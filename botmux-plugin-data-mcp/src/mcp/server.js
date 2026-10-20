import { createInterface } from 'node:readline';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { clearAllStoredResults, ResultStore } from './result-store.js';
import { resolvePrivateModelAddress } from './private-network.js';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const DEFAULT_SERVICE_BASE_URL = 'http://127.0.0.1:8765';
const DEFAULT_SERVICE_SOCKET_PATH = join(homedir(), '.cache', 'ksher-agent-data-mcp', 'run', 'api.sock');
const INTERNAL_AUTH_HEADER = 'X-Internal-Auth';
const SENSITIVE_PROCESS_ENV_KEYS = [
  'DATA_MCP_INTERNAL_AUTH_TOKEN',
  'DATA_MCP_RESULT_MODEL_API_KEY',
  'DATA_MCP_RESULT_BINDING_HMAC_KEY',
  'TCHOUSE_D_PASSWORD',
];
const OUTBOUND_ARTIFACT_PREFIX = 'data-mcp-';
const OUTBOUND_STALE_AFTER_MS = 15 * 60 * 1000;
const stagedOutboundArtifacts = new Set();
let hostEnvCache;
let packageVersionCache;

function assertNoSensitiveProcessEnv(env = process.env) {
  if (SENSITIVE_PROCESS_ENV_KEYS.some(key => Object.hasOwn(env, key))) {
    throw new Error(
      'Data MCP plugin refuses secrets in its process environment; '
      + 'use KSHER_AGENT_DATA_MCP_ENV_FILE',
    );
  }
}

assertNoSensitiveProcessEnv();

function removeStagedOutboundArtifacts() {
  for (const path of stagedOutboundArtifacts) {
    try { unlinkSync(path); } catch { /* already consumed or best-effort shutdown cleanup */ }
  }
  stagedOutboundArtifacts.clear();
}

function cleanupStaleOutboundArtifacts(now = Date.now()) {
  const pluginHome = process.env.BOTMUX_PLUGIN_HOME;
  if (!pluginHome) return;
  const outbound = resolve(pluginHome, 'outbound');
  if (!existsSync(outbound)) return;
  for (const name of readdirSync(outbound)) {
    if (!name.startsWith(OUTBOUND_ARTIFACT_PREFIX) && !name.startsWith(`.${OUTBOUND_ARTIFACT_PREFIX}`)) continue;
    const path = join(outbound, name);
    try {
      if (now - statSync(path).mtimeMs >= OUTBOUND_STALE_AFTER_MS) unlinkSync(path);
    } catch { /* concurrent consumer or unrelated filesystem failure */ }
  }
}

