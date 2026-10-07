// Split from tests/plugin-desk-task-execution.test.mjs (part 2 of 4,
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

for (const partial of [false,true]) test(`EF-1 real Core+Git: ${partial?'partial':'full'} apply lost observe retains exact recovery plan and resources`,async t=>{
  const {d,result,actionId}=await correctionStaged(t);
  const effect=d.deps.task.runTaskEffect;
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    if(input.operation==='observe'&&input.actionKind==='integration'&&input.receipt.phase==='land')
      return {ok:false,code:'CAPABILITY_GAP',message:'fixture lost land observation',recovery:'reconcile exact action'};
    return effect(ctx,input,deps);
  }};
  if(partial){const copy=d.deps.fs.copyFile;d.deps.fs={...d.deps.fs,copyFile:(src,dst,mode)=>{
    if(dst===join(d.w.repo,'changed.txt'))throw new Error('fixture second apply fails');return copy(src,dst,mode);
  }};}
  const landed=await runTaskIntegration(d.ctx,integrationRequest(d,result,'land','correction-land',actionId),d.deps);
  assert.equal(landed.ok,false);const issued=latestTaskEntity(d.ledger(),actionId);
  assert.equal(issued.state,'issued');assert.ok(issued.recoveryPlan,'LAND INTENT pins recovery material before any target write');
  const plan=issued.recoveryPlan;
  assert.equal(existsSync(plan.backupDir),true);
  assert.equal(readFileSync(join(d.w.repo,'added.txt'),'utf8'),'added result\n');
  assert.equal(readFileSync(join(d.w.repo,'changed.txt'),'utf8'),partial?'before\n':'verified result\n');
  // A forged later receipt cannot change the already admitted immutable plan.
  const stableEffect=d.deps.task.runTaskEffect;
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    if(input.operation==='observe'&&input.receipt?.phase==='reconcile')input={...input,receipt:{...input.receipt,
      recoveryPlan:{...input.receipt.recoveryPlan,expectedCombined:{...input.receipt.recoveryPlan.expectedCombined,artifactSha256:'f'.repeat(64)}}}};
    return stableEffect(ctx,input,deps);
  }};
  const forged=await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','forged-plan',actionId),d.deps);
  assert.equal(forged.ok,false,JSON.stringify(forged));assert.equal(latestTaskEntity(d.ledger(),actionId).state,'issued');
  assert.deepEqual(latestTaskEntity(d.ledger(),actionId).recoveryPlan,plan);
  d.deps.task={...d.deps.task,runTaskEffect:stableEffect};
  const reconcileInput=integrationRequest(d,result,'reconcile','correction-reconcile',actionId);
  const reconciled=await runTaskIntegration(d.ctx,reconcileInput,d.deps);
  assert.equal(reconciled.ok,true,JSON.stringify(reconciled));
  const recovered=latestTaskEntity(d.ledger(),actionId);
  assert.deepEqual(recovered.recoveryPlan,plan);assert.deepEqual(recovered.target,issued.target,'fresh recovery target never overwrites original admission');
  assert.equal(recovered.receipt.recoveryClassification,partial?'partial':'full-applied');
  assert.equal(recovered.state,partial?'held':'observed');
  assert.equal(recovered.landed===null,partial);
  const measured=d.deps.measure, revision=d.ledger().revision, originalReceipt=JSON.parse(JSON.stringify(recovered.receipt));
  d.deps.measure=async()=>assert.fail('historical phase replay never remeasures');
  const fsIo=d.deps.fs, gitIo=d.deps.git, host=d.deps.host;
  const calls={create:d.host.calls.create.length,send:d.host.calls.send.length};
  d.deps.fs=Object.fromEntries(Object.keys(fsIo).map(key=>[key,()=>assert.fail(`replay must not probe adapter filesystem: ${key}`)]));
  d.deps.git=Object.fromEntries(Object.keys(gitIo).map(key=>[key,()=>assert.fail(`replay must not probe Git: ${key}`)]));
  d.deps.host=()=>assert.fail('replay must not probe SDK');
  const replay=await runTaskIntegration(d.ctx,reconcileInput,d.deps);
  assert.equal(replay.ok,true,JSON.stringify(replay));assert.equal(replay.perform,false);assert.equal(d.ledger().revision,revision);assert.deepEqual(latestTaskEntity(d.ledger(),actionId).receipt,originalReceipt,'receipt fields and measuredAt remain original');
  const changed=await runTaskIntegration(d.ctx,{...reconcileInput,expectedActionRevision:reconcileInput.expectedActionRevision+1},d.deps);
  assert.equal(changed.ok,false);assert.equal(d.ledger().revision,revision);
  d.deps.measure=measured;d.deps.fs=fsIo;d.deps.git=gitIo;d.deps.host=host;
  assert.deepEqual({create:d.host.calls.create.length,send:d.host.calls.send.length},calls);
  if(!partial){
    const remove=d.deps.fs.rmrf;
    d.deps.fs={...d.deps.fs,rmrf:path=>{if(path===plan.backupDir)throw new Error('fixture backup cleanup denied');return remove(path);}};
    const incomplete=await fixtureCleanup(d,result,actionId,'incomplete-cleanup');
    assert.equal(incomplete.discharged,false,JSON.stringify(incomplete));assert.ok(existsSync(plan.backupDir));
    assert.equal(latestTaskEntity(d.ledger(),actionId).state,'held');
    await assertRecoveryTargetFenced(d,'failed-cleanup');
    d.deps.fs={...d.deps.fs,rmrf:remove};
    const heldRevision=d.ledger().revision;
    const remeasured=await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','after-incomplete-cleanup',actionId),d.deps);
    assert.equal(remeasured.ok,false,JSON.stringify(remeasured));assert.equal(d.ledger().revision,heldRevision,'already-observed unchanged cleanup does not append unfunded progress');
    assert.equal(Object.hasOwn(remeasured,'landed'),false);assert.ok(existsSync(plan.backupDir));
  }
  const discharge=partial?await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','correction-discharge',actionId),d.deps):await fixtureCleanup(d,result,actionId,'correction-discharge');
  if(partial){
    assert.notEqual(discharge.discharged,true,JSON.stringify(discharge));
    assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
    assert.ok(d.ledger().taskEntries.some(r=>r.kind==='resource'&&r.actionId===actionId&&latestTaskEntity(d.ledger(),r.resourceId).disposition==='retained'));
    await d.define('other',{scope:scopeFor('other.txt')});
    const other=await runTaskDispatch(d.ctx,d.bootInput('other',{placement:{kind:'isolated',baseRef:d.w.head}}),d.deps);
    assert.equal(other.state,'bound',JSON.stringify(other));
    assert.equal((await runTaskDispatch(d.ctx,d.sendInput(other.attemptId,'send-other'),d.deps)).sent,true);
    const otherResult=await observeAndRuleTask(d,'other',other.attemptId,'other.txt','other result\n');
    const fenced=await runTaskIntegration(d.ctx,integrationRequest(d,otherResult,'stage','held-target-fence'),d.deps);
    assert.equal(fenced.ok,false,JSON.stringify(fenced));assert.equal(fenced.code,'SCOPE_CONFLICT','partial target still serializes other integrations');
  }else{
    assert.equal(discharge.discharged,true,JSON.stringify(discharge));
    assert.equal(existsSync(plan.stageDir),false);assert.equal(existsSync(plan.backupDir),false);
    assert.deepEqual([...discharge.removed].sort(),[plan.stageDir,plan.backupDir].sort());
  }
  assert.ok(existsSync(plan.targetOriginal.path));assert.ok(existsSync(plan.expectedCombined.path));assert.ok(existsSync(plan.manifestPath));
});


