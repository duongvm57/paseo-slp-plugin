import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { install, json, identity, hash, readJson } from '../plugin/server/runtime/cli/package.ts';
import { localTarget, runtimeStatus } from '../plugin/server/runtime/cli/runtime-state.ts';
import { readJevConfig, readJevKey, resolveJev } from '../plugin/server/runtime/cli/jev.ts';
import { readCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { roleBundle } from '../plugin/server/runtime/cli/role-bundle.ts';
import { createJev } from '../plugin/server/jev.ts';
import { createManager } from '../plugin/server/manager.ts';
import { createStateStore } from '../plugin/server/state-store.ts';
import { fakeOrKey } from './fake-secrets.mjs';
import {
  activateInput, makeBinaries, makeDaemon, makeDeps, makeHome,
  statusInput, targetOf, waitTerminal,
} from './helpers/plugin-doubles.mjs';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/rtstate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake daemon home: <home>/slp-runtime/state/* plus <home>/config.json.
function homeFixture(t, { receipt = null, config = null, language = null, routing = null } = {}) {
  const home = join(fixture(t), 'home');
  mkdirSync(join(home, 'slp-runtime/state'), { recursive: true });
  if (receipt) writeFileSync(join(home, 'slp-runtime/state/receipt.json'), json(receipt));
  if (routing) writeFileSync(join(home, 'slp-runtime/state/role-routing.json'), json(routing));
  if (language != null) writeFileSync(join(home, 'slp-runtime/state/communication-language'), language);
  if (config != null) writeFileSync(join(home, 'config.json'), json(config));
  return home;
}

test('local-target mirrors plugin detection: flag, env, then default', t => {
  const dir = fixture(t);
  assert.deepEqual(localTarget(dir), { daemonHome: dir, source: 'flag' });
  // Strip managed-session env so the unmanaged chain is exercised; a managed
  // seat legitimately resolves its bound home instead of the env/default.
  const saved = {};
  for (const key of ['PASEO_HOME', 'SLP_DAEMON_HOME', 'SLP_MANAGED_RUNTIME']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  t.after(() => { for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  } });
  process.env.PASEO_HOME = dir;
  assert.deepEqual(localTarget(), { daemonHome: dir, source: 'env' });
  delete process.env.PASEO_HOME;
  const fallback = localTarget();
  assert.equal(fallback.source, 'default');
  assert.ok(fallback.daemonHome.endsWith('.paseo'));
  // Managed mode resolves the bound home and never falls through to env.
  process.env.SLP_MANAGED_RUNTIME = '1';
  process.env.SLP_DAEMON_HOME = dir;
  assert.deepEqual(localTarget(), { daemonHome: dir, source: 'managed-env' });
  assert.throws(() => localTarget('relative'), /Absolute path/);
});

test('status without a receipt distinguishes clean, orphaned and unknown homes', t => {
  // Clean config → INACTIVE.
  let home = homeFixture(t, { config: { agents: { providers: {} }, daemon: { agentProfiles: [] } } });
  let status = runtimeStatus(home);
  assert.equal(status.state, 'INACTIVE');
  assert.equal(status.receipt, null);
  // Orphaned slp-* entries → interrupted activation evidence.
  home = homeFixture(t, { config: { agents: { providers: { 'slp-devin-lead': {}, other: {} } }, daemon: { agentProfiles: [{ id: 'slp-lead' }] } } });
  status = runtimeStatus(home);
  assert.equal(status.state, 'RECOVERY_REQUIRED');
  assert.deepEqual(status.orphanedEntries, ['slp-devin-lead', 'slp-lead']);
  // No config.json at all → INACTIVE (nothing to scan, gap noted).
  home = homeFixture(t);
  status = runtimeStatus(home);
  assert.equal(status.state, 'INACTIVE');
  // Corrupt config → UNKNOWN, never a guessed clean state.
  home = homeFixture(t);
  writeFileSync(join(home, 'config.json'), '{ not json');
  status = runtimeStatus(home);
  assert.equal(status.state, 'UNKNOWN');
  assert.ok(status.gaps.some(gap => /config\.json unreadable/.test(gap)));
});

test('status fails closed on a corrupt receipt instead of guessing INACTIVE', t => {
  const home = homeFixture(t);
  writeFileSync(join(home, 'slp-runtime/state/receipt.json'), '{ not json');
  assert.throws(() => runtimeStatus(home), /Cannot read .*receipt\.json/);
});

test('status recomputes file-derivable views and marks daemon-only views as gaps', t => {
  const dir = fixture(t);
  const runtimePath = join(dir, 'runtime');
  install(root, runtimePath);
  const candidateSha256 = identity(root).sha256;
  const launcher = join(dir, 'launcher-bin');
  writeFileSync(launcher, '#!/bin/sh\n');
  const home = homeFixture(t, {
    config: { agents: { providers: { 'slp-devin-lead': {}, 'slp-codex-peer': {} } },
      daemon: { agentProfiles: [{ id: 'slp-lead' }], mcp: { injectIntoAgents: true } } },
    language: 'Vietnamese',
    routing: { schemaVersion: 1, supervisor: { family: 'devin', model: 'm1' }, lead: { family: 'devin', model: 'm2' } },
  });
  writeFileSync(join(home, 'slp-runtime/state/receipt.json'), json({
    schemaVersion: 1, pluginId: 'paseo-slp', revision: 3, state: 'ACTIVE',
    target: { hostId: 'h', daemonHome: realpathSync(home) }, stableRoot: join(home, 'slp-runtime'),
    createdAt: 't', updatedAt: 't', activeOperationId: null, retained: [],
    binding: {
      bindingSha256: 'b'.repeat(64), candidateSha256, payloadSha256: 'p'.repeat(64),
      runtimePath, launchSetSha256: 'l'.repeat(64), baseline: 'fresh',
      launcherFiles: [{ path: launcher, sha256: hash(readFileSync(launcher)), mode: 0o755 }],
      binaries: { devin: { path: launcher }, codex: { path: join(dir, 'absent-bin') } },
      owned: {
        providers: { 'slp-devin-lead': { present: true }, 'slp-pi-peer': { present: true, value: {} } },
        profiles: [{ index: 0, value: { id: 'slp-lead', provider: 'slp-devin-lead', model: 'm2', modeId: 'bypass', featureValues: { auto_accept: true } } }],
      },
    },
    operations: [{ operationId: 'op-1', kind: 'activate', phase: 'terminal', outcome: 'succeeded', conflicts: [], acceptedAt: 't1', completedAt: 't2' }],
  }));
  const status = runtimeStatus(home);
  assert.equal(status.state, 'ACTIVE');
  assert.equal(status.derivedFrom, 'local-files');
  assert.equal(status.checks.targetMatch, true);
  assert.equal(status.checks.runtime.ok, true);
  assert.deepEqual(status.checks.launchers, [{ path: launcher, ok: true }]);
  // slp-pi-peer was injected per the receipt but is absent from config.json.
  assert.deepEqual(status.checks.configDrift.missingProviders, ['slp-pi-peer']);
  assert.deepEqual(status.checks.configDrift.missingProfiles, []);
  assert.deepEqual(status.receipt.binding.binaries.codex.exists, false);
  assert.deepEqual(status.receipt.binding.managedProfiles,
    [{ id: 'slp-lead', provider: 'slp-devin-lead', model: 'm2', modeId: 'bypass', thinkingOptionId: null, featureValues: { auto_accept: true } }]);
  assert.equal(status.communicationLanguage, 'Vietnamese');
  assert.deepEqual(status.roleRouting.supervisor, { family: 'devin', model: 'm1' });
  assert.deepEqual(status.receipt.operations, [{ operationId: 'op-1', kind: 'activate', phase: 'terminal', outcome: 'succeeded', conflicts: 0, acceptedAt: 't1', completedAt: 't2' }]);
  assert.ok(status.gaps.some(gap => /family availability/.test(gap)));
});

test('status reports a target mismatch and launcher drift as local evidence', t => {
  const dir = fixture(t);
  const runtimePath = join(dir, 'runtime');
  install(root, runtimePath);
  const launcher = join(dir, 'launcher-bin');
  writeFileSync(launcher, 'v1');
  const home = homeFixture(t, {
    config: { agents: { providers: {} }, daemon: { agentProfiles: [] } },
    receipt: {
      schemaVersion: 1, pluginId: 'paseo-slp', revision: 1, state: 'ACTIVE',
      target: { hostId: 'h', daemonHome: '/some/other/home' },
      binding: {
        candidateSha256: 'f'.repeat(64), runtimePath,
        launcherFiles: [{ path: launcher, sha256: 'deadbeef'.repeat(8), mode: 0o755 }],
        binaries: {}, owned: { providers: {}, profiles: [] },
      },
      operations: [],
    },
  });
  const status = runtimeStatus(home);
  assert.equal(status.checks.targetMatch, false);
  assert.equal(status.checks.runtime.ok, false);
  assert.deepEqual(status.checks.launchers, [{ path: launcher, ok: false, detail: 'sha256 drift' }]);
});

test('CLI status and local-target are read-only and fail closed', t => {
  const home = homeFixture(t, { config: { agents: { providers: {} } } });
  const cli = join(root, 'bin/slp.mjs');
  const env = { PATH: process.env.PATH };
  const target = JSON.parse(execFileSync(process.execPath, [cli, 'local-target', '--paseo-home', home], { env, encoding: 'utf8' }));
  assert.deepEqual(target, { daemonHome: home, source: 'flag' });
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--paseo-home', home], { env, encoding: 'utf8' }));
  assert.equal(status.state, 'INACTIVE');
  // Flags these commands do not own are rejected rather than ignored.
  assert.throws(() => execFileSync(process.execPath, [cli, 'status', '--apply'], { env }));
  assert.throws(() => execFileSync(process.execPath, [cli, 'status', 'extra'], { env }));
});

// ---------------------------------------------------------------------------
// Writer→reader integration: the plugin's server RPCs own every write under
// <daemonHome>/slp-runtime/state; the package readers (runtimeStatus, jev
// config/key, readCatalog, role-bundle) must resolve the same state back.
// Pins observable reader behavior, never file layout — the upcoming
// state-store extraction must be able to move storage without these tests
// changing.
// ---------------------------------------------------------------------------

test('plugin-written jev config and key read back through the package readers', async t => {
  const home = makeHome(t);
  const jev = createJev();
  const key = fakeOrKey('e2-rtstate');
  await jev.setJev({
    schemaVersion: 1, target: targetOf(home), expectedSha256: null,
    jev: {
      schemaVersion: 1, enabled: true, capabilities: { routing: true },
      provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai', model: 'typesafe/jev-1.13' },
    },
  });
  await jev.setJevKey({ schemaVersion: 1, target: targetOf(home), key });

  // The config view resolves the same document the writer stored.
  const config = readJevConfig(home);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.capabilities, { routing: true });
  assert.deepEqual(config.provider, {
    kind: 'openrouter', baseUrl: 'https://openrouter.ai', model: 'typesafe/jev-1.13',
  });
  // The key written by set-jev-key is what readJevKey hands a capability call.
  assert.equal(readJevKey(home, 'openrouter'), key);
  // Full resolution arms the capability and derives the transport endpoint.
  const resolved = resolveJev(home, 'routing');
  assert.equal(resolved.armed, true);
  assert.equal(resolved.key, key);
  assert.equal(resolved.provider.endpoint, 'https://openrouter.ai/api/alpha/decisions');

  // The status probe reports presence + permissions — never key material.
  const status = runtimeStatus(home);
  assert.deepEqual(status.jev, {
    configured: true, enabled: true, capabilities: { routing: true },
    provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai', model: 'typesafe/jev-1.13' },
    hasKey: true, keyPermissionsOk: true,
  });
  assert.equal(JSON.stringify(status).includes(key), false);
});

test('manager-written language, routing and pool state read back through the package probes', async t => {
  const home = makeHome(t);
  const manager = createManager(makeDeps());
  const store = createStateStore();
  const managedEnv = {
    SLP_MANAGED_RUNTIME: '1', SLP_NODE_BIN: process.execPath,
    SLP_RUNTIME_ROOT: root, SLP_DAEMON_HOME: realpathSync(home),
  };

  // communication-language: written by set-language, consumed by the status
  // probe and by role-bundle at managed-session entry.
  assert.equal(runtimeStatus(home).communicationLanguage, null);
  assert.equal(roleBundle(root, 'peer', managedEnv).instructions.includes('Communication language:'), false);
  await store.setLanguage({ schemaVersion: 1, target: targetOf(home), value: 'Vietnamese' });
  // Observed asymmetry: the status probe surfaces the stored bytes verbatim
  // (the writer terminates the file with a newline) while the bundle render
  // and the plugin's own status reader trim at consume time.
  assert.equal(runtimeStatus(home).communicationLanguage, 'Vietnamese\n');
  assert.ok(roleBundle(root, 'peer', managedEnv).instructions.includes('Communication language: Vietnamese'));
  await store.setLanguage({ schemaVersion: 1, target: targetOf(home), value: null });
  assert.equal(runtimeStatus(home).communicationLanguage, null);
  assert.equal(roleBundle(root, 'peer', managedEnv).instructions.includes('Communication language:'), false);

  // role-routing.json: set-role-routing writes; the status probe and the
  // plugin's own get-role-routing read the same document back.
  const routing = {
    schemaVersion: 1,
    supervisor: { family: 'devin', model: 'swe-2-max' },
    lead: { family: 'codex', model: 'gpt-5-codex' },
  };
  await store.setRoleRouting({ schemaVersion: 1, target: targetOf(home), routing });
  assert.deepEqual(runtimeStatus(home).roleRouting, routing);
  assert.deepEqual((await store.getRoleRouting({ schemaVersion: 1, target: targetOf(home) })).routing, routing);

  // peer-pool.json: set-peer-pool writes under sha256 CAS; readCatalog
  // resolves it as the user-scope catalog for a repository without its own
  // .paseo-slp/slp-routing.json.
  const repo = join(fixture(t), 'repo');
  mkdirSync(repo, { recursive: true });
  const pool = {
    version: 1,
    policy: 'Peers pick the cheapest live seat that fits the work.',
    quotaFallback: { enabled: true, optionId: 'peer-eng' },
    options: [{
      id: 'peer-eng', provider: 'codex', roles: ['peer'], model: 'gpt-5-codex',
      enabled: true, availability: 'ready', modeId: 'fast',
      suitableFor: ['bounded coding tasks'], avoidFor: ['open-ended research'],
      notes: 'Local-only annotation — never sent to Jev.',
    }],
  };
  const written = await store.setPeerPool({ schemaVersion: 1, target: targetOf(home), pool, expectedSha256: null });
  const catalog = readCatalog(repo, home);
  assert.equal(catalog.scope, 'user');
  assert.equal(catalog.sha256, written.sha256, 'the CAS token the writer returned is the file hash the reader recomputes');
  assert.deepEqual(catalog.options, pool.options);
  assert.deepEqual(catalog.quotaFallback, pool.quotaFallback);
  assert.deepEqual(catalog.tokenConflicts, []);
});

test('an activated binding reads back through both the plugin status RPC and the local status probe', async t => {
  const home = makeHome(t);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  const manager = createManager(deps);
  const store = createStateStore();
  await store.setLanguage({ schemaVersion: 1, target: targetOf(home), value: 'Vietnamese' });

  const opId = randomUUID();
  const start = await manager.activate(activateInput(home, deps.payload, opId), daemon);
  assert.equal(start.accepted, true);
  const done = await waitTerminal(manager, home, opId, daemon);
  assert.equal(done.operation.outcome, 'succeeded');
  assert.equal(done.state, 'ACTIVE');

  // The journal the activation committed is the same receipt both readers
  // report: the plugin's own status RPC and the package-side local probe.
  const status = runtimeStatus(home);
  assert.equal(status.state, 'ACTIVE');
  assert.equal(status.checks.targetMatch, true);
  assert.equal(status.receipt.binding.candidateSha256, deps.payload.candidate.sha256);
  assert.equal(status.receipt.binding.launcherCount, 12);
  assert.ok(status.checks.launchers.every(file => file.ok), 'recorded launcher bytes re-hash from disk');
  assert.deepEqual(status.checks.configDrift.missingProviders, []);
  assert.deepEqual(status.checks.configDrift.missingProfiles, []);
  assert.equal(status.receipt.binding.binaries.devin.exists, true);
  assert.equal(status.receipt.operations.length, 1);
  const [op] = status.receipt.operations;
  assert.equal(op.operationId, opId);
  assert.equal(op.kind, 'activate');
  assert.equal(op.phase, 'terminal');
  assert.equal(op.outcome, 'succeeded');
  assert.equal(op.conflicts, 0);
  assert.ok(op.acceptedAt && op.completedAt);
  // Both readers agree on state and binding identity.
  const daemonView = await manager.status(statusInput(home), daemon);
  assert.equal(daemonView.state, status.state);
  assert.equal(daemonView.binding.candidateSha256, status.receipt.binding.candidateSha256);
  // The trim asymmetry across the two readers on the same written file.
  assert.equal(status.communicationLanguage, 'Vietnamese\n');
  assert.equal(daemonView.communicationLanguage, 'Vietnamese');
  // Observed double-fidelity gap: the test materializer records the
  // simplified plugin-side installed.json (its own verifyPublished accepts
  // it), while the package verifyInstall recomputes the §5 candidate
  // identity recipe — so this check reports not-ok under doubles even though
  // real installs verify. Pinned explicitly so a double upgrade surfaces
  // here rather than silently changing coverage.
  assert.equal(status.checks.runtime.ok, false);
  assert.equal(typeof status.checks.runtime.detail, 'string');
});
