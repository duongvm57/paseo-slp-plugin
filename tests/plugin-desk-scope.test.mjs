// tests/plugin-desk-scope.test.mjs — P4 scope machinery coverage over the
// real socket (contract R2, B1-B12): assignment-bound declarations, the
// shared state-machine seam, the server-derived required-review gate,
// reviewer/candidate/axis binding, self-review prohibition, idempotent
// replay, scoped status projection and the schema-v5 tables. Socket-level:
// every call goes through handshake + tools/call like the settlement
// suite. Fixtures live under tmpdir().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bridgeFixture as deskBridgeFixture,
  gitRepo as deskGitRepo,
  startBridge,
  memberRow as deskMemberRow,
  repoOf,
  seedMemberships,
  seedStore,
  hello,
  handshake,
  rpc,
  BIN_SOURCE,
} from './helpers/desk-bridge-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { deskRepoPaths } from '../plugin/server/desk-store.ts';
import { sha256Hex } from '../plugin/server/config-view.ts';
import { approvedScopeRound, runScopeDeclare } from '../plugin/server/desk-scope.ts';
import {
  DeskAssignmentResult,
  DeskScopeDeclareResult,
  DeskScopeTransitionResult,
  DeskSeatStatus,
  DeskReviewPlan,
  WIRE_LIMITS,
} from '../plugin/shared/enforcement.ts';

// Bind the real fixture binary; startup also verifies its bytes.
const PIN = sha256Hex(readFileSync(BIN_SOURCE));
const PROVIDER = 'slp-codex-peer';
const FIXED_AT = '2026-01-02T00:00:00.000Z';
const CAPTURED_AT = '2026-01-02T00:00:01.000Z';
const CAPTURED_SNAP = 'c'.repeat(64);
const CAPTURED_HEAD = 'd'.repeat(40);
const DECL_SHA = 'e'.repeat(64);

const gitRepo = t => deskGitRepo(t, 'slp-scope-repo-');

const captureOk = async ({ repository }) => ({
  status: 'ok',
  repository,
  measuredAt: CAPTURED_AT,
  snapshotSha256: CAPTURED_SNAP,
  head: CAPTURED_HEAD,
  incomplete: [],
});

function bridgeFixture(t, over = {}) {
  return deskBridgeFixture(t, 'slp-scope-home-', PIN, {
    ...over,
    capture: over.capture ?? captureOk,
  });
}

async function started(t, over = {}) {
  const f = await startBridge(t, bridgeFixture(t, over));
  assert.equal(f.outcome, 'listening');
  return f;
}

const memberRow = (handle, over = {}) =>
  deskMemberRow(handle, { provider: PROVIDER, at: FIXED_AT }, over);

const HELLO = (handle, over = {}) => hello(PIN, handle, over);

let rpcSeq = 0;
async function call(reader, conn, name, args) {
  rpcSeq += 1;
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: `scp-${rpcSeq}`,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const body = JSON.parse(reply.result.content[0].text);
  return { isError: reply.result.isError === true, body };
}

const livePaseo = agent => ({ agents: { ref: () => ({ refresh: async () => ({ agent }) }) } });
const LIVE_AGENT = { provider: PROVIDER, workspaceId: 'wks-1', archivedAt: null };

/** One desk: a lead seat plus two peer seats, all bound over the socket. */
async function boundTrio(t, over = {}) {
  const paseoRef = { current: livePaseo(over.agent ?? LIVE_AGENT) };
  const f = await started(t, { ...over, paseoRef });
  f.bridge.noteDispatch(f.paseoRef.current);
  const git = over.git ?? gitRepo(t);
  const lead = memberRow('lead-handle', { role: 'lead', agentId: 'agent-lead' });
  const peer = memberRow('peer-handle', { role: 'peer', agentId: 'agent-1' });
  const peer2 = memberRow('peer2-handle', { role: 'peer', agentId: 'agent-2' });
  const repoKey = await seedMemberships(seedStore(f), repoOf(git), [lead, peer, peer2]);
  const leadConn = await handshake(f.paths.socketPath, HELLO('lead-handle'));
  const peerConn = await handshake(f.paths.socketPath, HELLO('peer-handle'));
  const peer2Conn = await handshake(f.paths.socketPath, HELLO('peer2-handle'));
  t.after(() => { leadConn.conn.destroy(); peerConn.conn.destroy(); peer2Conn.conn.destroy(); });
  assert.equal(leadConn.ack.ok, true, `lead hello rejected: ${JSON.stringify(leadConn.ack)}`);
  assert.equal(peerConn.ack.ok, true, `peer hello rejected: ${JSON.stringify(peerConn.ack)}`);
  assert.equal(peer2Conn.ack.ok, true, `peer2 hello rejected: ${JSON.stringify(peer2Conn.ack)}`);
  return { f, git, repo: repoOf(git), repoKey, lead, peer, peer2, leadConn, peerConn, peer2Conn, paseoRef };
}

/** Register an assignment and attach both peers; returns assignmentId. */
async function registerPair(t, { leadConn }, seats = ['agent-1', 'agent-2']) {
  const reg = await call(leadConn.reader, leadConn.conn, 'slp_assignment_register', {
    requestId: `reg-${randomUUID()}`,
    authorityRef: 'grant:test',
    objective: 'bounded task',
  });
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  const { assignmentId } = DeskAssignmentResult.parse(reg.body);
  for (const agentId of seats) {
    const att = await call(leadConn.reader, leadConn.conn, 'slp_assignment_attach', {
      requestId: `att-${randomUUID()}`,
      assignmentId,
      agentId,
    });
    assert.equal(att.body.ok, true, JSON.stringify(att.body));
  }
  return assignmentId;
}

const goodRecord = (over = {}) => ({
  version: 1,
  kind: 'handback',
  seat: { role: 'peer', disposition: 'engineer', agentId: 'agent-1' },
  verdict: 'APPROVE',
  candidate: { repository: '/repo', snapshotSha256: CAPTURED_SNAP },
  checks: [{ cmd: 'npm test', exit: 0, sha: sha256Hex('ok\n'), output: 'ok\n' }],
  ...over,
});

/** Submit one handback so a durable observed candidate exists for
 *  seatAgentId; returns the ledger candidate row's snapshotSha256. */
async function observeCandidate(t, ctx, { peerConn, assignmentId, agentId }) {
  const reply = await call(peerConn.reader, peerConn.conn, 'slp_handback_submit', {
    requestId: `hb-${randomUUID()}`,
    assignmentId,
    recordV1: goodRecord({ seat: { role: 'peer', disposition: 'engineer', agentId } }),
    candidateId: null,
  });
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const candidate = ledger.candidates.find(c => c.assignmentId === assignmentId && c.seatAgentId === agentId);
  assert.ok(candidate, 'the observe commit must land a candidate row');
  return candidate.snapshotSha256;
}

const declareArgs = (over = {}) => ({
  requestId: `dcl-${randomUUID()}`,
  assignmentId: 'ASG',
  scopeId: 'scope-1',
  label: 'p4 bounded slice',
  declarationSha256: DECL_SHA,
  refs: ['note:plan'],
  seatAgentId: 'agent-1',
  // Explicit compatibility opt-in for historical two-axis fixtures.
  reviewPlan: null,
  ...over,
});

const transitionArgs = (over = {}) => ({
  requestId: `trn-${randomUUID()}`,
  assignmentId: 'ASG',
  scopeId: 'scope-1',
  transition: 'claim',
  scopeRevision: 1,
  candidateSnapshot: null,
  candidateHead: null,
  ...over,
});

const reviewArgs = (over = {}) => ({
  requestId: `rev-${randomUUID()}`,
  assignmentId: 'ASG',
  scopeId: 'scope-1',
  scopeRevision: 1,
  candidateSnapshot: CAPTURED_SNAP,
  axis: 'spec',
  verdict: 'approve',
  findingsRef: null,
  ...over,
});

const ledgerOf = (f, repoKey) => {
  const read = seedStore(f).read(repoKey);
  assert.equal(read.state, 'ok');
  return read.ledger;
};

const briefBody = objective => ({
  objective,
  acceptanceCriteria: ['the pinned scope completes its declared work'],
  constraints: [],
  provisionalDesign: 'No design is prescribed; the owner records the implementation choice after inspection.',
  assumptions: [],
  unknowns: [],
  requiredEvidence: [],
  ownedSurfaces: [],
  excludedSurfaces: [],
  dependencies: [],
  notifications: [],
});

async function amendBrief(ctx, expectedBriefRevision, objective) {
  return call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_amend', {
    requestId: `brief-${randomUUID()}`,
    assignmentId: ctx.assignmentId,
    expectedBriefRevision,
    brief: briefBody(objective),
    changeReason: `Clarify the operative outcome at revision ${expectedBriefRevision + 1}.`,
    authorityRef: 'grant:brief-test',
    affectedOwners: ['agent-lead', 'agent-1'],
  });
}

