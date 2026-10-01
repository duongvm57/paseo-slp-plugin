// tests/plugin-desk-store-schema-v3.test.mjs — P3-a store-level coverage
// (contract P3-a §X6 + §4): the additive v2→v3 migration, the v1→v3 chain,
// byte-preservation of pre-existing tables, the new decide → state
// channels (assignments/candidates/handbacks), and their refinements. A
// synthetic decide drives the channels — command semantics live in
// tests/plugin-desk-handback.test.mjs. Fixtures live under tmpdir().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeskStore, LEDGER_LIMITS, MIGRATIONS, repoKeyFor } from '../plugin/server/desk-store.ts';
import { canonicalSha256 } from '../plugin/server/config-view.ts';

const REPO = { hostId: 'host-test', gitCommonDir: '/repo/.git' };
const REPO_KEY = repoKeyFor(REPO);
const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const COMMAND = { action: 'noop' };

const repoDir = root => join(root, 'state', 'enforcement', 'repos', REPO_KEY);
const ledgerPath = root => join(repoDir(root), 'ledger.json');
const eventsDir = root => join(repoDir(root), 'events');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-desk-v3-'));
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

function handbackRow(over = {}) {
  // The store now fails closed when recordSha256 does not equal
  // canonicalSha256(record) — the fixture hashes the real row bytes, and a
  // negative test overrides recordSha256 explicitly.
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

// A v2 fixture: the P2-c shape — body fields + memberships, no P3-a tables.
function v2Ledger(over = {}) {
  return {
    format: 'paseo-slp/enforcement',
    schemaVersion: 2,
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
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Migration — additive v2→v3 and chained v1→v3; old tables byte-preserved.
// ---------------------------------------------------------------------------

test('migration: a valid v2 ledger reads ok with persistedSchemaVersion 2', t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v2 = v2Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v2));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 2);
  assert.deepEqual(read.ledger.assignments, []);
  assert.deepEqual(read.ledger.candidates, []);
  assert.deepEqual(read.ledger.handbacks, []);
  assert.deepEqual(read.ledger.memberships, v2.memberships, 'memberships migrate verbatim');
  assert.deepEqual(read.ledger.requests, v2.requests, 'requests migrate verbatim');
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), JSON.stringify(v2), 'read never rewrites the file');
});

test('migration: the first commit on a v2 ledger writes v3 + schema-migrated, tables byte-preserved', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v2 = v2Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v2));
  const store = freshStore(dir);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.assignments, []);
  assert.deepEqual(onDisk.candidates, []);
  assert.deepEqual(onDisk.handbacks, []);
  assert.deepEqual(onDisk.settlements, []);
  assert.deepEqual(onDisk.memberships, v2.memberships, 'memberships bytes preserved');
  assert.deepEqual(onDisk.requests.slice(0, -1), v2.requests, 'requests bytes preserved');
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const kinds = segment.trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['schema-migrated', 'test.event']);
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.deepEqual(migrated.payload, { from: 2, to: 6 });
});

test('migration: MIGRATIONS[2] is pure and total — input untouched, output adds three empty tables', t => {
  const v2 = v2Ledger();
  const snapshot = JSON.stringify(v2);
  const migrated = MIGRATIONS[2](v2);
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.assignments, []);
  assert.deepEqual(migrated.candidates, []);
  assert.deepEqual(migrated.handbacks, []);
  assert.deepEqual(migrated.memberships, v2.memberships);
  assert.deepEqual(migrated.requests, v2.requests);
  assert.equal(JSON.stringify(v2), snapshot, 'the input object is never mutated');
});

test('migration: a v1 ledger chains v1→v2→v3 on read and on commit', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v1 = { ...v2Ledger(), schemaVersion: 1 };
  delete v1.memberships;
  writeFileSync(ledgerPath(dir), JSON.stringify(v1));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 1);
  assert.deepEqual(read.ledger.memberships, []);
  assert.deepEqual(read.ledger.handbacks, []);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.assignments, []);
  assert.deepEqual(onDisk.settlements, []);
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.equal(migrated.kind, 'schema-migrated');
  assert.deepEqual(migrated.payload, { from: 1, to: 6 });
});

