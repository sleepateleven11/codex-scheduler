import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';

async function fixture(t, action, exitCode) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-scheduler-entry-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const name = action === 'install' ? '安装插件.cmd' : '卸载插件.cmd';
  const entry = path.join(directory, name);
  await fs.copyFile(path.join(root, name), entry);
  if (exitCode !== undefined) {
    for (const folder of ['scripts', 'src', '.codex-plugin', '.agents/plugins']) await fs.mkdir(path.join(directory, folder), { recursive: true });
    for (const file of ['package.json', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json']) await fs.writeFile(path.join(directory, file), '{}');
    for (const file of ['src/paths.mjs', 'src/runtime.mjs']) await fs.writeFile(path.join(directory, file), '// fixture only');
    // The wrapper can only reach this harmless fixture, never the live installer.
    await fs.writeFile(path.join(directory, 'scripts', `${action}.mjs`), `console.log('ENTRY-FIXTURE'); process.exit(${exitCode});\n`);
  }
  return { directory, entry };
}

async function runEntry({ directory, entry }, { nodeAvailable = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `call "${entry}"`], {
      cwd: directory, windowsHide: true, windowsVerbatimArguments: true, shell: false,
      env: { ...process.env, PATH: nodeAvailable ? `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` : [path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => output.push(chunk));
    child.stdin.on('error', () => {});
    child.stdin.end('\r\n');
    const timeout = setTimeout(() => { child.kill(); reject(new Error('CMD entry fixture timed out')); }, 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output: Buffer.concat(output).toString('utf8') }); });
  });
}

for (const action of ['install', 'uninstall']) {
  test(`${action} CMD explains the Node prerequisite before running any installer`, { skip: !windows }, async t => {
    const result = await runEntry(await fixture(t, action, 0), { nodeAvailable: false });
    assert.equal(result.code, 1);
    assert.match(result.output, /Node\.js 22/);
    assert.match(result.output, /尚未执行/);
    assert.doesNotMatch(result.output, /ENTRY-FIXTURE/);
  });

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
    test(`${action} CMD preserves Node exit ${exitCode} after its pause`, { skip: !windows }, async t => {
      const result = await runEntry(await fixture(t, action, exitCode));
      assert.equal(result.code, exitCode);
      assert.match(result.output, /ENTRY-FIXTURE/);
      assert.doesNotMatch(result.output, /未执行/);
    });
  }
}
