// Split from tests/plugin-desk-task-execution.test.mjs (part 1 of 4,
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

test('isolated placement materializes a real worktree at the pinned base', async t => {
  const w = world(t);
  const scratchDir = adapterPaths(w.scratch, 'repo-key').placements('att-1');
  const placed = await materializeIsolatedPlacement({
    fs: w.fs, git: w.git, repoRoot: w.repo, scratchDir, baseRef: w.head,
  });
  assert.equal(realpathSync(placed.cwd), realpathSync(scratchDir));
  assert.equal(placed.head, w.head);
  assert.equal(readFileSync(join(placed.cwd, 'kept.txt'), 'utf8'), 'kept\n');
  // Same git common dir ⇒ same repository — the shared-checkout invariant.
  const common = await w.git.commonDir(placed.cwd);
  assert.equal(common, realpathSync(join(w.repo, '.git')));
  await removeIsolatedPlacement({ git: w.git, repoRoot: w.repo, scratchDir: placed.cwd });
});


test('worktree placement rejects base refs that do not resolve', async t => {
  const w = world(t);
  await assert.rejects(() => materializeIsolatedPlacement({
    fs: w.fs, git: w.git, repoRoot: w.repo,
    scratchDir: adapterPaths(w.scratch, 'repo-key').placements('att-x'),
    baseRef: 'deadbeef'.repeat(5),
  }));
});


test('delta is BASE→RESULT and preserves modes, deletions and symlinks', async t => {
  const w = world(t);
  const base = await w.measure(w.repo);
  const scratchDir = adapterPaths(w.scratch, 'repo-key').placements('att-2');
  const placed = await materializeIsolatedPlacement({
    fs: w.fs, git: w.git, repoRoot: w.repo, scratchDir, baseRef: w.head,
  });
  evolveSource(placed.cwd);
  const result = await w.measure(placed.cwd);
  const delta = computeDelta(base, result);
  const paths = new Set(delta.changedPaths);
  for (const p of ['changed.txt', 'added.txt', 'deleted.txt', 'script.sh', 'link.txt']) {
    assert.ok(paths.has(p), `expected ${p} in delta, got ${[...paths]}`);
  }
  assert.ok(!paths.has('kept.txt'));
  const del = delta.entries.find(e => e.path === 'deleted.txt');
  assert.equal(del.op, 'delete');
  const link = delta.entries.find(e => e.path === 'link.txt');
  assert.equal(link.op, 'modify');
  assert.equal(link.kind, 'symlink');
  const mode = delta.entries.find(e => e.path === 'script.sh');
  assert.equal(mode.mode, 0o644);
});


test('constrainDelta rejects out-of-grant paths', async t => {
  const w = world(t);
  const base = await w.measure(w.repo);
  writeFileSync(join(w.repo, 'granted.txt'), 'g\n');
  writeFileSync(join(w.repo, 'sneaky.txt'), 's\n');
  const result = await w.measure(w.repo);
  const delta = computeDelta(base, result);
  const confined = constrainDelta(delta, ['granted.txt']);
  assert.equal(confined.ok, false);
  assert.deepEqual(confined.paths, ['sneaky.txt']);
  const ok = constrainDelta(delta, ['granted.txt', 'sneaky.txt']);
  assert.equal(ok.ok, true);
});


test('three-way: clean apply, dirty-target conflict, equal-result noop', async t => {
  const w = world(t);
  const base = await w.measure(w.repo);
  const scratchDir = adapterPaths(w.scratch, 'repo-key').placements('att-3');
  const placed = await materializeIsolatedPlacement({
    fs: w.fs, git: w.git, repoRoot: w.repo, scratchDir, baseRef: w.head,
  });
  evolveSource(placed.cwd);
  const result = await w.measure(placed.cwd);
  const delta = computeDelta(base, result);

  // (a) Clean target — everything applies.
  const clean = threeWay(base, result, base, delta);
  assert.equal(clean.conflicts.length, 0);
  assert.equal(clean.apply.length, 5);
  assert.equal(clean.noop.length, 0);

  // (b) Target diverged on the same path — conflict, both sides kept.
  const targetRepo = join(w.dir, 'target');
  git(w.repo, ['worktree', 'add', targetRepo, w.head]);
  t.after(() => { try { git(w.repo, ['worktree', 'remove', '--force', targetRepo]); } catch {} });
  writeFileSync(join(targetRepo, 'changed.txt'), 'target-won\n');
  const diverged = await w.measure(targetRepo);
  const plan = threeWay(base, result, diverged, delta);
  const conflictPaths = plan.conflicts.map(c => c.path);
  assert.deepEqual(conflictPaths, ['changed.txt']);
  assert.equal(plan.apply.length, 4);
  // Target's own write is preserved in the fresh measure.
  assert.equal(readFileSync(join(targetRepo, 'changed.txt'), 'utf8'), 'target-won\n');

  // (c) Target already holds the result — noop, nothing to apply.
  const targetEqual = join(w.dir, 'target-eq');
  git(w.repo, ['worktree', 'add', targetEqual, w.head]);
  t.after(() => { try { git(w.repo, ['worktree', 'remove', '--force', targetEqual]); } catch {} });
  evolveSource(targetEqual);
  const equal = await w.measure(targetEqual);
  const planEq = threeWay(base, result, equal, delta);
  assert.equal(planEq.conflicts.length, 0);
  assert.equal(planEq.apply.length, 0);
  assert.equal(planEq.noop.length, 5);
});


test('stage → verify → backup → apply → restore round-trips a real target', async t => {
  const w = world(t);
  const base = await w.measure(w.repo);
  const scratchDir = adapterPaths(w.scratch, 'repo-key').placements('att-4');
  const placed = await materializeIsolatedPlacement({
    fs: w.fs, git: w.git, repoRoot: w.repo, scratchDir, baseRef: w.head,
  });
  evolveSource(placed.cwd);
  const result = await w.measure(placed.cwd);
  const delta = computeDelta(base, result);

  // Target checkout with preserved prior dirty work on an unrelated path.
  const target = join(w.dir, 'target');
  git(w.repo, ['worktree', 'add', target, w.head]);
  t.after(() => { try { git(w.repo, ['worktree', 'remove', '--force', target]); } catch {} });
  writeFileSync(join(target, 'prior-work.txt'), 'mine\n');
  const targetMeasure = await w.measure(target);
  const plan = threeWay(base, result, targetMeasure, delta);
  assert.equal(plan.conflicts.length, 0);

  // Stage into owned scratch as a git worktree — a real repo context.
  const paths = adapterPaths(w.scratch, 'repo-key');
  const stageDir = paths.stage('int-1');
  w.fs.ensureEmptyDir(stageDir);
  await w.git.worktreeAdd(target, stageDir, targetMeasure.head);
  const worktreePaths = await w.git.lsFiles(stageDir, { cached: true });
  materializeStage({
    fs: w.fs, stageRoot: stageDir, stageKind: 'git-worktree', worktreePaths,
    targetRoot: target, targetBase: targetMeasure,
    sourceRoot: placed.cwd, delta,
  });
  const stageMeasure = await w.measure(stageDir);
  const expected = expectedStageMap(targetMeasure, delta);
  const match = stageMatches(stageMeasure, expected);
  assert.equal(match.ok, true, JSON.stringify(match.mismatches));

  // Backup, apply, final measure — prior dirty work preserved.
  const backupDir = paths.backup('int-1');
  w.fs.ensureEmptyDir(backupDir);
  const manifest = backupDeltaPaths({
    fs: w.fs, targetRoot: target, backupDir, delta,
  });
  assert.ok(Array.isArray(manifest));
  const applied = applyDeltaToTarget({
    fs: w.fs, targetRoot: target, sourceRoot: placed.cwd, apply: plan.apply,
  });
  assert.equal(applied.applied.length, 5);
  const finalMeasure = await w.measure(target);
  const finalCheck = stageMatches(finalMeasure, expected);
  assert.equal(finalCheck.ok, true, JSON.stringify(finalCheck.mismatches));
  assert.equal(readFileSync(join(target, 'prior-work.txt'), 'utf8'), 'mine\n');
  assert.equal((lstatSync(join(target, 'script.sh')).mode & 0o777), 0o644);
  assert.equal(readlinkSync(join(target, 'link.txt')), 'changed.txt');
  assert.equal(lstatSync(join(target, 'deleted.txt'), { throwIfNoEntry: false }), undefined);
  // Backups preserved until explicit discharge — never auto-deleted.
  assert.equal(readFileSync(join(backupDir, manifest.find(e=>e.path==='changed.txt').blobKey), 'utf8'), 'before\n');
  assert.ok(manifest.length >= 4, 'touched paths backed up');

  // Restore returns the target to its pre-landing bytes.
  restoreFromBackup({ fs: w.fs, targetRoot: target, backupDir, manifest });
  const restored = await w.measure(target);
  const restoredCheck = stageMatches(restored, expectedStageMap(targetMeasure, { digest: '', changedPaths: [], entries: [] }));
  assert.equal(readFileSync(join(target, 'changed.txt'), 'utf8'), 'before\n');
  assert.equal((lstatSync(join(target, 'script.sh')).mode & 0o777), 0o755);
  assert.equal(readlinkSync(join(target, 'link.txt')), 'kept.txt');
  assert.ok(lstatSync(join(target, 'deleted.txt')).isFile());
  assert.equal(restoredCheck.ok, true, JSON.stringify(restoredCheck.mismatches));
});


test('content-map measure is typed distinctly from git snapshots', async t => {
  const w = world(t);
  const contentDir = join(w.dir, 'content');
  mkdirSync(contentDir);
  writeFileSync(join(contentDir, 'a.txt'), 'a\n');
  const measure = createContentMapMeasure(w.fs);
  const map = await measure(contentDir);
  assert.equal(map.kind, 'content-map');
  assert.equal(map.head, null);
  assert.equal(map.entries.length, 1);
  // A git measure of the same content is never the same kind.
  const gitMeasure = await w.measure(w.repo);
  assert.equal(gitMeasure.kind, 'git-snapshot');
});


test('scanUnsupported flags gitlinks and non-file shapes typed', async t => {
  const w = world(t);
  const base = await w.measure(w.repo);
  assert.equal(scanUnsupported([{ label: 'x', measure: base }]).length, 0);
  const withLink = {
    ...base,
    entries: [...base.entries, { path: 'sub', kind: 'gitlink', indexOid: 'a'.repeat(40), headOid: null, state: 'clean' }],
  };
  const flagged = scanUnsupported([{ label: 'x', measure: withLink }]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].path, 'sub');
});


