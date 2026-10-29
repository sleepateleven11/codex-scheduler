import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectSchedulerSource, planMarketplaceSource, mcpManifest, portableMcpManifest, distributionPayload, stageInstallationSource, DISTRIBUTION_INCLUDES } from '../scripts/plugin-common.mjs';
import { installPluginWithRecovery, installOptionalManagerLaunchers, selectCachedSchedulerMcps } from '../scripts/install.mjs';
import { getPaths } from '../src/paths.mjs';
import { uninstallPluginWithCleanup } from '../scripts/uninstall.mjs';
import { stopCachedSchedulerMcps } from '../src/plugin-processes.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-scheduler-source-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  async function source(name, { version = '0.1.1', manifest = {}, marketplace = {} } = {}) {
    const root = path.join(directory, name);
    await fs.mkdir(path.join(root, '.codex-plugin'), { recursive: true });
    await fs.mkdir(path.join(root, '.agents', 'plugins'), { recursive: true });
    await fs.writeFile(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'codex-scheduler', version, skills: './skills/', mcpServers: './.mcp.json', ...manifest }));
    await fs.writeFile(path.join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'local-scheduler', plugins: [{ name: 'codex-scheduler', source: { source: 'local', path: '.' } }], ...marketplace }));
    return root;
  }
  return { directory, source };
}

test('a verified previous extraction of this dedicated marketplace can migrate without changing data or config', async t => {
  const f = await fixture(t);
  const oldRoot = await f.source('previous', { version: '0.1.0' });
  const newRoot = await f.source('new');
  const queueFile = path.join(f.directory, 'queue-data.json');
  await fs.writeFile(queueFile, '{"existing":"preserved"}');
  const config = { marketplaces: { 'local-scheduler': { source_type: 'local', source: oldRoot }, other: { source_type: 'git', source: 'unrelated' } }, plugins: { other: { enabled: true } } };
  const before = JSON.stringify(config);
  const oldManifest = await fs.readFile(path.join(oldRoot, '.codex-plugin', 'plugin.json'), 'utf8');
  assert.deepEqual(await planMarketplaceSource(config.marketplaces['local-scheduler'], { root: newRoot }), {
    action: 'migrate', fromRoot: await fs.realpath(oldRoot), toRoot: newRoot, pluginId: 'codex-scheduler@local-scheduler', fromVersion: '0.1.0', toVersion: '0.1.1',
  });
  assert.equal(JSON.stringify(config), before);
  assert.equal(await fs.readFile(queueFile, 'utf8'), '{"existing":"preserved"}');
  assert.equal(await fs.readFile(path.join(oldRoot, '.codex-plugin', 'plugin.json'), 'utf8'), oldManifest);
});

test('first install and same-directory reinstall preserve their separate source plans', async t => {
  const f = await fixture(t);
  const root = await f.source('current');
  assert.deepEqual(await planMarketplaceSource(null, { root }), { action: 'register', toRoot: root, pluginId: 'codex-scheduler@local-scheduler' });
  assert.deepEqual(await planMarketplaceSource({ source_type: 'local', source: root }, { root }), { action: 'keep', toRoot: root, pluginId: 'codex-scheduler@local-scheduler' });
});

test('a deleted old extraction migrates only with enabled exact registration and dedicated verified cache identity', async t => {
  const f = await fixture(t);
  const root = await f.source('new extraction');
  const prior = { source_type: 'local', source: path.join(f.directory, 'deleted old extraction') };
  const codexHome = path.join(f.directory, 'isolated new profile');
  const cached = await f.source(path.join('isolated new profile', 'plugins', 'cache', 'local-scheduler', 'codex-scheduler', '0.2.4'), { version: '0.2.4' });
  await fs.mkdir(path.join(cached, 'src'));
  await fs.writeFile(path.join(cached, 'src', 'mcp-server.mjs'), '// fixture only');
  const server = mcpManifest(path.join(f.directory, 'node.exe'), cached, { dataDir: f.directory });
  await fs.writeFile(path.join(cached, '.mcp.json'), JSON.stringify(server));
  const registeredPlugins = { 'codex-scheduler@local-scheduler': { enabled: true } };
  const result = await planMarketplaceSource(prior, { root, codexHome, registeredPlugins });
  assert.equal(result.action, 'migrate');
  assert.equal(result.fromRoot, prior.source);
  assert.equal(result.fromVersion, '0.2.4');
  for (const plugins of [undefined, { 'codex-scheduler@local-scheduler': { enabled: false } }, { ...registeredPlugins, 'another-plugin@local-scheduler': { enabled: true } }]) {
    await assert.rejects(planMarketplaceSource(prior, { root, codexHome, registeredPlugins: plugins }), /原注册已保留/);
  }
  server.mcpServers.codex_scheduler.args = [path.join(f.directory, 'foreign-script.mjs')];
  await fs.writeFile(path.join(cached, '.mcp.json'), JSON.stringify(server));
  await assert.rejects(planMarketplaceSource(prior, { root, codexHome, registeredPlugins }), /原注册已保留/);
});

