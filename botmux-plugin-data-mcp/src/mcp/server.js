import { createInterface } from 'node:readline';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const DEFAULT_SERVICE_BASE_URL = 'http://127.0.0.1:8765';
const DEFAULT_SERVICE_SOCKET_PATH = join(homedir(), '.cache', 'ksher-agent-data-mcp', 'run', 'api.sock');
const INTERNAL_AUTH_HEADER = 'X-Internal-Auth';
const FROZEN_QUERY_CONTRACT_VERSION = 2;
const FROZEN_QUERY_MAX_ROWS = 50;
const FROZEN_QUERY_MAX_DATA_ROWS = 1000;
const FROZEN_QUERY_MAX_COLUMNS = 20;
const FROZEN_QUERY_MAX_CELL_CHARS = 1000;
const FROZEN_QUERY_MAX_DATA_CELL_CHARS = 10000;
const FROZEN_QUERY_MAX_COLUMN_KEY_CHARS = 128;
const FROZEN_QUERY_MAX_COLUMN_LABEL_CHARS = 256;
let hostEnvCache;
let packageVersionCache;

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

function nonBlankProcessEnv(name) {
  // Security boundary: query-plan context must come from the host-owned child
  // process environment. Do not replace this with configValue(), whose local
  // host-env-file fallback is valid for service config but not caller context.
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function frozenQueryError(code, message) {
  return { contractVersion: FROZEN_QUERY_CONTRACT_VERSION, status: 'error', errorCode: code, message };
}

function sqlLiteral(value, type) {
  if (type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error('argument_invalid_integer');
    return String(value);
  }
  if (type === 'enum' && typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('argument_invalid_enum');
    return String(value);
  }
  if (!['string', 'enum', 'date'].includes(type)) throw new Error('argument_type_unsupported');
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('argument_invalid_string');
  if (type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('argument_invalid_date');
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function renderFrozenQuery(args) {
  const payload = args.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload_invalid');
  const template = payload.sql;
  if (typeof template !== 'string' || !template.trim() || template.length > 200_000) throw new Error('payload_sql_required');
  const datasource = typeof payload.datasource === 'string' && payload.datasource.trim()
    ? payload.datasource.trim() : 'tchouse-c';
  if (datasource !== 'tchouse-c') throw new Error('unsupported_datasource');
  if (!Array.isArray(args.parameters) || args.parameters.length > 64
    || !args.values || typeof args.values !== 'object' || Array.isArray(args.values)) {
    throw new Error('arguments_invalid');
  }
  const encoded = new Map();
  for (const parameter of args.parameters) {
    if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) throw new Error('parameter_invalid');
    if (typeof parameter.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name)) throw new Error('parameter_name_invalid');
    if (encoded.has(parameter.name)) throw new Error('parameter_duplicate');
    if (!Object.hasOwn(args.values, parameter.name)) throw new Error('parameter_required');
    encoded.set(parameter.name, sqlLiteral(args.values[parameter.name], parameter.type));
  }
  for (const key of Object.keys(args.values)) if (!encoded.has(key)) throw new Error('argument_unknown');
  const referenced = new Set();
  const sql = template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, name) => {
    if (!encoded.has(name)) throw new Error('placeholder_unknown');
    referenced.add(name);
    return encoded.get(name);
  });
  if (/\{\{|\}\}/.test(sql)) throw new Error('placeholder_invalid');
  for (const name of encoded.keys()) if (!referenced.has(name)) throw new Error('parameter_unused');
  return { sql, datasource };
}

function safeDisplayText(value) {
  return String(value ?? '—')
    // Query values are display data, never markup. Replacing delimiters is
    // deliberately non-recursive and therefore cannot expose a new tag after
    // an earlier match is removed (for example nested `<a<at>t ...>` input).
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/[\t\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '�');
}

function frozenBusinessRows(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = Array.isArray(body.rows) ? body.rows : Array.isArray(body.data) ? body.data : null;
  if (!raw) return null;
  const sampledRows = raw.slice(0, FROZEN_QUERY_MAX_DATA_ROWS);
  if (sampledRows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return null;
  const rows = sampledRows.filter(row => Object.keys(row).length > 0);
  if (rows.some(row => Object.values(row).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)))) return null;
  const labels = new Map();
  if (Array.isArray(body.columns)) {
    for (const column of body.columns) {
      if (column && typeof column === 'object' && !Array.isArray(column) && typeof column.name === 'string') {
        labels.set(column.name, safeDisplayText(column.description || column.name));
      }
    }
  }
  const columns = [...new Set([...labels.keys(), ...rows.flatMap(row => Object.keys(row))])]
    .filter(key => key.length > 0 && key.length <= FROZEN_QUERY_MAX_COLUMN_KEY_CHARS)
    .slice(0, FROZEN_QUERY_MAX_COLUMNS).map(key => ({
      key,
      label: (labels.get(key) || safeDisplayText(key)).slice(0, FROZEN_QUERY_MAX_COLUMN_LABEL_CHARS),
    }));
  const totalRows = Number.isSafeInteger(body.row_count) && body.row_count >= raw.length ? body.row_count : raw.length;
  return { rows, columns, totalRows };
}

