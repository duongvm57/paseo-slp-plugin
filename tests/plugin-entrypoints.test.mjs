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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    requirements: { paseo: '>=0.8.0 <0.10.0' },
    build: [['npm', 'install', '--omit=dev', '--no-audit', '--no-fund']],
  });
});

test('host manifest validator rejects invented/extra keys', async t => {
  const host = await loadHostPluginModules();
  if (!host || typeof host.readPluginManifest !== 'function') {
    t.skip('HOST MANIFEST VALIDATOR UNAVAILABLE — rejection coverage skipped (set PASEO_CLI_MODULES; see warning above)');
    return;
  }
  const cases = [
    { name: 'extra top-level key', doc: { id: 'x', extraField: true } },
    { name: 'invented requirements key', doc: { id: 'x', requirements: { bogus: '1' } } },
    { name: 'missing id', doc: { requirements: { paseo: '>=0.8.0' } } },
    { name: 'non-string id', doc: { id: 42 } },
  ];
  for (const { name, doc } of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'slp-manifest-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'paseo-plugin.json'), JSON.stringify(doc));
    await assert.rejects(() => host.readPluginManifest(dir), undefined, name);
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
`,
  );
  return file;
}

// Import the real contribute() with the lane-stub resolve hook armed (real
// lane modules win; stubs only cover lane-isolated worktrees).
async function importContribute(t) {
  const stubFile = writeLaneStubs(t);
  const stubUrl = pathToFileURL(stubFile).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith('/plugin/index.server.ts') && LANE_SPECIFIERS.has(specifier)) {
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

  const entry = await import(pathToFileURL(join(PLUGIN_DIR, 'index.server.ts')).href);
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
      'get-jev',
      'get-peer-pool',
      'get-role-routing',
      'get-supervision',
      'get-supervision-status',
      'get-work-tracker',
      'local-target',
      'reconcile',
      'set-jev',
      'set-jev-key',
      'set-language',
      'set-peer-pool',
      'set-role-routing',
      'set-supervision',
      'set-work-tracker',
      'status',
      'test-jev',
    ],
  );
  for (const { handler } of registrations) {
    assert.equal(typeof handler, 'function');
  }
  assert.deepEqual(
    beforeHooks.map(h => h.name).sort(),
    ['agent.create', 'agent.session_open'],
  );
  for (const { handler } of beforeHooks) {
    assert.equal(typeof handler, 'function');
  }
  // Shadow-observer lifecycle hooks (Phase B): synchronous capture only.
  assert.deepEqual(
    onHooks.map(h => h.name).sort(),
    ['agent.archived', 'agent.created', 'agent.turn_ended', 'agent.turn_started'],
  );
  for (const { handler } of onHooks) {
    assert.equal(typeof handler, 'function');
  }
  assert.equal(typeof cleanup, 'function');
  assert.doesNotThrow(() => cleanup());
  assert.deepEqual(
    unregistered.sort(),
    ['agent.archived', 'agent.create', 'agent.created', 'agent.session_open', 'agent.turn_ended', 'agent.turn_started'],
  );
  assert.doesNotThrow(() => cleanup(), 'cleanup must be idempotent');
});

test('contribute() leaves the shadow observer inert when the served home is only a default guess', async t => {
  const contribute = await importContribute(t);
  // No PASEO_HOME export → detectDaemonHome() answers source "default" and
  // the observer must stay null: a default-guessed home is never observed
  // (spec §Configuration — a prefill is not proof of host-home mapping).
  const prevHome = process.env.PASEO_HOME;
  delete process.env.PASEO_HOME;
  t.after(() => { if (prevHome !== undefined) process.env.PASEO_HOME = prevHome; });
  const onHooks = [];
  const server = {
    handle() {},
    before() { return () => {}; },
    on(name) { onHooks.push(name); return () => {}; },
  };
  const cleanup = contribute(server);
  assert.deepEqual(onHooks, [], 'no lifecycle hooks register without a verified served home');
  cleanup();
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
