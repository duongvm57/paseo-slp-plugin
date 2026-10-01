// tests/plugin-desk-store.test.mjs — P2-a desk store kernel coverage.
//
// Crash coverage is two layers: K uses real SIGKILL child processes at every
// commit-protocol point c1–c5 (plus lockHeld) on both a first and a later
// commit; T throws at the same points in-process. Invariants asserted after
// every crash: I1 the ledger still reads valid, I2 the lock is never stolen
// (an orphaned lock answers RECOVERY_REQUIRED until a recovery authority
// removes it — P2-e semantics are simulated by unlinking the file).
//
// Concurrency C1–C3 is deterministic: a `lockHeld` barrier parks the holder
// child until the parent message, `lockWait` marks the first EEXIST retry of
// each waiter, and parent IPC sequences the schedule. Recovery races are
// excluded per decisions-p2a-cut (they belong to P2-e).
//
// All fixtures live under tmpdir() and are removed in t.after; nothing here
// writes to the repository tree, .local-checks, or depends on git state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeskStore, LEDGER_LIMITS, repoKeyFor } from '../plugin/server/desk-store.ts';
import { canonicalSha256 } from '../plugin/server/config-view.ts';

const REPO = { hostId: 'host-test', gitCommonDir: '/repo/.git' };
const REPO_KEY = repoKeyFor(REPO);
const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const CHILD_URL = new URL('../plugin/server/desk-store.ts', import.meta.url).href;

const reposDir = root => join(root, 'state', 'enforcement', 'repos');
const repoDir = (root, key = REPO_KEY) => join(reposDir(root), key);
const ledgerPath = (root, key = REPO_KEY) => join(repoDir(root, key), 'ledger.json');
const lockPath = (root, key = REPO_KEY) => join(repoDir(root, key), 'lock');
const eventsDir = (root, key = REPO_KEY) => join(repoDir(root, key), 'events');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-desk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function envelope(over = {}) {
  return {
    repo: { ...REPO },
    actorKey: 'actor-1',
    assignmentId: 'assign-1',
    requestId: 'req-1',
    command: { action: 'grant', scope: 'read' },
    ...over,
  };
}

const decideCommit = (v = 1) => () => ({
  ok: true,
  events: [{ kind: 'test.event', payload: { v } }],
});

const decideReject = () => () => ({
  ok: false,
  code: 'AUTHORITY_REQUIRED',
  message: 'authority required for the command',
  recovery: 'change the command',
});

const freshStore = (root, extra = {}) =>
  createDeskStore({ stableRoot: root, ...extra });

const fixedStore = root => freshStore(root, { now: () => new Date(FIXED_NOW) });

function readLedgerFile(root, key = REPO_KEY) {
  return JSON.parse(readFileSync(ledgerPath(root, key), 'utf8'));
}

function allTmpFiles(root) {
  const found = [];
  const walk = dir => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name.endsWith('.tmp')) found.push(p);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(repoDir(root));
  return found;
}

function listSegments(root, key = REPO_KEY) {
  const dir = eventsDir(root, key);
  return existsSync(dir) ? readdirSync(dir).filter(n => /^\d+-\d+\.jsonl$/.test(n)).sort() : [];
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(res => child.once('exit', res));
  return child.pid;
}

// --- Child-process harness --------------------------------------------------

const CHILD_SOURCE = `
import { createDeskStore } from ${JSON.stringify(CHILD_URL)};
import { writeFileSync } from 'node:fs';
const spec = JSON.parse(process.argv[2]);
const send = m => { if (process.send) process.send(m); };
const faults = {};
if (spec.killAt) faults[spec.killAt] = () => { process.kill(process.pid, 'SIGKILL'); };
if (spec.hold) {
  faults.lockHeld = () => new Promise(resolve => {
    send('locked');
    const on = m => { if (m === 'go') { process.off('message', on); resolve(); } };
    process.on('message', on);
  });
}
if (spec.signalWait) {
  let signaled = false;
  faults.lockWait = async () => { if (!signaled) { signaled = true; send('waiting'); } };
}
const deps = { stableRoot: spec.stableRoot, faults };
if (spec.fixedNow) deps.now = () => new Date(spec.fixedNow);
const store = createDeskStore(deps);
try {
  const result = await store.transact(spec.repoKey, spec.envelope, () => spec.reject
    ? { ok: false, code: 'AUTHORITY_REQUIRED', message: 'denied', recovery: 'fix' }
    : { ok: true, events: [{ kind: 'test.event', payload: { v: spec.v ?? 1 } }] });
  if (spec.resultPath) writeFileSync(spec.resultPath, JSON.stringify(result));
  console.log('RESULT ' + JSON.stringify(result));
} catch (error) {
  console.log('ERROR ' + (error && error.code ? error.code : String(error)));
  process.exitCode = 3;
}
`;

function writeChildScript(dir) {
  const path = join(dir, 'desk-child.mjs');
  writeFileSync(path, CHILD_SOURCE);
  return path;
}

const CHILD_WATCHDOG_MS = 30_000;
const CHILD_MESSAGE_MS = 20_000;

