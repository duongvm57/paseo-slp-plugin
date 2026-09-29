// tests/plugin-desk-seat.test.mjs — P2-c seat binding handshake coverage
// (contract §7). The oracle is DESK_FIELD_POLICY: every phase test iterates
// the policy's own entries, so a cell flipped in the policy without a code
// change fails here. The W8 completeness oracle is exercised through the
// TypeScript compiler API on a throwaway program under tmpdir() — the
// negative controls prove the bind is not vacuous. Sweep, budget (G2/G3),
// unhandled-rejection (G4) and handle-secrecy oracles close the slice.
// Fixtures live under tmpdir(); the real daemon home, the repo tree and
// .local-checks are never touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeskStore, LEDGER_LIMITS, repoKeyFor } from '../plugin/server/desk-store.ts';
import {
  DESK_FIELD_POLICY,
  DESK_SEAT_DIAGNOSTICS,
  DESK_HANDLE_KEY,
  MEMBERSHIPS_FULL_PREFIX,
  HANDLE_COLLISION_PREFIX,
  createDeskSeat,
  decideSeatCommand,
} from '../plugin/server/desk-seat.ts';
import { sha256Hex } from '../plugin/server/config-view.ts';
import { OperationConflict } from '../plugin/shared/contracts.ts';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXED_AT = '2026-01-01T00:00:00.000Z';
const PROVIDER = 'slp-codex-peer';

// The git common dir of a plain `git init <dir>` repository.
const gitCommonDirOf = repo => realpathSync(join(repo, '.git'));

function tmp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

