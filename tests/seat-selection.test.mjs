import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { preflightPeerChoice, selectPeerSeat, revalidatePeerSelection } from '../plugin/server/runtime/cli/seat-selection.ts';
import { canonicalJson } from '../plugin/server/runtime/cli/jev.ts';
import { hash } from '../plugin/server/runtime/cli/package.ts';
import { ROUTE_DECLINE_CANDIDATE, routeChoices, catalogBinding } from '../plugin/server/runtime/cli/routing.ts';
import { selectionFixture } from './helpers/seat-selection-fixture.mjs';
for (const mode of ['off','unconfigured']) {
 test(mode+' multiple options need a choice and never take-first',async t=>{
  const f=selectionFixture(t,{mode});const choice=await preflightPeerChoice(f.request);
  assert.equal(choice.state,'selection-required');assert.equal(choice.operationAdmitted,false);
  assert.deepEqual(choice.choices.map(c=>c.optionId),['first','second']);
  await assert.rejects(selectPeerSeat(f.request,f.deps),/multiple eligible/);
  assert.deepEqual(f.phases,[]);assert.equal(f.calls.logical,0);
  const selected=await selectPeerSeat({...f.request,selection:{optionId:'second'}},f.deps);
  assert.equal(selected.route.optionId,'second');assert.equal(selected.origin,'lead');
  assert.equal(selected.route.catalogSha256,f.sha());assert.equal(f.calls.logical,0);
 });
 test(mode+' sole eligible option pins complete settings without Jev',async t=>{
  const f=selectionFixture(t,{mode});f.options[0].enabled=false;f.savePool();
  assert.equal(await preflightPeerChoice(f.request),null);
  const selected=await selectPeerSeat(f.request,f.deps);
  assert.equal(selected.origin,'unique');assert.equal(selected.route.optionId,'second');
  const bundle=revalidatePeerSelection(f.request,selected,f.providers);
  assert.deepEqual(bundle.binding,{provider:'slp-codex-peer',model:'model/variant',modeId:'full-access',thinkingOptionId:'high',features:{fast_mode:true}});
  assert.equal(f.calls.logical,0);
 });
}
test('shadow requires independent selection even with a sole option',async t=>{
 const f=selectionFixture(t,{mode:'shadow',count:1});
 assert.equal((await preflightPeerChoice(f.request)).state,'selection-required');
 await assert.rejects(selectPeerSeat(f.request,f.deps),error=>{
  assert.match(error.message,/independent Lead selection/);assert.equal(error.reason,'selection-required');return true;
 });assert.equal(f.calls.logical,0);
});
for(const choice of ['second',ROUTE_DECLINE_CANDIDATE]){
 test('shadow retains independent first choice and full advisory '+choice,async t=>{
  const f=selectionFixture(t,{mode:'shadow'});f.setChoice(choice);const req={...f.request,selection:{optionId:'first'}};
  assert.equal(await preflightPeerChoice(req),null);const selected=await selectPeerSeat(req,f.deps);
  assert.equal(selected.route.optionId,'first');assert.equal(selected.origin,'lead');assert.equal(f.calls.logical,1);
  assert.equal(selected.route.decision.answers.route_option.choice,choice);
  assert.equal(selected.decisionResult.declined,choice===ROUTE_DECLINE_CANDIDATE);
  const bundle=revalidatePeerSelection(req,selected,f.providers);
  assert.equal(bundle.routing.jev.jevChoice,choice);assert.equal(f.calls.logical,1);
 });
}
test('armed default selects Jev choice once and revalidates without network',async t=>{
 const f=selectionFixture(t,{mode:'armed'});assert.equal(await preflightPeerChoice(f.request),null);
 const selected=await selectPeerSeat(f.request,f.deps);
 assert.equal(selected.route.optionId,'second');assert.equal(selected.origin,'jev');
 assert.equal(f.calls.logical,1);assert.equal(f.calls.fetch,1);assert.deepEqual(f.phases.map(p=>p.name),['route-issued']);
 assert.equal(selected.route.decision.context.armed,true);
 for(let i=0;i<3;i++)revalidatePeerSelection(f.request,selected,f.providers);
 assert.equal(f.calls.logical,1);
});
test('armed independent selection cannot override a different Jev answer',async t=>{
 const f=selectionFixture(t,{mode:'armed'});
 let answer;
 const decide=async req=>{answer=await f.decide(req);return answer;};
 await assert.rejects(selectPeerSeat({...f.request,selection:{optionId:'first'}},{...f.deps,decide}),/differs from armed/);
 assert.deepEqual(f.phases.map(phase=>phase.name),['route-issued','route-mismatch']);
 const retained=f.phases[1].value;
 assert.deepEqual(retained.selection,{optionId:'first'});
 for(const [key,value] of Object.entries(answer))assert.deepEqual(retained[key],value,key);
 assert.ok(Buffer.byteLength(JSON.stringify(retained))<=32768);
 assert.equal(f.calls.logical,1);
 assert.equal((await selectPeerSeat({...f.request,selection:{optionId:'second'}},f.deps)).route.optionId,'second');
});
for(const mode of ['armed','shadow']){
 for(const failure of ['network','timeout','schema','out-of-set','missing-key']){
  test(mode+' '+failure+' fails closed without selecting any fallback',async t=>{
   const f=selectionFixture(t,{mode});f.setFailure(failure);if(failure==='missing-key')rmSync(f.keyPath);
   const req={...f.request,...(mode==='shadow'?{selection:{optionId:'first'}}:{})};
   await assert.rejects(selectPeerSeat(req,f.deps));assert.equal(f.calls.logical,1);
   assert.equal(f.phases.length,1);assert.equal(f.phases[0].name,'route-issued');
  });
 }
}
test('armed decline is a rejection rather than sole or first-option fallback',async t=>{
 const f=selectionFixture(t,{mode:'armed',count:1});f.setChoice(ROUTE_DECLINE_CANDIDATE);
 await assert.rejects(selectPeerSeat(f.request,f.deps),/declined/);assert.equal(f.calls.logical,1);
});
for(const shape of ['none','selection']){
 test('corrupt configured Jev blocks '+shape+' before any decision, even with sole pool',async t=>{
  const f=selectionFixture(t,{mode:'error',count:1});const req={...f.request,...(shape==='selection'?{selection:{optionId:'first'}}:{})};
  await assert.rejects(preflightPeerChoice(req));await assert.rejects(selectPeerSeat(req,f.deps));
  assert.equal(f.calls.logical,0);assert.deepEqual(f.phases,[]);
 });
}
test('empty repository pool does not fall back to the user pool',async t=>{
 const f=selectionFixture(t,{count:0});writeFileSync(join(f.home,'slp-runtime/state/peer-pool.json'),JSON.stringify({schemaVersion:1,options:[]}));
 await assert.rejects(preflightPeerChoice(f.request),/no eligible/);
});
test('source and mode drift across network stop the dependent formation',async t=>{
 for(const drift of ['pool','config']){
  const f=selectionFixture(t,{mode:'armed'});
  const decide=async req=>{const answer=await f.decide(req);
   if(drift==='pool'){f.options[0].notes='drift';f.savePool();}else f.configure('shadow');return answer;};
  await assert.rejects(selectPeerSeat(f.request,{...f.deps,decide}),error=>error.code==='ROUTE_DRIFT');
 }
});
test('malformed or semantically stale Jev receipts cannot select a seat',async t=>{
 for(const field of ['hash','role','vocabulary','model','candidates','armed','envelope']){
  const f=selectionFixture(t,{mode:'armed'});
  const decide=async req=>{const answer=await f.decide(req);const receipt=answer.decision;
   if(field==='hash'){receipt.sha256='0'.repeat(64);return answer;}
   if(field==='role')receipt.context.role='lead';
   if(field==='vocabulary')receipt.context.vocabularyVersion='old';
   if(field==='model')receipt.model='typesafe/jev-0.1';
   if(field==='candidates')receipt.context.candidates=['first'];
   if(field==='armed')receipt.context.armed=false;
   if(field==='envelope')answer.optionId='first';
   const {sha256,...unsigned}=receipt;receipt.sha256=hash(canonicalJson(unsigned));return answer;};
  await assert.rejects(selectPeerSeat(f.request,{...f.deps,decide}),undefined,field);
 }
});
test('choice preflight reports omitted candidates and bounds bytes without inventing a selection',async t=>{
 const f=selectionFixture(t,{count:40});const choice=await preflightPeerChoice(f.request);
 assert.equal(choice.choices.length,32);assert.equal(choice.omittedCount,8);assert.ok(Buffer.byteLength(JSON.stringify(choice))<=32768);
 f.options.forEach(o=>{o.suitableFor=['x'.repeat(40000)];});f.savePool();
 await assert.rejects(preflightPeerChoice(f.request),error=>error.code==='REQUEST_TOO_LARGE');
});
test('full decision exceeding phase allowance refuses without discarding receipt',async t=>{
 const f=selectionFixture(t,{mode:'armed'});const decide=async req=>{const answer=await f.decide(req);answer.warnings=['x'.repeat(40000)];return answer;};
 await assert.rejects(selectPeerSeat(f.request,{...f.deps,decide}),error=>error.code==='REQUEST_TOO_LARGE');assert.equal(f.phases.length,1);
});
test('armed mismatch refuses oversized evidence before retaining any answer',async t=>{
 const f=selectionFixture(t,{mode:'armed'});
 const decide=async req=>{const answer=await f.decide(req);answer.warnings=['x'.repeat(40000)];return answer;};
 await assert.rejects(selectPeerSeat({...f.request,selection:{optionId:'first'}},{...f.deps,decide}),error=>error.code==='REQUEST_TOO_LARGE');
 assert.deepEqual(f.phases.map(phase=>phase.name),['route-issued']);
 assert.equal(f.calls.logical,1);
});
test('armed mismatch does not retain an invalid decision or inconsistent envelope',async t=>{
 for(const field of ['hash','envelope']){
  const f=selectionFixture(t,{mode:'armed'});
  const decide=async req=>{const answer=await f.decide(req);
   if(field==='hash')answer.decision.sha256='0'.repeat(64);else answer.optionId='first';
   return answer;};
  await assert.rejects(selectPeerSeat({...f.request,selection:{optionId:'first'}},{...f.deps,decide}));
  assert.deepEqual(f.phases.map(phase=>phase.name),['route-issued']);
 }
});

