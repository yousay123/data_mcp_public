import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearSignedAppTestProfileCacheForTests,
  resolveSignedAppTestProfile,
} from '../src/mcp/signed-app-profile.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'data-mcp-signed-profile-'));
const socketPath = join(root, 'test-api.sock');
const pluginHome = join(root, 'plugin-home');
const selectedAppId = 'cli_signed_profile_test';
const otherAppId = 'cli_other_bot';
const bindingSecret = '0123456789abcdef0123456789abcdef';
const evilBindingSecret = 'profile-must-not-override-this-secret';
const rowSentinel = 'SIGNED_PROFILE_ROW_SENTINEL';
const modelSentinel = 'SIGNED_PROFILE_MODEL_SENTINEL';
let modelCalls = 0;
let modelAuthorization;

function jsonResponse(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

const service = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (req.url === '/agent/validate-sql') {
      jsonResponse(res, {
        status: 'success', datasource: 'tchouse-c', normalized_sql: body.sql,
        tables: ['synthetic.events'], columns: ['synthetic_value'],
        query_plan_id: 'signed-profile-plan',
      });
      return;
    }
    if (req.url === '/agent/run-query') {
      jsonResponse(res, {
        status: 'success', datasource: 'tchouse-c', row_count: 1, truncated: false,
        columns: [{ name: 'synthetic_value', type: 'String' }],
        rows: [{ synthetic_value: rowSentinel }],
      });
      return;
    }
    if (req.url === '/agent/export-query-excel-file') {
      const path = join(root, 'signed-profile.xlsx');
      writeFileSync(path, 'synthetic workbook', { mode: 0o600 });
      jsonResponse(res, {
        status: 'success', query_id: 'signed-profile-export',
        file: { path, filename: body.filename, row_count: 1 },
      });
      return;
    }
    jsonResponse(res, { status: 'error' }, 404);
  });
});
await new Promise(resolvePromise => service.listen(socketPath, resolvePromise));

const model = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (!body.includes(rowSentinel)) throw new Error('selected profile model did not receive synthetic result');
    modelAuthorization = req.headers.authorization;
    modelCalls += 1;
    jsonResponse(res, { choices: [{ message: { content: modelSentinel } }] });
  });
});
await new Promise(resolvePromise => model.listen(0, '127.0.0.1', resolvePromise));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === 'string') throw new Error('model fixture did not bind');

const defaultEnvFile = join(root, 'default.env');
writeFileSync(defaultEnvFile, [
  `DATA_MCP_RESULT_BINDING_HMAC_KEY=${bindingSecret}`,
  'DATA_MCP_VALIDATE_SQL_ENDPOINT=http://127.0.0.1:1/default-validate',
  'DATA_MCP_RUN_QUERY_ENDPOINT=http://127.0.0.1:1/default-run',
  'DATA_MCP_EXPORT_QUERY_ENDPOINT=http://127.0.0.1:1/default-export',
].join('\n') + '\n', { mode: 0o600 });
const profileFile = join(root, 'test-profile.env');
writeFileSync(profileFile, [
  `DATA_MCP_SERVICE_SOCKET_PATH=${socketPath}`,
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:${modelAddress.port}/v1/chat/completions`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL=signed-profile-model',
  'DATA_MCP_RESULT_MODEL_API_KEY=synthetic-profile-api-key',
  `DATA_MCP_RESULT_BINDING_HMAC_KEY=${evilBindingSecret}`,
  'BOTMUX_SESSION_ID=forbidden-profile-session',
].join('\n') + '\n', { mode: 0o600 });

function childEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('DATA_MCP_') || key === 'KSHER_AGENT_DATA_MCP_ENV_FILE') delete env[key];
  }
  return {
    ...env,
    BOTMUX_SESSION_ID: 'signed-profile-session',
    BOTMUX_PLUGIN_HOME: pluginHome,
    KSHER_AGENT_DATA_MCP_ENV_FILE: defaultEnvFile,
    DATA_MCP_TEST_PROFILE_APP_ID: selectedAppId,
    DATA_MCP_TEST_PROFILE_ENV_FILE: profileFile,
    ...extra,
  };
}

function spawnPlugin(extraEnv = {}) {
  const child = spawn(process.execPath, [join(pluginRoot, 'dist', 'mcp', 'server.js')], {
    cwd: pluginRoot,
    env: childEnvironment(extraEnv),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => {
    output += chunk;
    for (;;) {
      const newline = output.indexOf('\n');
      if (newline < 0) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter(response);
      }
    }
  });
  return {
    call(name, arguments_, caller) {
      const id = nextId++;
      const response = new Promise(resolvePromise => pending.set(id, resolvePromise));
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name, arguments: arguments_, _meta: { botmuxTrustedCaller: caller } },
      })}\n`);
      return response;
    },
    async close() {
      child.stdin.end();
      const code = await new Promise((resolvePromise, reject) => {
        child.once('error', reject);
        child.once('close', resolvePromise);
      });
      if (code !== 0) throw new Error(`plugin exited ${code}: ${errors}`);
    },
  };
}

