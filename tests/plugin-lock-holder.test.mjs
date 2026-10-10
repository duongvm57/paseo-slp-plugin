import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createDeskStore, deskRepoPaths, repoKeyFor } from '../plugin/server/desk-store.ts';
import { recoverDeskLock } from '../plugin/server/desk-recovery.ts';
import { classifyLockHolderProcess, parseLockHolder, readProcessIdentity } from '../plugin/server/runtime/lock-holder.ts';
import { bridgeFixture, startBridge } from './helpers/desk-bridge-fixture.mjs';

// Fixed wire-contract boundaries: production limits must not move these oracles.
const NONCE_64 = 'x'.repeat(64);
const NONCE_65 = 'x'.repeat(65);

test('lock holder: one record interpretation for string and filesystem bytes', () => {
  const value = { pid: 123, instanceNonce: 'holder', startedAt: '2026-10-02T00:00:00.000Z' };
  assert.deepEqual(parseLockHolder(JSON.stringify(value)), value);
  assert.deepEqual(parseLockHolder(Buffer.from(JSON.stringify(value))), value);
  assert.deepEqual(parseLockHolder(JSON.stringify({ ...value, startedAt: 42, extension: true })), {
    pid: value.pid, instanceNonce: value.instanceNonce,
  });
  assert.equal(parseLockHolder(JSON.stringify({ pid: 123, instanceNonce: NONCE_64 }))?.pid, 123);
});

test('lock holder: invalid records cannot be mistaken for a live process group', () => {
  for (const pid of [0, -1, 1.5, '123', null]) {
    assert.equal(parseLockHolder(JSON.stringify({ pid, instanceNonce: 'holder' })), null, `pid ${pid}`);
  }
  for (const instanceNonce of ['', null, 123, NONCE_65]) {
    assert.equal(parseLockHolder(JSON.stringify({ pid: 123, instanceNonce })), null);
  }
  for (const bytes of ['not json', 'null', '[]', '123', '{}']) assert.equal(parseLockHolder(bytes), null);
});

test('lock holder: syscall observations remain distinct so callers keep recovery policy', () => {
  const seen = [];
  assert.equal(classifyLockHolderProcess(123, pid => seen.push(pid)), 'alive');
  assert.deepEqual(seen, [123]);
  for (const [code, expected] of [['ESRCH', 'esrch'], ['EPERM', 'eperm'], ['EINVAL', 'undetermined']]) {
    assert.equal(classifyLockHolderProcess(123, () => { throw Object.assign(new Error(code), { code }); }), expected);
  }
  assert.equal(classifyLockHolderProcess(123, () => { throw null; }), 'undetermined');
});

const record = over => JSON.stringify({ pid: process.pid, instanceNonce: 'foreign', ...over }) + '\n';
const malformedRecords = [
  ['pid zero', record({ pid: 0 })],
  ['negative pid', record({ pid: -1 })],
  ['fractional pid', record({ pid: 1.5 })],
  ['string pid', record({ pid: String(process.pid) })],
  ['null pid', record({ pid: null })],
  ['absent pid', record({ pid: undefined })],
  ['absent nonce', record({ instanceNonce: undefined })],
  ['empty nonce', record({ instanceNonce: '' })],
  ['null nonce', record({ instanceNonce: null })],
  ['numeric nonce', record({ instanceNonce: 123 })],
  ['65-character nonce', record({ instanceNonce: NONCE_65 })],
  ['invalid JSON', 'not-json-at-all\n'],
];

