import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../plugin/server/runtime/cli/package.ts';
import { createDeskBridge } from '../plugin/server/desk-bridge.ts';
import { canonicalSha256 } from '../plugin/server/config-view.ts';
import { createDeskStore } from '../plugin/server/desk-store.ts';
import { auditCapabilities } from '../plugin/server/capabilities.ts';
import { DESK_BRIDGE_PROTOCOL } from '../plugin/shared/enforcement.ts';
import { gitRepo, hello, handshake, memberRow, repoOf, rpc, seedMemberships } from './helpers/desk-bridge-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const bridgeSha256 = createHash('sha256').update(readFileSync(join(root, 'bin/slp-desk-mcp.mjs'))).digest('hex');
const at = '2026-01-01T00:00:00.000Z';
const codexProfile = { id: 'slp-lead', provider: 'slp-codex-lead', model: 'gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast_mode: true } };

function managedBridge(t, options = {}) {
  const { afterCreate, profile = codexProfile, reportedModeId, omitCurrentModeId, providerEntries } = options;
  const providerModes = Object.hasOwn(options, 'providerModes') ? options.providerModes : [{ id: 'full-access' }];
  const includeProviderModes = options.includeProviderModes !== false;
  const dir = mkdtempSync(join(tmpdir(), 'slp-managed-formation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const repo = gitRepo(t, 'slp-managed-formation-repo-');
  const home = join(dir, 'home');
  const stableRoot = join(home, 'slp-runtime');
  mkdirSync(stableRoot, { recursive: true });

  const candidates = [
    { candidateSha256: 'a'.repeat(64), launchSetSha256: 'c'.repeat(64) },
    { candidateSha256: 'b'.repeat(64), launchSetSha256: 'd'.repeat(64) },
  ];
  for (const candidate of candidates) {
    install(root, join(stableRoot, candidate.candidateSha256));
    mkdirSync(join(stableRoot, 'launchers', candidate.launchSetSha256), { recursive: true });
  }
  const bindingFor = candidate => ({
    bindingSha256: candidate.candidateSha256,
    candidateSha256: candidate.candidateSha256,
    payloadSha256: candidate.candidateSha256,
    runtimePath: join(stableRoot, candidate.candidateSha256),
    launchSetSha256: candidate.launchSetSha256,
    launchManifestSha256: candidate.launchSetSha256,
    node: { path: process.execPath, version: process.version },
  });
  let currentBinding = bindingFor(candidates[0]);
  const verifiedLaunchSets = [];
  const journal = { read: () => ({ state: 'ACTIVE', binding: structuredClone(currentBinding) }) };
  const launchers = {
    verify: async path => {
      const launchSetSha256 = basename(path);
      verifiedLaunchSets.push(launchSetSha256);
      assert.ok(candidates.some(item => item.launchSetSha256 === launchSetSha256), `unexpected launch set ${launchSetSha256}`);
      return {
        directory: realpathSync(path),
        files: [],
        launchSetSha256,
        launchManifestSha256: launchSetSha256,
        bridgeSha256,
        bridgeProtocolVersion: DESK_BRIDGE_PROTOCOL,
      };
    },
  };
  const parent = { id: 'parent', provider: profile.provider, workspaceId: 'workspace', archivedAt: null };
  const paseoRef = { current: { agents: { ref: id => ({ refresh: async () => ({ agent: id === parent.id ? parent : null, project: null }) }) } } };

  const effects = { creates: [], sends: [] };
  let childSnapshot = null;
  const childHandle = id => ({
    id,
    refresh: async () => ({ agent: id === 'child' ? childSnapshot : null, project: null }),
    send: async (text, options) => effects.sends.push({ text, options }),
    archive: async () => ({ archivedAt: at }),
    waitForFinish: async () => null,
    timeline: { refetch: async () => ({ entries: [] }) },
  });
  const createChild = async (workspaceId, options) => {
    effects.creates.push({ workspaceId, options: structuredClone(options) });
    const combined = options.config.provider;
    const slash = combined.indexOf('/');
    childSnapshot = {
      id: 'child',
      provider: combined.slice(0, slash),
      model: combined.slice(slash + 1),
      cwd: repo.dir,
      workspaceId,
      archivedAt: null,
      labels: { ...options.labels, 'paseo.parent-agent-id': options.parent },
      ...(!omitCurrentModeId ? { currentModeId: options.config.modeId !== undefined ? options.config.modeId : reportedModeId } : {}),
      thinkingOptionId: options.config.thinkingOptionId,
      features: Object.entries(options.config.featureValues ?? {}).map(([id, value]) => ({ id, value })),
    };
    afterCreate?.(() => { currentBinding = bindingFor(candidates[1]); });
    return childHandle('child');
  };
  const taskHost = {
    providers: { snapshot: async () => ({ entries: providerEntries ?? (() => {
      const entry = { provider: profile.provider, enabled: true, status: 'ready' };
      if (includeProviderModes) entry.modes = providerModes;
      return [entry];
    })() }) },
    agents: {
      ref: id => childHandle(id),
      create: async options => createChild('workspace', options),
      list: async () => ({ entries: [] }),
    },
    workspaces: { ref: id => ({ agents: { create: options => createChild(id, options) } }) },
  };
  writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [profile] } }));

  const bridge = createDeskBridge({
    journal,
    launchers,
    payload: { files: [{ path: 'bin/slp-desk-mcp.mjs', sha256: bridgeSha256 }] },
    paseoRef,
    taskHost: () => taskHost,
    audit: auditCapabilities,
    detectDaemonHome: () => ({ daemonHome: home, source: 'env' }),
    realpath: realpathSync,
    createStore: path => createDeskStore({ stableRoot: path }),
    warn: () => {},
  });
  void bridge.start();
  return {
    home, stableRoot, candidates, bindingFor, profile, setBinding: candidate => { currentBinding = bindingFor(candidate); },
    verifiedLaunchSets, bridge, paseoRef, effects,
    ready: bridge.whenReady(),
    repo,
  };
}