test('measurement refuses nested repositories instead of dropping their bytes', async t => {
  const w = world(t);
  const nested = join(w.repo, 'nested');
  mkdirSync(nested);
  git(nested, ['init', '-b', 'main']);
  writeFileSync(join(nested, 'inner.txt'), 'nested proof\n');
  git(nested, ['add', '-A']);
  git(nested, ['commit', '-m', 'base']);
  assert.equal(snapshot(w.repo).nested.length, 1);
  await assert.rejects(() => w.measure(w.repo), error =>
    error.code === 'INTEGRATION_UNSUPPORTED' && /nested/.test(error.message));
});


test('measurement refuses incomplete and unknown snapshot entries', async t => {
  const w = world(t);
  const base = snapshot(w.repo);
  for (const change of [
    { incomplete: ['unproven'] },
    { files: [...base.files, { path: 'device', kind: 'device' }] },
    { files: [...base.files, { path: '../escape', kind: 'file', mode: 0o644, sha256: 'a'.repeat(64) }] },
    { nested: [{ path: 'n', files: [] }] },
  ]) {
    await assert.rejects(() => createDirectMeasure(() => ({ ...base, ...change }))(w.repo),
      error => error.code === 'INTEGRATION_UNSUPPORTED');
  }
});


test('suboperation identities stay bounded and distinct for maximum length requests', () => {
  const request = 'r'.repeat(128);
  const ids = ['reserve', 'create-intent', 'create-issue', 'create-observe', 'bind']
    .map(site => subRequestId(request, site));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id.length <= 128));
  assert.equal(ids[2], subRequestId(request, 'create-issue'));
});


test('Git reference maps retain binary bytes and executable class without dirty checkout claims', async t => {
  const w = world(t);
  const bytes = Buffer.from([0, 255, 128, 1, 2]);
  writeFileSync(join(w.repo,'binary.bin'),bytes);
  git(w.repo,['add','binary.bin']);git(w.repo,['commit','-m','fixture binary']);
  const ref=git(w.repo,['rev-parse','HEAD']);
  writeFileSync(join(w.repo,'binary.bin'),'dirty unrelated bytes');
  const measured=await w.git.measureReference(w.repo,ref);
  assert.equal(measured.kind,'git-reference');
  assert.equal(measured.root,realpathSync(w.repo));
  assert.equal(measured.reference.modeSemantics,'git-tree-executable-class');
  assert.equal(measured.entries.find(e=>e.path==='binary.bin').sha256,sha256Hex(bytes));
  assert.equal(measured.entries.find(e=>e.path==='script.sh').mode,0o755);
  assert.equal(measured.reference.mapSha256,measureMapSha256(measured));
  assert.notEqual(measured.sha256,(await w.measure(w.repo)).sha256);
});

// ---------------------------------------------------------------------------
// Bounded argv exec.
// ---------------------------------------------------------------------------


test('boundedArgv reports pass/fail/timeout/byte-cap typed', async t => {
  const exec = boundedArgv();
  const pass = await exec(process.execPath, ['-e', 'process.exit(0)'], { limits: { timeoutMs: 5000, maxOutputBytes: 4096 } });
  assert.equal(pass.status, 'passed');
  assert.equal(pass.exitCode, 0);
  const fail = await exec(process.execPath, ['-e', 'process.exit(3)'], { limits: { timeoutMs: 5000, maxOutputBytes: 4096 } });
  assert.equal(fail.status, 'failed');
  assert.equal(fail.exitCode, 3);
  const timeout = await exec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { limits: { timeoutMs: 300, maxOutputBytes: 4096 } });
  assert.equal(timeout.status, 'timeout');
  const capped = await exec(process.execPath, ['-e', 'process.stdout.write("x".repeat(1 << 20))'], { limits: { timeoutMs: 15000, maxOutputBytes: 1024 } });
  assert.ok(capped.status === 'byte-cap' || capped.status === 'failed');
  assert.notEqual(capped.status, 'passed');
});

// ---------------------------------------------------------------------------
// Orchestration against a recording Core double.
// ---------------------------------------------------------------------------


test('SDK 0.10 fixture converts create options to the native before-hook DTO',()=>{
  const opts={requestId:'host-create-1',idempotencyKey:'key-1',labels:{'slp.task':'task-1'},cwd:'/source',
    parent:{id:'agent-owner'},title:'bounded seat',config:{provider:'slp-codex-peer/model/variant',
      modeId:'full-access',thinkingOptionId:'high',featureValues:{bounded:true},options:{fixture:true}}};
  const raw=fixtureNativeCreateRequest(opts,{workspaceId:'workspace-1',cwd:'/placed'});
  assert.deepEqual(raw,{requestId:'host-create-1',idempotencyKey:'key-1',labels:{'slp.task':'task-1'},
    config:{provider:'slp-codex-peer',model:'model/variant',cwd:'/placed',title:'bounded seat',
      modeId:'full-access',thinkingOptionId:'high',featureValues:{bounded:true},providerOptions:{fixture:true}},
    workspaceId:'workspace-1',callerAgentId:'agent-owner'});
  assert.equal(Object.hasOwn(raw,'parent'),false);assert.equal(Object.hasOwn(raw,'initialPrompt'),false);
  assert.equal(opts.config.provider,'slp-codex-peer/model/variant','conversion does not mutate admitted SDK options');
  assert.deepEqual(fixtureNativeCreateRequest({cwd:'/source',parent:'owner-2',prompt:'ordinary prompt',config:{provider:'codex/model'}}),
    {config:{provider:'codex',model:'model',cwd:'/source'},callerAgentId:'owner-2',initialPrompt:'ordinary prompt'});
  assert.throws(()=>fixtureNativeCreateRequest({cwd:'/source',config:{provider:'codex/'}}),/provider\/model/);
});


test('managed create transports one opaque ticket and persists only its digest',async t=>{
  const w=world(t),ledger=fixtureLedger(w),core=coreDouble(ledger),host=fixtureHost();
  const deps=fixtureDeps(w,ledger,host.api,core.task);
  const request=bootstrapInput({placement:{kind:'shared-checkout',cwd:w.repo,baseRef:'HEAD'}});
  const out=await mechanicalDispatch(fixtureCtx(),request,deps);assert.equal(out.ok,true,JSON.stringify(out));
  const opts=host.calls.create[0],ticket=opts.env?.SLP_TASK_CREATE_TICKET;
  assert.match(ticket??'',/^[a-f0-9]{64}$/);assert.deepEqual(Object.keys(opts.env),['SLP_TASK_CREATE_TICKET']);
  const intent=core.calls.find(c=>c.operation==='intent'&&c.actionKind==='create');
  assert.equal(intent.body.createTicketSha256,sha256Hex(ticket));
  assert.equal(JSON.stringify(core.calls).includes(ticket),false,'raw carrier never reaches Core requests or receipts');
  const count=host.calls.create.length;const replay=await mechanicalDispatch(fixtureCtx(),request,deps);
  assert.equal(replay.perform,false);assert.equal(host.calls.create.length,count);
});


test('managed create redacts its exact ticket before SDK error truncation or receipt persistence',async t=>{
  const w=world(t),ledger=fixtureLedger(w),core=coreDouble(ledger),host=fixtureHost();
  let raw=null;host.api.agents.create=async opts=>{
    raw=opts.env?.SLP_TASK_CREATE_TICKET??'missing-carrier';
    throw new Error('x'.repeat(480)+raw+' echoed SDK opts/env '+raw);
  };
  const out=await mechanicalDispatch(fixtureCtx(),bootstrapInput({placement:{kind:'shared-checkout',cwd:w.repo,baseRef:'HEAD'}}),fixtureDeps(w,ledger,host.api,core.task));
  assert.match(raw,/^[a-f0-9]{64}$/);assert.equal(out.state,'uncertain');
  assert.equal(JSON.stringify({out,calls:core.calls}).includes(raw),false);
  assert.equal(out.error.includes(raw.slice(0,24)),false,'redaction precedes truncation of a crossing secret');
  assert.ok(out.error.includes('[REDACTED]'));
});


test('managed create redacts a ticket echoed by post-create refresh before storing verification errors',async t=>{
  const w=world(t),ledger=fixtureLedger(w),core=coreDouble(ledger),host=fixtureHost();
  const create=host.api.agents.create;let raw=null;
  host.api.agents.create=async opts=>{
    raw=opts.env.SLP_TASK_CREATE_TICKET;const handle=await create(opts);
    host.api.agents.ref=id=>({...handle,id,refresh:async()=>{throw new Error('z'.repeat(96)+raw+' refresh echo');}});
    return handle;
  };
  const out=await mechanicalDispatch(fixtureCtx(),bootstrapInput({placement:{kind:'shared-checkout',cwd:w.repo,baseRef:'HEAD'}}),fixtureDeps(w,ledger,host.api,core.task));
  assert.equal(out.state,'uncertain');assert.match(raw,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify({out,calls:core.calls}).includes(raw),false);
  assert.equal(out.verification.mismatches.join(',').includes(raw.slice(0,24)),false);
  assert.ok(out.verification.mismatches.join(',').includes('[REDACTED]'));
});


test('managed create accepts extra host labels while checking every reserved label',async t=>{
  const w=world(t),ledger=fixtureLedger(w),core=coreDouble(ledger),host=fixtureHost();
  const create=host.api.agents.create;
  host.api.agents.create=async opts=>{
    const handle=await create(opts),refresh=handle.refresh;
    host.api.agents.ref=id=>({...handle,id,refresh:async()=>{const result=await refresh();return {...result,agent:{...result.agent,labels:{...result.agent.labels,'host.extra':'native-metadata'}}};}});
    return handle;
  };
  const out=await mechanicalDispatch(fixtureCtx(),bootstrapInput({placement:{kind:'shared-checkout',cwd:w.repo,baseRef:'HEAD'}}),fixtureDeps(w,ledger,host.api,core.task));
  assert.equal(out.state,'seat-pending',JSON.stringify(out));assert.equal(host.calls.create.length,1);assert.equal(host.calls.send.length,0);
});


for(const key of ['slp.repo','slp.task','slp.attempt','slp.assignment','slp.create-action'])test('managed bootstrap requires positive '+key+' before bind',async t=>{
  const w=world(t),ledger=fixtureLedger(w),core=coreDouble(ledger),host=fixtureHost();
  const create=host.api.agents.create;
  host.api.agents.create=async opts=>{
    const handle=await create(opts),refresh=handle.refresh;
    host.api.agents.ref=id=>({...handle,id,refresh:async()=>{const result=await refresh();return {...result,agent:{...result.agent,labels:{...result.agent.labels,[key]:'foreign-value'}}};}});
    return handle;
  };
  const out=await mechanicalDispatch(fixtureCtx(),bootstrapInput({placement:{kind:'shared-checkout',cwd:w.repo,baseRef:'HEAD'}}),fixtureDeps(w,ledger,host.api,core.task));
  assert.equal(out.state,'uncertain',JSON.stringify(out));assert.ok(out.verification.mismatches.some(item=>item.startsWith('label:'+key+':')));
  assert.equal(core.calls.some(call=>call.operation==='bind'),false);assert.equal(host.calls.send.length,0);
});


