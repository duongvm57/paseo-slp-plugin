// tests/plugin-routing.test.mjs — Phase 1 settings-driven provider
// generation (docs/spec/settings-driven-providers.md §5): the plugin-owned
// role-routing file at slp-runtime/state/role-routing.json, the
// get/set-role-routing RPCs, routing-driven provider/profile generation,
// rebind removal of non-chosen combos, the dependent-reference guard, and
// the absent/legacy → all-fifteen backward-compatibility decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManager } from '../plugin/server/manager.ts';
import { createStateStore } from '../plugin/server/state-store.ts';
import {
  OWNED_IDS,
  activateInput,
  deactivateInput,
  makeBinaries,
  makeDaemon,
  makeDeps,
  makeHome,
  opConflicts,
  readConfigJson,
  readReceipt,
  slpProvidersOf,
  targetOf,
  waitTerminal,
} from './helpers/plugin-doubles.mjs';

const routingPath = home => join(home, 'slp-runtime', 'state', 'role-routing.json');
const writeRoutingFile = (home, text) => {
  mkdirSync(dirname(routingPath(home)), { recursive: true });
  writeFileSync(routingPath(home), text, { mode: 0o600 });
};

const setRouting = (store, home, supervisor, lead) =>
  store.setRoleRouting({ schemaVersion: 1, target: targetOf(home), routing: { schemaVersion: 1, supervisor, lead } });
const getRouting = (store, home) =>
  store.getRoleRouting({ schemaVersion: 1, target: targetOf(home) });

// The six generated ids under a routing: chosen supervisor + chosen lead
// combos plus all four pool-driven peers — nothing else.
const generatedIds = (supFamily, leadFamily) =>
  [`slp-${supFamily}-supervisor`, `slp-${leadFamily}-lead`, 'slp-codex-peer', 'slp-pi-peer', 'slp-devin-peer', 'slp-claude-peer', 'slp-opencode-peer'].sort();
const absentIds = (supFamily, leadFamily) =>
  OWNED_IDS.filter(id => !generatedIds(supFamily, leadFamily).includes(id));

// ---------------------------------------------------------------------------
// State file + RPC surface
// ---------------------------------------------------------------------------

test('role-routing file round-trips through get/set before any activation', async t => {
  const home = makeHome(t);
  const manager = createManager(makeDeps());
  const store = createStateStore();
  const file = routingPath(home);

  // Unset → null (the legacy all-fifteen generation applies).
  assert.equal(existsSync(file), false);
  assert.deepEqual(await getRouting(store, home), { schemaVersion: 1, routing: null });

  // Set → lands atomically with private mode; get returns the stored value.
  const choice = {
    supervisor: { family: 'pi', model: 'pi-model', modeId: 'fast' },
    lead: { family: 'devin', model: 'swe-2-max', thinkingOptionId: 'high', featureValues: { auto_accept: true } },
  };
  const set = await setRouting(store, home, choice.supervisor, choice.lead);
  assert.deepEqual(set, { schemaVersion: 1, routing: { schemaVersion: 1, ...choice } });
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 1, ...choice });
  assert.deepEqual(await getRouting(store, home), { schemaVersion: 1, routing: { schemaVersion: 1, ...choice } });

  // Overwrite → the whole document is replaced (no field merge).
  const next = { family: 'claude' };
  await setRouting(store, home, choice.supervisor, next);
  const read = await getRouting(store, home);
  assert.deepEqual(read.routing.lead, next, 'a saved routing replaces the previous document verbatim');
  assert.equal(read.routing.supervisor.model, 'pi-model');

  // No tmp siblings survive the atomic write.
  const stateDir = join(home, 'slp-runtime', 'state');
  assert.deepEqual(
    (await import('node:fs')).readdirSync(stateDir).filter(name => name.endsWith('.tmp')),
    [],
  );
});

