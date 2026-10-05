import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256 } from '../plugin/server/config-view.ts';
import { createDeskOperations } from '../plugin/server/desk-operation.ts';
import { createFormationPlanner, runSeatCreate, FormationPlanningError } from '../plugin/server/desk-formation.ts';
import { DeskSeatCreateInput, DeskTaskDeliverInput } from '../plugin/shared/delegation.ts';
import { memberRow } from './helpers/desk-bridge-fixture.mjs';
import { launchPlan } from '../plugin/server/runtime/cli/launch.ts';
import { install } from '../plugin/server/runtime/cli/package.ts';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'slp-formation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stableRoot = join(root, 'slp-runtime'); mkdirSync(stableRoot);
  const row = memberRow('formation-parent', {}, { agentId: 'parent', role: 'lead', createCwd: root, workspaceId: 'workspace' });
  const input = { requestId: 'form', role: 'lead', taskLabel: 'bounded', assignment: 'Orient and report.', grantRef: 'human:form' };
  const plan = { create: { provider: 'slp-codex-lead/model/variant', title: 'Lead bounded', workspaceId: 'workspace',
    initialPrompt: 'Orient and report.', settings: { modeId: 'full-access', thinkingOptionId: 'high', features: { fast_mode: true } } },
    modeSupport: { provider: 'slp-codex-lead', modes: ['full-access', 'auto'] } };
  const effects = [];
  let snapshot;
  const ref = () => ({ refresh: async () => ({ agent: snapshot, project: null }),
    send: async (text, options) => effects.push({ kind: 'send', text, options }),
    timeline: { refetch: async () => ({ entries: [] }) } });
  const create = async options => {
    effects.push({ kind: 'create', options });
    snapshot = { id: 'child', provider: 'slp-codex-lead', model: 'model/variant', cwd: root, workspaceId: 'workspace',
      labels: { ...options.labels, 'paseo.parent-agent-id': options.parent }, currentModeId: 'full-access',
      thinkingOptionId: 'high', features: [{ id: 'fast_mode', value: true }], archivedAt: null };
    return { id: 'child' };
  };
  const host = { agents: { ref, create, list: async () => ({ entries: [] }) }, workspaces: { ref: () => ({ agents: { create } }) },
    providers: { snapshot: async () => ({ entries: [] }) } };
  const deps = { stableRoot, repoKey: 'repo', host: () => host, plan: async () => structuredClone(plan), guard: async () => null };
  return { root, stableRoot, row, input, plan, effects, host, deps,
    snapshot: () => snapshot, setSnapshot: value => { snapshot = value; }, run: (data = input) => runSeatCreate(row, data, deps) };
}

test('ordinary formation derives native parent/placement, observes exact runtime and sends once without a caller file', async t => {
  const f = fixture(t), out = await f.run();
  assert.equal(out.state, 'recorded', JSON.stringify(out));
  assert.equal(out.result.state, 'host-accepted', JSON.stringify(out));
  assert.deepEqual(f.effects.map(row => row.kind), ['create', 'send']);
  const create = f.effects[0].options;
  assert.equal(create.parent, 'parent'); assert.equal('prompt' in create, false); assert.equal('cwd' in create, false);
  assert.deepEqual(create.config, { provider: 'slp-codex-lead/model/variant', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast_mode: true } });
  assert.equal(out.result.parent, 'parent'); assert.equal(out.result.workspaceId, 'workspace');
  const before = f.effects.length;
  const replay = await f.run(); assert.equal(replay.replayed, true); assert.equal(replay.receiptSha256, out.receiptSha256);
  assert.equal(f.effects.length, before);
  const changed = await f.run({ ...f.input, assignment: 'Different work' });
  assert.equal(changed.code, 'IDEMPOTENCY_CONFLICT'); assert.equal(f.effects.length, before);
});

