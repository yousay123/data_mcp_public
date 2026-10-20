import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPrivateModelAddress,
  isProxyFakeIpAddress,
  parseResultModelTestException,
  pinnedModelLookup,
  resolvePrivateModelAddress,
} from '../src/mcp/private-network.js';
import { ResultStore } from '../src/mcp/result-store.js';
import { installFakeBotmux } from './test-botmux-fixture.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'data-mcp-followup-'));
const pluginHome = join(root, 'plugin-home');
const fakeBotmux = installFakeBotmux(root);
const botmuxLog = join(root, 'botmux.jsonl');
const rowSentinel = 'SYNTHETIC_ROW_SENTINEL_4821';
const modelSentinel = 'SYNTHETIC_MODEL_SENTINEL_7734';
const modelOutput = `${modelSentinel}:${rowSentinel}`;
const bindingSecret = '0123456789abcdef0123456789abcdef';
let planCounter = 0;
let modelCalls = 0;
const modelPayloads = [];
let exportedFilename;
let mutateActiveResultDuringModelCall;

function jsonResponse(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

const service = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (req.url === '/validate') {
      planCounter += 1;
      jsonResponse(res, {
        status: 'success', datasource: 'tchouse-c', normalized_sql: body.sql,
        tables: ['synthetic.events'], columns: ['synthetic_value'],
        query_plan_id: `synthetic-plan-${planCounter}`,
      });
      return;
    }
    if (req.url === '/run') {
      jsonResponse(res, {
        status: 'success', datasource: 'tchouse-c', row_count: 1,
        rows_before_limit_at_least: 1, truncated: false,
        effective_limit: 200, truncation_uncertain: true,
        user_limit_reached: false,
        user_limit_notice: '当前结果仅代表限定范围，不能用于全量汇总。',
        limit_notice: '查询结果达到或超出限制（上限 200 行）',
        limit_injected: true, limit_capped: false,
        columns: [{ name: 'synthetic_value', type: 'String' }],
        rows: [{ synthetic_value: rowSentinel }],
      });
      return;
    }
    if (req.url === '/export') {
      exportedFilename = body.filename;
      const path = join(root, 'synthetic.xlsx');
      writeFileSync(path, 'synthetic workbook', { mode: 0o600 });
      jsonResponse(res, {
        status: 'success', query_id: 'synthetic-export',
        file: { path, filename: body.filename, row_count: 1 },
      });
      return;
    }
    jsonResponse(res, { status: 'error' }, 404);
  });
});
await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
const serviceAddress = service.address();
if (!serviceAddress || typeof serviceAddress === 'string') throw new Error('service fixture did not bind');

const model = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!JSON.stringify(body).includes(rowSentinel)) throw new Error('internal model did not receive stored synthetic row');
    if (Object.hasOwn(body, 'tools') || Object.hasOwn(body, 'tool_choice')) {
      throw new Error('internal model request must not expose tools');
    }
    if (JSON.stringify(body).includes('CAS_REPLACE_SYNTHETIC')) mutateActiveResultDuringModelCall?.();
    modelPayloads.push(body);
    modelCalls += 1;
    jsonResponse(res, { choices: [{ message: { content: modelOutput } }] });
  });
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === 'string') throw new Error('model fixture did not bind');

