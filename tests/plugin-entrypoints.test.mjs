// tests/plugin-entrypoints.test.mjs — §13 row 1 coverage: the shipped
// paseo-plugin.json parses through the host's REAL manifest validator
// (readPluginManifest from the installed @getpaseo/server), and the real
// contribution function in plugin/index.server.ts registers the full RPC set,
// the two before-hooks, and the shadow-observer lifecycle hooks, and returns
// a working cleanup.
//
// contribute() itself only CONSTRUCTS its lane deps — the resolve hook below
// substitutes a specifier ONLY when the real lane module fails to resolve
// (index.server.ts statically imports materializer/executables/launchers/
// generated-payload — sibling-lane modules absent in a lane-isolated worktree,
// present in the integrated repo). Real modules therefore exercise the real
// createMaterializer/executables/launchers constructors whenever they exist;
// the stub is a worktree-isolation fallback, not a mock of the contribution.
// Host-module discovery (PASEO_CLI_MODULES → npm root -g → which paseo → fnm)
// lives in tests/helpers/plugin-doubles.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { loadHostModule } from './helpers/plugin-doubles.mjs';
import { CatalogModel, CatalogOutput } from '../plugin/shared/contracts.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugin');

async function loadHostPluginModules() {
  return loadHostModule('plugins/manifest.js');
}

// ---------------------------------------------------------------------------
// (a) manifest through the host's real validator
// ---------------------------------------------------------------------------

test('paseo-plugin.json parses through the host readPluginManifest', async t => {
  const host = await loadHostPluginModules();
  if (!host || typeof host.readPluginManifest !== 'function') {
    t.skip('HOST MANIFEST VALIDATOR UNAVAILABLE — manifest parsing not verified against real host (set PASEO_CLI_MODULES; see warning above)');
    return;
  }
  const manifest = await host.readPluginManifest(PLUGIN_DIR);
  assert.deepEqual(manifest, {
    id: 'paseo-slp',
    requirements: { paseo: '>=0.8.0' },
    build: [['npm', 'install', '--omit=dev', '--no-audit', '--no-fund']],
  });
});

test('host manifest rejects invalid fields and never preserves unknown top-level keys', async t => {
  const host = await loadHostPluginModules();
  if (!host || typeof host.readPluginManifest !== 'function') {
    t.skip('HOST MANIFEST VALIDATOR UNAVAILABLE — rejection coverage skipped (set PASEO_CLI_MODULES; see warning above)');
    return;
  }
  const cases = [
    { name: 'extra top-level key', doc: { id: 'x', extraField: true }, unknownKey: 'extraField' },
    { name: 'invented requirements key', doc: { id: 'x', requirements: { bogus: '1' } } },
    { name: 'missing id', doc: { requirements: { paseo: '>=0.8.0' } } },
    { name: 'non-string id', doc: { id: 42 } },
  ];
  for (const { name, doc, unknownKey } of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'slp-manifest-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'paseo-plugin.json'), JSON.stringify(doc));
    if (unknownKey) {
      // 0.10.x rejects; 0.11.x strips. Neither may retain the unknown key.
      // Keep assertions outside the rejection handler so a failed assertion
      // cannot be mistaken for the host rejecting the manifest.
      const outcome = await host.readPluginManifest(dir).then(
        manifest => ({ accepted: true, manifest }),
        () => ({ accepted: false }),
      );
      if (outcome.accepted) {
        assert.equal(Object.hasOwn(outcome.manifest, unknownKey), false, name);
        assert.equal(outcome.manifest.id, doc.id, 'accepted manifest retains its valid identity');
      }
    } else {
      await assert.rejects(() => host.readPluginManifest(dir), undefined, name);
    }
  }
});

// ---------------------------------------------------------------------------
// (b) real contribute() against a minimal server stub
// ---------------------------------------------------------------------------

const LANE_SPECIFIERS = new Map([
  ['./server/materializer.ts', 'materializer'],
  ['./server/generated/runtime-payload.ts', 'runtime-payload'],
  ['./server/executables.ts', 'executables'],
  ['./server/launchers.ts', 'launchers'],
]);