test('set-role-routing rejects malformed input and unknown keys', async t => {
  const home = makeHome(t);
  const manager = createManager(makeDeps());
  const store = createStateStore();
  const target = targetOf(home);
  const base = { family: 'codex' };
  const cases = [
    ['unknown top-level key', { schemaVersion: 1, target, routing: { schemaVersion: 1, supervisor: base, lead: base, extra: 1 } }],
    ['unknown RoleChoice key', { schemaVersion: 1, target, routing: { schemaVersion: 1, supervisor: { ...base, bogus: 'x' }, lead: base } }],
    ['unknown family', { schemaVersion: 1, target, routing: { schemaVersion: 1, supervisor: { family: 'gpt' }, lead: base } }],
    ['missing lead', { schemaVersion: 1, target, routing: { schemaVersion: 1, supervisor: base } }],
    ['empty model string', { schemaVersion: 1, target, routing: { schemaVersion: 1, supervisor: { ...base, model: '' }, lead: base } }],
    ['non-record featureValues', { schemaVersion: 1, target, routing: { schemaVersion: 1, supervisor: { ...base, featureValues: 'x' }, lead: base } }],
    ['wrong schemaVersion', { schemaVersion: 1, target, routing: { schemaVersion: 2, supervisor: base, lead: base } }],
    ['missing routing', { schemaVersion: 1, target }],
  ];
  for (const [name, input] of cases) {
    await assert.rejects(() => store.setRoleRouting(input), /invalid set-role-routing input/, name);
  }
  await assert.rejects(
    () => store.getRoleRouting({ schemaVersion: 1 }),
    /invalid get-role-routing input/,
  );
  assert.equal(existsSync(routingPath(home)), false, 'a rejected write never creates the file');
});

// ---------------------------------------------------------------------------
// Backward compatibility: absent/legacy routing → v1 all-fifteen generation
// ---------------------------------------------------------------------------

test('malformed or legacy-version routing file degrades to all-fifteen generation', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const store = createStateStore();

  writeRoutingFile(home, '{"schemaVersion":2,"supervisor":{"family":"pi"},"lead":{"family":"pi"}}\n');
  assert.deepEqual(await getRouting(store, home), { schemaVersion: 1, routing: null });
  writeRoutingFile(home, 'not json at all');
  assert.deepEqual(await getRouting(store, home), { schemaVersion: 1, routing: null });

  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(done.state, 'ACTIVE');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15, 'legacy routing keeps v1 generation');
});

// ---------------------------------------------------------------------------
// Settings-driven generation
// ---------------------------------------------------------------------------

test('routing generates the two chosen combos plus all four peers', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const store = createStateStore();

  await setRouting(
    store, home,
    { family: 'pi', model: 'pi-model', modeId: 'fast' },
    { family: 'devin', model: 'swe-2-max', thinkingOptionId: 'high', featureValues: { auto_accept: true } },
  );
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(done.state, 'ACTIVE');

  const providers = slpProvidersOf(readConfigJson(home));
  assert.deepEqual(Object.keys(providers).sort(), generatedIds('pi', 'devin'));
  for (const id of absentIds('pi', 'devin')) {
    assert.equal(providers[id], undefined, `${id} must be absent under the routing`);
  }

  const profiles = readConfigJson(home).daemon.agentProfiles;
  const supervisor = profiles.find(p => p.id === 'slp-supervisor');
  const lead = profiles.find(p => p.id === 'slp-lead');
  assert.equal(supervisor.provider, 'slp-pi-supervisor');
  assert.equal(supervisor.model, 'pi-model');
  assert.equal(supervisor.modeId, 'fast');
  assert.equal(lead.provider, 'slp-devin-lead');
  assert.equal(lead.model, 'swe-2-max');
  assert.equal(lead.thinkingOptionId, 'high');
  assert.deepEqual(lead.featureValues, { auto_accept: true });

  // The recorded projection still spans all fifteen owned ids — the
  // non-chosen six are present:false, which is what drives removal.
  const binding = readReceipt(home).binding;
  assert.deepEqual(Object.keys(binding.owned.providers).sort(), OWNED_IDS);
  for (const id of absentIds('pi', 'devin')) {
    assert.equal(binding.owned.providers[id].present, false, `${id} recorded absent`);
  }
  for (const id of generatedIds('pi', 'devin')) {
    assert.equal(binding.owned.providers[id].present, true, `${id} recorded present`);
  }
});

