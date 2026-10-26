import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInternalResultAgent } from '../src/mcp/result-agent.js';

const root = mkdtempSync(join(tmpdir(), 'data-mcp-result-agent-'));
const pluginHome = join(root, 'plugin-home');
let responseMode = 'tools';
let requests = [];

const toolCalls = [
  ['call_excel', 'create_excel', { filename: '结果.xlsx', sheets: [{ name: '每日', columns: ['stat_date', 'amount'] }] }],
  ['call_chart', 'create_chart', { filename: '趋势.svg', title: '每日趋势', type: 'line', label_column: 'stat_date', value_column: 'amount' }],
  ['call_pdf', 'create_pdf', { filename: '报告.pdf', title: '结果报告', sections: [{ heading: '结论', paragraphs: ['结果来自同一查询。'] }], table_columns: ['stat_date', 'amount'] }],
  ['call_doc', 'create_document', { filename: '说明.md', title: '结果说明', sections: [{ heading: '口径', paragraphs: ['按日汇总。'] }], table_columns: ['stat_date', 'amount'] }],
].map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }));

const modelServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ payload, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (payload.tool_choice === 'none') {
      res.end(JSON.stringify({ choices: [{ message: { content: '已按同一查询结果生成全部产物。' } }] }));
      return;
    }
    if (responseMode === 'none') {
      res.end(JSON.stringify({ choices: [{ message: { content: '没有调用工具。' } }] }));
      return;
    }
    if (responseMode === 'unrequested') {
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [toolCalls[1]] } }] }));
      return;
    }
    if (responseMode === 'excel-only') {
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [toolCalls[0]] } }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: toolCalls } }] }));
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
};

const delivered = await runInternalResultAgent({
  result,
  question: '生成分析、Excel、PDF、图表和文档',
  resultContext: {
    time_range: '[2026-03-01, 2026-04-01)', metric: '提现成功金额 USD',
    grouping: 'day', timezone: 'Asia/Shanghai', filters: ['ds=20260301..20260331'],
  },
  requestedOutputs: ['analysis', 'excel', 'pdf', 'chart', 'document'],
  runtimeConfig,
  pluginHome,
});
if (delivered.files.length !== 4 || delivered.artifactTypes.join(',') !== 'excel,chart,pdf,document') {
  throw new Error('result Agent did not create every requested artifact');
}
if (requests.length !== 2 || requests.some(entry => entry.authorization !== 'Bearer internal-test-key')) {
  throw new Error('result Agent model loop or authentication is incorrect');
}
const firstRequest = requests[0].payload;
const envelope = JSON.parse(firstRequest.messages.find(message => message.role === 'user').content);
if (envelope.rows.length !== 2
  || envelope.result_manifest.columns[1].name !== 'amount'
  || envelope.result_manifest.context.timezone !== 'Asia/Shanghai') {
  throw new Error('result Agent did not receive rows, schema, and metric context');
}
const expectedTools = ['create_excel', 'create_pdf', 'create_chart', 'create_document'];
for (const name of expectedTools) {
  if (!firstRequest.tools.some(tool => tool.function?.name === name)) throw new Error(`missing Agent tool ${name}`);
}
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

for (const file of delivered.files) rmSync(file.path, { force: true });
modelServer.close();
rmSync(root, { recursive: true, force: true });
console.log('internal result Agent tool-call tests passed');
