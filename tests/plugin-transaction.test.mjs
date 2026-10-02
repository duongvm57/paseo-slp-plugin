// tests/plugin-transaction.test.mjs — transaction-lane coverage for the
// Option A v1 manager: activation/rebind/deactivate happy paths, idempotency,
// collision/drift gates, schema-loss detection, and journal behavior. Doubles
// do real filesystem work in temporary homes and live in
// tests/helpers/plugin-doubles.mjs; the daemon config surface uses the
// installed @getpaseo/server DaemonConfigStore when host modules resolve
// (resolution order in the helper — PASEO_CLI_MODULES env, npm root -g, the
// paseo bin prefix, fnm installs) and a line-faithful MiniStore port otherwise,
// with a loud warning when real-backend parity coverage is skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createManager } from '../plugin/server/manager.ts';
import { createStateStore } from '../plugin/server/state-store.ts';
import {
  assertPersistedCompatible,
  desiredProviderEntries,
  patchForDirection,
} from '../plugin/server/config-transaction.ts';
import { OperationConflict, OwnedProvider, PEER_PASEO_TOOLS_POLICY } from '../plugin/shared/contracts.ts';
import { FAMILY_LABEL } from '../plugin/shared/runtime/families.ts';
import { providerWrittenFieldsEqual } from '../plugin/server/config-view.ts';
import { peerPaseoToolsPolicy } from '../plugin/server/runtime/cli/profiles.ts';
import {
  MiniStore,
  FAMILIES,
  OWNED_IDS,
  activateInput,
  deactivateInput,
  initialMutable,
  isRecord,
  loadRealBackend,
  makeBinaries,
  makeDaemon,
  makeDeps,
  makeHome,
  makeMaterializer,
  makePayload,
  makePluginFixture,
  opConflicts,
  opOf,
  readConfigJson,
  readReceipt,
  receiptPath,
  sha256,
  slpProvidersOf,
  statusInput,
  targetOf,
  waitTerminal,
} from './helpers/plugin-doubles.mjs';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('plugin provider generation and receipt schemas carry the Peer Paseo tool policy only', () => {
  assert.deepEqual(PEER_PASEO_TOOLS_POLICY.disabledTools, peerPaseoToolsPolicy.disabledTools);
  assert.deepEqual(PEER_PASEO_TOOLS_POLICY.disabledTools, [...PEER_PASEO_TOOLS_POLICY.disabledTools].sort());

  const launchSet = {
    launchSetSha256: 'fixture-launch-set',
    files: OWNED_IDS.map(id => ({ path: `/launchers/${id}` })),
  };
  const resolution = {
    node: { path: '/usr/bin/node' },
    binaries: Object.fromEntries(FAMILIES.map(family => [family, { available: true, path: `/usr/bin/${family}` }])),
  };
  const entries = desiredProviderEntries(launchSet, resolution, '/slp/runtime', '/paseo');
  for (const family of FAMILIES) {
    assert.deepEqual(entries[`slp-${family}-peer`].paseoTools, {
      disabledTools: PEER_PASEO_TOOLS_POLICY.disabledTools,
    });
    for (const role of ['supervisor', 'lead']) {
      assert.equal(Object.hasOwn(entries[`slp-${family}-${role}`], 'paseoTools'), false);
    }
  }

  const ownedPeer = {
    extends: 'codex',
    label: 'SLP Codex Peer',
    command: ['/launchers/slp-codex-peer'],
    env: {},
    enabled: true,
    paseoTools: PEER_PASEO_TOOLS_POLICY,
  };
  assert.equal(OwnedProvider.safeParse(ownedPeer).success, true);
  assert.equal(providerWrittenFieldsEqual(ownedPeer, { ...ownedPeer, paseoTools: { disabledTools: [] } }), false);
});

test('happy activate: INACTIVE → ACTIVE, providers/profiles/injection written, binding committed', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const opId = randomUUID();

  const start = await manager.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  assert.equal(start.state, 'ACTIVATING');
  assert.equal(start.operation?.operationId, opId);
  assert.equal(start.operation?.outcome, 'pending');
  assert.equal(start.pollAfterMs, 1000);

  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'ACTIVE');
  assert.equal(done.binding?.candidateSha256, deps.payload.candidate.sha256);
  assert.equal(done.retainedRuntimeCount, 1);
  assert.ok(done.verifiedAt);

  const config = readConfigJson(home);
  assert.equal(config.daemon.mcp.enabled, true);
  assert.equal(config.daemon.mcp.injectIntoAgents, true);
  const providers = slpProvidersOf(config);
  assert.equal(Object.keys(providers).length, 12);
  for (const id of OWNED_IDS) {
    const family = id.split('-')[1];
    const role = id.split('-')[2];
    const entry = providers[id];
    const roleLabel = id.split('-')[2][0].toUpperCase() + id.split('-')[2].slice(1);
    assert.equal(entry.enabled, true);
    assert.equal(entry.env.SLP_SESSION_OPEN_GRANT, '');
    // Every entry's argv[0] is a real launch-set launcher — devin's runs the
    // shim+wrapper, hook families' run the sentinel gate. All commands are
    // single-element (the host's argv0 --version probe drops the tail).
    assert.equal(entry.command.length, 1);
    assert.ok(entry.command[0].includes(`${home}/slp-runtime/launchers/`), `command for ${id}`);
    assert.equal(entry.env.SLP_MANAGED_RUNTIME, '1');
    assert.equal(entry.env.PASEO_HOME, home);
    assert.ok(entry.env.SLP_NODE_BIN, `SLP_NODE_BIN for ${id}`);
    if (role === 'peer') {
      assert.deepEqual(entry.paseoTools, { disabledTools: PEER_PASEO_TOOLS_POLICY.disabledTools });
    } else {
      assert.equal(Object.hasOwn(entry, 'paseoTools'), false);
    }
    // One label template for every transport: `SLP <Family> <Role>` with
    // FAMILY_LABEL as the single display-name source.
    assert.equal(entry.label, `SLP ${FAMILY_LABEL[family]} ${roleLabel}`);
    if (family === 'devin') {
      assert.equal(entry.env.SLP_DEVIN_BIN, binaries.devin);
      continue;
    }
    // Hook families are sentinel-gated thin aliases: same launcher shape,
    // managed env backstop, plus the family binary the gate execs through.
    assert.equal(entry.env.SLP_FAMILY_BIN, binaries[family]);
    assert.equal(entry.env[`SLP_${family.toUpperCase()}_BIN`], binaries[family]);
    assert.equal(entry.env.SLP_RUNTIME_ROOT, join(home, 'slp-runtime', deps.payload.candidate.sha256));
  }
  const profileIds = config.daemon.agentProfiles.map(p => p.id);
  assert.ok(profileIds.includes('slp-supervisor'));
  assert.ok(profileIds.includes('slp-lead'));
  assert.equal(providers['slp-codex-lead'].extends, 'codex');
  assert.equal(providers['slp-devin-lead'].extends, 'acp');

  const runtimeDir = join(home, 'slp-runtime');
  assert.ok(existsSync(join(runtimeDir, deps.payload.candidate.sha256, 'installed.json')));
  assert.ok(existsSync(receiptPath(home)));
  assert.equal(lstatSync(receiptPath(home)).mode & 0o777, 0o600);
});

