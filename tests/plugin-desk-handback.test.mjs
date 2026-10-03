// tests/plugin-desk-handback.test.mjs — P3-a desk handback coverage
// (contract P3-a §1/§4): slp_handback_submit plus the lead-only
// assignment tools end-to-end over the REAL Unix socket — real desk
// store, real wire frames, structural doubles only for the host SDK,
// launch-set verify and the observed-capture subprocess. Fixtures live
// under tmpdir(); the real daemon home and the repo tree are never
// touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BIN_SOURCE,
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
} from './helpers/desk-bridge-fixture.mjs';
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  createDeskStore,
} from '../plugin/server/desk-store.ts';
import { decideDeskHandback, seatAssignmentsView } from '../plugin/server/desk-handback.ts';
import { sha256Hex, canonicalSha256 } from '../plugin/server/config-view.ts';
import {
  DESK_BRIDGE_PROTOCOL,
  DeskSeatStatus,
  DeskHandbackSubmitResult,
  DeskAssignmentResult,
  DeskRejection,
  WIRE_LIMITS,
} from '../plugin/shared/enforcement.ts';

const FIXED_AT = '2026-01-01T00:00:00.000Z';
const CAPTURED_AT = '2026-01-02T00:00:00.000Z';
const PROVIDER = 'slp-codex-peer';
// Real pin: these fixtures verify packaged-binary graft integrity.
const PIN = sha256Hex(readFileSync(BIN_SOURCE));
const CAPTURED_SNAP = 'd'.repeat(64);
const CAPTURED_HEAD = 'e'.repeat(40);

const gitRepo = t => deskGitRepo(t, 'slp-hb-repo-');

/** Default capture double — a successful observed measurement. */
const captureOk = async ({ repository }) => ({
  status: 'ok',
  repository,
  measuredAt: CAPTURED_AT,
  snapshotSha256: CAPTURED_SNAP,
  head: CAPTURED_HEAD,
  incomplete: [],
});

function bridgeFixture(t, over = {}) {
  return deskBridgeFixture(t, 'slp-hb-home-', PIN, {
    ...over,
    capture: over.capture ?? captureOk,
  });
}

async function started(t, over = {}) {
  const f = await startBridge(t, bridgeFixture(t, over));
  assert.equal(f.outcome, 'listening');
  return f;
}

// ---------------------------------------------------------------------------
// seats — one repo desk carries every membership this suite needs
// ---------------------------------------------------------------------------

const memberRow = (handle, over = {}) =>
  deskMemberRow(handle, { provider: PROVIDER, at: FIXED_AT }, over);

const leadRow = (handle, over = {}) =>
  memberRow(handle, {
    membershipId: randomUUID(),
    role: 'lead',
    agentId: 'agent-lead',
    ...over,
  });

// ---------------------------------------------------------------------------
// socket helpers (same NDJSON discipline as the bridge suite)
// ---------------------------------------------------------------------------

const HELLO = (handle, over = {}) => hello(PIN, handle, over);

let rpcSeq = 0;
async function call(reader, conn, name, args) {
  rpcSeq += 1;
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: `hb-${rpcSeq}`,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const body = JSON.parse(reply.result.content[0].text);
  return { isError: reply.result.isError === true, body };
}

const livePaseo = agent => ({ agents: { ref: () => ({ refresh: async () => ({ agent }) }) } });
const LIVE_AGENT = { provider: PROVIDER, workspaceId: 'wks-1', archivedAt: null };

/** One desk with a lead seat and a peer seat; both bound over the socket. */
async function boundPair(t, over = {}) {
  const paseoRef = { current: livePaseo(over.agent ?? LIVE_AGENT) };
  const f = await started(t, { ...over, paseoRef });
  f.bridge.noteDispatch(f.paseoRef.current);
  const git = over.git ?? gitRepo(t);
  const lead = memberRow('lead-handle', { role: 'lead', agentId: 'agent-lead' });
  const peer = memberRow('peer-handle', { role: 'peer', agentId: 'agent-1' });
  const repoKey = await seedMemberships(seedStore(f), repoOf(git), [lead, peer]);
  const leadConn = await handshake(f.paths.socketPath, HELLO('lead-handle'));
  const peerConn = await handshake(f.paths.socketPath, HELLO('peer-handle'));
  t.after(() => { leadConn.conn.destroy(); peerConn.conn.destroy(); });
  assert.equal(leadConn.ack.ok, true, `lead hello rejected: ${JSON.stringify(leadConn.ack)}`);
  assert.equal(peerConn.ack.ok, true, `peer hello rejected: ${JSON.stringify(peerConn.ack)}`);
  return { f, git, repo: repoOf(git), repoKey, lead, peer, leadConn, peerConn, paseoRef };
}

/** Register + attach an assignment as the lead; returns assignmentId. */
async function registerAndAttach(t, { leadConn, peer }, agentId = 'agent-1') {
  const reg = await call(leadConn.reader, leadConn.conn, 'slp_assignment_register', {
    requestId: `reg-${randomUUID()}`,
    authorityRef: 'grant:test',
    objective: 'bounded task',
  });
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  const parsed = DeskAssignmentResult.parse(reg.body);
  assert.equal(parsed.state, 'open');
  const att = await call(leadConn.reader, leadConn.conn, 'slp_assignment_attach', {
    requestId: `att-${randomUUID()}`,
    assignmentId: parsed.assignmentId,
    agentId,
  });
  assert.equal(att.body.ok, true, JSON.stringify(att.body));
  const attached = DeskAssignmentResult.parse(att.body);
  assert.equal(attached.seat.agentId, agentId);
  return parsed.assignmentId;
}

const EVIDENCE = 'ok\n';
const EVIDENCE_SHA = sha256Hex(EVIDENCE);
const goodRecord = (over = {}) => ({
  version: 1,
  kind: 'handback',
  seat: { role: 'peer', disposition: 'engineer', agentId: 'agent-1' },
  verdict: 'APPROVE',
  candidate: { repository: '/repo', snapshotSha256: 'c'.repeat(64) },
  checks: [{ cmd: 'npm test', exit: 0, sha: EVIDENCE_SHA, output: EVIDENCE }],
  ...over,
});

const ledgerOf = (f, repoKey) => {
  const read = seedStore(f).read(repoKey);
  assert.equal(read.state, 'ok');
  return read.ledger;
};

// ---------------------------------------------------------------------------
// catalog + strict input
// ---------------------------------------------------------------------------

test('slp_handback_submit is a visible mutation; P4+/hidden entries stay absent or typed-rejected', async t => {
  const { peerConn } = await boundPair(t);
  const list = await rpc(peerConn.reader, peerConn.conn, { jsonrpc: '2.0', id: 'l1', method: 'tools/list' });
  const tools = list.result.tools;
  const submit = tools.find(tool => tool.name === 'slp_handback_submit');
  assert.ok(submit, 'handback submit is visible');
  const names = tools.map(tool => tool.name);
  for (const forbidden of ['slp_recover_lock', 'slp_desk_internal', 'slp_review_open', 'slp_decision_record']) {
    assert.ok(!names.includes(forbidden), `${forbidden} absent`);
  }
  // An excluded tool is a typed rejection, not a silent no-op.
  const absent = await call(peerConn.reader, peerConn.conn, 'slp_decision_record', {});
  assert.equal(absent.body.code, 'INVALID_RECORD');
});