function caller(appId = selectedAppId, turnId = 'signed-profile-turn') {
  return {
    requestUserOpenId: 'ou_signed_profile', requestUserUnionId: 'on_signed_profile',
    ...(appId ? { requestLarkAppId: appId } : {}),
    senderType: 'user', turnId, hostCapabilities: ['result_delivery_v1'],
  };
}

const plugin = spawnPlugin();
const selectedValidation = await plugin.call('validate_sql_for_user', {
  sql: 'SELECT synthetic_value FROM synthetic.events', datasource: 'tchouse-c',
}, caller());
if (!JSON.stringify(selectedValidation).includes('signed-profile-plan')) {
  throw new Error('signed matching app did not use the selected service profile');
}

for (const [label, signedCaller, arguments_] of [
  ['other app', caller(otherAppId, 'other-turn'), {}],
  ['missing app', caller(null, 'missing-app-turn'), {}],
  ['model-forged app', caller(otherAppId, 'forged-turn'), { requestLarkAppId: selectedAppId }],
]) {
  const response = await plugin.call('validate_sql_for_user', {
    sql: 'SELECT synthetic_value FROM synthetic.events', datasource: 'tchouse-c', ...arguments_,
  }, signedCaller);
  if (!JSON.stringify(response).includes('data_mcp_service_unreachable')) {
    throw new Error(`${label} incorrectly received the selected service profile`);
  }
}

const initial = await plugin.call('deliver_query_result_for_user', {
  sql: 'SELECT synthetic_value FROM synthetic.events', datasource: 'tchouse-c',
  query_plan_id: 'signed-profile-plan', output_mode: 'analysis', question: 'initial',
}, caller(selectedAppId, 'initial-turn'));
if (initial.result?._meta?.botmuxHostDelivery?.markdown !== modelSentinel
  || JSON.stringify(initial.result?.content).includes(rowSentinel)
  || modelAuthorization !== 'Bearer synthetic-profile-api-key') {
  throw new Error('initial analysis did not use the selected model profile safely');
}

const followup = await plugin.call('continue_query_result_for_user', {
  question: 'follow up', output_mode: 'analysis',
}, caller(selectedAppId, 'followup-turn'));
if (followup.result?._meta?.botmuxHostDelivery?.markdown !== modelSentinel || modelCalls !== 2) {
  throw new Error('follow-up did not reuse the selected model profile and base HMAC binding');
}

const exported = await plugin.call('continue_query_result_for_user', {
  question: 'export', output_mode: 'excel', filename: '../unsafe.xlsx',
}, caller(selectedAppId, 'export-turn'));
if (!Array.isArray(exported.result?._meta?.botmuxHostDelivery?.files)) {
  throw new Error('follow-up export did not use the selected service profile');
}
await plugin.close();

clearSignedAppTestProfileCacheForTests();
const direct = resolveSignedAppTestProfile({ requestLarkAppId: selectedAppId }, childEnvironment());
if (direct.DATA_MCP_SERVICE_SOCKET_PATH !== socketPath
  || Object.hasOwn(direct, 'DATA_MCP_RESULT_BINDING_HMAC_KEY')
  || Object.hasOwn(direct, 'BOTMUX_SESSION_ID')) {
  throw new Error('profile whitelist accepted identity or HMAC configuration');
}
if (resolveSignedAppTestProfile({ requestLarkAppId: otherAppId }, childEnvironment()) !== undefined
  || resolveSignedAppTestProfile({}, childEnvironment()) !== undefined) {
  throw new Error('unsigned or other-app caller selected the test profile');
}

