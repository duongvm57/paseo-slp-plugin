import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTaskRuntimeResolver, observeTaskProviders, PROVIDER_WARMUP } from '../plugin/server/desk-task-runtime.ts';
import { createTaskBoundedHost } from '../plugin/server/desk-task-host.ts';
import { resolveBinding } from '../plugin/server/runtime/cli/launch.ts';
import { readCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { presetChoiceSet } from '../plugin/server/runtime/cli/preset-routing.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'slp-task-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repo');
  const daemonHome = join(root, 'home');
  const runtimePath = join(root, 'candidate');
  mkdirSync(join(repository, '.paseo-slp'), { recursive: true });
  mkdirSync(daemonHome);
  const modulePath = join(runtimePath, 'plugin/server/runtime/cli/launch.ts');
  mkdirSync(join(runtimePath, 'plugin/server/runtime/cli'), { recursive: true });
  writeFileSync(modulePath, 'export {};');
  const receipt = join(runtimePath, 'installed.json');
  writeFileSync(receipt, JSON.stringify({ candidate: { files: [{ path: 'plugin/server/runtime/cli/launch.ts' }] } }));
  const pool = {
    version: 1, policy: 'Fixture pool.', quotaFallback: { enabled: false, optionId: null },
    options: [{
      id: 'test-worker', provider: 'devin', roles: ['peer'], model: 'swe-2-high',
      modeId: 'bypass', thinkingOptionId: 'max', features: { auto_accept: true },
      enabled: true, availability: 'ready', suitableFor: ['coding'], avoidFor: [], notes: 'Fixture runtime.',
    }],
  };
  const poolFile = join(repository, '.paseo-slp/slp-routing.json');
  const savePool = () => writeFileSync(poolFile, JSON.stringify(pool));
  savePool();
  const selection = () => ({ optionId: 'test-worker', catalogSha256: readCatalog(repository, daemonHome).sha256 });
  const calls = [];
  let entries = [{ provider: 'slp-devin-peer', enabled: true, status: 'ready' }];
  const host = { providers: { snapshot: async input => { calls.push(input); return { entries }; } } };
  const imports = [];
  const resolver = createTaskRuntimeResolver({
    runtimePath, daemonHome, host: () => host,
    importModule: async specifier => { imports.push(specifier); return { resolveBinding }; },
  });
  return {
    root, repository, daemonHome, runtimePath, modulePath, receipt, poolFile, pool, savePool,
    selection, host, calls, imports, resolver, setEntries: value => { entries = value; },
  };
}

test('task runtime uses the installed resolver and preserves the complete eligible Peer bundle', async t => {
  const f = fixture(t);
  const resolved = await f.resolver(f.repository, f.selection(), 'Engineer');
  assert.equal(resolved.provider, 'slp-devin-peer');
  assert.equal(resolved.model, 'swe-2-high');
  assert.equal(resolved.modeId, 'bypass');
  assert.equal(resolved.thinkingOptionId, 'max');
  assert.deepEqual(resolved.features, { auto_accept: true });
  assert.equal(resolved.routing.optionId, 'test-worker');
  assert.equal(resolved.routing.catalogSha256, f.selection().catalogSha256);
  assert.deepEqual(f.calls, [{ cwd: f.repository }]);
  assert.deepEqual(f.imports, [pathToFileURL(f.modulePath).href]);
});

test('new Manager dispatch preserves a v1 candidate strict provider ABI when host snapshots expose models',async t=>{
 const f=fixture(t);f.setEntries([{provider:'slp-devin-peer',enabled:true,status:'ready',models:[{id:'swe-2-high',thinkingOptions:[{id:'max'}]}]}]);
 const resolver=createTaskRuntimeResolver({runtimePath:f.runtimePath,daemonHome:f.daemonHome,host:()=>f.host,
  importModule:async()=>({resolveBinding:(role,request,disposition)=>{
   for(const provider of request.providers) if(Object.hasOwn(provider,'models'))throw new Error('Unknown legacy provider field: models');
   return resolveBinding(role,request,disposition);
  }})});
 const resolved=await resolver(f.repository,f.selection());
 assert.equal(resolved.provider,'slp-devin-peer',JSON.stringify(resolved));assert.equal(resolved.thinkingOptionId,'max');
});