cleanupStaleOutboundArtifacts();
process.once('exit', removeStagedOutboundArtifacts);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    removeStagedOutboundArtifacts();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function error(id, code, message, data) {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function trustedCallerFrom(request) {
  const caller = request.params?._meta?.botmuxTrustedCaller;
  if (!caller || typeof caller !== 'object' || Array.isArray(caller)) {
    // Fail closed. The host is the only party that can state who the caller is;
    // there is deliberately no file-based fallback. The previous one read
    // `<dataDir>/trusted-turns/<BOTMUX_SESSION_ID>.json`, whose directory is
    // world-readable and whose name is derived from a plaintext session id — any
    // process running as the same user could write another session's file and be
    // served as that person, with the audit trail pointing at them.
    return null;
  }
  return normalizeTrustedCaller(caller, 'gateway_meta');
}

function normalizeTrustedCaller(caller, source) {
  const requestUserOpenId = typeof caller.requestUserOpenId === 'string'
    ? caller.requestUserOpenId
    : undefined;
  const requestUserUnionId = typeof caller.requestUserUnionId === 'string'
    ? caller.requestUserUnionId
    : undefined;
  const requestLarkAppId = typeof caller.requestLarkAppId === 'string'
    ? caller.requestLarkAppId
    : undefined;
  const turnId = typeof caller.turnId === 'string' ? caller.turnId : undefined;
  const callerSource = typeof caller.source === 'string'
    ? caller.source
    : typeof caller.callerSource === 'string'
      ? caller.callerSource
      : typeof caller.caller_source === 'string'
        ? caller.caller_source
        : undefined;
  const senderType = typeof caller.senderType === 'string'
    ? caller.senderType
    : typeof caller.sender_type === 'string'
      ? caller.sender_type
      : undefined;
  const taskId = typeof caller.taskId === 'string'
    ? caller.taskId
    : typeof caller.callerTaskId === 'string'
      ? caller.callerTaskId
      : typeof caller.caller_task_id === 'string'
        ? caller.caller_task_id
        : undefined;
  const capturedAt = typeof caller.capturedAt === 'string'
    ? caller.capturedAt
    : typeof caller.captured_at === 'string'
      ? caller.captured_at
      : undefined;
  const dispatchAttempt = Number.isSafeInteger(caller.dispatchAttempt)
    ? caller.dispatchAttempt
    : undefined;
  const hostCapabilities = Array.isArray(caller.hostCapabilities)
    ? caller.hostCapabilities.filter(value => typeof value === 'string')
    : [];
  if (!requestUserOpenId && !requestUserUnionId) return null;
  return {
    source,
    ...(requestUserOpenId ? { requestUserOpenId } : {}),
    ...(requestUserUnionId ? { requestUserUnionId } : {}),
    ...(requestLarkAppId ? { requestLarkAppId } : {}),
    ...(callerSource ? { callerSource } : {}),
    ...(senderType ? { senderType } : {}),
    ...(taskId ? { taskId } : {}),
    ...(capturedAt ? { capturedAt } : {}),
    ...(turnId ? { turnId } : {}),
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
    hostCapabilities,
  };
}

function botmuxDataDir() {
  if (process.env.SESSION_DATA_DIR) return process.env.SESSION_DATA_DIR;

  const configDir = join(homedir(), '.botmux');
  const fallback = join(configDir, 'data');
  try {
    const breadcrumb = readFileSync(join(configDir, '.data-dir'), 'utf8').trim();
    if (breadcrumb && existsSync(breadcrumb)) {
      if (existsSync(join(breadcrumb, 'sessions.json'))) return breadcrumb;
      try {
        if (readdirSync(breadcrumb).some(file => file.startsWith('sessions-') && file.endsWith('.json'))) {
          return breadcrumb;
        }
      } catch {
        // Fall through to the default BotMux data dir.
      }
    }
  } catch {
    // Missing breadcrumb is normal.
  }
  return fallback;
}

function hostEnvPath() {
  return process.env.KSHER_AGENT_DATA_MCP_ENV_FILE
    || join(homedir(), '.config', 'ksher-agent-data-mcp', 'env');
}

function parseHostEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  if (
    (value.startsWith("'") && value.endsWith("'"))
    || (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

function hostEnv() {
  if (hostEnvCache) return hostEnvCache;
  const values = {};
  try {
    const text = readFileSync(hostEnvPath(), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const entry = parseHostEnvLine(line);
      if (entry) values[entry[0]] = entry[1];
    }
  } catch {
    // Host env file is optional. Missing values are handled by callers.
  }
  hostEnvCache = values;
  return hostEnvCache;
}

function configValue(name) {
  const fromProcess = process.env[name];
  if (typeof fromProcess === 'string' && fromProcess) return fromProcess;
  const fromHostFile = hostEnv()[name];
  return typeof fromHostFile === 'string' && fromHostFile ? fromHostFile : undefined;
}

if (configValue('DATA_MCP_RESULT_MODEL_TEST_EXCEPTION')) {
  console.error('[data-mcp] WARN test-only result model endpoint exception is configured');
}

function nonBlankProcessEnv(name) {
  // Security boundary: query-plan context must come from the host-owned child
  // process environment. Do not replace this with configValue(), whose local
  // host-env-file fallback is valid for service config but not caller context.
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resultStoreFor(caller) {
  const pluginHome = nonBlankProcessEnv('BOTMUX_PLUGIN_HOME');
  const secret = hostEnv().DATA_MCP_RESULT_BINDING_HMAC_KEY;
  if (!pluginHome || typeof secret !== 'string' || secret.length < 32) {
    throw new Error('result_store_not_configured');
  }
  return new ResultStore({
    pluginHome,
    secret,
    config: {
      idleTtlMs: configValue('DATA_MCP_RESULT_IDLE_TTL_MS'),
      absoluteTtlMs: configValue('DATA_MCP_RESULT_ABSOLUTE_TTL_MS'),
      maxResultBytes: configValue('DATA_MCP_RESULT_MAX_BYTES'),
      maxTotalBytes: configValue('DATA_MCP_RESULT_MAX_TOTAL_BYTES'),
      maxOwnerBytes: configValue('DATA_MCP_RESULT_MAX_OWNER_BYTES'),
    },
  });
}

function activeResultIdentity(caller) {
  const sessionId = nonBlankProcessEnv('BOTMUX_SESSION_ID');
  if (
    caller.senderType !== 'user'
    || !caller.requestUserUnionId
    || !caller.requestLarkAppId
    || !sessionId
  ) {
    throw new Error('followup_identity_required');
  }
  return {
    unionId: caller.requestUserUnionId,
    appId: caller.requestLarkAppId,
    sessionId,
  };
}

function trustedQueryPlanContext() {
  const sessionId = nonBlankProcessEnv('BOTMUX_SESSION_ID');
  if (sessionId) return { id: sessionId, source: 'session' };

  const executionId = nonBlankProcessEnv('BOTMUX_EXECUTION_ID');
  return executionId ? { id: executionId, source: 'execution' } : undefined;
}

function maskValue(value) {
  if (typeof value !== 'string' || !value) return undefined;
  if (value.length <= 10) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function packageVersion() {
  if (packageVersionCache) return packageVersionCache;
  for (const relativePath of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
      if (typeof pkg.version === 'string' && pkg.version) {
        packageVersionCache = pkg.version;
        return packageVersionCache;
      }
    } catch {
      // Try the next package metadata location.
    }
  }
  return 'unknown';
}

function callerDiagnostic(caller) {
  return {
    source: caller.source,
    callerSource: caller.callerSource ?? null,
    senderType: caller.senderType ?? 'unknown_legacy',
    taskId: caller.taskId ?? null,
    turnId: caller.turnId ?? null,
    capturedAt: caller.capturedAt ?? null,
    hasOpenId: !!caller.requestUserOpenId,
    hasUnionId: !!caller.requestUserUnionId,
    hasLarkAppId: !!caller.requestLarkAppId,
    ...(caller.requestUserOpenId ? { requestUserOpenIdMasked: maskValue(caller.requestUserOpenId) } : {}),
    ...(caller.requestUserUnionId ? { requestUserUnionIdMasked: maskValue(caller.requestUserUnionId) } : {}),
    ...(caller.requestLarkAppId ? { requestLarkAppId: caller.requestLarkAppId } : {}),
  };
}

function isTrustedHumanOrSchedule(caller) {
  const scheduleSource = caller.callerSource === 'schedule_creator';
  const senderType = caller.senderType;
  // `schedule_creator` is the forward-compatible Botmux scheduled-turn leg.
  // On the current Barry host it is unreachable until the runtime includes the
  // upstream commits that inject caller source/task id.
  return senderType === 'user' || (scheduleSource && !!caller.taskId);
}

function scheduleTurnBindingIssue(caller) {
  const scheduleSource = caller.callerSource === 'schedule_creator';
  const turnId = typeof caller.turnId === 'string' ? caller.turnId : '';
  const taskId = typeof caller.taskId === 'string' ? caller.taskId : '';

  if (scheduleSource) {
    const scheduledTurn = /^schedule:([^:]+):(.+)$/.exec(turnId);
    if (!taskId || !scheduledTurn || scheduledTurn[1] !== taskId) {
      return {
        status: 'validation_error',
        result_class: 'policy_error',
        message: '定时任务身份与当前执行轮次不一致，拒绝访问 Data MCP',
        issues: [{
          code: 'schedule_turn_identity_mismatch',
          severity: 'error',
          message: 'caller_source=schedule_creator 时，turn_id 必须是 schedule:<task_id>:<turn>，且 task_id 必须完全一致',
          suggested_action: '请等待当前会话空闲后重试，或为不同创建人的定时任务使用独立话题会话',
        }],
        permission_scope: 'user_identity',
        audit_context: auditContext(caller),
      };
    }
  } else if (turnId.startsWith('schedule:')) {
    return {
      status: 'validation_error',
      result_class: 'policy_error',
      message: '定时任务轮次缺少可信 schedule_creator 身份来源，拒绝访问 Data MCP',
      issues: [{
        code: 'schedule_turn_source_mismatch',
        severity: 'error',
        message: 'turn_id 以 schedule: 开头时，caller_source 必须是 schedule_creator',
        suggested_action: '请由 Botmux 定时任务宿主重新注入可信调用身份',
      }],
      permission_scope: 'user_identity',
      audit_context: auditContext(caller),
    };
  }

  return null;
}

function callerPolicyIssue(caller) {
  if (!isTrustedHumanOrSchedule(caller)) {
    return {
      status: 'validation_error',
      message: '当前调用方不是受信任的真实用户或定时任务来源，拒绝执行数据查询',
      issues: [{
        code: 'trusted_human_or_schedule_required',
        severity: 'error',
        message: '查询/导出工具只允许 senderType=user，或 caller_source=schedule_creator 且 caller_task_id 非空',
        suggested_action: '请由真实用户重新触发；旧宿主 senderType=unknown_legacy 时不会执行明细查询或导出',
      }],
      permission_scope: 'user_identity',
      audit_context: auditContext(caller),
    };
  }

  return null;
}

function redactSchemaDetailsForUntrustedCaller(body, caller) {
  if (isTrustedHumanOrSchedule(caller) || !body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  return collapsedValidationDetail(caller);
}

function collapsedValidationDetail(caller) {
  return {
    status: 'validation_error',
    schema_detail_redacted: true,
    permission_scope: 'user_identity',
    issues: [{
      code: 'trusted_human_or_schedule_required',
      severity: 'error',
      message: 'validate_sql_for_user 在非受信任真实用户或定时任务来源下不会返回表权限、表名、列名或 SQL 归一化结果',
      suggested_action: '请由真实用户重新触发；旧宿主 senderType=unknown_legacy 时 validate 只返回固定拒绝形态',
    }],
    audit_context: auditContext(caller),
  };
}

function sanitizeValidationResult(body) {
  if (!body || body.status !== 'success') {
    return {
      status: 'validation_error',
      error_code: 'sql_validation_failed',
      message: 'sql_validation_failed',
    };
  }
  const result = {
    status: 'success',
    datasource: typeof body.datasource === 'string' ? body.datasource : 'tchouse-c',
    tables: Array.isArray(body.tables) ? body.tables.filter(value => typeof value === 'string') : [],
    columns: Array.isArray(body.columns) ? body.columns.filter(value => typeof value === 'string') : [],
  };
  if (typeof body.normalized_sql === 'string') result.normalized_sql = body.normalized_sql;
  if (typeof body.query_plan_id === 'string') result.query_plan_id = body.query_plan_id;
  if (typeof body.execution_mode === 'string') result.execution_mode = body.execution_mode;
  return result;
}

const SAFE_METADATA_FIELDS = new Set([
  'priority', 'full_path', 'backend_name', 'type_classify', 'source_type',
  'biz_domain', 'database_name', 'table_name', 'table_comment', 'column_name',
  'column_comment', 'biz_definition', 'sensitive_level', 'ds',
]);

function sanitizeMetadataSearchResult(body) {
  if (!body || body.status !== 'success') {
    return {
      status: body?.status === 'not_found' ? 'not_found' : 'error',
      error_code: body?.status === 'not_found' ? 'metadata_snapshot_no_match' : 'metadata_snapshot_unavailable',
    };
  }
  const results = Array.isArray(body.results)
    ? body.results.map(row => Object.fromEntries(
      Object.entries(row && typeof row === 'object' ? row : {})
        .filter(([key, value]) => SAFE_METADATA_FIELDS.has(key) && ['string', 'number', 'boolean'].includes(typeof value)),
    ))
    : [];
  return { status: 'success', results };
}

function redactHttpErrorDetail(kind, caller) {
  if (kind === 'validate') return collapsedValidationDetail(caller);
  return {
    status: 'error',
    upstream_detail_redacted: true,
    audit_context: auditContext(caller),
  };
}

function auditContext(caller) {
  return {
    caller_source: caller.callerSource ?? null,
    sender_type: caller.senderType ?? 'unknown_legacy',
    task_id: caller.taskId ?? null,
    turn_id: caller.turnId ?? null,
    captured_at: caller.capturedAt ?? null,
  };
}

function toolText(text) {
  return { content: [{ type: 'text', text }] };
}

function jsonTool(value) {
  return toolText(JSON.stringify(value, null, 2));
}

function hostDeliveryTool(delivery) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ status: 'delivery_requested', deliveryId: delivery.deliveryId }) }],
    _meta: { botmuxHostDelivery: delivery },
  };
}