function spawnChild(t, scriptPath, spec) {
  const child = spawn(process.execPath, [scriptPath, JSON.stringify(spec)], {
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
  // Guaranteed cleanup: a bounded watchdog kills a wedged child, and t.after
  // kills+awaits anything still alive — no orphans even when a test fails
  // mid-schedule (fixtures' tmpdir removal runs alongside via t.after).
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
    child,
    exited,
    send: m => child.send(m),
    onceMessage: name => Promise.race([
      new Promise(res => waiters.push(m => (m === name ? (res(m), true) : false))),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${CHILD_MESSAGE_MS}ms waiting for '${name}': ${stderr}`)), CHILD_MESSAGE_MS)),
    ]),
    output: () => ({ stdout, stderr }),
  };
}

function childResult(dir, name = 'result.json') {
  const path = join(dir, name);
  assert.ok(existsSync(path), `expected child result at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Run a killed child at `point`; returns post-crash context. `later` seeds
 *  one committed revision first so both first-commit and steady-state
 *  commit paths are exercised. */
async function crashAt(t, point, { later = false } = {}) {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  if (later) {
    const seed = fixedStore(root);
    const seeded = await seed.transact(REPO_KEY, envelope({ requestId: 'req-seed' }), decideCommit(0));
    assert.equal(seeded.ok, true);
  }
  const script = writeChildScript(dir);
  const resultPath = join(dir, 'result.json');
  const killed = envelope({ requestId: 'req-2' });
  const proc = spawnChild(t, script, {
    stableRoot: root,
    repoKey: REPO_KEY,
    envelope: killed,
    killAt: point,
    resultPath,
    fixedNow: FIXED_NOW,
    v: 2,
  });
  const { signal } = await proc.exited;
  assert.equal(signal, 'SIGKILL', `child must die by SIGKILL at ${point}: ${proc.output().stderr}`);
  return { dir, root, resultPath, killed };
}

/** I2 oracle (contract §6 K c2–c4): retry the *same* requestId+body while
 *  the orphan lock stands → RECOVERY_REQUIRED whose message carries the dead
 *  holder's pid and instance nonce; the lock file's bytes are byte-identical
 *  before and after the retry — the store never touches it. Simulating the
 *  P2-e recovery authority: the test unlinks the lock itself afterwards. */
async function assertOrphanLock(root, killedEnvelope, t) {
  const lock = lockPath(root);
  assert.ok(existsSync(lock), 'killed holder must leave its lock file');
  const holder = JSON.parse(readFileSync(lock, 'utf8'));
  const bytesBefore = readFileSync(lock);
  const retry = freshStore(root, { now: () => new Date(FIXED_NOW) });
  const denied = await retry.transact(REPO_KEY, killedEnvelope, decideCommit(2));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'RECOVERY_REQUIRED');
  assert.match(denied.message, new RegExp(`pid ${holder.pid}`), 'message must name the dead pid');
  assert.match(denied.message, new RegExp(String(holder.instanceNonce).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'message must name the dead nonce');
  assert.deepEqual(readFileSync(lock), bytesBefore, 'I2: lock bytes must be identical before and after the denied retry');
  unlinkSync(lock); // recovery authority (P2-e) simulated by the test
  return retry;
}

const assertIoFailure = error => {
  assert.equal(error?.name, 'OperationConflict');
  assert.equal(error?.code, 'IO_FAILURE');
  return true;
};

// --- read() -----------------------------------------------------------------

test('read: absent repo directory and empty repo directory are both absent', t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);
  assert.equal(store.read(REPO_KEY).state, 'absent');
  mkdirSync(repoDir(root), { recursive: true });
  assert.equal(store.read(REPO_KEY).state, 'absent');
});

test('read: malformed repoKey is unsafe, never a crash', t => {
  const dir = fixture(t);
  const store = freshStore(join(dir, 'stable'));
  for (const key of ['', 'xyz', 'A'.repeat(64), '0'.repeat(63)]) {
    const result = store.read(key);
    assert.equal(result.state, 'unsafe', key);
    assert.equal(result.diagnostics.code, 'repo-key-invalid');
  }
});

test('read: invalid JSON, wrong header, schema-invalid, and oversized ledger are corrupt', t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);
  mkdirSync(repoDir(root), { recursive: true });

  writeFileSync(ledgerPath(root), '{not json');
  let result = store.read(REPO_KEY);
  assert.equal(result.state, 'corrupt');
  assert.equal(result.diagnostics.code, 'invalid-json');

  writeFileSync(ledgerPath(root), JSON.stringify({ format: 'other', schemaVersion: 1 }));
  result = store.read(REPO_KEY);
  assert.equal(result.state, 'corrupt');
  assert.equal(result.diagnostics.code, 'header-invalid');

  writeFileSync(ledgerPath(root), JSON.stringify({ format: 'paseo-slp/enforcement', schemaVersion: 1 }));
  result = store.read(REPO_KEY);
  assert.equal(result.state, 'corrupt');
  assert.equal(result.diagnostics.code, 'schema-invalid');
  assert.equal(result.diagnostics.schemaVersion, 1);

  writeFileSync(ledgerPath(root), JSON.stringify({
    format: 'paseo-slp/enforcement',
    schemaVersion: 1,
    repo: { repoKey: REPO_KEY, repoKeyAlgorithm: 'sha256(hostId|gitCommonDir)@1', hostId: REPO.hostId, gitCommonDir: REPO.gitCommonDir },
    revision: 0,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    lastEventSeq: 0,
    lastEventSha256: null,
    requests: [{ bogus: true }],
  }));
  result = store.read(REPO_KEY);
  assert.equal(result.state, 'corrupt');
  assert.equal(result.diagnostics.code, 'schema-invalid');

  writeFileSync(ledgerPath(root), ' '.repeat(LEDGER_LIMITS.ledgerBytes + 1));
  result = store.read(REPO_KEY);
  assert.equal(result.state, 'corrupt');
  assert.equal(result.diagnostics.code, 'oversized');
});

test('read: schemaVersion 5 is future, never corrupt and never overwritten', t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);
  mkdirSync(repoDir(root), { recursive: true });
  const body = JSON.stringify({ format: 'paseo-slp/enforcement', schemaVersion: 5, anything: 'goes' });
  writeFileSync(ledgerPath(root), body);
  const result = store.read(REPO_KEY);
  assert.equal(result.state, 'future');
  assert.equal(result.diagnostics.code, 'future-version');
  assert.equal(result.diagnostics.schemaVersion, 5);
  assert.equal(readFileSync(ledgerPath(root), 'utf8'), body, 'future ledger must not be modified');
});