const hostEnvFile = join(root, 'host.env');
writeFileSync(hostEnvFile, [
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:${modelAddress.port}/v1/chat/completions`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL=internal-test-model',
  `DATA_MCP_RESULT_BINDING_HMAC_KEY=${bindingSecret}`,
].join('\n') + '\n', { mode: 0o600 });

function spawnPlugin(sessionId, envFile = hostEnvFile) {
  const child = spawn(process.execPath, [join(pluginRoot, 'dist', 'mcp', 'server.js')], {
    cwd: pluginRoot,
    env: fakeBotmux.env({
      BOTMUX_SESSION_ID: sessionId,
      BOTMUX_PLUGIN_HOME: pluginHome,
      DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
      DATA_MCP_VALIDATE_SQL_ENDPOINT: `http://127.0.0.1:${serviceAddress.port}/validate`,
      DATA_MCP_RUN_QUERY_ENDPOINT: `http://127.0.0.1:${serviceAddress.port}/run`,
      DATA_MCP_EXPORT_QUERY_ENDPOINT: `http://127.0.0.1:${serviceAddress.port}/export`,
      KSHER_AGENT_DATA_MCP_ENV_FILE: envFile,
      FAKE_BOTMUX_LOG: botmuxLog,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffered = '';
  let stderr = '';
  const pending = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });
  let nextId = 1;
  return {
    child,
    call(name, arguments_, caller) {
      const id = nextId++;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name, arguments: arguments_, _meta: { botmuxTrustedCaller: caller } },
      })}\n`);
      return promise;
    },
    list() {
      const id = nextId++;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })}\n`);
      return promise;
    },
    async close() {
      child.stdin.end();
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (code !== 0) throw new Error(`plugin exited ${code}: ${stderr}`);
    },
    stderr() { return stderr; },
  };
}

function toolPayload(response) {
  return JSON.parse(response?.result?.content?.[0]?.text || '{}');
}

const callerA = {
  requestUserOpenId: 'ou_synthetic_a', requestUserUnionId: 'on_synthetic_a',
  requestLarkAppId: 'cli_synthetic', senderType: 'user', turnId: 'om_initial',
  hostCapabilities: ['result_delivery_v1'],
};
const plugin = spawnPlugin('session-synthetic-a');
const listed = (await plugin.list()).result?.tools ?? [];
if (!listed.some(tool => tool.name === 'continue_query_result_for_user')) throw new Error('follow-up tool missing');
if (listed.some(tool => ['frozen_query_raw', 'execute_frozen_query'].includes(tool.name))) {
  throw new Error('raw-result tool remained model-visible');
}
const retiredRawCall = await plugin.call('frozen_query_raw', { payload: { sql: 'SELECT synthetic_value' } }, callerA);
const retiredRawText = JSON.stringify(retiredRawCall);
if (!retiredRawText.includes('unknown_tool') || retiredRawText.includes(rowSentinel)) {
  throw new Error('raw-result invocation route remained callable');
}
const followupSchema = listed.find(tool => tool.name === 'continue_query_result_for_user')?.inputSchema;
const schemaText = JSON.stringify(followupSchema);
for (const forbidden of ['result_id', 'session_id', 'union_id', 'app_id', 'identity']) {
  if (schemaText.includes(forbidden)) throw new Error(`follow-up schema exposes ${forbidden}`);
}

const initial = await plugin.call('deliver_query_result_for_user', {
  sql: 'SELECT synthetic_value FROM synthetic.events', datasource: 'tchouse-c',
  query_plan_id: 'synthetic-initial-plan', output_mode: 'analysis', question: 'initial',
}, callerA);
const initialVisible = JSON.stringify(initial.result?.content ?? []);
if (initialVisible.includes(rowSentinel) || initialVisible.includes(modelSentinel)) throw new Error('initial result leaked');
if (toolPayload(initial).status !== 'delivered') throw new Error('initial direct delivery missing');

const followupCaller = { ...callerA, turnId: 'om_followup' };
const followup = await plugin.call('continue_query_result_for_user', {
  question: 'continue from the active synthetic result', output_mode: 'analysis',
  result_id: 'model-forged-result', requestUserUnionId: 'on_forged',
}, followupCaller);
const followupVisible = JSON.stringify(followup.result?.content ?? []);
if (followupVisible.includes(rowSentinel) || followupVisible.includes(modelSentinel)) throw new Error('follow-up result leaked');
if (toolPayload(followup).status !== 'delivered') throw new Error('follow-up direct delivery missing');
const callsAfterFollowup = modelCalls;

