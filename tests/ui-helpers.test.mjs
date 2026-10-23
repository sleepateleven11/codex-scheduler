import assert from 'node:assert/strict';
import test from 'node:test';
await import('../public/ui-helpers.js');
const ui = globalThis.SchedulerUI;

test('only unsent pending and paused tasks expose editing', () => {
  for (const status of ['scheduled', 'waiting_quota', 'waiting_thread', 'paused']) assert.equal(ui.canEditTask({ status }), true);
  for (const status of ['running', 'completed', 'failed', 'cancelled', 'needs_review', undefined]) assert.equal(ui.canEditTask({ status }), false);
});
test('a receipt, turn or persisted dispatch intent prevents editing even if status is stale', () => {
  for (const extra of [{ submissionReceipt: {} }, { turnId: 'turn-1' }, { dispatchState: 'intent' }, { dispatchState: 'submitted' }]) {
    assert.equal(ui.canEditTask({ status: 'scheduled', ...extra }), false);
  }
  assert.equal(ui.canEditTask({ status: 'scheduled', lastRejectedSubmission: {}, dispatchState: null }), true);
});
test('countdown rounds up, never becomes negative, and ticks through minute boundaries', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  assert.equal(ui.remainingTime(now + 60500, now), '1 分 1 秒');
  assert.equal(ui.remainingTime(now + 60500, now + 1000), '1 分 0 秒');
  assert.equal(ui.remainingTime(now - 10000, now), '0 秒');
  assert.equal(ui.remainingTime('invalid', now), '');
  assert.equal(ui.remainingTime(null, now), '');
});
test('long countdowns retain hours, minutes and seconds', () => {
  const now = 1700000000000;
  assert.equal(ui.remainingTime(now + (86400 + 3600 + 60 + 5) * 1000, now), '1 天 1 小时 1 分 5 秒');
  assert.equal(ui.remainingTime(now + 3600000, now), '1 小时 0 分 0 秒');
});
test('scheduled, quota and conversation waiting use distinct countdown messages', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  const due = new Date(now + 5000).toISOString();
  assert.equal(ui.taskCountdown({ status: 'scheduled', runAt: due }, now), '距离发送 5 秒');
  assert.equal(ui.taskCountdown({ status: 'scheduled', runAt: due }, now + 5000), '已到时间，等待调度');
  assert.equal(ui.taskCountdown({ status: 'waiting_quota', nextAttemptAt: due }, now), '距离再次检查额度 5 秒');
  assert.equal(ui.taskCountdown({ status: 'waiting_quota', nextAttemptAt: due }, now + 5000), '正在重新检查额度');
  assert.equal(ui.taskCountdown({ status: 'waiting_thread', nextAttemptAt: due }, now), '距离再次检查对话 5 秒');
  assert.equal(ui.taskCountdown({ status: 'waiting_thread' }, now), '等待对话空闲后继续');
  assert.equal(ui.taskCountdown({ status: 'running' }, now), '');
});
test('quota reset time takes priority over a generic retry time', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  assert.equal(ui.taskCountdown({ status: 'waiting_quota', quotaResetAt: new Date(now + 60000).toISOString(), nextAttemptAt: new Date(now + 5000).toISOString() }, now), '距离再次检查额度 1 分 0 秒');
});
test('only the explicit per-task quota mode replaces scheduled sending', () => {
  assert.equal(ui.taskSendMode({ sendMode: 'quota_available' }), 'quota_available');
  for (const task of [{}, { sendMode: 'scheduled' }, { sendMode: null }, { sendMode: true }, { sendMode: 'quota' }]) {
    assert.equal(ui.taskSendMode(task), 'scheduled');
    assert.equal(ui.taskTriggerText(task), '定时发送');
  }
  assert.equal(ui.taskTriggerText({ sendMode: 'quota_available' }), '额度可用时立即发送');
});
test('quota-triggered tasks never present their internal runAt as a fixed send countdown', () => {
  const now = Date.parse('2026-10-22T10:00:00Z');
  const runAt = new Date(now + 3600000).toISOString();
  assert.equal(ui.taskCountdown({ status: 'scheduled', sendMode: 'quota_available', runAt }, now), '等待检测额度，额度可用时发送');
  assert.equal(ui.taskCountdown({ status: 'scheduled', sendMode: 'quota_available', runAt }, now + 7200000), '等待检测额度，额度可用时发送');
  assert.equal(ui.taskCountdown({ status: 'scheduled', runAt }, now), '距离发送 1 小时 0 分 0 秒');
});
test('quota-trigger polling counts down to the next real check before a predicted reset', () => {
  const now = Date.parse('2026-10-22T10:00:00Z');
  const task = { status: 'waiting_quota', sendMode: 'quota_available', quotaResetAt: new Date(now + 3600000).toISOString(), nextAttemptAt: new Date(now + 30000).toISOString() };
  assert.equal(ui.taskCountdown(task, now), '距离再次检查额度 30 秒');
  assert.equal(ui.taskCountdown(task, now + 30000), '正在重新检查额度');
  delete task.nextAttemptAt;
  assert.equal(ui.taskCountdown(task, now), '额度恢复后自动继续');
});
test('quota-trigger mode respects conversation waiting and does not imply resending finished tasks', () => {
  const now = Date.parse('2026-10-22T10:00:00Z');
  assert.equal(ui.taskCountdown({ sendMode: 'quota_available', status: 'waiting_thread', nextAttemptAt: new Date(now + 5000).toISOString() }, now), '距离再次检查对话 5 秒');
  for (const status of ['paused', 'running', 'completed', 'failed', 'cancelled', 'needs_review']) assert.equal(ui.taskCountdown({ sendMode: 'quota_available', status }, now), '');
});
test('quota trigger guidance makes saving and immediate availability explicit', () => {
  const hint = ui.quotaTriggerHint();
  assert.ok(hint.includes('保存后每 30 秒检测'));
  assert.ok(hint.includes('当前额度可用时立即发送'));
  assert.ok(hint.includes('无需设置时间'));
  assert.ok(hint.includes('仍需创建任务'));
});
test('quota mode is never retained as a new-task preference', () => {
  assert.deepEqual(ui.pickPreferences({ sendMode: 'quota_available', quotaTrigger: true, model: 'model', threadId: 'thread' }), { model: 'model', threadId: 'thread' });
});
test('preferences contain only user choices and never prompt or access credentials', () => {
  assert.deepEqual(ui.pickPreferences({ projectPath: 'C:\\work', threadId: 'thread', model: 'model', effort: 'high', timeZone: 'UTC', prompt: 'private', token: 'secret', unknown: 'ignored' }), { projectPath: 'C:\\work', threadId: 'thread', model: 'model', effort: 'high', timeZone: 'UTC' });
  assert.deepEqual(ui.pickPreferences({ model: {}, threadId: 'x'.repeat(201), effort: '' }), { effort: '' });
});
test('historical success does not create a new completion notification on startup', () => {
  assert.equal(ui.taskNotice(null, { id: 'a', status: 'completed' }), null);
  assert.equal(ui.taskNotice({ status: 'completed' }, { id: 'a', status: 'completed' }), null);
});
test('only meaningful newly observed terminal changes create persistent notices', () => {
  assert.deepEqual(ui.taskNotice({ status: 'running' }, { id: 'a', status: 'completed' }), { kind: 'success', message: '任务已完成', taskId: 'a' });
  assert.equal(ui.taskNotice({ status: 'scheduled' }, { id: 'a', status: 'waiting_quota' }), null);
  assert.equal(ui.taskNotice({ status: 'running' }, { id: 'a', status: 'failed' }).kind, 'error');
  assert.equal(ui.taskNotice({ status: 'running' }, { id: 'a', status: 'needs_review' }).kind, 'warning');
});