test('read: symlinked ancestors and a non-file ledger are unsafe', t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);

  // ledger.json as a directory → not-regular-file
  mkdirSync(ledgerPath(root), { recursive: true });
  let result = store.read(REPO_KEY);
  assert.equal(result.state, 'unsafe');
  assert.equal(result.diagnostics.code, 'not-regular-file');
  rmSync(ledgerPath(root), { recursive: true });

  // symlinked repo directory → unsafe-path ancestor
  const real = join(dir, 'elsewhere');
  mkdirSync(real, { recursive: true });
  rmSync(repoDir(root), { recursive: true });
  symlinkSync(real, repoDir(root));
  result = store.read(REPO_KEY);
  assert.equal(result.state, 'unsafe');
  assert.equal(result.diagnostics.code, 'unsafe-path');
});

test('read: ledger repoKey / algorithm / binding mismatches are unsafe', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);
  assert.equal((await store.transact(REPO_KEY, envelope(), decideCommit())).ok, true);
  const ledger = readLedgerFile(root);

  // Path repoKey differs from the ledger's recorded repoKey.
  const other = { hostId: 'host-other', gitCommonDir: '/repo/.git' };
  const otherKey = repoKeyFor(other);
  mkdirSync(repoDir(root, otherKey), { recursive: true });
  writeFileSync(ledgerPath(root, otherKey), JSON.stringify(ledger));
  const moved = store.read(otherKey);
  assert.equal(moved.state, 'unsafe');
  assert.equal(moved.diagnostics.code, 'repo-mismatch');

  // Wrong algorithm label fails the z.literal at schema level → corrupt.
  ledger.repo.repoKeyAlgorithm = 'sha1@0';
  writeFileSync(ledgerPath(root), JSON.stringify(ledger));
  const bad = store.read(REPO_KEY);
  assert.equal(bad.state, 'corrupt');
  assert.equal(bad.diagnostics.code, 'schema-invalid');
});

test('read: refinement failures — duplicate keys, dangling eventSeqs, seq/digest mismatch', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);
  assert.equal((await store.transact(REPO_KEY, envelope(), decideCommit())).ok, true);
  const ledger = readLedgerFile(root);

  const dup = { ...ledger, requests: [ledger.requests[0], { ...ledger.requests[0] }] };
  writeFileSync(ledgerPath(root), JSON.stringify(dup));
  let result = store.read(REPO_KEY);
  assert.equal(result.state, 'corrupt');
  assert.equal(result.diagnostics.code, 'refinement-failed');

  const dangling = { ...ledger, requests: [{ ...ledger.requests[0], eventSeqs: [1, 99] }] };
  writeFileSync(ledgerPath(root), JSON.stringify(dangling));
  result = store.read(REPO_KEY);
  assert.equal(result.state, 'corrupt');
  assert.equal(result.diagnostics.code, 'refinement-failed');

  const mismatched = { ...ledger, lastEventSeq: 0, lastEventSha256: 'f'.repeat(64) };
  writeFileSync(ledgerPath(root), JSON.stringify(mismatched));
  result = store.read(REPO_KEY);
  assert.equal(result.state, 'corrupt');
});

test('read: hash chain — tampered event, removed segment are corrupt; orphan segment is ignored', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = fixedStore(root);
  assert.equal((await store.transact(REPO_KEY, envelope({ requestId: 'r1' }), decideCommit(1))).ok, true);
  assert.equal((await store.transact(REPO_KEY, envelope({ requestId: 'r2' }), decideCommit(2))).ok, true);
  assert.deepEqual(listSegments(root), ['1-1.jsonl', '2-2.jsonl']);

  // Tamper one byte inside seq 1's payload.
  const seg1 = join(eventsDir(root), '1-1.jsonl');
  const event = JSON.parse(readFileSync(seg1, 'utf8'));
  event.payload.v = 999;
  writeFileSync(seg1, JSON.stringify(event) + '\n');
  let result = store.read(REPO_KEY);
  assert.equal(result.state, 'corrupt');
  assert.equal(result.diagnostics.code, 'hash-chain-broken');

  // Restore, then remove the first segment → gap in the chain.
  await store.transact(REPO_KEY, envelope({ requestId: 'r3' }), decideReject()); // still committed row
  writeFileSync(seg1, JSON.stringify({ ...event, payload: { v: 1 } }) + '\n');
  unlinkSync(seg1);
  result = store.read(REPO_KEY);
  assert.equal(result.state, 'corrupt');
  assert.equal(result.diagnostics.code, 'hash-chain-broken');
});

