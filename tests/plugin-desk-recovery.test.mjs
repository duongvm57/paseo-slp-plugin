// tests/plugin-desk-recovery.test.mjs — P2-e desk lock recovery coverage.
//
// The closed 17-result precedence table (§3.2) is exercised end to end: every
// result name is produced at least once and the final test asserts the
// SEEN set equals the enum, so an added result without a test fails. I/O
// branches use the injectable `io`/`kill` seams — never OS permissions.
// Process-liveness branches use real pids: a reaped child for ESRCH, a live
// sleeper for held/pid-reuse.
//
// Race schedules L1/L2/L2b/L3 (M3) use the same deterministic technique as
// P2-a: barrier hooks on the recoverer (recoverLockHeld/beforeLockRecheck)
// plus a `lockHeld` fault on the transacting child, sequenced over IPC —
// no sleeps, no probabilistic loops.
//
// All fixtures live under tmpdir(); the repo tree, .local-checks and the
// real daemon home are never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  boundRecoveryOutput,
  recoverDeskLock,
  recoverLockView,
  recoveryOutput,
} from '../plugin/server/desk-recovery.ts';
import { createDeskStore, DESK_BRIDGE_REPO, deskRepoPaths, repoKeyFor } from '../plugin/server/desk-store.ts';
import { createDeskSeat, DESK_HANDLE_KEY } from '../plugin/server/desk-seat.ts';
import { sha256Hex } from '../plugin/server/config-view.ts';
import {
  DeskRecoveryResult,
  RecoverLockInput,
  RecoverLockOutput,
  WIRE_LIMITS,
} from '../plugin/shared/enforcement.ts';
import { OperationConflict } from '../plugin/shared/contracts.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const COMMON_DIR = '/repo/.git';
const REPO_KEY = repoKeyFor({ hostId: 'local', gitCommonDir: COMMON_DIR });
const ACTOR = 'operator:test';
const RECOVER_URL = new URL('../plugin/server/desk-recovery.ts', import.meta.url).href;
const STORE_URL = new URL('../plugin/server/desk-store.ts', import.meta.url).href;

// Every test records the result it produced; the last test asserts the set
// equals the closed enum — an uncovered result, or a new one without a test,
// fails the suite.
const SEEN = new Set();
const record = outcome => {
  SEEN.add(outcome.receipt.result);
  return outcome;
};

// --- Fixtures ----------------------------------------------------------------

function tmp(t, prefix = 'slp-p2e-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** A stable root with the repo namespace present (repos/<key>/events/). */
function repoFixture(t, key = REPO_KEY) {
  const dir = tmp(t);
  const stableRoot = join(dir, 'stable');
  const paths = deskRepoPaths(stableRoot, key);
  mkdirSync(paths.eventsDir, { recursive: true });
  return { dir, stableRoot, paths, key };
}

const lockContent = (pid, nonce) => JSON.stringify({ pid, instanceNonce: nonce, startedAt: NOW });

function writeLock(paths, pid, nonce = 'deadbeef'.repeat(4)) {
  writeFileSync(paths.lockPath, lockContent(pid, nonce));
}

const auditLines = paths =>
  existsSync(paths.auditPath)
    ? readFileSync(paths.auditPath, 'utf8').split('\n').filter(l => l.length > 0).map(l => JSON.parse(l))
    : [];

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(res => child.once('exit', res));
  return child.pid;
}

/** A live sleeper child owned by the test — killed in t.after. */
function livePid(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  return child.pid;
}

const run = (fx, over = {}, input = { actorKey: ACTOR }) =>
  recoverDeskLock(
    { stableRoot: fx.stableRoot, repoKey: fx.key, now: () => new Date(NOW), ...over },
    input,
  ).then(record);

// --- Group A — before any desk file operation --------------------------------

test('A3: an over-cap actorKey is refused before any file op — receipt carries it verbatim', async t => {
  const fx = repoFixture(t);
  const long = 'operator:cli:' + 'u'.repeat(WIRE_LIMITS.recoverActorKey);
  const out = await run(fx, {
    io: {
      // The oracle: no desk file may be touched on this path.
      openSync: () => { throw new Error('file op under actor-invalid'); },
      readFileSync: () => { throw new Error('file op under actor-invalid'); },
      lstatOrNull: () => { throw new Error('file op under actor-invalid'); },
    },
  }, { actorKey: long });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INVALID_RECORD');
  assert.equal(out.receipt.result, 'actor-invalid');
  assert.equal(out.receipt.actorKey, long, 'the rejected key is never truncated');
  assert.equal(out.receipt.recoverLockReleased, null);
});

test('A3: an empty actorKey is refused the same way', async t => {
  const fx = repoFixture(t);
  const out = await run(fx, {}, { actorKey: '' });
  assert.equal(out.receipt.result, 'actor-invalid');
  assert.match(out.message, /actorKey is empty/);
});

test('A4: a non-directory namespace ancestor is unsafe', async t => {
  const fx = repoFixture(t);
  // events exists as a regular file — the same ancestor chain transact checks.
  rmSync(fx.paths.eventsDir, { recursive: true });
  writeFileSync(fx.paths.eventsDir, 'x');
  const out = await run(fx);
  assert.equal(out.receipt.result, 'unsafe');
  assert.equal(out.code, 'STATE_UNREADABLE');
  assert.equal(existsSync(fx.paths.recoverLockPath), false);
});

