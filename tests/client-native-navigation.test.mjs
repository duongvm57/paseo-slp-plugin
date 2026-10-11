import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { act, deferredRpc, loadHooks } from './helpers/client-hooks-harness.mjs';

const colors = Object.fromEntries(['foreground', 'foregroundMuted', 'statusDanger', 'statusWarning', 'statusSuccess',
  'surface0', 'surface1', 'surface2', 'border', 'accent', 'accentForeground'].map(key => [key, '#123456']));
const props = (hostId = 'host-a', over = {}) => ({ host: { id: hostId, label: hostId },
  theme: { colors }, layout: { compact: false, platform: 'web' }, params: {}, ...over });

function registrationRig(over = {}) {
  const registrations = [], removed = [], opened = [], calls = [];
  const add = kind => value => { registrations.push({ kind, value }); return () => removed.push(value.id); };
  return { registrations, removed, opened, calls, client: {
    addScreen: add('screen'), addSidebarHeaderItem: add('sidebar-header'), addSidebarFooterItem: () => assert.fail('SLP belongs in the upper sidebar'), addWorkspacePanel: add('panel'), addCommandCenterItem: add('command'),
    openScreen: input => opened.push(input),
    rpc: async (contract, input) => { calls.push({ name: contract.name, input }); return { error: null, recipients: [] }; },
    addHeaderButton: () => assert.fail('no recipient'), ...over,
  } };
}

test('native contribution keeps manager ID, normalizes section links and sidebar quick view is independent', async t => {
  const mod = await loadHooks(t), rig = registrationRig();
  const cleanup = mod.contributeClient(rig.client);
  t.after(cleanup);
  const screen = rig.registrations.find(row => row.kind === 'screen').value;
  assert.equal(screen.id, 'manager');
  assert.equal(rig.registrations.find(row => row.value.id === 'slp').kind, 'sidebar-header');
  assert.equal(screen.title({ section: 'supervision' }), 'SLP · Supervision');
  assert.equal(screen.title({ section: '/private/path', token: 'never-forward' }), 'SLP · Overview');
  const command = rig.registrations.find(row => row.value.id === 'open-slp').value;
  command.onSelect({ openScreen: input => rig.opened.push(input) });
  assert.deepEqual(rig.opened, [{ screenId: 'manager', params: { section: 'overview' } }]);
  let popover;
  let sidebar;
  await act(async () => { sidebar = TestRenderer.create(React.createElement(mod.SlpSidebarItem, props('host-a', {
    currentScreen: { screenId: 'manager', params: { section: 'pool' } },
    openScreen: input => rig.opened.push(input), openPopover: Component => { popover = Component; },
  }))); });
  t.after(async () => { await act(async () => sidebar.unmount()); });
  const row = sidebar.root.findByType('SidebarRow');
  assert.equal(row.props.active, true);
  const quick = row.props.trailing;
  assert.equal(quick.props.accessibilityRole, 'button');
  assert.equal(quick.props.accessibilityLabel, 'Quick view SLP runtime');
  assert.equal(quick.props.focusable, true);
  assert.equal(quick.props.children.props.name, 'Info');
  assert.equal(quick.props.children.props.color, colors.foregroundMuted);
  const mergedStyle = state => Object.assign({}, ...quick.props.style(state).filter(Boolean));
  assert.equal(mergedStyle({ pressed: false }).width + quick.props.hitSlop * 2, 44);
  assert.equal(mergedStyle({ pressed: false, focused: true }).outlineColor, colors.accent);
  assert.equal(mergedStyle({ pressed: false, focused: true }).outlineWidth, 3);
  assert.equal(mergedStyle({ pressed: false, hovered: true }).backgroundColor, colors.surface2);
  assert.equal(mergedStyle({ pressed: true }).opacity, 0.7);
  assert.equal(quick.props.children.props.children, undefined, 'icon has no visible text label');
  await act(async () => quick.props.onPress());
  assert.equal(popover, mod.RuntimePopover);
  assert.equal(rig.opened.length, 1, 'quick view does not open a screen');
  await act(async () => row.props.onPress());
  assert.deepEqual(rig.opened[1], { screenId: 'manager', params: { section: 'overview' } });
  const alternate = { ...colors, foregroundMuted: '#abcdef', surface2: '#654321', accent: '#fedcba' };
  await act(async () => sidebar.update(React.createElement(mod.SlpSidebarItem, props('host-a', {
    theme: { colors: alternate }, layout: { compact: true, platform: 'web' },
    openScreen() {}, openPopover() {},
  }))));
  const compact = sidebar.root.findByType('SidebarRow').props.trailing;
  const compactStyle = Object.assign({}, ...compact.props.style({ pressed: false, focused: true }).filter(Boolean));
  assert.equal(compactStyle.width, 32);
  assert.equal(compactStyle.height, 32, 'compact accessory does not inflate the native sidebar row');
  assert.equal(compactStyle.height + compact.props.hitSlop * 2, 44, 'touch slop remains independent of visible accessory size');
  assert.equal(compactStyle.outlineColor, alternate.accent);
  assert.equal(compactStyle.backgroundColor, alternate.surface2);
  assert.equal(compact.props.children.props.color, alternate.foregroundMuted);
  await cleanup();
  assert.equal(rig.removed.length, 5);
  await cleanup();
  assert.equal(rig.removed.length, 5, 'cleanup is idempotent');
});