test('idempotent retry: same operationId + same payload returns the existing operation', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  let gateResolve;
  const gate = new Promise(r => (gateResolve = r));
  const deps = makeDeps({
    execOpts: { binaries },
    materializerHooks: { beforeMaterialize: () => gate },
  });
  const manager = createManager(deps);
  const opId = randomUUID();
  const input = activateInput(home, deps.payload, opId);

  const first = await manager.activate(input, daemon);
  assert.equal(first.accepted, true);
  // Dropped start response: retry with the identical request while pending.
  const retry = await manager.activate(input, daemon);
  assert.equal(retry.accepted, true);
  assert.equal(retry.operation.operationId, opId);
  assert.equal(retry.operation.outcome, 'pending');
  assert.equal(daemon.patchCalls.length, 0);
  gateResolve();
  await waitTerminal(manager, home, opId, daemon);
});

test('same operationId with a changed payload → IDEMPOTENCY_CONFLICT', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const opId = randomUUID();
  const first = await manager.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(first.accepted, true);
  await waitTerminal(manager, home, opId, daemon);
  const changed = activateInput(home, deps.payload, opId, { adoptIdentical: true });
  const retry = await manager.activate(changed, daemon);
  assert.equal(retry.accepted, false);
  assert.equal(retry.conflicts[0].code, 'IDEMPOTENCY_CONFLICT');
});

test('competing mutation start while a worker is in flight → BUSY', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  let gateResolve;
  const gate = new Promise(r => (gateResolve = r));
  const deps = makeDeps({
    execOpts: { binaries },
    materializerHooks: { beforeMaterialize: () => gate },
  });
  const manager = createManager(deps);
  const first = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  assert.equal(first.accepted, true);
  const second = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  assert.equal(second.accepted, false);
  assert.equal(second.conflicts[0].code, 'BUSY');
  gateResolve();
  await waitTerminal(manager, home, first.operation.operationId, daemon);
});

test('re-activate with identical target verifies and returns no-op, no patch', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const first = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, first.operation.operationId, daemon);
  const patchCount = daemon.patchCalls.length;

  const again = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  assert.equal(again.accepted, true);
  const done = await waitTerminal(manager, home, again.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'no-op');
  assert.equal(daemon.patchCalls.length, patchCount, 'identical activate must not patch');
});

test('mcp.enabled=false in live config → MCP_DISABLED, nothing written', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t, { version: 1, daemon: { mcp: { enabled: false } } });
  const manager = createManager(deps);
  const opId = randomUUID();
  const start = await manager.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.equal(done.state, 'INACTIVE');
  assert.ok(opConflicts(home, opId).includes('MCP_DISABLED'));
  assert.equal(daemon.patchCalls.length, 0);
  assert.equal(readConfigJson(home).daemon.mcp.enabled, false);
});

test('live mcp.enabled overridden true while raw is false → RAW_LIVE_DIVERGENCE', async t => {
  const home = makeHome(t, { version: 1, daemon: { mcp: { enabled: false } } });
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home, { overrides: { mcpEnabled: true } });
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const opId = randomUUID();
  await manager.activate(activateInput(home, deps.payload, opId), daemon);
  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.equal(done.state, 'INACTIVE');
  assert.ok(opConflicts(home, opId).includes('RAW_LIVE_DIVERGENCE'));
  assert.equal(daemon.patchCalls.length, 0);
});

test('pre-existing slp-* provider without adoptIdentical → COLLISION', async t => {
  const home = makeHome(t, {
    version: 1,
    daemon: { mcp: { enabled: true } },
    agents: {
      providers: {
        'slp-codex-lead': {
          extends: 'codex',
          label: 'old install',
          command: ['/old/path'],
          env: {},
          enabled: true,
        },
      },
    },
  });
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const opId = randomUUID();
  const start = await manager.activate(activateInput(home, deps.payload, opId), daemon);
  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, opId).includes('COLLISION'));
  assert.equal(daemon.patchCalls.length, 0);
  assert.equal(readConfigJson(home).agents.providers['slp-codex-lead'].command[0], '/old/path');
});

test('adoptIdentical adopts byte-identical entries with baseline adopted-observed', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const first = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, first.operation.operationId, daemon);

  // Journal lost (e.g. state dir wiped) but config + runtime dirs remain: a
  // re-activation sees identical entries and adopts them explicitly.
  rmSync(join(home, 'slp-runtime', 'state'), { recursive: true, force: true });
  const manager2 = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const opId = randomUUID();
  const start = await manager2.activate(
    activateInput(home, deps.payload, opId, { adoptIdentical: true }),
    daemon,
  );
  assert.equal(start.accepted, true);
  const done = await waitTerminal(manager2, home, opId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'ACTIVE');
  assert.equal(done.binding.baseline, 'adopted-observed');
});

test('adoptIdentical with a differing entry → COLLISION with expected/actual hashes', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const first = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, first.operation.operationId, daemon);

  rmSync(join(home, 'slp-runtime', 'state'), { recursive: true, force: true });
  const config = readConfigJson(home);
  config.agents.providers['slp-codex-lead'].label = 'tampered';
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

  const daemon2 = await makeDaemon(t, home);
  const manager2 = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const opId = randomUUID();
  await manager2.activate(activateInput(home, deps.payload, opId, { adoptIdentical: true }), daemon2);
  const done = await waitTerminal(manager2, home, opId, daemon2);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, opId).includes('COLLISION'));
  const conflict = readReceipt(home).operations.find(o => o.operationId === opId).conflicts.find(c => c.code === 'COLLISION');
  assert.ok(conflict.expectedSha256 && conflict.actualSha256 && conflict.expectedSha256 !== conflict.actualSha256);
  assert.equal(daemon2.patchCalls.length, 0);
});

test('legacy slp-peer-* profile → COLLISION migration conflict', async t => {
  const home = makeHome(t, {
    version: 1,
    daemon: {
      mcp: { enabled: true },
      agentProfiles: [{ id: 'slp-peer-engineer', name: 'legacy', provider: 'codex' }],
    },
  });
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const opId = randomUUID();
  await manager.activate(activateInput(home, deps.payload, opId), daemon);
  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, opId).includes('COLLISION'));
  assert.equal(daemon.patchCalls.length, 0);
});

