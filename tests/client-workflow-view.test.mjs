import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { act, deferredRpc, loadHooks, renderHook } from './helpers/client-hooks-harness.mjs';
import { bindWorkspaceDesk, readWorkspaceWorkflow } from '../plugin/server/workflow-view.ts';
import { createDeskStore } from '../plugin/server/desk-store.ts';
import { runAssignmentRegister } from '../plugin/server/desk-handback.ts';
import { runTaskCommand } from '../plugin/server/desk-task.ts';
import { memberRow, seedMemberships } from './helpers/desk-bridge-fixture.mjs';

const response = over => ({ workspaceId: 'workspace-a', ...over });

async function setup(t, strict = false) {
  const mod = await loadHooks(t);
  const reads = deferredRpc();
  const rendered = await renderHook(t, props => mod.useWorkspaceWorkflow(props.targetKey, props.workspaceId, reads.rpc),
    { targetKey: 'host-a/workspace-a', workspaceId: 'workspace-a' }, strict);
  return { ...rendered, reads };
}

test('workspace read survives StrictMode replay and drops the abandoned completion', async t => {
  const { state, reads } = await setup(t, true);
  assert.equal(reads.calls.length, 2);
  await act(async () => reads.calls[0].resolve({ workspaceId: 'old' }));
  assert.equal(state.current.current.result, null);
  await act(async () => reads.calls[1].resolve({ workspaceId: 'workspace-a' }));
  assert.equal(state.current.current.result.workspaceId, 'workspace-a');
  assert.equal(state.current.current.loading, false);
});

test('host/workspace A→B→A rejects old results and stale errors', async t => {
  const { state, reads, update } = await setup(t);
  await update({ targetKey: 'host-b/workspace-b', workspaceId: 'workspace-b' });
  await update({ targetKey: 'host-a/workspace-a', workspaceId: 'workspace-a' });
  assert.equal(reads.calls.length, 3);
  await act(async () => { reads.calls[0].resolve({ workspaceId: 'old-a' }); reads.calls[1].reject(new Error('old-b error')); });
  assert.equal(state.current.current.result, null);
  assert.equal(state.current.current.error, null);
  assert.equal(state.current.current.loading, true);
  await act(async () => reads.calls[2].resolve({ workspaceId: 'workspace-a' }));
  assert.equal(state.current.current.result.workspaceId, 'workspace-a');
});

test('a host switch with the same workspace ID invalidates its earlier session without remounting the hook', async t => {
  const { state, reads, update } = await setup(t);
  await update({ targetKey: 'host-a/workspace-a', workspaceId: 'workspace-a' });
  assert.equal(reads.calls.length, 1, 'ordinary rerenders do not reissue a read');
  await update({ targetKey: 'host-b/workspace-a', workspaceId: 'workspace-a' });
  await update({ targetKey: 'host-a/workspace-a', workspaceId: 'workspace-a' });
  assert.equal(reads.calls.length, 3);
  await act(async () => { reads.calls[0].resolve(response({ state: 'old-a' })); reads.calls[1].resolve(response({ state: 'host-b' })); });
  assert.equal(state.current.current.result, null);
  await act(async () => reads.calls[2].resolve(response({ state: 'current-a' })));
  assert.equal(state.current.current.result.state, 'current-a');
});

test('newer same-workspace request owns the displayed page and reload drops old cursor pins', async t => {
  const { state, reads } = await setup(t);
  await act(async () => { void state.current.select('assignment-1'); });
  assert.equal(reads.calls[1].input.assignmentId, 'assignment-1');
  await act(async () => reads.calls[0].resolve(response({ assignments: ['old list'] })));
  assert.equal(state.current.current.result, null);
  await act(async () => reads.calls[1].resolve(response({ ledgerRevision: 7, view: { briefRevision: 2,
    nextCursor: { assignmentId: 'assignment-1', ledgerRevision: 7, section: 'briefs', offset: 20 } } })));
  await act(async () => { void state.current.more(); });
  assert.equal(reads.calls[2].input.page.expectedLedgerRevision, 7);
  assert.equal(reads.calls[2].input.page.expectedBriefRevision, 2);
  assert.equal(reads.calls[2].input.page.cursor.offset, 20);
  await act(async () => { void state.current.reload(); });
  assert.equal(reads.calls[3].input.assignmentId, 'assignment-1');
  assert.equal(reads.calls[3].input.page.cursor, null);
  assert.equal(reads.calls[3].input.page.expectedLedgerRevision, null);
  await act(async () => reads.calls[2].reject(new Error('obsolete continuation')));
  assert.equal(state.current.current.error, null);
  await act(async () => reads.calls[3].resolve(response({ state: 'conflict', problem: { code: 'REVISION_CONFLICT', detail: 'Reload' } })));
  assert.equal(state.current.current.result.state, 'conflict');
  assert.equal(state.current.current.result.problem.code, 'REVISION_CONFLICT');
});

