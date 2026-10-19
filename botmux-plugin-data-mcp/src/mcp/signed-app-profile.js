import { lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const TEST_PROFILE_ALLOWED_KEYS = new Set([
  'DATA_MCP_SERVICE_SOCKET_PATH',
  'DATA_MCP_RESULT_MODEL_ENDPOINT',
  'DATA_MCP_RESULT_MODEL_ALLOWED_HOSTS',
  'DATA_MCP_RESULT_MODEL',
  'DATA_MCP_RESULT_MODEL_API_KEY',
  'DATA_MCP_RESULT_MODEL_TEST_EXCEPTION',
]);

const profileCache = new Map();

function invalidProfile() {
  throw new Error('test_profile_config_invalid');
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) invalidProfile();
  let value = match[2].trim();
  if (
    (value.startsWith("'") && value.endsWith("'"))
    || (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

function secureProfileStat(path) {
  let linkStat;
  let fileStat;
  try {
    linkStat = lstatSync(path);
    fileStat = statSync(path);
  } catch {
    invalidProfile();
  }
  if (linkStat.isSymbolicLink() || !fileStat.isFile()) invalidProfile();
  // No owner execute bit and no group/other permissions: 0600, 0400, etc.
  if ((fileStat.mode & 0o177) !== 0) invalidProfile();
  return fileStat;
}

function readWhitelistedProfile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch { invalidProfile(); }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry && TEST_PROFILE_ALLOWED_KEYS.has(entry[0])) values[entry[0]] = entry[1];
  }
  return Object.freeze(values);
}

export function resolveSignedAppTestProfile(caller, env = process.env) {
  const configuredAppId = typeof env.DATA_MCP_TEST_PROFILE_APP_ID === 'string'
    ? env.DATA_MCP_TEST_PROFILE_APP_ID.trim()
    : '';
  const configuredPath = typeof env.DATA_MCP_TEST_PROFILE_ENV_FILE === 'string'
    ? env.DATA_MCP_TEST_PROFILE_ENV_FILE.trim()
    : '';
  if (!configuredAppId || caller?.requestLarkAppId !== configuredAppId) return undefined;
  if (!configuredPath || !isAbsolute(configuredPath)) invalidProfile();

  const path = resolve(configuredPath);
  const fileStat = secureProfileStat(path);
  const cacheKey = `${configuredAppId}\0${path}\0${fileStat.mtimeMs}`;
  const cached = profileCache.get(cacheKey);
  if (cached) return cached;

  const profile = readWhitelistedProfile(path);
  for (const key of profileCache.keys()) {
    if (key.startsWith(`${configuredAppId}\0${path}\0`)) profileCache.delete(key);
  }
  profileCache.set(cacheKey, profile);
  return profile;
}

export function clearSignedAppTestProfileCacheForTests() {
  profileCache.clear();
}
