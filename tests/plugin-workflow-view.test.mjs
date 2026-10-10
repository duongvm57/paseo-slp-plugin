import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindWorkspaceDesk, readWorkspaceWorkflow } from '../plugin/server/workflow-view.ts';
import { createDeskStore, deskRepoPaths } from '../plugin/server/desk-store.ts';
import { runAssignmentRegister, runAssignmentAttach, runHandbackSubmit } from '../plugin/server/desk-handback.ts';
import { runAssignmentAmend, runDecisionAppend } from '../plugin/server/desk-assignment.ts';
import { runAssignmentOffer, runAssignmentAccept } from '../plugin/server/desk-ownership.ts';
import { runSettlementRecord } from '../plugin/server/desk-settlement.ts';
import { runScopeDeclare, runScopeTransition, runScopeReview } from '../plugin/server/desk-scope.ts';
import { memberRow, seedMemberships } from './helpers/desk-bridge-fixture.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'slp-workflow-view-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.json'), '{}\n');
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; });
  const repository = join(root, 'repo'); mkdirSync(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args]);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repository, 'file'), 'content\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  return { root, home, repository, git };
}

const workspace = (directory, over = {}) => ({ id: 'workspace-selected', workspaceDirectory: directory, ...over });
const host = value => ({ workspaces: { ref: id => ({ refresh: async () => value }) } });

test('work view binds the fresh selected workspace and shares a repo desk across worktrees without writes', async t => {
  const f = fixture(t);
  const worktree = join(f.root, 'lane'); f.git('worktree', 'add', '-qb', 'lane', worktree);
  let selected;
  const sdk = { workspaces: { ref(id) { selected = id; return { refresh: async () => workspace(worktree) }; } } };
  const view = await bindWorkspaceDesk('workspace-selected', sdk);
  assert.equal(selected, 'workspace-selected');
  assert.equal(view.state, 'ok');
  assert.equal(view.workspaceDirectory, worktree);
  assert.equal(view.repo.gitCommonDir, join(f.repository, '.git'));
  assert.equal(view.repo.hostId, 'local');
  const main = await bindWorkspaceDesk('workspace-selected', host(workspace(f.repository)));
  assert.equal(main.repoKey, view.repoKey);
  assert.deepEqual(readdirSync(f.home), ['config.json']);
});

test('unverified home and linked runtime root withhold even workspace reads', async t => {
  const f = fixture(t);
  let touches = 0;
  const sdk = { workspaces: { ref() { touches++; throw new Error('must not be read'); } } };
  delete process.env.PASEO_HOME;
  assert.equal((await bindWorkspaceDesk('workspace-selected', sdk)).reason, 'home-unverified');
  process.env.PASEO_HOME = f.home;
  const elsewhere = join(f.root, 'elsewhere'); mkdirSync(elsewhere); symlinkSync(elsewhere, join(f.home, 'slp-runtime'));
  assert.equal((await bindWorkspaceDesk('workspace-selected', sdk)).reason, 'home-unverified');
  assert.equal(touches, 0);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('missing workspace capabilities, stale identity, archive and missing directory stay explicit gaps', async t => {
  const f = fixture(t);
  for (const sdk of [undefined, {}, { workspaces: { ref: () => ({}) } }]) {
    assert.equal((await bindWorkspaceDesk('workspace-selected', sdk)).reason, 'workspace-capability-gap');
  }
  for (const value of [null, workspace(f.repository, { id: 'other' }), workspace(f.repository, { archivingAt: 'now' }), { id: 'workspace-selected', projectRootPath: f.repository }, workspace('/absent/workspace'), workspace('relative')]) {
    assert.equal((await bindWorkspaceDesk('workspace-selected', host(value))).reason, 'workspace-unavailable');
  }
  const plain = join(f.root, 'plain'); mkdirSync(plain);
  assert.equal((await bindWorkspaceDesk('workspace-selected', host(workspace(plain)))).reason, 'repository-unavailable');
});

test('repository environment cannot redirect a read away from the selected workspace', async t => {
  const f = fixture(t);
  const other = join(f.root, 'other'); mkdirSync(other); execFileSync('git', ['init', '-q', other]);
  const names = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'];
  const previous = names.map(name => process.env[name]);
  for (const name of names) process.env[name] = name === 'GIT_WORK_TREE' ? other : join(other, '.git');
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  const binding = await bindWorkspaceDesk('workspace-selected', host(workspace(f.repository)));
  assert.equal(binding.state, 'ok');
  assert.equal(binding.repo.gitCommonDir, join(f.repository, '.git'));
});

const request = (over = {}) => ({ schemaVersion: 1, workspaceId: 'workspace-selected', assignmentId: null,
  assignmentCursor: null, limit: 20,
  page: { section: 'briefs', expectedLedgerRevision: null, expectedBriefRevision: null, cursor: null, limit: 20 }, ...over });

async function registered(t, count = 1, objective = 'A bounded legacy assignment') {
  const f = fixture(t);
  const sdk = host(workspace(f.repository));
  const binding = await bindWorkspaceDesk('workspace-selected', sdk);
  assert.equal(binding.state, 'ok');
  const store = createDeskStore({ stableRoot: binding.home.stableRoot });
  const lead = memberRow('workflow-lead', { provider: 'slp-codex-lead', at: '2026-01-01T00:00:00.000Z' },
    { role: 'lead', agentId: 'workflow-lead', workspaceId: 'workspace-selected', createCwd: f.repository });
  await seedMemberships(store, binding.repo, [lead]);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const result = await runAssignmentRegister({ repoKey: binding.repoKey, row: lead },
      { requestId: `register-${i}`, authorityRef: 'human:bounded-test', objective }, { store });
    assert.equal(result.ok, true, JSON.stringify(result));
    ids.push(result.assignmentId);
  }
  return { ...f, sdk, binding, store, lead, ids, ledgerPath: deskRepoPaths(binding.home.stableRoot, binding.repoKey).ledgerPath };
}

test('Human read projects a legacy assignment without inventing a brief or accepting it, and writes no state', async t => {
  const f = await registered(t);
  const before = readFileSync(f.ledgerPath);
  const list = await readWorkspaceWorkflow(request(), f.sdk);
  assert.equal(list.state, 'ready');
  assert.equal(list.assignmentTotal, 1);
  assert.equal(list.assignments[0].id, f.ids[0]);
  assert.equal(list.assignments[0].objectiveBasis, 'registration');
  assert.equal(list.assignments[0].briefRevision, 0);
  assert.equal(list.assignments[0].ownerAgentId, 'workflow-lead');
  assert.equal(list.assignments[0].ownershipRevision, 0);
  assert.equal(list.acceptance, 'not-established-by-this-view');
  const detail = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0] }), f.sdk);
  assert.equal(detail.view.currentBrief, null);
  assert.equal(detail.view.briefRevision, 0);
  assert.equal(detail.view.legacyObjective, 'A bounded legacy assignment');
  assert.equal(detail.view.acceptance, 'not-established-by-this-view');
  assert.deepEqual(readFileSync(f.ledgerPath), before);
});