for (const field of ['workspaceId', 'model', 'currentModeId', 'thinkingOptionId', 'features', 'labels']) {
  test(`formation with ${field} mismatch retains the created seat and withholds assignment`, async t => {
    const f = fixture(t), original = f.host.workspaces.ref;
    f.host.workspaces.ref = id => ({ agents: { create: async options => {
      const child = await original(id).agents.create(options);
      const snapshot = f.snapshot(); delete snapshot[field]; return child;
    } } });
    const out = await f.run(); assert.equal(out.result.state, 'identity-uncertain', JSON.stringify(out));
    assert.deepEqual(f.effects.map(row => row.kind), ['create']);
    await f.run(); assert.equal(f.effects.length, 1);
  });
}

for (const effect of ['create', 'send']) {
  test(`lost ${effect} acknowledgment cannot trigger resubmission`, async t => {
    const f = fixture(t);
    if (effect === 'create') f.host.workspaces.ref = () => ({ agents: { create: async () => { f.effects.push({ kind: 'create' }); throw new Error('lost'); } } });
    else f.host.agents.ref = () => ({ refresh: async () => ({ agent: f.snapshot(), project: null }), send: async () => { f.effects.push({ kind: 'send' }); throw new Error('lost'); } });
    const out = await f.run(); assert.equal(out.result.state, `${effect}-uncertain`);
    const count = f.effects.length; await f.run(); assert.equal(f.effects.length, count);
  });
}

test('bundle drift and ended actor authority block the next effect after create', async t => {
  const f = fixture(t);
  let plans = 0;
  f.deps.plan = async () => { plans++; return plans < 3 ? f.plan : {
    create: { ...f.plan.create, settings: { ...f.plan.create.settings, modeId: 'auto' } },
    modeSupport: f.plan.modeSupport,
  }; };
  const out = await f.run(); assert.equal(out.result.code, 'ROUTE_DRIFT'); assert.equal(out.result.agentId, 'child');
  assert.deepEqual(f.effects.map(row => row.kind), ['create']);
  const second = fixture(t);
  second.deps.guard = async () => second.effects.length ? { ok: false, code: 'STALE_EPOCH', message: 'revoked', recovery: 'stop' } : null;
  assert.equal((await second.run()).result.code, 'STALE_EPOCH');
  assert.deepEqual(second.effects.map(row => row.kind), ['create']);
});

test('exclusive durable intent serializes concurrent calls and a crashed operation stays partial', async t => {
  const f = fixture(t), ops = createDeskOperations(f.stableRoot);
  const identity = { repoKey: 'repo', membershipId: f.row.membershipId, agentId: 'parent', requestId: 'crash', kind: 'seat-create' };
  let release; const blocked = new Promise(resolve => { release = resolve; });
  let effects = 0;
  const first = ops.run(identity, { work: 1 }, async phase => { phase('create-issued', { label: 'one' }); effects++; await blocked; throw new Error('crash'); });
  const replay = await ops.run(identity, { work: 1 }, async () => { assert.fail('duplicate execution'); });
  assert.equal(replay.state, 'partial'); assert.equal(replay.phases[0].name, 'create-issued');
  release(); await first; assert.equal(effects, 1);
  assert.equal((await ops.run(identity, { work: 1 }, async () => assert.fail('resume'))).state, 'partial');
  const path = join(f.stableRoot, 'state/operations', readdirSync(join(f.stableRoot, 'state/operations'))[0]);
  const bytes = readFileSync(join(path, '0.json'), 'utf8'); writeFileSync(join(path, '0.json'), bytes.replace('one', 'two'));
  assert.equal(ops.get(identity).code, 'STATE_UNREADABLE');
  assert.equal((await ops.run(identity, { work: 1 }, async () => assert.fail('corrupt retry'))).code, 'STATE_UNREADABLE');
});