async function distributableFixture(t) {
  const f = await fixture(t);
  const root = await f.source('new user extracted package', { version: '1.2.3' });
  for (const folder of ['src', 'public', 'skills/codex-scheduler', 'scripts']) await fs.mkdir(path.join(root, folder), { recursive: true });
  for (const name of ['src/mcp-server.mjs', 'public/app.js', 'skills/codex-scheduler/SKILL.md', 'scripts/install.mjs', 'scripts/uninstall.mjs', 'README.md', '安装插件.cmd', '卸载插件.cmd']) await fs.writeFile(path.join(root, name), `// ${name} fixture only\n`);
  for (const name of ['package.json', 'package-lock.json']) await fs.writeFile(path.join(root, name), JSON.stringify({ name: 'codex-scheduler', version: '1.2.3' }));
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify(mcpManifest(path.join(f.directory, 'developer Node', 'node.exe'), root, { dataDir: path.join(f.directory, 'developer data') })));
  const binary = Buffer.from('fixture Node, never executed');
  const license = Buffer.from('fixture upstream license');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const nodePath = path.join(root, 'runtime', 'windows-x64', 'node.exe');
  await fs.mkdir(path.dirname(nodePath), { recursive: true });
  await fs.writeFile(nodePath, binary);
  await fs.writeFile(path.join(root, 'runtime', 'LICENSE.node.txt'), license);
  await fs.writeFile(path.join(root, 'runtime', 'node-release.json'), JSON.stringify({ version: '24.22.1', platforms: {
    'win-x64': { url: 'https://nodejs.org/dist/v24.22.1/win-x64/node.exe', sha256: digest(binary) },
    'win-arm64': { url: 'https://nodejs.org/dist/v24.22.1/win-arm64/node.exe', sha256: digest('unused arm64 fixture') },
  }, license: { file: 'LICENSE.node.txt', source: 'https://raw.githubusercontent.com/nodejs/node/v24.22.1/LICENSE', sha256: digest(license) } }));
  return { ...f, root, nodePath, stage: options => stageInstallationSource({ sourceRoot: root, nodePath, platform: 'win32', ...options }) };
}

test('source distribution sanitizes machine paths and excludes runtime binaries, tests and verification artifacts', async t => {
  const f = await distributableFixture(t);
  await fs.mkdir(path.join(f.root, 'tests'));
  await fs.writeFile(path.join(f.root, 'tests', 'private-fixture.json'), 'not distributed');
  await fs.writeFile(path.join(f.root, 'queue.json'), 'not distributed');
  await fs.mkdir(path.join(f.root, 'verification'));
  await fs.writeFile(path.join(f.root, 'verification', 'local-endpoint.json'), 'not distributed');
  const payload = await distributionPayload(f.root);
  assert.deepEqual(JSON.parse(payload.find(file => file.name === '.mcp.json').bytes.toString()), portableMcpManifest());
  assert.ok(!DISTRIBUTION_INCLUDES.includes('tests'));
  assert.ok(!payload.some(file => /tests|verification|queue\.json/.test(file.name)));
  assert.ok(payload.some(file => file.name === 'runtime/node-release.json'));
  assert.ok(payload.some(file => file.name === 'runtime/LICENSE.node.txt'));
  assert.ok(!payload.some(file => file.name.endsWith('/node.exe')));
  assert.doesNotMatch(Buffer.concat(payload.map(file => file.bytes)).toString(), /developer Node|developer data/);
  await fs.writeFile(path.join(f.root, 'src', 'auth.json'), 'sensitive file, must not ship');
  await assert.rejects(distributionPayload(f.root), /本机运行数据/);
});

