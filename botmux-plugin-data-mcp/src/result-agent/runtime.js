import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, join, resolve } from 'node:path';
import { buildModelWorkbook } from './model-workbook.js';
import { pinnedModelLookup, resolvePrivateModelAddress } from '../mcp/private-network.js';

const OUTPUTS = new Set(['analysis', 'excel', 'pdf', 'chart', 'document']);
const TOOL_BY_OUTPUT = Object.freeze({
  analysis: 'create_analysis',
  excel: 'create_excel',
  pdf: 'create_pdf',
  chart: 'create_chart',
  document: 'create_document',
});
const OUTPUT_BY_TOOL = Object.freeze(Object.fromEntries(
  Object.entries(TOOL_BY_OUTPUT).map(([output, tool]) => [tool, output]),
));
const MAX_MODEL_PAYLOAD_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACTS = 6;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MODEL_MAX_ATTEMPTS = 2;
const DEFAULT_MODEL_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 140_000;
const PROMPT_TEMPLATE_VERSION = 'result-agent-tool-contract-v5';
const SUMMARY_UNAVAILABLE = '本次未生成可用的分析总结，请以结果明细为准。';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function attachAudit(error, audit) {
  const normalized = error instanceof Error ? error : new Error('result_agent_failed');
  normalized.resultAgentAudit = { ...audit, status: 'failed' };
  return normalized;
}

function modelConfig(runtimeConfig) {
  const endpointValue = runtimeConfig.value('DATA_MCP_RESULT_MODEL_ENDPOINT');
  const model = runtimeConfig.value('DATA_MCP_RESULT_MODEL');
  const allowedHosts = new Set((runtimeConfig.value('DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS') || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  if (!endpointValue || !model || allowedHosts.size === 0) throw new Error('result_agent_not_configured');
  const endpoint = new URL(endpointValue);
  if (!['http:', 'https:'].includes(endpoint.protocol)
    || endpoint.username || endpoint.password
    || !allowedHosts.has(endpoint.hostname.toLowerCase())) {
    throw new Error('result_agent_endpoint_not_allowed');
  }
  const boundedInteger = (name, fallback, minimum, maximum) => {
    const raw = runtimeConfig.value(name);
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error('result_agent_invalid_retry_config');
    }
    return parsed;
  };
  return {
    endpoint,
    model,
    apiKey: runtimeConfig.value('DATA_MCP_RESULT_MODEL_API_KEY'),
    maxAttempts: boundedInteger('DATA_MCP_RESULT_MODEL_MAX_ATTEMPTS', DEFAULT_MODEL_MAX_ATTEMPTS, 1, 4),
    retryBaseDelayMs: boundedInteger(
      'DATA_MCP_RESULT_MODEL_RETRY_BASE_DELAY_MS',
      DEFAULT_MODEL_RETRY_BASE_DELAY_MS,
      0,
      2_000,
    ),
    requestTimeoutMs: boundedInteger(
      'DATA_MCP_RESULT_MODEL_REQUEST_TIMEOUT_MS',
      DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
      1_000,
      300_000,
    ),
  };
}

function modelRequestRetryable(error) {
  if (error?.message === 'result_agent_timeout' || error?.message === 'result_agent_network_error') return true;
  const match = /^result_agent_http_([1-5][0-9]{2})$/.exec(error?.message || '');
  if (!match) return false;
  const status = Number(match[1]);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelay(milliseconds) {
  return milliseconds > 0
    ? new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
    : Promise.resolve();
}

async function postModelAttempt(config, body, runtimeConfig, onTestExceptionUsed) {
  const startedAt = Date.now();
  const pinned = await resolvePrivateModelAddress(config.endpoint.hostname, undefined, {
    testException: runtimeConfig.value('DATA_MCP_RESULT_MODEL_TEST_EXCEPTION'),
    onTestExceptionUsed,
  });
  const response = await new Promise((resolvePromise, rejectPromise) => {
    const transport = config.endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      lookup: pinnedModelLookup(pinned.address, pinned.family),
      ...(config.endpoint.protocol === 'https:' ? { servername: config.endpoint.hostname } : {}),
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolvePromise({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        requestId: res.headers['x-request-id'] || res.headers['request-id'],
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(config.requestTimeoutMs, () => req.destroy(new Error('result_agent_timeout')));
    req.on('error', error => {
      rejectPromise(error?.message === 'result_agent_timeout'
        ? error
        : new Error('result_agent_network_error'));
    });
    req.end(body);
  });
  const responseTrace = {
    requestId: typeof response.requestId === 'string' ? response.requestId : null,
    latencyMs: Date.now() - startedAt,
    httpStatus: response.status,
  };
  if (!response.ok) {
    const error = new Error(`result_agent_http_${response.status}`);
    error.modelTrace = responseTrace;
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(response.text); } catch {
    const error = new Error('result_agent_invalid_json');
    error.modelTrace = responseTrace;
    throw error;
  }
  const message = parsed?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') {
    const error = new Error('result_agent_invalid_response');
    error.modelTrace = responseTrace;
    throw error;
  }
  return {
    message,
    trace: {
      requestId: responseTrace.requestId || parsed?.id,
      responseModel: typeof parsed?.model === 'string' ? parsed.model : null,
      outputHash: sha256(stableJson(message)),
      latencyMs: responseTrace.latencyMs,
      httpStatus: responseTrace.httpStatus,
    },
  };
}

async function postModel(config, payload, runtimeConfig, onTestExceptionUsed) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_MODEL_PAYLOAD_BYTES) throw new Error('result_agent_payload_too_large');
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const response = await postModelAttempt(config, body, runtimeConfig, onTestExceptionUsed);
      return {
        ...response,
        trace: {
          ...response.trace,
          latencyMs: Date.now() - startedAt,
          modelAttemptCount: attempt,
          modelRetriesUsed: attempt - 1,
        },
      };
    } catch (error) {
      if (error instanceof Error) {
        error.modelTrace = {
          ...(error.modelTrace || {}),
          latencyMs: Date.now() - startedAt,
          modelAttemptCount: attempt,
          modelRetriesUsed: attempt - 1,
        };
      }
      if (!modelRequestRetryable(error) || attempt >= config.maxAttempts) throw error;
      await retryDelay(config.retryBaseDelayMs * (2 ** (attempt - 1)));
    }
  }
  throw new Error('result_agent_network_error');
}

function columnNames(result) {
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const names = columns.map(column => typeof column === 'string' ? column : column?.name)
    .filter(name => typeof name === 'string' && name.trim()).map(name => name.trim());
  if (names.length) return names;
  const first = Array.isArray(result.rows) ? result.rows[0] : undefined;
  return first && !Array.isArray(first) && typeof first === 'object' ? Object.keys(first) : [];
}

function normalizedRows(result, columns) {
  const rows = Array.isArray(result.rows) ? result.rows : Array.isArray(result.data) ? result.data : [];
  return rows.map(row => {
    if (Array.isArray(row)) return Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null]));
    if (row && typeof row === 'object') return Object.fromEntries(columns.map(column => [column, row[column] ?? null]));
    throw new Error('result_agent_invalid_rows');
  });
}

