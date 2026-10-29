import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopConnectionManager, INITIALIZATION_URL, openCodexInitialization } from '../src/connection-manager.mjs';

const BASE = Date.parse('2026-10-29T00:00:00Z');
const offline = () => ({ connected: false, code: 'DESKTOP_NOT_CONNECTED' });
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t, { probe = offline, reconnect = offline, open = async () => {} } = {}) {
  let now = BASE;
  const calls = [];
  const adapter = {
    async desktopStatus(options) { calls.push(['probe', options]); return probe(); },
    async reconnectDesktop() { calls.push(['reconnect']); return reconnect(); },
  };
  const manager = new DesktopConnectionManager({ adapter, clock: () => now,
    openInitialization: async () => { calls.push(['open']); return open(); } });
  t.after(() => manager.stop());
  return { manager, calls, advance(ms) { now += ms; }, now: () => now,
    count(name) { return calls.filter(([kind]) => kind === name).length; } };
}

test('automatic checks back off at 3, 10 and 30 seconds without opening Codex or sending anything', async t => {
  const f = fixture(t);
  for (const [index, backoff] of [3000, 10000, 30000, 30000].entries()) {
    const result = await f.manager.check();
    assert.equal(f.count('probe'), index + 1);
    assert.equal(Date.parse(result.initialization.nextAttemptAt) - f.now(), backoff);
    assert.equal(result.desktop.connected, false);
    assert.equal(result.initialization.canInitialize, true);
    f.advance(backoff - 1);
    await f.manager.check();
    assert.equal(f.count('probe'), index + 1, 'polls inside backoff must share the cached failure');
    f.advance(1);
  }
  assert.equal(f.count('reconnect'), 0);
  assert.equal(f.count('open'), 0);
  assert.ok(f.calls.every(([name]) => name === 'probe'));
});

test('concurrent checks share one read-only in-flight probe, including a manual reconnect request', async t => {
  const gate = deferred();
  const f = fixture(t, { probe: () => gate.promise });
  const first = f.manager.check();
  const second = f.manager.check({ force: true });
  assert.equal(first, second);
  assert.equal(f.count('probe'), 1);
  assert.equal(f.count('reconnect'), 0);
  gate.resolve({ connected: true });
  assert.equal((await first).desktop.connected, true);
  assert.equal((await second).initialization.status, 'connected');
});

test('an explicit initialization opens once and waits for a real connection instead of treating launch as success', async t => {
  let connected = false;
  const f = fixture(t, { probe: () => ({ connected }) });
  const [first, second] = await Promise.all([f.manager.initialize(), f.manager.initialize()]);
  assert.equal(f.count('reconnect'), 1);
  assert.equal(f.count('open'), 1);
  assert.equal(first.desktop.connected, false);
  assert.equal(first.initialization.status, 'waiting');
  assert.equal(first.initialization.canInitialize, false);
  assert.deepEqual(first, second);
  assert.equal(Date.parse(first.initialization.deadlineAt) - f.now(), 60000);
  await f.manager.initialize();
  assert.equal(f.count('open'), 1, 'clicks while waiting must not open more native windows');
  await f.manager.check();
  assert.equal(Date.parse(f.manager.snapshot().initialization.nextAttemptAt) - f.now(), 2000);
  connected = true;
  f.advance(2000);
  const ready = await f.manager.check();
  assert.equal(ready.desktop.connected, true);
  assert.equal(ready.initialization.status, 'connected');
  assert.equal(ready.initialization.deadlineAt, null);
  assert.equal(ready.initialization.canInitialize, false);
  assert.equal(f.count('open'), 1);
});

test('initialization waits for an existing probe and skips opening the host when that probe establishes connection', async t => {
  const gate = deferred();
  const f = fixture(t, { probe: () => gate.promise });
  const probe = f.manager.check();
  const initialization = f.manager.initialize();
  assert.equal(f.count('open'), 0);
  gate.resolve({ connected: true });
  await probe;
  assert.equal((await initialization).desktop.connected, true);
  assert.equal(f.count('reconnect'), 0);
  assert.equal(f.count('open'), 0);
});

test('a newly registered desktop observed while the native opener is pending remains connected when it finishes', async t => {
  const opening = deferred();
  const started = deferred();
  const f = fixture(t, { probe: async () => ({ connected: true }), open: () => { started.resolve(); return opening.promise; } });
  const initialization = f.manager.initialize();
  await started.promise;
  assert.equal(f.count('open'), 1);
  await f.manager.check({ force: false });
  // Explicitly bypass the previous failed preflight cache to simulate a fresh
  // host registration while the OS launch request has not returned yet.
  f.advance(3000);
  const ready = await f.manager.check();
  assert.equal(ready.desktop.connected, true);
  opening.resolve();
  const result = await initialization;
  assert.equal(result.initialization.status, 'connected');
  assert.equal(result.desktop.connected, true);
  assert.equal(result.initialization.deadlineAt, null);
});

