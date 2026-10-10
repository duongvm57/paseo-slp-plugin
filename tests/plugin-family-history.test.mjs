import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createJournal } from '../plugin/server/journal.ts';
import { createManager } from '../plugin/server/manager.ts';
import { canonicalSha256, effectiveView, extractProjection, unrelatedPersistedView } from '../plugin/server/config-view.ts';
import { classifyState, patchForDirection } from '../plugin/server/config-transaction.ts';
import { Receipt, OwnedProvider, PersistedProvider, Projection } from '../plugin/shared/contracts.ts';
import { LEGACY_OWNED_PROVIDER_IDS, OWNED_PROVIDER_IDS } from '../plugin/shared/runtime/families.ts';
import { activateInput, deactivateInput, reconcileInput, makePluginFixture, makeDeps, makeDaemon, receiptPath, readReceipt, readConfigJson, sha256, waitTerminal, waitRecovery, dirBlocker, armRecoveryFault } from './helpers/plugin-doubles.mjs';

const addedIds = ['slp-opencode-supervisor', 'slp-opencode-lead', 'slp-opencode-peer'];
const encoded = value => JSON.stringify(value, null, 2) + '\n';

// Author a synthetic legacy corpus. These conversions belong only to fixture
// construction: production must never perform them on persisted history.
async function legacyFixture(t, { inactive = false, pending = false } = {}) {
  const f = await makePluginFixture(t);
  const manager = createManager(f.deps);
  if (pending) { dirBlocker(f.home); armRecoveryFault(f.deps, 'activate', 'patch-dispatched'); }
  const start = await manager.activate(activateInput(f.home, f.deps.payload, randomUUID()), f.daemon);
  if (pending) await waitRecovery(manager, f.home, f.daemon);
  else await waitTerminal(manager, f.home, start.operation.operationId, f.daemon);
  if (inactive) {
    const op = await manager.deactivate(deactivateInput(f.home, randomUUID(), readReceipt(f.home).binding.bindingSha256), f.daemon);
    await waitTerminal(manager, f.home, op.operation.operationId, f.daemon);
  }
  const receipt = readReceipt(f.home);
  const sets = new Map();
  const rewriteSet = binding => {
    if (!binding || sets.has(binding.launchSetSha256)) return;
    const oldDir = dirname(binding.launcherFiles[0].path);
    const manifest = JSON.parse(readFileSync(join(oldDir, 'launch.json'), 'utf8'));
    delete manifest.binaries.opencode;
    manifest.launchers = manifest.launchers.filter(file => !addedIds.includes(file.id));
    const bytes = encoded(manifest); const manifestSha = sha256(bytes);
    const setSha = sha256(manifestSha + manifest.launchers.map(file => file.sha256).join(''));
    const directory = join(f.home, 'slp-runtime/launchers', setSha); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'launch.json'), bytes);
    for (const file of manifest.launchers) writeFileSync(join(directory, file.id), readFileSync(join(oldDir, file.id)), { mode: file.mode });
    sets.set(binding.launchSetSha256, { setSha, manifestSha, directory });
  };
  rewriteSet(receipt.binding);
  for (const op of receipt.operations) { rewriteSet(op.plan?.previousBinding); rewriteSet(op.plan?.nextBinding); }
  const projection = value => { for (const id of addedIds) delete value.providers[id]; };
  const snapshot = value => { projection(value.owned); value.ownedSha256 = canonicalSha256(value.owned); };
  const binding = value => {
    if (!value) return;
    const set = sets.get(value.launchSetSha256);
    value.launchSetSha256 = set.setSha; value.launchManifestSha256 = set.manifestSha;
    value.launcherFiles = value.launcherFiles.filter(file => !addedIds.includes(basename(file.path))).map(file => ({ ...file, path: join(set.directory, basename(file.path)) }));
    delete value.binaries.opencode; projection(value.owned); snapshot(value.beforeActivation);
    value.postPatchPersistedShapeSha256 = canonicalSha256(value.owned);
    value.bindingSha256 = canonicalSha256({ candidateSha256: value.candidateSha256, payloadSha256: value.payloadSha256, launchSetSha256: value.launchSetSha256, owned: value.owned });
  };
  binding(receipt.binding);
  for (const op of receipt.operations) {
    if (!op.plan) continue;
    snapshot(op.plan.before); projection(op.plan.afterOwned); op.plan.afterOwnedSha256 = canonicalSha256(op.plan.afterOwned);
    binding(op.plan.previousBinding); binding(op.plan.nextBinding);
  }
  for (const retained of receipt.retained) {
    const set = sets.get(retained.launchSetSha256); if (set) retained.launchSetSha256 = set.setSha;
  }
  const config = readConfigJson(f.home);
  for (const id of addedIds) delete config.agents?.providers?.[id];
  writeFileSync(join(f.home, 'config.json'), encoded(config));
  const bytes = encoded(receipt); writeFileSync(receiptPath(f.home), bytes);
  f.daemon = await makeDaemon(t, f.home);
  const journal = createJournal();
  assert.deepEqual(journal.read(join(f.home, 'slp-runtime')), receipt, 'fixture is an admitted legacy record before scenarios');
  return { ...f, receipt, bytes, journal, stableRoot: join(f.home, 'slp-runtime'), rootOperationId: start.operation.operationId, manager: createManager(makeDeps({ payload: f.deps.payload, execOpts: { binaries: f.binaries } })) };
}

