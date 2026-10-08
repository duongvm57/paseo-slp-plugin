// tests/plugin-desk-bridge.test.mjs — P2-d desk MCP bridge coverage
// (contract §7). Every guard and lifecycle claim is exercised against the
// REAL Unix socket the adapter binds under a tmp daemon home — never the
// real daemon home, never the repo tree. Launch-set verify and the host
// SDK are structural doubles; the desk store, socket, lockfile and wire
// frames are real.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BIN_SOURCE,
  bridgeFixture as deskBridgeFixture,
  gitRepo as deskGitRepo,
  startBridge,
  memberRow as deskMemberRow,
  repoOf,
  seedMemberships,
  seedStore,
  hello,
  handshake,
  rpc,
  tmp,
  connect,
  LineReader,
} from './helpers/desk-bridge-fixture.mjs';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  createDeskStore,
  deskRepoPaths,
  repoKeyFor,
} from '../plugin/server/desk-store.ts';
import { auditCapabilities, CAPABILITY_IDS } from '../plugin/server/capabilities.ts';
import { roleBundle } from '../plugin/server/runtime/cli/role-bundle.ts';
import { spawnKit } from '../plugin/server/runtime/cli/spawn-kit.ts';
import { SETTLEMENT_VIA } from '../plugin/server/runtime/cli/report-records.ts';
import { decideDeskHandback } from '../plugin/server/desk-handback.ts';
import { DESK_TOOL_CATALOG } from '../plugin/server/desk-bridge.ts';
import { sha256Hex } from '../plugin/server/config-view.ts';
import {
  DESK_BRIDGE_PROTOCOL,
  DeskBridgeToolEntry,
  DeskBridgeAck,
  DeskSeatStatus,
  WIRE_LIMITS,
} from '../plugin/shared/enforcement.ts';
import { DeskSeatCreateInput } from '../plugin/shared/delegation.ts';
import { DeskTaskDispatchInput, DeskTaskIntegrateInput } from '../plugin/shared/enforcement.ts';

const REQUEST_CAP = WIRE_LIMITS.deskBridgeRequestBytes;
const RESPONSE_CAP = WIRE_LIMITS.deskBridgeResponseBytes;
const FIXED_AT = '2026-01-01T00:00:00.000Z';
const PROVIDER = 'slp-codex-peer';
// Real pin: these fixtures verify packaged-binary graft integrity.
const PIN = sha256Hex(readFileSync(BIN_SOURCE));

const gitRepo = t => deskGitRepo(t, 'slp-bridge-repo-');

/** A tmp daemon home whose launch-set directory exists (the verify double
 *  realpaths it) and whose candidate ships the real packaged binary. */
function bridgeFixture(t, over = {}) {
  return deskBridgeFixture(t, 'slp-bridge-home-', PIN, over);
}

async function started(t, over = {}) {
  const f = await startBridge(t, bridgeFixture(t, over));
  return f;
}

// ---------------------------------------------------------------------------
// store + membership fixtures
// ---------------------------------------------------------------------------

const memberRow = (handle, over = {}) =>
  deskMemberRow(handle, { provider: PROVIDER, at: FIXED_AT }, over);

const seedMembership = (store, repo, row) => seedMemberships(store, repo, [row]);

// ---------------------------------------------------------------------------
// socket client helpers — one parsed NDJSON frame at a time
// ---------------------------------------------------------------------------

const HELLO = (handle, over = {}) => hello(PIN, handle, over);

const livePaseo = agent => ({
  agents: { ref: () => ({ refresh: async () => ({ agent }) }) },
});

const LIVE_AGENT = { provider: PROVIDER, workspaceId: 'wks-1', archivedAt: null };

// ---------------------------------------------------------------------------
// lifecycle — bind, modes, lock, stop
// ---------------------------------------------------------------------------

test('start binds the socket 0600 under enforcement/, takes the repo lock, stop cleans up', async t => {
  const f = await started(t);
  assert.equal(f.outcome, 'listening');
  assert.equal(f.bridge.state().kind, 'listening');
  assert.equal(f.bridge.socketPath(), f.paths.socketPath);

  assert.equal(statSync(f.paths.socketPath).mode & 0o777, 0o600);
  assert.equal(statSync(f.paths.enforcementDir).mode & 0o777, 0o700);
  const holder = JSON.parse(readFileSync(f.paths.lockPath, 'utf8'));
  assert.equal(holder.pid, process.pid);
  assert.equal(typeof holder.instanceNonce, 'string');
  assert.equal(f.paths.repoKey, repoKeyFor({ hostId: 'desk-bridge', gitCommonDir: 'desk-bus' }));

  f.bridge.stop();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(existsSync(f.paths.socketPath), false);
  assert.equal(existsSync(f.paths.lockPath), false);
  assert.equal(f.bridge.state().kind, 'unavailable');
});

test('Windows is a typed CAPABILITY_GAP, never a fake adapter', async t => {
  const f = await started(t, { platform: 'win32' });
  assert.equal(f.outcome, 'unavailable');
  assert.deepEqual(f.bridge.state(), {
    kind: 'unavailable',
    code: 'CAPABILITY_GAP',
    reason: 'no Windows transport — unix-socket only',
  });
  assert.equal(existsSync(f.paths.socketPath), false);
});

test('a binding-less home leaves the bridge inert (CAPABILITY_GAP)', async t => {
  const f = await started(t, { journal: { read: () => ({ binding: null }) } });
  assert.equal(f.outcome, 'unavailable');
  assert.equal(f.bridge.state().code, 'CAPABILITY_GAP');
  assert.match(f.bridge.state().reason, /no active SLP binding/);
  assert.equal(existsSync(f.paths.socketPath), false);
});

test('a binding whose runtimePath diverges from the verified launch root is CANDIDATE_DRIFT', async t => {
  const f = await started(t, {
    journal: {
      read: () => ({
        binding: {
          launchSetSha256: 'a'.repeat(64),
          runtimePath: '/elsewhere/candidate',
          node: { path: process.execPath },
          candidateSha256: 'b'.repeat(64),
        },
      }),
    },
  });
  assert.equal(f.outcome, 'unavailable');
  assert.equal(f.bridge.state().code, 'CANDIDATE_DRIFT');
});

// ---------------------------------------------------------------------------
// lifecycle lock — reserved repo namespace, fail-closed classes
// ---------------------------------------------------------------------------

test('a dead foreign lock holder is reclaimed with the recovery seam audit before binding', async t => {
  const f = bridgeFixture(t, { kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
  mkdirSync(f.paths.repoDir, { recursive: true });
  const bytes = JSON.stringify({ pid: 424242, instanceNonce: 'foreign', startedAt: FIXED_AT }) + '\n';
  writeFileSync(f.paths.lockPath, bytes);
  assert.equal((await startBridge(t, f)).outcome, 'listening');
  const paths = deskRepoPaths(f.stableRoot, f.paths.repoKey);
  const audit = JSON.parse(readFileSync(paths.auditPath, 'utf8').trim());
  assert.equal(audit.phase, 'pre-unlink');
  assert.equal(audit.actorKey, 'plugin:desk-bridge');
  assert.equal(audit.pid, 424242);
  assert.equal(audit.instanceNonce, 'foreign');
  assert.equal(audit.lockSha256, sha256Hex(bytes));
  assert.equal(audit.repoKey, f.paths.repoKey);
  assert.equal(JSON.parse(readFileSync(f.paths.lockPath, 'utf8')).pid, process.pid);
  assert.equal(existsSync(paths.recoverLockPath), false);
});

test('a proven process-start mismatch reclaims the stale bridge instance, with audit', async t => {
  const f = bridgeFixture(t, { kill: () => {}, processIdentity: () => 'boot:200' });
  mkdirSync(f.paths.repoDir, { recursive: true });
  writeFileSync(f.paths.lockPath, JSON.stringify({ pid: 424242, instanceNonce: 'old', processIdentity: 'boot:100' }));
  assert.equal((await startBridge(t, f)).outcome, 'listening');
  assert.equal(JSON.parse(readFileSync(deskRepoPaths(f.stableRoot, f.paths.repoKey).auditPath, 'utf8')).instanceNonce, 'old');
});

test('a reused live pid without recorded process identity is untouched', async t => {
  const f = bridgeFixture(t, { kill: () => {}, processIdentity: () => 'boot:200' });
  mkdirSync(f.paths.repoDir, { recursive: true });
  const bytes = JSON.stringify({ pid: 424242, instanceNonce: 'old', startedAt: FIXED_AT });
  writeFileSync(f.paths.lockPath, bytes);
  assert.equal((await startBridge(t, f)).outcome, 'unavailable');
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), bytes);
  assert.equal(existsSync(deskRepoPaths(f.stableRoot, f.paths.repoKey).auditPath), false);
});

