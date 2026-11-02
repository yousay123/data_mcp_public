import { createInterface } from 'node:readline';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { clearAllStoredResults, ResultStore } from './result-store.js';
import { runIsolatedResultAgent } from './result-agent-client.js';
import { resolveSignedAppTestProfile, TEST_PROFILE_ALLOWED_KEYS } from './signed-app-profile.js';
import { deliverDirectLarkReply, DirectReplyError } from './direct-lark-reply.js';

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
const OUTBOUND_ARTIFACT_PREFIXES = ['data-mcp-', 'result-agent-'];
const OUTBOUND_STALE_AFTER_MS = 15 * 60 * 1000;
const DELIVERY_BUDGET_MS = 55_000;
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
    if (!OUTBOUND_ARTIFACT_PREFIXES.some(prefix => name.startsWith(prefix) || name.startsWith(`.${prefix}`))) continue;
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

function hostOnlyConfigValue(name) {
  const fromHostFile = hostEnv()[name];
  return typeof fromHostFile === 'string' && fromHostFile ? fromHostFile : undefined;
}

if (configValue('DATA_MCP_RESULT_MODEL_TEST_EXCEPTION')) {
  console.error('[data-mcp] WARN test-only result model endpoint exception is configured');
}
if (process.env.DATA_MCP_TEST_PROFILE_APP_ID || process.env.DATA_MCP_TEST_PROFILE_ENV_FILE) {
  console.error(
    '[data-mcp] WARN process-level signed-app test profile selectors are ignored; '
    + 'configure them in KSHER_AGENT_DATA_MCP_ENV_FILE',
  );
}
if (hostOnlyConfigValue('DATA_MCP_TEST_PROFILE_APP_ID')
  || hostOnlyConfigValue('DATA_MCP_TEST_PROFILE_ENV_FILE')) {
  console.error('[data-mcp] WARN signed-app test profile selection is configured');
}

function runtimeConfigForCaller(caller) {
  const profile = resolveSignedAppTestProfile(caller, {
    // The selector controls whether a signed caller is redirected to a test
    // service. Keep it in the host-owned configuration plane: per-bot runtime
    // env is session-local and can be copied to the wrong bot accidentally.
    DATA_MCP_TEST_PROFILE_APP_ID: hostOnlyConfigValue('DATA_MCP_TEST_PROFILE_APP_ID'),
    DATA_MCP_TEST_PROFILE_ENV_FILE: hostOnlyConfigValue('DATA_MCP_TEST_PROFILE_ENV_FILE'),
  });
  return Object.freeze({
    testProfileSelected: profile !== undefined,
    value(name) {
      if (profile && TEST_PROFILE_ALLOWED_KEYS.has(name)) {
        const override = profile[name];
        return typeof override === 'string' && override ? override : undefined;
      }
      return configValue(name);
    },
  });
}

const hostRuntimeConfig = Object.freeze({
  testProfileSelected: false,
  value: configValue,
});

function enabledDatasourceIds() {
  const configured = configValue('DATA_MCP_ENABLED_DATASOURCES') || 'tchouse-c';
  const values = configured
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9][a-z0-9-]*$/.test(value));
  return [...new Set(values.length ? values : ['tchouse-c'])];
}

function defaultDatasourceId(datasourceIds) {
  return datasourceIds.includes('tchouse-c') ? 'tchouse-c' : undefined;
}

