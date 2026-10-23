import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordInstallation } from '../src/installation-state.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-install-state-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, codexHome: path.join(directory, 'codex-home'), dataDir: path.join(directory, 'physical-appdata', 'CodexScheduler') };
}
function fromExternalProcess(f, extra = {}) {
  const env = { ...process.env, CODEX_HOME: f.codexHome, LOCALAPPDATA: path.join(f.directory, 'different-external-appdata') };
  delete env.SCHEDULER_DATA_DIR;
  Object.assign(env, extra);
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import {getPaths} from ${JSON.stringify(new URL('../src/paths.mjs', import.meta.url).href)}; console.log(JSON.stringify({dataDir:getPaths().dataDir}));`], { env, encoding: 'utf8', windowsHide: true });
}
test('external uninstall and the desktop resolve one canonical data directory despite different AppData views', async t => {
  const f = await fixture(t);
  const installationPath = path.join(f.codexHome, 'codex-scheduler-install.json');
  const recorded = await recordInstallation({ paths: { dataDir: f.dataDir, installationPath }, legacyDirectories: async () => [] });
  assert.equal(recorded.dataDir, await fs.realpath(f.dataDir));
  const result = fromExternalProcess(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dataDir, recorded.dataDir);
  assert.deepEqual(JSON.parse(await fs.readFile(installationPath, 'utf8')), { version: 1, dataDir: recorded.dataDir });
});
test('explicit isolated data overrides are preserved and do not read the saved installation', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.codexHome);
  await fs.writeFile(path.join(f.codexHome, 'codex-scheduler-install.json'), '{invalid');
  const explicit = path.join(f.directory, 'explicit-test-data');
  const result = fromExternalProcess(f, { SCHEDULER_DATA_DIR: explicit });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dataDir, explicit);
});
test('corrupt installation information is preserved and never silently targets a different queue', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.codexHome);
  const installationPath = path.join(f.codexHome, 'codex-scheduler-install.json');
  for (const invalid of ['{broken', JSON.stringify({ version: 1, dataDir: 'relative' }), JSON.stringify({ version: 99, dataDir: f.dataDir })]) {
    await fs.writeFile(installationPath, invalid);
    const result = fromExternalProcess(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /原文件已保留/);
    assert.equal(await fs.readFile(installationPath, 'utf8'), invalid);
  }
});

test('the first external upgrade recovers a legacy package queue without creating a new empty queue', async t => {
  const f = await fixture(t);
  const legacy = path.join(f.directory, 'legacy-Codex-package', 'CodexScheduler');
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, 'queue.json'), '{"version":1,"tasks":[]}');
  const installationPath = path.join(f.codexHome, 'codex-scheduler-install.json');
  const result = await recordInstallation({ paths: { dataDir: f.dataDir, installationPath }, platform: 'win32', explicitDataDir: '', legacyDirectories: async () => [legacy] });
  assert.equal(result.dataDir, await fs.realpath(legacy));
  assert.equal(await fs.stat(f.dataDir).then(() => true, () => false), false);
  assert.equal(JSON.parse(fromExternalProcess(f).stdout).dataDir, result.dataDir);
});

test('ambiguous legacy queues are never silently merged or replaced', async t => {
  const f = await fixture(t);
  const directories = [path.join(f.directory, 'first'), path.join(f.directory, 'second')];
  for (const directory of directories) { await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'queue.json'), 'preserved'); }
  const installationPath = path.join(f.codexHome, 'codex-scheduler-install.json');
  await assert.rejects(recordInstallation({ paths: { dataDir: f.dataDir, installationPath }, platform: 'win32', explicitDataDir: '', legacyDirectories: async () => directories }), /多份/);
  assert.equal(await fs.stat(installationPath).then(() => true, () => false), false);
  for (const directory of directories) assert.equal(await fs.readFile(path.join(directory, 'queue.json'), 'utf8'), 'preserved');
});
