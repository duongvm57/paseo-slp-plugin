// Behavioral harness for useSupervisionCard — the real hook is esbuild-
// bundled against the RN/Paseo boundary stubs (tests/helpers/*-stub.mjs) and
// rendered through react-test-renderer, so mount/re-render/effect/cleanup
// semantics — including StrictMode replay — are React's own, not simulated.
// The callsite mirrors plugin/client/ManagerSurface.tsx:193-219 and :345-352:
// a fresh `target` object literal every render, `keyRef` updated in a
// `[key]`-deps effect, `isCurrentKey` reading the ref.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React, { StrictMode, useEffect, useRef } from 'react';
import TestRenderer from 'react-test-renderer';

const { create, act } = TestRenderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const root = fileURLToPath(new URL('..', import.meta.url));

// The real hook reaches react-native and @getpaseo/plugin/client — replace
// those boundaries with stubs; react itself stays the installed 19.x.
// The bundle is emitted under the repo (gitignored .local-checks/) so its
// `react` import resolves to the same node_modules copy the test's
// react-test-renderer drives — one React instance, one hooks dispatcher.
const bundleEntry = async () => {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/slp-supervision-card-'));
  const outfile = join(dir, 'supervision-card.mjs');
  await build({
    entryPoints: [join(root, 'tests/helpers/supervision-card-entry.mts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['react', 'react-test-renderer'],
    alias: {
      'react-native': join(root, 'tests/helpers/rn-stub.mjs'),
      '@getpaseo/plugin/client': join(root, 'tests/helpers/paseo-client-stub.mjs'),
    },
  });
  return { dir, outfile };
};

let bundlePromise;
const loadBundle = () => {
  bundlePromise ??= (async () => {
    const { dir, outfile } = await bundleEntry();
    const mod = await import(pathToFileURL(outfile).href);
    return { ...mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  })();
  return bundlePromise;
};

const LEAD_ENTRY = {
  agent: {
    id: 'lead-1111-aaaa', provider: 'slp-codex-lead', status: 'idle',
    title: 'Lead One', workspaceId: 'ws-lead-1', archivedAt: null,
  },
  project: { projectName: 'paseo-slp', workspaceName: 'main' },
};

const resultFor = (home) => ({
  schemaVersion: 2,
  config: null,
  sha256: Buffer.from(home).toString('hex').padEnd(64, '0').slice(0, 64),
  migration: null,
  observations: [],
  gates: {},
  diagnostics: { droppedEvents: 0, reasons: [] },
  unverified: [],
  error: null,
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// Mirrors ManagerSurface: fresh `target` literal every render (line 193),
// keyRef maintained by a `[key]`-deps effect (lines 216-219), isCurrentKey
// reading the ref (line 275), hook call with the same wiring (345-352).
const makeHarness = (mod, capture, rpc) => {
  function Harness({ home }) {
    const target = { hostId: 'host-1', daemonHome: home };
    const key = mod.targetKey(target);
    const keyRef = useRef(key);
    useEffect(() => { keyRef.current = key; }, [key]);
    const isCurrentKey = (issueKey) => keyRef.current === issueKey;
    capture.card = mod.useSupervisionCard({
      target,
      targetKey: key,
      isCurrentKey,
      callGetSupervision: rpc.getSupervision,
      callSetSupervision: rpc.setSupervision,
      update: () => {},
    });
    return null;
  }
  return Harness;
};

const setup = async (t, { strict = false, home = '/home/a' } = {}) => {
  const mod = await loadBundle();
  t.after(() => mod.cleanup());
  const capture = {};
  const rpc = {
    getCalls: [],
    getDeferreds: [],
    setCalls: [],
    getSupervision(input) {
      rpc.getCalls.push(input);
      const d = deferred();
      rpc.getDeferreds.push(d);
      return d.promise;
    },
    setSupervision(input) {
      rpc.setCalls.push(input);
      return Promise.reject(new Error('test: set-supervision not exercised'));
    },
  };
  mod.paseoState.current = {
    agents: { list: async () => ({ entries: [LEAD_ENTRY] }) },
  };
  t.after(() => { mod.paseoState.current = null; });
  const Harness = makeHarness(mod, capture, rpc);
  const element = strict
    ? React.createElement(StrictMode, null, React.createElement(Harness, { home }))
    : React.createElement(Harness, { home });
  let renderer;
  await act(async () => { renderer = create(element); });
  t.after(() => { act(() => renderer.unmount()); });
  return { mod, capture, rpc, renderer, Harness };
};

// The card's own gate (supervision.tsx:362): `disabled = !target || busy ||
// data === null` — with a live target and no op in flight it reduces to the
// data check, which is what the screenshot shows stuck.
const controlsEnabled = (capture) => capture.card.data !== null && !capture.card.busy;

test('fresh-target re-render during a pending get-supervision still lands the snapshot', async (t) => {
  const { mod, capture, rpc } = await setup(t);
  assert.equal(rpc.getCalls.length, 1, 'one get-supervision issued at mount');
  assert.equal(capture.card.agents?.length, 1, 'agent directory populated (matches screenshot)');
  assert.equal(capture.card.data, null, 'data pending while the RPC is in flight');

  // Settle the in-flight read after re-renders already happened (agents
  // list resolved, reset-effect state writes — each a fresh-target render).
  await act(async () => { rpc.getDeferreds[0].resolve(resultFor('/home/a')); });

  assert.notEqual(capture.card.data, null, 'settings snapshot must land once the pending RPC resolves');
  assert.equal(capture.card.data.sha256, resultFor('/home/a').sha256);
  assert.equal(controlsEnabled(capture), true, 'controls enabled once the CAS snapshot exists');

  // Checkbox toggle through the same path CheckRow drives (supervision.tsx:482).
  const [row] = mod.leadRows(capture.card.agents ?? [], capture.card.form);
  assert.ok(row, 'a Lead row exists');
  assert.equal(mod.leadChecked(capture.card.form, row.agentId), false);
  act(() => {
    capture.card.edit(current => mod.toggleLead(current, { agentId: row.agentId, workspaceId: row.workspaceId }, true));
  });
  assert.equal(mod.leadChecked(capture.card.form, row.agentId), true, 'Lead checkbox toggles on');
  assert.equal(capture.card.dirty, true);
});

test('StrictMode mount replay still lands the snapshot', async (t) => {
  const { capture, rpc } = await setup(t, { strict: true });
  assert.ok(rpc.getCalls.length >= 1, 'get-supervision issued');
  for (const d of rpc.getDeferreds) {
    await act(async () => { d.resolve(resultFor('/home/a')); });
  }
  assert.notEqual(capture.card.data, null, 'settings snapshot must land under StrictMode replay');
  assert.equal(controlsEnabled(capture), true);
});

test('target A→B→A reloads each home and a stale resolution cannot paint', async (t) => {
  const { mod, capture, rpc, renderer, Harness } = await setup(t);
  // A's read pending; switch to B — A's late resolution must be dropped.
  await act(async () => { renderer.update(React.createElement(Harness, { home: '/home/b' })); });
  assert.equal(capture.card.data, null, 'B snapshot pending');
  const aCall = rpc.getCalls.findIndex(c => c.target.daemonHome === '/home/a');
  const bCall = rpc.getCalls.findIndex(c => c.target.daemonHome === '/home/b');
  assert.ok(bCall > aCall, 'get-supervision re-issued for B');
  await act(async () => { rpc.getDeferreds[aCall].resolve(resultFor('/home/a')); });
  assert.equal(capture.card.data, null, 'late A resolution must not paint over B');
  await act(async () => { rpc.getDeferreds[bCall].resolve(resultFor('/home/b')); });
  assert.equal(capture.card.data?.sha256, resultFor('/home/b').sha256, 'B snapshot lands');
  // Back to A: a fresh read must be issued (the draft/snapshot were reset).
  await act(async () => { renderer.update(React.createElement(Harness, { home: '/home/a' })); });
  const aCalls = rpc.getCalls.filter(c => c.target.daemonHome === '/home/a');
  assert.equal(aCalls.length, 2, 'returning to A issues a fresh get-supervision');
  assert.equal(capture.card.data, null);
  await act(async () => { rpc.getDeferreds[rpc.getCalls.indexOf(aCalls[1])].resolve(resultFor('/home/a')); });
  assert.equal(capture.card.data?.sha256, resultFor('/home/a').sha256, 'A snapshot lands again');
  assert.equal(controlsEnabled(capture), true);
});

test('a rejected read surfaces readError instead of an endless loading state', async (t) => {
  const { capture, rpc } = await setup(t);
  await act(async () => { rpc.getDeferreds[0].reject(new Error('get-supervision exploded')); });
  assert.notEqual(capture.card.readError, null, 'readError set on failure');
  assert.equal(capture.card.data, null);
});