test('unsafe receipt ancestry admits no effect', async t => {
  const f = fixture(t); mkdirSync(join(f.stableRoot, 'state'));
  symlinkSync(f.root, join(f.stableRoot, 'state/operations'));
  const out = await f.run(); assert.equal(out.ok, false); assert.deepEqual(f.effects, []);
});

test('strict convenience inputs cannot inject identity/settings, waive task grants or reuse a seat', () => {
  const input = { requestId: 'r', role: 'lead', taskLabel: 'bounded', assignment: 'work', grantRef: 'human:form' };
  assert.equal(DeskSeatCreateInput.safeParse(input).success, true);
  for (const extra of [{ parent: 'other' }, { workspaceId: 'other' }, { settings: {} }, { runtime: {} }, { labels: {} }]) {
    assert.equal(DeskSeatCreateInput.safeParse({ ...input, ...extra }).success, false);
  }
  assert.equal(DeskTaskDeliverInput.safeParse({ reuseTarget: { agentId: 'old' } }).success, false);
});

test('production planner uses fresh saved bundles, ready SDK providers and exact installed plan without runtime overrides', async t => {
  const f = fixture(t), runtimePath = join(f.root, 'candidate');
  install(fileURLToPath(new URL('..', import.meta.url)), runtimePath);
  const profile = { id: 'slp-lead', provider: 'slp-codex-lead', model: 'model/variant', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast_mode: true } };
  const save = value => writeFileSync(join(f.root, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [value] } })); save(profile);
  const calls = [];
  f.host.providers.snapshot = async input => { calls.push(input); return { entries: [{ provider: 'slp-codex-lead', enabled: true, status: 'ready', modes: [{ id: 'full-access' }] }] }; };
  const planner = createFormationPlanner({ runtimePath, daemonHome: f.root, host: () => f.host });
  const plan = await planner(f.row, f.input);
  assert.deepEqual(plan.create.settings, f.plan.create.settings); assert.equal(plan.create.provider, f.plan.create.provider);
  assert.equal(plan.create.workspaceId, 'workspace'); assert.match(plan.create.initialPrompt, /Tuyến handback: parent agent ID đã xác minh là parent\./);
  assert.deepEqual(calls, [{ cwd: f.root }]);
  f.host.providers.snapshot = async () => ({ entries: [{ provider: 'slp-codex-lead', enabled: true, status: 'loading', modes: [{ id: 'full-access' }] }] });
  await assert.rejects(planner(f.row, f.input), error => error.code === 'INVALID_RECORD' && /validation failed/.test(error.message));
  f.host.providers.snapshot = async () => { save({ ...profile, model: 'changed' }); return { entries: [{ provider: 'slp-codex-lead', enabled: true, status: 'ready', modes: [{ id: 'full-access' }] }] }; };
  await assert.rejects(planner(f.row, f.input), /saved profiles changed/);
});

for (const leg of [1,2,3]) {
 test(`known planner failure at leg ${leg} records a typed outcome and preserves any created identity`,async t=>{
  const f=fixture(t); let calls=0;
  f.deps.plan=async()=>{calls++;if(calls===leg)throw new FormationPlanningError('CAPABILITY_GAP','provider observation unavailable');return f.plan;};
  const out=await f.run(); assert.equal(out.state,'recorded'); assert.equal(out.result.code,'CAPABILITY_GAP');
  assert.equal(out.result.agentId,leg===3?'child':undefined);
  assert.deepEqual(f.effects.map(effect=>effect.kind),leg===3?['create']:[]);
  const count=f.effects.length; await f.run(); assert.equal(f.effects.length,count);
 });
}

test('production planner separates capability failure from config/validation failures',async t=>{
 const f=fixture(t);
 const noHost=createFormationPlanner({runtimePath:f.root,daemonHome:f.root,host:()=>null});
 await assert.rejects(noHost(f.row,f.input),error=>error.code==='CAPABILITY_GAP');
 await assert.rejects(noHost({...f.row,workspaceId:null},f.input),error=>error.code==='CAPABILITY_GAP');
});
