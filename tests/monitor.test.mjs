import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { json, readJson } from '../plugin/server/runtime/cli/package.ts';
import { monitor } from '../plugin/server/runtime/cli/monitor.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function gitRepo(dir) {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'monitor@test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Monitor Test']);
  writeFileSync(join(dir, 'seed.txt'), 'seed');
  execFileSync('git', ['-C', dir, 'add', 'seed.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed']);
  return dir;
}
function agentState(home, id, fields) {
  const group = join(home, 'agents', 'group');
  mkdirSync(group, { recursive: true });
  writeFileSync(join(group, `${id}.json`), json({ id, ...fields }));
}

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* host without node:sqlite */ }
const sqliteTest = DatabaseSync ? test : test.skip;
function devinDbFixture(dir, sessions, calls) {
  const path = join(dir, 'sessions.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, last_activity_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE tool_call_state (session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, tool_call_json TEXT, PRIMARY KEY (session_id, tool_call_id))');
  const insertSession = db.prepare('INSERT INTO sessions (id, working_directory, last_activity_at) VALUES (?, ?, ?)');
  for (const s of sessions) insertSession.run(s.id, s.cwd, s.lastActivityAt);
  const insertCall = db.prepare('INSERT INTO tool_call_state (session_id, tool_call_id, tool_call_json) VALUES (?, ?, ?)');
  calls.forEach((call, i) => insertCall.run(call[0], call[1] ?? `call-${i}`, JSON.stringify(call[2])));
  db.close();
  return path;
}
const toolCall = (tool, extra = {}) => ({ toolCallId: 'x', kind: 'execute', title: tool, rawInput: {}, _meta: { 'cognition.ai/inferenceToolName': tool }, ...extra });

test('monitor emits attention once per fingerprint and always rewrites the checkpoint', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  agentState(home, 'a1', { lastStatus: 'running', cwd: repo, requiresAttention: true, attentionReason: 'permission pending' });
  const stateFile = join(dir, 'state.json');
  const request = { paseoHome: home, agents: [{ id: 'a1', cwd: repo }], stateFile };
  const first = monitor(request);
  assert.deepEqual(first.signals.map(s => s.kind), ['attention']);
  assert.equal(first.signals[0].agentId, 'a1');
  assert.equal(first.signals[0].evidence.reason, 'permission pending');
  assert.equal(first.stateFile, stateFile);
  assert.ok(readJson(stateFile).a1.emitted.includes('a1|attention|permission pending'));
  const second = monitor(request);
  assert.deepEqual(second.signals, []);
  assert.equal(second.scanned, 1);
  // A stale reason alone is not a trigger: requiresAttention===false suppresses.
  agentState(home, 'a2', { lastStatus: 'idle', cwd: repo, requiresAttention: false, attentionReason: 'stale reason' });
  assert.deepEqual(monitor({ paseoHome: home, agents: [{ id: 'a2', cwd: repo }] }).signals, []);
});

test('monitor counts consecutive follow-up bumps until a commit breaks the streak', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  const stateFile = join(dir, 'state.json');
  const request = { paseoHome: home, agents: [{ id: 'a1', cwd: repo }], stateFile };
  const bump = stamp => agentState(home, 'a1', { lastStatus: 'working', cwd: repo, lastUserMessageAt: stamp });
  bump('2026-09-17T01:00:00Z');
  assert.deepEqual(monitor(request).signals, []);
  bump('2026-09-17T02:00:00Z');
  assert.deepEqual(monitor(request).signals, []);
  bump('2026-09-17T03:00:00Z');
  const third = monitor(request);
  assert.deepEqual(third.signals.map(s => s.kind), ['follow-up-round']);
  assert.equal(third.signals[0].evidence.followUpCount, 2);
  writeFileSync(join(repo, 'progress.txt'), 'x');
  execFileSync('git', ['-C', repo, 'add', 'progress.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'progress']);
  bump('2026-09-17T04:00:00Z');
  assert.deepEqual(monitor(request).signals, []);
});

test('monitor flags an idle agent with a dirty worktree past the threshold only', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  writeFileSync(join(repo, 'dirty.txt'), 'x');
  agentState(home, 'a1', { lastStatus: 'idle', cwd: repo, lastActivityAt: new Date(Date.now() - 3600e3).toISOString() });
  const out = monitor({ paseoHome: home, agents: [{ id: 'a1', cwd: repo }] });
  assert.equal(out.stateless, true);
  assert.equal(out.stateFile, null);
  assert.deepEqual(out.signals.map(s => s.kind), ['idle-dirty']);
  assert.deepEqual(out.signals[0].evidence.dirty, ['dirty.txt']);
  agentState(home, 'a2', { lastStatus: 'finished', cwd: repo, lastActivityAt: new Date().toISOString() });
  assert.deepEqual(monitor({ paseoHome: home, agents: [{ id: 'a2', cwd: repo }] }).signals, []);
  agentState(home, 'a3', { lastStatus: 'working', cwd: repo, lastActivityAt: new Date(Date.now() - 3600e3).toISOString() });
  assert.deepEqual(monitor({ paseoHome: home, agents: [{ id: 'a3', cwd: repo }] }).signals, []);
});

