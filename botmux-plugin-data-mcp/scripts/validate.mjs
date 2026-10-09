import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = join(repoRoot, 'dist');

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function quoteEnvValue(value) {
  const text = String(value);
  if (text.includes("'")) fail('test fixture env values must not contain a single quote');
  return `'${text}'`;
}

const SERVICE_PM2_ENV_ALLOWLIST = new Set([
  'KSHER_AGENT_DATA_MCP_ENV_FILE',
  'DATA_MCP_HTTP_SOCKET_PATH',
  'DATA_MCP_SERVICE_API_BIN',
  'KSHER_AGENT_DATA_MCP_RUNTIME_HOME',
]);

function validateServiceDefinition(definition, manifest) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    fail('plugin_service_definition_not_found:data-mcp');
  }
  if (!definition.pm2 || typeof definition.pm2 !== 'object' || Array.isArray(definition.pm2)) {
    fail('plugin_service_pm2_missing:data-mcp');
  }
  if (typeof definition.pm2.script !== 'string' || !definition.pm2.script.trim()) {
    fail('plugin_service_pm2_script_missing:data-mcp');
  }
  if (definition.mode && definition.mode !== manifest.service?.mode) {
    fail('plugin_service_mode_mismatch:data-mcp');
  }
  const serviceEnv = definition.pm2.env ?? {};
  if (!serviceEnv || typeof serviceEnv !== 'object' || Array.isArray(serviceEnv)) {
    fail('plugin_service_pm2_env_invalid:data-mcp');
  }
  for (const [key, value] of Object.entries(serviceEnv)) {
    if (!SERVICE_PM2_ENV_ALLOWLIST.has(key)) {
      fail(`plugin_service_pm2_env_key_not_allowed:data-mcp:${key}`);
    }
    if (typeof value !== 'string' || !value) {
      fail(`plugin_service_pm2_env_value_invalid:data-mcp:${key}`);
    }
  }
  return definition;
}

function expectFailure(fn, expected) {
  let error;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error) || error.message !== expected) {
    fail(`expected ${expected}, got ${error instanceof Error ? error.message : 'no error'}`);
  }
}

