// tests/plugin-enforcement.test.mjs — P0 enforcement desk coverage:
// wire/view schemas, the closed seat-binding transition vocabulary,
// toolPolicy preapproval merge semantics, the capability audit's
// unknown-by-default floor and per-family probe rows, and the read-only
// readView/dispatch seam under the capability-rows-only contract —
// provider projection is the P1 backlog (gap `providerTools-projection`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  CapabilityRecord,
  CapabilityGap,
  SeatBindingState,
  SeatBindingView,
  BINDING_TRANSITIONS,
  canTransitionSeatBinding,
  ToolPolicy,
  TOOL_POLICY_MAX_PREAPPROVED,
  mergeToolPolicyPreapprovals,
  DeskRejection,
  GetEnforcementStatusInput,
  GetEnforcementStatusOutput,
  CompletenessCollection,
  CompletenessEntry,
  CompletenessEntriesSchema,
  CompletenessReason,
  WIRE_LIMITS,
} from '../plugin/shared/enforcement.ts';
import { auditCapabilities, CAPABILITY_IDS, PASEO_SOURCE_REVISION, PROVIDER_TOOLS_PROJECTION_GAP } from '../plugin/server/capabilities.ts';
import { createEnforcement, boundStatusView, P0_STATIC_LIMITATIONS } from '../plugin/server/enforcement.ts';
import {
  LIMITATION_TABLE,
  limitation,
  renderSkippedLedgers,
  renderRevoked,
} from '../plugin/server/limitations.ts';
import { createDeskStore, repoKeyFor, REVOKE_REASONS } from '../plugin/server/desk-store.ts';
import { emptyReceipt } from '../plugin/server/journal.ts';
import { readRawConfig } from '../plugin/server/config-view.ts';
import { MAX_RPC_BYTES, OperationConflict } from '../plugin/shared/contracts.ts';
import { FetchAgentsResponseMessageSchema } from '@getpaseo/protocol/messages';
import { FAMILY_IDS } from '../plugin/shared/families.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function tmp(t, prefix = 'enf-') {
  // §7 hermetic rule: fixtures live under the OS tmpdir — the repo tree and
  // .local-checks are never written by tests.
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const NOW = '2026-01-01T00:00:00.000Z';
const target = home => ({ hostId: 'test', daemonHome: home });

// ---------------------------------------------------------------------------
// Wire/view schemas
// ---------------------------------------------------------------------------

test('CapabilityRecord round-trips and stays strict', () => {
  const record = {
    schemaVersion: 1,
    capabilityId: 'probe.session-open-env-to-mcp-child',
    family: 'codex',
    probeId: 'a',
    status: 'unknown',
    source: 'paseo-src',
    sourceRef: `paseo@${PASEO_SOURCE_REVISION}:x.ts`,
    evidenceKind: 'source-static-compat',
    evidenceRef: 'static',
    observedAt: null,
    limitations: ['none'],
  };
  assert.deepEqual(CapabilityRecord.parse(record), record);
  assert.throws(() => CapabilityRecord.parse({ ...record, bogus: 1 }));
  assert.throws(() => CapabilityRecord.parse({ ...record, status: 'enforced' }));
  assert.throws(() => CapabilityRecord.parse({ ...record, probeId: 'e' }));
  assert.throws(() => CapabilityRecord.parse({ ...record, family: 'gemini' }));
});

test('CapabilityGap requires the missing primitive, never a workaround', () => {
  const gap = {
    capabilityId: 'probe.session-open-env-to-mcp-child',
    family: 'pi',
    missingPrimitive: 'a host surface reporting MCP child env',
    neededBy: 'probe (a)',
    ownerAction: 'Lead creates a probe seat',
  };
  assert.deepEqual(CapabilityGap.parse(gap), gap);
  assert.throws(() => CapabilityGap.parse({ ...gap, missingPrimitive: '' }));
  assert.throws(() => CapabilityGap.parse({ ...gap, extra: 'x' }));
});

// ---------------------------------------------------------------------------
// Seat-binding transition vocabulary
// ---------------------------------------------------------------------------

test('BINDING_TRANSITIONS enumerates every state and only the permitted edges', () => {
  const states = SeatBindingState.options;
  assert.deepEqual(Object.keys(BINDING_TRANSITIONS).sort(), [...states].sort());
  // Exhaustive (from, to) enumeration — no silent edge exists outside the map.
  for (const from of states) {
    for (const to of states) {
      const expected = BINDING_TRANSITIONS[from].includes(to);
      assert.equal(canTransitionSeatBinding(from, to), expected, `${from} -> ${to}`);
      // No self-transitions: a state only changes across a real edge.
      if (from === to) assert.equal(expected, false, `self-loop ${from}`);
    }
  }
  // revoked is terminal and reachable from every live state.
  assert.deepEqual(BINDING_TRANSITIONS.revoked, []);
  for (const from of states.filter(s => s !== 'revoked')) {
    assert.ok(canTransitionSeatBinding(from, 'revoked'), `${from} must reach revoked`);
  }
  // The intended handshake chain.
  for (const [from, to] of [
    ['unbound-open', 'host-confirmed'],
    ['host-confirmed', 'attached'],
    ['attached', 'active'],
    ['active', 'revoked'],
  ]) {
    assert.ok(canTransitionSeatBinding(from, to), `${from} -> ${to}`);
  }
  assert.equal(canTransitionSeatBinding('unbound-open', 'active'), false);
  assert.equal(canTransitionSeatBinding('active', 'host-confirmed'), false);
});

// ---------------------------------------------------------------------------
// toolPolicy — preapproval merge
// ---------------------------------------------------------------------------

const grant = (server, tool) => ({ kind: 'mcp', server, tool });

test('ToolPolicy is preapproval-only; a denied field fails strict parsing', () => {
  assert.deepEqual(
    ToolPolicy.parse({ preapproved: [grant('s', 't')] }),
    { preapproved: [grant('s', 't')] },
  );
  assert.throws(() => ToolPolicy.parse({ preapproved: [], denied: [] }));
  assert.throws(() => ToolPolicy.parse({ preapproved: [{ kind: 'shell', server: 's', tool: 't' }] }));
});

