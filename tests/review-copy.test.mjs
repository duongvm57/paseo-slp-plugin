import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReviewCopy } from '../scripts/review-copy.mjs';
import { snapshot } from '../plugin/server/runtime/cli/package.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'slp-review-copy-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  const git = (...args) => execFileSync('git', ['-C', source, ...args]);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(source, 'kept'), 'initial\n');
  writeFileSync(join(source, 'removed'), 'old\n');
  writeFileSync(join(source, '.gitignore'), 'ignored/\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  return { root, source, git };
}

test('review copy retains the full ordinary work snapshot and probe writes cannot change source bytes', t => {
  const { root, source, git } = fixture(t);
  writeFileSync(join(source, 'kept'), 'changed\n'); chmodSync(join(source, 'kept'), 0o751);
  rmSync(join(source, 'removed'));
  writeFileSync(join(source, 'new name, with space'), 'untracked\n');
  writeFileSync(join(source, 'staged-new'), 'tracked but missing\n'); git('add', 'staged-new'); rmSync(join(source, 'staged-new'));
  symlinkSync('kept', join(source, 'link'));
  mkdirSync(join(source, 'ignored')); writeFileSync(join(source, 'ignored', 'dependency'), 'external\n');
  const pin = snapshot(source).sha256;
  const copy = prepareReviewCopy(source, pin, root);
  assert.equal(snapshot(copy.candidate).sha256, pin);
  assert.equal(snapshot(source).sha256, pin);
  assert.equal(readFileSync(join(copy.directory, 'copy.json'), 'utf8').includes(pin), true);
  assert.equal(readdirSync(copy.candidate).includes('ignored'), false);
  writeFileSync(join(copy.candidate, 'kept'), 'probe mutation\n');
  assert.equal(readFileSync(join(source, 'kept'), 'utf8'), 'changed\n');
  assert.equal(snapshot(source).sha256, pin);
  assert.notEqual(snapshot(copy.candidate).sha256, pin);
});

test('drift and in-repository allocation refuse without leaving a copy', t => {
  const { root, source } = fixture(t);
  const pin = snapshot(source).sha256;
  writeFileSync(join(source, 'kept'), 'drift\n');
  assert.throws(() => prepareReviewCopy(source, pin, root), /differs/);
  assert.throws(() => prepareReviewCopy(source, snapshot(source).sha256, source), /outside/);
  assert.deepEqual(readdirSync(root), ['source']);
});

test('nested repository candidates are an explicit materialization gap', t => {
  const { root, source } = fixture(t);
  const nested = join(source, 'nested'); mkdirSync(nested);
  execFileSync('git', ['init', '-q', nested]);
  writeFileSync(join(nested, 'untracked'), 'nested bytes\n');
  const pin = snapshot(source).sha256;
  assert.throws(() => prepareReviewCopy(source, pin, root), /nested repositories or gitlinks/);
  assert.deepEqual(readdirSync(root), ['source']);
});

test('gitlinks and unborn roots refuse before allocation', t => {
  const { root, source, git } = fixture(t);
  const oid = git('rev-parse', 'HEAD').toString().trim();
  git('update-index', '--add', '--cacheinfo', `160000,${oid},component`);
  assert.throws(() => prepareReviewCopy(source, snapshot(source).sha256, root), /gitlinks/);
  const unborn = join(root, 'unborn'); mkdirSync(unborn);
  execFileSync('git', ['init', '-q', unborn]);
  writeFileSync(join(unborn, 'untracked'), 'bytes\n');
  assert.throws(() => prepareReviewCopy(unborn, snapshot(unborn).sha256, root), /committed root/);
  assert.deepEqual(readdirSync(root).sort(), ['source', 'unborn']);
});

test('a directory replaced by a symlink cannot make materialization write outside the copy', t => {
  const { root, source, git } = fixture(t);
  mkdirSync(join(source, 'owned'));
  writeFileSync(join(source, 'owned', 'tracked'), 'tracked bytes\n');
  git('add', 'owned'); git('commit', '-qm', 'track directory');
  rmSync(join(source, 'owned'), { recursive: true });
  const external = join(root, 'external'); mkdirSync(external);
  writeFileSync(join(external, 'tracked'), 'external bytes\n');
  symlinkSync(external, join(source, 'owned'));
  const pin = snapshot(source).sha256;
  assert.throws(() => prepareReviewCopy(source, pin, root), /below a symlink/);
  assert.equal(readFileSync(join(external, 'tracked'), 'utf8'), 'external bytes\n');
  assert.equal(snapshot(source).sha256, pin);
  assert.deepEqual(readdirSync(root).sort(), ['external', 'source']);
});