function resultEnvelope(result, resultContext) {
  const columns = columnNames(result);
  if (!columns.length) throw new Error('result_agent_schema_missing');
  const rows = normalizedRows(result, columns);
  const context = validateCanonicalContext(resultContext);
  return {
    manifest: {
      schema_version: 1,
      datasource: typeof result.datasource === 'string' ? result.datasource : 'tchouse-c',
      columns: (Array.isArray(result.columns) ? result.columns : columns).map(column => (
        typeof column === 'string' ? { name: column } : column
      )),
      row_count: Number.isSafeInteger(result.row_count) ? result.row_count : rows.length,
      rows_before_limit_at_least: Number.isSafeInteger(result.rows_before_limit_at_least)
        ? result.rows_before_limit_at_least : null,
      effective_limit: Number.isSafeInteger(result.effective_limit) ? result.effective_limit : null,
      truncated: result.truncated === true,
      truncation_uncertain: result.truncation_uncertain === true,
      user_limit_reached: result.user_limit_reached === true,
      user_limit_notice: typeof result.user_limit_notice === 'string' ? result.user_limit_notice : null,
      limit_notice: typeof result.limit_notice === 'string' ? result.limit_notice : null,
      limit_injected: result.limit_injected === true,
      limit_capped: result.limit_capped === true,
      quality_warnings: Array.isArray(result.quality_warnings) ? result.quality_warnings : [],
      context,
    },
    columns,
    rows,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateCanonicalContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('result_agent_context_missing');
  const integrity = value.integrity;
  const unsigned = { ...value };
  delete unsigned.integrity;
  const expected = createHash('sha256').update(stableJson(unsigned)).digest('hex');
  const stringArrays = ['tables', 'metric_columns', 'metric_expressions', 'filter_predicates', 'time_range_predicates', 'grouping_columns'];
  if (value.schema_version !== 1
    || value.provenance !== 'data_mcp_validated_query_plan'
    || typeof value.datasource !== 'string'
    || stringArrays.some(key => !Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string'))
    || !Array.isArray(value.returned_columns)
    || value.returned_columns.some(column => !column || typeof column.name !== 'string' || typeof column.type !== 'string')
    || value.unit?.status !== 'not_inferred_from_sql'
    || value.timezone?.status !== 'database_session_default'
    || integrity?.algorithm !== 'sha256'
    || integrity?.digest !== expected) {
    throw new Error('result_agent_context_invalid');
  }
  return value;
}

function boundedString(value, max, code, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : fallback;
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(code);
  }
  return text;
}

function selectedColumns(args, available, key = 'columns') {
  const values = Array.isArray(args[key]) ? args[key] : [];
  if (!values.length || values.length > 100 || values.some(value => typeof value !== 'string' || !available.includes(value))) {
    throw new Error('result_agent_invalid_column_selection');
  }
  return [...new Set(values)];
}

function assertOnlyKeys(value, allowed, code = 'result_agent_free_text_not_allowed') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error(code);
  }
}

function scopeNotice(manifest) {
  if (manifest.truncated || manifest.truncation_uncertain) {
    return manifest.user_limit_notice || manifest.limit_notice || '查询结果存在截断或截断状态不确定，产物不代表完整结果。';
  }
  if (manifest.user_limit_reached) return manifest.user_limit_notice || '查询使用了显式 LIMIT，产物仅代表限定范围。';
  return null;
}

function safeFilename(value, extension) {
  const leaf = basename(String(value || `query-result.${extension}`).replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, '_')
    .replace(/\.(xlsx|pdf|svg|md)$/i, '')
    .slice(0, 100)
    .replace(/^\.+/, '');
  return `${leaf || 'query-result'}.${extension}`;
}

function stageArtifact(pluginHome, filename, content) {
  if (!pluginHome || !Buffer.isBuffer(content) || content.length < 1 || content.length > MAX_ARTIFACT_BYTES) {
    throw new Error('result_agent_artifact_invalid');
  }
  const outbound = resolve(pluginHome, 'outbound');
  mkdirSync(outbound, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const target = join(outbound, `result-agent-${token}-${filename}`);
  const temporary = join(outbound, `.result-agent-${token}.partial`);
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, target);
    return target;
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function executeExcel(args, envelope, pluginHome) {
  assertOnlyKeys(args, new Set(['sheets']));
  if (envelope.rows.length > 9_999) throw new Error('result_agent_artifact_row_limit');
  const sheets = Array.isArray(args.sheets) ? args.sheets : [];
  if (!sheets.length || sheets.length > 4) throw new Error('result_agent_invalid_excel_plan');
  const spec = {
    sheets: sheets.map((sheet, index) => {
      assertOnlyKeys(sheet, new Set(['columns']));
      const columns = selectedColumns(sheet, envelope.columns);
      return {
        name: `数据${index + 1}`,
        rows: [columns, ...envelope.rows.map(row => columns.map(column => row[column]))],
      };
    }),
  };
  const filename = safeFilename('query-result', 'xlsx');
  const bytes = buildModelWorkbook(spec, scopeNotice(envelope.manifest));
  return { type: 'excel', filename, path: stageArtifact(pluginHome, filename, bytes), bytes: bytes.length };
}

function executeChart(args, envelope) {
  assertOnlyKeys(args, new Set(['type', 'label_column', 'value_column', 'max_points']));
  const label = boundedString(args.label_column, 200, 'result_agent_invalid_chart_plan');
  const value = boundedString(args.value_column, 200, 'result_agent_invalid_chart_plan');
  if (!envelope.columns.includes(label) || !envelope.columns.includes(value) || !['bar', 'line'].includes(args.type)) {
    throw new Error('result_agent_invalid_chart_plan');
  }
  const maxPoints = Number.isSafeInteger(args.max_points) ? args.max_points : 100;
  if (maxPoints < 2 || maxPoints > 200) throw new Error('result_agent_invalid_chart_plan');
  const points = envelope.rows.slice(0, maxPoints).map(row => ({
    label: String(row[label] ?? ''),
    value: parseDecimal(row[value], 'result_agent_invalid_chart_value'),
  })).filter(point => point.value !== null);
  if (points.length < 2) throw new Error('result_agent_invalid_chart_plan');
  const spec = {
    title: `${label} · ${value}`.slice(0, 100),
    data: { values: points.map(point => ({
      category: point.label,
      value: point.value.scale === 0 && Number.isSafeInteger(Number(point.value.coefficient))
        ? Number(point.value.coefficient)
        : formatDecimal(point.value.coefficient, point.value.scale, point.value.scale),
    })) },
    mark: args.type,
    encoding: {
      x: { field: 'category', type: 'ordinal', title: label },
      y: { field: 'value', type: 'quantitative', title: value },
    },
  };
  const notice = envelope.rows.length > points.length
    ? `\n\n图表仅展示前 ${points.length} 个有效数据点，共 ${envelope.rows.length} 行。` : '';
  return { type: 'chart', markdown: `\`\`\`vega-lite\n${JSON.stringify(spec)}\n\`\`\`${notice}` };
}

function powerOfTen(scale) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 100) throw new Error('result_agent_invalid_claim_value');
  return 10n ** BigInt(scale);
}

