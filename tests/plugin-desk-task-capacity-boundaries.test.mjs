import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { createDeskStore, deskRepoPaths, LEDGER_LIMITS } from '../plugin/server/desk-store.ts';
import { runAssignmentRegister, runAssignmentAttach } from '../plugin/server/desk-handback.ts';
import { runTaskCommand, runTaskEffect } from '../plugin/server/desk-task.ts';
import { memberRow, seedMemberships } from './helpers/desk-bridge-fixture.mjs';
import { resolveDeskTaskCapacityReserve } from '../plugin/server/desk-task-capacity.ts';
import { canonicalSha256, sha256Hex } from '../plugin/server/config-view.ts';
import { WIRE_LIMITS } from '../plugin/shared/enforcement.ts';

const AT = '2026-01-01T00:00:00.000Z';

// Saturation-boundary regressions for the frozen capacity semantics. The pads
// below write complete, valid v9 history straight into the ledger — every
// task-entry pad row carries the matching task-entry-appended event bound to a
// committed request — and the asserted operations run through the real
// runTaskCommand/runTaskEffect/transact paths so the store's post-state reserve
// check is what admits or refuses them.

async function boundaryFixture(t, { now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-cap-boundary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repository = join(dir, 'repo'); mkdirSync(repository);
  execFileSync('git', ['init', '-q', repository]);
  execFileSync('git', ['-C', repository, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const stableRoot = join(dir, 'home', 'slp-runtime'); mkdirSync(stableRoot, { recursive: true, mode: 0o700 });
  const store = createDeskStore({ stableRoot, ...(now === undefined ? {} : { now }) });
  const lead = memberRow('owner', { provider: 'slp-codex-lead', at: AT }, { role: 'lead', agentId: 'owner', createCwd: repository, workspaceId: null });
  const worker = memberRow('worker', { provider: 'slp-codex-peer', at: AT }, { agentId: 'worker', createCwd: repository, workspaceId: null });
  const successor = memberRow('next', { provider: 'slp-codex-lead', at: AT }, { role: 'lead', agentId: 'next', createCwd: repository, workspaceId: null });
  const repo = { hostId: 'local', gitCommonDir: realpathSync(join(repository, '.git')) };
  const repoKey = await seedMemberships(store, repo, [lead, worker, successor]);
  const ctx = { repoKey, row: lead };
  const workerCtx = { repoKey, row: worker };
  const deps = { store };
  const registration = await runAssignmentRegister(ctx, { requestId: 'register', authorityRef: 'human:fixture', objective: 'bounded task' }, { store });
  assert.equal(registration.ok, true, JSON.stringify(registration));
  const assignmentId = registration.assignmentId;
  const paths = deskRepoPaths(stableRoot, repoKey);
  const ledger = () => { const read = store.read(repoKey); assert.equal(read.state, 'ok', JSON.stringify(read)); return read.ledger; };
  const reserveVec = () => resolveDeskTaskCapacityReserve({
    taskEntries: ledger().taskEntries, memberships: ledger().memberships, assignments: ledger().assignments,
    scopes: ledger().scopes, scopeTransitions: ledger().scopeTransitions }, { eventPayloadBytes: LEDGER_LIMITS.eventPayloadBytes });
  const pins = (taskRevision = 1) => ({ expectedLedgerRevision: ledger().revision, expectedBriefRevision: 0, expectedOwnershipRevision: 0, expectedTaskRevision: taskRevision });
  const body = { state: 'open', outcome: 'artifact', objective: null, authorityRef: 'human:fixture', dependencies: [], scope: null,
    proofPolicy: { kind: 'declared', authorityRef: 'human:fixture', ruleRef: 'protocol:proof', reason: 'bounded artifact proof', requiredChecks: [], requiredEvidence: [], reviewRequired: false, availability: 'artifact', verificationRecipes: [] },
    grants: { create: 'grant:create', send: 'grant:send', archive: 'grant:archive', integrate: 'grant:integrate', commit: null },
    budgets: { maxAttempts: 3, maxActionsPerAttempt: 12 }, reason: null };
  const command = async input => runTaskCommand(ctx, { assignmentId, ...input }, deps);
  const effect = async input => runTaskEffect(ctx, input, deps);
  const define = async (id, extra = {}) => { const r = await command({ operation: 'define', requestId: `define-${id}`, taskId: id, ...pins(0), task: { ...body, ...extra } }); assert.equal(r.ok, true, JSON.stringify(r)); return id; };
  const reserve = async (id, extra = {}) => command({ operation: 'reserve', requestId: `reserve-${id}`, taskId: id, ...pins(), grantRef: 'grant:send', placement: { kind: 'shared-checkout', cwd: repository }, runtime: { optionId: 'fixture', catalogSha256: 'a'.repeat(64) }, seatPin: { provider: worker.provider, model: 'fixture', optionId: 'fixture', catalogSha256: 'a'.repeat(64) }, reuseTarget: { agentId: worker.agentId }, effectBudget: 12, ...extra });
  const measuredBase = { root: repository, snapshotSha256: 'b'.repeat(64), head: null, kind: 'git-snapshot', measuredAt: AT, incomplete: [], artifactSha256: null };

  // --- valid-history pads -------------------------------------------------
  const diskLedger = () => JSON.parse(readFileSync(paths.ledgerPath, 'utf8'));
  const commitDisk = (disk, label) => {
    writeFileSync(paths.ledgerPath, JSON.stringify(disk) + '\n', { mode: 0o600 });
    const read = store.read(repoKey);
    assert.equal(read.state, 'ok', `${label} pad corrupted the ledger: ${JSON.stringify(read.diagnostics)}`);
  };
  let padNonce = 0;
  // One committed pad request covers the events of one pad batch.
  const pushPadRequest = (disk, requestId, firstSeq, lastSeq) => {
    disk.requests.push({ actorKey: `agent:${lead.agentId}`, assignmentId, requestId, bodySha256: 'a'.repeat(64),
      canonicalization: 'slp-canonical-json/1', receiptId: randomUUID(), revision: disk.revision + 1,
      outcome: 'committed', eventSeqs: [firstSeq, lastSeq], rejection: null });
    disk.revision += 1;
  };
  const appendPadEvents = (disk, requestId, rows) => {
    let seq = disk.lastEventSeq, prev = disk.lastEventSha256;
    const built = rows.map(row => {
      seq += 1;
      const ev = { seq, prevSha256: prev, at: AT, requestId, actorKey: `agent:${lead.agentId}`, assignmentId,
        kind: 'task-entry-appended',
        payload: { entryId: row.entryId, entityId: row.entityId, entryKind: row.kind, revision: row.revision,
          entrySha256: row.entrySha256, taskId: row.taskId, actorMembershipId: row.actorMembershipId,
          briefRevision: row.briefRevision, ownershipRevision: row.ownershipRevision } };
      ev.sha256 = canonicalSha256(ev); prev = ev.sha256; return ev;
    });
    writeFileSync(join(paths.eventsDir, `${built[0].seq}-${built.at(-1).seq}.jsonl`), built.map(e => JSON.stringify(e)).join('\n') + '\n');
    disk.lastEventSeq = seq; disk.lastEventSha256 = prev;
    pushPadRequest(disk, requestId, built[0].seq, built.at(-1).seq);
  };
  const stampEntry = (kind, fields) => {
    const id = `pad-${kind}-${padNonce++}`;
    const row = { entryId: id, entityId: id, kind, assignmentId, taskId: null, revision: 1,
      priorEntryId: null, priorEntrySha256: null, requestId: `pad-req-${padNonce}`,
      actorAgentId: lead.agentId, actorMembershipId: lead.membershipId, ownershipRevision: 0, briefRevision: 0, ...fields };
    return { ...row, entrySha256: canonicalSha256(row) };
  };
  const controlRow = () => { const row = stampEntry('control', { targetTaskId: null, targetAttemptId: null,
    state: 'stop-requested', reason: 'pad', outstandingActionIds: [], outstandingResourceIds: [] });
    row.controlId = row.entityId; delete row.entrySha256; row.entrySha256 = canonicalSha256(row); return row; };
  const deliveryFields = state => ({ deliveryKind: 'brief',
    senderAgentId: lead.agentId, senderMembershipId: lead.membershipId, recipientAgentId: worker.agentId, recipientMembershipId: worker.membershipId,
    bodySha256: null, bodyRef: null, actionId: null, attemptId: null, resultId: null, state, ackEvidence: [],
    handlingEvidence: state === 'handled' ? ['ev:handled'] : null,
    reason: state === 'handled' ? 'x'.repeat(30_000) : null });
  const pendingDeliveryRow = () => { const row = stampEntry('delivery', deliveryFields('pending'));
    row.deliveryId = row.entityId; delete row.entrySha256; row.entrySha256 = canonicalSha256(row); return row; };
  const fatHandledDeliveryRow = () => { const row = stampEntry('delivery', deliveryFields('handled'));
    row.deliveryId = row.entityId; delete row.entrySha256; row.entrySha256 = canonicalSha256(row); return row; };
  const retainedResourceRow = () => { const row = stampEntry('resource', { resourceKind: 'artifact', resourceKey: `out-${padNonce}`,
    ownerAgentId: lead.agentId, ownerMembershipId: lead.membershipId, attemptId: null, actionId: null,
    disposition: 'retained', observedState: null, observedVia: null, obligations: [], releaseRuling: null });
    row.resourceId = row.entityId; delete row.entrySha256; row.entrySha256 = canonicalSha256(row); return row; };
  // Pad taskEntries one committed batch at a time; every batch keeps the
  // ledger readable under the real history validator.
  const padTaskEntries = (makeRow, count) => {
    const disk = diskLedger();
    const made = [];
    // Chunk by the per-commit event bound: each committed pad request covers
    // at most 64 task-entry-appended events.
    for (let i = 0; i < count; i += LEDGER_LIMITS.eventsPerCommit) {
      const rows = Array.from({ length: Math.min(LEDGER_LIMITS.eventsPerCommit, count - i) }, () => makeRow());
      // requestId must equal the covering request row's requestId and the
      // digest must cover the final row bytes.
      const requestId = `pad-req-${padNonce++}`;
      for (const row of rows) {
        row.requestId = requestId;
        delete row.entrySha256;
        row.entrySha256 = canonicalSha256(row);
      }
      disk.taskEntries.push(...rows);
      appendPadEvents(disk, requestId, rows);
      made.push(...rows);
    }
    commitDisk(disk, 'taskEntries');
    return made;
  };
  // Pad request table with immutable rejected rows (no events — same shape the
  // existing capacity test uses for legacy commit history).
  const padRequests = count => {
    const disk = diskLedger();
    for (let i = 0; i < count; i++) {
      const n = disk.requests.length + 1;
      disk.requests.push({ actorKey: 'fixture:legacy', assignmentId: 'fixture', requestId: `pad-req-${n}`,
        bodySha256: 'a'.repeat(64), canonicalization: 'slp-canonical-json/1',
        receiptId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, revision: n, outcome: 'rejected',
        eventSeqs: null, rejection: { ok: false, code: 'INVALID_RECORD', message: 'fixture saturation', recovery: 'fixture' } });
    }
    disk.revision += count;
    commitDisk(disk, 'requests');
  };
  // Exempt scope rows: briefRevision 0 + ownership null + reviewPlan null need
  // no event binding. An open (transition-less) scope still costs one
  // terminal-transition credit and one aux-row byte credit in the reserve.
  const padOpenScope = label => {
    const disk = diskLedger();
    const scopeId = `scp-pad-${padNonce++}`;
    disk.scopes.push({ assignmentId, scopeId, requestId: `pad-req-${padNonce}`, revision: 1, priorRevision: null,
      ownerMembershipId: lead.membershipId, ownerAgentId: lead.agentId, assignmentRevision: 1,
      seatAgentId: null, label, declarationSha256: sha256Hex(`decl-${scopeId}`), refs: [],
      briefRevision: 0, ownership: null, reviewPlan: null });
    commitDisk(disk, 'scope');
    return scopeId;
  };
  // Exempt transition rows (briefRevision 0 + mandateSha256 null + legacy-axis
  // discharged). declare→claim→submit-for-review self-loop stays legal and
  // non-gated, so the pad scope remains open.
  const padTransitions = (scopeId, count) => {
    const disk = diskLedger();
    let revision = disk.scopeTransitions.filter(r => r.scopeId === scopeId).length;
    for (let i = 0; i < count; i++) {
      revision += 1;
      const command = revision === 1 ? 'declare' : revision === 2 ? 'claim' : 'submit-for-review';
      const from = revision === 1 ? null : revision === 2 ? 'declared' : revision === 3 ? 'claimed' : 'submitted-for-review';
      const to = revision === 1 ? 'declared' : revision === 2 ? 'claimed' : 'submitted-for-review';
      disk.scopeTransitions.push({ transitionId: `stn-${scopeId}-${revision}`, assignmentId, scopeId,
        requestId: `pad-req-${padNonce++}`, revision, command, from, to, scopeRevision: 1,
        candidateSnapshot: command === 'submit-for-review' ? 'c'.repeat(64) : null, candidateHead: null,
        discharged: [], actorAgentId: lead.agentId, briefRevision: 0, mandateSha256: null });
    }
    commitDisk(disk, 'scopeTransitions');
  };
  const fileBytes = () => readFileSync(paths.ledgerPath).byteLength;
  // The store's byte check serializes the candidate as
  // JSON.stringify(ledger, null, 2) + '\n' (desk-store.ts ~line 3805), so the
  // canonical committed size is computed from the parsed ledger — the
  // minified pad-file byte count is NOT the checked size.
  const canonicalOf = disk => Buffer.byteLength(JSON.stringify(disk, null, 2) + '\n');
  const canonicalBytes = () => canonicalOf(diskLedger());
  const entryReserveSum = () => { const l = ledger(); return l.taskEntries.length + reserveVec().taskEntries; };
  const requestReserveSum = () => { const l = ledger(); return l.requests.length + reserveVec().requests; };
  const transitionReserveSum = () => { const l = ledger(); return l.scopeTransitions.length + reserveVec().scopeTransitions; };
  const byteSlack = () => LEDGER_LIMITS.ledgerBytes - (canonicalBytes() + reserveVec().bytes);
  const padToEntrySum = target => {
    const deficit = target - entryReserveSum();
    assert.ok(deficit >= 0, `entry reserve sum already above target: ${entryReserveSum()} > ${target}`);
    if (deficit > 0) padTaskEntries(controlRow, deficit);
    assert.equal(entryReserveSum(), target);
  };
  const fatRowWithReason = len => {
    const row = fatHandledDeliveryRow();
    row.reason = 'x'.repeat(len);
    delete row.entrySha256; row.entrySha256 = canonicalSha256(row);
    return row;
  };
  // Pad the serialized ledger with valid handled-delivery rows until the
  // canonical slack (cap − canonical bytes − reserve.bytes) reaches
  // targetSlack exactly. The final rows' ASCII reason lengths are tuned
  // BEFORE their digests and event bindings so the next-state serialization
  // lands byte-exact; every row stays under the 32 KB per-entry wire budget.
  const padDeliveriesToSlack = (targetSlack = 0) => {
    while (byteSlack() > targetSlack + 45_000) {
      const n = Math.min(LEDGER_LIMITS.eventsPerCommit, Math.floor((byteSlack() - targetSlack - 45_000) / 33_000));
      if (n <= 0) break;
      padTaskEntries(fatHandledDeliveryRow, n);
    }
    for (let guard = 0; guard < 12 && byteSlack() !== targetSlack; guard++) {
      const disk = diskLedger();
      const requestId = `pad-req-${padNonce}`;
      const probe = fatRowWithReason(1); probe.requestId = requestId;
      delete probe.entrySha256; probe.entrySha256 = canonicalSha256(probe);
      const model = JSON.parse(JSON.stringify(disk));
      model.taskEntries.push(probe);
      pushPadRequest(model, requestId, disk.lastEventSeq + 1, disk.lastEventSeq + 1);
      const cost1 = canonicalOf(model) - canonicalOf(disk);
      let reasonLen = byteSlack() - targetSlack - cost1 + 1;
      assert.ok(reasonLen >= 1, `byte deadzone: slack ${byteSlack() - targetSlack} below one tuned row cost ${cost1}`);
      // Clamp to the 32 KB wire budget while always leaving room for a final
      // tuned row, so the loop can never strand a sub-row slack.
      if (reasonLen > 30_000) reasonLen = Math.min(30_000, byteSlack() - targetSlack - 2 * cost1 - 49);
      padTaskEntries(() => fatRowWithReason(reasonLen), 1);
    }
    assert.equal(byteSlack(), targetSlack, `canonical slack ${byteSlack()} did not reach ${targetSlack}`);
  };
  const padOpenScopes = (count, prefix) => {
    const disk = diskLedger();
    for (let i = 0; i < count; i++) {
      const scopeId = `scp-pad-${padNonce++}`;
      disk.scopes.push({ assignmentId, scopeId, requestId: `pad-req-${padNonce}`, revision: 1, priorRevision: null,
        ownerMembershipId: lead.membershipId, ownerAgentId: lead.agentId, assignmentRevision: 1,
        seatAgentId: null, label: `${prefix} ${i}`, declarationSha256: sha256Hex(`decl-${scopeId}`), refs: [],
        briefRevision: 0, ownership: null, reviewPlan: null });
    }
    commitDisk(disk, 'scopes');
  };
  // Smallest VALID closed scope history: 1 scope + 1 candidate + 2 axis
  // reviews + 6 transitions (declare→claim→submit-for-review→
  // review-observed→approve→close). A task-cancel shortcut cannot pad a
  // closed scope: history validation requires its taskCancellation pin to
  // resolve against a real stopped attempt, a stop-observed control row and
  // a bound scope-transitioned event (desk-task-history.ts ~line 752).
  const closedScopeRows = tag => {
    const n = padNonce++;
    const scopeId = `scp-closed-${tag}-${n}`;
    const scope = { assignmentId, scopeId, requestId: `pad-req-${n}`, revision: 1, priorRevision: null,
      ownerMembershipId: lead.membershipId, ownerAgentId: lead.agentId, assignmentRevision: 1,
      seatAgentId: null, label: `closed ${tag} ${n}`, declarationSha256: sha256Hex(`decl-${scopeId}`), refs: [],
      briefRevision: 0, ownership: null, reviewPlan: null };
    const reviews = ['spec', 'standards'].map(axis => ({ reviewId: `rev-${scopeId}-${axis}`, assignmentId, scopeId,
      requestId: `rev-req-${scopeId}-${axis}`, revision: 1, scopeRevision: 1, candidateSnapshot: 'c'.repeat(64), axis, verdict: 'approve',
      reviewerAgentId: worker.agentId, reviewerSeatId: worker.membershipId, findingsRef: null, lensId: null,
      briefRevision: 0, mandateSha256: null }));
    const axes = reviews.map(row => ({ axis: row.axis, reviewId: row.reviewId }));
    const T = (revision, command, from, to, discharged = []) => ({ transitionId: `stn-${scopeId}-${revision}`,
      assignmentId, scopeId, requestId: `t-req-${scopeId}-${revision}`, revision, command, from, to, scopeRevision: 1,
      candidateSnapshot: command === 'submit-for-review' ? 'c'.repeat(64) : null, candidateHead: null,
      discharged, actorAgentId: lead.agentId, briefRevision: 0, mandateSha256: null });
    const transitions = [T(1, 'declare', null, 'declared'), T(2, 'claim', 'declared', 'claimed'),
      T(3, 'submit-for-review', 'claimed', 'submitted-for-review'),
      T(4, 'review-observed', 'submitted-for-review', 'review-observed', axes),
      T(5, 'approve', 'review-observed', 'approved', axes), T(6, 'close', 'approved', 'closed', axes)];
    return { scope, reviews, transitions };
  };
  const padClosedScopes = (count, tag) => {
    const disk = diskLedger();
    if (!disk.candidates.some(row => row.candidateId === 'cand-pad')) {
      disk.candidates.push({ candidateId: 'cand-pad', assignmentId, kind: 'observed',
        seatAgentId: worker.agentId, seatMembershipId: worker.membershipId, repository,
        snapshotSha256: 'c'.repeat(64), head: null, incomplete: [], measuredAt: AT });
    }
    for (let i = 0; i < count; i++) {
      const { scope, reviews, transitions } = closedScopeRows(tag);
      disk.scopes.push(scope); disk.scopeReviews.push(...reviews); disk.scopeTransitions.push(...transitions);
    }
    commitDisk(disk, 'closed-scopes');
  };
  // Declaration revisions of ONE open legacy scope pad the scopes TABLE —
  // the cap counts every revision row, not distinct scopeIds. Later
  // revisions amend provenance only (desk-scope.ts ~line 585): contiguous
  // 1..N lineage, priorRevision links, unique request keys, no transitions,
  // no events (legacy-exempt rows).
  const padScopeRevisions = (count, tag) => {
    const disk = diskLedger();
    const scopeId = `scp-rev-${tag}-${padNonce++}`;
    for (let revision = 1; revision <= count; revision++) {
      disk.scopes.push({ assignmentId, scopeId, requestId: `pad-req-${padNonce++}`, revision,
        priorRevision: revision === 1 ? null : revision - 1,
        ownerMembershipId: lead.membershipId, ownerAgentId: lead.agentId, assignmentRevision: 1,
        seatAgentId: null, label: `${tag} rev ${revision}`, declarationSha256: sha256Hex(`decl-${scopeId}-${revision}`), refs: [],
        briefRevision: 0, ownership: null, reviewPlan: null });
    }
    commitDisk(disk, 'scope-revisions');
    return scopeId;
  };
  const issuePlace = async (reserved, tag) => {
    const issued = await effect({ operation: 'issue', requestId: `place-issue-${tag}`, attemptId: reserved.attemptId, actionId: reserved.next.actionId });
    assert.equal(issued.perform, true, JSON.stringify(issued));
    return issued;
  };
  const observePlace = (reserved, tag, cwd = repository) =>
    effect({ operation: 'observe', requestId: `place-observe-${tag}`, attemptId: reserved.attemptId, actionId: reserved.next.actionId, actionKind: 'place', receipt: { status: 'observed', cwd, base: measuredBase } });
  const stopAttempt = (reserved, taskId, tag) => command({ operation: 'stop', requestId: `stop-${tag}`, taskId, attemptId: reserved.attemptId, ...pins(), reason: `stop ${tag}` });
  const settleAttempt = (reserved, tag, extra = {}) => {
    const attempt = ledger().taskEntries.filter(r => r.kind === 'attempt' && r.attemptId === reserved.attemptId).at(-1);
    return command({ operation: 'reconcile', requestId: `settle-${tag}`, attemptIds: [reserved.attemptId], actionIds: [], resourceIds: [], observationTypes: [],
      attemptRulings: [{ attemptId: reserved.attemptId, expectedAttemptRevision: attempt.revision, disposition: 'stopped', reason: 'terminal settle', evidence: ['ledger:stop'] }], ...extra });
  };
  const unfundedAppend = async (tag, rows) => {
    const requestId = `unfunded-${tag}`;
    for (const row of rows) { row.requestId = requestId; delete row.entrySha256; row.entrySha256 = canonicalSha256(row); }
    return store.transact(repoKey,
      { repo, actorKey: `agent:${lead.agentId}`, assignmentId, requestId, command: { kind: 'fixture-append' } },
      l => ({ ok: true, events: rows.map(row => ({ kind: 'task-entry-appended', payload: { entryId: row.entryId, entityId: row.entityId, entryKind: row.kind, revision: row.revision, entrySha256: row.entrySha256, taskId: row.taskId, actorMembershipId: row.actorMembershipId, briefRevision: row.briefRevision, ownershipRevision: row.ownershipRevision } })), taskEntries: [...l.taskEntries, ...rows] }));
  };

  return { dir, repository, stableRoot, store, lead, worker, successor, repo, repoKey, ctx, workerCtx, deps,
    assignmentId, paths, ledger, reserveVec, pins, body, command, effect, define, reserve, measuredBase,
    diskLedger, commitDisk, padTaskEntries, padRequests, padOpenScope, padOpenScopes, padClosedScopes, closedScopeRows, padScopeRevisions, padTransitions, controlRow, pendingDeliveryRow,
    fatHandledDeliveryRow, retainedResourceRow, fileBytes, canonicalBytes, entryReserveSum, requestReserveSum, transitionReserveSum,
    byteSlack, padToEntrySum, padDeliveriesToSlack, issuePlace, observePlace, stopAttempt, settleAttempt, unfundedAppend };
}

test('issued shared place observation commits at the exact task-entry boundary, then stop and terminal settlement remain possible', async t => {
  const f = await boundaryFixture(t);
  await f.define('A');
  const reserved = await f.reserve('A');
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await f.issuePlace(reserved, 'a');
  // Loose assignment obligations that the reserve already accounts for: one
  // pending delivery (+2 rows) and one retained resource (+1 row), seeded with
  // valid event/request bindings.
  f.padTaskEntries(() => f.pendingDeliveryRow(), 1);
  f.padTaskEntries(() => f.retainedResourceRow(), 1);
  f.padToEntrySum(LEDGER_LIMITS.taskEntries);
  assert.equal(f.entryReserveSum(), LEDGER_LIMITS.taskEntries);
  // The boundary is real: an unrelated one-row append no longer fits.
  const before = readFileSync(f.paths.ledgerPath);
  const refused = await f.unfundedAppend('entry-boundary', [f.controlRow()]);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /recovery capacity/);
  assert.deepEqual(readFileSync(f.paths.ledgerPath), before);
  // Frozen claim: at this exact boundary the issued place observation commits
  // both its action and attempt rows.
  const observed = await f.observePlace(reserved, 'a');
  assert.equal(observed.ok, true, `place observe at the exact boundary must commit: ${JSON.stringify(observed)}`);
  const stop = await f.stopAttempt(reserved, 'A', 'a');
  assert.equal(stop.ok, true, `stop after boundary observation must commit: ${JSON.stringify(stop)}`);
  const settle = await f.settleAttempt(reserved, 'a');
  assert.equal(settle.ok, true, `terminal settlement must commit: ${JSON.stringify(settle)}`);
  const attempt = f.ledger().taskEntries.filter(r => r.kind === 'attempt' && r.attemptId === reserved.attemptId).at(-1);
  assert.equal(attempt.state, 'stopped');
  assert.equal(f.ledger().taskEntries.length <= LEDGER_LIMITS.taskEntries, true);
});

test('the last admissible entry index below the boundary still lands observe, loose-commitment edges, stop and settle', async t => {
  const f = await boundaryFixture(t);
  await f.define('A');
  const reserved = await f.reserve('A');
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await f.issuePlace(reserved, 'b');
  const [delivery] = f.padTaskEntries(() => f.pendingDeliveryRow(), 1);
  f.padToEntrySum(LEDGER_LIMITS.taskEntries - 1);
  // A loose-commitment edge consumes its own reserved credit at the boundary:
  // acknowledging the pending delivery writes one row and frees one credit.
  const ack = await runTaskCommand(f.workerCtx, { operation: 'acknowledge', assignmentId: f.assignmentId,
    requestId: 'ack-loose-delivery', deliveryId: delivery.deliveryId,
    expectedLedgerRevision: f.ledger().revision, expectedBriefRevision: 0, expectedOwnershipRevision: 0,
    acknowledgment: 'responsibility-acknowledged', reason: 'worker sees it' }, f.deps);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(f.entryReserveSum(), LEDGER_LIMITS.taskEntries - 1, 'the acknowledged delivery edge is reserve-conserving');
  const observed = await f.observePlace(reserved, 'b');
  assert.equal(observed.ok, true, JSON.stringify(observed));
  const postObserve = f.entryReserveSum();
  t.diagnostic(`boundary-1 observe: entryReserveSum ${LEDGER_LIMITS.taskEntries - 1} -> ${postObserve}`);
  assert.ok(postObserve <= LEDGER_LIMITS.taskEntries, 'observation stays under the cap');
  assert.ok(postObserve <= LEDGER_LIMITS.taskEntries - 1, 'the observed receipt is exactly funded — the post-state reserve sum never exceeds the pre-observation sum');
  const stop = await f.stopAttempt(reserved, 'A', 'b');
  assert.equal(stop.ok, true, JSON.stringify(stop));
  const settle = await f.settleAttempt(reserved, 'b');
  assert.equal(settle.ok, true, JSON.stringify(settle));
  assert.equal(f.ledger().taskEntries.filter(r => r.kind === 'attempt' && r.attemptId === reserved.attemptId).at(-1).state, 'stopped');
});

test('request-table boundary: rejected and legacy commits consume no reserved request slots while observe, stop and settle stay funded', async t => {
  const f = await boundaryFixture(t);
  await f.define('A');
  const reserved = await f.reserve('A');
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await f.issuePlace(reserved, 'c');
  f.padRequests(LEDGER_LIMITS.requests - f.ledger().requests.length - f.reserveVec().requests);
  assert.equal(f.requestReserveSum(), LEDGER_LIMITS.requests);
  const before = readFileSync(f.paths.ledgerPath);
  const requestsBefore = f.ledger().requests.length;
  // A decide-level rejection is refused at the guard before any row lands.
  const rejected = await f.store.transact(f.repoKey,
    { repo: f.repo, actorKey: 'fixture:legacy', assignmentId: 'fixture', requestId: 'legacy-boundary', command: { kind: 'legacy' } },
    () => ({ ok: false, code: 'INVALID_RECORD', message: 'legacy rejects', recovery: 'fixture' }));
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /recovery capacity/);
  assert.deepEqual(readFileSync(f.paths.ledgerPath), before);
  assert.equal(f.ledger().requests.length, requestsBefore, 'a refused commit appends no request row');
  // The issued place observation spends exactly its own request credit.
  const observed = await f.observePlace(reserved, 'c');
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(f.requestReserveSum(), LEDGER_LIMITS.requests, 'observe is request-conserving at the boundary');
  const stop = await f.stopAttempt(reserved, 'A', 'c');
  assert.equal(stop.ok, true, JSON.stringify(stop));
  const settle = await f.settleAttempt(reserved, 'c');
  assert.equal(settle.ok, true, JSON.stringify(settle));
  assert.equal(f.ledger().taskEntries.filter(r => r.kind === 'attempt' && r.attemptId === reserved.attemptId).at(-1).state, 'stopped');
});

test('issued isolated place observation commits at the exact task-entry boundary and releases the worktree at settlement', async t => {
  const f = await boundaryFixture(t);
  const worktree = join(f.dir, 'wt');
  execFileSync('git', ['-C', f.repository, 'worktree', 'add', '-q', worktree, 'HEAD']);
  await f.define('A');
  const reserved = await f.reserve('A', { placement: { kind: 'isolated', cwd: worktree } });
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await f.issuePlace(reserved, 'd');
  f.padToEntrySum(LEDGER_LIMITS.taskEntries);
  // Isolated observation writes action + attempt + worktree-resource rows; the
  // issued place credit must cover the whole write at the exact boundary.
  const observed = await f.observePlace(reserved, 'd', worktree);
  assert.equal(observed.ok, true, `isolated place observe at the exact boundary must commit: ${JSON.stringify(observed)}`);
  const stop = await f.stopAttempt(reserved, 'A', 'd');
  assert.equal(stop.ok, true, JSON.stringify(stop));
  const worktreeResource = f.ledger().taskEntries.filter(r => r.kind === 'resource' && r.resourceKind === 'worktree').at(-1);
  assert.ok(worktreeResource, 'isolated observation records the worktree resource');
  f.deps.observe = { observeResources: async req => ({ results: req.resources.map(r => ({ resourceId: r.resourceId, kind: r.kind, positive: true, quiescent: true, evidence: [{ kind: 'fixture', ref: 'removed' }] })) }) };
  const settle = await f.settleAttempt(reserved, 'd', {
    resourceIds: [worktreeResource.resourceId],
    observationTypes: ['resources'],
    releaseRulings: [{ resourceId: worktreeResource.resourceId, expectedResourceRevision: worktreeResource.revision, reason: 'release worktree', evidence: ['fixture:removed'] }] });
  assert.equal(settle.ok, true, JSON.stringify(settle));
  assert.equal(f.ledger().taskEntries.filter(r => r.kind === 'attempt' && r.attemptId === reserved.attemptId).at(-1).state, 'stopped');
});

test('serialized-ledger-byte boundary: an issued place receipt commits at the exact canonical byte edge, then stop and settle land', async t => {
  const f = await boundaryFixture(t);
  await f.define('A');
  const reserved = await f.reserve('A');
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await f.issuePlace(reserved, 'e');
  // Pad serialized bytes with valid 'handled' delivery rows until the
  // CANONICAL byte sum — byteLength(JSON.stringify(ledger,null,2)+'\n') +
  // reserve.bytes — equals the cap exactly.
  f.padDeliveriesToSlack(0);
  assert.equal(f.canonicalBytes() + f.reserveVec().bytes, LEDGER_LIMITS.ledgerBytes,
    'exact canonical byte boundary: serialized bytes + byte reserve = cap');
  const before = readFileSync(f.paths.ledgerPath);
  // Any unfunded commit — even a single small row — is one byte over.
  const refused = await f.unfundedAppend('byte-boundary', [f.controlRow()]);
  assert.equal(refused.ok, false, 'a one-row append must refuse at the exact byte boundary');
  assert.match(refused.message, /recovery reserve|recovery capacity|byte cap|over the/i);
  assert.deepEqual(readFileSync(f.paths.ledgerPath), before);
  // The issued place observation is funded: its reserved byte credit covers
  // the receipt rows, so the commit lands and the sum never exceeds the cap.
  const observed = await f.observePlace(reserved, 'e');
  assert.equal(observed.ok, true, `observe must commit at the exact byte boundary: ${JSON.stringify(observed)}`);
  t.diagnostic(`post-observe canonical slack: ${f.byteSlack()} bytes`);
  const stop = await f.stopAttempt(reserved, 'A', 'e');
  assert.equal(stop.ok, true, `stop at the byte boundary must commit: ${JSON.stringify(stop)}`);
  const settle = await f.settleAttempt(reserved, 'e');
  assert.equal(settle.ok, true, `settle at the byte boundary must commit: ${JSON.stringify(settle)}`);
  assert.equal(f.ledger().taskEntries.filter(r => r.kind === 'attempt' && r.attemptId === reserved.attemptId).at(-1).state, 'stopped');
  assert.ok(f.canonicalBytes() + f.reserveVec().bytes <= LEDGER_LIMITS.ledgerBytes,
    'final used+reserved must stay under the cap');
});

test('scope-transition boundary: the terminal task-cancel edge lands on the last reserved transition slot', async t => {
  const f = await boundaryFixture(t);
  await runAssignmentAttach(f.ctx, { requestId: 'attach-worker', assignmentId: f.assignmentId, agentId: f.worker.agentId }, f.deps);
  const taskScope = { label: 'claimed writer', refs: ['grant:scope'], ownership: { writerAgentId: f.worker.agentId, writerAuthorityRef: null,
    paths: ['src/core'], resources: [], stateOwners: [], dependsOnScopeIds: [], notifications: [] },
    reviewPlan: { kind: 'not-required', authorityRef: 'human:fixture', ruleRef: 'protocol:proof', reason: 'bounded test scope', lenses: [], exemptionClass: null } };
  await f.define('A', { scope: taskScope });
  const reserved = await f.reserve('A');
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await f.issuePlace(reserved, 'f');
  const observed = await f.observePlace(reserved, 'f');
  assert.equal(observed.ok, true, JSON.stringify(observed));
  const bound = await f.effect({ operation: 'bind', requestId: 'bind-f', attemptId: reserved.attemptId,
    member: { agentId: f.worker.agentId, membershipId: f.worker.membershipId },
    observed: { provider: f.worker.provider, createCwd: f.repository, workspaceId: null } });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const boundScopeId = f.ledger().taskEntries.filter(r => r.kind === 'attempt' && r.attemptId === reserved.attemptId).at(-1).boundScopeId;
  assert.ok(boundScopeId);
  // Candidate row that pad submit-for-review transitions reference.
  const disk = f.diskLedger();
  disk.candidates.push({ candidateId: 'cand-pad', assignmentId: f.assignmentId, kind: 'observed',
    seatAgentId: f.worker.agentId, seatMembershipId: f.worker.membershipId, repository: f.repository,
    snapshotSha256: 'c'.repeat(64), head: null, incomplete: [], measuredAt: AT });
  f.commitDisk(disk, 'candidate');
  const padScope = f.padOpenScope('pad transition scope');
  f.padTransitions(padScope, 3); // declare, claim, submit — scope stays open (1 credit)
  const target = LEDGER_LIMITS.scopeTransitions - f.transitionReserveSum();
  f.padTransitions(padScope, target);
  assert.equal(f.transitionReserveSum(), LEDGER_LIMITS.scopeTransitions);
  const before = readFileSync(f.paths.ledgerPath);
  // An unrelated one-transition append no longer fits.
  const refusePad = f.diskLedger();
  const padScopeRevision = refusePad.scopeTransitions.filter(r => r.scopeId === padScope).length + 1;
  refusePad.scopeTransitions.push({ transitionId: `stn-${padScope}-x`, assignmentId: f.assignmentId, scopeId: padScope,
    requestId: 'pad-overflow', revision: padScopeRevision, command: 'submit-for-review', from: 'submitted-for-review', to: 'submitted-for-review',
    scopeRevision: 1, candidateSnapshot: 'c'.repeat(64), candidateHead: null, discharged: [], actorAgentId: f.lead.agentId,
    briefRevision: 0, mandateSha256: null });
  const refused = await f.store.transact(f.repoKey,
    { repo: f.repo, actorKey: `agent:${f.lead.agentId}`, assignmentId: f.assignmentId, requestId: 'transition-overflow', command: { kind: 'fixture-transition' } },
    l => ({ ok: true, events: [], scopeTransitions: [...l.scopeTransitions, refusePad.scopeTransitions.at(-1)] }));
  assert.equal(refused.ok, false);
  assert.match(refused.message, /recovery capacity/);
  assert.deepEqual(readFileSync(f.paths.ledgerPath), before);
  const stop = await f.stopAttempt(reserved, 'A', 'f');
  assert.equal(stop.ok, true, JSON.stringify(stop));
  // The atomic bind records retained resources; release them so terminal
  // settlement has no outstanding obligations.
  const boundResources = f.ledger().taskEntries.filter(r => r.kind === 'resource' && r.attemptId === reserved.attemptId && r.disposition === 'retained');
  f.deps.observe = { observeResources: async req => ({ results: req.resources.map(r => ({ resourceId: r.resourceId, kind: r.kind, positive: true, quiescent: true, evidence: [{ kind: 'fixture', ref: 'released' }] })) }) };
  const settle = await f.settleAttempt(reserved, 'f', {
    resourceIds: boundResources.map(r => r.resourceId),
    observationTypes: ['resources'],
    releaseRulings: boundResources.map(r => ({ resourceId: r.resourceId, expectedResourceRevision: r.revision, reason: 'release', evidence: ['fixture:released'] })) });
  assert.equal(settle.ok, true, `terminal settle must commit its task-cancel transition on the last reserved slot: ${JSON.stringify(settle)}`);
  assert.equal(f.ledger().scopeTransitions.filter(r => r.scopeId === boundScopeId).at(-1).to, 'closed');
  assert.equal(f.ledger().taskEntries.filter(r => r.kind === 'attempt' && r.attemptId === reserved.attemptId).at(-1).state, 'stopped');
});

test('decide-level event bounds: >64 events per commit and >16 KB payloads refuse without consuming request slots', async t => {
  const f = await boundaryFixture(t);
  await f.define('A');
  const many = Array.from({ length: LEDGER_LIMITS.eventsPerCommit + 1 }, (_, i) => ({ kind: 'fixture-note', payload: { i } }));
  const tooMany = await f.store.transact(f.repoKey,
    { repo: f.repo, actorKey: `agent:${f.lead.agentId}`, assignmentId: f.assignmentId, requestId: 'too-many-events', command: { kind: 'fixture' } },
    () => ({ ok: true, events: many, taskEntries: f.ledger().taskEntries }));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /event bound/);
  const fatPayload = [{ kind: 'fixture-note', payload: { blob: 'x'.repeat(LEDGER_LIMITS.eventPayloadBytes) } }];
  const tooFat = await f.store.transact(f.repoKey,
    { repo: f.repo, actorKey: `agent:${f.lead.agentId}`, assignmentId: f.assignmentId, requestId: 'too-fat-event', command: { kind: 'fixture' } },
    () => ({ ok: true, events: fatPayload, taskEntries: f.ledger().taskEntries }));
  assert.equal(tooFat.ok, false);
  assert.match(tooFat.message, /payload exceeds/);
  assert.equal(f.store.read(f.repoKey).state, 'ok');
});

