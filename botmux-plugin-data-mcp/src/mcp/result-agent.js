import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, join, resolve } from 'node:path';
import { buildModelWorkbook } from './model-workbook.js';
import { pinnedModelLookup, resolvePrivateModelAddress } from './private-network.js';

const FILE_OUTPUTS = new Set(['excel', 'pdf', 'chart', 'document']);
const TOOL_BY_OUTPUT = Object.freeze({
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
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(60_000, () => req.destroy(new Error('result_agent_timeout')));
    req.on('error', rejectPromise);
    req.end(body);
  });
  if (!response.ok) throw new Error(`result_agent_http_${response.status}`);
  let parsed;
  try { parsed = JSON.parse(response.text); } catch { throw new Error('result_agent_invalid_json'); }
  const message = parsed?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') throw new Error('result_agent_invalid_response');
  return message;
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
  const suppliedContext = resultContext && typeof resultContext === 'object' && !Array.isArray(resultContext)
    ? resultContext : {};
  const context = {
    metric: suppliedContext.metric ?? null,
    time_range: suppliedContext.time_range ?? null,
    filters: Array.isArray(suppliedContext.filters) ? suppliedContext.filters : [],
    grouping: suppliedContext.grouping ?? null,
    unit: suppliedContext.unit ?? null,
    timezone: suppliedContext.timezone ?? null,
    ...suppliedContext,
  };
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

function scopeNotice(manifest) {
  if (manifest.truncated || manifest.truncation_uncertain) return '查询结果存在截断或截断状态不确定，产物不代表完整结果。';
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
  if (envelope.rows.length > 9_999) throw new Error('result_agent_artifact_row_limit');
  const sheets = Array.isArray(args.sheets) ? args.sheets : [];
  if (!sheets.length || sheets.length > 4) throw new Error('result_agent_invalid_excel_plan');
  const spec = {
    sheets: sheets.map(sheet => {
      const columns = selectedColumns(sheet, envelope.columns);
      return {
        name: boundedString(sheet.name, 31, 'result_agent_invalid_sheet_name'),
        rows: [columns, ...envelope.rows.map(row => columns.map(column => row[column]))],
      };
    }),
  };
  const filename = safeFilename(args.filename, 'xlsx');
  const bytes = buildModelWorkbook(spec, scopeNotice(envelope.manifest));
  return { type: 'excel', filename, path: stageArtifact(pluginHome, filename, bytes), bytes: bytes.length };
}