// ---------------------------------------------------------------------------
// The P3-a decide → state channels — same schema+refinement gate as
// memberships (§2.2). Synthetic decides only.
// ---------------------------------------------------------------------------

test('channels: valid assignments/candidates/handbacks tables commit; a later decide may leave them alone', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const member = membershipRow();
  const assignment = assignmentRow({
    ownerMembershipId: lead.membershipId,
    seats: [{ agentId: member.agentId, membershipId: member.membershipId }],
  });
  const candidate = candidateRow({ seatMembershipId: member.membershipId });
  const handback = handbackRow({
    seatMembershipId: member.membershipId,
    claimedCandidateId: candidate.candidateId,
    observed: {
      status: 'ok',
      candidateId: candidate.candidateId,
      repository: '/repo',
      measuredAt: FIXED_NOW,
      error: null,
    },
  });
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true,
    events: [{ kind: 'test.seed', payload: {} }],
    memberships: [lead, member],
    assignments: [assignment],
    candidates: [candidate],
    handbacks: [handback],
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.deepEqual(read.ledger.assignments, [assignment]);
  assert.deepEqual(read.ledger.candidates, [candidate]);
  assert.deepEqual(read.ledger.handbacks, [handback]);
  // A decide without the new channels leaves them verbatim.
  const next = await store.transact(REPO_KEY, envelope({ requestId: 'r2' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(next.ok, true);
  const read2 = store.read(REPO_KEY);
  assert.deepEqual(read2.ledger.handbacks, [handback]);
});

test('channels: an invalid assignments table → INVALID_RECORD, nothing recorded', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const bad = assignmentRow({ state: 'reserving' }); // outside the v3 state set
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true, events: [], assignments: [bad],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /decide returned invalid assignments/);
  assert.equal(store.read(REPO_KEY).state, 'absent');
});

test('channels: an invalid handbacks table → INVALID_RECORD, nothing recorded', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const bad = handbackRow({ revision: 0 });
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true, events: [], handbacks: [bad],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /decide returned invalid handbacks/);
});

// ---------------------------------------------------------------------------
// Refinements — referential integrity and stream uniqueness.
// ---------------------------------------------------------------------------

const seedTables = (store, tables) =>
  store.transact(REPO_KEY, envelope(), () => ({ ok: true, events: [], ...tables }));

test('refinement: a dangling ownerMembershipId in assignments fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await seedTables(store, {
    assignments: [assignmentRow({ ownerMembershipId: randomUUID() })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
  assert.equal(store.read(REPO_KEY).state, 'absent');
});

test('refinement: a candidate against an unknown assignment is refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await seedTables(store, {
    candidates: [candidateRow({ assignmentId: 'asg-missing' })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
});

