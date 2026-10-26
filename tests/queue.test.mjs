import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QueueManager } from '../src/queue.mjs';

const BASE = Date.parse('2026-10-20T04:00:00.000Z');
const input = (fields = {}) => ({
  projectPath: 'C:\\Projects\\Example', projectLabel: 'Example',
  threadId: 'thread-1', threadTitle: 'Existing conversation',
  model: 'gpt-test', effort: 'medium', prompt: 'Continue this work.',
  runAt: new Date(BASE).toISOString(), ...fields,
});
const desktopReceipt = (fields = {}) => ({
  transport: 'codex-desktop', acknowledgedAt: new Date(BASE).toISOString(),
  sourceThreadId: 'scheduler-source-thread', knownTurnIds: ['previous-turn'], native: {}, ...fields,
});

async function harness(t, overrides = {}, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-queue-test-'));
  const storePath = path.join(dir, 'queue.json');
  let now = BASE;
  const calls = { execute: [], quota: [], state: [], reconcile: [] };
  const adapter = {
    async getQuota(model) { calls.quota.push(model); return { allowed: true, resetAt: null }; },
    async getThreadState(task) { calls.state.push(task.id); return { busy: false, archived: false, cwd: task.projectPath }; },
    async execute(task, { onTurnStarted }) {
      calls.execute.push(task);
      await onTurnStarted(`turn-${task.id}`);
      return { status: 'completed', turnId: `turn-${task.id}`, output: 'Done.' };
    },
    async reconcile(task) { calls.reconcile.push(task); return { status: 'needs_review', error: 'Submission uncertain.' }; },
    ...overrides,
  };
  const queue = new QueueManager({ storePath, adapter, clock: () => now, ...options });
  await queue.initialize();
  t.after(async () => { await queue.stop(); await rm(dir, { recursive: true, force: true }); });
  return { queue, adapter, calls, storePath, advance: ms => { now += ms; }, now: () => now };
}

test('creates a persistent task, retains explicit model and returns isolated snapshots', async t => {
  const { queue, storePath, adapter, now } = await harness(t);
  const task = await queue.create(input({ runAt: '2026-10-20T13:00:00+08:00' }));
  assert.equal(task.runAt, '2026-10-20T05:00:00.000Z');
  assert.equal(task.model, 'gpt-test');
  assert.equal(task.status, 'scheduled');
  task.prompt = 'Changed outside the queue';
  assert.equal(queue.get(task.id).prompt, 'Continue this work.');
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  assert.equal(reopened.get(task.id).prompt, 'Continue this work.');
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).tasks.length, 1);
});

test('editing rejects previously submitted tasks even if their stored status looks pending', async t => {
  for (const proof of [{ submissionReceipt: desktopReceipt() }, { turnId: 'already-started-turn' }, { dispatchState: 'intent' }, { dispatchState: 'submitted' }]) {
    const { queue, adapter, storePath, now } = await harness(t);
    const task = await queue.create(input({ runAt: new Date(BASE + 60_000).toISOString() }));
    const document = JSON.parse(await readFile(storePath, 'utf8'));
    Object.assign(document.tasks[0], proof);
    await writeFile(storePath, JSON.stringify(document));
    const reopened = new QueueManager({ storePath, adapter, clock: now });
    await reopened.initialize();
    await assert.rejects(reopened.update(task.id, { prompt: 'Unsafe edit.' }), /已经提交/);
    assert.equal(reopened.get(task.id).prompt, task.prompt);
    await reopened.stop();
  }
});

test('deduplicates concurrent create requests by clientRequestId', async t => {
  const { queue } = await harness(t);
  const tasks = await Promise.all(Array.from({ length: 8 }, () => queue.create(input({ clientRequestId: 'request-1' }))));
  assert.equal(new Set(tasks.map(task => task.id)).size, 1);
  assert.equal(queue.list().length, 1);
});

test('a due task cannot begin dispatch before its creation write commits', { timeout: 3000 }, async t => {
  const { queue, calls } = await harness(t);
  const writeStore = queue._writeStore.bind(queue);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  let first = true;
  queue._writeStore = async () => { if (first) { first = false; entered(); await gate; } return writeStore(); };
  const creating = queue.create(input({ clientRequestId: 'durability-before-dispatch' }));
  await began;
  const pending = queue.list()[0];
  await queue.tick();
  assert.equal(calls.state.length, 0);
  assert.equal(calls.execute.length, 0);
  await assert.rejects(queue.delete(pending.id), error => error.code === 'task_busy');
  release();
  const saved = await creating;
  await queue.tick();
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.execute[0].id, saved.id);
});

test('failed creation rolls back before a concurrent snapshot and never leaves a dispatchable ghost', { timeout: 3000 }, async t => {
  const { queue, storePath, calls } = await harness(t);
  const writeStore = queue._writeStore.bind(queue);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  let failOnce = true;
  queue._writeStore = async () => { if (failOnce) { failOnce = false; entered(); await gate; throw new Error('Isolated creation disk failure.'); } return writeStore(); };
  const rejected = assert.rejects(queue.create(input({ clientRequestId: 'failed-cycle-child', threadId: 'failed-thread' })), /creation disk failure/);
  await began;
  const succeeded = queue.create(input({ clientRequestId: 'independent-create', threadId: 'other-thread' }));
  await queue.tick();
  release();
  await rejected;
  const saved = await succeeded;
  assert.deepEqual(queue.list().map(task => task.id), [saved.id]);
  assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).tasks.map(task => task.id), [saved.id]);
  await queue.tick();
  assert.deepEqual(calls.execute.map(task => task.id), [saved.id]);
});

test('a resumed task remains undispatchable until its resumed state is durable', { timeout: 3000 }, async t => {
  const { queue, calls } = await harness(t);
  const task = await queue.create(input());
  await queue.pause(task.id);
  const writeStore = queue._writeStore.bind(queue);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  let first = true;
  queue._writeStore = async () => { if (first) { first = false; entered(); await gate; } return writeStore(); };
  const resuming = queue.resume(task.id);
  await began;
  await queue.tick();
  assert.equal(calls.execute.length, 0);
  release();
  await resuming;
  await queue.tick();
  assert.equal(calls.execute.length, 1);
});

test('a failed resume durably restores pause instead of later sending an uncommitted change', async t => {
  const { queue, storePath, calls } = await harness(t);
  const task = await queue.create(input());
  await queue.pause(task.id);
  const writeStore = queue._writeStore.bind(queue);
  let failOnce = true;
  queue._writeStore = async () => { if (failOnce) { failOnce = false; throw new Error('Isolated resume write failure.'); } return writeStore(); };
  await assert.rejects(queue.resume(task.id), /resume write failure/);
  assert.equal(queue.get(task.id).status, 'paused');
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).tasks[0].status, 'paused');
  await queue.tick();
  assert.equal(calls.execute.length, 0);
});

