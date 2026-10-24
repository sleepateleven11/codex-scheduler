import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildBrowserCommand, buildWindowsLauncherPlan, ownsManagerShortcut, parseOpenArgs, launchBrowser, installManagerLaunchers, removeManagerLaunchers } from '../src/launcher.mjs';
import { openManager } from '../scripts/open.mjs';
import { buildManagerIcon } from '../src/launcher-icon.mjs';

const token = 'a'.repeat(64);
const url = `http://127.0.0.1:12345/?token=${token}`;
const planOptions = {
  installedRoot: "C:\\用户\\插件缓存\\0.2.0",
  nodePath: "D:\\O'Brien Node\\node.exe", dataDir: 'C:\\用户\\本机数据\\时序',
  desktopDir: 'C:\\用户\\桌面', programsDir: 'C:\\用户\\开始菜单\\程序', systemRoot: 'C:\\Windows', env: {},
};

test('open arguments accept the browser default and an explicit automation-only URL mode', () => {
  assert.deepEqual(parseOpenArgs([]), { urlOnly: false });
  assert.deepEqual(parseOpenArgs(['--url']), { urlOnly: true });
  for (const args of [['--url', '--url'], ['--port=80'], ['http://example.com']]) assert.throws(() => parseOpenArgs(args), /仅支持/);
});

test('the browser command passes the dashboard as a single argument without a shell', async () => {
  assert.deepEqual(buildBrowserCommand(url, 'win32'), { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] });
  assert.deepEqual(buildBrowserCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(buildBrowserCommand(url, 'linux'), { command: 'xdg-open', args: [url] });
  let unreferenced = false;
  await launchBrowser(url, { platform: 'win32', spawnProcess(command, args, options) {
    assert.equal(command, 'rundll32.exe');
    assert.deepEqual(args, ['url.dll,FileProtocolHandler', url]);
    assert.deepEqual(options, { detached: true, windowsHide: true, stdio: 'ignore', shell: false });
    const child = new EventEmitter(); child.unref = () => { unreferenced = true; };
    queueMicrotask(() => child.emit('spawn')); return child;
  } });
  assert.equal(unreferenced, true);
});

test('browser launch rejects a foreign URL or malformed dashboard before starting any process', () => {
  for (const value of ['https://example.com/', `http://localhost:12345/?token=${token}`, `http://127.0.0.1:12345/admin?token=${token}`, `http://127.0.0.1:12345/?token=${token}&token=${token}`, `http://127.0.0.1:12345/?token=${token}&run=anything`, 'http://127.0.0.1:12345/?token=invalid']) {
    assert.throws(() => buildBrowserCommand(value, 'win32'));
  }
});

test('opening probes the desktop connection without printing the dashboard token', async () => {
  const calls = [];
  const endpoint = { port: 12345, token };
  const result = await openManager({
    ensure: async () => { calls.push('ensure'); return endpoint; },
    reconnect: async value => { assert.equal(value, endpoint); calls.push('reconnect'); return { desktop: { connected: true } }; },
    launch: async value => { assert.equal(value, url); calls.push('browser'); },
    print: () => assert.fail('normal launcher must not print its bearer URL'),
  });
  assert.deepEqual(calls, ['ensure', 'reconnect', 'browser']);
  assert.equal(result.opened, true); assert.equal(result.connection.desktop.connected, true);
});

test('a disconnected desktop still opens the management page and reports the actual connection failure', async () => {
  let opened = false;
  const result = await openManager({ ensure: async () => ({ port: 12345, token }), reconnect: async () => { throw new Error('桌面连接已过期'); }, launch: async () => { opened = true; } });
  assert.equal(opened, true); assert.equal(result.connection.desktop.connected, false);
  assert.equal(result.connection.desktop.message, '桌面连接已过期');
});

test('URL mode prints the current URL once and never opens a browser', async () => {
  const printed = [];
  const result = await openManager({ ensure: async () => ({ port: 12345, token }), reconnect: async () => ({ desktop: { connected: false } }), urlOnly: true, print: value => printed.push(value), launch: () => assert.fail('URL-only automation must not open a browser') });
  assert.deepEqual(printed, [url]); assert.equal(result.opened, false);
});

