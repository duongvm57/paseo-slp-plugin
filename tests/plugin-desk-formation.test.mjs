import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256 } from '../plugin/server/config-view.ts';
import { createDeskOperations } from '../plugin/server/desk-operation.ts';
import { createFormationPlanner, runSeatCreate, FormationPlanningError } from '../plugin/server/desk-formation.ts';
import { DeskSeatCreateInput, DeskTaskDeliverInput } from '../plugin/shared/delegation.ts';
import { WIRE_LIMITS } from '../plugin/shared/enforcement.ts';
import { createFormationPlacement } from '../plugin/server/desk-placement.ts';
import { execFileSync } from 'node:child_process';
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
  let currentRole = input.role;
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
  const host = { agents: { ref, create, list: async () => ({ entries: [] }) }, workspaces: { ref: id => ({ id,
    refresh:async()=>({id,workspaceDirectory:root,status:'done',archivingAt:null}),agents: { create } }) },
    providers: { snapshot: async () => ({ entries: [] }) } };
  const deps = { stableRoot, repoKey: 'repo', host: () => host, plan: async () => structuredClone(plan), guard: async () => null,
    placement:createFormationPlacement({repo:{gitCommonDir:join(root,'.git')},host:()=>host,
      git:{commonDir:async()=>join(root,'.git'),top:async()=>root,revParse:async()=>null}}),
    readMemberships: () => snapshot ? [memberRow('child-member', {provider:snapshot.provider,at:'2026-01-01T00:00:00.000Z'},
      {agentId:'child',role:currentRole,createCwd:snapshot.cwd,workspaceId:snapshot.workspaceId})] : [] };
  return { root, stableRoot, row, input, plan, effects, host, deps,
    snapshot: () => snapshot, setSnapshot: value => { snapshot = value; }, run: (data = input) => { currentRole=data.role;return runSeatCreate(row, data, deps); } };
}

test('delivery server: ordinary formation derives native parent/placement, observes exact runtime and sends once without a caller file', async t => {
  const f = fixture(t), serverInput = { ...f.input, delivery: 'server' }, out = await f.run(serverInput);
  assert.equal(out.state, 'recorded', JSON.stringify(out));
  assert.equal(out.result.state, 'host-accepted', JSON.stringify(out));
  assert.deepEqual(f.effects.map(row => row.kind), ['create', 'send']);
  const create = f.effects[0].options;
  assert.equal(create.parent, 'parent'); assert.equal('prompt' in create, false); assert.equal('cwd' in create, false);
  assert.deepEqual(create.config, { provider: 'slp-codex-lead/model/variant', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast_mode: true } });
  assert.equal(out.result.parent, 'parent'); assert.equal(out.result.workspaceId, 'workspace');
  const before = f.effects.length;
  const replay = await f.run(serverInput); assert.equal(replay.replayed, true); assert.equal(replay.receiptSha256, out.receiptSha256);
  assert.equal(f.effects.length, before);
  const changed = await f.run({ ...serverInput, assignment: 'Different work' });
  assert.equal(changed.code, 'IDEMPOTENCY_CONFLICT'); assert.equal(f.effects.length, before);
});

