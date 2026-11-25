import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultStore } from '../src/mcp/result-store.js';
import { canonicalContext } from './test-result-context-fixture.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverEntry = process.env.DATA_MCP_TEST_SERVER_ENTRY || join(pluginRoot, 'src/mcp/server.js');
const root = mkdtempSync(join(tmpdir(), 'data-mcp-delivery-state-'));
const pluginHome = join(root, 'home');
const secret = 'synthetic-delivery-state-secret-00000000';
const identity = { unionId: 'on_state', appId: 'cli_synthetic', sessionId: 'session_state' };
const caller = {
  requestUserOpenId: 'ou_state', requestUserUnionId: identity.unionId,
  requestLarkAppId: identity.appId, senderType: 'user', hostCapabilities: ['result_delivery_v1'],
};
const bin = join(root, 'bin');
mkdirSync(bin);
const started = join(root, 'send-started.json');
const release = join(root, 'send-release');
const log = join(root, 'sends.jsonl');
writeFileSync(join(bin, 'botmux'), `#!/usr/bin/env node
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='observe') {
 console.log(JSON.stringify({probe:{status:'ok'},identity:{sessionId:process.env.BOTMUX_SESSION_ID,larkAppId:'cli_synthetic'}}));
} else if(args[0]==='send') {
 const files=args.flatMap((arg,index)=>arg==='--files'?[args[index+1]]:[]);
 appendFileSync(${JSON.stringify(log)},JSON.stringify({args,files})+'\\n');
 writeFileSync(${JSON.stringify(started)},JSON.stringify(files));
 const deadline=Date.now()+10_000;
 while(!existsSync(${JSON.stringify(release)})) {
  if(Date.now()>deadline)process.exit(2);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
 }
 console.log(JSON.stringify({success:true,messageId:'om_state_card',attachmentMessageIds:[],failedAttachments:files.map(()=> 'synthetic.xlsx')}));
} else process.exit(2);
`, { mode: 0o700 });

// A controllable clock for the actual server process. Production source is
// imported normally; timers are advanced through a private test IPC channel.
const clockHook = join(root, 'clock-hook.cjs');
writeFileSync(clockHook, `
let now=Date.now(); Date.now=()=>now;
const intervals=new Map(); let next=0;
global.setInterval=(fn,delay,...args)=> {
 const timer={id:++next,unref(){return this}};
 intervals.set(timer,{fn,delay,next:now+delay,args});return timer;
};
global.clearInterval=timer=>intervals.delete(timer);
process.on('message',message=> {
 if(message?.kind!=='advance')return;
 now+=message.ms;
 for(const timer of intervals.values())if(timer.next<=now){timer.next=now+timer.delay;timer.fn(...timer.args);}
 process.send({kind:'advanced',id:message.id,now});
});
`);

const columns = [{ name: 'value', type: 'UInt64' }];
const result = {
  status: 'success', datasource: 'tchouse-c', row_count: 2,
  columns, rows: [{ value: 2 }, { value: 3 }], truncated: false,
  result_context: canonicalContext(columns),
};
const store = new ResultStore({ pluginHome, secret });
store.put(identity, { result });