test('list continuation pins its own revision and selection clears the list cursor', async t => {
  const { state, reads } = await setup(t);
  await act(async () => reads.calls[0].resolve(response({ ledgerRevision: 12, view: null,
    assignmentNextCursor: { ledgerRevision: 12, offset: 20 } })));
  await act(async () => { void state.current.more(); });
  assert.deepEqual(reads.calls[1].input.assignmentCursor, { ledgerRevision: 12, offset: 20 });
  assert.equal(reads.calls[1].input.page.expectedLedgerRevision, 12);
  await act(async () => { void state.current.select('assignment-new'); });
  assert.equal(reads.calls[2].input.assignmentCursor, null);
  assert.equal(reads.calls[2].input.page.expectedLedgerRevision, null);
});

test('a mismatched current response is an error rather than another workspace painting as selected work', async t => {
  const { state, reads } = await setup(t);
  await act(async () => reads.calls[0].resolve({ workspaceId: 'unrelated-workspace', state: 'ready' }));
  assert.equal(state.current.current.result, null);
  assert.match(state.current.current.error, /does not match/);
});

test('client contribution opens the work panel in workspace context and removes its contributions', async t => {
  const mod = await loadHooks(t);
  const registrations = [];
  const removed = [];
  const add = kind => value => { registrations.push({ kind, value }); return () => removed.push({ kind, value }); };
  const cleanup = mod.contributeClient({
    addSurface: (id, Component) => add('surface')({ id, Component }),
    addSidebarItem: add('sidebar'), addCommandCenterItem: add('command'), addWorkspacePanel: add('panel'),
    rpc: async () => ({ error: null, recipients: [] }),
    addHeaderButton: () => { throw new Error('no notification recipient was selected'); },
  });
  let cleaned = false;
  t.after(() => { if (!cleaned) cleanup(); });
  const panel = registrations.find(row => row.kind === 'panel' && row.value.id === 'slp-work');
  assert.equal(panel.value.context, 'workspace');
  assert.equal(panel.value.Component, mod.WorkflowPanel);
  const command = registrations.find(row => row.kind === 'command' && row.value.id === 'open-slp-work');
  assert.equal(command.value.context, 'workspace');
  let opened;
  command.value.onSelect({ openPanel: id => { opened = id; }, openSurface: () => assert.fail('work reads open a workspace panel') });
  assert.equal(opened, 'slp-work');
  cleanup();
  cleaned = true;
  assert.equal(removed.length, 5);
});

