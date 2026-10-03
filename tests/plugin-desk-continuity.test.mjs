// Identity-preserving assignment continuity — focused ownership/history
// core regressions. Store + decide + runner seams only: no bridge, no
// live host, no sockets. Every ledger row commits through real transact
// calls with real events so the hash chain and event bindings hold.
// Acceptance is proven in BOTH settled branches: while the prior owner's
// pinned membership is still live (acknowledgment precedes archival) and
// after retirement — the committed ownership revision, never liveness,
// removes the former owner's fresh mutation authority.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDeskStore, repoKeyFor } from '../plugin/server/desk-store.ts';
import {
  currentReviewExclusions,
  decideDeskOwnership,
  deskWorkflowParticipant,
  effectiveOwner,
  lineageOwners,
  ownerAtEventSeq,
  runAssignmentAccept,
  runAssignmentOffer,
} from '../plugin/server/desk-ownership.ts';
import { decideDeskAssignment, projectDeskWorkflow } from '../plugin/server/desk-assignment.ts';
import { currentScopeReviewQualification, decideDeskScope } from '../plugin/server/desk-scope.ts';
import { decideDeskRollout } from '../plugin/server/desk-rollout.ts';
import { runAssignmentRegister, seatAssignmentsView } from '../plugin/server/desk-handback.ts';
import { canonicalSha256 } from '../plugin/server/config-view.ts';

const REPO = { hostId: 'host-continuity', gitCommonDir: '/repo/.git' };
const REPO_KEY = repoKeyFor(REPO);
const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const SHA = 'f'.repeat(64);
const HEAD = 'a'.repeat(40);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-desk-cont-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ledgerPath = root => join(root, 'state', 'enforcement', 'repos', REPO_KEY, 'ledger.json');

const member = (agentId, role = 'lead', over = {}) => ({
  membershipId: randomUUID(),
  state: 'host-confirmed',
  bindingHandleSha256: canonicalSha256(`handle:${agentId}:${randomUUID()}`),
  provider: 'slp-codex-peer',
  family: 'codex',
  role,
  createCwd: '/repo',
  openGeneration: 1,
  agentId,
  workspaceId: 'wks-1',
  createdAt: FIXED_NOW,
  hostConfirmedAt: FIXED_NOW,
  registeredAt: FIXED_NOW,
  revokedAt: null,
  revokeReason: null,
  ...over,
});

const assignment = (owner, over = {}) => ({
  assignmentId: 'asg-1',
  requestId: 'req-asg-1',
  authorityRef: 'grant:human-1',
  objective: 'the operative work',
  ownerMembershipId: owner.membershipId,
  ownerAgentId: owner.agentId,
  workspaceId: 'wks-1',
  state: 'open',
  seats: [],
  ...over,
});

const candidate = (seat, over = {}) => ({
  candidateId: 'cand-1',
  assignmentId: 'asg-1',
  kind: 'observed',
  seatAgentId: seat.agentId,
  seatMembershipId: seat.membershipId,
  repository: '/repo',
  snapshotSha256: 'c'.repeat(64),
  head: HEAD,
  incomplete: [],
  measuredAt: FIXED_NOW,
  ...over,
});

// A neutral v7-shaped scope row — the event-binding escape requires the
// additive pins to stay neutral on a seeded declaration.
const scope = (owner, over = {}) => ({
  assignmentId: 'asg-1',
  scopeId: 'scope-1',
  requestId: 'req-scp-1',
  revision: 1,
  priorRevision: null,
  ownerMembershipId: owner.membershipId,
  ownerAgentId: owner.agentId,
  assignmentRevision: 2,
  seatAgentId: null,
  label: 'bounded slice',
  declarationSha256: 'e'.repeat(64),
  refs: [],
  briefRevision: 0,
  ownership: null,
  reviewPlan: null,
  ...over,
});

const brief = (objective, extra = {}) => ({
  objective,
  acceptanceCriteria: ['observable result'],
  constraints: [],
  provisionalDesign: 'provisional choice',
  assumptions: [],
  unknowns: [],
  requiredEvidence: [],
  ownedSurfaces: [],
  excludedSurfaces: [],
  dependencies: [],
  notifications: [],
  ...extra,
});

const rid = label => `req-${label}-${randomUUID()}`;

const envelope = (actorAgentId, requestId, command) => ({
  repo: REPO,
  actorKey: actorAgentId === null ? 'actor-seed' : `agent:${actorAgentId}`,
  assignmentId: command.assignmentId ?? 'asg-1',
  requestId,
  command,
});

/** The durable request key is the envelope's — the command's embedded
 *  requestId is the single source so rows always bind their own request. */
const tx = (store, decide, actorAgentId, requestId, command) =>
  store.transact(REPO_KEY, envelope(actorAgentId, command.requestId ?? requestId, command), decide);

const seed = (store, tables) =>
  store.transact(REPO_KEY, envelope(null, rid('seed'), { action: 'seed' }),
    () => ({ ok: true, events: [], ...tables }));

const ledger = store => {
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  return read.ledger;
};

/** Revoke the pinned row and append a fresh live row for the same agent —
 *  the retired owner's exact membership no longer resolves live, while the
 *  durable row remains for lineage lookups. */
const retire = async (store, row) => {
  const rebound = {
    ...row,
    membershipId: randomUUID(),
    bindingHandleSha256: canonicalSha256(`rebound:${row.agentId}:${randomUUID()}`),
  };
  const memberships = ledger(store).memberships.map(m =>
    m.membershipId === row.membershipId
      ? { ...m, state: 'revoked', revokedAt: FIXED_NOW, revokeReason: 'archived' }
      : m,
  ).concat(rebound);
  const result = await seed(store, { memberships });
  assert.equal(result.ok, true, JSON.stringify(result));
  return rebound;
};

const offerInput = (over = {}) => ({
  requestId: rid('offer'),
  assignmentId: 'asg-1',
  expectedOwnershipRevision: 0,
  targetAgentId: 'agent-b',
  targetMembershipId: undefined,
  authorityRef: 'grant:human-1',
  contextRef: 'note:handoff',
  ...over,
});