const model = createServer((req, res) => {
  req.resume();
  req.once('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: {
      content: null, tool_calls: [{ id: 'excel', type: 'function', function: {
        name: 'create_excel', arguments: JSON.stringify({ sheets: [{ columns: ['value'] }] }),
      } }],
    } }] }));
  });
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const hostEnvFile = join(root, 'host.env');
writeFileSync(hostEnvFile, [
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:${model.address().port}/v1/chat/completions`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL=synthetic-model',
  `DATA_MCP_RESULT_BINDING_HMAC_KEY=${secret}`,
].join('\n') + '\n', { mode: 0o600 });

function start() {
  const child = spawn(process.execPath, ['--require', clockHook, serverEntry], {
    cwd: pluginRoot,
    env: {
      ...process.env, PATH: `${bin}${delimiter}${process.env.PATH || ''}`,
      BOTMUX_SESSION_ID: identity.sessionId, BOTMUX_PLUGIN_HOME: pluginHome,
      KSHER_AGENT_DATA_MCP_ENV_FILE: hostEnvFile,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const closed = new Promise(resolve => child.once('exit', resolve));
  let buffer = ''; let stderr = ''; let id = 0;
  const pending = new Map(); const advances = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line) { const value = JSON.parse(line); pending.get(value.id)?.resolve(value); }
    }
  });
  child.on('message', message => {
    if (message?.kind === 'advanced') advances.get(message.id)?.resolve(message.now);
  });
  function wait(map, key) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server response timeout: ${stderr}`)), 15_000);
      map.set(key, { resolve(value) { clearTimeout(timer); map.delete(key); resolve(value); } });
    });
  }
  return {
    async list() {
      const requestId = ++id; const response = wait(pending, requestId);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/list', params: {} })}\n`);
      return response;
    },
    async excel(turnId) {
      const requestId = ++id; const response = wait(pending, requestId);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: {
        name: 'continue_query_result_for_user',
        arguments: { question: 'export the current synthetic result', requested_outputs: ['excel'] },
        _meta: { botmuxTrustedCaller: { ...caller, turnId } },
      } })}\n`);
      return response;
    },
    async status(override = {}) {
      const requestId = ++id; const response = wait(pending, requestId);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: {
        name: 'get_query_delivery_status_for_user', arguments: {},
        _meta: { botmuxTrustedCaller: { ...caller, turnId: 'om_status', ...override } },
      } })}\n`);
      const result = await response;
      return JSON.parse(result.result.content[0].text);
    },
    async advance(ms) {
      const requestId = ++id; const response = wait(advances, requestId);
      child.send({ kind: 'advance', id: requestId, ms }); return response;
    },
    async close() {
      child.stdin.end(); if (child.connected) child.disconnect();
      const code = await closed;
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      assert.equal(code, 0, stderr);
    },
  };
}

