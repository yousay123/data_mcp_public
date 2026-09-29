import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const DEFAULT_ENV_FILE = join(homedir(), '.config', 'ksher-agent-data-mcp', 'env');
const DEFAULT_SOCKET_PATH = join(homedir(), '.cache', 'ksher-agent-data-mcp', 'run', 'api.sock');
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 8_000;
const HEALTH_POLL_MS = 100;

function parseEnvLine(line, lineNumber) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) {
    throw new Error(`invalid Data MCP env file syntax at line ${lineNumber}`);
  }
  const key = match[1];
  const encoded = match[2];
  if (encoded.length < 2 || !encoded.startsWith("'") || !encoded.endsWith("'")) {
    throw new Error(`Data MCP env key ${key} must use a single-quoted literal`);
  }
  const value = encoded.slice(1, -1);
  if (value.includes("'")) {
    throw new Error(`Data MCP env key ${key} contains an unsupported single quote`);
  }
  return [key, value];
}

export function parseEnvFile(text) {
  const values = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const entry = parseEnvLine(line, index + 1);
    if (!entry) continue;
    if (Object.hasOwn(values, entry[0])) {
      throw new Error(`duplicate Data MCP env key ${entry[0]}`);
    }
    values[entry[0]] = entry[1];
  }
  return values;
}

export function healthRequest(socketPath) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = request({ socketPath, path: '/health', method: 'GET', timeout: 1_000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        if (body.length <= 64 * 1024) body += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
          finish(false);
          return;
        }
        try {
          const parsed = JSON.parse(body);
          finish(
            parsed?.status === 'ok'
            && parsed?.http_identity?.transport === 'unix_socket',
          );
        } catch {
          finish(false);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.on('error', () => finish(false));
    req.end();
  });
}

async function healthProbe(socketPath) {
  if (!await healthRequest(socketPath)) return { kind: 'unhealthy' };
  let socketStat;
  try {
    socketStat = await stat(socketPath);
  } catch {
    return { kind: 'unhealthy' };
  }
  const mode = socketStat.mode & 0o777;
  if (!socketStat.isSocket() || mode !== 0o600) {
    return { kind: 'unsafe_socket', mode, isSocket: socketStat.isSocket() };
  }
  return { kind: 'healthy' };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth(socketPath, timeoutMs, childExit, signalReceived) {
  let deadlineTimer;
  const deadline = new Promise(resolve => {
    deadlineTimer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    deadlineTimer.unref();
  });
  try {
    while (true) {
      const outcome = await Promise.race([
        healthProbe(socketPath),
        childExit.then(result => ({ kind: 'exit', result })),
        signalReceived.then(signal => ({ kind: 'signal', signal })),
        deadline,
      ]);
      if (outcome.kind === 'exit') return outcome;
      if (outcome.kind === 'signal') return outcome;
      if (outcome.kind === 'unsafe_socket') return outcome;
      if (outcome.kind === 'healthy') return outcome;
      if (outcome.kind === 'timeout') return outcome;
      await delay(HEALTH_POLL_MS);
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function stopChild(child, childExit, killGraceMs, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return childExit;
  child.kill(signal);
  const result = await Promise.race([
    childExit,
    delay(killGraceMs).then(() => null),
  ]);
  if (result) return result;
  child.kill('SIGKILL');
  return childExit;
}

function parseTimeout(env, key, fallback, minimum, maximum) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`invalid ${key}`);
  }
  return parsed;
}

export function resolveServiceTimeouts(env = process.env) {
  return {
    readyTimeoutMs: parseTimeout(
      env,
      'DATA_MCP_SERVICE_READY_TIMEOUT_MS',
      DEFAULT_READY_TIMEOUT_MS,
      50,
      300_000,
    ),
    killGraceMs: parseTimeout(
      env,
      'DATA_MCP_SERVICE_KILL_GRACE_MS',
      DEFAULT_KILL_GRACE_MS,
      10,
      60_000,
    ),
  };
}

export function resolveApiExecutable(env) {
  const explicit = env.DATA_MCP_SERVICE_API_BIN;
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error('DATA_MCP_SERVICE_API_BIN must be an absolute path');
    }
    return explicit;
  }
  const runtimeHome = env.KSHER_AGENT_DATA_MCP_RUNTIME_HOME;
  if (!runtimeHome) {
    throw new Error('missing DATA_MCP_SERVICE_API_BIN or KSHER_AGENT_DATA_MCP_RUNTIME_HOME');
  }
  if (!isAbsolute(runtimeHome)) {
    throw new Error('KSHER_AGENT_DATA_MCP_RUNTIME_HOME must be an absolute path');
  }
  return join(runtimeHome, '.venv', 'bin', 'ksher-agent-data-api');
}

export async function runApiService({ env = process.env } = {}) {
  const envFile = env.KSHER_AGENT_DATA_MCP_ENV_FILE || DEFAULT_ENV_FILE;
  const envText = await readFile(envFile, 'utf8');
  const childEnv = { ...env, ...parseEnvFile(envText), KSHER_AGENT_DATA_MCP_ENV_FILE: envFile };
  const socketPath = childEnv.DATA_MCP_HTTP_SOCKET_PATH || DEFAULT_SOCKET_PATH;
  const apiExecutable = resolveApiExecutable(childEnv);
  await access(apiExecutable, fsConstants.X_OK);
  const { readyTimeoutMs, killGraceMs } = resolveServiceTimeouts(childEnv);

  const child = spawn(apiExecutable, [], {
    env: childEnv,
    stdio: 'inherit',
  });
  const childExit = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  let requestedSignal = null;
  let resolveSignal;
  const signalReceived = new Promise(resolve => {
    resolveSignal = resolve;
  });
  const forwardSignal = signal => {
    if (requestedSignal) return;
    requestedSignal = signal;
    resolveSignal(signal);
  };
  const onTerm = () => forwardSignal('SIGTERM');
  const onInt = () => forwardSignal('SIGINT');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);

  try {
    const readiness = await waitForHealth(socketPath, readyTimeoutMs, childExit, signalReceived);
    if (readiness.kind === 'signal') {
      await stopChild(child, childExit, killGraceMs, readiness.signal);
      return 0;
    }
    if (readiness.kind === 'exit') return 1;
    if (readiness.kind === 'timeout') {
      await stopChild(child, childExit, killGraceMs);
      return 1;
    }
    if (readiness.kind === 'unsafe_socket') {
      await stopChild(child, childExit, killGraceMs);
      const actual = readiness.isSocket
        ? `0${readiness.mode.toString(8).padStart(3, '0')}`
        : 'not-a-socket';
      throw new Error(`Unix socket permissions must be 0600, got ${actual}`);
    }

    const runningOutcome = await Promise.race([
      childExit.then(result => ({ kind: 'exit', result })),
      signalReceived.then(signal => ({ kind: 'signal', signal })),
    ]);
    if (runningOutcome.kind === 'signal') {
      await stopChild(child, childExit, killGraceMs, runningOutcome.signal);
      return 0;
    }
    const { result } = runningOutcome;
    if (result.error) return 1;
    return typeof result.code === 'number' && result.code !== 0 ? result.code : 1;
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  }
}
