// tests/plugin-desk-rollout.test.mjs — P5 rollout machinery coverage over
// the real socket (contract R1, B1-B12): allowlisted check definitions,
// the bounded repo-scoped run seam (candidate/environment pinned
// server-side, immutable run rows, capability-gap `blocked` rows, retry
// caps), the explicit rollout state machine with server-derived check and
// cohort gates, append-only rollback pins, caller-scoped status
// projection. Every call goes through handshake + tools/call like the
// scope suite. The exec/probe/environment seams are injected doubles —
// tests never spawn. Fixtures live under tmpdir().

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
import { readFileSync } from 'node:fs';
import { decideDeskCheck } from '../plugin/server/desk-check-runner.ts';
import { decideDeskRollout } from '../plugin/server/desk-rollout.ts';
import { approvedScopeRound } from '../plugin/server/desk-scope.ts';
import { sha256Hex } from '../plugin/server/config-view.ts';
import {
  DeskAssignmentResult,
  DeskCheckDeclareResult,
  DeskCheckRunResult,
  DeskRolloutDeclareResult,
  DeskRolloutTransitionResult,
  DeskSeatStatus,
} from '../plugin/shared/enforcement.ts';

// Bind the real fixture binary; startup also verifies its bytes.
const PIN = sha256Hex(readFileSync(BIN_SOURCE));
const PROVIDER = 'slp-codex-peer';
const FIXED_AT = '2026-01-02T00:00:00.000Z';
const CAPTURED_AT = '2026-01-02T00:00:01.000Z';
const CAPTURED_SNAP = 'c'.repeat(64);
const CAPTURED_HEAD = 'd'.repeat(40);
const DECL_SHA = 'e'.repeat(64);
const DEF_SHA = 'b'.repeat(64);
const ENV = { node: 'v99.0.0-test', platform: 'test-os' };

const gitRepo = t => deskGitRepo(t, 'slp-rol-repo-');

const captureOk = async ({ repository }) => ({
  status: 'ok',
  repository,
  measuredAt: CAPTURED_AT,
  snapshotSha256: CAPTURED_SNAP,
  head: CAPTURED_HEAD,
  incomplete: [],
});

/** The default exec double — `git rev-parse HEAD` answers the pinned head;
 *  anything else passes trivially. Every spawn lands in `execCalls` so a
 *  replay that re-executes is detectable. */
const execOk = execCalls => async (cmd, argv) => {
  execCalls.push([cmd, ...argv]);
  if (argv[0] === 'rev-parse') return { stdout: `${CAPTURED_HEAD}\n`, stderr: '' };
  return { stdout: 'ok\n', stderr: '' };
};

function bridgeFixture(t, over = {}) {
  return deskBridgeFixture(t, 'slp-rol-home-', PIN, {
    ...over,
    capture: over.capture ?? captureOk,
    checkProbe: over.checkProbe ?? (() => null),
    checkEnvironment: over.checkEnvironment ?? (() => ENV),
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
    id: `rol-${rpcSeq}`,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const body = JSON.parse(reply.result.content[0].text);
  return { isError: reply.result.isError === true, body };
}

const livePaseo = agent => ({ agents: { ref: () => ({ refresh: async () => ({ agent }) }) } });
const LIVE_AGENT = { provider: PROVIDER, workspaceId: 'wks-1', archivedAt: null };

/** One desk: a lead seat plus two peer seats, all bound over the socket.
 *  `over.checkExec`/`checkProbe`/`checkEnvironment` are the injected seams
 *  — no test ever spawns a real child. */
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
  const candidate = ledger.candidates.filter(c => c.assignmentId === assignmentId && c.seatAgentId === agentId).at(-1);
  assert.ok(candidate, 'the observe commit must land a candidate row');
  return candidate.snapshotSha256;
}

const ledgerOf = (f, repoKey) => {
  const read = seedStore(f).read(repoKey);
  assert.equal(read.state, 'ok');
  return read.ledger;
};

const briefBody = objective => ({
  objective,
  acceptanceCriteria: ['the declared candidate satisfies the scope outcome'],
  constraints: [],
  provisionalDesign: 'No implementation design is prescribed; select one after inspection.',
  assumptions: [], unknowns: [], requiredEvidence: [], ownedSurfaces: [], excludedSurfaces: [], dependencies: [], notifications: [],
});

async function amendBrief(ctx, expectedBriefRevision, objective) {
  return call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_amend', {
    requestId: `brief-${randomUUID()}`, assignmentId: ctx.assignmentId, expectedBriefRevision,
    brief: briefBody(objective), changeReason: `Revise operative outcome ${expectedBriefRevision + 1}.`,
    authorityRef: 'grant:brief-test', affectedOwners: ['agent-lead', 'agent-1'],
  });
}

// --- P5 wire arg builders ---------------------------------------------------

const scopeArgs = (over = {}) => ({
  requestId: `scp-${randomUUID()}`,
  assignmentId: 'ASG',
  scopeId: 'scope-1',
  label: 'p5 bounded slice',
  declarationSha256: DECL_SHA,
  refs: [],
  seatAgentId: 'agent-1',
  // Explicit compatibility opt-in for historical two-axis fixtures.
  reviewPlan: null,
  ...over,
});

const checkArgs = (over = {}) => ({
  requestId: `chk-${randomUUID()}`,
  assignmentId: 'ASG',
  scopeId: 'scope-1',
  checkId: 'check-1',
  checkClass: 'repo-git-head',
  label: 'head pin check',
  definitionSha256: DEF_SHA,
  limits: { timeoutMs: 5000, maxOutputBytes: 65536, maxRetries: 1 },
  requiredEvidence: [],
  refs: [],
  ...over,
});

const rolloutArgs = (over = {}) => ({
  requestId: `rol-${randomUUID()}`,
  assignmentId: 'ASG',
  scopeId: 'scope-1',
  rolloutId: 'rollout-1',
  label: 'p5 rollout',
  declarationSha256: DECL_SHA,
  candidateSnapshot: CAPTURED_SNAP,
  candidateHead: CAPTURED_HEAD,
  requiredChecks: [{ checkId: 'check-1', definitionDigest: DEF_SHA }],
  refs: [],
  ...over,
});

const transitionArgs = (over = {}) => ({
  requestId: `trn-${randomUUID()}`,
  assignmentId: 'ASG',
  rolloutId: 'rollout-1',
  transition: 'start-checks',
  rolloutRevision: 1,
  targetSnapshot: null,
  evidenceRefs: [],
  ...over,
});

const runArgs = (over = {}) => ({
  requestId: `run-${randomUUID()}`,
  assignmentId: 'ASG',
  rolloutId: 'rollout-1',
  checkId: 'check-1',
  definitionRevision: 1,
  evidenceRef: null,
  ...over,
});

// --- fixtures on the fixture ------------------------------------------------

/** assignment + bound scope + check definition + candidate + rollout in
 *  `declared` — the base every machine test extends. */
async function declaredRollout(t, over = {}) {
  const ctx = await boundTrio(t, over);
  const assignmentId = await registerPair(t, ctx);
  const sc = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId }));
  assert.equal(sc.body.ok, true, JSON.stringify(sc.body));
  const cd = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId }));
  assert.equal(cd.body.ok, true, JSON.stringify(cd.body));
  const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId, agentId: 'agent-1' });
  const rd = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({ assignmentId, candidateSnapshot: snapshot }));
  assert.equal(rd.body.ok, true, JSON.stringify(rd.body));
  return { ...ctx, assignmentId, snapshot };
}

/** declaredRollout + start-checks — the run window is open. */
async function checksRunning(t, over = {}) {
  const ctx = await declaredRollout(t, over);
  const st = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(st.body.ok, true, JSON.stringify(st.body));
  return ctx;
}