test('list pages obey the whole UTF-8 response budget and retain every full objective', async t => {
  const objective = '𐐀'.repeat(1024);
  const f = await registered(t, 24, objective);
  let input = request({ limit: 50 });
  const seen = new Set();
  for (let pages = 0; pages < 25; pages++) {
    const page = await readWorkspaceWorkflow(input, f.sdk);
    assert.equal(page.state, 'ready');
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65536, 'independent wire byte bound');
    assert.equal(page.assignmentTotal, 24);
    for (const row of page.assignments) { assert.equal(row.objective, objective); assert.equal(seen.has(row.id), false); seen.add(row.id); }
    if (!page.assignmentNextCursor) break;
    assert.ok(page.assignments.length > 0, 'continuation makes progress');
    input = request({ limit: 50, assignmentCursor: page.assignmentNextCursor,
      page: { ...input.page, expectedLedgerRevision: page.ledgerRevision } });
  }
  assert.deepEqual(seen, new Set(f.ids));
});

test('changed ledger rejects a list continuation and an old pinned detail rather than mixing revisions', async t => {
  const f = await registered(t, 2);
  const first = await readWorkspaceWorkflow(request({ limit: 1 }), f.sdk);
  const changed = await runAssignmentRegister({ repoKey: f.binding.repoKey, row: f.lead },
    { requestId: 'register-new', authorityRef: 'human:bounded-test', objective: 'Later work' }, { store: f.store });
  assert.equal(changed.ok, true);
  const next = await readWorkspaceWorkflow(request({ assignmentCursor: first.assignmentNextCursor,
    page: { ...request().page, expectedLedgerRevision: first.ledgerRevision } }), f.sdk);
  assert.equal(next.state, 'conflict');
  assert.equal(next.problem.code, 'REVISION_CONFLICT');
  assert.deepEqual(next.assignments, []);
  const detail = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0],
    page: { ...request().page, expectedLedgerRevision: first.ledgerRevision } }), f.sdk);
  assert.equal(detail.state, 'conflict');
  assert.equal(detail.view, null);
});

test('absent and future/unreadable ledgers stay different, and caller paths are rejected before host reads', async t => {
  const f = fixture(t);
  const sdk = host(workspace(f.repository));
  assert.equal((await readWorkspaceWorkflow(request(), sdk)).state, 'absent');
  assert.deepEqual(readdirSync(f.home), ['config.json']);
  const unreadable = await readWorkspaceWorkflow(request(), sdk, { deskStore: () => ({ read: () => ({ state: 'future', diagnostics: { code: 'future-version', schemaVersion: 999 } }) }) });
  assert.equal(unreadable.state, 'unavailable');
  assert.equal(unreadable.problem.code, 'STATE_UNREADABLE');
  let touches = 0;
  const noTouch = { workspaces: { ref() { touches++; throw new Error('not authorized'); } } };
  await assert.rejects(() => readWorkspaceWorkflow(request({ repository: f.repository }), noTouch), /invalid workspace workflow request/);
  await assert.rejects(() => readWorkspaceWorkflow(request({ daemonHome: f.home }), noTouch), /invalid workspace workflow request/);
  assert.equal(touches, 0);
});

const operativeBrief = (objective, constraintCount) => ({
  objective, acceptanceCriteria: ['All declared evidence is inspectable'],
  constraints: Array.from({ length: constraintCount }, (_, i) => ({ text: `${i}:` + 'c'.repeat(4090), authorityRef: 'human:test', sourceRef: null })),
  provisionalDesign: 'Keep declared records intact', assumptions: [], unknowns: [], requiredEvidence: [],
  ownedSurfaces: [], excludedSurfaces: [], dependencies: [], notifications: [],
});

