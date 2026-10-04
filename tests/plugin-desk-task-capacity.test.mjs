import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { resolveDeskTaskCapacityReserve } from '../plugin/server/desk-task-capacity.ts';
import { WIRE_LIMITS } from '../plugin/shared/enforcement.ts';
import { createDeskStore, deskRepoPaths, LEDGER_LIMITS } from '../plugin/server/desk-store.ts';
import { runAssignmentRegister } from '../plugin/server/desk-handback.ts';
import { runTaskCommand, runTaskEffect } from '../plugin/server/desk-task.ts';
import { memberRow, seedMemberships } from './helpers/desk-bridge-fixture.mjs';

const empty = () => ({ taskEntries: [], memberships: [], assignments: [], scopes: [], scopeTransitions: [] });

const reserve = entries => resolveDeskTaskCapacityReserve({ ...empty(), taskEntries: entries }, { eventPayloadBytes: 16_384 });
const attempt = (extra = {}) => ({ kind: 'attempt', entityId: 'attempt-1', attemptId: 'attempt-1',
  assignmentId: 'assignment-1', taskId: 'task-1', revision: 1, taskRevision: 1, state: 'reserved',
  member: null, placement: { kind: 'shared-checkout', cwd: '/repo' }, host: { agentId: null },
  reuseTarget: { agentId: 'worker' }, stop: { requested: false }, ...extra });
const effectAction = (actionKind, state = 'issued', revision = 1) => ({ kind: 'action', entityId: 'effect-1',
  actionId: 'effect-1', attemptId: 'attempt-1', assignmentId: 'assignment-1', taskId: 'task-1',
  actionKind, state, revision, body: { messageId: 'message-1' } });

for (const kind of ['place', 'create', 'send', 'archive']) {
  test(`${kind} reserves its coupled receipt separately from bind and terminal obligations`, () => {
    const a = attempt({ member: { agentId: 'worker' }, state: kind === 'send' ? 'dispatched' : 'bound' });
    const delivery = { kind: 'delivery', entityId: 'delivery-1', revision: 1, taskId: 'task-1',
      attemptId: 'attempt-1', actionId: 'effect-1', state: 'pending' };
    const base = [a, ...(kind === 'send' ? [delivery] : [])];
    const baseline = reserve(base);
    const receiptRows = kind === 'send' ? 3 : 2;
    for (const state of ['intended', 'issued', 'uncertain', 'held']) {
      const actual = reserve([...base, effectAction(kind, state)]);
      assert.equal(actual.requests - baseline.requests, state === 'intended' ? 2 : 1);
      assert.equal(actual.taskEntries - baseline.taskEntries, receiptRows + (state === 'intended' ? 1 : 0));
      assert.equal(actual.futureEvents - baseline.futureEvents, receiptRows + (state === 'intended' ? 1 : 0));
      assert.equal(actual.memberships, baseline.memberships);
      assert.equal(actual.scopes, baseline.scopes);
      assert.equal(actual.scopeTransitions, baseline.scopeTransitions);
      assert.deepEqual(actual.assignmentSeats, baseline.assignmentSeats);
    }
    const before = reserve([...base, effectAction(kind, 'intended')]);
    const issued = reserve([...base, effectAction(kind, 'intended'), effectAction(kind, 'issued', 2)]);
    assert.equal(before.requests - issued.requests, 1);
    assert.equal(before.taskEntries - issued.taskEntries, 1, 'issue consumes only the issue row');
    for (const state of ['observed', 'failed', 'abandoned']) {
      const done = reserve([...base, effectAction(kind, 'intended'), effectAction(kind, 'issued', 2), effectAction(kind, state, 3)]);
      assert.equal(issued.requests - done.requests, 1);
      assert.equal(issued.taskEntries - done.taskEntries, receiptRows);
    }
  });
}

