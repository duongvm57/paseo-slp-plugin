// tests/plugin-desk-store-schema-v5.test.mjs — P4 store-level coverage
// (contract R2 B1-B10 durable half): the additive v4→v5 migration, the
// chained bumps from older versions, byte-preservation of pre-existing
// tables, the new decide → scopes/scopeReviews/scopeTransitions state
// channels and their fail-closed refinements (lineage, identity binding,
// legal edge walk, round-pin discharge, self-review). A synthetic decide
// drives the channels — command semantics live in
// tests/plugin-desk-scope.test.mjs. Fixtures live under tmpdir().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeskStore, MIGRATIONS, repoKeyFor } from '../plugin/server/desk-store.ts';
import { canonicalSha256 } from '../plugin/server/config-view.ts';

const REPO = { hostId: 'host-test', gitCommonDir: '/repo/.git' };
const REPO_KEY = repoKeyFor(REPO);
const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const COMMAND = { action: 'noop' };

const repoDir = root => join(root, 'state', 'enforcement', 'repos', REPO_KEY);
const ledgerPath = root => join(repoDir(root), 'ledger.json');
const eventsDir = root => join(repoDir(root), 'events');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-desk-v5-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const freshStore = root => createDeskStore({ stableRoot: root });

function envelope(over = {}) {
  return {
    repo: { ...REPO },
    actorKey: 'actor-1',
    assignmentId: 'assign-1',
    requestId: 'req-1',
    command: { ...COMMAND },
    ...over,
  };
}

function membershipRow(over = {}) {
  return {
    membershipId: randomUUID(),
    state: 'host-confirmed',
    bindingHandleSha256: 'a'.repeat(64),
    provider: 'slp-codex-peer',
    family: 'codex',
    role: 'peer',
    createCwd: '/repo',
    openGeneration: 1,
    agentId: 'agent-1',
    workspaceId: 'wks-1',
    createdAt: FIXED_NOW,
    hostConfirmedAt: FIXED_NOW,
    registeredAt: FIXED_NOW,
    revokedAt: null,
    revokeReason: null,
    ...over,
  };
}

function assignmentRow(over = {}) {
  return {
    assignmentId: 'asg-1',
    requestId: 'req-asg-1',
    authorityRef: 'grant:x',
    objective: 'do the thing',
    ownerMembershipId: randomUUID(),
    ownerAgentId: 'agent-lead',
    workspaceId: 'wks-1',
    state: 'open',
    seats: [],
    ...over,
  };
}

function candidateRow(over = {}) {
  return {
    candidateId: 'cand-1',
    assignmentId: 'asg-1',
    kind: 'observed',
    seatAgentId: 'agent-1',
    seatMembershipId: randomUUID(),
    repository: '/repo',
    snapshotSha256: 'c'.repeat(64),
    head: 'a'.repeat(40),
    incomplete: [],
    measuredAt: FIXED_NOW,
    ...over,
  };
}

function scopeRow(over = {}) {
  return {
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-scp-1',
    revision: 1,
    priorRevision: null,
    ownerMembershipId: 'LEAD_MID',
    ownerAgentId: 'agent-lead',
    assignmentRevision: 2,
    seatAgentId: 'agent-1',
    label: 'bounded slice',
    declarationSha256: 'e'.repeat(64),
    refs: ['note:plan'],
    ...over,
  };
}

function scopeReviewRow(over = {}) {
  return {
    reviewId: 'srv-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-rev-1',
    revision: 1,
    scopeRevision: 1,
    candidateSnapshot: 'c'.repeat(64),
    axis: 'spec',
    verdict: 'approve',
    reviewerAgentId: 'agent-2',
    reviewerSeatId: 'SEAT2_MID',
    findingsRef: null,
    ...over,
  };
}