test('EF-2 backup: symlink x and file x.link restore exact bytes, link and permission bits',async t=>{
  const w=world(t);symlinkSync('kept.txt',join(w.repo,'x'));writeFileSync(join(w.repo,'x.link'),'original file\n');chmodSync(join(w.repo,'x.link'),0o640);
  const backupDir=join(w.scratch,'collision-backup');mkdirSync(backupDir);
  const delta={entries:[{path:'x',op:'modify',kind:'symlink',sha256:null,mode:0o777},{path:'x.link',op:'modify',kind:'file',sha256:null,mode:0o640}],changedPaths:['x','x.link'],digest:'fixture'};
  const manifest=backupDeltaPaths({fs:w.fs,targetRoot:w.repo,backupDir,delta});
  assert.equal(new Set(manifest.map(e=>e.blobKey)).size,2);
  assert.equal(manifest.find(e=>e.path==='x.link').mode,0o640);
  for(const e of manifest)assert.equal(lstatSync(join(backupDir,e.blobKey)).mode&0o777,0o600,'stored blob permissions differ from original target mode');
  rmSync(join(w.repo,'x'));symlinkSync('changed.txt',join(w.repo,'x'));writeFileSync(join(w.repo,'x.link'),'changed file\n');chmodSync(join(w.repo,'x.link'),0o600);
  restoreFromBackup({fs:w.fs,targetRoot:w.repo,backupDir,manifest});
  assert.equal(readlinkSync(join(w.repo,'x')),'kept.txt');assert.equal(readFileSync(join(w.repo,'x.link'),'utf8'),'original file\n');
  assert.equal(lstatSync(join(w.repo,'x.link')).mode&0o777,0o640);
});