test('clean profile install stages its own stable local source and survives removal of the extraction folder', async t => {
  const f = await distributableFixture(t);
  const dataDir = path.join(f.directory, 'recipient profile', 'own stable data');
  await fs.mkdir(dataDir, { recursive: true });
  const staged = await f.stage({ dataDir });
  assert.equal(path.dirname(staged.root), path.join(dataDir, 'installation', 'plugin'));
  assert.match(path.basename(staged.root), /^1\.2\.3-[a-f0-9]{16}$/);
  const installed = JSON.parse(await fs.readFile(path.join(staged.root, '.mcp.json'), 'utf8')).mcpServers.codex_scheduler;
  assert.equal(installed.command, staged.nodePath);
  assert.equal(path.dirname(path.dirname(installed.command)), path.join(dataDir, 'runtime'));
  assert.notEqual(installed.command, f.nodePath);
  assert.equal(installed.cwd, await fs.realpath(dataDir));
  assert.deepEqual(installed.args, [path.join(staged.root, 'src', 'mcp-server.mjs')]);
  assert.equal((await f.stage({ dataDir })).root, staged.root);
  // Delete only this test's extraction, not the retained recipient data.
  assert.equal(path.dirname(f.root), f.directory);
  await fs.rm(f.root, { recursive: true });
  assert.equal((await inspectSchedulerSource(staged.root)).manifest.version, '1.2.3');
  await fs.access(path.join(staged.root, 'scripts', 'uninstall.mjs'));
  assert.equal(await fs.readFile(staged.nodePath, 'utf8'), 'fixture Node, never executed');
  assert.equal(await fs.readFile(path.join(path.dirname(staged.nodePath), 'LICENSE.node.txt'), 'utf8'), 'fixture upstream license');
  assert.equal(await fs.stat(path.join(staged.root, 'runtime', 'windows-x64')).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(dataDir, 'queue.json')).then(() => true, () => false), false);
});

test('existing local source is checked for tampering before reinstall and never overwritten', async t => {
  const f = await distributableFixture(t);
  const dataDir = path.join(f.directory, 'recipient data');
  await fs.mkdir(dataDir);
  const staged = await f.stage({ dataDir });
  const existingFile = path.join(staged.root, 'src', 'mcp-server.mjs');
  await fs.writeFile(existingFile, 'foreign changed file');
  await assert.rejects(f.stage({ dataDir }), /内容不符.*保留/);
  assert.equal(await fs.readFile(existingFile, 'utf8'), 'foreign changed file');
});

test('Windows stable source publication retries transient locks with a bounded backoff and then succeeds', async t => {
  const f = await distributableFixture(t);
  const dataDir = path.join(f.directory, 'recipient data');
  await fs.mkdir(dataDir);
  let attempts = 0;
  const delays = [];
  const staged = await f.stage({ dataDir, platform: 'win32',
    rename: async (from, to) => {
      const code = ['EPERM', 'EACCES', 'EBUSY'][attempts++];
      if (code) throw Object.assign(new Error('transient Windows directory lock'), { code });
      await fs.rename(from, to);
    }, delay: async ms => { delays.push(ms); },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [100, 200, 300]);
  assert.equal((await inspectSchedulerSource(staged.root)).manifest.version, '1.2.3');
});

test('persistent Windows locks stop after ten publication attempts and retain all earlier source copies', async t => {
  const f = await distributableFixture(t);
  const dataDir = path.join(f.directory, 'recipient data');
  await fs.mkdir(dataDir);
  const previous = await f.stage({ dataDir });
  const oldFile = path.join(previous.root, 'README.md');
  const oldContents = await fs.readFile(oldFile, 'utf8');
  await fs.appendFile(path.join(f.root, 'README.md'), 'updated payload');
  let attempts = 0;
  const delays = [];
  const lock = Object.assign(new Error('persistent Windows lock'), { code: 'EPERM' });
  await assert.rejects(f.stage({ dataDir, platform: 'win32',
    rename: async () => { attempts++; throw lock; }, delay: async ms => { delays.push(ms); },
  }), actual => actual === lock);
  assert.equal(attempts, 10);
  assert.deepEqual(delays, [100, 200, 300, 400, 500, 500, 500, 500, 500]);
  assert.equal(await fs.readFile(oldFile, 'utf8'), oldContents);
  assert.deepEqual(await fs.readdir(path.dirname(previous.root)), [path.basename(previous.root)]);
});

test('non-lock publication errors and other platforms fail immediately without retry', async t => {
  for (const [platform, code] of [['win32', 'ENOSPC'], ['win32', 'EXDEV'], ['linux', 'EPERM']]) {
    const f = await distributableFixture(t);
    const dataDir = path.join(f.directory, 'recipient data');
    await fs.mkdir(dataDir);
    let attempts = 0;
    const failure = Object.assign(new Error('not a retryable Windows sharing error'), { code });
    await assert.rejects(f.stage({ dataDir, platform,
      rename: async () => { attempts++; throw failure; }, delay: async () => { assert.fail('must not retry unrelated errors'); },
    }), actual => actual === failure);
    assert.equal(attempts, 1);
  }
});

test('a target appearing during Windows lock retries is validated and never overwritten', async t => {
  const f = await distributableFixture(t);
  const dataDir = path.join(f.directory, 'recipient data');
  await fs.mkdir(dataDir);
  let attempts = 0;
  let target;
  await assert.rejects(f.stage({ dataDir, platform: 'win32',
    rename: async (from, to) => {
      attempts++; target = to;
      await fs.cp(from, to, { recursive: true });
      await fs.writeFile(path.join(to, 'README.md'), 'foreign target contents');
      throw Object.assign(new Error('target appeared during sharing violation'), { code: 'EPERM' });
    }, delay: async () => {},
  }), /内容不符.*保留/);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(path.join(target, 'README.md'), 'utf8'), 'foreign target contents');
});

