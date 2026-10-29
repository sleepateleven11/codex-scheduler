import fs from 'node:fs/promises';
import path from 'node:path';
import { CodexRpcClient, RpcError } from './rpc-client.mjs';
import { getPaths } from './paths.mjs';
import { DesktopClient, DesktopClientError, parseToolJSON } from './desktop-client.mjs';
import { isSubscriptionModel, threadProviderStatus, subscriptionPolicy, ProviderPolicyError } from './provider-policy.mjs';

const samePath = (a, b) => path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();
const asIso = value => Number.isFinite(Number(value)) && Number(value) > 0 ? new Date(Number(value) * 1000).toISOString() : null;
const errorText = error => typeof error === 'string' ? error : error?.message || JSON.stringify(error || {});
const isQuotaError = error => /usage.?limit|rate.?limit|quota|usageLimitExceeded/i.test(typeof error === 'string' ? error : JSON.stringify({ message: error?.message, data: error?.data, code: error?.code, codexErrorInfo: error?.codexErrorInfo, error }));
export function normalizeQuota(response, model = null) {
  const buckets = Object.entries(response?.rateLimitsByLimitId || {}).filter(([, bucket]) => bucket && typeof bucket === 'object')
    .map(([key, bucket]) => ({ ...bucket, limitId: bucket.limitId || key }));
  if (!buckets.length && response?.rateLimits) buckets.push(response.rateLimits);
  // normalModelSlug describes a quota alias; it is not a supported model-to-bucket entitlement mapping.
  const relevant = buckets;
  const windows = relevant.flatMap(b => ['primary', 'secondary'].flatMap(key => b[key] ? [{ ...b[key], limitId: b.limitId, kind: key }] : []));
  const exhausted = windows.filter(w => Number(w.usedPercent) >= 100);
  const denied = response?.ordinaryUsageAllowed !== true || exhausted.length > 0 || relevant.some(b => b.spendControlReached || b.rateLimitReachedType);
  const resetTimes = exhausted.map(w => Number(w.resetsAt)).filter(v => Number.isFinite(v) && v * 1000 > Date.now());
  return {
    allowed: relevant.length > 0 && !denied,
    resetAt: resetTimes.length ? asIso(Math.max(...resetTimes)) : null,
    reason: !relevant.length || response?.ordinaryUsageAllowed == null ? '暂时无法确认当前额度是否可用，任务会保留并稍后检查。' : denied ? '当前订阅额度不足，任务将等待额度恢复后执行。' : null,
    windows: windows.map(w => ({ usedPercent: w.usedPercent, windowDurationMins: w.windowDurationMins, resetsAt: asIso(w.resetsAt), kind: w.kind, limitId: w.limitId || null })),
  };
}

export async function readDesktopProjects(codexHome = getPaths().codexHome) {
  const state = JSON.parse(await fs.readFile(path.join(codexHome, '.codex-global-state.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
  const projects = [];
  const order = state['project-order'] || [];
  const local = state['local-projects'] || {};
  const entries = Array.isArray(local) ? local : Object.values(local);
  for (const p of entries) for (const root of p.rootPaths || []) if (typeof root === 'string' && root) projects.push({ id: p.id, path: root, label: p.name || path.basename(root), order: order.indexOf(p.id) });
  for (const root of state['electron-saved-workspace-roots'] || []) if (typeof root === 'string' && !projects.some(p => samePath(p.path, root))) projects.push({ path: root, label: path.basename(root), order: -1 });
  return { projects: projects.sort((a, b) => (a.order < 0 ? 10000 : a.order) - (b.order < 0 ? 10000 : b.order)).map(({ order, ...p }) => p), assignments: state['thread-project-assignments'] || {} };
}

/** Read lifecycle events; a fresh app-server can synthesize "interrupted" for a desktop turn that is still running. */
export async function readRolloutBusy(file) {
  if (!file) return null;
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    const size = Math.min(stat.size, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, stat.size - size);
    let lifecycle = null;
    for (const line of buffer.toString('utf8').split('\n')) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'event_msg') continue;
      if (event.payload?.type === 'task_started') lifecycle = 'running';
      if (['task_complete', 'task_completed', 'turn_aborted'].includes(event.payload?.type)) lifecycle = 'idle';
    }
    return lifecycle === 'running' ? true : lifecycle === 'idle' ? false : null;
  } catch { return null; }
  finally { await handle?.close(); }
}