// A real Git repo — the ROUTE cell resolves the ledger through it.
function gitRepo(t) {
  const dir = tmp(t, 'slp-seat-repo-');
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function homeFixture(t) {
  const dir = tmp(t, 'slp-seat-home-');
  const home = join(dir, 'home');
  mkdirSync(join(home, 'slp-runtime', 'state'), { recursive: true });
  const canonical = realpathSync(home);
  return { home, canonical, stableRoot: join(canonical, 'slp-runtime') };
}

// A desk-seat wired to a real store under a tmp daemon home; warnings are
// captured, the clock is fixed, and the budget can be shrunk per test.
function seatFixture(t, over = {}) {
  const f = homeFixture(t);
  const repo = gitRepo(t);
  const warnings = [];
  const store = over.store ?? createDeskStore({ stableRoot: f.stableRoot });
  const seat = createDeskSeat({
    stableRoot: f.stableRoot,
    store,
    now: () => new Date(FIXED_AT),
    warn: line => warnings.push(line),
    ...over.deps,
  });
  return { ...f, repo, warnings, store, seat };
}

const mintInput = (repo, over = {}) => ({
  provider: PROVIDER,
  family: 'codex',
  role: 'peer',
  cwd: repo,
  env: {},
  ...over,
});

const openInput = (repo, over = {}) => ({
  agentId: 'agent-1',
  workspaceId: 'wks-1',
  provider: PROVIDER,
  cwd: repo,
  reason: 'create',
  purpose: 'interactive',
  env: {},
  ...over,
});

const createdEvent = (repo, over = {}) => ({
  agent: { id: 'agent-1', workspaceId: 'wks-1', parentAgentId: null, provider: PROVIDER, cwd: repo, title: null },
  ...over,
});

const archivedEvent = (repo, over = {}) => ({
  agent: { id: 'agent-1', workspaceId: 'wks-1', parentAgentId: null, provider: PROVIDER, cwd: repo, title: null },
  archivedAt: '2025-12-31T23:00:00.000Z',
  ...over,
});

const membershipRow = (over = {}) => ({
  membershipId: randomUUID(),
  state: 'unbound-open',
  bindingHandleSha256: sha256Hex('seed-handle'),
  provider: PROVIDER,
  family: 'codex',
  role: 'peer',
  createCwd: '/repo',
  openGeneration: 1,
  agentId: null,
  workspaceId: null,
  createdAt: FIXED_AT,
  hostConfirmedAt: null,
  registeredAt: null,
  revokedAt: null,
  revokeReason: null,
  ...over,
});

// Seed rows through the §2.2 channel: one commit whose decide returns the
// table verbatim (the store validates schema + refinements).
async function seedRows(store, repoKey, rows) {
  const result = await store.transact(
    repoKey,
    {
      repo: { hostId: 'local', gitCommonDir: realpathSync(join(gitCommonDirOf(repoKey))) },
      actorKey: 'desk:hook',
      assignmentId: 'unassigned',
      requestId: randomUUID(),
      command: { kind: 'seed' },
    },
    () => ({ ok: true, events: [], memberships: rows }),
  );
  assert.ok(result.ok, `seed commit failed: ${JSON.stringify(result)}`);
}

// ---------------------------------------------------------------------------
// W8 — the completeness oracle and its negative controls (TS compiler API).
// ---------------------------------------------------------------------------

test('W8: the seven ExactKeys pairs hold on the exported policy value', () => {
  // The type-level bind lives in desk-seat.ts and is checked by
  // `npm run typecheck`; this test pins the runtime-visible half: the
  // policy branches exist with the expected shapes.
  assert.deepEqual(Object.keys(DESK_FIELD_POLICY), ['mint', 'bind', 'register', 'revoke']);
  assert.deepEqual(Object.keys(DESK_FIELD_POLICY.mint), ['config', 'env']);
  assert.deepEqual(Object.keys(DESK_FIELD_POLICY.register), ['agent']);
  assert.deepEqual(Object.keys(DESK_FIELD_POLICY.revoke), ['agent', 'archivedAt']);
});

test('W8 negative control — TypeScript compiler API proves the bind is two-way', t => {
  const tsModule = new URL('../node_modules/typescript/lib/typescript.js', import.meta.url).pathname;
  const ts = require(tsModule);
  const dir = tmp(t, 'slp-w8-');
  const lifecycle = join(ROOT, 'node_modules', '@getpaseo', 'plugin', 'dist', 'server', 'lifecycle.d.ts');
  const deskSeat = join(ROOT, 'plugin', 'server', 'desk-seat.ts');
  const probe = variants => `import { DESK_FIELD_POLICY, ExactKeys } from ${JSON.stringify(deskSeat)};
import type { PluginHookAgent } from ${JSON.stringify(lifecycle)};
${variants.map((v, i) => `const p${i}: ExactKeys<typeof DESK_FIELD_POLICY.register.agent, ${v}> = true;`).join('\n')}
${variants.map((_, i) => `void p${i};`).join('\n')}
`;
  const options = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  };
  const errorsFor = source => {
    const file = join(dir, 'probe.ts');
    writeFileSync(file, source);
    const program = ts.createProgram([file], options);
    return ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
  };
  const exact = errorsFor(probe(['PluginHookAgent']));
  assert.equal(exact.length, 0, exact.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  const extra = errorsFor(probe(['PluginHookAgent & { extraProbeField: string }']));
  assert.ok(extra.length > 0, 'a source key missing from the policy must fail typecheck');
  const missing = errorsFor(probe(['Omit<PluginHookAgent, "title">']));
  assert.ok(missing.length > 0, 'a policy key missing from the source must fail typecheck');
});

// ---------------------------------------------------------------------------
// §3 decide — guard state, sweep bounds, event budget (pure, no store).
// ---------------------------------------------------------------------------

test('§3 guard: a host-confirmed row never transitions to attached or active', () => {
  const ledger = {
    memberships: [
      membershipRow({ state: 'host-confirmed', agentId: 'agent-1', workspaceId: 'wks-1', hostConfirmedAt: FIXED_AT }),
    ],
  };
  const out = decideSeatCommand(ledger, {
    kind: 'seat.register', at: FIXED_AT, agentId: 'agent-1', workspaceId: 'wks-1',
    provider: PROVIDER, cwd: '/repo',
  });
  // The register matches every COMPARE_EXACT cell → registeredAt set; the
  // row never leaves the P2-c state set.
  assert.equal(out.ok, true);
  assert.equal(out.memberships[0].state, 'host-confirmed');
  assert.ok(out.memberships[0].registeredAt !== null);
});

test('§3 event budget: ttlSweepPerCommit + 2 ≤ eventsPerCommit (read from the exports)', () => {
  assert.ok(LEDGER_LIMITS.ttlSweepPerCommit + 2 <= LEDGER_LIMITS.eventsPerCommit);
});

test('§3 prefixes: the full-table and collision rejections carry the contract constants', () => {
  assert.equal(MEMBERSHIPS_FULL_PREFIX, 'memberships-full:');
  assert.equal(HANDLE_COLLISION_PREFIX, 'handle-collision:');
  assert.ok(DESK_SEAT_DIAGNOSTICS.includes('memberships-full'));
  assert.ok(DESK_SEAT_DIAGNOSTICS.includes('rejected'));
});

// ---------------------------------------------------------------------------
// Mint — the §7 domain, G1, and the policy-driven cells.
// ---------------------------------------------------------------------------

test('mint: success puts the handle in env only after the row is committed (G1)', async t => {
  const f = seatFixture(t);
  const out = await f.seat.deskMint(mintInput(f.repo));
  assert.ok(out !== null, 'a git cwd mints');
  assert.match(out.handle, /^[0-9a-f]{64}$/, 'the handle is 256 bits of hex');
  const read = f.store.read(repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(f.repo) }));
  assert.equal(read.state, 'ok');
  const rows = read.ledger.memberships.filter(row => row.bindingHandleSha256 === sha256Hex(out.handle));
  assert.equal(rows.length, 1, 'exactly one row carries the handle hash');
  assert.equal(rows[0].state, 'unbound-open');
  assert.equal(rows[0].provider, PROVIDER);
  assert.equal(rows[0].createCwd, realpathSync(f.repo));
  assert.equal(rows[0].agentId, null);
});