function buildFrozenQueryPresentation(body, output = {}) {
  const maxChars = Number.isSafeInteger(output.maxChars) ? Math.max(100, Math.min(100000, output.maxChars)) : 12000;
  const format = ['text', 'markdown', 'table', 'auto'].includes(output.format) ? output.format : 'auto';
  const prefix = typeof output.prefix === 'string' ? output.prefix.slice(0, maxChars) : '';
  const suffix = typeof output.suffix === 'string' ? output.suffix.slice(0, Math.max(0, maxChars - prefix.length)) : '';
  const business = frozenBusinessRows(body);
  let core = '查询已完成。';
  if (business) {
    if (business.rows.length === 0) core = '查询完成，未找到符合条件的数据。';
    else core = business.rows.slice(0, FROZEN_QUERY_MAX_ROWS)
      .map((row, index) => `${business.totalRows > 1 ? `${index + 1}. ` : ''}${business.columns.map(column => `${column.label}：${safeDisplayText(row[column.key])}`).join('；')}`)
      .join('\n');
  }
  const fallbackText = `${prefix}${core}${suffix}`.slice(0, maxChars);
  const useTable = business && business.rows.length > 0 && business.columns.length > 0
    && (format === 'table' || (format === 'auto' && (business.rows.length > 1 || business.columns.length > 1)));
  const blocks = [];
  if (useTable) {
    if (prefix) blocks.push({ type: 'markdown', markdown: prefix });
    const candidateRows = business.rows.slice(0, FROZEN_QUERY_MAX_ROWS).map(row => Object.fromEntries(
      business.columns.map(column => [column.key, safeDisplayText(row[column.key]).slice(0, FROZEN_QUERY_MAX_CELL_CHARS)]),
    ));
    const fixedChars = prefix.length + suffix.length
      + business.columns.reduce((sum, column) => sum + column.key.length + column.label.length, 0);
    let presentationChars = fixedChars;
    const rows = [];
    for (const row of candidateRows) {
      const rowChars = business.columns.reduce((sum, column) => sum + String(row[column.key] ?? '').length, 0);
      if (presentationChars + rowChars > maxChars) break;
      rows.push(row);
      presentationChars += rowChars;
    }
    if (rows.length > 0) {
      blocks.push({ type: 'table', columns: business.columns, rows, totalRows: business.totalRows, truncated: business.totalRows > rows.length });
    } else {
      blocks.push({ type: 'markdown', markdown: fallbackText });
    }
    if (suffix) blocks.push({ type: 'markdown', markdown: suffix });
  } else {
    // The channel-neutral contract has only markdown and table carriers.
    // BotMux chooses text message versus card from the command's output.format
    // and uses fallbackText for the former.
    blocks.push({ type: 'markdown', markdown: fallbackText });
  }
  return {
    contractVersion: FROZEN_QUERY_CONTRACT_VERSION,
    status: 'success',
    fallbackText,
    blocks,
    meta: {
      queryId: typeof body?.query_id === 'string' && body.query_id ? body.query_id : null,
      totalRows: business?.totalRows ?? null,
    },
    ...(business ? {
      data: {
        rows: business.rows.slice(0, FROZEN_QUERY_MAX_DATA_ROWS).map(row => Object.fromEntries(
          business.columns.map(column => {
            const value = row[column.key];
            return [column.key, typeof value === 'string'
              ? safeDisplayText(value).slice(0, FROZEN_QUERY_MAX_DATA_CELL_CHARS)
              : value ?? null];
          }),
        )),
        columns: business.columns,
        totalRows: business.totalRows,
      },
    } : {}),
  };
}

async function executeFrozenQuery(caller, args) {
  let rendered;
  try { rendered = renderFrozenQuery(args); }
  catch (error) { return frozenQueryError(error instanceof Error ? error.message : 'definition_invalid', '固化查询定义或参数不合法'); }
  const validate = await callDataMcpService('validate', caller, { sql: rendered.sql, datasource: rendered.datasource, execution_mode: 'single' });
  if (!validate || validate.status !== 'success' || typeof validate.query_plan_id !== 'string') {
    return frozenQueryError(validate?.error_code || 'query_validation_failed', validate?.message || '查询校验失败');
  }
  const run = await callDataMcpService('run', caller, { sql: rendered.sql, datasource: rendered.datasource, query_plan_id: validate.query_plan_id });
  if (!run || run.status === 'error' || run.status === 'validation_error') {
    return frozenQueryError(run?.error_code || 'query_execution_failed', run?.message || '查询执行失败');
  }
  return buildFrozenQueryPresentation(run, args.output);
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
  const token = configValue('DATA_MCP_INTERNAL_AUTH_TOKEN');
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
        'content-type': 'application/json',
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
  return kind === 'validate' ? redactSchemaDetailsForUntrustedCaller(body, caller) : body;
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
  return body;
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

  if (name === 'run_query_for_user') {
    ok(request.id, jsonTool(await callDataMcpService('run', caller, argsFrom(request))));
    return;
  }

  if (name === 'execute_frozen_query') {
    ok(request.id, jsonTool(await executeFrozenQuery(caller, argsFrom(request))));
    return;
  }

  if (name === 'export_query_to_excel_file') {
    ok(request.id, jsonTool(await callDataMcpService('export', caller, argsFrom(request))));
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
      name: 'execute_frozen_query',
      description: 'Render, validate and run an approved frozen read-only query, returning a channel-neutral presentation without SQL.',
      inputSchema: {
        type: 'object',
        properties: {
          payload: { type: 'object', additionalProperties: true },
          parameters: { type: 'array', items: { type: 'object', additionalProperties: true } },
          values: { type: 'object', additionalProperties: true },
          output: {
            type: 'object',
            properties: {
              format: { type: 'string', enum: ['text', 'markdown', 'table', 'auto'] },
              prefix: { type: 'string' },
              suffix: { type: 'string' },
              maxChars: { type: 'integer', minimum: 100, maximum: 100000 },
            },
            additionalProperties: false,
          },
        },
        required: ['payload', 'parameters', 'values'],
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
        },
        required: ['sql', 'query_plan_id'],
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
