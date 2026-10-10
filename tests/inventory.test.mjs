import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { install, snapshot, json } from '../plugin/server/runtime/cli/package.ts';
import { launchPlan } from '../plugin/server/runtime/cli/launch.ts';
import { inventory } from '../plugin/server/runtime/cli/inventory.ts';
import { agents } from '../plugin/server/runtime/cli/agents.ts';
import { monitor } from '../plugin/server/runtime/cli/monitor.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/inventory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const binding = { provider: 'codex', model: 'gpt-5.6-luna', modeId: 'auto' };
const request = installed => ({ workspaceId: 'wks', repository: root, assignment: 'Short brief', binding });
function paseoHomeFixture(dir) {
  const home = join(dir, 'home');
  mkdirSync(join(home, 'agents', 'group'), { recursive: true });
  writeFileSync(join(home, 'config.json'), json({
    version: 1,
    agents: { providers: {
      'slp-codex-lead': { extends: 'codex', label: 'SLP codex lead', command: ['node', '/x/bin/codex-role.mjs', 'lead'] },
      'slp-devin-peer': { extends: 'acp', label: 'SLP devin peer', command: ['node', '/x/bin/devin-role.mjs', 'peer'] },
      off: { enabled: false },
    } },
    daemon: { agentProfiles: [
      { id: 'slp-lead', provider: 'slp-codex-lead', model: 'gpt-5.6-luna', modeId: 'full-access', featureValues: { fast_mode: true } },
      { id: 'custom', provider: 'pi', model: 'upstream/model', thinkingOptionId: 'high' },
    ] },
  }));
  return home;
}

test('inventory emits prepare-consumable providers/profiles from config when no paseo is reachable', t => {
  const dir = fixture(t), home = paseoHomeFixture(dir);
  const out = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'inventory', '--paseo-home', home],
    { env: { PATH: '' }, encoding: 'utf8' }));
  assert.equal(out.source.providers, join(home, 'config.json'));
  assert.equal(out.source.profiles, join(home, 'config.json'));
  assert.deepEqual(out.providers.find(p => p.id === 'slp-devin-peer'), { id: 'slp-devin-peer', enabled: true, extends: 'acp' });
  assert.deepEqual(out.providers.find(p => p.id === 'off'), { id: 'off', enabled: false });
  assert.deepEqual(out.profiles[0], { id: 'slp-lead', provider: 'slp-codex-lead', model: 'gpt-5.6-luna', modeId: 'full-access', featureValues: { fast_mode: true } });
  // The emitted arrays feed launchPlan directly.
  const installed = join(dir, 'release');
  install(root, installed);
  const plan = launchPlan(installed, { ...request(installed), role: 'lead', binding: undefined,
    profiles: out.profiles, providers: out.providers });
  assert.equal(plan.create.provider, 'slp-codex-lead/gpt-5.6-luna');
  assert.equal(plan.create.settings.modeId, 'full-access');
  // In-process call may use a live daemon; profiles always come from config.
  const live = inventory(home);
  assert.ok(live.providers.every(p => typeof p.id === 'string' && typeof p.enabled === 'boolean'));
  assert.equal(live.profiles.length, 2);
});

test('inventory tolerates an empty home and keeps arrays consumable', t => {
  const dir = fixture(t), home = join(dir, 'empty');
  mkdirSync(home);
  const out = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'inventory', '--paseo-home', home],
    { env: { PATH: '' }, encoding: 'utf8' }));
  assert.deepEqual(out.providers, []);
  assert.deepEqual(out.profiles, []);
});

test('inventory never spawns paseo for a home without a live daemon', t => {
  const dir = fixture(t), home = paseoHomeFixture(dir);
  const fakeBin = join(dir, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'paseo'), '#!/bin/sh\nprintf \'%s\\n\' \'[{"provider":"LIVE-MARKER","enabled":"Enabled","status":"available"}]\'\n');
  chmodSync(join(fakeBin, 'paseo'), 0o755);
  const out = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'inventory', '--paseo-home', home],
    { env: { PATH: fakeBin }, encoding: 'utf8' }));
  assert.equal(out.source.providers, join(home, 'config.json'));
  assert.ok(!out.providers.some(p => p.id === 'LIVE-MARKER'));
  assert.ok(out.providers.some(p => p.id === 'slp-devin-peer'));
});

