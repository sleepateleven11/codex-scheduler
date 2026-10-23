import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPaths } from '../src/paths.mjs';
const run = promisify(execFile);
const root = getPaths().root;
const files = [];
async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else if (/\.(mjs|js|cjs)$/.test(full)) files.push(full); } }
for (const folder of ['src', 'scripts', 'tests', 'public']) {
  const directory = path.join(root, folder);
  if (folder === 'tests' && !await fs.stat(directory).catch(() => null)) continue;
  await walk(directory);
}
await Promise.all(files.map(file => run(process.execPath, ['--check', file], { windowsHide: true })));
await import('./check-plugin.mjs');
console.log(`语法与插件结构检查通过（${files.length} 个脚本）。`);
