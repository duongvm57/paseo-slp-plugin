// Preloaded only by the catalog authority test. Replay the actual pure
// decisions from successful existing fixtures, with each bound actor role.
// Replays never write a ledger or execute an SDK/filesystem effect.
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DESK_TOOL_CATALOG } from '../../plugin/server/desk-bridge.ts';
import { createDeskStore, deskReposDir, effectiveOwner } from '../../plugin/server/desk-store.ts';
import { canReadDeskWorkflow } from '../../plugin/server/desk-assignment.ts';
import { runSettlementExport } from '../../plugin/server/desk-settlement.ts';
import { createDeskOperations } from '../../plugin/server/desk-operation.ts';
import { runSeatCreate } from '../../plugin/server/desk-formation.ts';
import { runTaskDeliver } from '../../plugin/server/desk-delivery.ts';
import { sha256Hex } from '../../plugin/server/config-view.ts';
import { memberRow, observeDeskBridgeFixtures, rpc } from './desk-bridge-fixture.mjs';

const roles = ['supervisor', 'lead', 'peer'];
const evidence = {};
const kinds = {
  'assignment.register': 'slp_assignment_register', 'assignment.attach': 'slp_assignment_attach',
  'assignment.close': 'slp_assignment_close', 'assignment.amend': 'slp_assignment_amend',
  'decision.append': 'slp_decision_append', 'handback.submit': 'slp_handback_submit',
  'settlement.record': 'slp_settlement_record', 'scope.declare': 'slp_scope_declare',
  'scope.transition': 'slp_scope_transition', 'scope.review': 'slp_scope_review',
  'check.declare': 'slp_check_declare', 'check.run.commit': 'slp_check_run',
  'rollout.declare': 'slp_rollout_declare', 'rollout.transition': 'slp_rollout_transition',
  'ownership.offer': 'slp_assignment_offer', 'ownership.accept': 'slp_assignment_accept',
  'task.define': 'slp_task_define', 'task.reserve': 'slp_task_dispatch',
  'task.result': 'slp_task_result', 'task.rule': 'slp_task_rule', 'task.hold': 'slp_task_hold',
  'task.stop': 'slp_task_stop', 'task.acknowledge': 'slp_task_acknowledge',
  'task.reconcile': 'slp_task_reconcile', 'task.effect.integration-admit': 'slp_task_integrate',
};

function record(tool, role, outcome) {
  const cell = (evidence[tool] ??= {})[role] ??= { probes: 0, accepted: 0, rejected: [] };
  cell.probes++;
  if (outcome.ok) {
    cell.accepted++;
    const entry = DESK_TOOL_CATALOG.find(entry => entry.name === tool);
    assert.ok(entry?.visible && entry.roles.includes(role), `${role} can use ${tool}, so its list must include it`);
  } else if (!cell.rejected.includes(outcome.code)) cell.rejected.push(outcome.code);
}

function actorVariant(ledger, command, role) {
  const copy = structuredClone(ledger);
  const cmd = structuredClone(command);
  const original = copy.memberships.find(row => row.agentId === cmd.actorAgentId);
  assert.ok(original, 'successful fixture command has a bound actor');
  const owns = row => copy.assignments.some(assignment => {
    const owner = effectiveOwner(copy, assignment);
    return owner.agentId === row.agentId && owner.membershipId === row.membershipId;
  });
  let actor = original;
  if (owns(original) && role !== 'lead') {
    // Never turn a registered owner into a Peer/Supervisor: the durable
    // store requires Lead owners. Prefer the actual bound worker/recipient
    // for participant commands; otherwise exercise a different live actor.
    const attempt = copy.taskEntries.filter(row => row.kind === 'attempt' && row.attemptId === cmd.attemptId).at(-1);
    const delivery = copy.taskEntries.filter(row => row.kind === 'delivery' && row.deliveryId === cmd.deliveryId).at(-1);
    const targetId = attempt?.member?.agentId ?? delivery?.recipientAgentId;
    actor = copy.memberships.find(row => row.agentId === targetId && !owns(row));
    if (!actor) {
      actor = memberRow(`probe-${role}`, { provider: `slp-codex-${role}`, at: '2026-01-01T00:00:00.000Z' },
        { role, agentId: `probe-${role}`, createCwd: original.createCwd });
      copy.memberships.push(actor);
    }
  }
  actor.role = role;
  cmd.actorAgentId = actor.agentId;
  if ('actorMembershipId' in cmd) cmd.actorMembershipId = actor.membershipId;
  if ('actorOpenGeneration' in cmd) cmd.actorOpenGeneration = actor.openGeneration;
  return { ledger: copy, command: cmd, actor };
}

