// Split from tests/plugin-desk-task-execution.test.mjs (part 3 of 4,
// duration-balanced; see tests/helpers/task-execution-fixtures.mjs for the
// shared fixtures). Every test of the original suite lives in exactly one
// part, verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import {
  adapterPaths, applyDeltaToTarget, backupDeltaPaths, computeDelta,
  constrainDelta, expectedStageMap, materializeIsolatedPlacement,
  materializeStage, restoreFromBackup, scanUnsupported, stageMatches,
  threeWay, removeIsolatedPlacement, verifyBackupIntegrity, collectCleanupInventoryBytes,
} from '../plugin/server/desk-task-execution-git.ts';
import {
  boundedArgv, createContentMapMeasure, createDirectMeasure,
  createTaskFsIo, createTaskGitIo, effectIdentity, sha256Hex, measureMapSha256,
} from '../plugin/server/desk-task-execution-host.ts';
import {
  createTaskHostEventObserver, createTaskObserver,
  runTaskDispatch, runTaskIntegration, runTaskReconciliation, subRequestId,
} from '../plugin/server/desk-task-execution.ts';
import {
  latestTask, latestTaskEntity, runTaskCommand, runTaskEffect,
} from '../plugin/server/desk-task.ts';
import { createDeskStore, repoKeyFor } from '../plugin/server/desk-store.ts';
import { createDeskSeat, DESK_TASK_CREATE_TICKET_KEY } from '../plugin/server/desk-seat.ts';
import { createRoleInjection } from '../plugin/server/role-injection.ts';
import { fileURLToPath } from 'node:url';
import { runAssignmentRegister, runHandbackSubmit } from '../plugin/server/desk-handback.ts';
import { runScopeDeclare, runScopeTransition } from '../plugin/server/desk-scope.ts';
import { snapshot } from '../plugin/server/runtime/cli/package.ts';


import { GIT_ENV, git, world, mechanicalDispatch, mechanicalIntegration, evolveSource, REPO_KEY, NOW, uuid, fixtureCtx, coreDouble, fixtureDeps, fixtureLedger, fixtureNativeCreateRequest, fixtureHost, dispatchBase, bootstrapInput, reuseFixture, reuseInput, stageFixture, taskWithInjectedEffect, REAL_REPO, realMember, realDesk, taskSpec, realLifecycle, observeAndRuleTask, integrationRequest, fixtureCleanup, completeIntegration, scopeFor, assertRecoveryTargetFenced, correctionStaged, c2Staged, c2LandResolved, withoutBootstrapIo, pointerCleanupCut } from './helpers/task-execution-fixtures.mjs';

for(const basis of ['land-recovery','stage-only','issued-land'])test('C2 real Core finite continuation measures full '+basis+' request/row costs',async t=>{
  const {d,result,actionId}=await c2Staged(t);
  let issuedStart=null;
  const effect=d.deps.task.runTaskEffect;
  if(basis==='issued-land')d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    if(input.operation==='observe'&&input.receipt?.phase==='land'){issuedStart=d.ledger();assert.equal(latestTaskEntity(issuedStart,actionId).state,'issued');}
    return effect(ctx,input,deps);
  }};
  if(basis!=='stage-only')assert.equal((await runTaskIntegration(d.ctx,integrationRequest(d,result,'land','cost-land',actionId),d.deps)).landed,true);
  d.deps.task={...d.deps.task,runTaskEffect:effect};
  const start=issuedStart??d.ledger(),row=latestTaskEntity(d.ledger(),actionId),fs=d.deps.fs,gitIo=d.deps.git;
  if(basis!=='stage-only')assert.equal((await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','cost-land-resolution',actionId),d.deps)).recoveryClassification,'full-applied');
  const candidatePath=join(row.stageDir,'..','cleanup-account.v1.json');
  let proofWrites=0,stageRemoves=0,backupRemoves=0;
  d.deps.fs={...fs,writeFile:(path,bytes,mode)=>{
    if(path===candidatePath){proofWrites++;if(proofWrites===1)throw new Error('first verification persistence interrupted');}
    return fs.writeFile(path,bytes,mode);
  },rmrf:path=>{
    if(path===row.recoveryPlan?.backupDir){
      backupRemoves++;
      if(backupRemoves===1){
        const manifest=JSON.parse(readFileSync(row.recoveryPlan.manifestPath,'utf8'));
        fs.rmrf(join(path,manifest.entries.find(entry=>entry.existed).blobKey));
        throw new Error('first backup cycle stopped after admitted partial deletion');
      }
    }
    return fs.rmrf(path);
  }};
  d.deps.git={...gitIo,worktreeRemove:async(...args)=>{
    stageRemoves++;
    if(stageRemoves===1){fs.rmrf(join(row.stageDir,'changed.txt'));throw new Error('first stage cycle stopped after admitted partial deletion');}
    return gitIo.worktreeRemove(...args);
  }};
  const steps=basis==='stage-only'?4:6;
  for(let cycle=0;cycle<steps;cycle++){
    const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge',`cost-${basis}-${cycle}`,actionId),d.deps);
    assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.discharged,cycle===steps-1);
    if(cycle<2){assert.ok(existsSync(row.stageDir));if(row.recoveryPlan)assert.ok(existsSync(row.recoveryPlan.backupDir));}
  }
  const finish=d.ledger();
  assert.equal(proofWrites,2);assert.equal(stageRemoves,2);assert.equal(backupRemoves,basis==='stage-only'?0:2);
  assert.equal(finish.requests.length-start.requests.length,basis==='issued-land'?20:basis==='land-recovery'?19:12,'actual emitted requests include each supported landing observation/resolution and both TOTAL cycles');
  assert.equal(finish.taskEntries.length-start.taskEntries.length,basis==='issued-land'?22:basis==='land-recovery'?21:13,'actual emitted rows include only exact resource-release revisions');
  assert.ok(row.resourceIds.every(id=>latestTaskEntity(finish,id).disposition==='released'));
  const rows=finish.taskEntries.slice(start.taskEntries.length);
  assert.ok(rows.every(entry=>Buffer.byteLength(JSON.stringify(entry))<=32768));
  assert.ok(rows.filter(entry=>entry.kind==='action').every(entry=>entry.receipt?.cleanupObservation?.resources.every(resource=>!Object.hasOwn(resource,'entries'))??true),'ledger observations contain compact inventories');
  if(row.recoveryPlan){assert.ok(existsSync(row.recoveryPlan.manifestPath));assert.ok(existsSync(row.recoveryPlan.targetOriginal.path));}
});


