import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export function getPaths() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const installationPath = path.join(codexHome, 'codex-scheduler-install.json');
  let savedDataDir;
  if (!process.env.SCHEDULER_DATA_DIR) {
    try {
      const saved = JSON.parse(readFileSync(installationPath, 'utf8'));
      if (saved.version !== 1 || typeof saved.dataDir !== 'string' || !path.isAbsolute(saved.dataDir)) throw new Error('Invalid installation path.');
      savedDataDir = saved.dataDir;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取时序的本机安装信息，原文件已保留。');
    }
  }
  const dataDir = path.resolve(process.env.SCHEDULER_DATA_DIR || savedDataDir || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'CodexScheduler'));
  return { root, dataDir, endpointPath: path.join(dataDir, 'endpoint.json'), storePath: path.join(dataDir, 'queue.json'), logPath: path.join(dataDir, 'worker.log'), lockPath: path.join(dataDir, 'worker.lock'), configPath: path.join(dataDir, 'settings.json'), codexHome, installationPath };
}
