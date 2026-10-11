import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { act, deferredRpc, loadHooks } from './helpers/client-hooks-harness.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
export const colors = Object.fromEntries(['foreground', 'foregroundMuted', 'statusDanger', 'statusWarning', 'statusSuccess',
  'surface0', 'surface1', 'surface2', 'border', 'accent', 'accentForeground'].map(key => [key, '#123456']));
const runtime = over => ({ schemaVersion: 1, target: { hostId: 'host-a', daemonHome: '/canonical/a' }, state: 'ACTIVE',
  embeddedCandidateSha256: B, binding: { candidateSha256: A, bindingSha256: A, payloadSha256: A,
    launchSetSha256: A, runtimePath: '/runtime', nodePath: '/node', baseline: 'fresh' },
  families: [], operation: null, conflicts: [], verifiedAt: null, retainedRuntimeCount: 0,
  communicationLanguage: null, liveAcceptance: null, managedProfiles: [], ...over });

async function render(t, Component, props) {
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return renderer;
}

test('Jev overview keeps an unavailable read, unknown state and invalid config distinct from a disabled capability', async t => {
  const { jevSummary } = await loadHooks(t);
  const view = { configured: true, enabled: false, error: null };
  assert.equal(jevSummary(view, null), 'Disabled');
  assert.equal(jevSummary({ ...view, enabled: null }, null), 'State unavailable');
  assert.equal(jevSummary({ ...view, configured: false }, null), 'Not configured');
  assert.equal(jevSummary({ ...view, error: 'invalid configuration' }, null), 'Configuration error; open Routing / Jev');
  assert.equal(jevSummary(view, 'read failed'), 'Read unavailable');
  assert.equal(jevSummary(null, null), 'Awaiting settings read');
  const draft = { dirty: true, saved: false }, saved = { dirty: false, saved: true };
  assert.equal(jevSummary(view, null, draft), 'Unsaved settings · Saved state: Disabled');
  assert.equal(jevSummary(view, null, saved), 'Saved settings · Disabled');
  for (const editor of [draft, saved]) {
    const prefix = editor.dirty ? 'Unsaved settings · Saved state: ' : '';
    assert.equal(jevSummary(view, 'read failed', editor), `${prefix}Read unavailable`);
    assert.equal(jevSummary(null, null, editor), `${prefix}Awaiting settings read`);
    assert.equal(jevSummary({ ...view, enabled: null }, null, editor), `${prefix}State unavailable`);
    assert.equal(jevSummary({ ...view, configured: false }, null, editor), `${prefix}Not configured`);
    assert.equal(jevSummary({ ...view, error: 'invalid configuration' }, null, editor), `${prefix}Configuration error; open Routing / Jev`);
  }
});

test('slim option controls retain selection, touch slop and themed focus without forced pill height', async t => {
  const mod = await loadHooks(t), selected = [];
  mod.primitiveState.tree = true;
  for (const variant of ['pill', 'choice']) {
    const renderer = await render(t, mod.ChipSelect, { colors, variant, value: 'high',
      options: [{ label: 'Provider default (low)', value: 'default' }, { label: 'high', value: 'high' }],
      onChange: value => selected.push(value) });
    const buttons = renderer.root.findAll(node => node.props.accessibilityRole === 'button'
      && typeof node.props.style === 'function' && typeof node.props.onPress === 'function');
    const control = buttons[0];
    const style = Object.assign({}, ...control.props.style({ pressed: false, focused: true }).filter(Boolean));
    assert.equal(style.minHeight, undefined, '44px minimum must not inflate the visible option');
    assert.equal(style.paddingVertical, variant === 'pill' ? 5 : 6);
    assert.deepEqual(control.props.hitSlop, { top: 3, bottom: 3, left: 0, right: 0 });
    const gap = variant === 'pill' ? mod.controlStyles.chipRow.gap : mod.controlStyles.choiceRow.gap;
    assert.ok(control.props.hitSlop.top + control.props.hitSlop.bottom <= gap, 'wrapped touch expansions do not overlap');
    assert.equal(style.outlineColor, colors.accent);
    assert.equal(style.outlineWidth, 3);
    assert.equal(buttons.find(node => node.props.accessibilityState.selected).props.accessibilityState.disabled, false);
    await act(async () => control.props.onPress());
  }
  assert.deepEqual(selected, ['default', 'default']);
});

test('binding identity distinguishes mismatch, missing read, unbound and verification without truncating pins', async t => {
  const mod = await loadHooks(t);
  const renderer = await render(t, mod.RuntimeIdentity, { colors, statusView: runtime(), home: '/typed' });
  const text = () => JSON.stringify(renderer.toJSON());
  assert.match(text(), /Runtime differs from this plugin/);
  assert.match(text(), /Choose Update SLP runtime/);
  assert.match(text(), /Reloading the UI does not change the active binding/);
  assert.match(text(), /Not yet verified/);
  assert.ok(text().includes(A) && text().includes(B));
  assert.ok(text().includes('/canonical/a'));
  assert.doesNotMatch(text(), /\/typed/);
  await act(async () => renderer.update(React.createElement(mod.RuntimeIdentity,
    { colors, statusView: runtime({ binding: null, verifiedAt: '2026-10-11T04:00:00Z' }), home: '/typed' })));
  assert.match(text(), /No active binding/);
  assert.match(text(), /2026-10-11T04:00:00Z/);
  assert.doesNotMatch(text(), /Runtime differs from this plugin/);
  assert.doesNotMatch(text(), /Choose Update SLP runtime/);
  await act(async () => renderer.update(React.createElement(mod.RuntimeIdentity, { colors, statusView: null, home: '/typed' })));
  assert.match(text(), /Awaiting inspection/);
  assert.doesNotMatch(text(), /No active binding|Not yet verified/);
});

test('Manager starts at Overview, exposes conflicts, keeps drafts across sections and never writes on navigation', async t => {
  const mod = await loadHooks(t);
  const calls = [];
  mod.paseoState.current = { agents: { list: async () => ({ entries: [] }) }, rpc: async (contract, input) => {
    calls.push({ name: contract.name, input });
    switch (contract.name) {
      case 'local-target': return { daemonHome: '/a' };
      case 'status': return runtime({ conflicts: [{ code: 'CONFIG_DRIFT', message: 'fixture conflict', path: '/config' }] });
      case 'get-role-routing': return { routing: { schemaVersion: 1, supervisor: { family: 'codex', model: 'saved-model' }, lead: { family: 'codex' } } };
      case 'get-peer-pool': return { pool: null, sha256: null, error: null, legacy: null, legacyError: null };
      case 'get-jev': return { jev: { configured: false, enabled: false, capabilities: { routing: false, supervision: false }, provider: null, sha256: null, error: null } };
      case 'get-supervision': return { schemaVersion: 2, config: null, sha256: null, migration: null, observations: [], gates: {}, diagnostics: { droppedEvents: 0, reasons: [] }, unverified: [], error: null };
      case 'catalog': return { models: [], modes: [], features: [], error: 'fixture catalog unavailable' };
      default: throw new Error(`Unexpected RPC ${contract.name}`);
    }
  } };
  const renderer = await render(t, mod.ManagerSurface, { host: { id: 'host-a', label: 'Fixture host' },
    layout: { compact: true, platform: 'web' }, theme: { colors } });
  const tab = name => renderer.root.findByProps({ accessibilityLabel: `${name} tab` });
  assert.equal(tab('Overview').props.accessibilityState.selected, true);
  assert.match(JSON.stringify(renderer.toJSON()), /fixture conflict/);
  await act(async () => tab('Profiles').props.onPress());
  const card = renderer.root.findByType(mod.ManagerSurface).findAll(node => node.type.name === 'RoutingCard')[0];
  await act(async () => card.props.routing.setField('supervisor', 'model')('unsaved-model'));
  await act(async () => tab('Supervision').props.onPress());
  await act(async () => tab('Profiles').props.onPress());
  assert.equal(card.props.routing.form.supervisor.model, 'unsaved-model');
  assert.match(JSON.stringify(renderer.toJSON()), /Save profiles/);
  assert.equal(calls.filter(call => /^(set-|activate|reconcile|deactivate|test-)/.test(call.name)).length, 0);
});

