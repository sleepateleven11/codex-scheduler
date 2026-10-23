import { discoverCodex } from '../src/runtime.mjs';
import { stopDaemon } from '../src/daemon-client.mjs';
import { removeBrokerTask } from '../src/windows-broker.mjs';
import { removeManagerLaunchers } from '../src/launcher.mjs';
import { connect, PLUGIN_ID } from './plugin-common.mjs';
import { stopCachedSchedulerMcps } from '../src/plugin-processes.mjs';
import { samePath } from './plugin-common.mjs';
import { fileURLToPath } from 'node:url';

export async function uninstallPluginWithCleanup(client, { stopCachedMcps = stopCachedSchedulerMcps, removeLaunchers = removeManagerLaunchers } = {}) {
  // Validate and close our connections while cache manifests still exist.
  // After deleting the cache there is no safe identity proof for stale PIDs.
  await stopCachedMcps();
  await client.request('plugin/uninstall', { pluginId: PLUGIN_ID }, 90000);
  return removeLaunchers();
}

async function main() {
  if (process.argv.length > 2) throw new Error('卸载命令不接受参数。');
  const stopped = await stopDaemon();
  if (!stopped.stopped) throw new Error(stopped.message || '后台未确认停止，尚未卸载插件。');
  if (stopped.pending) throw new Error('当前一轮仍在执行。已停止派发新任务，请等这一轮结束后重新卸载。');
  await removeBrokerTask();
  const client = await connect(await discoverCodex());
  try {
    const entries = await uninstallPluginWithCleanup(client);
    console.log('Codex Scheduler 已卸载，本插件的后台启动项与管理器入口已删除；本机任务数据保留。');
    if (entries.preserved?.length) console.log('发现归属不同的同名快捷方式，已原样保留。');
  } finally { await client.close(); }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(`卸载失败：${error.message}`); process.exitCode = 1; });
}