test('native work panel distinguishes absent state, legacy context and unavailable reads without inventing acceptance', async t => {
  const mod = await loadHooks(t);
  const reads = deferredRpc();
  const contracts = [];
  mod.paseoState.current = {
    workspaces: { current: () => ({ directory: '/workspace/selected' }) },
    rpc: (contract, input) => { contracts.push(contract.name); return reads.rpc(input); },
  };
  const colors = Object.fromEntries(['foreground', 'foregroundMuted', 'statusDanger', 'statusWarning', 'surface1', 'surface2',
    'border', 'accent', 'accentForeground'].map(key => [key, '#123456']));
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(mod.WorkflowPanel, {
    workspaceId: 'workspace-a', host: { id: 'host-a', label: 'Selected host' }, theme: { colors }, layout: { compact: true },
  })); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const text = () => JSON.stringify(renderer.toJSON());
  const press = async label => act(async () => renderer.root.findByProps({ label }).props.onPress());
  assert.equal(reads.calls[0].input.workspaceId, 'workspace-a');
  assert.deepEqual(contracts, ['get-workspace-workflow']);
  await act(async () => reads.calls[0].resolve(response({ state: 'absent', assignments: [], view: null,
    target: { daemonHome: '/verified/home', workspaceDirectory: '/workspace/selected', repoKey: 'measured-repo' } })));
  assert.match(text(), /No desk ledger/);
  assert.match(text(), /not represented here/);
  assert.doesNotMatch(text(), /\/verified\/home/);
  const disclosure = renderer.root.findAll(node => typeof node.props.onPress === 'function' && node.props.accessibilityState?.expanded === false);
  assert.equal(disclosure.length, 1);
  await act(async () => disclosure[0].props.onPress());
  assert.match(text(), /\/verified\/home/);
  await press('Reload');
  await act(async () => reads.calls[1].resolve(response({ state: 'ready', ledgerRevision: 4,
    assignments: [{ id: 'assignment-legacy', objective: 'Legacy outcome', objectiveBasis: 'registration',
      briefRevision: 0, state: 'open', ownerAgentId: 'lead-a', ownerMembershipId: '11111111-1111-4111-8111-111111111111',
      ownershipRevision: 0 }],
    assignmentTotal: 1, assignmentOffset: 0, assignmentNextCursor: null, view: null })));
  await press('Read assignment');
  assert.equal(reads.calls[2].input.assignmentId, 'assignment-legacy');
  await act(async () => reads.calls[2].resolve(response({ state: 'ready', assignments: [], view: {
    assignmentId: 'assignment-legacy', ledgerRevision: 4, briefRevision: 0, currentBrief: null,
    ownership: { registeredOwnerAgentId: 'lead-a', registeredOwnerMembershipId: '11111111-1111-4111-8111-111111111111',
      ownerAgentId: 'lead-a', ownerMembershipId: '11111111-1111-4111-8111-111111111111', ownershipRevision: 0,
      ownerMembership: { state: 'host-confirmed', registeredAt: '2026-01-01T00:00:00.000Z', revokedAt: null },
      acceptedAcknowledgment: null },
    legacyObjective: 'Legacy outcome', section: 'briefs', items: [], total: 0, omittedBefore: 0, omittedAfter: 0, nextCursor: null,
  } })));
  assert.match(text(), /structured brief absent/);
  assert.match(text(), /ownership revision/);
  assert.match(text(), /recorded membership host-confirmed/);
  assert.match(text(), /Legacy outcome/);
  assert.match(text(), /not project acceptance/);
  await press('Reload');
  await act(async () => reads.calls[3].resolve(response({ state: 'unavailable', view: null,
    problem: { code: 'STATE_UNREADABLE', detail: 'The bound desk is unreadable.' } })));
  assert.match(text(), /Work records unavailable/);
  assert.match(text(), /bound desk is unreadable/);
  assert.doesNotMatch(text(), /Legacy outcome/);
});