const acceptInput = (over = {}) => ({
  requestId: rid('accept'),
  assignmentId: 'asg-1',
  offerId: 'ofr-missing',
  expectedOwnershipRevision: 0,
  expectedLedgerRevision: 0,
  expectedBriefRevision: 0,
  acknowledgment: 'I take custody of the operative work',
  settlementRef: null,
  resources: [],
  ...over,
});

const offerCmd = input => ({ kind: 'ownership.offer', ...input });
const acceptCmd = input => ({ kind: 'ownership.accept', ...input });

/** A seeded ledger with owner lead A, nominee lead B and an optional
 *  attached peer seat R. `seatAgentIds` names agents whose membership rows
 *  also become attached seats (extra agents are created as leads). */
const seededTrio = async (t, { seatAgentIds = [] } = {}) => {
  const dir = fixture(t);
  const store = createDeskStore({ stableRoot: dir });
  const A = member('agent-a', 'lead');
  const B = member('agent-b', 'lead');
  const R = member('agent-r', 'peer');
  const known = new Map([['agent-a', A], ['agent-b', B], ['agent-r', R]]);
  const extra = seatAgentIds
    .filter(id => !known.has(id))
    .map(id => { const row = member(id, 'lead'); known.set(id, row); return row; });
  const asg = assignment(A, {
    seats: seatAgentIds.map(id => ({ agentId: id, membershipId: known.get(id).membershipId })),
  });
  const result = await seed(store, {
    memberships: [A, B, R, ...extra],
    assignments: [asg],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { dir, store, A, B, R, asg };
};

const offer = (store, owner, input) =>
  tx(store, decideDeskOwnership, owner.agentId, input.requestId, offerCmd({ ...input, actorAgentId: owner.agentId }));
const accept = (store, nominee, input) =>
  tx(store, decideDeskOwnership, nominee.agentId, input.requestId, acceptCmd({ ...input, actorAgentId: nominee.agentId }));

// ---------------------------------------------------------------------------
// Offers — append-only nomination by the exact current owner.
// ---------------------------------------------------------------------------

test('offer: exact owner nominates an exact live lead; no authority transfers', async t => {
  const { store, A, B, R, asg } = await seededTrio(t);
  const input = offerInput({ targetMembershipId: B.membershipId });
  const result = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, input, { store },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ownershipRevision, 0);
  assert.ok(result.offerId.startsWith('ofr-'));

  const read = ledger(store);
  assert.equal(read.ownershipOffers.length, 1);
  const row = read.ownershipOffers[0];
  assert.equal(row.fromAgentId, 'agent-a');
  assert.equal(row.fromMembershipId, A.membershipId);
  assert.equal(row.toAgentId, 'agent-b');
  assert.equal(row.toMembershipId, B.membershipId);

  // Offering transfers nothing — custody is still revision 0 under A.
  const owner = effectiveOwner(read, asg);
  assert.equal(owner.agentId, 'agent-a');
  assert.equal(owner.membershipId, A.membershipId);
  assert.equal(owner.ownershipRevision, 0);

  // Participant discovery: nominee reads, the roster is unchanged.
  assert.equal(deskWorkflowParticipant(read, B, asg), 'offer-nominee');
  assert.equal(deskWorkflowParticipant(read, A, asg), 'current-owner');
  assert.equal(deskWorkflowParticipant(read, R, asg), null);
  assert.deepEqual(lineageOwners(asg, read.ownershipAccepts), [
    { agentId: 'agent-a', membershipId: A.membershipId },
  ]);
});

test('offer: stale revision, non-owner, dead/non-lead/wrong-pin targets and self all reject', async t => {
  const { store, A, B, R, asg } = await seededTrio(t);
  const base = offerInput({ targetMembershipId: B.membershipId });

  // Stale ownership CAS.
  const stale = await tx(store, decideDeskOwnership, A.agentId, rid('offer'),
    offerCmd({ ...base, requestId: rid('offer'), expectedOwnershipRevision: 1, actorAgentId: A.agentId }));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'REVISION_CONFLICT');

  // A non-owner lead and a peer seat both fail the exact-owner check.
  const nonOwner = await tx(store, decideDeskOwnership, B.agentId, rid('offer'),
    offerCmd({ ...base, requestId: rid('offer'), actorAgentId: B.agentId }));
  assert.equal(nonOwner.ok, false);
  assert.equal(nonOwner.code, 'AUTHORITY_REQUIRED');
  const peerOffer = await tx(store, decideDeskOwnership, R.agentId, rid('offer'),
    offerCmd({ ...base, requestId: rid('offer'), actorAgentId: R.agentId }));
  assert.equal(peerOffer.ok, false);
  assert.equal(peerOffer.code, 'AUTHORITY_REQUIRED');

  // Wrong membership pin for the target, a dead target, a non-lead target.
  const wrongPin = await tx(store, decideDeskOwnership, A.agentId, rid('offer'),
    offerCmd({ ...base, requestId: rid('offer'), targetMembershipId: randomUUID(), actorAgentId: A.agentId }));
  assert.equal(wrongPin.ok, false);
  assert.equal(wrongPin.code, 'ACTOR_MISMATCH');
  const deadTarget = await tx(store, decideDeskOwnership, A.agentId, rid('offer'),
    offerCmd({ ...base, requestId: rid('offer'), targetAgentId: 'agent-ghost', targetMembershipId: randomUUID(), actorAgentId: A.agentId }));
  assert.equal(deadTarget.ok, false);
  assert.equal(deadTarget.code, 'ACTOR_MISMATCH');
  const peerTarget = await tx(store, decideDeskOwnership, A.agentId, rid('offer'),
    offerCmd({ ...base, requestId: rid('offer'), targetAgentId: R.agentId, targetMembershipId: R.membershipId, actorAgentId: A.agentId }));
  assert.equal(peerTarget.ok, false);
  assert.equal(peerTarget.code, 'ACTOR_MISMATCH');

  // Self-nomination is malformed, not a succession.
  const self = await tx(store, decideDeskOwnership, A.agentId, rid('offer'),
    offerCmd({ ...base, requestId: rid('offer'), targetAgentId: A.agentId, targetMembershipId: A.membershipId, actorAgentId: A.agentId }));
  assert.equal(self.ok, false);
  assert.equal(self.code, 'INVALID_RECORD');
  assert.equal(ledger(store).ownershipOffers.length, 0);

  // A closed assignment takes no offers.
  const closed = { ...asg, state: 'closed' };
  const seed2 = await seed(store, { assignments: [closed] });
  assert.equal(seed2.ok, true);
  const onClosed = await tx(store, decideDeskOwnership, A.agentId, rid('offer'),
    offerCmd({ ...base, requestId: rid('offer'), actorAgentId: A.agentId }));
  assert.equal(onClosed.ok, false);
  assert.equal(onClosed.code, 'AUTHORITY_REQUIRED');
});

