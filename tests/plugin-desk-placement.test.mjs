import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeskSeatCreateInput } from '../plugin/shared/delegation.ts';
import { createDeskOperations } from '../plugin/server/desk-operation.ts';
import { createFormationPlanner } from '../plugin/server/desk-formation.ts';
import { placementFixture,fixtureGit } from './helpers/formation-placement-fixture.mjs';

test('placement schema preserves absent/default and strict caller/existing/worktree-gap inputs',()=>{
 const base={requestId:'r',role:'peer',taskLabel:'x',assignment:'read',grantRef:'human'};
 assert.deepEqual(DeskSeatCreateInput.parse(base),base);
 for(const placement of [{kind:'caller'},{kind:'existing',workspaceId:'target',reason:'lane'},
  {kind:'existing',cwd:'/lane',reason:'lane'},{kind:'worktree',reason:'lane',baseRef:'HEAD'}]){
  assert.deepEqual(DeskSeatCreateInput.parse({...base,placement}),{...base,placement});
  assert.deepEqual(DeskSeatCreateInput.parse({...base,role:'lead',placement}),{...base,role:'lead',placement});
 }
 for(const placement of [{kind:'existing',reason:'lane'},{kind:'existing',cwd:'relative',reason:'lane'},
  {kind:'caller',workspaceId:'override'},{kind:'existing',workspaceId:'target'},{kind:'existing',workspaceId:'target',reason:'lane',catalogFile:'/foreign'}]){
  assert.equal(DeskSeatCreateInput.safeParse({...base,placement}).success,false);
 }
});

for(const kind of ['caller','existing-id','existing-cwd','worktree-gap']){
 for(const topology of ['same-repo','foreign','nested','uncertainty']){
  test('placement matrix '+kind+' × '+topology,async t=>{
   const f=placementFixture(t,{budgets:{readMs:30,effectMs:30}});
   const cwd=topology==='foreign'?f.foreign:topology==='nested'?f.nested:kind==='caller'?f.repository:f.target;
   const placement=kind==='caller'?{kind:'caller'}:kind==='existing-id'?{kind:'existing',workspaceId:'target',reason:'isolated lane'}:
    kind==='existing-cwd'?{kind:'existing',cwd,reason:'isolated lane'}:{kind:'worktree',reason:'isolated lane'};
   if(kind==='caller'||kind==='existing-id')f.workspaces.get(kind==='caller'?'caller':'target').workspaceDirectory=cwd;
   if(topology==='uncertainty'){
    if(kind==='existing-cwd')f.setOpenFault(()=>new Promise(()=>{}));
    else f.setRefreshFault(()=>new Promise(()=>{}));
   }
   const input=DeskSeatCreateInput.parse({...f.input,placement}),out=await f.run(input);
   if(kind==='worktree-gap'){
    assert.equal(out.result.code,'CAPABILITY_GAP');assert.equal(out.phases.length,0);
    assert.equal(f.hostCalls.length,0);assert.equal(f.calls.logical,0);
   }else if(topology==='same-repo'){
    assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));
    assert.equal(out.result.workspaceId,kind==='caller'?'caller':kind==='existing-cwd'?'opened':'target');
    assert.equal(out.result.parent,'parent');assert.equal(f.snapshots.get('child').cwd,cwd);
    assert.equal(out.phases.length,kind==='existing-cwd'?11:9);
    assert.ok(out.result.delivery.prompt.includes('Repository: '+cwd));
    assert.ok(out.result.delivery.prompt.includes('Routing/protocol repository: '+f.repository));
    assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,1);
   }else if(topology==='uncertainty'){
    assert.equal(out.result.state,'placement-uncertain');assert.equal(out.result.sent,false);
    assert.equal(out.result.workspaceId,kind==='existing-cwd'?null:kind==='caller'?'caller':'target');
    assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,0);
   }else{
    assert.equal(out.result.code,'CAPABILITY_GAP',JSON.stringify(out));
    assert.equal(f.hostCalls.filter(c=>c.kind==='create'||c.kind==='open').length,0);
    assert.equal(f.calls.logical,0);
   }
   const calls=f.hostCalls.length,decisions=f.calls.logical,replay=await f.run(input);
   assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);assert.equal(f.calls.logical,decisions);
   assert.equal(f.hostCalls.some(c=>c.kind==='forbidden-workspace-create'),false);
  });
 }
}

