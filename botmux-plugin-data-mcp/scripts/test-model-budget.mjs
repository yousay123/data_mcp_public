import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInternalResultAgent } from '../src/result-agent/runtime.js';
import { runIsolatedResultAgent } from '../src/mcp/result-agent-client.js';
import { canonicalContext } from './test-result-context-fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'result-model-budget-'));
const columns = [{ name: 'value', type: 'UInt64' }];
const result = { status: 'success', datasource: 'tchouse-c', row_count: 2, columns,
  rows: [{ value: 2 }, { value: 3 }], result_context: canonicalContext(columns) };
let scenario = 'ok'; let requests = [];
const server = createServer((req, res) => {
  const chunks = []; req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const payload = JSON.parse(Buffer.concat(chunks)); requests.push(payload);
    if (scenario === 'network_then_expand' && requests.length === 1) { res.writeHead(503); res.end('{}'); return; }
    const length = scenario === 'always_length' || (['expand', 'network_then_expand'].includes(scenario) && payload.max_tokens < 8192);
    const available = new Set(payload.tools.map(tool => tool.function.name));
    let calls = JSON.parse(payload.messages.find(message => message.role === 'user').content).requested_outputs.map(output => ({
      id: output, type: 'function', function: {
        name: output === 'analysis' ? 'create_analysis' : 'create_excel',
        arguments: JSON.stringify(output === 'analysis' ? { analysis_markdown: '合成结果 2 与 3，可自由分析。' } : { sheets: [{ columns: ['value'] }] }),
      },
    })).filter(call => available.has(call.function.name));
    if (['multi', 'slow_after_plan'].includes(scenario) && requests.length === 1) calls = calls.filter(call => call.function.name === 'create_excel');
    if (scenario === 'repair_batches') {
      if (requests.length === 1) {
        calls.find(call => call.function.name === 'create_analysis').function.arguments = JSON.stringify({ analysis_markdown: '{{fact_99}}' });
        calls.reverse();
      } else if (requests.length === 2) calls = calls.filter(call => call.function.name === 'create_analysis');
    }
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'synthetic-budget-model', choices: [{ finish_reason: length ? 'length' : 'tool_calls', message: { tool_calls: calls } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: payload.chat_template_kwargs.enable_thinking ? 10 : 0 } } }));
    };
    if (scenario === 'slow' || (scenario === 'slow_after_plan' && requests.length > 1)) { const timer = setTimeout(reply, 1500); res.once('close', () => clearTimeout(timer)); }
    else reply();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = {
  DATA_MCP_RESULT_MODEL_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
  DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS: '127.0.0.1', DATA_MCP_RESULT_MODEL: 'synthetic-budget-model',
  DATA_MCP_RESULT_MODEL_RETRY_BASE_DELAY_MS: '0',
};
const options = (name, overrides = {}, extra = {}) => ({ result, question: '合成预算验收', requestedOutputs: ['analysis', 'excel'],
  pluginHome: join(root, name), runtimeConfig: { value: key => ({ ...config, ...overrides })[key] }, ...extra });