test('membership boundary: an unrelated mint cannot spend the one membership slot an issued new-seat create reserves', async t => {
  const f = await boundaryFixture(t);
  await f.define('A');
  const runtime = { optionId: 'fixture', catalogSha256: 'a'.repeat(64) };
  const seatPin = { provider: 'slp-codex-peer', model: 'fixture', optionId: 'fixture', catalogSha256: 'a'.repeat(64) };
  const reserved = await f.reserve('A', { grantRef: 'grant:create', runtime, seatPin, reuseTarget: 'new' });
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await f.issuePlace(reserved, 'g');
  const observed = await f.observePlace(reserved, 'g');
  assert.equal(observed.ok, true, JSON.stringify(observed));
  const idempotencyKey = 'task-create-idempotency';
  const hostRequestId = 'task-create-host-request';
  const createTicket = randomBytes(32).toString('hex');
  const publicInput = { phase: 'bootstrap', requestId: 'public-bootstrap-claim', assignmentId: f.assignmentId, taskId: 'A', attemptId: null,
    expectedLedgerRevision: f.ledger().revision, expectedBriefRevision: 0, expectedOwnershipRevision: 0, expectedTaskRevision: 1,
    expectedAttemptRevision: 0, grantRef: 'grant:create', runtime, placement: { kind: 'shared-checkout', cwd: f.repository }, effectBudget: 8 };
  const labels = { 'slp.repo': f.repoKey, 'slp.assignment': f.assignmentId, 'slp.task': 'A', 'slp.attempt': reserved.attemptId };
  const createIntent = await f.effect({ operation: 'intent', requestId: 'create-claim-intent', attemptId: reserved.attemptId, actionKind: 'create', body: {
    runtime, seat: seatPin, placement: { cwd: f.repository, kind: 'shared-checkout' }, idempotencyKey, hostRequestId,
    labels, parent: f.lead.agentId, grantRef: 'grant:create', resourceIntents: ['agent-archive', 'membership'],
    createTicketSha256: sha256Hex(createTicket), publicRequestId: publicInput.requestId, publicRequestSha256: canonicalSha256(publicInput) } });
  assert.equal(createIntent.ok, true, JSON.stringify(createIntent));
  const createIssue = await f.effect({ operation: 'issue', requestId: 'create-claim-issue', attemptId: reserved.attemptId, actionId: createIntent.actionId, actionKind: 'create' });
  assert.equal(createIssue.perform, true, JSON.stringify(createIssue));
  assert.equal(f.reserveVec().memberships, 1, 'the issued new-seat create holds one membership credit');
  // Pad memberships to the boundary so only the reserved slot remains.
  const rows = [...f.ledger().memberships];
  while (rows.length < LEDGER_LIMITS.memberships - 1) {
    const n = rows.length;
    rows.push({ ...f.worker, membershipId: randomUUID(), bindingHandleSha256: sha256Hex(`member-pad-${n}`), agentId: `member-pad-${n}`, capacityClaim: null });
  }
  const padded = await f.store.transact(f.repoKey, { repo: f.repo, actorKey: 'fixture:capacity', assignmentId: 'fixture', requestId: 'member-pad', command: { kind: 'fixture-capacity' } },
    () => ({ ok: true, events: [], memberships: rows }));
  assert.equal(padded.ok, true, JSON.stringify(padded));
  assert.equal(f.ledger().memberships.length, LEDGER_LIMITS.memberships - 1);
  // An unrelated membership append is refused: the last slot is reserved.
  const before = readFileSync(f.paths.ledgerPath);
  const refused = await f.store.transact(f.repoKey, { repo: f.repo, actorKey: 'fixture:capacity', assignmentId: 'fixture', requestId: 'member-overflow', command: { kind: 'fixture-capacity' } },
    l => ({ ok: true, events: [], memberships: [...l.memberships, { ...f.worker, membershipId: randomUUID(), bindingHandleSha256: sha256Hex('member-overflow'), agentId: 'member-overflow', capacityClaim: null }] }));
  assert.equal(refused.ok, false);
  assert.match(refused.message, /recovery capacity/);
  assert.deepEqual(readFileSync(f.paths.ledgerPath), before);
  assert.equal(f.reserveVec().memberships, 1, 'the refused commit does not consume the reserved claim');
});