async function managerRig(t, extra = {}, adapters = {}, tree = false) {
  const mod = await loadHooks(t), reads = deferredRpc(), calls = [];
  mod.primitiveState.tree = tree;
  mod.paseoState.current = { agents: { list: async () => ({ entries: [] }) }, rpc: (contract, input) => {
    calls.push({ name: contract.name, input });
    if (adapters[contract.name]) return adapters[contract.name](input);
    if (contract.name === 'local-target') return Promise.resolve({ daemonHome: '/a' });
    if (contract.name === 'status') return reads.rpc(input);
    if (contract.name === 'get-role-routing') return Promise.resolve({ routing: null });
    if (contract.name === 'get-peer-pool') return Promise.resolve({ pool: null, sha256: null, error: null, legacy: null, legacyError: null });
    if (contract.name === 'get-jev') return Promise.resolve({ jev: null });
    if (contract.name === 'get-supervision') return Promise.resolve({ config: null, observations: [], unverified: [], diagnostics: { droppedEvents: 0, reasons: [] } });
    if (contract.name === 'catalog') return Promise.resolve({ models: [], modes: [], features: [], error: null });
    throw new Error(`Unapproved fixture call ${contract.name}`);
  } };
  const base = { host: { id: 'host-a', label: 'Fixture host' }, layout: { compact: true, platform: 'web' }, theme: { colors }, params: {}, ...extra };
  const renderer = await render(t, mod.ManagerSurface, base);
  const update = async over => act(async () => renderer.update(React.createElement(mod.ManagerSurface, { ...base, ...over })));
  const routing = () => renderer.root.findAll(node => node.type.name === 'RoutingCard')[0]?.props.routing;
  return { mod, reads, calls, renderer, update, routing };
}

const control = (rig, label) => rig.renderer.root.findAll(node => node.props.label === label && typeof node.props.onPress === 'function')[0];
const visible = node => {
  for (let current = node; current; current = current.parent) {
    if ([current.props.style].flat().some(style => style?.display === 'none')) return false;
  }
  return true;
};
const modal = rig => rig.renderer.root.findAll(node => node.type === 'Modal')[0];
async function acknowledge(rig) {
  const dialog = modal(rig);
  for (const title of ['Exclusive configuration window', 'Daemon home confirmed']) {
    await act(async () => dialog.findAll(node => node.props.title === title && typeof node.props.onToggle === 'function')[0].props.onToggle(true));
  }
}

test('Save profiles confirms on demand, saves then applies once with pinned authority and pending protection', async t => {
  const saves = deferredRpc(), starts = deferredRpc();
  const rig = await managerRig(t, { params: { section: 'profiles' } }, {
    'get-role-routing': async () => ({ routing: { schemaVersion: 1, supervisor: { family: 'codex', model: 'old' }, lead: { family: 'codex' } } }),
    'set-role-routing': input => saves.rpc(input), activate: input => starts.rpc(input),
  }, true);
  await act(async () => rig.reads.calls[0].resolve(runtime({ embeddedCandidateSha256: A })));
  assert.equal(modal(rig), undefined, 'opening Profiles never asks or mutates');
  assert.equal(rig.renderer.root.findAll(node => node.props.title === 'Apply saved configuration').length, 0);
  await act(async () => rig.routing().setField('supervisor', 'model')('new-model'));
  await act(async () => control(rig, 'Save profiles').props.onPress());
  assert.ok(modal(rig));
  assert.equal(saves.calls.length, 0);
  assert.equal(control(rig, 'Save and apply').props.disabled, true);
  await act(async () => control(rig, 'Cancel').props.onPress());
  assert.equal(modal(rig), undefined);
  assert.equal(saves.calls.length, 0);
  await act(async () => control(rig, 'Save profiles').props.onPress());
  await acknowledge(rig);
  await act(async () => control(rig, 'Save and apply').props.onPress());
  assert.equal(modal(rig), undefined);
  assert.equal(saves.calls.length, 1);
  assert.equal(starts.calls.length, 0, 'Apply waits for save success and fresh status');
  assert.ok(control(rig, 'Saving…').props.disabled);
  await act(async () => saves.calls[0].resolve({ routing: saves.calls[0].input.routing }));
  assert.equal(rig.reads.calls.length, 2);
  assert.equal(starts.calls.length, 0);
  await act(async () => rig.reads.calls[1].resolve(runtime({ embeddedCandidateSha256: A })));
  assert.equal(starts.calls.length, 1);
  assert.equal(starts.calls[0].input.candidateSha256, A);
  assert.deepEqual(starts.calls[0].input.target, { hostId: 'host-a', daemonHome: '/a' });
  assert.deepEqual(starts.calls[0].input.authority, { exclusiveAdministrativeWindow: true, verifiedHostHomeMapping: true });
  assert.equal('profiles' in starts.calls[0].input, false);
  const operation = { operationId: starts.calls[0].input.operationId, kind: 'activate', phase: 'verify', outcome: 'pending',
    startedAt: '2026-10-11T06:35:00Z', updatedAt: '2026-10-11T06:35:00Z', completedAt: null };
  await act(async () => starts.calls[0].resolve({ schemaVersion: 1, accepted: true, state: 'ACTIVATING', operation, conflicts: [], pollAfterMs: 5000 }));
  assert.equal(rig.reads.calls.at(-1).input.operationId, operation.operationId);
  assert.ok(control(rig, 'Applying…').props.disabled);
  const card = rig.renderer.root.findAll(node => node.type.name === 'RoutingCard')[0];
  await act(async () => card.props.onSave());
  assert.equal(saves.calls.length, 1, 'pending direct callback cannot save/apply twice');
  assert.equal(starts.calls.length, 1);
  assert.ok(JSON.stringify(rig.renderer.toJSON()).includes(operation.operationId));
});

for (const failure of ['save-error', 'target-switch', 'candidate-change', 'status-error']) {
  test(`Save then Apply stops safely on ${failure}`, async t => {
    const saves = deferredRpc(), starts = deferredRpc();
    const rig = await managerRig(t, { params: { section: 'profiles' } }, {
      'set-role-routing': input => saves.rpc(input), activate: input => starts.rpc(input),
    }, true);
    await act(async () => rig.reads.calls[0].resolve(runtime()));
    await act(async () => rig.routing().setField('supervisor', 'model')('new-model'));
    await act(async () => control(rig, 'Save profiles').props.onPress());
    assert.match(JSON.stringify(rig.renderer.toJSON()), /Applying also updates the bound runtime/);
    await acknowledge(rig);
    await act(async () => control(rig, 'Save and apply').props.onPress());
    if (failure === 'save-error') await act(async () => saves.calls[0].reject(new Error('save refused')));
    else if (failure === 'target-switch') {
      await rig.update({ host: { id: 'host-b', label: 'Other host' } });
      await act(async () => saves.calls[0].resolve({ routing: saves.calls[0].input.routing }));
      assert.equal(modal(rig), undefined);
      await act(async () => rig.reads.calls[1].resolve(runtime({ target: { hostId: 'host-b', daemonHome: '/a' } })));
      assert.equal(rig.routing().saved, false);
    } else {
      await act(async () => saves.calls[0].resolve({ routing: saves.calls[0].input.routing }));
      if (failure === 'candidate-change') await act(async () => rig.reads.calls[1].resolve(runtime({ embeddedCandidateSha256: A })));
      else await act(async () => rig.reads.calls[1].reject(new Error('status failed')));
      assert.equal(rig.routing().saved, true, 'save remains truthful when Apply cannot run');
      assert.match(JSON.stringify(rig.renderer.toJSON()), /Profiles were saved, but applying/);
    }
    assert.equal(starts.calls.length, 0);
  });
}

