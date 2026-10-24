import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readRuntimeRelease, runtimeOfflinePayload, stageWindowsRuntime } from '../scripts/runtime-package.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-runtime-package-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const sourceRoot = path.join(directory, '解压文件 with spaces');
  const dataDir = path.join(directory, '新用户 stable data');
  const license = Buffer.from('test upstream license');
  const release = { version: '24.22.1', platforms: {}, license: { file: 'LICENSE.node.txt', source: 'https://raw.githubusercontent.com/nodejs/node/v24.22.1/LICENSE', sha256: digest(license) } };
  const nodes = {};
  for (const arch of ['x64', 'arm64']) {
    const bytes = Buffer.from(`mock ${arch} Node executable, never executed`);
    nodes[arch] = path.join(sourceRoot, 'runtime', `windows-${arch}`, 'node.exe');
    await fs.mkdir(path.dirname(nodes[arch]), { recursive: true });
    await fs.writeFile(nodes[arch], bytes);
    release.platforms[`win-${arch}`] = { url: `https://nodejs.org/dist/v24.22.1/win-${arch}/node.exe`, sha256: digest(bytes) };
  }
  const metadata = path.join(sourceRoot, 'runtime', 'node-release.json');
  await fs.writeFile(metadata, JSON.stringify(release));
  await fs.writeFile(path.join(sourceRoot, 'runtime', release.license.file), license);
  await fs.mkdir(dataDir);
  return { directory, sourceRoot, dataDir, metadata, release, nodes };
}

test('offline packages admit only the selected architecture with verified pinned binary bytes', async t => {
  const f = await fixture(t);
  for (const arch of ['x64', 'arm64']) {
    const files = await runtimeOfflinePayload(f.sourceRoot, arch);
    assert.deepEqual(files.map(file => file.name), [`runtime/windows-${arch}/node.exe`]);
    assert.equal(digest(files[0].bytes), f.release.platforms[`win-${arch}`].sha256);
  }
  await assert.rejects(runtimeOfflinePayload(f.sourceRoot, 'ia32'), /仅支持/);
  await fs.appendFile(f.nodes.x64, 'changed');
  await assert.rejects(runtimeOfflinePayload(f.sourceRoot, 'x64'), /SHA-256 校验失败/);
  assert.equal((await runtimeOfflinePayload(f.sourceRoot, 'arm64')).length, 1);
});

test('runtime metadata rejects alternate origins, mismatched versions, unsafe license paths and invalid checksums', async t => {
  const f = await fixture(t);
  const mutations = [
    release => { release.platforms['win-x64'].url = 'http://nodejs.org/dist/v24.22.1/win-x64/node.exe'; },
    release => { release.platforms['win-x64'].url = 'https://example.com/node.exe'; },
    release => { release.platforms['win-arm64'].sha256 = 'unchecked'; },
    release => { release.version = '20.0.0'; },
    release => { release.license.file = '../private-file'; },
    release => { release.license.source = 'https://raw.githubusercontent.com/other/node/v24.22.1/LICENSE'; },
  ];
  for (const mutate of mutations) {
    const release = structuredClone(f.release); mutate(release);
    await fs.writeFile(f.metadata, JSON.stringify(release));
    await assert.rejects(readRuntimeRelease(f.sourceRoot), /清单无效|官方 HTTPS/);
  }
});

test('the bundled runtime is retained separately from extraction and reused only after binary and license verification', async t => {
  const f = await fixture(t);
  const staged = await stageWindowsRuntime({ ...f, nodePath: f.nodes.arm64 });
  const expected = path.join(f.dataDir, 'runtime', `node-v24.22.1-win-arm64-${f.release.platforms['win-arm64'].sha256.slice(0, 12)}`, 'node.exe');
  assert.equal(staged.nodePath, expected);
  assert.deepEqual(await stageWindowsRuntime({ ...f, nodePath: staged.nodePath }), staged);
  const before = await fs.readFile(staged.nodePath);
  assert.equal(path.dirname(f.sourceRoot), f.directory);
  await fs.rm(f.sourceRoot, { recursive: true });
  assert.deepEqual(await fs.readFile(staged.nodePath), before);
  assert.equal(await fs.readFile(path.join(path.dirname(staged.nodePath), 'LICENSE.node.txt'), 'utf8'), 'test upstream license');
});

test('corrupted or unrelated runtimes never replace an existing stable executable', async t => {
  const f = await fixture(t);
  const staged = await stageWindowsRuntime({ ...f, nodePath: f.nodes.x64 });
  await fs.writeFile(staged.nodePath, 'foreign stable executable');
  await assert.rejects(stageWindowsRuntime({ ...f, nodePath: f.nodes.x64 }), /SHA-256 校验失败/);
  assert.equal(await fs.readFile(staged.nodePath, 'utf8'), 'foreign stable executable');
  await fs.appendFile(f.nodes.arm64, 'damaged');
  await assert.rejects(stageWindowsRuntime({ ...f, nodePath: f.nodes.arm64 }), /固定运行时不匹配/);
});

test('offline packaging and stable staging reject corrupted licenses before writing runtime files', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.sourceRoot, 'runtime', 'LICENSE.node.txt'), 'not the upstream license');
  await assert.rejects(runtimeOfflinePayload(f.sourceRoot, 'x64'), /SHA-256 校验失败/);
  await assert.rejects(stageWindowsRuntime({ ...f, nodePath: f.nodes.x64 }), /SHA-256 校验失败/);
  assert.deepEqual(await fs.readdir(f.dataDir), []);
});

test('a runtime parent redirected outside the installation is rejected without changing that target', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'unrelated');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.dataDir, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageWindowsRuntime({ ...f, nodePath: f.nodes.x64 }), /独立文件夹/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('transient runtime publication locks retry without replacing other versions or leaving partial installations', async t => {
  const f = await fixture(t);
  const prior = await stageWindowsRuntime({ ...f, nodePath: f.nodes.arm64 });
  let attempts = 0;
  const delays = [];
  const staged = await stageWindowsRuntime({ ...f, nodePath: f.nodes.x64,
    rename: async (from, to) => {
      if (++attempts < 4) throw Object.assign(new Error('scanner held a new directory'), { code: 'EPERM' });
      return fs.rename(from, to);
    }, delay: async ms => { delays.push(ms); },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [100, 200, 300]);
  assert.deepEqual((await fs.readdir(path.join(f.dataDir, 'runtime'))).sort(), [path.basename(path.dirname(prior.nodePath)), path.basename(path.dirname(staged.nodePath))].sort());
});

test('persistent runtime publication locks stop after a bounded retry and leave the existing runtime untouched', async t => {
  const f = await fixture(t);
  const prior = await stageWindowsRuntime({ ...f, nodePath: f.nodes.arm64 });
  let attempts = 0;
  const lock = Object.assign(new Error('persistent runtime lock'), { code: 'EACCES' });
  await assert.rejects(stageWindowsRuntime({ ...f, nodePath: f.nodes.x64,
    rename: async () => { attempts++; throw lock; }, delay: async () => {},
  }), actual => actual === lock);
  assert.equal(attempts, 10);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'runtime')), [path.basename(path.dirname(prior.nodePath))]);
});
