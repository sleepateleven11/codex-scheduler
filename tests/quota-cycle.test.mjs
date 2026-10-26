import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {QueueManager} from '../src/queue.mjs';
import {QuotaCycleManager,selectQuotaCycleWindow} from '../src/quota-cycle.mjs';

const BASE=Date.parse('2026-10-26T06:00:00+08:00');
const FIVE=5*60*60*1000;
const iso=value=>new Date(value).toISOString();
const input=patch=>({projectPath:'C:\\Projects\\Cycle',threadId:'cycle-conversation',threadTitle:'Quota cycle fixture',model:'gpt-cycle-fixture',effort:'low',prompt:'Reply OK only.',timeZone:'Asia/Shanghai',...patch});
const quota=(used=0,reset=BASE+FIVE)=>({allowed:true,windows:[{limitId:'codex',kind:'primary',usedPercent:used,windowDurationMins:300,resetsAt:reset==null?null:iso(reset)}]});
async function fixture(t,{initialQuota=quota(),adapter:overrides={}}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'codex-quota-cycle-test-'));
  let now=BASE,current=initialQuota,busy=false;
  const calls={execute:[],quota:[]};
  const adapter={
    async getQuota(model,options){calls.quota.push({model,options});return structuredClone(current);},
    async getThreadState(task){return {busy,archived:false,cwd:task.projectPath};},
    async execute(task,{onTurnStarted}){calls.execute.push(task);await onTurnStarted(`fixture-${task.id}`);return {status:'completed',turnId:`fixture-${task.id}`,output:'OK'};},
    async reconcile(task){return {status:'completed',turnId:task.turnId,output:'OK'};},...overrides,
  };
  const queue=new QueueManager({storePath:path.join(directory,'queue.json'),adapter,clock:()=>now});await queue.initialize();
  const storePath=path.join(directory,'cycles.json');
  let manager=new QuotaCycleManager({storePath,queue,adapter,clock:()=>now});await manager.initialize();
  const f={directory,storePath,adapter,queue,calls,get manager(){return manager;},now:()=>now,advance:ms=>{now+=ms;},setNow:value=>{now=value;},setQuota:value=>{current=value;},setBusy:value=>{busy=value;},
    async poll(){now+=30000;await manager.tick();},async restart(){await manager.stop();manager=new QuotaCycleManager({storePath,queue,adapter,clock:()=>now});await manager.initialize();return manager;},
    async complete(){await queue.tick();now+=30000;await manager.tick();},
  };
  t.after(async()=>{await manager.stop();await queue.stop();await rm(directory,{recursive:true,force:true});});
  return f;
}

test('a raw full five-hour window creates exactly one normal one-shot task with immutable preferences',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input({clientRequestId:'create-cycle-1'}));
  await Promise.all([f.manager.tick(),f.manager.tick()]);
  assert.equal(f.queue.list().length,1);const child=f.queue.list()[0];
  assert.equal(child.sendMode,'scheduled');assert.equal(child.runAt,iso(BASE));assert.equal(child.model,rule.model);assert.equal(child.effort,'low');assert.equal(child.prompt,rule.prompt);
  assert.match(child.clientRequestId,/^quota-cycle:[a-f\d]{64}$/);assert.equal(f.manager.get(rule.id).completedCycles,0);
  const snapshot=f.manager.get(rule.id);snapshot.prompt='Changed';assert.equal(f.manager.get(rule.id).prompt,rule.prompt);
  await f.complete();assert.equal(f.manager.get(rule.id).completedCycles,1);assert.equal(f.manager.get(rule.id).lastResult,'OK');assert.equal(f.manager.get(rule.id).lastSentAt,iso(BASE));
  for(let i=0;i<4;i++)await f.poll();assert.equal(f.queue.list().length,1);assert.equal(f.calls.execute.length,1);
});

test('partial quota waits for a confirmed refill rather than merely being allowed',async t=>{
  const f=await fixture(t,{initialQuota:quota(1)});const rule=await f.manager.create(input());await f.manager.tick();
  assert.equal(f.queue.list().length,0);assert.equal(f.manager.get(rule.id).status,'waiting_reset');assert.equal(f.manager.get(rule.id).nextResetAt,iso(BASE+FIVE));
  f.setNow(BASE+FIVE);f.setQuota(quota(0,BASE+2*FIVE));await f.manager.tick();assert.equal(f.queue.list().length,1);
});