function parseDecimal(value, errorCode = 'result_agent_invalid_claim_value') {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error(errorCode);
    value = String(value);
  } else if (typeof value === 'bigint') {
    return { coefficient: value, scale: 0 };
  } else if (typeof value !== 'string') {
    throw new Error(errorCode);
  }
  const match = value.trim().match(/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new Error(errorCode);
  const fraction = match[3] || '';
  const exponent = Number.parseInt(match[4] || '0', 10);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error(errorCode);
  let coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= powerOfTen(-scale);
    scale = 0;
  }
  if (scale > 100) throw new Error(errorCode);
  return { coefficient, scale };
}

function rescaleExact(decimal, targetScale, errorCode = 'result_agent_invalid_claim_value') {
  if (decimal.scale === targetScale) return decimal.coefficient;
  if (decimal.scale < targetScale) return decimal.coefficient * powerOfTen(targetScale - decimal.scale);
  const divisor = powerOfTen(decimal.scale - targetScale);
  if (decimal.coefficient % divisor !== 0n) throw new Error(errorCode);
  return decimal.coefficient / divisor;
}

function declaredDecimalScale(column, envelope) {
  const descriptors = [
    envelope.manifest.columns.find(item => item?.name === column),
    envelope.manifest.context.returned_columns.find(item => item?.name === column),
  ];
  for (const descriptor of descriptors) {
    const type = typeof descriptor?.type === 'string' ? descriptor.type : '';
    const decimal = type.match(/\bDecimal\s*\(\s*\d+\s*,\s*(\d+)\s*\)/i);
    if (decimal) return Number.parseInt(decimal[1], 10);
    const sized = type.match(/\bDecimal(?:32|64|128|256)\s*\(\s*(\d+)\s*\)/i);
    if (sized) return Number.parseInt(sized[1], 10);
    if (/\b(?:U?Int(?:8|16|32|64|128|256)?)\b/i.test(type)) return 0;
  }
  return null;
}

function formatDecimal(coefficient, scale, minimumScale = scale) {
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale > 0) digits = digits.padStart(scale + 1, '0');
  let integer = scale > 0 ? digits.slice(0, -scale) : digits;
  let fraction = scale > 0 ? digits.slice(-scale) : '';
  while (fraction.length > minimumScale && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

function groupedNumber(value) {
  const text = String(value);
  const match = text.match(/^(-?)(\d+)(\.\d+)?$/);
  if (!match) return text;
  return `${match[1]}${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${match[3] || ''}`;
}

function markdownTableCell(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/g, ' ');
}

function queryContextLines(envelope) {
  const context = envelope.manifest.context;
  const parts = [`本次结果来自 ${String(context.datasource).toUpperCase()} 的 ${context.tables.join('、')}`];
  if (context.metric_expressions.length) parts.push(`统计口径为 ${context.metric_expressions.join('、')}`);
  if (context.time_range_predicates.length) parts.push(`时间范围按 ${context.time_range_predicates.join(' AND ')} 限定`);
  const otherFilters = context.filter_predicates.filter(
    predicate => !context.time_range_predicates.includes(predicate),
  );
  if (otherFilters.length) parts.push(`同时应用 ${otherFilters.join(' AND ')} 过滤`);
  if (context.grouping_columns.length) parts.push(`并按 ${context.grouping_columns.join('、')} 分组`);
  return [
    '## 数据口径',
    '',
    `${parts.map(markdownTableCell).join('，')}。`,
  ];
}

function roundedDivide(numerator, denominator) {
  if (denominator <= 0n) throw new Error('result_agent_invalid_claim_value');
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  return negative ? -quotient : quotient;
}

function computedClaimEvidence(args, envelope) {
  const claims = Array.isArray(args.claims) ? args.claims : [];
  if (claims.length > 20) throw new Error('result_agent_invalid_claims');
  return claims.map(claim => {
    assertOnlyKeys(claim, new Set(['operation', 'column']));
    const operation = claim?.operation;
    if (!['count', 'sum', 'average', 'minimum', 'maximum'].includes(operation)) {
      throw new Error('result_agent_invalid_claim_operation');
    }
    if (operation === 'count') {
      const value = groupedNumber(envelope.rows.length);
      return { value, display: `**返回记录数：${value} 行**` };
    }
    const column = boundedString(claim?.column, 200, 'result_agent_invalid_claim_column');
    if (!envelope.columns.includes(column)) throw new Error('result_agent_invalid_claim_column');
    const values = envelope.rows.map(row => parseDecimal(row[column])).filter(value => value !== null);
    if (!values.length) throw new Error('result_agent_invalid_claim_value');
    const inferredScale = Math.max(...values.map(value => value.scale));
    const scale = declaredDecimalScale(column, envelope) ?? inferredScale;
    if (!Number.isInteger(scale) || scale < 0 || scale > 100) throw new Error('result_agent_invalid_claim_value');
    const exact = values.map(value => rescaleExact(value, scale));
    let coefficient;
    let outputScale = scale;
    if (operation === 'sum' || operation === 'average') coefficient = exact.reduce((total, item) => total + item, 0n);
    if (operation === 'minimum') coefficient = exact.reduce((current, item) => item < current ? item : current);
    if (operation === 'maximum') coefficient = exact.reduce((current, item) => item > current ? item : current);
    if (operation === 'average') {
      outputScale = Math.min(100, Math.max(scale, 6));
      coefficient = roundedDivide(coefficient * powerOfTen(outputScale - scale), BigInt(exact.length));
    }
    const value = groupedNumber(formatDecimal(coefficient, outputScale, scale));
    if (column.toLowerCase() === 'row_count') return { value, display: `**数据量：${value} 行**` };
    const operationLabel = {
      sum: '合计', average: '平均值', minimum: '最小值', maximum: '最大值',
    }[operation];
    return { value, display: `- **${column}（${operationLabel}）**：${value}` };
  });
}

function computedClaims(args, envelope) {
  return computedClaimEvidence(args, envelope).map(item => item.display);
}

function numericEvidence(envelope) {
  const summaries = [];
  for (const column of envelope.columns) {
    try {
      const values = envelope.rows.map(row => parseDecimal(row[column]));
      if (!values.some(value => value !== null)) continue;
      const scale = Math.max(...values.filter(Boolean).map(value => value.scale));
      const exact = values.map(value => value === null ? null : rescaleExact(value, scale));
      const present = exact.filter(value => value !== null);
      const min = present.reduce((a, b) => a < b ? a : b);
      const max = present.reduce((a, b) => a > b ? a : b);
      const operations = ['sum', 'average', 'minimum', 'maximum'];
      const aggregate = Object.fromEntries(operations.map(operation => [operation,
        computedClaimEvidence({ claims: [{ operation, column }] }, envelope)[0].value,
      ]));
      const changes = { up: 0, down: 0, unchanged: 0, missing: 0 };
      for (let index = 1; index < exact.length; index += 1) {
        const a = exact[index - 1]; const b = exact[index];
        changes[a === null || b === null ? 'missing' : b > a ? 'up' : b < a ? 'down' : 'unchanged'] += 1;
      }
      summaries.push({ column, ...aggregate,
        minimum_row_indices: exact.flatMap((value, index) => value === min ? [index] : []),
        maximum_row_indices: exact.flatMap((value, index) => value === max ? [index] : []),
        adjacent_changes_in_result_order: changes,
      });
    } catch { /* Non-numeric columns have no numeric summary. */ }
  }
  return summaries;
}