test('submit input is strict — extra fields reject INVALID_RECORD', async t => {
  const { peerConn } = await boundPair(t);
  const reply = await call(peerConn.reader, peerConn.conn, 'slp_handback_submit', {
    requestId: 'r1', assignmentId: 'asg-x', recordV1: goodRecord(), candidateId: null, actorId: 'spoof',
  });
  assert.equal(reply.body.ok, false);
  assert.equal(reply.body.code, 'INVALID_RECORD');
});

// ---------------------------------------------------------------------------
// assignment authority — lead-only register/attach/close (X2/X3)
// ---------------------------------------------------------------------------

test('a peer cannot register or attach an assignment', async t => {
  const { peerConn } = await boundPair(t);
  const reg = await call(peerConn.reader, peerConn.conn, 'slp_assignment_register', {
    requestId: 'reg-peer', authorityRef: 'grant:x', objective: null,
  });
  assert.equal(reg.body.code, 'AUTHORITY_REQUIRED');
  const att = await call(peerConn.reader, peerConn.conn, 'slp_assignment_attach', {
    requestId: 'att-peer', assignmentId: 'asg-any', agentId: 'agent-1',
  });
  assert.equal(att.body.code, 'AUTHORITY_REQUIRED');
});

test('register → attach → close commit durable, hash-chained rows', async t => {
  const { f, repoKey, leadConn } = await boundPair(t);
  const reg = await call(leadConn.reader, leadConn.conn, 'slp_assignment_register', {
    requestId: 'reg-1', authorityRef: 'grant:notebook-1', objective: 'build the thing',
  });
  assert.equal(reg.body.ok, true);
  const parsed = DeskAssignmentResult.parse(reg.body);
  assert.match(parsed.assignmentId, /^asg-[0-9a-f]{32}$/);
  const ledger = ledgerOf(f, repoKey);
  const row = ledger.assignments.find(a => a.assignmentId === parsed.assignmentId);
  assert.ok(row, 'assignment row is durable');
  assert.equal(row.authorityRef, 'grant:notebook-1');
  assert.equal(row.ownerAgentId, 'agent-lead');
  assert.equal(row.state, 'open');
  const kinds = readdirEvents(f, repoKey).map(e => e.kind);
  assert.ok(kinds.includes('assignment-registered'), 'the register event is hash-chained');

  const close = await call(leadConn.reader, leadConn.conn, 'slp_assignment_close', {
    requestId: 'close-1', assignmentId: parsed.assignmentId,
  });
  assert.equal(close.body.ok, true);
  assert.equal(DeskAssignmentResult.parse(close.body).state, 'closed');
  assert.equal(ledgerOf(f, repoKey).assignments.find(a => a.assignmentId === parsed.assignmentId).state, 'closed');
});

test('a lead who is not the owner cannot attach or close', async t => {
  const { f, leadConn, repo, repoKey } = await boundPair(t);
  // A second lead bound to a different handle, same desk.
  const other = memberRow('lead2-handle', { role: 'lead', agentId: 'agent-lead-2' });
  const ledger = ledgerOf(f, repoKey);
  await seedMemberships(seedStore(f), repo, [...ledger.memberships, other]);
  const lead2 = await handshake(f.paths.socketPath, HELLO('lead2-handle'));
  t.after(() => lead2.conn.destroy());
  assert.equal(lead2.ack.ok, true);

  const reg = await call(leadConn.reader, leadConn.conn, 'slp_assignment_register', {
    requestId: 'reg-owner', authorityRef: 'grant:x', objective: null,
  });
  const assignmentId = DeskAssignmentResult.parse(reg.body).assignmentId;
  const att = await call(lead2.reader, lead2.conn, 'slp_assignment_attach', {
    requestId: 'att-x', assignmentId, agentId: 'agent-1',
  });
  assert.equal(att.body.code, 'AUTHORITY_REQUIRED');
  const close = await call(lead2.reader, lead2.conn, 'slp_assignment_close', {
    requestId: 'close-x', assignmentId,
  });
  assert.equal(close.body.code, 'AUTHORITY_REQUIRED');
});

// ---------------------------------------------------------------------------
// submit — happy path, durable rows, replay, conflict
// ---------------------------------------------------------------------------

test('submit commits the claim verbatim, attaches the observed candidate, and returns revision/receipt/gaps', async t => {
  const ctx = await boundPair(t);
  const assignmentId = await registerAndAttach(t, ctx);
  const reply = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-1', assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  const result = DeskHandbackSubmitResult.parse(reply.body);
  assert.equal(result.revision, 1);
  assert.match(result.handbackId, /^hb-[0-9a-f]{32}$/);
  assert.match(result.observedCandidateId, /^cand-[0-9a-f]{32}$/);
  assert.deepEqual(result.gaps, []);

  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const row = ledger.handbacks.find(h => h.handbackId === result.handbackId);
  assert.ok(row, 'the handback row is durable');
  assert.equal(row.revision, 1);
  assert.equal(row.agentId, 'agent-1');
  assert.equal(row.recordSha256, canonicalSha256(goodRecord()));
  assert.deepEqual(row.record, goodRecord(), 'the claim is stored verbatim');
  assert.equal(row.observed.status, 'ok');
  const candidate = ledger.candidates.find(c => c.candidateId === result.observedCandidateId);
  assert.ok(candidate, 'the observed candidate row exists');
  assert.equal(candidate.kind, 'observed');
  assert.equal(candidate.snapshotSha256, CAPTURED_SNAP);
  assert.equal(candidate.head, CAPTURED_HEAD);
  assert.equal(candidate.assignmentId, assignmentId);
  assert.equal(candidate.repository, '/repo', 'the measured root is the membership createCwd');
});

test('replay of the same input returns the recorded response; a different body is IDEMPOTENCY_CONFLICT', async t => {
  const ctx = await boundPair(t);
  const assignmentId = await registerAndAttach(t, ctx);
  const input = { requestId: 'hb-replay', assignmentId, recordV1: goodRecord(), candidateId: null };
  const first = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', input);
  assert.equal(first.body.ok, true);
  const again = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', input);
  assert.equal(again.body.ok, true);
  assert.equal(again.body.receiptId, first.body.receiptId);
  assert.equal(again.body.handbackId, first.body.handbackId);
  assert.equal(again.body.revision, first.body.revision);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(ledger.handbacks.length, 1, 'no second row');
  assert.equal(ledger.candidates.length, 1, 'no second candidate');

  const conflict = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    ...input, recordV1: goodRecord({ verdict: 'FINDINGS' }),
  });
  assert.equal(conflict.body.ok, false);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).handbacks.length, 1);
});

test('a second requestId mints an immutable second revision — the first row is untouched', async t => {
  const ctx = await boundPair(t);
  const assignmentId = await registerAndAttach(t, ctx);
  const first = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-a', assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  const second = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-b', assignmentId, recordV1: goodRecord({ verdict: 'FINDINGS' }), candidateId: null,
  });
  assert.equal(first.body.revision, 1);
  assert.equal(second.body.revision, 2);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const rows = ledger.handbacks.filter(h => h.agentId === 'agent-1').sort((a, b) => a.revision - b.revision);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].record, goodRecord(), 'revision 1 keeps its claim');
  assert.equal(rows[0].observed.status, 'ok');
});

// ---------------------------------------------------------------------------
// submit — authority and validation rejections
// ---------------------------------------------------------------------------