test('hidden Windows entrypoints quote Unicode and spaces and store only allowlisted local paths', () => {
  const plan = buildWindowsLauncherPlan({ ...planOptions, env: { CODEX_HOME: 'C:\\本机 配置\\.codex', OPENAI_API_KEY: 'secret-key', CODEX_APP_TOOLS_PIPE_PATH: 'ephemeral-pipe', CODEX_TOOL_CALL_ID: 'historic-call', OTHER_TOKEN: token } });
  assert.equal(plan.targetPath, 'C:\\Windows\\System32\\wscript.exe');
  assert.deepEqual(plan.shortcuts, ['C:\\用户\\桌面\\时序任务管理器.lnk', 'C:\\用户\\开始菜单\\程序\\时序任务管理器.lnk']);
  assert.equal(plan.arguments, '"C:\\用户\\本机数据\\时序\\manager-launcher.vbs"');
  assert.ok(plan.launcherSource.includes('""D:\\O\'Brien Node\\node.exe"" ""C:\\用户\\插件缓存\\0.2.0\\scripts\\open.mjs""'));
  assert.ok(plan.launcherSource.includes(', 0, True)'));
  assert.ok(plan.launcherSource.includes('processEnv("CODEX_HOME") = "C:\\本机 配置\\.codex"'));
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'PSModulePath']) assert.ok(plan.launcherSource.includes(`processEnv.Remove "${key}"`));
  for (const forbidden of ['secret-key', 'OPENAI_API_KEY', 'ephemeral-pipe', 'CODEX_TOOL_CALL_ID', token, '?token=', '127.0.0.1']) assert.ok(!plan.launcherSource.includes(forbidden), forbidden);
  assert.equal(buildWindowsLauncherPlan({ ...planOptions, dataDir: planOptions.dataDir.toUpperCase() }).scope, plan.scope);
  for (const change of [{ installedRoot: 'relative' }, { nodePath: 'C:\\python.exe' }, { desktopDir: 'C:\\bad\npath' }, { dataDir: 'C:\\invalid"path' }]) assert.throws(() => buildWindowsLauncherPlan({ ...planOptions, ...change }));
});

test('shortcut ownership requires this data scope, the exact launcher arguments, and the expected system target', () => {
  const plan = buildWindowsLauncherPlan(planOptions);
  const own = { description: plan.description, targetPath: plan.targetPath, arguments: plan.arguments };
  assert.equal(ownsManagerShortcut(own, plan), true);
  assert.equal(ownsManagerShortcut({ ...own, targetPath: own.targetPath.toUpperCase() }, plan), true);
  for (const changed of [null, { ...own, description: 'another app' }, { ...own, arguments: 'different.vbs' }, { ...own, targetPath: 'C:\\another\\wscript.exe' }]) assert.equal(ownsManagerShortcut(changed, plan), false);
});

test('the hourglass icon is a standalone 32-bit Windows icon with visible pixels and transparent corners', () => {
  const icon = buildManagerIcon();
  assert.equal(icon.readUInt16LE(2), 1); assert.equal(icon.readUInt16LE(4), 1);
  assert.equal(icon[6], 32); assert.equal(icon[7], 32);
  assert.equal(icon.readUInt16LE(12), 32);
  const bitmapStart = icon.readUInt32LE(18);
  assert.equal(icon.length, bitmapStart + icon.readUInt32LE(14));
  assert.equal(icon.readUInt32LE(bitmapStart), 40);
  assert.equal(icon[bitmapStart + 40 + 3], 0);
  assert.equal(icon[bitmapStart + 40 + (16 * 32 + 16) * 4 + 3], 255);
  assert.deepEqual(icon, buildManagerIcon());
});