for (const mode of ['unconfigured', 'off', 'shadow', 'armed']) {
 test('v2 '+mode+' rejects ambiguous/ineligible pairs before phases or Jev', async t => {
  const f=selectionFixture(t,{mode,count:1});
  f.catalog.version=2;
  Object.assign(f.options[0],{displayName:'Fixture',description:'Bounded coding',effortPolicy:{kind:'select'},runtimeRule:'none'});
  delete f.options[0].thinkingOptionId;
  f.providers[0].models=[{id:'model/variant',thinkingOptions:[{id:'low'},{id:'high'}]}];f.savePool();
  for (const [selection,reason] of [
   [{optionId:'first'},'effort-required'],
   [{optionId:'first',thinkingOptionId:'unsupported'},'pair-ineligible'],
   [{optionId:'missing'},'pair-ineligible'],
  ]) {
   const req={...f.request,selection};
   const verify=error=>{assert.equal(error.code,'INVALID_RECORD');assert.equal(error.reason,reason);if(reason==='effort-required')assert.deepEqual(error.eligibleEfforts,['low','high']);return true;};
   await assert.rejects(preflightPeerChoice(req,f.providers),verify);
   await assert.rejects(selectPeerSeat(req,f.deps),verify);
   assert.deepEqual(f.phases,[]);assert.equal(f.calls.logical,0);
  }
  if(mode==='armed'||mode==='shadow')f.configure('off');
  const pair={...f.request,selection:{optionId:'first',thinkingOptionId:'low'}};
  assert.equal(await preflightPeerChoice(pair,f.providers),null);
  assert.equal((await selectPeerSeat(pair,f.deps)).route.thinkingOptionId,'low');
  f.catalog.options[0].effortPolicy={kind:'fixed',thinkingOptionId:'high'};f.savePool();
  const sole={...f.request,selection:{optionId:'first'}};
  assert.equal(await preflightPeerChoice(sole,f.providers),null);
  assert.equal((await selectPeerSeat(sole,f.deps)).route.thinkingOptionId,'high');
 });
}