test('partial registration failure rolls back every acquired contribution before any bell timer starts', async t => {
  const mod = await loadHooks(t);
  for (const failing of ['addSidebarHeaderItem', 'addCommandCenterItem', 'addWorkspacePanel']) {
    const rig = registrationRig({ [failing]: () => { throw new Error('host refused contribution'); } });
    assert.throws(() => mod.contributeClient(rig.client), /host refused/);
    assert.deepEqual(rig.removed, rig.registrations.map(row => row.value.id).reverse());
    assert.equal(rig.calls.length, 0, 'no background bell work before static registration succeeds');
  }
});

test('cleanup awaits async removers, removes all siblings after a failure and disposes the bell poll/listener', async t => {
  const mod = await loadHooks(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const removed = [];
  const rig = registrationRig({ addSidebarHeaderItem: value => async () => {
    await Promise.resolve(); removed.push(value.id); throw new Error('remove failed');
  } });
  const cleanup = mod.contributeClient(rig.client);
  await assert.rejects(cleanup(), /cleanup failed/);
  assert.deepEqual(removed, ['slp']);
  assert.equal(rig.removed.length, 4);
  const before = rig.calls.length;
  mod.notifySupervisionChanged();
  t.mock.timers.tick(120_000);
  assert.equal(rig.calls.length, before, 'unload owns timer and local subscription cleanup');
  await cleanup();
});

test('bell settings link goes to supervision; late/error/reversed reads cannot invent zero recipients', async t => {
  const mod = await loadHooks(t), reads = deferredRpc(), bells = [], opened = [];
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = { rpc: reads.rpc, openScreen: input => opened.push(input), addHeaderButton: contribution => {
    const bell = { contribution, removed: false, remove() { this.removed = true; } }; bells.push(bell); return bell;
  } };
  const cleanup = mod.contributeSupervisionControls(client);
  t.after(cleanup);
  const result = workspaceId => ({ error: null, recipients: [{ workspaceId }] });
  await reads.calls[0].resolve(result('workspace-a'));
  await new Promise(resolve => setImmediate(resolve));
  bells[0].contribution.button.behavior.items[0].behavior.onPress();
  assert.deepEqual(opened, [{ screenId: 'manager', params: { section: 'supervision' } }]);
  mod.notifySupervisionChanged();
  mod.notifySupervisionChanged();
  reads.calls[2].resolve({ error: 'catalog unavailable', recipients: [] });
  reads.calls[1].resolve(result('obsolete-workspace'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bells.length, 1);
  assert.equal(bells[0].removed, false);
  mod.notifySupervisionChanged();
  cleanup();
  reads.calls[3].resolve(result('after-unload'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bells.length, 1);
  assert.equal(bells[0].removed, true);
  t.mock.timers.tick(120_000);
  assert.equal(reads.calls.length, 4);
});

test('popover reads selected host only on open/refresh, drops late target results and creates no polling or mutations', async t => {
  const mod = await loadHooks(t), statusReads = deferredRpc(), calls = [];
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  mod.paseoState.current = { rpc: (contract, input) => {
    calls.push({ name: contract.name, input });
    return contract.name === 'local-target' ? Promise.resolve({ daemonHome: '/fixture-home' }) : statusReads.rpc(input);
  } };
  let renderer;
  const element = host => React.createElement(mod.RuntimePopover, props(host, { close() {}, openScreen() {} }));
  await act(async () => { renderer = TestRenderer.create(element('host-a')); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  await act(async () => renderer.update(element('host-b')));
  assert.equal(statusReads.calls[0].input.target.hostId, 'host-a');
  assert.equal(statusReads.calls[1].input.target.hostId, 'host-b');
  await act(async () => statusReads.calls[0].reject(new Error('old host error')));
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /old host error/);
  await act(async () => statusReads.calls[1].reject(new Error('current host unavailable')));
  assert.match(JSON.stringify(renderer.toJSON()), /current host unavailable/);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /0 runtime conflicts/);
  const before = calls.length;
  t.mock.timers.tick(120_000);
  assert.equal(calls.length, before);
  assert.ok(calls.every(call => ['local-target', 'status'].includes(call.name)));
});
