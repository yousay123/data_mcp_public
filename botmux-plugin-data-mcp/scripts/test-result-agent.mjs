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

const toolCalls = [
  ['call_analysis', 'create_analysis', { claims: [{ operation: 'sum', column: 'amount' }] }],
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
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_result_agent_fixture' });
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
        ['pa', 'create_analysis', { claims }],
        ['pd', 'create_document', { claims, table_columns: ['stat_date', 'amount'] }],
        ['pp', 'create_pdf', { claims, table_columns: ['stat_date', 'amount'] }],
        ['pc', 'create_chart', { type: 'bar', label_column: 'stat_date', value_column: 'amount' }],
        ['pe', 'create_excel', { sheets: [{ columns: ['stat_date', 'amount'] }] }],
      ].map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: calls } }] }));
      return;
    }
    if (responseMode === 'invalid-decimal') {
      const call = { id: 'bad', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'amount' }] }) } };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'row-count') {
      const call = {
        id: 'count', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'row_count' }] }),
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
  question: '生成分析、Excel、PDF、图表和文档',
  requestedOutputs: ['analysis', 'excel', 'pdf', 'chart', 'document'],
  runtimeConfig,
  pluginHome,
});
if (!delivered.markdown.includes('## 查询口径')
  || !delivered.markdown.includes('synthetic.events')
  || !delivered.markdown.includes("stat_date &gt;= '2026-03-01'")) {
  throw new Error('analysis did not combine result and query scope');
}
if (delivered.files.length !== 4 || delivered.artifactTypes.join(',') !== 'excel,chart,pdf,document') {
  throw new Error('result Agent did not create every requested artifact');
}
if (delivered.audit?.status !== 'succeeded'
  || delivered.audit.modelId !== 'internal-test-model'
  || delivered.audit.responseModel !== 'internal-test-model-resolved'
  || delivered.audit.requestId !== 'req_result_agent_fixture'
  || delivered.audit.promptTemplateVersion !== 'result-agent-tool-contract-v1'
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
  '**数据量：1,261,699 行**',
  '## 查询口径',
  'DLC',
  'ksher_dim.dim_kgp_va_account',
  'COUNT(*) AS row_count',
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
if (JSON.stringify(toolCalls).includes('18.75') || JSON.stringify(toolCalls).includes('2026-03-02')) {
  throw new Error('Agent tool arguments copied protected row values instead of binding source columns');
}
for (const file of delivered.files) {
  if (!existsSync(file.path)) throw new Error(`missing generated ${file.type}`);
  const content = readFileSync(file.path);
  if (file.type === 'excel' && content.subarray(0, 2).toString() !== 'PK') throw new Error('invalid xlsx');
  if (file.type === 'pdf' && content.subarray(0, 5).toString() !== '%PDF-') throw new Error('invalid pdf');
  if (file.type === 'chart' && (!content.toString().includes('<svg') || !content.toString().includes('2026-03-02'))) {
    throw new Error('chart did not use protected source rows');
  }
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
  '- **amount（合计）**：9,007,199,254,740,989.51',
  '- **amount（平均值）**：3,002,399,751,580,329.836667',
  '- **amount（最小值）**：-3.50',
  '- **amount（最大值）**：9,007,199,254,740,993.00',
];
for (const claim of exactClaims) {
  if (!precision.markdown.includes(claim)) throw new Error(`missing exact analysis claim: ${claim}`);
  const document = precision.files.find(file => file.type === 'document');
  if (!readFileSync(document.path, 'utf8').includes(claim)) throw new Error(`missing exact document claim: ${claim}`);
  const pdf = precision.files.find(file => file.type === 'pdf');
  const utf16 = Buffer.from(`\ufeff${claim}`, 'utf16le').swap16().toString('hex').toUpperCase();
  if (!readFileSync(pdf.path).toString().includes(utf16)) throw new Error(`missing exact PDF claim: ${claim}`);
}
if (!readFileSync(precision.files.find(file => file.type === 'chart').path, 'utf8').includes('<svg')) {
  throw new Error('high-precision chart was not generated from exact decimal inputs');
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
if (!decimalSum.markdown.includes('amount（合计）**：0.30')) {
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
if (!negativeSum.markdown.includes('amount（合计）**：-5.00')) {
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
  || isolated.audit.promptTemplateVersion !== 'result-agent-tool-contract-v1') {
  throw new Error('isolated result Agent worker dropped the audit trace');
}
rmSync(isolated.files[0].path, { force: true });

for (const file of delivered.files) rmSync(file.path, { force: true });
for (const file of precision.files) rmSync(file.path, { force: true });
modelServer.close();
rmSync(root, { recursive: true, force: true });
console.log('internal result Agent tool-call tests passed');
