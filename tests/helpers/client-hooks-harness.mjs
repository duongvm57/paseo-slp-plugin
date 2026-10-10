import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React, { StrictMode } from 'react';
import TestRenderer from 'react-test-renderer';

export const { act } = TestRenderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(join(root, 'package.json'));
export async function loadHooks(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-client-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outfile = join(dir, 'hooks.mjs');
  await build({
    entryPoints: [join(root, 'tests/helpers/client-hooks-entry.mts')],
    outfile, bundle: true, format: 'esm', platform: 'node',
    alias: {
      'react-native': join(root, 'tests/helpers/rn-stub.mjs'),
      '@getpaseo/plugin/client/react-native': join(root, 'tests/helpers/client-clipboard-stub.mjs'),
      '@getpaseo/plugin/client': join(root, 'tests/helpers/paseo-client-stub.mjs'),
    },
    plugins: [{ name: 'one-react', setup(builder) {
      builder.onResolve({ filter: /^react(?:\/|$)/ }, args => ({ path: require.resolve(args.path), external: true }));
    } }],
  });
  const mod = await import(pathToFileURL(outfile).href);
  mod.paseoState.current = { agents: { list: async () => ({ entries: [] }) } };
  return mod;
}
export function deferredRpc() {
  const calls = [];
  const rpc = input => new Promise((resolve, reject) => { calls.push({ input, resolve, reject }); });
  return { calls, rpc };
}
export async function renderHook(t, hook, props, strict = false) {
  const state = {};
  function Harness(props) { state.current = hook(props); return null; }
  const element = props => strict
    ? React.createElement(StrictMode, null, React.createElement(Harness, props))
    : React.createElement(Harness, props);
  let renderer;
  await act(async () => { renderer = TestRenderer.create(element(props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return { state, update: async props => { await act(async () => renderer.update(element(props))); } };
}