test('detail pages reduce row count under the UTF-8 budget while keeping full briefs and retrievable omissions', async t => {
  const f = await registered(t);
  for (let revision = 0; revision < 3; revision++) {
    const result = await runAssignmentAmend({ repoKey: f.binding.repoKey, row: f.lead }, {
      requestId: `brief-${revision}`, assignmentId: f.ids[0], expectedBriefRevision: revision,
      brief: operativeBrief(`Outcome ${revision + 1}`, 6), changeReason: 'Update the operative outcome',
      authorityRef: 'human:test', affectedOwners: [f.lead.agentId],
    }, { store: f.store });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const before = readFileSync(f.ledgerPath);
  let input = request({ assignmentId: f.ids[0], page: { ...request().page, limit: 50 } });
  const seen = [];
  for (let pages = 0; pages < 4; pages++) {
    const result = await readWorkspaceWorkflow(input, f.sdk);
    assert.equal(result.state, 'ready');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
    const view = result.view;
    assert.equal(view.currentBrief.body.objective, 'Outcome 3');
    assert.equal(view.total, 3);
    assert.equal(view.omittedBefore + view.items.length + view.omittedAfter, 3);
    for (const item of view.items) {
      assert.equal(item.kind, 'briefRevision');
      assert.deepEqual(item.row.body, operativeBrief(`Outcome ${item.row.revision}`, 6));
      seen.push(item.row.revision);
    }
    if (!view.nextCursor) break;
    assert.ok(view.items.length > 0);
    input = request({ assignmentId: f.ids[0], page: { ...request().page, limit: 50,
      expectedLedgerRevision: result.ledgerRevision, expectedBriefRevision: view.briefRevision, cursor: view.nextCursor } });
  }
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(readFileSync(f.ledgerPath), before);
});

test('a complete brief larger than the view budget returns an explicit gap rather than clipped constraints', async t => {
  const f = await registered(t);
  const result = await runAssignmentAmend({ repoKey: f.binding.repoKey, row: f.lead }, {
    requestId: 'large-brief', assignmentId: f.ids[0], expectedBriefRevision: 0,
    brief: operativeBrief('Preserve a large operative brief', 20), changeReason: 'Retain required constraints',
    authorityRef: 'human:test', affectedOwners: [],
  }, { store: f.store });
  assert.equal(result.ok, true, JSON.stringify(result));
  const before = readFileSync(f.ledgerPath);
  const detail = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0] }), f.sdk);
  assert.equal(detail.state, 'unavailable');
  assert.equal(detail.problem.code, 'VIEW_TOO_LARGE');
  assert.equal(detail.view, null);
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= 65536);
  assert.deepEqual(readFileSync(f.ledgerPath), before);
});

test('selection: Human read preserves the selected no-review basis separately from waiver and legacy claims', async t => {
  const f = await registered(t);
  for (const [scopeId, reviewPlan] of [
    ['selected', { kind: 'not-required', authorityRef: 'grant:selection', ruleRef: 'rule:bounded',
      reason: 'No material independent question remains.', lenses: [], exemptionClass: null }],
    ['waived', { kind: 'exempt', authorityRef: 'grant:waiver', ruleRef: 'rule:class',
      reason: 'The declared class has an authority-backed waiver.', lenses: [], exemptionClass: 'bounded-class' }],
    ['legacy', null],
  ]) {
    const result = await runScopeDeclare({ repoKey: f.binding.repoKey, row: f.lead }, {
      requestId: `declare-${scopeId}`, assignmentId: f.ids[0], scopeId, seatAgentId: null,
      label: scopeId, declarationSha256: 'd'.repeat(64), refs: [], reviewPlan,
    }, { store: f.store });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const before = readFileSync(f.ledgerPath);
  const read = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0],
    page: { ...request().page, section: 'ownership' },
  }), f.sdk);
  assert.equal(read.state, 'ready');
  const rows = new Map(read.view.items.map(item => [item.row.scopeId, item.row]));
  assert.equal(rows.get('selected').reviewPlan.kind, 'not-required');
  assert.equal(rows.get('selected').reviewPlan.exemptionClass, null);
  assert.equal(rows.get('selected').reviewPlan.reason, 'No material independent question remains.');
  assert.equal(rows.get('waived').reviewPlan.kind, 'exempt');
  assert.equal(rows.get('waived').reviewPlan.exemptionClass, 'bounded-class');
  assert.equal(rows.get('legacy').reviewPlan, null);
  assert.equal(read.acceptance, 'not-established-by-this-view');
  assert.deepEqual(readFileSync(f.ledgerPath), before);
});