test('A5: a non-EEXIST recover.lock creation failure is recover-lock-io', async t => {
  const fx = repoFixture(t);
  const io = {
    openSync: (p, flags, mode) => {
      if (p === fx.paths.recoverLockPath) { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return openSync(p, flags, mode);
    },
  };
  const out = await run(fx, { io });
  assert.equal(out.receipt.result, 'recover-lock-io');
  assert.equal(out.code, 'STATE_UNREADABLE');
});

// --- Group B — recover.lock already exists -----------------------------------

test('B1: a recover.lock that vanishes before its read is busy', async t => {
  const fx = repoFixture(t);
  writeFileSync(fx.paths.recoverLockPath, lockContent(process.pid, 'live-rl'));
  const io = {
    readFileSync: p => {
      if (p === fx.paths.recoverLockPath) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
      return readFileSync(p);
    },
  };
  const out = await run(fx, { io });
  assert.equal(out.receipt.result, 'busy');
  assert.equal(out.code, 'CAPABILITY_GAP');
  assert.equal(out.receipt.recoverLockReleased, null, 'this recoverer never held RL');
});

test('B2: a live recover.lock holder is busy; the lock is never touched', async t => {
  const fx = repoFixture(t);
  const pid = livePid(t);
  writeFileSync(fx.paths.recoverLockPath, lockContent(pid, 'other-recoverer'));
  writeLock(fx.paths, await deadPid());
  const bytes = readFileSync(fx.paths.lockPath);
  const out = await run(fx);
  assert.equal(out.receipt.result, 'busy');
  assert.equal(out.receipt.pid, pid);
  assert.ok(readFileSync(fx.paths.lockPath).equals(bytes));
});

test('B3: an orphaned recover.lock (dead holder) is recover-lock-orphan — never auto-removed', async t => {
  const fx = repoFixture(t);
  const pid = await deadPid();
  writeFileSync(fx.paths.recoverLockPath, lockContent(pid, 'dead-rl'));
  writeLock(fx.paths, await deadPid());
  const out = await run(fx);
  assert.equal(out.receipt.result, 'recover-lock-orphan');
  assert.equal(out.code, 'RECOVERY_REQUIRED');
  assert.equal(out.receipt.pid, pid);
  assert.ok(existsSync(fx.paths.recoverLockPath), 'RL is never removed automatically');
  assert.ok(existsSync(fx.paths.lockPath), 'the desk lock is untouched too');
});

test('B3 variant: an unparseable recover.lock is also recover-lock-orphan', async t => {
  const fx = repoFixture(t);
  writeFileSync(fx.paths.recoverLockPath, 'not json');
  const out = await run(fx);
  assert.equal(out.receipt.result, 'recover-lock-orphan');
  assert.equal(out.receipt.pid, null);
  assert.ok(existsSync(fx.paths.recoverLockPath));
});

// --- Group C — RL held, classify the desk lock --------------------------------

test('C1: no lock file is no-lock — ok, idempotent, audit untouched', async t => {
  const fx = repoFixture(t);
  const out = await run(fx);
  assert.equal(out.ok, true);
  assert.equal(out.receipt.result, 'no-lock');
  assert.equal(out.receipt.recoverLockReleased, true);
  assert.equal(existsSync(fx.paths.recoverLockPath), false);
  assert.equal(auditLines(fx.paths).length, 0);
});

test('C2: an unparseable lock is unreadable; bytes unchanged', async t => {
  const fx = repoFixture(t);
  writeFileSync(fx.paths.lockPath, '{"pid":"nope"}');
  const out = await run(fx);
  assert.equal(out.receipt.result, 'unreadable');
  assert.equal(out.code, 'RECOVERY_REQUIRED');
  assert.equal(readFileSync(fx.paths.lockPath, 'utf8'), '{"pid":"nope"}');
});

test('C3 held: a live holder pid (pid-reuse shape) is never unlinked', async t => {
  const fx = repoFixture(t);
  const pid = livePid(t);
  writeLock(fx.paths, pid, 'different-nonce-than-the-original');
  const bytes = readFileSync(fx.paths.lockPath);
  const out = await run(fx);
  assert.equal(out.receipt.result, 'held');
  assert.equal(out.code, 'CAPABILITY_GAP');
  assert.ok(readFileSync(fx.paths.lockPath).equals(bytes));
  assert.equal(existsSync(fx.paths.recoverLockPath), false, 'RL was released');
  assert.equal(out.receipt.recoverLockReleased, true);
});

test('C3 via EPERM: kill throwing EPERM means alive — held', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, 424242);
  const out = await run(fx, {
    kill: () => { const e = new Error('eperm'); e.code = 'EPERM'; throw e; },
  });
  assert.equal(out.receipt.result, 'held');
  assert.ok(existsSync(fx.paths.lockPath));
});

test('C4: a kill error that is neither ESRCH nor EPERM is undetermined', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, 424242);
  const out = await run(fx, {
    kill: () => { const e = new Error('bad pid'); e.code = 'EINVAL'; throw e; },
  });
  assert.equal(out.receipt.result, 'undetermined');
  assert.equal(out.code, 'RECOVERY_REQUIRED');
  assert.ok(existsSync(fx.paths.lockPath));
});

// --- Group D — ESRCH path: re-read, audit, unlink -----------------------------

test('D1: lock bytes changed between reads → changed, no audit, no unlink', async t => {
  const fx = repoFixture(t);
  const pid = await deadPid();
  writeLock(fx.paths, pid);
  const original = readFileSync(fx.paths.lockPath);
  let reads = 0;
  const io = {
    readFileSync: p => {
      if (p === fx.paths.lockPath && ++reads === 2) return Buffer.from(lockContent(pid + 1, 'swapped'));
      return readFileSync(p);
    },
  };
  const out = await run(fx, { io });
  assert.equal(out.receipt.result, 'changed');
  assert.equal(out.code, 'CAPABILITY_GAP');
  assert.ok(readFileSync(fx.paths.lockPath).equals(original), 'the lock the recoverer saw stays');
  assert.equal(auditLines(fx.paths).length, 0);
});

