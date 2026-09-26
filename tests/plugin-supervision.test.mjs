// tests/plugin-supervision.test.mjs — the configuration seam behind
// plugin/server/supervision/state.ts + plugin/shared/supervision.ts:
// private supervision.json (schema 2: daemon defaults for discovered Leads,
// explicit per-Lead routes, the shared confidence threshold) under the
// SERVED daemon home only, raw-file SHA-256 CAS (rechecked after awaited
// agent validation), exact Lead→Supervisor validation through a doubled
// Paseo SDK surface, schema-1 migration that never widens an earlier
// choice, pending verification when the host returns no snapshot, the
// served-home bell actions, and broken-file
// evidence semantics. No daemon, no network: PaseoLike is a structural
// double; the served home is injected like the real detectDaemonHome seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSupervisionState, supervisionPath } from '../plugin/server/supervision/state.ts';
import { effectiveRoute, normalizeSupervisionFile, notifyRecipients, withoutNotify } from '../plugin/shared/supervision.ts';
import { createJev } from '../plugin/server/jev.ts';
import { makeHome, targetOf } from './helpers/plugin-doubles.mjs';

const LEAD = '11111111-1111-4111-8111-111111111111';
const LEAD2 = '22222222-2222-4222-8222-222222222222';
const SUP = '33333333-3333-4333-8333-333333333333';
const SUP2 = '44444444-4444-4444-8444-444444444444';
const WKS = 'wks_testworkspace';

// A state instance bound to `home` as the daemon home the process serves —
// the production seam is detectDaemonHome() (PASEO_HOME export); tests
// inject it so the served-home gate is exercised, not bypassed.
const stateFor = home => createSupervisionState({ servedHome: () => ({ daemonHome: home, source: 'env' }) });
const fileOf = home => supervisionPath(join(home, 'slp-runtime'));

const DEFAULTS = { mode: 'off', supervisorAgentId: null, supervisorWorkspaceId: null, pendingDelayMs: 60000 };
const cfg = ({ routes = [], defaults = {}, confidenceThreshold = 0.9 } = {}) => ({
  schemaVersion: 3, confidenceThreshold, defaults: { ...DEFAULTS, ...defaults }, routes,
});
const get = (state, home) => state.getSupervision({ schemaVersion: 2, target: targetOf(home) });
// `routesOrConfig`: an array is shorthand for cfg({ routes }).
const set = (state, home, routesOrConfig, expectedSha256, paseo) =>
  state.setSupervision({
    schemaVersion: 2, target: targetOf(home),
    config: Array.isArray(routesOrConfig) ? cfg({ routes: routesOrConfig }) : routesOrConfig,
    expectedSha256,
  }, paseo);

const route = (over = {}) => ({
  leadAgentId: LEAD,
  leadWorkspaceId: WKS,
  supervisorAgentId: SUP,
  mode: 'shadow',
  pendingDelayMs: 60000,
  ...over,
});

// Structural PaseoLike double — refresh returns {agent} or {agent:null} and
// records which agent IDs were refreshed.
const makePaseo = agents => {
  const paseo = {
    calls: [],
    agents: {
      ref(id) {
        const refresh = async () => {
          paseo.calls.push(id);
          return { agent: agents[id] ?? null };
        };
        return { refresh };
      },
    },
  };
  return paseo;
};

const leadAgent = (over = {}) => ({
  id: LEAD, provider: 'slp-codex-lead', workspaceId: WKS, status: 'idle', archivedAt: null, ...over,
});
const supAgent = (over = {}) => ({
  id: SUP, provider: 'slp-codex-supervisor', workspaceId: WKS, status: 'idle', archivedAt: null, ...over,
});
const livePaseo = makePaseo({ [LEAD]: leadAgent(), [SUP]: supAgent(), [SUP2]: supAgent({ id: SUP2, workspaceId: 'wks_sup2' }) });

// ---------------------------------------------------------------------------
// Defaults and file semantics
// ---------------------------------------------------------------------------