function scopeTransitionRow(over = {}) {
  return {
    transitionId: 'stn-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-trn-1',
    revision: 1,
    command: 'declare',
    from: null,
    to: 'declared',
    scopeRevision: 1,
    candidateSnapshot: null,
    candidateHead: null,
    discharged: [],
    actorAgentId: 'agent-lead',
    ...over,
  };
}

// A v4 fixture: the P3-b shape — every pre-P4 field, no scope tables.
function v4Ledger(over = {}) {
  return {
    format: 'paseo-slp/enforcement',
    schemaVersion: 4,
    repo: {
      repoKey: REPO_KEY,
      repoKeyAlgorithm: 'sha256(hostId|gitCommonDir)@1',
      hostId: REPO.hostId,
      gitCommonDir: REPO.gitCommonDir,
    },
    revision: 1,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    lastEventSeq: 0,
    lastEventSha256: null,
    requests: [
      {
        actorKey: 'actor-1',
        assignmentId: 'assign-1',
        requestId: 'req-1',
        bodySha256: canonicalSha256({ repo: REPO, command: COMMAND }),
        canonicalization: 'slp-canonical-json/1',
        receiptId: randomUUID(),
        revision: 1,
        outcome: 'committed',
        eventSeqs: null,
        rejection: null,
      },
    ],
    memberships: [membershipRow()],
    assignments: [],
    candidates: [],
    handbacks: [],
    settlements: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Migration — additive v4→v5; old tables byte-preserved.
// ---------------------------------------------------------------------------

test('migration: a valid v4 ledger reads ok with persistedSchemaVersion 4 and empty P4 tables', t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const g = graph();
  const v4 = v4Ledger({
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
  });
  writeFileSync(ledgerPath(dir), JSON.stringify(v4));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 4);
  assert.deepEqual(read.ledger.scopes, []);
  assert.deepEqual(read.ledger.scopeReviews, []);
  assert.deepEqual(read.ledger.scopeTransitions, []);
  assert.deepEqual(read.ledger.candidates, v4.candidates, 'candidates migrate verbatim');
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), JSON.stringify(v4), 'read never rewrites the file');
});

test('migration: the first commit on a v4 ledger writes v5 + schema-migrated, tables byte-preserved', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v4 = v4Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v4));
  const store = freshStore(dir);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 5);
  assert.deepEqual(onDisk.scopes, []);
  assert.deepEqual(onDisk.scopeReviews, []);
  assert.deepEqual(onDisk.scopeTransitions, []);
  assert.deepEqual(onDisk.memberships, v4.memberships, 'memberships bytes preserved');
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const kinds = segment.trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['schema-migrated', 'test.event']);
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.deepEqual(migrated.payload, { from: 4, to: 5 });
});