test('a missing reset permits one bootstrap, then raw zero cannot produce another bootstrap',async t=>{
  const f=await fixture(t,{initialQuota:quota(0,null)});const rule=await f.manager.create(input());await f.manager.tick();await f.complete();
  assert.equal(f.manager.get(rule.id).status,'awaiting_window_binding');assert.equal(f.manager.get(rule.id).awaitingWindowBinding,true);
  await f.restart();for(let i=0;i<5;i++)await f.poll();assert.equal(f.queue.list().length,1);
  f.setQuota(quota(0,BASE+FIVE));await f.poll();assert.equal(f.manager.get(rule.id).nextResetAt,iso(BASE+FIVE));assert.equal(f.queue.list().length,1);
  f.setNow(BASE+FIVE);f.setQuota(quota(0,BASE+FIVE));await f.manager.tick();assert.equal(f.queue.list().length,2);
  await f.complete();for(let i=0;i<3;i++)await f.poll();assert.equal(f.queue.list().length,2);assert.equal(f.manager.get(rule.id).awaitingWindowBinding,true);
});

test('initial partial data with no reset waits until raw full before its single bootstrap',async t=>{
  const f=await fixture(t,{initialQuota:quota(2,null)});await f.manager.create(input());await f.manager.tick();assert.equal(f.queue.list().length,0);
  f.setQuota(quota(0,null));await f.poll();assert.equal(f.queue.list().length,1);
});

test('a full initial window with an expired reset bootstraps once and waits for binding',async t=>{
  const f=await fixture(t,{initialQuota:quota(0,BASE-1000)});const rule=await f.manager.create(input());await f.manager.tick();await f.complete();
  assert.equal(f.manager.get(rule.id).awaitingWindowBinding,true);await f.poll();assert.equal(f.queue.list().length,1);
});

test('small reset-time adjustments before the confirmed boundary do not count as a new cycle',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());await f.manager.tick();await f.complete();
  f.setQuota(quota(0,BASE+FIVE+30000));await f.poll();assert.equal(f.queue.list().length,1);assert.equal(f.manager.get(rule.id).nextResetAt,iso(BASE+FIVE+30000));
  f.setNow(BASE+FIVE);await f.manager.tick();assert.equal(f.queue.list().length,1);
  f.setNow(BASE+FIVE+30000);f.setQuota(quota(0,BASE+2*FIVE+30000));await f.manager.tick();assert.equal(f.queue.list().length,2);
});

test('after the old boundary an advanced reset confirms a new window even if other work consumed some quota',async t=>{
  const f=await fixture(t);await f.manager.create(input());await f.manager.tick();await f.complete();
  f.setNow(BASE+FIVE);f.setQuota(quota(5,BASE+2*FIVE));await f.manager.tick();assert.equal(f.queue.list().length,2);
});

test('a past boundary with unchanged partially used data does not prove a refill',async t=>{
  const f=await fixture(t);await f.manager.create(input());await f.manager.tick();await f.complete();
  f.setNow(BASE+FIVE);f.setQuota(quota(10,BASE+FIVE));await f.manager.tick();assert.equal(f.queue.list().length,1);
  f.setQuota(quota(0,BASE+FIVE));await f.poll();assert.equal(f.queue.list().length,2);
});

test('weekly or other quota denial blocks a full five-hour window',async t=>{
  const f=await fixture(t,{initialQuota:{...quota(),allowed:false,reason:'Weekly allowance exhausted.'}});await f.manager.create(input());await f.manager.tick();assert.equal(f.queue.list().length,0);
  f.setQuota(quota());await f.poll();assert.equal(f.queue.list().length,1);
});

