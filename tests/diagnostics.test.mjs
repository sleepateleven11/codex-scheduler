import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticsService } from '../src/diagnostics.mjs';

function fixture(overrides = {}, options = {}) {
  const calls = [];
  const adapter = {
    async subscriptionStatus() { calls.push('subscription'); return { ready: true, accountType: 'chatgpt', provider: 'openai' }; },
    async desktopStatus() { calls.push('status'); return { connected: true }; },
    async reconnectDesktop() { calls.push('reconnect'); return { connected: true }; },
    async projects() { calls.push('projects'); return [{ path: 'fixture' }]; },
    async models() { calls.push('models'); return [{ id: 'gpt-fixture' }]; },
    ...overrides,
  };
  const service = new DiagnosticsService({ adapter, platform: 'win32', nodeVersion: '22.1.0',
    findCodex: async () => 'fixture', findDesktopServer: async () => 'fixture', checkStorage: async () => {}, ...options });
  return { service, calls };
}

test('first-run self-test reads capabilities and shares concurrent probes without sending a message', async () => {
  const { service, calls } = fixture();
  const reports = await Promise.all([service.run(), service.run(), service.run()]);
  assert.ok(reports.every(report => report.ready));
  assert.equal(reports[0].checks.length, 10);
  assert.deepEqual(calls.sort(), ['models', 'projects', 'status', 'subscription']);
  reports[0].ready = false;
  assert.equal((await service.run()).ready, true);
});

test('new user without host registration is guided to load the plugin without fake credentials', async () => {
  const { service } = fixture({ async desktopStatus() { return { connected: false, message: 'private \\.\\pipe\\secret' }; } });
  const report = await service.run();
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(check => check.id === 'connection').status, 'fail');
  assert.match(report.checks.find(check => check.id === 'connection').message, /自动连接.*一键初始化/);
  assert.doesNotMatch(JSON.stringify(report), /secret|pipe/);
});

test('dependency, login and provider failures are isolated and never leak raw exceptions', async () => {
  const { service } = fixture({ async subscriptionStatus() { throw new Error('Authorization: Bearer PRIVATE'); }, async projects() { throw new Error('private-path'); } }, {
    nodeVersion: '20.0.0', findCodex: async () => { throw new Error('PRIVATE'); }, findDesktopServer: async () => { throw new Error('PRIVATE'); },
  });
  const report = await service.run();
  for (const id of ['node', 'codex', 'account', 'provider', 'desktop-tools', 'projects']) assert.equal(report.checks.find(check => check.id === id).status, 'fail');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|private-path|Authorization/);
});

test('manual recheck refreshes the host connection and leaves task creation outside the self-test', async () => {
  const { service, calls } = fixture();
  await service.run();
  await service.run({ reconnect: true, refresh: true });
  assert.equal(calls.filter(call => call === 'reconnect').length, 1);
  assert.equal(calls.filter(call => call === 'subscription').length, 2);
  assert.equal(calls.some(call => /send|create/i.test(call)), false);
});

test('recheck refreshes an empty model catalog after the user repairs provider configuration', async () => {
  let configured = false;
  const { service } = fixture({ async models(options) { assert.equal(options?.refresh, true); return configured ? [{ id: 'gpt-fixture' }] : []; } });
  assert.equal((await service.run()).ready, false);
  configured = true;
  assert.equal((await service.run({ refresh: true, reconnect: true })).ready, true);
});
