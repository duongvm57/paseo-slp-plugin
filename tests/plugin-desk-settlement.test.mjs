// tests/plugin-desk-settlement.test.mjs — P3-b settlement mirror coverage
// (contract P3-b §B1–B10): slp_settlement_record / slp_settlement_export
// end-to-end over the REAL Unix socket — real desk store, real wire frames,
// structural doubles only for the host SDK and the observed-capture
// subprocess. The derived record is also re-validated against the
// AUTHORITATIVE plugin/server/runtime/cli/report-records.ts validateRecord (B5 parser parity).
// Fixtures live under tmpdir(); the real daemon home and repo tree are
// never touched.

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
  tmp,
} from './helpers/desk-bridge-fixture.mjs';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { validateRecord } from '../plugin/server/runtime/cli/report-records.ts';
import {
  createDeskStore,
} from '../plugin/server/desk-store.ts';
import { buildSettlementRecord, decideDeskSettlement } from '../plugin/server/desk-settlement.ts';
import { sha256Hex } from '../plugin/server/config-view.ts';
import {
  DeskSeatStatus,
  DeskSettlementRecordResult,
  DeskSettlementExportResult,
  DeskAssignmentResult,
  WIRE_LIMITS,
} from '../plugin/shared/enforcement.ts';

const FIXED_AT = '2026-01-01T00:00:00.000Z';
const CAPTURED_AT = '2026-01-02T00:00:00.000Z';
const PROVIDER = 'slp-codex-peer';
// Real pin: these fixtures verify packaged-binary graft integrity.
const PIN = sha256Hex(readFileSync(BIN_SOURCE));
const CAPTURED_SNAP = 'd'.repeat(64);
const CAPTURED_HEAD = 'e'.repeat(40);

const gitRepo = t => deskGitRepo(t, 'slp-stl-repo-');

const captureOk = async ({ repository }) => ({
  status: 'ok',
  repository,
  measuredAt: CAPTURED_AT,
  snapshotSha256: CAPTURED_SNAP,
  head: CAPTURED_HEAD,
  incomplete: [],
});

function bridgeFixture(t, over = {}) {
  return deskBridgeFixture(t, 'slp-stl-home-', PIN, {
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

// ---------------------------------------------------------------------------
// socket helpers (same NDJSON discipline as the bridge/handback suites)
// ---------------------------------------------------------------------------

const HELLO = (handle, over = {}) => hello(PIN, handle, over);

let rpcSeq = 0;
async function call(reader, conn, name, args) {
  rpcSeq += 1;
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: `stl-${rpcSeq}`,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const body = JSON.parse(reply.result.content[0].text);
  return { isError: reply.result.isError === true, body };
}

const livePaseo = agent => ({ agents: { ref: () => ({ refresh: async () => ({ agent }) }) } });
const LIVE_AGENT = { provider: PROVIDER, workspaceId: 'wks-1', archivedAt: null };

/** One desk with a lead seat and two peer seats; all bound over the socket.
 *  `peer2` exists so cross-seat scoping has a real second bound identity. */
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

/** Register + attach a seat; returns assignmentId. */
async function registerAndAttach(t, { leadConn }, agentId = 'agent-1') {
  const reg = await call(leadConn.reader, leadConn.conn, 'slp_assignment_register', {
    requestId: `reg-${randomUUID()}`,
    authorityRef: 'grant:test',
    objective: 'bounded task',
  });
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  const parsed = DeskAssignmentResult.parse(reg.body);
  const att = await call(leadConn.reader, leadConn.conn, 'slp_assignment_attach', {
    requestId: `att-${randomUUID()}`,
    assignmentId: parsed.assignmentId,
    agentId,
  });
  assert.equal(att.body.ok, true, JSON.stringify(att.body));
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

/** Submit one handback as the peer; returns {handbackId, observedCandidateId}. */
async function submitHandback(t, ctx, requestId = `hb-${randomUUID()}`) {
  const reply = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId,
    assignmentId: ctx.assignmentId,
    recordV1: goodRecord(),
    candidateId: null,
  });
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  return { handbackId: reply.body.handbackId, candidateId: reply.body.observedCandidateId };
}

const SETTLED_AT = '2026-01-03T00:00:00.000Z';

/** A complete settlement input — every prerequisite attested. */
const goodSettlement = (over = {}) => ({
  requestId: `stl-${randomUUID()}`,
  assignmentId: 'ASG',
  seatAgentId: 'agent-1',
  seatTitle: 'bounded task — engineer seat',
  at: SETTLED_AT,
  deliveryRef: 'note:delivered-2026-01-02',
  reworkClosureRef: 'note:rework-closed',
  sinkRef: 'issue:sl-1',
  decisionRef: 'decision:external-42',
  handbackRefs: [],
  candidateRefs: [],
  resources: [{ ref: 'agent:peer-1', disposition: 'released' }],
  timeline: {
    nativeHandle: 'rollout-uuid-9',
    sessionId: 'sess-9',
    via: 'host-transcript',
    export: null,
    gap: 'no authorized transcript export on this host',
  },
  ...over,
});

const ledgerOf = (f, repoKey) => {
  const read = seedStore(f).read(repoKey);
  assert.equal(read.state, 'ok');
  return read.ledger;
};

const settlementEvents = (f, repoKey) => {
  const dir = join(f.stableRoot, 'state', 'enforcement', 'repos', repoKey, 'events');
  const rows = [];
  for (const name of readdirSync(dir).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.length > 0) rows.push(JSON.parse(line));
    }
  }
  return rows;
};

