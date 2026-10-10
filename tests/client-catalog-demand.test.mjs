import test from 'node:test';
import assert from 'node:assert/strict';
import { act, deferredRpc, loadHooks, renderHook } from './helpers/client-hooks-harness.mjs';

// Oracle strings deliberately do not import implementation key helpers.
const scope = 'codex|peer', feature = 'codex|peer|model,with-comma|mode-1';
const scopes = [{ family: 'codex', role: 'peer' }];
const result = label => ({ schemaVersion: 1, models: [{ id: label, label }], modes: [],
  features: [{ id: label, label, type: 'boolean' }], error: null });
const activation = operationId => ({ operationId, kind: 'activate', outcome: 'succeeded' });
async function setup(t, strict = false, initial = {}) {
  const mod = await loadHooks(t), rpc = deferredRpc();
  const hook = ({ home = '/a', operation, scopes: demandedScopes = scopes, features = [feature] }) => {
    const target = { hostId: 'host-1', daemonHome: home };
    const cache = mod.useCatalogCache(target, mod.targetKey(target), operation, rpc.rpc);
    mod.useCatalogDemand(cache, demandedScopes, features);
    return cache;
  };
  return { ...await renderHook(t, hook, initial, strict), rpc };
}
const callsFor = (rpc, home) => rpc.calls.filter(call => call.input.cwd === home);
async function settle(calls, label) { await act(async () => { for (const call of calls) call.resolve(result(label)); }); }

