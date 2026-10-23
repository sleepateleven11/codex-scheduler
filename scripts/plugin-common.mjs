import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CodexRpcClient } from '../src/rpc-client.mjs';
import { discoverCodex, discoverNode } from '../src/runtime.mjs';
import { getPaths } from '../src/paths.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_NAME = 'codex-scheduler';
export const MARKETPLACE_NAME = 'local-scheduler';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const MARKETPLACE_PATH = path.join(ROOT, '.agents', 'plugins', 'marketplace.json');
export const TOOL_NAMES = ['scheduler_open', 'scheduler_catalog', 'scheduler_threads', 'scheduler_create', 'scheduler_list', 'scheduler_action'];
export const DISTRIBUTION_INCLUDES = ['.codex-plugin', '.mcp.json', '.agents', 'src', 'public', 'skills', 'scripts', 'package.json', 'package-lock.json', 'README.md', '安装插件.cmd', '卸载插件.cmd'];

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function samePath(a, b) {
  const clean = value => path.resolve(String(value).replace(/^\\\\\?\\/, '')).replaceAll('\\', '/').replace(/\/$/, '');
  const left = clean(a);
  const right = clean(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function mcpManifest(nodePath, launchRoot = ROOT, { dataDir = getPaths().dataDir } = {}) {
  return { mcpServers: { codex_scheduler: {
    command: nodePath,
    args: [path.join(launchRoot, 'src', 'mcp-server.mjs')],
    cwd: dataDir,
    startup_timeout_sec: 20,
    tool_timeout_sec: 120,
    env_vars: ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'CODEX_HOME', 'CODEX_CLI_PATH', 'SCHEDULER_CODEX_PATH', 'SCHEDULER_DATA_DIR', 'PATH', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_THREAD_ID'],
  } } };
}

// The archive must not carry the packager's account, Node location or local
// worker directory. Installation resolves and rewrites all three locally.
export function portableMcpManifest() {
  return mcpManifest('node', '.', { dataDir: '.' });
}

export async function distributionPayload(sourceRoot = ROOT) {
  const root = await fs.realpath(sourceRoot);
  const files = [];
  async function collect(relative) {
    const full = path.join(root, relative);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`分发目录中不允许链接文件：${relative}`);
    const canonical = await fs.realpath(full);
    const inside = path.relative(root, canonical);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('分发文件超出插件目录。');
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(full)).sort()) await collect(path.join(relative, name));
    } else if (stat.isFile()) {
      const name = relative.replaceAll('\\', '/');
      if (/(?:^|\/)(?:auth\.json|queue\.json|settings\.json|endpoint\.json|desktop-connection\.json|worker\.(?:log|lock)|\.env(?:\..*)?)$/i.test(name)) throw new Error(`分发目录中存在本机运行数据：${name}`);
      files.push({ name, bytes: name === '.mcp.json' ? Buffer.from(JSON.stringify(portableMcpManifest(), null, 2) + '\n') : await fs.readFile(full) });
    } else throw new Error(`分发目录中存在不支持的文件：${relative}`);
  }
  for (const name of DISTRIBUTION_INCLUDES) await collect(name);
  return files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export async function writeDistribution(destination, { sourceRoot = ROOT, files } = {}) {
  files ||= await distributionPayload(sourceRoot);
  for (const file of files) {
    const target = path.join(destination, file.name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.bytes, { flag: 'wx' });
  }
  return files;
}

