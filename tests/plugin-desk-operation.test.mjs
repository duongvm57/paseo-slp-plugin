import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeskOperations } from '../plugin/server/desk-operation.ts';
import { canonicalSha256 } from '../plugin/server/config-view.ts';

function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'slp-operation-epoch-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
 const identity={repoKey:'repo',membershipId:'original',agentId:'same-agent',kind:'seat-create',requestId:'same-request'};
 return {root,identity,input:{work:'same'},ops:createDeskOperations(root)};
}
function legacy(f, identity=f.identity, complete=true) {
 // Exact pre-correction format-v1 address and record recipe. This exercises
 // surviving receipts rather than recreating them with today's journal.
 const path=join(f.root,'state/operations',canonicalSha256([identity.repoKey,identity.membershipId,identity.agentId,identity.kind,identity.requestId]));
 mkdirSync(path,{recursive:true,mode:0o700});
 const record=(name,body,previousSha256)=>{
  const row={schemaVersion:1,previousSha256,body,sha256:canonicalSha256({previousSha256,body})};
  writeFileSync(join(path,name),JSON.stringify(row),{mode:0o600}); return row.sha256;
 };
 const intent=record('intent.json',{identity,request:f.input},null);
 const issued=record('0.json',{name:'create-issued',value:{label:'original'}},intent);
 const result=complete?record('result.json',{state:'create-uncertain'},issued):null;
 const before=Object.fromEntries(readdirSync(path).map(name=>[name,readFileSync(join(path,name),'utf8')]));
 return {path,intent,issued,result,before};
}

for (const kind of ['seat-create','task-deliver']) {
 test(`stable ${kind} identity denies another epoch while preserving readable original caller evidence`,async t=>{
  const f=fixture(t); f.identity.kind=kind; let effects=0;
  const original=await f.ops.run(f.identity,f.input,async phase=>{phase('create-issued',{label:'original'});effects++;return {state:'create-uncertain'};});
  const rebound={...f.identity,membershipId:'rebound'};
  const denied=await f.ops.run(rebound,f.input,async()=>{effects++;return {state:'duplicate'};});
  assert.equal(denied.code,'ACTOR_MISMATCH'); assert.equal(effects,1);
  const read=f.ops.get(rebound); assert.equal(read.ok,true); assert.equal(read.callerEpochMatches,false);
  assert.deepEqual(read.identity,f.identity); assert.equal(read.receiptSha256,original.receiptSha256);
  assert.deepEqual(read.result,original.result);
  const replay=await f.ops.run(f.identity,f.input,async()=>assert.fail('resubmission'));
  assert.equal(replay.receiptSha256,original.receiptSha256); assert.equal(replay.callerEpochMatches,true);
  assert.equal((await f.ops.run(f.identity,{work:'changed'},async()=>assert.fail('changed effect'))).code,'IDEMPOTENCY_CONFLICT');
 });
}

for (const complete of [true,false]) {
 test(`legacy ${complete?'recorded':'partial'} receipt retains bytes/digest across addressing correction and epoch change`,async t=>{
  const f=fixture(t), prior=legacy(f, f.identity,complete);
  const read=f.ops.get({...f.identity,membershipId:'rebound'});
  assert.equal(read.ok,true); assert.equal(read.callerEpochMatches,false);
  assert.equal(read.receiptSha256,prior.result??prior.issued); assert.equal(read.state,complete?'recorded':'partial');
  assert.equal((await f.ops.run({...f.identity,membershipId:'rebound'},f.input,async()=>assert.fail('rebound effect'))).code,'ACTOR_MISMATCH');
  const replay=await f.ops.run(f.identity,f.input,async()=>assert.fail('legacy effect'));
  assert.equal(replay.receiptSha256,read.receiptSha256);
  assert.equal(readdirSync(join(f.root,'state/operations')).length,1,'no rewritten/copied receipt or namespace-reset admission');
  assert.deepEqual(Object.fromEntries(readdirSync(prior.path).map(name=>[name,readFileSync(join(prior.path,name),'utf8')])),prior.before);
 });
}

test('ambiguous legacy epochs never select a favorable receipt or admit another effect',async t=>{
 const f=fixture(t); legacy(f); legacy(f,{...f.identity,membershipId:'second-old'});
 assert.equal(f.ops.get(f.identity).code,'STATE_UNREADABLE');
 assert.equal((await f.ops.run(f.identity,f.input,async()=>assert.fail('ambiguous effect'))).code,'STATE_UNREADABLE');
 assert.equal(readdirSync(join(f.root,'state/operations')).length,2);
});

test('corrupt retained intent blocks absence inference and is never overwritten',async t=>{
 const f=fixture(t), prior=legacy(f); writeFileSync(join(prior.path,'intent.json'),'{partial');
 assert.equal((await f.ops.run({...f.identity,membershipId:'new'},f.input,async()=>assert.fail('corrupt effect'))).code,'STATE_UNREADABLE');
 assert.equal(readFileSync(join(prior.path,'intent.json'),'utf8'),'{partial');
});

test('concurrent epochs share one admission; a losing epoch cannot execute while the original is in flight',async t=>{
 const f=fixture(t); let release; const barrier=new Promise(resolve=>{release=resolve;}); let effects=0;
 const original=f.ops.run(f.identity,f.input,async phase=>{phase('create-issued',{label:'original'});effects++;await barrier;throw new Error('process loss');});
 const denied=await f.ops.run({...f.identity,membershipId:'other'},f.input,async()=>assert.fail('concurrent duplicate'));
 assert.equal(denied.code,'ACTOR_MISMATCH'); assert.equal(effects,1);
 const pending=f.ops.get({...f.identity,membershipId:'other'}); assert.equal(pending.state,'partial'); assert.equal(pending.phases.length,1);
 release(); await original;
 assert.equal((await f.ops.run(f.identity,f.input,async()=>assert.fail('crash resume'))).state,'partial');
});

test('foreign native caller cannot retrieve another actor receipt; a distinct native request remains independent',async t=>{
 const f=fixture(t); const original=await f.ops.run(f.identity,f.input,async()=>({state:'recorded'}));
 assert.equal(f.ops.get({...f.identity,agentId:'foreign'}).code,'EVIDENCE_INCOMPLETE');
 let calls=0; const other=await f.ops.run({...f.identity,requestId:'different'},f.input,async()=>{calls++;return {state:'new'};});
 assert.equal(calls,1); assert.notEqual(other.intentSha256,original.intentSha256);
});
