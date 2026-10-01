// tests/plugin-desk-store-schema-v4.test.mjs — P3-b store-level coverage
// (contract P3-b §B8): the additive v3→v4→v5 migration, the chained v1/v2
// bumps, byte-preservation of pre-existing tables, the new decide →
// `settlements` state channel and its refinements. A synthetic decide
// drives the channel — command semantics live in
// tests/plugin-desk-settlement.test.mjs. Fixtures live under tmpdir().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeskStore, LEDGER_LIMITS, MIGRATIONS, repoKeyFor } from '../plugin/server/desk-store.ts';
import { canonicalSha256 } from '../plugin/server/config-view.ts';
import { WIRE_LIMITS } from '../plugin/shared/enforcement.ts';

const REPO = { hostId: 'host-test', gitCommonDir: '/repo/.git' };
const REPO_KEY = repoKeyFor(REPO);
const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const COMMAND = { action: 'noop' };

const repoDir = root => join(root, 'state', 'enforcement', 'repos', REPO_KEY);
const ledgerPath = root => join(repoDir(root), 'ledger.json');
const eventsDir = root => join(repoDir(root), 'events');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-desk-v4-'));
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

function handbackRow(over = {}) {
  const record = over.record ?? { version: 1, kind: 'handback' };
  return {
    handbackId: 'hb-1',
    assignmentId: 'asg-1',
    agentId: 'agent-1',
    seatMembershipId: randomUUID(),
    requestId: 'req-hb-1',
    revision: 1,
    record,
    recordSha256: canonicalSha256(record),
    claimedCandidateId: null,
    observed: {
      status: 'pending',
      candidateId: null,
      repository: '/repo',
      measuredAt: null,
      error: null,
    },
    gaps: [],
    ...over,
  };
}

function settlementRow(over = {}) {
  return {
    settlementId: 'stl-1',
    assignmentId: 'asg-1',
    requestId: 'req-stl-1',
    revision: 1,
    ownerMembershipId: randomUUID(),
    ownerAgentId: 'agent-lead',
    seatAgentId: 'agent-1',
    seatMembershipId: randomUUID(),
    seatProvider: 'slp-codex-peer',
    seatTitle: 'bounded task',
    at: FIXED_NOW,
    deliveryRef: 'note:delivered',
    reworkClosureRef: 'note:rework-closed',
    sinkRef: 'issue:root',
    decisionRef: null,
    handbackRefs: [],
    candidateRefs: [],
    resources: [{ ref: 'agent:peer-1', disposition: 'released' }],
    timeline: {
      nativeHandle: 'rollout-uuid-1',
      sessionId: null,
      via: 'host-transcript',
      export: null,
      gap: 'no authorized transcript export on this host',
    },
    exportVerification: null,
    status: 'completed',
    gaps: ['transcript-export-unavailable', 'decision-reference-missing'],
    ...over,
  };
}

// A v3 fixture: the P3-a shape — body fields + memberships + the P3-a
// tables, no settlements.
function v3Ledger(over = {}) {
  return {
    format: 'paseo-slp/enforcement',
    schemaVersion: 3,
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
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Migration — additive v3→v4 and chained v1/v2; old tables byte-preserved.
// ---------------------------------------------------------------------------

test('migration: a valid v3 ledger reads ok with persistedSchemaVersion 3', t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  // A populated v3 fixture: every P3-a table carries a wired row, so the
  // read asserts verbatim migration of real rows, not empty arrays.
  const g = graph();
  const v3 = v3Ledger({
    memberships: [g.lead, g.seat],
    assignments: [g.assignment],
    candidates: [g.candidate],
    handbacks: [g.handback],
  });
  writeFileSync(ledgerPath(dir), JSON.stringify(v3));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 3);
  assert.deepEqual(read.ledger.settlements, []);
  assert.deepEqual(read.ledger.scopes, []);
  assert.deepEqual(read.ledger.scopeReviews, []);
  assert.deepEqual(read.ledger.scopeTransitions, []);
  assert.deepEqual(read.ledger.handbacks, v3.handbacks, 'handbacks migrate verbatim');
  assert.deepEqual(read.ledger.assignments, v3.assignments, 'assignments migrate verbatim');
  assert.deepEqual(read.ledger.candidates, v3.candidates, 'candidates migrate verbatim');
  assert.deepEqual(read.ledger.memberships, v3.memberships, 'memberships migrate verbatim');
  assert.deepEqual(read.ledger.requests, v3.requests, 'requests migrate verbatim');
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), JSON.stringify(v3), 'read never rewrites the file');
});

