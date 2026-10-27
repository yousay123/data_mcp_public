import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeBotmux } from './test-botmux-fixture.mjs';
import { canonicalContext } from './test-result-context-fixture.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'data-mcp-delivery-'));
const pluginHome = join(root, 'plugin-home');
const hostEnvFile = join(root, 'host.env');
const missingModelEnvFile = join(root, 'host-missing-model.env');
const botmuxLog = join(root, 'botmux.jsonl');
const sentinel = 'CONFIDENTIAL_BUSINESS_ROW_7319';
const modelOutput = '受控分析结果：合成记录。';
let modelSawSentinel = false;
let modelSawAuth = false;
let modelSawLimitEvidence = false;
let queryCount = 0;
let failNextModelCall = false;

const runResult = {
  status: 'success', query_id: 'q_internal', row_count: 2,
  rows_before_limit_at_least: 2, truncated: false,
  effective_limit: 200, truncation_uncertain: true,
  user_limit_reached: false,
  user_limit_notice: '当前结果仅代表限定范围，不能用于全量汇总。',
  limit_notice: '查询结果达到或超出限制（上限 200 行）',
  limit_injected: true, limit_capped: false,
  columns: [{ name: 'stat_date' }, { name: 'amount' }, { name: 'secret' }],
  rows: [
    { stat_date: '2026-03-01', amount: 10, secret: sentinel },
    { stat_date: '2026-03-02', amount: 20, secret: sentinel },
  ],
  result_context: canonicalContext([
    { name: 'stat_date', type: 'Date' }, { name: 'amount', type: 'UInt64' }, { name: 'secret', type: 'String' },
  ]),
};

const serviceServer = createServer((req, res) => {
  queryCount += 1;
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(runResult));
});
await new Promise(resolve => serviceServer.listen(0, '127.0.0.1', resolve));
const serviceAddress = serviceServer.address();
if (!serviceAddress || typeof serviceAddress === 'string') throw new Error('service fixture did not bind');

const modelServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    if (failNextModelCall) {
      failNextModelCall = false;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'synthetic provider failure' }));
      return;
    }
    const body = Buffer.concat(chunks).toString('utf8');
    modelSawSentinel = body.includes(sentinel);
    modelSawAuth = req.headers.authorization === 'Bearer internal-test-key';
    const payload = JSON.parse(body);
    const userContent = payload.messages?.find(message => message.role === 'user')?.content || '{}';
    const internalResult = JSON.parse(userContent);
    const manifest = internalResult.result_manifest || {};
    modelSawLimitEvidence = manifest.truncation_uncertain === true
      && manifest.user_limit_reached === false
      && manifest.user_limit_notice === '当前结果仅代表限定范围，不能用于全量汇总。'
      && manifest.limit_notice === '查询结果达到或超出限制（上限 200 行）';
    res.writeHead(200, { 'content-type': 'application/json' });
    if (payload.tool_choice === 'required') {
      const fileCalls = [
        { id: 'excel', type: 'function', function: { name: 'create_excel', arguments: JSON.stringify({ sheets: [{ columns: ['stat_date', 'amount'] }] }) } },
        { id: 'chart', type: 'function', function: { name: 'create_chart', arguments: JSON.stringify({ type: 'line', label_column: 'stat_date', value_column: 'amount' }) } },
        { id: 'pdf', type: 'function', function: { name: 'create_pdf', arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'amount' }], table_columns: ['stat_date', 'amount'] }) } },
        { id: 'document', type: 'function', function: { name: 'create_document', arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'amount' }], table_columns: ['stat_date', 'amount'] }) } },
      ];
      const analysisCall = { id: 'analysis', type: 'function', function: { name: 'create_analysis', arguments: JSON.stringify({ claims: [{ operation: 'sum', column: 'amount' }] }) } };
      const calls = internalResult.requested_outputs.includes('analysis') ? [analysisCall] : fileCalls;
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: calls } }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: `${modelOutput}\n\n当前结果仅代表限定范围，不能用于全量汇总。` } }] }));
  });
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const modelAddress = modelServer.address();
if (!modelAddress || typeof modelAddress === 'string') throw new Error('model fixture did not bind');
writeFileSync(hostEnvFile, [
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:${modelAddress.port}/v1/chat/completions`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL=internal-test-model',
  'DATA_MCP_RESULT_MODEL_API_KEY=internal-test-key',
  'DATA_MCP_RESULT_BINDING_HMAC_KEY=0123456789abcdef0123456789abcdef',
].join('\n') + '\n', { mode: 0o600 });
writeFileSync(missingModelEnvFile, [
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:${modelAddress.port}/v1/chat/completions`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL_API_KEY=internal-test-key',
  'DATA_MCP_RESULT_BINDING_HMAC_KEY=0123456789abcdef0123456789abcdef',
].join('\n') + '\n', { mode: 0o600 });

