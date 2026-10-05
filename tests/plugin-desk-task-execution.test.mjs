// plugin-desk-task-execution.test.mjs — Executable proof for the task
// execution adapter: real temp Git mechanics plus separate mechanical
// fixtures and actual createDeskStore/Core/seat-hook authority/history flows.
// All SDK effects are fixtures; no live daemon operation is exercised.
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

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example',
};
const git = (repo, args) =>
  execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();

function world(t, dir = mkdtempSync(join(tmpdir(), 'slp-taskexec-'))) {
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const repo = join(dir, 'repo');
  const scratch = join(dir, 'scratch');
  mkdirSync(repo); mkdirSync(scratch);
  git(dir, ['init', '-b', 'main', 'repo']);
  writeFileSync(join(repo, 'kept.txt'), 'kept\n');
  writeFileSync(join(repo, 'changed.txt'), 'before\n');
  writeFileSync(join(repo, 'deleted.txt'), 'gone\n');
  writeFileSync(join(repo, 'script.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(join(repo, 'script.sh'), 0o755);
  symlinkSync('kept.txt', join(repo, 'link.txt'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'base']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const fs = createTaskFsIo([dir]);
  const gitIo = createTaskGitIo();
  const measure = createDirectMeasure(snapshot);
  return { dir, repo, scratch, head, fs, git: gitIo, measure };
}

// Mechanical fixtures supply complete wire inputs; their mutable rows do not
// prove Core authority/history. Real-store scenarios below call the exports directly.
function mechanicalDispatch(ctx, input, deps) {
  const common = { ...dispatchBase(), expectedTaskRevision: 1, ...input };
  common.expectedTaskRevision = Math.max(1, common.expectedTaskRevision);
  const keys = ['requestId','assignmentId','taskId','phase','expectedLedgerRevision','expectedBriefRevision',
    'expectedOwnershipRevision','expectedTaskRevision','grantRef','attemptId','expectedAttemptRevision'];
  if (['bootstrap','reuse'].includes(input.phase)) {
    common.placement ??= {kind:'shared-checkout'};
    keys.push('runtime','placement','effectBudget');
    if (input.phase === 'bootstrap') keys.push('title'); else keys.push('reuseTarget');
  } else {
    common.expectedAttemptRevision = Math.max(1, common.expectedAttemptRevision);
    keys.push(input.phase === 'send' ? 'text' : 'cascade');
  }
  return runTaskDispatch(ctx, Object.fromEntries(keys.filter(k => common[k] !== undefined).map(k => [k, common[k]])), deps);
}
function mechanicalIntegration(ctx, input, deps) {
  const common = { expectedResultRevision:1,expectedAdjudicationRevision:1,expectedActionRevision:1,
    integrationActionId:null,stageKind:'git-worktree',verification:{recipeIds:[]},...input };
  const keys = ['requestId','assignmentId','taskId','resultId','expectedLedgerRevision',
    'expectedResultRevision','expectedAdjudicationRevision','phase','integrationActionId'];
  if (input.phase === 'stage') keys.push('grant','verification','stageKind');
  else keys.push('expectedActionRevision');
  if (input.phase === 'discharge') keys.push('grantRef');
  return runTaskIntegration(ctx, Object.fromEntries(keys.filter(k => common[k] !== undefined).map(k => [k, common[k]])), deps);
}

// ---------------------------------------------------------------------------
// Git mechanics — real temp repos.
// ---------------------------------------------------------------------------

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

function evolveSource(dir) {
  writeFileSync(join(dir, 'changed.txt'), 'after\n');
  writeFileSync(join(dir, 'added.txt'), 'new\n');
  rmSync(join(dir, 'deleted.txt'));
  chmodSync(join(dir, 'script.sh'), 0o644);
  rmSync(join(dir, 'link.txt'));
  symlinkSync('changed.txt', join(dir, 'link.txt'));
}

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

const REPO_KEY = 'repo-test';
const NOW = '2026-01-01T00:00:00.000Z';
const uuid = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function fixtureCtx(overrides = {}) {
  return {
    repoKey: REPO_KEY,
    row: {
      membershipId: uuid(1), agentId: 'agent-owner', provider: 'slp-owner',
      createCwd: '/desk', workspaceId: null, registeredAt: NOW,
      revokedAt: null, ...overrides,
    },
  };
}

/** A Core double: records every runTaskCommand/runTaskEffect and mutates a
 *  taskEntries stream the way Core's commits would — the adapter only ever
 *  sees the ledger stream, never Core internals. Rows carry entityId +
 *  revision so the authoritative accessors read them; one mutable row per
 *  entity models "latest revision" while keeping fixture patches visible.
 *  Semantics mirrored: reserve mints attempt+place-intent; admit mints an
 *  ISSUED integration action (admission IS the issue); intent/issue/observe
 *  drive intended→issued→{observed,uncertain,failed,held} with the same
 *  receipt lifts the real decide performs. */
function coreDouble(ledger) {
  const calls = [];
  const counters = { action: 0 };
  let ledgerRevision = 0;
  const bump = () => ++ledgerRevision;
  const push = row => { ledger.taskEntries.push(row); return row; };
  const latestOf = entityId => {
    let latest = null;
    for (const row of ledger.taskEntries) {
      if (row.entityId !== entityId) continue;
      if (!latest || (row.revision ?? 0) > (latest.revision ?? 0)) latest = row;
    }
    return latest;
  };
  const attempt = () => latestOf('att-1');
  const statusToState = { observed: 'observed', uncertain: 'uncertain', failed: 'failed', held: 'held', conflict: 'held' };
  const measurePin = v => (v && typeof v === 'object' ? {
    snapshotSha256: v.snapshotSha256 ?? v.sha256 ?? null,
    head: v.head ?? null, root: v.root ?? '',
    kind: v.kind === 'content-map' ? 'content-map' : 'git-snapshot',
    measuredAt: v.measuredAt ?? NOW, incomplete: v.incomplete ?? [],
    artifactSha256: v.artifactSha256 ?? null,
  } : null);
  const revise = (row, fields) => Object.assign(row, fields, { revision: (row.revision ?? 0) + 1 });
  const liftReceipt = (row, receipt) => {
    for (const key of ['sourceBase', 'sourceResult', 'target', 'stageBase', 'prepared', 'landed', 'final', 'base']) {
      const pin = measurePin(receipt[key]);
      if (pin !== null) row[key === 'final' ? 'landed' : (key === 'base' ? 'sourceBase' : key)] = pin;
    }
    for (const key of ['stageDir', 'stagedSha', 'expectedStageSha', 'expectedSha', 'backupDir',
      'targetCwd', 'sourceCwd', 'targetBaseSha', 'sourceResultSha', 'sourceBaseSha', 'deltaDigest', 'phase', 'stageKind']) {
      if (typeof receipt[key] === 'string') row[key] = receipt[key];
    }
    for (const key of ['checkRuns', 'conflicts', 'changedPaths']) {
      if (Array.isArray(receipt[key])) row[key] = receipt[key];
    }
    row.receipt = receipt;
  };
  const applyEffect = input => {
    calls.push(input);
    if (input.operation === 'bind') {
      const att = latestOf(input.attemptId);
      if (att) revise(att, { state: 'bound', member: { agentId: input.member.agentId, membershipId: input.member.membershipId } });
      return { ok: true, bound: true, attemptId: input.attemptId, ledgerRevision: bump(), replayed: false };
    }
    if (input.operation === 'intent') {
      if (input.actionId !== undefined && input.actionId !== null) {
        const existing = latestOf(input.actionId);
        if (existing) {
          revise(existing, { state: 'intended', phase: input.body?.phase ?? existing.phase, body: input.body ?? existing.body, recoveryPlan: input.body?.recoveryPlan ?? existing.recoveryPlan ?? null });
          return { ok: true, actionId: input.actionId, actionPin: { actionId: input.actionId }, ledgerRevision: bump(), replayed: false };
        }
      }
      const actionId = `act-${++counters.action}`;
      const actionAttempt = latestOf(input.attemptId);
      push({
        kind: 'action', entityId: actionId, revision: 1, assignmentId: input.assignmentId ?? 'asg-1',
        taskId: input.taskId ?? actionAttempt?.taskId ?? null, attemptId: input.attemptId ?? null, resultId: input.resultId ?? null,
        actionId, actionKind: input.actionKind, ordinal: counters.action, phase: null,
        body: input.body ?? {}, state: 'intended', receipt: null,
      });
      return { ok: true, actionId, actionPin: { actionId }, ledgerRevision: bump(), replayed: false };
    }
    if (input.operation === 'issue') {
      const existing = latestOf(input.actionId);
      if (existing && existing.state !== 'intended') {
        return { ok: true, actionId: input.actionId, perform: false };
      }
      if (existing) revise(existing, { state: 'issued' });
      else push({
        kind: 'action', entityId: input.actionId, revision: 1, assignmentId: 'asg-1',
        actionId: input.actionId, actionKind: input.actionKind ?? null, state: 'issued', body: {},
      });
      return {
        ok: true, actionId: input.actionId, perform: true, ledgerRevision: bump(), replayed: false,
        permit: {
          actionId: input.actionId, entrySha256: 'e'.repeat(64),
          ownershipRevision: 0, attemptRevision: existing?.revision ?? 1,
          body: existing?.body ?? {},
        },
      };
    }
    if (input.operation === 'observe') {
      const row = latestOf(input.actionId);
      if (!row || !['issued', 'uncertain', 'held'].includes(row.state)) {
        return { ok: false, code: 'INVALID_RECORD', message: `action ${input.actionId} is ${row?.state ?? 'absent'} — only issued/uncertain actions accept observations`, recovery: 'issue before observe' };
      }
      const receipt = input.receipt ?? {};
      revise(row, { state: statusToState[receipt.status] ?? 'uncertain' });
      liftReceipt(row, receipt);
      const att = input.attemptId !== undefined && input.attemptId !== null ? latestOf(input.attemptId) : null;
      if (att && receipt.status === 'uncertain') revise(att, { state: 'reconciliation-required' });
      if (att && receipt.status === 'observed') {
        if (input.actionKind === 'place') {
          const fields = {};
          if (typeof receipt.cwd === 'string') fields.placement = { ...(att.placement ?? {}), cwd: receipt.cwd };
          const base = measurePin(receipt.base) ?? measurePin(receipt.sourceBase);
          if (base !== null) {
            if (typeof receipt.artifactSha256 === 'string') base.artifactSha256 = receipt.artifactSha256;
            fields.sourceBase = base;
          }
          revise(att, fields);
        } else if (input.actionKind === 'create' && typeof receipt.agentId === 'string') {
          revise(att, { host: { agentId: receipt.agentId } });
        } else if (input.actionKind === 'send') {
          revise(att, { state: 'running' });
        } else if (input.actionKind === 'archive') {
          revise(att, { state: 'stopped' });
        }
      }
      return { ok: true, actionId: input.actionId, ledgerRevision: bump(), replayed: false };
    }
    if (input.operation === 'integration-admit') {
      const actionId = `act-int-${++counters.action}`;
      const body = input.body ?? {};
      push({
        kind: 'action', entityId: actionId, revision: 1, assignmentId: input.assignmentId,
        taskId: input.taskId, resultId: input.resultId, attemptId: null,
        actionId, actionKind: 'integration', ordinal: counters.action, phase: 'stage',
        body, state: 'issued', receipt: null,
        grant: { authorityRef: input.grant.authorityRef, paths: input.grant.paths, target: input.grant.target ?? null },
        verification: input.verification ?? null,
        sourceBase: measurePin(body.sourceBase), sourceResult: measurePin(body.sourceResult), target: measurePin(body.target),
        sourceBaseSha: body.sourceBaseSha ?? null, sourceResultSha: body.sourceResultSha ?? null,
        targetBaseSha: body.targetBaseSha ?? null,
        targetCwd: input.grant.target?.cwd ?? body.targetCwd ?? null,
        sourceCwd: body.sourceCwd ?? null,
        stageKind: body.stageKind ?? null, stageDir: null, stagedSha: null,
        expectedStageSha: null, expectedSha: null, backupDir: null, recoveryPlan:null, landed:null, checkRuns: null,
        conflicts: Array.isArray(body.conflicts) ? body.conflicts : null,
        changedPaths: Array.isArray(body.changedPaths) ? body.changedPaths : null,
        deltaDigest: body.deltaDigest ?? null,
      });
      return { ok: true, actionId, actionPin: { actionId }, perform: true, ledgerRevision: bump(), replayed: false };
    }
    return { ok: true };
  };
  return {
    calls,
    task: {
      runTaskCommand: async (_ctx, input) => {
        calls.push(input);
        if (input.operation === 'reserve') {
          const attemptId = 'att-1';
          const placeActionId = 'act-place';
          push({
            kind: 'attempt', entityId: attemptId, revision: 1, assignmentId: input.assignmentId,
            attemptId, taskId: input.taskId, state: 'reserved', placement: {
              kind: input.placement.kind, cwd: input.placement.cwd ?? null,
              baseRef: input.placement.baseRef ?? null, workspaceId: input.placement.workspaceId ?? null,
            },
            sourceBase: null, seatPin: input.seatPin, runtime: input.runtime ?? null,
            member: null, host: { agentId: null }, stop: { requested: false, reason: null },
            resultId: null, integrationActionId: null, effectBudget: input.effectBudget ?? null,
          });
          push({
            kind: 'action', entityId: placeActionId, revision: 1, assignmentId: input.assignmentId,
            taskId: input.taskId, attemptId, actionId: placeActionId, actionKind: 'place',
            phase: null, body: { placement: input.placement }, state: 'intended', receipt: null,
          });
          return {
            ok: true, receiptId: 'rc-reserve', taskId: input.taskId, attemptId,
            ledgerRevision: bump(), replayed: false,
            next: { operation: 'issue', actionId: placeActionId },
          };
        }
        if (input.operation === 'reconcile') {
          return { ok: true, receiptId: 'rc-reconcile', taskId: input.taskId ?? null, ledgerRevision: bump(), replayed: false, resolved: [], outstanding: [], bound: [] };
        }
        return { ok: true, receiptId: 'rc-other', taskId: input.taskId ?? null, ledgerRevision: bump(), replayed: false };
      },
      runTaskEffect: async (_ctx, input) => applyEffect(input),
    },
  };
}

function fixtureDeps(w, ledger, host, task, overrides = {}) {
  return {
    store: {
      read: () => ({ state: 'ok', ledger, persistedSchemaVersion: 8 }),
      transact: async () => { throw new Error('adapter never transacts directly'); },
    },
    task,
    host: () => host,
    resolveSeat: overrides.resolveSeat ?? (async () => ({
      provider: 'slp-codex-peer', model: 'm1', modeId: null, thinkingOptionId: null,
      routing: { optionId: 'opt-seat', catalogSha256: 'c'.repeat(64), jev: { required: false, decision: 'none' } },
    })),
    measure: w.measure,
    measureContentMap: createContentMapMeasure(w.fs),
    exec: boundedArgv(),
    fs: w.fs,
    git: w.git,
    scratch: { stableRoot: w.scratch },
    now: () => new Date(NOW),
  };
}

function fixtureLedger(w, extra = {}) {
  return {
    repo: { hostId: 'host-1', gitCommonDir: realpathSync(join(w.repo, '.git')) },
    memberships: [],
    taskEntries: [],
    ...extra,
  };
}

/** A TaskHostApi fixture — records creates/sends; refresh answers the
 *  claimed pins so post-create verification can pass or drift. */
// SDK 0.10 native-create conversion, used at the fixture before-hook boundary.
// The SDK exposes provider/model selection as one string; the hook receives
// separate native fields and top-level parent/workspace request metadata.
function fixtureNativeCreateRequest(options, placement) {
  const {config: agentConfig,cwd,parent,title,prompt,...requestOptions}=options;
  const {provider: selection,options: providerOptions,...runtimeConfig}=agentConfig;
  const separator=selection.indexOf('/');
  if(separator<=0||separator===selection.length-1)throw new Error('Expected config.provider in "provider/model" format');
  return {...requestOptions,config:{...runtimeConfig,provider:selection.slice(0,separator),model:selection.slice(separator+1),
    cwd:placement?.cwd??cwd,...(title!==undefined?{title}:{}),...(providerOptions!==undefined?{providerOptions}:{})},
    ...(placement?{workspaceId:placement.workspaceId}:{}),...(parent?{callerAgentId:typeof parent==='string'?parent:parent.id}:{}),
    ...(prompt!==undefined?{initialPrompt:prompt}:{})};
}

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

function fixtureHost({ agentId = 'agent-new', drift = {}, multi = false } = {}) {
  const calls = { create: [], send: [], archive: [], list: 0 };
  const createdById = new Map();
  const snapshotOf = (id=agentId) => ({
    id, provider: 'slp-codex-peer', model: 'm1', cwd: (createdById.get(id) ?? calls.create.at(-1))?.cwd ?? null,
    workspaceId: null, archivedAt: null, status: 'idle', activeTurn: null,
    labels: { ...(createdById.get(id)?.labels ?? {}), 'paseo.parent-agent-id': 'agent-owner' },
    ...drift,
  });
  const ref = id => ({
    refresh: async () => ({ agent: id === agentId || createdById.has(id) ? snapshotOf(id) : null, project: null }),
    send: async (text, opts) => { calls.send.push({ id, text, opts }); return { messageId: opts?.messageId ?? null }; },
    archive: async () => { calls.archive.push(id); return { archivedAt: NOW }; },
    waitForFinish: async () => ({ status: 'finished' }),
    timeline: {refetch: async () => ({entries:[]})},
  });
  return {
    calls,
    api: {
      agents: {
        create: async opts => { calls.create.push(opts); const id=multi&&calls.create.length>1?`${agentId}-${calls.create.length}`:agentId; createdById.set(id,opts); return { id, refresh: async () => ({ agent: snapshotOf(id), project: null }) }; },
        ref,
        list: async () => { calls.list++; return { entries: [], pageInfo: { hasMore: false, cursor: null } }; },
      },
      workspaces: { ref: () => ({ agents: { create: async opts => { calls.create.push(opts); return { id: agentId, refresh: async () => ({ agent: snapshotOf(), project: null }) }; } } }) },
      timeline: { refetch: async () => ({ entries: [] }) },
    },
  };
}

const dispatchBase = () => ({
  expectedLedgerRevision: 0, expectedBriefRevision: 0, expectedOwnershipRevision: 0,
  expectedTaskRevision: 1, expectedAttemptRevision: 0,
  attemptId: null, grantRef: 'grant:x',
});

const bootstrapInput = (overrides = {}) => ({
  phase: 'bootstrap', requestId: 'req-boot-1', assignmentId: 'asg-1', taskId: 'task-1',
  grantRef: 'grant:create',
  placement: { kind: 'shared-checkout', cwd: null /* filled by caller */, baseRef: 'HEAD' },
  runtime: { optionId: 'opt-seat', catalogSha256: 'c'.repeat(64) },
  title: 'task seat',
  ...dispatchBase(), grantRef:'grant:create', ...overrides,
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
  assert.equal(text, 'do the work');
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

const reuseFixture = (w, drift = {}) => fixtureHost({
  drift: {
    cwd: realpathSync(w.repo), status: 'idle', activeTurn: null,
    archivedAt: null, provider: 'slp-codex-peer', model: 'm1',
    labels: { 'paseo.parent-agent-id': 'agent-owner' },
    ...(drift.cwd === 'OUTSIDE'
      ? { ...drift, cwd: mkdirSync(join(w.dir, 'outside'), { recursive: true }) && realpathSync(join(w.dir, 'outside')) }
      : drift),
  },
});

const reuseInput = (overrides = {}) => ({
  phase: 'reuse', requestId: 'req-reuse-1', assignmentId: 'asg-1', taskId: 'task-1',
  grantRef: 'grant:reuse',
  runtime: { optionId: 'opt-seat', catalogSha256: 'c'.repeat(64) },
  reuseTarget: { agentId: 'agent-new' },
  ...dispatchBase(), grantRef:'grant:create', ...overrides,
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
async function stageFixture(t, attemptId, recipeIds) {
  const w = world(t);
  const ledger = fixtureLedger(w);
  const core = coreDouble(ledger);
  const host = fixtureHost();
  const deps = fixtureDeps(w, ledger, host.api, core.task);
  const placed = await materializeIsolatedPlacement({
    fs: w.fs, git: w.git, repoRoot: w.repo,
    scratchDir: adapterPaths(w.scratch, REPO_KEY).placements(attemptId), baseRef: w.head,
  });
  const baseMeasure = await w.measure(placed.cwd);
  evolveSource(placed.cwd);
  const resultMeasure = await w.measure(placed.cwd);
  const artifactDir = join(w.scratch, 'task-exec', REPO_KEY, 'attempts', attemptId);
  mkdirSync(artifactDir, { recursive: true });
  const artifactBytes = JSON.stringify(baseMeasure);
  writeFileSync(join(artifactDir, 'base.measure.json'), artifactBytes);
  ledger.taskEntries.push(
    { kind: 'attempt', entityId: attemptId, revision: 1, assignmentId: 'asg-1',
      attemptId, taskId: 'task-1', state: 'running',
      placement: { cwd: placed.cwd, kind: 'isolated' },
      sourceBase: { snapshotSha256: baseMeasure.sha256, head: baseMeasure.head, root: baseMeasure.root, kind: 'git-snapshot',
        measuredAt: NOW, incomplete: [], artifactSha256: sha256Hex(artifactBytes) },
      stop: { requested: false, reason: null }, member: null, host: { agentId: 'agent-new' },
      resultId: `res-${attemptId}` },
    { kind: 'result', entityId: `res-${attemptId}`, revision: 1, assignmentId: 'asg-1', taskId: 'task-1',
      resultId: `res-${attemptId}`, attemptId, snapshotSha256: resultMeasure.sha256, candidate: null },
  );
  const staged = await mechanicalIntegration(fixtureCtx(), {
    phase: 'stage', requestId: `req-${attemptId}-stage`, assignmentId: 'asg-1',
    taskId: 'task-1', resultId: `res-${attemptId}`,
    expectedLedgerRevision: 0, integrationActionId: null,
    grant: { authorityRef: 'grant:i', paths: ['changed.txt', 'added.txt', 'deleted.txt', 'script.sh', 'link.txt'], target: { cwd: w.repo } },
    verification: { recipeIds },
    stageKind: 'git-worktree',
  }, deps);
  assert.equal(staged.staged, true, JSON.stringify(staged));
  const integ = ledger.taskEntries.find(r => r.actionId === staged.integrationActionId);
  integ.targetCwd = realpathSync(w.repo);
  integ.sourceCwd = placed.cwd;
  integ.targetBaseSha = (await w.measure(w.repo)).sha256;
  integ.sourceResultSha = resultMeasure.sha256;
  return { w, ledger, core, deps, staged, integ };
}

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
function taskWithInjectedEffect(core, inject) {
  return {
    runTaskCommand: core.task.runTaskCommand,
    runTaskEffect: async (ctx, input) => {
      const replacement = inject(input);
      if (replacement !== undefined) {
        core.calls.push(input);
        return replacement;
      }
      return core.task.runTaskEffect(ctx, input);
    },
  };
}

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

const REAL_REPO = w => ({ hostId: 'local', gitCommonDir: realpathSync(join(w.repo, '.git')) });

const realMember = (agentId, createCwd, role, over = {}) => ({
  membershipId: crypto.randomUUID(),
  state: 'host-confirmed',
  bindingHandleSha256: sha256Hex(`handle:${agentId}`),
  provider: 'slp-codex-peer',
  family: 'codex',
  role,
  createCwd,
  openGeneration: 1,
  agentId,
  workspaceId: null,
  createdAt: NOW,
  hostConfirmedAt: NOW,
  registeredAt: NOW,
  revokedAt: null,
  revokeReason: null,
  ...over,
});

async function realDesk(t, options = {}) {
  const w = world(t);
  const repo = REAL_REPO(w);
  const repoKey = repoKeyFor(repo);
  const stableRoot = join(w.scratch, 'desk-store');
  const store = createDeskStore({ stableRoot });
  const seatWarnings=[];
  const seatHooks = createDeskSeat({stableRoot,store,now:()=>new Date(NOW),warn:message=>seatWarnings.push(message)});
  let owner = realMember('agent-owner', realpathSync(w.repo), 'lead', { provider: 'slp-codex-lead' });
  if(options.actualOwner){
    const minted=await seatHooks.deskMint({provider:'slp-codex-lead',family:'codex',role:'lead',cwd:w.repo,env:{}});
    assert.ok(minted);
    await seatHooks.deskBind({agentId:'agent-owner',workspaceId:null,provider:'slp-codex-lead',cwd:w.repo,
      reason:'create',purpose:'interactive',env:{SLP_DESK_HANDLE:minted.handle}});
    await seatHooks.deskRegister({agent:{id:'agent-owner',workspaceId:null,parentAgentId:null,provider:'slp-codex-lead',cwd:w.repo,title:null}});
    owner=store.read(repoKey).ledger.memberships.find(row=>row.agentId==='agent-owner');assert.ok(owner);
  }else{
    const seeded = await store.transact(repoKey, {
      repo,actorKey:'desk:hook',assignmentId:'unassigned',requestId:'seed-owner',command:{kind:'seed'},
    }, () => ({ok:true,events:[],memberships:[owner,...Array.from({length:options.legacyMemberships??0},(_,index)=>
      realMember(`legacy-${index}`,realpathSync(w.repo),'peer',{membershipId:uuid(index+10000),state:'revoked',revokedAt:NOW,revokeReason:'archived'}))]}));
    assert.equal(seeded.ok,true,JSON.stringify(seeded));
  }
  const ctx = {repoKey,row:owner};
  const ledger = () => {const r=store.read(repoKey);assert.equal(r.state,'ok',JSON.stringify(r));return r.ledger;};
  const registered = await runAssignmentRegister(ctx,{requestId:'register',authorityRef:'grant:desk',objective:'bounded task fixture'},{store});
  assert.equal(registered.ok,true,JSON.stringify(registered));
  const assignmentId = registered.assignmentId;
  const workspaceId = options.workspaceId ?? null;
  const host = fixtureHost({multi:true,drift:{workspaceId}});
  const deps = fixtureDeps(w,null,host.api,{runTaskCommand,runTaskEffect});
  deps.store = store;
  deps.task={runTaskCommand,runTaskEffect:async(ctx,input,runnerDeps)=>{
    try{return await runTaskEffect(ctx,input,runnerDeps);}catch(error){
      throw new Error(`actual Core ${input.operation}/${input.body?.phase??input.receipt?.phase??input.actionKind??'unknown'}/${input.body?.cleanupStep??input.receipt?.cleanupStep??'ordinary'}: ${error.message}`,{cause:error});
    }
  }};
  const hookEnvs=new Map(),hookTrace={calls:0,mints:0,nativeEffects:0};
  const runtimeFixture=join(w.scratch,'hook-candidate-fixture'),modulePath='plugin/server/runtime/cli/role-bundle.ts';
  mkdirSync(join(runtimeFixture,'plugin/server/runtime/cli'),{recursive:true});
  writeFileSync(join(runtimeFixture,modulePath),readFileSync(fileURLToPath(new URL('../plugin/server/runtime/cli/role-bundle.ts',import.meta.url))),{mode:0o600});
  // Minimal module-selection receipt is fixture data, not a verified runtime
  // installation. Candidate integrity and policy rendering are stubbed below.
  writeFileSync(join(runtimeFixture,'installed.json'),JSON.stringify({candidate:{files:[{path:modulePath}]}}),{mode:0o600});
  const injection=createRoleInjection({
    readActiveBinding:()=>({runtimePath:runtimeFixture,candidateSha256:'c'.repeat(64),
      payloadSha256:'d'.repeat(64),nodePath:process.execPath,daemonHome:w.scratch}),
    // Candidate verification is a fixture; role injection/mint/store are real.
    verifyCandidate:()=>{},
    // Rendering/candidate integrity is outside this authority fixture. No
    // production runtime installation or verification claim is performed.
    importModule:async()=>({roleBundle:(_root,role)=>({role,instructions:`SLP role=${role}\nfixture policy renderer\n`})}),
    deskMint:async input=>{hookTrace.mints++;return seatHooks.deskMint(input);},
  });
  const registerCreated = async (opts=host.calls.create.at(-1), handle={id:host.calls.create.length>1?`agent-new-${host.calls.create.length}`:'agent-new'}) => {
    const env=hookEnvs.get(handle.id)??[...hookEnvs.values()].at(-1);assert.ok(env,'membership handle comes from the actual config/env before-hook');
    await seatHooks.deskBind({agentId:handle.id,workspaceId,provider:'slp-codex-peer',cwd:opts.cwd,
      reason:'create',purpose:'interactive',env});
    await seatHooks.deskRegister({agent:{id:handle.id,workspaceId,parentAgentId:'agent-owner',
      provider:'slp-codex-peer',cwd:opts.cwd,title:null}});
  };
  const create = host.api.agents.create;
  host.api.agents.create = async opts => {
    const attempts = ledger().taskEntries.filter(r=>r.kind==='attempt');
    const attempt = latestTaskEntity(ledger(),attempts.at(-1).attemptId);
    const createAction = ledger().taskEntries.filter(r=>r.kind==='action'&&r.actionKind==='create').at(-1);
    assert.equal(createAction.state,'issued','real admission precedes SDK create');
    assert.equal(attempt.member,null);
    assert.equal(attempt.boundScopeId,null,'create does not grant write scope');
    assert.equal(attempt.member,null,'new task does not reuse the prior attached seat');
    assert.equal('prompt' in opts,false);
    const raw=fixtureNativeCreateRequest(opts,{workspaceId,cwd:opts.cwd}),projected={config:raw.config,env:raw.env};
    hookTrace.calls++;assert.deepEqual(Object.keys(projected).sort(),['config','env']);
    const request=options.transformHook?options.transformHook(projected):projected;
    const hooked=await injection.agentCreate({request});
    assert.ok(hooked);assert.equal(Object.hasOwn(hooked.env,DESK_TASK_CREATE_TICKET_KEY),false);
    assert.ok(hooked.env.SLP_DESK_HANDLE);assert.ok(hooked.config.systemPrompt.startsWith('SLP role=peer'));
    const claim=ledger().memberships.find(row=>row.bindingHandleSha256===sha256Hex(hooked.env.SLP_DESK_HANDLE)).capacityClaim;
    assert.equal(claim.version,2);assert.equal(claim.basis,'create-ticket');assert.equal(claim.createActionId,createAction.actionId);
    assert.equal(claim.ticketSha256,createAction.body.createTicketSha256);
    if(options.afterMint)await options.afterMint({store,repoKey,claim});
    hookTrace.nativeEffects++;
    const handle = await create(opts);
    hookEnvs.set(handle.id,hooked.env);
    if(!options.delayedRegistration)await registerCreated(opts,handle);
    if(options.lostCreateAck) throw new Error('fixture lost create response after effect');
    return handle;
  };
  // A workspace create follows the same native config/env hook and seat
  // registration path as a direct create; metadata stays outside the hook.
  host.api.workspaces.ref = id => ({agents:{create:opts=>{
    assert.equal(id,workspaceId);
    return host.api.agents.create({...opts,cwd:w.repo});
  }}});
  const ref = host.api.agents.ref;
  host.api.agents.ref = id => {
    const h=ref(id);
    return {...h,refresh:async(...args)=>{const result=await h.refresh(...args);return options.transformSnapshot?options.transformSnapshot(result):result;},send:async (text,opts)=>{
      const a = ledger().taskEntries.filter(r=>r.kind==='attempt'&&r.host.agentId===id)
        .map(r=>latestTaskEntity(ledger(),r.attemptId)).at(-1);
      assert.ok(a.boundScopeId,'actual scope binding precedes SDK send');
      assert.ok(ledger().scopeTransitions.some(r=>r.scopeId===a.boundScopeId&&r.to==='claimed'));
      const scope=ledger().scopes.find(r=>r.scopeId===a.boundScopeId);
      if(scope.ownership!==null)assert.equal(scope.ownership.writerAgentId,id);
      assert.equal(scope.seatAgentId,id);
      const send=ledger().taskEntries.filter(r=>r.kind==='action'&&r.actionKind==='send').at(-1);
      assert.equal(send.state,'issued');
      await h.send(text,opts);
      if(options.lostSendAck) throw new Error('fixture lost send response after effect');
    }};
  };
  const taskCommand = input => runTaskCommand(ctx,input,{store,observe:createTaskObserver(ctx,deps)});
  const define = async (taskId='task-1',over={}) => {
    const out=await taskCommand({operation:'define',requestId:`define-${taskId}`,assignmentId,taskId,
      expectedLedgerRevision:ledger().revision,expectedBriefRevision:0,expectedOwnershipRevision:0,expectedTaskRevision:0,
      task:taskSpec(over)});
    assert.equal(out.ok,true,JSON.stringify(out));return out.taskId;
  };
  const bootInput = (taskId='task-1',over={}) => bootstrapInput({requestId:`boot-${taskId}`,assignmentId,taskId,
    expectedLedgerRevision:ledger().revision,expectedTaskRevision:latestTask(ledger(),assignmentId,taskId).revision,
    placement:{kind:'shared-checkout',cwd:w.repo,baseRef:w.head},...over});
  const sendInput = (attemptId,requestId='send-1') => ({phase:'send',requestId,assignmentId,
    taskId:latestTaskEntity(ledger(),attemptId).taskId,grantRef:'grant:send',attemptId,text:'perform bounded work',
    expectedLedgerRevision:ledger().revision,expectedBriefRevision:0,expectedOwnershipRevision:0,
    expectedTaskRevision:latestTask(ledger(),assignmentId,latestTaskEntity(ledger(),attemptId).taskId).revision,
    expectedAttemptRevision:latestTaskEntity(ledger(),attemptId).revision});
  return {w,repo,repoKey,store,ctx,owner,ledger,taskCommand,deps,host,assignmentId,define,bootInput,sendInput,registerCreated,seatHooks,injection,hookEnvs,hookTrace,seatWarnings,
    get seat(){return ledger().memberships.find(m=>m.agentId==='agent-new');}};
}

function taskSpec(over={}) {
  return {state:'open',outcome:'land the granted delta',objective:null,authorityRef:'grant:desk',dependencies:[],
    scope:{label:'bounded writer',refs:['grant:desk'],ownership:{writerAgentId:'future-seat',writerAuthorityRef:null,
      paths:['changed.txt','added.txt','deleted.txt','script.sh','link.txt'],resources:[],stateOwners:[],dependsOnScopeIds:[],notifications:[]},
      reviewPlan:{kind:'not-required',authorityRef:'grant:desk',ruleRef:'fixture:scope',reason:'fixture no independent mandate',lenses:[],exemptionClass:null}},
    proofPolicy:{kind:'declared',authorityRef:'grant:i',ruleRef:'rule:i',reason:'verify candidate',requiredChecks:[],requiredEvidence:[],
      reviewRequired:false,availability:'integrated-code',verificationRecipes:[{recipeId:'verify',argv:[process.execPath,'-e','process.exit(0)'],
        cwd:'.',timeoutMs:5000,maxOutputBytes:4096,required:true,authorityRef:'grant:i',ruleRef:'rule:i'}]},
    grants:{create:'grant:create',send:'grant:send',archive:'grant:archive',integrate:'grant:i',commit:null},
    budgets:{maxAttempts:null,maxActionsPerAttempt:null},reason:null,...over};
}

async function realLifecycle(t, {nonDefaultUmask=false,cleanupFailure=false,finalMismatch=false,artifactDependency=false}={}) {
  const d = await realDesk(t);
  const { w, ctx, deps, ledger, taskCommand, assignmentId } = d;

  await d.define();
  const taskRow = () => latestTask(ledger(), assignmentId, 'task-1');

  // BOOTSTRAP — prompt-free reserve → place issue/observe → create → bind,
  // all against real Core state transitions.
  const boot = await runTaskDispatch(ctx, bootstrapInput({
    requestId: 'req-real-boot', assignmentId,
    expectedLedgerRevision: ledger().revision,
    expectedTaskRevision: taskRow().revision,
    placement: { kind: 'shared-checkout', cwd: w.repo, baseRef: w.head },
    runtime: { optionId: 'opt-seat', catalogSha256: 'c'.repeat(64) },
  }), deps);
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.equal(boot.state, 'bound', JSON.stringify(boot));
  assert.equal(boot.agentId, 'agent-new');
  const attemptId = boot.attemptId;
  // The create carried no prompt — the seat materializes empty, the task
  // brief rides the durable record, not the agent constructor.
  assert.equal(d.host.calls.create.length, 1);
  assert.equal(d.host.calls.create[0].prompt, undefined);
  const attempt = () => latestTaskEntity(ledger(), attemptId);
  assert.equal(attempt().kind, 'attempt');
  assert.equal(attempt().state, 'bound');
  assert.equal(attempt().member.agentId, 'agent-new');
  assert.equal(attempt().member.membershipId, d.seat.membershipId);
  assert.equal(attempt().sourceBase.artifactSha256.length, 64);
  assert.ok(attempt().boundScopeId);
  assert.equal(attempt().boundScopeRevision,1);
  assert.equal(ledger().assignments.find(a=>a.assignmentId===assignmentId).seats.length,1);
  assert.equal(ledger().scopes.find(s=>s.scopeId===attempt().boundScopeId).ownership.writerAgentId,'agent-new');

  // SEND — the bound member tuple was registered durably by the real bind.
  const sent = await runTaskDispatch(ctx, {
    phase: 'send', requestId: 'req-real-send', assignmentId: assignmentId, taskId: 'task-1',
    grantRef: 'grant:send', attemptId,
    expectedAttemptRevision: attempt().revision, expectedLedgerRevision: ledger().revision,
    expectedBriefRevision: 0, expectedOwnershipRevision: 0, expectedTaskRevision: taskRow().revision,
    text: 'do the work',
  }, deps);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.sent, true);
  assert.equal(attempt().state, 'running');

  // Evolve the source in place — the shared checkout IS the result tree.
  evolveSource(w.repo);

  // RESULT — measured provenance, real entry commit.
  const resultMeasure = await w.measure(w.repo);
  const handback=await runHandbackSubmit({repoKey:d.repoKey,row:d.seat},{requestId:'result-handback',assignmentId,candidateId:null,
    recordV1:{version:1,kind:'handback',seat:{role:'peer',disposition:'engineer',agentId:d.seat.agentId},verdict:null,
      candidate:{repository:w.repo,snapshotSha256:resultMeasure.sha256},checks:[]}},
    {store:d.store,binding:{runtimePath:'/fixture/runtime',nodePath:process.execPath},uuid:()=>crypto.randomUUID(),now:()=>new Date(NOW),
      capture:async ({repository})=>{const m=await w.measure(repository);return {status:'ok',repository:m.root,measuredAt:m.measuredAt,
        snapshotSha256:m.sha256,head:m.head,incomplete:m.incomplete};}});
  assert.equal(handback.ok,true,JSON.stringify(handback));
  const candidate=ledger().candidates.find(c=>c.candidateId===handback.observedCandidateId);
  assert.ok(candidate);
  for (const transition of ['submit-for-review','review-observed','approve']) {
    const out=await runScopeTransition(ctx,{requestId:`scope-${transition}`,assignmentId,scopeId:attempt().boundScopeId,
      transition,scopeRevision:attempt().boundScopeRevision,candidateSnapshot:transition==='submit-for-review'?resultMeasure.sha256:null,
      candidateHead:transition==='submit-for-review'?resultMeasure.head:null,briefRevision:0},{store:d.store});
    assert.equal(out.ok,true,JSON.stringify(out));
  }
  const resulted = await taskCommand({
    operation: 'result', requestId: 'req-real-result', assignmentId: assignmentId,
    taskId: 'task-1', attemptId,
    expectedTaskRevision: taskRow().revision,
    expectedLedgerRevision: ledger().revision,
    expectedBriefRevision: 0, expectedOwnershipRevision: 0,
    result: {
      snapshotSha256: resultMeasure.sha256, candidate: {snapshotSha256:candidate.snapshotSha256,head:candidate.head,candidateId:candidate.candidateId},
      handbackId: handback.handbackId, handbackDigest: ledger().handbacks.find(h=>h.handbackId===handback.handbackId).recordSha256, artifacts: [{key:'work-product',sha256:sha256Hex(readFileSync(join(w.repo,'changed.txt')))}],
      scopeId: attempt().boundScopeId, scopeRevision: attempt().boundScopeRevision, reviewRound: {scopeRevision:attempt().boundScopeRevision,
        candidateSnapshot:resultMeasure.sha256,briefRevision:0,
        mandateSha256:ledger().scopeTransitions.find(r=>r.scopeId===attempt().boundScopeId&&r.command==='submit-for-review').mandateSha256},
      checkRuns: [], findings: [], provenance: 'measured',
    },
  });
  assert.equal(resulted.ok, true, JSON.stringify(resulted));
  const resultId = resulted.resultId;
  const resultRow = () => latestTaskEntity(ledger(), resultId);
  assert.equal(resultRow().kind, 'result');

  // RULE — accepted adjudication unblocks integration admission.
  const ruled = await taskCommand({
    operation: 'rule', requestId: 'req-real-rule', assignmentId: assignmentId,
    taskId: 'task-1', expectedTaskRevision: taskRow().revision,
    expectedLedgerRevision: ledger().revision,
    expectedBriefRevision: 0, expectedOwnershipRevision: 0,
    adjudication: {
      resultId, expectedResultRevision: resultRow().revision,
      verdict: 'accepted', reason: 'the measured result stands',
      evidence: [], counterevidence: [], residualRisk: null, findings: [],
    },
  });
  assert.equal(ruled.ok, true, JSON.stringify(ruled));
  const adjudicationRow = () => latestTaskEntity(ledger(), ruled.adjudicationId ?? resultId);
  const rulingRevision = ruled.adjudicationId !== undefined
    ? latestTaskEntity(ledger(), ruled.adjudicationId)?.revision ?? 1
    : 1;

  // The integration target must bind to the desk's repository — a second
  // worktree of the same repo at the BASE commit keeps the delta a real
  // apply instead of a noop onto the source checkout.
  const target = join(w.dir, 'target');
  git(w.repo, ['worktree', 'add', '--detach', target, w.head]);
  t.after(() => {
    try {
      execFileSync('git', ['-C', w.repo, 'worktree', 'remove', '--force', target],
        { stdio: ['ignore', 'ignore', 'ignore'], env: GIT_ENV });
    } catch { /* discharged or already cleaned */ }
  });

  writeFileSync(join(target,'prior-work.txt'),'unrelated dirty bytes\n');

  // STAGE — integration admission mints an issued action (admission IS the
  // issue); the adapter materializes the candidate under owned scratch.
  const staged = await runTaskIntegration(ctx, {
    phase: 'stage', requestId: 'req-real-stage', assignmentId: assignmentId,
    taskId: 'task-1', resultId,
    expectedLedgerRevision: ledger().revision,
    expectedResultRevision: resultRow().revision,
    expectedAdjudicationRevision: rulingRevision,
    integrationActionId: null,
    grant: {
      authorityRef: 'grant:i',
      paths: ['changed.txt', 'added.txt', 'deleted.txt', 'script.sh', 'link.txt'],
      target: { cwd: target },
    },
    verification: { recipeIds: ['verify'] },
    stageKind: 'git-worktree',
  }, deps);
  assert.equal(staged.ok, true, JSON.stringify(staged));
  assert.equal(staged.staged, true, JSON.stringify(staged));
  const integrationActionId = staged.integrationActionId;
  assert.ok(integrationActionId);
  const integ = () => latestTaskEntity(ledger(), integrationActionId);
  assert.equal(integ().state, 'observed');
  assert.equal(integ().stageKind, 'git-worktree');
  assert.equal(realpathSync(integ().stageDir), realpathSync(staged.stageDir));

  // CHECK — durable admission gates recipe execution; the 'verify' recipe
  // is pinned on the task's proof policy and must run inside the stage.
  const checked = await runTaskIntegration(ctx, {
    phase: 'check', requestId: 'req-real-check', assignmentId: assignmentId,
    taskId: 'task-1', resultId, expectedLedgerRevision: ledger().revision,
    integrationActionId, expectedActionRevision:integ().revision,
    expectedResultRevision:resultRow().revision, expectedAdjudicationRevision:rulingRevision,
  }, deps);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.checkRuns[0].recipeId, 'verify');
  assert.equal(checked.checkRuns[0].status, 'passed');
  assert.equal(integ().checkRuns[0].status, 'passed');

  if(finalMismatch) {
    const copy=deps.fs.copyFile;
    deps.fs={...deps.fs,copyFile:(src,dst,mode)=>{
      if(dst===join(target,'changed.txt'))deps.fs.writeFile(dst,Buffer.from('fault injected bytes\n'),mode);
      else copy(src,dst,mode);
    }};
  }
  // LAND — intent → issue → backup → apply → final verify; the action row
  // carries the landed measure pin and backup path.
  const landed = await runTaskIntegration(ctx, {
    phase: 'land', requestId: 'req-real-land', assignmentId: assignmentId,
    taskId: 'task-1', resultId, expectedLedgerRevision: ledger().revision,
    integrationActionId, expectedActionRevision:integ().revision,
    expectedResultRevision:resultRow().revision, expectedAdjudicationRevision:rulingRevision,
  }, deps);
  assert.equal(landed.ok, true, JSON.stringify(landed));
  if(finalMismatch) {
    assert.equal(landed.landed,false,JSON.stringify(landed));
    assert.equal(landed.held,'final-mismatch');
    assert.equal(integ().state,'held');assert.equal(integ().landed,null,'unverified bytes never mint a landed pin');
    assert.ok(integ().receipt.measuredFinal);
    assert.ok(existsSync(landed.backupDir));
    assert.equal(readFileSync(join(landed.backupDir,integ().receipt.backupManifest.find(e=>e.path==='changed.txt').blobKey),'utf8'),'before\n');
    const plan=integ().recoveryPlan;assert.ok(plan);
    const refused=await runTaskIntegration(ctx,{phase:'discharge',requestId:'mismatch-cleanup',assignmentId,taskId:'task-1',resultId,
      expectedLedgerRevision:ledger().revision,expectedResultRevision:resultRow().revision,expectedAdjudicationRevision:rulingRevision,
      expectedActionRevision:integ().revision,integrationActionId,grantRef:'grant:i'},deps);
    assert.notEqual(refused.discharged,true,JSON.stringify(refused));assert.ok(existsSync(plan.stageDir));assert.ok(existsSync(plan.backupDir));
    await assertRecoveryTargetFenced(d,'mismatch',target);
    return;
  }
  assert.equal(landed.landed, true, JSON.stringify(landed));
  assert.equal(integ().state, 'observed');
  assert.ok(integ().landed !== null, 'landed measure pin recorded');
  assert.equal(readFileSync(join(target, 'changed.txt'), 'utf8'), 'after\n');
  assert.equal(readFileSync(join(target, 'added.txt'), 'utf8'), 'new\n');
  assert.equal(existsSync(join(target, 'deleted.txt')), false);
  assert.equal(readlinkSync(join(target, 'link.txt')), 'changed.txt');

  const deniedCleanup=await runTaskIntegration(ctx,{phase:'discharge',requestId:'denied-cleanup',assignmentId,
    taskId:'task-1',resultId,expectedLedgerRevision:ledger().revision,expectedResultRevision:resultRow().revision,
    expectedAdjudicationRevision:rulingRevision,expectedActionRevision:integ().revision,integrationActionId,grantRef:'foreign:grant'},deps);
  assert.equal(deniedCleanup.ok,false,JSON.stringify(deniedCleanup));
  assert.equal(deniedCleanup.code,'AUTHORITY_REQUIRED');
  assert.ok(existsSync(staged.stageDir),'denied cleanup preserves candidate proof');
  assert.ok(existsSync(landed.backupDir),'denied cleanup preserves backups');

  if(cleanupFailure) {
    deps.git={...deps.git,worktreeRemove:async ()=>{throw new Error('fixture denied worktree removal');}};
  }
  // DISCHARGE — admitted cleanup removes stage + backup durably.
  const resultForCleanup={taskId:'task-1',resultId,rulingId:ruled.adjudicationId};
  const discharged=await fixtureCleanup(d,resultForCleanup,integrationActionId,'req-real-discharge');
  assert.equal(discharged.ok, true, JSON.stringify(discharged));
  if(cleanupFailure) {
    assert.equal(discharged.discharged,false,JSON.stringify(discharged));
    assert.equal(integ().state,'held');assert.ok(discharged.gap);
    assert.ok(existsSync(staged.stageDir),'failed cleanup preserves staged candidate');
    const artifact=join(w.scratch,'task-exec',d.repoKey,'integrations',integrationActionId,'source-result.measure.json');
    assert.equal(sha256Hex(readFileSync(artifact)),integ().sourceResult.artifactSha256,'dependency artifact survives');
    const replay=await runTaskIntegration(ctx,{phase:'discharge',requestId:integ().body.publicRequestId,assignmentId,
      taskId:'task-1',resultId,expectedLedgerRevision:integ().body.controlPins.expectedLedgerRevision,
      expectedResultRevision:resultRow().revision,expectedAdjudicationRevision:rulingRevision,
      expectedActionRevision:integ().body.controlPins.expectedActionRevision,integrationActionId,grantRef:'grant:i'},deps);
    assert.equal(replay.perform,false,'cleanup failure replay runs zero new removals');
    assert.ok(existsSync(staged.stageDir));return;
  }
  assert.equal(discharged.discharged, true, JSON.stringify(discharged));
  assert.equal(existsSync(staged.stageDir), false);
  assert.equal(integ().phase, 'discharge');
  assert.equal(readFileSync(join(target,'prior-work.txt'),'utf8'),'unrelated dirty bytes\n');
  const savedMap=join(w.scratch,'task-exec',d.repoKey,'integrations',integrationActionId,'source-result.measure.json');
  assert.ok(existsSync(savedMap),'dependency proof survives stage/backup discharge');
  assert.equal(sha256Hex(readFileSync(savedMap)),integ().sourceResult.artifactSha256);

  // The producer maps survive discharge and establish availability in an
  // actual isolated consumer commit tree; dirty working bytes are not its base.
  git(w.repo,['add','-A']);git(w.repo,['commit','-m','fixture producer base']);
  const consumerRef=git(w.repo,['rev-parse','HEAD']);
  writeFileSync(join(w.repo,'changed.txt'),'dirty producer checkout must not be copied\n');
  const consumerScope=taskSpec().scope;
  await d.define('consumer',{dependencies:[{taskId:'task-1',availability:artifactDependency?'artifact':'integrated-code',
    artifactKey:artifactDependency?'work-product':null,targetPath:artifactDependency?'changed.txt':null,target:null}],
    scope:{...consumerScope,ownership:{...consumerScope.ownership,paths:['consumer.txt']}}});
  const consumerInput=d.bootInput('consumer',{placement:{kind:'isolated',baseRef:consumerRef},effectBudget:8});
  if (nonDefaultUmask) {
    const add=deps.git.worktreeAdd;
    deps.git={...deps.git,worktreeAdd:async (repo,dir,ref)=>{
      if(dir.includes('/placements/')) {
        execFileSync(process.execPath,['--input-type=module','-e',
          "import {execFileSync} from 'node:child_process'; process.umask(0o077); execFileSync('git',JSON.parse(process.argv[1]),{stdio:'pipe'});",
          JSON.stringify(['--no-optional-locks','-C',repo,'worktree','add','--detach',dir,ref])],{env:GIT_ENV});
      } else await add(repo,dir,ref);
    }};
  }
  const consumer=await runTaskDispatch(ctx,consumerInput,deps);
  if(nonDefaultUmask) {
    assert.equal(consumer.held,'reference-materialization-mismatch',JSON.stringify(consumer));
    assert.equal(d.host.calls.create.length,1,'mode mismatch creates zero consumer seats');
    assert.equal(d.host.calls.send.length,1,'mode mismatch sends zero consumer work');
    assert.ok(existsSync(consumer.placementCwd),'unresolved materialized worktree is retained');
    assert.equal(lstatSync(join(consumer.placementCwd,'changed.txt')).mode & 0o777,0o600);
    const place=ledger().taskEntries.filter(r=>r.kind==='action'&&r.actionKind==='place'&&r.attemptId===consumer.attemptId).at(-1);
    assert.equal(place.state,'held');
    assert.equal(place.body.dependencyObservation.reference.modeSemantics,'git-tree-executable-class');
    return;
  }
  assert.equal(consumer.state,'bound',JSON.stringify(consumer));
  const consumerAttempt=latestTaskEntity(ledger(),consumer.attemptId);
  assert.equal(readFileSync(join(consumerAttempt.placement.cwd,'changed.txt'),'utf8'),'after\n');
  assert.equal(consumerAttempt.consumedDependencies[0].resultId,resultId);
  const consumerPlace=ledger().taskEntries.filter(r=>r.kind==='action'&&r.actionKind==='place'&&r.attemptId===consumer.attemptId).at(-1);
  const reference=consumerPlace.body.dependencyObservation.reference;
  assert.equal(reference.resolvedHead,consumerRef);
  assert.equal(reference.modeSemantics,'git-tree-executable-class');
  assert.equal(reference.mapSha256,measureMapSha256(await w.measure(consumerAttempt.placement.cwd)));
  const consumerSend=await runTaskDispatch(ctx,d.sendInput(consumer.attemptId,'consumer-send'),deps);
  assert.equal(consumerSend.sent,true,JSON.stringify(consumerSend));
  assert.equal(d.host.calls.send.length,2);

  // RECONCILE — every effect is observed so nothing is outstanding; Core
  // still answers the closed vocabulary rather than an adapter guess.
  const reconciled = await runTaskReconciliation(ctx, {
    requestId: 'req-real-reconcile', assignmentId: assignmentId, taskId: 'task-1',
    attemptIds: [attemptId], actionIds: [],
    resourceIds: [], observationTypes: ['action'],
  }, deps);
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));

}

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

async function observeAndRuleTask(d,taskId,attemptId,changedPath,contents) {
  const attempt=()=>latestTaskEntity(d.ledger(),attemptId);
  const root=attempt().placement.cwd;
  writeFileSync(join(root,changedPath),contents);
  const measured=await d.w.measure(root);
  const member=d.ledger().memberships.find(m=>m.membershipId===attempt().member.membershipId);
  const handback=await runHandbackSubmit({repoKey:d.repoKey,row:member},{requestId:`handback-${taskId}`,
    assignmentId:d.assignmentId,candidateId:null,recordV1:{version:1,kind:'handback',seat:{role:'peer',disposition:'engineer',agentId:member.agentId},
      verdict:null,candidate:{repository:root,snapshotSha256:measured.sha256},checks:[]}},
    {store:d.store,binding:{nodePath:process.execPath,runtimePath:'/fixture/runtime'},uuid:()=>crypto.randomUUID(),now:()=>new Date(NOW),
      capture:async ({repository})=>{const m=await d.w.measure(repository);return {status:'ok',repository:m.root,measuredAt:m.measuredAt,
        snapshotSha256:m.sha256,head:m.head,incomplete:m.incomplete};}});
  assert.equal(handback.ok,true,JSON.stringify(handback));
  const candidate=d.ledger().candidates.find(c=>c.candidateId===handback.observedCandidateId);assert.ok(candidate);
  for(const transition of ['submit-for-review','review-observed','approve']) {
    const out=await runScopeTransition(d.ctx,{requestId:`scope-${taskId}-${transition}`,assignmentId:d.assignmentId,
      scopeId:attempt().boundScopeId,scopeRevision:attempt().boundScopeRevision,transition,briefRevision:0,
      candidateSnapshot:transition==='submit-for-review'?measured.sha256:null,candidateHead:transition==='submit-for-review'?measured.head:null},{store:d.store});
    assert.equal(out.ok,true,JSON.stringify(out));
  }
  const round=d.ledger().scopeTransitions.find(r=>r.scopeId===attempt().boundScopeId&&r.command==='submit-for-review');
  const captured=d.ledger().handbacks.find(h=>h.handbackId===handback.handbackId);
  const resulted=await d.taskCommand({operation:'result',requestId:`result-${taskId}`,assignmentId:d.assignmentId,taskId,attemptId,
    expectedLedgerRevision:d.ledger().revision,expectedBriefRevision:0,expectedOwnershipRevision:0,
    expectedTaskRevision:latestTask(d.ledger(),d.assignmentId,taskId).revision,
    result:{snapshotSha256:measured.sha256,candidate:{snapshotSha256:candidate.snapshotSha256,head:candidate.head,candidateId:candidate.candidateId},
      handbackId:captured.handbackId,handbackDigest:captured.recordSha256,artifacts:[],scopeId:attempt().boundScopeId,
      scopeRevision:attempt().boundScopeRevision,reviewRound:{scopeRevision:round.scopeRevision,candidateSnapshot:round.candidateSnapshot,
        briefRevision:round.briefRevision,mandateSha256:round.mandateSha256},checkRuns:[],findings:[],provenance:'measured'}});
  assert.equal(resulted.ok,true,JSON.stringify(resulted));
  const resultId=resulted.resultId;
  const ruled=await d.taskCommand({operation:'rule',requestId:`rule-${taskId}`,assignmentId:d.assignmentId,taskId,
    expectedLedgerRevision:d.ledger().revision,expectedBriefRevision:0,expectedOwnershipRevision:0,
    expectedTaskRevision:latestTask(d.ledger(),d.assignmentId,taskId).revision,
    adjudication:{resultId,expectedResultRevision:latestTaskEntity(d.ledger(),resultId).revision,verdict:'accepted',
      reason:'fixture owner adjudicates the observed bounded result',evidence:[],counterevidence:[],residualRisk:null,findings:[]}});
  assert.equal(ruled.ok,true,JSON.stringify(ruled));
  return {taskId,attemptId,resultId,rulingId:ruled.adjudicationId};
}

function integrationRequest(d,result,phase,requestId,actionId=null) {
  const r=latestTaskEntity(d.ledger(),result.resultId);const ruling=latestTaskEntity(d.ledger(),result.rulingId);
  const common={phase,requestId,assignmentId:d.assignmentId,taskId:result.taskId,resultId:result.resultId,
    expectedLedgerRevision:d.ledger().revision,expectedResultRevision:r.revision,expectedAdjudicationRevision:ruling.revision,
    integrationActionId:actionId};
  return phase==='stage'?{...common,grant:{authorityRef:'grant:i',paths:latestTask(d.ledger(),d.assignmentId,result.taskId).scope.ownership.paths,
    target:{cwd:d.w.repo}},verification:{recipeIds:['verify']},stageKind:'git-worktree'}:
    {...common,expectedActionRevision:latestTaskEntity(d.ledger(),actionId).revision,...(phase==='discharge'?{grantRef:'grant:i'}:{})};
}

// Fixture owner explicitly reads fresh public pins for each bounded cycle.
// This helper does not retry faults; it only drives at most the three normal
// verification/stage/backup admissions in this supported test recipe.
async function fixtureCleanup(d,result,actionId,prefix='fixture-cleanup') {
  let out;
  for(let step=0;step<3;step++) {
    out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge',`${prefix}-${step}`,actionId),d.deps);
    assert.equal(out.ok,true,JSON.stringify(out));
    if(out.discharged===true)return out;
    if(out.state==='held'||out.gap)return out;
  }
  return out;
}

async function completeIntegration(d,result,stage=null) {
  const staged=stage??await runTaskIntegration(d.ctx,integrationRequest(d,result,'stage',`stage-${result.taskId}`),d.deps);
  assert.equal(staged.staged,true,JSON.stringify(staged));
  const actionId=staged.integrationActionId;
  for(const phase of ['check','land']) {
    const out=await runTaskIntegration(d.ctx,integrationRequest(d,result,phase,`${phase}-${result.taskId}`,actionId),d.deps);
    assert.equal(out.ok,true,JSON.stringify(out));
    if(phase==='check')assert.equal(out.blocked,false,JSON.stringify(out));
    if(phase==='land')assert.equal(out.landed,true,JSON.stringify(out));
    if(phase==='discharge')assert.equal(out.discharged,true,JSON.stringify(out));
  }
  const cleaned=await fixtureCleanup(d,result,actionId,`cleanup-${result.taskId}`);
  assert.equal(cleaned.discharged,true,JSON.stringify(cleaned));
  return actionId;
}

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

function scopeFor(path) {
  const scope=taskSpec().scope;
  return {...scope,ownership:{...scope.ownership,paths:[path]}};
}

async function assertRecoveryTargetFenced(d,suffix,target=d.w.repo) {
  const taskId=`other-${suffix}`;await d.define(taskId,{scope:scopeFor(`${taskId}.txt`)});
  const other=await runTaskDispatch(d.ctx,d.bootInput(taskId,{placement:{kind:'isolated',baseRef:d.w.head},effectBudget:8}),d.deps);
  assert.equal(other.state,'bound',JSON.stringify(other));
  assert.equal((await runTaskDispatch(d.ctx,d.sendInput(other.attemptId,`send-${suffix}`),d.deps)).sent,true);
  const result=await observeAndRuleTask(d,taskId,other.attemptId,`${taskId}.txt`,'other result\n');
  const input=integrationRequest(d,result,'stage',`held-target-${suffix}`);input.grant.target.cwd=target;
  const fenced=await runTaskIntegration(d.ctx,input,d.deps);
  assert.equal(fenced.ok,false,JSON.stringify(fenced));assert.equal(fenced.code,'SCOPE_CONFLICT','uncertain target still serializes other integrations');
}

// Corrective regressions: real Core admissions/history and temp Git effects.
async function correctionStaged(t) {
  const d=await realDesk(t);await d.define();
  const boot=await runTaskDispatch(d.ctx,d.bootInput('task-1',{placement:{kind:'isolated',baseRef:d.w.head}}),d.deps);
  assert.equal(boot.state,'bound',JSON.stringify(boot));
  assert.equal((await runTaskDispatch(d.ctx,d.sendInput(boot.attemptId),d.deps)).sent,true);
  writeFileSync(join(latestTaskEntity(d.ledger(),boot.attemptId).placement.cwd,'added.txt'),'added result\n');
  const result=await observeAndRuleTask(d,'task-1',boot.attemptId,'changed.txt','verified result\n');
  const stage=await runTaskIntegration(d.ctx,integrationRequest(d,result,'stage','correction-stage'),d.deps);
  assert.equal(stage.staged,true,JSON.stringify(stage));
  const checked=await runTaskIntegration(d.ctx,integrationRequest(d,result,'check','correction-check',stage.integrationActionId),d.deps);
  assert.equal(checked.blocked,false,JSON.stringify(checked));
  return {d,result,actionId:stage.integrationActionId};
}
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

async function c2Staged(t) {
  const d=await realDesk(t);await d.define();
  const boot=await runTaskDispatch(d.ctx,d.bootInput('task-1',{placement:{kind:'isolated',baseRef:d.w.head}}),d.deps);
  assert.equal(boot.state,'bound',JSON.stringify(boot));
  assert.equal((await runTaskDispatch(d.ctx,d.sendInput(boot.attemptId),d.deps)).sent,true);
  writeFileSync(join(latestTaskEntity(d.ledger(),boot.attemptId).placement.cwd,'script.sh'),'#!/bin/sh\necho modified fixture\n');
  const result=await observeAndRuleTask(d,'task-1',boot.attemptId,'changed.txt','verified result\n');
  const stage=await runTaskIntegration(d.ctx,integrationRequest(d,result,'stage','correction-stage'),d.deps);
  assert.equal(stage.staged,true,JSON.stringify(stage));
  const checked=await runTaskIntegration(d.ctx,integrationRequest(d,result,'check','correction-check',stage.integrationActionId),d.deps);
  assert.equal(checked.blocked,false,JSON.stringify(checked));
  return {d,result,actionId:stage.integrationActionId};
}
// Diagnosis only. Desired assertion expects supported explicit recovery;
// characterization alone is never treated as a regression pass.
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

async function c2LandResolved(t,{lost=false}={}) {
  const fixture=await c2Staged(t),{d,result,actionId}=fixture,effect=d.deps.task.runTaskEffect;
  if(lost)d.deps.task={...d.deps.task,runTaskEffect:async(ctx,input,deps)=>input.operation==='observe'&&input.receipt?.phase==='land'
    ?{ok:false,code:'CAPABILITY_GAP',message:'fixture lost LAND receipt',recovery:'explicit reconcile'}:effect(ctx,input,deps)};
  const land=await runTaskIntegration(d.ctx,integrationRequest(d,result,'land','c2-land',actionId),d.deps);
  assert.equal(lost?land.ok===false:land.landed===true,true,JSON.stringify(land));
  d.deps.task={...d.deps.task,runTaskEffect:effect};
  const originalTarget=latestTaskEntity(d.ledger(),actionId).target;
  const resolved=await runTaskIntegration(d.ctx,integrationRequest(d,result,'reconcile','c2-land-resolution',actionId),d.deps);
  assert.equal(resolved.recoveryClassification,'full-applied',JSON.stringify(resolved));
  assert.deepEqual(latestTaskEntity(d.ledger(),actionId).target,originalTarget);
  return fixture;
}
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

async function withoutBootstrapIo(d,run) {
  const original={host:d.deps.host,resolveSeat:d.deps.resolveSeat,fs:d.deps.fs,git:d.deps.git,measure:d.deps.measure};
  const crypto=createRequire(import.meta.url)('node:crypto'),randomBytes=crypto.randomBytes;
  d.deps.host=()=>assert.fail('bootstrap replay must not access SDK');
  d.deps.resolveSeat=async()=>assert.fail('bootstrap replay must not resolve runtime/catalog');
  d.deps.fs=new Proxy(original.fs,{get:()=>()=>assert.fail('bootstrap replay must not inspect filesystem')});
  d.deps.git=new Proxy(original.git,{get:()=>()=>assert.fail('bootstrap replay must not inspect Git')});
  d.deps.measure=async()=>assert.fail('bootstrap replay must not measure');
  crypto.randomBytes=()=>assert.fail('bootstrap replay must not generate entropy');syncBuiltinESMExports();
  try{return await run();}finally{Object.assign(d.deps,original);crypto.randomBytes=randomBytes;syncBuiltinESMExports();}
}

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

async function pointerCleanupCut(t,{relativePointer=false}={}) {
  const fixture=await c2LandResolved(t),{d,result,actionId}=fixture;
  const plan=latestTaskEntity(d.ledger(),actionId).recoveryPlan,pointer=join(plan.stageDir,'.git');
  if(relativePointer){
    const gitDir=await d.deps.git.absoluteGitDir(plan.stageDir);
    const {relative}=await import('node:path');writeFileSync(pointer,`gitdir: ${relative(plan.stageDir,gitDir)}\n`);
  }
  const original=readFileSync(pointer),mode=lstatSync(pointer).mode&0o777;
  assert.equal((await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','pointer-account',actionId),d.deps)).discharged,false);
  const fs=d.deps.fs,gitIo=d.deps.git;
  d.deps.git={...gitIo,worktreeRemove:async()=>{fs.rmrf(pointer);throw new Error('fixture issued pointer loss');}};
  const cut=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge','pointer-first',actionId),d.deps);
  assert.equal(cut.state,'held',JSON.stringify(cut));assert.equal(existsSync(pointer),false);
  d.deps.git=gitIo;
  return {...fixture,plan,pointer,original,mode,fs,gitIo};
}

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