/** checksRunning + a passing run + checks-passed + canary-ready — ready to
 *  bind the cohort. */
async function canaryReady(t, over = {}) {
  const ctx = await checksRunning(t, over);
  const run = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(run.body.ok, true, JSON.stringify(run.body));
  assert.equal(run.body.status, 'passed');
  const cp = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'checks-passed' }));
  assert.equal(cp.body.ok, true, JSON.stringify(cp.body));
  const cr = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'canary-ready' }));
  assert.equal(cr.body.ok, true, JSON.stringify(cr.body));
  return ctx;
}

const rolloutTransitionsOf = (f, repoKey, rolloutId = 'rollout-1') =>
  ledgerOf(f, repoKey).rolloutTransitions.filter(r => r.rolloutId === rolloutId);

const stateOf = (f, repoKey, rolloutId = 'rollout-1') => {
  const tr = rolloutTransitionsOf(f, repoKey, rolloutId);
  return tr[tr.length - 1]?.to;
};

// --- P4 review dance — promote's review gate rides the scope's own
//     machine; observations come from a bound non-owner, non-bound-seat
//     seat (agent-2 on peer2Conn; scope-1 is bound to agent-1). -----------

const scopeTransArgs = (over = {}) => ({
  requestId: `stn-${randomUUID()}`,
  assignmentId: 'ASG',
  scopeId: 'scope-1',
  transition: 'claim',
  scopeRevision: 1,
  candidateSnapshot: null,
  candidateHead: null,
  ...over,
});

const scopeReviewArgs = (over = {}) => ({
  requestId: `srv-${randomUUID()}`,
  assignmentId: 'ASG',
  scopeId: 'scope-1',
  scopeRevision: 1,
  candidateSnapshot: CAPTURED_SNAP,
  axis: 'spec',
  verdict: 'approve',
  findingsRef: null,
  ...over,
});

/** claim → submit-for-review(candidate pin) → spec + standards
 *  observations → review-observed → approve. Ends with the round pin
 *  (scopeRevision, candidateSnapshot) standing approved. */
async function approveScope(ctx, { snapshot = ctx.snapshot, scopeRevision = 1 } = {}) {
  const scopeTransition = args =>
    call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', scopeTransArgs({ assignmentId: ctx.assignmentId, ...args }));
  const claim = await scopeTransition({ transition: 'claim' });
  assert.equal(claim.body.ok, true, JSON.stringify(claim.body));
  const submit = await scopeTransition({ transition: 'submit-for-review', candidateSnapshot: snapshot, candidateHead: CAPTURED_HEAD });
  assert.equal(submit.body.ok, true, JSON.stringify(submit.body));
  for (const axis of ['spec', 'standards']) {
    const observed = await call(ctx.peer2Conn.reader, ctx.peer2Conn.conn, 'slp_scope_review', scopeReviewArgs({
      assignmentId: ctx.assignmentId, axis, candidateSnapshot: snapshot, scopeRevision,
    }));
    assert.equal(observed.body.ok, true, `${axis}: ${JSON.stringify(observed.body)}`);
  }
  const gate = await scopeTransition({ transition: 'review-observed' });
  assert.equal(gate.body.ok, true, JSON.stringify(gate.body));
  const approve = await scopeTransition({ transition: 'approve' });
  assert.equal(approve.body.ok, true, JSON.stringify(approve.body));
}

// ---------------------------------------------------------------------------
// B1 — definition authority: durable, allowlisted, owner-bound, scoped.
// ---------------------------------------------------------------------------

test('B1: slp_check_declare binds (assignmentId, scopeId, ownerAgentId, revision, digest, limits) durably', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  const sc = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId }));
  assert.equal(sc.body.ok, true, JSON.stringify(sc.body));
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId }));
  assert.equal(reply.isError, false);
  const body = DeskCheckDeclareResult.parse(reply.body);
  assert.equal(body.checkId, 'check-1');
  assert.equal(body.revision, 1);

  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const row = ledger.checkDefinitions.find(d => d.assignmentId === assignmentId && d.checkId === 'check-1');
  assert.ok(row, 'the definition row is durable');
  assert.equal(row.ownerAgentId, 'agent-lead', 'owner derived from the bound membership, never the caller');
  assert.equal(row.scopeId, 'scope-1');
  assert.equal(row.checkClass, 'repo-git-head');
  assert.equal(row.definitionSha256, DEF_SHA);
  assert.equal(row.priorRevision, null);
  assert.equal(row.assignmentRevision, 3, 'the declare pins the assignment structural revision');
  assert.deepEqual(row.limits, { timeoutMs: 5000, maxOutputBytes: 65536, maxRetries: 1 });
});

test('B1: a non-allowlisted class or caller-supplied argv is a malformed command', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId }));
  const badClass = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId, checkClass: 'rm -rf /' }));
  assert.equal(badClass.body.ok, false, `the closed class enum rejects: ${JSON.stringify(badClass.body)}`);
  // Extra fields — argv, cmd, path — are never on the wire schema.
  const argv = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId, argv: ['rm', '-rf', '/'] }));
  assert.equal(argv.body.ok, false, 'strict input schema drops arbitrary fields');
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(ledger.checkDefinitions.length, 0, 'nothing committed');
});

test('B1: limits may only narrow the ceilings — maxRetries > 1 rejects at the wire schema', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId }));
  const reply = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({
    assignmentId,
    limits: { timeoutMs: 5000, maxOutputBytes: 65536, maxRetries: 2 },
  }));
  assert.equal(reply.body.ok, false, 'the one-retry ceiling is a wire cap');
});

test('B1: a peer or a foreign lead cannot declare — owner identity is server-derived', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId }));
  const peer = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_check_declare', checkArgs({ assignmentId }));
  assert.equal(peer.body.ok, false);
  assert.equal(peer.body.code, 'AUTHORITY_REQUIRED', 'a bound peer seat is not the receiving owner');
  // A foreign assignment — even to the owner — is not administered here.
  const foreign = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId: 'asg-ghost' }));
  assert.equal(foreign.body.ok, false);
  assert.equal(foreign.body.code, 'AUTHORITY_REQUIRED');
  // A real assignment owned by nobody matching the actor.
  const other = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_register', {
    requestId: `reg-${randomUUID()}`,
    authorityRef: 'grant:other',
    objective: null,
  });
  assert.equal(other.body.ok, true);
  const foreignScope = await call(ctx.peer2Conn.reader, ctx.peer2Conn.conn, 'slp_check_declare', checkArgs({ assignmentId, checkId: 'check-9' }));
  assert.equal(foreignScope.body.ok, false);
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).checkDefinitions.length, 0);
});

test('B1: a check on an undeclared scope, and redeclaration lineage', async t => {
  const ctx = await boundTrio(t);
  const assignmentId = await registerPair(t, ctx);
  const noScope = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId, scopeId: 'scope-ghost' }));
  assert.equal(noScope.body.ok, false);
  assert.equal(noScope.body.code, 'SCOPE_CONFLICT');
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId }));
  // Redeclare appends an immutable revision — never edits in place.
  const amend = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId, label: 'amended' }));
  assert.equal(amend.body.ok, true, JSON.stringify(amend.body));
  assert.equal(amend.body.revision, 2);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const rows = ledger.checkDefinitions.filter(d => d.checkId === 'check-1');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].priorRevision, 1);
  assert.equal(rows[0].label, 'head pin check', 'rev 1 is untouched');
  // A checkId may never rebind scopes.
  const cross = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId, scopeId: 'scope-2' }));
  assert.equal(cross.body.ok, false);
  assert.equal(cross.body.code, 'SCOPE_CONFLICT');
});

