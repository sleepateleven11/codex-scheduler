import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { discoverCodex } from './runtime.mjs';

export class RpcError extends Error { constructor(error) { super(error.message || 'Codex RPC error'); this.name = 'RpcError'; this.code = error.code; this.data = error.data; } }
export class CodexRpcClient extends EventEmitter {
  constructor({ codexPath, cwd, extraArgs = [] } = {}) { super(); this.codexPath = codexPath; this.cwd = cwd; this.extraArgs = extraArgs; this.pending = new Map(); this.serverRequests = new Set(); this.sequence = 0; this.proc = null; this.starting = null; this.closing = null; }
  async start() {
    if (this.closing) throw new Error('Codex 连接正在关闭。');
    if (this.proc && this.proc.exitCode === null && this.ready) return this;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async #start() {
    this.codexPath ||= await discoverCodex();
    const proc = spawn(this.codexPath, ['app-server', '--listen', 'stdio://', ...this.extraArgs], { cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.ready = false;
    // Runtime logs can contain private context; don't copy them to plugin logs.
    proc.stderr.resume();
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && !message.method && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new RpcError(message.error)); else pending.resolve(message.result);
      } else if (message.id != null && message.method) {
        this.serverRequests.add(message.id);
        try { this.emit('serverRequest', message); }
        catch { /* An observer must not leave the server waiting for permission. */ }
        finally {
          if (this.serverRequests.has(message.id)) this.respondError(message.id, '后台操作需要人工处理。请在 Codex 中打开该对话继续。');
        }
      } else this.emit('notification', message);
    });
    let disconnected = false;
    const exited = error => {
      if (this.proc !== proc || disconnected) return;
      disconnected = true;
      this.ready = false;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear(); this.serverRequests.clear(); this.emit('disconnected', error);
    };
    proc.stdin.on('error', error => { exited(error); if (proc.exitCode === null) proc.kill(); });
    proc.once('error', error => exited(error));
    proc.once('exit', () => exited(new Error('Codex 连接已关闭。')));
    try {
      await this.#request('initialize', { clientInfo: { name: 'codex_scheduler', title: 'Codex 定时任务', version: '0.3.3' }, capabilities: { experimentalApi: true } }, 30000);
      this.notify('initialized', {});
      this.ready = true;
    } catch (error) {
      if (proc.exitCode === null) proc.kill();
      throw error;
    }
    return this;
  }
  async request(method, params = {}, timeout = 30000) { await this.start(); return this.#request(method, params, timeout); }
  #request(method, params, timeout) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null || this.proc.stdin.destroyed || !this.proc.stdin.writable) { reject(new Error('Codex 连接已关闭。')); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); const error = new Error(`Codex 请求超时：${method}`); error.code = 'RPC_TIMEOUT'; reject(error); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  #write(message) {
    if (!this.proc || this.proc.stdin.destroyed || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(message) + '\n', () => {});
  }
  notify(method, params = {}) { this.#write({ method, params }); }
  respond(id, result) { if (!this.serverRequests.delete(id)) return; this.#write({ id, result }); }
  respondError(id, message) { if (!this.serverRequests.delete(id)) return; this.#write({ id, error: { code: -32001, message } }); }
  async close() {
    if (this.closing) return this.closing;
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    this.closing = (async () => {
      this.ready = false;
      proc.stdin.end();
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); proc.off('exit', done); resolve(); };
        const timer = setTimeout(done, 1500);
        proc.once('exit', done);
      });
      if (proc.exitCode === null) proc.kill();
    })();
    try { await this.closing; }
    finally { this.closing = null; }
  }
}