test('DC-01: current disagreement survives review-observed, excludes obsolete rounds and preserves Lead rulings', async t => {
  const f = await registered(t);
  const assignmentId = f.ids[0], scopeId = 'continuity';
  const ctx = row => ({ repoKey: f.binding.repoKey, row });
  const succeed = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const seats = ['writer', 'reviewer-a', 'reviewer-b'].map(agentId => memberRow(`workflow-${agentId}`,
    { provider: 'slp-codex-peer', at: '2026-01-01T00:00:00.000Z' },
    { role: 'peer', agentId, workspaceId: 'workspace-selected', createCwd: f.repository }));
  await seedMemberships(f.store, f.binding.repo, [f.lead, ...seats]);
  for (const seat of seats) succeed(await runAssignmentAttach(ctx(f.lead), {
    requestId: randomUUID(), assignmentId, agentId: seat.agentId,
  }, { store: f.store }));
  const plan = { kind: 'required', authorityRef: 'human:continuity', ruleRef: 'rule:continuity',
    reason: 'Independent continuity judgment is required.', exemptionClass: null,
    lenses: [{ id: 'continuity', name: 'Continuity', authorityRef: 'human:continuity', ruleRef: 'rule:continuity' }] };
  let scopeRevision = 1, briefRevision = 0;
  const declare = () => runScopeDeclare(ctx(f.lead), {
    requestId: randomUUID(), assignmentId, scopeId, label: 'Continuity', declarationSha256: 'd'.repeat(64),
    refs: [], seatAgentId: 'writer', expectedBriefRevision: briefRevision, reviewPlan: plan,
  }, { store: f.store });
  const transition = (command, candidateSnapshot = null) => runScopeTransition(ctx(f.lead), {
    requestId: randomUUID(), assignmentId, scopeId, scopeRevision, briefRevision, transition: command,
    candidateSnapshot, candidateHead: null,
  }, { store: f.store });
  const review = (seat, candidateSnapshot, verdict) => runScopeReview(ctx(seat), {
    requestId: randomUUID(), assignmentId, scopeId, scopeRevision, briefRevision,
    candidateSnapshot, lensId: 'continuity', verdict,
    findingsRef: verdict === 'findings' ? 'evidence:continuity-gap' : null,
  }, { store: f.store });
  const capture = async candidateSnapshot => succeed(await runHandbackSubmit(ctx(seats[0]), {
    requestId: randomUUID(), assignmentId, candidateId: null,
    recordV1: { version: 1, kind: 'handback', seat: { role: 'peer', disposition: 'engineer', agentId: 'writer' },
      verdict: null, candidate: { repository: f.repository, snapshotSha256: candidateSnapshot }, checks: [] },
  }, { store: f.store, uuid: randomUUID, now: () => new Date('2026-01-01T00:00:01.000Z'),
    binding: { nodePath: process.execPath, runtimePath: '/fixture/runtime' },
    capture: async ({ repository }) => ({ status: 'ok', repository, measuredAt: '2026-01-01T00:00:01.000Z',
      snapshotSha256: candidateSnapshot, head: null, incomplete: [] }),
  }));
  const read = async () => {
    const bytes = readFileSync(f.ledgerPath);
    const result = await readWorkspaceWorkflow(request({ assignmentId,
      page: { ...request().page, section: 'reviews', limit: 50 },
    }), f.sdk);
    assert.equal(result.state, 'ready', JSON.stringify(result));
    assert.equal(result.view.omittedBefore, 0);
    assert.equal(result.view.omittedAfter, 0, 'the regression inspects the whole review page');
    assert.equal(result.acceptance, 'not-established-by-this-view');
    assert.deepEqual(readFileSync(f.ledgerPath), bytes, 'the public read never adjudicates or writes state');
    return result.view;
  };
  const markers = view => view.items.filter(item => item.kind === 'reviewDisagreement');
  // Compare the immutable rows only — the per-item `qualification` marker
  // is a read-time projection of current standing, not recorded history.
  const observations = view => view.items.filter(item => item.kind === 'scopeReview').map(item => item.row);
  const assertDisagreement = (view, candidate, findingsId, approvalId) => {
    assert.deepEqual(markers(view).map(item => item.reason).sort(), ['conflicting-verdicts', 'unresolved-findings']);
    for (const marker of markers(view)) {
      assert.equal(marker.scopeRevision, scopeRevision);
      assert.equal(marker.briefRevision, briefRevision);
      assert.equal(marker.candidateSnapshot, candidate);
      assert.deepEqual(marker.reviewIds.slice().sort(), marker.reason === 'unresolved-findings'
        ? [findingsId] : [findingsId, approvalId].sort());
    }
  };
  const candidateA = 'a'.repeat(64), candidateB = 'b'.repeat(64);
  succeed(await declare());
  await capture(candidateA);
  succeed(await transition('claim'));
  succeed(await transition('submit-for-review', candidateA));
  const findingsA = succeed(await review(seats[1], candidateA, 'findings'));
  const approvalA = succeed(await review(seats[2], candidateA, 'approve'));
  const before = await read();
  assertDisagreement(before, candidateA, findingsA.reviewId, approvalA.reviewId);
  assert.equal(before.items.filter(item => item.kind === 'scopeTransition').at(-1).row.to, 'submitted-for-review');
  succeed(await transition('review-observed'));
  const after = await read();
  assert.deepEqual(markers(after), markers(before), 'observing the required review set is not adjudication');
  assert.deepEqual(observations(after), observations(before));
  assert.equal(after.items.filter(item => item.kind === 'scopeTransition').at(-1).row.candidateSnapshot, null);
  succeed(await transition('approve'));
  const ruled = await read();
  assert.deepEqual(markers(ruled), [], 'the actual owner ruling ends the pending adjudication');
  assert.deepEqual(observations(ruled), observations(before), 'a ruling does not rewrite either independent verdict');
  assert.equal(ruled.items.filter(item => item.kind === 'scopeTransition').at(-1).row.command, 'approve');

  await capture(candidateB);
  succeed(await transition('submit-for-review', candidateB));
  assert.deepEqual(markers(await read()), [], 'the old candidate disagreement cannot enter a new candidate round');
  const approvalB = succeed(await review(seats[2], candidateB, 'approve'));
  succeed(await review(seats[1], candidateB, 'approve'));
  assert.deepEqual(markers(await read()), [], 'agreeing current observations are not a conflict');
  const findingsB = succeed(await review(seats[1], candidateB, 'findings'));
  assertDisagreement(await read(), candidateB, findingsB.reviewId, approvalB.reviewId);
  succeed(await transition('review-observed'));
  assertDisagreement(await read(), candidateB, findingsB.reviewId, approvalB.reviewId);
  scopeRevision = succeed(await declare()).revision;
  assert.deepEqual(markers(await read()), [], 'a declaration amendment makes the earlier round obsolete');
  succeed(await transition('reject'));
  succeed(await transition('submit-for-review', candidateB));
  assert.deepEqual(markers(await read()), [], 'same candidate with a fresh declaration does not inherit old observations');
  const findings2 = succeed(await review(seats[1], candidateB, 'findings'));
  const approval2 = succeed(await review(seats[2], candidateB, 'approve'));
  succeed(await transition('review-observed'));
  assertDisagreement(await read(), candidateB, findings2.reviewId, approval2.reviewId);

  const historicalReviews = observations(await read());
  succeed(await runAssignmentAmend(ctx(f.lead), {
    requestId: randomUUID(), assignmentId, expectedBriefRevision: 0,
    brief: operativeBrief('A revised continuity objective', 0), changeReason: 'Clarify the authorized outcome',
    authorityRef: 'human:continuity', affectedOwners: [f.lead.agentId, 'writer'],
  }, { store: f.store }));
  briefRevision = 1;
  assert.deepEqual(markers(await read()), [], 'a brief amendment excludes pending markers on stale pins');
  assert.deepEqual(observations(await read()), historicalReviews);
  scopeRevision = succeed(await declare()).revision;
  succeed(await transition('reject'));
  succeed(await transition('submit-for-review', candidateB));
  assert.deepEqual(markers(await read()), []);
  const findings3 = succeed(await review(seats[1], candidateB, 'findings'));
  const approval3 = succeed(await review(seats[2], candidateB, 'approve'));
  succeed(await transition('review-observed'));
  assertDisagreement(await read(), candidateB, findings3.reviewId, approval3.reviewId);
  const currentReviews = observations(await read());
  succeed(await transition('reject'));
  const rejected = await read();
  assert.deepEqual(markers(rejected), []);
  assert.deepEqual(observations(rejected), currentReviews);
  assert.equal(rejected.items.filter(item => item.kind === 'scopeTransition').at(-1).row.command, 'reject');
});