for(const delivery of ['caller','server'])test('armed cwd-open '+delivery+' uses worst-case twelve phases without re-deciding',async t=>{
 const f=placementFixture(t,{mode:'armed',count:2});f.setChoice('second');
 const input={...f.input,delivery,placement:{kind:'existing',cwd:f.target,reason:'isolated lane'}};
 const out=await f.run(input);assert.equal(out.phases.length,12);assert.equal(f.calls.logical,1);
 assert.deepEqual(out.phases.map(p=>p.name),['placement-planned','workspace-open-issued','workspace-open-returned','target-observed',
  'route-issued','route-selected','prepared','create-issued','create-returned','create-observed','membership-observed',
  delivery==='caller'?'delivery-handed-off':'send-issued']);
 assert.equal(out.result.state,delivery==='caller'?'awaiting-caller-delivery':'host-accepted');
 assert.equal(f.hostCalls.filter(c=>c.kind==='send').length,delivery==='server'?1:0);
 const calls=f.hostCalls.length;const replay=await f.run(input);assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);
});

test('existing ID and cwd must agree; missing/archiving descriptor never falls back to open',async t=>{
 for(const fault of ['cwd','missing','archiving','foreign']){
  const f=placementFixture(t);if(fault==='missing')f.workspaces.delete('target');
  if(fault==='archiving')f.workspaces.get('target').archivingAt='2026-01-01T00:00:00Z';
  if(fault==='foreign')f.workspaces.get('target').workspaceDirectory=f.foreign;
  const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',cwd:fault==='cwd'?f.repository:f.target,reason:'lane'}});
  assert.equal(out.result.ok,false);assert.equal(f.hostCalls.some(c=>c.kind==='open'||c.kind==='create'),false);
 }
});

test('source pool and protocol win over missing target config; CLI JSON cannot supply trusted context',async t=>{
 const f=placementFixture(t);delete f.options[0].modeId;f.savePool();
 writeFileSync(join(f.repository,'.paseo-slp/workspace-protocol.md'),'---\nagent_mode: full-access\n---\nFixture protocol.\n');
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.state,'awaiting-caller-delivery');assert.equal(out.result.runtime.modeId,'full-access');
 const selected=out.phases.find(p=>p.name==='route-selected').value;
 assert.equal(selected.source.repository,f.repository);assert.equal(selected.source.catalogFile,f.poolPath);
 assert.equal(f.hostCalls.filter(c=>c.kind==='providers').every(c=>c.cwd===f.target),true);
 const module=await import(pathToFileURL(join(f.candidate,'plugin/server/runtime/cli/launch.ts')).href);
 const request={repository:f.target,workspaceId:'target',role:'peer',assignment:'read',providers:f.providers,
  route:selected.route,paseoHome:f.home,trustedContext:{routingRepository:f.repository,protocolRepository:f.repository}};
 assert.throws(()=>module.launchPlan(f.candidate,request));
 assert.throws(()=>module.launchPlan(f.candidate,{...request,route:{...selected.route,catalogFile:f.poolPath}}));
});

