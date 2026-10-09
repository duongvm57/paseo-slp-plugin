// Behavioral coverage for plugin/server/provider-catalog.ts — the snapshot
// path, the probe-and-latch downgrade, and the verbatim legacy fallback.
// snapshotUnsupported is module-global on purpose (process-lifetime latch),
// so every scenario imports a FRESH module via a cache-busting query.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { CatalogFeature, CatalogInput, CatalogOutput } from '../plugin/shared/contracts.ts';
import * as hostDescriptors from './helpers/provider-descriptors.mts';

const root = fileURLToPath(new URL('..', import.meta.url));
const MODULE = join(root, 'plugin/server/provider-catalog.ts');
let scenario = 0;
const freshCatalog = async () => (await import(`${MODULE}?case=${++scenario}`)).loadCatalog;

// Silence the latch warning but keep it observable.
const warnings = [];
const realWarn = console.warn;
console.warn = message => warnings.push(String(message));
after(() => { console.warn = realWarn; });

const baseInput = { schemaVersion: 1, family: 'devin', role: 'peer' };

const fakePaseo = (over = {}) => {
  const calls = { snapshot: 0, listModels: 0, listModes: 0, listFeatures: [] };
  const paseo = {
    providers: {
      listModels: async provider => { calls.listModels++; return { models: [{ id: `${provider}-m1` }], error: null }; },
      listModes: async provider => { calls.listModes++; return { modes: [{ id: `${provider}-mode` }], error: null }; },
      listFeatures: async draft => { calls.listFeatures.push(draft); return { features: [], error: null }; },
      ...over,
    },
  };
  return { paseo, calls };
};

const snapshotEntries = entries => async () => { return { entries, error: null }; };

test('snapshot path: managed-id entry wins, resolvedProvider recorded, models filtered', async () => {
  const loadCatalog = await freshCatalog();
  const { paseo, calls } = fakePaseo({
    snapshot: async options => {
      assert.deepEqual(options, { cwd: '/daemon' });
      return {
        entries: [
          { provider: 'devin', status: 'ready', models: [{ id: 'base-model' }], modes: [{ id: 'base-mode' }] },
          {
            provider: 'slp-devin-peer', status: 'ready',
            models: [{ id: 'swe-2-max' }, { id: 'hidden', isSelectable: false }],
            modes: [{ id: 'bypass' }],
          },
        ],
        error: null,
      };
    },
  });
  const out = await loadCatalog({ ...baseInput, cwd: '/daemon' }, paseo);
  assert.equal(out.resolvedProvider, 'slp-devin-peer');
  assert.deepEqual(out.models.map(m => m.id), ['swe-2-max']);
  assert.deepEqual(out.modes.map(m => m.id), ['bypass']);
  assert.equal(out.error, null);
  // Snapshot path makes no legacy list calls.
  assert.equal(calls.listModels, 0);
  assert.equal(calls.listModes, 0);
});

test('picker catalog refreshes each managed provider before reading models after a CLI update', async () => {
  for (const family of ['codex', 'pi', 'devin', 'claude']) {
    const loadCatalog = await freshCatalog();
    let model = 'old-model';
    const calls = [];
    const { paseo } = fakePaseo({
      refresh: async options => {
        calls.push(['refresh', options]);
        model = 'new-model';
      },
      snapshot: async () => {
        calls.push(['snapshot']);
        return {
          entries: [{ provider: `slp-${family}-peer`, status: 'ready', models: [{ id: model }], modes: [] }],
          error: null,
        };
      },
    });
    const out = await loadCatalog({ schemaVersion: 1, family, role: 'peer' }, paseo);
    assert.deepEqual(out.models.map(entry => entry.id), ['new-model'], family);
    assert.deepEqual(calls[0], ['refresh', { providers: [`slp-${family}-peer`] }], family);
    assert.deepEqual(calls[1], ['snapshot'], family);

    calls.length = 0;
    await loadCatalog({ schemaVersion: 1, family, role: 'peer', model: 'new-model' }, paseo);
    assert.deepEqual(calls, [['snapshot']], 'feature lookup reuses refreshed catalog');
  }
});