test('read: unexpected segment I/O throws IO_FAILURE — corrupt is reserved for bad bytes', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);
  assert.equal((await store.transact(REPO_KEY, envelope(), decideCommit())).ok, true);

  // Structural corruption stays a *returned* corrupt state…
  const segment = join(eventsDir(root), '1-1.jsonl');
  const good = readFileSync(segment, 'utf8');
  writeFileSync(segment, '{"tampered":true}\n');
  const corrupt = store.read(REPO_KEY);
  assert.equal(corrupt.state, 'corrupt');
  assert.equal(corrupt.diagnostics.code, 'hash-chain-broken');

  // …but a filesystem fault on the same segment throws IO_FAILURE.
  writeFileSync(segment, good);
  if (process.platform !== 'win32') {
    const stat = statSync(segment);
    t.after(() => { try { chmodSync(segment, stat.mode); } catch { /* dir removed anyway */ } });
    chmodSync(segment, 0o000);
    assert.throws(() => store.read(REPO_KEY), assertIoFailure);
    chmodSync(segment, stat.mode);
    assert.equal(store.read(REPO_KEY).state, 'ok');
  }
});

// --- transact: envelope & decide guards -------------------------------------

test('transact: malformed envelope, repoKey mismatch, and oversized ids are INVALID_RECORD', async t => {
  const dir = fixture(t);
  const store = freshStore(join(dir, 'stable'));

  for (const bad of [null, {}, { ...envelope(), extra: 1 }, { ...envelope(), requestId: 'x'.repeat(LEDGER_LIMITS.idLen + 1) }]) {
    const result = await store.transact(REPO_KEY, bad, decideCommit());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_RECORD');
  }

  const wrongKey = await store.transact('0'.repeat(64), envelope(), decideCommit());
  assert.equal(wrongKey.code, 'INVALID_RECORD');

  const badKeyFormat = await store.transact('not-hex', envelope(), decideCommit());
  assert.equal(badKeyFormat.code, 'INVALID_RECORD');

  // The envelope's own binding must match the addressed repoKey.
  const mismatched = envelope({ repo: { hostId: 'host-x', gitCommonDir: '/repo/.git' } });
  const result = await store.transact(REPO_KEY, mismatched, decideCommit());
  assert.equal(result.code, 'INVALID_RECORD');
});

test('transact: ledger repo binding must equal envelope repo on an existing ledger', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);
  assert.equal((await store.transact(REPO_KEY, envelope(), decideCommit())).ok, true);
  // A foreign repo yields a different repoKey, so the envelope check rejects
  // it before the ledger binding check — INVALID_RECORD either way.
  const foreign = envelope({ repo: { hostId: 'other-host', gitCommonDir: '/repo/.git' } });
  const result = await store.transact(REPO_KEY, foreign, decideCommit());
  assert.equal(result.code, 'INVALID_RECORD');
});

test('transact: decide purity — throw, async, malformed shapes all INVALID_RECORD, nothing commits', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);
  const cases = [
    () => { throw new Error('boom'); },
    async () => ({ ok: true, events: [] }),
    () => ({ ok: true, events: 'nope' }),
    () => ({ ok: true }),
    () => 42,
    () => ({ ok: false, code: 'NOT_A_CODE' }),
    ledger => { ledger.requests.push({}); return { ok: true, events: [] }; }, // mutate frozen snapshot
  ];
  for (const [index, decide] of cases.entries()) {
    const result = await store.transact(REPO_KEY, envelope({ requestId: `bad-${index}` }), decide);
    assert.equal(result.ok, false, `case ${index}`);
    assert.equal(result.code, 'INVALID_RECORD', `case ${index}`);
  }
  const state = store.read(REPO_KEY);
  assert.equal(state.state, 'absent', 'a rejected decide path must leave no ledger');
});

test('transact: decide event bounds — count and payload bytes', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);

  const tooMany = await store.transact(REPO_KEY, envelope({ requestId: 'r-many' }),
    () => ({ ok: true, events: Array.from({ length: LEDGER_LIMITS.eventsPerCommit + 1 }, (_, i) => ({ kind: 'k', payload: { i } })) }));
  assert.equal(tooMany.code, 'INVALID_RECORD');

  const fat = await store.transact(REPO_KEY, envelope({ requestId: 'r-fat' }),
    () => ({ ok: true, events: [{ kind: 'k', payload: { blob: 'x'.repeat(LEDGER_LIMITS.eventPayloadBytes) } }] }));
  assert.equal(fat.code, 'INVALID_RECORD');

  const uncodable = await store.transact(REPO_KEY, envelope({ requestId: 'r-nc' }),
    () => ({ ok: true, events: [{ kind: 'k', payload: { big: 1n } }] }));
  assert.equal(uncodable.code, 'INVALID_RECORD');

  const badKind = await store.transact(REPO_KEY, envelope({ requestId: 'r-k' }),
    () => ({ ok: true, events: [{ kind: 'k'.repeat(LEDGER_LIMITS.eventKind + 1), payload: {} }] }));
  assert.equal(badKind.code, 'INVALID_RECORD');

  assert.equal(store.read(REPO_KEY).state, 'absent');
});

