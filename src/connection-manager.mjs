import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const run = promisify(execFile);
// This fixed host route carries no prompt, credential, local token or caller ID.
export const INITIALIZATION_URL = 'codex://plugins/codex-scheduler%40local-scheduler/app/scheduler_open?path=%2Finitialize';

export async function openCodexInitialization({ platform = process.platform, env = process.env, systemRoot = env.SystemRoot || 'C:\\Windows', runCommand = run } = {}) {
  if (platform !== 'win32') throw new Error('一键初始化需要 Windows 上的 Codex 桌面。');
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // ShellExecute resolves the current user's registered Codex app, including
  // Store installs. Never guess a WindowsApps path or restart the user's app.
  const url = new URL(INITIALIZATION_URL);
  url.searchParams.set('path', '/initialize?attempt=' + randomBytes(16).toString('hex'));
  const environment = { ...env };
  const blocked = new Set(['psmodulepath', 'node_options', 'node_path', 'codex_app_tools_pipe_path', 'codex_thread_id', 'codex_tool_call_id', 'codex_app_tools_caller_host_id']);
  for (const name of Object.keys(environment)) if (blocked.has(name.toLowerCase())) delete environment[name];
  await runCommand(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; Start-Process -FilePath '${url.href}' -ErrorAction Stop`],
  { windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024, env: environment });
}

export class DesktopConnectionManager {
  constructor({ adapter, openInitialization = openCodexInitialization, clock = Date.now, initializationTimeoutMs = 60000 } = {}) {
    this.adapter = adapter; this.openInitialization = openInitialization; this.clock = clock;
    this.initializationTimeoutMs = initializationTimeoutMs;
    this.desktop = { connected: false, message: '正在连接 Codex。' };
    this.state = { status: 'idle', message: '正在自动连接 Codex。' };
    this.failures = 0; this.checked = false; this.nextAttemptAt = 0; this.deadline = null;
    this.pending = null; this.initializing = null; this.opening = false; this.stopped = false; this.timer = null; this.revision = 0;
  }
  snapshot() {
    if (this.deadline !== null && this.clock() >= this.deadline && !this.desktop.connected && !this.opening) {
      this.deadline = null;
      this.state = { ...this.state, status: 'error', message: '初始化未完成。请确认 Codex 已登录并启用时序插件，然后重试。' };
      this.revision++;
    }
    return structuredClone({ desktop: this.desktop, initialization: { ...this.state,
      canInitialize: !this.stopped && !this.desktop.connected && !this.opening && this.deadline === null,
      nextAttemptAt: this.nextAttemptAt ? new Date(this.nextAttemptAt).toISOString() : null,
      deadlineAt: this.deadline === null ? null : new Date(this.deadline).toISOString(), revision: this.revision } });
  }
  check({ force = false } = {}) {
    if (this.stopped) return Promise.resolve(this.snapshot());
    if (this.pending) return this.pending;
    if (!force && this.checked && this.clock() < this.nextAttemptAt) return Promise.resolve(this.snapshot());
    if (!this.desktop.connected && this.deadline === null && this.state.status !== 'error') this.state = { ...this.state, status: 'connecting', message: '正在自动连接 Codex。' };
    const operation = (async () => {
      let desktop;
      try { desktop = force ? await this.adapter.reconnectDesktop() : await this.adapter.desktopStatus({ refresh: true }); }
      catch { desktop = { connected: false, code: 'DESKTOP_UNAVAILABLE', message: '暂时无法连接 Codex。' }; }
      if (this.stopped) return this.snapshot();
      this.checked = true;
      this.desktop = desktop?.connected === true ? { connected: true } : {
        connected: false, ...(typeof desktop?.code === 'string' && /^[A-Z_]{3,60}$/.test(desktop.code) ? { code: desktop.code } : {}),
        message: 'Codex 尚未连接。',
      };
      if (this.desktop.connected) {
        this.failures = 0; this.deadline = null;
        this.state = { ...this.state, status: 'connected', message: '已连接 Codex。' };
        this.nextAttemptAt = this.clock() + 15000;
      } else {
        this.failures++;
        this.snapshot();
        if (this.deadline !== null) this.state = { ...this.state, status: 'waiting', message: '已打开 Codex，正在等待连接。' };
        else if (this.state.status !== 'error') this.state = { ...this.state, status: 'idle', message: '自动连接未成功，可点击“一键初始化”。' };
        this.nextAttemptAt = this.clock() + (this.deadline !== null ? 2000 : [3000, 10000, 30000][Math.min(this.failures - 1, 2)]);
      }
      this.revision++;
      return this.snapshot();
    })();
    this.pending = operation;
    void operation.finally(() => { if (this.pending === operation) this.pending = null; });
    return operation;
  }
  initialize() {
    if (this.initializing) return this.initializing;
    const current = this.snapshot();
    if (this.stopped || this.deadline !== null || this.opening) return Promise.resolve(current);
    const operation = (async () => {
      const connected = await this.check({ force: true });
      if (this.stopped || connected.desktop.connected) return this.snapshot();
      this.opening = true;
      this.deadline = this.clock() + this.initializationTimeoutMs;
      this.state = { status: 'waiting', startedAt: new Date(this.clock()).toISOString(), message: '正在打开 Codex。' };
      this.revision++;
      try {
        await this.openInitialization();
        if (!this.stopped && !this.desktop.connected) this.state = { ...this.state, status: 'waiting', message: '已打开 Codex，正在等待连接。' };
      } catch {
        if (!this.stopped && !this.desktop.connected) {
          this.deadline = null;
          this.state = { ...this.state, status: 'error', message: '无法打开初始化入口。请先安装并打开 Codex，再重试。' };
        }
      } finally { this.opening = false; this.nextAttemptAt = this.clock(); this.revision++; }
      return this.snapshot();
    })();
    this.initializing = operation;
    void operation.finally(() => { if (this.initializing === operation) this.initializing = null; });
    return operation;
  }
  start() {
    if (this.timer || this.stopped) return;
    void this.check();
    this.timer = setInterval(() => { this.snapshot(); if (this.clock() >= this.nextAttemptAt) void this.check(); }, 1000);
    this.timer.unref?.();
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.timer = null;
    await Promise.allSettled([this.pending, this.initializing]);
  }
}
