import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindWorkspaceDesk, readWorkspaceWorkflow } from '../plugin/server/workflow-view.ts';
import { projectDeskWorkflow } from '../plugin/server/desk-assignment.ts';
import { createDeskStore, deskRepoPaths } from '../plugin/server/desk-store.ts';
import { runAssignmentRegister } from '../plugin/server/desk-handback.ts';
import { runTaskCommand } from '../plugin/server/desk-task.ts';
import { DeskTaskRecapResult } from '../plugin/shared/enforcement.ts';
import { buildTaskRecap } from '../plugin/server/runtime/handoff-recap.ts';
import { canonicalSha256 } from '../plugin/server/config-view.ts';
import { memberRow, seedMemberships } from './helpers/desk-bridge-fixture.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'slp-workflow-tasks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.json'), '{}\n');
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; });
  const repository = join(root, 'repo'); mkdirSync(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args]);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repository, 'file'), 'content\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  return { root, home, repository, git };
}

const workspace = (directory, over = {}) => ({ id: 'workspace-selected', workspaceDirectory: directory, ...over });
const host = value => ({ workspaces: { ref: () => ({ refresh: async () => value }) } });
const request = (over = {}) => ({ schemaVersion: 1, workspaceId: 'workspace-selected', assignmentId: null,
  assignmentCursor: null, limit: 20,
  page: { section: 'briefs', expectedLedgerRevision: null, expectedBriefRevision: null, cursor: null, limit: 20 }, ...over });
const taskPage = (over = {}) => ({ section: 'tasks', expectedLedgerRevision: null, expectedBriefRevision: null, cursor: null, limit: 20, ...over });

async function registered(t) {
  const f = fixture(t);
  const sdk = host(workspace(f.repository));
  const binding = await bindWorkspaceDesk('workspace-selected', sdk);
  assert.equal(binding.state, 'ok');
  const store = createDeskStore({ stableRoot: binding.home.stableRoot });
  const lead = memberRow('workflow-lead', { provider: 'slp-codex-lead', at: '2026-01-01T00:00:00.000Z' },
    { role: 'lead', agentId: 'workflow-lead', workspaceId: 'workspace-selected', createCwd: f.repository });
  await seedMemberships(store, binding.repo, [lead]);
  const result = await runAssignmentRegister({ repoKey: binding.repoKey, row: lead },
    { requestId: 'register-0', authorityRef: 'human:bounded-test', objective: 'A bounded assignment' }, { store });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { ...f, sdk, binding, store, lead, assignmentId: result.assignmentId,
    ledgerPath: deskRepoPaths(binding.home.stableRoot, binding.repoKey).ledgerPath };
}

test('the assignment list reports a supported empty task queue, not an unavailable one', async t => {
  const f = await registered(t);
  const list = await readWorkspaceWorkflow(request(), f.sdk);
  assert.equal(list.state, 'ready');
  assert.equal(list.assignments.length, 1);
  const counts = list.assignments[0].taskCounts;
  assert.notEqual(counts, null);
  for (const key of ['backlog', 'ready', 'held', 'running', 'integrating', 'settled', 'superseded',
    'openHolds', 'pendingAcks', 'resources', 'controls']) {
    assert.equal(counts[key], 0, `expected a supported empty count for ${key}`);
  }
});

// Seeds real DeskTaskEntry rows through the store's own transact — rows are
// schema-validated, self-hashed and bound to committed task-entry-appended
// events by the store's refinements on write. Nothing below fabricates a
// projection shape; it only commits ledger rows and reads the view.
const KIND_ID = { task: 'taskId', attempt: 'attemptId', result: 'resultId', adjudication: 'adjudicationId',
  hold: 'holdId', action: 'actionId', delivery: 'deliveryId', resource: 'resourceId', control: 'controlId' };
const taskEntry = (f, { entryId, entityId, taskId, kind, requestId, ...fields }) => {
  const row = {
    entryId, entityId, [KIND_ID[kind]]: entityId,
    taskId: taskId === undefined ? entityId : taskId,
    assignmentId: f.assignmentId, revision: 1,
    priorEntryId: null, priorEntrySha256: null,
    requestId, actorAgentId: f.lead.agentId, actorMembershipId: f.lead.membershipId,
    ownershipRevision: 0, briefRevision: 0, kind, ...fields,
  };
  return { ...row, entrySha256: canonicalSha256(row) };
};