test('absent file reads as unconfigured: defaults off, no routes, null sha, no error', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  const view = await get(state, home);
  assert.deepEqual(view, {
    schemaVersion: 2, config: cfg(), sha256: null, migration: null,
    observations: null, gates: null, diagnostics: null, unverified: [], error: null,
  });
  assert.equal(existsSync(fileOf(home)), false);
});

test('config round-trips through set/get with 0600 atomic writes and restart load', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  const stored = await set(state, home, cfg({ routes: [route()], confidenceThreshold: 0.8 }), null, livePaseo);
  assert.equal(lstatSync(fileOf(home)).mode & 0o777, 0o600);
  assert.equal(stored.error, null);
  assert.equal(stored.config.routes.length, 1);
  assert.equal(stored.config.confidenceThreshold, 0.8);
  assert.equal(typeof stored.sha256, 'string');
  assert.deepEqual(
    readdirSync(join(home, 'slp-runtime', 'state')).filter(name => name.endsWith('.tmp')),
    [],
  );
  assert.equal(JSON.parse(readFileSync(fileOf(home), 'utf8')).schemaVersion, 3, 'writes are always schema 3');
  const restarted = stateFor(home);
  const view = await get(restarted, home);
  assert.equal(view.error, null);
  assert.deepEqual(view.config, stored.config);
  assert.equal(view.sha256, stored.sha256);
});

test('invalid file is off with a visible error — config null, sha preserved for CAS', async t => {
  const home = makeHome(t);
  mkdirSync(dirname(fileOf(home)), { recursive: true });
  writeFileSync(fileOf(home), '{not json');
  const state = stateFor(home);
  const view = await get(state, home);
  assert.equal(view.config, null);
  assert.equal(typeof view.sha256, 'string');
  assert.match(view.error, /not valid JSON/);
  writeFileSync(fileOf(home), JSON.stringify({ schemaVersion: 3, routes: [] }));
  const mismatched = await get(state, home);
  assert.equal(mismatched.config, null);
  assert.match(mismatched.error, /schema validation/);
  writeFileSync(fileOf(home), JSON.stringify(cfg({ routes: [route(), route({ supervisorAgentId: null })] })));
  const dup = await get(state, home);
  assert.equal(dup.config, null);
  assert.match(dup.error, /duplicate leadAgentId/);
  // CAS still lets a stale-aware client overwrite the broken file.
  const repaired = await set(state, home, [route()], dup.sha256, livePaseo);
  assert.equal(repaired.error, null);
  assert.equal(repaired.config.routes.length, 1);
});

// ---------------------------------------------------------------------------
// Migration (schema 1 → 2)
// ---------------------------------------------------------------------------

test('migration: a schema-1 file reads with every route off and its previous modes listed', async t => {
  const home = makeHome(t);
  mkdirSync(dirname(fileOf(home)), { recursive: true });
  const legacy = { schemaVersion: 1, routes: [route({ mode: 'shadow' }), route({ leadAgentId: LEAD2, mode: 'notify' }), route({ leadAgentId: SUP2, mode: 'off', supervisorAgentId: null })] };
  writeFileSync(fileOf(home), JSON.stringify(legacy));
  const before = readFileSync(fileOf(home));
  const view = await get(stateFor(home), home);
  assert.equal(view.error, null);
  assert.deepEqual(view.config.routes.map(r => r.mode), ['off', 'off', 'off'], 'an upgrade never activates or widens a route');
  assert.equal(view.config.routes[1].supervisorAgentId, SUP, 'the recipient is kept for an explicit re-enable');
  assert.deepEqual(view.config.defaults, DEFAULTS);
  assert.deepEqual(view.migration, {
    fromSchemaVersion: 1,
    disabledRoutes: [{ leadAgentId: LEAD, previousMode: 'shadow' }, { leadAgentId: LEAD2, previousMode: 'notify' }],
    disabledDefaults: null,
  });
  assert.deepEqual(readFileSync(fileOf(home)), before, 'reading never rewrites the file');
  assert.equal(effectiveRoute(view.config, LEAD, null), null);
  // A save (with the file's CAS token) writes schema 3 and clears the migration.
  const saved = await set(stateFor(home), home, cfg({ routes: [route()] }), view.sha256, livePaseo);
  assert.equal(saved.migration, null);
  assert.equal(JSON.parse(readFileSync(fileOf(home), 'utf8')).schemaVersion, 3);
});