/** Register + attach + submit one handback — the settled-seat fixture most
 *  tests need. Returns ctx + {assignmentId, handbackId, candidateId}. */
async function settledFixture(t, over = {}) {
  const ctx = await boundTrio(t, over);
  const assignmentId = await registerAndAttach(t, ctx);
  const { handbackId, candidateId } = await submitHandback(t, { ...ctx, assignmentId });
  return { ...ctx, assignmentId, handbackId, candidateId };
}

// ---------------------------------------------------------------------------
// catalog + strict input
// ---------------------------------------------------------------------------

test('P3-b tools are visible mutations/reads; hidden and never-declared entries stay absent', async t => {
  const { leadConn, peerConn } = await boundTrio(t);
  const list = await rpc(leadConn.reader, leadConn.conn, { jsonrpc: '2.0', id: 'l1', method: 'tools/list' });
  const names = list.result.tools.map(tool => tool.name);
  assert.ok(names.includes('slp_settlement_record'), 'settlement record is visible');
  assert.ok(names.includes('slp_settlement_export'), 'settlement export is visible');
  const peerList = await rpc(peerConn.reader, peerConn.conn, { jsonrpc: '2.0', id: 'l2', method: 'tools/list' });
  assert.ok(!peerList.result.tools.some(tool => tool.name === 'slp_settlement_record'));
  assert.ok(peerList.result.tools.some(tool => tool.name === 'slp_settlement_export'));
  for (const forbidden of ['slp_review_open', 'slp_review_submit', 'slp_decision_record', 'slp_recover_lock', 'slp_desk_internal', 'slp_deploy']) {
    assert.ok(!names.includes(forbidden), `${forbidden} absent`);
  }
});

test('record input is strict — extra fields reject INVALID_RECORD', async t => {
  const { leadConn } = await boundTrio(t);
  const reply = await call(leadConn.reader, leadConn.conn, 'slp_settlement_record', {
    ...goodSettlement({ assignmentId: 'asg-x' }), actorId: 'spoof',
  });
  assert.equal(reply.body.ok, false);
  assert.equal(reply.body.code, 'INVALID_RECORD');
});

// ---------------------------------------------------------------------------
// B1 — owner authority: peer / non-owner lead / supervisor reject typed
// ---------------------------------------------------------------------------

test('B1: a peer cannot record settlement for itself or another seat', async t => {
  const ctx = await settledFixture(t);
  const self = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId }));
  assert.equal(self.body.ok, false);
  assert.equal(self.body.code, 'AUTHORITY_REQUIRED');
  const other = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, seatAgentId: 'agent-2' }));
  assert.equal(other.body.code, 'AUTHORITY_REQUIRED');
});

test('B1: a lead who is not the receiving owner cannot record settlement', async t => {
  const ctx = await settledFixture(t);
  const other = memberRow('lead2-handle', { role: 'lead', agentId: 'agent-lead-2' });
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  await seedMemberships(seedStore(ctx.f), ctx.repo, [...ledger.memberships, other]);
  const lead2 = await handshake(ctx.f.paths.socketPath, HELLO('lead2-handle'));
  t.after(() => lead2.conn.destroy());
  assert.equal(lead2.ack.ok, true);
  const reply = await call(lead2.reader, lead2.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId }));
  assert.equal(reply.body.ok, false);
  assert.equal(reply.body.code, 'AUTHORITY_REQUIRED');
});

test('B1: a supervisor-role membership cannot settle for the lead', async t => {
  const ctx = await settledFixture(t);
  const sup = memberRow('sup-handle', { role: 'supervisor', agentId: 'agent-sup' });
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  await seedMemberships(seedStore(ctx.f), ctx.repo, [...ledger.memberships, sup]);
  const supConn = await handshake(ctx.f.paths.socketPath, HELLO('sup-handle'));
  t.after(() => supConn.conn.destroy());
  assert.equal(supConn.ack.ok, true);
  const reply = await call(supConn.reader, supConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId }));
  assert.equal(reply.body.ok, false);
  assert.equal(reply.body.code, 'AUTHORITY_REQUIRED');
});

test('B1: settlement rejects unknown assignment, unbound seat, and a seat of another assignment', async t => {
  const ctx = await settledFixture(t);
  const unknown = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: 'asg-ghost' }));
  assert.equal(unknown.body.code, 'AUTHORITY_REQUIRED');
  const unbound = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, seatAgentId: 'agent-9' }));
  assert.equal(unbound.body.code, 'INVALID_RECORD');
  // agent-2 is a live peer but not attached to this assignment.
  const foreign = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, seatAgentId: 'agent-2' }));
  assert.equal(foreign.body.code, 'INVALID_RECORD');
});

// ---------------------------------------------------------------------------
// commit — happy path, durable rows, derived status, events
// ---------------------------------------------------------------------------