for(const lost of [false,true])test('C2 partial stage deletion '+(lost?'with lost observation':'with held observation')+' uses only exact issued provenance',async t=>{
  const {d,result,actionId}=await c2LandResolved(t),row=latestTaskEntity(d.ledger(),actionId),plan=row.recoveryPlan;
  assert.equal((await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','stage-cut-verify',actionId),d.deps)).discharged,false);
  const gitIo=d.deps.git,effect=d.deps.task.runTaskEffect,initial=d.ledger(),pointer=join(plan.stageDir,'.git');
  const originalBytes=readFileSync(pointer),originalMode=lstatSync(pointer).mode&0o777;
  const originalFs=d.deps.fs;let restores=0;
  d.deps.fs={...originalFs,writeFileExclusive:(path,bytes,mode)=>{
    restores++;assert.equal(path,pointer);assert.deepEqual(bytes,originalBytes);assert.equal(mode,originalMode);
    const issued=latestTaskEntity(d.ledger(),actionId);assert.equal(issued.state,'issued');assert.equal(issued.body.permit.ordinal,2);
    return originalFs.writeFileExclusive(path,bytes,mode);
  }};
  let removes=0;
  d.deps.git={...gitIo,worktreeRemove:async()=>{removes++;d.deps.fs.rmrf(join(plan.stageDir,'.git'));throw new Error('fixture stage pointer deleted before cleanup interruption');}};
  if(lost)d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>input.operation==='observe'&&input.receipt?.cleanupStep==='remove-resource'
    ?{ok:false,code:'CAPABILITY_GAP',message:'fixture lost partial stage observation',recovery:'explicit reconcile'}:effect(ctx,input,deps)};
  const request=integrationRequest(d,result,'discharge','stage-cut-remove',actionId);
  const cut=await runTaskIntegration(d.ctx,request,d.deps);assert.notEqual(cut.discharged,true);assert.equal(removes,1);
  assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));assert.equal(existsSync(join(plan.stageDir,'.git')),false);
  assert.ok(row.resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='retained'));
  const beforeReplay=d.ledger().revision;
  d.deps.git=new Proxy(gitIo,{get:()=>()=>assert.fail('historical cleanup replay must not inspect Git')});
  const fs=d.deps.fs,measure=d.deps.measure,host=d.deps.host;
  d.deps.fs=new Proxy(fs,{get:()=>()=>assert.fail('historical cleanup replay must not inspect filesystem')});
  d.deps.measure=async()=>assert.fail('historical cleanup replay must not measure');
  d.deps.host=async()=>assert.fail('historical cleanup replay must not inspect SDK');
  d.deps.task={...d.deps.task,runTaskEffect:effect};
  const replay=await runTaskIntegration(d.ctx,request,d.deps);
  assert.equal(replay.perform,false,JSON.stringify(replay));assert.equal(d.ledger().revision,beforeReplay);
  const changed=await runTaskIntegration(d.ctx,{...request,expectedActionRevision:request.expectedActionRevision+1},d.deps);
  assert.equal(changed.ok,false);assert.equal(d.ledger().revision,beforeReplay);
  d.deps.fs=fs;d.deps.git=gitIo;d.deps.measure=measure;d.deps.host=host;
  const reconciled=await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','stage-cut-progress',actionId),d.deps);
  if(lost)assert.equal(reconciled.cleanupStep,'reconcile-progress',JSON.stringify(reconciled));
  else{assert.equal(reconciled.ok,false,JSON.stringify(reconciled));assert.equal(d.ledger().revision,beforeReplay,'unchanged already-observed partial progress is not another funded observation');}
  assert.notEqual(reconciled.discharged,true);
  assert.ok(existsSync(plan.backupDir));assert.equal(Object.hasOwn(reconciled,'backupIntegrity'),false);
  const retry=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','stage-cut-fresh-retry',actionId),d.deps);
  assert.equal(retry.discharged,false,JSON.stringify(retry));assert.equal(existsSync(plan.stageDir),false,JSON.stringify(retry));assert.ok(existsSync(plan.backupDir));
  const complete=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','stage-cut-backup',actionId),d.deps);
  assert.equal(complete.discharged,true,JSON.stringify(complete));assert.equal(restores,1);
  assert.equal(d.ledger().requests.length-initial.requests.length,9);assert.equal(d.ledger().taskEntries.length-initial.taskEntries.length,11);
});