// ---------------------------------------------------------------------------
// B2 — candidate/environment pin; B3 — actor separation; B4 — run window +
// retry caps; B5 — immutable evidence.
// ---------------------------------------------------------------------------

test('B2: a run pins the rollout candidate + definition revision + server environment — the caller names none', async t => {
  const execCalls = [];
  const ctx = await checksRunning(t, { checkExec: execOk(execCalls) });
  const run = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(run.body.ok, true, JSON.stringify(run.body));
  const body = DeskCheckRunResult.parse(run.body);
  assert.equal(body.status, 'passed');
  assert.equal(body.attempt, 1);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const row = ledger.checkRuns.find(r => r.runId === body.runId);
  assert.ok(row, 'the run row is durable');
  assert.equal(row.candidateSnapshot, ctx.snapshot, 'candidate pin derived from the rollout, never the caller');
  assert.equal(row.candidateHead, CAPTURED_HEAD);
  assert.equal(row.definitionRevision, 1);
  assert.equal(row.definitionSha256, DEF_SHA);
  assert.deepEqual(row.environment, ENV, 'the environment fingerprint is server-measured');
  assert.equal(row.actorAgentId, 'agent-lead');
  assert.equal(row.attempt, 1);
  assert.equal(row.retryOf, null);
  assert.equal(execCalls.length, 1, 'one bounded child ran');
  assert.equal(execCalls[0][0], 'git');
  assert.deepEqual(execCalls[0].slice(1), ['rev-parse', 'HEAD'], 'fixed argv — the caller supplies nothing executable');
});

test('B3: a bound seat or a foreign actor cannot run checks — the rollout owner only', async t => {
  const ctx = await checksRunning(t, { checkExec: execOk([]) });
  const peer = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(peer.body.ok, false);
  assert.equal(peer.body.code, 'AUTHORITY_REQUIRED');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).checkRuns.length, 0, 'no row committed');
});

test('B4: runs only commit in checks-running; a passed stream never re-runs; retries cap at the definition bound', async t => {
  const execCalls = [];
  const ctx = await declaredRollout(t, { checkExec: execOk(execCalls) });
  // Not in checks-running — the window is closed.
  const early = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(early.body.ok, false);
  assert.equal(early.body.code, 'ROLLOUT_CONFLICT');
  assert.equal(execCalls.length, 0, 'a rejected run never spawns');
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId }));
  const run = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(run.body.status, 'passed');
  // A second run on a passed stream is not a retry — it is a conflict.
  const again = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(again.body.ok, false);
  assert.equal(again.body.code, 'ROLLOUT_CONFLICT');
  // Superseded definition pins reject REVISION_CONFLICT.
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId: ctx.assignmentId, label: 'amended' }));
  const stale = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId, checkId: 'check-1' }));
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
});

test('B4: amending a definition mid-stream never reopens it — the stream pins its first revision', async t => {
  const execFail = async () => {
    const err = new Error('exit 1');
    err.code = 1;
    err.stdout = '';
    err.stderr = '';
    throw err;
  };
  const ctx = await checksRunning(t, { checkExec: execFail });
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(first.body.status, 'failed');
  // Amend to revision 2 — the stream still pins revision 1, and the
  // amendment must not silently widen the retry budget or retarget runs.
  const amend = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId: ctx.assignmentId, label: 'amended' }));
  assert.equal(amend.body.ok, true);
  const drifted = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId, definitionRevision: 2 }));
  assert.equal(drifted.body.ok, false);
  assert.equal(drifted.body.code, 'REVISION_CONFLICT', 'a mid-stream revision bump is typed, never a commit corruption');
});

test('B4: a failed attempt retries once under the definition cap, then RETRY_EXHAUSTED', async t => {
  let calls = 0;
  const execFlaky = async () => {
    calls += 1;
    const err = new Error('exit 1');
    err.code = 1;
    err.stdout = 'nope\n';
    err.stderr = '';
    throw err;
  };
  const ctx = await checksRunning(t, { checkExec: execFlaky });
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.status, 'failed');
  assert.equal(first.body.attempt, 1);
  const second = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(second.body.status, 'failed');
  assert.equal(second.body.attempt, 2);
  const third = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(third.body.ok, false);
  assert.equal(third.body.code, 'RETRY_EXHAUSTED');
  assert.equal(calls, 2, 'the exhausted call never spawned');
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const runs = ledger.checkRuns.filter(r => r.checkId === 'check-1');
  assert.equal(runs.length, 2);
  assert.equal(runs[1].retryOf, runs[0].runId, 'attempt 2 chains its predecessor');
});

test('B4: maxRetries 0 leaves no retry room at all', async t => {
  const execFail = async () => {
    const err = new Error('exit 1');
    err.code = 1;
    err.stdout = '';
    err.stderr = '';
    throw err;
  };
  const ctx = await checksRunning(t, { checkExec: execFail });
  // Amend the definition to forbid retries (revision 2, maxRetries 0).
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({
    assignmentId: ctx.assignmentId,
    limits: { timeoutMs: 5000, maxOutputBytes: 65536, maxRetries: 0 },
  }));
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId, definitionRevision: 2 }));
  assert.equal(first.body.status, 'failed');
  const retry = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId, definitionRevision: 2 }));
  assert.equal(retry.body.ok, false);
  assert.equal(retry.body.code, 'RETRY_EXHAUSTED');
});

test('B2/B5: a capability gap commits a durable blocked row — the class never executes', async t => {
  const execCalls = [];
  const gap = { capability: 'repo-checkout', detail: 'candidate repository is not readable on this host' };
  const ctx = await checksRunning(t, {
    checkExec: execOk(execCalls),
    checkProbe: () => gap,
  });
  const run = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(run.body.ok, true, JSON.stringify(run.body));
  assert.equal(run.body.status, 'blocked');
  assert.equal(execCalls.length, 0, 'a gap never executes the class');
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const row = ledger.checkRuns.find(r => r.checkId === 'check-1');
  assert.ok(row);
  assert.equal(row.status, 'blocked');
  assert.deepEqual(row.gap, gap, 'the durable gap record lands verbatim');
  assert.equal(row.outputTail, null);
  assert.equal(row.exitCode, null);
});

test('B5: a run row is immutable — idempotent replay returns the same row and never re-executes', async t => {
  const execCalls = [];
  const ctx = await checksRunning(t, { checkExec: execOk(execCalls) });
  const requestId = `run-${randomUUID()}`;
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId, requestId }));
  assert.equal(first.body.ok, true);
  const second = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId, requestId }));
  assert.equal(second.body.ok, true);
  assert.equal(second.body.runId, first.body.runId, 'replay resolves the same durable row');
  assert.equal(execCalls.length, 1, 'the replay never re-executes the class');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).checkRuns.length, 1);
});

test('B3/B6: a run replay is actor- and body-bound — foreign actors and altered bodies conflict', async t => {
  const execCalls = [];
  const ctx = await checksRunning(t, { checkExec: execOk(execCalls) });
  const requestId = `run-${randomUUID()}`;
  const first = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId, requestId }));
  assert.equal(first.body.ok, true);
  assert.equal(execCalls.length, 1);
  // A bound peer reusing the requestId hits the authority gate before the
  // replay lookup — the committed row never leaks to another actor.
  const peer = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId, requestId }));
  assert.equal(peer.body.ok, false);
  assert.equal(peer.body.code, 'AUTHORITY_REQUIRED');
  // Same actor, same requestId, different body — a typed conflict, not a
  // replay of the committed row.
  for (const over of [{ checkId: 'check-2' }, { evidenceRef: 'ev-x' }, { rolloutId: 'rollout-9' }]) {
    const altered = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId, requestId, ...over }));
    assert.equal(altered.body.ok, false, `altered body must conflict: ${JSON.stringify(over)}`);
    assert.equal(altered.body.code, 'IDEMPOTENCY_CONFLICT');
  }
  // The verbatim body still replays the durable row — no re-execution.
  const replay = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId, requestId }));
  assert.equal(replay.body.ok, true);
  assert.equal(replay.body.runId, first.body.runId);
  assert.equal(execCalls.length, 1, 'no altered-body or replay call spawned');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).checkRuns.length, 1);
});