test('a replacement live holder during recovery is untouched and unaudited', async t => {
  let probes = 0;
  let f;
  const replacement = JSON.stringify({ pid: 434343, instanceNonce: 'new-live', processIdentity: 'boot:200' });
  f = bridgeFixture(t, { kill: () => {
    if (++probes === 2) writeFileSync(f.paths.lockPath, replacement);
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  } });
  mkdirSync(f.paths.repoDir, { recursive: true });
  writeFileSync(f.paths.lockPath, JSON.stringify({ pid: 424242, instanceNonce: 'dead' }));
  assert.equal((await startBridge(t, f)).outcome, 'unavailable');
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), replacement);
  assert.equal(existsSync(deskRepoPaths(f.stableRoot, f.paths.repoKey).auditPath), false);
});

test('an unreadable process-start identity cannot authorize reclaim', async t => {
  const f = bridgeFixture(t, { kill: () => {}, processIdentity: () => null });
  mkdirSync(f.paths.repoDir, { recursive: true });
  const bytes = JSON.stringify({ pid: 424242, instanceNonce: 'old', processIdentity: 'boot:100' });
  writeFileSync(f.paths.lockPath, bytes);
  assert.equal((await startBridge(t, f)).outcome, 'unavailable');
  assert.equal(f.bridge.state().code, 'RECOVERY_REQUIRED');
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), bytes);
});

test('a malformed lock holder is RECOVERY_REQUIRED', async t => {
  const f = bridgeFixture(t);
  mkdirSync(f.paths.repoDir, { recursive: true });
  writeFileSync(f.paths.lockPath, 'not-json-at-all\n');
  void f.bridge.start();
  const outcome = await f.bridge.whenReady();
  t.after(() => f.bridge.stop());
  assert.equal(outcome, 'unavailable');
  assert.equal(f.bridge.state().code, 'RECOVERY_REQUIRED');
  assert.match(f.bridge.state().reason, /malformed/);
});

test('a live foreign holder is never stolen — bounded wait ends desk-busy', async t => {
  const f = bridgeFixture(t, { kill: () => { /* alive */ } });
  mkdirSync(f.paths.repoDir, { recursive: true });
  writeFileSync(
    f.paths.lockPath,
    JSON.stringify({ pid: 424242, instanceNonce: 'foreign-live' }) + '\n',
  );
  const t0 = Date.now();
  void f.bridge.start();
  const outcome = await f.bridge.whenReady();
  t.after(() => f.bridge.stop());
  assert.equal(outcome, 'unavailable');
  assert.equal(f.bridge.state().code, 'CAPABILITY_GAP');
  assert.match(f.bridge.state().reason, /desk-busy/);
  assert.match(f.bridge.state().reason, /do not respawn the bridge/);
  assert.ok(Date.now() - t0 < 10000, 'bounded wait respected');
  assert.equal(JSON.parse(readFileSync(f.paths.lockPath, 'utf8')).instanceNonce, 'foreign-live');
  assert.equal(existsSync(deskRepoPaths(f.stableRoot, f.paths.repoKey).auditPath), false);
  assert.equal(existsSync(f.paths.socketPath), false);
});

// F4 — releaseLock ownership: the bridge unlinks only a lock still owned
// by THIS instance ({pid, instanceNonce} both match). A foreign rewrite is
// preserved; a vanished lock is tolerated. (desk-store releaseLock parity.)

test('F4: stop() never unlinks a foreign-owned bridge lock', async t => {
  const f = await started(t);
  assert.equal(existsSync(f.paths.lockPath), true);
  // A racing instance replaced the holder record — same path, foreign
  // pid+nonce. releaseLock must leave those bytes in place.
  const foreign = JSON.stringify({ pid: 424242, instanceNonce: 'foreign-nonce', startedAt: FIXED_AT }) + '\n';
  writeFileSync(f.paths.lockPath, foreign);
  f.bridge.stop();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(existsSync(f.paths.lockPath), true);
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), foreign);
  assert.ok(f.warnings.some(line => /not owned by this instance/.test(line)));
  // The socket is still cleaned up — only the foreign lock survives.
  assert.equal(existsSync(f.paths.socketPath), false);
});

test('F4: stop() tolerates an already-vanished lock — logged, never invented', async t => {
  const f = await started(t);
  rmSync(f.paths.lockPath);
  f.bridge.stop();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(existsSync(f.paths.lockPath), false);
  assert.ok(f.warnings.some(line => /unreadable|left in place/.test(line)));
});

// ---------------------------------------------------------------------------
// handshake — hello schema, binary pin, seat resolution
// ---------------------------------------------------------------------------

test('old-format rejection ack still parses under slp-desk-bridge/1', () => {
  const old = { schemaVersion: 1, protocol: DESK_BRIDGE_PROTOCOL, ok: false,
    error: { code: 'ACTOR_MISMATCH', message: 'rejected' } };
  assert.deepEqual(DeskBridgeAck.parse(old), old);
  const current = { ...old, error: { ...old.error, recovery: 'tell the Lead; reconnecting cannot repair this binding' } };
  assert.deepEqual(DeskBridgeAck.parse(current), current);
});

test('hello roundtrip: valid handshake answers the protocol ack', async t => {
  const f = await started(t);
  const git = gitRepo(t);
  const store = seedStore(f);
  const handle = 'handle-secret-1';
  await seedMembership(store, repoOf(git), memberRow(handle));

  const { conn, ack } = await handshake(f.paths.socketPath, HELLO(handle));
  t.after(() => conn.destroy());
  assert.deepEqual(ack, {
    schemaVersion: 1,
    protocol: DESK_BRIDGE_PROTOCOL,
    ok: true,
  });
});

test('malformed JSON hello is a typed INVALID_RECORD and the connection closes', async t => {
  const f = await started(t);
  const conn = await connect(f.paths.socketPath);
  const reader = new LineReader(conn);
  conn.write('this is not json\n');
  const line = JSON.parse((await reader.next()).toString('utf8'));
  assert.equal(line.ok, false);
  assert.equal(line.error.code, 'INVALID_RECORD');
  await new Promise(resolve => conn.once('close', resolve));
});

test('a hello that fails the schema is INVALID_RECORD', async t => {
  const f = await started(t);
  const { conn, ack } = await handshake(f.paths.socketPath, { hello: 'nope' });
  t.after(() => conn.destroy());
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'INVALID_RECORD');
  assert.match(ack.error.recovery, /reconnecting cannot/);
  assert.match(ack.error.recovery, /Lead|Human|tooling/);
});

test('handshake budget rejection names tooling recovery', { timeout: 12000 }, async t => {
  const f = await started(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const conn = await connect(f.paths.socketPath);
  t.after(() => conn.destroy());
  const reader = new LineReader(conn);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10000);
  const ack = JSON.parse((await reader.next()).toString());
  assert.equal(ack.error.code, 'INVALID_RECORD');
  assert.match(ack.error.recovery, /reconnecting cannot/);
  assert.match(ack.error.recovery, /tooling/);
});

test('a wrong protocol literal never reaches dispatch', async t => {
  const f = await started(t);
  const { conn, ack } = await handshake(
    f.paths.socketPath,
    HELLO('h', { protocol: 'slp-desk-bridge/0' }),
  );
  t.after(() => conn.destroy());
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'INVALID_RECORD');
  assert.match(ack.error.recovery, /reconnecting cannot/);
  assert.match(ack.error.recovery, /Lead|Human|tooling/);
});

test('a bridge binary hash outside the launch-set pin is CANDIDATE_DRIFT', async t => {
  const f = await started(t);
  const { conn, ack } = await handshake(
    f.paths.socketPath,
    HELLO('h', { bridgeSha256: 'c'.repeat(64) }),
  );
  t.after(() => conn.destroy());
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'CANDIDATE_DRIFT');
  assert.match(ack.error.recovery, /reconnecting cannot/);
  assert.match(ack.error.recovery, /Lead|Human|tooling/);
});

test('a handle with no membership row is ACTOR_MISMATCH', async t => {
  const f = await started(t);
  const git = gitRepo(t);
  await seedMembership(seedStore(f), repoOf(git), memberRow('other-handle'));
  const { conn, ack } = await handshake(f.paths.socketPath, HELLO('unmatched'));
  t.after(() => conn.destroy());
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'ACTOR_MISMATCH');
  assert.match(ack.error.recovery, /reconnecting cannot/);
  assert.match(ack.error.recovery, /Lead|Human|tooling/);
});