test('explicit profiles input overrides routing; a family override generates its provider', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const store = createStateStore();

  await setRouting(store, home, { family: 'pi', model: 'routing-model' }, { family: 'devin' });
  const act = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), {
      profiles: {
        supervisor: { model: 'override-model' },
        lead: { family: 'claude', model: 'swe-2-max' },
      },
    }),
    daemon,
  );
  const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(done.state, 'ACTIVE');

  const profiles = readConfigJson(home).daemon.agentProfiles;
  const supervisor = profiles.find(p => p.id === 'slp-supervisor');
  const lead = profiles.find(p => p.id === 'slp-lead');
  assert.equal(supervisor.provider, 'slp-pi-supervisor', 'routing still supplies the provider');
  assert.equal(supervisor.model, 'override-model', 'explicit model wins over routing');
  assert.equal(lead.provider, 'slp-claude-lead', 'explicit family repoint wins over routing');
  assert.equal(lead.model, 'swe-2-max');

  const providers = slpProvidersOf(readConfigJson(home));
  assert.equal(providers['slp-claude-lead']?.enabled, true, 'the overridden family provider is generated');
  assert.equal(providers['slp-devin-lead'], undefined, 'the routing-chosen lead family is no longer generated');
});

test('profiles null clears a routing-supplied field on BOTH fresh and rebind paths', async t => {
  // L2 parity: `null` is an explicit clear everywhere — on the fresh
  // desiredProfiles path it must delete the routing-supplied field, not let
  // the routing value win; the rebind path has always deleted live fields.
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const store = createStateStore();

  // Fresh path: routing supplies model, profiles input clears it with null.
  await setRouting(store, home, { family: 'pi', model: 'routing-model' }, { family: 'devin', model: 'lead-model' });
  const act = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), {
      profiles: { supervisor: { model: null } },
    }),
    daemon,
  );
  const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(done.state, 'ACTIVE');
  let profiles = readConfigJson(home).daemon.agentProfiles;
  const supervisor = profiles.find(p => p.id === 'slp-supervisor');
  assert.equal(supervisor.provider, 'slp-pi-supervisor');
  assert.equal('model' in supervisor, false, 'null clears the routing-supplied field on fresh activation');

  // Rebind path: same input now clears the lead model the routing wrote.
  const second = await manager.activate(
    activateInput(home, deps.payload, randomUUID(), {
      profiles: { lead: { model: null } },
    }),
    daemon,
  );
  const done2 = await waitTerminal(manager, home, second.operation.operationId, daemon);
  assert.equal(done2.operation.outcome, 'succeeded');
  profiles = readConfigJson(home).daemon.agentProfiles;
  const lead = profiles.find(p => p.id === 'slp-lead');
  assert.equal(lead.provider, 'slp-devin-lead');
  assert.equal('model' in lead, false, 'null clears the routing-supplied field on rebind');
});

test('routing that selects an unavailable family fails closed at plan time', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t, ['codex', 'pi', 'devin']); // claude unresolved
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const store = createStateStore();

  await setRouting(store, home, { family: 'claude' }, { family: 'codex' });
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, act.operation.operationId).includes('EXECUTABLE_UNAVAILABLE'));
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 0, 'a rejected routing writes nothing');
});

// ---------------------------------------------------------------------------
// Rebind / migration
// ---------------------------------------------------------------------------

test('routing change on an existing binding removes non-chosen providers and repoints profiles in one re-activation', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const store = createStateStore();

  // Legacy all-fifteen binding first.
  const first = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, first.operation.operationId, daemon);
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15);

  // Route supervisor → devin, lead → pi; re-activate the same candidate.
  await setRouting(store, home, { family: 'devin', model: 'swe-2-high' }, { family: 'pi' });
  const second = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const done = await waitTerminal(manager, home, second.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');

  const providers = slpProvidersOf(readConfigJson(home));
  assert.deepEqual(Object.keys(providers).sort(), generatedIds('devin', 'pi'));
  const profiles = readConfigJson(home).daemon.agentProfiles;
  assert.equal(profiles.find(p => p.id === 'slp-supervisor').provider, 'slp-devin-supervisor');
  assert.equal(profiles.find(p => p.id === 'slp-supervisor').model, 'swe-2-high');
  assert.equal(profiles.find(p => p.id === 'slp-lead').provider, 'slp-pi-lead');

  // The one dispatched patch both writes the kept providers and removes the
  // non-chosen combos — migration is a single re-activation.
  const lastPatch = daemon.patchCalls.at(-1);
  assert.deepEqual([...lastPatch.removeProviders].sort(), absentIds('devin', 'pi'));
  assert.deepEqual(Object.keys(lastPatch.providers).sort(), generatedIds('devin', 'pi'));
});