const repeated = await plugin.call('continue_query_result_for_user', { question: 'repeat' }, followupCaller);
if (!JSON.stringify(repeated).includes('rate_limited') || modelCalls !== callsAfterFollowup) {
  throw new Error('per-turn follow-up limit failed');
}

const liveStore = new ResultStore({ pluginHome, secret: bindingSecret });
const liveIdentity = {
  unionId: callerA.requestUserUnionId,
  appId: callerA.requestLarkAppId,
  sessionId: 'session-synthetic-a',
};
mutateActiveResultDuringModelCall = () => {
  const current = liveStore.read(liveIdentity);
  if (current.status !== 'active') throw new Error('CAS fixture could not find active result');
  liveStore.put(liveIdentity, current.record.payload);
};
const staleFollowup = await plugin.call('continue_query_result_for_user', {
  question: 'CAS_REPLACE_SYNTHETIC', output_mode: 'analysis',
}, { ...callerA, turnId: 'om_cas_replace' });
mutateActiveResultDuringModelCall = undefined;
if (!JSON.stringify(staleFollowup).includes('delivery_failed')
  || staleFollowup.result?._meta?.botmuxHostDelivery) {
  throw new Error('result replacement during follow-up did not fail closed');
}

const callerB = { ...callerA, requestUserUnionId: 'on_synthetic_b', turnId: 'om_user_b' };
const crossUser = await plugin.call('continue_query_result_for_user', { question: 'cross user' }, callerB);
if (!JSON.stringify(crossUser).includes('no_active_result')) throw new Error('cross-user binding failed');
const crossApp = await plugin.call('continue_query_result_for_user', { question: 'cross app' }, {
  ...callerA, requestLarkAppId: 'cli_other', turnId: 'om_app',
});
if (!JSON.stringify(crossApp).includes('no_active_result')) throw new Error('cross-app binding failed');
const botCaller = await plugin.call('continue_query_result_for_user', { question: 'bot caller' }, {
  ...callerA, senderType: 'bot', turnId: 'om_bot',
});
if (!JSON.stringify(botCaller).includes('identity_rejected')) throw new Error('bot follow-up was not rejected');

const excel = await plugin.call('continue_query_result_for_user', {
  question: 'export the active result', output_mode: 'excel', filename: '../..\\\u0001synthetic.csv',
}, { ...callerA, turnId: 'om_excel' });
const excelVisible = JSON.stringify(excel.result?.content ?? []);
if (excelVisible.includes('synthetic.csv') || excelVisible.includes('.xlsx') || excelVisible.includes(root)) {
  throw new Error('Excel path or filename leaked into model-visible content');
}
if (exportedFilename !== 'synthetic.csv.xlsx') throw new Error(`unsafe filename was not normalized: ${exportedFilename}`);

const auditText = readFileSync(join(pluginHome, 'active-results-v1', 'audit.jsonl'), 'utf8');
if (auditText.includes(rowSentinel) || auditText.includes(modelSentinel)
  || auditText.includes('continue from the active synthetic result')) {
  throw new Error('audit log contains result data, internal-model output, or raw question text');
}
if (plugin.stderr().includes(rowSentinel) || plugin.stderr().includes(modelSentinel)) {
  throw new Error('plugin stderr contains result data or internal-model output');
}
if (modelPayloads.length < 2) throw new Error('internal model was not called for initial and follow-up analysis');
const followupModelPayload = JSON.stringify(modelPayloads[1]);
for (const expected of [
  '\\"rows_before_limit_at_least\\":1',
  '\\"effective_limit\\":200',
  '\\"truncation_uncertain\\":true',
  '\\"user_limit_reached\\":false',
  '\\"user_limit_notice\\":\\"当前结果仅代表限定范围，不能用于全量汇总。\\"',
  '\\"limit_notice\\":\\"查询结果达到或超出限制（上限 200 行）\\"',
  '\\"limit_injected\\":true',
  '\\"limit_capped\\":false',
]) {
  if (!followupModelPayload.includes(expected)) {
    throw new Error(`stored follow-up result lost limit evidence: ${expected}`);
  }
}

