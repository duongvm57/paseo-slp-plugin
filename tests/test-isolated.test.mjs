import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSuiteFiles, shardFiles } from '../scripts/test-suite.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = join(repo, 'scripts', 'test-isolated.mjs');
const fixtures = join(repo, 'tests', 'fixtures', 'test-isolated');

// A throwaway Git repository holding the fixture tests; the wrapper is pointed at it.
function fixtureRepo(t, names, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'slp-test-isolated-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'repo');
  mkdirSync(join(work, 'tests'), { recursive: true });
  for (const name of names) copyFileSync(join(fixtures, name), join(work, 'tests', name));
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(work, 'tests', name), content);
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', ...args], { stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
  return { root, work, record: join(root, 'record') };
}

function run(work, args, { onSpawn, detached = false, env: extraEnv = {} } = {}) {
  const env = { ...process.env, SLP_TEST_ISOLATED_ROOT: work, ...extraEnv };
  delete env.PASEO_HOME;
  return new Promise(resolve => {
    const child = spawn(process.execPath, [wrapper, ...args], { env, cwd: repo, detached });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    onSpawn?.(child);
  });
}
const receiptOf = dir => JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, what) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 100)); }
  assert.fail(`timed out waiting for ${what}`);
}

// Waits for hang.mjs to publish its pids, and kills whatever is left at the end.
async function started(t, work) {
  const pidFile = join(work, 'pids.json');
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('}'), 'the fixture to start');
  const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
  t.after(() => { for (const pid of [pids.runner, pids.self, pids.grandchild]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  return pids;
}

test('record mode pins the candidate, environment and log in an atomic receipt', async t => {
  const { work, record } = fixtureRepo(t, ['pass.mjs']);
  const { code, stdout } = await run(work, [`--slp-record=${record}`, 'tests/pass.mjs']);
  assert.equal(code, 0, stdout);
  const receipt = receiptOf(record);
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.candidate.stable, true);
  assert.equal(receipt.candidate.before.sha256, receipt.candidate.after.sha256);
  assert.match(receipt.candidate.after.sha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.candidate.after.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(receipt.argv, ['tests/pass.mjs']);
  assert.deepEqual(receipt.files, ['tests/pass.mjs']);
  assert.equal(receipt.node, process.version);
  assert.equal(receipt.platform.platform, process.platform);
  assert.ok(receipt.platform.cpus > 0);
  assert.equal(receipt.load.start.length, 3);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.signal, null);
  assert.deepEqual(receipt.counts, { tests: 3, passed: 2, failed: 0, cancelled: 0, skipped: 1, todo: 0 });
  assert.deepEqual(receipt.failures, []);
  const log = readFileSync(join(record, 'test.log'));
  assert.ok(log.includes('fixture passes'));
  assert.equal(receipt.log.sha256, execFileSync('sha256sum', [join(record, 'test.log')]).toString().split(' ')[0]);
  assert.ok(stdout.includes(receipt.log.sha256));
  assert.ok(stdout.includes(join(record, 'receipt.json')));
  assert.deepEqual(readdirSync(record).filter(n => n.endsWith('.tmp')), [], 'no temp file is left behind');
  assert.equal(receipt.events.sha256, execFileSync('sha256sum', [join(record, 'events.jsonl')]).toString().split(' ')[0]);
  assert.equal(receipt.selection, 'partial');
});

test('a failing run forwards node\'s exit code and the summary names the failing test with file:line', async t => {
  const { work, record } = fixtureRepo(t, ['fail.mjs']);
  const { code, stdout } = await run(work, [`--slp-record=${record}`, 'tests/fail.mjs']);
  assert.equal(code, 1);
  assert.match(stdout, /tests\/fail\.mjs:\d+ fixture fails on purpose/);
  assert.match(stdout, /test-isolated: fail/);
  assert.ok(stdout.split('\n').length <= 40);
  const receipt = receiptOf(record);
  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.counts.failed, 1);
  assert.deepEqual(receipt.failures.map(f => [f.file, f.name]), [['tests/fail.mjs', 'fixture fails on purpose']]);
  assert.ok(Number.isInteger(receipt.failures[0].line));
});

test('without a record flag the wrapper forwards the exit code and prints nothing extra', async t => {
  const { work } = fixtureRepo(t, ['fail.mjs', 'pass.mjs']);
  const failing = await run(work, ['tests/fail.mjs']);
  assert.equal(failing.code, 1);
  assert.ok(!failing.stdout.includes('test-isolated:'));
  const passing = await run(work, ['tests/pass.mjs']);
  assert.equal(passing.code, 0);
  assert.ok(!existsSync(join(work, 'receipt.json')));
});