test('mint: non-git cwd → not-git diagnostic, no handle, no row', async t => {
  const f = seatFixture(t);
  const plain = tmp(t, 'slp-seat-plain-');
  const out = await f.seat.deskMint(mintInput(plain));
  assert.equal(out, null);
  assert.deepEqual(f.warnings, ['slp: desk mint skipped: not-git']);
  assert.equal(f.store.read(repoKeyFor({ hostId: 'local', gitCommonDir: 'x' })).state, 'absent');
});

test('mint: env already carries the handle → env-collision, no mint', async t => {
  const f = seatFixture(t);
  const out = await f.seat.deskMint(mintInput(f.repo, { env: { SLP_DESK_HANDLE: 'existing' } }));
  assert.equal(out, null);
  assert.deepEqual(f.warnings, ['slp: desk mint skipped: env-collision']);
});

test('mint: missing cwd → no-cwd; non-absolute cwd → no-cwd', async t => {
  const f = seatFixture(t);
  assert.equal(await f.seat.deskMint(mintInput(undefined)), null);
  assert.deepEqual(f.warnings.at(-1), 'slp: desk mint skipped: no-cwd');
  assert.equal(await f.seat.deskMint(mintInput('relative/path')), null);
  assert.deepEqual(f.warnings.at(-1), 'slp: desk mint skipped: no-cwd');
});

test('mint: nonexistent cwd → no-cwd; unreadable cwd → cwd-unresolvable (seam)', async t => {
  const f = seatFixture(t);
  assert.equal(await f.seat.deskMint(mintInput(join(f.home, 'no-such-dir'))), null);
  assert.deepEqual(f.warnings.at(-1), 'slp: desk mint skipped: no-cwd');
  const failing = seatFixture(t, { deps: { realpath: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } } });
  assert.equal(await failing.seat.deskMint(mintInput(failing.repo)), null);
  assert.deepEqual(failing.warnings.at(-1), 'slp: desk mint skipped: cwd-unresolvable');
});

test('mint: a path over the cap → path-too-long (seam)', async t => {
  const f = seatFixture(t, { deps: { realpath: path => (path.length > LEDGER_LIMITS.pathLen ? path : path) } });
  const longCwd = `${f.repo}/${'x'.repeat(LEDGER_LIMITS.pathLen)}`;
  assert.equal(await f.seat.deskMint(mintInput(longCwd)), null);
  assert.deepEqual(f.warnings.at(-1), 'slp: desk mint skipped: path-too-long');
});

test('mint: store corruption → store-unreadable; a slow store → store-timeout with the handle withheld', async t => {
  const corrupt = seatFixture(t, {
    store: {
      read: () => ({ state: 'corrupt', diagnostics: { code: 'invalid-json', schemaVersion: null } }),
      transact: () => Promise.resolve({
        ok: false, code: 'STATE_UNREADABLE', message: 'desk ledger is corrupt', recovery: 'inspect',
      }),
    },
  });
  assert.equal(await corrupt.seat.deskMint(mintInput(corrupt.repo)), null);
  assert.deepEqual(corrupt.warnings.at(-1), 'slp: desk mint skipped: store-unreadable');

  const slow = seatFixture(t, {
    store: { read: () => ({ state: 'absent' }), transact: () => new Promise(() => {}) },
    deps: { transactBudgetMs: 30 },
  });
  const out = await slow.seat.deskMint(mintInput(slow.repo));
  assert.equal(out, null, 'the handle never joins env when the budget expires');
  assert.deepEqual(slow.warnings.at(-1), 'slp: desk mint skipped: store-timeout');
});