async function seedTaskEntries(f, partials) {
  const requestId = `seed-${randomUUID().slice(0, 8)}`;
  const rows = partials.map(partial => taskEntry(f, { requestId, ...partial }));
  const result = await f.store.transact(f.binding.repoKey,
    { repo: f.binding.repo, actorKey: `agent:${f.lead.agentId}`, assignmentId: f.assignmentId,
      requestId, command: { kind: 'seed-task-entries' } },
    ledger => ({
      ok: true,
      events: rows.map(row => ({ kind: 'task-entry-appended', payload: {
        entryId: row.entryId, entityId: row.entityId, entryKind: row.kind,
        revision: row.revision, entrySha256: row.entrySha256, taskId: row.taskId,
        actorMembershipId: row.actorMembershipId,
        briefRevision: row.briefRevision, ownershipRevision: row.ownershipRevision } })),
      taskEntries: [...ledger.taskEntries, ...rows],
    }));
  assert.equal(result.ok, true, `seed commit failed: ${JSON.stringify(result)}`);
  return rows;
}

const COUNT_KEYS = ['backlog', 'ready', 'held', 'running', 'integrating', 'settled', 'superseded',
  'openHolds', 'pendingAcks', 'resources', 'controls'];

test('committed task entries project one-item-per-entry with real counts', async t => {
  const f = await registered(t);
  const rows = await seedTaskEntries(f, [
    { entryId: 'e-task', entityId: 'task-a', kind: 'task', state: 'open',
      outcome: 'Ship the bounded slice', objective: null, authorityRef: 'human:bounded-test',
      dependencies: [], scope: null, proofPolicy: null,
      grants: { create: null, send: null, archive: null, integrate: null, commit: null },
      budgets: { maxAttempts: null, maxActionsPerAttempt: null }, reason: null },
    { entryId: 'e-hold', entityId: 'hold-a', taskId: 'task-a', kind: 'hold', state: 'open',
      holdKind: 'manual', attemptId: null, question: 'Hold pending owner answer', proposition: null,
      claimRefs: [], resourceIds: [], ruling: null },
    { entryId: 'e-del', entityId: 'del-a', taskId: null, kind: 'delivery', state: 'pending',
      deliveryKind: 'handback', senderAgentId: f.lead.agentId, senderMembershipId: f.lead.membershipId,
      recipientAgentId: f.lead.agentId, recipientMembershipId: f.lead.membershipId,
      bodySha256: null, bodyRef: null, actionId: null, attemptId: null, resultId: null,
      ackEvidence: [], handlingEvidence: null, reason: null },
    { entryId: 'e-res', entityId: 'res-a', taskId: null, kind: 'resource', disposition: 'retained',
      resourceKind: 'scratch', resourceKey: 'scratch/task-a', ownerAgentId: f.lead.agentId,
      ownerMembershipId: f.lead.membershipId, attemptId: null, actionId: null,
      observedState: null, observedVia: null, obligations: [], releaseRuling: null },
    { entryId: 'e-ctl', entityId: 'ctl-a', taskId: null, kind: 'control', state: 'stop-requested',
      targetTaskId: 'task-a', targetAttemptId: null, reason: 'Stop requested for audit',
      outstandingActionIds: [], outstandingResourceIds: [] },
  ]);

  const detail = await readWorkspaceWorkflow(request({ assignmentId: f.assignmentId, page: taskPage() }), f.sdk);
  assert.equal(detail.state, 'ready');
  const view = detail.view;
  assert.equal(view.section, 'tasks');
  assert.equal(view.total, 5);
  assert.equal(view.items.length, 5);
  assert.deepEqual(view.items.map(item => item.kind), Array(5).fill('taskEntry'));
  assert.deepEqual(view.items.map(item => item.row.entryId).sort(),
    rows.map(row => row.entryId).sort());
  assert.ok(view.items.every(item => item.current), 'each seeded identity has exactly one current entity row');
  for (const item of view.items) {
    assert.equal(item.row.entrySha256.length, 64);
    assert.equal(typeof item.summary?.entryId, 'string');
    assert.equal(item.summary.entryId, item.row.entryId);
  }
  assert.equal(view.items.find(item => item.row.kind === 'delivery').readiness, null,
    'assignment-level delivery has no inferred task readiness');

  const list = await readWorkspaceWorkflow(request(), f.sdk);
  const counts = list.assignments[0].taskCounts;
  assert.notEqual(counts, null);
  for (const key of COUNT_KEYS) {
    assert.ok(Number.isInteger(counts[key]) && counts[key] >= 0, `expected an integer count for ${key}`);
  }
  assert.ok(COUNT_KEYS.slice(0, 7).reduce((sum, key) => sum + counts[key], 0) >= 1,
    'the seeded declaration is counted in some readiness bucket');
  assert.deepEqual(view.taskCounts, counts,
    'detail projection counts use the same full-ledger current identities as the assignment list');
  assert.equal(view.taskCounts.openHolds, 1);
  assert.equal(view.taskCounts.pendingAcks, 1, 'assignment-level pending delivery remains counted');
  assert.equal(view.taskCounts.resources, 1, 'assignment-level retained resource remains counted');
  assert.equal(view.taskCounts.controls, 1, 'assignment-level stop control remains counted');
  const recap = DeskTaskRecapResult.parse(buildTaskRecap(view));
  assert.deepEqual(recap.unresolved, {
    tasks: ['e-task'], holds: ['e-hold'], resources: ['e-res'], deliveries: ['e-del'],
    effects: [], attempts: [], controls: ['e-ctl'],
  });
});

