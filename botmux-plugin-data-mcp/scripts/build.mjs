import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);
const sourceRoot = join(repoRoot, 'src');
const outputRoot = join(repoRoot, 'dist');
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

function assertNoSymlinks(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`plugin build does not allow symlinks: ${path}`);
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path)) assertNoSymlinks(join(path, name));
}

function copyStaticFiles(source, target) {
  if (!existsSync(source)) return;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`plugin build does not allow symlinks: ${source}`);
  if (stat.isFile()) {
    if (CODE_EXTENSIONS.has(extname(source))) return;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
    return;
  }
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) copyStaticFiles(join(source, name), join(target, name));
}

function assertJsonValue(value, path = 'mcp') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${path}.${key}`);
    return;
  }
  throw new Error(`${path} must contain JSON-serializable values only`);
}

async function bundleNode(source, output) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(output), { recursive: true });
  await build({
    entryPoints: [source],
    outfile: output,
    bundle: true,
    treeShaking: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'bundle',
    logLevel: 'silent',
  });
}

async function bundleBrowser(source, output) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(output), { recursive: true });
  await build({
    entryPoints: [source],
    outfile: output,
    bundle: true,
    treeShaking: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    packages: 'bundle',
    logLevel: 'silent',
  });
}

async function generateMcpIndex() {
  const sourceEntry = join(sourceRoot, 'mcp', 'index.js');
  if (!existsSync(sourceEntry)) return;
  const mod = await import(pathToFileURL(sourceEntry).href + `?t=${Date.now()}`);
  const config = mod.default ?? mod;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('src/mcp/index.js must default-export one MCP config object');
  }
  assertJsonValue(config);
  const transport = config.transport ?? 'stdio';
  if (transport === 'stdio') {
    if (!Array.isArray(config.command) || config.command.length === 0 || config.command.some(part => typeof part !== 'string' || !part.trim())) {
      throw new Error('stdio MCP config requires a non-empty string command array');
    }
  } else if (transport === 'streamable-http') {
    let url;
    try { url = new URL(config.url); } catch { throw new Error('streamable-http MCP config requires a valid url'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('streamable-http MCP url must use http or https');
  } else {
    throw new Error(`unsupported MCP transport: ${transport}`);
  }
  mkdirSync(join(outputRoot, 'mcp'), { recursive: true });
  writeFileSync(join(outputRoot, 'mcp', 'index.json'), JSON.stringify({ ...config, transport }, null, 2) + '\n');
}

async function generateCliCommandIndex() {
  const cliEntry = join(sourceRoot, 'cli', 'index.js');
  if (!existsSync(cliEntry)) return;
  const mod = await import(pathToFileURL(cliEntry).href + `?t=${Date.now()}`);
  const handlers = mod.default ?? mod;
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new Error('src/cli/index.js must default-export a command handler object');
  }
  const commands = Object.entries(handlers).map(([name, handler]) => {
    if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(name)) throw new Error(`invalid plugin command name: ${name}`);
    if (typeof handler !== 'function' && typeof handler?.run !== 'function') {
      throw new Error(`command handler must be a function or { run() }: ${name}`);
    }
    const description = typeof handler?.description === 'string' && handler.description.trim()
      ? handler.description.trim()
      : undefined;
    return { name, ...(description ? { description } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(join(outputRoot, 'cli'), { recursive: true });
  writeFileSync(join(outputRoot, 'cli', 'commands.json'), JSON.stringify({ schemaVersion: 1, commands }, null, 2) + '\n');
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
writeFileSync(
  join(outputRoot, 'package.json'),
  JSON.stringify(
    {
      private: true,
      type: 'module',
      name: packageJson.name,
      version: packageJson.version,
    },
    null,
    2,
  ) + '\n',
);

await Promise.all([
  bundleNode(join(sourceRoot, 'cli', 'index.js'), join(outputRoot, 'cli', 'index.js')),
  bundleNode(join(sourceRoot, 'mcp', 'server.js'), join(outputRoot, 'mcp', 'server.js')),
  bundleNode(join(sourceRoot, 'service', 'index.js'), join(outputRoot, 'service', 'index.js')),
  bundleNode(join(sourceRoot, 'service', 'api-runner.js'), join(outputRoot, 'service', 'api-runner.js')),
  bundleNode(join(sourceRoot, 'service', 'api-runner-entry.js'), join(outputRoot, 'service', 'api-runner-entry.js')),
  bundleNode(join(sourceRoot, 'service', 'server.js'), join(outputRoot, 'service', 'server.js')),
  bundleBrowser(join(sourceRoot, 'dashboard', 'index.js'), join(outputRoot, 'dashboard', 'index.js')),
]);

for (const surface of ['cli', 'mcp', 'service', 'dashboard']) {
  copyStaticFiles(join(sourceRoot, surface), join(outputRoot, surface));
}
copyStaticFiles(join(repoRoot, 'skills'), join(outputRoot, 'skills'));
await generateCliCommandIndex();
await generateMcpIndex();
assertNoSymlinks(outputRoot);