test('migration: a schema-2 file reads with every route AND the defaults off — new family coverage needs a re-save', async t => {
  // Schema 3 made Claude Code and Devin content transmissible; a schema-2
  // choice must never silently start sending it.
  const home = makeHome(t);
  mkdirSync(dirname(fileOf(home)), { recursive: true });
  const v2 = {
    schemaVersion: 2, confidenceThreshold: 0.8,
    defaults: { mode: 'notify', supervisorAgentId: SUP2, supervisorWorkspaceId: 'wks_sup2', pendingDelayMs: 5000 },
    routes: [route({ mode: 'shadow' }), route({ leadAgentId: LEAD2, mode: 'off', supervisorAgentId: null })],
  };
  writeFileSync(fileOf(home), JSON.stringify(v2));
  const before = readFileSync(fileOf(home));
  const view = await get(stateFor(home), home);
  assert.equal(view.error, null);
  assert.equal(view.config.schemaVersion, 3);
  assert.deepEqual([view.config.defaults.mode, ...view.config.routes.map(r => r.mode)], ['off', 'off', 'off']);
  assert.deepEqual([view.config.confidenceThreshold, view.config.defaults.supervisorAgentId, view.config.defaults.pendingDelayMs], [0.8, SUP2, 5000],
    'everything but the modes is kept for an explicit re-enable');
  assert.deepEqual(view.migration, {
    fromSchemaVersion: 2,
    disabledRoutes: [{ leadAgentId: LEAD, previousMode: 'shadow' }],
    disabledDefaults: { previousMode: 'notify' },
  });
  assert.deepEqual(readFileSync(fileOf(home), 'utf8'), before.toString(), 'reading never rewrites the file');
  assert.equal(effectiveRoute(view.config, LEAD, { workspaceId: WKS }), null);
  assert.equal(effectiveRoute(view.config, SUP, { workspaceId: WKS }), null, 'defaults observe nothing either');
  assert.deepEqual(notifyRecipients(view.config), [], 'no bell until the Human re-saves');
  // Disabling notifications on a migration view has nothing to reduce — no write.
  await stateFor(home).disableNotifications({ schemaVersion: 2 }, makePaseo({}));
  assert.deepEqual(readFileSync(fileOf(home), 'utf8'), before.toString());
});

test('effective route: explicit wins (off included); discovered Leads follow active defaults only', () => {
  const config = cfg({
    routes: [route({ mode: 'off' }), route({ leadAgentId: LEAD2, mode: 'notify' })],
    defaults: { mode: 'shadow', supervisorAgentId: SUP, supervisorWorkspaceId: WKS },
  });
  assert.equal(effectiveRoute(config, LEAD, { workspaceId: WKS }), null, 'explicit off wins over defaults');
  assert.equal(effectiveRoute(config, LEAD2, null), null, 'an explicit route waits for host evidence of its Lead');
  assert.equal(effectiveRoute(config, LEAD2, { workspaceId: 'wks_other' }), null, 'a Lead seen in another workspace does not match its route');
  assert.equal(effectiveRoute(config, LEAD2, { workspaceId: WKS }).source, 'route');
  const discovered = effectiveRoute(config, SUP2, { workspaceId: 'wks_x' });
  assert.deepEqual([discovered.source, discovered.mode, discovered.supervisorAgentId, discovered.leadWorkspaceId], ['default', 'shadow', SUP, 'wks_x']);
  assert.equal(effectiveRoute(config, SUP2, null), null, 'an undiscovered id never follows defaults');
  assert.equal(effectiveRoute(config, SUP, { workspaceId: WKS }), null, 'the default Supervisor is never its own Lead');
  assert.equal(effectiveRoute(cfg(), SUP2, { workspaceId: WKS }), null, 'defaults off observe nothing');
  assert.deepEqual(notifyRecipients(config), [{ agentId: SUP, workspaceId: WKS, source: 'route' }],
    'a route without a recorded Supervisor workspace falls back to its Lead workspace');
  assert.deepEqual(notifyRecipients(cfg({ routes: [route({ mode: 'notify', supervisorWorkspaceId: 'wks_sup' })] })),
    [{ agentId: SUP, workspaceId: 'wks_sup', source: 'route' }], 'the bell follows the Supervisor workspace');
  const off = withoutNotify(cfg({ routes: [route({ mode: 'notify' })], defaults: { mode: 'notify', supervisorAgentId: SUP, supervisorWorkspaceId: WKS } }));
  assert.deepEqual([off.defaults.mode, off.routes[0].mode], ['shadow', 'shadow'], 'disable keeps observing, delivers nothing');
  assert.equal(off.defaults.supervisorAgentId, SUP, 'the recipient is kept');
  assert.equal(normalizeSupervisionFile({ schemaVersion: 2 }).ok, false);
});

