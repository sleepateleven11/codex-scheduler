import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PreferencesStore, validatePreferences } from '../src/preferences.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-preferences-'));
  const file = path.join(directory, 'settings.json');
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { file, store: new PreferencesStore(file) };
}
test('preferences persist across new managers without storing drafts or access credentials', async t => {
  const { file, store } = await fixture(t);
  assert.deepEqual(await store.read(), {});
  const saved = { projectPath: 'C:\\项目\\时序', threadId: 'existing-thread', model: 'selected-model', effort: 'high', timeZone: 'Asia/Shanghai' };
  await store.update(saved);
  assert.deepEqual(await new PreferencesStore(file).read(), saved);
  assert.throws(() => store.update({ prompt: 'Draft must stay out of preferences.' }), /只保存/);
  assert.throws(() => store.update({ token: 'Not a preference.' }), /只保存/);
  assert.deepEqual((JSON.parse(await fs.readFile(file, 'utf8'))).preferences, saved);
  const copy = await store.read(); copy.model = 'changed only in the caller';
  assert.equal((await store.read()).model, saved.model);
});
test('concurrent preference updates preserve unrelated fields and queued writes', async t => {
  const { file, store } = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ version: 1, unrelatedSetting: { retained: true }, preferences: { model: 'original' } }));
  await Promise.all([store.update({ projectPath: 'C:\\Work' }), store.update({ timeZone: 'Europe/London' }), store.update({ model: 'new-model' })]);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved.preferences, { model: 'new-model', projectPath: 'C:\\Work', timeZone: 'Europe/London' });
  assert.deepEqual(saved.unrelatedSetting, { retained: true });
});
test('invalid preference files are preserved instead of silently replaced', async t => {
  const { file, store } = await fixture(t);
  for (const invalid of ['{broken', JSON.stringify({ version: 9, preferences: {} })]) {
    await fs.writeFile(file, invalid);
    await assert.rejects(store.update({ model: 'new' }), /原文件已保留/);
    assert.equal(await fs.readFile(file, 'utf8'), invalid);
  }
});
test('preference fields validate paths, timezones, and supported effort values', () => {
  assert.throws(() => validatePreferences({ projectPath: 'relative' }), /完整路径/);
  assert.throws(() => validatePreferences({ timeZone: 'Invalid/Zone' }), /时区/);
  assert.throws(() => validatePreferences({ effort: 'unknown' }), /思考强度/);
  assert.throws(() => validatePreferences({ model: {} }), /无效/);
  assert.throws(() => validatePreferences([]), /格式/);
  assert.deepEqual(validatePreferences({ projectPath: '', threadId: '', effort: '' }), { projectPath: '', threadId: '', effort: '' });
});
