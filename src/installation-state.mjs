import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths } from './paths.mjs';
import os from 'node:os';

async function legacyWindowsDataDirectories() {
  const packages = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Packages');
  const entries = await fs.readdir(packages, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return entries.filter(entry => entry.isDirectory() && /^OpenAI\.Codex_[\w]+$/.test(entry.name))
    .map(entry => path.join(packages, entry.name, 'LocalCache', 'Local', 'CodexScheduler'));
}

// AppData is virtualized inside the Windows desktop package. Keep only its
// canonical path in Codex home, so an external CMD sees the same queue/worker.
export async function recordInstallation({ paths = getPaths(), platform = process.platform,
  explicitDataDir = process.env.SCHEDULER_DATA_DIR, legacyDirectories = legacyWindowsDataDirectories } = {}) {
  let selected = paths.dataDir;
  const exists = file => fs.stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  // An external first upgrade from 0.2.0 has no pointer yet. If its ordinary
  // AppData has no queue, recover only this plugin's known Codex package data.
  if (platform === 'win32' && !explicitDataDir && !await exists(paths.installationPath) && !await exists(path.join(selected, 'queue.json'))) {
    const candidates = [];
    for (const directory of await legacyDirectories()) {
      if (await exists(path.join(directory, 'queue.json'))) candidates.push(await fs.realpath(directory));
    }
    const unique = [...new Set(candidates)];
    if (unique.length > 1) throw new Error('发现多份时序历史队列，未覆盖数据；请先指定 SCHEDULER_DATA_DIR。');
    if (unique.length === 1) selected = unique[0];
  }
  await fs.mkdir(selected, { recursive: true });
  const dataDir = await fs.realpath(selected);
  await fs.mkdir(path.dirname(paths.installationPath), { recursive: true });
  const temporary = `${paths.installationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, dataDir }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, paths.installationPath);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return { dataDir };
}