test('refinement: a handback claiming a foreign candidateId is refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const member = membershipRow();
  const result = await seedTables(store, {
    memberships: [lead, member],
    assignments: [assignmentRow({
      ownerMembershipId: lead.membershipId,
      seats: [{ agentId: member.agentId, membershipId: member.membershipId }],
    })],
    handbacks: [handbackRow({ seatMembershipId: member.membershipId, claimedCandidateId: 'cand-ghost' })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
});

test('refinement: duplicate (assignmentId, agentId, revision) handbacks are refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const member = membershipRow();
  const result = await seedTables(store, {
    memberships: [lead, member],
    assignments: [assignmentRow({
      ownerMembershipId: lead.membershipId,
      seats: [{ agentId: member.agentId, membershipId: member.membershipId }],
    })],
    handbacks: [
      handbackRow({ handbackId: 'hb-1', seatMembershipId: member.membershipId }),
      handbackRow({ handbackId: 'hb-2', requestId: 'req-hb-2', seatMembershipId: member.membershipId }),
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
});

test('refinement: duplicate seat agentId inside one assignment is refused', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const member = membershipRow();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  const result = await seedTables(store, {
    memberships: [lead, member, other],
    assignments: [assignmentRow({
      ownerMembershipId: lead.membershipId,
      seats: [
        { agentId: 'agent-1', membershipId: member.membershipId },
        { agentId: 'agent-1', membershipId: other.membershipId },
      ],
    })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
});

// ---------------------------------------------------------------------------
// A handback record cap — decide-side and row-level both bounded.
// ---------------------------------------------------------------------------

test('record bytes: an oversized handback record fails the schema refinement', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const member = membershipRow();
  const fat = 'x'.repeat(LEDGER_LIMITS.handbackRecordBytes); // > cap once wrapped
  const result = await seedTables(store, {
    memberships: [lead, member],
    assignments: [assignmentRow({
      ownerMembershipId: lead.membershipId,
      seats: [{ agentId: member.agentId, membershipId: member.membershipId }],
    })],
    handbacks: [handbackRow({ seatMembershipId: member.membershipId, record: { big: fat } })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
});

// A rejected commit on a persisted v2 ledger keeps the v2 shape on disk.
test('migration: a rejection on a v2 ledger commits the v2 shape — bump waits for success', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v2 = v2Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v2));
  const store = freshStore(dir);
  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rej-1' }), () => ({
    ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required', recovery: 'change the command',
  }));
  assert.equal(rejected.ok, false);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 2, 'a rejection never bumps the version');
  assert.equal(onDisk.assignments, undefined, 'no P3-a fields on the v2 file');
  assert.equal(onDisk.requests.length, 2);
  const ok = await store.transact(REPO_KEY, envelope({ requestId: 'ok-1' }), () => ({
    ok: true, events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(ok.ok, true);
  const migrated = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.assignments, []);
  assert.deepEqual(migrated.settlements, []);
});

// ---------------------------------------------------------------------------
// Cross-table identity refinements — fail-closed on every link the decide
// relies on, not just existence. `graph()` builds a minimal VALID identity
// graph; each test then corrupts exactly one edge.
// ---------------------------------------------------------------------------

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
    claimedCandidateId: candidate.candidateId,
    observed: {
      status: 'ok',
      candidateId: candidate.candidateId,
      repository: '/repo',
      measuredAt: FIXED_NOW,
      error: null,
    },
  });
  return { lead, seat, assignment, candidate, handback };
}

const graphTables = g => ({
  memberships: [g.lead, g.seat],
  assignments: [g.assignment],
  candidates: [g.candidate],
  handbacks: [g.handback],
});

const assertRefused = (result, store) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /refinement/);
  assert.equal(store.read(REPO_KEY).state, 'absent', 'a refused commit leaves nothing behind');
};

test('refinement: the valid identity graph commits (positive control)', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await seedTables(store, graphTables(graph()));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(store.read(REPO_KEY).state, 'ok');
});

test('refinement: an owner membership carrying a different agentId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.assignment.ownerAgentId = 'agent-2'; // ownerMembershipId still points at agent-lead
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: a non-lead owner membership fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.lead.role = 'peer'; // the ownerMembershipId now resolves to a non-lead
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: an assignment seat whose membership carries a different agentId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.assignment.seats = [{ agentId: 'agent-2', membershipId: g.seat.membershipId }];
  assertRefused(await seedTables(store, graphTables(g)), store);
});

test('refinement: a handback whose seatMembershipId carries a different agentId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  g.handback.seatMembershipId = other.membershipId; // resolves to agent-2, row claims agent-1
  const result = await seedTables(store, {
    ...graphTables(g),
    memberships: [g.lead, g.seat, other],
  });
  assertRefused(result, store);
});

test('refinement: a handback whose agentId is not attached to its assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  // asg-2 attaches agent-2 only; the handback claims the agent-1 seat on it.
  const otherAssignment = assignmentRow({
    assignmentId: 'asg-2',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    seats: [{ agentId: other.agentId, membershipId: other.membershipId }],
  });
  g.handback.assignmentId = otherAssignment.assignmentId;
  g.handback.claimedCandidateId = null;
  g.handback.observed = { status: 'pending', candidateId: null, repository: '/repo', measuredAt: null, error: null };
  const result = await seedTables(store, {
    ...graphTables(g),
    memberships: [g.lead, g.seat, other],
    assignments: [g.assignment, otherAssignment],
  });
  assertRefused(result, store);
});