const fake = installFakeBotmux(root);
function runPlugin(requests, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, 'dist', 'mcp', 'server.js')], {
      cwd: pluginRoot,
      env: fake.env({
        BOTMUX_SESSION_ID: 'session_result_delivery_test',
        BOTMUX_PLUGIN_HOME: pluginHome,
        DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
        DATA_MCP_RUN_QUERY_ENDPOINT: `http://127.0.0.1:${serviceAddress.port}/agent/run-query`,
        KSHER_AGENT_DATA_MCP_ENV_FILE: hostEnvFile,
        FAKE_BOTMUX_LOG: botmuxLog,
        ...extraEnv,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(`plugin exited ${code}: ${stderr}`));
      else resolve(stdout.trim().split('\n').filter(Boolean).map(JSON.parse));
    });
    child.stdin.end(requests.map((request, index) => JSON.stringify({
      jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: request,
    })).join('\n') + '\n');
  });
}

const caller = {
  requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test',
  requestLarkAppId: 'cli_synthetic', senderType: 'user', turnId: 'om_delivery',
};
const responses = await runPlugin([
  {
    name: 'deliver_query_result_for_user',
    arguments: {
      sql: 'SELECT amount FROM fixture', datasource: 'tchouse-c',
      query_plan_id: 'qplan_internal', requested_outputs: ['analysis'], question: '汇总',
    },
    _meta: { botmuxTrustedCaller: caller },
  },
  {
    name: 'deliver_query_result_for_user',
    arguments: {
      sql: 'SELECT amount FROM fixture', datasource: 'tchouse-c',
      query_plan_id: 'qplan_artifacts',
      requested_outputs: ['excel', 'chart', 'pdf', 'document'],
      question: '生成 Excel、图表、PDF 和文档',
    },
    _meta: { botmuxTrustedCaller: { ...caller, turnId: 'om_excel' } },
  },
  {
    name: 'run_query_for_user',
    arguments: { sql: 'SELECT amount FROM fixture', query_plan_id: 'raw' },
    _meta: { botmuxTrustedCaller: caller },
  },
]);
const byId = new Map(responses.map(response => [response.id, response]));
const toolPayload = response => JSON.parse(response?.result?.content?.[0]?.text || '{}');
const analysisVisible = JSON.stringify(byId.get(1)?.result ?? {});
if (toolPayload(byId.get(1)).status !== 'delivered') throw new Error('analysis was not directly delivered');
for (const forbidden of [sentinel, modelOutput, 'botmuxHostDelivery']) {
  if (analysisVisible.includes(forbidden)) throw new Error(`calling model saw protected value: ${forbidden}`);
}
const excelVisible = JSON.stringify(byId.get(2)?.result ?? {});
if (toolPayload(byId.get(2)).attachmentCount !== 4 || excelVisible.includes('.xlsx') || excelVisible.includes(root)) {
  throw new Error('multi-artifact receipt was unsafe or incomplete');
}
if (!JSON.stringify(byId.get(3)).includes('isolated_delivery_required')) {
  throw new Error('raw query path was not isolated');
}
if (!modelSawSentinel || !modelSawAuth || !modelSawLimitEvidence) {
  throw new Error('internal result model did not receive the protected result, credential, and limit evidence');
}
if (queryCount !== 2) throw new Error(`each delivery must query exactly once; got ${queryCount} queries for 2 deliveries`);
const botmuxRecords = readFileSync(botmuxLog, 'utf8').trim().split('\n').map(JSON.parse);
if (!botmuxRecords.some(row => row.content?.includes('amount（sum）：30'))) {
  throw new Error('source-bound analysis was not sent to Feishu');
}
const fileRecord = botmuxRecords.find(row => row.args[0] === 'send' && row.args.includes('--files'));
if (!fileRecord || fileRecord.args.filter(arg => arg === '--files').length !== 4) {
  throw new Error('Agent artifacts were not sent to Feishu together');
}
if (!botmuxRecords.some(row => row.content?.includes('不能用于全量汇总'))) {
  throw new Error('Excel direct delivery lost the user LIMIT advisory');
}
const stagedPaths = fileRecord.args.flatMap((arg, index) => arg === '--files' ? [fileRecord.args[index + 1]] : []);
if (stagedPaths.some(existsSync)) throw new Error('staged Agent artifact was not removed after delivery');

