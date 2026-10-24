import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { discoverCodex } from './runtime.mjs';
import { discoverDesktopServer } from './desktop-client.mjs';
import { getPaths } from './paths.mjs';

const check = (id, title, status, message) => ({ id, title, status, message });

// Reports only capability/status information. Never return raw RPC errors,
// config objects, account identifiers, pipe names, or authentication material.
export class DiagnosticsService {
  constructor({ adapter, paths = getPaths(), platform = process.platform, nodeVersion = process.versions.node,
    findCodex = discoverCodex, findDesktopServer = () => discoverDesktopServer({ codexHome: paths.codexHome }),
    checkStorage = () => fs.access(paths.dataDir, constants.R_OK | constants.W_OK), cacheMs = 10000 } = {}) {
    this.adapter = adapter; this.platform = platform; this.nodeVersion = nodeVersion;
    this.findCodex = findCodex; this.findDesktopServer = findDesktopServer; this.checkStorage = checkStorage;
    this.cacheMs = cacheMs; this.cached = null; this.checkedAt = 0; this.pending = null;
  }
  async run({ refresh = false, reconnect = false } = {}) {
    if (this.pending) {
      if (!reconnect) return this.pending;
      await this.pending;
    }
    if (!refresh && !reconnect && this.cached && Date.now() - this.checkedAt < this.cacheMs) return structuredClone(this.cached);
    const operation = this.inspect({ reconnect });
    this.pending = operation;
    try { this.cached = await operation; this.checkedAt = Date.now(); return structuredClone(this.cached); }
    finally { if (this.pending === operation) this.pending = null; }
  }
  async inspect({ reconnect }) {
    const results = await Promise.allSettled([
      this.findCodex(), this.findDesktopServer(), this.checkStorage(),
      this.adapter.subscriptionStatus({ refresh: true }),
      reconnect ? this.adapter.reconnectDesktop() : this.adapter.desktopStatus(),
      this.adapter.projects(), this.adapter.models({ refresh: true }),
    ]);
    const ok = i => results[i].status === 'fulfilled';
    const value = i => ok(i) ? results[i].value : null;
    const subscription = value(3);
    const checks = [
      check('platform', 'Windows 环境', this.platform === 'win32' ? 'pass' : 'fail', this.platform === 'win32' ? '当前 Windows 环境受支持。' : '此分发版需要 Windows。'),
      check('node', '运行环境', Number(this.nodeVersion.split('.')[0]) >= 22 ? 'pass' : 'fail', Number(this.nodeVersion.split('.')[0]) >= 22 ? 'Node.js 运行环境可用。' : '运行环境不兼容，请下载对应架构的 Windows 离线包并重新运行安装入口。'),
      check('codex', 'Codex 桌面', ok(0) ? 'pass' : 'fail', ok(0) ? '已找到本机 Codex。' : '未找到 Codex，请安装并启动 Codex 桌面。'),
      check('storage', '本机数据', ok(2) ? 'pass' : 'fail', ok(2) ? '任务可以保存在当前电脑。' : '无法读写任务目录，请检查当前用户权限后重新安装。'),
      check('account', 'ChatGPT 登录', subscription?.accountType === 'chatgpt' ? 'pass' : 'fail', subscription?.accountType === 'chatgpt' ? '已使用本机 ChatGPT 账号登录。' : '请在 Codex 中登录自己的 ChatGPT 账号；此版本使用订阅额度。'),
      check('provider', '模型服务商', subscription?.ready ? 'pass' : 'fail', subscription?.ready ? '当前设置支持 OpenAI / ChatGPT 订阅；每个目标对话还会单独核验。' : '当前模型服务商或登录状态不兼容。请在 Codex 设置中选择 OpenAI 并使用 ChatGPT 登录。'),
      check('desktop-tools', '桌面工具', ok(1) ? 'pass' : 'fail', ok(1) ? 'Codex 自带的桌面工具可用。' : '未找到桌面工具，请更新 Codex 并重新加载时序插件。'),
      check('connection', '发送连接', value(4)?.connected ? 'pass' : 'fail', value(4)?.connected ? '已连接 Codex 发送服务，自检未发送消息。' : '请保持 Codex 运行，在 Codex 中加载时序插件并打开管理器，然后重新检测。'),
      check('projects', '本机项目', ok(5) && value(5)?.length ? 'pass' : 'fail', ok(5) && value(5)?.length ? '已读取本机项目。请选择自己的项目和已有对话。' : '请先在 Codex 添加本机项目并创建对话，再重新检测。'),
      check('models', '可选模型', ok(6) && value(6)?.length ? 'pass' : 'fail', ok(6) && value(6)?.length ? '已读取可选 GPT 模型，实际发送仍会检查服务商和额度。' : '暂时未能读取 GPT 模型，请检查 Codex 登录和服务商设置。'),
    ];
    const failed = checks.filter(item => item.status === 'fail');
    return { ready: failed.length === 0, checkedAt: new Date().toISOString(), checks,
      summary: failed.length ? `还有 ${failed.length} 项需要处理，完成后可创建发送任务。` : '首次配置与连接自检通过，可以安排任务。' };
  }
}