test('EF-2 backup: tampered last blob refuses restore before the FIRST target mutation',async t=>{
  const w=world(t), backupDir=join(w.scratch,'tampered-backup');mkdirSync(backupDir);
  const delta={entries:['changed.txt','kept.txt'].map(path=>({path,op:'modify',kind:'file',sha256:null,mode:0o644})),changedPaths:['changed.txt','kept.txt'],digest:'fixture'};
  const manifest=backupDeltaPaths({fs:w.fs,targetRoot:w.repo,backupDir,delta});
  writeFileSync(join(w.repo,'changed.txt'),'new changed\n');writeFileSync(join(w.repo,'kept.txt'),'new kept\n');
  writeFileSync(join(backupDir,manifest.at(-1).blobKey),'tampered bytes\n');
  let writes=0;const fs={...w.fs,writeFile:(...args)=>{writes++;return w.fs.writeFile(...args);}};
  assert.throws(()=>restoreFromBackup({fs,targetRoot:w.repo,backupDir,manifest}),/BACKUP_INTEGRITY/);
  assert.equal(writes,0);assert.equal(readFileSync(join(w.repo,'changed.txt'),'utf8'),'new changed\n');
  assert.equal(readFileSync(join(w.repo,'kept.txt'),'utf8'),'new kept\n');
  assert.ok(existsSync(backupDir));
});


test('EF-1/2 real Core+Git: tampered backup blob blocks apply and cleanup, preserves admitted resources',async t=>{
  const {d,result,actionId}=await correctionStaged(t);
  const owned=adapterPaths(d.w.scratch,d.repoKey), write=d.deps.fs.writeFile;
  let targetWrites=0;const copy=d.deps.fs.copyFile;
  d.deps.fs={...d.deps.fs,copyFile:(src,dst,mode)=>{if(dst.startsWith(d.w.repo+'/'))targetWrites++;return copy(src,dst,mode);},
    writeFile:(path,bytes,mode)=>write(path,path.startsWith(owned.backup(actionId)+'/blobs/')?Buffer.from('tampered blob'):bytes,mode)};
  const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'land','tamper-land',actionId),d.deps);
  assert.equal(out.landed,false,JSON.stringify(out));assert.equal(targetWrites,0);
  const row=latestTaskEntity(d.ledger(),actionId);assert.equal(row.state,'held');assert.equal(row.landed,null);assert.ok(row.recoveryPlan);
  const reconciled=await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','tamper-reconcile',actionId),d.deps);
  assert.equal(reconciled.recoveryClassification,'unknown',JSON.stringify(reconciled));assert.equal(reconciled.backupIntegrity,false);
  const cleanup=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','tamper-cleanup',actionId),d.deps);
  assert.notEqual(cleanup.discharged,true);assert.equal(targetWrites,0);
  assert.ok(existsSync(row.recoveryPlan.stageDir));assert.ok(existsSync(row.recoveryPlan.backupDir));
  assert.equal(readFileSync(join(d.w.repo,'changed.txt'),'utf8'),'before\n');assert.equal(existsSync(join(d.w.repo,'added.txt')),false);
});