const rejected = await runPlugin([{
  name: 'deliver_query_result_for_user',
  arguments: {
    sql: 'SELECT amount FROM fixture', query_plan_id: 'rejected', output_mode: 'analysis',
  },
  _meta: { botmuxTrustedCaller: { ...caller, turnId: 'schedule:task:turn', callerSource: 'schedule_creator', taskId: 'task' } },
}]);
if (!JSON.stringify(rejected[0]).includes('direct_reply_identity_rejected')) {
  throw new Error('synthetic scheduled turn was not rejected for direct reply');
}

const transportFailure = await runPlugin([{
  name: 'deliver_query_result_for_user',
  arguments: {
    sql: 'SELECT amount FROM fixture', query_plan_id: 'failed-send', output_mode: 'analysis',
  },
  _meta: { botmuxTrustedCaller: { ...caller, turnId: 'om_failed' } },
}], { FAKE_BOTMUX_FAIL: 'send' });
const failedVisible = JSON.stringify(transportFailure[0].result ?? {});
if (!failedVisible.includes('direct_reply_transport_failed') || failedVisible.includes(modelOutput) || failedVisible.includes(sentinel)) {
  throw new Error('transport failure did not return a fixed, redacted error');
}

failNextModelCall = true;
const agentFailure = await runPlugin([{
  name: 'deliver_query_result_for_user',
  arguments: {
    sql: 'SELECT amount FROM fixture', query_plan_id: 'failed-agent',
    output_mode: 'analysis', question: '触发受控模型故障',
  },
  _meta: { botmuxTrustedCaller: { ...caller, turnId: 'om_agent_failed' } },
}]);
const agentFailureVisible = JSON.stringify(agentFailure[0].result ?? {});
if (!agentFailureVisible.includes('delivered')
  || agentFailureVisible.includes('synthetic provider failure')
  || agentFailureVisible.includes(sentinel)) {
  throw new Error('result Agent failure did not use the safe deterministic fallback');
}

const missingModel = await runPlugin([{
  name: 'deliver_query_result_for_user',
  arguments: {
    sql: 'SELECT amount FROM fixture', query_plan_id: 'missing-model',
    output_mode: 'analysis', question: '验证配置缺失降级',
  },
  _meta: { botmuxTrustedCaller: { ...caller, turnId: 'om_missing_model' } },
}], { KSHER_AGENT_DATA_MCP_ENV_FILE: missingModelEnvFile });
if (!JSON.stringify(missingModel[0].result ?? {}).includes('delivered')) {
  throw new Error('missing result model did not use the safe deterministic fallback');
}
const auditRows = readFileSync(join(pluginHome, 'active-results-v1', 'audit.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(JSON.parse);
if (!auditRows.some(row => row.status === 'deterministic_fallback_used'
  && row.stage === 'result_agent'
  && row.action === 'model_request'
  && row.error_code === 'result_agent_http_503'
  && row.query_id === 'q_internal')) {
  throw new Error('first-turn result Agent failure did not emit actionable safe audit detail');
}
if (!auditRows.some(row => row.status === 'deterministic_fallback_used'
  && row.stage === 'result_agent'
  && row.action === 'model_config'
  && row.error_code === 'result_agent_not_configured'
  && row.query_id === 'q_internal')) {
  throw new Error('missing result model did not emit its exact safe audit detail');
}
const fallbackBotmuxRecords = readFileSync(botmuxLog, 'utf8').trim().split('\n').map(JSON.parse);
if (!fallbackBotmuxRecords.some(row => row.content?.includes('受控查询返回的原始结果')
  && row.content?.includes('CONFIDENTIAL_BUSINESS_ROW_7319'))) {
  throw new Error('safe deterministic fallback was not delivered through the trusted reply path');
}

modelServer.close();
serviceServer.close();
console.log('trusted direct result delivery tests passed');