// ---------------------------------------------------------------------------
// CAS
// ---------------------------------------------------------------------------

test('set-supervision rejects a stale expectedSha256', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  await set(state, home, [route()], null, livePaseo);
  await assert.rejects(
    () => set(state, home, [], null, livePaseo),
    error => error.code === 'IDEMPOTENCY_CONFLICT' && /changed since/.test(error.message),
  );
  await assert.rejects(
    () => set(state, home, [], 'f'.repeat(64), livePaseo),
    error => error.code === 'IDEMPOTENCY_CONFLICT',
  );
  const current = await get(state, home);
  const cleared = await set(state, home, [], current.sha256, livePaseo);
  assert.equal(cleared.error, null);
  assert.deepEqual(cleared.config.routes, []);
});

// ---------------------------------------------------------------------------
// Served-home binding
// ---------------------------------------------------------------------------

test('supervision state binds to the served daemon home — mismatches refuse, never touch files', async t => {
  const served = makeHome(t);
  const other = makeHome(t);
  const state = stateFor(served);
  const view = await get(state, other);
  assert.equal(view.config, null);
  assert.match(view.error, /not the daemon home this plugin serves/);
  await assert.rejects(
    () => set(state, other, [], null, livePaseo),
    error => error.code === 'HOME_UNVERIFIED',
  );
  assert.equal(existsSync(fileOf(other)), false);
  const guessing = createSupervisionState({ servedHome: () => ({ daemonHome: served, source: 'default' }) });
  const gap = await get(guessing, served);
  assert.equal(gap.config, null);
  assert.match(gap.error, /host capability gap/);
  await assert.rejects(
    () => set(guessing, served, [], null, livePaseo),
    error => error.code === 'HOME_UNVERIFIED',
  );
  // The served-home actions refuse the same way.
  const status = await guessing.getStatus({ schemaVersion: 2 });
  assert.match(status.error, /host capability gap/);
  await assert.rejects(() => guessing.disableNotifications({ schemaVersion: 2 }, livePaseo), error => error.code === 'HOME_UNVERIFIED');
  assert.equal(existsSync(fileOf(served)), false);
});

// ---------------------------------------------------------------------------
// Validation through the doubled SDK
// ---------------------------------------------------------------------------