test('a long fail list is truncated in the summary and kept whole in the receipt', async t => {
  const body = Array.from({ length: 60 }, (_, i) => `test('many ${i}', () => assert.fail('x'));`).join('\n');
  const { work, record } = fixtureRepo(t, [], { 'many.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n` });
  const { code, stdout } = await run(work, [`--slp-record=${record}`, 'tests/many.mjs']);
  assert.equal(code, 1);
  assert.ok(stdout.split('\n').length <= 40, stdout);
  assert.match(stdout, /45 more not shown \(truncated/);
  assert.equal(receiptOf(record).failures.length, 60);
});

test('baseline comparison lists new, fixed and unchanged failures and warns about different pins', async t => {
  const { work, record } = fixtureRepo(t, ['flaky.mjs']);
  writeFileSync(join(work, 'gone'), '');
  const first = await run(work, [`--slp-record=${record}-1`, 'tests/flaky.mjs']);
  assert.equal(first.code, 1);
  rmSync(join(work, 'gone'));
  writeFileSync(join(work, 'fresh'), '');
  const second = await run(work, [`--slp-record=${record}-2`, `--slp-baseline=${record}-1/receipt.json`, '--test-concurrency=1', 'tests/flaky.mjs']);
  assert.equal(second.code, 1, 'exit code stays node\'s own');
  const { baseline } = receiptOf(`${record}-2`);
  assert.deepEqual(baseline.added.map(k => k.split(' ').slice(1).join(' ')), ['fresh failure']);
  assert.deepEqual(baseline.fixed.map(k => k.split(' ').slice(1).join(' ')), ['gone failure']);
  assert.deepEqual(baseline.kept.map(k => k.split(' ').slice(1).join(' ')), ['kept failure']);
  assert.ok(baseline.warnings.includes('argv differs'));
  assert.ok(baseline.warnings.includes('candidate snapshot differs from the baseline'));
  assert.match(second.stdout, /baseline: 1 new, 1 fixed, 1 unchanged/);
  assert.match(second.stdout, /baseline WARNING: argv differs/);
});

test('an unreadable baseline is recorded in the receipt and does not change the exit code', async t => {
  const { work, record } = fixtureRepo(t, ['pass.mjs']);
  const { code, stdout } = await run(work, [`--slp-record=${record}`, `--slp-baseline=${record}/nope.json`, 'tests/pass.mjs']);
  assert.equal(code, 0);
  assert.match(stdout, /baseline: baseline receipt is unreadable/);
  const { baseline } = receiptOf(record);
  assert.equal(baseline.path, join(record, 'nope.json'));
  assert.match(baseline.error, /unreadable/);
});

test('--slp-baseline without --slp-record is a usage error', async t => {
  const { work } = fixtureRepo(t, ['pass.mjs']);
  const { code, stderr } = await run(work, ['--slp-baseline=/nowhere.json', 'tests/pass.mjs']);
  assert.equal(code, 2);
  assert.match(stderr, /requires --slp-record/);
});

const tiny = name => ({ [`${name}.test.mjs`]: `import test from 'node:test';\ntest('${name} works', () => {});\n` });

test('--shard runs one deterministic slice of the default suite and labels the receipt "shard"', async t => {
  const names = ['alpha.mjs', 'beta.mjs', 'gamma.mjs', 'delta.mjs', 'epsilon.mjs'];
  const extra = Object.assign({}, ...names.map(tiny));
  const { work, record } = fixtureRepo(t, [], extra);
  const first = await run(work, [`--shard=1/2`, `--slp-record=${record}-1`]);
  const second = await run(work, [`--shard=2/2`, `--slp-record=${record}-2`]);
  assert.equal(first.code, 0, first.stdout);
  assert.equal(second.code, 0, second.stdout);
  const suite = defaultSuiteFiles(work);
  const [firstShard, secondShard] = [1, 2].map(index => shardFiles(work, suite, index, 2));
  for (const [receiptDir, expected, index] of [[`${record}-1`, firstShard, 1], [`${record}-2`, secondShard, 2]]) {
    const receipt = receiptOf(receiptDir);
    assert.equal(receipt.selection, 'shard', 'a slice never claims the full-suite label');
    assert.deepEqual(receipt.shard, { index, of: 2 });
    assert.deepEqual(receipt.files, expected);
    assert.deepEqual(receipt.argv, expected);
    assert.equal(receipt.status, 'pass');
  }
  assert.deepEqual([...firstShard, ...secondShard].sort(), suite, 'the two shards cover the suite exactly once');
  const repeat = await run(work, [`--shard=1/2`, `--slp-record=${record}-3`]);
  assert.equal(repeat.code, 0);
  assert.deepEqual(receiptOf(`${record}-3`).files, firstShard, 'the partition is deterministic');
  const capped = await run(work, [`--shard=2/2`, '--test-concurrency=1', `--slp-record=${record}-4`]);
  assert.equal(capped.code, 0, capped.stdout);
  const cappedReceipt = receiptOf(`${record}-4`);
  assert.deepEqual(cappedReceipt.files, secondShard);
  assert.deepEqual(cappedReceipt.argv, ['--test-concurrency=1', ...secondShard], 'the concurrency cap rides along in argv');
});

test('--shard refuses other arguments and malformed specs without running anything', async t => {
  const { work, record } = fixtureRepo(t, ['pass.mjs']);
  for (const argv of [
    ['--shard=1/2', 'tests/pass.mjs'],
    ['--shard=1/2', '--test-name-pattern=pass'],
    ['--shard=0/2'],
    ['--shard=3/2'],
    ['--shard=x'],
    ['--shard=1/'],
  ]) {
    const { code, stderr } = await run(work, argv);
    assert.equal(code, 2, `${argv.join(' ')} must be a usage error`);
    assert.match(stderr, /--shard/);
    assert.ok(!stderr.includes(' at '), 'no stack trace');
  }
  assert.ok(!existsSync(record), 'no receipt was written');
});

test('the reporter role never depends on the environment: a marker variable cannot skip a failing run', async t => {
  const { work, record } = fixtureRepo(t, ['fail.mjs']);
  for (const flags of [[], [`--slp-record=${record}`]]) {
    const { code } = await run(work, [...flags, 'tests/fail.mjs'], { env: { SLP_TEST_ISOLATED_REPORTER: '1' } });
    assert.equal(code, 1);
  }
  assert.equal(receiptOf(record).counts.failed, 1);
});

test('record mode forwards argv verbatim: a filter after the file gives the same counts in both modes', async t => {
  const { work, record } = fixtureRepo(t, ['pass.mjs']);
  const argv = ['tests/pass.mjs', '--test-name-pattern=also'];
  const plain = await run(work, argv);
  const recorded = await run(work, [`--slp-record=${record}`, ...argv]);
  const fromText = Number(/ℹ tests (\d+)/.exec(plain.stdout)?.[1]);
  const receipt = receiptOf(record);
  assert.ok(fromText > 0);
  assert.equal(receipt.counts.tests, fromText);
  assert.deepEqual(receipt.argv, argv);
  assert.equal(recorded.code, plain.code);
});

test('selection is default-suite only when the wrapper forwards no argument at all', async t => {
  const { work, record } = fixtureRepo(t, [], { 'one.test.mjs': "import test from 'node:test';\ntest('t', () => {});\n" });
  const selection = async (...args) => { await run(work, [`--slp-record=${record}`, ...args]); return receiptOf(record).selection; };
  assert.equal(await selection(), 'default-suite');
  assert.equal(await selection('--test-concurrency=2'), 'partial');
  assert.equal(await selection('tests/one.test.mjs'), 'partial');
  for (const flag of ['--test-name-pattern=t', '--test-name-pattern', '--test-skip-pattern=t', '--test-only', '--test-shard=1/2', '--test-rerun-failures=state.json']) {
    assert.equal(await selection(flag), 'partial', flag);
  }
  assert.match((await run(work, [`--slp-record=${record}`])).stdout, /selection: default-suite/);
});

test('fail closed: the test runner dying leaves an invalid receipt and a non-zero exit', async t => {
  const { work, record } = fixtureRepo(t, ['crash.mjs']);
  const { code } = await run(work, [`--slp-record=${record}`, 'tests/crash.mjs']);
  const receipt = receiptOf(record);
  assert.equal(receipt.status, 'invalid');
  assert.equal(receipt.counts, null);
  assert.notEqual(code, 0);
});

test('fail closed: a candidate that changes during the run is invalid even when node exits 0', async t => {
  const { work, record } = fixtureRepo(t, ['drift.mjs']);
  const { code, stdout } = await run(work, [`--slp-record=${record}`, 'tests/drift.mjs']);
  const receipt = receiptOf(record);
  assert.equal(receipt.candidate.stable, false);
  assert.notEqual(receipt.candidate.before.sha256, receipt.candidate.after.sha256);
  assert.equal(receipt.status, 'invalid');
  assert.match(receipt.reason, /candidate changed/);
  assert.equal(receipt.exitCode, 0, 'node itself exited 0');
  assert.notEqual(code, 0, stdout);
});

test('a pass receipt from an earlier run does not survive a wrapper killed before it writes its own', { timeout: 30000 }, async t => {
  const { work, record } = fixtureRepo(t, ['hang.mjs']);
  mkdirSync(record);
  writeFileSync(join(record, 'receipt.json'), JSON.stringify({ status: 'pass' }));
  let wrapperChild;
  const done = run(work, [`--slp-record=${record}`, 'tests/hang.mjs'], { onSpawn: c => { wrapperChild = c; } });
  const pids = await started(t, work);
  wrapperChild.kill('SIGKILL');
  await done;
  rmSync(pids.home, { recursive: true, force: true });
  assert.ok(!existsSync(join(record, 'receipt.json')) || receiptOf(record).status !== 'pass');
});

for (const [label, make] of [
  ['a missing parent directory', root => join(root, 'missing', 'rec')],
  ['a dangling symlink', root => { symlinkSync(join(root, 'nowhere'), join(root, 'link')); return join(root, 'link'); }],
]) {
  test(`record dir with ${label} is a short usage error and writes nothing`, async t => {
    const { root, work } = fixtureRepo(t, ['pass.mjs']);
    const target = make(root);
    const { code, stderr } = await run(work, [`--slp-record=${target}`, 'tests/pass.mjs']);
    assert.equal(code, 2);
    assert.match(stderr, /--slp-record parent directory does not exist or is a dangling link/);
    assert.ok(!stderr.includes(' at '), 'no stack trace');
    assert.ok(!existsSync(join(root, 'missing')) && !existsSync(join(root, 'nowhere')));
  });
}

test('a record directory inside the repository is refused', async t => {
  const { work } = fixtureRepo(t, ['pass.mjs']);
  const { code, stderr } = await run(work, [`--slp-record=${join(work, 'rec')}`, 'tests/pass.mjs']);
  assert.equal(code, 2);
  assert.match(stderr, /outside the repository/);
});

for (const recording of [true, false]) {
  test(`signal cleanup (${recording ? 'record' : 'default'} mode): child, grandchild and temp home are gone`, { timeout: 30000 }, async t => {
    const { work, record } = fixtureRepo(t, ['hang.mjs']);
    const flags = recording ? [`--slp-record=${record}`] : [];
    let wrapperChild;
    const done = run(work, [...flags, 'tests/hang.mjs'], { onSpawn: c => { wrapperChild = c; } });
    const pids = await started(t, work);
    assert.ok(existsSync(pids.home));
    assert.ok(alive(pids.grandchild));
    wrapperChild.kill('SIGTERM'); // only the wrapper pid; the caller's group is not signalled
    const { code } = await done;
    assert.equal(code, 143);
    await until(() => ![pids.runner, pids.self, pids.grandchild].some(alive), 'descendants to exit');
    assert.ok(!existsSync(pids.home), 'temporary PASEO_HOME is removed');
    if (recording) {
      const receipt = receiptOf(record);
      assert.equal(receipt.status, 'interrupted');
      assert.equal(receipt.signal, 'SIGTERM');
      assert.equal(receipt.exitCode, 143);
    }
  });
}

test('SIGKILL to the wrapper\'s process group leaves no runner, grandchild or test process', { timeout: 30000 }, async t => {
  const { work, record } = fixtureRepo(t, ['hang.mjs']);
  let wrapperChild;
  const done = run(work, [`--slp-record=${record}`, 'tests/hang.mjs'], { detached: true, onSpawn: c => { wrapperChild = c; } });
  const pids = await started(t, work);
  process.kill(-wrapperChild.pid, 'SIGKILL'); // the way a host timeout kills a shell job
  await done;
  await until(() => ![pids.runner, pids.self, pids.grandchild].some(alive), 'descendants to exit after a group SIGKILL');
  rmSync(pids.home, { recursive: true, force: true }); // a killed wrapper cannot remove it; documented limit
});