test('C2 two TOTAL resource cycles retain the target fence after continuing deletion failure',async t=>{
  const {d,result,actionId}=await c2LandResolved(t),plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan;
  assert.equal((await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','resource-limit-verify',actionId),d.deps)).discharged,false);
  let removes=0;d.deps.git={...d.deps.git,worktreeRemove:async()=>{removes++;throw new Error('continued stage removal fault');}};
  for(let cycle=0;cycle<2;cycle++){
    const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge',`resource-limit-${cycle}`,actionId),d.deps);
    assert.notEqual(out.discharged,true);assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
  }
  const exhausted=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','resource-limit-exhausted',actionId),d.deps);
  assert.equal(exhausted.ok,false,JSON.stringify(exhausted));assert.equal(removes,2);
  assert.ok(latestTaskEntity(d.ledger(),actionId).resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='retained'));
  await assertRecoveryTargetFenced(d,'two-resource-cycles-exhausted');
});


for(const issued of [false,true])test('real Core bootstrap replay retains '+(issued?'issued place without create context':'reserve-only intended place')+' with zero external IO',async t=>{
  const d=await realDesk(t);await d.define();const input=d.bootInput();
  const seat={provider:'slp-codex-peer',model:'m1',optionId:input.runtime.optionId,catalogSha256:input.runtime.catalogSha256};
  const reserved=await d.taskCommand({operation:'reserve',requestId:subRequestId(input.requestId,'reserve'),
    assignmentId:input.assignmentId,taskId:input.taskId,grantRef:input.grantRef,
    expectedLedgerRevision:input.expectedLedgerRevision,expectedBriefRevision:input.expectedBriefRevision,
    expectedOwnershipRevision:input.expectedOwnershipRevision,expectedTaskRevision:input.expectedTaskRevision,
    placement:input.placement,runtime:input.runtime,seatPin:seat,reuseTarget:'new',effectBudget:input.effectBudget});
  assert.equal(reserved.ok,true,JSON.stringify(reserved));
  if(issued)assert.equal((await runTaskEffect(d.ctx,{operation:'issue',requestId:subRequestId(input.requestId,'place-issue'),
    attemptId:reserved.attemptId,actionId:reserved.next.actionId,actionKind:'place'},{store:d.store,observe:createTaskObserver(d.ctx,d.deps)})).ok,true);
  const before=d.ledger();
  d.deps.host=()=>assert.fail('historical bootstrap may not access SDK');
  d.deps.resolveSeat=async()=>assert.fail('historical bootstrap may not resolve catalog');
  d.deps.fs=new Proxy(d.deps.fs,{get:()=>()=>assert.fail('historical bootstrap may not inspect filesystem')});
  d.deps.git=new Proxy(d.deps.git,{get:()=>()=>assert.fail('historical bootstrap may not inspect Git')});
  d.deps.measure=async()=>assert.fail('historical bootstrap may not measure');
  const effect=d.deps.task.runTaskEffect;let effectCalls=0;
  d.deps.task={...d.deps.task,runTaskEffect:async(...args)=>{effectCalls++;return effect(...args);}};
  const replay=await runTaskDispatch(d.ctx,input,d.deps);
  assert.equal(replay.ok,false,JSON.stringify(replay));assert.equal(replay.code,'CAPABILITY_GAP');
  assert.match(replay.recovery,/retain|reconcile/i);assert.equal(effectCalls,0,'missing CREATE context cannot issue a historical intended place');
  assert.equal(d.ledger().revision,before.revision);assert.equal(d.ledger().requests.length,before.requests.length);
  assert.equal(latestTaskEntity(d.ledger(),reserved.next.actionId).state,issued?'issued':'intended');
});


for(const lost of [false,true])test('real Core bootstrap historical '+(lost?'lost-create':'successful-create')+' replay uses original reserve and issued place with zero IO/entropy',async t=>{
  const d=await realDesk(t,{lostCreateAck:lost});await d.define();const input=d.bootInput();
  const boot=await runTaskDispatch(d.ctx,input,d.deps);assert.equal(boot.state,lost?'uncertain':'bound',JSON.stringify(boot));
  const before=d.ledger(),originalReceipt=latestTaskEntity(before,boot.attemptId),effect=d.deps.task.runTaskEffect;
  let issues=0;d.deps.task={...d.deps.task,runTaskEffect:async(ctx,request,deps)=>{
    assert.equal(request.operation,'issue');assert.equal(request.requestId,subRequestId(input.requestId,'place-issue'));issues++;
    return effect(ctx,request,deps);
  }};
  await withoutBootstrapIo(d,async()=>{
    const replay=await runTaskDispatch(d.ctx,input,d.deps);
    assert.equal(replay.perform,false,JSON.stringify(replay));assert.equal(replay.state,'historical-replay');
    assert.equal(replay.recordedAttemptState,originalReceipt.state);assert.equal(replay.recordedAttemptRevision,originalReceipt.revision);
    assert.equal(replay.recordedActionState,lost?'uncertain':'observed');assert.equal(issues,1);
    for(const [key,value] of [['title','changed title'],['runtime',{...input.runtime,catalogSha256:'d'.repeat(64)}],
      ['placement',{...input.placement,baseRef:'foreign-ref'}],['grantRef','grant:foreign'],['expectedLedgerRevision',input.expectedLedgerRevision+1],
      ['expectedTaskRevision',input.expectedTaskRevision+1],['expectedBriefRevision',input.expectedBriefRevision+1]]){
      const changed=await runTaskDispatch(d.ctx,{...input,[key]:value},d.deps);
      assert.equal(changed.ok,false,key+': '+JSON.stringify(changed));
      assert.equal(d.ledger().revision,before.revision);assert.equal(d.ledger().requests.length,before.requests.length);
    }
  });
  assert.equal(d.ledger().revision,before.revision);assert.equal(issues,1);assert.equal(d.host.calls.create.length,1);
});


for(const cut of ['intent','issue'])test('real Core private ticket lost after create '+cut+' stays retained on replay without native resubmission',async t=>{
  const d=await realDesk(t);await d.define();const input=d.bootInput(),effect=d.deps.task.runTaskEffect;
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,request,deps)=>{
    const out=await effect(ctx,request,deps);
    if(request.actionKind==='create'&&request.operation===cut&&out.ok)return {ok:false,code:'CAPABILITY_GAP',message:'fixture invocation lost after durable create '+cut,recovery:'retain issued lineage'};
    return out;
  }};
  const stopped=await runTaskDispatch(d.ctx,input,d.deps);assert.equal(stopped.ok,false);assert.equal(d.host.calls.create.length,0);
  d.deps.task={...d.deps.task,runTaskEffect:effect};
  const before=d.ledger(),attempt=before.taskEntries.find(row=>row.kind==='attempt'),action=before.taskEntries.filter(row=>row.kind==='action'&&row.actionKind==='create').at(-1);
  assert.equal(action.state,cut==='intent'?'intended':'issued');assert.match(action.body.createTicketSha256,/^[a-f0-9]{64}$/);
  await withoutBootstrapIo(d,async()=>{
    const replay=await runTaskDispatch(d.ctx,input,d.deps);assert.equal(replay.perform,false,JSON.stringify(replay));
    assert.equal(replay.gap,'private-create-ticket-unavailable');assert.equal(replay.recordedActionState,action.state);
  });
  assert.equal(d.ledger().revision,before.revision);assert.equal(d.ledger().requests.length,before.requests.length);
  assert.equal(d.host.calls.create.length,0);assert.equal(latestTaskEntity(d.ledger(),attempt.attemptId).member,null);
  assert.equal(latestTaskEntity(d.ledger(),attempt.attemptId).boundScopeId,null);
});