function statisticEvidence(envelope) {
  const facts = [{ column: null, operation: 'returned_row_count', value: String(envelope.rows.length) }];
  for (const summary of numericEvidence(envelope)) {
    for (const operation of ['sum', 'average', 'minimum', 'maximum']) {
      facts.push({ column: summary.column, operation, value: summary[operation] });
    }
    for (const [direction, count] of Object.entries(summary.adjacent_changes_in_result_order)) {
      facts.push({ column: summary.column, operation: `adjacent_${direction}_count`, value: String(count) });
    }
  }
  return facts.map((fact, index) => ({ ...fact, reference: `{{stat_${index}}}`, display: `${fact.column || '结果'}（${fact.operation}）：${fact.value}` }));
}

function calculationOperand(value, envelope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('result_agent_invalid_calculation_operand');
  }
  assertOnlyKeys(value, new Set(['row_index', 'column']));
  if (!Number.isSafeInteger(value.row_index)
    || value.row_index < 0
    || value.row_index >= envelope.rows.length) {
    throw new Error('result_agent_invalid_calculation_operand');
  }
  const column = boundedString(value.column, 200, 'result_agent_invalid_calculation_operand');
  if (!envelope.columns.includes(column)) throw new Error('result_agent_invalid_calculation_operand');
  const decimal = parseDecimal(
    envelope.rows[value.row_index][column],
    'result_agent_invalid_calculation_value',
  );
  if (decimal === null) throw new Error('result_agent_invalid_calculation_value');
  return decimal;
}

function divideDecimals(numerator, denominator, outputScale, multiplier = 1n) {
  if (denominator.coefficient === 0n) throw new Error('result_agent_invalid_calculation_value');
  let scaledNumerator = numerator.coefficient
    * multiplier
    * powerOfTen(denominator.scale + outputScale);
  let scaledDenominator = denominator.coefficient * powerOfTen(numerator.scale);
  if (scaledDenominator < 0n) {
    scaledNumerator = -scaledNumerator;
    scaledDenominator = -scaledDenominator;
  }
  return roundedDivide(scaledNumerator, scaledDenominator);
}

function computedCalculationEvidence(args, envelope) {
  const calculations = Array.isArray(args.calculations) ? args.calculations : [];
  if (calculations.length > 20) throw new Error('result_agent_invalid_calculations');
  return calculations.map(calculation => {
    assertOnlyKeys(calculation, new Set(['operation', 'operands', 'label', 'precision']));
    const operation = calculation?.operation;
    if (!['add', 'subtract', 'multiply', 'divide', 'percent_change'].includes(operation)) {
      throw new Error('result_agent_invalid_calculation_operation');
    }
    if (!Array.isArray(calculation.operands) || calculation.operands.length !== 2) {
      throw new Error('result_agent_invalid_calculation_operand');
    }
    const [left, right] = calculation.operands.map(value => calculationOperand(value, envelope));
    const precision = calculation.precision === undefined ? 2 : calculation.precision;
    if (!Number.isSafeInteger(precision) || precision < 0 || precision > 12) {
      throw new Error('result_agent_invalid_calculation_precision');
    }
    let coefficient;
    let scale;
    let suffix = '';
    if (operation === 'add' || operation === 'subtract') {
      scale = Math.max(left.scale, right.scale);
      coefficient = operation === 'add'
        ? rescaleExact(left, scale, 'result_agent_invalid_calculation_value')
          + rescaleExact(right, scale, 'result_agent_invalid_calculation_value')
        : rescaleExact(left, scale, 'result_agent_invalid_calculation_value')
          - rescaleExact(right, scale, 'result_agent_invalid_calculation_value');
    } else if (operation === 'multiply') {
      scale = left.scale + right.scale;
      if (scale > 100) throw new Error('result_agent_invalid_calculation_value');
      coefficient = left.coefficient * right.coefficient;
    } else {
      scale = precision;
      const numerator = operation === 'percent_change'
        ? {
            coefficient: rescaleExact(right, Math.max(left.scale, right.scale))
              - rescaleExact(left, Math.max(left.scale, right.scale)),
            scale: Math.max(left.scale, right.scale),
          }
        : left;
      coefficient = divideDecimals(
        numerator,
        operation === 'percent_change' ? left : right,
        scale,
        operation === 'percent_change' ? 100n : 1n,
      );
      if (operation === 'percent_change') suffix = '%';
    }
    const value = groupedNumber(formatDecimal(coefficient, scale, scale));
    const label = {
      add: '相加结果',
      subtract: '差值',
      multiply: '乘积',
      divide: '比值',
      percent_change: '变化率',
    }[operation];
    return { value, display: `- **${markdownTableCell(label)}**：${value}${suffix}` };
  });
}

function sourceFactEvidence(args, envelope) {
  const facts = Array.isArray(args.facts) ? args.facts : [];
  if (facts.length > 50) throw new Error('result_agent_invalid_facts');
  return facts.map(fact => {
    assertOnlyKeys(fact, new Set(['row_index', 'column', 'label']));
    if (!Number.isSafeInteger(fact?.row_index)
      || fact.row_index < 0
      || fact.row_index >= envelope.rows.length) {
      throw new Error('result_agent_invalid_fact_row');
    }
    const column = boundedString(fact?.column, 200, 'result_agent_invalid_fact_column');
    if (!envelope.columns.includes(column)) throw new Error('result_agent_invalid_fact_column');
    const label = column;
    const value = markdownTableCell(envelope.rows[fact.row_index][column] ?? '');
    return { value, display: `- **${markdownTableCell(label)}**：${value}` };
  });
}

function structuralEnumerationPrefix(line) {
  const digit = line.match(/^(\s*)(\p{N}{1,2})[.)、]\s+/u);
  if (digit) {
    const normalized = digit[2].normalize('NFKC');
    if (/^\d{1,2}$/u.test(normalized) && Number(normalized) >= 1 && Number(normalized) <= 20) {
      return digit[0];
    }
  }
  return line.match(/^(\s*)(?:一|二|三|四|五|六|七|八|九|十)[.)、]\s+/u)?.[0] || '';
}

function containsNumericLiteral(value) {
  const text = String(value || '');
  const normalized = text.normalize('NFKC');
  const digitPattern = /[+\-]?\p{N}[\p{N},]*(?:\.\p{N}+)?(?:[eE][+\-]?\p{N}+)?%?/u;
  const chineseNumeral = '零〇一二两三四五六七八九十百千万亿兆壹贰叁肆伍陆柒捌玖拾佰仟萬億';
  const chinesePattern = new RegExp([
    `第[${chineseNumeral}]+`,
    `[${chineseNumeral}]{2,}`,
    `[${chineseNumeral}](?:天|日|周|月|年|户|行|列|个|次|倍|元|万|萬|亿|億|兆)`,
    `(?:百分之|千分之|万分之|萬分之)[${chineseNumeral}]+`,
    `[${chineseNumeral}]+分之[${chineseNumeral}]+`,
    '(?:过半|過半|半数|半數|一半|大半|小半)',
    '(?:翻倍|双倍|雙倍|数倍|數倍|多倍)',
    '(?:数十|數十|数百|數百|数千|數千|数万|數萬|几十|幾十|上百|上千|上万|上萬)',
  ].join('|'), 'u');
  const englishPattern = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|percent|half|quarter|dozen)\b/iu;
  return digitPattern.test(text)
    || digitPattern.test(normalized)
    || chinesePattern.test(text)
    || chinesePattern.test(normalized)
    || englishPattern.test(text)
    || englishPattern.test(normalized);
}