test('legacy active and inactive histories read verbatim, preserve every digest and do not gain absent OpenCode slots', async t => {
  for (const inactive of [false, true]) {
    const f = await legacyFixture(t, { inactive });
    const read = f.journal.read(f.stableRoot);
    assert.deepEqual(read, f.receipt); assert.equal(readFileSync(receiptPath(f.home), 'utf8'), f.bytes);
    for (const op of read.operations) {
      assert.equal(Object.keys(op.plan.afterOwned.providers).length, 12);
      assert.equal(Object.hasOwn(op.plan.afterOwned.providers, 'slp-opencode-peer'), false);
      assert.equal(op.plan.afterOwnedSha256, f.receipt.operations.find(x => x.operationId === op.operationId).plan.afterOwnedSha256);
    }
    if (!inactive) assert.equal(Object.hasOwn(read.binding.binaries, 'opencode'), false);
  }
});

test('legacy parsing rejects partial, mixed, unknown domains and verbatim hash tampering without rewriting bytes', async t => {
  const f = await legacyFixture(t);
  const mutations = [
    r => delete r.binding.binaries.pi,
    r => { r.binding.binaries.future = { available: false, path: null, version: null }; },
    r => { r.binding.binaries.opencode = { available: false, path: null, version: null }; },
    r => delete r.binding.owned.providers['slp-pi-peer'],
    r => { r.binding.owned.providers['slp-future-peer'] = { present: false }; },
    r => { r.operations[0].plan.afterOwned.providers['slp-opencode-peer'] = { present: false }; },
    r => { r.binding.bindingSha256 = 'f'.repeat(64); },
    r => { r.operations[0].plan.before.ownedSha256 = 'f'.repeat(64); },
    r => { r.operations[0].plan.afterOwnedSha256 = 'f'.repeat(64); },
    r => { r.binding.launcherFiles[0].path = join(dirname(r.binding.launcherFiles[0].path), 'slp-opencode-peer'); },
  ];
  for (const mutate of mutations) {
    const r = structuredClone(f.receipt); mutate(r); const bytes = encoded(r); writeFileSync(receiptPath(f.home), bytes);
    assert.throws(() => f.journal.read(f.stableRoot), error => error.code === 'RECOVERY_REQUIRED');
    assert.equal(readFileSync(receiptPath(f.home), 'utf8'), bytes);
  }
  const mixedPlan = structuredClone(f.receipt);
  for (const id of addedIds) mixedPlan.operations[0].plan.afterOwned.providers[id] = { present: false };
  mixedPlan.operations[0].plan.afterOwnedSha256 = canonicalSha256(mixedPlan.operations[0].plan.afterOwned);
  assert.equal(Receipt.safeParse(mixedPlan).success, false, 'individually valid endpoint domains cannot mix inside a plan');
});

