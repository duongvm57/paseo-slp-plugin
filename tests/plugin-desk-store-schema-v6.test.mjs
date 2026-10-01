// tests/plugin-desk-store-schema-v6.test.mjs — P5 store-level coverage
// (contract R1 B1-B12 durable half): the additive v5→v6 migration, byte-
// preservation of pre-existing tables, the new decide →
// checkDefinitions/checkRuns/rollouts/rolloutTransitions channels and
// their fail-closed refinements (lineage, identity binding, legal edge
// walk, cohort digest recompute, check-gate discharge, retry streams,
// blocked-gap coupling). A synthetic decide drives the channels — command
// semantics live in tests/plugin-desk-rollout.test.mjs. Fixtures live
// under tmpdir().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeskStore, MIGRATIONS, repoKeyFor } from '../plugin/server/desk-store.ts';
import { canonicalJson, canonicalSha256, sha256Hex } from '../plugin/server/config-view.ts';

const REPO = { hostId: 'host-test', gitCommonDir: '/repo/.git' };
const REPO_KEY = repoKeyFor(REPO);
const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const COMMAND = { action: 'noop' };

const repoDir = root => join(root, 'state', 'enforcement', 'repos', REPO_KEY);
const ledgerPath = root => join(repoDir(root), 'ledger.json');
const eventsDir = root => join(repoDir(root), 'events');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-desk-v6-'));
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
    refs: [],
    ...over,
  };
}

function checkDefRow(over = {}) {
  return {
    checkId: 'check-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-chk-1',
    revision: 1,
    priorRevision: null,
    ownerMembershipId: 'LEAD_MID',
    ownerAgentId: 'agent-lead',
    assignmentRevision: 2,
    checkClass: 'repo-git-head',
    label: 'head pin check',
    definitionSha256: 'b'.repeat(64),
    limits: { timeoutMs: 5000, maxOutputBytes: 65536, maxRetries: 1 },
    requiredEvidence: [],
    refs: [],
    ...over,
  };
}

function checkRunRow(over = {}) {
  return {
    runId: 'run-1',
    assignmentId: 'asg-1',
    rolloutId: 'rollout-1',
    checkId: 'check-1',
    requestId: 'req-run-1',
    rolloutRevision: 1,
    definitionRevision: 1,
    definitionSha256: 'b'.repeat(64),
    candidateSnapshot: 'c'.repeat(64),
    candidateHead: 'a'.repeat(40),
    environment: { node: 'v99.0.0-test', platform: 'test-os' },
    status: 'passed',
    attempt: 1,
    retryOf: null,
    actorAgentId: 'agent-lead',
    actorSeatId: 'LEAD_MID',
    exitCode: 0,
    timedOut: false,
    durationMs: 12,
    outputSha256: 'f'.repeat(64),
    outputTail: 'ok',
    outputTruncated: false,
    outputPointer: null,
    evidenceRef: null,
    gap: null,
    ...over,
  };
}

function rolloutRow(over = {}) {
  return {
    rolloutId: 'rollout-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-rol-1',
    revision: 1,
    priorRevision: null,
    ownerMembershipId: 'LEAD_MID',
    ownerAgentId: 'agent-lead',
    assignmentRevision: 2,
    label: 'p5 rollout',
    declarationSha256: 'e'.repeat(64),
    candidateSnapshot: 'c'.repeat(64),
    candidateHead: 'a'.repeat(40),
    requiredChecks: [{ checkId: 'check-1', definitionDigest: 'b'.repeat(64) }],
    refs: [],
    ...over,
  };
}

const COHORT = (assignment, over = {}) => {
  const members = [assignment.ownerAgentId, ...assignment.seats.map(s => s.agentId)].sort();
  return {
    members,
    digest: sha256Hex(canonicalJson({ members, assignmentRevision: 2 })),
    assignmentRevision: 2,
    ...over,
  };
};

function rolloutTransitionRow(over = {}) {
  return {
    transitionId: 'rtn-1',
    assignmentId: 'asg-1',
    rolloutId: 'rollout-1',
    requestId: 'req-rtn-1',
    revision: 1,
    command: 'declare',
    from: null,
    to: 'declared',
    rolloutRevision: 1,
    actorAgentId: 'agent-lead',
    cohort: null,
    targetSnapshot: null,
    targetHead: null,
    evidenceRefs: [],
    dischargedChecks: [],
    dischargedReviews: [],
    cohortDigestAtGate: null,
    ...over,
  };
}

