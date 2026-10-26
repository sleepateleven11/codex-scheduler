import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildBrokerPlan } from '../src/windows-broker.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clientUrl = new URL('../src/daemon-client.mjs', import.meta.url).href;

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function runScenario(t, scenario) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-scheduler-daemon-test-'));
  const dataDir = path.join(directory, 'data');
  await fs.mkdir(dataDir);
  const harness = path.join(directory, 'scenario.mjs');
  await fs.writeFile(harness, `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDaemon, stopDaemon } from ${JSON.stringify(clientUrl)};
const dataDir = process.env.SCHEDULER_DATA_DIR;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finish() {
  const lastEndpointPid = JSON.parse(await fs.readFile(path.join(dataDir, 'endpoint.json'), 'utf8')).pid;
  assert.equal((await stopDaemon()).stopped, true);
  for (let attempt = 0; attempt < 100; attempt++) {
    const remains = await Promise.all(['worker.lock', 'endpoint.json'].map(name =>
      fs.access(path.join(dataDir, name)).then(() => true, () => false)));
    if (remains.every(exists => !exists)) {
      for (let check = 0; check < 100; check++) {
        try { process.kill(lastEndpointPid, 0); }
        catch (error) { if (error.code === 'ESRCH') return; throw error; }
        await delay(10);
      }
      assert.fail('The stopped worker kept its process alive after releasing metadata.');
    }
    await delay(25);
  }
  assert.fail('The stopped worker did not release its lock and endpoint.');
}
${scenario}
`);
  let completed = false;
  const child = spawn(process.execPath, [harness], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env,
      SCHEDULER_DATA_DIR: dataDir,
      CODEX_HOME: path.join(directory, 'empty-codex-home'),
      // An accidental adapter call launches only Node, never a signed-in model.
      SCHEDULER_CODEX_PATH: process.execPath,
      SCHEDULER_LAUNCH_MODE: 'direct',
    },
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    try {
      // The helper's environment remains fixed even if the test is cancelled.
      let endpoint = await readJson(path.join(dataDir, 'endpoint.json'));
      if (!completed && !endpoint) {
        for (let attempt = 0; attempt < 20 && !endpoint; attempt++) {
          await delay(25);
          endpoint = await readJson(path.join(dataDir, 'endpoint.json'));
        }
      }
      if (endpoint) {
        await fetch(`http://127.0.0.1:${endpoint.port}/api/stop`, {
          method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}` },
          signal: AbortSignal.timeout(1000),
        }).catch(() => {});
        for (let attempt = 0; attempt < 40; attempt++) {
          if (!await readJson(path.join(dataDir, 'endpoint.json'))) break;
          await delay(25);
        }
      }
      const lock = await readJson(path.join(dataDir, 'worker.lock')).catch(() => null);
      if (Number.isInteger(lock?.pid) && lock.pid > 0 && lock.pid !== process.pid) {
        try { process.kill(lock.pid); } catch { /* Already exited. */ }
      }
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, output || 'Isolated daemon lifecycle helper exited unsuccessfully.');
  completed = true;
}

test('empty daemon has one startup owner, protects its HTTP API, and releases metadata on stop', { timeout: 8000 }, async t => {
  await runScenario(t, `
const workers = await Promise.all(Array.from({ length: 4 }, () => ensureDaemon()));
const endpoint = workers[0];
assert.ok(workers.every(worker => worker.pid === endpoint.pid && worker.port === endpoint.port));
assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'worker.lock'), 'utf8')).pid, endpoint.pid);
const origin = 'http://127.0.0.1:' + endpoint.port;
const headers = { Authorization: 'Bearer ' + endpoint.token };
assert.equal((await fetch(origin + '/api/health')).status, 401);
assert.equal((await fetch(origin + '/api/health', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
const response = await fetch(origin + '/api/health', { headers });
assert.equal(response.status, 200);
assert.equal((await response.json()).worker.status, 'running');
await finish();
`);
});

test('Windows broker persists only selected local paths and encodes a hidden waiting action', async t => {
  const paths = { root: path.resolve('scheduler-source'), dataDir: path.resolve('scheduler-local-data'), logPath: path.resolve('scheduler-local-data', 'worker.log') };
  const env = { CODEX_HOME: path.resolve('selected-codex-home'), SCHEDULER_CODEX_PATH: path.resolve('codex.exe'), OPENAI_API_KEY: 'secret-must-not-be-persisted', SCHEDULER_LAUNCH_MODE: 'direct', UNRELATED_SETTING: 'unrelated-must-not-be-persisted' };
  const plan = buildBrokerPlan({ paths, nodePath: process.execPath, env });
  assert.match(plan.taskName, /^CodexScheduler-[a-f0-9]{24}$/);
  assert.ok(plan.launcherSource.includes(JSON.stringify(env.CODEX_HOME)));
  assert.ok(plan.launcherSource.includes('SCHEDULER_DATA_DIR'));
  assert.doesNotMatch(plan.launcherSource, /secret-must-not-be-persisted|unrelated-must-not-be-persisted|OPENAI_API_KEY|SCHEDULER_LAUNCH_MODE/);
  const command = Buffer.from(plan.actionArguments.split('-EncodedCommand ')[1], 'base64').toString('utf16le');
  assert.match(command, /-WindowStyle Hidden -Wait -PassThru/);
  assert.ok(command.includes(process.execPath));
  assert.notEqual(buildBrokerPlan({ paths, nodePath: `${process.execPath}.changed`, env }).actionArguments, plan.actionArguments);
  assert.equal(buildBrokerPlan({ paths, nodePath: process.execPath, env }).taskName, plan.taskName);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-scheduler-broker-syntax-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const launcher = path.join(directory, 'worker-launcher.mjs');
  await fs.writeFile(launcher, plan.launcherSource);
  const checked = spawnSync(process.execPath, ['--check', launcher], { windowsHide: true, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('preferences API remembers selections and rejects drafts, credentials, and cross-origin writes', { timeout: 8000 }, async t => {
  await runScenario(t, `
const endpoint = await ensureDaemon();
const origin = 'http://127.0.0.1:' + endpoint.port;
const headers = { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json' };
assert.deepEqual((await (await fetch(origin + '/api/preferences', { headers })).json()).preferences, {});
const saved = await fetch(origin + '/api/preferences', { method: 'PUT', headers, body: JSON.stringify({ model: 'fixture-model', timeZone: 'Asia/Shanghai' }) });
assert.equal(saved.status, 200);
assert.equal((await saved.json()).preferences.model, 'fixture-model');
for (const body of [{ prompt: 'Never save this draft.' }, { token: 'Never save credentials.' }]) {
  assert.equal((await fetch(origin + '/api/preferences', { method: 'PUT', headers, body: JSON.stringify(body) })).status, 400);
}
assert.equal((await fetch(origin + '/api/preferences', { method: 'PUT', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ model: 'should-not-save' }) })).status, 403);
assert.deepEqual((await (await fetch(origin + '/api/preferences', { headers })).json()).preferences, { model: 'fixture-model', timeZone: 'Asia/Shanghai' });
await finish();
`);
});

test('quota cycle APIs are isolated, authenticated, and do not enable a rule on discovery', { timeout: 8000 }, async t => {
  await runScenario(t, `
const endpoint = await ensureDaemon();
const origin = 'http://127.0.0.1:' + endpoint.port;
const headers = { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json' };
assert.equal((await fetch(origin + '/api/quota-cycles')).status, 401);
assert.deepEqual(await (await fetch(origin + '/api/quota-cycles', { headers })).json(), { rules: [] });
const data = JSON.parse(await fs.readFile(path.join(dataDir, 'quota-cycles.json'), 'utf8'));
assert.equal(data.version, 1); assert.deepEqual(data.rules, []);
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
assert.equal((await fetch(origin + '/api/quota-cycles/' + id, { method: 'DELETE', headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
assert.equal((await fetch(origin + '/api/quota-cycles/' + id + '/action', { method: 'POST', headers, body: JSON.stringify({ action: 'retry' }) })).status, 400);
assert.equal((await fetch(origin + '/api/quota-cycles/' + id, { method: 'DELETE', headers })).status, 200);
assert.deepEqual(await (await fetch(origin + '/api/quota-cycles', { headers })).json(), { rules: [] });
assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'queue.json'), 'utf8')).tasks, []);
await finish();
`);
});

test('task deletion API is authenticated, durable, idempotent, and protects uncertain dispatches', { timeout: 8000 }, async t => {
  await runScenario(t, `
const now = new Date().toISOString();
const scheduled = {
  id: '11111111-1111-4111-8111-111111111111', projectPath: 'C:\\\\fixture',
  threadId: 'fixture-thread', model: 'fixture-model', prompt: 'Private pending prompt.',
  status: 'scheduled', runAt: '2099-01-01T00:00:00.000Z', createdAt: now, updatedAt: now,
  attempts: 0, clientRequestId: 'pending-request', timeZone: 'UTC',
};
const history = { ...scheduled, id: '22222222-2222-4222-8222-222222222222', status: 'completed', prompt: 'Private history.', result: 'Private output.', clientRequestId: 'history-request' };
const protectedTask = { ...scheduled, id: '33333333-3333-4333-8333-333333333333', status: 'paused', prompt: 'Protected pending prompt.', dispatchState: 'intent', clientRequestId: 'protected-request' };
const queueFile = path.join(dataDir, 'queue.json');
await fs.writeFile(queueFile, JSON.stringify({ version: 1, tasks: [scheduled, history, protectedTask] }));
const endpoint = await ensureDaemon();
const origin = 'http://127.0.0.1:' + endpoint.port;
const headers = { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json' };
const destination = origin + '/api/tasks/' + scheduled.id;
assert.equal((await fetch(destination, { method: 'DELETE' })).status, 401);
assert.equal((await fetch(destination, { method: 'DELETE', headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
assert.equal(JSON.parse(await fs.readFile(queueFile, 'utf8')).tasks.length, 3);
const removed = await fetch(destination, { method: 'DELETE', headers });
assert.equal(removed.status, 200);
assert.deepEqual(await removed.json(), { deleted: true, id: scheduled.id });
const onceDeleted = await fs.readFile(queueFile, 'utf8');
assert.ok(!onceDeleted.includes(scheduled.prompt));
assert.ok(!onceDeleted.includes(scheduled.clientRequestId));
assert.equal((await fetch(destination, { method: 'DELETE', headers })).status, 200);
assert.equal(await fs.readFile(queueFile, 'utf8'), onceDeleted);
const action = await fetch(origin + '/api/tasks/' + history.id + '/action', { method: 'POST', headers, body: JSON.stringify({ action: 'delete' }) });
assert.equal(action.status, 200);
assert.deepEqual(await action.json(), { deleted: true, id: history.id });
const rejected = await fetch(origin + '/api/tasks/' + protectedTask.id, { method: 'DELETE', headers });
assert.equal(rejected.status, 409);
assert.equal((await rejected.json()).error, 'task_busy');
const finalDocument = JSON.parse(await fs.readFile(queueFile, 'utf8'));
assert.deepEqual(finalDocument.tasks.map(task => task.id), [protectedTask.id]);
assert.equal(finalDocument.deletedRequestHashes.length, 2);
await finish();
`);
});

test('concurrent startup recovers a dead worker lock with one owner', { timeout: 8000 }, async t => {
  await runScenario(t, `
const lockFile = path.join(dataDir, 'worker.lock');
await fs.writeFile(lockFile, JSON.stringify({ pid: 2147483647 }));
const old = new Date(Date.now() - 120000);
await fs.utimes(lockFile, old, old);
const workers = await Promise.all(Array.from({ length: 8 }, () => ensureDaemon()));
const endpoint = workers[0];
assert.ok(workers.every(worker => worker.pid === endpoint.pid && worker.port === endpoint.port));
assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).pid, endpoint.pid);
await finish();
`);
});

test('startup recovers an old incomplete lock file', { timeout: 8000 }, async t => {
  await runScenario(t, `
const lockFile = path.join(dataDir, 'worker.lock');
await fs.writeFile(lockFile, '{incomplete');
const old = new Date(Date.now() - 120000);
await fs.utimes(lockFile, old, old);
const endpoint = await ensureDaemon();
assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).pid, endpoint.pid);
await finish();
`);
});