test('journal retains old artifacts across CAS writes but rejects new or edited legacy evidence even with recalculated digests', async t => {
  const f = await legacyFixture(t);
  // Non-schema key order is also retained: validation must not serialize a
  // schema-normalized replacement for the historical artifact.
  f.receipt.binding = Object.fromEntries(Object.entries(f.receipt.binding).reverse());
  writeFileSync(receiptPath(f.home), encoded(f.receipt));
  assert.equal(JSON.stringify(f.journal.read(f.stableRoot).binding), JSON.stringify(f.receipt.binding));
  const next = structuredClone(f.receipt); next.revision++;
  f.journal.write(f.stableRoot, next);
  assert.deepEqual(readReceipt(f.home).operations, f.receipt.operations);
  assert.deepEqual(readReceipt(f.home).binding, f.receipt.binding);
  assert.equal(JSON.stringify(readReceipt(f.home).binding), JSON.stringify(f.receipt.binding));
  const stable = readFileSync(receiptPath(f.home), 'utf8');
  assert.throws(() => f.journal.write(f.stableRoot, next), /revision must advance/);
  const changed = structuredClone(next); changed.revision++;
  changed.binding.verifiedAt = '2026-10-09T00:00:00.000Z';
  assert.throws(() => f.journal.write(f.stableRoot, changed), /modified historical binding refused/);
  assert.equal(readFileSync(receiptPath(f.home), 'utf8'), stable);
  const fresh = structuredClone(f.receipt); fresh.revision = 0;
  assert.throws(() => f.journal.write(join(f.home, 'new-empty-root'), fresh), /new or modified historical/);
});

test('authorized rebind emits current15/current5 while preserving the exact legacy plan, baseline and edited profile bundle', async t => {
  const f = await legacyFixture(t);
  const config = readConfigJson(f.home);
  config.agents.providers.personal = { extends: 'codex', label: 'Unrelated', command: ['/bin/true'] };
  const profile = config.daemon.agentProfiles.find(p => p.id === 'slp-lead');
  Object.assign(profile, { model: 'provider/nested/model', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast_mode: true } });
  writeFileSync(join(f.home, 'config.json'), encoded(config));
  f.daemon = await makeDaemon(t, f.home);
  const start = await f.manager.activate(activateInput(f.home, f.deps.payload, randomUUID()), f.daemon);
  const done = await waitTerminal(f.manager, f.home, start.operation.operationId, f.daemon);
  assert.equal(done.operation.outcome, 'succeeded', JSON.stringify(done.conflicts));
  const read = readReceipt(f.home);
  assert.equal(Object.keys(read.binding.binaries).length, 5); assert.equal(Object.keys(read.binding.owned.providers).length, 15);
  assert.deepEqual(read.operations[0], f.receipt.operations[0]); assert.deepEqual(read.binding.beforeActivation, f.receipt.binding.beforeActivation);
  assert.deepEqual(readConfigJson(f.home).agents.providers.personal, config.agents.providers.personal);
  const result = readConfigJson(f.home).daemon.agentProfiles.find(p => p.id === 'slp-lead');
  for (const key of ['model', 'modeId', 'thinkingOptionId', 'featureValues']) assert.deepEqual(result[key], profile[key]);
  const plan = read.operations.at(-1).plan;
  assert.equal(Object.keys(plan.before.owned.providers).length, 15); assert.equal(Object.keys(plan.afterOwned.providers).length, 15);
  assert.deepEqual(plan.previousBinding, f.receipt.binding);
});

test('a provider absent from the legacy vocabulary is never silently claimed or deleted', async t => {
  const f = await legacyFixture(t); const config = readConfigJson(f.home);
  const foreign = { extends: 'opencode', label: 'Pre-existing OpenCode', command: ['/bin/true'], enabled: true, env: {} };
  config.agents.providers['slp-opencode-peer'] = foreign; writeFileSync(join(f.home, 'config.json'), encoded(config));
  f.daemon = await makeDaemon(t, f.home);
  const before = readFileSync(join(f.home, 'config.json'), 'utf8');
  const patchesBefore = f.daemon.patchCalls.length;
  const start = await f.manager.activate(activateInput(f.home, f.deps.payload, randomUUID()), f.daemon);
  const failed = await waitTerminal(f.manager, f.home, start.operation.operationId, f.daemon);
  assert.equal(failed.operation.outcome, 'failed'); assert.ok(readReceipt(f.home).operations.at(-1).conflicts.some(c => c.code === 'COLLISION'));
  assert.equal(readFileSync(join(f.home, 'config.json'), 'utf8'), before);
  assert.equal(f.daemon.patchCalls.length, patchesBefore, 'typed collision precedes daemon effects');
  assert.deepEqual(readReceipt(f.home).binding, f.receipt.binding); assert.deepEqual(readReceipt(f.home).operations[0], f.receipt.operations[0]);
  const deactivate = await f.manager.deactivate(deactivateInput(f.home, randomUUID(), f.receipt.binding.bindingSha256), f.daemon);
  const done = await waitTerminal(f.manager, f.home, deactivate.operation.operationId, f.daemon);
  assert.equal(done.operation.outcome, 'succeeded', JSON.stringify(done.conflicts));
  assert.deepEqual(readConfigJson(f.home).agents.providers['slp-opencode-peer'], foreign);
  assert.equal(readReceipt(f.home).binding, null);
  assert.ok(!f.daemon.patchCalls.at(-1).removeProviders.includes('slp-opencode-peer'));
});