test('record commits the attestation, derives completed status, and emits a hash-chained event', async t => {
  const ctx = await settledFixture(t);
  const input = goodSettlement({
    assignmentId: ctx.assignmentId,
    handbackRefs: [ctx.handbackId],
    candidateRefs: [ctx.candidateId],
  });
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', input);
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  const result = DeskSettlementRecordResult.parse(reply.body);
  assert.equal(result.revision, 1);
  assert.match(result.settlementId, /^stl-[0-9a-f]{32}$/);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.gaps, ['transcript-export-unavailable']);

  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const row = ledger.settlements.find(s => s.settlementId === result.settlementId);
  assert.ok(row, 'the settlement row is durable');
  assert.equal(row.assignmentId, ctx.assignmentId);
  assert.equal(row.ownerAgentId, 'agent-lead');
  assert.equal(row.seatAgentId, 'agent-1');
  assert.equal(row.seatProvider, PROVIDER, 'provider is the durable membership value, never the claim');
  assert.deepEqual(row.handbackRefs, [ctx.handbackId]);
  assert.deepEqual(row.candidateRefs, [ctx.candidateId]);
  assert.equal(row.timeline.via, 'host-transcript');
  const kinds = settlementEvents(ctx.f, ctx.repoKey).map(e => e.kind);
  assert.ok(kinds.includes('settlement-recorded'), 'the settlement event is hash-chained');
});

test('record on a closed assignment is allowed — status derives from attestations, not assignment state', async t => {
  const ctx = await settledFixture(t);
  const close = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_close', {
    requestId: `close-${randomUUID()}`,
    assignmentId: ctx.assignmentId,
  });
  assert.equal(close.body.ok, true);
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId }));
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  assert.equal(reply.body.status, 'completed');
});

// ---------------------------------------------------------------------------
// B3 — status dispositions: blocked / partial / completed, gaps durable
// ---------------------------------------------------------------------------

test('B3: missing delivery evidence records blocked + gap, never completed', async t => {
  const ctx = await settledFixture(t);
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, deliveryRef: null }));
  assert.equal(reply.body.ok, true);
  assert.equal(reply.body.status, 'blocked');
  assert.ok(reply.body.gaps.includes('delivery-evidence-missing'));
});

test('B3: open correction/re-review (no closure pointer) is partial, not completed', async t => {
  const ctx = await settledFixture(t);
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, reworkClosureRef: null }));
  assert.equal(reply.body.status, 'partial');
  assert.ok(reply.body.gaps.includes('rework-closure-evidence-missing'));
});

test('B3: unknown resource dispositions and a missing sink record partial + gaps', async t => {
  const ctx = await settledFixture(t);
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    sinkRef: null,
    resources: [
      { ref: 'agent:peer-1', disposition: 'released' },
      { ref: 'agent:peer-2', disposition: 'unknown' },
    ],
  }));
  assert.equal(reply.body.status, 'partial');
  assert.ok(reply.body.gaps.includes('sink-pointer-missing'));
  assert.ok(reply.body.gaps.includes('resource-dispositions-unknown:1'));
});

test('B3: missing transcript export without handle+gap keeps partial; with both it is completed and the gap is durable', async t => {
  const ctx = await settledFixture(t);
  // No export, no nativeHandle — transcript evidence cannot be pointed at.
  const uncovered = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: { nativeHandle: null, sessionId: null, via: 'unreadable', export: null, gap: 'transcript unreadable' },
  }));
  assert.equal(uncovered.body.status, 'partial');
  assert.ok(uncovered.body.gaps.includes('transcript-export-unavailable'));
  // No export but a native handle + recorded capability gap — completed.
  const covered = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: { nativeHandle: 'rollout-uuid-9', sessionId: null, via: 'host-transcript', export: null, gap: 'no export API' },
  }));
  assert.equal(covered.body.status, 'completed');
  assert.ok(covered.body.gaps.includes('transcript-export-unavailable'), 'the capability gap stays durable');
  // A VERIFIED export pointer completes with no transcript gap at all —
  // the artifact must exist under the bound repo root for the seam to
  // prove it (write the real file, claim its real sha256/bytes).
  const bytes = Buffer.from('transcript evidence bytes\n', 'utf8');
  mkdirSync(join(ctx.git.dir, '.local-checks'), { recursive: true });
  writeFileSync(join(ctx.git.dir, '.local-checks', 'transcript.txt'), bytes);
  const exported = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: {
      nativeHandle: 'rollout-uuid-9',
      sessionId: 'sess-9',
      via: 'host-transcript',
      export: { path: '.local-checks/transcript.txt', sha256: sha256Hex(bytes), bytes: bytes.length },
      gap: null,
    },
  }));
  assert.equal(exported.body.status, 'completed');
  assert.ok(!exported.body.gaps.includes('transcript-export-unavailable'));
  assert.deepEqual(exported.body.exportVerification, { status: 'verified', detail: null });
});

test('B3: missing decisionRef is a durable provenance gap, never a blocker', async t => {
  const ctx = await settledFixture(t);
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, decisionRef: null }));
  assert.equal(reply.body.status, 'completed');
  assert.ok(reply.body.gaps.includes('decision-reference-missing'));
});

// ---------------------------------------------------------------------------
// B2 — internal refs resolve to THIS seat's rows on THIS assignment
// ---------------------------------------------------------------------------

test('B2: refs to another seat\'s handback or candidate reject INVALID_RECORD', async t => {
  const ctx = await settledFixture(t);
  // Attach agent-2 to the same assignment and have it submit a handback.
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_attach', {
    requestId: `att-${randomUUID()}`, assignmentId: ctx.assignmentId, agentId: 'agent-2',
  });
  const other = await call(ctx.peer2Conn.reader, ctx.peer2Conn.conn, 'slp_handback_submit', {
    requestId: `hb-${randomUUID()}`, assignmentId: ctx.assignmentId,
    recordV1: goodRecord({ seat: { role: 'peer', disposition: 'engineer', agentId: 'agent-2' } }),
    candidateId: null,
  });
  assert.equal(other.body.ok, true);
  // Settling agent-1 cannot cite agent-2's rows.
  const foreignHb = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, handbackRefs: [other.body.handbackId] }));
  assert.equal(foreignHb.body.code, 'INVALID_RECORD');
  const foreignCand = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, candidateRefs: [other.body.observedCandidateId] }));
  assert.equal(foreignCand.body.code, 'INVALID_RECORD');
});