test('bootstrap: shared checkout → reserve → place → create(no prompt) → verify → bind', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const input = bootstrapInput({ placement: { kind: 'shared-checkout', cwd: w.repo, baseRef: 'HEAD' } });
  const out = await mechanicalDispatch(fixtureCtx(), input, deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.state, 'seat-pending'); // no membership registered yet — never auto-writable
  assert.equal(out.agentId, 'agent-new');

  // Durable sequence: reserve, place observe (verify-only — no host
  // effect), create intent+issue+observe. Bind needs a registered
  // membership — absent here, so it never reaches Core.
  const ops = core.calls.map(c => c.operation);
  assert.deepEqual(ops, ['reserve', 'issue', 'observe', 'intent', 'issue', 'observe']);

  // Bootstrap creation carries NO work prompt — ever.
  assert.equal(host.calls.create.length, 1);
  const created = host.calls.create[0];
  assert.equal('prompt' in created, false);
  assert.equal('initialPrompt' in created, false);
  assert.equal('clientMessageId' in created, false);
  assert.equal('workspaceId' in created, false); // not a 0.10 create field
  assert.equal(created.cwd, realpathSync(w.repo));
  assert.equal(created.parent, 'agent-owner');
  assert.equal(created.config.provider, 'slp-codex-peer/m1');
  assert.match(created.idempotencyKey, /^slp-task-create-/);
});


test('bootstrap isolated: materializes desk worktree and measures BASE', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const input = bootstrapInput({
    requestId: 'req-iso-1',
    placement: { kind: 'isolated', baseRef: w.head },
  });
  const out = await mechanicalDispatch(fixtureCtx(), input, deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  const created = host.calls.create[0];
  const placedDir = adapterPaths(w.scratch, REPO_KEY).placements('att-1');
  assert.equal(created.cwd, realpathSync(placedDir));
  // Intent-time resource obligations ride the create intent.
  const createIntent = core.calls.find(c => c.operation === 'intent' && c.actionKind === 'create');
  assert.ok(createIntent.body.resourceIntents.includes('worktree-remove'));
  // The BASE measure artifact landed under the attempt scope for stage.
  const artifact = join(placedDir.replace(/\/placements\/att-1$/, ''), 'attempts', 'att-1', 'base.measure.json');
  const artifactBytes = readFileSync(artifact);
  assert.ok(artifactBytes.toString().includes('"sha256"'));
  // The durable sourceBase pin binds the persisted BYTES, not the
  // artifact's self-declared sha.
  assert.equal(createIntent.body.sourceBase.artifactSha256, sha256Hex(artifactBytes));
});


test('route drift between reserve and create fails closed', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  let call = 0;
  const deps = fixtureDeps(w, ledger, host.api, core.task, {
    resolveSeat: async () => ({ provider: 'slp-codex-peer', model: `m${++call}` }),
  });
  const out = await mechanicalDispatch(fixtureCtx(), bootstrapInput({
    requestId: 'req-drift', placement: { kind: 'shared-checkout', cwd: w.repo },
  }), deps);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ROUTE_DRIFT');
  assert.equal(host.calls.create.length, 0);
});


test('create never resubmits an uncertain ack', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  host.api.agents.create = async () => { throw new Error('daemon lost the ack'); };
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const input = bootstrapInput({ requestId: 'req-unc-1', placement: { kind: 'shared-checkout', cwd: w.repo } });
  const out = await mechanicalDispatch(fixtureCtx(), input, deps);
  assert.equal(out.ok, true);
  assert.equal(out.state, 'uncertain');
  const observes = core.calls.filter(c => c.operation === 'observe' && c.actionKind === 'create');
  assert.equal(observes.at(-1).receipt.status, 'uncertain');
});


test('send gates on registered membership then correlates messageId', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const boot = bootstrapInput({ requestId: 'req-b2', placement: { kind: 'shared-checkout', cwd: w.repo } });
  await mechanicalDispatch(fixtureCtx(), boot, deps);
  const attempt = ledger.taskEntries.find(r => r.kind === 'attempt');
  const createCwd = host.calls.create[0].cwd;

  // (a) No registered membership ⇒ seat-pending, nothing sent.
  const send1 = await mechanicalDispatch(fixtureCtx(), {
    phase: 'send', requestId: 'req-s1', assignmentId: 'asg-1', taskId: 'task-1', grantRef: 'grant:send',
    attemptId: 'att-1', expectedAttemptRevision: 0, expectedLedgerRevision: 0, expectedBriefRevision: 0,
    expectedOwnershipRevision: 0, expectedTaskRevision: 0, text: 'do the work',
  }, deps);
  assert.equal(send1.sent, false);
  assert.equal(send1.state, 'seat-pending');
  assert.equal(host.calls.send.length, 0);

  // (b) Registered membership ⇒ bind under lock, then send with messageId.
  ledger.memberships.push({
    membershipId: uuid(2), agentId: 'agent-new', provider: 'slp-codex-peer',
    createCwd, workspaceId: null, registeredAt: NOW, revokedAt: null,
  });
  const pendingRevision=core.calls.length;
  const stillPending=await mechanicalDispatch(fixtureCtx(),{phase:'send',requestId:'pending-after-register',assignmentId:'asg-1',taskId:'task-1',grantRef:'grant:send',attemptId:'att-1',text:'do the work',expectedLedgerRevision:0},deps);
  assert.equal(stillPending.sent,false);assert.equal(core.calls.length,pendingRevision,'registration alone never triggers bind');
  // This mechanical fixture represents the separately reconciled bound row.
  attempt.state='bound';attempt.member={agentId:'agent-new',membershipId:uuid(2)};
  const send2 = await mechanicalDispatch(fixtureCtx(), {
    phase: 'send', requestId: 'req-s2', assignmentId: 'asg-1', taskId: 'task-1', grantRef: 'grant:send',
    attemptId: 'att-1', expectedAttemptRevision: 0, expectedLedgerRevision: 0, expectedBriefRevision: 0,
    expectedOwnershipRevision: 0, expectedTaskRevision: 0, text: 'do the work',
  }, deps);
  assert.equal(send2.sent, true, JSON.stringify(send2));
  assert.equal(send2.state, 'running');
  assert.equal(host.calls.send.length, 1);
  const { text, opts } = host.calls.send[0];
  assert.equal(text, 'do the work\n\nDesk delivery (claim; no authority grant):\n' +
    'Lead text sha256: 443270cdc607ba1eacf02db71d38a805a6eea51b2e41688e12614c634b8643d0\n' +
    'Assignment id: "asg-1"\nTask id: "task-1"\nAttempt id: "att-1"\n' +
    'Handback route: the verified parent agent ID is "agent-owner".\n');
  assert.equal(opts.messageId, send2.messageId);
  assert.equal(opts.messageId, effectIdentity('send', 'req-s2'));

  // (c) The attempt row is bound/running after the sequence.
  assert.equal(attempt.state, 'running');
});


test('send before create never fabricates a seat', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const out = await mechanicalDispatch(fixtureCtx(), {
    phase: 'send', requestId: 'req-s0', assignmentId: 'asg-1', taskId: 'task-1', grantRef: 'grant:send',
    attemptId: 'att-none', expectedAttemptRevision: 0, expectedLedgerRevision: 0, expectedBriefRevision: 0,
    expectedOwnershipRevision: 0, expectedTaskRevision: 0, text: 'x',
  }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ACTOR_MISMATCH');
  assert.equal(host.calls.send.length, 0);
});


test('stop-held attempt rejects new sends', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  ledger.taskEntries.push({
    kind: 'attempt', entityId: 'att-9', revision: 1, assignmentId: 'asg-1',
    attemptId: 'att-9', taskId: 't', state: 'stop-requested',
    host: { agentId: 'agent-x' }, placement: { cwd: w.repo }, seatPin: { provider: 'slp-codex-peer' },
    stop: { requested: true, reason: 'stop' }, member: null, sourceBase: null,
  });
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const out = await mechanicalDispatch(fixtureCtx(), {
    phase: 'send', requestId: 'req-s9', assignmentId: 'asg-1', taskId: 'task-1', grantRef: 'grant:send',
    attemptId: 'att-9', expectedAttemptRevision: 0, expectedLedgerRevision: 0, expectedBriefRevision: 0,
    expectedOwnershipRevision: 0, expectedTaskRevision: 0, text: 'x',
  }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'STOP_REQUESTED');
  assert.equal(host.calls.send.length, 0);
});