/** declare scope-1 bound to agent-1 — the fixture most tests extend. */
async function declared(t, ctx) {
  const c = ctx ?? await boundTrio(t);
  const assignmentId = await registerPair(t, c);
  const d = await call(c.leadConn.reader, c.leadConn.conn, 'slp_scope_declare', declareArgs({ assignmentId }));
  assert.equal(d.body.ok, true, JSON.stringify(d.body));
  return { ...c, assignmentId };
}

/** declared + claim + an observed candidate + submit — an open round. */
async function roundOpen(t, ctx) {
  const base = await declared(t, ctx);
  const snapshot = await observeCandidate(t, base, { peerConn: base.peerConn, assignmentId: base.assignmentId, agentId: 'agent-1' });
  const claim = await call(base.leadConn.reader, base.leadConn.conn, 'slp_scope_transition', transitionArgs({ assignmentId: base.assignmentId }));
  assert.equal(claim.body.ok, true, JSON.stringify(claim.body));
  const sub = await call(base.leadConn.reader, base.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: base.assignmentId,
    transition: 'submit-for-review',
    candidateSnapshot: snapshot,
    candidateHead: CAPTURED_HEAD,
  }));
  assert.equal(sub.body.ok, true, JSON.stringify(sub.body));
  return { ...base, snapshot };
}

const review = (ctx, peer, args) =>
  call(peer.reader, peer.conn, 'slp_scope_review', args);

// ---------------------------------------------------------------------------
// B1 — assignment-bound declaration: the durable row pins
// (assignmentId, scopeId, ownerAgentId, assignmentRevision) server-side;
// the caller never names the owner.
// ---------------------------------------------------------------------------

test('B1: slp_scope_declare binds (assignmentId, scopeId, ownerAgentId, assignmentRevision) durably', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({ assignmentId }));
  assert.equal(reply.isError, false);
  const body = DeskScopeDeclareResult.parse(reply.body);
  assert.equal(body.scopeId, 'scope-1');
  assert.equal(body.revision, 1);

  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const row = ledger.scopes.find(s => s.assignmentId === assignmentId && s.scopeId === 'scope-1');
  assert.ok(row, 'the declaration row is durable');
  assert.equal(row.ownerAgentId, 'agent-lead', 'owner derived from the bound membership, never the caller');
  assert.equal(row.revision, 1);
  assert.equal(row.priorRevision, null);
  // (declared with zero seats)=1, attach agent-1 →2, attach agent-2 →3.
  assert.equal(row.assignmentRevision, 3, 'the declare pins the assignment structural revision at declare time');
  assert.equal(row.seatAgentId, 'agent-1');
  assert.equal(row.declarationSha256, DECL_SHA);
  assert.deepEqual(row.refs, ['note:plan'], 'claimed refs are stored as provenance only');
  // The stream opens with the (none → declared) edge — one row, revision 1.
  const tr = ledger.scopeTransitions.filter(x => x.assignmentId === assignmentId && x.scopeId === 'scope-1');
  assert.equal(tr.length, 1);
  assert.equal(tr[0].command, 'declare');
  assert.equal(tr[0].from, null);
  assert.equal(tr[0].to, 'declared');
  assert.equal(tr[0].actorAgentId, 'agent-lead');
});

test('B1: a peer or foreign lead cannot declare — owner identity is server-derived', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  const asPeer = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_scope_declare', declareArgs({ assignmentId }));
  assert.equal(asPeer.body.code, 'AUTHORITY_REQUIRED', JSON.stringify(asPeer.body));
  // A second lead that never registered the assignment is still a foreign owner.
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const lead2 = memberRow('lead2-handle', { role: 'lead', agentId: 'agent-lead-2' });
  await seedMemberships(seedStore(ctx.f), ctx.repo, [...ledger.memberships, lead2]);
  const lead2Conn = await handshake(ctx.f.paths.socketPath, HELLO('lead2-handle'));
  t.after(() => lead2Conn.conn.destroy());
  const asForeignLead = await call(lead2Conn.reader, lead2Conn.conn, 'slp_scope_declare', declareArgs({ assignmentId }));
  assert.equal(asForeignLead.body.code, 'AUTHORITY_REQUIRED');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopes.length, 0, 'no declaration lands durable');
});

test('B1: declaration rejects a seat that is not attached, and a closed assignment', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx, ['agent-1']);
  const badSeat = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({ assignmentId, seatAgentId: 'agent-2' }));
  assert.equal(badSeat.body.code, 'INVALID_RECORD');
  const close = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_close', {
    requestId: `cls-${randomUUID()}`,
    assignmentId,
  });
  assert.equal(close.body.ok, true);
  const closed = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({ assignmentId }));
  assert.equal(closed.body.code, 'SCOPE_CONFLICT');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopes.length, 0);
});

// ---------------------------------------------------------------------------
// B2 — immutable declaration revisions: redeclare appends rev 2 with
// explicit lineage; rev 1 is never edited; assignmentRevision tracks the
// assignment's structural revision at each declare.
// ---------------------------------------------------------------------------

test('B2: redeclare appends an immutable revision — rev 1 byte-identical, rev 2 chains priorRevision', async t => {
  const ctx = await declared(t);
  const before = ledgerOf(ctx.f, ctx.repoKey).scopes[0];
  const snapshot = JSON.stringify(before);
  const second = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId,
    requestId: `dcl-${randomUUID()}`,
    label: 'p4 bounded slice — amended',
    declarationSha256: '9'.repeat(64),
  }));
  assert.equal(second.body.ok, true, JSON.stringify(second.body));
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const stream = ledger.scopes.filter(s => s.assignmentId === ctx.assignmentId && s.scopeId === 'scope-1');
  assert.equal(stream.length, 2);
  assert.deepEqual(JSON.stringify(stream[0]), snapshot, 'rev 1 is immutable');
  assert.equal(stream[1].revision, 2);
  assert.equal(stream[1].priorRevision, 1);
  assert.equal(stream[1].label, 'p4 bounded slice — amended');
  assert.equal(stream[1].assignmentRevision, 3);
  // Amendments never emit transitions — the machine state stays put.
  assert.equal(ledger.scopeTransitions.length, 1);
});

// ---------------------------------------------------------------------------
// B3 — the state machine: only SCOPE_TRANSITIONS edges commit; every other
// move is a typed SCOPE_CONFLICT and lands nothing.
// ---------------------------------------------------------------------------

test('B3: the full legal walk commits — declare→claim→submit→review-observed→approve→advance→submit', async t => {
  const ctx = await roundOpen(t);
  const spec = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, axis: 'spec' }));
  assert.equal(spec.body.ok, true, JSON.stringify(spec.body));
  const std = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, axis: 'standards', requestId: `rev-${randomUUID()}` }));
  assert.equal(std.body.ok, true, JSON.stringify(std.body));
  const observed = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'review-observed',
  }));
  assert.equal(observed.body.ok, true, JSON.stringify(observed.body));
  assert.equal(DeskScopeTransitionResult.parse(observed.body).state, 'review-observed');
  const approve = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'approve',
  }));
  assert.equal(approve.body.ok, true, JSON.stringify(approve.body));
  const advance = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'advance',
  }));
  assert.equal(advance.body.ok, true, JSON.stringify(advance.body));
  assert.equal(advance.body.state, 'advanced');
  // advanced → submit opens a fresh round.
  const resub = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'submit-for-review', candidateSnapshot: ctx.snapshot, candidateHead: CAPTURED_HEAD,
  }));
  assert.equal(resub.body.ok, true, JSON.stringify(resub.body));
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const walk = ledger.scopeTransitions.filter(x => x.scopeId === 'scope-1').map(x => [x.command, x.to]);
  assert.deepEqual(walk, [
    ['declare', 'declared'],
    ['claim', 'claimed'],
    ['submit-for-review', 'submitted-for-review'],
    ['review-observed', 'review-observed'],
    ['approve', 'approved'],
    ['advance', 'advanced'],
    ['submit-for-review', 'submitted-for-review'],
  ]);
});

test('B3: illegal edges reject SCOPE_CONFLICT and commit nothing', async t => {
  const ctx = await declared(t);
  // declared → submit-for-review is not an edge (claim is required first).
  const skip = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'submit-for-review', candidateSnapshot: CAPTURED_SNAP,
  }));
  assert.equal(skip.body.code, 'SCOPE_CONFLICT', JSON.stringify(skip.body));
  const claim = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(claim.body.ok, true);
  // claimed → claim again is not an edge.
  const again = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(again.body.code, 'SCOPE_CONFLICT');
  // claimed → approve is not an edge.
  const approve = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'approve',
  }));
  assert.equal(approve.body.code, 'SCOPE_CONFLICT');
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(ledger.scopeTransitions.length, 2, 'only declare+claim committed');
});

