"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const ui = globalThis.SchedulerUI;
  const state = {
    projects: [], models: [], threads: [], tasks: [], quota: null, worker: null, desktop: null,
    timeZone: "Asia/Shanghai", filter: "active", connected: false,
    loadingThreads: false, threadRequest: 0, polling: false, submitting: false,
    taskSignature: "", toastTimeout: null, actionPending: new Set(), token: "", pendingCreation: null,
    preferences: {}, preferenceTail: Promise.resolve(), editingId: null, draftSnapshot: null, loadingDraft: false,
    reconnecting: false, noticeTaskId: null, loadedTasks: false,
    diagnostics: null, checkingSetup: false, setupReported: false, diagnosticsSignature: "",
    pendingActions: new Map(), threadError: null, selectedThreadId: "", renderedFilter: "active", bootstrapping: false,
    deletedTaskIds: new Set(),
    alerts: { general: null, connection: null, desktop: null },
  };
  const labels = {
    scheduled: "待执行", queued: "排队中", waiting_quota: "等待额度", waiting_quota_reset: "等待额度",
    waiting_thread: "等待对话", running: "执行中", completed: "已完成", succeeded: "已完成",
    failed: "执行失败", paused: "已暂停", cancelled: "已取消", canceled: "已取消",
    retry_wait: "等待重试", needs_review: "需要核对",
  };
  const terminal = new Set(["completed", "succeeded", "cancelled", "canceled"]);
  const completed = new Set(["completed", "succeeded"]);
  const waiting = new Set(["waiting_quota", "waiting_quota_reset"]);
  const statusOf = (task) => task.status || task.state || "scheduled";
  const element = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  };
  const icon = (type) => {
    const paths = { clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-9.5a8.5 8.5 0 0 1 17 0Z"/><path d="M7 9h9M7 13h6"/>' };
    const wrapper = element("span");
    // Only hard-coded paths enter this fragment. All server content uses textContent.
    wrapper.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' + (paths[type] || paths.clock) + "</svg>";
    return wrapper.firstChild;
  };
  function readToken() {
    const url = new URL(window.location.href);
    const received = url.searchParams.get("token");
    try {
      if (received) {
        sessionStorage.setItem("scheduler-access", received);
        state.token = received;
        url.searchParams.delete("token");
        history.replaceState(null, "", url.pathname + url.search + url.hash);
      } else state.token = sessionStorage.getItem("scheduler-access") || "";
    } catch (_) { state.token = received || ""; }
  }
  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(path, {
        ...options, signal: controller.signal,
        cache: "no-store", credentials: "same-origin",
        headers: { Authorization: "Bearer " + state.token, ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
      });
      let data;
      try { data = await response.json(); }
      catch (error) { if (error.name === "AbortError") throw error; throw new Error("暂时无法读取响应，请稍后刷新重试。"); }
      if (!response.ok) {
        const error = new Error(data.message || data.error || "操作未完成，请稍后重试。");
        error.status = response.status; error.code = data.error; throw error;
      }
      return data;
    } finally { clearTimeout(timeout); }
  }
  function showAlert(message, kind = "warning", source = "general") {
    state.alerts[source] = message ? { message, kind } : null;
    const alerts = Object.values(state.alerts).filter(Boolean);
    const node = $("global-alert");
    node.className = "alert " + (alerts.some((alert) => alert.kind === "error") ? "error" : "warning");
    node.textContent = alerts.map((alert) => alert.message).join("\n");
    node.style.whiteSpace = "pre-line";
    node.hidden = !alerts.length;
  }
  function updateDesktop(desktop) {
    if (desktop !== undefined) state.desktop = desktop;
    const message = state.desktop?.message;
    showAlert(state.desktop?.connected === false
      ? typeof message === "string" && /[\u3400-\u9fff]/.test(message) ? message : "Codex 发送服务尚未连接。请保持 Codex 运行，然后点击“重新连接”；任务会保留。"
      : "", "warning", "desktop");
    renderServices();
  }
  function toast(message, error = false) {
    clearTimeout(state.toastTimeout);
    const node = $("toast");
    node.className = "toast" + (error ? " error" : "");
    node.textContent = message;
    node.hidden = false;
    state.toastTimeout = setTimeout(() => { node.hidden = true; }, error ? 6500 : 4000);
  }
  function connection(online) {
    state.connected = online;
    $("connection-dot").className = "connection-dot " + (online ? "online" : "offline");
    $("connection-label").textContent = online ? "后台已连接" : "后台未连接";
    renderWorker();
    renderServices();
    setComposerMode();
    if (state.loadedTasks) renderTasks();
  }
  function renderServices() {
    const workerReady = state.connected && !["stopped", "stopping", "error"].includes(state.worker?.status);
    $("background-dot").className = "service-dot " + (workerReady ? "online" : "offline");
    $("background-label").textContent = !state.connected ? "连接已中断" : workerReady ? "已连接" : "尚未运行";
    const desktopReady = state.desktop?.connected === true;
    $("desktop-dot").className = "service-dot " + (desktopReady ? "online" : state.desktop ? "offline" : "");
    $("desktop-label").textContent = state.reconnecting ? "正在重新连接…" : desktopReady ? "已连接" : state.desktop ? "未连接" : "正在检查";
    $("reconnect-button").hidden = desktopReady;
    $("reconnect-button").disabled = state.reconnecting || !state.connected || state.submitting || state.loadingDraft || state.checkingSetup || state.bootstrapping;
    $("reconnect-button").textContent = state.reconnecting ? "连接中…" : "重新连接";
    $("service-help").textContent = !state.connected ? "请双击“时序任务管理器”重新打开，任务记录会保留。" : desktopReady ? "保持 Codex 运行、电脑唤醒，任务会按时发送。" : "请完成连接自检。已有任务会保留，连接恢复后继续。";
  }
  function updateDiagnostics(report) {
    if (report === undefined) return;
    const previousReady = state.diagnostics?.ready;
    state.diagnostics = report;
    const checks = Array.isArray(report?.checks) ? report.checks : [];
    const summary = report?.ready === true ? (checks.length ? checks.length + " 项检查通过，可以安排任务" : "本机设置已就绪") : report?.summary || (report?.ready === false ? "还需完成以下设置" : "暂未获取自检结果，请点击重新检测");
    if ($("setup-summary").textContent !== summary) $("setup-summary").textContent = summary;
    $("setup-panel").classList.toggle("needs-attention", report?.ready === false);
    const signature = JSON.stringify(checks);
    if (signature !== state.diagnosticsSignature) $("setup-checks").replaceChildren(...checks.map((check) => {
      const status = ["pass", "fail", "warning"].includes(check.status) ? check.status : "warning";
      const item = element("li", "setup-check " + status);
      const label = { pass: "通过", fail: "待处理", warning: "提示" }[status];
      item.append(element("span", "setup-check-status", label));
      const body = element("div", "setup-check-content");
      body.append(element("strong", "", check.title || "配置检查"));
      if (check.message) body.append(element("p", "", check.message));
      if (typeof check.action === "string" && check.action.trim() && check.action !== check.message) body.append(element("p", "setup-check-action", check.action));
      item.append(body);
      return item;
    }));
    state.diagnosticsSignature = signature;
    $("setup-checked-at").textContent = report?.checkedAt ? "检查于 " + formatDate(report.checkedAt) + "；检查不会发送消息。" : "检查不会创建任务或发送消息。";
    if (!state.setupReported && report) { $("setup-panel").open = report.ready !== true; state.setupReported = true; }
    if (report?.ready === false && previousReady !== false) $("setup-panel").open = true;
    setComposerMode();
  }
  async function checkSetup() {
    if (state.checkingSetup || state.submitting || state.loadingDraft) return;
    state.checkingSetup = true;
    setComposerMode();
    $("diagnostics-button").disabled = true;
    $("diagnostics-button").setAttribute("aria-busy", "true");
    $("diagnostics-button").classList.add("is-loading");
    $("diagnostics-button").textContent = "正在检测…";
    $("setup-error").hidden = true;
    try {
      const report = await api("/api/diagnostics", { method: "POST", body: "{}" });
      updateDiagnostics(report.diagnostics || report);
      const previousThread = $("thread-select").value;
      const data = await api("/api/bootstrap");
      state.projects = data.projects || [];
      state.models = data.models || [];
      if (data.worker) state.worker = data.worker;
      if (data.quota !== undefined) state.quota = data.quota;
      receiveTasks(data.tasks || []);
      connection(true); updateDesktop(data.desktop); updateDiagnostics(data.diagnostics);
      populateProjects(data); populateModels();
      $("schedule-fields").disabled = false;
      renderQuota(); renderTasks();
      await loadThreads(previousThread);
      showAlert("", "warning", "connection");
      if (state.diagnostics?.ready) toast("本机设置和连接检查通过");
    } catch (error) {
      $("setup-error").textContent = "检测未完成：" + readableError(error);
      $("setup-error").hidden = false;
      $("setup-panel").open = true;
    } finally {
      state.checkingSetup = false;
      $("diagnostics-button").disabled = false;
      $("diagnostics-button").setAttribute("aria-busy", "false");
      $("diagnostics-button").classList.remove("is-loading");
      $("diagnostics-button").textContent = "重新检测";
      setComposerMode();
    }
  }
  async function reconnectDesktop() {
    if (state.reconnecting || !state.connected) return;
    state.reconnecting = true;
    renderServices();
    showAlert("", "warning", "general");
    try {
      const data = await api("/api/desktop/reconnect", { method: "POST", body: "{}" });
      updateDesktop(data.desktop);
      updateDiagnostics(data.diagnostics);
      if (data.desktop?.connected) toast("Codex 发送服务已连接");
      else showAlert(data.desktop?.message || "还未连上 Codex。请确认 Codex 已运行，然后再次连接。任务会继续保留。", "warning", "desktop");
      await poll();
      await checkSetup();
    } catch (error) { showAlert("重新连接未完成：" + readableError(error), "error", "desktop"); }
    finally { state.reconnecting = false; renderServices(); }
  }
  function readPreferences() {
    try { return ui.pickPreferences(JSON.parse(localStorage.getItem("scheduler-preferences") || "{}")); }
    catch (_) { return {}; }
  }
  function rememberPreferences() {
    const preferences = ui.pickPreferences({ projectPath: $("project-select").value, threadId: $("thread-select").value, model: $("model-select").value, effort: $("effort-select").value, timeZone: $("timezone-select").value });
    state.preferences = preferences;
    try { localStorage.setItem("scheduler-preferences", JSON.stringify(preferences)); } catch (_) { /* The server copy still survives browser storage restrictions. */ }
    state.preferenceTail = state.preferenceTail.catch(() => {}).then(() => api("/api/preferences", { method: "PUT", body: JSON.stringify(preferences) })).then(() => {
      showAlert("", "warning", "preferences");
    }).catch(() => {
      showAlert("当前选择已在此页面记住，但暂时无法保存到后台。任务创建不受影响；下次打开时可能需要重新选择。", "warning", "preferences");
    });
  }
  function readableError(error) {
    if (error.name === "AbortError") return "连接响应超时。任务记录会保留，请刷新确认状态后再操作。";
    if (error.status === 401 || error.status === 403) return "访问已失效，请双击桌面或开始菜单的“时序任务管理器”重新打开。";
    if (error instanceof TypeError) return "暂时无法连接调度服务。任务记录会保留，连接恢复后自动刷新。";
    return friendlyMessage(error.message) || "操作未完成，请稍后重试。";
  }
  function friendlyMessage(value, status) {
    const message = String(value || "").trim();
    if (!message) return "";
    const messages = {
      "Task not found.": "未找到这个任务，请刷新列表后重试。",
      "This task is running or being dispatched; its submitted turn cannot be changed or cancelled.": "任务已经开始发送，暂时无法修改或取消。请打开目标对话查看进度。",
      "Only pending or paused tasks can be edited.": "这个任务已开始处理，暂时无法修改。",
      "Only pending tasks can be paused.": "任务状态已变化，当前无法暂停，请刷新列表。",
      "Only paused tasks can be resumed.": "任务状态已变化，当前无需恢复，请刷新列表。",
      "A completed task cannot be cancelled.": "这个任务已经完成，无需取消。",
      "Only failed tasks or tasks needing review can be retried.": "这个任务当前无需重试，请刷新列表查看状态。",
      "The previous submission is uncertain and may already have run. Review the conversation first, then explicitly acknowledge duplicate risk.": "上次任务可能已经执行。请先核对目标对话，再确认是否重试。",
      "Waiting for the selected model quota to recover.": "正在等待所选模型的额度恢复，恢复后自动执行。",
      "Waiting for the conversation to become idle.": "目标对话暂不可用，任务已保留，稍后会再次检查。",
      "The conversation is currently running another turn.": "对话正在运行其他任务，任务已保留，稍后会再次检查。",
      "Could not verify conversation state.": "暂时无法确认对话状态，请检查目标对话后重试。",
      "This conversation is archived. Unarchive it or select an active conversation before retrying.": "对话已归档。请先在 Codex 中取消归档，再重试任务。",
      "The selected conversation belongs to a different project directory.": "对话与所选项目不一致。请取消这个任务，并重新选择项目和对话。",
      "Could not verify the selected model quota.": "暂时无法确认所选模型的额度，请稍后重试。",
      "The submission result could not be confirmed. Check the conversation before retrying.": "未能确认任务是否已经发送，请先核对目标对话，再决定是否重试。",
      "A turn ID was returned with a pre-submission wait. Check the conversation before retrying.": "任务的发送状态未能确认，请先核对目标对话，再决定是否重试。",
      "The turn was interrupted; manual retry is required.": "任务已中断。请核对目标对话后，手动重试。",
      "The turn failed; manual retry is required.": "任务执行未完成，请查看目标对话后重试。",
      "The previous submission needs manual review before any resend.": "上次任务的结果需要核对。请先查看目标对话，再决定是否重试。",
      "effort is not supported.": "所选模型不支持这个思考强度，请重新选择。",
      "timeZone must be a valid IANA timezone.": "所选时区不可用，请重新选择。",
      "projectPath must be an absolute directory path.": "项目目录不可用，请刷新后重新选择。",
    };
    if (messages[message]) return messages[message];
    if (/already has an active writer/i.test(message)) return "Codex 占用了此对话的写入连接，插件暂时无法接入该发送通道。";
    const uncertainPrefix = /^(Submission status is uncertain:|Could not reconcile the previous submission:)\s*/i;
    if (uncertainPrefix.test(message)) {
      const reason = message.replace(uncertainPrefix, "").replace(/\.?\s*Check the conversation before retrying\.$/i, "").trim();
      if (/[\u3400-\u9fff]/.test(reason)) return reason;
      return "未能确认上次任务的发送结果，请先核对目标对话，再决定是否重试。";
    }
    if (/^runAt (must be|is not)/.test(message)) return "发送时间无效，请重新选择日期和时间。";
    if (/^(projectPath|threadId|model|prompt|effort) must be a non-empty string/.test(message)) return "任务信息不完整，请检查项目、对话、模型和发送内容。";
    if (!/[\u3400-\u9fff]/.test(message)) {
      if (status === "waiting_thread") return "目标对话暂不可用，任务已保留，稍后会再次检查。";
      if (waiting.has(status)) return "正在等待额度恢复，恢复后自动执行。";
      if (status === "needs_review") return "上次任务的结果未能确认，请先查看目标对话，再决定是否重试。";
    }
    return message;
  }
  function validDate(value) {
    if (value === undefined || value === null || value === "") return null;
    const numeric = typeof value === "number" || /^\d{10,13}$/.test(String(value));
    const date = new Date(numeric ? (Number(value) < 1e12 ? Number(value) * 1000 : Number(value)) : value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function formatDate(value, timeZone = state.timeZone, includeYear = false) {
    const date = validDate(value);
    if (!date) return "时间待确认";
    try {
      return new Intl.DateTimeFormat("zh-CN", { timeZone, ...(includeYear ? { year: "numeric" } : {}), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
    } catch (_) { return date.toLocaleString("zh-CN"); }
  }
  function dateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
    return Object.fromEntries(parts.filter((item) => item.type !== "literal").map((item) => [item.type, Number(item.value)]));
  }
  function asInput(date, timeZone) {
    const p = dateParts(date, timeZone);
    const pad = (n) => String(n).padStart(2, "0");
    return p.year + "-" + pad(p.month) + "-" + pad(p.day) + "T" + pad(p.hour) + ":" + pad(p.minute);
  }
  function zonedTimeToISO(value, timeZone) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!match) throw new Error("请选择完整的发送日期和时间。");
    const [, year, month, day, hour, minute, second = "0"] = match;
    const target = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
    let guess = target;
    for (let i = 0; i < 4; i++) {
      const p = dateParts(new Date(guess), timeZone);
      const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
      const next = target - offset;
      if (next === guess) break;
      guess = next;
    }
    const p = dateParts(new Date(guess), timeZone);
    if (p.year !== +year || p.month !== +month || p.day !== +day || p.hour !== +hour || p.minute !== +minute || p.second !== +second) throw new Error("这个时间在所选时区不存在，请选择其他时间。");
    return new Date(guess).toISOString();
  }
  function setDefaultTime() {
    setQuickTime(60);
  }
  function setQuickTime(minutes) {
    if ($("quota-trigger").checked) return;
    const date = new Date(Math.ceil((Date.now() + minutes * 60 * 1000) / 60000) * 60000);
    date.setSeconds(0, 0);
    $("run-at").value = asInput(date, $("timezone-select").value);
    updateTimePreview();
    for (const button of document.querySelectorAll(".quick-times button")) button.setAttribute("aria-pressed", String(Number(button.dataset.minutes) === minutes));
  }
  function updateTimePreview() {
    const zone = $("timezone-select").value;
    $("footer-timezone").textContent = zone;
    if ($("quota-trigger").checked) { $("time-preview").textContent = "仅适用于这项任务；额度可用后只发送一次。"; return; }
    if (!$("run-at").value) { $("time-preview").textContent = "到达设定时间后进入执行队列。"; return; }
    try {
      const iso = zonedTimeToISO($("run-at").value, zone);
      $("time-preview").textContent = "计划于 " + formatDate(iso, zone, true) + " 发送。";
    } catch (error) { $("time-preview").textContent = error.message; }
  }
  function updateSendMode() {
    const quota = $("quota-trigger").checked;
    $("scheduled-time-controls").hidden = quota;
    $("run-at").required = !quota;
    $("run-at").disabled = quota;
    $("run-at-required").hidden = quota;
    for (const button of document.querySelectorAll(".quick-times button")) button.disabled = quota;
    $("timezone-select").disabled = quota;
    $("quota-trigger-help").hidden = !quota;
    $("quota-trigger-help").textContent = ui.quotaTriggerHint();
    $("quota-trigger").closest(".quota-trigger-option").classList.toggle("selected", quota);
    updateTimePreview();
    setComposerMode();
  }
  function populateProjects(data) {
    const select = $("project-select");
    const previous = select.value || state.preferences.projectPath;
    select.replaceChildren(element("option", "", "请选择项目"));
    select.firstChild.value = "";
    for (const project of state.projects) {
      const option = element("option", "", project.label || project.name || project.path);
      option.value = project.path;
      select.append(option);
    }
    if (state.projects.some((project) => project.path === previous)) select.value = previous;
    else if (data.currentProjectPath && state.projects.some((project) => project.path === data.currentProjectPath)) select.value = data.currentProjectPath;
    else if (state.projects.length === 1) select.value = state.projects[0].path;
    if (!state.projects.length) {
      select.firstChild.textContent = "暂无可用项目";
      $("thread-help").textContent = "请先在 Codex 中添加项目，然后刷新。";
    }
  }
  function populateModels() {
    const select = $("model-select");
    const previous = select.value || state.preferences.model;
    select.replaceChildren();
    for (const model of state.models) {
      const option = element("option", "", model.displayName || model.display_name || model.name || model.id);
      option.value = model.id;
      select.append(option);
    }
    if (!state.models.length) {
      const option = element("option", "", "暂无可用模型"); option.value = ""; select.append(option);
    }
    if (state.models.some((model) => model.id === previous)) select.value = previous;
    populateEfforts();
  }
  function populateEfforts() {
    const select = $("effort-select");
    const model = state.models.find((item) => item.id === $("model-select").value);
    const previous = select.value || (model?.id === state.preferences.model ? state.preferences.effort : "");
    const efforts = model?.supportedReasoningEfforts || model?.supported_reasoning_efforts || [];
    const names = { none: "无", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "超高" };
    select.replaceChildren();
    for (const effort of efforts) {
      const value = typeof effort === "string" ? effort : effort.reasoningEffort || effort.reasoning_effort || effort.effort;
      if (!value) continue;
      const option = element("option", "", names[value] || value);
      option.value = value;
      if (typeof effort === "object" && effort.description) option.title = effort.description;
      select.append(option);
    }
    if (!select.options.length) { const option = element("option", "", "默认"); option.value = ""; select.append(option); }
    const values = Array.from(select.options, (option) => option.value);
    const preferred = model?.defaultReasoningEffort || model?.default_reasoning_effort;
    select.value = values.includes(previous) ? previous : values.includes(preferred) ? preferred : values[0];
  }
  async function loadThreads(preferred) {
    const request = ++state.threadRequest;
    const path = $("project-select").value;
    const previous = typeof preferred === "string" ? preferred : $("thread-select").value || state.selectedThreadId;
    state.selectedThreadId = previous;
    state.threadError = null;
    state.threads = [];
    state.loadingThreads = !!path;
    $("refresh-threads").disabled = !!path;
    $("refresh-threads").setAttribute("aria-busy", String(!!path));
    $("refresh-threads").textContent = path ? "读取中…" : "刷新对话";
    renderThreads(previous);
    if (!path) { $("refresh-threads").disabled = false; return; }
    try {
      const data = await api("/api/threads?projectPath=" + encodeURIComponent(path));
      if (request !== state.threadRequest) return;
      state.threads = (data.threads || []).filter((thread) => !thread.archived);
      state.loadingThreads = false;
      renderThreads(previous);
      showAlert("", "warning", "threads");
    } catch (error) {
      if (request !== state.threadRequest) return;
      state.loadingThreads = false;
      state.threadError = readableError(error);
      renderThreads();
      $("thread-help").textContent = readableError(error);
      const message = readableError(error);
      showAlert("读取对话失败：" + message + (/刷新|重试/.test(message) ? "" : " 点击“刷新对话”重试。"), "error", "threads");
    } finally { if (request === state.threadRequest) { $("refresh-threads").disabled = false; $("refresh-threads").setAttribute("aria-busy", "false"); $("refresh-threads").textContent = "刷新对话"; } }
  }
  function renderThreads(previous = $("thread-select").value) {
    const select = $("thread-select");
    select.replaceChildren();
    const query = $("thread-search").value;
    const available = ui.matchingThreads(state.threads, query);
    const matchedCount = available.length;
    const selected = state.threads.find((thread) => thread.id === previous || thread.id === state.selectedThreadId);
    if (query.trim() && selected && !available.some(({ thread }) => thread.id === selected.id)) {
      const pinned = ui.threadOptions([selected])[0];
      if (pinned) available.unshift({ ...pinned, label: "当前已选 · " + pinned.label });
    }
    const placeholder = element("option", "", state.loadingThreads ? "正在读取对话…" : state.threadError ? "对话读取失败，请刷新重试" : !$("project-select").value ? "请先选择项目" : !state.threads.length ? "该项目暂无已有对话" : !matchedCount && query.trim() ? "没有匹配的对话" : "请选择已有对话");
    placeholder.value = "";
    select.append(placeholder);
    for (const { thread, label } of available) {
      const option = element("option", "", label);
      option.value = thread.id;
      select.append(option);
    }
    if (available.some(({ thread }) => thread.id === previous)) select.value = previous;
    else if (available.some(({ thread }) => thread.id === state.selectedThreadId)) select.value = state.selectedThreadId;
    if (!state.loadingThreads && !state.threadError) state.selectedThreadId = select.value;
    select.title = select.selectedOptions[0]?.textContent || "";
    select.disabled = state.loadingThreads || !available.length;
    if (state.loadingThreads) $("thread-help").textContent = "正在读取所选项目的已有对话。";
    else if (!$("project-select").value) $("thread-help").textContent = "选择项目后，即可查找已有对话。";
    else if (state.threadError) $("thread-help").textContent = "读取失败，请点击“刷新对话”重试。";
    else if (!state.threads.length) $("thread-help").textContent = "先在这个项目中创建对话，再点击“刷新对话”。";
    else $("thread-help").textContent = (query.trim() ? "匹配 " + matchedCount + " / " : "共 ") + state.threads.length + " 个对话 · 北京时间 · # 为编号" + (query.trim() && available.length > matchedCount ? "；已保留当前选择。" : "。");
    renderThreadDetails();
  }
  function renderThreadDetails() {
    const thread = state.threads.find((item) => item.id === $("thread-select").value);
    const details = $("thread-details");
    details.hidden = !thread;
    if (!thread) { details.replaceChildren(); setComposerMode(); return; }
    const updated = ui.threadTime(thread.updatedAt);
    const created = ui.threadTime(thread.createdAt);
    const times = [updated ? "更新 " + updated : "", created ? "创建 " + created : ""].filter(Boolean);
    const expanded = details.dataset.threadId === thread.id && details.querySelector(".thread-meta")?.open;
    details.dataset.threadId = thread.id;
    const identity = element("p", "thread-identity");
    identity.append(element("span", "", "对话编号 "), element("code", "", thread.id));
    const provider = ui.threadProviderStatus(thread);
    const top = element("div", "thread-topline");
    const title = element("p", "thread-selected-title", thread.title || "未命名对话");
    title.title = title.textContent;
    top.append(title);
    if (provider.label || provider.compatible !== null) {
      const pill = element("span", "provider-pill " + (provider.compatible === false ? "incompatible" : provider.compatible === true ? "compatible" : ""), provider.compatible === true ? "OpenAI 订阅" : provider.label || "待确认");
      pill.title = "实际服务商：" + (provider.label || "待确认") + (provider.compatible === false ? " · 暂不能发送" : "");
      top.append(pill);
    }
    const shortId = ui.shortThreadIds(state.threads).get(thread.id) || thread.id;
    details.replaceChildren(top, element("p", "thread-times", "#" + shortId + (updated ? " · 更新 " + updated : " · 时间待确认")));
    if (provider.issue) details.append(element("p", "thread-provider-issue", provider.issue));
    const metadata = element("details", "thread-meta");
    metadata.open = !!expanded;
    metadata.append(element("summary", "", "查看对话信息"), identity, element("p", "thread-times", times.length ? times.join(" · ") + "（北京时间）" : "创建和更新时间暂不可用"));
    metadata.append(element("p", "thread-provider", "实际服务商：" + (provider.label || "待确认")));
    if (typeof thread.preview === "string" && thread.preview.trim()) metadata.append(element("p", "thread-preview", "内容预览：" + thread.preview.trim().slice(0, 300)));
    details.append(metadata);
    setComposerMode();
  }
  function renderWorker() {
    const node = $("worker-status");
    let label = "调度正常";
    let className = "ready";
    if (!state.connected) { label = "连接中断"; className = "offline"; }
    else if (state.worker?.status === "stopped" || state.worker?.status === "error") { label = "调度未运行"; className = "offline"; }
    else if (state.worker?.status === "stopping") { label = "调度正在停止"; className = "offline"; }
    else if (state.worker?.status === "attention") { label = "调度需要处理"; className = "offline"; }
    else if (state.worker?.status === "paused") { label = "调度已暂停"; className = ""; }
    node.className = "worker-status " + className;
    node.replaceChildren(element("span", "worker-dot"), element("span", "", label));
  }
  function renderQuota() {
    const quota = state.quota;
    const card = $("quota-label").closest(".quota-card");
    card.classList.remove("waiting", "unknown");
    if (!quota || quota.allowed === null || quota.allowed === undefined) {
      card.classList.add("unknown");
      $("quota-label").textContent = "状态待确认";
      $("quota-description").textContent = "执行时检查，额度不足会自动排队";
      return;
    }
    const windows = Array.isArray(quota.windows) ? quota.windows : [];
    const remaining = windows.filter((window) => window.usedPercent !== null && window.usedPercent !== undefined && Number.isFinite(Number(window.usedPercent))).map((window) => Math.max(0, 100 - Number(window.usedPercent)));
    if (quota.allowed === false) {
      card.classList.add("waiting");
      $("quota-label").textContent = "等待额度恢复";
      $("quota-description").textContent = quota.resetAt ? "预计额度恢复还需 " + ui.remainingTime(quota.resetAt) : "任务会保留，并自动重试";
    } else {
      $("quota-label").textContent = "额度可用";
      $("quota-description").textContent = remaining.length ? "当前限制窗口至少剩余 " + Math.round(Math.min(...remaining)) + "%" : "任务将按计划进入执行队列";
    }
    if (quota.reason) card.title = String(quota.reason);
    else card.removeAttribute("title");
  }
  function nextAttempt(task) { return task.nextAttemptAt || task.nextRunAt || task.retryAt || task.quotaResetAt; }
  function errorText(task) {
    const error = task.lastError || task.reason || task.error || task.result?.error;
    if (!error) return "";
    return friendlyMessage(typeof error === "string" ? error : error.message || JSON.stringify(error, null, 2), statusOf(task));
  }
  function resultText(task) {
    if (!task.result) return "";
    if (typeof task.result === "string") return task.result;
    const output = task.result.output ?? task.result.text ?? task.result.message;
    if (output === undefined || output === null) return "";
    return typeof output === "string" ? output : JSON.stringify(output, null, 2);
  }
  function modelName(id) { const model = state.models.find((item) => item.id === id); return model?.displayName || model?.name || id || "默认模型"; }
  function actionButton(task, action, title, className = "") {
    const pending = state.actionPending.has(task.id) && state.pendingActions.get(task.id) === action;
    const busyLabels = { pause: "暂停中…", resume: "恢复中…", cancel: "取消中…", retry: "重试中…", edit: "载入中…", copy: "复制中…", delete: "删除中…" };
    const button = element("button", "task-action " + className + (pending ? " is-loading" : ""), pending ? busyLabels[action] || "处理中…" : title);
    button.type = "button";
    button.dataset.taskId = task.id;
    button.dataset.action = action;
    const deleteBlocked = action === "delete" ? ui.taskDeleteBlockReason(task) : "";
    button.disabled = state.actionPending.has(task.id) || !state.connected || !!deleteBlocked || (["copy", "edit", "delete"].includes(action) && (state.submitting || state.loadingDraft || state.checkingSetup));
    button.setAttribute("aria-busy", String(pending));
    button.setAttribute("aria-label", (pending ? busyLabels[action] || title : title) + "：" + (task.title || task.prompt || "定时任务").split("\n")[0].slice(0, 80));
    if (!state.connected) button.title = "连接恢复后可操作，任务记录已保留。";
    else if (deleteBlocked) button.title = deleteBlocked;
    button.addEventListener("click", () => actOnTask(task, action));
    return button;
  }
  function renderTask(task, open, targetIds) {
    const status = statusOf(task);
    const reason = errorText(task);
    const awaitingDesktopStart = status === "running" && task.submissionReceipt?.transport === "codex-desktop" && !task.turnId;
    const card = element("article", "task-card status-" + status);
    card.dataset.taskId = task.id;
    const top = element("div", "task-top");
    const title = task.title || String(task.prompt || "定时任务").trim().split(/\n/)[0];
    const heading = element("h3", "task-title", title || "定时任务");
    heading.title = title || "定时任务";
    top.append(heading, element("span", "status-chip " + status, awaitingDesktopStart ? "已提交，等待开始" : task.deliveryState === "not_sent" ? "未发送" : labels[status] || "待处理"));
    const destination = element("div", "task-destination");
    const targetId = targetIds.get(task.threadId);
    destination.append(icon("chat"), element("span", "", task.projectLabel || task.projectName || task.projectPath?.split(/[\\/]/).filter(Boolean).pop() || "所选项目"), element("span", "destination-divider", "/"), element("span", "", task.threadTitle || "所选对话"));
    if (targetId) destination.append(element("span", "destination-id", "#" + targetId));
    destination.title = (task.projectLabel || task.projectPath || "") + " / " + (task.threadTitle || "") + (task.threadId ? " · " + task.threadId : "");
    const meta = element("div", "task-meta");
    const time = element("span", "task-time");
    const zone = task.timeZone || state.timeZone;
    const quotaTrigger = ui.taskSendMode(task) === "quota_available";
    time.append(icon("clock"), element("span", "", quotaTrigger ? ui.taskTriggerText(task) : formatDate(task.runAt || task.scheduledAt, zone)));
    time.title = quotaTrigger ? "每 30 秒检测所选模型额度；额度可用时发送一次" : formatDate(task.runAt || task.scheduledAt, zone, true) + " · " + zone;
    meta.append(time, element("span", "task-model", modelName(task.model) + (task.effort ? " · " + ({ none: "无", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "超高" }[task.effort] || task.effort) : "")));
    card.append(top, destination, meta);
    const countdown = element("p", "task-countdown", ui.taskCountdown(task));
    countdown.dataset.countdownTask = task.id;
    countdown.hidden = !countdown.textContent;
    card.append(countdown);
    if (waiting.has(status)) card.append(element("p", "task-wait-note", (reason || "正在等待额度恢复，任务会保留并自动继续。") + (nextAttempt(task) ? " 下次检查：" + formatDate(nextAttempt(task), zone) + "。" : "")));
    else if (status === "waiting_thread") card.append(element("p", "task-wait-note", reason || "目标对话暂不可用，任务已保留，稍后会再次检查。"));
    else if (status === "needs_review") card.append(element("p", "task-error-note", reason || "上次发送结果未能确认，请先核对目标对话，再决定是否重试。"));
    else if (status === "failed" && reason) card.append(element("p", "task-error-note", reason));
    const bottom = element("div", "task-bottom");
    const details = element("details", "task-details");
    details.dataset.taskId = task.id;
    details.open = open;
    details.append(element("summary", "", "查看内容与结果"));
    const content = element("div", "task-details-content");
    content.append(element("p", "detail-label", "发送内容"), element("pre", "", task.prompt || ""));
    const result = resultText(task);
    if (result) content.append(element("p", "detail-label", "执行结果"), element("pre", "", result));
    if (reason) content.append(element("p", "detail-label", "最近提示"), element("pre", "", reason));
    content.append(element("p", "detail-label", "任务信息"), element("pre", "", (quotaTrigger ? "发送方式：" + ui.taskTriggerText(task) + "\n每 30 秒检测，额度可用后发送一次。" : "计划时间：" + formatDate(task.runAt || task.scheduledAt, zone, true) + " · " + zone) + (task.threadId ? "\n目标对话编号：" + task.threadId : "") + (task.completedAt ? "\n完成时间：" + formatDate(task.completedAt, zone, true) : "") + (task.attempts ? "\n已尝试：" + task.attempts + " 次" : "")));
    details.append(content);
    const actions = element("div", "task-actions");
    if (ui.canEditTask(task)) actions.append(actionButton(task, "edit", "编辑"));
    actions.append(actionButton(task, "copy", "复制"));
    if (status === "paused") actions.append(actionButton(task, "resume", "继续"));
    else if (status === "failed") actions.append(actionButton(task, "retry", "重试"));
    else if (status === "needs_review") actions.append(actionButton(task, "retry", "核对后重试"));
    else if (!terminal.has(status) && status !== "running") actions.append(actionButton(task, "pause", "暂停"));
    if (!terminal.has(status) && status !== "running") actions.append(actionButton(task, "cancel", "取消", "cancel"));
    if (status === "running") actions.append(element("span", "task-progress-note", awaitingDesktopStart ? "已交给 Codex，等待开始" : "请在对话中查看进度"));
    actions.append(actionButton(task, "delete", "删除", "delete"));
    bottom.append(details, actions);
    card.append(bottom);
    return card;
  }
  function tickCountdowns() {
    const tasks = new Map(state.tasks.map((task) => [task.id, task]));
    for (const node of document.querySelectorAll("[data-countdown-task]")) {
      node.textContent = ui.taskCountdown(tasks.get(node.dataset.countdownTask) || {});
      node.hidden = !node.textContent;
    }
    if (state.quota?.allowed === false && state.quota.resetAt) renderQuota();
  }
  function receiveTasks(tasks) {
    // An older poll may finish after DELETE. Never restore a record removed in
    // this session merely because that stale snapshot arrived later.
    tasks = tasks.filter((task) => !state.deletedTaskIds.has(task.id));
    if (state.loadedTasks) {
      const previous = new Map(state.tasks.map((task) => [task.id, task]));
      const notices = tasks.map((task) => ({ task, notice: ui.taskNotice(previous.get(task.id), task) })).filter((item) => item.notice);
      const latest = notices.at(-1);
      if (latest) {
        state.noticeTaskId = latest.task.id;
        $("task-notice").className = "alert task-notice " + latest.notice.kind;
        $("task-notice-text").textContent = latest.notice.message + "：" + (latest.task.title || latest.task.prompt || "定时任务").split("\n")[0].slice(0, 80) + (notices.length > 1 ? "（本次共 " + notices.length + " 项更新）" : "");
        $("task-notice").hidden = false;
      }
    }
    state.tasks = tasks;
    state.loadedTasks = true;
    const editing = tasks.find((task) => task.id === state.editingId);
    if (state.editingId && !editing) retainDraftAfterDeletion(state.editingId);
    else if (state.editingId && !ui.canEditTask(editing)) {
      $("submit-button").disabled = true;
      $("form-error").textContent = "这个任务已开始处理，无法再修改。你输入的内容仍在表单中，可点击“保留为新草稿”。";
      $("form-error").hidden = false;
      $("cancel-edit").textContent = "保留为新草稿";
    }
  }
  function renderTasks(force = false) {
    const active = state.tasks.filter((task) => !terminal.has(statusOf(task)));
    $("pending-count").textContent = active.length;
    $("completed-count").textContent = state.tasks.filter((task) => completed.has(statusOf(task))).length;
    $("nav-count").textContent = active.length;
    $("queue-jump-count").textContent = active.length;
    $("task-total").textContent = state.tasks.length;
    $("active-filter-count").textContent = active.length;
    const tasks = state.tasks.filter((task) => state.filter === "all" || (state.filter === "completed" ? completed.has(statusOf(task)) : !terminal.has(statusOf(task))));
    tasks.sort((a, b) => {
      if (state.filter === "completed" || state.filter === "all") return (validDate(b.updatedAt || b.createdAt || b.runAt)?.getTime() || 0) - (validDate(a.updatedAt || a.createdAt || a.runAt)?.getTime() || 0);
      const priority = { needs_review: 0, running: 1, failed: 2, waiting_quota: 3, waiting_thread: 4, scheduled: 5, queued: 5, paused: 6 };
      return (priority[statusOf(a)] ?? 5) - (priority[statusOf(b)] ?? 5) || (validDate(a.runAt)?.getTime() || 0) - (validDate(b.runAt)?.getTime() || 0);
    });
    $("tasks-loading").hidden = true;
    $("tasks-empty").hidden = tasks.length > 0;
    $("task-list").tabIndex = tasks.length ? 0 : -1;
    if (!tasks.length) {
      $("empty-title").textContent = state.filter === "completed" ? "完成的任务会出现在这里" : state.filter === "all" ? "还没有定时任务" : state.tasks.length ? "当前没有未完成的任务" : "把下一步提前安排好";
      $("empty-description").textContent = state.filter === "completed" ? "每一项完成的任务，都能在这里回看结果。" : state.tasks.length ? "你可以安排下一项任务，或切换到全部查看记录。" : "创建第一个定时任务，\n到时间，时序会帮你继续对话。";
      $("empty-description").style.whiteSpace = "pre-line";
    }
    const signature = JSON.stringify([state.filter, tasks, state.connected, state.submitting, state.loadingDraft, state.checkingSetup, Array.from(state.actionPending), Array.from(state.pendingActions)]);
    if (!force && signature === state.taskSignature) return;
    state.taskSignature = signature;
    const open = new Set(Array.from(document.querySelectorAll(".task-details[open]"), (node) => node.dataset.taskId));
    const listScroll = state.renderedFilter === state.filter ? $("task-list").scrollTop : 0;
    const detailScrolls = new Map(Array.from(document.querySelectorAll(".task-details[open]"), (node) => [node.dataset.taskId, Array.from(node.querySelectorAll("pre"), (pre) => ({ top: pre.scrollTop, left: pre.scrollLeft }))]));
    const activeElement = document.activeElement;
    const focused = activeElement?.dataset;
    const focusTarget = focused?.action && focused?.taskId ? { action: focused.action, id: focused.taskId }
      : activeElement?.tagName === "SUMMARY" && activeElement.closest(".task-details") ? { summary: true, id: activeElement.closest(".task-details").dataset.taskId } : null;
    const targetIds = ui.shortThreadIds(state.tasks.map((task) => ({ id: task.threadId })));
    $("task-list").replaceChildren(...tasks.map((task) => renderTask(task, open.has(task.id), targetIds)));
    $("task-list").scrollTop = listScroll;
    state.renderedFilter = state.filter;
    for (const node of document.querySelectorAll(".task-details[open]")) {
      const positions = detailScrolls.get(node.dataset.taskId) || [];
      Array.from(node.querySelectorAll("pre")).forEach((pre, index) => { if (positions[index]) { pre.scrollTop = positions[index].top; pre.scrollLeft = positions[index].left; } });
    }
    if (focusTarget?.summary) Array.from(document.querySelectorAll(".task-details")).find((node) => node.dataset.taskId === focusTarget.id)?.querySelector("summary")?.focus({ preventScroll: true });
    else if (focusTarget) {
      const replacement = Array.from(document.querySelectorAll(".task-action")).find((button) => button.dataset.action === focusTarget.action && button.dataset.taskId === focusTarget.id);
      const fallback = Array.from(document.querySelectorAll(".task-details")).find((node) => node.dataset.taskId === focusTarget.id)?.querySelector("summary") || $("task-filters").querySelector(".active");
      (replacement && !replacement.disabled ? replacement : fallback)?.focus({ preventScroll: true });
    }
  }
  function snapshotForm() {
    return { projectPath: $("project-select").value, threadId: $("thread-select").value, model: $("model-select").value, effort: $("effort-select").value, timeZone: $("timezone-select").value, sendMode: $("quota-trigger").checked ? "quota_available" : "scheduled", runAtInput: $("run-at").value, prompt: $("prompt-input").value };
  }
  function setComposerMode() {
    const editing = !!state.editingId;
    const deletingEditedTask = editing && state.pendingActions.get(state.editingId) === "delete";
    $("compose-title").textContent = editing ? "编辑定时任务" : "安排一个任务";
    $("compose-kicker").textContent = editing ? "修改任务" : "新建任务";
    $("submit-button").querySelector("span").textContent = state.submitting ? editing ? "正在保存…" : "正在创建…" : state.loadingDraft ? "正在载入…" : editing ? "保存修改" : $("quota-trigger").checked ? "创建额度任务" : "创建定时任务";
    $("submit-button").classList.toggle("is-loading", state.submitting || state.loadingDraft);
    $("submit-button").setAttribute("aria-busy", String(state.submitting || state.loadingDraft));
    $("schedule-form").setAttribute("aria-busy", String(state.submitting || state.loadingDraft));
    $("cancel-edit").hidden = !editing;
    $("cancel-edit").disabled = state.submitting || state.loadingDraft || deletingEditedTask;
    $("cancel-edit").textContent = "取消编辑";
    const editingLocked = editing && !ui.canEditTask(state.tasks.find((task) => task.id === state.editingId) || {});
    const blocked = ui.submissionBlockReason({ connected: state.connected, diagnostics: state.diagnostics, thread: state.threads.find((thread) => thread.id === $("thread-select").value) });
    $("submit-button").disabled = state.submitting || state.loadingDraft || state.loadingThreads || state.checkingSetup || state.bootstrapping || deletingEditedTask || editingLocked || !!blocked;
    $("submission-help").hidden = !blocked;
    const providerBlocked = state.threads.find((thread) => thread.id === $("thread-select").value)?.providerCompatible === false;
    $("submission-help").textContent = providerBlocked ? "所选对话暂不能发送，请在上方选择 OpenAI 对话。" : blocked;
    if (editingLocked) $("cancel-edit").textContent = "保留为新草稿";
    $("refresh-button").disabled = state.submitting || state.loadingDraft || state.checkingSetup || state.polling || state.bootstrapping;
    $("diagnostics-button").disabled = state.submitting || state.loadingDraft || state.checkingSetup || state.reconnecting;
    renderServices();
    if (state.loadedTasks) renderTasks();
  }
  function selectTimeZone(timeZone) {
    try { new Intl.DateTimeFormat("zh-CN", { timeZone }); }
    catch (_) { return false; }
    if (!Array.from($("timezone-select").options).some((option) => option.value === timeZone)) {
      const option = element("option", "", timeZone); option.value = timeZone; $("timezone-select").append(option);
    }
    $("timezone-select").value = timeZone;
    state.timeZone = timeZone;
    return true;
  }
  async function fillComposer(fields) {
    $("thread-search").value = "";
    $("project-select").value = state.projects.some((project) => project.path === fields.projectPath) ? fields.projectPath : "";
    $("model-select").value = state.models.some((model) => model.id === fields.model) ? fields.model : "";
    populateEfforts();
    if (Array.from($("effort-select").options).some((option) => option.value === fields.effort)) $("effort-select").value = fields.effort;
    selectTimeZone(fields.timeZone || state.timeZone);
    $("quota-trigger").checked = ui.taskSendMode(fields) === "quota_available";
    $("run-at").value = fields.runAtInput || asInput(new Date(Date.now() + 3600000), $("timezone-select").value);
    $("prompt-input").value = fields.prompt || "";
    updatePromptCount(); updateSendMode();
    await loadThreads(fields.threadId || "");
    const missing = [];
    if (!$("project-select").value) missing.push("原项目当前不可用，请重新选择项目");
    else if (!$("thread-select").value) missing.push("原对话已归档或当前不可用，请选择其他已有对话");
    if (!$("model-select").value) missing.push("原模型当前不可用，请重新选择模型");
    return missing;
  }
  async function draftTask(task, editing) {
    if (state.loadingDraft || state.submitting || editing && !ui.canEditTask(task)) return;
    state.loadingDraft = true;
    state.actionPending.add(task.id);
    renderTasks();
    if (editing && !state.editingId) state.draftSnapshot = snapshotForm();
    if (!editing) state.draftSnapshot = null;
    state.editingId = editing ? task.id : null;
    state.pendingCreation = null;
    $("schedule-fields").disabled = true;
    $("form-error").hidden = true;
    try {
      const zone = task.timeZone || state.timeZone;
      const past = ui.taskSendMode(task) === "scheduled" && (!validDate(task.runAt) || validDate(task.runAt).getTime() <= Date.now());
      const runAtInput = editing && !past && validDate(task.runAt) ? asInput(validDate(task.runAt), zone) : asInput(new Date(Date.now() + (editing ? 5 : 60) * 60000), zone);
      const missing = await fillComposer({ ...task, runAtInput });
      $("draft-note").textContent = (editing ? "保存后更新这一项任务" + (task.status === "paused" ? "，并保持暂停。" : "。") + (past ? "原时间已过，已暂设为 5 分钟后，请检查发送时间。" : "") : "已复制为新草稿。检查发送方式和内容后，点击创建按钮才会加入队列。") + (missing.length ? " " + missing.join("；") + "。" : "");
      $("draft-note").hidden = false;
      if (missing.length) { $("form-error").textContent = missing.join("；") + "。"; $("form-error").hidden = false; }
    } finally {
      state.loadingDraft = false;
      state.actionPending.delete(task.id);
      $("schedule-fields").disabled = false;
      setComposerMode(); renderTasks(true);
      $("compose-title").scrollIntoView({ behavior: "smooth", block: "start" });
      $("prompt-input").focus({ preventScroll: true });
    }
  }
  async function cancelEdit() {
    if (!state.editingId || state.submitting || state.loadingDraft || state.pendingActions.get(state.editingId) === "delete") return;
    const current = state.tasks.find((task) => task.id === state.editingId);
    const snapshot = state.draftSnapshot;
    const keepDraft = !current || !ui.canEditTask(current);
    state.editingId = null; state.draftSnapshot = null;
    state.pendingCreation = null;
    $("form-error").hidden = true;
    if (keepDraft) {
      $("draft-note").textContent = "内容已保留为新草稿。检查发送方式后，点击创建按钮才会创建另一项任务。";
      $("draft-note").hidden = false;
    } else {
      state.loadingDraft = true;
      $("schedule-fields").disabled = true;
      try { if (snapshot) await fillComposer(snapshot); }
      finally { state.loadingDraft = false; $("schedule-fields").disabled = false; }
      $("draft-note").hidden = true;
    }
    setComposerMode();
  }
  function taskActionFocus(taskId, action) {
    const buttons = Array.from(document.querySelectorAll(".task-action"));
    return buttons.find((button) => button.dataset.taskId === taskId && button.dataset.action === action && !button.disabled)
      || Array.from(document.querySelectorAll(".task-details")).find((node) => node.dataset.taskId === taskId)?.querySelector("summary")
      || $("task-filters").querySelector(".active");
  }
  function confirmTaskAction(dialogId, acceptedValue, fallback) {
    const dialog = $(dialogId);
    if (!dialog || typeof dialog.showModal !== "function") return Promise.resolve(window.confirm(fallback));
    if (document.querySelector(".confirm-dialog[open]")) return Promise.resolve(false);
    const origin = document.activeElement?.dataset;
    const originId = origin?.taskId;
    const originAction = origin?.action;
    return new Promise((resolve) => {
      dialog.returnValue = "cancel";
      dialog.addEventListener("close", () => {
        if (originId) taskActionFocus(originId, originAction)?.focus({ preventScroll: true });
        resolve(dialog.returnValue === acceptedValue);
      }, { once: true });
      dialog.showModal();
    });
  }
  function confirmRetry() {
    return confirmTaskAction("retry-dialog", "retry", "上次发送结果未能确认，重试可能发送重复消息。请先核对目标对话，确认仍需再次发送吗？");
  }
  function confirmDeletion(task) {
    const copy = ui.taskDeleteConfirmation(task);
    $("delete-dialog-title").textContent = copy.title;
    $("delete-dialog-description").textContent = copy.description;
    $("delete-dialog-note").textContent = copy.note;
    $("delete-dialog-target").textContent = (task.title || task.prompt || "定时任务").trim().split("\n")[0].slice(0, 180);
    return confirmTaskAction("delete-dialog", "delete", copy.title + "\n\n" + copy.description + "\n\n" + copy.note);
  }
  function retainDraftAfterDeletion(taskId) {
    if (state.editingId !== taskId) return;
    state.editingId = null;
    state.draftSnapshot = null;
    state.pendingCreation = null;
    $("form-error").hidden = true;
    $("draft-note").textContent = "原任务已删除。表单内容已保留为新草稿，只有再次点击创建按钮才会加入队列。";
    $("draft-note").hidden = false;
  }
  async function deleteTask(task) {
    if (state.submitting || state.loadingDraft || state.checkingSetup) return;
    let current = state.tasks.find((item) => item.id === task.id);
    if (!current) return;
    const blocked = ui.taskDeleteBlockReason(current);
    if (blocked) { toast(blocked, true); return; }
    if (!await confirmDeletion(current)) return;
    current = state.tasks.find((item) => item.id === task.id);
    if (!current) { toast("这项任务已经从列表移除。"); return; }
    const changed = ui.taskDeleteBlockReason(current);
    if (changed) { toast(changed, true); return; }
    if (state.actionPending.has(task.id) || state.submitting || state.loadingDraft || state.checkingSetup || !state.connected) return;
    const visibleCards = Array.from($("task-list").children);
    const previousIndex = visibleCards.findIndex((card) => card.dataset.taskId === task.id);
    state.actionPending.add(task.id);
    state.pendingActions.set(task.id, "delete");
    setComposerMode();
    try {
      await api("/api/tasks/" + encodeURIComponent(task.id), { method: "DELETE" });
      state.deletedTaskIds.add(task.id);
      retainDraftAfterDeletion(task.id);
      state.tasks = state.tasks.filter((item) => item.id !== task.id);
      if (state.noticeTaskId === task.id) { state.noticeTaskId = null; $("task-notice").hidden = true; }
      showAlert("", "warning", "general");
      renderTasks(true);
      setComposerMode();
      const focused = document.activeElement;
      if (focused === document.body || focused === $("task-list") || focused?.closest(".task-card")?.dataset.taskId === task.id) {
        const cards = Array.from($("task-list").children);
        const next = cards[Math.min(Math.max(previousIndex, 0), cards.length - 1)];
        (next ? taskActionFocus(next.dataset.taskId, "delete") : $("task-filters").querySelector(".active"))?.focus({ preventScroll: true });
      }
      toast("任务已删除；Codex 对话和已发出的消息会保留。");
      await poll(true);
    } catch (error) {
      showAlert(error.code === "task_busy" ? "任务已经开始运行或派发，暂不能删除。记录已保留，请等待执行结束后再操作。"
        : error.code === "deletion_persist_failed" ? "删除未能保存，任务记录已保留，调度已暂停。请再次点击删除以重试。"
          : "删除未能确认：" + readableError(error), "error", "general");
      await poll(true);
    } finally {
      state.actionPending.delete(task.id);
      state.pendingActions.delete(task.id);
      renderTasks();
      setComposerMode();
    }
  }
  async function actOnTask(task, action) {
    if (state.actionPending.has(task.id)) return;
    if (!state.connected) { toast("连接恢复后可操作，任务记录已保留。", true); return; }
    if (action === "delete") return deleteTask(task);
    if (action === "edit" || action === "copy") {
      state.pendingActions.set(task.id, action);
      try { return await draftTask(task, action === "edit"); }
      finally { state.pendingActions.delete(task.id); renderTasks(); }
    }
    const payload = { action };
    if (statusOf(task) === "needs_review" && action === "retry") {
      if (!await confirmRetry()) return;
      payload.acknowledgeDuplicateRisk = true;
    }
    state.actionPending.add(task.id);
    state.pendingActions.set(task.id, action);
    renderTasks();
    try {
      await api("/api/tasks/" + encodeURIComponent(task.id) + "/action", { method: "POST", body: JSON.stringify(payload) });
      showAlert("", "warning", "general");
      toast({ pause: "任务已暂停", resume: "任务已恢复，等待执行", cancel: "任务已取消", retry: "任务已重新加入队列" }[action] || "任务已更新");
      await poll(true);
    } catch (error) { showAlert(readableError(error), "error", "general"); }
    finally { state.actionPending.delete(task.id); state.pendingActions.delete(task.id); renderTasks(); }
  }
  async function poll(manual = false) {
    if (state.polling) return;
    state.polling = true;
    if (manual) { $("refresh-button").disabled = true; $("refresh-button").classList.add("is-loading"); $("refresh-button").setAttribute("aria-busy", "true"); }
    try {
      const data = await api("/api/tasks");
      receiveTasks(data.tasks || []);
      if (data.worker) state.worker = data.worker;
      if (data.quota !== undefined) state.quota = data.quota;
      connection(true);
      showAlert("", "warning", "connection");
      updateDesktop(data.desktop);
      updateDiagnostics(data.diagnostics);
      renderQuota(); renderTasks();
      $("last-updated").textContent = "更新于 " + new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    } catch (error) { connection(false); showAlert(readableError(error), "error", "connection"); }
    finally { state.polling = false; $("refresh-button").classList.remove("is-loading"); $("refresh-button").setAttribute("aria-busy", "false"); setComposerMode(); }
  }
  async function submit(event) {
    event.preventDefault();
    if (state.submitting) return;
    $("form-error").hidden = true;
    let payload;
    const editingId = state.editingId;
    try {
      if (state.loadingDraft) return;
      if (editingId && state.pendingActions.get(editingId) === "delete") throw new Error("原任务正在删除，请稍候；表单内容会保留为新草稿。");
      if (state.checkingSetup || state.loadingThreads) throw new Error("正在检查配置或读取对话，请稍候。");
      const blocked = ui.submissionBlockReason({ connected: state.connected, diagnostics: state.diagnostics, thread: state.threads.find((thread) => thread.id === $("thread-select").value) });
      if (blocked) throw new Error(blocked);
      if (editingId && !ui.canEditTask(state.tasks.find((task) => task.id === editingId) || {})) throw new Error("这个任务已经开始处理，不能再修改。请保留为新草稿或查看原任务。" );
      const projectPath = $("project-select").value;
      const threadId = $("thread-select").value;
      const model = $("model-select").value;
      const prompt = $("prompt-input").value.trim();
      const timeZone = $("timezone-select").value;
      const sendMode = $("quota-trigger").checked ? "quota_available" : "scheduled";
      if (!projectPath) { $("project-select").focus(); throw new Error("请先选择一个项目。"); }
      if (!threadId) { $("thread-select").focus(); throw new Error("请选择要继续的已有对话。"); }
      if (!model) { $("model-select").focus(); throw new Error("请选择执行任务使用的模型。"); }
      let runAt;
      if (sendMode === "scheduled") {
        if (!$("run-at").value) { $("run-at").focus(); throw new Error("请选择发送时间。"); }
        runAt = zonedTimeToISO($("run-at").value, timeZone);
        if (new Date(runAt).getTime() <= Date.now()) { $("run-at").focus(); throw new Error("发送时间已过去，请选择未来的时间。"); }
      }
      if (!prompt) { $("prompt-input").focus(); throw new Error("请填写要发送的内容。"); }
      const project = state.projects.find((item) => item.path === projectPath);
      const thread = state.threads.find((item) => item.id === threadId);
      payload = { projectPath, threadId, model, effort: $("effort-select").value || null, prompt, sendMode, ...(runAt ? { runAt } : {}), timeZone };
      if (!editingId) {
        payload.projectLabel = project?.label || project?.name || projectPath;
        payload.threadTitle = thread?.title || "未命名对话";
        const fingerprint = JSON.stringify(payload);
        if (state.pendingCreation?.fingerprint !== fingerprint) state.pendingCreation = { fingerprint, id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) };
        payload.clientRequestId = state.pendingCreation.id;
      }
    } catch (error) {
      $("form-error").textContent = error.message; $("form-error").hidden = false;
      const field = document.activeElement;
      if (field?.matches("input, select, textarea") && $("schedule-form").contains(field)) { field.setAttribute("aria-invalid", "true"); field.setAttribute("aria-errormessage", "form-error"); }
      return;
    }
    state.submitting = true;
    $("submit-button").disabled = true;
    $("schedule-fields").disabled = true;
    setComposerMode();
    try {
      const response = await api(editingId ? "/api/tasks/" + encodeURIComponent(editingId) : "/api/tasks", { method: editingId ? "PATCH" : "POST", body: JSON.stringify(payload) });
      state.pendingCreation = null;
      const task = response.task || response;
      if (task?.id) {
        const index = state.tasks.findIndex((item) => item.id === task.id);
        if (index >= 0) state.tasks[index] = task; else state.tasks.push(task);
      }
      setFilter("active");
      renderTasks(true);
      state.editingId = null; state.draftSnapshot = null;
      $("draft-note").hidden = true;
      $("prompt-input").value = ""; updatePromptCount();
      rememberPreferences();
      $("quota-trigger").checked = false; updateSendMode();
      toast(editingId ? "修改已保存" + (task.status === "paused" ? "，任务仍处于暂停状态" : "") : payload.sendMode === "quota_available" ? "任务已创建 · 额度可用时自动发送一次" : "任务已安排 · " + formatDate(payload.runAt, payload.timeZone) + " 发送");
      await poll(true);
    } catch (error) { $("form-error").textContent = readableError(error); $("form-error").hidden = false; }
    finally { state.submitting = false; $("schedule-fields").disabled = false; setComposerMode(); }
  }
  function setFilter(filter) {
    state.filter = filter;
    for (const button of $("task-filters").querySelectorAll("button")) {
      const selected = button.dataset.filter === filter;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    renderTasks();
  }
  function updatePromptCount() { $("prompt-count").textContent = Array.from($("prompt-input").value).length + " 字"; }
  async function bootstrap() {
    state.bootstrapping = true;
    $("refresh-button").disabled = true;
    $("refresh-button").classList.add("is-loading");
    $("refresh-button").setAttribute("aria-busy", "true");
    try {
      const data = await api("/api/bootstrap");
      state.projects = data.projects || [];
      state.models = data.models || [];
      receiveTasks(data.tasks || []);
      state.worker = data.worker;
      state.quota = data.quota;
      state.preferences = ui.pickPreferences(data.preferences && Object.keys(data.preferences).length ? data.preferences : readPreferences());
      selectTimeZone(state.preferences.timeZone || data.timeZone || "Asia/Shanghai") || selectTimeZone("Asia/Shanghai");
      connection(true);
      showAlert("", "warning", "connection");
      updateDesktop(data.desktop);
      updateDiagnostics(data.diagnostics === undefined ? null : data.diagnostics);
      populateProjects(data); populateModels();
      $("schedule-fields").disabled = false;
      setDefaultTime(); updateSendMode(); renderQuota(); renderTasks();
      showAlert(!state.projects.length ? "还没有可用项目。请先在 Codex 中添加项目，然后刷新。" : !state.models.length ? "暂时没有可用模型，请稍后刷新。" : "", "warning");
      await loadThreads(state.preferences.projectPath === $("project-select").value ? state.preferences.threadId || "" : "");
    } catch (error) {
      connection(false); showAlert(readableError(error), "error", "connection");
      updateDiagnostics({ ready: false, summary: "暂时无法连接任务后台，请重新打开管理器或重新检测。", checks: [] });
      $("tasks-loading").hidden = true;
      $("tasks-empty").hidden = false;
      $("empty-title").textContent = "暂时无法读取任务";
      $("empty-description").textContent = "请检查连接后点击页面右上方的刷新。";
    } finally { state.bootstrapping = false; $("refresh-button").classList.remove("is-loading"); $("refresh-button").setAttribute("aria-busy", "false"); setComposerMode(); }
  }
  $("schedule-form").addEventListener("submit", submit);
  $("project-select").addEventListener("change", async () => { $("thread-search").value = ""; await loadThreads(""); rememberPreferences(); });
  $("thread-search").addEventListener("input", () => renderThreads());
  $("refresh-threads").addEventListener("click", () => loadThreads());
  $("thread-select").addEventListener("change", () => { state.selectedThreadId = $("thread-select").value; $("thread-select").title = $("thread-select").selectedOptions[0]?.textContent || ""; renderThreadDetails(); rememberPreferences(); });
  $("model-select").addEventListener("change", () => { populateEfforts(); renderThreadDetails(); rememberPreferences(); });
  $("effort-select").addEventListener("change", rememberPreferences);
  $("timezone-select").addEventListener("change", () => { state.timeZone = $("timezone-select").value; updateTimePreview(); rememberPreferences(); });
  $("run-at").addEventListener("change", () => { for (const button of document.querySelectorAll(".quick-times button")) button.setAttribute("aria-pressed", "false"); updateTimePreview(); });
  $("quota-trigger").addEventListener("change", updateSendMode);
  $("prompt-input").addEventListener("input", updatePromptCount);
  document.querySelector(".quick-times").addEventListener("click", (event) => { const button = event.target.closest("button[data-minutes]"); if (button) setQuickTime(Number(button.dataset.minutes)); });
  $("cancel-edit").addEventListener("click", cancelEdit);
  $("reconnect-button").addEventListener("click", reconnectDesktop);
  $("diagnostics-button").addEventListener("click", checkSetup);
  $("setup-nav-button").addEventListener("click", () => { $("setup-panel").open = true; $("setup-panel").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); $("setup-panel").querySelector("summary").focus({ preventScroll: true }); });
  for (const type of ["input", "change"]) $("schedule-form").addEventListener(type, (event) => { event.target.removeAttribute("aria-invalid"); event.target.removeAttribute("aria-errormessage"); $("form-error").hidden = true; });
  $("notice-dismiss").addEventListener("click", () => { $("task-notice").hidden = true; });
  $("notice-view").addEventListener("click", () => {
    setFilter("all");
    const card = Array.from(document.querySelectorAll(".task-card")).find((node) => node.dataset.taskId === state.noticeTaskId);
    if (card) { card.querySelector("details").open = true; card.scrollIntoView({ behavior: "smooth", block: "center" }); }
  });
  $("refresh-button").addEventListener("click", async () => {
    if (state.submitting || state.loadingDraft) return;
    if ($( "schedule-fields").disabled) return bootstrap();
    await poll(true);
  });
  $("task-filters").addEventListener("click", (event) => { const button = event.target.closest("button[data-filter]"); if (button) setFilter(button.dataset.filter); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("schedule-fields").disabled) poll(); });
  readToken();
  bootstrap();
  setInterval(() => { if (!document.hidden) tickCountdowns(); }, 1000);
  setInterval(() => { if (!document.hidden && !$("schedule-fields").disabled) poll(); }, 5000);
})();