test('refinement: a claimed candidateId on another assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  const otherAssignment = assignmentRow({
    assignmentId: 'asg-2',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    seats: [{ agentId: other.agentId, membershipId: other.membershipId }],
  });
  const foreignCandidate = candidateRow({
    candidateId: 'cand-2',
    assignmentId: otherAssignment.assignmentId,
    seatMembershipId: other.membershipId,
    seatAgentId: other.agentId,
  });
  g.handback.claimedCandidateId = foreignCandidate.candidateId; // belongs to asg-2, not asg-1
  const result = await seedTables(store, {
    ...graphTables(g),
    memberships: [g.lead, g.seat, other],
    assignments: [g.assignment, otherAssignment],
    candidates: [g.candidate, foreignCandidate],
  });
  assertRefused(result, store);
});

test('refinement: an observed candidateId on another assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  const otherAssignment = assignmentRow({
    assignmentId: 'asg-2',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    seats: [{ agentId: other.agentId, membershipId: other.membershipId }],
  });
  const foreignCandidate = candidateRow({
    candidateId: 'cand-2',
    assignmentId: otherAssignment.assignmentId,
    seatMembershipId: other.membershipId,
    seatAgentId: other.agentId,
  });
  g.handback.observed = {
    status: 'ok',
    candidateId: foreignCandidate.candidateId,
    repository: '/repo',
    measuredAt: FIXED_NOW,
    error: null,
  };
  const result = await seedTables(store, {
    ...graphTables(g),
    memberships: [g.lead, g.seat, other],
    assignments: [g.assignment, otherAssignment],
    candidates: [g.candidate, foreignCandidate],
  });
  assertRefused(result, store);
});

test('refinement: an observed candidate recorded for a different seatMembershipId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  const otherCandidate = candidateRow({
    candidateId: 'cand-2',
    seatMembershipId: other.membershipId,
    seatAgentId: other.agentId,
  });
  // The candidate is on the same assignment but was observed for a seat the
  // handback never claimed — the handback→observed seat link must hold.
  g.assignment.seats.push({ agentId: other.agentId, membershipId: other.membershipId });
  g.handback.observed = {
    status: 'ok',
    candidateId: otherCandidate.candidateId,
    repository: '/repo',
    measuredAt: FIXED_NOW,
    error: null,
  };
  const result = await seedTables(store, {
    ...graphTables(g),
    memberships: [g.lead, g.seat, other],
    candidates: [g.candidate, otherCandidate],
  });
  assertRefused(result, store);
});

test('refinement: a candidate whose seatMembershipId carries a different agentId fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  g.candidate.seatMembershipId = other.membershipId; // resolves to agent-2, row claims agent-1
  const result = await seedTables(store, {
    ...graphTables(g),
    memberships: [g.lead, g.seat, other],
  });
  assertRefused(result, store);
});

test('refinement: a candidate whose seatAgentId is not attached to its assignment fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  g.assignment.seats = [{ agentId: other.agentId, membershipId: other.membershipId }]; // agent-1 detached
  // The handback would fail the same rule — candidates are checked first,
  // so this isolates the candidate-side attachment link.
  const result = await seedTables(store, {
    ...graphTables(g),
    memberships: [g.lead, g.seat, other],
  });
  assertRefused(result, store);
});

test('refinement: a closed assignment with a revoked seat stays valid history', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.assignment.state = 'closed';
  g.seat.state = 'revoked';
  g.seat.revokedAt = FIXED_NOW;
  g.seat.revokeReason = 'archived';
  const result = await seedTables(store, graphTables(g));
  assert.equal(result.ok, true, `closed/revoked history must stay readable: ${JSON.stringify(result)}`);
  assert.equal(store.read(REPO_KEY).state, 'ok');
});

test('refinement: a doctored ledger file reads corrupt — write-side and read-side both fail closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const result = await seedTables(store, graphTables(graph()));
  assert.equal(result.ok, true, JSON.stringify(result));
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  onDisk.handbacks[0].agentId = 'agent-2'; // tamper with the recorded identity link
  writeFileSync(ledgerPath(dir), JSON.stringify(onDisk));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'corrupt');
  assert.equal(read.diagnostics.code, 'refinement-failed');
});

// ---------------------------------------------------------------------------
// The serialized-ledger byte cap (LEDGER_LIMITS.ledgerBytes) — the commit
// path refuses a write that would produce an unreadable oversized file,
// before any durable write and without touching acknowledged state.
// ---------------------------------------------------------------------------