test('B3: a transition pins the LATEST declaration revision — a superseded pin is REVISION_CONFLICT', async t => {
  const ctx = await declared(t);
  const second = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, requestId: `dcl-${randomUUID()}`,
  }));
  assert.equal(second.body.revision, 2);
  const stale = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, scopeRevision: 1,
  }));
  assert.equal(stale.body.code, 'REVISION_CONFLICT', JSON.stringify(stale.body));
  const fresh = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, scopeRevision: 2,
  }));
  assert.equal(fresh.body.ok, true, JSON.stringify(fresh.body));
});

// ---------------------------------------------------------------------------
// B4 — the required-review gate: server-derived axes; a missing axis is a
// typed REVIEW_INCOMPLETE rejection that commits nothing.
// ---------------------------------------------------------------------------

test('B4: review-observed and close are gated — missing axes reject REVIEW_INCOMPLETE, zero commit', async t => {
  const ctx = await roundOpen(t);
  // From submitted-for-review: review-observed and close are legal edges
  // but gated while the round pin is set; advance is not even an edge
  // from this state (it only leaves approved/rejected).
  for (const transition of ['review-observed', 'close']) {
    const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
      assignmentId: ctx.assignmentId, transition,
    }));
    assert.equal(reply.body.code, 'REVIEW_INCOMPLETE', `${transition}: ${JSON.stringify(reply.body)}`);
    assert.match(reply.body.message, /spec|standards/);
  }
  const noEdge = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'advance',
  }));
  assert.equal(noEdge.body.code, 'SCOPE_CONFLICT', 'advance is not an edge from submitted-for-review');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopeTransitions.length, 3, 'declare+claim+submit only — nothing committed');
});

test('B4: one missing axis still rejects; both axes discharge the gate with durable evidence', async t => {
  const ctx = await roundOpen(t);
  const spec = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, axis: 'spec' }));
  assert.equal(spec.body.ok, true);
  const stillGated = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'review-observed',
  }));
  assert.equal(stillGated.body.code, 'REVIEW_INCOMPLETE');
  assert.match(stillGated.body.message, /standards/);
  const std = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, axis: 'standards' }));
  assert.equal(std.body.ok, true);
  const observed = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'review-observed',
  }));
  assert.equal(observed.body.ok, true, JSON.stringify(observed.body));
  const parsed = DeskScopeTransitionResult.parse(observed.body);
  assert.deepEqual(parsed.discharged.map(d => d.axis).sort(), ['spec', 'standards']);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const gate = ledger.scopeTransitions.find(x => x.command === 'review-observed');
  assert.equal(gate.discharged.length, 2);
  assert.ok(gate.discharged.every(d => ledger.scopeReviews.some(r => r.reviewId === d.reviewId)));
});

test('B4: early close is not an edge — declared/claimed close typed-rejects with zero commit', async t => {
  const ctx = await declared(t);
  const fromDeclared = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'close',
  }));
  assert.equal(fromDeclared.body.code, 'SCOPE_CONFLICT', 'close before any round is not an edge');
  const claim = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(claim.body.ok, true);
  const fromClaimed = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'close',
  }));
  assert.equal(fromClaimed.body.code, 'SCOPE_CONFLICT', 'close with no submitted round is not an edge');
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(ledger.scopeTransitions.length, 2, 'declare+claim only — close committed nothing');
});

test('B4: claimed provenance never discharges the gate — refs on the declaration change nothing', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  const d = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId, refs: ['review:already-approved', 'spec:outsourced'],
  }));
  assert.equal(d.body.ok, true);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({ assignmentId }));
  const snapshot = await observeCandidate(t, { ...ctx, assignmentId }, { peerConn: ctx.peerConn, assignmentId, agentId: 'agent-1' });
  const sub = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId, transition: 'submit-for-review', candidateSnapshot: snapshot,
  }));
  assert.equal(sub.body.ok, true);
  const gate = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId, transition: 'review-observed',
  }));
  assert.equal(gate.body.code, 'REVIEW_INCOMPLETE', 'claimed review refs never satisfy the gate');
});

// ---------------------------------------------------------------------------
// B5 — review binding: axis/seat/candidate/scopeRevision; self-review and
// drift are typed rejections.
// ---------------------------------------------------------------------------

test('B5: a review must bind the round pin — drifted scopeRevision/candidate reject typed', async t => {
  const ctx = await roundOpen(t);
  const staleRev = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, scopeRevision: 9 }));
  assert.equal(staleRev.body.code, 'REVISION_CONFLICT', JSON.stringify(staleRev.body));
  const drift = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, candidateSnapshot: '7'.repeat(64) }));
  assert.equal(drift.body.code, 'CANDIDATE_DRIFT');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopeReviews.length, 0);
});

test('B5: self-review is prohibited — the bound seat cannot review its own scope', async t => {
  const ctx = await roundOpen(t);
  const own = await review(ctx, ctx.peerConn, reviewArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(own.body.code, 'AUTHORITY_REQUIRED');
  const owner = await review(ctx, ctx.leadConn, reviewArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(owner.body.code, 'AUTHORITY_REQUIRED');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopeReviews.length, 0);
});

test('B5: an owner who is also a seat may still not review — the prohibition binds identity, not seat-ness', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  // Attach the owner itself as a seat — the self-review rule must hold
  // even when the owner satisfies the seat-binding check.
  const att = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_attach', {
    requestId: `att-${randomUUID()}`, assignmentId, agentId: 'agent-lead',
  });
  assert.equal(att.body.ok, true, JSON.stringify(att.body));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({ assignmentId }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({ assignmentId }));
  const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId, agentId: 'agent-1' });
  const sub = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId, transition: 'submit-for-review', candidateSnapshot: snapshot,
  }));
  assert.equal(sub.body.ok, true);
  const own = await review(ctx, ctx.leadConn, reviewArgs({ assignmentId }));
  assert.equal(own.body.code, 'AUTHORITY_REQUIRED', 'owner review stays prohibited even when the owner is a seat');
});

test('B5: a second reviewer\'s stream starts at revision 1 — revision streams are per (axis, reviewer)', async t => {
  const ctx = await boundTrio(t);
  const ledger0 = ledgerOf(ctx.f, ctx.repoKey);
  const peer3 = memberRow('peer3-handle', { role: 'peer', agentId: 'agent-3' });
  await seedMemberships(seedStore(ctx.f), ctx.repo, [...ledger0.memberships, peer3]);
  const peer3Conn = await handshake(ctx.f.paths.socketPath, HELLO('peer3-handle'));
  t.after(() => peer3Conn.conn.destroy());
  assert.equal(peer3Conn.ack.ok, true);
  const assignmentId = await registerPair(t, ctx, ['agent-1', 'agent-2', 'agent-3']);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({ assignmentId }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({ assignmentId }));
  const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId, agentId: 'agent-1' });
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId, transition: 'submit-for-review', candidateSnapshot: snapshot,
  }));
  const first = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId }));
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  const second = await review(ctx, peer3Conn, reviewArgs({ assignmentId, requestId: `rev-${randomUUID()}` }));
  assert.equal(second.body.ok, true, JSON.stringify(second.body));
  const rows = ledgerOf(ctx.f, ctx.repoKey).scopeReviews.filter(r => r.axis === 'spec');
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.revision, 1, 'each (axis, reviewer) stream opens at revision 1');
});

test('B5: a review outside a round, on a foreign assignment, or on an undeclared scope rejects', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  // No scope at all.
  const ghost = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId }));
  assert.equal(ghost.body.code, 'SCOPE_CONFLICT');
  // Declared but never submitted — no round pin exists.
  const d = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({ assignmentId }));
  assert.equal(d.body.ok, true);
  const noRound = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId }));
  assert.equal(noRound.body.code, 'SCOPE_CONFLICT');
  // Foreign assignment id.
  const foreign = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: 'asg-ghost' }));
  assert.equal(foreign.body.code, 'AUTHORITY_REQUIRED');
});

// ---------------------------------------------------------------------------
// B6 — candidate binding on submit: only a durable observed candidate of
// THIS assignment (and of the bound seat) can pin a round.
// ---------------------------------------------------------------------------