test('transact: non-canonicalizable command body is INVALID_RECORD', async t => {
  const dir = fixture(t);
  const store = freshStore(join(dir, 'stable'));
  const result = await store.transact(REPO_KEY, envelope({ command: { big: 1n } }), decideCommit());
  assert.equal(result.code, 'INVALID_RECORD');
});

// --- commit semantics ---------------------------------------------------------

test('commit: first commit writes ledger, segment, chain head — and a zero-event commit writes no segment', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = fixedStore(root);

  const withEvent = await store.transact(REPO_KEY, envelope({ requestId: 'r1' }), decideCommit(7));
  assert.equal(withEvent.ok, true);
  assert.equal(withEvent.receipt.replayed, false);
  assert.equal(withEvent.receipt.revision, 1);
  assert.deepEqual(withEvent.receipt.eventSeqs, [1, 1]);
  assert.match(withEvent.receipt.receiptId, /^[0-9a-f-]{36}$/);

  const noEvent = await store.transact(REPO_KEY, envelope({ requestId: 'r2' }), () => ({ ok: true, events: [] }));
  assert.equal(noEvent.ok, true);
  assert.equal(noEvent.receipt.eventSeqs, null);
  assert.equal(noEvent.receipt.revision, 2);

  const ledger = readLedgerFile(root);
  assert.equal(ledger.format, 'paseo-slp/enforcement');
  assert.equal(ledger.schemaVersion, 4);
  assert.equal(ledger.revision, 2);
  assert.equal(ledger.lastEventSeq, 1);
  assert.equal(typeof ledger.lastEventSha256, 'string');
  assert.equal(ledger.requests.length, 2);
  assert.equal(ledger.requests[0].outcome, 'committed');
  assert.equal(ledger.requests[0].rejection, null);
  assert.equal(ledger.requests[0].canonicalization, 'slp-canonical-json/1');
  assert.equal(ledger.repo.repoKeyAlgorithm, 'sha256(hostId|gitCommonDir)@1');
  assert.equal(ledger.repo.repoKey, REPO_KEY);
  assert.equal(ledger.createdAt, FIXED_NOW);

  // Hash chain: seq 1 has prevSha256 null and a self-consistent digest.
  const [line] = readFileSync(join(eventsDir(root), '1-1.jsonl'), 'utf8').trim().split('\n');
  const event = JSON.parse(line);
  assert.equal(event.seq, 1);
  assert.equal(event.prevSha256, null);
  const { sha256, ...rest } = event;
  assert.equal(sha256, canonicalSha256(rest));
  assert.equal(sha256, ledger.lastEventSha256);

  // File states: private modes, no temps, lock released.
  if (process.platform !== 'win32') {
    assert.equal(statSync(repoDir(root)).mode & 0o777, 0o700);
    assert.equal(statSync(ledgerPath(root)).mode & 0o777, 0o600);
  }
  assert.deepEqual(allTmpFiles(root), []);
  assert.equal(existsSync(lockPath(root)), false);
});

test('commit: rejected decisions are committed as request rows and replay the same rejection', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);

  const rejected = await store.transact(REPO_KEY, envelope({ requestId: 'rj' }), decideReject());
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'AUTHORITY_REQUIRED');

  const ledger = readLedgerFile(root);
  assert.equal(ledger.requests.length, 1);
  assert.equal(ledger.requests[0].outcome, 'rejected');
  assert.equal(ledger.requests[0].rejection.code, 'AUTHORITY_REQUIRED');
  assert.equal(ledger.requests[0].eventSeqs, null);
  assert.equal(ledger.lastEventSeq, 0, 'rejected decisions write no events');
  assert.deepEqual(listSegments(root), []);

  const replay = await store.transact(REPO_KEY, envelope({ requestId: 'rj' }), decideCommit());
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'AUTHORITY_REQUIRED', 'replay must return the committed rejection');
});

test('idempotency: exact replay is field-identical, body change is IDEMPOTENCY_CONFLICT, restart replays too', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);

  const first = await store.transact(REPO_KEY, envelope({ requestId: 'r1' }), decideCommit(1));
  const replay = await store.transact(REPO_KEY, envelope({ requestId: 'r1' }), decideCommit(2)); // decide never runs
  assert.deepEqual(replay, { ok: true, receipt: { ...first.receipt, replayed: true } });

  const conflict = await store.transact(REPO_KEY, envelope({ requestId: 'r1', command: { action: 'revoke' } }), decideCommit());
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');

  // Same requestId under a different actor is a different idempotency key.
  const other = await store.transact(REPO_KEY, envelope({ requestId: 'r1', actorKey: 'actor-2' }), decideCommit());
  assert.equal(other.ok, true);
  assert.equal(other.receipt.replayed, false);

  // Replay across a store restart — the durable table owns the record.
  const restarted = freshStore(root);
  const afterRestart = await restarted.transact(REPO_KEY, envelope({ requestId: 'r1' }), decideCommit(3));
  assert.deepEqual(afterRestart, { ok: true, receipt: { ...first.receipt, replayed: true } });
});