await plugin.close();

const lowQuotaFile = join(root, 'low-quota.env');
writeFileSync(lowQuotaFile, [
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:${modelAddress.port}/v1/chat/completions`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL=internal-test-model',
  `DATA_MCP_RESULT_BINDING_HMAC_KEY=${bindingSecret}`,
  'DATA_MCP_RESULT_MAX_BYTES=256',
].join('\n') + '\n', { mode: 0o600 });
const lowQuota = spawnPlugin('session-synthetic-a', lowQuotaFile);
const lowQuotaInitial = await lowQuota.call('deliver_query_result_for_user', {
  sql: 'SELECT synthetic_value FROM synthetic.events', datasource: 'tchouse-c',
  query_plan_id: 'synthetic-low-quota-plan', output_mode: 'analysis', question: 'low quota first turn',
}, { ...callerA, turnId: 'om_low_quota_initial' });
if (toolPayload(lowQuotaInitial).status !== 'delivered') {
  throw new Error('result-store quota failure broke first-turn delivery');
}
const callsAfterLowQuotaInitial = modelCalls;
const lowQuotaFollowup = await lowQuota.call('continue_query_result_for_user', {
  question: 'must not use the previous active result',
}, { ...callerA, turnId: 'om_low_quota_followup' });
if (!JSON.stringify(lowQuotaFollowup).includes('no_active_result')
  || modelCalls !== callsAfterLowQuotaInitial) {
  throw new Error('result-store quota failure left a stale active result');
}
await lowQuota.close();

const otherSession = spawnPlugin('session-synthetic-other');
const crossSession = await otherSession.call('continue_query_result_for_user', { question: 'cross session' }, {
  ...callerA, turnId: 'om_other_session',
});
if (!JSON.stringify(crossSession).includes('no_active_result')) throw new Error('cross-session binding failed');
await otherSession.close();

const missingKeyFile = join(root, 'missing-key.env');
writeFileSync(missingKeyFile, [
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:${modelAddress.port}/v1/chat/completions`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL=internal-test-model',
].join('\n') + '\n', { mode: 0o600 });
const missingKey = spawnPlugin('session-missing-key', missingKeyFile);
const missingKeyInitial = await missingKey.call('deliver_query_result_for_user', {
  sql: 'SELECT synthetic_value FROM synthetic.events', datasource: 'tchouse-c',
  query_plan_id: 'synthetic-missing-key-plan', output_mode: 'analysis', question: 'missing key first turn',
}, { ...callerA, turnId: 'om_missing_key_initial' });
if (toolPayload(missingKeyInitial).status !== 'delivered') {
  throw new Error('missing result-store HMAC key broke first-turn delivery');
}
const missingKeyResponse = await missingKey.call('continue_query_result_for_user', { question: 'missing key' }, {
  ...callerA, turnId: 'om_missing_key',
});
if (!JSON.stringify(missingKeyResponse).includes('identity_rejected')) throw new Error('missing HMAC key did not fail closed');
await missingKey.close();

const storeHome = join(root, 'store-unit');
const store = new ResultStore({
  pluginHome: storeHome,
  secret: bindingSecret,
  config: { idleTtlMs: 10, absoluteTtlMs: 100, maxResultBytes: 4096, maxOwnerBytes: 8192, maxTotalBytes: 16384 },
});
const identity = { unionId: 'on_unit', appId: 'cli_unit', sessionId: 'session_unit' };
const first = store.put(identity, { result: { rows: [{ value: rowSentinel }] } }, 100);
const mode = statSync(store.recordPath(first.bindingKey)).mode & 0o777;
if (mode !== 0o600) throw new Error(`result file mode was ${mode.toString(8)}`);
if (!store.reserveTurn(identity, 'turn-unit', 100) || store.reserveTurn(identity, 'turn-unit', 100)) {
  throw new Error('turn reservation was not one-shot');
}
const replacement = store.put(identity, { result: { rows: [] } }, 101);
if (replacement.createdAt !== 101 || replacement.absoluteExpiresAt !== 201) {
  throw new Error('new query result inherited the previous absolute TTL');
}
let casFailed = false;
try { store.assertVersion(identity, first.version, 101); } catch { casFailed = true; }
if (!casFailed) throw new Error('stale result version did not fail closed');
if (store.read(identity, 112).status !== 'expired') throw new Error('idle expiry failed');
if (store.put(identity, { result: { rows: [] } }, 113).version !== 1) {
  throw new Error('expired result was not replaced as a fresh active result');
}