test('B6: submit-for-review requires an observed candidate of this assignment and bound seat', async t => {
  const ctx = await declared(t);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({ assignmentId: ctx.assignmentId }));
  // No candidate at all.
  const noCand = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'submit-for-review', candidateSnapshot: '7'.repeat(64),
  }));
  assert.equal(noCand.body.code, 'CANDIDATE_DRIFT', JSON.stringify(noCand.body));
  // A candidate from another assignment never pins this scope's round.
  const otherAsg = await registerPair(t, ctx);
  const otherSnap = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId: otherAsg, agentId: 'agent-1' });
  const crossAsg = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'submit-for-review', candidateSnapshot: otherSnap,
  }));
  // CAPTURED_SNAP exists on ctx.assignmentId too? No — the observe ran on
  // otherAsg only; the find is (assignmentId, snapshot) — cross fails.
  assert.equal(crossAsg.body.code, 'CANDIDATE_DRIFT');
  // The real candidate pins the round; the seat match is implicit (the
  // scope's bound seat produced the candidate).
  const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId: ctx.assignmentId, agentId: 'agent-1' });
  const pinned = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'submit-for-review', candidateSnapshot: snapshot, candidateHead: CAPTURED_HEAD,
  }));
  assert.equal(pinned.body.ok, true, JSON.stringify(pinned.body));
  const row = ledgerOf(ctx.f, ctx.repoKey).scopeTransitions.at(-1);
  assert.equal(row.candidateSnapshot, snapshot);
  assert.equal(row.candidateHead, CAPTURED_HEAD);
  // A scope bound to a different seat cannot pin another seat's candidate.
  const d2 = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, scopeId: 'scope-2', seatAgentId: 'agent-2',
  }));
  assert.equal(d2.body.ok, true);
  const c2 = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, scopeId: 'scope-2',
  }));
  assert.equal(c2.body.ok, true);
  const mismatch = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, scopeId: 'scope-2', transition: 'submit-for-review', candidateSnapshot: snapshot,
  }));
  assert.equal(mismatch.body.code, 'CANDIDATE_DRIFT', 'a bound-seat scope pins only that seat\'s candidates');
});

test('B6: a wrong candidateHead claim is CANDIDATE_DRIFT — the head pin is evidence, not input', async t => {
  const ctx = await declared(t);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({ assignmentId: ctx.assignmentId }));
  const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId: ctx.assignmentId, agentId: 'agent-1' });
  const bad = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'submit-for-review', candidateSnapshot: snapshot, candidateHead: '9'.repeat(40),
  }));
  assert.equal(bad.body.code, 'CANDIDATE_DRIFT');
});

// ---------------------------------------------------------------------------
// B7 — append-only + idempotency + close semantics.
// ---------------------------------------------------------------------------

test('B7: replayed requestIds return the same durable outcome — no duplicate rows', async t => {
  const ctx = await declared(t);
  const requestId = `dcl-${randomUUID()}`;
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({ assignmentId: ctx.assignmentId, requestId, scopeId: 'scope-2' }));
  assert.equal(first.body.ok, true);
  const replay = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({ assignmentId: ctx.assignmentId, requestId, scopeId: 'scope-2' }));
  assert.equal(replay.body.ok, true);
  assert.equal(replay.body.revision, first.body.revision);
  assert.equal(replay.body.receiptId, first.body.receiptId);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(ledger.scopes.filter(s => s.scopeId === 'scope-2').length, 1, 'replay never duplicates');
  // A conflicting body under the same requestId is an idempotency conflict.
  const conflict = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, requestId, scopeId: 'scope-2', label: 'different body',
  }));
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
});

test('B7: close is terminal, not acceptance — nothing leaves closed, approval stays a verdict', async t => {
  const ctx = await roundOpen(t);
  for (const axis of ['spec', 'standards']) {
    const r = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, axis }));
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
  }
  for (const transition of ['review-observed', 'approve']) {
    const step = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
      assignmentId: ctx.assignmentId, transition,
    }));
    assert.equal(step.body.ok, true, `${transition}: ${JSON.stringify(step.body)}`);
  }
  const close = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'close',
  }));
  assert.equal(close.body.ok, true, JSON.stringify(close.body));
  assert.equal(close.body.state, 'closed');
  // closed never reads back as approved: the only approval signal is the
  // `approved` state, which closed never produces.
  const after = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'claim',
  }));
  assert.equal(after.body.code, 'SCOPE_CONFLICT', 'no edge leaves closed');
});

test('B7: close mid-round is gated — the open round still owes its axes', async t => {
  const ctx = await roundOpen(t);
  const close = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'close',
  }));
  assert.equal(close.body.code, 'REVIEW_INCOMPLETE');
});

// ---------------------------------------------------------------------------
// B8 — a declaration amendment preserves the old round as history but makes
// its observations/transitions stale until the owner rejects it and submits
// a fresh round pinned to the current declaration.
// ---------------------------------------------------------------------------

test('B8: a scope amendment stales the old round, preserves its pin, and requires a fresh independently reviewed round', async t => {
  const ctx = await roundOpen(t);
  const before = ledgerOf(ctx.f, ctx.repoKey);
  const firstSubmit = before.scopeTransitions.find(row => row.scopeId === 'scope-1' && row.command === 'submit-for-review');
  assert.ok(firstSubmit, 'the original candidate round is committed');
  assert.equal(firstSubmit.scopeRevision, 1);

  const amend = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, expectedBriefRevision: 0,
    requestId: `dcl-${randomUUID()}`, label: 'amended mid-round',
  }));
  assert.equal(amend.body.revision, 2);
  const afterAmend = ledgerOf(ctx.f, ctx.repoKey);
  const oldPin = afterAmend.scopeTransitions.find(row => row.scopeId === 'scope-1' && row.command === 'submit-for-review');
  assert.deepEqual(oldPin, firstSubmit, 'the submitted round pin remains immutable after amendment');

  const domainState = ledger => ({
    declarations: ledger.scopes.filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1')
      .sort((a, b) => a.revision - b.revision),
    reviews: ledger.scopeReviews.filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1')
      .sort((a, b) => String(a.axis ?? a.lensId).localeCompare(String(b.axis ?? b.lensId)) ||
        a.reviewerAgentId.localeCompare(b.reviewerAgentId) || a.revision - b.revision),
    transitions: ledger.scopeTransitions.filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1')
      .sort((a, b) => a.revision - b.revision),
    lastEventSeq: ledger.lastEventSeq,
    lastEventSha256: ledger.lastEventSha256,
  });
  const afterAmendState = domainState(afterAmend);

  // Neither an observation on the old pin nor a gated move on the new
  // declaration may discharge the stale round. Rejection receipts may be
  // recorded for idempotency, but no workflow rows or event history change.
  const staleReview = await review(ctx, ctx.peer2Conn, reviewArgs({
    assignmentId: ctx.assignmentId, scopeRevision: 1, candidateSnapshot: ctx.snapshot,
  }));
  assert.equal(staleReview.body.code, 'REVISION_CONFLICT', JSON.stringify(staleReview.body));
  const staleGate = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'review-observed', scopeRevision: 2,
  }));
  assert.equal(staleGate.body.code, 'REVISION_CONFLICT', JSON.stringify(staleGate.body));
  assert.deepEqual(domainState(ledgerOf(ctx.f, ctx.repoKey)), afterAmendState,
    'stale observations/transitions leave declarations, review rows, transitions and committed event history unchanged');

  const rejectOldRound = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'reject', scopeRevision: 2,
  }));
  assert.equal(rejectOldRound.body.ok, true, JSON.stringify(rejectOldRound.body));
  const freshSubmit = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, scopeRevision: 2, transition: 'submit-for-review',
    candidateSnapshot: ctx.snapshot, candidateHead: CAPTURED_HEAD,
  }));
  assert.equal(freshSubmit.body.ok, true, JSON.stringify(freshSubmit.body));
  const freshPin = ledgerOf(ctx.f, ctx.repoKey).scopeTransitions.find(row =>
    row.scopeId === 'scope-1' && row.command === 'submit-for-review' && row.revision === freshSubmit.body.revision);
  assert.equal(freshPin.scopeRevision, 2);
  assert.equal(freshPin.candidateSnapshot, ctx.snapshot);

  for (const axis of ['spec', 'standards']) {
    const observed = await review(ctx, ctx.peer2Conn, reviewArgs({
      assignmentId: ctx.assignmentId, scopeRevision: 2, candidateSnapshot: ctx.snapshot, axis,
    }));
    assert.equal(observed.body.ok, true, JSON.stringify(observed.body));
  }
  const gate = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'review-observed', scopeRevision: 2,
  }));
  assert.equal(gate.body.ok, true, JSON.stringify(gate.body));
  assert.deepEqual(gate.body.discharged.map(row => row.axis).sort(), ['spec', 'standards']);
  const approve = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'approve', scopeRevision: 2,
  }));
  assert.equal(approve.body.ok, true, JSON.stringify(approve.body));

  const final = ledgerOf(ctx.f, ctx.repoKey);
  const finalOldPin = final.scopeTransitions.find(row => row.scopeId === 'scope-1' &&
    row.command === 'submit-for-review' && row.revision === firstSubmit.revision);
  assert.deepEqual(finalOldPin, firstSubmit, 'the stale historical round is never rebound by the fresh one');
  const standing = final.scopeTransitions.filter(row => row.scopeId === 'scope-1').sort((a, b) => a.revision - b.revision);
  assert.ok(approvedScopeRound(standing, { scopeRevision: 2, briefRevision: 0, mandateSha256: null }));
});

