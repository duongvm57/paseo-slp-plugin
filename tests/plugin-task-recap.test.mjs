import test from 'node:test';
import assert from 'node:assert/strict';
import { DeskTaskRecapResult, DeskWorkflowProjection } from '../plugin/shared/enforcement.ts';
import { buildTaskRecap } from '../plugin/server/runtime/handoff-recap.ts';

const OWNER_MEMBER = '00000000-0000-4000-8000-000000000001';
const ACTOR_MEMBER = '00000000-0000-4000-8000-000000000002';
const sha = value => value.repeat(64).slice(0, 64);

const queueCounts = (over = {}) => ({
  backlog: 0, ready: 0, held: 0, running: 0, integrating: 0, settled: 0, superseded: 0,
  openHolds: 0, pendingAcks: 0, resources: 0, controls: 0, ...over,
});

const stamp = ({ entryId = 'entry-1', entityId = 'task-1', taskId = 'task-1',
  revision = 1, ...over } = {}) => ({
  entryId, entityId, taskId, assignmentId: 'as-1', revision,
  priorEntryId: null, priorEntrySha256: null, entrySha256: sha('a'), requestId: 'req-1',
  actorAgentId: 'worker-1', actorMembershipId: ACTOR_MEMBER,
  ownershipRevision: 0, briefRevision: 1, ...over,
});

function taskRow(options = {}) {
  const { state = 'open', ...identity } = options;
  return {
    ...stamp(identity),
    kind: 'task', state, outcome: 'Ship the bounded change', objective: null,
    authorityRef: 'human:bounded-test', dependencies: [], scope: null, proofPolicy: null,
    grants: { create: null, send: null, archive: null, integrate: null, commit: null },
    budgets: { maxAttempts: null, maxActionsPerAttempt: null }, reason: null,
  };
}

function holdRow({ entryId, holdId = 'hold-a', revision = 1, outcome = 'retain',
  priorEntryId = null, priorEntrySha256 = null } = {}) {
  return {
    ...stamp({ entryId, entityId: holdId, taskId: 'task-a', revision,
      priorEntryId, priorEntrySha256, entrySha256: revision === 1 ? sha('c') : sha('d'),
      requestId: `req-${entryId}` }),
    kind: 'hold', holdId, attemptId: null, holdKind: 'question',
    question: 'Wait for the owner ruling', proposition: null, claimRefs: [], resourceIds: [],
    state: 'ruled',
    ruling: {
      reason: `Hold ${outcome} ruling`, outcome, ownerAgentId: 'lead-1',
      ownerMembershipId: OWNER_MEMBER, briefRevision: 1,
    },
  };
}

const readiness = (over = {}) => ({
  bucket: 'held', reasons: ['question-open'], eligible: false,
  pins: { briefRevision: 1, taskRevision: 1 }, ...over,
});
const qualification = (over = {}) => ({
  qualified: false, scopeProof: null, reasons: ['result-unruled'], resultId: null, adjudicationId: null,
  pins: { resultRevision: 0, adjudicationRevision: 0, scopeId: null, scopeRevision: null }, ...over,
});

function item(row, over = {}) {
  return {
    kind: 'taskEntry', row, current: true,
    readiness: row.taskId === null ? null : readiness(),
    resultQualification: row.taskId === null ? null : qualification(),
    currentRuling: null,
    summary: {
      entryId: row.entryId, taskId: row.taskId, kind: row.kind,
      state: row.state ?? row.disposition ?? row.verdict ?? 'recorded',
      summary: row.kind === 'task' ? row.outcome : null,
      entrySha256: row.entrySha256, ordinal: row.revision,
    },
    ...over,
  };
}

function taskView(items, over = {}) {
  const assignmentId = 'as-1';
  const ledgerRevision = 9;
  const total = over.total ?? items.length;
  const omittedBefore = over.omittedBefore ?? 0;
  const omittedAfter = over.omittedAfter ?? 0;
  const nextOffset = omittedBefore + items.length;
  return DeskWorkflowProjection.parse({
    ok: true, assignmentId, ledgerRevision, briefRevision: 1,
    ownership: {
      registeredOwnerAgentId: 'lead-1', registeredOwnerMembershipId: OWNER_MEMBER,
      ownerAgentId: 'lead-1', ownerMembershipId: OWNER_MEMBER, ownershipRevision: 0,
      ownerMembership: null, acceptedAcknowledgment: null,
    },
    currentBrief: null, legacyObjective: 'A bounded objective',
    taskCounts: over.taskCounts ?? queueCounts(),
    section: 'tasks', items, total, omittedBefore, omittedAfter,
    nextCursor: nextOffset < total
      ? { assignmentId, ledgerRevision, section: 'tasks', offset: nextOffset } : null,
    acceptance: 'not-established-by-this-view',
  });
}