test('deleting pending and historical tasks removes content and results from the durable store', async t => {
  const { queue, calls, storePath } = await harness(t);
  for (const status of ['scheduled', 'waiting_quota', 'waiting_thread', 'paused', 'completed', 'failed', 'cancelled', 'needs_review']) {
    const task = await queue.create(input({ threadId: `delete-${status}`, prompt: `private prompt ${status}`, clientRequestId: `request-${status}` }));
    const stored = queue.tasks.find(item => item.id === task.id);
    Object.assign(stored, { status, result: `private result ${status}` });
    if (status === 'needs_review') Object.assign(stored, { dispatchState: 'submitted', submissionReceipt: desktopReceipt(), turnId: 'possibly-sent' });
    await queue._persist();
    assert.deepEqual(await queue.delete(task.id), { deleted: true, id: task.id });
    assert.throws(() => queue.get(task.id), /Task not found/);
    const document = await readFile(storePath, 'utf8');
    assert.ok(!document.includes(`private prompt ${status}`));
    assert.ok(!document.includes(`private result ${status}`));
    assert.ok(!document.includes(`request-${status}`));
    assert.deepEqual(await queue.delete(task.id), { deleted: true, id: task.id });
  }
  await queue.tick();
  assert.deepEqual(queue.list(), []);
  assert.equal(calls.execute.length, 0);
  const document = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(document.deletedRequestHashes.length, 8);
  assert.ok(document.deletedRequestHashes.every(hash => /^[a-f0-9]{64}$/.test(hash)));
});

test('deletion tombstones reject concurrent and post-restart retries of the same creation request', async t => {
  const { queue, adapter, storePath, now } = await harness(t);
  const payload = input({ clientRequestId: 'deleted-create-request' });
  const task = await queue.create(payload);
  const deleting = queue.delete(task.id);
  const lateCreate = queue.create(payload);
  await assert.rejects(lateCreate, error => error.code === 'creation_deleted' && error.statusCode === 409);
  await deleting;
  await queue.stop();
  const reopened = await new QueueManager({ storePath, adapter, clock: now }).initialize();
  await assert.rejects(reopened.create(payload), error => error.code === 'creation_deleted');
  assert.deepEqual(reopened.list(), []);
  const fresh = await reopened.create({ ...payload, clientRequestId: 'a-new-explicit-request' });
  assert.notEqual(fresh.id, task.id);
  await reopened.stop();
});

test('deleting a missing task is idempotent and never writes to storage', async t => {
  const { queue } = await harness(t);
  queue._writeStore = async () => { assert.fail('A missing task must not trigger a write.'); };
  assert.deepEqual(await queue.delete('already-gone'), { deleted: true, id: 'already-gone' });
  assert.equal(queue.lastTickError, null);
});

test('running, actively processed, and inconsistent pending submissions cannot be deleted', async t => {
  const { queue, storePath } = await harness(t);
  for (const proof of [{ status: 'running' }, { _processing: true }, { _active: true }, { dispatchState: 'intent' }, { dispatchState: 'submitted' }, { submissionReceipt: desktopReceipt() }, { turnId: 'possibly-sent' }]) {
    const task = await queue.create(input({ threadId: `protected-${queue.list().length}` }));
    const stored = queue.tasks.find(item => item.id === task.id);
    const { _processing, _active, ...fields } = proof;
    Object.assign(stored, fields);
    if (_processing) queue._processing.add(task.id);
    if (_active) queue._active.add(task.id);
    await queue._persist();
    const before = await readFile(storePath, 'utf8');
    await assert.rejects(queue.delete(task.id), error => error.code === 'task_busy' && error.statusCode === 409);
    assert.equal(await readFile(storePath, 'utf8'), before);
    queue._processing.delete(task.id); queue._active.delete(task.id);
  }
});

test('a task deleted after tick snapshots candidates never reaches its adapter', async t => {
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const executed = [];
  const { queue, calls } = await harness(t, { async execute(task) { executed.push(task.id); started(); await gate; return { status: 'completed' }; } });
  const first = await queue.create(input({ threadId: 'first-thread' }));
  const second = await queue.create(input({ threadId: 'second-thread' }));
  const ticking = queue.tick();
  await began;
  await queue.delete(second.id);
  release();
  await ticking;
  assert.deepEqual(executed, [first.id]);
  assert.deepEqual(calls.state, [first.id]);
  assert.throws(() => queue.get(second.id), /Task not found/);
});

test('deletion failure rolls back before a concurrent create snapshot and pauses dispatch until retry', async t => {
  const { queue, storePath, calls } = await harness(t);
  const original = await queue.create(input({ clientRequestId: 'restore-on-error', threadId: 'shared-thread' }));
  const follower = await queue.create(input({ threadId: 'shared-thread' }));
  let release; let prepared;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { prepared = resolve; });
  const writeStore = queue._writeStore.bind(queue);
  let failOnce = true;
  queue._writeStore = async () => {
    if (failOnce && !queue.tasks.some(task => task.id === original.id)) {
      failOnce = false; prepared(); await gate; throw new Error('Isolated disk failure.');
    }
    return writeStore();
  };
  const deleting = queue.delete(original.id);
  const rejected = assert.rejects(deleting, error => error.code === 'deletion_persist_failed' && error.statusCode === 503);
  await began;
  await queue.tick();
  assert.equal(calls.execute.length, 0, 'the follower must remain blocked while deletion is uncommitted');
  const creating = queue.create(input({ clientRequestId: 'concurrent-create', threadId: 'another-thread' }));
  release();
  await rejected;
  const concurrent = await creating;
  const document = JSON.parse(await readFile(storePath, 'utf8'));
  assert.deepEqual(new Set(document.tasks.map(task => task.id)), new Set([original.id, follower.id, concurrent.id]));
  assert.equal(queue.get(original.id).prompt, original.prompt);
  assert.equal(queue.get(original.id).status, 'paused');
  assert.equal(document.tasks.find(task => task.id === original.id).status, 'paused');
  assert.equal(document.deletedRequestHashes, undefined);
  await queue.tick();
  assert.equal(calls.execute.length, 0, 'failed deletion must not silently resume sending');
  assert.match(queue.lastTickError, /调度已暂停/);
  await queue.delete(original.id);
  assert.equal(queue.lastTickError, null);
  await queue.tick();
  assert.ok(calls.execute.every(task => task.id !== original.id));
  assert.ok(calls.execute.some(task => task.id === concurrent.id));
});

test('a failed deletion durably pauses a waiting task across restart until explicit recovery', async t => {
  const { queue, adapter, storePath, now, calls } = await harness(t);
  const task = await queue.create(input({ clientRequestId: 'failed-delete-stays-paused' }));
  const follower = await queue.create(input());
  const writeStore = queue._writeStore.bind(queue);
  let failOnce = true;
  queue._writeStore = async () => { if (failOnce) { failOnce = false; throw new Error('Isolated transient write failure.'); } return writeStore(); };
  await assert.rejects(queue.delete(task.id), error => error.code === 'deletion_persist_failed');
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).tasks.find(item => item.id === task.id).status, 'paused');
  await queue.stop();
  const reopened = await new QueueManager({ storePath, adapter, clock: now }).initialize();
  await reopened.tick();
  assert.equal(calls.execute.length, 0);
  assert.equal(reopened.get(task.id).status, 'paused');
  assert.equal(reopened.get(follower.id).status, 'scheduled');
  await reopened.resume(task.id);
  await reopened.tick();
  assert.equal(calls.execute.length, 1, 'resuming is the explicit authorization to restore sending');
  await reopened.stop();
});