test('migration: a rejection on a v4 ledger commits the v4 shape — the bump waits for success', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), JSON.stringify(v4Ledger()));
  const store = freshStore(dir);
  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rej-1' }), () => ({
    ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required', recovery: 'change the command',
  }));
  assert.equal(rejected.ok, false);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 4, 'a rejection never bumps the version');
  assert.equal(onDisk.scopes, undefined, 'no P4 fields on the v4 file');
  const ok = await store.transact(REPO_KEY, envelope({ requestId: 'ok-1' }), () => ({
    ok: true, events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(ok.ok, true);
  const migrated = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(migrated.schemaVersion, 5);
  assert.deepEqual(migrated.scopes, []);
});

// ---------------------------------------------------------------------------
// The decide → state channels — same schema+refinement gate as P3.
// ---------------------------------------------------------------------------

const seedTables = (store, tables) =>
  store.transact(REPO_KEY, envelope(), () => ({ ok: true, events: [], ...tables }));

/** A minimal VALID P4 graph: lead owner + two attached seats + the bound
 *  seat's observed candidate + declaration rev 1 + the opening transition
 *  + a submitted round + both review axes + the discharging gate row. */
function graph() {
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const seat = membershipRow({ agentId: 'agent-1' });
  const reviewer = membershipRow({ agentId: 'agent-2', bindingHandleSha256: 'b'.repeat(64) });
  const assignment = assignmentRow({
    ownerMembershipId: lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [
      { agentId: seat.agentId, membershipId: seat.membershipId },
      { agentId: reviewer.agentId, membershipId: reviewer.membershipId },
    ],
  });
  const candidate = candidateRow({ seatMembershipId: seat.membershipId, seatAgentId: seat.agentId });
  const scope = scopeRow({ ownerMembershipId: lead.membershipId, assignmentRevision: 3 });
  const transitions = [
    scopeTransitionRow({ transitionId: 'stn-1', revision: 1 }),
    scopeTransitionRow({
      transitionId: 'stn-2', revision: 2, requestId: 'req-trn-2',
      command: 'claim', from: 'declared', to: 'claimed',
    }),
    scopeTransitionRow({
      transitionId: 'stn-3', revision: 3, requestId: 'req-trn-3',
      command: 'submit-for-review', from: 'claimed', to: 'submitted-for-review',
      candidateSnapshot: 'c'.repeat(64), candidateHead: 'a'.repeat(40),
    }),
  ];
  const reviews = [
    scopeReviewRow({ reviewerSeatId: reviewer.membershipId }),
    scopeReviewRow({ reviewId: 'srv-2', requestId: 'req-rev-2', axis: 'standards', reviewerSeatId: reviewer.membershipId }),
  ];
  const gate = scopeTransitionRow({
    transitionId: 'stn-4', revision: 4, requestId: 'req-trn-4',
    command: 'review-observed', from: 'submitted-for-review', to: 'review-observed',
    discharged: [
      { axis: 'spec', reviewId: 'srv-1' },
      { axis: 'standards', reviewId: 'srv-2' },
    ],
  });
  return { lead, seat, reviewer, assignment, candidate, scope, transitions, reviews, gate };
}

const graphTables = g => ({
  memberships: [g.lead, g.seat, g.reviewer],
  assignments: [g.assignment],
  candidates: [g.candidate],
  scopes: [g.scope],
  scopeTransitions: [...g.transitions, g.gate],
  scopeReviews: g.reviews,
});

test('channel: a valid P4 graph commits and reads back', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const result = await seedTables(store, graphTables(g));
  assert.equal(result.ok, true, JSON.stringify(result));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.scopes.length, 1);
  assert.equal(read.ledger.scopeReviews.length, 2);
  assert.equal(read.ledger.scopeTransitions.length, 4);
});

test('channel: schema-invalid scope tables reject INVALID_RECORD', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const bad = { ...g.scope, refs: 'not-an-array' };
  const result = await seedTables(store, { ...graphTables(g), scopes: [bad] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /invalid scopes/);
  const badReview = { ...g.reviews[0], axis: 'vibes' };
  const result2 = await seedTables(store, { ...graphTables(g), scopeReviews: [badReview] });
  assert.equal(result2.ok, false);
  assert.match(result2.message, /invalid scopeReviews/);
  const badTr = { ...g.transitions[0], to: 'nowhere' };
  const result3 = await seedTables(store, { ...graphTables(g), scopeTransitions: [badTr] });
  assert.equal(result3.ok, false);
  assert.match(result3.message, /invalid scopeTransitions/);
});

// ---------------------------------------------------------------------------
// Refinements — fail closed on every link.
// ---------------------------------------------------------------------------

test('refinement: a scope on a foreign assignment or non-owner owner fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const foreign = { ...g.scope, assignmentId: 'asg-ghost' };
  const result = await seedTables(store, { ...graphTables(g), scopes: [foreign] });
  assert.equal(result.ok, false);
  assert.match(result.message, /refinement/);
  const wrongOwner = { ...g.scope, ownerAgentId: 'agent-9' };
  const result2 = await seedTables(store, { ...graphTables(g), scopes: [wrongOwner] });
  assert.equal(result2.ok, false);
});