function scopeTransitionRow(over = {}) {
  return {
    transitionId: 'stn-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-stn-1',
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

function scopeReviewRow(over = {}) {
  return {
    reviewId: 'srv-1',
    assignmentId: 'asg-1',
    scopeId: 'scope-1',
    requestId: 'req-srv-1',
    revision: 1,
    scopeRevision: 1,
    candidateSnapshot: 'c'.repeat(64),
    axis: 'spec',
    verdict: 'approve',
    reviewerAgentId: 'agent-2',
    reviewerSeatId: randomUUID(),
    findingsRef: null,
    ...over,
  };
}

// A v5 fixture: the P4 shape — every pre-P5 field, no check/rollout tables.
function v5Ledger(over = {}) {
  return {
    format: 'paseo-slp/enforcement',
    schemaVersion: 5,
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
    scopes: [],
    scopeReviews: [],
    scopeTransitions: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Migration — additive v5→v6; old tables byte-preserved.
// ---------------------------------------------------------------------------

test('migration: a valid v5 ledger reads ok with persistedSchemaVersion 5 and empty P5 tables', t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const g = graph();
  const v5 = v5Ledger({
    memberships: [g.lead, g.seat],
    assignments: [g.assignment],
    candidates: [g.candidate],
    scopes: [g.scope],
  });
  writeFileSync(ledgerPath(dir), JSON.stringify(v5));
  const store = freshStore(dir);
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 5);
  assert.deepEqual(read.ledger.checkDefinitions, []);
  assert.deepEqual(read.ledger.checkRuns, []);
  assert.deepEqual(read.ledger.rollouts, []);
  assert.deepEqual(read.ledger.rolloutTransitions, []);
  assert.deepEqual(read.ledger.scopes, v5.scopes, 'P4 tables migrate verbatim');
  assert.equal(readFileSync(ledgerPath(dir), 'utf8'), JSON.stringify(v5), 'read never rewrites the file');
});

test('migration: the first commit on a v5 ledger writes v6 + schema-migrated, tables byte-preserved', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  const v5 = v5Ledger();
  writeFileSync(ledgerPath(dir), JSON.stringify(v5));
  const store = freshStore(dir);
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'post-bump' }), () => ({
    ok: true,
    events: [{ kind: 'test.event', payload: { v: 1 } }],
  }));
  assert.equal(result.ok, true);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 6);
  assert.deepEqual(onDisk.checkDefinitions, []);
  assert.deepEqual(onDisk.checkRuns, []);
  assert.deepEqual(onDisk.rollouts, []);
  assert.deepEqual(onDisk.rolloutTransitions, []);
  assert.deepEqual(onDisk.memberships, v5.memberships, 'memberships bytes preserved');
  const segment = readFileSync(join(eventsDir(dir), '1-2.jsonl'), 'utf8');
  const kinds = segment.trim().split('\n').map(line => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['schema-migrated', 'test.event']);
  const migrated = JSON.parse(segment.trim().split('\n')[0]);
  assert.deepEqual(migrated.payload, { from: 5, to: 6 });
});

test('migration: a rejection on a v5 ledger commits the v5 shape — the bump waits for success', async t => {
  const dir = fixture(t);
  mkdirSync(repoDir(dir), { recursive: true });
  writeFileSync(ledgerPath(dir), JSON.stringify(v5Ledger()));
  const store = freshStore(dir);
  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rej-1' }), () => ({
    ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required', recovery: 'change the command',
  }));
  assert.equal(rejected.ok, false);
  const onDisk = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(onDisk.schemaVersion, 5, 'a rejection never bumps the version');
  assert.equal(onDisk.checkDefinitions, undefined, 'no P5 fields on the v5 file');
  const ok = await store.transact(REPO_KEY, envelope({ requestId: 'ok-1' }), () => ({
    ok: true, events: [{ kind: 'test.event', payload: {} }],
  }));
  assert.equal(ok.ok, true);
  const migrated = JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.checkRuns, []);
});