test('unrelated config is preserved byte-for-byte across activation and deactivation', async t => {
  const home = makeHome(t, {
    version: 1,
    $schema: 'https://example.test/schema.json',
    daemon: {
      mcp: { enabled: true },
      appendSystemPrompt: 'keep me',
      agentProfiles: [{ id: 'user-profile', name: 'Mine', provider: 'codex', model: 'm1' }],
    },
    agents: {
      providers: { codex: { enabled: true } },
      metadataGeneration: { providers: [{ provider: 'codex', model: 'mm' }] },
    },
    worktrees: { root: '/tmp/wt' },
  });
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');
  let config = readConfigJson(home);
  assert.equal(config.daemon.appendSystemPrompt, 'keep me');
  assert.equal(config.daemon.agentProfiles[0].id, 'user-profile');
  assert.equal(config.daemon.agentProfiles[0].model, 'm1');
  assert.equal(config.agents.providers.codex.enabled, true);
  assert.equal(config.worktrees.root, '/tmp/wt');
  assert.equal(config.$schema, 'https://example.test/schema.json');
  // Owned profiles append after unrelated entries.
  assert.deepEqual(config.daemon.agentProfiles.map(p => p.id), ['user-profile', 'slp-supervisor', 'slp-lead']);

  const bindingSha = doneAct.binding.bindingSha256;
  const deact = await manager.deactivate(deactivateInput(home, randomUUID(), bindingSha), daemon);
  const doneDeact = await waitTerminal(manager, home, deact.operation.operationId, daemon);
  assert.equal(doneDeact.state, 'INACTIVE');
  config = readConfigJson(home);
  assert.equal(config.daemon.appendSystemPrompt, 'keep me');
  assert.deepEqual(config.daemon.agentProfiles.map(p => p.id), ['user-profile']);
  assert.equal(Object.keys(slpProvidersOf(config)).length, 0);
  // injectIntoAgents was absent before activation → restored semantically as explicit false.
  assert.equal(config.daemon.mcp.injectIntoAgents, false);
});

test('deactivate semantic restore: absent injectIntoAgents → explicit false', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t, { version: 1, daemon: { mcp: { enabled: true } } });
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(readConfigJson(home).daemon.mcp.injectIntoAgents, true);
  const deact = await manager.deactivate(deactivateInput(home, randomUUID(), doneAct.binding.bindingSha256), daemon);
  const done = await waitTerminal(manager, home, deact.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  const config = readConfigJson(home);
  assert.equal(config.daemon.mcp.injectIntoAgents, false, 'absent flag restores semantically as explicit false');
  assert.equal(Object.keys(slpProvidersOf(config)).length, 0);
  const status = await manager.status(statusInput(home), daemon);
  assert.equal(status.state, 'INACTIVE');
  assert.equal(status.binding, null);
});

test('set-language writes, reports and clears the plugin-owned language file', async t => {
  const home = makeHome(t);
  const daemon = await makeDaemon(t, home);
  const manager = createManager(makeDeps());
  const store = createStateStore();
  const file = join(home, 'slp-runtime', 'state', 'communication-language');

  // Unset → status reports null (seats keep the model default).
  const before = await manager.status(statusInput(home), daemon);
  assert.equal(before.communicationLanguage, null);
  assert.equal(existsSync(file), false);

  // Set → the file lands verbatim; status reports it.
  const set = await store.setLanguage({ schemaVersion: 1, target: targetOf(home), value: 'Vietnamese' });
  assert.deepEqual(set, { schemaVersion: 1, value: 'Vietnamese' });
  assert.equal(readFileSync(file, 'utf8'), 'Vietnamese\n');
  const during = await manager.status(statusInput(home), daemon);
  assert.equal(during.communicationLanguage, 'Vietnamese');

  // Clear → file removed, status null again.
  const cleared = await store.setLanguage({ schemaVersion: 1, target: targetOf(home), value: null });
  assert.deepEqual(cleared, { schemaVersion: 1, value: null });
  assert.equal(existsSync(file), false);
  const after = await manager.status(statusInput(home), daemon);
  assert.equal(after.communicationLanguage, null);

  // Schema guards the write: empty/whitespace values are refused.
  await assert.rejects(() =>
    store.setLanguage({ schemaVersion: 1, target: targetOf(home), value: '   ' }),
    /invalid set-language input/);
});

test('deactivate with present injectIntoAgents=false restores false (not absent)', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t, { version: 1, daemon: { mcp: { enabled: true, injectIntoAgents: false } } });
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  const deact = await manager.deactivate(deactivateInput(home, randomUUID(), doneAct.binding.bindingSha256), daemon);
  await waitTerminal(manager, home, deact.operation.operationId, daemon);
  const config = readConfigJson(home);
  assert.equal(config.daemon.mcp.injectIntoAgents, false);
  assert.ok(Object.hasOwn(config.daemon.mcp, 'injectIntoAgents'));
});

test('profilesPresent records RAW key presence: absent vs explicit [] stay distinct', async t => {
  // The recorded projection stores raw truth — the absent≡empty equivalence
  // exists only at §8.3 comparison sites, never in receipt projections/hashes.
  const activate = async config => {
    const { home, binaries, daemon, deps } = await makePluginFixture(t, config);
    const manager = createManager(deps);
    const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
    await waitTerminal(manager, home, act.operation.operationId, daemon);
    return { home, deps };
  };
  const absent = await activate({ version: 1, daemon: { mcp: { enabled: true } } });
  const explicitEmpty = await activate({ version: 1, daemon: { mcp: { enabled: true }, agentProfiles: [] } });
  const receiptAbsent = readReceipt(absent.home);
  const receiptEmpty = readReceipt(explicitEmpty.home);
  assert.equal(receiptAbsent.binding.beforeActivation.owned.profilesPresent, false);
  assert.equal(receiptEmpty.binding.beforeActivation.owned.profilesPresent, true);
  assert.notEqual(
    receiptAbsent.binding.beforeActivation.allProfilesSha256,
    receiptEmpty.binding.beforeActivation.allProfilesSha256,
    'absent and explicit [] must hash distinctly',
  );
  // The activation endpoint always records presence — the patch writes the
  // key regardless of array contents.
  assert.equal(receiptAbsent.binding.owned.profilesPresent, true);
  assert.equal(receiptEmpty.binding.owned.profilesPresent, true);

  // A removal endpoint is equally raw: the inverse patch writes agentProfiles
  // explicitly, so afterOwned.profilesPresent is true even when the remaining
  // array is empty.
  const daemon = await makeDaemon(t, explicitEmpty.home);
  const manager2 = createManager(makeDeps({ payload: explicitEmpty.deps.payload, execOpts: { binaries: makeBinaries(t) } }));
  const bindingSha = receiptEmpty.binding.bindingSha256;
  const deactId = randomUUID();
  await manager2.deactivate(deactivateInput(explicitEmpty.home, deactId, bindingSha), daemon);
  await waitTerminal(manager2, explicitEmpty.home, deactId, daemon);
  const deactOp = opOf(explicitEmpty.home, deactId);
  assert.equal(deactOp.plan.afterOwned.profilesPresent, true, 'removal endpoint records raw written key');
  assert.equal(deactOp.plan.afterOwned.profiles.length, 0);
  assert.ok(Object.hasOwn(readConfigJson(explicitEmpty.home).daemon, 'agentProfiles'));
});

