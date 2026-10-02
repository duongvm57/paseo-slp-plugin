import test from 'node:test';
import assert from 'node:assert/strict';
import { act, deferredRpc, loadHooks, renderHook } from './helpers/client-hooks-harness.mjs';

const homeTarget = home => ({ hostId: 'host-1', daemonHome: home });
const sha = 'a'.repeat(64);
const routingResult = home => ({ routing: { schemaVersion: 1,
  supervisor: { family: 'codex', model: `supervisor-${home}` },
  lead: { family: 'codex', model: `lead-${home}` } } });
const poolResult = home => ({ schemaVersion: 1, sha256: sha, error: null, legacy: null, legacyError: null,
  pool: { version: 1, policy: 'Choose the eligible seat that fits the task.', options: [{ id: 'custom-seat', provider: 'codex', model: home,
    enabled: true, suitableFor: [], avoidFor: [], notes: 'A custom general-purpose test seat.' }], quotaFallback: { enabled: false, optionId: null } } });
const jevResult = home => ({ jev: { configured: true, enabled: true, sha256: sha,
  capabilities: { routing: false, supervision: true },
  provider: { kind: 'openrouter', model: 'typesafe/jev-1.13', baseUrl: 'https://openrouter.ai' }, error: home } });
const trackerResult = home => ({ workTracker: { configured: true, enabled: false, bd: null, error: home } });
const supervisionResult = home => ({ schemaVersion: 2, config: null, sha256: home === '/a' ? sha : Buffer.from(home).toString('hex').padEnd(64, '0').slice(0, 64),
  migration: null, observations: [], gates: {}, diagnostics: { droppedEvents: 0, reasons: [] }, unverified: [], error: null });