test('a revoked membership handle is STALE_EPOCH', async t => {
  const f = await started(t);
  const git = gitRepo(t);
  await seedMembership(
    seedStore(f),
    repoOf(git),
    memberRow('dead-handle', {
      state: 'revoked',
      revokedAt: FIXED_AT,
      revokeReason: 'archived',
    }),
  );
  const { conn, ack } = await handshake(f.paths.socketPath, HELLO('dead-handle'));
  t.after(() => conn.destroy());
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'STALE_EPOCH');
  assert.match(ack.error.recovery, /reconnecting cannot/);
  assert.match(ack.error.recovery, /Lead|Human|tooling/);
});

test('an unbound-open membership cannot bind through the bridge', async t => {
  const f = await started(t);
  const git = gitRepo(t);
  await seedMembership(
    seedStore(f),
    repoOf(git),
    memberRow('open-handle', {
      state: 'unbound-open',
      agentId: null,
      workspaceId: null,
      hostConfirmedAt: null,
      registeredAt: null,
    }),
  );
  const { conn, ack } = await handshake(f.paths.socketPath, HELLO('open-handle'));
  t.after(() => conn.destroy());
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'ACTOR_MISMATCH');
  assert.match(ack.error.recovery, /reconnecting cannot/);
  assert.match(ack.error.recovery, /Lead|Human|tooling/);
});

// ---------------------------------------------------------------------------
// catalog + dispatch guards
// ---------------------------------------------------------------------------

/** Fully-wired seat: seeded membership, live paseo double, bound hello —
 *  plus a real RPC-dispatch evidence mark (E-P2D-4): `noteDispatch` is the
 *  only call a genuine daemon→plugin handler makes; the capability gate
 *  stays closed without it. */
async function boundSeat(t, over = {}) {
  const paseoRef = { current: livePaseo('agent' in over ? over.agent : LIVE_AGENT) };
  const f = await started(t, { ...over, paseoRef });
  f.bridge.noteDispatch(f.paseoRef.current);
  const git = gitRepo(t);
  const handle = over.handle ?? 'handle-1';
  const row = memberRow(handle, over.row);
  const repoKey = await seedMembership(seedStore(f), repoOf(git), row);
  const { conn, reader, ack } = await handshake(f.paths.socketPath, HELLO(handle));
  t.after(() => conn.destroy());
  assert.equal(ack.ok, true, `hello rejected: ${JSON.stringify(ack)}`);
  return { f, git, repo: repoOf(git), handle, row, repoKey, conn, reader, paseoRef };
}