test('task recap returns the exact pinned projection, full-ledger counts and typed resolver data', () => {
  const row = taskRow();
  const projection = taskView([
    item(row, {
      readiness: readiness({ pins: { briefRevision: 1, taskRevision: 1, dependencyRevisions: { 'dep-a': 3 } } }),
    }),
  ], {
    total: 5, omittedAfter: 4,
    taskCounts: queueCounts({ backlog: 2, ready: 3, held: 1, openHolds: 2, pendingAcks: 1, resources: 1 }),
  });

  const built = buildTaskRecap(projection);
  assert.strictEqual(built.view, projection);
  assert.strictEqual(built.counts, projection.taskCounts);
  const recap = DeskTaskRecapResult.parse(built);

  assert.equal(recap.ok, true);
  assert.equal(recap.contextStatus, 'partial');
  assert.deepEqual(recap.counts, {
    backlog: 2, ready: 3, held: 1, running: 0, integrating: 0, settled: 0, superseded: 0,
    openHolds: 2, pendingAcks: 1, resources: 1, controls: 0,
  });
  assert.deepEqual(recap.unresolved.tasks, ['entry-1']);
  assert.deepEqual(recap.view.items[0].readiness.pins.dependencyRevisions, { 'dep-a': 3 });
  assert.deepEqual(recap.view.items[0].resultQualification, qualification());
  assert.equal(recap.view.omittedAfter, 4);
  assert.ok(recap.gaps.includes('task-history-page-incomplete'));
  assert.equal(recap.acceptance, 'not-established-by-this-recap');
});

test('task recap preserves the shared current ruling and terminal scope proof verbatim', () => {
  const row = taskRow();
  const ruling = {
    ...stamp({ entryId: 'ruling-entry', entityId: 'adjudication-1', revision: 2 }),
    kind: 'adjudication', taskId: 'task-1', adjudicationId: 'adjudication-1',
    resultId: 'result-1', resultRevision: 1, resultEntrySha256: sha('b'),
    taskRevision: 1, attemptId: null, verdict: 'accepted', reason: 'Current pinned ruling',
    evidence: [], counterevidence: [], residualRisk: null, findings: [],
    proofPolicyDigest: null, dependencyPins: [],
  };
  const projection = taskView([item(row, {
    readiness: readiness({ bucket: 'ready', reasons: [], eligible: true }),
    resultQualification: qualification({
      qualified: true, scopeProof: 'terminal-approved-round', reasons: [], resultId: 'result-1', adjudicationId: 'adjudication-1',
      pins: { resultRevision: 1, adjudicationRevision: 1, scopeId: 'scope-1', scopeRevision: 2 },
    }),
    currentRuling: ruling,
  })]);
  const built = buildTaskRecap(projection);
  const recap = DeskTaskRecapResult.parse(built);

  assert.strictEqual(built.view, projection);
  assert.deepEqual(recap.view.items[0].currentRuling, ruling);
  assert.equal(recap.view.items[0].resultQualification.qualified, true);
  assert.equal(recap.view.items[0].resultQualification.scopeProof, 'terminal-approved-round');
  assert.deepEqual(recap.gaps, []);
  assert.equal(recap.contextStatus, 'complete');
});

