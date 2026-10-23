import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';

const STATUSES = new Set(['scheduled', 'waiting_quota', 'waiting_thread', 'running', 'completed', 'failed', 'paused', 'cancelled', 'needs_review']);
const PENDING = new Set(['scheduled', 'waiting_quota', 'waiting_thread']);
const BLOCKING = new Set([...PENDING, 'running', 'paused', 'needs_review']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const EDITABLE = new Set(['projectPath', 'executionPath', 'projectLabel', 'threadId', 'threadTitle', 'model', 'effort', 'prompt', 'runAt', 'timeZone', 'sendMode']);
const SEND_MODES = new Set(['scheduled', 'quota_available']);
const QUOTA_POLL_MS = 30_000;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const copy = value => structuredClone(value);
const errorText = error => String(error?.message ?? error ?? 'Unknown error');
const requestHash = value => createHash('sha256').update(value).digest('hex');
const queueError = (message, code, statusCode) => Object.assign(new Error(message), { code, statusCode });

function requiredString(value, name, max = 100_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string (maximum ${max} characters).`);
  return value.trim();
}

function timestamp(value, name = 'runAt') {
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO date and time with an explicit timezone offset (or Z).`);
  }
  // Date.parse normalizes impossible calendar dates, so explicitly reject those.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error(`${name} is not a valid calendar date.`);
  const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`${name} is not a valid clock time.`);
  return new Date(value).toISOString();
}

function validOptionalDate(value) {
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.getPrototypeOf(receipt) !== Object.prototype) throw new Error('submissionReceipt must be a plain JSON object.');
  if (receipt.transport !== 'codex-desktop') throw new Error('submissionReceipt has an unsupported transport.');
  timestamp(receipt.acknowledgedAt, 'submissionReceipt.acknowledgedAt');
  requiredString(receipt.sourceThreadId, 'submissionReceipt.sourceThreadId', 200);
  if (!Array.isArray(receipt.knownTurnIds) || receipt.knownTurnIds.length > 2_000) throw new Error('submissionReceipt.knownTurnIds must be an array of turn IDs.');
  for (const id of receipt.knownTurnIds) requiredString(id, 'submissionReceipt.knownTurnIds entry', 200);
  if (receipt.native != null && (typeof receipt.native !== 'object' || Array.isArray(receipt.native) || Object.getPrototypeOf(receipt.native) !== Object.prototype)) throw new Error('submissionReceipt.native must be a plain JSON object.');
  const json = JSON.stringify(receipt);
  if (json.length > 128_000) throw new Error('submissionReceipt is too large.');
  return JSON.parse(json);
}

function validateInput(input, { now = null } = {}) {
  const sendMode = input.sendMode === undefined ? 'scheduled' : input.sendMode;
  if (!SEND_MODES.has(sendMode)) throw new Error('sendMode must be scheduled or quota_available.');
  const projectPath = requiredString(input.projectPath, 'projectPath', 32_768);
  if (!path.isAbsolute(projectPath) && !path.win32.isAbsolute(projectPath)) throw new Error('projectPath must be an absolute directory path.');
  const executionPath = input.executionPath == null ? null : requiredString(input.executionPath, 'executionPath', 32_768);
  if (executionPath && !path.isAbsolute(executionPath) && !path.win32.isAbsolute(executionPath)) throw new Error('executionPath must be an absolute directory path.');
  const sourceThreadId = input.sourceThreadId == null ? null : requiredString(input.sourceThreadId, 'sourceThreadId', 36);
  if (sourceThreadId && !UUID.test(sourceThreadId)) throw new Error('sourceThreadId must be a UUID.');
  const timeZone = input.timeZone ?? 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new Error('timeZone must be a valid IANA timezone.'); }
  const effort = input.effort == null || input.effort === '' ? null : requiredString(input.effort, 'effort', 32);
  if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('effort is not supported.');
  requiredString(input.prompt, 'prompt');
  return {
    projectPath,
    executionPath,
    sourceThreadId,
    projectLabel: typeof input.projectLabel === 'string' ? input.projectLabel.trim().slice(0, 500) : path.basename(projectPath),
    threadId: requiredString(input.threadId, 'threadId', 200),
    threadTitle: typeof input.threadTitle === 'string' ? input.threadTitle.trim().slice(0, 1_000) : '',
    model: requiredString(input.model, 'model', 200),
    effort,
    prompt: input.prompt,
    sendMode,
    runAt: timestamp(sendMode === 'quota_available' && now != null ? now : input.runAt),
    timeZone,
  };
}