test('tools/list exposes the visible catalog — hidden and excluded tools absent', async t => {
  const { reader, conn } = await boundSeat(t, { row: { role: 'lead' } });
  const reply = await rpc(reader, conn, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = reply.result.tools.map(tool => tool.name);
  assert.deepEqual(names, [
    'slp_status',
    'slp_handback_submit',
    'slp_assignment_register',
    'slp_assignment_attach',
    'slp_assignment_close',
    'slp_assignment_amend',
    'slp_decision_append',
    'slp_workflow_get',
    'slp_settlement_record',
    'slp_settlement_export',
    'slp_scope_declare',
    'slp_scope_transition',
    'slp_scope_review',
    'slp_check_declare',
    'slp_check_run',
    'slp_rollout_declare',
    'slp_rollout_transition',
    'slp_assignment_offer',
    'slp_assignment_accept',
    'slp_task_define',
    'slp_task_dispatch',
    'slp_task_result',
    'slp_task_rule',
    'slp_task_hold',
    'slp_task_stop',
    'slp_task_acknowledge',
    'slp_task_reconcile',
    'slp_task_integrate',
    'slp_task_recap',
    'slp_seat_create',
    'slp_operation_get',
    'slp_task_deliver',
    'slp_task_get',
  ]);
  // MCP clients require the public input schema root to be an object even
  // when zod represents a discriminated union as a top-level anyOf/oneOf.
  for (const tool of reply.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema root`);
  }
  const byName = new Map(reply.result.tools.map(tool => [tool.name, tool]));
  const unions = {
    slp_task_dispatch: ['bootstrap', 'reuse', 'send', 'archive'],
    slp_task_integrate: ['stage', 'check', 'land', 'reconcile', 'discharge'],
    slp_seat_create: ['lead', 'peer'],
  };
  for (const [name, expectedVariants] of Object.entries(unions)) {
    const schema = byName.get(name).inputSchema;
    const branches = schema.oneOf ?? schema.anyOf;
    assert.ok(Array.isArray(branches) && branches.length === expectedVariants.length, `${name} retains every input branch`);
    for (const branch of branches) {
      assert.equal(branch.additionalProperties, false, `${name} branch stays strict`);
    }
    const discriminator = name === 'slp_seat_create' ? 'role' : 'phase';
    assert.deepEqual(branches.map(branch => branch.properties?.[discriminator]?.const).sort(),
      [...expectedVariants].sort(), `${name} retains its discriminated variants`);
  }
  // slp_recover_lock / slp_desk_internal and non-desk verbs are never
  // catalog entries.
  for (const forbidden of ['slp_recover_lock', 'slp_desk_internal', 'slp_review_open', 'slp_decision_record', 'slp_deploy']) {
    assert.ok(!names.includes(forbidden));
  }
  // Every emitted row obeys the centralized wire caps.
  for (const tool of reply.result.tools) {
    assert.ok(tool.name.length <= WIRE_LIMITS.deskBridgeToolName, tool.name);
    assert.ok(
      tool.description.length <= WIRE_LIMITS.deskBridgeToolDescription,
      `${tool.name}: ${tool.description.length} chars over ${WIRE_LIMITS.deskBridgeToolDescription}`,
    );
  }
});

// Every catalog row — visible and hidden alike — must satisfy the shared
// DeskBridgeToolEntry caps; the wire test above only sees the visible half.
test('the whole desk tool catalog satisfies DeskBridgeToolEntry (all rows, centralized caps)', () => {
  assert.ok(DESK_TOOL_CATALOG.length > 0);
  const visible = [];
  for (const row of DESK_TOOL_CATALOG) {
    DeskBridgeToolEntry.parse(row);
    if (row.visible) visible.push(row.name);
  }
  // Sanity: the catalog enumerates the full P3-a + P3-b + P4 + P5 + continuity visible surface.
  assert.deepEqual(visible.sort(), [
    'slp_assignment_accept',
    'slp_assignment_amend',
    'slp_assignment_attach',
    'slp_assignment_close',
    'slp_assignment_offer',
    'slp_assignment_register',
    'slp_check_declare',
    'slp_check_run',
    'slp_decision_append',
    'slp_handback_submit',
    'slp_operation_get',
    'slp_rollout_declare',
    'slp_rollout_transition',
    'slp_scope_declare',
    'slp_scope_review',
    'slp_scope_transition',
    'slp_seat_create',
    'slp_settlement_export',
    'slp_settlement_record',
    'slp_status',
    'slp_task_acknowledge',
    'slp_task_define',
    'slp_task_deliver',
    'slp_task_dispatch',
    'slp_task_get',
    'slp_task_hold',
    'slp_task_integrate',
    'slp_task_recap',
    'slp_task_reconcile',
    'slp_task_result',
    'slp_task_rule',
    'slp_task_stop',
    'slp_workflow_get',
  ]);
});

test('initialize + ping answer; an unknown method is a typed JSON-RPC error', async t => {
  const { reader, conn } = await boundSeat(t);
  const init = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26' },
  });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'slp-desk');
  const ping = await rpc(reader, conn, { jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(ping.result, {});
  const unknown = await rpc(reader, conn, { jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.equal(unknown.error.code, -32601);
  assert.equal(unknown.error.data.slpCode, 'CAPABILITY_GAP');
});

test('slp_status answers the seat-scoped view and nothing more', async t => {
  const { reader, conn, row, repoKey } = await boundSeat(t);
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  const view = DeskSeatStatus.parse(JSON.parse(reply.result.content[0].text));
  assert.equal(view.seat.membershipId, row.membershipId);
  assert.equal(view.seat.agentId, 'agent-1');
  assert.equal(view.seat.state, 'host-confirmed');
  assert.equal(view.desk.repoKey, repoKey);
  assert.equal(view.desk.state, 'available');
  assert.equal(view.desk.protocol, DESK_BRIDGE_PROTOCOL);
  assert.deepEqual(view.assignments, []);
  assert.deepEqual(view.limitations, []);
  assert.equal(view.acceptance, 'not-established-by-this-view');
});

test('MCP request metadata is transport-only and cannot override seat identity or arguments', async t => {
  const { reader, conn, row } = await boundSeat(t);
  const meta = { progressToken: 'local-probe', actorAgentId: 'forged-agent', nested: { grantRef: 'forged-grant' } };
  const call = params => rpc(reader, conn, { jsonrpc: '2.0', id: 1, method: 'tools/call', params });
  const reply = await call({ name: 'slp_status', arguments: {}, _meta: meta });
  assert.notEqual(reply.result.isError, true);
  const view = DeskSeatStatus.parse(JSON.parse(reply.result.content[0].text));
  assert.equal(view.seat.membershipId, row.membershipId);
  assert.equal(view.seat.agentId, 'agent-1');
  for (const params of [
    { name: 'slp_status', arguments: {}, _meta: 'invalid' },
    { name: 'slp_status', arguments: {}, _meta: { progressToken: false } },
    { name: 'slp_status', arguments: {}, actorAgentId: 'forged-agent' },
    { name: 'slp_status', arguments: { actorAgentId: 'forged-agent' }, _meta: meta },
  ]) {
    const rejected = await call(params);
    assert.equal(rejected.result.isError, true);
    assert.equal(JSON.parse(rejected.result.content[0].text).code, 'INVALID_RECORD');
  }
});

test('a hidden mechanism entry is rejected with AUTHORITY_REQUIRED', async t => {
  const { reader, conn } = await boundSeat(t);
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_desk_internal', arguments: {} },
  });
  assert.equal(reply.result.isError, true);
  const rejection = JSON.parse(reply.result.content[0].text);
  assert.equal(rejection.ok, false);
  assert.equal(rejection.code, 'AUTHORITY_REQUIRED');
});

test('an unknown tool name is INVALID_RECORD', async t => {
  const { reader, conn } = await boundSeat(t);
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_recover_lock', arguments: {} },
  });
  const rejection = JSON.parse(reply.result.content[0].text);
  assert.equal(rejection.code, 'INVALID_RECORD');
});

test('tool catalog uses concise English guidance and explains ambiguous field sources', async t => {
  const { reader, conn } = await boundSeat(t, { row: { role: 'lead' } });
  const { result } = await rpc(reader, conn, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  for (const tool of result.tools) {
    assert.ok(tool.description.length <= 256, `${tool.name} keeps the description cap`);
    assert.doesNotMatch(tool.description, /[\u00c0-\u1eff]/, `${tool.name} description is English`);
    assert.doesNotMatch(tool.description, /Input:|Response:/, `${tool.name} avoids duplicating schema field lists`);
    const inspect = schema => {
      if (!schema || typeof schema !== 'object') return;
      for (const [key, field] of Object.entries(schema.properties ?? {})) {
        if (key === 'authorityRef' || key === 'grantRef') {
          assert.match(field.description, /Human grant/);
          assert.match(field.description, /assignment sentence\/date/);
          assert.match(field.description, /verbatim claim, never authenticated/);
        }
        inspect(field);
      }
      for (const key of ['oneOf', 'anyOf', 'allOf']) for (const branch of schema[key] ?? []) inspect(branch);
      inspect(schema.items);
    };
    inspect(tool.inputSchema);
  }
  const descriptionCharacters = schema => {
    if (!schema || typeof schema !== 'object') return 0;
    return Object.entries(schema).reduce((sum, [key, value]) => sum +
      (key === 'description' && typeof value === 'string' ? value.length : descriptionCharacters(value)), 0);
  };
  const loadedDescriptionCharacters = result.tools.reduce((sum, tool) =>
    sum + tool.description.length + descriptionCharacters(tool.inputSchema), 0);
  assert.ok(loadedDescriptionCharacters <= 5987, 'description text does not exceed the HEAD catalog budget');
  const byName = new Map(result.tools.map(tool => [tool.name, tool]));
  assert.match(byName.get('slp_handback_submit').inputSchema.properties.recordV1.description, /Bare JSON record object, not the fenced block/);
  assert.match(byName.get('slp_handback_submit').inputSchema.properties.recordV1.description, /slp.mjs records --schema/);
  const via = byName.get('slp_settlement_record').inputSchema.properties.timeline.properties.via.description;
  for (const value of SETTLEMENT_VIA) assert.ok(via.includes(value), value);
  const transition = byName.get('slp_scope_transition');
  assert.match(transition.inputSchema.properties.candidateSnapshot.description, /snapshotSha256.*candidate row.*slp_workflow_get/);
  assert.match(transition.description, /slp_handback_submit/);
  assert.match(byName.get('slp_scope_declare').inputSchema.properties.declarationSha256.description, /sha256.*declaration body/);
  assert.match(byName.get('slp_scope_declare').description, /after slp_assignment_amend/);
});

test('Peer kit supplies desk health, handback and hold signatures with native fallback', async t => {
  const { reader, conn } = await boundSeat(t);
  const { result } = await rpc(reader, conn, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const kit = spawnKit('peer');
  const byName = new Map(result.tools.map(tool => [tool.name, tool]));
  for (const name of ['slp_status', 'slp_handback_submit', 'slp_task_hold']) {
    const signature = kit.tools.find(tool => tool.startsWith(`${name}(`));
    assert.ok(signature, `${name} is supplied to Peers`);
    const argumentsText = signature.slice(name.length + 1, -1);
    const params = argumentsText ? argumentsText.split(', ').map(value => value.split(': ')[0]) : [];
    const schema = byName.get(name).inputSchema;
    assert.deepEqual(params.map(value => value.replace(/\?$/, '')).sort(), Object.keys(schema.properties).sort());
    assert.deepEqual(params.filter(value => !value.endsWith('?')).sort(), [...(schema.required ?? [])].sort());
    for (const field of ['candidateId', 'attemptId', 'holdId', 'hold', 'ruling']) {
      if (schema.properties[field]) assert.match(signature, new RegExp(`${field}: [^,]+ \\| null`));
    }
  }
  assert.match(kit.note, /without slp_desk tools, hand back with one native send_agent_prompt report/);
  assert.match(kit.note, /agentId.*full id.*list_agents.*shortId/);
});

test('managed Peer entry omits install lifecycle helpers; orchestrating entries retain them', t => {
  const root = process.cwd();
  const env = { SLP_MANAGED_RUNTIME: '1', SLP_NODE_BIN: process.execPath,
    SLP_RUNTIME_ROOT: root, SLP_DAEMON_HOME: tmp(t, 'slp-carrier-home-') };
  const peer = roleBundle(root, 'peer', env).instructions;
  assert.doesNotMatch(peer, /install <dir>|upgrade\/uninstall/);
  assert.match(peer, /slp_handback_submit/);
  for (const role of ['supervisor', 'lead']) {
    const entry = roleBundle(root, role, env).instructions;
    assert.match(entry, /install <dir>/);
    assert.match(entry, /upgrade\/uninstall/);
  }
});

test('tool arguments beyond the strict schema are INVALID_RECORD', async t => {
  const { reader, conn } = await boundSeat(t);
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: { repoKey: 'forged', agentId: 'x' } },
  });
  const rejection = JSON.parse(reply.result.content[0].text);
  assert.equal(rejection.code, 'INVALID_RECORD');
});

test('strict input reports at most three paths and messages within the rejection cap', async t => {
  const { reader, conn } = await boundSeat(t);
  const call = async (id, name, args) => JSON.parse((await rpc(reader, conn, {
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  })).result.content[0].text);
  const invalid = await call(1, 'slp_scope_declare', {
    requestId: '', assignmentId: '', scopeId: '', label: '',
    declarationSha256: 'a'.repeat(64), refs: [], seatAgentId: null,
  });
  assert.equal(invalid.code, 'INVALID_RECORD');
  assert.match(invalid.message, /requestId: Too small: expected string to have >=1 characters/);
  assert.match(invalid.message, /assignmentId: /);
  assert.match(invalid.message, /scopeId: /);
  assert.doesNotMatch(invalid.message, /label: /);
  assert.match(invalid.recovery, /tools\/list/);
  assert.match(invalid.recovery, /only declared fields/);
  const refined = await call(2, 'slp_scope_declare', {
    requestId: 'r', assignmentId: 'a', scopeId: 's', label: 'scope',
    declarationSha256: 'a'.repeat(64), refs: [], seatAgentId: null,
    reviewPlan: { kind: 'required', authorityRef: 'Human grant', ruleRef: 'rule',
      reason: 'review', lenses: [], exemptionClass: null },
  });
  assert.match(refined.message, /reviewPlan.lenses: required plan has lenses and no exemption class/);
  const huge = await call(3, 'slp_status', { ['x'.repeat(10000)]: true });
  assert.equal(huge.code, 'INVALID_RECORD');
  assert.ok(huge.message.length <= WIRE_LIMITS.rejectionMessage);
});

test('authority rejection directs assignment lookup and revoked-seat escalation', async t => {
  const { reader, conn, f, repoKey, row } = await boundSeat(t, { row: { role: 'lead' } });
  const reply = await rpc(reader, conn, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'slp_assignment_close', arguments: { requestId: 'missing', assignmentId: 'unregistered' } } });
  const rejection = JSON.parse(reply.result.content[0].text);
  assert.equal(rejection.code, 'AUTHORITY_REQUIRED');
  assert.match(rejection.message, /not registered/);
  assert.match(rejection.recovery, /slp_status/);
  assert.match(rejection.recovery, /Lead/);
  const ledger = seedStore(f).read(repoKey).ledger;
  const revoked = decideDeskHandback({ ...ledger, memberships: [{ ...row, state: 'revoked',
    revokedAt: FIXED_AT, revokeReason: 'archived' }] }, {
    kind: 'assignment.close', actorAgentId: row.agentId, requestId: 'revoked', assignmentId: 'unregistered',
  });
  assert.equal(revoked.code, 'AUTHORITY_REQUIRED');
  assert.match(revoked.recovery, /slp_status/);
  assert.match(revoked.recovery, /retrying cannot rebind a revoked seat/);
});

test('bridge dispatch fault requires reconciliation before resubmission', async t => {
  let fault = false;
  const { reader, conn } = await boundSeat(t, { audit: input => {
    if (fault) throw new Error('fixture fault');
    return auditCapabilities(input);
  } });
  fault = true;
  const reply = await rpc(reader, conn, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'slp_status', arguments: {} } });
  assert.equal(reply.error.data.slpCode, 'EXECUTION_UNKNOWN');
  assert.match(reply.error.message, /the request may have committed; reconcile with slp_status or slp_operation_get before resubmitting/);
});

test('native union branches reject discriminator and unknown-field violations before effects', async t => {
  const effects = [];
  const taskHost = () => ({
    providers: { snapshot: async () => { effects.push('providers.snapshot'); return { entries: [] }; } },
    agents: {
      ref: () => ({ refresh: async () => ({ agent: LIVE_AGENT }), send: async () => effects.push('agents.send') }),
      create: async () => { effects.push('agents.create'); return { id: 'unexpected' }; },
    },
    workspaces: { ref: () => ({ agents: { create: async () => { effects.push('workspaces.create'); return { id: 'unexpected' }; } } }) },
  });
  const { reader, conn } = await boundSeat(t, { taskHost });
  const dispatch = {
    requestId: 'union-dispatch', assignmentId: 'asg-fixture', taskId: 'task-fixture',
    expectedLedgerRevision: 0, expectedBriefRevision: 0, expectedOwnershipRevision: 0,
    expectedTaskRevision: 1, grantRef: 'human:fixture', attemptId: null, expectedAttemptRevision: 0,
    runtime: { optionId: 'pool-fixture', catalogSha256: 'a'.repeat(64) },
    placement: { kind: 'shared-checkout', cwd: '/repo' }, phase: 'bootstrap',
  };
  const integrate = {
    requestId: 'union-integrate', assignmentId: 'asg-fixture', taskId: 'task-fixture', resultId: 'result-fixture',
    expectedLedgerRevision: 0, expectedResultRevision: 1, expectedAdjudicationRevision: 1,
    phase: 'stage', integrationActionId: null,
    grant: { authorityRef: 'human:fixture', paths: ['src/file.ts'], target: { cwd: '/repo' } },
    verification: { recipeIds: [] }, stageKind: 'content-dir',
  };
  const seatCreate = { requestId: 'union-create', role: 'lead', grantRef: 'human:fixture',
    taskLabel: 'bounded work', assignment: 'Implement the bounded task.' };
  assert.equal(DeskTaskDispatchInput.safeParse(dispatch).success, true, 'bootstrap branch fixture is valid');
  assert.equal(DeskTaskIntegrateInput.safeParse(integrate).success, true, 'stage branch fixture is valid');
  assert.equal(DeskSeatCreateInput.safeParse(seatCreate).success, true, 'Lead branch fixture is valid');
  const calls = [
    ['slp_task_dispatch', { ...dispatch, phase: 'send' }],
    ['slp_task_dispatch', { ...dispatch, callerAgentId: 'forged' }],
    ['slp_task_integrate', { ...integrate, phase: 'land' }],
    ['slp_task_integrate', { ...integrate, internalReceipt: true }],
    ['slp_seat_create', { ...seatCreate, role: 'peer' }],
    ['slp_seat_create', { ...seatCreate, modeId: 'caller-selected' }],
  ];
  let id = 10;
  for (const [name, args] of calls) {
    const reply = await rpc(reader, conn, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(reply.result.isError, true, `${name} must reject the invalid union input`);
    assert.equal(JSON.parse(reply.result.content[0].text).code, 'INVALID_RECORD', name);
    assert.deepEqual(effects, [], `${name} rejection occurs before native/provider effects`);
  }
});

test('dispatch stays closed while no host SDK context has arrived', async t => {
  const f = await started(t); // paseoRef.current stays null
  const git = gitRepo(t);
  const handle = 'handle-nopaseo';
  await seedMembership(seedStore(f), repoOf(git), memberRow(handle));
  const { conn, reader, ack } = await handshake(f.paths.socketPath, HELLO(handle));
  t.after(() => conn.destroy());
  assert.equal(ack.ok, true);
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  const rejection = JSON.parse(reply.result.content[0].text);
  assert.equal(rejection.code, 'CAPABILITY_GAP');
});

for (const [title, agent] of [
  ['an archived agent', { ...LIVE_AGENT, archivedAt: FIXED_AT }],
  ['a provider mismatch', { ...LIVE_AGENT, provider: 'slp-pi-peer' }],
  ['a workspace mismatch', { ...LIVE_AGENT, workspaceId: 'wks-other' }],
  ['a vanished agent', null],
]) {
  test(`live-identity guard rejects ${title}`, async t => {
    const { reader, conn } = await boundSeat(t, { agent });
    const reply = await rpc(reader, conn, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'slp_status', arguments: {} },
    });
    const rejection = JSON.parse(reply.result.content[0].text);
    assert.equal(rejection.code, 'ACTOR_MISMATCH', `${title}: ${JSON.stringify(rejection)}`);
  });
}

test('a stale epoch mid-session (revoked after hello) closes dispatch', async t => {
  const { reader, conn, f, repo, repoKey, row } = await boundSeat(t);
  const store = seedStore(f);
  const result = await store.transact(
    repoKey,
    {
      repo,
      actorKey: 'desk:hook',
      assignmentId: 'unassigned',
      requestId: randomUUID(),
      command: { kind: 'seed' },
    },
    () => ({
      ok: true,
      events: [],
      memberships: [
        { ...row, state: 'revoked', revokedAt: FIXED_AT, revokeReason: 'archived' },
      ],
    }),
  );
  assert.ok(result.ok, `revoke seed failed: ${JSON.stringify(result)}`);
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  const rejection = JSON.parse(reply.result.content[0].text);
  assert.equal(rejection.code, 'STALE_EPOCH');
});

test('read-only status still answers under recovery-required with the limitation flag', async t => {
  const { reader, conn, f, repoKey } = await boundSeat(t, {
    // The seat repo's lock reports a dead holder — the injected kill
    // probe makes every pid read as dead.
  });
  // Rebuild availability probe's kill: the fixture's default kill calls
  // process.kill(pid, 0); pid 1 is alive here, so use a dead-pid double by
  // writing a holder whose pid the real probe treats as dead — a pid far
  // beyond the range. Instead, pin a dead holder under the SEAT repo dir.
  const seatPaths = deskRepoPaths(f.stableRoot, repoKey);
  mkdirSync(seatPaths.repoDir, { recursive: true });
  writeFileSync(
    seatPaths.lockPath,
    JSON.stringify({ pid: 4194303, instanceNonce: 'dead-holder' }) + '\n',
  );
  // The real pidAlive probe: 4194303 is above the Linux pid_max — dead.
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  const view = DeskSeatStatus.parse(JSON.parse(reply.result.content[0].text));
  assert.equal(view.desk.state, 'recovery-required');
  assert.deepEqual(view.limitations, [
    'desk lock orphaned or unreadable — operator recovery required before desk mutations',
    'assignments view withheld — the desk ledger cannot be read',
  ]);
  const mutation = await rpc(reader, conn, { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'slp_assignment_register', arguments: { requestId: 'blocked', authorityRef: 'Human', objective: null } } });
  const rejection = JSON.parse(mutation.result.content[0].text);
  assert.equal(rejection.code, 'RECOVERY_REQUIRED');
  assert.match(rejection.recovery, /reads still answer/);
  assert.match(rejection.recovery, /Human\/tooling authority/);
  assert.match(rejection.recovery, /tell the Lead/);

});

test('read-only status still answers when the ledger itself is unreadable (degraded)', async t => {
  const { reader, conn, f, repoKey, row } = await boundSeat(t);
  // Corrupt the bound repo's ledger after the handshake — the seat's health
  // reporter must still answer from the handshake-bound row, marking the
  // desk degraded instead of rejecting outright.
  writeFileSync(deskRepoPaths(f.stableRoot, repoKey).ledgerPath, '{corrupt\n');
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply.result));
  const view = DeskSeatStatus.parse(JSON.parse(reply.result.content[0].text));
  assert.equal(view.desk.state, 'degraded');
  // The seat block is the handshake-bound row — snapshot fidelity, not a
  // fabricated fresh read.
  assert.equal(view.seat.membershipId, row.membershipId);
  assert.equal(view.seat.agentId, 'agent-1');
  assert.equal(view.seat.state, 'host-confirmed');
  assert.deepEqual(view.assignments, []);
  assert.deepEqual(view.limitations, [
    'desk ledger is not readable — seat view is best-effort',
    'assignments view withheld — the desk ledger cannot be read',
  ]);
  // The degraded path broke no guard: a mutation on the unreadable desk is
  // still refused before any run.
  const mutation = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'slp_handback_submit',
      arguments: {
        requestId: 'r-degraded',
        assignmentId: 'asg-1',
        recordV1: { version: 1, kind: 'handback' },
        candidateId: null,
      },
    },
  });
  const rejection = JSON.parse(mutation.result.content[0].text);
  assert.equal(mutation.result.isError, true);
  assert.equal(rejection.code, 'STATE_UNREADABLE');
});

test('slp_status stays schema-valid when several projection caps are hit at once', async t => {
  const { reader, conn, f, repo, repoKey, row } = await boundSeat(t, {
    row: { role: 'lead', agentId: 'agent-lead' },
  });
  // 70 owned assignments × 33 attached seats: the assignments cap (64) and
  // the per-assignment seats cap (32) both bind — the limitation aggregate
  // must stay inside WIRE_LIMITS.deskBridgeLimitations with elision stated.
  const seatRows = Array.from({ length: 33 }, (_, i) =>
    memberRow(`seat-${i}`, { agentId: `seat-${i}` }));
  const assignments = Array.from({ length: 70 }, (_, i) => ({
    assignmentId: `asg-cap-${i}`,
    requestId: `req-asg-cap-${i}`,
    authorityRef: 'grant:cap',
    objective: null,
    ownerMembershipId: row.membershipId,
    ownerAgentId: 'agent-lead',
    workspaceId: 'wks-1',
    state: 'open',
    seats: seatRows.map(m => ({ agentId: m.agentId, membershipId: m.membershipId })),
  }));
  const seeded = await seedStore(f).transact(
    repoKey,
    {
      repo,
      actorKey: 'desk:hook',
      assignmentId: 'unassigned',
      requestId: randomUUID(),
      command: { kind: 'seed' },
    },
    ledger => ({
      ok: true,
      events: [],
      memberships: [...ledger.memberships, ...seatRows],
      assignments,
    }),
  );
  assert.ok(seeded.ok, `multi-cap seed failed: ${JSON.stringify(seeded)}`);
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply.result));
  // The parse itself is the finding: an over-cap aggregate must never make
  // the status view fail its own schema (EXECUTION_UNKNOWN).
  const view = DeskSeatStatus.parse(JSON.parse(reply.result.content[0].text));
  assert.equal(view.desk.state, 'available');
  assert.equal(view.assignments.length, WIRE_LIMITS.deskStatusAssignments);
  assert.ok(view.assignments.every(a => a.seats.length <= WIRE_LIMITS.deskStatusSeats));
  assert.ok(view.limitations.length <= WIRE_LIMITS.deskBridgeLimitations);
  for (const line of view.limitations) {
    assert.ok(line.length <= WIRE_LIMITS.limitationLen, line);
  }
  // Elision is disclosed as counting markers, not silently dropped.
  assert.ok(view.limitations.some(l => l.includes('6 assignment(s) not shown')), JSON.stringify(view.limitations));
  assert.ok(view.limitations.some(l => l.includes('seat lists truncated')), JSON.stringify(view.limitations));
});

// ---------------------------------------------------------------------------
// wire robustness — malformed frames, byte cap, resume semantics
// ---------------------------------------------------------------------------

test('a malformed NDJSON frame after hello is a typed error; the session continues', async t => {
  const { reader, conn } = await boundSeat(t);
  conn.write('not valid json\n');
  const error = JSON.parse((await reader.next()).toString('utf8'));
  assert.equal(error.error.code, -32700);
  assert.equal(error.error.data.slpCode, 'INVALID_RECORD');
  assert.match(error.error.message, /malformed/);
  const reply = await rpc(reader, conn, { jsonrpc: '2.0', id: 7, method: 'ping' });
  assert.deepEqual(reply.result, {});
});

test('a frame over the request cap carries the typed REQUEST_TOO_LARGE code', async t => {
  const { reader, conn } = await boundSeat(t);
  // Complete oversized line (terminated): rejected, not swallowed.
  conn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(REQUEST_CAP) }) + '\n');
  const error = JSON.parse((await reader.next()).toString('utf8'));
  assert.equal(error.error.code, -32600);
  // The typed SLP code is machine-readable in data.slpCode (T5), not just
  // embedded in free-form message text.
  assert.equal(error.error.data.slpCode, 'REQUEST_TOO_LARGE');
  assert.match(error.error.message, /REQUEST_TOO_LARGE/);
  assert.match(error.error.message, /shrink or split the record; the cap is per frame/);
  const reply = await rpc(reader, conn, { jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(reply.result, {});
});

test('an unterminated flood is swallowed whole — its tail never re-parses', async t => {
  const { reader, conn } = await boundSeat(t);
  // Over-cap bytes with NO newline, then the flood's newline, then a valid frame.
  conn.write('x'.repeat(REQUEST_CAP + 1024));
  await new Promise(resolve => setTimeout(resolve, 50));
  conn.write('\n' + JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }) + '\n');
  const first = JSON.parse((await reader.next()).toString('utf8'));
  assert.equal(first.error.data.slpCode, 'REQUEST_TOO_LARGE');
  assert.match(first.error.message, /REQUEST_TOO_LARGE/);
  const second = JSON.parse((await reader.next()).toString('utf8'));
  assert.equal(second.id, 5);
  assert.deepEqual(second.result, {});
});

test('an over-cap hello rejects with the typed REQUEST_TOO_LARGE ack code', async t => {
  const f = await started(t);
  const conn = await connect(f.paths.socketPath);
  const reader = new LineReader(conn);
  conn.write(JSON.stringify(HELLO('h', { pad: 'x'.repeat(REQUEST_CAP) })) + '\n');
  const line = JSON.parse((await reader.next()).toString('utf8'));
  assert.equal(line.ok, false);
  assert.equal(line.error.code, 'REQUEST_TOO_LARGE');
  await new Promise(resolve => conn.once('close', resolve));
});

test('request and response byte caps are the two separate shared WIRE_LIMITS keys', () => {
  assert.equal(REQUEST_CAP, 262144);
  assert.equal(RESPONSE_CAP, 262144);
  assert.equal('deskBridgeLineBytes' in WIRE_LIMITS, false);
});

// ---------------------------------------------------------------------------
// agent.create graft — §4 amend seam over the second before-hook
// ---------------------------------------------------------------------------

const createRequest = (over = {}) => ({
  request: {
    config: { provider: PROVIDER, cwd: '/repo' },
    env: { SLP_DESK_HANDLE: 'minted-handle', ...over.env },
    ...over.request,
  },
});

test('graft: non-slp provider and missing handle pass through untouched', async t => {
  const f = await started(t);
  const unchanged = await f.bridge.agentCreateGraft({
    request: { config: { provider: 'devin', cwd: '/repo' }, env: { SLP_DESK_HANDLE: 'h' } },
  });
  assert.equal(unchanged, undefined);
  const noHandle = await f.bridge.agentCreateGraft(
    createRequest({ env: { SLP_DESK_HANDLE: undefined } }),
  );
  assert.equal(noHandle, undefined);
});

test('graft: a stopped bridge mints nothing — env handle alone is never a transport', async t => {
  const f = bridgeFixture(t);
  const out = await f.bridge.agentCreateGraft(createRequest());
  assert.equal(out, undefined);
  assert.ok(f.warnings.some(line => /not listening/.test(line)));
});

test('graft: happy path wires the stdio server with node, STABLE binary, handle and socket', async t => {
  const f = await started(t);
  const out = await f.bridge.agentCreateGraft(createRequest());
  assert.ok(out !== undefined);
  const desk = out.config.mcpServers.slp_desk;
  assert.equal(desk.type, 'stdio');
  assert.equal(desk.command, process.execPath);
  // F1: args point at the stable enforcement-dir install, NEVER the
  // GC-able candidate sha-dir.
  assert.deepEqual(desk.args, [f.paths.bridgePath]);
  assert.equal(f.paths.bridgePath, join(f.paths.enforcementDir, 'slp-desk-mcp.mjs'));
  assert.ok(!f.paths.bridgePath.startsWith(f.runtimePath));
  assert.equal(desk.env.SLP_DESK_HANDLE, 'minted-handle');
  assert.equal(desk.env.SLP_DESK_SOCK, f.paths.socketPath);
  // Request env passes through verbatim — the graft adds config, not env.
  assert.equal(out.env.SLP_DESK_HANDLE, 'minted-handle');
});

test('F1: start self-installs the verified binary at the stable path (sha == pin == declared)', async t => {
  const f = await started(t);
  assert.equal(existsSync(f.paths.bridgePath), true);
  assert.equal(sha256Hex(readFileSync(f.paths.bridgePath)), PIN);
  assert.equal(statSync(f.paths.bridgePath).mode & 0o777, 0o600);
  // A GC'd candidate dir cannot strand a verified install — graft still
  // serves the stable path without re-reading the candidate.
  rmSync(join(f.runtimePath, 'bin', 'slp-desk-mcp.mjs'));
  const out = await f.bridge.agentCreateGraft(createRequest());
  assert.ok(out !== undefined);
  assert.deepEqual(out.config.mcpServers.slp_desk.args, [f.paths.bridgePath]);
});

test('F1: a drifted stable file is re-installed from the verified candidate', async t => {
  const f = await started(t);
  writeFileSync(f.paths.bridgePath, '// corrupted after install\n');
  const out = await f.bridge.agentCreateGraft(createRequest());
  assert.ok(out !== undefined);
  assert.equal(sha256Hex(readFileSync(f.paths.bridgePath)), PIN);
});

test('graft: a foreign slp_desk entry is preserved verbatim — never clobbered', async t => {
  const f = await started(t);
  const foreign = { type: 'stdio', command: '/elsewhere', args: [], env: {} };
  const out = await f.bridge.agentCreateGraft(
    createRequest({ request: { config: { provider: PROVIDER, mcpServers: { slp_desk: foreign, other: { type: 'stdio' } } } } }),
  );
  assert.equal(out, undefined, 'collision must not rewrite the request');
  assert.ok(f.warnings.some(line => /slp_desk already exists/.test(line)));
});

test('graft: drifted candidate bytes with no verified install fail integrity — nothing grafted', async t => {
  const f = await started(t);
  // Both halves broken at once: no stable file to serve and the candidate
  // no longer hashes to the manifest pin — the graft refuses.
  rmSync(f.paths.bridgePath);
  writeFileSync(join(f.runtimePath, 'bin', 'slp-desk-mcp.mjs'), '// tampered after publish\n');
  const out = await f.bridge.agentCreateGraft(createRequest());
  assert.equal(out, undefined);
  assert.ok(f.warnings.some(line => /fails integrity|manifest pin/.test(line)));
});

test('graft: a payload that never declared the binary refuses to serve it', async t => {
  const f = await started(t, { payload: { files: [{ path: 'bin/slp-shim.mjs', sha256: PIN }] } });
  const out = await f.bridge.agentCreateGraft(createRequest());
  assert.equal(out, undefined);
  assert.ok(f.warnings.some(line => /fails integrity/.test(line)));
});

// ---------------------------------------------------------------------------
// session-open stash — live SDK reaches the dispatch guards on resume opens
// ---------------------------------------------------------------------------

test('E-P2D-4: hook identity serves UDS tools without claiming operator RPC evidence', async t => {
  const paseoRef = { current: null };
  let audited;
  const f = await started(t, { paseoRef, audit: input => { audited = auditCapabilities(input); return audited; } });
  const git = gitRepo(t);
  const handle = 'resume-handle';
  await seedMembership(seedStore(f), repoOf(git), memberRow(handle));
  const { conn, reader, ack } = await handshake(f.paths.socketPath, HELLO(handle));
  t.after(() => conn.destroy());
  assert.equal(ack.ok, true);
  // No context yet — dispatch is closed.
  const closed = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  assert.equal(JSON.parse(closed.result.content[0].text).code, 'CAPABILITY_GAP');
  // A session_open hook ctx arrives — the SDK identity surface is now
  // stashed. A hook is not operator RPC evidence, but UDS dispatch needs
  // the listening bridge transport plus that live SDK identity.
  f.bridge.sessionOpenStash({ request: {} }, { paseo: livePaseo(LIVE_AGENT) });
  const hookOnly = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  const hookView = DeskSeatStatus.parse(JSON.parse(hookOnly.result.content[0].text));
  assert.equal(hookView.desk.state, 'available');
  assert.equal(audited.records.find(row => row.capabilityId === CAPABILITY_IDS.pluginRpcDispatch).status, 'unknown');
  assert.equal(audited.records.find(row => row.capabilityId === CAPABILITY_IDS.deskBridgeTransport).status, 'supported');
  // The create-hook stash behaves identically — hooks never mint evidence.
  // (The graft may still wire config; what it must never do is open the
  // plugin-rpc.dispatch capability row.)
  await f.bridge.agentCreateGraft(
    { request: { config: { provider: PROVIDER }, env: { SLP_DESK_HANDLE: 'h' } } },
    { paseo: livePaseo(LIVE_AGENT) },
  );
  const createHookOnly = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  assert.equal(DeskSeatStatus.parse(JSON.parse(createHookOnly.result.content[0].text)).desk.state, 'available');
  // An actual operator RPC observation is independent of UDS availability.
  f.bridge.noteDispatch(f.paseoRef.current);
  const open = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  const view = DeskSeatStatus.parse(JSON.parse(open.result.content[0].text));
  assert.equal(view.desk.state, 'available');
});

// ---------------------------------------------------------------------------
// errata v2 — F7 component lstat, F8 start/stop race, F9 strict UTF-8
// ---------------------------------------------------------------------------

test('F7: a symlinked state/ component under the stable root is RUNTIME_INTEGRITY — nothing escapes it', async t => {
  const f = bridgeFixture(t);
  const escape = tmp(t, 'slp-bridge-escape-');
  symlinkSync(escape, join(f.stableRoot, 'state'), 'dir');
  t.after(() => f.bridge.stop());
  void f.bridge.start();
  assert.equal(await f.bridge.whenReady(), 'unavailable');
  assert.equal(f.bridge.state().code, 'RUNTIME_INTEGRITY');
  assert.match(f.bridge.state().reason, /not a real directory/);
  // The socket, lock and stable binary must never materialise through the
  // symlink — the escape target stays empty.
  assert.equal(existsSync(join(escape, 'enforcement')), false);
  assert.equal(existsSync(f.paths.lockPath), false);
});

test('F7: a regular file where a path component must be a directory is RUNTIME_INTEGRITY', async t => {
  const f = bridgeFixture(t);
  writeFileSync(join(f.stableRoot, 'state'), 'not a directory');
  t.after(() => f.bridge.stop());
  void f.bridge.start();
  assert.equal(await f.bridge.whenReady(), 'unavailable');
  assert.equal(f.bridge.state().code, 'RUNTIME_INTEGRITY');
  assert.equal(existsSync(f.paths.socketPath), false);
});

test('F8: stop() while start() is pending on stable-root resolution aborts cleanly', async t => {
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const f = bridgeFixture(t, {
    launchers: {
      verify: async dir => {
        await gate;
        return {
          directory: realpathSync(dir),
          files: [],
          launchSetSha256: 'a'.repeat(64),
          launchManifestSha256: 'a'.repeat(64),
          bridgeSha256: PIN,
          bridgeProtocolVersion: DESK_BRIDGE_PROTOCOL,
        };
      },
    },
  });
  const startP = f.bridge.start();
  f.bridge.stop(); // lands while resolveStableRoot is suspended
  assert.equal(f.bridge.state().kind, 'unavailable');
  release();
  await startP;
  assert.equal(await f.bridge.whenReady(), 'unavailable');
  assert.equal(existsSync(f.paths.lockPath), false);
  assert.equal(existsSync(f.paths.socketPath), false);
  // A second stop must not corrupt state nor revive anything.
  f.bridge.stop();
  assert.equal(f.bridge.state().kind, 'unavailable');
  assert.equal(existsSync(f.paths.lockPath), false);
});

test('F8: stop() during the bounded desk-busy wait releases a late-acquired lock', async t => {
  // Every foreign pid reads alive, so acquireLock enters the poll loop.
  const f = bridgeFixture(t, { kill: () => {} });
  mkdirSync(f.paths.repoDir, { recursive: true });
  writeFileSync(
    f.paths.lockPath,
    JSON.stringify({ pid: 424242, instanceNonce: 'foreign', startedAt: FIXED_AT }) + '\n',
  );
  const startP = f.bridge.start();
  // Let the lock poll get going, then stop mid-wait and free the lock —
  // the resumed acquire must be unwound, never left holding.
  await new Promise(resolve => setTimeout(resolve, 150));
  f.bridge.stop();
  rmSync(f.paths.lockPath);
  await startP;
  assert.equal(await f.bridge.whenReady(), 'unavailable');
  assert.equal(existsSync(f.paths.lockPath), false);
  assert.equal(existsSync(f.paths.socketPath), false);
  assert.equal(f.bridge.state().kind, 'unavailable');
});

test('F9: a byte-invalid hello is INVALID_RECORD — U+FFFD substitution never reaches the schema', async t => {
  const f = await started(t);
  const conn = await connect(f.paths.socketPath);
  t.after(() => conn.destroy());
  const reader = new LineReader(conn);
  // 0xFF 0xFE inside the handle string would decode to U+FFFD and still
  // JSON.parse — strict UTF-8 must refuse the frame before the schema sees it.
  conn.write(Buffer.concat([
    Buffer.from(`{"schemaVersion":1,"protocol":"${DESK_BRIDGE_PROTOCOL}","handle":"abc`),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`","bridgeSha256":"${PIN}"}\n`),
  ]));
  const line = JSON.parse((await reader.next()).toString('utf8'));
  assert.equal(line.error.code, 'INVALID_RECORD');
  assert.match(line.error.message, /UTF-8/);
});

test('F9: a byte-invalid frame after binding is a typed error; the session continues', async t => {
  const { conn, reader } = await boundSeat(t);
  conn.write(Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","id":9,"method":"'),
    Buffer.from([0xff]),
    Buffer.from('ping"}\n'),
  ]));
  const error = JSON.parse((await reader.next()).toString('utf8'));
  assert.equal(error.error.data.slpCode, 'INVALID_RECORD');
  const pong = await rpc(reader, conn, { jsonrpc: '2.0', id: 10, method: 'ping' });
  assert.deepEqual(pong.result, {});
});

// ---------------------------------------------------------------------------
// r2 — thrown IO is a bounded outcome everywhere the ledger is read, and
// durable-length seat fields stay inside the wire schema.
// ---------------------------------------------------------------------------

/** A store wrapper whose read() faults once `ctl` says so — seeded bytes
 *  stay intact, only the read path faults. `calls` counts reads so a
 *  status call can be proven single-observation. */
const throwingStore = ctl => root => {
  const real = createDeskStore({ stableRoot: root });
  return {
    ...real,
    read: key => {
      ctl.calls += 1;
      if (ctl.throws || (ctl.throwAfter !== undefined && ctl.calls > ctl.throwAfter)) {
        throw new Error('io fault — injected');
      }
      return real.read(key);
    },
  };
};

test('a thrown ledger read during hello rejects typed — the handshake never hangs', async t => {
  const ctl = { throws: true, calls: 0 };
  const f = await started(t, { createStore: throwingStore(ctl) });
  assert.equal(f.outcome, 'listening');
  const git = gitRepo(t);
  // Seed through a real store instance — the bridge's own store faults.
  await seedMembership(seedStore(f), repoOf(git), memberRow('handle-1'));
  const { conn, ack } = await handshake(f.paths.socketPath, HELLO('handle-1'));
  t.after(() => conn.destroy());
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'STATE_UNREADABLE');
});

test('a thrown ledger read after binding: status degrades from one observation, mutation fails closed', async t => {
  const ctl = { throws: false, calls: 0 };
  const { reader, conn, row } = await boundSeat(t, { createStore: throwingStore(ctl) });
  ctl.calls = 0;
  ctl.throws = true;
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  // A bounded typed result — never a hung frame.
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply.result));
  const view = DeskSeatStatus.parse(JSON.parse(reply.result.content[0].text));
  assert.equal(view.desk.state, 'degraded');
  // The handshake-bound row answers — nothing fabricated from a live read.
  assert.equal(view.seat.membershipId, row.membershipId);
  assert.equal(view.seat.agentId, 'agent-1');
  assert.deepEqual(view.assignments, []);
  assert.deepEqual(view.limitations, [
    'desk ledger is not readable — seat view is best-effort',
    'assignments view withheld — the desk ledger cannot be read',
  ]);
  // Identity, availability and projection derive from ONE observation —
  // a second read could disagree with the first inside a single call.
  assert.equal(ctl.calls, 1, 'status must observe the ledger exactly once');
  const mutation = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'slp_handback_submit',
      arguments: {
        requestId: 'r-throw',
        assignmentId: 'asg-1',
        recordV1: { version: 1, kind: 'handback' },
        candidateId: null,
      },
    },
  });
  const rejection = JSON.parse(mutation.result.content[0].text);
  assert.equal(mutation.result.isError, true);
  assert.equal(rejection.code, 'STATE_UNREADABLE');
});

test('a read fault between identity and availability answers RECOVERY_REQUIRED', async t => {
  const ctl = { throws: false, calls: 0 };
  const { reader, conn } = await boundSeat(t, { createStore: throwingStore(ctl) });
  // The mutation dispatch reads twice: freshRow (identity) succeeds, the
  // availability probe's own read faults → degraded → typed refusal.
  ctl.calls = 0;
  ctl.throwAfter = 1;
  const mutation = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'slp_assignment_register',
      arguments: { requestId: 'r-seq', authorityRef: 'grant:x', objective: null },
    },
  });
  const rejection = JSON.parse(mutation.result.content[0].text);
  assert.equal(mutation.result.isError, true);
  assert.equal(rejection.code, 'RECOVERY_REQUIRED');
  assert.equal(ctl.calls, 2, 'freshRow read + availability read — no more');
});

test('a ledger deleted mid-session answers STALE_EPOCH — absent stays distinct from unreadable', async t => {
  const { reader, conn, f, repoKey } = await boundSeat(t);
  rmSync(deskRepoPaths(f.stableRoot, repoKey).ledgerPath);
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  const rejection = JSON.parse(reply.result.content[0].text);
  assert.equal(reply.result.isError, true);
  assert.equal(rejection.code, 'STALE_EPOCH');
});

test('seat fields at the durable maxima stay inside the status wire schema — no truncation', async t => {
  const provider = 'p'.repeat(WIRE_LIMITS.providerLen);
  const workspaceId = 'w'.repeat(WIRE_LIMITS.workspaceIdLen);
  const createCwd = `/${'d'.repeat(64)}`;
  const { reader, conn, row } = await boundSeat(t, {
    agent: { provider, workspaceId, archivedAt: null },
    row: { provider, workspaceId, createCwd },
  });
  const reply = await rpc(reader, conn, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'slp_status', arguments: {} },
  });
  // Under the old wire-64 provider cap this answer was EXECUTION_UNKNOWN —
  // a ledger-valid row failed the response schema.
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply.result));
  const view = DeskSeatStatus.parse(JSON.parse(reply.result.content[0].text));
  assert.equal(view.seat.provider, provider);
  assert.equal(view.seat.workspaceId, workspaceId);
  assert.equal(view.seat.createCwd, createCwd);
  assert.equal(view.seat.membershipId, row.membershipId);
});

test('a live lock replacing the orphan during the final identity probe stays untouched', async t => {
  let probes = 0;
  let f;
  const replacement = JSON.stringify({ pid: 434343, instanceNonce: 'live-replacement' });
  f = bridgeFixture(t, { kill: () => {
    if (++probes === 3) writeFileSync(f.paths.lockPath, replacement);
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  } });
  mkdirSync(f.paths.repoDir, { recursive: true });
  writeFileSync(f.paths.lockPath, JSON.stringify({ pid: 424242, instanceNonce: 'orphan' }));
  assert.equal((await startBridge(t, f)).outcome, 'unavailable');
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), replacement);
  assert.equal(existsSync(deskRepoPaths(f.stableRoot, f.paths.repoKey).auditPath), false);
});

test('the real kernel identity of a live bridge cannot authorize another instance to reclaim it', async t => {
  const f = await started(t);
  const bytes = readFileSync(f.paths.lockPath, 'utf8');
  if (process.platform === 'linux') {
    assert.match(JSON.parse(bytes).processIdentity, /^[0-9a-f-]{36}:\d+$/);
  }
  const other = f.makeBridge();
  t.after(() => other.stop());
  await other.start();
  assert.equal(await other.whenReady(), 'unavailable');
  assert.equal(other.state().code, 'CAPABILITY_GAP');
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), bytes);
  assert.equal(existsSync(deskRepoPaths(f.stableRoot, f.paths.repoKey).auditPath), false);
  other.stop();
  assert.equal(existsSync(f.paths.socketPath), true, 'a refused instance never removes the live holder socket');
  const socket = await connect(f.paths.socketPath);
  socket.destroy();
});