test('runner-committed define and hold project with real readiness and counts', async t => {
  const f = await registered(t);
  const ctx = { repoKey: f.binding.repoKey, row: f.lead };
  const taskBody = {
    state: 'open', outcome: 'Runner-defined outcome', objective: null,
    authorityRef: 'human:bounded-test', dependencies: [], scope: null, proofPolicy: null,
    grants: { create: null, send: null, archive: null, integrate: null, commit: null },
    budgets: { maxAttempts: null, maxActionsPerAttempt: null }, reason: null,
  };
  const ledgerRevision = () => {
    const read = f.store.read(f.binding.repoKey);
    assert.equal(read.state, 'ok');
    return read.ledger.revision;
  };

  const defined = await runTaskCommand(ctx, {
    operation: 'define', requestId: 'define-1', assignmentId: f.assignmentId, taskId: null,
    expectedLedgerRevision: ledgerRevision(), expectedBriefRevision: 0,
    expectedOwnershipRevision: 0, expectedTaskRevision: 0, task: taskBody,
  }, { store: f.store });
  assert.equal(defined.ok, true, JSON.stringify(defined));
  assert.equal(typeof defined.taskId, 'string');

  let detail = await readWorkspaceWorkflow(request({ assignmentId: f.assignmentId, page: taskPage() }), f.sdk);
  assert.equal(detail.state, 'ready');
  assert.equal(detail.view.total, 1);
  const declaration = detail.view.items[0];
  assert.equal(declaration.row.kind, 'task');
  assert.equal(declaration.row.taskId, defined.taskId);
  assert.equal(declaration.current, true);
  assert.equal(declaration.readiness.bucket, 'ready');
  assert.equal(declaration.readiness.eligible, true);
  assert.equal(declaration.readiness.pins.taskRevision, 1);
  assert.deepEqual(declaration.resultQualification.reasons, ['result-unruled']);
  assert.equal(declaration.resultQualification.scopeProof, null);
  assert.equal(declaration.currentRuling, null);

  const holdInput = {
    operation: 'hold', requestId: 'hold-1', assignmentId: f.assignmentId, taskId: defined.taskId,
    attemptId: null, holdId: null,
    expectedLedgerRevision: ledgerRevision(), expectedBriefRevision: 0, expectedOwnershipRevision: 0,
    hold: { holdKind: 'question', question: 'Awaiting an owner answer', proposition: null,
      claimRefs: [], resourceIds: [] },
    ruling: null,
  };
  const held = await runTaskCommand(ctx, holdInput, { store: f.store });
  assert.equal(held.ok, true, JSON.stringify(held));

  detail = await readWorkspaceWorkflow(request({ assignmentId: f.assignmentId, page: taskPage() }), f.sdk);
  assert.equal(detail.view.total, 2);
  assert.deepEqual(detail.view.taskCounts, { ...COUNT_KEYS.reduce((counts, key) => ({ ...counts, [key]: 0 }), {}),
    held: 1, openHolds: 1 });
  const reopened = detail.view.items.find(item => item.row.kind === 'task');
  assert.equal(reopened.current, true);
  assert.equal(reopened.readiness.bucket, 'held');
  assert.equal(reopened.readiness.eligible, false);
  assert.ok(reopened.readiness.reasons.includes('question-open'));
  assert.equal(reopened.resultQualification.qualified, false);
  assert.deepEqual(reopened.resultQualification.pins, {
    resultRevision: 0, adjudicationRevision: 0, scopeId: null, scopeRevision: null,
  });
  assert.equal(reopened.resultQualification.scopeProof, null);
  assert.equal(reopened.currentRuling, null);
  const hold = detail.view.items.find(item => item.row.kind === 'hold');
  assert.equal(hold.current, true);
  assert.equal(hold.row.state, 'open');
  assert.equal(hold.readiness.bucket, 'held');

  // The recap is only a wrapper over this exact shared projection. It keeps
  // resolver values, current identity and full-ledger counts from the same
  // runner-seeded read, while the shared result schema validates the output.
  const recap = DeskTaskRecapResult.parse(buildTaskRecap(detail.view));
  assert.deepEqual(recap.counts, detail.view.taskCounts);
  assert.deepEqual(recap.view.items, detail.view.items);
  assert.deepEqual(recap.unresolved.tasks, [reopened.row.entryId]);
  assert.deepEqual(recap.unresolved.holds, [hold.row.entryId]);
  assert.equal(recap.contextStatus, 'complete');

  const list = await readWorkspaceWorkflow(request(), f.sdk);
  assert.equal(list.assignments[0].taskCounts.held, 1);
  assert.equal(list.assignments[0].taskCounts.openHolds, 1);

  // The identical request replays its receipt instead of doubling the
  // ledger — replay is proof of the original commit, never permission to
  // reissue.
  const replay = await runTaskCommand(ctx, holdInput, { store: f.store });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  const afterReplay = await readWorkspaceWorkflow(request({ assignmentId: f.assignmentId, page: taskPage() }), f.sdk);
  assert.equal(afterReplay.view.total, 2, 'replay must not append a second hold');
});