test('deactivate blocked by DEPENDENT_REFERENCE from an unrelated profile', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  // A human adds an unrelated profile that references an owned provider.
  const config = readConfigJson(home);
  config.daemon.agentProfiles.push({ id: 'mine', name: 'Mine', provider: 'slp-codex-peer' });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const daemon2 = await makeDaemon(t, home);
  const opId = randomUUID();
  const deact = await manager.deactivate(deactivateInput(home, opId, doneAct.binding.bindingSha256), daemon2);
  const done = await waitTerminal(manager, home, deact.operation.operationId, daemon2);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, opId).includes('DEPENDENT_REFERENCE'));
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 12);
});

test('deactivate blocked by DEPENDENT_REFERENCE from metadataGeneration.providers', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  // A human points structured generation at an owned provider — removal would
  // strand the reference, so deactivation must refuse.
  const config = readConfigJson(home);
  config.agents.metadataGeneration = { providers: [{ provider: 'slp-codex-lead', model: 'm1' }] };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const daemon2 = await makeDaemon(t, home);
  const opId = randomUUID();
  const deact = await manager.deactivate(deactivateInput(home, opId, doneAct.binding.bindingSha256), daemon2);
  const done = await waitTerminal(manager, home, deact.operation.operationId, daemon2);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, opId).includes('DEPENDENT_REFERENCE'));
  assert.equal(daemon2.patchCalls.length, 0);
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 12);
});

test('deactivate with a modified owned profile → OWNERSHIP_DRIFT, no patch', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  const config = readConfigJson(home);
  const idx = config.daemon.agentProfiles.findIndex(p => p.id === 'slp-lead');
  config.daemon.agentProfiles[idx] = { ...config.daemon.agentProfiles[idx], provider: 'codex' };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const daemon2 = await makeDaemon(t, home);
  const opId = randomUUID();
  const deact = await manager.deactivate(deactivateInput(home, opId, doneAct.binding.bindingSha256), daemon2);
  const done = await waitTerminal(manager, home, deact.operation.operationId, daemon2);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, opId).includes('OWNERSHIP_DRIFT'));
  assert.equal(daemon2.patchCalls.length, 0);
});

test('rebind with a new candidate keeps old runtime + launch set retained', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const payload1 = makePayload();
  const deps = makeDeps({ payload: payload1, execOpts: { binaries } });
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, payload1, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');
  const oldLaunchSet = doneAct.binding.launchSetSha256;

  const payload2 = makePayload({ 'bin/slp-shim.mjs': '#!/usr/bin/env node\n// v2\n' });
  const manager2 = createManager(makeDeps({ payload: payload2, execOpts: { binaries } }));
  const act2 = await manager2.activate(activateInput(home, payload2, randomUUID()), daemon);
  const done2 = await waitTerminal(manager2, home, act2.operation.operationId, daemon);
  assert.equal(done2.state, 'ACTIVE');
  assert.notEqual(done2.binding.candidateSha256, doneAct.binding.candidateSha256);
  assert.notEqual(done2.binding.launchSetSha256, oldLaunchSet);
  assert.equal(done2.retainedRuntimeCount, 2);
  assert.ok(existsSync(join(home, 'slp-runtime', doneAct.binding.candidateSha256)));
  assert.ok(existsSync(join(home, 'slp-runtime', 'launchers', oldLaunchSet)));
  const config = readConfigJson(home);
  // Every entry's argv[0] is a launcher in the new binding's launch set —
  // devin's runs the shim, hook families' run the gate.
  assert.ok(config.agents.providers['slp-devin-lead'].command[0].includes(done2.binding.launchSetSha256));
  assert.ok(config.agents.providers['slp-codex-lead'].command[0].includes(done2.binding.launchSetSha256));
});

test('original baseline survives multiple rebinds — every candidate + launch set retained', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const payload1 = makePayload();
  const payload2 = makePayload({ 'bin/slp-shim.mjs': '#!/usr/bin/env node\n// v2\n' });
  const payload3 = makePayload({ 'bin/slp-shim.mjs': '#!/usr/bin/env node\n// v3\n', 'roles/peer.md': '# peer v3\n' });
  const bindings = [];
  for (const payload of [payload1, payload2, payload3]) {
    const manager = createManager(makeDeps({ payload, execOpts: { binaries } }));
    const act = await manager.activate(activateInput(home, payload, randomUUID()), daemon);
    const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
    assert.equal(done.state, 'ACTIVE');
    bindings.push(done.binding);
  }
  // Every prior candidate's runtime directory and launch set still exists —
  // rebinds retain, never delete.
  const receipt = readReceipt(home);
  const retainedSha = receipt.retained.map(entry => entry.candidateSha256);
  for (const binding of bindings) {
    assert.ok(existsSync(join(home, 'slp-runtime', binding.candidateSha256)));
    assert.ok(existsSync(join(home, 'slp-runtime', 'launchers', binding.launchSetSha256)));
  }
  assert.deepEqual(retainedSha, bindings.map(b => b.candidateSha256));
  assert.equal(receipt.binding.candidateSha256, bindings[2].candidateSha256);
  assert.equal(receipt.retained.length, 3);
  // The newest binding's devin launchers point at the newest launch set.
  const config = readConfigJson(home);
  assert.ok(config.agents.providers['slp-devin-lead'].command[0].includes(bindings[2].launchSetSha256));
});