export class CodexAdapter {
  constructor({ client, desktopClient, codexHome = getPaths().codexHome } = {}) {
    this.client = client || new CodexRpcClient({ cwd: getPaths().root });
    this.codexHome = codexHome;
    this.cachedModels = null;
    this.cachedQuota = null;
    this.quotaCheckedAt = 0;
    this.desktop = desktopClient === undefined ? (client ? null : new DesktopClient()) : desktopClient;
    this.desktopHealth = null;
    this.desktopHealthAt = 0;
    this.desktopStatusPending = null;
    this.desktopReconnectPending = null;
    this.subscriptionStatuses = new Map();
  }
  async close() { await Promise.all([this.client.close(), this.desktop?.close()]); }
  async desktopStatus({ refresh = false } = {}) {
    if (!this.desktop) return { connected: false, message: '请从 Codex 桌面打开定时任务管理器，连接发送服务。' };
    if (this.desktopReconnectPending) return this.desktopReconnectPending;
    if (!refresh && this.desktopHealth && Date.now() - this.desktopHealthAt < 5000) return this.desktopHealth;
    if (this.desktopStatusPending) return this.desktopStatusPending;
    const pending = this.#probeDesktop();
    this.desktopStatusPending = pending;
    try { return await pending; }
    finally { if (this.desktopStatusPending === pending) this.desktopStatusPending = null; }
  }
  async #probeDesktop() {
    try {
      const result = await this.desktop.callTool('list_projects', {});
      if (result.isError) throw new Error('无法连接 Codex 桌面，请打开 Codex 并重新加载时序插件，已有任务会保留。');
      this.desktopHealth = { connected: true };
    } catch (error) { this.desktopHealth = { connected: false, message: error.message, ...(error instanceof DesktopClientError ? { code: error.code } : {}) }; }
    this.desktopHealthAt = Date.now();
    return this.desktopHealth;
  }
  async reconnectDesktop() {
    if (!this.desktop) return { connected: false, message: '尚未登记 Codex 桌面连接。请打开 Codex 并重新加载时序插件，已有任务会保留。' };
    if (this.desktopReconnectPending) return this.desktopReconnectPending;
    const pending = (async () => {
      // Let an existing read-only health probe settle before replacing its
      // client. DesktopClient.close() also waits for any queued send to finish;
      // reconnect never cancels, repeats, or otherwise changes that submission.
      await this.desktopStatusPending;
      await this.desktop.close();
      this.desktopHealth = null;
      this.desktopHealthAt = 0;
      const status = await this.#probeDesktop();
      return status.connected ? { ...status, message: '已重新连接 Codex，等待中的任务会自动继续。' } : status;
    })();
    this.desktopReconnectPending = pending;
    try { return await pending; }
    finally { if (this.desktopReconnectPending === pending) this.desktopReconnectPending = null; }
  }
  async models({ refresh = false } = {}) {
    if (this.cachedModels && !refresh) return this.cachedModels;
    const response = await this.client.request('model/list', { includeHidden: false });
    this.cachedModels = (response.data || []).map(m => ({ id: m.model || m.id, displayName: m.displayName || m.model || m.id, supportedReasoningEfforts: m.supportedReasoningEfforts || [], defaultReasoningEffort: m.defaultReasoningEffort, isDefault: m.isDefault })).filter(m => isSubscriptionModel(m.id));
    return this.cachedModels;
  }
  async subscriptionStatus({ refresh = false, cwd } = {}) {
    const key = cwd || '';
    const cached = this.subscriptionStatuses.get(key);
    if (!refresh && cached && Date.now() - cached.checkedAt < 5000) return cached.status;
    let status;
    try {
      const [account, config] = await Promise.all([
        this.client.request('account/read', { refreshToken: false }),
        this.client.request('config/read', { includeLayers: false, ...(cwd ? { cwd } : {}) }),
      ]);
      status = subscriptionPolicy(account, config, { openaiBaseUrl: process.env.OPENAI_BASE_URL });
    } catch {
      status = { ready: false, accountType: 'unknown', provider: null, providerLabel: '服务商未确认', code: 'PROVIDER_CONFIGURATION_UNAVAILABLE', issue: '暂时无法读取 Codex 的订阅登录和服务商配置，任务尚未发送。请运行连接自检后重试。' };
    }
    this.subscriptionStatuses.set(key, { status, checkedAt: Date.now() });
    return status;
  }
  async validateProviderForThread(task, thread = null, { refresh = true, checkModel = true } = {}) {
    thread ||= (await this.client.request('thread/read', { threadId: task.threadId, includeTurns: false })).thread;
    const routing = threadProviderStatus(thread);
    if (!routing.providerCompatible) throw new ProviderPolicyError(routing.providerIssue, routing.modelProvider ? 'THREAD_PROVIDER_UNSUPPORTED' : 'THREAD_PROVIDER_UNKNOWN');
    const subscription = await this.subscriptionStatus({ refresh, cwd: thread.cwd });
    if (!subscription.ready) throw new ProviderPolicyError(subscription.issue, subscription.code);
    if (checkModel) {
      const models = await this.models({ refresh });
      if (!isSubscriptionModel(task.model) || !models.some(model => model.id === task.model)) throw new ProviderPolicyError('所选 GPT 模型不在当前 Codex 可用列表中，任务尚未发送。请刷新模型列表后重新选择。', 'SUBSCRIPTION_MODEL_UNAVAILABLE');
    }
    return routing;
  }
  async projects() {
    const { projects } = await readDesktopProjects(this.codexHome);
    return projects;
  }
  async #listAll(params) {
    const rows = []; let cursor;
    do {
      const result = await this.client.request('thread/list', { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
      rows.push(...(result.data || []));
      cursor = result.nextCursor;
      if (rows.length >= 2000) break;
    } while (cursor);
    return rows;
  }
  async threads(projectPath) {
    const { projects, assignments } = await readDesktopProjects(this.codexHome);
    const selected = projects.find(p => samePath(p.path, projectPath));
    if (!selected) throw new Error('请选择 Codex 中已保存的本地项目。');
    const rows = await this.#listAll({ cwd: selected.path, archived: false });
    const assigned = Object.entries(assignments).filter(([, a]) => a.projectKind === 'local' && a.projectId === selected.id).map(([id]) => id).filter(id => !rows.some(t => t.id === id));
    if (assigned.length) {
      const archived = new Set((await this.#listAll({ archived: true })).map(t => t.id));
      const extra = await Promise.all(assigned.filter(id => !archived.has(id)).map(async id => {
        try { return (await this.client.request('thread/read', { threadId: id, includeTurns: false })).thread; } catch { return null; }
      }));
      rows.push(...extra.filter(Boolean));
    }
    // Imported rollouts can make thread/list return the same chat more than
    // once. Preserve separate same-title chats and keep the newest row per ID.
    const distinct = new Map();
    const updated = value => typeof value === 'number' ? value : Date.parse(value) || 0;
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id) continue;
      const previous = distinct.get(row.id);
      if (!previous || updated(row.updatedAt) > updated(previous.updatedAt)) distinct.set(row.id, row);
    }
    return [...distinct.values()].filter(t => t.canAcceptDirectInput !== false).map(t => ({
      id: t.id, title: t.name || (typeof t.preview === 'string' ? t.preview.slice(0, 80) : '') || '未命名对话',
      cwd: t.cwd, busy: t.status?.type === 'active', archived: false,
      createdAt: t.createdAt, updatedAt: t.updatedAt,
      preview: typeof t.preview === 'string' ? t.preview.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
      ...threadProviderStatus(t),
    }));
  }
  async validateTask(task) {
    const { projects, assignments } = await readDesktopProjects(this.codexHome);
    const selected = projects.find(p => samePath(p.path, task.projectPath));
    if (!selected) throw new Error('项目已移除，请重新选择。');
    const stat = await fs.stat(selected.path).catch(() => null);
    if (!stat?.isDirectory()) throw new Error('项目目录暂时不可用。');
    const models = await this.models();
    const model = models.find(m => m.id === task.model);
    if (!model) throw new Error('该模型当前不可选，请刷新模型列表。');
    if (task.effort && !model.supportedReasoningEfforts.some(e => e.reasoningEffort === task.effort)) throw new Error('该模型不支持所选思考强度。');
    const thread = await this.client.request('thread/read', { threadId: task.threadId, includeTurns: false });
    const assignment = assignments[task.threadId];
    const belongs = samePath(thread.thread.cwd, selected.path) || assignment?.projectKind === 'local' && assignment.projectId === selected.id;
    if (!belongs) throw new Error('所选对话不属于这个项目，请重新选择。');
    const executionPath = thread.thread.cwd;
    if (!(await fs.stat(executionPath).catch(() => null))?.isDirectory()) throw new Error('对话原来的工作目录暂时不可用。');
    const archived = await this.#listAll({ cwd: executionPath, archived: true });
    if (archived.some(t => t.id === task.threadId)) throw new Error('该对话已归档，请先在 Codex 中取消归档。');
    await this.validateProviderForThread(task, thread.thread, { refresh: true, checkModel: false });
    const connection = this.desktop ? await this.desktop.connectionInfo() : null;
    return { ...task, ...(connection ? { sourceThreadId: connection.sourceThreadId } : {}), projectPath: selected.path, executionPath, projectLabel: selected.label, threadTitle: thread.thread.name || task.threadTitle || '未命名对话' };
  }
  async getQuota(model = null, { refresh = false } = {}) {
    try {
      if (refresh || !this.cachedQuota || Date.now() - this.quotaCheckedAt > 5000) {
        const account = await this.client.request('account/read', { refreshToken: false });
        if (account.account?.type !== 'chatgpt') return { allowed: false, resetAt: null, reason: '请在 Codex 中使用 ChatGPT 订阅账号登录。队列不会自动改用按量付费 API。', windows: [] };
        this.cachedQuota = await this.client.request('account/rateLimits/read');
        this.quotaCheckedAt = Date.now();
      }
      return normalizeQuota(this.cachedQuota, model);
    } catch { return { allowed: false, resetAt: null, reason: '暂时无法连接 Codex 或读取额度，任务会保留并稍后检查。', windows: [] }; }
  }
  async #turns(threadId, limit = 10, cursor) { return this.client.request('thread/turns/list', { threadId, limit, sortDirection: 'desc', ...(cursor ? { cursor } : {}) }); }
  async getThreadState(task, { validateProvider = true } = {}) {
    const response = await this.client.request('thread/read', { threadId: task.threadId, includeTurns: false });
    const thread = response.thread;
    if (validateProvider) await this.validateProviderForThread(task, thread, { refresh: true });
    const archived = (await this.#listAll({ cwd: thread.cwd, archived: true })).some(t => t.id === task.threadId);
    const latest = (await this.#turns(task.threadId, 1)).data?.[0];
    const rolloutBusy = await readRolloutBusy(thread.path);
    return { cwd: thread.cwd, archived, busy: thread.status?.type === 'active' || latest?.status === 'inProgress' || rolloutBusy === true || latest?.status === 'interrupted' && rolloutBusy == null, latestTurnId: latest?.id, ...threadProviderStatus(thread) };
  }
  #result(turn, { sideEffects = false, approval = false } = {}) {
    const fullOutput = (turn.items || []).filter(i => i.type === 'agentMessage').map(i => i.text || '').join('\n');
    const output = fullOutput.slice(0, 100000);
    const error = errorText(turn.error);
    if (approval) return { status: sideEffects ? 'needs_review' : 'failed', turnId: turn.id, output, error: '该任务需要人工批准。请打开原对话处理后，再决定是否重试。' };
    const quotaError = isQuotaError(turn.error);
    if (turn.status !== 'completed' && quotaError && !sideEffects && !fullOutput.trim()) return { status: 'waiting_quota', error: '请求遇到额度限制，未产生输出或工具操作；额度恢复后重试。' };
    if (turn.status !== 'completed' && quotaError) return { status: 'needs_review', turnId: turn.id, output, error: '额度中断前已产生部分工作。请先核对原对话，系统不会自动重发原消息。' };
    return { status: turn.status === 'completed' ? 'completed' : turn.status === 'inProgress' ? 'running' : turn.status === 'interrupted' ? 'interrupted' : 'failed', turnId: turn.id, output, error: turn.error ? error : turn.status === 'interrupted' ? '执行已中断，请核对原对话后重试。' : null };
  }
  async execute(task, { onTurnStarted, onSubmitted }) {
    const state = await this.getThreadState(task);
    if (state.archived) return { status: 'failed', error: '对话已归档。' };
    if (state.busy) return { status: 'waiting_thread', error: '对话正在执行，稍后发送。' };
    // Re-read authoritative routing even when the task was validated days ago.
    await this.validateProviderForThread(task);
    if (this.desktop) return this.#executeDesktop(task, { onTurnStarted, onSubmitted });
    let resumed;
    try {
      resumed = await this.client.request('thread/resume', { threadId: task.threadId, excludeTurns: true, model: task.model, modelProvider: 'openai' });
    } catch (error) {
      // This explicit resume rejection precedes turn/start, so this message was
      // not submitted. Do not reuse this classification after turn/start.
      const writerMessage = `thread ${task.threadId} already has an active writer`;
      if (error instanceof RpcError && error.code === -32600 && error.message.trim().replace(/\.$/, '') === writerMessage) {
        return { status: 'waiting_thread', error: '该对话正由 Codex 桌面占用写入连接，本条消息尚未发送，后台将稍后重试。' };
      }
      throw error;
    }
    if (resumed.model !== task.model) return { status: 'failed', error: 'Codex 未确认所选模型，任务未发送。' };
    if (resumed.modelProvider !== 'openai' || resumed.thread?.modelProvider !== 'openai') return { status: 'failed', error: 'Codex 未确认 OpenAI 订阅服务商，任务未发送。' };
    if (!samePath(resumed.thread.cwd, task.executionPath || task.projectPath)) return { status: 'failed', error: '对话工作目录已改变，任务未发送。' };
    let turnId; let approval = false; let sideEffects = false;
    const items = new Map(); let finish; const buffered = []; const bufferedRequests = [];
    const completed = new Promise(resolve => { finish = resolve; });
    const processNotification = message => {
      const p = message.params;
      const eventTurn = p?.turnId || p?.turn?.id;
      if (!turnId || eventTurn !== turnId) return;
      if (message.method === 'item/started' && p.item?.type && !['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'].includes(p.item.type)) sideEffects = true;
      if (message.method === 'item/completed' && p.item) items.set(p.item.id, p.item);
      if (message.method === 'turn/completed') finish({ turn: p.turn });
    };
    const onNotification = message => {
      if (message.params?.threadId !== task.threadId) return;
      if (!turnId) buffered.push(message); else processNotification(message);
    };
    const flagRequest = request => {
      const owner = request.params?.threadId || request.params?.thread_id;
      if (owner !== task.threadId) return;
      const ownerTurn = request.params?.turnId || request.params?.turn_id;
      if (ownerTurn && ownerTurn !== turnId) return;
      approval = true;
      if (turnId) void this.client.request('turn/interrupt', { threadId: task.threadId, turnId }).catch(() => {});
      return true;
    };
    const onRequest = request => {
      const owner = request.params?.threadId || request.params?.thread_id;
      if (owner !== task.threadId) return;
      if (!turnId) { bufferedRequests.push(request); return; }
      const ownerTurn = request.params?.turnId || request.params?.turn_id;
      if (ownerTurn && ownerTurn !== turnId) return;
      this.client.respondError(request.id, '后台任务需要人工处理。请在 Codex 中打开原对话继续。');
      flagRequest(request);
    };
    const onDisconnect = error => finish({ error });
    this.client.on('notification', onNotification);
    this.client.on('serverRequest', onRequest);
    this.client.on('disconnected', onDisconnect);
    try {
      let started;
      try {
        started = await this.client.request('turn/start', { threadId: task.threadId, model: task.model, ...(task.effort ? { effort: task.effort } : {}), input: [{ type: 'text', text: task.prompt }], clientUserMessageId: task.id, turnTrigger: 'scheduled' }, 45000);
      } catch (error) {
        if (isQuotaError(error) && error.code !== 'RPC_TIMEOUT') return { status: 'waiting_quota', error: '请求因额度限制被拒绝，等待恢复后执行。', retryAt: (await this.getQuota(task.model, { refresh: true })).resetAt };
        throw error;
      }
      turnId = started.turn.id;
      await onTurnStarted(turnId);
      for (const event of buffered) processNotification(event);
      for (const request of bufferedRequests) if (flagRequest(request)) this.client.respondError(request.id, '后台任务需要人工处理。请在 Codex 中打开原对话继续。');
      if (approval) void this.client.request('turn/interrupt', { threadId: task.threadId, turnId }).catch(() => {});
      const ended = started.turn.status === 'inProgress' ? await completed : { turn: started.turn };
      if (ended.error) throw ended.error;
      const turn = { ...ended.turn, items: [...items.values(), ...(ended.turn.items || [])].filter((v, i, all) => all.findIndex(x => x.id === v.id) === i) };
      sideEffects ||= turn.items.some(i => !['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'].includes(i.type));
      const result = this.#result(turn, { sideEffects, approval });
      if (result.status === 'waiting_quota') result.retryAt = (await this.getQuota(task.model, { refresh: true })).resetAt;
      return result;
    } finally {
      this.client.off('notification', onNotification); this.client.off('serverRequest', onRequest); this.client.off('disconnected', onDisconnect);
    }
  }
  async #desktopTurns(threadId) {
    const response = await this.client.request('thread/turns/list', { threadId, limit: 100, sortDirection: 'desc', itemsView: 'full' });
    return response.data || [];
  }
  #isDesktopInput(item, task, receipt) {
    if (item.type === 'functionCallOutput' && item.name === 'send_message_to_thread' && item.namespace === 'codex_app') {
      const expected = `<codex_delegation>\n  <source_thread_id>${receipt.sourceThreadId}</source_thread_id>\n  <input>${task.prompt}</input>\n</codex_delegation>`;
      return item.output === expected;
    }
    return false;
  }
  async #executeDesktop(task, { onTurnStarted, onSubmitted }) {
    // A read-only host probe before submission distinguishes an unavailable
    // desktop from an unknown result after the send tool has been written.
    const status = await this.desktopStatus({ refresh: true });
    if (!status.connected) return { status: 'waiting_thread', error: status.message };
    const connection = await this.desktop.connectionInfo();
    const sourceThreadId = task.sourceThreadId || connection.sourceThreadId;
    const before = await this.#desktopTurns(task.threadId);
    const receipt = {
      transport: 'codex-desktop', sourceThreadId,
      acknowledgedAt: new Date().toISOString(),
      knownTurnIds: before.map(turn => turn.id),
      knownItemIds: before.flatMap(turn => (turn.items || []).filter(item => this.#isDesktopInput(item, task, { sourceThreadId })).map(item => item.id)),
      native: {},
    };
    let response;
    // Native desktop send supports a model override but not a provider
    // override. Check again immediately before that irreversible submission.
    await this.validateProviderForThread(task);
    try {
      response = await this.desktop.callTool('send_message_to_thread', {
        threadId: task.threadId, prompt: task.prompt, model: task.model,
        ...(task.effort ? { thinking: task.effort } : {}),
      }, { sourceThreadId });
    } catch (error) {
      if (error instanceof DesktopClientError && error.stage === 'preCall' && !error.uncertain) return { status: 'waiting_thread', error: error.message };
      throw error;
    }
    if (response.isError) {
      // A tool-level error is not evidence that the desktop did nothing.
      const text = (response.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
      throw new Error(text || 'Codex 桌面未能确认发送结果。');
    }
    const native = parseToolJSON(response);
    if (native.threadId !== task.threadId) throw new Error('Codex 桌面的发送回执与目标对话不一致。');
    receipt.acknowledgedAt = new Date().toISOString();
    receipt.native = { threadId: native.threadId };
    if (typeof onSubmitted !== 'function') throw new Error('发送回执无法保存，停止自动重试。');
    await onSubmitted(receipt);
    const result = await this.#reconcileDesktop({ ...task, submissionReceipt: receipt });
    if (result.turnId && onTurnStarted) await onTurnStarted(result.turnId);
    return result;
  }
  async #reconcileDesktop(task) {
    const receipt = task.submissionReceipt;
    let turns;
    try { turns = await this.#desktopTurns(task.threadId); }
    catch { return { status: 'running', submissionReceipt: receipt, error: '消息已提交到 Codex，暂时无法读取执行状态，后台会继续核对。' }; }
    const knownTurns = new Set(receipt.knownTurnIds || []);
    const knownItems = new Set(receipt.knownItemIds || []);
    const candidates = turns.filter(turn => !task.turnId || turn.id === task.turnId).flatMap(turn =>
      (turn.items || []).filter(item =>
        (!knownTurns.has(turn.id) || !knownItems.has(item.id)) &&
        (!receipt.native?.inputItemId || item.id === receipt.native.inputItemId) &&
        this.#isDesktopInput(item, task, receipt)).map(item => ({ turn, item })));
    if (candidates.length > 1) return { status: 'needs_review', submissionReceipt: receipt, error: '已提交到桌面，但发现多条相同内容的新输入，暂时无法唯一关联执行结果。系统不会重发。' };
    const match = candidates[0];
    const turn = match?.turn;
    if (!turn) {
      if (Date.now() - Date.parse(receipt.acknowledgedAt) > 120000) return { status: 'needs_review', submissionReceipt: receipt, error: 'Codex 已接收消息，但两分钟内未找到可唯一关联的执行记录。系统不会重发，请查看目标对话。' };
      return { status: 'running', submissionReceipt: receipt };
    }
    const enriched = { ...receipt, native: { ...receipt.native, turnId: turn.id, inputItemId: match.item.id } };
    let state;
    try { state = await this.getThreadState(task, { validateProvider: false }); }
    catch { return { status: 'running', turnId: turn.id, submissionReceipt: enriched, error: '消息已提交，正在重新读取对话执行状态。' }; }
    if (turn.status === 'inProgress' || turn.status === 'interrupted' && state.busy) return { status: 'running', turnId: turn.id, submissionReceipt: enriched };
    const sideEffects = (turn.items || []).some(item => !this.#isDesktopInput(item, task, receipt) && !['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'].includes(item.type));
    const result = this.#result(turn, { sideEffects });
    return { ...result, ...(result.status === 'waiting_quota' ? { confirmedNoWork: true } : {}), turnId: turn.id, submissionReceipt: enriched };
  }
  async reconcile(task) {
    if (task.submissionReceipt?.transport === 'codex-desktop') return this.#reconcileDesktop(task);
    let cursor; let turn;
    for (let page = 0; page < 20 && !turn; page++) {
      const response = await this.#turns(task.threadId, 50, cursor);
      turn = response.data.find(t => task.turnId ? t.id === task.turnId : (t.items || []).some(i => i.type === 'userMessage' && i.id === task.id) && (!t.startedAt || t.startedAt * 1000 >= Date.parse(task.dispatchStartedAt || task.createdAt) - 5000));
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    if (!turn) return { status: 'needs_review', error: '无法确认上次请求是否送达。请核对原对话，系统不会自动重发。' };
    const state = await this.getThreadState(task, { validateProvider: false });
    if (state.busy) return { status: 'running', turnId: turn.id };
    if (turn.status === 'inProgress') return { status: 'needs_review', turnId: turn.id, error: '执行状态未能确认，请打开原对话核对。' };
    const sideEffects = (turn.items || []).some(i => !['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction'].includes(i.type));
    return this.#result(turn, { sideEffects });
  }
}