test('route validation requires exact provider roles, non-archived, active, matching workspace', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  const cases = [
    ['Lead provider is a peer', { [LEAD]: leadAgent({ provider: 'slp-codex-peer' }), [SUP]: supAgent() }, /exact slp-<family>-lead/],
    ['Lead provider is not SLP', { [LEAD]: leadAgent({ provider: 'claude' }), [SUP]: supAgent() }, /exact slp-<family>-lead/],
    ['Lead archived', { [LEAD]: leadAgent({ archivedAt: '2026-09-20T00:00:00Z' }), [SUP]: supAgent() }, /archived/],
    ['Lead closed', { [LEAD]: leadAgent({ status: 'closed' }), [SUP]: supAgent() }, /closed/],
    ['Lead workspace mismatch', { [LEAD]: leadAgent({ workspaceId: 'wks_other' }), [SUP]: supAgent() }, /workspace/],
    ['Supervisor provider is a lead', { [LEAD]: leadAgent(), [SUP]: supAgent({ provider: 'slp-pi-lead' }) }, /exact slp-<family>-supervisor/],
    ['Supervisor archived', { [LEAD]: leadAgent(), [SUP]: supAgent({ archivedAt: 'x' }) }, /archived/],
    ['Supervisor closed', { [LEAD]: leadAgent(), [SUP]: supAgent({ status: 'closed' }) }, /active agent/],
    ['Supervisor errored', { [LEAD]: leadAgent(), [SUP]: supAgent({ status: 'error' }) }, /active agent/],
  ];
  for (const [name, agents, pattern] of cases) {
    await assert.rejects(
      () => set(state, home, [route()], null, makePaseo(agents)),
      error => error.code === 'INVALID_REQUEST' && pattern.test(error.message),
      name,
    );
    assert.equal(existsSync(fileOf(home)), false, name);
  }
});

test('defaults: an active exact Supervisor is required and its workspace is server-derived', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  // A client-supplied workspace is ignored — the refreshed agent decides.
  const stored = await set(state, home, cfg({ defaults: { mode: 'notify', supervisorAgentId: SUP2, supervisorWorkspaceId: null } }), null, livePaseo);
  assert.equal(stored.config.defaults.supervisorWorkspaceId, 'wks_sup2');
  await assert.rejects(
    () => set(state, home, cfg({ defaults: { mode: 'shadow', supervisorAgentId: LEAD } }), stored.sha256, livePaseo),
    error => error.code === 'INVALID_REQUEST' && /exact slp-<family>-supervisor/.test(error.message),
  );
  // Default notify without a recipient fails the schema.
  await assert.rejects(
    () => set(state, home, cfg({ defaults: { mode: 'notify' } }), stored.sha256, livePaseo),
    /invalid set-supervision input/,
  );
  // Defaults off with the SAME recipient keep its recorded workspace without
  // a liveness check (a departed Supervisor does not block unrelated edits).
  const parked = await set(state, home, cfg({ defaults: { mode: 'off', supervisorAgentId: SUP2 } }), stored.sha256, makePaseo({}));
  assert.equal(parked.config.defaults.supervisorWorkspaceId, 'wks_sup2');
});

test('threshold is bounded 0.5–1 by the schema', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  for (const bad of [0.49, 1.01]) {
    await assert.rejects(() => set(state, home, cfg({ confidenceThreshold: bad }), null, livePaseo), /invalid set-supervision input/);
  }
  const ok = await set(state, home, cfg({ confidenceThreshold: 0.5 }), null, livePaseo);
  assert.equal(ok.config.confidenceThreshold, 0.5);
});

test('duplicate leadAgentId is rejected at write', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  await assert.rejects(
    () => set(state, home, [route(), route({ supervisorAgentId: null, leadAgentId: LEAD })], null, livePaseo),
    error => error.code === 'INVALID_REQUEST' && /duplicate leadAgentId/.test(error.message),
  );
  const paseo = makePaseo({ [LEAD]: leadAgent(), [LEAD2]: leadAgent({ id: LEAD2 }), [SUP]: supAgent() });
  const stored = await set(state, home, [route(), route({ leadAgentId: LEAD2, supervisorAgentId: null })], null, paseo);
  assert.equal(stored.config.routes.length, 2);
});

test('off routes skip liveness validation; notify requires and validates a Supervisor', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  const parked = await set(state, home, [route({ mode: 'off' })], null, makePaseo({}));
  assert.equal(parked.error, null);
  assert.equal(parked.config.routes[0].mode, 'off');
  const notify = await set(state, home, [route({ mode: 'notify' })], parked.sha256, livePaseo);
  assert.equal(notify.config.routes[0].mode, 'notify');
  await assert.rejects(
    () => set(state, home, [route({ mode: 'notify', supervisorAgentId: null })], notify.sha256, livePaseo),
    /invalid set-supervision input/,
  );
});