test('B2: refs to another assignment\'s rows or unknown ids reject INVALID_RECORD', async t => {
  const ctx = await settledFixture(t);
  // A second assignment owned by the same lead, agent-1 attached, handback submitted.
  const otherAsg = await registerAndAttach(t, ctx, 'agent-1');
  const foreign = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_handback_submit', {
    requestId: `hb-${randomUUID()}`, assignmentId: otherAsg, recordV1: goodRecord(), candidateId: null,
  });
  assert.equal(foreign.body.ok, true);
  const crossAsg = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, handbackRefs: [foreign.body.handbackId] }));
  assert.equal(crossAsg.body.code, 'INVALID_RECORD');
  const ghost = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, handbackRefs: ['hb-ghost'], candidateRefs: ['cand-ghost'] }));
  assert.equal(ghost.body.code, 'INVALID_RECORD');
});

test('B2: a revoked seat membership still settles — the durable identity outlives the binding', async t => {
  const ctx = await settledFixture(t);
  // Revoke the peer membership directly in the ledger (the seat-revoke
  // write path lives in desk-seat.ts — this seeds the post-revoke state).
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const revoked = ledger.memberships.map(m =>
    m.agentId === 'agent-1'
      ? { ...m, state: 'revoked', revokedAt: SETTLED_AT, revokeReason: 'archived' }
      : m,
  );
  const seed = await seedStore(ctx.f).transact(ctx.repoKey, {
    repo: ctx.repo,
    actorKey: 'desk:hook',
    assignmentId: 'unassigned',
    requestId: randomUUID(),
    command: { kind: 'seed' },
  }, () => ({ ok: true, events: [], memberships: revoked }));
  assert.equal(seed.ok, true, JSON.stringify(seed));
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, handbackRefs: [ctx.handbackId] }));
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  assert.equal(reply.body.status, 'completed');
  const row = ledgerOf(ctx.f, ctx.repoKey).settlements[0];
  assert.equal(row.seatAgentId, 'agent-1', 'the settled seat keeps its original identity');
  assert.equal(row.seatProvider, PROVIDER);
});

test('B1/B2: a revoked OWNER membership cannot record new revisions — existing rows stay durable', async t => {
  const ctx = await settledFixture(t);
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId }));
  assert.equal(first.body.ok, true);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const revoked = ledger.memberships.map(m =>
    m.agentId === 'agent-lead'
      ? { ...m, state: 'revoked', revokedAt: SETTLED_AT, revokeReason: 'archived' }
      : m,
  );
  const seed = await seedStore(ctx.f).transact(ctx.repoKey, {
    repo: ctx.repo, actorKey: 'desk:hook', assignmentId: 'unassigned',
    requestId: randomUUID(), command: { kind: 'seed' },
  }, () => ({ ok: true, events: [], memberships: revoked }));
  assert.equal(seed.ok, true);
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId }));
  assert.equal(reply.body.ok, false);
  // The revocation either trips the bridge's stale-epoch rebinding check or
  // the decide's live-owner check — both are the typed fail-closed outcome;
  // what matters is that no new revision lands.
  assert.ok(['AUTHORITY_REQUIRED', 'STALE_EPOCH'].includes(reply.body.code), `unexpected code ${reply.body.code}`);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).settlements.length, 1, 'the committed revision is never lost');
});

// ---------------------------------------------------------------------------
// B4 — immutable revisions + replay/conflict
// ---------------------------------------------------------------------------

test('B4: replay of the same input returns the recorded response; a different body is IDEMPOTENCY_CONFLICT', async t => {
  const ctx = await settledFixture(t);
  const input = goodSettlement({ assignmentId: ctx.assignmentId, requestId: 'stl-replay' });
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', input);
  assert.equal(first.body.ok, true);
  const again = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', input);
  assert.equal(again.body.ok, true);
  assert.equal(again.body.receiptId, first.body.receiptId);
  assert.equal(again.body.settlementId, first.body.settlementId);
  assert.equal(again.body.revision, first.body.revision);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).settlements.length, 1, 'no second row');
  const conflict = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    { ...input, sinkRef: 'issue:different' });
  assert.equal(conflict.body.ok, false);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).settlements.length, 1);
});

test('B4: a second requestId mints an immutable second revision — the first row is untouched', async t => {
  const ctx = await settledFixture(t);
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, requestId: 'stl-a', sinkRef: null }));
  const second = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, requestId: 'stl-b', sinkRef: 'issue:sl-9' }));
  assert.equal(first.body.revision, 1);
  assert.equal(first.body.status, 'partial');
  assert.equal(second.body.revision, 2);
  assert.equal(second.body.status, 'completed');
  const rows = ledgerOf(ctx.f, ctx.repoKey).settlements
    .filter(s => s.seatAgentId === 'agent-1')
    .sort((a, b) => a.revision - b.revision);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'partial', 'revision 1 keeps its disposition');
  assert.equal(rows[0].sinkRef, null, 'revision 1 keeps its pointers');
});