observeDeskBridgeFixtures({
  store: (_root, store) => ({ ...store, transact: (key, envelope, decide) =>
    store.transact(key, envelope, (ledger, command) => {
      const outcome = decide(ledger, command);
      const tool = kinds[command.kind];
      if (tool && outcome.ok) {
        for (const role of roles) {
          const variant = actorVariant(ledger, command, role);
          record(tool, role, decide(variant.ledger, variant.command));
        }
      }
      return outcome;
    }),
  }),
  beforeCall: async (identity, frame, reader, conn) => {
    if (!identity || frame.method !== 'tools/call') return null;
    const list = await rpc(reader, conn, { jsonrpc: '2.0', id: `role-list-${frame.id}`, method: 'tools/list' });
    const root = dirname(dirname(dirname(identity.socketPath)));
    const store = createDeskStore({ stableRoot: root });
    for (const key of readdirSync(deskReposDir(root))) {
      const read = store.read(key);
      if (read.state !== 'ok') continue;
      const row = read.ledger.memberships.find(row => row.bindingHandleSha256 === sha256Hex(identity.handle));
      if (row) return { root, key, row, ledger: read.ledger, frame, listed: list.result.tools.map(tool => tool.name) };
    }
    return null;
  },
  afterCall: async (before, reply) => {
    if (!before || !reply.result?.content) return;
    const body = JSON.parse(reply.result.content[0].text);
    if (before.frame.params.name === 'slp_desk_internal') {
      assert.equal(body.code, 'AUTHORITY_REQUIRED');
      record('slp_desk_internal', before.row.role, body);
      return;
    }
    if (reply.result.isError || body.ok === false) return;
    const { root, key, row, ledger, frame } = before;
    const name = frame.params.name;
    // Every successful real tools/call also checks the actual connection's
    // tools/list, rather than only checking the metadata used by the probes.
    assert.ok(before.listed.includes(name), `${row.role}/${name}: accepted wire call was omitted`);
    for (const role of roles) {
      const actor = { ...row, role };
      const ctx = { row: actor, repoKey: key };
      const input = frame.params.arguments ?? {};
      const deps = { store: { read: () => ({ state: 'ok', ledger }) } };
      let outcome;
      switch (name) {
        case 'slp_status': outcome = { ok: true }; break;
        case 'slp_workflow_get': case 'slp_task_get': case 'slp_task_recap':
          outcome = { ok: canReadDeskWorkflow(ledger, actor, input.assignmentId), code: 'AUTHORITY_REQUIRED' }; break;
        case 'slp_settlement_export': outcome = await runSettlementExport(ctx, input, deps); break;
        case 'slp_operation_get': outcome = createDeskOperations(root).get({ repoKey: key,
          agentId: actor.agentId, membershipId: actor.membershipId, ...input }); break;
        case 'slp_seat_create':
          // Existing receipt, exact immutable input: role check still runs,
          // then replay reads it. Any attempt to execute an effect fails.
          outcome = await runSeatCreate(actor, input, { stableRoot: root, repoKey: key,
            host: () => { assert.fail('formation parity must only replay'); },
            plan: () => { assert.fail('formation parity must only replay'); },
            guard: () => { assert.fail('formation parity must only replay'); } }); break;
        case 'slp_task_deliver':
          if (role === 'lead') outcome = { ok: true }; // original accepted wire call
          else outcome = await runTaskDeliver(ctx, input, deps);
          break;
        case 'slp_desk_internal': assert.fail('mechanism can never succeed');
        default: continue; // real decide probes above own mutations
      }
      record(name, role, outcome);
    }
  },
});

// Each node --test worker gets its own evidence file. Parent checks merge
// the measured cells and require all 34 tools × all three roles.
process.on('exit', () => writeFileSync(join(process.env.SLP_DESK_TOOL_COVERAGE, `${process.pid}.json`), JSON.stringify(evidence)));