test('submit rejects: unbound seat, unknown assignment, closed assignment', async t => {
  const ctx = await boundPair(t);
  // Unbound — no assignment registered yet and the peer is attached nowhere.
  const unbound = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-x', assignmentId: 'asg-missing', recordV1: goodRecord(), candidateId: null,
  });
  assert.equal(unbound.body.code, 'AUTHORITY_REQUIRED');

  const assignmentId = await registerAndAttach(t, ctx);
  // A second peer that is bound but NOT attached to this assignment.
  const stray = memberRow('stray-handle', { agentId: 'agent-stray' });
  await seedMemberships(seedStore(ctx.f), ctx.repo, [...ledgerOf(ctx.f, ctx.repoKey).memberships, stray]);
  const strayConn = await handshake(ctx.f.paths.socketPath, HELLO('stray-handle'));
  t.after(() => strayConn.conn.destroy());
  const notAttached = await call(strayConn.reader, strayConn.conn, 'slp_handback_submit', {
    requestId: 'hb-y', assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  assert.equal(notAttached.body.code, 'AUTHORITY_REQUIRED');

  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_close', {
    requestId: 'close-1', assignmentId,
  });
  const closed = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-z', assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  assert.equal(closed.body.code, 'AUTHORITY_REQUIRED');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).handbacks.length, 0);
});

test('an invalid recordV1 rejects INVALID_RECORD and writes no handback row', async t => {
  const ctx = await boundPair(t);
  const assignmentId = await registerAndAttach(t, ctx);
  const reply = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-bad', assignmentId, recordV1: { version: 1, kind: 'handback' }, candidateId: null,
  });
  assert.equal(reply.body.ok, false);
  assert.equal(reply.body.code, 'INVALID_RECORD');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).handbacks.length, 0);
});

test('a settlement-kind recordV1 rejects INVALID_RECORD — this surface is handback-only', async t => {
  const ctx = await boundPair(t);
  const assignmentId = await registerAndAttach(t, ctx);
  const reply = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-settle', assignmentId, recordV1: goodRecord({ kind: 'settlement' }), candidateId: null,
  });
  assert.equal(reply.body.code, 'INVALID_RECORD');
});

test('candidateId must resolve to a candidate of the same assignment', async t => {
  const ctx = await boundPair(t);
  const asgA = await registerAndAttach(t, ctx);
  const first = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-c1', assignmentId: asgA, recordV1: goodRecord(), candidateId: null,
  });
  const foreign = first.body.observedCandidateId;
  // Register a second assignment; the foreign candidate belongs to A.
  const regB = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_register', {
    requestId: 'reg-b', authorityRef: 'grant:b', objective: null,
  });
  const asgB = DeskAssignmentResult.parse(regB.body).assignmentId;
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_attach', {
    requestId: 'att-b', assignmentId: asgB, agentId: 'agent-1',
  });
  const bogus = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-c2', assignmentId: asgB, recordV1: goodRecord(), candidateId: 'cand-missing',
  });
  assert.equal(bogus.body.code, 'INVALID_RECORD');
  const cross = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-c3', assignmentId: asgB, recordV1: goodRecord(), candidateId: foreign,
  });
  assert.equal(cross.body.code, 'INVALID_RECORD');
  // Same-assignment resolution is accepted.
  const legit = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-c4', assignmentId: asgA, recordV1: goodRecord(), candidateId: foreign,
  });
  assert.equal(legit.body.ok, true);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).handbacks.find(h => h.requestId === 'hb-c4').claimedCandidateId, foreign);
});

// ---------------------------------------------------------------------------
// observed capture — failure lands as gaps, never as a rejection (X4)
// ---------------------------------------------------------------------------

test('a failed capture commits with gaps and observed.status failed — no candidate row', async t => {
  const ctx = await boundPair(t, {
    capture: async ({ repository }) => ({
      status: 'failed', repository, measuredAt: CAPTURED_AT, reason: 'timeout', detail: 'capture exceeded the bound',
    }),
  });
  const assignmentId = await registerAndAttach(t, ctx);
  const reply = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-fail', assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  const result = DeskHandbackSubmitResult.parse(reply.body);
  assert.equal(result.observedCandidateId, null);
  assert.ok(result.gaps.some(g => g.startsWith('observed-capture-failed:timeout')));
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const row = ledger.handbacks[0];
  assert.equal(row.observed.status, 'failed');
  assert.match(row.observed.error, /timeout/);
  assert.equal(ledger.candidates.length, 0);
});

test('the capture subprocess runs under the bound runtime with the seat createCwd', async t => {
  const seen = [];
  const ctx = await boundPair(t, {
    capture: async deps => {
      seen.push({ ...deps });
      return captureOk(deps);
    },
  });
  const assignmentId = await registerAndAttach(t, ctx);
  await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-cap', assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].repository, '/repo');
  assert.equal(seen[0].nodePath, process.execPath);
  assert.match(seen[0].runtimePath, /slp-runtime/);
});

test('a crash between the claim commit and the observe commit converges on retry', async t => {
  let armed = false;
  let captured = false;
  const ctx = await boundPair(t, {
    createStore: root => createDeskStore({
      stableRoot: root,
      faults: { segmentRenamed: () => { if (armed) throw new Error('boom before ledger rename'); } },
    }),
    capture: async deps => {
      // The claim commit has already landed; arm the observe commit to crash —
      // once only, so the retry's observe commit is clean.
      if (!captured) { captured = true; armed = true; }
      return captureOk(deps);
    },
  });
  const assignmentId = await registerAndAttach(t, ctx);
  const reply = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-crash', assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  // The observe commit failed mid-write — the response is a typed error, but
  // the claim row is durable with a pending observation.
  assert.equal(reply.isError, true);
  const crashed = ledgerOf(ctx.f, ctx.repoKey);
  const pending = crashed.handbacks.find(h => h.requestId === 'hb-crash');
  assert.ok(pending, 'the claim survived the crash');
  assert.equal(pending.observed.status, 'pending');
  assert.equal(crashed.candidates.length, 0);

  armed = false;
  const retry = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-crash', assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  assert.equal(retry.body.ok, true, JSON.stringify(retry.body));
  assert.equal(retry.body.handbackId, pending.handbackId);
  assert.equal(retry.body.revision, 1);
  assert.match(retry.body.observedCandidateId, /^cand-/);
  const healed = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(healed.handbacks.length, 1, 'retry did not duplicate the claim');
  assert.equal(healed.candidates.length, 1);
});

// ---------------------------------------------------------------------------
// status scoping (X7) + no auto-* (X8)
// ---------------------------------------------------------------------------