// ---------------------------------------------------------------------------
// Accepts — the exact nominee takes custody; the prior owner's session
// state (live or retired) is never a mutex.
// ---------------------------------------------------------------------------

test('accept: no offer, wrong nominee and stale pins reject — prior session state is never consulted', async t => {
  const { store, A, B, R } = await seededTrio(t);
  const deps = { store };

  // No offer exists at all — there is no unauthenticated recovery path.
  const noOffer = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B }, acceptInput(), deps);
  assert.equal(noOffer.ok, false);
  assert.equal(noOffer.code, 'AUTHORITY_REQUIRED');

  // An unregistered "human pointer" agent cannot claim custody either.
  const ghost = member('agent-human', 'lead');
  const ghostAccept = await tx(store, decideDeskOwnership, ghost.agentId, rid('accept'),
    acceptCmd({ ...acceptInput(), actorAgentId: ghost.agentId }));
  assert.equal(ghostAccept.ok, false);
  assert.equal(ghostAccept.code, 'AUTHORITY_REQUIRED');

  const real = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetMembershipId: B.membershipId }), deps);
  assert.equal(real.ok, true);

  // Wrong nominee — the peer and a non-nominated lead both fail.
  const peerAccept = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: R }, acceptInput({ offerId: real.offerId }), deps);
  assert.equal(peerAccept.ok, false);
  assert.equal(peerAccept.code, 'AUTHORITY_REQUIRED');
  const outsider = member('agent-c', 'lead');
  const seededC = await seed(store, { memberships: [...ledger(store).memberships, outsider] });
  assert.equal(seededC.ok, true);
  const outsiderAccept = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: outsider }, acceptInput({ offerId: real.offerId }), deps);
  assert.equal(outsiderAccept.ok, false);
  assert.equal(outsiderAccept.code, 'AUTHORITY_REQUIRED');

  // Stale revision pins reject — with the prior owner still fully live.
  const staleLedger = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B }, acceptInput({
      offerId: real.offerId,
      expectedLedgerRevision: 0,
    }), deps);
  assert.equal(staleLedger.ok, false);
  assert.equal(staleLedger.code, 'REVISION_CONFLICT');
  const staleBrief = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B }, acceptInput({
      offerId: real.offerId,
      expectedLedgerRevision: ledger(store).revision,
      expectedBriefRevision: 9,
    }), deps);
  assert.equal(staleBrief.ok, false);
  assert.equal(staleBrief.code, 'REVISION_CONFLICT');
  const staleOwnership = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B }, acceptInput({
      offerId: real.offerId,
      expectedOwnershipRevision: 4,
      expectedLedgerRevision: ledger(store).revision,
    }), deps);
  assert.equal(staleOwnership.ok, false);
  assert.equal(staleOwnership.code, 'REVISION_CONFLICT');
});

test('succession while prior stays live: acceptance removes fresh authority, not read or identity', async t => {
  const { store, A, B, R, asg } = await seededTrio(t, { seatAgentIds: ["agent-r"] });
  const deps = { store };

  // A writes brief revision 1, then offers — work may continue under the
  // standing offer without transferring authority.
  const amended = await tx(store, decideDeskAssignment, A.agentId, rid('amend'),
    {
      kind: 'assignment.amend', actorAgentId: A.agentId, requestId: rid('amend'),
      assignmentId: 'asg-1', expectedBriefRevision: 0, brief: brief('first brief'),
      changeReason: 'initial', authorityRef: 'grant:human-1', affectedOwners: [],
    });
  assert.equal(amended.ok, true, JSON.stringify(amended));
  const offerResult = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetMembershipId: B.membershipId }), deps);
  assert.equal(offerResult.ok, true, JSON.stringify(offerResult));
  const amended2 = await tx(store, decideDeskAssignment, A.agentId, rid('amend'),
    {
      kind: 'assignment.amend', actorAgentId: A.agentId, requestId: rid('amend'),
      assignmentId: 'asg-1', expectedBriefRevision: 1, brief: brief('second brief'),
      changeReason: 'still working', authorityRef: 'grant:human-1', affectedOwners: [],
    });
  assert.equal(amended2.ok, true, JSON.stringify(amended2));

  // The exact nominee accepts while A's pinned membership is still live —
  // receiving acknowledgment can precede archival; no cleanup is inferred.
  const accepted = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B }, acceptInput({
      offerId: offerResult.offerId,
      expectedLedgerRevision: ledger(store).revision,
      expectedBriefRevision: 2,
      settlementRef: 'settlement:acct-1',
      resources: [{ ref: 'repo:/repo', disposition: 'retained' }],
    }), deps);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.ownershipRevision, 1);
  assert.deepEqual(accepted.gaps, []);

  const read = ledger(store);
  assert.equal(read.ownershipAccepts.length, 1);
  const acceptRow = read.ownershipAccepts[0];
  assert.equal(acceptRow.ownershipRevision, 1);
  assert.equal(acceptRow.toMembershipId, B.membershipId);
  assert.equal(acceptRow.fromMembershipId, A.membershipId);

  // Custody moved to B's exact tuple; the registration tuple is immutable.
  const after = effectiveOwner(read, asg);
  assert.deepEqual(after, { agentId: 'agent-b', membershipId: B.membershipId, ownershipRevision: 1 });
  const persistedAsg = read.assignments.find(a => a.assignmentId === 'asg-1');
  assert.equal(persistedAsg.ownerAgentId, 'agent-a');
  assert.equal(persistedAsg.ownerMembershipId, A.membershipId);
  assert.deepEqual(lineageOwners(asg, read.ownershipAccepts).map(t => t.agentId), ['agent-a', 'agent-b']);

  // The still-live prior owner keeps participant read access to history
  // but holds no fresh mutation authority — the ownership revision, not
  // its live session, is the mutex.
  assert.equal(deskWorkflowParticipant(read, A, persistedAsg), 'prior-owner');
  assert.equal(deskWorkflowParticipant(read, B, persistedAsg), 'current-owner');
  assert.equal(deskWorkflowParticipant(read, R, persistedAsg), 'attached-seat');
  const denied = await tx(store, decideDeskAssignment, A.agentId, rid('amend'),
    {
      kind: 'assignment.amend', actorAgentId: A.agentId, requestId: rid('amend'),
      assignmentId: 'asg-1', expectedBriefRevision: 2, brief: brief('former owner writes'),
      changeReason: 'attempt', authorityRef: 'grant:fake', affectedOwners: [],
    });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'AUTHORITY_REQUIRED');
  const deniedOffer = await tx(store, decideDeskOwnership, A.agentId, rid('offer'),
    offerCmd({ ...offerInput({ targetMembershipId: R.membershipId }), actorAgentId: A.agentId }));
  assert.equal(deniedOffer.ok, false);
  assert.equal(deniedOffer.code, 'AUTHORITY_REQUIRED');

  // The successor mutates under its own pin; A's rev-0 briefs stay bound
  // to A's custody at their own event time — history does not relabel.
  const amended3 = await tx(store, decideDeskAssignment, B.agentId, rid('amend'),
    {
      kind: 'assignment.amend', actorAgentId: B.agentId, requestId: rid('amend'),
      assignmentId: 'asg-1', expectedBriefRevision: 2, brief: brief('successor brief'),
      changeReason: 'successor continues', authorityRef: 'grant:human-1', affectedOwners: [],
    });
  assert.equal(amended3.ok, true, JSON.stringify(amended3));
  const clean = store.read(REPO_KEY);
  assert.equal(clean.state, 'ok', 'A-authored history remains valid at its own event time');
});