test('rebind preserves human-edited profile preferences', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const payload1 = makePayload();
  const manager = createManager(makeDeps({ payload: payload1, execOpts: { binaries } }));
  const act = await manager.activate(activateInput(home, payload1, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  const config = readConfigJson(home);
  const idx = config.daemon.agentProfiles.findIndex(p => p.id === 'slp-lead');
  config.daemon.agentProfiles[idx] = { ...config.daemon.agentProfiles[idx], model: 'opus-4', notes: 'human edited' };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

  const payload2 = makePayload({ 'bin/slp-shim.mjs': 'v2\n' });
  const manager2 = createManager(makeDeps({ payload: payload2, execOpts: { binaries } }));
  const daemon2 = await makeDaemon(t, home);
  const act2 = await manager2.activate(activateInput(home, payload2, randomUUID()), daemon2);
  const done2 = await waitTerminal(manager2, home, act2.operation.operationId, daemon2);
  assert.equal(done2.state, 'ACTIVE');
  const lead = readConfigJson(home).daemon.agentProfiles.find(p => p.id === 'slp-lead');
  assert.equal(lead.model, 'opus-4');
  assert.equal(lead.notes, 'human edited');
});

test('initialProfileFamily on an existing binding → INVALID_REQUEST', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  const bad = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), { initialProfileFamily: 'pi' }),
    daemon,
  );
  assert.equal(bad.accepted, false);
  assert.equal(bad.conflicts[0].code, 'INVALID_REQUEST');
});

test('initialProfileFamily selects the profile provider family', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), { initialProfileFamily: 'pi' }),
    daemon,
  );
  const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(done.state, 'ACTIVE');
  const lead = readConfigJson(home).daemon.agentProfiles.find(p => p.id === 'slp-lead');
  assert.equal(lead.provider, 'slp-pi-lead');
});

test('profiles on first activation write the supplied values verbatim', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), {
      profiles: {
        supervisor: { model: 'swe-2-high', modeId: 'bypass', featureValues: { auto_accept: true } },
        lead: { family: 'devin', model: 'swe-2-max' },
      },
    }),
    daemon,
  );
  const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(done.state, 'ACTIVE');
  const profiles = readConfigJson(home).daemon.agentProfiles;
  const supervisor = profiles.find(p => p.id === 'slp-supervisor');
  const lead = profiles.find(p => p.id === 'slp-lead');
  assert.equal(supervisor.model, 'swe-2-high');
  assert.equal(supervisor.modeId, 'bypass');
  assert.deepEqual(supervisor.featureValues, { auto_accept: true });
  assert.equal(supervisor.provider, 'slp-codex-supervisor', 'default family applies without a per-role override');
  assert.equal(lead.provider, 'slp-devin-lead', 'per-role family override repoints the provider');
  assert.equal(lead.model, 'swe-2-max');
  assert.equal(lead.modeId, undefined, 'unset fields are never invented');
  assert.equal(lead.featureValues, undefined);
  assert.equal(supervisor.family, undefined, 'family is a picker control, never a persisted field');
});

test('profiles on an existing binding apply explicit edits: set, clear, repoint', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), {
      profiles: { supervisor: { model: 'swe-2-high', modeId: 'bypass' } },
    }),
    daemon,
  );
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  const edit = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), {
      profiles: {
        supervisor: { model: null, family: 'devin' },
        lead: { model: 'swe-2-max', featureValues: { auto_accept: true } },
      },
    }),
    daemon,
  );
  assert.equal(edit.accepted, true);
  const done = await waitTerminal(manager, home, edit.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  const profiles = readConfigJson(home).daemon.agentProfiles;
  const supervisor = profiles.find(p => p.id === 'slp-supervisor');
  const lead = profiles.find(p => p.id === 'slp-lead');
  assert.equal(supervisor.provider, 'slp-devin-supervisor', 'family repoints the provider');
  assert.equal(supervisor.model, undefined, 'null clears the field');
  assert.equal(supervisor.modeId, 'bypass', 'absent fields preserve the live value');
  assert.equal(lead.provider, 'slp-codex-lead', 'no family key preserves the live provider');
  assert.equal(lead.model, 'swe-2-max');
  assert.deepEqual(lead.featureValues, { auto_accept: true });
});

test('profiles on an existing binding reject an unavailable family', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t, ['codex', 'pi', 'devin']); // claude unresolved
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  const bad = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), {
      profiles: { supervisor: { family: 'claude' } },
    }),
    daemon,
  );
  assert.equal(bad.accepted, true, 'the request is journaled; the plan stage rejects');
  const done = await waitTerminal(manager, home, bad.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  const supervisor = readConfigJson(home).daemon.agentProfiles.find(p => p.id === 'slp-supervisor');
  assert.equal(supervisor.provider, 'slp-codex-supervisor', 'a rejected edit leaves the live profile untouched');
});

test('status exposes live managed-profile values for the bound editor', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const pre = await manager.status(statusInput(home), daemon);
  assert.deepEqual(pre.managedProfiles, [], 'no binding → no managed profiles');
  const act = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), {
      profiles: { lead: { model: 'swe-2-max', modeId: 'bypass' } },
    }),
    daemon,
  );
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  const post = await manager.status(statusInput(home), daemon);
  assert.equal(post.managedProfiles.length, 2);
  const lead = post.managedProfiles.find(p => p.id === 'slp-lead');
  const supervisor = post.managedProfiles.find(p => p.id === 'slp-supervisor');
  assert.equal(lead.provider, 'slp-codex-lead');
  assert.equal(lead.model, 'swe-2-max');
  assert.equal(lead.modeId, 'bypass');
  assert.equal(supervisor.model, null);
  assert.equal(supervisor.featureValues, null);
});

test('status reports state and never mutates; unknown operationId → NOT_FOUND', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const before = readFileSync(join(home, 'config.json'));
  const s0 = await manager.status(statusInput(home), daemon);
  assert.equal(s0.state, 'INACTIVE');
  assert.equal(s0.binding, null);
  assert.equal(s0.families.length, 4);
  assert.equal(s0.liveAcceptance, 'not-established-by-this-rpc');
  const unknown = await manager.status(statusInput(home, randomUUID()), daemon);
  assert.equal(unknown.operation, null);
  assert.equal(unknown.conflicts.at(-1).code, 'NOT_FOUND');
  assert.deepEqual(readFileSync(join(home, 'config.json')), before);
  assert.equal(daemon.patchCalls.length, 0);
  assert.equal(daemon.getCalls, 0, 'status must not call config.get');
});

test('oversized input → INVALID_REQUEST', async t => {
  const home = makeHome(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries: makeBinaries(t) } });
  const manager = createManager(deps);
  const huge = activateInput(home, deps.payload, randomUUID(), { nodePath: '/' + 'x'.repeat(70 * 1024) });
  const out = await manager.activate(huge, daemon);
  assert.equal(out.accepted, false);
  assert.equal(out.conflicts[0].code, 'INVALID_REQUEST');
});

test('win32 platform → UNSUPPORTED_PLATFORM before any mutation', async t => {
  const home = makeHome(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries: makeBinaries(t) }, platform: 'win32' });
  const manager = createManager(deps);
  const out = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  assert.equal(out.accepted, false);
  assert.equal(out.conflicts[0].code, 'UNSUPPORTED_PLATFORM');
  assert.ok(!existsSync(join(home, 'slp-runtime')));
});

