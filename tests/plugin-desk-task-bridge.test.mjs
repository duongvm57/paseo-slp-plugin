import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  BIN_SOURCE, bridgeFixture, startBridge, gitRepo, repoOf, memberRow,
  seedStore, seedMemberships, hello, handshake, rpc,
} from './helpers/desk-bridge-fixture.mjs';
import { sha256Hex } from '../plugin/server/config-view.ts';
import { WIRE_LIMITS } from '../plugin/shared/enforcement.ts';
import { install } from '../plugin/server/runtime/cli/package.ts';
import { readCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { createDeskSeat } from '../plugin/server/desk-seat.ts';
import { runTaskCommand } from '../plugin/server/desk-task.ts';

const PIN = sha256Hex(readFileSync(BIN_SOURCE));
const AT = '2026-01-01T00:00:00.000Z';

async function fixture(t, { execution = false, lostSendAck = false, lostCreateAck = false,
  formation = false, changeBindingAfterCreate = false } = {}) {
  const git = gitRepo(t, 'slp-task-wire-repo-');
  const lead = memberRow('task-owner', { provider: 'slp-codex-lead', at: AT },
    { agentId: 'task-owner', role: 'lead', createCwd: git.dir, workspaceId: formation ? 'wire-workspace' : null });
  const peer = memberRow('task-reader', { provider: 'slp-codex-peer', at: AT },
    { agentId: 'task-reader', createCwd: git.dir, workspaceId: null });
  const members = [lead, peer];
  const effects = [];
  const snapshots = new Map();
  const hooks = { beforeWorkerRefresh: null };
  let active = true;
  let store, repoKey, seatHooks;
  const paseo = { agents: { ref: id => ({ refresh: async () => {
    if (snapshots.has(id)) {
      if (hooks.beforeWorkerRefresh) await hooks.beforeWorkerRefresh(id);
      return { agent: snapshots.get(id), project: null };
    }
    const row = members.find(row => row.agentId === id);
    return { agent: row === undefined ? null : { provider: row.provider, workspaceId: row.workspaceId, archivedAt: null } };
  }, send: async (text, options) => {
    if (formation) {
      assert.equal(id, 'formed-lead');
      effects.push({ kind: 'send', agentId: id, text, messageId: options.messageId });
      return;
    }
    const ledger = store.read(repoKey).ledger;
    const attempts = ledger.taskEntries.filter(row => row.kind === 'attempt' && row.host.agentId === id);
    const attempt = attempts.at(-1);
    assert.equal(attempt.member.agentId, id);
    assert.ok(ledger.scopeTransitions.some(row => row.scopeId === attempt.boundScopeId && row.to === 'claimed'));
    effects.push({ kind: 'send', agentId: id, text, messageId: options.messageId });
    if (lostSendAck) throw new Error('fixture lost delivery acknowledgment');
  }, timeline: { refetch: async () => ({ entries: [] }) }, archive: async () => { throw new Error('archive not granted by fixture'); },
  waitForFinish: async () => undefined,
  }), create: async options => {
    assert.equal('prompt' in options, false);
    assert.equal(options.parent, lead.agentId);
    const action = store.read(repoKey).ledger.taskEntries.filter(row => row.kind === 'action' && row.actionKind === 'create').at(-1);
    assert.equal(action.state, 'issued');
    effects.push({ kind: 'create', options });
    const id = 'task-worker';
    snapshots.set(id, { id, provider: 'slp-codex-peer', model: 'fixture-model', cwd: options.cwd,
      workspaceId: null, status: 'idle', archivedAt: null, activeTurn: null,
      labels: { ...options.labels, 'paseo.parent-agent-id': options.parent }, currentModeId: 'full-access', features: [] });
    const minted = await seatHooks.deskMint({ provider: 'slp-codex-peer', family: 'codex', role: 'peer', cwd: options.cwd, env: {} });
    assert.ok(minted, 'real membership mint must succeed');
    await seatHooks.deskBind({ agentId: id, workspaceId: null, provider: 'slp-codex-peer', cwd: options.cwd,
      reason: 'create', purpose: 'interactive', env: { SLP_DESK_HANDLE: minted.handle } });
    await seatHooks.deskRegister({ agent: { id, provider: 'slp-codex-peer', cwd: options.cwd,
      workspaceId: null, parentAgentId: lead.agentId, title: null } });
    if (lostCreateAck) throw new Error('fixture lost create acknowledgment');
    return { id };
  }, list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  providers: { snapshot: async () => ({ entries: [{ provider: formation ? 'slp-codex-lead' : 'slp-codex-peer', enabled: true, status: 'ready' }] }) },
  workspaces: { ref: workspaceId => ({ agents: { create: async options => {
    if (!formation) throw new Error('workspace create not selected');
    assert.equal(workspaceId, 'wire-workspace'); assert.equal(options.parent, lead.agentId);
    assert.equal('prompt' in options, false); assert.equal('cwd' in options, false);
    effects.push({ kind: 'create', options });
    snapshots.set('formed-lead', { id: 'formed-lead', provider: 'slp-codex-lead', model: 'fixture-model', cwd: git.dir,
      workspaceId, archivedAt: null, labels: { ...options.labels, 'paseo.parent-agent-id': options.parent },
      currentModeId: options.config.modeId, thinkingOptionId: options.config.thinkingOptionId, features: [] });
    if (changeBindingAfterCreate) active = false;
    return { id: 'formed-lead' };
  } } }) },
  };
  let raw;
  const journal = formation ? { read: () => ({ state: active ? 'ACTIVE' : 'INACTIVE', binding: {
    launchSetSha256: raw.launchSetSha, runtimePath: raw.runtimePath, node: { path: process.execPath },
    candidateSha256: raw.candidateSha } }) } : undefined;
  raw = bridgeFixture(t, 'slp-task-wire-home-', PIN, { paseoRef: { current: paseo },
    taskHost: execution || formation ? () => paseo : undefined, journal });
  if (execution || formation) {
    rmSync(raw.runtimePath, { recursive: true });
    install(fileURLToPath(new URL('..', import.meta.url)), raw.runtimePath);
    execFileSync('git', ['-C', git.dir, 'config', 'user.name', 'Fixture']);
    execFileSync('git', ['-C', git.dir, 'config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(join(git.dir, 'changed.txt'), 'base\n');
    execFileSync('git', ['-C', git.dir, 'add', '.']);
    execFileSync('git', ['-C', git.dir, 'commit', '-qm', 'fixture']);
    mkdirSync(join(git.dir, '.paseo-slp'));
    writeFileSync(join(git.dir, '.paseo-slp/slp-routing.json'), JSON.stringify({ version: 1, policy: 'Fixture pool',
      quotaFallback: { enabled: false, optionId: null }, options: [{ id: 'wire-worker', provider: 'codex', roles: ['peer'],
        model: 'fixture-model', modeId: 'full-access', features: {}, enabled: true, availability: 'ready',
        suitableFor: ['coding'], avoidFor: [], notes: 'Fixture' }] }));
    if (formation) writeFileSync(join(raw.home, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [{
      id: 'slp-lead', provider: 'slp-codex-lead', model: 'fixture-model', modeId: 'full-access', thinkingOptionId: 'high', featureValues: {},
    }] } }));
  }
  const f = await startBridge(t, raw);
  assert.equal(f.outcome, 'listening');
  f.bridge.noteDispatch(paseo);
  store = seedStore(f);
  repoKey = await seedMemberships(store, repoOf(git), members);
  seatHooks = createDeskSeat({ stableRoot: f.stableRoot, store, now: () => new Date(AT), warn: line => assert.fail(line) });
  const connect = async handle => {
    const channel = await handshake(f.paths.socketPath, hello(PIN, handle));
    t.after(() => channel.conn.destroy());
    assert.equal(channel.ack.ok, true, JSON.stringify(channel.ack));
    return channel;
  };
  const owner = await connect('task-owner');
  const reader = await connect('task-reader');
  let id = 0;
  const call = async (seat, name, input) => {
    const reply = await rpc(seat.reader, seat.conn, { jsonrpc: '2.0', id: ++id,
      method: 'tools/call', params: { name, arguments: input } });
    return JSON.parse(reply.result.content[0].text);
  };
  const registered = await call(owner, 'slp_assignment_register', {
    requestId: 'register-task-wire', authorityRef: 'human:fixture', objective: 'Produce a bounded investigation',
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  return { ...f, git, store, repoKey, owner, reader, call, effects, snapshots, seatHooks, hooks, lead,
    assignmentId: registered.assignmentId, rpcId: () => ++id };
}

const declaration = f => ({
  requestId: 'define-task-wire', assignmentId: f.assignmentId, taskId: null,
  expectedLedgerRevision: f.store.read(f.repoKey).ledger.revision,
  expectedBriefRevision: 0, expectedOwnershipRevision: 0, expectedTaskRevision: 0,
  task: { state: 'open', outcome: 'Produce a bounded investigation artifact', objective: null,
    authorityRef: 'human:fixture', dependencies: [], scope: null,
    proofPolicy: { kind: 'declared', authorityRef: 'human:fixture', ruleRef: 'protocol:proof',
      reason: 'Read-only investigation; owner verifies the artifact', requiredChecks: [], requiredEvidence: [],
      reviewRequired: false, availability: 'artifact', verificationRecipes: [] },
    grants: { create: null, send: null, archive: null, integrate: null, commit: null },
    budgets: { maxAttempts: 1, maxActionsPerAttempt: 8 }, reason: null },
});

test('the native task catalog fits the relay response and keeps internal receipts off the wire', async t => {
  const f = await fixture(t);
  const reply = await rpc(f.owner.reader, f.owner.conn, { jsonrpc: '2.0', id: f.rpcId(), method: 'tools/list' });
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= WIRE_LIMITS.deskBridgeResponseBytes);
  const tasks = reply.result.tools.filter(row => row.name.startsWith('slp_task_'));
  assert.deepEqual(tasks.map(row => row.name).sort(), [
    'slp_task_acknowledge', 'slp_task_define', 'slp_task_deliver', 'slp_task_dispatch', 'slp_task_get', 'slp_task_hold', 'slp_task_integrate',
    'slp_task_recap', 'slp_task_reconcile', 'slp_task_result', 'slp_task_rule', 'slp_task_stop',
  ]);
  for (const row of tasks) {
    const variants = row.inputSchema.oneOf ?? row.inputSchema.anyOf ?? [row.inputSchema];
    for (const schema of variants) {
      assert.equal(schema.additionalProperties, false, row.name);
      for (const field of ['actorAgentId', 'actorMembershipId', 'receipt', 'observed', 'perform', 'sdk']) {
        assert.equal(schema.properties?.[field], undefined, `${row.name}.${field}`);
      }
    }
  }
});

test('a task declaration commits through the guarded socket and the shared tasks projection', async t => {
  const f = await fixture(t);
  const created = await f.call(f.owner, 'slp_task_define', declaration(f));
  assert.equal(created.ok, true, JSON.stringify(created));
  const read = await f.call(f.owner, 'slp_workflow_get', {
    assignmentId: f.assignmentId, section: 'tasks', expectedLedgerRevision: created.ledgerRevision,
    expectedBriefRevision: 0, cursor: null, limit: 20,
  });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.total, 1);
  assert.equal(read.items[0].row.taskId, created.taskId);
  assert.equal(read.items[0].readiness.bucket, 'ready');
  assert.equal(read.items[0].readiness.pins.taskRevision, 1);
  assert.equal(read.acceptance, 'not-established-by-this-view');
});

test('nonowner and supplied observation fields cannot mutate the task ledger', async t => {
  const f = await fixture(t);
  const before = f.store.read(f.repoKey).ledger;
  const denied = await f.call(f.reader, 'slp_task_define', declaration(f));
  assert.equal(denied.ok, false);
  assert.ok(['AUTHORITY_REQUIRED', 'ACTOR_MISMATCH'].includes(denied.code));
  assert.deepEqual(f.store.read(f.repoKey).ledger.taskEntries, before.taskEntries);
  const bad = await f.call(f.owner, 'slp_task_define', { ...declaration(f), observed: { status: 'passed' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_RECORD');
  assert.deepEqual(f.store.read(f.repoKey).ledger.taskEntries, before.taskEntries);
});

test('a task recap uses the authorized shared page and global counts under the same pins', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 3; n++) {
    const created = await f.call(f.owner, 'slp_task_define', { ...declaration(f), requestId: `define-${n}` });
    assert.equal(created.ok, true, JSON.stringify(created));
  }
  const ledgerRevision = f.store.read(f.repoKey).ledger.revision;
  const request = { requestId: 'recap-page-1', assignmentId: f.assignmentId,
    expectedLedgerRevision: ledgerRevision, expectedBriefRevision: 0,
    expectedOwnershipRevision: 0, cursor: null, limit: 1 };
  const page = await f.call(f.owner, 'slp_workflow_get', { assignmentId: f.assignmentId,
    section: 'tasks', expectedLedgerRevision: ledgerRevision, expectedBriefRevision: 0,
    cursor: null, limit: 1 });
  assert.equal(page.ok, true, JSON.stringify(page));
  const recap = await f.call(f.owner, 'slp_task_recap', request);
  assert.equal(recap.ok, true, JSON.stringify(recap));
  assert.deepEqual(recap.view, page);
  assert.deepEqual(recap.counts, page.taskCounts);
  const buckets = ['backlog', 'ready', 'held', 'running', 'integrating', 'settled', 'superseded'];
  assert.equal(buckets.reduce((total, bucket) => total + recap.counts[bucket], 0), 3);
  assert.equal(recap.view.items.length, 1);
  assert.equal(recap.view.omittedAfter, 2);
  assert.equal(recap.contextStatus, 'partial');
  assert.equal(recap.acceptance, 'not-established-by-this-recap');
  const second = await f.call(f.owner, 'slp_task_recap', { ...request, requestId: 'recap-page-2', cursor: recap.view.nextCursor });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.view.omittedBefore, 1);
  assert.notEqual(second.view.items[0].row.entryId, recap.view.items[0].row.entryId);
  assert.deepEqual(second.counts, recap.counts);
});

test('recap rejects foreign readers, stale pins and caller-supplied projections without mutation', async t => {
  const f = await fixture(t);
  const created = await f.call(f.owner, 'slp_task_define', declaration(f));
  assert.equal(created.ok, true, JSON.stringify(created));
  const before = f.store.read(f.repoKey).ledger;
  const request = { requestId: 'recap-guard', assignmentId: f.assignmentId,
    expectedLedgerRevision: before.revision, expectedBriefRevision: 0,
    expectedOwnershipRevision: 0, cursor: null, limit: 20 };
  const denied = await f.call(f.reader, 'slp_task_recap', request);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'AUTHORITY_REQUIRED');
  for (const changed of [{ expectedLedgerRevision: before.revision - 1 }, { expectedOwnershipRevision: 1 }]) {
    const stale = await f.call(f.owner, 'slp_task_recap', { ...request, ...changed });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'REVISION_CONFLICT');
  }
  for (const changed of [{ view: { ok: true, counts: { ready: 99 } } }, { taskId: created.taskId }, { offset: 0 }]) {
    const supplied = await f.call(f.owner, 'slp_task_recap', { ...request, ...changed });
    assert.equal(supplied.ok, false);
    assert.equal(supplied.code, 'INVALID_RECORD');
  }
  assert.deepEqual(f.store.read(f.repoKey).ledger, before);
});