test('inventory uses the live listing only for a live pid and reports unknown enabled states as null', t => {
  const dir = fixture(t), home = paseoHomeFixture(dir);
  writeFileSync(join(home, 'paseo.pid'), json({ pid: process.pid, listen: '127.0.0.1:1' }));
  const fakeBin = join(dir, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'paseo'), '#!/bin/sh\nprintf \'%s\\n\' \'[{"provider":"live-one","enabled":"Pending","status":"available"}]\'\n');
  chmodSync(join(fakeBin, 'paseo'), 0o755);
  const out = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'inventory', '--paseo-home', home],
    { env: { PATH: fakeBin }, encoding: 'utf8' }));
  assert.equal(out.source.providers, 'paseo provider ls --json');
  assert.deepEqual(out.providers, [{ id: 'live-one', enabled: null, status: 'available' }]);
  assert.equal(out.profiles.length, 2);
});

test('agents emits handles and devin attach hints, skipping malformed state', t => {
  const dir = fixture(t), home = join(dir, 'home');
  mkdirSync(join(home, 'agents', 'project-a'), { recursive: true });
  mkdirSync(join(home, 'agents', 'empty-group'));
  writeFileSync(join(home, 'agents', 'stray.txt'), 'not an agent dir');
  const base = { cwd: '/repo', workspaceId: 'wks_1', lastStatus: 'closed' };
  writeFileSync(join(home, 'agents', 'project-a', 'a1.json'), json({ ...base, id: 'a1', title: 'Peer — Engineer', provider: 'slp-devin-peer',
    persistence: { provider: 'slp-devin-peer', nativeHandle: 'session-123' } }));
  writeFileSync(join(home, 'agents', 'project-a', 'a2.json'), json({ ...base, id: 'a2', title: 'Pi lead', provider: 'slp-pi-lead',
    persistence: { provider: 'slp-pi-lead', nativeHandle: '/home/x/.pi/agent/sessions/s.jsonl' } }));
  writeFileSync(join(home, 'agents', 'project-a', 'a3.json'), json({ ...base, id: 'a3', provider: 'devin' }));
  writeFileSync(join(home, 'agents', 'project-a', 'a4.json'), json({ ...base, id: 'a4', provider: 'devin',
    persistence: { provider: 'devin', nativeHandle: 'hand le' } }));
  writeFileSync(join(home, 'agents', 'project-a', 'broken.json'), '{not json');
  const list = agents(home);
  assert.deepEqual(list.map(a => a.id), ['a1', 'a2', 'a3', 'a4']);
  const devin = list.find(a => a.id === 'a1');
  assert.equal(devin.nativeHandle, 'session-123');
  assert.equal(devin.attach, 'cd /repo && devin -r session-123');
  assert.equal(list.find(a => a.id === 'a2').attach, null);
  assert.equal(list.find(a => a.id === 'a3').attach, null);
  assert.equal(list.find(a => a.id === 'a3').nativeHandle, null);
  assert.equal(list.find(a => a.id === 'a4').attach, 'cd /repo && devin -r "hand le"');
  const cli = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'agents', '--paseo-home', home],
    { env: { PATH: '' }, encoding: 'utf8' }));
  assert.deepEqual(cli, list);
});

test('agents returns [] for a home without an agents directory and rejects stray targets', t => {
  const dir = fixture(t), home = join(dir, 'home');
  mkdirSync(home);
  assert.deepEqual(agents(home), []);
  const stray = () => execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'agents', 'extra', '--paseo-home', home],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.throws(stray, /takes no arguments/);
});