test('succession after retirement: the same acceptance completes with the pinned row archived', async t => {
  const { store, A, B, R, asg } = await seededTrio(t, { seatAgentIds: ["agent-r"] });
  const deps = { store };
  const offerResult = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetMembershipId: B.membershipId }), deps);
  assert.equal(offerResult.ok, true);

  // The prior owner retires before the nominee acknowledges — the second
  // settled branch completes identically.
  const a2 = await retire(store, A);
  const accepted = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B }, acceptInput({
      offerId: offerResult.offerId,
      expectedLedgerRevision: ledger(store).revision,
    }), deps);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.ownershipRevision, 1);
  assert.deepEqual(accepted.gaps, ['settlement-account-missing']);

  const read = ledger(store);
  const persistedAsg = read.assignments.find(a => a.assignmentId === 'asg-1');
  assert.equal(deskWorkflowParticipant(read, B, persistedAsg), 'current-owner');
  // A rebound prior owner holds no lineage pin — it participates in nothing.
  assert.equal(deskWorkflowParticipant(read, a2, persistedAsg), null);
});

test('two consecutive acceptances: effectiveOwner resolves the contiguous tip regardless of table order', async t => {
  const { store, A, B, R, asg } = await seededTrio(t);
  const deps = { store };
  const C = member('agent-c', 'lead');
  const D = member('agent-d', 'lead');
  assert.equal((await seed(store, { memberships: [...ledger(store).memberships, C, D] })).ok, true);

  // A → B while everyone stays live; a competing offer to D rides the same
  // base revision and loses.
  const offerB = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetMembershipId: B.membershipId }), deps);
  const offerD = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetAgentId: 'agent-d', targetMembershipId: D.membershipId }), deps);
  assert.equal(offerB.ok, true);
  assert.equal(offerD.ok, true);
  const acceptB = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B },
    acceptInput({ offerId: offerB.offerId, expectedLedgerRevision: ledger(store).revision }), deps);
  assert.equal(acceptB.ok, true, JSON.stringify(acceptB));
  assert.equal(acceptB.ownershipRevision, 1);

  // B → C: the new effective owner may itself nominate onward.
  const offerC = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: B },
    offerInput({ targetAgentId: 'agent-c', targetMembershipId: C.membershipId, expectedOwnershipRevision: 1 }), deps);
  assert.equal(offerC.ok, true, JSON.stringify(offerC));
  const acceptC = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: C },
    acceptInput({
      offerId: offerC.offerId, expectedOwnershipRevision: 1,
      expectedLedgerRevision: ledger(store).revision,
    }), deps);
  assert.equal(acceptC.ok, true, JSON.stringify(acceptC));
  assert.equal(acceptC.ownershipRevision, 2);

  const read = ledger(store);
  const persistedAsg = read.assignments.find(a => a.assignmentId === 'asg-1');
  assert.deepEqual(effectiveOwner(read, persistedAsg),
    { agentId: 'agent-c', membershipId: C.membershipId, ownershipRevision: 2 });
  assert.deepEqual(lineageOwners(persistedAsg, read.ownershipAccepts).map(t => t.agentId),
    ['agent-a', 'agent-b', 'agent-c']);

  // Order-independent resolution — a shuffled table still lands on the
  // contiguous tip, never on array position.
  const shuffled = { ...read, ownershipAccepts: [...read.ownershipAccepts].reverse() };
  assert.deepEqual(effectiveOwner(shuffled, persistedAsg).agentId, 'agent-c');

  // Both prior owners keep exact-pin live read; the stale rev-0 nominee
  // and a rebound non-lineage membership get nothing.
  assert.equal(deskWorkflowParticipant(read, A, persistedAsg), 'prior-owner');
  assert.equal(deskWorkflowParticipant(read, B, persistedAsg), 'prior-owner');
  assert.equal(deskWorkflowParticipant(read, C, persistedAsg), 'current-owner');
  assert.equal(deskWorkflowParticipant(read, D, persistedAsg), null);
});