test('open-scope byte wall: retained byte reserve binds before the 2048-row scope cap', async t => {
  const f = await boundaryFixture(t);
  await f.define('A');
  // OPEN-scope finding only: each transition-less scope costs one
  // scope-transition credit and one aux-row byte credit (~53 KB), so the
  // serialized-ledger byte wall lands far below 2048 for this history class.
  // This says nothing about the closed-history reachability proven next.
  let scopes = 0;
  while (f.byteSlack() > 150_000 && scopes < LEDGER_LIMITS.scopes) {
    const step = Math.min(32, Math.max(1, Math.floor(f.byteSlack() / 60_000)));
    f.padOpenScopes(step, 'pad scope'); scopes += step;
  }
  assert.ok(f.ledger().scopes.length < LEDGER_LIMITS.scopes,
    `open-scope byte wall at ${f.ledger().scopes.length} scopes`);
  const before = readFileSync(f.paths.ledgerPath);
  const slack = f.byteSlack();
  const fatRows = Array.from({ length: Math.ceil((slack + 60_000) / 30_500) }, () => f.fatHandledDeliveryRow());
  const refused = await f.unfundedAppend('scope-ceiling', fatRows);
  assert.equal(refused.ok, false, `a commit exceeding the ${slack}-byte slack must refuse`);
  assert.match(refused.message, /recovery reserve|recovery capacity|ledger byte/i);
  assert.deepEqual(readFileSync(f.paths.ledgerPath), before);
});