function queryDatasourceSchema(datasourceIds) {
  const schema = { type: 'string', enum: datasourceIds };
  const defaultDatasource = defaultDatasourceId(datasourceIds);
  if (defaultDatasource) schema.default = defaultDatasource;
  return schema;
}
function nonBlankProcessEnv(name) {
  // Security boundary: query-plan context must come from the host-owned child
  // process environment. Do not replace this with configValue(), whose local
  // host-env-file fallback is valid for service config but not caller context.
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function dataMcpModelMode() {
  const mode = nonBlankProcessEnv('DATA_MCP_MODEL_MODE') ?? 'dual';
  if (mode !== 'single' && mode !== 'dual') {
    throw new Error('data_mcp_model_mode_invalid');
  }
  return mode;
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
    const issues = Array.isArray(body?.issues)
      ? body.issues.slice(0, 20).flatMap(issue => {
        if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return [];
        const code = typeof issue.code === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(issue.code)
          ? issue.code : null;
        if (!code) return [];
        return [{
          code,
          severity: typeof issue.severity === 'string' && /^[a-z]{1,20}$/.test(issue.severity)
            ? issue.severity : 'error',
          ...(typeof issue.message === 'string' && issue.message.length <= 500
            ? { message: issue.message } : {}),
          ...(typeof issue.suggested_action === 'string' && issue.suggested_action.length <= 500
            ? { suggested_action: issue.suggested_action } : {}),
        }];
      })
      : [];
    const directCode = typeof body?.error_code === 'string'
      && /^[A-Za-z0-9_.-]{1,128}$/.test(body.error_code)
      ? body.error_code : null;
    return {
      status: 'validation_error',
      error_code: directCode || (issues.length === 1 ? issues[0].code : 'sql_validation_failed'),
      message: issues.length === 1 && issues[0].message
        ? issues[0].message : 'SQL 校验失败，请根据安全问题码修正后重新校验',
      ...(issues.length ? { issues } : {}),
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

function argsFrom(request) {
  return request.params?.arguments && typeof request.params.arguments === 'object'
    ? request.params.arguments
    : {};
}

function serviceBaseUrl(runtimeConfig) {
  return (runtimeConfig.value('DATA_MCP_SERVICE_BASE_URL') || DEFAULT_SERVICE_BASE_URL).replace(/\/+$/, '');
}

function explicitServiceEndpoint(kind, runtimeConfig) {
  // A selected profile's dedicated Unix socket is the complete service
  // boundary. Never let a default-profile per-tool URL bypass it.
  if (runtimeConfig.testProfileSelected) return undefined;
  if (kind === 'validate') {
    return runtimeConfig.value('DATA_MCP_VALIDATE_SQL_ENDPOINT');
  } else if (kind === 'run') {
    return runtimeConfig.value('DATA_MCP_RUN_QUERY_ENDPOINT') || runtimeConfig.value('DATA_MCP_QUERY_ENDPOINT');
  }
  // Snapshot endpoints deliberately have no per-tool environment override.
  // They must use the same private Unix-socket service boundary as the other tools.
  return undefined;
}

function servicePath(kind) {
  if (kind === 'validate') return '/agent/validate-sql';
  if (kind === 'run') return '/agent/run-query';
  if (kind === 'refreshSnapshot') return '/agent/refresh-metadata-snapshot';
  if (kind === 'searchSnapshot') return '/agent/search-metadata-snapshot';
  if (kind === 'searchDlcTables') return '/agent/search-dlc-tables';
  if (kind === 'subjectsByTable') return '/agent/inspect-ck-subjects-by-table';
  if (kind === 'resourcesBySubject') return '/agent/inspect-ck-resources-by-subject';
  if (kind === 'defaultRoleBaseline') return '/agent/audit-ck-default-role-baseline';
  throw new Error(`unsupported_service_kind:${String(kind)}`);
}

function serviceEndpoint(kind, runtimeConfig) {
  const explicit = explicitServiceEndpoint(kind, runtimeConfig);
  if (explicit) return explicit;
  return `${serviceBaseUrl(runtimeConfig)}${servicePath(kind)}`;
}

function serviceSocketPath(runtimeConfig) {
  const socketPath = runtimeConfig.value('DATA_MCP_SERVICE_SOCKET_PATH');
  if (socketPath === 'disabled') return undefined;
  return socketPath || DEFAULT_SERVICE_SOCKET_PATH;
}

function serviceHeaders(runtimeConfig) {
  const headers = { 'content-type': 'application/json' };
  const token = runtimeConfig
    ? runtimeConfig.value('DATA_MCP_INTERNAL_AUTH_TOKEN')
    : hostEnv().DATA_MCP_INTERNAL_AUTH_TOKEN;
  if (token) {
    headers[INTERNAL_AUTH_HEADER] = token;
  }
  return headers;
}

function postJsonOverUnixSocket(socketPath, path, payload, runtimeConfig) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = httpRequest({
      socketPath,
      path,
      method: 'POST',
      headers: {
        ...serviceHeaders(runtimeConfig),
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

function postJsonOverUrl(endpoint, payload, runtimeConfig) {
  if (endpoint.startsWith('data:')) {
    return fetch(endpoint, {
      method: 'POST',
      headers: serviceHeaders(runtimeConfig),
      body: JSON.stringify(payload),
    });
  }
  const url = new URL(endpoint);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers = {
      ...serviceHeaders(runtimeConfig),
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

function discardStagedOutboundArtifact(path) {
  if (!path) return;
  stagedOutboundArtifacts.delete(path);
  try { unlinkSync(path); } catch { /* already consumed or absent */ }
}

function requestedOutputs(args) {
  if (Array.isArray(args.requested_outputs)) return args.requested_outputs;
  if (args.output_mode === 'excel') return ['excel'];
  if (args.output_mode === 'pdf') return ['pdf'];
  if (args.output_mode === 'chart') return ['chart'];
  if (args.output_mode === 'document' || args.output_mode === 'feishu_doc') return ['document'];
  return ['analysis'];
}

async function runResultAgent(result, args, runtimeConfig, timeoutMs) {
  return runIsolatedResultAgent({
    result,
    question: typeof args.question === 'string' && args.question.trim()
      ? args.question.trim()
      : '请基于本次查询结果生成用户要求的产物',
    requestedOutputs: requestedOutputs(args),
    runtimeConfig,
    pluginHome: nonBlankProcessEnv('BOTMUX_PLUGIN_HOME'),
    onTestExceptionUsed: hostname => resultStoreFor().auditModelEndpointException(hostname),
    timeoutMs,
  });
}

function resultAgentAuditDetail(trace, result) {
  const detail = trace && typeof trace === 'object' && !Array.isArray(trace) ? trace : {};
  return {
    stage: 'result_agent',
    action: 'model_request',
    queryId: result?.query_id,
    providerTaskId: result?.datasource === 'dlc' ? result.query_id : undefined,
    modelId: detail.modelId,
    responseModel: detail.responseModel,
    endpointHost: detail.endpointHost,
    requestId: detail.requestId,
    promptTemplateVersion: detail.promptTemplateVersion,
    promptTemplateHash: detail.promptTemplateHash,
    inputHash: detail.inputHash,
    outputHash: detail.outputHash,
    inputRowCount: detail.inputRowCount,
    latencyMs: detail.latencyMs,
    httpStatus: detail.httpStatus,
  };
}

function resultAgentAuditStatus(error) {
  const code = error instanceof Error ? error.message : '';
  const safeCodes = new Set([
    'result_agent_not_configured',
    'result_agent_endpoint_not_allowed',
    'result_agent_payload_too_large',
    'result_agent_invalid_json',
    'result_agent_invalid_response',
    'result_agent_context_invalid',
    'result_agent_schema_missing',
    'result_agent_invalid_rows',
    'result_agent_timeout',
    'result_agent_ipc_payload_too_large',
    'result_agent_ipc_invalid_response',
    'result_agent_worker_failed',
    'result_agent_process_isolation_failed',
    'result_agent_context_missing',
    'result_model_network_not_private',
  ]);
  if (/^result_agent_http_[1-5][0-9]{2}$/.test(code)) return code;
  return safeCodes.has(code) ? code : 'result_agent_failed';
}

function resultAgentAuditAction(errorCode) {
  if (errorCode === 'result_agent_not_configured') return 'model_config';
  if (errorCode === 'result_agent_endpoint_not_allowed'
    || errorCode === 'result_model_network_not_private') return 'endpoint_validation';
  if (errorCode === 'result_agent_timeout' || errorCode.startsWith('result_agent_http_')) return 'model_request';
  if (errorCode.includes('context') || errorCode.includes('schema') || errorCode.includes('rows')) {
    return 'result_validation';
  }
  if (errorCode.includes('ipc') || errorCode.includes('worker') || errorCode.includes('process_isolation')) {
    return 'worker_isolation';
  }
  return 'result_processing';
}

function resultAgentMayUseDeterministicFallback(errorCode) {
  return errorCode === 'result_agent_not_configured'
    || errorCode === 'result_agent_timeout'
    || /^result_agent_http_5[0-9]{2}$/.test(errorCode);
}

function markdownCell(value) {
  if (value === null || value === undefined) return 'NULL';
  if (!['string', 'number', 'boolean', 'bigint'].includes(typeof value)) {
    throw new Error('deterministic_fallback_unsupported_value');
  }
  const text = String(value);
  if (text.length > 500) throw new Error('deterministic_fallback_value_too_large');
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/g, ' ');
}

function deterministicContextLines(result) {
  const context = result?.result_context;
  if (!context || typeof context !== 'object') return [];
  const rows = [
    ['数据源', String(context.datasource || result.datasource || '').toUpperCase()],
    ['数据表', Array.isArray(context.tables) ? context.tables.join('、') : ''],
    ['统计口径', Array.isArray(context.metric_expressions)
      ? context.metric_expressions.join('、') : ''],
  ].filter(([, value]) => value);
  if (Array.isArray(context.time_range_predicates) && context.time_range_predicates.length) {
    rows.push(['时间范围', context.time_range_predicates.join(' AND ')]);
  }
  if (!rows.length) return [];
  return [
    '## 查询口径',
    '',
    '| 口径项 | 内容 |',
    '| --- | --- |',
    ...rows.map(([label, value]) => `| ${label} | ${markdownCell(value)} |`),
  ];
}

function deterministicAnalysisFallback(result, args) {
  const outputs = requestedOutputs(args);
  if (outputs.length !== 1 || outputs[0] !== 'analysis') return null;
  const columns = (Array.isArray(result.columns) ? result.columns : [])
    .map(column => typeof column === 'string' ? column : column?.name)
    .filter(column => typeof column === 'string' && column.trim())
    .map(column => column.trim());
  const rows = Array.isArray(result.rows) ? result.rows : Array.isArray(result.data) ? result.data : [];
  if (columns.length < 1 || columns.length > 20 || rows.length < 1 || rows.length > 20) return null;
  const renderedRows = rows.map(row => {
    if (Array.isArray(row)) return columns.map((_, index) => markdownCell(row[index]));
    if (row && typeof row === 'object') return columns.map(column => markdownCell(row[column]));
    throw new Error('deterministic_fallback_invalid_row');
  });
  const markdown = [
    '# 查询结果',
    '',
    '> 结果代理暂不可用，以下为受控查询返回的原始结果，未作额外口径推断。',
    '',
    '## 数据明细',
    '',
    `| ${columns.map(markdownCell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...renderedRows.map(row => `| ${row.join(' | ')} |`),
    '',
    ...deterministicContextLines(result),
  ].join('\n');
  if (Buffer.byteLength(markdown) > 16 * 1024) return null;
  return { markdown, files: [] };
}

function safeDiagnosticText(value, fallback, max = 500) {
  return typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim() : fallback;
}

function safeDiagnosticCode(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value)
    ? value : fallback;
}

function deterministicDlcFailure(result, args) {
  if (!result || result.status === 'success'
    || (result.datasource !== 'dlc' && args.datasource !== 'dlc')) return null;
  const errorCode = safeDiagnosticCode(result.error_code, 'dlc_query_failed');
  const failureStage = safeDiagnosticCode(result.failure_stage, 'dlc_task_execution');
  const failureAction = safeDiagnosticCode(result.failure_action, null);
  const diagnosticCase = result.diagnostic_case == null
    ? null : safeDiagnosticCode(result.diagnostic_case, null);
  const queryId = safeDiagnosticCode(result.query_id, null);
  const planId = safeDiagnosticCode(args.query_plan_id, null);
  const diagnosis = safeDiagnosticText(
    result.diagnostic_summary,
    `DLC 查询失败（${errorCode}）`,
  );
  const suggestedAction = safeDiagnosticText(
    result.suggested_action,
    '请维护方根据安全错误码和查询标识检查 DLC 审计后再处理',
  );
  const details = [
    ['失败阶段', failureStage],
    ...(failureAction ? [['失败动作', failureAction]] : []),
    ['安全错误码', errorCode],
    ['可重试', result.retryable === true ? '是；确认上游状态后再重试' : '否；先完成排障'],
    ...(diagnosticCase ? [['WeData 排障案例', diagnosticCase]] : []),
    ...(planId ? [['查询计划', planId]] : []),
    ...(queryId ? [['DLC Query ID', queryId]] : []),
  ];
  return {
    markdown: [
      '# DLC 查询失败',
      '',
      '## 排查结论',
      '',
      diagnosis,
      '',
      '## 故障信息',
      '',
      '| 项目 | 内容 |',
      '| --- | --- |',
      ...details.map(([label, value]) => `| ${markdownCell(label)} | ${markdownCell(value)} |`),
      '',
      '## 建议处理',
      '',
      suggestedAction,
      '',
      '> 排障基于 WeData Skill 的受控 DLC 调用链路和案例规则；未向模型或消息暴露凭证、原始响应体及账号敏感信息。',
    ].join('\n'),
    files: [],
  };
}

function deterministicResultAgentFailure(result, args, errorCode) {
  const queryId = safeDiagnosticCode(result?.query_id, null);
  const planId = safeDiagnosticCode(args.query_plan_id, null);
  const action = resultAgentAuditAction(errorCode);
  const details = [
    ['失败阶段', 'result_agent'],
    ['失败动作', action],
    ['安全错误码', errorCode],
    ...(planId ? [['查询计划', planId]] : []),
    ...(queryId ? [['Query ID', queryId]] : []),
  ];
  return {
    markdown: [
      '# 查询结果处理失败',
      '',
      '数据查询已经完成，但内网结果模型未能生成用户要求的最终输出，因此本次没有展示查询数据。',
      '',
      '| 项目 | 内容 |',
      '| --- | --- |',
      ...details.map(([label, value]) => `| ${markdownCell(label)} | ${markdownCell(value)} |`),
      '',
      '请模型网关/结果代理维护方按安全错误码和查询标识排查；确认模型服务恢复后，再由真人请求重新生成计划。',
    ].join('\n'),
    files: [],
  };
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
    result_context: result.result_context,
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

function fixedFollowupResult(code) {
  return {
    status: code,
    error_code: code,
    message: code,
  };
}

async function deliverQueryResult(caller, args, runtimeConfig) {
  const deliveryStartedAt = Date.now();
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
  const result = await callDataMcpService('run', caller, args, runtimeConfig);
  if (result?.status !== 'success') {
    const failure = deterministicDlcFailure(result, args);
    if (!failure) return { error: isolatedDeliveryFailure() };
    return {
      delivery: {
        schemaVersion: 1,
        deliveryId: `data-result-error-${randomUUID()}`,
        markdown: failure.markdown,
        responseKind: 'final',
      },
    };
  }
  let authored;
  try {
    authored = await runResultAgent(
      result,
      args,
      runtimeConfig,
      DELIVERY_BUDGET_MS - (Date.now() - deliveryStartedAt),
    );
    if (store && identity) {
      try {
        store.audit(
          identity,
          caller.turnId || 'initial',
          args.question || '',
          null,
          'result_agent_succeeded',
          Date.now(),
          resultAgentAuditDetail(authored.audit, result),
        );
      } catch { /* best-effort non-sensitive audit */ }
    }
    delete authored.audit;
  } catch (error) {
    const errorCode = resultAgentAuditStatus(error);
    if (store && identity) {
      try {
        store.audit(
          identity,
          caller.turnId || 'initial',
          args.question || '',
          null,
          errorCode,
          Date.now(),
          {
            ...resultAgentAuditDetail(error?.resultAgentAudit, result),
            action: resultAgentAuditAction(errorCode),
            errorCode,
          },
        );
      } catch { /* best-effort non-sensitive audit */ }
    }
    authored = deterministicResultAgentFailure(result, args, errorCode);
  }
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
      markdown: authored.markdown,
      ...(authored.files.length ? { files: authored.files } : {}),
      responseKind: 'final',
    },
  };
}

async function continueQueryResult(caller, args, runtimeConfig) {
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
  try {
    if (!payload.result) throw new Error('followup_result_unavailable');
    const authored = await runResultAgent(payload.result, {
      ...args,
      question,
    }, runtimeConfig);
    store.audit(
      identity,
      caller.turnId,
      question,
      expectedVersion,
      'result_agent_succeeded',
      Date.now(),
      resultAgentAuditDetail(authored.audit, payload.result),
    );
    delete authored.audit;
    store.assertVersion(identity, expectedVersion);
    store.touch(identity, expectedVersion);
    store.audit(identity, caller.turnId, question, expectedVersion, 'delivery_requested');
    return {
      delivery: {
        schemaVersion: 1,
        deliveryId: `data-followup-${randomUUID()}`,
        markdown: authored.markdown,
        ...(authored.files.length ? { files: authored.files } : {}),
        responseKind: 'final',
      },
    };
  } catch (error) {
    const errorCode = resultAgentAuditStatus(error);
    store.audit(identity, caller.turnId, question, expectedVersion, 'delivery_failed', Date.now(), {
      ...resultAgentAuditDetail(error?.resultAgentAudit, payload.result),
      action: resultAgentAuditAction(errorCode),
      errorCode,
    });
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

function directReplyFailure(error) {
  const code = error instanceof DirectReplyError ? error.code : 'direct_reply_failed';
  const receipt = error instanceof DirectReplyError ? error.receipt : {};
  return {
    status: 'error',
    error_code: code,
    message: code,
    delivered: false,
    textBytes: Number.isSafeInteger(receipt.textBytes) ? receipt.textBytes : 0,
    attachmentCount: Number.isSafeInteger(receipt.attachmentCount) ? receipt.attachmentCount : 0,
    truncated: receipt.truncated === true,
  };
}

async function sendPreparedDirectReply(caller, prepared) {
  if (prepared.error) return prepared.error;
  const paths = Array.isArray(prepared.delivery?.files)
    ? prepared.delivery.files.map(file => file?.path).filter(Boolean)
    : [];
  try {
    const receipt = await deliverDirectLarkReply(
      caller,
      prepared.delivery,
      nonBlankProcessEnv('BOTMUX_PLUGIN_HOME'),
    );
    return { status: 'delivered', ...receipt };
  } catch (error) {
    return directReplyFailure(error);
  } finally {
    for (const path of paths) discardStagedOutboundArtifact(path);
  }
}

async function callDataMcpService(kind, caller, args, runtimeConfig) {
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
    return callSnapshotService(kind, caller, payload, runtimeConfig);
  }

  if (kind === 'searchDlcTables') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = args.limit === undefined ? 5 : args.limit;
    if (!query || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      return {
        status: 'validation_error',
        result_class: 'policy_error',
        error_code: 'dlc_table_search_input_invalid',
        message: 'DLC 表检索 query 不能为空且不超过 500 字符，limit 必须为 1 到 20 的整数',
      };
    }
    return callSnapshotService(kind, caller, {
      ...trustedCallerPayload(caller), query, limit,
    }, runtimeConfig);
  }

  if (kind === 'refreshSnapshot') {
    const payload = trustedCallerPayload(caller);
    return callSnapshotService(kind, caller, payload, runtimeConfig);
  }

  if (kind === 'defaultRoleBaseline') {
    return callSnapshotService(kind, caller, trustedCallerPayload(caller), runtimeConfig);
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
    }, runtimeConfig);
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
    }, runtimeConfig);
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

  const enabledDatasources = enabledDatasourceIds();
  const datasource = typeof args.datasource === 'string' && args.datasource.trim()
    ? args.datasource.trim()
    : 'tchouse-c';
  if (!enabledDatasources.includes(datasource)) {
    return {
      status: 'validation_error',
      result_class: 'policy_error',
      message: `当前公开查询入口未启用数据源：${datasource}`,
      issues: [{
        code: 'unsupported_datasource',
        severity: 'error',
        message: `validate/run/deliver 仅允许已配置数据源：${enabledDatasources.join(', ')}`,
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
        message: 'run 必须携带 validate_sql_for_user 返回的 query_plan_id',
        suggested_action: '先调用 validate_sql_for_user 获取 query_plan_id，再执行查询',
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
  let response;
  try {
    const explicit = explicitServiceEndpoint(kind, runtimeConfig);
    const socketPath = serviceSocketPath(runtimeConfig);
    response = explicit || !socketPath
      ? await postJsonOverUrl(explicit || serviceEndpoint(kind, runtimeConfig), payload, runtimeConfig)
      : await postJsonOverUnixSocket(socketPath, servicePath(kind), payload, runtimeConfig);
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
    caller_session_id: nonBlankProcessEnv('BOTMUX_SESSION_ID') ?? null,
    caller_task_id: caller.taskId ?? null,
    caller_turn_id: caller.turnId ?? null,
    caller_captured_at: caller.capturedAt ?? null,
  };
}

async function callSnapshotService(kind, caller, payload, runtimeConfig) {
  const isAudit = [
    'defaultRoleBaseline', 'subjectsByTable', 'resourcesBySubject',
  ].includes(kind);
  let response;
  try {
    // Metadata search is a shared signed catalog and must not follow the
    // caller's SQL execution profile. Audit/refresh endpoints still use the
    // caller-selected service boundary.
    const serviceConfig = kind === 'searchSnapshot' ? hostRuntimeConfig : runtimeConfig;
    const socketPath = serviceSocketPath(serviceConfig);
    response = socketPath
      ? await postJsonOverUnixSocket(socketPath, servicePath(kind), payload, serviceConfig)
      : await postJsonOverUrl(serviceEndpoint(kind, serviceConfig), payload, serviceConfig);
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

  let runtimeConfig;
  try {
    runtimeConfig = runtimeConfigForCaller(caller);
  } catch {
    ok(request.id, jsonTool({
      status: 'error',
      error_code: 'test_profile_config_invalid',
      message: 'test_profile_config_invalid',
    }));
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
    ok(request.id, jsonTool(await callDataMcpService('validate', caller, argsFrom(request), runtimeConfig)));
    return;
  }

  if (name === 'run_query_for_user' && dataMcpModelMode() === 'single') {
    ok(request.id, jsonTool(await callDataMcpService('run', caller, argsFrom(request), runtimeConfig)));
    return;
  }

  if (name === 'run_query_for_user') {
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
    if (dataMcpModelMode() !== 'dual') {
      error(request.id, -32602, `unknown_tool:${String(name)}`);
      return;
    }
    const policyIssue = callerPolicyIssue(caller);
    if (policyIssue) {
      ok(request.id, jsonTool(policyIssue));
      return;
    }
    let prepared;
    try {
      prepared = await deliverQueryResult(caller, argsFrom(request), runtimeConfig);
    } catch {
      prepared = { error: isolatedDeliveryFailure() };
    }
    ok(request.id, jsonTool(await sendPreparedDirectReply(caller, prepared)));
    return;
  }

  if (name === 'continue_query_result_for_user') {
    if (dataMcpModelMode() !== 'dual') {
      error(request.id, -32602, `unknown_tool:${String(name)}`);
      return;
    }
    const policyIssue = callerPolicyIssue(caller);
    if (policyIssue) {
      ok(request.id, jsonTool(policyIssue));
      return;
    }
    let prepared;
    try {
      prepared = await continueQueryResult(caller, argsFrom(request), runtimeConfig);
    } catch {
      prepared = { error: fixedFollowupResult('delivery_failed') };
    }
    ok(request.id, jsonTool(await sendPreparedDirectReply(caller, prepared)));
    return;
  }

  if (name === 'refresh_metadata_snapshot') {
    ok(request.id, jsonTool(await callDataMcpService('refreshSnapshot', caller, argsFrom(request), runtimeConfig)));
    return;
  }

  if (name === 'search_metadata_snapshot') {
    ok(request.id, jsonTool(await callDataMcpService('searchSnapshot', caller, argsFrom(request), runtimeConfig)));
    return;
  }

  if (name === 'search_dlc_tables_for_user') {
    ok(request.id, jsonTool(await callDataMcpService('searchDlcTables', caller, argsFrom(request), runtimeConfig)));
    return;
  }

  if (name === 'inspect_ck_subjects_by_table') {
    ok(request.id, jsonTool(await callDataMcpService('subjectsByTable', caller, argsFrom(request), runtimeConfig)));
    return;
  }

  if (name === 'inspect_ck_resources_by_subject') {
    ok(request.id, jsonTool(await callDataMcpService('resourcesBySubject', caller, argsFrom(request), runtimeConfig)));
    return;
  }

  if (name === 'audit_ck_default_role_baseline') {
    ok(request.id, jsonTool(await callDataMcpService('defaultRoleBaseline', caller, argsFrom(request), runtimeConfig)));
    return;
  }

  error(request.id, -32602, `unknown_tool:${String(name)}`);
}

function toolSchemas() {
  const datasourceIds = enabledDatasourceIds();
  const datasourceSchema = queryDatasourceSchema(datasourceIds);
  const tools = [
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
          datasource: datasourceSchema,
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
          datasource: datasourceSchema,
          query_plan_id: { type: 'string' },
        },
        required: ['sql', 'query_plan_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'deliver_query_result_for_user',
      description: 'Execute one approved query once, pass rows/schema/context to the internal result Agent, and deliver the Agent-authored response and requested artifacts directly to the original trusted Feishu conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          datasource: datasourceSchema,
          query_plan_id: { type: 'string' },
          question: { type: 'string', minLength: 1, maxLength: 4000 },
          requested_outputs: {
            type: 'array', minItems: 1, maxItems: 5, uniqueItems: true,
            items: { type: 'string', enum: ['analysis', 'excel', 'pdf', 'chart', 'document'] },
          },
          output_mode: {
            type: 'string',
            enum: ['analysis', 'excel', 'pdf', 'chart', 'document', 'feishu_doc'],
            description: 'Deprecated single-output compatibility field; prefer requested_outputs.',
          },
        },
        required: ['sql', 'query_plan_id', 'question'],
        additionalProperties: false,
      },
    },
    {
      name: 'continue_query_result_for_user',
      description: 'Continue from the caller-bound stored result through the internal result Agent without re-querying or exposing result data to the calling model.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 4000 },
          requested_outputs: {
            type: 'array', minItems: 1, maxItems: 5, uniqueItems: true,
            items: { type: 'string', enum: ['analysis', 'excel', 'pdf', 'chart', 'document'] },
          },
          output_mode: {
            type: 'string', enum: ['analysis', 'excel', 'pdf', 'chart', 'document', 'feishu_doc'],
            description: 'Deprecated single-output compatibility field; prefer requested_outputs.',
          },
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
      description: 'TChouse-C/ClickHouse discovery only: search the verified signed local metadata snapshot for candidate tables, fields, partitions, and metric definitions. Never call this tool for an explicit DLC request with a fully qualified table; use validate_sql_for_user with datasource=dlc so the service performs live DLC metadata and permission checks. Never falls back to online metadata.',
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
      name: 'search_dlc_tables_for_user',
      description: 'DLC-only live table discovery under the trusted caller identity. Call only when the current user request explicitly names DLC/WeData or is a clear continuation of an already confirmed DLC query. If the current request does not name a source, default to TChouse-C/ClickHouse and use search_metadata_snapshot instead; never infer DLC from an earlier query or test. For an explicit DLC request, call this before generating SQL when the user has not supplied a verified database.table, or after DLC validation reports a metadata lookup failure. Never invent or fuzzy-rewrite a table name: use only authoritative candidates returned here; when requires_confirmation=true, ask the user to choose before validating SQL.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string', minLength: 1, maxLength: 500,
            description: 'Business phrase, metric, or suspected DLC table name from the user request.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
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
  if (dataMcpModelMode() === 'single') {
    return tools.filter(tool => ![
      'deliver_query_result_for_user',
      'continue_query_result_for_user',
    ].includes(tool.name));
  }
  return tools;
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