async function bootWorker(t, options = {}) {
  const f = await fixture(t, { execution: true, ...options });
  const input = declaration(f);
  input.task.scope = { label: 'Wire task writer', refs: ['human:fixture'],
    ownership: { writerAgentId: 'future-worker', writerAuthorityRef: null,
      paths: ['changed.txt'], resources: [], stateOwners: [], dependsOnScopeIds: [], notifications: [] },
    reviewPlan: { kind: 'not-required', authorityRef: 'human:fixture', ruleRef: 'protocol:fixture',
      reason: 'Local fixture with no review trigger', lenses: [], exemptionClass: null } };
  input.task.grants.create = 'grant:create'; input.task.grants.send = 'grant:send';
  input.task.budgets.maxActionsPerAttempt = 24;
  const defined = await f.call(f.owner, 'slp_task_define', input);
  assert.equal(defined.ok, true, JSON.stringify(defined));
  const boot = await f.call(f.owner, 'slp_task_dispatch', {
    requestId: 'wire-bootstrap', assignmentId: f.assignmentId, taskId: defined.taskId,
    phase: 'bootstrap', attemptId: null, expectedAttemptRevision: 0,
    expectedLedgerRevision: f.store.read(f.repoKey).ledger.revision,
    expectedBriefRevision: 0, expectedOwnershipRevision: 0, expectedTaskRevision: 1,
    grantRef: 'grant:create', placement: { kind: 'shared-checkout', cwd: f.git.dir },
    runtime: { optionId: 'wire-worker', catalogSha256: readCatalog(f.git.dir, f.home).sha256 },
  });
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.equal(boot.state, 'bound', JSON.stringify(boot));
  const ledger = () => f.store.read(f.repoKey).ledger;
  const attempt = () => ledger().taskEntries.filter(row => row.kind === 'attempt' && row.attemptId === boot.attemptId).at(-1);
  const sendInput = { requestId: 'wire-send', assignmentId: f.assignmentId, taskId: defined.taskId,
    phase: 'send', attemptId: boot.attemptId, expectedAttemptRevision: attempt().revision,
    expectedLedgerRevision: ledger().revision, expectedBriefRevision: 0, expectedOwnershipRevision: 0,
    expectedTaskRevision: 1, grantRef: 'grant:send', text: 'Implement only changed.txt and return evidence.' };
  return { ...f, boot, ledger, attempt, sendInput };
}

