import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

async function isFile(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }
export function assertNodeVersion(version = process.versions.node) {
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(String(version)) || Number(String(version).split('.')[0]) < 22) {
    throw new Error('需要 Node.js 22 或更高版本。请安装新版 Node.js，重新打开安装窗口后再试。');
  }
}

export async function discoverCodex({ env = process.env, platform = process.platform, home = os.homedir(), runCommand = run } = {}) {
  for (const name of ['SCHEDULER_CODEX_PATH', 'CODEX_CLI_PATH']) {
    const candidate = env[name];
    if (!candidate) continue;
    if (path.isAbsolute(candidate) && await isFile(candidate)) return candidate;
    throw new Error(`${name} 指定的 Codex 文件不存在，请修正路径后重试。`);
  }
  if (platform === 'win32') {
    const locals = [...new Set([env.LOCALAPPDATA, path.join(home, 'AppData', 'Local')].filter(Boolean))];
    for (const local of locals) {
      const base = path.join(local, 'OpenAI', 'Codex', 'bin');
      const dirs = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
      const versions = await Promise.all(dirs.filter(d => d.isDirectory()).map(async d => ({ file: path.join(base, d.name, 'codex.exe'), modified: (await fs.stat(path.join(base, d.name))).mtimeMs })));
      for (const v of versions.sort((a, b) => b.modified - a.modified)) if (await isFile(v.file)) return v.file;
    }
    const found = await runCommand('where.exe', ['codex.exe'], { windowsHide: true, env }).catch(() => ({ stdout: '' }));
    for (const file of found.stdout.trim().split(/\r?\n/)) if (file && await isFile(file)) return file;
    // Read only the current user's package registration; do not scan WindowsApps
    // or assume another computer has the developer's Codex version directory.
    const command = 'Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation | ConvertTo-Json -Compress';
    const registered = await runCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, env, timeout: 10000 }).catch(() => ({ stdout: '' }));
    let locations = [];
    try { const value = JSON.parse(registered.stdout.trim()); locations = Array.isArray(value) ? value : [value]; } catch {}
    for (const location of locations.filter(value => typeof value === 'string' && path.isAbsolute(value))) {
      for (const relative of ['app/resources/codex.exe', 'resources/codex.exe', 'resources/bin/codex.exe']) {
        const file = path.join(location, relative);
        if (await isFile(file)) return file;
      }
    }
  } else {
    for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const file = path.join(dir, 'codex');
      if (await isFile(file)) return file;
    }
  }
  throw new Error('未找到 Codex。请先安装并登录 Codex 桌面端。');
}
export function discoverNode() { assertNodeVersion(); return process.execPath; }