test('normal sections stay free of runtime setup and never save or bind on navigation', async t => {
  const rig = await managerRig(t, {}, {}, true);
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  const setup = () => rig.renderer.root.findAll(node => node.props.title === 'Runtime setup')[0];
  for (const section of ['overview', 'profiles', 'pool', 'language', 'jev', 'supervision']) {
    await act(async () => rig.renderer.root.findByType('SettingsSelect').props.onValueChange(section));
    assert.equal(visible(setup()), false);
    assert.equal(modal(rig), undefined);
  }
  await act(async () => rig.renderer.root.findByType('SettingsSelect').props.onValueChange('maintenance'));
  assert.equal(visible(setup()), true);
  assert.equal(rig.calls.filter(call => /^(set-|activate)/.test(call.name)).length, 0);
});

test('a rejected chained Apply preserves saved Profiles and does not retry activation automatically', async t => {
  const starts = deferredRpc();
  const rig = await managerRig(t, { params: { section: 'profiles' } }, {
    'set-role-routing': async input => ({ routing: input.routing }), activate: input => starts.rpc(input),
  }, true);
  await act(async () => rig.reads.calls[0].resolve(runtime({ embeddedCandidateSha256: A })));
  await act(async () => rig.routing().setField('supervisor', 'model')('new-model'));
  await act(async () => control(rig, 'Save profiles').props.onPress());
  await acknowledge(rig);
  await act(async () => control(rig, 'Save and apply').props.onPress());
  await act(async () => rig.reads.calls[1].resolve(runtime({ embeddedCandidateSha256: A })));
  assert.equal(starts.calls.length, 1);
  await act(async () => starts.calls[0].resolve({ schemaVersion: 1, accepted: false, state: 'ACTIVE',
    operation: null, conflicts: [{ code: 'CONFIG_DRIFT', message: 'apply rejected' }], pollAfterMs: 0 }));
  assert.equal(rig.routing().saved, true);
  assert.match(JSON.stringify(rig.renderer.toJSON()), /apply rejected/);
  await act(async () => rig.reads.calls[2].resolve(runtime({ embeddedCandidateSha256: A })));
  assert.equal(starts.calls.length, 1);
  assert.equal(rig.calls.filter(call => call.name === 'set-role-routing').length, 1);
});

test('accepted pending activation keeps its ID through uncertain polls and rejects another submission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starts = deferredRpc();
  const rig = await managerRig(t, {}, { activate: input => starts.rpc(input) }, true);
  const button = () => rig.renderer.root.findAll(node => node.props.label === 'Update SLP runtime' && typeof node.props.onPress === 'function')[0];
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  for (const title of ['Exclusive configuration window', 'Daemon home confirmed']) {
    await act(async () => rig.renderer.root.findAll(node => node.props.title === title && typeof node.props.onToggle === 'function')[0].props.onToggle(true));
  }
  await act(async () => button().props.onPress());
  const id = starts.calls[0].input.operationId;
  const operation = { operationId: id, kind: 'activate', phase: 'verify', outcome: 'pending',
    startedAt: '2026-10-11T06:15:00Z', updatedAt: '2026-10-11T06:15:00Z', completedAt: null };
  await act(async () => starts.calls[0].resolve({ schemaVersion: 1, accepted: true, state: 'ACTIVATING', operation, conflicts: [], pollAfterMs: 10 }));
  assert.equal(rig.reads.calls[1].input.operationId, id);
  await act(async () => rig.reads.calls[1].resolve(runtime({ operation })));
  assert.equal(button().props.disabled, true);
  await act(async () => button().props.onPress());
  assert.equal(starts.calls.length, 1, 'handler refuses even a direct repeated callback');
  await act(async () => t.mock.timers.tick(10));
  assert.equal(rig.reads.calls[2].input.operationId, id);
  await act(async () => rig.reads.calls[2].resolve(runtime({ operation: null })));
  assert.equal(button().props.disabled, true, 'missing operation is uncertain, not completion');
  assert.ok(JSON.stringify(rig.renderer.toJSON()).includes(id));
  await act(async () => t.mock.timers.tick(5000));
  const poll = rig.reads.calls.at(-1);
  assert.equal(poll.input.operationId, id);
  await act(async () => poll.resolve(runtime({ operation: { ...operation, outcome: 'succeeded', completedAt: '2026-10-11T06:15:01Z' } })));
  assert.equal(button().props.disabled, false, 'only the tracked terminal result releases the guard');
});

test('Jev Overview distinguishes retained draft from saved state until explicit Apply succeeds', async t => {
  const savedView = { configured: true, enabled: false, capabilities: { routing: false, supervision: false },
    provider: { kind: 'openrouter', model: 'typesafe/jev-1.13', baseUrl: 'https://openrouter.ai' },
    hasKey: false, keyPermissionsOk: null, sha256: A, error: null };
  const writes = deferredRpc();
  const rig = await managerRig(t, {}, {
    'get-jev': async () => ({ jev: savedView }),
    'set-jev': input => writes.rpc(input),
  });
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  const select = section => act(async () => rig.renderer.root.findByType('SettingsSelect').props.onValueChange(section));
  const card = () => rig.renderer.root.findAll(node => node.type.name === 'JevCard')[0];
  const summary = () => rig.renderer.root.findAll(node => node.props.label === 'Jev' && typeof node.props.value === 'string')[0].props.value;
  assert.equal(summary(), 'Disabled');
  await select('jev');
  await act(async () => card().findAll(node => node.props.title === 'Enable Jev' && typeof node.props.onToggle === 'function')[0].props.onToggle(true));
  await select('overview');
  assert.equal(summary(), 'Unsaved settings · Saved state: Disabled');
  assert.equal(card().props.jev.enabledOn, true);
  assert.equal(card().props.jev.view.enabled, false);
  assert.equal(rig.calls.filter(call => /^(set-|activate|reconcile|deactivate|test-)/.test(call.name)).length, 0);
  await select('jev');
  assert.equal(card().props.jev.enabledOn, true);
  await act(async () => card().findAll(node => node.props.label === 'Apply Jev settings' && typeof node.props.onPress === 'function')[0].props.onPress());
  assert.equal(writes.calls.length, 1);
  assert.equal(writes.calls[0].input.expectedSha256, A);
  assert.equal(writes.calls[0].input.jev.enabled, true);
  await select('overview');
  assert.equal(summary(), 'Unsaved settings · Saved state: Disabled', 'pending save does not claim success');
  await act(async () => writes.calls[0].resolve({ jev: { ...savedView, enabled: true, sha256: B } }));
  assert.equal(summary(), 'Saved settings · Enabled; inspect capabilities');
  assert.equal(card().props.jev.dirty, false);
  assert.equal(card().props.jev.saved, true);
  assert.equal(rig.calls.filter(call => /^(set-|activate|reconcile|deactivate|test-)/.test(call.name)).length, 1);
});