test('production socket services reserve, measure, create without prompt, bind scope and send exactly once', async t => {
  const f = await bootWorker(t);
  assert.equal(f.effects.filter(effect => effect.kind === 'create').length, 1);
  assert.equal(f.attempt().sourceBase.artifactSha256.length, 64);
  const sent = await f.call(f.owner, 'slp_task_dispatch', f.sendInput);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.sent, true);
  assert.equal(f.effects.filter(effect => effect.kind === 'send').length, 1);
  const replay = await f.call(f.owner, 'slp_task_dispatch', f.sendInput);
  assert.ok(replay.ok === false || replay.perform === false || replay.sent === false);
  assert.equal(f.effects.filter(effect => effect.kind === 'create').length, 1);
  assert.equal(f.effects.filter(effect => effect.kind === 'send').length, 1);
});

test('native turn evidence observes only the positively correlated bound worker and never grants acceptance', async t => {
  const f = await bootWorker(t, { lostSendAck: true });
  await f.call(f.owner, 'slp_task_dispatch', f.sendInput);
  const action = () => f.ledger().taskEntries.filter(row => row.kind === 'action' && row.actionKind === 'send').at(-1);
  assert.equal(action().state, 'uncertain');
  const before = f.ledger().revision;
  await f.bridge.taskTurnEnded({ agentId: 'task-worker', turnId: 'wrong-turn', outcome: 'completed',
    timeline: [{ type: 'user_message', messageId: 'unrelated-message' }] });
  await f.bridge.taskTurnEnded({ agentId: 'task-reader', turnId: 'wrong-actor', outcome: 'completed',
    timeline: [{ type: 'user_message', messageId: action().body.messageId }] });
  assert.equal(f.ledger().revision, before);
  await f.bridge.taskTurnEnded({ agentId: 'task-worker', turnId: 'observed-turn', outcome: 'completed',
    timeline: [{ type: 'user_message', messageId: action().body.messageId }] });
  assert.equal(action().state, 'observed');
  assert.equal(action().actorAgentId, 'task-worker', 'the native receipt uses the worker, never a fabricated owner');
  assert.equal(f.ledger().taskEntries.filter(row => row.kind === 'adjudication').length, 0);
  assert.equal(f.effects.filter(effect => effect.kind === 'send').length, 1);
});

