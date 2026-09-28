// verify-handback-cli.test.mjs — the verb facade: flag wiring, exit codes,
// stdout/stderr discipline, and the old-runtime unknown-command behavior
// (caller-side CapabilityGap, per contract §8). Engine semantics live in
// tests/candidate-verify.test.mjs; this suite only proves the facade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, snapshot } from '../src/package.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(PKG, 'bin', 'slp.mjs');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const run = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  mkdirSync(repo);
  mkdirSync(join(home, 'agents'), { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'cli@example.test']);
  git(repo, ['config', 'user.name', 'CLI Test']);
  writeFileSync(join(repo, 'CONTRACT.md'), 'contract bytes\n');
  writeFileSync(join(repo, 'pin.txt'), 'pin bytes\n');
  writeFileSync(join(repo, 'extra.txt'), 'extra bytes\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'seed']);
  const contractSha = hash(readFileSync(join(repo, 'CONTRACT.md')));
  const pinSha = hash(readFileSync(join(repo, 'pin.txt')));
  const extraSha = hash(readFileSync(join(repo, 'extra.txt')));
  const snap = snapshot(repo);
  const record = {
    version: 1, kind: 'handback',
    seat: { role: 'peer', disposition: 'Engineer' },
    verdict: 'APPROVE',
    candidate: { repository: repo, snapshotSha256: snap.sha256 },
    checks: [],
  };
  const report = join(dir, 'report.md');
  writeFileSync(report, `# report\n\n\`\`\`slp-record\n${JSON.stringify(record)}\n\`\`\`\n`);
  return { dir, repo, home, report, contractSha, pinSha, extraSha, snap };
}