test('isolated worktree birth and release stay funded without a materialized cwd and across stop', () => {
  const place = effectAction('place');
  const shared = attempt();
  const isolated = attempt({ placement: { kind: 'isolated', cwd: null } });
  const extra = (a, b) => ({ requests: a.requests - b.requests, entries: a.taskEntries - b.taskEntries });
  assert.deepEqual(extra(reserve([isolated, place]), reserve([shared, place])), { requests: 1, entries: 2 });
  const stopped = { ...isolated, state: 'stop-requested', stop: { requested: true }, revision: 2 };
  const sharedStopped = { ...stopped, placement: shared.placement };
  assert.deepEqual(extra(reserve([isolated, stopped, place]), reserve([shared, sharedStopped, place])), { requests: 1, entries: 2 });
  const worktree = { kind: 'resource', entityId: 'worktree-1', resourceId: 'worktree-1', revision: 1,
    attemptId: 'attempt-1', resourceKind: 'worktree', disposition: 'retained' };
  const born = reserve([isolated, stopped, place, worktree]);
  const missing = reserve([isolated, stopped, place]);
  assert.equal(missing.requests - born.requests, 0, 'birth leaves its release request reserved');
  assert.equal(missing.taskEntries - born.taskEntries, 1, 'birth consumes exactly one row');
  const released = reserve([isolated, stopped, place, worktree, { ...worktree, disposition: 'released', revision: 2 }]);
  assert.equal(born.requests - released.requests, 1);
  assert.equal(born.taskEntries - released.taskEntries, 1);
});

test('receipt cost uses current attempt and delivery heads rather than historical pending rows', () => {
  const a = attempt({ state: 'dispatched', member: { agentId: 'worker' } });
  const send = effectAction('send');
  const pending = { kind: 'delivery', entityId: 'delivery-1', revision: 1, taskId: 'task-1', actionId: 'effect-1', state: 'pending' };
  const accepted = { ...pending, revision: 2, state: 'host-accepted' };
  const before = reserve([a, pending, send]);
  const after = reserve([a, pending, accepted, send]);
  assert.equal(before.taskEntries - after.taskEntries, 1, 'host-accepted consumes only the receipt delivery edge, not acknowledgment');
  assert.equal(before.requests, after.requests);
  const terminal = { ...a, revision: 2, state: 'stopped' };
  const noAttemptChange = reserve([a, terminal, pending, accepted, send]);
  assert.equal(noAttemptChange.taskEntries - reserve([a, terminal, pending, accepted]).taskEntries, 1);
});

function action(revision, state, receipt = null) {
  return {
    kind: 'action', entityId: 'action-1', entryId: `entry-${revision}`, entrySha256: String(revision).repeat(64).slice(0, 64),
    actionId: 'action-1', actionKind: 'integration', assignmentId: 'assignment-1', taskId: 'task-1', attemptId: null,
    resultId: 'result-1', ordinal: 1, revision, phase: 'discharge', state,
    body: { phase: 'discharge', cleanupStep: 'verify-account', cleanupCandidate: {
      version: 1, basis: 'stage-only', actionId: 'action-1', recoveryPlanSha256: null,
      resources: [
        { role: 'stage', resourceId: 'resource-1', resourceKey: '/stage', disposition: 'released' },
        { role: 'backup', resourceId: 'resource-2', resourceKey: '/backup', disposition: 'released' },
      ],
    } },
    receipt, recoveryPlan: null, cleanupVerification: null, stageDir: '/stage', backupDir: null,
  };
}

function verificationState(rows) {
  const resources = [
    { kind: 'resource', entityId: 'resource-1', resourceId: 'resource-1', actionId: 'action-1', attemptId: null,
      assignmentId: 'assignment-1', taskId: null, resourceKind: 'directory', resourceKey: '/stage', disposition: 'released', revision: 2 },
    { kind: 'resource', entityId: 'resource-2', resourceId: 'resource-2', actionId: 'action-1', attemptId: null,
      assignmentId: 'assignment-1', taskId: null, resourceKind: 'directory', resourceKey: '/backup', disposition: 'released', revision: 2 },
  ];
  return resolveDeskTaskCapacityReserve({ ...empty(), taskEntries: [...rows, ...resources] }, { eventPayloadBytes: 16_384 });
}