test('a failed host refresh still returns the snapshot with an actionable error', async () => {
  const loadCatalog = await freshCatalog();
  const { paseo } = fakePaseo({
    refresh: async () => { throw new Error('refresh timed out'); },
    snapshot: snapshotEntries([
      { provider: 'slp-codex-peer', status: 'ready', models: [{ id: 'gpt-6-luna' }], modes: [] },
    ]),
  });
  const result = await loadCatalog({ schemaVersion: 1, family: 'codex', role: 'peer' }, paseo);
  assert.deepEqual(result.models.map(model => model.id), ['gpt-6-luna']);
  assert.match(result.error, /provider refresh failed: refresh timed out/);
});

test('snapshot path: base family entry is the fallback when the managed id is absent', async () => {
  const loadCatalog = await freshCatalog();
  const { paseo } = fakePaseo({
    snapshot: snapshotEntries([
      { provider: 'devin', status: 'ready', models: [{ id: 'base-model' }], modes: [{ id: 'm' }] },
    ]),
  });
  const out = await loadCatalog(baseInput, paseo);
  assert.equal(out.resolvedProvider, 'devin');
  assert.deepEqual(out.models.map(m => m.id), ['base-model']);
});

test('snapshot path: no matching entry reports an error and never falls to legacy', async () => {
  const loadCatalog = await freshCatalog();
  const { paseo, calls } = fakePaseo({
    snapshot: snapshotEntries([{ provider: 'codex', status: 'ready' }]),
  });
  const out = await loadCatalog(baseInput, paseo);
  assert.match(out.error, /slp-devin-peer not found in providers\.snapshot/);
  assert.deepEqual(out.models, []);
  assert.equal(calls.listModels, 0);
  assert.equal(calls.listModes, 0);
});

test('snapshot path: features resolve on the resolved provider id only when a model is given', async () => {
  const loadCatalog = await freshCatalog();
  const { paseo, calls } = fakePaseo({
    snapshot: snapshotEntries([
      { provider: 'slp-devin-peer', status: 'ready', models: [{ id: 'swe-2-max' }], modes: [] },
    ]),
  });
  const out = await loadCatalog({ ...baseInput, model: 'swe-2-max', modeId: 'bypass' }, paseo);
  assert.deepEqual(calls.listFeatures, [
    { provider: 'slp-devin-peer/swe-2-max', cwd: '/', modeId: 'bypass' },
  ]);
  assert.equal(out.error, null);
  const outNoModel = await loadCatalog(baseInput, paseo);
  assert.equal(calls.listFeatures.length, 1, 'no model → no feature call');
  assert.equal(outNoModel.features.length, 0);
});

test('capability latch: unknown_schema latches and later calls go straight to legacy', async () => {
  const loadCatalog = await freshCatalog();
  const marker = Object.assign(new Error('Unknown request, try upgrading the daemon'), { code: 'unknown_schema' });
  const { paseo, calls } = fakePaseo({ snapshot: async () => { calls.snapshot++; throw marker; } });
  const first = await loadCatalog(baseInput, paseo);
  assert.deepEqual(first.models.map(m => m.id), ['devin-m1']);
  assert.equal(first.resolvedProvider, undefined, 'legacy path emits no resolvedProvider');
  const second = await loadCatalog(baseInput, paseo);
  assert.equal(calls.snapshot, 1, 'latched: no second snapshot attempt');
  assert.equal(calls.listModels, 2);
  assert.deepEqual(second.models.map(m => m.id), ['devin-m1']);
  assert.equal(warnings.length >= 1, true, 'latch must not be silent');
});

