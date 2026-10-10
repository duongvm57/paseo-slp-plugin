// tests/plugin-recovery.test.mjs — recovery-lane coverage: durable-phase crash
// fixtures, journal write failure after patch success, explicit
// complete/restore-before, no blind rollback, idempotent recovery retries.
//
// Crash points are named at the operation boundary by armRecoveryFault.
// The helper owns UUID sequencing; assertions below prove the intended durable
// phase and external patch state. File/dir blockers remain real filesystem faults.
//
// Doubles and fixtures live in tests/helpers/plugin-doubles.mjs (S3 dedup);
// host-module resolution order and the loud MiniStore-fallback warning are
// documented there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createManager } from '../plugin/server/manager.ts';
import {
  activateInput,
  armRecoveryFault,
  deactivateInput,
  dirBlocker,
  fileBlocker,
  makeBinaries,
  makeDaemon,
  makeDeps,
  makeLaunchers,
  makeMaterializer,
  makePayload,
  makePluginFixture,
  makeHome,
  opCodes,
  opOf,
  readConfigJson,
  readReceipt,
  receiptPath,
  reconcileInput,
  sha256,
  slpProvidersOf,
  statusInput,
  waitRecovery,
  waitTerminal,
} from './helpers/plugin-doubles.mjs';

// Tests begin below; all doubles/fixtures are imported from tests/helpers.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('crash before any plan (accepted phase) → foreign pending; inspect marks failed; new activate proceeds', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  dirBlocker(home); // every poisoned write fails EEXIST
  armRecoveryFault(deps, 'activate', 'materialized'); // 'materialized' write onward
  const managerA = createManager(deps);
  const opId = randomUUID();
  const start = await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  await waitRecovery(managerA, home, daemon);

  const stuck = opOf(home, opId);
  assert.equal(stuck.outcome, 'pending');
  assert.equal(stuck.phase, 'accepted');
  assert.equal(stuck.plan, null);
  assert.equal(daemon.patchCalls.length, 0);

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const status = await managerB.status(statusInput(home), daemon);
  assert.equal(status.state, 'RECOVERY_REQUIRED');

  const inspectId = randomUUID();
  const inspect = await managerB.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  assert.equal(inspect.accepted, true);
  assert.equal(inspect.state, 'RECOVERY_REQUIRED', 'the pending subject is marked at acceptance');
  await waitTerminal(managerB, home, inspectId, daemon);
  const after = readReceipt(home);
  assert.equal(after.operations.find(o => o.operationId === opId).outcome, 'failed');
  assert.equal(after.operations.find(o => o.operationId === inspectId).outcome, 'succeeded');
  assert.equal(after.state, 'INACTIVE');

  const act = await managerB.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const done = await waitTerminal(managerB, home, act.operation.operationId, daemon);
  assert.equal(done.state, 'ACTIVE');
});

test('crash at prepared (plan durable, patch never dispatched) → complete redispatches the forward patch exactly once', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  dirBlocker(home);
  armRecoveryFault(deps, 'activate', 'patch-dispatched'); // 'patch-dispatched' write onward
  const managerA = createManager(deps);
  const opId = randomUUID();
  const start = await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  await waitRecovery(managerA, home, daemon);

  const stuck = opOf(home, opId);
  assert.equal(stuck.phase, 'prepared');
  assert.equal(stuck.outcome, 'pending');
  assert.equal(stuck.patchAttempts.length, 0);
  assert.equal(daemon.patchCalls.length, 0, 'a failed journal write must prevent dispatch');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 0);

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const recId = randomUUID();
  const reconcile = await managerB.reconcile(reconcileInput(home, recId, 'complete', opId), daemon);
  assert.equal(reconcile.accepted, true);
  const done = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'ACTIVE');
  assert.equal(daemon.patchCalls.length, 1, 'exactly one redispatched patch');
  assert.equal(opOf(home, opId).outcome, 'succeeded');
  assert.equal(readReceipt(home).binding.candidateSha256, deps.payload.candidate.sha256);
});

test('patch applied then settle-write killed → foreign pending at patch-dispatched → complete finalizes with zero extra patches', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  dirBlocker(home);
  armRecoveryFault(deps, 'activate', 'settled'); // settle write onward
  const managerA = createManager(deps);
  const opId = randomUUID();
  const start = await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  await waitRecovery(managerA, home, daemon);

  const stuck = opOf(home, opId);
  assert.equal(stuck.phase, 'patch-dispatched');
  assert.equal(stuck.outcome, 'pending');
  assert.equal(stuck.patchAttempts.length, 1);
  assert.equal(stuck.patchAttempts[0].result, 'pending');
  assert.equal(daemon.patchCalls.length, 1);
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15, 'the patch was really applied');

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const status = await managerB.status(statusInput(home), daemon);
  assert.equal(status.state, 'RECOVERY_REQUIRED');
  const recId = randomUUID();
  const reconcile = await managerB.reconcile(reconcileInput(home, recId, 'complete', opId), daemon);
  assert.equal(reconcile.accepted, true);
  const done = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'ACTIVE');
  assert.equal(daemon.patchCalls.length, 1, 'no hidden second patch');
  assert.equal(opOf(home, opId).outcome, 'succeeded');
});

test('crash after verified (attempt returned, commit never wrote) → complete finalizes', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  dirBlocker(home);
  armRecoveryFault(deps, 'activate', 'committed'); // commit write
  const managerA = createManager(deps);
  const opId = randomUUID();
  const start = await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  await waitRecovery(managerA, home, daemon);

  const stuck = opOf(home, opId);
  assert.equal(stuck.phase, 'verified');
  assert.equal(stuck.outcome, 'pending');
  assert.equal(stuck.patchAttempts[0].result, 'returned');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15);

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const recId = randomUUID();
  const reconcile = await managerB.reconcile(reconcileInput(home, recId, 'complete', opId), daemon);
  const done = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'ACTIVE');
  assert.equal(daemon.patchCalls.length, 1);
});

test('restore-before on an applied activation → inverse patch once, providers removed, runtime retained', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  dirBlocker(home);
  armRecoveryFault(deps, 'activate', 'settled');
  const managerA = createManager(deps);
  const opId = randomUUID();
  await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15);

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const recId = randomUUID();
  const reconcile = await managerB.reconcile(reconcileInput(home, recId, 'restore-before', opId), daemon);
  assert.equal(reconcile.accepted, true);
  const done = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'INACTIVE');
  assert.equal(daemon.patchCalls.length, 2, 'original patch + exactly one inverse');
  const config = readConfigJson(home);
  assert.equal(Object.keys(slpProvidersOf(config)).length, 0);
  assert.equal(config.daemon.mcp.injectIntoAgents, false);
  assert.ok(existsSync(join(home, 'slp-runtime', deps.payload.candidate.sha256)), 'candidate dir retained');
  const finalReceipt = readReceipt(home);
  assert.equal(finalReceipt.retained.length, 1);
  assert.equal(finalReceipt.binding, null);
  assert.equal(finalReceipt.operations.find(o => o.operationId === opId).outcome, 'failed');
});

test('patch rejection (never applied) → outcome-unknown; no blind rollback; same-boot reconcile blocked; new-boot restore-before needs no patch', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home, { patchScript: ['reject'] });
  const deps = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(deps);
  const opId = randomUUID();
  const before = readFileSync(join(home, 'config.json'));
  const start = await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  const done = await waitTerminal(managerA, home, opId, daemon);
  assert.equal(done.operation.outcome, 'recovery-required');
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.ok(opCodes(home, opId).includes('PATCH_OUTCOME_UNKNOWN'));
  assert.equal(daemon.patchCalls.length, 1);
  // No blind timeout rollback: the config file is untouched.
  assert.deepEqual(readFileSync(join(home, 'config.json')), before);

  // Same boot: an outcome-unknown attempt blocks mutating reconcile.
  const early = await managerA.reconcile(reconcileInput(home, randomUUID(), 'complete', opId), daemon);
  assert.equal(early.accepted, false);
  assert.equal(early.conflicts[0].code, 'PATCH_OUTCOME_UNKNOWN');

  // New boot (post-quiesce): observed before-state → restore-before finalizes, no patch.
  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const recId = randomUUID();
  const reconcile = await managerB.reconcile(reconcileInput(home, recId, 'restore-before', opId), daemon);
  assert.equal(reconcile.accepted, true);
  const done2 = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done2.operation.outcome, 'succeeded');
  assert.equal(done2.state, 'INACTIVE');
  assert.equal(daemon.patchCalls.length, 1, 'restore-before on before-state must not patch');
  assert.equal(opOf(home, opId).outcome, 'failed');
});

test('journal write failure after a successful patch → op lands recovery-required; complete finishes it', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  fileBlocker(home); // single EEXIST — cleanup removes it
  armRecoveryFault(deps, 'activate', 'settled', { once: true }); // only the settle write fails
  const managerA = createManager(deps);
  const opId = randomUUID();
  const start = await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  const done = await waitTerminal(managerA, home, opId, daemon);
  assert.equal(done.operation.outcome, 'recovery-required');
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15, 'patch was applied');
  assert.ok(opCodes(home, opId).includes('PATCH_OUTCOME_UNKNOWN'), 'attempt stayed pending → outcome unknown');

  // Same-boot reconcile is blocked on the unknown attempt.
  const early = await managerA.reconcile(reconcileInput(home, randomUUID(), 'complete', opId), daemon);
  assert.equal(early.accepted, false);
  assert.equal(early.conflicts[0].code, 'PATCH_OUTCOME_UNKNOWN');

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const recId = randomUUID();
  const reconcile = await managerB.reconcile(reconcileInput(home, recId, 'complete', opId), daemon);
  assert.equal(reconcile.accepted, true);
  const done2 = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done2.operation.outcome, 'succeeded');
  assert.equal(done2.state, 'ACTIVE');
  assert.equal(daemon.patchCalls.length, 1);
});