// ---------------------------------------------------------------------------
// B9 — status projection: scoped, provenance-separated, bounded.
// ---------------------------------------------------------------------------

test('B9: slp_status projects scopes caller-scoped — owner sees all; bound seat sees its scope', async t => {
  const ctx = await roundOpen(t);
  const spec = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(spec.body.ok, true);
  // Owner view: every scope with its machine state + round pin.
  const owner = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_status', {});
  const ownerView = DeskSeatStatus.parse(owner.body);
  const ownerAsg = ownerView.assignments.find(a => a.assignmentId === ctx.assignmentId);
  const scope = ownerAsg.scopes.find(s => s.scopeId === 'scope-1');
  assert.equal(scope.state, 'submitted-for-review');
  assert.equal(scope.revision, 1);
  assert.deepEqual(scope.requiredAxes, ['spec', 'standards']);
  assert.deepEqual(scope.dischargedAxes, ['spec']);
  assert.equal(scope.activeCandidateSnapshot, CAPTURED_SNAP);
  assert.equal(scope.reviews.length, 1);
  assert.equal(scope.reviews[0].axis, 'spec');
  assert.equal(scope.reviews[0].reviewerAgentId, 'agent-2');
  // The bound seat sees its own scope; the other peer sees the unbound view
  // of nothing — scope-1 is bound to agent-1, so agent-2's list is empty
  // unless the scope is unbound.
  const peer = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_status', {});
  const peerView = DeskSeatStatus.parse(peer.body);
  const peerAsg = peerView.assignments.find(a => a.assignmentId === ctx.assignmentId);
  assert.ok(peerAsg.scopes.some(s => s.scopeId === 'scope-1'), 'the bound seat sees its scope');
  const peer2 = await call(ctx.peer2Conn.reader, ctx.peer2Conn.conn, 'slp_status', {});
  const peer2View = DeskSeatStatus.parse(peer2.body);
  const peer2Asg = peer2View.assignments.find(a => a.assignmentId === ctx.assignmentId);
  assert.equal(peer2Asg === undefined || peer2Asg.scopes.every(s => s.scopeId !== 'scope-1'), true,
    'a foreign-bound scope never leaks into another seat\'s view');
});

test('B9: status never re-serves claimed provenance — refs and findingsRef stay in the ledger', async t => {
  const ctx = await declared(t);
  const owner = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_status', {});
  const view = DeskSeatStatus.parse(owner.body);
  const scope = view.assignments.find(a => a.assignmentId === ctx.assignmentId).scopes[0];
  assert.equal(scope.scopeId, 'scope-1');
  assert.equal('refs' in scope, false, 'claimed refs are ledger-only provenance');
  assert.equal('findingsRef' in (scope.reviews[0] ?? {}), false);
});

test('B9: a review list beyond the per-scope cap is truncated WITH an explicit limitation — never silently', async t => {
  const ctx = await roundOpen(t);
  // One reviewer can append revision after revision on the same (axis,
  // reviewer) stream — the append-only ledger keeps them all.
  for (let i = 0; i < WIRE_LIMITS.deskStatusScopeReviews + 1; i += 1) {
    const r = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, axis: 'spec' }));
    assert.equal(r.body.ok, true, `review ${i + 1}: ${JSON.stringify(r.body)}`);
  }
  const owner = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_status', {});
  const view = DeskSeatStatus.parse(owner.body);
  const scope = view.assignments.find(a => a.assignmentId === ctx.assignmentId).scopes[0];
  assert.equal(scope.reviews.length, WIRE_LIMITS.deskStatusScopeReviews, 'the projection caps the review list');
  assert.ok(
    view.limitations.some(l => l.includes('review') && l.includes(String(WIRE_LIMITS.deskStatusScopeReviews))),
    `a limitation marker must carry the truncation: ${JSON.stringify(view.limitations)}`,
  );
  // The durable ledger still holds every row — truncation is a wire view,
  // never a write.
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopeReviews.length, WIRE_LIMITS.deskStatusScopeReviews + 1);
});

// ---------------------------------------------------------------------------
// B10 — wire bounds: over-cap inputs reject before any durable commit.
// ---------------------------------------------------------------------------

test('B10: over-cap scope inputs reject INVALID_RECORD and land nothing', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  const fatRefs = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId, refs: Array.from({ length: WIRE_LIMITS.deskScopeRefs + 1 }, (_, i) => `ref-${i}`),
  }));
  assert.equal(fatRefs.isError, true, 'a wire-schema violation is an envelope error');
  assert.equal(fatRefs.body.code, 'INVALID_RECORD');
  const fatLabel = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId, label: 'x'.repeat(WIRE_LIMITS.deskScopeLabel + 1),
  }));
  assert.equal(fatLabel.isError, true);
  assert.equal(fatLabel.body.code, 'INVALID_RECORD');
  const badAxis = await call(ctx.peer2Conn.reader, ctx.peer2Conn.conn, 'slp_scope_review', reviewArgs({
    assignmentId, axis: 'vibes',
  }));
  assert.equal(badAxis.body.code, 'INVALID_RECORD');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopes.length, 0);
});

// ---------------------------------------------------------------------------
// B11 — reject path: direct reject by the owner, then gated advance still
// owes the round's axes; resubmit opens a fresh round.
// ---------------------------------------------------------------------------

test('B11: reject records the owner decision; advance stays gated; resubmit re-pins', async t => {
  const ctx = await roundOpen(t);
  const reject = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'reject',
  }));
  assert.equal(reject.body.ok, true, JSON.stringify(reject.body));
  assert.equal(reject.body.state, 'rejected');
  // rejected → advance still owes the round's axes (the pin holds).
  const gated = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'advance',
  }));
  assert.equal(gated.body.code, 'REVIEW_INCOMPLETE');
  // rejected → close owes the round's axes too — the owner cannot close a
  // scope out of review debt.
  const gatedClose = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'close',
  }));
  assert.equal(gatedClose.body.code, 'REVIEW_INCOMPLETE');
  // A resubmit opens a fresh round pinned to the same candidate.
  const resub = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'submit-for-review', candidateSnapshot: ctx.snapshot,
  }));
  assert.equal(resub.body.ok, true, JSON.stringify(resub.body));
});

// ---------------------------------------------------------------------------
// B12 — the durable rows: request-key uniqueness is a durable invariant,
// and the v5 tables carry the pinned identities (replay consistency).
// ---------------------------------------------------------------------------

test('B12: committed rows carry server-derived identity — actor, seat, pins; request keys are unique', async t => {
  const ctx = await roundOpen(t);
  const spec = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId }));
  const std = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, axis: 'standards' }));
  assert.equal(spec.body.ok && std.body.ok, true);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const reviews = ledger.scopeReviews.filter(r => r.scopeId === 'scope-1');
  for (const r of reviews) {
    assert.equal(r.reviewerAgentId, 'agent-2');
    assert.equal(r.reviewerSeatId, ctx.peer2.membershipId, 'the durable seat binding, not a claim');
    assert.equal(r.scopeRevision, 1);
    assert.equal(r.candidateSnapshot, ctx.snapshot);
    assert.equal(r.assignmentId, ctx.assignmentId);
  }
  // Re-record the SAME axis — a new revision on the same review stream,
  // append-only.
  const again = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, axis: 'spec', verdict: 'findings', findingsRef: 'note:round-1-spec' }));
  assert.equal(again.body.ok, true);
  assert.equal(again.body.revision, 2, 'a repeated observation appends a revision on the same stream');
  const stream = ledgerOf(ctx.f, ctx.repoKey).scopeReviews.filter(r => r.axis === 'spec');
  assert.equal(stream.length, 2);
});