test('migration: MIGRATIONS[5] is pure and total — input untouched, output adds the four tables', () => {
  const v5 = v5Ledger();
  const snapshot = JSON.stringify(v5);
  const migrated = MIGRATIONS[5](v5);
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(migrated.checkDefinitions, []);
  assert.deepEqual(migrated.checkRuns, []);
  assert.deepEqual(migrated.rollouts, []);
  assert.deepEqual(migrated.rolloutTransitions, []);
  assert.equal(JSON.stringify(v5), snapshot, 'the input object is never mutated');
});

// ---------------------------------------------------------------------------
// The decide → state channels — same schema+refinement gate as P4.
// ---------------------------------------------------------------------------

// Each seed gets its own requestId — a shared envelope would replay the
// first committed request row and never reach decide.
const seedTables = (store, tables) =>
  store.transact(REPO_KEY, envelope({ requestId: `seed-${randomUUID()}` }), () => ({ ok: true, events: [], ...tables }));

/** A minimal VALID P5 graph: lead owner + one attached seat + the bound
 *  seat's observed candidate + scope + check definition + rollout +
 *  opening edge + start-checks + a passed run + the discharging gate row. */
function graph() {
  const lead = membershipRow({ role: 'lead', agentId: 'agent-lead', bindingHandleSha256: 'd'.repeat(64) });
  const seat = membershipRow({ agentId: 'agent-1' });
  const assignment = assignmentRow({
    ownerMembershipId: lead.membershipId,
    ownerAgentId: 'agent-lead',
    seats: [{ agentId: seat.agentId, membershipId: seat.membershipId }],
  });
  const candidate = candidateRow({ seatMembershipId: seat.membershipId, seatAgentId: seat.agentId });
  const scope = scopeRow({ ownerMembershipId: lead.membershipId });
  const def = checkDefRow({ ownerMembershipId: lead.membershipId });
  const rollout = rolloutRow({ ownerMembershipId: lead.membershipId });
  const transitions = [
    rolloutTransitionRow({ transitionId: 'rtn-1', revision: 1 }),
    rolloutTransitionRow({
      transitionId: 'rtn-2', revision: 2, requestId: 'req-rtn-2',
      command: 'start-checks', from: 'declared', to: 'checks-running',
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-3', revision: 3, requestId: 'req-rtn-3',
      command: 'checks-passed', from: 'checks-running', to: 'checks-passed',
      dischargedChecks: [{ checkId: 'check-1', runId: 'run-1' }],
    }),
  ];
  const run = checkRunRow({ actorSeatId: lead.membershipId });
  return { lead, seat, assignment, candidate, scope, def, rollout, transitions, run };
}

const graphTables = g => ({
  memberships: [g.lead, g.seat],
  assignments: [g.assignment],
  candidates: [g.candidate],
  scopes: [g.scope],
  checkDefinitions: [g.def],
  rollouts: [g.rollout],
  checkRuns: [g.run],
  rolloutTransitions: g.transitions,
});

test('channel: a valid P5 graph commits and reads back', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const result = await seedTables(store, graphTables(g));
  assert.equal(result.ok, true, JSON.stringify(result));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.checkDefinitions.length, 1);
  assert.equal(read.ledger.checkRuns.length, 1);
  assert.equal(read.ledger.rollouts.length, 1);
  assert.equal(read.ledger.rolloutTransitions.length, 3);
});

test('channel: schema-invalid P5 tables reject INVALID_RECORD', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const badDef = { ...g.def, checkClass: 'arbitrary-shell' };
  const result = await seedTables(store, { ...graphTables(g), checkDefinitions: [badDef] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /invalid checkDefinitions/);
  const badRun = { ...g.run, status: 'mystery' };
  const result2 = await seedTables(store, { ...graphTables(g), checkRuns: [badRun] });
  assert.equal(result2.ok, false);
  assert.match(result2.message, /invalid checkRuns/);
  const badRollout = { ...g.rollout, requiredChecks: 'not-an-array' };
  const result3 = await seedTables(store, { ...graphTables(g), rollouts: [badRollout] });
  assert.equal(result3.ok, false);
  assert.match(result3.message, /invalid rollouts/);
  const badTr = { ...g.transitions[0], to: 'deployed' };
  const result4 = await seedTables(store, { ...graphTables(g), rolloutTransitions: [badTr] });
  assert.equal(result4.ok, false);
  assert.match(result4.message, /invalid rolloutTransitions/);
});

// ---------------------------------------------------------------------------
// Refinements — fail closed on every link.
// ---------------------------------------------------------------------------