function writeLaneStubs(t) {
  // Honest doubles in a real module file: they do real filesystem work if the
  // manager ever calls them, but contribute() itself only constructs them.
  const dir = mkdtempSync(join(tmpdir(), 'slp-lane-stubs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'lane-stubs.mjs');
  writeFileSync(
    file,
    `import { createHash } from 'node:crypto';
const sha256 = d => createHash('sha256').update(d).digest('hex');
const files = [{ path: 'bin/slp-shim.mjs', sha256: sha256('shim'), mode: 0o644, base64: Buffer.from('shim').toString('base64') }];
export const embeddedPayload = {
  schemaVersion: 1,
  candidate: { sha256: sha256('candidate'), files: files.map(({ path, sha256: s }) => ({ path, sha256: s })) },
  payloadSha256: sha256('payload'),
  files,
};
export const createMaterializer = () => ({
  async materialize() { throw new Error('not exercised by contribute()'); },
  async verifyPublished() {},
  async discardStaging() {},
});
export const createExecutableResolver = () => ({
  async resolve() { throw new Error('not exercised by contribute()'); },
});
export const createLauncherBuilder = () => ({
  async publish() { throw new Error('not exercised by contribute()'); },
  async verify() { throw new Error('not exercised by contribute()'); },
});
export const createDeskBridge = deps => {
  const probe = globalThis.__paseoDeskBridgeProbe;
  if (probe) probe.deps = deps;
  return {
    start() {},
    state() { return { kind: 'listening' }; },
    notePaseo(paseo) { if (paseo === undefined) return; deps.paseoRef.current = paseo; if (probe) probe.notePaseo.push(paseo); },
    noteDispatch(paseo) { if (probe) probe.noteDispatch.push(paseo); },
    taskTurnEnded() {},
    agentCreateGraft() {},
    sessionOpenStash() {},
    stop() { if (probe) probe.stopCalls++; },
  };
};
`,
  );
  return file;
}

// Import the real contribute() with the lane-stub resolve hook armed (real
// lane modules win; stubs only cover lane-isolated worktrees).
async function importContribute(t, options = {}) {
  const stubFile = writeLaneStubs(t);
  const stubUrl = pathToFileURL(stubFile).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parentPath = context.parentURL?.split('?')[0];
      if (parentPath?.endsWith('/plugin/index.server.ts') && options.deskBridgeProbe === true
        && specifier === './server/desk-bridge.ts') {
        return { url: `${stubUrl}#desk-bridge`, shortCircuit: true };
      }
      if (parentPath?.endsWith('/plugin/index.server.ts') && LANE_SPECIFIERS.has(specifier)) {
        // Real lane modules first — the stub is only a fallback for
        // lane-isolated worktrees where the sibling module is absent.
        try {
          return nextResolve(specifier, context);
        } catch {
          return { url: `${stubUrl}#${LANE_SPECIFIERS.get(specifier)}`, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());

  const entryUrl = pathToFileURL(join(PLUGIN_DIR, 'index.server.ts'));
  if (options.deskBridgeProbe === true) entryUrl.searchParams.set('deskBridgeProbe', 'observer-absent');
  const entry = await import(entryUrl.href);
  return entry.default;
}

test('contribute() registers the RPCs plus the two before-hooks, cleanup unregisters', async t => {
  const contribute = await importContribute(t);
  assert.equal(typeof contribute, 'function');

  // Point the served-home detection at an isolated temp home so the shadow
  // observer resolves deterministically (a missing/unreadable home leaves it
  // inert and the on-hooks never register).
  const home = mkdtempSync(join(tmpdir(), 'paseo-entry-'));
  writeFileSync(join(home, 'config.json'), '{}\n');
  const prevHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  const registrations = [];
  const beforeHooks = [];
  const onHooks = [];
  const unregistered = [];
  const server = {
    handle(contract, handler) {
      registrations.push({ name: contract.name, handler });
    },
    before(name, handler) {
      beforeHooks.push({ name, handler });
      return () => unregistered.push(name);
    },
    on(name, handler) {
      onHooks.push({ name, handler });
      return () => unregistered.push(name);
    },
  };
  const cleanup = contribute(server);
  assert.deepEqual(
    registrations.map(r => r.name).sort(),
    [
      'activate',
      'catalog',
      'deactivate',
      'disable-supervision-notifications',
      'enforcement-recover-lock',
      'enforcement-runtime-pin',
      'enforcement-status',
      'get-jev',
      'get-peer-pool',
      'get-role-routing',
      'get-supervision',
      'get-supervision-status',
      'get-workspace-workflow',
      'local-target',
      'reconcile',
      'set-jev',
      'set-jev-key',
      'set-language',
      'set-peer-pool',
      'set-role-routing',
      'set-supervision',
      'status',
      'test-jev',
    ],
  );
  for (const { handler } of registrations) {
    assert.equal(typeof handler, 'function');
  }
  // Two hooks per event: the P2-c role-injection pair, then the P2-d
  // bridge graft/session-stash pair — registration order is the wiring
  // contract, so names sort identically and duplicates are expected.
  assert.deepEqual(
    beforeHooks.map(h => h.name).sort(),
    ['agent.create', 'agent.create', 'agent.session_open', 'agent.session_open'],
  );
  for (const { handler } of beforeHooks) {
    assert.equal(typeof handler, 'function');
  }
  // Shadow-observer lifecycle hooks (Phase B) plus the P2-c desk
  // registration/revoke handlers — the desk handlers register separately on
  // the same two events, so those names appear twice.
  assert.deepEqual(
    onHooks.map(h => h.name).sort(),
    [
      'agent.archived',
      'agent.archived',
      'agent.created',
      'agent.created',
      'agent.turn_ended',
      'agent.turn_ended',
      'agent.turn_started',
      'agent.turn_started',
    ],
  );
  for (const { handler } of onHooks) {
    assert.equal(typeof handler, 'function');
  }
  assert.equal(typeof cleanup, 'function');
  assert.doesNotThrow(() => cleanup());
  assert.deepEqual(
    unregistered.sort(),
    [
      'agent.archived',
      'agent.archived',
      'agent.create',
      'agent.create',
      'agent.created',
      'agent.created',
      'agent.session_open',
      'agent.session_open',
      'agent.turn_ended',
      'agent.turn_ended',
      'agent.turn_started',
      'agent.turn_started',
    ],
  );
  assert.doesNotThrow(() => cleanup(), 'cleanup must be idempotent');
});

test('turn_started stashes the SDK for Desk without the optional observer and cleanup unregisters it', async t => {
  const deskProbe = { deps: null, notePaseo: [], noteDispatch: [], stopCalls: 0 };
  globalThis.__paseoDeskBridgeProbe = deskProbe;
  t.after(() => { if (globalThis.__paseoDeskBridgeProbe === deskProbe) delete globalThis.__paseoDeskBridgeProbe; });
  const contribute = await importContribute(t, { deskBridgeProbe: true });
  // No PASEO_HOME export → detectDaemonHome() answers source "default" and
  // the observer must stay null: a default-guessed home is never observed
  // (spec §Configuration — a prefill is not proof of host-home mapping).
  // The P2-c desk handshake handlers are NOT gated the same way: their
  // stable-root resolution deliberately accepts the default home (contract
  // §4.2, Q1), so exactly the desk pair registers here.
  const prevHome = process.env.PASEO_HOME;
  delete process.env.PASEO_HOME;
  t.after(() => { if (prevHome !== undefined) process.env.PASEO_HOME = prevHome; });
  // Hermetic default home: with PASEO_HOME unset, detectDaemonHome() resolves
  // join(homedir(), '.paseo') and contribute() realpaths it for the desk-seat
  // stableRoot — point HOME at a fixture dir holding a real .paseo so the
  // test never depends on the ambient user home. The default source still
  // leaves the observer inert; only the desk handshake pair registers.
  const defaultHome = mkdtempSync(join(tmpdir(), 'paseo-entry-defaulthome-'));
  mkdirSync(join(defaultHome, '.paseo'));
  const prevHomeDir = process.env.HOME;
  process.env.HOME = defaultHome;
  t.after(() => {
    if (prevHomeDir === undefined) delete process.env.HOME;
    else process.env.HOME = prevHomeDir;
    rmSync(defaultHome, { recursive: true, force: true });
  });
  // L1(3) — the warn spy is installed BEFORE contribute(): the observation
  // window covers construction and the whole drive, so a warning emitted
  // during contribute() itself cannot escape the oracle.
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = line => warnings.push(String(line));
  t.after(() => { console.warn = originalWarn; });
  const registrations = [];
  const unregistered = [];
  const server = {
    handle() {},
    before() { return () => {}; },
    on(name, handler) { registrations.push({ name, handler }); return () => unregistered.push(name); },
  };
  const cleanup = contribute(server);
  assert.equal(deskProbe.deps.taskHost(), null, 'a resumed ACP turn has no SDK slot before its lifecycle start callback');
  assert.equal(deskProbe.deps.paseoRef.current, null, 'Desk has no identity context before turn_started');
  // The desk registers membership lifecycle plus positive task-send
  // observation. The optional communication observer remains inert.
  assert.deepEqual(
    registrations.map(r => r.name).sort(),
    ['agent.archived', 'agent.created', 'agent.turn_ended', 'agent.turn_started'],
    'only desk lifecycle registers without a verified served home; communication supervision stays inert',
  );
  // (c) provenance: driving each handler with an slp-* payload over a
  // non-git cwd yields exactly the desk diagnostic warn and never throws —
  // the desk handlers are fail-open. An observer handler driven the same
  // way would throw on the missing hook context, so a mutant that swaps
  // the pairs fails here. The non-git cwd keeps the drive off the real
  // daemon home (the resolver fails before any store access).
  const plainDir = mkdtempSync(join(tmpdir(), 'paseo-entry-plain-'));
  t.after(() => rmSync(plainDir, { recursive: true, force: true }));
  const slpEvent = {
    agent: { id: 'agent-1', workspaceId: null, parentAgentId: null, provider: 'slp-codex-peer', cwd: plainDir, title: null },
  };
  const expectedOp = { 'agent.created': 'register', 'agent.archived': 'revoke' };
  for (const { name, handler } of registrations) {
    assert.equal(typeof handler, 'function');
    if (name === 'agent.turn_started') continue;
    if (name === 'agent.turn_ended') {
      const before = warnings.length;
      await handler({ agent: slpEvent.agent, turnId: 'fixture-turn', outcome: { kind: 'completed' }, timeline: [] }, {});
      assert.equal(warnings.length, before, 'unbound task observation stays inert');
      continue;
    }
    await handler(slpEvent, {});
    assert.deepEqual(warnings.at(-1), `slp: desk ${expectedOp[name]} skipped: not-git`, `${name} handler is the desk ${expectedOp[name]}`);
    const beforeSilent = warnings.length;
    await handler({ agent: { ...slpEvent.agent, provider: 'custom-tool' } }, {});
    assert.equal(warnings.length, beforeSilent, 'a non-slp provider is a silent no-op');
  }
  const started = registrations.filter(row => row.name === 'agent.turn_started');
  assert.equal(started.length, 1, 'the SDK stash registers even though observer is absent');
  const identity = { id: 'agent-1', provider: 'slp-codex-peer', cwd: plainDir, workspaceId: null };
  const paseo = {
    agents: { ref: id => ({ refresh: async () => ({ agent: id === identity.id ? identity : null, project: null }) }) },
  };
  await started[0].handler({ agent: slpEvent.agent, turnId: 'fixture-start' }, { paseo, signal: new AbortController().signal });
  assert.strictEqual(deskProbe.deps.taskHost(), paseo, 'TaskHostApi receives the exact lifecycle SDK object');
  assert.strictEqual(deskProbe.deps.paseoRef.current, paseo, 'Desk bridge identity uses that same SDK object');
  assert.deepEqual(deskProbe.notePaseo, [paseo]);
  assert.deepEqual(deskProbe.noteDispatch, [], 'a lifecycle hook never claims RPC dispatch evidence');
  const refreshed = await deskProbe.deps.paseoRef.current.agents.ref(identity.id).refresh();
  assert.strictEqual(refreshed.agent, identity, 'the captured Desk identity context can refresh its live agent');
  // L1(3) — the FULL console.warn stream from the spy install (before
  // contribute()) through the whole drive is exactly the two desk
  // diagnostics: no filter, no narrower window — any extra warning
  // (prefixed or not) fails the oracle.
  assert.deepEqual(
    warnings,
    ['slp: desk register skipped: not-git', 'slp: desk revoke skipped: not-git'],
    'every console.warn from construction through the drive is exactly the two desk diagnostics',
  );
  cleanup();
  assert.equal(unregistered.filter(name => name === 'agent.turn_started').length, 1, 'cleanup unregisters the independent SDK stash hook');
  assert.equal(deskProbe.stopCalls, 1);
});

// ---------------------------------------------------------------------------
// (b2) the catalog RPC maps real model descriptors — thinking options included
// ---------------------------------------------------------------------------

test('the catalog RPC passes per-model thinking options through to CatalogOutput', async t => {
  const contribute = await importContribute(t);
  const registrations = [];
  const cleanup = contribute({
    handle: (contract, handler) => registrations.push({ name: contract.name, handler }),
    before: () => () => {},
    on: () => () => {},
  });
  t.after(() => cleanup());
  const catalogHandler = registrations.find(r => r.name === 'catalog')?.handler;
  assert.equal(typeof catalogHandler, 'function');

  // The shape listModels really returns (AgentModelDefinition): codex/pi
  // declare thinkingOptions + a default; devin-style models declare none.
  const thinking = [
    { id: 'low', label: 'low' },
    { id: 'medium', label: 'medium', description: 'd', isDefault: true, metadata: { tier: 2 } },
    { id: 'high', label: 'high' },
  ];
  const paseo = {
    providers: {
      listModels: async () => ({
        models: [
          { id: 'gpt-5.6', label: 'GPT 5.6', thinkingOptions: thinking, defaultThinkingOptionId: 'medium' },
          { id: 'swe-2-max' },
        ],
      }),
      listModes: async () => ({ modes: [{ id: 'bypass' }] }),
      listFeatures: async () => ({ features: [] }),
    },
  };
  const result = await catalogHandler({ schemaVersion: 1, family: 'codex' }, { paseo });
  // Options and the declared default survive verbatim; a model that
  // declares none keeps absent keys — "not declared" is never rewritten
  // into an invented empty list on the wire.
  assert.deepEqual(result.models[0], {
    id: 'gpt-5.6', label: 'GPT 5.6', thinkingOptions: thinking, defaultThinkingOptionId: 'medium',
  });
  assert.deepEqual(result.models[1], { id: 'swe-2-max', label: 'swe-2-max' });
  // The wire schema round-trips the result — thinkingOptions and
  // defaultThinkingOptionId are part of CatalogOutput now.
  assert.deepEqual(CatalogOutput.parse(result), result);
});

test('CatalogModel round-trips thinking options and stays strict', () => {
  const model = {
    id: 'gpt-5.6',
    label: 'GPT 5.6',
    thinkingOptions: [
      { id: 'medium', label: 'medium', description: 'd', isDefault: true, metadata: { tier: 2 } },
    ],
    defaultThinkingOptionId: 'medium',
  };
  assert.deepEqual(CatalogModel.parse(model), model);
  assert.throws(() => CatalogModel.parse({ ...model, bogus: 1 }));
});

// ---------------------------------------------------------------------------
// (c) real host compiler on the plugin entrypoints
// ---------------------------------------------------------------------------

// compilePlugin (plugins/compiler.js in the installed @getpaseo/server) IS
// importable and runs offline — esbuild resolves through nodeRequire relative
// to the host module. The only blocker in a lane-isolated worktree is
// unresolved sibling-lane specifiers statically imported by index.server.ts;
// the compiler itself needs no live daemon. When the lane modules are present
// (integrated repo), a full successful bundle is asserted; when absent, this
// test documents the boundary precisely.
// deferred-to-S1: extend this to a full entrypoint bundle verification once
// sibling lanes ship in the same checkout.
test('real host compilePlugin runs on the plugin entrypoints', async t => {
  const host = await loadHostModule('plugins/compiler.js');
  if (!host || typeof host.compilePlugin !== 'function') {
    t.skip('HOST COMPILER UNAVAILABLE — compile coverage skipped (set PASEO_CLI_MODULES; see warning above)');
    return;
  }
  const laneModules = [...LANE_SPECIFIERS.keys()].map(spec => spec.replace('./', ''));
  const missing = laneModules.filter(rel => !existsSync(join(PLUGIN_DIR, rel)));
  if (missing.length === 0) {
    const out = await host.compilePlugin({
      client: join(PLUGIN_DIR, 'index.client.tsx'),
      server: join(PLUGIN_DIR, 'index.server.ts'),
    });
    assert.ok(out.serverBundle && out.serverBundle.length > 0, 'server bundle empty');
    assert.ok(out.clientBundle && out.clientBundle.length > 0, 'client bundle empty');
    return;
  }
  // Lane-isolated worktree: the compiler runs and reports exactly the absent
  // sibling-lane specifiers — the failure is module resolution, not a limit
  // of the compiler or of offline use.
  const failure = await host
    .compilePlugin({ client: null, server: join(PLUGIN_DIR, 'index.server.ts') })
    .then(() => null, error => error);
  assert.ok(failure, 'expected an unresolved-lane-module build failure');
  const message = String(failure.message ?? failure);
  for (const rel of missing) {
    assert.ok(
      message.includes(rel) || message.includes(`./${rel}`),
      `expected missing specifier ${rel} in compiler error:\n${message.slice(0, 800)}`,
    );
  }
  console.info(
    `deferred-to-S1: full compile verification needs sibling lane modules absent here: ${missing.join(', ')}`,
  );
});