/** Persistent single-owner queue. Run one manager per store file. */
export class QueueManager {
  constructor({ storePath, adapter, clock = () => Date.now(), pollMs = 5_000, onChange = () => {}, maxConcurrent = 1 }) {
    if (!storePath || !adapter) throw new Error('storePath and adapter are required.');
    for (const method of ['getQuota', 'getThreadState', 'execute', 'reconcile']) {
      if (typeof adapter[method] !== 'function') throw new Error(`adapter.${method} is required.`);
    }
    this.storePath = storePath;
    this.adapter = adapter;
    this.clock = clock;
    this.pollMs = Math.max(100, Number(pollMs) || 5_000);
    this.onChange = onChange;
    this.maxConcurrent = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
    this.tasks = [];
    this.deletedRequestHashes = new Set();
    this._deleting = new Map();
    this._deletions = new Map();
    this._deleteStorageFaults = new Set();
    this.initialized = false;
    this._writeTail = Promise.resolve();
    this._tickPromise = null;
    this._processing = new Set();
    this._active = new Set();
    this._timer = null;
    this._stopping = false;
    this.lastTickError = null;
  }

  _now() { return new Date(this.clock()).toISOString(); }
  _assertInitialized() { if (!this.initialized) throw new Error('Call initialize() before using the queue.'); }
  _find(id) { const task = this.tasks.find(item => item.id === id); if (!task) throw new Error('Task not found.'); return task; }
  _assertMutable(task) {
    if (task.status === 'running' || this._processing.has(task.id) || this._active.has(task.id) || this._deleting.has(task.id)) throw new Error('This task is running or being dispatched; its submitted turn cannot be changed or cancelled.');
  }