test('screen params follow direct links, back and reload; compact selector writes only normalized section params and retains draft', async t => {
  const opened = [];
  const rig = await managerRig(t, { params: { section: 'supervision' }, onSectionChange: section => opened.push(section) });
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  const selector = () => rig.renderer.root.findByType('SettingsSelect');
  assert.equal(selector().props.value, 'supervision');
  await act(async () => rig.routing().setField('supervisor', 'model')('local-draft'));
  await act(async () => selector().props.onValueChange('profiles'));
  assert.deepEqual(opened, ['profiles']);
  await rig.update({ params: { section: 'profiles' } });
  assert.equal(selector().props.value, 'profiles');
  await rig.update({ params: { section: 'supervision' } });
  assert.equal(rig.routing().form.supervisor.model, 'local-draft');
  await rig.update({ params: { section: 'unknown', daemonHome: '/never-forwarded', authority: 'never-forwarded' } });
  assert.equal(selector().props.value, 'overview');
  assert.match(JSON.stringify(rig.renderer.toJSON()), /Unknown section/);
  assert.ok(rig.calls.every(call => !JSON.stringify(call.input).includes('never-forwarded')));
  assert.equal(rig.calls.filter(call => call.name === 'status').length, 1, 'section changes do not refetch or auto-save');
});

test('home A→B→A rejects old status/error, clears target drafts and acknowledgments, and newest refresh wins', async t => {
  const rig = await managerRig(t);
  const field = () => rig.renderer.root.findAll(node => node.props.label === 'Daemon home' && typeof node.props.onChangeText === 'function')[0];
  await act(async () => rig.renderer.root.findAll(node => node.props.title === 'Advanced' && node.props.subtitle === 'Executable overrides and recovery options')[0].props.onToggle(true));
  await act(async () => field().props.onChangeText('/b'));
  await act(async () => field().props.onChangeText('/a'));
  assert.equal(rig.reads.calls.length, 3);
  await act(async () => {
    rig.reads.calls[0].resolve(runtime({ communicationLanguage: 'old-a' }));
    rig.reads.calls[1].reject(new Error('old-b-error'));
  });
  assert.doesNotMatch(JSON.stringify(rig.renderer.toJSON()), /old-a|old-b-error/);
  await act(async () => rig.reads.calls[2].resolve(runtime()));
  await act(async () => rig.routing().setField('supervisor', 'model')('draft-for-a'));
  await act(async () => rig.renderer.root.findByProps({ title: 'Daemon home confirmed' }).props.onToggle(true));
  await act(async () => field().props.onChangeText('/b'));
  await act(async () => rig.reads.calls[3].resolve(runtime({ target: { hostId: 'host-a', daemonHome: '/b' } })));
  assert.notEqual(rig.routing().form.supervisor.model, 'draft-for-a');
  assert.equal(rig.renderer.root.findByProps({ title: 'Daemon home confirmed' }).props.checked, false);
  const refresh = () => rig.renderer.root.findByProps({ label: 'Refresh' }).props.onPress();
  await act(async () => { refresh(); refresh(); });
  await act(async () => rig.reads.calls[5].resolve(runtime({ communicationLanguage: 'newest-refresh' })));
  await act(async () => rig.reads.calls[4].resolve(runtime({ communicationLanguage: 'older-refresh' })));
  assert.match(JSON.stringify(rig.renderer.toJSON()), /newest-refresh/);
  assert.doesNotMatch(JSON.stringify(rig.renderer.toJSON()), /older-refresh/);
});

test('host A→B→A mounts fresh Manager lifetimes without carrying a home, draft or late status', async t => {
  const rig = await managerRig(t);
  await rig.update({ host: { id: 'host-b', label: 'Host B' } });
  await rig.update({ host: { id: 'host-a', label: 'Host A returned' } });
  assert.deepEqual(rig.reads.calls.map(call => call.input.target.hostId), ['host-a', 'host-b', 'host-a']);
  await act(async () => rig.reads.calls[0].resolve(runtime({ communicationLanguage: 'obsolete-host-a' })));
  await act(async () => rig.reads.calls[1].reject(new Error('obsolete-host-b')));
  assert.doesNotMatch(JSON.stringify(rig.renderer.toJSON()), /obsolete-host-a|obsolete-host-b/);
  await act(async () => rig.reads.calls[2].resolve(runtime({ communicationLanguage: 'current-host-a' })));
  assert.match(JSON.stringify(rig.renderer.toJSON()), /current-host-a/);
});