test('migration: the first commit on a v3 ledger writes v5 + schema-migrated, tables byte-preserved', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v3 = v3Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v3));
  const store = freshStore(dir);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.settlements, []);
  assert.deepEqual(onDisk.scopes, []);
  assert.deepEqual(onDisk.scopeReviews, []);
  assert.deepEqual(onDisk.scopeTransitions, []);
  assert.deepEqual(onDisk.assignments, []);
  assert.deepEqual(onDisk.memberships, v3.memberships, 'memberships bytes preserved');
  assert.deepEqual(onDisk.requests.slice(0, -1), v3.requests, 'requests bytes preserved');
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const kinds = segment.trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['schema-migrated', 'test.event']);
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.deepEqual(migrated.payload, { from: 3, to: 6 });
});

test('migration: MIGRATIONS[3] is pure and total — input untouched, output adds the empty table', t => {
  const v3 = v3Ledger();
  const snapshot = JSON.stringify(v3);
  const migrated = MIGRATIONS[3](v3);
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.settlements, []);
  assert.deepEqual(migrated.memberships, v3.memberships);
  assert.deepEqual(migrated.requests, v3.requests);
  assert.equal(JSON.stringify(v3), snapshot, 'the input object is never mutated');
});

test('migration: MIGRATIONS[4] is pure and total — the v4 shape gains the three P4 tables', t => {
  const v4 = { ...v3Ledger(), schemaVersion: 4, settlements: [] };
  const snapshot = JSON.stringify(v4);
  const migrated = MIGRATIONS[4](v4);
  assert.equal(migrated.schemaVersion, 5);
  assert.deepEqual(migrated.scopes, []);
  assert.deepEqual(migrated.scopeReviews, []);
  assert.deepEqual(migrated.scopeTransitions, []);
  assert.deepEqual(migrated.settlements, []);
  assert.equal(JSON.stringify(v4), snapshot, 'the input object is never mutated');
});

test('migration: a v2 ledger chains v2→v3→v4→v5 on read and on commit', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v2 = { ...v3Ledger(), schemaVersion: 2 };
  delete v2.assignments;
  delete v2.candidates;
  delete v2.handbacks;
  writeFileSync(ledgerPath(dir), JSON.stringify(v2));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 2);
  assert.deepEqual(read.ledger.settlements, []);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.settlements, []);
  assert.deepEqual(onDisk.scopes, []);
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.equal(migrated.kind, 'schema-migrated');
  assert.deepEqual(migrated.payload, { from: 2, to: 6 });
});

test('migration: a v1 ledger chains v1→v2→v3→v4→v5 on read and on commit', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v1 = { ...v3Ledger(), schemaVersion: 1 };
  delete v1.memberships;
  delete v1.assignments;
  delete v1.candidates;
  delete v1.handbacks;
  writeFileSync(ledgerPath(dir), JSON.stringify(v1));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 1);
  assert.deepEqual(read.ledger.settlements, []);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.deepEqual(migrated.payload, { from: 1, to: 6 });
});

test('migration: a future-version ledger still fails closed', t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), JSON.stringify({ ...v3Ledger(), schemaVersion: 7 }));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'future');
  assert.equal(read.diagnostics.code, 'future-version');
});

// A rejected commit on a persisted v3 ledger keeps the v3 shape on disk.
test('migration: a rejection on a v3 ledger commits the v3 shape — bump waits for success', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v3 = v3Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v3));
  const store = freshStore(dir);
  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rej-1' }), () => ({
    ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required', recovery: 'change the command',
  }));
  assert.equal(rejected.ok, false);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 3, 'a rejection never bumps the version');
  assert.equal(onDisk.settlements, undefined, 'no P3-b field on the v3 file');
  assert.deepEqual(onDisk.assignments, [], 'the v3 tables stay');
  assert.equal(onDisk.requests.length, 2);
  const ok = await store.transact(REPO_KEY, envelope({ requestId: 'ok-1' }), () => ({
    ok: true, events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(ok.ok, true);
  const migrated = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.settlements, []);
  assert.deepEqual(migrated.scopes, []);
});

// ---------------------------------------------------------------------------
// The P3-b decide → state channel — same schema+refinement gate as the
// P3-a tables (§2.2). Synthetic decides only.
// ---------------------------------------------------------------------------

const seedTables = (store, tables) =>
  store.transact(REPO_KEY, envelope(), () => ({ ok: true, events: [], ...tables }));

