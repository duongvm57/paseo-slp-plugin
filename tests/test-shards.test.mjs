import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSuiteFiles, shardFiles } from '../scripts/test-suite.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = join(repo, 'scripts', 'test-isolated.mjs');
const verifier = join(repo, 'scripts', 'test-shards-verify.mjs');
const fixtures = join(repo, 'tests', 'fixtures', 'test-isolated');

// A throwaway Git repository holding the fixture tests, mirroring the
// test-isolated fixture pattern so shard runs and verifier measurements
// exercise real wrapper receipts end to end.
function fixtureRepo(t, names, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'slp-test-shards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'repo');
  mkdirSync(join(work, 'tests'), { recursive: true });
  for (const name of names) copyFileSync(join(fixtures, name), join(work, 'tests', name));
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(work, 'tests', name), content);
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', ...args], { stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
  return { root, work, records: join(root, 'records') };
}

function run(script, args, { env: extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.PASEO_HOME;
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env, cwd: repo });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const tiny = name => ({ [`${name}.test.mjs`]: `import test from 'node:test';\ntest('${name} works', () => {});\n` });

test('the default suite partition is disjoint, exhaustive and deterministic', () => {
  const suite = defaultSuiteFiles(repo);
  assert.ok(suite.length > 4, 'the real suite has enough files to shard');
  for (const of of [1, 2, 3, 4, 7]) {
    const shards = Array.from({ length: of }, (_, i) => shardFiles(repo, suite, i + 1, of));
    const union = shards.flat();
    assert.deepEqual(union.sort(), suite, `${of} shards cover the suite exactly once`);
    assert.equal(new Set(union).size, union.length, `${of} shards do not overlap`);
    assert.deepEqual(shardFiles(repo, suite, 1, of), shardFiles(repo, suite, 1, of), 'the partition is deterministic');
    for (const shard of shards) assert.ok(shard.length > 0, `no shard is empty at ${of}`);
  }
});

