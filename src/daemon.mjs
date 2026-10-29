import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPaths } from './paths.mjs';
import { CodexAdapter } from './codex-adapter.mjs';
import { QueueManager } from './queue.mjs';
import { QuotaCycleManager } from './quota-cycle.mjs';
import { PreferencesStore } from './preferences.mjs';
import { DiagnosticsService } from './diagnostics.mjs';
import { DesktopConnectionManager } from './connection-manager.mjs';

const paths = getPaths();
const version = '0.4.1';
const preferences = new PreferencesStore(paths.configPath);
const startedAt = new Date().toISOString();
let lockHandle; let server; let mutexServer; let queue; let quotaCycles; let adapter; let diagnostics; let connections; let endpoint; let stopping = false;
const mutexSockets = new Set();

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function claimProcessMutex() {
  if (process.platform !== 'win32') return true;
  await fs.mkdir(paths.dataDir, { recursive: true });
  const canonical = path.normalize(await fs.realpath(paths.dataDir)).replace(/^\\\\\?\\/, '').toLowerCase();
  const suffix = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  const pipe = `\\\\.\\pipe\\codex-scheduler-${suffix}`;
  const candidate = net.createServer(socket => {
    mutexSockets.add(socket);
    socket.once('close', () => mutexSockets.delete(socket));
    socket.on('error', () => {});
    socket.end();
  });
  const claimed = await new Promise((resolve, reject) => {
    candidate.once('error', error => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    candidate.listen(pipe, () => resolve(true));
  });
  if (claimed) {
    mutexServer = candidate;
    candidate.removeAllListeners('error');
    candidate.on('error', error => { logShutdownError(error); void shutdown().catch(logShutdownError); });
  }
  return claimed;
}
async function claimLock() {
  await fs.mkdir(paths.dataDir, { recursive: true });
  try { lockHandle = await fs.open(paths.lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let old;
    try { old = JSON.parse(await fs.readFile(paths.lockPath, 'utf8')); }
    catch { old = {}; }
    const stat = await fs.stat(paths.lockPath);
    if (old.pid && alive(old.pid) || !old.pid && Date.now() - stat.mtimeMs < 60000) return false;
    await fs.unlink(paths.lockPath);
    try { lockHandle = await fs.open(paths.lockPath, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  }
  await lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt }));
  await lockHandle.sync();
  return true;
}
function json(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); }
async function body(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 150000) throw new Error('内容过长，请缩短后重试。');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
function authorized(request) {
  const token = request.headers.authorization?.replace(/^Bearer /, '') || '';
  const a = Buffer.from(token); const b = Buffer.from(endpoint.token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function workerState() { const lastError = queue.lastTickError || quotaCycles?.lastTickError || null; return { status: stopping ? 'stopping' : lastError ? 'attention' : 'running', startedAt, version, lastError }; }
function acceptingChanges() { if (stopping) throw Object.assign(new Error('后台正在停止，请稍后重新打开插件。'), { statusCode: 503 }); }
async function route(request, response) {
  const origin = `http://127.0.0.1:${endpoint.port}`;
  if (request.headers.host !== `127.0.0.1:${endpoint.port}` && request.headers.host !== `localhost:${endpoint.port}`) return json(response, 403, { message: '无效的访问地址。' });
  if (request.headers.origin && ![origin, `http://localhost:${endpoint.port}`].includes(request.headers.origin)) return json(response, 403, { message: '访问来源不匹配。' });
  const url = new URL(request.url, origin);
  response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
  if (url.pathname.startsWith('/api/')) {
    if (!authorized(request)) return json(response, 401, { error: 'unauthorized', message: '连接已失效，请双击“时序任务管理器”重新打开。' });
    if (url.pathname === '/api/health') return json(response, 200, { worker: workerState() });
    if (request.method === 'POST' && url.pathname === '/api/stop') {
      stopping = true; json(response, 200, { stopped: true, pending: queue.list().some(t => t.status === 'running') });
      void shutdown().catch(logShutdownError); return;
    }
    if (stopping) return json(response, 503, { message: '后台正在停止，请稍后重新打开插件。' });
    if (request.method === 'POST' && url.pathname === '/api/desktop/reconnect') {
      return json(response, 200, await connections.check({ force: true }));
    }
    if (request.method === 'POST' && url.pathname === '/api/desktop/initialize') {
      const input = await body(request);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('初始化不接受自定义参数。');
      return json(response, 200, await connections.initialize());
    }
    if (url.pathname === '/api/diagnostics' && ['GET', 'POST'].includes(request.method)) {
      return json(response, 200, await diagnostics.run({ refresh: request.method === 'POST', reconnect: request.method === 'POST' }));
    }
    if (request.method === 'GET' && url.pathname === '/api/preferences') return json(response, 200, { preferences: await preferences.read() });
    if (request.method === 'PUT' && url.pathname === '/api/preferences') return json(response, 200, { preferences: await preferences.update(await body(request)) });
    if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
      const probes = await Promise.allSettled([adapter.projects(), adapter.models(), adapter.getQuota(), connections.check(), preferences.read(), diagnostics.run()]);
      const value = (index, fallback) => probes[index].status === 'fulfilled' ? probes[index].value : fallback;
      return json(response, 200, { projects: value(0, []), models: value(1, []), quota: value(2, null), ...value(3, connections.snapshot()), preferences: value(4, {}), diagnostics: value(5, null), worker: workerState(), tasks: queue.list(), quotaCycles: quotaCycles.list(), timeZone: 'Asia/Shanghai' });
    }
    if (request.method === 'GET' && url.pathname === '/api/threads') return json(response, 200, { threads: await adapter.threads(url.searchParams.get('projectPath') || '') });
    if (request.method === 'GET' && url.pathname === '/api/quota') return json(response, 200, await adapter.getQuota(url.searchParams.get('model'), { refresh: true }));
    if (request.method === 'GET' && url.pathname === '/api/tasks') return json(response, 200, { tasks: queue.list(), quotaCycles: quotaCycles.list(), worker: workerState(), quota: await adapter.getQuota(), ...await connections.check(), diagnostics: await diagnostics.run() });
    if (request.method === 'GET' && url.pathname === '/api/quota-cycles') return json(response, 200, { rules: quotaCycles.list() });
    if (request.method === 'POST' && url.pathname === '/api/quota-cycles') {
      const input = await body(request);
      const report = await diagnostics.run({ refresh: true });
      if (!report.ready) throw new Error('首次配置或连接自检尚未通过，请先完成页面上的检测步骤。');
      const validated = await adapter.validateTask({ ...input, sendMode: 'scheduled', runAt: new Date().toISOString() });
      acceptingChanges();
      return json(response, 201, { rule: await quotaCycles.create(validated) });
    }
    const cycleAction = /^\/api\/quota-cycles\/([a-f0-9-]+)\/action$/.exec(url.pathname);
    if (request.method === 'POST' && cycleAction) {
      const input = await body(request);
      if (!['pause', 'resume'].includes(input.action)) throw new Error('额度循环仅支持暂停或恢复。');
      if (input.action === 'resume') await adapter.validateTask(quotaCycles.get(cycleAction[1]));
      acceptingChanges();
      return json(response, 200, { rule: await quotaCycles[input.action](cycleAction[1]) });
    }
    const cycleMatch = /^\/api\/quota-cycles\/([a-f0-9-]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && cycleMatch) return json(response, 200, await quotaCycles.delete(cycleMatch[1]));
    if (request.method === 'PATCH' && cycleMatch) {
      const patch = await body(request);
      const validated = await adapter.validateTask({ ...quotaCycles.get(cycleMatch[1]), ...patch });
      acceptingChanges();
      return json(response, 200, { rule: await quotaCycles.update(cycleMatch[1], { ...patch, executionPath: validated.executionPath, projectLabel: validated.projectLabel, threadTitle: validated.threadTitle }) });
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const input = await body(request);
      const report = await diagnostics.run({ refresh: true });
      if (!report.ready) throw new Error('首次配置或连接自检尚未通过，请先完成页面上的检测步骤。');
      const validated = await adapter.validateTask(input);
      acceptingChanges();
      const task = await queue.create(validated);
      return json(response, 201, { task });
    }
    const actionMatch = /^\/api\/tasks\/([a-f0-9-]+)\/action$/.exec(url.pathname);
    if (request.method === 'POST' && actionMatch) {
      const input = await body(request); const id = actionMatch[1];
      if (!['pause', 'resume', 'cancel', 'retry', 'delete'].includes(input.action)) throw new Error('不支持的操作。');
      if (input.action === 'retry') await adapter.validateTask(queue.get(id));
      if (input.action === 'delete') return json(response, 200, await queue.delete(id));
      const task = await queue[input.action](id, { acknowledgeDuplicateRisk: input.acknowledgeDuplicateRisk === true });
      return json(response, 200, { task });
    }
    const taskMatch = /^\/api\/tasks\/([a-f0-9-]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && taskMatch) return json(response, 200, await queue.delete(taskMatch[1]));
    if (request.method === 'PATCH' && taskMatch) {
      const patch = await body(request); const validated = await adapter.validateTask({ ...queue.get(taskMatch[1]), ...patch });
      acceptingChanges();
      return json(response, 200, { task: await queue.update(taskMatch[1], { ...patch, executionPath: validated.executionPath, projectLabel: validated.projectLabel, threadTitle: validated.threadTitle }) });
    }
    return json(response, 404, { message: '未找到该功能。' });
  }
  if (request.method !== 'GET') return json(response, 405, { message: '不支持该请求方式。' });
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/ui-helpers.js': ['ui-helpers.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
  const selected = files[url.pathname];
  if (!selected) return json(response, 404, { message: '页面不存在。' });
  response.writeHead(200, { 'Content-Type': selected[1], 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  response.end(await fs.readFile(path.join(paths.root, 'public', selected[0])));
}
async function shutdown() {
  if (shutdown.promise) return shutdown.promise;
  stopping = true;
  shutdown.promise = (async () => {
    try {
      const results = await Promise.allSettled([quotaCycles?.stop(), queue?.stop(), connections?.stop()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    finally {
      try { await adapter?.close(); }
      finally {
        server?.closeAllConnections();
        if (server) await new Promise(resolve => server.close(resolve));
        if (lockHandle) await fs.unlink(paths.endpointPath).catch(() => {});
        await lockHandle?.close().catch(() => {});
        if (lockHandle) await fs.unlink(paths.lockPath).catch(() => {});
        for (const socket of mutexSockets) socket.destroy();
        if (mutexServer) await new Promise(resolve => mutexServer.close(resolve));
      }
    }
  })();
  await shutdown.promise;
  // Desktop transports can retain idle handles after their connections close.
  // Queue writes, sockets and metadata are released; end this dedicated worker
  // so the Windows background task can be launched again.
  setImmediate(() => process.exit(process.exitCode || 0));
}
function logShutdownError(error) { console.error(`Worker shutdown failed: ${error.message}`); process.exitCode = 1; }

try {
  // Windows owns this mutex for the process lifetime, including stale-file recovery.
  if (!await claimProcessMutex()) process.exit(0);
  if (!await claimLock()) process.exit(0);
  adapter = new CodexAdapter();
  connections = new DesktopConnectionManager({ adapter });
  diagnostics = new DiagnosticsService({ adapter, paths });
  queue = new QueueManager({ storePath: paths.storePath, adapter, maxConcurrent: 1 });
  await queue.initialize();
  quotaCycles = new QuotaCycleManager({ storePath: paths.quotaCyclesPath, queue, adapter });
  await quotaCycles.initialize();
  const token = randomBytes(32).toString('hex');
  server = http.createServer((request, response) => { void route(request, response).catch(error => { if (!response.headersSent) json(response, [409, 503].includes(error.statusCode) ? error.statusCode : 400, { error: ['task_busy', 'creation_deleted', 'deletion_persist_failed'].includes(error.code) ? error.code : 'operation_failed', message: error.message }); else response.destroy(); }); });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  endpoint = { pid: process.pid, port: server.address().port, token, startedAt, version };
  await fs.writeFile(paths.endpointPath, JSON.stringify(endpoint), { mode: 0o600 });
  queue.start();
  quotaCycles.start();
  connections.start();
  console.log(`${new Date().toISOString()} Scheduler worker ready`);
  process.on('SIGTERM', () => { void shutdown().catch(logShutdownError); });
  process.on('SIGINT', () => { void shutdown().catch(logShutdownError); });
} catch (error) {
  console.error(`${new Date().toISOString()} Worker startup failed: ${error.message}`);
  await shutdown().catch(logShutdownError);
  process.exitCode = 1;
}
