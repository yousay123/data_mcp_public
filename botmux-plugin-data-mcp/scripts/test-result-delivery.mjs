import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeBotmux } from './test-botmux-fixture.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'data-mcp-delivery-'));
const pluginHome = join(root, 'plugin-home');
const hostEnvFile = join(root, 'host.env');
const botmuxLog = join(root, 'botmux.jsonl');
const sentinel = 'CONFIDENTIAL_BUSINESS_ROW_7319';
const modelOutput = '受控分析结果：合成记录。';
let modelSawSentinel = false;
let modelSawAuth = false;
let modelSawLimitEvidence = false;

const modelServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    modelSawSentinel = body.includes(sentinel);
    modelSawAuth = req.headers.authorization === 'Bearer internal-test-key';
    modelSawLimitEvidence = body.includes('\"rows_before_limit_at_least\":1')
      && body.includes('\"effective_limit\":200')
      && body.includes('\"truncation_uncertain\":true')
      && body.includes('\"user_limit_reached\":false')
      && body.includes('\"user_limit_notice\":\"当前结果仅代表限定范围，不能用于全量汇总。\"')
      && body.includes('\"limit_notice\":\"查询结果达到或超出限制（上限 200 行）\"')
      && body.includes('\"limit_injected\":true')
      && body.includes('\"limit_capped\":false');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: modelOutput } }] }));
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

const fake = installFakeBotmux(root);
const runResult = {
  status: 'success', query_id: 'q_internal', row_count: 1,
  rows_before_limit_at_least: 1, truncated: false,
  effective_limit: 200, truncation_uncertain: true,
  user_limit_reached: false,
  user_limit_notice: '当前结果仅代表限定范围，不能用于全量汇总。',
  limit_notice: '查询结果达到或超出限制（上限 200 行）',
  limit_injected: true, limit_capped: false,
  columns: [{ name: 'amount' }], rows: [{ amount: sentinel }],
};
const sourceWorkbook = join(root, 'source.xlsx');
writeFileSync(sourceWorkbook, 'SYNTHETIC_XLSX_BYTES');
const exportResult = {
  status: 'success', query_id: 'q_export',
  user_limit_notice: '当前结果仅代表限定范围，不能用于全量汇总。',
  file: { path: sourceWorkbook, filename: '业务结果.xlsx', row_count: 3 },
};

function runPlugin(requests, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, 'dist', 'mcp', 'server.js')], {
      cwd: pluginRoot,
      env: fake.env({
        BOTMUX_SESSION_ID: 'session_result_delivery_test',
        BOTMUX_PLUGIN_HOME: pluginHome,
        DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
        DATA_MCP_RUN_QUERY_ENDPOINT: `data:application/json,${encodeURIComponent(JSON.stringify(runResult))}`,
        DATA_MCP_EXPORT_QUERY_ENDPOINT: `data:application/json,${encodeURIComponent(JSON.stringify(exportResult))}`,
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
      query_plan_id: 'qplan_internal', output_mode: 'analysis', question: '汇总',
    },
    _meta: { botmuxTrustedCaller: caller },
  },
  {
    name: 'deliver_query_result_for_user',
    arguments: {
      sql: 'SELECT amount FROM fixture', datasource: 'tchouse-c',
      query_plan_id: 'qplan_export', output_mode: 'excel', filename: '业务结果',
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
if (toolPayload(byId.get(2)).attachmentCount !== 1 || excelVisible.includes('.xlsx') || excelVisible.includes(root)) {
  throw new Error('Excel receipt was unsafe or incomplete');
}
if (!JSON.stringify(byId.get(3)).includes('isolated_delivery_required')) {
  throw new Error('raw query path was not isolated');
}
if (!modelSawSentinel || !modelSawAuth || !modelSawLimitEvidence) {
  throw new Error('internal result model did not receive the protected result, credential, and limit evidence');
}
const botmuxRecords = readFileSync(botmuxLog, 'utf8').trim().split('\n').map(JSON.parse);
if (!botmuxRecords.some(row => row.content?.includes(modelOutput))) {
  throw new Error('analysis text was not sent to Feishu');
}
const fileRecord = botmuxRecords.find(row => row.args[0] === 'send' && row.args.includes('--files'));
if (!fileRecord) throw new Error('Excel attachment was not sent to Feishu');
if (!fileRecord.content?.includes('不能用于全量汇总')) {
  throw new Error('Excel direct delivery lost the user LIMIT advisory');
}
const stagedPath = fileRecord.args[fileRecord.args.indexOf('--files') + 1];
if (existsSync(stagedPath)) throw new Error('staged Excel artifact was not removed after delivery');

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

modelServer.close();
console.log('trusted direct result delivery tests passed');