test('real shard receipts covering a fixture suite verify as full coverage', async t => {
  const names = ['alpha.mjs', 'beta.mjs', 'gamma.mjs', 'delta.mjs'];
  const { work, records } = fixtureRepo(t, [], Object.assign({}, ...names.map(tiny)));
  mkdirSync(records, { recursive: true });
  for (const index of [1, 2]) {
    const { code, stdout } = await run(wrapper, [`--shard=${index}/2`, `--slp-record=${records}/shard-${index}`],
      { env: { SLP_TEST_ISOLATED_ROOT: work } });
    assert.equal(code, 0, stdout);
  }
  const { code, stdout, stderr } = await run(verifier, [records, `--expect-node=${process.version}`, '--expect-count=2', `--repo=${work}`]);
  assert.equal(code, 0, stderr);
  const aggregate = JSON.parse(stdout);
  assert.equal(aggregate.verified, true);
  assert.equal(aggregate.count, 2);
  assert.equal(aggregate.files, names.length);
  assert.equal(aggregate.node, process.version);
  assert.match(aggregate.candidate.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(aggregate.shards.map(s => s.index), [1, 2]);
  assert.ok(aggregate.sumDurationMs > 0);
  for (const shard of aggregate.shards) assert.equal(shard.failed, 0);
});

for (const [label, mutate, reason] of [
  ['a missing shard', records => rmSync(join(records, 'shard-2'), { recursive: true, force: true }), /shard 2\/2 is missing/],
  ['an extra shard directory', records => { cpSync(join(records, 'shard-1'), join(records, 'shard-2-copy'), { recursive: true }); }, /expected 2 shard receipts, found 3/],
  ['a shard that claims the full-suite label', records => patch(records, 'shard-1', receipt => { receipt.selection = 'default-suite'; }), /selection is "default-suite", not "shard"/],
  ['a failing shard', records => patch(records, 'shard-1', receipt => { receipt.status = 'fail'; receipt.exitCode = 1; }), /status is "fail"/],
  ['a shard on the wrong node', records => patch(records, 'shard-1', receipt => { receipt.node = 'v99.0.0'; }), /node "v99\.0\.0" does not match/],
  ['a shard that ran foreign files', records => patch(records, 'shard-1', receipt => { receipt.files = ['tests/elsewhere.test.mjs']; }), /expected the \d+-file partition slice/],
  ['a shard on a different candidate', records => patch(records, 'shard-1', receipt => { receipt.candidate.after.sha256 = 'f'.repeat(64); }), /shards ran on different candidates/],
  ['a receipt whose argv hides a filter', records => patch(records, 'shard-1', receipt => { receipt.argv = [...receipt.files, '--test-name-pattern=x']; }), /argv is not exactly the shard slice/],
  ['a receipt with inconsistent counts', records => patch(records, 'shard-1', receipt => { receipt.counts.failed = 1; }), /passing coverage forbids failed\/cancelled\/skipped\/todo/],
  ['a receipt whose counts do not add up', records => patch(records, 'shard-1', receipt => { receipt.counts.passed += 1; }), /passed 3 != tests 2/],
  ['a receipt whose counts differ from its events', records => patch(records, 'shard-1', receipt => { receipt.counts.tests += 1; receipt.counts.passed += 1; }), /receipt counts differ from the events global summary/],
  ['a receipt hiding an omission as skipped', records => patch(records, 'shard-1', receipt => { receipt.counts.passed -= 1; receipt.counts.skipped += 1; }), /passed 1 != tests 2 — hidden omissions are not coverage/],
  ['a receipt hiding an omission as todo', records => patch(records, 'shard-1', receipt => { receipt.counts.passed -= 1; receipt.counts.todo += 1; }), /passed 1 != tests 2 — hidden omissions are not coverage/],
  ['an unstable candidate pin', records => patch(records, 'shard-1', receipt => { receipt.candidate.stable = false; }), /candidate pins are not one stable pin/],
  ['a shard whose pinned log is missing', records => rmSync(join(records, 'shard-1', 'test.log')), /test\.log is missing or its hash differs/],
  ['a shard whose pinned log hash differs', records => appendFileSync(join(records, 'shard-1', 'test.log'), 'tampered\n'), /test\.log is missing or its hash differs/],
  ['a shard whose events hash differs', records => appendFileSync(join(records, 'shard-1', 'events.jsonl'), 'tampered\n'), /events\.jsonl is missing or its hash differs/],
  ['a shard whose events carry a foreign file summary', records => rewriteEvents(records, 'shard-1', lines => {
    lines.push(JSON.stringify({ type: 'test:summary', name: 'foreign', nesting: 0, file: '/elsewhere/foreign.test.mjs', counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 }, success: true }));
  }), /outside the repository's tests\/ directory/],
  ['a shard whose events miss a per-file summary', records => rewriteEvents(records, 'shard-1', lines => {
    const at = lines.findIndex(line => { const event = JSON.parse(line); return event.type === 'test:summary' && event.file; });
    lines.splice(at, 1);
  }), /events carry 0 summaries for tests\//],
  ['a shard whose events duplicate a per-file summary', records => rewriteEvents(records, 'shard-1', lines => {
    const at = lines.findIndex(line => { const event = JSON.parse(line); return event.type === 'test:summary' && event.file; });
    lines.splice(at + 1, 0, lines[at]);
  }), /events carry 2 summaries for tests\//],
  ['a shard whose events are malformed', records => rewriteEvents(records, 'shard-1', lines => { lines.push('not-json'); }), /events\.jsonl line \d+ is malformed/],
  ['a shard whose events lost the global summary', records => rewriteEvents(records, 'shard-1', lines => {
    const at = lines.findIndex(line => { const event = JSON.parse(line); return event.type === 'test:summary' && !event.file; });
    lines.splice(at, 1);
  }), /events carry 0 global summaries/],
]) {
  test(`the verifier fails closed on ${label}`, async t => {
    const names = ['alpha.mjs', 'beta.mjs', 'gamma.mjs', 'delta.mjs'];
    const { work, records } = fixtureRepo(t, [], Object.assign({}, ...names.map(tiny)));
    mkdirSync(records, { recursive: true });
    for (const index of [1, 2]) {
      const { code } = await run(wrapper, [`--shard=${index}/2`, `--slp-record=${records}/shard-${index}`],
        { env: { SLP_TEST_ISOLATED_ROOT: work } });
      assert.equal(code, 0);
    }
    mutate(records);
    const { code, stderr } = await run(verifier, [records, `--expect-node=${process.version}`, '--expect-count=2', `--repo=${work}`]);
    assert.equal(code, 1, stderr);
    assert.match(stderr, reason, 'the specific violation is named, not just any failure');
  });
}

function patch(records, shard, apply) {
  const path = join(records, shard, 'receipt.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  apply(receipt);
  writeFileSync(path, JSON.stringify(receipt, null, 2));
}

function rewriteEvents(records, shard, mutate) {
  const path = join(records, shard, 'events.jsonl');
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  mutate(lines);
  writeFileSync(path, `${lines.join('\n')}\n`);
  patch(records, shard, receipt => {
    receipt.events.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  });
}

test('the verifier demands its inputs', async t => {
  const { root } = fixtureRepo(t, ['pass.mjs']);
  for (const args of [
    [],
    [join(root, 'records')],
    [join(root, 'records'), '--expect-count=2'],
    [join(root, 'records'), `--expect-node=${process.version}`],
  ]) {
    const { code, stderr } = await run(verifier, args);
    assert.equal(code, 2);
    assert.match(stderr, /test-shards-verify/);
    assert.ok(!stderr.includes(' at '), 'no stack trace');
  }
});

test('the gate script fails the required check by name on every non-success result', async t => {
  const gate = join(repo, 'scripts', 'test-shards-gate.mjs');
  const success = await run(gate, ['success']);
  assert.equal(success.code, 0, success.stderr);
  assert.match(success.stdout, /success/);
  for (const result of ['failure', 'cancelled', 'skipped', 'unknown-state', '']) {
    const outcome = await run(gate, [result]);
    assert.equal(outcome.code, 1, `result ${JSON.stringify(result)} must fail the gate`);
    assert.match(outcome.stderr, /fails closed/);
  }
  const missing = await run(gate, []);
  assert.equal(missing.code, 1, 'a missing needs result must fail the gate');
});

test('the workflow keeps the required check fail-closed by name', () => {
  const workflow = readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
  const validate = workflow.slice(workflow.indexOf('\n  validate:'));
  assert.match(workflow, /SHARD_COUNT: '4'/, 'one declared shard count');
  assert.match(workflow, /shard: \[1, 2, 3, 4\]/, 'the shard matrix lists exactly 1..SHARD_COUNT');
  assert.ok(!/22\.18\.0/.test(workflow), 'the retired Node 22 leg is gone');
  assert.match(validate, /needs: test-shard/, 'validate waits for every shard');
  assert.match(validate, /if: \$\{\{ !cancelled\(\) \}\}/, 'validate runs even on failed/cancelled/skipped needs');
  assert.match(validate, /test-shards-gate\.mjs "\$\{\{ needs\.test-shard\.result \}\}"/, 'the wired gate consumes the actual needs result');
  assert.match(validate, /node-version: \$\{\{ matrix\.node \}\}/, 'the check name stays validate (24) via the matrix');
  assert.match(validate, /node: \['24'\]/, 'Node 24 is the only validate leg');
  assert.match(validate, /test-shards-verify\.mjs/, 'the coverage gate runs before typecheck/check/payload');
});