test('refinement: a definition on a foreign assignment/scope or non-owner owner fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const foreign = { ...g.def, assignmentId: 'asg-ghost' };
  const result = await seedTables(store, { ...graphTables(g), checkDefinitions: [foreign] });
  assert.equal(result.ok, false);
  const wrongOwner = { ...g.def, ownerAgentId: 'agent-9' };
  const result2 = await seedTables(store, { ...graphTables(g), checkDefinitions: [wrongOwner] });
  assert.equal(result2.ok, false);
  const ghostScope = { ...g.def, scopeId: 'scope-ghost' };
  const result3 = await seedTables(store, { ...graphTables(g), checkDefinitions: [ghostScope] });
  assert.equal(result3.ok, false);
});

test('refinement: definition and rollout lineages must be contiguous 1..N', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const gap = { ...g.def, requestId: 'req-chk-9', revision: 3, priorRevision: 2 };
  const result = await seedTables(store, { ...graphTables(g), checkDefinitions: [g.def, gap] });
  assert.equal(result.ok, false, 'definition revision 3 without revision 2 is corruption');
  const rolGap = { ...g.rollout, requestId: 'req-rol-9', revision: 2, priorRevision: null };
  const result2 = await seedTables(store, { ...graphTables(g), rollouts: [g.rollout, rolGap] });
  assert.equal(result2.ok, false, 'rollout revision 2 must name priorRevision 1');
  // Contiguous revisions but a forged priorRevision link — only the
  // immediate-parent check catches this; the size check alone passes.
  const forged = { ...g.def, requestId: 'req-chk-9', revision: 2, priorRevision: null };
  const result3 = await seedTables(store, { ...graphTables(g), checkDefinitions: [g.def, forged] });
  assert.equal(result3.ok, false, 'revision 2 must chain priorRevision 1 — contiguity is not lineage');
});

test('refinement: a rollout pinned to a phantom candidate or phantom check digest fails closed', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const ghostCand = { ...g.rollout, candidateSnapshot: '9'.repeat(64) };
  const result = await seedTables(store, { ...graphTables(g), rollouts: [ghostCand] });
  assert.equal(result.ok, false);
  const badDigest = { ...g.rollout, requiredChecks: [{ checkId: 'check-1', definitionDigest: '7'.repeat(64) }] };
  const result2 = await seedTables(store, { ...graphTables(g), rollouts: [badDigest] });
  assert.equal(result2.ok, false, 'a required pin must resolve to a definition row at that digest');
  // A required check living on a different scope never resolves — even
  // with a correct digest.
  const scope2 = { ...g.scope, scopeId: 'scope-2', requestId: 'req-scp-2' };
  const defOtherScope = { ...g.def, checkId: 'check-9', scopeId: 'scope-2', requestId: 'req-chk-9' };
  const wrongScope = { ...g.rollout, requiredChecks: [{ checkId: 'check-9', definitionDigest: 'b'.repeat(64) }] };
  const result3 = await seedTables(store, {
    ...graphTables(g),
    scopes: [g.scope, scope2],
    checkDefinitions: [g.def, defOtherScope],
    rollouts: [wrongScope],
  });
  assert.equal(result3.ok, false, 'a required check on another scope never resolves');
});

test('refinement: a run bound to a mismatched definition digest or rollout pin is corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const badDigest = { ...g.run, definitionSha256: '7'.repeat(64) };
  const result = await seedTables(store, { ...graphTables(g), checkRuns: [badDigest] });
  assert.equal(result.ok, false, 'run digest must match the pinned definition row');
  const badCandidate = { ...g.run, candidateSnapshot: '8'.repeat(64) };
  const result2 = await seedTables(store, { ...graphTables(g), checkRuns: [badCandidate] });
  assert.equal(result2.ok, false, 'run candidate must equal the pinned declaration revision');
  const foreignActor = { ...g.run, actorAgentId: 'agent-1' };
  const result3 = await seedTables(store, { ...graphTables(g), checkRuns: [foreignActor] });
  assert.equal(result3.ok, false, 'runs are owner-authored only');
});