// Use the public adapters with actual files. Probe doubles observe syscall use;
// they do not call the parser or decide an adapter's expected refusal for it.
async function characterizeAdapters(t, bytes, { valid = false, eperm = false } = {}) {
  const probes = { store: [], bridge: [], recovery: [] };
  const probe = (adapter, pid) => {
    probes[adapter].push(pid);
    if (eperm) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
  };
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(signal, 0, 'store only probes liveness');
    probe('store', pid);
  });
  // This exercises bridge lifecycle refusals only; no binary graft needs a pin.
  const f = bridgeFixture(t, 'slp-holder-adapters-', 'a'.repeat(64), {
    kill: pid => probe('bridge', pid),
  });
  const repo = { hostId: 'local', gitCommonDir: '/repo/.git' };
  const repoKey = repoKeyFor(repo);
  const paths = deskRepoPaths(f.stableRoot, repoKey);
  mkdirSync(paths.eventsDir, { recursive: true });
  mkdirSync(f.paths.repoDir, { recursive: true });
  writeFileSync(paths.lockPath, bytes);
  writeFileSync(f.paths.lockPath, bytes);

  let decided = false;
  const result = await createDeskStore({ stableRoot: f.stableRoot }).transact(repoKey, {
    repo, actorKey: 'actor-1', assignmentId: 'assign-1', requestId: 'req-1', command: { kind: 'test' },
  }, () => { decided = true; return { ok: true, events: [] }; });
  assert.equal(result.ok, false);
  assert.equal(result.code, valid ? 'CAPABILITY_GAP' : 'RECOVERY_REQUIRED');
  assert.match(valid ? result.recovery : result.message, valid ? /desk-busy/ : /unreadable or unparseable/);
  assert.equal(decided, false, 'no decision or commit passes a held/malformed lock');

  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'unavailable');
  assert.equal(f.bridge.state().code, valid && !eperm ? 'CAPABILITY_GAP' : 'RECOVERY_REQUIRED');
  assert.match(f.bridge.state().reason, !valid ? /malformed/ : eperm ? /dead pid/ : /desk-busy/);
  f.bridge.stop();

  const recovery = await recoverDeskLock({
    stableRoot: f.stableRoot, repoKey, kill: pid => probe('recovery', pid),
  }, { actorKey: 'operator:test' });
  assert.equal(recovery.ok, false);
  assert.equal(recovery.receipt.result, valid ? 'held' : 'unreadable');
  assert.equal(recovery.code, valid ? 'CAPABILITY_GAP' : 'RECOVERY_REQUIRED');
  assert.equal(recovery.receipt.pid, valid ? process.pid : null);
  assert.equal(recovery.receipt.instanceNonce, valid ? NONCE_64 : null);

  for (const lock of [paths.lockPath, f.paths.lockPath]) {
    assert.equal(readFileSync(lock, 'utf8'), bytes, 'each adapter preserves the same holder bytes');
  }
  assert.equal(existsSync(paths.ledgerPath), false);
  assert.deepEqual(readdirSync(paths.eventsDir), []);
  assert.equal(existsSync(f.paths.socketPath), false);
  assert.equal(existsSync(paths.auditPath), false, 'no successful recovery intent is audited');
  assert.equal(existsSync(paths.recoverLockPath), false, 'the recoverer releases its own lock');
  for (const [adapter, pids] of Object.entries(probes)) {
    if (valid) {
      assert.ok(pids.length > 0, `${adapter} accepts the 64-character holder for liveness classification`);
      assert.ok(pids.every(pid => pid === process.pid), `${adapter} probes only the valid holder pid`);
    } else {
      assert.deepEqual(pids, [], `${adapter} must not probe any malformed holder`);
    }
  }
}

for (const [label, bytes] of malformedRecords) {
  test(`lock holder adapters: ${label} refuses without probe, audit or mutation`, async t => {
    await characterizeAdapters(t, bytes);
  });
}

test('lock holder adapters: the literal 64-character nonce is a live foreign holder', async t => {
  await characterizeAdapters(t, record({ instanceNonce: NONCE_64 }), { valid: true });
});

test('lock holder adapters: EPERM preserves each adapter\'s liveness policy', async t => {
  await characterizeAdapters(t, record({ instanceNonce: NONCE_64 }), { valid: true, eperm: true });
});

const BOOT_ID = '01234567-89ab-cdef-0123-456789abcdef';
// Field 22 is a literal oracle; comm contains spaces and ')' to exercise the
// kernel stat grammar rather than indexing a whitespace-split whole line.
const PROC_STAT = '424242 (worker ) with spaces) R 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 8675309 23 24\n';

test('readProcessIdentity parses field 22 after the final comm parenthesis', () => {
  const reads = [];
  const identity = readProcessIdentity(424242, {
    platform: 'linux',
    readFile: path => {
      reads.push(path);
      return path === '/proc/424242/stat' ? PROC_STAT : BOOT_ID + '\n';
    },
  });
  assert.equal(identity, BOOT_ID + ':8675309');
  assert.deepEqual(reads, ['/proc/sys/kernel/random/boot_id', '/proc/424242/stat', '/proc/sys/kernel/random/boot_id']);
});

test('readProcessIdentity refuses malformed boot IDs and missing start ticks', () => {
  for (const boot of ['', 'not-a-boot-id', '-'.repeat(36), 'a'.repeat(36)]) {
    assert.equal(readProcessIdentity(424242, {
      platform: 'linux', readFile: path => path.endsWith('/stat') ? PROC_STAT : boot,
    }), null, boot);
  }
  for (const stat of ['424242 (worker) R 4 5\n', PROC_STAT.replace('8675309', 'unknown')]) {
    assert.equal(readProcessIdentity(424242, {
      platform: 'linux', readFile: path => path.endsWith('/stat') ? stat : BOOT_ID,
    }), null);
  }
});

test('readProcessIdentity returns identity doubt for a missing proc entry', () => {
  const reads = [];
  assert.equal(readProcessIdentity(424242, {
    platform: 'linux', readFile: path => {
      reads.push(path);
      if (path.endsWith('/stat')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return BOOT_ID;
    },
  }), null);
  assert.deepEqual(reads, ['/proc/sys/kernel/random/boot_id', '/proc/424242/stat']);
});
