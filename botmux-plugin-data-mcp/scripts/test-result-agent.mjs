import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInternalResultAgent } from '../src/result-agent/runtime.js';
import { runIsolatedResultAgent } from '../src/mcp/result-agent-client.js';
import { canonicalContext } from './test-result-context-fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'data-mcp-result-agent-'));
const pluginHome = join(root, 'plugin-home');
let responseMode = 'tools';
let requests = [];
const analysisMarkdown = [
  '# 金额趋势概览',
  '',
  '近两日金额由 12.50 上升至 18.75，增加 6.25（50.00%）。',
  '',
  '## 关注点',
  '',
  '- 2026-03-02 为区间高点，2026-03-01 为区间低点。',
  '> 数值变化本身不能证明因果关系。',
].join('\n');

const toolCalls = [
  ['call_analysis', 'create_analysis', { claims: [
    { operation: 'sum', column: 'amount' },
    { operation: 'latest', column: 'amount', label_column: 'stat_date' },
    { operation: 'change', column: 'amount', label_column: 'stat_date' },
    { operation: 'minimum', column: 'amount', label_column: 'stat_date' },
    { operation: 'maximum', column: 'amount', label_column: 'stat_date' },
    { operation: 'largest_change', column: 'amount', label_column: 'stat_date' },
  ], analysis_markdown: analysisMarkdown, table_columns: ['stat_date', 'amount'], table_max_rows: 2 }],
  ['call_excel', 'create_excel', { sheets: [{ columns: ['stat_date', 'amount'] }] }],
  ['call_chart', 'create_chart', { type: 'line', label_column: 'stat_date', value_column: 'amount' }],
  ['call_pdf', 'create_pdf', { claims: [{ operation: 'sum', column: 'amount' }], table_columns: ['stat_date', 'amount'] }],
  ['call_doc', 'create_document', { claims: [{ operation: 'sum', column: 'amount' }], table_columns: ['stat_date', 'amount'] }],
].map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }));

const modelServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ payload, authorization: req.headers.authorization });
    const responseHeaders = { 'content-type': 'application/json', 'x-request-id': 'req_result_agent_fixture' };
    if (responseMode === 'always-503' || (responseMode === 'retry-503' && requests.length < 3)) {
      res.writeHead(503, responseHeaders);
      res.end(JSON.stringify({ error: { message: 'temporary unavailable' } }));
      return;
    }
    if (responseMode === 'unauthorized') {
      res.writeHead(401, responseHeaders);
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
      return;
    }
    res.writeHead(200, responseHeaders);
    if (payload.tool_choice === 'none') {
      res.end(JSON.stringify({ choices: [{ message: { content: '已按同一查询结果生成全部产物。' } }] }));
      return;
    }
    if (responseMode === 'none') {
      res.end(JSON.stringify({ choices: [{ message: { content: '没有调用工具。' } }] }));
      return;
    }
    if (responseMode === 'unrequested') {
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [toolCalls[2]] } }] }));
      return;
    }
    if (responseMode === 'excel-only') {
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [toolCalls[1]] } }] }));
      return;
    }
    if (responseMode === 'retry-503') {
      res.end(JSON.stringify({
        id: 'resp_result_agent_retry_fixture', model: 'internal-test-model-resolved',
        choices: [{ message: { content: null, tool_calls: [toolCalls[0]] } }],
      }));
      return;
    }
    if (responseMode === 'semantic-gap' || responseMode === 'semantic-gap-mixed') {
      const gap = {
        id: 'gap', type: 'function',
        function: { name: 'report_semantic_gap', arguments: JSON.stringify({ reason: 'missing_dimension' }) },
      };
      res.end(JSON.stringify({ choices: [{ message: {
        content: null,
        tool_calls: responseMode === 'semantic-gap-mixed' ? [gap, toolCalls[0]] : [gap],
      } }] }));
      return;
    }
    if (responseMode.startsWith('free-text-')) {
      const injection = {
        'free-text-chinese': { title: '总金额为九十九万' },
        'free-text-english': { sections: [{ heading: 'total', paragraphs: ['total is nine hundred thousand'] }] },
        'free-text-multiplier': { subtitle: '金额翻倍' },
        'free-text-chart': { title: '总金额 999999' },
      }[responseMode];
      const chart = responseMode === 'free-text-chart';
      const call = {
        id: 'call_bogus', type: 'function',
        function: {
          name: chart ? 'create_chart' : 'create_document',
          arguments: JSON.stringify({
            ...(chart ? { type: 'line', label_column: 'stat_date', value_column: 'amount' } : { table_columns: ['stat_date', 'amount'] }),
            ...injection,
          }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'precision') {
      const claims = ['sum', 'average', 'minimum', 'maximum'].map(operation => ({ operation, column: 'amount' }));
      const calls = [
        ['pa', 'create_analysis', { claims, analysis_markdown: '# 高精度汇总\n\n已按原始精度完成聚合。' }],
        ['pd', 'create_document', { claims, table_columns: ['stat_date', 'amount'] }],
        ['pp', 'create_pdf', { claims, table_columns: ['stat_date', 'amount'] }],
        ['pc', 'create_chart', { type: 'bar', label_column: 'stat_date', value_column: 'amount' }],
        ['pe', 'create_excel', { sheets: [{ columns: ['stat_date', 'amount'] }] }],
      ].map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: calls } }] }));
      return;
    }
    if (responseMode === 'invalid-decimal') {
      const input = JSON.parse(payload.messages.find(message => message.role === 'user').content);
      const sum = input.rows.reduce((total, row) => total + Number(row.amount), 0).toFixed(2);
      const call = { id: 'bad', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'amount' }], analysis_markdown: `# 汇总\n\n合计为 ${sum}。` }) } };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'analysis-ungrounded') {
      const call = { id: 'ungrounded', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'amount' }], analysis_markdown: '# 汇总\n\n总额为 999999。' }) } };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'row-count') {
      const call = {
        id: 'count', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'row_count' }], analysis_markdown: '# 数据量\n\n查询结果为 1,261,699 行。' }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    res.end(JSON.stringify({
      id: 'resp_result_agent_fixture', model: 'internal-test-model-resolved',
      choices: [{ message: { content: null, tool_calls: toolCalls } }],
    }));
  });
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const address = modelServer.address();
if (!address || typeof address === 'string') throw new Error('model fixture did not bind');
const values = {
  DATA_MCP_RESULT_MODEL_ENDPOINT: `http://127.0.0.1:${address.port}/v1/chat/completions`,
  DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS: '127.0.0.1',
  DATA_MCP_RESULT_MODEL: 'internal-test-model',
  DATA_MCP_RESULT_MODEL_API_KEY: 'internal-test-key',
};
const runtimeConfig = { value: name => values[name] };
const result = {
  status: 'success', datasource: 'tchouse-c', row_count: 2,
  columns: [{ name: 'stat_date', type: 'Date' }, { name: 'amount', type: 'Decimal' }],
  rows: [{ stat_date: '2026-03-01', amount: 12.5 }, { stat_date: '2026-03-02', amount: 18.75 }],
  truncated: false, quality_warnings: [],
  result_context: canonicalContext([
    { name: 'stat_date', type: 'Date' }, { name: 'amount', type: 'Decimal' },
  ], {
    filter_predicates: ["stat_date >= '2026-03-01'", "stat_date < '2026-04-01'"],
    time_range_predicates: ["stat_date >= '2026-03-01'", "stat_date < '2026-04-01'"],
    grouping_columns: ['stat_date'],
  }),
};