test('remote, missing and unrelated same-name marketplaces are never migrated', async t => {
  const f = await fixture(t);
  const root = await f.source('current');
  await assert.rejects(planMarketplaceSource({ source_type: 'git', source: 'other-source' }, { root }), /原注册已保留/);
  await assert.rejects(planMarketplaceSource({ source_type: 'local', source: path.join(f.directory, 'missing') }, { root }), /原注册已保留/);
  const wrongPlugin = await f.source('wrong-plugin', { manifest: { name: 'unrelated-plugin' } });
  await assert.rejects(planMarketplaceSource({ source_type: 'local', source: wrongPlugin }, { root }), /原注册已保留/);
  const wrongMarketplace = await f.source('wrong-marketplace', { marketplace: { name: 'somebody-else' } });
  await assert.rejects(planMarketplaceSource({ source_type: 'local', source: wrongMarketplace }, { root }), /原注册已保留/);
});

test('a marketplace with additional plugins or a plugin path outside its root is not redirected', async t => {
  const f = await fixture(t);
  const root = await f.source('current');
  const anotherRoot = await f.source('another-plugin-root');
  const sharedRoot = await f.source('shared', { marketplace: { plugins: [{ name: 'codex-scheduler', source: { source: 'local', path: '.' } }, { name: 'another-plugin', source: { source: 'local', path: '.' } }] } });
  await assert.rejects(planMarketplaceSource({ source_type: 'local', source: sharedRoot }, { root }), /原注册已保留/);
  const escaped = await f.source('escaped', { marketplace: { plugins: [{ name: 'codex-scheduler', source: { source: 'local', path: anotherRoot } }] } });
  await assert.rejects(planMarketplaceSource({ source_type: 'local', source: escaped }, { root }), /原注册已保留/);
  const nonlocal = await f.source('nonlocal', { marketplace: { plugins: [{ name: 'codex-scheduler', source: { source: 'git', path: '.' } }] } });
  await assert.rejects(planMarketplaceSource({ source_type: 'local', source: nonlocal }, { root }), /原注册已保留/);
});

test('the newly extracted source must also have the complete matching plugin identity', async t => {
  const f = await fixture(t);
  const root = await f.source('incomplete', { manifest: { mcpServers: './other-server.json' } });
  await assert.rejects(inspectSchedulerSource(root), /身份匹配/);
  await assert.rejects(planMarketplaceSource(null, { root }), /身份匹配/);
});

test('the cached MCP entrypoint uses a stable working directory that survives uninstall', async t => {
  const f = await fixture(t);
  const cachedRoot = path.join(f.directory, 'codex-home', 'plugins', 'cache', 'local-scheduler', 'codex-scheduler', '0.2.0');
  const nodePath = path.join(f.directory, 'Node Runtime', 'node.exe');
  const server = mcpManifest(nodePath, cachedRoot).mcpServers.codex_scheduler;
  assert.equal(server.command, nodePath);
  assert.deepEqual(server.args, [path.join(cachedRoot, 'src', 'mcp-server.mjs')]);
  assert.equal(server.cwd, getPaths().dataDir);
  assert.notEqual(server.cwd, cachedRoot);
  const relative = path.relative(cachedRoot, server.cwd);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'a child of the removable cache would still lock it');
  const explicitDataDir = path.join(f.directory, 'canonical data retained after uninstall');
  const explicit = mcpManifest(nodePath, cachedRoot, { dataDir: explicitDataDir }).mcpServers.codex_scheduler;
  assert.equal(explicit.cwd, explicitDataDir);
  assert.deepEqual(explicit.args, server.args);
});