test('B4: crash after commit before acknowledgement replays without duplication', async t => {
  // A store whose ledgerCommitted fault kills the response path after the
  // commit point — the row is durable even though the call reports a fault.
  // The fault is armed only around the settlement commit so fixture setup
  // commits run clean.
  let armed = false;
  const createStore = root => createDeskStore({
    stableRoot: root,
    faults: {
      ledgerCommitted: () => {
        if (armed) { armed = false; throw new Error('simulated post-commit crash'); }
      },
    },
  });
  const ctx = await settledFixture(t, { createStore });
  armed = true;
  const input = goodSettlement({ assignmentId: ctx.assignmentId, requestId: 'stl-crash' });
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', input);
  // The commit landed; the response path died — the caller sees a typed
  // fault, not a receipt.
  assert.equal(first.body.ok, false);
  assert.equal(first.body.code, 'EXECUTION_UNKNOWN');
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(ledger.settlements.length, 1, 'the commit is durable');
  // The seat retries the identical body — the recorded receipt replays.
  const retry = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', input);
  assert.equal(retry.body.ok, true, JSON.stringify(retry.body));
  assert.equal(retry.body.settlementId, ledger.settlements[0].settlementId);
  assert.equal(retry.body.revision, 1);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).settlements.length, 1, 'replay never duplicates');
});

// ---------------------------------------------------------------------------
// B5 — export: explicit v1 record, parser-compatible, provenance preserved
// ---------------------------------------------------------------------------

test('B5: export re-derives the committed v1 record — authoritative validator accepts it', async t => {
  const ctx = await settledFixture(t);
  const tBytes = Buffer.from('real transcript export\n', 'utf8');
  mkdirSync(join(ctx.git.dir, '.local-checks'), { recursive: true });
  writeFileSync(join(ctx.git.dir, '.local-checks', 't.txt'), tBytes);
  const tClaim = { path: '.local-checks/t.txt', sha256: sha256Hex(tBytes), bytes: tBytes.length };
  const record = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    handbackRefs: [ctx.handbackId],
    candidateRefs: [ctx.candidateId],
    timeline: {
      nativeHandle: 'rollout-uuid-9',
      sessionId: 'sess-9',
      via: 'host-transcript',
      export: tClaim,
      gap: null,
    },
  }));
  const settlementId = record.body.settlementId;
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_export', { settlementId });
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  const parsed = DeskSettlementExportResult.parse(reply.body);
  const v1 = parsed.record;
  assert.equal(v1.version, 1);
  assert.equal(v1.kind, 'settlement');
  assert.equal(v1.task, ctx.assignmentId, 'task binds the durable assignment slug');
  assert.equal(v1.seat.provider, PROVIDER);
  assert.equal(v1.seat.title, 'bounded task — engineer seat');
  assert.equal(v1.seat.agentId, 'agent-1');
  assert.equal(v1.recordedBy, 'agent-lead', 'recordedBy is the server-derived owner');
  assert.equal(v1.at, SETTLED_AT);
  assert.deepEqual(v1.timeline.export, tClaim);
  assert.deepEqual(parsed.exportVerification, { status: 'verified', detail: null });
  // The exported record carries no internal mirror state: pointer refs and
  // status stay on the desk row.
  assert.equal(v1.decisionRef, undefined);
  assert.equal(v1.deliveryRef, undefined);
  assert.equal(v1.status, undefined);
  // B5 — the AUTHORITATIVE validator (plugin/server/runtime/cli/report-records.ts), not the port.
  const verdict = validateRecord(v1);
  assert.equal(verdict.valid, true, JSON.stringify(verdict.errors));
});

test('B5: export is deterministic — same row, same record bytes', async t => {
  const ctx = await settledFixture(t);
  const record = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId }));
  const settlementId = record.body.settlementId;
  const a = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_export', { settlementId });
  const b = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_export', { settlementId });
  assert.deepEqual(a.body.record, b.body.record);
  // And buildSettlementRecord derives the same bytes from the durable row.
  const row = ledgerOf(ctx.f, ctx.repoKey).settlements[0];
  assert.deepEqual(buildSettlementRecord(row), a.body.record);
});

test('B5: an invalid v1 input is refused before commit — bad via / bad export path', async t => {
  const ctx = await settledFixture(t);
  const badVia = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: { nativeHandle: null, sessionId: null, via: 'invented', export: null, gap: null },
  }));
  assert.equal(badVia.body.ok, false);
  assert.equal(badVia.body.code, 'INVALID_RECORD');
  const badPath = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: { nativeHandle: null, sessionId: null, via: 'host-transcript', export: { path: '/abs/escape.txt', sha256: 'f'.repeat(64), bytes: 1 }, gap: null },
  }));
  assert.equal(badPath.body.code, 'INVALID_RECORD');
  const badTraversal = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: { nativeHandle: null, sessionId: null, via: 'host-transcript', export: { path: '../escape.txt', sha256: 'f'.repeat(64), bytes: 1 }, gap: null },
  }));
  assert.equal(badTraversal.body.code, 'INVALID_RECORD');
  // A Time-valid `at` with a non-Z offset is command-legal but v1-invalid
  // (`UTC_TIMESTAMP_PATTERN` requires a Z) — only the pre-commit record
  // validation gate can refuse it.
  const badAt = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, at: '2026-01-03T00:00:00+05:00' }));
  assert.equal(badAt.body.code, 'INVALID_RECORD');
  assert.match(badAt.body.message, /derived settlement record invalid/);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).settlements.length, 0, 'nothing invalid lands durable');
});