test('slp_status is caller-scoped: a seat sees only its own handbacks, the owner lead sees the assignment stream', async t => {
  const ctx = await boundPair(t);
  const assignmentId = await registerAndAttach(t, ctx);
  await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-s1', assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  // The submitting peer sees its assignment and its own handback.
  const peerStatus = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_status', {});
  const peerView = DeskSeatStatus.parse(JSON.parse(JSON.stringify(peerStatus.body)));
  assert.equal(peerView.assignments.length, 1);
  assert.equal(peerView.assignments[0].assignmentId, assignmentId);
  assert.equal(peerView.assignments[0].handbacks.length, 1);
  assert.equal(peerView.assignments[0].handbacks[0].agentId, 'agent-1');
  assert.equal(peerView.assignments[0].handbacks[0].observedStatus, 'ok');
  // The owner lead sees the same stream.
  const leadStatus = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_status', {});
  const leadView = DeskSeatStatus.parse(leadStatus.body);
  assert.equal(leadView.assignments.length, 1);
  assert.equal(leadView.assignments[0].handbacks.length, 1);
  // A bound-but-unattached seat sees nothing of this assignment.
  const stray = memberRow('stray-handle', { agentId: 'agent-stray' });
  await seedMemberships(seedStore(ctx.f), ctx.repo, [...ledgerOf(ctx.f, ctx.repoKey).memberships, stray]);
  const strayConn = await handshake(ctx.f.paths.socketPath, HELLO('stray-handle'));
  t.after(() => strayConn.conn.destroy());
  const strayStatus = await call(strayConn.reader, strayConn.conn, 'slp_status', {});
  const strayView = DeskSeatStatus.parse(strayStatus.body);
  assert.deepEqual(strayView.assignments, []);
  // No view carries a claimed record body — the record bytes stay server-side.
  assert.equal('record' in peerView.assignments[0].handbacks[0], false);
});

test('a submit mutates only the handback surface — memberships and other tables are untouched', async t => {
  const ctx = await boundPair(t);
  const before = ledgerOf(ctx.f, ctx.repoKey);
  const assignmentId = await registerAndAttach(t, ctx);
  await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'hb-iso', assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  const after = ledgerOf(ctx.f, ctx.repoKey);
  assert.deepEqual(after.memberships, before.memberships, 'no seat state drifted');
  assert.equal(after.assignments.length, before.assignments.length + 1);
  assert.equal(after.assignments.at(-1).state, 'open', 'submit never closes an assignment');
});

