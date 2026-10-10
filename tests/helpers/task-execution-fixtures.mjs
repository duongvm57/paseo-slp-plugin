// tests/helpers/task-execution-fixtures.mjs — shared fixtures and helpers for
// the plugin-desk-task-execution test parts, extracted verbatim from the
// original single-file suite (plugin-desk-task-execution.test.mjs at
// 814c2410196ee0c05c54005749fa476b67e8f0d1) so the parts can run in separate
// processes/CI shards. All SDK effects are fixtures; no live daemon operation
// is exercised. Plugin-relative URLs are resolved from THIS module's
// location (one directory deeper than the parts).

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
} from '../../plugin/server/desk-task-execution-git.ts';
import {
  boundedArgv, createContentMapMeasure, createDirectMeasure,
  createTaskFsIo, createTaskGitIo, effectIdentity, sha256Hex, measureMapSha256,
} from '../../plugin/server/desk-task-execution-host.ts';
import {
  createTaskHostEventObserver, createTaskObserver,
  runTaskDispatch, runTaskIntegration, runTaskReconciliation, subRequestId,
} from '../../plugin/server/desk-task-execution.ts';
import {
  latestTask, latestTaskEntity, runTaskCommand, runTaskEffect,
} from '../../plugin/server/desk-task.ts';
import { observeDeskStore } from './desk-bridge-fixture.mjs';
import { createDeskStore, repoKeyFor } from '../../plugin/server/desk-store.ts';
import { createDeskSeat, DESK_TASK_CREATE_TICKET_KEY } from '../../plugin/server/desk-seat.ts';
import { createRoleInjection } from '../../plugin/server/role-injection.ts';
import { fileURLToPath } from 'node:url';
import { runAssignmentRegister, runHandbackSubmit } from '../../plugin/server/desk-handback.ts';
import { runScopeDeclare, runScopeTransition } from '../../plugin/server/desk-scope.ts';
import { snapshot } from '../../plugin/server/runtime/cli/package.ts';


export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example',
};
export const git = (repo, args) =>
  execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();