test('D2: a non-ENOENT re-read failure is unreadable', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  let reads = 0;
  const io = {
    readFileSync: p => {
      if (p === fx.paths.lockPath && ++reads === 2) { const e = new Error('io'); e.code = 'EIO'; throw e; }
      return readFileSync(p);
    },
  };
  const out = await run(fx, { io });
  assert.equal(out.receipt.result, 'unreadable');
  assert.ok(existsSync(fx.paths.lockPath));
});

test('D3: a failed audit append never unlinks; the lock bytes stay', async t => {
  const fx = repoFixture(t);
  const pid = await deadPid();
  writeLock(fx.paths, pid);
  const bytes = readFileSync(fx.paths.lockPath);
  const io = {
    openSync: (p, flags, mode) => {
      if (p === fx.paths.auditPath) { const e = new Error('audit io'); e.code = 'EIO'; throw e; }
      return openSync(p, flags, mode);
    },
  };
  const out = await run(fx, { io });
  assert.equal(out.receipt.result, 'audit-failed');
  assert.equal(out.code, 'RECOVERY_REQUIRED');
  assert.equal(out.receipt.auditAppended, false);
  assert.ok(readFileSync(fx.paths.lockPath).equals(bytes), 'audit failure → no unlink, ever');
  assert.equal(existsSync(fx.paths.recoverLockPath), false);
});

test('D4: a failed unlink leaves the lock and exactly one audit line; retry recovers', async t => {
  const fx = repoFixture(t);
  const pid = await deadPid();
  writeLock(fx.paths, pid);
  const bytes = readFileSync(fx.paths.lockPath);
  const lockSha256 = createHash('sha256').update(bytes).digest('hex');
  let first = true;
  const io = {
    unlinkSync: p => {
      if (p === fx.paths.lockPath && first) { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return unlinkSync(p);
    },
  };
  const out1 = await run(fx, { io });
  assert.equal(out1.receipt.result, 'unlink-failed');
  assert.equal(out1.code, 'RECOVERY_REQUIRED');
  assert.ok(readFileSync(fx.paths.lockPath).equals(bytes));
  assert.equal(auditLines(fx.paths).length, 1);
  assert.equal(out1.receipt.recoverLockReleased, true);

  // Same lock, second call — the audit gains a second line with the SAME
  // lockSha256 (§3.3: the pre-unlink record is per unlink intent).
  first = false;
  const out2 = await run(fx, { io });
  assert.equal(out2.receipt.result, 'recovered');
  const lines = auditLines(fx.paths);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].lockSha256, lockSha256);
  assert.equal(lines[1].lockSha256, lockSha256);
  for (const line of lines) {
    assert.deepEqual(Object.keys(line),
      ['schemaVersion', 'phase', 'at', 'actorKey', 'repoKey', 'pid', 'instanceNonce', 'lockSha256']);
    assert.equal(line.phase, 'pre-unlink');
    assert.equal(line.pid, pid);
    assert.equal(line.repoKey, fx.key);
  }
  assert.equal(existsSync(fx.paths.lockPath), false);
});

test('D5: ENOENT at unlink time is changed — the audit line stays as evidence', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  const io = {
    unlinkSync: p => {
      if (p === fx.paths.lockPath) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
      return unlinkSync(p);
    },
  };
  const out = await run(fx, { io });
  assert.equal(out.receipt.result, 'changed');
  assert.equal(out.code, 'CAPABILITY_GAP');
  assert.equal(auditLines(fx.paths).length, 1);
});

test('D3 variant: the audit-created directory fsync failing is audit-failed — no unlink', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  const bytes = readFileSync(fx.paths.lockPath);
  const io = {
    fsyncDirectory: () => { const e = new Error('fsync io'); e.code = 'EIO'; throw e; },
  };
  const out = await run(fx, { io });
  // fsyncDirectory runs inside the audit step when this call created the
  // audit file — its failure is an audit-durability failure: no unlink.
  assert.equal(out.receipt.result, 'audit-failed');
  assert.ok(readFileSync(fx.paths.lockPath).equals(bytes));
});

test('D6: fsyncDirectory failing only after the unlink yields unlink-unsynced', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  let unlinked = false;
  const io = {
    unlinkSync: p => { unlinkSync(p); if (p === fx.paths.lockPath) unlinked = true; },
    fsyncDirectory: () => {
      if (unlinked) { const e = new Error('fsync io'); e.code = 'EIO'; throw e; }
    },
  };
  const out = await run(fx, { io });
  assert.equal(out.receipt.result, 'unlink-unsynced');
  assert.equal(out.code, 'RECOVERY_REQUIRED');
  assert.equal(existsSync(fx.paths.lockPath), false, 'the unlink itself succeeded');
  assert.equal(auditLines(fx.paths).length, 1);
});