test('bodySha256: the literal digest of {repo, command} is recorded and excludes the idempotency key', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);
  await store.transact(REPO_KEY, envelope(), decideCommit());
  const ledger = readLedgerFile(root);
  assert.equal(
    ledger.requests[0].bodySha256,
    '056f9c1fd9b714df9d3b8272959764aae91aabebe93189222758beafc8e55a12',
    'canonicalSha256({repo,command}) literal',
  );
  assert.equal(ledger.requests[0].bodySha256, canonicalSha256({ repo: REPO, command: { action: 'grant', scope: 'read' } }));
});

test('bounded requests: a ledger at the cap rejects with INVALID_RECORD', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = fixedStore(root);
  assert.equal((await store.transact(REPO_KEY, envelope(), decideCommit())).ok, true);
  const ledger = readLedgerFile(root);
  ledger.requests = Array.from({ length: LEDGER_LIMITS.requests }, (_, i) => ({
    ...ledger.requests[0],
    requestId: `fill-${i}`,
  }));
  writeFileSync(ledgerPath(root), JSON.stringify(ledger));
  const result = await store.transact(REPO_KEY, envelope({ requestId: 'overflow' }), decideCommit());
  assert.equal(result.code, 'INVALID_RECORD');
  assert.match(result.message, /full/);

  // And one past the cap fails closed on read — boundedness is structural.
  ledger.requests.push({ ...ledger.requests[0], requestId: 'one-too-many' });
  writeFileSync(ledgerPath(root), JSON.stringify(ledger));
  const state = store.read(REPO_KEY);
  assert.equal(state.state, 'corrupt');
  assert.equal(state.diagnostics.code, 'schema-invalid');
});

// --- lock behavior ------------------------------------------------------------

test('lock: live holder → CAPABILITY_GAP; dead or unparseable holder → RECOVERY_REQUIRED; file never removed', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const store = freshStore(root);
  mkdirSync(repoDir(root), { recursive: true });

  // Live foreign holder.
  writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, instanceNonce: 'foreign', startedAt: FIXED_NOW }));
  const busy = await store.transact(REPO_KEY, envelope(), decideCommit());
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'CAPABILITY_GAP');
  assert.match(busy.recovery, /desk-busy/);
  assert.ok(existsSync(lockPath(root)), 'live lock must remain');

  // Dead holder.
  writeFileSync(lockPath(root), JSON.stringify({ pid: await deadPid(), instanceNonce: 'dead', startedAt: FIXED_NOW }));
  const dead = await store.transact(REPO_KEY, envelope(), decideCommit());
  assert.equal(dead.code, 'RECOVERY_REQUIRED');
  assert.ok(existsSync(lockPath(root)), 'dead lock is not removed by the store');

  // Unparseable holder.
  writeFileSync(lockPath(root), 'garbage');
  const garbage = await store.transact(REPO_KEY, envelope(), decideCommit());
  assert.equal(garbage.code, 'RECOVERY_REQUIRED');
});

test('lock: unsafe ancestors yield STATE_UNREADABLE without touching the path', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const real = join(dir, 'real-repo-dir');
  mkdirSync(real, { recursive: true });
  mkdirSync(join(root, 'state', 'enforcement', 'repos'), { recursive: true });
  symlinkSync(real, repoDir(root));
  const store = freshStore(root);
  const result = await store.transact(REPO_KEY, envelope(), decideCommit());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STATE_UNREADABLE');
});

test('mutex: two in-process transacts serialize — one commit at a time', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  let release;
  let parked = false;
  const seenRevisions = [];
  // Single-shot barrier: only p1 parks at lockHeld; p2 must not see it.
  const store = freshStore(root, {
    faults: {
      lockHeld: () => {
        if (parked) return;
        parked = true;
        return new Promise(res => { release = res; });
      },
    },
  });

  const p1 = store.transact(REPO_KEY, envelope({ requestId: 'm1' }),
    ledger => { seenRevisions.push(ledger.revision); return { ok: true, events: [] }; });
  for (let i = 0; i < 1000 && release === undefined; i += 1) {
    await new Promise(res => setImmediate(res)); // deterministic: wait until p1 holds
  }
  assert.ok(release, 'p1 must reach lockHeld');
  const p2 = store.transact(REPO_KEY, envelope({ requestId: 'm2' }),
    ledger => { seenRevisions.push(ledger.revision); return { ok: true, events: [] }; });
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.deepEqual(seenRevisions, [0, 1], 'second decide must observe the first commit');
  assert.equal(r1.receipt.revision, 1);
  assert.equal(r2.receipt.revision, 2);
});

// --- crash T: thrown faults at every commit point ----------------------------

const COMMIT_POINTS = ['beforeLock', 'lockHeld', 'segmentTempWritten', 'segmentRenamed', 'ledgerCommitted', 'afterComplete'];