test('single journal failure at materialized write → clean terminal failure, not stuck pending', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  fileBlocker(home);
  armRecoveryFault(deps, 'activate', 'materialized', { once: true }); // only the 'materialized' write fails
  const managerA = createManager(deps);
  const opId = randomUUID();
  await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  const done = await waitTerminal(managerA, home, opId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.equal(done.state, 'INACTIVE');
  assert.ok(opCodes(home, opId).includes('IO_FAILURE'));
  assert.equal(daemon.patchCalls.length, 0);
});

test('acceptance write failure → activate rejected IO_FAILURE, no receipt left', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  fileBlocker(home);
  armRecoveryFault(deps, 'activate', 'accepted', { once: true }); // the acceptance write itself
  const manager = createManager(deps);
  const out = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  assert.equal(out.accepted, false);
  assert.equal(out.conflicts[0].code, 'IO_FAILURE');
  assert.ok(!existsSync(receiptPath(home)));
  assert.equal(daemon.patchCalls.length, 0);
});

test('deactivate crash after its patch applied → restore-before reinstates the binding', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  const bindingSha = doneAct.binding.bindingSha256;

  dirBlocker(home);
  armRecoveryFault(deps, 'deactivate', 'settled'); // settle write onward
  const deact = await managerA.deactivate(deactivateInput(home, randomUUID(), bindingSha), daemon);
  const deactId = deact.operation.operationId;
  await waitRecovery(managerA, home, daemon);
  const stuck = opOf(home, deactId);
  assert.equal(stuck.phase, 'patch-dispatched');
  assert.equal(stuck.outcome, 'pending');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 0, 'deactivate patch applied');

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const status = await managerB.status(statusInput(home), daemon);
  assert.equal(status.state, 'RECOVERY_REQUIRED');
  const recId = randomUUID();
  const reconcile = await managerB.reconcile(reconcileInput(home, recId, 'restore-before', deactId), daemon);
  const done = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'ACTIVE', 'restore-before reinstates the binding');
  const config = readConfigJson(home);
  assert.equal(Object.keys(slpProvidersOf(config)).length, 15);
  assert.equal(config.daemon.mcp.injectIntoAgents, true);
  assert.equal(readReceipt(home).binding.bindingSha256, bindingSha);
});

test('deactivate crash after its patch applied → complete finishes the removal', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  const bindingSha = doneAct.binding.bindingSha256;

  dirBlocker(home);
  armRecoveryFault(deps, 'deactivate', 'settled');
  const deact = await managerA.deactivate(deactivateInput(home, randomUUID(), bindingSha), daemon);
  const deactId = deact.operation.operationId;
  await waitRecovery(managerA, home, daemon);

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const recId = randomUUID();
  const reconcile = await managerB.reconcile(reconcileInput(home, recId, 'complete', deactId), daemon);
  const done = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'INACTIVE');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 0);
  const receipt = readReceipt(home);
  assert.equal(receipt.lastDeactivatedBindingSha256, bindingSha);
  assert.equal(receipt.binding, null);
});

test('deactivate crash before dispatch (entries intact) → complete redispatches removal', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);

  dirBlocker(home);
  armRecoveryFault(deps, 'deactivate', 'patch-dispatched'); // the dispatch write
  const deact = await managerA.deactivate(deactivateInput(home, randomUUID(), doneAct.binding.bindingSha256), daemon);
  const deactId = deact.operation.operationId;
  await waitRecovery(managerA, home, daemon);
  const stuck = opOf(home, deactId);
  assert.equal(stuck.phase, 'prepared');
  assert.equal(stuck.patchAttempts.length, 0);
  assert.equal(daemon.patchCalls.length, 1, 'only the activate patch ran');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15, 'providers still present');

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const recId = randomUUID();
  const reconcile = await managerB.reconcile(reconcileInput(home, recId, 'complete', deactId), daemon);
  const done = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'INACTIVE');
  assert.equal(daemon.patchCalls.length, 2, 'one redispatched deactivate patch');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 0);
});

test('divergent disk/live state → reconcile refuses to patch and stays RECOVERY_REQUIRED', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  dirBlocker(home);
  armRecoveryFault(deps, 'activate', 'settled');
  const managerA = createManager(deps);
  const opId = randomUUID();
  await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15);

  // Live view diverges from disk: drop one owned provider from get() responses.
  const divergent = {
    patchCalls: daemon.patchCalls,
    config: {
      get: async id => {
        const out = await daemon.config.get(id);
        const copy = structuredClone(out.config);
        delete copy.providers['slp-codex-lead'];
        return { ...out, config: copy };
      },
      patch: daemon.config.patch,
    },
  };
  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const patchesBefore = daemon.patchCalls.length;
  const recId = randomUUID();
  const reconcile = await managerB.reconcile(reconcileInput(home, recId, 'complete', opId), divergent);
  assert.equal(reconcile.accepted, true);
  const done = await waitTerminal(managerB, home, recId, divergent);
  assert.equal(done.operation.outcome, 'failed');
  assert.equal(readReceipt(home).state, 'RECOVERY_REQUIRED');
  assert.equal(daemon.patchCalls.length, patchesBefore, 'divergent state must not be patched');
});

test('reconcile guards: missing interruptedOperationId → INVALID_REQUEST; unknown → NOT_FOUND; terminal op → INVALID_REQUEST', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const missing = await manager.reconcile(reconcileInput(home, randomUUID(), 'complete'), daemon);
  assert.equal(missing.accepted, false);
  assert.equal(missing.conflicts[0].code, 'INVALID_REQUEST');
  const unknown = await manager.reconcile(reconcileInput(home, randomUUID(), 'complete', randomUUID()), daemon);
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.conflicts[0].code, 'NOT_FOUND');

  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const done = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  const out = await manager.reconcile(reconcileInput(home, randomUUID(), 'complete', act.operation.operationId), daemon);
  assert.equal(out.accepted, false);
  assert.equal(out.conflicts[0].code, 'INVALID_REQUEST');
});

test('reconcile during an in-flight worker → BUSY', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  let gateResolve;
  const gate = new Promise(r => (gateResolve = r));
  const deps = makeDeps({ execOpts: { binaries }, materializerHooks: { beforeMaterialize: () => gate } });
  const manager = createManager(deps);
  const opId = randomUUID();
  await manager.activate(activateInput(home, deps.payload, opId), daemon);
  const reconcile = await manager.reconcile(reconcileInput(home, randomUUID(), 'inspect'), daemon);
  assert.equal(reconcile.accepted, false);
  assert.equal(reconcile.conflicts[0].code, 'BUSY');
  gateResolve();
  await waitTerminal(manager, home, opId, daemon);
});

test('reconcile retry with same id + payload returns the existing recovery operation', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  dirBlocker(home);
  armRecoveryFault(deps, 'activate', 'settled');
  const managerA = createManager(deps);
  const opId = randomUUID();
  await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  await waitRecovery(managerA, home, daemon);

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const recId = randomUUID();
  const input = reconcileInput(home, recId, 'complete', opId);
  const first = await managerB.reconcile(input, daemon);
  assert.equal(first.accepted, true);
  const second = await managerB.reconcile(input, daemon);
  assert.equal(second.accepted, true);
  assert.equal(second.operation.operationId, recId);
  const changed = await managerB.reconcile(reconcileInput(home, recId, 'restore-before', opId), daemon);
  assert.equal(changed.accepted, false);
  assert.equal(changed.conflicts[0].code, 'IDEMPOTENCY_CONFLICT');
  await waitTerminal(managerB, home, recId, daemon);
});

test('status distinguishes same-boot in-flight vs foreign pending; never writes', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home, { patchScript: ['hang'] });
  const deps = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(deps);
  const opId = randomUUID();
  const start = await managerA.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  // Wait until the patch attempt is journaled, then the worker parks forever.
  const deadline = Date.now() + 8000;
  for (;;) {
    const op = opOf(home, opId);
    if (op && op.phase === 'patch-dispatched') break;
    if (Date.now() > deadline) throw new Error('patch never dispatched');
    await new Promise(r => setTimeout(r, 10));
  }
  const bytes = readFileSync(receiptPath(home));
  const sameBoot = await managerA.status(statusInput(home), daemon);
  assert.equal(sameBoot.state, 'ACTIVATING', 'same-boot pending is in-flight, not recovery');
  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const foreign = await managerB.status(statusInput(home, opId), daemon);
  assert.equal(foreign.state, 'RECOVERY_REQUIRED', 'foreign pending requires recovery');
  assert.equal(foreign.operation?.operationId, opId);
  assert.deepEqual(readFileSync(receiptPath(home)), bytes, 'status must not mutate the receipt');
});

test('inspect on a healthy binding reports ACTIVE with no conflicts', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);
  const inspectId = randomUUID();
  const inspect = await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  assert.equal(inspect.accepted, true);
  assert.equal(inspect.state, 'ACTIVE');
  const done = await waitTerminal(manager, home, inspectId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.conflicts.length, 0);
  assert.equal(done.state, 'ACTIVE');
  // An identical retry replays the recorded reply — no second execution.
  const retry = await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  assert.equal(retry.accepted, true);
  assert.equal(retry.operation.operationId, inspectId);
  assert.equal(retry.operation.outcome, 'succeeded');
  assert.equal(daemon.patchCalls.length, 1, 'inspect must not patch');
});

