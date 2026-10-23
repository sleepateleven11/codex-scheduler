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
  { name: 'scheduler_create', description: '按用户指定的时间或额度可用条件，向选定已有对话发送一次消息。sendMode=quota_available 时每30秒检测，额度可用即发送，当前已可用也会发送；仅在用户已明确授权消息、目标和触发条件时创建。', inputSchema: { ...object({ projectPath: string('项目完整路径'), threadId: string('已有对话 ID'), model: string('模型列表中的模型标识'), effort: string('可选思考强度'), prompt: string('用户希望发送的完整原文'), sendMode: { type: 'string', enum: ['scheduled', 'quota_available'], description: '默认 scheduled 按时间发送；quota_available 无需时间，额度可用时立即发送。' }, runAt: string('scheduled 模式必填，带时区偏移或 Z 的 ISO 8601 时间；quota_available 模式无需填写'), timeZone: string('IANA 时区，默认 Asia/Shanghai'), clientRequestId: string('可选的请求去重 ID；同一逻辑创建操作重试时保持不变') }), required: ['projectPath', 'threadId', 'model', 'prompt'], anyOf: [{ required: ['runAt'], properties: { sendMode: { enum: ['scheduled'] } } }, { required: ['sendMode'], properties: { sendMode: { const: 'quota_available' } } }] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'scheduler_list', description: '查看定时消息、额度等待、执行结果和后台状态。', inputSchema: object({}), annotations: { readOnlyHint: true } },
  { name: 'scheduler_action', description: '暂停、恢复、取消排队消息或重试失败任务。结果不明的任务需要先核对原对话，再显式确认可能重复的风险。已经运行的任务不能通过取消排队来中断。', inputSchema: { ...object({ id: string('队列任务 ID'), action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'retry'] }, acknowledgeDuplicateRisk: { type: 'boolean' } }), required: ['id', 'action'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
];
const toolNames = new Set(tools.map(t => t.name));
async function callTool(name, args = {}, meta = {}) {
  const sourceThreadId = resolveDesktopSourceThreadId(meta);
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH && sourceThreadId) await registerDesktopConnection({ sourceThreadId });
  if (name === 'scheduler_open') { const endpoint = await ensureDaemon(); return { url: dashboardUrl(endpoint), message: '请在 Codex 面板中打开此地址。' }; }
  if (name === 'scheduler_catalog') { const { projects, models, quota, timeZone } = await requestApi('/api/bootstrap'); return { projects, models, quota, timeZone }; }
  if (name === 'scheduler_threads') return requestApi(`/api/threads?projectPath=${encodeURIComponent(args.projectPath)}`);
  if (name === 'scheduler_create') return requestApi('/api/tasks', { method: 'POST', body: args });
  if (name === 'scheduler_list') return requestApi('/api/tasks');
  if (name === 'scheduler_action') return requestApi(`/api/tasks/${encodeURIComponent(args.id)}/action`, { method: 'POST', body: args });
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
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'codex-scheduler', version: '0.3.0' } };
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