test('routing → routing rebind swaps the role providers in one re-activation', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const store = createStateStore();

  await setRouting(store, home, { family: 'pi' }, { family: 'devin' });
  const first = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, first.operation.operationId, daemon);
  assert.deepEqual(Object.keys(slpProvidersOf(readConfigJson(home))).sort(), generatedIds('pi', 'devin'));

  await setRouting(store, home, { family: 'claude' }, { family: 'codex' });
  const second = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const done = await waitTerminal(manager, home, second.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');

  const providers = slpProvidersOf(readConfigJson(home));
  assert.deepEqual(Object.keys(providers).sort(), generatedIds('claude', 'codex'));
  const profiles = readConfigJson(home).daemon.agentProfiles;
  assert.equal(profiles.find(p => p.id === 'slp-supervisor').provider, 'slp-claude-supervisor');
  assert.equal(profiles.find(p => p.id === 'slp-lead').provider, 'slp-codex-lead');
});

test('a foreign profile referencing a removed provider blocks the rebind with DEPENDENT_REFERENCE', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const store = createStateStore();

  await setRouting(store, home, { family: 'pi' }, { family: 'devin' });
  const first = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, first.operation.operationId, daemon);

  // A foreign profile now depends on a provider the next routing removes.
  const config = readConfigJson(home);
  config.daemon.agentProfiles.push({ id: 'user-helper', name: 'Mine', provider: 'slp-pi-supervisor' });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const daemon2 = await makeDaemon(t, home); // live view re-reads persisted config

  await setRouting(store, home, { family: 'codex' }, { family: 'devin' });
  const second = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon2);
  const done = await waitTerminal(manager, home, second.operation.operationId, daemon2);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opConflicts(home, second.operation.operationId).includes('DEPENDENT_REFERENCE'));
  assert.ok(readConfigJson(home).agents.providers['slp-pi-supervisor'], 'the referenced provider survives');
});

test('deactivation under a settings-driven binding still removes every owned id', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const store = createStateStore();

  await setRouting(store, home, { family: 'pi' }, { family: 'devin' });
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 7);

  const deact = await manager.deactivate(
    deactivateInput(home, randomUUID(), doneAct.binding.bindingSha256),
    daemon,
  );
  const done = await waitTerminal(manager, home, deact.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 0);
});

// ---------------------------------------------------------------------------
// Peer pool: plugin-owned user-scope catalog at state/peer-pool.json
// ---------------------------------------------------------------------------

const poolPath = home => join(home, 'slp-runtime', 'state', 'peer-pool.json');
const legacyPoolPath = home => join(home, 'slp-routing.json');
const writeFile = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
};

const poolFixture = {
  version: 1,
  policy: 'Peers pick the cheapest live seat that fits the work.',
  quotaFallback: { enabled: true, optionId: 'peer-eng' },
  options: [{
    id: 'peer-eng',
    provider: 'codex',
    roles: ['peer'],
    model: 'gpt-5-codex',
    enabled: true,
    availability: 'ready',
    modeId: 'fast',
    suitableFor: ['bounded coding tasks'],
    avoidFor: ['open-ended research'],
    notes: 'Local-only annotation — never sent to Jev.',
  }],
};

const getPool = (store, home) =>
  store.getPeerPool({ schemaVersion: 1, target: targetOf(home) });
const setPool = (store, home, pool, expectedSha256) =>
  store.setPeerPool({ schemaVersion: 1, target: targetOf(home), pool, expectedSha256 });

test('peer pool round-trips through get/set under sha256 CAS', async t => {
  const home = makeHome(t);
  const manager = createManager(makeDeps());
  const store = createStateStore();
  const file = poolPath(home);

  // Absent file → all null, no error.
  assert.equal(existsSync(file), false);
  assert.deepEqual(await getPool(store, home), {
    schemaVersion: 1, pool: null, sha256: null, error: null, legacy: null, legacyError: null,
  });

  // First write: expectedSha256 null means "expect no file".
  const written = await setPool(store, home, poolFixture, null);
  assert.deepEqual(written.pool, poolFixture);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), poolFixture);

  // Read returns the pool plus the hash token the next write must carry.
  const read = await getPool(store, home);
  assert.deepEqual(read.pool, poolFixture);
  assert.equal(read.sha256, written.sha256);
  assert.equal(read.error, null);

  // Whole-file overwrite with the correct token lands and rotates the hash.
  const next = { ...poolFixture, policy: 'Amended policy' };
  const rewritten = await setPool(store, home, next, read.sha256);
  assert.notEqual(rewritten.sha256, read.sha256);
  assert.deepEqual((await getPool(store, home)).pool, next);

  // No tmp siblings survive the atomic write.
  const stateDir = join(home, 'slp-runtime', 'state');
  assert.deepEqual(readdirSync(stateDir).filter(name => name.endsWith('.tmp')), []);
});

