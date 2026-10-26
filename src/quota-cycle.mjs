import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, open, rename, unlink} from 'node:fs/promises';
import path from 'node:path';

const STATUSES=new Set(['waiting_quota','waiting_reset','awaiting_window_binding','waiting_thread','queued','running','paused','needs_review','error']);
const CHILD_PENDING=new Set(['scheduled','waiting_quota','waiting_thread','paused']);
const CHILD_BLOCKING=new Set([...CHILD_PENDING,'running','needs_review']);
const EDITABLE=new Set(['projectPath','executionPath','sourceThreadId','projectLabel','threadId','threadTitle','model','effort','prompt','timeZone']);
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/;
const UUID=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const textError=error=>String(error?.message||error||'未知错误').slice(0,4000);
const cycleError=(message,code='cycle_invalid',statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const samePath=(left,right)=>path.resolve(left).replace(/[\\/]+$/,'').toLowerCase()===path.resolve(right).replace(/[\\/]+$/,'').toLowerCase();
function string(value,name,max=100000){if(typeof value!=='string'||!value.trim()||value.length>max)throw cycleError(`${name} 无效。`);return value.trim();}
function date(value,name='时间'){
  if(typeof value!=='string'||!DATE.test(value)||!Number.isFinite(Date.parse(value)))throw cycleError(`${name} 无效。`);
  const [year,month,day]=value.slice(0,10).split('-').map(Number),[hour,minute,second]=value.slice(11,19).split(':').map(Number);
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)throw cycleError(`${name} 无效。`);
  return new Date(value).toISOString();
}
function optionalDate(value,name){return value==null?null:date(value,name);}
function taskFields(input){
  const projectPath=string(input.projectPath,'项目路径',32768);
  if(!path.isAbsolute(projectPath)&&!path.win32.isAbsolute(projectPath))throw cycleError('项目必须使用完整路径。');
  const executionPath=input.executionPath==null?null:string(input.executionPath,'对话工作目录',32768);
  if(executionPath&&!path.isAbsolute(executionPath)&&!path.win32.isAbsolute(executionPath))throw cycleError('对话工作目录必须使用完整路径。');
  const sourceThreadId=input.sourceThreadId==null?null:string(input.sourceThreadId,'来源对话',36);
  if(sourceThreadId&&!UUID.test(sourceThreadId))throw cycleError('来源对话编号无效。');
  const timeZone=input.timeZone??'Asia/Shanghai';
  try{new Intl.DateTimeFormat('en',{timeZone});}catch{throw cycleError('时区无效。');}
  const effort=input.effort==null||input.effort===''?null:string(input.effort,'思考强度',32);
  if(effort&&!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(effort))throw cycleError('思考强度无效。');
  string(input.prompt,'发送内容');
  return {projectPath,executionPath,sourceThreadId,projectLabel:typeof input.projectLabel==='string'?input.projectLabel.trim().slice(0,500):path.basename(projectPath),
    threadId:string(input.threadId,'目标对话',200),threadTitle:typeof input.threadTitle==='string'?input.threadTitle.trim().slice(0,1000):'',
    model:string(input.model,'模型',200),effort,prompt:input.prompt,timeZone};
}

// A display rounded to 100% is not evidence of a full window. Only the raw,
// unambiguous five-hour window can drive this independent scheduling rule.
export function selectQuotaCycleWindow(quota){
  if(!Array.isArray(quota?.windows))return null;
  const five=quota.windows.filter(window=>window&&typeof window.windowDurationMins==='number'&&window.windowDurationMins===300);
  // A bucket name alone does not establish which model consumes it. Wait when
  // more than one five-hour window is present instead of guessing an alias.
  if(five.length!==1)return null;
  const window=five[0];
  if(typeof window.usedPercent!=='number'||!Number.isFinite(window.usedPercent)||window.usedPercent<0||window.usedPercent>100)return null;
  let resetsAt=null;
  if(window.resetsAt!=null){try{resetsAt=date(window.resetsAt,'额度刷新时间');}catch{return null;}}
  return {limitId:typeof window.limitId==='string'?window.limitId:'legacy',kind:typeof window.kind==='string'?window.kind:'primary',
    windowDurationMins:300,usedPercent:window.usedPercent,resetsAt};
}