// ---------------------------------------------------------------------------
// B5/B10 + F-STD-P3B-1 — the artifact seam: a claimed timeline.export must
// prove itself under the bound repo root before it can ground `completed`.
// These exercise the REAL FS seam (no injected double) so an absent file
// can never produce a false completion — the S-MAJOR regression.
// ---------------------------------------------------------------------------

test('seam: an absent export path rejects — never a false completed', async t => {
  const ctx = await settledFixture(t);
  // The claimed artifact simply does not exist under the repo worktree.
  const absent = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: {
      nativeHandle: 'rollout-uuid-9',
      sessionId: null,
      via: 'host-transcript',
      export: { path: '.local-checks/definitely-absent.txt', sha256: 'f'.repeat(64), bytes: 12 },
      gap: null,
    },
  }));
  assert.equal(absent.body.ok, false, JSON.stringify(absent.body));
  assert.equal(absent.body.code, 'INVALID_RECORD');
  // The decide's own seam rejection — not a downstream schema refusal.
  assert.match(absent.body.message, /bound repository root/);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).settlements.length, 0, 'a disproven claim never lands durable');
});

test('seam: sha/bytes mismatch and outside-root claims reject', async t => {
  const ctx = await settledFixture(t);
  // A real file exists but the claimed sha does not match its bytes.
  const bytes = Buffer.from('actual transcript bytes\n', 'utf8');
  mkdirSync(join(ctx.git.dir, '.local-checks'), { recursive: true });
  writeFileSync(join(ctx.git.dir, '.local-checks', 'real.txt'), bytes);
  const wrongSha = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: { nativeHandle: null, sessionId: null, via: 'host-transcript', export: { path: '.local-checks/real.txt', sha256: 'f'.repeat(64), bytes: bytes.length }, gap: null },
  }));
  assert.equal(wrongSha.body.code, 'INVALID_RECORD');
  // Right sha, wrong byte count — still a disproven claim.
  const wrongBytes = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: { nativeHandle: null, sessionId: null, via: 'host-transcript', export: { path: '.local-checks/real.txt', sha256: sha256Hex(bytes), bytes: bytes.length + 1 }, gap: null },
  }));
  assert.equal(wrongBytes.body.code, 'INVALID_RECORD');
  // A real file OUTSIDE the bound root escapes the allowed evidence domain.
  const outsideDir = tmp(t, 'slp-stl-outside-');
  writeFileSync(join(outsideDir, 'outside.txt'), 'outside evidence\n');
  const escaped = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: {
      nativeHandle: null, sessionId: null, via: 'host-transcript',
      export: { path: relative(ctx.git.dir, join(outsideDir, 'outside.txt')), sha256: sha256Hex('outside evidence\n'), bytes: 'outside evidence\n'.length },
      gap: null,
    },
  }));
  assert.equal(escaped.body.code, 'INVALID_RECORD');
  // A symlink INSIDE the repo pointing outside — the path itself is
  // repository-relative (passes every shape gate); only realpath
  // containment can catch it.
  symlinkSync(join(outsideDir, 'outside.txt'), join(ctx.git.dir, '.local-checks', 'link.txt'));
  const viaLink = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: {
      nativeHandle: null, sessionId: null, via: 'host-transcript',
      export: { path: '.local-checks/link.txt', sha256: sha256Hex('outside evidence\n'), bytes: 'outside evidence\n'.length },
      gap: null,
    },
  }));
  assert.equal(viaLink.body.code, 'INVALID_RECORD');
  assert.match(viaLink.body.message, /bound repository root/);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).settlements.length, 0);
});

test('seam: an unverifiable export commits claimed-only — partial + durable gap, never completed', async t => {
  // The seam itself cannot prove anything (capability unavailable) — the
  // claim is recorded as claimed-only and the revision cannot complete.
  const ctx = await settledFixture(t, {
    verifyExport: async () => ({ status: 'unavailable', detail: 'host-verifier-missing' }),
  });
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: {
      nativeHandle: 'rollout-uuid-9',
      sessionId: null,
      via: 'host-transcript',
      export: { path: '.local-checks/t.txt', sha256: 'f'.repeat(64), bytes: 12 },
      gap: 'no authorized transcript export on this host',
    },
  }));
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  assert.equal(reply.body.status, 'partial', 'an unproven export never grounds completed — even beside an honest handle');
  assert.ok(reply.body.gaps.includes('transcript-export-unverified'));
  assert.deepEqual(reply.body.exportVerification, { status: 'unavailable', detail: 'host-verifier-missing' });
  // The verdict is durable on the row and re-emitted by export.
  const row = ledgerOf(ctx.f, ctx.repoKey).settlements[0];
  assert.deepEqual(row.exportVerification, { status: 'unavailable', detail: 'host-verifier-missing' });
  const exported = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_export', { settlementId: row.settlementId });
  const parsed = DeskSettlementExportResult.parse(exported.body);
  assert.equal(parsed.status, 'partial');
  assert.deepEqual(parsed.exportVerification, { status: 'unavailable', detail: 'host-verifier-missing' });
  // The claim still echoes verbatim in the v1 record — it is a claim, not proof.
  assert.equal(parsed.record.timeline.export.path, '.local-checks/t.txt');
});