async function cachedMcpFixture(t) {
  const f = await fixture(t);
  const codexHome = path.join(f.directory, 'codex-home');
  const cachedRoot = await f.source(path.join('codex-home', 'plugins', 'cache', 'local-scheduler', 'codex-scheduler', '0.1.0'), { version: '0.1.0' });
  const executablePath = path.join(f.directory, 'node.exe');
  const script = path.join(cachedRoot, 'src', 'mcp-server.mjs');
  await fs.mkdir(path.dirname(script));
  await fs.writeFile(script, '// a fake cached tool connection, never executed');
  await fs.writeFile(path.join(cachedRoot, '.mcp.json'), JSON.stringify({ mcpServers: { codex_scheduler: { command: executablePath, args: [script], cwd: cachedRoot } } }));
  const row = { pid: 43210, executablePath, argv: [executablePath, script], createdAt: '2026-10-20T00:00:00.0000000Z' };
  return { ...f, codexHome, cachedRoot, row };
}

test('cache lock recovery selects only an exact Node command backed by this plugin cache manifest', async t => {
  const f = await cachedMcpFixture(t);
  const unrelated = path.join(f.directory, 'somewhere', 'mcp-server.mjs');
  const rows = [null, f.row,
    { ...f.row, pid: process.pid },
    { ...f.row, pid: 1, argv: [f.row.executablePath, unrelated] },
    { ...f.row, pid: 2, argv: [...f.row.argv, '--extra'] },
    { ...f.row, pid: 3, argv: [f.row.executablePath, path.join(f.cachedRoot, 'src', 'daemon.mjs')] },
    { ...f.row, pid: 4, executablePath: path.join(f.directory, 'another-node.exe') },
    { ...f.row, pid: 5, argv: [f.row.executablePath, path.join(f.codexHome, 'plugins', 'cache', 'another-marketplace', 'codex-scheduler', '0.1.0', 'src', 'mcp-server.mjs')] },
  ];
  assert.deepEqual(await selectCachedSchedulerMcps(rows, { codexHome: f.codexHome }), [f.row]);
  await fs.writeFile(path.join(f.cachedRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'unrelated-plugin', version: '0.1.0', mcpServers: './.mcp.json' }));
  assert.deepEqual(await selectCachedSchedulerMcps([f.row], { codexHome: f.codexHome }), []);
});

test('verified cached MCP ownership accepts its stable data directory but rejects another directory', async t => {
  const f = await cachedMcpFixture(t);
  const dataDir = path.join(f.directory, 'stable task data');
  await fs.mkdir(dataDir);
  const configFile = path.join(f.cachedRoot, '.mcp.json');
  const server = { command: f.row.executablePath, args: [f.row.argv[1]], cwd: dataDir };
  await fs.writeFile(configFile, JSON.stringify({ mcpServers: { codex_scheduler: server } }));
  assert.deepEqual(await selectCachedSchedulerMcps([f.row], { codexHome: f.codexHome, dataDir }), [f.row]);
  assert.deepEqual(await selectCachedSchedulerMcps([f.row], { codexHome: f.codexHome, dataDir: f.directory }), []);
});

test('cached MCP cleanup awaits only verified owners and leaves cache metadata intact for uninstall', async t => {
  const f = await cachedMcpFixture(t);
  const otherOwner = { ...f.row, pid: f.row.pid + 1 };
  const manifestFile = path.join(f.cachedRoot, '.codex-plugin', 'plugin.json');
  const manifestBefore = await fs.readFile(manifestFile, 'utf8');
  const events = [];
  await stopCachedSchedulerMcps({
    codexHome: f.codexHome,
    listProcesses: async () => { events.push('inspect'); return [f.row, { ...f.row, pid: 99, argv: [...f.row.argv, '--foreign'] }, otherOwner]; },
    stopProcess: async row => { events.push(`stop-start-${row.pid}`); await Promise.resolve(); events.push(`stop-complete-${row.pid}`); },
  });
  assert.deepEqual(events, ['inspect', `stop-start-${f.row.pid}`, `stop-complete-${f.row.pid}`, `stop-start-${otherOwner.pid}`, `stop-complete-${otherOwner.pid}`]);
  assert.equal(await fs.readFile(manifestFile, 'utf8'), manifestBefore);
});

test('cached MCP cleanup does not stop commands whose ownership proof is already missing', async t => {
  const f = await cachedMcpFixture(t);
  await fs.unlink(path.join(f.cachedRoot, '.codex-plugin', 'plugin.json'));
  await stopCachedSchedulerMcps({
    codexHome: f.codexHome, listProcesses: async () => [f.row],
    stopProcess: async () => { assert.fail('missing metadata must not trigger termination'); },
  });
});