test('inspect verifies a retained launch set sharing the active runtime path', async t => {
  // N9: rebinding the same candidate with a changed binary resolution
  // publishes a NEW launch set while the runtime path is unchanged. The old
  // set stays retained under that same runtimePath — the verify loop must
  // not skip it just because the path matches the active binding's.
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps1 = makeDeps({ execOpts: { binaries } });
  const manager1 = createManager(deps1);
  const act = await manager1.activate(activateInput(home, deps1.payload, randomUUID()), daemon);
  const done1 = await waitTerminal(manager1, home, act.operation.operationId, daemon);
  assert.equal(done1.state, 'ACTIVE');
  const oldSet = done1.binding.launchSetSha256;

  const deps2 = makeDeps({
    payload: deps1.payload,
    execOpts: { binaries, versions: { codex: '2.0.0-test' } },
  });
  const manager2 = createManager(deps2);
  const act2 = await manager2.activate(activateInput(home, deps2.payload, randomUUID()), daemon);
  const done2 = await waitTerminal(manager2, home, act2.operation.operationId, daemon);
  assert.equal(done2.state, 'ACTIVE');
  assert.equal(done2.binding.candidateSha256, done1.binding.candidateSha256, 'same candidate');
  assert.notEqual(done2.binding.launchSetSha256, oldSet, 'changed resolution → new launch set');
  const receipt = readReceipt(home);
  const sharing = receipt.retained.filter(e => e.runtimePath === receipt.binding.runtimePath);
  assert.ok(
    sharing.some(e => e.launchSetSha256 === oldSet),
    'the old launch set is retained under the shared runtimePath',
  );

  // Delete one launcher of the retained (inactive) set: inspect must report
  // RUNTIME_INTEGRITY, not ACTIVE with no conflicts.
  rmSync(join(home, 'slp-runtime', 'launchers', oldSet, 'slp-devin-lead'));
  const inspectId = randomUUID();
  const inspect = await manager2.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  assert.equal(inspect.accepted, true);
  const done = await waitTerminal(manager2, home, inspectId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.ok(
    opCodes(home, inspectId).includes('RUNTIME_INTEGRITY'),
    `expected RUNTIME_INTEGRITY, got ${JSON.stringify(opCodes(home, inspectId))}`,
  );
  assert.equal(done.state, 'RECOVERY_REQUIRED');
});

// ---------------------------------------------------------------------------
// Round-3 findings: recovery chains, journaled inspect, binding invariants
// ---------------------------------------------------------------------------

test('reconcile-of-reconcile: a dead complete-of-activate still finalizes the activation endpoint', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const depsA = makeDeps({ execOpts: { binaries } });
  dirBlocker(home);
  armRecoveryFault(depsA, 'activate', 'settled'); // settle write onward — patch applied, op stuck pending
  const managerA = createManager(depsA);
  const opId = randomUUID();
  await managerA.activate(activateInput(home, depsA.payload, opId), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.ok(Object.keys(slpProvidersOf(readConfigJson(home))).length > 0, 'activation patch applied');

  // R1(complete) is journaled, then dies before its finalizing write.
  const depsB = makeDeps({ payload: depsA.payload, execOpts: { binaries } });
  armRecoveryFault(depsB, 'complete-after', 'finalized');
  const managerB = createManager(depsB);
  const r1 = randomUUID();
  const first = await managerB.reconcile(reconcileInput(home, r1, 'complete', opId), daemon);
  assert.equal(first.accepted, true);
  await waitRecovery(managerB, home, daemon);
  assert.equal(opOf(home, r1).outcome, 'pending');
  assert.equal(opOf(home, r1).kind, 'reconcile');

  // R2 completes R1: the chain was driving the activation's forward endpoint —
  // config already holds providers/profiles, so the receipt must bind ACTIVE.
  const managerC = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const r2 = randomUUID();
  const second = await managerC.reconcile(reconcileInput(home, r2, 'complete', r1), daemon);
  assert.equal(second.accepted, true);
  const done = await waitTerminal(managerC, home, r2, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  const receipt = readReceipt(home);
  assert.equal(receipt.state, 'ACTIVE');
  assert.ok(receipt.binding, 'the activation endpoint must bind, not report INACTIVE');
  assert.equal(receipt.binding.candidateSha256, depsA.payload.candidate.sha256);
  assert.equal(receipt.operations.find(o => o.operationId === opId).outcome, 'succeeded');
  assert.equal(receipt.operations.find(o => o.operationId === r1).outcome, 'succeeded');
  assert.equal(daemon.patchCalls.length, 1, 'no extra patches — observed state was already after');
});

test('reconcile-of-reconcile: a dead restore-before still drives the chain to the before endpoint', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  const act = await managerA.activate(activateInput(home, depsA.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);

  // Deactivate applies its removal patch, then dies before settling.
  dirBlocker(home);
  armRecoveryFault(depsA, 'deactivate', 'settled');
  const deactId = randomUUID();
  await managerA.deactivate(deactivateInput(home, deactId, doneAct.binding.bindingSha256), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 0, 'removal patch applied');

  // R1(restore-before) is journaled, then dies before its inverse dispatch.
  const depsB = makeDeps({ payload: depsA.payload, execOpts: { binaries } });
  armRecoveryFault(depsB, 'restore-before', 'patch-dispatched');
  const managerB = createManager(depsB);
  const r1 = randomUUID();
  await managerB.reconcile(reconcileInput(home, r1, 'restore-before', deactId), daemon);
  await waitRecovery(managerB, home, daemon);
  assert.equal(opOf(home, r1).outcome, 'pending');

  // R2(complete) on R1: R1 was driving toward the before endpoint, so the
  // chain direction is `before` — observed after-state must be inversed.
  const managerC = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const r2 = randomUUID();
  await managerC.reconcile(reconcileInput(home, r2, 'complete', r1), daemon);
  const done = await waitTerminal(managerC, home, r2, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  const receipt = readReceipt(home);
  assert.equal(receipt.state, 'ACTIVE', 'the restore-before chain must reinstate the binding');
  assert.ok(receipt.binding);
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15, 'inverse patch restored providers');
  assert.equal(receipt.operations.find(o => o.operationId === deactId).outcome, 'failed');
  assert.equal(receipt.operations.find(o => o.operationId === r1).outcome, 'succeeded');
});

test('journaled inspect: status resolves the op and a conflicting retry is refused', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const inspectId = randomUUID();
  const inspect = await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  assert.equal(inspect.accepted, true);
  const done = await waitTerminal(manager, home, inspectId, daemon);
  assert.equal(done.operation.operationId, inspectId, 'status(inspectId) resolves the journaled op');
  assert.equal(done.operation.kind, 'reconcile');
  // Same opId with a different payload is an idempotency conflict.
  const clash = await manager.reconcile(reconcileInput(home, inspectId, 'inspect', randomUUID()), daemon);
  assert.equal(clash.accepted, false);
  assert.equal(clash.conflicts[0].code, 'IDEMPOTENCY_CONFLICT');
});

test('inspect detects injectIntoAgents drift and transitions to RECOVERY_REQUIRED', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);

  // Flip the flag on BOTH raw and live — raw≡live agreement is preserved, so
  // only the binding's recorded ownership can expose the drift.
  await daemon.config.patch({ mcp: { injectIntoAgents: false } });
  const inspectId = randomUUID();
  const inspect = await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  assert.equal(inspect.accepted, true);
  const done = await waitTerminal(manager, home, inspectId, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  const codes = opOf(home, inspectId).conflicts.map(c => c.code);
  assert.ok(codes.includes('OWNERSHIP_DRIFT'), `expected OWNERSHIP_DRIFT, got ${codes}`);
  assert.equal(readReceipt(home).state, 'RECOVERY_REQUIRED');
});

test('inspect transitions runtime/launch integrity failures to RECOVERY_REQUIRED', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);

  // Corrupt the bound runtime payload — the inspect must not report ACTIVE.
  const binding = readReceipt(home).binding;
  rmSync(join(binding.runtimePath, 'bin', 'slp-shim.mjs'));
  const inspectId = randomUUID();
  await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(manager, home, inspectId, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  const codes = opOf(home, inspectId).conflicts.map(c => c.code);
  assert.ok(codes.includes('RUNTIME_INTEGRITY'), `expected RUNTIME_INTEGRITY, got ${codes}`);
});

test('inspect rejects a bound launch-set dir replaced by a symlink to another set', async t => {
  // X2: activate A → rebind B → swap B's launch-set dir for a symlink to A's.
  // Inspect must report RUNTIME_INTEGRITY — never verify A's bytes as B.
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  const act = await managerA.activate(activateInput(home, depsA.payload, randomUUID()), daemon);
  const doneA = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  assert.equal(doneA.state, 'ACTIVE');
  const setA = doneA.binding.launchSetSha256;

  const payloadB = makePayload({ 'bin/slp-shim.mjs': '#!/usr/bin/env node\n// v2\n' });
  const depsB = makeDeps({ payload: payloadB, execOpts: { binaries } });
  const managerB = createManager(depsB);
  const act2 = await managerB.activate(activateInput(home, payloadB, randomUUID()), daemon);
  const doneB = await waitTerminal(managerB, home, act2.operation.operationId, daemon);
  assert.equal(doneB.state, 'ACTIVE');
  const setB = doneB.binding.launchSetSha256;
  assert.notEqual(setB, setA);

  const setDirB = join(home, 'slp-runtime', 'launchers', setB);
  rmSync(setDirB, { recursive: true });
  symlinkSync(join(home, 'slp-runtime', 'launchers', setA), setDirB);

  const inspectId = randomUUID();
  await managerB.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(managerB, home, inspectId, daemon);
  const codes = opOf(home, inspectId).conflicts.map(c => c.code);
  assert.ok(codes.includes('RUNTIME_INTEGRITY'), `expected RUNTIME_INTEGRITY, got ${codes}`);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
});

test('inspect treats a verify identity mismatch against the receipt as RUNTIME_INTEGRITY', async t => {
  // X2 call-site half: even when verify() returns successfully, an identity
  // that differs from the receipt's recorded launchSetSha256 is a conflict —
  // the call site must compare, not ignore the returned digest.
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const inner = makeLaunchers();
  const aliased = {
    publish: req => inner.publish(req),
    verify: async dir => ({ ...(await inner.verify(dir)), launchSetSha256: 'f'.repeat(64) }),
  };
  const deps = makeDeps({ execOpts: { binaries }, launchers: aliased });
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');

  const inspectId = randomUUID();
  await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(manager, home, inspectId, daemon);
  const codes = opOf(home, inspectId).conflicts.map(c => c.code);
  assert.ok(codes.includes('RUNTIME_INTEGRITY'), `expected RUNTIME_INTEGRITY, got ${codes}`);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
});