test('unknown quota, malformed percentages and ambiguous five-hour buckets never trigger',async t=>{
  for(const candidate of [null,{allowed:true,windows:[]},{allowed:true,windows:[{usedPercent:0,windowDurationMins:null}]},
    ...[null,undefined,'0',-1,101,NaN,Infinity].map(value=>({allowed:true,windows:[{...quota().windows[0],usedPercent:value}]})),
    {allowed:true,windows:[{...quota().windows[0],resetsAt:'not-a-date'}]},
    {allowed:true,windows:[{...quota().windows[0],limitId:'one'},{...quota().windows[0],limitId:'two'}]},
    {allowed:true,windows:[quota().windows[0],{...quota().windows[0],kind:'secondary'}]}]){
    const f=await fixture(t,{initialQuota:candidate});const rule=await f.manager.create(input());await f.manager.tick();assert.equal(f.queue.list().length,0);assert.equal(f.manager.get(rule.id).status,'waiting_quota');
  }
});

test('multiple five-hour buckets remain ambiguous even when one is named codex',()=>{
  assert.equal(selectQuotaCycleWindow({windows:[...quota().windows,{...quota(50).windows[0],limitId:'model-alias'}]}),null);
  assert.equal(selectQuotaCycleWindow({windows:[{...quota().windows[0],limitId:'single-alias'}]}).limitId,'single-alias');
  assert.equal(selectQuotaCycleWindow({windows:[{...quota().windows[0],windowDurationMins:'300'}]}),null);
});

test('a pre-existing future task in the same conversation waits visibly without producing overdue children',async t=>{
  const f=await fixture(t);const prior=await f.queue.create({...input(),runAt:iso(BASE+3*FIVE)});const rule=await f.manager.create(input());await f.manager.tick();
  assert.equal(f.queue.list().length,1);assert.equal(f.manager.get(rule.id).status,'waiting_thread');
  f.setNow(BASE+2*FIVE);f.setQuota(quota(0,BASE+3*FIVE));await f.manager.tick();assert.equal(f.queue.list().length,1);
  await f.queue.cancel(prior.id);await f.poll();assert.equal(f.queue.list().length,2);assert.equal(f.manager.get(rule.id).activeTaskId,f.queue.list()[1].id);
});

test('a busy child crossing a refresh binds the actual dispatch window instead of emitting a catch-up child',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());await f.manager.tick();f.setBusy(true);await f.queue.tick();
  f.setNow(BASE+FIVE+30000);f.setQuota(quota(3,BASE+2*FIVE));await f.manager.tick();assert.equal(f.queue.list().length,1);assert.equal(f.manager.get(rule.id).lastTaskStatus,'waiting_thread');
  f.setBusy(false);await f.queue.tick();await f.poll();assert.equal(f.manager.get(rule.id).completedCycles,1);assert.equal(f.manager.get(rule.id).lastSentAt,iso(BASE+FIVE+30000));assert.equal(f.manager.get(rule.id).nextResetAt,iso(BASE+2*FIVE));
  await f.poll();assert.equal(f.queue.list().length,1);
});

test('an existing child waiting on quota prevents another cycle child',async t=>{
  const f=await fixture(t);await f.manager.create(input());await f.manager.tick();f.setQuota({...quota(100),allowed:false});await f.queue.tick();
  f.setNow(BASE+FIVE+30000);f.setQuota(quota(0,BASE+2*FIVE));await f.manager.tick();assert.equal(f.queue.list().length,1);
});

test('uncertain child submission disables the rule and cannot be resumed without reviewing the child',async t=>{
  const f=await fixture(t,{adapter:{async execute(){throw new Error('Transport lost after dispatch.');}}});const rule=await f.manager.create(input());await f.manager.tick();await f.complete();
  assert.equal(f.manager.get(rule.id).enabled,false);assert.equal(f.manager.get(rule.id).status,'needs_review');assert.equal(f.manager.get(rule.id).completedCycles,0);
  await assert.rejects(f.manager.resume(rule.id),{code:'cycle_needs_review'});f.setNow(BASE+3*FIVE);await f.manager.tick();assert.equal(f.queue.list().length,1);
});

test('a failed child pauses the loop and resume does not recreate that consumed window',async t=>{
  const f=await fixture(t,{adapter:{async execute(){return {status:'failed',error:'Fixture rejection.'};}}});const rule=await f.manager.create(input());await f.manager.tick();await f.complete();
  assert.equal(f.manager.get(rule.id).status,'error');assert.equal(f.manager.get(rule.id).completedCycles,0);await f.manager.resume(rule.id);await f.manager.tick();assert.equal(f.queue.list().length,1);
  f.setNow(BASE+FIVE);f.setQuota(quota(0,BASE+2*FIVE));await f.manager.tick();assert.equal(f.queue.list().length,2);
});