const fatHandbacks = (seatMembershipId, count, revisionFrom = 1) =>
  Array.from({ length: count }, (_, i) =>
    handbackRow({
      handbackId: `hb-fat-${revisionFrom + i}`,
      requestId: `req-fat-${revisionFrom + i}`,
      seatMembershipId,
      revision: revisionFrom + i,
      record: { version: 1, kind: 'handback', big: 'x'.repeat(240000) },
    }));

test('ledger bytes: an over-cap commit is refused INVALID_RECORD before any durable write', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const result = await store.transact(REPO_KEY, envelope(), () => ({
    ok: true,
    events: [{ kind: 'test.seed', payload: {} }],
    memberships: [g.lead, g.seat],
    assignments: [g.assignment],
    // ~70 rows of ~250 KB each — the serialized candidate is ~17 MB.
    handbacks: fatHandbacks(g.seat.membershipId, 70),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /byte cap|over the \d+-byte cap/);
  // The refusal fired before the segment and the commit point alike — the
  // repo directory holds neither a ledger nor an orphan event segment.
  assert.equal(store.read(REPO_KEY).state, 'absent');
  assert.equal(existsSync(eventsDir(dir)), false);
});

test('ledger bytes: saturation refuses the over-cap commit, keeps acknowledged state readable and replayable', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const seed = await store.transact(REPO_KEY, envelope({ requestId: 'seed-1' }), () => ({
    ok: true,
    events: [],
    memberships: [g.lead, g.seat],
    assignments: [g.assignment],
  }));
  assert.equal(seed.ok, true, JSON.stringify(seed));
  // Each fill commit appends one ~250 KB handback row — the serialized
  // ledger approaches the cap and the first crossing commit is refused.
  const fill = i => ledger => ({
    ok: true,
    events: [{ kind: 'test.fill', payload: { i } }],
    handbacks: [...ledger.handbacks, ...fatHandbacks(g.seat.membershipId, 1, i)],
  });
  let saturated = null;
  let committed = 0;
  for (let i = 1; i <= 80; i += 1) {
    const result = await store.transact(REPO_KEY, envelope({ requestId: `fill-${i}` }), fill(i));
    if (!result.ok) {
      saturated = result;
      break;
    }
    committed = i;
  }
  assert.ok(saturated !== null, 'the byte cap must fire before 80 commits');
  assert.equal(saturated.code, 'INVALID_RECORD');
  assert.match(saturated.message, /over the \d+-byte cap/);
  // The acknowledged ledger never crossed the cap and still reads cleanly.
  assert.ok(statSync(ledgerPath(dir)).size <= LEDGER_LIMITS.ledgerBytes);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok', `saturated ledger must stay readable: ${JSON.stringify(read.diagnostics)}`);
  assert.equal(read.ledger.handbacks.length, committed);
  // An already-acknowledged request still replays its recorded receipt.
  const replay = await store.transact(
    REPO_KEY,
    envelope({ requestId: 'fill-1' }),
    () => ({ ok: false, code: 'X', message: 'unreachable', recovery: 'unreachable' }),
  );
  assert.equal(replay.ok, true, `replay must return the recorded receipt: ${JSON.stringify(replay)}`);
  assert.equal(replay.receipt.replayed, true);
  // The refused request was never recorded — retrying it re-derives the
  // same typed rejection instead of double-committing.
  const retry = await store.transact(REPO_KEY, envelope({ requestId: `fill-${committed + 1}` }), fill(committed + 1));
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'INVALID_RECORD');
});

