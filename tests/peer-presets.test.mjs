import { canonicalJson } from "../plugin/server/runtime/cli/jev.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { selectionFixture } from './helpers/seat-selection-fixture.mjs';
import { starterPeerOptions } from '../plugin/shared/runtime/peer-presets.ts';
import { PeerPool } from '../plugin/shared/contracts.ts';
import { presetChoiceSet } from '../plugin/server/runtime/cli/preset-routing.ts';
import { preflightPeerChoice, selectPeerSeat, revalidatePeerSelection } from '../plugin/server/runtime/cli/seat-selection.ts';
import { readCatalog, catalogBinding, validateCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { freshPresetPoolForm, peerPoolForm, presetMigrationForm, buildPeerPool, newCustomPreset } from '../plugin/client/manager-state.ts';
import { observePeerReference, reobservePeerReference } from '../plugin/server/peer-reference.ts';

function fixture(t, mode='off') {
 const f=selectionFixture(t,{mode});
 f.catalog.version=2;
 f.catalog.options=starterPeerOptions().map((o,i)=>({...o,provider:'codex',model:'fixture-'+i,enabled:true,
  modelProvider:i===4?'other':'primary',modeId:'full-access',notes:'PRIVATE_NOTE_'+i}));
 f.providers[0].models=f.catalog.options.map(o=>({id:o.model,thinkingOptions:[{id:'low'},{id:'high'},{id:'ultracode'}]}));
 f.request.routingContext={reference:{agentId:'writer',provider:'slp-devin-peer',model:'swe-2-high'}};
 f.savePool();
 return f;
}
const choice=(f,id,effort='high')=>presetChoiceSet(readCatalog(f.repository,f.home),'peer',f.providers,f.request.routingContext).choices.find(c=>c.optionId===id&&c.thinkingOptionId===effort);

test('new pools have exactly five parked defaults, with open IDs and descriptions',()=>{
 const form=freshPresetPoolForm(),built=buildPeerPool(form,()=>[]);
 assert.ok('pool' in built);assert.equal(built.pool.version,2);
 assert.deepEqual(built.pool.options.map(o=>o.displayName),['Fast','Balanced','Advanced','Frontier','Cross-provider']);
 assert.ok(built.pool.options.every(o=>!o.enabled&&o.provider===''&&o.model===''));
 assert.equal(built.pool.options[4].runtimeRule,'different-model-provider');
 assert.ok(PeerPool.safeParse(built.pool).success);assert.doesNotThrow(()=>validateCatalog(built.pool));
 assert.equal(peerPoolForm({...built.pool,options:[]}).seats.length,0,'saved empty pool is not reseeded');
 const custom=newCustomPreset(form.seats.map(s=>s.id));
 Object.assign(custom,{id:'standard-coding',displayName:'Tên tự do',description:'Mô tả tùy ý'});
 form.seats.push(custom);
 const open=buildPeerPool(form,()=>[]);assert.ok('pool' in open);assert.doesNotThrow(()=>validateCatalog(open.pool));
 assert.equal(open.pool.options.at(-1).displayName,'Tên tự do','v2 old reserved names are no longer reserved');
});

test('v1 migration is a preview, preserves IDs/bundles/fallback/notes/unknown fields, and keeps effort fixed',t=>{
 const f=selectionFixture(t,{count:1}),before=structuredClone(f.catalog);
 Object.assign(f.catalog,{extension:{retained:true},quotaFallback:{enabled:true,optionId:'first'}});
 Object.assign(f.catalog.options[0],{availability:'paused',roles:['peer','lead'],customField:'keep me'});
 const original=structuredClone(f.catalog),form=presetMigrationForm(original);
 const built=buildPeerPool(form,()=>[],new Map(original.options.map(o=>[o.id,o])),original);
 assert.ok('pool' in built);assert.deepEqual(f.catalog,original);assert.equal(before.version,1);
 const option=built.pool.options[0];assert.equal(option.id,'first');assert.equal(option.model,original.options[0].model);
 assert.deepEqual(option.features,original.options[0].features);assert.deepEqual(option.roles,original.options[0].roles);
 assert.equal(option.availability,'paused');assert.equal(option.notes,original.options[0].notes);
 assert.equal(option.customField,'keep me');assert.deepEqual(built.pool.extension,{retained:true});
 assert.deepEqual(built.pool.quotaFallback,original.quotaFallback);assert.deepEqual(option.effortPolicy,{kind:'fixed',thinkingOptionId:'high'});
 assert.ok(PeerPool.safeParse(built.pool).success);assert.doesNotThrow(()=>validateCatalog(built.pool));
 assert.ok(!PeerPool.safeParse({...original,options:[{...original.options[0],notes:''}]}).success,'v1 still requires its original notes');
});

test('discovery exposes model + pure effort pairs and all custom preset descriptions without private notes',async t=>{
 const f=fixture(t);f.catalog.options.push({...f.catalog.options[1],id:'human-special',displayName:'My adversary',description:'Find counterexamples in uncertain proofs',selectionHints:'Prefer concise evidence'});f.savePool();
 const reply=await preflightPeerChoice(f.request,f.providers);
 assert.equal(reply.operationAdmitted,false);assert.equal(reply.omittedCount,0);
 assert.equal(reply.choices.length,12);assert.ok(reply.choices.some(c=>c.optionId==='human-special'&&c.description.includes('counterexamples')));
 assert.ok(!JSON.stringify(reply).includes('PRIVATE_NOTE'));assert.ok(!reply.choices.some(c=>c.thinkingOptionId==='ultracode'));
 const low=choice(f,'frontier','low');assert.ok(low,'frontier is not fixed to high thinking');
 f.request.selection={optionId:'human-special',thinkingOptionId:'high'};
 const selected=await selectPeerSeat(f.request,f.deps);
 const bound=revalidatePeerSelection(f.request,selected,f.providers);
 assert.equal(bound.binding.thinkingOptionId,'high');assert.equal(bound.routing.optionId,'human-special');assert.equal(f.calls.fetch,0);
 assert.equal(selected.origin,'lead');
});

test('Lead discovery and Jev receive the same Human pool policy, sufficiency guidance and effort descriptions',async t=>{
 const f=fixture(t,'shadow');f.catalog.policy='Prefer bounded work on the lighter configured option; retain quality checks.';
 f.providers[0].models[1].label='Human-visible model';
 f.providers[0].models[1].description='A workhorse for bounded tasks';
 f.providers[0].models[1].thinkingOptions[0]={id:'low',label:'Light',description:'Less reasoning for settled steps'};
 f.savePool();
 const discovery=await preflightPeerChoice(f.request,f.providers);
 assert.equal(discovery.policy,f.catalog.policy);
 assert.match(discovery.selectionGuidance,/smallest sufficient/);
 const picked=discovery.choices.find(c=>c.optionId==='balanced'&&c.thinkingOptionId==='low');
 assert.equal(picked.effortLabel,'Light');assert.equal(picked.effortDescription,'Less reasoning for settled steps');
 assert.equal(picked.modelDescription,'A workhorse for bounded tasks');
 let body;const fetchImpl=async(url,init)=>{body=JSON.parse(init.body);return f.fetchImpl(url,init);};
 f.setChoice(picked.candidateId);f.request.selection={optionId:'balanced',thinkingOptionId:'low'};
 const selected=await selectPeerSeat(f.request,{...f.deps,decide:req=>import('../plugin/server/runtime/cli/jev-routing.ts').then(m=>m.routeDecide(req,{fetchImpl}))});
 assert.equal(body.state.policy,discovery.policy);assert.equal(body.state.selectionGuidance,discovery.selectionGuidance);
 assert.deepEqual(body.state.options,discovery.choices);
 assert.match(body.questions.route_option.instructions,/smallest sufficient/);
 assert.match(body.questions.route_option.criteria[picked.candidateId],/Less reasoning for settled steps/);
 assert.ok(!JSON.stringify(body).includes('PRIVATE_NOTE'));
 assert.equal(selected.selectionEvidence.policy,f.catalog.policy);
 assert.deepEqual(selected.selectionEvidence.choice,picked);
 assert.equal(selected.origin,'lead');assert.equal(selected.decisionResult.optionId,'balanced');
 const before=presetChoiceSet(readCatalog(f.repository,f.home),'peer',f.providers,f.request.routingContext).selectionSha256;
 f.providers[0].models[1].thinkingOptions[0].description='Changed host meaning';
 assert.notEqual(presetChoiceSet(readCatalog(f.repository,f.home),'peer',f.providers,f.request.routingContext).selectionSha256,before);
 assert.throws(()=>revalidatePeerSelection(f.request,selected,f.providers),/capabilities/);
});

test('one model with several effort pairs still requires selection; unknown orchestration is fixed-only',async t=>{
 const f=fixture(t);f.catalog.options=f.catalog.options.slice(0,1);f.savePool();
 assert.equal((await preflightPeerChoice(f.request,f.providers)).choices.length,2);
 await assert.rejects(selectPeerSeat(f.request,f.deps),/Multiple preset/);
 f.request.selection={optionId:'fast'};await assert.rejects(selectPeerSeat(f.request,f.deps),/including thinkingOptionId/);
 f.request.selection={optionId:'fast',thinkingOptionId:'ultracode'};await assert.rejects(selectPeerSeat(f.request,f.deps),/eligible preset/);
 f.catalog.options[0].effortPolicy={kind:'fixed',thinkingOptionId:'ultracode'};f.savePool();
 f.request.selection={optionId:'fast',thinkingOptionId:'ultracode'};
 assert.equal((await selectPeerSeat(f.request,f.deps)).route.thinkingOptionId,'ultracode');
});

test('cross-provider compares runtime families without vendor declarations or reference pool entries',async t=>{
 const f=fixture(t);f.catalog.options[4].displayName='Renamed alternative';
 f.catalog.options.forEach(o=>delete o.modelProvider);f.savePool();
 assert.ok(choice(f,'cross-provider'));
 f.request.routingContext.reference={agentId:'writer',provider:'slp-codex-lead',model:'unlisted-author-model'};
 let set=presetChoiceSet(f.catalog,'peer',f.providers,f.request.routingContext);
 assert.ok(!set.choices.some(c=>c.optionId==='cross-provider'));
 assert.ok(set.excluded.find(e=>e.optionId==='cross-provider').reasons.includes('same-provider'));
 f.request.routingContext={};set=presetChoiceSet(f.catalog,'peer',f.providers,{});
 assert.equal(set.choices.length,8);assert.ok(set.excluded.some(e=>e.reasons.includes('reference-provider-unknown')));
 f.request.routingContext={crossProvider:true,reference:{agentId:'writer',provider:'slp-devin-peer',model:'swe-2-high'}};
 set=presetChoiceSet(f.catalog,'peer',f.providers,f.request.routingContext);assert.equal(set.choices.length,10);
 assert.ok(set.choices.some(c=>c.optionId==='cross-provider'));
 const withWrapper=set.selectionSha256;
 f.request.routingContext.reference.provider='devin';
 assert.equal(presetChoiceSet(f.catalog,'peer',f.providers,f.request.routingContext).choices.length,10,'base provider and managed wrapper normalize alike');
 assert.notEqual(presetChoiceSet(f.catalog,'peer',f.providers,f.request.routingContext).selectionSha256,withWrapper,'raw reference observation remains pinned');
 f.request.routingContext.reference.provider='custom-unrecognized';
 assert.equal(presetChoiceSet(f.catalog,'peer',f.providers,f.request.routingContext).choices.length,0);
 f.request.routingContext.reference.provider='codex';
 f.catalog.options[4].modelProvider='other-vendor';
 assert.equal(presetChoiceSet(f.catalog,'peer',f.providers,f.request.routingContext).choices.length,0,'declared model vendors cannot bypass a same-runtime requirement');
});

test('armed Jev selects a custom preset + effort, receipts bind capabilities and descriptions',async t=>{
 const f=fixture(t,'armed');Object.assign(f.catalog.options[1],{id:'custom-critic',displayName:'Critic',description:'Challenge the premise',selectionHints:'Find counterexamples'});f.savePool();
 const picked=choice(f,'custom-critic','low');f.setChoice(picked.candidateId);
 const selected=await selectPeerSeat(f.request,f.deps);
 assert.equal(selected.route.optionId,'custom-critic');assert.equal(selected.route.thinkingOptionId,'low');
 assert.equal(f.calls.logical,1);assert.equal(f.calls.fetch,1);assert.equal(selected.origin,'jev');
 const bound=revalidatePeerSelection(f.request,selected,f.providers);assert.equal(bound.binding.thinkingOptionId,'low');
 assert.equal(f.calls.logical,1,'offline revalidation never re-decides');
 const reserialized=JSON.parse(canonicalJson(selected.route));
 assert.doesNotThrow(()=>catalogBinding(f.repository,'peer',f.providers,reserialized,f.home),'receipt dictionary key order is not semantics');
 const invalidEffort={...selected.route,thinkingOptionId:'high'};
 assert.throws(()=>catalogBinding(f.repository,'peer',f.providers,invalidEffort,f.home),/differs from armed/);
 f.providers[0].models[0].thinkingOptions.push({id:'medium'});
 assert.throws(()=>revalidatePeerSelection(f.request,selected,f.providers),/capabilities/);
 f.providers[0].models[0].thinkingOptions.pop();
 f.catalog.options[1].description='Changed guidance';f.savePool();
 assert.throws(()=>revalidatePeerSelection(f.request,selected,f.providers),/changed/);
});

test('shadow retains the independent effort pair; armed decline and mismatched effort fail closed',async t=>{
 const f=fixture(t,'shadow');f.setChoice(choice(f,'advanced','high').candidateId);
 await assert.rejects(selectPeerSeat(f.request,f.deps),/independent/);
 f.request.selection={optionId:'advanced',thinkingOptionId:'low'};
 const selected=await selectPeerSeat(f.request,f.deps);assert.equal(selected.route.thinkingOptionId,'low');
 assert.equal(selected.decisionResult.thinkingOptionId,'high');
 f.configure('armed');await assert.rejects(selectPeerSeat(f.request,f.deps),/differs from armed/);
 delete f.request.selection;f.setChoice('no-suitable-option');await assert.rejects(selectPeerSeat(f.request,f.deps),/declined/);
});

test('unsupported/missing capability and empty allowlist never fall back; large pools do not truncate',async t=>{
 const f=fixture(t);f.catalog.options[0].effortPolicy={kind:'select',allowed:['medium']};f.savePool();
 let set=presetChoiceSet(f.catalog,'peer',f.providers,f.request.routingContext);
 assert.ok(set.excluded.find(e=>e.optionId==='fast').reasons.includes('no-supported-allowed-effort'));
 f.catalog.options[0].effortPolicy={kind:'select',allowed:[]};assert.throws(()=>validateCatalog(f.catalog),/nonempty unique/);
 assert.ok(!PeerPool.safeParse(f.catalog).success);
 f.catalog.options[0].effortPolicy={kind:'select'};f.providers[0].models=[];
 await assert.rejects(preflightPeerChoice(f.request,f.providers),/No eligible/);
 const huge=fixture(t);huge.catalog.options=Array.from({length:40},(_,i)=>({...huge.catalog.options[0],id:'option-'+i}));huge.savePool();
 await assert.rejects(preflightPeerChoice(huge.request,huge.providers),/no candidates were truncated/);
});

test('reference seats are observed explicitly and a changed runtime invalidates the pin',async()=>{
 let model='author-model';const calls=[];
 const host={agents:{ref:id=>({refresh:async()=>{calls.push(id);return {agent:{id,provider:'slp-codex-peer',model}};}})}};
 assert.deepEqual(await observePeerReference(host),{});assert.equal(calls.length,0);
 const pin=await observePeerReference(host,{referenceAgentId:'author',crossProvider:true});
 assert.equal(pin.reference.agentId,'author');assert.equal(pin.reference.model,'author-model');
 await reobservePeerReference(host,pin);model='changed';await assert.rejects(reobservePeerReference(host,pin),/changed/);
 await assert.rejects(reobservePeerReference(host,{reference:{provider:'codex',model:'claimed'}}),/agent ID/);
});

test('v1 RPC schemas retain arbitrary extension fields instead of interpreting new v2 fields',t=>{
 const f=selectionFixture(t,{count:1});Object.assign(f.catalog.options[0],{displayName:{legacy:'opaque'},effortPolicy:'old-extension',runtimeRule:42});
 assert.deepEqual(PeerPool.parse(f.catalog).options[0].displayName,{legacy:'opaque'});
 assert.doesNotThrow(()=>validateCatalog(f.catalog));
});

test('v1 writer upgrade is read-only until explicit CAS conversion and can restore the original backup',async t=>{
 const {createStateStore}=await import('../plugin/server/state-store.ts');
 const {makeHome,targetOf}=await import('./helpers/plugin-doubles.mjs');
 const {readFileSync,mkdirSync}=await import('node:fs');const {join}=await import('node:path');
 const home=makeHome(t),store=createStateStore(),target=targetOf(home);
 const old={version:1,policy:'Keep the old pool',options:[{id:'custom',provider:'codex',model:'old-model',thinkingOptionId:'high',roles:['peer'],enabled:true,availability:'ready',suitableFor:['bounded work'],avoidFor:[],notes:'Keep private notes',opaque:{preserved:true},description:{old:'extension'}}],quotaFallback:{enabled:false,optionId:null}};
 const dir=join(home,'slp-runtime/state');mkdirSync(dir,{recursive:true});const file=join(dir,'peer-pool.json');const bytes=JSON.stringify(old,null,3)+'\n';writeFileSync(file,bytes);
 const read=()=>store.getPeerPool({schemaVersion:1,target});
 const seen=await read();assert.deepEqual(seen.pool,old);assert.equal(readFileSync(file,'utf8'),bytes,'get never rewrites old bytes');
 const form=presetMigrationForm(seen.pool),built=buildPeerPool(form,()=>[],new Map(old.options.map(o=>[o.id,o])),old);
 assert.ok('pool' in built);
 const converted=await store.setPeerPool({schemaVersion:1,target,pool:built.pool,expectedSha256:seen.sha256});
 assert.equal(converted.pool.version,2);assert.equal((await read()).pool.options[0].notes,'Keep private notes');
 await assert.rejects(store.setPeerPool({schemaVersion:1,target,pool:old,expectedSha256:seen.sha256}),/changed since/);
 const restored=await store.setPeerPool({schemaVersion:1,target,pool:old,expectedSha256:converted.sha256});
 assert.deepEqual(restored.pool,old);assert.deepEqual((await read()).pool,old);
});

test('installed-candidate native formation pins the returned preset effort and replays without another create',async t=>{
 const {placementFixture}=await import('./helpers/formation-placement-fixture.mjs');
 const f=placementFixture(t,{count:1});const o=f.catalog.options[0];
 f.catalog.version=2;Object.assign(o,{displayName:'User preset',description:'Bounded implementation',runtimeRule:'none',effortPolicy:{kind:'select'}});delete o.thinkingOptionId;f.savePool();
 f.host.providers.snapshot=async()=>({entries:[{provider:'slp-codex-peer',enabled:true,status:'ready',modes:[{id:'full-access'}],models:[{id:o.model,thinkingOptions:[{id:'low'},{id:'high'}]}]}]});
 const discovery=await f.run();assert.equal(discovery.state,'selection-required');assert.equal(discovery.choices.length,2);assert.equal(discovery.operationAdmitted,false);
 const req={...f.input,selection:{optionId:o.id,thinkingOptionId:'low'}};
 const out=await f.run(req);assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));
 assert.equal(out.result.routingSelection.origin,'lead');assert.equal(out.result.routingSelection.optionId,o.id);
 assert.equal(out.result.routingSelection.thinkingOptionId,'low');assert.equal(out.result.routingSelection.policy,f.catalog.policy);
 assert.equal(out.result.routingSelection.receiptOwnerAgentId,f.row.agentId);assert.equal(out.result.routingSelection.requestId,req.requestId);
 assert.equal(out.result.routingSelection.decisionReceiptSha256,null);
 assert.equal(out.phases.find(p=>p.name==='route-selected').value.selectionEvidence.choice.description,o.description);
 assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,1);
 assert.equal(f.hostCalls.find(c=>c.kind==='create').options.config.thinkingOptionId,'low');
 assert.equal((await f.run(req)).receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,1);
});