test('D7 recovered: orphan lock (reaped child pid) is audited then unlinked', async t => {
  const fx = repoFixture(t);
  const pid = await deadPid();
  writeLock(fx.paths, pid, 'nonce-of-the-dead');
  const bytes = readFileSync(fx.paths.lockPath);
  const out = await run(fx);
  assert.equal(out.ok, true);
  assert.equal(out.receipt.result, 'recovered');
  assert.equal(out.receipt.pid, pid);
  assert.equal(out.receipt.instanceNonce, 'nonce-of-the-dead');
  assert.equal(out.receipt.auditAppended, true);
  assert.equal(out.receipt.recoverLockReleased, true);
  assert.equal(existsSync(fx.paths.lockPath), false);
  assert.equal(existsSync(fx.paths.recoverLockPath), false);
  const [line] = auditLines(fx.paths);
  assert.equal(line.lockSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(line.actorKey, ACTOR);
  // The strict output shape round-trips on the wire schema.
  const wire = recoveryOutput(out);
  assert.deepEqual(Object.keys(wire), ['ok', 'receipt']);
  assert.deepEqual(RecoverLockOutput.parse(wire), wire);
  assert.deepEqual(boundRecoveryOutput(wire), wire);
});

// --- Group E — recover.lock cleanup after C/D --------------------------------

test('E2: an RL reread mismatch converts the envelope, keeps the C/D result', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  const io = {
    readFileSync: p => {
      if (p === fx.paths.recoverLockPath) return Buffer.from(lockContent(999999, 'foreign'));
      return readFileSync(p);
    },
  };
  const out = await run(fx, { io });
  // inner result recovered; the RL looked foreign at cleanup → envelope flips.
  assert.equal(out.receipt.result, 'recovered');
  assert.equal(out.receipt.recoverLockReleased, false);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'RECOVERY_REQUIRED');
  assert.equal(out.message, 'recover-lock-release-failed: recovered');
  assert.match(out.recovery, /recover\.lock/);
  assert.equal(existsSync(fx.paths.lockPath), false, 'the recovery itself did happen');
  assert.ok(existsSync(fx.paths.recoverLockPath), 'the foreign RL is never removed');
});

test('E2 variant: an RL unlink failure behaves identically', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  const io = {
    unlinkSync: p => {
      if (p === fx.paths.recoverLockPath) { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return unlinkSync(p);
    },
  };
  const out = await run(fx, { io });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'RECOVERY_REQUIRED');
  assert.equal(out.message, 'recover-lock-release-failed: recovered');
  assert.equal(out.receipt.result, 'recovered');
  assert.equal(out.receipt.recoverLockReleased, false);
  assert.equal(existsSync(fx.paths.lockPath), false);
});

// --- Off-table exceptions -----------------------------------------------------

test('internal-error: a programming fault degrades to the closed result, never throws', async t => {
  const fx = repoFixture(t);
  const out = await run(fx, {
    uuid: () => { throw new TypeError('boom'); },
  });
  assert.equal(out.ok, false);
  assert.equal(out.receipt.result, 'internal-error');
  assert.equal(out.code, 'RECOVERY_REQUIRED');
  assert.match(out.message, /internal-error/);
});

// A throwing clock seam is the same off-table exception — §3.2 forbids a raw
// exception crossing the boundary, so `now()` is read inside the try on every
// surface (S1). The receipt falls back to the real clock for `at`.
test('internal-error: a throwing clock degrades the same way — algorithm and RPC gate', async t => {
  const fx = repoFixture(t);
  const out = await run(fx, {
    now: () => { throw new Error('clock dead'); },
  });
  assert.equal(out.ok, false);
  assert.equal(out.receipt.result, 'internal-error');
  assert.equal(out.code, 'RECOVERY_REQUIRED');
  assert.equal(out.receipt.recoverLockReleased, null);
  assert.doesNotThrow(() => new Date(out.receipt.at), 'receipt carries a valid timestamp');

  const gate = await recoverLockView(
    {
      schemaVersion: 1,
      target: { hostId: 'test', daemonHome: '/home/never' },
      repo: { gitCommonDir: COMMON_DIR },
    },
    { now: () => { throw new Error('clock dead'); } },
  );
  assert.equal(gate.ok, false);
  assert.equal(gate.receipt.result, 'internal-error');
  assert.deepEqual(RecoverLockOutput.parse(gate), gate);
});

// A throwing recoverLockHeld hook must not strand our own recover.lock —
// the hook fires inside the cleanup scope, so E still runs (S2).
test('internal-error: a throwing recoverLockHeld hook still releases our recover.lock', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  const out = await run(fx, {
    hooks: { recoverLockHeld: () => { throw new Error('hook boom'); } },
  });
  assert.equal(out.receipt.result, 'internal-error');
  assert.equal(out.receipt.recoverLockReleased, true, 'E cleanup ran despite the hook throw');
  assert.equal(existsSync(fx.paths.recoverLockPath), false, 'our RL was removed');
  assert.ok(existsSync(fx.paths.lockPath), 'the desk lock was never unlinked');
  assert.equal(auditLines(fx.paths).length, 0, 'no audit line — the unlink never ran');
});

// --- X5 idempotence ------------------------------------------------------------

for (const checkpoint of ['recoverLockHeld', 'beforeLockRecheck']) {
  test(`internal-error: rejected ${checkpoint} promise re-enters lock cleanup`, async t => {
    const fx = repoFixture(t);
    writeLock(fx.paths, await deadPid());
    const bytes = readFileSync(fx.paths.lockPath);
    const out = await run(fx, {
      hooks: { [checkpoint]: async () => { throw new Error('async hook boom'); } },
    });
    assert.equal(out.receipt.result, 'internal-error');
    assert.equal(out.receipt.recoverLockReleased, true);
    assert.equal(existsSync(fx.paths.recoverLockPath), false);
    assert.deepEqual(readFileSync(fx.paths.lockPath), bytes);
    assert.equal(auditLines(fx.paths).length, 0);
  });
}

test('X5: a second recovery call after success is a clean no-lock', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  const first = await run(fx);
  assert.equal(first.receipt.result, 'recovered');
  const second = await run(fx);
  assert.equal(second.ok, true);
  assert.equal(second.receipt.result, 'no-lock');
  assert.equal(auditLines(fx.paths).length, 1, 'no new audit line');
});