test('invalid deletion markers fail closed instead of permitting task resurrection', async t => {
  const { storePath, adapter, now } = await harness(t);
  for (const deletedRequestHashes of ['invalid', ['not-a-hash'], ['a'.repeat(64), 'a'.repeat(64)]]) {
    const body = JSON.stringify({ version: 1, tasks: [], deletedRequestHashes });
    await writeFile(storePath, body);
    const reopened = new QueueManager({ storePath, adapter, clock: now });
    await assert.rejects(reopened.initialize(), /Invalid deleted request markers/);
    assert.equal(await readFile(storePath, 'utf8'), body);
  }
});

test('the adapter-authorized source thread persists and remains fixed when a task is edited', async t => {
  const sourceThreadId = '11111111-1111-7111-8111-111111111111';
  const { queue, adapter, storePath, now } = await harness(t);
  const task = await queue.create(input({ sourceThreadId }));
  assert.equal(task.sourceThreadId, sourceThreadId);
  await queue.update(task.id, { prompt: 'Edited prompt.' });
  assert.equal(queue.get(task.id).sourceThreadId, sourceThreadId);
  await assert.rejects(queue.update(task.id, { sourceThreadId: '22222222-2222-7222-8222-222222222222' }), /cannot be edited/);
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  assert.equal(reopened.get(task.id).sourceThreadId, sourceThreadId);
});

test('runs due tasks once even when several callers tick at the same time', async t => {
  const { queue, calls } = await harness(t);
  const task = await queue.create(input());
  await Promise.all([queue.tick(), queue.tick(), queue.tick()]);
  await queue.tick();
  assert.equal(calls.execute.length, 1);
  const final = queue.get(task.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.attempts, 1);
  assert.equal(final.turnId, `turn-${task.id}`);
  assert.equal(final.result, 'Done.');
});

test('does not execute before the selected send time', async t => {
  const { queue, calls, advance } = await harness(t);
  const task = await queue.create(input({ runAt: new Date(BASE + 30_000).toISOString() }));
  await queue.tick();
  assert.equal(calls.execute.length, 0);
  advance(30_000);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'completed');
});

test('quota exhaustion preserves the task and resumes at the reported reset', async t => {
  let allowed = false;
  const resetAt = new Date(BASE + 3_600_000).toISOString();
  const { queue, calls, advance } = await harness(t, { async getQuota() { return { allowed, resetAt, reason: 'Five-hour limit reached.' }; } });
  const task = await queue.create(input());
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'waiting_quota');
  assert.equal(queue.get(task.id).nextAttemptAt, resetAt);
  assert.equal(queue.get(task.id).attempts, 0);
  assert.equal(calls.execute.length, 0);
  allowed = true;
  advance(3_599_999);
  await queue.tick();
  assert.equal(calls.execute.length, 0);
  advance(1);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'completed');
  assert.equal(calls.execute[0].model, 'gpt-test');
});

test('unknown quota reset uses conservative rechecks bounded at fifteen minutes', async t => {
  const { queue, calls, advance, now } = await harness(t, { async getQuota() { return { allowed: false, resetAt: null }; } });
  const task = await queue.create(input());
  for (let i = 0; i < 7; i++) {
    await queue.tick();
    const next = Date.parse(queue.get(task.id).nextAttemptAt);
    const delay = next - now();
    assert.ok(delay >= 60_000 && delay <= 900_000);
    advance(delay);
  }
  assert.equal(calls.execute.length, 0);
});

test('quota-available tasks use creation time and send immediately when quota is already available', async t => {
  const quotaChecks = [];
  const { queue, calls } = await harness(t, {
    async getQuota(model, options) { quotaChecks.push({ model, options }); return { allowed: true }; },
  });
  for (const [index, runAt] of [undefined, new Date(BASE + 86_400_000).toISOString(), 'unused date'].entries()) {
    const task = await queue.create(input({ sendMode: 'quota_available', threadId: `quota-thread-${index}`, runAt }));
    assert.equal(task.runAt, new Date(BASE).toISOString());
    assert.equal(task.nextAttemptAt, task.runAt);
    assert.equal(task.sendMode, 'quota_available');
  }
  await Promise.all([queue.tick(), queue.tick()]);
  await queue.tick();
  assert.equal(calls.execute.length, 3);
  assert.ok(queue.list().every(task => task.status === 'completed' && task.attempts === 1));
  assert.deepEqual(quotaChecks, Array.from({ length: 3 }, () => ({ model: 'gpt-test', options: { refresh: true } })));
});

test('quota-available tasks poll a long reset prediction and send once an earlier recovery is confirmed', async t => {
  let allowed = false;
  const checks = [];
  const resetAt = new Date(BASE + 3_600_000).toISOString();
  const { queue, calls, advance, storePath } = await harness(t, {
    async getQuota(model, options) { checks.push({ model, options }); return { allowed, resetAt, reason: 'Usage exhausted.' }; },
  });
  const task = await queue.create(input({ sendMode: 'quota_available', runAt: undefined }));
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'waiting_quota');
  assert.equal(queue.get(task.id).quotaResetAt, resetAt);
  assert.equal(queue.get(task.id).nextAttemptAt, new Date(BASE + 30_000).toISOString());
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).tasks[0].quotaResetAt, resetAt);
  assert.equal(calls.execute.length, 0);
  allowed = true;
  advance(29_999);
  await queue.tick();
  assert.equal(checks.length, 1);
  advance(1);
  await Promise.all([queue.tick(), queue.tick()]);
  await queue.tick();
  assert.equal(checks.length, 2);
  assert.ok(checks.every(check => check.options.refresh === true));
  assert.equal(calls.execute.length, 1);
  assert.equal(queue.get(task.id).status, 'completed');
  assert.equal(queue.get(task.id).quotaResetAt, null);
});

test('quota-available polling honors an earlier reset but rechecks a stale prediction every thirty seconds', async t => {
  const { queue, calls, advance, now } = await harness(t, {
    async getQuota() { return { allowed: false, resetAt: new Date(BASE + 10_000).toISOString() }; },
  });
  const task = await queue.create(input({ sendMode: 'quota_available' }));
  await queue.tick();
  assert.equal(queue.get(task.id).nextAttemptAt, new Date(BASE + 10_000).toISOString());
  advance(10_000);
  await queue.tick();
  assert.equal(Date.parse(queue.get(task.id).nextAttemptAt) - now(), 30_000);
  assert.equal(calls.execute.length, 0);
});

test('quota-available mode never sends on unknown quota and automatically recovers from quota read errors', async t => {
  let checks = 0;
  const { queue, calls, advance } = await harness(t, {
    async getQuota() {
      checks++;
      if (checks === 1) return null;
      if (checks === 2) return { allowed: undefined };
      if (checks === 3) throw new Error('Quota service is temporarily disconnected.');
      return { allowed: true };
    },
  });
  const task = await queue.create(input({ sendMode: 'quota_available' }));
  for (let index = 0; index < 3; index++) {
    await queue.tick();
    assert.equal(queue.get(task.id).status, 'waiting_quota');
    assert.equal(queue.get(task.id).attempts, 0);
    assert.equal(calls.execute.length, 0);
    advance(30_000);
  }
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'completed');
  assert.equal(calls.execute.length, 1);
});