test('mergeToolPolicyPreapprovals preserves order and dedupes exact (server, tool) pairs', () => {
  const existing = { preapproved: [grant('a', 'x'), grant('b', 'y')] };
  const result = mergeToolPolicyPreapprovals(existing, [
    grant('a', 'x'),          // duplicate
    grant('c', 'z'),          // new
    grant('a', 'y'),          // same server, different tool — new
    grant('c', 'z'),          // duplicate within the addition batch
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.toolPolicy.preapproved, [
    grant('a', 'x'), grant('b', 'y'), grant('c', 'z'), grant('a', 'y'),
  ]);
  assert.deepEqual(result.added, [grant('c', 'z'), grant('a', 'y')]);
  assert.deepEqual(result.duplicates, [grant('a', 'x'), grant('c', 'z')]);
  // The merged value itself stays wire-valid.
  assert.deepEqual(ToolPolicy.parse(result.toolPolicy), result.toolPolicy);
  // No mutation of the input value.
  assert.deepEqual(existing, { preapproved: [grant('a', 'x'), grant('b', 'y')] });
});

test('mergeToolPolicyPreapprovals treats same-name tools under different servers as distinct grants', () => {
  const result = mergeToolPolicyPreapprovals(null, [grant('s1', 'read'), grant('s2', 'read')]);
  assert.equal(result.ok, true);
  assert.equal(result.toolPolicy.preapproved.length, 2);
  assert.equal(result.added.length, 2);
});

test('mergeToolPolicyPreapprovals rejects an unparseable existing policy rather than replacing it', () => {
  assert.throws(() => mergeToolPolicyPreapprovals({ preapproved: [{ kind: 'mcp', server: '' }] }, []));
  assert.throws(() => mergeToolPolicyPreapprovals({ denied: [] }, []));
});

test('mergeToolPolicyPreapprovals fails closed at the 1024 bound — never an invalid policy', () => {
  const grants = n => Array.from({ length: n }, (_, i) => grant('s', `t${i}`));
  // Exactly at the bound: a valid, ok merge.
  const atBound = mergeToolPolicyPreapprovals(
    { preapproved: grants(TOOL_POLICY_MAX_PREAPPROVED - 1) },
    [grant('s', `t${TOOL_POLICY_MAX_PREAPPROVED - 1}`)],
  );
  assert.equal(atBound.ok, true);
  assert.equal(atBound.toolPolicy.preapproved.length, TOOL_POLICY_MAX_PREAPPROVED);
  assert.deepEqual(ToolPolicy.parse(atBound.toolPolicy), atBound.toolPolicy);
  // One grant over the bound: typed rejection, no merged policy, nothing applied.
  const over = mergeToolPolicyPreapprovals(
    { preapproved: grants(TOOL_POLICY_MAX_PREAPPROVED) },
    [grant('s', 'one-more')],
  );
  assert.equal(over.ok, false);
  assert.equal(over.code, 'INVALID_RECORD');
  assert.equal('toolPolicy' in over, false);
  assert.deepEqual(DeskRejection.parse(over), over);
  // Duplicates still dedupe before the bound — a pure-duplicate batch is a no-op, not a rejection.
  const noop = mergeToolPolicyPreapprovals(
    { preapproved: grants(TOOL_POLICY_MAX_PREAPPROVED) },
    [grant('s', 't0')],
  );
  assert.equal(noop.ok, true);
  assert.equal(noop.added.length, 0);
});

// ---------------------------------------------------------------------------
// Capability audit — unknown floor, per-family probe rows, live observation
// ---------------------------------------------------------------------------

const silentHost = { rpcDispatched: false, providersSnapshot: null, agentsList: null };

test('auditCapabilities emits per-family rows for all four families plus host-wide rows', () => {
  const { records, gaps } = auditCapabilities({ now: NOW, observed: silentHost });
  for (const family of FAMILY_IDS) {
    const familyRows = records.filter(r => r.family === family);
    assert.equal(familyRows.length, 6, `${family} rows`);
    // Every mandated probe (a)-(d) has exactly one record per family.
    for (const probeId of ['a', 'b', 'c', 'd']) {
      const probeRows = familyRows.filter(r => r.probeId === probeId);
      assert.equal(probeRows.length, 1, `${family} probe ${probeId}`);
      // Probe rows can never claim support from static evidence alone.
      assert.equal(probeRows[0].status, 'unknown', `${family} probe ${probeId} status`);
      assert.equal(probeRows[0].evidenceKind, 'source-static-compat');
    }
    // …and one matching BLOCKED gap per probe per family.
    for (const probeId of ['a', 'b', 'c', 'd']) {
      const cap = { a: 'probe.session-open-env-to-mcp-child', b: 'probe.create-mcp-env-to-mcp-child', c: 'probe.create-env-to-session-open-request', d: 'probe.mcp-servers-resume-persistence' }[probeId];
      const familyGaps = gaps.filter(g => g.family === family && g.capabilityId === cap);
      assert.equal(familyGaps.length, 1, `${family} gap for ${cap}`);
      assert.ok(familyGaps[0].missingPrimitive.length > 0);
      assert.ok(familyGaps[0].ownerAction.length > 0);
    }
  }
  // The mandatory providerTools-projection gap leads — a wire cap can never
  // shed it behind the family probe gaps.
  assert.deepEqual(gaps[0], PROVIDER_TOOLS_PROJECTION_GAP);
  // Every emitted record and gap parses through the wire schema.
  for (const r of records) assert.deepEqual(CapabilityRecord.parse(r), r);
  for (const g of gaps) assert.deepEqual(CapabilityGap.parse(g), g);
});

test('the mandatory providerTools-projection gap carries the pinned permanent-gap semantics', () => {
  const { gaps } = auditCapabilities({ now: NOW, observed: silentHost });
  const row = gaps.filter(g => g.capabilityId === 'providerTools-projection');
  assert.equal(row.length, 1, 'exactly one mandatory gap');
  assert.deepEqual(row[0], {
    capabilityId: 'providerTools-projection',
    family: null,
    missingPrimitive: 'host lacks an introspection surface for effective tool policy (F10)',
    neededBy: 'upstream-host (F10 permanent gap)',
    ownerAction: 'Human: raise a Paseo core request for effective tool-policy introspection; SLP ships no projection',
  });
});

test('auditCapabilities keeps the unknown floor without live observation', () => {
  const { records } = auditCapabilities({ now: NOW, observed: silentHost });
  const byId = id => records.filter(r => r.capabilityId === id);
  // Live-dependent rows never invent support.
  assert.equal(byId(CAPABILITY_IDS.pluginRpcDispatch)[0].status, 'unknown');
  assert.equal(byId(CAPABILITY_IDS.providersSnapshot)[0].status, 'unknown');
  assert.equal(byId(CAPABILITY_IDS.agentsList)[0].status, 'unknown');
  // Verified absences are unsupported — negative evidence, not a guess.
  for (const id of ['createCallerPrincipal', 'createAgentId', 'serverInfoAccessor', 'deskLedger']) {
    assert.equal(byId(CAPABILITY_IDS[id])[0].status, 'unsupported', id);
  }
  // Static plumbing facts can be supported.
  assert.equal(byId(CAPABILITY_IDS.hookAgentCreate)[0].status, 'supported');
  assert.equal(byId(CAPABILITY_IDS.mcpRecordPersistence)[0].status, 'supported');
});

test('auditCapabilities upgrades rows only on supplied live observation', () => {
  const { records } = auditCapabilities({
    now: NOW,
    observed: { rpcDispatched: true, providersSnapshot: true, agentsList: true },
  });
  const byId = id => records.filter(r => r.capabilityId === id)[0];
  assert.equal(byId(CAPABILITY_IDS.pluginRpcDispatch).status, 'supported');
  assert.equal(byId(CAPABILITY_IDS.pluginRpcDispatch).evidenceKind, 'host-observation');
  assert.equal(byId(CAPABILITY_IDS.providersSnapshot).status, 'supported');
  assert.equal(byId(CAPABILITY_IDS.agentsList).status, 'supported');
  // An answered-and-rejected surface is unsupported, not unknown.
  const rejected = auditCapabilities({
    now: NOW,
    observed: { rpcDispatched: true, providersSnapshot: false, agentsList: null },
  });
  const byId2 = id => rejected.records.filter(r => r.capabilityId === id)[0];
  assert.equal(byId2(CAPABILITY_IDS.providersSnapshot).status, 'unsupported');
  assert.equal(byId2(CAPABILITY_IDS.agentsList).status, 'unknown');
});

test('exact MCP preapproval follows the registry contract per family', () => {
  const { records } = auditCapabilities({ now: NOW, observed: silentHost });
  const status = family =>
    records.find(r => r.family === family && r.capabilityId === CAPABILITY_IDS.toolPolicyPreapproval).status;
  assert.equal(status('codex'), 'supported');
  assert.equal(status('claude'), 'supported');
  assert.equal(status('pi'), 'unsupported');
  assert.equal(status('devin'), 'unsupported');
});

test('every one of the 18 observation tuples yields the exact pinned inventory', () => {
  // The closed observation domain (spec §2.1): rpcDispatched {false,true} ×
  // providersSnapshot {null,false,true} × agentsList {null,false,true}.
  const HOST_IDS = [
    'hook.agent.create', 'hook.agent.session-open', 'hook.workspace.create',
    'create.caller-principal', 'create.agent-id', 'parent-agent-id.label',
    'plugin-rpc.dispatch', 'host.providers-snapshot', 'host.agents-list',
    'host.server-info-accessor', 'paseo-tools.disabled-tools',
    'model-resolution.introspection', 'mcp-servers.agent-record-persistence',
    'enforcement.desk-ledger',
  ];
  const FAMILY_ROW_IDS = [
    'tool-policy.mcp-preapproval', 'mcp-servers.stdio-launch',
    'probe.session-open-env-to-mcp-child', 'probe.create-mcp-env-to-mcp-child',
    'probe.create-env-to-session-open-request', 'probe.mcp-servers-resume-persistence',
  ];
  const FAMILY_GAP_IDS = FAMILY_ROW_IDS.filter(id => id.startsWith('probe.'));
  const tuples = [];
  for (const rpcDispatched of [false, true])
    for (const providersSnapshot of [null, false, true])
      for (const agentsList of [null, false, true])
        tuples.push({ rpcDispatched, providersSnapshot, agentsList });
  assert.equal(tuples.length, 18);
  for (const observed of tuples) {
    const label = JSON.stringify(observed);
    const { records, gaps } = auditCapabilities({ now: NOW, observed });
    assert.equal(records.length, 38, `records ${label}`);
    assert.equal(gaps.length, 17, `gaps ${label}`);
    // Exact id/family inventory — a new row or family without a pin raise
    // must fail here, never be shed by the wire cap.
    assert.deepEqual(
      new Set(records.filter(r => r.family === null).map(r => r.capabilityId)),
      new Set(HOST_IDS),
      `host ids ${label}`,
    );
    for (const family of FAMILY_IDS) {
      assert.deepEqual(
        new Set(records.filter(r => r.family === family).map(r => r.capabilityId)),
        new Set(FAMILY_ROW_IDS),
        `${family} ids ${label}`,
      );
      assert.deepEqual(
        new Set(gaps.filter(g => g.family === family).map(g => g.capabilityId)),
        new Set(FAMILY_GAP_IDS),
        `${family} gaps ${label}`,
      );
    }
    assert.deepEqual(
      gaps.filter(g => g.family === null).map(g => g.capabilityId),
      ['providerTools-projection'],
      `mandatory gap ${label}`,
    );
    // Production domain fits the pins with room for nothing else — the
    // producer must never shed a row.
    assert.ok(records.length <= WIRE_LIMITS.capabilities);
    assert.ok(gaps.length <= WIRE_LIMITS.gaps);
    for (const r of records) assert.deepEqual(CapabilityRecord.parse(r), r);
    for (const g of gaps) assert.deepEqual(CapabilityGap.parse(g), g);
  }
});

test('auditCapabilities fails closed when the registry is ahead of fact curation', () => {
  // Simulates a family added to plugin/shared/families.ts without a matching
  // FAMILY_FACTS entry: the audit must not crash on an undefined lookup, must
  // not fabricate evidence, and must emit a typed gap per fact-dependent row.
  const { records, gaps } = auditCapabilities({ now: NOW, observed: silentHost, familyFacts: {} });
  for (const family of FAMILY_IDS) {
    for (const [cap, probeId] of [
      [CAPABILITY_IDS.toolPolicyPreapproval, null],
      [CAPABILITY_IDS.mcpStdioLaunch, null],
      [CAPABILITY_IDS.probeCreateMcpEnv, 'b'],
      [CAPABILITY_IDS.probeMcpResume, 'd'],
    ]) {
      const row = records.find(r => r.family === family && r.capabilityId === cap);
      assert.ok(row, `${family}/${cap} row still emitted`);
      assert.equal(row.status, 'unknown', `${family}/${cap} fails closed to unknown`);
      assert.equal(row.evidenceKind, 'none');
      assert.equal(row.probeId, probeId);
      const g = gaps.find(x => x.family === family && x.capabilityId === cap);
      assert.ok(g, `${family}/${cap} emits a typed gap`);
      assert.match(g.missingPrimitive, /FAMILY_FACTS/);
      assert.ok(g.ownerAction.length > 0);
    }
    // Fact-free probe rows keep their normal blocked evidence.
    for (const cap of [CAPABILITY_IDS.probeSessionOpenEnv, CAPABILITY_IDS.probeCreateEnvEcho]) {
      const row = records.find(r => r.family === family && r.capabilityId === cap);
      assert.equal(row.status, 'unknown', `${family}/${cap}`);
      assert.equal(row.evidenceKind, 'source-static-compat');
    }
  }
  // Everything emitted still parses on the wire.
  for (const r of records) assert.deepEqual(CapabilityRecord.parse(r), r);
  for (const g of gaps) assert.deepEqual(CapabilityGap.parse(g), g);
});

test('a curated fact that breaks the wire schema fails closed as IO_FAILURE, never a bare ZodError', () => {
  // familyFacts is the curation seam: an over-bound sourceRef makes record()
  // throw ZodError inside the audit — the boundary converts it to the typed
  // conflict the contract requires (§2.1 A2-S1). Production constants are
  // untouched.
  const badFacts = {
    codex: {
      exactPreapproval: true,
      mcpLaunchRef: 'x'.repeat(WIRE_LIMITS.sourceRef + 1),
      mcpLaunchEvidence: 'injected',
      resumeEvidence: 'injected',
      resumeLimitation: null,
    },
  };
  assert.throws(
    () => auditCapabilities({ now: NOW, observed: silentHost, familyFacts: badFacts }),
    error => error instanceof OperationConflict && error.code === 'IO_FAILURE',
  );
  // Non-ZodError failures propagate unchanged — only schema violations are
  // converted at the boundary.
  const boom = new TypeError('synthetic');
  const sabotage = {
    get codex() { throw boom; },
  };
  assert.throws(
    () => auditCapabilities({ now: NOW, observed: silentHost, familyFacts: sabotage }),
    error => error === boom,
  );
});

// ---------------------------------------------------------------------------
// readView / dispatch — the read-only desk seam under the provenance gate
// ---------------------------------------------------------------------------

function fixtureHome(t) {
  const dir = tmp(t);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return home;
}

/** Receipt/host evidence may attach only when PASEO_HOME exports THIS daemon's
 *  served home and the target realpath matches it (spec §2.1 decision row). */
function serveHome(t, home) {
  const prev = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prev;
  });
}