// A decide rejection is also a commit — its recorded rejection row makes the
// serialized ledger grow, so the byte cap must refuse it identically. The
// ledger is built just under the cap so the outcome is deterministic.
test('ledger bytes: a decide rejection that would push the ledger over the cap is refused the same way', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // Build a valid v3 ledger on disk sized just under the byte cap: fat
  // handback rows approach the bound, then one row's pad field lands the
  // file at exactly `target` bytes.
  const ledger = {
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
    requests: [],
    memberships: [g.lead, g.seat],
    assignments: [g.assignment],
    candidates: [],
    handbacks: [],
  };
  const target = LEDGER_LIMITS.ledgerBytes - 350;
  const measure = () => Buffer.byteLength(JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  while (measure() + 252000 < target) {
    ledger.handbacks.push(
      handbackRow({
        handbackId: `hb-fat-${ledger.handbacks.length + 1}`,
        requestId: `req-fat-${ledger.handbacks.length + 1}`,
        seatMembershipId: g.seat.membershipId,
        revision: ledger.handbacks.length + 1,
        record: { version: 1, kind: 'handback', big: 'x'.repeat(240000) },
      }),
    );
  }
  // The pad row stays under the per-record cap (its pad is < 252000 bytes).
  ledger.handbacks.push(
    handbackRow({
      handbackId: 'hb-pad',
      requestId: 'req-pad',
      seatMembershipId: g.seat.membershipId,
      revision: ledger.handbacks.length + 1,
      record: { version: 1, kind: 'handback', pad: '' },
    }),
  );
  ledger.handbacks.at(-1).record.pad = 'x'.repeat(target - measure());
  // The pad lands after handbackRow hashed the record — a sha256 field is
  // fixed-width, so recomputing it keeps the file at exactly `target`.
  ledger.handbacks.at(-1).recordSha256 = canonicalSha256(ledger.handbacks.at(-1).record);
  const bytes = JSON.stringify(ledger, null, 2) + '\n';
  assert.equal(Buffer.byteLength(bytes, 'utf8'), target);
  mkdirSync(repoDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), bytes);
  assert.equal(store.read(REPO_KEY).state, 'ok');
  // The rejection's own recorded row (~1.5 KB with these strings) overflows
  // the 350-byte headroom — refused before the commit point, never recorded.
  const rejected = await store.transact(
    REPO_KEY,
    envelope({ requestId: 'rej-cap' }),
    () => ({
      ok: false,
      code: 'AUTHORITY_REQUIRED',
      message: 'm'.repeat(500),
      recovery: 'r'.repeat(500),
    }),
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'INVALID_RECORD');
  assert.match(rejected.message, /over the \d+-byte cap/);
  // The acknowledged ledger is byte-identical — nothing was appended.
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), bytes);
  assert.equal(store.read(REPO_KEY).state, 'ok');
});

// ---------------------------------------------------------------------------
// r2 additions — join-key integrity, canonical hash, tuple encoding.
// ---------------------------------------------------------------------------

test('refinement: duplicate membershipIds fail closed on commit and on read', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const dup = randomUUID();
  const a = membershipRow({ membershipId: dup, agentId: 'agent-1' });
  const b = membershipRow({ membershipId: dup, agentId: 'agent-2', bindingHandleSha256: 'e'.repeat(64) });
  const result = await seedTables(store, { memberships: [a, b] });
  assertRefused(result, store);
  // A doctored on-disk ledger with the same duplication reads corrupt.
  mkdirSync(repoDir(dir), { recursive: true });
  const v2 = v2Ledger({ memberships: [a, b] });
  writeFileSync(ledgerPath(dir), JSON.stringify(v2));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'corrupt');
  assert.equal(read.diagnostics.code, 'refinement-failed');
});

test('refinement: duplicate (ownerAgentId, requestId) assignment pairs fail closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const second = assignmentRow({
    assignmentId: 'asg-2',
    requestId: g.assignment.requestId, // the response resolver keys here
    ownerMembershipId: g.lead.membershipId,
  });
  const result = await seedTables(store, {
    ...graphTables(g),
    assignments: [g.assignment, second],
  });
  assertRefused(result, store);
});

test('refinement: a stored recordSha256 that is not canonicalSha256(record) fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  g.handback.recordSha256 = 'f'.repeat(64); // plausible-looking but not the record's canonical hash
  const result = await seedTables(store, graphTables(g));
  assertRefused(result, store);
  // The same corruption planted on disk after a valid commit reads corrupt.
  const ok = await seedTables(store, graphTables(graph()));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  onDisk.handbacks[0].recordSha256 = 'f'.repeat(64);
  writeFileSync(ledgerPath(dir), JSON.stringify(onDisk));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'corrupt');
  assert.equal(read.diagnostics.code, 'refinement-failed');
});