function argsFrom(request) {
  return request.params?.arguments && typeof request.params.arguments === 'object'
    ? request.params.arguments
    : {};
}

function serviceBaseUrl() {
  return (configValue('DATA_MCP_SERVICE_BASE_URL') || DEFAULT_SERVICE_BASE_URL).replace(/\/+$/, '');
}

function explicitServiceEndpoint(kind) {
  if (kind === 'validate') {
    return configValue('DATA_MCP_VALIDATE_SQL_ENDPOINT');
  } else if (kind === 'export') {
    return configValue('DATA_MCP_EXPORT_QUERY_ENDPOINT') || configValue('DATA_MCP_EXPORT_ENDPOINT');
  } else if (kind === 'run') {
    return configValue('DATA_MCP_RUN_QUERY_ENDPOINT') || configValue('DATA_MCP_QUERY_ENDPOINT');
  }
  // Snapshot endpoints deliberately have no per-tool environment override.
  // They must use the same private Unix-socket service boundary as the other tools.
  return undefined;
}

function servicePath(kind) {
  if (kind === 'validate') return '/agent/validate-sql';
  if (kind === 'export') return '/agent/export-query-excel-file';
  if (kind === 'run') return '/agent/run-query';
  if (kind === 'refreshSnapshot') return '/agent/refresh-metadata-snapshot';
  if (kind === 'searchSnapshot') return '/agent/search-metadata-snapshot';
  if (kind === 'subjectsByTable') return '/agent/inspect-ck-subjects-by-table';
  if (kind === 'resourcesBySubject') return '/agent/inspect-ck-resources-by-subject';
  if (kind === 'defaultRoleBaseline') return '/agent/audit-ck-default-role-baseline';
  throw new Error(`unsupported_service_kind:${String(kind)}`);
}

function serviceEndpoint(kind) {
  const explicit = explicitServiceEndpoint(kind);
  if (explicit) return explicit;
  return `${serviceBaseUrl()}${servicePath(kind)}`;
}

function serviceSocketPath() {
  const socketPath = configValue('DATA_MCP_SERVICE_SOCKET_PATH');
  if (socketPath === 'disabled') return undefined;
  return socketPath || DEFAULT_SERVICE_SOCKET_PATH;
}

function serviceHeaders() {
  const headers = { 'content-type': 'application/json' };
  const token = hostEnv().DATA_MCP_INTERNAL_AUTH_TOKEN;
  if (token) {
    headers[INTERNAL_AUTH_HEADER] = token;
  }
  return headers;
}