const leadMember = (agentId, repository) => memberRow(`workflow-${agentId}`,
  { provider: 'slp-codex-lead', at: '2026-01-01T00:00:00.000Z' },
  { role: 'lead', agentId, workspaceId: 'workspace-selected', createCwd: repository });

const ledgerRevisionOf = f => f.store.read(f.binding.repoKey).ledger.revision;

test('discovery returns the whole operative objective, its basis and the effective owner after succession', async t => {
  const f = await registered(t, 1, 'Legacy registration objective');
  const objective = '𐐀'.repeat(2048); // 4096 UTF-16 units — the full operative bound, unlike the 2048 registration cap
  const amend = await runAssignmentAmend({ repoKey: f.binding.repoKey, row: f.lead }, {
    requestId: 'brief-unicode', assignmentId: f.ids[0], expectedBriefRevision: 0,
    brief: operativeBrief(objective, 0), changeReason: 'Set the operative outcome',
    authorityRef: 'human:test', affectedOwners: [f.lead.agentId],
  }, { store: f.store });
  assert.equal(amend.ok, true, JSON.stringify(amend));

  const receiver = leadMember('workflow-receiver', f.repository);
  await seedMemberships(f.store, f.binding.repo, [f.lead, receiver]);
  const offer = await runAssignmentOffer({ repoKey: f.binding.repoKey, row: f.lead }, {
    requestId: 'offer-1', assignmentId: f.ids[0], expectedOwnershipRevision: 0,
    targetAgentId: receiver.agentId, targetMembershipId: receiver.membershipId,
    authorityRef: 'human:handoff', contextRef: 'note:planned-succession',
  }, { store: f.store });
  assert.equal(offer.ok, true, JSON.stringify(offer));
  const accept = await runAssignmentAccept({ repoKey: f.binding.repoKey, row: receiver }, {
    requestId: 'accept-1', assignmentId: f.ids[0], offerId: offer.offerId,
    expectedOwnershipRevision: 0, expectedLedgerRevision: ledgerRevisionOf(f), expectedBriefRevision: 1,
    acknowledgment: 'I take custody of the recorded work and its open obligations.',
    settlementRef: null,
    resources: [{ ref: 'issue:TRACK-1', disposition: 'retained' }, { ref: 'session:old-handle', disposition: 'unknown' }],
  }, { store: f.store });
  assert.equal(accept.ok, true, JSON.stringify(accept));

  const before = readFileSync(f.ledgerPath);
  const list = await readWorkspaceWorkflow(request(), f.sdk);
  assert.equal(list.state, 'ready', JSON.stringify(list.problem));
  const row = list.assignments[0];
  assert.equal(row.objective, objective);
  assert.equal(row.objectiveBasis, 'brief');
  assert.equal(row.briefRevision, 1);
  assert.equal(row.ownerAgentId, 'workflow-receiver');
  assert.equal(row.ownerMembershipId, receiver.membershipId);
  assert.equal(row.ownershipRevision, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(list)) <= 65536);

  const detail = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0] }), f.sdk);
  const ownership = detail.view.ownership;
  assert.equal(ownership.registeredOwnerAgentId, 'workflow-lead');
  assert.equal(ownership.registeredOwnerMembershipId, f.lead.membershipId);
  assert.equal(ownership.ownerAgentId, 'workflow-receiver');
  assert.equal(ownership.ownerMembershipId, receiver.membershipId);
  assert.equal(ownership.ownershipRevision, 1);
  assert.deepEqual(ownership.ownerMembership, {
    state: 'host-confirmed', registeredAt: '2026-01-01T00:00:00.000Z', revokedAt: null });
  const ack = ownership.acceptedAcknowledgment;
  assert.equal(ack.acceptId, accept.acceptId);
  assert.equal(ack.offerId, offer.offerId);
  assert.equal(ack.requestId, 'accept-1');
  assert.equal(ack.acknowledgment, 'I take custody of the recorded work and its open obligations.');
  assert.equal(ack.settlementRef, null);
  assert.deepEqual(ack.gaps, []);
  assert.equal(ack.briefRevision, 1);
  assert.ok(Number.isInteger(ack.ledgerRevision) && ack.ledgerRevision >= 0);
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= 65536);

  const ownershipPage = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0],
    page: { ...request().page, section: 'ownership' } }), f.sdk);
  assert.deepEqual(ownershipPage.view.items.map(item => item.kind), ['ownershipOffer', 'ownershipAccept']);
  const offerRow = ownershipPage.view.items[0].row;
  assert.equal(offerRow.fromAgentId, 'workflow-lead');
  assert.equal(offerRow.toMembershipId, receiver.membershipId);
  const acceptRow = ownershipPage.view.items[1].row;
  assert.equal(acceptRow.acknowledgment, 'I take custody of the recorded work and its open obligations.');
  assert.deepEqual(acceptRow.resources, [
    { ref: 'issue:TRACK-1', disposition: 'retained' },
    { ref: 'session:old-handle', disposition: 'unknown' }]);
  assert.deepEqual(readFileSync(f.ledgerPath), before, 'the public read never writes');
});