test('integration: stage → check → land with preserved dirty target work', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);

  // Attempt produced a result: source = evolved isolated worktree.
  const placedDir = adapterPaths(w.scratch, REPO_KEY).placements('att-1');
  const placed = await materializeIsolatedPlacement({
    fs: w.fs, git: w.git, repoRoot: w.repo, scratchDir: placedDir, baseRef: w.head,
  });
  const baseMeasure = await w.measure(placed.cwd);
  evolveSource(placed.cwd);
  const resultMeasure = await w.measure(placed.cwd);
  // Persist the BASE artifact exactly where the orchestrator reads it —
  // the attempt's sourceBase pin binds the file BYTES.
  const artifactDir = join(w.scratch, 'task-exec', REPO_KEY, 'attempts', 'att-1');
  mkdirSync(artifactDir, { recursive: true });
  const artifactBytes = JSON.stringify(baseMeasure);
  writeFileSync(join(artifactDir, 'base.measure.json'), artifactBytes);
  ledger.taskEntries.push(
    { kind: 'attempt', entityId: 'att-1', revision: 1, assignmentId: 'asg-1',
      attemptId: 'att-1', taskId: 'task-1', state: 'running',
      placement: { cwd: placed.cwd, kind: 'isolated' },
      sourceBase: { snapshotSha256: baseMeasure.sha256, head: baseMeasure.head, root: baseMeasure.root, kind: 'git-snapshot',
        measuredAt: NOW, incomplete: [], artifactSha256: sha256Hex(artifactBytes) },
      stop: { requested: false, reason: null }, member: null, host: { agentId: 'agent-new' },
      resultId: 'res-1' },
    { kind: 'result', entityId: 'res-1', revision: 1, assignmentId: 'asg-1', taskId: 'task-1',
      resultId: 'res-1', attemptId: 'att-1', snapshotSha256: resultMeasure.sha256, candidate: null },
  );

  // Target = same repo main checkout with preserved prior dirty work.
  writeFileSync(join(w.repo, 'prior-work.txt'), 'mine\n');
  const grantPaths = ['changed.txt', 'added.txt', 'deleted.txt', 'script.sh', 'link.txt'];

  // STAGE
  const staged = await mechanicalIntegration(fixtureCtx(), {
    phase: 'stage', requestId: 'req-i1', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: 'res-1',
    expectedLedgerRevision: 0, integrationActionId: null,
    grant: { authorityRef: 'grant:int-1', paths: grantPaths, target: { cwd: w.repo } },
    verification: { recipeIds: ['verify'] },
    stageKind: 'git-worktree',
  }, deps);
  assert.equal(staged.ok, true, JSON.stringify(staged));
  assert.equal(staged.staged, true);
  const actionId = staged.integrationActionId;
  // Target untouched during stage.
  assert.equal(readFileSync(join(w.repo, 'changed.txt'), 'utf8'), 'before\n');

  // CHECK — recipe resolves from the ledger row verification pin via a
  // proof-policy lookup the double satisfies by carrying recipeIds through.
  const integ = ledger.taskEntries.find(r => r.actionId === actionId);
  integ.stageDir = staged.stageDir;
  integ.stageKind = 'git-worktree';
  integ.targetCwd = realpathSync(w.repo);
  integ.sourceCwd = placed.cwd;
  integ.targetBaseSha = (await w.measure(w.repo)).sha256;
  integ.sourceResultSha = resultMeasure.sha256;
  // Core's proof policy lives on the task entry — recipes resolve from it.
  ledger.taskEntries.push({
    kind: 'task', entityId: 'task-1', revision: 1, assignmentId: 'asg-1',
    taskId: 'task-1',
    proofPolicy: { verificationRecipes: [
      { recipeId: 'verify', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 5000, maxOutputBytes: 4096 },
    ] },
  });
  const checked = await mechanicalIntegration(fixtureCtx(), {
    phase: 'check', requestId: 'req-i2', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: 'res-1', expectedLedgerRevision: 0,
    integrationActionId: actionId,
  }, deps);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.checkRuns[0].status, 'passed');

  // LAND — durable intent, re-measure, backup, apply, final verify.
  const landed = await mechanicalIntegration(fixtureCtx(), {
    phase: 'land', requestId: 'req-i3', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: 'res-1', expectedLedgerRevision: 0,
    integrationActionId: actionId,
  }, deps);
  assert.equal(landed.ok, true, JSON.stringify(landed));
  assert.equal(landed.landed, true);
  assert.equal(landed.finalMatchesExpected, true);
  // Prior dirty work survived; the delta applied with modes/links.
  assert.equal(readFileSync(join(w.repo, 'prior-work.txt'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(w.repo, 'changed.txt'), 'utf8'), 'after\n');
  assert.equal(readlinkSync(join(w.repo, 'link.txt')), 'changed.txt');
  // Landing intent was committed before the apply.
  const landOps = core.calls.filter(c => c.actionKind === 'integration').map(c => `${c.operation}${c.body?.phase ? `:${c.body.phase}` : ''}`);
  assert.ok(landOps.includes('intent:land'), JSON.stringify(landOps));
  // Backup preserved.
  assert.ok(landed.backupDir.includes('backup'));
  assert.equal(readFileSync(join(landed.backupDir, ledger.taskEntries.find(r=>r.actionId===landed.integrationActionId).receipt.backupManifest.find(e=>e.path==='changed.txt').blobKey), 'utf8'), 'before\n');
});


test('integration stage rejects out-of-grant delta paths', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const placedDir = adapterPaths(w.scratch, REPO_KEY).placements('att-2');
  const placed = await materializeIsolatedPlacement({
    fs: w.fs, git: w.git, repoRoot: w.repo, scratchDir: placedDir, baseRef: w.head,
  });
  const baseMeasure = await w.measure(placed.cwd);
  evolveSource(placed.cwd);
  const resultMeasure = await w.measure(placed.cwd);
  const artifactDir = join(w.scratch, 'task-exec', REPO_KEY, 'attempts', 'att-2');
  mkdirSync(artifactDir, { recursive: true });
  const att2Bytes = JSON.stringify(baseMeasure);
  writeFileSync(join(artifactDir, 'base.measure.json'), att2Bytes);
  ledger.taskEntries.push(
    { kind: 'attempt', entityId: 'att-2', revision: 1, assignmentId: 'asg-1',
      attemptId: 'att-2', taskId: 'task-1', state: 'running',
      placement: { cwd: placed.cwd },
      sourceBase: { snapshotSha256: baseMeasure.sha256, head: baseMeasure.head, root: baseMeasure.root, kind: 'git-snapshot',
        measuredAt: NOW, incomplete: [], artifactSha256: sha256Hex(att2Bytes) },
      stop: { requested: false, reason: null }, member: null, host: { agentId: 'agent-new' }, resultId: 'res-2' },
    { kind: 'result', entityId: 'res-2', revision: 1, assignmentId: 'asg-1', taskId: 'task-1',
      resultId: 'res-2', attemptId: 'att-2', snapshotSha256: resultMeasure.sha256, candidate: null },
  );
  const out = await mechanicalIntegration(fixtureCtx(), {
    phase: 'stage', requestId: 'req-i9', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: 'res-2',
    expectedLedgerRevision: 0, integrationActionId: null,
    grant: { authorityRef: 'grant:x', paths: ['changed.txt'], target: { cwd: w.repo } },
    verification: { recipeIds: [] },
  }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INTEGRATION_CONFLICT');
});


test('land holds on target drift instead of applying stale delta', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const placedDir = adapterPaths(w.scratch, REPO_KEY).placements('att-3');
  const placed = await materializeIsolatedPlacement({
    fs: w.fs, git: w.git, repoRoot: w.repo, scratchDir: placedDir, baseRef: w.head,
  });
  const baseMeasure = await w.measure(placed.cwd);
  evolveSource(placed.cwd);
  const resultMeasure = await w.measure(placed.cwd);
  const artifactDir = join(w.scratch, 'task-exec', REPO_KEY, 'attempts', 'att-3');
  mkdirSync(artifactDir, { recursive: true });
  const att3Bytes = JSON.stringify(baseMeasure);
  writeFileSync(join(artifactDir, 'base.measure.json'), att3Bytes);
  const staleTargetSha = 'f'.repeat(64);
  ledger.taskEntries.push(
    { kind: 'attempt', entityId: 'att-3', revision: 1, assignmentId: 'asg-1',
      attemptId: 'att-3', taskId: 'task-1', state: 'running',
      placement: { cwd: placed.cwd },
      sourceBase: { snapshotSha256: baseMeasure.sha256, head: baseMeasure.head, root: baseMeasure.root, kind: 'git-snapshot',
        measuredAt: NOW, incomplete: [], artifactSha256: sha256Hex(att3Bytes) },
      stop: { requested: false, reason: null }, member: null, host: { agentId: 'agent-new' }, resultId: 'res-3' },
    { kind: 'result', entityId: 'res-3', revision: 1, assignmentId: 'asg-1', taskId: 'task-1',
      resultId: 'res-3', attemptId: 'att-3', snapshotSha256: resultMeasure.sha256, candidate: null },
    { kind: 'action', entityId: 'act-int-drift', revision: 1, assignmentId: 'asg-1',
      actionId: 'act-int-drift', actionKind: 'integration', state: 'observed',
      taskId: 'task-1', resultId: 'res-3', attemptId: 'att-3',
      stageDir: join(w.scratch, 'stage-drift'), stageKind: 'git-worktree',
      targetCwd: realpathSync(w.repo), sourceCwd: placed.cwd,
      targetBaseSha: staleTargetSha, sourceResultSha: resultMeasure.sha256,
      stagedSha: null, backupDir: null, checkRuns: null, receipt: null, body: {},
      grant: { authorityRef: 'g', paths: ['changed.txt'], target: { cwd: w.repo } } },
  );
  const out = await mechanicalIntegration(fixtureCtx(), {
    phase: 'land', requestId: 'req-idrift', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: 'res-3', expectedLedgerRevision: 0,
    integrationActionId: 'act-int-drift',
  }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.landed, false);
  assert.equal(out.held, 'target-drift');
  // Fresh preflight refuses before a plan can authorize backup or apply.
  assert.equal(core.calls.length,0);
});


test('reconciliation delegates to Core with the production observer', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const out = await runTaskReconciliation(fixtureCtx(), {
    requestId: 'req-r1', assignmentId: 'asg-1', attemptIds: ['att-1'],
    actionIds: [], resourceIds: [], observationTypes: ['action'],
  }, deps);
  assert.equal(out.ok, true);
  assert.equal(core.calls.at(-1).operation, 'reconcile');
});


test('production observer answers placement/resource observations bounded', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const observer = createTaskObserver(fixtureCtx(), deps);
  const placed = await observer.observePlacement({ cwd: w.repo });
  assert.equal(placed.available, true);
  ledger.memberships.push({
    membershipId: uuid(3), agentId: 'agent-m', provider: 'p', createCwd: '/x',
    workspaceId: null, registeredAt: NOW, revokedAt: NOW, // revoked
  });
  ledger.revision=0;
  const resources = await observer.observeResources({
    ledgerRevision:0,resources: [
      { kind: 'worktree', path: join(w.scratch, 'nonexistent') },
      { kind: 'membership', membershipId: uuid(3) },
    ],
  });
  assert.equal(resources.results[0].exists, false);
  assert.equal(resources.results[1].revoked, true);
});


test('host event observer correlates turn_ended timeline messageIds', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const messageId = effectIdentity('send', 'req-s1');
  ledger.taskEntries.push({kind:'attempt',entityId:'att-1',revision:1,attemptId:'att-1',host:{agentId:'agent-new'}});
  ledger.taskEntries.push({
    kind: 'action', entityId: 'act-send-1', revision: 1, assignmentId: 'asg-1',
    actionId: 'act-send-1', actionKind: 'send', state: 'issued',
    taskId: 'task-1', attemptId: 'att-1', resultId: null, body: { messageId }, receipt: null,
  });
  const observer = createTaskHostEventObserver(deps);
  await observer.onTurnEnded(fixtureCtx(), {
    agentId:'agent-new',turnId: 'turn-1', outcome: 'completed',
    timeline: [{ type: 'user_message', messageId }],
  });
  const row = ledger.taskEntries.find(r => r.actionId === 'act-send-1');
  assert.equal(row.state, 'observed');
  assert.equal(row.receipt.correlation, 'messageId');
  // Unrelated turn_ended without the id leaves the row untouched.
  ledger.taskEntries.push({ kind: 'action', entityId: 'act-send-2', revision: 1, assignmentId: 'asg-1',
    actionId: 'act-send-2', actionKind: 'send', state: 'issued',
    taskId: 'task-1', attemptId: 'att-1', resultId: null, body: { messageId: 'other' }, receipt: null });
  await observer.onTurnEnded(fixtureCtx(), { turnId: 'turn-2', outcome: 'completed', timeline: [] });
  assert.equal(ledger.taskEntries.find(r => r.actionId === 'act-send-2').state, 'issued');
});