test('all manager sections and binding retain completed reads on reopen while fresh RPCs are pending', async t => {
  const mod = await loadHooks(t); mod.primitiveState.tree = true;
  const deferred = deferredRpc(), mutations = []; let pending = false, renderer;
  const metadata = { schemaVersion: 1, models: [{ id: 'fixture-model', label: 'Fixture model', thinkingOptions: [{ id: 'high', label: 'high' }] }],
    modes: [{ id: 'full-access', label: 'Full access' }], features: [{ id: 'flag', label: 'Feature flag', type: 'toggle', value: false }], error: null };
  const reads = {
    'local-target': { daemonHome: '/a' }, status: runtime({ embeddedCandidateSha256: A, communicationLanguage: 'Vietnamese' }),
    'get-role-routing': { routing: { schemaVersion: 1, supervisor: { family: 'codex', model: 'fixture-model', modeId: 'full-access', thinkingOptionId: 'high' }, lead: { family: 'codex', model: 'fixture-model' } } },
    'get-peer-pool': { pool: { version: 1, policy: 'Remember this pool', options: [], quotaFallback: { enabled: false, optionId: null } }, sha256: A, error: null, legacy: null, legacyError: null },
    'get-jev': { jev: { configured: true, enabled: true, capabilities: { routing: false, supervision: false }, provider: { kind: 'openrouter', model: 'saved-model', baseUrl: 'https://example.invalid' }, sha256: A, error: null } },
    'get-supervision': { schemaVersion: 2, config: null, sha256: A, observations: [], gates: {}, unverified: [], migration: null, diagnostics: { droppedEvents: 0, reasons: [] }, error: null }, catalog: metadata,
  };
  mod.paseoState.current = { agents: { list: async () => ({ entries: [] }) }, rpc: (contract, input) => {
    if (!(contract.name in reads)) { mutations.push(contract.name); throw Error('Unexpected mutation'); }
    return pending ? deferred.rpc({ name: contract.name, input }) : Promise.resolve(reads[contract.name]);
  } };
  const props = { host: { id: 'host-a', label: 'Fixture' }, layout: { compact: true, platform: 'web' }, theme: { colors }, params: { section: 'profiles' } };
  t.after(async () => { await act(async () => renderer?.unmount()); });
  await act(async () => { renderer = TestRenderer.create(React.createElement(mod.ManagerSurface, props)); });
  const card = name => renderer.root.findAll(node => node.type.name === name)[0];
  assert.equal(card('RoutingCard').props.routing.form.supervisor.model, 'fixture-model');
  await act(async () => renderer.unmount()); pending = true;
  await act(async () => { renderer = TestRenderer.create(React.createElement(mod.ManagerSurface, props)); });
  assert.ok(JSON.stringify(renderer.toJSON()).includes(A), 'binding pin remains visible before status/local-target reads');
  assert.equal(card('RoutingCard').props.routing.form.supervisor.model, 'fixture-model');
  assert.equal(card('RoutingCard').props.routing.fresh, false);
  assert.equal(card('PeerPoolCard').props.pool.poolForm.policy, 'Remember this pool');
  assert.equal(card('PeerPoolCard').props.pool.poolLocked, true);
  assert.equal(card('JevCard').props.jev.model, 'saved-model');
  assert.equal(card('JevCard').props.jev.fresh, false);
  assert.equal(card('SupervisionCard').props.supervision.data.sha256, A);
  assert.equal(card('SupervisionCard').props.supervision.fresh, false);
  assert.ok(renderer.root.findAll(node => node.type.name === 'LanguageCard')[0].props.disabled);
  const fields = card('RoutingCard').findAll(node => node.type.name === 'Field' && ['Mode', 'Feature values (JSON)', 'Thinking option'].includes(node.props.label));
  assert.equal(fields.length, 0, 'cached option controls remain; no transient raw editors');
  assert.ok(JSON.stringify(renderer.toJSON()).includes('Refreshing provider options'));
  assert.equal(renderer.toJSON().children[1].type, 'View', 'a conditional refresh banner must not insert a row above Binding');
  const headerReadStatus = () => renderer.root.findAll(node => node.type === 'Text' && node.props.accessibilityLiveRegion === 'polite'
    && typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.includes(' on Fixture'))[0];
  assert.equal(headerReadStatus().props.numberOfLines, 1);
  assert.equal(headerReadStatus().props.accessibilityLabel, 'Updating saved view on Fixture');
  assert.equal(headerReadStatus().props.accessibilityHint, 'Writes wait for a fresh read.');
  const rootPrefix = renderer.toJSON().children.slice(0, 2).map(node => node.type);

  await act(async () => card('RoutingCard').props.onSave());
  assert.deepEqual(mutations, []);
  for (const section of ['overview', 'pool', 'jev', 'supervision', 'language', 'maintenance']) {
    await act(async () => renderer.update(React.createElement(mod.ManagerSurface, { ...props, params: { section } })));
    assert.ok(JSON.stringify(renderer.toJSON()).includes(A));
  }
  const local = deferred.calls.find(call => call.input.name === 'local-target');
  await act(async () => local.resolve(reads['local-target']));
  const statusCall = deferred.calls.find(call => call.input.name === 'status');
  await act(async () => statusCall.resolve(reads.status));
  assert.deepEqual(renderer.toJSON().children.slice(0, 2).map(node => node.type), rootPrefix, 'fresh completion must not remove an intervening layout row');
  assert.equal(headerReadStatus().props.numberOfLines, 1);
  assert.equal(headerReadStatus().props.accessibilityLabel, 'Runtime and work settings on Fixture');
  assert.equal(headerReadStatus().props.accessibilityHint, undefined);
  assert.equal(renderer.root.findAll(node => node.type.name === 'LanguageCard')[0].props.disabled, false, 'successful fresh status releases its write guard');
  await act(async () => renderer.root.findAll(node => node.props.label === 'Refresh' && typeof node.props.onPress === 'function')[0].props.onPress());
  const failedRefresh = deferred.calls.filter(call => call.input.name === 'status').at(-1);
  await act(async () => failedRefresh.reject(new Error('runtime refresh unavailable')));
  assert.equal(headerReadStatus().props.accessibilityLabel, 'Runtime read unavailable on Fixture');
  assert.equal(renderer.root.findAll(node => node.type.name === 'LanguageCard')[0].props.disabled, true, 'refresh failure never grants writes from retained status');
  assert.ok(JSON.stringify(renderer.toJSON()).includes('runtime refresh unavailable'));
  assert.ok(JSON.stringify(renderer.toJSON()).includes(A), 'failed status refresh does not erase the displayed binding');
  assert.deepEqual(mutations, []);
});


test('cold Profiles keeps catalog-ready controls visible while only feature metadata is pending', async t => {
  const features = deferredRpc();
  const metadata = { schemaVersion: 1, models: [{ id: 'known-model', label: 'Known model', thinkingOptions: [{ id: 'high', label: 'high' }] }],
    modes: [{ id: 'full-access', label: 'Full access' }], features: [], error: null };
  const rig = await managerRig(t, { params: { section: 'profiles' } }, {
    'get-role-routing': async () => ({ routing: { schemaVersion: 1, supervisor: { family: 'codex', model: 'known-model', modeId: 'full-access', thinkingOptionId: 'high' }, lead: { family: 'codex', model: 'known-model' } } }),
    catalog: input => input.model ? features.rpc(input) : Promise.resolve(metadata),
  }, true);
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  assert.equal(features.calls.length, 2);
  const card = rig.renderer.root.findAll(node => node.type.name === 'RoutingCard')[0];
  assert.equal(card.findAll(node => node.type.name === 'OptionPicker' && node.props.label === 'Model').length, 2,
    'Model choices already read must not be hidden behind slower feature metadata');
  assert.ok(card.findAll(node => node.type.name === 'ChipSelect').some(node => node.props.options.some(option => option.label === 'Full access')));
  assert.ok(card.findAll(node => node.type.name === 'ChipSelect').some(node => node.props.options.some(option => option.value === 'high')));
  assert.equal(card.findAll(node => node.type.name === 'Field' && node.props.label === 'Feature values (JSON)').length, 0);
  assert.equal(control(rig, 'Save profiles').props.disabled, true);
  const grid = card.findAll(node => node.props.style?.flexWrap === 'wrap' && node.props.style?.gap === 18)[0];
  assert.ok(grid, 'responsive grid exists before all metadata completes');
  assert.equal(grid.props.onLayout, undefined, 'no second render changes column layout after measuring');
  const firstGridStyle = JSON.stringify(grid.props.style);
  assert.ok(!JSON.stringify(rig.renderer.toJSON()).includes('Loading profile options'));
  await act(async () => { for (const call of features.calls) call.resolve({ ...metadata, features: [{ id: 'flag', label: 'Ready feature', type: 'toggle', value: false }] }); });
  assert.equal(card.findAll(node => node.type.name === 'SwitchRow' && node.props.title === 'Ready feature').length, 2);
  assert.equal(JSON.stringify(grid.props.style), firstGridStyle, 'read completion does not change column geometry');
});


test('binding keeps its badge and verification row mounted before the initial read completes', async t => {
  const mod = await loadHooks(t);
  const renderer = await render(t, mod.RuntimeIdentity, { colors, statusView: null, home: '/a' });
  const badgeCount = () => renderer.root.findAll(node => node.type.name === 'Badge').length;
  const verificationCount = () => renderer.root.findAll(node => node.type.name === 'KV' && node.props.label === 'Last binding verification').length;
  assert.equal(badgeCount(), 1);
  assert.equal(verificationCount(), 1);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Not bound|Not yet verified/);
  await act(async () => renderer.update(React.createElement(mod.RuntimeIdentity, { colors, statusView: runtime({ embeddedCandidateSha256: A }), home: '/a' })));
  assert.equal(badgeCount(), 1); assert.equal(verificationCount(), 1);
});