test('refinement: a blocked run must carry its gap record; a passed run may not', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const unblocked = { ...g.run, gap: { capability: 'repo-checkout', detail: 'missing' } };
  const result = await seedTables(store, { ...graphTables(g), checkRuns: [unblocked] });
  assert.equal(result.ok, false, 'only a blocked run carries a gap');
  const bareBlocked = {
    ...g.run,
    status: 'blocked',
    exitCode: null,
    durationMs: null,
    outputSha256: null,
    outputTail: null,
    gap: null,
  };
  const result2 = await seedTables(store, { ...graphTables(g), checkRuns: [bareBlocked] });
  assert.equal(result2.ok, false, 'blocked without a gap record is corrupt');
  const executedBlocked = { ...bareBlocked, gap: { capability: 'x', detail: 'y' }, exitCode: 1 };
  const result3 = await seedTables(store, { ...graphTables(g), checkRuns: [executedBlocked] });
  assert.equal(result3.ok, false, 'a blocked run never executed — no exit fields');
});

test('refinement: retry streams are contiguous, chained and capped by the definition', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // A third attempt exceeds maxRetries 1.
  const third = checkRunRow({
    runId: 'run-3', requestId: 'req-run-3', attempt: 3, retryOf: 'run-2', status: 'failed',
  });
  const second = checkRunRow({
    runId: 'run-2', requestId: 'req-run-2', attempt: 2, retryOf: 'run-1', status: 'failed',
  });
  const result = await seedTables(store, { ...graphTables(g), checkRuns: [g.run, second, third] });
  assert.equal(result.ok, false, 'maxRetries 1 allows two attempts, never three');
  // A retry naming a phantom predecessor.
  const orphan = checkRunRow({ runId: 'run-2', requestId: 'req-run-2', attempt: 2, retryOf: 'run-ghost', status: 'failed' });
  const result2 = await seedTables(store, { ...graphTables(g), checkRuns: [g.run, orphan] });
  assert.equal(result2.ok, false, 'attempt 2 must chain attempt 1 by runId');
  // A stream mixing pinned definitions is corrupt.
  const mixed = checkRunRow({ runId: 'run-2', requestId: 'req-run-2', attempt: 2, retryOf: 'run-1', status: 'failed', definitionRevision: 9, definitionSha256: 'b'.repeat(64) });
  const result3 = await seedTables(store, { ...graphTables(g), checkRuns: [g.run, mixed] });
  assert.equal(result3.ok, false, 'a stream runs one definition revision');
});

test('refinement: the rollout walk follows ROLLOUT_TRANSITIONS — illegal hops and drifted `to` are corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const illegal = rolloutTransitionRow({
    transitionId: 'rtn-9', revision: 4, requestId: 'req-rtn-9',
    command: 'promote', from: 'checks-passed', to: 'promoted',
  });
  const result = await seedTables(store, { ...graphTables(g), rolloutTransitions: [...g.transitions, illegal] });
  assert.equal(result.ok, false, 'checks-passed → promote is not an edge');
  const drifted = rolloutTransitionRow({
    transitionId: 'rtn-2', revision: 2, requestId: 'req-rtn-2',
    command: 'start-checks', from: 'declared', to: 'promoted',
  });
  const result2 = await seedTables(store, {
    ...graphTables(g),
    rolloutTransitions: [g.transitions[0], drifted],
  });
  assert.equal(result2.ok, false, 'the edge table owns the target state');
  const dupRequest = rolloutTransitionRow({
    transitionId: 'rtn-9', revision: 4, requestId: 'req-rtn-2',
    command: 'checks-failed', from: 'checks-running', to: 'checks-failed',
  });
  const result3 = await seedTables(store, {
    ...graphTables(g),
    rolloutTransitions: [g.transitions[0], g.transitions[1], dupRequest],
  });
  assert.equal(result3.ok, false, 'two transitions share (assignmentId, actorAgentId, requestId)');
});