// Read the hash-chained event segment files for a repo desk.
function readdirEvents(f, repoKey) {
  const dir = join(f.stableRoot, 'state', 'enforcement', 'repos', repoKey, 'events');
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').trim().split('\n')) {
      out.push(JSON.parse(line));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// seatAssignmentsView — the projection's limitation aggregate is bounded by
// the wire schema's own cap: elision is reported as counting markers, never
// one line per dropped row (an over-cap aggregate would fail DeskSeatStatus
// and turn a readable desk into EXECUTION_UNKNOWN).
// ---------------------------------------------------------------------------

test('seatAssignmentsView: a saturated projection stays inside the limitation caps with elision counted', () => {
  const limits = {
    assignments: WIRE_LIMITS.deskStatusAssignments,
    seats: WIRE_LIMITS.deskStatusSeats,
    handbacks: WIRE_LIMITS.deskStatusHandbacks,
  };
  const leadRow = {
    membershipId: '00000000-0000-0000-0000-000000000000',
    agentId: 'agent-lead',
    state: 'host-confirmed',
    registeredAt: FIXED_AT,
    role: 'lead',
  };
  const ledger = {
    memberships: [leadRow],
    ownershipOffers: [],
    ownershipAccepts: [],
    assignments: Array.from({ length: 80 }, (_, i) => ({
      assignmentId: `asg-${i}`,
      ownerAgentId: 'agent-lead',
      ownerMembershipId: leadRow.membershipId,
      state: 'open',
      seats: Array.from({ length: 33 }, (unused, j) => ({ agentId: `seat-${i}-${j}` })),
    })),
    handbacks: [],
  };
  const projection = seatAssignmentsView(
    ledger,
    leadRow,
    limits,
  );
  assert.equal(projection.assignments.length, 64);
  // Three marker classes at most — never one entry per elided row.
  assert.ok(projection.limitations.length <= 3);
  assert.ok(projection.limitations.length <= WIRE_LIMITS.deskBridgeLimitations);
  for (const line of projection.limitations) {
    assert.ok(line.length <= WIRE_LIMITS.limitationLen, line);
  }
  assert.ok(projection.limitations.some(l => l.includes('16 assignment(s) not shown')), JSON.stringify(projection.limitations));
  assert.ok(projection.limitations.some(l => l.includes('64 assignment(s) have seat lists truncated')), JSON.stringify(projection.limitations));
  // The assembled wire view parses — the aggregate can never make the status
  // reply fail its own schema.
  const view = {
    schemaVersion: 1,
    generatedAt: FIXED_AT,
    seat: {
      membershipId: '00000000-0000-0000-0000-000000000000',
      agentId: 'agent-lead',
      state: 'host-confirmed',
      family: 'codex',
      role: 'lead',
      provider: PROVIDER,
      workspaceId: null,
      createCwd: '/repo',
      openGeneration: 1,
      createdAt: FIXED_AT,
      hostConfirmedAt: FIXED_AT,
      registeredAt: FIXED_AT,
    },
    desk: { repoKey: 'a'.repeat(64), state: 'available', protocol: DESK_BRIDGE_PROTOCOL },
    // seatAssignmentsView projects the handback half; the bridge merges the
    // settlement and scope projections onto each row — empty arrays are what
    // that merge emits for a scope-less fixture.
    assignments: projection.assignments.map(assignment => ({ ...assignment, settlements: [], scopes: [], checkDefinitions: [], rollouts: [] })),
    limitations: projection.limitations,
    acceptance: 'not-established-by-this-view',
  };
  DeskSeatStatus.parse(view);
});

// ---------------------------------------------------------------------------
// r2 — replay survives a membership rebind: resolvers key on durable
// request fields, never the live membershipId a rebind replaces.
// ---------------------------------------------------------------------------

test('register replay after a lead membership rebind resolves the same assignment', async t => {
  const { f, repo, repoKey, lead, leadConn } = await boundPair(t);
  const requestId = `reg-${randomUUID()}`;
  const args = { requestId, authorityRef: 'grant:rebind', objective: 'rebind test' };
  const first = await call(leadConn.reader, leadConn.conn, 'slp_assignment_register', args);
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  const assignmentId = first.body.assignmentId;

  // Rebind: revoke the live lead membership and install a fresh row for
  // the same agentId — new membershipId, new handle. The assignment keeps
  // its recorded ownerMembershipId pointing at the revoked row.
  const rebound = memberRow('lead-handle-2', { role: 'lead', agentId: 'agent-lead' });
  const reseed = await seedStore(f).transact(
    repoKey,
    { repo, actorKey: 'desk:hook', assignmentId: 'unassigned', requestId: randomUUID(), command: { kind: 'seed' } },
    ledger => ({
      ok: true,
      events: [],
      memberships: [
        ...ledger.memberships.map(m =>
          m.membershipId === lead.membershipId
            ? { ...m, state: 'revoked', revokedAt: FIXED_AT, revokeReason: 'archived' }
            : m),
        rebound,
      ],
    }),
  );
  assert.ok(reseed.ok, `rebind seed failed: ${JSON.stringify(reseed)}`);

  const conn2 = await handshake(f.paths.socketPath, HELLO('lead-handle-2'));
  t.after(() => conn2.conn.destroy());
  assert.equal(conn2.ack.ok, true, `rebound hello rejected: ${JSON.stringify(conn2.ack)}`);
  const replay = await call(conn2.reader, conn2.conn, 'slp_assignment_register', args);
  assert.equal(replay.body.ok, true, `replay must resolve the recorded row: ${JSON.stringify(replay.body)}`);
  assert.equal(replay.body.assignmentId, assignmentId);
  // The replay never appended a second assignment — one row per requestId.
  const ledger = ledgerOf(f, repoKey);
  assert.equal(ledger.assignments.filter(a => a.requestId === requestId).length, 1);
  // A different body under the same requestId is an idempotency conflict.
  const conflict = await call(conn2.reader, conn2.conn, 'slp_assignment_register', {
    ...args, authorityRef: 'grant:changed',
  });
  assert.equal(conflict.body.ok, false);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
});

test('submit replay after a peer membership rebind resolves the same handback row', async t => {
  const { f, repo, repoKey, peer, leadConn, peerConn } = await boundPair(t);
  const assignmentId = await registerAndAttach(t, { leadConn, peer });
  const requestId = `sub-${randomUUID()}`;
  const args = { requestId, assignmentId, recordV1: goodRecord(), candidateId: null };
  const first = await call(peerConn.reader, peerConn.conn, 'slp_handback_submit', args);
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  const firstParsed = DeskHandbackSubmitResult.parse(first.body);

  const rebound = memberRow('peer-handle-2', { agentId: 'agent-1' });
  const reseed = await seedStore(f).transact(
    repoKey,
    { repo, actorKey: 'desk:hook', assignmentId: 'unassigned', requestId: randomUUID(), command: { kind: 'seed' } },
    ledger => ({
      ok: true,
      events: [],
      memberships: [
        ...ledger.memberships.map(m =>
          m.membershipId === peer.membershipId
            ? { ...m, state: 'revoked', revokedAt: FIXED_AT, revokeReason: 'archived' }
            : m),
        rebound,
      ],
    }),
  );
  assert.ok(reseed.ok, `rebind seed failed: ${JSON.stringify(reseed)}`);

  const conn2 = await handshake(f.paths.socketPath, HELLO('peer-handle-2'));
  t.after(() => conn2.conn.destroy());
  assert.equal(conn2.ack.ok, true, `rebound hello rejected: ${JSON.stringify(conn2.ack)}`);
  const replay = await call(conn2.reader, conn2.conn, 'slp_handback_submit', args);
  assert.equal(replay.body.ok, true, `replay must resolve the recorded row: ${JSON.stringify(replay.body)}`);
  const replayParsed = DeskHandbackSubmitResult.parse(replay.body);
  assert.equal(replayParsed.handbackId, firstParsed.handbackId);
  assert.equal(replayParsed.revision, firstParsed.revision);
  assert.equal(replayParsed.observedCandidateId, firstParsed.observedCandidateId);
  // No second handback row — the stream stays one revision deep.
  const ledger = ledgerOf(f, repoKey);
  assert.equal(
    ledger.handbacks.filter(h => h.assignmentId === assignmentId && h.agentId === 'agent-1').length,
    1,
  );
});

test('derived assignment ids never alias on delimiter-embedded fields', async t => {
  const { f, repo, repoKey, leadConn } = await boundPair(t);
  // Delimiter-injection control: ('agent-lead|x','y') and ('agent-lead',
  // 'x|y') collide only under a '|'-joined key — the original defect was
  // bare concat, under which they do NOT collide; the bare-concat classes
  // are covered by the 'asg'/'hb' alias tests below.
  const odd = memberRow('odd-handle', { role: 'lead', agentId: 'agent-lead|x' });
  const seeded = await seedStore(f).transact(
    repoKey,
    { repo, actorKey: 'desk:hook', assignmentId: 'unassigned', requestId: randomUUID(), command: { kind: 'seed' } },
    ledger => ({ ok: true, events: [], memberships: [...ledger.memberships, odd] }),
  );
  assert.ok(seeded.ok, `odd-lead seed failed: ${JSON.stringify(seeded)}`);
  const oddConn = await handshake(f.paths.socketPath, HELLO('odd-handle'));
  t.after(() => oddConn.conn.destroy());
  assert.equal(oddConn.ack.ok, true, `odd hello rejected: ${JSON.stringify(oddConn.ack)}`);

  const one = await call(oddConn.reader, oddConn.conn, 'slp_assignment_register', {
    requestId: 'y', authorityRef: 'grant:a', objective: null,
  });
  assert.equal(one.body.ok, true, JSON.stringify(one.body));
  const two = await call(leadConn.reader, leadConn.conn, 'slp_assignment_register', {
    requestId: 'x|y', authorityRef: 'grant:b', objective: null,
  });
  // Under a join('|') deriveId this second register collides with the
  // first derived id and is refused INVALID_RECORD.
  assert.equal(two.body.ok, true, `concat-aliased tuples must mint distinct ids: ${JSON.stringify(two.body)}`);
  assert.notEqual(two.body.assignmentId, one.body.assignmentId);
  const ledger = ledgerOf(f, repoKey);
  assert.equal(ledger.assignments.length, 2);
});

// ---------------------------------------------------------------------------
// r2-proof — the ORIGINAL bare-concat defect class on deriveId. join("")
// aliases split-boundary ("ab"+"c" == "a"+"bc") and digit ("a1"+23 ==
// "a"+123) shifts; only canonical-JSON tuple encoding keeps them distinct.
// The '|' test above stays as the delimiter-injection control.
// ---------------------------------------------------------------------------

test("derived 'asg' ids stay distinct under bare-concat split-boundary and digit aliases", async t => {
  const { f, repo, repoKey, leadConn } = await boundPair(t);
  // Three extra leads covering both bare-concat classes:
  //   digit          ('a1','23') ~ ('a','123') → "a123"
  //   split-boundary ('ab','c')  ~ ('a','bc')  → "abc"
  const extra = [
    memberRow('lead-a1-handle', { role: 'lead', agentId: 'a1' }),
    memberRow('lead-ab-handle', { role: 'lead', agentId: 'ab' }),
    memberRow('lead-a-handle', { role: 'lead', agentId: 'a' }),
  ];
  const seeded = await seedStore(f).transact(
    repoKey,
    { repo, actorKey: 'desk:hook', assignmentId: 'unassigned', requestId: randomUUID(), command: { kind: 'seed' } },
    ledger => ({ ok: true, events: [], memberships: [...ledger.memberships, ...extra] }),
  );
  assert.ok(seeded.ok, `extra leads seed failed: ${JSON.stringify(seeded)}`);
  const conns = {};
  for (const [name, handle] of [['a1', 'lead-a1-handle'], ['ab', 'lead-ab-handle'], ['a', 'lead-a-handle']]) {
    const c = await handshake(f.paths.socketPath, HELLO(handle));
    t.after(() => c.conn.destroy());
    assert.equal(c.ack.ok, true, `${name} hello rejected: ${JSON.stringify(c.ack)}`);
    conns[name] = c;
  }
  const register = (conn, requestId) =>
    call(conn.reader, conn.conn, 'slp_assignment_register', {
      requestId, authorityRef: 'grant:alias', objective: null,
    });
  const d1 = await register(conns.a1, '23');
  const d2 = await register(conns.a, '123');
  const s1 = await register(conns.ab, 'c');
  const s2 = await register(conns.a, 'bc');
  for (const [label, res] of [['digit-1', d1], ['digit-2', d2], ['split-1', s1], ['split-2', s2]]) {
    assert.equal(res.body.ok, true, `${label} refused — bare-concat alias: ${JSON.stringify(res.body)}`);
  }
  const ids = new Set([d1.body.assignmentId, d2.body.assignmentId, s1.body.assignmentId, s2.body.assignmentId]);
  assert.equal(ids.size, 4, 'four concat-aliased tuples must mint four distinct ids');
  assert.equal(ledgerOf(f, repoKey).assignments.length, 4);
});

test("derived 'hb' ids stay distinct under bare-concat aliases at both tuple boundaries", async t => {
  // Decide-level: the bridge can never fabricate these because real
  // assignmentIds are derived 'asg-<hash>' — the fixture exercises the
  // free-form boundary the pure decide must still encode unambiguously.
  const seat = agentId => ({
    membershipId: randomUUID(), agentId, role: 'peer', state: 'host-confirmed',
    registeredAt: FIXED_AT, createCwd: '/repo', workspaceId: 'wks-1',
  });
  const asg = (assignmentId, seats) => ({
    assignmentId, requestId: `req-${assignmentId}`, authorityRef: 'grant:x',
    objective: null, ownerMembershipId: randomUUID(), ownerAgentId: 'lead',
    workspaceId: 'wks-1', state: 'open',
    seats,
  });
  const mAb = seat('ab');
  const mA = seat('a');
  const ledger = {
    memberships: [mAb, mA],
    assignments: [
      // 'a' is attached to 'asg-1' too — boundary-2 needs the same agent
      // submitting against two prefix-shifting assignment ids.
      asg('asg-1', [
        { agentId: 'ab', membershipId: mAb.membershipId },
        { agentId: 'a', membershipId: mA.membershipId },
      ]),
      asg('basg-1', [{ agentId: 'a', membershipId: mA.membershipId }]),
      asg('asg-1b', [{ agentId: 'a', membershipId: mA.membershipId }]),
    ],
    candidates: [],
    handbacks: [],
  };
  const submit = (actorAgentId, assignmentId, requestId) =>
    decideDeskHandback(ledger, {
      kind: 'handback.submit', actorAgentId, assignmentId, requestId,
      recordV1: goodRecord(), candidateId: null,
    });
  // Boundary 1 (agent|asg): ('ab','asg-1','x') ~ ('a','basg-1','x') → "abasg-1x".
  const b1a = submit('ab', 'asg-1', 'x');
  const b1b = submit('a', 'basg-1', 'x');
  // Boundary 2 (asg|req): ('a','asg-1','bc') ~ ('a','asg-1b','c') → "aasg-1bc".
  const b2a = submit('a', 'asg-1b', 'c');
  const b2b = submit('a', 'asg-1', 'bc');
  for (const [label, res] of [['b1a', b1a], ['b1b', b1b], ['b2a', b2a], ['b2b', b2b]]) {
    assert.equal(res.ok, true, `${label} refused: ${JSON.stringify(res)}`);
  }
  const ids = new Set([
    b1a.handbacks.at(-1).handbackId,
    b1b.handbacks.at(-1).handbackId,
    b2a.handbacks.at(-1).handbackId,
    b2b.handbacks.at(-1).handbackId,
  ]);
  assert.equal(ids.size, 4, 'concat-aliased tuples must mint distinct handback ids');
});

// ---------------------------------------------------------------------------
// r3 — mutation-result wire parity (F-STD-4). The durable gaps cap is
// WIRE_LIMITS.gapLen (256); a submit replay returns the durable row's gaps
// verbatim, so a ledger-valid row at the durable maximum must still parse
// under DeskHandbackSubmitResult. The seeds below use the real transact
// state channel: the request tuple/body matches what the submit runner
// builds, so the store replays the recorded receipt and the runner
// re-derives the response from the durable row.
// ---------------------------------------------------------------------------

const seedSubmit = (ctx, requestId, assignmentId, record, row) =>
  seedStore(ctx.f).transact(
    ctx.repoKey,
    {
      repo: ctx.repo,
      actorKey: 'agent:agent-1',
      assignmentId,
      requestId,
      command: {
        kind: 'handback.submit', requestId, actorAgentId: 'agent-1',
        assignmentId, recordV1: record, candidateId: null,
      },
    },
    ledger => ({
      ok: true,
      events: [],
      assignments: [...ledger.assignments, {
        assignmentId, requestId: `req-asg-${assignmentId}`, authorityRef: 'grant:test', objective: null,
        ownerMembershipId: ctx.lead.membershipId, ownerAgentId: 'agent-lead', workspaceId: 'wks-1',
        state: 'open', seats: [{ agentId: 'agent-1', membershipId: ctx.peer.membershipId }],
      }],
      handbacks: [...ledger.handbacks, {
        handbackId: `hb-${requestId}`, assignmentId, agentId: 'agent-1',
        seatMembershipId: ctx.peer.membershipId, requestId, revision: 1,
        record, recordSha256: canonicalSha256(record), claimedCandidateId: null,
        observed: row.observed, gaps: row.gaps,
      }],
    }),
  );

test('submit replay over a durable-max gaps row answers a schema-valid result (F-STD-4)', async t => {
  const ctx = await boundPair(t);
  const record = goodRecord();
  const gaps = Array.from({ length: 16 }, (_, i) => `gap-${i}`.padEnd(WIRE_LIMITS.gapLen, 'g'));
  const seeded = await seedSubmit(ctx, 'req-gap', 'asg-gap', record, {
    observed: { status: 'failed', candidateId: null, repository: '/repo', measuredAt: CAPTURED_AT, error: 'exit: capture exited 2' },
    gaps,
  });
  assert.equal(seeded.ok, true, `seed commit failed: ${JSON.stringify(seeded)}`);

  const reply = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'req-gap', assignmentId: 'asg-gap', recordV1: record, candidateId: null,
  });
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  const parsed = DeskHandbackSubmitResult.parse(reply.body);
  assert.equal(parsed.gaps.length, 16);
  assert.equal(parsed.gaps[0].length, WIRE_LIMITS.gapLen, 'durable gaps return verbatim — never truncated');
  assert.equal(parsed.handbackId, 'hb-req-gap');
  assert.equal(parsed.observedCandidateId, null);
});