test('a correlated native event cannot write after the worker membership is revoked', async t => {
  const f = await bootWorker(t, { lostSendAck: true });
  await f.call(f.owner, 'slp_task_dispatch', f.sendInput);
  const action = () => f.ledger().taskEntries.filter(row => row.kind === 'action' && row.actionKind === 'send').at(-1);
  assert.equal(action().state, 'uncertain');
  await f.seatHooks.deskRevoke({ agent: { id: 'task-worker', provider: 'slp-codex-peer',
    cwd: f.git.dir, workspaceId: null, parentAgentId: 'task-owner', title: null } });
  const before = f.ledger();
  assert.ok(before.memberships.find(row => row.agentId === 'task-worker').revokedAt);
  await f.bridge.taskTurnEnded({ agentId: 'task-worker', turnId: 'retired-worker-turn', outcome: 'completed',
    timeline: [{ type: 'user_message', messageId: action().body.messageId }] });
  assert.deepEqual(f.ledger(), before);
  assert.equal(action().state, 'uncertain');
  assert.equal(f.effects.filter(effect => effect.kind === 'send').length, 1);
});

function delivery(f, over = {}) {
  const declared = declaration(f);
  declared.task.scope = { label: 'Bounded readonly proof', refs: ['human:fixture'], ownership: null,
    reviewPlan: { kind: 'not-required', authorityRef: 'human:fixture', ruleRef: 'protocol:fixture',
      reason: 'Readonly fixture; owner verifies findings', lenses: [], exemptionClass: null } };
  declared.task.grants.create = 'grant:create'; declared.task.grants.send = 'grant:send';
  declared.task.budgets.maxActionsPerAttempt = 24;
  return { requestId: 'deliver-wire', assignmentId: f.assignmentId,
    expectedLedgerRevision: f.store.read(f.repoKey).ledger.revision, expectedBriefRevision: 0, expectedOwnershipRevision: 0,
    task: declared.task, runtime: { optionId: 'wire-worker', catalogSha256: readCatalog(f.git.dir, f.home).sha256 },
    text: 'Read only changed.txt and return evidence.', ...over };
}