test('send modes are validated and switching to scheduled mode requires a new explicit send time', async t => {
  const { queue, advance } = await harness(t);
  for (const sendMode of ['', null, false, 'quota', 'immediate']) await assert.rejects(queue.create(input({ sendMode })), /sendMode/);
  await assert.rejects(queue.create(input({ sendMode: 'scheduled', runAt: undefined })), /runAt/);
  const task = await queue.create(input({ sendMode: 'quota_available' }));
  advance(5_000);
  await assert.rejects(queue.update(task.id, { sendMode: 'scheduled' }), /runAt/);
  await assert.rejects(queue.update(task.id, { sendMode: 'scheduled', runAt: 'invalid' }), /runAt/);
  await assert.rejects(queue.update(task.id, { sendMode: 'other' }), /sendMode/);
  assert.equal(queue.get(task.id).sendMode, 'quota_available');
  const updated = await queue.update(task.id, { sendMode: 'scheduled', runAt: new Date(BASE + 60_000).toISOString() });
  assert.equal(updated.sendMode, 'scheduled');
  assert.equal(updated.nextAttemptAt, new Date(BASE + 60_000).toISOString());
});

test('a paused task edited to quota-available persists its mode and resumes once without duplicates', async t => {
  const { queue, adapter, storePath, now, advance, calls } = await harness(t);
  const task = await queue.create(input({ runAt: new Date(BASE + 3_600_000).toISOString() }));
  await queue.pause(task.id);
  advance(10_000);
  const edited = await queue.update(task.id, { sendMode: 'quota_available', prompt: 'Send after recovery.', runAt: undefined });
  assert.equal(edited.status, 'paused');
  assert.equal(edited.runAt, new Date(BASE + 10_000).toISOString());
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  await reopened.tick();
  assert.equal(calls.execute.length, 0);
  assert.equal(reopened.get(task.id).sendMode, 'quota_available');
  await reopened.resume(task.id);
  await Promise.all([reopened.tick(), reopened.tick()]);
  await reopened.tick();
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.execute[0].prompt, 'Send after recovery.');
  assert.equal(reopened.get(task.id).status, 'completed');
  await reopened.stop();
});

test('quota-available retry retains its mode and quota freshness after reload', async t => {
  let allowed = false;
  let sends = 0;
  const optionsSeen = [];
  const { queue, adapter, storePath, now, advance } = await harness(t, {
    async getQuota(model, options) { optionsSeen.push(options); return { allowed }; },
    async execute() { sends++; return { status: sends === 1 ? 'failed' : 'completed' }; },
  });
  const task = await queue.create(input({ sendMode: 'quota_available' }));
  await queue.tick();
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  allowed = true;
  advance(30_000);
  await reopened.tick();
  assert.equal(reopened.get(task.id).status, 'failed');
  assert.equal(sends, 1);
  const retried = await reopened.retry(task.id);
  assert.equal(retried.sendMode, 'quota_available');
  await reopened.tick();
  await reopened.tick();
  assert.equal(reopened.get(task.id).status, 'completed');
  assert.equal(sends, 2);
  assert.ok(optionsSeen.every(options => options?.refresh === true));
  await reopened.stop();
});

test('legacy tasks without a send mode retain scheduled timing after reload', async t => {
  const { queue, adapter, storePath, now, advance, calls } = await harness(t);
  const task = await queue.create(input({ runAt: new Date(BASE + 60_000).toISOString() }));
  const stored = JSON.parse(await readFile(storePath, 'utf8'));
  delete stored.tasks[0].sendMode;
  delete stored.tasks[0].quotaResetAt;
  await writeFile(storePath, JSON.stringify(stored));
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  await reopened.tick();
  assert.equal(calls.execute.length, 0);
  advance(60_000);
  await reopened.tick();
  assert.equal(reopened.get(task.id).status, 'completed');
  assert.equal(calls.execute.length, 1);
  await reopened.stop();
});

test('quota-available mode preserves per-conversation order across a quota wait', async t => {
  let allowed = false;
  const { queue, calls, advance } = await harness(t, { async getQuota() { return { allowed }; } });
  const first = await queue.create(input({ sendMode: 'quota_available', prompt: 'First' }));
  advance(1);
  const second = await queue.create(input({ sendMode: 'quota_available', prompt: 'Second' }));
  await queue.tick();
  assert.equal(queue.get(first.id).status, 'waiting_quota');
  assert.equal(queue.get(second.id).status, 'scheduled');
  allowed = true;
  advance(30_000);
  await queue.tick();
  assert.deepEqual(calls.execute.map(task => task.prompt), ['First']);
  await queue.tick();
  assert.deepEqual(calls.execute.map(task => task.prompt), ['First', 'Second']);
});

test('a quota-available task with a durable acknowledgement reconciles after reload without resending', async t => {
  let sends = 0;
  const { queue, adapter, storePath, now } = await harness(t, {
    async execute(task, { onSubmitted }) { sends++; await onSubmitted(desktopReceipt()); return { status: 'running' }; },
    async reconcile() { return { status: 'completed', turnId: 'existing-turn' }; },
  });
  const task = await queue.create(input({ sendMode: 'quota_available' }));
  await queue.tick();
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  await reopened.tick();
  assert.equal(reopened.get(task.id).sendMode, 'quota_available');
  assert.equal(reopened.get(task.id).status, 'completed');
  assert.equal(sends, 1);
  await reopened.stop();
});

test('busy conversations wait and execute once idle', async t => {
  let busy = true;
  const { queue, calls, advance } = await harness(t, { async getThreadState(task) { return { busy, archived: false, cwd: task.projectPath }; } });
  const task = await queue.create(input());
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'waiting_thread');
  assert.equal(calls.execute.length, 0);
  busy = false;
  advance(5_000);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'completed');
});

test('earlier quota-waiting tasks prevent overtaking in the same conversation', async t => {
  let allowed = false;
  const { queue, calls, advance } = await harness(t, { async getQuota() { return { allowed, resetAt: new Date(BASE + 10_000).toISOString() }; } }, { maxConcurrent: 3 });
  const first = await queue.create(input({ prompt: 'First' }));
  const second = await queue.create(input({ prompt: 'Second' }));
  await queue.tick();
  assert.equal(queue.get(first.id).status, 'waiting_quota');
  assert.equal(queue.get(second.id).status, 'scheduled');
  allowed = true;
  advance(10_000);
  await queue.tick();
  assert.deepEqual(calls.execute.map(task => task.prompt), ['First']);
  await queue.tick();
  assert.deepEqual(calls.execute.map(task => task.prompt), ['First', 'Second']);
});