test('a native opener failure cannot overwrite a connection already established by the host', async t => {
  const opening = deferred(); const started = deferred();
  const f = fixture(t, { probe: async () => ({ connected: true }), open: () => { started.resolve(); return opening.promise; } });
  const initialization = f.manager.initialize();
  await started.promise;
  f.advance(3000);
  assert.equal((await f.manager.check()).desktop.connected, true);
  opening.reject(new Error('private launcher diagnostic'));
  const result = await initialization;
  assert.equal(result.desktop.connected, true);
  assert.equal(result.initialization.status, 'connected');
  assert.equal(result.initialization.canInitialize, false);
  assert.doesNotMatch(JSON.stringify(result), /private launcher/);
});

test('an initialization deadline enables a retry without emitting a false success or opening repeatedly', async t => {
  const f = fixture(t);
  await f.manager.initialize();
  f.advance(59999);
  assert.equal(f.manager.snapshot().initialization.status, 'waiting');
  assert.equal(f.manager.snapshot().initialization.canInitialize, false);
  f.advance(1);
  const expired = f.manager.snapshot();
  assert.equal(expired.initialization.status, 'error');
  assert.equal(expired.initialization.canInitialize, true);
  assert.equal(expired.desktop.connected, false);
  assert.match(expired.initialization.message, /初始化未完成/);
  await f.manager.initialize();
  assert.equal(f.count('open'), 2);
  assert.equal(f.manager.snapshot().initialization.status, 'waiting');
  assert.equal(Date.parse(f.manager.snapshot().initialization.deadlineAt) - f.now(), 60000);
});