for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1', '::1', 'fd00::1']) {
  if (!isPrivateModelAddress(address)) throw new Error(`private model address was rejected: ${address}`);
}
for (const address of ['198.18.0.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '::ffff:8.8.8.8', '2001:4860:4860::8888']) {
  if (isPrivateModelAddress(address)) throw new Error(`non-private model address was accepted: ${address}`);
}
for (const address of ['198.18.0.1', '198.19.255.254']) {
  if (!isProxyFakeIpAddress(address)) throw new Error(`proxy fake IP was not recognized: ${address}`);
}
const privateResolution = await resolvePrivateModelAddress('synthetic.internal', async () => [
  { address: '10.2.3.4', family: 4 },
  { address: 'fd00::2', family: 6 },
]);
if (privateResolution.address !== '10.2.3.4') throw new Error('private DNS resolution did not return a pinned address');
const pinnedLookup = pinnedModelLookup('10.2.3.4', 4);
const allLookupResult = await new Promise((resolve, reject) => {
  pinnedLookup('synthetic.internal', { all: true }, (error, addresses) => {
    if (error) reject(error);
    else resolve(addresses);
  });
});
if (!Array.isArray(allLookupResult)
  || allLookupResult.length !== 1
  || allLookupResult[0].address !== '10.2.3.4'
  || allLookupResult[0].family !== 4) {
  throw new Error('pinned model lookup did not honor the Node all=true callback contract');
}
const singleLookupResult = await new Promise((resolve, reject) => {
  pinnedLookup('synthetic.internal', {}, (error, address, family) => {
    if (error) reject(error);
    else resolve({ address, family });
  });
});
if (singleLookupResult.address !== '10.2.3.4' || singleLookupResult.family !== 4) {
  throw new Error('pinned model lookup did not honor the single-address callback contract');
}
const pinnedHttpServer = createServer((_req, res) => jsonResponse(res, { ok: true }));
await new Promise(resolve => pinnedHttpServer.listen(0, '127.0.0.1', resolve));
try {
  const address = pinnedHttpServer.address();
  if (!address || typeof address === 'string') throw new Error('pinned HTTP test server did not bind');
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: 'synthetic.internal',
      port: address.port,
      path: '/',
      lookup: pinnedModelLookup('127.0.0.1', 4),
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end();
  });
  if (response.statusCode !== 200 || JSON.parse(response.body).ok !== true) {
    throw new Error('pinned model lookup failed in a real HTTP request');
  }
} finally {
  await new Promise((resolve, reject) => pinnedHttpServer.close(error => error ? reject(error) : resolve()));
}
for (const answers of [
  [{ address: '198.18.0.1', family: 4 }],
  [{ address: '10.2.3.4', family: 4 }, { address: '8.8.8.8', family: 4 }],
  [],
]) {
  let rejected = false;
  try { await resolvePrivateModelAddress('synthetic.internal', async () => answers); }
  catch { rejected = true; }
  if (!rejected) throw new Error(`unsafe DNS answers were accepted: ${JSON.stringify(answers)}`);
}