test('issued send observation commits at the exact task-entry boundary (coupled action+attempt receipt)', async t => {
  const f = await boundaryFixture(t);
  await f.define('S');
  const reserved = await f.reserve('S');
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await f.issuePlace(reserved, 's');
  const placed = await f.observePlace(reserved, 's');
  assert.equal(placed.ok, true, JSON.stringify(placed));
  const bound = await f.effect({ operation: 'bind', requestId: 'bind-s', attemptId: reserved.attemptId,
    member: { agentId: f.worker.agentId, membershipId: f.worker.membershipId },
    observed: { provider: f.worker.provider, createCwd: f.repository, workspaceId: null } });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const attempt = f.ledger().taskEntries.filter(r => r.kind === 'attempt' && r.attemptId === reserved.attemptId).at(-1);
  const controlPins = { assignmentId: f.assignmentId, taskId: 'S', ...f.pins(), expectedAttemptRevision: attempt.revision };
  const intent = await f.effect({ operation: 'intent', requestId: 'send-intent-s', attemptId: reserved.attemptId,
    actionKind: 'send', body: { grantRef: 'grant:send', controlPins, messageId: 'message-s' } });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  const issued = await f.effect({ operation: 'issue', requestId: 'send-issue-s', attemptId: reserved.attemptId,
    actionId: intent.actionId, actionKind: 'send' });
  assert.equal(issued.perform, true, JSON.stringify(issued));
  // Every send intent materializes a pending delivery bound to the action
  // (desk-task.ts ~line 3058) — assert the actual row before the boundary.
  const pendingBefore = f.ledger().taskEntries.filter(r => r.kind === 'delivery' && r.actionId === intent.actionId).at(-1);
  assert.equal(pendingBefore?.state, 'pending', 'send intent must have materialized a pending delivery row');
  f.padToEntrySum(LEDGER_LIMITS.taskEntries);
  // Frozen claim generalizes: a send observation commits its action +
  // attempt + pending-delivery revision rows at the exact boundary.
  const entriesBefore = f.ledger().taskEntries.length;
  const observed = await f.effect({ operation: 'observe', requestId: 'send-observe-s', attemptId: reserved.attemptId,
    actionId: intent.actionId, actionKind: 'send', receipt: { status: 'observed', messageId: 'message-s' } });
  assert.equal(observed.ok, true, `send observe at the exact boundary must commit: ${JSON.stringify(observed)}`);
  const emitted = f.ledger().taskEntries.slice(entriesBefore);
  assert.deepEqual(emitted.map(r => r.kind), ['action', 'attempt', 'delivery'],
    'send observation emits exactly its coupled action+attempt+delivery receipt');
  t.diagnostic(`send observe emitted rows: ${emitted.map(r => `${r.kind}:${Buffer.byteLength(JSON.stringify(r))}`).join(',')}`);
  const delivered = f.ledger().taskEntries.filter(r => r.kind === 'delivery' && r.deliveryId === pendingBefore.deliveryId).at(-1);
  assert.equal(delivered.state, 'host-accepted', 'the pending delivery is consumed by the send receipt');
  const postObserve = f.entryReserveSum();
  t.diagnostic(`send observe: entryReserveSum ${LEDGER_LIMITS.taskEntries} -> ${postObserve}`);
  assert.ok(postObserve <= LEDGER_LIMITS.taskEntries, 'send observation stays under the cap');
  const stop = await f.stopAttempt(reserved, 'S', 's');
  assert.equal(stop.ok, true, `stop after send boundary observation must commit: ${JSON.stringify(stop)}`);
  assert.equal(f.ledger().taskEntries.filter(r => r.kind === 'attempt' && r.attemptId === reserved.attemptId).at(-1).state, 'stop-requested');
});

