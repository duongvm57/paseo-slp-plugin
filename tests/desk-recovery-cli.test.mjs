// tests/desk-recovery-cli.test.mjs — P2-e CLI mirror coverage.
//
// X2 parity: the same fixture driven through the plugin TS algorithm and
// src/desk-recovery.mjs produces the same output object except
// receipt.actorKey/receipt.at (surface identity and clock). The bin verb is
// spawned as a real process for exit codes and --json shape.
//
// Hermetic: a throwaway `git init` repository and a tmpdir daemon home;
// nothing touches the real home, repo tree or .local-checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverDeskLock, recoverLockView, recoveryOutput } from '../plugin/server/desk-recovery.ts';
import { repoKeyFor } from '../plugin/server/desk-store.ts';
import { DeskRecoveryResult, RecoverLockOutput, WIRE_LIMITS } from '../plugin/shared/enforcement.ts';
import {
  deskRecover, repoKeyOf, repoKeyFor as mirrorRepoKeyFor, cliActorKey, DESK_BRIDGE_REPO,
} from '../src/desk-recovery.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SLP = join(ROOT, 'bin', 'slp.mjs');
const NOW = '2026-01-01T00:00:00.000Z';

function tmp(t, prefix = 'slp-cli-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function gitRepo(t) {
  const dir = join(tmp(t), 'repo');
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function homeDir(t) {
  const home = join(tmp(t), 'home');
  mkdirSync(home, { recursive: true });
  return home;
}

const pathsFor = (home, repoKey) => {
  const repoDir = join(realpathSync(home), 'slp-runtime', 'state', 'enforcement', 'repos', repoKey);
  return {
    repoDir,
    lockPath: join(repoDir, 'lock'),
    recoverLockPath: join(repoDir, 'recover.lock'),
    auditPath: join(repoDir, 'recovery-log.jsonl'),
  };
};

/** Repo namespace present under home; returns the repoKey the CLI will use. */
function namespace(t, home, repoKey) {
  const paths = pathsFor(home, repoKey);
  mkdirSync(join(paths.repoDir, 'events'), { recursive: true });
  return paths;
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(res => child.once('exit', res));
  return child.pid;
}

const lockFile = (paths, pid, nonce = 'deadbeef'.repeat(4)) =>
  writeFileSync(paths.lockPath, JSON.stringify({ pid, instanceNonce: nonce, startedAt: NOW }));

/** Spawn the real verb. Returns {code, stdout, stderr}. */
const cli = (args, options = {}) =>
  spawnSync(process.execPath, [SLP, 'desk-recover', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    ...options,
  });

// --- repoKey parity ------------------------------------------------------------

test('the CLI repoKey mirror matches repoKeyFor on the same real common dir', t => {
  const repo = gitRepo(t);
  const expected = repoKeyFor({ hostId: 'local', gitCommonDir: realpathSync(join(repo, '.git')) });
  assert.equal(repoKeyOf(repo), expected);
  assert.equal(mirrorRepoKeyFor({ hostId: 'local', gitCommonDir: realpathSync(join(repo, '.git')) }), expected);
});

// --- Function-level outcomes ----------------------------------------------------

test('no-lock and recovered are ok:true; --json shape is the strict RPC output', async t => {
  const repo = gitRepo(t);
  const home = homeDir(t);
  const repoKey = repoKeyOf(repo);
  const paths = namespace(t, home, repoKey);

  // no-lock
  const first = deskRecover({ repository: repo, home });
  assert.equal(first.output.ok, true);
  assert.equal(first.output.receipt.result, 'no-lock');
  assert.deepEqual(RecoverLockOutput.parse(first.output), first.output);
  assert.equal(first.outcome.receipt.repoKey, repoKey);

  // orphan lock → recovered
  const pid = await deadPid();
  lockFile(paths, pid, 'orphan-nonce');
  const second = deskRecover({ repository: repo, home });
  assert.equal(second.output.ok, true);
  assert.equal(second.output.receipt.result, 'recovered');
  assert.equal(second.output.receipt.pid, pid);
  assert.equal(second.output.receipt.recoverLockReleased, true);
  assert.equal(existsSync(paths.lockPath), false);
  assert.equal(existsSync(paths.recoverLockPath), false);
  // one audit line, sha of the exact bytes removed
  const [line] = readFileSync(paths.auditPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(line.lockSha256, createHash('sha256').update(JSON.stringify({ pid, instanceNonce: 'orphan-nonce', startedAt: NOW })).digest('hex'));
  assert.match(second.outcome.receipt.actorKey, /^operator:cli:.+/);
});

test('held: a lock whose pid is alive is a rejection, never unlinked', t => {
  const repo = gitRepo(t);
  const home = homeDir(t);
  const paths = namespace(t, home, repoKeyOf(repo));
  lockFile(paths, process.pid, 'this-process');
  const bytes = readFileSync(paths.lockPath);
  const { outcome } = deskRecover({ repository: repo, home });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.receipt.result, 'held');
  assert.equal(outcome.code, 'CAPABILITY_GAP');
  assert.ok(readFileSync(paths.lockPath).equals(bytes));
});

test('actor-invalid: a userInfo exception maps to the closed result — no desk file is created', t => {
  const repo = gitRepo(t);
  const home = homeDir(t);
  const paths = namespace(t, home, repoKeyOf(repo));
  const { outcome, output } = deskRecover({
    repository: repo, home,
    userInfo: () => { throw new Error('no passwd entry'); },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.receipt.result, 'actor-invalid');
  assert.equal(outcome.code, 'INVALID_RECORD');
  assert.match(outcome.message, /actor-invalid/);
  assert.equal(existsSync(paths.recoverLockPath), false);
  assert.equal(existsSync(paths.auditPath), false);
  assert.deepEqual(RecoverLockOutput.parse(output), output);
});

test('actor-invalid: an empty username is refused, never invented', t => {
  const repo = gitRepo(t);
  const home = homeDir(t);
  const { outcome } = deskRecover({
    repository: repo, home,
    userInfo: () => ({ username: '' }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.receipt.result, 'actor-invalid');
});

test('actor-invalid: an over-cap username yields actor-invalid with the untruncated key in the receipt', async t => {
  const repo = gitRepo(t);
  const home = homeDir(t);
  const paths = namespace(t, home, repoKeyOf(repo));
  const username = 'u'.repeat(WIRE_LIMITS.recoverActorKey); // prefix + name > cap
  const { outcome } = deskRecover({
    repository: repo, home,
    userInfo: () => ({ username }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.receipt.result, 'actor-invalid');
  assert.equal(outcome.receipt.actorKey, `operator:cli:${username}`, 'never truncated');
  assert.equal(existsSync(paths.recoverLockPath), false, 'refused before file ops');
  assert.equal(existsSync(paths.auditPath), false);
});

// --- E-P2D-3 — the explicit --bridge sentinel target ----------------------------

test('deskRecover({bridge:true}) resolves the DESK_BRIDGE_REPO sentinel — git is never invoked', async t => {
  const home = homeDir(t);
  const repoKey = mirrorRepoKeyFor(DESK_BRIDGE_REPO);
  assert.equal(repoKey, repoKeyFor({ hostId: 'desk-bridge', gitCommonDir: 'desk-bus' }));
  const paths = namespace(t, home, repoKey);
  lockFile(paths, await deadPid(), 'bridge-orphan');
  const { outcome, output } = deskRecover({
    bridge: true,
    home,
    // If input resolution touched the repo path this would throw — it must not.
    io: { spawnGit: () => { throw new Error('git must not run for --bridge'); } },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.receipt.repoKey, repoKey);
  assert.equal(outcome.receipt.result, 'recovered');
  assert.equal(existsSync(paths.lockPath), false);
  assert.deepEqual(RecoverLockOutput.parse(output), output);
});

test('deskRecover({bridge:true}) on a held sentinel lock is `held` — never unlinked', t => {
  const home = homeDir(t);
  const repoKey = mirrorRepoKeyFor(DESK_BRIDGE_REPO);
  const paths = namespace(t, home, repoKey);
  lockFile(paths, process.pid, 'bridge-live');
  const bytes = readFileSync(paths.lockPath);
  const { outcome } = deskRecover({ bridge: true, home });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.receipt.result, 'held');
  assert.equal(outcome.receipt.repoKey, repoKey);
  assert.equal(outcome.code, 'CAPABILITY_GAP');
  assert.ok(readFileSync(paths.lockPath).equals(bytes));
});

// --- X2 parity ------------------------------------------------------------------

test('X2 parity: every result in the closed enum produces identical outputs but for actorKey/at', async t => {
  const repo = gitRepo(t);
  const repoKey = repoKeyOf(repo);
  const pid = await deadPid();

  // Recovery mutates its fixture, so each surface gets its OWN byte-identical
  // home+namespace: same dead pid, same nonce, same bytes.
  const makeHome = () => {
    const home = homeDir(t);
    const paths = namespace(t, home, repoKey);
    const root = join(realpathSync(home), 'slp-runtime');
    return { home, paths, root };
  };
  const symlinkStat = () => ({ isDirectory: () => false, isSymbolicLink: () => true });
  const fail = code => Object.assign(new Error(`fixture ${code}`), { code });
  const deadLock = paths => lockFile(paths, pid, 'same-nonce');
  const rlFile = (paths, rlPid, nonce) =>
    writeFileSync(paths.recoverLockPath, JSON.stringify({ pid: rlPid, instanceNonce: nonce, startedAt: NOW }));

  // Every algorithm result, driven identically on both surfaces. `io` is a
  // factory so stateful seams reset per surface; `cli` fields become
  // deskRecover options, `tsInput` becomes the recoverDeskLock input.
  const cases = [
    ['actor-invalid', {
      // Same over-cap length on both surfaces → identical message bytes.
      cli: { userInfo: () => ({ username: 'u'.repeat(200 - 'operator:cli:'.length) }) },
      tsInput: { actorKey: 'x'.repeat(200) },
    }],
    ['unsafe', { io: () => ({ lstatOrNull: () => symlinkStat() }) }],
    ['recover-lock-io', {
      io: () => ({
        openSync: (p, flags, mode) => {
          if (p.endsWith('/recover.lock')) throw fail('EACCES');
          return openSync(p, flags, mode);
        },
      }),
    }],
    ['busy', { setup: p => rlFile(p, process.pid, 'live-rl') }],
    ['recover-lock-orphan', { setup: p => { rlFile(p, pid, 'dead-rl'); deadLock(p); } }],
    ['no-lock', {}],
    ['unreadable', { setup: p => writeFileSync(p.lockPath, 'garbage{') }],
    ['held', { setup: p => lockFile(p, process.pid, 'live') }],
    ['undetermined', { setup: deadLock, kill: () => { throw fail('EINVAL'); } }],
    ['changed', {
      setup: deadLock,
      io: () => {
        let reads = 0;
        return {
          readFileSync: p => (p.endsWith('/lock') && ++reads === 2
            ? Buffer.from(JSON.stringify({ pid: pid + 1, instanceNonce: 'swapped', startedAt: NOW }))
            : readFileSync(p)),
        };
      },
    }],
    ['audit-failed', {
      setup: deadLock,
      io: () => ({
        openSync: (p, flags, mode) => {
          if (p.endsWith('/recovery-log.jsonl')) throw fail('EIO');
          return openSync(p, flags, mode);
        },
      }),
    }],
    ['unlink-failed', {
      setup: deadLock,
      io: () => ({
        unlinkSync: p => {
          if (p.endsWith('/lock')) throw fail('EACCES');
          return unlinkSync(p);
        },
      }),
    }],
    ['unlink-unsynced', {
      // Pre-created audit file → no directory fsync inside the audit step;
      // the post-unlink fsync is the one that throws.
      setup: p => { deadLock(p); writeFileSync(p.auditPath, ''); },
      io: () => ({ fsyncDirectory: () => { throw fail('EIO'); } }),
    }],
    ['recovered', { setup: deadLock }],
    // A throwing clock seam is an off-table exception → internal-error on
    // both surfaces (S1: the clock read sits inside the boundary catch).
    ['internal-error', { now: () => { throw new Error('clock boom'); } }],
  ];

  const seen = new Set();
  for (const [name, spec] of cases) {
    const cliFx = makeHome();
    const tsFx = makeHome();
    spec.setup?.(cliFx.paths);
    spec.setup?.(tsFx.paths);
    const cliOut = deskRecover({
      repository: repo, home: cliFx.home, io: spec.io?.(),
      kill: spec.kill, now: spec.now, uuid: spec.uuid, userInfo: spec.cli?.userInfo,
    }).output;
    const rpcOut = recoveryOutput(await recoverDeskLock(
      {
        stableRoot: tsFx.root, repoKey, now: spec.now ?? (() => new Date(NOW)),
        kill: spec.kill, uuid: spec.uuid, io: spec.io?.(),
      },
      spec.tsInput ?? { actorKey: 'operator:test' },
    ));
    seen.add(cliOut.receipt.result);
    assert.equal(cliOut.receipt.result, name, `${name}: CLI result`);
    assert.equal(rpcOut.receipt.result, name, `${name}: TS result`);
    const { receipt: a, ...aRest } = cliOut;
    const { receipt: b, ...bRest } = rpcOut;
    assert.deepEqual(aRest, bRest, `${name}: envelope divergence`);
    const { actorKey: _a, at: _at, ...aReceipt } = a;
    const { actorKey: _b, at: _bt, ...bReceipt } = b;
    assert.deepEqual(aReceipt, bReceipt, `${name}: receipt divergence`);
    assert.match(a.actorKey, /^operator:cli:/);
    assert.deepEqual(RecoverLockOutput.parse(cliOut), cliOut, `${name}: CLI output schema-invalid`);
    assert.deepEqual(RecoverLockOutput.parse(rpcOut), rpcOut, `${name}: RPC output schema-invalid`);
  }

  // home-unverified / target-mismatch exist only on the RPC surface — §3.4
  // puts the provenance gate in the RPC layer; the CLI's authority is the
  // operator's explicit --paseo-home, so the same state proceeds there.
  const gateFx = makeHome();
  const rpcInput = home => ({
    schemaVersion: 1,
    target: { hostId: 'test', daemonHome: home },
    repo: { gitCommonDir: '/repo/.git' },
  });
  const unverified = await recoverLockView(rpcInput(gateFx.home), {
    detectDaemonHome: () => ({ daemonHome: gateFx.home, source: 'default' }),
    now: () => new Date(NOW),
  });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.receipt.result, 'home-unverified');
  assert.equal(unverified.code, 'CAPABILITY_GAP');
  assert.deepEqual(RecoverLockOutput.parse(unverified), unverified);
  seen.add('home-unverified');
  // …while the CLI on the same home keeps going (no gate on this surface).
  const cliOnUnverified = deskRecover({ repository: repo, home: gateFx.home }).output;
  assert.equal(cliOnUnverified.receipt.result, 'no-lock');

  const served = homeDir(t);
  const other = homeDir(t);
  const mismatch = await recoverLockView(rpcInput(other), {
    detectDaemonHome: () => ({ daemonHome: served, source: 'env' }),
    now: () => new Date(NOW),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.receipt.result, 'target-mismatch');
  assert.equal(mismatch.code, 'ACTOR_MISMATCH');
  assert.deepEqual(RecoverLockOutput.parse(mismatch), mismatch);
  seen.add('target-mismatch');

  // The parity sweep plus the two gate results covers the closed enum.
  assert.deepEqual(
    [...seen].sort(),
    [...DeskRecoveryResult.options].sort(),
    'every result in the enum was exercised',
  );
});

// --- Process-level CLI ------------------------------------------------------------

test('exit codes: 2 for usage errors, 0/1 for outcomes', async t => {
  const repo = gitRepo(t);
  const home = homeDir(t);

  const noRepo = cli([]);
  assert.equal(noRepo.status, 2, `missing repository: ${noRepo.stderr}`);

  const forced = cli([repo, '--force']);
  assert.equal(forced.status, 2, `--force is a usage error: ${forced.stderr}`);

  const bogus = cli([repo, '--bogus']);
  assert.equal(bogus.status, 2, `unknown flag: ${bogus.stderr}`);

  const notGit = cli([tmpdir(), '--paseo-home', home]);
  assert.equal(notGit.status, 2, `non-repo input: ${notGit.stderr}`);

  // no-lock → 0 (the repo namespace exists; the lock does not)
  const paths = namespace(t, home, repoKeyOf(repo));
  const empty = cli([repo, '--paseo-home', home]);
  assert.equal(empty.status, 0, `no-lock: ${empty.stderr}`);
  assert.match(empty.stdout, /result: no-lock/);

  // orphan lock → recovered → 0
  lockFile(paths, await deadPid(), 'orphan');
  const done = cli([repo, '--paseo-home', home]);
  assert.equal(done.status, 0, `recovered: ${done.stderr}`);
  assert.match(done.stdout, /result: recovered/);
  assert.match(done.stdout, /auditAppended: true/);
  assert.equal(existsSync(paths.lockPath), false);

  // held → 1
  lockFile(paths, process.pid, 'alive');
  const held = cli([repo, '--paseo-home', home]);
  assert.equal(held.status, 1, `held: ${held.stderr}`);
  assert.match(held.stdout, /result: held/);
  assert.match(held.stdout, /recoverLockReleased: true/);
  assert.ok(existsSync(paths.lockPath), 'held lock is never removed');
});

test('--json prints exactly the RPC output object on one line', async t => {
  const repo = gitRepo(t);
  const home = homeDir(t);
  const paths = namespace(t, home, repoKeyOf(repo));
  lockFile(paths, await deadPid(), 'json-case');
  const out = cli([repo, '--paseo-home', home, '--json']);
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.split('\n').filter(l => l.length > 0);
  assert.equal(lines.length, 1, 'exactly one line');
  const parsed = JSON.parse(lines[0]);
  // Same object the algorithm produces — strict schema, strict key order.
  assert.deepEqual(RecoverLockOutput.parse(parsed), parsed);
  assert.deepEqual(Object.keys(parsed), ['ok', 'receipt']);
  assert.deepEqual(Object.keys(parsed.receipt),
    ['schemaVersion', 'repoKey', 'actorKey', 'at', 'result', 'pid', 'instanceNonce', 'auditAppended', 'recoverLockReleased']);
  assert.equal(parsed.receipt.result, 'recovered');
  // And it equals the function-level output but for the clock/actor seam.
  const direct = deskRecover({ repository: repo, home });
  // direct is a second run → no-lock; pin the JSON shape instead:
  assert.equal(direct.output.receipt.result, 'no-lock');
});

test('desk-recover --bridge recovers the sentinel lock end-to-end; <repo> + --bridge is usage error', async t => {
  const repo = gitRepo(t);
  const home = homeDir(t);

  const both = cli([repo, '--bridge', '--paseo-home', home]);
  assert.equal(both.status, 2, `mutual exclusion: ${both.stderr}`);

  const repoKey = mirrorRepoKeyFor(DESK_BRIDGE_REPO);
  const paths = namespace(t, home, repoKey);
  lockFile(paths, await deadPid(), 'bridge-orphan');
  const out = cli(['--bridge', '--paseo-home', home]);
  assert.equal(out.status, 0, `--bridge recovered: ${out.stderr}`);
  assert.match(out.stdout, /result: recovered/);
  assert.match(out.stdout, new RegExp(`repoKey: ${repoKey}`));
  assert.equal(existsSync(paths.lockPath), false);
  // A real-repository run is untouched — same namespace mechanics.
  const realPaths = namespace(t, home, repoKeyOf(repo));
  lockFile(realPaths, await deadPid(), 'real-orphan');
  const real = cli([repo, '--paseo-home', home]);
  assert.equal(real.status, 0, `real repo still works: ${real.stderr}`);
});

test('human output names the result, pid, nonce, message and recovery fields', async t => {
  const repo = gitRepo(t);
  const home = homeDir(t);
  const paths = namespace(t, home, repoKeyOf(repo));
  lockFile(paths, process.pid, 'held-nonce');
  const out = cli([repo, '--paseo-home', home]);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^result: held$/m);
  assert.match(out.stdout, new RegExp(`^pid: ${process.pid}$`, 'm'));
  assert.match(out.stdout, /^nonce: held-nonce$/m);
  assert.match(out.stdout, /^message: held:/m);
});