test('set-peer-pool refuses a stale sha256 and leaves the file untouched', async t => {
  const home = makeHome(t);
  const manager = createManager(makeDeps());
  const store = createStateStore();
  const file = poolPath(home);

  const first = await setPool(store, home, poolFixture, null);
  const before = readFileSync(file, 'utf8');

  // A writer holding the pre-write view (null) or an old token both fail.
  for (const [name, expectedSha256] of [['null token on existing file', null], ['stale token', 'f'.repeat(64)]]) {
    const err = await setPool(store, home, poolFixture, expectedSha256).catch(e => e);
    assert.equal(err?.name, 'OperationConflict', name);
    assert.equal(err?.code, 'IDEMPOTENCY_CONFLICT', name);
    assert.match(err?.message ?? '', /peer pool changed/, name);
    assert.equal(readFileSync(file, 'utf8'), before, `${name}: conflict never touches the file`);
  }
  assert.equal(first.sha256, (await getPool(store, home)).sha256);
});

test('get-peer-pool surfaces a malformed file with its sha256 so CAS overwrite still works', async t => {
  const home = makeHome(t);
  const manager = createManager(makeDeps());
  const store = createStateStore();
  const file = poolPath(home);

  writeFile(file, '{ not json');
  const bad = await getPool(store, home);
  assert.equal(bad.pool, null);
  assert.match(bad.error, /not valid JSON/);
  assert.equal(typeof bad.sha256, 'string', 'sha256 of raw bytes still reported');

  // The editor can overwrite the corrupt file under CAS with that token.
  const fixed = await setPool(store, home, poolFixture, bad.sha256);
  assert.deepEqual((await getPool(store, home)).pool, poolFixture);
  assert.equal(fixed.sha256, (await getPool(store, home)).sha256);
});

test('legacy slp-routing.json is offered for import and never modified', async t => {
  const home = makeHome(t);
  const manager = createManager(makeDeps());
  const store = createStateStore();
  const legacyFile = legacyPoolPath(home);
  // The on-disk legacy shape carries the wave-5 optionIds list; reads
  // normalize it to the single-option contract (wave-6 migration, ≤1).
  const legacyPool = {
    ...poolFixture,
    quotaFallback: { enabled: true, optionIds: ['peer-legacy'] },
    options: [{ ...poolFixture.options[0], id: 'peer-legacy' }],
  };
  const migratedPool = { ...legacyPool, quotaFallback: { enabled: true, optionId: 'peer-legacy' } };

  writeFile(legacyFile, `${JSON.stringify(legacyPool)}\n`);
  const before = readFileSync(legacyFile, 'utf8');

  // Absent peer-pool.json but present legacy file → legacy pool readable,
  // in its migrated optionId shape.
  const read = await getPool(store, home);
  assert.equal(read.pool, null);
  assert.deepEqual(read.legacy, migratedPool);
  assert.equal(read.legacyError, null);

  // Saving the pool writes only state/peer-pool.json; legacy bytes untouched.
  await setPool(store, home, migratedPool, null);
  assert.equal(readFileSync(legacyFile, 'utf8'), before, 'legacy file is read-only');
  assert.deepEqual((await getPool(store, home)).pool, migratedPool);

  // A malformed legacy file surfaces as legacyError, not as the pool error.
  writeFile(legacyFile, '{ not json');
  const broken = await getPool(store, home);
  assert.equal(broken.legacy, null);
  assert.match(broken.legacyError, /not valid JSON/);
  assert.equal(broken.error, null, 'pool file is fine — only legacy is broken');
});