test('capability latch: a missing snapshot method latches the same way', async () => {
  const loadCatalog = await freshCatalog();
  const { paseo, calls } = fakePaseo(); // no snapshot method at all
  await loadCatalog(baseInput, paseo);
  await loadCatalog(baseInput, paseo);
  assert.equal(calls.listModels, 2);
  assert.equal(calls.listModes, 2);
});

test('transient snapshot failures do not latch — the next call retries', async () => {
  const loadCatalog = await freshCatalog();
  let attempts = 0;
  const { paseo, calls } = fakePaseo({
    snapshot: async () => {
      attempts++;
      if (attempts === 1) throw new Error('socket hangup');
      return { entries: [{ provider: 'slp-devin-peer', status: 'ready', models: [{ id: 'swe-2-max' }], modes: [] }], error: null };
    },
  });
  const first = await loadCatalog(baseInput, paseo);
  assert.equal(calls.listModels, 1, 'transient throw degrades this call to legacy');
  assert.equal(first.resolvedProvider, undefined);
  const second = await loadCatalog(baseInput, paseo);
  assert.equal(attempts, 2, 'no latch — snapshot retried');
  assert.equal(second.resolvedProvider, 'slp-devin-peer');
  assert.equal(calls.listModels, 1, 'second call stayed on the snapshot path');
});

test('snapshot path: a loading entry resolves through the per-provider listings', async () => {
  const loadCatalog = await freshCatalog();
  const listed = { models: [], modes: [] };
  const { paseo, calls } = fakePaseo({
    snapshot: snapshotEntries([
      { provider: 'devin', status: 'ready', models: [{ id: 'base-model' }], modes: [{ id: 'm' }] },
      { provider: 'slp-devin-peer', status: 'loading' },
    ]),
    listModels: async (provider, options) => {
      calls.listModels++;
      listed.models.push([provider, options]);
      return {
        models: [{
          id: 'swe-2-high',
          thinkingOptions: [{ id: 'medium' }, { id: 'high' }, { id: 'max' }],
          defaultThinkingOptionId: 'max',
        }],
        error: null,
      };
    },
    listModes: async (provider, options) => {
      calls.listModes++;
      listed.modes.push([provider, options]);
      return { modes: [{ id: 'bypass' }], error: null };
    },
  });
  const out = await loadCatalog({ ...baseInput, cwd: '/daemon' }, paseo);
  // The picked provider id — not the family — is queried, in scope.
  assert.deepEqual(listed.models, [['slp-devin-peer', { cwd: '/daemon' }]]);
  assert.deepEqual(listed.modes, [['slp-devin-peer', { cwd: '/daemon' }]]);
  assert.equal(out.resolvedProvider, 'slp-devin-peer');
  // The resolved answer carries models/modes — no "is loading" error the
  // client would cache as terminal.
  assert.equal(out.error, null);
  assert.deepEqual(out.models.map(m => m.id), ['swe-2-high']);
  assert.deepEqual(out.models[0].thinkingOptions.map(o => o.id), ['medium', 'high', 'max']);
  assert.equal(out.models[0].defaultThinkingOptionId, 'max');
  assert.deepEqual(out.modes.map(m => m.id), ['bypass']);
});

test('snapshot path: a loading entry that resolves unavailable reports the listing error', async () => {
  const loadCatalog = await freshCatalog();
  const { paseo } = fakePaseo({
    snapshot: snapshotEntries([{ provider: 'pi', status: 'loading' }]),
    listModels: async () => ({ models: [], error: 'Provider pi is not available' }),
    listModes: async () => ({ modes: [], error: 'Provider pi is not available' }),
  });
  const out = await loadCatalog({ schemaVersion: 1, family: 'pi', role: 'peer' }, paseo);
  assert.equal(out.resolvedProvider, 'pi');
  assert.match(out.error, /not available/);
  assert.deepEqual(out.models, []);
});