test('second verification cycle keeps exact issue and observation credit after its intent', () => {
  const landProof = { ...action(0, 'observed', { phase: 'land', status: 'observed', backupIntegrity: true, recoveryClassification: 'full-applied' }), phase: 'land', body: { phase: 'land' } };
  const firstIntent = action(1, 'intended');
  const firstIssue = action(2, 'issued');
  const firstHeldReceipt = action(3, 'held', { phase: 'discharge', cleanupStep: 'verify-account', status: 'held' });
  const beforeSecond = verificationState([landProof, firstIntent, firstIssue, firstHeldReceipt]);
  const secondIntent = action(4, 'intended');
  const afterIntent = verificationState([landProof, firstIntent, firstIssue, firstHeldReceipt, secondIntent]);
  const secondIssue = action(5, 'issued');
  const afterIssue = verificationState([landProof, firstIntent, firstIssue, firstHeldReceipt, secondIntent, secondIssue]);
  const secondObservation = action(6, 'observed', { phase: 'discharge', cleanupStep: 'verify-account', status: 'observed' });
  const afterObservation = verificationState([landProof, firstIntent, firstIssue, firstHeldReceipt, secondIntent, secondIssue, secondObservation]);

  assert.equal(beforeSecond.requests - WIRE_LIMITS.deskTaskRecoveryRequests, 3);
  assert.equal(beforeSecond.taskEntries - WIRE_LIMITS.deskTaskRecoveryEntries, 3);
  assert.equal(beforeSecond.requests - afterIntent.requests, 1, 'the second intent commit consumes one request, not the whole cycle');
  assert.equal(beforeSecond.taskEntries - afterIntent.taskEntries, 1, 'the second intent commit consumes one action row, not the whole cycle');
  assert.equal(afterIntent.requests - afterIssue.requests, 1, 'the second issue consumes one remaining request credit');
  assert.equal(afterIntent.taskEntries - afterIssue.taskEntries, 1, 'the second issue consumes one remaining action-row credit');
  assert.equal(afterIssue.requests - afterObservation.requests, 1, 'the second observation consumes the final request credit');
  assert.equal(afterIssue.taskEntries - afterObservation.taskEntries, 1, 'the second observation consumes the final action-row credit');
  assert.equal(afterObservation.requests, WIRE_LIMITS.deskTaskRecoveryRequests);
  assert.equal(afterObservation.taskEntries, WIRE_LIMITS.deskTaskRecoveryEntries);
});

async function receiptFixture(t, kind, isolated = false) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-coupled-receipt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repository = join(dir, 'repo'); mkdirSync(repository);
  execFileSync('git', ['init', '-q', repository]);
  const stableRoot = join(dir, 'home', 'slp-runtime'); mkdirSync(stableRoot, { recursive: true, mode: 0o700 });
  const store = createDeskStore({ stableRoot });
  const at = '2026-01-01T00:00:00.000Z';
  const lead = memberRow('owner', { provider: 'slp-codex-lead', at }, { role: 'lead', agentId: 'owner', createCwd: repository, workspaceId: null });
  const worker = memberRow('worker', { provider: 'slp-codex-peer', at }, { agentId: 'worker', createCwd: repository, workspaceId: null });
  const repo = { hostId: 'local', gitCommonDir: realpathSync(join(repository, '.git')) };
  const repoKey = await seedMemberships(store, repo, [lead, worker]);
  const ctx = { repoKey, row: lead };
  const deps = { store };
  const ledger = () => { const read = store.read(repoKey); assert.equal(read.state, 'ok', JSON.stringify(read)); return read.ledger; };
  const registered = await runAssignmentRegister(ctx, { requestId: 'register', authorityRef: 'human:fixture', objective: 'coupled receipt' }, deps);
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const assignmentId = registered.assignmentId;
  const pins = (taskRevision = 1) => ({ expectedLedgerRevision: ledger().revision, expectedBriefRevision: 0, expectedOwnershipRevision: 0, expectedTaskRevision: taskRevision });
  const command = input => runTaskCommand(ctx, { assignmentId, ...input }, deps);
  const effect = input => runTaskEffect(ctx, input, deps);
  const defined = await command({ operation: 'define', requestId: 'define', taskId: 'task-1', ...pins(0),
    task: { state: 'open', outcome: 'artifact', objective: null, authorityRef: 'human:fixture', dependencies: [], scope: null,
      proofPolicy: { kind: 'declared', authorityRef: 'human:fixture', ruleRef: 'protocol:proof', reason: 'fixture', requiredChecks: [], requiredEvidence: [], reviewRequired: false, availability: 'artifact', verificationRecipes: [] },
      grants: { create: 'grant:create', send: 'grant:send', archive: 'grant:archive', integrate: null, commit: null },
      budgets: { maxAttempts: 1, maxActionsPerAttempt: 8 }, reason: null } });
  assert.equal(defined.ok, true, JSON.stringify(defined));
  const reserved = await command({ operation: 'reserve', requestId: 'reserve', taskId: 'task-1', ...pins(), grantRef: 'grant:send',
    // An isolated future birth deliberately has no materialized cwd yet.
    placement: isolated ? { kind: 'isolated' } : { kind: 'shared-checkout', cwd: repository },
    runtime: { optionId: 'fixture', catalogSha256: 'a'.repeat(64) },
    seatPin: { provider: worker.provider, model: 'fixture', optionId: 'fixture', catalogSha256: 'a'.repeat(64) },
    reuseTarget: { agentId: worker.agentId }, effectBudget: 8 });
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  const attemptId = reserved.attemptId;
  const paths = deskRepoPaths(stableRoot, repoKey);
  const measure = () => {
    const l = ledger();
    const r = resolveDeskTaskCapacityReserve(l, { eventPayloadBytes: LEDGER_LIMITS.eventPayloadBytes });
    return { entries: l.taskEntries.length, requests: l.requests.length, events: l.lastEventSeq,
      bytes: readFileSync(paths.ledgerPath).byteLength, reserveEntries: r.taskEntries, reserveRequests: r.requests, reserveBytes: r.bytes,
      memberships: l.memberships.length, scopes: l.scopes.length, transitions: l.scopeTransitions.length };
  };
  const base = { root: repository, snapshotSha256: 'b'.repeat(64), head: null, kind: 'git-snapshot', measuredAt: at, incomplete: [], artifactSha256: null };
  const currentAttempt = () => ledger().taskEntries.filter(row => row.kind === 'attempt' && row.attemptId === attemptId).at(-1);
  let actionId = reserved.next.actionId;
  if (kind !== 'place') {
    const issuePlace = await effect({ operation: 'issue', requestId: 'place-issue', attemptId, actionId });
    assert.equal(issuePlace.perform, true, JSON.stringify(issuePlace));
    const observePlace = await effect({ operation: 'observe', requestId: 'place-observe', attemptId, actionId, actionKind: 'place', receipt: { status: 'observed', cwd: repository, base } });
    assert.equal(observePlace.ok, true, JSON.stringify(observePlace));
    if (kind === 'send' || kind === 'archive') {
      const bound = await effect({ operation: 'bind', requestId: 'bind', attemptId, member: { agentId: worker.agentId, membershipId: worker.membershipId }, observed: { provider: worker.provider, createCwd: repository, workspaceId: null } });
      assert.equal(bound.ok, true, JSON.stringify(bound));
    }
    const intent = await effect({ operation: 'intent', requestId: 'effect-intent', attemptId, actionKind: kind,
      body: { grantRef: `grant:${kind}`, messageId: 'message-1', controlPins: { assignmentId, taskId: 'task-1', ...pins(), expectedAttemptRevision: currentAttempt().revision } } });
    assert.equal(intent.ok, true, JSON.stringify(intent));
    actionId = intent.actionId;
  }
  const beforeIssue = measure();
  const issue = await effect({ operation: 'issue', requestId: 'effect-issue', attemptId, actionId });
  assert.equal(issue.perform, true, JSON.stringify(issue));
  const issued = measure();
  assert.equal(issued.entries - beforeIssue.entries, 1);
  assert.equal(issued.requests - beforeIssue.requests, 1);
  assert.equal(beforeIssue.reserveEntries - issued.reserveEntries, 1);
  assert.equal(beforeIssue.reserveRequests - issued.reserveRequests, 1);
  return { command, effect, ledger, measure, attemptId, actionId, currentAttempt, repository, base, deps };
}

