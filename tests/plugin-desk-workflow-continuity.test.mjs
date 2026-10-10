// tests/plugin-desk-workflow-continuity.test.mjs — public agent reader
// parity for the continuity projection. The agent path is the real desk
// bridge socket (slp_workflow_get); mutations go through the public runner
// seams on the same store. No fixture engine is duplicated here — the
// bridge harness supplies the socket, the store commits every row, and
// the assertions compare the wire result with the pure projection on the
// same verified ledger read. No live daemon state is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { sha256Hex } from '../plugin/server/config-view.ts';
import { runAssignmentRegister } from '../plugin/server/desk-handback.ts';
import { projectDeskWorkflow, runAssignmentAmend } from '../plugin/server/desk-assignment.ts';
import { runAssignmentAccept, runAssignmentOffer } from '../plugin/server/desk-ownership.ts';

const PIN = sha256Hex(readFileSync(BIN_SOURCE));
const FIXED_AT = '2026-01-01T00:00:00.000Z';
const PROVIDER = 'slp-codex-peer';
const livePaseo = agent => ({ agents: { ref: () => ({ refresh: async () => ({ agent }) }) } });
const LIVE_AGENT = { provider: PROVIDER, workspaceId: 'wks-1', archivedAt: null };
const member = (handle, over = {}) => deskMemberRow(handle, { provider: PROVIDER, at: FIXED_AT }, over);
const HELLO = handle => hello(PIN, handle);

const PAGE = { section: 'ownership', expectedLedgerRevision: null, expectedBriefRevision: null, cursor: null, limit: 50 };

async function call(assignmentId, seat, id, over = {}) {
  const reply = await rpc(seat.reader, seat.conn, {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: {
      name: 'slp_workflow_get',
      arguments: { assignmentId, ...PAGE, ...over },
    },
  });
  return JSON.parse(reply.result.content[0].text);
}