const submitDeps = (f, capture) => ({
  store: f.store, uuid: randomUUID, now: () => new Date('2026-01-01T00:00:01.000Z'),
  binding: { nodePath: process.execPath, runtimePath: '/fixture/runtime' }, capture,
});

const seatRecord = (repository, checks, over = {}) => ({
  version: 1, kind: 'handback',
  seat: { role: 'peer', disposition: 'engineer', agentId: 'seat-1' },
  verdict: null, candidate: { repository, snapshotSha256: 'c'.repeat(64) }, checks,
  ...over,
});

test('handback summaries keep declared claims, measured observation and ledger-only bodies distinct', async t => {
  const f = await registered(t);
  const seat = memberRow('workflow-seat', { provider: 'slp-codex-peer', at: '2026-01-01T00:00:00.000Z' },
    { role: 'peer', agentId: 'seat-1', workspaceId: 'workspace-selected', createCwd: f.repository });
  await seedMemberships(f.store, f.binding.repo, [f.lead, seat]);
  const ctx = row => ({ repoKey: f.binding.repoKey, row });
  const attach = await runAssignmentAttach(ctx(f.lead), {
    requestId: 'attach-seat', assignmentId: f.ids[0], agentId: 'seat-1' }, { store: f.store });
  assert.equal(attach.ok, true, JSON.stringify(attach));

  // A large claim stays ledger-held: the summary carries digest, measured
  // size and availability, never the body.
  const bigOutput = 'x'.repeat(200_000);
  const bigRecord = seatRecord(f.repository, [
    { cmd: 'run-proof', exit: 0, sha: createHash('sha256').update(bigOutput).digest('hex'), output: bigOutput, outputRef: 'artifacts/proof.log' },
    { cmd: 'run-lint', exit: 1, sha: null, outputRef: 'artifacts/lint.log' },
  ]);
  const okSubmit = await runHandbackSubmit(ctx(seat), {
    requestId: 'hb-ok', assignmentId: f.ids[0], candidateId: null, recordV1: bigRecord },
    submitDeps(f, async ({ repository }) => ({ status: 'ok', repository, measuredAt: '2026-01-01T00:00:02.000Z',
      snapshotSha256: 'c'.repeat(64), head: null, incomplete: [] })));
  assert.equal(okSubmit.ok, true, JSON.stringify(okSubmit));

  const pending = await runHandbackSubmit(ctx(seat), {
    requestId: 'hb-pending', assignmentId: f.ids[0], candidateId: okSubmit.observedCandidateId,
    recordV1: seatRecord(f.repository, [{ cmd: 'check', exit: 0, sha: null }]) },
    { ...submitDeps(f, async () => { throw new Error('capture must not run'); }), binding: null });
  assert.equal(pending.ok, true, JSON.stringify(pending));
  assert.equal(pending.observedCandidateId, null);

  const failed = await runHandbackSubmit(ctx(seat), {
    requestId: 'hb-failed', assignmentId: f.ids[0], candidateId: null,
    recordV1: seatRecord(f.repository, [{ cmd: 'check', exit: 2, sha: null }]) },
    submitDeps(f, async ({ repository }) => ({ status: 'failed', repository, measuredAt: '2026-01-01T00:00:03.000Z',
      reason: 'exit', detail: 'snapshot subprocess exited 9' })));
  assert.equal(failed.ok, true, JSON.stringify(failed));

  const before = readFileSync(f.ledgerPath);
  const result = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0],
    page: { ...request().page, section: 'evidence', limit: 50 } }), f.sdk);
  assert.equal(result.state, 'ready', JSON.stringify(result.problem));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536, 'a 200KiB claim never inflates the page');
  const summaries = result.view.items.filter(item => item.kind === 'handbackSummary');
  assert.equal(summaries.length, 3);
  const byRequest = new Map(summaries.map(item => [item.summary.requestId, item.summary]));
  const okSummary = byRequest.get('hb-ok');
  assert.equal(okSummary.recordAvailability, 'ledger');
  assert.equal(okSummary.recordSha256.length, 64);
  assert.ok(okSummary.recordBytes > 200_000, `measured record bytes: ${okSummary.recordBytes}`);
  assert.equal(okSummary.observed.status, 'ok');
  assert.equal(okSummary.observed.candidateId, okSubmit.observedCandidateId);
  assert.equal(okSummary.suppliedCheckCount, 2);
  assert.deepEqual(okSummary.suppliedOutputRefs, ['artifacts/proof.log', 'artifacts/lint.log']);
  assert.equal(okSummary.outputRefsOmitted, 0);
  assert.ok(!('record' in okSummary) && !('body' in okSummary), 'no record body on the wire');
  const pendingSummary = byRequest.get('hb-pending');
  assert.equal(pendingSummary.observed.status, 'pending');
  assert.equal(pendingSummary.claimedCandidateId, okSubmit.observedCandidateId);
  assert.equal(pendingSummary.observed.candidateId, null);
  const failedSummary = byRequest.get('hb-failed');
  assert.equal(failedSummary.observed.status, 'failed');
  assert.match(failedSummary.observed.error, /exit/);
  const candidateItem = result.view.items.find(item => item.kind === 'candidateObservation');
  assert.equal(candidateItem.row.candidateId, okSubmit.observedCandidateId);
  assert.equal(result.acceptance, 'not-established-by-this-view');
  assert.deepEqual(readFileSync(f.ledgerPath), before);
});