test('one semantic delivery crosses real Core create/bind/send and returns targeted current pins without history paging', async t => {
  const f = await fixture(t, { execution: true });
  const request = delivery(f);
  const out = await f.call(f.owner, 'slp_task_deliver', request);
  assert.equal(out.state, 'recorded', JSON.stringify(out));
  assert.equal(out.result.delivery.ok, true, JSON.stringify(out));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create', 'send']);
  assert.equal(out.result.current.pins.expectedLedgerRevision, f.store.read(f.repoKey).ledger.revision);
  const current = await f.call(f.owner, 'slp_task_get', { assignmentId: f.assignmentId, taskId: out.result.taskId, attemptId: out.result.attemptId });
  assert.equal(current.ok, true, JSON.stringify(current));
  assert.equal(current.attempt.host.agentId, 'task-worker'); assert.equal('items' in current, false);
  assert.equal(current.pins.expectedAttemptRevision, current.attempt.revision);
  const replay = await f.call(f.owner, 'slp_task_deliver', request);
  assert.equal(replay.receiptSha256, out.receiptSha256); assert.equal(replay.replayed, true);
  assert.equal(f.effects.length, 2);
  const altered = await f.call(f.owner, 'slp_task_deliver', { ...request, text: 'Changed' });
  assert.equal(altered.code, 'IDEMPOTENCY_CONFLICT'); assert.equal(f.effects.length, 2);
  const receipt = await f.call(f.owner, 'slp_operation_get', { kind: 'task-deliver', requestId: request.requestId });
  assert.equal(receipt.receiptSha256, out.receiptSha256);
  const foreignReceipt = await f.call(f.reader, 'slp_operation_get', { kind: 'task-deliver', requestId: request.requestId });
  assert.equal(foreignReceipt.ok, false);
  const stale = await f.call(f.owner, 'slp_task_get', { assignmentId: f.assignmentId, taskId: out.result.taskId, expectedLedgerRevision: 0 });
  assert.equal(stale.code, 'REVISION_CONFLICT');
  const foreignAttempt = await f.call(f.owner, 'slp_task_get', { assignmentId: f.assignmentId, taskId: out.result.taskId, attemptId: 'foreign' });
  assert.equal(foreignAttempt.code, 'ACTOR_MISMATCH');
});