test('mint: handle collision → rejected diagnostic; a full table → memberships-full', async t => {
  // Force the collision: the seam returns the same handle bytes twice.
  const fixed = seatFixture(t, { deps: { randomHandle: () => 'fixed-handle' } });
  assert.ok((await fixed.seat.deskMint(mintInput(fixed.repo))) !== null);
  fixed.warnings.length = 0;
  assert.equal(await fixed.seat.deskMint(mintInput(fixed.repo)), null);
  assert.deepEqual(fixed.warnings.at(-1), 'slp: desk mint skipped: rejected');

  // A full table: seed LEDGER_LIMITS.memberships rows through the §2.2
  // channel, then mint — the decide answers with the pinned prefix.
  const full = seatFixture(t);
  const rows = Array.from({ length: LEDGER_LIMITS.memberships }, (_, i) =>
    membershipRow({ bindingHandleSha256: sha256Hex(`row-${i}`) }));
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(full.repo) });
  const seeded = await full.store.transact(
    repoKey,
    { repo: { hostId: 'local', gitCommonDir: gitCommonDirOf(full.repo) }, actorKey: 'desk:hook', assignmentId: 'unassigned', requestId: randomUUID(), command: { kind: 'seed' } },
    () => ({ ok: true, events: [], memberships: rows }),
  );
  assert.ok(seeded.ok);
  await full.seat.deskMint(mintInput(full.repo));
  assert.deepEqual(full.warnings.at(-1), 'slp: desk mint skipped: memberships-full');
});

// ---------------------------------------------------------------------------
// Bind — GATE/JOIN/COMPARE_EXACT cells driven from the policy.
// ---------------------------------------------------------------------------

async function minted(f, handle = 'handle-1') {
  const out = await f.seat.deskMint(mintInput(f.repo, { env: {} }));
  assert.ok(out !== null);
  return out.handle;
}

test('bind: create × interactive with the echoed handle → host-confirmed (W2)', async t => {
  const f = seatFixture(t);
  const { handle } = await f.seat.deskMint(mintInput(f.repo));
  await f.seat.deskBind(openInput(f.repo, { env: { SLP_DESK_HANDLE: handle } }));
  const read = f.store.read(repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(f.repo) }));
  const row = read.ledger.memberships.find(row => row.bindingHandleSha256 === sha256Hex(handle));
  assert.equal(row.state, 'host-confirmed');
  assert.equal(row.agentId, 'agent-1');
  assert.equal(row.workspaceId, 'wks-1');
  assert.ok(row.hostConfirmedAt !== null);
});

test('§7 bind policy — every COMPARE_EXACT cell mismatch → ACTOR_MISMATCH; GATE values → no-op; JOIN miss → no row', async t => {
  const f = seatFixture(t);
  const { handle } = await f.seat.deskMint(mintInput(f.repo));
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(f.repo) });
  const readRow = () => {
    const read = f.store.read(repoKey);
    return read.state === 'ok' ? read.ledger.memberships.find(row => row.bindingHandleSha256 === sha256Hex(handle)) : undefined;
  };
  const exercised = new Set();
  for (const [field, rule] of Object.entries(DESK_FIELD_POLICY.bind)) {
    exercised.add(field);
    f.warnings.length = 0;
    if (rule.cell === 'COMPARE_EXACT') {
      const mutated = openInput(f.repo, {
        env: { SLP_DESK_HANDLE: handle },
        provider: field === 'provider' ? 'slp-pi-peer' : PROVIDER,
        cwd: field === 'cwd' ? gitRepo(t) : f.repo,
      });
      await f.seat.deskBind(mutated);
      assert.deepEqual(f.warnings.at(-1), 'slp: desk bind skipped: rejected', `${field} mismatch rejects`);
      assert.equal(readRow().state, 'unbound-open', `${field} mismatch leaves the row unbound`);
    }
    if (rule.cell === 'GATE') {
      const before = f.store.read(repoKey).ledger.memberships.length;
      await f.seat.deskBind(openInput(f.repo, { env: { SLP_DESK_HANDLE: handle }, [field]: field === 'reason' ? 'resume' : 'history' }));
      assert.equal(f.store.read(repoKey).ledger.memberships.length, before, `${field} gate no-op does not transact`);
      assert.equal(f.warnings.length, 0, `${field} gate no-op is silent`);
    }
    if (rule.cell === 'JOIN') {
      await f.seat.deskBind(openInput(f.repo, { env: {} }));
      assert.equal(f.warnings.length, 0, 'a missing handle is a silent no-op');
    }
    if (rule.cell === 'RECORD') {
      assert.ok(readRow() !== undefined, `${field} is recorded on the row after bind`);
    }
  }
  // Completeness: every policy entry of the phase was visited.
  assert.deepEqual([...exercised].sort(), Object.keys(DESK_FIELD_POLICY.bind).sort());
});

