import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, join, resolve } from 'node:path';
import { buildModelWorkbook } from './model-workbook.js';
import { renderQueryContext } from './query-context.js';
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
const PROMPT_TEMPLATE_VERSION = 'result-agent-tool-contract-v7';

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
  const maxTokens = boundedInteger('DATA_MCP_RESULT_MODEL_MAX_TOKENS', 8192, 256, 32768);
  const tokenCap = boundedInteger('DATA_MCP_RESULT_MODEL_MAX_TOKENS_CAP', Math.max(maxTokens, 16384), maxTokens, 32768);
  const thinking = runtimeConfig.value('DATA_MCP_RESULT_MODEL_ENABLE_THINKING');
  if (thinking !== undefined && !['true', 'false', '1', '0'].includes(String(thinking).toLowerCase())) {
    throw new Error('result_agent_invalid_model_config');
  }
  const temperature = Number(runtimeConfig.value('DATA_MCP_RESULT_MODEL_TEMPERATURE') ?? 0);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('result_agent_invalid_model_config');
  return {
    endpoint,
    model,
    apiKey: runtimeConfig.value('DATA_MCP_RESULT_MODEL_API_KEY'),
    maxTokens, tokenCap, temperature,
    enableThinking: ['true', '1'].includes(String(thinking).toLowerCase()),
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
  const finishReason = parsed?.choices?.[0]?.finish_reason;
  const optionalInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const trace = {
    requestId: responseTrace.requestId || parsed?.id,
    responseModel: typeof parsed?.model === 'string' ? parsed.model : null,
    latencyMs: responseTrace.latencyMs, httpStatus: responseTrace.httpStatus,
    finishReason: typeof finishReason === 'string' ? finishReason : undefined,
    promptTokens: optionalInteger(parsed?.usage?.prompt_tokens),
    completionTokens: optionalInteger(parsed?.usage?.completion_tokens),
    reasoningTokens: optionalInteger(parsed?.usage?.completion_tokens_details?.reasoning_tokens),
  };
  if (finishReason === 'length') {
    const error = new Error('result_agent_output_truncated');
    error.modelTrace = trace;
    throw error;
  }
  if (!message || typeof message !== 'object') {
    const error = new Error('result_agent_invalid_response');
    error.modelTrace = responseTrace;
    throw error;
  }
  return {
    message,
    trace: {
      ...trace,
      outputHash: sha256(stableJson(message)),
    },
  };
}