test('SCHEMA_LOSS: unknown top-level field → rejected before any patch', async t => {
  // The daemon booted on a clean config; a foreign edit then added a field
  // the persisted schema would silently drop on the next write.
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const corrupt = readConfigJson(home);
  corrupt.mysteryField = { a: 1 };
  writeFileSync(join(home, 'config.json'), JSON.stringify(corrupt, null, 2) + '\n', { mode: 0o600 });
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const opId = randomUUID();
  await manager.activate(activateInput(home, deps.payload, opId), daemon);
  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, opId).includes('SCHEMA_LOSS'));
  assert.equal(daemon.patchCalls.length, 0);
  assert.ok(readConfigJson(home).mysteryField, 'field preserved — never stripped');
});

test('SCHEMA_LOSS: unknown field inside a strict object', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const corrupt = readConfigJson(home);
  corrupt.daemon.git = { maxProcessesPerSecond: 4, bogus: 1 };
  writeFileSync(join(home, 'config.json'), JSON.stringify(corrupt, null, 2) + '\n', { mode: 0o600 });
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const opId = randomUUID();
  await manager.activate(activateInput(home, deps.payload, opId), daemon);
  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, opId).includes('SCHEMA_LOSS'));
});

test('SCHEMA_LOSS: unknown field on an owned provider entry', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  // Corrupt one owned entry with an extra field the host would silently drop.
  const config = readConfigJson(home);
  config.agents.providers['slp-codex-lead'].extraField = 42;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const daemon2 = await makeDaemon(t, home);
  const opId = randomUUID();
  const deact = await manager.deactivate(deactivateInput(home, opId, doneAct.binding.bindingSha256), daemon2);
  const done = await waitTerminal(manager, home, deact.operation.operationId, daemon2);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, opId).includes('SCHEMA_LOSS'));
  assert.equal(daemon2.patchCalls.length, 0);
});

test('legacy provider entry migration is detected as SCHEMA_LOSS', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  // A pre-migration provider shape on disk: loadPersistedConfig would rewrite
  // it (data loss for the plugin's purposes), so the transaction must refuse.
  const corrupt = readConfigJson(home);
  corrupt.agents = { providers: { 'slp-codex-peer': { command: { mode: 'replace', argv: ['/x'] }, env: {} } } };
  writeFileSync(join(home, 'config.json'), JSON.stringify(corrupt, null, 2) + '\n', { mode: 0o600 });
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const opId = randomUUID();
  await manager.activate(activateInput(home, deps.payload, opId), daemon);
  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, opId).includes('SCHEMA_LOSS'));
  assert.equal(daemon.patchCalls.length, 0);
});

test('target host mismatch → TARGET_MISMATCH', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  const alien = activateInput(home, deps.payload, randomUUID());
  alien.target.hostId = 'other-host';
  const out = await manager.activate(alien, daemon);
  assert.equal(out.accepted, false);
  assert.equal(out.conflicts[0].code, 'TARGET_MISMATCH');
});

test('corrupt journal → RECOVERY_REQUIRED, never overwritten', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  writeFileSync(receiptPath(home), '{"schemaVersion":1,"bogus":', { mode: 0o600 });
  const status = await manager.status(statusInput(home), daemon);
  assert.equal(status.state, 'RECOVERY_REQUIRED');
  const act2 = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  assert.equal(act2.accepted, false);
  assert.equal(act2.conflicts[0].code, 'RECOVERY_REQUIRED');
  assert.deepEqual(readFileSync(receiptPath(home)), Buffer.from('{"schemaVersion":1,"bogus":'));
});

test('receipt revision increments monotonically', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  const receipt = readReceipt(home);
  assert.ok(receipt.revision >= 4, `expected several revisions, got ${receipt.revision}`);
  assert.equal(receipt.operations.length, 1);
  assert.equal(receipt.state, 'ACTIVE');
});

test('no SLP temp files remain after a successful activation', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  const leftovers = readdirSync(join(home, 'slp-runtime', 'state')).filter(f => f !== 'receipt.json');
  assert.deepEqual(leftovers, []);
  assert.ok(!existsSync(join(home, 'slp-runtime', '.staging')));
});

test('status with no receipt but present SLP entries → RECOVERY_REQUIRED', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  rmSync(join(home, 'slp-runtime'), { recursive: true, force: true });
  const status = await manager.status(statusInput(home), daemon);
  assert.equal(status.state, 'RECOVERY_REQUIRED');
});

test('close() stops accepting work', async t => {
  const home = makeHome(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries: makeBinaries(t) } });
  const manager = createManager(deps);
  manager.close();
  const out = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  assert.equal(out.accepted, false);
  assert.equal(out.conflicts[0].code, 'INVALID_REQUEST');
});

test('explicit binaries override resolution and land in provider env', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries: {} } });
  const manager = createManager(deps);

  // §6 ordering: no explicitly enabled base family and codex unavailable →
  // activation fails rather than picking an arbitrary family.
  const refused = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), { binaries: { claude: binaries.claude } }),
    daemon,
  );
  const refusedDone = await waitTerminal(manager, home, refused.operation.operationId, daemon);
  assert.equal(refusedDone.operation.outcome, 'failed');
  assert.ok(opConflicts(home, refused.operation.operationId).includes('EXECUTABLE_UNAVAILABLE'));

  // An explicit initialProfileFamily qualifies the override.
  const act = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), {
      binaries: { claude: binaries.claude },
      initialProfileFamily: 'claude',
    }),
    daemon,
  );
  const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(done.state, 'ACTIVE');
  const config = readConfigJson(home);
  assert.equal(config.agents.providers['slp-claude-peer'].env.SLP_FAMILY_BIN, binaries.claude);
  assert.equal(config.agents.providers['slp-codex-peer'].enabled, false);
});

test('materializer failure → op failed, state INACTIVE, staging cleaned', async t => {
  const home = makeHome(t);
  const daemon = await makeDaemon(t, home);
  const payload = makePayload();
  const materializer = makeMaterializer(payload);
  const broken = {
    ...materializer,
    async materialize() {
      throw new OperationConflict('RUNTIME_INTEGRITY', 'embedded payload digest mismatch');
    },
  };
  const deps = makeDeps({ payload, materializer: broken, execOpts: { binaries: makeBinaries(t) } });
  const manager = createManager(deps);
  const opId = randomUUID();
  const start = await manager.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.equal(done.state, 'INACTIVE');
  assert.equal(daemon.patchCalls.length, 0);
});