test('replay: a repeated request resolves the original immutable row, never a fresh write', async t => {
  const { store, A, B } = await seededTrio(t);
  const deps = { store };
  const input = offerInput({ targetMembershipId: B.membershipId });

  const first = await runAssignmentOffer({ repoKey: REPO_KEY, row: A }, input, deps);
  const second = await runAssignmentOffer({ repoKey: REPO_KEY, row: A }, input, deps);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first, 'identical request rebuilds the identical offer result');
  assert.equal(ledger(store).ownershipOffers.length, 1);

  // After succession, the rebound live membership may still replay its own
  // historical receipt — the row resolves immutably, never a fresh offer.
  const a2 = await retire(store, A);
  const acceptReq = acceptInput({
    offerId: first.offerId, expectedLedgerRevision: ledger(store).revision });
  const accepted = await runAssignmentAccept({ repoKey: REPO_KEY, row: B }, acceptReq, deps);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const replayed = await runAssignmentOffer({ repoKey: REPO_KEY, row: a2 }, input, deps);
  assert.deepEqual(replayed, first, 'a live caller replays the immutable offer, not a new offer');
  assert.equal(ledger(store).ownershipOffers.length, 1);

  // The identical accept request resolves its own committed row — the
  // recorded outcome replays verbatim, never a fresh write.
  const acceptAgain = await runAssignmentAccept({ repoKey: REPO_KEY, row: B }, acceptReq, deps);
  assert.deepEqual(acceptAgain, accepted);
  assert.equal(ledger(store).ownershipAccepts.length, 1);
});

test('runner preflight: a stale or revoked caller membership is STALE_EPOCH before any receipt', async t => {
  const { store, A, B } = await seededTrio(t);
  const deps = { store };
  await retire(store, A);
  const result = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetMembershipId: B.membershipId }), deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE_EPOCH');
});

// ---------------------------------------------------------------------------
// Durability — rows bind their own committed events; tampering is corrupt.
// ---------------------------------------------------------------------------

test('tamper: rewritten accept fields fail event binding; a re-pointed tuple is corrupt', async t => {
  const { store, A, B, dir } = await seededTrio(t);
  const deps = { store };
  const offerResult = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetMembershipId: B.membershipId }), deps);
  assert.equal(offerResult.ok, true);
  const accepted = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B },
    acceptInput({ offerId: offerResult.offerId, expectedLedgerRevision: ledger(store).revision }), deps);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  // Rewrite the accept acknowledgment — row checks pass, the committed
  // event payload no longer binds.
  const path = ledgerPath(dir);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  file.ownershipAccepts[0].acknowledgment = 'forged words';
  writeFileSync(path, JSON.stringify(file));
  assert.equal(store.read(REPO_KEY).state, 'corrupt');
  writeFileSync(path, JSON.stringify({ ...file, ownershipAccepts: [{
    ...file.ownershipAccepts[0], acknowledgment: 'I take custody of the operative work',
    toMembershipId: randomUUID(),
  }] }));
  assert.equal(store.read(REPO_KEY).state, 'corrupt', 'a re-pointed successor tuple is corrupt');
});

test('registration history: replacing the registered owner cannot bypass the succession protocol', async t => {
  const { store, A, B, dir } = await seededTrio(t);
  const registered = await runAssignmentRegister({ repoKey: REPO_KEY, row: A }, {
    requestId: 'register-pinned-owner', authorityRef: 'grant:original', objective: 'Keep the same authority lineage',
  }, { store });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const path = ledgerPath(dir);
  const original = readFileSync(path, 'utf8');
  const forged = JSON.parse(original);
  const row = forged.assignments.find(row => row.assignmentId === registered.assignmentId);
  row.ownerAgentId = B.agentId;
  row.ownerMembershipId = B.membershipId;
  writeFileSync(path, JSON.stringify(forged));
  assert.equal(store.read(REPO_KEY).state, 'corrupt', 'the registration event binds its original owner');
  writeFileSync(path, original);
  const rebound = await retire(store, A);
  const reboundLedger = JSON.parse(readFileSync(path, 'utf8'));
  reboundLedger.assignments.find(row => row.assignmentId === registered.assignmentId).ownerMembershipId = rebound.membershipId;
  writeFileSync(path, JSON.stringify(reboundLedger));
  assert.equal(store.read(REPO_KEY).state, 'corrupt', 'a new membership of the same agent cannot replace the original pin');
});

test('no-event offer rows are never authorized — the binding has no seeded escape', async t => {
  const { store, A, B } = await seededTrio(t);
  const forged = {
    offerId: 'ofr-forged',
    assignmentId: 'asg-1',
    requestId: rid('forged'),
    ownershipRevision: 0,
    fromAgentId: 'agent-a',
    fromMembershipId: A.membershipId,
    toAgentId: 'agent-b',
    toMembershipId: B.membershipId,
    authorityRef: 'grant:x',
    contextRef: 'note:x',
  };
  // The pre-commit refinement throws rather than persisting a ledger that
  // would read corrupt — the offer row can never exist without its event.
  await assert.rejects(() => seed(store, { ownershipOffers: [forged] }), /refusing to commit/);
  assert.equal(ledger(store).ownershipOffers.length, 0, 'no forged row was written');
});

