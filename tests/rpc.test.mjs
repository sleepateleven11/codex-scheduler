import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexRpcClient } from '../src/rpc-client.mjs';

const shim = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let pending; let handledReplies = 0;
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'probe-default') {
    pending = message.id;
    return send({ id: message.id, method: 'approval', params: { threadId: 'other' } });
  }
  if (message.method === 'probe-handled') {
    pending = message.id;
    return send({ id: 'server:handled', method: 'approval', params: { threadId: 'mine' } });
  }
  if (message.method === 'probe-count') return send({ id: message.id, result: { handledReplies } });
  if (message.method === 'probe-exit') return process.exit(7);
  if (message.id === 'server:handled') {
    handledReplies++;
    return send({ id: pending, result: { approval: message.result } });
  }
  if (message.error) return send({ id: pending, result: { answer: message.error.code } });
});
rl.on('close', () => process.exit(0));
`;

async function fakeClient(t, source = shim) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-scheduler-rpc-test-'));
  // Node treats the first app-server argument as a local shim, never a real Codex executable.
  await fs.writeFile(path.join(directory, 'app-server'), source);
  const client = new CodexRpcClient({ codexPath: process.execPath, cwd: directory });
  t.after(async () => {
    await client.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return client;
}

test('RPC rejects an unhandled server request even when its ID collides with an outgoing request', { timeout: 4000 }, async t => {
  const client = await fakeClient(t);
  let observed = 0;
  // An unrelated listener must not disable the default permission rejection.
  client.on('serverRequest', message => { if (message.params.threadId === 'other') observed++; });
  await client.start();
  assert.deepEqual(await client.request('probe-default', {}, 2000), { answer: -32001 });
  assert.equal(observed, 1);
});

test('RPC accepts a synchronous explicit server reply without sending a second fallback', { timeout: 4000 }, async t => {
  const client = await fakeClient(t);
  client.on('serverRequest', message => client.respond(message.id, { handled: true }));
  await client.start();
  assert.deepEqual(await client.request('probe-handled', {}, 2000), { approval: { handled: true } });
  assert.deepEqual(await client.request('probe-count', {}, 2000), { handledReplies: 1 });
});

test('RPC initialization rejects promptly when the child exits and clears pending requests', { timeout: 4000 }, async t => {
  const client = await fakeClient(t, 'process.exit(7);');
  await assert.rejects(client.start(), /Codex/);
  assert.equal(client.pending.size, 0);
});

test('RPC rejects a pending operation when the transport exits', { timeout: 4000 }, async t => {
  const client = await fakeClient(t);
  await client.start();
  await assert.rejects(client.request('probe-exit', {}, 2000), /Codex/);
  assert.equal(client.pending.size, 0);
});
