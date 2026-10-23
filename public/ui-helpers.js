"use strict";

// Shared presentation rules; this file has no access to storage or the network.
(() => {
  const editable = new Set(["scheduled", "waiting_quota", "waiting_thread", "paused"]);
  const threadClock = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
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
  function quotaTriggerHint() { return "保存后每 30 秒检测；当前额度可用时立即发送，无需设置时间。勾选后仍需创建任务。"; }
  function taskTriggerText(task) { return taskSendMode(task) === "quota_available" ? "额度可用时立即发送" : "定时发送"; }
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
  globalThis.SchedulerUI = Object.freeze({ canEditTask, canDeleteTask, taskDeleteBlockReason, taskDeleteConfirmation, secondsLeft, remainingTime, taskSendMode, quotaTriggerHint, taskTriggerText, taskCountdown, pickPreferences, taskNotice, threadTime, shortThreadIds, threadOptions, matchingThreads, threadProviderStatus, diagnosticsBlockReason, submissionBlockReason });
})();