test('refinement: cohort and target fields ride exactly their commands', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // cohort on a non-start-canary row.
  const stray = rolloutTransitionRow({
    transitionId: 'rtn-9', revision: 4, requestId: 'req-rtn-9',
    command: 'canary-ready', from: 'checks-passed', to: 'canary-ready',
    cohort: COHORT(g.assignment),
  });
  const result = await seedTables(store, { ...graphTables(g), rolloutTransitions: [...g.transitions, stray] });
  assert.equal(result.ok, false, 'a stray cohort payload is corruption');
  // start-canary without a cohort.
  const bare = rolloutTransitionRow({
    transitionId: 'rtn-9', revision: 4, requestId: 'req-rtn-9',
    command: 'start-canary', from: 'canary-ready', to: 'canary-running',
    cohort: null,
  });
  const withReady = [...g.transitions, rolloutTransitionRow({
    transitionId: 'rtn-4', revision: 4, requestId: 'req-rtn-4',
    command: 'canary-ready', from: 'checks-passed', to: 'canary-ready',
  })];
  const result2 = await seedTables(store, { ...graphTables(g), rolloutTransitions: [...withReady, { ...bare, revision: 5 }] });
  assert.equal(result2.ok, false, 'start-canary must pin the cohort');
  // A forged roster digest.
  const forged = rolloutTransitionRow({
    transitionId: 'rtn-5', revision: 5, requestId: 'req-rtn-5',
    command: 'start-canary', from: 'canary-ready', to: 'canary-running',
    cohort: { members: ['agent-1'], digest: '0'.repeat(64), assignmentRevision: 2 },
  });
  const result3 = await seedTables(store, { ...graphTables(g), rolloutTransitions: [...withReady, forged] });
  assert.equal(result3.ok, false, 'the cohort digest recomputes — a forged roster is corrupt');
  // A cohort member outside the assignment roster.
  const outsideCohort = COHORT(g.assignment, { members: ['agent-1', 'agent-lead', 'agent-9'].sort() });
  outsideCohort.digest = sha256Hex(canonicalJson({ members: outsideCohort.members, assignmentRevision: 2 }));
  const outsider = rolloutTransitionRow({
    transitionId: 'rtn-5', revision: 5, requestId: 'req-rtn-5',
    command: 'start-canary', from: 'canary-ready', to: 'canary-running',
    cohort: outsideCohort,
  });
  const result4 = await seedTables(store, { ...graphTables(g), rolloutTransitions: [...withReady, outsider] });
  assert.equal(result4.ok, false, 'cohort members must be the assignment roster');
  // rollback target must resolve.
  const ghostTarget = rolloutTransitionRow({
    transitionId: 'rtn-9', revision: 4, requestId: 'req-rtn-9',
    command: 'rollback', from: 'checks-passed', to: 'rolled-back',
    targetSnapshot: '9'.repeat(64), targetHead: null,
  });
  const result5 = await seedTables(store, { ...graphTables(g), rolloutTransitions: [...g.transitions, ghostTarget] });
  assert.equal(result5.ok, false, 'rollback pins an observed candidate, never a claimed hash');
});

test('refinement: a check-gated transition must discharge real passed runs bound to the pins', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  // Phantom runId.
  const badGate = { ...g.transitions[2], dischargedChecks: [{ checkId: 'check-1', runId: 'run-ghost' }] };
  const result = await seedTables(store, { ...graphTables(g), rolloutTransitions: [g.transitions[0], g.transitions[1], badGate] });
  assert.equal(result.ok, false, 'a discharge must name a real run');
  // Empty discharge on a gated command.
  const bareGate = { ...g.transitions[2], dischargedChecks: [] };
  const result2 = await seedTables(store, { ...graphTables(g), rolloutTransitions: [g.transitions[0], g.transitions[1], bareGate] });
  assert.equal(result2.ok, false, 'every required check must be discharged');
  // A failed run never discharges.
  const failedRun = { ...g.run, status: 'failed' };
  const result3 = await seedTables(store, { ...graphTables(g), checkRuns: [failedRun] });
  assert.equal(result3.ok, false, 'a failed run cannot discharge the gate');
  // An ungated command carrying discharge evidence.
  const stray = { ...g.transitions[1], dischargedChecks: [{ checkId: 'check-1', runId: 'run-1' }] };
  const result4 = await seedTables(store, { ...graphTables(g), rolloutTransitions: [g.transitions[0], stray] });
  assert.equal(result4.ok, false, 'only check-gated transitions carry discharge evidence');
});