test('managed composition preserves lost-send uncertainty and cannot replay delivery or accept output', async t => {
  const f = await fixture(t, { execution: true, lostSendAck: true });
  const request = delivery(f), out = await f.call(f.owner, 'slp_task_deliver', request);
  assert.equal(out.result.current.entities.find(row => row.kind === 'action' && row.state === 'uncertain')?.state, 'uncertain', JSON.stringify(out));
  const effects = f.effects.length;
  await f.call(f.owner, 'slp_task_deliver', request); assert.equal(f.effects.length, effects);
  assert.equal(f.store.read(f.repoKey).ledger.taskEntries.filter(row => row.kind === 'adjudication').length, 0);
});

test('managed composition rejects missing separate effect grants and stale CAS before any host effect', async t => {
  const f = await fixture(t, { execution: true });
  const missing = delivery(f); missing.task.grants.send = null;
  assert.equal((await f.call(f.owner, 'slp_task_deliver', missing)).code, 'AUTHORITY_REQUIRED');
  assert.deepEqual(f.effects, []);
  const stale = delivery(f, { requestId: 'stale-delivery', expectedLedgerRevision: 0 });
  const rejected = await f.call(f.owner, 'slp_task_deliver', stale);
  assert.equal(rejected.result.code, 'REVISION_CONFLICT', JSON.stringify(rejected)); assert.deepEqual(f.effects, []);
});

