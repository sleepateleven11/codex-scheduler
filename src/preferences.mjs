import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const FIELDS = new Set(['projectPath', 'threadId', 'model', 'effort', 'timeZone']);
export function validatePreferences(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('偏好设置格式不正确。');
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!FIELDS.has(key)) throw new Error('偏好设置只保存项目、对话、模型、思考强度和时区。');
    if (typeof value !== 'string' || value.length > (key === 'projectPath' ? 32768 : 200)) throw new Error('偏好设置内容无效。');
    if (key === 'projectPath' && value && !path.isAbsolute(value) && !path.win32.isAbsolute(value)) throw new Error('项目目录必须是完整路径。');
    if (key === 'effort' && value && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) throw new Error('思考强度无效。');
    if (key === 'timeZone') {
      try { if (!value) throw new Error(); new Intl.DateTimeFormat('en', { timeZone: value }); }
      catch { throw new Error('时区无效。'); }
    }
    clean[key] = value;
  }
  return clean;
}

export class PreferencesStore {
  constructor(file) { this.file = file; this.tail = Promise.resolve(); }
  async _document() {
    let document;
    try { document = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, preferences: {} }; throw new Error('无法读取偏好设置，原文件已保留。'); }
    if (!document || typeof document !== 'object' || Array.isArray(document) || document.version !== 1) throw new Error('偏好设置版本无效，原文件已保留。');
    validatePreferences(document.preferences || {});
    return document;
  }
  async read() { await this.tail.catch(() => {}); return structuredClone((await this._document()).preferences || {}); }
  update(patch) {
    const clean = validatePreferences(patch);
    const operation = this.tail.catch(() => {}).then(async () => {
      const document = await this._document();
      document.preferences = { ...document.preferences, ...clean };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(document, null, 2) + '\n');
        await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temporary, this.file);
      } finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
      return structuredClone(document.preferences);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