test('a known Windows backup access denial stops only validated plugin connections and retries installation once', async t => {
  const f = await cachedMcpFixture(t);
  let requests = 0;
  const stopped = [];
  const params = { marketplacePath: 'fake-source', pluginName: 'codex-scheduler' };
  const client = { async request(method, actual) {
    assert.equal(method, 'plugin/install'); assert.deepEqual(actual, params);
    if (++requests === 1) throw new Error('failed to back up plugin cache entry: 拒绝访问。 (os error 5)');
    return { installed: true };
  } };
  const result = await installPluginWithRecovery(client, params, {
    platform: 'win32', codexHome: f.codexHome,
    listProcesses: async () => [f.row, { ...f.row, pid: 99, argv: [f.row.executablePath, 'unrelated.mjs'] }],
    stopProcess: async row => stopped.push(row.pid), delay: async () => {}, log: () => {},
  });
  assert.deepEqual(result, { installed: true });
  assert.deepEqual(stopped, [f.row.pid]);
  assert.equal(requests, 2);
  assert.ok(await fs.stat(f.cachedRoot));
});

test('unrelated install failures and unverified cache owners never trigger process termination or retry', async t => {
  const f = await cachedMcpFixture(t);
  for (const [message, rows] of [['some other install error', [f.row]], ['failed to back up plugin cache entry: os error 5', []]]) {
    let requests = 0; let stopped = 0;
    const error = new Error(message);
    const client = { async request() { requests++; throw error; } };
    await assert.rejects(installPluginWithRecovery(client, {}, {
      platform: 'win32', codexHome: f.codexHome, listProcesses: async () => rows,
      stopProcess: async () => { stopped++; }, delay: async () => {}, log: () => {},
    }), actual => actual === error);
    assert.equal(requests, 1); assert.equal(stopped, 0);
  }
});

test('cache recovery stops after its single retry if the replacement install also fails', async t => {
  const f = await cachedMcpFixture(t);
  let requests = 0; let stopped = 0;
  const client = { async request() { requests++; throw new Error('failed to back up plugin cache entry: os error 5'); } };
  await assert.rejects(installPluginWithRecovery(client, {}, {
    platform: 'win32', codexHome: f.codexHome, listProcesses: async () => [f.row],
    stopProcess: async () => { stopped++; }, delay: async () => {}, log: () => {},
  }), /failed to back up/);
  assert.equal(requests, 2); assert.equal(stopped, 1);
});

test('a successful installation never inspects or stops cached processes', async () => {
  const params = { marketplacePath: 'source with spaces', pluginName: 'codex-scheduler' };
  const response = { installed: true };
  const calls = [];
  const client = { async request(...args) { calls.push(args); return response; } };
  const unexpected = async () => { assert.fail('successful installation must not enter lock recovery'); };
  assert.equal(await installPluginWithRecovery(client, params, {
    platform: 'win32', listProcesses: unexpected, stopProcess: unexpected, delay: unexpected, log: unexpected,
  }), response);
  assert.deepEqual(calls, [['plugin/install', params, 90000]]);
});

test('a Windows-shaped backup error on another platform never triggers process inspection', async () => {
  const error = new Error('failed to back up plugin cache entry: access denied (os error 5)');
  let requests = 0;
  const unexpected = async () => { assert.fail('Windows recovery must not run on another platform'); };
  await assert.rejects(installPluginWithRecovery({ async request() { requests++; throw error; } }, {}, {
    platform: 'linux', listProcesses: unexpected, stopProcess: unexpected, delay: unexpected, log: unexpected,
  }), actual => actual === error);
  assert.equal(requests, 1);
});

test('cache metadata lost during uninstall is not permission to stop a leftover process', async t => {
  for (const missing of ['manifest', 'mcp', 'script']) {
    const f = await cachedMcpFixture(t);
    const file = missing === 'manifest' ? path.join(f.cachedRoot, '.codex-plugin', 'plugin.json')
      : missing === 'mcp' ? path.join(f.cachedRoot, '.mcp.json') : f.row.argv[1];
    await fs.unlink(file);
    assert.deepEqual(await selectCachedSchedulerMcps([f.row], { codexHome: f.codexHome }), [], missing);
  }
});

test('a stale or partially rewritten cache command is never treated as a verified owner', async t => {
  const f = await cachedMcpFixture(t);
  const configFile = path.join(f.cachedRoot, '.mcp.json');
  const valid = { command: f.row.executablePath, args: [f.row.argv[1]], cwd: f.cachedRoot };
  for (const server of [
    { ...valid, command: path.join(f.directory, 'different', 'node.exe') },
    { ...valid, args: [] },
    { ...valid, args: [...valid.args, '--unexpected'] },
    { ...valid, cwd: f.directory },
    null,
  ]) {
    await fs.writeFile(configFile, JSON.stringify({ mcpServers: { codex_scheduler: server } }));
    assert.deepEqual(await selectCachedSchedulerMcps([f.row], { codexHome: f.codexHome }), []);
  }
  await fs.writeFile(configFile, '{partial json');
  assert.deepEqual(await selectCachedSchedulerMcps([f.row], { codexHome: f.codexHome }), []);
});