test('pause and resume control the pending child without resetting cycle identity',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());await f.manager.tick();const original=f.manager.get(rule.id);await f.manager.pause(rule.id);
  assert.equal(f.queue.list()[0].status,'paused');await f.restart();await f.manager.resume(rule.id);assert.equal(f.queue.list()[0].status,'scheduled');assert.equal(f.manager.get(rule.id).lastCycleKey,original.lastCycleKey);
  await f.manager.tick();assert.equal(f.queue.list().length,1);await f.complete();assert.equal(f.manager.get(rule.id).completedCycles,1);
});

test('pausing a running child only stops future cycles and deletion refuses to interrupt it',async t=>{
  const f=await fixture(t,{adapter:{async execute(task,{onTurnStarted}){await onTurnStarted('running-fixture');return {status:'running',turnId:'running-fixture'};}}});const rule=await f.manager.create(input());await f.manager.tick();await f.queue.tick();
  await f.manager.pause(rule.id);assert.equal(f.queue.list()[0].status,'running');assert.equal(f.manager.get(rule.id).enabled,false);
  await assert.rejects(f.manager.delete(rule.id),{code:'cycle_busy'});assert.equal(f.queue.list()[0].status,'running');assert.equal(f.manager.get(rule.id).enabled,false);
});

test('delete removes its unsubmitted pending child and prevents an old create request resurrecting the loop',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input({clientRequestId:'retry-created-rule'}));await f.manager.tick();const deleted=await f.manager.delete(rule.id);
  assert.equal(deleted.deleted,true);assert.equal(f.queue.list().length,0);assert.equal(f.manager.list().length,0);await f.restart();await assert.rejects(f.manager.create(input({clientRequestId:'retry-created-rule'})),{code:'creation_deleted'});
});

for(const action of ['delete','cancel'])test(`a manually ${action}d child is not recreated in its window`,async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());await f.manager.tick();const child=f.queue.list()[0];await f.queue[action](child.id);await f.poll();
  assert.equal(f.manager.get(rule.id).activeTaskId,null);const count=f.queue.list().length;await f.restart();await f.poll();assert.equal(f.queue.list().length,count);
  f.setNow(BASE+FIVE);f.setQuota(quota(0,BASE+2*FIVE));await f.manager.tick();assert.equal(f.queue.list().length,count+1);
});

test('an intent written before a crash creates its frozen child once after restart',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());f.manager._createChild=async()=>{throw new Error('Simulated crash before queue.create.');};
  await assert.rejects(f.manager.tick(),/Simulated crash/);const intent=f.manager.get(rule.id).dispatchIntent;assert.ok(intent);assert.equal(f.queue.list().length,0);
  await assert.rejects(f.manager.update(rule.id,{prompt:'Change during intent'}),{code:'cycle_busy'});await f.restart();await f.poll();assert.equal(f.queue.list().length,1);assert.equal(f.queue.list()[0].clientRequestId,intent.requestId);assert.equal(f.queue.list()[0].prompt,intent.input.prompt);
});

test('a crash after queue creation recovers the same paused child without resubmitting',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());const write=f.manager._writeStore.bind(f.manager);
  f.manager._writeStore=async()=>{if(f.manager.rules.some(item=>item.activeTaskId))throw new Error('Disk failure after child persisted.');return write();};
  await assert.rejects(f.manager.tick(),{code:'cycle_persist_failed'});assert.equal(f.queue.list().length,1);const child=f.queue.list()[0];assert.equal(child.status,'paused');
  await f.restart();await f.poll();assert.equal(f.queue.list().length,1);assert.equal(f.manager.get(rule.id).activeTaskId,child.id);assert.equal(f.manager.get(rule.id).enabled,false);
  await f.manager.resume(rule.id);assert.equal(f.queue.list()[0].id,child.id);assert.equal(f.queue.list()[0].status,'scheduled');
});

