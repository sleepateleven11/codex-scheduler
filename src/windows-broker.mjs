import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPaths } from './paths.mjs';

const run = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const normalized = value => path.normalize(path.resolve(value)).replace(/^\\\\\?\\/, '').toLowerCase();

// Keep the launcher independent of the invoking MCP process and its environment.
// Only these local path overrides may be persisted; credentials are never copied.
export function buildBrokerPlan({ paths = getPaths(), nodePath = process.execPath, env = process.env } = {}) {
  const hash = createHash('sha256').update(normalized(paths.dataDir)).digest('hex').slice(0, 24);
  const taskName = `CodexScheduler-${hash}`;
  const description = `Codex Scheduler on-demand background worker; scope=${hash}`;
  const launcherPath = path.join(paths.dataDir, 'worker-launcher.mjs');
  const explicitEnv = { SCHEDULER_DATA_DIR: paths.dataDir };
  for (const key of ['CODEX_HOME', 'SCHEDULER_CODEX_PATH', 'CODEX_CLI_PATH']) {
    if (env[key]) explicitEnv[key] = env[key];
  }
  const launcherSource = [
    "import fs from 'node:fs';",
    "import { format } from 'node:util';",
    ...Object.entries(explicitEnv).map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`),
    `const logPath = ${JSON.stringify(paths.logPath)};`,
    "const log = (...values) => fs.appendFileSync(logPath, format(...values) + '\\n', { mode: 0o600 });",
    'console.log = log; console.error = log;',
    `await import(${JSON.stringify(pathToFileURL(path.join(paths.root, 'src', 'daemon.mjs')).href)});`,
    '',
  ].join('\n');
  const command = `$ErrorActionPreference='Stop'; Remove-Item Env:NODE_OPTIONS,Env:NODE_PATH -ErrorAction SilentlyContinue; $worker = Start-Process -FilePath ${quote(nodePath)} -ArgumentList ${quote(`"${launcherPath}"`)} -WorkingDirectory ${quote(paths.root)} -WindowStyle Hidden -Wait -PassThru; exit $worker.ExitCode`;
  const actionArguments = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(command, 'utf16le').toString('base64')}`;
  return { taskName, description, launcherPath, launcherSource, actionExecute: 'powershell.exe', actionArguments, workingDirectory: paths.root };
}

async function planForCurrentDirectory() {
  const paths = getPaths();
  paths.dataDir = await fs.realpath(paths.dataDir).catch(error => { if (error.code === 'ENOENT') return paths.dataDir; throw error; });
  paths.logPath = path.join(paths.dataDir, 'worker.log');
  return buildBrokerPlan({ paths });
}

async function powershell(script, timeout) {
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';\n${script}`, 'utf16le').toString('base64');
  const env = { ...process.env };
  delete env.PSModulePath;
  try {
    const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, timeout, maxBuffer: 65536, env });
    return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {};
  } catch (error) {
    const detail = String(error.stderr || (error.killed ? 'Windows 后台启动请求超时。' : error.message)).trim();
    throw new Error(`Windows 后台启动器操作失败：${detail}`);
  }
}

export function brokerTaskLookupScript(taskName) {
  return `
try { $task = Get-ScheduledTask -TaskName ${quote(taskName)} -ErrorAction Stop }
catch {
  if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_TaskName*') { $task = $null }
  else { throw }
}
`;
}

function inspectionScript(plan) {
  return `
${brokerTaskLookupScript(plan.taskName)}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$desiredPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$desiredSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Hidden
if ($task -and $task.Description -ne ${quote(plan.description)}) { throw '同名计划任务属于其他用途，未修改。' }
$matches = $false
if ($task) {
  $actions = @($task.Actions)
  $triggers = @($task.Triggers | Where-Object { $null -ne $_ })
  $matches = $actions.Count -eq 1 -and $actions[0].Execute -eq ${quote(plan.actionExecute)} -and $actions[0].Arguments -eq ${quote(plan.actionArguments)} -and $actions[0].WorkingDirectory -eq ${quote(plan.workingDirectory)} -and $triggers.Count -eq 0 -and $task.Principal.LogonType -eq $desiredPrincipal.LogonType -and $task.Principal.RunLevel -eq $desiredPrincipal.RunLevel -and ($task.Principal.UserId -eq $identity.Name -or $task.Principal.UserId -eq $identity.User.Value) -and $task.Settings.ExecutionTimeLimit -eq $desiredSettings.ExecutionTimeLimit -and $task.Settings.MultipleInstances -eq $desiredSettings.MultipleInstances -and $task.Settings.Hidden -and $task.Settings.Enabled -and -not $task.Settings.DisallowStartIfOnBatteries -and -not $task.Settings.StopIfGoingOnBatteries
}
`;
}

async function atomicLauncher(plan) {
  const temporary = `${plan.launcherPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, plan.launcherSource, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, plan.launcherPath);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function startWindowsBroker({ timeoutMs = 25000 } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows 后台启动器仅适用于 Windows。');
  await fs.mkdir(getPaths().dataDir, { recursive: true });
  const plan = await planForCurrentDirectory();
  const deadline = Date.now() + timeoutMs;
  const remaining = maximum => {
    const time = deadline - Date.now();
    if (time <= 0) throw new Error('Windows 后台启动器响应超时，请稍后重试。');
    return Math.min(maximum, time);
  };
  const current = await powershell(`${inspectionScript(plan)}
@{ exists=[bool]$task; running=([bool]$task -and $task.State.ToString() -eq 'Running'); matches=[bool]$matches } | ConvertTo-Json -Compress
`, remaining(10000));
  const existingSource = await fs.readFile(plan.launcherPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (current.running) {
    if (!current.matches || existingSource !== plan.launcherSource) throw new Error('后台正在运行，启动路径或设置已改变；请先停止后台，再重新打开插件。');
    return { taskName: plan.taskName, running: true };
  }
  if (existingSource !== plan.launcherSource) await atomicLauncher(plan);
  return powershell(`${inspectionScript(plan)}
if ($task -and $task.State.ToString() -eq 'Running') {
  if (-not $matches) { throw '后台正在运行，不能更新启动设置。' }
} else {
  if (-not $matches) {
    $action = New-ScheduledTaskAction -Execute ${quote(plan.actionExecute)} -Argument ${quote(plan.actionArguments)} -WorkingDirectory ${quote(plan.workingDirectory)}
    Register-ScheduledTask -TaskName ${quote(plan.taskName)} -Description ${quote(plan.description)} -Action $action -Principal $desiredPrincipal -Settings $desiredSettings -Force | Out-Null
  }
  Start-ScheduledTask -TaskName ${quote(plan.taskName)}
}
@{ taskName=${quote(plan.taskName)}; started=$true } | ConvertTo-Json -Compress
`, remaining(15000));
}

export async function removeBrokerTask() {
  if (process.platform !== 'win32') return { removed: false };
  const plan = await planForCurrentDirectory();
  return powershell(`
${brokerTaskLookupScript(plan.taskName)}
if ($task) {
  if ($task.Description -ne ${quote(plan.description)}) { throw '同名计划任务属于其他用途，未删除。' }
  Unregister-ScheduledTask -TaskName ${quote(plan.taskName)} -Confirm:$false
}
@{ removed=[bool]$task } | ConvertTo-Json -Compress
`, 15000);
}