test('preset-capable task dispatch retains model metadata and binds the selected supported effort',async t=>{
 const f=fixture(t),model={id:'swe-2-high',thinkingOptions:[{id:'medium'},{id:'max'}]};
 f.pool.version=2;Object.assign(f.pool.options[0],{displayName:'Worker',description:'Bounded repair',runtimeRule:'none',effortPolicy:{kind:'select'}});
 delete f.pool.options[0].thinkingOptionId;f.savePool();
 f.setEntries([{provider:'slp-devin-peer',enabled:true,status:'ready',models:[model]}]);
 const inventory=[{id:'slp-devin-peer',enabled:true,status:'available',models:[model]}];
 const set=presetChoiceSet(readCatalog(f.repository,f.daemonHome),'peer',inventory);
 const selection={...f.selection(),thinkingOptionId:'medium',selectionSha256:set.selectionSha256,routingContext:{}};
 const resolver=createTaskRuntimeResolver({runtimePath:f.runtimePath,daemonHome:f.daemonHome,host:()=>f.host,
  importModule:async()=>({FORMATION_CAPABILITIES:{peerPresets:2},resolveBinding})});
 const resolved=await resolver(f.repository,selection);assert.equal(resolved.provider,'slp-devin-peer',JSON.stringify(resolved));
 assert.equal(resolved.thinkingOptionId,'medium');
});

test('task runtime resolves OpenCode only with live ACP transport and ready SDK evidence',async t=>{
 const f=fixture(t);Object.assign(f.pool.options[0],{provider:'opencode',model:'provider/nested/model',modeId:'build'});f.savePool();
 f.setEntries([{provider:'slp-opencode-peer',enabled:true,status:'ready'}]);
 let reads=0;
 f.host.config={get:async()=>{reads++;return {config:{providers:{'slp-opencode-peer':{extends:'acp'}}}};}};
 const result=await f.resolver(f.repository,f.selection());
 assert.equal(result.provider,'slp-opencode-peer');assert.equal(result.model,'provider/nested/model');assert.equal(reads,2);
 f.host.config.get=async()=>({config:{providers:{'slp-opencode-peer':{extends:'opencode'}}}});
 assert.equal((await f.resolver(f.repository,f.selection())).ok,false);
 f.host.config.get=async()=>assert.fail('disabled SDK observation cannot acquire transport/availability from config');
 f.setEntries([{provider:'slp-opencode-peer',enabled:false,status:'ready'}]);
 assert.equal((await f.resolver(f.repository,f.selection())).ok,false);
});

test('published native OpenCode transport is never overwritten by configured ACP',async t=>{
 const f=fixture(t);Object.assign(f.pool.options[0],{provider:'opencode',model:'provider/model',modeId:'build'});f.savePool();
 f.setEntries([{provider:'slp-opencode-peer',enabled:true,status:'ready',extends:'opencode'}]);
 f.host.config={get:async()=>assert.fail('published conflicting transport must not be repaired')};
 const result=await f.resolver(f.repository,f.selection());
 assert.equal(result.ok,false);assert.match(result.message,/extends.*opencode.*acp/);
});

test('non-OpenCode resolution does not acquire a config-read dependency',async t=>{
 const f=fixture(t);f.host.config={get:async()=>assert.fail('unrelated provider transport read')};
 assert.equal((await f.resolver(f.repository,f.selection())).provider,'slp-devin-peer');
});

test('catalog change is re-read on the next resolution rather than using the earlier bundle', async t => {
  const f = fixture(t), old = f.selection();
  assert.equal((await f.resolver(f.repository, old)).model, 'swe-2-high');
  f.pool.options[0].model = 'swe-2-medium';
  f.savePool();
  const stale = await f.resolver(f.repository, old);
  assert.equal(stale.ok, false);
  assert.match(stale.message, /Routing catalog changed/);
  assert.equal((await f.resolver(f.repository, f.selection())).model, 'swe-2-medium');
  assert.equal(f.calls.length, 3);
});

for (const observation of [
  { enabled: false, status: 'ready' }, { status: 'ready' },
  { enabled: true, status: 'loading' }, { enabled: true, status: 'error' },
  { enabled: true, status: 'unavailable' }, { enabled: true, status: 'future-status' },
  { enabled: true, status: 'ready', error: 'provider unavailable' },
]) {
  test(`dispatch resolution rejects an unverified host observation ${JSON.stringify(observation)}`, async t => {
    const f = fixture(t);
    f.setEntries([{ provider: 'slp-devin-peer', ...observation }]);
    const rejected = await f.resolver(f.repository, f.selection());
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /Unverified provider/);
  });
}