test('agent readers skip broken records and linked groups while preserving their duplicate-ID policies', t => {
  const dir = fixture(t), home = join(dir, 'home'), group = join(home, 'agents', 'group');
  mkdirSync(group, { recursive: true });
  const state = title => ({ id: 'duplicate', title, requiresAttention: true, attentionReason: title });
  writeFileSync(join(group, '01.json'), json(state('first')));
  writeFileSync(join(group, '02.json'), json(state('last')));
  for (const [name, bytes] of Object.entries({
    'broken.json': '{not json', 'null.json': 'null', 'array.json': '[]',
    'scalar.json': '1', 'missing-id.json': '{}', 'numeric-id.json': '{"id":1}',
    'ignored.txt': json({ id: 'ignored' }),
  })) writeFileSync(join(group, name), bytes);
  mkdirSync(join(group, 'directory.json'));
  symlinkSync(join(dir, 'missing.json'), join(group, 'dangling.json'));
  writeFileSync(join(home, 'agents', 'stray.txt'), 'not a group');
  const external = join(dir, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'hidden.json'), json({ id: 'hidden' }));
  symlinkSync(external, join(home, 'agents', 'linked-group'));
  // Existing readers follow file links but never recurse into linked groups.
  writeFileSync(join(dir, 'linked.json'), json({ id: 'linked' }));
  symlinkSync(join(dir, 'linked.json'), join(group, 'linked.json'));

  assert.deepEqual(agents(home).map(({ id, title }) => ({ id, title })), [
    { id: 'duplicate', title: 'first' }, { id: 'duplicate', title: 'last' }, { id: 'linked', title: null },
  ]);
  const out = monitor({ paseoHome: home, agents: [{ id: 'duplicate' }, { id: 'linked' }, { id: 'hidden' }] });
  assert.deepEqual(out.signals.map(({ agentId, kind, evidence }) => ({ agentId, kind, reason: evidence.reason })),
    [{ agentId: 'duplicate', kind: 'attention', reason: 'last' }]);
  assert.deepEqual(out.gaps.filter(gap => gap.gap === 'no agent state under paseoHome').map(gap => gap.agentId), ['hidden']);
});

test('agent readers distinguish missing state storage from an invalid agents root', t => {
  const dir = fixture(t), home = join(dir, 'home');
  mkdirSync(home);
  assert.deepEqual(agents(home), []);
  assert.ok(monitor({ paseoHome: home, agents: [{ id: 'missing' }] }).gaps
    .some(gap => gap.gap === 'no agent state under paseoHome'));
  writeFileSync(join(home, 'agents'), 'not a directory');
  assert.throws(() => agents(home), error => error.code === 'ENOTDIR');
  assert.throws(() => monitor({ paseoHome: home, agents: [{ id: 'missing' }] }), error => error.code === 'ENOTDIR');
});

test('prepare adds an Assignment file line without inlining file bytes', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const brief = join(dir, 'brief.md');
  writeFileSync(brief, 'FULL BOUNDED ASSIGNMENT BYTES');
  const plan = launchPlan(installed, { ...request(installed), assignmentFile: brief });
  assert.match(plan.create.initialPrompt, /Short brief/);
  assert.match(plan.create.initialPrompt, new RegExp(`Assignment file: ${brief}.*authoritative for scope`));
  assert.ok(!plan.create.initialPrompt.includes('BOUNDED ASSIGNMENT BYTES'));
  for (const [file, pattern] of [
    ['relative/brief.md', /Absolute assignmentFile/],
    [join(dir, 'missing.md'), /does not exist/],
    [dir, /regular file/],
  ]) {
    assert.throws(() => launchPlan(installed, { ...request(installed), assignmentFile: file }), pattern);
  }
});