test('refinement: a cohort-gated transition records the pinned digest at gate time', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = graph();
  const ready = rolloutTransitionRow({
    transitionId: 'rtn-4', revision: 4, requestId: 'req-rtn-4',
    command: 'canary-ready', from: 'checks-passed', to: 'canary-ready',
  });
  const cohort = COHORT(g.assignment);
  const canary = rolloutTransitionRow({
    transitionId: 'rtn-5', revision: 5, requestId: 'req-rtn-5',
    command: 'start-canary', from: 'canary-ready', to: 'canary-running',
    cohort,
  });
  const passed = rolloutTransitionRow({
    transitionId: 'rtn-6', revision: 6, requestId: 'req-rtn-6',
    command: 'canary-passed', from: 'canary-running', to: 'canary-passed',
    cohortDigestAtGate: cohort.digest,
  });
  const valid = await seedTables(store, { ...graphTables(g), rolloutTransitions: [...g.transitions, ready, canary, passed] });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  // A gate digest that disagrees with the pinned cohort is corruption —
  // the decide would have rejected, and a forged commit cannot replay.
  const drifted = { ...passed, cohortDigestAtGate: '0'.repeat(64) };
  const result = await seedTables(store, { ...graphTables(g), rolloutTransitions: [...g.transitions, ready, canary, drifted] });
  assert.equal(result.ok, false, 'the gate digest must equal the pinned cohort digest');
  // A cohort-gated row without the recorded digest.
  const bare = { ...passed, cohortDigestAtGate: null };
  const result2 = await seedTables(store, { ...graphTables(g), rolloutTransitions: [...g.transitions, ready, canary, bare] });
  assert.equal(result2.ok, false, 'a cohort-gated commit must record what it observed');
});

/** A promote-ready graph: a reviewer seat joins the roster, the scope's
 *  review round stands approved on the rollout's exact candidate pin, and
 *  the transition stream walks to `promote` carrying every discharge the
 *  decide would have recorded. */
function promoteGraph() {
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
  const scope = scopeRow({ ownerMembershipId: lead.membershipId });
  const def = checkDefRow({ ownerMembershipId: lead.membershipId });
  const rollout = rolloutRow({ ownerMembershipId: lead.membershipId });
  const reviews = [
    scopeReviewRow({ reviewerSeatId: reviewer.membershipId }),
    scopeReviewRow({ reviewId: 'srv-2', requestId: 'req-srv-2', axis: 'standards', reviewerSeatId: reviewer.membershipId }),
  ];
  const scopeTransitions = [
    scopeTransitionRow({ transitionId: 'stn-1', revision: 1 }),
    scopeTransitionRow({
      transitionId: 'stn-2', revision: 2, requestId: 'req-stn-2',
      command: 'claim', from: 'declared', to: 'claimed',
    }),
    scopeTransitionRow({
      transitionId: 'stn-3', revision: 3, requestId: 'req-stn-3',
      command: 'submit-for-review', from: 'claimed', to: 'submitted-for-review',
      candidateSnapshot: 'c'.repeat(64), candidateHead: 'a'.repeat(40),
    }),
    scopeTransitionRow({
      transitionId: 'stn-4', revision: 4, requestId: 'req-stn-4',
      command: 'review-observed', from: 'submitted-for-review', to: 'review-observed',
      discharged: [{ axis: 'spec', reviewId: 'srv-1' }, { axis: 'standards', reviewId: 'srv-2' }],
    }),
    scopeTransitionRow({
      transitionId: 'stn-5', revision: 5, requestId: 'req-stn-5',
      command: 'approve', from: 'review-observed', to: 'approved',
    }),
  ];
  const cohort = COHORT(assignment);
  const transitions = [
    rolloutTransitionRow({ transitionId: 'rtn-1', revision: 1 }),
    rolloutTransitionRow({
      transitionId: 'rtn-2', revision: 2, requestId: 'req-rtn-2',
      command: 'start-checks', from: 'declared', to: 'checks-running',
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-3', revision: 3, requestId: 'req-rtn-3',
      command: 'checks-passed', from: 'checks-running', to: 'checks-passed',
      dischargedChecks: [{ checkId: 'check-1', runId: 'run-1' }],
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-4', revision: 4, requestId: 'req-rtn-4',
      command: 'canary-ready', from: 'checks-passed', to: 'canary-ready',
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-5', revision: 5, requestId: 'req-rtn-5',
      command: 'start-canary', from: 'canary-ready', to: 'canary-running', cohort,
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-6', revision: 6, requestId: 'req-rtn-6',
      command: 'canary-passed', from: 'canary-running', to: 'canary-passed',
      cohortDigestAtGate: cohort.digest,
    }),
    rolloutTransitionRow({
      transitionId: 'rtn-7', revision: 7, requestId: 'req-rtn-7',
      command: 'promote', from: 'canary-passed', to: 'promoted',
      dischargedChecks: [{ checkId: 'check-1', runId: 'run-1' }],
      dischargedReviews: [{ axis: 'spec', reviewId: 'srv-1' }, { axis: 'standards', reviewId: 'srv-2' }],
      cohortDigestAtGate: cohort.digest,
    }),
  ];
  const run = checkRunRow({ actorSeatId: lead.membershipId });
  return { lead, seat, reviewer, assignment, candidate, scope, def, rollout, transitions, reviews, scopeTransitions, run };
}