test('set-peer-pool rejects malformed input and unknown keys', async t => {
  const home = makeHome(t);
  const manager = createManager(makeDeps());
  const store = createStateStore();
  const target = targetOf(home);
  const cases = [
    ['unknown top-level key', { schemaVersion: 1, target, pool: poolFixture, expectedSha256: null, extra: 1 }],
    ['missing pool', { schemaVersion: 1, target, expectedSha256: null }],
    ['pool wrong version', { schemaVersion: 1, target, pool: { ...poolFixture, version: 2 }, expectedSha256: null }],
    ['empty policy', { schemaVersion: 1, target, pool: { ...poolFixture, policy: '' }, expectedSha256: null }],
    ['quotaFallback unknown key', { schemaVersion: 1, target, pool: { ...poolFixture, quotaFallback: { enabled: true, optionId: 'peer-eng', bogus: 1 } }, expectedSha256: null }],
    ['unknown option provider', { schemaVersion: 1, target, pool: { ...poolFixture, options: [{ ...poolFixture.options[0], provider: 'gpt' }] }, expectedSha256: null }],
    ['non-string expectedSha256', { schemaVersion: 1, target, pool: poolFixture, expectedSha256: 7 }],
    ['wrong schemaVersion', { schemaVersion: 2, target, pool: poolFixture, expectedSha256: null }],
  ];
  for (const [name, input] of cases) {
    await assert.rejects(() => store.setPeerPool(input), /invalid set-peer-pool input/, name);
  }
  await assert.rejects(
    () => store.getPeerPool({ schemaVersion: 1 }),
    /invalid get-peer-pool input/,
  );
  assert.equal(existsSync(poolPath(home)), false, 'a rejected write never creates the file');
});

// ---------------------------------------------------------------------------
// Schema parity: the wire schema and the package validator must never drift
// ---------------------------------------------------------------------------
// set-peer-pool writes bytes that plugin/server/runtime/cli/routing.ts::readCatalog later validates
// for every repository without a repo-pinned catalog. A verdict mismatch means
// either a saved pool that kills prepare/routes on every unpinned repo (wire
// looser), or a healthy file the Manager reports as broken (wire stricter).
// This table pins both sides to the same accept/reject verdict per case.

import { PeerPool } from '../plugin/shared/contracts.ts';
import { validateCatalog } from '../plugin/server/runtime/cli/routing.ts';