test('bind: revoked handle → STALE_EPOCH rejection; unknown handle → no row branch', async t => {
  const f = seatFixture(t);
  const { handle } = await f.seat.deskMint(mintInput(f.repo));
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(f.repo) });
  // Bind, then revoke through the real archived path.
  await f.seat.deskBind(openInput(f.repo, { env: { SLP_DESK_HANDLE: handle } }));
  await f.seat.deskRevoke(archivedEvent(f.repo));
  const rowBefore = f.store.read(repoKey).ledger.memberships.find(row => row.bindingHandleSha256 === sha256Hex(handle));
  assert.equal(rowBefore.state, 'revoked');
  f.warnings.length = 0;
  await f.seat.deskBind(openInput(f.repo, { env: { SLP_DESK_HANDLE: handle } }));
  assert.deepEqual(f.warnings.at(-1), 'slp: desk bind skipped: rejected');
  // A present-but-unknown handle finds no row → ACTOR_MISMATCH rejection
  // (§3 bind branch 1); the silent no-op is the ABSENT-handle JOIN miss.
  f.warnings.length = 0;
  await f.seat.deskBind(openInput(f.repo, { env: { SLP_DESK_HANDLE: 'f'.repeat(64) } }));
  assert.deepEqual(f.warnings.at(-1), 'slp: desk bind skipped: rejected');
  f.warnings.length = 0;
  await f.seat.deskBind(openInput(f.repo, { env: {} }));
  assert.equal(f.warnings.length, 0, 'an absent handle is a silent no-op');
});

// ---------------------------------------------------------------------------
// Register / revoke.
// ---------------------------------------------------------------------------

test('register: matching cells → registeredAt; any COMPARE_EXACT mismatch → registration-mismatch revoke', async t => {
  const f = seatFixture(t);
  const { handle } = await f.seat.deskMint(mintInput(f.repo));
  await f.seat.deskBind(openInput(f.repo, { env: { SLP_DESK_HANDLE: handle } }));
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(f.repo) });
  const readRow = () => f.store.read(repoKey).ledger.memberships.find(row => row.bindingHandleSha256 === sha256Hex(handle));
  assert.ok(readRow().registeredAt === null, 'not yet registered');
  await f.seat.deskRegister(createdEvent(f.repo));
  assert.ok(readRow().registeredAt !== null, 'registered');
  // A second register is a no-op.
  const stamp = readRow().registeredAt;
  await f.seat.deskRegister(createdEvent(f.repo));
  assert.equal(readRow().registeredAt, stamp);
});

test('§7 register policy — every COMPARE_EXACT mismatch (incl. workspaceId null↔string) revokes', async t => {
  // For each COMPARE_EXACT cell of the register policy: a fresh
  // host-confirmed, unregistered row, then a real agent.created payload
  // that mismatches exactly that cell → the row is revoked with
  // `registration-mismatch`, `revokedAt = at`, and the seat-revoked event
  // carries the pinned payload.
  const mismatchAgent = (field, repo) => ({
    id: 'agent-1',
    workspaceId: field === 'workspaceId' ? 'wks-other' : 'wks-1',
    parentAgentId: null,
    provider: field === 'provider' ? 'slp-pi-peer' : PROVIDER,
    // Same gitCommonDir (same ledger), different realpath — the COMPARE_EXACT
    // cwd cell mismatches without leaving the repo's ledger.
    cwd: field === 'cwd' ? join(repo, '.git') : repo,
    title: null,
  });
  const exercised = [];
  for (const [field, rule] of Object.entries(DESK_FIELD_POLICY.register.agent)) {
    if (rule.cell !== 'COMPARE_EXACT') continue;
    exercised.push(field);
    const fresh = seatFixture(t);
    const { handle } = await fresh.seat.deskMint(mintInput(fresh.repo));
    await fresh.seat.deskBind(openInput(fresh.repo, { env: { SLP_DESK_HANDLE: handle } }));
    const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(fresh.repo) });
    const before = fresh.store.read(repoKey).ledger.memberships.find(row => row.bindingHandleSha256 === sha256Hex(handle));
    assert.equal(before.state, 'host-confirmed', `${field}: the row starts host-confirmed`);
    assert.ok(before.registeredAt === null, `${field}: the row starts unregistered`);
    await fresh.seat.deskRegister({ agent: mismatchAgent(field, fresh.repo) });
    const row = fresh.store.read(repoKey).ledger.memberships.find(row => row.bindingHandleSha256 === sha256Hex(handle));
    assert.equal(row.state, 'revoked', `${field} mismatch revokes the row`);
    assert.equal(row.revokeReason, 'registration-mismatch', `${field} mismatch reason`);
    assert.equal(row.revokedAt, FIXED_AT, `${field}: revokedAt is the server clock`);
    const events = readSeatEvents(fresh.stableRoot, repoKey);
    const revokedEvent = events.filter(event => event.kind === 'seat-revoked').at(-1);
    assert.deepEqual(revokedEvent.payload, { membershipId: before.membershipId, reason: 'registration-mismatch' }, `${field}: the seat-revoked payload`);
  }
  // K4 — the workspaceId pair covers null↔string AND string↔string.
  const fresh = seatFixture(t);
  const { handle } = await fresh.seat.deskMint(mintInput(fresh.repo));
  await fresh.seat.deskBind(openInput(fresh.repo, { env: { SLP_DESK_HANDLE: handle }, workspaceId: null }));
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(fresh.repo) });
  await fresh.seat.deskRegister({ agent: { id: 'agent-1', workspaceId: 'wks-1', parentAgentId: null, provider: PROVIDER, cwd: fresh.repo, title: null } });
  const row = fresh.store.read(repoKey).ledger.memberships.find(row => row.bindingHandleSha256 === sha256Hex(handle));
  assert.equal(row.state, 'revoked', 'null stored vs string observed → registration-mismatch');
  assert.equal(row.revokeReason, 'registration-mismatch');
  // Completeness: every COMPARE_EXACT entry of the register policy ran.
  const policyFields = Object.entries(DESK_FIELD_POLICY.register.agent)
    .filter(([, rule]) => rule.cell === 'COMPARE_EXACT')
    .map(([field]) => field);
  assert.deepEqual(exercised.sort(), policyFields.sort());
});