test('thread times normalize seconds, milliseconds and ISO to Beijing time', () => {
  const iso = '2026-10-21T16:05:00.000Z';
  assert.equal(ui.threadTime(iso), '2026-10-22 00:05');
  assert.equal(ui.threadTime(Date.parse(iso)), '2026-10-22 00:05');
  assert.equal(ui.threadTime(Date.parse(iso) / 1000), '2026-10-22 00:05');
  assert.equal(ui.threadTime(String(Date.parse(iso) / 1000)), '2026-10-22 00:05');
  for (const value of [null, undefined, '', 'unknown']) assert.equal(ui.threadTime(value), '');
});

test('same-title same-time conversations retain their real IDs and distinct labels', () => {
  const threads = [
    { id: '11111111-1111-7111-8111-111111111111', title: '大图', updatedAt: 1792645200, preview: '检查光学影像' },
    { id: '11111111-1111-7111-9111-111111111111', title: '大图', updatedAt: 1792645200, preview: '检查雷达影像' },
  ];
  const options = ui.threadOptions(threads);
  assert.equal(new Set(options.map((option) => option.label)).size, 2);
  assert.deepEqual(options.map((option) => option.thread.id), threads.map((thread) => thread.id));
  for (const option of options) {
    assert.ok(option.label.startsWith('大图 · 更新 2026-10-22 '));
    assert.ok(option.label.includes('#' + option.shortId));
    assert.equal(option.thread.title, '大图');
  }
  assert.notEqual(options[0].shortId, options[1].shortId);
  assert.ok(options[0].shortId.length > 6);
});

test('conversation suffixes are unique even with shared UUID prefixes and suffixes', () => {
  const threads = [{ id: '01aa-same-abcdef' }, { id: '01aa-other-abcdef' }, { id: 'abcdef' }, { id: 'short' }];
  const ids = ui.shortThreadIds(threads);
  assert.equal(new Set(ids.values()).size, threads.length);
  for (const { id } of threads) assert.ok(id.endsWith(ids.get(id)));
  assert.equal(ids.get('short'), 'short');
  assert.deepEqual([...ui.shortThreadIds(threads.slice().reverse())].sort(), [...ids].sort());
});