async function postModel(config, payload, runtimeConfig, onTestExceptionUsed) {
  const startedAt = Date.now();
  const current = { ...payload };
  let attempts = 0; let retries = 0; let expansions = 0;
  const usage = {};
  const collect = trace => {
    for (const key of ['promptTokens', 'completionTokens', 'reasoningTokens']) {
      if (Number.isSafeInteger(trace?.[key])) usage[key] = (usage[key] || 0) + trace[key];
    }
  };
  const decorate = trace => ({
    ...trace, ...usage, latencyMs: Date.now() - startedAt,
    modelAttemptCount: attempts, modelRetriesUsed: retries, modelBudgetExpansions: expansions,
    modelMaxTokens: current.max_tokens, modelTokenCap: config.tokenCap,
    modelEnableThinking: config.enableThinking, modelTemperature: config.temperature,
  });
  for (;;) {
    const body = JSON.stringify(current);
    if (Buffer.byteLength(body) > MAX_MODEL_PAYLOAD_BYTES) throw new Error('result_agent_payload_too_large');
    attempts += 1;
    try {
      const response = await postModelAttempt(config, body, runtimeConfig, onTestExceptionUsed);
      collect(response.trace);
      return { ...response, trace: decorate(response.trace) };
    } catch (error) {
      collect(error?.modelTrace);
      if (error?.message === 'result_agent_output_truncated' && expansions === 0 && current.max_tokens < config.tokenCap) {
        expansions += 1;
        current.max_tokens = config.tokenCap;
        continue;
      }
      if (!modelRequestRetryable(error) || retries >= config.maxAttempts - 1) {
        if (error instanceof Error) error.modelTrace = decorate(error.modelTrace || {});
        throw error;
      }
      retries += 1;
      await retryDelay(config.retryBaseDelayMs * (2 ** (retries - 1)));
    }
  }
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
  assertOnlyKeys(args, new Set(['type', 'label_column', 'value_column', 'series_column', 'title', 'max_points']));
  const label = boundedString(args.label_column, 200, 'result_agent_invalid_chart_plan');
  const value = boundedString(args.value_column, 200, 'result_agent_invalid_chart_plan');
  if (!envelope.columns.includes(label) || !envelope.columns.includes(value)
    || !['bar', 'line', 'area', 'scatter', 'pie', 'donut'].includes(args.type)) {
    throw new Error('result_agent_invalid_chart_plan');
  }
  const maxPoints = Number.isSafeInteger(args.max_points) ? args.max_points : 100;
  if (maxPoints < 2 || maxPoints > 200) throw new Error('result_agent_invalid_chart_plan');
  if (args.series_column !== undefined && !envelope.columns.includes(args.series_column)) throw new Error('result_agent_invalid_chart_plan');
  if (['pie', 'donut'].includes(args.type) && args.series_column) throw new Error('result_agent_invalid_chart_plan');
  const scalar = decimal => decimal.scale === 0 && Number.isSafeInteger(Number(decimal.coefficient))
    ? Number(decimal.coefficient) : formatDecimal(decimal.coefficient, decimal.scale, decimal.scale);
  const points = envelope.rows.slice(0, maxPoints).map(row => ({
    label: args.type === 'scatter' ? parseDecimal(row[label], 'result_agent_invalid_chart_value') : String(row[label] ?? ''),
    value: parseDecimal(row[value], 'result_agent_invalid_chart_value'),
    ...(args.series_column ? { series: String(row[args.series_column] ?? '') } : {}),
  })).filter(point => point.value !== null && point.label !== null);
  if (points.length < 2) throw new Error('result_agent_invalid_chart_plan');
  if (['pie', 'donut'].includes(args.type)
    && (points.some(point => point.value.coefficient < 0n) || !points.some(point => point.value.coefficient > 0n))) {
    throw new Error('result_agent_invalid_chart_value');
  }
  const spec = {
    ...(args.title ? { title: boundedString(args.title, 100, 'result_agent_invalid_chart_plan') } : {}),
    data: { values: points.map(point => ({
      category: args.type === 'scatter' ? scalar(point.label) : point.label,
      value: scalar(point.value),
      ...(args.series_column ? { series: point.series } : {}),
    })) },
    mark: ({ scatter: 'point', pie: 'arc', donut: { type: 'arc', innerRadius: 0.5 } })[args.type] || args.type,
    encoding: ['pie', 'donut'].includes(args.type) ? {
      theta: { field: 'value', type: 'quantitative' }, color: { field: 'category', type: 'nominal', title: label },
    } : {
      x: { field: 'category', type: args.type === 'scatter' ? 'quantitative' : 'ordinal', title: label },
      y: { field: 'value', type: 'quantitative', title: value },
      ...(args.series_column ? { color: { field: 'series', type: 'nominal', title: args.series_column } } : {}),
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
    assertOnlyKeys(claim, new Set(['operation', 'column', 'row_indices']));
    let rows = envelope.rows;
    if (claim.row_indices !== undefined) {
      const indices = claim.row_indices;
      if (!Array.isArray(indices) || !indices.length || indices.length > envelope.rows.length
        || new Set(indices).size !== indices.length
        || indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= envelope.rows.length)) {
        throw new Error('result_agent_invalid_claim_rows');
      }
      rows = indices.map(index => envelope.rows[index]);
    }
    const operation = claim?.operation;
    if (!['count', 'sum', 'average', 'minimum', 'maximum'].includes(operation)) {
      throw new Error('result_agent_invalid_claim_operation');
    }
    if (operation === 'count') {
      const value = groupedNumber(rows.length);
      return { value, display: `**返回记录数：${value} 行**` };
    }
    const column = boundedString(claim?.column, 200, 'result_agent_invalid_claim_column');
    if (!envelope.columns.includes(column)) throw new Error('result_agent_invalid_claim_column');
    const values = rows.map(row => parseDecimal(row[column])).filter(value => value !== null);
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

function validateAuthoredNarrative(markdown) {
  const normalized = String(markdown).normalize('NFKC');
  if (/<\/?(?:script|style|iframe)\b|javascript:|file:\/\/|https?:\/\//iu.test(normalized)) {
    throw new Error('result_agent_invalid_analysis_markdown');
  }
}

function markdownTableCells(line) {
  const trimmed = String(line).trim();
  if (!trimmed.includes('|')) return null;
  const body = trimmed.replace(/^\|/u, '').replace(/\|$/u, '');
  const cells = body.split('|').map(cell => cell.trim());
  return cells.length ? cells : null;
}

function stripModelAuthoredMarkdownTables(markdown, onTable) {
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
      if (/^\|.*\|$/u.test(lines[index].trim())) { onTable?.(); continue; }
      retained.push(lines[index]);
      continue;
    }
    onTable?.();
    index += 1;
    while (index + 1 < lines.length) {
      const row = markdownTableCells(lines[index + 1]);
      if (!row || row.length !== header.length) break;
      index += 1;
    }
  }
  return retained.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function renderAuthoredAnalysis(args, envelope, question, maxChars = 8_000) {
  const authoredMarkdown = boundedString(args.analysis_markdown, maxChars, 'result_agent_invalid_analysis_markdown');
  const markdown = stripModelAuthoredMarkdownTables(authoredMarkdown);
  validateAuthoredNarrative(markdown);
  const evidence = {
    fact: sourceFactEvidence(args, envelope),
    claim: computedClaimEvidence(args, envelope),
    calc: computedCalculationEvidence(args, envelope),
    stat: statisticEvidence(envelope),
  };
  const rendered = markdown.split('\n').map(line => {
    const standalone = line.trim().match(/^\{\{(fact|claim|calc|stat)_(\d+)\}\}$/u);
    if (standalone) {
      const index = Number(standalone[2]);
      const item = evidence[standalone[1]][index];
      if (!Number.isSafeInteger(index) || index < 0 || !item) {
        throw new Error('result_agent_ungrounded_analysis');
      }
      return item.display;
    }
    const replaced = line.replace(/\{\{(fact|claim|calc|stat)_(\d+)\}\}/gu, (_placeholder, kind, rawIndex) => {
      const index = Number(rawIndex);
      const item = evidence[kind][index];
      if (!Number.isSafeInteger(index) || index < 0 || !item) {
        throw new Error('result_agent_ungrounded_analysis');
      }
      return item.value;
    });
    if (replaced.includes('{{')) throw new Error('result_agent_ungrounded_analysis');
    return replaced;
  });
  return rendered;
}

function detailTableLines(args, envelope, maxRows) {
  if (!Array.isArray(args.table_columns) || !args.table_columns.length) return [];
  const columns = selectedColumns(args, envelope.columns, 'table_columns');
  const formats = new Map();
  if (args.table_formats !== undefined) {
    if (!Array.isArray(args.table_formats) || args.table_formats.length > columns.length) {
      throw new Error('result_agent_invalid_analysis_table');
    }
    for (const format of args.table_formats) {
      assertOnlyKeys(format, new Set(['column', 'decimals', 'grouping']));
      if (!columns.includes(format.column) || formats.has(format.column)
        || !Number.isSafeInteger(format.decimals) || format.decimals < 0 || format.decimals > 12
        || (format.grouping !== undefined && typeof format.grouping !== 'boolean')) {
        throw new Error('result_agent_invalid_analysis_table');
      }
      formats.set(format.column, format);
    }
  }
  const cell = (row, column) => {
    const value = row[column];
    const format = formats.get(column);
    if (!format || value === null || value === undefined || value === '') return markdownTableCell(value ?? '');
    const decimal = parseDecimal(value, 'result_agent_invalid_analysis_table');
    if (decimal === null) return '';
    const coefficient = decimal.scale > format.decimals
      ? roundedDivide(decimal.coefficient, powerOfTen(decimal.scale - format.decimals))
      : decimal.coefficient * powerOfTen(format.decimals - decimal.scale);
    const display = formatDecimal(coefficient, format.decimals, format.decimals);
    return markdownTableCell(format.grouping ? groupedNumber(display) : display);
  };
  const lines = [
    '## 数据明细',
    '',
    `| ${columns.map(markdownTableCell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...envelope.rows.slice(0, maxRows).map(row => (
      `| ${columns.map(column => cell(row, column)).join(' | ')} |`
    )),
  ];
  if (envelope.rows.length > maxRows) lines.push('', `仅展示前 ${maxRows} 行，共 ${envelope.rows.length} 行。`);
  return [...lines, ''];
}

function conciseNarrative(lines) {
  const retained = [];
  let skipSection = false;
  let inlineScope = false;
  for (const line of lines) {
    // Model-authored scope can be a heading, a bold inline label, or plain
    // prose. The canonical context has one owner: the renderer below.
    if (/^\s*(?:[-*]\s+)?(?:\*\*)?(?:数据口径|统计口径|口径说明)(?:\*\*)?\s*[：:]/u.test(line)) {
      skipSection = true;
      inlineScope = true;
      continue;
    }
    if (inlineScope && !line.trim()) { skipSection = false; inlineScope = false; continue; }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/u);
    if (heading) {
      inlineScope = false;
      skipSection = /^(?:数据口径|统计口径|口径说明|数据明细|按日明细|趋势图)$/u.test(heading[1].trim());
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
  const context = [...renderQueryContext(envelope.manifest.context)];
  const notice = scopeNotice(envelope.manifest);
  if (notice) context.push('', `数据范围说明：${notice}`);
  return [
    analysis?.details,
    ...charts,
    summary || null,
    !analysis && !charts.length ? '查询结果文件见附件。' : null,
    context.join('\n'),
  ].filter(Boolean).join('\n\n');
}

function executeAnalysis(args, envelope, question = '') {
  assertOnlyKeys(args, new Set([
    'analysis_markdown', 'facts', 'claims', 'calculations', 'table_columns', 'table_max_rows', 'table_formats',
  ]));
  if (args.claims !== undefined && !Array.isArray(args.claims)) throw new Error('result_agent_invalid_claims');
  if (args.calculations !== undefined && !Array.isArray(args.calculations)) {
    throw new Error('result_agent_invalid_calculations');
  }
  const maxRows = Number.isSafeInteger(args.table_max_rows) ? args.table_max_rows : 50;
  if (maxRows < 1 || maxRows > 200) throw new Error('result_agent_invalid_analysis_table');
  let authoredTable = false;
  stripModelAuthoredMarkdownTables(args.analysis_markdown, () => { authoredTable = true; });
  const analysis = {
    type: 'analysis',
    summary: conciseNarrative(renderAuthoredAnalysis(args, envelope, question)),
    details: detailTableLines(
      !args.table_columns?.length && authoredTable
        ? { ...args, table_columns: envelope.columns } : args,
      envelope, maxRows,
    ).join('\n').trim(),
  };
  return { ...analysis, markdown: composeResultCard(analysis, [], envelope) };
}

function documentLines(args, envelope, maxRows) {
  const title = args.title ? boundedString(args.title, 120, 'result_agent_invalid_document_plan') : '查询结果';
  validateAuthoredNarrative(title);
  const content = args.content_markdown
    ? renderAuthoredAnalysis({ ...args, analysis_markdown: args.content_markdown }, envelope, '', 30_000)
    : computedClaims(args, envelope);
  const lines = [title, '', ...content, ''];
  let authoredTable = false;
  stripModelAuthoredMarkdownTables(args.content_markdown || '', () => { authoredTable = true; });
  const tableArgs = !args.table_columns?.length && authoredTable ? { ...args, table_columns: envelope.columns } : args;
  if (Array.isArray(tableArgs.table_columns) && tableArgs.table_columns.length) {
    lines.push(...detailTableLines(tableArgs, envelope, maxRows));
  }
  lines.push(...renderQueryContext(envelope.manifest.context));
  const notice = scopeNotice(envelope.manifest);
  if (notice) lines.push(`数据范围说明：${notice}`);
  return lines;
}

function executeDocument(args, envelope, pluginHome) {
  assertOnlyKeys(args, new Set(['title', 'content_markdown', 'facts', 'claims', 'calculations', 'table_columns', 'table_max_rows', 'table_formats']));
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
  const wrapped = lines.flatMap((line, index) => {
    const heading = index === 0 ? [line, '#', line] : line.match(/^(#{1,6})\s+(.+)$/u);
    const size = heading ? Math.max(12, 18 - heading[1].length * 2) : 11;
    const text = (heading ? heading[2] : line).replace(/\*\*/gu, '').replace(/`/gu, '');
    const output = []; let current = ''; let width = 0;
    const maxWidth = Math.floor(495 / size);
    for (const character of text) {
      const units = 1;
      if (width + units > maxWidth && current) { output.push({ text: current, size }); current = ''; width = 0; }
      current += character; width += units;
    }
    output.push({ text: current, size });
    return output;
  });
  const pages = [];
  for (let index = 0; index < wrapped.length; index += 42) pages.push(wrapped.slice(index, index + 42));
  const objects = [];
  const pageIds = pages.map((_, index) => 3 + index * 2);
  const fontId = 3 + pages.length * 2;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  pages.forEach((page, index) => {
    const pageId = pageIds[index]; const contentId = pageId + 1;
    const stream = `q 1 1 1 rg 0 0 595 842 re f Q BT 50 790 Td 17 TL ${page.map(line => `/F1 ${line.size} Tf <${utf16Hex(line.text)}> Tj T*`).join(' ')} ET`;
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
  assertOnlyKeys(args, new Set(['title', 'content_markdown', 'facts', 'claims', 'calculations', 'table_columns', 'table_max_rows', 'table_formats']));
  const maxRows = Number.isSafeInteger(args.table_max_rows) ? args.table_max_rows : 30;
  if (maxRows < 1 || maxRows > 100) throw new Error('result_agent_invalid_document_plan');
  const bytes = simplePdf(documentLines(args, envelope, maxRows));
  const filename = safeFilename('query-result', 'pdf');
  return { type: 'pdf', filename, path: stageArtifact(pluginHome, filename, bytes), bytes: bytes.length };
}

function toolDefinitions() {
  const claims = {
    type: 'array', maxItems: 20,
    description: 'Optional exact arithmetic over protected rows. Select row_indices when subtotals/totals coexist with details. Omitting indices includes every returned row; this is not automatically a business total.',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        operation: { type: 'string', enum: ['count', 'sum', 'average', 'minimum', 'maximum'] },
        column: { type: 'string' },
        row_indices: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 0 } },
      },
      required: ['operation'],
    },
  };
  const analysisProperties = {
    analysis_markdown: {
      type: 'string', minLength: 1, maxLength: 8000,
      description: 'Complete concise analysis, normally one or two sentences. No headings, tables, repeated scope, or repetition of every row. Numbers, calculations and estimates are allowed; distinguish observed facts from hypotheses. Fact/claim/calc/stat references are optional.',
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
    table_formats: { type: 'array', maxItems: 100, description: 'Display-only exact decimal rounding and thousands grouping for selected numeric columns. Follow the user request; never change source rows or format identifier/date columns as amounts.', items: { type: 'object', additionalProperties: false, properties: { column: { type: 'string' }, decimals: { type: 'integer', minimum: 0, maximum: 12 }, grouping: { type: 'boolean' } }, required: ['column', 'decimals'] } },
  };
  const documentProperties = {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    content_markdown: { type: 'string', minLength: 1, maxLength: 30000, description: 'Model-authored report with headings, findings, estimates and recommendations. Actual result tables are generated separately from table_columns.' },
    facts: analysisProperties.facts, claims, calculations: analysisProperties.calculations,
    table_columns: analysisProperties.table_columns, table_max_rows: analysisProperties.table_max_rows,
    table_formats: analysisProperties.table_formats,
  };
  return [
    { type: 'function', function: { name: 'create_analysis', description: 'Write a question-specific analysis and choose generic source facts, exact aggregates, generic arithmetic, and optional detail columns. The model owns narrative and structure; the host binds or computes every exact value.', parameters: { type: 'object', additionalProperties: false, properties: analysisProperties, required: ['analysis_markdown'] } } },
    { type: 'function', function: { name: 'create_excel', description: 'Create an Excel workbook from the exact protected query rows. Select sheets and columns; the tool owns names and cell data.', parameters: { type: 'object', additionalProperties: false, properties: { sheets: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, properties: { columns: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } }, required: ['columns'] } } }, required: ['sheets'] } } },
    { type: 'function', function: { name: 'create_chart', description: 'Choose a native chart type, axes and optional series/title. All plotted values are bound to source columns. Scatter needs numeric axes; pie/donut needs nonnegative values.', parameters: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['bar', 'line', 'area', 'scatter', 'pie', 'donut'] }, label_column: { type: 'string' }, value_column: { type: 'string' }, series_column: { type: 'string' }, title: { type: 'string', maxLength: 100 }, max_points: { type: 'integer', minimum: 2, maximum: 200 } }, required: ['type', 'label_column', 'value_column'] } } },
    { type: 'function', function: { name: 'create_document', description: 'Author a Markdown report freely using title and content_markdown. Choose source-bound table columns and optional exact references; the tool writes the file and exact row data.', parameters: { type: 'object', additionalProperties: false, properties: documentProperties } } },
    { type: 'function', function: { name: 'create_pdf', description: 'Author a paginated PDF report using title and content_markdown, with findings and recommendations. Original data tables come only from table_columns.', parameters: { type: 'object', additionalProperties: false, properties: documentProperties } } },
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