const promoteTables = g => ({
  memberships: [g.lead, g.seat, g.reviewer],
  assignments: [g.assignment],
  candidates: [g.candidate],
  scopes: [g.scope],
  scopeTransitions: g.scopeTransitions,
  scopeReviews: g.reviews,
  checkDefinitions: [g.def],
  rollouts: [g.rollout],
  checkRuns: [g.run],
  rolloutTransitions: g.transitions,
});

test('channel: a fully-gated promote graph commits and reads back', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = promoteGraph();
  const result = await seedTables(store, promoteTables(g));
  assert.equal(result.ok, true, JSON.stringify(result));
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.rolloutTransitions.length, 7);
});

test('refinement: a promote row carries exactly the approved round\'s discharge — forged, missing, extra or mismatched evidence is corruption', async t => {
  const dir = fixture(t);
  const store = freshStore(dir);
  const g = promoteGraph();
  const promote = g.transitions[6];
  // A forged reviewId resolves to nothing.
  const forged = { ...promote, dischargedReviews: [{ axis: 'spec', reviewId: 'srv-ghost' }, { axis: 'standards', reviewId: 'srv-2' }] };
  const result = await seedTables(store, { ...promoteTables(g), rolloutTransitions: [...g.transitions.slice(0, 6), forged] });
  assert.equal(result.ok, false, 'a discharge must name a durable review row');
  // A missing axis leaves the round under-discharged.
  const missing = { ...promote, dischargedReviews: [{ axis: 'spec', reviewId: 'srv-1' }] };
  const result2 = await seedTables(store, { ...promoteTables(g), rolloutTransitions: [...g.transitions.slice(0, 6), missing] });
  assert.equal(result2.ok, false, 'every required axis must be discharged once');
  // An extra discharge row — a duplicated axis — never shrinks or pads the set.
  const extra = { ...promote, dischargedReviews: [...promote.dischargedReviews, { axis: 'spec', reviewId: 'srv-2' }] };
  const result3 = await seedTables(store, { ...promoteTables(g), rolloutTransitions: [...g.transitions.slice(0, 6), extra] });
  assert.equal(result3.ok, false, 'an axis discharges at most once');
  // A real review row bound to a different candidate than the rollout pin.
  const foreign = scopeReviewRow({ reviewId: 'srv-9', requestId: 'req-srv-9', axis: 'standards', candidateSnapshot: '9'.repeat(64), reviewerSeatId: g.reviewer.membershipId });
  const wrongPin = { ...promote, dischargedReviews: [{ axis: 'spec', reviewId: 'srv-1' }, { axis: 'standards', reviewId: 'srv-9' }] };
  const result4 = await seedTables(store, {
    ...promoteTables(g),
    scopeReviews: [...g.reviews, foreign],
    rolloutTransitions: [...g.transitions.slice(0, 6), wrongPin],
  });
  assert.equal(result4.ok, false, 'the review must bind the promoted candidate');
  // No approved round at all — the discharge evidence is unanchored.
  const unanchored = promoteTables(g);
  unanchored.scopeTransitions = g.scopeTransitions.slice(0, 4);
  const result5 = await seedTables(store, unanchored);
  assert.equal(result5.ok, false, 'no approve edge consumed this discharge set');
  // Review evidence on a non-gated transition.
  const stray = { ...g.transitions[1], dischargedReviews: [{ axis: 'spec', reviewId: 'srv-1' }] };
  const result6 = await seedTables(store, { ...promoteTables(g), rolloutTransitions: [g.transitions[0], stray, ...g.transitions.slice(2)] });
  assert.equal(result6.ok, false, 'only review-gated transitions carry review evidence');
});