test('Profiles frame is already mounted before local target and initial status return', async t => {
  const local = deferredRpc(), routing = deferredRpc(), catalogs = deferredRpc();
  const rig = await managerRig(t, { params: { section: 'profiles' } }, {
    'local-target': input => local.rpc(input), 'get-role-routing': input => routing.rpc(input), catalog: input => catalogs.rpc(input),
  }, true);
  const card = () => rig.renderer.root.findAll(node => node.type.name === 'RoutingCard')[0];
  assert.ok(card());
  assert.equal(control(rig, 'Save profiles').props.disabled, true);
  assert.equal(card().findAll(node => node.type.name === 'Field' && ['Mode', 'Thinking option', 'Feature values (JSON)'].includes(node.props.label)).length, 0);
  await act(async () => local.calls[0].resolve({ daemonHome: '/a' }));
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  await act(async () => routing.calls[0].resolve({ routing: { schemaVersion: 1, supervisor: { family: 'codex', model: 'stored-model', modeId: 'stored-mode', thinkingOptionId: 'stored-thinking' }, lead: { family: 'codex' } } }));
  const values = card().findAll(node => node.type.name === 'PendingProfileValue').map(node => node.props.value);
  assert.ok(values.includes('stored-model') && values.includes('stored-mode') && values.includes('stored-thinking'));
  assert.equal(control(rig, 'Save profiles').props.disabled, true);
  assert.ok(card());
});

test('manual Refresh after a fresh read keeps the header row stable and revokes write readiness until completion', async t => {
  const rig = await managerRig(t, {}, {}, true);
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  const subtitle = () => rig.renderer.root.findAll(node => node.type === 'Text' && node.props.accessibilityLiveRegion === 'polite'
    && typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.endsWith(' on Fixture host'))[0];
  const language = () => rig.renderer.root.findAll(node => node.type.name === 'LanguageCard')[0];
  const before = rig.renderer.toJSON().children.slice(0, 2).map(node => node.type);
  assert.equal(language().props.disabled, false);
  await act(async () => control(rig, 'Refresh').props.onPress());
  assert.equal(subtitle().props.accessibilityLabel, 'Updating saved view on Fixture host');
  assert.equal(subtitle().props.numberOfLines, 1);
  assert.equal(subtitle().props.accessibilityHint, 'Writes wait for a fresh read.');
  assert.equal(language().props.disabled, true);
  assert.deepEqual(rig.renderer.toJSON().children.slice(0, 2).map(node => node.type), before);
  await act(async () => rig.reads.calls[1].resolve(runtime()));
  assert.equal(subtitle().props.accessibilityLabel, 'Runtime and work settings on Fixture host');
  assert.equal(language().props.disabled, false);
  assert.deepEqual(rig.renderer.toJSON().children.slice(0, 2).map(node => node.type), before);
});

test('activation transport failure plus failed probe retains its original ID and blocks a replacement submission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starts = deferredRpc();
  const rig = await managerRig(t, {}, { activate: input => starts.rpc(input) }, true);
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  for (const title of ['Exclusive configuration window', 'Daemon home confirmed']) {
    await act(async () => rig.renderer.root.findAll(node => node.props.title === title && typeof node.props.onToggle === 'function')[0].props.onToggle(true));
  }
  const action = () => control(rig, 'Update SLP runtime');
  await act(async () => action().props.onPress());
  const id = starts.calls[0].input.operationId;
  await act(async () => starts.calls[0].reject(new Error('start transport lost')));
  assert.equal(rig.reads.calls[1].input.operationId, id);
  await act(async () => rig.reads.calls[1].reject(new Error('probe transport lost')));
  const tracked = rig.renderer.root.findAll(node => node.props.label === 'Tracked operation' && typeof node.props.value === 'string')[0];
  assert.equal(tracked?.props.value, id, 'uncertain acceptance must retain a structured operation guard');
  assert.equal(action().props.disabled, true);
  await act(async () => action().props.onPress());
  assert.equal(starts.calls.length, 1);
  await act(async () => control(rig, 'Refresh').props.onPress());
  assert.equal(rig.reads.calls.at(-1).input.operationId, id, 'manual inspection targets the original ID');
  await act(async () => rig.reads.calls.at(-1).resolve(runtime({ operation: null })));
  assert.equal(action().props.disabled, true, 'an absent/partial operation cannot erase uncertain acceptance');
  await act(async () => t.mock.timers.tick(5000));
  assert.equal(rig.reads.calls.at(-1).input.operationId, id);
  const operation = { operationId: id, kind: 'activate', phase: 'verify', outcome: 'succeeded',
    startedAt: '2026-10-11T08:00:00Z', updatedAt: '2026-10-11T08:00:01Z', completedAt: '2026-10-11T08:00:01Z' };
  await act(async () => rig.reads.calls.at(-1).resolve(runtime({ operation })));
  assert.equal(action().props.disabled, false, 'exact tracked terminal result resolves the uncertainty');
  assert.equal(starts.calls.length, 1, 'read-only recovery never retries a mutation');
});

for (const observation of ['not-found', 'foreign']) test(`uncertain start with ${observation} probe never automatically mutates or replaces its ID`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starts = deferredRpc();
  const rig = await managerRig(t, {}, { activate: input => starts.rpc(input) }, true);
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  for (const title of ['Exclusive configuration window', 'Daemon home confirmed']) {
    await act(async () => rig.renderer.root.findAll(node => node.props.title === title && typeof node.props.onToggle === 'function')[0].props.onToggle(true));
  }
  await act(async () => control(rig, 'Update SLP runtime').props.onPress());
  const request = starts.calls[0].input, id = request.operationId;
  await act(async () => starts.calls[0].reject(new Error('response dropped')));
  const pending = { operationId: 'foreign-operation', kind: 'activate', phase: 'verify', outcome: 'pending', startedAt: '2026-10-11T08:00:00Z', updatedAt: '2026-10-11T08:00:00Z', completedAt: null };
  await act(async () => rig.reads.calls[1].resolve(runtime(observation === 'not-found'
    ? { operation: null, conflicts: [{ code: 'NOT_FOUND', message: `no operation ${id} in this journal` }] }
    : { operation: pending })));
  assert.equal(starts.calls.length, 1, 'even confirmed absence is not an automatic retry');
  assert.equal(control(rig, 'Update SLP runtime').props.disabled, true);
  const tracked = () => rig.renderer.root.findAll(node => node.props.label === 'Tracked operation' && typeof node.props.value === 'string')[0];
  assert.equal(tracked().props.value, id);
  if (observation === 'foreign') {
    assert.equal(control(rig, 'Retry original operation'), undefined, 'foreign operation cannot authorize retry');
    await act(async () => control(rig, 'Refresh').props.onPress());
    assert.equal(rig.reads.calls.at(-1).input.operationId, id);
    await act(async () => rig.reads.calls.at(-1).resolve(runtime({ operation: { ...pending, operationId: id, outcome: 'failed', completedAt: '2026-10-11T08:00:01Z' } })));
    assert.equal(tracked(), undefined, 'manual exact terminal inspection resolves the original guard');
    assert.equal(starts.calls.length, 1);
    return;
  }
  const retry = () => control(rig, 'Retry original operation');
  assert.equal(retry().props.disabled, false);
  const ack = rig.renderer.root.findAll(node => node.props.title === 'Daemon home confirmed' && typeof node.props.onToggle === 'function')[0];
  await act(async () => ack.props.onToggle(false));
  assert.equal(retry().props.disabled, true);
  await act(async () => retry().props.onPress());
  assert.equal(starts.calls.length, 1);
  await act(async () => ack.props.onToggle(true));
  await act(async () => { retry().props.onPress(); retry().props.onPress(); });
  assert.equal(starts.calls.length, 2, 'an explicit same-ID retry dispatches once');
  assert.deepEqual(starts.calls[1].input, request, 'retry preserves all original target/candidate/authority/payload bytes');
  await act(async () => starts.calls[1].reject(new Error('retry response also lost')));
  assert.equal(rig.reads.calls.at(-1).input.operationId, id);
  await act(async () => rig.reads.calls.at(-1).reject(new Error('second probe failed')));
  assert.equal(tracked().props.value, id);
  assert.equal(starts.calls.length, 2, 'a second transport failure remains read-only until explicit retry');
});