for(const config of ['slp-routing.json','workspace-protocol.md'])test('conflicting target '+config+' blocks before native allocation',async t=>{
 const f=placementFixture(t);mkdirSync(join(f.target,'.paseo-slp'),{recursive:true});writeFileSync(join(f.target,'.paseo-slp',config),'conflicting target');
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.code,'ROUTE_DRIFT');assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

for(const registration of ['missing','unregistered','revoked'])test('registration '+registration+' retains known child without runnable delivery',async t=>{
 const f=placementFixture(t,{registration});const input={...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'},delivery:'server'};
 const out=await f.run(input);assert.equal(out.result.state,'seat-pending');assert.equal(out.result.agentId,'child');assert.equal(out.result.sent,false);
 assert.equal(Object.hasOwn(out.result,'delivery'),false);assert.ok(out.result.assignmentEvidence.prompt);assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
 assert.equal(out.phases.at(-1).name,'membership-observed');assert.equal(out.phases.at(-1).value.registered,false);
 f.setRegistration('ready');const calls=f.hostCalls.length,replay=await f.run(input);
 assert.equal(replay.result.state,'seat-pending');assert.equal(f.hostCalls.length,calls);
});

for(const field of ['role','provider','createCwd','workspaceId'])test('membership exact '+field+' is required before delivery',async t=>{
 const f=placementFixture(t);f.setAfterCreate(()=>{f.members[0][field]='wrong';});
 const out=await f.run({...f.input,placement:{kind:'caller'},delivery:'server'});
 assert.equal(out.result.state,'seat-pending');assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
});

test('legacy omitted full pin bypasses membership even when registration is delayed',async t=>{
 const f=placementFixture(t,{registration:'missing'}),input={...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}};
 const out=await f.run(input);assert.equal(out.result.state,'awaiting-caller-delivery');assert.equal(out.result.agentId,'child');
 assert.deepEqual(out.phases.map(p=>p.name),['prepared','create-issued','create-returned','create-observed','delivery-handed-off']);
 assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
});

test('omitted legacy full pin keeps bytes/five phases; explicit caller is a distinct immutable body',async t=>{
 const f=placementFixture(t),input={...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}};
 const out=await f.run(input);assert.equal(out.phases.length,5);
 const dir=join(f.home,'slp-runtime/state/operations',readdirSync(join(f.home,'slp-runtime/state/operations'))[0]);
 const before=Object.fromEntries(readdirSync(dir).map(n=>[n,readFileSync(join(dir,n),'utf8')]));
 const calls=f.hostCalls.length,replay=await f.run(input);assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);
 assert.deepEqual(Object.fromEntries(readdirSync(dir).map(n=>[n,readFileSync(join(dir,n),'utf8')])),before);
 assert.equal((await f.run({...input,placement:{kind:'caller'}})).code,'IDEMPOTENCY_CONFLICT');
});

for(const last of ['workspace-open-issued','target-observed'])test('partial '+last+' never resumes or opens/creates again',async t=>{
 const f=placementFixture(t),input={...f.input,placement:{kind:'existing',cwd:f.target,reason:'lane'}};
 const identity={repoKey:'repo',membershipId:f.row.membershipId,agentId:'parent',kind:'seat-create',requestId:input.requestId};
 await createDeskOperations(f.deps.stableRoot).run(identity,input,async phase=>{phase(last,{retained:true});throw new Error('crash');});
 const out=await f.run(input);assert.equal(out.state,'partial');assert.equal(out.phases.length,1);assert.equal(f.hostCalls.length,0);assert.equal(f.calls.logical,0);
});

test('target HEAD drift after child creation retains ID and withholds delivery',async t=>{
 const f=placementFixture(t);f.setAfterCreate(()=>fixtureGit(f.target,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
  'commit','--allow-empty','-qm','target drift'));
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.code,'ROUTE_DRIFT');assert.equal(out.result.agentId,'child');assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,1);
 assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);assert.equal(Object.hasOwn(out.result,'delivery'),false);
});

// Exercise the public formation interface: a successful first qualification
// is not a lease across the actor guard awaited before the native effect.
for(const delivery of ['caller','server'])for(const stage of ['create','delivery'])for(const fault of ['revoked','drift']){
 test('qualification '+delivery+' '+stage+' fences '+fault+' between final workspace observations',async t=>{
  const f=placementFixture(t),plan=f.deps.plan,verify=f.placement.verify;
  const boundaryPlan=stage==='create'?2:3;
  let plans=0,observations=0,revoked=false;
  f.deps.plan=async(...args)=>{const out=await plan(...args);plans++;return out;};
  f.placement.verify=async(...args)=>{
   await verify(...args);
   if(plans===boundaryPlan && ++observations===1){
    if(fault==='revoked')revoked=true;
    else fixtureGit(f.target,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
     'commit','--allow-empty','-qm','drift across awaited guard');
   }
  };
  const refusal={ok:false,code:'STALE_EPOCH',message:'fixture actor revoked',recovery:'stop'};
  f.deps.guard=async()=>revoked?refusal:null;
  const input={...f.input,delivery,placement:{kind:'existing',workspaceId:'target',reason:'lane'}};
  const out=await f.run(input);
  assert.equal(out.result.code,fault==='revoked'?'STALE_EPOCH':'ROUTE_DRIFT',JSON.stringify(out));
  assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,stage==='create'?0:1);
  assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
  assert.equal(Object.hasOwn(out.result,'delivery'),false);
  assert.equal(out.phases.some(p=>p.name==='delivery-handed-off'||p.name==='send-issued'),false);
  if(stage==='delivery')assert.equal(out.result.agentId,'child');
  else assert.equal(Object.hasOwn(out.result,'agentId'),false);
  if(fault==='revoked')assert.deepEqual(out.result,stage==='create'?refusal:{...refusal,agentId:'child'});
  const calls=f.hostCalls.length,replay=await f.run(input);
  assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.hostCalls.length,calls);
 });
}