for (const mode of ['unconfigured','off','shadow','armed']) {
 for (const failure of ['disabled-pool','missing-model','no-allowed-effort','selected-disabled','selected-missing-model','same-provider']) {
  test('v2 '+mode+' '+failure+' classifies empty selected pairs without changing offline errors',async t=>{
   const f=selectionFixture(t,{mode,count:2});f.catalog.version=2;
   for(const option of f.options){
    Object.assign(option,{displayName:'Fixture',description:'Bounded coding',effortPolicy:{kind:'select'},runtimeRule:'none'});
    delete option.thinkingOptionId;
   }
   f.providers[0].models=[{id:'model/variant',thinkingOptions:[{id:'low'},{id:'high'}]}];
   if(failure==='disabled-pool')f.options.forEach(o=>o.enabled=false);
   if(failure==='missing-model')f.providers[0].models=[];
   if(failure==='no-allowed-effort')f.options.forEach(o=>o.effortPolicy.allowed=['medium']);
   if(failure==='selected-disabled')f.options[0].enabled=false;
   if(failure==='selected-missing-model')f.options[0].model='PRIVATE_MISSING_MODEL';
   if(failure==='same-provider')f.request.routingContext={crossProvider:true,reference:{provider:'slp-codex-peer',model:'writer'}};
   f.savePool();const req={...f.request,selection:{optionId:'first'}};
   const verify=e=>{assert.equal(e.name,'SeatSelectionError');assert.equal(e.reason,'no-eligible-pairs');return true;};
   await assert.rejects(preflightPeerChoice(req,f.providers),verify);
   await assert.rejects(selectPeerSeat(req,f.deps),verify);
   assert.deepEqual(f.phases,[]);assert.equal(f.calls.logical,0);
   if(!failure.startsWith('selected-')){
    assert.throws(()=>routeChoices({...f.request,providers:f.providers}),e=>e.name==='Error'&&/No eligible preset/.test(e.message));
    assert.throws(()=>catalogBinding(f.repository,'peer',f.providers,{optionId:'first',catalogSha256:f.sha(),selectionSha256:'0'.repeat(64),thinkingOptionId:'low',routingContext:f.request.routingContext},f.home),e=>e.name==='Error'&&/No eligible preset/.test(e.message));
   }
  });
 }
}