for (const kind of ['place', 'create', 'send', 'archive']) {
  for (const status of ['observed', 'uncertain', 'held', 'failed']) {
    test(`actual store ${kind}/${status} measures accepted coupled receipt rows`, async t => {
      const f = await receiptFixture(t, kind);
      const before = f.measure();
      const receipt = kind === 'place' ? { status, cwd: f.repository, base: f.base }
        : kind === 'create' ? { status, agentId: 'worker' }
        : kind === 'send' ? { status, messageId: 'message-1' } : { status };
      const observed = await f.effect({ operation: 'observe', requestId: 'receipt', attemptId: f.attemptId, actionId: f.actionId, actionKind: kind, receipt });
      assert.equal(observed.ok, true, JSON.stringify(observed));
      const after = f.measure();
      const expected = kind === 'send' && status === 'observed' ? ['action', 'attempt', 'delivery']
        : status === 'observed' || status === 'uncertain' || kind === 'send' && status === 'failed' ? ['action', 'attempt'] : ['action'];
      assert.deepEqual(f.ledger().taskEntries.slice(before.entries).map(row => row.kind), expected);
      assert.equal(after.requests - before.requests, 1);
      assert.equal(after.events - before.events, expected.length);
      assert.equal(after.memberships, before.memberships);
      assert.equal(after.scopes, before.scopes);
      assert.equal(after.transitions, before.transitions);
      if (status === 'observed' || status === 'failed') {
        assert.ok(before.reserveEntries - after.reserveEntries >= expected.length, 'receipt spends its own funded rows');
        assert.equal(before.reserveRequests - after.reserveRequests, kind === 'archive' && status === 'observed' ? 2 : 1);
      } else {
        assert.equal(after.reserveEntries, before.reserveEntries, 'unresolved receipts retain the terminal resolution edge');
        assert.equal(after.reserveRequests, before.reserveRequests);
      }
      const replay = await f.effect({ operation: 'observe', requestId: 'receipt', attemptId: f.attemptId, actionId: f.actionId, actionKind: kind, receipt });
      assert.equal(replay.replayed, true, JSON.stringify(replay));
      assert.deepEqual(f.measure(), after, 'historical replay consumes no credit or row');
      t.diagnostic(JSON.stringify({ kind, status, rows: expected, before, after }));
    });
  }
}

