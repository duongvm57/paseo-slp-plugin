import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { act, deferredRpc, loadHooks } from './helpers/client-hooks-harness.mjs';

const colors = Object.fromEntries(['foreground', 'foregroundMuted', 'statusDanger', 'statusWarning', 'statusSuccess',
  'surface0', 'surface1', 'surface2', 'border', 'accent', 'accentForeground'].map(key => [key, '#123456']));
const props = over => ({ host: { id: 'selected-host', label: 'Selected host' }, workspaceId: 'workspace-a',
  layout: { compact: true, platform: 'web' }, theme: { colors }, ...over });
const counts = over => ({ backlog: 0, ready: 0, held: 0, running: 0, integrating: 0, settled: 0, superseded: 0,
  openHolds: 0, pendingAcks: 0, resources: 0, controls: 0, ...over });
const assignment = over => ({ id: 'assignment-1', objective: 'Ship a readable work panel', objectiveBasis: 'registration', briefRevision: 0,
  state: 'open', ownerAgentId: 'owner-agent', ownerMembershipId: 'owner-member', ownershipRevision: 0, taskCounts: null, ...over });
const response = over => ({ schemaVersion: 1, workspaceId: 'workspace-a', state: 'ready', generatedAt: '2026-10-11T04:00:00Z',
  ledgerRevision: 9, assignments: [], assignmentTotal: 1, assignmentOffset: 0, assignmentNextCursor: null,
  view: null, target: null, problem: null, acceptance: 'not-established-by-this-view', ...over });

async function fixture(t, overrides = {}) {
  const mod = await loadHooks(t), read = deferredRpc(), copied = [], opened = [];
  mod.paseoState.current = { agents: { current: () => ({ title: 'Current owner name', status: 'idle' }) },
    workspaces: { current: () => ({ directory: '/fixture-workspace' }) }, rpc: (_contract, input) => read.rpc(input) };
  mod.clipboardState.copy = async value => copied.push(value);
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(mod.WorkflowPanel, props({
    navigation: { openAgent: input => opened.push(input), openWorkspace() {} }, ...overrides,
  }))); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const text = () => JSON.stringify(renderer.toJSON());
  const press = async label => act(async () => renderer.root.findByProps({ label }).props.onPress());
  return { mod, read, copied, opened, renderer, text, press };
}

test('assignment list opens its current owner on the selected host in one action and keeps IDs in readable details', async t => {
  const rig = await fixture(t);
  await act(async () => rig.read.calls[0].resolve(response({ assignments: [assignment({ taskCounts: counts({ held: 2, running: 1 }) })],
    assignmentTotal: 8, assignmentOffset: 3 })));
  assert.match(rig.text(), /Ship a readable work panel|Current owner name/);
  assert.match(rig.text(), /tasks 3 · ready 0 · held 2 · running 1/);
  assert.match(rig.text(), /earlier entries omitted/);
  assert.doesNotMatch(rig.text(), /assignment-1/);
  await rig.press('Open owner chat');
  assert.deepEqual(rig.opened, [{ agentId: 'owner-agent', serverId: 'selected-host' }]);
  await rig.press('Copy owner ID');
  assert.deepEqual(rig.copied, ['owner-agent']);
  await act(async () => rig.renderer.root.findByProps({ accessibilityLabel: 'Assignment details' }).props.onPress());
  assert.match(rig.text(), /assignment-1/);
  assert.equal(rig.read.calls.length, 1, 'details/navigation never mutate or refetch the desk');
});

test('owner fallback is copyable without navigation; late clipboard errors stay on their host/owner', async t => {
  const rig = await fixture(t, { navigation: undefined });
  await act(async () => rig.read.calls[0].resolve(response({ assignments: [assignment()] })));
  assert.equal(rig.renderer.root.findAllByProps({ label: 'Open owner chat' }).length, 0);
  assert.match(rig.text(), /Chat navigation is unavailable/);
  const copy = deferredRpc(); rig.mod.clipboardState.copy = copy.rpc;
  await rig.press('Copy owner ID');
  await act(async () => rig.renderer.update(React.createElement(rig.mod.WorkflowPanel, props({ host: { id: 'host-b', label: 'Host B' } }))));
  await act(async () => copy.calls[0].reject(new Error('obsolete clipboard error')));
  assert.doesNotMatch(rig.text(), /obsolete clipboard error/);
});