test('EF-1 real Core+Git: complete original target resolves no-apply without minting land',async t=>{
  const {d,result,actionId}=await correctionStaged(t), effect=d.deps.task.runTaskEffect, copy=d.deps.fs.copyFile;
  let writes=0;
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    if(input.operation==='observe'&&input.receipt?.phase==='land')return {ok:false,code:'CAPABILITY_GAP',message:'lost no-apply receipt',recovery:'reconcile'};
    return effect(ctx,input,deps);
  }};
  d.deps.fs={...d.deps.fs,copyFile:(src,dst,mode)=>{if(dst.startsWith(d.w.repo+'/')){writes++;throw new Error('first apply refused');}return copy(src,dst,mode);}};
  const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'land','original-land',actionId),d.deps);
  assert.equal(out.ok,false);assert.equal(writes,1);
  const plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan;assert.ok(plan);
  const recovered=await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','original-reconcile',actionId),d.deps);
  assert.equal(recovered.recoveryClassification,'original',JSON.stringify(recovered));assert.equal(recovered.landed,false);
  assert.equal(recovered.backupIntegrity,true);assert.equal(latestTaskEntity(d.ledger(),actionId).landed,null);
  assert.equal(readFileSync(join(d.w.repo,'changed.txt'),'utf8'),'before\n');assert.equal(existsSync(join(d.w.repo,'added.txt')),false);
  const cleaned=await fixtureCleanup(d,result,actionId,'original-cleanup');
  assert.equal(cleaned.discharged,true,JSON.stringify(cleaned));assert.equal(existsSync(plan.stageDir),false);assert.equal(existsSync(plan.backupDir),false);
  assert.equal(latestTaskEntity(d.ledger(),actionId).landed,null);assert.ok(existsSync(plan.targetOriginal.path));
});


