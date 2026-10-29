import assert from 'node:assert/strict';
import test from 'node:test';
await import('../public/ui-helpers.js');
const ui = globalThis.SchedulerUI;

test('opening initialization is still waiting until the desktop connection is confirmed', () => {
  const view = ui.desktopConnectionView({ connected: true, desktop: { connected: false }, initialization: { status: 'waiting', message: '已打开 Codex，等待连接。', canInitialize: false } });
  assert.equal(view.ready, false);
  assert.equal(view.pending, true);
  assert.equal(view.canInitialize, false);
  assert.equal(view.showInitialize, true);
  assert.match(view.label, /等待/);
  assert.doesNotMatch(view.label, /已连接/);
  assert.match(view.help, /等待连接/);
});

test('a verified connection hides initialization even when a delayed initialization status still says waiting', () => {
  const view = ui.desktopConnectionView({ connected: true, desktop: { connected: true }, initialization: { status: 'waiting', message: '正在等待', canInitialize: false }, initializing: true });
  assert.equal(view.ready, true);
  assert.equal(view.pending, false);
  assert.equal(view.label, '已连接');
  assert.equal(view.showInitialize, false);
  assert.equal(view.canInitialize, false);
  assert.equal(view.help, '');
});

test('initialization retry requires explicit server permission and an available local background', () => {
  const input = { connected: true, desktop: { connected: false }, initialization: { status: 'error', message: '连接超时，请重试。', canInitialize: true } };
  assert.equal(ui.desktopConnectionView(input).canInitialize, true);
  assert.match(ui.desktopConnectionView(input).help, /连接超时/);
  assert.equal(ui.desktopConnectionView({ ...input, connected: false }).canInitialize, false);
  assert.equal(ui.desktopConnectionView({ ...input, connected: false, desktop: { connected: true } }).ready, false);
  assert.equal(ui.desktopConnectionView({ ...input, initialization: { ...input.initialization, canInitialize: false } }).canInitialize, false);
  assert.equal(ui.desktopConnectionView({ ...input, initialization: null }).showInitialize, false);
});

test('initialization in progress cannot launch a duplicate or override an actual connected flag', () => {
  const input = { connected: true, desktop: { connected: false }, initialization: { status: 'idle', canInitialize: true }, initializing: true };
  assert.equal(ui.desktopConnectionView(input).canInitialize, false);
  assert.equal(ui.desktopConnectionView(input).pending, true);
  assert.match(ui.desktopConnectionView(input).label, /初始化/);
  assert.equal(ui.desktopConnectionView({ ...input, desktop: { connected: true } }).ready, true);
});

test('initialization status alone never displays a successful sending connection', () => {
  const view = ui.desktopConnectionView({ connected: true, desktop: { connected: false }, initialization: { status: 'connected', message: '连接成功', canInitialize: false } });
  assert.equal(view.ready, false);
  assert.equal(view.label, '未连接');
  assert.doesNotMatch(view.help, /成功|已连接/);
});

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

test('pending, paused and historical records can be deleted while running and unknown tasks stay protected', () => {
  for (const status of ['scheduled', 'waiting_quota', 'waiting_thread', 'paused', 'completed', 'failed', 'cancelled', 'needs_review']) {
    assert.equal(ui.canDeleteTask({ status }), true, status);
    assert.equal(ui.taskDeleteBlockReason({ status }), '');
  }
  for (const status of ['running', 'unexpected', undefined]) assert.equal(ui.canDeleteTask({ status }), false, String(status));
  assert.match(ui.taskDeleteBlockReason({ status: 'running' }), /运行或派发中/);
});

test('pending records with an uncertain dispatch cannot be hidden by deletion', () => {
  for (const status of ['scheduled', 'waiting_quota', 'waiting_thread', 'paused']) {
    for (const extra of [{ submissionReceipt: {} }, { turnId: 'turn-1' }, { dispatchState: 'intent' }, { dispatchState: 'submitted' }]) {
      assert.equal(ui.canDeleteTask({ status, ...extra }), false, status + JSON.stringify(extra));
    }
    assert.equal(ui.canDeleteTask({ status, dispatchState: null, lastRejectedSubmission: {} }), true);
  }
});