test('null/missing counts, measured zero, absent desk, partial page and RPC error remain different states', async t => {
  const rig = await fixture(t);
  await act(async () => rig.read.calls[0].resolve(response({ assignments: [assignment({ taskCounts: null })] })));
  assert.match(rig.text(), /task queue not recorded/);
  assert.doesNotMatch(rig.text(), /no task entries recorded/);
  await rig.press('Reload');
  await act(async () => rig.read.calls[1].resolve(response({ assignments: [assignment({ taskCounts: undefined })] })));
  assert.match(rig.text(), /task counts unavailable/);
  await rig.press('Reload');
  await act(async () => rig.read.calls[2].resolve(response({ assignments: [assignment({ taskCounts: counts() })] })));
  assert.match(rig.text(), /no task entries recorded/);
  await rig.press('Reload');
  await act(async () => rig.read.calls[3].resolve(response({ state: 'absent', assignments: [], assignmentTotal: 0 })));
  assert.match(rig.text(), /No desk ledger/);
  assert.doesNotMatch(rig.text(), /no task entries recorded|No assignments are registered/);
  await rig.press('Reload');
  await act(async () => rig.read.calls[4].reject(new Error('fixture read failed')));
  assert.match(rig.text(), /fixture read failed/);
  assert.doesNotMatch(rig.text(), /no task entries recorded/);
});

test('evidence keeps declarations, measurements, incomplete coverage and recorded review qualification distinct', async t => {
  const rig = await fixture(t);
  await act(async () => rig.read.calls[0].resolve(response({ assignments: [assignment()] })));
  await rig.press('Read assignment');
  const view = { assignmentId: 'assignment-1', ledgerRevision: 9, briefRevision: 0, currentBrief: null, legacyObjective: 'Current assignment',
    ownership: { ownerAgentId: 'owner-agent', ownershipRevision: 0, ownerMembership: null },
    section: 'evidence', taskCounts: counts({ held: 4 }), total: 12, omittedBefore: 3, omittedAfter: 5, nextCursor: null,
    items: [
      { kind: 'candidateObservation', row: { snapshotSha256: 'a'.repeat(64), incomplete: ['unreadable-file'], measuredAt: '2026-10-11T03:00:00Z', seatAgentId: 'measured-seat' } },
      { kind: 'checkDefinition', row: { label: 'Fixture declared check' } },
      { kind: 'checkRun', row: { checkId: 'check-1', status: 'failed', exitCode: null, outputTruncated: true, outputPointer: 'fixture-log' } },
      { kind: 'scopeReview', row: { verdict: 'approved', reviewerAgentId: 'reviewer', briefRevision: 0 },
        qualification: { standingApproval: false, discharging: false, eligible: false } },
    ] };
  await act(async () => rig.read.calls[1].resolve(response({ view })));
  assert.match(rig.text(), /Measured candidate · incomplete coverage/);
  assert.match(rig.text(), /2026-10-11T03:00:00Z/);
  assert.match(rig.text(), /Declared check/);
  assert.match(rig.text(), /Runtime check observation · failed/);
  assert.match(rig.text(), /Unavailable/);
  assert.match(rig.text(), /not supplied by this projection/);
  assert.match(rig.text(), /Recorded review · approved/);
  assert.match(rig.text(), /outside the current standing qualification/);
  assert.match(rig.text(), /tasks 4 · ready 0 · held 4/);
  assert.match(rig.text(), /"4"," of ","12"," records/);
  assert.doesNotMatch(rig.text(), /unreadable-file|fixture-log/);
  await act(async () => { for (const node of rig.renderer.root.findAllByProps({ accessibilityLabel: 'Record details and provenance' })) node.props.onPress(); });
  assert.match(rig.text(), /unreadable-file|fixture-log/);
  assert.ok(rig.read.calls.every(call => call.input.schemaVersion === 1));
});