for (const point of COMMIT_POINTS) {
  test(`crash-T@${point}: thrown fault → IO_FAILURE, ledger stays valid, lock released`, async t => {
    const dir = fixture(t);
    const root = join(dir, 'stable');
    const faults = { [point]: () => { throw new Error(`fault@${point}`); } };
    const store = freshStore(root, { faults, now: () => new Date(FIXED_NOW) });
    await assert.rejects(() => store.transact(REPO_KEY, envelope({ requestId: 'r1' }), decideCommit(1)), assertIoFailure);

    // I1: the ledger reads valid — absent or committed, never torn.
    const state = freshStore(root).read(REPO_KEY);
    assert.ok(['absent', 'ok'].includes(state.state), `I1: got ${state.state}`);

    // I2: the lock was released, not left behind.
    assert.equal(existsSync(lockPath(root)), false, `lock must be released after T@${point}`);

    // Retry the identical request: committed crashes replay, pre-commit crashes commit.
    const retry = freshStore(root, { now: () => new Date(FIXED_NOW) });
    const result = await retry.transact(REPO_KEY, envelope({ requestId: 'r1' }), decideCommit(1));
    assert.equal(result.ok, true);
    if (point === 'ledgerCommitted' || point === 'afterComplete') {
      assert.equal(result.receipt.replayed, true, `${point} commits before the fault → replay`);
      assert.equal(readLedgerFile(root).revision, 1);
    } else {
      assert.equal(result.receipt.replayed, false, `${point} faults before commit → fresh commit`);
      assert.equal(readLedgerFile(root).revision, 1);
    }
    assert.deepEqual(allTmpFiles(root), [], 'no temp files may remain');
  });
}

test('crash-T@segmentRenamed: orphan segment is overwritten with identical bytes on retry', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const faults = { segmentRenamed: () => { throw new Error('fault@segmentRenamed'); } };
  const store = freshStore(root, { faults, now: () => new Date(FIXED_NOW) });
  await assert.rejects(() => store.transact(REPO_KEY, envelope({ requestId: 'r1' }), decideCommit(1)), assertIoFailure);

  const segment = join(eventsDir(root), '1-1.jsonl');
  const orphanBytes = readFileSync(segment, 'utf8');
  assert.equal(freshStore(root).read(REPO_KEY).state, 'absent', 'uncommitted segment carries no authority');

  const retry = freshStore(root, { now: () => new Date(FIXED_NOW) });
  const result = await retry.transact(REPO_KEY, envelope({ requestId: 'r1' }), decideCommit(1));
  assert.equal(result.ok, true);
  assert.equal(readFileSync(segment, 'utf8'), orphanBytes, 'A3: overwrite reproduces the same durable bytes');
});

// --- crash K: real SIGKILL at every commit point, first and later commit -----

for (const point of COMMIT_POINTS) {
  for (const later of [false, true]) {
    test(`crash-K@${point} (${later ? 'later' : 'first'} commit): invariants I1/I2 hold`, async t => {
      const { root, killed } = await crashAt(t, point, { later });
      const reader = freshStore(root);

      // I1 — the ledger is always a valid document: absent before the commit
      // point, ok at/after it; the hash chain verifies either way.
      const state = reader.read(REPO_KEY);
      const committed = point === 'ledgerCommitted' || point === 'afterComplete';
      if (committed) {
        assert.equal(state.state, 'ok', `${point}: commit must be durable`);
        assert.equal(state.ledger.revision, later ? 2 : 1);
      } else {
        assert.equal(state.state, later ? 'ok' : 'absent', `${point}: pre-commit ledger must be clean`);
        if (later) assert.equal(state.ledger.revision, 1);
      }

      // Point-specific durable debris: segment temp at c2, named orphan at c3.
      const eventFiles = existsSync(eventsDir(root)) ? readdirSync(eventsDir(root)) : [];
      if (point === 'segmentTempWritten') {
        assert.ok(eventFiles.some(n => n.endsWith('.tmp')), 'c2 leaves a temp segment');
        assert.equal(eventFiles.filter(n => n.endsWith('.jsonl')).length, later ? 1 : 0);
      }
      if (point === 'segmentRenamed') {
        const orphan = later ? '2-2.jsonl' : '1-1.jsonl';
        assert.ok(eventFiles.includes(orphan), 'c3 leaves an orphan segment');
      }

      // I2 — a crash before the lock attempt or after release leaves no
      // lock; every other point orphans a lock that is classified
      // RECOVERY_REQUIRED on the same requestId/body, bytes untouched.
      let retry;
      if (point === 'beforeLock' || point === 'afterComplete') {
        assert.equal(existsSync(lockPath(root)), false, `${point} crash leaves no lock`);
        retry = freshStore(root, { now: () => new Date(FIXED_NOW) });
      } else {
        retry = await assertOrphanLock(root, killed, t);
      }

      // After simulated recovery, the identical request resolves.
      const result = await retry.transact(REPO_KEY, killed, decideCommit(2));
      assert.equal(result.ok, true);
      if (committed) {
        assert.equal(result.receipt.replayed, true, 'post-commit crash replays');
        const recorded = readLedgerFile(root).requests.find(r => r.requestId === 'req-2');
        assert.equal(result.receipt.receiptId, recorded.receiptId, 'replay returns the committed receiptId');
      } else {
        assert.equal(result.receipt.replayed, false, 'pre-commit crash commits anew');
      }
    });
  }
}