test('submit replay of a pending row appends the observe marker and still parses', async t => {
  const ctx = await boundPair(t, {
    capture: async ({ repository }) => ({
      status: 'failed', repository, measuredAt: CAPTURED_AT, reason: 'exit', detail: 'probe exited 2',
    }),
  });
  const record = goodRecord();
  const seeded = await seedSubmit(ctx, 'req-pend', 'asg-pend', record, {
    observed: { status: 'pending', candidateId: null, repository: '/repo', measuredAt: null, error: null },
    gaps: ['durable-gap'.padEnd(WIRE_LIMITS.gapLen, 'x')],
  });
  assert.equal(seeded.ok, true, `seed commit failed: ${JSON.stringify(seeded)}`);

  const reply = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: 'req-pend', assignmentId: 'asg-pend', recordV1: record, candidateId: null,
  });
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  const parsed = DeskHandbackSubmitResult.parse(reply.body);
  assert.equal(parsed.gaps[0].length, WIRE_LIMITS.gapLen);
  assert.ok(parsed.gaps.some(g => g.startsWith('observed-capture-failed:exit')));
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).handbacks.find(h => h.requestId === 'req-pend').observed.status, 'failed');
});

test('the durable gaps cap is not widened — a beyond-bound row still refuses', async t => {
  const ctx = await boundPair(t);
  const record = goodRecord();
  const seeded = await seedSubmit(ctx, 'req-over', 'asg-over', record, {
    observed: { status: 'failed', candidateId: null, repository: '/repo', measuredAt: CAPTURED_AT, error: 'exit: x' },
    gaps: ['x'.repeat(WIRE_LIMITS.gapLen + 1)],
  });
  assert.equal(seeded.ok, false, 'a gaps entry past the durable cap must refuse, not be wedged into the ledger');
  assert.equal(seedStore(ctx.f).read(ctx.repoKey).state, 'ok');
});