// ---------------------------------------------------------------------------
// Missing-pin vs exact-match regressions — absence of required evidence is
// never a verified tuple.
// ---------------------------------------------------------------------------


test('bootstrap verify: absent snapshot evidence stays uncertain', async t => {
  const cases = [
    ['provider', { provider: undefined }],
    ['cwd', { cwd: undefined }],
    ['model', { model: undefined }],
    ['parent', { labels: {} }],
  ];
  for (const [name, drift] of cases) {
    const w = world(t);
    const ledger = fixtureLedger(w);
    const core = coreDouble(ledger);
    const host = fixtureHost({ drift });
    const deps = fixtureDeps(w, ledger, host.api, core.task);
    const out = await mechanicalDispatch(fixtureCtx(), bootstrapInput({
      requestId: `req-mp-${name}`,
      placement: { kind: 'shared-checkout', cwd: w.repo },
    }), deps);
    assert.equal(out.state, 'uncertain', `${name}: ${JSON.stringify(out)}`);
    const prefix = name === 'parent' ? 'parent' : name;
    assert.ok(out.verification.mismatches.some(m => m.startsWith(prefix)),
      `${name}: ${JSON.stringify(out.verification)}`);
    // No bind and no second create — uncertain never resubmits.
    assert.equal(core.calls.filter(c => c.operation === 'bind').length, 0, name);
    assert.equal(host.calls.create.length, 1, name);
  }
});


test('bootstrap verify: requested mode unreported stays uncertain', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost(); // snapshot reports no currentModeId
  const deps = fixtureDeps(w, ledger, host.api, core.task, {
    resolveSeat: async () => ({ provider: 'slp-codex-peer', model: 'm1', modeId: 'mode-2' }),
  });
  const out = await mechanicalDispatch(fixtureCtx(), bootstrapInput({
    requestId: 'req-mp-mode',
    placement: { kind: 'shared-checkout', cwd: w.repo },
  }), deps);
  assert.equal(out.state, 'uncertain', JSON.stringify(out));
  assert.ok(out.verification.mismatches.some(m => m.startsWith('mode')));
  assert.equal(host.calls.create[0].config.modeId, 'mode-2');
});


test('reuse: exact-match snapshot reserves and binds to seat-pending', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = reuseFixture(w);
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const out = await mechanicalDispatch(fixtureCtx(), reuseInput(), deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.state, 'seat-pending'); // eligibility passed, no membership yet
  assert.equal(core.calls.filter(c => c.operation === 'reserve').length, 1);
  assert.equal(host.calls.send.length, 0);
});


test('reuse: absent or wrong snapshot evidence stays ineligible', async t => {
  const cases = [
    ['archive-unreported', { archivedAt: undefined }],
    ['archived', { archivedAt: '2026-01-01T00:00:00Z' }],
    ['status-unreported', { status: undefined }],
    ['status-running', { status: 'running' }],
    ['status-closed', { status: 'closed' }],
    ['active-turn-unreported', { activeTurn: undefined }],
    ['active-turn', { activeTurn: { turnId: 't1' } }],
    ['cwd-unreported', { cwd: undefined }],
    ['cwd-desk', { cwd: 'OUTSIDE' }],        // inside roots, not the desk repo
    ['provider-unreported', { provider: undefined }],
    ['provider', { provider: 'other' }],
    ['model-unreported', { model: undefined }],
    ['model', { model: 'other' }],
    ['parent-unreported', { labels: {} }],
    ['parent-route', { labels: { 'paseo.parent-agent-id': 'stranger' } }],
  ];
  for (const [name, drift] of cases) {
    const w = world(t);
    const ledger = fixtureLedger(w);
    const core = coreDouble(ledger);
    const host = reuseFixture(w, drift);
    const deps = fixtureDeps(w, ledger, host.api, core.task);
    const out = await mechanicalDispatch(fixtureCtx(),
      reuseInput({ requestId: `req-ri-${name}` }), deps);
    assert.equal(out.ok, false, `${name}: ${JSON.stringify(out)}`);
    assert.equal(out.code, 'SEAT_INELIGIBLE', name);
    assert.equal(core.calls.filter(c => c.operation === 'reserve').length, 0,
      `${name}: nothing reserved before eligibility`);
    assert.equal(host.calls.send.length, 0, name);
  }
});


test('reuse: asserted placement cwd compares exact realpath', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = reuseFixture(w);
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const good = await mechanicalDispatch(fixtureCtx(), reuseInput({
    requestId: 'req-rc-1', placement: { kind: 'shared-checkout', cwd: w.repo },
  }), deps);
  assert.equal(good.ok, true, JSON.stringify(good));
  mkdirSync(join(w.dir, 'other'), { recursive: true });
  const bad = await mechanicalDispatch(fixtureCtx(), reuseInput({
    requestId: 'req-rc-2', placement: { kind: 'shared-checkout', cwd: join(w.dir, 'other') },
  }), deps);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'SEAT_INELIGIBLE');
});


test('tampered BASE artifact fails closed even with intact embedded sha', async t => {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const placed = await materializeIsolatedPlacement({
    fs: w.fs, git: w.git, repoRoot: w.repo,
    scratchDir: adapterPaths(w.scratch, REPO_KEY).placements('att-4'), baseRef: w.head,
  });
  const baseMeasure = await w.measure(placed.cwd);
  evolveSource(placed.cwd);
  const resultMeasure = await w.measure(placed.cwd);
  const artifactDir = join(w.scratch, 'task-exec', REPO_KEY, 'attempts', 'att-4');
  mkdirSync(artifactDir, { recursive: true });
  const artifactBytes = JSON.stringify(baseMeasure);
  writeFileSync(join(artifactDir, 'base.measure.json'), artifactBytes);
  ledger.taskEntries.push(
    { kind: 'attempt', entityId: 'att-4', revision: 1, assignmentId: 'asg-1',
      attemptId: 'att-4', taskId: 'task-1', state: 'running',
      placement: { cwd: placed.cwd, kind: 'isolated' },
      sourceBase: { snapshotSha256: baseMeasure.sha256, head: baseMeasure.head, root: baseMeasure.root, kind: 'git-snapshot',
        measuredAt: NOW, incomplete: [], artifactSha256: sha256Hex(artifactBytes) },
      stop: { requested: false, reason: null }, member: null, host: { agentId: 'agent-new' },
      resultId: 'res-4' },
    { kind: 'result', entityId: 'res-4', revision: 1, assignmentId: 'asg-1', taskId: 'task-1',
      resultId: 'res-4', attemptId: 'att-4', snapshotSha256: resultMeasure.sha256, candidate: null },
  );
  // Tamper the persisted bytes while leaving the embedded sha256 field
  // intact — the byte pin catches what the self-declared sha cannot.
  const tampered = JSON.stringify({
    ...baseMeasure,
    entries: [...baseMeasure.entries,
      { path: 'injected.txt', kind: 'file', sha256: '0'.repeat(64), mode: '100644' }],
  });
  writeFileSync(join(artifactDir, 'base.measure.json'), tampered);
  const out = await mechanicalIntegration(fixtureCtx(), {
    phase: 'stage', requestId: 'req-tamper', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: 'res-4',
    expectedLedgerRevision: 0, integrationActionId: null,
    grant: { authorityRef: 'grant:x', paths: ['changed.txt'], target: { cwd: w.repo } },
    verification: { recipeIds: [] },
  }, deps);
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.code, 'CAPABILITY_GAP');
});

/** Shared stage fixture — real worktree placement + evolved source +
 *  byte-pinned BASE artifact on the attempt row. */

test('check detects a recipe mutating staged bytes', async t => {
  const fx = await stageFixture(t, 'att-mut', ['mutator']);
  fx.ledger.taskEntries.push({
    kind: 'task', entityId: 'task-1', revision: 1, assignmentId: 'asg-1',
    taskId: 'task-1',
    proofPolicy: { verificationRecipes: [
      { recipeId: 'mutator', required: true,
        argv: [process.execPath, '-e', 'require("fs").appendFileSync("changed.txt","x")'],
        timeoutMs: 5000, maxOutputBytes: 4096 },
    ] },
  });
  const out = await mechanicalIntegration(fixtureCtx(), {
    phase: 'check', requestId: 'req-mut-check', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: fx.integ.resultId, expectedLedgerRevision: 0,
    integrationActionId: fx.staged.integrationActionId,
  }, fx.deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.checkRuns[0].status, 'mutated');
  assert.equal(out.blocked, true);
});


test('check blocks a pinned recipe with no declaration', async t => {
  const fx = await stageFixture(t, 'att-ghost', ['ghost-recipe']);
  const out = await mechanicalIntegration(fixtureCtx(), {
    phase: 'check', requestId: 'req-ghost-check', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: fx.integ.resultId, expectedLedgerRevision: 0,
    integrationActionId: fx.staged.integrationActionId,
  }, fx.deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.checkRuns[0].status, 'blocked');
  assert.equal(out.runDetails[0].reason, 'recipe-missing');
  assert.equal(out.blocked, true);
});


test('land holds when the staged candidate drifted after check', async t => {
  const fx = await stageFixture(t, 'att-sd', ['verify']);
  fx.ledger.taskEntries.push({
    kind: 'task', entityId: 'task-1', revision: 1, assignmentId: 'asg-1',
    taskId: 'task-1',
    proofPolicy: { verificationRecipes: [
      { recipeId: 'verify', required: true,
        argv: [process.execPath, '-e', 'process.exit(0)'],
        timeoutMs: 5000, maxOutputBytes: 4096 },
    ] },
  });
  const checked = await mechanicalIntegration(fixtureCtx(), {
    phase: 'check', requestId: 'req-sd-check', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: fx.integ.resultId, expectedLedgerRevision: 0,
    integrationActionId: fx.staged.integrationActionId,
  }, fx.deps);
  assert.equal(checked.checkRuns[0].status, 'passed', JSON.stringify(checked));
  // Mutate the staged candidate post-check — land must hold, not apply.
  writeFileSync(join(fx.staged.stageDir, 'changed.txt'), 'tampered\n');
  const out = await mechanicalIntegration(fixtureCtx(), {
    phase: 'land', requestId: 'req-sd-land', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: fx.integ.resultId, expectedLedgerRevision: 0,
    integrationActionId: fx.staged.integrationActionId,
  }, fx.deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.landed, false);
  assert.equal(out.held, 'stage-drift');
});


