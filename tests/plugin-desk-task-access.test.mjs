import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createTaskRepositoryAccess, TaskRepositoryMismatchError } from '../plugin/server/desk-task-access.ts';
import { repoKeyFor } from '../plugin/server/runtime/desk-paths.ts';

const identity = path => createHash('sha256').update(path).digest('hex').slice(0, 12);

function rejectsDifferentRepository(expected, actual, expectedName = basename(dirname(expected)), actualName = basename(dirname(actual))) {
  return error => {
    assert.match(error.message, /different Git repository/);
    assert.ok(error.message.includes(`expected repo ${JSON.stringify(expectedName)} (${identity(expected)})`));
    assert.ok(error.message.includes(`actual repo ${JSON.stringify(actualName)} (${identity(actual)})`));
    assert.ok(error.message.length <= 240, 'both identities fit the bridge diagnostic bound');
    assert.equal(error.message.includes(expected), false);
    assert.equal(error.message.includes(actual), false);
    return true;
  };
}

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
  await assert.rejects(createTaskRepositoryAccess({ ...f.input, checkoutRoots: [foreign] }),
    rejectsDifferentRepository(f.input.repo.gitCommonDir, realpathSync(join(foreign, '.git'))));
  assert.equal(existsSync(join(f.stableRoot, 'task-exec')), false);
  assert.equal(readFileSync(join(foreign, 'sentinel'), 'utf8'), 'prior\n');
});

for (const useWorktree of [false, true]) {
  test(`nested Git repository${useWorktree ? ' worktree' : ''} is rejected before allocating task scratch`, async t => {
    const f = fixture(t), nested = join(f.repository, 'nested');
    mkdirSync(nested);
    const git = (...args) => execFileSync('git', ['-C', nested, ...args], { stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(nested, 'sentinel'), 'prior\n');
    let checkout = nested;
    if (useWorktree) {
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
      checkout = join(f.root, 'nested-lane');
      git('worktree', 'add', '--detach', checkout, 'HEAD');
    }
    await assert.rejects(createTaskRepositoryAccess({ ...f.input, checkoutRoots: [checkout] }),
      rejectsDifferentRepository(f.input.repo.gitCommonDir, realpathSync(join(nested, '.git'))));
    assert.equal(existsSync(join(f.stableRoot, 'task-exec')), false);
    assert.equal(readFileSync(join(checkout, 'sentinel'), 'utf8'), 'prior\n');
  });
}

test('repository mismatch diagnostics bound identities without exposing credential-shaped path bytes', async t => {
  const f = fixture(t), secret = 'ghp_' + 'x'.repeat(40);
  const expected = `/private/${secret}/${'expected'.repeat(1000)}/.git`;
  const actual = `/private/${secret}/${'actual'.repeat(1000)}/.git`;
  const repo = { hostId: 'local', gitCommonDir: expected };
  await assert.rejects(createTaskRepositoryAccess({ ...f.input, repo, repoKey: repoKeyFor(repo) }, {
    commonDir: async () => actual,
    top: async () => assert.fail('foreign repository must not expand access'),
  }), error => {
    rejectsDifferentRepository(expected, actual, 'expected'.repeat(3), 'actual'.repeat(4))(error);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(existsSync(join(f.stableRoot, 'task-exec')), false);
});

test('repository diagnostics distinguish identical checkout names by their short Git identity', () => {
  const expected = '/first/project/.git', actual = '/second/project/.git';
  const error = new TaskRepositoryMismatchError(expected, actual);
  rejectsDifferentRepository(expected, actual)(error);
  assert.notEqual(identity(expected), identity(actual));
});

test('bare and nonstandard Git metadata names remain display hints without changing identity', () => {
  const expected = '/first/source.git', actual = '/second/custom-metadata';
  rejectsDifferentRepository(expected, actual, 'source.git', 'custom-metadata')(
    new TaskRepositoryMismatchError(expected, actual));
});

test('repository labels redact credentials before truncation and strip controls and line separators', () => {
  const secret = 'ghp_' + 'x'.repeat(40);
  for (const name of [secret, 'ghp_\u200b' + 'x'.repeat(40), 'Bearer\t' + 'x'.repeat(40)]) {
    const expected = `/first/${name}/.git`, actual = '/second/re\u0000po\u202e\u2028\u2029/.git';
    const error = new TaskRepositoryMismatchError(expected, actual);
    rejectsDifferentRepository(expected, actual, '<redacted>', 'repo')(error);
    assert.equal(error.message.includes('x'.repeat(20)), false);
    assert.doesNotMatch(error.message, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  }
});

test('escaped and astral labels keep both identities inside the bridge message bound', () => {
  for (const name of ['"\\'.repeat(1000), '😀'.repeat(1000)]) {
    const expected = `/first/${name}/.git`, actual = `/second/${name}/.git`;
    const label = Array.from(name).slice(0, 24).join('');
    rejectsDifferentRepository(expected, actual, label, label)(new TaskRepositoryMismatchError(expected, actual));
  }
  rejectsDifferentRepository('/first/\u0000/.git', '/second/\u202e/.git', 'unknown', 'unknown')(
    new TaskRepositoryMismatchError('/first/\u0000/.git', '/second/\u202e/.git'));
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