test('inspect refuses a binding whose recorded executable no longer probes clean', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);

  // Delete one recorded family binary — the recorded-path probe must fail.
  rmSync(binaries.codex);
  const inspectId = randomUUID();
  await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(manager, home, inspectId, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  const codes = opOf(home, inspectId).conflicts.map(c => c.code);
  assert.ok(codes.includes('EXECUTABLE_UNAVAILABLE'), `expected EXECUTABLE_UNAVAILABLE, got ${codes}`);
});

test('receipt with a mutating phase but no plan is corrupt at journal read', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);

  const receipt = readReceipt(home);
  receipt.operations[0].phase = 'prepared';
  receipt.operations[0].plan = null;
  writeFileSync(receiptPath(home), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  const status = await manager.status(statusInput(home), daemon);
  assert.equal(status.state, 'RECOVERY_REQUIRED');
  assert.deepEqual(readFileSync(receiptPath(home)), Buffer.from(JSON.stringify(receipt, null, 2) + '\n'), 'corrupt receipt preserved');
  // ...also: a terminal+succeeded op without a plan is equally corrupt.
  receipt.operations[0].phase = 'terminal';
  writeFileSync(receiptPath(home), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  const status2 = await manager.status(statusInput(home), daemon);
  assert.equal(status2.state, 'RECOVERY_REQUIRED');
});

test('reconcile throwing pre-dispatch keeps RECOVERY_REQUIRED — never restores ACTIVE', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);

  // Deactivate dies after its patch applied: pending patch-dispatched op,
  // binding still recorded, providers already gone.
  dirBlocker(home);
  armRecoveryFault(deps, 'deactivate', 'settled');
  const deact = await managerA.deactivate(deactivateInput(home, randomUUID(), doneAct.binding.bindingSha256), daemon);
  const deactId = deact.operation.operationId;
  await waitRecovery(managerA, home, daemon);
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 0, 'deactivate patch applied');

  // The previous binding's runtime no longer verifies — restore-before must
  // throw in its pre-dispatch verify branch.
  rmSync(readReceipt(home).binding.runtimePath, { recursive: true, force: true });

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const recId = randomUUID();
  await managerB.reconcile(reconcileInput(home, recId, 'restore-before', deactId), daemon);
  const done = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.equal(done.state, 'RECOVERY_REQUIRED', 'a failed recovery must not mask the pending evidence');
  const receipt = readReceipt(home);
  assert.equal(receipt.state, 'RECOVERY_REQUIRED');
  assert.ok(receipt.binding, 'binding untouched by the failed recovery');
  assert.equal(opOf(home, deactId).outcome, 'recovery-required');
  assert.ok(opCodes(home, recId).includes('RUNTIME_INTEGRITY'), `expected RUNTIME_INTEGRITY, got ${opCodes(home, recId)}`);
});

test('inspect with a recovery subject that throws unexpectedly keeps RECOVERY_REQUIRED', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  dirBlocker(home);
  armRecoveryFault(deps, 'activate', 'settled'); // settle write onward — patch applied, op stuck pending
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const actId = act.operation.operationId;
  await waitRecovery(managerA, home, daemon);
  assert.equal(opOf(home, actId).phase, 'patch-dispatched');

  // The daemon's live view is unreachable — classification throws.
  const deadDaemon = {
    ...daemon,
    config: {
      get: async () => { throw new Error('daemon unreachable'); },
      patch: (...args) => daemon.config.patch(...args),
    },
  };
  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const inspectId = randomUUID();
  await managerB.reconcile(reconcileInput(home, inspectId, 'inspect'), deadDaemon);
  const done = await waitTerminal(managerB, home, inspectId, deadDaemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.equal(done.state, 'RECOVERY_REQUIRED', 'binding is absent here — priorState would have said INACTIVE');
  assert.equal(readReceipt(home).state, 'RECOVERY_REQUIRED');
  assert.equal(opOf(home, actId).outcome, 'recovery-required');
});

test('deactivate failing before its plan journals restores ACTIVE priorState', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);

  fileBlocker(home);
  armRecoveryFault(deps, 'deactivate', 'prepared', { once: true }); // the 'prepared' write only
  const deact = await manager.deactivate(deactivateInput(home, randomUUID(), doneAct.binding.bindingSha256), daemon);
  const done = await waitTerminal(manager, home, deact.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.equal(done.state, 'ACTIVE', 'pre-dispatch failure restores the recorded pre-op state');
  assert.ok(readReceipt(home).binding, 'binding still recorded');
  assert.equal(daemon.patchCalls.length, 1, 'only the activate patch ran');
});

test('journaled reconcile intent lacking priorState (legacy) falls back to RECOVERY_REQUIRED', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  dirBlocker(home);
  armRecoveryFault(deps, 'activate', 'settled');
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const actId = act.operation.operationId;
  await waitRecovery(managerA, home, daemon);

  // Simulate a pre-field journal: strip priorState from every operation the
  // moment the reconcile's verify runs, then fail it.
  const base = makeMaterializer(deps.payload);
  const depsB = makeDeps({
    payload: deps.payload,
    execOpts: { binaries },
    materializer: {
      ...base,
      async verifyPublished(runtimePath, candidateSha256) {
        const receipt = JSON.parse(readFileSync(receiptPath(home), 'utf8'));
        for (const op of receipt.operations) delete op.priorState;
        writeFileSync(receiptPath(home), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
        return base.verifyPublished(runtimePath, candidateSha256);
      },
    },
  });
  // Break the recorded runtime so verifyPublished throws after the strip.
  rmSync(join(home, 'slp-runtime', deps.payload.candidate.sha256, 'installed.json'), { force: true });

  const managerB = createManager(depsB);
  const recId = randomUUID();
  await managerB.reconcile(reconcileInput(home, recId, 'complete', actId), daemon);
  const done = await waitTerminal(managerB, home, recId, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  const journaled = opOf(home, recId);
  assert.ok(!('priorState' in journaled) || journaled.priorState === undefined, 'legacy op carried no priorState field');
});

// ---------------------------------------------------------------------------
// Round 4 — systematic state-machine hardening
// ---------------------------------------------------------------------------

test('inspect treats mcp.enabled=false as binding drift, not a clean ACTIVE', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);

  // Flip the binding precondition on BOTH sides: raw file + fresh daemon's
  // live view (MiniStore rereads the file at construction).
  const config = readConfigJson(home);
  config.daemon.mcp.enabled = false;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const deadDaemon = await makeDaemon(t, home);

  const inspectId = randomUUID();
  await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), deadDaemon);
  const done = await waitTerminal(manager, home, inspectId, deadDaemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  const codes = opOf(home, inspectId).conflicts.map(c => c.code);
  assert.ok(codes.includes('OWNERSHIP_DRIFT'), `expected OWNERSHIP_DRIFT, got ${codes}`);
});

test('inspect transitions to RECOVERY_REQUIRED when the persisted file fails schema validation', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);

  const config = readConfigJson(home);
  config.unrelatedJunk = { nested: true };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

  const inspectId = randomUUID();
  await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(manager, home, inspectId, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED', 'schema loss is recovery evidence, not a clean report');
  const codes = opOf(home, inspectId).conflicts.map(c => c.code);
  assert.ok(codes.includes('SCHEMA_LOSS'), `expected SCHEMA_LOSS, got ${codes}`);
});

test('an interrupted inspect restores its own priorState — never erases recovery evidence', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(managerA, home, act.operation.operationId, daemon);

  // A rebind dies at its materialized write: pending pre-plan op, healthy
  // binding still recorded.
  dirBlocker(home);
  armRecoveryFault(deps, 'activate', 'materialized'); // 'materialized' write onward
  const rebind = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const rebindId = rebind.operation.operationId;
  await waitRecovery(managerA, home, daemon);

  // First inspect: marks the rebind op recovery-required at acceptance, then
  // dies before its own terminal journal — the receipt keeps RECOVERY_REQUIRED
  // + pending inspect + recovery-required rebind.
  const depsB = makeDeps({ payload: deps.payload, execOpts: { binaries } });
  dirBlocker(home);
  armRecoveryFault(depsB, 'inspect', 'subject-marked'); // interrupted-op mark + inspect settle writes
  const managerB = createManager(depsB);
  const inspect1 = randomUUID();
  await managerB.reconcile(reconcileInput(home, inspect1, 'inspect'), daemon);
  await waitRecovery(managerB, home, daemon);
  assert.equal(opOf(home, inspect1).outcome, 'pending');
  assert.equal(opOf(home, rebindId).outcome, 'recovery-required');

  // New boot: the second inspect adopts the dead inspect op as subject. Its
  // no-plan branch must restore the inspect's recorded priorState
  // (RECOVERY_REQUIRED), not a binding-derived ACTIVE.
  const managerC = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const inspect2 = randomUUID();
  await managerC.reconcile(reconcileInput(home, inspect2, 'inspect'), daemon);
  const done = await waitTerminal(managerC, home, inspect2, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.equal(readReceipt(home).state, 'RECOVERY_REQUIRED');
  assert.equal(opOf(home, inspect1).outcome, 'failed');
  assert.equal(opOf(home, rebindId).outcome, 'recovery-required');
});