test('Lead existing workspace uses its saved profile and exact live role registration',async t=>{
 const f=placementFixture(t,{role:'lead'});const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.state,'awaiting-caller-delivery');assert.equal(out.result.runtime.provider,'slp-codex-lead/model/variant');
 assert.equal(out.result.workspaceId,'target');assert.equal(out.phases.length,8);assert.equal(f.calls.logical,0);
});

for(const topology of ['foreign','nested'])test('omitted caller placement still rejects '+topology+' repository before child create',async t=>{
 const f=placementFixture(t);f.workspaces.get('caller').workspaceDirectory=f[topology];
 const out=await f.run({...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}});
 assert.equal(out.result.code,'CAPABILITY_GAP');assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
 assert.match(out.result.message,/different Git repository/);
});

test('worktree gap wins over corrupt Jev and multiple-option discovery before every host effect',async t=>{
 const f=placementFixture(t,{mode:'error',count:2});
 const out=await f.run({...f.input,placement:{kind:'worktree',reason:'lane'}});
 assert.equal(out.result.code,'CAPABILITY_GAP');assert.equal(out.phases.length,0);assert.equal(f.hostCalls.length,0);assert.equal(f.calls.logical,0);
});

test('open returned ID remains retained when descriptor refresh later becomes uncertain',async t=>{
 const f=placementFixture(t,{budgets:{readMs:10,effectMs:10}});f.setRefreshFault(()=>new Promise(()=>{}));
 const out=await f.run({...f.input,placement:{kind:'existing',cwd:f.target,reason:'lane'}});
 assert.equal(out.result.state,'placement-uncertain');assert.equal(out.result.workspaceId,'opened');assert.equal(out.result.sent,false);
 assert.equal(out.phases.at(-1).name,'workspace-open-returned');assert.equal(f.hostCalls.some(c=>c.kind==='create'),false);
});

test('bound candidate lacking placement ABI refuses before open while omitted full runtime remains compatible',async t=>{
 const f=placementFixture(t),planner=createFormationPlanner({runtimePath:f.candidate,daemonHome:f.home,host:()=>f.host,
  importModule:async spec=>{const module=await import(spec);return {...module,FORMATION_CAPABILITIES:undefined};}});
 f.deps.plan=planner;f.deps.placementCapability=planner.placementCapability;
 const input={...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}};
 const gap=await f.run({...input,placement:{kind:'existing',cwd:f.target,reason:'lane'}});
 assert.equal(gap.code,'CAPABILITY_GAP');assert.equal(f.hostCalls.length,0);
 const legacy=await f.run(input);assert.equal(legacy.result.state,'awaiting-caller-delivery');assert.equal(legacy.phases.length,5);
});

for(const drift of ['directory','HEAD'])test('target '+drift+' drift during provider wait blocks child allocation',async t=>{
 const f=placementFixture(t);let reads=0;
 f.setProviderHook(()=>{if(++reads===3){
  if(drift==='directory')f.workspaces.get('target').workspaceDirectory=f.repository;
  else fixtureGit(f.target,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','pre-create drift');
 }});
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.code,'ROUTE_DRIFT');assert.equal(f.hostCalls.some(c=>c.kind==='create'),false);
});

test('pinned source configuration drift across provider wait blocks armed decision before network',async t=>{
 const f=placementFixture(t,{mode:'armed',count:2});f.setChoice('second');
 f.setProviderHook(()=>{f.options[0].notes='drift';f.savePool();});
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'}});
 assert.equal(out.result.code,'ROUTE_DRIFT');assert.equal(f.calls.logical,0);assert.equal(f.hostCalls.some(c=>c.kind==='create'),false);
});

test('Git identity drift during the awaited open guard refuses before SDK open',async t=>{
 const f=placementFixture(t);let guards=0;
 f.deps.guard=async()=>{if(++guards===3)writeFileSync(join(f.target,'.git'),'gitdir: '+join(f.foreign,'.git')+'\n');return null;};
 const out=await f.run({...f.input,placement:{kind:'existing',cwd:f.target,reason:'lane'}});
 assert.equal(out.result.code,'CAPABILITY_GAP');assert.equal(f.hostCalls.some(c=>c.kind==='open'||c.kind==='create'),false);
});

