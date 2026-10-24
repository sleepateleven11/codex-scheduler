import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stopDaemon } from '../src/daemon-client.mjs';
import { getPaths } from '../src/paths.mjs';
import { installManagerLaunchers } from '../src/launcher.mjs';
import { recordInstallation } from '../src/installation-state.mjs';
import {
  ROOT, MARKETPLACE_NAME, MARKETPLACE_PATH, PLUGIN_NAME, PLUGIN_ID,
  inspectPackage, connect, configuredMarketplace, planMarketplaceSource, samePath, marketplaceOverrides,
  stageInstallationSource, patchInstalledMcp, readInstalled, verifyTools,
} from './plugin-common.mjs';

import {cachedMcpProcesses, selectCachedSchedulerMcps, stopCachedMcp, stopCachedSchedulerMcps} from "../src/plugin-processes.mjs";
export {cachedMcpProcesses, selectCachedSchedulerMcps} from "../src/plugin-processes.mjs";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Call only after persisted installation and fresh-session tool discovery pass.
// Desktop policy or a foreign same-name shortcut must not invalidate that core
// result; this optional step never catches plugin identity or install failures.
export async function installOptionalManagerLaunchers(options, {
  installLaunchers = installManagerLaunchers, log = message => console.log(message),
} = {}) {
  try {
    const entrypoints = await installLaunchers(options);
    if (entrypoints.installed) log('已创建桌面和开始菜单的“时序任务管理器”，双击即可使用，也可在 Codex 中打开。');
    else log('插件已安装并验证通过；可在 Codex 中说“打开定时任务管理器”。');
    return entrypoints;
  } catch (error) {
    log(`插件已安装并验证通过；桌面或开始菜单入口未创建：${error.message}`);
    log('仍可在 Codex 中说“打开定时任务管理器”。');
    return { installed: false, warning: true };
  }
}

export async function installPluginWithRecovery(client, params, {
  platform = process.platform, codexHome = getPaths().codexHome,
  listProcesses = cachedMcpProcesses, stopProcess = stopCachedMcp, delay = pause,
  log = message => console.log(message),
} = {}) {
  try { return await client.request('plugin/install', params, 90000); }
  catch (error) {
    if (platform !== 'win32' || !/failed to back up plugin cache entry/i.test(error.message) || !/(?:os error\s*5|access.+denied|拒绝访问)/i.test(error.message)) throw error;
    let rows;
    try { rows = await listProcesses(); }
    catch {
      log('无法读取本插件旧连接的进程信息，未终止任何进程；Codex 返回的安装错误已保留。');
      throw error;
    }
    const candidates = await selectCachedSchedulerMcps(rows, { codexHome });
    if (!candidates.length) throw error;
    log('旧的定时插件连接占用安装缓存；仅关闭已验证属于本插件的工具连接后重试一次。');
    for (const candidate of candidates) await stopProcess(candidate);
    await delay(300);
    // Wait for the verified processes to exit before retrying. Never delete the
    // cache or broaden process termination to the host or unrelated Node apps.
    return client.request('plugin/install', params, 90000);
  }
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some(flag => flag !== '--dry-run')) throw new Error('仅支持 --dry-run 参数。');
  const { manifest, codexPath, nodePath } = await inspectPackage();
  // Validate a former extraction folder before stopping any working background
  // process. This preflight is read-only, including during --dry-run.
  let client = await connect(codexPath);
  let sourcePlan;
  try {
    const configResult = await client.request('config/read', { includeLayers: true });
    const prior = configuredMarketplace(configResult);
    const registeredPlugins = configResult.config?.plugins || Object.assign({}, ...(configResult.layers || []).map(layer => layer.config?.plugins || {}));
    sourcePlan = await planMarketplaceSource(prior, { registeredPlugins });
  } finally { await client.close(); }
  if (flags.has('--dry-run')) {
    console.log(JSON.stringify({ plugin: PLUGIN_ID, version: manifest.version, source: ROOT, codexPath, nodePath,
      sourcePlan, changes: ['复制程序到本机稳定安装目录并设置本机启动路径', sourcePlan.action === 'migrate' ? '迁移已验证为同一插件的本地来源' : '注册 local-scheduler 本地来源', '安装并验证 codex-scheduler 插件', '创建桌面和开始菜单的时序任务管理器入口'], dryRun: true }, null, 2));
    return;
  }

  await recordInstallation();
  const stopped = await stopDaemon();
  if (!stopped.stopped) throw new Error('无法确认旧后台已停止，请先处理正在执行的任务。');
  if (stopped.pending) throw new Error('当前一轮仍在执行。已停止派发新任务，请等这一轮结束后重新安装。');
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!await fs.stat(getPaths().endpointPath).catch(() => null)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const staged = await stageInstallationSource({ nodePath });
  const stableNodePath = staged.nodePath;
  const marketplacePath = path.join(staged.root, '.agents', 'plugins', 'marketplace.json');
  client = await connect(codexPath, marketplaceOverrides(staged.root));
  let installedRoot;
  try {
    const listed = await client.request('plugin/list', { cwds: [staged.root] });
    const marketplace = listed.marketplaces?.find(item => item.name === MARKETPLACE_NAME);
    if (!marketplace?.plugins?.some(item => item.name === PLUGIN_NAME)) throw new Error('Codex 未发现本地插件，尚未安装。');
    const released = await stopCachedSchedulerMcps();
    if (released.stopped) console.log('安装前已关闭本插件的旧工具连接，等待完成后再更新缓存。');
    await installPluginWithRecovery(client, { marketplacePath, pluginName: PLUGIN_NAME });
    await client.request('config/value/write', { keyPath: `marketplaces.${MARKETPLACE_NAME}`,
      value: { source_type: 'local', source: staged.root }, mergeStrategy: 'upsert' });
    const detail = await readInstalled(client, marketplacePath);
    if (!detail.summary.installed || !detail.summary.enabled) throw new Error('安装结果未显示插件已启用。');
    installedRoot = await patchInstalledMcp(detail, manifest.version, stableNodePath);
    await client.request('plugin/reconcile', { reason: 'codex-scheduler local installation verified launch paths' }, 90000);
    console.log(`已安装 ${PLUGIN_ID} ${manifest.version}。本地缓存：${installedRoot}`);
    console.log(`本机安装副本：${staged.root}。原解压目录可移动或删除，不影响已安装版本。`);
    if (sourcePlan.action === 'migrate') console.log('已迁移本插件的来源，本机任务数据与原目录保留。');
  } finally { await client.close(); }

  // New process proves discovery uses persisted config rather than install overrides.
  client = await connect(codexPath);
  try {
    const detail = await readInstalled(client, marketplacePath);
    if (!detail.summary.installed || !detail.summary.enabled) throw new Error('新会话未读到已启用插件。');
    const tools = await verifyTools(client);
    console.log(`新会话已发现 ${tools.length} 个定时任务工具。`);
  } finally { await client.close(); }
  await installOptionalManagerLaunchers({ installedRoot, nodePath: stableNodePath });
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(`安装未完成验证：${error.message}`); process.exitCode = 1; });
}
