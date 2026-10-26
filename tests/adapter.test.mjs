import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexAdapter, normalizeQuota, readDesktopProjects, readRolloutBusy } from '../src/codex-adapter.mjs';
import { RpcError } from '../src/rpc-client.mjs';

const model = 'gpt-selected';
const projectPath = 'C:\\Projects\\Example';
const task = (fields = {}) => ({ id: 'client-message-123', threadId: 'thread-123', projectPath, model, effort: 'medium', prompt: '  Keep the indentation.\n', createdAt: '2026-10-20T04:00:00.000Z', dispatchStartedAt: '2026-10-20T04:00:00.000Z', ...fields });
const future = offset => Math.floor(Date.now() / 1000) + offset;
const window = (usedPercent = 0, offset = 3600) => ({ usedPercent, resetsAt: future(offset), windowDurationMins: 300 });
const quota = buckets => ({ ordinaryUsageAllowed: true, rateLimitsByLimitId: buckets, rateLimits: { primary: window(0) } });

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-adapter-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

class FakeRpc extends EventEmitter {
  constructor(handler = async () => undefined) { super(); this.handler = handler; this.calls = []; this.errors = []; }
  async request(method, params, timeout) {
    this.calls.push({ method, params, timeout });
    const result = await this.handler(method, params, this);
    if (result !== undefined) return result;
    if (method === 'thread/resume') return { model, modelProvider: 'openai', thread: { modelProvider: 'openai', id: 'thread-123', cwd: projectPath } };
    if (method === 'thread/read') return { thread: { id: 'thread-123', cwd: projectPath, modelProvider: 'openai' } };
    if (method === 'model/list') return { data: [{ model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
    if (method === 'config/read') return { config: { model_provider: null } };
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'account/rateLimits/read') return quota({ codex: { primary: window(0) } });
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected fake request: ${method}`);
  }
  respondError(id, message) { this.errors.push({ id, message }); }
  async close() {}
}

function executionAdapter(handler) {
  const client = new FakeRpc(handler);
  const adapter = new CodexAdapter({ client });
  adapter.getThreadState = async () => ({ busy: false, archived: false, cwd: projectPath });
  return { adapter, client };
}

test('quota conservatively respects an exhausted alias bucket without assuming a model binding', () => {
  const result = normalizeQuota(quota({
    shared: { limitId: 'codex', normalModelSlug: null, primary: window(20) },
    selected: { limitId: 'selected', normalModelSlug: model, primary: window(10) },
    other: { limitId: 'other', normalModelSlug: 'gpt-other', primary: window(100) },
  }), model);
  assert.equal(result.allowed, false);
  assert.equal(result.windows.length, 3);
});

test('quota waits for the latest exhausted applicable window, not an unexhausted later window', () => {
  const a = window(100, 3600);
  const b = window(100, 7200);
  const laterUnused = window(5, 86400);
  const result = normalizeQuota(quota({ codex: { primary: a, secondary: b }, selected: { normalModelSlug: model, primary: laterUnused } }), model);
  assert.equal(result.allowed, false);
  assert.equal(result.resetAt, new Date(b.resetsAt * 1000).toISOString());
});

test('quota preserves exact window usage and bucket identity for cycle scheduling', () => {
  const response = quota({ codex: { primary: window(0.4), secondary: { ...window(12), windowDurationMins: 10080 } } });
  const result = normalizeQuota(response, model);
  assert.equal(result.allowed, true);
  assert.equal(result.resetAt, null, 'An available quota must not reuse an exhausted-window deadline.');
  assert.equal(result.windows[0].usedPercent, 0.4, 'Do not round 99.6% remaining into a fully unused window.');
  assert.equal(result.windows[0].limitId, 'codex', 'The keyed bucket identity survives even when omitted inside the value.');
  assert.equal(result.windows[0].windowDurationMins, 300);
  assert.equal(result.windows[1].windowDurationMins, 10080);
  assert.equal(result.windows[1].kind, 'secondary');
  assert.equal(result.windows[0].resetsAt, new Date(response.rateLimitsByLimitId.codex.primary.resetsAt * 1000).toISOString());
});

test('legacy single-bucket quota retains its identity and unknown reset stays unknown', () => {
  const result = normalizeQuota({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null } } });
  assert.equal(result.windows[0].limitId, 'codex');
  assert.equal(result.windows[0].resetsAt, null);
  assert.equal(result.windows[0].usedPercent, 0);
});

test('unknown ordinaryUsageAllowed cannot infer recovery from percentages', () => {
  for (const ordinaryUsageAllowed of [null, undefined]) {
    const result = normalizeQuota({ ...quota({ codex: { primary: window(0) } }), ordinaryUsageAllowed }, model);
    assert.equal(result.allowed, false);
  }
});

test('missing quota data remains unavailable rather than implying zero usage', () => {
  assert.equal(normalizeQuota({}, model).allowed, false);
  assert.equal(normalizeQuota({ rateLimits: {} }, model).allowed, false);
  assert.equal(normalizeQuota(quota({ unrelated: { normalModelSlug: 'gpt-other', primary: window(0) } }), model).allowed, true);
});

test('unknown permission without exhausted windows does not delay rechecks until an unrelated weekly reset', () => {
  const response = { ...quota({ codex: { primary: window(10, 3600), secondary: window(20, 604800) } }), ordinaryUsageAllowed: null };
  const result = normalizeQuota(response, model);
  assert.equal(result.allowed, false);
  assert.equal(result.resetAt, null);
});

test('backend denial and spend-control denial override available percentages', () => {
  const allowedWindows = quota({ codex: { primary: window(0) } });
  assert.equal(normalizeQuota({ ...allowedWindows, ordinaryUsageAllowed: false }, model).allowed, false);
  assert.equal(normalizeQuota(quota({ codex: { primary: window(0), spendControlReached: true } }), model).allowed, false);
  assert.equal(normalizeQuota(quota({ codex: { primary: window(0), rateLimitReachedType: 'workspace_member_usage_limit_reached' } }), model).allowed, false);
});

test('quota with a past reset remains denied until the backend permits usage', () => {
  const result = normalizeQuota(quota({ codex: { primary: window(100, -60) } }), model);
  assert.equal(result.allowed, false);
  assert.equal(result.resetAt, null);
});

test('project discovery preserves saved project labels/order and deduplicates saved roots', async t => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, '.codex-global-state.json'), JSON.stringify({
    'project-order': ['b', 'a'],
    'local-projects': { a: { id: 'a', name: 'A', rootPaths: ['C:\\A'] }, b: { id: 'b', name: 'B', rootPaths: ['C:\\B', 'C:\\B2'] } },
    'electron-saved-workspace-roots': ['c:\\a\\', 'C:\\Extra'],
    'thread-project-assignments': { thread: 'a' },
  }));
  const result = await readDesktopProjects(dir);
  assert.deepEqual(result.projects.map(p => p.path), ['C:\\B', 'C:\\B2', 'C:\\A', 'C:\\Extra']);
  assert.deepEqual(result.projects.map(p => p.label), ['B', 'B', 'A', 'Extra']);
  assert.deepEqual(result.assignments, { thread: 'a' });
});

test('project conversations merge explicitly assigned local worktree chats and omit archived assignments', async t => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'project');
  const worktree = path.join(dir, 'worktree');
  await Promise.all([mkdir(root), mkdir(worktree)]);
  await writeFile(path.join(dir, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { selected: { id: 'selected', name: 'Selected', rootPaths: [root] } },
    'thread-project-assignments': {
      'direct-thread': { projectKind: 'local', projectId: 'selected' },
      'worktree-thread': { projectKind: 'local', projectId: 'selected' },
      'archived-thread': { projectKind: 'local', projectId: 'selected' },
      'cloud-thread': { projectKind: 'cloud', projectId: 'selected' },
      'other-project-thread': { projectKind: 'local', projectId: 'other' },
    },
  }));
  const client = new FakeRpc(async (method, params) => {
    if (method === 'thread/list') return params.archived
      ? { data: [{ id: 'archived-thread', cwd: worktree }] }
      : { data: [{ id: 'direct-thread', name: 'Direct', cwd: root }] };
    if (method === 'thread/read') return { thread: { modelProvider: 'openai', id: params.threadId, name: 'Assigned worktree', cwd: worktree, status: { type: 'idle' } } };
  });
  const adapter = new CodexAdapter({ client, codexHome: dir });
  const threads = await adapter.threads(root);
  assert.deepEqual(threads.map(thread => thread.id), ['direct-thread', 'worktree-thread']);
  assert.equal(threads[1].cwd, worktree);
  assert.equal(threads[1].archived, false);
  assert.deepEqual(client.calls.filter(call => call.method === 'thread/read').map(call => call.params.threadId), ['worktree-thread']);
});

test('same-title chats retain distinct IDs and return identifying timestamps and bounded preview', async t => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'project');
  await writeFile(path.join(dir, '.codex-global-state.json'), JSON.stringify({
    'local-projects': [{ id: 'selected', name: 'Selected', rootPaths: [root] }],
  }));
  const client = new FakeRpc(async method => method === 'thread/list' ? { data: [
    { id: 'chat-one', name: '大图', cwd: root, createdAt: 1792400000, updatedAt: 1792410000, preview: '  One\n  conversation  ' },
    { id: 'chat-two', name: '大图', cwd: root, createdAt: 1792420000, updatedAt: 1792430000, preview: '二'.repeat(500) },
    { id: 'chat-no-preview', name: 'Other', cwd: root, preview: {} },
    { id: 'chat-one', name: '大图', cwd: root, createdAt: 1792400000, updatedAt: 1792405000, preview: 'Older imported duplicate' },
    { id: 'chat-one', name: '大图', cwd: root, createdAt: 1792400000, updatedAt: 1792415000, preview: 'Latest imported duplicate' },
  ] } : undefined);
  const adapter = new CodexAdapter({ client, codexHome: dir });
  const threads = await adapter.threads(root);
  assert.deepEqual(threads.slice(0, 2).map(thread => thread.title), ['大图', '大图']);
  assert.deepEqual(threads.slice(0, 2).map(thread => thread.id), ['chat-one', 'chat-two']);
  assert.equal(threads[0].createdAt, 1792400000);
  assert.equal(threads[1].updatedAt, 1792430000);
  assert.equal(threads.length, 3);
  assert.equal(threads[0].updatedAt, 1792415000);
  assert.equal(threads[0].preview, 'Latest imported duplicate');
  assert.equal(threads[1].preview.length, 300);
  assert.equal(threads[2].preview, '');
});

test('task validation supplies the assigned worktree cwd authoritatively and ignores caller executionPath', async t => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'project');
  const worktree = path.join(dir, 'worktree');
  await Promise.all([mkdir(root), mkdir(worktree)]);
  await writeFile(path.join(dir, '.codex-global-state.json'), JSON.stringify({
    'local-projects': [{ id: 'selected', name: 'Selected project', rootPaths: [root] }],
    'thread-project-assignments': { 'thread-123': { projectKind: 'local', projectId: 'selected' } },
  }));
  const client = new FakeRpc(async (method, params) => {
    if (method === 'model/list') return { data: [{ model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
    if (method === 'thread/read') return { thread: { modelProvider: 'openai', id: 'thread-123', name: 'Worktree conversation', cwd: worktree } };
    if (method === 'thread/list') { assert.equal(params.cwd, worktree); assert.equal(params.archived, true); return { data: [] }; }
  });
  const adapter = new CodexAdapter({ client, codexHome: dir });
  const validated = await adapter.validateTask(task({ projectPath: root, executionPath: path.join(dir, 'caller-chosen-path') }));
  assert.equal(validated.projectPath, root);
  assert.equal(validated.executionPath, worktree);
  assert.equal(validated.projectLabel, 'Selected project');
  assert.equal(validated.threadTitle, 'Worktree conversation');
  assert.equal(client.calls.some(call => call.method === 'turn/start'), false);
});

test('caller executionPath cannot authorize an arbitrary unassigned conversation cwd', async t => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'project');
  const unassigned = path.join(dir, 'unassigned');
  await Promise.all([mkdir(root), mkdir(unassigned)]);
  await writeFile(path.join(dir, '.codex-global-state.json'), JSON.stringify({
    'local-projects': [{ id: 'selected', name: 'Selected project', rootPaths: [root] }],
    'thread-project-assignments': {},
  }));
  const client = new FakeRpc(async method => {
    if (method === 'model/list') return { data: [{ model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
    if (method === 'thread/read') return { thread: { modelProvider: 'openai', id: 'thread-123', cwd: unassigned } };
  });
  const adapter = new CodexAdapter({ client, codexHome: dir });
  await assert.rejects(adapter.validateTask(task({ projectPath: root, executionPath: unassigned })), /不属于这个项目/);
  assert.equal(client.calls.some(call => call.method === 'turn/start'), false);
});

test('an explicitly assigned worktree conversation still cannot target an archived chat', async t => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'project');
  const worktree = path.join(dir, 'worktree');
  await Promise.all([mkdir(root), mkdir(worktree)]);
  await writeFile(path.join(dir, '.codex-global-state.json'), JSON.stringify({
    'local-projects': [{ id: 'selected', name: 'Selected project', rootPaths: [root] }],
    'thread-project-assignments': { 'thread-123': { projectKind: 'local', projectId: 'selected' } },
  }));
  const client = new FakeRpc(async method => {
    if (method === 'model/list') return { data: [{ model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
    if (method === 'thread/read') return { thread: { modelProvider: 'openai', id: 'thread-123', cwd: worktree } };
    if (method === 'thread/list') return { data: [{ id: 'thread-123', cwd: worktree }] };
  });
  const adapter = new CodexAdapter({ client, codexHome: dir });
  await assert.rejects(adapter.validateTask(task({ projectPath: root })), /已归档/);
});

test('rollout lifecycle overrides stale app-server status and tolerates partial lines', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'rollout.jsonl');
  const event = type => JSON.stringify({ type: 'event_msg', payload: { type } });
  await writeFile(file, [event('task_complete'), 'invalid', event('task_started'), '{partial'].join('\n'));
  assert.equal(await readRolloutBusy(file), true);
  await writeFile(file, [event('task_started'), event('turn_aborted')].join('\n'));
  assert.equal(await readRolloutBusy(file), false);
  await writeFile(file, JSON.stringify({ type: 'response_item', payload: { type: 'message' } }));
  assert.equal(await readRolloutBusy(file), null);
  assert.equal(await readRolloutBusy(path.join(dir, 'missing')), null);
});

test('unknown rollout lifecycle does not treat fresh-server interrupted status as safely idle', async t => {
  const client = new FakeRpc(async method => {
    if (method === 'thread/read') return { thread: { modelProvider: 'openai', id: 'thread-123', cwd: projectPath, path: null, status: { type: 'idle' } } };
    if (method === 'thread/list') return { data: [] };
    if (method === 'thread/turns/list') return { data: [{ id: 'desktop-turn', status: 'interrupted' }] };
  });
  const adapter = new CodexAdapter({ client });
  const state = await adapter.getThreadState(task());
  assert.equal(state.busy, true);
});

test('non-subscription account never reaches a paid model send through quota checks', async () => {
  const client = new FakeRpc(async method => method === 'account/read' ? { account: { type: 'apiKey' } } : undefined);
  const adapter = new CodexAdapter({ client });
  const result = await adapter.getQuota(model);
  assert.equal(result.allowed, false);
  assert.equal(client.calls.some(c => c.method === 'account/rateLimits/read'), false);
});

test('transient quota RPC failure queues conservatively', async () => {
  const client = new FakeRpc(async () => { throw new Error('Connection unavailable'); });
  const adapter = new CodexAdapter({ client });
  const result = await adapter.getQuota(model);
  assert.equal(result.allowed, false);
  assert.equal(result.resetAt, null);
});

test('execute preserves the exact chosen model, prompt, effort and crash-recovery message ID', async () => {
  const { adapter, client } = executionAdapter(async method => method === 'turn/start' ? { turn: { id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Done.' }] } } : undefined);
  const started = [];
  const current = task();
  const result = await adapter.execute(current, { onTurnStarted: async id => { started.push(id); } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(started, ['turn-1']);
  const sent = client.calls.find(c => c.method === 'turn/start').params;
  assert.equal(sent.model, current.model);
  assert.equal(sent.effort, current.effort);
  assert.equal(sent.input[0].text, current.prompt);
  assert.equal(sent.clientUserMessageId, current.id);
});

test('execute refuses a resumed model mismatch before submitting', async () => {
  const { adapter, client } = executionAdapter(async method => method === 'thread/resume' ? { model: 'different-model', thread: { modelProvider: 'openai', cwd: projectPath } } : undefined);
  const result = await adapter.execute(task(), { onTurnStarted: async () => {} });
  assert.equal(result.status, 'failed');
  assert.equal(client.calls.some(c => c.method === 'turn/start'), false);
});

test('an explicit active-writer resume rejection waits without submitting a turn', async () => {
  const rejection = new RpcError({ code: -32600, message: `thread ${task().threadId} already has an active writer` });
  const { adapter, client } = executionAdapter(async method => {
    if (method === 'thread/resume') throw rejection;
  });
  const started = [];
  const result = await adapter.execute(task(), { onTurnStarted: async id => { started.push(id); } });
  assert.equal(result.status, 'waiting_thread');
  assert.match(result.error, /尚未发送/);
  assert.deepEqual(started, []);
  assert.equal(client.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(client.listenerCount('notification'), 0);
});

test('the same active-writer RPC text after turn/start remains uncertain and is thrown', async () => {
  const rejection = new RpcError({ code: -32600, message: `thread ${task().threadId} already has an active writer` });
  const { adapter, client } = executionAdapter(async method => {
    if (method === 'turn/start') throw rejection;
  });
  await assert.rejects(adapter.execute(task(), { onTurnStarted: async () => {} }), error => error === rejection);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(client.listenerCount('notification'), 0);
});

test('resume timeouts, generic errors, wrong-thread errors and other RPC codes are not classified as an unsent writer wait', async () => {
  const writerMessage = `thread ${task().threadId} already has an active writer`;
  const timeout = new Error(writerMessage);
  timeout.code = 'RPC_TIMEOUT';
  const errors = [
    timeout,
    new Error(writerMessage),
    new RpcError({ code: -32600, message: 'thread other-thread already has an active writer' }),
    new RpcError({ code: -32000, message: writerMessage }),
    new RpcError({ code: -32600, message: 'Unable to resume this conversation.' }),
  ];
  for (const rejection of errors) {
    const { adapter, client } = executionAdapter(async method => {
      if (method === 'thread/resume') throw rejection;
    });
    await assert.rejects(adapter.execute(task(), { onTurnStarted: async () => {} }), error => error === rejection);
    assert.equal(client.calls.some(call => call.method === 'turn/start'), false);
  }
});

test('partial output on quota failure requires manual handling instead of repeating work', async () => {
  const { adapter } = executionAdapter(async method => method === 'turn/start' ? { turn: { id: 'turn-1', status: 'failed', error: { message: 'Usage limit reached' }, items: [{ id: 'answer', type: 'agentMessage', text: 'Completed the first section.' }] } } : undefined);
  const result = await adapter.execute(task(), { onTurnStarted: async () => {} });
  assert.equal(result.status, 'needs_review');
});

test('tool work in final turn items prevents quota autoretry even without item-start notifications', async () => {
  for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageGeneration', 'collabAgentToolCall']) {
    const { adapter } = executionAdapter(async method => method === 'turn/start' ? { turn: { id: 'turn-1', status: 'failed', error: { message: 'Usage limit reached' }, items: [{ id: 'tool', type }] } } : undefined);
    const result = await adapter.execute(task(), { onTurnStarted: async () => {} });
    assert.equal(result.status, 'needs_review', type);
  }
});

test('a structured quota error without output can wait even when the human message is localized', async () => {
  const { adapter } = executionAdapter(async method => method === 'turn/start' ? { turn: { id: 'turn-1', status: 'failed', error: { message: '使用额度已用完', codexErrorInfo: 'usageLimitExceeded' }, items: [] } } : undefined);
  const result = await adapter.execute(task(), { onTurnStarted: async () => {} });
  assert.equal(result.status, 'waiting_quota');
});

test('an approval request for another thread cannot interrupt or fail this task', async () => {
  const { adapter, client } = executionAdapter(async (method, params, rpc) => {
    if (method === 'turn/start') {
      rpc.emit('serverRequest', { id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: 'other-thread', turnId: 'other-turn' } });
      return { turn: { id: 'turn-1', status: 'completed', items: [] } };
    }
  });
  const result = await adapter.execute(task(), { onTurnStarted: async () => {} });
  assert.equal(result.status, 'completed');
  assert.equal(client.errors.length, 0);
  assert.equal(client.calls.some(c => c.method === 'turn/interrupt'), false);
});

test('approval in this task is never auto-approved or automatically retried', async () => {
  const { adapter, client } = executionAdapter(async (method, params, rpc) => {
    if (method === 'turn/start') {
      rpc.emit('serverRequest', { id: 92, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-123', turnId: 'turn-1' } });
      return { turn: { id: 'turn-1', status: 'interrupted', items: [] } };
    }
  });
  const result = await adapter.execute(task(), { onTurnStarted: async () => {} });
  assert.ok(['failed', 'needs_review'].includes(result.status));
  assert.equal(client.errors.length, 1);
  assert.equal(client.errors[0].id, 92);
  assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('an old-turn approval arriving before the start response cannot contaminate this turn', async () => {
  const { adapter, client } = executionAdapter(async (method, params, rpc) => {
    if (method === 'turn/start') {
      rpc.emit('serverRequest', { id: 93, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-123', turnId: 'old-turn' } });
      return { turn: { id: 'turn-1', status: 'completed', items: [] } };
    }
  });
  const result = await adapter.execute(task(), { onTurnStarted: async () => {} });
  assert.equal(result.status, 'completed');
  assert.equal(client.errors.length, 0);
  assert.equal(client.calls.some(c => c.method === 'turn/interrupt'), false);
});

test('a completion for a different turn in the same thread cannot finish this task', async () => {
  const { adapter, client } = executionAdapter(async (method, params, rpc) => {
    if (method === 'turn/start') {
      rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-123', turn: { id: 'old-turn', status: 'completed', items: [{ id: 'old-answer', type: 'agentMessage', text: 'Unrelated old answer' }] } } });
      setImmediate(() => rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-123', turn: { id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Correct answer' }] } } }));
      return { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
    }
  });
  const result = await adapter.execute(task(), { onTurnStarted: async () => {} });
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.output, 'Correct answer');
  assert.equal(client.listenerCount('notification'), 0);
});

test('reconcile finds the exact client message ID across pages without any resend', async () => {
  const client = new FakeRpc(async (method, params) => {
    if (method === 'thread/turns/list') return params.cursor
      ? { data: [{ id: 'recovered-turn', startedAt: Date.parse('2026-10-20T04:00:01Z') / 1000, status: 'completed', items: [{ id: 'client-message-123', type: 'userMessage' }, { id: 'answer', type: 'agentMessage', text: 'Recovered' }] }] }
      : { data: [{ id: 'unrelated-turn', status: 'completed', items: [{ id: 'different-message', type: 'userMessage' }] }], nextCursor: 'page-2' };
  });
  const adapter = new CodexAdapter({ client });
  adapter.getThreadState = async () => ({ busy: false });
  const result = await adapter.reconcile(task());
  assert.equal(result.status, 'completed');
  assert.equal(result.turnId, 'recovered-turn');
  assert.equal(client.calls.some(c => c.method === 'turn/start'), false);
});

test('reconcile cannot infer delivery from identical text without the exact message ID', async () => {
  const client = new FakeRpc(async method => method === 'thread/turns/list' ? { data: [{ id: 'unrelated-turn', status: 'completed', items: [{ id: 'different-message', type: 'userMessage', content: [{ type: 'inputText', text: task().prompt }] }] }] } : undefined);
  const adapter = new CodexAdapter({ client });
  const result = await adapter.reconcile(task());
  assert.equal(result.status, 'needs_review');
  assert.equal(client.calls.some(c => c.method === 'turn/start'), false);
});

test('conversation metadata exposes actual routing without dropping incompatible same-title chats', async t => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'project');
  await writeFile(path.join(dir, '.codex-global-state.json'), JSON.stringify({ 'local-projects': [{ id: 'selected', rootPaths: [root] }] }));
  const client = new FakeRpc(async method => method === 'thread/list' ? { data: [
    { id: 'openai-chat', name: 'Same', cwd: root, modelProvider: 'openai' },
    { id: 'deepseek-chat', name: 'Same', cwd: root, modelProvider: 'deepseek' },
    { id: 'unknown-chat', name: 'Same', cwd: root },
  ] } : undefined);
  const threads = await new CodexAdapter({ client, codexHome: dir }).threads(root);
  assert.equal(threads.length, 3);
  assert.deepEqual(threads.map(row => row.providerCompatible), [true, false, false]);
  assert.deepEqual(threads.map(row => row.modelProvider), ['openai', 'deepseek', null]);
  assert.match(threads[1].providerLabel, /DeepSeek/);
  assert.ok(threads[2].providerIssue);
});

test('creating a GPT task for a DeepSeek-bound conversation fails before any submission', async t => {
  const dir = await tempDir(t);
  const root = path.join(dir, 'project');
  await mkdir(root);
  await writeFile(path.join(dir, '.codex-global-state.json'), JSON.stringify({ 'local-projects': [{ id: 'selected', rootPaths: [root] }] }));
  const client = new FakeRpc(async method => {
    if (method === 'thread/read') return { thread: { id: 'thread-123', cwd: root, modelProvider: 'deepseek' } };
    if (method === 'thread/list') return { data: [] };
  });
  await assert.rejects(new CodexAdapter({ client, codexHome: dir }).validateTask(task({ projectPath: root })), error => error.code === 'THREAD_PROVIDER_UNSUPPORTED');
  assert.equal(client.calls.some(call => ['thread/resume', 'turn/start'].includes(call.method)), false);
});

test('queued tasks recheck current authoritative provider and reject a caller-supplied OpenAI claim', async () => {
  for (const modelProvider of ['deepseek', null, undefined]) {
    const client = new FakeRpc(async method => method === 'thread/read' ? { thread: { id: 'thread-123', cwd: projectPath, modelProvider } } : undefined);
    const adapter = new CodexAdapter({ client });
    await assert.rejects(adapter.getThreadState(task({ modelProvider: 'openai', providerCompatible: true })), error => ['THREAD_PROVIDER_UNSUPPORTED', 'THREAD_PROVIDER_UNKNOWN'].includes(error.code));
    assert.equal(client.calls.some(call => ['thread/resume', 'turn/start'].includes(call.method)), false);
  }
});

test('target working directory config is re-read and a changed OpenAI external endpoint stops queued work', async () => {
  let unsafe = false;
  const client = new FakeRpc(async (method, params) => {
    if (method === 'config/read') {
      assert.equal(params.cwd, projectPath);
      return { config: { model_provider: 'openai', ...(unsafe ? { model_providers: { openai: { base_url: 'https://api.deepseek.com' } } } : {}) } };
    }
    if (method === 'thread/list' || method === 'thread/turns/list') return { data: [] };
  });
  const adapter = new CodexAdapter({ client });
  assert.equal((await adapter.getThreadState(task())).providerCompatible, true);
  unsafe = true;
  await assert.rejects(adapter.getThreadState(task()), error => error.code === 'OPENAI_ENDPOINT_OVERRIDE');
  assert.equal(client.calls.filter(call => call.method === 'config/read').length, 2);
});

test('model catalog hides custom providers and a stale unknown GPT selection is refused', async () => {
  const client = new FakeRpc(async method => method === 'model/list' ? { data: [{ model }, { model: 'deepseek-chat' }, { model: 'gptfake' }] } : undefined);
  const adapter = new CodexAdapter({ client });
  assert.deepEqual((await adapter.models()).map(row => row.id), [model]);
  await assert.rejects(adapter.validateProviderForThread(task({ model: 'gpt-stale' })), error => error.code === 'SUBSCRIPTION_MODEL_UNAVAILABLE');
});

test('a resume response cannot silently redirect an OpenAI task to another provider', async () => {
  const { adapter, client } = executionAdapter(async method => method === 'thread/resume' ? { model, modelProvider: 'deepseek', thread: { cwd: projectPath, modelProvider: 'deepseek' } } : undefined);
  const result = await adapter.execute(task(), { onTurnStarted: async () => {} });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /服务商/);
  assert.equal(client.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(client.calls.find(call => call.method === 'thread/resume').params.modelProvider, 'openai');
});

test('connection diagnostics return only sanitized routing and never raw RPC errors', async () => {
  const client = new FakeRpc(async () => { throw new Error('secret-value api_key=not-for-diagnostics'); });
  const result = await new CodexAdapter({ client }).subscriptionStatus({ refresh: true });
  assert.equal(result.ready, false);
  assert.equal(result.code, 'PROVIDER_CONFIGURATION_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result), /secret-value|api_key/);
});