test('inspect-created RECOVERY_REQUIRED over unmanaged entries still permits explicit adoption', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(managerA, home, act.operation.operationId, daemon);

  // Receipt vanishes; entries remain — §8.4 pending-adoption state.
  rmSync(receiptPath(home), { force: true });
  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const inspectId = randomUUID();
  await managerB.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const doneInspect = await waitTerminal(managerB, home, inspectId, daemon);
  assert.equal(doneInspect.state, 'RECOVERY_REQUIRED');

  const adopt = await managerB.activate(
    activateInput(home, deps.payload, randomUUID(), { adoptIdentical: true }),
    daemon,
  );
  assert.equal(adopt.accepted, true, `adoption refused: ${adopt.conflicts.map(c => c.code)}`);
  const done = await waitTerminal(managerB, home, adopt.operation.operationId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'ACTIVE');
  assert.equal(readReceipt(home).binding.baseline, 'adopted-observed');
});

test('a clean re-inspect clears a state-level recovery once the drift is fixed', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);

  await daemon.config.patch({ mcp: { injectIntoAgents: false } });
  const badInspect = randomUUID();
  await manager.reconcile(reconcileInput(home, badInspect, 'inspect'), daemon);
  const doneBad = await waitTerminal(manager, home, badInspect, daemon);
  assert.equal(doneBad.state, 'RECOVERY_REQUIRED');

  // Administrator repairs the drift outside the plugin; the next inspect
  // verifies the binding clean and restores the verified state.
  await daemon.config.patch({ mcp: { injectIntoAgents: true } });
  const goodInspect = randomUUID();
  await manager.reconcile(reconcileInput(home, goodInspect, 'inspect'), daemon);
  const done = await waitTerminal(manager, home, goodInspect, daemon);
  assert.equal(done.state, 'ACTIVE', 'clean inspect resolves the pending recovery');
  assert.equal(readReceipt(home).state, 'ACTIVE');
});

test('equal plan endpoints (identical-config adoption) finalize without a redundant patch', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(managerA, home, act.operation.operationId, daemon);

  // Receipt removed; the identical entries remain → an adoptIdentical plan
  // has before == after. Interrupt it at the 'verified' write (post-prepared).
  rmSync(receiptPath(home), { force: true });
  const depsB = makeDeps({ payload: deps.payload, execOpts: { binaries } });
  dirBlocker(home);
  armRecoveryFault(depsB, 'adopt-identical', 'verified'); // 'verified' write onward — plan journaled, no patch
  const managerB = createManager(depsB);
  const adopt = await managerB.activate(
    activateInput(home, deps.payload, randomUUID(), { adoptIdentical: true }),
    daemon,
  );
  const adoptId = adopt.operation.operationId;
  await waitRecovery(managerB, home, daemon);
  const stuck = opOf(home, adoptId);
  assert.equal(stuck.outcome, 'pending');
  assert.ok(stuck.plan, 'plan journaled');
  assert.equal(daemon.patchCalls.length, 1, 'adoption skipped its no-change patch');

  const managerC = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const recId = randomUUID();
  await managerC.reconcile(reconcileInput(home, recId, 'complete', adoptId), daemon);
  const done = await waitTerminal(managerC, home, recId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'ACTIVE');
  assert.equal(daemon.patchCalls.length, 1, 'no redundant patch dispatched');
  assert.ok(readReceipt(home).binding, 'binding finalized');
});

test('inspect refreshes owned profile positions so a later deactivate is not drifted', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  const bindingSha = doneAct.binding.bindingSha256;

  // An unrelated profile lands at the head: owned values stay valid but
  // their positions shift.
  const profiles = readConfigJson(home).daemon.agentProfiles;
  const human = { id: 'human-x', name: 'Human X', provider: 'other-provider', notes: '' };
  await daemon.config.patch({ agentProfiles: [human, ...profiles] });

  const inspectId = randomUUID();
  await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(manager, home, inspectId, daemon);
  assert.equal(done.state, 'ACTIVE');
  const refreshed = readReceipt(home).binding.owned.profiles;
  assert.deepEqual(refreshed.map(s => s.index), [1, 2], 'positions refreshed into the binding');

  const deact = await manager.deactivate(deactivateInput(home, randomUUID(), readReceipt(home).binding.bindingSha256), daemon);
  const doneDeact = await waitTerminal(manager, home, deact.operation.operationId, daemon);
  assert.equal(doneDeact.operation.outcome, 'succeeded');
  assert.equal(doneDeact.state, 'INACTIVE');
});

test('status(operationId) exposes the operation’s journaled conflicts', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);

  await daemon.config.patch({ mcp: { injectIntoAgents: false } });
  const inspectId = randomUUID();
  await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  await waitTerminal(manager, home, inspectId, daemon);

  const status = await manager.status(statusInput(home, inspectId), daemon);
  assert.equal(status.operation.operationId, inspectId);
  const codes = status.conflicts.map(c => c.code);
  assert.ok(codes.includes('OWNERSHIP_DRIFT'), `expected OWNERSHIP_DRIFT in status conflicts, got ${codes}`);
});

test('status response stays inside the 64 KiB RPC bound even with oversized family fields', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const huge = 'v'.repeat(96 * 1024);
  const deps = makeDeps({ execOpts: { binaries, versions: { codex: huge, pi: huge, devin: huge, claude: huge } } });
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(manager, home, act.operation.operationId, daemon);

  const status = await manager.status(statusInput(home), daemon);
  const bytes = Buffer.byteLength(JSON.stringify(status));
  assert.ok(bytes <= 64 * 1024, `status response ${bytes}B exceeds the RPC bound`);
  for (const family of status.families) {
    assert.ok((family.observedVersion?.length ?? 0) <= 600, `${family.family} version not capped`);
  }
});

// ---------------------------------------------------------------------------
// Round-5 systematic-hardening regressions (R1–R10 + contract arity)
// ---------------------------------------------------------------------------

test('an unresolved same-boot attempt anywhere in the chain blocks mutations on its root', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  // Patch 1 (activate): applies, then the response is lost — outcome-unknown,
  // disk sits on the after endpoint. Patch 2 (the restore-before inverse):
  // rejected before applying — outcome-unknown, disk stays after.
  const daemon = await makeDaemon(t, home, { patchScript: ['apply-then-reject', 'reject'] });
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  const opId = randomUUID();
  await managerA.activate(activateInput(home, depsA.payload, opId), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.ok(Object.keys(slpProvidersOf(readConfigJson(home))).length > 0, 'activation patch applied');

  // Boot B: restore-before on the activation — the foreign attempt is not a
  // live race, so admission passes and the worker dispatches the inverse.
  // That inverse lands outcome-unknown on THIS boot.
  const managerB = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const r1 = randomUUID();
  const first = await managerB.reconcile(reconcileInput(home, r1, 'restore-before', opId), daemon);
  assert.equal(first.accepted, true);
  await waitTerminal(managerB, home, r1, daemon);
  assert.equal(opOf(home, r1).outcome, 'recovery-required');
  assert.equal(daemon.patchCalls.length, 2);

  // complete on r1 stays blocked (same-boot attempt on the requested op)…
  const blockedSelf = await managerB.reconcile(reconcileInput(home, randomUUID(), 'complete', r1), daemon);
  assert.equal(blockedSelf.accepted, false);
  assert.equal(blockedSelf.conflicts[0].code, 'PATCH_OUTCOME_UNKNOWN');
  // …and a mutation against the ROOT must be refused too — the chain still
  // holds r1's unresolved same-boot attempt, so a second inverse would race
  // the first. The old gate only inspected the requested op and let this
  // through to a second patch.
  const blockedRoot = await managerB.reconcile(reconcileInput(home, randomUUID(), 'restore-before', opId), daemon);
  assert.equal(blockedRoot.accepted, false);
  assert.equal(blockedRoot.conflicts[0].code, 'PATCH_OUTCOME_UNKNOWN');
  assert.equal(daemon.patchCalls.length, 2, 'no racing second inverse may dispatch');
});