test('seam: status projection carries exportVerified', async t => {
  const ctx = await settledFixture(t);
  const bytes = Buffer.from('verified transcript\n', 'utf8');
  mkdirSync(join(ctx.git.dir, '.local-checks'), { recursive: true });
  writeFileSync(join(ctx.git.dir, '.local-checks', 'v.txt'), bytes);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: { nativeHandle: null, sessionId: null, via: 'host-transcript', export: { path: '.local-checks/v.txt', sha256: sha256Hex(bytes), bytes: bytes.length }, gap: null },
  }));
  const status = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_status', {});
  const view = DeskSeatStatus.parse(status.body);
  const asg = view.assignments.find(a => a.assignmentId === ctx.assignmentId);
  assert.equal(asg.settlements[0].exportVerified, true, 'the seam verdict projects into status');
});

test('seam: decide refuses a claimed export without the runner verdict — and vice versa', async t => {
  const ctx = await settledFixture(t);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const base = {
    kind: 'settlement.record',
    requestId: 'stl-direct-v',
    actorAgentId: 'agent-lead',
    assignmentId: ctx.assignmentId,
    seatAgentId: 'agent-1',
    seatTitle: 'bounded task',
    at: SETTLED_AT,
    deliveryRef: 'note:delivered',
    reworkClosureRef: 'note:closed',
    sinkRef: 'issue:x',
    decisionRef: 'decision:x',
    handbackRefs: [],
    candidateRefs: [],
    resources: [],
  };
  const claim = { path: '.local-checks/t.txt', sha256: 'f'.repeat(64), bytes: 12 };
  // Claimed export, verdict missing — the envelope is malformed.
  const noVerdict = decideDeskSettlement(ledger, {
    ...base,
    timeline: { nativeHandle: 'h', sessionId: null, via: 'host-transcript', export: claim, gap: null },
    exportVerification: null,
  });
  assert.equal(noVerdict.ok, false);
  assert.equal(noVerdict.code, 'INVALID_RECORD');
  // A disproven verdict rejects at decide level too.
  const disproved = decideDeskSettlement(ledger, {
    ...base,
    requestId: 'stl-direct-v2',
    timeline: { nativeHandle: 'h', sessionId: null, via: 'host-transcript', export: claim, gap: null },
    exportVerification: { status: 'absent', detail: null },
  });
  assert.equal(disproved.ok, false);
  assert.equal(disproved.code, 'INVALID_RECORD');
  // A verdict without a claimed export is equally malformed.
  const orphanVerdict = decideDeskSettlement(ledger, {
    ...base,
    requestId: 'stl-direct-v3',
    timeline: { nativeHandle: 'h', sessionId: null, via: 'host-transcript', export: null, gap: 'gap' },
    exportVerification: { status: 'verified', detail: null },
  });
  assert.equal(orphanVerdict.ok, false);
  assert.equal(orphanVerdict.code, 'INVALID_RECORD');
  // And a verified verdict on a claimed export decides cleanly.
  const proven = decideDeskSettlement(ledger, {
    ...base,
    requestId: 'stl-direct-v4',
    timeline: { nativeHandle: 'h', sessionId: null, via: 'host-transcript', export: claim, gap: null },
    exportVerification: { status: 'verified', detail: null },
  });
  assert.equal(proven.ok, true, JSON.stringify(proven));
  assert.equal(proven.settlements.at(-1).status, 'completed');
  assert.deepEqual(proven.settlements.at(-1).exportVerification, { status: 'verified', detail: null });
});

// ---------------------------------------------------------------------------
// B5/B7 — export scoping: owner + settled seat only
// ---------------------------------------------------------------------------

test('B7: export is scoped — the settled seat may export; other seats and non-owners may not', async t => {
  const ctx = await settledFixture(t);
  const record = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId }));
  const settlementId = record.body.settlementId;
  const bySeat = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_settlement_export', { settlementId });
  assert.equal(bySeat.body.ok, true, 'the settled seat exports its own settlement');
  assert.equal(bySeat.body.record.kind, 'settlement');
  const byOther = await call(ctx.peer2Conn.reader, ctx.peer2Conn.conn, 'slp_settlement_export', { settlementId });
  assert.equal(byOther.body.ok, false);
  assert.equal(byOther.body.code, 'AUTHORITY_REQUIRED');
  const byUnknown = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_export', { settlementId: 'stl-ghost' });
  assert.equal(byUnknown.body.code, 'AUTHORITY_REQUIRED');
});

// ---------------------------------------------------------------------------
// B6 — status projection scoping: owner sees all, seat sees its own
// ---------------------------------------------------------------------------

test('B6: slp_status projects settlements caller-scoped — owner sees all, seat sees its own', async t => {
  const ctx = await settledFixture(t);
  // Settle agent-1's report.
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId }));
  // Attach agent-2 and settle its report too.
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_attach', {
    requestId: `att-${randomUUID()}`, assignmentId: ctx.assignmentId, agentId: 'agent-2',
  });
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, seatAgentId: 'agent-2' }));

  const leadStatus = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_status', {});
  const leadView = DeskSeatStatus.parse(leadStatus.body);
  const leadAsg = leadView.assignments.find(a => a.assignmentId === ctx.assignmentId);
  assert.equal(leadAsg.settlements.length, 2, 'the owner sees both seats\' settlements');

  const peerStatus = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_status', {});
  const peerView = DeskSeatStatus.parse(peerStatus.body);
  const peerAsg = peerView.assignments.find(a => a.assignmentId === ctx.assignmentId);
  assert.equal(peerAsg.settlements.length, 1, 'a seat sees only its own settlement');
  assert.equal(peerAsg.settlements[0].seatAgentId, 'agent-1');
  assert.equal(peerAsg.settlements[0].status, 'completed');

  const peer2Status = await call(ctx.peer2Conn.reader, ctx.peer2Conn.conn, 'slp_status', {});
  const peer2View = DeskSeatStatus.parse(peer2Status.body);
  const peer2Asg = peer2View.assignments.find(a => a.assignmentId === ctx.assignmentId);
  assert.equal(peer2Asg.settlements.length, 1);
  assert.equal(peer2Asg.settlements[0].seatAgentId, 'agent-2');
});