async function sendingFile() {
  const deadline = Date.now() + 10_000;
  while (!existsSync(started)) {
    if (Date.now() > deadline) throw new Error('upload never started');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const files = JSON.parse(readFileSync(started, 'utf8'));
  assert.equal(files.length, 1); assert(files[0].endsWith('.xlsx'));
  return files[0];
}

let server;
try {
  server = start(); await server.list();
  const failedSend = server.excel('om_retained');
  const retained = await sendingFile();
  assert.equal((await server.status()).status, 'pending');
  assert.equal((await server.status({ requestUserUnionId: 'on_other' })).status, 'no_active_result');
  assert.equal((await server.status({ senderType: 'bot' })).status, 'delivery_status_unavailable');
  writeFileSync(release, 'release');
  assert.match(JSON.stringify(await failedSend), /direct_reply_partial_delivery/);
  const terminalReceipt = await server.status();
  assert.equal(terminalReceipt.status, 'unknown', 'a terminated partial send must not stay pending');
  assert.equal(terminalReceipt.messageId, 'om_state_card');
  assert(existsSync(retained), 'failed upload must preserve its private artifact');
  await server.close(); server = null;
  assert(existsSync(retained), 'normal shutdown must retain a failed artifact');
  server = start(); await server.list();
  assert.deepEqual(await server.status(), terminalReceipt, 'safe receipt must survive process restart');
  assert(existsSync(retained), 'restart must retain an unexpired failed artifact');
  await server.advance(20 * 60_000);
  assert(!existsSync(retained), 'periodic sweep must remove expired retained artifacts');
  rmSync(started); rmSync(release);

  const activeSend = server.excel('om_inflight');
  const inFlight = await sendingFile();
  // Mark the actual uploading file as old, then cross a sweep while the
  // transport is blocked. The file must remain usable until the send settles.
  const old = (Date.now() - 30 * 60_000) / 1000;
  utimesSync(inFlight, old, old);
  await server.advance(20 * 60_000);
  assert(existsSync(inFlight), 'periodic sweep must skip an in-flight upload');
  writeFileSync(release, 'release');
  assert.match(JSON.stringify(await activeSend), /direct_reply_partial_delivery/);
  assert(existsSync(inFlight), 'settled failure must not delete the artifact immediately');
  await server.advance(20 * 60_000);
  assert(!existsSync(inFlight), 'settled failed upload must become eligible for expiry');

  const unitIdentity = { ...identity, sessionId: 'session_unit' };
  const first = store.put(unitIdentity, { marker: 'old' });
  const second = store.put(unitIdentity, { marker: 'replacement' });
  const receipt = { deliveryId: 'data-result-00000000-0000-4000-8000-000000000001', status: 'delivered', messageId: 'om_old' };
  store.audit(unitIdentity, 'om_receipt', '', first.version, 'delivery_receipt', Date.now(), { generationId: first.generationId, deliveryReceipt: receipt });
  assert.equal(store.deliveryStatus(unitIdentity).status, 'delivery_status_unknown', 'old version receipts cannot attach to replacement results');
  const abaIdentity = { ...identity, sessionId: 'session_aba' };
  const clock = Date.now();
  const beforeClear = store.put(abaIdentity, { marker: 'old' }, clock);
  const oldRevision = { version: beforeClear.version, generationId: beforeClear.generationId };
  store.audit(abaIdentity, 'om_before_clear', '', beforeClear.version, 'delivery_receipt', clock, { generationId: beforeClear.generationId, deliveryReceipt: receipt });
  assert.equal(store.deliveryStatus(abaIdentity, clock).status, 'delivered');
  store.clear(abaIdentity);
  const afterClear = store.put(abaIdentity, { marker: 'new' }, clock);
  assert.equal(afterClear.version, beforeClear.version, 'exercise numeric version reuse at the same timestamp');
  assert.notEqual(afterClear.generationId, beforeClear.generationId);
  assert.equal(store.deliveryStatus(abaIdentity, clock).status, 'delivery_status_unknown');
  assert.throws(() => store.assertVersion(abaIdentity, oldRevision, clock), /version_changed/);
  assert.throws(() => store.replaceIfVersion(abaIdentity, oldRevision, { marker: 'stale' }, clock), /version_changed/);
  assert.throws(() => store.touch(abaIdentity, oldRevision, clock), /version_changed/);
  assert.equal(store.clearIfVersion(abaIdentity, oldRevision, clock), false);
  assert.equal(store.read(abaIdentity, clock).record.payload.marker, 'new');
  assert.throws(() => store.assertVersion(unitIdentity, first.version), /version_changed/);
  assert.equal(store.clearIfVersion(unitIdentity, first.version), false);
  assert.equal(store.read(unitIdentity).record.version, second.version);
  assert.equal(store.reserveTurn(unitIdentity, 'om_scopes', Date.now(), ['excel']), true);
  assert.equal(store.reserveTurn(unitIdentity, 'om_scopes', Date.now(), ['analysis', 'excel']), false);
  assert.equal(store.reserveTurn(unitIdentity, 'om_scopes', Date.now(), ['analysis']), true);
  assert.equal(store.reserveTurn(unitIdentity, 'om_scopes', Date.now(), ['analysis']), false);
  assert.equal(store.reserveTurn(unitIdentity, 'om_primary', Date.now(), ['delivery_primary']), true);
  const restartedStore = new ResultStore({ pluginHome, secret });
  assert.equal(restartedStore.reserveTurn(unitIdentity, 'om_primary', Date.now(), ['delivery_primary']), false);
  console.log('delivery state tests passed: failure/restart retention, timed expiry, upload overlap, replacement CAS, reservation rollback, durable primary lane');
} finally {
  if (server) { writeFileSync(release, 'release'); await server.close(); }
  await new Promise(resolve => model.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