// --- Child harness for the deterministic race schedules ------------------------

const CHILD_WATCHDOG_MS = 30_000;
const CHILD_MESSAGE_MS = 20_000;

const CHILD_SOURCE = `
import { recoverDeskLock, recoveryOutput } from ${JSON.stringify(RECOVER_URL)};
import { createDeskStore } from ${JSON.stringify(STORE_URL)};
import { unlinkSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const spec = JSON.parse(process.argv[2]);
const send = m => { if (process.send) process.send(m); };
const park = name => new Promise(resolve => {
  send(name);
  const on = m => { if (m === 'go-' + name || m === 'go') { process.off('message', on); resolve(); } };
  process.on('message', on);
});
if (spec.mode === 'recover') {
  let unlinkedLock = 0;
  const io = {
    unlinkSync: p => {
      if (basename(p) === 'lock') {
        unlinkedLock += 1;
        if (spec.killAt === 'before-unlink') process.kill(process.pid, 'SIGKILL');
      }
      return unlinkSync(p);
    },
  };
  const hooks = {};
  if (spec.park) hooks[spec.park] = () => park(spec.park);
  try {
    const outcome = await recoverDeskLock(
      { stableRoot: spec.stableRoot, repoKey: spec.repoKey,
        now: () => new Date(spec.now), io, hooks },
      { actorKey: spec.actorKey });
    writeFileSync(spec.resultPath, JSON.stringify({ output: recoveryOutput(outcome), unlinkedLock }));
    send('done');
  } catch (error) {
    writeFileSync(spec.resultPath, JSON.stringify({ error: String(error), unlinkedLock }));
    send('done');
  }
} else {
  // transact mode — the desk-store holder path from P2-a, lockHeld barrier.
  const faults = {};
  if (spec.hold) faults.lockHeld = () => park('tx-held');
  const store = createDeskStore({
    stableRoot: spec.stableRoot, faults, now: () => new Date(spec.now),
  });
  try {
    const result = await store.transact(spec.repoKey, spec.envelope,
      () => ({ ok: true, events: [{ kind: 'test.event', payload: { v: 1 } }] }));
    writeFileSync(spec.resultPath, JSON.stringify({ result }));
    send('done');
  } catch (error) {
    writeFileSync(spec.resultPath, JSON.stringify({ error: String(error) }));
    send('done');
  }
}
`;

