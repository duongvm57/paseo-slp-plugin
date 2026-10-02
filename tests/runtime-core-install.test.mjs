import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hash, identity, install, installUnitPaths, json, update, verifyInstall } from '../plugin/server/runtime/cli/package.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-core-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('installed native TS core runs CLI adapters without node_modules or plugin dependencies', t => {
  const dir = fixture(t), destination = join(dir, 'installed'), home = join(dir, 'home');
  mkdirSync(home);
  const { candidate } = install(root, destination);
  assert.equal(existsSync(join(destination, 'node_modules')), false);
  assert.equal(existsSync(join(destination, 'plugin/package.json')), false);
  for (const file of candidate.files.filter(file => file.path.startsWith('plugin/'))) {
    assert.match(file.path, /^plugin\/(?:server|shared)\/runtime\//u);
    assert.deepEqual(readFileSync(join(destination, file.path)), readFileSync(join(root, file.path)));
  }
  const slp = join(destination, 'bin/slp.mjs');
  const schema = JSON.parse(execFileSync(process.execPath, [slp, 'records', '--schema'], { encoding: 'utf8' }));
  assert.ok(schema.oneOf);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.paseo-slp'), { recursive: true });
  writeFileSync(join(repo, '.paseo-slp/slp-routing.json'), json({
    version: 1, policy: 'Fixture routing pool.', options: [{
      id: 'security-review', provider: 'codex', roles: ['peer'], model: 'fixture',
      enabled: true, availability: 'ready', suitableFor: ['work:change'],
      avoidFor: [], notes: 'Deliberately conflicting standard seat.',
    }],
  }));
  const routes = JSON.parse(execFileSync(process.execPath, [slp, 'routes', repo, '--paseo-home', home], { encoding: 'utf8' }));
  assert.deepEqual(routes.tokenConflicts.map(row => row.id), ['security-review']);
  assert.equal(existsSync(join(destination, 'src/routing-vocabulary.mjs')), false);
  mkdirSync(join(home, 'slp-runtime/state'), { recursive: true });
  writeFileSync(join(home, 'slp-runtime/state/work-tracker.json'), json({ schemaVersion: 1, tracker: 'beads', enabled: true }));
  const tracker = JSON.parse(execFileSync(process.execPath, [slp, 'tracker', repo, '--paseo-home', home], {
    encoding: 'utf8', env: { ...process.env, PATH: '/no-fixture-bd' },
  }));
  assert.equal(tracker.enabled, true);
  assert.equal(tracker.state, 'unavailable');
  writeFileSync(join(home, 'slp-runtime/state/jev.json'), json({ schemaVersion: 1, enabled: false }));
  const jev = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { readJevConfig, sanitizeRemoteText } from './plugin/server/runtime/cli/jev.ts'; console.log(JSON.stringify({config: readJevConfig(process.argv[1]), text: sanitizeRemoteText('ordinary brief')}));",
    home], { cwd: destination, encoding: 'utf8' }));
  assert.equal(jev.config.enabled, false);
  assert.equal(jev.config.provider, null);
  assert.equal(jev.text, 'ordinary brief');
  const key = 'a'.repeat(64);
  const namespace = join(home, 'slp-runtime/state/enforcement/repos', key);
  mkdirSync(join(namespace, 'events'), { recursive: true });
  // Run the installed sync adapter rather than loading the repository core.
  const outcome = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { recoverLock, recoveryOutput } from './plugin/server/runtime/cli/desk-recovery.ts'; console.log(JSON.stringify(recoveryOutput(recoverLock({stableRoot: process.argv[1], repoKey: process.argv[2]}, {actorKey:'operator:cli:test'}))));",
    join(home, 'slp-runtime'), key], { cwd: destination, encoding: 'utf8' }));
  assert.equal(outcome.receipt.result, 'no-lock');
  assert.equal(outcome.receipt.recoverLockReleased, true);
  assert.deepEqual(verifyInstall(destination).candidate, candidate);
});

test('legacy receipt keeps its identity and upgrades to the new install unit', t => {
  const dir = fixture(t), source = join(dir, 'legacy'), destination = join(dir, 'installed');
  mkdirSync(join(source, 'bin'), { recursive: true });
  mkdirSync(join(source, 'src'));
  for (const [path, bytes] of [
    ['package.json', '{"type":"module"}\n'], ['install.sh', '#!/bin/sh\n'],
    ['bin/slp.mjs', ''], ['src/old.mjs', 'export const old = true;\n'],
  ]) writeFileSync(join(source, path), bytes);
  // This is the old bin/src selector's receipt, built independently of the new selector.
  const entries = ['bin/slp.mjs', 'install.sh', 'package.json', 'src/old.mjs']
    .map(path => ({ path, sha256: hash(readFileSync(join(source, path))) }));
  const legacy = { sha256: hash(json(entries)), files: entries };
  assert.deepEqual(identity(source), legacy);
  install(source, destination);
  assert.deepEqual(verifyInstall(destination).candidate, legacy);
  update(root, destination);
  assert.deepEqual(verifyInstall(destination).candidate, identity(root));
  assert.equal(existsSync(join(destination, 'src/old.mjs')), false);
  assert.equal(existsSync(join(destination, 'plugin/server/runtime/desk-recovery.ts')), true);
});

for (const ancestor of ['plugin', 'plugin/server', 'plugin/server/runtime']) {
  test(`selector refuses symlink at ${ancestor} before reading runtime bytes`, t => {
    const dir = fixture(t), source = join(dir, 'source'), outside = join(dir, 'outside');
    mkdirSync(source); mkdirSync(outside);
    mkdirSync(join(source, 'bin')); mkdirSync(join(source, 'src'));
    writeFileSync(join(source, 'package.json'), '{}'); writeFileSync(join(source, 'install.sh'), '');
    mkdirSync(join(source, ancestor, '..'), { recursive: true });
    symlinkSync(outside, join(source, ancestor), 'dir');
    assert.throws(() => installUnitPaths(source), /symlink or non-directory/);
  });
}