test('interrupted pre-plan op with a binding: inspect still enforces the mcp.enabled invariant', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home, { forceMini: true });
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  const act = await managerA.activate(activateInput(home, depsA.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');

  // The deactivate dies before its 'prepared' write — pending, no plan. The
  // dir blocker fails every poisoned write (the file blocker fails only the
  // first), so the recordFailure write dies too and the op stays pending.
  armRecoveryFault(depsA, 'deactivate', 'prepared');
  dirBlocker(home);
  const deactId = randomUUID();
  await managerA.deactivate(deactivateInput(home, deactId, doneAct.binding.bindingSha256), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.equal(opOf(home, deactId).outcome, 'pending');
  assert.equal(opOf(home, deactId).plan, null);

  // mcp.enabled flips false on BOTH sides — raw and live still agree, but
  // the binding's recorded precondition no longer holds.
  const config = readConfigJson(home);
  config.daemon.mcp.enabled = false;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  daemon.__store.current.mcp.enabled = false;

  const managerB = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const inspectId = randomUUID();
  await managerB.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(managerB, home, inspectId, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.ok(opCodes(home, inspectId).includes('OWNERSHIP_DRIFT'), `expected drift finding, got ${opCodes(home, inspectId)}`);
  assert.equal(
    opOf(home, deactId).outcome,
    'recovery-required',
    'the broken endpoint must keep the subject unresolved — not restore a state recorded before the violation',
  );
});

test('a recovery-required planless root stays resolvable: a later inspect selects and settles it', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);

  // Activation dies pre-plan (its 'materialized' write is poisoned).
  const depsA = makeDeps({ execOpts: { binaries } });
  armRecoveryFault(depsA, 'activate', 'materialized');
  dirBlocker(home);
  const managerA = createManager(depsA);
  const opId = randomUUID();
  await managerA.activate(activateInput(home, depsA.payload, opId), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.equal(opOf(home, opId).outcome, 'pending');

  // Boot B's inspect marks the activation recovery-required, then dies
  // before its terminal write — leaving the root recovery-required AND
  // planless: unreachable for complete/restore-before, invisible to the old
  // pending-only subject selection.
  const depsB = makeDeps({ payload: depsA.payload, execOpts: { binaries } });
  armRecoveryFault(depsB, 'inspect', 'subject-marked');
  const managerB = createManager(depsB);
  const i1 = randomUUID();
  await managerB.reconcile(reconcileInput(home, i1, 'inspect'), daemon);
  await waitRecovery(managerB, home, daemon);
  assert.equal(opOf(home, opId).outcome, 'recovery-required');
  assert.equal(opOf(home, i1).outcome, 'pending');

  // Boot C inspect #1 settles the dead inspect (pending subject)…
  const managerC = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const i2 = randomUUID();
  await managerC.reconcile(reconcileInput(home, i2, 'inspect'), daemon);
  await waitTerminal(managerC, home, i2, daemon);
  assert.equal(opOf(home, i1).outcome, 'failed');
  assert.equal(readReceipt(home).state, 'RECOVERY_REQUIRED', 'the planless root is still unresolved evidence');

  // …inspect #2 must select the planless root itself and resolve it —
  // otherwise RECOVERY_REQUIRED would block activation forever with no
  // reachable recovery path (complete on a planless op is INVALID_REQUEST).
  const i3 = randomUUID();
  await managerC.reconcile(reconcileInput(home, i3, 'inspect'), daemon);
  const done = await waitTerminal(managerC, home, i3, daemon);
  assert.equal(done.state, 'INACTIVE');
  assert.equal(opOf(home, opId).outcome, 'failed');

  // The deadlock is gone: a fresh activation proceeds.
  const managerD = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const act = await managerD.activate(activateInput(home, depsA.payload, randomUUID()), daemon);
  assert.equal(act.accepted, true);
  const doneAct = await waitTerminal(managerD, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');
});

test('recovery removal refuses when live metadataGeneration references owned providers', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home, { forceMini: true });
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  const act = await managerA.activate(activateInput(home, depsA.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');

  // The deactivate dies after 'prepared': plan journaled, no patch
  // dispatched (dir blocker — every poisoned write fails, including the
  // recordFailure write, so the op stays pending).
  armRecoveryFault(depsA, 'deactivate', 'request-id');
  dirBlocker(home);
  const deactId = randomUUID();
  await managerA.deactivate(deactivateInput(home, deactId, doneAct.binding.bindingSha256), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.equal(opOf(home, deactId).outcome, 'pending');
  assert.ok(opOf(home, deactId).plan !== null);

  // A live override now references an owned provider while raw config has no
  // metadataGeneration entries — the removal patch would silently empty the
  // live list via the host's implicit filtering.
  daemon.__store.current.metadataGeneration.providers = [
    { provider: 'slp-codex-lead', prompt: 'unapproved live reference' },
  ];

  const managerB = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const rec = randomUUID();
  await managerB.reconcile(reconcileInput(home, rec, 'complete', deactId), daemon);
  const done = await waitTerminal(managerB, home, rec, daemon);
  assert.equal(done.operation.outcome, 'failed');
  assert.ok(opCodes(home, rec).includes('RAW_LIVE_DIVERGENCE'), `expected RAW_LIVE_DIVERGENCE, got ${opCodes(home, rec)}`);
  assert.equal(daemon.patchCalls.length, 1, 'no removal patch may dispatch against live-only references');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15, 'providers untouched');
});

test('inspect publishes the profile refresh only after every invariant passes', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');
  const before = readReceipt(home).binding;

  // A valid human edit to an owned profile (still targets an available
  // same-role provider) PLUS a broken runtime: the refresh must NOT publish
  // — the integrity check fails after it would have landed.
  const config = readConfigJson(home);
  const ownedProfile = config.daemon.agentProfiles.find(p => p.id === 'slp-supervisor');
  ownedProfile.description = 'human edit outside the journal';
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  rmSync(join(home, 'slp-runtime', before.candidateSha256, 'bin', 'slp-shim.mjs'));

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const inspectId = randomUUID();
  await managerB.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(managerB, home, inspectId, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.ok(opCodes(home, inspectId).includes('RUNTIME_INTEGRITY'));

  const after = readReceipt(home).binding;
  assert.equal(after.bindingSha256, before.bindingSha256, 'a failed inspect must keep the last trustworthy binding');
  assert.equal(after.verifiedAt, before.verifiedAt, 'verifiedAt must not advance on a failed inspect');
  assert.equal(after.owned.profiles.find(s => s.value.id === 'slp-supervisor').value.description ?? null, null);
});

test('journal validation rejects tampered derived hashes even when the format is valid', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(managerA, home, act.operation.operationId, daemon);

  // Format-valid but wrong digests: the schema's Sha pattern passes, only
  // recomputing the derived hashes exposes the tampering.
  const receipt = readReceipt(home);
  receipt.binding.bindingSha256 = 'a'.repeat(64);
  receipt.binding.postPatchPersistedShapeSha256 = 'b'.repeat(64);
  const tampered = JSON.stringify(receipt, null, 2) + '\n';
  writeFileSync(receiptPath(home), tampered, { mode: 0o600 });

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const status = await managerB.status(statusInput(home), daemon);
  assert.equal(status.state, 'RECOVERY_REQUIRED');
  assert.ok(
    status.conflicts.some(c => c.code === 'RECOVERY_REQUIRED' && /invariants/.test(c.message)),
    `expected a cross-field-invariant conflict, got ${status.conflicts.map(c => `${c.code}:${c.message.slice(0, 60)}`)}`,
  );
  // The tampered receipt is preserved, never overwritten.
  assert.equal(readFileSync(receiptPath(home), 'utf8'), tampered);
});

test('a symlinked state ancestor is rejected even when the receipt exists', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  await waitTerminal(managerA, home, act.operation.operationId, daemon);

  const stateDir = join(home, 'slp-runtime', 'state');
  renameSync(stateDir, `${stateDir}-real`);
  symlinkSync(`${stateDir}-real`, stateDir);

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const status = await managerB.status(statusInput(home), daemon);
  assert.equal(status.state, 'RECOVERY_REQUIRED');
  assert.ok(status.conflicts.some(c => c.code === 'RECOVERY_REQUIRED'));
});

test('status response stays inside the bound under maximum schema-valid load', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const huge = 'v'.repeat(96 * 1024);
  const deps = makeDeps({ execOpts: { binaries, versions: { codex: huge, pi: huge, devin: huge, claude: huge } } });
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const opId = act.operation.operationId;
  await waitTerminal(managerA, home, opId, daemon);

  // Pack the queried op's journal with 64 schema-max conflicts (~6 KiB
  // each): shedding must converge, and whatever shape survives must still
  // serialize inside the bound — the last-resort fallback must not re-add
  // the oversized fields it just removed.
  const receipt = readReceipt(home);
  const op = receipt.operations.find(o => o.operationId === opId);
  op.conflicts = Array.from({ length: 64 }, (_, i) => ({
    code: 'IO_FAILURE',
    path: `/${'p'.repeat(4000)}`,
    message: `conflict ${i}: ${'m'.repeat(2000)}`,
    expectedSha256: 'a'.repeat(64),
    actualSha256: 'b'.repeat(64),
  }));
  writeFileSync(receiptPath(home), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const status = await managerB.status(statusInput(home, opId), daemon);
  const bytes = Buffer.byteLength(JSON.stringify(status));
  assert.ok(bytes <= 64 * 1024, `status response ${bytes}B exceeds the RPC bound`);
  assert.ok(status.conflicts.length <= 64);
  assert.ok(
    status.conflicts.some(c => /omitted|truncated/.test(c.message)),
    'a maxed-out response must carry the shedding marker',
  );
});

test('verifyPublished anchors the recorded payload identity on installed.json', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const managerA = createManager(deps);
  const act = await managerA.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');

  // Tamper the candidate's own identity record: the recorded pair must be
  // checked against installed.json, not just the embedded payload — a
  // swapped/foreign directory fails RUNTIME_INTEGRITY.
  const installedPath = join(home, 'slp-runtime', deps.payload.candidate.sha256, 'installed.json');
  const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
  installed.payloadSha256 = 'f'.repeat(64);
  writeFileSync(installedPath, JSON.stringify(installed, null, 2) + '\n');

  const managerB = createManager(makeDeps({ payload: deps.payload, execOpts: { binaries } }));
  const inspectId = randomUUID();
  await managerB.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(managerB, home, inspectId, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.ok(opCodes(home, inspectId).includes('RUNTIME_INTEGRITY'));
});

// ---------------------------------------------------------------------------
// Round-6 Astra sweep-4 regressions (V1–V4)
// ---------------------------------------------------------------------------

test('V1: fresh inspect with no receipt still runs persisted-schema checks before the INACTIVE verdict', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  // A persisted-schema-rejected field with no receipt at all: the old
  // fresh-inspect branch enumerated unmanaged entries only and published a
  // clean INACTIVE — the schema check must run before EVERY verdict.
  const corrupt = readConfigJson(home);
  corrupt.mysteryField = { a: 1 };
  writeFileSync(join(home, 'config.json'), JSON.stringify(corrupt, null, 2) + '\n', { mode: 0o600 });

  const manager = createManager(makeDeps({ execOpts: { binaries } }));
  const inspectId = randomUUID();
  await manager.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(manager, home, inspectId, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.ok(opCodes(home, inspectId).includes('SCHEMA_LOSS'), `expected SCHEMA_LOSS, got ${opCodes(home, inspectId)}`);
});

test('V1: interrupted pre-plan op without a binding runs persisted/live checks before the restore verdict', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  // Fresh activation dies before 'materialized': pending, plan null, no
  // binding anywhere — a second boot's inspect owns the verdict.
  dirBlocker(home);
  armRecoveryFault(depsA, 'activate', 'materialized');
  const opId = randomUUID();
  await managerA.activate(activateInput(home, depsA.payload, opId), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.equal(opOf(home, opId).outcome, 'pending');
  assert.equal(opOf(home, opId).plan, null);
  assert.equal(readReceipt(home).binding, null);

  const corrupt = readConfigJson(home);
  corrupt.mysteryField = { a: 1 };
  writeFileSync(join(home, 'config.json'), JSON.stringify(corrupt, null, 2) + '\n', { mode: 0o600 });

  const managerB = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const inspectId = randomUUID();
  await managerB.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(managerB, home, inspectId, daemon);
  // Old code restored priorState(INACTIVE) with succeeded/conflicts:[] — a
  // clean verdict over a schema-broken config.
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.ok(opCodes(home, inspectId).includes('SCHEMA_LOSS'), `expected SCHEMA_LOSS, got ${opCodes(home, inspectId)}`);
  assert.equal(opOf(home, opId).outcome, 'recovery-required', 'subject keeps recovery evidence, not a clean failed verdict');
});

