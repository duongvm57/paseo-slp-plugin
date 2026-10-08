import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DESK_TOOL_CATALOG } from '../plugin/server/desk-bridge.ts';
import { DeskBridgeToolEntry, DESK_BRIDGE_PROTOCOL } from '../plugin/shared/enforcement.ts';
import { sha256Hex } from '../plugin/server/config-view.ts';
import {
  BIN_SOURCE, bridgeFixture, startBridge, gitRepo, repoOf, memberRow,
  seedStore, seedMemberships, handshake, hello, rpc,
} from './helpers/desk-bridge-fixture.mjs';

const PIN = sha256Hex(readFileSync(BIN_SOURCE));
const AT = '2026-01-01T00:00:00.000Z';
const ROLES = ['supervisor', 'lead', 'peer'];

// This expectation is independent of the catalog's declarations. Participant
// predicates have no role restriction; custody is only registered/transferred
// to Leads. Formation explicitly admits Supervisors as well as Leads.
const PARTICIPANT_TOOLS = [
  'slp_status', 'slp_handback_submit', 'slp_workflow_get',
  'slp_settlement_export', 'slp_scope_review', 'slp_task_result',
  'slp_task_hold', 'slp_task_acknowledge', 'slp_task_recap',
  'slp_operation_get', 'slp_task_get',
];
const LEAD_TOOLS = [
  'slp_assignment_register', 'slp_assignment_attach', 'slp_assignment_close',
  'slp_assignment_amend', 'slp_decision_append', 'slp_settlement_record',
  'slp_scope_declare', 'slp_scope_transition', 'slp_check_declare', 'slp_check_run',
  'slp_rollout_declare', 'slp_rollout_transition', 'slp_assignment_offer',
  'slp_assignment_accept', 'slp_task_define', 'slp_task_dispatch', 'slp_task_rule',
  'slp_task_stop', 'slp_task_reconcile', 'slp_task_integrate', 'slp_task_deliver',
];

async function seats(t, options = {}) {
  const { missingRole } = options;
  const git = gitRepo(t, 'slp-tool-list-repo-');
  const rows = ROLES.map(role => memberRow(role, { provider: `slp-codex-${role}`, at: AT }, {
    role, agentId: role, createCwd: git.dir, workspaceId: null,
  }));
  const paseo = { agents: { ref: id => ({ refresh: async () => ({ agent: {
    provider: rows.find(row => row.agentId === id)?.provider, workspaceId: null, archivedAt: null,
  } }) }) } };
  const f = bridgeFixture(t, 'slp-tool-list-home-', PIN, {
    paseoRef: { current: paseo },
    // A malformed dependency snapshot is unreachable with the real store,
    // but proves the compatibility fallback instead of silently serving [].
    ...(Object.hasOwn(options, 'missingRole') ? { createStore: root => {
      const store = seedStore({ stableRoot: root });
      return { ...store, read: key => {
        const read = store.read(key);
        if (read.state === 'ok') read.ledger.memberships[0].role = missingRole;
        return read;
      } };
    } } : {}),
  });
  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'listening');
  f.bridge.noteDispatch(paseo);
  const store = seedStore(f);
  const repoKey = await seedMemberships(store, repoOf(git), rows);
  let id = 0;
  const connect = async role => {
    const channel = await handshake(f.paths.socketPath, hello(PIN, role));
    t.after(() => channel.conn.destroy());
    assert.equal(channel.ack.ok, true);
    const request = async (method, params) => rpc(channel.reader, channel.conn, {
      jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}),
    });
    return { request, list: async () => (await request('tools/list')).result,
      call: async (name, arguments_) => (await request('tools/call', { name, arguments: arguments_ })).result };
  };
  return { ...f, rows, store, repoKey, connect };
}

test('every catalog entry declares a unique, closed role set; only the mechanism admits none', () => {
  assert.equal(DESK_TOOL_CATALOG.length, 34);
  const expected = new Map([
    ...PARTICIPANT_TOOLS.map(name => [name, ROLES]),
    ...LEAD_TOOLS.map(name => [name, ['lead']]),
    ['slp_seat_create', ['supervisor', 'lead']], ['slp_desk_internal', []],
  ]);
  for (const entry of DESK_TOOL_CATALOG) {
    assert.deepEqual([...entry.roles].sort(), [...expected.get(entry.name)].sort(), entry.name);
    assert.equal(DeskBridgeToolEntry.safeParse({ ...entry, roles: undefined }).success, false);
    assert.equal(DeskBridgeToolEntry.safeParse({ ...entry, roles: ['human'] }).success, false);
    assert.equal(DeskBridgeToolEntry.safeParse({ ...entry, roles: ['peer', 'peer'] }).success, false);
    if (entry.visible) assert.equal(DeskBridgeToolEntry.safeParse({ ...entry, roles: [] }).success, false);
  }
});

test('hello-bound connections list their role, keep MCP shape, and do not share a role cache', async t => {
  const f = await seats(t);
  for (const role of ['peer', 'lead', 'supervisor', 'peer']) {
    const seat = await f.connect(role);
    const init = (await seat.request('initialize')).result;
    assert.equal(init.serverInfo.version, DESK_BRIDGE_PROTOCOL);
    assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
    const listed = await seat.list();
    assert.deepEqual(Object.keys(listed), ['tools']);
    const expected = [...PARTICIPANT_TOOLS,
      ...(role === 'lead' ? LEAD_TOOLS : []), ...(role !== 'peer' ? ['slp_seat_create'] : [])];
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), expected.sort(), role);
    for (const tool of listed.tools) {
      assert.deepEqual(Object.keys(tool), ['name', 'description', 'inputSchema']);
      assert.equal(tool.inputSchema.type, 'object');
    }
    const status = await seat.call('slp_status', {});
    assert.equal(status.isError, undefined);
    assert.equal(JSON.parse(status.content[0].text).seat.role, role);
  }
});

test('unavailable or unknown connection roles fall back to the full visible catalog', async t => {
  for (const missingRole of [undefined, 'future-role']) {
    const f = await seats(t, { missingRole });
    const seat = await f.connect('supervisor');
    const list = await seat.list();
    assert.deepEqual(list.tools.map(tool => tool.name), DESK_TOOL_CATALOG.filter(row => row.visible).map(row => row.name));
  }
});

test('a Peer still reaches the same Lead-only AUTHORITY_REQUIRED rejection when it is unlisted', async t => {
  const f = await seats(t);
  const peer = await f.connect('peer');
  assert.equal((await peer.list()).tools.some(tool => tool.name === 'slp_assignment_register'), false);
  const result = await peer.call('slp_assignment_register', {
    requestId: 'hidden-lead-call', authorityRef: 'human:fixture', objective: 'Role probe',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false, code: 'AUTHORITY_REQUIRED',
    message: 'role "peer" may not administer assignments — a bound lead membership is required',
    recovery: 'the supervisor/lead/peer role pin is a durable membership field, not a claim',
  });
  for (const role of ROLES) {
    const seat = await f.connect(role);
    const hidden = await seat.call('slp_desk_internal', {});
    assert.equal(JSON.parse(hidden.content[0].text).code, 'AUTHORITY_REQUIRED');
  }
});