test('prepare fills missing providers/profiles from inventoryFile; inline arrays win', t => {
  const dir = fixture(t), installed = join(dir, 'release');
  install(root, installed);
  const file = join(dir, 'inventory.json');
  writeFileSync(file, json({
    providers: [{ id: 'slp-codex-lead', enabled: true, status: 'available', extends: 'codex' }],
    profiles: [{ id: 'slp-lead', provider: 'slp-codex-lead', model: 'gpt-5.6-luna', modeId: 'full-access' }],
  }));
  const filled = launchPlan(installed, { ...request(installed), role: 'lead', binding: undefined, inventoryFile: file });
  assert.equal(filled.create.provider, 'slp-codex-lead/gpt-5.6-luna');
  const inline = [{ id: 'slp-lead', provider: 'slp-codex-lead', model: 'override/model' }];
  const won = launchPlan(installed, { ...request(installed), role: 'lead', binding: undefined, profiles: inline,
    providers: [{ id: 'slp-codex-lead', enabled: true, status: 'available', extends: 'codex' }], inventoryFile: file });
  assert.equal(won.create.provider, 'slp-codex-lead/override/model');
  for (const [fields, pattern] of [
    [{ inventoryFile: 'relative.json' }, /Absolute inventoryFile/],
    [{ inventoryFile: join(dir, 'missing.json') }, /not a readable JSON file/],
    [{ profiles: undefined, providers: undefined, inventoryFile: file.replace('inventory.json', 'none.json') }, /not a readable JSON file/],
  ]) {
    assert.throws(() => launchPlan(installed, { ...request(installed), role: 'lead', binding: undefined, ...fields }), pattern);
  }
  writeFileSync(join(dir, 'bad.json'), json(['not', 'object']));
  assert.throws(() => launchPlan(installed, { ...request(installed), role: 'lead', binding: undefined, inventoryFile: join(dir, 'bad.json') }), /must be a JSON object/);
  writeFileSync(join(dir, 'bad2.json'), json({ providers: 'nope' }));
  assert.throws(() => launchPlan(installed, { ...request(installed), role: 'lead', binding: undefined, inventoryFile: join(dir, 'bad2.json') }), /inventoryFile.providers must be an array/);
  // Missing both inline and file inventory keeps the existing missing-inventory errors.
  assert.throws(() => launchPlan(installed, { ...request(installed), role: 'lead', binding: undefined, profiles: [{ id: 'slp-lead', provider: 'slp-codex-lead', model: 'm' }] }), /list_providers inventory required/);
});

test('snapshot recurses into nested repositories and detects nested drift', t => {
  const dir = fixture(t);
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'owned.txt'), 'root');
  mkdirSync(join(dir, 'sub'));
  execFileSync('git', ['init', '-q', join(dir, 'sub')]);
  writeFileSync(join(dir, 'sub', 'inner.txt'), 'nested');
  const first = snapshot(dir);
  assert.equal(first.nested.length, 1);
  assert.equal(first.nested[0].path, 'sub');
  assert.ok(first.nested[0].files.some(f => f.path === 'inner.txt'));
  assert.equal(first.files.some(f => f.path === 'sub' || f.path === 'sub/'), false);
  assert.equal(snapshot(dir).sha256, first.sha256);
  writeFileSync(join(dir, 'sub', 'inner.txt'), 'changed');
  const second = snapshot(dir);
  assert.notEqual(second.sha256, first.sha256);
  assert.notEqual(second.nested[0].sha256, first.nested[0].sha256);
  // Second-level nesting recurses through the same routine and stays inspectable.
  mkdirSync(join(dir, 'sub', 'deep'));
  execFileSync('git', ['init', '-q', join(dir, 'sub', 'deep')]);
  writeFileSync(join(dir, 'sub', 'deep', 'leaf.txt'), 'leaf');
  const third = snapshot(dir);
  assert.equal(third.nested[0].path, 'sub');
  assert.equal(third.nested[0].nested.length, 1);
  assert.equal(third.nested[0].nested[0].path, 'deep');
  assert.ok(third.nested[0].nested[0].files.some(f => f.path === 'leaf.txt'));
});

test('snapshot handles staged gitlinks and still rejects index file entries that are directories', t => {
  const dir = fixture(t);
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'owned.txt'), 'root');
  mkdirSync(join(dir, 'linked'));
  execFileSync('git', ['init', '-q', join(dir, 'linked')]);
  execFileSync('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,linked']);
  // The staged pointer is recorded verbatim; the linked repo has no commits so
  // no HEAD resolves and the scope is unproven rather than a crash.
  const snap = snapshot(dir);
  assert.deepEqual(snap.files.find(entry => entry.path === 'linked'),
    { path: 'linked', kind: 'gitlink', indexOid: '1111111111111111111111111111111111111111', headOid: null, state: 'uninitialized' });
  assert.deepEqual(snap.incomplete, ['linked']);
  // An index entry claiming a regular file while a non-repo directory sits on
  // disk is still unsupported — only gitlinks get pointer semantics.
  execFileSync('git', ['-C', dir, 'update-index', '--force-remove', 'linked']);
  rmSync(join(dir, 'linked', '.git'), { recursive: true });
  execFileSync('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', '100644,2222222222222222222222222222222222222222,linked']);
  assert.throws(() => snapshot(dir), /Submodules\/directories unsupported: linked/);
});