function validateAuthoredNarrative(markdown, envelope, question) {
  const original = String(markdown);
  const normalized = original.normalize('NFKC');
  if (/<\/?(?:script|style|iframe)\b|javascript:|file:\/\/|https?:\/\//iu.test(normalized)) {
    throw new Error('result_agent_invalid_analysis_markdown');
  }
  const narrativeWithoutEvidence = value => value
    .replace(/\{\{(?:fact|claim|calc|stat)_\d+\}\}/gu, '')
    .split('\n')
    .map(line => line.slice(structuralEnumerationPrefix(line).length))
    .join('\n');
  if (containsNumericLiteral(narrativeWithoutEvidence(original))
    || containsNumericLiteral(narrativeWithoutEvidence(normalized))) {
    throw new Error('result_agent_ungrounded_analysis');
  }
}

function redactUngroundedNumbers(markdown, envelope, question, analysisArgs) {
  const original = boundedString(markdown, 8_000, 'result_agent_invalid_analysis_markdown');
  const normalized = original.normalize('NFKC');
  if (/<\/?(?:script|style|iframe)\b|javascript:|file:\/\/|https?:\/\//iu.test(normalized)) {
    throw new Error('result_agent_invalid_analysis_markdown');
  }
  const placeholders = [];
  const protectedMarkdown = original.replace(/\{\{(?:fact|claim|calc|stat)_\d+\}\}/gu, placeholder => {
    const marker = String.fromCodePoint(0xE000 + placeholders.length);
    placeholders.push(placeholder);
    return marker;
  });
  const redacted = protectedMarkdown.split('\n').map(line => {
    const enumeration = structuralEnumerationPrefix(line);
    const body = enumeration ? line.slice(enumeration.length) : line;
    return containsNumericLiteral(body) ? '' : `${enumeration}${body}`;
  }).join('\n').replace(/\n{3,}/gu, '\n\n');
  const restored = [...redacted].map(character => {
    const codePoint = character.codePointAt(0);
    return codePoint >= 0xE000 && codePoint < 0xE000 + placeholders.length
      ? placeholders[codePoint - 0xE000]
      : character;
  }).join('');
  const missingEvidence = [];
  for (let index = 0; index < (analysisArgs.facts?.length || 0); index += 1) {
    if (analysisArgs.table_columns?.includes(analysisArgs.facts[index]?.column)) continue;
    const placeholder = `{{fact_${index}}}`;
    if (!restored.includes(placeholder)) missingEvidence.push(placeholder);
  }
  for (const [kind, values] of [
    ['claim', analysisArgs.claims],
    ['calc', analysisArgs.calculations],
  ]) {
    for (let index = 0; index < (values?.length || 0); index += 1) {
      const placeholder = `{{${kind}_${index}}}`;
      if (!restored.includes(placeholder)) missingEvidence.push(placeholder);
    }
  }
  if (!missingEvidence.length) return restored.trim() || SUMMARY_UNAVAILABLE;
  return `${restored.trim()}\n\n${missingEvidence.join('\n\n')}`;
}

function markdownTableCells(line) {
  const trimmed = String(line).trim();
  if (!trimmed.includes('|')) return null;
  const body = trimmed.replace(/^\|/u, '').replace(/\|$/u, '');
  const cells = body.split('|').map(cell => cell.trim());
  return cells.length ? cells : null;
}

function stripModelAuthoredMarkdownTables(markdown) {
  const lines = String(markdown).split('\n');
  const retained = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = markdownTableCells(lines[index]);
    const separator = index + 1 < lines.length ? markdownTableCells(lines[index + 1]) : null;
    const isTable = header
      && separator
      && header.length === separator.length
      && separator.every(cell => /^:?-{3,}:?$/u.test(cell));
    if (!isTable) {
      retained.push(lines[index]);
      continue;
    }
    index += 1;
    while (index + 1 < lines.length) {
      const row = markdownTableCells(lines[index + 1]);
      if (!row || row.length !== header.length) break;
      index += 1;
    }
  }
  return retained.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function renderAuthoredAnalysis(args, envelope, question) {
  const authoredMarkdown = boundedString(args.analysis_markdown, 8_000, 'result_agent_invalid_analysis_markdown');
  const markdown = Array.isArray(args.table_columns) && args.table_columns.length
    ? stripModelAuthoredMarkdownTables(authoredMarkdown)
    : authoredMarkdown;
  validateAuthoredNarrative(markdown, envelope, question);
  const evidence = {
    fact: sourceFactEvidence(args, envelope),
    claim: computedClaimEvidence(args, envelope),
    calc: computedCalculationEvidence(args, envelope),
    stat: statisticEvidence(envelope),
  };
  let evidenceCount = 0;
  const rendered = markdown.split('\n').map(line => {
    const standalone = line.trim().match(/^\{\{(fact|claim|calc|stat)_(\d+)\}\}$/u);
    if (standalone) {
      const index = Number(standalone[2]);
      const item = evidence[standalone[1]][index];
      if (!Number.isSafeInteger(index) || index < 0 || !item) {
        throw new Error('result_agent_ungrounded_analysis');
      }
      evidenceCount += 1;
      return item.display;
    }
    const replaced = line.replace(/\{\{(fact|claim|calc|stat)_(\d+)\}\}/gu, (_placeholder, kind, rawIndex, offset) => {
      const index = Number(rawIndex);
      const item = evidence[kind][index];
      if (!Number.isSafeInteger(index) || index < 0 || !item) {
        throw new Error('result_agent_ungrounded_analysis');
      }
      if (kind === 'fact' && /^\d{4}-\d{2}-\d{2}(?:$|[ T])/u.test(item.value)
        && /^\s*(?:次|户|个|元|行|倍|%)/u.test(line.slice(offset + _placeholder.length))) {
        throw new Error('result_agent_invalid_fact_semantics');
      }
      evidenceCount += 1;
      return item.value;
    });
    if (replaced.includes('{{')) throw new Error('result_agent_ungrounded_analysis');
    return replaced;
  });
  if (evidenceCount === 0 && !(Array.isArray(args.table_columns) && args.table_columns.length)) {
    throw new Error('result_agent_evidence_required');
  }
  return rendered;
}