test('monitor flags scope drift and test mirrors from git status paths', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'tests'));
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'src/foo.mjs'), 'x');
  writeFileSync(join(repo, 'tests/foo.test.mjs'), 'x');
  writeFileSync(join(repo, 'docs/note.md'), 'x');
  agentState(home, 'a1', { lastStatus: 'working', cwd: repo });
  const out = monitor({ paseoHome: home, agents: [{ id: 'a1', cwd: repo, scope: ['src/', 'tests/'] }] });
  const drift = out.signals.find(s => s.kind === 'scope-drift');
  assert.deepEqual(drift.evidence.offending, ['docs/note.md']);
  const mirror = out.signals.find(s => s.kind === 'test-mirror');
  assert.deepEqual(mirror.evidence.pairs, [{ test: 'tests/foo.test.mjs', implementation: 'src/foo.mjs' }]);
  const globbed = monitor({ paseoHome: home, agents: [{ id: 'a1', cwd: repo, scope: ['src/*', 'tests/*', 'docs/'] }] });
  assert.equal(globbed.signals.some(s => s.kind === 'scope-drift'), false);
  // Non-ASCII paths must match scope literally (core.quotePath=false), not drift.
  mkdirSync(join(repo, 'tài-liệu'));
  writeFileSync(join(repo, 'tài-liệu/ghi-chú.md'), 'x');
  const unicode = monitor({ paseoHome: home, agents: [{ id: 'a1', cwd: repo, scope: ['tài-liệu/'] }] });
  const unicodeDrift = unicode.signals.find(s => s.kind === 'scope-drift');
  assert.deepEqual(unicodeDrift.evidence.offending.sort(), ['docs/note.md', 'src/foo.mjs', 'tests/foo.test.mjs'].sort());
});

test('monitor flags churn only when a dirty path keeps changing across scans', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  const file = join(repo, 'seed.txt');
  writeFileSync(file, 'changed');
  utimesSync(file, 1700000000, 1700000000);
  agentState(home, 'a1', { lastStatus: 'working', cwd: repo });
  const stateFile = join(dir, 'state.json');
  const request = { paseoHome: home, agents: [{ id: 'a1', cwd: repo }], stateFile };
  assert.deepEqual(monitor(request).signals, []);
  // Still dirty but untouched between scans: no repeated correction, no emit.
  assert.deepEqual(monitor(request).signals, []);
  // A fresh edit to the same dirty path is the second churn round.
  utimesSync(file, 1700000100, 1700000100);
  const third = monitor(request);
  assert.deepEqual(third.signals.map(s => s.kind), ['file-churn']);
  assert.deepEqual(third.signals[0].evidence, { path: 'seed.txt', scans: 2 });
  assert.deepEqual(monitor(request).signals, []);
  const custom = join(dir, 'custom.json');
  writeFileSync(custom, json({ a1: { churn: { 'seed.txt': { mtime: 1, count: 2 } }, emitted: [] } }));
  const fifth = monitor({ ...request, stateFile: custom, thresholds: { churnScans: 3 } });
  assert.deepEqual(fifth.signals.map(s => s.kind), ['file-churn']);
  assert.equal(fifth.signals[0].evidence.scans, 3);
});