const delivered = await runInternalResultAgent({
  result,
  question: '按日返回完整明细，并生成分析、Excel、PDF、图表和文档',
  requestedOutputs: ['analysis', 'excel', 'pdf', 'chart', 'document'],
  runtimeConfig,
  pluginHome,
});
if (!delivered.markdown.includes('## 数据口径')
  || !delivered.markdown.includes('synthetic.events')
  || !delivered.markdown.includes("stat_date &gt;= '2026-03-01'")) {
  throw new Error('analysis did not combine result and query scope');
}
if (delivered.files.length !== 3 || delivered.artifactTypes.join(',') !== 'excel,chart,pdf,document') {
  throw new Error('result Agent did not create every requested artifact');
}
for (const expected of [
  '# 金额趋势概览',
  '由 12.50 上升至 18.75，增加 6.25（50.00%）',
  '## 关注点',
  '不能证明因果关系',
  '## 数据明细',
  '| 日期 | 金额 |',
  '| 2026-03-01 | 12.5 |',
  '```vega-lite',
  '"value_exact":"18.75"',
]) {
  if (!delivered.markdown.includes(expected)) throw new Error(`decision-oriented delivery missing ${expected}`);
}
if (delivered.audit?.status !== 'succeeded'
  || delivered.audit.modelId !== 'internal-test-model'
  || delivered.audit.responseModel !== 'internal-test-model-resolved'
  || delivered.audit.requestId !== 'req_result_agent_fixture'
  || delivered.audit.promptTemplateVersion !== 'result-agent-tool-contract-v6'
  || delivered.audit.inputRowCount !== 2
  || delivered.audit.httpStatus !== 200
  || ![delivered.audit.promptTemplateHash, delivered.audit.inputHash, delivered.audit.outputHash]
    .every(value => /^[a-f0-9]{64}$/.test(value))) {
  throw new Error('result Agent did not return a complete privacy-safe audit trace');
}
if (requests.length !== 1 || requests.some(entry => entry.authorization !== 'Bearer internal-test-key')) {
  throw new Error('result Agent model loop or authentication is incorrect');
}
const firstRequest = requests[0].payload;

