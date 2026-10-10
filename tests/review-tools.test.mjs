import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/slp.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
const run = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const records = (report, repo) => {
  const result = spawnSync(process.execPath, [cli, 'records', '-', '--require', 'handback', '--repo', repo], { input: report, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  return { status: result.status, out: JSON.parse(result.stdout) };
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'slp-review-tools-'));
  const repo = join(dir, 'repo');
  const scratch = join(dir, 'scratch');
  mkdirSync(repo); mkdirSync(scratch);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'b.txt'), 'bee\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  return { dir, repo: realpathSync(repo), scratch, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const request = (f, over = {}) => {
  const path = join(f.scratch, 'req.json');
  writeFileSync(path, JSON.stringify({ repository: f.repo, seat: { role: 'peer', disposition: 'reviewer', agentId: 'agent-1' }, verdict: 'APPROVE', checks: [{ cmd: 'npm test', exit: 0, outputFile: join(f.scratch, 'out.txt') }], ...over }));
  return path;
};

test('review-packet reports candidate, changes against base, delta and evidence as facts only', () => {
  const f = fixture();
  try {
    const copy = join(f.dir, 'copy');
    cpSync(f.repo, copy, { recursive: true });
    writeFileSync(join(f.repo, 'a.txt'), 'one\nTWO\nthree\n');
    git(f.repo, 'rm', '-q', 'b.txt');
    writeFileSync(join(f.repo, 'new.txt'), 'x\ny\n');
    const ev = join(f.scratch, 'receipt.json');
    writeFileSync(ev, '{"status":"pass"}\n');
    const before = git(f.repo, 'status', '--porcelain');
    const args = ['review-packet', f.repo, '--base', f.base, '--since', copy, '--evidence', ev];
    const first = run(...args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, run(...args).stdout, 'deterministic');
    assert.equal(git(f.repo, 'status', '--porcelain'), before, 'read-only');
    const packet = JSON.parse(first.stdout);
    assert.equal(packet.kind, 'slp-review-packet');
    assert.equal(packet.candidate.head, f.base);
    assert.match(packet.candidate.snapshotSha256, /^[0-9a-f]{64}$/);
    assert.equal(packet.candidate.files, 2);
    assert.deepEqual(packet.changed.map(c => [c.path, c.status]), [['a.txt', 'modified'], ['b.txt', 'deleted'], ['new.txt', 'untracked']]);
    assert.deepEqual(packet.changed.find(c => c.path === 'a.txt'), { path: 'a.txt', status: 'modified', insertions: 2, deletions: 1 });
    assert.deepEqual(packet.changed.find(c => c.path === 'new.txt'), { path: 'new.txt', status: 'untracked', insertions: 2, deletions: 0 });
    assert.deepEqual(packet.diffStat, { files: 3, insertions: 4, deletions: 2 });
    assert.deepEqual([packet.since.added, packet.since.removed, packet.since.modified, packet.since.identical], [['new.txt'], ['b.txt'], ['a.txt'], false]);
    assert.deepEqual(packet.evidence, [{ path: ev, sha256: sha('{"status":"pass"}\n'), bytes: 18 }]);
    for (const key of ['verdict', 'findings', 'writer', 'seat']) assert.equal(key in packet, false);
    // a snapshot JSON saved earlier works as --since too
    const snap = join(f.scratch, 'snap.json');
    writeFileSync(snap, run('snapshot', copy).stdout);
    assert.deepEqual(JSON.parse(run('review-packet', f.repo, '--base', f.base, '--since', snap).stdout).since.modified, ['a.txt']);
  } finally { f.cleanup(); }
});

