import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  closeSync,
  appendFileSync,
} from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const SCHEMA_VERSION = 1;
function matchesRevision(record, expected) {
  return expected && typeof expected === 'object'
    ? record.version === expected.version && record.generationId === expected.generationId
    : record.version === expected;
}
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RESULT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_OWNER_BYTES = 10 * 1024 * 1024;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('result_store_unsafe_directory');
  chmodSync(path, 0o700);
}

function safeUnlink(path) {
  try { unlinkSync(path); } catch { /* already removed */ }
}

export class ResultStore {
  constructor({ pluginHome, secret, config = {} }) {
    if (typeof pluginHome !== 'string' || !pluginHome.trim()) throw new Error('result_store_home_required');
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('result_store_hmac_key_required');
    this.secret = secret;
    this.root = resolve(pluginHome, 'active-results-v1');
    this.records = join(this.root, 'records');
    this.turns = join(this.root, 'turns');
    this.auditPath = join(this.root, 'audit.jsonl');
    this.idleTtlMs = positiveInteger(config.idleTtlMs, DEFAULT_IDLE_TTL_MS);
    this.absoluteTtlMs = positiveInteger(config.absoluteTtlMs, DEFAULT_ABSOLUTE_TTL_MS);
    this.maxResultBytes = positiveInteger(config.maxResultBytes, DEFAULT_MAX_RESULT_BYTES);
    this.maxTotalBytes = positiveInteger(config.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.maxOwnerBytes = positiveInteger(config.maxOwnerBytes, DEFAULT_MAX_OWNER_BYTES);
    privateDirectory(this.root);
    privateDirectory(this.records);
    privateDirectory(this.turns);
    this.cleanup();
  }

  digest(label, values) {
    const hmac = createHmac('sha256', this.secret);
    hmac.update(label);
    for (const value of values) {
      hmac.update('\0');
      hmac.update(String(value));
    }
    return hmac.digest('hex');
  }

  binding(identity) {
    const unionId = identity?.unionId;
    const appId = identity?.appId;
    const sessionId = identity?.sessionId;
    if (![unionId, appId, sessionId].every(value => typeof value === 'string' && value.trim())) {
      throw new Error('result_store_identity_required');
    }
    return {
      bindingKey: this.digest('binding-v1', [unionId, appId, sessionId]),
      ownerKey: this.digest('owner-v1', [unionId, appId]),
    };
  }

  recordPath(bindingKey) {
    return join(this.records, `${bindingKey}.json`);
  }

  readRecord(path) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('result_store_unsafe_record');
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (record?.schemaVersion !== SCHEMA_VERSION) throw new Error('result_store_schema_mismatch');
      return record;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  read(identity, now = Date.now()) {
    const { bindingKey } = this.binding(identity);
    const path = this.recordPath(bindingKey);
    const record = this.readRecord(path);
    if (!record) return { status: 'no_active_result' };
    if (record.absoluteExpiresAt <= now || record.idleExpiresAt <= now) {
      safeUnlink(path);
      return { status: 'expired' };
    }
    return { status: 'active', record };
  }

  put(identity, payload, now = Date.now()) {
    const { bindingKey, ownerKey } = this.binding(identity);
    const path = this.recordPath(bindingKey);
    this.cleanup(now);
    const previous = this.readRecord(path);
    const createdAt = now;
    const record = {
      schemaVersion: SCHEMA_VERSION,
      bindingKey,
      ownerKey,
      generationId: randomUUID(),
      version: (previous?.version ?? 0) + 1,
      createdAt,
      updatedAt: now,
      idleExpiresAt: now + this.idleTtlMs,
      absoluteExpiresAt: Math.min(createdAt + this.absoluteTtlMs, now + this.absoluteTtlMs),
      payload,
    };
    const serialized = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.maxResultBytes) throw new Error('result_store_result_too_large');
    this.enforceQuota(ownerKey, bytes, previous ? statSync(path).size : 0);
    this.atomicWrite(path, serialized);
    return record;
  }