function detailTableLines(args, envelope, maxRows) {
  if (!Array.isArray(args.table_columns) || !args.table_columns.length) return [];
  const columns = selectedColumns(args, envelope.columns, 'table_columns');
  const lines = [
    '## 数据明细',
    '',
    `| ${columns.map(markdownTableCell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...envelope.rows.slice(0, maxRows).map(row => (
      `| ${columns.map(column => markdownTableCell(row[column] ?? '')).join(' | ')} |`
    )),
  ];
  if (envelope.rows.length > maxRows) lines.push('', `仅展示前 ${maxRows} 行，共 ${envelope.rows.length} 行。`);
  return [...lines, ''];
}

function conciseNarrative(lines) {
  const retained = [];
  let skipSection = false;
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/u);
    if (heading) {
      skipSection = /^(?:数据口径|统计口径|数据明细|按日明细|趋势图)$/u.test(heading[1].trim());
      continue;
    }
    if (!skipSection) retained.push(line);
  }
  const seen = new Set();
  return retained.join('\n').split(/\n\s*\n/u).map(part => part.trim()).filter(part => {
    if (!part || seen.has(part)) return false;
    seen.add(part);
    return true;
  }).join('\n\n');
}

function composeResultCard(analysis, artifacts, envelope) {
  const charts = artifacts.filter(artifact => artifact.type === 'chart').map(artifact => artifact.markdown);
  const summary = analysis?.summary;
  const context = [...queryContextLines(envelope)];
  const notice = scopeNotice(envelope.manifest);
  if (notice) context.push('', `数据范围说明：${notice}`);
  return [
    analysis?.details,
    ...charts,
    summary ? `## 分析总结\n\n${summary}` : null,
    !analysis && !charts.length ? '查询结果文件见附件。' : null,
    context.join('\n'),
  ].filter(Boolean).join('\n\n');
}

function executeAnalysis(args, envelope, question = '') {
  assertOnlyKeys(args, new Set([
    'analysis_markdown', 'facts', 'claims', 'calculations', 'table_columns', 'table_max_rows',
  ]));
  if (args.claims !== undefined && !Array.isArray(args.claims)) throw new Error('result_agent_invalid_claims');
  if (args.calculations !== undefined && !Array.isArray(args.calculations)) {
    throw new Error('result_agent_invalid_calculations');
  }
  const maxRows = Number.isSafeInteger(args.table_max_rows) ? args.table_max_rows : 50;
  if (maxRows < 1 || maxRows > 200) throw new Error('result_agent_invalid_analysis_table');
  const analysis = {
    type: 'analysis',
    summary: conciseNarrative(renderAuthoredAnalysis(args, envelope, question))
      || SUMMARY_UNAVAILABLE,
    details: detailTableLines(args, envelope, maxRows).join('\n').trim(),
  };
  return { ...analysis, markdown: composeResultCard(analysis, [], envelope) };
}

function documentLines(args, envelope, maxRows) {
  const lines = ['查询结果', '', ...computedClaims(args, envelope), '', ...queryContextLines(envelope), ''];
  if (Array.isArray(args.table_columns) && args.table_columns.length) {
    const columns = selectedColumns(args, envelope.columns, 'table_columns');
    lines.push(columns.join(' | '));
    lines.push(columns.map(() => '---').join(' | '));
    for (const row of envelope.rows.slice(0, maxRows)) lines.push(columns.map(column => String(row[column] ?? '')).join(' | '));
    if (envelope.rows.length > maxRows) lines.push(`仅展示前 ${maxRows} 行，共 ${envelope.rows.length} 行。`);
    lines.push('');
  }
  const notice = scopeNotice(envelope.manifest);
  if (notice) lines.push(`数据范围说明：${notice}`);
  return lines;
}

function executeDocument(args, envelope, pluginHome) {
  assertOnlyKeys(args, new Set(['claims', 'table_columns', 'table_max_rows']));
  const maxRows = Number.isSafeInteger(args.table_max_rows) ? args.table_max_rows : 50;
  if (maxRows < 1 || maxRows > 200) throw new Error('result_agent_invalid_document_plan');
  const lines = documentLines(args, envelope, maxRows);
  const markdown = Buffer.from(`# ${lines.shift()}\n\n${lines.map(line => line && !line.includes(' | ') && !line.startsWith('数据范围说明：') ? line : line).join('\n')}\n`);
  const filename = safeFilename('query-result', 'md');
  return { type: 'document', filename, path: stageArtifact(pluginHome, filename, markdown), bytes: markdown.length };
}

function utf16Hex(text) {
  const bytes = Buffer.alloc(2 + String(text).length * 2);
  bytes.writeUInt16BE(0xfeff, 0);
  for (let index = 0; index < String(text).length; index += 1) bytes.writeUInt16BE(String(text).charCodeAt(index), 2 + index * 2);
  return bytes.toString('hex').toUpperCase();
}

function simplePdf(lines) {
  const pages = [];
  for (let index = 0; index < lines.length; index += 42) pages.push(lines.slice(index, index + 42));
  const objects = [];
  const pageIds = pages.map((_, index) => 3 + index * 2);
  const fontId = 3 + pages.length * 2;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  pages.forEach((page, index) => {
    const pageId = pageIds[index]; const contentId = pageId + 1;
    const stream = `BT /F1 11 Tf 50 790 Td 17 TL ${page.map(line => `<${utf16Hex(line.slice(0, 90))}> Tj T*`).join(' ')} ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>] >>';
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(output);
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) output += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  output += `trailer << /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

function executePdf(args, envelope, pluginHome) {
  assertOnlyKeys(args, new Set(['claims', 'table_columns', 'table_max_rows']));
  const maxRows = Number.isSafeInteger(args.table_max_rows) ? args.table_max_rows : 30;
  if (maxRows < 1 || maxRows > 100) throw new Error('result_agent_invalid_document_plan');
  const bytes = simplePdf(documentLines(args, envelope, maxRows));
  const filename = safeFilename('query-result', 'pdf');
  return { type: 'pdf', filename, path: stageArtifact(pluginHome, filename, bytes), bytes: bytes.length };
}

function toolDefinitions() {
  const claims = {
    type: 'array', maxItems: 20,
    description: 'Optional numeric facts computed exactly by the host from protected rows.',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        operation: { type: 'string', enum: ['count', 'sum', 'average', 'minimum', 'maximum'] },
        column: { type: 'string' },
      },
      required: ['operation'],
    },
  };
  const documentProperties = {
    claims,
    table_columns: { type: 'array', maxItems: 100, items: { type: 'string' } },
    table_max_rows: { type: 'integer', minimum: 1, maximum: 200 },
  };
  const analysisProperties = {
    analysis_markdown: {
      type: 'string', minLength: 1, maxLength: 8000,
      description: 'Complete concise analysis, normally one or two sentences. No headings, tables, repeated scope, or repetition of every row. Bind source values with {{fact_0}}, aggregates with {{claim_0}}, arithmetic with {{calc_0}}, or references in computed_facts.',
    },
    facts: {
      type: 'array', maxItems: 50,
      description: 'Generic source facts. Works for strings, booleans, numbers, dates, account names, permissions, and any other returned field.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          row_index: { type: 'integer', minimum: 0 },
          column: { type: 'string' },
          label: { type: 'string', minLength: 1, maxLength: 80 },
        },
        required: ['row_index', 'column'],
      },
    },
    claims,
    calculations: {
      type: 'array', maxItems: 20,
      description: 'Generic exact arithmetic computed by the host. For percent_change, operands are [baseline, current] and the inline placeholder returns the numeric value without the percent sign.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide', 'percent_change'] },
          operands: {
            type: 'array', minItems: 2, maxItems: 2,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                row_index: { type: 'integer', minimum: 0 },
                column: { type: 'string' },
              },
              required: ['row_index', 'column'],
            },
          },
          label: { type: 'string', minLength: 1, maxLength: 80 },
          precision: { type: 'integer', minimum: 0, maximum: 12 },
        },
        required: ['operation', 'operands'],
      },
    },
    table_columns: { type: 'array', maxItems: 100, items: { type: 'string' } },
    table_max_rows: { type: 'integer', minimum: 1, maximum: 200 },
  };
  return [
    { type: 'function', function: { name: 'create_analysis', description: 'Write a question-specific analysis and choose generic source facts, exact aggregates, generic arithmetic, and optional detail columns. The model owns narrative and structure; the host binds or computes every exact value.', parameters: { type: 'object', additionalProperties: false, properties: analysisProperties, required: ['analysis_markdown'] } } },
    { type: 'function', function: { name: 'create_excel', description: 'Create an Excel workbook from the exact protected query rows. Select sheets and columns; the tool owns names and cell data.', parameters: { type: 'object', additionalProperties: false, properties: { sheets: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, properties: { columns: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } }, required: ['columns'] } } }, required: ['sheets'] } } },
    { type: 'function', function: { name: 'create_chart', description: 'Create a native inline chart in the same result card from exact source columns. The tool binds all data; this output is not a downloadable file.', parameters: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['bar', 'line'] }, label_column: { type: 'string' }, value_column: { type: 'string' }, max_points: { type: 'integer', minimum: 2, maximum: 200 } }, required: ['type', 'label_column', 'value_column'] } } },
    { type: 'function', function: { name: 'create_document', description: 'Select source-bound claims and table structure. The tool owns every rendered word and value; no free text is accepted.', parameters: { type: 'object', additionalProperties: false, properties: documentProperties } } },
    { type: 'function', function: { name: 'create_pdf', description: 'Select source-bound claims and table structure. The tool owns every rendered word and value; no free text is accepted.', parameters: { type: 'object', additionalProperties: false, properties: documentProperties } } },
  ];
}

