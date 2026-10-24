import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { getPaths } from './paths.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const LOCAL_PIPE = /^\\\\\.\\pipe\\[^\\/\u0000-\u001f]+$/i;
const READ_TOOLS = ['list_projects', 'list_threads', 'list_archived_threads', 'read_thread', 'wait_threads', 'get_usage_limits', 'list_artifacts', 'read_thread_terminal'];
const ALLOWED_TOOLS = new Set([...READ_TOOLS, 'send_message_to_thread']);
const SAFE_ENV = new Set(['systemroot', 'windir', 'comspec', 'pathext', 'path', 'home', 'userprofile', 'localappdata', 'appdata', 'temp', 'tmp', 'codex_home', 'codex_mcp_node_path', 'codex_browser_use_node_path', 'codex_electron_resources_path', 'codex_cli_path', 'xdg_cache_home', 'codex_app_tools_caller_host_id']);

export class DesktopClientError extends Error {
  constructor(message, { code = 'DESKTOP_UNAVAILABLE', stage = 'preCall', uncertain = false, cause } = {}) {
    super(message, { cause });
    this.name = 'DesktopClientError';
    this.code = code;
    this.stage = stage;
    this.uncertain = uncertain;
  }
}

function sourceId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new DesktopClientError('尚未登记真实的来源对话。请在 Codex 中重新加载时序插件，已有任务会保留。', { code: 'DESKTOP_CONTEXT_INVALID' });
  return value;
}

