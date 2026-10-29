"use strict";

// Shared presentation rules; this file has no access to storage or the network.
(() => {
  const editable = new Set(["scheduled", "waiting_quota", "waiting_thread", "paused"]);
  const threadClock = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function desktopConnectionView({ connected = false, desktop = null, initialization = null, reconnecting = false, initializing = false } = {}) {
    const ready = connected && desktop?.connected === true;
    const status = initialization?.status;
    const pending = initializing || status === "connecting" || status === "waiting";
    const message = status === "connected" && !ready ? "" : typeof initialization?.message === "string" ? initialization.message.trim() : "";
    const desktopMessage = typeof desktop?.message === "string" ? desktop.message.trim() : "";
    return {
      ready,
      pending: !ready && pending,
      label: ready ? "已连接" : !connected ? "等待后台" : initializing ? "正在初始化…" : reconnecting ? "正在连接…" : status === "connecting" ? "自动连接中…" : status === "waiting" ? "等待 Codex 连接" : desktop ? "未连接" : "正在检查",
      help: !connected ? "请重新打开任务管理器，任务记录会保留。" : ready ? "" : initializing ? "正在启动初始化…" : message || desktopMessage || "正在自动连接；如未连上，可点击一键初始化。",
      showInitialize: !ready && initialization !== null,
      canInitialize: !ready && connected && !pending && !reconnecting && initialization?.canInitialize === true,
      initializeLabel: initializing ? "初始化中…" : status === "waiting" ? "等待连接…" : "一键初始化",
    };
  }
  function canEditTask(task) {
    return editable.has(task.status) && !task.submissionReceipt && !task.turnId && !["intent", "submitted"].includes(task.dispatchState);
  }
  function taskDeleteBlockReason(task = {}) {
    const status = task.status || task.state;
    if (status === "running") return "任务正在运行或派发中，请等待执行结束后再删除。";
    if (!["scheduled", "waiting_quota", "waiting_thread", "paused", "completed", "failed", "cancelled", "needs_review"].includes(status)) return "当前任务状态暂不支持删除，请刷新任务列表。";
    if (["scheduled", "waiting_quota", "waiting_thread", "paused"].includes(status)
      && (task.submissionReceipt || task.turnId || ["intent", "submitted"].includes(task.dispatchState))) return "这项任务已经提交或正在派发，暂不能删除。请先核对目标对话并刷新列表。";
    return "";
  }
  function canDeleteTask(task) { return !taskDeleteBlockReason(task); }
  function taskDeleteConfirmation(task = {}) {
    const status = task.status || task.state;
    const description = status === "needs_review"
      ? "这项任务可能已经发送到 Codex，当前结果尚未确认。删除后无法恢复，也不再跟踪结果；不会停止对话中已经开始的工作。"
      : ["scheduled", "waiting_quota", "waiting_thread", "paused"].includes(status)
        ? "删除后，这项等待发送的任务将从队列移除，不再自动发送。删除后无法恢复。"
        : "将永久移除此电脑上的任务记录及其执行结果，删除后无法恢复。";
    return {
      title: status === "needs_review" ? "删除结果待核对的任务？" : "删除这项任务？",
      description,
      note: "只删除本地任务记录，不删除 Codex 对话，也不撤回或删除已经发出的消息。",
    };
  }
  function secondsLeft(value, now = Date.now()) {
    if (!value) return null;
    const time = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(time) ? Math.max(0, Math.ceil((time - now) / 1000)) : null;
  }
  function remainingTime(value, now = Date.now()) {
    const total = secondsLeft(value, now);
    if (total === null) return "";
    if (total === 0) return "0 秒";
    const days = Math.floor(total / 86400);
    const hours = Math.floor(total % 86400 / 3600);
    const minutes = Math.floor(total % 3600 / 60);
    const seconds = total % 60;
    return [days ? days + " 天" : "", days || hours ? hours + " 小时" : "", days || hours || minutes ? minutes + " 分" : "", seconds + " 秒"].filter(Boolean).join(" ");
  }
  function taskSendMode(task = {}) { return task.sendMode === "quota_available" ? "quota_available" : "scheduled"; }
  function quotaTriggerHint() { return "创建后自动检测额度，可用时发送一次。"; }
  function quotaRemainingText(usedPercent) {
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return "";
    if (usedPercent === 0) return "100%";
    if (usedPercent === 100) return "0%";
    const rounded = Math.round((100 - usedPercent) * 10) / 10;
    if (rounded >= 100) return "接近100%";
    if (rounded <= 0) return "少于0.1%";
    return rounded + "%";
  }
  function quotaWindowSummary(windows) {
    if (!Array.isArray(windows) || !windows.length) return "";
    if (windows.some((window) => !window || !quotaRemainingText(window.usedPercent) || ![300, 10080].includes(window.windowDurationMins))) return "";
    const buckets = new Set(windows.map((window) => typeof window.limitId === "string" && window.limitId ? window.limitId : "legacy"));
    if (buckets.size !== 1) return "";
    const five = windows.filter((window) => window.windowDurationMins === 300);
    const week = windows.filter((window) => window.windowDurationMins === 10080);
    if (five.length !== 1 || week.length > 1) return "";
    return ["5 小时剩余 " + quotaRemainingText(five[0].usedPercent), week.length ? "周额度剩余 " + quotaRemainingText(week[0].usedPercent) : ""].filter(Boolean).join(" · ");
  }
  function taskTriggerText(task) { return taskSendMode(task) === "quota_available" ? "额度可用时立即发送" : "定时发送"; }
  function cycleStatus(rule = {}) {
    if (rule.status === "needs_review") return { label: "需要核对", tone: "needs_review" };
    if (rule.status === "error") return { label: "需要处理", tone: "error" };
    if (rule.enabled === false || rule.status === "paused") return { label: "已暂停", tone: "paused" };
    if (rule.status === "running") return { label: "本轮执行中", tone: "running" };
    if (rule.status === "waiting_thread") return { label: "等待对话空闲", tone: "waiting_quota" };
    if (rule.status === "awaiting_window_binding") return { label: "等待刷新时间", tone: "waiting_reset" };
    if (rule.status === "queued") return { label: rule.lastTaskStatus === "running" ? "本轮执行中" : "本轮已排队", tone: "running" };
    if (rule.status === "waiting_reset") return { label: "等待下轮刷新", tone: "waiting_reset" };
    if (rule.status === "waiting_quota") return { label: "检测额度", tone: "waiting_quota" };
    return { label: "状态待确认", tone: "paused" };
  }
  function cycleCountdown(rule = {}, now = Date.now()) {
    if (rule.status === "needs_review") return "本轮发送结果需要核对，系统不会自动重复发送。";
    if (rule.status === "error") return "请处理最近提示后再恢复循环。";
    if (rule.enabled === false || rule.status === "paused") return "循环已暂停。";
    if (rule.status === "running") return "正在等待本轮消息执行完成";
    if (rule.status === "awaiting_window_binding") return "本轮已安排，等待刷新时间。";
    if (rule.status === "waiting_thread") return "等待前序任务或对话空闲。";
    if (rule.status === "queued") return rule.lastTaskStatus === "running" ? "正在等待本轮消息执行完成" : "本轮消息已加入任务队列";
    const left = secondsLeft(rule.nextCheckAt, now);
    return left === null ? "等待读取真实额度窗口" : left === 0 ? "正在重新检测额度窗口" : "距离下次检测 " + remainingTime(rule.nextCheckAt, now);
  }
  function cycleCompletedCount(rule = {}) {
    return Number.isSafeInteger(rule.completedCycles) && rule.completedCycles >= 0 ? rule.completedCycles : 0;
  }
  function cycleTriggerHint(quota) {
    const waiting = Array.isArray(quota?.windows) && quota.windows.filter((window) => window?.windowDurationMins === 300).length !== 1;
    return waiting ? "未检测到 5 小时额度窗口，暂不发送。" : "当前满额即发送，否则等待下次刷新；之后每轮一次。";
  }
  function cycleDeleteConfirmation() {
    return "停止后续发送，保留已发消息和对话。正在执行的任务会继续。";
  }
  function taskCountdown(task, now = Date.now()) {
    if (task.status === "scheduled") {
      if (taskSendMode(task) === "quota_available") return "等待检测额度，额度可用时发送";
      const left = secondsLeft(task.runAt, now);
      return left === null ? "" : left === 0 ? "已到时间，等待调度" : "距离发送 " + remainingTime(task.runAt, now);
    }
    if (task.status === "waiting_quota") {
      const next = taskSendMode(task) === "quota_available" ? task.nextAttemptAt : task.quotaResetAt || task.nextAttemptAt;
      const left = secondsLeft(next, now);
      return left === null ? "额度恢复后自动继续" : left === 0 ? "正在重新检查额度" : "距离再次检查额度 " + remainingTime(next, now);
    }
    if (task.status === "waiting_thread") {
      const left = secondsLeft(task.nextAttemptAt, now);
      return left === null || left === 0 ? "等待对话空闲后继续" : "距离再次检查对话 " + remainingTime(task.nextAttemptAt, now);
    }
    return "";
  }
  function pickPreferences(input = {}) {
    const result = {};
    for (const key of ["projectPath", "threadId", "model", "effort", "timeZone"]) {
      if (typeof input[key] === "string" && input[key].length <= (key === "projectPath" ? 32768 : 200)) result[key] = input[key];
    }
    return result;
  }
  function taskNotice(previous, task) {
    if (!previous || previous.status === task.status) return null;
    if (["completed", "succeeded"].includes(task.status)) return { kind: "success", message: "任务已完成", taskId: task.id };
    if (task.status === "failed") return { kind: "error", message: "任务执行失败，请查看任务中的原因", taskId: task.id };
    if (task.status === "needs_review") return { kind: "warning", message: "任务发送结果需要核对，请查看目标对话", taskId: task.id };
    return null;
  }
  function threadTime(value) {
    if (value === null || value === undefined || value === "") return "";
    const numeric = typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value));
    const date = new Date(numeric ? (Number(value) < 1e12 ? Number(value) * 1000 : Number(value)) : value);
    if (!Number.isFinite(date.getTime())) return "";
    const parts = Object.fromEntries(threadClock.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return parts.year + "-" + parts.month + "-" + parts.day + " " + parts.hour + ":" + parts.minute;
  }
  function shortThreadIds(threads) {
    const ids = [...new Set(threads.map((thread) => thread.id).filter((id) => typeof id === "string" && id))];
    const suffixCounts = new Map();
    function countSuffix(id, length) {
      if (!suffixCounts.has(length)) {
        const counts = new Map();
        for (const value of ids) { const suffix = value.slice(-length); counts.set(suffix, (counts.get(suffix) || 0) + 1); }
        suffixCounts.set(length, counts);
      }
      return suffixCounts.get(length).get(id.slice(-length));
    }
    return new Map(ids.map((id) => {
      let length = Math.min(6, id.length);
      while (length < id.length && countSuffix(id, length) > 1) length++;
      return [id, id.slice(-length)];
    }));
  }
  function threadOptions(threads) {
    const ids = shortThreadIds(threads);
    const seen = new Set();
    return threads.filter((thread) => {
      if (!ids.has(thread.id) || seen.has(thread.id)) return false;
      seen.add(thread.id);
      return true;
    }).map((thread) => {
      const title = thread.title || "未命名对话";
      const updated = threadTime(thread.updatedAt);
      const created = threadTime(thread.createdAt);
      const shortId = ids.get(thread.id);
      const date = updated ? "更新 " + updated : created ? "创建 " + created : "时间未知";
      const provider = threadProviderStatus(thread);
      const label = title + " · " + date + " · #" + shortId + (provider.label ? " · " + provider.label : "") + (provider.compatible === false ? " · 需处理" : "") + (thread.busy ? " · 正在运行" : "");
      const searchText = [title, thread.id, thread.preview, updated, created, "#" + shortId, provider.label].filter((value) => typeof value === "string").join(" ").toLocaleLowerCase();
      return { thread, label, shortId, updated, created, searchText };
    });
  }
  function matchingThreads(threads, query) {
    const terms = String(query || "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return threadOptions(threads).filter((option) => terms.every((term) => option.searchText.includes(term)));
  }
  function threadProviderStatus(thread = {}) {
    const provider = typeof thread.modelProvider === "string" ? thread.modelProvider.trim().toLowerCase() : "";
    const explicit = typeof thread.providerCompatible === "boolean" ? thread.providerCompatible : null;
    const compatible = explicit === false || provider && provider !== "openai" ? false : explicit;
    const label = typeof thread.providerLabel === "string" && thread.providerLabel.trim()
      ? thread.providerLabel.trim().slice(0, 120)
      : provider === "openai" ? "OpenAI" : provider === "deepseek" ? "DeepSeek" : provider ? "其他服务商" : "";
    const suppliedIssue = typeof thread.providerIssue === "string" ? thread.providerIssue.trim().slice(0, 500) : "";
    const guidance = "请在 Codex 切换该对话为 OpenAI，或选择兼容对话，然后刷新对话。仅更改模型名称不会切换服务商。";
    const issue = compatible === false
      ? suppliedIssue && /请.*(?:OpenAI|订阅通道)/.test(suppliedIssue) ? suppliedIssue : (suppliedIssue || "这个对话当前未使用受支持的 OpenAI 服务商。") + " " + guidance
      : "";
    return { label, compatible, issue };
  }
  function diagnosticsBlockReason(report) {
    if (!report || report.ready !== false) return "";
    const failed = Array.isArray(report.checks) ? report.checks.find((check) => check.status === "fail") : null;
    return failed?.message || report.summary || "首次设置尚未完成，请按上方自检提示处理后重新检测。";
  }
  function submissionBlockReason({ connected = true, diagnostics = null, thread = null } = {}) {
    if (!connected) return "任务后台未连接，请重新打开时序任务管理器。";
    if (thread && threadProviderStatus(thread).compatible === false) return threadProviderStatus(thread).issue;
    return diagnosticsBlockReason(diagnostics);
  }
  globalThis.SchedulerUI = Object.freeze({ desktopConnectionView, canEditTask, canDeleteTask, taskDeleteBlockReason, taskDeleteConfirmation, secondsLeft, remainingTime, taskSendMode, quotaTriggerHint, quotaRemainingText, quotaWindowSummary, taskTriggerText, taskCountdown, cycleStatus, cycleCountdown, cycleCompletedCount, cycleTriggerHint, cycleDeleteConfirmation, pickPreferences, taskNotice, threadTime, shortThreadIds, threadOptions, matchingThreads, threadProviderStatus, diagnosticsBlockReason, submissionBlockReason });
})();