/** A minimal VALID settlement graph: lead owner + attached seat + the
 *  seat's handback/observed candidate + one settlement row. */
function graph() {
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const seat = membershipRow({ agentId: 'agent-1' });
  const assignment = assignmentRow({
    ownerMembershipId: lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [{ agentId: seat.agentId, membershipId: seat.membershipId }],
  });
  const candidate = candidateRow({ seatMembershipId: seat.membershipId, seatAgentId: seat.agentId });
  const handback = handbackRow({
    seatMembershipId: seat.membershipId,
    agentId: seat.agentId,
    observed: {
      status: 'ok',
      candidateId: candidate.candidateId,
      repository: '/repo',
      measuredAt: FIXED_NOW,
      error: null,
    },
  });
  const settlement = settlementRow({
    ownerMembershipId: lead.membershipId,
    seatMembershipId: seat.membershipId,
    seatProvider: seat.provider,
    handbackRefs: [handback.handbackId],
    candidateRefs: [candidate.candidateId],
  });
  return { lead, seat, assignment, candidate, handback, settlement };
}

const graphTables = g => ({
  memberships: [g.lead, g.seat],
  assignments: [g.assignment],
  candidates: [g.candidate],
  handbacks: [g.handback],
  settlements: [g.settlement],
});

const assertRefused = (result, store) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement|invalid settlements/);
  assert.equal(store.read(REPO_KEY).state, 'absent', 'a refused commit leaves nothing behind');
};

test('channel: a valid settlements table commits; a later decide may leave it alone', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const result = await seedTables(store, graphTables(g));
  assert.equal(result.ok, true, JSON.stringify(result));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.deepEqual(read.ledger.settlements, [g.settlement]);
  const next = await store.transact(REPO_KEY, envelope({ requestId: 'r2' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(next.ok, true);
  assert.deepEqual(store.read(REPO_KEY).ledger.settlements, [g.settlement]);
});

test('channel: an invalid settlements table → INVALID_RECORD, nothing recorded', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const bad = settlementRow({ revision: 0 });
  const result = await seedTables(store, { settlements: [bad] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /invalid settlements/);
});

// ---------------------------------------------------------------------------
// Settlement refinements — every identity link the decide relies on.
// ---------------------------------------------------------------------------

test('refinement: the valid settlement graph commits (positive control)', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await seedTables(store, graphTables(graph()));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('refinement: a settlement owned by a non-owner agentId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.ownerAgentId = 'agent-2'; // ownerMembershipId still points at agent-lead
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: a settlement owner membership that is not a lead fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.lead.role = 'peer';
  g.assignment.ownerMembershipId = g.seat.membershipId;
  g.assignment.ownerAgentId = 'agent-1';
  g.settlement.ownerMembershipId = g.seat.membershipId;
  g.settlement.ownerAgentId = 'agent-1';
  // The seat row is not a lead → owner role check fires.
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: a settlement for a seat not attached to the assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.seatAgentId = 'agent-2'; // not in assignment.seats
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: a settlement whose seatMembershipId belongs to another agent fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.seatMembershipId = g.lead.membershipId; // resolves to agent-lead, not agent-1
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: a settlement referencing another seat\'s handback fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // agent-2 is a real seat of the same assignment with a valid handback —
  // ONLY the settlement's ref link is broken, so the seat pin inside the
  // settlement refinement is the check under test.
  const seat2 = membershipRow({ agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  g.assignment.seats.push({ agentId: 'agent-2', membershipId: seat2.membershipId });
  g.handback.agentId = 'agent-2';
  g.handback.seatMembershipId = seat2.membershipId;
  // The foreign handback carries no candidate links — those would trip the
  // handback's own observed-candidate refinement before the settlement's
  // ref link is even reached.
  g.handback.claimedCandidateId = null;
  g.handback.observed = { status: 'pending', candidateId: null, repository: '/repo', measuredAt: null, error: null };
  g.settlement.handbackRefs = [g.handback.handbackId];
  g.settlement.candidateRefs = [];
  const tables = graphTables(g);
  tables.memberships.push(seat2);
  assertRefused(await seedTables(store, tables), store);
});

test('refinement: a settlement referencing a foreign-assignment handback fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // A second, fully valid assignment for the same seat — the handback is
  // legal THERE; only the settlement's assignment pin is under test.
  const asg2 = assignmentRow({
    assignmentId: 'asg-2',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [{ agentId: g.seat.agentId, membershipId: g.seat.membershipId }],
  });
  const hb2 = handbackRow({
    handbackId: 'hb-2',
    assignmentId: 'asg-2',
    agentId: g.seat.agentId,
    seatMembershipId: g.seat.membershipId,
    requestId: 'req-hb-2',
  });
  g.settlement.handbackRefs = [hb2.handbackId];
  const tables = graphTables(g);
  tables.assignments.push(asg2);
  tables.handbacks.push(hb2);
  assertRefused(await seedTables(store, tables), store);
});

test('refinement: a settlement referencing a foreign-assignment candidate fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const asg2 = assignmentRow({
    assignmentId: 'asg-2',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [{ agentId: g.seat.agentId, membershipId: g.seat.membershipId }],
  });
  const cand2 = candidateRow({
    candidateId: 'cand-2',
    assignmentId: 'asg-2',
    seatAgentId: g.seat.agentId,
    seatMembershipId: g.seat.membershipId,
  });
  g.settlement.candidateRefs = [cand2.candidateId];
  const tables = graphTables(g);
  tables.assignments.push(asg2);
  tables.candidates.push(cand2);
  assertRefused(await seedTables(store, tables), store);
});