test('snapshot path: terminal statuses do not fall back to listings', async () => {
  const loadCatalog = await freshCatalog();
  const { paseo, calls } = fakePaseo({
    snapshot: snapshotEntries([
      { provider: 'slp-devin-peer', status: 'unavailable' },
    ]),
  });
  const out = await loadCatalog(baseInput, paseo);
  assert.match(out.error, /slp-devin-peer is unavailable/);
  assert.equal(calls.listModels, 0, 'terminal status must not re-ask listings');
  assert.equal(calls.listModes, 0);
});

test('role-less input resolves the base family entry directly', async () => {
  const loadCatalog = await freshCatalog();
  const { paseo } = fakePaseo({
    snapshot: snapshotEntries([{ provider: 'devin', status: 'ready', models: [{ id: 'm' }], modes: [] }]),
  });
  const out = await loadCatalog({ schemaVersion: 1, family: 'devin' }, paseo);
  assert.equal(out.resolvedProvider, 'devin');
});

test('preview budget: a cold-alias refresh that outlives the budget still yields the measured snapshot', async () => {
  // Real-elapsed check of the live repro: the no-model picker call hung in
  // providers.refresh until the daemon abandoned the RPC, while the same
  // snapshot answered ready in ~1s. The bound is real seconds — the handler
  // must answer inside it with the measured catalog, no fake clock.
  const loadCatalog = await freshCatalog();
  const { paseo } = fakePaseo({
    refresh: () => new Promise(() => {}),
    snapshot: snapshotEntries([
      { provider: 'slp-pi-supervisor', status: 'ready', models: [{ id: 'openai/gpt-6-luna' }], modes: [] },
    ]),
  });
  const out = await loadCatalog({ schemaVersion: 1, family: 'pi', role: 'supervisor' }, paseo);
  assert.equal(out.resolvedProvider, 'slp-pi-supervisor');
  assert.deepEqual(out.models.map(m => m.id), ['openai/gpt-6-luna']);
  assert.equal(out.error, null);
});

test('preview budget: an exhausted warm-up budget never starts loading-entry listings', async () => {
  // Real-elapsed second bound check: refresh consumes the whole shared
  // deadline, then the still-loading entry must answer with its measured
  // state without starting any advisory listing call — expired budget is a
  // no-start, not a started-then-abandoned call.
  const loadCatalog = await freshCatalog();
  const { paseo, calls } = fakePaseo({
    refresh: () => new Promise(() => {}),
    snapshot: snapshotEntries([
      { provider: 'pi', status: 'ready', models: [{ id: 'base-m' }], modes: [] },
      { provider: 'slp-pi-supervisor', status: 'loading' },
    ]),
  });
  const out = await loadCatalog({ schemaVersion: 1, family: 'pi', role: 'supervisor' }, paseo);
  assert.equal(calls.listModels, 0, 'expired budget must not start listings');
  assert.equal(calls.listModes, 0);
  assert.equal(calls.listFeatures.length, 0);
  assert.equal(out.resolvedProvider, 'slp-pi-supervisor');
  assert.match(out.error, /slp-pi-supervisor is loading/);
  assert.deepEqual(out.models, []);
  assert.deepEqual(out.modes, []);
});

const knownThinking = { id: 'high', label: 'High', description: 'More reasoning',
  isDefault: true, metadata: { tier: 2 } };
const knownToggle = { type: 'toggle', id: 'fast', label: 'Fast', description: 'Faster replies',
  tooltip: 'Host tooltip', icon: 'zap', value: true, desktopTrigger: 'icon' };
const knownSelect = { type: 'select', id: 'thinking', label: 'Thinking', value: null,
  options: [knownThinking], desktopTrigger: 'label' };