test('conversation order follows send time even when the future task was created first', async t => {
  const { queue, calls } = await harness(t);
  await queue.create(input({ prompt: 'Future first', runAt: new Date(BASE + 600_000).toISOString() }));
  await queue.create(input({ prompt: 'Due second' }));
  await queue.tick();
  assert.deepEqual(calls.execute.map(task => task.prompt), ['Due second']);
});

test('different conversations execute concurrently within the configured limit', async t => {
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { queue } = await harness(t, {
    async execute(task, { onTurnStarted }) {
      active++;
      peak = Math.max(peak, active);
      await onTurnStarted(`turn-${task.id}`);
      if (active === 2) release();
      await gate;
      active--;
      return { status: 'completed' };
    },
  }, { maxConcurrent: 2 });
  await queue.create(input());
  await queue.create(input({ threadId: 'thread-2' }));
  await queue.create(input({ threadId: 'thread-3' }));
  await queue.tick();
  assert.equal(peak, 2);
  assert.equal(queue.list().filter(task => task.status === 'completed').length, 3);
});

test('a busy conversation cannot starve unrelated due tasks', async t => {
  const { queue, calls } = await harness(t, {
    async getThreadState(task) { return { busy: task.threadId === 'busy', archived: false, cwd: task.projectPath }; },
  });
  const busy = await queue.create(input({ threadId: 'busy' }));
  const ready = await queue.create(input({ threadId: 'ready' }));
  await queue.tick();
  assert.equal(queue.get(busy.id).status, 'waiting_thread');
  assert.equal(queue.get(ready.id).status, 'completed');
  assert.deepEqual(calls.execute.map(task => task.threadId), ['ready']);
});

test('prompt leading and trailing whitespace is preserved exactly', async t => {
  const { queue, calls, storePath } = await harness(t);
  const prompt = '\n    def example():\n        return 1\n\n';
  await queue.create(input({ prompt }));
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).tasks[0].prompt, prompt);
  await queue.tick();
  assert.equal(calls.execute[0].prompt, prompt);
});

test('a queued candidate moved into the future during another send is not dispatched early', async t => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const startedPromise = new Promise(resolve => { started = resolve; });
  const sends = [];
  const { queue } = await harness(t, {
    async execute(task) {
      sends.push(task.threadId);
      started();
      await gate;
      return { status: 'completed' };
    },
  });
  await queue.create(input({ threadId: 'first' }));
  const second = await queue.create(input({ threadId: 'second' }));
  const ticking = queue.tick();
  await startedPromise;
  try { await queue.update(second.id, { runAt: new Date(BASE + 600_000).toISOString() }); }
  finally { release(); await ticking; }
  assert.deepEqual(sends, ['first']);
  assert.equal(queue.get(second.id).status, 'scheduled');
});

test('pausing blocks later messages; cancellation releases that conversation', async t => {
  const { queue, calls } = await harness(t);
  const first = await queue.create(input({ prompt: 'First' }));
  await queue.create(input({ prompt: 'Second' }));
  await queue.pause(first.id);
  await queue.tick();
  assert.equal(calls.execute.length, 0);
  await queue.cancel(first.id);
  await queue.tick();
  assert.equal(queue.get(first.id).status, 'cancelled');
  assert.deepEqual(calls.execute.map(task => task.prompt), ['Second']);
});

test('resuming a paused due task schedules it immediately', async t => {
  const { queue, advance } = await harness(t);
  const task = await queue.create(input());
  await queue.pause(task.id);
  advance(60_000);
  await queue.resume(task.id);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'completed');
});

test('archived conversations and mismatched project directories fail before sending', async t => {
  const { queue, calls } = await harness(t, {
    async getThreadState(task) { return task.threadId === 'archived' ? { busy: false, archived: true } : { busy: false, archived: false, cwd: 'C:\\Other' }; },
  });
  const archived = await queue.create(input({ threadId: 'archived' }));
  const wrongProject = await queue.create(input({ threadId: 'wrong-project' }));
  await queue.tick();
  await queue.tick();
  assert.equal(queue.get(archived.id).status, 'failed');
  assert.match(queue.get(archived.id).lastError, /archived/);
  assert.match(queue.get(wrongProject.id).lastError, /different project/);
  assert.equal(calls.execute.length, 0);
});

test('Windows project directory comparison ignores casing and trailing separators', async t => {
  const { queue } = await harness(t, { async getThreadState() { return { busy: false, archived: false, cwd: 'c:\\projects\\example\\' }; } });
  const task = await queue.create(input());
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'completed');
});

test('a validated assigned worktree execution path persists and accepts its conversation cwd', async t => {
  const executionPath = 'C:\\Managed\\Example-worktree';
  const { queue, adapter, storePath, now, calls } = await harness(t, {
    async getThreadState() { return { busy: false, archived: false, cwd: executionPath }; },
  });
  const task = await queue.create(input({ executionPath }));
  assert.equal(task.projectPath, 'C:\\Projects\\Example');
  assert.equal(task.executionPath, executionPath);
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  assert.equal(reopened.get(task.id).executionPath, executionPath);
  await reopened.tick();
  assert.equal(reopened.get(task.id).status, 'completed');
  assert.equal(calls.execute[0].projectPath, 'C:\\Projects\\Example');
  assert.equal(calls.execute[0].executionPath, executionPath);
});

test('a worktree cwd without a validated execution path is still rejected', async t => {
  const { queue, calls } = await harness(t, {
    async getThreadState() { return { busy: false, archived: false, cwd: 'C:\\Managed\\Unassigned-worktree' }; },
  });
  const task = await queue.create(input());
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'failed');
  assert.equal(calls.execute.length, 0);
});

test('updating an execution path validates it and preserves the selected project root', async t => {
  const { queue } = await harness(t);
  const task = await queue.create(input());
  await assert.rejects(queue.update(task.id, { executionPath: 'relative/worktree' }), /absolute/);
  const updated = await queue.update(task.id, { executionPath: 'C:\\Managed\\Validated-worktree' });
  assert.equal(updated.projectPath, task.projectPath);
  assert.equal(updated.executionPath, 'C:\\Managed\\Validated-worktree');
});

test('generic state and quota errors fail without automatic retries', async t => {
  let quotaCalls = 0;
  const { queue, calls, advance } = await harness(t, { async getQuota() { quotaCalls++; throw new Error('Connection refused'); } });
  const task = await queue.create(input());
  await queue.tick();
  advance(3_600_000);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'failed');
  assert.equal(quotaCalls, 1);
  assert.equal(calls.execute.length, 0);
});

test('dispatch intent is durable before execute and turn IDs are durable inside callback', async t => {
  let storePath;
  const { queue, storePath: file } = await harness(t, {
    async execute(task, { onTurnStarted }) {
      const intent = JSON.parse(await readFile(storePath, 'utf8')).tasks[0];
      assert.equal(intent.status, 'running');
      assert.equal(intent.dispatchState, 'intent');
      assert.equal(intent.attempts, 1);
      await onTurnStarted('real-turn-id');
      const submitted = JSON.parse(await readFile(storePath, 'utf8')).tasks[0];
      assert.equal(submitted.turnId, 'real-turn-id');
      assert.equal(submitted.dispatchState, 'submitted');
      return { status: 'completed', turnId: 'real-turn-id' };
    },
  });
  storePath = file;
  await queue.create(input());
  await queue.tick();
});