test('history: an event-bound offer by a former owner cannot reuse its old ownership revision', async t => {
  const { store, A, B } = await seededTrio(t);
  const offered = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetMembershipId: B.membershipId }), { store });
  assert.equal(offered.ok, true);
  const accepted = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B },
    acceptInput({ offerId: offered.offerId, expectedLedgerRevision: ledger(store).revision }), { store });
  assert.equal(accepted.ok, true);
  const before = ledger(store);
  const stale = { ...before.ownershipOffers[0], offerId: 'ofr-stale-event', requestId: 'req-stale-event' };
  // Bypass the producer deliberately: matching row/event bytes still need
  // event-time authority in the store's independent historical verifier.
  await assert.rejects(() => store.transact(REPO_KEY,
    envelope(A.agentId, stale.requestId, { assignmentId: 'asg-1', requestId: stale.requestId }),
    () => ({ ok: true, ownershipOffers: [...before.ownershipOffers, stale], events: [{
      kind: 'ownership-offered', payload: {
        offerId: stale.offerId, ownershipRevision: stale.ownershipRevision,
        fromAgentId: stale.fromAgentId, fromMembershipId: stale.fromMembershipId,
        toAgentId: stale.toAgentId, toMembershipId: stale.toMembershipId,
        authorityRef: stale.authorityRef, contextRef: stale.contextRef,
      },
    }] })), /refusing to commit/);
  assert.deepEqual(ledger(store), before, 'the stale offer commits no row, revision or event');
});

// ---------------------------------------------------------------------------
// Migration + cohort — v7→v8 additive; revision-0 pins stay legacy; an
// accepted revision drifts the pinned cohort even with identical members.
// ---------------------------------------------------------------------------

const rolloutDecl = (actor, requestId, rolloutId, scopeId, candidateSnapshot) => ({
  kind: 'rollout.declare', actorAgentId: actor.agentId, requestId,
  assignmentId: 'asg-1', scopeId, rolloutId,
  label: 'p5 rollout', declarationSha256: 'e'.repeat(64),
  candidateSnapshot, candidateHead: HEAD, requiredChecks: [], refs: [],
});
const rolloutMove = (actor, requestId, rolloutId, transition) => ({
  kind: 'rollout.transition', actorAgentId: actor.agentId, requestId,
  assignmentId: 'asg-1', rolloutId, transition,
  rolloutRevision: 1, targetSnapshot: null, evidenceRefs: [],
});

test('cohort: migrated rev-0 pin stays valid; accepted revision drifts with identical members', async t => {
  const dir = fixture(t);
  const store = createDeskStore({ stableRoot: dir });
  const A = member('agent-a', 'lead');
  const B = member('agent-b', 'lead');
  const R = member('agent-r', 'peer');
  // The prior owner stays in the roster as a seat — the member set is
  // identical before and after succession, so only the ownership revision
  // in the digest recipe can drift the pin.
  const asg = assignment(A, {
    seats: [
      { agentId: A.agentId, membershipId: A.membershipId },
      { agentId: B.agentId, membershipId: B.membershipId },
      { agentId: R.agentId, membershipId: R.membershipId },
    ],
  });
  const cand = candidate(R);
  const scp = scope(A);
  const seeded = await seed(store, {
    memberships: [A, B, R],
    assignments: [asg],
    candidates: [cand],
    scopes: [scp],
  });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));

  // Drive both rollouts to canary-running through the real decide — every
  // row+event pair commits with honest bindings.
  for (const rolloutId of ['ro-1', 'ro-2']) {
    for (const cmd of [
      rolloutDecl(A, rid('rol'), rolloutId, 'scope-1', cand.snapshotSha256),
      rolloutMove(A, rid('rtn'), rolloutId, 'start-checks'),
      rolloutMove(A, rid('rtn'), rolloutId, 'checks-passed'),
      rolloutMove(A, rid('rtn'), rolloutId, 'canary-ready'),
      rolloutMove(A, rid('rtn'), rolloutId, 'start-canary'),
    ]) {
      const result = await tx(store, decideDeskRollout, A.agentId, cmd.requestId, cmd);
      assert.equal(result.ok, true, `${rolloutId} ${cmd.transition ?? cmd.kind}: ${JSON.stringify(result)}`);
    }
  }

  // The pinned cohort used the legacy recipe — no ownershipRevision field.
  const pre = ledger(store);
  const canary = pre.rolloutTransitions.find(row => row.rolloutId === 'ro-1' && row.command === 'start-canary');
  assert.equal(canary.cohort.ownershipRevision, undefined);
  assert.equal(canary.cohort.digest, canonicalSha256({
    members: ['agent-a', 'agent-b', 'agent-r'], assignmentRevision: canary.cohort.assignmentRevision,
  }));

  // Downgrade the file to the v7 shape — the seeded rev-0 rows are already
  // byte-identical to what v7 would have written.
  const path = ledgerPath(dir);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  delete file.ownershipOffers;
  delete file.ownershipAccepts;
  file.schemaVersion = 7;
  writeFileSync(path, JSON.stringify(file));

  const migrated = store.read(REPO_KEY);
  assert.equal(migrated.state, 'ok');
  assert.equal(migrated.persistedSchemaVersion, 7);
  assert.equal(migrated.ledger.schemaVersion, 8);
  assert.deepEqual(migrated.ledger.ownershipOffers, []);
  assert.deepEqual(migrated.ledger.ownershipAccepts, []);

  // Migration alone at ownership revision 0: the legacy pin still gates.
  const passed = await tx(store, decideDeskRollout, A.agentId, rid('rtn'),
    rolloutMove(A, rid('rtn'), 'ro-1', 'canary-passed'));
  assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).schemaVersion, 8);

  // Succession while the prior owner stays live — the roster is identical;
  // only the ownership revision in the digest recipe moves.
  const offerResult = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetMembershipId: B.membershipId }), { store });
  assert.equal(offerResult.ok, true, JSON.stringify(offerResult));
  const accepted = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B },
    acceptInput({ offerId: offerResult.offerId, expectedLedgerRevision: ledger(store).revision }), { store });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  const drift = await tx(store, decideDeskRollout, B.agentId, rid('rtn'),
    rolloutMove(B, rid('rtn'), 'ro-2', 'canary-passed'));
  assert.equal(drift.ok, false);
  assert.equal(drift.code, 'COHORT_DRIFT',
    'an accepted ownership revision drifts the pinned cohort even with identical members');
});

// ---------------------------------------------------------------------------
// Review discharge — the shared resolver requalifies observations against
// the current owner/writer; exact-pinned independent reviews still reuse.
// ---------------------------------------------------------------------------