test('schema rejects malformed routes before any validation or write', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  const cases = [
    ['bad lead id', route({ leadAgentId: 'not-a-uuid' })],
    ['missing workspace', route({ leadWorkspaceId: '' })],
    ['self-supervision', route({ supervisorAgentId: LEAD })],
    ['unknown mode', route({ mode: 'loud' })],
    ['unknown key', { ...route(), extra: 1 }],
    ['negative delay', route({ pendingDelayMs: -1 })],
    ['unbounded delay', route({ pendingDelayMs: 86400001 })],
  ];
  for (const [name, bad] of cases) {
    await assert.rejects(() => set(state, home, [bad], null, livePaseo), /invalid set-supervision input/, name);
  }
  assert.equal(existsSync(fileOf(home)), false);
});

test('a second writer landing during agent validation is caught by the recheck', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slowPaseo = {
    agents: {
      ref: id => ({
        refresh: async () => { await gate; return { agent: { [LEAD]: leadAgent(), [SUP]: supAgent() }[id] ?? null }; },
      }),
    },
  };
  const pending = set(state, home, [route()], null, slowPaseo);
  await new Promise(resolve => setImmediate(resolve));
  const winner = await set(state, home, [route({ supervisorAgentId: null })], null, livePaseo);
  release();
  await assert.rejects(() => pending, error => error.code === 'IDEMPOTENCY_CONFLICT');
  const view = await get(state, home);
  assert.equal(view.sha256, winner.sha256);
});

// ---------------------------------------------------------------------------
// Served-home actions (header bell)
// ---------------------------------------------------------------------------

test('no host snapshot is pending verification, not a rejection; a returned snapshot is still checked', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  // The refresh returns nothing for the Lead and throws for the Supervisor
  // (live: "Agent not found" for a live slp Lead) — the save lands, both are
  // listed unverified, and the picker's Supervisor workspace is kept.
  const throwing = {
    agents: {
      ref: id => ({
        refresh: async () => {
          if (id === SUP) throw new Error('Agent not found: ' + id);
          return { agent: null };
        },
      }),
    },
  };
  const saved = await set(state, home, [route({ mode: 'notify', supervisorWorkspaceId: 'wks_picker' })], null, throwing);
  assert.equal(saved.error, null);
  assert.deepEqual(saved.unverified.map(item => [item.agentId, item.role]), [[LEAD, 'lead'], [SUP, 'supervisor']]);
  assert.match(saved.unverified[1].reason, /Agent not found/);
  assert.equal(saved.config.routes[0].supervisorWorkspaceId, 'wks_picker');
  assert.deepEqual((await get(state, home)).unverified, [], 'get never reports a previous save');
  // A route Supervisor in another workspace is fine; its own workspace is
  // server-derived and places the bell.
  const moved = await set(state, home, [route({ mode: 'notify', supervisorAgentId: SUP2, supervisorWorkspaceId: 'wks_client_guess' })], saved.sha256, livePaseo);
  assert.deepEqual(moved.unverified, []);
  assert.equal(moved.config.routes[0].supervisorWorkspaceId, 'wks_sup2');
  assert.deepEqual((await state.getStatus({ schemaVersion: 2 })).recipients, [{ agentId: SUP2, workspaceId: 'wks_sup2', source: 'route' }]);
  // Unverified default Supervisor keeps the client workspace.
  const defaults = await set(state, home, cfg({ defaults: { mode: 'notify', supervisorAgentId: SUP, supervisorWorkspaceId: 'wks_picker' } }), moved.sha256, throwing);
  assert.equal(defaults.config.defaults.supervisorWorkspaceId, 'wks_picker');
  assert.deepEqual(defaults.unverified.map(item => item.role), ['supervisor']);
});

