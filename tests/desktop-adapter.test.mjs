import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexAdapter } from '../src/codex-adapter.mjs';
import { DesktopClientError } from '../src/desktop-client.mjs';

const SOURCE = '11111111-1111-7111-8111-111111111111';
const OTHER_SOURCE = '22222222-2222-7222-8222-222222222222';
const TARGET = '33333333-3333-7333-8333-333333333333';
const PROJECT = 'C:\\Projects\\DesktopAdapterFixture';
const task = (fields = {}) => ({
  id: 'schedule-fixture-1', threadId: TARGET, projectPath: PROJECT,
  model: 'gpt-selected-fixture', effort: 'high',
  prompt: '  Preserve this exact prompt.\n第二行 <tag> & punctuation.  ',
  ...fields,
});
const jsonResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const wrapper = (scheduled, id = 'desktop-input-new', fields = {}) => ({
  id, type: 'functionCallOutput', name: 'send_message_to_thread', namespace: 'codex_app',
  output: `<codex_delegation>\n  <source_thread_id>${SOURCE}</source_thread_id>\n  <input>${scheduled.prompt}</input>\n</codex_delegation>`,
  ...fields,
});
const turn = (id, items = [], fields = {}) => ({ id, status: 'completed', items, ...fields });
const receipt = (fields = {}) => ({
  transport: 'codex-desktop', sourceThreadId: SOURCE,
  acknowledgedAt: new Date().toISOString(), knownTurnIds: [], knownItemIds: [],
  native: { threadId: TARGET }, ...fields,
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeRpc extends EventEmitter {
  constructor({ snapshots = [[]], latest = null, onFullHistory, modelProvider = 'openai', config = { model_provider: null }, accountType = 'chatgpt', onRequest } = {}) {
    super();
    this.snapshots = snapshots;
    this.modelProvider = modelProvider;
    this.config = config;
    this.accountType = accountType;
    this.onRequest = onRequest;
    this.latest = latest;
    this.onFullHistory = onFullHistory;
    this.fullReads = 0;
    this.calls = [];
  }
  async request(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    const overridden = await this.onRequest?.(method, params, this);
    if (overridden !== undefined) return overridden;
    if (method === 'account/read') return { account: { type: this.accountType } };
    if (method === 'config/read') return { config: this.config };
    if (method === 'model/list') return { data: [{ model: task().model, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] };
    if (method === 'thread/read') return { thread: { modelProvider: this.modelProvider, id: TARGET, cwd: PROJECT, status: { type: 'idle' } } };
    if (method === 'thread/list') return { data: [] };
    if (method === 'thread/turns/list') {
      if (params.itemsView !== 'full') return { data: this.latest ? [this.latest] : [] };
      const index = this.fullReads++;
      if (this.onFullHistory) return { data: await this.onFullHistory(index) };
      return { data: structuredClone(this.snapshots[Math.min(index, this.snapshots.length - 1)]) };
    }
    throw new Error(`Unexpected isolated RPC request: ${method}`);
  }
  async close() {}
}

class FakeDesktop {
  constructor({ onTool, sourceThreadId = SOURCE } = {}) {
    this.onTool = onTool;
    this.sourceThreadId = sourceThreadId;
    this.calls = [];
    this.infoReads = 0;
  }
  async connectionInfo() { this.infoReads++; return { sourceThreadId: this.sourceThreadId }; }
  async callTool(name, args, options) {
    this.calls.push({ name, args: structuredClone(args), options: options ? structuredClone(options) : undefined });
    const response = await this.onTool?.(name, args, options);
    if (response !== undefined) return response;
    if (name === 'list_projects') return jsonResult({ projects: [{ path: PROJECT, name: 'Fixture' }] });
    if (name === 'send_message_to_thread') return jsonResult({ threadId: TARGET });
    throw new Error(`Unexpected isolated desktop tool: ${name}`);
  }
  async close() {}
}

function harness(t, { rpc = {}, desktop = {} } = {}) {
  const client = new FakeRpc(rpc);
  const desktopClient = new FakeDesktop(desktop);
  const adapter = new CodexAdapter({ client, desktopClient });
  t.after(() => adapter.close());
  return { adapter, client, desktopClient };
}
const sentCalls = desktop => desktop.calls.filter(call => call.name === 'send_message_to_thread');
const callbacks = () => ({ async onSubmitted() {}, async onTurnStarted() {} });

test('desktop dispatch preserves the exact prompt, selected model and thinking strength', async t => {
  const scheduled = task();
  const { adapter, client, desktopClient } = harness(t);
  let saved;
  const result = await adapter.execute(scheduled, {
    async onSubmitted(value) { saved = structuredClone(value); },
    async onTurnStarted() { assert.fail('An acknowledgement without a matching turn must not invent a turn id.'); },
  });
  assert.deepEqual(sentCalls(desktopClient), [{
    name: 'send_message_to_thread',
    args: { threadId: TARGET, prompt: scheduled.prompt, model: scheduled.model, thinking: scheduled.effort },
    options: { sourceThreadId: SOURCE },
  }]);
  assert.equal(saved.transport, 'codex-desktop');
  assert.equal(saved.sourceThreadId, SOURCE);
  assert.equal(saved.native.threadId, TARGET);
  assert.equal(result.status, 'running');
  assert.equal(result.turnId, undefined);
  assert.equal(client.calls.some(call => ['thread/resume', 'turn/start'].includes(call.method)), false);
});

test('a saved source conversation remains authoritative after the desktop connection changes', async t => {
  const scheduled = task({ sourceThreadId: SOURCE });
  const { adapter, desktopClient } = harness(t, { desktop: { sourceThreadId: OTHER_SOURCE } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(sentCalls(desktopClient)[0].options.sourceThreadId, SOURCE);
  assert.equal(result.submissionReceipt.sourceThreadId, SOURCE);
});

test('acknowledgement waits for the receipt to be saved before reading execution results', async t => {
  const { adapter, client } = harness(t);
  const entered = deferred();
  const allowSave = deferred();
  let settled = false;
  const pending = adapter.execute(task(), {
    async onSubmitted(value) { entered.resolve(value); await allowSave.promise; },
    async onTurnStarted() { assert.fail('There is no matching turn yet.'); },
  }).then(result => { settled = true; return result; });
  const acknowledged = await entered.promise;
  assert.equal(acknowledged.transport, 'codex-desktop');
  assert.equal(settled, false);
  assert.equal(client.fullReads, 1, 'Only the checkpoint may be read until receipt persistence completes.');
  allowSave.resolve();
  const result = await pending;
  assert.equal(result.status, 'running');
  assert.equal(result.turnId, undefined);
  assert.equal(client.fullReads, 2);
});

test('a new matching native input followed by a completed turn becomes completed', async t => {
  const scheduled = task();
  const completedTurn = turn('turn-after-send', [wrapper(scheduled), { id: 'answer', type: 'agentMessage', text: 'Verified fixture result.' }]);
  const { adapter, desktopClient } = harness(t, { rpc: { snapshots: [[], [completedTurn]] } });
  const events = [];
  const result = await adapter.execute(scheduled, {
    async onSubmitted() { events.push('receipt-saved'); },
    async onTurnStarted(id) { events.push(id); },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.turnId, completedTurn.id);
  assert.equal(result.output, 'Verified fixture result.');
  assert.equal(result.submissionReceipt.native.turnId, completedTurn.id);
  assert.deepEqual(events, ['receipt-saved', completedTurn.id]);
  assert.equal(sentCalls(desktopClient).length, 1);
});

test('a matching native input in an unfinished turn remains running', async t => {
  const scheduled = task();
  const { adapter } = harness(t, { rpc: { snapshots: [[], [turn('turn-still-working', [wrapper(scheduled)], { status: 'inProgress' })]] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'running');
  assert.equal(result.turnId, 'turn-still-working');
});

test('the same text in a human user message cannot claim a desktop submission', async t => {
  const scheduled = task();
  const humanTurn = turn('human-turn', [
    { id: scheduled.id, type: 'userMessage', content: [{ type: 'text', text: scheduled.prompt }] },
    { id: 'human-answer', type: 'agentMessage', text: 'This belongs to the human message.' },
  ]);
  const { adapter } = harness(t, { rpc: { snapshots: [[], [humanTurn]] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'running');
  assert.equal(result.turnId, undefined);
  assert.equal(result.output, undefined);
});

test('a native wrapper must match the source, tool, namespace and exact prompt', async t => {
  const scheduled = task();
  const mismatches = [
    wrapper(scheduled, 'wrong-source', { output: wrapper(scheduled).output.replace(SOURCE, OTHER_SOURCE) }),
    wrapper(scheduled, 'wrong-tool', { name: 'different_tool' }),
    wrapper(scheduled, 'wrong-namespace', { namespace: 'different_app' }),
    wrapper(scheduled, 'trimmed-prompt', { output: wrapper(scheduled).output.replace(scheduled.prompt, scheduled.prompt.trim()) }),
  ];
  const { adapter } = harness(t, { rpc: { snapshots: [[], mismatches.map(item => turn(item.id + '-turn', [item]))] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'running');
  assert.equal(result.turnId, undefined);
});

test('an old matching wrapper already in the checkpoint cannot count as the new send', async t => {
  const scheduled = task();
  const old = turn('turn-before-send', [wrapper(scheduled, 'old-wrapper')]);
  const { adapter } = harness(t, { rpc: { snapshots: [[old], [old]] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'running');
  assert.equal(result.turnId, undefined);
  assert.deepEqual(result.submissionReceipt.knownTurnIds, [old.id]);
  assert.deepEqual(result.submissionReceipt.knownItemIds, ['old-wrapper']);
});

test('a genuinely new wrapper in an existing turn is distinguishable from its checkpoint', async t => {
  const scheduled = task();
  const old = turn('existing-turn', [wrapper(scheduled, 'old-wrapper')]);
  const after = turn(old.id, [...old.items, wrapper(scheduled, 'new-wrapper'), { id: 'answer', type: 'agentMessage', text: 'New result.' }]);
  const { adapter } = harness(t, { rpc: { snapshots: [[old], [after]] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'completed');
  assert.equal(result.turnId, old.id);
});

test('multiple new matching wrappers in separate turns require review without resending', async t => {
  const scheduled = task();
  const ambiguous = [turn('new-turn-a', [wrapper(scheduled, 'wrapper-a')]), turn('new-turn-b', [wrapper(scheduled, 'wrapper-b')])];
  const { adapter, desktopClient } = harness(t, { rpc: { snapshots: [[], ambiguous] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'needs_review');
  assert.equal(result.turnId, undefined);
  assert.equal(sentCalls(desktopClient).length, 1);
});

test('multiple new matching wrappers in one turn also require review', async t => {
  const scheduled = task();
  const ambiguous = turn('combined-turn', [wrapper(scheduled, 'wrapper-a'), wrapper(scheduled, 'wrapper-b')]);
  const { adapter } = harness(t, { rpc: { snapshots: [[], [ambiguous]] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'needs_review');
});

test('reconciliation reads persisted desktop receipts and never sends again', async t => {
  const scheduled = task();
  const completedTurn = turn('persisted-desktop-turn', [wrapper(scheduled), { id: 'answer', type: 'agentMessage', text: 'Recovered result.' }]);
  const { adapter, desktopClient } = harness(t, {
    rpc: { snapshots: [[completedTurn]] },
    desktop: { onTool() { assert.fail('Reconciliation must not invoke any desktop tool.'); } },
  });
  const recovered = { ...scheduled, submissionReceipt: receipt() };
  const first = await adapter.reconcile(recovered);
  const second = await adapter.reconcile({ ...recovered, turnId: first.turnId, submissionReceipt: first.submissionReceipt });
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.equal(second.output, 'Recovered result.');
  assert.equal(desktopClient.calls.length, 0);
  assert.equal(desktopClient.infoReads, 0);
});

test('an expired acknowledgement without a matching record requires review and never resends', async t => {
  const { adapter, desktopClient } = harness(t);
  const result = await adapter.reconcile({ ...task(), submissionReceipt: receipt({ acknowledgedAt: new Date(Date.now() - 121000).toISOString() }) });
  assert.equal(result.status, 'needs_review');
  assert.equal(sentCalls(desktopClient).length, 0);
});

test('unavailable desktop health keeps the task waiting before any send', async t => {
  const { adapter, desktopClient } = harness(t, { desktop: { onTool(name) {
    if (name === 'list_projects') throw new DesktopClientError('Fixture desktop unavailable.');
  } } });
  const result = await adapter.execute(task(), {
    async onSubmitted() { assert.fail('No receipt exists before sending.'); },
    async onTurnStarted() { assert.fail('No turn exists before sending.'); },
  });
  assert.equal(result.status, 'waiting_thread');
  assert.equal(result.error, 'Fixture desktop unavailable.');
  assert.equal(sentCalls(desktopClient).length, 0);
});

test('a confirmed pre-call rejection waits, while a possibly dispatched error is propagated', async t => {
  for (const [name, options, expectedWait] of [
    ['pre-call rejection', { stage: 'preCall', uncertain: false }, true],
    ['tool-call uncertainty', { stage: 'toolCall', uncertain: true }, false],
    ['uncertain pre-call label', { stage: 'preCall', uncertain: true }, false],
  ]) await t.test(name, async sub => {
    const error = new DesktopClientError(name, options);
    const { adapter, desktopClient } = harness(sub, { desktop: { onTool(tool) { if (tool === 'send_message_to_thread') throw error; } } });
    const pending = adapter.execute(task(), {
      async onSubmitted() { assert.fail('A rejected or uncertain send has no confirmed receipt.'); },
      async onTurnStarted() { assert.fail('A rejected or uncertain send has no identified turn.'); },
    });
    if (expectedWait) { const result = await pending; assert.equal(result.status, 'waiting_thread'); assert.equal(result.error, name); }
    else await assert.rejects(pending, caught => caught === error);
    assert.equal(sentCalls(desktopClient).length, 1);
  });
});

test('a native tool-level error is not treated as proof that nothing was sent', async t => {
  const { adapter } = harness(t, { desktop: { onTool(name) {
    if (name === 'send_message_to_thread') return { isError: true, content: [{ type: 'text', text: 'Fixture uncertain native result.' }] };
  } } });
  await assert.rejects(adapter.execute(task(), callbacks()), /Fixture uncertain native result/);
});

test('the incoming native wrapper alone is not a tool side effect when quota blocks generation', async t => {
  const scheduled = task();
  const failed = turn('quota-blocked-turn', [wrapper(scheduled)], { status: 'failed', error: { message: 'usage limit exceeded' } });
  const { adapter } = harness(t, { rpc: { snapshots: [[], [failed]] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'waiting_quota');
  assert.equal(result.confirmedNoWork, true);
  assert.equal(result.submissionReceipt.native.turnId, 'quota-blocked-turn');
  assert.equal(result.submissionReceipt.native.inputItemId, 'desktop-input-new');
  assert.match(result.error, /未产生输出或工具操作/);
});

test('actual tool work before a quota error still requires review', async t => {
  const scheduled = task();
  const failed = turn('partial-work-turn', [wrapper(scheduled), { id: 'command', type: 'commandExecution', command: 'fixture command' }], { status: 'failed', error: { message: 'usage limit exceeded' } });
  const { adapter } = harness(t, { rpc: { snapshots: [[], [failed]] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'needs_review');
  assert.notEqual(result.confirmedNoWork, true);
  assert.match(result.error, /部分工作/);
});

test('native quota proof exists only when the uniquely matched turn has neither output nor tool work', async t => {
  for (const hasOutput of [false, true]) for (const hasTool of [false, true]) {
    await t.test(`output=${hasOutput}, tool=${hasTool}`, async sub => {
      const scheduled = task();
      const items = [wrapper(scheduled)];
      if (hasOutput) items.push({ id: 'partial-answer', type: 'agentMessage', text: 'Some work has already reached the conversation.' });
      if (hasTool) items.push({ id: 'file-change', type: 'fileChange', changes: [{ path: 'fixture.txt', diff: '+changed' }] });
      const rejected = turn('unique-quota-turn', items, { status: 'failed', error: { message: 'rate limit exceeded' } });
      const { adapter, desktopClient } = harness(sub, { rpc: { snapshots: [[], [rejected]] } });
      const result = await adapter.execute(scheduled, callbacks());
      assert.equal(result.status, hasOutput || hasTool ? 'needs_review' : 'waiting_quota');
      assert.equal(result.confirmedNoWork === true, !hasOutput && !hasTool);
      assert.equal(result.turnId, rejected.id);
      assert.equal(result.submissionReceipt.native.turnId, rejected.id);
      assert.equal(result.submissionReceipt.native.inputItemId, 'desktop-input-new');
      assert.equal(sentCalls(desktopClient).length, 1);
      if (hasOutput) assert.match(result.output, /Some work/);
    });
  }
});

test('outgoing calls and unrelated function outputs invalidate native no-work proof', async t => {
  const extraItems = [
    { id: 'outgoing-call', type: 'functionCall', name: 'write_file', arguments: '{}' },
    { id: 'mcp-call', type: 'mcpToolCall', server: 'fixture', tool: 'mutate' },
    { id: 'unrelated-output', type: 'functionCallOutput', name: 'different_tool', namespace: 'codex_app', output: 'Done.' },
  ];
  for (const extra of extraItems) await t.test(extra.type + '/' + extra.id, async sub => {
    const scheduled = task();
    const rejected = turn('quota-after-tool', [wrapper(scheduled), extra], { status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } });
    const { adapter } = harness(sub, { rpc: { snapshots: [[], [rejected]] } });
    const result = await adapter.execute(scheduled, callbacks());
    assert.equal(result.status, 'needs_review');
    assert.notEqual(result.confirmedNoWork, true);
  });
});

test('quota no-work proof is withheld if more than one new native input could be ours', async t => {
  const scheduled = task();
  const rejected = turn('ambiguous-quota-turn', [wrapper(scheduled, 'input-a'), wrapper(scheduled, 'input-b')], { status: 'failed', error: { message: 'quota exceeded' } });
  const { adapter } = harness(t, { rpc: { snapshots: [[], [rejected]] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'needs_review');
  assert.notEqual(result.confirmedNoWork, true);
});

test('an empty ordinary failure or a completed turn never authorizes a quota retry', async t => {
  for (const [name, fields, expected] of [
    ['ordinary failure', { status: 'failed', error: { message: 'Unrelated fixture failure.' } }, 'failed'],
    ['completed turn', { status: 'completed', error: { message: 'quota exceeded' } }, 'completed'],
  ]) await t.test(name, async sub => {
    const scheduled = task();
    const { adapter } = harness(sub, { rpc: { snapshots: [[], [turn('non-retry-turn', [wrapper(scheduled)], fields)]] } });
    const result = await adapter.execute(scheduled, callbacks());
    assert.equal(result.status, expected);
    assert.notEqual(result.confirmedNoWork, true);
  });
});

test('output truncation cannot hide real output when deciding whether a quota retry is safe', async t => {
  const scheduled = task();
  const emitted = ' '.repeat(100000) + 'A real answer was already emitted.';
  const rejected = turn('quota-after-long-output', [wrapper(scheduled), { id: 'long-answer', type: 'agentMessage', text: emitted }], { status: 'failed', error: { message: 'usage limit exceeded' } });
  const { adapter } = harness(t, { rpc: { snapshots: [[], [rejected]] } });
  const result = await adapter.execute(scheduled, callbacks());
  assert.equal(result.status, 'needs_review');
  assert.notEqual(result.confirmedNoWork, true);
});

test('GPT selection cannot send to DeepSeek, an alias or an unknown native target provider', async t => {
  for (const modelProvider of ['deepseek', 'OPENAI', 'openai-proxy', null]) await t.test(String(modelProvider), async sub => {
    const { adapter, desktopClient } = harness(sub, { rpc: { modelProvider } });
    await assert.rejects(adapter.execute(task({ modelProvider: 'openai' }), callbacks()), error => ['THREAD_PROVIDER_UNSUPPORTED', 'THREAD_PROVIDER_UNKNOWN'].includes(error.code));
    assert.equal(sentCalls(desktopClient).length, 0);
  });
});

test('the final native-send guard catches a provider change after the history checkpoint', async t => {
  const { adapter, client, desktopClient } = harness(t, { rpc: {
    onRequest(method, params, rpc) {
      if (method === 'thread/read' && rpc.fullReads > 0) return { thread: { id: TARGET, cwd: PROJECT, modelProvider: 'deepseek' } };
    },
  } });
  await assert.rejects(adapter.execute(task(), callbacks()), error => error.code === 'THREAD_PROVIDER_UNSUPPORTED');
  assert.equal(client.fullReads, 1);
  assert.equal(sentCalls(desktopClient).length, 0);
});

test('a custom OpenAI endpoint or API account never reaches a native send', async t => {
  for (const rpc of [
    { config: { model_provider: 'openai', model_providers: { openai: { base_url: 'https://api.deepseek.com' } } } },
    { accountType: 'apiKey' },
  ]) await t.test(rpc.accountType || 'custom endpoint', async sub => {
    const { adapter, desktopClient } = harness(sub, { rpc });
    await assert.rejects(adapter.execute(task(), callbacks()), error => ['OPENAI_ENDPOINT_OVERRIDE', 'SUBSCRIPTION_LOGIN_REQUIRED'].includes(error.code));
    assert.equal(sentCalls(desktopClient).length, 0);
  });
});

test('provider changes after a saved receipt do not prevent read-only reconciliation or trigger resends', async t => {
  const scheduled = task();
  const { adapter, desktopClient } = harness(t, { rpc: { modelProvider: 'deepseek', snapshots: [[turn('completed-before-provider-change', [wrapper(scheduled)])]] } });
  const result = await adapter.reconcile({ ...scheduled, submissionReceipt: receipt() });
  assert.equal(result.status, 'completed');
  assert.equal(sentCalls(desktopClient).length, 0);
});