for(const cut of ['stage-failure-backup-removed','partial-backup-delete-throw','partial-backup-delete-lost-observe'])test('EF-1-R1 '+cut,async t=>{
  const {d,result,actionId}=await c2Staged(t);
  const land=await runTaskIntegration(d.ctx,integrationRequest(d,result,'land','diag-land',actionId),d.deps);
  assert.equal(land.landed,true,JSON.stringify(land));
  const plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan;
  const before=await d.w.measure(d.w.repo);
  const originalFs=d.deps.fs,originalGit=d.deps.git,effect=d.deps.task.runTaskEffect;
  const verified=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','diag-verify',actionId),d.deps);
  assert.equal(verified.discharged,false,JSON.stringify(verified));assert.ok(latestTaskEntity(d.ledger(),actionId).cleanupVerification);
  if(cut!=='stage-failure-backup-removed'){
    const stageDone=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','diag-stage',actionId),d.deps);
    assert.equal(stageDone.discharged,false);assert.equal(existsSync(plan.stageDir),false);
  }
  let removalCalls=0,removedBlob=null;
  if(cut==='stage-failure-backup-removed')d.deps.git={...originalGit,worktreeRemove:async()=>{removalCalls++;throw new Error('fixture stage removal transient failure');}};
  else d.deps.fs={...originalFs,rmrf:path=>{
    removalCalls++;
    if(path===plan.backupDir){
      const manifest=JSON.parse(readFileSync(plan.manifestPath,'utf8'));
      removedBlob=join(plan.backupDir,manifest.entries.find(e=>e.existed).blobKey);
      originalFs.rmrf(removedBlob);
      throw new Error('fixture recursive backup deletion interrupted after one blob');
    }
    return originalFs.rmrf(path);
  }};
  if(cut.endsWith('lost-observe'))d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    if(input.operation==='observe'&&input.receipt?.phase==='discharge')return {ok:false,code:'CAPABILITY_GAP',message:'fixture cleanup observe lost',recovery:'reconcile explicit action'};
    return effect(ctx,input,deps);
  }};
  const cleanupInput=integrationRequest(d,result,'discharge','diag-first-cleanup',actionId);
  const first=await runTaskIntegration(d.ctx,cleanupInput,d.deps);
  assert.notEqual(first.discharged,true,'fault cannot release resources');
  const cutRow=latestTaskEntity(d.ledger(),actionId);
  const backupInventory=JSON.parse(readFileSync(plan.manifestPath,'utf8')).entries.filter(e=>e.existed).map(e=>({blobKey:e.blobKey,present:existsSync(join(plan.backupDir,e.blobKey))}));
  if(cut!=='stage-failure-backup-removed'){assert.equal(backupInventory.filter(e=>e.present).length,1,'one untouched backup blob survives');assert.equal(backupInventory.filter(e=>!e.present).length,1);}
  const afterCut={stage:existsSync(plan.stageDir),backup:existsSync(plan.backupDir),blob:removedBlob===null?null:existsSync(removedBlob)};
  assert.ok(cutRow.resourceIds.some(id=>latestTaskEntity(d.ledger(),id).disposition==='retained'));
  // Same admitted request replay may read history, never repeat deletion.
  let repeatEffects=0;d.deps.git={...originalGit,worktreeRemove:async()=>{repeatEffects++;assert.fail('blind replay stage removal');}};
  d.deps.fs={...originalFs,rmrf:()=>{repeatEffects++;assert.fail('blind replay recursive delete');}};
  d.deps.task={...d.deps.task,runTaskEffect:effect};
  const replay=await runTaskIntegration(d.ctx,cleanupInput,d.deps);
  assert.equal(replay.perform,false,JSON.stringify(replay));assert.equal(repeatEffects,0);
  d.deps.fs=originalFs;d.deps.git=originalGit;
  const fresh=await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','diag-fresh-reconcile',actionId),d.deps);
  const retry=await fixtureCleanup(d,result,actionId,'diag-fresh-granted-cleanup');
  assert.equal((await d.w.measure(d.w.repo)).sha256,before.sha256,'cleanup/recovery preserve complete target');
  console.log(JSON.stringify({probe:cut,first,cutState:cutRow.state,cutReceipt:cutRow.receipt,afterCut,backupInventory,removalCalls,replay,fresh,retry,
    final:{stage:existsSync(plan.stageDir),backup:existsSync(plan.backupDir),resources:cutRow.resourceIds.map(id=>({key:latestTaskEntity(d.ledger(),id).resourceKey,disposition:latestTaskEntity(d.ledger(),id).disposition}))}}));
  if(retry.discharged!==true)await assertRecoveryTargetFenced(d,'diag-'+cut);
  assert.equal(retry.discharged,true,'fresh explicit reconcile + newly granted cleanup must complete after transient fault; prior approved deletion is not unexplained tamper');
  assert.equal(existsSync(plan.stageDir),false);assert.equal(existsSync(plan.backupDir),false);
  assert.ok(cutRow.resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='released'));
});



test('cleanup inventory includes ignored material, empty directories, links, .git pointer and root mode without following links',async t=>{
  const w=world(t),root=join(w.scratch,'inventory');mkdirSync(root);chmodSync(root,0o750);
  mkdirSync(join(root,'empty'));chmodSync(join(root,'empty'),0o700);
  writeFileSync(join(root,'.git'),'gitdir: /fixture/admin\n');writeFileSync(join(root,'.gitignore'),'ignored.bin\n');
  writeFileSync(join(root,'ignored.bin'),Buffer.from([0,255,4]));symlinkSync('../repo',join(root,'outside-link'));
  const entries=JSON.parse(collectCleanupInventoryBytes(w.fs,root).toString());
  assert.deepEqual(entries.map(e=>e.path),['.','.git','.gitignore','empty','ignored.bin','outside-link']);
  assert.equal(entries[0].kind,'directory');assert.equal(entries[0].mode,0o750);
  assert.equal(entries.find(e=>e.path==='ignored.bin').sha256,sha256Hex(Buffer.from([0,255,4])));
  assert.equal(entries.find(e=>e.path==='outside-link').kind,'symlink');assert.equal(entries.find(e=>e.path==='outside-link').sha256,sha256Hex('../repo'));
  assert.equal(entries.some(e=>e.path.startsWith('outside-link/')),false);
});

