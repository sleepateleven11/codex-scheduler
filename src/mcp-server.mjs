import readline from 'node:readline';
import { ensureDaemon, requestApi, dashboardUrl } from './daemon-client.mjs';
import { registerDesktopConnection, registerDesktopConnectionFromHost, resolveDesktopSourceThreadId } from './desktop-client.mjs';
import { LAUNCHER_URI, launcherResource, readLauncherResource } from './launcher-resource.mjs';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
const string = description => ({ type: 'string', description });
const tools = [
  { name: 'scheduler_open', title: '时序任务管理器', description: '打开 Codex 定时任务中文面板，选择项目、已有对话、模型、时间并管理队列。将返回的 url 用 open_in_codex 的 browser 类型打开；不要在回复中复制连接令牌。', inputSchema: object({}), annotations: { readOnlyHint: true, destructiveHint: false }, _meta: { ui: { resourceUri: LAUNCHER_URI, visibility: ['model', 'app'] }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } },
  { name: 'scheduler_catalog', description: '读取已保存的本地项目、可选模型及订阅额度，不执行模型任务。', inputSchema: object({}), annotations: { readOnlyHint: true } },
  { name: 'scheduler_threads', description: '列出所选本地项目中的已有对话。', inputSchema: { ...object({ projectPath: string('来自项目列表的完整目录路径。') }), required: ['projectPath'] }, annotations: { readOnlyHint: true } },
  { name: 'scheduler_create', description: '按用户授权保存一次性消息或额度循环。scheduled 按时间发送一次；quota_available 每30秒检测，额度可用即发送一次；quota_cycle 在5小时窗口满额时先发一条，不满先等刷新，随后每轮刷新发送一次，持续直到暂停或删除。创建循环必须得到用户对目标、模型、消息及持续重复发送的明确授权；讨论或开发功能不表示启用真实循环。', inputSchema: { ...object({ projectPath: string('项目完整路径'), threadId: string('已有对话 ID'), model: string('模型列表中的模型标识'), effort: string('可选思考强度'), prompt: string('用户希望发送的完整原文'), sendMode: { type: 'string', enum: ['scheduled', 'quota_available', 'quota_cycle'], description: '默认 scheduled 按时间发送一次；quota_available 额度可用时发送一次；quota_cycle 每个5小时窗口刷新后循环发送，后二者无需runAt。' }, runAt: string('scheduled 模式必填，带时区偏移或 Z 的 ISO 8601 时间'), timeZone: string('IANA 时区，默认 Asia/Shanghai'), clientRequestId: string('可选的请求去重 ID；同一逻辑创建操作重试时保持不变') }), required: ['projectPath', 'threadId', 'model', 'prompt'], anyOf: [{ required: ['runAt'], properties: { sendMode: { enum: ['scheduled'] } } }, { required: ['sendMode'], properties: { sendMode: { enum: ['quota_available', 'quota_cycle'] } } }] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'scheduler_list', description: '查看定时消息、额度等待、执行结果和后台状态。', inputSchema: object({}), annotations: { readOnlyHint: true } },
  { name: 'scheduler_action', description: '暂停、恢复、取消、重试或删除一次性任务；targetType=quota_cycle 时针对额度循环，仅支持 pause/resume/delete。暂停或删除循环会停止未来发送，不撤回已发送消息；已派发工作不被中断。运行或派发中的一次性任务不可删除。delete 永久删除本地记录，仅在用户明确要求删除时使用。结果不明的任务需先核对原对话，不能自动重试。', inputSchema: { ...object({ id: string('队列任务或额度循环 ID'), targetType: { type: 'string', enum: ['task', 'quota_cycle'], description: '默认 task；操作额度循环必须指定 quota_cycle。' }, action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'retry', 'delete'] }, acknowledgeDuplicateRisk: { type: 'boolean' } }), required: ['id', 'action'] }, annotations: { readOnlyHint: false, destructiveHint: true } },
];
const toolNames = new Set(tools.map(t => t.name));
async function callTool(name, args = {}, meta = {}) {
  const sourceThreadId = resolveDesktopSourceThreadId(meta);
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH && sourceThreadId) await registerDesktopConnection({ sourceThreadId });
  if (name === 'scheduler_open') { const endpoint = await ensureDaemon(); return { url: dashboardUrl(endpoint), message: '请在 Codex 面板中打开此地址。' }; }
  if (name === 'scheduler_catalog') { const { projects, models, quota, timeZone } = await requestApi('/api/bootstrap'); return { projects, models, quota, timeZone }; }
  if (name === 'scheduler_threads') return requestApi(`/api/threads?projectPath=${encodeURIComponent(args.projectPath)}`);
  if (name === 'scheduler_create') {
    if (args.sendMode === 'quota_cycle') { const { sendMode, runAt, ...rule } = args; return requestApi('/api/quota-cycles', { method: 'POST', body: rule }); }
    return requestApi('/api/tasks', { method: 'POST', body: args });
  }
  if (name === 'scheduler_list') return requestApi('/api/tasks');
  if (name === 'scheduler_action') {
    if (args.targetType === 'quota_cycle') {
      if (!['pause', 'resume', 'delete'].includes(args.action)) throw new Error('额度循环仅支持暂停、恢复或删除。');
      const route = `/api/quota-cycles/${encodeURIComponent(args.id)}`;
      return args.action === 'delete' ? requestApi(route, { method: 'DELETE' }) : requestApi(route + '/action', { method: 'POST', body: { action: args.action } });
    }
    return args.action === 'delete' ? requestApi(`/api/tasks/${encodeURIComponent(args.id)}`, { method: 'DELETE' }) : requestApi(`/api/tasks/${encodeURIComponent(args.id)}/action`, { method: 'POST', body: args });
  }
  throw new Error('未知的插件工具。');
}
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id == null) return;
  try {
    let result;
    if (request.method === 'initialize') {
      // Only the genuine desktop-provided environment is used during discovery.
      // A missing context leaves registration untouched and does not break MCP.
      await registerDesktopConnectionFromHost();
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'codex-scheduler', version: '0.4.0' } };
    }
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'resources/list') result = { resources: [launcherResource()] };
    else if (request.method === 'resources/read') result = readLauncherResource(request.params?.uri);
    else if (request.method === 'tools/call') {
      if (!toolNames.has(request.params?.name)) throw new Error('未知的插件工具。');
      try { const data = await callTool(request.params.name, request.params.arguments, request.params._meta); result = { content: [{ type: 'text', text: JSON.stringify(data) }] }; }
      catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
    } else throw new Error('不支持的 MCP 请求。');
    output({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) { output({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } }); }
});
// Closing a conversation ends this MCP connection, not the persistent worker.
input.on('close', () => process.exit(0));