function executeChart(args, envelope, pluginHome) {
  const label = boundedString(args.label_column, 200, 'result_agent_invalid_chart_plan');
  const value = boundedString(args.value_column, 200, 'result_agent_invalid_chart_plan');
  if (!envelope.columns.includes(label) || !envelope.columns.includes(value) || !['bar', 'line'].includes(args.type)) {
    throw new Error('result_agent_invalid_chart_plan');
  }
  const maxPoints = Number.isSafeInteger(args.max_points) ? args.max_points : 100;
  if (maxPoints < 2 || maxPoints > 200) throw new Error('result_agent_invalid_chart_plan');
  const points = envelope.rows.slice(0, maxPoints).map(row => {
    const number = Number(row[value]);
    if (!Number.isFinite(number)) throw new Error('result_agent_invalid_chart_value');
    return { label: String(row[label] ?? ''), value: number };
  });
  if (points.length < 2) throw new Error('result_agent_invalid_chart_plan');
  const width = 960; const height = 540; const left = 90; const top = 55; const bottom = 85; const right = 35;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const maximum = Math.max(...points.map(point => point.value), 0) || 1;
  const step = plotWidth / points.length;
  const title = boundedString(args.title, 160, 'result_agent_invalid_chart_title', '查询结果图表');
  const elements = [`<rect width="100%" height="100%" fill="#fff"/>`, `<text x="${width / 2}" y="30" text-anchor="middle" font-size="20" fill="#173d67">${xml(title)}</text>`, `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" stroke="#789"/>`, `<line x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}" stroke="#789"/>`];
  const coordinates = points.map((point, index) => ({
    ...point,
    x: left + step * (index + 0.5),
    y: top + plotHeight - (point.value / maximum) * plotHeight,
  }));
  if (args.type === 'bar') {
    for (const point of coordinates) elements.push(`<rect x="${point.x - Math.min(step * 0.32, 22)}" y="${point.y}" width="${Math.min(step * 0.64, 44)}" height="${top + plotHeight - point.y}" fill="#4276b8"/>`);
  } else {
    elements.push(`<polyline fill="none" stroke="#4276b8" stroke-width="3" points="${coordinates.map(point => `${point.x},${point.y}`).join(' ')}"/>`);
    for (const point of coordinates) elements.push(`<circle cx="${point.x}" cy="${point.y}" r="4" fill="#4276b8"/>`);
  }
  for (const point of coordinates) elements.push(`<text x="${point.x}" y="${top + plotHeight + 20}" text-anchor="middle" font-size="10" fill="#496174">${xml(point.label.slice(0, 12))}</text>`);
  if (envelope.rows.length > points.length) elements.push(`<text x="${left}" y="${height - 20}" font-size="11" fill="#9a5a00">仅展示前 ${points.length} 个数据点，共 ${envelope.rows.length} 行。</text>`);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements.join('')}</svg>`);
  const filename = safeFilename(args.filename, 'svg');
  return { type: 'chart', filename, path: stageArtifact(pluginHome, filename, svg), bytes: svg.length };
}

function documentLines(args, envelope, maxRows) {
  const title = boundedString(args.title, 160, 'result_agent_invalid_document_title', '查询结果报告');
  const sections = Array.isArray(args.sections) ? args.sections : [];
  if (!sections.length || sections.length > 12) throw new Error('result_agent_invalid_document_plan');
  const lines = [title, ''];
  for (const section of sections) {
    lines.push(boundedString(section.heading, 160, 'result_agent_invalid_document_heading'));
    const paragraphs = Array.isArray(section.paragraphs) ? section.paragraphs : [];
    if (paragraphs.length > 8) throw new Error('result_agent_invalid_document_plan');
    for (const paragraph of paragraphs) lines.push(boundedString(paragraph, 2500, 'result_agent_invalid_document_paragraph'));
    lines.push('');
  }
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
  const maxRows = Number.isSafeInteger(args.table_max_rows) ? args.table_max_rows : 50;
  if (maxRows < 1 || maxRows > 200) throw new Error('result_agent_invalid_document_plan');
  const lines = documentLines(args, envelope, maxRows);
  const markdown = Buffer.from(`# ${lines.shift()}\n\n${lines.map(line => line && !line.includes(' | ') && !line.startsWith('数据范围说明：') ? line : line).join('\n')}\n`);
  const filename = safeFilename(args.filename, 'md');
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
  const maxRows = Number.isSafeInteger(args.table_max_rows) ? args.table_max_rows : 30;
  if (maxRows < 1 || maxRows > 100) throw new Error('result_agent_invalid_document_plan');
  const bytes = simplePdf(documentLines(args, envelope, maxRows));
  const filename = safeFilename(args.filename, 'pdf');
  return { type: 'pdf', filename, path: stageArtifact(pluginHome, filename, bytes), bytes: bytes.length };
}

function toolDefinitions() {
  const documentProperties = {
    filename: { type: 'string', maxLength: 120 },
    title: { type: 'string', maxLength: 160 },
    sections: {
      type: 'array', minItems: 1, maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          heading: { type: 'string', maxLength: 160 },
          paragraphs: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 2500 } },
        },
        required: ['heading', 'paragraphs'],
      },
    },
    table_columns: { type: 'array', maxItems: 100, items: { type: 'string' } },
    table_max_rows: { type: 'integer', minimum: 1, maximum: 200 },
  };
  return [
    { type: 'function', function: { name: 'create_excel', description: 'Create an Excel workbook from the exact protected query rows. Select structure and columns; never supply cell data.', parameters: { type: 'object', additionalProperties: false, properties: { filename: { type: 'string', maxLength: 120 }, title: { type: 'string', maxLength: 160 }, sheets: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 31 }, columns: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } }, required: ['name', 'columns'] } } }, required: ['filename', 'sheets'] } } },
    { type: 'function', function: { name: 'create_chart', description: 'Create an SVG chart whose labels and values are read from exact source columns.', parameters: { type: 'object', additionalProperties: false, properties: { filename: { type: 'string', maxLength: 120 }, title: { type: 'string', maxLength: 160 }, type: { type: 'string', enum: ['bar', 'line'] }, label_column: { type: 'string' }, value_column: { type: 'string' }, max_points: { type: 'integer', minimum: 2, maximum: 200 } }, required: ['filename', 'title', 'type', 'label_column', 'value_column'] } } },
    { type: 'function', function: { name: 'create_document', description: 'Create a Markdown document authored by the result Agent; table values are bound to exact source columns.', parameters: { type: 'object', additionalProperties: false, properties: documentProperties, required: ['filename', 'title', 'sections'] } } },
    { type: 'function', function: { name: 'create_pdf', description: 'Create a PDF authored by the result Agent; table values are bound to exact source columns.', parameters: { type: 'object', additionalProperties: false, properties: documentProperties, required: ['filename', 'title', 'sections'] } } },
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
  if (call.name === 'create_excel') return executeExcel(call.args, envelope, pluginHome);
  if (call.name === 'create_chart') return executeChart(call.args, envelope, pluginHome);
  if (call.name === 'create_document') return executeDocument(call.args, envelope, pluginHome);
  if (call.name === 'create_pdf') return executePdf(call.args, envelope, pluginHome);
  throw new Error('result_agent_unknown_tool');
}

