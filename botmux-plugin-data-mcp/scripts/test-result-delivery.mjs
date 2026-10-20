import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sentinel = 'CONFIDENTIAL_BUSINESS_ROW_7319';
const pluginHome = mkdtempSync(join(tmpdir(), 'data-mcp-delivery-'));
const hostEnvFile = join(pluginHome, 'host.env');
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
    modelSawLimitEvidence = body.includes('\\"rows_before_limit_at_least\\":1')
      && body.includes('\\"effective_limit\\":200')
      && body.includes('\\"truncation_uncertain\\":true')
      && body.includes('\\"user_limit_reached\\":false')
      && body.includes('\\"limit_injected\\":true')
      && body.includes('\\"limit_capped\\":false');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '受控分析结果：合成记录。' } }] }));
  });
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const address = modelServer.address();
if (!address || typeof address === 'string') throw new Error('model test server did not bind');
writeFileSync(hostEnvFile, [
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:${address.port}/v1/chat/completions`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL=internal-test-model',
  'DATA_MCP_RESULT_MODEL_API_KEY=internal-test-key',
  'DATA_MCP_RESULT_BINDING_HMAC_KEY=0123456789abcdef0123456789abcdef',
].join('\n') + '\n', { mode: 0o600 });

const runResult = {
  status: 'success', query_id: 'q_internal', row_count: 1,
  rows_before_limit_at_least: 1, truncated: false,
  effective_limit: 200, truncation_uncertain: true,
  user_limit_reached: false,
  limit_injected: true, limit_capped: false,
  columns: [{ name: 'amount' }], rows: [{ amount: sentinel }],
};
const child = spawn(process.execPath, [join(pluginRoot, 'dist', 'mcp', 'server.js')], {
  cwd: pluginRoot,
  env: {
    ...process.env,
    BOTMUX_SESSION_ID: 'session_result_delivery_test',
    BOTMUX_PLUGIN_HOME: pluginHome,
    DATA_MCP_ISOLATED_DELIVERY_REQUIRED: '1',
    DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
    DATA_MCP_RUN_QUERY_ENDPOINT: `data:application/json,${encodeURIComponent(JSON.stringify(runResult))}`,
    KSHER_AGENT_DATA_MCP_ENV_FILE: hostEnvFile,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdin.end([JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: {
    name: 'deliver_query_result_for_user',
    arguments: {
      sql: 'SELECT amount FROM fixture', datasource: 'tchouse-c',
      query_plan_id: 'qplan_internal', output_mode: 'analysis', question: '汇总',
    },
    _meta: { botmuxTrustedCaller: {
      requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test',
      requestLarkAppId: 'cli_test', senderType: 'user', turnId: 'om_test',
      hostCapabilities: ['result_delivery_v1'],
    } },
  },
}), JSON.stringify({
  jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: {
    name: 'run_query_for_user',
    arguments: { sql: 'SELECT amount FROM fixture', datasource: 'tchouse-c', query_plan_id: 'qplan_raw' },
    _meta: { botmuxTrustedCaller: {
      requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test',
      requestLarkAppId: 'cli_test', senderType: 'user', turnId: 'om_test',
    } },
  },
})].join('\n') + '\n');
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
});
modelServer.close();
if (exitCode !== 0) throw new Error(`delivery fixture failed: ${stderr}`);
const responses = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const response = responses.find(item => item.id === 1);
const visible = JSON.stringify(response.result?.content ?? []);
if (visible.includes(sentinel)) throw new Error('business row leaked into calling model content');
if (response.result?._meta?.botmuxHostDelivery?.markdown !== '受控分析结果：合成记录。') {
  throw new Error('internal model analysis was not wrapped for trusted host delivery');
}
if (!modelSawSentinel || !modelSawAuth || !modelSawLimitEvidence) {
  throw new Error('internal result model did not receive the protected result and credential');
}
const rawResponse = responses.find(item => item.id === 2);
if (!rawResponse?.result?.content?.[0]?.text?.includes('isolated_delivery_required')) {
  throw new Error('raw result tool remained available in isolated-delivery mode');
}

const sourceWorkbook = join(pluginHome, 'source.xlsx');
writeFileSync(sourceWorkbook, 'xlsx-fixture');
const excelResult = {
  status: 'success', query_id: 'q_export',
  file: { path: sourceWorkbook, filename: '业务结果.xlsx', row_count: 3 },
};
const excelChild = spawn(process.execPath, [join(pluginRoot, 'dist', 'mcp', 'server.js')], {
  cwd: pluginRoot,
  env: {
    ...process.env,
    BOTMUX_SESSION_ID: 'session_result_delivery_excel_test',
    BOTMUX_PLUGIN_HOME: pluginHome,
    DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
    DATA_MCP_EXPORT_QUERY_ENDPOINT: `data:application/json,${encodeURIComponent(JSON.stringify(excelResult))}`,
    KSHER_AGENT_DATA_MCP_ENV_FILE: hostEnvFile,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let excelStdout = '';
let excelStderr = '';
excelChild.stdout.setEncoding('utf8');
excelChild.stderr.setEncoding('utf8');
excelChild.stdout.on('data', chunk => { excelStdout += chunk; });
excelChild.stderr.on('data', chunk => { excelStderr += chunk; });
excelChild.stdin.end([
  JSON.stringify({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: {
      name: 'deliver_query_result_for_user',
      arguments: {
        sql: 'SELECT amount FROM fixture', datasource: 'tchouse-c',
        query_plan_id: 'qplan_export', output_mode: 'excel', filename: '业务结果',
      },
      _meta: { botmuxTrustedCaller: {
        requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test',
        requestLarkAppId: 'cli_test', senderType: 'user', turnId: 'om_test',
        hostCapabilities: ['result_delivery_v1'],
      } },
    },
  }),
  JSON.stringify({
    jsonrpc: '2.0', id: 31, method: 'tools/call',
    params: {
      name: 'export_query_to_excel_file',
      arguments: { sql: 'SELECT amount FROM fixture', query_plan_id: 'qplan_raw_export' },
      _meta: { botmuxTrustedCaller: {
        requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test',
        requestLarkAppId: 'cli_test', senderType: 'user', turnId: 'om_test',
      } },
    },
  }),
].join('\n') + '\n');
const excelExitCode = await new Promise((resolve, reject) => {
  excelChild.once('error', reject);
  excelChild.once('close', resolve);
});
if (excelExitCode !== 0) throw new Error(`Excel delivery fixture failed: ${excelStderr}`);
const excelResponses = excelStdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const excelResponse = excelResponses.find(item => item.id === 3);
const deliveredPath = excelResponse.result?._meta?.botmuxHostDelivery?.files?.[0]?.path;
if (!deliveredPath || !deliveredPath.startsWith(join(pluginHome, 'outbound'))) {
  throw new Error('Excel artifact was not staged in the plugin outbound directory');
}
if (existsSync(deliveredPath)) {
  throw new Error('Excel artifact survived Data MCP process shutdown');
}
const missingIsolationConfig = JSON.stringify(excelResponses.find(item => item.id === 31)?.result ?? {});
if (!missingIsolationConfig.includes('isolated_delivery_required')) {
  throw new Error('raw export path did not fail closed when isolation configuration was absent');
}

// A long-lived plugin must remove a staged artifact when its process is
// interrupted before Botmux consumes the envelope.
const interruptChild = spawn(process.execPath, [join(pluginRoot, 'dist', 'mcp', 'server.js')], {
  cwd: pluginRoot,
  env: {
    ...process.env,
    BOTMUX_SESSION_ID: 'session_result_delivery_interrupt_test',
    BOTMUX_PLUGIN_HOME: pluginHome,
    DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
    DATA_MCP_EXPORT_QUERY_ENDPOINT: `data:application/json,${encodeURIComponent(JSON.stringify(excelResult))}`,
    KSHER_AGENT_DATA_MCP_ENV_FILE: hostEnvFile,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const interruptedResponse = new Promise((resolve, reject) => {
  let buffered = '';
  interruptChild.once('error', reject);
  interruptChild.stdout.setEncoding('utf8');
  interruptChild.stdout.on('data', chunk => {
    buffered += chunk;
    const newline = buffered.indexOf('\n');
    if (newline < 0) return;
    try { resolve(JSON.parse(buffered.slice(0, newline))); } catch (error) { reject(error); }
  });
});
interruptChild.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0', id: 7, method: 'tools/call',
  params: {
    name: 'deliver_query_result_for_user',
    arguments: {
      sql: 'SELECT amount FROM fixture', datasource: 'tchouse-c',
      query_plan_id: 'qplan_interrupt', output_mode: 'excel', filename: '中断测试',
    },
    _meta: { botmuxTrustedCaller: {
      requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test',
      requestLarkAppId: 'cli_test', senderType: 'user', turnId: 'om_test',
      hostCapabilities: ['result_delivery_v1'],
    } },
  },
})}\n`);
const interruptedPath = (await interruptedResponse).result?._meta?.botmuxHostDelivery?.files?.[0]?.path;
if (!interruptedPath || !existsSync(interruptedPath)) {
  throw new Error('interruption fixture did not stage its outbound artifact');
}
interruptChild.kill('SIGTERM');
await new Promise((resolve, reject) => {
  interruptChild.once('error', reject);
  interruptChild.once('close', resolve);
});
if (existsSync(interruptedPath)) throw new Error('interrupted Data MCP process left an outbound artifact');

const failureSentinel = 'CONFIDENTIAL_PARTIAL_ROW_9917';
const failedUpstream = {
  status: 'error',
  message: 'upstream failed',
  rows: [{ secret: failureSentinel }],
  columns: [{ name: failureSentinel }],
  file: { path: `/tmp/${failureSentinel}.xlsx` },
  raw_response: failureSentinel,
  detail: failureSentinel,
};
const failedChild = spawn(process.execPath, [join(pluginRoot, 'dist', 'mcp', 'server.js')], {
  cwd: pluginRoot,
  env: {
    ...process.env,
    BOTMUX_SESSION_ID: 'session_result_delivery_failure_test',
    BOTMUX_PLUGIN_HOME: pluginHome,
    // An attempted opt-out must not reopen the raw result path.
    DATA_MCP_ISOLATED_DELIVERY_REQUIRED: '0',
    DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
    DATA_MCP_RUN_QUERY_ENDPOINT: `data:application/json,${encodeURIComponent(JSON.stringify(failedUpstream))}`,
    DATA_MCP_EXPORT_QUERY_ENDPOINT: `data:application/json,${encodeURIComponent(JSON.stringify(failedUpstream))}`,
    KSHER_AGENT_DATA_MCP_ENV_FILE: hostEnvFile,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let failedStdout = '';
let failedStderr = '';
failedChild.stdout.setEncoding('utf8');
failedChild.stderr.setEncoding('utf8');
failedChild.stdout.on('data', chunk => { failedStdout += chunk; });
failedChild.stderr.on('data', chunk => { failedStderr += chunk; });
const trustedMeta = { botmuxTrustedCaller: {
  requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test',
  requestLarkAppId: 'cli_test', senderType: 'user', turnId: 'om_test',
  hostCapabilities: ['result_delivery_v1'],
} };
failedChild.stdin.end([
  JSON.stringify({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: {
      name: 'deliver_query_result_for_user',
      arguments: { sql: 'SELECT secret', query_plan_id: 'qplan_failed_run', output_mode: 'analysis' },
      _meta: trustedMeta,
    },
  }),
  JSON.stringify({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: {
      name: 'deliver_query_result_for_user',
      arguments: { sql: 'SELECT secret', query_plan_id: 'qplan_failed_export', output_mode: 'excel' },
      _meta: trustedMeta,
    },
  }),
  JSON.stringify({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: {
      name: 'run_query_for_user',
      arguments: { sql: 'SELECT secret', query_plan_id: 'qplan_raw_disabled' },
      _meta: trustedMeta,
    },
  }),
].join('\n') + '\n');
const failedExitCode = await new Promise((resolve, reject) => {
  failedChild.once('error', reject);
  failedChild.once('close', resolve);
});
if (failedExitCode !== 0) throw new Error(`failure fixture failed: ${failedStderr}`);
const failedResponses = failedStdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
for (const id of [4, 5]) {
  const text = JSON.stringify(failedResponses.find(item => item.id === id)?.result ?? {});
  if (text.includes(failureSentinel)) throw new Error(`failure payload leaked for request ${id}`);
  if (!text.includes('isolated_data_operation_failed')) throw new Error(`failure was not sanitized for request ${id}`);
}
const attemptedOptOut = JSON.stringify(failedResponses.find(item => item.id === 6)?.result ?? {});
if (!attemptedOptOut.includes('isolated_delivery_required') || attemptedOptOut.includes(failureSentinel)) {
  throw new Error('raw result path did not fail closed when isolation opt-out was attempted');
}

async function runThrowingDeliveryFixture(id, env, arguments_) {
  const fixture = spawn(process.execPath, [join(pluginRoot, 'dist', 'mcp', 'server.js')], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      BOTMUX_SESSION_ID: `session_throw_${id}`,
      BOTMUX_PLUGIN_HOME: pluginHome,
      DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
      KSHER_AGENT_DATA_MCP_ENV_FILE: hostEnvFile,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let fixtureStdout = '';
  let fixtureStderr = '';
  fixture.stdout.setEncoding('utf8');
  fixture.stderr.setEncoding('utf8');
  fixture.stdout.on('data', chunk => { fixtureStdout += chunk; });
  fixture.stderr.on('data', chunk => { fixtureStderr += chunk; });
  fixture.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: {
      name: 'deliver_query_result_for_user',
      arguments: arguments_,
      _meta: trustedMeta,
    },
  })}\n`);
  const code = await new Promise((resolve, reject) => {
    fixture.once('error', reject);
    fixture.once('close', resolve);
  });
  if (code !== 0) throw new Error(`throwing fixture ${id} failed: ${fixtureStderr}`);
  return fixtureStdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))[0];
}

const endpointSentinel = 'CONFIDENTIAL_MODEL_ENDPOINT_4471';
const refusedModelEnv = join(pluginHome, 'refused-model.env');
writeFileSync(refusedModelEnv, [
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:1/${endpointSentinel}`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL=internal-test-model',
  'DATA_MCP_RESULT_BINDING_HMAC_KEY=0123456789abcdef0123456789abcdef',
].join('\n') + '\n', { mode: 0o600 });
const refusedModel = await runThrowingDeliveryFixture(8, {
  KSHER_AGENT_DATA_MCP_ENV_FILE: refusedModelEnv,
  DATA_MCP_RUN_QUERY_ENDPOINT: `data:application/json,${encodeURIComponent(JSON.stringify(runResult))}`,
}, { sql: 'SELECT amount', query_plan_id: 'qplan_refused_model', output_mode: 'analysis' });
const refusedModelText = JSON.stringify(refusedModel);
if (!refusedModelText.includes('isolated_data_operation_failed') || refusedModelText.includes(endpointSentinel)) {
  throw new Error('result-model transport exception was not sanitized');
}

const pathSentinel = 'CONFIDENTIAL_EXPORT_PATH_5529';
const missingFileResult = {
  status: 'success', query_id: 'q_missing_file',
  file: { path: `/tmp/${pathSentinel}.xlsx`, filename: 'result.xlsx', row_count: 1 },
};
const missingFile = await runThrowingDeliveryFixture(9, {
  DATA_MCP_EXPORT_QUERY_ENDPOINT: `data:application/json,${encodeURIComponent(JSON.stringify(missingFileResult))}`,
}, { sql: 'SELECT amount', query_plan_id: 'qplan_missing_file', output_mode: 'excel' });
const missingFileText = JSON.stringify(missingFile);
if (!missingFileText.includes('isolated_data_operation_failed') || missingFileText.includes(pathSentinel)) {
  throw new Error('Excel filesystem exception was not sanitized');
}
process.stdout.write('isolated result delivery validation passed\n');