for (const field of ['workspaceId', 'model', 'currentModeId', 'thinkingOptionId', 'features', 'labels']) {
  test(`formation with ${field} mismatch retains the created seat and withholds assignment`, async t => {
    const f = fixture(t), original = f.host.workspaces.ref;
    f.host.workspaces.ref = id => ({ ...original(id), agents: { create: async options => {
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
    if (effect === 'create') {
      const original=f.host.workspaces.ref;
      f.host.workspaces.ref = id => ({ ...original(id), agents: { create: async () => { f.effects.push({ kind: 'create' }); throw new Error('lost'); } } });
    }
    else f.host.agents.ref = () => ({ refresh: async () => ({ agent: f.snapshot(), project: null }), send: async () => { f.effects.push({ kind: 'send' }); throw new Error('lost'); } });
    const input = { ...f.input, delivery: 'server' };
    const out = await f.run(input); assert.equal(out.result.state, `${effect}-uncertain`);
    const count = f.effects.length; await f.run(input); assert.equal(f.effects.length, count);
  });
}

test('default delivery hands the exact prompt to the caller without an SDK send and replay repeats no effect', async t => {
  const f = fixture(t), out = await f.run();
  assert.equal(out.state, 'recorded', JSON.stringify(out));
  const result = out.result, promptSha256 = canonicalSha256(f.plan.create.initialPrompt);
  assert.equal(result.state, 'awaiting-caller-delivery'); assert.equal(result.sent, false);
  assert.equal(result.resourceDisposition, 'retained'); assert.equal(result.parent, 'parent'); assert.equal(result.agentId, 'child');
  assert.deepEqual(result.delivery, { tool: 'send_agent_prompt', agentId: 'child', notifyOnFinish: true, prompt: f.plan.create.initialPrompt, promptSha256 });
  assert.deepEqual(f.effects.map(row => row.kind), ['create']);
  assert.deepEqual(out.phases.map(phase => phase.name), ['prepared', 'create-issued', 'create-returned', 'create-observed', 'delivery-handed-off']);
  assert.deepEqual(out.phases[4].value, { agentId: 'child', promptSha256 });
  const replay = await f.run(); assert.equal(replay.replayed, true); assert.equal(replay.receiptSha256, out.receiptSha256);
  assert.equal(f.effects.length, 1);
  // The intent binds the body as received: absent replays its receipt; explicit "caller"/"server" are different bodies.
  assert.equal((await f.run({ ...f.input, delivery: 'caller' })).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.run({ ...f.input, delivery: 'server' })).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.effects.length, 1);
});

test('drift or revoked authority before caller handoff blocks it exactly as it blocks a server send', async t => {
  for (const delivery of [undefined, 'caller', 'server']) {
    const f = fixture(t); let plans = 0;
    f.deps.plan = async () => { plans++; return plans < 3 ? f.plan : { create: { ...f.plan.create, settings: { ...f.plan.create.settings, modeId: 'auto' } }, modeSupport: f.plan.modeSupport }; };
    const input = delivery === undefined ? f.input : { ...f.input, delivery };
    const out = await f.run(input); assert.equal(out.result.code, 'ROUTE_DRIFT'); assert.equal(out.result.agentId, 'child');
    assert.deepEqual(f.effects.map(row => row.kind), ['create']);
    assert.equal(out.phases.some(phase => ['delivery-handed-off', 'send-issued'].includes(phase.name)), false);
    const second = fixture(t);
    second.deps.guard = async () => second.effects.length ? { ok: false, code: 'STALE_EPOCH', message: 'revoked', recovery: 'stop' } : null;
    const revoked = await second.run(input); assert.equal(revoked.result.code, 'STALE_EPOCH');
    assert.equal(revoked.phases.some(phase => ['delivery-handed-off', 'send-issued'].includes(phase.name)), false);
  }
});

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
  for (const delivery of ['caller', 'server']) assert.equal(DeskSeatCreateInput.safeParse({ ...input, delivery }).success, true);
  assert.equal(DeskSeatCreateInput.safeParse({ ...input, delivery: 'other' }).success, false);
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
  assert.equal(plan.create.workspaceId, 'workspace'); assert.match(plan.create.initialPrompt, /Handback route: the verified parent agent ID is parent\./);
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


test('Peer formation accepts optional runtime or independent selection without rewriting legacy input', () => {
  const base = { requestId: 'r', role: 'peer', taskLabel: 'bounded', assignment: 'work', grantRef: 'human:form' };
  assert.deepEqual(DeskSeatCreateInput.parse(base), base);
  const selected = { ...base, selection: { optionId: 'independent-choice' } };
  assert.deepEqual(DeskSeatCreateInput.parse(selected), selected);
  const legacy = { ...base, runtime: { optionId: 'old', catalogSha256: 'a'.repeat(64) } };
  assert.deepEqual(DeskSeatCreateInput.parse(legacy), legacy);
  assert.equal(DeskSeatCreateInput.safeParse({ ...legacy, selection: selected.selection }).success, false);
  assert.equal(DeskSeatCreateInput.safeParse({ ...base, selection: { optionId: 'x', model: 'override' } }).success, false);
  assert.equal(DeskSeatCreateInput.safeParse({ ...base, role: 'lead', selection: selected.selection }).success, false);
});

test('automatic Peer selection occurs only in one admitted executor and stays fixed across all replans', async t => {
  const f = fixture(t); let selectedCalls = 0, plans = 0;
  const selected = { route: { optionId: 'pool', catalogSha256: 'a'.repeat(64) }, mode: 'armed',
    modeSha256: 'b'.repeat(64), origin: 'jev', source: { repository: f.root, catalogFile: '/pool', scope: 'repository' }, decisionResult: { decision: { full: true } } };
  f.deps.preflightPeer = async () => null;
  f.deps.selectPeer = async (_row, _input, phase) => {
    assert.equal(readdirSync(join(f.stableRoot, 'state/operations')).length, 1);
    selectedCalls++; phase('route-issued', { mode: 'armed' }); return selected;
  };
  f.deps.plan = async (_row, _input, context) => { plans++; assert.deepEqual(context.selected, selected); return f.plan; };
  const input = { ...f.input, role: 'peer' };
  const out = await f.run(input);
  assert.equal(out.result.state, 'awaiting-caller-delivery'); assert.equal(plans, 3); assert.equal(selectedCalls, 1);
  assert.deepEqual(out.phases.map(p => p.name), ['route-issued', 'route-selected', 'prepared', 'create-issued', 'create-returned', 'create-observed', 'delivery-handed-off']);
  assert.deepEqual(out.phases[1].value, selected);
  let replayPreflights = 0, replayDecisions = 0;
  f.deps.preflightPeer = async () => { replayPreflights++; return null; };
  f.deps.selectPeer = async () => { replayDecisions++; return selected; }; f.deps.plan = async () => assert.fail('replay plan');
  const replay = await f.run(input); assert.equal(replay.receiptSha256, out.receiptSha256);
  assert.equal(replay.replayed, true); assert.equal(f.effects.length, 1);
  assert.equal(replayPreflights, 0); assert.equal(replayDecisions, 0);
});

test('explicit legacy Peer runtime preserves five phases and invokes no selection hooks', async t => {
  const f = fixture(t);
  f.deps.preflightPeer = async () => assert.fail('legacy preflight');
  f.deps.selectPeer = async () => assert.fail('legacy decision');
  const input = { ...f.input, role: 'peer', runtime: { optionId: 'old', catalogSha256: 'a'.repeat(64) } };
  const out = await f.run(input);
  assert.deepEqual(out.phases.map(p => p.name), ['prepared', 'create-issued', 'create-returned', 'create-observed', 'delivery-handed-off']);
  const path = join(f.stableRoot, 'state/operations', readdirSync(join(f.stableRoot, 'state/operations'))[0]);
  const before = Object.fromEntries(readdirSync(path).map(name => [name, readFileSync(join(path,name),'utf8')]));
  assert.deepEqual(JSON.parse(before['intent.json']).body.request, input);
  await f.run(input);
  assert.deepEqual(Object.fromEntries(readdirSync(path).map(name => [name,readFileSync(join(path,name),'utf8')])),before);
});

import { selectionFixture } from './helpers/seat-selection-fixture.mjs';
import { pathToFileURL } from 'node:url';
import { routeDecide } from '../plugin/server/runtime/cli/jev-routing.ts';

async function realPeerFixture(t, mode, count = 2) {
 const f=selectionFixture(t,{mode,count});
 execFileSync('git',['init','-q',f.repository]);
 const candidate=join(f.dir,'candidate');install(fileURLToPath(new URL('..',import.meta.url)),candidate);
 const row=memberRow('peer-parent',{}, {agentId:'parent',role:'lead',createCwd:f.repository,workspaceId:'workspace'});
 const effects=[];let snapshot,decisions=0;
 const create=async options=>{
  effects.push({kind:'create',options});
  const split=options.config.provider.indexOf('/');
  snapshot={id:'child',provider:options.config.provider.slice(0,split),model:options.config.provider.slice(split+1),
   cwd:f.repository,workspaceId:'workspace',archivedAt:null,labels:{...options.labels,'paseo.parent-agent-id':options.parent},
   currentModeId:options.config.modeId,thinkingOptionId:options.config.thinkingOptionId,
   features:Object.entries(options.config.featureValues).map(([id,value])=>({id,value}))};
  return {id:'child'};
 };
 const host={providers:{snapshot:async()=>({entries:[{provider:'slp-codex-peer',enabled:true,status:'ready',modes:[{id:'full-access'}]}]})},
  agents:{ref:()=>({refresh:async()=>({agent:snapshot,project:null}),send:async()=>{effects.push({kind:'send'});},timeline:{refetch:async()=>({entries:[]})}})},workspaces:{ref:id=>({id,
   refresh:async()=>({id,workspaceDirectory:f.repository,status:'done',archivingAt:null}),agents:{create}})}};
 const loaded=[];
 const planner=createFormationPlanner({runtimePath:candidate,daemonHome:f.home,host:()=>host,
  importModule:async spec=>{
   loaded.push(spec);assert.equal(spec,pathToFileURL(join(candidate,'plugin/server/runtime/cli/launch.ts')).href);
   const launch=await import(spec);
   return {...launch,selectPeerSeat:(req,deps)=>launch.selectPeerSeat(req,{...deps,decide:async request=>{
    decisions++;return routeDecide(request,{fetchImpl:f.fetchImpl});
   }})};
  }});
 const deps={stableRoot:join(f.home,'slp-runtime'),repoKey:'repo',host:()=>host,plan:planner,
  preflightPeer:planner.preflightPeer,selectPeer:planner.selectPeer,guard:async()=>null,
  placement:createFormationPlacement({repo:{gitCommonDir:join(f.repository,'.git')},host:()=>host}),
  readMemberships:()=>snapshot?[memberRow('peer-child',{provider:snapshot.provider,at:'2026-01-01T00:00:00.000Z'},
    {agentId:'child',role:'peer',createCwd:snapshot.cwd,workspaceId:snapshot.workspaceId})]:[]};
 const input={requestId:'matrix',role:'peer',taskLabel:'bounded',assignment:f.request.assignment,grantRef:'human:fixture'};
 return {...f,row,candidate,host,effects,loaded,planner,formationDeps:deps,input,decisions:()=>decisions,
  run:request=>runSeatCreate(row,request??input,deps)};
}

for(const mode of ['unconfigured','off','shadow','armed','error']){
 for(const shape of ['runtime','selection','none']){
  test('matrix '+mode+' × '+shape+' preserves choice, phase count and replay',async t=>{
   // Generate any old receipt before corrupting Jev config; explicit path never calls new selector.
   const f=await realPeerFixture(t,mode==='error'?'off':mode);
   let runtime={optionId:'first',catalogSha256:f.sha()};
   if(mode==='armed'||mode==='shadow'){
    f.setChoice('first');const prior=await f.decide({repository:f.repository,paseoHome:f.home,brief:f.request.assignment});runtime.decision=prior.decision;
   }
   if(mode==='error')f.configure('error');
   const before=f.calls.fetch;
   const req={...f.input,...(shape==='runtime'?{runtime}:shape==='selection'?{selection:{optionId:'first'}}:{})};
   const out=await f.run(req);
   if(mode==='error'){
    assert.equal(out.ok===false||out.result?.ok===false,true,JSON.stringify(out));assert.equal(f.effects.length,0);
   }else if(shape==='none' && mode!=='armed'){
    assert.equal(out.state,'selection-required');assert.equal(out.operationAdmitted,false);assert.equal(f.effects.length,0);
    assert.equal(readdirSync(join(f.home,'slp-runtime','state')).includes('operations'),false);
    const chosen=await f.run({...req,selection:{optionId:'first'}});
    assert.equal(chosen.result.state,'awaiting-caller-delivery');
   }else{
    assert.equal(out.result.state,'awaiting-caller-delivery',JSON.stringify(out));
    const expected=shape==='runtime'?5:mode==='armed'||mode==='shadow'?7:6;
    assert.equal(out.phases.length,expected);assert.equal(out.phases.length<=16,true);
    assert.equal(out.phases.some(p=>p.name==='route-selected'),shape!=='runtime');
    assert.equal(f.decisions(),shape==='runtime'?0:mode==='armed'||mode==='shadow'?1:0);
    const after=f.calls.fetch;
    f.configure('error');f.formationDeps.preflightPeer=async()=>assert.fail('replay preflight');
    f.formationDeps.selectPeer=async()=>assert.fail('replay decision');
    const replay=await f.run(req);
    assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.calls.fetch,after);assert.equal(f.effects.length,1);
   }
   if(shape==='runtime')assert.equal(f.calls.fetch,before);
  });
 }
}
for(const failure of ['network','timeout','schema','missing-key','decline']){
 test('admitted armed '+failure+' records refusal, creates nothing and replays without Jev',async t=>{
  const f=await realPeerFixture(t,'armed',1);f.setFailure(failure);
  if(failure==='missing-key')rmSync(f.keyPath);
  if(failure==='decline')f.setChoice('no-suitable-option');
  const out=await f.run();assert.equal(out.state,'recorded');assert.equal(out.result.ok,false);
  assert.equal(out.phases.length,failure==='decline'?2:1);assert.equal(out.phases[0].name,'route-issued');assert.equal(f.effects.length,0);
  if(failure==='decline')assert.equal(out.phases[1].value.decision.answers.route_option.choice,'no-suitable-option');
  const before=f.calls.fetch;await f.run();assert.equal(f.calls.fetch,before);assert.equal(f.effects.length,0);
 });
}
test('caller and server delivery have the same worst-case seven phase budget',async t=>{
 const f=await realPeerFixture(t,'armed');
 const out=await f.run({...f.input,delivery:'server'});
 assert.equal(out.result.state,'host-accepted');assert.equal(out.phases.length,7);
 assert.equal(out.phases.at(-1).name,'send-issued');assert.equal(f.decisions(),1);
 assert.deepEqual(f.effects.map(e=>e.kind),['create','send']);
});
test('pending route-issued and route-selected histories never resume selection or reseal intent',async t=>{
 for(const last of ['route-issued','route-selected']){
  const f=await realPeerFixture(t,'armed');
  const identity={repoKey:'repo',membershipId:f.row.membershipId,agentId:'parent',kind:'seat-create',requestId:f.input.requestId};
  const ops=createDeskOperations(f.formationDeps.stableRoot);
  await ops.run(identity,f.input,async phase=>{phase(last,{retained:true});throw new Error('process interrupted');});
  const out=await f.run();assert.equal(out.state,'partial');assert.equal(out.phases[0].name,last);
  assert.equal(f.decisions(),0);assert.equal(f.effects.length,0);
 }
});
test('missing bound candidate selector fails automatically but preserves explicit-runtime compatibility',async t=>{
 const f=await realPeerFixture(t,'off',1);
 const old=createFormationPlanner({runtimePath:f.candidate,daemonHome:f.home,host:()=>f.host,
  importModule:async spec=>{const {launchPlan}=await import(spec);return {launchPlan};}});
 f.formationDeps.plan=old;f.formationDeps.preflightPeer=old.preflightPeer;f.formationDeps.selectPeer=old.selectPeer;
 assert.equal((await f.run()).code,'CAPABILITY_GAP');assert.equal(f.effects.length,0);
 const req={...f.input,runtime:{optionId:'first',catalogSha256:f.sha()}};
 assert.equal((await f.run(req)).result.state,'awaiting-caller-delivery');
});
test('automatic provider unavailability blocks without silently selecting another option',async t=>{
 const f=await realPeerFixture(t,'off',1);
 f.host.providers.snapshot=async()=>({entries:[{provider:'slp-codex-peer',enabled:true,status:'unavailable',modes:[{id:'full-access'}]}]});
 const out=await f.run();assert.equal(out.result.ok,false);assert.equal(f.effects.length,0);
});

test('automatic decision checks caller authority again after awaited provider observation',async t=>{
 const f=await realPeerFixture(t,'armed');let reads=0;
 const original=f.host.providers.snapshot;
 f.host.providers.snapshot=async()=>{reads++;return original();};
 f.formationDeps.guard=async()=>reads?{ok:false,code:'STALE_EPOCH',message:'revoked',recovery:'stop'}:null;
 const out=await f.run();assert.equal(out.result.code,'STALE_EPOCH');assert.equal(f.decisions(),0);assert.equal(f.effects.length,0);
});
for(const leg of ['before-create','before-delivery']){
 test('fixed automatic pool pin blocks '+leg+' drift without re-deciding',async t=>{
  const f=await realPeerFixture(t,'armed');let observations=0;const original=f.host.providers.snapshot;
  f.host.providers.snapshot=async()=>{observations++;if(observations===(leg==='before-create'?3:4)){f.options[0].notes='changed';f.savePool();}return original();};
  const out=await f.run();assert.equal(out.result.code,'ROUTE_DRIFT');assert.equal(f.decisions(),1);
  assert.equal(f.effects.length,leg==='before-create'?0:1);
  assert.equal(out.phases.some(p=>p.name==='delivery-handed-off'),false);
 });
}
test('offline prepare and check cannot invoke the automatic selector or network',async t=>{
 const f=await realPeerFixture(t,'armed');const out=await f.run();
 const selected=out.phases.find(p=>p.name==='route-selected').value;
 const module=await import(pathToFileURL(join(f.candidate,'plugin/server/runtime/cli/launch.ts')).href);
 let networkCalls=0;
 const old=globalThis.fetch;globalThis.fetch=async()=>{networkCalls++;throw new Error('prepare network');};t.after(()=>{globalThis.fetch=old;});
 const request={repository:f.repository,workspaceId:'workspace',role:'peer',assignment:f.request.assignment,
  providers:f.providers,route:selected.route,paseoHome:f.home};
 assert.equal(module.launchPlan(f.candidate,request).routing.optionId,'second');
 assert.equal(module.launchCheck(f.candidate,request).ok,true);
 assert.equal(networkCalls,0);
 assert.equal(f.decisions(),1);
});
test('automatic formation refuses oversized retained prompt evidence before native allocation',async t=>{
 const f=fixture(t);const selected={route:{optionId:'x',catalogSha256:'a'.repeat(64)},source:{repository:f.root,catalogFile:'/pool',scope:'repository'},
  mode:'off',modeSha256:'b'.repeat(64),origin:'unique'};
 f.deps.preflightPeer=async()=>null;f.deps.selectPeer=async()=>selected;
 f.plan.create.initialPrompt='x'.repeat(100000);
 const out=await f.run({...f.input,role:'peer'});assert.equal(out.result.code,'REQUEST_TOO_LARGE');assert.equal(f.effects.length,0);
 assert.equal(out.phases.length,1);assert.equal(out.phases[0].name,'route-selected');
});

for(const character of ['界','\0']){
 test('oversized automatic assignment '+JSON.stringify(character)+' preserves requestId before armed decision/admission',async t=>{
  const f=await realPeerFixture(t,'armed');
  const oversized=DeskSeatCreateInput.parse({...f.input,assignment:character.repeat(WIRE_LIMITS.deskTaskText)});
  const out=await f.run(oversized);
  assert.equal(f.decisions(),0);assert.equal(f.calls.fetch,0);assert.equal(f.effects.length,0);
  assert.equal(out.code,'REQUEST_TOO_LARGE');
  assert.equal(readdirSync(join(f.home,'slp-runtime/state')).includes('operations'),false);
  const shortened=await f.run(f.input);
  assert.equal(shortened.result.state,'awaiting-caller-delivery');assert.equal(f.decisions(),1);
  assert.equal(shortened.identity.requestId,oversized.requestId);assert.equal(shortened.phases.length,7);
 });
}
test('oversized legacy full-runtime assignment keeps original admission and five phases',async t=>{
 const f=await realPeerFixture(t,'off');
 const input=DeskSeatCreateInput.parse({...f.input,assignment:'界'.repeat(WIRE_LIMITS.deskTaskText),
  runtime:{optionId:'first',catalogSha256:f.sha()}});
 const out=await f.run(input);
 assert.equal(out.result.state,'awaiting-caller-delivery');assert.equal(out.phases.length,5);assert.equal(f.decisions(),0);
 const replay=await f.run(input);assert.equal(replay.receiptSha256,out.receiptSha256);assert.equal(f.effects.length,1);
});

test('candidate drift during provider observation blocks automatic decision before any network',async t=>{
 const f=await realPeerFixture(t,'armed');
 const original=f.host.providers.snapshot;
 f.host.providers.snapshot=async()=>{writeFileSync(join(f.candidate,'src/common.md'),'changed candidate bytes');return original();};
 const out=await f.run();assert.equal(out.result.code,'RUNTIME_INTEGRITY');assert.equal(f.decisions(),0);assert.equal(f.effects.length,0);
});
test('legacy recorded full-runtime intent and all five phases replay byte-for-byte without discovery',async t=>{
 const f=fixture(t);const input={...f.input,role:'peer',runtime:{optionId:'old',catalogSha256:'a'.repeat(64)}};
 const identity={repoKey:'repo',membershipId:f.row.membershipId,agentId:'parent',requestId:input.requestId,kind:'seat-create'};
 const path=join(f.stableRoot,'state/operations',canonicalSha256([identity.repoKey,identity.membershipId,identity.agentId,identity.kind,identity.requestId]));
 mkdirSync(path,{recursive:true,mode:0o700});
 let previous=null;
 const put=(name,body)=>{const row={schemaVersion:1,previousSha256:previous,body,sha256:canonicalSha256({previousSha256:previous,body})};
  writeFileSync(join(path,name),JSON.stringify(row),{mode:0o600});previous=row.sha256;};
 put('intent.json',{identity,request:input});
 for(const [i,name] of ['prepared','create-issued','create-returned','create-observed','delivery-handed-off'].entries())put(i+'.json',{name,value:{old:true}});
 put('result.json',{ok:true,state:'awaiting-caller-delivery',agentId:'old-child'});
 const before=Object.fromEntries(readdirSync(path).map(name=>[name,readFileSync(join(path,name),'utf8')]));
 f.deps.preflightPeer=async()=>assert.fail('old preflight');f.deps.selectPeer=async()=>assert.fail('old Jev');f.deps.plan=async()=>assert.fail('old planner');
 const replay=await f.run(input);assert.equal(replay.result.agentId,'old-child');assert.equal(replay.phases.length,5);
 assert.deepEqual(Object.fromEntries(readdirSync(path).map(name=>[name,readFileSync(join(path,name),'utf8')])),before);assert.equal(f.effects.length,0);
});