// ---------------------------------------------------------------------------
// Caps — wire/durable parity: over-cap fields reject typed, never truncate
// ---------------------------------------------------------------------------

test('caps: over-bound pointer/refs/resources reject typed, not truncated', async t => {
  const ctx = await settledFixture(t);
  const bigPointer = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, deliveryRef: 'x'.repeat(WIRE_LIMITS.deskSettlementPointer + 1) }));
  assert.equal(bigPointer.body.code, 'INVALID_RECORD');
  const bigRefs = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, handbackRefs: Array.from({ length: WIRE_LIMITS.deskSettlementRefs + 1 }, (_, i) => `hb-${i}`) }));
  assert.equal(bigRefs.body.code, 'INVALID_RECORD');
  const bigResources = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record',
    goodSettlement({ assignmentId: ctx.assignmentId, resources: Array.from({ length: WIRE_LIMITS.deskSettlementResources + 1 }, (_, i) => ({ ref: `r-${i}`, disposition: 'released' })) }));
  assert.equal(bigResources.body.code, 'INVALID_RECORD');
  const bigGap = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    timeline: { nativeHandle: 'h', sessionId: null, via: 'host-transcript', export: null, gap: 'g'.repeat(WIRE_LIMITS.gapLen + 1) },
  }));
  assert.equal(bigGap.body.code, 'INVALID_RECORD');
});

// ---------------------------------------------------------------------------
// decide-level unit checks — the pure decide guards must be observable on
// their own, without the store refinement layer behind them (that layer is
// covered separately in plugin-desk-store-schema-v4.test.mjs).
// ---------------------------------------------------------------------------

test('decide: a foreign-seat handbackRef is refused at decide level, not just by store refinement', async t => {
  const ctx = await settledFixture(t);
  // Attach agent-2 and let it hand back — a legal handback on the same
  // assignment that a settlement for agent-1 must still not cite.
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_attach', {
    requestId: `att-${randomUUID()}`, assignmentId: ctx.assignmentId, agentId: 'agent-2',
  });
  const other = await call(ctx.peer2Conn.reader, ctx.peer2Conn.conn, 'slp_handback_submit', {
    requestId: `hb-${randomUUID()}`, assignmentId: ctx.assignmentId,
    recordV1: goodRecord({ seat: { role: 'peer', disposition: 'engineer', agentId: 'agent-2' } }),
    candidateId: null,
  });
  assert.equal(other.body.ok, true);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const decision = decideDeskSettlement(ledger, {
    kind: 'settlement.record',
    requestId: 'stl-direct',
    actorAgentId: 'agent-lead',
    assignmentId: ctx.assignmentId,
    seatAgentId: 'agent-1',
    seatTitle: 'bounded task',
    at: SETTLED_AT,
    deliveryRef: 'note:delivered',
    reworkClosureRef: 'note:closed',
    sinkRef: 'issue:x',
    decisionRef: 'decision:x',
    handbackRefs: [other.body.handbackId],
    candidateRefs: [],
    resources: [{ ref: 'agent:peer-1', disposition: 'released' }],
    timeline: { nativeHandle: 'h', sessionId: null, via: 'host-transcript', export: null, gap: 'gap' },
    exportVerification: null,
  });
  assert.equal(decision.ok, false, 'the decide itself must refuse the foreign-seat ref');
  assert.equal(decision.code, 'INVALID_RECORD');
  // Same for a foreign-seat candidateRef.
  const decision2 = decideDeskSettlement(ledger, {
    kind: 'settlement.record',
    requestId: 'stl-direct-2',
    actorAgentId: 'agent-lead',
    assignmentId: ctx.assignmentId,
    seatAgentId: 'agent-1',
    seatTitle: 'bounded task',
    at: SETTLED_AT,
    deliveryRef: 'note:delivered',
    reworkClosureRef: 'note:closed',
    sinkRef: 'issue:x',
    decisionRef: 'decision:x',
    handbackRefs: [],
    candidateRefs: [other.body.observedCandidateId],
    resources: [],
    timeline: { nativeHandle: 'h', sessionId: null, via: 'host-transcript', export: null, gap: 'gap' },
    exportVerification: null,
  });
  assert.equal(decision2.ok, false);
  assert.equal(decision2.code, 'INVALID_RECORD');
});

test('record at the durable/wire boundary values is accepted — parity matrix', async t => {
  const ctx = await settledFixture(t);
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_settlement_record', goodSettlement({
    assignmentId: ctx.assignmentId,
    deliveryRef: 'x'.repeat(WIRE_LIMITS.deskSettlementPointer),
    timeline: { nativeHandle: 'h', sessionId: null, via: 'host-transcript', export: null, gap: 'g'.repeat(WIRE_LIMITS.gapLen) },
  }));
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
  // The durable row's fields must satisfy the result schema verbatim —
  // the F-STD-4 rule: a replayed row can never exceed its wire shape.
  DeskSettlementRecordResult.parse(reply.body);
});
