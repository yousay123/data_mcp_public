import { createInterface } from 'node:readline';
import { runInternalResultAgent } from './runtime.js';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let handled = false;

input.on('line', async line => {
  if (handled || !line.trim()) return;
  handled = true;
  try {
    const request = JSON.parse(line);
    const values = request?.config;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('result_agent_worker_invalid_request');
    let exceptionHostname;
    const result = await runInternalResultAgent({
      result: request.result,
      question: request.question,
      requestedOutputs: request.requestedOutputs,
      pluginHome: request.pluginHome,
      runtimeConfig: { value: name => values[name] },
      onTestExceptionUsed: hostname => { exceptionHostname = hostname; },
    });
    process.stdout.write(`${JSON.stringify({ ok: true, result, exceptionHostname, agentPid: process.pid })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'result_agent_worker_failed',
      audit: error instanceof Error ? error.resultAgentAudit : undefined,
      agentPid: process.pid,
    })}\n`);
  } finally {
    input.close();
  }
});