function requestId(rule,cycleKey){return `quota-cycle:${hash(`${rule.id}\0${rule.generation}\0${cycleKey}`)}`;}
function validateRule(rule){
  if(!rule||typeof rule!=='object'||Array.isArray(rule)||typeof rule.id!=='string'||!UUID.test(rule.id))throw cycleError('循环规则编号无效。');
  const fields=taskFields(rule);
  if(Object.keys(fields).some(key=>rule[key]!==fields[key]))throw cycleError('循环规则任务字段无效。');
  if(typeof rule.enabled!=='boolean'||!STATUSES.has(rule.status)||!Number.isSafeInteger(rule.generation)||rule.generation<1||!Number.isSafeInteger(rule.completedCycles)||rule.completedCycles<0)throw cycleError('循环规则状态无效。');
  if(rule.enabled&&['paused','needs_review','error'].includes(rule.status)||!rule.enabled&&!['paused','needs_review','error'].includes(rule.status))throw cycleError('循环开关与状态不一致。');
  for(const key of ['createdAt','updatedAt'])date(rule[key],key);
  for(const key of ['nextCheckAt','nextResetAt','cycleCursor','lastSentAt'])optionalDate(rule[key],key);
  if(typeof rule.awaitingWindowBinding!=='boolean')throw cycleError('循环窗口状态无效。');
  for(const key of ['clientRequestId','activeRequestId','activeTaskId','lastTaskId','lastTaskStatus','lastCycleKey'])if(rule[key]!=null)string(rule[key],key,200);
  if(rule.lastError!=null&&typeof rule.lastError!=='string'||rule.lastResult!=null&&typeof rule.lastResult!=='string')throw cycleError('循环结果格式无效。');
  if(!Array.isArray(rule.lastObservedWindows)||rule.lastObservedWindows.length>1)throw cycleError('循环窗口记录无效。');
  for(const window of rule.lastObservedWindows)if(!selectQuotaCycleWindow({windows:[window]}))throw cycleError('循环窗口记录无效。');
  if(rule.lastCycleKey!=null&&rule.lastCycleKey!=='bootstrap'){
    if(!rule.lastCycleKey.startsWith('after:'))throw cycleError('循环周期标识无效。');date(rule.lastCycleKey.slice(6));
  }
  if(rule.cycleCursor&&!rule.lastCycleKey||rule.completedCycles>0&&(!rule.lastSentAt||!rule.lastCycleKey))throw cycleError('循环周期记录不完整。');
  if(rule.lastCycleKey&&!rule.nextResetAt&&!rule.awaitingWindowBinding&&!rule.dispatchIntent)throw cycleError('循环缺少刷新边界。');
  if(['queued','running'].includes(rule.status)&&!rule.dispatchIntent)throw cycleError('循环缺少派发记录。');
  if(rule.dispatchIntent!=null){
    const intent=rule.dispatchIntent;
    if(!intent||typeof intent!=='object'||Array.isArray(intent)||intent.generation!==rule.generation)throw cycleError('循环派发记录无效。');
    string(intent.cycleKey,'派发周期',200);date(intent.createdAt);taskFields(intent.input);date(intent.input.runAt);
    if(Object.keys(fields).some(key=>intent.input[key]!==fields[key]))throw cycleError('循环派发内容与规则不一致。');
    if(intent.cycleKey!==rule.lastCycleKey||intent.input.sendMode!=='scheduled'||intent.requestId!==requestId(rule,intent.cycleKey)||intent.requestId!==rule.activeRequestId||intent.input.clientRequestId!==intent.requestId)throw cycleError('循环派发标识无效。');
  }else if(rule.activeRequestId!=null||rule.activeTaskId!=null)throw cycleError('缺少循环派发记录。');
}