const exceptionHost = 'synthetic-external.example';
const exceptionAddress = '203.0.113.10';
const exceptionValue = `host=${exceptionHost};ip=${exceptionAddress};expires=2099-12-31`;
let exceptionAuditCalls = 0;
const exceptionResolution = await resolvePrivateModelAddress(exceptionHost, async () => [
  { address: exceptionAddress, family: 4 },
], {
  testException: exceptionValue,
  now: Date.UTC(2099, 10, 30),
  onTestExceptionUsed: async (hostname) => {
    exceptionAuditCalls += 1;
    store.auditModelEndpointException(hostname, Date.UTC(2099, 10, 30));
  },
});
if (!exceptionResolution.testExceptionUsed || exceptionResolution.address !== exceptionAddress
  || exceptionAuditCalls !== 1) {
  throw new Error('exact test endpoint exception was not used and audited');
}
const exceptionAuditText = readFileSync(join(storeHome, 'active-results-v1', 'audit.jsonl'), 'utf8');
if (!exceptionAuditText.includes('model_endpoint_exception_used')
  || exceptionAuditText.includes(exceptionHost)
  || exceptionAuditText.includes(exceptionAddress)
  || exceptionAuditText.includes(rowSentinel)
  || exceptionAuditText.includes(modelSentinel)) {
  throw new Error('test endpoint exception audit leaked host, IP, or result data');
}

for (const scenario of [
  {
    label: 'hostname mismatch',
    hostname: 'other.example',
    answers: [{ address: exceptionAddress, family: 4 }],
    exception: exceptionValue,
    now: Date.UTC(2099, 10, 30),
  },
  {
    label: 'IP mismatch',
    hostname: exceptionHost,
    answers: [{ address: '203.0.113.11', family: 4 }],
    exception: exceptionValue,
    now: Date.UTC(2099, 10, 30),
  },
  {
    label: 'multiple DNS answers',
    hostname: exceptionHost,
    answers: [
      { address: exceptionAddress, family: 4 },
      { address: '203.0.113.11', family: 4 },
    ],
    exception: exceptionValue,
    now: Date.UTC(2099, 10, 30),
  },
  {
    label: 'expired exception',
    hostname: exceptionHost,
    answers: [{ address: exceptionAddress, family: 4 }],
    exception: `host=${exceptionHost};ip=${exceptionAddress};expires=2026-10-18`,
    now: Date.UTC(2026, 9, 19),
  },
  {
    label: 'missing exception',
    hostname: exceptionHost,
    answers: [{ address: exceptionAddress, family: 4 }],
    exception: undefined,
    now: Date.UTC(2099, 10, 30),
  },
]) {
  let exceptionUsed = false;
  let rejection;
  try {
    await resolvePrivateModelAddress(scenario.hostname, async () => scenario.answers, {
      testException: scenario.exception,
      now: scenario.now,
      onTestExceptionUsed: () => { exceptionUsed = true; },
    });
  } catch (error) { rejection = error; }
  if (exceptionUsed || rejection?.message !== 'result_model_network_not_private') {
    throw new Error(`${scenario.label} test endpoint exception was accepted or rejected incorrectly`);
  }
}

for (const invalid of [
  'host=*.example;ip=203.0.113.10;expires=2099-12-31',
  'host=synthetic.example;ip=203.0.113.0/24;expires=2099-12-31',
  'host=synthetic.example;ip=198.18.0.1;expires=2099-12-31',
  'host=synthetic.example;ip=127.0.0.1;expires=2099-12-31',
  'host=synthetic.example;ip=10.0.0.1;expires=2099-12-31',
  'host=203.0.113.10;ip=203.0.113.10;expires=2099-12-31',
  'host=one.example;ip=203.0.113.10;expires=2099-12-31;host=two.example',
]) {
  if (parseResultModelTestException(invalid, Date.UTC(2099, 10, 30))) {
    throw new Error(`invalid test endpoint exception was accepted: ${invalid}`);
  }
}
if (parseResultModelTestException(
  'host=synthetic.example;ip=203.0.113.10;expires=2099-12-31',
  Date.UTC(2099, 0, 1),
)) {
  throw new Error('test endpoint exception longer than 60 days was accepted');
}