test('native work panel renders the sixth tasks section with queue counts and resolver labels', async t => {
  const mod = await loadHooks(t);
  const reads = deferredRpc();
  mod.paseoState.current = {
    workspaces: { current: () => ({ directory: '/workspace/selected' }) },
    rpc: (contract, input) => reads.rpc(input),
  };
  const colors = Object.fromEntries(['foreground', 'foregroundMuted', 'statusDanger', 'statusWarning', 'surface1', 'surface2',
    'border', 'accent', 'accentForeground'].map(key => [key, '#123456']));
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(mod.WorkflowPanel, {
    workspaceId: 'workspace-a', host: { id: 'host-a', label: 'Selected host' }, theme: { colors }, layout: { compact: true },
  })); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const text = () => JSON.stringify(renderer.toJSON());
  const press = async label => act(async () => renderer.root.findByProps({ label }).props.onPress());
  await act(async () => reads.calls[0].resolve(response({ state: 'ready', ledgerRevision: 4,
    assignments: [{ id: 'assignment-1', objective: 'Queue outcome', objectiveBasis: 'registration',
      briefRevision: 0, state: 'open', ownerAgentId: 'lead-a', ownerMembershipId: '11111111-1111-4111-8111-111111111111',
      ownershipRevision: 0,
      taskCounts: { backlog: 0, ready: 0, held: 1, running: 0, integrating: 0, settled: 0, superseded: 0,
        openHolds: 1, pendingAcks: 1, resources: 0, controls: 0 } }],
    assignmentTotal: 1, assignmentOffset: 0, assignmentNextCursor: null, view: null })));
  assert.match(text(), /tasks 1 · ready 0 · held 1/);
  await press('Read assignment');
  await act(async () => reads.calls[1].resolve(response({ state: 'ready', ledgerRevision: 4, assignments: [], view: {
    assignmentId: 'assignment-1', ledgerRevision: 4, briefRevision: 0, currentBrief: null,
    ownership: { registeredOwnerAgentId: 'lead-a', registeredOwnerMembershipId: '11111111-1111-4111-8111-111111111111',
      ownerAgentId: 'lead-a', ownerMembershipId: '11111111-1111-4111-8111-111111111111', ownershipRevision: 0,
      ownerMembership: { state: 'host-confirmed', registeredAt: '2026-01-01T00:00:00.000Z', revokedAt: null },
      acceptedAcknowledgment: null },
    legacyObjective: 'Queue outcome', section: 'briefs', items: [], total: 0, omittedBefore: 0, omittedAfter: 0, nextCursor: null,
  } })));
  await press('Tasks');
  assert.equal(reads.calls[2].input.page.section, 'tasks');
  assert.equal(reads.calls[2].input.page.expectedLedgerRevision, 4);
  const stamp = over => ({ entryId: 'entry-1', entityId: 'task-1', taskId: 'task-1', assignmentId: 'assignment-1',
    revision: 1, priorEntryId: null, priorEntrySha256: null, entrySha256: 'a'.repeat(64), requestId: 'req-1',
    actorAgentId: 'lead-a', actorMembershipId: '22222222-2222-4222-8222-222222222222',
    ownershipRevision: 0, briefRevision: 0, ...over });
  const recapItem = (row, over = {}) => ({ entryId: row.entryId, taskId: row.taskId ?? null, kind: row.kind,
    state: row.state ?? 'recorded', summary: null, entrySha256: row.entrySha256, ordinal: row.revision, ...over });
  const readiness = over => ({ bucket: 'held', reasons: ['question-open'], eligible: false,
    pins: { briefRevision: 0, taskRevision: 1 }, ...over });
  const resultQualification = { qualified: true, scopeProof: 'terminal-approved-round', reasons: [], resultId: 'result-1', adjudicationId: 'adj-current',
    pins: { resultRevision: 1, adjudicationRevision: 1, scopeId: 'scope-1', scopeRevision: 2 } };
  const currentRuling = { adjudicationId: 'adj-current', resultId: 'result-1', verdict: 'accepted',
    reason: 'Current pinned task result ruling' };
  const entry = (row, over = {}) => ({ kind: 'taskEntry', row, current: true,
    readiness: row.taskId === null ? null : readiness(),
    resultQualification: row.taskId === null ? null : resultQualification,
    currentRuling: row.taskId === null ? null : currentRuling, summary: recapItem(row), ...over });
  await act(async () => reads.calls[2].resolve(response({ state: 'ready', assignments: [], view: {
    assignmentId: 'assignment-1', ledgerRevision: 4, briefRevision: 0, currentBrief: null,
    ownership: { registeredOwnerAgentId: 'lead-a', registeredOwnerMembershipId: '11111111-1111-4111-8111-111111111111',
      ownerAgentId: 'lead-a', ownerMembershipId: '11111111-1111-4111-8111-111111111111', ownershipRevision: 0,
      ownerMembership: { state: 'host-confirmed', registeredAt: '2026-01-01T00:00:00.000Z', revokedAt: null },
      acceptedAcknowledgment: null },
    legacyObjective: 'Queue outcome', section: 'tasks', total: 5, omittedBefore: 0, omittedAfter: 0, nextCursor: null,
    taskCounts: { backlog: 0, ready: 0, held: 1, running: 0, integrating: 0, settled: 0, superseded: 0,
      openHolds: 1, pendingAcks: 1, resources: 0, controls: 0 },
    items: [
      entry(stamp({ kind: 'task', state: 'open', outcome: 'Ship the feature' }), { readiness: readiness() }),
      entry(stamp({ entryId: 'entry-2', entityId: 'hold-1', taskId: 'task-1', revision: 1, kind: 'hold',
        holdId: 'hold-1', attemptId: null, holdKind: 'question', question: 'Wait for the owner ruling',
        proposition: null, claimRefs: [], resourceIds: [], state: 'ruled',
        ruling: { reason: 'Still blocked', outcome: 'retain', ownerAgentId: 'lead-a',
          ownerMembershipId: '11111111-1111-4111-8111-111111111111', briefRevision: 0 } })),
      entry(stamp({ entryId: 'entry-3', entityId: 'result-1', revision: 1, kind: 'result', resultId: 'result-1', provenance: 'measured' })),
      entry(stamp({ entryId: 'entry-4', entityId: 'adj-current', revision: 1, kind: 'adjudication', adjudicationId: 'adj-current',
        resultId: 'result-1', verdict: 'accepted' })),
      entry(stamp({ entryId: 'entry-5', entityId: 'del-1', revision: 1, kind: 'delivery', deliveryId: 'del-1', state: 'pending' })),
    ],
  } })));
  assert.match(text(), /Task declaration/);
  assert.match(text(), /Current task queue/);
  assert.match(text(), /tasks 1 · ready 0 · held 1/);
  assert.match(text(), /Recorded state open\. Current revision for this entity\. Current task context: readiness held \(not eligible\) — question-open; result qualification qualified \(scope proof terminal-approved-round\); current task ruling accepted \(adj-current\)/);
  assert.match(text(), /Retained hold — remains an active obligation until a current-owner ruling releases or withdraws it/);
  assert.match(text(), /Current task result qualification — shared resolver/);
  assert.match(text(), /Current task ruling — shared projection/);
  assert.match(text(), /Recorded verdict accepted\. Current task qualification and ruling come from the shared resolver, not row order/);
  assert.match(text(), /Delivery pending — a recorded delivery flag, never settlement or acceptance/);
  assert.match(text(), /"5"," of ","5"," records/);
});