test('V1: interrupted pre-plan op verifies retained assets before the verdict', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  const act = await managerA.activate(activateInput(home, depsA.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');
  const launchSet1 = doneAct.binding.launchSetSha256;

  // Rebind to a second candidate: retained[0] keeps the OLD launch set.
  const payload2 = makePayload({ 'bin/slp-shim.mjs': '#!/usr/bin/env node\n// v2\n', 'roles/peer.md': '# peer\n' });
  const depsB = makeDeps({ payload: payload2, execOpts: { binaries } });
  const managerB = createManager(depsB);
  const act2 = await managerB.activate(activateInput(home, payload2, randomUUID()), daemon);
  const doneAct2 = await waitTerminal(managerB, home, act2.operation.operationId, daemon);
  assert.equal(doneAct2.state, 'ACTIVE');
  assert.notEqual(readReceipt(home).retained[0].launchSetSha256, doneAct2.binding.launchSetSha256);

  // A deactivate then dies before its 'prepared' write: pending, no plan,
  // binding still pointing at candidate 2.
  armRecoveryFault(depsB, 'deactivate', 'prepared');
  dirBlocker(home);
  const deactId = randomUUID();
  await managerB.deactivate(deactivateInput(home, deactId, doneAct2.binding.bindingSha256), daemon);
  await waitRecovery(managerB, home, daemon);
  assert.equal(opOf(home, deactId).plan, null);

  // Delete the retained launch set — the old code verified only the active
  // binding and restored ACTIVE/succeeded; a normal inspect right after
  // caught RUNTIME_INTEGRITY.
  rmSync(join(home, 'slp-runtime', 'launchers', launchSet1), { recursive: true, force: true });

  const managerC = createManager(makeDeps({ payload: payload2, execOpts: { binaries } }));
  const inspectId = randomUUID();
  await managerC.reconcile(reconcileInput(home, inspectId, 'inspect'), daemon);
  const done = await waitTerminal(managerC, home, inspectId, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.ok(opCodes(home, inspectId).some(c => c === 'RUNTIME_INTEGRITY' || c === 'IO_FAILURE'), `expected integrity evidence, got ${opCodes(home, inspectId)}`);
});

test('V2: deactivation recovery revalidates the endpoint runtime before dispatching the removal patch', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  const act = await managerA.activate(activateInput(home, depsA.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');

  // Deactivate dies at 'prepared': plan durable, no patch dispatched.
  armRecoveryFault(depsA, 'deactivate', 'request-id');
  dirBlocker(home);
  const deactId = randomUUID();
  await managerA.deactivate(deactivateInput(home, deactId, doneAct.binding.bindingSha256), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.equal(opOf(home, deactId).outcome, 'pending');
  assert.ok(opOf(home, deactId).plan !== null);
  assert.equal(daemon.patchCalls.length, 1);

  // The endpoint's runtime corrupts in the crash window — complete() must
  // report integrity evidence, not erase it with the removal patch.
  rmSync(join(home, 'slp-runtime', depsA.payload.candidate.sha256, 'bin', 'slp-shim.mjs'));

  const managerB = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const rec = randomUUID();
  await managerB.reconcile(reconcileInput(home, rec, 'complete', deactId), daemon);
  const done = await waitTerminal(managerB, home, rec, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.ok(opCodes(home, rec).includes('RUNTIME_INTEGRITY'), `expected RUNTIME_INTEGRITY, got ${opCodes(home, rec)}`);
  assert.equal(daemon.patchCalls.length, 1, 'no removal patch may dispatch against a corrupt endpoint');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15, 'providers untouched');
});

test('V2: activation recovery re-verifies the runtime after the patch before publishing ACTIVE', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const depsA = makeDeps({ execOpts: { binaries } });
  dirBlocker(home);
  armRecoveryFault(depsA, 'activate', 'patch-dispatched'); // 'patch-dispatched' write onward: pending at prepared
  const managerA = createManager(depsA);
  const opId = randomUUID();
  await managerA.activate(activateInput(home, depsA.payload, opId), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.equal(opOf(home, opId).phase, 'prepared');
  assert.equal(daemon.patchCalls.length, 0);

  // Corrupt the runtime the moment the redispatched patch lands — after the
  // pre-dispatch verify, before the post-patch verify.
  const shim = join(home, 'slp-runtime', depsA.payload.candidate.sha256, 'bin', 'slp-shim.mjs');
  const origPatch = daemon.config.patch;
  daemon.config.patch = (patch, requestId) =>
    origPatch(patch, requestId).then(res => {
      rmSync(shim, { force: true });
      return res;
    });

  const managerB = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const rec = randomUUID();
  await managerB.reconcile(reconcileInput(home, rec, 'complete', opId), daemon);
  const done = await waitTerminal(managerB, home, rec, daemon);
  assert.equal(done.state, 'RECOVERY_REQUIRED');
  assert.ok(opCodes(home, rec).includes('RUNTIME_INTEGRITY'), `expected RUNTIME_INTEGRITY, got ${opCodes(home, rec)}`);
  assert.equal(daemon.patchCalls.length, 1, 'the forward patch was redispatched once');
  assert.equal(readReceipt(home).binding, null, 'a corrupt endpoint must not publish ACTIVE');
});

test('V3: restore-before of a rebind restores providers without tripping the dependency guard', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home, { patchScript: ['ok', 'apply-then-reject'] });
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  const act = await managerA.activate(activateInput(home, depsA.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');
  const bindingA = readReceipt(home).binding.bindingSha256;

  // A dependent reference to an owned provider exists on BOTH sides BEFORE
  // the rebind — it is recorded in the plan's unrelated-persisted anchor, so
  // classification stays clean. The inverse of a rebind removes no
  // providers, so the reference is legitimate state to keep.
  const config = readConfigJson(home);
  config.agents.metadataGeneration = { providers: [{ provider: 'slp-codex-lead', model: 'm1' }] };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  daemon.__store.current.metadataGeneration.providers = [{ provider: 'slp-codex-lead', model: 'm1' }];

  // Rebind to candidate 2 via the manager that embeds it (the update flow):
  // the patch applies (disk = after endpoint) but the response is lost —
  // outcome-unknown, RECOVERY_REQUIRED.
  const payload2 = makePayload({ 'bin/slp-shim.mjs': '#!/usr/bin/env node\n// v2\n', 'roles/peer.md': '# peer\n' });
  const managerB = createManager(makeDeps({ payload: payload2, execOpts: { binaries } }));
  const rebindId = randomUUID();
  const rebind = await managerB.activate(activateInput(home, payload2, rebindId), daemon);
  assert.equal(rebind.accepted, true);
  await waitRecovery(managerB, home, daemon);
  assert.equal(opOf(home, rebindId).outcome, 'recovery-required');
  assert.equal(daemon.patchCalls.length, 2);

  // New boot embedding candidate 1 (the runtime it restores): the chain's
  // unresolved attempt is foreign, so restore-before is admitted; the
  // inverse restores binding A's provider values and removes nothing — the
  // dependency guard must not fire.
  const managerC = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const rec = randomUUID();
  const accepted = await managerC.reconcile(reconcileInput(home, rec, 'restore-before', rebindId), daemon);
  assert.equal(accepted.accepted, true);
  const done = await waitTerminal(managerC, home, rec, daemon);
  assert.equal(done.operation.outcome, 'succeeded', `expected succeeded, got ${done.operation.outcome} ${opCodes(home, rec)}`);
  assert.ok(!opCodes(home, rec).includes('DEPENDENT_REFERENCE'), 'rebind inverse removes no providers');
  assert.equal(done.state, 'ACTIVE');
  assert.equal(readReceipt(home).binding.bindingSha256, bindingA, 'binding A restored');
  assert.equal(daemon.patchCalls.length, 3, 'exactly one inverse patch');
});

test('V4: the 64 KiB fallback preserves state, operation, binding identity and counts', async t => {
  // Escaped paths push the serialized response past the bound: every \u0001
  // becomes six bytes in JSON. ~3.3K-char home → ~20KB per recorded path
  // (target.daemonHome, binding.runtimePath/nodePath, family binaryPaths).
  const base = mkdtempSync(join(tmpdir(), 'slp-deep-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, ...Array(13).fill(''.repeat(250)));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, daemon: { mcp: { enabled: true } } }, null, 2) + '\n', { mode: 0o600 });
  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  const binaries = {};
  for (const family of ['codex', 'pi', 'devin', 'claude', 'opencode']) {
    const p = join(binDir, `${family}-bin`);
    writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    binaries[family] = p;
  }
  const nodePath = join(binDir, 'node');
  writeFileSync(nodePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const daemon = await makeDaemon(t, home);
  // Deep paths arrive through the executable seam (execOpts), not the wire
  // input — the input bound would reject a >64KiB activate request outright.
  const deps = makeDeps({ execOpts: { binaries, node: nodePath } });
  const manager = createManager(deps);
  const act = await manager.activate(
    activateInput(home, deps.payload, randomUUID()),
    daemon,
  );
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');
  const real = readReceipt(home).binding;

  const status = await manager.status(statusInput(home), daemon);
  const bytes = Buffer.byteLength(JSON.stringify(status));
  assert.ok(bytes <= 64 * 1024, `status response ${bytes}B exceeds the RPC bound`);
  // The fallback fired — long fields were shortened — but nothing real was
  // rendered as absent.
  assert.ok(status.conflicts.some(c => /truncated/.test(c.message)), 'truncation marker missing');
  assert.equal(status.state, 'ACTIVE');
  assert.equal(status.operation.operationId, act.operation.operationId);
  assert.equal(status.retainedRuntimeCount, real ? readReceipt(home).retained.length : 0);
  assert.ok(status.binding !== null, 'a real binding must never be nulled by the fallback');
  assert.equal(status.binding.bindingSha256, real.bindingSha256);
  assert.equal(status.binding.candidateSha256, real.candidateSha256);
  assert.equal(status.binding.payloadSha256, real.payloadSha256);
  assert.equal(status.binding.launchSetSha256, real.launchSetSha256);
  assert.equal(status.binding.baseline, real.baseline);
  assert.ok(status.binding.runtimePath.endsWith('…') && status.binding.runtimePath.length <= 513);
  assert.ok(status.binding.nodePath.endsWith('…') && status.binding.nodePath.length <= 513);
  assert.ok(status.target.daemonHome.endsWith('…') && status.target.daemonHome.length <= 513);
  assert.ok(status.verifiedAt !== null);
});

// ---------------------------------------------------------------------------
// Round-7 Astra sweep-5 regressions (W1–W3): calibration of the Round-6 fixes
// ---------------------------------------------------------------------------

test('W1: deactivation recovery does not require the external provider binary', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  const act = await managerA.activate(activateInput(home, depsA.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');

  // Deactivate dies at 'prepared': plan durable, no patch dispatched.
  armRecoveryFault(depsA, 'deactivate', 'request-id');
  dirBlocker(home);
  const deactId = randomUUID();
  await managerA.deactivate(deactivateInput(home, deactId, doneAct.binding.bindingSha256), daemon);
  await waitRecovery(managerA, home, daemon);
  assert.equal(opOf(home, deactId).outcome, 'pending');
  assert.ok(opOf(home, deactId).plan !== null);
  assert.equal(daemon.patchCalls.length, 1);

  // The external binary vanishes in the crash window — runtime + launchers
  // stay intact. §8.3: detaching a verifiable binding must not require the
  // external provider binary to still be installed.
  rmSync(binaries.codex);

  const managerB = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const rec = randomUUID();
  await managerB.reconcile(reconcileInput(home, rec, 'complete', deactId), daemon);
  const done = await waitTerminal(managerB, home, rec, daemon);
  assert.equal(done.operation.outcome, 'succeeded', `expected succeeded, got ${done.operation.outcome} ${opCodes(home, rec)}`);
  assert.equal(done.state, 'INACTIVE');
  assert.equal(daemon.patchCalls.length, 2, 'the removal patch redispatched once');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 0);
});

test('W2: restore-before of a partial adoption guards only the providers the inverse removes', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const depsA = makeDeps({ execOpts: { binaries } });
  const managerA = createManager(depsA);
  const act = await managerA.activate(activateInput(home, depsA.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(managerA, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');

  // Trim disk to exactly one canonical owned provider plus a
  // metadataGeneration reference to it — the reference pre-exists the op, so
  // it is anchored in the plan's unrelated-persisted hash and keeps
  // classification clean.
  const config = readConfigJson(home);
  for (const id of Object.keys(config.agents.providers)) {
    if (id !== 'slp-codex-lead') delete config.agents.providers[id];
  }
  config.agents.metadataGeneration = { providers: [{ provider: 'slp-codex-lead', model: 'm1' }] };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  rmSync(receiptPath(home), { force: true });

  // Boot 2: the daemon loads the trimmed config; the adoption patch adds
  // the other 11 providers, then the response is lost.
  const daemonB = await makeDaemon(t, home, { patchScript: ['apply-then-reject'] });
  const managerB = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const adoptId = randomUUID();
  const adopt = await managerB.activate(activateInput(home, depsA.payload, adoptId, { adoptIdentical: true }), daemonB);
  assert.equal(adopt.accepted, true, `adoption refused: ${adopt.conflicts.map(c => c.code)}`);
  await waitRecovery(managerB, home, daemonB);
  assert.equal(opOf(home, adoptId).outcome, 'recovery-required');
  assert.equal(Object.keys(slpProvidersOf(readConfigJson(home))).length, 15, 'forward patch applied');

  // Boot 3: restore-before. The inverse removes the 11 adopted providers
  // and KEEPS slp-codex-lead — a reference to a kept provider is legitimate
  // state, not DEPENDENT_REFERENCE. The old code checked all twelve.
  const managerC = createManager(makeDeps({ payload: depsA.payload, execOpts: { binaries } }));
  const rec = randomUUID();
  const accepted = await managerC.reconcile(reconcileInput(home, rec, 'restore-before', adoptId), daemonB);
  assert.equal(accepted.accepted, true);
  const done = await waitTerminal(managerC, home, rec, daemonB);
  assert.equal(done.operation.outcome, 'succeeded', `expected succeeded, got ${done.operation.outcome} ${opCodes(home, rec)}`);
  assert.ok(!opCodes(home, rec).includes('DEPENDENT_REFERENCE'), 'a kept provider must not trip the guard');
  assert.equal(done.state, 'INACTIVE');
  assert.deepEqual(Object.keys(slpProvidersOf(readConfigJson(home))), ['slp-codex-lead']);
  assert.equal(daemonB.patchCalls.length, 2, 'exactly one inverse patch');
});

test('W3: the 64 KiB fallback sheds oversized conflict diagnostics while preserving identity', async t => {
  // Same escaping-path fixture as V4, plus one schema-max conflict riding in
  // on the latest op — its 4096-char path and 2048-char message escape ~6×
  // and pushed the old preserved fallback to ~66.6KB.
  const base = mkdtempSync(join(tmpdir(), 'slp-deep-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, ...Array(13).fill(''.repeat(250)));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, daemon: { mcp: { enabled: true } } }, null, 2) + '\n', { mode: 0o600 });
  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  const binaries = {};
  for (const family of ['codex', 'pi', 'devin', 'claude', 'opencode']) {
    const p = join(binDir, `${family}-bin`);
    writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    binaries[family] = p;
  }
  const nodePath = join(binDir, 'node');
  writeFileSync(nodePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const versions = Object.fromEntries(
    ['codex', 'pi', 'devin', 'claude', 'opencode'].map(f => [f, ''.repeat(256)]),
  );

  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries, node: nodePath, versions } });
  const manager = createManager(deps);
  const act = await manager.activate(activateInput(home, deps.payload, randomUUID()), daemon);
  const doneAct = await waitTerminal(manager, home, act.operation.operationId, daemon);
  assert.equal(doneAct.state, 'ACTIVE');
  const real = readReceipt(home).binding;

  // A schema-max conflict on the latest op (merged into status output) with
  // escape-heavy path+message — and a 256-char hostId to keep the repro's
  // load profile. The request hostId matches the receipt so only this one
  // conflict is in play.
  const hostId = 'h'.repeat(256);
  const receipt = readReceipt(home);
  receipt.target.hostId = hostId;
  receipt.operations[receipt.operations.length - 1].conflicts = [{
    code: 'IO_FAILURE',
    path: '/' + ''.repeat(4095),
    message: ''.repeat(2048),
    expectedSha256: null,
    actualSha256: null,
  }];
  writeFileSync(receiptPath(home), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });

  const status = await manager.status({ schemaVersion: 1, target: { hostId, daemonHome: home } }, daemon);
  const bytes = Buffer.byteLength(JSON.stringify(status));
  assert.ok(bytes <= 64 * 1024, `status response ${bytes}B exceeds the RPC bound`);
  assert.ok(status.conflicts.some(c => /truncated/.test(c.message)), 'truncation marker missing');
  assert.equal(status.state, 'ACTIVE');
  assert.equal(status.operation.operationId, act.operation.operationId);
  assert.equal(status.retainedRuntimeCount, readReceipt(home).retained.length);
  assert.ok(status.binding !== null, 'a real binding must never be nulled by the fallback');
  assert.equal(status.binding.bindingSha256, real.bindingSha256);
  assert.equal(status.binding.candidateSha256, real.candidateSha256);
  // The oversized conflict is still reported — shortened, not erased.
  assert.ok(status.conflicts.some(c => c.code === 'IO_FAILURE' && c.path?.endsWith('…')), 'conflict diagnostics should be shortened, not dropped');
});

test('X3: an oversized probe-failure conflict is normalized at creation so the op settles', async t => {
  const { home, binaries, daemon, deps } = await makePluginFixture(t);
  const manager = createManager(deps);
  const opId = randomUUID();
  // 2900-char explicit nodePath — schema-valid input (AbsolutePath ≤4096) but
  // nonexistent on disk, so the resolution failure embeds the whole path in
  // the conflict message (~2939 chars > the 2048 wire bound). Before the fix
  // that oversized conflict failed Receipt.parse inside recordFailure and the
  // op wedged accepted/pending forever.
  await manager.activate(
    activateInput(home, deps.payload, opId, { nodePath: '/' + 'x'.repeat(2900) }),
    daemon,
  );
  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.state, 'INACTIVE');
  const op = opOf(home, opId);
  assert.equal(op.outcome, 'failed', 'a pre-patch probe failure must settle failed, not wedge pending');
  assert.equal(op.phase, 'terminal');
  const conflict = op.conflicts.find(c => c.code === 'EXECUTABLE_UNAVAILABLE');
  assert.ok(conflict, `expected EXECUTABLE_UNAVAILABLE, got ${op.conflicts.map(c => c.code)}`);
  assert.ok(conflict.message.length <= 2048, `conflict message ${conflict.message.length} exceeds the schema bound`);
  assert.ok(conflict.message.endsWith('…[truncated]'), 'oversized messages carry the truncation marker');
  assert.equal(daemon.patchCalls.length, 0, 'failure before any patch must dispatch nothing');
});