test('cleanup inventory refuses file/entry/total caps and detects changing listings before proof can be admitted',async t=>{
  const w=world(t),root=join(w.scratch,'limits');mkdirSync(root);writeFileSync(join(root,'file'),'bytes');
  let reads=0;const fs={...w.fs,readFile:path=>{reads++;return w.fs.readFile(path);}};
  assert.throws(()=>collectCleanupInventoryBytes(fs,root,{maxStageEntries:4096,maxFileBytes:4,maxTotalBytes:64*1024*1024,maxDeltaPaths:512}),/INVENTORY_CAP/);
  assert.equal(reads,0,'oversized actual file is refused before read');
  assert.throws(()=>collectCleanupInventoryBytes(fs,root,{maxStageEntries:1,maxFileBytes:8,maxTotalBytes:64*1024*1024,maxDeltaPaths:512}),/INVENTORY_CAP/);
  assert.throws(()=>collectCleanupInventoryBytes(fs,root,{maxStageEntries:4096,maxFileBytes:8,maxTotalBytes:4,maxDeltaPaths:512}),/INVENTORY_CAP/);
  let lists=0;assert.throws(()=>collectCleanupInventoryBytes({...w.fs,listDirectory:path=>++lists===1?['file']:['file','new']},root),/INVENTORY_DRIFT/);
});


test('cleanup registration IO observes exact worktree metadata read-only',async t=>{
  const w=world(t),stage=join(w.scratch,'registered-stage');
  await w.git.worktreeAdd(w.repo,stage,w.head);
  const registration=await w.git.worktreeList(w.repo),gitDir=await w.git.absoluteGitDir(stage);
  assert.ok(registration.includes(`worktree ${stage}\0`));assert.ok(registration.includes(`HEAD ${w.head}\0`));
  assert.ok(gitDir.startsWith(join(w.repo,'.git','worktrees')+'/'));
  assert.equal((await w.git.commonDir(stage)),realpathSync(join(w.repo,'.git')));
  assert.equal(readFileSync(join(gitDir,'gitdir'),'utf8').trim(),join(stage,'.git'));
});


test('real Core create pins SDK requestId and adds only the returned action label without changing intent labels',async t=>{
  const d=await realDesk(t);await d.define();
  const input=d.bootInput(),boot=await runTaskDispatch(d.ctx,input,d.deps);assert.equal(boot.state,'bound',JSON.stringify(boot));
  const intent=d.ledger().taskEntries.find(r=>r.kind==='action'&&r.actionKind==='create'&&r.state==='intended');
  const opts=d.host.calls.create[0];assert.ok(intent);
  assert.equal(opts.requestId,intent.body.hostRequestId);assert.equal(opts.idempotencyKey,intent.body.idempotencyKey);
  assert.deepEqual(opts.labels,{...intent.body.labels,'slp.create-action':intent.actionId});
  assert.equal(Object.hasOwn(intent.body.labels,'slp.create-action'),false,'immutable original labels are preserved');
  assert.equal(Object.hasOwn(opts,'prompt'),false);const before=d.host.calls.create.length;
  const replay=await runTaskDispatch(d.ctx,input,d.deps);assert.equal(replay.perform,false,JSON.stringify(replay));
  assert.equal(d.host.calls.create.length,before);
});