  replaceIfVersion(identity, expectedVersion, payload, now = Date.now()) {
    const current = this.read(identity, now);
    if (current.status !== 'active' || !matchesRevision(current.record, expectedVersion)) {
      throw new Error('result_store_version_changed');
    }
    const record = {
      ...current.record,
      version: current.record.version + 1,
      updatedAt: now,
      idleExpiresAt: Math.min(current.record.absoluteExpiresAt, now + this.idleTtlMs),
      payload,
    };
    const serialized = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.maxResultBytes) throw new Error('result_store_result_too_large');
    const path = this.recordPath(current.record.bindingKey);
    this.enforceQuota(current.record.ownerKey, bytes, statSync(path).size);
    this.atomicWrite(path, serialized);
    return record;
  }

  clear(identity) {
    const { bindingKey } = this.binding(identity);
    safeUnlink(this.recordPath(bindingKey));
  }

  clearIfVersion(identity, expectedVersion, now = Date.now()) {
    const current = this.read(identity, now);
    if (current.status !== 'active' || !matchesRevision(current.record, expectedVersion)) return false;
    safeUnlink(this.recordPath(current.record.bindingKey));
    return true;
  }

  assertVersion(identity, expectedVersion, now = Date.now()) {
    const current = this.read(identity, now);
    if (current.status !== 'active' || !matchesRevision(current.record, expectedVersion)) {
      throw new Error('result_store_version_changed');
    }
    return current.record;
  }

  touch(identity, expectedVersion, now = Date.now()) {
    const current = this.assertVersion(identity, expectedVersion, now);
    const updated = {
      ...current,
      updatedAt: now,
      idleExpiresAt: Math.min(current.absoluteExpiresAt, now + this.idleTtlMs),
    };
    this.atomicWrite(this.recordPath(current.bindingKey), `${JSON.stringify(updated)}\n`);
    return updated;
  }

  reserveTurn(identity, turnId, now = Date.now(), scopes = ['all']) {
    if (typeof turnId !== 'string' || !turnId.trim()) throw new Error('result_store_turn_required');
    const { bindingKey } = this.binding(identity);
    const acquired = [];
    try {
      for (const scope of [...new Set(scopes)].sort()) {
        const turnKey = this.digest('turn-v2', [bindingKey, turnId, scope]);
        const path = join(this.turns, `${turnKey}.lock`);
        const fd = openSync(path, 'wx', 0o600);
        acquired.push(path);
        try { writeFileSync(fd, `${now}\n`); } finally { closeSync(fd); }
      }
      return true;
    } catch (error) {
      for (const path of acquired) safeUnlink(path);
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  }

  audit(identity, turnId, question, version, status, now = Date.now(), detail = {}) {
    const { bindingKey } = this.binding(identity);
    const safeDetail = {};
    if (detail.deliveryReceipt && typeof detail.deliveryReceipt === 'object') {
      const receipt = detail.deliveryReceipt;
      if (!/^data-(?:result(?:-error)?|followup)-[a-f0-9-]{36}$/.test(receipt.deliveryId ?? '')
        || !['pending', 'delivered', 'failed', 'unknown'].includes(receipt.status)) {
        throw new Error('result_store_invalid_delivery_receipt');
      }
      const ids = [receipt.messageId, ...(receipt.attachmentMessageIds || [])].filter(value => value !== undefined);
      if (ids.length > 7 || ids.some(value => typeof value !== 'string' || !/^om_[A-Za-z0-9_-]{1,200}$/.test(value))) {
        throw new Error('result_store_invalid_delivery_receipt');
      }
      safeDetail.receipt_binding = bindingKey;
      safeDetail.receipt_generation = /^[a-f0-9-]{36}$/.test(detail.generationId ?? '') ? detail.generationId : null;
      safeDetail.delivery_receipt = {
        deliveryId: receipt.deliveryId, status: receipt.status,
        ...(receipt.authority === 'host' ? { authority: 'host' } : {}),
        ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
        attachmentMessageIds: [...(receipt.attachmentMessageIds || [])],
        attachmentCount: receipt.attachmentMessageIds?.length || 0,
      };
    }
    if (detail?.stage === 'result_agent') safeDetail.stage = detail.stage;
    if (typeof detail?.action === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(detail.action)) {
      safeDetail.action = detail.action;
    }
    if (typeof detail?.errorCode === 'string'
      && /^(?:result_agent_[a-z0-9_]{1,80}|result_model_network_not_private)$/.test(detail.errorCode)) {
      safeDetail.error_code = detail.errorCode;
    }
    if (typeof detail?.queryId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(detail.queryId)) {
      safeDetail.query_id = detail.queryId;
    }
    if (typeof detail?.providerTaskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(detail.providerTaskId)) {
      safeDetail.provider_task_id = detail.providerTaskId;
    }
    if (typeof detail?.modelId === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(detail.modelId)) {
      safeDetail.model_id = detail.modelId;
    }
    if (typeof detail?.responseModel === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(detail.responseModel)) {
      safeDetail.response_model = detail.responseModel;
    }
    if (typeof detail?.endpointHost === 'string' && detail.endpointHost.trim()) {
      safeDetail.endpoint_host_hash = this.digest('model-endpoint-host-v1', [detail.endpointHost]).slice(0, 16);
    }
    if (typeof detail?.requestId === 'string' && detail.requestId.trim()) {
      safeDetail.request_id_hash = this.digest('model-request-id-v1', [detail.requestId]).slice(0, 16);
    }
    if (typeof detail?.promptTemplateVersion === 'string'
      && /^[A-Za-z0-9._-]{1,80}$/.test(detail.promptTemplateVersion)) {
      safeDetail.prompt_template_version = detail.promptTemplateVersion;
    }
    for (const [source, target] of [
      ['promptTemplateHash', 'prompt_template_hash'],
      ['inputHash', 'input_hash'],
      ['outputHash', 'output_hash'],
    ]) {
      if (typeof detail?.[source] === 'string' && /^[a-f0-9]{64}$/.test(detail[source])) {
        safeDetail[target] = detail[source];
      }
    }
    if (typeof detail?.analysisRedactionUsed === 'boolean') {
      safeDetail.analysis_redaction_used = detail.analysisRedactionUsed;
    }
    if (Number.isSafeInteger(detail?.inputRowCount) && detail.inputRowCount >= 0) {
      safeDetail.input_row_count = detail.inputRowCount;
    }
    if (Number.isSafeInteger(detail?.latencyMs) && detail.latencyMs >= 0) {
      safeDetail.latency_ms = detail.latencyMs;
    }
    if (Number.isSafeInteger(detail?.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599) {
      safeDetail.http_status = detail.httpStatus;
    }
    for (const [source, target] of [
      ['modelAttemptCount', 'model_attempt_count'],
      ['modelRetriesUsed', 'model_retries_used'],
      ['modelRepairCount', 'model_repair_count'],
      ['modelBudgetExpansions', 'model_budget_expansions'],
      ['modelPlanningRounds', 'model_planning_rounds'],
      ['modelMaxTokens', 'model_max_tokens'], ['modelTokenCap', 'model_token_cap'],
      ['promptTokens', 'prompt_tokens'], ['completionTokens', 'completion_tokens'],
      ['reasoningTokens', 'reasoning_tokens'],
    ]) {
      if (Number.isSafeInteger(detail?.[source]) && detail[source] >= 0) {
        safeDetail[target] = detail[source];
      }
    }
    if (typeof detail?.modelEnableThinking === 'boolean') safeDetail.model_enable_thinking = detail.modelEnableThinking;
    if (Number.isFinite(detail?.modelTemperature) && detail.modelTemperature >= 0 && detail.modelTemperature <= 2) {
      safeDetail.model_temperature = detail.modelTemperature;
    }
    if (typeof detail?.finishReason === 'string' && /^[a-z_]{1,32}$/.test(detail.finishReason)) safeDetail.finish_reason = detail.finishReason;
    const event = {
      at: new Date(now).toISOString(),
      binding: bindingKey.slice(0, 16),
      turn: this.digest('audit-turn-v1', [turnId]).slice(0, 16),
      question: this.digest('audit-question-v1', [question]).slice(0, 16),
      version,
      status,
      ...safeDetail,
    };
    appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.auditPath, 0o600);
  }

  deliveryStatus(identity, now = Date.now()) {
    const active = this.read(identity, now);
    if (active.status !== 'active') return { status: active.status };
    if (!/^[a-f0-9-]{36}$/.test(active.record.generationId ?? '')) return { status: 'delivery_status_unknown' };
    const { bindingKey } = this.binding(identity);
    let descriptor;
    try {
      descriptor = openSync(this.auditPath, 'r');
      const size = fstatSync(descriptor).size;
      const start = Math.max(0, size - 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      const bytes = readSync(descriptor, buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
      if (start) lines.shift();
      for (const line of lines.reverse()) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        if (record.receipt_binding !== bindingKey || record.version !== active.record.version
          || record.receipt_generation !== active.record.generationId) continue;
        const receipt = record.delivery_receipt;
        if (!receipt) continue;
        // Reconstruct the allowlist; never return arbitrary persisted fields.
        if (!/^data-(?:result(?:-error)?|followup)-[a-f0-9-]{36}$/.test(receipt.deliveryId ?? '')
          || typeof record.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.at)
          || !['pending', 'delivered', 'failed', 'unknown'].includes(receipt.status)
          || !Array.isArray(receipt.attachmentMessageIds) || receipt.attachmentMessageIds.length > 6
          || [receipt.messageId, ...receipt.attachmentMessageIds].filter(value => value !== undefined)
            .some(value => typeof value !== 'string' || !/^om_[A-Za-z0-9_-]{1,200}$/.test(value))) {
          return { status: 'delivery_status_unavailable' };
        }
        if (receipt.authority === 'host') return {
          status: 'host_status_required', pluginId: 'data-mcp', deliveryId: receipt.deliveryId,
          next_action: 'botmux_result_delivery_status', observedAt: record.at,
        };
        return {
          status: receipt.status, deliveryId: receipt.deliveryId,
          ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
          attachmentMessageIds: receipt.attachmentMessageIds,
          attachmentCount: receipt.attachmentMessageIds.length,
          observedAt: record.at,
        };
      }
      return { status: 'delivery_status_unknown' };
    } catch {
      return { status: 'delivery_status_unavailable' };
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }

  auditModelEndpointException(hostname, now = Date.now()) {
    if (typeof hostname !== 'string' || !hostname.trim()) {
      throw new Error('result_model_exception_host_required');
    }
    const event = {
      at: new Date(now).toISOString(),
      host: this.digest('model-endpoint-host-v1', [hostname]).slice(0, 16),
      status: 'model_endpoint_exception_used',
    };
    appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.auditPath, 0o600);
  }

  enforceQuota(ownerKey, incomingBytes, replacedBytes) {
    let total = 0;
    let ownerTotal = 0;
    for (const name of readdirSync(this.records)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.records, name);
      const record = this.readRecord(path);
      if (!record) continue;
      const bytes = statSync(path).size;
      total += bytes;
      if (record.ownerKey === ownerKey) ownerTotal += bytes;
    }
    const nextTotal = total - replacedBytes + incomingBytes;
    const nextOwnerTotal = ownerTotal - replacedBytes + incomingBytes;
    if (nextTotal > this.maxTotalBytes) throw new Error('result_store_global_quota_exceeded');
    if (nextOwnerTotal > this.maxOwnerBytes) throw new Error('result_store_owner_quota_exceeded');
  }

  cleanup(now = Date.now()) {
    for (const name of readdirSync(this.records)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(this.records, name);
      try {
        const record = this.readRecord(path);
        if (record && (record.absoluteExpiresAt <= now || record.idleExpiresAt <= now)) safeUnlink(path);
      } catch {
        safeUnlink(path);
      }
    }
    for (const name of readdirSync(this.turns)) {
      if (!/^[a-f0-9]{64}\.lock$/.test(name)) continue;
      const path = join(this.turns, name);
      try {
        if (now - statSync(path).mtimeMs > this.idleTtlMs) safeUnlink(path);
      } catch { safeUnlink(path); }
    }
  }

  atomicWrite(path, content) {
    const temporary = join(this.root, `.${randomUUID()}.partial`);
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } finally {
      if (existsSync(temporary)) safeUnlink(temporary);
    }
  }
}
