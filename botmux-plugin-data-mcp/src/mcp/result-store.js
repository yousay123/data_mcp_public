import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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

export function clearAllStoredResults(pluginHome) {
  if (typeof pluginHome !== 'string' || !pluginHome.trim()) return;
  const records = resolve(pluginHome, 'active-results-v1', 'records');
  if (!existsSync(records)) return;
  const stat = lstatSync(records);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('result_store_unsafe_directory');
  for (const name of readdirSync(records)) {
    if (/^[a-f0-9]{64}\.json$/.test(name)) safeUnlink(join(records, name));
  }
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
    if (current.status !== 'active' || current.record.version !== expectedVersion) {
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

  assertVersion(identity, expectedVersion, now = Date.now()) {
    const current = this.read(identity, now);
    if (current.status !== 'active' || current.record.version !== expectedVersion) {
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

  reserveTurn(identity, turnId, now = Date.now()) {
    if (typeof turnId !== 'string' || !turnId.trim()) throw new Error('result_store_turn_required');
    const { bindingKey } = this.binding(identity);
    const turnKey = this.digest('turn-v1', [bindingKey, turnId]);
    const path = join(this.turns, `${turnKey}.lock`);
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, `${now}\n`); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  }

  audit(identity, turnId, question, version, status, now = Date.now()) {
    const { bindingKey } = this.binding(identity);
    const event = {
      at: new Date(now).toISOString(),
      binding: bindingKey.slice(0, 16),
      turn: this.digest('audit-turn-v1', [turnId]).slice(0, 16),
      question: this.digest('audit-question-v1', [question]).slice(0, 16),
      version,
      status,
    };
    appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.auditPath, 0o600);
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