test('review and terminal records remain removable even when past delivery evidence is present', () => {
  for (const status of ['needs_review', 'completed', 'failed', 'cancelled']) {
    assert.equal(ui.canDeleteTask({ status, submissionReceipt: {}, turnId: 'past-turn', dispatchState: 'submitted' }), true, status);
  }
});

test('deletion confirmation distinguishes unsent, historical and uncertain deliveries without promising a retraction', () => {
  const scheduled = ui.taskDeleteConfirmation({ status: 'waiting_quota' });
  assert.match(scheduled.description, /不再自动发送/);
  const completed = ui.taskDeleteConfirmation({ status: 'completed' });
  assert.match(completed.description, /执行结果/);
  const uncertain = ui.taskDeleteConfirmation({ status: 'needs_review', dispatchState: 'intent' });
  assert.match(uncertain.title, /待核对/);
  assert.match(uncertain.description, /可能已经发送/);
  assert.match(uncertain.description, /删除后无法恢复/);
  assert.match(uncertain.description, /不再跟踪结果/);
  assert.match(uncertain.description, /不会停止/);
  for (const status of ['scheduled', 'completed', 'needs_review']) {
    const { note } = ui.taskDeleteConfirmation({ status });
    assert.match(note, /不删除 Codex 对话/);
    assert.match(note, /不撤回或删除已经发出的消息/);
  }
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
  assert.ok(hint.includes('创建后自动检测额度'));
  assert.ok(hint.includes('可用时发送一次'));
});
test('quota mode is never retained as a new-task preference', () => {
  assert.deepEqual(ui.pickPreferences({ sendMode: 'quota_available', quotaTrigger: true, model: 'model', threadId: 'thread' }), { model: 'model', threadId: 'thread' });
});

test('quota cycles distinguish pause, pending completion and uncertain delivery without promising another send', () => {
  assert.deepEqual(ui.cycleStatus({ enabled: false, status: 'paused' }), { label: '已暂停', tone: 'paused' });
  assert.equal(ui.cycleStatus({ enabled: true, status: 'queued', lastTaskStatus: 'running' }).label, '本轮执行中');
  assert.equal(ui.cycleStatus({ enabled: true, status: 'queued', lastTaskStatus: 'waiting_thread' }).label, '本轮已排队');
  assert.equal(ui.cycleStatus({ enabled: false, status: 'needs_review' }).label, '需要核对');
  assert.equal(ui.cycleStatus({ enabled: false, status: 'error' }).label, '需要处理');
  assert.equal(ui.cycleStatus({ enabled: true, status: 'waiting_reset' }).label, '等待下轮刷新');
  assert.equal(ui.cycleStatus({ enabled: true, status: 'running' }).label, '本轮执行中');
  assert.equal(ui.cycleStatus({ enabled: true, status: 'waiting_thread' }).label, '等待对话空闲');
  assert.equal(ui.cycleStatus({ enabled: true, status: 'awaiting_window_binding' }).label, '等待刷新时间');
  assert.equal(ui.cycleStatus({ enabled: true, status: 'unrecognized' }).label, '状态待确认');
  assert.match(ui.cycleCountdown({ enabled: false, status: 'needs_review' }), /不会自动重复发送/);
  assert.match(ui.cycleCountdown({ enabled: false, status: 'paused' }), /已暂停/);
  assert.match(ui.cycleCountdown({ enabled: true, status: 'awaiting_window_binding' }), /本轮已安排.*等待刷新时间/);
  assert.match(ui.cycleCountdown({ enabled: true, status: 'waiting_thread' }), /等待前序任务或对话空闲/);
});

test('quota cycle countdown uses the real next check and never invents a fixed five-hour send time', () => {
  const now = Date.parse('2026-10-26T02:00:00Z');
  const rule = { enabled: true, status: 'waiting_reset', nextCheckAt: new Date(now + 30000).toISOString(), nextResetAt: new Date(now + 3600000).toISOString() };
  assert.equal(ui.cycleCountdown(rule, now), '距离下次检测 30 秒');
  assert.equal(ui.cycleCountdown(rule, now + 30000), '正在重新检测额度窗口');
  delete rule.nextCheckAt;
  assert.equal(ui.cycleCountdown(rule, now), '等待读取真实额度窗口');
  assert.equal(ui.cycleCountdown({ enabled: true, status: 'queued', lastTaskStatus: 'running' }, now), '正在等待本轮消息执行完成');
});