test('status lists notify recipients with their bell workspace; disable turns notify into shadow', async t => {
  const home = makeHome(t);
  const state = stateFor(home);
  await set(state, home, cfg({
    routes: [route({ mode: 'notify' })],
    defaults: { mode: 'notify', supervisorAgentId: SUP2 },
  }), null, livePaseo);
  const status = await state.getStatus({ schemaVersion: 2 });
  assert.deepEqual(status.recipients.map(r => [r.agentId, r.workspaceId, r.source]).sort(), [
    [SUP, WKS, 'route'], [SUP2, 'wks_sup2', 'default'],
  ].sort());
  // Disabling succeeds even when a routed Lead is gone (no re-validation of
  // a pure reduction) and keeps every recipient.
  const disabled = await state.disableNotifications({ schemaVersion: 2 }, makePaseo({}));
  assert.deepEqual(disabled.recipients, []);
  const view = await get(state, home);
  assert.deepEqual([view.config.defaults.mode, view.config.routes[0].mode], ['shadow', 'shadow']);
  assert.equal(view.config.defaults.supervisorAgentId, SUP2);
  // Nothing to disable → no write.
  const sha = view.sha256;
  await state.disableNotifications({ schemaVersion: 2 }, makePaseo({}));
  assert.equal((await get(state, home)).sha256, sha);
});

// ---------------------------------------------------------------------------
// Jev CAS seam (spec: get-jev/set-jev carry a raw-file hash before the
// capability toggle so a stale save cannot overwrite another client's
// supervision choice)
// ---------------------------------------------------------------------------

test('set-jev requires the raw-file CAS token and preserves unrelated capability keys', async t => {
  const home = makeHome(t);
  const jev = createJev();
  const base = {
    schemaVersion: 1, enabled: true, capabilities: { routing: true },
    provider: { kind: 'openrouter', baseUrl: 'https://openrouter.ai', model: 'typesafe/jev-1.13' },
  };
  const first = await jev.setJev({ schemaVersion: 1, target: targetOf(home), jev: base, expectedSha256: null });
  assert.equal(typeof first.jev.sha256, 'string');
  // A stale save is refused rather than overwriting.
  await assert.rejects(
    () => jev.setJev({
      schemaVersion: 1, target: targetOf(home),
      jev: { ...base, capabilities: { routing: true, supervision: true } },
      expectedSha256: null,
    }),
    error => error.code === 'IDEMPOTENCY_CONFLICT',
  );
  // A fresh-token save stores every key verbatim — the catchall record
  // carries capabilities this client does not own.
  const second = await jev.setJev({
    schemaVersion: 1, target: targetOf(home),
    jev: { ...base, capabilities: { routing: true, supervision: true } },
    expectedSha256: first.jev.sha256,
  });
  assert.deepEqual(second.jev.capabilities, { routing: true, supervision: true });
  // The stored file keeps them too.
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, 'slp-runtime', 'state', 'jev.json'), 'utf8')).capabilities,
    { routing: true, supervision: true },
  );
});

// ---------------------------------------------------------------------------
// Fixture sanity — the sanitized family fixtures stay loadable and shaped
// like the host evidence they were taken from.
// ---------------------------------------------------------------------------

test('sanitized provider fixtures parse and carry send_agent_prompt evidence', async t => {
  const dir = new URL('./fixtures/supervision/', import.meta.url).pathname;
  const families = ['codex', 'devin', 'pi', 'claude'];
  for (const family of families) {
    const fixture = JSON.parse(readFileSync(join(dir, `${family}.send-agent-prompt.json`), 'utf8'));
    assert.equal(typeof fixture, 'object', family);
    // Every fixture names the tool and shows where the record came from —
    // no credentials or real agent content may appear (fixtures are
    // sanitized: synthetic ids only).
    assert.match(JSON.stringify(fixture), /send_agent_prompt/, family);
    assert.doesNotMatch(JSON.stringify(fixture), /sk-[a-zA-Z0-9_-]{10}|sk-or-|ya29\.|ghp_/, family);
  }
});
