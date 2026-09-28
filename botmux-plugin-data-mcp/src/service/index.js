import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));

export default {
  mode: 'auto',
  pm2: {
    script: 'service/api-runner-entry.js',
    cwd: pluginDir,
    env: {
      KSHER_AGENT_DATA_MCP_ENV_FILE: process.env.KSHER_AGENT_DATA_MCP_ENV_FILE
        || join(homedir(), '.config', 'ksher-agent-data-mcp', 'env'),
      DATA_MCP_HTTP_SOCKET_PATH: process.env.DATA_MCP_HTTP_SOCKET_PATH
        || join(homedir(), '.cache', 'ksher-agent-data-mcp', 'run', 'api.sock'),
    },
    killTimeoutMs: 10_000,
  },
};