test('native work panel renders a projection seeded by the exported task runner', async t => {
  const root = mkdtempSync(join(tmpdir(), 'slp-client-runner-task-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), '{}\n');
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => { if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome; });

  const repository = join(root, 'repo');
  mkdirSync(repository);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repository, 'file'), 'fixture\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');

  const paseo = { workspaces: { ref: () => ({ refresh: async () => ({
    id: 'workspace-a', workspaceDirectory: repository,
  }) }) } };
  const binding = await bindWorkspaceDesk('workspace-a', paseo);
  assert.equal(binding.state, 'ok');
  const store = createDeskStore({ stableRoot: binding.home.stableRoot });
  const lead = memberRow('client-runner-lead',
    { provider: 'slp-codex-lead', at: '2026-01-01T00:00:00.000Z' },
    { role: 'lead', agentId: 'client-runner-lead', workspaceId: 'workspace-a', createCwd: repository });
  await seedMemberships(store, binding.repo, [lead]);
  const registered = await runAssignmentRegister({ repoKey: binding.repoKey, row: lead },
    { requestId: 'client-register', authorityRef: 'human:bounded-test', objective: 'Runner-seeded queue' }, { store });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const context = { repoKey: binding.repoKey, row: lead };
  const currentRevision = () => {
    const read = store.read(binding.repoKey);
    assert.equal(read.state, 'ok');
    return read.ledger.revision;
  };
  const task = {
    state: 'open', outcome: 'Expose a current read-only queue row', objective: null,
    authorityRef: 'human:bounded-test', dependencies: [], scope: null, proofPolicy: null,
    grants: { create: null, send: null, archive: null, integrate: null, commit: null },
    budgets: { maxAttempts: null, maxActionsPerAttempt: null }, reason: null,
  };
  const defined = await runTaskCommand(context, {
    operation: 'define', requestId: 'client-define', assignmentId: registered.assignmentId,
    taskId: null, expectedLedgerRevision: currentRevision(), expectedBriefRevision: 0,
    expectedOwnershipRevision: 0, expectedTaskRevision: 0, task,
  }, { store });
  assert.equal(defined.ok, true, JSON.stringify(defined));
  const held = await runTaskCommand(context, {
    operation: 'hold', requestId: 'client-hold', assignmentId: registered.assignmentId,
    taskId: defined.taskId, attemptId: null, holdId: null,
    expectedLedgerRevision: currentRevision(), expectedBriefRevision: 0, expectedOwnershipRevision: 0,
    hold: { holdKind: 'question', question: 'Wait for the owner answer', proposition: null,
      claimRefs: [], resourceIds: [] }, ruling: null,
  }, { store });
  assert.equal(held.ok, true, JSON.stringify(held));

  const mod = await loadHooks(t);
  const sdk = { workspaces: { ref: () => ({ refresh: async () => ({
    id: 'workspace-a', workspaceDirectory: repository,
  }) }) } };
  mod.paseoState.current = {
    workspaces: { current: () => ({ directory: repository }) },
    rpc: (_contract, input) => readWorkspaceWorkflow(input, sdk),
  };
  const colors = Object.fromEntries(['foreground', 'foregroundMuted', 'statusDanger', 'statusWarning', 'surface1', 'surface2',
    'border', 'accent', 'accentForeground'].map(key => [key, '#123456']));
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(mod.WorkflowPanel, {
      workspaceId: 'workspace-a', host: { id: 'host-a', label: 'Selected host' }, theme: { colors }, layout: { compact: true },
    }));
    await new Promise(resolve => setImmediate(resolve));
  });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const text = () => JSON.stringify(renderer.toJSON());
  const press = async label => act(async () => renderer.root.findByProps({ label }).props.onPress());
  await press('Read assignment');
  await press('Tasks');

  assert.match(text(), /Task declaration/);
  assert.match(text(), /Current task queue/);
  assert.match(text(), /tasks 1 · ready 0 · held 1/);
  assert.match(text(), /readiness held \(not eligible\) — question-open/);
  assert.match(text(), /result qualification not qualified \(scope proof null\) — result-unruled/);
  assert.match(text(), /no current task ruling is projected/);
  assert.match(text(), /Current task result qualification — shared resolver/);
});