async function boundFormationSeat(t, options) {
  const f = managedBridge(t, options);
  assert.equal(await f.ready, 'listening');
  t.after(() => f.bridge.stop());
  const handle = `formation-${randomUUID()}`;
  const row = memberRow(handle, { provider: f.profile.provider, at }, {
    role: 'lead', agentId: 'parent', createCwd: f.repo.dir, workspaceId: 'workspace',
  });
  await seedMemberships(createDeskStore({ stableRoot: f.stableRoot }), repoOf(f.repo), [row]);
  const { conn, reader, ack } = await handshake(f.bridge.socketPath(), hello(bridgeSha256, handle));
  t.after(() => conn.destroy());
  assert.equal(ack.ok, true);
  f.bridge.noteDispatch(f.paseoRef.current);
  return { ...f, conn, reader, row };
}

const seatCreate = requestId => ({
  requestId, role: 'lead', taskLabel: 'bounded work', assignment: 'Implement the assigned outcome.', grantRef: 'human:assignment',
});

async function callTool(f, id, name, args) {
  const reply = await rpc(f.reader, f.conn, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(reply.result?.content?.[0]?.text, `missing ${name} result: ${JSON.stringify(reply)}`);
  return JSON.parse(reply.result.content[0].text);
}

test('slp_seat_create adopts a newly verified binding when it changes before invocation and pins the child report route', async t => {
  const f = await boundFormationSeat(t);
  f.setBinding(f.candidates[1]);

  const out = await callTool(f, 1, 'slp_seat_create', { ...seatCreate('before-invoke'), delivery: 'server' });
  assert.equal(out.state, 'recorded', JSON.stringify(out));
  assert.equal(out.result.state, 'host-accepted', JSON.stringify(out));
  assert.equal(out.acceptance, 'not-established-by-this-receipt');
  assert.ok(f.verifiedLaunchSets.includes(f.candidates[1].launchSetSha256), 'the invocation verifies the current launch set');
  assert.equal(f.effects.creates.length, 1);
  assert.equal(f.effects.sends.length, 1);
  assert.equal(f.effects.creates[0].options.parent, 'parent');
  assert.equal(f.effects.creates[0].options.labels['slp.formation'], out.phases[1].value.label);
  assert.equal(f.effects.creates[0].options['notifyOnFinish'], undefined, 'finish callback is not the report or acceptance route');
  assert.match(f.effects.sends[0].text, /Handback route: the verified parent agent ID is parent\./);
  assert.match(f.effects.sends[0].text, /At handback, send exactly one native report to the verified parent above\./);
  assert.match(f.effects.sends[0].text, /A finish notification only signals the event; it does not replace the report or establish acceptance\./);
  assert.match(f.effects.sends[0].text, /A standby Lead reports readiness separately; readiness is not a technical verdict\./);
  assert.equal(f.effects.sends.length, 1, 'formation sends one assignment; it does not create an acknowledgment loop');
  assert.equal(out.result.notification, 'native-finish-callback-not-established; child reports to observed parent');
});

test('slp_seat_create defaults to caller delivery: no SDK send and an exact send_agent_prompt notifyOnFinish handoff', async t => {
  const f = await boundFormationSeat(t);
  const out = await callTool(f, 1, 'slp_seat_create', seatCreate('caller-delivery'));
  assert.equal(out.state, 'recorded', JSON.stringify(out));
  assert.equal(out.result.state, 'awaiting-caller-delivery', JSON.stringify(out.result));
  assert.equal(f.effects.creates.length, 1); assert.equal(f.effects.sends.length, 0);
  assert.equal(out.result.sent, false);
  const handoff = out.result.delivery;
  assert.equal(handoff.tool, 'send_agent_prompt'); assert.equal(handoff.notifyOnFinish, true); assert.equal(handoff.agentId, 'child');
  assert.equal(handoff.promptSha256, canonicalSha256(handoff.prompt));
  assert.match(handoff.prompt, /A finish notification only signals the event; it does not replace the report or establish acceptance\./);
  assert.equal(out.phases.at(-1).name, 'delivery-handed-off'); assert.equal(out.phases.at(-1).value.promptSha256, handoff.promptSha256);
  const replay = await callTool(f, 2, 'slp_seat_create', seatCreate('caller-delivery'));
  assert.equal(replay.replayed, true); assert.equal(replay.receiptSha256, out.receiptSha256);
  assert.equal(f.effects.creates.length, 1); assert.equal(f.effects.sends.length, 0);
});

test('Pi lead with a fresh empty mode catalog creates without inventing or inheriting a permission mode', async t => {
  const profile = {
    id: 'slp-lead', provider: 'slp-pi-lead', model: 'openai-codex/gpt-6-luna', modeId: null,
    thinkingOptionId: 'medium', featureValues: {},
  };
  const f = await boundFormationSeat(t, { profile, providerModes: [], reportedModeId: null });
  const out = await callTool(f, 1, 'slp_seat_create', { ...seatCreate('pi-no-mode'), delivery: 'server' });
  assert.equal(out.state, 'recorded', JSON.stringify(out));
  assert.equal(out.result.state, 'host-accepted', JSON.stringify(out.result));
  assert.equal(f.effects.creates.length, 1);
  assert.equal(f.effects.sends.length, 1);
  assert.equal(f.effects.creates[0].options.config.provider, 'slp-pi-lead/openai-codex/gpt-6-luna');
  assert.equal(Object.hasOwn(f.effects.creates[0].options.config, 'modeId'), false);
  assert.equal(f.effects.creates[0].options.config.thinkingOptionId, 'medium');
  assert.deepEqual(f.effects.creates[0].options.config.featureValues, {});
  assert.deepEqual(out.phases[0].value.modeSupport, { provider: 'slp-pi-lead', modes: [] });
});

test('empty-mode provider rejects an omitted currentModeId and retains child identity without sending', async t => {
  const profile = { ...codexProfile, provider: 'slp-pi-lead', model: 'openai-codex/gpt-6-luna', modeId: null };
  const f = await boundFormationSeat(t, { profile, providerModes: [], omitCurrentModeId: true });
  const out = await callTool(f, 1, 'slp_seat_create', seatCreate('pi-mode-unreported'));
  assert.equal(out.result.state, 'identity-uncertain', JSON.stringify(out.result));
  assert.equal(out.result.agentId, 'child');
  assert.deepEqual(out.result.verification.mismatches, ['mode:unsupported:unreported']);
  assert.equal(f.effects.creates.length, 1);
  assert.equal(Object.hasOwn(f.effects.creates[0].options.config, 'modeId'), false);
  assert.equal(f.effects.sends.length, 0);
  const receipt = await callTool(f, 2, 'slp_operation_get', { kind: 'seat-create', requestId: 'pi-mode-unreported' });
  assert.equal(receipt.result.agentId, 'child');
  assert.deepEqual(receipt.phases.map(phase => phase.name), [
    'prepared', 'create-issued', 'create-returned', 'create-observed',
  ]);
});

test('a saved Pi mode absent from the fresh provider snapshot is rejected before native create', async t => {
  const profile = { ...codexProfile, provider: 'slp-pi-lead', model: 'openai-codex/gpt-6-luna', modeId: 'full-access' };
  const f = await boundFormationSeat(t, { profile, providerModes: [] });
  const out = await callTool(f, 1, 'slp_seat_create', seatCreate('pi-unsupported-mode'));
  assert.equal(out.result.code, 'INVALID_RECORD', JSON.stringify(out.result));
  assert.equal(f.effects.creates.length, 0);
  assert.equal(f.effects.sends.length, 0);
});

test('a missing provider modes field does not prove that modeId is unsupported', async t => {
  const profile = { ...codexProfile, provider: 'slp-pi-lead', model: 'openai-codex/gpt-6-luna', modeId: null };
  const f = await boundFormationSeat(t, { profile, includeProviderModes: false });
  const out = await callTool(f, 1, 'slp_seat_create', seatCreate('pi-unknown-modes'));
  assert.equal(out.result.code, 'CAPABILITY_GAP', JSON.stringify(out.result));
  assert.equal(f.effects.creates.length, 0);
  assert.equal(f.effects.sends.length, 0);
});

test('an empty modes list from a different provider cannot authorize mode omission', async t => {
  const profile = { ...codexProfile, provider: 'slp-pi-lead', model: 'openai-codex/gpt-6-luna', modeId: null };
  const f = await boundFormationSeat(t, { profile, providerEntries: [
    { provider: 'slp-other-lead', enabled: true, status: 'ready', modes: [] },
    { provider: 'slp-pi-lead', enabled: true, status: 'ready' },
  ] });
  const out = await callTool(f, 1, 'slp_seat_create', seatCreate('pi-other-provider-modes'));
  assert.equal(out.result.code, 'CAPABILITY_GAP', JSON.stringify(out.result));
  assert.equal(f.effects.creates.length, 0);
  assert.equal(f.effects.sends.length, 0);
});

test('a provider with advertised modes cannot bypass an unresolved saved profile mode', async t => {
  const profile = { ...codexProfile, modeId: null };
  const f = await boundFormationSeat(t, { profile, providerModes: [{ id: 'full-access' }, { id: 'auto' }] });
  const out = await callTool(f, 1, 'slp_seat_create', seatCreate('codex-unresolved-mode'));
  assert.equal(out.result.code, 'CAPABILITY_GAP', JSON.stringify(out.result));
  assert.equal(f.effects.creates.length, 0);
  assert.equal(f.effects.sends.length, 0);
});

test('empty-mode provider verification rejects a host-reported inherited mode and withholds assignment', async t => {
  const profile = { ...codexProfile, provider: 'slp-pi-lead', model: 'openai-codex/gpt-6-luna', modeId: null };
  const f = await boundFormationSeat(t, { profile, providerModes: [], reportedModeId: 'inherited-mode' });
  const out = await callTool(f, 1, 'slp_seat_create', seatCreate('pi-inherited-mode'));
  assert.equal(out.result.state, 'identity-uncertain', JSON.stringify(out.result));
  assert.deepEqual(out.result.verification.mismatches, ['mode:unsupported:inherited-mode']);
  assert.equal(f.effects.creates.length, 1);
  assert.equal(Object.hasOwn(f.effects.creates[0].options.config, 'modeId'), false);
  assert.equal(f.effects.sends.length, 0);
});

test('slp_seat_create retains the observed child and withholds assignment when binding changes after native create', async t => {
  const f = await boundFormationSeat(t, { afterCreate: rebind => rebind() });
  const create = f.effects;
  // The fixture changes the active receipt only after the host create effect
  // returns, so all pre-create guards observe candidate A.
  const out = await callTool(f, 1, 'slp_seat_create', seatCreate('during-effect'));
  assert.equal(out.state, 'recorded', JSON.stringify(out));
  assert.equal(out.acceptance, 'not-established-by-this-receipt');
  assert.equal(out.result.code, 'CANDIDATE_DRIFT', JSON.stringify(out.result));
  assert.equal(out.result.ok, false);
  assert.equal(out.result.agentId, 'child', 'the already-created native identity remains inspectable');
  assert.equal(Object.hasOwn(out.result, 'state'), false, 'drift is not mislabeled as a created/accepted result');
  assert.equal(Object.hasOwn(out.result, 'sent'), false, 'no delivery is claimed after drift');
  assert.equal(create.creates.length, 1);
  assert.equal(create.sends.length, 0, 'a changed binding blocks assignment delivery');

  const receipt = await callTool(f, 2, 'slp_operation_get', { kind: 'seat-create', requestId: 'during-effect' });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.result.agentId, 'child');
  assert.deepEqual(receipt.phases.map(phase => phase.name), [
    'prepared', 'create-issued', 'create-returned', 'create-observed',
  ]);
  const replay = await callTool(f, 3, 'slp_seat_create', seatCreate('during-effect'));
  assert.equal(replay.replayed, true);
  assert.equal(create.creates.length, 1, 'the same request never repeats a native effect');
  assert.equal(create.sends.length, 0);
});
