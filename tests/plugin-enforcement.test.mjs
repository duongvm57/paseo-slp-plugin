// tests/plugin-enforcement.test.mjs — P0 enforcement desk coverage:
// wire/view schemas, the closed seat-binding transition vocabulary,
// toolPolicy preapproval merge semantics, the capability audit's
// unknown-by-default floor and per-family probe rows, and the read-only
// readView/dispatch seam under the capability-rows-only contract —
// provider projection is the P1 backlog (gap `providerTools-projection`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { emptyReceipt } from '../plugin/server/journal.ts';
import { readRawConfig } from '../plugin/server/config-view.ts';
import { MAX_RPC_BYTES, OperationConflict } from '../plugin/shared/contracts.ts';
import { FetchAgentsResponseMessageSchema } from '@getpaseo/protocol/messages';
import { FAMILY_IDS } from '../plugin/shared/families.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function tmp(t, prefix = 'enf-') {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/', prefix));
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
  // P0 never projects provider policy, per-agent models or binding rows.
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
  assert.equal(arrayCap(out.bindings), 0, 'bindings is literal [] — non-empty is producer-invalid');
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
  // still carries the mandatory row; bindings has only the literal-zero state.
  const collections = [
    ['capabilities', WIRE_LIMITS.capabilities],
    ['gaps', WIRE_LIMITS.gaps],
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
  // bindings: only the literal-empty state exists; one row is producer-invalid.
  assert.doesNotThrow(() => GetEnforcementStatusOutput.parse(fixtureAt({ bindings: 0 })));
  const withBinding = fixtureAt();
  withBinding.bindings = [fatBinding()];
  assert.equal(GetEnforcementStatusOutput.safeParse(withBinding).success, false);
  assert.throws(
    () => boundStatusView(withBinding),
    error => error instanceof OperationConflict && error.code === 'IO_FAILURE',
  );
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
