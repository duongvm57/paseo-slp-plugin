import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskBoundedHost, TaskHostWaitExpired } from '../plugin/server/desk-task-host.ts';

function fixture() {
  const calls = [];
  const agent = {
    id: 'fixture-agent',
    refresh: async (...args) => { calls.push(['refresh', ...args]); return { agent: { id: 'fixture-agent' }, project: null }; },
    send: async (...args) => { calls.push(['send', ...args]); },
    archive: async () => { calls.push(['archive']); return { archivedAt: 'fixture-date' }; },
    waitForFinish: async (...args) => { calls.push(['wait', ...args]); return { outcome: 'completed' }; },
    timeline: { refetch: async (...args) => { calls.push(['timeline', ...args]); return { entries: [] }; } },
  };
  const api = {
    providers: { snapshot: async (...args) => { calls.push(['snapshot', ...args]); return { entries: [] }; } },
    agents: {
      ref: id => { calls.push(['ref', id]); return agent; },
      create: async options => { calls.push(['create', options]); return agent; },
      list: async options => { calls.push(['list', options]); return { entries: [] }; },
    },
    workspaces: { ref: id => ({ agents: { create: async options => { calls.push(['workspace.create', id, options]); return agent; } } }) },
  };
  return { calls, agent, api };
}

test('task host preserves create, workspace, message identity and fresh observation arguments', async () => {
  const f = fixture(), host = createTaskBoundedHost(f.api);
  const options = { config: { provider: 'slp-devin-peer/swe-2-high' }, cwd: '/fixture', parent: 'owner', idempotencyKey: 'create-key' };
  const agent = await host.agents.create(options);
  assert.equal(agent.id, 'fixture-agent');
  await agent.send('bounded work', { messageId: 'delivery-id' });
  await agent.refresh('refresh-id');
  await agent.timeline.refetch({ limit: 50 });
  await agent.archive();
  await host.providers.snapshot({ cwd: '/fixture' });
  await host.agents.list({ filter: { labels: { 'slp.attempt': 'attempt-id' } }, page: { limit: 50 } });
  const workspaceOptions = { config: options.config, parent: 'owner', idempotencyKey: 'workspace-key' };
  await host.workspaces.ref('workspace-id').agents.create(workspaceOptions);
  assert.deepEqual(f.calls, [
    ['create', options], ['send', 'bounded work', { messageId: 'delivery-id' }], ['refresh', 'refresh-id'],
    ['timeline', { limit: 50 }], ['archive'], ['snapshot', { cwd: '/fixture' }],
    ['list', { filter: { labels: { 'slp.attempt': 'attempt-id' } }, page: { limit: 50 } }],
    ['workspace.create', 'workspace-id', workspaceOptions],
  ]);
});

test('expired create keeps late host completion separate from cancellation and performs no retry or archive', async () => {
  const f = fixture();
  let finish, creates = 0;
  f.api.agents.create = () => { creates++; return new Promise(resolve => { finish = resolve; }); };
  const host = createTaskBoundedHost(f.api, { effectMs: 10 });
  await assert.rejects(host.agents.create({ config: { provider: 'fixture' }, cwd: '/fixture' }), error => {
    assert.ok(error instanceof TaskHostWaitExpired);
    assert.equal(error.operation, 'create');
    assert.equal(error.effectMayContinue, true);
    return true;
  });
  finish(f.agent);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates, 1);
  assert.deepEqual(f.calls, []);
});

for (const operation of ['send', 'archive']) {
  test(`expired ${operation} remains an unresolved effect`, async () => {
    const f = fixture();
    let invocations = 0;
    f.agent[operation] = () => { invocations++; return new Promise(() => {}); };
    const agent = createTaskBoundedHost(f.api, { effectMs: 10 }).agents.ref('fixture-agent');
    await assert.rejects(agent[operation]('work', { messageId: 'same-id' }), error => error instanceof TaskHostWaitExpired && error.effectMayContinue);
    assert.equal(invocations, 1);
  });
}

test('unanswered provider and timeline reads establish no observation', async () => {
  const f = fixture();
  f.api.providers.snapshot = () => new Promise(() => {});
  f.agent.timeline.refetch = () => new Promise(() => {});
  const host = createTaskBoundedHost(f.api, { readMs: 10 });
  for (const read of [() => host.providers.snapshot(), () => host.agents.ref('fixture-agent').timeline.refetch()]) {
    await assert.rejects(read(), error => error instanceof TaskHostWaitExpired && error.effectMayContinue === false);
  }
});

test('host rejection is preserved without converting it to an absence or retry', async () => {
  const f = fixture(), rejection = new Error('connection lost after request');
  let calls = 0;
  f.agent.send = async () => { calls++; throw rejection; };
  const host = createTaskBoundedHost(f.api);
  await assert.rejects(host.agents.ref('fixture-agent').send('work', { messageId: 'same-id' }), error => error === rejection);
  assert.equal(calls, 1);
});

test('live config transport reads retain request identity and remain bounded read-only observations',async()=>{
 const f=fixture();let calls=0;
 f.api.config={get:async requestId=>{calls++;return {requestId,config:{providers:{}}};}};
 const host=createTaskBoundedHost(f.api,{readMs:10});
 assert.deepEqual(await host.config.get('transport-read'),{requestId:'transport-read',config:{providers:{}}});
 f.api.config.get=()=>{calls++;return new Promise(()=>{});};
 await assert.rejects(host.config.get(),error=>error instanceof TaskHostWaitExpired && error.operation==='config.get' && error.effectMayContinue===false);
 assert.equal(calls,2);assert.deepEqual(f.calls,[]);
});