test('monitor records evidence gaps for broken or undeclared cwd and missing state', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  // Outside the worktree: fixture dirs sit inside this repo, so an in-repo
  // "plain" directory would resolve to the parent checkout instead.
  const plain = mkdtempSync(join(tmpdir(), 'monitor-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  agentState(home, 'a1', { lastStatus: 'working', cwd: repo });
  const out = monitor({ paseoHome: home, agents: [
    { id: 'a1', cwd: join(dir, 'missing') },
    { id: 'a2', cwd: plain },
    { id: 'a3' },
  ] });
  assert.deepEqual(out.signals, []);
  assert.equal(out.scanned, 3);
  assert.equal(out.gaps.find(g => g.agentId === 'a1').gap, 'cwd is not a directory');
  assert.match(out.gaps.find(g => g.agentId === 'a2' && g.cwd).gap, /not a git repository/);
  assert.equal(out.gaps.filter(g => g.agentId === 'a2').length, 2);
  assert.deepEqual(out.gaps.filter(g => g.agentId === 'a3').map(g => g.gap),
    ['no agent state under paseoHome', 'no cwd declared']);
});

test('monitor honors the signals subset and validates the request shape', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  writeFileSync(join(repo, 'outside.md'), 'x');
  agentState(home, 'a1', { lastStatus: 'working', cwd: repo, requiresAttention: true });
  const agents = [{ id: 'a1', cwd: repo, scope: ['src/'] }];
  const out = monitor({ paseoHome: home, agents, signals: ['attention'] });
  assert.deepEqual(out.signals.map(s => s.kind), ['attention']);
  for (const [fields, pattern] of [
    [{}, /request\.agents required/],
    [{ agents: [{ cwd: repo }] }, /agents\[\]\.id required/],
    [{ agents: [{ id: 'a1', cwd: 'relative' }] }, /cwd must be absolute/],
    [{ agents: [{ id: 'a1' }, { id: 'a1' }] }, /Duplicate agents\[\]\.id/],
    [{ agents, signals: ['bogus'] }, /subset/],
    [{ agents, stateFile: 'relative/state.json' }, /Absolute stateFile/],
    [{ agents, thresholds: { idleMinutes: 0 } }, /idleMinutes must be positive/],
    [{ agents, paseoHome: 'relative' }, /Absolute paseoHome/],
  ]) {
    assert.throws(() => monitor({ paseoHome: home, ...fields }), pattern);
  }
});

test('monitor CLI reads request.json and prints the scan', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  agentState(home, 'a1', { lastStatus: 'finished', cwd: repo, requiresAttention: true });
  const request = join(dir, 'request.json');
  writeFileSync(request, json({ paseoHome: home, agents: [{ id: 'a1', cwd: repo }] }));
  const out = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'monitor', request], { encoding: 'utf8' }));
  assert.equal(out.signals[0].kind, 'attention');
  assert.equal(out.stateless, true);
  const missing = spawnSync(process.execPath, [join(root, 'bin/slp.mjs'), 'monitor'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /monitor requires <request\.json>/);
});

sqliteTest('monitor devin probe emits tool-mix and suppresses the fingerprint on rerun', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  const calls = [...Array(18).fill(toolCall('exec')), toolCall('read'), toolCall('read')]
    .map(call => ['sess-1', null, call]);
  const dbPath = devinDbFixture(dir, [{ id: 'sess-1', cwd: repo, lastActivityAt: 1 }], calls);
  agentState(home, 'a1', { lastStatus: 'working', cwd: repo, provider: 'slp-devin-peer', persistence: { nativeHandle: 'sess-1' } });
  const stateFile = join(dir, 'state.json');
  const request = { paseoHome: home, agents: [{ id: 'a1', cwd: repo }], stateFile, devinSessionsDb: dbPath };
  const out = monitor(request);
  const mix = out.signals.find(s => s.kind === 'tool-mix');
  assert.equal(mix.evidence.tool, 'exec');
  assert.equal(mix.evidence.share, 0.9);
  assert.equal(mix.evidence.window, 20);
  assert.equal(mix.evidence.sessionId, 'sess-1');
  assert.equal(readJson(stateFile).a1.devin.sessionId, 'sess-1');
  assert.deepEqual(monitor(request).signals, []);
  // A new devin session (new nativeHandle) retires the old fingerprints.
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO sessions (id, working_directory, last_activity_at) VALUES (?, ?, ?)').run('sess-2', repo, 2);
  calls.forEach((call, i) => db.prepare('INSERT INTO tool_call_state (session_id, tool_call_id, tool_call_json) VALUES (?, ?, ?)')
    .run('sess-2', `s2-${i}`, JSON.stringify(toolCall('read'))));
  db.close();
  agentState(home, 'a1', { lastStatus: 'working', cwd: repo, provider: 'slp-devin-peer', persistence: { nativeHandle: 'sess-2' } });
  const rolled = monitor(request);
  const remixed = rolled.signals.find(s => s.kind === 'tool-mix');
  assert.equal(remixed.evidence.tool, 'read');
  assert.equal(remixed.evidence.sessionId, 'sess-2');
});

