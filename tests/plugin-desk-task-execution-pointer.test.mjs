// Split from tests/plugin-desk-task-execution.test.mjs (part 4 of 4,
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

for(const fault of ['missing-before-first-permit','locked-admin','foreign-admin-pointer','symlink','directory','survivor-mode','escaped-resource'])
  test('C2 pointer preflight refuses '+fault+' before destructive ISSUE',async t=>{
    const {d,result,actionId}=await c2LandResolved(t),row=latestTaskEntity(d.ledger(),actionId),plan=row.recoveryPlan;
    assert.equal((await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','pointer-preflight-account',actionId),d.deps)).discharged,false);
    const pointer=join(plan.stageDir,'.git'),gitDir=await d.deps.git.absoluteGitDir(plan.stageDir),fs=d.deps.fs,gitIo=d.deps.git;
    if(fault==='missing-before-first-permit')fs.rmrf(pointer);
    if(fault==='locked-admin')writeFileSync(join(gitDir,'locked'),'locked');
    if(fault==='foreign-admin-pointer')writeFileSync(join(gitDir,'gitdir'),join(d.w.repo,'.git')+'\n');
    if(fault==='symlink'){fs.rmrf(pointer);symlinkSync(join(d.w.repo,'missing'),pointer);}
    if(fault==='directory'){fs.rmrf(pointer);mkdirSync(pointer);}
    if(fault==='survivor-mode')chmodSync(join(plan.stageDir,'kept.txt'),0o600);
    const effect=d.deps.task.runTaskEffect;let restores=0,removes=0;
    d.deps.fs={...fs,writeFileExclusive:()=>{restores++;assert.fail('preflight denial cannot restore');},rmrf:()=>{removes++;assert.fail('preflight denial cannot remove');}};
    d.deps.git={...gitIo,worktreeRemove:async()=>{removes++;assert.fail('preflight denial cannot invoke Git removal');}};
    if(fault==='escaped-resource')d.deps.task={...d.deps.task,runTaskEffect:(ctx,input,deps)=>effect(ctx,input.operation==='intent'&&input.body?.permit
      ?{...input,body:{...input.body,permit:{...input.body.permit,resourceKey:d.w.repo}}}:input,deps)};
    const issuedBefore=d.ledger().taskEntries.filter(entry=>entry.kind==='action'&&entry.actionId===actionId&&entry.state==='issued'&&entry.body?.cleanupStep==='remove-resource').length;
    const denied=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','pointer-preflight-denied',actionId),d.deps);
    assert.equal(denied.ok,false,JSON.stringify(denied));assert.equal(restores,0);assert.equal(removes,0);
    assert.equal(d.ledger().taskEntries.filter(entry=>entry.kind==='action'&&entry.actionId===actionId&&entry.state==='issued'&&entry.body?.cleanupStep==='remove-resource').length,issuedBefore);
    assert.ok(row.resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='retained'));
    assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
  });


for(const fault of ['source-after-issue','target-after-issue','survivor-after-issue','locked-after-issue','leaf-after-issue','race-file','race-dangling-link','wrong-written-bytes','wrong-written-size','wrong-written-mode','helper-unavailable','unsupported-original-format'])
  test('C2 pointer restoration retains obligations for '+fault,async t=>{
    const {d,result,actionId,plan,pointer,original,mode,fs,gitIo}=await pointerCleanupCut(t,{relativePointer:fault==='unsupported-original-format'});
    let restores=0,removes=0;const effect=d.deps.task.runTaskEffect;
    d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
      const out=await effect(ctx,input,deps);
      if(input.operation==='issue'&&out.ok===true&&out.perform!==false){
        if(fault==='source-after-issue')writeFileSync(join(latestTaskEntity(d.ledger(),actionId).sourceCwd,'changed.txt'),'post-ISSUE source drift');
        if(fault==='target-after-issue')writeFileSync(join(d.w.repo,'changed.txt'),'post-ISSUE target drift');
        if(fault==='leaf-after-issue')writeFileSync(pointer,'post-ISSUE racing leaf');
        if(fault==='survivor-after-issue')writeFileSync(join(plan.stageDir,'kept.txt'),'post-ISSUE survivor drift');
        if(fault==='locked-after-issue')writeFileSync(join(latestTaskEntity(d.ledger(),actionId).cleanupVerification.candidate.resources[0].gitRegistration.gitDir,'locked'),'locked');
      }
      return out;
    }};
    d.deps.fs={...fs,writeFileExclusive:fault==='helper-unavailable'?undefined:(path,bytes,permission)=>{
      restores++;assert.equal(path,pointer);assert.deepEqual(bytes,original);assert.equal(permission,mode);
      if(fault==='race-file')writeFileSync(path,'racing material');
      if(fault==='race-dangling-link')symlinkSync(join(d.w.repo,'missing'),path);
      const result=fs.writeFileExclusive(path,bytes,permission);
      if(fault==='wrong-written-bytes')writeFileSync(path,Buffer.alloc(bytes.length,120));
      if(fault==='wrong-written-size')writeFileSync(path,bytes.subarray(0,bytes.length-1));
      if(fault==='wrong-written-mode')chmodSync(path,permission===0o600?0o644:0o600);
      return result;
    },rmrf:()=>{removes++;assert.fail('a held pointer cannot remove backup');}};
    d.deps.git={...gitIo,worktreeRemove:async()=>{removes++;assert.fail('pointer proof failure must precede Git removal');}};
    const request=integrationRequest(d,result,'discharge','pointer-second-negative',actionId);
    const held=await runTaskIntegration(d.ctx,request,d.deps);assert.notEqual(held.discharged,true,JSON.stringify(held));assert.equal(removes,0);
    assert.equal(restores,['race-file','race-dangling-link','wrong-written-bytes','wrong-written-size','wrong-written-mode'].includes(fault)?1:0);
    assert.ok(latestTaskEntity(d.ledger(),actionId).resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='retained'));
    assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
    if(fault==='leaf-after-issue')assert.equal(readFileSync(pointer,'utf8'),'post-ISSUE racing leaf');
    if(fault==='race-file')assert.equal(readFileSync(pointer,'utf8'),'racing material');
    if(fault==='race-dangling-link')assert.equal(readlinkSync(pointer),join(d.w.repo,'missing'));
    const beforeReplay=d.ledger().revision;
    d.deps.fs=new Proxy(fs,{get:()=>()=>assert.fail('replay must not inspect or restore pointer')});
    d.deps.git=new Proxy(gitIo,{get:()=>()=>assert.fail('replay must not inspect or remove worktree')});
    d.deps.measure=async()=>assert.fail('replay must not measure');
    const replay=await runTaskIntegration(d.ctx,request,d.deps);assert.equal(replay.perform,false,JSON.stringify(replay));assert.equal(d.ledger().revision,beforeReplay);
  });