test('a deleted child tombstone after an intent crash suppresses that cycle instead of changing request ID',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());const write=f.manager._writeStore.bind(f.manager);
  f.manager._writeStore=async()=>{if(f.manager.rules.some(item=>item.activeTaskId))throw new Error('Crash after local queue write.');return write();};
  await assert.rejects(f.manager.tick());const child=f.queue.list()[0];await f.queue.delete(child.id);await f.restart();await f.poll();
  assert.equal(f.queue.list().length,0);assert.equal(f.manager.get(rule.id).activeRequestId,null);assert.equal(f.manager.get(rule.id).lastTaskStatus,'deleted');await f.poll();assert.equal(f.queue.list().length,0);
});

test('disk failure before dispatch intent fails closed until an explicit successful resume',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());const write=f.manager._writeStore.bind(f.manager);
  f.manager._writeStore=async()=>{if(f.manager.rules.some(item=>item.dispatchIntent))throw new Error('No disk space.');return write();};
  await assert.rejects(f.manager.tick(),{code:'cycle_persist_failed'});assert.equal(f.queue.list().length,0);assert.equal(f.manager.get(rule.id).lastCycleKey,null);
  f.manager._writeStore=write;await f.poll();assert.equal(f.queue.list().length,0);await f.manager.resume(rule.id);await f.manager.tick();assert.equal(f.queue.list().length,1);
});

test('concurrent client retries return one durable rule and concurrent ticks create one child',async t=>{
  const f=await fixture(t);const rules=await Promise.all(Array.from({length:4},()=>f.manager.create(input({clientRequestId:'same-client-retry'}))));assert.equal(new Set(rules.map(rule=>rule.id)).size,1);
  await Promise.all(Array.from({length:5},()=>f.manager.tick()));assert.equal(f.queue.list().length,1);
});

test('stop during a quota read prevents creating a new child',async t=>{
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});const wait=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{adapter:{async getQuota(){entered();await wait;return quota();}}});await f.manager.create(input());const ticking=f.manager.tick();await started;const stopping=f.manager.stop();release();await Promise.all([ticking,stopping]);assert.equal(f.queue.list().length,0);
});

test('editing a completed rule changes future preferences but preserves the consumed window',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());await f.manager.tick();await assert.rejects(f.manager.update(rule.id,{prompt:'new'}),{code:'cycle_busy'});await f.complete();
  const before=f.manager.get(rule.id);await f.manager.update(rule.id,{prompt:'Future content',threadId:'different-thread'});const after=f.manager.get(rule.id);assert.equal(after.generation,before.generation+1);assert.equal(after.cycleCursor,before.cycleCursor);
  await f.manager.tick();assert.equal(f.queue.list().length,1);f.setNow(BASE+FIVE);f.setQuota(quota(0,BASE+2*FIVE));await f.manager.tick();assert.equal(f.queue.list()[1].prompt,'Future content');
});

test('invalid persisted rules fail without replacing the original bytes',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());const valid=JSON.parse(await readFile(f.storePath,'utf8'));
  for(const modify of [document=>{document.version=999;},document=>{document.rules.push(structuredClone(document.rules[0]));},document=>{document.rules[0].completedCycles=-1;},document=>{document.rules[0].awaitingWindowBinding='yes';},document=>{document.rules[0].dispatchIntent={requestId:'foreign'};}]){
    const document=structuredClone(valid);modify(document);const bytes=JSON.stringify(document);await writeFile(f.storePath,bytes);
    const other=new QuotaCycleManager({storePath:f.storePath,queue:f.queue,adapter:f.adapter,clock:f.now});await assert.rejects(other.initialize());assert.equal(await readFile(f.storePath,'utf8'),bytes);
  }
  assert.ok(rule.id);
});

test('initial partial quota can detect a refresh already partly consumed by another user action',async t=>{
  const f=await fixture(t,{initialQuota:quota(20)});const rule=await f.manager.create(input());await f.manager.tick();
  f.setQuota(quota(19,BASE+FIVE+30000));await f.poll();assert.equal(f.queue.list().length,0);
  f.setNow(BASE+FIVE+30000);f.setQuota(quota(5,BASE+2*FIVE+30000));await f.manager.tick();assert.equal(f.queue.list().length,1);assert.equal(f.manager.get(rule.id).lastCycleKey,'bootstrap');
});