test('native cross-provider reference drift after create retains the child and withholds delivery',async t=>{
 const {placementFixture}=await import('./helpers/formation-placement-fixture.mjs');
 const f=placementFixture(t,{count:2});f.catalog.version=2;
 f.catalog.options.forEach((o,i)=>{Object.assign(o,{model:'fixture-'+i,displayName:'Preset '+i,description:'Independent judgment',modelProvider:i?'other':'primary',runtimeRule:i?'different-model-provider':'none',effortPolicy:{kind:'select'}});delete o.thinkingOptionId;});f.savePool();
 f.host.providers.snapshot=async()=>({entries:[{provider:'slp-codex-peer',enabled:true,status:'ready',modes:[{id:'full-access'}],models:f.catalog.options.map(o=>({id:o.model,thinkingOptions:[{id:'low'},{id:'high'}]}))}]});
 f.snapshots.set('writer',{id:'writer',provider:'slp-devin-peer',model:'swe-2-high'});
 const req={...f.input,routingRequirements:{referenceAgentId:'writer',crossProvider:true},selection:{optionId:'second',thinkingOptionId:'high'}};
 f.setAfterCreate(()=>{f.snapshots.get('writer').model='changed-model';});
 const out=await f.run(req);assert.equal(out.result.code,'ROUTE_DRIFT',JSON.stringify(out));assert.equal(out.result.agentId,'child');
 assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,1);assert.equal(out.phases.some(p=>p.name==='delivery-handed-off'),false);
 assert.equal((await f.run(req)).receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,1);
});