test('verify-handback prints the view on stdout, exit 0, silent stderr', t => {
  const w = world(t);
  const res = run(['verify-handback', w.report, '--repo', w.repo, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--paseo-home', w.home]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  const view = JSON.parse(res.stdout);
  assert.equal(view.kind, 'slp-verify-handback');
  assert.equal(view.summary, 'match');
  assert.equal(view.input.repo, w.repo);
});

test('verify-handback wires --expect-file repeats, --expect-parent/--expect-workspace', t => {
  const w = world(t);
  const res = run(['verify-handback', w.report, '--repo', w.repo, '--expect-contract', `CONTRACT.md=${w.contractSha}`,
    '--expect-file', `pin.txt=${w.pinSha}`, '--expect-file', `extra.txt=${w.extraSha}`,
    '--expect-parent', 'lead-1', '--expect-workspace', 'wks_9', '--paseo-home', w.home]);
  assert.equal(res.status, 0, res.stderr);
  const view = JSON.parse(res.stdout);
  assert.equal(view.pins.length, 2);
  assert.equal(view.pins[0].result, 'match');
  assert.equal(view.input.expect.files, 2);
  assert.equal(view.input.expect.parent, 'lead-1');
  assert.equal(view.input.expect.workspace, 'wks_9');
});

test('mismatch is data: a divergent claim still exits 0 with a view', t => {
  const w = world(t);
  writeFileSync(join(w.repo, 'untracked.txt'), 'dirty\n'); // snapshot changes
  const res = run(['verify-handback', w.report, '--repo', w.repo, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--paseo-home', w.home]);
  assert.equal(res.status, 0, res.stderr);
  const view = JSON.parse(res.stdout);
  assert.equal(view.candidate.snapshotSha256.result, 'mismatch');
  assert.equal(view.summary, 'mismatch');
});

test('missing --expect-contract is INVALID_REQUEST: stderr typed, stdout empty', t => {
  const w = world(t);
  const res = run(['verify-handback', w.report, '--repo', w.repo, '--paseo-home', w.home]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^INVALID_REQUEST: /);
});

test('missing --repo is INVALID_REQUEST', t => {
  const w = world(t);
  const res = run(['verify-handback', w.report, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--paseo-home', w.home]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^INVALID_REQUEST: /);
});

test('parser keeps its existing messages: repeated option, unknown flag, flag not valid for command', t => {
  const w = world(t);
  const repeated = run(['verify-handback', w.report, '--repo', w.repo, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--paseo-home', w.home]);
  assert.equal(repeated.status, 1);
  assert.equal(repeated.stdout, '');
  assert.match(repeated.stderr, /Repeated option --expect-contract/);
  const foreign = run(['verify-handback', w.report, '--repo', w.repo, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--paseo-home', w.home, '--kind', 'handback']);
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /--kind is not valid for verify-handback/);
  const unknown = run(['verify-handback', w.report, '--repo', w.repo, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--paseo-home', w.home, '--bogus']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown flag --bogus/);
});

test('missing report positional is a parser error; a bad pin value is INVALID_REQUEST', t => {
  const w = world(t);
  const noTarget = run(['verify-handback', '--repo', w.repo, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--paseo-home', w.home]);
  assert.equal(noTarget.status, 1);
  assert.match(noTarget.stderr, /requires <report>/);
  const badPin = run(['verify-handback', w.report, '--repo', w.repo, '--expect-contract', 'no-equals-sign', '--paseo-home', w.home]);
  assert.equal(badPin.status, 1);
  assert.equal(badPin.stdout, '');
  assert.match(badPin.stderr, /^INVALID_REQUEST: /);
});

test('PATH without git is CAPABILITY_GAP — preflight proves the host tool', t => {
  const w = world(t);
  const emptyBin = join(w.dir, 'empty-bin');
  mkdirSync(emptyBin);
  const res = run(['verify-handback', w.report, '--repo', w.repo, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--paseo-home', w.home],
    { PATH: emptyBin });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^CAPABILITY_GAP: /);
});

test('a nested git failure inside snapshot() after preflight is IO_FAILURE', t => {
  // C-S3 — preflight passes on real git; the failing producer is a git
  // nested inside snapshot(): the parent lists `sub/` as an untracked nested
  // root, snapshot() descends, and the inner git dies on the corrupt config.
  // Real fixture, no seam: a child-producer error must surface IO_FAILURE.
  const w = world(t);
  const sub = join(w.repo, 'sub');
  mkdirSync(sub);
  git(sub, ['init', '-q']);
  writeFileSync(join(sub, '.git', 'config'), 'garbage [[[\n');
  const res = run(['verify-handback', w.report, '--repo', w.repo, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--paseo-home', w.home]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^IO_FAILURE: /);
});

test('a malformed repo-probe line after exit 0 is IO_FAILURE at the CLI', t => {
  // A git wrapper in a temp PATH appends a GARBAGE line to rev-parse output —
  // the whole facade path must fail loud: exit 1, typed stderr, empty stdout.
  const w = world(t);
  const shimDir = join(w.dir, 'bin');
  mkdirSync(shimDir);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nif printf '%s\\n' "$@" | grep -q -- '--is-inside-work-tree'; then "${realGit}" "$@"; echo GARBAGE; else exec "${realGit}" "$@"; fi\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
  const res = run(['verify-handback', w.report, '--repo', w.repo, '--expect-contract', `CONTRACT.md=${w.contractSha}`, '--paseo-home', w.home],
    { PATH: `${shimDir}:${process.env.PATH}` });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^IO_FAILURE: /);
});

test('an old runtime without the verb keeps its existing unknown-command behavior', t => {
  // The "old runtime" is a hermetic copy of this package's bin/ + src/ with
  // the verify-handback commands-table entry and dispatch branch stripped —
  // no git history, commit SHA or network, so a shallow CI checkout cannot
  // break it (Lead's CI-surface finding, correction round 3). Running the
  // verb must land on the existing error path: nonzero exit, no stdout, a
  // caller-side CapabilityGap-shaped signal.
  const dir = mkdtempSync(join(tmpdir(), 'slp-old-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(PKG, 'bin'), join(dir, 'bin'), { recursive: true });
  cpSync(join(PKG, 'src'), join(dir, 'src'), { recursive: true });
  const slpPath = join(dir, 'bin', 'slp.mjs');
  const lines = readFileSync(slpPath, 'utf8').split('\n');
  const entry = lines.findIndex(line => line.includes("'verify-handback':"));
  assert.ok(entry > -1, 'source commands table must contain the verb entry');
  lines.splice(entry, 1);
  const dispatch = lines.findIndex(line => line.includes("command === 'verify-handback'"));
  assert.ok(dispatch > -1, 'source dispatch must contain the verb branch');
  const close = lines.findIndex((line, i) => i > dispatch && line === '  }');
  assert.ok(close > -1, 'dispatch block must close at two-space indent');
  lines.splice(dispatch, close - dispatch + 1);
  const stripped = lines.join('\n');
  assert.ok(!stripped.includes("'verify-handback':"), 'copy must lose the commands-table entry');
  assert.ok(!stripped.includes("command === 'verify-handback'"), 'copy must lose the dispatch branch');
  writeFileSync(slpPath, stripped);
  const res = spawnSync(process.execPath, [slpPath, 'verify-handback', 'report.md'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /Usage|takes no arguments|Unknown/);
});
