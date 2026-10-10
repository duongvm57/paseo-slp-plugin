import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySeat } from '../plugin/server/desk-seat-observation.ts';

const pin = {
  provider: 'slp-codex-peer', model: 'model', cwd: '/repo/worktree',
  workspaceId: 'workspace', parent: 'lead', modeId: 'full-access',
  thinkingOptionId: 'high', features: { fast_mode: true, speed: 'normal' },
  labels: { 'slp.formation': 'formation-pin' },
};
const snapshot = () => ({
  id: 'peer', provider: pin.provider, model: pin.model, cwd: pin.cwd,
  workspaceId: pin.workspaceId, currentModeId: pin.modeId,
  thinkingOptionId: pin.thinkingOptionId, archivedAt: null,
  labels: { ...pin.labels, 'paseo.parent-agent-id': pin.parent },
  features: [{ id: 'fast_mode', value: true }, { id: 'speed', value: 'normal' }],
});
const host = refresh => ({ agents: { ref: id => {
  assert.equal(id, 'peer');
  return { refresh };
} } });
const observe = (agent, expected = pin, ticket) => verifySeat(
  host(async () => ({ agent, project: null })), 'peer', expected, ticket,
);

test('native observation needs only a fresh read adapter, never create/send/list/workspace effects', async () => {
  let current = snapshot(), reads = 0;
  const adapter = host(async () => { reads++; return { agent: current, project: null }; });
  assert.deepEqual(await verifySeat(adapter, 'peer', pin), {
    ok: true, mismatches: [], workspaceId: 'workspace', parent: 'lead',
  });
  current = { ...current, model: 'changed' };
  assert.deepEqual((await verifySeat(adapter, 'peer', pin)).mismatches, ['model:changed']);
  assert.equal(reads, 2, 'every observation refreshes once; no cached success');
});

for (const [field, diagnostic] of [
  ['id', 'agentId:unreported'], ['provider', 'provider:unreported'],
  ['cwd', 'cwd:unreported'], ['model', 'model:unreported'],
  ['workspaceId', 'workspaceId:unreported'], ['currentModeId', 'mode:unreported'],
  ['thinkingOptionId', 'thinking:unreported'], ['features', 'features:unreported'],
  ['archivedAt', 'archivedAt:unreported'],
]) {
  test(`native observation refuses unreported ${field} evidence`, async () => {
    const agent = snapshot(); delete agent[field];
    const result = await observe(agent);
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, [diagnostic]);
  });
}

test('native parent proof is the parent label, never workspace or another snapshot field', async () => {
  const agent = snapshot(); delete agent.labels['paseo.parent-agent-id'];
  agent.parentAgentId = 'lead';
  assert.deepEqual((await observe(agent)).mismatches, ['parent:unreported']);
  agent.labels['paseo.parent-agent-id'] = 'other';
  assert.deepEqual((await observe(agent)).mismatches, ['parent:other']);
});

test('managed provenance labels are exact, including explicit unavailable provenance', async () => {
  const agent = snapshot(); agent.labels['slp.formation'] = 'other';
  assert.deepEqual((await observe(agent)).mismatches, ['label:slp.formation:mismatch']);
  assert.deepEqual((await observe(snapshot(), { ...pin, labels: null })).mismatches,
    ['label:create-provenance-unavailable']);
});

test('null model/workspace/parent require reported absence, not missing evidence', async () => {
  const agent = snapshot(); agent.model = null; agent.workspaceId = null;
  delete agent.labels['paseo.parent-agent-id'];
  const expected = { ...pin, model: null, workspaceId: null, parent: null };
  assert.equal((await observe(agent, expected)).ok, true);
  delete agent.workspaceId; delete agent.model;
  assert.deepEqual((await observe(agent, expected)).mismatches, ['model:unreported', 'workspaceId:unreported']);
});

test('providers with unsupported modes must report explicit null, not omit mode evidence', async () => {
  const expected = { ...pin, modeId: undefined, modeIdUnsupported: true };
  const agent = snapshot(); agent.currentModeId = null;
  assert.equal((await observe(agent, expected)).ok, true);
  delete agent.currentModeId;
  assert.deepEqual((await observe(agent, expected)).mismatches, ['mode:unsupported:unreported']);
  agent.currentModeId = 'full-access';
  assert.deepEqual((await observe(agent, expected)).mismatches, ['mode:unsupported:full-access']);
});

test('thinking evidence uses effective thinking only when explicit thinking is absent', async () => {
  const agent = snapshot(); delete agent.thinkingOptionId; agent.effectiveThinkingOptionId = 'high';
  assert.equal((await observe(agent)).ok, true);
  agent.thinkingOptionId = 'low';
  assert.deepEqual((await observe(agent)).mismatches, ['thinking:low']);
});

test('requested features are exact while unrequested metadata is irrelevant', async () => {
  const agent = snapshot(); agent.features.push({ id: 'other', value: false });
  assert.equal((await observe(agent)).ok, true);
  agent.features = [{ id: 'fast_mode', value: false }];
  assert.deepEqual((await observe(agent)).mismatches, ['feature:fast_mode:false', 'feature:speed:absent']);
  delete agent.features; delete agent.currentModeId; delete agent.thinkingOptionId;
  assert.equal((await observe(agent, { ...pin, features: {}, modeId: undefined, thinkingOptionId: null })).ok, true);
});

test('unavailable snapshots stay uncertain without invented tuple fields', async () => {
  for (const refresh of [async () => null, async () => ({ agent: null, project: null })]) {
    assert.deepEqual(await verifySeat(host(refresh), 'peer', pin), {
      ok: false, mismatches: ['refresh returned no agent snapshot'],
    });
  }
});

test('private create tickets are redacted before refresh-error preview truncation', async () => {
  const ticket = 'private-issued-ticket';
  const message = `SDK ${ticket} ${'x'.repeat(160)} ${ticket}`;
  const result = await verifySeat(host(async () => { throw new Error(message); }), 'peer', pin, ticket);
  assert.deepEqual(result, {
    ok: false, mismatches: [`refresh-failed:${message.replaceAll(ticket, '[REDACTED]').slice(0, 128)}`],
  });
  assert.equal(JSON.stringify(result).includes(ticket), false);
  const rejected = snapshot(); rejected.cwd = `/tmp/${ticket}/${ticket}`;
  assert.deepEqual((await observe(rejected, pin, ticket)).mismatches,
    ['cwd:/tmp/[REDACTED]/[REDACTED]']);
});