test('desktop acknowledgement is durable and remains running until the accepted turn is read back', async t => {
  let storePath;
  const receipt = desktopReceipt();
  let sends = 0;
  const { queue, storePath: file } = await harness(t, {
    async execute(task, { onSubmitted }) {
      sends++;
      await onSubmitted(receipt);
      const persisted = JSON.parse(await readFile(storePath, 'utf8')).tasks[0];
      assert.equal(persisted.status, 'running');
      assert.equal(persisted.turnId, null);
      assert.equal(persisted.dispatchState, 'submitted');
      assert.deepEqual(persisted.submissionReceipt, receipt);
      receipt.native.changedAfterCallback = true;
      return { status: 'running' };
    },
  });
  storePath = file;
  const task = await queue.create(input());
  await queue.tick();
  assert.equal(sends, 1);
  const final = queue.get(task.id);
  assert.equal(final.status, 'running');
  assert.equal(final.turnId, null);
  assert.equal(final.submissionReceipt.native.changedAfterCallback, undefined);
  assert.equal(final.nextAttemptAt, new Date(BASE + 5_000).toISOString());
});

test('a running execute result can carry its persisted desktop submission receipt', async t => {
  const receipt = desktopReceipt();
  const { queue, storePath } = await harness(t, { async execute() { return { status: 'running', submissionReceipt: receipt }; } });
  const task = await queue.create(input());
  await queue.tick();
  receipt.knownTurnIds.push('changed-outside-the-queue');
  assert.equal(queue.get(task.id).status, 'running');
  assert.deepEqual(queue.get(task.id).submissionReceipt.knownTurnIds, ['previous-turn']);
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).tasks[0].dispatchState, 'submitted');
});

test('acknowledged desktop work is reconciled after restart and polling never resends it', async t => {
  let sends = 0;
  let reconciliations = 0;
  let completed = false;
  const { queue, adapter, storePath, now, advance } = await harness(t, {
    async execute(task, { onSubmitted }) { sends++; await onSubmitted(desktopReceipt()); return { status: 'running' }; },
    async reconcile(task) {
      reconciliations++;
      assert.equal(task.submissionReceipt.transport, 'codex-desktop');
      return completed ? { status: 'completed', turnId: 'accepted-desktop-turn', output: 'Read-back result.' } : { status: 'running' };
    },
  });
  const task = await queue.create(input());
  await queue.tick();
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  assert.equal(reopened.get(task.id).status, 'running');
  assert.equal(reconciliations, 1);
  for (let i = 0; i < 3; i++) { advance(5_000); await reopened.tick(); }
  assert.equal(reconciliations, 4);
  assert.equal(sends, 1);
  completed = true;
  advance(5_000);
  await reopened.tick();
  assert.equal(reopened.get(task.id).status, 'completed');
  assert.equal(reopened.get(task.id).turnId, 'accepted-desktop-turn');
  assert.equal(reopened.get(task.id).result, 'Read-back result.');
  assert.equal(sends, 1);
});

test('running without a turn ID or desktop receipt remains uncertain instead of authorizing polling or resend', async t => {
  let sends = 0;
  let reconciliations = 0;
  const { queue, advance } = await harness(t, {
    async execute() { sends++; return { status: 'running' }; },
    async reconcile() { reconciliations++; return { status: 'completed' }; },
  });
  const task = await queue.create(input());
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'needs_review');
  advance(5_000);
  await queue.tick();
  assert.equal(sends, 1);
  assert.equal(reconciliations, 0);
});

test('an execute running result with a confirmed turn ID is polled without resending', async t => {
  let sends = 0;
  const { queue, advance } = await harness(t, {
    async execute(task, { onTurnStarted }) { sends++; await onTurnStarted('live-turn'); return { status: 'running' }; },
    async reconcile() { return { status: 'completed', turnId: 'live-turn' }; },
  });
  const task = await queue.create(input());
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'running');
  advance(5_000);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'completed');
  assert.equal(sends, 1);
});

test('manual retry clears a previous desktop acknowledgement before another dispatch', async t => {
  const { queue } = await harness(t, {
    async execute(task, { onSubmitted }) { await onSubmitted(desktopReceipt()); return { status: 'needs_review', error: 'Review the accepted request.' }; },
  });
  const task = await queue.create(input());
  await queue.tick();
  await assert.rejects(queue.retry(task.id), /duplicate risk/);
  const retried = await queue.retry(task.id, { acknowledgeDuplicateRisk: true });
  assert.equal(retried.submissionReceipt, null);
  assert.equal(retried.dispatchState, null);
});

test('retry clears legacy pre-send diagnostics so a successful retry cannot still appear unsent', async t => {
  const { queue, adapter, storePath, now } = await harness(t, { async execute() { return { status: 'failed', error: 'Previous send failed.' }; } });
  const task = await queue.create(input());
  await queue.tick();
  const stored = JSON.parse(await readFile(storePath, 'utf8'));
  stored.tasks[0].deliveryState = 'not_sent';
  stored.tasks[0].failureStage = 'thread/resume';
  await writeFile(storePath, JSON.stringify(stored));
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  const retried = await reopened.retry(task.id);
  assert.equal(retried.deliveryState, undefined);
  assert.equal(retried.failureStage, undefined);
  const persisted = JSON.parse(await readFile(storePath, 'utf8')).tasks[0];
  assert.equal('deliveryState' in persisted, false);
  assert.equal('failureStage' in persisted, false);
});

test('a waiting status after desktop acknowledgement cannot put an accepted request back into the send queue', async t => {
  for (const status of ['waiting_thread', 'waiting_quota']) {
    let sends = 0;
    const { queue, advance } = await harness(t, {
      async execute(task, { onSubmitted }) { sends++; await onSubmitted(desktopReceipt()); return { status: 'running' }; },
      async reconcile() { return { status, error: 'Native request is still waiting.' }; },
    });
    const task = await queue.create(input());
    await queue.tick();
    advance(5_000);
    await queue.tick();
    assert.equal(queue.get(task.id).status, 'needs_review', status);
    assert.equal(queue.get(task.id).submissionReceipt.transport, 'codex-desktop');
    advance(60_000);
    await queue.tick();
    assert.equal(sends, 1);
  }
});

