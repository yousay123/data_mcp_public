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
let modelHttpFailuresRemaining = 0;
let repairResponses = 0;

const toolCalls = [
  ['call_analysis', 'create_analysis', {
    analysis_markdown: '# 金额变化观察\n\n{{claim_0}}\n\n金额表现存在变化，建议结合业务活动进一步核查。',
    claims: [{ operation: 'sum', column: 'amount' }],
  }],
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
    if (modelHttpFailuresRemaining > 0) {
      modelHttpFailuresRemaining -= 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'synthetic transient failure' }));
      return;
    }
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
        ['pa', 'create_analysis', { analysis_markdown: '# 精度校验\n\n{{claim_0}}\n\n{{claim_1}}\n\n{{claim_2}}\n\n{{claim_3}}', claims }],
        ['pd', 'create_document', { claims, table_columns: ['stat_date', 'amount'] }],
        ['pp', 'create_pdf', { claims, table_columns: ['stat_date', 'amount'] }],
        ['pc', 'create_chart', { type: 'bar', label_column: 'stat_date', value_column: 'amount' }],
        ['pe', 'create_excel', { sheets: [{ columns: ['stat_date', 'amount'] }] }],
      ].map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: calls } }] }));
      return;
    }
    if (responseMode === 'invalid-decimal') {
      const call = { id: 'bad', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify({ analysis_markdown: '# 异常值\n\n{{claim_0}}', claims: [{ operation: 'sum', column: 'amount' }] }) } };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'row-count') {
      const call = {
        id: 'count', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({ analysis_markdown: '# 数据量结果\n\n{{claim_0}}', claims: [{ operation: 'sum', column: 'row_count' }] }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'string-fact') {
      const call = {
        id: 'string-fact', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({
            analysis_markdown: '# 当前账号\n\n{{fact_0}}\n\n该账号来自本次查询结果。',
            facts: [{ row_index: 0, column: 'account', label: '当前账号' }],
          }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'generic-calculation') {
      const call = {
        id: 'generic-calculation', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({
            analysis_markdown: '# 通用计算\n\n相加 {{calc_0}}，相减 {{calc_1}}，相乘 {{calc_2}}，相除 {{calc_3}}，变化率 {{calc_4}}%。',
            calculations: [
              {
                operation: 'add', label: '相加',
                operands: [
                  { row_index: 0, column: 'amount' },
                  { row_index: 1, column: 'amount' },
                ],
              },
              {
                operation: 'subtract', label: '金额增量',
                operands: [
                  { row_index: 1, column: 'amount' },
                  { row_index: 0, column: 'amount' },
                ],
              },
              {
                operation: 'multiply', label: '相乘',
                operands: [
                  { row_index: 0, column: 'amount' },
                  { row_index: 1, column: 'amount' },
                ],
              },
              {
                operation: 'divide', label: '相除', precision: 2,
                operands: [
                  { row_index: 1, column: 'amount' },
                  { row_index: 0, column: 'amount' },
                ],
              },
              {
                operation: 'percent_change', label: '金额变化率', precision: 2,
                operands: [
                  { row_index: 0, column: 'amount' },
                  { row_index: 1, column: 'amount' },
                ],
              },
            ],
          }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'stat-evidence') {
      const content = JSON.parse(payload.messages.find(message => message.role === 'user').content);
      const reference = content.computed_facts.find(fact => fact.column === 'amount' && fact.operation === 'adjacent_up_count').reference;
      const repairing = payload.messages.some(message => message.role === 'tool');
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
        id: 'stat-evidence', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify({
          analysis_markdown: repairing ? `相邻上升 ${reference} 次。` : '相邻上升 {{stat_9999}} 次。',
          ...(repairing ? {} : { facts: [{ row_index: 0, column: 'stat_date' }] }),
        }) },
      }] } }] }));
      return;
    }
    if (responseMode === 'layout') {
      const calls = [
        ['layout-analysis', 'create_analysis', {
          analysis_markdown: '# 查询结果\n\n累计为 {{claim_0}}，建议关注后续变化。\n\n## 分析总结\n\n累计为 {{claim_0}}，建议关注后续变化。\n\n## 数据口径\n\nMODEL_SCOPE_DUPLICATE',
          claims: [{ operation: 'sum', column: 'amount' }], table_columns: ['stat_date', 'amount'],
        }],
        ['layout-chart', 'create_chart', { type: 'line', label_column: 'stat_date', value_column: 'amount' }],
        ['layout-excel', 'create_excel', { sheets: [{ columns: ['stat_date', 'amount'] }] }],
      ].map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: calls } }] }));
      return;
    }
    if (responseMode === 'summary-detail') {
      const call = {
        id: 'summary-detail', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({
            analysis_markdown: [
              '# 注册商户趋势',
              '',
              '本次累计为 {{claim_0}}。',
              '',
              '| stat_date | amount |',
              '| --- | --- |',
              '| 2026-03-01 | 12.5 |',
              '| 2026-03-02 | 18.75 |',
              '',
              '每日明细如下。',
            ].join('\n'),
            claims: [{ operation: 'sum', column: 'amount' }],
            table_columns: ['stat_date', 'amount'],
          }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'free-numeric-analysis') {
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
        id: 'free-analysis', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify({
          analysis_markdown: '本次覆盖 2 天，金额有所变化；假设未来增长 25.6%，可能达到 999999，此为情景推算而非已发生事实。\n\n| stat_date | amount |\n| --- | --- |\n| 2026-03-02 | 999999 |',
        }) },
      }] } }] }));
      return;
    }
    if (responseMode === 'redacted-dates-in-detail') {
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
        id: 'lost-summary', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify({
          analysis_markdown: '本次覆盖 2 天，建议结合业务背景观察变化。',
          facts: [{ row_index: 0, column: 'stat_date' }], table_columns: ['stat_date', 'amount'],
        }) },
      }] } }] }));
      return;
    }
    if (responseMode === 'redacted-fact-with-partial-table') {
      const call = {
        id: 'redacted-fact-with-partial-table', type: 'function',
        function: {
          name: 'create_analysis',
          arguments: JSON.stringify({
            analysis_markdown: '# 关键金额\n\n关键金额 {{fact_0}}；假设情景估计 999999，尚待验证。',
            facts: [{ row_index: 1, column: 'amount', label: '关键金额' }],
            table_columns: ['stat_date'],
          }),
        },
      };
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }));
      return;
    }
    if (responseMode === 'repair-once') {
      repairResponses += 1;
      const args = repairResponses === 1
        ? { analysis_markdown: '# 趋势判断\n\n较前期增长 {{calc_999}}%，建议继续观察。' }
        : {
            analysis_markdown: '# 趋势判断\n\n较前期增长 {{calc_0}}%，建议结合业务活动继续观察。',
            calculations: [{
              operation: 'percent_change', precision: 2,
              operands: [
                { row_index: 0, column: 'amount' },
                { row_index: 1, column: 'amount' },
              ],
            }],
          };
      const call = {
        id: `repair-${repairResponses}`,
        type: 'function',
        function: { name: 'create_analysis', arguments: JSON.stringify(args) },
      };
      res.end(JSON.stringify({
        id: `resp_repair_${repairResponses}`,
        model: 'internal-test-model-resolved',
        choices: [{ message: { content: null, tool_calls: [call] } }],
      }));
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
    query_semantics: {
      source_blocks: [{ tables: ['synthetic.events'], filters: [
        { column: 'stat_date', operator: 'gte', value: '2026-03-01', is_time: true },
        { column: 'stat_date', operator: 'lt', value: '2026-04-01', is_time: true },
      ], time_groupings: [{ column: 'stat_date', grain: 'day' }], aggregations: [{ column: 'amount', operation: 'sum' }] }],
      unmatched_records_zero_filled: false, filter_coverage_complete: true,
    },
  }),
};