export function world(t, dir = mkdtempSync(join(tmpdir(), 'slp-taskexec-'))) {
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
export function mechanicalDispatch(ctx, input, deps) {
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
export function mechanicalIntegration(ctx, input, deps) {
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

export function evolveSource(dir) {
  writeFileSync(join(dir, 'changed.txt'), 'after\n');
  writeFileSync(join(dir, 'added.txt'), 'new\n');
  rmSync(join(dir, 'deleted.txt'));
  chmodSync(join(dir, 'script.sh'), 0o644);
  rmSync(join(dir, 'link.txt'));
  symlinkSync('changed.txt', join(dir, 'link.txt'));
}

export const REPO_KEY = 'repo-test';
export const NOW = '2026-01-01T00:00:00.000Z';
export const uuid = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

export function fixtureCtx(overrides = {}) {
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
export function coreDouble(ledger) {
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

export function fixtureDeps(w, ledger, host, task, overrides = {}) {
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

export function fixtureLedger(w, extra = {}) {
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
export function fixtureNativeCreateRequest(options, placement) {
  const {config: agentConfig,cwd,parent,title,prompt,...requestOptions}=options;
  const {provider: selection,options: providerOptions,...runtimeConfig}=agentConfig;
  const separator=selection.indexOf('/');
  if(separator<=0||separator===selection.length-1)throw new Error('Expected config.provider in "provider/model" format');
  return {...requestOptions,config:{...runtimeConfig,provider:selection.slice(0,separator),model:selection.slice(separator+1),
    cwd:placement?.cwd??cwd,...(title!==undefined?{title}:{}),...(providerOptions!==undefined?{providerOptions}:{})},
    ...(placement?{workspaceId:placement.workspaceId}:{}),...(parent?{callerAgentId:typeof parent==='string'?parent:parent.id}:{}),
    ...(prompt!==undefined?{initialPrompt:prompt}:{})};
}

export function fixtureHost({ agentId = 'agent-new', drift = {}, multi = false } = {}) {
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

export const dispatchBase = () => ({
  expectedLedgerRevision: 0, expectedBriefRevision: 0, expectedOwnershipRevision: 0,
  expectedTaskRevision: 1, expectedAttemptRevision: 0,
  attemptId: null, grantRef: 'grant:x',
});

export const bootstrapInput = (overrides = {}) => ({
  phase: 'bootstrap', requestId: 'req-boot-1', assignmentId: 'asg-1', taskId: 'task-1',
  grantRef: 'grant:create',
  placement: { kind: 'shared-checkout', cwd: null /* filled by caller */, baseRef: 'HEAD' },
  runtime: { optionId: 'opt-seat', catalogSha256: 'c'.repeat(64) },
  title: 'task seat',
  ...dispatchBase(), grantRef:'grant:create', ...overrides,
});

export const reuseFixture = (w, drift = {}) => fixtureHost({
  drift: {
    cwd: realpathSync(w.repo), status: 'idle', activeTurn: null,
    archivedAt: null, provider: 'slp-codex-peer', model: 'm1',
    labels: { 'paseo.parent-agent-id': 'agent-owner' },
    ...(drift.cwd === 'OUTSIDE'
      ? { ...drift, cwd: mkdirSync(join(w.dir, 'outside'), { recursive: true }) && realpathSync(join(w.dir, 'outside')) }
      : drift),
  },
});

export const reuseInput = (overrides = {}) => ({
  phase: 'reuse', requestId: 'req-reuse-1', assignmentId: 'asg-1', taskId: 'task-1',
  grantRef: 'grant:reuse',
  runtime: { optionId: 'opt-seat', catalogSha256: 'c'.repeat(64) },
  reuseTarget: { agentId: 'agent-new' },
  ...dispatchBase(), grantRef:'grant:create', ...overrides,
});

export async function stageFixture(t, attemptId, recipeIds) {
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

export function taskWithInjectedEffect(core, inject) {
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

export const REAL_REPO = w => ({ hostId: 'local', gitCommonDir: realpathSync(join(w.repo, '.git')) });

export const realMember = (agentId, createCwd, role, over = {}) => ({
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

export async function realDesk(t, options = {}) {
  const w = world(t);
  const repo = REAL_REPO(w);
  const repoKey = repoKeyFor(repo);
  const stableRoot = join(w.scratch, 'desk-store');
  const store = observeDeskStore(stableRoot, createDeskStore({ stableRoot }));
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
  writeFileSync(join(runtimeFixture,modulePath),readFileSync(fileURLToPath(new URL('../../plugin/server/runtime/cli/role-bundle.ts',import.meta.url))),{mode:0o600});
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

export function taskSpec(over={}) {
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

export async function realLifecycle(t, {nonDefaultUmask=false,cleanupFailure=false,finalMismatch=false,artifactDependency=false}={}) {
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

export async function observeAndRuleTask(d,taskId,attemptId,changedPath,contents) {
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

export function integrationRequest(d,result,phase,requestId,actionId=null) {
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
export async function fixtureCleanup(d,result,actionId,prefix='fixture-cleanup') {
  let out;
  for(let step=0;step<3;step++) {
    out=await runTaskIntegration(d.ctx,integrationRequest(d,result,'discharge',`${prefix}-${step}`,actionId),d.deps);
    assert.equal(out.ok,true,JSON.stringify(out));
    if(out.discharged===true)return out;
    if(out.state==='held'||out.gap)return out;
  }
  return out;
}

export async function completeIntegration(d,result,stage=null) {
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

export function scopeFor(path) {
  const scope=taskSpec().scope;
  return {...scope,ownership:{...scope.ownership,paths:[path]}};
}

export async function assertRecoveryTargetFenced(d,suffix,target=d.w.repo) {
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
export async function correctionStaged(t) {
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
export async function c2Staged(t) {
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
export async function c2LandResolved(t,{lost=false}={}) {
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
export async function withoutBootstrapIo(d,run) {
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

export async function pointerCleanupCut(t,{relativePointer=false}={}) {
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