test('thread search covers preview, full and short ID, and Beijing dates', () => {
  const threads = [
    { id: 'unique-abc123', title: '重名', createdAt: '2026-10-21T16:05:00Z', updatedAt: '2026-10-22T02:10:00Z', preview: 'SAR 配准结果' },
    { id: 'unique-def456', title: '重名', updatedAt: '2026-10-20T02:10:00Z', preview: '另一个结果' },
  ];
  for (const query of ['SAR', 'unique-abc123', '#abc123', '2026-10-22', '00:05', '重名 10:10 SAR']) {
    assert.deepEqual(ui.matchingThreads(threads, query).map((option) => option.thread.id), ['unique-abc123']);
  }
  assert.equal(ui.matchingThreads(threads, '重名').length, 2);
  assert.equal(ui.matchingThreads(threads, 'none').length, 0);
});

test('missing timestamps are explicit, created time is a fallback, and duplicate rows are deduplicated by ID', () => {
  const threads = [{ id: 'first-id', title: '标题 <script>' }, { id: 'second-id', title: '标题', updatedAt: 'invalid', createdAt: '2026-10-22T01:00:00Z', busy: true }, { id: 'first-id', title: '重复行' }];
  const options = ui.threadOptions(threads);
  assert.equal(options.length, 2);
  assert.equal(options[0].label, '标题 <script> · 时间未知 · #rst-id');
  assert.equal(options[1].label, '标题 · 创建 2026-10-22 09:00 · #ond-id · 正在运行');
});

test('the actual DeepSeek provider blocks GPT submission before a task can be enqueued', () => {
  const thread = { id: 'legacy-deepseek', title: '旧对话', model: 'gpt-6.1-sol', modelProvider: 'deepseek', providerLabel: 'DeepSeek', providerCompatible: false, providerIssue: '该对话仍绑定 DeepSeek。' };
  const provider = ui.threadProviderStatus(thread);
  assert.equal(provider.compatible, false);
  assert.equal(provider.label, 'DeepSeek');
  assert.ok(provider.issue.includes('该对话仍绑定 DeepSeek'));
  assert.ok(provider.issue.includes('请在 Codex 切换该对话为 OpenAI'));
  assert.ok(provider.issue.includes('仅更改模型名称不会切换服务商'));
  assert.equal(ui.submissionBlockReason({ diagnostics: { ready: true }, thread }), provider.issue);
  assert.ok(ui.threadOptions([thread])[0].label.includes('DeepSeek · 需处理'));
  assert.equal(ui.matchingThreads([thread], 'deepseek')[0].thread.id, thread.id);
});

test('provider identity remains authoritative even if the model label or a stale compatibility flag says GPT', () => {
  assert.equal(ui.threadProviderStatus({ modelProvider: ' DeepSeek ', model: 'gpt-6.1-sol', providerCompatible: true }).compatible, false);
  assert.equal(ui.threadProviderStatus({ modelProvider: 'custom-proxy' }).compatible, false);
  assert.equal(ui.threadProviderStatus({ modelProvider: 'openai', providerCompatible: false }).compatible, false);
  const openai = { modelProvider: ' OpenAI ', providerCompatible: true, providerLabel: 'OpenAI · ChatGPT 订阅' };
  assert.equal(ui.threadProviderStatus(openai).compatible, true);
  assert.equal(ui.submissionBlockReason({ diagnostics: { ready: true }, thread: openai }), '');
});

test('a missing diagnostic report is backward compatible while a failed first setup prevents submission', () => {
  assert.equal(ui.submissionBlockReason({ thread: { title: '旧格式' } }), '');
  assert.equal(ui.threadProviderStatus({}).compatible, null);
  assert.equal(ui.diagnosticsBlockReason({ ready: true, checks: [{ status: 'warning', message: '等待额度恢复' }] }), '');
  const checks = [{ status: 'pass', message: '后台已连接' }, { status: 'fail', message: '请先登录自己的 ChatGPT 账号。' }];
  assert.equal(ui.submissionBlockReason({ diagnostics: { ready: false, checks, summary: '未就绪' } }), '请先登录自己的 ChatGPT 账号。');
  assert.equal(ui.diagnosticsBlockReason({ ready: false, summary: '请重新检测。' }), '请重新检测。');
  assert.ok(ui.submissionBlockReason({ connected: false, diagnostics: { ready: true } }).includes('任务后台未连接'));
});

test('provider blocking explains the selected conversation before unrelated global configuration failures', () => {
  const thread = { modelProvider: 'deepseek' };
  const reason = ui.submissionBlockReason({ diagnostics: { ready: false, checks: [{ status: 'fail', message: '其他设置未完成' }] }, thread });
  assert.ok(reason.includes('这个对话当前未使用受支持的 OpenAI 服务商'));
  assert.ok(reason.includes('选择兼容对话'));
  assert.ok(!reason.includes('其他设置'));
});

test('a complete provider repair instruction from the backend is displayed once', () => {
  const message = '这个对话绑定了其他服务商。请先在 Codex 原对话切换到 OpenAI 订阅通道，再刷新；也可以选择已有的 OpenAI 对话。仅选择 GPT 模型不会切换服务商。';
  const status = ui.threadProviderStatus({ modelProvider: 'deepseek', providerCompatible: false, providerIssue: message });
  assert.equal(status.issue, message);
});