test('pure planner: patchForDirection rebuilds forward and inverse patches', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(done.state, 'ACTIVE');
  const receipt = readReceipt(home);
  const plan = receipt.operations[0].plan;
  const beforeConfig = { version: 1, daemon: { mcp: { enabled: true } } };
  const forward = patchForDirection(plan, 'activate', 'forward', beforeConfig);
  assert.equal(forward.mcp.injectIntoAgents, true);
  assert.equal(Object.keys(forward.providers).length, 12);
  assert.equal(forward.removeProviders, undefined);
  assert.equal(forward.agentProfiles.length, 2);
  const inverse = patchForDirection(plan, 'activate', 'inverse', readConfigJson(home));
  assert.equal(inverse.mcp.injectIntoAgents, false);
  assert.deepEqual([...inverse.removeProviders].sort(), OWNED_IDS);
  assert.equal(inverse.agentProfiles.length, 0);
});

test('assertPersistedCompatible: plain validator coverage', async () => {
  assert.doesNotThrow(() => assertPersistedCompatible({ version: 1, daemon: { mcp: { enabled: true } } }));
  assert.throws(() => assertPersistedCompatible({ version: 1, extra: 1 }), /drop|invalid|fails/i);
  assert.throws(
    () => assertPersistedCompatible({ version: 1, daemon: { allowedHosts: ['x'] } }),
    /drop|invalid|fails/i,
  );
  assert.throws(
    () => assertPersistedCompatible({ version: 1, agents: { providers: { codex: { enabled: true, unknownKey: 1 } } } }),
    /drop|invalid|fails/i,
  );
  // openai.voice must be STRIPPED by the removed-field preprocessing and then
  // reported as a dropped field — a schema-parse rejection would mean the
  // strip never ran.
  assert.throws(
    () => assertPersistedCompatible({ version: 1, providers: { openai: { voice: { model: 'x' } } } }),
    /providers\.openai\.voice/,
  );
  // Empty webUi distDir must be rejected (host requires .min(1)).
  assert.throws(
    () => assertPersistedCompatible({ version: 1, features: { webUi: { distDir: '' } } }),
    /webUi\.distDir|fails/i,
  );
  assert.throws(
    () => assertPersistedCompatible({ version: 1, daemon: { git: { maxProcessesPerSecond: -1 } } }),
    /drop|invalid|fails/i,
  );
});