  async initialize() {
    if (this.initialized) return this;
    let data;
    try { data = JSON.parse(await readFile(this.storePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot safely read queue store: ${errorText(error)}`); }
    if (data) {
      if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error('Unsupported or invalid queue store; it was not overwritten.');
      if (data.deletedRequestHashes !== undefined && (!Array.isArray(data.deletedRequestHashes) || data.deletedRequestHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) || new Set(data.deletedRequestHashes).size !== data.deletedRequestHashes.length)) throw new Error('Invalid deleted request markers; the queue store was not overwritten.');
      this.deletedRequestHashes = new Set(data.deletedRequestHashes || []);
      const ids = new Set();
      for (const task of data.tasks) {
        if (!task || typeof task.id !== 'string' || ids.has(task.id) || !STATUSES.has(task.status)) throw new Error('Invalid queue task; the queue store was not overwritten.');
        try {
          validateInput(task);
          if (task.clientRequestId != null && this.deletedRequestHashes.has(requestHash(requiredString(task.clientRequestId, 'clientRequestId', 200)))) throw new Error('A deleted request cannot retain a task.');
          timestamp(task.createdAt, 'createdAt');
          timestamp(task.updatedAt, 'updatedAt');
          if (task.nextAttemptAt != null) timestamp(task.nextAttemptAt, 'nextAttemptAt');
          if (task.quotaResetAt != null) timestamp(task.quotaResetAt, 'quotaResetAt');
          if (task.submissionReceipt != null) validateReceipt(task.submissionReceipt);
          if (task.lastRejectedSubmission != null) validateReceipt(task.lastRejectedSubmission);
          if (!Number.isInteger(task.attempts) || task.attempts < 0) throw new Error('Invalid attempt count.');
        } catch (error) { throw new Error(`Invalid queue task; the queue store was not overwritten: ${errorText(error)}`); }
        ids.add(task.id);
      }
      this.tasks = data.tasks;
    }
    this.initialized = true;
    // A persisted intent can mean the process died before receiving a turn ID.
    // Only a read-only reconciliation can establish whether anything was sent.
    for (const task of this.tasks.filter(item => item.status === 'running')) {
      this._processing.add(task.id);
      try { await this._reconcile(task); }
      finally { this._processing.delete(task.id); }
    }
    await this._persist();
    return this;
  }

  async _writeStore() {
    const document = { version: 1, tasks: this.tasks };
    if (this.deletedRequestHashes.size) document.deletedRequestHashes = [...this.deletedRequestHashes];
    const body = JSON.stringify(document, null, 2) + '\n';
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, this.storePath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
    }
  }

  async _persist({ prepare } = {}) {
    // Build snapshots only when this serialized write starts. In particular,
    // queued writes must observe a deletion rollback rather than a stale body.
    let rollbackSaved = false;
    const write = this._writeTail.catch(() => {}).then(async () => {
      let rollback;
      try {
        rollback = prepare?.();
        await this._writeStore();
      } catch (error) {
        if (rollback) {
          rollback();
          // A transient write failure must leave the restored record durable
          // before a later queued mutation writes another snapshot.
          await this._writeStore().then(() => { rollbackSaved = true; }, () => {});
        }
        throw error;
      }
    });
    this._writeTail = write;
    try { await write; }
    catch (error) {
      // The delete caller still receives its failure, but an already restored
      // durable store must not make a later orderly stop fail with that error.
      if (rollbackSaved && this._writeTail === write) this._writeTail = Promise.resolve();
      throw error;
    }
    try { this.onChange(this.list()); } catch { /* Observers cannot break persistence or dispatch. */ }
  }

  list() { this._assertInitialized(); return copy(this.tasks); }
  get(id) { this._assertInitialized(); return copy(this._find(id)); }

  async create(input) {
    this._assertInitialized();
    const clientRequestId = input.clientRequestId == null ? null : requiredString(input.clientRequestId, 'clientRequestId', 200);
    if (clientRequestId) {
      const assertNotDeleted = () => { if (this.deletedRequestHashes.has(requestHash(clientRequestId))) throw queueError('这个创建请求对应的任务已删除。请新建任务后再提交。', 'creation_deleted', 409); };
      assertNotDeleted();
      const existing = this.tasks.find(task => task.clientRequestId === clientRequestId);
      if (existing) { await this._writeTail; assertNotDeleted(); return copy(this._find(existing.id)); }
    }
    const now = this._now();
    const fields = validateInput(input, { now });
    const task = {
      id: randomUUID(), ...fields, clientRequestId,
      status: 'scheduled', createdAt: now, updatedAt: now,
      attempts: 0, nextAttemptAt: fields.runAt, lastError: null, result: null,
      turnId: null, submissionReceipt: null, lastRejectedSubmission: null, dispatchState: null, dispatchStartedAt: null, quotaRechecks: 0, quotaResetAt: null,
    };
    this.tasks.push(task);
    await this._persist();
    return copy(task);
  }

  async update(id, patch) {
    this._assertInitialized();
    const task = this._find(id);
    this._assertMutable(task);
    if (TERMINAL.has(task.status) || task.status === 'needs_review') throw new Error('Only pending or paused tasks can be edited.');
    if (task.submissionReceipt || task.turnId || ['intent', 'submitted'].includes(task.dispatchState)) throw new Error('这条消息已经提交，无法再编辑；请先核对目标对话。');
    for (const key of Object.keys(patch)) if (!EDITABLE.has(key)) throw new Error(`Task field ${key} cannot be edited.`);
    if (task.sendMode === 'quota_available' && patch.sendMode === 'scheduled' && !Object.hasOwn(patch, 'runAt')) throw new Error('runAt is required when changing to scheduled mode.');
    const now = this._now();
    Object.assign(task, validateInput({ ...task, ...patch }, { now }), { updatedAt: now, lastError: null, quotaRechecks: 0, quotaResetAt: null });
    task.nextAttemptAt = task.runAt;
    if (task.status !== 'paused') task.status = 'scheduled';
    await this._persist();
    return copy(task);
  }

  async pause(id) {
    this._assertInitialized();
    const task = this._find(id);
    this._assertMutable(task);
    if (!PENDING.has(task.status) && task.status !== 'paused') throw new Error('Only pending tasks can be paused.');
    task.status = 'paused';
    task.updatedAt = this._now();
    await this._persist();
    return copy(task);
  }

  async resume(id) {
    this._assertInitialized();
    const task = this._find(id);
    this._assertMutable(task);
    if (task.status !== 'paused') throw new Error('Only paused tasks can be resumed.');
    task.status = 'scheduled';
    task.nextAttemptAt = new Date(Math.max(Date.parse(task.runAt), this.clock())).toISOString();
    task.updatedAt = this._now();
    await this._persist();
    return copy(task);
  }

  async cancel(id) {
    this._assertInitialized();
    const task = this._find(id);
    this._assertMutable(task);
    if (task.status === 'completed') throw new Error('A completed task cannot be cancelled.');
    task.status = 'cancelled';
    task.updatedAt = this._now();
    task.nextAttemptAt = null;
    await this._persist();
    return copy(task);
  }

  async delete(id) {
    this._assertInitialized();
    requiredString(id, 'id', 200);
    if (this._deletions.has(id)) return this._deletions.get(id);
    const task = this.tasks.find(item => item.id === id);
    if (!task) return { deleted: true, id };
    if (task && (task.status === 'running' || this._processing.has(id) || this._active.has(id)
      || ([...PENDING, 'paused'].includes(task.status) && (task.submissionReceipt || task.turnId || ['intent', 'submitted'].includes(task.dispatchState))))) {
      throw queueError('任务正在运行、派发或尚有未确认的提交，暂时无法删除。请先核对目标对话，等待处理结束或取消排队后再试。', 'task_busy', 409);
    }
    this._deleting.set(id, task);
    const operation = this._persist({ prepare: () => {
      const index = this.tasks.indexOf(task);
      if (index < 0) throw new Error('Task not found.');
      const hash = task.clientRequestId ? requestHash(task.clientRequestId) : null;
      const hadMarker = hash && this.deletedRequestHashes.has(hash);
      this.tasks.splice(index, 1);
      if (hash) this.deletedRequestHashes.add(hash);
      return () => {
        this.tasks.splice(Math.min(index, this.tasks.length), 0, task);
        if (hash && !hadMarker) this.deletedRequestHashes.delete(hash);
        if (PENDING.has(task.status) || task.status === 'paused') {
          task.status = 'paused';
          task.nextAttemptAt = null;
          task.updatedAt = this._now();
          task.lastError = '删除未能保存，任务已暂停。请检查存储后重试删除。';
        }
        this._deleteStorageFaults.add(id);
        this.lastTickError = '删除未能保存，调度已暂停。任务记录已保留，请检查磁盘空间或权限后重试删除。';
      };
    } }).then(() => {
      const recovered = this._deleteStorageFaults.delete(id);
      if (recovered && !this._deleteStorageFaults.size) this.lastTickError = null;
      return { deleted: true, id };
    }, () => {
      this._deleteStorageFaults.add(id);
      this.lastTickError = '删除未能保存，调度已暂停。任务记录已保留，请检查磁盘空间或权限后重试删除。';
      throw queueError('删除未能保存，调度已暂停。任务记录已保留，请检查磁盘空间或权限后重试删除。', 'deletion_persist_failed', 503);
    }).finally(() => { this._deleting.delete(id); this._deletions.delete(id); });
    this._deletions.set(id, operation);
    return operation;
  }

  async retry(id, { acknowledgeDuplicateRisk = false } = {}) {
    this._assertInitialized();
    const task = this._find(id);
    this._assertMutable(task);
    if (task.status !== 'failed' && task.status !== 'needs_review') throw new Error('Only failed tasks or tasks needing review can be retried.');
    if (task.status === 'needs_review' && !acknowledgeDuplicateRisk) throw new Error('The previous submission is uncertain and may already have run. Review the conversation first, then explicitly acknowledge duplicate risk.');
    task.status = 'scheduled';
    task.nextAttemptAt = this._now();
    task.updatedAt = this._now();
    task.lastError = null;
    task.result = null;
    task.turnId = null;
    task.submissionReceipt = null;
    task.lastRejectedSubmission = null;
    delete task.deliveryState;
    delete task.failureStage;
    task.dispatchState = null;
    task.dispatchStartedAt = null;
    task.quotaRechecks = 0;
    task.quotaResetAt = null;
    await this._persist();
    return copy(task);
  }

  start() {
    this._assertInitialized();
    if (this._timer) return this;
    this._stopping = false;
    this._timer = setInterval(() => { void this.tick().catch(error => { this.lastTickError = errorText(error); }); }, this.pollMs);
    this._timer.unref?.();
    void this.tick().catch(error => { this.lastTickError = errorText(error); });
    return this;
  }

  async stop() {
    this._stopping = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._tickPromise) await this._tickPromise;
    await this._writeTail;
  }

  tick() {
    this._assertInitialized();
    if (this._tickPromise) return this._tickPromise;
    this._tickPromise = this._tick().finally(() => { this._tickPromise = null; });
    return this._tickPromise;
  }

  async _tick() {
    if (this._deleteStorageFaults.size) return this.list();
    this.lastTickError = null;
    if (this._stopping) return this.list();
    // Recovered running turns are observed again; they are never submitted again.
    for (const task of this.tasks.filter(item => item.status === 'running' && !this._active.has(item.id))) {
      if (task.nextAttemptAt && Date.parse(task.nextAttemptAt) > this.clock()) continue;
      this._processing.add(task.id);
      try { await this._reconcile(task); }
      finally { this._processing.delete(task.id); }
    }
    const runningThreads = new Set([...this.tasks.filter(task => task.status === 'running'), ...this._deleting.values()].map(task => task.threadId));
    // Send time orders each conversation; creation order breaks ties.
    // A paused, quota-waiting or uncertain earlier item blocks later sends.
    const ordered = this.tasks.map((task, index) => ({ task, index }))
      .sort((a, b) => Date.parse(a.task.runAt) - Date.parse(b.task.runAt) || a.index - b.index)
      .map(item => item.task);
    const firstByThread = new Map();
    for (const task of ordered) if (BLOCKING.has(task.status) && !firstByThread.has(task.threadId)) firstByThread.set(task.threadId, task.id);
    const candidates = [];
    for (const task of ordered) {
      if (!PENDING.has(task.status) || firstByThread.get(task.threadId) !== task.id || runningThreads.has(task.threadId)) continue;
      if (Date.parse(task.runAt) > this.clock() || Date.parse(task.nextAttemptAt ?? task.runAt) > this.clock()) continue;
      candidates.push(task);
    }
    const slots = Math.max(0, this.maxConcurrent - this.tasks.filter(task => task.status === 'running').length);
    let cursor = 0;
    const worker = async () => {
      while (!this._stopping && !this._deleteStorageFaults.size && cursor < candidates.length) {
        const task = candidates[cursor++];
        // Mutations may happen while another candidate is being processed.
        if (!this.tasks.includes(task) || !PENDING.has(task.status) || this._processing.has(task.id) || [...this._deleting.values()].some(item => item.threadId === task.threadId)) continue;
        if (Date.parse(task.runAt) > this.clock() || Date.parse(task.nextAttemptAt ?? task.runAt) > this.clock()) continue;
        const currentHead = this.tasks.filter(item => item.threadId === task.threadId && BLOCKING.has(item.status))
          .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))[0];
        if (currentHead?.id !== task.id) continue;
        this._processing.add(task.id);
        try { await this._process(task); }
        finally { this._processing.delete(task.id); this._active.delete(task.id); }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(slots, candidates.length) }, worker));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    return this.list();
  }

  async _wait(task, status, error, retryAt) {
    let next = validOptionalDate(retryAt);
    if (status === 'waiting_quota' && task.sendMode === 'quota_available') {
      // Reset times are estimates; a fresh quota check may establish recovery
      // earlier. Keep the estimate separate from the bounded polling deadline.
      task.quotaResetAt = next;
      const resetMs = next ? Date.parse(next) : NaN;
      next = new Date(Math.min(this.clock() + QUOTA_POLL_MS, resetMs > this.clock() ? resetMs : Infinity)).toISOString();
    } else if (!next || Date.parse(next) <= this.clock()) {
      const delay = status === 'waiting_quota'
        ? Math.min(900_000, 60_000 * 2 ** Math.min(task.quotaRechecks ?? 0, 4))
        : Math.max(this.pollMs, 5_000);
      next = new Date(this.clock() + delay).toISOString();
    }
    if (status === 'waiting_quota') task.quotaRechecks = (task.quotaRechecks ?? 0) + 1;
    task.status = status;
    task.lastError = error || (status === 'waiting_quota' ? 'Waiting for the selected model quota to recover.' : 'Waiting for the conversation to become idle.');
    task.nextAttemptAt = next;
    task.updatedAt = this._now();
    // A confirmed pre-submission wait can be safely tried again.
    task.dispatchState = null;
    task.dispatchStartedAt = null;
    await this._persist();
  }

  async _fail(task, error, status = 'failed') {
    task.status = status;
    task.lastError = errorText(error);
    task.nextAttemptAt = null;
    task.updatedAt = this._now();
    await this._persist();
  }

  async _process(task) {
    let thread;
    let quota;
    try {
      thread = await this.adapter.getThreadState(copy(task));
      if (!thread || typeof thread.busy !== 'boolean' || typeof thread.archived !== 'boolean') throw new Error('Could not verify conversation state.');
      if (thread.archived) { await this._fail(task, 'This conversation is archived. Unarchive it or select an active conversation before retrying.'); return; }
      if (thread.cwd && !samePath(thread.cwd, task.executionPath || task.projectPath)) { await this._fail(task, 'The selected conversation belongs to a different project directory.'); return; }
      if (thread.busy) { await this._wait(task, 'waiting_thread', 'The conversation is currently running another turn.'); return; }
    } catch (error) { await this._fail(task, error); return; }
    try {
      quota = task.sendMode === 'quota_available'
        ? await this.adapter.getQuota(task.model, { refresh: true })
        : await this.adapter.getQuota(task.model);
      if (!quota || typeof quota.allowed !== 'boolean') throw new Error('Could not verify the selected model quota.');
    } catch (error) {
      if (task.sendMode === 'quota_available') await this._wait(task, 'waiting_quota', errorText(error));
      else await this._fail(task, error);
      return;
    }
    if (this._stopping || this._deleteStorageFaults.size) return;
    if (!quota.allowed) { await this._wait(task, 'waiting_quota', quota.reason, quota.resetAt); return; }
    task.status = 'running';
    task.attempts++;
    task.quotaRechecks = 0;
    task.quotaResetAt = null;
    task.lastError = null;
    task.dispatchState = 'intent';
    task.dispatchStartedAt = this._now();
    task.updatedAt = this._now();
    task.nextAttemptAt = null;
    // If this write fails, execute is never called.
    await this._persist();
    if (this._stopping || this._deleteStorageFaults.size) {
      // The intent write completed, but no request was sent. This rollback is
      // safe; a stopped worker must not begin another turn during shutdown.
      task.status = 'scheduled';
      task.attempts--;
      task.dispatchState = null;
      task.dispatchStartedAt = null;
      task.nextAttemptAt = this._now();
      task.updatedAt = this._now();
      await this._persist();
      return;
    }
    this._active.add(task.id);
    let result;
    try {
      result = await this.adapter.execute(copy(task), {
        onSubmitted: async receipt => {
          task.submissionReceipt = validateReceipt(receipt);
          task.dispatchState = 'submitted';
          task.updatedAt = this._now();
          await this._persist();
        },
        onTurnStarted: async turnId => {
          task.turnId = requiredString(typeof turnId === 'object' ? turnId.turnId ?? turnId.id : turnId, 'turnId', 200);
          task.dispatchState = 'submitted';
          task.updatedAt = this._now();
          await this._persist();
        },
      });
    } catch (error) {
      // A transport exception after dispatch cannot prove that no turn exists.
      await this._fail(task, `Submission status is uncertain: ${errorText(error)}. Check the conversation before retrying.`, 'needs_review');
      return;
    }
    await this._applyResult(task, result);
  }

  async _reconcile(task) {
    let result;
    try { result = await this.adapter.reconcile(copy(task)); }
    catch (error) { await this._fail(task, `Could not reconcile the previous submission: ${errorText(error)}. Check the conversation before retrying.`, 'needs_review'); return; }
    await this._applyResult(task, result);
  }

  async _applyResult(task, result) {
    if (!result || typeof result.status !== 'string') { await this._fail(task, 'The submission result could not be confirmed. Check the conversation before retrying.', 'needs_review'); return; }
    const previousOutput = task.result;
    if (result.submissionReceipt != null) {
      try { task.submissionReceipt = validateReceipt(result.submissionReceipt); }
      catch (error) { await this._fail(task, `The submission receipt is invalid: ${errorText(error)}. Check the conversation before retrying.`, 'needs_review'); return; }
    }
    if (result.turnId) task.turnId = String(result.turnId);
    if (result.output != null) task.result = typeof result.output === 'string' ? result.output : copy(result.output);
    if (result.status === 'waiting_quota' || result.status === 'waiting_thread') {
      if (task.submissionReceipt) {
        const hasOutput = value => value != null && (typeof value !== 'string' || value.trim().length > 0);
        const confirmedRejectedTurn = result.status === 'waiting_quota'
          && result.confirmedNoWork === true
          && Boolean(task.turnId)
          && task.submissionReceipt.native?.turnId === task.turnId
          && !hasOutput(result.output)
          && !hasOutput(previousOutput);
        if (confirmedRejectedTurn) {
          task.lastRejectedSubmission = copy(task.submissionReceipt);
          task.submissionReceipt = null;
        } else {
          await this._fail(task, 'Codex desktop already acknowledged this submission. Its waiting state cannot safely authorize another send; check the conversation first.', 'needs_review');
          return;
        }
      }
      if (task.turnId && result.status === 'waiting_thread') {
        await this._fail(task, 'A turn ID was returned with a pre-submission wait. Check the conversation before retrying.', 'needs_review');
        return;
      }
      // An adapter reporting a wait must have established that no work ran.
      task.turnId = null;
      await this._wait(task, result.status, result.error, result.retryAt);
      return;
    }
    if (result.status === 'running') {
      if (!task.turnId && !task.submissionReceipt) {
        await this._fail(task, 'No turn ID or submission receipt confirms the running request. Check the conversation before retrying.', 'needs_review');
        return;
      }
      task.status = 'running';
      task.dispatchState = 'submitted';
      task.nextAttemptAt = new Date(this.clock() + Math.max(this.pollMs, 5_000)).toISOString();
      task.updatedAt = this._now();
      await this._persist();
      return;
    }
    if (result.status === 'completed') {
      task.status = 'completed';
      task.lastError = null;
      task.dispatchState = 'finished';
      task.nextAttemptAt = null;
      task.updatedAt = this._now();
      await this._persist();
      return;
    }
    if (result.status === 'failed' || result.status === 'interrupted') {
      task.dispatchState = 'finished';
      await this._fail(task, result.error || (result.status === 'interrupted' ? 'The turn was interrupted; manual retry is required.' : 'The turn failed; manual retry is required.'));
      return;
    }
    await this._fail(task, result.error || 'The previous submission needs manual review before any resend.', 'needs_review');
  }
}

function samePath(a, b) {
  const windows = path.win32.isAbsolute(a) || path.win32.isAbsolute(b);
  const api = windows ? path.win32 : path;
  const normalize = value => api.normalize(value).replace(/[\\/]+$/, '') || api.parse(value).root;
  return windows ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
}

export default QueueManager;
