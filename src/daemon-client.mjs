import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getPaths } from './paths.mjs';
import { startWindowsBroker } from './windows-broker.mjs';
import { registerDesktopConnectionFromHost } from './desktop-client.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readEndpoint() { try { return JSON.parse(await fs.readFile(getPaths().endpointPath, 'utf8')); } catch { return null; } }
async function call(endpoint, route, { method = 'GET', body, timeoutMs = 45000 } = {}) {
  if (!endpoint || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token || '')) throw new Error('后台连接信息无效。');
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
    method, headers: { Authorization: `Bearer ${endpoint.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || '操作未完成。');
  return data;
}
let starting;
export async function ensureDaemon() {
  if (starting) return starting;
  starting = ensureWorker().finally(() => { starting = null; });
  return starting;
}
async function ensureWorker() {
  // Only Codex-provided context can renew the desktop endpoint. Ordinary
  // desktop/browser launchers have no host context and leave it untouched.
  await registerDesktopConnectionFromHost();
  const useBroker = process.platform === 'win32' && process.env.SCHEDULER_LAUNCH_MODE !== 'direct';
  const deadline = Date.now() + (useBroker ? 45000 : 25000);
  let endpoint = await readEndpoint();
  if (endpoint) {
    let health;
    try { health = await call(endpoint, '/api/health', { timeoutMs: 1000 }); }
    catch { /* Try starting; exclusive worker lock resolves racing launches. */ }
    if (health?.worker?.status === 'stopping') throw new Error('后台正在停止，当前任务结束后可重新打开插件。');
    if (health?.worker?.version === '0.3.3') return endpoint;
  }
  const paths = getPaths();
  await fs.mkdir(paths.dataDir, { recursive: true });
  let launchError;
  if (useBroker) await startWindowsBroker({ timeoutMs: Math.min(25000, deadline - Date.now()) });
  else {
    const fd = openSync(paths.logPath, 'a', 0o600);
    try {
      const worker = spawn(process.execPath, [path.join(paths.root, 'src', 'daemon.mjs')], { cwd: paths.root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: process.env });
      worker.on('error', error => { launchError = error; });
      worker.unref();
    } finally { closeSync(fd); }
  }
  while (Date.now() < deadline) {
    if (launchError) throw new Error(`后台未能启动：${launchError.message}`);
    await delay(250);
    endpoint = await readEndpoint();
    if (!endpoint) continue;
    try {
      const health = await call(endpoint, '/api/health', { timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())) });
      if (health.worker?.status === 'stopping') throw new Error('后台正在停止。');
      if (health.worker?.version === '0.3.3') return endpoint;
    } catch { /* Still starting. */ }
  }
  throw new Error('后台未能启动。请查看插件状态或重新打开插件。');
}
export async function requestApi(route, options) { return call(await ensureDaemon(), route, options); }
export async function stopDaemon() {
  const endpoint = await readEndpoint();
  if (!endpoint) return { stopped: true };
  if (Number.isInteger(endpoint.pid) && endpoint.pid > 0) {
    try { process.kill(endpoint.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return { stopped: true, message: '后台进程已结束，任务数据保留。' }; }
  }
  try { return await call(endpoint, '/api/stop', { method: 'POST', body: {} }); }
  catch { return { stopped: false, message: '后台没有响应；请先确认正在执行的任务状态。' }; }
}
export function dashboardUrl(endpoint) { return `http://127.0.0.1:${endpoint.port}/?token=${endpoint.token}`; }