test('B6: retry streams bind the assignment — same rolloutId/checkId/candidate under two assignments stay independent', async t => {
  const results = ['fail', 'pass', 'pass'];
  const execCalls = [];
  const execQueue = async (cmd, argv) => {
    execCalls.push([cmd, ...argv]);
    if (results.shift() === 'fail') {
      const err = new Error('exit 1');
      err.code = 1;
      err.stdout = 'nope\n';
      err.stderr = '';
      throw err;
    }
    return { stdout: `${CAPTURED_HEAD}\n`, stderr: '' };
  };
  const ctx = await boundTrio(t, { checkExec: execQueue });
  const assignmentA = await registerPair(t, ctx);
  const assignmentB = await registerPair(t, ctx);
  for (const assignmentId of [assignmentA, assignmentB]) {
    assert.equal((await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId }))).body.ok, true);
    assert.equal((await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId }))).body.ok, true);
    const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId, agentId: 'agent-1' });
    assert.equal(snapshot, CAPTURED_SNAP, 'both assignments pin the same snapshot hash');
    assert.equal((await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({ assignmentId, candidateSnapshot: snapshot }))).body.ok, true);
    assert.equal((await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId }))).body.ok, true);
  }
  // A's first attempt fails — one element of ITS stream.
  const a1 = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: assignmentA }));
  assert.equal(a1.body.status, 'failed');
  assert.equal(a1.body.attempt, 1);
  // B's first run must open at attempt 1 — without the assignment key the
  // streams collide: B would land at attempt 2, and its pass would close
  // A's stream.
  const b1 = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: assignmentB }));
  assert.equal(b1.body.ok, true, JSON.stringify(b1.body));
  assert.equal(b1.body.status, 'passed');
  assert.equal(b1.body.attempt, 1, 'B opens its own stream under the same rollout/check/candidate ids');
  const a2 = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: assignmentA }));
  assert.equal(a2.body.status, 'passed');
  assert.equal(a2.body.attempt, 2, "A's retry chains its own stream — B's pass never counted");
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const runsA = ledger.checkRuns.filter(r => r.assignmentId === assignmentA);
  const runsB = ledger.checkRuns.filter(r => r.assignmentId === assignmentB);
  assert.equal(runsA.length, 2);
  assert.equal(runsA[1].retryOf, runsA[0].runId);
  assert.equal(runsB.length, 1);
  // Each rollout discharges only its own stream's evidence.
  const cpB = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: assignmentB, transition: 'checks-passed' }));
  assert.equal(cpB.body.ok, true, JSON.stringify(cpB.body));
});

// ---------------------------------------------------------------------------
// B8/B9 — the explicit machine: check gate, cohort gate, hold/rollback.
// ---------------------------------------------------------------------------

test('B4/B8: rollout transitions walk the shared edges only — early promote/close reject typed', async t => {
  const ctx = await declaredRollout(t, { checkExec: execOk([]) });
  const promote = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'promote' }));
  assert.equal(promote.body.ok, false);
  assert.equal(promote.body.code, 'ROLLOUT_CONFLICT');
  const close = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'close' }));
  assert.equal(close.body.ok, false);
  assert.equal(close.body.code, 'ROLLOUT_CONFLICT');
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'declared', 'nothing moved');
  assert.equal(rolloutTransitionsOf(ctx.f, ctx.repoKey).length, 1, 'rejections commit no transition rows');
  // Stale revision pin.
  const stale = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, rolloutRevision: 9 }));
  assert.equal(stale.body.ok, false);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
  // A peer may not move the machine.
  const peer = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(peer.body.ok, false);
  assert.equal(peer.body.code, 'AUTHORITY_REQUIRED');
});

test('B8: checks-passed requires passed runs for every required check — pass never auto-promotes', async t => {
  const ctx = await checksRunning(t, { checkExec: execOk([]) });
  const premature = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'checks-passed' }));
  assert.equal(premature.body.ok, false);
  assert.equal(premature.body.code, 'CHECK_INCOMPLETE');
  assert.match(premature.body.message, /check-1/);
  const run = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(run.body.status, 'passed');
  // B12 — the machine did not move on its own.
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'checks-running', 'a passing run never transitions the rollout');
  const passed = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'checks-passed' }));
  assert.equal(passed.body.ok, true, JSON.stringify(passed.body));
  const body = DeskRolloutTransitionResult.parse(passed.body);
  assert.equal(body.state, 'checks-passed');
  assert.equal(body.dischargedChecks.length, 1);
  assert.equal(body.dischargedChecks[0].checkId, 'check-1');
  assert.equal(body.dischargedChecks[0].runId, run.body.runId, 'the discharge names the committed run');
});

test('B7: start-canary pins a bounded membership snapshot; drift typed-rejects and never expands', async t => {
  const ctx = await canaryReady(t, { checkExec: execOk([]) });
  const start = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'start-canary' }));
  assert.equal(start.body.ok, true, JSON.stringify(start.body));
  const row = rolloutTransitionsOf(ctx.f, ctx.repoKey).find(r => r.command === 'start-canary');
  assert.ok(row.cohort, 'the cohort pin lands on the transition row');
  assert.deepEqual(row.cohort.members, ['agent-1', 'agent-2', 'agent-lead'], 'sorted roster: owner + seats');
  // Drift: attach a third seat — the roster no longer digests identically.
  const peer3 = memberRow('peer3-handle', { role: 'peer', agentId: 'agent-3' });
  const reseed = await seedStore(ctx.f).transact(
    ctx.repoKey,
    { repo: ctx.repo, actorKey: 'desk:hook', assignmentId: 'unassigned', requestId: randomUUID(), command: { kind: 'seed' } },
    ledger => ({ ok: true, events: [], memberships: [...ledger.memberships, peer3] }),
  );
  assert.equal(reseed.ok, true);
  const attach = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_assignment_attach', {
    requestId: `att-${randomUUID()}`,
    assignmentId: ctx.assignmentId,
    agentId: 'agent-3',
  });
  assert.equal(attach.body.ok, true);
  const drifted = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'canary-passed' }));
  assert.equal(drifted.body.ok, false);
  assert.equal(drifted.body.code, 'COHORT_DRIFT');
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'canary-running', 'drift holds the rollout — the cohort never expanded');
  // The pinned cohort stays byte-identical on the ledger.
  const after = rolloutTransitionsOf(ctx.f, ctx.repoKey).find(r => r.command === 'start-canary');
  assert.deepEqual(after.cohort, row.cohort);
});