test('pending legacy recovery completes or restores its original pinned plan without adding OpenCode ownership', async t => {
  for (const action of ['complete', 'restore-before']) {
    const f = await legacyFixture(t, { pending: true });
    const oldPlan = structuredClone(f.receipt.operations[0].plan);
    const start = await f.manager.reconcile(reconcileInput(f.home, randomUUID(), action, f.rootOperationId), f.daemon);
    const done = await waitTerminal(f.manager, f.home, start.operation.operationId, f.daemon);
    assert.equal(done.operation.outcome, 'succeeded', JSON.stringify(done.conflicts));
    const read = readReceipt(f.home); assert.deepEqual(read.operations[0].plan, oldPlan);
    if (action === 'complete') {
      assert.equal(done.state, 'ACTIVE'); assert.equal(Object.keys(read.binding.binaries).length, 4);
      assert.deepEqual(read.binding, oldPlan.nextBinding);
      assert.ok(Object.keys(readConfigJson(f.home).agents.providers).every(id => !id.startsWith('slp-opencode-')));
    } else { assert.equal(done.state, 'INACTIVE'); assert.equal(read.binding, null); }
  }
});

test('legacy endpoint comparison hashes its own unrelated domain; inverse recovery cannot remove new unrelated family slots', async t => {
  const f = await legacyFixture(t, { pending: true }); const plan = f.receipt.operations[0].plan;
  const config = readConfigJson(f.home); const effective = effectiveView((await f.daemon.config.get()).config);
  assert.equal(classifyState(config, (await f.daemon.config.get()).config, plan).class, 'before');
  const current = extractProjection(config, 'COLLISION'); assert.equal(Object.keys(current.providers).length, 15);
  const historical = extractProjection(config, 'COLLISION', LEGACY_OWNED_PROVIDER_IDS); assert.equal(Object.keys(historical.providers).length, 12);
  const changed = structuredClone(config); changed.agents ??= {}; changed.agents.providers ??= {}; changed.agents.providers['slp-opencode-peer'] = { extends: 'opencode', label: 'External', command: ['/bin/true'], enabled: true, env: {} };
  assert.notEqual(canonicalSha256(unrelatedPersistedView(changed, LEGACY_OWNED_PROVIDER_IDS)), canonicalSha256(unrelatedPersistedView(config, LEGACY_OWNED_PROVIDER_IDS)));
  const inverse = patchForDirection(plan, 'activate', 'inverse', changed);
  assert.deepEqual(inverse.removeProviders.sort(), [...LEGACY_OWNED_PROVIDER_IDS].sort());
  assert.equal(OWNED_PROVIDER_IDS.length, 15); assert.equal(effective.enabled, true);
});


