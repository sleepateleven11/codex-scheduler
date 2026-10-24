import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const ARCHITECTURES = ['x64', 'arm64'];

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('运行时文件必须为独立的普通文件。');
  return file;
}

export function validateRuntimeRelease(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release) || !/^\d+\.\d+\.\d+$/.test(release.version || '') || Number(release.version.split('.')[0]) < 22) throw new Error('Node.js 运行时版本清单无效。');
  for (const arch of ARCHITECTURES) {
    const entry = release.platforms?.[`win-${arch}`];
    if (entry?.url !== `https://nodejs.org/dist/v${release.version}/win-${arch}/node.exe` || !HASH.test(entry.sha256 || '')) throw new Error('Node.js 运行时必须使用固定的官方 HTTPS 地址与 SHA-256。');
  }
  if (release.license?.file !== 'LICENSE.node.txt' || !HASH.test(release.license.sha256 || '') ||
    release.license.source !== `https://raw.githubusercontent.com/nodejs/node/v${release.version}/LICENSE`) throw new Error('Node.js 许可清单无效。');
  return release;
}

export async function readRuntimeRelease(sourceRoot) {
  const file = path.join(sourceRoot, 'runtime', 'node-release.json');
  await regularFile(file);
  return validateRuntimeRelease(JSON.parse(await fs.readFile(file, 'utf8')));
}

async function verifiedRuntimeFile(file, expected) {
  await regularFile(file);
  if (await sha256File(file) !== expected) throw new Error('Node.js 运行时 SHA-256 校验失败，请重新下载完整安装包。');
  return file;
}

export async function runtimeOfflinePayload(sourceRoot, arch, { release } = {}) {
  if (!ARCHITECTURES.includes(arch)) throw new Error('离线安装包架构仅支持 x64 或 arm64。');
  release = release ? validateRuntimeRelease(release) : await readRuntimeRelease(sourceRoot);
  await verifiedRuntimeFile(path.join(sourceRoot, 'runtime', release.license.file), release.license.sha256);
  const name = `runtime/windows-${arch}/node.exe`;
  const file = await verifiedRuntimeFile(path.join(sourceRoot, name), release.platforms[`win-${arch}`].sha256);
  const bytes = await fs.readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== release.platforms[`win-${arch}`].sha256) throw new Error('Node.js 运行时读取时发生变化，请重新下载完整安装包。');
  return [{ name, bytes }];
}

async function childDirectory(parent, name) {
  const target = path.join(parent, name);
  await fs.mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(target);
  const real = await fs.realpath(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(parent, real) !== name) throw new Error('本机运行时目录不是有效的独立文件夹，原文件已保留。');
  return real;
}

// The executing bundled/downloaded Node must outlive the user's extraction.
// Verify the exact pinned bytes and preserve the matching upstream license.
export async function stageWindowsRuntime({ sourceRoot, dataDir, nodePath,
  rename = fs.rename, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const release = await readRuntimeRelease(sourceRoot);
  const license = path.join(sourceRoot, 'runtime', release.license.file);
  await verifiedRuntimeFile(license, release.license.sha256);
  await regularFile(nodePath);
  const digest = await sha256File(nodePath);
  const arch = ARCHITECTURES.find(value => release.platforms[`win-${value}`].sha256 === digest);
  if (!arch) throw new Error('当前 Node.js 与安装包固定运行时不匹配，请双击“安装插件.cmd”完成自动配置。');
  const parent = await childDirectory(await fs.realpath(dataDir), 'runtime');
  const target = path.join(parent, `node-v${release.version}-win-${arch}-${digest.slice(0, 12)}`);
  async function verifyExisting() {
    const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(parent, await fs.realpath(target)) !== path.basename(target)) throw new Error('本机运行时副本不是有效目录，原文件已保留。');
    await verifiedRuntimeFile(path.join(target, 'node.exe'), digest);
    await verifiedRuntimeFile(path.join(target, release.license.file), release.license.sha256);
    return true;
  }
  if (!await verifyExisting()) {
    const temporary = await fs.mkdtemp(path.join(parent, '.node-install-'));
    try {
      await fs.copyFile(nodePath, path.join(temporary, 'node.exe'));
      await fs.copyFile(license, path.join(temporary, release.license.file));
      await verifiedRuntimeFile(path.join(temporary, 'node.exe'), digest);
      await verifiedRuntimeFile(path.join(temporary, release.license.file), release.license.sha256);
      for (let attempt = 0; attempt < 10; attempt++) {
        if (await verifyExisting()) break;
        try { await rename(temporary, target); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY'].includes(error.code) || attempt === 9) throw error;
          await delay(Math.min(100 * (attempt + 1), 500));
        }
      }
    } finally {
      if (path.dirname(temporary) !== parent || !path.basename(temporary).startsWith('.node-install-')) throw new Error('运行时临时目录清理范围无效。');
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  return { nodePath: path.join(target, 'node.exe'), version: release.version, arch, sha256: digest };
}
