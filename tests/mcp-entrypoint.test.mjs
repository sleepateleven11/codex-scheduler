import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { LAUNCHER_URI, launcherHtml, readLauncherResource } from '../src/launcher-resource.mjs';
import { registerDesktopConnection, registerDesktopConnectionFromHost } from '../src/desktop-client.mjs';

const SOURCE = '11111111-1111-7111-8111-111111111111';
const PIPE = String.raw`\\.\pipe\scheduler-initialize-fixture`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-mcp-entrypoint-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return dir;
}

async function mcp(t, dataDir, hostEnv = {}) {
  const env = { ...process.env, SCHEDULER_DATA_DIR: dataDir };
  delete env.CODEX_THREAD_ID; delete env.CODEX_APP_TOOLS_PIPE_PATH;
  Object.assign(env, hostEnv);
  const child = spawn(process.execPath, [path.join(root, 'src', 'mcp-server.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map(); let id = 0;
  lines.on('line', text => { const result = JSON.parse(text); const resolve = pending.get(result.id); if (resolve) { pending.delete(result.id); resolve(result); } });
  t.after(async () => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode !== null) return resolve(); const timer = setTimeout(() => { child.kill(); resolve(); }, 1000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); lines.close(); });
  return (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; const timer = setTimeout(() => reject(new Error(`MCP fixture timed out: ${method}`)), 5000); pending.set(requestId, message => { clearTimeout(timer); resolve(message); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`); });
}

test('real MCP initialize registers genuine host context without a tools/call or daemon startup', async t => {
  const dir = await directory(t);
  const request = await mcp(t, dir, { CODEX_THREAD_ID: SOURCE, CODEX_APP_TOOLS_PIPE_PATH: PIPE });
  const initialized = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(initialized.result.serverInfo.version, '0.3.4');
  assert.ok(initialized.result.capabilities.resources);
  const descriptor = JSON.parse(await fs.readFile(path.join(dir, 'desktop-connection.json'), 'utf8'));
  assert.equal(descriptor.sourceThreadId, SOURCE); assert.equal(descriptor.pipePath, PIPE);
  assert.deepEqual(await fs.readdir(dir), ['desktop-connection.json']);
  const tools = (await request('tools/list')).result.tools;
  const entrypoint = tools.find(tool => tool.name === 'scheduler_open');
  assert.equal(entrypoint._meta.ui.resourceUri, LAUNCHER_URI);
  assert.deepEqual(entrypoint._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  const listed = await request('resources/list');
  assert.equal(listed.result.resources[0].uri, LAUNCHER_URI);
  const resource = await request('resources/read', { uri: LAUNCHER_URI });
  assert.equal(resource.result.contents[0].text, launcherHtml);
  assert.equal((await request('resources/read', { uri: 'file:///private' })).error.code, -32603);
  assert.deepEqual(await fs.readdir(dir), ['desktop-connection.json']);
});

test('initialize without a genuine source remains available and never invents a source ID', async t => {
  const dir = await directory(t);
  const request = await mcp(t, dir, { CODEX_APP_TOOLS_PIPE_PATH: PIPE });
  assert.ok((await request('initialize', { protocolVersion: '2024-11-05' })).result);
  assert.deepEqual(await fs.readdir(dir), []);
  const registration = await registerDesktopConnectionFromHost({ env: { CODEX_APP_TOOLS_PIPE_PATH: PIPE }, dataDir: dir });
  assert.equal(registration.registered, false); assert.match(registration.message, /尚未登记/);
});

test('MCP advertises and forwards an explicitly authorized quota trigger without inventing a send time', async t => {
  const dir = await directory(t);
  const submissions = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify({ worker: { version: '0.3.4', status: 'running' } }));
    assert.equal(req.url, '/api/tasks');
    assert.equal(req.method, 'POST');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    submissions.push(payload);
    res.statusCode = 201;
    res.end(JSON.stringify({ task: { ...payload, id: 'fixture-only', status: 'scheduled' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await fs.writeFile(path.join(dir, 'endpoint.json'), JSON.stringify({ port: server.address().port, token: 'a'.repeat(64) }));
  const request = await mcp(t, dir);
  await request('initialize', { protocolVersion: '2024-11-05' });
  const tool = (await request('tools/list')).result.tools.find(tool => tool.name === 'scheduler_create');
  assert.deepEqual(tool.inputSchema.properties.sendMode.enum, ['scheduled', 'quota_available']);
  assert.ok(!tool.inputSchema.required.includes('runAt'));
  assert.deepEqual(tool.inputSchema.anyOf[0].required, ['runAt']);
  assert.deepEqual(tool.inputSchema.anyOf[1].properties.sendMode, { const: 'quota_available' });
  const args = { projectPath: 'C:\\fixture', threadId: SOURCE, model: 'fixture-model', prompt: 'Fixture only', sendMode: 'quota_available' };
  const response = await request('tools/call', { name: 'scheduler_create', arguments: args });
  assert.ok(!response.result.isError);
  assert.deepEqual(submissions, [args]);
  assert.equal(JSON.parse(response.result.content[0].text).task.sendMode, 'quota_available');
});

test('MCP advertises destructive local deletion and forwards it using the DELETE API', async t => {
  const dir = await directory(t);
  const calls = [];
  const id = '44444444-4444-4444-8444-444444444444';
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify({ worker: { version: '0.3.4', status: 'running' } }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
    res.end(JSON.stringify({ deleted: true, id }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await fs.writeFile(path.join(dir, 'endpoint.json'), JSON.stringify({ port: server.address().port, token: 'b'.repeat(64) }));
  const request = await mcp(t, dir);
  await request('initialize', { protocolVersion: '2024-11-05' });
  const tool = (await request('tools/list')).result.tools.find(tool => tool.name === 'scheduler_action');
  assert.ok(tool.inputSchema.properties.action.enum.includes('delete'));
  assert.equal(tool.annotations.destructiveHint, true);
  assert.match(tool.description, /不撤回已发送消息/);
  const response = await request('tools/call', { name: 'scheduler_action', arguments: { id, action: 'delete' } });
  assert.ok(!response.result.isError);
  assert.deepEqual(JSON.parse(response.result.content[0].text), { deleted: true, id });
  assert.deepEqual(calls, [{ method: 'DELETE', url: '/api/tasks/' + id, body: '' }]);
});

test('global MCP initialization after a desktop restart renews the endpoint while keeping the saved genuine source', async t => {
  const dir = await directory(t);
  await registerDesktopConnection({ pipePath: `${PIPE}-old`, sourceThreadId: SOURCE, dataDir: dir });
  const request = await mcp(t, dir, { CODEX_APP_TOOLS_PIPE_PATH: `${PIPE}-after-restart` });
  assert.ok((await request('initialize', { protocolVersion: '2024-11-05' })).result);
  const descriptor = JSON.parse(await fs.readFile(path.join(dir, 'desktop-connection.json'), 'utf8'));
  assert.equal(descriptor.sourceThreadId, SOURCE);
  assert.equal(descriptor.pipePath, `${PIPE}-after-restart`);
  assert.deepEqual(await fs.readdir(dir), ['desktop-connection.json']);
});

test('invalid or missing host registration never overwrites an existing genuine descriptor', async t => {
  const dir = await directory(t);
  const descriptor = await registerDesktopConnection({ pipePath: PIPE, sourceThreadId: SOURCE, dataDir: dir });
  for (const env of [{}, { CODEX_APP_TOOLS_PIPE_PATH: PIPE, CODEX_THREAD_ID: 'invalid' }, { CODEX_APP_TOOLS_PIPE_PATH: 'https://remote', CODEX_THREAD_ID: SOURCE }]) {
    assert.equal((await registerDesktopConnectionFromHost({ env, dataDir: dir })).registered, false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'desktop-connection.json'), 'utf8')), descriptor);
  }
});

const settle = () => new Promise(resolve => setImmediate(resolve));
async function widget(t, { url = 'http://127.0.0.1:1234/#token=fixture', openError = false, displayMode = 'fullscreen' } = {}) {
  const calls = []; const elements = new Map(); let listener;
  for (const id of ['open', 'status']) elements.set(id, { disabled: false, textContent: '', addEventListener(event, fn) { this[event] = fn; } });
  const parent = { postMessage(message) { calls.push(message); if (message.id != null) queueMicrotask(() => listener({ source: parent, data: { jsonrpc: '2.0', id: message.id, result: message.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ url }) }] } : message.method === 'ui/open-link' ? { isError: openError } : { hostContext: { displayMode } } } })); } };
  const window = { parent, addEventListener(event, fn) { listener = fn; } };
  const context = vm.createContext({ window, document: { getElementById: id => elements.get(id) }, URL, Map, Error, JSON, setTimeout, clearTimeout });
  const code = launcherHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(code, context); await settle();
  return { calls, elements, async toolResult(result = { content: [{ type: 'text', text: JSON.stringify({ url }) }] }) { listener({ source: parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }); await settle(); }, async click() { elements.get('open').click(); await settle(); } };
}

test('native entrypoint uses only the standard host bridge and launches localhost once per opening', async t => {
  const w = await widget(t);
  await w.toolResult(); await w.toolResult();
  assert.deepEqual(w.calls.filter(call => call.id != null).map(call => call.method), ['ui/initialize', 'ui/open-link']);
  assert.match(w.elements.get('status').textContent, /管理器已打开/);
  await w.click();
  assert.deepEqual(w.calls.filter(call => call.method === 'tools/call').map(call => call.params.name), ['scheduler_open']);
  assert.equal(w.calls.filter(call => call.method === 'ui/open-link').length, 2);
  assert.doesNotMatch(launcherHtml, /fetch\(|<iframe|OPENAI_API_KEY|send_message_to_thread/);
  assert.deepEqual(readLauncherResource(LAUNCHER_URI).contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
});

test('native entrypoint rejects remote or malformed dashboard URLs before opening anything', async t => {
  for (const url of ['https://example.com/', 'http://127.0.0.1:1234/remote', 'http://user:password@127.0.0.1:1234/']) {
    const w = await widget(t, { url }); await w.toolResult();
    assert.equal(w.calls.filter(call => call.method === 'ui/open-link').length, 0);
    assert.match(w.elements.get('status').textContent, /地址无效/);
    assert.equal(w.elements.get('open').disabled, false);
  }
});

test('an inline model invocation never opens another browser automatically', async t => {
  const w = await widget(t, { displayMode: 'inline' }); await w.toolResult();
  assert.equal(w.calls.filter(call => call.method === 'ui/open-link').length, 0);
  assert.match(w.elements.get('status').textContent, /点击即可打开/);
  await w.click();
  assert.equal(w.calls.filter(call => call.method === 'ui/open-link').length, 1);
});

test('an unsupported native open-link leaves a usable desktop shortcut fallback', async t => {
  const w = await widget(t, { openError: true }); await w.toolResult();
  assert.match(w.elements.get('status').textContent, /桌面/);
  assert.equal(w.elements.get('open').disabled, false);
});