test('v7: a brief amendment stales scope transitions and requires a fresh approved round without invalidating prior history', async t => {
  const ctx = await boundTrio(t);
  ctx.assignmentId = await registerPair(t, ctx);
  const firstBrief = await amendBrief(ctx, 0, 'Implement the original bounded outcome.');
  assert.equal(firstBrief.body.ok, true, JSON.stringify(firstBrief.body));
  const declaredScope = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, expectedBriefRevision: 1,
  }));
  assert.equal(declaredScope.body.ok, true, JSON.stringify(declaredScope.body));
  const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId: ctx.assignmentId, agentId: 'agent-1' });
  const transition = (args = {}) => call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, briefRevision: 1, ...args,
  }));
  assert.equal((await transition({ transition: 'claim' })).body.ok, true);
  assert.equal((await transition({ transition: 'submit-for-review', candidateSnapshot: snapshot, candidateHead: CAPTURED_HEAD })).body.ok, true);
  for (const axis of ['spec', 'standards']) {
    const observed = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, briefRevision: 1, axis }));
    assert.equal(observed.body.ok, true, JSON.stringify(observed.body));
  }
  assert.equal((await transition({ transition: 'review-observed' })).body.ok, true);
  assert.equal((await transition({ transition: 'approve' })).body.ok, true);

  const beforeAmendment = ledgerOf(ctx.f, ctx.repoKey);
  const history = beforeAmendment.scopeTransitions.filter(row => row.scopeId === 'scope-1');
  assert.ok(approvedScopeRound(history, { briefRevision: 1, scopeRevision: 1, mandateSha256: null }));
  const secondBrief = await amendBrief(ctx, 1, 'Clarify the revised bounded outcome.');
  assert.equal(secondBrief.body.ok, true, JSON.stringify(secondBrief.body));
  const afterAmendment = ledgerOf(ctx.f, ctx.repoKey);
  const oldRound = afterAmendment.scopeTransitions.filter(row => row.scopeId === 'scope-1');
  assert.ok(approvedScopeRound(oldRound), 'the recorded approval remains historically intact');
  assert.equal(approvedScopeRound(oldRound, { briefRevision: 2, scopeRevision: 1, mandateSha256: null }), null,
    'a current freshness query cannot reuse the earlier brief pin');
  const stale = await transition({ transition: 'advance', briefRevision: 2 });
  assert.equal(stale.body.code, 'REVISION_CONFLICT', JSON.stringify(stale.body));
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopeTransitions.length, oldRound.length, 'a stale gate writes no transition');

  const redeclared = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, expectedBriefRevision: 2, requestId: `dcl-${randomUUID()}`,
  }));
  assert.equal(redeclared.body.revision, 2);
  const fresh = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, scopeRevision: 2, briefRevision: 2,
    transition: 'submit-for-review', candidateSnapshot: snapshot, candidateHead: CAPTURED_HEAD,
  }));
  assert.equal(fresh.body.ok, true, JSON.stringify(fresh.body));
  for (const axis of ['spec', 'standards']) {
    const observed = await review(ctx, ctx.peer2Conn, reviewArgs({
      assignmentId: ctx.assignmentId, scopeRevision: 2, briefRevision: 2, axis, requestId: `rev-${randomUUID()}`,
    }));
    assert.equal(observed.body.ok, true, JSON.stringify(observed.body));
  }
  for (const transitionName of ['review-observed', 'approve']) {
    const moved = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
      assignmentId: ctx.assignmentId, scopeRevision: 2, briefRevision: 2, transition: transitionName,
    }));
    assert.equal(moved.body.ok, true, JSON.stringify(moved.body));
  }
  const current = ledgerOf(ctx.f, ctx.repoKey).scopeTransitions.filter(row => row.scopeId === 'scope-1');
  assert.equal(approvedScopeRound(current, { briefRevision: 2, scopeRevision: 2, mandateSha256: null })?.scopeRevision, 2);
});

test('v7: an old observed round cannot approve on amended brief pins; a fresh round can', async t => {
  const ctx = await boundTrio(t);
  ctx.assignmentId = await registerPair(t, ctx);
  assert.equal((await amendBrief(ctx, 0, 'The first operative outcome.')).body.ok, true);
  const declaration = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, expectedBriefRevision: 1,
  }));
  assert.equal(declaration.body.ok, true, JSON.stringify(declaration.body));
  const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId: ctx.assignmentId, agentId: 'agent-1' });
  const transition = (over = {}) => call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, briefRevision: 1, ...over,
  }));
  assert.equal((await transition({ transition: 'claim' })).body.ok, true);
  assert.equal((await transition({ transition: 'submit-for-review', candidateSnapshot: snapshot, candidateHead: CAPTURED_HEAD })).body.ok, true);
  for (const axis of ['spec', 'standards']) {
    const observed = await review(ctx, ctx.peer2Conn, reviewArgs({
      assignmentId: ctx.assignmentId, briefRevision: 1, candidateSnapshot: snapshot, axis,
    }));
    assert.equal(observed.body.ok, true, JSON.stringify(observed.body));
  }
  assert.equal((await transition({ transition: 'review-observed' })).body.ok, true);

  assert.equal((await amendBrief(ctx, 1, 'A materially revised operative outcome.')).body.ok, true);
  const redeclared = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, expectedBriefRevision: 2, requestId: `dcl-${randomUUID()}`,
  }));
  assert.equal(redeclared.body.revision, 2);
  const committed = ledgerOf(ctx.f, ctx.repoKey);
  const state = ledger => ({
    declarations: ledger.scopes.filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1').sort((a, b) => a.revision - b.revision),
    reviews: ledger.scopeReviews.filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1').sort((a, b) => a.revision - b.revision),
    transitions: ledger.scopeTransitions.filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1').sort((a, b) => a.revision - b.revision),
    lastEventSeq: ledger.lastEventSeq,
    lastEventSha256: ledger.lastEventSha256,
  });
  const beforeStaleApprove = state(committed);
  const staleApprove = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'approve', scopeRevision: 2, briefRevision: 2,
  }));
  assert.equal(staleApprove.body.ok, false, JSON.stringify(staleApprove.body));
  assert.equal(staleApprove.body.code, 'REVISION_CONFLICT', 'a new declaration cannot rebind observations from the older round');
  assert.deepEqual(state(ledgerOf(ctx.f, ctx.repoKey)), beforeStaleApprove,
    'stale approval leaves rows and the committed event chain untouched');

  const rejected = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'reject', scopeRevision: 2, briefRevision: 2,
  }));
  assert.equal(rejected.body.ok, true, JSON.stringify(rejected.body));
  const fresh = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'submit-for-review', scopeRevision: 2, briefRevision: 2,
    candidateSnapshot: snapshot, candidateHead: CAPTURED_HEAD,
  }));
  assert.equal(fresh.body.ok, true, JSON.stringify(fresh.body));
  for (const axis of ['spec', 'standards']) {
    const observed = await review(ctx, ctx.peer2Conn, reviewArgs({
      assignmentId: ctx.assignmentId, scopeRevision: 2, briefRevision: 2,
      candidateSnapshot: snapshot, axis, requestId: `rev-${randomUUID()}`,
    }));
    assert.equal(observed.body.ok, true, JSON.stringify(observed.body));
  }
  const freshGate = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'review-observed', scopeRevision: 2, briefRevision: 2,
  }));
  assert.equal(freshGate.body.ok, true, JSON.stringify(freshGate.body));
  const approved = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'approve', scopeRevision: 2, briefRevision: 2,
  }));
  assert.equal(approved.body.ok, true, JSON.stringify(approved.body));
  const final = ledgerOf(ctx.f, ctx.repoKey);
  const stream = final.scopeTransitions.filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1').sort((a, b) => a.revision - b.revision);
  assert.equal(stream.filter(row => row.command === 'approve').length, 1, 'only the fresh, fully reviewed round is approved');
  assert.deepEqual(stream.filter(row => row.command === 'approve')[0].discharged.map(item => item.axis).sort(), ['spec', 'standards']);
  assert.deepEqual(stream.find(row => row.command === 'submit-for-review' && row.scopeRevision === 1),
    committed.scopeTransitions.filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1').sort((a, b) => a.revision - b.revision).find(row => row.command === 'submit-for-review'),
    'the original candidate round remains immutable');
  assert.equal(approvedScopeRound(stream, { scopeRevision: 2, briefRevision: 2, mandateSha256: null })?.scopeRevision, 2);
});