function unserveHome(t) {
  const prev = process.env.PASEO_HOME;
  delete process.env.PASEO_HOME;
  t.after(() => { if (prev !== undefined) process.env.PASEO_HOME = prev; });
}

const stubJournal = receipt => ({ read: () => receipt });
const countingJournal = calls => ({ read: () => { calls.count++; return null; } });

// Every agents.list mock below is generated from the pinned oracle —
// DaemonClient would reject an invalid payload before it reached the plugin,
// so a test double must never fabricate a shape the oracle refuses.
const AgentsListPayload = FetchAgentsResponseMessageSchema.shape.payload;

const agentsEntry = () => ({
  agent: {
    id: 'a1', provider: 'codex', cwd: '/tmp', model: 'm',
    createdAt: NOW, updatedAt: NOW, lastUserMessageAt: null,
    status: 'idle',
    capabilities: {
      supportsStreaming: false, supportsSessionPersistence: false,
      supportsDynamicModes: false, supportsMcpServers: false,
      supportsReasoningStream: false, supportsToolInvocations: false,
    },
    currentModeId: null, availableModes: [], pendingPermissions: [],
    persistence: null, title: null,
    runtimeInfo: { provider: 'codex', sessionId: 's1', model: 'm-eff' },
  },
  project: {
    projectKey: 'k', projectName: 'p',
    checkout: { isGit: false, cwd: '/tmp', currentBranch: null, remoteUrl: null, forge: null, isPaseoOwnedWorktree: false, mainRepoRoot: null },
  },
});

function agentsListMock(payload) {
  const parsed = AgentsListPayload.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`test fixture rejected by the pinned oracle: ${parsed.error.issues[0]?.message}`);
  }
  return async () => payload;
}

const agentsListOk = () => agentsListMock({
  requestId: 'r1',
  entries: [agentsEntry()],
  pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
});

const capRow = (view, id) => view.capabilities.find(r => r.capabilityId === id);
const omitted = (view, collection, reason) =>
  view.completeness.find(e => e.collection === collection && e.reason === reason)?.count ?? 0;

test('readView on a verified served home attaches receipt and host evidence; output parses on the wire', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const receipt = emptyReceipt({
    hostId: 'test',
    canonicalHome: realpathSync(home),
    stableRoot: join(realpathSync(home), 'slp-runtime'),
    now: NOW,
  });
  const enforcement = createEnforcement({ journal: stubJournal(receipt), now: () => new Date(NOW) });
  const paseo = {
    providers: { snapshot: async () => ({ entries: [] }) },
    agents: { list: agentsListOk() },
  };
  const view = await enforcement.readView({ schemaVersion: 1, target: target(home) }, paseo);
  // The view itself parses through the published wire schema.
  assert.deepEqual(GetEnforcementStatusOutput.parse(view), view);
  assert.equal(view.installation.state, 'INACTIVE');
  assert.equal(view.installation.revision, 0);
  assert.equal(view.installation.bound, false);
  assert.equal(view.installation.error, null);
  // No provider-policy or per-agent model projection; bindings is the P2-e
  // read-only membership projection — empty here because the verified home
  // has no repos directory yet.
  assert.equal(Object.keys(view).some(key => key.startsWith('providerTools')), false);
  assert.equal('modelObservations' in view, false);
  assert.deepEqual(view.bindings, []);
  assert.equal(view.acceptance, 'not-established-by-this-view');
  // Live surfaces flipped the dependent rows.
  assert.equal(capRow(view, CAPABILITY_IDS.pluginRpcDispatch).status, 'supported');
  assert.equal(capRow(view, CAPABILITY_IDS.agentsList).status, 'supported');
  assert.equal(capRow(view, CAPABILITY_IDS.agentsList).evidenceKind, 'host-observation');
  assert.ok(view.limitations.some(l => l.includes('observational only')));
  assert.ok(view.limitations.some(l => l.includes('not projected by this view')));
});

test('readView without an exported PASEO_HOME keeps static-only evidence — no receipt read, no host calls', async t => {
  const home = fixtureHome(t);
  unserveHome(t);
  const calls = { count: 0 };
  const paseoCalls = { count: 0 };
  const enforcement = createEnforcement({ journal: countingJournal(calls), now: () => new Date(NOW) });
  const paseo = {
    providers: { snapshot: async () => { paseoCalls.count++; } },
    agents: { list: async () => { paseoCalls.count++; } },
  };
  const view = await enforcement.readView({ schemaVersion: 1, target: target(home) }, paseo);
  assert.deepEqual(GetEnforcementStatusOutput.parse(view), view);
  assert.equal(calls.count, 0, 'journal.read must not run for an unverified target');
  assert.equal(paseoCalls.count, 0, 'host surfaces must not be exercised for an unverified target');
  assert.equal(view.installation, null);
  assert.ok(view.limitations.some(l => /served home/.test(l)), 'provenance limitation recorded');
  // Host-dependent rows keep the unknown floor — nothing fabricates support.
  assert.equal(capRow(view, CAPABILITY_IDS.agentsList).status, 'unknown');
  assert.equal(capRow(view, CAPABILITY_IDS.providersSnapshot).status, 'unknown');
  // rpcDispatched is proven by this very response, not by a host call.
  assert.equal(capRow(view, CAPABILITY_IDS.pluginRpcDispatch).status, 'supported');
  assert.equal(view.completeness.filter(e => e.collection === 'agents.list').length, 0);
  // P2-e: the projection is withheld under the provenance gate — never a
  // pretend "no memberships" answer.
  assert.deepEqual(view.bindings, []);
  assert.equal(omitted(view, 'bindings', 'source-incomplete'), 1);
  assert.ok(view.limitations.includes(limitation('L-P')), 'L-P fires on the unverified home');
  assert.deepEqual(view.gaps[0], PROVIDER_TOOLS_PROJECTION_GAP);
});

test('readView on a target whose realpath differs from the served home degrades to static-only', async t => {
  const served = fixtureHome(t);
  const other = fixtureHome(t);
  serveHome(t, served);
  const calls = { count: 0 };
  const enforcement = createEnforcement({ journal: countingJournal(calls), now: () => new Date(NOW) });
  const view = await enforcement.readView({ schemaVersion: 1, target: target(other) }, undefined);
  assert.deepEqual(GetEnforcementStatusOutput.parse(view), view);
  assert.equal(calls.count, 0);
  assert.equal(view.installation, null);
  assert.ok(view.limitations.some(l => /realpath mismatch|served home/.test(l)));
  assert.equal(capRow(view, CAPABILITY_IDS.agentsList).status, 'unknown');
});

test('readView on an unresolvable target path degrades to static-only instead of throwing', async t => {
  const served = fixtureHome(t);
  serveHome(t, served);
  const enforcement = createEnforcement({ journal: countingJournal({ count: 0 }), now: () => new Date(NOW) });
  const view = await enforcement.readView(
    { schemaVersion: 1, target: { hostId: 'test', daemonHome: join(served, 'missing') } },
    undefined,
  );
  assert.deepEqual(GetEnforcementStatusOutput.parse(view), view);
  assert.equal(view.installation, null);
  assert.ok(view.limitations.some(l => /does not resolve|served home/.test(l)));
});

test('a receipt naming a different target is TARGET_MISMATCH — the view degrades to static-only', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const mismatched = emptyReceipt({
    hostId: 'another-host',
    canonicalHome: realpathSync(home),
    stableRoot: join(realpathSync(home), 'slp-runtime'),
    now: NOW,
  });
  const enforcement = createEnforcement({ journal: stubJournal(mismatched), now: () => new Date(NOW) });
  const calls = { count: 0 };
  const paseo = { agents: { list: async () => { calls.count++; } } };
  const view = await enforcement.readView({ schemaVersion: 1, target: target(home) }, paseo);
  assert.deepEqual(GetEnforcementStatusOutput.parse(view), view);
  assert.equal(calls.count, 0, 'host surfaces withheld on TARGET_MISMATCH');
  assert.equal(view.installation, null);
  assert.ok(view.limitations.some(l => l.includes('TARGET_MISMATCH')));
});

test('a receipt for a different daemon home stored in this home is TARGET_MISMATCH too', async t => {
  const home = fixtureHome(t);
  const foreign = fixtureHome(t);
  serveHome(t, home);
  const mismatched = emptyReceipt({
    hostId: 'test',
    canonicalHome: realpathSync(foreign),
    stableRoot: join(realpathSync(foreign), 'slp-runtime'),
    now: NOW,
  });
  const enforcement = createEnforcement({ journal: stubJournal(mismatched), now: () => new Date(NOW) });
  const view = await enforcement.readView({ schemaVersion: 1, target: target(home) }, undefined);
  assert.equal(view.installation, null);
  assert.ok(view.limitations.some(l => l.includes('TARGET_MISMATCH')));
});