// --- deterministic concurrency C1–C3 ------------------------------------------

test('C1: holder barrier → waiter retries → sequential commits, revisions 1 then 2', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const script = writeChildScript(dir);

  const a = spawnChild(t, script, {
    stableRoot: root, repoKey: REPO_KEY, hold: true, v: 1,
    envelope: envelope({ requestId: 'A' }), resultPath: join(dir, 'a.json'),
  });
  await a.onceMessage('locked');

  const b = spawnChild(t, script, {
    stableRoot: root, repoKey: REPO_KEY, signalWait: true, v: 2,
    envelope: envelope({ requestId: 'B' }), resultPath: join(dir, 'b.json'),
  });
  await b.onceMessage('waiting'); // deterministic: B has observed the held lock

  a.send('go');
  const [ra, rb] = await Promise.all([a.exited, b.exited]);
  assert.equal(ra.code, 0, a.output().stderr);
  assert.equal(rb.code, 0, b.output().stderr);

  const rA = childResult(dir, 'a.json');
  const rB = childResult(dir, 'b.json');
  assert.equal(rA.receipt.revision, 1);
  assert.equal(rB.receipt.revision, 2);
  assert.equal(rA.receipt.replayed, false);
  assert.equal(rB.receipt.replayed, false);

  const ledger = readLedgerFile(root);
  assert.equal(ledger.requests.length, 2);
  assert.equal(ledger.lastEventSeq, 2);
  assert.equal(freshStore(root).read(REPO_KEY).state, 'ok');
});

test('C2: held lock → waiter expires to CAPABILITY_GAP; after release a retry commits', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const script = writeChildScript(dir);

  const a = spawnChild(t, script, {
    stableRoot: root, repoKey: REPO_KEY, hold: true, v: 1,
    envelope: envelope({ requestId: 'A' }), resultPath: join(dir, 'a.json'),
  });
  await a.onceMessage('locked');

  // B waits its full lockWaitMs while A is parked and alive.
  const b = spawnChild(t, script, {
    stableRoot: root, repoKey: REPO_KEY, v: 2,
    envelope: envelope({ requestId: 'B' }), resultPath: join(dir, 'b.json'),
  });
  await b.exited;
  const rB = childResult(dir, 'b.json');
  assert.equal(rB.ok, false);
  assert.equal(rB.code, 'CAPABILITY_GAP', 'live holder must classify as desk-busy');
  assert.ok(existsSync(lockPath(root)), 'A still holds its lock');

  a.send('go');
  await a.exited;
  assert.equal(childResult(dir, 'a.json').receipt.revision, 1);

  const retry = await freshStore(root).transact(REPO_KEY, envelope({ requestId: 'B' }), decideCommit(2));
  assert.equal(retry.ok, true);
  assert.equal(retry.receipt.revision, 2);
});

test('C3: same requestId+body from two processes — one commit, the loser replays it', async t => {
  const dir = fixture(t);
  const root = join(dir, 'stable');
  const script = writeChildScript(dir);
  const shared = envelope({ requestId: 'shared' });

  const a = spawnChild(t, script, {
    stableRoot: root, repoKey: REPO_KEY, hold: true,
    envelope: shared, resultPath: join(dir, 'a.json'),
  });
  await a.onceMessage('locked');

  // B sends the identical envelope — same (actorKey, assignmentId,
  // requestId) and same body — while A is parked holding the lock.
  const b = spawnChild(t, script, {
    stableRoot: root, repoKey: REPO_KEY, signalWait: true,
    envelope: shared, resultPath: join(dir, 'b.json'),
  });
  await b.onceMessage('waiting');

  a.send('go');
  const [ra, rb] = await Promise.all([a.exited, b.exited]);
  assert.equal(ra.code, 0, a.output().stderr);
  assert.equal(rb.code, 0, b.output().stderr);

  const rA = childResult(dir, 'a.json');
  const rB = childResult(dir, 'b.json');
  assert.equal(rA.ok, true);
  assert.equal(rB.ok, true);
  assert.equal(rA.receipt.replayed, false, 'A is the sole committer');
  assert.equal(rB.receipt.replayed, true, 'B replays A\u2019s committed record');
  assert.equal(rB.receipt.receiptId, rA.receipt.receiptId, 'field-identical receiptId across processes');
  assert.equal(rB.receipt.revision, rA.receipt.revision);
  assert.deepEqual(rB.receipt.eventSeqs, rA.receipt.eventSeqs);
  assert.equal(rA.receipt.revision, 1, 'revision increases exactly once');

  const state = freshStore(root).read(REPO_KEY);
  assert.equal(state.state, 'ok');
  assert.equal(state.ledger.revision, 1);
  assert.equal(state.ledger.requests.length, 1, 'exactly one request record');
  assert.equal(state.ledger.requests[0].requestId, 'shared');
  assert.equal(state.ledger.lastEventSeq, 1);
  assert.deepEqual(listSegments(root), ['1-1.jsonl']);
});