test('public route-choices CLI discovers off-mode v2 pairs and prepares with their pins without Jev',async t=>{
 const {execFileSync}=await import('node:child_process');const {join}=await import('node:path');const {fileURLToPath}=await import('node:url');
 const f=fixture(t,'off'),root=fileURLToPath(new URL('..',import.meta.url));
 const requestFile=join(f.dir,'choices.json');writeFileSync(requestFile,JSON.stringify({repository:f.repository,paseoHome:f.home,providers:f.providers,routingContext:f.request.routingContext}));
 const result=JSON.parse(execFileSync(process.execPath,[join(root,'bin/slp.mjs'),'route-choices',requestFile],{encoding:'utf8'}));
 assert.equal(result.policy,f.catalog.policy);assert.match(result.selectionGuidance,/smallest sufficient/);
 assert.equal(result.choices.length,10);assert.equal(result.omittedCount,0);assert.ok(!JSON.stringify(result).includes('PRIVATE_NOTE'));
 const picked=result.choices.find(c=>c.optionId==='advanced'&&c.thinkingOptionId==='low');
 const route={optionId:picked.optionId,thinkingOptionId:picked.thinkingOptionId,catalogSha256:result.catalogSha256,selectionSha256:result.selectionSha256,routingContext:result.routingContext};
 assert.equal(catalogBinding(f.repository,'peer',f.providers,route,f.home).binding.thinkingOptionId,'low');
 const schema=JSON.parse(execFileSync(process.execPath,[join(root,'bin/slp.mjs'),'route-choices','--schema'],{encoding:'utf8'}));
 assert.match(schema.description,/no Jev/);
});