test('every mutation tool answer parses its declared wire schema — success, replay equality and rejection', async t => {
  const ctx = await boundPair(t);
  const regArgs = { requestId: `reg-${randomUUID()}`, authorityRef: 'grant:matrix', objective: null };
  const reg = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_register', regArgs);
  const regBody = DeskAssignmentResult.parse(reg.body);
  const regReplay = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_register', regArgs);
  assert.deepEqual(regReplay.body, reg.body, 'a replayed register returns the identical result body');
  const att = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_attach', {
    requestId: `att-${randomUUID()}`, assignmentId: regBody.assignmentId, agentId: 'agent-1',
  });
  DeskAssignmentResult.parse(att.body);
  const sub = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: `sub-${randomUUID()}`, assignmentId: regBody.assignmentId, recordV1: goodRecord(), candidateId: null,
  });
  DeskHandbackSubmitResult.parse(sub.body);
  const close = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_close', {
    requestId: `close-${randomUUID()}`, assignmentId: regBody.assignmentId,
  });
  DeskAssignmentResult.parse(close.body);
  const denied = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_assignment_register', {
    requestId: `reg-${randomUUID()}`, authorityRef: 'grant:no', objective: null,
  });
  const rejection = DeskRejection.parse(denied.body);
  assert.equal(rejection.code, 'AUTHORITY_REQUIRED');
});

test('brief amendments and material decisions are owner-only, CAS-bound and exactly replayable', async t => {
  const { f, repoKey, leadConn, peerConn } = await boundPair(t);
  const assignmentId = await registerAndAttach(t, { leadConn, peer: { agentId: 'agent-1' } });
  const brief = (objective, extra = {}) => ({
    objective,
    acceptanceCriteria: ['observable result'],
    constraints: [{ text: 'authority constraint', authorityRef: 'grant:human-1', sourceRef: 'note:source-1' }],
    provisionalDesign: 'provisional choice',
    assumptions: ['assumption'],
    unknowns: ['unknown'],
    requiredEvidence: ['candidate and checks'],
    ownedSurfaces: ['plugin/server/desk-assignment.ts'],
    excludedSurfaces: ['plugin/index.server.ts'],
    dependencies: [],
    notifications: [{ event: 'brief-amended', recipientAgentId: 'agent-1' }],
    ...extra,
  });
  const amend = (requestId, body, expectedBriefRevision = 0) => call(leadConn.reader, leadConn.conn, 'slp_assignment_amend', {
    requestId, assignmentId, expectedBriefRevision, brief: body,
    changeReason: 'initial operative brief', authorityRef: 'grant:human-1', affectedOwners: ['agent-lead'],
  });

  const invalidBriefs = [
    ['empty objective', { objective: '' }],
    ['whitespace objective', { objective: ' \t\n ' }],
    ['empty acceptance list', { acceptanceCriteria: [] }],
    ['whitespace acceptance criterion', { acceptanceCriteria: [' \t\n '] }],
    ['empty provisional design', { provisionalDesign: '' }],
    ['whitespace provisional design', { provisionalDesign: ' \t\n ' }],
  ];
  for (const [index, [label, invalidFields]] of invalidBriefs.entries()) {
    const rejected = await amend(`brief-invalid-${index}`, brief('valid objective', invalidFields));
    assert.equal(rejected.body.code, 'INVALID_RECORD', `${label}: ${JSON.stringify(rejected.body)}`);
  }
  const afterInvalidBriefs = ledgerOf(f, repoKey);
  assert.equal(afterInvalidBriefs.briefRevisions.filter(row => row.assignmentId === assignmentId).length, 0);
  assert.equal(readdirEvents(f, repoKey).filter(event => event.kind === 'brief-revision-appended').length, 0);

  const denied = await call(peerConn.reader, peerConn.conn, 'slp_assignment_amend', {
    requestId: 'peer-amend', assignmentId, expectedBriefRevision: 0, brief: brief('unauthorized'),
    changeReason: 'attempt', authorityRef: 'grant:fake', affectedOwners: [],
  });
  assert.equal(denied.body.code, 'AUTHORITY_REQUIRED');

  const firstBody = brief('bounded operative objective');
  const first = await amend('brief-1', firstBody);
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal(first.body.revision, 1);
  assert.match(first.body.entrySha256, /^[a-f0-9]{64}$/);
  const replay = await amend('brief-1', firstBody);
  assert.equal(replay.body.receiptId, first.body.receiptId);
  const changedReplay = await amend('brief-1', brief('changed body'));
  assert.equal(changedReplay.body.code, 'IDEMPOTENCY_CONFLICT');
  const stale = await amend('brief-stale', brief('stale writer'), 0);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');

  const secondBody = brief('amended operative objective', { unknowns: ['unknown one', 'unknown two'] });
  const second = await amend('brief-2', secondBody, 1);
  assert.equal(second.body.ok, true, JSON.stringify(second.body));
  assert.equal(second.body.revision, 2);

  const decision = await call(leadConn.reader, leadConn.conn, 'slp_decision_append', {
    requestId: 'decision-1', assignmentId, expectedBriefRevision: 2, authorityRef: 'grant:human-1',
    decision: {
      proposition: 'choose the provisional design', ruling: 'retain provisionally', reason: 'bounded evidence',
      supportingEvidenceRefs: ['note:support'], contraryEvidenceRefs: ['note:counter'], unresolvedRisk: 'coverage remains unknown',
      affectedBriefRevision: 2, affectedOwners: ['agent-1'], notificationRefs: ['notify:intent'], outcomeRefs: ['outcome:pending'],
    },
  });
  assert.equal(decision.body.ok, true, JSON.stringify(decision.body));
  assert.equal(decision.body.revision, 1);
  const decisionArgs = {
    requestId: 'decision-1', assignmentId, expectedBriefRevision: 2, authorityRef: 'grant:human-1',
    decision: {
      proposition: 'choose the provisional design', ruling: 'retain provisionally', reason: 'bounded evidence',
      supportingEvidenceRefs: ['note:support'], contraryEvidenceRefs: ['note:counter'], unresolvedRisk: 'coverage remains unknown',
      affectedBriefRevision: 2, affectedOwners: ['agent-1'], notificationRefs: ['notify:intent'], outcomeRefs: ['outcome:pending'],
    },
  };
  const replayedDecision = await call(leadConn.reader, leadConn.conn, 'slp_decision_append', decisionArgs);
  assert.deepEqual(replayedDecision.body, decision.body, 'an exact decision replay returns the original response');
  const changedDecisionBody = await call(leadConn.reader, leadConn.conn, 'slp_decision_append', {
    ...decisionArgs,
    decision: { ...decisionArgs.decision, reason: 'different request body' },
  });
  assert.equal(changedDecisionBody.body.code, 'IDEMPOTENCY_CONFLICT');
  const staleAffectedBrief = await call(leadConn.reader, leadConn.conn, 'slp_decision_append', {
    requestId: 'decision-stale-affected', assignmentId, expectedBriefRevision: 2, authorityRef: 'grant:human-1',
    decision: { ...decisionArgs.decision, affectedBriefRevision: 1 },
  });
  assert.equal(staleAffectedBrief.body.code, 'REVISION_CONFLICT');
  const staleCurrentBrief = await call(leadConn.reader, leadConn.conn, 'slp_decision_append', {
    requestId: 'decision-stale-current', assignmentId, expectedBriefRevision: 1, authorityRef: 'grant:human-1',
    decision: { ...decisionArgs.decision, affectedBriefRevision: 1 },
  });
  assert.equal(staleCurrentBrief.body.code, 'REVISION_CONFLICT');
  const peerDecision = await call(peerConn.reader, peerConn.conn, 'slp_decision_append', {
    ...decisionArgs, requestId: 'peer-decision',
  });
  assert.equal(peerDecision.body.code, 'AUTHORITY_REQUIRED');

  const read = ledgerOf(f, repoKey);
  assert.equal(read.briefRevisions.filter(row => row.assignmentId === assignmentId).length, 2);
  assert.equal(read.decisionEntries.filter(row => row.assignmentId === assignmentId).length, 1);
});