for(const placement of [undefined,{kind:'caller'}])test('hop2 placed Lead inherits main-checkout source for '+(placement?.kind??'omitted'),async t=>{
 const f=placementFixture(t);
 writeFileSync(join(f.repository,'.paseo-slp/workspace-protocol.md'),'---\nagent_mode: full-access\n---\nSource protocol.\n');
 // A conflicting user pool proves hop2 did not silently bind to it.
 writeFileSync(join(f.home,'slp-runtime/state/peer-pool.json'),JSON.stringify({...f.catalog,options:[{...f.options[0],id:'user-only'}]}));
 const lead=await f.run({...f.input,role:'lead',requestId:'first-hop',placement:{kind:'existing',workspaceId:'target',reason:'Lead lane'}});
 assert.equal(lead.result.state,'awaiting-caller-delivery');
 f.row.agentId=lead.result.agentId;f.row.createCwd=f.target;f.row.workspaceId='target';
 const input={...f.input,requestId:'second-hop',...(placement?{placement}:{})};
 const out=await f.run(input);assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));
 const chosen=out.phases.find(p=>p.name==='route-selected').value;
 assert.equal(chosen.source.repository,f.repository);assert.equal(chosen.source.scope,'repository');
 assert.equal(chosen.route.optionId,'first');assert.equal(out.result.parent,'child');assert.equal(out.result.agentId,'grandchild');
 assert.ok(out.result.delivery.prompt.includes('Use '+f.repository+'/.paseo-slp/workspace-protocol.md'));
 const calls=f.hostCalls.length;await f.run(input);assert.equal(f.hostCalls.length,calls);
});

test('hop2 full pin uses main source without new phase or membership gate',async t=>{
 const f=placementFixture(t,{registration:'missing'});f.row.createCwd=f.target;f.row.workspaceId='target';
 const out=await f.run({...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}});
 assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));assert.equal(out.phases.length,5);
});

for(const placement of [undefined,{kind:'caller'}])test('linked checkout without a trustworthy configuration source fails closed '+(placement?.kind??'omitted'),async t=>{
 const f=placementFixture(t);f.row.createCwd=f.target;f.row.workspaceId='target';
 writeFileSync(join(f.home,'slp-runtime/state/peer-pool.json'),JSON.stringify(f.catalog));
 rmSync(join(f.repository,'.paseo-slp'),{recursive:true,force:true});
 const out=await f.run({...f.input,...(placement?{placement}:{})});
 assert.equal(out.code??out.result?.code,'CAPABILITY_GAP',JSON.stringify(out));
 assert.match(out.message??out.result.message,/configuration source/i);assert.equal(f.hostCalls.some(c=>c.kind==='create'||c.kind==='open'),false);
});

test('hop2 source pins revalidate before armed network and before delivery',async t=>{
 for(const at of ['decision','delivery']){
  const f=placementFixture(t,{mode:'armed',count:2});f.row.createCwd=f.target;f.row.workspaceId='target';f.setChoice('second');
  const drift=()=>{f.options[0].notes='main drift';f.savePool();};
  if(at==='decision')f.setProviderHook(drift);else f.setAfterCreate(drift);
  const out=await f.run(f.input);assert.equal(out.result.code,'ROUTE_DRIFT',JSON.stringify(out));
  assert.equal(f.calls.logical,at==='decision'?0:1);assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
  assert.equal(Object.hasOwn(out.result,'delivery'),false);
 }
});

test('membership waits read-only for delayed registration then delivers once in phase budget',async t=>{
 const f=placementFixture(t,{registration:'missing'});f.deps.membershipWaitMs=200;
 const saved=f.deps.readMemberships;let reads=0;
 f.deps.readMemberships=()=>{if(++reads===2)f.members.push({...f.row,membershipId:'delayed',agentId:'child',role:'peer',provider:'slp-codex-peer',createCwd:f.target,workspaceId:'target'});return saved();};
 const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'},delivery:'server'});
 assert.equal(out.result.state,'host-accepted',JSON.stringify(out));assert.ok(reads>=2);assert.equal(out.phases.length,9);
 assert.equal(f.hostCalls.filter(c=>c.kind==='create').length,1);assert.equal(f.hostCalls.filter(c=>c.kind==='send').length,1);
});