test('review discharge: a review authored by the later owner cannot discharge that owner’s own gate', async t => {
  const dir = fixture(t);
  const store = createDeskStore({ stableRoot: dir });
  const A = member('agent-a', 'lead');
  const B = member('agent-b', 'lead');
  const R = member('agent-r', 'lead');
  const asg = assignment(A, {
    seats: [
      { agentId: B.agentId, membershipId: B.membershipId },
      { agentId: R.agentId, membershipId: R.membershipId },
    ],
  });
  const cand = candidate(R);
  const seeded = await seed(store, {
    memberships: [A, B, R],
    assignments: [asg],
    candidates: [cand],
  });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));

  const plan = {
    kind: 'required', authorityRef: 'grant:human-1', ruleRef: 'rule:review',
    reason: 'mandated lens', lenses: [{ id: 'lens-1', name: 'lens one', authorityRef: 'grant:human-1', ruleRef: 'rule:review' }],
    exemptionClass: null,
  };
  const declare = await tx(store, decideDeskScope, A.agentId, rid('scp'), {
    kind: 'scope.declare', actorAgentId: A.agentId, requestId: rid('scp'),
    assignmentId: 'asg-1', scopeId: 'scope-1', label: 'bounded slice',
    declarationSha256: 'e'.repeat(64), refs: [], seatAgentId: null,
    reviewPlan: plan,
  });
  assert.equal(declare.ok, true, JSON.stringify(declare));
  const scopeTx = (actor, transition, extra = {}) => tx(store, decideDeskScope, actor.agentId, rid('sct'), {
    kind: 'scope.transition', actorAgentId: actor.agentId, requestId: rid('sct'),
    assignmentId: 'asg-1', scopeId: 'scope-1', transition, scopeRevision: 1,
    candidateSnapshot: null, candidateHead: null, ...extra,
  });
  assert.equal((await scopeTx(A, 'claim')).ok, true);
  assert.equal((await scopeTx(A, 'submit-for-review', {
    candidateSnapshot: cand.snapshotSha256, candidateHead: HEAD,
  })).ok, true);

  // B records the required review as a seat — valid at rev-0 event time.
  const bReview = await tx(store, decideDeskScope, B.agentId, rid('rev'), {
    kind: 'scope.review', actorAgentId: B.agentId, requestId: rid('rev'),
    assignmentId: 'asg-1', scopeId: 'scope-1', scopeRevision: 1,
    candidateSnapshot: cand.snapshotSha256, lensId: 'lens-1',
    verdict: 'approve', findingsRef: null,
  });
  assert.equal(bReview.ok, true, JSON.stringify(bReview));
  const bReviewId = ledger(store).scopeReviews.find(row => row.reviewerAgentId === B.agentId).reviewId;
  assert.deepEqual(currentScopeReviewQualification(ledger(store), asg, 'scope-1').eligibleReviewIds, [bReviewId]);

  // Succession while the prior owner stays live: B becomes the effective
  // owner, and the shared resolver now excludes B's own observation.
  const offerResult = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetMembershipId: B.membershipId }), { store });
  assert.equal(offerResult.ok, true);
  const accepted = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B },
    acceptInput({ offerId: offerResult.offerId, expectedLedgerRevision: ledger(store).revision }), { store });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.ok(currentReviewExclusions(ledger(store), asg, { ownership: null }).has('agent-b'));
  assert.deepEqual(currentScopeReviewQualification(ledger(store), asg, 'scope-1').eligibleReviewIds, []);

  // B's own earlier observation stays valid history but cannot discharge
  // B's own gate — review-observed requalifies it against current custody.
  const selfDischarge = await scopeTx(B, 'review-observed');
  assert.equal(selfDischarge.ok, false);
  assert.equal(selfDischarge.code, 'REVIEW_INCOMPLETE');

  // An exact-pinned third-party review reuses and discharges the round.
  const rReview = await tx(store, decideDeskScope, R.agentId, rid('rev'), {
    kind: 'scope.review', actorAgentId: R.agentId, requestId: rid('rev'),
    assignmentId: 'asg-1', scopeId: 'scope-1', scopeRevision: 1,
    candidateSnapshot: cand.snapshotSha256, lensId: 'lens-1',
    verdict: 'approve', findingsRef: null,
  });
  assert.equal(rReview.ok, true, JSON.stringify(rReview));
  const observed = await scopeTx(B, 'review-observed');
  assert.equal(observed.ok, true, JSON.stringify(observed));
  const approved = await scopeTx(B, 'approve');
  assert.equal(approved.ok, true, JSON.stringify(approved));

  // The reader and promotion share the gate's qualification. If the
  // independent reviewer later accepts ownership, history stays readable
  // but that standing approval cannot carry the new owner's promotion.
  assert.ok(currentScopeReviewQualification(ledger(store), asg, 'scope-1').standingApproval);
  const nextOffer = await runAssignmentOffer({ repoKey: REPO_KEY, row: B }, offerInput({
    targetAgentId: R.agentId, targetMembershipId: R.membershipId, expectedOwnershipRevision: 1,
  }), { store });
  assert.equal(nextOffer.ok, true, JSON.stringify(nextOffer));
  const nextAccepted = await runAssignmentAccept({ repoKey: REPO_KEY, row: R }, acceptInput({
    offerId: nextOffer.offerId, expectedOwnershipRevision: 1, expectedLedgerRevision: ledger(store).revision,
  }), { store });
  assert.equal(nextAccepted.ok, true, JSON.stringify(nextAccepted));
  assert.equal(currentScopeReviewQualification(ledger(store), asg, 'scope-1').standingApproval, null);
  const rolloutId = 'rollout-reviewed';
  assert.equal((await tx(store, decideDeskRollout, R.agentId, rid('rol'),
    rolloutDecl(R, rid('rol'), rolloutId, 'scope-1', cand.snapshotSha256))).ok, true);
  for (const move of ['start-checks', 'checks-passed', 'canary-ready', 'start-canary', 'canary-passed']) {
    const moved = await tx(store, decideDeskRollout, R.agentId, rid('rol'), rolloutMove(R, rid('rol'), rolloutId, move));
    assert.equal(moved.ok, true, JSON.stringify(moved));
  }
  const beforePromote = ledger(store);
  const promote = await tx(store, decideDeskRollout, R.agentId, rid('rol'), rolloutMove(R, rid('rol'), rolloutId, 'promote'));
  assert.equal(promote.ok, false);
  assert.equal(promote.code, 'REVIEW_INCOMPLETE');
  assert.deepEqual(ledger(store).rolloutTransitions, beforePromote.rolloutTransitions);

  // Independently challenge the durable verifier with a buggy producer
  // that mislabels the current owner's old review as a third-party one.
  // The real stored observation and its event remain untouched.
  const forgedCommand = rolloutMove(R, rid('forged-promote'), rolloutId, 'promote');
  const beforeForged = ledger(store);
  await assert.rejects(() => store.transact(REPO_KEY,
    envelope(R.agentId, forgedCommand.requestId, forgedCommand),
    (state, command) => decideDeskRollout({ ...state,
      scopeReviews: state.scopeReviews.map(row => row.reviewerAgentId === R.agentId
        ? { ...row, reviewerAgentId: A.agentId } : row),
    }, command)), /refusing to commit/);
  assert.deepEqual(ledger(store), beforeForged);

  // B's own review row remains in the immutable history — readable, bound
  // to its own event time, never erased by the succession.
  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.ledger.scopeReviews.filter(row => row.reviewerAgentId === 'agent-b').length, 1);
});

