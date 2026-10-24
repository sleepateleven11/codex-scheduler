import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { getPaths } from './paths.mjs';
import { buildManagerIcon } from './launcher-icon.mjs';

const run = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const vbQuote = value => `"${String(value).replaceAll('"', '""')}"`;
const windowsPath = value => path.win32.normalize(value).replace(/^\\\\\?\\/, '').replace(/[\\/]$/, '').toLowerCase();

export function parseOpenArgs(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--url')) throw new Error('打开命令仅支持 --url 参数。');
  return { urlOnly: args[0] === '--url' };
}

// Open only this worker's local dashboard. Arguments are passed directly to the
// operating system, never interpolated into a shell command.
export function buildBrowserCommand(value, platform = process.platform) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length !== 1 || !/^[a-f0-9]{64}$/.test(url.searchParams.get('token') || '')) {
    throw new Error('定时任务管理器地址无效。');
  }
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url.href] };
  if (platform === 'darwin') return { command: 'open', args: [url.href] };
  return { command: 'xdg-open', args: [url.href] };
}

export async function launchBrowser(url, { platform = process.platform, spawnProcess = spawn } = {}) {
  const { command, args } = buildBrowserCommand(url, platform);
  await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { detached: true, windowsHide: true, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function absoluteWindows(value, label) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value) || /[\u0000-\u001f"]/.test(value)) throw new Error(`${label}必须是有效的 Windows 绝对路径。`);
  return path.win32.normalize(value);
}

// The shortcut contains paths only. A fresh port and dashboard token are read
// by open.mjs on each launch, so a restarted background worker keeps working.
export function buildWindowsLauncherPlan({ installedRoot, nodePath = process.execPath, dataDir = getPaths().dataDir, desktopDir, programsDir, systemRoot = process.env.SystemRoot || 'C:\\Windows', env = process.env }) {
  installedRoot = absoluteWindows(installedRoot, '插件目录');
  nodePath = absoluteWindows(nodePath, 'Node 路径');
  dataDir = absoluteWindows(dataDir, '任务数据目录');
  desktopDir = absoluteWindows(desktopDir, '桌面目录');
  programsDir = absoluteWindows(programsDir, '开始菜单目录');
  systemRoot = absoluteWindows(systemRoot, '系统目录');
  if (path.win32.basename(nodePath).toLowerCase() !== 'node.exe') throw new Error('启动器需要已验证的 Node 可执行文件。');
  const scope = createHash('sha256').update(windowsPath(dataDir)).digest('hex').slice(0, 24);
  const description = `Codex Scheduler manager; scope=${scope}`;
  const marker = `' ${description}`;
  const launcherPath = path.win32.join(dataDir, 'manager-launcher.vbs');
  const openScript = path.win32.join(installedRoot, 'scripts', 'open.mjs');
  const targetPath = path.win32.join(systemRoot, 'System32', 'wscript.exe');
  const argumentsString = `"${launcherPath}"`;
  const commandLine = `"${nodePath}" "${openScript}"`;
  const icon = buildManagerIcon();
  const iconPath = path.win32.join(dataDir, `manager-icon-${createHash('sha256').update(icon).digest('hex').slice(0, 16)}.ico`);
  const explicitEnv = { SCHEDULER_DATA_DIR: dataDir };
  for (const key of ['CODEX_HOME', 'SCHEDULER_CODEX_PATH', 'CODEX_CLI_PATH']) {
    if (env[key]) explicitEnv[key] = absoluteWindows(env[key], key);
  }
  const launcherSource = [marker,
    'Option Explicit', 'Dim shell, processEnv, result', 'Set shell = CreateObject("WScript.Shell")',
    'Set processEnv = shell.Environment("PROCESS")',
    'processEnv.Remove "NODE_OPTIONS"',
    'processEnv.Remove "NODE_PATH"',
    'processEnv.Remove "PSModulePath"',
    ...Object.entries(explicitEnv).map(([key, value]) => `processEnv(${vbQuote(key)}) = ${vbQuote(value)}`),
    `shell.CurrentDirectory = ${vbQuote(installedRoot)}`,
    'On Error Resume Next', `result = shell.Run(${vbQuote(commandLine)}, 0, True)`,
    'If Err.Number <> 0 Then',
    '  MsgBox "定时任务管理器未能启动，请重新安装插件以修复入口。", 48, "时序任务管理器"',
    '  WScript.Quit 1', 'End If', 'On Error GoTo 0', 'If result <> 0 Then',
    '  MsgBox "定时任务管理器暂时无法打开。请确认 Codex 已安装，并稍后重试；仍有问题可重新安装插件。", 48, "时序任务管理器"',
    'End If', 'WScript.Quit result', '',
  ].join('\r\n');
  return { scope, description, marker, launcherPath, launcherSource, targetPath, arguments: argumentsString, iconPath,
    workingDirectory: dataDir, iconLocation: iconPath + ',0',
    shortcuts: [desktopDir, programsDir].map(directory => path.win32.join(directory, '时序任务管理器.lnk')) };
}

export function ownsManagerShortcut(shortcut, plan) {
  return Boolean(shortcut && shortcut.description === plan.description && typeof shortcut.targetPath === 'string' &&
    windowsPath(shortcut.targetPath) === windowsPath(plan.targetPath) && shortcut.arguments === plan.arguments);
}

async function powershell(script) {
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);\n${script}`, 'utf16le').toString('base64');
  const env = { ...process.env };
  delete env.PSModulePath;
  try {
    const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000, maxBuffer: 65536, env });
    return stdout.trim() ? JSON.parse(stdout.trim()) : {};
  } catch (cause) { throw new Error(`快捷方式操作未完成：${String(cause.stderr || cause.message).trim()}`, { cause }); }
}

async function currentPlan({ installedRoot = getPaths().root, nodePath = process.execPath, dataDir = getPaths().dataDir, env = process.env, runPowerShell = powershell } = {}) {
  const dirs = await runPowerShell(`$shell = New-Object -ComObject WScript.Shell; @{ desktopDir=$shell.SpecialFolders.Item('Desktop'); programsDir=$shell.SpecialFolders.Item('Programs'); systemRoot=$env:SystemRoot } | ConvertTo-Json -Compress`);
  return buildWindowsLauncherPlan({ installedRoot, nodePath, dataDir: await fs.realpath(dataDir).catch(error => { if (error.code === 'ENOENT') return dataDir; throw error; }), env, ...dirs });
}

function shortcutHelpers(plan) {
  return `$shell = New-Object -ComObject WScript.Shell
$locations = @(${plan.shortcuts.map(quote).join(', ')})
function Test-OwnedShortcut($shortcut) {
  return $shortcut.Description -ceq ${quote(plan.description)} -and [string]::Equals($shortcut.TargetPath, ${quote(plan.targetPath)}, [StringComparison]::OrdinalIgnoreCase) -and $shortcut.Arguments -ceq ${quote(plan.arguments)}
}`;
}

export async function installManagerLaunchers({ platform = process.platform, runPowerShell = powershell, ...options } = {}) {
  if (platform !== 'win32') return { installed: false, shortcuts: [] };
  const plan = await currentPlan({ ...options, runPowerShell });
  await Promise.all([fs.access(path.win32.join(options.installedRoot || getPaths().root, 'scripts', 'open.mjs')), fs.access(plan.targetPath)]);
  const previous = await fs.readFile(plan.launcherPath, 'utf16le').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (previous !== null && previous.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] !== plan.marker) throw new Error('同名管理器启动文件属于其他用途，未覆盖。');
  // Inspect both existing links before changing either one. A same-name foreign
  // shortcut is not permission to replace it, even if its target is missing.
  await runPowerShell(`${shortcutHelpers(plan)}
foreach ($location in $locations) {
  if (Test-Path -LiteralPath $location) {
    if (-not (Test-OwnedShortcut ($shell.CreateShortcut($location)))) { throw '桌面或开始菜单中已有其他用途的同名快捷方式，未覆盖。' }
  }
}
@{ checked=$true } | ConvertTo-Json -Compress`);
  await fs.mkdir(path.dirname(plan.launcherPath), { recursive: true });
  const icon = buildManagerIcon();
  const previousIcon = await fs.readFile(plan.iconPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (previousIcon && !previousIcon.equals(icon)) throw new Error('同名管理器图标属于其他用途，未覆盖。');
  if (!previousIcon) await fs.writeFile(plan.iconPath, icon, { flag: 'wx', mode: 0o600 });
  const temporary = `${plan.launcherPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, '\uFEFF' + plan.launcherSource, { encoding: 'utf16le', flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, plan.launcherPath);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  const result = await runPowerShell(`${shortcutHelpers(plan)}
foreach ($location in $locations) {
  if (Test-Path -LiteralPath $location) {
    if (-not (Test-OwnedShortcut ($shell.CreateShortcut($location)))) { throw '同名快捷方式已改变，未覆盖。' }
  }
  $parent = [System.IO.Path]::GetDirectoryName($location)
  if (-not (Test-Path -LiteralPath $parent)) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
  $shortcut = $shell.CreateShortcut($location)
  $shortcut.TargetPath = ${quote(plan.targetPath)}
  $shortcut.Arguments = ${quote(plan.arguments)}
  $shortcut.WorkingDirectory = ${quote(plan.workingDirectory)}
  $shortcut.Description = ${quote(plan.description)}
  $shortcut.IconLocation = ${quote(plan.iconLocation)}
  $shortcut.WindowStyle = 7
  $shortcut.Save()
  if (-not (Test-OwnedShortcut ($shell.CreateShortcut($location)))) { throw '快捷方式保存后验证失败。' }
}
@{ installed=$true; shortcuts=$locations } | ConvertTo-Json -Compress`);
  return { ...result, launcherPath: plan.launcherPath };
}

export async function removeManagerLaunchers({ platform = process.platform, runPowerShell = powershell, ...options } = {}) {
  if (platform !== 'win32') return { removed: [], preserved: [] };
  const plan = await currentPlan({ ...options, runPowerShell });
  const result = await runPowerShell(`${shortcutHelpers(plan)}
$removed = @(); $preserved = @()
foreach ($location in $locations) {
  if (Test-Path -LiteralPath $location) {
    if (Test-OwnedShortcut ($shell.CreateShortcut($location))) { Remove-Item -LiteralPath $location; $removed += $location }
    else { $preserved += $location }
  }
}
@{ removed=@($removed); preserved=@($preserved) } | ConvertTo-Json -Compress`);
  const source = await fs.readFile(plan.launcherPath, 'utf16le').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (source !== null && source.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] === plan.marker) await fs.unlink(plan.launcherPath);
  const icon = await fs.readFile(plan.iconPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (icon?.equals(buildManagerIcon())) await fs.unlink(plan.iconPath);
  return result;
}