for(const changedActor of ['revoked','rebound','open-generation'])test('real Core bootstrap replay rejects '+changedActor+' caller before all external IO',async t=>{
  const d=await realDesk(t,{actualOwner:true});await d.define();const input=d.bootInput();
  assert.equal((await runTaskDispatch(d.ctx,input,d.deps)).state,'bound');
  if(changedActor==='revoked'||changedActor==='rebound'){
    const transact=d.store.transact.bind(d.store),errors=[],warnings=[];
    d.store.transact=async(...args)=>{try{return await transact(...args);}catch(error){errors.push({name:error.name,message:error.message});throw error;}};
    const revoker=createDeskSeat({stableRoot:join(d.w.scratch,'desk-store'),store:d.store,now:()=>new Date(NOW),warn:message=>warnings.push(message)});
    await revoker.deskRevoke({agent:{id:'agent-owner',provider:'slp-codex-lead',cwd:d.w.repo,
      workspaceId:null,parentAgentId:null,title:null},archivedAt:NOW});
    d.store.transact=transact;assert.equal(warnings.length,0,JSON.stringify({warnings,errors}));
  }
  let ctx=changedActor==='open-generation'?{...d.ctx,row:{...d.ctx.row,openGeneration:d.ctx.row.openGeneration+1}}:d.ctx;
  if(changedActor==='rebound'){
    const minted=await d.seatHooks.deskMint({provider:'slp-codex-lead',family:'codex',role:'lead',cwd:d.w.repo,env:{}});assert.ok(minted);
    await d.seatHooks.deskBind({agentId:'agent-owner',workspaceId:null,provider:'slp-codex-lead',cwd:d.w.repo,
      reason:'create',purpose:'interactive',env:{SLP_DESK_HANDLE:minted.handle}});
    await d.seatHooks.deskRegister({agent:{id:'agent-owner',provider:'slp-codex-lead',cwd:d.w.repo,workspaceId:null,parentAgentId:null,title:null}});
    const replacement=d.ledger().memberships.find(row=>row.agentId==='agent-owner'&&row.revokedAt===null);
    assert.ok(replacement);assert.notEqual(replacement.membershipId,d.owner.membershipId);ctx={...d.ctx,row:replacement};
  }
  const before=d.ledger();
  await withoutBootstrapIo(d,async()=>{
    const denied=await runTaskDispatch(ctx,input,d.deps);assert.equal(denied.ok,false,JSON.stringify(denied));
  });
  assert.equal(d.ledger().revision,before.revision);assert.equal(d.ledger().requests.length,before.requests.length);
});


test('managed read-only scope without writer ownership delivers through its exact claimed scope',async t=>{
  const d=await realDesk(t);
  await d.define('task-1',{scope:{...taskSpec().scope,ownership:null}});
  const boot=await runTaskDispatch(d.ctx,d.bootInput(),d.deps);
  assert.equal(boot.state,'bound',JSON.stringify(boot));
  const attempt=latestTaskEntity(d.ledger(),boot.attemptId);
  const scope=d.ledger().scopes.find(row=>row.scopeId===attempt.boundScopeId);
  assert.equal(scope.ownership,null);
  assert.equal(d.ledger().scopeTransitions.filter(row=>row.scopeId===scope.scopeId).at(-1).to,'claimed');
  const sent=await runTaskDispatch(d.ctx,{...d.sendInput(boot.attemptId),text:'Read policy and report three facts; no file writes.'},d.deps);
  assert.equal(sent.sent,true,JSON.stringify(sent));
  assert.equal(d.host.calls.send.length,1);
  assert.equal(d.ledger().scopes.find(row=>row.scopeId===scope.scopeId).ownership,null,'delivery creates no writer authority');
});


