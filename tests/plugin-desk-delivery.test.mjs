import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskObserver, runTaskDispatch } from '../plugin/server/desk-task-execution.ts';
import { world, fixtureCtx, fixtureLedger, fixtureHost, fixtureDeps, coreDouble, realDesk } from './helpers/task-execution-fixtures.mjs';

test('send reconciliation requires the retained caller and message ID for projected inputs', async t => {
  const w = world(t), ledger = fixtureLedger(w), host = fixtureHost();
  ledger.taskEntries.push(
    { kind: 'attempt', entityId: 'attempt', revision: 1, attemptId: 'attempt', host: { agentId: 'agent-new' } },
    { kind: 'action', entityId: 'send', revision: 1, actionId: 'send', actionKind: 'send', attemptId: 'attempt', callerAgentId: 'old-owner', body: { messageId: 'delivery' } },
  );
  let entries = [];
  const ref = host.api.agents.ref;
  host.api.agents.ref = id => ({ ...ref(id), timeline: { refetch: async () => ({ entries }) } });
  const observer = createTaskObserver(fixtureCtx(), fixtureDeps(w, ledger, host.api, coreDouble(ledger).task));
  const request = { actionKind: 'send', actionId: 'send', agentId: 'agent-new', messageId: 'delivery' };
  for (const [sender, event, expected] of [['agent-owner', 'message', false], ['old-owner', 'finished', false], ['old-owner', 'errored', false], ['old-owner', 'message', true]]) {
    entries = [{ item: { type: 'tool_call', name: 'agent_message', status: 'completed', error: null,
      callId: 'paseo-agent-message:delivery', agentMessage: { event, sender: { id: sender }, text: 'work' } } }];
    assert.equal((await observer.observeAction(request)).resolved, expected);
  }
  entries = [{ item: { type: 'user_message', clientMessageId: 'delivery' } }];
  assert.equal((await observer.observeAction(request)).resolved, true, 'legacy transport remains correlated, with unknown author');
  assert.equal((await observer.observeAction({ ...request, agentId: 'foreign-worker' })).resolved, false);
});

test('create reconciliation includes background attempts and does not turn an empty scan into absence', async t => {
  const w = world(t), ledger = fixtureLedger(w), host = fixtureHost();
  ledger.taskEntries.push(
    { kind: 'attempt', entityId: 'attempt', revision: 1, attemptId: 'attempt', placement: { cwd: w.repo } },
    { kind: 'action', entityId: 'create', revision: 1, actionId: 'create', actionKind: 'create', attemptId: 'attempt' },
  );
  const calls = [];
  host.api.agents.list = async input => { calls.push(input); return { entries: [], pageInfo: { hasMore: false } }; };
  const observer = createTaskObserver(fixtureCtx(), fixtureDeps(w, ledger, host.api, coreDouble(ledger).task));
  const request = { actionKind: 'create', actionId: 'create', attemptId: 'attempt' };
  const result = await observer.observeAction(request);
  assert.deepEqual(calls, [{ filter: { labels: { 'slp.attempt': 'attempt' }, includeBackground: true }, page: { limit: 50 } }]);
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'create-candidates-incomplete-or-ambiguous');
  host.api.agents.list = async () => { throw new Error('background capability unavailable'); };
  await assert.rejects(observer.observeAction(request), /background capability unavailable/);
});

test('background label discovery recovers the exact created seat after a lost create acknowledgment', async t => {
  const d = await realDesk(t, { lostCreateAck: true });
  await d.define();
  const boot = await runTaskDispatch(d.ctx, d.bootInput(), d.deps);
  const action = d.ledger().taskEntries.filter(r => r.kind === 'action' && r.actionKind === 'create').at(-1);
  const agent = (await d.host.api.agents.ref('agent-new').refresh()).agent;
  assert.ok(agent);
  d.host.api.agents.list = async options => ({ entries: options.filter?.includeBackground ? [{ agent }] : [], pageInfo: { hasMore: false } });
  const result = await createTaskObserver(d.ctx, d.deps).observeAction({ actionKind: 'create', actionId: action.actionId, attemptId: boot.attemptId });
  assert.equal(result.resolved, true, JSON.stringify(result));
  assert.equal(result.agent.id, agent.id);
  assert.equal(d.host.calls.create.length, 1, 'discovery never creates a replacement');
});
