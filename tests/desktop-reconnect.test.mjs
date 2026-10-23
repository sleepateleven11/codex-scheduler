import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../src/codex-adapter.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('concurrent health reads share one read-only desktop probe', async t => {
  const gate = deferred();
  const calls = [];
  const desktop = { async close() {}, async callTool(name) { calls.push(name); await gate.promise; return {}; } };
  const adapter = new CodexAdapter({ client: { async close() {} }, desktopClient: desktop });
  t.after(() => adapter.close());
  const reads = [adapter.desktopStatus(), adapter.desktopStatus({ refresh: true }), adapter.desktopStatus()];
  gate.resolve();
  assert.deepEqual(await Promise.all(reads), [{ connected: true }, { connected: true }, { connected: true }]);
  assert.deepEqual(calls, ['list_projects']);
});

test('reconnect waits for an in-flight probe, closes once, refreshes registration and never sends messages', async t => {
  const oldProbe = deferred();
  const events = [];
  let calls = 0;
  const desktop = {
    async close() { events.push('close'); },
    async callTool(name) { events.push(name); calls++; if (calls === 1) { await oldProbe.promise; throw new Error('Old endpoint disconnected'); } return {}; },
  };
  const adapter = new CodexAdapter({ client: { async close() {} }, desktopClient: desktop });
  t.after(() => adapter.close());
  const stale = adapter.desktopStatus();
  const reconnects = [adapter.reconnectDesktop(), adapter.reconnectDesktop(), adapter.desktopStatus({ refresh: true })];
  oldProbe.resolve();
  assert.equal((await stale).connected, false);
  const results = await Promise.all(reconnects);
  for (const result of results) { assert.equal(result.connected, true); assert.match(result.message, /重新连接/); }
  assert.deepEqual(events, ['list_projects', 'close', 'list_projects']);
  assert.deepEqual(await adapter.desktopStatus(), { connected: true });
});

test('reconnect keeps a specific missing-registration error and leaves the queue untouched', async t => {
  const calls = [];
  const desktop = { async close() { calls.push('close'); }, async callTool(name) { calls.push(name); throw new Error('尚未登记 Codex 桌面连接。已有任务会保留。'); } };
  const adapter = new CodexAdapter({ client: { async close() {} }, desktopClient: desktop });
  t.after(() => adapter.close());
  assert.deepEqual(await adapter.reconnectDesktop(), { connected: false, message: '尚未登记 Codex 桌面连接。已有任务会保留。' });
  assert.deepEqual(calls, ['close', 'list_projects']);
});

test('an adapter with no desktop connector reports registration is needed without an RPC mutation', async () => {
  const adapter = new CodexAdapter({ client: { async close() {} }, desktopClient: null });
  assert.match((await adapter.reconnectDesktop()).message, /尚未登记/);
  await adapter.close();
});