test('a uniquely associated native quota rejection with no work can submit one later attempt after reset', async t => {
  let sends = 0;
  const resetAt = new Date(BASE + 60_000).toISOString();
  const firstReceipt = desktopReceipt({ knownItemIds: ['prior-item'], native: { threadId: 'thread-1' } });
  const rejectedReceipt = { ...firstReceipt, native: { threadId: 'thread-1', turnId: 'quota-rejected-turn' } };
  const { queue, advance, storePath } = await harness(t, {
    async execute(task, { onSubmitted }) {
      sends++;
      await onSubmitted(sends === 1 ? firstReceipt : desktopReceipt({ knownTurnIds: ['previous-turn', 'quota-rejected-turn'], native: { threadId: 'thread-1' } }));
      return { status: 'running' };
    },
    async reconcile() {
      return sends === 1
        ? { status: 'waiting_quota', turnId: 'quota-rejected-turn', submissionReceipt: rejectedReceipt, confirmedNoWork: true, output: '', retryAt: resetAt }
        : { status: 'completed', turnId: 'completed-second-turn', output: 'Completed after quota recovery.' };
    },
  });
  const task = await queue.create(input());
  await queue.tick();
  assert.equal(sends, 1);
  advance(5_000);
  await queue.tick();
  const waiting = queue.get(task.id);
  assert.equal(waiting.status, 'waiting_quota');
  assert.equal(waiting.turnId, null);
  assert.equal(waiting.submissionReceipt, null);
  assert.deepEqual(waiting.lastRejectedSubmission, rejectedReceipt);
  assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).tasks[0].lastRejectedSubmission, rejectedReceipt);
  advance(54_999);
  await queue.tick();
  assert.equal(sends, 1);
  advance(1);
  await queue.tick();
  assert.equal(sends, 2);
  assert.equal(queue.get(task.id).status, 'running');
  advance(5_000);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'completed');
  assert.equal(queue.get(task.id).turnId, 'completed-second-turn');
  assert.equal(queue.get(task.id).attempts, 2);
  assert.deepEqual(queue.get(task.id).lastRejectedSubmission, rejectedReceipt);
  await queue.tick();
  assert.equal(sends, 2);
});

test('native quota retry requires exact turn association, explicit no-work proof and no output', async t => {
  const valid = {
    status: 'waiting_quota', turnId: 'rejected-turn', confirmedNoWork: true, output: '',
    submissionReceipt: desktopReceipt({ native: { threadId: 'thread-1', turnId: 'rejected-turn' } }),
  };
  for (const change of [
    { confirmedNoWork: false },
    { confirmedNoWork: undefined },
    { turnId: undefined },
    { submissionReceipt: desktopReceipt({ native: { threadId: 'thread-1', turnId: 'different-turn' } }) },
    { output: 'Partial work already produced.' },
    { output: { completedStep: 1 } },
    { status: 'waiting_thread' },
  ]) {
    let sends = 0;
    const { queue, advance } = await harness(t, {
      async execute(task, { onSubmitted }) { sends++; await onSubmitted(desktopReceipt()); return { status: 'running' }; },
      async reconcile() { return { ...valid, ...change }; },
    });
    const task = await queue.create(input());
    await queue.tick();
    advance(5_000);
    await queue.tick();
    assert.equal(queue.get(task.id).status, 'needs_review', JSON.stringify(change));
    assert.ok(queue.get(task.id).submissionReceipt);
    assert.equal(queue.get(task.id).lastRejectedSubmission, null);
    advance(60_000);
    await queue.tick();
    assert.equal(sends, 1);
  }
});

test('a later empty native quota result cannot erase earlier partial work to authorize an automatic resend', async t => {
  let polls = 0;
  const receipt = desktopReceipt({ native: { threadId: 'thread-1', turnId: 'partial-turn' } });
  const { queue, advance } = await harness(t, {
    async execute(task, { onSubmitted }) { await onSubmitted(receipt); return { status: 'running' }; },
    async reconcile() {
      polls++;
      return polls === 1
        ? { status: 'running', turnId: 'partial-turn', output: 'A step has already completed.' }
        : { status: 'waiting_quota', turnId: 'partial-turn', output: '', confirmedNoWork: true };
    },
  });
  const task = await queue.create(input());
  await queue.tick();
  advance(5_000);
  await queue.tick();
  advance(5_000);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'needs_review');
  assert.ok(queue.get(task.id).submissionReceipt);
  assert.equal(queue.get(task.id).lastRejectedSubmission, null);
});

test('manual retry clears the rejected native submission audit receipt', async t => {
  const receipt = desktopReceipt({ native: { threadId: 'thread-1', turnId: 'rejected-turn' } });
  const { queue, advance } = await harness(t, {
    async execute(task, { onSubmitted }) { await onSubmitted(receipt); return { status: 'running' }; },
    async reconcile() { return { status: 'waiting_quota', turnId: 'rejected-turn', confirmedNoWork: true }; },
    async getQuota() { return { allowed: true }; },
  });
  const task = await queue.create(input());
  await queue.tick();
  advance(5_000);
  await queue.tick();
  assert.ok(queue.get(task.id).lastRejectedSubmission);
  // A later preflight error is a normal manual-retry state.
  queue.adapter.getThreadState = async () => { throw new Error('Project temporarily unavailable.'); };
  advance(60_000);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'failed');
  const retried = await queue.retry(task.id);
  assert.equal(retried.lastRejectedSubmission, null);
});

test('invalid submission receipts cannot establish that a request is safely running', async t => {
  for (const receipt of [[], desktopReceipt({ transport: 'unknown' }), desktopReceipt({ acknowledgedAt: '2026-10-20T12:00:00' }), desktopReceipt({ knownTurnIds: 'not-an-array' })]) {
    const { queue } = await harness(t, { async execute() { return { status: 'running', submissionReceipt: receipt }; } });
    const task = await queue.create(input());
    await queue.tick();
    assert.equal(queue.get(task.id).status, 'needs_review');
    assert.equal(queue.get(task.id).submissionReceipt, null);
  }
});

test('transport errors after dispatch require review and block later sends', async t => {
  let sends = 0;
  const { queue } = await harness(t, { async execute() { sends++; throw new Error('Socket disconnected'); } });
  const first = await queue.create(input());
  await queue.create(input({ prompt: 'Second' }));
  await queue.tick();
  await queue.tick();
  assert.equal(queue.get(first.id).status, 'needs_review');
  assert.equal(sends, 1);
  await assert.rejects(queue.retry(first.id), /acknowledge duplicate risk/);
  await queue.retry(first.id, { acknowledgeDuplicateRisk: true });
  assert.equal(queue.get(first.id).status, 'scheduled');
});

test('confirmed failed turns require manual retry', async t => {
  let sends = 0;
  const { queue } = await harness(t, { async execute() { sends++; return sends === 1 ? { status: 'failed', error: 'Model rejected this turn.' } : { status: 'completed' }; } });
  const task = await queue.create(input());
  await queue.tick();
  await queue.tick();
  assert.equal(sends, 1);
  await queue.retry(task.id);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'completed');
  assert.equal(queue.get(task.id).attempts, 2);
});

test('an explicit post-dispatch quota failure queues a later attempt', async t => {
  let sends = 0;
  const { queue, advance } = await harness(t, {
    async execute(task, { onTurnStarted }) {
      sends++;
      await onTurnStarted(`attempt-${sends}`);
      return sends === 1 ? { status: 'waiting_quota', error: 'Usage limit', retryAt: new Date(BASE + 60_000).toISOString() } : { status: 'completed', turnId: 'attempt-2' };
    },
  });
  const task = await queue.create(input());
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'waiting_quota');
  advance(60_000);
  await queue.tick();
  assert.equal(queue.get(task.id).status, 'completed');
  assert.equal(sends, 2);
});