const exec = promisify(execFile);
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
async function executePowerShell(script) {
  const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);\n${script}`, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
  return stdout.trim() ? JSON.parse(stdout.trim()) : {};
}

async function isolatedWindowsEntries(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-launcher-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const options = { installedRoot: path.join(directory, "中文 O'Brien 缓存", '0.2.0'), dataDir: path.join(directory, '本机数据'), nodePath: process.execPath, env: {} };
  const dirs = { desktopDir: path.join(directory, '桌面'), programsDir: path.join(directory, '开始菜单'), systemRoot: process.env.SystemRoot };
  await fs.mkdir(path.join(options.installedRoot, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(options.installedRoot, 'scripts', 'open.mjs'), '// isolated fake launcher, never executed');
  await fs.mkdir(options.dataDir, { recursive: true });
  await fs.mkdir(dirs.desktopDir); await fs.mkdir(dirs.programsDir);
  const runPowerShell = script => script.includes("SpecialFolders.Item('Desktop')") ? Promise.resolve(dirs) : executePowerShell(script);
  return { options: { ...options, runPowerShell }, plan: buildWindowsLauncherPlan({ ...options, ...dirs }) };
}

test('Windows install creates real shortcuts in an isolated directory that point into the installed cache', { skip: process.platform !== 'win32' }, async t => {
  const { options, plan } = await isolatedWindowsEntries(t);
  const result = await installManagerLaunchers(options);
  assert.equal(result.installed, true); assert.deepEqual(result.shortcuts, plan.shortcuts);
  const launcher = await fs.readFile(plan.launcherPath);
  assert.equal(launcher[0], 0xff); assert.equal(launcher[1], 0xfe);
  assert.equal(launcher.toString('utf16le').replace(/^\uFEFF/, ''), plan.launcherSource);
  assert.deepEqual(await fs.readFile(plan.iconPath), buildManagerIcon());
  const links = await executePowerShell(`$shell = New-Object -ComObject WScript.Shell; @(${plan.shortcuts.map(psQuote).join(',')}) | ForEach-Object { $link=$shell.CreateShortcut($_); @{ targetPath=$link.TargetPath; arguments=$link.Arguments; description=$link.Description } } | ConvertTo-Json -Compress`);
  assert.equal(links.length, 2);
  for (const link of links) assert.equal(ownsManagerShortcut(link, plan), true);
  // Execute only the isolated dummy open script, never the real manager, to
  // verify the VBS command actually survives Unicode, spaces and apostrophes.
  await fs.writeFile(path.join(options.installedRoot, 'scripts', 'open.mjs'), "import fs from 'node:fs'; fs.writeFileSync(process.env.SCHEDULER_DATA_DIR + '/launch-proof.json', JSON.stringify({ cwd: process.cwd(), dataDir: process.env.SCHEDULER_DATA_DIR }));");
  await exec(plan.targetPath, ['//B', '//Nologo', plan.launcherPath], { windowsHide: true, timeout: 10000 });
  const proof = JSON.parse(await fs.readFile(path.join(options.dataDir, 'launch-proof.json'), 'utf8'));
  assert.equal(proof.cwd, options.installedRoot); assert.equal(proof.dataDir, options.dataDir);
  assert.equal((await installManagerLaunchers(options)).installed, true);
});

test('Windows install refuses a foreign same-name shortcut before writing its launcher or changing either link', { skip: process.platform !== 'win32' }, async t => {
  const { options, plan } = await isolatedWindowsEntries(t);
  await executePowerShell(`$shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut(${psQuote(plan.shortcuts[1])}); $link.TargetPath='C:\\Windows\\notepad.exe'; $link.Description='unrelated'; $link.Save(); @{ created=$true } | ConvertTo-Json -Compress`);
  const before = await fs.readFile(plan.shortcuts[1]);
  await assert.rejects(installManagerLaunchers(options), /同名快捷方式/);
  assert.equal(await fs.stat(plan.launcherPath).catch(() => null), null);
  assert.equal(await fs.stat(plan.iconPath).catch(() => null), null);
  assert.equal(await fs.stat(plan.shortcuts[0]).catch(() => null), null);
  assert.deepEqual(await fs.readFile(plan.shortcuts[1]), before);
});

test('Windows uninstall removes only owned links and leaves another same-name link and queue data intact', { skip: process.platform !== 'win32' }, async t => {
  const { options, plan } = await isolatedWindowsEntries(t);
  await installManagerLaunchers(options);
  const queuePath = path.join(options.dataDir, 'queue.json');
  await fs.writeFile(queuePath, '{"existing":"preserved"}');
  await executePowerShell(`$shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut(${psQuote(plan.shortcuts[0])}); $link.Description='another app now owns this'; $link.Save(); @{ changed=$true } | ConvertTo-Json -Compress`);
  const before = await fs.readFile(plan.shortcuts[0]);
  const result = await removeManagerLaunchers(options);
  assert.deepEqual(result.removed, [plan.shortcuts[1]]); assert.deepEqual(result.preserved, [plan.shortcuts[0]]);
  assert.deepEqual(await fs.readFile(plan.shortcuts[0]), before);
  assert.equal(await fs.stat(plan.shortcuts[1]).catch(() => null), null);
  assert.equal(await fs.stat(plan.launcherPath).catch(() => null), null);
  assert.equal(await fs.stat(plan.iconPath).catch(() => null), null);
  assert.equal(await fs.readFile(queuePath, 'utf8'), '{"existing":"preserved"}');
});

test('Windows install preserves a foreign launcher with the same filename', { skip: process.platform !== 'win32' }, async t => {
  const { options, plan } = await isolatedWindowsEntries(t);
  const foreign = Buffer.from('\uFEFF\' owned by another app\r\n', 'utf16le');
  await fs.writeFile(plan.launcherPath, foreign);
  await assert.rejects(installManagerLaunchers(options), /同名管理器启动文件属于其他用途/);
  assert.deepEqual(await fs.readFile(plan.launcherPath), foreign);
  for (const shortcut of plan.shortcuts) assert.equal(await fs.stat(shortcut).catch(() => null), null);
});