test('connected provider failures have no configured or base-family fallback', async t => {
  const f = fixture(t);
  f.host.providers.snapshot = async () => { throw new Error('offline'); };
  const unavailable = await f.resolver(f.repository, f.selection());
  assert.equal(unavailable.code, 'CAPABILITY_GAP');
  assert.deepEqual(f.imports, []);
  f.host.providers.snapshot = async () => ({ entries: [{ provider: 'devin', enabled: true, status: 'ready' }] });
  const wrongProvider = await f.resolver(f.repository, f.selection());
  assert.equal(wrongProvider.ok, false);
  assert.match(wrongProvider.message, /Unverified provider slp-devin-peer/);
});

test('pool eligibility and daemon-specific Jev requirements survive native task resolution', async t => {
  const f = fixture(t);
  f.pool.options[0].availability = 'paused';
  f.savePool();
  const excluded = await f.resolver(f.repository, f.selection());
  assert.equal(excluded.ok, false);
  assert.match(excluded.message, /excluded for peer/);
  f.pool.options[0].availability = 'ready';
  f.savePool();
  const state = join(f.daemonHome, 'slp-runtime/state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'jev.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, capabilities: { routing: true },
    provider: { kind: 'openrouter', model: 'typesafe/jev-1.13' },
  }));
  const missingDecision = await f.resolver(f.repository, f.selection());
  assert.equal(missingDecision.ok, false);
  assert.match(missingDecision.message, /requires a route.decision receipt/);
});

test('missing, ambiguous and symlink candidate modules never select source fallback', async t => {
  const f = fixture(t);
  for (const paths of [[], ['src/launch.ts', 'plugin/server/runtime/cli/launch.ts']]) {
    writeFileSync(f.receipt, JSON.stringify({ candidate: { files: paths.map(path => ({ path })) } }));
    const rejected = await f.resolver(f.repository, f.selection());
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /exactly one launch module/);
  }
  writeFileSync(f.receipt, JSON.stringify({ candidate: { files: [{ path: 'plugin/server/runtime/cli/launch.ts' }] } }));
  rmSync(f.modulePath);
  symlinkSync(f.poolFile, f.modulePath);
  const linked = await f.resolver(f.repository, f.selection());
  assert.equal(linked.ok, false);
  assert.match(linked.message, /regular file/);
  assert.deepEqual(f.imports, []);
});

// Each read stays under the host's 8 s read bound, yet two of them exceed the
// 10 s warm-up budget. Mocked clocks run the default budget without waiting.
async function observeOnMockedClock(t, host) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const start = Date.now();
  let settled;
  observeTaskProviders(host, '/repo').then(value => { settled = { value, at: Date.now() - start }; },
    error => { settled = { error, at: Date.now() - start }; });
  for (let step = 0; step < 1000 && !settled; step++) {
    t.mock.timers.tick(50);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(settled, 'observation settles');
  return settled;
}

const slowSnapshot = (ms, status) => new Promise(resolve => setTimeout(resolve, ms, { entries: [{ provider: 'slp-devin-peer', enabled: true, status }] }));

test('provider warm-up keeps its budget when each snapshot read is slow', async t => {
  let reads = 0;
  const host = createTaskBoundedHost({ providers: { snapshot: () => slowSnapshot(6000, ++reads === 1 ? 'loading' : 'ready') } });
  const settled = await observeOnMockedClock(t, host);
  assert.ok(settled.at <= PROVIDER_WARMUP.budgetMs, `observation took ${settled.at} ms`);
  assert.equal(reads, 2);
  // The ready read arrived after the deadline, so the loading read stands.
  assert.equal(settled.value.entries[0].status, 'loading');
});

test('provider warm-up refuses a first snapshot read that misses the budget', async t => {
  const settled = await observeOnMockedClock(t, { providers: { snapshot: () => slowSnapshot(12_000, 'ready') } });
  assert.ok(settled.at <= PROVIDER_WARMUP.budgetMs, `observation took ${settled.at} ms`);
  assert.match(settled.error?.message ?? '', /missed the warm-up deadline/);
});
