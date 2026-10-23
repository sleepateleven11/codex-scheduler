import fs from "node:fs/promises";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {getPaths} from "./paths.mjs";
import {MARKETPLACE_NAME, PLUGIN_NAME, samePath} from "../scripts/plugin-common.mjs";

const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Query only Node processes whose command references this plugin's cache. The
// argv parser avoids substring matches against unrelated commands or flags.
export async function cachedMcpProcesses() {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SchedulerProcessArgv {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  public static string[] Parse(string commandLine) {
    int count; IntPtr pointer=CommandLineToArgvW(commandLine, out count);
    if(pointer==IntPtr.Zero) return new string[0];
    try { string[] args=new string[count]; for(int i=0;i<count;i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size)); return args; }
    finally { LocalFree(pointer); }
  }
}
'@
@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/','\\').IndexOf('\\plugins\\cache\\local-scheduler\\codex-scheduler\\',[StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object {
  [pscustomobject]@{ pid=[int]$_.ProcessId; executablePath=$_.ExecutablePath; argv=@([SchedulerProcessArgv]::Parse($_.CommandLine)); createdAt=$_.CreationDate.ToUniversalTime().ToString('o') }
}) | ConvertTo-Json -Depth 5 -Compress
`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  if (!stdout.trim()) return [];
  const rows = JSON.parse(stdout);
  return Array.isArray(rows) ? rows : [rows];
}

export async function selectCachedSchedulerMcps(rows, { codexHome = getPaths().codexHome, dataDir = getPaths().dataDir } = {}) {
  const cacheRoot = path.join(codexHome, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME);
  const stableDirectory = await fs.realpath(dataDir).catch(() => dataDir);
  const selected = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (!Number.isInteger(row.pid) || row.pid <= 0 || row.pid === process.pid || !Array.isArray(row.argv) || row.argv.length !== 2) continue;
    const [executable, script] = row.argv;
    if (typeof executable !== 'string' || typeof script !== 'string' || typeof row.executablePath !== 'string' || !path.isAbsolute(executable) || !path.isAbsolute(script) || path.basename(executable).toLowerCase() !== 'node.exe' || !samePath(executable, row.executablePath)) continue;
    const parts = path.relative(cacheRoot, script).split(path.sep);
    if (parts.length !== 3 || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(parts[0]) || parts[1].toLowerCase() !== 'src' || parts[2].toLowerCase() !== 'mcp-server.mjs') continue;
    const root = path.join(cacheRoot, parts[0]);
    try {
      const [manifest, mcp, realCacheRoot, realScript] = await Promise.all([
        fs.readFile(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8').then(JSON.parse),
        fs.readFile(path.join(root, '.mcp.json'), 'utf8').then(JSON.parse),
        fs.realpath(cacheRoot), fs.realpath(script),
      ]);
      const realParts = path.relative(realCacheRoot, realScript).split(path.sep);
      if (realParts.length !== 3 || realParts[0] !== parts[0] || realParts[1].toLowerCase() !== 'src' || realParts[2].toLowerCase() !== 'mcp-server.mjs') continue;
      const server = mcp.mcpServers?.codex_scheduler;
      if (manifest.name !== PLUGIN_NAME || manifest.version !== parts[0] || manifest.mcpServers !== './.mcp.json' || !server || !samePath(server.command, executable) || !(samePath(server.cwd, root) || samePath(server.cwd, stableDirectory)) || !Array.isArray(server.args) || server.args.length !== 1 || !samePath(server.args[0], script)) continue;
      selected.push(row);
    } catch { /* Missing or changed cache metadata is never permission to stop a process. */ }
  }
  return selected;
}

export async function stopCachedMcp(candidate) {
  // Revalidate PID, creation time and exact argv immediately before terminating
  // our disposable tool connection. The persistent daemon is a different file.
  const current = (await cachedMcpProcesses()).find(row => row.pid === candidate.pid && row.createdAt === candidate.createdAt && samePath(row.executablePath, candidate.executablePath) && JSON.stringify(row.argv) === JSON.stringify(candidate.argv));
  if (!current || !(await selectCachedSchedulerMcps([current])).length) return;
  try { process.kill(candidate.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(candidate.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await pause(50);
  }
  throw new Error('本插件的旧连接尚未完全退出，安装缓存保留，请稍后重试。');
}

export async function stopCachedSchedulerMcps({ codexHome = getPaths().codexHome, dataDir = getPaths().dataDir,
  listProcesses = cachedMcpProcesses, stopProcess = stopCachedMcp } = {}) {
  const candidates = await selectCachedSchedulerMcps(await listProcesses(), { codexHome, dataDir });
  for (const candidate of candidates) await stopProcess(candidate);
  return { stopped: candidates.length };
}