function readSeatEvents(stableRoot, repoKey) {
  const events = join(stableRoot, 'state', 'enforcement', 'repos', repoKey, 'events');
  const lines = [];
  for (const name of readdirSync(events).sort()) {
    for (const line of readFileSync(join(events, name), 'utf8').split('\n')) {
      if (line.length > 0) lines.push(JSON.parse(line));
    }
  }
  return lines;
}
test('register with no live row → ok, no event, no diagnostic (fail-open)', async t => {
  const f = seatFixture(t);
  await f.seat.deskRegister(createdEvent(f.repo, { agent: { id: 'ghost', workspaceId: null, parentAgentId: null, provider: PROVIDER, cwd: f.repo, title: null } }));
  assert.deepEqual(f.warnings, []);
});

test('revoke: archived revokes the live row with revokedAt = at; no row → silent; non-git cwd → diagnostic', async t => {
  const f = seatFixture(t);
  const { handle } = await f.seat.deskMint(mintInput(f.repo));
  await f.seat.deskBind(openInput(f.repo, { env: { SLP_DESK_HANDLE: handle } }));
  await f.seat.deskRevoke(archivedEvent(f.repo, { archivedAt: '2000-01-01T00:00:00.000Z' }));
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(f.repo) });
  const row = f.store.read(repoKey).ledger.memberships.find(r => r.bindingHandleSha256 === sha256Hex(handle));
  assert.equal(row.state, 'revoked');
  assert.equal(row.revokeReason, 'archived');
  assert.equal(row.revokedAt, FIXED_AT, 'revokedAt uses the server clock, not archivedAt');
  assert.deepEqual(f.warnings, []);
  // archivedAt and the IGNORED cells cannot change the outcome.
  await f.seat.deskRevoke(archivedEvent(f.repo, { agent: { ...archivedEvent(f.repo).agent, title: 'renamed', workspaceId: null, provider: 'slp-pi-peer' } }));
  assert.deepEqual(f.warnings, [], 'a second revoke of a revoked agent is a silent no-op');
  const plain = seatFixture(t);
  await plain.seat.deskRevoke(archivedEvent(tmp(t, 'slp-seat-plain2-')));
  assert.deepEqual(plain.warnings, ['slp: desk revoke skipped: not-git']);
});

// ---------------------------------------------------------------------------
// Sweep — 130 expired rows over three bounded commits.
// ---------------------------------------------------------------------------