for(const lost of [false,true])test(`C2 real Core: ${lost?'lost':'normal observed'} LAND uses explicit verification then stage then backup with measured row costs`,async t=>{
  const {d,result,actionId}=await c2LandResolved(t,{lost}),start=d.ledger(),row=latestTaskEntity(start,actionId),plan=row.recoveryPlan;
  const before=await d.w.measure(d.w.repo);
  for(const [step,label] of ['verify','stage','backup'].entries()) {
    const input=integrationRequest(d,result,'discharge',`c2-normal-${label}`,actionId);
    const out=await runTaskIntegration(d.ctx,input,d.deps);assert.equal(out.ok,true,JSON.stringify(out));
    assert.equal(out.discharged,step===2,'one public phase cannot run another resource cycle');
    assert.equal(existsSync(plan.stageDir),step===0);assert.equal(existsSync(plan.backupDir),step<2);
    const action=latestTaskEntity(d.ledger(),actionId);
    assert.ok(action.cleanupVerification,'verified account exists before first destructive permit');
    assert.equal(Object.hasOwn(action.receipt,'recoveryClassification'),false,'cleanup does not manufacture LAND proof');
    assert.equal(Object.hasOwn(action.receipt,'backupIntegrity'),false);assert.equal(Object.hasOwn(action.receipt,'recoveredLand'),false);
  }
  const after=d.ledger();assert.equal(after.requests.length-start.requests.length,9,'three cycles × intent/issue/observe');
  assert.equal(after.taskEntries.length-start.taskEntries.length,11,'nine action rows plus exactly two resource releases');
  assert.equal((await d.w.measure(d.w.repo)).sha256,before.sha256);assert.ok(existsSync(plan.manifestPath));assert.ok(existsSync(plan.targetOriginal.path));
});


test('C2 real Core: stage-only remains one known resource, no fabricated LAND classification',async t=>{
  const {d,result,actionId}=await c2Staged(t),start=d.ledger(),row=latestTaskEntity(start,actionId);
  assert.equal(row.recoveryPlan,null);assert.equal(row.resourceIds.length,1);
  const verified=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','stage-only-verify',actionId),d.deps);
  assert.equal(verified.discharged,false);assert.ok(existsSync(row.stageDir));
  const account=latestTaskEntity(d.ledger(),actionId).cleanupVerification;
  assert.equal(account.candidate.basis,'stage-only');assert.equal(account.candidate.sourceProofKind,'stage-observed');assert.equal(account.candidate.recoveryPlanSha256,null);
  const removed=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','stage-only-remove',actionId),d.deps);
  assert.equal(removed.discharged,true,JSON.stringify(removed));assert.equal(existsSync(row.stageDir),false);assert.equal(latestTaskEntity(d.ledger(),actionId).landed,null);
  assert.equal(d.ledger().requests.length-start.requests.length,6);assert.equal(d.ledger().taskEntries.length-start.taskEntries.length,7);
});


for(const cut of ['issue-denied','write-missing','write-prefix','write-nonprefix','observe-lost'])test('C2 verification boundary '+cut,async t=>{
  const {d,result,actionId}=await c2LandResolved(t),plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan;
  const fs=d.deps.fs,effect=d.deps.task.runTaskEffect;let writes=0;
  d.deps.fs={...fs,writeFile:(path,bytes,mode)=>{
    if(path.endsWith('/cleanup-account.v1.json')){
      writes++;
      if(cut==='write-missing')throw new Error('fixture proof write absent');
      if(cut==='write-prefix'){fs.writeFile(path,bytes.subarray(0,Math.floor(bytes.length/2)),mode);throw new Error('fixture partial prefix write');}
      if(cut==='write-nonprefix'){fs.writeFile(path,Buffer.from('wrong non-prefix bytes'),mode);throw new Error('fixture non-prefix write');}
    }
    return fs.writeFile(path,bytes,mode);
  }};
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    if(input.operation==='issue'&&cut==='issue-denied'&&latestTaskEntity(d.ledger(),actionId).body?.cleanupStep==='verify-account')return {ok:true,perform:false};
    if(input.operation==='observe'&&input.receipt?.cleanupStep==='verify-account'&&cut==='observe-lost')return {ok:false,code:'CAPABILITY_GAP',message:'lost verification observation',recovery:'explicit reconcile'};
    return effect(ctx,input,deps);
  }};
  const request=integrationRequest(d,result,'discharge','verify-boundary-first',actionId),first=await runTaskIntegration(d.ctx,request,d.deps);
  assert.notEqual(first.discharged,true);assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
  assert.equal(latestTaskEntity(d.ledger(),actionId).cleanupVerification??null,null);
  assert.equal(writes,cut==='issue-denied'?0:1);
  d.deps.fs=fs;d.deps.task={...d.deps.task,runTaskEffect:effect};
  if(cut==='observe-lost'){
    const recovered=await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','verify-lost-reconcile',actionId),d.deps);
    assert.equal(recovered.ok,true,JSON.stringify(recovered));assert.ok(latestTaskEntity(d.ledger(),actionId).cleanupVerification);
  }else if(cut==='write-nonprefix'){
    const refused=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','verify-nonprefix-continuation',actionId),d.deps);
    assert.notEqual(refused.discharged,true);assert.equal(latestTaskEntity(d.ledger(),actionId).cleanupVerification??null,null);
  }else{
    const continuation=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','verify-exact-continuation',actionId),d.deps);
    assert.equal(continuation.ok,true,JSON.stringify(continuation));assert.equal(continuation.discharged,false);
    assert.ok(latestTaskEntity(d.ledger(),actionId).cleanupVerification,'sole proof continuation verifies exact original bytes');
  }
  assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
});