test('cache recovery awaits the verified owner shutdown and release delay before installing again', async t => {
  const f = await cachedMcpFixture(t);
  const events = [];
  let requests = 0;
  const params = { marketplacePath: 'same source', pluginName: 'codex-scheduler' };
  const client = { async request(method, actual, timeout) {
    assert.equal(method, 'plugin/install'); assert.equal(actual, params); assert.equal(timeout, 90000);
    events.push(`request-${++requests}`);
    if (requests === 1) throw new Error('failed to back up plugin cache entry: access is denied (os error 5)');
    return { installed: true };
  } };
  await installPluginWithRecovery(client, params, {
    platform: 'win32', codexHome: f.codexHome,
    listProcesses: async () => { events.push('inspect'); return [f.row]; },
    stopProcess: async row => { assert.equal(row, f.row); events.push('stop-start'); await Promise.resolve(); events.push('stop-complete'); },
    delay: async ms => { assert.equal(ms, 300); events.push('release-start'); await Promise.resolve(); events.push('release-complete'); },
    log: () => {},
  });
  assert.deepEqual(events, ['request-1', 'inspect', 'stop-start', 'stop-complete', 'release-start', 'release-complete', 'request-2']);
});

test('failure to release a verified owner aborts recovery without retrying installation', async t => {
  const f = await cachedMcpFixture(t);
  let requests = 0;
  const releaseError = new Error('verified process could not be stopped');
  await assert.rejects(installPluginWithRecovery({ async request() {
    requests++;
    throw new Error('failed to back up plugin cache entry: os error 5');
  } }, {}, {
    platform: 'win32', codexHome: f.codexHome,
    listProcesses: async () => [f.row], stopProcess: async () => { throw releaseError; },
    delay: async () => { assert.fail('an unreleased owner must not be followed by retry'); }, log: () => {},
  }), actual => actual === releaseError);
  assert.equal(requests, 1);
});

test('uninstall closes verified cached MCP connections before Codex removes their identity metadata', async () => {
  const events = [];
  const client = { async request(method, params, timeout) {
    events.push('uninstall');
    assert.equal(method, 'plugin/uninstall');
    assert.deepEqual(params, { pluginId: 'codex-scheduler@local-scheduler' });
    assert.equal(timeout, 90000);
    return { uninstalled: true };
  } };
  await uninstallPluginWithCleanup(client, {
    stopCachedMcps: async () => { events.push('stop-start'); await Promise.resolve(); events.push('stop-complete'); },
    removeLaunchers: async () => { events.push('remove-shortcuts'); return { removed: [], preserved: [] }; },
  });
  assert.deepEqual(events, ['stop-start', 'stop-complete', 'uninstall', 'remove-shortcuts']);
});

test('uninstall aborts before deleting cache identity when a verified connection cannot be closed', async () => {
  const error = new Error('verified cached MCP process did not exit');
  const events = [];
  await assert.rejects(uninstallPluginWithCleanup({ async request() { events.push('uninstall'); } }, {
    stopCachedMcps: async () => { events.push('stop'); throw error; },
    removeLaunchers: async () => { events.push('remove-shortcuts'); },
  }), actual => actual === error);
  assert.deepEqual(events, ['stop']);
});

test('failed Codex uninstall retains the existing manager launchers for retry', async () => {
  const error = new Error('Codex refused plugin/uninstall');
  const events = [];
  await assert.rejects(uninstallPluginWithCleanup({ async request() {
    events.push('uninstall'); throw error;
  } }, {
    stopCachedMcps: async () => { events.push('stop'); },
    removeLaunchers: async () => { events.push('remove-shortcuts'); },
  }), actual => actual === error);
  assert.deepEqual(events, ['stop', 'uninstall']);
});

test('a clean profile skips Windows process discovery when no readable scheduler cache exists', async t => {
  const f = await fixture(t);
  const result = await stopCachedSchedulerMcps({ codexHome: path.join(f.directory, 'new Codex profile'), dataDir: f.directory,
    listProcesses: async () => assert.fail('fresh installs must not depend on CIM permissions'),
    stopProcess: async () => assert.fail('no cached connection exists'),
    log: () => assert.fail('a clean cache is not an inspection failure'),
  });
  assert.deepEqual(result, { stopped: 0 });
});