test('refinement: declaration lineage must be contiguous — a skipped or forked revision fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const gap = { ...g.scope, requestId: 'req-scp-9', revision: 3, priorRevision: 2 };
  const result = await seedTables(store, { ...graphTables(g), scopes: [g.scope, gap] });
  assert.equal(result.ok, false, 'revision 3 without revision 2 is corruption');
  const fork = { ...g.scope, requestId: 'req-scp-9', label: 'forked' };
  const result2 = await seedTables(store, { ...graphTables(g), scopes: [g.scope, fork] });
  assert.equal(result2.ok, false, 'two rows claim revision 1');
  const orphan = { ...g.scope, requestId: 'req-scp-9', revision: 2, priorRevision: null };
  const result3 = await seedTables(store, { ...graphTables(g), scopes: [g.scope, orphan] });
  assert.equal(result3.ok, false, 'rev 2 must name priorRevision 1');
});

test('refinement: assignmentRevision beyond the assignment\'s structural revision fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const future = { ...g.scope, assignmentRevision: 99 };
  const result = await seedTables(store, { ...graphTables(g), scopes: [future] });
  assert.equal(result.ok, false);
});

test('refinement: a review by the owner or the bound seat is self-review — corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // Each sub-case keeps the surrounding tables self-consistent — only the
  // self-review refinement can reject.
  const base = {
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope],
    scopeTransitions: g.transitions,
  };
  // Owner as reviewer — its agentId is never a seat, so reviewerSeatId
  // claims the reviewer's membership and the owner check must still fail.
  const ownerReview = { ...g.reviews[0], reviewerAgentId: 'agent-lead' };
  const result = await seedTables(store, { ...base, scopeReviews: [ownerReview] });
  assert.equal(result.ok, false, 'the owner may never review');
  // The bound seat reviewing its own scope — its seat binding is real.
  const selfReview = { ...g.reviews[0], reviewerAgentId: 'agent-1', reviewerSeatId: g.seat.membershipId };
  const result2 = await seedTables(store, { ...base, scopeReviews: [selfReview] });
  assert.equal(result2.ok, false, 'the bound seat may never review its own scope');
});

test('refinement: a review pinned to a nonexistent scopeRevision or foreign candidate fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const ghostRev = { ...g.reviews[0], scopeRevision: 7 };
  const result = await seedTables(store, { ...graphTables(g), scopeReviews: [ghostRev] });
  assert.equal(result.ok, false);
  const foreignCand = { ...g.reviews[0], candidateSnapshot: '9'.repeat(64) };
  const result2 = await seedTables(store, { ...graphTables(g), scopeReviews: [foreignCand] });
  assert.equal(result2.ok, false);
});

test('refinement: the transition walk must follow the shared edges — an illegal hop is corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // declared → advance is not an edge.
  const illegal = scopeTransitionRow({
    transitionId: 'stn-9', revision: 5, requestId: 'req-trn-9',
    command: 'advance', from: 'review-observed', to: 'advanced',
    discharged: [{ axis: 'spec', reviewId: 'srv-1' }, { axis: 'standards', reviewId: 'srv-2' }],
  });
  const result = await seedTables(store, { ...graphTables(g), scopeTransitions: [...g.transitions, g.gate, illegal] });
  assert.equal(result.ok, false, 'an edge outside SCOPE_TRANSITIONS never commits');
  // A gap in the revision stream.
  const stream = [...g.transitions];
  const gap = scopeTransitionRow({ transitionId: 'stn-9', revision: 5, requestId: 'req-trn-9', command: 'claim', from: 'declared', to: 'claimed' });
  const result2 = await seedTables(store, { memberships: [g.lead, g.seat, g.reviewer], assignments: [g.assignment], candidates: [g.candidate], scopes: [g.scope], scopeTransitions: [g.transitions[0], gap] });
  assert.equal(result2.ok, false, 'transition revisions must be contiguous');
});