test('v2 save guard rejects old/unverifiable active runtimes and rechecks an awaited binding',async()=>{
 const {guardPresetWrite}=await import('../plugin/server/peer-pool-compatibility.ts');
 let receipt={binding:{runtimePath:'/fixture-runtime',candidateSha256:'a'.repeat(64)},operations:[]};
 const read=()=>receipt;
 await assert.rejects(guardPresetWrite('/fixture',{read,observeRuntime:async()=>({candidateSha256:'a'.repeat(64),supported:false})}),/Update SLP runtime/);
 await assert.rejects(guardPresetWrite('/fixture',{read,observeRuntime:async()=>({candidateSha256:'b'.repeat(64),supported:true})}),/does not verify/);
 const recheck=await guardPresetWrite('/fixture',{read,observeRuntime:async()=>({candidateSha256:'a'.repeat(64),supported:true})});
 assert.doesNotThrow(recheck);receipt={...receipt,binding:{...receipt.binding,candidateSha256:'b'.repeat(64)}};assert.throws(recheck,/changed during/);
 receipt={binding:null,operations:[{outcome:'pending'}]};await assert.rejects(guardPresetWrite('/fixture',{read}),/runtime operation/);
});

test('v2 pool writer checks active runtime support before writing; v1 stays writable for restoration',async t=>{
 const {createStateStore}=await import('../plugin/server/state-store.ts');const {makeHome,targetOf}=await import('./helpers/plugin-doubles.mjs');
 const {readFileSync}=await import('node:fs');const {join}=await import('node:path');
 const home=makeHome(t),target=targetOf(home),store=createStateStore();
 const old={version:1,policy:'Legacy',options:[],quotaFallback:{enabled:false,optionId:null}};
 const saved=await store.setPeerPool({schemaVersion:1,target,pool:old,expectedSha256:null});
 const bytes=readFileSync(join(home,'slp-runtime/state/peer-pool.json'),'utf8');let checks=0;
 const guarded=createStateStore({guardPresetWrite:async()=>{checks++;throw new Error('Active runtime is v1-only');}});
 await assert.rejects(guarded.setPeerPool({schemaVersion:1,target,pool:{...old,version:2},expectedSha256:saved.sha256}),/v1-only/);
 assert.equal(checks,1);assert.equal(readFileSync(join(home,'slp-runtime/state/peer-pool.json'),'utf8'),bytes);
 await guarded.setPeerPool({schemaVersion:1,target,pool:old,expectedSha256:saved.sha256});assert.equal(checks,1,'v1 restoration never depends on v2 runtime support');
});

test('v2 save guard verifies the actual materialized candidate capability before accepting conversion',async t=>{
 const {guardPresetWrite}=await import('../plugin/server/peer-pool-compatibility.ts');const {install}=await import('../plugin/server/runtime/cli/package.ts');
 const {fileURLToPath}=await import('node:url');const {join}=await import('node:path');
 const f=fixture(t),candidate=join(f.dir,'current-candidate'),installed=install(fileURLToPath(new URL('..',import.meta.url)),candidate);
 const read=()=>({binding:{runtimePath:candidate,candidateSha256:installed.candidate.sha256},operations:[]});
 assert.doesNotThrow(await guardPresetWrite(f.home,{read}));
});