test('settlement summaries carry the complete recorded account with claimed vs measured export distinct', async t => {
  const f = await registered(t);
  const seat = memberRow('workflow-seat', { provider: 'slp-codex-peer', at: '2026-01-01T00:00:00.000Z' },
    { role: 'peer', agentId: 'seat-1', workspaceId: 'workspace-selected', createCwd: f.repository });
  await seedMemberships(f.store, f.binding.repo, [f.lead, seat]);
  const ctx = row => ({ repoKey: f.binding.repoKey, row });
  assert.equal((await runAssignmentAttach(ctx(f.lead), {
    requestId: 'attach-seat', assignmentId: f.ids[0], agentId: 'seat-1' }, { store: f.store })).ok, true);
  const submit = await runHandbackSubmit(ctx(seat), {
    requestId: 'hb-1', assignmentId: f.ids[0], candidateId: null,
    recordV1: seatRecord(f.repository, [{ cmd: 'check', exit: 0, sha: 'e'.repeat(64) }]) },
    submitDeps(f, async ({ repository }) => ({ status: 'ok', repository, measuredAt: '2026-01-01T00:00:02.000Z',
      snapshotSha256: 'c'.repeat(64), head: null, incomplete: [] })));
  assert.equal(submit.ok, true, JSON.stringify(submit));
  const settlement = await runSettlementRecord(ctx(f.lead), {
    requestId: 'stl-1', assignmentId: f.ids[0], seatAgentId: 'seat-1', seatTitle: 'Engineer seat',
    at: '2026-01-01T00:00:05.000Z',
    deliveryRef: 'deliverable:pr-7', reworkClosureRef: null, sinkRef: null, decisionRef: null,
    handbackRefs: [submit.handbackId], candidateRefs: [submit.observedCandidateId],
    resources: [
      { ref: 'branch:worktree-1', disposition: 'released' },
      { ref: 'issue:TRACK-2', disposition: 'retained' },
      { ref: 'session:orphaned', disposition: 'unknown' },
    ],
    timeline: { nativeHandle: null, sessionId: 'session-1', via: 'unchecked',
      export: { path: 'exports/transcript.json', sha256: 'f'.repeat(64), bytes: 128 }, gap: null },
  }, { store: f.store, verifyExport: async () => ({ status: 'unavailable', detail: 'the artifact seam could not prove the claim' }) });
  assert.equal(settlement.ok, true, JSON.stringify(settlement));
  assert.equal(settlement.status, 'partial');

  const result = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0],
    page: { ...request().page, section: 'evidence', limit: 50 } }), f.sdk);
  assert.equal(result.state, 'ready', JSON.stringify(result.problem));
  const summary = result.view.items.find(item => item.kind === 'settlementSummary').summary;
  assert.equal(summary.settlementId, settlement.settlementId);
  assert.equal(summary.status, 'partial');
  assert.equal(summary.ownerAgentId, 'workflow-lead');
  assert.equal(summary.seatAgentId, 'seat-1');
  assert.deepEqual(summary.resources, [
    { ref: 'branch:worktree-1', disposition: 'released' },
    { ref: 'issue:TRACK-2', disposition: 'retained' },
    { ref: 'session:orphaned', disposition: 'unknown' }]);
  assert.deepEqual(summary.timeline.export, { path: 'exports/transcript.json', sha256: 'f'.repeat(64), bytes: 128 });
  assert.deepEqual(summary.exportVerification, { status: 'unavailable', detail: 'the artifact seam could not prove the claim' });
  assert.ok(summary.gaps.includes('resource-dispositions-unknown:1'));
  assert.ok(summary.gaps.includes('transcript-export-unverified'));
  assert.equal(summary.handbackRefs[0], submit.handbackId);
});