test('native OpenCode observations preserve raw fields/hash while current owned schema requires ACP', async t => {
  const f = await legacyFixture(t); const raw = readConfigJson(f.home);
  const foreign = { extends: 'opencode', label: 'Native observation', command: ['/bin/true'], enabled: true, env: { KEEP: 'bytes' } };
  const rawBytes = encoded(foreign); const oldHash = canonicalSha256(foreign);
  assert.deepEqual(PersistedProvider.parse(foreign), foreign);
  assert.equal(OwnedProvider.safeParse(foreign).success, false, 'native is not current authored provider config');
  assert.equal(OwnedProvider.safeParse({ ...foreign, extends: 'acp' }).success, true);
  assert.equal(PersistedProvider.safeParse({ ...foreign, extends: 'unknown' }).success, false);
  raw.agents.providers['slp-opencode-peer'] = foreign;
  const observation = extractProjection(raw, 'COLLISION');
  assert.deepEqual(Projection.parse(observation), observation);
  assert.equal(encoded(observation.providers['slp-opencode-peer'].value), rawBytes);
  assert.equal(canonicalSha256(observation.providers['slp-opencode-peer'].value), oldHash);
  const mixed = structuredClone(observation); delete mixed.providers['slp-opencode-lead'];
  assert.equal(Projection.safeParse(mixed).success, false);
  const plan = f.receipt.operations[0].plan;
  assert.ok(!patchForDirection(plan, 'activate', 'inverse', raw).removeProviders.includes('slp-opencode-peer'));
  assert.equal(encoded(raw.agents.providers['slp-opencode-peer']), rawBytes, 'restore planning does not mutate foreign native fields');
});

test('legacy deactivate recovery restores foreign native OpenCode verbatim and keeps old hashes', async t => {
  const f = await legacyFixture(t); const raw = readConfigJson(f.home);
  const foreign = { extends: 'opencode', label: 'Unowned native', command: ['/bin/true'], enabled: true, env: { FOREIGN: 'keep' } };
  raw.agents.providers['slp-opencode-peer'] = foreign; writeFileSync(join(f.home, 'config.json'), encoded(raw));
  f.daemon = await makeDaemon(t, f.home); const crashingDeps = makeDeps({ payload: f.deps.payload, execOpts: { binaries: f.binaries } });
  f.manager = createManager(crashingDeps); dirBlocker(f.home); armRecoveryFault(crashingDeps, 'deactivate', 'settled');
  const opId = randomUUID(); await f.manager.deactivate(deactivateInput(f.home, opId, f.receipt.binding.bindingSha256), f.daemon);
  await waitRecovery(f.manager, f.home, f.daemon);
  const oldPlan = structuredClone(readReceipt(f.home).operations.find(op => op.operationId === opId).plan);
  const manager = createManager(makeDeps({ payload: f.deps.payload, execOpts: { binaries: f.binaries } }));
  const id = randomUUID(); await manager.reconcile(reconcileInput(f.home, id, 'restore-before', opId), f.daemon);
  const done = await waitTerminal(manager, f.home, id, f.daemon);
  assert.equal(done.operation.outcome, 'succeeded', JSON.stringify(done.conflicts));
  assert.deepEqual(readConfigJson(f.home).agents.providers['slp-opencode-peer'], foreign);
  assert.equal(canonicalSha256(readConfigJson(f.home).agents.providers['slp-opencode-peer']), canonicalSha256(foreign));
  assert.deepEqual(readReceipt(f.home).operations.find(op => op.operationId === opId).plan, oldPlan);
  assert.deepEqual(readReceipt(f.home).binding, f.receipt.binding);
  assert.ok(f.daemon.patchCalls.every(patch => !patch.removeProviders.includes('slp-opencode-peer')));
});


test('journal refuses a newly authored native OpenCode binding even with internally correct hashes', async t => {
  const f = await makePluginFixture(t); const manager = createManager(f.deps);
  const op = await manager.activate(activateInput(f.home, f.deps.payload, randomUUID()), f.daemon);
  await waitTerminal(manager, f.home, op.operation.operationId, f.daemon);
  const path = receiptPath(f.home); const bytes = readFileSync(path, 'utf8'); const receipt = readReceipt(f.home);
  const binding = receipt.binding; assert.equal(binding.owned.providers['slp-opencode-peer'].value.extends, 'acp');
  binding.owned.providers['slp-opencode-peer'].value.extends = 'opencode';
  binding.postPatchPersistedShapeSha256 = canonicalSha256(binding.owned);
  binding.bindingSha256 = canonicalSha256({ candidateSha256: binding.candidateSha256, payloadSha256: binding.payloadSha256, launchSetSha256: binding.launchSetSha256, owned: binding.owned });
  receipt.revision++;
  assert.throws(() => createJournal().write(join(f.home, 'slp-runtime'), receipt), /new binding provider slp-opencode-peer must extend acp/);
  assert.equal(readFileSync(path, 'utf8'), bytes, 'failed native binding write preserves the serialized receipt');
});