test('a native launch failure is actionable and never leaks its raw environment or command', async t => {
  const secret = 'private-pipe-or-account-secret';
  const f = fixture(t, { open: async () => { throw new Error(secret); } });
  const result = await f.manager.initialize();
  assert.equal(result.desktop.connected, false);
  assert.equal(result.initialization.status, 'error');
  assert.equal(result.initialization.canInitialize, true);
  assert.equal(result.initialization.deadlineAt, null);
  assert.match(result.initialization.message, /无法打开初始化入口/);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('desktop probe exceptions and unknown status payloads fail closed without exposing private messages', async t => {
  const secret = 'sk-secret-private-account-and-pipe';
  let fail = true;
  const f = fixture(t, { probe: async () => {
    if (fail) throw new Error(secret);
    return { connected: 'true', code: secret, message: secret, pipePath: secret };
  } });
  let result = await f.manager.check();
  assert.equal(result.desktop.connected, false);
  assert.equal(result.desktop.code, 'DESKTOP_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes(secret));
  fail = false; f.advance(3000);
  result = await f.manager.check();
  assert.equal(result.desktop.connected, false);
  assert.equal(result.desktop.code, undefined);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('a healthy connection is retained for fifteen seconds and explicit initialization never opens a native window', async t => {
  const f = fixture(t, { probe: async () => ({ connected: true }), reconnect: async () => ({ connected: true }) });
  const ready = await f.manager.check();
  assert.equal(Date.parse(ready.initialization.nextAttemptAt) - f.now(), 15000);
  f.advance(14999);
  await f.manager.check();
  assert.equal(f.count('probe'), 1);
  await f.manager.initialize();
  assert.equal(f.count('reconnect'), 1);
  assert.equal(f.count('open'), 0);
  assert.equal(f.manager.snapshot().initialization.status, 'connected');
});

test('a failed health check after a connection is established resumes automatic retries', async t => {
  let connected = true;
  const f = fixture(t, { probe: async () => ({ connected }) });
  await f.manager.check();
  connected = false; f.advance(15000);
  const lost = await f.manager.check();
  assert.equal(lost.desktop.connected, false);
  assert.equal(lost.initialization.canInitialize, true);
  assert.equal(Date.parse(lost.initialization.nextAttemptAt) - f.now(), 3000);
  assert.equal(f.count('open'), 0);
});

test('stopping during a probe prevents late success and all later checks or initialization side effects', async t => {
  const gate = deferred();
  const f = fixture(t, { probe: () => gate.promise });
  const probe = f.manager.check();
  const stop = f.manager.stop();
  gate.resolve({ connected: true });
  await Promise.all([probe, stop]);
  const result = await f.manager.initialize();
  await f.manager.check({ force: true });
  assert.equal(result.desktop.connected, false);
  assert.equal(result.initialization.canInitialize, false);
  assert.equal(f.count('probe'), 1);
  assert.equal(f.count('reconnect'), 0);
  assert.equal(f.count('open'), 0);
});

test('stopping during the initialization preflight prevents the native opener from starting', async t => {
  const gate = deferred();
  const f = fixture(t, { reconnect: () => gate.promise });
  const initialization = f.manager.initialize();
  const stop = f.manager.stop();
  gate.resolve(offline());
  await Promise.all([initialization, stop]);
  assert.equal(f.count('open'), 0);
  assert.equal(f.manager.snapshot().initialization.canInitialize, false);
});

test('stopping during an already-started native launch drains it but never performs another probe or launch', async t => {
  const opening = deferred(); const started = deferred();
  const f = fixture(t, { open: () => { started.resolve(); return opening.promise; } });
  const initialization = f.manager.initialize();
  await started.promise;
  let stopped = false;
  const stop = f.manager.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  await f.manager.check({ force: true });
  const repeated = f.manager.initialize();
  assert.equal(repeated, initialization);
  assert.equal(f.count('reconnect'), 1);
  assert.equal(f.count('open'), 1);
  opening.resolve();
  await Promise.all([initialization, stop]);
  await f.manager.initialize();
  assert.equal(f.manager.snapshot().initialization.canInitialize, false);
  assert.equal(f.count('probe'), 0);
  assert.equal(f.count('reconnect'), 1);
  assert.equal(f.count('open'), 1);
});

test('starting automatic recovery is idempotent and stopping prevents a later start', async t => {
  const f = fixture(t);
  f.manager.start();
  f.manager.start();
  await f.manager.check();
  assert.equal(f.count('probe'), 1);
  assert.equal(f.count('open'), 0);
  assert.equal(f.count('reconnect'), 0);
  await f.manager.stop();
  f.manager.start();
  await f.manager.check({ force: true });
  assert.equal(f.count('probe'), 1);
  assert.equal(f.count('open'), 0);
});

test('snapshots are detached from internal state and expose a monotonically changing connection revision', async t => {
  const f = fixture(t);
  const first = f.manager.snapshot();
  first.desktop.connected = true;
  first.initialization.status = 'connected';
  assert.equal(f.manager.snapshot().desktop.connected, false);
  const checked = await f.manager.check();
  assert.ok(checked.initialization.revision > first.initialization.revision);
  const started = await f.manager.initialize();
  assert.ok(started.initialization.revision > checked.initialization.revision);
});

test('the Windows initializer opens only the fixed registered host route with no model input or local secrets', async () => {
  const invocations = [];
  for (let call = 0; call < 2; call++) await openCodexInitialization({ platform: 'win32', systemRoot: 'C:\\Windows', runCommand: async (...args) => { invocations.push(args); } });
  const reference = new URL(INITIALIZATION_URL);
  const nonces = invocations.map(([command, args, options]) => {
    assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    const match = args[4].match(/^\$ErrorActionPreference='Stop'; Start-Process -FilePath '([^']+)' -ErrorAction Stop$/);
    assert.ok(match, 'the native launch command may contain only the fixed protocol opener');
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 15000);
    const target = new URL(match[1]);
    assert.equal(target.protocol, reference.protocol);
    assert.equal(target.hostname, reference.hostname);
    assert.equal(target.pathname, reference.pathname);
    assert.equal(target.username, ''); assert.equal(target.password, '');
    assert.equal(target.port, ''); assert.equal(target.hash, '');
    assert.deepEqual([...target.searchParams.keys()], ['path']);
    const path = target.searchParams.get('path');
    const attempt = path.match(/^\/initialize\?attempt=([a-f0-9]{32})$/);
    assert.ok(attempt, 'each activation must carry only a fresh safe attempt nonce');
    assert.doesNotMatch(args[4], /(?:turn\/start|prompt=|token=|threadId=|pipe|WindowsApps)/i);
    return attempt[1];
  });
  assert.notEqual(nonces[0], nonces[1], 'native entrypoint reuse must receive a new activation identity');
});

test('the initializer removes runtime injection variables from a detached PowerShell environment without mutating its parent', async () => {
  const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', APPDATA: 'C:\\Example\\AppData\\Roaming',
    PSModulePath: 'C:\\InjectedModules', NODE_OPTIONS: '--require C:\\injected.cjs', NODE_PATH: 'C:\\InjectedNodeModules',
    CODEX_APP_TOOLS_PIPE_PATH: 'private-host-pipe', CODEX_THREAD_ID: 'private-source-thread', CODEX_TOOL_CALL_ID: 'private-call', CODEX_APP_TOOLS_CALLER_HOST_ID: 'private-host' };
  const before = structuredClone(env);
  let options;
  await openCodexInitialization({ platform: 'win32', systemRoot: 'C:\\Windows', env, runCommand: async (_command, _args, value) => { options = value; } });
  assert.ok(options.env && options.env !== env);
  const denied = ['psmodulepath', 'node_options', 'node_path', 'codex_app_tools_pipe_path', 'codex_thread_id', 'codex_tool_call_id', 'codex_app_tools_caller_host_id'];
  for (const key of Object.keys(options.env)) assert.ok(!denied.includes(key.toLowerCase()), key);
  assert.equal(options.env.SystemRoot, env.SystemRoot);
  assert.equal(options.env.PATH, env.PATH);
  assert.equal(options.env.APPDATA, env.APPDATA);
  assert.deepEqual(env, before);
});

test('unsupported platforms reject initialization before executing any process', async () => {
  await assert.rejects(openCodexInitialization({ platform: 'linux', runCommand: async () => assert.fail('must not run') }), /Windows/);
});