test('readView surfaces a corrupt receipt as a bounded installation.error instead of failing the view', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const corrupt = new OperationConflict('SCHEMA_LOSS', 'receipt bytes are not JSON');
  const enforcement = createEnforcement({ journal: { read: () => { throw corrupt; } }, now: () => new Date(NOW) });
  const view = await enforcement.readView({ schemaVersion: 1, target: target(home) }, undefined);
  assert.equal(view.installation.state, null);
  assert.match(view.installation.error, /SCHEMA_LOSS/);
  assert.ok(view.installation.error.length <= WIRE_LIMITS.installationError);
  assert.ok(view.limitations.some(l => l.includes('install receipt unreadable')));
  assert.deepEqual(GetEnforcementStatusOutput.parse(view), view);
});

test('readView with no receipt on disk reports present-but-empty installation', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const enforcement = createEnforcement({ journal: stubJournal(null), now: () => new Date(NOW) });
  const view = await enforcement.readView({ schemaVersion: 1, target: target(home) }, undefined);
  assert.deepEqual(view.installation, { state: null, revision: null, bound: false, error: null });
});

// agents.list decision table (spec §2.1): success → supported; an identifiable
// unknown_schema rejection → unsupported; any other failure or an oracle-reject
// payload → unknown + limitation. Never a fabricated page, never a false ok.
test('agents.list success marks the endpoint capability supported via host-observation', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const enforcement = createEnforcement({ journal: stubJournal(null), now: () => new Date(NOW) });
  const view = await enforcement.readView(
    { schemaVersion: 1, target: target(home) },
    { agents: { list: agentsListOk() } },
  );
  const row = capRow(view, CAPABILITY_IDS.agentsList);
  assert.equal(row.status, 'supported');
  assert.equal(row.evidenceKind, 'host-observation');
  assert.equal(row.observedAt, NOW);
  // The endpoint observation emits its envelope — no omission recorded.
  assert.equal(view.completeness.filter(e => e.collection === 'agents.list').length, 0);
});

test('agents.list unknown_schema rejection marks the endpoint capability unsupported', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const enforcement = createEnforcement({ journal: stubJournal(null), now: () => new Date(NOW) });
  const view = await enforcement.readView(
    { schemaVersion: 1, target: target(home) },
    { agents: { list: async () => { throw new Error('unknown_schema: agents.list'); } } },
  );
  assert.equal(capRow(view, CAPABILITY_IDS.agentsList).status, 'unsupported');
  assert.equal(omitted(view, 'agents.list', 'malformed'), 1, 'one envelope in, one omission out');
});

test('agents.list transport failure keeps the capability unknown — never a fabricated false', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const enforcement = createEnforcement({ journal: stubJournal(null), now: () => new Date(NOW) });
  const view = await enforcement.readView(
    { schemaVersion: 1, target: target(home) },
    { agents: { list: async () => { throw new Error('socket closed'); } } },
  );
  assert.equal(capRow(view, CAPABILITY_IDS.agentsList).status, 'unknown');
  assert.equal(omitted(view, 'agents.list', 'malformed'), 1);
  assert.ok(view.limitations.some(l => l.includes('agents.list failed')));
});

test('agents.list payload the protocol oracle rejects is inconclusive evidence', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const enforcement = createEnforcement({ journal: stubJournal(null), now: () => new Date(NOW) });
  const view = await enforcement.readView(
    { schemaVersion: 1, target: target(home) },
    { agents: { list: async () => ({ not: 'an-envelope' }) } },
  );
  const row = capRow(view, CAPABILITY_IDS.agentsList);
  assert.equal(row.status, 'unknown');
  assert.equal(row.evidenceKind, 'source-static-compat');
  assert.equal(omitted(view, 'agents.list', 'malformed'), 1);
  assert.ok(view.limitations.some(l => l.includes('protocol oracle')));
});

test('providers.snapshot unknown_schema marks the surface unsupported; other errors stay unknown', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const enforcement = createEnforcement({ journal: stubJournal(null), now: () => new Date(NOW) });
  const rejected = await enforcement.readView(
    { schemaVersion: 1, target: target(home) },
    { providers: { snapshot: async () => { throw new Error('unknown_schema'); } } },
  );
  assert.equal(capRow(rejected, CAPABILITY_IDS.providersSnapshot).status, 'unsupported');
  const flaky = await enforcement.readView(
    { schemaVersion: 1, target: target(home) },
    { providers: { snapshot: async () => { throw new Error('timeout'); } } },
  );
  assert.equal(capRow(flaky, CAPABILITY_IDS.providersSnapshot).status, 'unknown');
  assert.ok(flaky.limitations.some(l => l.includes('providers.snapshot failed')));
});

test('the production view emits the full pinned inventory with zero omissions', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const enforcement = createEnforcement({ journal: stubJournal(null), now: () => new Date(NOW) });
  const view = await enforcement.readView({ schemaVersion: 1, target: target(home) }, { agents: { list: agentsListOk() } });
  // Pins equal the audit inventory: everything produced is emitted verbatim.
  assert.equal(view.capabilities.length, 38);
  assert.equal(view.capabilities.length, WIRE_LIMITS.capabilities);
  assert.equal(view.gaps.length, 17);
  assert.equal(view.gaps.length, WIRE_LIMITS.gaps);
  // No omission in the production domain — completeness is the empty report.
  assert.deepEqual(view.completeness, []);
  // The mandatory gap leads, verbatim.
  assert.deepEqual(view.gaps[0], PROVIDER_TOOLS_PROJECTION_GAP);
  // Every emitted row round-trips through the wire schema.
  for (const r of view.capabilities) assert.deepEqual(CapabilityRecord.parse(r), r);
  for (const g of view.gaps) assert.deepEqual(CapabilityGap.parse(g), g);
});

test('readView rejects malformed input with INVALID_REQUEST', async t => {
  const home = fixtureHome(t);
  serveHome(t, home);
  const enforcement = createEnforcement({ journal: stubJournal(null) });
  await assert.rejects(
    () => enforcement.readView({ schemaVersion: 1, target: target(home), extra: 1 }, undefined),
    error => error instanceof OperationConflict && error.code === 'INVALID_REQUEST',
  );
  assert.throws(() => GetEnforcementStatusInput.parse({ schemaVersion: 1, target: { hostId: 'x' } }));
});

test('dispatch rejects every command with CAPABILITY_GAP — P0 has no mutation path', async () => {
  const enforcement = createEnforcement({ journal: stubJournal(null) });
  for (const command of [{ kind: 'seat.bind' }, { kind: 'authority.grant' }, 'not-an-object', null]) {
    const rejection = await enforcement.dispatch(command);
    assert.equal(rejection.ok, false);
    assert.equal(rejection.code, 'CAPABILITY_GAP');
    assert.deepEqual(DeskRejection.parse(rejection), rejection);
    assert.ok(rejection.recovery.length > 0);
  }
});

// ---------------------------------------------------------------------------
// boundStatusView — the final guard. Under the pinned P0 capacity vector the
// byte shed is unreachable: schema-invalid or over-bound output throws
// IO_FAILURE; there is no diagnostic floor.
// ---------------------------------------------------------------------------

const baseView = () => GetEnforcementStatusOutput.parse({
  schemaVersion: 1,
  target: { hostId: 't', daemonHome: '/tmp' },
  generatedAt: NOW,
  installation: null,
  capabilities: [],
  gaps: [PROVIDER_TOOLS_PROJECTION_GAP],
  bindings: [],
  limitations: [],
  completeness: [],
  acceptance: 'not-established-by-this-view',
});

test('boundStatusView passes a schema-valid under-bound view through verbatim', () => {
  const view = baseView();
  assert.deepEqual(boundStatusView(view), view);
});

test('boundStatusView throws IO_FAILURE on producer-invalid output — never a floor', () => {
  const invalids = [
    { ...baseView(), capabilities: 'not-an-array' },
    { ...baseView(), acceptance: 'verdict' },
    { ...baseView(), gaps: [] }, // strict shape is fine — test a real break below
    { ...baseView(), completeness: [{ collection: 'capabilities', reason: 'row-limit', count: 1, detail: null }, { collection: 'capabilities', reason: 'row-limit', count: 1, detail: null }] },
  ];
  // gaps:[] is schema-valid — swap it for a genuinely invalid case.
  invalids[2] = { ...baseView(), installation: { state: 'x', revision: -1, bound: false, error: null } };
  for (const broken of invalids) {
    assert.throws(
      () => boundStatusView(broken),
      error => error instanceof OperationConflict && error.code === 'IO_FAILURE',
      JSON.stringify(broken).slice(0, 120),
    );
  }
});

// ---------------------------------------------------------------------------
// config-view — sanitized parse errors
// ---------------------------------------------------------------------------