test('automatic omitted request waits for registration; pending gives same-request receipt action',async t=>{
 const f=placementFixture(t,{registration:'missing'});let reads=0;f.deps.readMemberships=()=>{reads++;return [];};
 const input={...f.input,delivery:'server'};const out=await f.run(input);
 assert.equal(out.result.state,'seat-pending');assert.ok(reads>=2);assert.equal(out.phases.length,5);
 assert.deepEqual(out.result.nextAction,{tool:'slp_operation_get',arguments:{kind:'seat-create',requestId:input.requestId}});
 assert.match(out.result.readiness,/do not recreate/);const before=reads,calls=f.hostCalls.length;
 const receipt=createDeskOperations(f.deps.stableRoot).get({repoKey:'repo',membershipId:f.row.membershipId,agentId:f.row.agentId,kind:'seat-create',requestId:input.requestId});
 assert.equal(receipt.result.state,'seat-pending');await f.run(input);assert.equal(reads,before);assert.equal(f.hostCalls.length,calls);
});

test('legacy Lead omitted placement never waits or reads membership',async t=>{
 const f=placementFixture(t,{role:'lead',registration:'missing'});
 f.deps.readMemberships=()=>{throw new Error('legacy must not read memberships');};
 const out=await f.run(f.input);assert.equal(out.result.state,'awaiting-caller-delivery');assert.equal(out.phases.length,5);
});

test('no protocol pin means no instruction to read a nonexistent source protocol',async t=>{
 const f=placementFixture(t);const out=await f.run({...f.input,placement:{kind:'caller'}});
 assert.equal(out.result.state,'awaiting-caller-delivery');assert.ok(out.result.delivery.prompt.includes('Routing/protocol repository: '+f.repository));
 assert.equal(out.result.delivery.prompt.includes('Use '+f.repository+'/.paseo-slp/workspace-protocol.md'),false);
});


test('hop2 keeps a configured linked top rather than inheriting main configuration',async t=>{
 const f=placementFixture(t);mkdirSync(join(f.target,'.paseo-slp'),{recursive:true});
 writeFileSync(join(f.target,'.paseo-slp/slp-routing.json'),JSON.stringify({...f.catalog,options:[{...f.options[0],id:'local-only'}]}));
 f.row.createCwd=f.target;f.row.workspaceId='target';const out=await f.run(f.input);
 assert.equal(out.result.state,'awaiting-caller-delivery');const selected=out.phases.find(p=>p.name==='route-selected').value;
 assert.equal(selected.source.repository,f.target);assert.equal(selected.route.optionId,'local-only');
});

test('membership event arriving during a real wait delivers within the fixed twelve-phase budget',async t=>{
 const f=placementFixture(t,{mode:'armed',count:2,registration:'missing'});f.setChoice('second');f.deps.membershipWaitMs=300;
 let timer;f.setAfterCreate(()=>{timer=setTimeout(()=>f.members.push({...f.row,membershipId:'event-member',agentId:'child',role:'peer',provider:'slp-codex-peer',createCwd:f.target,workspaceId:'opened'}),40);});
 t.after(()=>clearTimeout(timer));const out=await f.run({...f.input,placement:{kind:'existing',cwd:f.target,reason:'lane'},delivery:'server'});
 assert.equal(out.result.state,'host-accepted',JSON.stringify(out));assert.equal(out.phases.length,12);
 assert.equal(f.hostCalls.filter(c=>c.kind==='send').length,1);
});

test('membership wait rechecks actor and target after delayed registration',async t=>{
 for(const drift of ['actor','HEAD']){
  const f=placementFixture(t,{registration:'missing'});f.deps.membershipWaitMs=200;let reads=0,changed=false;
  f.deps.readMemberships=()=>{if(++reads===2){f.members.push({...f.row,membershipId:'late',agentId:'child',role:'peer',provider:'slp-codex-peer',createCwd:f.target,workspaceId:'target'});
   changed=true;if(drift==='HEAD')fixtureGit(f.target,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','registration drift');}return f.members;};
  f.deps.guard=async()=>changed&&drift==='actor'?{ok:false,code:'AUTHORITY_REQUIRED',message:'parent revoked'}:null;
  const out=await f.run({...f.input,placement:{kind:'existing',workspaceId:'target',reason:'lane'},delivery:'server'});
  assert.equal(out.result.code,drift==='actor'?'AUTHORITY_REQUIRED':'ROUTE_DRIFT',JSON.stringify(out));assert.equal(out.result.agentId,'child');
  assert.equal(f.hostCalls.some(c=>c.kind==='send'),false);
 }
});