/** Wraps a recorded Core double so selected effect calls can be injected —
 *  the injected call is still pushed to core.calls so op order stays
 *  auditable, but the ledger row is left in its pre-admission state. */

test('discharge denied at admission removes nothing', async t => {
  const {d,result,actionId}=await c2LandResolved(t),plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan;
  const effect=d.deps.task.runTaskEffect,calls=[];let removals=0;
  d.deps.fs={...d.deps.fs,rmrf:()=>{removals++;assert.fail('denied verification cannot remove material');}};
  d.deps.git={...d.deps.git,worktreeRemove:async()=>{removals++;assert.fail('denied verification cannot remove stage');}};
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    calls.push(input.operation);
    return input.operation==='issue'?{ok:true,actionId:input.actionId,perform:false}:effect(ctx,input,deps);
  }};
  const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','req-deny',actionId),d.deps);
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.discharged,false);assert.equal(out.perform,false);
  assert.equal(removals,0);assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
  assert.deepEqual(calls,['intent','issue']);assert.equal(latestTaskEntity(d.ledger(),actionId).state,'intended');
});


test('discharge intent rejection preserves stage and backup', async t => {
  const {d,result,actionId}=await c2LandResolved(t),plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan;
  const effect=d.deps.task.runTaskEffect;let removals=0;const before=d.ledger();
  d.deps.fs={...d.deps.fs,rmrf:()=>{removals++;assert.fail('refused intent cannot remove material');}};
  d.deps.git={...d.deps.git,worktreeRemove:async()=>{removals++;assert.fail('refused intent cannot remove stage');}};
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>input.operation==='intent'&&input.body?.phase==='discharge'
    ?{ok:false,code:'ACTOR_MISMATCH',message:'fixture owner denied',recovery:'fresh owner must admit'}:effect(ctx,input,deps)};
  const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','req-intrej',actionId),d.deps);
  assert.equal(out.ok,false,JSON.stringify(out));assert.equal(out.code,'ACTOR_MISMATCH');assert.equal(removals,0);
  assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));assert.equal(d.ledger().revision,before.revision);
});


test('discharge removes only after admission; observe rejection propagates', async t => {
  const {d,result,actionId}=await c2LandResolved(t),plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan;
  assert.equal((await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','req-obsrej-verify',actionId),d.deps)).discharged,false);
  const effect=d.deps.task.runTaskEffect,remove=d.deps.git.worktreeRemove,calls=[];
  d.deps.git={...d.deps.git,worktreeRemove:async(...args)=>{
    assert.equal(latestTaskEntity(d.ledger(),actionId).state,'issued');assert.deepEqual(calls,['intent','issue']);
    return remove(...args);
  }};
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{
    calls.push(input.operation);
    return input.operation==='observe'&&input.receipt?.cleanupStep==='remove-resource'
      ?{ok:false,code:'REVISION_CONFLICT',message:'fixture lost stage observation',recovery:'explicit reconcile'}:effect(ctx,input,deps);
  }};
  const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','req-obsrej',actionId),d.deps);
  assert.equal(out.ok,false,JSON.stringify(out));assert.equal(out.code,'REVISION_CONFLICT');
  assert.equal(existsSync(plan.stageDir),false);assert.ok(existsSync(plan.backupDir),'one public cycle cannot also remove backup');
  assert.equal(latestTaskEntity(d.ledger(),actionId).state,'issued');assert.deepEqual(calls,['intent','issue','observe']);
  assert.ok(latestTaskEntity(d.ledger(),actionId).resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='retained'));
  d.deps.task={...d.deps.task,runTaskEffect:effect};
  const reconciled=await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','req-obsrej-progress',actionId),d.deps);
  assert.equal(reconciled.discharged,false,JSON.stringify(reconciled));assert.ok(existsSync(plan.backupDir));
  const completed=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','req-obsrej-fresh-backup',actionId),d.deps);
  assert.equal(completed.discharged,true,JSON.stringify(completed));assert.deepEqual([...completed.removed].sort(),[plan.stageDir,plan.backupDir].sort());
});


test('discharge admits intent+issue before removal and observes', async t => {
  const {d,result,actionId}=await c2LandResolved(t),plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan;
  const verified=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','req-dch-verify',actionId),d.deps);
  assert.equal(verified.discharged,false);assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
  const effect=d.deps.task.runTaskEffect,remove=d.deps.git.worktreeRemove,rmrf=d.deps.fs.rmrf,calls=[];
  d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>{calls.push(input.operation);return effect(ctx,input,deps);}};
  d.deps.git={...d.deps.git,worktreeRemove:async(...args)=>{
    assert.deepEqual(calls,['intent','issue']);assert.equal(latestTaskEntity(d.ledger(),actionId).state,'issued');return remove(...args);
  }};
  const stage=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','req-dch-stage',actionId),d.deps);
  assert.equal(stage.discharged,false,JSON.stringify(stage));assert.equal(existsSync(plan.stageDir),false);assert.ok(existsSync(plan.backupDir));
  assert.deepEqual(calls,['intent','issue','observe']);calls.length=0;
  d.deps.fs={...d.deps.fs,rmrf:path=>{
    assert.equal(path,plan.backupDir);assert.deepEqual(calls,['intent','issue']);
    assert.equal(latestTaskEntity(d.ledger(),actionId).state,'issued');return rmrf(path);
  }};
  const backup=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','req-dch-backup',actionId),d.deps);
  assert.equal(backup.discharged,true,JSON.stringify(backup));assert.equal(existsSync(plan.backupDir),false);
  assert.deepEqual(calls,['intent','issue','observe']);assert.deepEqual([...backup.removed].sort(),[plan.stageDir,plan.backupDir].sort());
  const latest=latestTaskEntity(d.ledger(),actionId);assert.equal(latest.state,'observed');assert.equal(latest.phase,'discharge');
  assert.ok(latest.resourceIds.every(id=>latestTaskEntity(d.ledger(),id).disposition==='released'));assert.ok(existsSync(plan.manifestPath));
});


test('reconcile propagates observe rejection', async t => {
  const fx = await stageFixture(t, 'att-recrej', []);
  const deps = {
    ...fx.deps,
    task: taskWithInjectedEffect(fx.core, input =>
      input.operation === 'observe' && input.receipt?.phase === 'reconcile'
        ? { ok: false, code: 'DENIED', message: 'no', hint: 'retry' }
        : undefined),
  };
  const out = await mechanicalIntegration(fixtureCtx(), {
    phase: 'reconcile', requestId: 'req-recrej', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: fx.integ.resultId, expectedLedgerRevision: 0,
    integrationActionId: fx.staged.integrationActionId,
  }, deps);
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.code, 'DENIED');
});


test('check denied at admission runs zero recipes', async t => {
  const fx = await stageFixture(t, 'att-chkdeny', ['mutator']);
  fx.ledger.taskEntries.push({
    kind: 'task', entityId: 'task-1', revision: 1, assignmentId: 'asg-1',
    taskId: 'task-1',
    proofPolicy: { verificationRecipes: [
      { recipeId: 'mutator', required: true,
        argv: [process.execPath, '-e', 'require("fs").appendFileSync("changed.txt","x")'],
        timeoutMs: 5000, maxOutputBytes: 4096 },
    ] },
  });
  const stagedSha = (await fx.w.measure(fx.staged.stageDir)).sha256;
  const deps = {
    ...fx.deps,
    task: taskWithInjectedEffect(fx.core, input =>
      input.operation === 'issue' && input.actionKind === 'integration'
        ? { ok: true, actionId: input.actionId, perform: false }
        : undefined),
  };
  const out = await mechanicalIntegration(fixtureCtx(), {
    phase: 'check', requestId: 'req-chkdeny', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: fx.integ.resultId, expectedLedgerRevision: 0,
    integrationActionId: fx.staged.integrationActionId,
  }, deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.perform, false);
  assert.deepEqual(out.checkRuns, []);
  const afterSha = (await fx.w.measure(fx.staged.stageDir)).sha256;
  assert.equal(afterSha, stagedSha, 'refused check must run zero argv');
});


test('land reports final-mismatch and holds when applied bytes fail verify', async t => {
  const fx = await stageFixture(t, 'att-fmis', []);
  // Corrupt exactly one applied copy so the post-apply measure cannot
  // equal the expected map — a land that must not report success.
  const realCopy = fx.deps.fs.copyFile;
  const deps = {
    ...fx.deps,
    fs: {
      ...fx.deps.fs,
      copyFile: (src, dst, mode) => {
        if (dst.endsWith('changed.txt')) fx.deps.fs.writeFile(dst, Buffer.from('corrupted\n'), mode);
        else realCopy(src, dst, mode);
      },
    },
  };
  const out = await mechanicalIntegration(fixtureCtx(), {
    phase: 'land', requestId: 'req-fmis', assignmentId: 'asg-1',
    taskId: 'task-1', resultId: fx.integ.resultId, expectedLedgerRevision: 0,
    integrationActionId: fx.staged.integrationActionId,
  }, deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.landed, false);
  assert.equal(out.held, 'final-mismatch');
  assert.equal(out.finalMatchesExpected, false);
  assert.equal(fx.integ.state, 'held', 'unknown target receipt must retain the action');
  assert.ok(existsSync(out.backupDir), 'backup proof survives a failed land');
});

// ---------------------------------------------------------------------------
// Real Core + real store — the adapter drives the landed desk-task runners
// end to end; only membership/assignment rows are seeded (task entries are
// always minted by Core itself — the store verifies the hash chain).
// ---------------------------------------------------------------------------


test('real Core+store: complete scope workflow and retained maps feed an isolated dependent', t=>realLifecycle(t));

test('real Core: isolated artifact dependency verifies committed bytes and exact producer pins', t=>realLifecycle(t,{artifactDependency:true}));

test('real Core: cleanup failure retains proof and replay never retries removal', t=>realLifecycle(t,{cleanupFailure:true}));

test('real Core: final mismatch is held with no landed pin and retained backup', t=>realLifecycle(t,{finalMismatch:true}));

test('real Core: nondefault umask materialization holds modes with zero create/send', t=>realLifecycle(t,{nonDefaultUmask:true}));