const files = name => existsSync(join(root, name, 'outbound')) ? readdirSync(join(root, name, 'outbound')) : [];
try {
  const baseline = await runInternalResultAgent(options('default'));
  assert.equal(requests[0].max_tokens, 8192);
  assert.equal(baseline.audit.finishReason, 'tool_calls');
  assert.equal(baseline.audit.completionTokens, 30);
  requests = [];
  const isolated = await runIsolatedResultAgent(options('isolated', {
    DATA_MCP_RESULT_MODEL_MAX_TOKENS: '4096', DATA_MCP_RESULT_MODEL_MAX_TOKENS_CAP: '8192',
    DATA_MCP_RESULT_MODEL_ENABLE_THINKING: 'true', DATA_MCP_RESULT_MODEL_TEMPERATURE: '0.3',
  }));
  assert.equal(requests[0].max_tokens, 4096);
  assert.equal(requests[0].temperature, 0.3);
  assert.equal(requests[0].chat_template_kwargs.enable_thinking, true);
  assert.equal(isolated.audit.reasoningTokens, 10);

  scenario = 'multi'; requests = [];
  const planned = await runInternalResultAgent(options('multi'));
  assert.equal(requests.length, 2); assert.equal(planned.audit.modelPlanningRounds, 1);
  assert.equal(files('multi').length, 1);
  scenario = 'repair_batches'; requests = [];
  const repaired = await runInternalResultAgent(options('repair_batches'));
  assert.equal(requests.length, 3); assert.equal(repaired.audit.modelRepairCount, 1);
  assert.equal(repaired.audit.modelPlanningRounds, 1);
  assert.equal(files('repair_batches').length, 1, 'rolled-back output must not survive partial repair planning');

  scenario = 'expand'; requests = [];
  const expanded = await runInternalResultAgent(options('expand', { DATA_MCP_RESULT_MODEL_MAX_TOKENS: '2048', DATA_MCP_RESULT_MODEL_MAX_TOKENS_CAP: '8192' }));
  assert.deepEqual(requests.map(request => request.max_tokens), [2048, 8192]);
  assert.equal(expanded.audit.modelBudgetExpansions, 1);
  assert.equal(expanded.audit.modelRetriesUsed, 0);
  assert.equal(expanded.audit.modelAttemptCount, 2);
  assert.equal(expanded.audit.completionTokens, 60);
  assert.equal(files('expand').length, 1, 'length response must not execute artifact tools');

  scenario = 'always_length'; requests = [];
  await assert.rejects(runInternalResultAgent(options('bounded', { DATA_MCP_RESULT_MODEL_MAX_TOKENS: '4096', DATA_MCP_RESULT_MODEL_MAX_TOKENS_CAP: '8192' })), error => {
    assert.equal(error.message, 'result_agent_output_truncated');
    assert.equal(error.resultAgentAudit.finishReason, 'length');
    assert.equal(error.resultAgentAudit.modelMaxTokens, 8192);
    return true;
  });
  assert.equal(requests.length, 2); assert.equal(files('bounded').length, 0);
  requests = [];
  await assert.rejects(runInternalResultAgent(options('strict', { DATA_MCP_RESULT_MODEL_MAX_TOKENS: '2048', DATA_MCP_RESULT_MODEL_MAX_TOKENS_CAP: '2048' })), /result_agent_output_truncated/);
  assert.equal(requests.length, 1);

  scenario = 'network_then_expand'; requests = [];
  const retried = await runInternalResultAgent(options('retry', { DATA_MCP_RESULT_MODEL_MAX_TOKENS: '2048', DATA_MCP_RESULT_MODEL_MAX_TOKENS_CAP: '8192' }));
  assert.equal(requests.length, 3); assert.equal(retried.audit.modelRetriesUsed, 1);
  assert.equal(retried.audit.modelBudgetExpansions, 1); assert.equal(files('retry').length, 1);
  scenario = 'slow'; requests = [];
  await assert.rejects(runIsolatedResultAgent(options('cancelled', {}, { timeoutMs: 500 })), /result_agent_timeout/);
  assert.equal(files('cancelled').length, 0);
  scenario = 'slow_after_plan'; requests = [];
  await assert.rejects(runIsolatedResultAgent(options('cancelled_plan', {}, { timeoutMs: 500 })), /result_agent_timeout/);
  assert.equal(requests.length, 2); assert.equal(files('cancelled_plan').length, 0);
  for (const overrides of [
    { DATA_MCP_RESULT_MODEL_MAX_TOKENS: '-1' },
    { DATA_MCP_RESULT_MODEL_MAX_TOKENS: '8192', DATA_MCP_RESULT_MODEL_MAX_TOKENS_CAP: '2048' },
    { DATA_MCP_RESULT_MODEL_ENABLE_THINKING: 'invalid' }, { DATA_MCP_RESULT_MODEL_TEMPERATURE: 'NaN' },
  ]) await assert.rejects(runInternalResultAgent(options('invalid', overrides)), /result_agent_invalid_(?:retry|model)_config/);
  console.log('model budget tests passed: configurable worker parameters, bounded length expansion, retries, cancellation, no partial artifacts');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