test('quota cycle counts only confirmed completed rounds and does not infer success from a queued message', () => {
  assert.equal(ui.cycleCompletedCount({ completedCycles: 3 }), 3);
  for (const value of [undefined, null, '3', -1, 1.5, NaN, Infinity]) assert.equal(ui.cycleCompletedCount({ completedCycles: value, lastTaskStatus: 'running' }), 0);
});

test('quota cycle guidance requires explicit enabling and describes one message per real window', () => {
  assert.match(ui.cycleTriggerHint(), /当前满额/);
  assert.match(ui.cycleTriggerHint(), /等待下次刷新/);
  assert.match(ui.cycleTriggerHint(), /之后每轮一次/);
  assert.match(ui.cycleDeleteConfirmation(), /停止后续发送/);
  assert.match(ui.cycleDeleteConfirmation(), /保留已发消息和对话/);
  assert.match(ui.cycleDeleteConfirmation(), /正在执行的任务会继续/);
  assert.deepEqual(ui.pickPreferences({ cycleMode: true, enabled: true, model: 'gpt-fixture', prompt: 'private' }), { model: 'gpt-fixture' });
});

test('quota display distinguishes exact full capacity from rounded fractional usage', () => {
  assert.equal(ui.quotaRemainingText(0), '100%');
  assert.equal(ui.quotaRemainingText(0.4), '99.6%');
  assert.equal(ui.quotaRemainingText(0.0001), '接近100%');
  assert.equal(ui.quotaRemainingText(25), '75%');
  assert.equal(ui.quotaRemainingText(99.999), '少于0.1%');
  assert.equal(ui.quotaRemainingText(100), '0%');
  for (const value of [undefined, null, '0', -1, 101, NaN, Infinity]) assert.equal(ui.quotaRemainingText(value), '');
});

test('five-hour and weekly quota summaries remain distinct even when the week has lower capacity', () => {
  const windows = [{ limitId: 'codex', usedPercent: 0, windowDurationMins: 300 }, { limitId: 'codex', usedPercent: 8, windowDurationMins: 10080 }];
  assert.equal(ui.quotaWindowSummary(windows), '5 小时剩余 100% · 周额度剩余 92%');
  assert.equal(ui.quotaWindowSummary([{ usedPercent: 0.4, windowDurationMins: 300 }]), '5 小时剩余 99.6%');
  assert.equal(ui.quotaWindowSummary([{ usedPercent: 0.0001, windowDurationMins: 300 }]), '5 小时剩余 接近100%');
});

test('multiple quota buckets, malformed windows and unrecognized durations keep the conservative summary', () => {
  const five = { limitId: 'codex', usedPercent: 0, windowDurationMins: 300 };
  for (const windows of [null, [], [{ ...five, usedPercent: null }], [{ ...five, windowDurationMins: 60 }], [five, { ...five }], [five, { limitId: 'other', usedPercent: 5, windowDurationMins: 10080 }], [{ limitId: 'codex', usedPercent: 5, windowDurationMins: 10080 }]]) assert.equal(ui.quotaWindowSummary(windows), '');
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

test('cycle setup explains a weekly-only or ambiguous quota instead of promising immediate sends', () => {
  assert.match(ui.cycleTriggerHint({ windows: [{ windowDurationMins: 10080, usedPercent: 19 }] }), /未检测到 5 小时额度窗口.*暂不发送/);
  assert.match(ui.cycleTriggerHint({ windows: [] }), /暂不发送/);
  assert.match(ui.cycleTriggerHint({ windows: [{ windowDurationMins: 300 }, { windowDurationMins: 300 }] }), /暂不发送/);
  assert.doesNotMatch(ui.cycleTriggerHint({ windows: [{ windowDurationMins: 300, usedPercent: 0 }, { windowDurationMins: 10080, usedPercent: 19 }] }), /暂不发送/);
});