test('refinement: canonical key order — a record hashed canonically commits regardless of key order', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // The stored record's keys are NOT in canonical order; its sha is the
  // canonical hash. A raw-byte hash implementation would refuse this row.
  g.handback.record = { zebra: 1, apple: { nested: true }, middle: [3, 2, 1] };
  g.handback.recordSha256 = canonicalSha256({ apple: { nested: true }, middle: [3, 2, 1], zebra: 1 });
  const result = await seedTables(store, graphTables(g));
  assert.equal(result.ok, true, `canonical-ordered hash must verify: ${JSON.stringify(result)}`);
  assert.equal(store.read(REPO_KEY).state, 'ok');
});

test('refinement: delimiter-embedded handback tuples stay distinct', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // Delimiter-injection control: an agentId carrying '|' must not alias
  // another (assignmentId, agentId) pair under ANY concat scheme. JSON
  // tuple encoding keeps ["asg-1","a|b",1] and ["asg-1|a","b",1] distinct;
  // a '|'-joined key would collide them.
  const other = membershipRow({ membershipId: randomUUID(), agentId: 'b', bindingHandleSha256: 'e'.repeat(64) });
  const pipe = membershipRow({ membershipId: randomUUID(), agentId: 'a|b', bindingHandleSha256: '7'.repeat(64) });
  const second = assignmentRow({
    assignmentId: 'asg-1|a',
    requestId: 'req-asg-2',
    ownerMembershipId: g.lead.membershipId,
    seats: [{ agentId: 'b', membershipId: other.membershipId }],
  });
  // Keep the graph's original seat attached — g.candidate still resolves
  // through agent-1 — and add the 'a|b' seat alongside it.
  g.assignment.seats.push({ agentId: 'a|b', membershipId: pipe.membershipId });
  g.handback.agentId = 'a|b';
  g.handback.seatMembershipId = pipe.membershipId;
  g.handback.claimedCandidateId = null;
  g.handback.observed = { status: 'pending', candidateId: null, repository: '/repo', measuredAt: null, error: null };
  const otherHandback = handbackRow({
    handbackId: 'hb-2',
    requestId: 'req-hb-2',
    assignmentId: 'asg-1|a',
    agentId: 'b',
    seatMembershipId: other.membershipId,
    revision: 1,
  });
  const result = await seedTables(store, {
    memberships: [g.lead, g.seat, other, pipe],
    assignments: [g.assignment, second],
    candidates: [g.candidate],
    handbacks: [g.handback, otherHandback],
  });
  assert.equal(result.ok, true, `distinct tuples must not alias: ${JSON.stringify(result)}`);
  assert.equal(store.read(REPO_KEY).state, 'ok');
  assert.equal(store.read(REPO_KEY).ledger.handbacks.length, 2);
});

// ---------------------------------------------------------------------------
// r2-proof — the ORIGINAL bare-concat defect class. Every multi-part store
// key must distinguish tuples whose parts alias under `${a}${b}${c}` /
// join(""): split-boundary ("ab"+"c" == "a"+"bc") and digit ("a1"+23 ==
// "a"+123) shifts. Only tuple encoding (JSON.stringify) is safe — a mutant
// restoring bare concat on ANY single site turns this suite red.
// ---------------------------------------------------------------------------

