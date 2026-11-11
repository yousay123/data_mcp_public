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
const PROMPT_TEMPLATE_VERSION = 'result-agent-tool-contract-v1';

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
  return { endpoint, model, apiKey: runtimeConfig.value('DATA_MCP_RESULT_MODEL_API_KEY') };
}

async function postModel(config, payload, runtimeConfig, onTestExceptionUsed) {
  const startedAt = Date.now();
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_MODEL_PAYLOAD_BYTES) throw new Error('result_agent_payload_too_large');
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
    req.setTimeout(60_000, () => req.destroy(new Error('result_agent_timeout')));
    req.on('error', rejectPromise);
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

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
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

function executeChart(args, envelope, pluginHome) {
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
  const width = 960; const height = 540; const left = 90; const top = 55; const bottom = 85; const right = 35;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const chartScale = Math.max(...points.map(point => point.value.scale));
  const scaledValues = points.map(point => rescaleExact(point.value, chartScale, 'result_agent_invalid_chart_value'));
  const zero = 0n;
  const minimum = scaledValues.reduce((current, item) => item < current ? item : current, zero);
  const maximum = scaledValues.reduce((current, item) => item > current ? item : current, zero);
  const span = maximum - minimum || 1n;
  const ratio = item => Number(((item - minimum) * 1_000_000_000n) / span) / 1_000_000_000;
  const baselineY = top + plotHeight - ratio(zero) * plotHeight;
  const step = plotWidth / points.length;
  const title = '查询结果图表';
  const elements = [`<rect width="100%" height="100%" fill="#fff"/>`, `<text x="${width / 2}" y="30" text-anchor="middle" font-size="20" fill="#173d67">${xml(title)}</text>`, `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" stroke="#789"/>`, `<line x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}" stroke="#789"/>`];
  const coordinates = points.map((point, index) => ({
    ...point,
    x: left + step * (index + 0.5),
    y: top + plotHeight - ratio(scaledValues[index]) * plotHeight,
  }));
  if (args.type === 'bar') {
    for (const point of coordinates) elements.push(`<rect x="${point.x - Math.min(step * 0.32, 22)}" y="${Math.min(point.y, baselineY)}" width="${Math.min(step * 0.64, 44)}" height="${Math.max(Math.abs(baselineY - point.y), 1)}" fill="#4276b8"/>`);
  } else {
    elements.push(`<polyline fill="none" stroke="#4276b8" stroke-width="3" points="${coordinates.map(point => `${point.x},${point.y}`).join(' ')}"/>`);
    for (const point of coordinates) elements.push(`<circle cx="${point.x}" cy="${point.y}" r="4" fill="#4276b8"/>`);
  }
  for (const point of coordinates) elements.push(`<text x="${point.x}" y="${top + plotHeight + 20}" text-anchor="middle" font-size="10" fill="#496174">${xml(point.label.slice(0, 12))}</text>`);
  if (envelope.rows.length > points.length) elements.push(`<text x="${left}" y="${height - 20}" font-size="11" fill="#9a5a00">仅展示前 ${points.length} 个数据点，共 ${envelope.rows.length} 行。</text>`);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements.join('')}</svg>`);
  const filename = safeFilename('query-result-chart', 'svg');
  return { type: 'chart', filename, path: stageArtifact(pluginHome, filename, svg), bytes: svg.length };
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
  const rows = [
    ['数据源', String(context.datasource).toUpperCase()],
    ['数据表', context.tables.join('、')],
    ['统计口径', context.metric_expressions.join('、')],
  ];
  if (context.time_range_predicates.length) {
    rows.push(['时间范围', context.time_range_predicates.join(' AND ')]);
  }
  const otherFilters = context.filter_predicates.filter(
    predicate => !context.time_range_predicates.includes(predicate),
  );
  if (otherFilters.length) rows.push(['其他过滤', otherFilters.join(' AND ')]);
  if (context.grouping_columns.length) rows.push(['分组字段', context.grouping_columns.join('、')]);
  return [
    '## 查询口径',
    '',
    '| 口径项 | 内容 |',
    '| --- | --- |',
    ...rows.map(([label, value]) => `| ${label} | ${markdownTableCell(value)} |`),
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

function computedClaims(args, envelope) {
  const claims = Array.isArray(args.claims) ? args.claims : [];
  if (claims.length > 20) throw new Error('result_agent_invalid_claims');
  return claims.map(claim => {
    assertOnlyKeys(claim, new Set(['operation', 'column']));
    const operation = claim?.operation;
    if (!['count', 'sum', 'average', 'minimum', 'maximum'].includes(operation)) {
      throw new Error('result_agent_invalid_claim_operation');
    }
    if (operation === 'count') return `**返回记录数：${groupedNumber(envelope.rows.length)} 行**`;
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
    if (column.toLowerCase() === 'row_count') return `**数据量：${value} 行**`;
    const operationLabel = {
      sum: '合计', average: '平均值', minimum: '最小值', maximum: '最大值',
    }[operation];
    return `- **${column}（${operationLabel}）**：${value}`;
  });
}

function narrativeLines(args, envelope) {
  const lines = ['查询结果', '', '## 数据结论', ''];
  const claims = computedClaims(args, envelope);
  if (claims.length) lines.push(...claims, '');
  lines.push(...queryContextLines(envelope), '');
  return lines;
}

function executeAnalysis(args, envelope) {
  assertOnlyKeys(args, new Set(['claims']));
  if (!Array.isArray(args.claims) || !args.claims.length) throw new Error('result_agent_invalid_claims');
  const lines = narrativeLines(args, envelope);
  const notice = scopeNotice(envelope.manifest);
  if (notice) lines.push(`数据范围说明：${notice}`);
  return { type: 'analysis', markdown: `# ${lines.shift()}\n\n${lines.join('\n')}\n` };
}