test('review-packet fails closed on bad base, missing inputs and an inside-repository --out', () => {
  const f = fixture();
  try {
    const bad = run('review-packet', f.repo, '--base', 'no-such-ref');
    assert.equal(bad.status, 1); assert.equal(bad.stdout, ''); assert.match(bad.stderr, /not a git commit/);
    assert.equal(run('review-packet', f.repo).status, 1);
    assert.equal(run('review-packet', f.repo, '--base', '--output=x').status, 1);
    const missing = run('review-packet', f.repo, '--base', f.base, '--evidence', join(f.scratch, 'nope.txt'));
    assert.equal(missing.status, 1); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /evidence file missing/);
    assert.equal(run('review-packet', f.repo, '--base', f.base, '--evidence', 'relative.txt').status, 1);
    assert.match(run('review-packet', f.repo, '--base', f.base, '--since', join(f.scratch, 'gone')).stderr, /--since not found/);
    writeFileSync(join(f.scratch, 'junk.json'), '{}');
    assert.match(run('review-packet', f.repo, '--base', f.base, '--since', join(f.scratch, 'junk.json')).stderr, /not a snapshot JSON/);

    const inside = run('review-packet', f.repo, '--base', f.base, '--out', join(f.repo, 'sub', 'p.json'));
    assert.equal(inside.status, 1); assert.match(inside.stderr, /outside the repository/);
    assert.equal(existsSync(join(f.repo, 'sub')), false);
    symlinkSync(f.repo, join(f.scratch, 'link'));
    assert.equal(run('review-packet', f.repo, '--base', f.base, '--out', join(f.scratch, 'link', 'p.json')).status, 1);
    assert.equal(existsSync(join(f.repo, 'p.json')), false);

    const out = join(f.scratch, 'nested', 'p.json');
    const ok = run('review-packet', f.repo, '--base', f.base, '--out', out);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readFileSync(out, 'utf8'), ok.stdout);
  } finally { f.cleanup(); }
});