export async function stageInstallationSource({ sourceRoot = ROOT, dataDir = getPaths().dataDir, nodePath = process.execPath } = {}) {
  const { manifest } = await inspectSchedulerSource(sourceRoot);
  const files = await distributionPayload(sourceRoot);
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.name}\0${file.bytes.length}\0`).update(file.bytes);
  const digest = hash.digest('hex');
  let parent = await fs.realpath(dataDir);
  for (const segment of ['installation', 'plugin']) {
    const next = path.join(parent, segment);
    await fs.mkdir(next).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(next);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(next), next)) throw new Error('本机安装目录不是有效的独立文件夹，原文件已保留。');
    parent = next;
  }
  const stagedRoot = path.join(parent, `${manifest.version}-${digest.slice(0, 16)}`);
  const existing = await fs.lstat(stagedRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('本机插件安装副本不是有效目录，原文件已保留。');
    await inspectSchedulerSource(stagedRoot);
    const previousFiles = await distributionPayload(stagedRoot);
    if (previousFiles.length !== files.length || files.some((file, index) => file.name !== previousFiles[index].name || !file.bytes.equals(previousFiles[index].bytes))) throw new Error('本机插件安装副本内容不符，原文件已保留。');
  } else {
    const temporary = await fs.mkdtemp(path.join(parent, '.install-'));
    try {
      await writeDistribution(temporary, { files });
      await fs.rename(temporary, stagedRoot);
    } finally {
      if (samePath(path.dirname(temporary), parent) && path.basename(temporary).startsWith('.install-')) await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  await writeMcpConfig(path.join(stagedRoot, '.mcp.json'), nodePath, stagedRoot, { dataDir });
  return { root: stagedRoot, digest, files: files.length };
}

// Migration is safe only for our dedicated local marketplace. A marketplace
// containing other plugins must never be redirected to a new extraction folder.
export async function inspectSchedulerSource(sourceRoot) {
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) throw new Error('插件来源必须是本机绝对目录。');
  const root = await fs.realpath(sourceRoot);
  const [manifest, marketplace] = await Promise.all([
    readJson(path.join(root, '.codex-plugin', 'plugin.json')),
    readJson(path.join(root, '.agents', 'plugins', 'marketplace.json')),
  ]);
  if (manifest.name !== PLUGIN_NAME || !/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.skills !== './skills/' || manifest.mcpServers !== './.mcp.json') {
    throw new Error('该目录不是身份匹配的 codex-scheduler 插件。');
  }
  if (marketplace.name !== MARKETPLACE_NAME || !Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) throw new Error('原来源不是本插件专用的 local-scheduler 来源。');
  const entry = marketplace.plugins[0];
  if (entry.name !== PLUGIN_NAME || entry.source?.source !== 'local' || typeof entry.source.path !== 'string') throw new Error('来源中的插件身份或类型不匹配。');
  const pluginRoot = await fs.realpath(path.resolve(root, entry.source.path));
  if (!samePath(pluginRoot, root)) throw new Error('来源中的插件指向其他目录，不能自动迁移。');
  return { root, manifest, marketplace };
}

export async function planMarketplaceSource(prior, { root = ROOT, codexHome = getPaths().codexHome, registeredPlugins } = {}) {
  const current = await inspectSchedulerSource(root);
  if (!prior) return { action: 'register', toRoot: root, pluginId: PLUGIN_ID };
  if (prior.source_type !== 'local' || typeof prior.source !== 'string' || !path.isAbsolute(prior.source)) throw new Error(`已存在不同的 ${MARKETPLACE_NAME} 来源，无法自动迁移；原注册已保留。`);
  if (samePath(prior.source, root)) return { action: 'keep', toRoot: root, pluginId: PLUGIN_ID };
  let previous;
  try { previous = await inspectSchedulerSource(prior.source); }
  catch (cause) {
    const sourceMissing = await fs.stat(prior.source).then(() => false, error => error.code === 'ENOENT');
    if (cause.code === 'ENOENT' && sourceMissing && registeredPlugins?.[PLUGIN_ID]?.enabled === true &&
      !Object.keys(registeredPlugins).some(id => id.endsWith(`@${MARKETPLACE_NAME}`) && id !== PLUGIN_ID)) {
      const cacheMarketplace = path.join(codexHome, 'plugins', 'cache', MARKETPLACE_NAME);
      const names = await fs.readdir(cacheMarketplace, { withFileTypes: true }).catch(() => []);
      if (names.length === 1 && names[0].isDirectory() && names[0].name === PLUGIN_NAME) {
        const versions = await fs.readdir(path.join(cacheMarketplace, PLUGIN_NAME), { withFileTypes: true });
        for (const version of versions.filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))) {
          const candidate = path.join(cacheMarketplace, PLUGIN_NAME, version.name);
          try {
            const proof = await inspectSchedulerSource(candidate);
            const server = (await readJson(path.join(candidate, '.mcp.json'))).mcpServers?.codex_scheduler;
            const script = path.join(candidate, 'src', 'mcp-server.mjs');
            if (!samePath(proof.root, candidate) || proof.manifest.version !== version.name || !path.isAbsolute(server?.command || '') || server?.args?.length !== 1 || !samePath(server.args[0], script)) continue;
            await fs.access(script);
            previous = { ...proof, root: prior.source };
            break;
          } catch {}
        }
      }
    }
    if (!previous) throw new Error(`无法确认原 ${MARKETPLACE_NAME} 目录属于本插件，原注册已保留：${cause.message}`, { cause });
  }
  return { action: 'migrate', fromRoot: previous.root, toRoot: root, pluginId: PLUGIN_ID, fromVersion: previous.manifest.version, toVersion: current.manifest.version };
}

export async function inspectPackage() {
  const { manifest, marketplace } = await inspectSchedulerSource(ROOT);
  await Promise.all(['src/mcp-server.mjs', 'src/rpc-client.mjs', 'src/runtime.mjs', 'skills/codex-scheduler/SKILL.md'].map(name => fs.access(path.join(ROOT, name))));
  const [codexPath, nodePath] = await Promise.all([discoverCodex(), discoverNode()]);
  return { manifest, marketplace, codexPath, nodePath };
}

export function marketplaceOverrides(root = ROOT) {
  return ['-c', `marketplaces.${MARKETPLACE_NAME}.source_type=${JSON.stringify('local')}`,
    '-c', `marketplaces.${MARKETPLACE_NAME}.source=${JSON.stringify(root.replaceAll('\\', '/'))}`];
}

export async function connect(codexPath, extraArgs = []) {
  const client = new CodexRpcClient({ codexPath, cwd: ROOT, extraArgs });
  await client.start();
  return client;
}

export function configuredMarketplace(configResult) {
  if (configResult.config?.marketplaces?.[MARKETPLACE_NAME]) return configResult.config.marketplaces[MARKETPLACE_NAME];
  const layers = [...(configResult.layers || [])].reverse();
  for (const layer of layers) {
    const value = layer.config?.marketplaces?.[MARKETPLACE_NAME];
    if (value) return value;
  }
  return null;
}

export async function writeMcpConfig(destination, nodePath, launchRoot = ROOT, { dataDir = getPaths().dataDir } = {}) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(mcpManifest(nodePath, launchRoot, { dataDir: await fs.realpath(dataDir) }), null, 2)}\n`, 'utf8');
}

