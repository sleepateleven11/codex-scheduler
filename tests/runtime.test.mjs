import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNodeVersion, discoverCodex } from '../src/runtime.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-runtime-test-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  const file = async relative => { const target = path.join(directory, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'fixture, never executed'); return target; };
  return { directory, file, home: path.join(directory, 'different user profile') };
}

test('runtime requires Node 22+ and reports the prerequisite in plain language', () => {
  for (const version of ['22.0.0', '24.18.0', '23.1.0-beta.1']) assert.doesNotThrow(() => assertNodeVersion(version));
  for (const version of ['18.19.0', '20.9.0', 'unknown']) assert.throws(() => assertNodeVersion(version), /Node\.js 22.*重新打开/);
});

test('an explicit Codex path is used locally and an invalid explicit path is never silently ignored', async t => {
  const f = await fixture(t);
  const file = await f.file('custom Codex/codex.exe');
  assert.equal(await discoverCodex({ env: { SCHEDULER_CODEX_PATH: file }, home: f.home }), file);
  await assert.rejects(discoverCodex({ env: { SCHEDULER_CODEX_PATH: path.join(f.directory, 'missing'), CODEX_CLI_PATH: file }, home: f.home }), /SCHEDULER_CODEX_PATH.*不存在/);
});

test('Windows discovery follows the recipient profile and checks PATH when its bundled CLI is absent', async t => {
  const f = await fixture(t);
  const local = path.join(f.directory, 'recipient AppData');
  const file = await f.file('recipient AppData/OpenAI/Codex/bin/new-build/codex.exe');
  const unexpected = async () => assert.fail('a bundled runtime should be selected without invoking discovery commands');
  assert.equal(await discoverCodex({ platform: 'win32', env: { LOCALAPPDATA: local }, home: f.home, runCommand: unexpected }), file);
  const pathFile = await f.file('installed elsewhere/codex.exe');
  const calls = [];
  assert.equal(await discoverCodex({ platform: 'win32', env: {}, home: f.home, runCommand: async (command, args) => { calls.push([command, args]); return { stdout: `${pathFile}\r\n` }; } }), pathFile);
  assert.deepEqual(calls, [['where.exe', ['codex.exe']]]);
});

test('Windows package discovery reads only the current user registration and selects a bundled CLI', async t => {
  const f = await fixture(t);
  const location = path.join(f.directory, 'package');
  const file = await f.file('package/app/resources/codex.exe');
  const calls = [];
  const result = await discoverCodex({ platform: 'win32', env: {}, home: f.home, runCommand: async (command, args) => {
    calls.push([command, args]);
    return { stdout: command === 'where.exe' ? '' : JSON.stringify(location) };
  } });
  assert.equal(result, file);
  assert.match(calls[1][1].at(-1), /^Get-AppxPackage -Name OpenAI\.Codex /);
  assert.doesNotMatch(calls[1][1].at(-1), /AllUsers|Set-|Remove-|Register-/);
});

test('Windows discovery accepts the direct updater bin layout without requiring PATH or package commands', async t => {
  const f = await fixture(t);
  const local = path.join(f.directory, 'Windows 用户 Local');
  const file = await f.file('Windows 用户 Local/OpenAI/Codex/bin/codex.exe');
  assert.equal(await discoverCodex({ platform: 'win32', env: { LOCALAPPDATA: local }, home: f.home,
    runCommand: async () => assert.fail('the direct CLI exists'),
  }), file);
});

test('Store discovery supports the resources bin layout even when PATH lookup fails', async t => {
  const f = await fixture(t);
  const location = path.join(f.directory, 'store installed package');
  const file = await f.file('store installed package/app/resources/bin/codex.exe');
  const calls = [];
  assert.equal(await discoverCodex({ platform: 'win32', env: {}, home: f.home,
    runCommand: async (command, args, options) => {
      calls.push(command);
      assert.equal(options.windowsHide, true);
      if (command === 'where.exe') throw new Error('PATH command unavailable');
      assert.match(args.at(-1), /^Get-AppxPackage -Name OpenAI\.Codex /);
      return { stdout: JSON.stringify([null, 'relative unsafe path', location]) };
    },
  }), file);
  assert.deepEqual(calls, ['where.exe', 'powershell.exe']);
});

test('missing Codex produces an installation instruction without trying an unrelated executable', async t => {
  const f = await fixture(t);
  await assert.rejects(discoverCodex({ platform: 'win32', env: {}, home: f.home, runCommand: async () => ({ stdout: '' }) }), /请先安装并登录 Codex 桌面端/);
});