function postJsonOverUnixSocket(socketPath, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = httpRequest({
      socketPath,
      path,
      method: 'POST',
      headers: {
        ...serviceHeaders(),
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function postJsonOverUrl(endpoint, payload) {
  if (endpoint.startsWith('data:')) {
    return fetch(endpoint, {
      method: 'POST',
      headers: serviceHeaders(),
      body: JSON.stringify(payload),
    });
  }
  const url = new URL(endpoint);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers = {
      ...serviceHeaders(),
      'content-length': Buffer.byteLength(body),
    };
    const req = transport(url, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function resultModelConfig() {
  const endpointValue = configValue('DATA_MCP_RESULT_MODEL_ENDPOINT');
  const model = configValue('DATA_MCP_RESULT_MODEL');
  const allowedHosts = new Set((configValue('DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS') || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  if (!endpointValue || !model || allowedHosts.size === 0) {
    throw new Error('result_model_not_configured');
  }
  const endpoint = new URL(endpointValue);
  if (!['http:', 'https:'].includes(endpoint.protocol)
    || endpoint.username || endpoint.password
    || !allowedHosts.has(endpoint.hostname.toLowerCase())) {
    throw new Error('result_model_endpoint_not_allowed');
  }
  return {
    endpoint,
    model,
    apiKey: configValue('DATA_MCP_RESULT_MODEL_API_KEY'),
  };
}

async function postJsonToResultModel(endpoint, apiKey, payload) {
  const pinned = await resolvePrivateModelAddress(endpoint.hostname, undefined, {
    testException: configValue('DATA_MCP_RESULT_MODEL_TEST_EXCEPTION'),
    onTestExceptionUsed: (hostname) => resultStoreFor().auditModelEndpointException(hostname),
  });
  return new Promise((resolvePromise, reject) => {
    const body = JSON.stringify(payload);
    const transport = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    };
    const req = transport(endpoint, {
      method: 'POST',
      headers,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      ...(endpoint.protocol === 'https:' ? { servername: endpoint.hostname } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolvePromise({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(60_000, () => req.destroy(new Error('result_model_timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function analyzeResultWithInternalModel(result, question) {
  const config = resultModelConfig();
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > 5 * 1024 * 1024) throw new Error('result_model_payload_too_large');
  const response = await postJsonToResultModel(config.endpoint, config.apiKey, {
    model: config.model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: [
          '你是企业内网中的数据结果分析器。只根据给定查询结果回答，不补造事实。',
          '必须写明时间范围、统计口径、数据缺失/截断和不能推出的结论。',
          '输出简洁中文 Markdown；不得输出数据库账号、SQL、身份标识或访问凭证。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `用户问题：${question || '请汇总本次查询结果'}\n查询结果：${serialized}`,
      },
    ],
  });
  if (!response.ok) throw new Error(`result_model_http_${response.status}`);
  let body;
  try { body = JSON.parse(response.text); } catch { throw new Error('result_model_invalid_json'); }
  const markdown = body?.choices?.[0]?.message?.content;
  if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 50_000) {
    throw new Error('result_model_invalid_content');
  }
  return markdown;
}

function copyExportToPluginOutbound(file) {
  const pluginHome = process.env.BOTMUX_PLUGIN_HOME;
  if (!pluginHome || !file || typeof file.path !== 'string') throw new Error('export_artifact_missing');
  const source = realpathSync(file.path);
  if (!statSync(source).isFile()) throw new Error('export_artifact_invalid');
  const outbound = resolve(pluginHome, 'outbound');
  mkdirSync(outbound, { recursive: true, mode: 0o700 });
  const safeName = basename(typeof file.filename === 'string' ? file.filename : source)
    .replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, '_');
  const token = randomUUID();
  const target = join(outbound, `data-mcp-${token}-${safeName || 'query-result.xlsx'}`);
  const temporary = join(outbound, `.data-mcp-${token}.partial`);
  stagedOutboundArtifacts.add(temporary);
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
    stagedOutboundArtifacts.delete(temporary);
    stagedOutboundArtifacts.add(target);
    return target;
  } catch (error) {
    stagedOutboundArtifacts.delete(temporary);
    try { unlinkSync(temporary); } catch { /* best-effort */ }
    throw error;
  }
}

function discardStagedOutboundArtifact(path) {
  if (!path) return;
  stagedOutboundArtifacts.delete(path);
  try { unlinkSync(path); } catch { /* already consumed or absent */ }
}

function sanitizedExcelFilename(value) {
  const leaf = basename(String(value || 'query-result').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, '_')
    .replace(/\.xlsx$/i, '')
    .slice(0, 100)
    .replace(/^\.+/, '');
  return `${leaf || 'query-result'}.xlsx`;
}

function storableQueryResult(result) {
  return {
    status: 'success',
    datasource: typeof result.datasource === 'string' ? result.datasource : 'tchouse-c',
    columns: Array.isArray(result.columns) ? result.columns : [],
    rows: Array.isArray(result.rows) ? result.rows : Array.isArray(result.data) ? result.data : [],
    row_count: Number.isSafeInteger(result.row_count) ? result.row_count : 0,
    rows_before_limit_at_least: Number.isSafeInteger(result.rows_before_limit_at_least)
      ? result.rows_before_limit_at_least
      : null,
    effective_limit: Number.isSafeInteger(result.effective_limit) ? result.effective_limit : null,
    truncated: result.truncated === true,
    truncation_uncertain: result.truncation_uncertain === true,
    user_limit_reached: result.user_limit_reached === true,
    user_limit_notice: typeof result.user_limit_notice === 'string' ? result.user_limit_notice : null,
    limit_notice: typeof result.limit_notice === 'string' ? result.limit_notice : null,
    limit_injected: result.limit_injected === true,
    limit_capped: result.limit_capped === true,
    quality_warnings: Array.isArray(result.quality_warnings) ? result.quality_warnings : [],
  };
}

function storedPayload(args, result) {
  return {
    query: {
      sql: args.sql,
      datasource: typeof args.datasource === 'string' ? args.datasource : 'tchouse-c',
    },
    result: result ? storableQueryResult(result) : null,
  };
}

async function freshPlan(caller, query) {
  const validation = await callDataMcpService('validate', caller, {
    sql: query.sql,
    datasource: query.datasource,
    execution_mode: 'single',
  });
  if (validation?.status !== 'success' || typeof validation.query_plan_id !== 'string') {
    throw new Error('followup_revalidation_failed');
  }
  return validation.query_plan_id;
}

function fixedFollowupResult(code) {
  return {
    status: code,
    error_code: code,
    message: code,
  };
}

async function deliverQueryResult(caller, args) {
  if (!caller.hostCapabilities.includes('result_delivery_v1')) {
    return {
      error: {
        status: 'validation_error',
        error_code: 'trusted_result_delivery_unavailable',
        message: '当前 Botmux 宿主未启用可信结果直送能力，拒绝执行以避免业务数据进入调用模型上下文',
      },
    };
  }
  let identity;
  let store;
  if (caller.senderType === 'user') {
    try {
      identity = activeResultIdentity(caller);
      store = resultStoreFor(caller);
      // A new first-turn query invalidates the old active result before any
      // work starts. If the new snapshot cannot be stored, follow-ups must see
      // no result rather than silently using data from the previous query.
      store.clear(identity);
    } catch {
      try { clearAllStoredResults(nonBlankProcessEnv('BOTMUX_PLUGIN_HOME')); }
      catch { /* fail safe: follow-up store creation still remains unavailable */ }
      identity = undefined;
      store = undefined;
    }
  }
  const mode = args.output_mode;
  if (mode === 'analysis') {
    const result = await callDataMcpService('run', caller, args);
    if (result?.status !== 'success') return { error: isolatedDeliveryFailure() };
    const markdown = await analyzeResultWithInternalModel(result, args.question);
    if (store) {
      try { store.put(identity, storedPayload(args, result)); }
      catch {
        store.clear(identity);
        try { store.audit(identity, caller.turnId || 'initial', args.question || '', null, 'storage_failed'); }
        catch { /* best-effort non-sensitive audit */ }
      }
    }
    return {
      delivery: {
        schemaVersion: 1,
        deliveryId: `data-result-${randomUUID()}`,
        markdown,
        responseKind: 'final',
      },
    };
  }
  if (mode === 'excel') {
    const safeArgs = { ...args, filename: sanitizedExcelFilename(args.filename) };
    const result = await callDataMcpService('export', caller, safeArgs);
    if (result?.status !== 'success') return { error: isolatedDeliveryFailure() };
    const path = copyExportToPluginOutbound(result.file);
    if (store) {
      try { store.put(identity, storedPayload(safeArgs, null)); }
      catch {
        store.clear(identity);
        try { store.audit(identity, caller.turnId || 'initial', args.question || '', null, 'storage_failed'); }
        catch { /* best-effort non-sensitive audit */ }
      }
    }
    return {
      delivery: {
        schemaVersion: 1,
        deliveryId: `data-result-${randomUUID()}`,
        markdown: [
          '查询完成，已生成 Excel。',
          '',
          `- 行数：${Number(result.file?.row_count ?? 0).toLocaleString('en-US')}`,
          `- 查询编号：${String(result.query_id ?? '未返回')}`,
          typeof result.user_limit_notice === 'string' ? `- 提示：${result.user_limit_notice}` : null,
        ].filter(line => line !== null).join('\n'),
        files: [{ path }],
        responseKind: 'final',
      },
    };
  }
  return {
    error: {
      status: 'validation_error',
      error_code: 'invalid_delivery_output_mode',
      message: 'output_mode 仅支持 analysis 或 excel；一次查询只允许一种执行路径',
    },
  };
}

async function continueQueryResult(caller, args) {
  if (!caller.hostCapabilities.includes('result_delivery_v1')) {
    return { error: fixedFollowupResult('trusted_result_delivery_unavailable') };
  }
  let identity;
  let store;
  try {
    identity = activeResultIdentity(caller);
    store = resultStoreFor(caller);
  } catch {
    return { error: fixedFollowupResult('identity_rejected') };
  }
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question || question.length > 4000 || !caller.turnId) {
    return { error: fixedFollowupResult('invalid_followup_request') };
  }
  const active = store.read(identity);
  if (active.status !== 'active') {
    store.audit(identity, caller.turnId, question, null, active.status);
    return { error: fixedFollowupResult(active.status) };
  }
  if (!store.reserveTurn(identity, caller.turnId)) {
    store.audit(identity, caller.turnId, question, active.record.version, 'rate_limited');
    return { error: fixedFollowupResult('rate_limited') };
  }
  const expectedVersion = active.record.version;
  const payload = active.record.payload;
  const mode = args.output_mode === 'excel' ? 'excel' : 'analysis';
  try {
    if (mode === 'analysis') {
      let result = payload.result;
      let finalVersion = expectedVersion;
      if (!result) {
        const queryPlanId = await freshPlan(caller, payload.query);
        const rerun = await callDataMcpService('run', caller, {
          ...payload.query,
          query_plan_id: queryPlanId,
        });
        if (rerun?.status !== 'success') throw new Error('followup_query_failed');
        result = storableQueryResult(rerun);
        const updated = store.replaceIfVersion(identity, expectedVersion, {
          ...payload,
          result,
        });
        finalVersion = updated.version;
      }
      const markdown = await analyzeResultWithInternalModel(result, question);
      store.assertVersion(identity, finalVersion);
      store.touch(identity, finalVersion);
      store.audit(identity, caller.turnId, question, finalVersion, 'delivery_requested');
      return {
        delivery: {
          schemaVersion: 1,
          deliveryId: `data-followup-${randomUUID()}`,
          markdown,
          responseKind: 'final',
        },
      };
    }

    const queryPlanId = await freshPlan(caller, payload.query);
    const exported = await callDataMcpService('export', caller, {
      ...payload.query,
      query_plan_id: queryPlanId,
      filename: sanitizedExcelFilename(args.filename),
    });
    if (exported?.status !== 'success') throw new Error('followup_export_failed');
    store.assertVersion(identity, expectedVersion);
    const path = copyExportToPluginOutbound(exported.file);
    try {
      store.assertVersion(identity, expectedVersion);
    } catch (error) {
      discardStagedOutboundArtifact(path);
      throw error;
    }
    store.touch(identity, expectedVersion);
    store.audit(identity, caller.turnId, question, expectedVersion, 'delivery_requested');
    return {
      delivery: {
        schemaVersion: 1,
        deliveryId: `data-followup-${randomUUID()}`,
        markdown: `Excel 为重新查询结果。\n\n生成时间：${new Date().toISOString()}`,
        files: [{ path }],
        responseKind: 'final',
      },
    };
  } catch {
    store.audit(identity, caller.turnId, question, expectedVersion, 'delivery_failed');
    return { error: fixedFollowupResult('delivery_failed') };
  }
}

function isolatedDeliveryFailure() {
  return {
    status: 'error',
    error_code: 'isolated_data_operation_failed',
    message: '数据操作失败；为保护业务数据，未向调用模型返回上游响应详情',
  };
}

async function callDataMcpService(kind, caller, args) {
  if (!caller.requestUserUnionId) {
    return {
      status: 'validation_error',
      message: '缺少 Botmux Gateway 注入的 requestUserUnionId，拒绝执行数据查询',
      issues: [{
        code: 'missing_trusted_union_id',
        severity: 'error',
        message: 'Data MCP 查询必须绑定宿主侧可信 union_id，不能回退到模型或用户自报身份',
        suggested_action: '请确认当前 Botmux runtime 已启用 MCP Gateway 可信身份注入，并从真实飞书用户消息触发',
      }],
      permission_scope: 'user_identity',
    };
  }

  if (kind === 'refreshSnapshot' || kind === 'defaultRoleBaseline') {
    if (
      caller.callerSource !== 'schedule_creator'
      || !caller.taskId
      || !caller.requestUserOpenId
      || !caller.requestLarkAppId
    ) {
      return {
        status: 'validation_error',
        result_class: 'policy_error',
        message: `${kind === 'refreshSnapshot' ? '元数据快照刷新' : '默认角色全量巡检'}只允许带 task/app 绑定的 schedule_creator 任务触发`,
        issues: [{
          code: kind === 'refreshSnapshot'
            ? 'metadata_snapshot_schedule_identity_required'
            : 'access_audit_schedule_required',
          severity: 'error',
          message: '刷新身份必须由宿主注入 schedule_creator、task_id、app_id 与 owner open_id/union_id',
          suggested_action: '请由任务创建者通过目标 Bot 的飞书原生 /schedule 创建固定刷新任务',
        }],
        permission_scope: kind === 'refreshSnapshot'
          ? 'metadata_snapshot_refresh'
          : 'ck_access_consistency_audit',
        audit_context: auditContext(caller),
      };
    }
  } else if (kind !== 'validate' && kind !== 'searchSnapshot') {
    const policyIssue = callerPolicyIssue(caller);
    if (policyIssue) return policyIssue;
  }

  if (kind === 'searchSnapshot') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return {
        status: 'validation_error',
        error_code: 'metadata_snapshot_query_required',
        message: '元数据检索 query 不能为空',
        permission_scope: 'metadata_snapshot',
      };
    }
    if (
      args.limit !== undefined
      && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50)
    ) {
      return {
        status: 'validation_error',
        error_code: 'metadata_snapshot_limit_invalid',
        message: '元数据检索 limit 必须是 1 到 50 的整数',
        permission_scope: 'metadata_snapshot',
      };
    }
    if (args.priority !== undefined && typeof args.priority !== 'string') {
      return {
        status: 'validation_error',
        error_code: 'metadata_snapshot_priority_invalid',
        message: '元数据检索 priority 必须是字符串',
        permission_scope: 'metadata_snapshot',
      };
    }
    const payload = { query };
    if (args.limit !== undefined) payload.limit = args.limit;
    if (typeof args.priority === 'string' && args.priority.trim()) {
      payload.priority = args.priority.trim();
    }
    return callSnapshotService(kind, caller, payload);
  }

  if (kind === 'refreshSnapshot') {
    const payload = trustedCallerPayload(caller);
    return callSnapshotService(kind, caller, payload);
  }

  if (kind === 'defaultRoleBaseline') {
    return callSnapshotService(kind, caller, trustedCallerPayload(caller));
  }

  if (kind === 'subjectsByTable') {
    if (!caller.turnId) {
      return {
        status: 'validation_error', result_class: 'policy_error', verdict: 'inconclusive',
        error_code: 'access_inspection_turn_required',
        message: '权限反查必须绑定宿主注入的真实 turn_id',
      };
    }
    const targetTables = Array.isArray(args.target_tables)
      ? args.target_tables.filter(value => typeof value === 'string').map(value => value.trim())
      : [];
    if (!targetTables.length || targetTables.length > 50) {
      return {
        status: 'validation_error', result_class: 'policy_error', verdict: 'inconclusive',
        error_code: 'invalid_access_inspection_scope',
        message: '必须显式提供 1 到 50 个目标 database.table，不接受空范围或全量通配',
      };
    }
    return callSnapshotService(kind, caller, {
      ...trustedCallerPayload(caller), target_tables: targetTables,
    });
  }

  if (kind === 'resourcesBySubject') {
    if (!caller.turnId) {
      return {
        status: 'validation_error', result_class: 'policy_error', verdict: 'inconclusive',
        error_code: 'access_inspection_turn_required',
        message: '权限反查必须绑定宿主注入的真实 turn_id',
      };
    }
    const targetAccounts = Array.isArray(args.target_accounts)
      ? args.target_accounts.filter(value => typeof value === 'string').map(value => value.trim())
      : [];
    const targetRoles = Array.isArray(args.target_roles)
      ? args.target_roles.filter(value => typeof value === 'string').map(value => value.trim())
      : [];
    if (!targetAccounts.length && !targetRoles.length) {
      return {
        status: 'validation_error', result_class: 'policy_error', verdict: 'inconclusive',
        error_code: 'invalid_access_inspection_scope',
        message: '必须显式提供目标账号或角色，不接受空范围或全量枚举',
      };
    }
    if (targetAccounts.length + targetRoles.length > 100) {
      return {
        status: 'validation_error', result_class: 'policy_error', verdict: 'inconclusive',
        error_code: 'invalid_access_inspection_scope', message: '单次最多检查 100 个账号与角色',
      };
    }
    return callSnapshotService(kind, caller, {
      ...trustedCallerPayload(caller),
      target_accounts: targetAccounts,
      target_roles: targetRoles,
    });
  }

  const sql = typeof args.sql === 'string' ? args.sql : '';
  if (!sql.trim()) {
    return {
      status: 'validation_error',
      message: '缺少必填参数 sql',
      issues: [{
        code: 'missing_sql',
        severity: 'error',
        message: 'validate_sql_for_user / run_query_for_user 只接收显式 SQL，不在插件侧生成 SQL',
      }],
    };
  }

  const executionContext = trustedQueryPlanContext();
  if (!executionContext) {
    return {
      status: 'validation_error',
      result_class: 'policy_error',
      message: '缺少 BotMux 查询计划执行上下文，拒绝签发或消费查询计划',
      issues: [{
        code: 'query_plan_session_required',
        severity: 'error',
        message: 'Data MCP 查询计划必须绑定宿主进程注入的 BOTMUX_SESSION_ID 或 BOTMUX_EXECUTION_ID',
      }],
      permission_scope: 'query_plan',
    };
  }

  const datasource = typeof args.datasource === 'string' && args.datasource.trim()
    ? args.datasource.trim()
    : 'tchouse-c';
  if (datasource !== 'tchouse-c') {
    return {
      status: 'validation_error',
      result_class: 'policy_error',
      message: '当前公开查询入口仅支持 tchouse-c 数据源',
      issues: [{
        code: 'unsupported_datasource',
        severity: 'error',
        message: 'validate/run/export 仅允许 tchouse-c',
      }],
      permission_scope: 'datasource',
    };
  }
  const executionMode = kind === 'validate'
    ? (typeof args.execution_mode === 'string' ? args.execution_mode : 'single')
    : undefined;
  if (kind === 'validate' && !['single', 'compare'].includes(executionMode)) {
    return {
      status: 'validation_error',
      result_class: 'policy_error',
      message: 'execution_mode 仅支持 single 或 compare',
      issues: [{ code: 'query_plan_execution_mode_invalid', severity: 'error' }],
      permission_scope: 'query_plan',
    };
  }
  if (kind !== 'validate' && (typeof args.query_plan_id !== 'string' || !args.query_plan_id.trim())) {
    return {
      status: 'validation_error',
      message: '缺少必填参数 query_plan_id，请先调用 validate_sql_for_user',
      issues: [{
        code: 'query_plan_required',
        severity: 'error',
        message: 'run/export 必须携带 validate_sql_for_user 返回的 query_plan_id',
        suggested_action: '先调用 validate_sql_for_user 获取 query_plan_id，再执行查询或导出',
      }],
      permission_scope: 'query_plan',
    };
  }
  const payload = {
    request_user_union_id: caller.requestUserUnionId,
    ...(caller.requestUserOpenId ? { request_user_open_id: caller.requestUserOpenId } : {}),
    ...(caller.requestLarkAppId ? { request_lark_app_id: caller.requestLarkAppId } : {}),
    caller_source: caller.callerSource ?? null,
    caller_sender_type: caller.senderType ?? 'unknown_legacy',
    // Keep the downstream field name for compatibility. The value is either a
    // real session id or the host-owned execution id used by a sessionless run.
    caller_session_id: executionContext.id,
    caller_task_id: caller.taskId ?? null,
    caller_turn_id: caller.turnId ?? null,
    caller_captured_at: caller.capturedAt ?? null,
    sql,
    datasource,
    ...(kind === 'validate' ? { execution_mode: executionMode } : {}),
    ...(kind === 'validate' && typeof args.repair_chain_id === 'string' && args.repair_chain_id.trim()
      ? { repair_chain_id: args.repair_chain_id.trim() }
      : {}),
    ...(kind !== 'validate' ? { query_plan_id: args.query_plan_id.trim() } : {}),
  };
  if (kind === 'export') {
    if (typeof args.filename === 'string' && args.filename.trim()) {
      payload.filename = args.filename.trim();
    }
    if (Number.isSafeInteger(args.max_export_rows) && args.max_export_rows > 0) {
      payload.max_export_rows = args.max_export_rows;
    }
    if (typeof args.expected_source_version === 'string' && args.expected_source_version.trim()) {
      payload.expected_source_version = args.expected_source_version.trim();
    }
  }

  let response;
  try {
    const explicit = explicitServiceEndpoint(kind);
    const socketPath = serviceSocketPath();
    response = explicit || !socketPath
      ? await postJsonOverUrl(explicit || serviceEndpoint(kind), payload)
      : await postJsonOverUnixSocket(socketPath, servicePath(kind), payload);
  } catch (err) {
    return {
      status: 'error',
      result_class: 'inconclusive',
      error_code: 'data_mcp_service_unreachable',
      message: `Data MCP 服务不可达：${err instanceof Error ? err.message : String(err)}`,
      suggested_action: '请确认 Python Data MCP API 已在本机启动，或联系服务维护方检查 endpoint 配置',
    };
  }

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw_response: text };
  }

  if (!response.ok) {
    return {
      status: 'error',
      result_class: 'inconclusive',
      error_code: 'data_mcp_service_error',
      message: `Data MCP 服务返回 HTTP ${response.status}`,
      detail: redactHttpErrorDetail(kind, caller),
    };
  }
  if (kind === 'validate') {
    return isTrustedHumanOrSchedule(caller)
      ? sanitizeValidationResult(body)
      : redactSchemaDetailsForUntrustedCaller(body, caller);
  }
  return body;
}

function trustedCallerPayload(caller) {
  return {
    request_user_union_id: caller.requestUserUnionId,
    ...(caller.requestUserOpenId ? { request_user_open_id: caller.requestUserOpenId } : {}),
    ...(caller.requestLarkAppId ? { request_lark_app_id: caller.requestLarkAppId } : {}),
    caller_source: caller.callerSource ?? null,
    caller_sender_type: caller.senderType ?? 'unknown_legacy',
    caller_task_id: caller.taskId ?? null,
    caller_turn_id: caller.turnId ?? null,
    caller_captured_at: caller.capturedAt ?? null,
  };
}

async function callSnapshotService(kind, caller, payload) {
  const isAudit = [
    'defaultRoleBaseline', 'subjectsByTable', 'resourcesBySubject',
  ].includes(kind);
  let response;
  try {
    const socketPath = serviceSocketPath();
    response = socketPath
      ? await postJsonOverUnixSocket(socketPath, servicePath(kind), payload)
      : await postJsonOverUrl(serviceEndpoint(kind), payload);
  } catch (err) {
    return {
      status: 'error',
      ...(isAudit ? { result_class: 'inconclusive', verdict: 'inconclusive' } : {}),
      error_code: isAudit ? 'access_audit_service_unreachable' : 'metadata_snapshot_service_unreachable',
      message: `Data MCP ${isAudit ? '审计' : '快照'}服务不可达：${err instanceof Error ? err.message : String(err)}`,
      suggested_action: `请维护方恢复同一 Unix socket 上的 Data MCP ${isAudit ? '审计' : '快照'}服务`,
    };
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    return {
      status: 'error',
      ...(isAudit ? { result_class: 'inconclusive', verdict: 'inconclusive' } : {}),
      error_code: isAudit ? 'access_audit_service_error' : 'metadata_snapshot_service_error',
      message: `Data MCP ${isAudit ? '审计' : '快照'}服务返回 HTTP ${response.status}`,
      permission_scope: isAudit ? 'ck_access_consistency_audit' : 'metadata_snapshot',
      audit_context: auditContext(caller),
    };
  }
  return kind === 'searchSnapshot' ? sanitizeMetadataSearchResult(body) : body;
}

async function handleToolCall(request) {
  const caller = trustedCallerFrom(request);
  if (!caller) {
    error(
      request.id,
      -32001,
      'trusted_identity_required',
      'Data MCP requires Botmux MCP Gateway host-injected botmuxTrustedCaller metadata.',
    );
    return;
  }

  const name = request.params?.name;
  if (name === 'data_mcp_identity_probe') {
    ok(request.id, jsonTool({
      ok: true,
      trustedCaller: callerDiagnostic(caller),
      pluginId: process.env.BOTMUX_PLUGIN_ID ?? null,
      sessionId: nonBlankProcessEnv('BOTMUX_SESSION_ID') ?? null,
      queryPlanContextSource: trustedQueryPlanContext()?.source ?? null,
    }));
    return;
  }

  if (name !== 'data_mcp_query_plan') {
    const bindingIssue = scheduleTurnBindingIssue(caller);
    if (bindingIssue) {
      ok(request.id, jsonTool(bindingIssue));
      return;
    }
  }

  if (name === 'data_mcp_query_plan') {
    ok(request.id, jsonTool({
      ok: true,
      trustedCaller: callerDiagnostic(caller),
      status: 'plan_only',
      nextSteps: [
        'resolve trusted caller to enterprise email / data account on Data MCP service side',
        'look up metadata dictionary for candidate tables and metric definitions on Data MCP service side',
        'ask user to confirm ambiguous scope/date/region',
        'generate read-only SQL only after scope is clear',
        'call validate_sql_for_user, then run_query_for_user when validation succeeds',
      ],
      request: argsFrom(request),
    }));
    return;
  }

  if (name === 'validate_sql_for_user') {
    ok(request.id, jsonTool(await callDataMcpService('validate', caller, argsFrom(request))));
    return;
  }

  if (name === 'run_query_for_user' || name === 'export_query_to_excel_file') {
    const policyIssue = callerPolicyIssue(caller);
    ok(request.id, jsonTool({
      ...(policyIssue ?? {
        status: 'validation_error',
        error_code: 'isolated_delivery_required',
        message: '业务结果必须留在内网投递链路，请改用 deliver_query_result_for_user',
      }),
    }));
    return;
  }

  if (name === 'deliver_query_result_for_user') {
    let prepared;
    try {
      prepared = await deliverQueryResult(caller, argsFrom(request));
    } catch {
      prepared = { error: isolatedDeliveryFailure() };
    }
    ok(request.id, prepared.error ? jsonTool(prepared.error) : hostDeliveryTool(prepared.delivery));
    return;
  }

  if (name === 'continue_query_result_for_user') {
    let prepared;
    try {
      prepared = await continueQueryResult(caller, argsFrom(request));
    } catch {
      prepared = { error: fixedFollowupResult('delivery_failed') };
    }
    ok(request.id, prepared.error ? jsonTool(prepared.error) : hostDeliveryTool(prepared.delivery));
    return;
  }

  if (name === 'refresh_metadata_snapshot') {
    ok(request.id, jsonTool(await callDataMcpService('refreshSnapshot', caller, argsFrom(request))));
    return;
  }

  if (name === 'search_metadata_snapshot') {
    ok(request.id, jsonTool(await callDataMcpService('searchSnapshot', caller, argsFrom(request))));
    return;
  }

  if (name === 'inspect_ck_subjects_by_table') {
    ok(request.id, jsonTool(await callDataMcpService('subjectsByTable', caller, argsFrom(request))));
    return;
  }

  if (name === 'inspect_ck_resources_by_subject') {
    ok(request.id, jsonTool(await callDataMcpService('resourcesBySubject', caller, argsFrom(request))));
    return;
  }

  if (name === 'audit_ck_default_role_baseline') {
    ok(request.id, jsonTool(await callDataMcpService('defaultRoleBaseline', caller, argsFrom(request))));
    return;
  }

  error(request.id, -32602, `unknown_tool:${String(name)}`);
}

function toolSchemas() {
  return [
    {
      name: 'data_mcp_identity_probe',
      description: 'Return the Botmux Gateway trusted caller context visible to Data MCP.',
      inputSchema: { type: 'object', additionalProperties: false },
    },
    {
      name: 'data_mcp_query_plan',
      description: 'Build a safe Data MCP query plan without executing database access.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          table: { type: 'string' },
          metric: { type: 'string' },
          dateRange: { type: 'string' },
          region: { type: 'string' },
        },
        additionalProperties: true,
      },
    },
    {
      name: 'validate_sql_for_user',
      description: 'Validate explicit read-only SQL through the Data MCP service using Botmux trusted caller identity.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          datasource: { type: 'string', enum: ['tchouse-c'], default: 'tchouse-c' },
          execution_mode: { type: 'string', enum: ['single', 'compare'], default: 'single' },
          repair_chain_id: { type: 'string', description: 'Reuse only when correcting the same failed SQL attempt.' },
        },
        required: ['sql'],
        additionalProperties: false,
      },
    },
    {
      name: 'run_query_for_user',
      description: 'Run explicit read-only SQL through the Data MCP service using Botmux trusted caller identity.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          datasource: { type: 'string', enum: ['tchouse-c'], default: 'tchouse-c' },
          query_plan_id: { type: 'string' },
        },
        required: ['sql', 'query_plan_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'export_query_to_excel_file',
      description: 'Run explicit read-only SQL through the Data MCP service and export the result to a local Excel file artifact when the user explicitly asks for a file.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          datasource: { type: 'string', enum: ['tchouse-c'], default: 'tchouse-c' },
          query_plan_id: { type: 'string' },
          filename: { type: 'string' },
          max_export_rows: { type: 'integer', minimum: 1 },
          expected_source_version: { type: 'string', minLength: 1, maxLength: 256 },
        },
        required: ['sql', 'query_plan_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'deliver_query_result_for_user',
      description: 'Execute one approved query and deliver either an internal-model analysis or an Excel artifact through the trusted Botmux host without exposing business data to the calling model.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          datasource: { type: 'string', enum: ['tchouse-c'], default: 'tchouse-c' },
          query_plan_id: { type: 'string' },
          output_mode: { type: 'string', enum: ['analysis', 'excel'] },
          question: { type: 'string' },
          filename: { type: 'string' },
          max_export_rows: { type: 'integer', minimum: 1 },
        },
        required: ['sql', 'query_plan_id', 'output_mode'],
        additionalProperties: false,
      },
    },
    {
      name: 'continue_query_result_for_user',
      description: 'Continue analysis of the caller-bound active result and deliver the answer through the trusted Botmux host without exposing result data to the calling model.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 4000 },
          output_mode: { type: 'string', enum: ['analysis', 'excel'], default: 'analysis' },
          filename: { type: 'string', maxLength: 200 },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
    {
      name: 'refresh_metadata_snapshot',
      description: 'Refresh the signed local metadata snapshot. Only a host-injected schedule_creator task with task/app/owner binding is accepted.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'search_metadata_snapshot',
      description: 'Search the verified signed local metadata snapshot for candidate tables, fields, partitions, and metric definitions. Never falls back to online metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          priority: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'audit_ck_default_role_baseline',
      description: 'Schedule-only entry-point DEFAULT ROLE ALL baseline. Returns anomalous account names only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'inspect_ck_subjects_by_table',
      description: 'List effective direct and inherited SELECT holders for explicit ClickHouse tables from one entry point. Fixed template; never accepts SQL.',
      inputSchema: {
        type: 'object',
        properties: {
          target_tables: {
            type: 'array', minItems: 1, maxItems: 50,
            items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*$' },
          },
        },
        required: ['target_tables'],
        additionalProperties: false,
      },
    },
    {
      name: 'inspect_ck_resources_by_subject',
      description: 'List direct and inherited ClickHouse resources for explicit accounts or roles from one entry point. Fixed template; never accepts SQL.',
      inputSchema: {
        type: 'object',
        properties: {
          target_accounts: {
            type: 'array', maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 128 },
          },
          target_roles: {
            type: 'array', maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
        additionalProperties: false,
      },
    },
  ];
}

input.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    ok(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'data-mcp', version: packageVersion() },
    });
    return;
  }
  if (request.method === 'tools/list') {
    ok(request.id, { tools: toolSchemas() });
    return;
  }
  if (request.method === 'tools/call') {
    handleToolCall(request).catch((err) => {
      error(
        request.id,
        -32000,
        'data_mcp_plugin_error',
        err instanceof Error ? err.message : String(err),
      );
    });
    return;
  }
  if (request.method === 'ping') {
    ok(request.id, {});
    return;
  }
  error(request.id, -32601, 'Method not found');
});