// Accept the same genuine executor metadata forms as the official app tools.
// An explicit but invalid/ambiguous source must never silently become another
// chat from the process environment or the last saved registration.
export function resolveDesktopSourceThreadId(meta = {}, env = process.env) {
  const candidates = [];
  const append = value => { candidates.push(sourceId(typeof value === 'string' ? value.trim() : value)); };
  if (meta && typeof meta === 'object') {
    for (const key of ['openai/threadId', 'openai/thread_id', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id']) {
      if (Object.hasOwn(meta, key)) append(meta[key]);
    }
    if (Object.hasOwn(meta, 'x-codex-turn-metadata')) {
      let turn = meta['x-codex-turn-metadata'];
      if (typeof turn === 'string') {
        try { turn = JSON.parse(turn); }
        catch { throw new DesktopClientError('来源对话信息无效，请从 Codex 重新打开时序插件。', { code: 'DESKTOP_CONTEXT_INVALID' }); }
      }
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new DesktopClientError('来源对话信息无效，请从 Codex 重新打开时序插件。', { code: 'DESKTOP_CONTEXT_INVALID' });
      if (Object.hasOwn(turn, 'thread_id')) append(turn.thread_id);
    }
    if (meta.thread && typeof meta.thread === 'object' && Object.hasOwn(meta.thread, 'id')) append(meta.thread.id);
  }
  if (new Set(candidates).size > 1) throw new DesktopClientError('来源对话信息不一致，请从 Codex 重新打开时序插件。', { code: 'DESKTOP_CONTEXT_INVALID' });
  if (candidates.length) return candidates[0];
  return env.CODEX_THREAD_ID === undefined ? undefined : sourceId(env.CODEX_THREAD_ID);
}

function validateDescriptor(value) {
  if (!value || typeof value !== 'object' || typeof value.pipePath !== 'string' || !LOCAL_PIPE.test(value.pipePath) || value.pipePath.length > 512) {
    throw new DesktopClientError('桌面连接信息无效，请从 Codex 重新打开插件。', { code: 'DESKTOP_CONNECTION_INVALID' });
  }
  sourceId(value.sourceThreadId);
  if (typeof value.registeredAt !== 'string' || !Number.isFinite(Date.parse(value.registeredAt))) throw new DesktopClientError('桌面连接登记时间无效。', { code: 'DESKTOP_CONNECTION_INVALID' });
  return { pipePath: value.pipePath, sourceThreadId: value.sourceThreadId, registeredAt: value.registeredAt };
}

// This endpoint is supplied by the real desktop executor. Never scan for a pipe
// or accept a remote host, and never persist tokens or historical tool-call IDs.
export async function registerDesktopConnection({ sourceThreadId, pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH, dataDir = getPaths().dataDir } = {}) {
  const descriptor = validateDescriptor({ sourceThreadId, pipePath, registeredAt: new Date().toISOString() });
  await fs.mkdir(dataDir, { recursive: true });
  const destination = path.join(dataDir, 'desktop-connection.json');
  const temporary = path.join(dataDir, `.desktop-connection-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return descriptor;
}

// The desktop starts local MCP servers during discovery. Registering its real
// context here needs no scheduler tool call, model request, or interactive hook.
// An ordinary launcher deliberately cannot invent this missing context.
export async function registerDesktopConnectionFromHost({ env = process.env, dataDir = getPaths().dataDir } = {}) {
  const missingContext = { registered: false, code: 'DESKTOP_HOST_CONTEXT_MISSING', message: '尚未登记 Codex 桌面连接。请打开 Codex 并重新加载时序插件，已有任务会保留。' };
  if (!env.CODEX_APP_TOOLS_PIPE_PATH) return missingContext;
  try {
    // The desktop may initialize a global MCP connection without a per-chat ID.
    // Its fresh host-supplied endpoint can still renew an existing registration;
    // only an already validated genuine source may be reused in that case.
    let sourceThreadId;
    if (env.CODEX_THREAD_ID === undefined) {
      let saved;
      try { saved = await fs.readFile(path.join(dataDir, 'desktop-connection.json'), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return missingContext; throw error; }
      sourceThreadId = validateDescriptor(JSON.parse(saved)).sourceThreadId;
    } else sourceThreadId = sourceId(env.CODEX_THREAD_ID);
    await registerDesktopConnection({ sourceThreadId, pipePath: env.CODEX_APP_TOOLS_PIPE_PATH, dataDir });
    return { registered: true };
  } catch (error) {
    return { registered: false, code: error.code || 'DESKTOP_REGISTRATION_FAILED', message: error instanceof DesktopClientError ? error.message : '无法保存 Codex 桌面连接，请重新加载时序插件。' };
  }
}

export async function discoverDesktopServer({ codexHome = getPaths().codexHome } = {}) {
  const directory = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (cause) { throw new DesktopClientError('未找到 Codex 官方桌面工具，请在桌面应用中重新打开插件。', { code: 'DESKTOP_SERVER_MISSING', cause }); }
  const versions = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(directory, version, 'server.mjs');
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* An incomplete installed version is not usable. */ }
  }
  throw new DesktopClientError('未找到 Codex 官方桌面工具服务。', { code: 'DESKTOP_SERVER_MISSING' });
}

function safeEnvironment(pipePath) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (SAFE_ENV.has(name.toLowerCase())) env[name] = value;
  env.CODEX_APP_TOOLS_PIPE_PATH = pipePath;
  delete env.CODEX_TOOL_CALL_ID;
  return env;
}

function transportError(cause, pending) {
  const uncertain = pending?.dispatched === true;
  return new DesktopClientError(uncertain ? '桌面连接中断，无法确认这次操作是否已执行，请先核对目标对话。' : '无法连接 Codex 桌面，请打开桌面应用并重新打开插件。', {
    code: uncertain ? 'DESKTOP_CALL_UNCERTAIN' : 'DESKTOP_UNAVAILABLE', stage: uncertain ? 'toolCall' : 'preCall', uncertain, cause,
  });
}

class StdioConnection {
  constructor(serverPath, descriptor) { this.serverPath = serverPath; this.descriptor = descriptor; this.pending = new Map(); this.sequence = 0; this.proc = null; this.closed = false; }
  async start(timeoutMs) {
    const proc = spawn(process.execPath, [this.serverPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: safeEnvironment(this.descriptor.pipePath) });
    this.proc = proc;
    // Official host logs can contain private context; never copy them to logs.
    proc.stderr.resume();
    this.lines = readline.createInterface({ input: proc.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id != null) {
        // No implicit approval or elicitation is allowed in a background client.
        this.write({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'This background client cannot approve interactive requests.' } }) });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) {
        const staleEndpoint = !pending.dispatched && /(?:connect\s+)?(?:ENOENT|ECONNREFUSED)\b/i.test(message.error.message || '');
        pending.reject(new DesktopClientError(pending.dispatched ? '桌面工具返回错误，请核对目标对话后再决定是否重试。' : staleEndpoint ? 'Codex 桌面连接已失效，请在 Codex 中重新打开时序插件以刷新连接。已有任务会保留。' : 'Codex 桌面工具连接失败。', {
          code: pending.dispatched ? 'DESKTOP_CALL_UNCERTAIN' : staleEndpoint ? 'DESKTOP_ENDPOINT_STALE' : 'DESKTOP_CONNECT_FAILED', stage: pending.dispatched ? 'toolCall' : 'preCall', uncertain: pending.dispatched,
          cause: Object.assign(new Error(message.error.message || 'MCP request failed'), { code: message.error.code }),
        }));
      } else pending.resolve(message.result);
    });
    const disconnected = cause => {
      if (this.closed) return;
      this.closed = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(transportError(cause, pending)); }
      this.pending.clear();
    };
    proc.once('error', disconnected);
    proc.once('exit', () => disconnected(new Error('Official desktop MCP exited.')));
    proc.stdin.on('error', disconnected);
    try {
      await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-scheduler', version: '0.3.4' } }, timeoutMs);
      this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const result = await this.request('tools/list', {}, timeoutMs);
      this.tools = new Set((result?.tools || []).map(tool => tool.name));
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  write(message, onError = () => {}) {
    if (!this.proc || this.closed || this.proc.stdin.destroyed || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) onError(error); });
    return true;
  }
  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      let payload;
      try { payload = { jsonrpc: '2.0', id: ++this.sequence, method, params }; JSON.stringify(payload); }
      catch (cause) { reject(new DesktopClientError('桌面工具参数无法编码。', { code: 'DESKTOP_ARGUMENTS_INVALID', cause })); return; }
      const pending = { resolve, reject, dispatched: false };
      const fail = cause => { if (!this.pending.delete(payload.id)) return; clearTimeout(pending.timer); reject(transportError(cause, pending)); };
      pending.timer = setTimeout(() => fail(new Error('Official desktop MCP timed out.')), timeoutMs);
      this.pending.set(payload.id, pending);
      if (!this.proc || this.closed || this.proc.stdin.destroyed || !this.proc.stdin.writable) { fail(new Error('Official desktop MCP is not connected.')); return; }
      pending.dispatched = method === 'tools/call';
      try { if (!this.write(payload, fail)) { pending.dispatched = false; fail(new Error('Official desktop MCP is not writable.')); } }
      catch (cause) { fail(cause); }
    });
  }
  async close() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    if (proc.exitCode === null) {
      proc.stdin.end();
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); proc.off('exit', done); resolve(); };
        const timer = setTimeout(done, 300);
        proc.once('exit', done);
      });
      if (proc.exitCode === null) proc.kill();
    }
    this.lines?.close();
  }
}

export class DesktopClient {
  constructor({ dataDir = getPaths().dataDir, serverPath, connectTimeoutMs = 10000, timeoutMs = 30000 } = {}) {
    this.dataDir = dataDir; this.serverPath = serverPath; this.connectTimeoutMs = connectTimeoutMs; this.timeoutMs = timeoutMs;
    this.connection = null; this.fingerprint = null; this.operations = Promise.resolve();
  }
  // Internal adapter context only: this contains the local endpoint and must
  // never be included in dashboard responses or ordinary task summaries.
  async connectionInfo() {
    try { return validateDescriptor(JSON.parse(await fs.readFile(path.join(this.dataDir, 'desktop-connection.json'), 'utf8'))); }
    catch (cause) {
      if (cause instanceof DesktopClientError) throw cause;
      throw new DesktopClientError('尚未登记 Codex 桌面连接。请打开 Codex 并重新加载时序插件，已有任务会保留。', { code: 'DESKTOP_NOT_CONNECTED', cause });
    }
  }
  callTool(name, args = {}, { sourceThreadId, timeoutMs = this.timeoutMs } = {}) {
    const operation = this.operations.then(async () => {
      if (!ALLOWED_TOOLS.has(name)) throw new DesktopClientError('此桌面工具不在定时插件允许的范围内。', { code: 'DESKTOP_TOOL_NOT_ALLOWED' });
      const descriptor = await this.connectionInfo();
      const caller = sourceId(sourceThreadId ?? descriptor.sourceThreadId);
      const fingerprint = JSON.stringify(descriptor);
      if (this.connection?.closed || fingerprint !== this.fingerprint) { await this.connection?.close(); this.connection = null; this.fingerprint = null; }
      if (!this.connection) {
        const connection = new StdioConnection(this.serverPath || await discoverDesktopServer(), descriptor);
        await connection.start(this.connectTimeoutMs);
        this.connection = connection; this.fingerprint = fingerprint;
      }
      if (!this.connection.tools.has(name)) throw new DesktopClientError('当前桌面版本未提供此工具，请更新或重新打开 Codex。', { code: 'DESKTOP_TOOL_UNAVAILABLE' });
      try {
        return await this.connection.request('tools/call', { name, arguments: args, _meta: { 'openai/threadId': caller } }, timeoutMs);
      } catch (error) {
        // Never retry after a tools/call write: the host may already have sent it.
        await this.connection.close(); this.connection = null; this.fingerprint = null;
        throw error;
      }
    });
    this.operations = operation.catch(() => {});
    return operation;
  }
  async close() {
    const operation = this.operations.then(async () => { await this.connection?.close(); this.connection = null; this.fingerprint = null; });
    this.operations = operation.catch(() => {});
    return operation;
  }
}

export function parseToolJSON(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  return JSON.parse(text);
}