test('refinement: bare-concat aliases stay distinct across every multi-part store key', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  // Two owner leads whose (ownerAgentId, requestId) pairs alias under bare
  // concat: ("lead-ab","c") and ("lead-a","bc") both flatten to "lead-abc".
  const leadAb = membershipRow({ membershipId: randomUUID(), agentId: 'lead-ab', role: 'lead', bindingHandleSha256: '1'.repeat(64) });
  const leadA = membershipRow({ membershipId: randomUUID(), agentId: 'lead-a', role: 'lead', bindingHandleSha256: '2'.repeat(64) });
  const seatA1 = membershipRow({ membershipId: randomUUID(), agentId: 'a1', bindingHandleSha256: '3'.repeat(64) });
  const seatA = membershipRow({ membershipId: randomUUID(), agentId: 'a', bindingHandleSha256: '4'.repeat(64) });
  const seatAb = membershipRow({ membershipId: randomUUID(), agentId: 'ab', bindingHandleSha256: '5'.repeat(64) });
  const seatB = membershipRow({ membershipId: randomUUID(), agentId: 'b', bindingHandleSha256: '6'.repeat(64) });
  const asgMain = assignmentRow({
    assignmentId: 'asg-1',
    requestId: 'req-asg-1',
    ownerMembershipId: leadAb.membershipId,
    ownerAgentId: 'lead-ab',
    seats: [
      { agentId: 'a1', membershipId: seatA1.membershipId },
      { agentId: 'a', membershipId: seatA.membershipId },
      { agentId: 'ab', membershipId: seatAb.membershipId },
    ],
  });
  const asgAlt = assignmentRow({
    assignmentId: 'asg-1a',
    requestId: 'req-asg-2',
    ownerMembershipId: leadAb.membershipId,
    ownerAgentId: 'lead-ab',
    seats: [{ agentId: 'b', membershipId: seatB.membershipId }],
  });
  // The (ownerAgentId, requestId) bare-concat alias pair.
  const asgOwn1 = assignmentRow({
    assignmentId: 'asg-own-1',
    requestId: 'c',
    ownerMembershipId: leadAb.membershipId,
    ownerAgentId: 'lead-ab',
    seats: [],
  });
  const asgOwn2 = assignmentRow({
    assignmentId: 'asg-own-2',
    requestId: 'bc',
    ownerMembershipId: leadA.membershipId,
    ownerAgentId: 'lead-a',
    seats: [],
  });
  const hb = (over) => handbackRow({ claimedCandidateId: null, observed: { status: 'pending', candidateId: null, repository: '/repo', measuredAt: null, error: null }, ...over });
  const result = await seedTables(store, {
    memberships: [leadAb, leadA, seatA1, seatA, seatAb, seatB],
    assignments: [asgMain, asgAlt, asgOwn1, asgOwn2],
    handbacks: [
      // Digit-boundary stream alias: ("asg-1","a1",23) ~ ("asg-1","a",123)
      // → "asg-1a123" under bare concat; distinct revisions under JSON.
      hb({ handbackId: 'hb-d1', requestId: 'r-digit-1', assignmentId: 'asg-1', agentId: 'a1', seatMembershipId: seatA1.membershipId, revision: 23 }),
      hb({ handbackId: 'hb-d2', requestId: 'r-digit-2', assignmentId: 'asg-1', agentId: 'a', seatMembershipId: seatA.membershipId, revision: 123 }),
      // Split-boundary stream alias: ("asg-1","ab",1) ~ ("asg-1a","b",1)
      // → "asg-1ab1".
      hb({ handbackId: 'hb-s1', requestId: 'r-alpha-1', assignmentId: 'asg-1', agentId: 'ab', seatMembershipId: seatAb.membershipId, revision: 1 }),
      hb({ handbackId: 'hb-s2', requestId: 'r-alpha-2', assignmentId: 'asg-1a', agentId: 'b', seatMembershipId: seatB.membershipId, revision: 1 }),
      // Split-boundary submit-key alias: ("asg-1","a","bc1") ~
      // ("asg-1a","b","c1") → "asg-1abc1".
      hb({ handbackId: 'hb-k1', requestId: 'bc1', assignmentId: 'asg-1', agentId: 'a', seatMembershipId: seatA.membershipId, revision: 124 }),
      hb({ handbackId: 'hb-k2', requestId: 'c1', assignmentId: 'asg-1a', agentId: 'b', seatMembershipId: seatB.membershipId, revision: 2 }),
    ],
  });
  assert.equal(result.ok, true, `distinct tuples must not alias under any key: ${JSON.stringify(result)}`);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.handbacks.length, 6);
  assert.equal(read.ledger.assignments.length, 4);
});

test('refinement: bare-concat request-tuple aliases commit as distinct requests', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  // (actorKey, assignmentId, requestId) pairs that alias under bare
  // concat: ("a","bc","d") and ("ab","c","d") both flatten to "abcd".
  const first = await store.transact(REPO_KEY, envelope({ actorKey: 'a', assignmentId: 'bc', requestId: 'd' }), () => ({
    ok: true, events: [{ kind: 'test.seed', payload: { n: 1 } }],
  }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await store.transact(REPO_KEY, envelope({ actorKey: 'ab', assignmentId: 'c', requestId: 'd' }), () => ({
    ok: true, events: [{ kind: 'test.seed', payload: { n: 2 } }],
  }));
  assert.equal(second.ok, true, `a concat-aliased second request must commit: ${JSON.stringify(second)}`);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.requests.length, 2);
});