test('B9: rollback is explicit, append-only and pins a known-good observed candidate', async t => {
  const ctx = await canaryReady(t, { checkExec: execOk([]) });
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'start-canary' }));
  const failed = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'canary-failed' }));
  assert.equal(failed.body.ok, true, JSON.stringify(failed.body));
  // Rollback without a target pin is malformed; a phantom target drifts.
  const bare = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'rollback' }));
  assert.equal(bare.body.ok, false);
  assert.equal(bare.body.code, 'INVALID_RECORD');
  const ghost = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'rollback', targetSnapshot: '9'.repeat(64) }));
  assert.equal(ghost.body.ok, false);
  assert.equal(ghost.body.code, 'CANDIDATE_DRIFT');
  const rollback = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({
    assignmentId: ctx.assignmentId,
    transition: 'rollback',
    targetSnapshot: ctx.snapshot,
  }));
  assert.equal(rollback.body.ok, true, JSON.stringify(rollback.body));
  const body = DeskRolloutTransitionResult.parse(rollback.body);
  assert.equal(body.state, 'rolled-back');
  const row = rolloutTransitionsOf(ctx.f, ctx.repoKey).find(r => r.command === 'rollback');
  assert.equal(row.targetSnapshot, ctx.snapshot);
  assert.equal(row.targetHead, CAPTURED_HEAD, 'the target head is server-derived from the durable candidate');
  // rolled-back is terminal save close; there is no edge back to running.
  const back = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'start-checks' }));
  assert.equal(back.body.ok, false);
  assert.equal(back.body.code, 'ROLLOUT_CONFLICT');
  const close = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'close' }));
  assert.equal(close.body.ok, true);
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'closed');
});

test('B8/B9: the full happy path — promote discharges checks AND reviews AND the cohort, then close', async t => {
  const ctx = await canaryReady(t, { checkExec: execOk([]) });
  // The review gate is durable, not assumed: the scope's round must stand
  // approved on the rollout's exact candidate before promote commits.
  await approveScope(ctx);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'start-canary' }));
  const canary = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'canary-passed' }));
  assert.equal(canary.body.ok, true, JSON.stringify(canary.body));
  const canaryRow = rolloutTransitionsOf(ctx.f, ctx.repoKey).find(r => r.command === 'canary-passed');
  assert.ok(canaryRow.cohortDigestAtGate, 'the gate records the digest it observed');
  const promote = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'promote' }));
  assert.equal(promote.body.ok, true, JSON.stringify(promote.body));
  const body = DeskRolloutTransitionResult.parse(promote.body);
  assert.equal(body.state, 'promoted');
  assert.equal(body.dischargedChecks.length, 1, 'promote re-discharges the required checks');
  assert.equal(body.dischargedReviews.length, 2, 'promote re-discharges both required review axes');
  assert.deepEqual(body.dischargedReviews.map(d => d.axis).sort(), ['spec', 'standards']);
  const promoteRow = rolloutTransitionsOf(ctx.f, ctx.repoKey).find(r => r.command === 'promote');
  assert.ok(promoteRow.cohortDigestAtGate, 'promote is cohort-gated too');
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  assert.ok(
    promoteRow.dischargedReviews.every(d => ledger.scopeReviews.some(r => r.reviewId === d.reviewId)),
    'every discharged reviewId resolves to a durable observation',
  );
  const close = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'close' }));
  assert.equal(close.body.ok, true);
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'closed');
  // The stream is append-only: every accepted row is still there.
  const stream = rolloutTransitionsOf(ctx.f, ctx.repoKey);
  assert.deepEqual(
    stream.map(r => r.command),
    ['declare', 'start-checks', 'checks-passed', 'canary-ready', 'start-canary', 'canary-passed', 'promote', 'close'],
  );
});

test('B9: hold is an explicit escape — a held rollout only resolves via rollback or close', async t => {
  const ctx = await checksRunning(t, { checkExec: execOk([]) });
  const hold = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'hold' }));
  assert.equal(hold.body.ok, true, JSON.stringify(hold.body));
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'held');
  // No forward motion from held.
  for (const cmd of ['checks-passed', 'canary-ready', 'start-canary', 'promote']) {
    const attempt = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: cmd }));
    assert.equal(attempt.body.ok, false, `${cmd} must reject from held`);
    assert.equal(attempt.body.code, 'ROLLOUT_CONFLICT');
  }
  const close = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'close' }));
  assert.equal(close.body.ok, true);
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'closed');
});

test('B2: a rollout redeclared during the awaited execution typed-rejects — the stale outcome never binds the moved pin', async t => {
  const SNAP_B = '8'.repeat(64);
  let capturedSnap = CAPTURED_SNAP;
  const captureMutable = async ({ repository }) => ({
    status: 'ok', repository, measuredAt: CAPTURED_AT, snapshotSha256: capturedSnap, head: CAPTURED_HEAD, incomplete: [],
  });
  const drift = { redeclare: null };
  let armed = true;
  const execDrift = async () => {
    if (!armed) return { stdout: `${CAPTURED_HEAD}\n`, stderr: '' };
    armed = false;
    // A concurrent owner declaration lands while the check executes:
    // revision 2 re-pins the rollout onto candidate B. The commit that
    // follows this await must typed-reject — outcome(A) is not evidence(B).
    const store = seedStore(ctx.f);
    const requestId = `rol-drift-${randomUUID()}`;
    drift.redeclare = await store.transact(ctx.repoKey, {
      repo: ctx.repo,
      actorKey: 'agent:agent-lead',
      assignmentId: ctx.assignmentId,
      requestId,
      command: {
        kind: 'rollout.declare', requestId, actorAgentId: 'agent-lead',
        assignmentId: ctx.assignmentId, scopeId: 'scope-1', rolloutId: 'rollout-1',
        label: 're-pinned mid-run', declarationSha256: DECL_SHA,
        candidateSnapshot: SNAP_B, candidateHead: CAPTURED_HEAD,
        requiredChecks: [{ checkId: 'check-1', definitionDigest: DEF_SHA }],
        refs: [],
      },
    }, decideDeskRollout);
    return { stdout: `${CAPTURED_HEAD}\n`, stderr: '' };
  };
  const ctx = await boundTrio(t, { capture: captureMutable, checkExec: execDrift });
  const assignmentId = await registerPair(t, ctx);
  ctx.assignmentId = assignmentId;
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId }));
  const snapA = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId, agentId: 'agent-1' });
  capturedSnap = SNAP_B;
  const snapB = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId, agentId: 'agent-1' });
  // Keep checkout A through this execution: only the durable declaration
  // changes mid-flight, so the store's revision guard remains the subject.
  capturedSnap = CAPTURED_SNAP;
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({ assignmentId, candidateSnapshot: snapA }));
  const started = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId }));
  assert.equal(started.body.ok, true);
  const run = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId }));
  assert.equal(run.body.ok, false, `the executed-under-A commit rejects after the redeclare: run=${JSON.stringify(run.body)} redeclare=${JSON.stringify(drift.redeclare)}`);
  assert.equal(run.body.code, 'REVISION_CONFLICT');
  assert.equal(drift.redeclare?.ok, true, `the mid-flight redeclare itself committed: ${JSON.stringify(drift.redeclare)}`);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(ledger.checkRuns.length, 0, 'nothing committed — no pass lands on candidate B');
  assert.equal(ledger.rollouts.at(-1).revision, 2);
  assert.equal(ledger.rollouts.at(-1).candidateSnapshot, SNAP_B);
  // The stale outcome cannot discharge the new candidate pin.
  const gate = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId, transition: 'checks-passed', rolloutRevision: 2 }));
  assert.equal(gate.body.code, 'CHECK_INCOMPLETE', 'no passed run is bound to candidate B');
  // A fresh run re-executes under revision 2's pin and discharges it.
  capturedSnap = SNAP_B;
  const rerun = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId, requestId: `run-${randomUUID()}` }));
  assert.equal(rerun.body.ok, true, JSON.stringify(rerun.body));
  assert.equal(rerun.body.status, 'passed');
  const row = ledgerOf(ctx.f, ctx.repoKey).checkRuns[0];
  assert.equal(row.rolloutRevision, 2);
  assert.equal(row.candidateSnapshot, snapB);
  const gate2 = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId, transition: 'checks-passed', rolloutRevision: 2 }));
  assert.equal(gate2.body.ok, true, JSON.stringify(gate2.body));
});