const serverSource = readFileSync(join(pluginRoot, 'src', 'mcp', 'server.js'), 'utf8');
if (!serverSource.includes(
  "testException: runtimeConfig.value('DATA_MCP_RESULT_MODEL_TEST_EXCEPTION'),",
)) {
  throw new Error('result model test exception is not wired from host configuration');
}

const warningEnvFile = join(root, 'test-exception-warning.env');
writeFileSync(warningEnvFile, [
  `DATA_MCP_RESULT_MODEL_TEST_EXCEPTION=${exceptionValue}`,
  `DATA_MCP_RESULT_BINDING_HMAC_KEY=${bindingSecret}`,
].join('\n') + '\n', { mode: 0o600 });
const warningPlugin = spawnPlugin('session-test-exception-warning', warningEnvFile);
await warningPlugin.list();
await warningPlugin.close();
if (!warningPlugin.stderr().includes('WARN test-only result model endpoint exception is configured')
  || warningPlugin.stderr().includes(exceptionHost)
  || warningPlugin.stderr().includes(exceptionAddress)) {
  throw new Error('test endpoint exception startup warning was missing or exposed endpoint details');
}

const publicEndpointFile = join(root, 'public-endpoint.env');
writeFileSync(publicEndpointFile, [
  'DATA_MCP_RESULT_MODEL_ENDPOINT=http://198.18.0.1/v1/chat/completions',
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=198.18.0.1',
  'DATA_MCP_RESULT_MODEL=internal-test-model',
  `DATA_MCP_RESULT_BINDING_HMAC_KEY=${bindingSecret}`,
].join('\n') + '\n', { mode: 0o600 });
const publicEndpoint = spawnPlugin('session-public-endpoint', publicEndpointFile);
const publicDenied = await publicEndpoint.call('deliver_query_result_for_user', {
  sql: 'SELECT synthetic_value FROM synthetic.events', query_plan_id: 'synthetic-public-plan',
  output_mode: 'analysis', question: 'network guard',
}, { ...callerA, turnId: 'turn-public-endpoint' });
if (!JSON.stringify(publicDenied).includes('isolated_data_operation_failed')) {
  throw new Error('non-private model endpoint did not fail closed');
}
await publicEndpoint.close();

let redirectHits = 0;
const redirect = createServer((_req, res) => {
  redirectHits += 1;
  res.writeHead(302, { location: `http://127.0.0.1:${modelAddress.port}/v1/chat/completions` });
  res.end();
});
await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
const redirectAddress = redirect.address();
if (!redirectAddress || typeof redirectAddress === 'string') throw new Error('redirect fixture did not bind');
const redirectEndpointFile = join(root, 'redirect-endpoint.env');
writeFileSync(redirectEndpointFile, [
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:${redirectAddress.port}/redirect`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL=internal-test-model',
  `DATA_MCP_RESULT_BINDING_HMAC_KEY=${bindingSecret}`,
].join('\n') + '\n', { mode: 0o600 });
const redirected = spawnPlugin('session-redirect-endpoint', redirectEndpointFile);
const modelCallsBeforeRedirect = modelCalls;
const redirectDenied = await redirected.call('deliver_query_result_for_user', {
  sql: 'SELECT synthetic_value FROM synthetic.events', query_plan_id: 'synthetic-redirect-plan',
  output_mode: 'analysis', question: 'redirect guard',
}, { ...callerA, turnId: 'turn-redirect-endpoint' });
if (!JSON.stringify(redirectDenied).includes('isolated_data_operation_failed')
  || redirectHits !== 1 || modelCalls !== modelCallsBeforeRedirect) {
  throw new Error('internal model redirect was followed or not rejected');
}
await redirected.close();
redirect.close();

service.close();
model.close();
process.stdout.write('active result follow-up validation passed\n');