test('chained Save Apply transport uncertainty keeps saved choices and original operation tracking', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starts = deferredRpc();
  const rig = await managerRig(t, { params: { section: 'profiles' } }, {
    'set-role-routing': async input => ({ routing: input.routing }), activate: input => starts.rpc(input),
  }, true);
  await act(async () => rig.reads.calls[0].resolve(runtime({ embeddedCandidateSha256: A })));
  await act(async () => rig.routing().setField('supervisor', 'model')('saved-model'));
  await act(async () => control(rig, 'Save profiles').props.onPress());
  await acknowledge(rig);
  await act(async () => control(rig, 'Save and apply').props.onPress());
  await act(async () => rig.reads.calls[1].resolve(runtime({ embeddedCandidateSha256: A })));
  const id = starts.calls[0].input.operationId;
  await act(async () => starts.calls[0].reject(new Error('Apply response lost')));
  await act(async () => rig.reads.calls[2].reject(new Error('Apply probe lost')));
  assert.equal(rig.routing().saved, true);
  assert.equal(rig.routing().form.supervisor.model, 'saved-model');
  assert.ok(JSON.stringify(rig.renderer.toJSON()).includes('Saved; Apply outcome unconfirmed'));
  const card = rig.renderer.root.findAll(node => node.type.name === 'RoutingCard')[0];
  await act(async () => card.props.onSave());
  assert.equal(starts.calls.length, 1);
  assert.equal(rig.calls.filter(call => call.name === 'set-role-routing').length, 1);
  assert.equal(rig.renderer.root.findAll(node => node.props.label === 'Tracked operation' && node.props.value === id).length > 0, true);
});

for (const reject of [false, true]) for (const startNext of [false, true]) test(`terminal poll during identical retry settles busy before delayed retry ${reject ? 'rejection' : 'success'} with ${startNext ? 'a newer' : 'no newer'} operation`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starts = deferredRpc();
  const rig = await managerRig(t, {}, { activate: input => starts.rpc(input) }, true);
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  for (const title of ['Exclusive configuration window', 'Daemon home confirmed']) {
    await act(async () => rig.renderer.root.findAll(node => node.props.title === title && typeof node.props.onToggle === 'function')[0].props.onToggle(true));
  }
  await act(async () => control(rig, 'Update SLP runtime').props.onPress());
  const original = starts.calls[0].input, id = original.operationId;
  await act(async () => starts.calls[0].reject(new Error('initial response lost')));
  await act(async () => rig.reads.calls[1].resolve(runtime({ operation: null, conflicts: [{ code: 'NOT_FOUND', message: `no operation ${id} in journal` }] })));
  assert.equal(starts.calls.length, 1, 'confirmed absence alone does not retry');
  await act(async () => control(rig, 'Retry original operation').props.onPress());
  assert.equal(starts.calls.length, 2);
  assert.deepEqual(starts.calls[1].input, original);
  assert.equal(control(rig, 'Refresh').props.disabled, true, 'retry invocation initially owns busy');
  await act(async () => t.mock.timers.tick(1000));
  const poll = rig.reads.calls.at(-1);
  assert.equal(poll.input.operationId, id);
  const terminal = { operationId: id, kind: 'activate', phase: 'verify', outcome: 'succeeded',
    startedAt: '2026-10-11T09:00:00Z', updatedAt: '2026-10-11T09:00:01Z', completedAt: '2026-10-11T09:00:01Z' };
  await act(async () => poll.resolve(runtime({ operation: terminal })));
  assert.equal(control(rig, 'Refresh').props.disabled, false, 'exact terminal poll settles the retry invocation busy ownership');
  assert.equal(control(rig, 'Update SLP runtime').props.disabled, false);
  assert.equal(rig.renderer.root.findAll(node => node.props.label === 'Tracked operation').length, 0);
  const beforeNext = rig.reads.calls.length;
  if (startNext) await act(async () => control(rig, 'Update SLP runtime').props.onPress());
  assert.equal(starts.calls.length, startNext ? 3 : 2, 'a subsequent operation requires another explicit action');
  const nextId = startNext ? starts.calls[2].input.operationId : null;
  if (startNext) assert.notEqual(nextId, id);
  assert.equal(control(rig, 'Refresh').props.disabled, startNext);
  await act(async () => {
    if (reject) starts.calls[1].reject(new Error('late old retry rejection'));
    else starts.calls[1].resolve({ schemaVersion: 1, accepted: true, state: 'ACTIVATING', operation: { ...terminal, outcome: 'pending', completedAt: null }, conflicts: [], pollAfterMs: 1000 });
  });
  assert.equal(control(rig, 'Refresh').props.disabled, startNext, 'old retry completion cannot alter resolved/newer busy state');
  assert.equal(rig.reads.calls.length, beforeNext, 'retired retry does not issue a stale status refresh/probe');
  assert.doesNotMatch(JSON.stringify(rig.renderer.toJSON()), /late old retry rejection/);
  if (!startNext) {
    assert.ok(JSON.stringify(rig.renderer.toJSON()).includes(`Operation ${id} resolved: succeeded.`));
    assert.equal(control(rig, 'Update SLP runtime').props.disabled, false);
    return;
  }
  assert.ok(JSON.stringify(rig.renderer.toJSON()).includes(`Starting operation ${nextId}`));
  await act(async () => starts.calls[2].resolve({ schemaVersion: 1, accepted: true, state: 'ACTIVE', operation: { ...terminal, operationId: nextId }, conflicts: [], pollAfterMs: 0 }));
  assert.equal(rig.reads.calls.at(-1).input.operationId, nextId);
  await act(async () => rig.reads.calls.at(-1).resolve(runtime({ operation: { ...terminal, operationId: nextId } })));
  assert.equal(control(rig, 'Refresh').props.disabled, false);
  assert.equal(control(rig, 'Update SLP runtime').props.disabled, false);
});

test('an obsolete failed status probe cannot repaint a terminal resolution or newer operation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starts = deferredRpc();
  const rig = await managerRig(t, {}, { activate: input => starts.rpc(input) }, true);
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  for (const title of ['Exclusive configuration window', 'Daemon home confirmed']) {
    await act(async () => rig.renderer.root.findAll(node => node.props.title === title && typeof node.props.onToggle === 'function')[0].props.onToggle(true));
  }
  await act(async () => control(rig, 'Update SLP runtime').props.onPress());
  const id = starts.calls[0].input.operationId;
  await act(async () => starts.calls[0].reject(new Error('start response lost')));
  const probe = rig.reads.calls[1];
  assert.equal(probe.input.operationId, id);
  await act(async () => t.mock.timers.tick(1000));
  const poll = rig.reads.calls[2];
  assert.equal(poll.input.operationId, id);
  const terminal = { operationId: id, kind: 'activate', phase: 'verify', outcome: 'succeeded',
    startedAt: '2026-10-11T09:00:00Z', updatedAt: '2026-10-11T09:00:01Z', completedAt: '2026-10-11T09:00:01Z' };
  await act(async () => poll.resolve(runtime({ operation: terminal })));
  assert.equal(control(rig, 'Refresh').props.disabled, false);
  await act(async () => control(rig, 'Update SLP runtime').props.onPress());
  const nextId = starts.calls[1].input.operationId;
  await act(async () => probe.reject(new Error('old probe finally failed')));
  assert.equal(control(rig, 'Refresh').props.disabled, true);
  assert.ok(JSON.stringify(rig.renderer.toJSON()).includes(`Starting operation ${nextId}`));
  assert.doesNotMatch(JSON.stringify(rig.renderer.toJSON()), /old probe finally failed|status probe failed as well/);
  assert.equal(starts.calls.length, 2);
});