function normalizedOutputs(requestedOutputs) {
  const outputs = Array.isArray(requestedOutputs) ? [...new Set(requestedOutputs)] : [];
  if (!outputs.length || outputs.length > 5 || outputs.some(output => output !== 'analysis' && !FILE_OUTPUTS.has(output))) {
    throw new Error('result_agent_invalid_outputs');
  }
  return outputs;
}

export async function runInternalResultAgent(options) {
  const outputs = normalizedOutputs(options.requestedOutputs);
  const envelope = resultEnvelope(options.result, options.resultContext);
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
        '文件产物必须由你调用对应工具生成；Data MCP 不生成最终文件。',
        '只调用 requested_outputs 明确要求的文件工具，每种要求的文件类型恰好调用一次。',
        '工具中的列名必须来自 result_manifest.columns；表格、图表数据由工具从同一份 rows 读取，不要在参数里重写数据。',
        '必须保留口径、时间范围、单位、过滤条件、截断和质量提示；不得输出 SQL、身份、凭据或本机路径。',
      ].join('\n'),
    },
    { role: 'user', content: serialized },
  ];
  const first = await postModel(config, {
    model: config.model,
    temperature: 0,
    messages,
    tools: toolDefinitions(),
    tool_choice: outputs.some(output => FILE_OUTPUTS.has(output)) ? 'required' : 'auto',
  }, options.runtimeConfig, options.onTestExceptionUsed);
  const calls = Array.isArray(first.tool_calls) ? first.tool_calls.map(parseToolCall) : [];
  const requiredFiles = outputs.filter(output => FILE_OUTPUTS.has(output));
  if (requiredFiles.length && !calls.length) throw new Error('result_agent_tool_call_required');
  if (calls.length > MAX_ARTIFACTS || calls.some(call => !requiredFiles.includes(call.output))) {
    throw new Error('result_agent_unrequested_tool');
  }
  for (const output of requiredFiles) {
    if (calls.filter(call => call.output === output).length !== 1) throw new Error('result_agent_tool_call_mismatch');
  }
  const artifacts = [];
  try {
    for (const call of calls) artifacts.push(executeTool(call, envelope, options.pluginHome));
    if (!calls.length) {
      const markdown = typeof first.content === 'string' ? first.content.trim() : '';
      if (!markdown || markdown.length > 50_000) throw new Error('result_agent_invalid_content');
      return { markdown, files: [], artifactTypes: [], manifest: envelope.manifest };
    }
    const toolMessages = calls.map((call, index) => ({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify({
        status: 'created',
        artifact_type: artifacts[index].type,
        filename: artifacts[index].filename,
        bytes: artifacts[index].bytes,
      }),
    }));
    const final = await postModel(config, {
      model: config.model,
      temperature: 0,
      messages: [...messages, { role: 'assistant', content: first.content ?? null, tool_calls: first.tool_calls }, ...toolMessages],
      tools: toolDefinitions(),
      tool_choice: 'none',
    }, options.runtimeConfig, options.onTestExceptionUsed);
    if (Array.isArray(final.tool_calls) && final.tool_calls.length) throw new Error('result_agent_extra_tool_round');
    const markdown = typeof final.content === 'string' ? final.content.trim() : '';
    if (!markdown || markdown.length > 50_000) throw new Error('result_agent_invalid_content');
    return {
      markdown,
      files: artifacts.map(artifact => ({ path: artifact.path, filename: artifact.filename, type: artifact.type })),
      artifactTypes: artifacts.map(artifact => artifact.type),
      manifest: envelope.manifest,
    };
  } catch (error) {
    for (const artifact of artifacts) {
      try { unlinkSync(artifact.path); } catch { /* best effort */ }
    }
    throw error;
  }
}
