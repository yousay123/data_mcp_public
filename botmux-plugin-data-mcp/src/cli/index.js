import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let hostEnvCache;

function parseHostEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  if (
    (value.startsWith("'") && value.endsWith("'"))
    || (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

function hostEnv() {
  if (hostEnvCache) return hostEnvCache;
  const values = {};
  const path = process.env.KSHER_AGENT_DATA_MCP_ENV_FILE
    || join(homedir(), '.config', 'ksher-agent-data-mcp', 'env');
  try {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const entry = parseHostEnvLine(line);
      if (entry) values[entry[0]] = entry[1];
    }
  } catch {
    // Host env file is optional.
  }
  hostEnvCache = values;
  return hostEnvCache;
}

function configValue(name) {
  const fromProcess = process.env[name];
  if (typeof fromProcess === 'string' && fromProcess) return fromProcess;
  const fromHostFile = hostEnv()[name];
  return typeof fromHostFile === 'string' && fromHostFile ? fromHostFile : undefined;
}

export default {
  'data-mcp:status': {
    description: 'Show private Data MCP plugin runtime status.',
    run(ctx) {
      return JSON.stringify({
        ok: true,
        pluginId: ctx.pluginId,
        version: ctx.version,
        packageName: ctx.packageName,
        configured: {
          serviceBaseUrl: configValue('DATA_MCP_SERVICE_BASE_URL') || 'http://127.0.0.1:8765',
          serviceSocketPath: configValue('DATA_MCP_SERVICE_SOCKET_PATH') || join(homedir(), '.cache', 'ksher-agent-data-mcp', 'run', 'api.sock'),
          validateSqlEndpoint: configValue('DATA_MCP_VALIDATE_SQL_ENDPOINT') || null,
          runQueryEndpoint: configValue('DATA_MCP_RUN_QUERY_ENDPOINT') || configValue('DATA_MCP_QUERY_ENDPOINT') || null,
          exportQueryEndpoint: configValue('DATA_MCP_EXPORT_QUERY_ENDPOINT') || configValue('DATA_MCP_EXPORT_ENDPOINT') || null,
          internalAuth: !!configValue('DATA_MCP_INTERNAL_AUTH_TOKEN'),
        },
      }, null, 2);
    },
  },

  'data-mcp:show-config': {
    description: 'Read private Data MCP plugin config.',
    run(ctx) {
      return JSON.stringify(ctx.api.config.get() ?? {}, null, 2);
    },
  },
};
