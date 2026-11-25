import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_IPC_BYTES = 6 * 1024 * 1024;
// Leave enough room for a bounded model retry while still returning a
// controlled error before the outer Data MCP tool deadline.
const AGENT_TIMEOUT_MS = 300_000;
const workerPath = fileURLToPath(new URL('../result-agent/worker.js', import.meta.url));
const CONFIG_KEYS = [
  'DATA_MCP_RESULT_MODEL_ENDPOINT',
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS',
  'DATA_MCP_RESULT_MODEL',
  'DATA_MCP_RESULT_MODEL_API_KEY',
  'DATA_MCP_RESULT_MODEL_MAX_ATTEMPTS',
  'DATA_MCP_RESULT_MODEL_RETRY_BASE_DELAY_MS',
  'DATA_MCP_RESULT_MODEL_REQUEST_TIMEOUT_MS',
  'DATA_MCP_RESULT_MODEL_MAX_TOKENS',
  'DATA_MCP_RESULT_MODEL_MAX_TOKENS_CAP',
  'DATA_MCP_RESULT_MODEL_ENABLE_THINKING',
  'DATA_MCP_RESULT_MODEL_TEMPERATURE',
  'DATA_MCP_RESULT_MODEL_TEST_EXCEPTION',
];

export function runIsolatedResultAgent(options) {
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs <= 0) {
    return Promise.reject(new Error('result_agent_timeout'));
  }
  const request = {
    result: options.result,
    question: options.question,
    requestedOutputs: options.requestedOutputs,
    pluginHome: options.pluginHome,
    config: Object.fromEntries(CONFIG_KEYS.map(key => [key, options.runtimeConfig.value(key)])),
  };
  const body = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(body) > MAX_IPC_BYTES) return Promise.reject(new Error('result_agent_ipc_payload_too_large'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      env: Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP'].flatMap(key => (
        typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []
      ))),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrBytes = 0;
    let timedOut = false;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(AGENT_TIMEOUT_MS, options.timeoutMs))
      : AGENT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_IPC_BYTES) child.kill('SIGKILL');
    });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('result_agent_timeout'));
        return;
      }
      let response;
      try { response = JSON.parse(stdout.trim()); } catch { reject(new Error('result_agent_ipc_invalid_response')); return; }
      if (code !== 0 || !response?.ok) {
        const error = new Error(typeof response?.error === 'string' ? response.error : 'result_agent_worker_failed');
        if (response?.audit && typeof response.audit === 'object' && !Array.isArray(response.audit)) {
          error.resultAgentAudit = response.audit;
        }
        reject(error);
        return;
      }
      if (!Number.isSafeInteger(response.agentPid) || response.agentPid === process.pid || stderrBytes > 0) {
        reject(new Error('result_agent_process_isolation_failed'));
        return;
      }
      if (response.exceptionHostname) options.onTestExceptionUsed?.(response.exceptionHostname);
      resolve(response.result);
    });
    child.stdin.end(body);
  });
}