// Prefer paths returned by plugin/read, then the versioned local cache path.
// Never patch another plugin or an unrelated folder.
export async function patchInstalledMcp(detail, version, nodePath) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const cacheRoot = path.join(codexHome, 'plugins', 'cache');
  const candidates = new Set([path.join(cacheRoot, MARKETPLACE_NAME, PLUGIN_NAME, version)]);
  for (const skill of detail.skills || []) {
    if (skill.path) candidates.add(path.resolve(path.dirname(skill.path), '..', '..'));
  }
  for (const candidate of candidates) {
    const relative = path.relative(cacheRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let manifest;
    try { manifest = await readJson(path.join(candidate, '.codex-plugin', 'plugin.json')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (manifest.name !== PLUGIN_NAME || manifest.version !== version) continue;
    await writeMcpConfig(path.join(candidate, '.mcp.json'), nodePath, candidate);
    return candidate;
  }
  throw new Error('插件安装已返回，但未找到对应版本的本地缓存，无法验证启动配置。');
}

export async function readInstalled(client, marketplacePath = MARKETPLACE_PATH) {
  return (await client.request('plugin/read', { marketplacePath, pluginName: PLUGIN_NAME })).plugin;
}

export async function verifyTools(client) {
  const result = await client.request('mcpServerStatus/list', { serverName: 'codex_scheduler', limit: 100 }, 90000);
  const servers = (result.data || []).filter(server => server.name === 'codex_scheduler' || server.pluginId === PLUGIN_ID);
  const available = new Set(servers.flatMap(server => Object.values(server.tools || {}).map(tool => tool.name)));
  const missing = TOOL_NAMES.filter(name => !available.has(name));
  if (missing.length) {
    const error = servers.map(server => server.toolsError).filter(Boolean).join('; ');
    throw new Error(`插件已安装，但新会话尚未成功发现工具：${missing.join(', ')}${error ? `。${error}` : ''}`);
  }
  return [...available].filter(name => TOOL_NAMES.includes(name));
}