test('real Core: lost create acknowledgment retains uncertainty and replay never creates twice', async t => {
  const d=await realDesk(t,{lostCreateAck:true});await d.define();
  const input=d.bootInput();
  const first=await runTaskDispatch(d.ctx,input,d.deps);
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.state,'uncertain');
  assert.equal(d.host.calls.create.length,1);
  const before=d.ledger().revision;
  const replay=await runTaskDispatch(d.ctx,input,d.deps);
  assert.equal(d.host.calls.create.length,1,'receipt replay runs zero SDK creates');
  assert.equal(d.ledger().revision,before,'replay adds no ledger history');
  assert.equal(replay.perform,false);
  const attempt=latestTaskEntity(d.ledger(),first.attemptId);
  assert.equal(attempt.boundScopeId,null,'uncertain create has no write scope');
  const pending=d.ledger().taskEntries.filter(r=>r.kind==='action'&&r.actionKind==='create').at(-1);
  assert.equal(pending.state,'uncertain');
  const reconciled=await runTaskReconciliation(d.ctx,{requestId:'empty-reconcile',assignmentId:d.assignmentId,
    taskId:'task-1',attemptIds:[first.attemptId],actionIds:[],resourceIds:[],observationTypes:['action']},d.deps);
  assert.equal(reconciled.ok,true,JSON.stringify(reconciled));
  assert.ok(reconciled.outstanding.includes(pending.actionId),'empty listing is not absence proof');
  assert.equal(d.host.calls.create.length,1);assert.equal(d.host.calls.send.length,0);
  assert.notEqual(latestTaskEntity(d.ledger(),first.attemptId).state,'settled');
});


test('real Core: caller CAS and lost-send replay fence SDK delivery', async t => {
  const d=await realDesk(t,{lostSendAck:true});await d.define();
  const boot=await runTaskDispatch(d.ctx,d.bootInput(),d.deps);assert.equal(boot.state,'bound',JSON.stringify(boot));
  const input=d.sendInput(boot.attemptId);
  const stale=await runTaskDispatch(d.ctx,{...input,requestId:'stale-send',expectedAttemptRevision:999},d.deps);
  assert.equal(stale.ok,false,JSON.stringify(stale));assert.equal(stale.code,'REVISION_CONFLICT');
  assert.equal(d.host.calls.send.length,0);
  const current=d.sendInput(boot.attemptId,'fresh-send');
  const first=await runTaskDispatch(d.ctx,current,d.deps);assert.equal(first.state,'uncertain',JSON.stringify(first));
  assert.equal(d.host.calls.send.length,1);
  await runTaskDispatch(d.ctx,current,d.deps);
  assert.equal(d.host.calls.send.length,1,'uncertain receipt never resends');
  const action=d.ledger().taskEntries.filter(r=>r.kind==='action'&&r.actionKind==='send').at(-1);
  const unrelated=createTaskHostEventObserver(d.deps);
  await unrelated.onTurnEnded(d.ctx,{agentId:'foreign-seat',timeline:[{type:'user_message',messageId:first.messageId}]});
  assert.equal(latestTaskEntity(d.ledger(),action.actionId).state,'uncertain','foreign seat cannot resolve our message');
  await unrelated.onTurnEnded(d.ctx,{agentId:boot.agentId,turnId:'turn-correlated',
    timeline:[{type:'user_message',messageId:first.messageId}]});
  assert.equal(latestTaskEntity(d.ledger(),action.actionId).state,'observed','exact seat message correlation resolves delivery');
  const after=d.ledger().revision;
  await unrelated.onTurnEnded(d.ctx,{agentId:boot.agentId,turnId:'turn-correlated',
    timeline:[{type:'user_message',messageId:first.messageId}]});
  assert.equal(d.ledger().revision,after,'latest action filter does not re-observe historical issued rows');
});


test('strict public phase inputs reject missing fields before any Core or SDK operation', async t => {
  const w=world(t);const ledger=fixtureLedger(w);const core=coreDouble(ledger);const host=fixtureHost();
  const deps=fixtureDeps(w,ledger,host.api,core.task);
  for(const input of [
    bootstrapInput({placement:undefined}),
    bootstrapInput({runtime:null}),
    {...dispatchBase(),phase:'send',requestId:'invalid-send',assignmentId:'asg-1',taskId:'task-1',text:'x'},
  ]) {
    const out=await runTaskDispatch(fixtureCtx(),input,deps);
    assert.equal(out.code,'INVALID_RECORD');
  }
  const missing=await runTaskIntegration(fixtureCtx(),{phase:'stage',requestId:'invalid-stage',assignmentId:'asg-1',
    taskId:'task-1',resultId:'res-1',expectedLedgerRevision:0,integrationActionId:null},deps);
  assert.equal(missing.code,'INVALID_RECORD');
  assert.equal(core.calls.length,0);assert.equal(host.calls.create.length,0);assert.equal(host.calls.send.length,0);
});


test('resource observer requires exact rule and positive admitted cleanup; absence and archive retain', async t => {
  const w=world(t);const ledger=fixtureLedger(w,{revision:5});const host=fixtureHost();
  const core=coreDouble(ledger);const observer=createTaskObserver(fixtureCtx(),fixtureDeps(w,ledger,host.api,core.task));
  const path=adapterPaths(w.scratch,REPO_KEY).stage('int-proof');
  const resource={kind:'resource',entityId:'resource-proof',resourceId:'resource-proof',revision:2,
    resourceKind:'scratch',resourceKey:path,actionId:'int-proof',attemptId:null};
  const action={kind:'action',entityId:'int-proof',revision:4,actionId:'int-proof',actionKind:'integration',
    state:'observed',phase:'discharge',entrySha256:'a'.repeat(64),receipt:{status:'observed',removed:[path],errors:[]}};
  ledger.taskEntries.push(resource,action);
  const request={ledgerRevision:5,resources:[{resourceId:resource.resourceId,kind:'scratch',resourceKey:path,
    path,attemptId:null,actionId:'int-proof',releaseRuling:{resourceId:resource.resourceId,expectedResourceRevision:2,reason:'cleanup',evidence:['fixture:rule']}}]};
  const positive=await observer.observeResources(request);
  assert.equal(positive.results[0].positive,true);
  assert.equal(positive.results[0].quiescent,true);
  assert.equal(positive.results[0].evidence[0].ref,action.entrySha256);
  for(const mutate of [
    q=>q.resources[0].releaseRuling=null,
    q=>q.resources[0].releaseRuling.expectedResourceRevision=1,
    q=>q.resources[0].resourceKey='/foreign',
    q=>q.ledgerRevision=4,
  ]) {
    const changed=structuredClone(request);mutate(changed);
    assert.equal((await observer.observeResources(changed)).results[0].positive,false);
  }
  action.receipt.removed=[];
  assert.equal((await observer.observeResources(request)).results[0].positive,false,'single absence lacks cleanup proof');
  const gap=await observer.observeResources({ledgerRevision:5,resources:[{resourceId:'unknown-agent',kind:'agent',
    resourceKey:'agent-new',attemptId:null,actionId:null,agentId:'agent-new',releaseRuling:null}]});
  assert.equal(gap.results[0].quiescent,false);assert.equal(gap.results[0].positive,false);
  assert.equal(gap.results[0].reason,'host-process-quiescence-unavailable');
});


test('real Core: stop fences sends; distinct archive and rule do not invent process quiescence', async t => {
  const d=await realDesk(t);await d.define();
  const boot=await runTaskDispatch(d.ctx,d.bootInput(),d.deps);assert.equal(boot.state,'bound',JSON.stringify(boot));
  const sent=await runTaskDispatch(d.ctx,d.sendInput(boot.attemptId),d.deps);assert.equal(sent.sent,true);
  const stopped=await d.taskCommand({operation:'stop',requestId:'stop-task',assignmentId:d.assignmentId,
    taskId:'task-1',attemptId:boot.attemptId,expectedLedgerRevision:d.ledger().revision,
    expectedBriefRevision:0,expectedOwnershipRevision:0,expectedTaskRevision:1,reason:'stop fixture'});
  assert.equal(stopped.ok,true,JSON.stringify(stopped));
  const denied=await runTaskDispatch(d.ctx,d.sendInput(boot.attemptId,'after-stop'),d.deps);
  assert.equal(denied.code,'STOP_REQUESTED');assert.equal(d.host.calls.send.length,1);
  const archiveInput={...d.sendInput(boot.attemptId,'archive-task'),phase:'archive',grantRef:'grant:archive'};delete archiveInput.text;
  const archived=await runTaskDispatch(d.ctx,archiveInput,d.deps);
  assert.equal(archived.archived,true,JSON.stringify(archived));assert.equal(d.host.calls.archive.length,1);
  const attempt=latestTaskEntity(d.ledger(),boot.attemptId);
  assert.equal(attempt.state,'stop-requested');assert.ok(attempt.boundScopeId);
  const resources=d.ledger().taskEntries.filter(r=>r.kind==='resource'&&r.attemptId===boot.attemptId)
    .filter(r=>latestTaskEntity(d.ledger(),r.resourceId).revision===r.revision);
  const reconcile=await runTaskReconciliation(d.ctx,{requestId:'rule-without-quiescence',assignmentId:d.assignmentId,
    taskId:'task-1',attemptIds:[boot.attemptId],actionIds:[],resourceIds:resources.map(r=>r.resourceId),
    releaseRulings:resources.map(r=>({resourceId:r.resourceId,expectedResourceRevision:r.revision,reason:'owner cleanup request',evidence:['fixture:owner-rule']})),
    observationTypes:['resources']},d.deps);
  assert.equal(reconcile.ok,false,JSON.stringify(reconcile));assert.equal(reconcile.code,'EVIDENCE_INCOMPLETE');
  for(const resource of resources)assert.equal(latestTaskEntity(d.ledger(),resource.resourceId).disposition,'retained');
  assert.equal(latestTaskEntity(d.ledger(),boot.attemptId).state,'stop-requested');
  assert.equal(d.ledger().scopeTransitions.filter(r=>r.scopeId===attempt.boundScopeId).at(-1).to,'claimed');
});