test('managed read-only delivery still refuses a redeclared scope outside its claimed revision',async t=>{
  const d=await realDesk(t);await d.define('task-1',{scope:{...taskSpec().scope,ownership:null}});
  const boot=await runTaskDispatch(d.ctx,d.bootInput(),d.deps);assert.equal(boot.state,'bound');
  const attempt=latestTaskEntity(d.ledger(),boot.attemptId);
  const scope=d.ledger().scopes.find(row=>row.scopeId===attempt.boundScopeId);
  const declared=await runScopeDeclare(d.ctx,{requestId:'readonly-scope-redeclare',assignmentId:d.assignmentId,
    scopeId:scope.scopeId,label:scope.label,declarationSha256:scope.declarationSha256,refs:scope.refs,
    seatAgentId:scope.seatAgentId,expectedBriefRevision:0,ownership:null,reviewPlan:scope.reviewPlan},{store:d.store});
  assert.equal(declared.ok,true,JSON.stringify(declared));
  const before=d.ledger();const sent=await runTaskDispatch(d.ctx,d.sendInput(boot.attemptId),d.deps);
  assert.equal(sent.code,'SCOPE_CONFLICT',JSON.stringify(sent));
  assert.equal(d.host.calls.send.length,0);
  assert.equal(d.ledger().taskEntries.length,before.taskEntries.length,'rejection issues no action');
  assert.equal(d.ledger().requests.at(-1).outcome,'rejected');
});


test('workspace-pinned task ticket mints unbound then registers and binds its exact workspace',async t=>{
  const workspaceId='workspace-owned';
  const d=await realDesk(t,{workspaceId});await d.define();
  const boot=await runTaskDispatch(d.ctx,d.bootInput('task-1',{
    placement:{kind:'shared-checkout',cwd:d.w.repo,baseRef:d.w.head,workspaceId},
  }),d.deps);
  assert.equal(boot.state,'bound',JSON.stringify({boot,warnings:d.seatWarnings}));
  assert.equal(d.hookTrace.mints,1);assert.equal(d.hookTrace.nativeEffects,1);
  assert.equal(d.seat.workspaceId,workspaceId);assert.ok(d.seat.registeredAt);
  assert.equal(d.seat.capacityClaim.version,2);
  assert.equal(latestTaskEntity(d.ledger(),boot.attemptId).member.membershipId,d.seat.membershipId);
  assert.equal(d.seatWarnings.length,0,JSON.stringify(d.seatWarnings));
});


test('workspace-pinned unbound task claim refuses foreign workspace registration without ledger writes',async t=>{
  const workspaceId='workspace-owned';
  const d=await realDesk(t,{workspaceId,delayedRegistration:true,
    afterMint:({store,repoKey})=>{const r=store.read(repoKey);assert.equal(r.state,'ok');
      assert.equal(r.ledger.memberships.at(-1).workspaceId,null);},
  });await d.define();
  const boot=await runTaskDispatch(d.ctx,d.bootInput('task-1',{
    placement:{kind:'shared-checkout',cwd:d.w.repo,baseRef:d.w.head,workspaceId},
  }),d.deps);
  assert.equal(boot.state,'seat-pending',JSON.stringify({boot,warnings:d.seatWarnings}));
  const before=d.ledger();
  // The raw handle stays in the fixture hook's env, never in persisted rows.
  await d.seatHooks.deskBind({agentId:'agent-new',workspaceId:'workspace-foreign',provider:'slp-codex-peer',cwd:d.w.repo,
    reason:'create',purpose:'interactive',env:d.hookEnvs.get('agent-new')});
  assert.equal(d.ledger().revision,before.revision);
  assert.equal(d.ledger().memberships.at(-1).agentId,null);
  await d.registerCreated();
  assert.equal(d.seat.workspaceId,workspaceId);
  assert.equal(d.ledger().memberships.length,before.memberships.length);
});


for(const bad of ['malformed-ticket','foreign-ticket','wrong-model','wrong-provider','wrong-cwd','wrong-mode','wrong-thinking','wrong-features'])test('actual config/env-only hook denies '+bad+' before native fixture effect',async t=>{
  const d=await realDesk(t,{transformHook:request=>{
    if(bad==='malformed-ticket')return {...request,env:{...request.env,[DESK_TASK_CREATE_TICKET_KEY]:'partial'}};
    if(bad==='foreign-ticket')return {...request,env:{...request.env,[DESK_TASK_CREATE_TICKET_KEY]:'f'.repeat(64)}};
    const key={'wrong-model':'model','wrong-provider':'provider','wrong-cwd':'cwd','wrong-mode':'modeId','wrong-thinking':'thinkingOptionId','wrong-features':'featureValues'}[bad];
    return {...request,config:{...request.config,[key]:bad==='wrong-features'?{unsupported:true}:bad==='wrong-cwd'?'/foreign-fixture':bad==='wrong-provider'?'codex':'foreign-value'}};
  }});await d.define();const before=d.ledger().memberships.length;
  const out=await runTaskDispatch(d.ctx,d.bootInput(),d.deps);
  assert.equal(out.state,'uncertain');assert.equal(d.hookTrace.nativeEffects,0);assert.equal(d.host.calls.create.length,0);
  assert.equal(d.ledger().memberships.length,before);assert.equal(d.ledger().memberships.some(row=>row.capacityClaim?.version===2),false);
  const attempt=latestTaskEntity(d.ledger(),out.attemptId);assert.equal(attempt.member,null);assert.equal(attempt.boundScopeId,null);
  assert.equal(attempt.state,'reconciliation-required');
});