test('v7: named lenses and authority-claimed exemptions control the review gate without changing legacy defaults', async t => {
  const ctx = await boundTrio(t);
  ctx.assignmentId = await registerPair(t, ctx);
  const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId: ctx.assignmentId, agentId: 'agent-1' });
  const reviewPlan = {
    kind: 'required', authorityRef: 'grant:future-workspace', ruleRef: 'rule:privacy',
    reason: 'The Human-authorized workspace rule requires this independent lens.', exemptionClass: null,
    lenses: [{ id: 'privacy', name: 'Privacy review', authorityRef: 'grant:future-workspace', ruleRef: 'rule:privacy' }],
  };
  const ownership = {
    writerAgentId: 'agent-1', writerAuthorityRef: null, paths: ['src/privacy.ts'], resources: ['resource:privacy-state'],
    stateOwners: [{ stateRef: 'privacy-state', moduleRef: 'src/privacy.ts' }], dependsOnScopeIds: [], notifications: [],
  };
  const declaration = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, seatAgentId: null, ownership, reviewPlan,
  }));
  assert.equal(declaration.body.ok, true, JSON.stringify(declaration.body));
  const staleWriter = await review(ctx, ctx.peerConn, reviewArgs({ assignmentId: ctx.assignmentId, lensId: 'privacy', axis: undefined }));
  assert.equal(staleWriter.body.code, 'AUTHORITY_REQUIRED', 'the declared writer cannot supply an independent review');
  for (const [transition, fields] of [
    ['claim', {}], ['submit-for-review', { candidateSnapshot: snapshot, candidateHead: CAPTURED_HEAD }],
  ]) {
    const moved = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
      assignmentId: ctx.assignmentId, transition, ...fields,
    }));
    assert.equal(moved.body.ok, true, JSON.stringify(moved.body));
  }
  const wrongLens = await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId, axis: 'spec' }));
  assert.equal(wrongLens.body.code, 'AUTHORITY_REQUIRED');
  const missing = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'review-observed',
  }));
  assert.equal(missing.body.code, 'REVIEW_INCOMPLETE');
  const lensReview = await review(ctx, ctx.peer2Conn, reviewArgs({
    assignmentId: ctx.assignmentId, axis: undefined, lensId: 'privacy',
  }));
  assert.equal(lensReview.body.ok, true, JSON.stringify(lensReview.body));
  const complete = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'review-observed',
  }));
  assert.deepEqual(complete.body.discharged.map(item => item.lensId), ['privacy']);
  const scopeRow = ledgerOf(ctx.f, ctx.repoKey).scopes[0];
  assert.equal(scopeRow.reviewPlan.authorityRef, 'grant:future-workspace', 'stored authority references remain claims');
  assert.deepEqual(scopeRow.ownership.stateOwners.map(owner => owner.stateRef), ['privacy-state']);

  const exemption = {
    kind: 'exempt', authorityRef: 'grant:future-workspace', ruleRef: 'rule:docs-only',
    reason: 'Authorized class is exempt from independent review.', lenses: [], exemptionClass: 'docs-only',
  };
  const exemptDeclaration = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, scopeId: 'docs-only', seatAgentId: null, reviewPlan: exemption,
    requestId: `dcl-${randomUUID()}`,
  }));
  assert.equal(exemptDeclaration.body.ok, true, JSON.stringify(exemptDeclaration.body));
  for (const [transition, fields] of [
    ['claim', {}], ['submit-for-review', { candidateSnapshot: snapshot, candidateHead: CAPTURED_HEAD }],
  ]) {
    const moved = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
      assignmentId: ctx.assignmentId, scopeId: 'docs-only', transition, ...fields,
    }));
    assert.equal(moved.body.ok, true, JSON.stringify(moved.body));
  }
  const exempt = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, scopeId: 'docs-only', transition: 'review-observed',
  }));
  assert.equal(exempt.body.ok, true, JSON.stringify(exempt.body));
  assert.deepEqual(exempt.body.discharged, [], 'the stored explicit exemption has an empty required set');
});

test('v7: omitted-axis named-lens observations append revisions across same and resubmitted rounds', async t => {
  const ctx = await boundTrio(t);
  ctx.assignmentId = await registerPair(t, ctx);
  const reviewPlan = {
    kind: 'required', authorityRef: 'grant:future-workspace', ruleRef: 'rule:privacy',
    reason: 'The authorized workspace rule requires an independent named lens.', exemptionClass: null,
    lenses: [{ id: 'privacy', name: 'Privacy review', authorityRef: 'grant:future-workspace', ruleRef: 'rule:privacy' }],
  };
  const declared = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, seatAgentId: null, reviewPlan,
  }));
  assert.equal(declared.body.ok, true, JSON.stringify(declared.body));
  const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId: ctx.assignmentId, agentId: 'agent-1' });
  const transition = (over = {}) => call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({
    assignmentId: ctx.assignmentId, ...over,
  }));
  assert.equal((await transition({ transition: 'claim' })).body.ok, true);
  assert.equal((await transition({ transition: 'submit-for-review', candidateSnapshot: snapshot, candidateHead: CAPTURED_HEAD })).body.ok, true);
  const observeLens = (scopeRevision = 1) => review(ctx, ctx.peer2Conn, reviewArgs({
    assignmentId: ctx.assignmentId, scopeRevision, axis: undefined, lensId: 'privacy',
  }));
  const first = await observeLens();
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal(first.body.revision, 1);
  const second = await observeLens();
  assert.equal(second.body.ok, true, JSON.stringify(second.body));
  assert.equal(second.body.revision, 2, 'the same reviewer/lens stream advances inside one round');
  const firstRound = ledgerOf(ctx.f, ctx.repoKey).scopeReviews
    .filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1' && row.reviewerAgentId === 'agent-2' && row.axis === null && row.lensId === 'privacy')
    .sort((a, b) => a.revision - b.revision);
  assert.deepEqual(firstRound.map(row => row.revision), [1, 2]);

  const rejected = await transition({ transition: 'reject' });
  assert.equal(rejected.body.ok, true, JSON.stringify(rejected.body));
  const redeclared = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, seatAgentId: null, reviewPlan, expectedBriefRevision: 0,
    requestId: `dcl-${randomUUID()}`,
  }));
  assert.equal(redeclared.body.revision, 2);
  const resubmitted = await transition({ transition: 'submit-for-review', scopeRevision: 2, candidateSnapshot: snapshot, candidateHead: CAPTURED_HEAD });
  assert.equal(resubmitted.body.ok, true, JSON.stringify(resubmitted.body));
  const third = await observeLens(2);
  assert.equal(third.body.ok, true, JSON.stringify(third.body));
  assert.equal(third.body.revision, 3, 'redeclare/resubmit does not reset the same reviewer/lens revision stream');
  const revisions = ledgerOf(ctx.f, ctx.repoKey).scopeReviews
    .filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1' && row.reviewerAgentId === 'agent-2' && row.axis === null && row.lensId === 'privacy')
    .sort((a, b) => a.revision - b.revision);
  assert.deepEqual(revisions.map(row => row.revision), [1, 2, 3]);
  assert.deepEqual(revisions.map(row => row.scopeRevision), [1, 1, 2]);
});

test('v7: declared ownership rejects segment overlap, shared state modules, and invalid dependency graphs', async t => {
  const ctx = await boundTrio(t);
  ctx.assignmentId = await registerPair(t, ctx);
  const ownership = (over = {}) => ({
    writerAgentId: 'agent-1', writerAuthorityRef: null, paths: [], resources: [],
    stateOwners: [], dependsOnScopeIds: [], notifications: [], ...over,
  });
  const declare = (scopeId, value, over = {}) => call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, scopeId, seatAgentId: null, ownership: value,
    requestId: `dcl-${randomUUID()}`, ...over,
  }));

  const base = await declare('base', ownership({
    paths: ['src/tree.ts'], resources: ['resource:base'],
    stateOwners: [{ stateRef: 'base-state', moduleRef: 'src/state.ts' }],
  }));
  assert.equal(base.body.ok, true, JSON.stringify(base.body));
  const beforeConflicts = ledgerOf(ctx.f, ctx.repoKey).scopes.length;
  const nestedPath = await declare('nested', ownership({ paths: ['src/tree.ts/child.ts'] }));
  assert.equal(nestedPath.body.code, 'SCOPE_CONFLICT', 'parent/child path segments are an active moving-surface overlap');
  const moduleOwner = await declare('same-module', ownership({
    paths: ['src/other.ts'], stateOwners: [{ stateRef: 'other-state', moduleRef: 'src/state.ts' }],
  }));
  assert.equal(moduleOwner.body.code, 'SCOPE_CONFLICT', 'one module cannot have two active state owners');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopes.length, beforeConflicts, 'conflicting declarations commit no scope row');

  const missingDependency = await declare('missing-dependency', ownership({ dependsOnScopeIds: ['not-declared'] }));
  assert.equal(missingDependency.body.code, 'SCOPE_CONFLICT', 'a dependency must resolve on the same assignment');
  const depA = await declare('dep-a', ownership({ paths: ['src/dep-a.ts'], dependsOnScopeIds: ['base'] }));
  assert.equal(depA.body.ok, true, JSON.stringify(depA.body));
  const depB = await declare('dep-b', ownership({ paths: ['src/dep-b.ts'], dependsOnScopeIds: ['dep-a'] }));
  assert.equal(depB.body.ok, true, JSON.stringify(depB.body));
  const cycle = await declare('dep-a', ownership({ paths: ['src/dep-a.ts'], dependsOnScopeIds: ['dep-b'] }));
  assert.equal(cycle.body.code, 'SCOPE_CONFLICT', 'a declaration amendment cannot introduce a dependency cycle');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopes.filter(row => row.scopeId === 'dep-a').length, 1);
});