const secondProfile = join(root, 'second-profile.env');
writeFileSync(secondProfile, 'DATA_MCP_SERVICE_SOCKET_PATH=/synthetic/second.sock\n', { mode: 0o600 });
const fixedTime = new Date('2026-10-19T00:00:00.000Z');
utimesSync(profileFile, fixedTime, fixedTime);
utimesSync(secondProfile, fixedTime, fixedTime);
const second = resolveSignedAppTestProfile(
  { requestLarkAppId: otherAppId },
  { DATA_MCP_TEST_PROFILE_APP_ID: otherAppId, DATA_MCP_TEST_PROFILE_ENV_FILE: secondProfile },
);
if (second.DATA_MCP_SERVICE_SOCKET_PATH !== '/synthetic/second.sock'
  || direct.DATA_MCP_SERVICE_SOCKET_PATH === second.DATA_MCP_SERVICE_SOCKET_PATH) {
  throw new Error('profile cache crossed app or file boundaries');
}
writeFileSync(secondProfile, 'DATA_MCP_SERVICE_SOCKET_PATH=/synthetic/reloaded.sock\n', { mode: 0o600 });
const laterTime = new Date(fixedTime.getTime() + 1000);
utimesSync(secondProfile, laterTime, laterTime);
const reloaded = resolveSignedAppTestProfile(
  { requestLarkAppId: otherAppId },
  { DATA_MCP_TEST_PROFILE_APP_ID: otherAppId, DATA_MCP_TEST_PROFILE_ENV_FILE: secondProfile },
);
if (reloaded.DATA_MCP_SERVICE_SOCKET_PATH !== '/synthetic/reloaded.sock') {
  throw new Error('profile cache did not reload after mtime changed');
}

for (const [label, pathValue] of [
  ['relative path', 'relative.env'],
  ['missing path', join(root, 'missing.env')],
]) {
  let rejected = false;
  try {
    resolveSignedAppTestProfile(
      { requestLarkAppId: selectedAppId },
      { DATA_MCP_TEST_PROFILE_APP_ID: selectedAppId, DATA_MCP_TEST_PROFILE_ENV_FILE: pathValue },
    );
  } catch (error) { rejected = error?.message === 'test_profile_config_invalid'; }
  if (!rejected) throw new Error(`${label} did not fail closed`);
}

const looseProfile = join(root, 'loose.env');
writeFileSync(looseProfile, 'DATA_MCP_SERVICE_SOCKET_PATH=/synthetic/loose.sock\n', { mode: 0o644 });
const linkedProfile = join(root, 'linked.env');
symlinkSync(secondProfile, linkedProfile);
for (const [label, pathValue] of [['loose permissions', looseProfile], ['symlink', linkedProfile]]) {
  clearSignedAppTestProfileCacheForTests();
  let rejected = false;
  try {
    resolveSignedAppTestProfile(
      { requestLarkAppId: selectedAppId },
      { DATA_MCP_TEST_PROFILE_APP_ID: selectedAppId, DATA_MCP_TEST_PROFILE_ENV_FILE: pathValue },
    );
  } catch (error) { rejected = error?.message === 'test_profile_config_invalid'; }
  if (!rejected) throw new Error(`${label} profile did not fail closed`);
}

const malformedProfile = join(root, 'malformed.env');
writeFileSync(malformedProfile, 'not an env assignment\n', { mode: 0o600 });
clearSignedAppTestProfileCacheForTests();
let malformedRejected = false;
try {
  resolveSignedAppTestProfile(
    { requestLarkAppId: selectedAppId },
    { DATA_MCP_TEST_PROFILE_APP_ID: selectedAppId, DATA_MCP_TEST_PROFILE_ENV_FILE: malformedProfile },
  );
} catch (error) { malformedRejected = error?.message === 'test_profile_config_invalid'; }
if (!malformedRejected) throw new Error('malformed profile did not fail closed');

const invalidPlugin = spawnPlugin({ DATA_MCP_TEST_PROFILE_ENV_FILE: looseProfile });
const invalidResponse = await invalidPlugin.call('validate_sql_for_user', {
  sql: 'SELECT synthetic_value FROM synthetic.events', datasource: 'tchouse-c',
}, caller(selectedAppId, 'invalid-profile-turn'));
if (!JSON.stringify(invalidResponse).includes('test_profile_config_invalid')
  || JSON.stringify(invalidResponse).includes('signed-profile-plan')) {
  throw new Error('selected invalid profile did not fail closed at the tool boundary');
}
await invalidPlugin.close();

chmodSync(looseProfile, 0o600);
service.close();
model.close();
rmSync(root, { recursive: true, force: true });
process.stdout.write('signed app test profile validation passed\n');