test('actual config/env-only hook consumes its ticket once and leaves ordinary unlabelled behavior unchanged',async t=>{
  const d=await realDesk(t);await d.define();const input=d.bootInput();
  assert.equal((await runTaskDispatch(d.ctx,input,d.deps)).state,'bound');
  const opts=d.host.calls.create[0],raw=fixtureNativeCreateRequest(opts),before=d.ledger();
  await assert.rejects(()=>d.injection.agentCreate({request:{config:raw.config,env:raw.env}}),/ticket claim/);
  assert.equal(d.ledger().memberships.length,before.memberships.length);assert.equal(d.hookTrace.nativeEffects,1);
  const ordinary=await d.injection.agentCreate({request:{config:{provider:'slp-codex-peer',model:'m1',cwd:d.w.repo},env:{ORDINARY:'preserved'}}});
  assert.equal(ordinary.env.ORDINARY,'preserved');assert.equal(Object.hasOwn(ordinary.env,DESK_TASK_CREATE_TICKET_KEY),false);
  const member=d.ledger().memberships.find(row=>row.bindingHandleSha256===sha256Hex(ordinary.env.SLP_DESK_HANDLE));
  assert.equal(member.capacityClaim??null,null,'ordinary membership does not claim task credit');
  assert.equal(d.ledger().memberships.filter(row=>row.capacityClaim?.version===2).length,1);
  assert.equal(await d.injection.agentCreate({request:{config:{provider:'codex',model:'m1',cwd:d.w.repo}}}),undefined);
});


test('native failure after committed ticket mint retains the unbound claim and never recovers or replaces its secret',async t=>{
  const d=await realDesk(t,{afterMint:async()=>{throw new Error('fixture lost mint/launch response after committed claim');}});
  await d.define();const input=d.bootInput();
  const out=await runTaskDispatch(d.ctx,input,d.deps);assert.equal(out.state,'uncertain');assert.equal(d.host.calls.create.length,0);
  const before=d.ledger(),claim=before.memberships.find(row=>row.capacityClaim?.version===2);
  assert.ok(claim);assert.equal(claim.agentId,null);assert.equal(claim.registeredAt,null);
  const attempt=latestTaskEntity(before,out.attemptId);assert.equal(attempt.member,null);assert.equal(attempt.boundScopeId,null);
  await withoutBootstrapIo(d,async()=>{const replay=await runTaskDispatch(d.ctx,input,d.deps);assert.equal(replay.perform,false);assert.equal(replay.gap,'private-create-ticket-unavailable');});
  assert.equal(d.ledger().revision,before.revision);assert.equal(d.ledger().memberships.length,before.memberships.length);
  assert.equal(d.host.calls.create.length,0);assert.equal(d.hookTrace.mints,1);
});


test('actual Core+native hook at 4095 memberships consumes the one reserved create credit and atomically binds scope',async t=>{
  const d=await realDesk(t,{legacyMemberships:4094});await d.define();
  const before=d.ledger();assert.equal(before.memberships.length,4095);
  const input=d.bootInput(),boot=await runTaskDispatch(d.ctx,input,d.deps);assert.equal(boot.state,'bound',JSON.stringify(boot));
  const after=d.ledger(),attempt=latestTaskEntity(after,boot.attemptId),claim=d.seat.capacityClaim;
  assert.equal(after.memberships.length,4096);assert.equal(d.hookTrace.nativeEffects,1);assert.equal(d.hookTrace.mints,1);
  assert.equal(claim.version,2);assert.equal(claim.basis,'create-ticket');assert.equal(claim.attemptId,boot.attemptId);
  const issued=after.taskEntries.find(row=>row.entryId===claim.createIssueRef.entryId);
  assert.equal(issued.state,'issued');assert.equal(issued.entrySha256,claim.createIssueRef.entrySha256);
  assert.equal(claim.intendedBodySha256,issued.bodySha256);assert.equal(claim.ticketSha256,issued.body.createTicketSha256);
  assert.equal(attempt.member.membershipId,d.seat.membershipId);assert.ok(attempt.boundScopeId);
  assert.equal(after.scopes.length-before.scopes.length,1);assert.equal(after.scopeTransitions.length-before.scopeTransitions.length,2);
  assert.equal(after.requests.length-before.requests.length,10,'one existing native mint transaction; no pre-mint/claim commit');
  assert.equal(after.taskEntries.length-before.taskEntries.length,12,'shared bind appends attempt plus the two exact resource accounts');
  const costs=[['reserve',2],['place-issue',1],['place-observe',2],['create-intent',1],['create-issue',1],['create-observe',2],['bind',3]];
  for(const [site,expected] of costs)assert.equal(after.taskEntries.slice(before.taskEntries.length).filter(row=>row.requestId===subRequestId(input.requestId,site)).length,expected,site);
  console.log('native-ticket measured bootstrap '+JSON.stringify({requests:after.requests.length-before.requests.length,
    taskEntries:after.taskEntries.length-before.taskEntries.length,memberships:after.memberships.length-before.memberships.length,
    scopes:after.scopes.length-before.scopes.length,scopeTransitions:after.scopeTransitions.length-before.scopeTransitions.length,
    events:after.lastEventSeq-before.lastEventSeq,bytes:Buffer.byteLength(JSON.stringify(after))-Buffer.byteLength(JSON.stringify(before))}));
  assert.ok(Buffer.byteLength(JSON.stringify(after))<16*1024*1024);
  const fullTable=after.memberships.length;
  const ordinary=await d.injection.agentCreate({request:{config:{provider:'slp-codex-peer',model:'m1',cwd:d.w.repo}}});
  assert.ok(ordinary.config.systemPrompt.startsWith('SLP role=peer'));assert.equal(ordinary.env?.SLP_DESK_HANDLE,undefined);
  assert.equal(d.ledger().memberships.length,fullTable,'unlabelled ordinary create cannot borrow the already consumed task credit');
});