const cards = {
  routing: { hook: 'useRoutingCard', get: 'callGetRoleRouting', set: 'callSetRoleRouting', result: routingResult,
    value: card => card.form.supervisor.model, expected: home => `supervisor-${home}`,
    edit: card => card.setField('supervisor', 'model')('draft'), run: card => card.save(), busy: card => card.busy },
  pool: { hook: 'usePeerPoolCard', get: 'callGetPeerPool', set: 'callSetPeerPool', result: poolResult,
    value: card => card.poolData?.pool?.options[0]?.model ?? null, expected: home => home,
    edit: card => card.setSeatField(0, 'model')('draft'), run: card => card.savePeerPool(), busy: card => card.poolSaving },
  jev: { hook: 'useJevCard', get: 'callGetJev', set: 'callSetJev', result: jevResult,
    value: card => card.view?.error ?? null, expected: home => home,
    edit: card => card.setEnabledOn(false), run: card => card.save(), busy: card => card.busy },
  tracker: { hook: 'useWorkTrackerCard', get: 'callGetWorkTracker', set: 'callSetWorkTracker', result: trackerResult,
    value: card => card.view?.error ?? null, expected: home => home,
    edit: () => {}, run: card => card.onToggle(true), busy: card => card.busy },
  supervision: { hook: 'useSupervisionCard', get: 'callGetSupervision', set: 'callSetSupervision', result: supervisionResult,
    value: card => card.data?.sha256 ?? null, expected: home => supervisionResult(home).sha256,
    edit: card => card.edit(current => current), run: card => card.save(), busy: card => card.busy },
};
async function setup(t, spec, strict = false) {
  const mod = await loadHooks(t);
  const read = deferredRpc(), write = deferredRpc();
  const patches = [];
  const hook = ({ home }) => {
    const target = homeTarget(home);
    return mod[spec.hook]({ target, targetKey: mod.targetKey(target),
      isCurrentKey: () => true, sameTarget: () => true, // owner must protect the seam itself
      statusView: null, catalogs: {}, featureSets: {}, featuresLoadingFor: null,
      scrollFocusNode: () => {}, update: (patch, target) => patches.push({ patch, target }),
      [spec.get]: read.rpc, [spec.set]: write.rpc,
      callSetJevKey: write.rpc, callTestJev: write.rpc });
  };
  const rendered = await renderHook(t, hook, { home: '/a' }, strict);
  return { ...rendered, mod, read, write, patches };
}
for (const [name, spec] of Object.entries(cards)) {
  test(`${name}: real StrictMode replay reissues a cancelled read and lands the live snapshot`, async t => {
    const { state, read } = await setup(t, spec, true);
    assert.equal(read.calls.length, 2, 'React replay issues one read per live effect');
    await act(async () => read.calls[0].resolve(spec.result('/obsolete')));
    assert.notEqual(spec.value(state.current), spec.expected('/obsolete'), 'abandoned replay cannot write');
    await act(async () => read.calls[1].resolve(spec.result('/a')));
    assert.equal(spec.value(state.current), spec.expected('/a'));
    if (name === 'pool') assert.equal(state.current.poolLocked, false);
  });
  test(`${name}: fresh objects, target switch and delayed A→B→A resolutions respect session identity`, async t => {
    const { state, read, update } = await setup(t, spec);
    await update({ home: '/a' });
    assert.equal(read.calls.length, 1, 'fresh object does not cancel or refetch');
    await update({ home: '/b' });
    await update({ home: '/a' });
    assert.equal(read.calls.length, 3);
    await act(async () => {
      read.calls[0].resolve(spec.result('/old-a'));
      read.calls[1].resolve(spec.result('/b'));
    });
    assert.notEqual(spec.value(state.current), spec.expected('/old-a'));
    assert.notEqual(spec.value(state.current), spec.expected('/b'));
    await act(async () => read.calls[2].resolve(spec.result('/a')));
    assert.equal(spec.value(state.current), spec.expected('/a'));
  });
  for (const reject of [false, true]) test(`${name}: stale mutation ${reject ? 'error' : 'success'} and finally preserve a newer operation`, async t => {
    const { state, read, write, update } = await setup(t, spec);
    await act(async () => read.calls[0].resolve(spec.result('/a')));
    act(() => spec.edit(state.current));
    if (name === 'pool') assert.equal('error' in state.current.poolBuild, false, 'fixture reaches pool mutation adapter');
    let older;
    act(() => { older = spec.run(state.current); });
    assert.equal(write.calls.length, 1);
    if (['pool', 'jev', 'supervision'].includes(name)) assert.equal(write.calls[0].input.expectedSha256, sha, 'CAS snapshot unchanged');
    await update({ home: '/b' });
    assert.equal(spec.busy(state.current), false, 'target switch releases abandoned busy');
    await act(async () => read.calls[1].resolve(spec.result('/b')));
    act(() => spec.edit(state.current));
    let newer;
    act(() => { newer = spec.run(state.current); });
    assert.equal(write.calls.length, 2);
    await act(async () => {
      if (reject) write.calls[0].reject(new Error('stale mutation failure'));
      else write.calls[0].resolve(spec.result('/stale'));
      await older;
    });
    assert.equal(spec.busy(state.current), true, 'stale finally cannot clear newer busy');
    assert.notEqual(spec.value(state.current), spec.expected('/stale'));
    if (name === 'pool') assert.equal(state.current.poolError, null);
    if (name === 'supervision') assert.equal(state.current.cardError, null);
    await act(async () => { write.calls[1].resolve(spec.result('/b')); await newer; });
    assert.equal(spec.busy(state.current), false);
  });
}
test('routing keeps its dirty draft while pool clears its draft/editor on target switch', async t => {
  const routing = await setup(t, cards.routing);
  await act(async () => routing.read.calls[0].resolve(routingResult('/a')));
  act(() => cards.routing.edit(routing.state.current));
  await routing.update({ home: '/b' });
  await act(async () => routing.read.calls[1].resolve(routingResult('/b')));
  assert.equal(routing.state.current.form.supervisor.model, 'draft');
  const pool = await setup(t, cards.pool);
  await act(async () => pool.read.calls[0].resolve(poolResult('/a')));
  act(() => { cards.pool.edit(pool.state.current); pool.state.current.setOpenSeat(0); });
  await pool.update({ home: '/b' });
  assert.equal(pool.state.current.poolForm.seats.length, 0);
  assert.equal(pool.state.current.poolDirty, false);
  assert.equal(pool.state.current.openSeat, null);
  await act(async () => pool.read.calls[1].resolve(poolResult('/b')));
  assert.equal(pool.state.current.poolForm.seats[0].model, '/b');
  assert.equal(pool.state.current.featureKeys[0], 'codex|peer|/b|', 'independent canonical key oracle');
});
test('pool rejected initial read remains locked with a visible read error; reload recovers', async t => {
  const { state, read } = await setup(t, cards.pool);
  await act(async () => read.calls[0].reject(new Error('cannot read pool')));
  assert.equal(state.current.poolReadError, 'cannot read pool');
  assert.equal(state.current.poolLocked, true);
  let reload;
  act(() => { reload = state.current.reloadPeerPool(); });
  await act(async () => { read.calls[1].resolve(poolResult('/a')); await reload; });
  assert.equal(state.current.poolReadError, null);
  assert.equal(state.current.poolLocked, false);
});
test('language stale apply completion preserves dirty draft and newer busy state', async t => {
  const mod = await loadHooks(t), write = deferredRpc();
  const { state, update } = await renderHook(t, ({ home }) => {
    const target = homeTarget(home);
    return mod.useLanguageCard({ target, targetKey: mod.targetKey(target), isCurrentKey: () => true,
      statusView: null, callSetLanguage: write.rpc, refresh: () => {}, update: () => {} });
  }, { home: '/a' });
  act(() => { state.current.onChangeText('first'); state.current.onApply(); });
  await update({ home: '/b' });
  act(() => state.current.onChangeText('second'));
  act(() => state.current.onApply());
  await act(async () => write.calls[0].resolve({}));
  assert.equal(state.current.busy, true);
  assert.equal(state.current.value, 'second');
  await act(async () => write.calls[1].resolve({}));
  assert.equal(state.current.busy, false);
});
for (const name of ['pool', 'jev', 'tracker', 'supervision']) test(`${name}: stale read rejection cannot paint an error; current rejection surfaces`, async t => {
  const { state, read, update } = await setup(t, cards[name]);
  const errorFor = card => name === 'pool' ? card.poolReadError : name === 'supervision' ? card.readError : card.loadError;
  await update({ home: '/b' });
  await act(async () => read.calls[0].reject(new Error('old target read failure')));
  assert.equal(errorFor(state.current), null);
  await act(async () => read.calls[1].reject(new Error('current target read failure')));
  assert.equal(errorFor(state.current), 'current target read failure');
});
for (const name of ['pool', 'supervision']) for (const reject of [false, true]) test(`${name}: stale reload ${reject ? 'error' : 'success'} leaves the new reload and snapshot alone`, async t => {
  const { state, read, update } = await setup(t, cards[name]);
  const reload = card => name === 'pool' ? card.reloadPeerPool() : card.reload();
  const reloading = card => name === 'pool' ? card.poolReloading : card.busy;
  await act(async () => read.calls[0].resolve(cards[name].result('/a')));
  let oldReload;
  act(() => { oldReload = reload(state.current); });
  await update({ home: '/b' });
  await act(async () => read.calls[2].resolve(cards[name].result('/b')));
  let newReload;
  act(() => { newReload = reload(state.current); });
  await act(async () => {
    if (reject) read.calls[1].reject(new Error('stale reload failure'));
    else read.calls[1].resolve(cards[name].result('/stale'));
    await oldReload;
  });
  assert.equal(reloading(state.current), true);
  assert.equal(cards[name].value(state.current), cards[name].expected('/b'));
  assert.equal(name === 'pool' ? state.current.poolError : state.current.cardError, null);
  await act(async () => { read.calls[3].resolve(cards[name].result('/b')); await newReload; });
  assert.equal(reloading(state.current), false);
});
test('Jev key-save refresh cannot clear the new target key input or key busy', async t => {
  const { state, read, write, update } = await setup(t, cards.jev);
  await act(async () => read.calls[0].resolve(jevResult('/a')));
  let older;
  act(() => { older = state.current.saveKey('test-old-key'); });
  await act(async () => write.calls[0].resolve({}));
  assert.equal(read.calls.length, 2, 'successful key save refreshes its own daemon');
  await update({ home: '/b' });
  await act(async () => read.calls[2].resolve(jevResult('/b')));
  act(() => state.current.setKeyInput('test-new-key'));
  let newer;
  act(() => { newer = state.current.saveKey('test-new-key'); });
  await act(async () => { read.calls[1].resolve(jevResult('/stale')); await older; });
  assert.equal(state.current.keyInput, 'test-new-key');
  assert.equal(state.current.keyBusy, true);
  assert.equal(state.current.view.error, '/b');
  await act(async () => write.calls[1].resolve({}));
  await act(async () => { read.calls[3].resolve(jevResult('/b')); await newer; });
  assert.equal(state.current.keyBusy, false);
  assert.equal(state.current.keyInput, '');
});
for (const reject of [false, true]) test(`Jev stale test ${reject ? 'error' : 'success'} cannot replace a newer pending test`, async t => {
  const { state, read, write, update } = await setup(t, cards.jev);
  await act(async () => read.calls[0].resolve(jevResult('/a')));
  let older;
  act(() => { older = state.current.runTest(); });
  await update({ home: '/b' });
  await act(async () => read.calls[1].resolve(jevResult('/b')));
  let newer;
  act(() => { newer = state.current.runTest(); });
  await act(async () => {
    if (reject) write.calls[0].reject(new Error('stale test failed'));
    else write.calls[0].resolve({ ok: true, detail: 'stale result' });
    await older;
  });
  assert.equal(state.current.test, null);
  assert.equal(state.current.testBusy, true);
  await act(async () => { write.calls[1].resolve({ ok: false, detail: 'b result' }); await newer; });
  assert.deepEqual(state.current.test, { ok: false, detail: 'b result' });
  assert.equal(state.current.testBusy, false);
});
test('pool delayed clipboard completion does not flash Copied on another target', async t => {
  const { mod, state, read, update } = await setup(t, cards.pool);
  const clipboard = deferredRpc();
  mod.clipboardState.copy = clipboard.rpc;
  await act(async () => read.calls[0].resolve(poolResult('/a')));
  let copy;
  act(() => { copy = state.current.copyPoolJson(); });
  assert.equal(JSON.parse(clipboard.calls[0].input).options[0].model, '/a');
  await update({ home: '/b' });
  await act(async () => { clipboard.calls[0].resolve(); await copy; });
  assert.equal(state.current.poolCopied, false);
  await act(async () => read.calls[1].resolve(poolResult('/b')));
});