test('C2 real Core: two TOTAL verification cycles exhaust without any destructive permit',async t=>{
  const {d,result,actionId}=await c2LandResolved(t),plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan,fs=d.deps.fs;
  let writes=0,removes=0;d.deps.fs={...fs,writeFile:(path,bytes,mode)=>{if(path.endsWith('/cleanup-account.v1.json')){writes++;throw new Error('continued bounded proof write failure');}return fs.writeFile(path,bytes,mode);},rmrf:()=>{removes++;assert.fail('unverified account may not remove');}};
  d.deps.git={...d.deps.git,worktreeRemove:async()=>{removes++;assert.fail('unverified account may not remove worktree');}};
  for(let cycle=0;cycle<2;cycle++){
    const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge',`verify-cycle-${cycle}`,actionId),d.deps);
    assert.notEqual(out.discharged,true);assert.equal(latestTaskEntity(d.ledger(),actionId).cleanupVerification??null,null);
  }
  const denied=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','verify-cycle-exhausted',actionId),d.deps);
  assert.equal(denied.ok,false,JSON.stringify(denied));assert.equal(writes,2);assert.equal(removes,0);
  assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
});


for(const drift of ['missing-leaf','survivor-mode','unexpected-path','target-head','source-result','bundle-bytes','forged-permit'])test('C2 pre-ISSUE '+drift+' denies zero deletion',async t=>{
  const {d,result,actionId}=await c2LandResolved(t),plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan;
  assert.equal((await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','preissue-verify',actionId),d.deps)).discharged,false);
  const effect=d.deps.task.runTaskEffect,fs=d.deps.fs,gitIo=d.deps.git;let deletes=0;
  d.deps.fs={...fs,rmrf:()=>{deletes++;assert.fail('preissue tamper permits no deletion');}};
  d.deps.git={...gitIo,worktreeRemove:async()=>{deletes++;assert.fail('preissue tamper permits no worktree deletion');}};
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    if(input.operation==='intent'&&input.body?.cleanupStep==='remove-resource'&&drift==='forged-permit')input={...input,body:{...input.body,permit:{...input.body.permit,expectedResourceRevision:input.body.permit.expectedResourceRevision+1}}};
    if(input.operation==='issue'&&latestTaskEntity(d.ledger(),actionId).body?.cleanupStep==='remove-resource'){
      if(drift==='missing-leaf')rmSync(join(plan.stageDir,'changed.txt'));
      if(drift==='survivor-mode')chmodSync(join(plan.stageDir,'changed.txt'),0o600);
      if(drift==='unexpected-path')writeFileSync(join(plan.stageDir,'unexpected'),'unexpected bytes');
      if(drift==='target-head')git(d.w.repo,['commit','--allow-empty','-m','fixture changed HEAD']);
      if(drift==='source-result')writeFileSync(join(latestTaskEntity(d.ledger(),actionId).sourceCwd,'changed.txt'),'changed source bytes');
      if(drift==='bundle-bytes')writeFileSync(latestTaskEntity(d.ledger(),actionId).cleanupVerification.candidate.artifact.path,'forged bundle');
    }
    return effect(ctx,input,deps);
  }};
  const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','preissue-remove',actionId),d.deps);
  assert.notEqual(out.discharged,true,JSON.stringify(out));assert.equal(deletes,0);
  assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
  assert.ok(latestTaskEntity(d.ledger(),actionId).resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='retained'));
});