test('task pages continue by cursor without repeating or dropping entries', async t => {
  const f = await registered(t);
  await seedTaskEntries(f, [1, 2, 3].map(n => ({
    entryId: `e-${n}`, entityId: `task-${n}`, kind: 'task', state: 'open',
    outcome: `Outcome ${n}`, objective: null, authorityRef: 'human:bounded-test',
    dependencies: [], scope: null, proofPolicy: null,
    grants: { create: null, send: null, archive: null, integrate: null, commit: null },
    budgets: { maxAttempts: null, maxActionsPerAttempt: null }, reason: null,
  })));

  const first = await readWorkspaceWorkflow(
    request({ assignmentId: f.assignmentId, page: taskPage({ limit: 2 }) }), f.sdk);
  assert.equal(first.view.items.length, 2);
  assert.equal(first.view.omittedAfter, 1);
  assert.ok(first.view.nextCursor, 'expected a continuation cursor');
  const second = await readWorkspaceWorkflow(
    request({ assignmentId: f.assignmentId,
      page: taskPage({ limit: 2, cursor: first.view.nextCursor,
        expectedLedgerRevision: first.view.ledgerRevision }) }), f.sdk);
  assert.equal(second.view.items.length, 1);
  assert.equal(second.view.omittedBefore, 2);
  const seen = new Set([...first.view.items, ...second.view.items].map(item => item.row.entryId));
  assert.equal(seen.size, 3);
});

test('task view refuses a stale ledger revision pin', async t => {
  const f = await registered(t);
  await seedTaskEntries(f, [{ entryId: 'e-1', entityId: 'task-1', kind: 'task', state: 'open',
    outcome: 'Outcome', objective: null, authorityRef: 'human:bounded-test',
    dependencies: [], scope: null, proofPolicy: null,
    grants: { create: null, send: null, archive: null, integrate: null, commit: null },
    budgets: { maxAttempts: null, maxActionsPerAttempt: null }, reason: null }]);
  const detail = await readWorkspaceWorkflow(request({ assignmentId: f.assignmentId, page: taskPage() }), f.sdk);
  const stale = await readWorkspaceWorkflow(
    request({ assignmentId: f.assignmentId,
      page: taskPage({ expectedLedgerRevision: detail.view.ledgerRevision - 1 }) }), f.sdk);
  assert.equal(stale.state, 'conflict');
  assert.equal(stale.problem.code, 'REVISION_CONFLICT');
});