test('agent reader: offer nominee, prior and current owners share one projection with no summary-as-authority', async t => {
  const paseoRef = { current: livePaseo(LIVE_AGENT) };
  const f = await startBridge(t, deskBridgeFixture(t, 'slp-wfcont-home-', PIN, { paseoRef }));
  f.bridge.noteDispatch(f.paseoRef.current);
  const git = deskGitRepo(t, 'slp-wfcont-repo-');
  const store = seedStore(f);
  const A = member('handle-lead-a', { role: 'lead', agentId: 'lead-a' });
  const B = member('handle-lead-b', { role: 'lead', agentId: 'lead-b' });
  const C = member('handle-lead-c', { role: 'lead', agentId: 'lead-c' });
  const X = member('handle-peer-x', { agentId: 'peer-x' });
  const repoKey = await seedMemberships(store, repoOf(git), [A, B, C, X]);
  const ctx = row => ({ repoKey, row });
  const ledger = () => {
    const read = store.read(repoKey);
    assert.equal(read.state, 'ok');
    return read.ledger;
  };

  const registered = await runAssignmentRegister(ctx(A), {
    requestId: 'reg-1', authorityRef: 'human:test', objective: 'Keep operative work inspectable',
  }, { store });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const assignmentId = registered.assignmentId;
  const amended = await runAssignmentAmend(ctx(A), {
    requestId: 'brief-1', assignmentId, expectedBriefRevision: 0,
    brief: {
      objective: 'Read the recorded obligations', acceptanceCriteria: ['Everything recorded is inspectable'],
      constraints: [], provisionalDesign: 'Projection only', assumptions: [], unknowns: [], requiredEvidence: [],
      ownedSurfaces: [], excludedSurfaces: [], dependencies: [], notifications: [],
    },
    changeReason: 'Set the operative outcome', authorityRef: 'human:test', affectedOwners: ['lead-a'],
  }, { store });
  assert.equal(amended.ok, true, JSON.stringify(amended));

  // Competing offers at the same base revision: B's is later accepted; C's
  // goes stale and grants no durable read.
  const offerB = await runAssignmentOffer(ctx(A), {
    requestId: 'offer-b', assignmentId, expectedOwnershipRevision: 0,
    targetAgentId: 'lead-b', targetMembershipId: B.membershipId,
    authorityRef: 'human:handoff', contextRef: 'note:planned-succession',
  }, { store });
  assert.equal(offerB.ok, true, JSON.stringify(offerB));
  const offerC = await runAssignmentOffer(ctx(A), {
    requestId: 'offer-c', assignmentId, expectedOwnershipRevision: 0,
    targetAgentId: 'lead-c', targetMembershipId: C.membershipId,
    authorityRef: 'human:handoff', contextRef: 'note:planned-succession',
  }, { store });
  assert.equal(offerC.ok, true, JSON.stringify(offerC));

  const seats = {};
  // Each member reads through its own bound session; the handle pins the
  // exact membership row.
  for (const [name, row] of [['a', A], ['b', B], ['c', C], ['x', X]]) {
    const handle = { a: 'handle-lead-a', b: 'handle-lead-b', c: 'handle-lead-c', x: 'handle-peer-x' }[name];
    const { conn, reader, ack } = await handshake(f.paths.socketPath, HELLO(handle));
    t.after(() => conn.destroy());
    assert.equal(ack.ok, true, `hello ${name}: ${JSON.stringify(ack)}`);
    seats[name] = { conn, reader, row };
  }

  // The nominee reads the assignment before accepting — offer read
  // qualification — and the wire result is byte-identical to the pure
  // projection on the same verified chain read.
  const nomineeView = await call(assignmentId, seats.b, 1);
  assert.equal(nomineeView.ok, true, JSON.stringify(nomineeView));
  assert.deepEqual(nomineeView, projectDeskWorkflow(ledger(), assignmentId, PAGE));
  assert.equal(nomineeView.ownership.ownerAgentId, 'lead-a');
  assert.equal(nomineeView.ownership.ownershipRevision, 0);
  assert.equal(nomineeView.ownership.acceptedAcknowledgment, null);
  assert.deepEqual(nomineeView.items.map(item => item.kind), ['ownershipOffer', 'ownershipOffer']);

  const denied = await call(assignmentId, seats.x, 2);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'AUTHORITY_REQUIRED');

  const accepted = await runAssignmentAccept(ctx(B), {
    requestId: 'accept-b', assignmentId, offerId: offerB.offerId,
    expectedOwnershipRevision: 0, expectedLedgerRevision: ledger().revision, expectedBriefRevision: 1,
    acknowledgment: 'I take custody of the operative work and its open obligations.',
    settlementRef: null, resources: [{ ref: 'issue:TRACK-9', disposition: 'unknown' }],
  }, { store });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  // Parity across the succession boundary: the receiving owner and the
  // still-live prior owner read the same projection through the bridge.
  const receiverView = await call(assignmentId, seats.b, 3);
  const priorView = await call(assignmentId, seats.a, 4);
  assert.equal(receiverView.ok, true, JSON.stringify(receiverView));
  assert.equal(priorView.ok, true, JSON.stringify(priorView));
  const expected = projectDeskWorkflow(ledger(), assignmentId, PAGE);
  assert.deepEqual(receiverView, expected);
  assert.deepEqual(priorView, expected);
  assert.equal(receiverView.ownership.ownerAgentId, 'lead-b');
  assert.equal(receiverView.ownership.ownerMembershipId, B.membershipId);
  assert.equal(receiverView.ownership.registeredOwnerAgentId, 'lead-a');
  assert.equal(receiverView.ownership.ownershipRevision, 1);
  assert.equal(receiverView.ownership.ownerMembership.state, 'host-confirmed');
  const ack = receiverView.ownership.acceptedAcknowledgment;
  assert.equal(ack.acceptId, accepted.acceptId);
  assert.equal(ack.offerId, offerB.offerId);
  assert.equal(ack.acknowledgment, 'I take custody of the operative work and its open obligations.');
  assert.equal(receiverView.items.filter(item => item.kind === 'ownershipAccept').length, 1);
  assert.equal(receiverView.acceptance, 'not-established-by-this-view');

  // The losing offer's nominee has no durable read — a stale offer confers
  // nothing once the revision moved.
  const stale = await call(assignmentId, seats.c, 5);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'AUTHORITY_REQUIRED');

  // A stale CAS pin is a typed conflict on the same public seam.
  const conflicted = await call(assignmentId, seats.b, 6, { expectedLedgerRevision: 0 });
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.code, 'REVISION_CONFLICT');
});