for (const status of ['observed', 'uncertain', 'held', 'failed']) {
  test(`actual isolated ${status} receipt births a worktree before bind and retains release through stop`, async t => {
    const f = await receiptFixture(t, 'place', true);
    assert.equal(f.currentAttempt().placement.cwd, null);
    const before = f.measure();
    const observed = await f.effect({ operation: 'observe', requestId: 'receipt', attemptId: f.attemptId, actionId: f.actionId, actionKind: 'place', receipt: { status, cwd: f.repository, base: f.base } });
    assert.equal(observed.ok, true, JSON.stringify(observed));
    const after = f.measure();
    const expected = status === 'observed' || status === 'uncertain' ? ['action', 'attempt', 'resource'] : ['action', 'resource'];
    assert.deepEqual(f.ledger().taskEntries.slice(before.entries).map(row => row.kind), expected);
    const resource = f.ledger().taskEntries.filter(row => row.kind === 'resource' && row.attemptId === f.attemptId).at(-1);
    assert.equal(resource.resourceKind, 'worktree');
    assert.equal(resource.disposition, 'retained');
    assert.equal(resource.obligations[0].kind, 'remove-after-quiescence');
    assert.equal(f.currentAttempt().member, null);
    const stopped = await f.command({ operation: 'stop', requestId: 'stop', taskId: 'task-1', attemptId: f.attemptId,
      expectedLedgerRevision: f.ledger().revision, expectedBriefRevision: 0, expectedOwnershipRevision: 0, expectedTaskRevision: 1, reason: 'fixture stop' });
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    if (status === 'held' || status === 'uncertain') {
      const settled = await f.command({ operation: 'reconcile', requestId: 'premature-terminal', attemptIds: [f.attemptId], actionIds: [], resourceIds: [], observationTypes: [],
        attemptRulings: [{ attemptId: f.attemptId, expectedAttemptRevision: f.currentAttempt().revision, disposition: 'stopped', reason: 'fixture', evidence: ['fixture'] }] });
      assert.equal(settled.ok, false, 'stop cannot erase unresolved action/resource obligations');
      const resolved = await f.effect({ operation: 'observe', requestId: 'positive-resolution', attemptId: f.attemptId, actionId: f.actionId, actionKind: 'place', receipt: { status: 'observed', cwd: f.repository, base: f.base } });
      assert.equal(resolved.ok, true, JSON.stringify(resolved));
    }
    f.deps.observe = { observeResources: async req => ({ results: req.resources.map(row => ({ resourceId: row.resourceId, kind: row.kind, positive: true, quiescent: true, evidence: [{ kind: 'fixture', ref: 'fixture:removed' }] })) }) };
    const settled = await f.command({ operation: 'reconcile', requestId: 'terminal', attemptIds: [f.attemptId], actionIds: [], resourceIds: [resource.resourceId], observationTypes: ['resources'],
      releaseRulings: [{ resourceId: resource.resourceId, expectedResourceRevision: resource.revision, reason: 'fixture release', evidence: ['fixture:removed'] }],
      attemptRulings: [{ attemptId: f.attemptId, expectedAttemptRevision: f.currentAttempt().revision, disposition: 'stopped', reason: 'fixture', evidence: ['fixture'] }] });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(f.currentAttempt().state, 'stopped');
    assert.equal(f.ledger().taskEntries.filter(row => row.entityId === resource.entityId).at(-1).disposition, 'released');
    const done = f.measure();
    assert.equal(done.reserveEntries, WIRE_LIMITS.deskTaskRecoveryEntries);
    assert.equal(done.reserveRequests, WIRE_LIMITS.deskTaskRecoveryRequests);
    t.diagnostic(JSON.stringify({ kind: 'isolated-place', status, rows: expected, before, after, done }));
  });
}