test('a ledger that cannot be read stays unavailable rather than masquerading as empty', async t => {
  const f = fixture(t);
  const sdk = host(workspace(f.repository));
  assert.equal((await readWorkspaceWorkflow(request(), sdk)).state, 'absent');
  const unreadable = await readWorkspaceWorkflow(request(), sdk,
    { deskStore: () => ({ read: () => ({ state: 'future', diagnostics: { code: 'future-version', schemaVersion: 999 } }) }) });
  assert.equal(unreadable.state, 'unavailable');
  assert.equal(unreadable.problem.code, 'STATE_UNREADABLE');
  assert.deepEqual(unreadable.assignments, []);
});

test('the tasks section pages an empty supported queue with pins and no invented rows', async t => {
  const f = await registered(t);
  const before = readFileSync(f.ledgerPath);
  const detail = await readWorkspaceWorkflow(request({ assignmentId: f.assignmentId, page: taskPage() }), f.sdk);
  assert.equal(detail.state, 'ready');
  const view = detail.view;
  assert.equal(view.section, 'tasks');
  assert.deepEqual(view.items, []);
  assert.equal(view.total, 0);
  assert.equal(view.omittedBefore, 0);
  assert.equal(view.omittedAfter, 0);
  assert.equal(view.nextCursor, null);
  assert.equal(view.assignmentId, f.assignmentId);
  assert.equal(view.ledgerRevision, detail.ledgerRevision);
  assert.equal(view.ownership.ownerAgentId, 'workflow-lead');
  assert.equal(view.ownership.ownershipRevision, 0);
  assert.equal(view.acceptance, 'not-established-by-this-view');
  assert.deepEqual(readFileSync(f.ledgerPath), before);
});

test('task section cursors pin assignment, section and ledger revision like every other section', async t => {
  const f = await registered(t);
  const stale = await readWorkspaceWorkflow(request({ assignmentId: f.assignmentId, page: taskPage() }), f.sdk);
  assert.equal(stale.state, 'ready');
  const changed = await runAssignmentRegister({ repoKey: f.binding.repoKey, row: f.lead },
    { requestId: 'register-1', authorityRef: 'human:bounded-test', objective: 'A second assignment' }, { store: f.store });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  const foreign = await readWorkspaceWorkflow(request({ assignmentId: f.assignmentId,
    page: taskPage({ expectedLedgerRevision: stale.ledgerRevision,
      cursor: { assignmentId: f.assignmentId, ledgerRevision: stale.ledgerRevision, section: 'tasks', offset: 0 } }) }), f.sdk);
  assert.equal(foreign.state, 'conflict');
  // The strict page envelope rejects a cursor that keeps another section or a
  // mismatched ledger pin before the projector ever sees it.
  await assert.rejects(readWorkspaceWorkflow(request({ assignmentId: f.assignmentId,
    page: taskPage({ expectedLedgerRevision: foreign.ledgerRevision,
      cursor: { assignmentId: f.assignmentId, ledgerRevision: foreign.ledgerRevision, section: 'briefs', offset: 0 } }) }), f.sdk),
    error => error.code === 'INVALID_REQUEST');
});

test('a tasks projection under the shared projector matches the RPC detail read', async t => {
  const f = await registered(t);
  const read = f.store.read(f.binding.repoKey);
  assert.equal(read.state, 'ok');
  const view = projectDeskWorkflow(read.ledger, f.assignmentId, taskPage({ limit: 50 }));
  assert.equal(view.ok, true);
  assert.equal(view.section, 'tasks');
  assert.deepEqual(view.items, []);
  const detail = await readWorkspaceWorkflow(request({ assignmentId: f.assignmentId, page: taskPage({ limit: 50 }) }), f.sdk);
  assert.deepEqual(detail.view.items, view.items);
  assert.equal(detail.view.total, view.total);
});