test('plugin PeerPool schema and package validateCatalog agree on every verdict', () => {
  const seat = {
    id: 'peer-eng', provider: 'codex', roles: ['peer'], model: 'gpt-5-codex',
    enabled: true, availability: 'ready', suitableFor: ['bounded coding'],
    avoidFor: ['open-ended research'], notes: 'Local-only note.',
  };
  const parked = {
    ...seat, id: 'peer-parked', provider: '', model: '', enabled: false,
    notes: 'Archetype seat parked until configured.',
  };
  const base = { version: 1, policy: 'Peers pick the cheapest live seat that fits.', options: [seat] };
  const opt = patch => ({ ...seat, ...patch });
  const pool = patch => ({ ...base, ...patch });
  const cases = [
    // Valid shapes first — both sides must accept.
    ['valid pool', base, true],
    ['parked archetype seat (blank provider+model, disabled)', pool({ options: [seat, parked] }), true],
    ['legacy extra option key (priority)', pool({ options: [opt({ priority: 3 })] }), true],
    ['extra top-level key', pool({ extra: 1 }), true],
    ['explicit nulls on nullish keys', pool({ quotaFallback: null, options: [opt({ modeId: null, thinkingOptionId: null, features: null })] }), true],
    ['devin enabled + swe-2 model', pool({ options: [opt({ provider: 'devin', model: 'swe-2-max' })] }), true],
    ['devin disabled + non-swe-2 model', pool({ options: [opt({ provider: 'devin', model: 'other', enabled: false })] }), true],
    ['quotaFallback disabled + null optionId', pool({ quotaFallback: { enabled: false, optionId: null } }), true],
    ['quotaFallback disabled + designated id kept', pool({ quotaFallback: { enabled: false, optionId: 'peer-eng' } }), true],
    ['quotaFallback enabled + designated id', pool({ quotaFallback: { enabled: true, optionId: 'peer-eng' } }), true],
    ['legacy optionIds [] migrates to null', pool({ quotaFallback: { enabled: false, optionIds: [] } }), true],
    ['legacy optionIds [one] migrates to that id', pool({ quotaFallback: { enabled: true, optionIds: ['peer-eng'] } }), true],
    ['empty options list', pool({ options: [] }), true],
    ['empty suitableFor/avoidFor arrays', pool({ options: [opt({ suitableFor: [], avoidFor: [] })] }), true],

    // Write-direction mismatches the review reproduced — both sides must reject.
    ['blank provider + enabled', pool({ options: [opt({ provider: '' })] }), false],
    ['enabled + empty model', pool({ options: [opt({ model: '' })] }), false],
    ['model with space', pool({ options: [opt({ model: 'gpt 5' })] }), false],
    ['model with newline', pool({ options: [opt({ model: 'gpt-5\n' })] }), false],
    ['model with control char', pool({ options: [opt({ model: 'gpt-5\x07' })] }), false],
    ['devin enabled + non-swe-2 model', pool({ options: [opt({ provider: 'devin', model: 'gpt-5' })] }), false],
    ['modeId whitespace', pool({ options: [opt({ modeId: ' ' })] }), false],
    ['modeId bad chars', pool({ options: [opt({ modeId: 'fast!' })] }), false],
    ['thinkingOptionId bad chars', pool({ options: [opt({ thinkingOptionId: 'a b' })] }), false],
    ['policy whitespace-only', pool({ policy: '   ' }), false],
    ['notes whitespace-only', pool({ options: [opt({ notes: ' ' })] }), false],
    ['suitableFor whitespace element', pool({ options: [opt({ suitableFor: [' '] })] }), false],
    ['avoidFor whitespace element', pool({ options: [opt({ avoidFor: [' ', 'ok'] })] }), false],
    ['duplicate option ids', pool({ options: [seat, seat] }), false],
    ['quotaFallback unknown designated id', pool({ quotaFallback: { enabled: false, optionId: 'peer-ghost' } }), false],
    ['quotaFallback enabled + null optionId', pool({ quotaFallback: { enabled: true, optionId: null } }), false],
    ['quotaFallback extra key', pool({ quotaFallback: { enabled: false, optionId: null, bogus: 1 } }), false],
    ['quotaFallback optionId non-string', pool({ quotaFallback: { enabled: false, optionId: 7 } }), false],
    ['legacy optionIds >1 fails closed', pool({ quotaFallback: { enabled: true, optionIds: ['peer-eng', 'peer-eng'] } }), false],
    ['legacy optionIds + optionId together rejected', pool({ quotaFallback: { enabled: false, optionId: 'peer-eng', optionIds: ['peer-eng'] } }), false],
    ['legacy optionIds unknown id still rejected', pool({ quotaFallback: { enabled: false, optionIds: ['peer-ghost'] } }), false],
    ['legacy optionIds enabled + empty still rejected', pool({ quotaFallback: { enabled: true, optionIds: [] } }), false],
    ['legacy optionIds non-array rejected', pool({ quotaFallback: { enabled: false, optionIds: 'peer-eng' } }), false],
    ['legacy optionIds non-string element rejected', pool({ quotaFallback: { enabled: false, optionIds: [7] } }), false],

    // Read-direction mismatches — the wire must accept what the package reads.
    ['modeId null reads fine', pool({ options: [opt({ modeId: null })] }), true],
    ['features null reads fine', pool({ options: [opt({ features: null })] }), true],

    // Shape-level rejects both sides share.
    ['unknown provider family', pool({ options: [opt({ provider: 'gpt' })] }), false],
    ['unknown provider + disabled', pool({ options: [opt({ provider: 'gpt', enabled: false })] }), false],
    ['roles empty', pool({ options: [opt({ roles: [] })] }), false],
    ['roles unknown value', pool({ options: [opt({ roles: ['peer', 'bogus'] })] }), false],
    ['availability unknown', pool({ options: [opt({ availability: 'gone' })] }), false],
    ['enabled non-boolean', pool({ options: [opt({ enabled: 'yes' })] }), false],
    ['features array', pool({ options: [opt({ features: [1] })] }), false],
    ['features string', pool({ options: [opt({ features: 'x' })] }), false],
    ['version 2', pool({ version: 2 }), false],
    ['options non-array', pool({ options: {} }), false],
    ['missing notes', pool({ options: [opt({ notes: undefined })] }), false],
    ['non-record option', pool({ options: ['x'] }), false],
    ['missing policy', { version: 1, options: [seat] }, false],
    ['id bad pattern', pool({ options: [opt({ id: 'Peer_X' })] }), false],
    ['id empty', pool({ options: [opt({ id: '' })] }), false],
    ['id is the Jev decline sentinel', pool({ options: [opt({ id: 'no-suitable-option' })] }), false],
    ['quotaFallback array', pool({ quotaFallback: [] }), false],
    ['quotaFallback empty object', pool({ quotaFallback: {} }), false],
    ['quotaFallback string', pool({ quotaFallback: 'peer-eng' }), false],
    ['suitableFor non-array', pool({ options: [opt({ suitableFor: 'x' })] }), false],
    ['non-record catalog', 'x', false],
    ['null catalog', null, false],
  ];
  for (const [name, candidate, expected] of cases) {
    let pkg;
    try { validateCatalog(candidate); pkg = true; } catch { pkg = false; }
    const wire = PeerPool.safeParse(candidate).success;
    assert.equal(pkg, expected, `${name}: package verdict`);
    assert.equal(wire, expected, `${name}: wire verdict`);
    assert.equal(pkg, wire, `${name}: schemas diverged`);
  }
});