// ---------------------------------------------------------------------------
// Read projection — ownership header and lineage items in the workflow.
// ---------------------------------------------------------------------------

test('workflow projection carries registered + effective tuples and lineage items', async t => {
  const { store, A, B } = await seededTrio(t);
  const deps = { store };
  const offerResult = await runAssignmentOffer(
    { repoKey: REPO_KEY, row: A }, offerInput({ targetMembershipId: B.membershipId }), deps);
  const acceptResult = await runAssignmentAccept(
    { repoKey: REPO_KEY, row: B },
    acceptInput({ offerId: offerResult.offerId, expectedLedgerRevision: ledger(store).revision }), deps);

  const read = ledger(store);
  const page = projectDeskWorkflow(read, 'asg-1', {
    section: 'ownership', expectedLedgerRevision: null,
    expectedBriefRevision: null, cursor: null, limit: 10,
  });
  assert.equal(page.ok, true, JSON.stringify(page));
  // Reader-shape assertion: the header carries the registered/effective
  // tuples plus the recorded membership state and the tip accept's
  // acknowledgment provenance — read-time metadata, never acceptance.
  const tipAccept = read.ownershipAccepts.find(row => row.ownershipRevision === 1);
  assert.deepEqual(page.ownership, {
    registeredOwnerAgentId: 'agent-a',
    registeredOwnerMembershipId: A.membershipId,
    ownerAgentId: 'agent-b',
    ownerMembershipId: B.membershipId,
    ownershipRevision: 1,
    ownerMembership: { state: B.state, registeredAt: B.registeredAt, revokedAt: B.revokedAt },
    acceptedAcknowledgment: {
      acceptId: acceptResult.acceptId,
      offerId: offerResult.offerId,
      requestId: tipAccept.requestId,
      acknowledgment: tipAccept.acknowledgment,
      settlementRef: tipAccept.settlementRef,
      gaps: tipAccept.gaps,
      ledgerRevision: tipAccept.ledgerRevision,
      briefRevision: tipAccept.briefRevision,
    },
  });
  const kinds = page.items.map(item => item.kind);
  assert.deepEqual(kinds, ['ownershipOffer', 'ownershipAccept']);

  // The status view resolves the effective owner + revision for a
  // participant, and hides the assignment from non-participants.
  const status = seatAssignmentsView(read, B, { assignments: 10, seats: 10, handbacks: 10 });
  const view = status.assignments.find(row => row.assignmentId === 'asg-1');
  assert.equal(view.ownerAgentId, 'agent-b');
  assert.equal(view.ownershipRevision, 1);
  const outsider = member('agent-z', 'lead');
  const hidden = seatAssignmentsView(read, outsider, { assignments: 10, seats: 10, handbacks: 10 });
  assert.equal(hidden.assignments.find(row => row.assignmentId === 'asg-1'), undefined);
});

// ---------------------------------------------------------------------------
// Migration — v7 file upgrades additively; the first commit writes v8.
// ---------------------------------------------------------------------------

test('migration: a v7 ledger reads as v8 with empty lineage tables; first commit migrates', async t => {
  const dir = fixture(t);
  const store = createDeskStore({ stableRoot: dir });
  const A = member('agent-a', 'lead');
  const asg = assignment(A);
  const seeded = await seed(store, { memberships: [A], assignments: [asg] });
  assert.equal(seeded.ok, true, JSON.stringify(seeded));

  // Rewrite as a v7 file — no ownership tables, version literal 7.
  const path = ledgerPath(dir);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  delete file.ownershipOffers;
  delete file.ownershipAccepts;
  file.schemaVersion = 7;
  writeFileSync(path, JSON.stringify(file));

  const read = store.read(REPO_KEY);
  assert.equal(read.state, 'ok');
  assert.equal(read.persistedSchemaVersion, 7);
  assert.equal(read.ledger.schemaVersion, 8);
  assert.deepEqual(read.ledger.ownershipOffers, []);
  assert.deepEqual(read.ledger.ownershipAccepts, []);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).schemaVersion, 7,
    'a read alone never rewrites the persisted file');

  // A rejection on the migrated-in-memory ledger keeps the v7 shape.
  const rejected = await tx(store, decideDeskOwnership, 'agent-ghost', rid('offer'),
    offerCmd({ ...offerInput(), actorAgentId: 'agent-ghost' }));
  assert.equal(rejected.ok, false);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).schemaVersion, 7);

  // The first successful commit lands the version bump.
  const committed = await tx(store, decideDeskAssignment, A.agentId, rid('amend'), {
    kind: 'assignment.amend', actorAgentId: A.agentId, requestId: rid('amend'),
    assignmentId: 'asg-1', expectedBriefRevision: 0, brief: brief('first'),
    changeReason: 'initial', authorityRef: 'grant:human-1', affectedOwners: [],
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).schemaVersion, 8);
});