test('readRawConfig parse failure keeps only the position — never raw input bytes', t => {
  const dir = tmp(t);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, '{"a": SECRET_MARKER_9f3b not-json}');
  assert.throws(
    () => readRawConfig(configPath),
    error => {
      assert.ok(error instanceof OperationConflict);
      assert.equal(error.code, 'SCHEMA_LOSS');
      assert.ok(!error.message.includes('SECRET_MARKER_9f3b'), `raw fragment leaked: ${error.message}`);
      assert.match(error.message, /not valid JSON/);
      return true;
    },
  );
  // The position form of the V8 error keeps `at position N`.
  writeFileSync(configPath, '[1,2');
  assert.throws(
    () => readRawConfig(configPath),
    error => {
      assert.equal(error.code, 'SCHEMA_LOSS');
      assert.match(error.message, /position \d+/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// §2.1 static capacity proof — pins derived from schema introspection
// ---------------------------------------------------------------------------

// zod4 introspection: unwrap nullable, then read the max_length check.
const schemaChecks = s => s._zod.def.checks?.map(c => c._zod.def) ?? [];
const maxLen = s => schemaChecks(s).find(d => d?.check === 'max_length')?.maximum;
const unwrap = s => (s._zod.def.type === 'nullable' ? s._zod.def.innerType : s);
const arrayCap = s => maxLen(unwrap(s));
const stringCap = s => maxLen(unwrap(s));
const itemCap = s => stringCap(unwrap(s)._zod.def.element);

test('one bound owner: every wire cap lives in WIRE_LIMITS and is enforced by the schema', () => {
  const out = GetEnforcementStatusOutput._zod.def.shape;
  const rec = CapabilityRecord._zod.def.shape;
  const gap = CapabilityGap._zod.def.shape;
  const binding = SeatBindingView._zod.def.shape;
  const installation = unwrap(out.installation)._zod.def.shape;
  const cases = [
    ['capabilities', arrayCap(out.capabilities), WIRE_LIMITS.capabilities],
    ['gaps', arrayCap(out.gaps), WIRE_LIMITS.gaps],
    ['bindings', arrayCap(out.bindings), WIRE_LIMITS.bindings],
    ['limitations', arrayCap(out.limitations), WIRE_LIMITS.limitations],
    ['limitation item', itemCap(out.limitations), WIRE_LIMITS.limitationLen],
    ['completeness', arrayCap(out.completeness), WIRE_LIMITS.completenessEntries],
    ['capabilityId', stringCap(rec.capabilityId), WIRE_LIMITS.capabilityId],
    ['sourceRef', stringCap(rec.sourceRef), WIRE_LIMITS.sourceRef],
    ['evidenceRef', stringCap(rec.evidenceRef), WIRE_LIMITS.evidenceRef],
    ['record limitations items', arrayCap(rec.limitations), WIRE_LIMITS.recordLimitations],
    ['record limitation len', itemCap(rec.limitations), WIRE_LIMITS.limitationLen],
    ['missingPrimitive', stringCap(gap.missingPrimitive), WIRE_LIMITS.missingPrimitive],
    ['neededBy', stringCap(gap.neededBy), WIRE_LIMITS.neededBy],
    ['ownerAction', stringCap(gap.ownerAction), WIRE_LIMITS.ownerAction],
    ['binding membershipId', stringCap(binding.membershipId), WIRE_LIMITS.membershipId],
    ['binding agentId', stringCap(binding.agentId), WIRE_LIMITS.agentId],
    ['installation.state', stringCap(installation.state), WIRE_LIMITS.installationState],
    ['installation.error', stringCap(installation.error), WIRE_LIMITS.installationError],
    ['target.hostId', stringCap(out.target._zod.def.shape.hostId), WIRE_LIMITS.targetHostId],
    ['target.daemonHome', stringCap(out.target._zod.def.shape.daemonHome), WIRE_LIMITS.targetDaemonHome],
    ['input target.hostId', stringCap(GetEnforcementStatusInput._zod.def.shape.target._zod.def.shape.hostId), WIRE_LIMITS.targetHostId],
    ['input target.daemonHome', stringCap(GetEnforcementStatusInput._zod.def.shape.target._zod.def.shape.daemonHome), WIRE_LIMITS.targetDaemonHome],
  ];
  for (const [name, schemaCap, pinned] of cases) {
    assert.equal(schemaCap, pinned, `${name}: schema cap ${schemaCap} !== WIRE_LIMITS ${pinned}`);
  }
  // The ledger slot count is the enum product — nothing hand-written.
  assert.equal(
    WIRE_LIMITS.completenessEntries,
    CompletenessCollection.options.length * CompletenessReason.options.length,
  );
  assert.equal(WIRE_LIMITS.completenessCount, Number.MAX_SAFE_INTEGER);
  // The closed collection vocabulary covers exactly the P0 scopes — no
  // providerTools, no `view` marker (producer-invalid throws instead).
  assert.deepEqual([...CompletenessCollection.options].sort(), [
    'agents.list', 'bindings', 'capabilities', 'completeness', 'gaps', 'limitations',
  ]);
  // P2-e: bindings carries real membership rows, capped at the pinned limit.
  assert.equal(arrayCap(out.bindings), WIRE_LIMITS.bindings);
  assert.equal(WIRE_LIMITS.bindings, 16);
  assert.equal(WIRE_LIMITS.bindingsRepos, 16);
});

// Fill scalars to exactly their pinned maxima; rows/entries generated at cap.
const fill = (prefix, max) => `${prefix}${'x'.repeat(Math.max(0, max - prefix.length))}`.slice(0, max);

const fatRecord = i => ({
  schemaVersion: 1,
  capabilityId: fill(`cap-${i}-`, WIRE_LIMITS.capabilityId),
  family: null,
  probeId: 'a',
  status: 'unknown',
  source: 'paseo-src',
  sourceRef: fill(`src-${i}-`, WIRE_LIMITS.sourceRef),
  evidenceKind: 'source-static-compat',
  evidenceRef: fill(`ev-${i}-`, WIRE_LIMITS.evidenceRef),
  observedAt: NOW,
  limitations: Array.from({ length: WIRE_LIMITS.recordLimitations }, (_, j) =>
    fill(`lim-${i}-${j}-`, WIRE_LIMITS.limitationLen)),
});

const fatGap = i => ({
  capabilityId: fill(`gap-${i}-`, WIRE_LIMITS.capabilityId),
  family: null,
  missingPrimitive: fill(`miss-${i}-`, WIRE_LIMITS.missingPrimitive),
  neededBy: fill(`need-${i}-`, WIRE_LIMITS.neededBy),
  ownerAction: fill(`own-${i}-`, WIRE_LIMITS.ownerAction),
});

const fatLimitation = i => fill(`L${i}-`, WIRE_LIMITS.limitationLen);

const allPairs = () =>
  CompletenessCollection.options.flatMap(collection =>
    CompletenessReason.options.map(reason => ({ collection, reason, count: 1, detail: null })));

const fatBinding = () => ({
  schemaVersion: 1,
  membershipId: fill('m-', WIRE_LIMITS.membershipId),
  agentId: fill('a-', WIRE_LIMITS.agentId),
  family: null,
  state: 'unbound-open',
  epoch: null,
  observedAt: NOW,
  limitations: [],
});

/** Schema-valid output built to `sizes`; scalars always at pinned maxima.
 *  The gaps collection always leads with the mandatory row — "zero" means
 *  mandatory-only (recordsIn=1), matching the producer's gap contract. */
function fixtureAt(sizes = {}) {
  const n = { capabilities: 0, gaps: 0, limitations: 0, completeness: 0, bindings: 0, ...sizes };
  return {
    schemaVersion: 1,
    target: {
      hostId: fill('h-', WIRE_LIMITS.targetHostId),
      daemonHome: `/${fill('d-', WIRE_LIMITS.targetDaemonHome - 1)}`,
    },
    generatedAt: NOW,
    installation: {
      state: fill('S-', WIRE_LIMITS.installationState),
      revision: Number.MAX_SAFE_INTEGER,
      bound: true,
      error: fill('E-', WIRE_LIMITS.installationError),
    },
    capabilities: Array.from({ length: n.capabilities }, (_, i) => fatRecord(i)),
    gaps: [
      PROVIDER_TOOLS_PROJECTION_GAP,
      ...Array.from({ length: Math.max(0, n.gaps - 1) }, (_, i) => fatGap(i)),
    ],
    bindings: Array.from({ length: n.bindings }, () => fatBinding()),
    limitations: Array.from({ length: n.limitations }, (_, i) => fatLimitation(i)),
    completeness: Array.from({ length: n.completeness }, (_, i) => allPairs()[i]),
    acceptance: 'not-established-by-this-view',
  };
}

// ---------------------------------------------------------------------------
// §2.1 normative wire fixtures — real audit output (normal) + escape-fill
// envelope (overflow), both deterministic and hash-pinned.
// ---------------------------------------------------------------------------

const ESCAPE_SEED = String.fromCodePoint(1) + 'é' + String.fromCharCode(34, 92, 10);
const escapeFill = n => ESCAPE_SEED.repeat(Math.ceil(n / ESCAPE_SEED.length)).slice(0, n);

/** The real audit rows of the pinned representative tuple — production
 *  FAMILY_FACTS, fixed timestamp, silent host (false,null,null). */
const fixtureAudit = () =>
  auditCapabilities({
    now: NOW,
    observed: { rpcDispatched: false, providersSnapshot: null, agentsList: null },
  });

const sha256Utf8 = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const utf8Bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('§2.1 normal fixture: real audit output at pinned caller maxima stays under 64 KiB', () => {
  const audit = fixtureAudit();
  const fixture = {
    schemaVersion: 1,
    target: {
      hostId: 'h' + 'é'.repeat(WIRE_LIMITS.targetHostId - 1),
      daemonHome: '/' + 'é'.repeat(WIRE_LIMITS.targetDaemonHome - 1),
    },
    generatedAt: NOW,
    installation: {
      state: 'é'.repeat(WIRE_LIMITS.installationState),
      revision: Number.MAX_SAFE_INTEGER,
      bound: true,
      error: 'é'.repeat(WIRE_LIMITS.installationError),
    },
    capabilities: audit.records,
    gaps: audit.gaps,
    bindings: [],
    limitations: [...P0_STATIC_LIMITATIONS],
    completeness: [],
    acceptance: 'not-established-by-this-view',
  };
  const parsed = GetEnforcementStatusOutput.parse(fixture);
  const bytes = utf8Bytes(parsed);
  const sha256 = sha256Utf8(parsed);
  console.info('P0 normal fixture', {
    K: {
      capabilities: WIRE_LIMITS.capabilities,
      gaps: WIRE_LIMITS.gaps,
      bindings: WIRE_LIMITS.bindings,
      limitations: WIRE_LIMITS.limitations,
      completeness: WIRE_LIMITS.completenessEntries,
      installationState: WIRE_LIMITS.installationState,
      installationError: WIRE_LIMITS.installationError,
    },
    scalars: {
      capabilityId: WIRE_LIMITS.capabilityId,
      sourceRef: WIRE_LIMITS.sourceRef,
      evidenceRef: WIRE_LIMITS.evidenceRef,
      missingPrimitive: WIRE_LIMITS.missingPrimitive,
      neededBy: WIRE_LIMITS.neededBy,
      ownerAction: WIRE_LIMITS.ownerAction,
      limitationLen: WIRE_LIMITS.limitationLen,
      recordLimitations: WIRE_LIMITS.recordLimitations,
      targetHostId: WIRE_LIMITS.targetHostId,
      targetDaemonHome: WIRE_LIMITS.targetDaemonHome,
    },
    jsonBytes: bytes,
    fixtureSha256: sha256,
  });
  assert.ok(
    bytes < MAX_RPC_BYTES,
    `normal fixture is ${bytes} bytes — over the ${MAX_RPC_BYTES}-byte bound`,
  );
});

test('§2.1 overflow fixture: a schema-valid escape-filled envelope over budget fails closed', () => {
  const audit = fixtureAudit();
  // Same shape/enum/inventory/38-17 cardinality as production output; every
  // free-form bounded field carries escapeFill(cap) — control, quote,
  // backslash and newline are legal JSON input that only costs bytes.
  const fixture = {
    schemaVersion: 1,
    target: {
      hostId: escapeFill(WIRE_LIMITS.targetHostId),
      daemonHome: '/' + escapeFill(WIRE_LIMITS.targetDaemonHome - 1),
    },
    generatedAt: NOW,
    installation: {
      state: escapeFill(WIRE_LIMITS.installationState),
      revision: 0,
      bound: false,
      error: escapeFill(WIRE_LIMITS.installationError),
    },
    capabilities: audit.records.map(r => ({
      ...r,
      sourceRef: escapeFill(WIRE_LIMITS.sourceRef),
      evidenceRef: escapeFill(WIRE_LIMITS.evidenceRef),
      limitations: Array.from({ length: WIRE_LIMITS.recordLimitations }, () =>
        escapeFill(WIRE_LIMITS.limitationLen)),
    })),
    gaps: audit.gaps.map(g => ({
      ...g,
      missingPrimitive: escapeFill(WIRE_LIMITS.missingPrimitive),
      neededBy: escapeFill(WIRE_LIMITS.neededBy),
      ownerAction: escapeFill(WIRE_LIMITS.ownerAction),
    })),
    bindings: [],
    limitations: Array.from({ length: WIRE_LIMITS.limitations }, () =>
      escapeFill(WIRE_LIMITS.limitationLen)),
    completeness: [],
    acceptance: 'not-established-by-this-view',
  };
  const parsed = GetEnforcementStatusOutput.parse(fixture);
  const bytes = utf8Bytes(parsed);
  console.info('P0 overflow fixture', { jsonBytes: bytes, fixtureSha256: sha256Utf8(parsed) });
  assert.ok(
    bytes > MAX_RPC_BYTES,
    `overflow fixture is ${bytes} bytes — expected over the ${MAX_RPC_BYTES}-byte bound`,
  );
  // Over-budget input ends in typed IO_FAILURE before emit — no byte-shed,
  // no prefix cut, no floor-as-success.
  assert.throws(
    () => boundStatusView(parsed),
    error => error instanceof OperationConflict && error.code === 'IO_FAILURE',
  );
});

test('§2.1 fixture states: every positive-capacity collection accepts zero and cap, rejects cap+1', () => {
  // The states table (§2.1): zero / cap / cap+1 per collection; gaps "zero"
  // still carries the mandatory row. P2-e gives bindings a real cap.
  const collections = [
    ['capabilities', WIRE_LIMITS.capabilities],
    ['gaps', WIRE_LIMITS.gaps],
    ['bindings', WIRE_LIMITS.bindings],
    ['limitations', WIRE_LIMITS.limitations],
    ['completeness', WIRE_LIMITS.completenessEntries],
  ];
  for (const [name, cap] of collections) {
    assert.doesNotThrow(
      () => GetEnforcementStatusOutput.parse(fixtureAt({ [name]: 0 })),
      `${name} at zero`,
    );
    assert.doesNotThrow(
      () => GetEnforcementStatusOutput.parse(fixtureAt({ [name]: cap })),
      `${name} at cap ${cap}`,
    );
    // cap+1 must be producer-invalid. For completeness the closed vocabulary
    // has exactly cap pairs, so the +1 is necessarily a duplicate pair —
    // producer-invalid either way.
    const over = fixtureAt({ [name]: cap });
    over[name] = [...over[name], over[name][over[name].length - 1]];
    assert.equal(
      GetEnforcementStatusOutput.safeParse(over).success,
      false,
      `${name} at cap+1 must be rejected`,
    );
    assert.throws(
      () => boundStatusView(over),
      error => error instanceof OperationConflict && error.code === 'IO_FAILURE',
      `${name} at cap+1 → IO_FAILURE`,
    );
  }
  // A schema-valid bindings row now parses — cap overflow is what fails.
  assert.doesNotThrow(() => GetEnforcementStatusOutput.parse(fixtureAt({ bindings: 1 })));
  // gaps.zero keeps exactly the mandatory row — never a synthetic omission.
  const zeroGaps = fixtureAt({ gaps: 0 });
  assert.deepEqual(zeroGaps.gaps, [PROVIDER_TOOLS_PROJECTION_GAP]);
  assert.doesNotThrow(() => GetEnforcementStatusOutput.parse(zeroGaps));
});

// ---------------------------------------------------------------------------
// CompletenessEntry — closed vocabulary sensitivity
// ---------------------------------------------------------------------------

test('open vocabulary, duplicate pairs, non-null detail and non-int counts are wire-invalid', () => {
  const entry = { collection: 'capabilities', reason: 'row-limit', count: 2, detail: null };
  assert.deepEqual(CompletenessEntry.parse(entry), entry);
  assert.throws(() => CompletenessEntry.parse({ ...entry, collection: 'providerTools' }));
  assert.throws(() => CompletenessEntry.parse({ ...entry, collection: 'view' }));
  assert.throws(() => CompletenessEntry.parse({ ...entry, collection: 'made-up' }));
  assert.throws(() => CompletenessEntry.parse({ ...entry, reason: 'invented' }));
  assert.throws(() => CompletenessEntry.parse({ ...entry, detail: 'x' }));
  assert.throws(() => CompletenessEntry.parse({ ...entry, count: 1.5 }));
  assert.throws(() => CompletenessEntry.parse({ ...entry, count: 0 }));
  assert.throws(() => CompletenessEntriesSchema.parse([entry, entry]));
});

// ---------------------------------------------------------------------------
// P2-e — read-only membership projection (contract §4) + §4.5 limitation table
// ---------------------------------------------------------------------------
//
// Fixture discipline: memberships land through the store's real `transact`
// (the same channel desk-seat uses), so projection tests read bytes that a
// real writer produced. readView itself must only read — the read-only proof
// below snapshots the repos tree before and after.

const reposDirOf = stableRoot => join(stableRoot, 'state', 'enforcement', 'repos');

/** A verified served home + its stable root; repos dir is NOT pre-created. */
function projectionHome(t) {
  const home = fixtureHome(t);
  serveHome(t, home);
  const stableRoot = join(realpathSync(home), 'slp-runtime');
  const view = (over = {}) =>
    createEnforcement({ journal: stubJournal(null), now: () => new Date(NOW), ...over })
      .readView({ schemaVersion: 1, target: target(home) }, undefined);
  return { home, stableRoot, view };
}

/** A repo key derived the same way the store derives it. */
const repoKeyAt = i => repoKeyFor({ hostId: 'local', gitCommonDir: `/gc/${i}` });

/** Seed a repo ledger through the real writer channel (P2-c memberships);
 *  the envelope's repo must hash to the same key (repo-mismatch → unsafe). */
async function seedMemberships(stableRoot, gcIndex, rows) {
  const gitCommonDir = `/gc/${gcIndex}`;
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir });
  const store = createDeskStore({ stableRoot });
  const result = await store.transact(
    repoKey,
    {
      repo: { hostId: 'local', gitCommonDir },
      actorKey: 'desk:hook',
      assignmentId: 'unassigned',
      requestId: randomUUID(),
      command: { kind: 'seed' },
    },
    () => ({ ok: true, events: [], memberships: rows }),
  );
  assert.ok(result.ok, `seed commit failed: ${JSON.stringify(result)}`);
  return repoKey;
}

/** A schema-valid v2 membership row (refinement-clean per variant). */
const member = (over = {}) => ({
  membershipId: randomUUID(),
  state: 'unbound-open',
  bindingHandleSha256: createHash('sha256').update(randomUUID()).digest('hex'),
  provider: 'slp-codex-peer',
  family: 'codex',
  role: 'peer',
  createCwd: '/repo',
  openGeneration: 1,
  agentId: null,
  workspaceId: null,
  createdAt: NOW,
  hostConfirmedAt: null,
  registeredAt: null,
  revokedAt: null,
  revokeReason: null,
  ...over,
});

test('P2-e: no repos directory (and an empty one) projects [] with no omissions', async t => {
  const absent = await projectionHome(t).view();
  assert.deepEqual(absent.bindings, []);
  assert.equal(absent.completeness.filter(e => e.collection === 'bindings').length, 0);

  const { home, stableRoot, view } = projectionHome(t);
  mkdirSync(reposDirOf(stableRoot), { recursive: true });
  const empty = await view();
  assert.deepEqual(GetEnforcementStatusOutput.parse(empty), empty);
  assert.deepEqual(empty.bindings, []);
  assert.equal(empty.completeness.filter(e => e.collection === 'bindings').length, 0);
  assert.equal(omitted(empty, 'bindings', 'source-incomplete'), 0);
});

test('P2-e: only rows with an agentId project; states pass through; rows are wire-valid', async t => {
  const { stableRoot, view } = projectionHome(t);
  const confirmed = member({
    state: 'host-confirmed', agentId: 'agent-confirmed', workspaceId: 'wks-1',
    hostConfirmedAt: '2026-01-01T00:00:01.000Z',
  });
  const revokedBound = member({
    state: 'revoked', agentId: 'agent-revoked', workspaceId: 'wks-2',
    hostConfirmedAt: '2026-01-01T00:00:02.000Z',
    registeredAt: '2026-01-01T00:00:03.000Z',
    revokedAt: '2026-01-01T00:00:04.000Z',
    revokeReason: 'archived',
  });
  await seedMemberships(stableRoot, 0, [
    member(), // unbound-open — no agentId
    member({ state: 'revoked', revokedAt: '2026-01-01T00:00:05.000Z', revokeReason: 'expired-unbound' }), // revoked, never bound
    confirmed,
    revokedBound,
  ]);
  const out = await view();
  assert.deepEqual(GetEnforcementStatusOutput.parse(out), out);
  assert.equal(out.bindings.length, 2);
  assert.equal(omitted(out, 'bindings', 'state-excluded'), 2,
    'both agentId-less rows count — unbound-open and expired-unbound');
  // Order: observedAt desc — the revoked row (…:04) leads the confirmed (…:01).
  const [rev, conf] = out.bindings;
  assert.equal(rev.agentId, 'agent-revoked');
  assert.equal(rev.state, 'revoked');
  assert.equal(rev.observedAt, '2026-01-01T00:00:04.000Z');
  assert.equal(rev.membershipId, revokedBound.membershipId);
  assert.equal(rev.family, 'codex');
  assert.equal(rev.epoch, null);
  assert.deepEqual(rev.limitations, [
    'registration: confirmed', 'attestation: none', 'revoked: archived',
  ]);
  assert.equal(conf.agentId, 'agent-confirmed');
  assert.equal(conf.state, 'host-confirmed');
  assert.equal(conf.observedAt, '2026-01-01T00:00:01.000Z');
  assert.deepEqual(conf.limitations, ['registration: pending', 'attestation: none']);
  // The emitted vocabulary never includes attached/active.
  assert.ok(out.bindings.every(row => !['attached', 'active', 'unbound-open'].includes(row.state)));
  for (const row of out.bindings) assert.deepEqual(SeatBindingView.parse(row), row);
  // The static L-B literal is always present.
  assert.ok(out.limitations.includes(limitation('L-B')));
});

test('P2-e: rows from multiple repos project together', async t => {
  const { stableRoot, view } = projectionHome(t);
  for (const i of [0, 1, 2]) {
    await seedMemberships(stableRoot, i, [
      member({ state: 'host-confirmed', agentId: `agent-${i}`, hostConfirmedAt: `2026-01-01T00:00:0${i}.000Z` }),
    ]);
  }
  const out = await view();
  assert.equal(out.bindings.length, 3);
  // observedAt descending across repos.
  assert.deepEqual(out.bindings.map(r => r.agentId), ['agent-2', 'agent-1', 'agent-0']);
});

// Ordering is by instant, not string bytes — a '+09:00' timestamp sorts
// EARLIER chronologically than a lexically-later 'Z' one (S6). Both the
// per-row max selection and the cross-row sort must use Date.parse.
test('P2-e §4.2: observedAt ordering follows the parsed instant — non-Z offsets', async t => {
  const { stableRoot, view } = projectionHome(t);
  await seedMemberships(stableRoot, 0, [
    // '2026-01-02T00:00:00+09:00' == 2026-01-01T15:00Z — lexically later than
    // agent-zulu's string but chronologically earlier.
    member({
      state: 'host-confirmed', agentId: 'agent-offset',
      hostConfirmedAt: '2026-01-02T00:00:00+09:00',
    }),
    member({
      state: 'host-confirmed', agentId: 'agent-zulu',
      hostConfirmedAt: '2026-01-01T23:00:00.000Z',
    }),
    // Same trap inside one row: registeredAt '23:00+09:00' (14:00Z) loses to
    // revokedAt '20:00Z' (20:00Z) by instant, wins by string bytes.
    member({
      state: 'revoked', agentId: 'agent-mixed',
      hostConfirmedAt: '2026-01-01T00:00:00.000Z',
      registeredAt: '2026-01-01T23:00:00+09:00',
      revokedAt: '2026-01-01T20:00:00.000Z',
      revokeReason: 'archived',
    }),
  ]);
  const out = await view();
  assert.deepEqual(GetEnforcementStatusOutput.parse(out), out);
  // Instants: zulu 23:00Z > mixed 20:00Z > offset 15:00Z.
  assert.deepEqual(out.bindings.map(r => r.agentId), ['agent-zulu', 'agent-mixed', 'agent-offset']);
  assert.equal(out.bindings[1].observedAt, '2026-01-01T20:00:00.000Z',
    'the stored string is emitted, but the max was chosen by instant');
});

// Regression (S6-reg): Date.parse of the epoch is 0 — a real instant, not a
// falsy one. A `||`-style instant() would sink epoch rows below pre-epoch.
test('P2-e §4.2: the epoch is a real instant — sorts ahead of pre-epoch', async t => {
  const { stableRoot, view } = projectionHome(t);
  await seedMemberships(stableRoot, 0, [
    member({ state: 'host-confirmed', agentId: 'agent-epoch', hostConfirmedAt: '1970-01-01T00:00:00.000Z' }),
    member({ state: 'host-confirmed', agentId: 'agent-preepoch', hostConfirmedAt: '1969-12-31T23:59:59.000Z' }),
  ]);
  const out = await view();
  assert.deepEqual(out.bindings.map(r => r.agentId), ['agent-epoch', 'agent-preepoch'],
    'epoch (parse = 0) must sort before 1969-12-31 (parse = -1000), not after');
});

test('P2-e: absent/corrupt/future/unsafe ledgers and read exceptions — one L-S1, exact completeness', async t => {
  const { stableRoot, view } = projectionHome(t);
  const repos = reposDirOf(stableRoot);
  // absent: repo dir exists, no ledger.json.
  mkdirSync(join(repos, repoKeyAt(0)), { recursive: true });
  // corrupt: invalid JSON.
  mkdirSync(join(repos, repoKeyAt(1)), { recursive: true });
  writeFileSync(join(repos, repoKeyAt(1), 'ledger.json'), 'not json{');
  // future: header-valid, schemaVersion ahead.
  mkdirSync(join(repos, repoKeyAt(2)), { recursive: true });
  writeFileSync(join(repos, repoKeyAt(2), 'ledger.json'), JSON.stringify({ format: 'paseo-slp/enforcement', schemaVersion: 3 }));
  // unsafe: ledger.json is a directory (not a regular file).
  mkdirSync(join(repos, repoKeyAt(3), 'ledger.json'), { recursive: true });
  // read throws: injected store seam maps a chosen key to IO_FAILURE.
  const throwing = repoKeyAt(4);
  mkdirSync(join(repos, throwing), { recursive: true });
  const deskStore = () => ({
    read: key => {
      if (key === throwing) throw new OperationConflict('IO_FAILURE', 'disk error');
      return createDeskStore({ stableRoot }).read(key);
    },
  });
  const out = await view({ deskStore });
  assert.deepEqual(GetEnforcementStatusOutput.parse(out), out);
  assert.deepEqual(out.bindings, []);
  // absent contributes nothing; corrupt+future+unsafe → malformed 3;
  // the thrown read → source-incomplete 1. All four dropped repos count
  // once into the aggregate L-S1 (N = 4).
  assert.equal(omitted(out, 'bindings', 'malformed'), 3);
  assert.equal(omitted(out, 'bindings', 'source-incomplete'), 1);
  const ls1 = `bindings: 4 repo ledger(s) skipped; inspect slp-runtime/state/enforcement/repos/*/ledger.json`;
  assert.ok(out.limitations.includes(ls1), `L-S1(N=4): ${JSON.stringify(out.limitations)}`);
  assert.equal(renderSkippedLedgers(4), ls1, 'the render helper produces the pinned literal');
  // No L-S2 — the repos dir listed fine.
  assert.equal(out.limitations.includes(limitation('L-S2')), false);
});

test('P2-e: a non-ENOENT readdir failure withholds bindings with L-S2 — never L-S1', async t => {
  const { view } = projectionHome(t);
  const out = await view({
    readdir: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; },
  });
  assert.deepEqual(GetEnforcementStatusOutput.parse(out), out);
  assert.deepEqual(out.bindings, []);
  assert.equal(omitted(out, 'bindings', 'source-incomplete'), 1);
  assert.ok(out.limitations.includes(limitation('L-S2')));
  assert.equal(out.limitations.some(l => /repo ledger\(s\) skipped/.test(l)), false, 'L-S1 must not appear when nothing was scanned');
});

test('P2-e: repos beyond bindingsRepos count as source-incomplete only — never into L-S1', async t => {
  const { stableRoot, view } = projectionHome(t);
  const repos = reposDirOf(stableRoot);
  // 17 candidate dirs; the corrupt one sorts first (within the scan cap),
  // one absent dir lands beyond it.
  const keys = Array.from({ length: WIRE_LIMITS.bindingsRepos + 1 }, (_, i) => repoKeyAt(i)).sort();
  for (const key of keys) mkdirSync(join(repos, key), { recursive: true });
  writeFileSync(join(repos, keys[0], 'ledger.json'), 'corrupt{');
  const out = await view();
  assert.deepEqual(GetEnforcementStatusOutput.parse(out), out);
  // scanned: 16 dirs (1 corrupt → malformed; 15 absent → nothing); beyond: 1.
  assert.equal(omitted(out, 'bindings', 'malformed'), 1);
  assert.equal(omitted(out, 'bindings', 'source-incomplete'), 1);
  assert.ok(out.limitations.includes(renderSkippedLedgers(1)), 'L-S1 counts only the read-and-dropped repo');
});

test('P2-e: directories whose names fail REPO_KEY_PATTERN are ignored silently', async t => {
  const { stableRoot, view } = projectionHome(t);
  const repos = reposDirOf(stableRoot);
  mkdirSync(join(repos, 'not-a-repo-key', 'nested'), { recursive: true });
  writeFileSync(join(repos, 'README'), 'x');
  const out = await view();
  assert.deepEqual(out.bindings, []);
  assert.equal(out.completeness.filter(e => e.collection === 'bindings').length, 0);
});

test('P2-e: over the bindings cap sheds the OLDEST rows into row-limit', async t => {
  const { stableRoot, view } = projectionHome(t);
  const rows = Array.from({ length: WIRE_LIMITS.bindings + 1 }, (_, i) => member({
    state: 'host-confirmed',
    agentId: `agent-${String(i).padStart(2, '0')}`,
    hostConfirmedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
  }));
  await seedMemberships(stableRoot, 0, rows);
  const out = await view();
  assert.deepEqual(GetEnforcementStatusOutput.parse(out), out);
  assert.equal(out.bindings.length, WIRE_LIMITS.bindings);
  assert.equal(omitted(out, 'bindings', 'row-limit'), 1);
  // The shed row is the oldest — agent-00 is absent, agent-16 survives.
  assert.equal(out.bindings.some(r => r.agentId === 'agent-00'), false);
  assert.equal(out.bindings[0].agentId, `agent-${String(WIRE_LIMITS.bindings).padStart(2, '0')}`);
});

test('P2-e: an over-cap field elides the whole row as field-overflow — never truncated', async t => {
  const { stableRoot, view } = projectionHome(t);
  const key = repoKeyAt(0);
  mkdirSync(join(reposDirOf(stableRoot), key), { recursive: true });
  const row = member({ state: 'host-confirmed', agentId: 'a'.repeat(WIRE_LIMITS.agentId + 1), hostConfirmedAt: NOW });
  const deskStore = () => ({ read: () => ({ state: 'ok', ledger: { memberships: [row] }, persistedSchemaVersion: 2 }) });
  const out = await view({ deskStore });
  assert.deepEqual(out.bindings, []);
  assert.equal(omitted(out, 'bindings', 'field-overflow'), 1);
});

test('P2-e: the projection is read-only — the repos tree is byte-identical after readView', async t => {
  const { stableRoot, view } = projectionHome(t);
  await seedMemberships(stableRoot, 0, [member({ state: 'host-confirmed', agentId: 'agent-1', hostConfirmedAt: NOW })]);
  const repos = reposDirOf(stableRoot);
  const snapshot = () => {
    const listing = [];
    for (const name of readdirSync(repos).sort()) {
      for (const file of readdirSync(join(repos, name)).sort()) {
        const path = join(repos, name, file);
        listing.push([name, file, readFileSync(path, 'utf8')]);
      }
    }
    return listing;
  };
  const before = snapshot();
  const out = await view();
  assert.equal(out.bindings.length, 1);
  assert.deepEqual(snapshot(), before, 'readView must never write under repos/');
  // And no desk locks or recovery artifacts appear.
  assert.equal(existsSync(join(repos, repoKeyAt(0), 'lock')), false);
  assert.equal(existsSync(join(repos, repoKeyAt(0), 'recover.lock')), false);
  assert.equal(existsSync(join(repos, repoKeyAt(0), 'recovery-log.jsonl')), false);
});

test('P2-e §4.5: the limitation table matches the pinned literals verbatim, byte-measured', () => {
  // The contract pins these strings byte-for-byte — a literal change without
  // a contract bump is a mutation this test kills.
  const longestReason = REVOKE_REASONS.reduce((a, b) => (b.length > a.length ? b : a));
  assert.equal(longestReason, 'registration-mismatch');
  const PINNED = {
    'L-B': 'bindings: desk handshake rows with an agentId; no attestation or authority; rows without agentId are only counted',
    'L-P': 'bindings withheld: PASEO_HOME not exported; memberships still recorded; export it or run desk-recover --paseo-home',
    'L-S1': `bindings: ${WIRE_LIMITS.bindingsRepos} repo ledger(s) skipped; inspect slp-runtime/state/enforcement/repos/*/ledger.json`,
    'L-S2': 'bindings: repos directory unreadable; check slp-runtime/state/enforcement/repos exists and is readable',
    'C-DL': 'desk ledger exists (P2-a store, P2-c memberships); bindings show handshakes, no attestation; no dispatch or authority',
    'R-RC': 'registration: confirmed',
    'R-RP': 'registration: pending',
    'R-AN': 'attestation: none',
    'R-RV': `revoked: ${longestReason}`,
  };
  assert.deepEqual(LIMITATION_TABLE.map(e => e.id).sort(), Object.keys(PINNED).sort(),
    'every pinned id exists and no id was added silently');
  for (const entry of LIMITATION_TABLE) {
    assert.equal(entry.text, PINNED[entry.id], `${entry.id} literal drifted`);
    const bytes = Buffer.byteLength(entry.text, 'utf8');
    assert.equal(bytes, entry.text.length, `${entry.id} must be printable ASCII (bytes === chars)`);
    assert.ok([...entry.text].every(c => c >= ' ' && c <= '~'), `${entry.id} non-ASCII`);
    assert.ok(bytes <= WIRE_LIMITS[entry.capKey], `${entry.id} ${bytes}B exceeds ${entry.capKey}=${WIRE_LIMITS[entry.capKey]}`);
    assert.equal(limitation(entry.id), entry.text, `${entry.id} accessor agrees`);
  }
  // §4.5 byte column, re-measured: L-B 113, L-P 114, L-S1 94 (N=16), L-S2 102,
  // C-DL 117, R-RC 23, R-RP 21, R-AN 17, R-RV 30.
  const measured = Object.fromEntries(LIMITATION_TABLE.map(e => [e.id, Buffer.byteLength(e.text, 'utf8')]));
  assert.deepEqual(measured, {
    'L-B': 113, 'L-P': 114, 'L-S1': 94, 'L-S2': 102,
    'C-DL': 117, 'R-RC': 23, 'R-RP': 21, 'R-AN': 17, 'R-RV': 30,
  });
  // Render helpers interpolate only the placeholder.
  assert.equal(renderSkippedLedgers(7), `bindings: 7 repo ledger(s) skipped; inspect slp-runtime/state/enforcement/repos/*/ledger.json`);
  assert.equal(renderRevoked('archived'), 'revoked: archived');
  // §4.5 worst-case: the P0 static count + one dynamic entry stays under cap.
  assert.ok(
    P0_STATIC_LIMITATIONS.length + 1 <= WIRE_LIMITS.limitations,
    'view limitations worst case must fit the collection cap',
  );
});

test('P2-e §4.4: 16 is the largest bindings cap whose worst-case view stays under 64 KiB', () => {
  const audit = fixtureAudit();
  // §4.4 builder per errata E-P2E-2 (contract-p2e-errata.vi.md): collections
  // sit at their caps; every CALLER- or DATA-DERIVED string is escape-filled
  // at its wire cap (target.*, installation.*, membershipId, agentId — the
  // seed escape of P0/P2-b). Producer-fixed strings stay at their real
  // pinned bytes —
  // capability/gap rows are compile-time literals in capabilities.ts (P0's
  // normative fixture uses `audit.records`/`audit.gaps` verbatim), and
  // limitations are the pinned §4.5 literals at their worst combination
  // (§4.5: static count + one dynamic; L-P is the longest dynamic), never
  // escape-filled schema-freak content — schema-only maxima on
  // producer-fixed fields belong to the overflow fixture, which already
  // proves the emit guard fails closed.
  const worstLimitations = [
    ...P0_STATIC_LIMITATIONS,
    [limitation('L-P'), limitation('L-S2'), renderSkippedLedgers(WIRE_LIMITS.bindingsRepos)]
      .reduce((a, b) => (b.length > a.length ? b : a)),
  ];
  const fatBindingWorst = () => ({
    schemaVersion: 1,
    membershipId: escapeFill(WIRE_LIMITS.membershipId),
    agentId: escapeFill(WIRE_LIMITS.agentId),
    family: 'codex',
    state: 'revoked',
    epoch: Number.MAX_SAFE_INTEGER,
    observedAt: NOW,
    limitations: [
      limitation('R-RC'), limitation('R-AN'), renderRevoked('registration-mismatch'),
    ],
  });
  const worstAt = n => GetEnforcementStatusOutput.parse({
    schemaVersion: 1,
    target: {
      hostId: escapeFill(WIRE_LIMITS.targetHostId),
      daemonHome: '/' + escapeFill(WIRE_LIMITS.targetDaemonHome - 1),
    },
    generatedAt: NOW,
    installation: {
      state: escapeFill(WIRE_LIMITS.installationState),
      revision: Number.MAX_SAFE_INTEGER,
      bound: true,
      error: escapeFill(WIRE_LIMITS.installationError),
    },
    capabilities: audit.records,
    gaps: audit.gaps,
    bindings: Array.from({ length: n }, fatBindingWorst),
    limitations: worstLimitations,
    completeness: allPairs(),
    acceptance: 'not-established-by-this-view',
  });
  // Candidate set from the contract: {64, 32, 16} — measure all three
  // (the schema caps bindings at WIRE_LIMITS.bindings, so the over-cap
  // candidates are measured on the pre-parse object).
  const measured = Object.fromEntries(
    [64, 32, 16].map(n => [n, utf8Bytes({ ...worstAt(Math.min(n, WIRE_LIMITS.bindings)), bindings: Array.from({ length: n }, fatBindingWorst) })]),
  );
  console.info('P2-e bindings worst-case fixture', { measured, cap: WIRE_LIMITS.bindings });
  // 64 and 32 exceed the schema cap anyway; byte-wise they are also over.
  assert.ok(measured[64] > MAX_RPC_BYTES && measured[32] > MAX_RPC_BYTES);
  assert.ok(measured[16] < MAX_RPC_BYTES, `worst-case at cap 16 is ${measured[16]} bytes`);
  assert.equal(WIRE_LIMITS.bindings, 16, 'the largest fitting candidate');
  // The at-cap fixture passes the emit guard verbatim.
  const atCap = worstAt(WIRE_LIMITS.bindings);
  assert.deepEqual(boundStatusView(atCap), atCap);
});

test('P2-e: capabilities row enforcement.desk-ledger keeps unsupported and carries C-DL', () => {
  const { records } = auditCapabilities({ now: NOW, observed: silentHost });
  const row = records.find(r => r.capabilityId === 'enforcement.desk-ledger');
  assert.equal(row.status, 'unsupported');
  assert.ok(row.limitations.includes(limitation('C-DL')));
  // The old P0 literal must be gone (mutation-sensitive pin).
  assert.equal(row.limitations.some(l => l.includes('does not exist')), false);
});
