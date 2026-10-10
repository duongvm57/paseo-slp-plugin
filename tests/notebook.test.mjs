import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { notebook } from '../plugin/server/runtime/cli/notebook.ts';
import { json } from '../plugin/server/runtime/cli/package.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/notebook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function gitRepo(dir) {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'notebook@test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Notebook Test']);
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
function notebookFile(cwd) {
  const dir = join(cwd, '.paseo-slp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notebook.md'), '# notebook\n');
}

test('notebook resolves the active supervisor notebook from another checkout of the same repo', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  const worktree = join(dir, 'wt');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wt-branch', worktree]);
  notebookFile(worktree);
  agentState(home, 'sup', { provider: 'slp-devin-supervisor', title: 'Supervisor — run', cwd: worktree, lastStatus: 'running', lastActivityAt: '2026-09-16T10:00:00Z' });
  const out = notebook(repo, home);
  assert.equal(out.notebooks.length, 1);
  assert.equal(out.notebooks[0].agentId, 'sup');
  assert.equal(out.notebooks[0].notebook, join(worktree, '.paseo-slp', 'notebook.md'));
  assert.equal(out.notebooks[0].notebookExists, true);
  assert.equal(out.notebooks[0].status, 'running');
});

test('notebook filters non-supervisors, unrelated repos, and sorts candidates by activity', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  const wt1 = join(dir, 'wt1'), wt2 = join(dir, 'wt2');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'b1', wt1]);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'b2', wt2]);
  const other = gitRepo(join(dir, 'other'));
  agentState(home, 'peer', { provider: 'slp-devin-peer', cwd: wt1, lastActivityAt: '2026-09-16T12:00:00Z' });
  agentState(home, 'sup-old', { provider: 'slp-codex-supervisor', cwd: wt1, lastActivityAt: '2026-09-15T08:00:00Z' });
  agentState(home, 'sup-new', { provider: 'pi', title: 'Supervisor — newer run', cwd: wt2, lastActivityAt: '2026-09-16T08:00:00Z' });
  agentState(home, 'sup-other', { provider: 'slp-devin-supervisor', cwd: other, lastActivityAt: '2026-09-16T09:00:00Z' });
  const out = notebook(repo, home);
  assert.deepEqual(out.notebooks.map(n => n.agentId), ['sup-new', 'sup-old']);
  assert.equal(out.notebooks[0].notebookExists, false);
});

test('notebook records a gap for a supervisor cwd that is not a git work tree', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  const plain = mkdtempSync(join(tmpdir(), 'notebook-nogit-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  agentState(home, 'sup-broken', { provider: 'slp-devin-supervisor', cwd: plain });
  const out = notebook(repo, home);
  assert.deepEqual(out.notebooks, []);
  assert.equal(out.gaps.length, 1);
  assert.equal(out.gaps[0].agentId, 'sup-broken');
});

test('notebook rejects a repository that is not a git work tree', t => {
  const dir = mkdtempSync(join(tmpdir(), 'notebook-plain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  assert.throws(() => notebook(dir, home), /Not a git work tree/);
});

test('slp.mjs notebook emits locator output end to end', t => {
  const dir = fixture(t), home = join(dir, 'home'), repo = gitRepo(join(dir, 'repo'));
  agentState(home, 'sup', { provider: 'slp-devin-supervisor', cwd: repo, lastActivityAt: '2026-09-16T10:00:00Z' });
  const out = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/slp.mjs'), 'notebook', repo, '--paseo-home', home], { encoding: 'utf8' }));
  assert.equal(out.notebooks.length, 1);
  assert.equal(out.notebooks[0].notebook, join(repo, '.paseo-slp', 'notebook.md'));
});