test('closed-scope histories: distinct closed identities saturate the transition table first', async t => {
  const f = await boundaryFixture(t);
  await runAssignmentAttach(f.ctx, { requestId: 'attach-worker', assignmentId: f.assignmentId, agentId: f.worker.agentId }, f.deps);
  await f.define('A');
  // Class finding only — NOT a scope-cap unreachable claim: distinct CLOSED
  // scope identities cost ≥6 transitions + 2 reviews each, so this history
  // class saturates the 8192-transition table around ~1365 scopes. The
  // scopes TABLE cap itself counts declaration revisions and is exercised
  // separately below. The task-cancel shortcut is unavailable to padding —
  // history validation requires its taskCancellation pin to resolve a real
  // stopped attempt, a stop-observed control and a bound scope-transitioned
  // event.
  while (f.transitionReserveSum() + 6 <= LEDGER_LIMITS.scopeTransitions) {
    f.padClosedScopes(Math.min(200, Math.floor((LEDGER_LIMITS.scopeTransitions - f.transitionReserveSum()) / 6)), 'wall');
  }
  const scopesAtWall = f.ledger().scopes.length;
  const transitionSum = f.transitionReserveSum();
  t.diagnostic(`closed-history wall: ${scopesAtWall} scopes, ${f.ledger().scopeTransitions.length} transitions, reserve sum ${transitionSum}/${LEDGER_LIMITS.scopeTransitions}, bytes ${f.fileBytes()}`);
  assert.ok(scopesAtWall < LEDGER_LIMITS.scopes,
    `closed-history class ceiling ${scopesAtWall} scopes at transition sum ${transitionSum}`);
  // One more closed scope needs its 6 transitions; the transition reserve
  // refuses it while the scope table is still far below 2048.
  const before = readFileSync(f.paths.ledgerPath);
  const { scope, reviews, transitions } = f.closedScopeRows('overflow');
  const refused = await f.store.transact(f.repoKey,
    { repo: f.repo, actorKey: `agent:${f.lead.agentId}`, assignmentId: f.assignmentId, requestId: 'closed-overflow', command: { kind: 'fixture-append' } },
    l => ({ ok: true, events: [], scopes: [...l.scopes, scope], scopeReviews: [...l.scopeReviews, ...reviews],
      scopeTransitions: [...l.scopeTransitions, ...transitions] }));
  assert.equal(refused.ok, false, `a closed scope needing ${transitions.length} transitions must refuse at transition sum ${transitionSum}`);
  assert.match(refused.message, /capacity|reserve|transition/i);
  assert.deepEqual(readFileSync(f.paths.ledgerPath), before);
  assert.equal(f.transitionReserveSum(), transitionSum, 'the refused commit consumes no transition capacity');
});