test('record-build derives sha from output bytes and passes records --require handback', () => {
  const f = fixture();
  try {
    const outside = 'ok 1\nexit 0\n';
    writeFileSync(join(f.scratch, 'out.txt'), outside);
    const insideBytes = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    writeFileSync(join(f.repo, 'evidence.bin'), insideBytes);
    const req = request(f, { checks: [
      { cmd: 'npm test', exit: 0, outputFile: join(f.scratch, 'out.txt') },
      { cmd: 'npm run check', exit: 1, outputFile: join(f.repo, 'evidence.bin') },
    ] });
    const built = run('record-build', req);
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, /^```slp-record\n/);
    const record = JSON.parse(built.stdout.split('\n').slice(1, -2).join('\n'));
    assert.deepEqual(record.checks[0], { cmd: 'npm test', exit: 0, sha: sha(outside), output: outside });
    assert.deepEqual(record.checks[1], { cmd: 'npm run check', exit: 1, sha: sha(insideBytes), outputRef: 'evidence.bin' });
    assert.equal(record.candidate.repository, f.repo);
    assert.equal(record.candidate.snapshotSha256, JSON.parse(run('snapshot', f.repo).stdout).sha256);
    assert.deepEqual(record.seat, { role: 'peer', disposition: 'reviewer', agentId: 'agent-1' });
    assert.doesNotMatch(built.stdout, /PLACEHOLDER/);
    const verified = records(built.stdout, f.repo);
    assert.equal(verified.status, 0);
    assert.equal(verified.out.errors.length, 0);
    assert.equal(verified.out.records[0].valid, true);
    // the evidence the record points at is re-hashed: a later edit is caught
    writeFileSync(join(f.repo, 'evidence.bin'), 'changed');
    const stale = records(built.stdout, f.repo);
    assert.equal(stale.status, 1);
    assert.ok(stale.out.errors.some(e => e.code === 'sha-mismatch'));
  } finally { f.cleanup(); }
});

test('record-build refuses missing, unreadable, stub-shaped and oversized evidence — never sha:null', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.scratch, 'out.txt'), 'x');
    const fail = (req, pattern) => {
      const result = run('record-build', req);
      assert.equal(result.status, 1, result.stdout); assert.equal(result.stdout, ''); assert.match(result.stderr, pattern);
    };
    fail(request(f, { checks: [{ cmd: 'c', exit: 0, outputFile: join(f.scratch, 'missing.txt') }] }), /missing or unreadable/);
    fail(request(f, { checks: [{ cmd: 'c', exit: 0, outputFile: f.scratch }] }), /missing or unreadable/);
    fail(request(f, { checks: [{ cmd: 'c', exit: 0, outputFile: 'out.txt' }] }), /absolute path/);
    fail(request(f, { checks: [{ cmd: 'c', exit: 0, sha: 'a'.repeat(64), output: 'PLACEHOLDER', outputFile: join(f.scratch, 'out.txt') }] }), /unknown field (sha|output)/);
    fail(request(f, { checks: [{ cmd: 'c', exit: 0, outputRef: 'x', outputFile: join(f.scratch, 'out.txt') }] }), /never supplied/);
    fail(request(f, { checks: [] }), /at least one check/);
    fail(request(f, { checks: [{ cmd: ' ', exit: 0, outputFile: join(f.scratch, 'out.txt') }] }), /cmd/);
    fail(request(f, { checks: [{ cmd: 'c', exit: '0', outputFile: join(f.scratch, 'out.txt') }] }), /exit must be an integer/);
    fail(request(f, { verdict: 'LGTM' }), /verdict/);
    fail(request(f, { seat: { role: 'peer' } }), /disposition/);
    fail(request(f, { extra: 1 }), /unknown field extra/);
    fail(request(f, { repository: 'relative' }), /absolute/);
    writeFileSync(join(f.scratch, 'bin.dat'), Buffer.from([0xc3, 0x28]));
    fail(request(f, { checks: [{ cmd: 'c', exit: 0, outputFile: join(f.scratch, 'bin.dat') }] }), /not valid UTF-8/);
    writeFileSync(join(f.scratch, 'big.txt'), 'x'.repeat(64 * 1024 + 1));
    fail(request(f, { checks: [{ cmd: 'c', exit: 0, outputFile: join(f.scratch, 'big.txt') }] }), /inline limit/);
    writeFileSync(join(f.scratch, 'req-bad.json'), '{not json');
    assert.equal(run('record-build', join(f.scratch, 'req-bad.json')).status, 1);
    // null verdict is a legitimate report-only value, and verdict must be present
    assert.equal(run('record-build', request(f, { verdict: null })).status, 0);
    const noVerdict = JSON.parse(readFileSync(request(f), 'utf8')); delete noVerdict.verdict;
    writeFileSync(join(f.scratch, 'nov.json'), JSON.stringify(noVerdict));
    assert.equal(run('record-build', join(f.scratch, 'nov.json')).status, 1);
  } finally { f.cleanup(); }
});

test('record-build --out stays outside the repository and never targets the request', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.scratch, 'out.txt'), 'x');
    const req = request(f);
    const inside = run('record-build', req, '--out', join(f.repo, 'rec.md'));
    assert.equal(inside.status, 1); assert.match(inside.stderr, /outside the repository/);
    assert.equal(existsSync(join(f.repo, 'rec.md')), false);
    assert.equal(run('record-build', req, '--out', req).status, 1);
    assert.equal(JSON.parse(readFileSync(req, 'utf8')).verdict, 'APPROVE');
    const out = join(f.scratch, 'rec.md');
    const ok = run('record-build', req, '--out', out);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readFileSync(out, 'utf8'), ok.stdout);
  } finally { f.cleanup(); }
});

test('policy only points at the tools: one clause each, no new obligation wording', () => {
  const gates = readFileSync(new URL('../src/references/review-gates.md', import.meta.url), 'utf8');
  const recordsDoc = readFileSync(new URL('../src/references/report-records.md', import.meta.url), 'utf8');
  assert.match(gates, /Lead may attach a facts-only review packet \(`slp\.mjs review-packet`\)/);
  assert.match(recordsDoc, /`slp\.mjs record-build` can draft one with shas taken from output files/);
});

test('--out never lands inside the repository through a dangling or chained symlink (both commands)', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.scratch, 'out.txt'), 'x');
    const req = request(f);
    const cases = {
      'dangling leaf': () => { symlinkSync(join(f.repo, 'pwned.json'), join(f.scratch, 'dead')); return join(f.scratch, 'dead'); },
      'relative dangling leaf': () => { symlinkSync('../repo/pwned.json', join(f.scratch, 'rel')); return join(f.scratch, 'rel'); },
      'chained dangling': () => { symlinkSync(join(f.repo, 'pwned.json'), join(f.scratch, 'hop2')); symlinkSync(join(f.scratch, 'hop2'), join(f.scratch, 'hop1')); return join(f.scratch, 'hop1'); },
      'dangling dir symlink': () => { symlinkSync(join(f.repo, 'newdir'), join(f.scratch, 'deaddir')); return join(f.scratch, 'deaddir', 'p.json'); },
    };
    for (const [name, make] of Object.entries(cases)) {
      const out = make();
      for (const args of [['review-packet', f.repo, '--base', f.base], ['record-build', req]]) {
        const result = run(...args, '--out', out);
        assert.equal(result.status, 1, `${name} ${args[0]}: ${result.stdout}`);
        assert.match(result.stderr, /outside the repository/, name);
      }
      assert.equal(existsSync(join(f.repo, 'pwned.json')), false, name);
      assert.equal(existsSync(join(f.repo, 'newdir')), false, name);
      assert.equal(existsSync(join(f.repo, 'p.json')), false, name);
    }
    // a symlink that resolves outside the repository stays allowed
    mkdirSync(join(f.dir, 'elsewhere'));
    symlinkSync(join(f.dir, 'elsewhere', 'ok.json'), join(f.scratch, 'fine'));
    assert.equal(run('review-packet', f.repo, '--base', f.base, '--out', join(f.scratch, 'fine')).status, 0);
    assert.equal(existsSync(join(f.dir, 'elsewhere', 'ok.json')), true);
    // a symlink loop fails closed
    symlinkSync(join(f.scratch, 'loop2'), join(f.scratch, 'loop1')); symlinkSync(join(f.scratch, 'loop1'), join(f.scratch, 'loop2'));
    assert.equal(run('record-build', req, '--out', join(f.scratch, 'loop1')).status, 1);
  } finally { f.cleanup(); }
});

test('--since accepts only a directory or regular file; a fifo fails closed instead of hanging', () => {
  const f = fixture();
  try {
    const fifo = join(f.scratch, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const result = spawnSync(process.execPath, [cli, 'review-packet', f.repo, '--base', f.base, '--since', fifo], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    assert.equal(result.error, undefined, 'must not hang');
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /directory or a regular file/);
  } finally { f.cleanup(); }
});

// Every path either command reads or writes must fail closed on a special file
// instead of blocking: a hang shows up as spawnSync's timeout error.
const runBounded = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(result.error, undefined, `blocked: ${args.join(' ')}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

test('no read or write path of either command blocks on a fifo', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.scratch, 'out.txt'), 'x');
    const fifo = name => { const path = join(f.scratch, name); execFileSync('mkfifo', [path]); return path; };
    const refused = (result, pattern) => { assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, pattern); };
    const req = request(f);
    // --out: an existing fifo (also behind a symlink) and an existing directory
    const outFifo = fifo('out-fifo');
    symlinkSync(outFifo, join(f.scratch, 'out-link'));
    for (const out of [outFifo, join(f.scratch, 'out-link'), f.scratch]) {
      refused(runBounded('review-packet', f.repo, '--base', f.base, '--out', out), /new path or an existing regular file/);
      refused(runBounded('record-build', req, '--out', out), /new path or an existing regular file/);
    }
    // an existing regular file stays a valid --out
    writeFileSync(join(f.scratch, 'again.json'), 'old');
    assert.equal(runBounded('review-packet', f.repo, '--base', f.base, '--out', join(f.scratch, 'again.json')).status, 0);
    // --evidence, outputFile and the request file
    refused(runBounded('review-packet', f.repo, '--base', f.base, '--evidence', fifo('ev-fifo')), /regular file/);
    refused(runBounded('review-packet', f.repo, '--base', f.base, '--evidence', f.scratch), /regular file/);
    refused(runBounded('record-build', request(f, { checks: [{ cmd: 'c', exit: 0, outputFile: fifo('of-fifo') }] })), /missing or unreadable/);
    refused(runBounded('record-build', fifo('req-fifo')), /request file must be a regular file/);
    // a tracked file replaced by a fifo inside the measured tree (also in a --since copy);
    // git itself never lists an untracked fifo, so only tracked entries can reach snapshot()
    rmSync(join(f.repo, 'b.txt'));
    execFileSync('mkfifo', [join(f.repo, 'b.txt')]);
    refused(runBounded('review-packet', f.repo, '--base', f.base), /special file/);
    refused(runBounded('record-build', request(f)), /special file/);
    rmSync(join(f.repo, 'b.txt'));
    writeFileSync(join(f.repo, 'b.txt'), 'bee\n');
    const copy = join(f.dir, 'copy');
    cpSync(f.repo, copy, { recursive: true });
    rmSync(join(copy, 'b.txt'));
    execFileSync('mkfifo', [join(copy, 'b.txt')]);
    refused(runBounded('review-packet', f.repo, '--base', f.base, '--since', copy), /special file/);
  } finally { f.cleanup(); }
});