test('missing or unrelated cache metadata skips process discovery without changing retained files', async t => {
  for (const invalid of ['missing-script', 'foreign-plugin', 'missing-config']) {
    const f = await cachedMcpFixture(t);
    if (invalid === 'missing-script') await fs.unlink(f.row.argv[1]);
    if (invalid === 'missing-config') await fs.unlink(path.join(f.cachedRoot, '.mcp.json'));
    if (invalid === 'foreign-plugin') await fs.writeFile(path.join(f.cachedRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'unrelated', version: '0.1.0' }));
    const before = await fs.readFile(path.join(f.cachedRoot, '.codex-plugin', 'plugin.json'));
    assert.deepEqual(await stopCachedSchedulerMcps({ codexHome: f.codexHome, dataDir: f.directory,
      listProcesses: async () => assert.fail('unverified cache cannot authorize inspection'),
      stopProcess: async () => assert.fail('unverified cache cannot authorize termination'),
    }), { stopped: 0 });
    assert.deepEqual(await fs.readFile(path.join(f.cachedRoot, '.codex-plugin', 'plugin.json')), before);
  }
});

test('denied CIM inspection leaves every process and cache intact while allowing Codex to determine the install result', async t => {
  const f = await cachedMcpFixture(t);
  const before = await fs.readFile(path.join(f.cachedRoot, '.mcp.json'));
  const warnings = [];
  const result = await stopCachedSchedulerMcps({ codexHome: f.codexHome,
    listProcesses: async () => { throw Object.assign(new Error('CIM access denied'), { code: 'EACCES' }); },
    stopProcess: async () => assert.fail('permission failure never authorizes termination'),
    log: message => warnings.push(message),
  });
  assert.deepEqual(result, { stopped: 0, inspectionUnavailable: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /保留全部进程.*Codex.*核验/);
  assert.deepEqual(await fs.readFile(path.join(f.cachedRoot, '.mcp.json')), before);
});

test('a restricted-token CIM row missing its executable path is never considered a verified owner', async t => {
  const f = await cachedMcpFixture(t);
  assert.deepEqual(await stopCachedSchedulerMcps({ codexHome: f.codexHome,
    listProcesses: async () => [{ ...f.row, executablePath: null }],
    stopProcess: async () => assert.fail('missing process identity never authorizes termination'),
  }), { stopped: 0 });
});

test('failure to stop a fully verified connection still fails instead of treating it as optional CIM inspection', async t => {
  const f = await cachedMcpFixture(t);
  const error = Object.assign(new Error('cannot stop elevated connection'), { code: 'EPERM' });
  await assert.rejects(stopCachedSchedulerMcps({ codexHome: f.codexHome,
    listProcesses: async () => [f.row], stopProcess: async () => { throw error; },
    log: () => assert.fail('a known termination failure must not become a warning'),
  }), actual => actual === error);
});

test('CIM denial during lock recovery preserves the actual Codex install failure without retrying or killing', async () => {
  const original = new Error('failed to back up plugin cache entry: access denied (os error 5)');
  let attempts = 0;
  const warnings = [];
  await assert.rejects(installPluginWithRecovery({ async request() { attempts++; throw original; } }, {}, {
    platform: 'win32', listProcesses: async () => { throw new Error('CIM permission denied'); },
    stopProcess: async () => assert.fail('inspection failed'), delay: async () => assert.fail('no retry'),
    log: message => warnings.push(message),
  }), actual => actual === original);
  assert.equal(attempts, 1);
  assert.match(warnings[0], /未终止任何进程.*安装错误已保留/);
});

test('desktop permission or foreign shortcut failures report only an optional entrypoint warning', async () => {
  for (const error of [Object.assign(new Error('desktop access denied'), { code: 'EACCES' }), new Error('已有其他用途的同名快捷方式，未覆盖')]) {
    const messages = [];
    const options = { installedRoot: 'already verified local cache', nodePath: 'verified stable runtime' };
    assert.deepEqual(await installOptionalManagerLaunchers(options, {
      installLaunchers: async actual => { assert.equal(actual, options); throw error; },
      log: message => messages.push(message),
    }), { installed: false, warning: true });
    assert.equal(messages.length, 2);
    assert.match(messages[0], /插件已安装并验证通过.*入口未创建/);
    assert.ok(messages[0].includes(error.message));
    assert.match(messages[1], /Codex.*时序插件入口.*打开管理器/);
  }
});

test('successful optional entrypoint creation returns the verified shortcut result unchanged', async () => {
  const messages = [];
  const entries = { installed: true, shortcuts: ['mock user desktop shortcut', 'mock user start menu shortcut'] };
  assert.equal(await installOptionalManagerLaunchers({}, {
    installLaunchers: async () => entries, log: message => messages.push(message),
  }), entries);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /已创建桌面和开始菜单/);
});