for (const drift of [false,true]) {
 test(`ordinary formation crosses authenticated wire guards; binding drift=${drift} preserves native identity`,async t=>{
  const f=await fixture(t,{formation:true,changeBindingAfterCreate:drift});
  const request={requestId:'wire-formation',role:'lead',taskLabel:'formation',assignment:'Read-only orientation and report.',grantRef:'human:fixture'};
  const out=await f.call(f.owner,'slp_seat_create',request);
  assert.equal(out.state,'recorded',JSON.stringify(out));
  if (drift) { assert.equal(out.result.code,'CANDIDATE_DRIFT'); assert.equal(out.result.agentId,'formed-lead'); }
  else { assert.equal(out.result.state,'host-accepted'); assert.equal(out.result.parent,'task-owner'); assert.equal(out.result.workspaceId,'wire-workspace'); }
  assert.deepEqual(f.effects.map(effect=>effect.kind),drift?['create']:['create','send']);
  const count=f.effects.length;
  const replay=await f.call(f.owner,'slp_seat_create',request); assert.equal(replay.receiptSha256,out.receiptSha256);
  assert.equal(f.effects.length,count);
 });
}

test('composite bootstrap uncertainty retains the exact reservation and never delivers or re-creates on replay',async t=>{
 const f=await fixture(t,{execution:true,lostCreateAck:true}); const request=delivery(f);
 const out=await f.call(f.owner,'slp_task_deliver',request);
 assert.equal(out.state,'recorded',JSON.stringify(out)); assert.equal(out.result.state,'uncertain',JSON.stringify(out));
 assert.ok(out.result.taskId); assert.ok(out.result.attemptId);
 assert.deepEqual(f.effects.map(effect=>effect.kind),['create']);
 await f.call(f.owner,'slp_task_deliver',request); assert.equal(f.effects.length,1);
});

test('composite send CAS conflict after unrelated commit keeps the bound attempt and issues no native send',async t=>{
 const f=await fixture(t,{execution:true}); let refreshes=0;
 f.hooks.beforeWorkerRefresh=async id=>{
  if(id!=='task-worker'||++refreshes!==2)return;
  const unrelated=declaration(f); unrelated.requestId='unrelated-task-race';
  const committed=await runTaskCommand({repoKey:f.repoKey,row:f.lead},{...unrelated,operation:'define'},{store:f.store});
  assert.equal(committed.ok,true,JSON.stringify(committed));
 };
 const request=delivery(f), out=await f.call(f.owner,'slp_task_deliver',request);
 assert.equal(out.state,'recorded',JSON.stringify(out)); assert.equal(out.result.delivery.code,'REVISION_CONFLICT',JSON.stringify(out));
 assert.equal(out.result.current.attempt.state,'bound'); assert.deepEqual(f.effects.map(effect=>effect.kind),['create']);
 await f.call(f.owner,'slp_task_deliver',request); assert.equal(f.effects.length,1);
});