test('task recap keeps a current retained hold unresolved until a later release row supersedes it', () => {
  const task = taskRow({ entryId: 'task-a', entityId: 'task-a', taskId: 'task-a' });
  const retained = holdRow({ entryId: 'hold-a-retained', outcome: 'retain' });
  const retainedProjection = taskView([
    item(task, { readiness: readiness({ reasons: ['question-open'] }) }),
    item(retained, { readiness: readiness({ reasons: ['question-open'] }) }),
  ], { taskCounts: queueCounts({ held: 1, openHolds: 1 }) });

  const whileRetained = buildTaskRecap(retainedProjection);
  assert.strictEqual(whileRetained.view, retainedProjection);
  assert.strictEqual(whileRetained.counts, retainedProjection.taskCounts);
  assert.deepEqual(whileRetained.unresolved.holds, ['hold-a-retained']);
  assert.equal(whileRetained.counts.openHolds, 1);
  DeskTaskRecapResult.parse(whileRetained);

  const released = holdRow({ entryId: 'hold-a-released', revision: 2, outcome: 'release',
    priorEntryId: retained.entryId, priorEntrySha256: retained.entrySha256 });
  const ready = readiness({ bucket: 'ready', reasons: [], eligible: true });
  const releasedProjection = taskView([
    item(task, { readiness: ready }),
    item(retained, { current: false, readiness: ready }),
    item(released, { readiness: ready }),
  ], { taskCounts: queueCounts({ ready: 1, openHolds: 0 }) });

  const afterRelease = buildTaskRecap(releasedProjection);
  assert.strictEqual(afterRelease.view, releasedProjection);
  assert.strictEqual(afterRelease.counts, releasedProjection.taskCounts);
  assert.equal(afterRelease.counts.openHolds, 0);
  assert.deepEqual(afterRelease.unresolved.holds, []);
  assert.deepEqual(afterRelease.view.items.map(entry => [entry.row.entryId, entry.current]), [
    ['task-a', true], ['hold-a-retained', false], ['hold-a-released', true],
  ]);
  assert.deepEqual(afterRelease.view.items[1].row, retained);
  assert.equal(afterRelease.view.total, 3);
  DeskTaskRecapResult.parse(afterRelease);
});

test('unresolved ids include only current entity rows while superseded history stays in view', () => {
  const entries = [
    item({ entryId: 'task-old', kind: 'task', state: 'open', taskId: 'task-a', entityId: 'task-a' }, { current: false }),
    item({ entryId: 'task-current', kind: 'task', state: 'withdrawn', taskId: 'task-a', entityId: 'task-a' }),
    item({ entryId: 'task-open', kind: 'task', state: 'reopened', taskId: 'task-b', entityId: 'task-b' }),
    item({ entryId: 'attempt-old', kind: 'attempt', state: 'running' }, { current: false }),
    item({ entryId: 'attempt-current', kind: 'attempt', state: 'settled' }),
    item({ entryId: 'attempt-open', kind: 'attempt', state: 'reconciliation-required' }),
    item({ entryId: 'hold-old', kind: 'hold', state: 'open' }, { current: false }),
    item({ entryId: 'hold-current', kind: 'hold', state: 'ruled' }),
    item({ entryId: 'hold-open', kind: 'hold', state: 'open' }),
    item({ entryId: 'resource-old', kind: 'resource', disposition: 'retained' }, { current: false }),
    item({ entryId: 'resource-current', kind: 'resource', disposition: 'released' }),
    item({ entryId: 'resource-open', kind: 'resource', disposition: 'transfer-pending' }),
    item({ entryId: 'delivery-old', kind: 'delivery', state: 'pending' }, { current: false }),
    item({ entryId: 'delivery-current', kind: 'delivery', state: 'handled' }),
    item({ entryId: 'delivery-open', kind: 'delivery', state: 'host-accepted' }),
    item({ entryId: 'effect-old', kind: 'action', actionKind: 'send', state: 'uncertain' }, { current: false }),
    item({ entryId: 'effect-current', kind: 'action', actionKind: 'send', state: 'observed' }),
    item({ entryId: 'effect-open', kind: 'action', actionKind: 'send', state: 'uncertain' }),
    item({ entryId: 'control-old', kind: 'control', state: 'stop-requested' }, { current: false }),
    item({ entryId: 'control-current', kind: 'control', state: 'resume-ruled' }),
    item({ entryId: 'control-open', kind: 'control', state: 'stop-requested' }),
  ];
  const projection = taskView([item(taskRow())]);
  projection.items = entries;

  const recap = buildTaskRecap(projection);
  assert.deepEqual(recap.unresolved, {
    tasks: ['task-open'],
    holds: ['hold-open'],
    resources: ['resource-open'],
    deliveries: ['delivery-open'],
    effects: ['effect-open'],
    attempts: ['attempt-open'],
    controls: ['control-open'],
  });
  assert.equal(recap.view.items.length, entries.length);
  assert.equal(recap.contextStatus, 'complete');
});

test('recap refuses a non-tasks projection or a tasks projection without full-ledger counts', () => {
  assert.throws(() => buildTaskRecap({ section: 'briefs' }), /tasks-section projection/);
  assert.throws(() => buildTaskRecap({ section: 'tasks' }), /full-ledger task counts/);
});
