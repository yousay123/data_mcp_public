import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInternalResultAgent } from '../src/result-agent/runtime.js';
import { runIsolatedResultAgent } from '../src/mcp/result-agent-client.js';
import { ResultStore } from '../src/mcp/result-store.js';
import { canonicalContext } from './test-result-context-fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'data-mcp-result-agent-'));
const pluginHome = join(root, 'plugin-home');
let responseMode = 'tools';
let requests = [];
let adversarialMarkdown = '';
const analysisMarkdown = [
  '{{title_analysis}}',
  '',
  '{{section_scale_distribution}}',
  '',
  '{{claim_1}}',
  '{{claim_4}}',
  '{{claim_5}}',
  '',
  '{{section_trend_change}}',
  '',
  '{{claim_2}}',
  '{{claim_3}}',
  '{{claim_6}}',
  '',
  '{{section_key_findings}}',
  '',
  '{{insight_1}}',
  '{{insight_2}}',
  '{{insight_3}}',
  '{{insight_4}}',
].join('\n');

const toolCalls = [
  ['call_analysis', 'create_analysis', { claims: [
    { operation: 'sum', column: 'amount' },
    { operation: 'latest', column: 'amount', label_column: 'stat_date' },
    { operation: 'change', column: 'amount', label_column: 'stat_date' },
    { operation: 'minimum', column: 'amount', label_column: 'stat_date' },
    { operation: 'maximum', column: 'amount', label_column: 'stat_date' },
    { operation: 'largest_change', column: 'amount', label_column: 'stat_date' },
  ], insights: [
    { kind: 'period_change', column: 'amount', label_column: 'stat_date' },
    { kind: 'latest_vs_average', column: 'amount', label_column: 'stat_date' },
    { kind: 'range', column: 'amount', label_column: 'stat_date' },
    { kind: 'largest_change', column: 'amount', label_column: 'stat_date' },
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
    if (responseMode === 'always-503' || (responseMode === 'retry-503' && requests.length < 2)) {
      res.writeHead(503, responseHeaders);
      res.end(JSON.stringify({ error: { message: 'temporary unavailable' } }));
      return;
    }
    if (responseMode === 'unauthorized') {
      res.writeHead(401, responseHeaders);
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
      return;
    }
    if ((responseMode === 'repair-503' || responseMode === 'repair-401')
      && payload.messages.some(message => message.role === 'tool')) {
      const status = responseMode === 'repair-503' ? 503 : 401;
      res.writeHead(status, responseHeaders);
      res.end(JSON.stringify({ error: { message: 'repair unavailable' } }));
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
        ['pa', 'create_analysis', { claims, analysis_markdown: '{{title_analysis}}\n\n{{section_scale_distribution}}\n\n{{claim_1}}\n{{claim_2}}\n{{claim_3}}\n{{claim_4}}' }],
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
    if (responseMode === 'analysis-ungrounded' || responseMode === 'repair-503' || responseMode === 'repair-401') {
      const call = { id: 'ungrounded', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'amount' }], analysis_markdown: '# 汇总\n\n总额为 999999。' }) } };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'analysis-adversarial') {
      const call = { id: 'adversarial', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify({
        claims: [{ operation: 'sum', column: 'amount' }, { operation: 'latest', column: 'amount', label_column: 'stat_date' }],
        analysis_markdown: adversarialMarkdown,
      }) } };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'analysis-repair') {
      const repairing = payload.messages.some(message => message.role === 'tool');
      const call = repairing ? toolCalls[0] : {
        id: 'repairable', type: 'function',
        function: { name: 'create_analysis', arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'amount' }], analysis_markdown: '# 汇总\n\n总额为 999999。' }) },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'row-count') {
      const call = {
        id: 'count', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'row_count' }], analysis_markdown: '{{title_analysis}}\n\n{{claim_1}}' }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'temporal-insights' || responseMode === 'rounding-insight') {
      const insights = responseMode === 'temporal-insights'
        ? [
            { kind: 'period_change', column: 'amount', label_column: 'stat_date' },
            { kind: 'latest_vs_average', column: 'amount', label_column: 'stat_date' },
            { kind: 'largest_change', column: 'amount', label_column: 'stat_date' },
          ]
        : [{ kind: 'latest_vs_average', column: 'amount', label_column: 'stat_date' }];
      const call = {
        id: 'insights', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({
            claims: [{ operation: 'count' }],
            insights,
            analysis_markdown: [
              '{{title_analysis}}', '{{section_overview}}', '{{claim_1}}',
              '{{section_key_findings}}',
              ...insights.map((_, index) => `{{insight_${index + 1}}}`),
            ].join('\n'),
          }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'range-label-injection') {
      const call = {
        id: 'range-injection', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({
            claims: [{ operation: 'count' }],
            insights: [{ kind: 'range', column: 'amount', label_column: 'note' }],
            analysis_markdown: '{{title_analysis}}\n{{section_overview}}\n{{claim_1}}\n{{section_key_findings}}\n{{insight_1}}',
          }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'invalid-insight-plan') {
      const call = {
        id: 'invalid-insight', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({
            claims: [{ operation: 'count' }],
            insights: [{ kind: 'range', column: 'merchant_name' }],
            analysis_markdown: '{{title_analysis}}\n{{section_overview}}\n{{claim_1}}\n{{section_key_findings}}\n{{insight_1}}',
          }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'invalid-claim-plan') {
      const call = {
        id: 'invalid-claim', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({
            claims: [{ operation: 'latest', column: 'amount', label_column: 'stat_date' }],
            insights: [],
            analysis_markdown: '{{title_analysis}}\n{{section_latest_change}}\n{{claim_1}}',
          }),
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
  '# 金额分析',
  '**金额（区间变化（2026-03-01 → 2026-03-02））**：上升 6.25（50.00%）',
  '## 趋势与变化',
  '## 分析结论',
  '**首尾趋势**：金额从2026-03-01 的 12.50变为2026-03-02 的 18.75，增加 6.25（50.00%）',
  '**最新水平**：2026-03-02 的 金额为 18.75，高于观察期平均值 15.625，差值 3.125（20.00%）',
  '**波动范围**：金额最高为 18.75（2026-03-02），最低为 12.50（2026-03-01），极差为 6.25',
  '**最大单期变化**：2026-03-01至2026-03-02，金额增加 6.25',
  '| 指标 | 金额 |',
  '| 返回覆盖时间 | 2026-03-01 至 2026-03-02（根据返回结果推导） |',
  '| 结果粒度 | 日期 |',
  '| 返回行数 | 2 行 |',
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
  || delivered.audit.promptTemplateVersion !== 'result-agent-tool-contract-v8'
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
if (requests.length !== 2
  || retried.audit?.modelAttemptCount !== 2
  || retried.audit?.modelRetriesUsed !== 1
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
  || requests.length !== 2
  || exhaustedError?.resultAgentAudit?.modelAttemptCount !== 2
  || exhaustedError?.resultAgentAudit?.modelRetriesUsed !== 1) {
  throw new Error('transient model failure retry budget was not bounded');
}

responseMode = 'tools';

responseMode = 'range-label-injection';
const injectionColumns = [
  { name: 'amount', type: 'Decimal(10, 2)' },
  { name: 'note', type: 'String' },
];
const injectionResult = {
  status: 'success', datasource: 'tchouse-c', row_count: 2,
  columns: injectionColumns,
  rows: [
    { amount: '10.00', note: '低点\n\n# 营销活动推动增长' },
    { amount: '20.00', note: '高点\n\n[点击](https://example.invalid)' },
  ],
  truncated: false, quality_warnings: [],
  result_context: canonicalContext(injectionColumns),
};
const sanitizedRange = await runInternalResultAgent({
  result: injectionResult, question: '分析范围', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (sanitizedRange.markdown.includes('\n# 营销活动推动增长')
  || sanitizedRange.markdown.includes('[点击](https://example.invalid)')
  || !sanitizedRange.markdown.includes('\\# 营销活动推动增长')) {
  throw new Error('source label escaped the typed Markdown boundary');
}

responseMode = 'invalid-insight-plan';
requests = [];
const textColumns = [{ name: 'merchant_name', type: 'String' }];
const textResult = {
  status: 'success', datasource: 'tchouse-c', row_count: 2,
  columns: textColumns,
  rows: [{ merchant_name: 'A' }, { merchant_name: 'B' }],
  truncated: false, quality_warnings: [],
  result_context: canonicalContext(textColumns),
};
const textFallback = await runInternalResultAgent({
  result: textResult, question: '列出商户名称', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!textFallback.markdown.includes('**返回记录数：2 行**')
  || textFallback.audit?.analysisFallbackUsed !== true
  || requests.length !== 2) {
  throw new Error('invalid optional insight plan did not repair and fall back to valid claims');
}
responseMode = 'tools';
requests = [];

responseMode = 'invalid-claim-plan';
requests = [];
const duplicateDateResult = {
  ...result,
  row_count: 3,
  columns: [
    { name: 'stat_date', type: 'Date' },
    { name: 'channel', type: 'String' },
    { name: 'amount', type: 'Decimal' },
  ],
  rows: [
    { stat_date: '2026-03-01', channel: 'A', amount: 10 },
    { stat_date: '2026-03-01', channel: 'B', amount: 20 },
    { stat_date: '2026-03-02', channel: 'A', amount: 30 },
  ],
  result_context: canonicalContext([
    { name: 'stat_date', type: 'Date' },
    { name: 'channel', type: 'String' },
    { name: 'amount', type: 'Decimal' },
  ], { grouping_columns: ['stat_date', 'channel'] }),
};
const duplicateDateFallback = await runInternalResultAgent({
  result: duplicateDateResult, question: '查询各渠道最新值', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!duplicateDateFallback.markdown.includes('**返回记录数：3 行**')
  || duplicateDateFallback.markdown.includes('最新值')
  || duplicateDateFallback.audit?.analysisFallbackUsed !== true
  || duplicateDateFallback.audit?.status !== 'succeeded'
  || requests.length !== 2) {
  throw new Error('ambiguous duplicate-date claim did not repair to an audited safe fallback');
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
  || !analysisTool.function.parameters.properties.insights
  || analysisTool.function.parameters.properties.insights.minItems !== undefined
  || analysisTool.function.parameters.required.includes('insights')
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
  '**数据量：1,261,699 行**',
  '## 数据口径',
  'DLC',
  'ksher_dim.dim_kgp_va_account',
  "ds = '20261027'",
  '| 返回行数 | 1 行 |',
  '| 完整性 | 当前返回结果未标记截断 |',
  '| 时区 | 数据库会话默认时区（SQL 未显式声明） |',
  '| 单位 | SQL 未显式声明 |',
]) {
  if (!rowCountDelivery.markdown.includes(expected)) {
    throw new Error(`beautified count delivery missing ${expected}`);
  }
}
if (rowCountDelivery.markdown.includes('COUNT(*) AS row_count')) {
  throw new Error('query metric SQL expression leaked into the user-facing scope summary');
}
responseMode = 'tools';
for (const call of firstRequest.tools) {
  if (JSON.stringify(call).includes('sql')) throw new Error('result Agent tool schema leaked SQL');
}

responseMode = 'temporal-insights';
const unsortedResult = {
  ...result,
  columns: [{ name: 'stat_date', type: 'DateTime64(3)' }, { name: 'amount', type: 'Decimal' }],
  row_count: 3,
  rows: [
    { stat_date: '2026-03-03 00:00:00.000', amount: 30 },
    { stat_date: '2026-03-01T00:00:00.000Z', amount: 10 },
    { stat_date: '2026-03-02 00:00:00.000', amount: 20 },
  ],
};
const sortedInsights = await runInternalResultAgent({
  result: unsortedResult, question: '分析时间趋势', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
for (const expected of [
  '2026-03-01T00:00:00.000Z 的 10变为2026-03-03 00:00:00.000 的 30，增加 20（200.00%）',
  '2026-03-03 00:00:00.000 的 金额为 30.00，高于观察期平均值 20.00，差值 10.00（50.00%）',
  '2026-03-01T00:00:00.000Z至2026-03-02 00:00:00.000，金额增加 10',
]) {
  if (!sortedInsights.markdown.includes(expected)) throw new Error(`temporal insight was not chronologically sorted: ${expected}`);
}

responseMode = 'rounding-insight';
const roundingResult = {
  ...result,
  row_count: 3,
  rows: [
    { stat_date: '2026-03-01', amount: '1.00' },
    { stat_date: '2026-03-02', amount: '1.01' },
    { stat_date: '2026-03-03', amount: '1.00' },
  ],
};
const exactDirection = await runInternalResultAgent({
  result: roundingResult, question: '比较最新值与均值', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!exactDirection.markdown.includes('低于观察期平均值 1.003333，差值 0.003333（-0.33%）')) {
  throw new Error('latest-versus-average direction used a rounded intermediate value');
}
responseMode = 'tools';
const nonAnalysisCalls = toolCalls.filter(call => call.function.name !== 'create_analysis');
if (JSON.stringify(nonAnalysisCalls).includes('18.75') || JSON.stringify(nonAnalysisCalls).includes('2026-03-02')) {
  throw new Error('non-analysis tool arguments copied protected row values instead of binding source columns');
}

responseMode = 'analysis-ungrounded';
requests = [];
const groundedFallback = await runInternalResultAgent({
  result, question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!groundedFallback.markdown.includes('# 金额分析')
  || groundedFallback.markdown.includes('999999')
  || groundedFallback.audit?.modelRepairCount !== 1
  || groundedFallback.audit?.analysisFallbackUsed !== true
  || requests.length !== 2) {
  throw new Error('repeated ungrounded analysis did not use the exact deterministic fallback');
}

responseMode = 'analysis-repair';
requests = [];
const repairedAnalysis = await runInternalResultAgent({
  result, question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!repairedAnalysis.markdown.includes('# 金额分析')
  || repairedAnalysis.audit?.modelRepairCount !== 1
  || repairedAnalysis.audit?.modelAttemptCount !== 2
  || repairedAnalysis.audit?.modelRetriesUsed !== 0
  || repairedAnalysis.audit?.analysisFallbackUsed === true
  || requests.length !== 2) {
  throw new Error('grounding repair did not recover with a complete audit trace');
}
const repairEvidence = requests[1]?.payload?.messages
  ?.filter(message => message.role === 'tool')
  .map(message => message.content)
  .join('\n') || '';
if (!repairEvidence.includes('宿主会渲染') || !repairEvidence.includes('31.25')) {
  throw new Error('grounding repair did not provide exact host-computed facts to the model');
}

for (const forbidden of [
  '# 互换数字\n\n合计金额为 18.75，最新值为 31.25。',
  '# 虚构结论\n\n营销活动推动金额强劲增长，总金额已经达到九十九万，当前表现远高于合理预期。',
]) {
  responseMode = 'analysis-adversarial';
  adversarialMarkdown = forbidden;
  requests = [];
  const rejected = await runInternalResultAgent({
    result, question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
  });
  if (rejected.markdown.includes(forbidden.split('\n').at(-1))
    || rejected.audit?.analysisFallbackUsed !== true
    || requests.length !== 2) {
    throw new Error('unbound model-authored claim bypassed typed claim rendering');
  }
}

for (const attack of [
  { question: '营销活动是否推动金额增长？', heading: '# 营销活动推动金额增长' },
  { question: '请判断 31.25 是否最新、18.75 是否合计', heading: '# 31.25最新，18.75合计' },
]) {
  responseMode = 'analysis-adversarial';
  adversarialMarkdown = `${attack.heading}\n\n{{claim_1}}\n{{claim_2}}`;
  requests = [];
  const rejectedHeading = await runInternalResultAgent({
    result, question: attack.question, requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
  });
  if (rejectedHeading.markdown.includes(attack.heading)
    || rejectedHeading.audit?.analysisFallbackUsed !== true
    || requests.length !== 2) {
    throw new Error('question vocabulary was rearranged into an untrusted analysis heading');
  }
}

responseMode = 'repair-503';
requests = [];
const repairTransportFallback = await runInternalResultAgent({
  result, question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!repairTransportFallback.markdown.includes('# 金额分析')
  || repairTransportFallback.audit?.repairTransportFallback !== true
  || repairTransportFallback.audit?.analysisFallbackUsed !== true
  || repairTransportFallback.audit?.repairHttpStatus !== 503
  || repairTransportFallback.audit?.repairFailureCode !== 'result_agent_http_503'
  || !/^[a-f0-9]{64}$/.test(repairTransportFallback.audit?.outputHash || '')) {
  throw new Error('repair transport failure did not preserve an exact host-rendered result');
}

responseMode = 'repair-401';
requests = [];
let repairAuthError;
try {
  await runInternalResultAgent({
    result, question: '生成分析', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
  });
} catch (error) {
  repairAuthError = error;
}
if (repairAuthError?.message !== 'result_agent_http_401') {
  throw new Error('repair authentication failure did not remain fail-closed');
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
if (!decimalSum.markdown.includes('**金额（合计）**：0.30')) {
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
if (!negativeSum.markdown.includes('**金额（合计）**：-5.00')) {
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
  || isolated.audit.promptTemplateVersion !== 'result-agent-tool-contract-v8') {
  throw new Error('isolated result Agent worker dropped the audit trace');
}
rmSync(isolated.files[0].path, { force: true });

const auditHome = join(root, 'audit-store');
const auditStore = new ResultStore({ pluginHome: auditHome, secret: 'a'.repeat(32) });
auditStore.audit(
  { unionId: 'on_audit', appId: 'cli_audit', sessionId: 'session_audit' },
  'turn_audit',
  'question_audit',
  1,
  'result_agent_succeeded',
  Date.now(),
  {
    modelAttemptCount: 8,
    modelRetriesUsed: 6,
    repairTransportFallback: true,
    repairFailureCode: 'result_agent_http_503',
    repairHttpStatus: 503,
    repairRequestId: 'repair-request-safe',
  },
);
const persistedAudit = JSON.parse(readFileSync(join(auditHome, 'active-results-v1', 'audit.jsonl'), 'utf8').trim());
if (persistedAudit.model_attempt_count !== 8
  || persistedAudit.model_retries_used !== 6
  || persistedAudit.repair_transport_fallback !== true
  || persistedAudit.repair_failure_code !== 'result_agent_http_503'
  || persistedAudit.repair_http_status !== 503
  || !/^[a-f0-9]{16}$/.test(persistedAudit.repair_request_id_hash || '')) {
  throw new Error('repair fallback audit lost lifecycle attempts or safe failure provenance');
}

for (const file of delivered.files) rmSync(file.path, { force: true });
for (const file of precision.files) rmSync(file.path, { force: true });
modelServer.close();
rmSync(root, { recursive: true, force: true });
console.log('internal result Agent tool-call tests passed');