function waitForExit(child, timeoutMs = 15_000, label = 'child process') {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for ${label} exit`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  fail(`timed out waiting for ${path}`);
}

function assertNoSymlinks(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail(`plugin dist must not contain symlinks: ${path}`);
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path)) assertNoSymlinks(join(path, name));
}

function markdownFilesUnder(path) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (['.git', 'dist', 'node_modules'].includes(entry.name)) continue;
      files.push(...markdownFilesUnder(join(path, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(join(path, entry.name));
    }
  }
  return files;
}

const pkg = readJson(join(repoRoot, 'package.json'));
const markdownIdentityFallbackPatterns = [
  { label: 'trusted-turns', pattern: /trusted-turns/i },
  { label: 'identity-<sha256', pattern: /identity-<sha256/i },
  { label: 'read-isolation', pattern: /read-isolation/i },
  { label: 'file-based identity fallback', pattern: /file[- ]based(?:\s+\w+){0,3}\s+fallback/i },
];
for (const markdownPath of markdownFilesUnder(repoRoot)) {
  const markdownSource = readFileSync(markdownPath, 'utf-8');
  for (const { label, pattern } of markdownIdentityFallbackPatterns) {
    if (pattern.test(markdownSource)) {
      fail(`plugin documentation must not describe a removed identity fallback: ${label}`);
    }
  }
}
const readmeSource = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
if (!readmeSource.includes('_meta.botmuxTrustedCaller')) {
  fail('README must document _meta.botmuxTrustedCaller as the trusted identity source');
}
if (!pkg.keywords?.includes('botmux-plugin')) fail('package.json must include keywords: ["botmux-plugin"]');
if (!/^[a-z][a-z0-9._-]{0,63}$/.test(pkg.botmux?.id ?? '')) fail('package.json#botmux.id is invalid');
if (!Array.isArray(pkg.files) || pkg.files.length !== 1 || pkg.files[0] !== 'dist/') {
  fail('package.json#files must publish only dist/');
}
if (!existsSync(runtimeRoot)) fail('dist/ is missing; run npm run build');
if (pkg.botmux?.service && !existsSync(join(runtimeRoot, 'service', 'index.js'))) {
  fail('botmux.service is set, but dist/service/index.js does not exist');
}
assertNoSymlinks(runtimeRoot);

const mcp = readJson(join(runtimeRoot, 'mcp', 'index.json'));
const mcpServerSource = readFileSync(join(runtimeRoot, 'mcp', 'server.js'), 'utf-8');
const mcpServerSourceFile = readFileSync(join(repoRoot, 'src', 'mcp', 'server.js'), 'utf-8');
const trustedCallerStart = mcpServerSourceFile.indexOf('function trustedCallerFrom(request) {');
const trustedCallerEnd = mcpServerSourceFile.indexOf('\n}\n\nfunction normalizeTrustedCaller', trustedCallerStart);
if (trustedCallerStart < 0 || trustedCallerEnd < 0) {
  fail('MCP server must keep trustedCallerFrom as an auditable identity gate');
}
const trustedCallerSource = mcpServerSourceFile.slice(trustedCallerStart, trustedCallerEnd);
if (!trustedCallerSource.includes('deliberately no file-based fallback')) {
  fail('trustedCallerFrom must retain the no-file-fallback security invariant');
}
const trustedCallerNormalizeCalls = trustedCallerSource.match(/normalizeTrustedCaller\s*\(/g) ?? [];
if (trustedCallerNormalizeCalls.length !== 1) {
  fail(`trustedCallerFrom must have exactly one trusted identity normalization path, got ${trustedCallerNormalizeCalls.length}`);
}
for (const accountField of ['request_user_tchouse_account', 'requestUserTchouseAccount', 'tchouse_account']) {
  if (mcpServerSource.includes(accountField)) {
    fail('MCP server must not consume or forward model-supplied database account arguments');
  }
}
if (mcp.name !== undefined) fail('dist/mcp/index.json must not declare a name; the plugin id is the MCP identity');
if (mcp.transport === 'streamable-http') {
  let url;
  try { url = new URL(mcp.url); } catch { fail('streamable-http MCP config requires a valid url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('streamable-http MCP url must use http or https');
} else if (mcp.transport !== 'stdio') {
  fail(`unsupported MCP transport: ${mcp.transport}`);
}

const cleanRoot = mkdtempSync(join(tmpdir(), 'botmux-plugin-dist-'));
try {
  cpSync(runtimeRoot, cleanRoot, { recursive: true });
  const cleanCli = join(cleanRoot, 'cli', 'index.js');
  const cleanCommands = readJson(join(cleanRoot, 'cli', 'commands.json')).commands ?? [];
  const mod = await import(pathToFileURL(cleanCli).href + `?t=${Date.now()}`);
  const handlers = mod.default ?? mod;
  for (const command of cleanCommands) {
    const handler = handlers?.[command.name];
    if (typeof handler !== 'function' && typeof handler?.run !== 'function') {
      fail(`dist/cli/commands.json declares ${command.name}, but dist/cli/index.js has no handler`);
    }
  }

  const serviceIndex = join(cleanRoot, 'service', 'index.js');
  if (existsSync(serviceIndex)) {
    const serviceMod = await import(pathToFileURL(serviceIndex).href + `?t=${Date.now()}`);
    const exported = serviceMod.default ?? serviceMod;
    const serviceDefinition = typeof exported === 'function'
      ? await exported({}, { pluginDir: cleanRoot, manifest: pkg.botmux })
      : exported;

    // One mutation per case: the baseline must pass, then each malformed
    // definition must fail for exactly the guard named by the expected code.
    validateServiceDefinition(serviceDefinition, pkg.botmux);
    const withoutPm2 = structuredClone(serviceDefinition);
    delete withoutPm2.pm2;
    expectFailure(
      () => validateServiceDefinition(withoutPm2, pkg.botmux),
      'plugin_service_pm2_missing:data-mcp',
    );
    const withoutScript = structuredClone(serviceDefinition);
    withoutScript.pm2.script = '';
    expectFailure(
      () => validateServiceDefinition(withoutScript, pkg.botmux),
      'plugin_service_pm2_script_missing:data-mcp',
    );
    const wrongMode = structuredClone(serviceDefinition);
    wrongMode.mode = 'manual';
    expectFailure(
      () => validateServiceDefinition(wrongMode, pkg.botmux),
      'plugin_service_mode_mismatch:data-mcp',
    );
    const leakedSecret = structuredClone(serviceDefinition);
    leakedSecret.pm2.env.DATA_MCP_PASSWORD = 'must-not-reach-pm2-config';
    expectFailure(
      () => validateServiceDefinition(leakedSecret, pkg.botmux),
      'plugin_service_pm2_env_key_not_allowed:data-mcp:DATA_MCP_PASSWORD',
    );

    if (serviceDefinition.mode !== 'auto' || pkg.botmux.service?.mode !== 'auto') {
      fail('Data MCP service definition and manifest must both use auto mode');
    }
    if (serviceDefinition.pm2.script !== 'service/api-runner-entry.js') {
      fail('Data MCP service must use the JavaScript API runner');
    }
    if (serviceDefinition.pm2.autorestart === false) {
      fail('Data MCP service must keep PM2 autorestart enabled');
    }
    if ('KSHER_AGENT_DATA_MCP_PYTHON' in (serviceDefinition.pm2.env ?? {})) {
      fail('Data MCP service must not reinterpret the system-Python bootstrap key');
    }
    if (!existsSync(join(cleanRoot, serviceDefinition.pm2.script))) {
      fail('Data MCP service runner is missing from the clean dist');
    }

    const runnerRoot = mkdtempSync(join(tmpdir(), 'data-mcp-api-runner-'));
    try {
      const runtimeHome = join(runnerRoot, 'runtime-abc123');
      const binDir = join(runtimeHome, '.venv', 'bin');
      const fakeApi = join(binDir, 'ksher-agent-data-api');
      const runner = join(cleanRoot, serviceDefinition.pm2.script);
      const runnerModule = join(cleanRoot, 'service', 'api-runner.js');
      const pm2ImportContainer = join(runnerRoot, 'pm2-import-container.mjs');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        pm2ImportContainer,
        `process.channel?.ref();\nimport('node:url').then(({ pathToFileURL }) => import(pathToFileURL(process.env.pm_exec_path).href));\n`,
      );
      writeFileSync(fakeApi, `#!${process.execPath}
        const http = require('node:http');
        const { chmodSync, writeFileSync } = require('node:fs');
        const mode = process.env.FAKE_API_MODE;
        if (process.env.FAKE_CHILD_PID_FILE) writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(process.pid));
        if (mode === 'exit') process.exit(0);
        let server;
        if (mode === 'healthy' || mode === 'hung-health') {
          server = http.createServer((req, res) => {
            if (mode === 'hung-health') return;
            if (req.url !== '/health') { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', http_identity: { transport: 'unix_socket' } }));
          });
          server.listen(process.env.DATA_MCP_HTTP_SOCKET_PATH, () => {
            const socketMode = Number.parseInt(process.env.FAKE_SOCKET_MODE || '600', 8);
            chmodSync(process.env.DATA_MCP_HTTP_SOCKET_PATH, socketMode);
            if (process.env.FAKE_READY_FILE) writeFileSync(process.env.FAKE_READY_FILE, 'ready');
          });
          const stop = signal => {
            if (process.env.FAKE_TERM_FILE) writeFileSync(process.env.FAKE_TERM_FILE, signal);
            server.close(() => process.exit(0));
          };
          process.once('SIGTERM', () => stop('SIGTERM'));
          process.once('SIGINT', () => stop('SIGINT'));
        } else {
          // Intentionally install no signal handler. The runner's SIGTERM must
          // use the platform default and terminate this never-healthy child;
          // the separate healthy case below tests explicit signal forwarding.
          setInterval(() => {}, 1000);
        }
      `);
      chmodSync(fakeApi, 0o755);

      const spawnRunner = (name, mode, extra = {}, { viaPm2Import = false } = {}) => {
        const caseDir = join(runnerRoot, name);
        const socketPath = join(caseDir, 'api.sock');
        const envFile = join(caseDir, 'env');
        mkdirSync(caseDir, { recursive: true });
        const envValues = {
          DATA_MCP_HTTP_SOCKET_PATH: socketPath,
          KSHER_AGENT_DATA_MCP_RUNTIME_HOME: runtimeHome,
          KSHER_AGENT_DATA_MCP_PYTHON: '/usr/bin/python3.11',
          FAKE_API_MODE: mode,
          DATA_MCP_SERVICE_READY_TIMEOUT_MS: '200',
          DATA_MCP_SERVICE_KILL_GRACE_MS: '100',
          ...extra,
        };
        writeFileSync(envFile, [
          ...Object.entries(envValues).map(([key, value]) => `${key}=${quoteEnvValue(value)}`),
          '',
        ].join('\n'));
        const child = spawn(process.execPath, [viaPm2Import ? pm2ImportContainer : runner], {
          env: {
            ...process.env,
            KSHER_AGENT_DATA_MCP_ENV_FILE: envFile,
            ...(viaPm2Import ? { pm_exec_path: runner } : {}),
          },
          // PM2 fork mode keeps fd 3 as a live IPC channel. Preserve it in the
          // PM2-import fixture so setting process.exitCode without an explicit
          // exit would hang instead of producing a false green result.
          stdio: viaPm2Import
            ? ['ignore', 'pipe', 'pipe', 'ipc']
            : ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        return { child, socketPath, stderr: () => stderr };
      };

      const runnerMod = await import(pathToFileURL(runnerModule).href + `?timeouts=${Date.now()}`);
      const parsedLiteral = runnerMod.parseEnvFile(
        `SPECIAL='cash$ # space "double"'\nEMPTY=''\n`,
      );
      if (parsedLiteral.SPECIAL !== 'cash$ # space "double"' || parsedLiteral.EMPTY !== '') {
        fail('Data MCP env parser must preserve single-quoted literal values exactly');
      }
      expectFailure(
        () => runnerMod.parseEnvFile(`BROKEN='can't'\n`),
        'Data MCP env key BROKEN contains an unsupported single quote',
      );
      expectFailure(
        () => runnerMod.parseEnvFile('BROKEN="double quoted"\n'),
        'Data MCP env key BROKEN must use a single-quoted literal',
      );
      expectFailure(
        () => runnerMod.parseEnvFile('BROKEN=unquoted\n'),
        'Data MCP env key BROKEN must use a single-quoted literal',
      );
      const runtimeResolvedApi = runnerMod.resolveApiExecutable({
        KSHER_AGENT_DATA_MCP_PYTHON: '/usr/bin/python3.11',
        KSHER_AGENT_DATA_MCP_RUNTIME_HOME: runtimeHome,
      });
      if (runtimeResolvedApi !== fakeApi) {
        fail('API runner must resolve from runtime home and ignore the system-Python bootstrap key');
      }
      const explicitApi = join(runnerRoot, 'explicit-api');
      if (runnerMod.resolveApiExecutable({
        DATA_MCP_SERVICE_API_BIN: explicitApi,
        KSHER_AGENT_DATA_MCP_RUNTIME_HOME: join(runnerRoot, 'wrong-runtime'),
      }) !== explicitApi) {
        fail('DATA_MCP_SERVICE_API_BIN must take precedence over runtime home');
      }
      const defaultTimeouts = runnerMod.resolveServiceTimeouts({});
      if (defaultTimeouts.readyTimeoutMs !== 30_000 || defaultTimeouts.killGraceMs !== 8_000) {
        fail('API runner production timeout defaults must remain readiness=30000ms and kill-grace=8000ms');
      }
      const injectedTimeouts = runnerMod.resolveServiceTimeouts({
        DATA_MCP_SERVICE_READY_TIMEOUT_MS: '200',
        DATA_MCP_SERVICE_KILL_GRACE_MS: '100',
      });
      if (injectedTimeouts.readyTimeoutMs !== 200 || injectedTimeouts.killGraceMs !== 100) {
        fail('API runner must honor separate readiness and kill-grace test overrides');
      }

      const hungHealthSocket = join(runnerRoot, 'hung-health-request.sock');
      const hungHealthConnections = new Set();
      const hungHealthServer = createServer(socket => {
        hungHealthConnections.add(socket);
        socket.once('close', () => hungHealthConnections.delete(socket));
      });
      await new Promise((resolve, reject) => {
        hungHealthServer.once('error', reject);
        hungHealthServer.listen(hungHealthSocket, resolve);
      });
      chmodSync(hungHealthSocket, 0o600);
      try {
        const healthResult = await Promise.race([
          runnerMod.healthRequest(hungHealthSocket),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('health request did not settle after its timeout')),
            2_000,
          )),
        ]);
        if (healthResult !== false) {
          fail('timed-out health request must settle as unhealthy');
        }
      } finally {
        const closed = new Promise(resolve => hungHealthServer.close(resolve));
        for (const socket of hungHealthConnections) socket.destroy();
        await closed;
      }

      const earlyExit = spawnRunner('early-exit', 'exit').child;
      const earlyExitResult = await waitForExit(earlyExit, 15_000, 'early-exit runner');
      if (earlyExitResult.code === 0) {
        fail('API runner must exit non-zero when its child exits before readiness');
      }

      const pm2ImportedEarlyExit = spawnRunner(
        'pm2-import-early-exit',
        'exit',
        {},
        { viaPm2Import: true },
      ).child;
      const pm2ImportedEarlyExitResult = await waitForExit(
        pm2ImportedEarlyExit,
        2_000,
        'PM2-imported early-exit runner',
      );
      if (pm2ImportedEarlyExitResult.code === 0) {
        fail('PM2-imported service entry must execute the API runner');
      }

      const noHealth = spawnRunner('no-health', 'no-health').child;
      const noHealthResult = await waitForExit(noHealth, 15_000, 'no-health runner');
      if (noHealthResult.code === 0) {
        fail('API runner must exit non-zero when Unix-socket health never becomes ready');
      }

      const hungHealth = spawnRunner('hung-health', 'hung-health').child;
      const hungHealthResult = await waitForExit(hungHealth, 15_000, 'hung-health runner');
      if (hungHealthResult.code === 0) {
        fail('API runner readiness deadline must win when a health request never responds');
      }

      const unsafeSocket = spawnRunner('unsafe-socket', 'healthy', {
        DATA_MCP_SERVICE_READY_TIMEOUT_MS: '5000',
        FAKE_SOCKET_MODE: '666',
      });
      const unsafeSocketResult = await waitForExit(
        unsafeSocket.child,
        15_000,
        'unsafe-socket runner',
      );
      if (unsafeSocketResult.code === 0) {
        fail('API runner must fail closed when Unix-socket permissions are not 0600');
      }
      if (!unsafeSocket.stderr().includes('Unix socket permissions must be 0600, got 0666')) {
        fail(`API runner must report the unsafe Unix-socket permission without changing it; got ${JSON.stringify(unsafeSocket.stderr())}`);
      }

      const signalCaseDir = join(runnerRoot, 'signal');
      const readyFile = join(signalCaseDir, 'ready');
      const termFile = join(signalCaseDir, 'term');
      const childPidFile = join(signalCaseDir, 'child.pid');
      const signalRun = spawnRunner('signal', 'healthy', {
        // A successful child should be observed by condition, not raced against
        // the deliberately tiny timeout used by the never-healthy case.
        DATA_MCP_SERVICE_READY_TIMEOUT_MS: '5000',
        FAKE_READY_FILE: readyFile,
        FAKE_TERM_FILE: termFile,
        FAKE_CHILD_PID_FILE: childPidFile,
      }).child;
      await waitForFile(readyFile);
      const fakeChildPid = Number(readFileSync(childPidFile, 'utf8'));
      const signalSentAt = Date.now();
      signalRun.kill('SIGTERM');
      const signalResult = await waitForExit(signalRun, 15_000, 'signal runner');
      if (signalResult.code !== 0) {
        fail(`API runner must exit cleanly after forwarding SIGTERM, got ${signalResult.code}`);
      }
      if (Date.now() - signalSentAt > 1_000) {
        fail('ready API runner must exit within kill-grace scale after SIGTERM, not wait for readiness deadline');
      }
      await waitForFile(termFile);
      if (readFileSync(termFile, 'utf8') !== 'SIGTERM') {
        fail('API runner must forward SIGTERM to the API child first');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
      if (!Number.isInteger(fakeChildPid) || processExists(fakeChildPid)) {
        fail('API runner must not leave an orphan API child after SIGTERM');
      }
    } finally {
      rmSync(runnerRoot, { recursive: true, force: true });
    }
  }

  if (mcp.transport === 'stdio') {
    if (mcp.command?.[0] !== 'node' || mcp.command?.[1] !== './mcp/server.js') {
      fail('template stdio MCP must use the dist-relative ./mcp/server.js entry');
    }
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'template-test', version: '1' } },
    };
    const listTools = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    };
    const missingIdentityCall = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'validate_sql_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c' },
      },
    };
    const missingUnionCall = {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'validate_sql_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c' },
        _meta: {
          botmuxTrustedCaller: {
            requestUserOpenId: 'ou_only_open_id',
            requestLarkAppId: 'cli_test',
          },
        },
      },
    };
    const missingSqlCall = {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'validate_sql_for_user',
        arguments: { datasource: 'tchouse-c' },
        _meta: {
          botmuxTrustedCaller: {
            requestUserOpenId: 'ou_test',
            requestUserUnionId: 'on_test',
            requestLarkAppId: 'cli_test',
          },
        },
      },
    };
    const forgedAccountExportCall = {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'export_query_to_excel_file',
        arguments: {
          sql: 'SELECT 1',
          datasource: 'tchouse-c',
          filename: 'result',
          max_export_rows: 10,
          request_user_tchouse_account: 'forged_account',
        },
        _meta: {
          botmuxTrustedCaller: {
            requestUserOpenId: 'ou_test',
            requestUserUnionId: 'on_test',
            requestLarkAppId: 'cli_test',
          },
        },
      },
    };
    const explicitBotCall = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'run_query_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c' },
        _meta: {
          botmuxTrustedCaller: {
            requestUserOpenId: 'ou_bot',
            requestUserUnionId: 'on_bot',
            requestLarkAppId: 'cli_test',
            senderType: 'bot',
          },
        },
      },
    };
    const scheduleCreatorCall = {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'validate_sql_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c' },
        _meta: {
          botmuxTrustedCaller: {
            requestUserOpenId: 'ou_creator',
            requestUserUnionId: 'on_creator',
            requestLarkAppId: 'cli_test',
            source: 'schedule_creator',
            taskId: 'task_123',
            turnId: 'schedule:task_123:turn-1',
          },
        },
      },
    };
    const mismatchedScheduleValidateCall = {
      jsonrpc: '2.0', id: 22, method: 'tools/call',
      params: {
        name: 'validate_sql_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c' },
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_creator', requestUserUnionId: 'on_creator',
          requestLarkAppId: 'cli_test', source: 'schedule_creator',
          taskId: '95677299', turnId: 'schedule:4e177326:3542f551-test',
        } },
      },
    };
    const mismatchedScheduleRunCall = {
      jsonrpc: '2.0', id: 23, method: 'tools/call',
      params: {
        name: 'run_query_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c', query_plan_id: 'qp_test' },
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_creator', requestUserUnionId: 'on_creator',
          requestLarkAppId: 'cli_test', source: 'schedule_creator',
          taskId: '95677299', turnId: 'schedule:4e177326:3542f551-test',
        } },
      },
    };
    const mismatchedScheduleExportCall = {
      jsonrpc: '2.0', id: 24, method: 'tools/call',
      params: {
        name: 'export_query_to_excel_file',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c', query_plan_id: 'qp_test' },
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_creator', requestUserUnionId: 'on_creator',
          requestLarkAppId: 'cli_test', source: 'schedule_creator',
          taskId: '95677299', turnId: 'schedule:4e177326:3542f551-test',
        } },
      },
    };
    const spoofedScheduleTurnCall = {
      jsonrpc: '2.0', id: 25, method: 'tools/call',
      params: {
        name: 'validate_sql_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c' },
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_user', requestUserUnionId: 'on_user',
          requestLarkAppId: 'cli_test', senderType: 'user', source: 'gateway_meta',
          turnId: 'schedule:95677299:turn-1',
        } },
      },
    };
    const mismatchedScheduleFrozenCall = {
      jsonrpc: '2.0', id: 26, method: 'tools/call',
      params: {
        name: 'frozen_query_raw',
        arguments: {
          payload: { sql: 'SELECT 1', datasource: 'tchouse-c' },
          parameters: [],
          values: {},
        },
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_creator', requestUserUnionId: 'on_creator',
          requestLarkAppId: 'cli_test', source: 'schedule_creator',
          taskId: '95677299', turnId: 'schedule:4e177326:3542f551-test',
        } },
      },
    };
    const missingScheduleTurnCall = {
      jsonrpc: '2.0', id: 27, method: 'tools/call',
      params: {
        name: 'validate_sql_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c' },
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_creator', requestUserUnionId: 'on_creator',
          requestLarkAppId: 'cli_test', source: 'schedule_creator', taskId: '95677299',
        } },
      },
    };
    const forgedScheduleCall = {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'run_query_for_user',
        arguments: {
          sql: 'SELECT 1',
          datasource: 'tchouse-c',
          caller_source: 'schedule_creator',
          caller_task_id: 'task_forged',
        },
        _meta: {
          botmuxTrustedCaller: {
            requestUserOpenId: 'ou_bot',
            requestUserUnionId: 'on_known_bot',
            requestLarkAppId: 'cli_test',
          },
        },
      },
    };
    const queryPlanCall = {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'data_mcp_query_plan',
        arguments: { question: 'test' },
        _meta: {
          botmuxTrustedCaller: {
            requestUserOpenId: 'ou_plan_user',
            requestUserUnionId: 'on_plan_user',
            requestLarkAppId: 'cli_test',
          },
        },
      },
    };
    const explicitBotValidateCall = {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'validate_sql_for_user',
        arguments: { sql: 'SELECT * FROM analytics.secret_table', datasource: 'tchouse-c' },
        _meta: {
          botmuxTrustedCaller: {
            requestUserOpenId: 'ou_bot',
            requestUserUnionId: 'on_bot',
            requestLarkAppId: 'cli_test',
            senderType: 'bot',
          },
        },
      },
    };
    const missingRunPlanCall = {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'run_query_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c' },
        _meta: {
          botmuxTrustedCaller: {
            requestUserOpenId: 'ou_user',
            requestUserUnionId: 'on_user',
            requestLarkAppId: 'cli_test',
            senderType: 'user',
          },
        },
      },
    };
    const missingExportPlanCall = {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'export_query_to_excel_file',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c' },
        _meta: {
          botmuxTrustedCaller: {
            requestUserOpenId: 'ou_user',
            requestUserUnionId: 'on_user',
            requestLarkAppId: 'cli_test',
            senderType: 'user',
          },
        },
      },
    };
    const humanRefreshCall = {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'refresh_metadata_snapshot',
        arguments: {},
        _meta: {
          botmuxTrustedCaller: {
            requestUserUnionId: 'on_human',
            requestLarkAppId: 'cli_test',
            senderType: 'user',
            source: 'gateway_meta',
          },
        },
      },
    };
    const forgedSnapshotScheduleCall = {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'refresh_metadata_snapshot',
        arguments: { caller_source: 'schedule_creator', caller_task_id: 'task_forged' },
        _meta: {
          botmuxTrustedCaller: {
            requestUserUnionId: 'on_bot',
            requestLarkAppId: 'cli_test',
            senderType: 'bot',
          },
        },
      },
    };
    const missingSnapshotQueryCall = {
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: {
        name: 'search_metadata_snapshot',
        arguments: {},
        _meta: { botmuxTrustedCaller: { requestUserUnionId: 'on_bot', senderType: 'bot' } },
      },
    };
    const inspectionWithoutTurnCall = {
      jsonrpc: '2.0', id: 18, method: 'tools/call',
      params: {
        name: 'inspect_ck_subjects_by_table',
        arguments: { target_tables: ['demo.orders'] },
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_user', requestUserUnionId: 'on_user',
          requestLarkAppId: 'cli_test', senderType: 'user',
        } },
      },
    };
    const emptySubjectScopeCall = {
      jsonrpc: '2.0', id: 19, method: 'tools/call',
      params: {
        name: 'inspect_ck_resources_by_subject', arguments: {},
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_user', requestUserUnionId: 'on_user',
          requestLarkAppId: 'cli_test', senderType: 'user', turnId: 'turn-1',
        } },
      },
    };
    const excessiveTableScopeCall = {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: {
        name: 'inspect_ck_subjects_by_table',
        arguments: {
          target_tables: Array.from({ length: 51 }, (_, index) => `demo.table_${index}`),
        },
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_user', requestUserUnionId: 'on_user',
          requestLarkAppId: 'cli_test', senderType: 'user', turnId: 'turn-1',
        } },
      },
    };
    const invalidDatasourceCall = {
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: {
        name: 'validate_sql_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-d' },
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_user', requestUserUnionId: 'on_user',
          requestLarkAppId: 'cli_test', senderType: 'user',
        } },
      },
    };
    const input = [
      initialize,
      listTools,
      missingIdentityCall,
      missingUnionCall,
      missingSqlCall,
      forgedAccountExportCall,
      explicitBotCall,
      scheduleCreatorCall,
      forgedScheduleCall,
      queryPlanCall,
      explicitBotValidateCall,
      missingRunPlanCall,
      missingExportPlanCall,
      humanRefreshCall,
      forgedSnapshotScheduleCall,
      missingSnapshotQueryCall,
      inspectionWithoutTurnCall,
      emptySubjectScopeCall,
      excessiveTableScopeCall,
      invalidDatasourceCall,
      mismatchedScheduleValidateCall,
      mismatchedScheduleRunCall,
      mismatchedScheduleExportCall,
      spoofedScheduleTurnCall,
      mismatchedScheduleFrozenCall,
      missingScheduleTurnCall,
    ].map(message => JSON.stringify(message)).join('\n') + '\n';
    const probe = spawnSync(process.execPath, [join(cleanRoot, 'mcp', 'server.js')], {
      cwd: cleanRoot,
      input,
      encoding: 'utf-8',
      timeout: 5000,
      env: {
        ...process.env,
        BOTMUX_SESSION_ID: 'session_validate_probe',
        BOTMUX_TRUSTED_TURN_FILE: '',
        SESSION_DATA_DIR: '',
        DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
        DATA_MCP_EXPORT_QUERY_ENDPOINT: 'data:application/json,%7B%22ok%22%3Atrue%7D',
        DATA_MCP_VALIDATE_SQL_ENDPOINT: 'data:application/json,%7B%22status%22%3A%22success%22%2C%22datasource%22%3A%22tchouse-c%22%2C%22tables%22%3A%5B%22analytics.secret_table%22%5D%2C%22columns%22%3A%5B%22secret_col%22%5D%2C%22normalized_sql%22%3A%22SELECT%20*%20FROM%20analytics.secret_table%22%2C%22sql_account_binding%22%3A%7B%22tchouse_account%22%3A%22secret_user%22%7D%7D',
      },
    });
    if (probe.status !== 0) fail(`template MCP initialize probe failed: ${probe.stderr}`);
    const responses = (probe.stdout ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const byId = new Map(responses.map(response => [response.id, response]));
    if (byId.get(1)?.result?.serverInfo?.name !== pkg.botmux.id) {
      fail('template MCP server did not return a valid initialize response');
    }
    if (byId.get(1)?.result?.serverInfo?.version !== pkg.version) {
      fail('template MCP serverInfo.version must match package.json version');
    }
    const tools = byId.get(2)?.result?.tools ?? [];
    for (const name of ['data_mcp_identity_probe', 'data_mcp_query_plan', 'validate_sql_for_user', 'run_query_for_user', 'frozen_query_raw', 'export_query_to_excel_file', 'refresh_metadata_snapshot', 'search_metadata_snapshot', 'audit_ck_default_role_baseline', 'inspect_ck_subjects_by_table', 'inspect_ck_resources_by_subject']) {
      if (!tools.some(tool => tool.name === name)) fail(`MCP tools/list is missing ${name}`);
    }
    if (tools.some(tool => tool.name === 'execute_frozen_query')) {
      fail('retired MCP tool execute_frozen_query must not be exposed');
    }
    const removedClusterComparisonTool = 'audit_ck_' + 'access_consistency';
    if (tools.some(tool => tool.name === removedClusterComparisonTool)) {
      fail('removed cluster comparison tool must not be exposed');
    }
    const visibleValidateSchema = tools.find(tool => tool.name === 'validate_sql_for_user')?.inputSchema;
    if (
      JSON.stringify(visibleValidateSchema).includes('request_user_union_id')
      || JSON.stringify(visibleValidateSchema).includes('caller_session_id')
      || JSON.stringify(visibleValidateSchema).includes('max_runs')
    ) {
      fail('validate_sql_for_user schema must not expose trusted identity arguments');
    }
    const visibleRunSchema = tools.find(tool => tool.name === 'run_query_for_user')?.inputSchema;
    const visibleFrozenSchema = tools.find(tool => tool.name === 'frozen_query_raw')?.inputSchema;
    const visibleExportSchema = tools.find(tool => tool.name === 'export_query_to_excel_file')?.inputSchema;
    if (
      JSON.stringify(visibleFrozenSchema).includes('requestUser')
      || JSON.stringify(visibleFrozenSchema).includes('request_user')
      || JSON.stringify(visibleFrozenSchema).includes('caller')
      || JSON.stringify(visibleFrozenSchema).includes('identity')
    ) {
      fail('frozen_query_raw schema must not expose trusted identity arguments');
    }
    if (visibleValidateSchema?.required?.includes('query_plan_id')) {
      fail('validate_sql_for_user must not require query_plan_id before it can issue one');
    }
    if (!visibleRunSchema?.required?.includes('query_plan_id')) {
      fail('run_query_for_user schema must require query_plan_id');
    }
    if (!visibleExportSchema?.required?.includes('query_plan_id')) {
      fail('export_query_to_excel_file schema must require query_plan_id');
    }
    for (const [name, schema] of [
      ['validate_sql_for_user', visibleValidateSchema],
      ['run_query_for_user', visibleRunSchema],
      ['export_query_to_excel_file', visibleExportSchema],
    ]) {
      if (JSON.stringify(schema?.properties?.datasource?.enum) !== JSON.stringify(['tchouse-c'])) {
        fail(`${name} datasource schema must allow only tchouse-c`);
      }
    }
    if (
      JSON.stringify(visibleValidateSchema?.properties?.execution_mode?.enum)
      !== JSON.stringify(['single', 'compare'])
    ) {
      fail('validate_sql_for_user execution_mode must expose only single|compare');
    }
    const visibleRefreshSchema = tools.find(tool => tool.name === 'refresh_metadata_snapshot')?.inputSchema;
    const visibleSearchSchema = tools.find(tool => tool.name === 'search_metadata_snapshot')?.inputSchema;
    const visibleDefaultRoleSchema = tools.find(tool => tool.name === 'audit_ck_default_role_baseline')?.inputSchema;
    const visibleSubjectsSchema = tools.find(tool => tool.name === 'inspect_ck_subjects_by_table')?.inputSchema;
    const visibleResourcesSchema = tools.find(tool => tool.name === 'inspect_ck_resources_by_subject')?.inputSchema;
    if (Object.keys(visibleRefreshSchema?.properties ?? {}).length !== 0) {
      fail('refresh_metadata_snapshot must not expose identity, SQL, table, or task arguments');
    }
    if (
      JSON.stringify(visibleSearchSchema).includes('identity')
      || JSON.stringify(visibleSearchSchema).includes('endpoint')
      || !visibleSearchSchema?.required?.includes('query')
    ) {
      fail('search_metadata_snapshot must expose only local query controls and require query');
    }
    if (Object.keys(visibleDefaultRoleSchema?.properties ?? {}).length !== 0) {
      fail('audit_ck_default_role_baseline must not expose account enumeration or identity arguments');
    }
    if (
      JSON.stringify(visibleSubjectsSchema).includes('sql')
      || JSON.stringify(visibleSubjectsSchema).includes('request_user_')
      || JSON.stringify(visibleSubjectsSchema?.required) !== JSON.stringify(['target_tables'])
      || visibleSubjectsSchema?.properties?.target_tables?.maxItems !== 50
    ) {
      fail('inspect_ck_subjects_by_table must expose only an explicit bounded table list');
    }
    if (
      JSON.stringify(visibleResourcesSchema).includes('sql')
      || JSON.stringify(visibleResourcesSchema).includes('request_user_')
      || JSON.stringify(Object.keys(visibleResourcesSchema?.properties ?? {}).sort())
        !== JSON.stringify(['target_accounts', 'target_roles'])
    ) {
      fail('inspect_ck_resources_by_subject must expose only explicit account/role lists');
    }
    if (byId.get(3)?.error?.message !== 'trusted_identity_required') {
      fail('MCP server must fail closed when Botmux trusted identity is absent');
    }
    const missingUnionText = byId.get(4)?.result?.content?.[0]?.text ?? '';
    if (!missingUnionText.includes('missing_trusted_union_id')) {
      fail('MCP server must fail closed when trusted union_id is absent');
    }
    const missingSqlText = byId.get(5)?.result?.content?.[0]?.text ?? '';
    if (!missingSqlText.includes('missing_sql')) {
      fail('MCP server must validate sql before calling Data MCP service');
    }
    const forgedAccountText = byId.get(6)?.result?.content?.[0]?.text ?? '';
    if (forgedAccountText.includes('request_user_tchouse_account') || forgedAccountText.includes('forged_account')) {
      fail('MCP server must not forward model-supplied database account arguments');
    }
    const explicitBotText = byId.get(7)?.result?.content?.[0]?.text ?? '';
    if (!explicitBotText.includes('trusted_human_or_schedule_required')) {
      fail('MCP server must reject explicit non-human callers on data-returning tools without schedule_creator context');
    }
    const scheduleCreatorText = byId.get(8)?.result?.content?.[0]?.text ?? '';
    if (!scheduleCreatorText.includes('"status":"success"') && !scheduleCreatorText.includes('"status": "success"')) {
      fail('MCP server must allow schedule_creator callers when taskId is present');
    }
    for (const id of [22, 23, 24, 26]) {
      const mismatchText = byId.get(id)?.result?.content?.[0]?.text ?? '';
      if (
        !mismatchText.includes('schedule_turn_identity_mismatch')
        || !mismatchText.includes('95677299')
        || !mismatchText.includes('schedule:4e177326:3542f551-test')
      ) {
        fail('query and export tools must reject mismatched schedule task/turn identity with an explicit reason');
      }
    }
    const spoofedScheduleTurnText = byId.get(25)?.result?.content?.[0]?.text ?? '';
    if (!spoofedScheduleTurnText.includes('schedule_turn_source_mismatch')) {
      fail('schedule turn ids must require caller_source=schedule_creator');
    }
    const missingScheduleTurnText = byId.get(27)?.result?.content?.[0]?.text ?? '';
    if (!missingScheduleTurnText.includes('schedule_turn_identity_mismatch')) {
      fail('schedule_creator callers must carry a matching schedule turn id');
    }
    const forgedScheduleText = byId.get(9)?.result?.content?.[0]?.text ?? '';
    if (!forgedScheduleText.includes('trusted_human_or_schedule_required') || forgedScheduleText.includes('task_forged')) {
      fail('model-supplied caller_source/caller_task_id must not bypass trusted caller policy on data-returning tools');
    }
    const queryPlanText = byId.get(10)?.result?.content?.[0]?.text ?? '';
    if (queryPlanText.includes('on_plan_user') || queryPlanText.includes('ou_plan_user')) {
      fail('data_mcp_query_plan must not expose raw trusted caller identifiers');
    }
    const explicitBotValidateText = byId.get(11)?.result?.content?.[0]?.text ?? '';
    if (
      !explicitBotValidateText.includes('schema_detail_redacted') ||
      !explicitBotValidateText.includes('trusted_human_or_schedule_required') ||
      explicitBotValidateText.includes('query_plan_id') ||
      explicitBotValidateText.includes('table_access_allowed') ||
      explicitBotValidateText.includes('analytics.secret_table') ||
      explicitBotValidateText.includes('secret_col')
    ) {
      fail('MCP server must collapse validation responses for non-human callers without schema or permission oracle details');
    }
    const missingRunPlanText = byId.get(12)?.result?.content?.[0]?.text ?? '';
    if (!missingRunPlanText.includes('query_plan_required')) {
      fail('run_query_for_user must fail closed when query_plan_id is missing');
    }
    const missingExportPlanText = byId.get(13)?.result?.content?.[0]?.text ?? '';
    if (!missingExportPlanText.includes('query_plan_required')) {
      fail('export_query_to_excel_file must fail closed when query_plan_id is missing');
    }
    const humanRefreshText = byId.get(14)?.result?.content?.[0]?.text ?? '';
    if (!humanRefreshText.includes('metadata_snapshot_schedule_identity_required')) {
      fail('refresh_metadata_snapshot must reject a normal human turn');
    }
    const forgedSnapshotScheduleText = byId.get(15)?.result?.content?.[0]?.text ?? '';
    if (
      !forgedSnapshotScheduleText.includes('metadata_snapshot_schedule_identity_required')
      || forgedSnapshotScheduleText.includes('task_forged')
    ) {
      fail('model arguments must not forge schedule identity for refresh_metadata_snapshot');
    }
    const missingSnapshotQueryText = byId.get(16)?.result?.content?.[0]?.text ?? '';
    if (!missingSnapshotQueryText.includes('metadata_snapshot_query_required')) {
      fail('search_metadata_snapshot must reject an empty query before service access');
    }
    const inspectionWithoutTurnText = byId.get(18)?.result?.content?.[0]?.text ?? '';
    if (!inspectionWithoutTurnText.includes('access_inspection_turn_required')) {
      fail('access inspection must require a host-injected turn id');
    }
    const emptySubjectScopeText = byId.get(19)?.result?.content?.[0]?.text ?? '';
    if (!emptySubjectScopeText.includes('invalid_access_inspection_scope')) {
      fail('resources-by-subject must reject an empty account/role scope');
    }
    const excessiveTableScopeText = byId.get(20)?.result?.content?.[0]?.text ?? '';
    if (!excessiveTableScopeText.includes('invalid_access_inspection_scope')) {
      fail('subjects-by-table must reject more than 50 target tables before service access');
    }
    const invalidDatasourceText = byId.get(21)?.result?.content?.[0]?.text ?? '';
    if (!invalidDatasourceText.includes('unsupported_datasource')) {
      fail('public query tools must reject non-tchouse-c datasource before service access');
    }

    const missingSessionCall = {
      jsonrpc: '2.0', id: 22, method: 'tools/call',
      params: {
        name: 'validate_sql_for_user',
        arguments: { sql: 'SELECT 1', datasource: 'tchouse-c' },
        _meta: { botmuxTrustedCaller: {
          requestUserOpenId: 'ou_user', requestUserUnionId: 'on_user',
          requestLarkAppId: 'cli_test', senderType: 'user',
        } },
      },
    };
    const missingSessionProbe = spawnSync(process.execPath, [join(cleanRoot, 'mcp', 'server.js')], {
      cwd: cleanRoot,
      input: [initialize, missingSessionCall].map(message => JSON.stringify(message)).join('\n') + '\n',
      encoding: 'utf-8',
      timeout: 5000,
      env: {
        ...process.env,
        BOTMUX_SESSION_ID: '',
        BOTMUX_EXECUTION_ID: '',
        BOTMUX_TRUSTED_TURN_FILE: '',
        SESSION_DATA_DIR: '',
        DATA_MCP_SERVICE_SOCKET_PATH: 'disabled',
        DATA_MCP_VALIDATE_SQL_ENDPOINT: 'data:application/json,%7B%22downstream_called%22%3Atrue%7D',
      },
    });
    if (missingSessionProbe.status !== 0) {
      fail(`missing-session MCP probe failed: ${missingSessionProbe.stderr}`);
    }
    const missingSessionResponses = (missingSessionProbe.stdout ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const missingSessionText = missingSessionResponses
      .find(response => response.id === 22)?.result?.content?.[0]?.text ?? '';
    if (!missingSessionText.includes('query_plan_session_required')) {
      fail('public query tools must fail closed when both session and execution context are absent');
    }
    if (missingSessionText.includes('downstream_called')) {
      fail('missing-session rejection must not call the downstream Data MCP service');
    }

    const socketPath = join(cleanRoot, 'data-mcp-api.sock');
    const socketReadyFile = join(cleanRoot, 'data-mcp-api-socket-ready');
    const socketServer = spawn(process.execPath, ['-e', `
      const http = require('node:http');
      const { chmodSync, writeFileSync } = require('node:fs');
      const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          if (req.headers['x-internal-auth']) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'validation_error', issues: [{ code: 'shared_token_used' }] }));
            return;
          }
          if (req.url === '/agent/search-metadata-snapshot') {
            if (parsed.query !== '账单' || parsed.priority !== '1' || parsed.limit !== 3) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ status: 'validation_error', issues: [{ code: 'wrong_search_payload' }] }));
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', transport: 'unix_socket', endpoint: req.url }));
            return;
          }
          const frozenSql = "SELECT '\\\\\\\\'' OR 1=1 --' AS probe";
          const expectedContextId = parsed.sql === '  SELECT execution_context  '
            ? 'execution_socket_probe'
            : parsed.sql === 'SELECT precedence_context'
              ? 'session_precedence_probe'
              : 'session_socket_probe';
          const failureCode = parsed.request_user_union_id !== 'on_socket_user'
            ? 'wrong_union_id'
            : (
                ['/agent/run-query', '/agent/validate-sql'].includes(req.url)
                && parsed.caller_session_id !== expectedContextId
              )
              ? 'wrong_execution_context'
              : req.url === '/agent/validate-sql'
                && parsed.execution_mode !== (
                  parsed.sql === frozenSql
                    || /^SELECT (?:query_timeout|datasource_unreachable|http_403|run_query_timeout|missing_union_id|trusted_human_or_schedule_required|account_mapping_unavailable|account_mismatch|query_concurrency_limit|restricted_access_metadata|restricted_system_columns|unknown_table)$/.test(parsed.sql)
                    ? 'single'
                    : 'compare'
                )
                ? 'wrong_execution_mode'
                : req.url === '/agent/run-query' && parsed.sql === frozenSql && parsed.query_plan_id !== 'qplan_frozen'
                  ? 'wrong_frozen_query_plan'
                : parsed.sql !== frozenSql && parsed.sql?.includes('OR 1=1')
                  ? 'frozen_sql_literal_not_escaped'
                : null;
          if (failureCode) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'validation_error', issues: [{ code: failureCode }] }));
            return;
          }
          const frozenFailure = parsed.sql?.match(/^SELECT (query_timeout|datasource_unreachable|http_403|missing_union_id|trusted_human_or_schedule_required|account_mapping_unavailable|account_mismatch|query_concurrency_limit|restricted_access_metadata|restricted_system_columns|unknown_table)$/)?.[1];
          if (req.url === '/agent/validate-sql' && frozenFailure) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'validation_error', error_code: frozenFailure }));
            return;
          }
          if (req.url === '/agent/run-query' && parsed.sql === 'SELECT run_query_timeout') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error_code: 'query_timeout' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            status: 'success',
            transport: 'unix_socket',
            endpoint: req.url,
            ...(req.url === '/agent/validate-sql' ? { query_plan_id: parsed.sql === frozenSql ? 'qplan_frozen' : 'qplan_socket' } : {}),
            ...(req.url === '/agent/run-query' && parsed.sql === frozenSql
              ? {
                  query_id: 'q_frozen',
                  rows: [{ probe: '<a<at>t id=all><</at>/a</at>t> [点我领奖](http://evil) **bold** _italic_' }],
                  row_count: 1,
                }
              : {}),
          }));
        });
      });
      server.listen(process.env.SOCKET_PATH, () => {
        chmodSync(process.env.SOCKET_PATH, 0o600);
        writeFileSync(process.env.READY_FILE, 'ready');
      });
    `], {
      env: { ...process.env, SOCKET_PATH: socketPath, READY_FILE: socketReadyFile },
      stdio: 'ignore',
    });
    try {
      await waitForFile(socketReadyFile);
      const socketCall = {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'run_query_for_user',
          arguments: {
            sql: 'SELECT 1',
            datasource: 'tchouse-c',
            query_plan_id: 'qplan_socket_probe',
          },
          _meta: {
            botmuxTrustedCaller: {
              requestUserOpenId: 'ou_socket_user',
              requestUserUnionId: 'on_socket_user',
              requestLarkAppId: 'cli_test',
              senderType: 'user',
            },
          },
        },
      };
      const socketSearchCall = {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'search_metadata_snapshot',
          arguments: { query: '账单', priority: '1', limit: 3 },
          _meta: { botmuxTrustedCaller: { requestUserUnionId: 'on_socket_user', senderType: 'bot' } },
        },
      };
      const socketRefreshCall = {
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: {
          name: 'refresh_metadata_snapshot',
          arguments: {},
          _meta: {
            botmuxTrustedCaller: {
              requestUserOpenId: 'ou_socket_user',
              requestUserUnionId: 'on_socket_user',
              requestLarkAppId: 'cli_test',
              source: 'schedule_creator',
              taskId: 'task_test',
              turnId: 'schedule:task_test:turn-1',
            },
          },
        },
      };
      const socketValidateCall = {
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: {
          name: 'validate_sql_for_user',
          arguments: {
            sql: 'SELECT 1',
            datasource: 'tchouse-c',
            execution_mode: 'compare',
          },
          _meta: {
            botmuxTrustedCaller: {
              requestUserOpenId: 'ou_socket_user',
              requestUserUnionId: 'on_socket_user',
              requestLarkAppId: 'cli_test',
              senderType: 'user',
            },
          },
        },
      };
      const frozenQueryCall = {
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/call',
        params: {
          name: 'frozen_query_raw',
          arguments: {
            payload: { sql: 'SELECT {{value}} AS probe', datasource: 'tchouse-c' },
            parameters: [{ name: 'value', type: 'string' }],
            values: { value: "\\' OR 1=1 --" },
            requestUserUnionId: 'on_forged_argument',
          },
          _meta: {
            botmuxTrustedCaller: {
              requestUserOpenId: 'ou_socket_user',
              requestUserUnionId: 'on_socket_user',
              requestLarkAppId: 'cli_test',
              senderType: 'user',
            },
          },
        },
      };
      const frozenInvalidValuesCall = {
        ...frozenQueryCall,
        id: 19,
        params: {
          ...frozenQueryCall.params,
          arguments: {
            ...frozenQueryCall.params.arguments,
            values: { sql: 'not-a-command-parameter' },
          },
        },
      };
      const frozenErrorCalls = [
        ['query_timeout', 'timeout', 20],
        ['datasource_unreachable', 'temporarily_unavailable', 21],
        ['http_403', 'permission_denied', 22],
        ['run_query_timeout', 'timeout', 23],
        ['missing_union_id', 'permission_denied', 24],
        ['trusted_human_or_schedule_required', 'permission_denied', 25],
        ['account_mapping_unavailable', 'permission_denied', 26],
        ['account_mismatch', 'permission_denied', 27],
        ['query_concurrency_limit', 'execution_failed', 28],
        ['restricted_access_metadata', 'permission_denied', 29],
        ['restricted_system_columns', 'permission_denied', 30],
        ['unknown_table', 'not_found', 31],
      ].map(([serviceCode, expectedCode, id]) => ({
        ...frozenQueryCall,
        id,
        expectedCode,
        params: {
          ...frozenQueryCall.params,
          arguments: {
            payload: { sql: `SELECT ${serviceCode}`, datasource: 'tchouse-c' },
            parameters: [],
            values: {},
          },
        },
      }));
      const socketProbe = spawnSync(process.execPath, [join(cleanRoot, 'mcp', 'server.js')], {
        cwd: cleanRoot,
        input: [
          initialize,
          socketCall,
          socketSearchCall,
          socketRefreshCall,
          socketValidateCall,
          frozenQueryCall,
          frozenInvalidValuesCall,
          ...frozenErrorCalls.map(({ expectedCode: _expectedCode, ...call }) => call),
        ]
          .map(message => JSON.stringify(message)).join('\n') + '\n',
        encoding: 'utf-8',
        timeout: 5000,
        env: {
          ...process.env,
          BOTMUX_SESSION_ID: 'session_socket_probe',
          BOTMUX_TRUSTED_TURN_FILE: '',
          SESSION_DATA_DIR: '',
          DATA_MCP_SERVICE_SOCKET_PATH: socketPath,
          DATA_MCP_INTERNAL_AUTH_TOKEN: 'token-that-must-not-be-sent-over-uds',
        },
      });
      if (socketProbe.status !== 0) fail(`template MCP Unix socket probe failed: ${socketProbe.stderr}`);
      const socketResponses = (socketProbe.stdout ?? '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      const socketText = socketResponses.find(response => response.id === 13)?.result?.content?.[0]?.text ?? '';
      if (!socketText.includes('"transport": "unix_socket"')) {
        fail('MCP server must call Data MCP service over Unix socket without forwarding a shared token');
      }
      const searchText = socketResponses.find(response => response.id === 14)?.result?.content?.[0]?.text ?? '';
      if (!searchText.includes('/agent/search-metadata-snapshot')) {
        fail('search_metadata_snapshot must forward local query controls over the shared Unix socket');
      }
      const refreshText = socketResponses.find(response => response.id === 15)?.result?.content?.[0]?.text ?? '';
      if (!refreshText.includes('/agent/refresh-metadata-snapshot')) {
        fail('refresh_metadata_snapshot must forward host-injected schedule identity over the shared Unix socket');
      }
      const validateText = socketResponses.find(response => response.id === 16)?.result?.content?.[0]?.text ?? '';
      if (!validateText.includes('/agent/validate-sql')) {
        fail('validate_sql_for_user must forward session binding and compare mode over the shared Unix socket');
      }
      const frozenText = socketResponses.find(response => response.id === 17)?.result?.content?.[0]?.text ?? '';
      const frozenPayload = JSON.parse(frozenText);
      if (
        frozenPayload.query_id !== 'q_frozen'
        || frozenPayload.row_count !== 1
        || !Array.isArray(frozenPayload.rows)
        || frozenPayload.rows[0]?.probe !== '<a<at>t id=all><</at>/a</at>t> [点我领奖](http://evil) **bold** _italic_'
        || !Array.isArray(frozenPayload.columns)
        || frozenPayload.error_code !== null
        || frozenText.includes('OR 1=1')
        || frozenText.includes('on_forged_argument')
        || frozenText.includes('contractVersion')
        || frozenText.includes('blocks')
        || frozenText.includes('fallbackText')
      ) {
        fail(`frozen_query_raw must bind trusted identity, escape SQL literals, keep validate/run bytes identical, omit SQL, and return raw data fields: ${frozenText}`);
      }
      const frozenInvalidValuesPayload = JSON.parse(
        socketResponses.find(response => response.id === 19)?.result?.content?.[0]?.text ?? '{}',
      );
      if (
        frozenInvalidValuesPayload.error_code !== 'invalid_request'
        || frozenInvalidValuesPayload.row_count !== 0
        || frozenInvalidValuesPayload.query_id !== null
        || !Array.isArray(frozenInvalidValuesPayload.rows)
        || !Array.isArray(frozenInvalidValuesPayload.columns)
        || JSON.stringify(frozenInvalidValuesPayload).includes('parameter_required')
      ) {
        fail(`frozen_query_raw must expose only raw public error fields: ${JSON.stringify(frozenInvalidValuesPayload)}`);
      }
      for (const { id, expectedCode } of frozenErrorCalls) {
        const payload = JSON.parse(
          socketResponses.find(response => response.id === id)?.result?.content?.[0]?.text ?? '{}',
        );
        if (payload.error_code !== expectedCode) {
          fail(`frozen_query_raw must normalize service errors: expected ${expectedCode}, got ${JSON.stringify(payload)}`);
        }
      }

      const executionValidateCall = {
        ...socketValidateCall,
        id: 23,
        params: {
          ...socketValidateCall.params,
          arguments: { ...socketValidateCall.params.arguments, sql: '  SELECT execution_context  ' },
        },
      };
      const executionRunCall = {
        ...socketCall,
        id: 24,
        params: {
          ...socketCall.params,
          arguments: { ...socketCall.params.arguments, sql: '  SELECT execution_context  ' },
        },
      };
      const executionProbe = spawnSync(process.execPath, [join(cleanRoot, 'mcp', 'server.js')], {
        cwd: cleanRoot,
        input: [initialize, executionValidateCall, executionRunCall]
          .map(message => JSON.stringify(message)).join('\n') + '\n',
        encoding: 'utf-8',
        timeout: 5000,
        env: {
          ...process.env,
          BOTMUX_SESSION_ID: '   ',
          BOTMUX_EXECUTION_ID: '  execution_socket_probe  ',
          BOTMUX_TRUSTED_TURN_FILE: '',
          SESSION_DATA_DIR: '',
          DATA_MCP_SERVICE_SOCKET_PATH: socketPath,
        },
      });
      if (executionProbe.status !== 0) {
        fail(`sessionless execution-id MCP probe failed: ${executionProbe.stderr}`);
      }
      const executionResponses = (executionProbe.stdout ?? '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      for (const responseId of [23, 24]) {
        const responseText = executionResponses
          .find(response => response.id === responseId)?.result?.content?.[0]?.text ?? '';
        if (!responseText.includes('"transport": "unix_socket"')) {
          fail(
            `validate and run must forward the same execution id and byte-exact SQL when no session exists: ${responseText}`,
          );
        }
      }

      const precedenceCall = {
        ...socketValidateCall,
        id: 25,
        params: {
          ...socketValidateCall.params,
          arguments: { ...socketValidateCall.params.arguments, sql: 'SELECT precedence_context' },
        },
      };
      const precedenceProbe = spawnSync(process.execPath, [join(cleanRoot, 'mcp', 'server.js')], {
        cwd: cleanRoot,
        input: [initialize, precedenceCall].map(message => JSON.stringify(message)).join('\n') + '\n',
        encoding: 'utf-8',
        timeout: 5000,
        env: {
          ...process.env,
          BOTMUX_SESSION_ID: '  session_precedence_probe  ',
          BOTMUX_EXECUTION_ID: 'execution_must_not_win',
          BOTMUX_TRUSTED_TURN_FILE: '',
          SESSION_DATA_DIR: '',
          DATA_MCP_SERVICE_SOCKET_PATH: socketPath,
        },
      });
      if (precedenceProbe.status !== 0) {
        fail(`session-over-execution precedence probe failed: ${precedenceProbe.stderr}`);
      }
      const precedenceText = (precedenceProbe.stdout ?? '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .find(response => response.id === 25)?.result?.content?.[0]?.text ?? '';
      if (!precedenceText.includes('"transport": "unix_socket"')) {
        fail(
          `BOTMUX_SESSION_ID must take precedence when both execution contexts are present: ${precedenceText}`,
        );
      }
    } finally {
      socketServer.kill();
    }

    const httpErrorPortFile = join(cleanRoot, 'validate-http-error-port');
    const httpErrorServer = spawn(process.execPath, ['-e', `
      const http = require('node:http');
      const { writeFileSync } = require('node:fs');
      const body = JSON.stringify({
        status: 'validation_error',
        datasource: 'tchouse-c',
        tables: ['analytics.secret_table'],
        columns: ['secret_col'],
        normalized_sql: 'SELECT * FROM analytics.secret_table',
        sql_account_binding: { tchouse_account: 'secret_user' },
        issues: [{ code: 'table_not_allowed', severity: 'error' }],
      });
      const server = http.createServer((req, res) => {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(body);
      });
      server.listen(0, '127.0.0.1', () => {
        writeFileSync(process.env.PORT_FILE, String(server.address().port));
      });
    `], {
      env: { ...process.env, PORT_FILE: httpErrorPortFile },
      stdio: 'ignore',
    });
    try {
      await waitForFile(httpErrorPortFile);
      const httpErrorPort = readFileSync(httpErrorPortFile, 'utf-8').trim();
      const httpErrorValidateCall = {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'validate_sql_for_user',
          arguments: { sql: 'SELECT * FROM analytics.secret_table', datasource: 'tchouse-c' },
          _meta: {
            botmuxTrustedCaller: {
              requestUserOpenId: 'ou_bot',
              requestUserUnionId: 'on_bot',
              requestLarkAppId: 'cli_test',
              senderType: 'bot',
            },
          },
        },
      };
      const httpErrorProbe = spawnSync(process.execPath, [join(cleanRoot, 'mcp', 'server.js')], {
        cwd: cleanRoot,
        input: [initialize, httpErrorValidateCall].map(message => JSON.stringify(message)).join('\n') + '\n',
        encoding: 'utf-8',
        timeout: 5000,
        env: {
          ...process.env,
          BOTMUX_SESSION_ID: 'session_http_error_probe',
          BOTMUX_TRUSTED_TURN_FILE: '',
          SESSION_DATA_DIR: '',
          DATA_MCP_VALIDATE_SQL_ENDPOINT: `http://127.0.0.1:${httpErrorPort}/validate-error`,
        },
      });
      if (httpErrorProbe.status !== 0) fail(`template MCP HTTP error probe failed: ${httpErrorProbe.stderr}`);
      const httpErrorResponses = (httpErrorProbe.stdout ?? '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      const httpErrorText = httpErrorResponses.find(response => response.id === 12)?.result?.content?.[0]?.text ?? '';
      if (
        !httpErrorText.includes('Data MCP 服务返回 HTTP 403') ||
        !httpErrorText.includes('schema_detail_redacted') ||
        !httpErrorText.includes('trusted_human_or_schedule_required') ||
        httpErrorText.includes('endpoint') ||
        httpErrorText.includes(`127.0.0.1:${httpErrorPort}`) ||
        httpErrorText.includes('table_access_allowed') ||
        httpErrorText.includes('table_not_allowed') ||
        httpErrorText.includes('analytics.secret_table') ||
        httpErrorText.includes('secret_col')
      ) {
        fail('MCP server must collapse validation HTTP error details for non-human callers without schema or permission oracle details');
      }
    } finally {
      httpErrorServer.kill();
    }

    // Identity has exactly one source: the host, via `_meta.botmuxTrustedCaller`.
    // A file under `<dataDir>/trusted-turns/` must NEVER be honored — the
    // directory is world-readable and the file name is derived from a plaintext
    // session id, so any same-uid process could impersonate anyone by writing it.
    const fallbackHome = mkdtempSync(join(tmpdir(), 'botmux-plugin-trusted-turn-'));
    try {
      const sessionId = 'fallback-session';
      const dataDir = join(fallbackHome, '.botmux', 'data');
      const hostEnvFile = join(fallbackHome, 'ksher-agent-data-mcp.env');
      mkdirSync(join(dataDir, 'trusted-turns'), { recursive: true });
      writeFileSync(hostEnvFile, [
        "DATA_MCP_INTERNAL_AUTH_TOKEN='test-token'",
        "DATA_MCP_SERVICE_BASE_URL='http://127.0.0.1:9876'",
        '',
      ].join('\n'));
      const forgedTurnFile = join(dataDir, 'trusted-turns', `${sessionId}.json`);
      const forgedRecord = JSON.stringify({
        sessionId,
        turnId: 'om_forged',
        updatedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        trustedCaller: {
          requestUserOpenId: 'ou_forged_file_user',
          requestUserUnionId: 'on_forged_file_user',
          requestLarkAppId: 'cli_forged_file',
        },
      });
      writeFileSync(forgedTurnFile, forgedRecord);

      const probeRequest = (id, meta) => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'data_mcp_identity_probe',
          arguments: {
            request_user_union_id: 'on_forged_user',
            request_user_open_id: 'ou_forged_user',
            request_user_tchouse_account: 'forged_account',
          },
          ...(meta ? { _meta: { botmuxTrustedCaller: meta } } : {}),
        },
      });
      const runProbe = (requests, extraEnv = {}) => {
        const input = [initialize, ...requests]
          .map(message => JSON.stringify(message)).join('\n') + '\n';
        const proc = spawnSync(process.execPath, [join(cleanRoot, 'mcp', 'server.js')], {
          cwd: cleanRoot,
          input,
          encoding: 'utf-8',
          timeout: 5000,
          env: {
            ...process.env,
            HOME: fallbackHome,
            USERPROFILE: fallbackHome,
            SESSION_DATA_DIR: dataDir,
            BOTMUX_SESSION_ID: sessionId,
            BOTMUX_TRUSTED_TURN_FILE: '',
            KSHER_AGENT_DATA_MCP_ENV_FILE: hostEnvFile,
            ...extraEnv,
          },
        });
        return (proc.stdout ?? '')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line));
      };

      // 1) A well-formed, unexpired turn file must NOT produce an identity.
      const noMeta = runProbe([probeRequest(7, null)]);
      const noMetaResponse = noMeta.find(response => response.id === 7);
      if (noMetaResponse?.error?.message !== 'trusted_identity_required') {
        fail('MCP server must fail closed without Gateway metadata, even when a trusted-turn file exists');
      }
      const noMetaText = JSON.stringify(noMetaResponse ?? {});
      if (noMetaText.includes('on_forged_file_user') || noMetaText.includes('ou_forged_file_user')) {
        fail('MCP server must not surface identities read from a trusted-turn file');
      }

      // 2) The explicit env pointer must not reopen that door either.
      const envPointer = runProbe([probeRequest(8, null)], { BOTMUX_TRUSTED_TURN_FILE: forgedTurnFile });
      if (envPointer.find(response => response.id === 8)?.error?.message !== 'trusted_identity_required') {
        fail('BOTMUX_TRUSTED_TURN_FILE must not be usable as an identity source');
      }

      // 3) With host-injected metadata the probe works, but configuration details remain private.
      const withMeta = runProbe([probeRequest(9, {
        requestUserOpenId: 'ou_host_user',
        requestUserUnionId: 'on_host_user',
        requestLarkAppId: 'cli_host',
      })]);
      const withMetaText = withMeta.find(response => response.id === 9)?.result?.content?.[0]?.text ?? '';
      if (!withMetaText.includes('"source": "gateway_meta"')) {
        fail('MCP server must report gateway_meta as the identity source');
      }
      if (
        withMetaText.includes('configured') ||
        withMetaText.includes('internalAuth') ||
        withMetaText.includes('serviceBaseUrl') ||
        withMetaText.includes('validateSqlEndpoint') ||
        withMetaText.includes('runQueryEndpoint') ||
        withMetaText.includes('exportQueryEndpoint') ||
        withMetaText.includes('http://127.0.0.1:9876')
      ) {
        fail('identity probe must not expose Data MCP service configuration details');
      }
      if (withMetaText.includes('on_forged_user') || withMetaText.includes('ou_forged_user') || withMetaText.includes('forged_account')) {
        fail('identity probe must not expose or trust model-supplied identity arguments');
      }
    } finally {
      rmSync(fallbackHome, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(cleanRoot, { recursive: true, force: true });
}

console.log('generated botmux plugin validation passed');
