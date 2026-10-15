import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { creatorClass, episodeId, labelledEpisode, protocolSha256, seatMetadata } from '../plugin/server/runtime/episode.ts';
import { install } from '../plugin/server/runtime/cli/package.ts';
import { handoffPlan, launchPlan, launchCheck } from '../plugin/server/runtime/cli/launch.ts';
import { committedRepository, placementFixture } from './helpers/formation-placement-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function directory(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'slp-episode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(join(dir, '.paseo-slp'));
  return dir;
}

test('protocol identity hashes exact bytes and reuses an unchanged file without rereading', t => {
  const dir = directory(t), path = join(dir, '.paseo-slp/workspace-protocol.md');
  const bytes = Buffer.from('---\r\nversion: 1\r\n---\r\nProtocol: "original"\r\n');
  fs.writeFileSync(path, bytes);
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => { if (typeof args[0] === 'number') reads++; return original(...args); };
  syncBuiltinESMExports();
  try {
    assert.equal(protocolSha256(dir), sha(bytes));
    assert.equal(protocolSha256(dir), sha(bytes));
    assert.equal(reads, 1);
    const stat = fs.statSync(path);
    fs.writeFileSync(path, Buffer.from(bytes.toString().replace('original', 'modified')));
    fs.utimesSync(path, stat.atime, stat.mtime);
    assert.equal(protocolSha256(dir), sha(fs.readFileSync(path)));
    assert.equal(reads, 2, 'restoring mtime on a same-size edit must invalidate cached identity');
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test('missing protocol emits a bounded warning and no placeholder label', t => {
  const metadata = seatMetadata({ role: 'peer', disposition: 'reviewer', repository: directory(t), runtimeSha: 'a'.repeat(64) });
  assert.deepEqual(metadata.labels, { 'slp.role': 'peer', 'slp.disposition': 'reviewer', 'slp.runtime-sha': 'a'.repeat(64) });
  assert.deepEqual(metadata.warnings, ['protocol-sha-unavailable']);
  assert.equal(seatMetadata({ role: 'lead', repository: directory(t) }).labels['slp.disposition'], undefined);
});

test('creator classification distinguishes unlabelled roots from legacy children and unreadable metadata', () => {
  const episode = { 'slp.episode-id': episodeId('fixture'), 'slp.episode-root': 'root' };
  assert.equal(creatorClass(episode), 'labelled');
  assert.deepEqual(labelledEpisode(episode), { episodeId: episode['slp.episode-id'], rootAgentId: 'root' });
  assert.equal(creatorClass({}), 'root');
  for (const labels of [null, { 'slp.formation': 'a'.repeat(64) }, { 'paseo.parent-agent-id': 'parent' },
    { 'slp.episode-id': 'broken', 'slp.episode-root': 'root' }]) assert.equal(creatorClass(labels), 'missing');
});

test('CLI emits the installed candidate identity, explicit role and handoff lineage without changing delivery bytes', t => {
  const dir = directory(t), installed = join(dir, 'installed');
  committedRepository(dir);
  const { candidate } = install(root, installed);
  const request = { repository: dir, workspaceId: 'workspace', role: 'lead', assignment: 'bounded work',
    binding: { provider: 'pi', model: 'model', modeId: 'full-access' } };
  const first = launchPlan(installed, request);
  assert.equal(first.create.labels['slp.runtime-sha'], candidate.sha256);
  assert.equal(first.create.labels['slp.role'], 'lead');
  assert.equal(first.create.labels['slp.episode-id'], undefined);
  assert.equal(first.create.labels['slp.disposition'], undefined);
  const episode = { episodeId: episodeId('handoff'), rootAgentId: 'original-root' };
  const handoff = { previousAgentId: 'previous', reason: 'quota', authority: 'Human assignment', state: 'settled',
    previousOwner: { settled: true, evidence: 'settlement' }, resources: [], episode };
  const successor = handoffPlan(installed, { ...request, handoff });
  assert.equal(successor.create.labels['slp.handoff-from'], 'previous');
  assert.deepEqual(labelledEpisode(successor.create.labels), episode);
  const { episode: _omitted, ...withoutEpisode } = handoff;
  const unknown = handoffPlan(installed, { ...request, handoff: withoutEpisode });
  assert.equal(unknown.create.labels['slp.handoff-from'], 'previous');
  assert.equal(unknown.create.labels['slp.episode-id'], undefined);
  assert.ok(unknown.warnings.includes('episode-context-missing'));
});

test('formation creates and verifies the exact role/version labels and retains its formation join', async t => {
  const f = placementFixture(t);
  const out = await f.run({ ...f.input, disposition: 'reviewer' });
  assert.equal(out.result.state, 'awaiting-caller-delivery');
  const issued = out.phases.find(row => row.name === 'create-issued').value;
  const created = f.hostCalls.find(row => row.kind === 'create').options;
  assert.equal(created.labels['slp.role'], 'peer');
  assert.equal(created.labels['slp.disposition'], 'reviewer');
  assert.equal(created.labels['slp.formation'], issued.label);
  assert.deepEqual(created.labels, issued.labels);
  assert.equal(created.labels['slp.runtime-sha'], JSON.parse(fs.readFileSync(join(f.candidate, 'installed.json'))).candidate.sha256);
  assert.deepEqual(out.result.verification.mismatches, []);
});

test('missing host metadata warns without blocking delivery or weakening core verification', async t => {
  const f = placementFixture(t);
  f.setAfterCreate(() => { delete f.snapshots.get('child').labels['slp.role']; });
  const out = await f.run();
  assert.equal(out.result.state, 'awaiting-caller-delivery');
  assert.deepEqual(out.result.verification.metadataMismatches, ['label:slp.role:mismatch']);
  assert.deepEqual(out.result.verification.mismatches, []);
});

test('protocol metadata follows the qualified source for a caller in a subdirectory', async t => {
  const f = placementFixture(t, { role: 'lead' });
  const protocol = '---\nagent_mode: full-access\n---\nTop-level source protocol.\n';
  fs.writeFileSync(join(f.repository, '.paseo-slp/workspace-protocol.md'), protocol);
  const subdir = join(f.repository, 'subdirectory');
  fs.mkdirSync(subdir);
  f.row.createCwd = subdir;
  f.workspaces.get('caller').workspaceDirectory = subdir;
  const out = await f.run();
  assert.equal(out.result.state, 'awaiting-caller-delivery');
  const issued = out.phases.find(row => row.name === 'create-issued').value;
  assert.equal(issued.labels['slp.protocol-sha'], sha(protocol));
  assert.ok(!issued.warnings.includes('protocol-sha-unavailable'));
});

test('Supervisor cross-repository metadata hashes the target protocol, preserving the caller parent', async t => {
  const f = placementFixture(t, { role: 'lead', callerRole: 'supervisor' });
  const protocol = '---\nagent_mode: full-access\n---\nForeign source protocol.\n';
  fs.mkdirSync(join(f.foreign, '.paseo-slp'));
  fs.writeFileSync(join(f.foreign, '.paseo-slp/workspace-protocol.md'), protocol);
  const out = await f.run({ ...f.input, placement: { kind: 'existing', workspaceId: 'foreign', reason: 'assigned target' } });
  assert.equal(out.result.state, 'awaiting-caller-delivery');
  const issued = out.phases.find(row => row.name === 'create-issued').value;
  assert.equal(issued.labels['slp.protocol-sha'], sha(protocol));
  assert.equal(issued.parent, f.row.agentId);
});


for (const context of ['missing', 'invalid', 'valid']) test(`handoff ${context} episode warnings survive check and create export`, t => {
  const dir = directory(t), installed = join(dir, 'installed');
  committedRepository(dir);
  install(root, installed);
  const handoff = { previousAgentId: 'previous', reason: 'quota', authority: 'Human', state: 'settled',
    previousOwner: { settled: true, evidence: 'settlement' }, resources: [],
    ...(context === 'missing' ? {} : { episode: context === 'invalid' ? { episodeId: 'invalid', rootAgentId: 'root' }
      : { episodeId: episodeId('valid-handoff'), rootAgentId: 'root' } }) };
  const request = { repository: dir, workspaceId: 'workspace', role: 'lead', assignment: 'bounded',
    binding: { provider: 'pi', model: 'model', modeId: 'full-access' }, handoff };
  const planned = handoffPlan(installed, request);
  const checked = launchCheck(installed, request, { handoff: true });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.warnings, planned.warnings);
  for (const flags of [['--check'], ['--emit', 'create']]) {
    const result = spawnSync(process.execPath, [join(installed, 'bin/slp.mjs'), 'prepare-handoff', '-', ...flags], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.warnings, planned.warnings);
    assert.equal(output.warnings.includes('episode-context-missing'), context !== 'valid');
    assert.ok(output.warnings.includes('protocol-sha-unavailable'));
    if (flags[0] === '--emit') assert.deepEqual(output.create, planned.create);
  }
});