responseMode = 'retry-503';
requests = [];
const retried = await runInternalResultAgent({
  result, question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (requests.length !== 3
  || retried.audit?.modelAttemptCount !== 3
  || retried.audit?.modelRetriesUsed !== 2
  || retried.audit?.httpStatus !== 200) {
  throw new Error('transient model failures did not recover with bounded retries');
}

responseMode = 'unauthorized';
requests = [];
let unauthorizedError;
try {
  await runInternalResultAgent({
    result, question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
  });
} catch (error) { unauthorizedError = error; }
if (unauthorizedError?.message !== 'result_agent_http_401'
  || requests.length !== 1
  || unauthorizedError?.resultAgentAudit?.modelAttemptCount !== 1
  || unauthorizedError?.resultAgentAudit?.modelRetriesUsed !== 0) {
  throw new Error('non-retryable model authentication failure was retried');
}

responseMode = 'always-503';
requests = [];
let exhaustedError;
try {
  await runInternalResultAgent({
    result, question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
  });
} catch (error) { exhaustedError = error; }
if (exhaustedError?.message !== 'result_agent_http_503'
  || requests.length !== 3
  || exhaustedError?.resultAgentAudit?.modelAttemptCount !== 3
  || exhaustedError?.resultAgentAudit?.modelRetriesUsed !== 2) {
  throw new Error('transient model failure retry budget was not bounded');
}

responseMode = 'tools';
requests = [];
if (firstRequest.max_tokens !== 2048
  || firstRequest.chat_template_kwargs?.enable_thinking !== false) {
  throw new Error('result Agent did not bound output tokens and disable Qwen thinking mode');
}
const envelope = JSON.parse(firstRequest.messages.find(message => message.role === 'user').content);
if (envelope.rows.length !== 2
  || envelope.result_manifest.columns[1].name !== 'amount'
  || envelope.result_manifest.context.provenance !== 'data_mcp_validated_query_plan') {
  throw new Error('result Agent did not receive rows, schema, and metric context');
}
const expectedTools = ['create_analysis', 'create_excel', 'create_pdf', 'create_chart', 'create_document'];
for (const name of expectedTools) {
  if (!firstRequest.tools.some(tool => tool.function?.name === name)) throw new Error(`missing Agent tool ${name}`);
}
const analysisTool = firstRequest.tools.find(tool => tool.function?.name === 'create_analysis');
if (!analysisTool?.function?.parameters?.properties?.table_columns
  || !analysisTool.function.parameters.properties.table_max_rows
  || !analysisTool.function.parameters.required.includes('analysis_markdown')
  || !firstRequest.messages.find(message => message.role === 'system')?.content?.includes('摘要不能替代明细')) {
  throw new Error('analysis tool did not expose or require inline row-detail semantics');
}
if (firstRequest.tools.some(tool => tool.function?.name === 'report_semantic_gap')) {
  throw new Error('initial request exposed the follow-up-only semantic gap tool');
}

responseMode = 'semantic-gap';
requests = [];
const semanticGap = await runInternalResultAgent({
  result,
  question: '按当前结果没有的地区维度继续分析',
  requestedOutputs: ['analysis'],
  allowSemanticGap: true,
  runtimeConfig,
  pluginHome,
});
if (semanticGap.status !== 'semantic_gap'
  || semanticGap.semanticGap?.reason !== 'missing_dimension'
  || semanticGap.artifactTypes.length !== 0
  || !requests[0]?.payload?.tools?.some(tool => tool.function?.name === 'report_semantic_gap')) {
  throw new Error('follow-up semantic gap was not returned as a bounded structured result');
}

responseMode = 'semantic-gap-mixed';
let mixedGapError;
try {
  await runInternalResultAgent({
    result,
    question: '不要混合补查与产物',
    requestedOutputs: ['analysis'],
    allowSemanticGap: true,
    runtimeConfig,
    pluginHome,
  });
} catch (error) { mixedGapError = error; }
if (mixedGapError?.message !== 'result_agent_semantic_gap_mismatch') {
  throw new Error(`mixed semantic gap must fail closed, got ${mixedGapError?.message}`);
}
responseMode = 'tools';

responseMode = 'row-count';
const rowCountResult = {
  status: 'success', datasource: 'dlc', row_count: 1,
  columns: [{ name: 'row_count', type: 'BIGINT' }],
  rows: [{ row_count: 1261699 }],
  truncated: false, quality_warnings: [],
  result_context: canonicalContext([{ name: 'row_count', type: 'BIGINT' }], {
    datasource: 'dlc',
    tables: ['ksher_dim.dim_kgp_va_account'],
    metric_columns: ['row_count'],
    metric_expressions: ['COUNT(*) AS row_count'],
    filter_predicates: ["ds = '20261027'"],
    time_range_predicates: ["ds = '20261027'"],
  }),
};
const rowCountDelivery = await runInternalResultAgent({
  result: rowCountResult,
  question: '查询昨天数据量', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
for (const expected of [
  '查询结果为 1,261,699 行',
  '## 数据口径',
  'DLC',
  'ksher_dim.dim_kgp_va_account',
  "ds = '20261027'",
]) {
  if (!rowCountDelivery.markdown.includes(expected)) {
    throw new Error(`beautified count delivery missing ${expected}`);
  }
}
responseMode = 'tools';
for (const call of firstRequest.tools) {
  if (JSON.stringify(call).includes('sql')) throw new Error('result Agent tool schema leaked SQL');
}
const nonAnalysisCalls = toolCalls.filter(call => call.function.name !== 'create_analysis');
if (JSON.stringify(nonAnalysisCalls).includes('18.75') || JSON.stringify(nonAnalysisCalls).includes('2026-03-02')) {
  throw new Error('non-analysis tool arguments copied protected row values instead of binding source columns');
}

responseMode = 'analysis-ungrounded';
let ungroundedError;
try {
  await runInternalResultAgent({
    result, question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
  });
} catch (error) { ungroundedError = error; }
if (ungroundedError?.message !== 'result_agent_ungrounded_analysis') {
  throw new Error(`ungrounded analysis must fail closed, got ${ungroundedError?.message}`);
}
for (const file of delivered.files) {
  if (!existsSync(file.path)) throw new Error(`missing generated ${file.type}`);
  const content = readFileSync(file.path);
  if (file.type === 'excel' && content.subarray(0, 2).toString() !== 'PK') throw new Error('invalid xlsx');
  if (file.type === 'pdf' && content.subarray(0, 5).toString() !== '%PDF-') throw new Error('invalid pdf');
  if (file.type === 'document' && !content.toString().includes('18.75')) throw new Error('document did not use protected source rows');
}

responseMode = 'none';
requests = [];
let noToolError;
try {
  await runInternalResultAgent({
    result, question: '生成 Excel', requestedOutputs: ['excel'], runtimeConfig, pluginHome,
  });
} catch (error) { noToolError = error; }
if (noToolError?.message !== 'result_agent_tool_call_required') {
  throw new Error(`missing tool call must fail closed, got ${noToolError?.message}`);
}

responseMode = 'unrequested';
requests = [];
let unrequestedError;
try {
  await runInternalResultAgent({
    result, question: '只生成 Excel', requestedOutputs: ['excel'], runtimeConfig, pluginHome,
  });
} catch (error) { unrequestedError = error; }
if (unrequestedError?.message !== 'result_agent_unrequested_tool') {
  throw new Error(`unrequested tool must fail closed, got ${unrequestedError?.message}`);
}

responseMode = 'excel-only';
requests = [];
let rowLimitError;
try {
  await runInternalResultAgent({
    result: { ...result, row_count: 10_000, rows: Array.from({ length: 10_000 }, (_, index) => ({
      stat_date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
      amount: index,
    })) },
    question: '生成超限 Excel', requestedOutputs: ['excel'], runtimeConfig, pluginHome,
  });
} catch (error) { rowLimitError = error; }
if (rowLimitError?.message !== 'result_agent_artifact_row_limit') {
  throw new Error(`artifact row limit must fail closed, got ${rowLimitError?.message}`);
}

for (const [mode, output] of [
  ['free-text-chinese', 'document'],
  ['free-text-english', 'document'],
  ['free-text-multiplier', 'document'],
  ['free-text-chart', 'chart'],
]) {
  responseMode = mode;
  requests = [];
  let freeTextError;
  try {
    await runInternalResultAgent({
      result, question: '生成产物', requestedOutputs: [output], runtimeConfig, pluginHome,
    });
  } catch (error) { freeTextError = error; }
  if (freeTextError?.message !== 'result_agent_free_text_not_allowed') {
    throw new Error(`${mode} must fail closed, got ${freeTextError?.message}`);
  }
}

responseMode = 'precision';
requests = [];
const precisionColumns = [{ name: 'stat_date', type: 'Date' }, { name: 'amount', type: 'Nullable(Decimal(38, 2))' }];
const precisionResult = {
  ...result,
  row_count: 4,
  columns: precisionColumns,
  rows: [
    { stat_date: '2026-03-01', amount: '9007199254740993.00' },
    { stat_date: '2026-03-02', amount: '0.01' },
    { stat_date: '2026-03-03', amount: '-3.50' },
    { stat_date: '2026-03-04', amount: null },
  ],
  result_context: canonicalContext(precisionColumns),
};
const precision = await runInternalResultAgent({
  result: precisionResult,
  question: '生成高精度多产物',
  requestedOutputs: ['analysis', 'document', 'pdf', 'chart', 'excel'],
  runtimeConfig,
  pluginHome,
});
const exactClaims = [
  '- **金额（合计）**：9,007,199,254,740,989.51',
  '- **金额（平均值）**：3,002,399,751,580,329.836667',
  '- **金额（最小值）**：-3.50',
  '- **金额（最大值）**：9,007,199,254,740,993.00',
];
for (const claim of exactClaims) {
  const document = precision.files.find(file => file.type === 'document');
  if (!readFileSync(document.path, 'utf8').includes(claim)) throw new Error(`missing exact document claim: ${claim}`);
  const pdf = precision.files.find(file => file.type === 'pdf');
  const utf16 = Buffer.from(`\ufeff${claim}`, 'utf16le').swap16().toString('hex').toUpperCase();
  if (!readFileSync(pdf.path).toString().includes(utf16)) throw new Error(`missing exact PDF claim: ${claim}`);
}
if (!precision.markdown.includes('```vega-lite')
  || !precision.markdown.includes('"value_exact":"9007199254740993.00"')) {
  throw new Error('high-precision inline chart was not generated from exact decimal inputs');
}

responseMode = 'invalid-decimal';
requests = [];
const decimalColumns = [{ name: 'stat_date', type: 'Date' }, { name: 'amount', type: 'Decimal(10, 2)' }];
const decimalResult = {
  ...result,
  columns: decimalColumns,
  rows: [{ stat_date: '2026-03-01', amount: '0.10' }, { stat_date: '2026-03-02', amount: '0.20' }],
  result_context: canonicalContext(decimalColumns),
};
const decimalSum = await runInternalResultAgent({
  result: decimalResult, question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!decimalSum.markdown.includes('合计为 0.30')) {
  throw new Error(`decimal addition lost scale or precision: ${decimalSum.markdown}`);
}
const negativeSum = await runInternalResultAgent({
  result: {
    ...decimalResult,
    row_count: 3,
    rows: [
      { stat_date: '2026-03-01', amount: '-1.00' },
      { stat_date: '2026-03-02', amount: '-2.00' },
      { stat_date: '2026-03-03', amount: '-2.00' },
    ],
  },
  question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!negativeSum.markdown.includes('合计为 -5.00')) {
  throw new Error(`negative decimal aggregation is incorrect: ${negativeSum.markdown}`);
}
for (const invalid of ['not-a-number', 9007199254740992]) {
  let invalidError;
  try {
    await runInternalResultAgent({
      result: { ...result, rows: [{ stat_date: '2026-03-01', amount: invalid }] },
      question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
    });
  } catch (error) { invalidError = error; }
  if (invalidError?.message !== 'result_agent_invalid_claim_value') {
    throw new Error(`invalid decimal must fail closed, got ${invalidError?.message}`);
  }
}

let contextError;
try {
  await runInternalResultAgent({
    result: {
      ...result,
      result_context: { ...result.result_context, grouping_columns: ['tampered_group'] },
    },
    question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
  });
} catch (error) { contextError = error; }
if (contextError?.message !== 'result_agent_context_invalid') {
  throw new Error(`tampered canonical context must fail closed, got ${contextError?.message}`);
}

responseMode = 'excel-only';
requests = [];
const isolated = await runIsolatedResultAgent({
  result, question: '生成 Excel', requestedOutputs: ['excel'], runtimeConfig, pluginHome,
});
if (isolated.files.length !== 1 || isolated.artifactTypes[0] !== 'excel') {
  throw new Error('isolated result Agent worker did not create the requested artifact');
}
if (isolated.audit?.modelId !== 'internal-test-model'
  || isolated.audit.promptTemplateVersion !== 'result-agent-tool-contract-v6') {
  throw new Error('isolated result Agent worker dropped the audit trace');
}
rmSync(isolated.files[0].path, { force: true });

for (const file of delivered.files) rmSync(file.path, { force: true });
for (const file of precision.files) rmSync(file.path, { force: true });
modelServer.close();
rmSync(root, { recursive: true, force: true });
console.log('internal result Agent tool-call tests passed');