test('role-scoped demand dedupes, filters unset families/null picks and preserves comma-bearing models', async t => {
  const { state, rpc, update } = await setup(t, false, {
    scopes: [...scopes, ...scopes, { family: '', role: 'peer' }], features: [feature, feature, null],
  });
  assert.equal(rpc.calls.length, 2);
  const featureCall = rpc.calls.find(call => call.input.model);
  assert.equal(featureCall.input.model, 'model,with-comma');
  assert.equal(featureCall.input.modeId, 'mode-1');
  assert.equal(featureCall.input.role, 'peer');
  await settle(rpc.calls, 'initial');
  assert.equal(state.current.catalogs[scope].models[0].id, 'initial');
  assert.equal(state.current.featureSets[feature].defs[0].id, 'initial');
  const revision = state.current.catalogRevision;
  await update({ features: [feature], scopes: [...scopes] });
  assert.equal(rpc.calls.length, 2, 'fresh arrays/target objects reuse the cache');
  assert.equal(state.current.catalogRevision, revision);
  await update({ features: [feature], scopes: [{ family: 'codex', role: 'lead' }, ...scopes] });
  assert.equal(rpc.calls.length, 3, 'another role has an independent cache entry');
  assert.equal(rpc.calls[2].input.role, 'lead');
  await settle([rpc.calls[2]], 'lead-only');
  assert.equal(state.current.catalogs['codex|lead'].models[0].id, 'lead-only');
  assert.equal(state.current.catalogs[scope].models[0].id, 'initial');
});
test('StrictMode cache invalidation/replay lands only the live demand results', async t => {
  const { state, rpc } = await setup(t, true);
  assert.equal(rpc.calls.length, 4);
  await settle(rpc.calls.slice(0, 2), 'abandoned');
  assert.deepEqual(state.current.catalogs, {});
  assert.deepEqual(state.current.featureSets, {});
  await settle(rpc.calls.slice(2), 'live');
  assert.equal(state.current.catalogs[scope].models[0].id, 'live');
  assert.equal(state.current.featureSets[feature].defs[0].id, 'live');
  assert.equal(state.current.catalogLoadingFor, null);
  assert.equal(state.current.featuresLoadingFor, null);
});
test('automatic reads and manual retry cannot write across A→B→A or clear a newer loading indicator', async t => {
  const { state, rpc, update } = await setup(t);
  await settle(rpc.calls, 'a');
  let staleCatalog, staleFeature;
  act(() => {
    staleCatalog = state.current.retryCatalog('codex', 'peer');
    staleFeature = state.current.retryFeatureSet(feature);
  });
  const stale = rpc.calls.slice(2);
  await update({ home: '/b' });
  const b = callsFor(rpc, '/b');
  assert.equal(b.length, 2);
  await act(async () => { stale[0].reject(new Error('old retry failed')); stale[1].resolve(result('wrong-target')); await Promise.all([staleCatalog, staleFeature]); });
  assert.deepEqual(state.current.catalogs, {});
  assert.deepEqual(state.current.featureSets, {});
  assert.equal(state.current.catalogLoadingFor, scope);
  assert.equal(state.current.featuresLoadingFor, feature);
  await update({ home: '/a' });
  const live = rpc.calls.slice(-2);
  await settle(b, 'wrong-b');
  assert.deepEqual(state.current.featureSets, {});
  await settle(live, 'new-a');
  assert.equal(state.current.featureSets[feature].defs[0].id, 'new-a');
  assert.equal(state.current.catalogs[scope].models[0].id, 'new-a');
});
test('successful activation invalidates both maps and revision; an operation identity invalidates once', async t => {
  const { state, rpc, update } = await setup(t);
  await settle(rpc.calls, 'initial');
  const revision = state.current.catalogRevision;
  let retry;
  act(() => { retry = state.current.retryFeatureSet(feature); });
  const oldRetry = rpc.calls.at(-1);
  await update({ operation: activation('activate-1') });
  assert.equal(state.current.catalogRevision, revision + 1);
  assert.deepEqual(state.current.catalogs, {});
  assert.deepEqual(state.current.featureSets, {});
  const newDemand = rpc.calls.slice(-2);
  await act(async () => { oldRetry.resolve(result('pre-activation')); await retry; });
  assert.deepEqual(state.current.featureSets, {});
  await settle(newDemand, 'activated');
  const count = rpc.calls.length;
  await update({ operation: activation('activate-1') });
  assert.equal(rpc.calls.length, count);
  assert.equal(state.current.catalogRevision, revision + 1);
  await update({ operation: { ...activation('failed-activation'), outcome: 'failed' } });
  assert.equal(state.current.catalogRevision, revision + 1, 'failed activation keeps catalogs');
  await update({ operation: { ...activation('activate-2'), outcome: 'no-op' } });
  assert.equal(state.current.catalogRevision, revision + 2, 'no-op activation also refreshes');
  await settle(rpc.calls.slice(-2), 'no-op');
});
test('persistent feature failure retries once, exposes raw-JSON fallback error, and manual retry recovers', async t => {
  const { state, rpc } = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const catalog = rpc.calls.find(call => !call.input.model), features = rpc.calls.find(call => call.input.model);
  await act(async () => { catalog.reject(new Error('catalog transport')); features.reject(new Error('transient feature transport')); });
  assert.equal(state.current.catalogs[scope].error, 'Catalog query failed');
  assert.equal(rpc.calls.length, 2);
  await act(async () => t.mock.timers.tick(1500));
  assert.equal(rpc.calls.length, 3, 'one bounded automatic retry');
  await act(async () => rpc.calls[2].reject(new Error('persistent feature transport')));
  assert.deepEqual(state.current.featureSets[feature], { defs: [], error: 'persistent feature transport' });
  assert.equal(state.current.featuresLoadingFor, null);
  let featureRetry, catalogRetry;
  act(() => { featureRetry = state.current.retryFeatureSet(feature); catalogRetry = state.current.retryCatalog('codex', 'peer'); });
  assert.equal(state.current.featureSets[feature].error, 'persistent feature transport', 'pending retry keeps fallback error');
  await act(async () => { rpc.calls[3].resolve(result('recovered')); rpc.calls[4].resolve(result('recovered')); await Promise.all([featureRetry, catalogRetry]); });
  assert.equal(state.current.featureSets[feature].error, null);
  assert.equal(state.current.catalogs[scope].error, null);
});
test('switching targets during feature backoff prevents an obsolete retry from being issued', async t => {
  const { rpc, update } = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => rpc.calls.find(call => call.input.model).reject(new Error('transient')));
  await update({ home: '/b' });
  await act(async () => t.mock.timers.tick(1500));
  assert.equal(callsFor(rpc, '/a').length, 2, 'backoff does not retry obsolete target');
  await settle(callsFor(rpc, '/b'), 'b');
});
test('a newer manual retry owns a cache key and older responses cannot overwrite it', async t => {
  const { state, rpc } = await setup(t);
  const initial = [...rpc.calls];
  let retry;
  act(() => { retry = state.current.retryFeatureSet(feature); });
  await act(async () => { rpc.calls[2].resolve(result('newer')); await retry; });
  await settle(initial, 'older');
  assert.equal(state.current.featureSets[feature].defs[0].id, 'newer');
  assert.equal(state.current.featuresLoadingFor, null);
});
test('an errored empty observation does not satisfy the next demand pass; a usable errored one does', async t => {
  const { state, rpc, update } = await setup(t);
  const catalog = rpc.calls.find(call => !call.input.model);
  const features = rpc.calls.find(call => call.input.model);
  await act(async () => { catalog.reject(new Error('cold-alias outage')); features.resolve(result('f0')); });
  assert.equal(state.current.catalogs[scope].error, 'Catalog query failed');
  const before = rpc.calls.length;
  await update({ features: [feature, 'codex|peer|model-b|mode-2'] });
  assert.equal(rpc.calls.length, before + 2, 'new demand re-measures the errored scope plus the new feature key');
  const refetch = rpc.calls.filter(call => !call.input.model).at(-1);
  await settle([refetch, rpc.calls.at(-1)], 'recovered');
  assert.equal(state.current.catalogs[scope].models[0].id, 'recovered');
  assert.equal(state.current.catalogs[scope].error, null);
  const settled = rpc.calls.length;
  await update({ features: ['codex|peer|model-c|mode-3'] });
  assert.equal(rpc.calls.length, settled + 1, 'recovered scope stays satisfied — only the new feature key fetches');
  await settle([rpc.calls.at(-1)], 'c');
  await update({ scopes: [...scopes, { family: 'codex', role: 'lead' }], features: [feature] });
  const leadCall = rpc.calls.at(-1);
  await act(async () => leadCall.resolve({ ...result('lead-m'), error: 'provider refresh failed: warm-up' }));
  const pinned = rpc.calls.length;
  await update({ features: ['codex|peer|model-d|mode-4'] });
  assert.equal(rpc.calls.slice(pinned).filter(call => !call.input.model).length, 0,
    'a usable errored catalog stays satisfied — measured errors are re-read, not re-fetched per demand');
});