const selectedNoReview = () => ({
  kind: 'not-required', authorityRef: 'grant:selection', ruleRef: 'rule:bounded-selection',
  reason: 'No material independent review question remains for this bounded scope.',
  lenses: [], exemptionClass: null,
});
const selectedRequired = () => ({
  kind: 'required', authorityRef: 'grant:selection', ruleRef: 'rule:identity',
  reason: 'An independent identity judgment is required.', exemptionClass: null,
  lenses: [{ id: 'identity', name: 'Identity judgment', authorityRef: 'grant:selection', ruleRef: 'rule:identity' }],
});

test('selection: strict decision schema distinguishes no-review from a waiver and rejects blank basis', () => {
  assert.equal(DeskReviewPlan.safeParse(selectedNoReview()).success, true);
  for (const over of [
    { lenses: selectedRequired().lenses }, { exemptionClass: 'waiver' },
    { reason: ' \t ' }, { authorityRef: ' ' }, { ruleRef: ' ' },
    { kind: 'required' }, { kind: 'exempt' },
  ]) assert.equal(DeskReviewPlan.safeParse({ ...selectedNoReview(), ...over }).success, false, JSON.stringify(over));
  assert.equal(DeskReviewPlan.safeParse({ ...selectedNoReview(), kind: 'exempt', exemptionClass: ' ' }).success, false);
});

test('selection: new omitted decision rejects durably and never becomes authorized by a later declaration', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  const omitted = declareArgs({ assignmentId, reviewPlan: undefined });
  const rejected = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', omitted);
  assert.equal(rejected.body.code, 'AUTHORITY_REQUIRED');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopes.length, 0);
  const chosen = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId, reviewPlan: selectedNoReview(),
  }));
  assert.equal(chosen.body.ok, true, JSON.stringify(chosen.body));
  const replay = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', omitted);
  assert.deepEqual(replay.body, rejected.body);
  const altered = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', { ...omitted, reviewPlan: null });
  assert.equal(altered.body.code, 'IDEMPOTENCY_CONFLICT');
});

test('selection: redeclare omission inherits named mandates and exact retries retain their original effective choice', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  const firstArgs = declareArgs({ assignmentId, reviewPlan: selectedRequired() });
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', firstArgs);
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  const inheritedArgs = declareArgs({ assignmentId, reviewPlan: undefined });
  const inherited = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', inheritedArgs);
  assert.equal(inherited.body.revision, 2);
  assert.deepEqual(ledgerOf(ctx.f, ctx.repoKey).scopes[1].reviewPlan, selectedRequired());
  const changed = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId, reviewPlan: selectedNoReview(),
  }));
  assert.equal(changed.body.revision, 3);
  const inheritedReplay = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', inheritedArgs);
  assert.deepEqual(inheritedReplay.body, inherited.body);
  assert.deepEqual((await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', firstArgs)).body, first.body);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopes.length, 3);
  const changedBody = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', { ...inheritedArgs, reviewPlan: null });
  assert.equal(changedBody.body.code, 'IDEMPOTENCY_CONFLICT');
  const legacy = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({ assignmentId, reviewPlan: null }));
  assert.equal(legacy.body.revision, 4);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopes[3].reviewPlan, null, 'explicit null deliberately chooses the compatibility rule');
});

test('selection: no-review pins measured candidate, approves empty evidence, projects distinctly and stales after amendment', async t => {
  const ctx = await boundTrio(t);
  ctx.assignmentId = await registerPair(t, ctx);
  const declaration = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, reviewPlan: selectedNoReview(),
  }));
  assert.equal(declaration.body.ok, true, JSON.stringify(declaration.body));
  const transition = over => call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', transitionArgs({ assignmentId: ctx.assignmentId, ...over }));
  assert.equal((await transition({ transition: 'claim' })).body.ok, true);
  const unmeasured = await transition({ transition: 'submit-for-review', candidateSnapshot: CAPTURED_SNAP, candidateHead: CAPTURED_HEAD });
  assert.equal(unmeasured.body.ok, false, 'a decision alone cannot invent a candidate');
  await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId: ctx.assignmentId, agentId: 'agent-1' });
  assert.equal((await transition({ transition: 'submit-for-review', candidateSnapshot: CAPTURED_SNAP, candidateHead: CAPTURED_HEAD })).body.ok, true);
  assert.equal((await review(ctx, ctx.peer2Conn, reviewArgs({ assignmentId: ctx.assignmentId }))).body.code, 'AUTHORITY_REQUIRED');
  const observed = await transition({ transition: 'review-observed' });
  assert.equal(observed.body.ok, true, JSON.stringify(observed.body));
  assert.deepEqual(observed.body.discharged, []);
  const approval = await transition({ transition: 'approve' });
  assert.equal(approval.body.ok, true, JSON.stringify(approval.body));
  assert.deepEqual(approval.body.discharged, []);
  const status = DeskSeatStatus.parse((await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_status', {})).body);
  const scope = status.assignments.find(row => row.assignmentId === ctx.assignmentId).scopes[0];
  assert.equal(scope.reviewDecision, 'not-required');
  assert.equal(scope.reviewExempt, false);
  assert.deepEqual(scope.requiredAxes, []);
  assert.deepEqual(scope.requiredLenses, []);
  const workflow = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_workflow_get', {
    assignmentId: ctx.assignmentId, section: 'ownership', expectedLedgerRevision: null, expectedBriefRevision: null, cursor: null, limit: 20,
  });
  assert.equal(workflow.body.items[0].row.reviewPlan.kind, 'not-required');
  const redeclared = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId: ctx.assignmentId, reviewPlan: undefined,
  }));
  assert.equal(redeclared.body.revision, 2);
  assert.equal((await transition({ transition: 'advance', scopeRevision: 2 })).body.code, 'REVISION_CONFLICT');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopeTransitions.filter(row => row.to === 'approved').length, 1);
});

test('selection: store refuses a valid-shaped rewrite of the durable decision and malformed empty mandates', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  assert.equal((await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', declareArgs({
    assignmentId, reviewPlan: selectedNoReview(),
  }))).body.ok, true);
  const store = seedStore(ctx.f);
  const path = deskRepoPaths(ctx.f.stableRoot, ctx.repoKey).ledgerPath;
  const original = readFileSync(path);
  const persisted = JSON.parse(original);
  for (const plan of [selectedRequired(), { ...selectedRequired(), lenses: [] }, { ...selectedNoReview(), reason: 'Rewritten basis' }]) {
    const changed = structuredClone(persisted);
    changed.scopes[0].reviewPlan = plan;
    writeFileSync(path, JSON.stringify(changed));
    assert.equal(store.read(ctx.repoKey).state, 'corrupt', JSON.stringify(plan));
  }
  writeFileSync(path, original);
});

test('selection: historical normalized-null retries replay after new mandates without changing the effective choice', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  const store = seedStore(ctx.f);
  const runnerCtx = { repoKey: ctx.repoKey, row: ctx.lead };
  // Reproduce the old runner's durable request normalization at the public store seam.
  const historicalStore = {
    read: (...args) => store.read(...args),
    transact: (key, envelope, decide) => {
      const command = { ...envelope.command, reviewPlan: envelope.command.reviewPlan ?? null };
      delete command.reviewPlanInput;
      return store.transact(key, { ...envelope, command }, decide);
    },
  };
  const oldArgs = declareArgs({ assignmentId, reviewPlan: undefined });
  const old = await runScopeDeclare(runnerCtx, oldArgs, { store: historicalStore });
  assert.equal(old.ok, true, JSON.stringify(old));
  const next = await runScopeDeclare(runnerCtx, declareArgs({ assignmentId, reviewPlan: selectedRequired() }), { store });
  assert.equal(next.revision, 2);
  const replay = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', oldArgs);
  assert.deepEqual(replay.body, old);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).scopes[0].reviewPlan, null);
  assert.deepEqual(ledgerOf(ctx.f, ctx.repoKey).scopes[1].reviewPlan, selectedRequired());
  const altered = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', { ...oldArgs, reviewPlan: selectedNoReview() });
  assert.equal(altered.body.code, 'IDEMPOTENCY_CONFLICT');
  const explicitArgs = declareArgs({ assignmentId, reviewPlan: null });
  const explicit = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', explicitArgs);
  assert.equal(explicit.body.ok, true, JSON.stringify(explicit.body));
  const newlyOmitted = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', { ...explicitArgs, reviewPlan: undefined });
  assert.equal(newlyOmitted.body.code, 'IDEMPOTENCY_CONFLICT', 'new explicit-null request bytes cannot masquerade as omission');
});