test('§3 sweep: 130 expired rows drain over 3 commits (60+60+10), young rows untouched', async t => {
  const f = seatFixture(t);
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(f.repo) });
  const expiredUnbound = Array.from({ length: 70 }, (_, i) =>
    membershipRow({
      bindingHandleSha256: sha256Hex(`unbound-${i}`),
      createdAt: '2025-12-30T00:00:00.000Z',
    }));
  const expiredBound = Array.from({ length: 60 }, (_, i) =>
    membershipRow({
      state: 'host-confirmed',
      agentId: `agent-${i}`,
      workspaceId: null,
      hostConfirmedAt: '2025-12-30T00:00:00.000Z',
      bindingHandleSha256: sha256Hex(`bound-${i}`),
    }));
  const young = membershipRow({ createdAt: FIXED_AT });
  const seeded = await f.store.transact(
    repoKey,
    { repo: { hostId: 'local', gitCommonDir: gitCommonDirOf(f.repo) }, actorKey: 'desk:hook', assignmentId: 'unassigned', requestId: randomUUID(), command: { kind: 'seed' } },
    () => ({ ok: true, events: [], memberships: [...expiredUnbound, ...expiredBound, young] }),
  );
  assert.ok(seeded.ok);
  // Three revoke commits sweep 60 + 60 + 10; none may be refused.
  for (let round = 0; round < 3; round += 1) {
    const result = await f.seat.deskRevoke(archivedEvent(f.repo, { agent: { id: `sweep-${round}`, workspaceId: null, parentAgentId: null, provider: PROVIDER, cwd: f.repo, title: null } }));
    assert.equal(result, undefined);
    const read = f.store.read(repoKey);
    assert.ok(read.state === 'ok');
    assert.ok(read.ledger.requests.at(-1).eventSeqs === null || read.ledger.requests.at(-1).eventSeqs[1] - read.ledger.requests.at(-1).eventSeqs[0] + 1 <= LEDGER_LIMITS.eventsPerCommit, 'no commit exceeded the event cap');
  }
  const final = f.store.read(repoKey);
  const states = Object.fromEntries(final.ledger.memberships.map(row => [row.membershipId, row.state]));
  const revokedCount = Object.values(states).filter(state => state === 'revoked').length;
  assert.equal(revokedCount, 130, 'every expired row is revoked');
  assert.equal(states[young.membershipId], 'unbound-open', 'a young row is untouched');
});

// ---------------------------------------------------------------------------
// G2/G3 — budget, late settle, ordering.
// ---------------------------------------------------------------------------

test('G2/G3: a late-transacting store times out, then settles late without unhandled rejection', async t => {
  const f = homeFixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let settle;
  const slowStore = {
    read: () => ({ state: 'absent' }),
    transact: () => new Promise(resolve => { settle = () => resolve({ ok: true, receipt: { receiptId: 'r', revision: 1, replayed: false, eventSeqs: null } }); }),
  };
  const warnings = [];
  const seat = createDeskSeat({
    stableRoot: f.stableRoot,
    store: slowStore,
    now: () => new Date(FIXED_AT),
    warn: line => warnings.push(line),
    transactBudgetMs: 40,
  });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const out = await seat.deskMint(mintInput(gitRepo(t)));
  assert.equal(out, null, 'the budget expires before the store settles');
  assert.deepEqual(warnings, ['slp: desk mint skipped: store-timeout']);
  release();
  settle();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(unhandled, [], 'the abandoned transact promise had handlers');
});

test('G3: bind over budget → store-timeout; register enqueued before the late bind settles; FIFO keeps the order (resolve and reject paths)', async t => {
  const f = seatFixture(t);
  const { handle } = await f.seat.deskMint(mintInput(f.repo));
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(f.repo) });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  // The delayed store enqueues the real transact SYNCHRONOUSLY (the FIFO
  // position is taken at call time) but resolves the reply past the budget.
  const delayedStore = (innerOutcome) => ({
    read: () => f.store.read(repoKey),
    transact: (key, envelope, decide) => {
      const inner = innerOutcome === 'resolve'
        ? f.store.transact(key, envelope, decide)
        : f.store.transact(key, envelope, decide).then(
            value => value,
            error => { throw error; },
          );
      return new Promise((resolve, reject) => {
        setTimeout(() => { inner.then(resolve, reject); }, 150);
      });
    },
  });

  // (a) resolve path — bind times out at 40 ms, register is called while
  // the bind transact is still in flight, and the late settle still lands
  // the row through unbound-open → host-confirmed → registeredAt.
  const resolving = createDeskSeat({
    stableRoot: f.stableRoot,
    store: delayedStore('resolve'),
    now: () => new Date(FIXED_AT),
    warn: line => f.warnings.push(line),
    transactBudgetMs: 40,
  });
  await resolving.deskBind(openInput(f.repo, { env: { SLP_DESK_HANDLE: handle } }));
  assert.deepEqual(f.warnings.at(-1), 'slp: desk bind skipped: store-timeout', 'the bind really exceeded the budget');
  // Register runs BEFORE the bind transact settles (the bind reply lands
  // ~150 ms later) — the FIFO mutex must still commit bind first.
  await resolving.deskRegister(createdEvent(f.repo));
  await new Promise(resolve => setTimeout(resolve, 250));
  const row = f.store.read(repoKey).ledger.memberships.find(r => r.bindingHandleSha256 === sha256Hex(handle));
  assert.equal(row.state, 'host-confirmed');
  assert.ok(row.registeredAt !== null, 'bind landed before register — no registration-timeout');

  // (b) reject path — the same schedule with a late rejection: the
  // pre-attached handler consumes it, never an unhandled rejection.
  const rejecting = createDeskSeat({
    stableRoot: f.stableRoot,
    store: {
      read: () => f.store.read(repoKey),
      transact: () => new Promise((resolve, reject) => setTimeout(() => reject(new Error('late store failure')), 150)),
    },
    now: () => new Date(FIXED_AT),
    warn: () => {},
    transactBudgetMs: 40,
  });
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  await rejecting.deskBind(openInput(f.repo, { env: { SLP_DESK_HANDLE: handle } }));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(unhandled, [], 'the late bind rejection had a handler');
});