function spawnChild(t, dir, spec) {
  const script = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, CHILD_SOURCE);
  const child = spawn(process.execPath, [script, JSON.stringify(spec)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise((res, rej) => {
    child.once('error', rej);
    child.once('exit', (code, signal) => res({ code, signal }));
  });
  const watchdog = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, CHILD_WATCHDOG_MS);
  t.after(async () => {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise(res => setTimeout(res, 5000))]);
    }
  });
  const waiters = [];
  child.on('message', m => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i](m)) waiters.splice(i, 1);
    }
  });
  return {
    pid: child.pid,
    exited,
    send: m => child.send(m),
    onceMessage: name => Promise.race([
      new Promise(res => waiters.push(m => (m === name ? (res(m), true) : false))),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout waiting '${name}': ${stderr}`)), CHILD_MESSAGE_MS)),
    ]),
    result: () => JSON.parse(readFileSync(spec.resultPath, 'utf8')),
    output: () => ({ stdout, stderr }),
  };
}

const childRecoverSpec = (fx, over = {}) => ({
  mode: 'recover',
  stableRoot: fx.stableRoot,
  repoKey: fx.key,
  actorKey: ACTOR,
  now: NOW,
  resultPath: join(fx.dir, `r-${Math.random().toString(36).slice(2)}.json`),
  ...over,
});

const childTransactSpec = (fx, over = {}) => ({
  mode: 'transact',
  stableRoot: fx.stableRoot,
  repoKey: fx.key,
  now: NOW,
  envelope: {
    repo: { hostId: 'local', gitCommonDir: COMMON_DIR },
    actorKey: 'actor-t',
    assignmentId: 'assign-t',
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    command: { action: 'hold' },
  },
  resultPath: join(fx.dir, `t-${Math.random().toString(36).slice(2)}.json`),
  ...over,
});

// --- Race schedules (M3 — barriers, never sleeps) ------------------------------

test('L3: two concurrent recoverers on one orphan lock — busy then recovered, one unlink, one audit line', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  // A creates recover.lock then parks at the barrier.
  const a = spawnChild(t, fx.dir, childRecoverSpec(fx, { park: 'recoverLockHeld' }));
  await a.onceMessage('recoverLockHeld');
  // B arrives while A holds RL → busy; the desk lock is untouched.
  const b = record(await run(fx));
  assert.equal(b.receipt.result, 'busy');
  assert.ok(existsSync(fx.paths.lockPath));
  // Release A — it completes the orphan recovery.
  a.send('go');
  await a.onceMessage('done');
  const aOut = a.result();
  record({ receipt: aOut.output.receipt });
  assert.equal(aOut.output.receipt.result, 'recovered');
  assert.equal(aOut.unlinkedLock, 1, 'exactly one recoverer unlink');
  assert.equal(auditLines(fx.paths).length, 1);
  assert.equal(existsSync(fx.paths.lockPath), false);
  assert.equal(existsSync(fx.paths.recoverLockPath), false);
});

test('L1: recoverer A parks, B is busy, A recovers; transaction T holds then a second B sees held', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  // (1) A holds RL and classified the orphan ESRCH — parked before re-read.
  const a = spawnChild(t, fx.dir, childRecoverSpec(fx, { park: 'beforeLockRecheck' }));
  await a.onceMessage('beforeLockRecheck');
  // (2) B: RL exists, holder A alive → busy.
  const b1 = record(await run(fx));
  assert.equal(b1.receipt.result, 'busy');
  assert.ok(existsSync(fx.paths.lockPath));
  // (3) release A → recovered; A unlinks the lock exactly once.
  a.send('go');
  await a.onceMessage('done');
  const aOut = a.result();
  assert.equal(aOut.output.receipt.result, 'recovered');
  assert.equal(aOut.unlinkedLock, 1);
  // (4) T acquires a fresh lock and parks holding it.
  const tp = spawnChild(t, fx.dir, childTransactSpec(fx, { hold: true }));
  await tp.onceMessage('tx-held');
  assert.ok(existsSync(fx.paths.lockPath), 'T holds a new lock');
  const tLockBytes = readFileSync(fx.paths.lockPath);
  // (5) B again: holds RL, reads T's lock, kill(T.pid) succeeds → held; the
  // recoverer MUST NOT unlink T's lock.
  const b2 = record(await run(fx));
  assert.equal(b2.receipt.result, 'held');
  assert.equal(b2.receipt.pid, tp.pid);
  assert.ok(readFileSync(fx.paths.lockPath).equals(tLockBytes), "T's lock bytes are never touched");
  // (6) release T → its transact commits and T releases its own lock.
  tp.send('go');
  await tp.onceMessage('done');
  assert.equal(tp.result().result.ok, true);
  assert.equal(existsSync(fx.paths.lockPath), false, 'T released its own lock');
  assert.equal(auditLines(fx.paths).length, 1, 'exactly one audit line overall');
});

test('L2: after recovery plus a completed transaction, the next recoverer sees no-lock', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  const a = await run(fx);
  assert.equal(a.receipt.result, 'recovered');
  // T acquires and releases (a full transact).
  const store = createDeskStore({ stableRoot: fx.stableRoot });
  const tx = await store.transact(fx.key, {
    repo: { hostId: 'local', gitCommonDir: COMMON_DIR },
    actorKey: 'actor-t', assignmentId: 'a', requestId: 'r-l2', command: {},
  }, () => ({ ok: true, events: [] }));
  assert.equal(tx.ok, true);
  assert.equal(existsSync(fx.paths.lockPath), false);
  const b = await run(fx);
  assert.equal(b.ok, true);
  assert.equal(b.receipt.result, 'no-lock');
  assert.equal(auditLines(fx.paths).length, 1);
});

test('L2b: while T holds its lock the recoverer sees held and never unlinks it', async t => {
  const fx = repoFixture(t);
  writeLock(fx.paths, await deadPid());
  await run(fx); // recover the orphan first
  const tp = spawnChild(t, fx.dir, childTransactSpec(fx, { hold: true }));
  await tp.onceMessage('tx-held');
  const tLockBytes = readFileSync(fx.paths.lockPath);
  const b = record(await run(fx));
  assert.equal(b.receipt.result, 'held');
  assert.ok(readFileSync(fx.paths.lockPath).equals(tLockBytes));
  tp.send('go');
  await tp.onceMessage('done');
});

test('crash between audit and unlink (child SIGKILL) — lock intact, one audit line, orphan RL blocks retry until manually removed, then recovers', async t => {
  const fx = repoFixture(t);
  const pid = await deadPid();
  writeLock(fx.paths, pid);
  const bytes = readFileSync(fx.paths.lockPath);
  const lockSha256 = createHash('sha256').update(bytes).digest('hex');
  const a = spawnChild(t, fx.dir, childRecoverSpec(fx, { killAt: 'before-unlink' }));
  const { signal } = await a.exited;
  assert.equal(signal, 'SIGKILL', `child must die at the unlink seam: ${a.output().stderr}`);
  assert.ok(readFileSync(fx.paths.lockPath).equals(bytes), 'lock survives a mid-recovery crash');
  assert.equal(auditLines(fx.paths).length, 1);
  // The dead recoverer's RL is an orphan — the next call is recover-lock-orphan
  // (B3), and the RL is still never removed automatically.
  const blocked = await run(fx);
  assert.equal(blocked.receipt.result, 'recover-lock-orphan');
  assert.ok(existsSync(fx.paths.recoverLockPath));
  // The sanctioned operator step removes the RL, then the call recovers.
  unlinkSync(fx.paths.recoverLockPath);
  const retry = await run(fx);
  assert.equal(retry.receipt.result, 'recovered');
  const lines = auditLines(fx.paths);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].lockSha256, lockSha256);
  assert.equal(lines[1].lockSha256, lockSha256);
});

// --- RPC surface — provenance gate + output shape ------------------------------

const rpcInput = home => ({
  schemaVersion: 1,
  target: { hostId: 'local', daemonHome: home },
  repo: { gitCommonDir: COMMON_DIR },
});

/** A daemon home whose slp-runtime repo namespace exists on disk. */
function homeFixture(t) {
  const dir = tmp(t);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const stableRoot = join(realpathSync(home), 'slp-runtime');
  const paths = deskRepoPaths(stableRoot, REPO_KEY);
  mkdirSync(paths.eventsDir, { recursive: true });
  return { home, stableRoot, paths };
}

test('RPC input is strict — a malformed input throws INVALID_REQUEST, never a result', async () => {
  await assert.rejects(
    recoverLockView({ schemaVersion: 1, target: { hostId: 'l', daemonHome: '/x' }, repo: {} }),
    error => error instanceof OperationConflict && error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    recoverLockView({ schemaVersion: 2, target: { hostId: 'l', daemonHome: '/x' }, repo: { gitCommonDir: '/r/.git' } }),
    error => error.code === 'INVALID_REQUEST',
  );
  // There is deliberately no force/expected/mode field — strict input.
  assert.equal(RecoverLockInput.safeParse({ ...rpcInput('/x'), force: true }).success, false);
});

test('A1: an unexported PASEO_HOME (default source) refuses with home-unverified — bytes unchanged', async t => {
  const { home, paths } = homeFixture(t);
  writeLock(paths, await deadPid());
  const bytes = readFileSync(paths.lockPath);
  const out = await recoverLockView(rpcInput(home), {
    detectDaemonHome: () => ({ daemonHome: home, source: 'default' }),
  });
  SEEN.add(out.receipt.result);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CAPABILITY_GAP');
  assert.equal(out.receipt.result, 'home-unverified');
  assert.match(out.message, /PASEO_HOME is not exported/);
  assert.match(out.recovery, /desk-recover/);
  assert.match(out.recovery, /--paseo-home/);
  assert.match(out.recovery, /export PASEO_HOME/);
  assert.deepEqual(RecoverLockOutput.parse(out), out);
  assert.ok(readFileSync(paths.lockPath).equals(bytes), 'no mutation on an unverified home');
});

test('A2: a target whose realpath differs from the served home is target-mismatch — bytes unchanged', async t => {
  const { home, paths } = homeFixture(t);
  writeLock(paths, await deadPid());
  const bytes = readFileSync(paths.lockPath);
  const other = join(tmp(t), 'other');
  mkdirSync(other, { recursive: true });
  const out = await recoverLockView(rpcInput(other), {
    detectDaemonHome: () => ({ daemonHome: home, source: 'env' }),
  });
  SEEN.add(out.receipt.result);
  assert.equal(out.receipt.result, 'target-mismatch');
  assert.equal(out.code, 'ACTOR_MISMATCH');
  assert.ok(readFileSync(paths.lockPath).equals(bytes));
});

test('RPC end-to-end: provenance verified → the orphan lock is recovered with actor operator:rpc', async t => {
  const { home, paths } = homeFixture(t);
  const pid = await deadPid();
  writeFileSync(paths.lockPath, lockContent(pid, 'dead-nonce'));
  const out = await recoverLockView(rpcInput(home), {
    detectDaemonHome: () => ({ daemonHome: home, source: 'env' }),
    now: () => new Date(NOW),
  });
  SEEN.add(out.receipt.result);
  assert.equal(out.ok, true);
  assert.equal(out.receipt.result, 'recovered');
  assert.equal(out.receipt.actorKey, 'operator:rpc');
  assert.deepEqual(Object.keys(out), ['ok', 'receipt']);
  assert.deepEqual(RecoverLockOutput.parse(out), out);
  assert.equal(existsSync(paths.lockPath), false);
  assert.equal(existsSync(paths.recoverLockPath), false);
});

// E-P2D-3 — the explicit sentinel descriptor reaches the desk-bridge
// lifecycle lock under its reserved repo namespace; gates and algorithm
// are identical to a real-repo run.

test('E-P2D-3: repo {sentinel:"desk-bridge"} recovers the DESK_BRIDGE_REPO namespace', async t => {
  const { home, stableRoot } = homeFixture(t);
  const sentinelKey = repoKeyFor(DESK_BRIDGE_REPO);
  const paths = deskRepoPaths(stableRoot, sentinelKey);
  mkdirSync(paths.eventsDir, { recursive: true });
  const pid = await deadPid();
  writeFileSync(paths.lockPath, lockContent(pid, 'bridge-orphan'));
  const out = await recoverLockView(
    {
      schemaVersion: 1,
      target: { hostId: 'local', daemonHome: home },
      repo: { sentinel: 'desk-bridge' },
    },
    {
      detectDaemonHome: () => ({ daemonHome: home, source: 'env' }),
      now: () => new Date(NOW),
    },
  );
  SEEN.add(out.receipt.result);
  assert.equal(out.ok, true);
  assert.equal(out.receipt.result, 'recovered');
  assert.equal(out.receipt.repoKey, sentinelKey);
  assert.equal(out.receipt.actorKey, 'operator:rpc');
  assert.deepEqual(RecoverLockOutput.parse(out), out);
  assert.equal(existsSync(paths.lockPath), false);
});

test('E-P2D-3: the sentinel input is strict — wrong literal or extra fields refuse', async () => {
  await assert.rejects(
    recoverLockView({ schemaVersion: 1, target: { hostId: 'l', daemonHome: '/x' }, repo: { sentinel: 'other' } }),
    error => error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    recoverLockView({ schemaVersion: 1, target: { hostId: 'l', daemonHome: '/x' }, repo: { sentinel: 'desk-bridge', gitCommonDir: '/r/.git' } }),
    error => error.code === 'INVALID_REQUEST',
  );
  // A caller-supplied repoKey can never name the sentinel directly.
  await assert.rejects(
    recoverLockView({ schemaVersion: 1, target: { hostId: 'l', daemonHome: '/x' }, repoKey: 'a'.repeat(64), repo: { sentinel: 'desk-bridge' } }),
    error => error.code === 'INVALID_REQUEST',
  );
});

test('RPC internal-error: an off-table throw inside the algorithm becomes the closed result', async t => {
  const { home } = homeFixture(t);
  const out = await recoverLockView(rpcInput(home), {
    detectDaemonHome: () => ({ daemonHome: home, source: 'env' }),
    io: { lstatOrNull: () => { throw new TypeError('programming fault'); } },
  });
  SEEN.add(out.receipt.result);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'RECOVERY_REQUIRED');
  assert.equal(out.receipt.result, 'internal-error');
  assert.deepEqual(RecoverLockOutput.parse(out), out);
});

// --- X6/X7 — P2-c desk-seat interaction ---------------------------------------
//
// The seat fixture uses a real `git init` repository so the hook paths
// resolve through the same ROUTE cell as production. The orphan lock's
// holder is a reaped child pid (ESRCH), so a transact that reaches the lock
// wait expires into RECOVERY_REQUIRED after lockWaitMs — the seat budget is
// widened so that wait is inside it.

function gitRepo(t) {
  const dir = join(tmp(t, 'slp-p2e-repo-'), 'repo');
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function seatFixture(t) {
  const repo = gitRepo(t);
  const dir = tmp(t, 'slp-p2e-home-');
  const stableRoot = join(dir, 'stable');
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: realpathSync(join(repo, '.git')) });
  const paths = deskRepoPaths(stableRoot, repoKey);
  mkdirSync(paths.eventsDir, { recursive: true });
  const warnings = [];
  const seat = createDeskSeat({
    stableRoot,
    warn: line => warnings.push(line),
    now: () => new Date(NOW),
    transactBudgetMs: 30_000,
  });
  return { repo, stableRoot, repoKey, paths, warnings, seat };
}

const mintInput = repo => ({ provider: 'slp-codex-peer', family: 'codex', role: 'peer', cwd: repo, env: {} });
const createdEvent = repo => ({
  agent: { id: 'agent-1', workspaceId: 'wks-1', parentAgentId: null, provider: 'slp-codex-peer', cwd: repo, title: null },
});
const archivedEvent = repo => ({ ...createdEvent(repo), archivedAt: NOW });

test('X6: no hook path runs recovery — all four desk ops fail-open on an orphan lock, bytes untouched', async t => {
  const { repo, stableRoot, repoKey, paths, warnings, seat } = seatFixture(t);
  const pid = await deadPid();
  writeLock(paths, pid, 'orphan-holder');
  const lockBytes = readFileSync(paths.lockPath);

  const mint = await seat.deskMint(mintInput(repo));
  assert.equal(mint, null);
  await seat.deskBind({
    agentId: 'agent-1', workspaceId: 'wks-1', provider: 'slp-codex-peer',
    cwd: repo, reason: 'create', purpose: 'interactive',
    env: { [DESK_HANDLE_KEY]: 'f'.repeat(64) },
  });
  await seat.deskRegister(createdEvent(repo));
  await seat.deskRevoke(archivedEvent(repo));

  for (const op of ['mint', 'bind', 'register', 'revoke']) {
    assert.ok(
      warnings.includes(`slp: desk ${op} skipped: store-recovery-required`),
      `${op} must surface the P2-c diagnostic; got ${JSON.stringify(warnings)}`,
    );
  }
  assert.ok(readFileSync(paths.lockPath).equals(lockBytes), 'no hook path ever touches the lock');
  assert.equal(existsSync(paths.recoverLockPath), false, 'no hook path creates recover.lock');
  assert.equal(existsSync(paths.auditPath), false, 'no hook path writes audit');
});

test('X7: before recovery mint is store-recovery-required; after, mint lands an unbound-open row', async t => {
  const { repo, stableRoot, repoKey, paths, warnings, seat } = seatFixture(t);
  writeLock(paths, await deadPid(), 'orphan-holder');

  // Before: fail-open with the P2-c diagnostic.
  const before = await seat.deskMint(mintInput(repo));
  assert.equal(before, null);
  assert.ok(warnings.includes('slp: desk mint skipped: store-recovery-required'));

  // The operator path recovers the orphan.
  const recovered = record(await recoverDeskLock(
    { stableRoot, repoKey, now: () => new Date(NOW) },
    { actorKey: ACTOR },
  ));
  assert.equal(recovered.receipt.result, 'recovered');
  assert.equal(existsSync(paths.lockPath), false);

  // After: mint succeeds and the unbound-open row is in the ledger.
  const after = await seat.deskMint(mintInput(repo));
  assert.ok(after !== null && typeof after.handle === 'string');
  const store = createDeskStore({ stableRoot });
  const read = await store.read(repoKey);
  assert.equal(read.state, 'ok');
  const row = read.ledger.memberships.find(m => m.bindingHandleSha256 === sha256Hex(after.handle));
  assert.ok(row, 'the minted membership row exists');
  assert.equal(row.state, 'unbound-open');
  assert.equal(row.agentId, null);
});

// --- Coverage pin — keep LAST --------------------------------------------------

test('the closed result enum has exactly 17 values and every one was exercised', () => {
  assert.deepEqual([...DeskRecoveryResult.options].sort(), [
    'actor-invalid', 'audit-failed', 'busy', 'changed', 'held', 'home-unverified',
    'internal-error', 'no-lock', 'recover-lock-io', 'recover-lock-orphan',
    'recovered', 'target-mismatch', 'undetermined', 'unlink-failed',
    'unlink-unsynced', 'unreadable', 'unsafe',
  ]);
  assert.equal(DeskRecoveryResult.options.length, 17);
  for (const result of DeskRecoveryResult.options) {
    assert.ok(SEEN.has(result), `result ${result} was never produced by this suite`);
  }
  // The result-name bound covers the longest member.
  for (const result of DeskRecoveryResult.options) {
    assert.ok(result.length <= WIRE_LIMITS.recoverResult, `${result} exceeds recoverResult`);
  }
});