test('legacy fs failure degrades to legacyError; pool fs failure throws IO_FAILURE', async t => {
  const home = makeHome(t);
  const manager = createManager(makeDeps());
  const store = createStateStore();

  // A directory where the legacy file should be: the advisory probe reports
  // the fs error as evidence and the healthy pool still answers.
  mkdirSync(legacyPoolPath(home));
  await setPool(store, home, poolFixture, null);
  const read = await getPool(store, home);
  assert.deepEqual(read.pool, poolFixture);
  assert.equal(read.legacy, null);
  assert.match(read.legacyError, /unreadable|EISDIR/);

  // The pool path itself failing to read must fail loud with a coded
  // conflict, not render the pool as absent.
  rmSync(poolPath(home));
  mkdirSync(poolPath(home));
  const err = await getPool(store, home).catch(e => e);
  assert.equal(err?.name, 'OperationConflict');
  assert.equal(err?.code, 'IO_FAILURE');
  assert.match(err?.message ?? '', /unreadable|EISDIR/);
  // set-peer-pool hits the same wall at the CAS gate rather than treating the
  // unreadable file as absent.
  const writeErr = await setPool(store, home, poolFixture, null).catch(e => e);
  assert.equal(writeErr?.code, 'IO_FAILURE');
});

test('legacy optionIds migrates to a single optionId — ≤1 normalizes, >1 fails closed', () => {
  const seat = {
    id: 'peer-eng', provider: 'codex', roles: ['peer'], model: 'gpt-5-codex',
    enabled: true, availability: 'ready', suitableFor: ['bounded coding'],
    avoidFor: [], notes: 'Local-only note.',
  };
  const base = { version: 1, policy: 'Peers pick the cheapest live seat that fits.', options: [seat] };
  for (const optionIds of [[], ['peer-eng']]) {
    const legacy = { ...base, quotaFallback: { enabled: optionIds.length === 1, optionIds } };
    const expected = { enabled: optionIds.length === 1, optionId: optionIds[0] ?? null };
    // Package validator: normalizes the catalog in place.
    const catalog = validateCatalog(structuredClone(legacy));
    assert.deepEqual(catalog.quotaFallback, expected, `package migration of ${JSON.stringify(optionIds)}`);
    // Wire schema: same normalization on parse output.
    const parsed = PeerPool.safeParse(legacy);
    assert.equal(parsed.success, true, `wire migration of ${JSON.stringify(optionIds)}`);
    assert.deepEqual(parsed.data.quotaFallback, expected);
  }
  // More than one legacy entry is ambiguous — both sides fail closed rather
  // than silently take-first.
  const ambiguous = { ...base, quotaFallback: { enabled: true, optionIds: ['peer-eng', 'peer-eng'] } };
  assert.throws(() => validateCatalog(structuredClone(ambiguous)), /exactly one/);
  const wire = PeerPool.safeParse(ambiguous);
  assert.equal(wire.success, false);
  assert.match(JSON.stringify(wire.error.issues), /exactly one/);
});
