import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { installFakeBotmux } from './test-botmux-fixture.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(pluginRoot, '..');
const python = process.env.DATA_MCP_TEST_PYTHON;
if (!python) throw new Error('DATA_MCP_TEST_PYTHON is required');

const fixture = spawnSync(python, [join(pluginRoot, 'scripts', 'exact-query-result-fixture.py')], {
  cwd: repositoryRoot,
  env: { ...process.env, PYTHONPATH: join(repositoryRoot, 'src') },
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});
if (fixture.status !== 0) throw new Error(`exact Python fixture failed: ${fixture.stderr}`);
const runResult = JSON.parse(fixture.stdout);
if (runResult.rows?.[0]?.amount !== '9007199254740993.00'
  || runResult.rows?.[0]?.event_id !== '18446744073709551615') {
  throw new Error('exact values were lost before the MCP boundary');
}

const root = mkdtempSync(join(tmpdir(), 'data-mcp-exact-chain-'));
const pluginHome = join(root, 'plugin-home');
const hostEnvFile = join(root, 'host.env');
const botmuxLog = join(root, 'botmux.jsonl');
let modelRows;

const serviceServer = createServer((req, res) => {
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(runResult));
});
await new Promise(resolvePromise => serviceServer.listen(0, '127.0.0.1', resolvePromise));
const serviceAddress = serviceServer.address();
if (!serviceAddress || typeof serviceAddress === 'string') throw new Error('service fixture did not bind');

const claims = ['sum', 'average', 'minimum', 'maximum'].map(operation => ({ operation, column: 'amount' }));
const modelServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const envelope = JSON.parse(payload.messages.find(message => message.role === 'user').content);
    modelRows = envelope.rows;
    const calls = [
      ['analysis', 'create_analysis', { claims }],
      ['excel', 'create_excel', { sheets: [{ columns: ['amount', 'event_id'] }] }],
      ['pdf', 'create_pdf', { claims, table_columns: ['amount', 'event_id'] }],
      ['chart', 'create_chart', { type: 'bar', label_column: 'event_id', value_column: 'amount' }],
      ['document', 'create_document', { claims, table_columns: ['amount', 'event_id'] }],
    ].map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: calls } }] }));
  });
});
await new Promise(resolvePromise => modelServer.listen(0, '127.0.0.1', resolvePromise));
const modelAddress = modelServer.address();
if (!modelAddress || typeof modelAddress === 'string') throw new Error('model fixture did not bind');

writeFileSync(hostEnvFile, [
  `DATA_MCP_RESULT_MODEL_ENDPOINT=http://127.0.0.1:${modelAddress.port}/v1/chat/completions`,
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS=127.0.0.1',
  'DATA_MCP_RESULT_MODEL=internal-test-model',
  'DATA_MCP_RESULT_BINDING_HMAC_KEY=0123456789abcdef0123456789abcdef',
].join('\n') + '\n', { mode: 0o600 });

const fake = installFakeBotmux(root);
const response = await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(process.execPath, [join(pluginRoot, 'src', 'mcp', 'server.js')], {
    cwd: pluginRoot,
    env: fake.env({
      BOTMUX_SESSION_ID: 'session_exact_chain',
      BOTMUX_PLUGIN_HOME: pluginHome,
      DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
      DATA_MCP_RUN_QUERY_ENDPOINT: `http://127.0.0.1:${serviceAddress.port}/agent/run-query`,
      KSHER_AGENT_DATA_MCP_ENV_FILE: hostEnvFile,
      FAKE_BOTMUX_LOG: botmuxLog,
      FAKE_BOTMUX_CAPTURE_FILES: '1',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', rejectPromise);
  child.once('close', code => {
    if (code !== 0) rejectPromise(new Error(`MCP server exited ${code}: ${stderr}`));
    else resolvePromise(JSON.parse(stdout.trim()));
  });
  child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'deliver_query_result_for_user',
      arguments: {
        sql: 'SELECT exact values', datasource: 'tchouse-c', query_plan_id: 'exact-plan',
        requested_outputs: ['analysis', 'excel', 'pdf', 'chart', 'document'],
        question: '生成精确多产物',
      },
      _meta: { botmuxTrustedCaller: {
        requestUserOpenId: 'ou_test', requestUserUnionId: 'on_example_user',
        requestLarkAppId: 'cli_synthetic', senderType: 'user', turnId: 'om_exact_chain',
      } },
    },
  })}\n`);
});

const receipt = JSON.parse(response?.result?.content?.[0]?.text || '{}');
if (receipt.status !== 'delivered' || receipt.attachmentCount !== 4) {
  throw new Error(`exact chain delivery failed: ${JSON.stringify(response)}`);
}
if (modelRows?.[0]?.amount !== '9007199254740993.00'
  || modelRows?.[0]?.event_id !== '18446744073709551615') {
  throw new Error('MCP or isolated-Agent IPC lost exact values');
}

const records = readFileSync(botmuxLog, 'utf8').trim().split('\n').map(JSON.parse);
const delivery = records.find(record => record.args[0] === 'send' && record.files?.length === 4);
if (!delivery) throw new Error('trusted delivery did not capture every exact artifact');
const deliveredText = records.map(record => record.content || '').join('\n');
const exactClaims = [
  '- **amount（合计）**：9,007,199,254,740,989.51',
  '- **amount（平均值）**：3,002,399,751,580,329.836667',
  '- **amount（最小值）**：-3.50',
  '- **amount（最大值）**：9,007,199,254,740,993.00',
];
for (const claim of exactClaims) {
  if (!deliveredText.includes(claim)) {
    throw new Error(`analysis lost exact claim: ${claim}; content=${deliveredText}`);
  }
}

function zipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    entries.set(bytes.subarray(nameStart, nameStart + nameLength).toString('utf8'), content);
    offset = dataStart + compressedSize;
  }
  return entries;
}

const captured = Object.fromEntries(delivery.files.map(file => [file.path.split('.').pop(), Buffer.from(file.base64, 'base64')]));
const document = captured.md.toString('utf8');
const pdfText = captured.pdf.toString('latin1');
const chart = captured.svg.toString('utf8');
const workbook = zipEntries(captured.xlsx).get('xl/worksheets/sheet1.xml')?.toString('utf8') || '';
for (const claim of exactClaims) {
  if (!document.includes(claim)) throw new Error(`document lost exact claim: ${claim}`);
  const utf16 = Buffer.from(`\ufeff${claim}`, 'utf16le').swap16().toString('hex').toUpperCase();
  if (!pdfText.includes(utf16)) throw new Error(`PDF lost exact claim: ${claim}`);
}
for (const sourceValue of ['9007199254740993.00', '18446744073709551615', '-3.50']) {
  if (!workbook.includes(sourceValue)) throw new Error(`Excel lost exact source value: ${sourceValue}`);
}
if (!chart.includes('<svg') || !chart.includes('184467440737')) {
  throw new Error('chart did not bind exact large-integer labels');
}
if (delivery.files.some(file => existsSync(file.path))) throw new Error('trusted delivery did not clean staged files');

modelServer.close();
serviceServer.close();
rmSync(root, { recursive: true, force: true });
console.log('exact ClickHouse-to-isolated-Agent delivery chain passed');