test('B2: a forged commit carrying another pin\'s outcome rejects — a run never binds what it did not measure', async t => {
  const ctx = await checksRunning(t, { checkExec: execOk([]) });
  const store = seedStore(ctx.f);
  const commit = over => store.transact(ctx.repoKey, {
    repo: ctx.repo,
    actorKey: 'agent:agent-lead',
    assignmentId: ctx.assignmentId,
    requestId: `forge-${randomUUID()}`,
    command: {
      kind: 'check.run.commit', requestId: `forge-${randomUUID()}`, actorAgentId: 'agent-lead',
      assignmentId: ctx.assignmentId, rolloutId: 'rollout-1', checkId: 'check-1',
      definitionRevision: 1, evidenceRef: null,
      rolloutRevision: 1, candidateSnapshot: ctx.snapshot, candidateHead: CAPTURED_HEAD,
      environment: { node: 'v99.0.0-test', platform: 'test-os' },
      outcome: { status: 'passed', exitCode: 0, timedOut: false, durationMs: 1, outputSha256: 'f'.repeat(64), outputTail: 'x', outputTruncated: false, outputPointer: null, gap: null },
      ...over,
    },
  }, decideDeskCheck);
  // Revision pins but the candidate was measured elsewhere — CANDIDATE_DRIFT.
  const foreign = await commit({ candidateSnapshot: '9'.repeat(64) });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 'CANDIDATE_DRIFT');
  // A stale revision pin — the declaration has since moved — REVISION_CONFLICT.
  const stale = await commit({ rolloutRevision: 7 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'REVISION_CONFLICT');
  assert.equal(ledgerOf(ctx.f, ctx.repoKey).checkRuns.length, 0, 'no forged outcome lands');
});

test('B8: promote is review-gated — missing or in-flight evidence rejects; the standing approved round discharges', async t => {
  const ctx = await canaryReady(t, { checkExec: execOk([]) });
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'start-canary' }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'canary-passed' }));
  // No review round exists at all — check evidence alone cannot promote.
  const missing = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'promote' }));
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.code, 'REVIEW_INCOMPLETE');
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'canary-passed', 'a rejected promote commits nothing');
  // A round pinned to the right candidate but observed on one axis only —
  // the scope machine never reaches review-observed, so promote still has
  // no standing approval.
  const scopeTransition = args =>
    call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', scopeTransArgs({ assignmentId: ctx.assignmentId, ...args }));
  await scopeTransition({ transition: 'claim' });
  await scopeTransition({ transition: 'submit-for-review', candidateSnapshot: ctx.snapshot, candidateHead: CAPTURED_HEAD });
  const spec = await call(ctx.peer2Conn.reader, ctx.peer2Conn.conn, 'slp_scope_review', scopeReviewArgs({ assignmentId: ctx.assignmentId, axis: 'spec' }));
  assert.equal(spec.body.ok, true, JSON.stringify(spec.body));
  const inflight = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'promote' }));
  assert.equal(inflight.body.code, 'REVIEW_INCOMPLETE', 'one axis observed, gate never walked — not a discharge');
  // Complete the round and promote discharges both axes.
  const standards = await call(ctx.peer2Conn.reader, ctx.peer2Conn.conn, 'slp_scope_review', scopeReviewArgs({ assignmentId: ctx.assignmentId, axis: 'standards' }));
  assert.equal(standards.body.ok, true, JSON.stringify(standards.body));
  await scopeTransition({ transition: 'review-observed' });
  await scopeTransition({ transition: 'approve' });
  const promote = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'promote' }));
  assert.equal(promote.body.ok, true, JSON.stringify(promote.body));
  const body = DeskRolloutTransitionResult.parse(promote.body);
  assert.equal(body.dischargedReviews.length, 2);
});

test('B8: a review round approved on a different candidate never discharges promote', async t => {
  const SNAP_B = '8'.repeat(64);
  let capturedSnap = CAPTURED_SNAP;
  const captureMutable = async ({ repository }) => ({
    status: 'ok', repository, measuredAt: CAPTURED_AT, snapshotSha256: capturedSnap, head: CAPTURED_HEAD, incomplete: [],
  });
  const ctx = await boundTrio(t, { capture: captureMutable, checkExec: execOk([]) });
  const assignmentId = await registerPair(t, ctx);
  ctx.assignmentId = assignmentId;
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId }));
  const snapA = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId, agentId: 'agent-1' });
  capturedSnap = SNAP_B;
  const snapB = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId, agentId: 'agent-1' });
  assert.equal(snapB, SNAP_B);
  // The rollout pins candidate B; the scope's review approves candidate A.
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({ assignmentId, candidateSnapshot: snapB }));
  await approveScope(ctx, { snapshot: snapA });
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId }));
  const run = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId }));
  assert.equal(run.body.ok, true, JSON.stringify(run.body));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId, transition: 'checks-passed' }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId, transition: 'canary-ready' }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId, transition: 'start-canary' }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId, transition: 'canary-passed' }));
  const promote = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId, transition: 'promote' }));
  assert.equal(promote.body.ok, false);
  assert.equal(promote.body.code, 'REVIEW_INCOMPLETE', 'the approved round pins candidate A — the rollout pins B');
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'canary-passed');
});

test('B8: a scope amendment supersedes the approved round — promote rejects until the new revision is re-reviewed', async t => {
  const ctx = await canaryReady(t, { checkExec: execOk([]) });
  await approveScope(ctx);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'start-canary' }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'canary-passed' }));
  // The owner amends the scope — revision 2 supersedes the approved rev1 pin.
  const amend = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId: ctx.assignmentId, requestId: `scp-${randomUUID()}`, label: 'amended' }));
  assert.equal(amend.body.ok, true, JSON.stringify(amend.body));
  const promote = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'promote' }));
  assert.equal(promote.body.ok, false);
  assert.equal(promote.body.code, 'REVIEW_INCOMPLETE', 'the approved round is bound to scope revision 1');
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'canary-passed');
});

test('v7: an operative brief amendment invalidates the standing review and blocks rollout promotion', async t => {
  const ctx = await canaryReady(t, { checkExec: execOk([]) });
  await approveScope(ctx);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'start-canary' }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'canary-passed' }));
  const before = ledgerOf(ctx.f, ctx.repoKey);
  const scopeHistory = before.scopeTransitions.filter(row => row.scopeId === 'scope-1');
  assert.ok(approvedScopeRound(scopeHistory, { briefRevision: 0, scopeRevision: 1, mandateSha256: null }));
  assert.equal((await amendBrief(ctx, 0, 'A materially revised operative outcome.')).body.ok, true);
  const after = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(after.briefRevisions.at(-1).revision, 1);
  assert.ok(approvedScopeRound(after.scopeTransitions.filter(row => row.scopeId === 'scope-1')),
    'the old approval remains recorded at its original event time');
  assert.equal(approvedScopeRound(after.scopeTransitions.filter(row => row.scopeId === 'scope-1'), {
    briefRevision: 1, scopeRevision: 1, mandateSha256: null,
  }), null, 'the freshness projection excludes the old brief pin');
  const rejected = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'promote',
  }));
  assert.equal(rejected.body.ok, false);
  assert.equal(rejected.body.code, 'REVIEW_INCOMPLETE', JSON.stringify(rejected.body));
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'canary-passed', 'stale promotion commits no rollout transition');
});