test('refinement: a transition whose `to` drifts from the edge\'s target is corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // claim is a legal edge from declared — but its `to` must be `claimed`,
  // never something else. A drifted `to` desyncs the derived machine state.
  const drifted = scopeTransitionRow({
    transitionId: 'stn-2', revision: 2, requestId: 'req-trn-2',
    command: 'claim', from: 'declared', to: 'closed',
  });
  const result = await seedTables(store, {
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope],
    scopeTransitions: [g.transitions[0], drifted],
  });
  assert.equal(result.ok, false, 'the edge table owns the target state, not the row');
});

test('refinement: a gate transition\'s discharge must bind the round pin exactly', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // Discharge naming a foreign reviewId.
  const badGate = { ...g.gate, discharged: [{ axis: 'spec', reviewId: 'srv-ghost' }, { axis: 'standards', reviewId: 'srv-2' }] };
  const result = await seedTables(store, { ...graphTables(g), scopeTransitions: [...g.transitions, badGate] });
  assert.equal(result.ok, false, 'a discharge must name a real review row');
  // Only one axis discharged.
  const halfGate = { ...g.gate, discharged: [{ axis: 'spec', reviewId: 'srv-1' }] };
  const result2 = await seedTables(store, { ...graphTables(g), scopeTransitions: [...g.transitions, halfGate] });
  assert.equal(result2.ok, false, 'every required axis must be discharged');
  // A discharge entry pointing at a review pinned to a different round.
  const wrongPin = { ...g.reviews[0], scopeRevision: 2 };
  const extraScope = { ...g.scope, requestId: 'req-scp-2', revision: 2, priorRevision: 1, label: 'amended' };
  const wrongGate = { ...g.gate, discharged: [{ axis: 'spec', reviewId: 'srv-1' }, { axis: 'standards', reviewId: 'srv-2' }] };
  const result3 = await seedTables(store, {
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope, extraScope],
    scopeReviews: [{ ...wrongPin }, g.reviews[1]],
    scopeTransitions: [...g.transitions, wrongGate],
  });
  assert.equal(result3.ok, false, 'a review pinned off the round never discharges it');
});

test('refinement: an ungated transition carrying discharged entries is corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const tainted = scopeTransitionRow({
    transitionId: 'stn-2', revision: 2, requestId: 'req-trn-2',
    command: 'claim', from: 'declared', to: 'claimed',
    discharged: [{ axis: 'spec', reviewId: 'srv-1' }],
  });
  const result = await seedTables(store, {
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope],
    scopeReviews: g.reviews,
    scopeTransitions: [g.transitions[0], tainted],
  });
  assert.equal(result.ok, false, 'only gated transitions carry discharge evidence');
});

test('refinement: a non-owner actor on a transition row fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const wrong = { ...g.transitions[1], actorAgentId: 'agent-1' };
  const result = await seedTables(store, { ...graphTables(g), scopeTransitions: [g.transitions[0], wrong] });
  assert.equal(result.ok, false);
});

test('refinement: duplicate request keys per actor fail closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // A legal third transition (claimed → submitted-for-review) that reuses
  // the claim row's requestId — same (assignmentId, actorAgentId, requestId).
  const dup = scopeTransitionRow({
    transitionId: 'stn-3', revision: 3, requestId: 'req-trn-2',
    command: 'submit-for-review', from: 'claimed', to: 'submitted-for-review',
    candidateSnapshot: 'c'.repeat(64), candidateHead: 'a'.repeat(40),
  });
  const result = await seedTables(store, {
    memberships: [g.lead, g.seat, g.reviewer],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope],
    scopeTransitions: [g.transitions[0], g.transitions[1], dup],
  });
  assert.equal(result.ok, false, 'two transitions share (assignmentId, actorAgentId, requestId)');
});
