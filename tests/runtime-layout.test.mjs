import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { candidateModulePath } from '../plugin/server/candidate-module.ts';
import { createRoleInjection } from '../plugin/server/role-injection.ts';
import { captureSeatSnapshot } from '../plugin/server/desk-handback.ts';
import { identity, install, json } from '../plugin/server/runtime/cli/package.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = 'a'.repeat(64);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-ts-layout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const layouts = [
  { name: 'runtime', directory: 'plugin/server/runtime/cli', extension: 'ts' },
  { name: 'legacy TS', directory: 'src', extension: 'ts' },
  { name: 'legacy MJS', directory: 'src', extension: 'mjs' },
];
function candidate(dir, { name, directory, extension }) {
  mkdirSync(join(dir, directory), { recursive: true });
  const files = [`${directory}/package.${extension}`, `${directory}/role-bundle.${extension}`];
  writeFileSync(join(dir, 'installed.json'), json({ candidate: { sha256: sha, files: files.map(path => ({ path })) } }));
  writeFileSync(join(dir, files[0]), `export const snapshot = () => ({ sha256: '${sha}', head: null, incomplete: [] });`);
  writeFileSync(join(dir, files[1]), `export const roleBundle = () => ({ role: 'lead', instructions: '${name} candidate policy' });`);
}
for (const layout of layouts) {
  test(`verified ${layout.name} layout loads its own policy and captures its own snapshot`, async t => {
    const dir = fixture(t);
    candidate(dir, layout);
    const binding = { candidateSha256: sha, payloadSha256: sha, runtimePath: dir, nodePath: process.execPath, daemonHome: dir };
    const calls = [];
    const injection = createRoleInjection({
      readActiveBinding: () => binding,
      verifyCandidate: () => { calls.push('verified'); },
      importModule: spec => { calls.push(spec); return import(spec); },
    });
    const result = await injection.agentCreate({ request: { config: { provider: 'slp-codex-lead', cwd: dir } } });
    assert.match(result.config.systemPrompt, new RegExp(`${layout.name} candidate policy`));
    assert.deepEqual(calls, ['verified', pathToFileURL(join(dir, layout.directory, `role-bundle.${layout.extension}`)).href]);
    const capture = await captureSeatSnapshot({ nodePath: process.execPath, runtimePath: dir, repository: dir, now: () => new Date('2026-01-01T00:00:00Z') });
    assert.equal(capture.status, 'ok');
    assert.equal(capture.snapshotSha256, sha);
  });
}

test('module selection refuses ambiguous, missing and symlink layouts before importing code', t => {
  const dir = fixture(t);
  candidate(dir, layouts[1]);
  const receipt = join(dir, 'installed.json');
  writeFileSync(receipt, json({ candidate: { files: [{ path: 'src/package.ts' }, { path: 'src/package.mjs' }] } }));
  assert.throws(() => candidateModulePath(dir, 'package'), /exactly one/);
  writeFileSync(receipt, json({ candidate: { files: [{ path: 'src/package.ts' }, { path: 'plugin/server/runtime/cli/package.ts' }] } }));
  assert.throws(() => candidateModulePath(dir, 'package'), /exactly one/);
  writeFileSync(receipt, json({ candidate: { files: [] } }));
  assert.throws(() => candidateModulePath(dir, 'package'), /exactly one/);
  writeFileSync(receipt, json({ candidate: { files: [{ path: 'src/package.ts' }] } }));
  rmSync(join(dir, 'src/package.ts'));
  symlinkSync(join(dir, 'src/role-bundle.ts'), join(dir, 'src/package.ts'));
  assert.throws(() => candidateModulePath(dir, 'package'), /regular file/);
});

test('a TS import failure does not select an undeclared retained MJS module', async t => {
  const dir = fixture(t);
  candidate(dir, layouts[1]);
  writeFileSync(join(dir, 'src/role-bundle.mjs'), 'throw new Error("must never load");');
  const specifiers = [];
  const injection = createRoleInjection({
    readActiveBinding: () => ({ candidateSha256: sha, payloadSha256: sha, runtimePath: dir, nodePath: process.execPath, daemonHome: dir }),
    verifyCandidate: () => {},
    importModule: async specifier => { specifiers.push(specifier); throw new Error('TS load failed'); },
  });
  await assert.rejects(injection.agentCreate({ request: { config: { provider: 'slp-codex-lead', cwd: dir } } }), /TS load failed/);
  assert.deepEqual(specifiers, [pathToFileURL(join(dir, 'src/role-bundle.ts')).href]);
});

test('installed TypeScript policy runs in a worker with empty execArgv and no build dependencies', async t => {
  const dir = fixture(t), installed = join(dir, 'candidate');
  install(root, installed);
  assert.equal(identity(installed).files.some(entry => entry.path.startsWith('src/') && /\.(?:ts|mjs|js)$/.test(entry.path)), false);
  const spec = pathToFileURL(join(installed, 'plugin/server/runtime/cli/role-bundle.ts')).href;
  const worker = new Worker(`const {parentPort}=require('node:worker_threads'); import(${JSON.stringify(spec)}).then(mod=>parentPort.postMessage(mod.roleBundle(${JSON.stringify(installed)}, 'peer').instructions));`, { eval: true, execArgv: [] });
  t.after(() => worker.terminate());
  const policy = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  assert.match(policy, /^SLP role=peer\n/);
  const installedFiles = identity(installed).files.map(entry => entry.path);
  assert.ok(installedFiles.includes('plugin/server/runtime/cli/cli.ts'));
  assert.ok(installedFiles.includes('plugin/server/runtime/report-semantics.ts'));
  assert.ok(installedFiles.includes('plugin/server/runtime/handoff-recap.ts'));
  assert.equal(candidateModulePath(installed, 'package'), join(installed, 'plugin/server/runtime/cli/package.ts'));
});

test('capture layout failure returns a bounded outcome without executing a child', async t => {
  const dir = fixture(t);
  let ran = false;
  const result = await captureSeatSnapshot({ nodePath: process.execPath, runtimePath: dir, repository: dir, now: () => new Date('2026-01-01T00:00:00Z'), exec: async () => { ran = true; throw new Error('unexpected spawn'); } });
  assert.equal(ran, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'spawn-failed');
  assert.ok(result.detail.length <= 512);
});