function validatedToolCalls(message, outputs, requireAll = true) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls.map(parseToolCall) : [];
  if (!calls.length) throw new Error('result_agent_tool_call_required');
  if (calls.length > MAX_ARTIFACTS || calls.some(call => !outputs.includes(call.output))) {
    throw new Error('result_agent_unrequested_tool');
  }
  for (const output of outputs) {
    const count = calls.filter(call => call.output === output).length;
    if (count > 1 || (requireAll && count !== 1)) {
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
    || error.message.startsWith('result_agent_invalid_chart_')
    || error.message === 'result_agent_invalid_document_plan'
    || error.message === 'result_agent_invalid_column_selection'
  );
}

function combinedModelTrace(previous, next, repair = true) {
  const usage = Object.fromEntries(['promptTokens', 'completionTokens', 'reasoningTokens'].flatMap(key => (
    Number.isSafeInteger(previous[key]) || Number.isSafeInteger(next[key])
      ? [[key, (previous[key] || 0) + (next[key] || 0)]] : []
  )));
  return {
    ...next, ...usage,
    latencyMs: (previous.latencyMs || 0) + (next.latencyMs || 0),
    modelAttemptCount: (previous.modelAttemptCount || 0) + (next.modelAttemptCount || 0),
    modelRetriesUsed: (previous.modelRetriesUsed || 0) + (next.modelRetriesUsed || 0),
    modelRepairCount: (previous.modelRepairCount || 0) + (repair ? 1 : 0),
    modelPlanningRounds: (previous.modelPlanningRounds || 0) + (next.modelPlanningRounds || 0),
    modelBudgetExpansions: (previous.modelBudgetExpansions || 0) + (next.modelBudgetExpansions || 0),
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
    computed_evidence_scope: 'all returned rows, including any subtotal/total rows; not a deduplicated business total',
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
        '分析正文允许直接书写数字、日期、计算结果和新的估算值，不强制占位符，不使用数字白名单。结合 rows 和 computed_numeric_evidence 自行核对事实；推算、预测、原因假设和建议须明确标注，不能冒充已查询到的事实。',
        'facts、claims、calculations 和 computed_facts 的 reference 均为可选能力；需要精确计算时可以使用，不要求为了格式机械调用。',
        '自动统计覆盖全部返回行，不能当作业务合计；明细与合计/小计混排时，请使用 claims.row_indices 明确选择同粒度明细行，或引用已有合计行，不重复累加。金额展示按用户要求设置 table_formats 的小数位和千分位，标识及日期列不要当作金额格式化。',
        '列表或明细结果请选择 table_columns；宿主只从原始 rows 渲染一次表格，analysis_markdown 不再重复明细表。',
        '分析内容和结论由你自由组织；不得修改明细、图表或文件中的原始数据，也不要新增用户未要求的文件或数据字段。',
        '图表可选折线、柱状、面积、散点、饼图、环图及适用的系列列；按数据特征和用户要求选择，不必每次使用折线图。',
        '文档和 PDF 由你自行撰写 title 和 content_markdown，可组织章节、推算与建议；表格使用 table_columns，由工具填入原始数据。',
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
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      chat_template_kwargs: { enable_thinking: config.enableThinking },
      messages,
      tools,
      tool_choice: 'required',
    }, options.runtimeConfig, options.onTestExceptionUsed);
  } catch (error) {
    throw attachAudit(error, { ...baseAudit, ...(error?.modelTrace || {}) });
  }
  const collectPlans = async (modelResponse, history = messages) => {
  // Models may plan requested outputs across several tool-call turns. Do not
  // execute any artifact plan until the whole requested set has been received.
  const plans = new Map();
  const planMessages = [...history];
  let planningRounds = 0;
  const initialPlanningRounds = modelResponse.trace.modelPlanningRounds || 0;
  for (;;) {
    const remaining = outputs.filter(output => !plans.has(output));
    let batch;
    try { batch = validatedToolCalls(modelResponse.message, remaining, false); }
    catch (error) { throw attachAudit(error, { ...baseAudit, ...modelResponse.trace }); }
    for (const call of batch) {
      const raw = modelResponse.message.tool_calls.find(item => item.id === call.id);
      plans.set(call.output, { ...raw, id: `plan_${plans.size}_${call.output}` });
    }
    if (plans.size === outputs.length) {
      modelResponse.message = { content: null, tool_calls: [...plans.values()] };
      modelResponse.trace.modelPlanningRounds = initialPlanningRounds + planningRounds;
      break;
    }
    if (planningRounds >= outputs.length - 1) throw attachAudit(new Error('result_agent_tool_call_mismatch'), { ...baseAudit, ...modelResponse.trace });
    const pending = outputs.filter(output => !plans.has(output));
    planMessages.push({ ...modelResponse.message, role: 'assistant' }, ...batch.map(call => ({
      role: 'tool', tool_call_id: call.id,
      content: JSON.stringify({ status: 'plan_received_not_executed', remaining_outputs: pending,
        instruction: '已收到此产物方案，尚未生成文件或投递。只调用剩余输出的工具，全部方案收齐后才统一执行。' }),
    })));
    let next;
    try {
      next = await postModel(config, { model: config.model, temperature: config.temperature,
        max_tokens: config.maxTokens, chat_template_kwargs: { enable_thinking: config.enableThinking },
        messages: planMessages, tools: tools.filter(tool => pending.includes(OUTPUT_BY_TOOL[tool.function.name])), tool_choice: 'required',
      }, options.runtimeConfig, options.onTestExceptionUsed);
    } catch (error) { throw attachAudit(error, { ...baseAudit, ...combinedModelTrace(modelResponse.trace, error?.modelTrace || {}, false) }); }
    next.trace = combinedModelTrace(modelResponse.trace, next.trace, false);
    modelResponse = next;
    planningRounds += 1;
  }
    return modelResponse;
  };
  modelResponse = await collectPlans(modelResponse);
  for (let repairAttempt = 0; repairAttempt <= 2; repairAttempt += 1) {
    const artifacts = [];
    let calls; let failedCall;
    try {
      calls = validatedToolCalls(modelResponse.message, outputs);
      let analysis;
      for (const call of calls) {
        failedCall = call;
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
      const repairCall = failedCall || calls?.find(call => call.name === 'create_analysis');
      if (!repairCall || !repairableAnalysisError(error) || repairAttempt >= 2) {
        throw attachAudit(error, { ...baseAudit, ...modelResponse.trace });
      }
      const repairMessages = [
        ...messages,
        {
          role: 'assistant',
          content: modelResponse.message.content ?? null,
          tool_calls: modelResponse.message.tool_calls,
        },
        ...calls.map(call => ({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            status: call.id === repairCall.id ? 'rejected' : 'rolled_back',
            error_code: call.id === repairCall.id ? error.message : undefined,
            instruction: [
              '请重新调用所有 requested_outputs 对应工具。',
              '请根据 error_code 修正工具参数或无效引用；数字和估算可以直接写在 analysis_markdown 中，不必改为占位符。',
              '如果选择了 fact/claim/calc/stat 引用，编号及对应的列、操作必须有效；也可直接用自然语言写分析。',
              '实际观察、推算和假设要区分，保持一至两句完整总结；深入分析仅在用户要求时展开。',
            ].join(''),
          }),
        })),
      ];
      let repaired;
      try {
        repaired = await postModel(config, {
          model: config.model,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          chat_template_kwargs: { enable_thinking: config.enableThinking },
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
      modelResponse = await collectPlans(repaired, repairMessages);
    }
  }
  throw attachAudit(new Error('result_agent_failed'), { ...baseAudit, ...modelResponse.trace });
}
