import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInternalResultAgent } from '../src/result-agent/runtime.js';
import { canonicalContext } from './test-result-context-fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'result-capabilities-'));
let chartType = 'line'; let mode = 'chart'; let requests = 0;
const columns = [{ name: 'day', type: 'String' }, { name: 'x', type: 'UInt64' }, { name: 'value', type: 'UInt64' }, { name: 'series', type: 'String' }];
const result = { status: 'success', datasource: 'tchouse-c', columns, row_count: 3,
  rows: [{ day: 'a', x: 1, value: 10, series: 'A' }, { day: 'b', x: 2, value: 20, series: 'B' }, { day: 'c', x: 3, value: 15, series: 'A' }],
  result_context: canonicalContext(columns),
};
const paragraph = '这是模型自主组织的合成场景报告，包含观察、待验证假设和行动建议；这些判断不替代明细数据。';
const content = ['## 主要观察', paragraph.repeat(5), '## 假设与验证', paragraph.repeat(6), '## 行动建议', paragraph.repeat(4), 'END_OF_REPORT',
  '| day | value |', '| --- | --- |', '| a | 999999 |'].join('\n\n');
const server = createServer((req, res) => {
  req.resume(); req.on('end', () => {
    requests += 1;
    let calls;
    if (mode === 'chart') {
      const args = { type: chartType, label_column: chartType === 'scatter' ? 'x' : 'day', value_column: 'value',
        ...(['bar', 'line', 'area', 'scatter'].includes(chartType) ? { series_column: 'series' } : {}) };
      calls = [{ id: 'chart', type: 'function', function: { name: 'create_chart', arguments: JSON.stringify(args) } }];
    } else if (mode === 'analysis' || mode === 'selected' || mode === 'bad_selection') calls = [{ id: 'analysis', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify(mode === 'analysis'
      ? { analysis_markdown: '金额增加，建议核对业务驱动。\n\n**口径说明**：此处重复口径，不应展示。', table_columns: ['day', 'value'], table_formats: [{ column: 'value', decimals: 2, grouping: true }] }
      : { analysis_markdown: '明细合计为{{claim_0}}。', claims: [{ operation: 'sum', column: 'value', row_indices: mode === 'selected' ? [0, 1] : [0, 0] }], table_columns: ['day', 'value'] }) } }];
    else calls = ['document', 'pdf'].map(output => ({ id: output, type: 'function', function: { name: `create_${output}`, arguments: JSON.stringify({ title: '合成报告', content_markdown: content, table_columns: ['day', 'value'] }) } }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: calls } }] }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const values = { DATA_MCP_RESULT_MODEL_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS: '127.0.0.1', DATA_MCP_RESULT_MODEL: 'synthetic-model' };
const runtimeConfig = { value: key => values[key] };
try {
  for (const type of ['bar', 'line', 'area', 'scatter', 'pie', 'donut']) {
    chartType = type;
    const output = await runInternalResultAgent({ result, question: '生成合适图表', requestedOutputs: ['chart'], runtimeConfig, pluginHome: root });
    const spec = JSON.parse(output.markdown.match(/```vega-lite\n([^]*?)\n```/u)[1]);
    assert.deepEqual(spec.data.values.map(row => row.value), [10, 20, 15]);
    if (type === 'scatter') { assert.equal(spec.mark, 'point'); assert.deepEqual(spec.data.values.map(row => row.category), [1, 2, 3]); }
    else if (type === 'pie') assert.equal(spec.mark, 'arc');
    else if (type === 'donut') assert.equal(spec.mark.type, 'arc');
    else assert.equal(spec.mark, type);
    if (process.env.DATA_MCP_TEST_ARTIFACT_DIR) {
      mkdirSync(process.env.DATA_MCP_TEST_ARTIFACT_DIR, { recursive: true });
      writeFileSync(join(process.env.DATA_MCP_TEST_ARTIFACT_DIR, `${type}.json`), JSON.stringify(spec));
    }
  }
  mode = 'report';
  const output = await runInternalResultAgent({ result, question: '自由组织长报告', requestedOutputs: ['document', 'pdf'], runtimeConfig, pluginHome: root });
  const markdown = readFileSync(output.files.find(file => file.type === 'document').path, 'utf8');
  assert(markdown.includes('## 假设与验证') && markdown.includes('END_OF_REPORT'));
  assert(markdown.includes('a | 10') && !markdown.includes('a | 999999'));
  assert(markdown.indexOf('END_OF_REPORT') < markdown.indexOf('**数据口径**'));
  const pdf = readFileSync(output.files.find(file => file.type === 'pdf').path).toString('latin1');
  const marker = Buffer.from('\ufeffEND_OF_REPORT', 'utf16le').swap16().toString('hex').toUpperCase();
  assert(pdf.includes(marker), 'long paragraphs must wrap without deleting their tail');
  mode = 'analysis';
  const exactResult = { ...result, rows: [{ day: 'a', x: 1, value: '9007199254740993.125', series: 'A' }, { day: 'b', x: 2, value: '-25633701.4', series: 'B' }, { day: 'c', x: 3, value: null, series: 'A' }] };
  const formatted = await runInternalResultAgent({ result: exactResult, question: '金额保留两位小数、千分位', requestedOutputs: ['analysis'], runtimeConfig, pluginHome: root });
  assert(formatted.markdown.includes('9,007,199,254,740,993.13'));
  assert(formatted.markdown.includes('-25,633,701.40'));
  assert(!formatted.markdown.includes('此处重复口径') && !formatted.markdown.includes('**口径说明**'));
  assert(formatted.markdown.includes('金额增加，建议核对业务驱动。'));
  assert.equal(exactResult.rows[0].value, '9007199254740993.125');
  assert.equal(requests, 8);
  mode = 'selected';
  const mixed = { ...result, rows: [{ day: 'a', value: 10 }, { day: 'b', value: 20 }, { day: '合计', value: 30 }] };
  const selected = await runInternalResultAgent({ result: mixed, question: '不要将合计行重复计入', requestedOutputs: ['analysis'], runtimeConfig, pluginHome: root });
  assert(selected.markdown.includes('明细合计为30。') && !selected.markdown.includes('明细合计为60。'));
  mode = 'bad_selection';
  await assert.rejects(runInternalResultAgent({ result: mixed, question: '重复行索引应拒绝', requestedOutputs: ['analysis'], runtimeConfig, pluginHome: root }), /result_agent_invalid_claim_rows/u);
  if (process.env.DATA_MCP_TEST_ARTIFACT_DIR) for (const file of output.files) copyFileSync(file.path, join(process.env.DATA_MCP_TEST_ARTIFACT_DIR, file.filename));
  console.log('result capabilities passed: six source-bound chart types, free report narrative, exact tables, complete multi-page PDF');
} finally {
  await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
}