test('ambiguous effort metadata exposes only a bounded subset of public IDs for the requested option',async t=>{
 const f=selectionFixture(t,{mode:'armed',count:2});f.catalog.version=2;
 for(const option of f.options){Object.assign(option,{displayName:'PRIVATE_LABEL',description:'PRIVATE_DESCRIPTION',effortPolicy:{kind:'select'},runtimeRule:'none'});delete option.thinkingOptionId;}
 f.options[1].model='other';
 const efforts=['a'.repeat(200),'b'.repeat(200)];
 f.providers[0].models=[{id:'model/variant',thinkingOptions:efforts.map(id=>({id,metadata:{kind:'effort'}}))},{id:'other',thinkingOptions:[{id:'PRIVATE_OTHER_EFFORT',metadata:{kind:'effort'}}]}];f.savePool();
 const req={...f.request,selection:{optionId:'first'}};
 await assert.rejects(preflightPeerChoice(req,f.providers),e=>{
  assert.equal(e.reason,'effort-required');assert.deepEqual(e.eligibleEfforts,[efforts[0]]);
  assert.ok(Buffer.byteLength(JSON.stringify(e.eligibleEfforts))<=384);assert.doesNotMatch(JSON.stringify(e.eligibleEfforts),/PRIVATE/);return true;
 });
 assert.equal(f.calls.logical,0);assert.deepEqual(f.phases,[]);
});