for(const drift of ['slp.repo','slp.task','slp.attempt','slp.assignment','slp.create-action','parent','workspace'])test('actual claimed native create holds '+drift+' drift before scope or work prompt',async t=>{
  const d=await realDesk(t,{transformSnapshot:result=>({...result,agent:{...result.agent,
    ...(drift==='workspace'?{workspaceId:'foreign-workspace'}:{labels:{...result.agent.labels,
      [drift==='parent'?'paseo.parent-agent-id':drift]:'foreign-value'}})}})});await d.define();
  const out=await runTaskDispatch(d.ctx,d.bootInput(),d.deps);assert.equal(out.state,'uncertain');
  assert.equal(d.hookTrace.nativeEffects,1);assert.equal(d.ledger().memberships.filter(row=>row.capacityClaim?.version===2).length,1);
  const attempt=latestTaskEntity(d.ledger(),out.attemptId);assert.equal(attempt.member,null);assert.equal(attempt.boundScopeId,null);
  assert.equal(d.ledger().scopes.length,0);assert.equal(d.host.calls.send.length,0);
  assert.notEqual(attempt.state,'settled');
});


for(const drift of ['historical-base-artifact','retained-result-artifact','fresh-result-checkout','target-head'])test('C2 initial verification observes '+drift+' drift and authorizes zero removal',async t=>{
  const {d,result,actionId}=await c2Staged(t),row=latestTaskEntity(d.ledger(),actionId),effect=d.deps.task.runTaskEffect;
  let callbacks=0,removals=0;
  d.deps.fs={...d.deps.fs,rmrf:()=>{removals++;assert.fail('unverified account cannot remove material');}};
  d.deps.git={...d.deps.git,worktreeRemove:async()=>{removals++;assert.fail('unverified account cannot remove worktree');}};
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    const observe=deps.observe.observeIntegrationCleanup;
    if(input.operation==='observe'&&input.receipt?.cleanupStep==='verify-account')deps={...deps,observe:{...deps.observe,observeIntegrationCleanup:async request=>{
      callbacks++;
      const attempt=d.ledger().taskEntries.find(entry=>entry.kind==='attempt'&&entry.taskId===row.taskId);
      if(drift==='historical-base-artifact')writeFileSync(join(d.w.scratch,'task-exec',d.repoKey,'attempts',attempt.attemptId,'base.measure.json'),'tampered historical BASE');
      if(drift==='retained-result-artifact')writeFileSync(join(d.w.scratch,'task-exec',d.repoKey,'integrations',actionId,'source-result.measure.json'),'tampered retained RESULT');
      if(drift==='fresh-result-checkout')writeFileSync(join(row.sourceCwd,'changed.txt'),'source drift after proof ISSUE');
      if(drift==='target-head')git(d.w.repo,['commit','--allow-empty','-m','target HEAD drift after proof ISSUE']);
      return observe(request);
    }}};
    return effect(ctx,input,deps);
  }};
  const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge',`initial-source-${drift}`,actionId),d.deps);
  assert.equal(out.ok,false,JSON.stringify(out));assert.equal(callbacks,1);assert.equal(removals,0);
  assert.equal(latestTaskEntity(d.ledger(),actionId).cleanupVerification??null,null);
  assert.ok(existsSync(row.stageDir));assert.ok(row.resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='retained'));
  assert.equal(latestTaskEntity(d.ledger(),actionId).landed,null,'source/cleanup measurements mint no LAND pin');
});