test('a real queue creation disk failure leaves no dispatchable ghost and retains its stable cycle intent',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());const write=f.queue._writeStore.bind(f.queue);
  f.queue._writeStore=async()=>{throw new Error('Queue file temporarily unwritable.');};await f.manager.tick();
  assert.equal(f.queue.list().length,0);assert.equal(f.manager.get(rule.id).status,'error');assert.equal(f.manager.get(rule.id).enabled,false);const request=f.manager.get(rule.id).dispatchIntent.requestId;
  f.queue._writeStore=write;await f.queue.tick();assert.equal(f.calls.execute.length,0);await f.manager.resume(rule.id);await f.manager.tick();assert.equal(f.queue.list()[0].clientRequestId,request);await f.queue.tick();assert.equal(f.calls.execute.length,1);
});

test('a queue implementation rejecting after a durable create has only its owned unsubmitted child paused',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());const create=f.queue.create.bind(f.queue);
  f.queue.create=async fields=>{await create(fields);throw new Error('Create result lost after the queue write.');};await f.manager.tick();
  assert.equal(f.queue.list().length,1);assert.equal(f.queue.list()[0].status,'paused');assert.equal(f.manager.get(rule.id).enabled,false);assert.ok(f.manager.get(rule.id).dispatchIntent);
  f.queue.create=create;await f.queue.tick();assert.equal(f.calls.execute.length,0);await f.manager.resume(rule.id);await f.queue.tick();assert.equal(f.calls.execute.length,1);
});

for(const action of ['pause','delete'])test(`${action} during an outstanding quota read prevents any child creation`,async t=>{
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});const wait=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{adapter:{async getQuota(){entered();await wait;return quota();}}});const rule=await f.manager.create(input());
  const ticking=f.manager.tick();await started;const actionResult=f.manager[action](rule.id);release();await Promise.all([ticking,actionResult]);
  assert.equal(f.queue.list().length,0);if(action==='pause')assert.equal(f.manager.get(rule.id).enabled,false);else assert.equal(f.manager.list().length,0);
});

test('tampered persisted intent targets and content are rejected without touching its file',async t=>{
  const f=await fixture(t);await f.manager.create(input());f.manager._createChild=async()=>{throw new Error('Crash with durable intent only.');};await assert.rejects(f.manager.tick());
  const valid=JSON.parse(await readFile(f.storePath,'utf8'));
  for(const [field,value] of [['threadId','different-target'],['model','different-model'],['prompt','different-content'],['effort','high'],['executionPath','C:\\Different'],['projectPath','C:\\Different'],['timeZone','UTC']]){
    const changed=structuredClone(valid);changed.rules[0].dispatchIntent.input[field]=value;const bytes=JSON.stringify(changed);await writeFile(f.storePath,bytes);
    const other=new QuotaCycleManager({storePath:f.storePath,queue:f.queue,adapter:f.adapter,clock:f.now});await assert.rejects(other.initialize(),/不一致/);assert.equal(await readFile(f.storePath,'utf8'),bytes);
  }
});

for(const action of ['pause','delete'])test(`${action} while the child queue write is outstanding pauses before a slow cycle checkpoint`,async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());
  let enterQueue,releaseQueue,enterCheckpoint,releaseCheckpoint;
  const queueEntered=new Promise(resolve=>{enterQueue=resolve;}),queueGate=new Promise(resolve=>{releaseQueue=resolve;});
  const checkpointEntered=new Promise(resolve=>{enterCheckpoint=resolve;}),checkpointGate=new Promise(resolve=>{releaseCheckpoint=resolve;});
  const queueWrite=f.queue._writeStore.bind(f.queue),cycleWrite=f.manager._writeStore.bind(f.manager);let held=false;
  f.queue._writeStore=async()=>{if(!held){held=true;enterQueue();await queueGate;}return queueWrite();};
  f.manager._writeStore=async()=>{if(f.manager.rules.some(item=>item.activeTaskId)){enterCheckpoint();await checkpointGate;}return cycleWrite();};
  const ticking=f.manager.tick();await queueEntered;const request=f.manager[action](rule.id);releaseQueue();await checkpointEntered;
  assert.equal(f.queue.list()[0].status,'paused');await f.queue.tick();assert.equal(f.calls.execute.length,0);
  releaseCheckpoint();await Promise.all([ticking,request]);assert.equal(f.calls.execute.length,0);
  if(action==='pause')assert.equal(f.manager.get(rule.id).enabled,false);else assert.equal(f.manager.list().length,0);
});

