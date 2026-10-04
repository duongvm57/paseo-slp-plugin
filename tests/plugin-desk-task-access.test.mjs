import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskRepositoryAccess } from '../plugin/server/desk-task-access.ts';
import { repoKeyFor } from '../plugin/server/runtime/desk-paths.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'slp-task-access-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repo'), stableRoot = join(root, 'state');
  mkdirSync(repository); mkdirSync(stableRoot);
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repository, 'owned'), 'base\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  const repo = { hostId: 'local', gitCommonDir: realpathSync(join(repository, '.git')) };
  return { root, repository, stableRoot, git, input: { repo, repoKey: repoKeyFor(repo), createCwd: repository, stableRoot } };
}

test('qualified worktrees share repository access while scratch stays confined to its private namespace', async t => {
  const f = fixture(t), worktree = join(f.root, 'lane');
  f.git('worktree', 'add', '--detach', worktree, 'HEAD');
  const access = await createTaskRepositoryAccess({ ...f.input, checkoutRoots: [worktree] });
  assert.equal(access.fs.readFile(join(worktree, 'owned')).toString(), 'base\n');
  access.fs.writeFile(join(access.privateRoot, 'proof'), Buffer.from('proof'), 0o600);
  assert.equal(statSync(access.privateRoot).mode & 0o777, 0o700);
  assert.throws(() => access.fs.writeFile(join(f.stableRoot, 'receipt.json'), Buffer.from('overwrite'), 0o600), /ESCAPED_ROOT/);
  assert.throws(() => access.fs.writeFile(join(f.stableRoot, 'task-exec', 'other-repo', 'proof'), Buffer.from('overwrite'), 0o600), /ESCAPED_ROOT/);
});

test('foreign checkout is rejected before allocating task scratch or modifying its bytes', async t => {
  const f = fixture(t), foreign = join(f.root, 'foreign');
  mkdirSync(foreign); execFileSync('git', ['init', '-q', foreign]); writeFileSync(join(foreign, 'sentinel'), 'prior\n');
  await assert.rejects(createTaskRepositoryAccess({ ...f.input, checkoutRoots: [foreign] }), /outside the bound repository/);
  assert.equal(existsSync(join(f.stableRoot, 'task-exec')), false);
  assert.equal(readFileSync(join(foreign, 'sentinel'), 'utf8'), 'prior\n');
});

test('a symlinked task namespace cannot redirect private artifacts to another root', async t => {
  const f = fixture(t), outside = join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.stableRoot, 'task-exec'));
  await assert.rejects(createTaskRepositoryAccess(f.input), /symlink|real directory/);
  assert.equal(existsSync(join(outside, f.input.repoKey)), false);
});

test('a mismatched repository key cannot allocate a namespace', async t => {
  const f = fixture(t);
  await assert.rejects(createTaskRepositoryAccess({ ...f.input, repoKey: '0'.repeat(64) }), /does not match its binding/);
  assert.equal(existsSync(join(f.stableRoot, 'task-exec')), false);
});