test('v7: a completed promotion remains historically valid when a later brief revision makes its approval stale', async t => {
  const ctx = await canaryReady(t, { checkExec: execOk([]) });
  await approveScope(ctx);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'start-canary' }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({ assignmentId: ctx.assignmentId, transition: 'canary-passed' }));
  const promoted = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({
    assignmentId: ctx.assignmentId, transition: 'promote',
  }));
  assert.equal(promoted.body.ok, true, JSON.stringify(promoted.body));
  assert.equal((await amendBrief(ctx, 0, 'The next work item changes the operative outcome.')).body.ok, true);
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(ledger.rolloutTransitions.filter(row => row.command === 'promote').length, 1);
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'promoted');
  assert.equal(approvedScopeRound(ledger.scopeTransitions.filter(row => row.scopeId === 'scope-1'), {
    briefRevision: 1, scopeRevision: 1, mandateSha256: null,
  }), null, 'later freshness does not rewrite the earlier approval event');
});

test('v7: an explicit exemption approves and promotes an empty discharge with event-time history intact', async t => {
  const ctx = await boundTrio(t, { checkExec: execOk([]) });
  ctx.assignmentId = await registerPair(t, ctx);
  const exemption = {
    kind: 'exempt', authorityRef: 'grant:future-workspace', ruleRef: 'rule:docs-only',
    reason: 'The authority-backed rule exempts this bounded documentation scope.',
    lenses: [], exemptionClass: 'docs-only',
  };
  const scope = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({
    assignmentId: ctx.assignmentId, seatAgentId: null, reviewPlan: exemption,
  }));
  assert.equal(scope.body.ok, true, JSON.stringify(scope.body));
  const check = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(check.body.ok, true, JSON.stringify(check.body));
  ctx.snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId: ctx.assignmentId, agentId: 'agent-1' });
  const rollout = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({
    assignmentId: ctx.assignmentId, candidateSnapshot: ctx.snapshot,
  }));
  assert.equal(rollout.body.ok, true, JSON.stringify(rollout.body));

  const rolloutTransition = over => call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({
    assignmentId: ctx.assignmentId, ...over,
  }));
  assert.equal((await rolloutTransition({})).body.ok, true);
  const run = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(run.body.ok, true, JSON.stringify(run.body));
  assert.equal((await rolloutTransition({ transition: 'checks-passed' })).body.ok, true);
  assert.equal((await rolloutTransition({ transition: 'canary-ready' })).body.ok, true);
  assert.equal((await rolloutTransition({ transition: 'start-canary' })).body.ok, true);
  assert.equal((await rolloutTransition({ transition: 'canary-passed' })).body.ok, true);

  const scopeTransition = over => call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', scopeTransArgs({
    assignmentId: ctx.assignmentId, ...over,
  }));
  assert.equal((await scopeTransition({ transition: 'claim' })).body.ok, true);
  assert.equal((await scopeTransition({
    transition: 'submit-for-review', candidateSnapshot: ctx.snapshot, candidateHead: CAPTURED_HEAD,
  })).body.ok, true);
  const observed = await scopeTransition({ transition: 'review-observed' });
  assert.equal(observed.body.ok, true, JSON.stringify(observed.body));
  assert.deepEqual(observed.body.discharged, [], 'only the explicit stored exemption has an empty required set');
  const approval = await scopeTransition({ transition: 'approve' });
  assert.equal(approval.body.ok, true, JSON.stringify(approval.body));
  assert.deepEqual(approval.body.discharged, []);
  const approved = ledgerOf(ctx.f, ctx.repoKey);
  const scopeHistory = approved.scopeTransitions.filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1').sort((a, b) => a.revision - b.revision);
  assert.deepEqual(approvedScopeRound(scopeHistory)?.discharged, []);

  const promoted = await rolloutTransition({ transition: 'promote' });
  assert.equal(promoted.body.ok, true, JSON.stringify(promoted.body));
  assert.deepEqual(promoted.body.dischargedReviews, []);
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'promoted');

  assert.equal((await amendBrief(ctx, 0, 'The next authorized work item has a different brief.')).body.ok, true);
  const revisedScope = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({
    assignmentId: ctx.assignmentId, seatAgentId: null, reviewPlan: exemption, expectedBriefRevision: 1,
    requestId: `scp-${randomUUID()}`,
  }));
  assert.equal(revisedScope.body.revision, 2);
  const historical = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(historical.rolloutTransitions.filter(row => row.assignmentId === ctx.assignmentId && row.command === 'promote').length, 1,
    'the committed promotion remains valid at its event-time brief/scope pins');
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'promoted');
});

test('selection: no-review approves and promotes empty evidence while historical pins survive later amendments', async t => {
  const ctx = await boundTrio(t, { checkExec: execOk([]) });
  ctx.assignmentId = await registerPair(t, ctx);
  const exemption = {
    kind: 'not-required', authorityRef: 'grant:future-workspace', ruleRef: 'rule:docs-only',
    reason: 'No material independent question remains for this bounded scope.',
    lenses: [], exemptionClass: null,
  };
  const scope = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({
    assignmentId: ctx.assignmentId, seatAgentId: null, reviewPlan: exemption,
  }));
  assert.equal(scope.body.ok, true, JSON.stringify(scope.body));
  const check = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(check.body.ok, true, JSON.stringify(check.body));
  ctx.snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId: ctx.assignmentId, agentId: 'agent-1' });
  const rollout = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({
    assignmentId: ctx.assignmentId, candidateSnapshot: ctx.snapshot,
  }));
  assert.equal(rollout.body.ok, true, JSON.stringify(rollout.body));

  const rolloutTransition = over => call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_transition', transitionArgs({
    assignmentId: ctx.assignmentId, ...over,
  }));
  assert.equal((await rolloutTransition({})).body.ok, true);
  const run = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_run', runArgs({ assignmentId: ctx.assignmentId }));
  assert.equal(run.body.ok, true, JSON.stringify(run.body));
  assert.equal((await rolloutTransition({ transition: 'checks-passed' })).body.ok, true);
  assert.equal((await rolloutTransition({ transition: 'canary-ready' })).body.ok, true);
  assert.equal((await rolloutTransition({ transition: 'start-canary' })).body.ok, true);
  assert.equal((await rolloutTransition({ transition: 'canary-passed' })).body.ok, true);

  const scopeTransition = over => call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_transition', scopeTransArgs({
    assignmentId: ctx.assignmentId, ...over,
  }));
  assert.equal((await scopeTransition({ transition: 'claim' })).body.ok, true);
  assert.equal((await scopeTransition({
    transition: 'submit-for-review', candidateSnapshot: ctx.snapshot, candidateHead: CAPTURED_HEAD,
  })).body.ok, true);
  const observed = await scopeTransition({ transition: 'review-observed' });
  assert.equal(observed.body.ok, true, JSON.stringify(observed.body));
  assert.deepEqual(observed.body.discharged, [], 'the selected no-review decision resolves an empty observation set');
  const approval = await scopeTransition({ transition: 'approve' });
  assert.equal(approval.body.ok, true, JSON.stringify(approval.body));
  assert.deepEqual(approval.body.discharged, []);
  const approved = ledgerOf(ctx.f, ctx.repoKey);
  const scopeHistory = approved.scopeTransitions.filter(row => row.assignmentId === ctx.assignmentId && row.scopeId === 'scope-1').sort((a, b) => a.revision - b.revision);
  assert.deepEqual(approvedScopeRound(scopeHistory)?.discharged, []);

  for (const changedPlan of [
    { ...exemption, reason: 'A revised selection requires a fresh candidate round.' },
    { kind: 'required', authorityRef: 'grant:selection', ruleRef: 'rule:identity',
      reason: 'An independent identity judgment is now required.', exemptionClass: null,
      lenses: [{ id: 'identity', name: 'Identity', authorityRef: 'grant:selection', ruleRef: 'rule:identity' }] },
  ]) {
    const stale = structuredClone(approved);
    stale.scopes[0].reviewPlan = changedPlan;
    const decision = decideDeskRollout(stale, { kind: 'rollout.transition', actorAgentId: 'agent-lead',
      ...transitionArgs({ assignmentId: ctx.assignmentId, transition: 'promote' }),
    });
    assert.equal(decision.code, 'REVIEW_INCOMPLETE', 'an empty historic discharge cannot survive a changed mandate');
  }

  const promoted = await rolloutTransition({ transition: 'promote' });
  assert.equal(promoted.body.ok, true, JSON.stringify(promoted.body));
  assert.deepEqual(promoted.body.dischargedReviews, []);
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'promoted');

  assert.equal((await amendBrief(ctx, 0, 'The next authorized work item has a different brief.')).body.ok, true);
  const revisedScope = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({
    assignmentId: ctx.assignmentId, seatAgentId: null, reviewPlan: exemption, expectedBriefRevision: 1,
    requestId: `scp-${randomUUID()}`,
  }));
  assert.equal(revisedScope.body.revision, 2);
  const historical = ledgerOf(ctx.f, ctx.repoKey);
  assert.equal(historical.rolloutTransitions.filter(row => row.assignmentId === ctx.assignmentId && row.command === 'promote').length, 1,
    'the committed promotion remains valid at its event-time brief/scope pins');
  assert.equal(stateOf(ctx.f, ctx.repoKey), 'promoted');
});

