import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const license = 'Isolated Node.js entrypoint fixture license.\n';
let runtimePromise;

async function fixtureRuntime() {
  return runtimePromise ||= (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-scheduler-entry-node-'));
    const nodePath = path.join(directory, 'node.exe');
    await fs.copyFile(process.execPath, nodePath);
    return { directory, nodePath, hash: sha256(await fs.readFile(nodePath)) };
  })();
}
after(async () => {
  if (!runtimePromise) return;
  const runtime = await runtimePromise;
  assert.equal(path.dirname(path.resolve(runtime.directory)), path.resolve(os.tmpdir()));
  await fs.rm(runtime.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function fixture(t, action, exitCode, { bundled = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-scheduler-entry-test-'));
  const packageRoot = path.join(directory, "中文 空格 & () ' ! % [package]");
  await fs.mkdir(packageRoot);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const name = action === 'install' ? '安装插件.cmd' : '卸载插件.cmd';
  const entry = path.join(packageRoot, name);
  await fs.copyFile(path.join(root, name), entry);
  if (exitCode !== undefined) {
    const runtime = await fixtureRuntime();
    for (const folder of ['scripts', 'src', '.codex-plugin', '.agents/plugins', `runtime/windows-${process.arch}`]) await fs.mkdir(path.join(packageRoot, folder), { recursive: true });
    for (const file of ['package.json', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json']) await fs.writeFile(path.join(packageRoot, file), '{}');
    for (const file of ['src/paths.mjs', 'src/runtime.mjs']) await fs.writeFile(path.join(packageRoot, file), '// fixture only');
    await fs.copyFile(path.join(root, 'scripts/bootstrap.ps1'), path.join(packageRoot, 'scripts/bootstrap.ps1'));
    if (bundled) await fs.link(runtime.nodePath, path.join(packageRoot, `runtime/windows-${process.arch}/node.exe`));
    await fs.writeFile(path.join(packageRoot, 'runtime/LICENSE.node.txt'), license);
    await fs.writeFile(path.join(packageRoot, 'runtime/node-release.json'), JSON.stringify({
      version: process.versions.node,
      platforms: Object.fromEntries(['x64', 'arm64'].map(arch => [`win-${arch}`, {
        url: `https://nodejs.org/dist/v${process.versions.node}/win-${arch}/node.exe`, sha256: runtime.hash,
      }])),
      license: { file: 'LICENSE.node.txt', sha256: sha256(license), source: `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE` },
    }));
    // This harmless script is the only installer the wrapper can execute.
    await fs.writeFile(path.join(packageRoot, 'scripts', `${action}.mjs`), `console.log('ENTRY-FIXTURE:' + JSON.stringify({node:process.execPath,args:process.argv.slice(2),nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,selected:process.env.CODEX_SCHEDULER_NODE_PATH,psModules:process.env.PSModulePath})); process.exit(${exitCode});\n`);
  }
  return { directory, packageRoot, entry, dataDir: path.join(directory, 'user-data'), codexHome: path.join(directory, 'codex-home') };
}

async function run(command, args, { directory, env, verbatim = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: directory, windowsHide: true,
      windowsVerbatimArguments: verbatim, shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => output.push(chunk));
    child.stdin.on('error', () => {});
    child.stdin.end('\r\n');
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Windows entry fixture timed out')); }, 30000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output: Buffer.concat(output).toString('utf8') }); });
  });
}

function environment(f, extra = {}) {
  return { ...process.env,
    PATH: [path.join(process.env.SystemRoot, 'System32'), path.dirname(powershell)].join(path.delimiter),
    SCHEDULER_DATA_DIR: f.dataDir, CODEX_HOME: f.codexHome, ...extra };
}

async function runEntry(f, { flags = ['--no-pause'], env = {} } = {}) {
  // No CALL: CALL reparses percent signs in a user's extraction-folder name.
  return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${f.entry}" ${flags.join(' ')}"`], {
    directory: f.directory, env: environment(f, env), verbatim: true,
  });
}

async function runBootstrapFunctions(f, command, env = {}) {
  const bootstrap = path.join(root, 'scripts/bootstrap.ps1').replaceAll("'", "''");
  const encoded = Buffer.from(`. '${bootstrap}'; ${command}`, 'utf16le').toString('base64');
  return run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    directory: f.directory, env: environment(f, env),
  });
}

function receipt(result) {
  const found = result.output.match(/ENTRY-FIXTURE:(\{[^\r\n]+\})/);
  assert.ok(found, result.output);
  return JSON.parse(found[1]);
}

for (const action of ['install', 'uninstall']) {
  test(`${action} CMD rejects a compressed-folder style entry without adjacent payload`, { skip: !windows }, async t => {
    const f = await fixture(t, action);
    const source = await fs.readFile(f.entry, 'utf8');
    assert.equal(source.replaceAll('\r\n', '').includes('\n'), false, 'Windows CMD entry uses CRLF');
    const result = await runEntry(f);
    assert.equal(result.code, 1);
    assert.match(result.output, /未执行/);
    assert.match(result.output, /全部解压缩/);
    assert.doesNotMatch(result.output, /MODULE_NOT_FOUND|ENTRY-FIXTURE/);
  });

  for (const exitCode of [0, 37]) {
    test(`${action} CMD uses a verified bundled runtime without Node in PATH and preserves exit ${exitCode}`, { skip: !windows }, async t => {
      const f = await fixture(t, action, exitCode);
      const result = await runEntry(f, { env: { NODE_OPTIONS: '--require nonexistent-bootstrap-preload', NODE_PATH: 'nonexistent-module-path' } });
      assert.equal(result.code, exitCode, result.output);
      const record = receipt(result);
      assert.ok(record.node.startsWith(`${f.dataDir}${path.sep}runtime${path.sep}`));
      assert.equal(record.node, record.selected);
      assert.equal(record.nodeOptions, null);
      assert.equal(record.nodePath, null);
      assert.deepEqual(record.args, []);
      assert.doesNotMatch(result.output, /未执行|MODULE_NOT_FOUND/);
      assert.equal(await fs.readFile(path.join(path.dirname(record.node), 'LICENSE.node.txt'), 'utf8'), license);
    });
  }
}

test('bootstrap keeps UTF-8 BOM so Windows PowerShell 5.1 reads Chinese diagnostics correctly', async () => {
  const bytes = await fs.readFile(path.join(root, 'scripts/bootstrap.ps1'));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('install CMD forwards dry-run without creating a real Codex installation', { skip: !windows }, async t => {
  const result = await runEntry(await fixture(t, 'install', 0), { flags: ['--dry-run', '--no-pause'] });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(receipt(result).args, ['--dry-run']);
});

test('uninstall CMD refuses dry-run rather than accidentally uninstalling', { skip: !windows }, async t => {
  const result = await runEntry(await fixture(t, 'uninstall', 0), { flags: ['--dry-run', '--no-pause'] });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /未执行卸载/);
  assert.doesNotMatch(result.output, /ENTRY-FIXTURE/);
});

test('install CMD reuses verified per-user runtime after extracted bundle is removed', { skip: !windows }, async t => {
  const f = await fixture(t, 'install', 0);
  const first = await runEntry(f);
  assert.equal(first.code, 0, first.output);
  const firstRecord = receipt(first);
  await fs.unlink(path.join(f.packageRoot, `runtime/windows-${process.arch}/node.exe`));
  const second = await runEntry(f);
  assert.equal(second.code, 0, second.output);
  assert.equal(receipt(second).node, firstRecord.node);
});

test('bootstrap rejects tampered bundled runtime before executing it or the installer', { skip: !windows }, async t => {
  const f = await fixture(t, 'install', 0);
  const bundled = path.join(f.packageRoot, `runtime/windows-${process.arch}/node.exe`);
  await fs.unlink(bundled); // Do not modify the shared hard-linked fixture.
  await fs.writeFile(bundled, 'untrusted executable marker');
  const result = await runEntry(f);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /校验失败/);
  assert.doesNotMatch(result.output, /ENTRY-FIXTURE/);
  await assert.rejects(fs.access(f.dataDir), { code: 'ENOENT' });
});

test('bootstrap rejects nonofficial metadata download host before making a request', { skip: !windows }, async t => {
  const f = await fixture(t, 'install', 0, { bundled: false });
  const file = path.join(f.packageRoot, 'runtime/node-release.json');
  const release = JSON.parse(await fs.readFile(file, 'utf8'));
  release.platforms[`win-${process.arch}`].url = 'https://example.invalid/node.exe';
  await fs.writeFile(file, JSON.stringify(release));
  const result = await runEntry(f);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /下载地址或校验值无效/);
  assert.doesNotMatch(result.output, /ENTRY-FIXTURE|正在从/);
});

test('bootstrap preserves a damaged stable cache rather than overwriting it', { skip: !windows }, async t => {
  const f = await fixture(t, 'install', 0);
  const runtime = await fixtureRuntime();
  const directory = path.join(f.dataDir, 'runtime', `node-v${process.versions.node}-win-${process.arch}-${runtime.hash.slice(0, 12)}`);
  await fs.mkdir(directory, { recursive: true });
  const badNode = path.join(directory, 'node.exe');
  await fs.writeFile(badNode, 'preserve original damaged cache');
  const result = await runEntry(f);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /未覆盖原目录/);
  assert.equal(await fs.readFile(badNode, 'utf8'), 'preserve original damaged cache');
  assert.doesNotMatch(result.output, /ENTRY-FIXTURE/);
});

test('bootstrap rejects a cache junction without writing through it', { skip: !windows }, async t => {
  const f = await fixture(t, 'install', 0);
  const outside = path.join(f.directory, 'outside-cache');
  await fs.mkdir(outside);
  await fs.mkdir(f.dataDir);
  await fs.symlink(outside, path.join(f.dataDir, 'runtime'), 'junction');
  const result = await runEntry(f);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /链接或目录联接/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.doesNotMatch(result.output, /ENTRY-FIXTURE/);
});

test('bootstrap rejects corrupt downloaded bytes and cleans only its owned temporary directory', { skip: !windows }, async t => {
  const f = await fixture(t, 'install', 0, { bundled: false });
  const packageRoot = f.packageRoot.replaceAll("'", "''");
  const result = await runBootstrapFunctions(f, `function Receive-SchedulerNode([string]$Url,[string]$Destination) { [IO.File]::WriteAllText($Destination,'corrupt download fixture') }; $release = Read-SchedulerNodeRelease '${packageRoot}' '${process.arch}'; $directory = Get-SchedulerRuntimeDirectory $release $null; try { Install-SchedulerRuntime '' $directory $release -Download; exit 9 } catch { [Console]::WriteLine($_.Exception.Message); exit 1 }`);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /SHA-256 校验失败/);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'runtime')), []);
  assert.doesNotMatch(result.output, /ENTRY-FIXTURE/);
});

test('explicit isolated data directory does not read a broken unrelated installation pointer', { skip: !windows }, async t => {
  const f = await fixture(t, 'install', 0);
  await fs.mkdir(f.codexHome);
  const pointerFile = path.join(f.codexHome, 'codex-scheduler-install.json');
  await fs.writeFile(pointerFile, 'unrelated damaged installation pointer');
  const result = await runEntry(f);
  assert.equal(result.code, 0, result.output);
  assert.ok(receipt(result).node.startsWith(f.dataDir));
  assert.equal(await fs.readFile(pointerFile, 'utf8'), 'unrelated damaged installation pointer');
});

test('saved installation pointer selects the same canonical per-user runtime with no explicit data directory', { skip: !windows }, async t => {
  const f = await fixture(t, 'install', 0);
  const canonical = path.join(f.directory, 'canonical packaged application data');
  await fs.mkdir(f.codexHome);
  await fs.writeFile(path.join(f.codexHome, 'codex-scheduler-install.json'), JSON.stringify({ version: 1, dataDir: canonical }));
  const result = await runEntry(f, { env: { SCHEDULER_DATA_DIR: '' } });
  assert.equal(result.code, 0, result.output);
  assert.ok(receipt(result).node.startsWith(`${canonical}${path.sep}runtime${path.sep}`));
});

test('bootstrap architecture names cover x64 and ARM64 independent of PowerShell bitness', { skip: !windows }, async t => {
  const f = await fixture(t, 'install');
  const source = path.join(root, 'scripts/bootstrap.ps1').replaceAll("'", "''");
  for (const [native, expected] of [['AMD64', 'x64'], ['X64', 'x64'], ['ARM64', 'arm64']]) {
    const command = `. '${source}'; ConvertTo-SchedulerWindowsArchitecture '${native}'`;
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      directory: f.directory, env: environment(f),
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output.trim(), new RegExp(`^${expected}$`));
  }
});

test('bootstrap restores system Windows PowerShell modules for Node children when parent module path is polluted', { skip: !windows }, async t => {
  const f = await fixture(t, 'install', 0);
  const result = await runEntry(f, { env: { PSModulePath: 'Z:\\unrelated-powershell-seven-modules' } });
  assert.equal(result.code, 0, result.output);
  const record = receipt(result);
  assert.ok(record.psModules.toLowerCase().includes(path.join(path.dirname(powershell), 'Modules').toLowerCase()));
  assert.doesNotMatch(record.psModules, /unrelated-powershell-seven/);
  const child = await runBootstrapFunctions(f, "$commands = @(Get-Command Get-AppxPackage,Get-ScheduledTask -ErrorAction Stop); [Console]::WriteLine(($commands.Name -join ','))", { PSModulePath: 'Z:\\unrelated-powershell-seven-modules' });
  assert.equal(child.code, 0, child.output);
  assert.match(child.output, /Get-AppxPackage/);
  assert.match(child.output, /Get-ScheduledTask/);
});