test('a failed first rule save can be retried after storage repair without an orphan rule or a restart',async t=>{
  const f=await fixture(t);const write=f.manager._writeStore.bind(f.manager);f.manager._writeStore=async()=>{throw new Error('First create denied.');};
  await assert.rejects(f.manager.create(input({clientRequestId:'retry-after-storage'})),{code:'cycle_persist_failed'});assert.equal(f.manager.list().length,0);assert.equal(f.queue.list().length,0);
  f.manager._writeStore=write;const rule=await f.manager.create(input({clientRequestId:'retry-after-storage'}));assert.equal(f.manager.list().length,1);assert.equal(f.manager.lastTickError,null);
  await f.manager.tick();assert.equal(f.queue.list().length,1);assert.equal(f.manager.get(rule.id).enabled,true);
});

test('a newer pause wins while an older resume is saving the rule',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());await f.manager.tick();await f.manager.pause(rule.id);
  let enterResume,releaseResume,enterDisabled,releaseDisabled;
  const resumeEntered=new Promise(resolve=>{enterResume=resolve;}),resumeGate=new Promise(resolve=>{releaseResume=resolve;});
  const disabledEntered=new Promise(resolve=>{enterDisabled=resolve;}),disabledGate=new Promise(resolve=>{releaseDisabled=resolve;});
  const write=f.manager._writeStore.bind(f.manager);let resumeHeld=false,disabledHeld=false;
  f.manager._writeStore=async()=>{
    if(f.manager.get(rule.id).enabled&&!resumeHeld){resumeHeld=true;enterResume();await resumeGate;}
    else if(resumeHeld&&!f.manager.get(rule.id).enabled&&!disabledHeld){disabledHeld=true;enterDisabled();await disabledGate;}
    return write();
  };
  const resuming=f.manager.resume(rule.id);await resumeEntered;const pausing=f.manager.pause(rule.id);releaseResume();await disabledEntered;
  assert.equal(f.queue.list()[0].status,'paused');await f.queue.tick();assert.equal(f.calls.execute.length,0);releaseDisabled();await Promise.all([resuming,pausing]);
  assert.equal(f.manager.get(rule.id).enabled,false);assert.equal(f.queue.list()[0].status,'paused');
});

test('a newer pause wins while an older resume is saving the child queue',async t=>{
  const f=await fixture(t);const rule=await f.manager.create(input());await f.manager.tick();await f.manager.pause(rule.id);
  let enterQueue,releaseQueue,enterDisabled,releaseDisabled;
  const queueEntered=new Promise(resolve=>{enterQueue=resolve;}),queueGate=new Promise(resolve=>{releaseQueue=resolve;});
  const disabledEntered=new Promise(resolve=>{enterDisabled=resolve;}),disabledGate=new Promise(resolve=>{releaseDisabled=resolve;});
  const queueWrite=f.queue._writeStore.bind(f.queue),ruleWrite=f.manager._writeStore.bind(f.manager);let held=false,disabledHeld=false;
  f.queue._writeStore=async()=>{if(!held){held=true;enterQueue();await queueGate;}return queueWrite();};
  f.manager._writeStore=async()=>{if(held&&!f.manager.get(rule.id).enabled&&!disabledHeld){disabledHeld=true;enterDisabled();await disabledGate;}return ruleWrite();};
  const resuming=f.manager.resume(rule.id);await queueEntered;const pausing=f.manager.pause(rule.id);
  await f.queue.tick();assert.equal(f.calls.execute.length,0);releaseQueue();await disabledEntered;
  assert.equal(f.queue.list()[0].status,'paused');await f.queue.tick();assert.equal(f.calls.execute.length,0);releaseDisabled();await Promise.all([resuming,pausing]);
  assert.equal(f.manager.get(rule.id).enabled,false);assert.equal(f.queue.list()[0].status,'paused');
});