test('real Core: delayed registration uses explicit reconciliation before a fresh once-only send', async t => {
  const d=await realDesk(t,{delayedRegistration:true});await d.define();
  const boot=await runTaskDispatch(d.ctx,d.bootInput(),d.deps);
  assert.equal(boot.state,'seat-pending',JSON.stringify(boot));assert.equal(d.host.calls.create.length,1);
  assert.equal('prompt' in d.host.calls.create[0],false);assert.equal(d.host.calls.send.length,0);
  const original=d.sendInput(boot.attemptId,'delayed-send');
  const before=d.ledger().revision;
  const pending=await runTaskDispatch(d.ctx,original,d.deps);
  assert.equal(pending.state,'seat-pending');assert.equal(pending.sent,false);assert.match(pending.recovery,/slp_task_reconcile/);
  assert.equal(d.ledger().revision,before,'unbound send mutates no ledger row');
  assert.equal(d.host.calls.send.length,0);
  await d.registerCreated();
  const registeredRevision=d.ledger().revision;
  const afterRegistration=await runTaskDispatch(d.ctx,original,d.deps);
  assert.equal(afterRegistration.sent,false);assert.equal(d.ledger().revision,registeredRevision,'registered membership still needs explicit bind');
  const created=d.ledger().taskEntries.filter(r=>r.kind==='action'&&r.actionKind==='create').at(-1);
  assert.equal(created.state,'observed');const createRevision=created.revision;
  const reconciled=await runTaskReconciliation(d.ctx,{requestId:'bind-delayed',assignmentId:d.assignmentId,taskId:'task-1',
    expectedLedgerRevision:d.ledger().revision,attemptIds:[boot.attemptId],actionIds:[],resourceIds:[],observationTypes:['action']},d.deps);
  assert.equal(reconciled.ok,true,JSON.stringify(reconciled));
  const bound=latestTaskEntity(d.ledger(),boot.attemptId);
  assert.equal(bound.state,'bound');assert.equal(bound.member.membershipId,d.seat.membershipId);assert.ok(bound.boundScopeId);
  assert.equal(latestTaskEntity(d.ledger(),created.actionId).revision,createRevision,'observed create is not duplicated during bind');
  const stale=await runTaskDispatch(d.ctx,original,d.deps);
  assert.equal(stale.ok,false,JSON.stringify(stale));assert.equal(stale.code,'REVISION_CONFLICT');assert.equal(d.host.calls.send.length,0);
  const fresh=d.sendInput(boot.attemptId,'fresh-delayed-send');
  const sent=await runTaskDispatch(d.ctx,fresh,d.deps);assert.equal(sent.sent,true,JSON.stringify(sent));
  await runTaskDispatch(d.ctx,fresh,d.deps);assert.equal(d.host.calls.send.length,1);
});


test('real Core: revoked, foreign and mismatched delayed registration never gain a write scope', async t => {
  for(const mode of ['foreign','mismatched-cwd','revoked']) {
    const d=await realDesk(t,{delayedRegistration:true});await d.define();
    const boot=await runTaskDispatch(d.ctx,d.bootInput(),d.deps);assert.equal(boot.state,'seat-pending');
    const opts=d.host.calls.create[0];
    if(mode==='foreign')await d.registerCreated(opts,{id:'foreign-seat'});
    else if(mode==='revoked') {
      await d.registerCreated(opts,{id:'agent-new'});
      await d.seatHooks.deskRevoke({agent:{id:'agent-new',workspaceId:null,parentAgentId:'agent-owner',
        provider:'slp-codex-peer',cwd:opts.cwd,title:null},archivedAt:NOW});
    } else {
      const other=join(d.w.dir,'other-checkout');git(d.w.repo,['worktree','add','--detach',other,d.w.head]);
      await d.registerCreated({...opts,cwd:other},{id:'agent-new'});
    }
    const reconciled=await runTaskReconciliation(d.ctx,{requestId:`bind-${mode}`,assignmentId:d.assignmentId,
      taskId:'task-1',attemptIds:[boot.attemptId],actionIds:[],resourceIds:[],observationTypes:['action']},d.deps);
    assert.ok(!reconciled.ok || !reconciled.bound.includes(boot.attemptId),JSON.stringify(reconciled));
    const attempt=latestTaskEntity(d.ledger(),boot.attemptId);
    assert.equal(attempt.member,null);assert.equal(attempt.boundScopeId,null);
    const before=d.ledger().revision;
    const pending=await runTaskDispatch(d.ctx,d.sendInput(boot.attemptId,`send-${mode}`),d.deps);
    assert.equal(pending.sent,false);assert.equal(d.ledger().revision,before);
    assert.equal(d.host.calls.create.length,1);assert.equal(d.host.calls.send.length,0);
  }
});


test('dispatch returns typed refusal for a nested snapshot and retains the admission without create', async t => {
  const w=world(t);const nested=join(w.repo,'nested');mkdirSync(nested);git(nested,['init','-b','main']);
  writeFileSync(join(nested,'inner.txt'),'inner');git(nested,['add','-A']);git(nested,['commit','-m','fixture nested']);
  const ledger=fixtureLedger(w);const core=coreDouble(ledger);const host=fixtureHost();
  const out=await mechanicalDispatch(fixtureCtx(),bootstrapInput({placement:{kind:'shared-checkout',cwd:w.repo}}),
    fixtureDeps(w,ledger,host.api,core.task));
  assert.equal(out.code,'INTEGRATION_UNSUPPORTED',JSON.stringify(out));
  assert.equal(host.calls.create.length,0);assert.equal(host.calls.send.length,0);
  assert.equal(ledger.taskEntries.find(r=>r.kind==='action'&&r.actionKind==='place').state,'issued');
});


test('real Core+Git: diamond isolates B/C, serializes one integration target, and measures BOTH results in D base', async t => {
  const d=await realDesk(t);
  const scopeFor=path=>{const base=taskSpec().scope;return {...base,ownership:{...base.ownership,paths:[path]}};};
  const dep=taskId=>({taskId,availability:'integrated-code',artifactKey:null,targetPath:null,target:null});
  await d.define('A',{scope:scopeFor('a.txt')});
  const a=await runTaskDispatch(d.ctx,d.bootInput('A',{placement:{kind:'isolated',baseRef:d.w.head},effectBudget:8}),d.deps);
  assert.equal(a.state,'bound',JSON.stringify(a));
  assert.equal((await runTaskDispatch(d.ctx,d.sendInput(a.attemptId,'send-A'),d.deps)).sent,true);
  const resultA=await observeAndRuleTask(d,'A',a.attemptId,'a.txt','A integrated\n');
  await completeIntegration(d,resultA);
  git(d.w.repo,['add','-A']);git(d.w.repo,['commit','-m','fixture A integrated']);
  const baseA=git(d.w.repo,['rev-parse','HEAD']);
  await d.define('B',{scope:scopeFor('b.txt'),dependencies:[dep('A')]});
  await d.define('C',{scope:scopeFor('c.txt'),dependencies:[dep('A')]});
  await d.define('D',{scope:scopeFor('d.txt'),dependencies:[dep('B'),dep('C')]});
  const b=await runTaskDispatch(d.ctx,d.bootInput('B',{placement:{kind:'isolated',baseRef:baseA},effectBudget:8}),d.deps);
  const c=await runTaskDispatch(d.ctx,d.bootInput('C',{placement:{kind:'isolated',baseRef:baseA},effectBudget:8}),d.deps);
  assert.equal(b.state,'bound',JSON.stringify(b));assert.equal(c.state,'bound',JSON.stringify(c));
  const attemptB=latestTaskEntity(d.ledger(),b.attemptId);const attemptC=latestTaskEntity(d.ledger(),c.attemptId);
  assert.notEqual(attemptB.placement.cwd,attemptC.placement.cwd,'B/C own distinct real worktrees');
  assert.equal(attemptB.consumedDependencies[0].taskId,'A');assert.equal(attemptC.consumedDependencies[0].taskId,'A');
  for(const task of [b,c])assert.equal((await runTaskDispatch(d.ctx,d.sendInput(task.attemptId,`send-${task.agentId}`),d.deps)).sent,true);
  const resultB=await observeAndRuleTask(d,'B',b.attemptId,'b.txt','B integrated\n');
  const resultC=await observeAndRuleTask(d,'C',c.attemptId,'c.txt','C integrated\n');
  const beforeTarget=await d.w.measure(d.w.repo);
  const assertDNoCreate=async (baseRef,requestId)=>{
    const count=d.host.calls.create.length;
    const out=await runTaskDispatch(d.ctx,d.bootInput('D',{requestId,placement:{kind:'isolated',baseRef},effectBudget:8}),d.deps);
    assert.equal(out.ok,false,`D requires BOTH results measured in its declared base: ${JSON.stringify(out)}`);
    assert.equal(d.host.calls.create.length,count);assert.equal(d.ledger().taskEntries.filter(r=>r.kind==='attempt'&&r.taskId==='D').length,0);
  };
  await assertDNoCreate(baseA,'D-before-landing');
  const stagedB=await runTaskIntegration(d.ctx,integrationRequest(d,resultB,'stage','stage-B'),d.deps);
  assert.equal(stagedB.staged,true,JSON.stringify(stagedB));
  const rejectedC=await runTaskIntegration(d.ctx,integrationRequest(d,resultC,'stage','C-conflicting-target'),d.deps);
  assert.equal(rejectedC.ok,false,JSON.stringify(rejectedC));assert.equal(rejectedC.code,'SCOPE_CONFLICT');
  assert.equal((await d.w.measure(d.w.repo)).sha256,beforeTarget.sha256,'staging and refusal preserve actual target bytes');
  assert.equal(d.ledger().taskEntries.filter(r=>r.kind==='action'&&r.actionKind==='integration'&&r.taskId==='C').length,0);
  await completeIntegration(d,resultB,stagedB);
  git(d.w.repo,['add','-A']);git(d.w.repo,['commit','-m','fixture B integrated']);
  const baseAB=git(d.w.repo,['rev-parse','HEAD']);
  await assertDNoCreate(baseAB,'D-only-B-landed');
  await completeIntegration(d,resultC);
  assert.equal(readFileSync(join(d.w.repo,'a.txt'),'utf8'),'A integrated\n');
  assert.equal(readFileSync(join(d.w.repo,'b.txt'),'utf8'),'B integrated\n');
  assert.equal(readFileSync(join(d.w.repo,'c.txt'),'utf8'),'C integrated\n');
  await assertDNoCreate(baseAB,'D-both-landed-but-base-missing-C');
  git(d.w.repo,['add','-A']);git(d.w.repo,['commit','-m','fixture B and C consumer base']);
  const baseABC=git(d.w.repo,['rev-parse','HEAD']);
  const dBoot=await runTaskDispatch(d.ctx,d.bootInput('D',{requestId:'D-measured-both',placement:{kind:'isolated',baseRef:baseABC},effectBudget:8}),d.deps);
  assert.equal(dBoot.state,'bound',JSON.stringify(dBoot));
  const attemptD=latestTaskEntity(d.ledger(),dBoot.attemptId);
  assert.deepEqual(attemptD.consumedDependencies.map(p=>p.taskId).sort(),['B','C']);
  assert.equal(readFileSync(join(attemptD.placement.cwd,'b.txt'),'utf8'),'B integrated\n');
  assert.equal(readFileSync(join(attemptD.placement.cwd,'c.txt'),'utf8'),'C integrated\n');
  assert.equal((await runTaskDispatch(d.ctx,d.sendInput(dBoot.attemptId,'send-D'),d.deps)).sent,true);
  assert.equal(d.host.calls.create.length,4);assert.equal(d.host.calls.send.length,4);
});