const delivered = await runInternalResultAgent({
  result,
  question: '生成分析、Excel、PDF、图表和文档',
  requestedOutputs: ['analysis', 'excel', 'pdf', 'chart', 'document'],
  runtimeConfig,
  pluginHome,
});
if (!delivered.markdown.includes('**数据口径**：')
  || !delivered.markdown.includes('synthetic.events')
  || !delivered.markdown.includes("2026-03-31")) {
  throw new Error('analysis did not combine result and query scope');
}
if (delivered.files.length !== 3 || delivered.artifactTypes.join(',') !== 'excel,chart,pdf,document') {
  throw new Error('result Agent did not create every requested artifact');
}
const inlineChart = JSON.parse(delivered.markdown.match(/```vega-lite\n([^]*?)\n```/u)[1]);
if (inlineChart.mark !== 'line' || inlineChart.data.values[1].category !== '2026-03-02'
  || Number(inlineChart.data.values[1].value) !== 18.75 || delivered.files.some(file => file.type === 'chart')) {
  throw new Error('chart must bind source rows in the result card rather than become an SVG attachment');
}
const numericSummary = JSON.parse(requests[0].payload.messages.find(message => message.role === 'user').content)
  .computed_numeric_evidence.find(summary => summary.column === 'amount');
if (Number(numericSummary.average) !== 15.625 || numericSummary.minimum_row_indices.join() !== '0'
  || numericSummary.adjacent_changes_in_result_order.up !== 1) {
  throw new Error('model did not receive exact generic analysis evidence');
}
if (delivered.audit?.status !== 'succeeded'
  || delivered.audit.modelId !== 'internal-test-model'
  || delivered.audit.responseModel !== 'internal-test-model-resolved'
  || delivered.audit.requestId !== 'req_result_agent_fixture'
  || delivered.audit.promptTemplateVersion !== 'result-agent-tool-contract-v7'
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
  '**数据口径**：',
  'DLC',
  'ksher_dim.dim_kgp_va_account',
  '查询计划未完整提供',
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
  if (file.type === 'document' && !content.toString().includes('18.75')) throw new Error('document did not use protected source rows');
}