// ---------------------------------------------------------------------------
// G4 — no unhandled rejection across every fail-open branch.
// ---------------------------------------------------------------------------

test('G4: every fail-open branch of all four seams leaves no unhandled rejection', async t => {
  const f = seatFixture(t);
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  const onUncaught = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUncaught);
  t.after(() => {
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUncaught);
  });
  const throwingStore = {
    read: () => { throw new Error('read exploded'); },
    transact: () => Promise.reject(new Error('store exploded')),
  };
  const broken = createDeskSeat({
    stableRoot: f.stableRoot,
    store: throwingStore,
    now: () => new Date(FIXED_AT),
    warn: () => {},
    transactBudgetMs: 40,
  });
  const repo = gitRepo(t);
  await broken.deskMint(mintInput(repo));
  await broken.deskBind(openInput(repo, { env: { SLP_DESK_HANDLE: 'h'.repeat(64) } }));
  await broken.deskRegister(createdEvent(repo));
  await broken.deskRevoke(archivedEvent(repo));
  // A no-handle open is a silent no-op — never a transact, never a rejection.
  await broken.deskBind(openInput(repo, { env: {} }));
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

// ---------------------------------------------------------------------------
// Handle secrecy.
// ---------------------------------------------------------------------------

test('the raw handle never appears in the ledger, the segments, or the warnings', async t => {
  const f = seatFixture(t);
  const { handle } = await f.seat.deskMint(mintInput(f.repo));
  await f.seat.deskBind(openInput(f.repo, { env: { SLP_DESK_HANDLE: handle } }));
  await f.seat.deskRegister(createdEvent(f.repo));
  const repoKey = repoKeyFor({ hostId: 'local', gitCommonDir: gitCommonDirOf(f.repo) });
  const ledgerBytes = readFileSync(join(f.stableRoot, 'state', 'enforcement', 'repos', repoKey, 'ledger.json'), 'utf8');
  assert.ok(!ledgerBytes.includes(handle), 'the ledger never stores the handle');
  const events = join(f.stableRoot, 'state', 'enforcement', 'repos', repoKey, 'events');
  for (const name of readdirSync(events)) {
    assert.ok(!readFileSync(join(events, name), 'utf8').includes(handle), 'no segment carries the handle');
  }
  for (const line of f.warnings) assert.ok(!line.includes(handle));
});

// ---------------------------------------------------------------------------
// F5 — a foreign rejection from the store maps to store-io in all four seams.
// ---------------------------------------------------------------------------

test('F5: a store promise rejecting a foreign Error → store-io in all four seams', async t => {
  const f = homeFixture(t);
  const warnings = [];
  const repo = gitRepo(t);
  const seat = createDeskSeat({
    stableRoot: f.stableRoot,
    store: { read: () => ({ state: 'absent' }), transact: () => Promise.reject(new Error('store exploded')) },
    now: () => new Date(FIXED_AT),
    warn: line => warnings.push(line),
  });
  assert.equal(await seat.deskMint(mintInput(repo)), null);
  assert.deepEqual(warnings.at(-1), 'slp: desk mint skipped: store-io');
  await seat.deskBind(openInput(repo, { env: { SLP_DESK_HANDLE: 'e'.repeat(64) } }));
  assert.deepEqual(warnings.at(-1), 'slp: desk bind skipped: store-io');
  await seat.deskRegister(createdEvent(repo));
  assert.deepEqual(warnings.at(-1), 'slp: desk register skipped: store-io');
  await seat.deskRevoke(archivedEvent(repo));
  assert.deepEqual(warnings.at(-1), 'slp: desk revoke skipped: store-io');
  // The OperationConflict path keeps its own mapping — never "rejected".
  const conflict = createDeskSeat({
    stableRoot: f.stableRoot,
    store: { read: () => ({ state: 'absent' }), transact: () => Promise.reject(new OperationConflict('IO_FAILURE', 'io')) },
    now: () => new Date(FIXED_AT),
    warn: line => warnings.push(line),
  });
  assert.equal(await conflict.deskMint(mintInput(repo)), null);
  assert.deepEqual(warnings.at(-1), 'slp: desk mint skipped: store-io');
});
