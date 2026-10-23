import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopClient, DesktopClientError, discoverDesktopServer, parseToolJSON, registerDesktopConnection, registerDesktopConnectionFromHost, resolveDesktopSourceThreadId } from '../src/desktop-client.mjs';

const SOURCE = '11111111-1111-7111-8111-111111111111';
const OTHER_SOURCE = '22222222-2222-7222-8222-222222222222';
const PIPE = String.raw`\\.\pipe\codex-scheduler-fake-desktop`;

async function fixture(t, { initialize = 'ok', catalog = ['list_projects', 'read_thread', 'send_message_to_thread'] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-scheduler-desktop-test-'));
  const serverPath = path.join(directory, 'fake-official-server.mjs');
  const callLog = path.join(directory, 'fake-calls.txt');
  await fs.writeFile(serverPath, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
    const rl=readline.createInterface({input:process.stdin});
    rl.on('line',line=>{
      const message=JSON.parse(line);
      if(message.method==='initialize') {
        if(${JSON.stringify(initialize)}==='exit') return process.exit(7);
        if(${JSON.stringify(initialize)}==='stale-endpoint') return send({id:message.id,error:{code:-32000,message:'connect ENOENT \\\\.\\pipe\\fixture-old-endpoint'}});
        return send({id:message.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fake-official',version:'1'}}});
      }
      if(message.method==='tools/list') return send({id:message.id,result:{tools:${JSON.stringify(catalog)}.map(name=>({name,inputSchema:{type:'object'}}))}});
      if(message.method!=='tools/call') return;
      fs.appendFileSync(${JSON.stringify(callLog)},'called\\n');
      if(message.params.arguments?.scenario==='exit') return process.exit(8);
      if(message.params.arguments?.scenario==='hang') return;
      if(message.params.arguments?.scenario==='rpc-error') return send({id:message.id,error:{code:-32000,message:'fake host rejected request'}});
      if(message.params.arguments?.scenario==='stale-after-write') return send({id:message.id,error:{code:-32000,message:'connect ENOENT fixture-old-endpoint'}});
      if(message.params.arguments?.scenario==='tool-error') return send({id:message.id,result:{isError:true,content:[{type:'text',text:'fake tool error'}]}});
      return send({id:message.id,result:{content:[{type:'text',text:JSON.stringify({
        name:message.params.name,args:message.params.arguments,meta:message.params._meta,
        pipe:process.env.CODEX_APP_TOOLS_PIPE_PATH,pid:process.pid,
        staleCallId:process.env.CODEX_TOOL_CALL_ID??null,
        apiKey:process.env.OPENAI_API_KEY??null,
        arbitrarySecret:process.env.SCHEDULER_TEST_SECRET??null
      })}]}});
    });
    rl.on('close',()=>process.exit(0));
  `);
  const client = new DesktopClient({ dataDir: directory, serverPath, connectTimeoutMs: 3000, timeoutMs: 2000 });
  t.after(async () => {
    await client.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { directory, serverPath, client, callLog, register: options => registerDesktopConnection({ dataDir: directory, pipePath: PIPE, sourceThreadId: SOURCE, ...options }) };
}

test('desktop registration stores only the genuine source, local endpoint and timestamp', async t => {
  const f = await fixture(t);
  await f.register();
  const stored = JSON.parse(await fs.readFile(path.join(f.directory, 'desktop-connection.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['pipePath', 'registeredAt', 'sourceThreadId']);
  assert.equal(stored.pipePath, PIPE);
  assert.equal(stored.sourceThreadId, SOURCE);
  assert.ok(Number.isFinite(Date.parse(stored.registeredAt)));
  assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
  await assert.rejects(f.register({ sourceThreadId: 'not-a-real-thread' }), { code: 'DESKTOP_CONTEXT_INVALID', stage: 'preCall', uncertain: false });
  await assert.rejects(f.register({ pipePath: String.raw`\\other-computer\pipe\remote` }), { code: 'DESKTOP_CONNECTION_INVALID' });
  await assert.rejects(f.register({ pipePath: String.raw`\\.\pipe\bad/name` }), { code: 'DESKTOP_CONNECTION_INVALID' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'desktop-connection.json'), 'utf8')), stored);
});

test('connectionInfo returns validated internal context and rejects missing or corrupted registrations', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.connectionInfo(), { code: 'DESKTOP_NOT_CONNECTED', stage: 'preCall', uncertain: false });
  const descriptor = await f.register();
  assert.deepEqual(await f.client.connectionInfo(), descriptor);
  const destination = path.join(f.directory, 'desktop-connection.json');
  await fs.writeFile(destination, JSON.stringify({ ...descriptor, unexpected: 'excluded' }));
  assert.deepEqual(await f.client.connectionInfo(), descriptor);
  await fs.writeFile(destination, JSON.stringify({ ...descriptor, sourceThreadId: 'invalid' }));
  await assert.rejects(f.client.connectionInfo(), { code: 'DESKTOP_CONTEXT_INVALID', uncertain: false });
  await assert.rejects(f.client.callTool('list_projects'), { code: 'DESKTOP_CONTEXT_INVALID', stage: 'preCall' });
  await fs.writeFile(destination, '{invalid-json');
  await assert.rejects(f.client.connectionInfo(), { code: 'DESKTOP_NOT_CONNECTED', uncertain: false });
  await assert.rejects(fs.access(f.callLog), { code: 'ENOENT' });
});

test('official desktop server discovery selects the newest complete installed version', async t => {
  const f = await fixture(t);
  const cache = path.join(f.directory, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  for (const version of ['0.1.6', '0.1.10', '0.2.0']) {
    await fs.mkdir(path.join(cache, version), { recursive: true });
    if (version !== '0.2.0') await fs.writeFile(path.join(cache, version, 'server.mjs'), '// fake fixture');
  }
  assert.equal(await discoverDesktopServer({ codexHome: f.directory }), path.join(cache, '0.1.10', 'server.mjs'));
  await assert.rejects(discoverDesktopServer({ codexHome: path.join(f.directory, 'missing') }), { code: 'DESKTOP_SERVER_MISSING' });
});

test('standard MCP call preserves result and genuine source metadata without forwarding tokens or stale call IDs', async t => {
  const f = await fixture(t);
  await f.register();
  const values = { CODEX_TOOL_CALL_ID: 'old-call-id', OPENAI_API_KEY: 'fake-test-key', SCHEDULER_TEST_SECRET: 'fake-test-secret' };
  const previous = new Map(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  t.after(() => { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const args = { threadId: OTHER_SOURCE, prompt: 'fake request only', model: 'gpt-6.1-sol', thinking: 'high' };
  const result = await f.client.callTool('send_message_to_thread', args);
  const actual = parseToolJSON(result);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(actual.args, args);
  assert.deepEqual(actual.meta, { 'openai/threadId': SOURCE });
  assert.equal(actual.pipe, PIPE);
  assert.equal(actual.staleCallId, null);
  assert.equal(actual.apiKey, null);
  assert.equal(actual.arbitrarySecret, null);
  assert.equal((await fs.readFile(f.callLog, 'utf8')).trim(), 'called');
});

test('per-job genuine source overrides the latest connection source and invalid IDs fail before dispatch', async t => {
  const f = await fixture(t);
  await f.register();
  const result = parseToolJSON(await f.client.callTool('read_thread', { threadId: SOURCE }, { sourceThreadId: OTHER_SOURCE }));
  assert.deepEqual(result.meta, { 'openai/threadId': OTHER_SOURCE });
  await assert.rejects(f.client.callTool('read_thread', {}, { sourceThreadId: 'invalid' }), { code: 'DESKTOP_CONTEXT_INVALID', uncertain: false });
  assert.equal((await fs.readFile(f.callLog, 'utf8')).trim(), 'called');
});

test('unregistered, disallowed and unavailable desktop operations fail safely before tools/call', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.callTool('list_projects'), { code: 'DESKTOP_NOT_CONNECTED', stage: 'preCall', uncertain: false });
  await f.register();
  await assert.rejects(f.client.callTool('create_thread', {}), { code: 'DESKTOP_TOOL_NOT_ALLOWED' });
  await assert.rejects(f.client.callTool('list_artifacts', {}), { code: 'DESKTOP_TOOL_UNAVAILABLE', stage: 'preCall', uncertain: false });
  await assert.rejects(fs.access(f.callLog), { code: 'ENOENT' });
});

test('official MCP startup failure remains a pre-call connection error', async t => {
  const f = await fixture(t, { initialize: 'exit' });
  await f.register();
  await assert.rejects(f.client.callTool('list_projects'), error => error instanceof DesktopClientError && error.stage === 'preCall' && !error.uncertain);
  await assert.rejects(fs.access(f.callLog), { code: 'ENOENT' });
});

test('a stale endpoint during startup produces an actionable error without exposing the endpoint or dispatching a tool', async t => {
  const f = await fixture(t, { initialize: 'stale-endpoint' });
  await f.register();
  await assert.rejects(f.client.callTool('list_projects'), error => {
    assert.equal(error.code, 'DESKTOP_ENDPOINT_STALE');
    assert.equal(error.stage, 'preCall');
    assert.equal(error.uncertain, false);
    assert.match(error.message, /重新打开时序插件.*已有任务会保留/);
    assert.doesNotMatch(error.message, /fixture|pipe|ENOENT/);
    return true;
  });
  await assert.rejects(fs.access(f.callLog), { code: 'ENOENT' });
});

for (const scenario of ['exit', 'hang', 'rpc-error', 'stale-after-write']) {
  test(`a ${scenario} after tools/call is uncertain and never automatically resent`, async t => {
    const f = await fixture(t);
    await f.register();
    await assert.rejects(f.client.callTool('send_message_to_thread', { scenario }, { timeoutMs: 100 }), { code: 'DESKTOP_CALL_UNCERTAIN', stage: 'toolCall', uncertain: true });
    assert.deepEqual((await fs.readFile(f.callLog, 'utf8')).trim().split('\n'), ['called']);
    assert.equal(f.client.connection, null);
  });
}

test('updated desktop registration closes the old official client and reconnects to the new endpoint', async t => {
  const f = await fixture(t);
  await f.register();
  const first = parseToolJSON(await f.client.callTool('list_projects'));
  await f.register({ pipePath: `${PIPE}-new`, sourceThreadId: OTHER_SOURCE });
  const second = parseToolJSON(await f.client.callTool('list_projects'));
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.pipe, `${PIPE}-new`);
  assert.deepEqual(second.meta, { 'openai/threadId': OTHER_SOURCE });
});

test('a genuine host endpoint refresh reuses only an existing validated source when global initialization has no chat ID', async t => {
  const f = await fixture(t);
  await f.register();
  const first = parseToolJSON(await f.client.callTool('list_projects'));
  const refreshed = await registerDesktopConnectionFromHost({ dataDir: f.directory, env: { CODEX_APP_TOOLS_PIPE_PATH: `${PIPE}-after-restart` } });
  assert.deepEqual(refreshed, { registered: true });
  const descriptor = await f.client.connectionInfo();
  assert.equal(descriptor.sourceThreadId, SOURCE);
  assert.equal(descriptor.pipePath, `${PIPE}-after-restart`);
  const second = parseToolJSON(await f.client.callTool('list_projects'));
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.pipe, `${PIPE}-after-restart`);
  assert.deepEqual(second.meta, { 'openai/threadId': SOURCE });
});

test('a missing or invalid explicit source never creates or replaces a genuine registration', async t => {
  const f = await fixture(t);
  assert.equal((await registerDesktopConnectionFromHost({ dataDir: f.directory, env: { CODEX_APP_TOOLS_PIPE_PATH: PIPE } })).registered, false);
  await assert.rejects(fs.access(path.join(f.directory, 'desktop-connection.json')), { code: 'ENOENT' });
  const original = await f.register();
  for (const env of [
    { CODEX_THREAD_ID: OTHER_SOURCE },
    { CODEX_APP_TOOLS_PIPE_PATH: `${PIPE}-new`, CODEX_THREAD_ID: 'invalid' },
    { CODEX_APP_TOOLS_PIPE_PATH: `${PIPE}-new`, CODEX_THREAD_ID: '' },
    { CODEX_APP_TOOLS_PIPE_PATH: 'https://not-local' },
  ]) {
    assert.equal((await registerDesktopConnectionFromHost({ dataDir: f.directory, env })).registered, false);
    assert.deepEqual(await f.client.connectionInfo(), original);
  }
  const file = path.join(f.directory, 'desktop-connection.json');
  await fs.writeFile(file, JSON.stringify({ ...original, sourceThreadId: 'invalid' }));
  const corrupted = await fs.readFile(file, 'utf8');
  assert.equal((await registerDesktopConnectionFromHost({ dataDir: f.directory, env: { CODEX_APP_TOOLS_PIPE_PATH: `${PIPE}-new` } })).registered, false);
  assert.equal(await fs.readFile(file, 'utf8'), corrupted);
});

test('genuine executor source metadata supports official aliases, turn metadata and nested thread IDs', () => {
  for (const key of ['openai/threadId', 'openai/thread_id', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id']) {
    assert.equal(resolveDesktopSourceThreadId({ [key]: SOURCE }, { CODEX_THREAD_ID: OTHER_SOURCE }), SOURCE);
  }
  assert.equal(resolveDesktopSourceThreadId({ 'x-codex-turn-metadata': { thread_id: SOURCE, turn_id: 'ignored-turn' } }, {}), SOURCE);
  assert.equal(resolveDesktopSourceThreadId({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: SOURCE }) }, {}), SOURCE);
  assert.equal(resolveDesktopSourceThreadId({ thread: { id: SOURCE } }, {}), SOURCE);
  assert.equal(resolveDesktopSourceThreadId({ 'openai/threadId': SOURCE, thread_id: SOURCE, thread: { id: SOURCE } }, {}), SOURCE);
  assert.equal(resolveDesktopSourceThreadId({}, { CODEX_THREAD_ID: SOURCE }), SOURCE);
  assert.equal(resolveDesktopSourceThreadId({}, {}), undefined);
  assert.equal(resolveDesktopSourceThreadId({ 'x-codex-turn-metadata': { turn_id: 'ignored-turn' } }, {}), undefined);
});

test('invalid or conflicting supplied executor metadata never falls back to a different source', () => {
  for (const meta of [
    { 'openai/threadId': 'invalid' },
    { 'openai/threadId': '' },
    { 'openai/threadId': SOURCE, thread_id: OTHER_SOURCE },
    { 'openai/threadId': SOURCE, 'x-codex-turn-metadata': { thread_id: OTHER_SOURCE } },
    { thread: { id: 123 } },
    { 'x-codex-turn-metadata': 'invalid-json' },
    { 'x-codex-turn-metadata': null },
  ]) assert.throws(() => resolveDesktopSourceThreadId(meta, { CODEX_THREAD_ID: SOURCE }), { code: 'DESKTOP_CONTEXT_INVALID' });
  assert.throws(() => resolveDesktopSourceThreadId({}, { CODEX_THREAD_ID: 'invalid' }), { code: 'DESKTOP_CONTEXT_INVALID' });
});

test('explicit client close is serialized and the next call can reconnect without replaying the old operation', async t => {
  const f = await fixture(t);
  await f.register();
  const first = parseToolJSON(await f.client.callTool('list_projects'));
  await Promise.all([f.client.close(), f.client.close()]);
  const second = parseToolJSON(await f.client.callTool('list_projects'));
  assert.notEqual(first.pid, second.pid);
  assert.deepEqual((await fs.readFile(f.callLog, 'utf8')).trim().split('\n'), ['called', 'called']);
});

test('MCP tool errors pass through unchanged and JSON helper accepts structured content', async t => {
  const f = await fixture(t);
  await f.register();
  assert.deepEqual(await f.client.callTool('read_thread', { scenario: 'tool-error' }), { isError: true, content: [{ type: 'text', text: 'fake tool error' }] });
  assert.deepEqual(parseToolJSON({ structuredContent: { ok: true } }), { ok: true });
  assert.throws(() => parseToolJSON({ content: [{ type: 'text', text: 'not json' }] }), SyntaxError);
});