/** Durable rules that create ordinary one-shot QueueManager tasks. One owner per file. */
export class QuotaCycleManager{
  constructor({storePath,queue,adapter,clock=()=>Date.now(),pollMs=30000,onChange=()=>{}}){
    if(!storePath||!queue||typeof queue.list!=='function'||typeof queue.create!=='function'||!adapter||typeof adapter.getQuota!=='function')throw new Error('storePath, queue and adapter are required.');
    this.storePath=storePath;this.queue=queue;this.adapter=adapter;this.clock=clock;this.pollMs=Math.max(100,Number(pollMs)||30000);this.onChange=onChange;
    this.rules=[];this.deletedRequestHashes=new Set();this.initialized=false;this.lastTickError=null;this._storageFault=false;this._tail=Promise.resolve();this._timer=null;this._stopping=false;this._suppressed=new Set();this._suppressionEpochs=new Map();
  }
  _now(){return new Date(this.clock()).toISOString();}
  _next(){return new Date(this.clock()+this.pollMs).toISOString();}
  _assert(){if(!this.initialized)throw new Error('Call initialize() before using quota cycles.');}
  _find(id){const rule=this.rules.find(item=>item.id===id);if(!rule)throw cycleError('循环规则不存在。','cycle_not_found',404);return rule;}
  _serial(operation){const result=this._tail.then(operation);this._tail=result.catch(()=>{});return result;}
  async _writeStore(){
    const document={version:1,rules:this.rules,deletedRequestHashes:[...this.deletedRequestHashes]};
    const target=path.resolve(this.storePath);await mkdir(path.dirname(target),{recursive:true});
    const temporary=`${target}.${process.pid}.${randomUUID()}.tmp`;let handle;
    try{handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(document,null,2)+'\n');await handle.sync();await handle.close();handle=null;await rename(temporary,target);}
    finally{await handle?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
  }
  async _save(change){
    const previous=clone(this.rules),markers=new Set(this.deletedRequestHashes);
    try{change();await this._writeStore();}
    catch(error){
      this.rules=previous;this.deletedRequestHashes=markers;this._storageFault=true;this.lastTickError='循环规则未能保存，已暂停新派发。请检查磁盘或权限后恢复。';
      // An already created child is independently durable. Try to pause only
      // this rule's unsubmitted child, never another task or an accepted turn.
      for(const rule of this.rules){const child=this._child(rule);if(child&&this._owns(rule,child)&&CHILD_PENDING.has(child.status)&&!this._submitted(child))try{await this.queue.pause(child.id);}catch{}}
      throw cycleError(`${this.lastTickError} ${textError(error)}`,'cycle_persist_failed',503);
    }
    try{this.onChange(this.list());}catch{}
  }
  async initialize(){return this._serial(async()=>{
    if(this.initialized)return this;
    let document;
    try{document=JSON.parse(await readFile(this.storePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error(`无法安全读取循环规则，原文件未覆盖：${textError(error)}`);}
    if(document){
      if(document.version!==1||!Array.isArray(document.rules)||document.rules.length>1000||!Array.isArray(document.deletedRequestHashes)||document.deletedRequestHashes.some(value=>typeof value!=='string'||!/^[a-f\d]{64}$/.test(value))||new Set(document.deletedRequestHashes).size!==document.deletedRequestHashes.length)throw new Error('循环规则存储无效，原文件未覆盖。');
      const ids=new Set(),requests=new Set();
      for(const rule of document.rules){validateRule(rule);if(ids.has(rule.id)||rule.clientRequestId&&(requests.has(rule.clientRequestId)||document.deletedRequestHashes.includes(hash(rule.clientRequestId))))throw new Error('循环规则存在重复或已删除标识，原文件未覆盖。');ids.add(rule.id);if(rule.clientRequestId)requests.add(rule.clientRequestId);}
      this.rules=document.rules;this.deletedRequestHashes=new Set(document.deletedRequestHashes);
    }else await this._writeStore();
    this.initialized=true;return this;
  });}
  list(){this._assert();return clone(this.rules);}
  get(id){this._assert();return clone(this._find(id));}
  create(input){return this._serial(async()=>{
    this._assert();
    if(this._storageFault){
      if(this.rules.length)throw cycleError(this.lastTickError,'cycle_storage_paused',503);
      // A failed first create rolled back its only rule, so no rule exists to
      // resume. A successful empty checkpoint permits retry after disk repair.
      await this._save(()=>{});this._storageFault=false;this.lastTickError=null;
    }
    const clientRequestId=input.clientRequestId==null?null:string(input.clientRequestId,'请求编号',200);
    if(clientRequestId&&this.deletedRequestHashes.has(hash(clientRequestId)))throw cycleError('该创建请求对应的循环已删除，请新建规则。','creation_deleted',409);
    const existing=clientRequestId&&this.rules.find(rule=>rule.clientRequestId===clientRequestId);if(existing)return clone(existing);
    if(this.rules.length>=1000)throw cycleError('循环规则数量已达到上限。');
    if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw cycleError('循环开关无效。');
    const now=this._now(),enabled=input.enabled!==false;
    const rule={id:randomUUID(),...taskFields(input),clientRequestId,enabled,status:enabled?'waiting_quota':'paused',createdAt:now,updatedAt:now,
      nextCheckAt:enabled?now:null,nextResetAt:null,lastError:null,generation:1,cycleCursor:null,lastCycleKey:null,awaitingWindowBinding:false,lastObservedWindows:[],
      activeRequestId:null,activeTaskId:null,lastTaskId:null,lastTaskStatus:null,lastResult:null,lastSentAt:null,completedCycles:0,dispatchIntent:null};
    await this._save(()=>this.rules.push(rule));return clone(rule);
  });}
  update(id,patch){return this._serial(async()=>{
    this._assert();if(this._storageFault)throw cycleError(this.lastTickError,'cycle_storage_paused',503);
    const rule=this._find(id);if(rule.dispatchIntent)throw cycleError('本轮任务尚未结束，暂时无法修改循环，请先处理本轮任务。','cycle_busy',409);
    for(const key of Object.keys(patch))if(!EDITABLE.has(key))throw cycleError(`循环字段 ${key} 不允许修改。`);
    const fields=taskFields({...rule,...patch});
    await this._save(()=>{Object.assign(rule,fields,{generation:rule.generation+1,updatedAt:this._now(),nextCheckAt:rule.enabled?this._now():null,lastError:null});});return this.get(id);
  });}
  _submitted(child){return Boolean(child.turnId||child.submissionReceipt||['intent','submitted'].includes(child.dispatchState));}
  _child(rule){return this.queue.list().find(task=>task.id===rule.activeTaskId||rule.activeRequestId&&task.clientRequestId===rule.activeRequestId)||null;}
  _owns(rule,child){return Boolean(rule.dispatchIntent&&child.clientRequestId===rule.activeRequestId&&Object.keys(taskFields(rule)).every(key=>child[key]===rule.dispatchIntent.input[key]));}
  _suppressNew(id){this._suppressed.add(id);this._suppressionEpochs.set(id,(this._suppressionEpochs.get(id)||0)+1);}
  pause(id){this._assert();this._suppressNew(id);return this._serial(async()=>{
    this._assert();let rule=this._find(id);
    await this._save(()=>Object.assign(rule,{enabled:false,status:'paused',nextCheckAt:null,updatedAt:this._now()}));
    const child=this._child(rule);
    if(child&&this._owns(rule,child)&&CHILD_PENDING.has(child.status)&&!this._submitted(child)){
      try{await this.queue.pause(child.id);}catch(error){rule=this._find(id);await this._save(()=>{rule.lastError=`循环已暂停；本轮任务未能暂停：${textError(error)}`;});}
    }else if(child&&this._submitted(child)){rule=this._find(id);await this._save(()=>{rule.lastError='循环已暂停；已派发的本轮任务会继续，之后不再新建任务。';});}
    return this.get(id);
  });}
  resume(id){this._assert();const requestedEpoch=this._suppressionEpochs.get(id)||0;return this._serial(async()=>{
    this._assert();let rule=this._find(id);const child=this._child(rule);
    if((this._suppressionEpochs.get(id)||0)!==requestedEpoch)return clone(rule);
    if(rule.status==='needs_review'&&(!child||child.status==='needs_review'))throw cycleError('请先核对本轮发送结果，并在任务队列中处理后再恢复循环。','cycle_needs_review',409);
    if(child&&!this._owns(rule,child))throw cycleError('关联任务已改变，请先核对本轮任务。','cycle_needs_review',409);
    if(child?.status==='needs_review')throw cycleError('请先核对本轮发送结果。','cycle_needs_review',409);
    await this._save(()=>Object.assign(rule,{enabled:true,status:rule.awaitingWindowBinding?'awaiting_window_binding':'waiting_reset',lastError:null,nextCheckAt:this._now(),updatedAt:this._now()}));
    if((this._suppressionEpochs.get(id)||0)!==requestedEpoch){
      rule=this._find(id);await this._save(()=>Object.assign(rule,{enabled:false,status:'paused',nextCheckAt:null,updatedAt:this._now()}));return this.get(id);
    }
    this._suppressed.delete(id);
    this._storageFault=false;this.lastTickError=null;
    if(child?.status==='paused'){
      try{await this.queue.resume(child.id);}catch(error){rule=this._find(id);await this._save(()=>Object.assign(rule,{enabled:false,status:'error',lastError:textError(error),nextCheckAt:null}));throw error;}
      if((this._suppressionEpochs.get(id)||0)!==requestedEpoch||this._suppressed.has(id)){
        rule=this._find(id);const resumed=this._child(rule);
        if(resumed&&this._owns(rule,resumed)&&CHILD_PENDING.has(resumed.status)&&!this._submitted(resumed))try{await this.queue.pause(resumed.id);}catch{}
        await this._save(()=>Object.assign(rule,{enabled:false,status:'paused',nextCheckAt:null,lastTaskStatus:this._child(rule)?.status||rule.lastTaskStatus,updatedAt:this._now()}));
      }
    }
    return this.get(id);
  });}
  delete(id){this._assert();this._suppressNew(id);return this._serial(async()=>{
    this._assert();const rule=this.rules.find(item=>item.id===id);if(!rule){this._suppressed.delete(id);return {deleted:true,id};}
    await this._save(()=>Object.assign(rule,{enabled:false,status:'paused',nextCheckAt:null,updatedAt:this._now()}));
    const child=this._child(rule);
    if(child){
      if(!this._owns(rule,child))throw cycleError('关联任务内容已改变；循环已暂停，请先核对。','cycle_needs_review',409);
      if(child.status==='running'||CHILD_PENDING.has(child.status)&&this._submitted(child))throw cycleError('本轮已派发，循环已暂停。请等待本轮结束后再删除。','cycle_busy',409);
      try{await this.queue.delete(child.id);}catch(error){const retained=this._find(id);await this._save(()=>{retained.lastError=`循环已暂停，关联任务未删除：${textError(error)}`;});throw error;}
    }
    await this._save(()=>{this.rules=this.rules.filter(item=>item.id!==id);if(rule.clientRequestId)this.deletedRequestHashes.add(hash(rule.clientRequestId));});
    this._suppressed.delete(id);
    if(!this.rules.length){this._storageFault=false;this.lastTickError=null;}
    return {deleted:true,id,deletedTaskId:child?.id||null};
  });}
  start(){this._assert();if(this._timer)return this;this._stopping=false;this._timer=setInterval(()=>{void this.tick().catch(error=>{this.lastTickError=textError(error);});},this.pollMs);this._timer.unref?.();void this.tick().catch(error=>{this.lastTickError=textError(error);});return this;}
  async stop(){this._stopping=true;if(this._timer)clearInterval(this._timer);this._timer=null;await this._tail;}
  tick(){return this._serial(async()=>{
    this._assert();if(this._stopping||this._storageFault)return this.list();
    for(const entry of [...this.rules]){
      if(this._stopping||this._storageFault)break;
      const rule=this._find(entry.id);if(!rule.enabled&&!rule.dispatchIntent)continue;
      if(rule.enabled&&rule.nextCheckAt&&Date.parse(rule.nextCheckAt)>this.clock())continue;
      await this._process(rule.id);
    }
    return this.list();
  });}
  async _status(id,status,message=null,extra={}){const rule=this._find(id);await this._save(()=>Object.assign(rule,{status:rule.enabled?status:rule.status,
    lastError:message==null&&!rule.enabled&&['error','needs_review'].includes(rule.status)?rule.lastError:message,nextCheckAt:rule.enabled?this._next():null,updatedAt:this._now()},extra));}
  async _suppress(id,status='deleted'){
    const rule=this._find(id);await this._save(()=>Object.assign(rule,{activeTaskId:null,activeRequestId:null,dispatchIntent:null,lastTaskStatus:status,
      status:rule.enabled?(rule.awaitingWindowBinding?'awaiting_window_binding':'waiting_reset'):'paused',lastError:'本轮任务已取消或删除，本窗口不会重新创建。',updatedAt:this._now(),nextCheckAt:rule.enabled?this._next():null}));
  }
  async _createChild(id){
    let rule=this._find(id);if(!rule.enabled||this._stopping||this._storageFault||this._suppressed.has(id)||!rule.dispatchIntent)return null;
    let child=this._child(rule);
    if(!child){
      try{child=await this.queue.create(clone(rule.dispatchIntent.input));}
      catch(error){
        if(error.code==='creation_deleted'){await this._suppress(id);return null;}
        // QueueManager may have pushed its in-memory task before its own disk
        // write failed. Pause that exact, still-unsubmitted owned task even if
        // persisting the pause also fails; never leave it ready for dispatch.
        const retained=this._child(rule);
        if(retained&&this._owns(rule,retained)&&CHILD_PENDING.has(retained.status)&&!this._submitted(retained))try{await this.queue.pause(retained.id);}catch{}
        await this._status(id,'error',`本轮任务未能加入队列：${textError(error)}`,{enabled:false,nextCheckAt:null,...(retained&&this._owns(rule,retained)?{activeTaskId:retained.id,lastTaskId:retained.id,lastTaskStatus:retained.status}:{})});return null;
      }
    }
    rule=this._find(id);
    if(!this._owns(rule,child)){await this._status(id,'needs_review','关联任务内容与已保存的本轮请求不一致，请先核对。',{enabled:false,nextCheckAt:null});return null;}
    if(this._stopping||this._storageFault||this._suppressed.has(id)){
      // Pause synchronously in QueueManager before awaiting our second store
      // write: its independent timer must not race a pending pause/delete.
      if(CHILD_PENDING.has(child.status)&&!this._submitted(child))try{await this.queue.pause(child.id);}catch{}
      child=this._child(rule)||child;
      await this._save(()=>Object.assign(rule,{enabled:false,status:'paused',activeTaskId:child.id,lastTaskId:child.id,lastTaskStatus:child.status,nextCheckAt:null,
        lastError:this._submitted(child)?'循环已暂停；已经派发的本轮任务会继续。':'循环已暂停，本轮尚未派发。',updatedAt:this._now()}));
      return child;
    }
    await this._save(()=>Object.assign(rule,{activeTaskId:child.id,lastTaskId:child.id,lastTaskStatus:child.status,status:'queued',updatedAt:this._now(),nextCheckAt:this._next()}));
    return child;
  }
  async _process(id){
    let rule=this._find(id),completedNow=false;
    if(rule.dispatchIntent){
      let child=this._child(rule);
      if(!child&&rule.activeTaskId){await this._suppress(id);return;}
      if(!child){if(!rule.enabled)return;child=await this._createChild(id);if(!child)return;rule=this._find(id);}
      if(!this._owns(rule,child)){await this._status(id,'needs_review','关联任务已被修改，请先核对。',{enabled:false,nextCheckAt:null});return;}
      if(!rule.activeTaskId)await this._save(()=>{rule.activeTaskId=child.id;rule.lastTaskId=child.id;});
      if(child.status==='completed'){
        const sent=optionalDate(child.dispatchStartedAt||child.submissionReceipt?.acknowledgedAt||child.updatedAt||child.createdAt,'发送时间');
        await this._save(()=>Object.assign(rule,{completedCycles:rule.completedCycles+1,lastTaskId:child.id,lastTaskStatus:'completed',lastResult:child.result==null?null:(typeof child.result==='string'?child.result:JSON.stringify(child.result)).slice(0,10000),
          lastSentAt:sent,activeRequestId:null,activeTaskId:null,dispatchIntent:null,awaitingWindowBinding:true,nextResetAt:null,status:rule.enabled?'awaiting_window_binding':'paused',lastError:null,updatedAt:this._now()}));completedNow=true;
      }else if(child.status==='needs_review'||child.status==='cancelled'&&this._submitted(child)){
        await this._status(id,'needs_review','本轮发送结果尚未确认，循环已停止，请先核对目标对话。',{enabled:false,nextCheckAt:null,lastTaskStatus:child.status,lastTaskId:child.id});return;
      }else if(child.status==='failed'){
        await this._status(id,'error',`本轮任务失败，循环已暂停：${child.lastError||'请检查任务队列。'}`,{enabled:false,nextCheckAt:null,lastTaskStatus:'failed',lastTaskId:child.id,lastResult:child.result==null?null:String(child.result).slice(0,10000),activeRequestId:null,activeTaskId:null,dispatchIntent:null});return;
      }else if(child.status==='cancelled'){await this._suppress(id,'cancelled');return;}
      else{
        const status=child.status==='running'?'running':child.status==='waiting_quota'?'waiting_quota':child.status==='waiting_thread'?'waiting_thread':'queued';
        if(child.status==='paused'&&rule.enabled){await this._status(id,'paused','本轮任务已暂停，循环也已暂停。',{enabled:false,nextCheckAt:null,lastTaskStatus:'paused'});return;}
        await this._status(id,status,child.lastError||null,{lastTaskStatus:child.status,lastTaskId:child.id});return;
      }
      rule=this._find(id);
    }
    if(!rule.enabled||this._suppressed.has(id))return;
    let quota;
    try{quota=await this.adapter.getQuota(rule.model,{refresh:true});}catch(error){await this._status(id,'waiting_quota',`暂时无法读取额度：${textError(error)}`);return;}
    if(this._stopping||this._storageFault||this._suppressed.has(id))return;
    const window=selectQuotaCycleWindow(quota);
    if(!window){await this._status(id,'waiting_quota','无法确认唯一的 5 小时额度窗口，暂不发送。');return;}
    const freshReset=window.resetsAt&&Date.parse(window.resetsAt)>this.clock()?window.resetsAt:null;
    await this._save(()=>{rule.lastObservedWindows=[window];rule.updatedAt=this._now();});
    rule=this._find(id);
    // An acknowledged child may have waited across several windows. Treat the
    // window observed at completion as consumed; never catch up old intervals.
    if(completedNow||rule.awaitingWindowBinding){
      if(freshReset){await this._status(id,'waiting_reset',null,{awaitingWindowBinding:false,nextResetAt:freshReset,cycleCursor:freshReset});}
      else await this._status(id,'awaiting_window_binding','本轮已触发，等待额度接口返回新的刷新时间。',{awaitingWindowBinding:true,nextResetAt:null});
      return;
    }
    if(quota?.allowed!==true){await this._status(id,'waiting_quota',quota?.reason||'额度暂不可用，等待恢复后继续。');return;}
    const full=window.usedPercent===0;
    let cycleKey;
    if(!rule.lastCycleKey){
      const previousBoundary=rule.nextResetAt;
      const confirmedReset=previousBoundary&&Date.parse(previousBoundary)<=this.clock()&&freshReset&&Date.parse(freshReset)>Date.parse(previousBoundary);
      if(!full&&!confirmedReset){await this._status(id,'waiting_reset',null,{nextResetAt:freshReset||previousBoundary});return;}
      cycleKey='bootstrap';
    }else{
      const boundary=rule.nextResetAt||rule.cycleCursor;
      if(!boundary){await this._status(id,'awaiting_window_binding','本轮已触发，等待确认下一次刷新时间。',{awaitingWindowBinding:true});return;}
      if(Date.parse(boundary)>this.clock()){
        await this._status(id,'waiting_reset',null,freshReset&&freshReset!==boundary?{nextResetAt:freshReset,cycleCursor:freshReset}:{});return;
      }
      if(!full&&!(freshReset&&Date.parse(freshReset)>Date.parse(boundary))){await this._status(id,'waiting_reset','刷新时间已到，正在等待额度接口确认恢复。');return;}
      cycleKey=`after:${boundary}`;
      if(cycleKey===rule.lastCycleKey){await this._status(id,'awaiting_window_binding','本轮已触发，等待确认下一窗口。',{awaitingWindowBinding:true,nextResetAt:null});return;}
    }
    const blocker=this.queue.list().find(task=>task.threadId===rule.threadId&&CHILD_BLOCKING.has(task.status));
    if(blocker){await this._status(id,'waiting_thread','目标对话已有尚未结束的任务；处理前序任务后继续，不会积压或补发错过的周期。');return;}
    if(this._stopping||this._storageFault||this._suppressed.has(id))return;
    const now=this._now(),clientRequestId=requestId(rule,cycleKey);
    const input={...taskFields(rule),sendMode:'scheduled',runAt:now,clientRequestId};
    await this._save(()=>Object.assign(rule,{lastCycleKey:cycleKey,cycleCursor:freshReset||rule.nextResetAt||rule.cycleCursor,nextResetAt:freshReset,
      awaitingWindowBinding:!freshReset,activeRequestId:clientRequestId,activeTaskId:null,dispatchIntent:{requestId:clientRequestId,cycleKey,generation:rule.generation,input,createdAt:now},
      status:'queued',lastTaskStatus:'creating',lastError:null,nextCheckAt:this._next(),updatedAt:now}));
    if(!this._stopping)await this._createChild(id);
  }
}