test('workflow read gives role-neutral access to attached live seats and pins every page', async t => {
  const { f, git, repoKey, peer, leadConn, peerConn } = await boundPair(t);
  const assignmentId = await registerAndAttach(t, { leadConn, peer: { agentId: 'agent-1' } });
  const store = seedStore(f);
  const current = ledgerOf(f, repoKey);
  const readerLead = memberRow('receiving-lead-handle', { role: 'lead', agentId: 'agent-lead-2' });
  const unattachedLead = memberRow('unattached-lead-handle', { role: 'lead', agentId: 'agent-lead-3' });
  const unattachedPeer = memberRow('unattached-peer-handle', { role: 'peer', agentId: 'agent-2' });
  await seedMemberships(store, repoOf(git), [...current.memberships, readerLead, unattachedLead, unattachedPeer]);
  const attach = await call(leadConn.reader, leadConn.conn, 'slp_assignment_attach', {
    requestId: 'attach-receiving-lead', assignmentId, agentId: 'agent-lead-2',
  });
  assert.equal(attach.body.ok, true, JSON.stringify(attach.body));
  const receiverConn = await handshake(f.paths.socketPath, HELLO('receiving-lead-handle'));
  t.after(() => receiverConn.conn.destroy());
  assert.equal(receiverConn.ack.ok, true, JSON.stringify(receiverConn.ack));
  const foreignLeadConn = await handshake(f.paths.socketPath, HELLO('unattached-lead-handle'));
  t.after(() => foreignLeadConn.conn.destroy());
  assert.equal(foreignLeadConn.ack.ok, true, JSON.stringify(foreignLeadConn.ack));
  const foreignPeerConn = await handshake(f.paths.socketPath, HELLO('unattached-peer-handle'));
  t.after(() => foreignPeerConn.conn.destroy());
  assert.equal(foreignPeerConn.ack.ok, true, JSON.stringify(foreignPeerConn.ack));

  const brief = (objective) => ({
    objective, acceptanceCriteria: ['done'], constraints: [], provisionalDesign: 'open', assumptions: [],
    unknowns: [], requiredEvidence: [], ownedSurfaces: [], excludedSurfaces: [], dependencies: [], notifications: [],
  });
  for (const [requestId, expectedBriefRevision, body] of [
    ['b1', 0, brief('first')], ['b2', 1, brief('second')],
  ]) {
    const result = await call(leadConn.reader, leadConn.conn, 'slp_assignment_amend', {
      requestId, assignmentId, expectedBriefRevision, brief: body,
      changeReason: 'revise', authorityRef: 'grant:human-1', affectedOwners: [],
    });
    assert.equal(result.body.ok, true, JSON.stringify(result.body));
  }

  const firstPage = await call(receiverConn.reader, receiverConn.conn, 'slp_workflow_get', {
    assignmentId, section: 'briefs', expectedLedgerRevision: null, expectedBriefRevision: 2, cursor: null, limit: 1,
  });
  assert.equal(firstPage.body.ok, true, JSON.stringify(firstPage.body));
  assert.equal(firstPage.body.currentBrief.revision, 2);
  assert.equal(firstPage.body.items.length, 1);
  assert.equal(firstPage.body.total, 2);
  assert.equal(firstPage.body.omittedAfter, 1);
  assert.ok(firstPage.body.nextCursor);
  assert.equal(firstPage.body.acceptance, 'not-established-by-this-view');

  const peerRead = await call(peerConn.reader, peerConn.conn, 'slp_workflow_get', {
    assignmentId, section: 'briefs', expectedLedgerRevision: firstPage.body.ledgerRevision,
    expectedBriefRevision: 2, cursor: null, limit: 1,
  });
  assert.equal(peerRead.body.ok, true, JSON.stringify(peerRead.body));
  assert.equal(peerRead.body.currentBrief.revision, 2, 'an attached live Peer can read the same private brief');

  const privateRead = { assignmentId, section: 'briefs', expectedLedgerRevision: null, expectedBriefRevision: null, cursor: null, limit: 1 };
  for (const [label, connection] of [['unattached Lead', foreignLeadConn], ['unattached Peer', foreignPeerConn]]) {
    const deniedRead = await call(connection.reader, connection.conn, 'slp_workflow_get', privateRead);
    assert.equal(deniedRead.body.code, 'AUTHORITY_REQUIRED', `${label}: ${JSON.stringify(deniedRead.body)}`);
    assert.equal(deniedRead.body.currentBrief, undefined, 'the rejection carries no private brief value');
  }

  const secondPage = await call(receiverConn.reader, receiverConn.conn, 'slp_workflow_get', {
    assignmentId, section: 'briefs', expectedLedgerRevision: firstPage.body.ledgerRevision,
    expectedBriefRevision: 2, cursor: firstPage.body.nextCursor, limit: 1,
  });
  assert.equal(secondPage.body.ok, true, JSON.stringify(secondPage.body));
  assert.equal(secondPage.body.omittedBefore, 1);
  assert.equal(secondPage.body.omittedAfter, 0);
  assert.equal(secondPage.body.items.length, 1);

  const ownerOnly = await call(peerConn.reader, peerConn.conn, 'slp_assignment_amend', {
    requestId: 'attached-peer-amend', assignmentId, expectedBriefRevision: 2,
    brief: brief('peer tries'), changeReason: 'attempt', authorityRef: 'grant:fake', affectedOwners: [],
  });
  assert.equal(ownerOnly.body.code, 'AUTHORITY_REQUIRED');

  const beforeRevocation = ledgerOf(f, repoKey);
  const revokedMemberships = beforeRevocation.memberships.map(row => row.membershipId === peer.membershipId
    ? { ...row, state: 'revoked', revokedAt: FIXED_AT, revokeReason: 'archived' }
    : row);
  const revoked = await store.transact(repoKey, {
    repo: repoOf(git), actorKey: 'desk:hook', assignmentId: 'unassigned',
    requestId: `revoke-peer-${randomUUID()}`, command: { kind: 'seed' },
  }, () => ({ ok: true, events: [], memberships: revokedMemberships }));
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  const revokedRead = await call(peerConn.reader, peerConn.conn, 'slp_workflow_get', privateRead);
  assert.equal(revokedRead.body.code, 'STALE_EPOCH');
  assert.ok(ledgerOf(f, repoKey).assignments.find(row => row.assignmentId === assignmentId).seats.some(seat => seat.membershipId === peer.membershipId),
    'revocation preserves the historical assignment seat binding');
});