for(const lost of [false,true])test('C2 pointer restored then interrupted '+(lost?'with lost receipt':'with held receipt')+' cannot create a third cycle',async t=>{
  const {d,result,actionId,plan,pointer,original,mode,fs,gitIo}=await pointerCleanupCut(t);
  const effect=d.deps.task.runTaskEffect;let restores=0,removes=0;
  d.deps.fs={...fs,writeFileExclusive:(...args)=>{restores++;return fs.writeFileExclusive(...args);}};
  d.deps.git={...gitIo,worktreeRemove:async()=>{removes++;assert.deepEqual(readFileSync(pointer),original);assert.equal(lstatSync(pointer).mode&0o777,mode);throw new Error('fixture interruption after exact restoration before Git removal');}};
  if(lost)d.deps.task={...d.deps.task,runTaskEffect:(ctx,input,deps)=>input.operation==='observe'&&input.receipt?.cleanupStep==='remove-resource'
    ?{ok:false,code:'CAPABILITY_GAP',message:'fixture lost restored-pointer observation',recovery:'explicit reconcile'}:effect(ctx,input,deps)};
  const request=integrationRequest(d,result,'discharge','pointer-restored-cut',actionId),cut=await runTaskIntegration(d.ctx,request,d.deps);
  assert.notEqual(cut.discharged,true);assert.equal(restores,1);assert.equal(removes,1);
  d.deps.task={...d.deps.task,runTaskEffect:effect};
  const rec=await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','pointer-restored-progress',actionId),d.deps);
  assert.notEqual(rec.discharged,true);if(lost)assert.equal(rec.cleanupStep,'reconcile-progress',JSON.stringify(rec));
  const exhausted=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','pointer-restored-no-third',actionId),d.deps);
  assert.equal(exhausted.ok,false,JSON.stringify(exhausted));assert.equal(restores,1);assert.equal(removes,1);
  assert.deepEqual(readFileSync(pointer),original);assert.equal(lstatSync(pointer).mode&0o777,mode);
  assert.ok(latestTaskEntity(d.ledger(),actionId).resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='retained'));
  assert.ok(existsSync(plan.backupDir));await assertRecoveryTargetFenced(d,'restored-pointer-'+lost);
});