responseMode = 'string-fact';
const stringResult = {
  status: 'success', datasource: 'tchouse-c', row_count: 1,
  columns: [{ name: 'account', type: 'String' }],
  rows: [{ account: 'trusted_user_01' }],
  truncated: false, quality_warnings: [],
  result_context: canonicalContext([{ name: 'account', type: 'String' }], {
    metric_columns: ['account'],
    metric_expressions: ['currentUser() AS account'],
  }),
};
const stringDelivery = await runInternalResultAgent({
  result: stringResult,
  question: '只返回当前账号', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!stringDelivery.markdown.includes('**account**：trusted_user_01')
  || stringDelivery.markdown.includes('返回记录数')) {
  throw new Error('generic string fact was not rendered from the protected row');
}

responseMode = 'generic-calculation';
const calculationDelivery = await runInternalResultAgent({
  result,
  question: '分析两天金额变化', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
for (const expected of ['相加 31.25', '相减 6.25', '相乘 234.375', '相除 1.50', '变化率 50.00%']) {
  if (!calculationDelivery.markdown.includes(expected)) {
    throw new Error(`generic row-bound calculation missing ${expected}: ${calculationDelivery.markdown}`);
  }
}
if (calculationDelivery.markdown.includes('NaN') || calculationDelivery.markdown.includes('Infinity')) {
  throw new Error(`generic row-bound calculations were not rendered exactly: ${calculationDelivery.markdown}`);
}

responseMode = 'layout';
const layout = await runInternalResultAgent({
  result, question: '明细、图表、简短总结和 Excel', requestedOutputs: ['analysis', 'chart', 'excel'], runtimeConfig, pluginHome,
});
const detailPosition = layout.markdown.indexOf('## 数据明细');
const chartPosition = layout.markdown.indexOf('```vega-lite');
const analysisPosition = layout.markdown.indexOf('累计为 31.25');
const scopePosition = layout.markdown.indexOf('**数据口径**：');
if (!(detailPosition >= 0 && chartPosition > detailPosition && analysisPosition > chartPosition && scopePosition > analysisPosition)
  || layout.markdown.includes('MODEL_SCOPE_DUPLICATE') || layout.markdown.includes('# 查询结果')
  || layout.markdown.match(/累计为 31.25/gu)?.length !== 1
  || layout.markdown.match(/\*\*数据口径\*\*：/gu)?.length !== 1 || layout.markdown.includes('## 分析总结')
  || layout.files.length !== 1 || layout.files[0].type !== 'excel') {
  throw new Error('result card layout must deduplicate and place scope after chart and summary');
}

responseMode = 'stat-evidence';
const statDelivery = await runInternalResultAgent({
  result, question: '解释相邻变化', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!statDelivery.markdown.includes('相邻上升 1 次。')
  || statDelivery.markdown.includes('2026-03-01 次') || statDelivery.audit.modelRepairCount !== 1) {
  throw new Error('invalid optional reference was not repaired using trusted statistics');
}

responseMode = 'summary-detail';
const summaryDetailDelivery = await runInternalResultAgent({
  result,
  question: '查询近七天注册商户数，返回总数和每日明细',
  requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
for (const expected of ['本次累计为 31.25', '2026-03-01', '12.5', '2026-03-02', '18.75']) {
  if (!summaryDetailDelivery.markdown.includes(expected)) {
    throw new Error(`trusted summary/detail delivery missing ${expected}`);
  }
}
if ((summaryDetailDelivery.markdown.match(/\| stat_date \| amount \|/gu) || []).length !== 1
  || !summaryDetailDelivery.markdown.includes('每日明细如下。')) {
  throw new Error(`model-authored duplicate detail table was not removed: ${summaryDetailDelivery.markdown}`);
}

responseMode = 'repair-once';
requests = [];
repairResponses = 0;
const repairedDelivery = await runInternalResultAgent({
  result,
  question: '分析变化并给出建议',
  requestedOutputs: ['analysis'],
  runtimeConfig,
  pluginHome,
});
if (requests.length !== 2
  || repairedDelivery.audit?.modelRepairCount !== 1
  || repairedDelivery.audit?.modelAttemptCount !== 2
  || !repairedDelivery.markdown.includes('较前期增长 50.00%')
  || repairedDelivery.markdown.includes('33.3%')) {
  throw new Error('analysis repair did not replace an ungrounded number with a host-computed calculation');
}

responseMode = 'free-numeric-analysis';
requests = [];
const freeAnalysis = await runInternalResultAgent({
  result, question: '自由分析并提供假设情景', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (requests.length !== 1 || !freeAnalysis.markdown.includes('25.6%') || !freeAnalysis.markdown.includes('999999')
  || !freeAnalysis.markdown.includes('情景推算而非已发生事实')
  || !freeAnalysis.markdown.includes('| 2026-03-02 | 18.75 |') || freeAnalysis.markdown.includes('| 2026-03-02 | 999999 |')
  || freeAnalysis.audit.analysisRedactionUsed) {
  throw new Error('free numeric analysis must not be censored or rewrite source-bound rows');
}
responseMode = 'redacted-fact-with-partial-table';
requests = [];
const partialTableDelivery = await runInternalResultAgent({
  result, question: '返回关键金额和日期明细', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (requests.length !== 1 || !partialTableDelivery.markdown.includes('18.75')
  || !partialTableDelivery.markdown.includes('2026-03-02') || !partialTableDelivery.markdown.includes('999999')) {
  throw new Error('optional references and free estimates must coexist with exact detail data');
}
responseMode = 'redacted-dates-in-detail';
const duration = await runInternalResultAgent({
  result, question: '明细和简短总结', requestedOutputs: ['analysis'], runtimeConfig, pluginHome,
});
if (!duration.markdown.includes('本次覆盖 2 天') || duration.markdown.includes('## 分析总结')
  || duration.audit.analysisRedactionUsed || duration.audit.modelAttemptCount !== 1) {
  throw new Error('natural duration text must succeed without forced placeholders or summary headings');
}

responseMode = 'string-fact';
requests = [];
modelHttpFailuresRemaining = 1;
const retriedDelivery = await runInternalResultAgent({
  result: stringResult,
  question: '只返回当前账号',
  requestedOutputs: ['analysis'],
  runtimeConfig,
  pluginHome,
});
if (requests.length !== 2
  || retriedDelivery.audit?.modelAttemptCount !== 2
  || retriedDelivery.audit?.modelRetriesUsed !== 1
  || !retriedDelivery.markdown.includes('trusted_user_01')) {
  throw new Error('transient model failure was not retried safely');
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
  ['free-text-english', 'document'],
  ['free-text-multiplier', 'document'],
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

for (const [mode, output] of [['free-text-chinese', 'document'], ['free-text-chart', 'chart']]) {
  responseMode = mode;
  const authored = await runInternalResultAgent({ result, question: '自由组织产物标题', requestedOutputs: [output], runtimeConfig, pluginHome });
  if (output === 'document' && !readFileSync(authored.files[0].path, 'utf8').includes('九十九万')) throw new Error('document title was not model-authored');
  if (output === 'chart' && !authored.markdown.includes('总金额 999999')) throw new Error('chart title was not model-authored');
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
  const utf16 = Buffer.from(`\ufeff${claim.replace(/\*\*/gu, '')}`, 'utf16le').swap16().toString('hex').toUpperCase();
  if (!readFileSync(pdf.path).toString().includes(utf16)) throw new Error(`missing exact PDF claim: ${claim}`);
}
if (!precision.markdown.includes('```vega-lite') || !precision.markdown.includes('9007199254740993.00')) {
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
  || isolated.audit.promptTemplateVersion !== 'result-agent-tool-contract-v7') {
  throw new Error('isolated result Agent worker dropped the audit trace');
}
rmSync(isolated.files[0].path, { force: true });

let exhaustedBudgetError;
try {
  await runIsolatedResultAgent({
    result,
    question: '预算已耗尽时不得继续请求模型',
    requestedOutputs: ['analysis'],
    runtimeConfig,
    pluginHome,
    timeoutMs: -1,
  });
} catch (error) { exhaustedBudgetError = error; }
if (exhaustedBudgetError?.message !== 'result_agent_timeout') {
  throw new Error(`exhausted result Agent budget must fail immediately, got ${exhaustedBudgetError?.message}`);
}

let slowModelRequests = 0;
const slowModelServer = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    slowModelRequests += 1;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'slow-string-fact',
              type: 'function',
              function: {
                name: 'create_analysis',
                arguments: JSON.stringify({
                  analysis_markdown: '{{fact_0}}',
                  facts: [{ row_index: 0, column: 'account', label: '当前账号' }],
                }),
              },
            }],
          },
        }],
      }));
    }, 200);
  });
});
await new Promise(resolve => slowModelServer.listen(0, '127.0.0.1', resolve));
const slowAddress = slowModelServer.address();
if (!slowAddress || typeof slowAddress === 'string') throw new Error('slow model fixture did not bind');
const slowValues = {
  ...values,
  DATA_MCP_RESULT_MODEL_ENDPOINT: `http://127.0.0.1:${slowAddress.port}/v1/chat/completions`,
};
const smallBudgetStartedAt = Date.now();
let smallBudgetError;
try {
  await runIsolatedResultAgent({
    result: stringResult,
    question: '小正数预算不得被扩大',
    requestedOutputs: ['analysis'],
    runtimeConfig: { value: name => slowValues[name] },
    pluginHome,
    timeoutMs: 50,
  });
} catch (error) { smallBudgetError = error; }
const smallBudgetElapsedMs = Date.now() - smallBudgetStartedAt;
if (smallBudgetError?.message !== 'result_agent_timeout' || smallBudgetElapsedMs >= 1_000) {
  throw new Error(`small positive budget was expanded: ${JSON.stringify({
    error: smallBudgetError?.message,
    elapsedMs: smallBudgetElapsedMs,
    modelRequests: slowModelRequests,
  })}`);
}
await new Promise((resolve, reject) => slowModelServer.close(error => error ? reject(error) : resolve()));

for (const file of delivered.files) rmSync(file.path, { force: true });
for (const file of precision.files) rmSync(file.path, { force: true });
modelServer.close();
rmSync(root, { recursive: true, force: true });
console.log('internal result Agent tool-call tests passed');