test('C2 actual discharge replay never issues an original verification intent whose ISSUE did not commit',async t=>{
  const {d,result,actionId}=await c2LandResolved(t),effect=d.deps.task.runTaskEffect;
  const request=integrationRequest(d,result,'discharge','unissued-proof-replay',actionId);
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>input.operation==='issue'
    ?{ok:true,perform:false}:effect(ctx,input,deps)};
  const first=await runTaskIntegration(d.ctx,request,d.deps);assert.equal(first.perform,false);assert.equal(first.discharged,false);
  const before=d.ledger(),original=latestTaskEntity(before,actionId);assert.equal(original.state,'intended');
  assert.equal(before.requests.some(row=>row.requestId===subRequestId(request.requestId,'discharge-issue')),false);
  let issues=0,observers=0;
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    if(input.operation==='issue')issues++;
    return effect(ctx,input,{...deps,observe:{...deps.observe,observeIntegrationCleanup:async()=>{observers++;assert.fail('unissued historical replay cannot observe');}}});
  }};
  await withoutBootstrapIo(d,async()=>{
    const replay=await runTaskIntegration(d.ctx,request,d.deps);assert.equal(replay.perform,false,JSON.stringify(replay));
  });
  console.log('unissued-cleanup replay delta '+JSON.stringify({revision:d.ledger().revision-before.revision,
    requests:d.ledger().requests.length-before.requests.length,issues,observers,state:latestTaskEntity(d.ledger(),actionId).state}));
  assert.equal(d.ledger().revision,before.revision);assert.equal(d.ledger().requests.length,before.requests.length);
  assert.equal(issues,0,'historical intent cannot mint an ISSUE');assert.equal(observers,0);
  assert.equal(latestTaskEntity(d.ledger(),actionId).state,'intended');assert.equal(latestTaskEntity(d.ledger(),actionId).revision,original.revision);
  // A second current intent must not be issued through the older request's
  // subkey. Its two-cycle admission is a different explicit public request.
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>input.operation==='issue'?{ok:true,perform:false}:effect(ctx,input,deps)};
  const fresh=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','unissued-proof-second-intent',actionId),d.deps);
  assert.equal(fresh.perform,false,JSON.stringify(fresh));
  const newer=d.ledger(),newAction=latestTaskEntity(newer,actionId);assert.equal(newAction.body.publicRequestId,'unissued-proof-second-intent');
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    if(input.operation==='issue')issues++;
    return effect(ctx,input,{...deps,observe:{...deps.observe,observeIntegrationCleanup:async()=>{observers++;assert.fail('old request cannot observe newer intent');}}});
  }};
  await withoutBootstrapIo(d,async()=>{const replay=await runTaskIntegration(d.ctx,request,d.deps);assert.equal(replay.gap,'historical-cleanup-issue-uncommitted');});
  assert.equal(issues,0);assert.equal(observers,0);assert.equal(d.ledger().revision,newer.revision);
  assert.equal(latestTaskEntity(d.ledger(),actionId).revision,newAction.revision);assert.deepEqual(latestTaskEntity(d.ledger(),actionId).body,newAction.body);
});


test('C2 normal observed LAND needs no extra reconciliation before its three granted cleanup cycles',async t=>{
  const {d,result,actionId}=await c2Staged(t);
  assert.equal((await runTaskIntegration(d.ctx,integrationRequest(d,result,'land','direct-cleanup-land',actionId),d.deps)).landed,true);
  const start=d.ledger(),plan=latestTaskEntity(start,actionId).recoveryPlan;
  for(let step=0;step<3;step++){
    const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge',`direct-cleanup-${step}`,actionId),d.deps);
    assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.discharged,step===2);
  }
  assert.equal(d.ledger().requests.length-start.requests.length,9);assert.equal(d.ledger().taskEntries.length-start.taskEntries.length,11);
  assert.ok(existsSync(plan.manifestPath));assert.ok(existsSync(plan.targetOriginal.path));assert.ok(existsSync(plan.expectedCombined.path));
});


for(const drift of ['survivor-bytes','survivor-mode','unexpected-path','unissued-backup-missing','target-head','source-result','forged-verification-ref','wrong-grant'])test('C2 issued partial stage permit does not authorize '+drift,async t=>{
  const {d,result,actionId}=await c2LandResolved(t),plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan;
  assert.equal((await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','survivor-account',actionId),d.deps)).discharged,false);
  const gitIo=d.deps.git,fs=d.deps.fs;
  d.deps.git={...gitIo,worktreeRemove:async()=>{fs.rmrf(join(plan.stageDir,'changed.txt'));throw new Error('fixture partial content removal with exact prior permit');}};
  const partial=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','survivor-partial',actionId),d.deps);
  assert.equal(partial.state,'held');assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
  d.deps.git=gitIo;
  if(drift==='survivor-bytes')writeFileSync(join(plan.stageDir,'kept.txt'),'tampered survivor');
  if(drift==='survivor-mode')chmodSync(join(plan.stageDir,'kept.txt'),0o600);
  if(drift==='unexpected-path')writeFileSync(join(plan.stageDir,'unaccounted'),'new unexpected material');
  if(drift==='unissued-backup-missing'){
    const manifest=JSON.parse(readFileSync(plan.manifestPath,'utf8'));fs.rmrf(join(plan.backupDir,manifest.entries.find(entry=>entry.existed).blobKey));
  }
  if(drift==='target-head')git(d.w.repo,['commit','--allow-empty','-m','target drift after deletion permit']);
  if(drift==='source-result')writeFileSync(join(latestTaskEntity(d.ledger(),actionId).sourceCwd,'changed.txt'),'fresh source RESULT drift');
  const effect=d.deps.task.runTaskEffect;let removals=0;
  d.deps.fs={...fs,rmrf:()=>{removals++;assert.fail('tampered issued survivors cannot be removed');}};
  d.deps.git={...gitIo,worktreeRemove:async()=>{removals++;assert.fail('tampered issued resource cannot be removed');}};
  if(drift==='forged-verification-ref')d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    if(input.operation==='intent'&&input.body?.cleanupStep==='remove-resource')input={...input,body:{...input.body,
      verificationRef:{...input.body.verificationRef,entrySha256:'f'.repeat(64)},permit:{...input.body.permit,verificationRef:{...input.body.permit.verificationRef,entrySha256:'f'.repeat(64)}}}};
    return effect(ctx,input,deps);
  }};
  const request=integrationRequest(d,result,'discharge','survivor-new-permit',actionId);
  if(drift==='wrong-grant')request.grantRef='grant:foreign';
  const out=await runTaskIntegration(d.ctx,request,d.deps);assert.equal(out.ok,false,JSON.stringify(out));assert.equal(removals,0);
  assert.ok(latestTaskEntity(d.ledger(),actionId).resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='retained'));
  assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
});