sqliteTest('monitor devin probe attributes sessions by nativeHandle, never by shared cwd', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  const target = join(repo, 'src/foo.mjs');
  // Lead and Supervisor share one worktree: newest-by-cwd would misattribute.
  const dbPath = devinDbFixture(dir, [
    { id: 'sess-sup', cwd: repo, lastActivityAt: 2 },
    { id: 'sess-lead', cwd: repo, lastActivityAt: 1 },
  ], [
    ...Array(4).fill(toolCall('edit', { kind: 'edit', rawInput: { file_path: target } })).map(call => ['sess-lead', null, call]),
    ...Array(3).fill(toolCall('exec')).map(call => ['sess-sup', null, call]),
  ]);
  agentState(home, 'lead', { lastStatus: 'working', cwd: repo, provider: 'devin', persistence: { nativeHandle: 'sess-lead' } });
  agentState(home, 'sup', { lastStatus: 'working', cwd: repo, provider: 'slp-devin-peer', persistence: { nativeHandle: 'sess-sup' } });
  const out = monitor({ paseoHome: home, agents: [{ id: 'lead', cwd: repo }, { id: 'sup', cwd: repo }], devinSessionsDb: dbPath });
  const cadence = out.signals.find(s => s.kind === 'correction-cadence');
  assert.equal(cadence.agentId, 'lead');
  assert.equal(cadence.evidence.sessionId, 'sess-lead');
  const mix = out.signals.find(s => s.agentId === 'sup' && s.kind === 'tool-mix');
  assert.equal(mix.evidence.tool, 'exec');
  assert.equal(mix.evidence.sessionId, 'sess-sup');
});

sqliteTest('monitor devin probe emits correction-cadence for repeated edits of one path', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  const target = join(repo, 'src/foo.mjs');
  const calls = [
    ...Array(4).fill(toolCall('edit', { kind: 'edit', rawInput: { file_path: target } })),
    toolCall('edit', { kind: 'edit', rawInput: { file_path: join(repo, 'src/other.mjs') } }),
    toolCall('write', { kind: 'edit', rawInput: {} }),           // unparseable path: skipped
    toolCall('read'),
  ].map(call => ['sess-1', null, call]);
  const dbPath = devinDbFixture(dir, [{ id: 'sess-1', cwd: repo, lastActivityAt: 1 }], calls);
  agentState(home, 'a1', { lastStatus: 'working', cwd: repo, provider: 'slp-devin-peer', persistence: { nativeHandle: 'sess-1' } });
  const out = monitor({ paseoHome: home, agents: [{ id: 'a1', cwd: repo }], devinSessionsDb: dbPath });
  const cadence = out.signals.find(s => s.kind === 'correction-cadence');
  assert.equal(cadence.evidence.path, target);
  assert.equal(cadence.evidence.count, 4);
  assert.equal(cadence.evidence.window, 7);
  assert.equal(out.signals.filter(s => s.kind === 'correction-cadence').length, 1);
});

sqliteTest('monitor devin probe records gaps and skips non-devin or unopted agents', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  mkdirSync(join(dir, 'other'));
  const dbPath = devinDbFixture(dir, [{ id: 'sess-1', cwd: join(dir, 'other'), lastActivityAt: 1 }], []);
  agentState(home, 'a1', { lastStatus: 'working', cwd: repo, provider: 'slp-devin-peer', persistence: { nativeHandle: 'no-such-session' } });
  agentState(home, 'a2', { lastStatus: 'working', cwd: repo, provider: 'slp-codex-peer' });
  agentState(home, 'a3', { lastStatus: 'working', cwd: repo, provider: 'slp-devin-peer' });
  const out = monitor({ paseoHome: home, agents: [{ id: 'a1', cwd: repo }, { id: 'a2', cwd: repo }, { id: 'a3', cwd: repo }], devinSessionsDb: dbPath });
  assert.equal(out.gaps.find(g => g.agentId === 'a1').gap, 'no devin session for handle');
  assert.equal(out.gaps.find(g => g.agentId === 'a3').gap, 'devin agent has no persistence.nativeHandle');
  assert.equal(out.gaps.some(g => g.agentId === 'a2'), false);
  const unreadable = monitor({ paseoHome: home, agents: [{ id: 'a1', cwd: repo }], devinSessionsDb: join(dir, 'missing.db') });
  assert.match(unreadable.gaps[0].gap, /devin sessions\.db unreadable/);
  const unopted = monitor({ paseoHome: home, agents: [{ id: 'a1', cwd: repo }] });
  assert.deepEqual(unopted.gaps ?? [], []);
  assert.equal(unopted.signals.every(s => !['tool-mix', 'correction-cadence'].includes(s.kind)), true);
});