function parseToolCall(call) {
  const name = call?.function?.name;
  if (!OUTPUT_BY_TOOL[name] || typeof call?.id !== 'string' || !call.id) throw new Error('result_agent_unknown_tool');
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('result_agent_invalid_tool_arguments'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('result_agent_invalid_tool_arguments');
  return { id: call.id, name, args, output: OUTPUT_BY_TOOL[name] };
}

function executeTool(call, envelope, pluginHome, question = '') {
  if (call.name === 'create_analysis') return executeAnalysis(call.args, envelope, question);
  if (call.name === 'create_excel') return executeExcel(call.args, envelope, pluginHome);
  if (call.name === 'create_chart') return executeChart(call.args, envelope, pluginHome);
  if (call.name === 'create_document') return executeDocument(call.args, envelope, pluginHome);
  if (call.name === 'create_pdf') return executePdf(call.args, envelope, pluginHome);
  throw new Error('result_agent_unknown_tool');
}

function normalizedOutputs(requestedOutputs) {
  const outputs = Array.isArray(requestedOutputs) ? [...new Set(requestedOutputs)] : [];
  if (!outputs.length || outputs.length > 5 || outputs.some(output => !OUTPUTS.has(output))) {
    throw new Error('result_agent_invalid_outputs');
  }
  return outputs;
}

function validatedToolCalls(message, outputs) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls.map(parseToolCall) : [];
  if (!calls.length) throw new Error('result_agent_tool_call_required');
  if (calls.length > MAX_ARTIFACTS || calls.some(call => !outputs.includes(call.output))) {
    throw new Error('result_agent_unrequested_tool');
  }
  for (const output of outputs) {
    if (calls.filter(call => call.output === output).length !== 1) {
      throw new Error('result_agent_tool_call_mismatch');
    }
  }
  return calls;
}

function repairableAnalysisError(error) {
  return typeof error?.message === 'string' && (
    error.message === 'result_agent_ungrounded_analysis'
    || error.message === 'result_agent_evidence_required'
    || error.message === 'result_agent_invalid_analysis_markdown'
    || error.message.startsWith('result_agent_invalid_fact_')
    || error.message.startsWith('result_agent_invalid_claim_')
    || error.message.startsWith('result_agent_invalid_calculation_')
  );
}

function combinedModelTrace(previous, next) {
  return {
    ...next,
    latencyMs: (previous.latencyMs || 0) + (next.latencyMs || 0),
    modelAttemptCount: (previous.modelAttemptCount || 0) + (next.modelAttemptCount || 0),
    modelRetriesUsed: (previous.modelRetriesUsed || 0) + (next.modelRetriesUsed || 0),
    modelRepairCount: (previous.modelRepairCount || 0) + 1,
  };
}