function documentLines(args, envelope, maxRows) {
  const lines = narrativeLines(args, envelope);
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
    type: 'array', minItems: 1, maxItems: 20,
    description: 'Claims computed with arbitrary-precision decimal arithmetic from protected rows. No labels or prose are accepted.',
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
  return [
    { type: 'function', function: { name: 'create_analysis', description: 'Select only source-bound computed claims. The tool owns all rendered wording; no free text is accepted.', parameters: { type: 'object', additionalProperties: false, properties: { claims }, required: ['claims'] } } },
    { type: 'function', function: { name: 'create_excel', description: 'Create an Excel workbook from the exact protected query rows. Select sheets and columns; the tool owns names and cell data.', parameters: { type: 'object', additionalProperties: false, properties: { sheets: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, properties: { columns: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } }, required: ['columns'] } } }, required: ['sheets'] } } },
    { type: 'function', function: { name: 'create_chart', description: 'Create an SVG chart from exact source columns. The tool owns title, annotations, and filename; no free text is accepted.', parameters: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['bar', 'line'] }, label_column: { type: 'string' }, value_column: { type: 'string' }, max_points: { type: 'integer', minimum: 2, maximum: 200 } }, required: ['type', 'label_column', 'value_column'] } } },
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

function executeTool(call, envelope, pluginHome) {
  if (call.name === 'create_analysis') return executeAnalysis(call.args, envelope);
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

export async function runInternalResultAgent(options) {
  const outputs = normalizedOutputs(options.requestedOutputs);
  const envelope = resultEnvelope(options.result, options.result?.result_context);
  const config = modelConfig(options.runtimeConfig);
  const serialized = JSON.stringify({
    user_request: options.question,
    requested_outputs: outputs,
    result_manifest: envelope.manifest,
    rows: envelope.rows,
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
        '工具不接受标题、段落、标签、文件名等自由文本。你只能选择列、聚合、图表类型和版式；全部数据事实与展示文字由工具从 rows 计算或使用固定模板。',
        '必须保留口径、时间范围、单位、过滤条件、截断和质量提示；不得输出 SQL、身份、凭据或本机路径。',
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
      messages,
      tools,
      tool_choice: 'required',
    }, options.runtimeConfig, options.onTestExceptionUsed);
  } catch (error) {
    throw attachAudit(error, { ...baseAudit, ...(error?.modelTrace || {}) });
  }
  const first = modelResponse.message;
  let calls;
  try {
    calls = Array.isArray(first.tool_calls) ? first.tool_calls.map(parseToolCall) : [];
    if (!calls.length) throw new Error('result_agent_tool_call_required');
    if (calls.length > MAX_ARTIFACTS || calls.some(call => !outputs.includes(call.output))) {
      throw new Error('result_agent_unrequested_tool');
    }
    for (const output of outputs) {
      if (calls.filter(call => call.output === output).length !== 1) throw new Error('result_agent_tool_call_mismatch');
    }
  } catch (error) {
    throw attachAudit(error, { ...baseAudit, ...modelResponse.trace });
  }
  const artifacts = [];
  try {
    let analysis;
    for (const call of calls) {
      const artifact = executeTool(call, envelope, options.pluginHome);
      if (artifact.type === 'analysis') analysis = artifact;
      else artifacts.push(artifact);
    }
    const notice = scopeNotice(envelope.manifest);
    const markdown = analysis?.markdown || [
      `已按同一份受控查询结果生成 ${artifacts.length} 个产物。`,
      notice ? `数据范围说明：${notice}` : null,
    ].filter(Boolean).join('\n\n');
    return {
      markdown,
      files: artifacts.map(artifact => ({ path: artifact.path, filename: artifact.filename, type: artifact.type })),
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
    throw attachAudit(error, { ...baseAudit, ...modelResponse.trace });
  }
}