for (const reply of ['accepted', 'transport-error']) for (const timing of ['away', 'returned']) {
  test(`initial start survives home A→B→A with ${reply} reply while ${timing}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const starts = deferredRpc();
    const rig = await managerRig(t, { params: { section: 'maintenance' } }, { activate: input => starts.rpc(input) }, true);
    const atA = over => runtime({ target: { hostId: 'host-a', daemonHome: '/a' }, ...over });
    const action = () => control(rig, 'Update SLP runtime');
    const tracked = () => rig.renderer.root.findAll(node => node.props.label === 'Tracked operation' && typeof node.props.value === 'string')[0]?.props.value;
    const ack = async () => {
      for (const title of ['Exclusive configuration window', 'Daemon home confirmed']) {
        await act(async () => rig.renderer.root.findAll(node => node.props.title === title && typeof node.props.onToggle === 'function')[0].props.onToggle(true));
      }
    };
    await act(async () => rig.reads.calls[0].resolve(atA()));
    await ack();
    await act(async () => action().props.onPress());
    const input = starts.calls[0].input, id = input.operationId;
    const operation = { operationId: id, kind: 'activate', phase: 'verify', outcome: 'pending',
      startedAt: '2026-10-11T17:00:00Z', updatedAt: '2026-10-11T17:00:00Z', completedAt: null };
    const deliver = () => act(async () => {
      if (reply === 'transport-error') starts.calls[0].reject(new Error('original response lost'));
      else starts.calls[0].resolve({ schemaVersion: 1, accepted: true, state: 'ACTIVATING', operation, conflicts: [], pollAfterMs: 1000 });
    });
    await act(async () => rig.renderer.root.findAll(node => node.props.title === 'Advanced' && node.props.subtitle === 'Executable overrides and recovery options')[0].props.onToggle(true));
    const home = value => act(async () => rig.renderer.root.findAll(node => node.props.label === 'Daemon home' && typeof node.props.onChangeText === 'function')[0].props.onChangeText(value));
    await home('/b');
    await act(async () => rig.reads.calls.at(-1).resolve(runtime({ target: { hostId: 'host-a', daemonHome: '/b' } })));
    if (timing === 'away') await deliver();
    assert.equal(tracked(), undefined, 'old-target operation must not paint over B');
    await home('/a');
    assert.equal(rig.reads.calls.at(-1).input.operationId, id, 'return inspection must query the unresolved original ID');
    await act(async () => rig.reads.calls.at(-1).resolve(atA()));
    await ack();
    assert.equal(tracked(), id);
    assert.equal(action().props.disabled, true, 'an empty status read cannot release the original start guard');
    await act(async () => action().props.onPress());
    assert.equal(starts.calls.length, 1, 'returning cannot dispatch a replacement ID');
    if (timing === 'returned') await deliver();
    await act(async () => t.mock.timers.tick(1000));
    const poll = rig.reads.calls.at(-1);
    assert.equal(poll.input.operationId, id);
    if (reply === 'transport-error') {
      await act(async () => poll.resolve(atA({ conflicts: [{ code: 'NOT_FOUND', message: 'no original journal entry yet' }] })));
      assert.equal(action().props.disabled, true);
      const retry = control(rig, 'Retry original operation');
      assert.equal(retry?.props.disabled, false, 'only fresh explicit absence permits a same-ID retry');
      assert.equal(starts.calls.length, 1, 'no automatic mutation retry');
      await act(async () => retry.props.onPress());
      assert.equal(starts.calls.length, 2);
      assert.deepEqual(starts.calls[1].input, input, 'explicit retry retains target/candidate/authority and every payload field');
    } else {
      await act(async () => poll.resolve(atA({ operation })));
      assert.equal(action().props.disabled, true);
    }
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(rig.reads.calls.at(-1).input.operationId, id);
    await act(async () => rig.reads.calls.at(-1).resolve(atA({ operation: { ...operation, outcome: 'succeeded', completedAt: '2026-10-11T17:00:01Z' } })));
    assert.equal(tracked(), undefined);
    assert.equal(action().props.disabled, false, 'an exact terminal read releases both tracking and invocation busy');
    assert.equal(control(rig, 'Refresh').props.disabled, false);
  });
}

for (const reject of [false, true]) test(`returned home terminal poll retires the initial start before its late ${reject ? 'error' : 'success'}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starts = deferredRpc();
  const rig = await managerRig(t, { params: { section: 'maintenance' } }, { activate: input => starts.rpc(input) }, true);
  await act(async () => rig.reads.calls[0].resolve(runtime()));
  const ack = async () => {
    for (const title of ['Exclusive configuration window', 'Daemon home confirmed']) {
      await act(async () => rig.renderer.root.findAll(node => node.props.title === title && typeof node.props.onToggle === 'function')[0].props.onToggle(true));
    }
  };
  await ack();
  await act(async () => control(rig, 'Update SLP runtime').props.onPress());
  const id = starts.calls[0].input.operationId;
  await act(async () => rig.renderer.root.findAll(node => node.props.title === 'Advanced' && node.props.subtitle === 'Executable overrides and recovery options')[0].props.onToggle(true));
  const home = value => act(async () => rig.renderer.root.findAll(node => node.props.label === 'Daemon home' && typeof node.props.onChangeText === 'function')[0].props.onChangeText(value));
  await home('/b');
  await home('/a');
  const terminal = { operationId: id, kind: 'activate', phase: 'verify', outcome: 'succeeded',
    startedAt: '2026-10-11T17:00:00Z', updatedAt: '2026-10-11T17:00:01Z', completedAt: '2026-10-11T17:00:01Z' };
  assert.equal(rig.reads.calls.at(-1).input.operationId, id);
  await act(async () => rig.reads.calls.at(-1).resolve(runtime({ operation: terminal })));
  await ack();
  assert.equal(control(rig, 'Refresh').props.disabled, false);
  assert.equal(control(rig, 'Update SLP runtime').props.disabled, false);
  await act(async () => control(rig, 'Update SLP runtime').props.onPress());
  const nextId = starts.calls[1].input.operationId;
  assert.notEqual(nextId, id);
  const readCount = rig.reads.calls.length;
  await act(async () => {
    if (reject) starts.calls[0].reject(new Error('retired original error'));
    else starts.calls[0].resolve({ schemaVersion: 1, accepted: true, state: 'ACTIVATING', operation: { ...terminal, outcome: 'pending', completedAt: null }, conflicts: [], pollAfterMs: 1000 });
  });
  assert.equal(rig.reads.calls.length, readCount, 'retired callback cannot probe or refresh');
  assert.equal(control(rig, 'Refresh').props.disabled, true, 'new invocation retains busy ownership');
  const text = JSON.stringify(rig.renderer.toJSON());
  assert.ok(text.includes(`Starting operation ${nextId}`));
  assert.doesNotMatch(text, /retired original error/);
});