// ---------------------------------------------------------------------------
// B10 — status projection: caller-scoped, bounded, provenance-preserving.
// ---------------------------------------------------------------------------

test('B10: slp_status projects definitions + rollouts with pins and bounded runs — per-seat scoping', async t => {
  const ctx = await canaryReady(t, { checkExec: execOk([]) });
  // slp_status answers the seat view directly — it is not a mutation reply.
  const status = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_status', {});
  const view = DeskSeatStatus.parse(status.body);
  const assignment = view.assignments.find(a => a.assignmentId === ctx.assignmentId);
  assert.ok(assignment, 'the owned assignment projects');
  assert.equal(assignment.checkDefinitions.length, 1);
  assert.equal(assignment.checkDefinitions[0].checkId, 'check-1');
  assert.equal(assignment.checkDefinitions[0].checkClass, 'repo-git-head');
  assert.equal(assignment.rollouts.length, 1);
  const rollout = assignment.rollouts[0];
  assert.equal(rollout.rolloutId, 'rollout-1');
  assert.equal(rollout.state, 'canary-ready');
  assert.equal(rollout.candidateSnapshot, ctx.snapshot);
  assert.deepEqual(rollout.requiredChecks, ['check-1']);
  assert.deepEqual(rollout.dischargedChecks, ['check-1']);
  assert.equal(rollout.runs.length, 1);
  assert.equal(rollout.runs[0].status, 'passed');
  // A bound seat sees the same machinery rows on its assignment — never
  // the output tails or claimed refs.
  const peerStatus = await call(ctx.peerConn.reader, ctx.peerConn.conn, 'slp_status', {});
  const peerView = DeskSeatStatus.parse(peerStatus.body);
  const peerAssignment = peerView.assignments.find(a => a.assignmentId === ctx.assignmentId);
  assert.ok(peerAssignment, 'a bound seat sees the machinery it may check');
  assert.equal(peerAssignment.rollouts.length, 1);
});

// ---------------------------------------------------------------------------
// B11 — the declare surface: scope/candidate/required-check resolution.
// ---------------------------------------------------------------------------

test('B11: rollout declare resolves scope + observed candidate + required-check pins server-side', async t => {
  // The capture stub answers a mutable snapshot so each seat's observed
  // candidate is distinct — two seats capturing the same tree would
  // legitimately share a snapshot row.
  let capturedSnap = CAPTURED_SNAP;
  const captureMutable = async ({ repository }) => ({
    status: 'ok', repository, measuredAt: CAPTURED_AT,
    snapshotSha256: capturedSnap, head: CAPTURED_HEAD, incomplete: [],
  });
  const ctx = await boundTrio(t, { checkExec: execOk([]), capture: captureMutable });
  const assignmentId = await registerPair(t, ctx);
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_scope_declare', scopeArgs({ assignmentId }));
  await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_check_declare', checkArgs({ assignmentId }));
  // Undeclared scope.
  const noScope = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({ assignmentId, scopeId: 'scope-ghost' }));
  assert.equal(noScope.body.ok, false);
  assert.equal(noScope.body.code, 'SCOPE_CONFLICT');
  // Phantom candidate.
  const noCandidate = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({ assignmentId, candidateSnapshot: '9'.repeat(64) }));
  assert.equal(noCandidate.body.ok, false);
  assert.equal(noCandidate.body.code, 'CANDIDATE_DRIFT');
  const snapshot = await observeCandidate(t, ctx, { peerConn: ctx.peerConn, assignmentId, agentId: 'agent-1' });
  // Phantom required-check digest.
  const noDef = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({
    assignmentId,
    candidateSnapshot: snapshot,
    requiredChecks: [{ checkId: 'check-1', definitionDigest: '7'.repeat(64) }],
  }));
  assert.equal(noDef.body.ok, false);
  assert.equal(noDef.body.code, 'INVALID_RECORD');
  // Duplicate required checkIds are malformed.
  const dup = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({
    assignmentId,
    candidateSnapshot: snapshot,
    requiredChecks: [
      { checkId: 'check-1', definitionDigest: DEF_SHA },
      { checkId: 'check-1', definitionDigest: DEF_SHA },
    ],
  }));
  assert.equal(dup.body.ok, false);
  // Happy path — the stream opens with (none → declared).
  const declare = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({ assignmentId, candidateSnapshot: snapshot }));
  assert.equal(declare.body.ok, true, JSON.stringify(declare.body));
  const body = DeskRolloutDeclareResult.parse(declare.body);
  assert.equal(body.rolloutId, 'rollout-1');
  const ledger = ledgerOf(ctx.f, ctx.repoKey);
  const row = ledger.rollouts.find(r => r.rolloutId === 'rollout-1');
  assert.ok(row);
  assert.equal(row.ownerAgentId, 'agent-lead');
  assert.equal(row.candidateSnapshot, snapshot);
  assert.equal(row.candidateHead, CAPTURED_HEAD);
  const stream = rolloutTransitionsOf(ctx.f, ctx.repoKey);
  assert.equal(stream.length, 1);
  assert.equal(stream[0].command, 'declare');
  assert.equal(stream[0].from, null);
  assert.equal(stream[0].to, 'declared');
  // A seat-bound scope's rollout pins a candidate observed by that seat.
  capturedSnap = '8'.repeat(64);
  const peer2Cand = await observeCandidate(t, ctx, { peerConn: ctx.peer2Conn, assignmentId, agentId: 'agent-2' });
  const crossSeat = await call(ctx.leadConn.reader, ctx.leadConn.conn, 'slp_rollout_declare', rolloutArgs({
    requestId: `rol-${randomUUID()}`,
    assignmentId,
    rolloutId: 'rollout-2',
    candidateSnapshot: peer2Cand,
  }));
  assert.equal(crossSeat.body.ok, false);
  assert.equal(crossSeat.body.code, 'CANDIDATE_DRIFT', 'the bound-seat scope rejects a foreign-seat candidate');
});