test('host descriptor fixture typechecks against the installed protocol', () => {
  const fixture = join(root, 'tests/helpers/provider-descriptors.mts');
  const program = ts.createProgram([fixture], {
    noEmit: true, strict: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ['node'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
});

test('toggle desktop trigger survives while future host feature keys are stripped', () => {
  assert.deepEqual(CatalogFeature.parse(hostDescriptors.toggle), knownToggle);
});

test('select desktop trigger and option metadata survive while future host keys are stripped', () => {
  assert.deepEqual(CatalogFeature.parse(hostDescriptors.select), knownSelect);
});

test('future desktop trigger strings survive catalog parsing without damaging descriptors', () => {
  const parsed = CatalogOutput.parse({ schemaVersion: 1, models: [], modes: [],
    features: hostDescriptors.futureFeatures, error: null });
  assert.deepEqual(parsed.features, [
    { ...knownToggle, desktopTrigger: 'both' },
    { ...knownSelect, desktopTrigger: 'both' },
  ]);
  assert.equal(parsed.error, null);
});

test('model mode and thinking descriptors accept future host keys at the wire boundary', () => {
  const parsed = CatalogOutput.parse({
    schemaVersion: 1, models: [hostDescriptors.model], modes: [hostDescriptors.mode],
    features: [], error: null,
  });
  assert.deepEqual(parsed.models, [{ id: 'host-model', label: 'Host model',
    thinkingOptions: [knownThinking], defaultThinkingOptionId: 'high' }]);
  assert.deepEqual(parsed.modes, [{ id: 'full-access', label: 'Full access' }]);
});

test('legacy feature descriptors still parse without an invented desktop trigger', () => {
  for (const { desktopTrigger, futureHostKey, ...legacy } of hostDescriptors.features) {
    const raw = legacy.type === 'select' ? { ...legacy, options: [knownThinking] } : legacy;
    const parsed = CatalogFeature.parse(raw);
    assert.deepEqual(parsed, raw);
    assert.equal(Object.hasOwn(parsed, 'desktopTrigger'), false);
  }
});

test('host descriptor evolution keeps known fields and plugin envelopes validated', () => {
  for (const raw of [
    { ...hostDescriptors.toggle, desktopTrigger: 1 },
    { ...hostDescriptors.toggle, value: 'true' },
    { ...hostDescriptors.select, desktopTrigger: null },
    { ...hostDescriptors.select, value: {} },
    { ...hostDescriptors.select, options: [{ id: '', label: 'Empty' }] },
  ]) assert.throws(() => CatalogFeature.parse(raw));
  assert.throws(() => CatalogOutput.parse({ schemaVersion: 1, models: [], modes: [],
    features: [], error: null, futurePluginKey: true }));
  assert.throws(() => CatalogInput.parse({ schemaVersion: 1, family: 'codex', futurePluginKey: true }));
});

for (const path of ['snapshot', 'legacy']) {
  test(path + ' host catalog preserves desktop triggers through loader and RPC parser', async () => {
    const loadCatalog = await freshCatalog();
    const overrides = {
      listModels: async () => ({ models: [hostDescriptors.model] }),
      listModes: async () => ({ modes: [hostDescriptors.mode] }),
      listFeatures: async () => ({ features: hostDescriptors.features }),
      ...(path === 'snapshot' ? { snapshot: snapshotEntries([{
        provider: 'slp-codex-peer', status: 'ready',
        models: [hostDescriptors.model], modes: [hostDescriptors.mode],
      }]) } : {}),
    };
    const { paseo } = fakePaseo(overrides);
    const raw = await loadCatalog({ schemaVersion: 1, family: 'codex', role: 'peer',
      model: 'host-model', cwd: '/catalog-workspace' }, paseo);
    assert.equal(raw.features[0].futureHostKey, true,
      'raw host payload reaches the plugin parser; it was not stripped by an older protocol first');
    const parsed = CatalogOutput.parse(raw);
    assert.deepEqual(parsed.features, [knownToggle, knownSelect]);
    assert.equal(parsed.error, null);
    assert.equal(parsed.models[0].defaultThinkingOptionId, 'high');
    assert.deepEqual(parsed.models[0].thinkingOptions, [knownThinking]);
    assert.deepEqual(parsed.modes, [{ id: 'full-access', label: 'Full access' }]);
  });
}