test('installed-impl parity: replica schema vs real loadPersistedConfig', async t => {
  const backend = await loadRealBackend();
  if (!backend) {
    t.skip('REAL BACKEND UNAVAILABLE — schema parity vs real loadPersistedConfig SKIPPED (set PASEO_CLI_MODULES; see warning above)');
    return;
  }
  const fixtures = [
    { version: 1, daemon: { mcp: { enabled: true } } },
    { version: 1, extraTop: { x: 1 }, daemon: {} },
    { version: 1, daemon: { allowedHosts: true } },
    { version: 1, agents: { providers: { codex: { enabled: true, stray: 1 } } } },
    { version: 1, providers: { local: { autoDownload: true } } },
    { version: 1, agents: { providers: { 'custom-x': { command: { mode: 'replace', argv: ['/bin/x'] } } } } },
    { version: 1, daemon: { mcp: { enabled: true, futureFlag: 1 } } },
    { version: 1, daemon: { browserTools: { enabled: true, future: 2 } } },
    // Host rejects an empty webUi distDir (z.string().min(1)).
    { version: 1, features: { webUi: { enabled: true, distDir: '' } } },
    // Host strips providers.openai.voice then parses — a data drop.
    { version: 1, providers: { openai: { apiKey: 'k', voice: { model: 'x' } } } },
  ];
  const collectDropped = (raw, parsed, path, out) => {
    if (!isRecord(raw)) return;
    if (!isRecord(parsed)) {
      out.push(path || '(root)');
      return;
    }
    for (const key of Object.keys(raw)) {
      const p = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(parsed, key)) {
        out.push(p);
        continue;
      }
      const rc = raw[key];
      const pc = parsed[key];
      if (Array.isArray(rc) && Array.isArray(pc)) {
        for (let i = 0; i < rc.length; i += 1) collectDropped(rc[i], pc[i], `${p}[${i}]`, out);
        continue;
      }
      collectDropped(rc, pc, p, out);
    }
  };
  for (const [i, fixture] of fixtures.entries()) {
    const dir = mkdtempSync(join(tmpdir(), `slp-parity-${i}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'config.json'), JSON.stringify(fixture), { mode: 0o600 });
    let realOk = true;
    let realParsed = null;
    let realError = null;
    try {
      realParsed = backend.loadPersistedConfig(dir);
    } catch (e) {
      realOk = false;
      realError = e;
    }
    let replicaError = null;
    try {
      assertPersistedCompatible(fixture);
    } catch (e) {
      replicaError = e;
    }
    const dropped = [];
    if (realOk) collectDropped(fixture, realParsed, '', dropped);
    const realLoses = !realOk || dropped.length > 0;
    assert.equal(
      replicaError !== null,
      realLoses,
      `fixture ${i}: replica ${replicaError?.message ?? 'ok'} vs real ${realOk ? `ok (dropped: ${dropped.join(',') || 'none'})` : realError?.message}`,
    );
  }
  console.info('installed-impl parity backend: real DaemonConfigStore modules');
});

test('installed-impl parity: MiniStore and DaemonConfigStore merge the same patch identically', async t => {
  const backend = await loadRealBackend();
  if (!backend) {
    t.skip('REAL BACKEND UNAVAILABLE — MiniStore patch-merge parity SKIPPED; merge semantics unverified against the real store (set PASEO_CLI_MODULES; see warning above)');
    return;
  }
  const base = {
    version: 1,
    pluginsEnabled: false,
    plugins: { 'unrelated-plugin': { source: 'directory', path: '/x', enabled: true } },
    agents: {
      providers: {
        'unrelated': { extends: 'codex', label: 'Unrelated', enabled: true },
        'slp-codex-peer': { extends: 'codex', label: 'Old SLP', enabled: false },
      },
      metadataGeneration: {
        providers: [
          { provider: 'slp-codex-peer', model: 'm1' },
          { provider: 'unrelated', model: 'm2' },
        ],
      },
      skills: { selection: { mode: 'custom', skills: ['old-skill'] } },
    },
    daemon: {
      mcp: { enabled: true },
      agentProfiles: [{ id: 'unrelated-profile', name: 'Keep', provider: 'codex', model: 'm1' }],
      appendSystemPrompt: 'base prompt',
      terminalProfiles: [{ id: 'tp-keep', name: 'T', command: '/bin/sh' }],
    },
  };
  const homeMini = makeHome(t, base);
  const homeReal = makeHome(t, base);
  const persisted = backend.loadPersistedConfig(homeReal);
  const mini = new MiniStore(homeMini);
  const real = new backend.DaemonConfigStore(homeReal, initialMutable(persisted), undefined, {
    startupPersisted: persisted,
    relayEnabledMutable: true,
  });

  const patch1 = {
    mcp: { injectIntoAgents: true },
    providers: {
      'slp-codex-peer': { extends: 'codex', label: 'SLP Codex Peer', enabled: true, command: ['/x'], env: {} },
      'new-provider': { extends: 'pi', label: 'New Provider', enabled: true },
    },
    agentProfiles: [
      { id: 'unrelated-profile', name: 'Keep', provider: 'codex', model: 'm1' },
      { id: 'slp-lead', name: 'SLP Lead', provider: 'slp-codex-lead', model: 'm' },
    ],
    pluginsEnabled: true,
    plugins: { 'paseo-slp': { source: 'directory', path: '/plugins/paseo-slp', enabled: true } },
    skills: { selection: { mode: 'custom', skills: ['new-skill', 'other'] } },
    appendSystemPrompt: 'appended tail',
    autoArchiveAfterMerge: true,
  };
  mini.patch(patch1);
  real.patch(patch1);
  assert.deepEqual(readConfigJson(homeMini), readConfigJson(homeReal), 'patch1 persisted divergence');
  assert.deepEqual(mini.get(), real.get(), 'patch1 effective divergence');

  const patch2 = {
    removeProviders: ['slp-codex-peer'],
    browserTools: { enabled: true },
    enableTerminalAgentHooks: true,
    terminalProfiles: [{ id: 'tp-new', name: 'T2', command: '/bin/sh' }],
    metadataGeneration: { providers: [{ provider: 'unrelated', model: 'm3' }] },
  };
  mini.patch(patch2);
  real.patch(patch2);
  assert.deepEqual(readConfigJson(homeMini), readConfigJson(homeReal), 'patch2 persisted divergence');
  assert.deepEqual(mini.get(), real.get(), 'patch2 effective divergence');
});

test('mixed absent/exact-present adoption computes indexes over the full array', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(managerA, home, act.operation.operationId, daemon);

  // §8.1 mixed case: every provider present, but only slp-supervisor survives
  // in the profile array — slp-lead must append at index 1, not collide at 0.
  const config = readConfigJson(home);
  config.daemon.agentProfiles = config.daemon.agentProfiles.filter(p => p.id === 'slp-supervisor');
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  rmSync(receiptPath(home), { force: true });
  const daemonB = await makeDaemon(t, home);

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const adopt = await managerB.activate(
    activateInput(home, deps.payload, randomUUID(), { adoptIdentical: true }),
    daemonB,
  );
  assert.equal(adopt.accepted, true, `adoption refused: ${adopt.conflicts.map(c => c.code)}`);
  const done = await waitTerminal(managerB, home, adopt.operation.operationId, daemonB);
  assert.equal(done.operation.outcome, 'succeeded', `op conflicts: ${done.conflicts.map(c => `${c.code}:${c.message}`)}`);
  assert.equal(done.state, 'ACTIVE');
  const slots = readReceipt(home).binding.owned.profiles;
  assert.deepEqual(slots.map(s => [s.value.id, s.index]), [['slp-supervisor', 0], ['slp-lead', 1]]);
});

test('allProfilesSha256 hashes the §7 wire format: {present:false} vs {present:true,value}', async t => {
  const specSha = s => createHash('sha256').update(s, 'utf8').digest('hex');
  const absentExpected = specSha('{"present":false}\n');
  const emptyExpected = specSha('{"present":true,"value":[]}\n');

  for (const [label, config] of [
    ['absent', undefined],
    ['explicit-empty', { version: 1, daemon: { mcp: { enabled: true }, agentProfiles: [] } }],
  ]) {
    const { home, binaries, daemon, deps } = await makePluginFixture(t, config);
    const manager = createManager(deps);
    const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
    await waitTerminal(manager, home, act.operation.operationId, daemon);
    const before = opOf(home, act.operation.operationId).plan.before.allProfilesSha256;
    const expected = label === 'absent' ? absentExpected : emptyExpected;
    assert.equal(before, expected, `${label}: before hash must use the spec wire format`);
    assert.notEqual(absentExpected, emptyExpected);
  }
});

test('adoption with only slp-lead records slots in index order and verifies clean', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(managerA, home, act.operation.operationId, daemon);

  // Every provider present, but only slp-lead survives in the profile array:
  // declaration order produces slots [1,0] — disk projection sorts [0,1] —
  // an order-sensitive compare would flag RAW_LIVE_DIVERGENCE post-patch.
  const config = readConfigJson(home);
  config.daemon.agentProfiles = config.daemon.agentProfiles.filter(p => p.id === 'slp-lead');
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  rmSync(receiptPath(home), { force: true });
  const daemonB = await makeDaemon(t, home);

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const adopt = await managerB.activate(
    activateInput(home, deps.payload, randomUUID(), { adoptIdentical: true }),
    daemonB,
  );
  assert.equal(adopt.accepted, true, `adoption refused: ${adopt.conflicts.map(c => c.code)}`);
  const done = await waitTerminal(managerB, home, adopt.operation.operationId, daemonB);
  assert.equal(done.operation.outcome, 'succeeded', `op conflicts: ${done.conflicts.map(c => `${c.code}:${c.message}`)}`);
  assert.equal(done.state, 'ACTIVE');
  const slots = readReceipt(home).binding.owned.profiles;
  assert.deepEqual(slots.map(s => [s.value.id, s.index]), [['slp-lead', 0], ['slp-supervisor', 1]]);
});

test('swapped owned profile order is already at the after endpoint — no patch', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(managerA, home, act.operation.operationId, daemon);

  // Reverse the two owned profiles in the array: the SET is identical, only
  // array positions differ. The after-endpoint projection must compare
  // equal to disk or the plan invents a spurious reorder patch.
  const config = readConfigJson(home);
  config.daemon.agentProfiles = [...config.daemon.agentProfiles].reverse();
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  rmSync(receiptPath(home), { force: true });
  const daemonB = await makeDaemon(t, home);

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const adopt = await managerB.activate(
    activateInput(home, deps.payload, randomUUID(), { adoptIdentical: true }),
    daemonB,
  );
  assert.equal(adopt.accepted, true, `adoption refused: ${adopt.conflicts.map(c => c.code)}`);
  const done = await waitTerminal(managerB, home, adopt.operation.operationId, daemonB);
  assert.equal(done.operation.outcome, 'succeeded', `op conflicts: ${done.conflicts.map(c => `${c.code}:${c.message}`)}`);
  assert.equal(done.state, 'ACTIVE');
  assert.equal(daemonB.patchCalls.length, 0, 'identical reordered config must not dispatch a patch');
});

test('effective backend marker', async t => {
  const home = makeHome(t);
  const daemon = await makeDaemon(t, home);
  console.info(`daemon config backend for this run: ${daemon.__backend}`);
});