test('refinement: a settlement denormalized seatProvider must match the membership', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.seatProvider = 'slp-pi-peer';
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: duplicate (assignmentId, seatAgentId, revision) settlements are refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const dup = settlementRow({
    ...g.settlement,
    settlementId: 'stl-2',
    requestId: 'req-stl-2',
  });
  const result = await seedTables(store, { ...graphTables(g), settlements: [g.settlement, dup] });
  assertRefused(result, store);
});

test('refinement: duplicate (assignmentId, ownerAgentId, requestId) settlement requests are refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const dup = settlementRow({
    ...g.settlement,
    settlementId: 'stl-2',
    revision: 2,
  });
  const result = await seedTables(store, { ...graphTables(g), settlements: [g.settlement, dup] });
  assertRefused(result, store);
});

test('refinement: a settlement on an unknown assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.assignmentId = 'asg-ghost';
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: a settlement via outside the closed SETTLEMENT_VIA enum fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.timeline = { ...g.settlement.timeline, via: 'invented-source' };
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('schema: settlement pointer/field caps share the wire bounds', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.deliveryRef = 'x'.repeat(WIRE_LIMITS.deskSettlementPointer + 1);
  assertRefused(await seedTables(store, graphTables(g)), store);
  const g2 = graph();
  g2.settlement.gaps = ['y'.repeat(WIRE_LIMITS.gapLen + 1)];
  const second = await seedTables(store, { ...graphTables(g2), settlements: [g2.settlement] });
  assertRefused(second, store);
});

// ---------------------------------------------------------------------------
// Export-verification coupling (P3-b R1) — the durable seam verdict must be
// consistent with the claim and the computed status: an unproven export can
// never sit on a completed row.
// ---------------------------------------------------------------------------

const CLAIMED_EXPORT = { path: '.local-checks/t.txt', sha256: 'f'.repeat(64), bytes: 12 };

test('refinement: a claimed export without the seam verdict fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = null;
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: an export-less row carrying a verdict fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.exportVerification = { status: 'verified', detail: null };
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: an unverified export can never sit on a completed row', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = { status: 'unavailable', detail: 'host-verifier-missing' };
  g.settlement.status = 'completed';
  g.settlement.gaps = ['transcript-export-unverified'];
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: an unverified export without the durable gap marker fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = { status: 'unavailable', detail: null };
  g.settlement.status = 'partial';
  g.settlement.gaps = ['decision-reference-missing'];
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: a verified row carrying the unverified gap marker fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = { status: 'verified', detail: null };
  g.settlement.status = 'completed';
  g.settlement.gaps = ['transcript-export-unverified', 'decision-reference-missing'];
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: a claimed-only unavailable export commits as partial with the durable gap (positive control)', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = { status: 'unavailable', detail: 'host-verifier-missing' };
  g.settlement.status = 'partial';
  g.settlement.gaps = ['transcript-export-unverified', 'decision-reference-missing'];
  const result = await seedTables(store, graphTables(g));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('refinement: a verified export commits as completed (positive control)', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.settlement.timeline = { ...g.settlement.timeline, export: CLAIMED_EXPORT };
  g.settlement.exportVerification = { status: 'verified', detail: null };
  g.settlement.status = 'completed';
  g.settlement.gaps = ['decision-reference-missing'];
  const result = await seedTables(store, graphTables(g));
  assert.equal(result.ok, true, JSON.stringify(result));
});