test('scope-table boundary: declaration revisions reach 2047, the scoped task bind consumes row 2048, overflow refuses no-write', async t => {
  const f = await boundaryFixture(t);
  await runAssignmentAttach(f.ctx, { requestId: 'attach-worker', assignmentId: f.assignmentId, agentId: f.worker.agentId }, f.deps);
  // A scope template task whose bind materializes a NEW scope row.
  const taskScope = { label: 'claimed writer', refs: ['grant:scope'], ownership: { writerAgentId: f.worker.agentId, writerAuthorityRef: null,
    paths: ['src/core'], resources: [], stateOwners: [], dependsOnScopeIds: [], notifications: [] },
    reviewPlan: { kind: 'not-required', authorityRef: 'human:fixture', ruleRef: 'protocol:proof', reason: 'bounded test scope', lenses: [], exemptionClass: null } };
  await f.define('A', { scope: taskScope });
  const reserved = await f.reserve('A');
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await f.issuePlace(reserved, 'r');
  const placed = await f.observePlace(reserved, 'r');
  assert.equal(placed.ok, true, JSON.stringify(placed));
  assert.ok(f.reserveVec().scopes >= 1, 'the unbound attempt holds its new-scope credit');
  // The scopes cap counts declaration REVISION rows (desk-store.ts transact
  // check on nextTables.scopes.length), not distinct scopeIds — repeated
  // revisions of one open legacy scope reach the table boundary.
  f.padScopeRevisions(LEDGER_LIMITS.scopes - 1 - f.ledger().scopes.length, 'cap');
  assert.equal(f.ledger().scopes.length, LEDGER_LIMITS.scopes - 1, 'the scopes table sits one row below the cap');
  // The real bind writes the 2048th scope row — consumed from the attempt's
  // own reserved slot, so it commits at the exact boundary.
  const bound = await f.effect({ operation: 'bind', requestId: 'bind-r', attemptId: reserved.attemptId,
    member: { agentId: f.worker.agentId, membershipId: f.worker.membershipId },
    observed: { provider: f.worker.provider, createCwd: f.repository, workspaceId: null } });
  assert.equal(bound.ok, true, `scoped bind must commit at scopes=2047: ${JSON.stringify(bound)}`);
  assert.equal(f.ledger().scopes.length, LEDGER_LIMITS.scopes, 'the bind row is the 2048th table row');
  // An unrelated scope append — one more declaration revision — exceeds the
  // cap and refuses without writing.
  const before = readFileSync(f.paths.ledgerPath);
  const padScopeId = f.ledger().scopes.find(r => r.scopeId.startsWith('scp-rev-cap-'))?.scopeId;
  const overflowRev = f.ledger().scopes.filter(r => r.scopeId === padScopeId).length + 1;
  const refused = await f.store.transact(f.repoKey,
    { repo: f.repo, actorKey: `agent:${f.lead.agentId}`, assignmentId: f.assignmentId, requestId: 'scope-overflow', command: { kind: 'fixture-append' } },
    l => ({ ok: true, events: [], scopes: [...l.scopes, { assignmentId: f.assignmentId, scopeId: padScopeId,
      requestId: 'scope-overflow-rev', revision: overflowRev, priorRevision: overflowRev - 1,
      ownerMembershipId: f.lead.membershipId, ownerAgentId: f.lead.agentId, assignmentRevision: 1,
      seatAgentId: null, label: 'overflow revision', declarationSha256: sha256Hex(`decl-${padScopeId}-${overflowRev}`), refs: [],
      briefRevision: 0, ownership: null, reviewPlan: null }] }));
  assert.equal(refused.ok, false, 'a 2049th scope-table row must refuse');
  assert.match(refused.message, /capacity|scopes table|2048/i);
  assert.deepEqual(readFileSync(f.paths.ledgerPath), before);
  assert.equal(f.ledger().scopes.length, LEDGER_LIMITS.scopes, 'the refused overflow consumes no scope row');
});

// Placeholder so `await import` order stays stable if more cases land here.
export {};