async function makeRunningStore(queue, storePath, fields = {}) {
  const task = await queue.create(input());
  const data = JSON.parse(await readFile(storePath, 'utf8'));
  Object.assign(data.tasks[0], { status: 'running', attempts: 1, dispatchState: 'intent', dispatchStartedAt: new Date(BASE).toISOString(), nextAttemptAt: null }, fields);
  await writeFile(storePath, JSON.stringify(data));
  return task;
}

test('restart reconciles a completed submitted turn without a duplicate send', async t => {
  const { queue, adapter, storePath, calls, now } = await harness(t, {
    async reconcile(task) { calls.reconcile.push(task); return { status: 'completed', turnId: task.turnId, output: 'Recovered answer' }; },
  });
  const task = await makeRunningStore(queue, storePath, { turnId: 'existing-turn', dispatchState: 'submitted' });
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  await reopened.tick();
  assert.equal(calls.reconcile.length, 1);
  assert.equal(calls.execute.length, 0);
  assert.equal(reopened.get(task.id).status, 'completed');
  assert.equal(reopened.get(task.id).result, 'Recovered answer');
});

test('restart with ambiguous dispatch intent never blindly resubmits', async t => {
  const { queue, adapter, storePath, calls, now } = await harness(t);
  const task = await makeRunningStore(queue, storePath);
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  await reopened.tick();
  assert.equal(reopened.get(task.id).status, 'needs_review');
  assert.equal(calls.execute.length, 0);
});

test('recovered turns still running are polled read-only until completed', async t => {
  let checks = 0;
  const { queue, adapter, storePath, calls, now, advance } = await harness(t, {
    async reconcile() { checks++; return { status: checks < 2 ? 'running' : 'completed', turnId: 'live-turn' }; },
  });
  const task = await makeRunningStore(queue, storePath, { turnId: 'live-turn' });
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await reopened.initialize();
  assert.equal(reopened.get(task.id).status, 'running');
  await reopened.tick();
  assert.equal(checks, 1);
  advance(5_000);
  await reopened.tick();
  assert.equal(checks, 2);
  assert.equal(reopened.get(task.id).status, 'completed');
  assert.equal(calls.execute.length, 0);
});

test('running tasks cannot be paused, cancelled, edited or manually resent', async t => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const startedPromise = new Promise(resolve => { started = resolve; });
  const { queue } = await harness(t, {
    async execute(task, { onTurnStarted }) {
      await onTurnStarted('running-turn');
      started();
      await gate;
      return { status: 'completed' };
    },
  });
  const task = await queue.create(input());
  const ticking = queue.tick();
  await startedPromise;
  try {
    await assert.rejects(queue.pause(task.id), /running/);
    await assert.rejects(queue.cancel(task.id), /running/);
    await assert.rejects(queue.update(task.id, { prompt: 'Changed' }), /running/);
    await assert.rejects(queue.retry(task.id), /running/);
  } finally { release(); await ticking; }
});

test('stop lets the active turn finish but does not admit another due conversation', async t => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const startedPromise = new Promise(resolve => { started = resolve; });
  const sends = [];
  const { queue } = await harness(t, {
    async execute(task) {
      sends.push(task.threadId);
      started();
      await gate;
      return { status: 'completed' };
    },
  });
  const first = await queue.create(input({ threadId: 'first' }));
  const second = await queue.create(input({ threadId: 'second' }));
  const ticking = queue.tick();
  await startedPromise;
  const stopping = queue.stop();
  release();
  await Promise.all([ticking, stopping]);
  assert.deepEqual(sends, ['first']);
  assert.equal(queue.get(first.id).status, 'completed');
  assert.equal(queue.get(second.id).status, 'scheduled');
  await queue.tick();
  assert.deepEqual(sends, ['first']);
});

test('stop during quota evaluation prevents sending any new turn', async t => {
  let release;
  let checking;
  const gate = new Promise(resolve => { release = resolve; });
  const checkingPromise = new Promise(resolve => { checking = resolve; });
  const { queue, calls } = await harness(t, {
    async getQuota() { checking(); await gate; return { allowed: true }; },
  });
  const task = await queue.create(input());
  const ticking = queue.tick();
  await checkingPromise;
  const stopping = queue.stop();
  release();
  await Promise.all([ticking, stopping]);
  assert.equal(calls.execute.length, 0);
  assert.equal(queue.get(task.id).status, 'scheduled');
  assert.equal(queue.get(task.id).attempts, 0);
});

test('rejects invalid scheduling inputs and preserves explicit timezone requirements', async t => {
  const { queue } = await harness(t);
  for (const bad of [
    { runAt: '2026-10-20T12:00:00' },
    { runAt: '2026-02-30T12:00:00+08:00' },
    { runAt: '2026-10-20T24:00:00Z' },
    { projectPath: 'relative/path' },
    { executionPath: 'relative/worktree' },
    { executionPath: '' },
    { sourceThreadId: 'not-a-uuid' },
    { sourceThreadId: '' },
    { prompt: '   ' },
    { threadId: '' },
    { model: '' },
    { timeZone: 'Invalid/Zone' },
    { effort: 'automatic-unlimited' },
  ]) await assert.rejects(queue.create(input(bad)));
  assert.equal(queue.list().length, 0);
});

test('updates validate fields and reset a pending task for the new schedule', async t => {
  const { queue } = await harness(t, { async getQuota() { return { allowed: false }; } });
  const task = await queue.create(input());
  await queue.tick();
  const updated = await queue.update(task.id, { model: 'chosen-model', runAt: '2026-10-21T12:00:00+08:00' });
  assert.equal(updated.status, 'scheduled');
  assert.equal(updated.model, 'chosen-model');
  assert.equal(updated.nextAttemptAt, '2026-10-21T04:00:00.000Z');
  await assert.rejects(queue.update(task.id, { status: 'completed' }), /cannot be edited/);
});

test('a corrupt persistent store fails closed and is not overwritten', async t => {
  const { storePath, adapter, now } = await harness(t);
  const corrupt = '{not json';
  await writeFile(storePath, corrupt);
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await assert.rejects(reopened.initialize(), /Cannot safely read/);
  assert.equal(await readFile(storePath, 'utf8'), corrupt);
});

test('invalid task fields in a valid JSON store cannot bypass scheduling validation', async t => {
  const { queue, storePath, adapter, now } = await harness(t);
  await queue.create(input());
  const data = JSON.parse(await readFile(storePath, 'utf8'));
  data.tasks[0].runAt = 'not-a-time';
  const invalid = JSON.stringify(data);
  await writeFile(storePath, invalid);
  const reopened = new QueueManager({ storePath, adapter, clock: now });
  await assert.rejects(reopened.initialize(), /Invalid queue task/);
  assert.equal(await readFile(storePath, 'utf8'), invalid);
});

test('concurrent creates leave a complete valid persistent snapshot', async t => {
  const { queue, storePath } = await harness(t);
  await Promise.all(Array.from({ length: 20 }, (_, index) => queue.create(input({ threadId: `thread-${index}` }))));
  const persisted = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(queue.list().length, 20);
  assert.equal(persisted.tasks.length, 20);
  assert.equal(new Set(persisted.tasks.map(task => task.id)).size, 20);
});