test('review items distinguish current standing qualification from immutable history across succession', async t => {
  const f = await registered(t);
  const ctx = row => ({ repoKey: f.binding.repoKey, row });
  const receiver = leadMember('workflow-receiver', f.repository);
  const seats = ['reviewer-a'].map(agentId => memberRow(`workflow-${agentId}`,
    { provider: 'slp-codex-peer', at: '2026-01-01T00:00:00.000Z' },
    { role: 'peer', agentId, workspaceId: 'workspace-selected', createCwd: f.repository }));
  await seedMemberships(f.store, f.binding.repo, [f.lead, receiver, ...seats]);
  // The receiver joins as an attached seat so it can observe the round
  // before it ever holds ownership.
  for (const seat of [receiver, ...seats]) {
    const attach = await runAssignmentAttach(ctx(f.lead), {
      requestId: randomUUID(), assignmentId: f.ids[0], agentId: seat.agentId }, { store: f.store });
    assert.equal(attach.ok, true, JSON.stringify(attach));
  }
  const plan = { kind: 'required', authorityRef: 'human:continuity', ruleRef: 'rule:continuity',
    reason: 'Independent continuity judgment is required.', exemptionClass: null,
    lenses: [{ id: 'continuity', name: 'Continuity', authorityRef: 'human:continuity', ruleRef: 'rule:continuity' }] };
  const declared = await runScopeDeclare(ctx(f.lead), {
    requestId: randomUUID(), assignmentId: f.ids[0], scopeId: 'continuity', label: 'Continuity',
    declarationSha256: 'd'.repeat(64), refs: [], seatAgentId: null, expectedBriefRevision: 0, reviewPlan: plan,
  }, { store: f.store });
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const scopeRevision = declared.revision;
  const snapshot = 'a'.repeat(64);
  const submit = await runHandbackSubmit(ctx(seats[0]), {
    requestId: randomUUID(), assignmentId: f.ids[0], candidateId: null,
    recordV1: seatRecord(f.repository, []),
  }, submitDeps(f, async ({ repository }) => ({ status: 'ok', repository, measuredAt: '2026-01-01T00:00:02.000Z',
    snapshotSha256: snapshot, head: null, incomplete: [] })));
  assert.equal(submit.ok, true, JSON.stringify(submit));
  const transition = (command, candidateSnapshot = null) => runScopeTransition(ctx(f.lead), {
    requestId: randomUUID(), assignmentId: f.ids[0], scopeId: 'continuity', scopeRevision,
    briefRevision: 0, transition: command, candidateSnapshot, candidateHead: null,
  }, { store: f.store });
  const review = (seat, verdict) => runScopeReview(ctx(seat), {
    requestId: randomUUID(), assignmentId: f.ids[0], scopeId: 'continuity', scopeRevision,
    briefRevision: 0, candidateSnapshot: snapshot, lensId: 'continuity', verdict, findingsRef: null,
  }, { store: f.store });
  assert.equal((await transition('claim')).ok, true);
  assert.equal((await transition('submit-for-review', snapshot)).ok, true);
  const earlierReview = await review(seats[0], 'approve');
  assert.equal(earlierReview.ok, true, JSON.stringify(earlierReview));
  const dischargingReview = await review(receiver, 'approve');
  assert.equal(dischargingReview.ok, true, JSON.stringify(dischargingReview));
  assert.equal((await transition('review-observed')).ok, true);
  assert.equal((await transition('approve')).ok, true, 'the recorded approval gates on the receiver seat review');

  const readReviews = async () => {
    const result = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0],
      page: { ...request().page, section: 'reviews', limit: 50 } }), f.sdk);
    assert.equal(result.state, 'ready', JSON.stringify(result.problem));
    return result.view.items.filter(item => item.kind === 'scopeReview');
  };
  const before = await readReviews();
  const beforeByReviewer = new Map(before.map(item => [item.row.reviewerAgentId, item]));
  assert.deepEqual(beforeByReviewer.get('workflow-receiver').qualification,
    { eligible: true, discharging: true, standingApproval: true });
  assert.deepEqual(beforeByReviewer.get('reviewer-a').qualification,
    { eligible: true, discharging: false, standingApproval: false });

  const offer = await runAssignmentOffer(ctx(f.lead), {
    requestId: 'offer-rev', assignmentId: f.ids[0], expectedOwnershipRevision: 0,
    targetAgentId: receiver.agentId, targetMembershipId: receiver.membershipId,
    authorityRef: 'human:handoff', contextRef: 'note:planned-succession',
  }, { store: f.store });
  assert.equal(offer.ok, true, JSON.stringify(offer));
  const accept = await runAssignmentAccept(ctx(receiver), {
    requestId: 'accept-rev', assignmentId: f.ids[0], offerId: offer.offerId,
    expectedOwnershipRevision: 0, expectedLedgerRevision: ledgerRevisionOf(f), expectedBriefRevision: 0,
    acknowledgment: 'Custody acknowledged.', settlementRef: null, resources: [],
  }, { store: f.store });
  assert.equal(accept.ok, true, JSON.stringify(accept));

  const after = await readReviews();
  const afterByReviewer = new Map(after.map(item => [item.row.reviewerAgentId, item]));
  // The new owner's own review stays immutable history but no longer
  // qualifies the current gate, so the recorded approval stops standing.
  assert.deepEqual(afterByReviewer.get('workflow-receiver').qualification,
    { eligible: false, discharging: false, standingApproval: false });
  assert.deepEqual(afterByReviewer.get('reviewer-a').qualification,
    { eligible: true, discharging: true, standingApproval: false });
  assert.equal(after.length, before.length, 'history is never rewritten');
  const fullPage = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0],
    page: { ...request().page, section: 'reviews', limit: 50 } }), f.sdk);
  const approvedTransition = fullPage.view.items
    .filter(item => item.kind === 'scopeTransition').find(item => item.row.to === 'approved');
  assert.ok(approvedTransition, 'the immutable approved transition remains visible');
});

test('a single item over the response budget returns a typed gap, never a clipped record', async t => {
  const f = await registered(t);
  const amend = await runAssignmentAmend({ repoKey: f.binding.repoKey, row: f.lead }, {
    requestId: 'brief-1', assignmentId: f.ids[0], expectedBriefRevision: 0,
    brief: operativeBrief('Outcome', 0), changeReason: 'Seed a brief for decisions',
    authorityRef: 'human:test', affectedOwners: [f.lead.agentId],
  }, { store: f.store });
  assert.equal(amend.ok, true, JSON.stringify(amend));
  const decision = await runDecisionAppend({ repoKey: f.binding.repoKey, row: f.lead }, {
    requestId: 'decision-large', assignmentId: f.ids[0], expectedBriefRevision: 1,
    authorityRef: 'human:test',
    decision: {
      proposition: 'Ship the bounded read', ruling: 'Proceed under the recorded grant',
      reason: 'Evidence is inspectable', supportingEvidenceRefs: Array.from({ length: 64 }, (_, i) => `ref:${i}:${'s'.repeat(1000)}`),
      contraryEvidenceRefs: [], unresolvedRisk: 'None declared', affectedBriefRevision: 1,
      affectedOwners: [f.lead.agentId], notificationRefs: [], outcomeRefs: [],
    },
  }, { store: f.store });
  assert.equal(decision.ok, true, JSON.stringify(decision));
  const result = await readWorkspaceWorkflow(request({ assignmentId: f.ids[0],
    page: { ...request().page, section: 'decisions', limit: 50 } }), f.sdk);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.problem.code, 'VIEW_TOO_LARGE');
  assert.equal(result.view, null);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
});