export async function runInternalResultAgent(options) {
  const outputs = normalizedOutputs(options.requestedOutputs);
  const envelope = resultEnvelope(options.result, options.result?.result_context);
  const config = modelConfig(options.runtimeConfig);
  const serialized = JSON.stringify({
    user_request: options.question,
    requested_outputs: outputs,
    result_manifest: envelope.manifest,
    rows: envelope.rows,
    computed_numeric_evidence: numericEvidence(envelope),
    computed_facts: statisticEvidence(envelope).map(({ display, ...fact }) => fact),
  });
  if (Buffer.byteLength(serialized) > MAX_MODEL_PAYLOAD_BYTES) throw new Error('result_agent_payload_too_large');
  const messages = [
    {
      role: 'system',
      content: [
        '你是企业内网中的数据结果 Agent。只依据 result_manifest 和 rows 工作，不补造数据。',
        '分析与文件产物都必须由你调用对应工具生成；Data MCP 不生成最终文件。',
        '只调用 requested_outputs 明确要求的工具，每种要求的输出类型恰好调用一次。',
        '工具中的列名必须来自 result_manifest.columns；表格、图表数据由工具从同一份 rows 读取，不要在参数里重写数据。',
        'create_analysis 的 Markdown 由你自由组织，不要套最大值、最小值、平均值等固定模板。围绕用户问题提炼现象、问题、风险或机会、业务影响和可执行建议。',
        '默认只写一至两句完整的分析总结：概括主要变化和需要关注的点，句子必须完整收尾。仅当用户明确要求详细/深入分析时才展开。不要写标题、重复明细、口径或“可信数据”等栏目；宿主会统一按明细、图表、分析总结、数据口径的顺序排版。',
        '默认简短总结可直接用自然语言概括变化，无需重复罗列日期和数值；如用户明确要求总数等指标，使用可信引用回答，不得遗漏。',
        '任何需要准确展示的原始字段值都通过 facts 选择，并在 Markdown 中引用从零开始编号的 {{fact_0}}、{{fact_1}}；facts 可以引用字符串、布尔值、数字、日期、账号和权限等任意返回字段。',
        '只有确有业务意义时才选择 claims 计算聚合，并引用从零开始编号的 {{claim_0}}、{{claim_1}}。不要为了满足格式机械增加聚合字段。列表或明细结果优先选择 table_columns。',
        '选择 table_columns 后，宿主会从可信 rows 统一渲染一次明细表；analysis_markdown 只写分析正文，不要再构造 Markdown 表格。',
        '差值、比值、变化率等派生数字使用 calculations，由宿主精确计算，并引用从零开始编号的 {{calc_0}}、{{calc_1}}；percent_change 的 operands 顺序是 [基准值, 当前值]，占位符只返回数值，正文需要自行补 %；不要在正文里自行填写派生数字。',
        '自由 Markdown 中不得直接写任何精确数字，即使数字来自 rows、用户问题或 context；原始值必须用 facts，聚合用 claims，跨行算术用 calculations。自然语言趋势、风险和建议可以自由表达。',
        '分析判断可以发散，但不得把推测写成已证实事实；可能原因应明确标注需要结合业务信息核查。',
        'computed_numeric_evidence 是工具精确计算的校对依据，不是固定输出模板。平均值使用对应列的 average claim，最低/最高值的日期从对应 row_indices 选择 fact；不要把 count 或其他列的值称为日均。趋势依据相邻变化核对，存在反弹不得说连续回落。结果行顺序不代表时间顺序时，不推断时间趋势。',
        'computed_facts 已提供带 reference 的可信统计值，可直接把 reference（如 {{stat_0}}）放入正文，无需另建 facts。相邻上升/下降次数只能引用 adjacent_up_count/adjacent_down_count 的 reference，不能引用日期或某日业务值。',
        '数据口径由宿主根据可信 context 生成自然段；不得输出 SQL、身份凭据或本机路径。',
      ].join('\n'),
    },
    { role: 'user', content: serialized },
  ];
  const tools = toolDefinitions();
  const baseAudit = {
    schemaVersion: 1,
    status: 'started',
    modelId: config.model,
    endpointHost: config.endpoint.hostname,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    promptTemplateHash: sha256(messages[0].content),
    inputHash: sha256(serialized),
    inputRowCount: envelope.rows.length,
  };
  let modelResponse;
  try {
    modelResponse = await postModel(config, {
      model: config.model,
      temperature: 0,
      max_tokens: 2048,
      chat_template_kwargs: { enable_thinking: false },
      messages,
      tools,
      tool_choice: 'required',
    }, options.runtimeConfig, options.onTestExceptionUsed);
  } catch (error) {
    throw attachAudit(error, { ...baseAudit, ...(error?.modelTrace || {}) });
  }
  for (let repairAttempt = 0; repairAttempt <= 2; repairAttempt += 1) {
    const artifacts = [];
    let calls;
    try {
      calls = validatedToolCalls(modelResponse.message, outputs);
      let analysis;
      for (const call of calls) {
        const artifact = executeTool(call, envelope, options.pluginHome, options.question);
        if (artifact.type === 'analysis') analysis = artifact;
        else artifacts.push(artifact);
      }
      return {
        markdown: composeResultCard(analysis, artifacts, envelope),
        files: artifacts.filter(artifact => artifact.path).map(artifact => ({ path: artifact.path, filename: artifact.filename, type: artifact.type })),
        artifactTypes: artifacts.map(artifact => artifact.type),
        manifest: envelope.manifest,
        audit: {
          ...baseAudit,
          ...modelResponse.trace,
          status: 'succeeded',
        },
      };
    } catch (error) {
      for (const artifact of artifacts) {
        try { unlinkSync(artifact.path); } catch { /* best effort */ }
      }
      const analysisCall = calls?.find(call => call.name === 'create_analysis');
      if (analysisCall
        && error.message === 'result_agent_ungrounded_analysis'
        && repairAttempt >= 2) {
        const sanitizedArtifacts = [];
        try {
          let analysis;
          for (const call of calls) {
            const safeCall = call.name === 'create_analysis'
              ? {
                  ...call,
                  args: {
                    ...call.args,
                    analysis_markdown: redactUngroundedNumbers(
                      call.args.analysis_markdown,
                      envelope,
                      options.question,
                      call.args,
                    ),
                  },
                }
              : call;
            const artifact = executeTool(safeCall, envelope, options.pluginHome, options.question);
            if (artifact.type === 'analysis') analysis = artifact;
            else sanitizedArtifacts.push(artifact);
          }
          return {
            markdown: composeResultCard(analysis, sanitizedArtifacts, envelope),
            files: sanitizedArtifacts.filter(artifact => artifact.path).map(artifact => ({
              path: artifact.path, filename: artifact.filename, type: artifact.type,
            })),
            artifactTypes: sanitizedArtifacts.map(artifact => artifact.type),
            manifest: envelope.manifest,
            audit: {
              ...baseAudit,
              ...modelResponse.trace,
              status: 'succeeded',
              analysisRedactionUsed: true,
            },
          };
        } catch (sanitizedError) {
          for (const artifact of sanitizedArtifacts) {
            try { unlinkSync(artifact.path); } catch { /* best effort */ }
          }
          throw attachAudit(sanitizedError, { ...baseAudit, ...modelResponse.trace });
        }
      }
      if (!analysisCall || !repairableAnalysisError(error) || repairAttempt >= 2) {
        throw attachAudit(error, { ...baseAudit, ...modelResponse.trace });
      }
      const repairMessages = [
        ...messages,
        {
          role: 'assistant',
          content: modelResponse.message.content ?? null,
          tool_calls: modelResponse.message.tool_calls,
        },
        {
          role: 'tool',
          tool_call_id: analysisCall.id,
          content: JSON.stringify({
            status: 'rejected',
            error_code: error.message,
            instruction: [
              '请重新调用所有 requested_outputs 对应工具。',
              '分析结构和建议可自由组织，但所有精确字段值必须通过从零开始编号的 {{fact_0}}、{{fact_1}} 引用 facts。',
              '聚合数字必须通过从零开始编号的 {{claim_0}}、{{claim_1}} 引用 claims；不要在自由 Markdown 中自行填写派生数字。',
              '差值、比值、变化率等跨行派生数字必须通过 {{calc_0}} 引用 calculations；percent_change 的 operands 顺序是 [基准值, 当前值]，并在占位符后补 %。',
              '占位符可以嵌入自然语言或表格单元格，但编号必须与 facts/claims/calculations 数组的零基位置一致。',
              '自由 Markdown 不得直接写任何精确数字；原始数字也必须用 fact，聚合交给 claim，跨行算术交给 calculation。',
              '纯文本或单行结果直接使用 facts，不要强行创建数值 claims。',
              'computed_facts 的 reference 可直接引用统计值，尤其上升/下降次数；不要用日期事实或原始行数值冒充变化次数。',
            ].join(''),
          }),
        },
      ];
      let repaired;
      try {
        repaired = await postModel(config, {
          model: config.model,
          temperature: 0,
          max_tokens: 2048,
          chat_template_kwargs: { enable_thinking: false },
          messages: repairMessages,
          tools,
          tool_choice: 'required',
        }, options.runtimeConfig, options.onTestExceptionUsed);
      } catch (repairError) {
        throw attachAudit(repairError, {
          ...baseAudit,
          ...combinedModelTrace(modelResponse.trace, repairError?.modelTrace || {}),
        });
      }
      repaired.trace = combinedModelTrace(modelResponse.trace, repaired.trace);
      modelResponse = repaired;
    }
  }
  throw attachAudit(new Error('result_agent_failed'), { ...baseAudit, ...modelResponse.trace });
}
