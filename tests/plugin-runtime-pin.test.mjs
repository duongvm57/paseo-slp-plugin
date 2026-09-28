// plugin-runtime-pin.test.mjs — P2-b RuntimePin: the closed §3 predicate,
// the enforcement-runtime-pin RPC surface and the emit guard. Receipts are
// seeded through the journal's real write API (or fixture bytes for the
// corrupt case) inside a temporary daemon home under os.tmpdir() — the real
// daemon home is never touched, and nothing is written into the repo tree.
// The integrity oracle is the real materializer.verifyPublished against an
// actually materialized embedded candidate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournal } from '../plugin/server/journal.ts';
import { createMaterializer } from '../plugin/server/materializer.ts';
import { embeddedPayload } from '../plugin/server/generated/runtime-payload.ts';
import { OWNED_PROFILE_IDS, OWNED_PROVIDER_IDS, canonicalSha256 } from '../plugin/server/config-view.ts';
import {
  RUNTIME_PIN_LIMITATIONS, boundRuntimePinView, readRuntimePin, readRuntimePinView,
} from '../plugin/server/runtime-pin.ts';
import {
  GetEnforcementStatusInput, GetRuntimePinInput, GetRuntimePinOutput, RuntimePin, RuntimePinReason, WIRE_LIMITS,
} from '../plugin/shared/enforcement.ts';
import { FAMILY_IDS } from '../plugin/shared/families.ts';
import { MAX_RPC_BYTES, OperationConflict, State } from '../plugin/shared/contracts.ts';
import { hash } from '../src/package.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const materializer = createMaterializer(embeddedPayload);
const journal = createJournal();
const NOW = '2026-01-01T00:00:00.000Z';
const sha = ch => ch.repeat(64);
const HOST = 'host-test';
const flip = s => `${s[0] === 'a' ? 'b' : 'a'}${s.slice(1)}`;

const conflict = async (promise, code) => {
  const error = await promise.then(() => null, error => error);
  assert.ok(error instanceof OperationConflict, `expected OperationConflict, got ${error}`);
  assert.equal(error.code, code, error.message);
  return error;
};

// A temporary daemon home: real directory, regular config.json, real
// slp-runtime — the three things resolveDaemonHome verifies.
function homeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-p2b-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const home = join(dir, 'home');
  mkdirSync(join(home, 'slp-runtime', 'state'), { recursive: true });
  writeFileSync(join(home, 'config.json'), '{}\n');
  const canonical = realpathSync(home);
  return { dir, home, canonical, stableRoot: join(canonical, 'slp-runtime') };
}

const detectFor = (daemonHome, source = 'env') => () => ({ daemonHome, source });
const caller = (daemonHome, hostId = HOST) => ({ hostId, daemonHome });
const verifyOk = () => Promise.resolve();
// A journal stub that counts reads — fixtures that must not reach the
// receipt assert zero.
const countingJournal = result => {
  let reads = 0;
  return {
    journal: { read: () => { reads += 1; return typeof result === 'function' ? result() : result; } },
    reads: () => reads,
  };
};
const verifyCounted = impl => {
  let calls = 0;
  return { verifyPublished: (...args) => { calls += 1; return impl ? impl(...args) : Promise.resolve(); }, calls: () => calls };
};

const projection = (profiles = OWNED_PROFILE_IDS) => ({
  providers: Object.fromEntries(OWNED_PROVIDER_IDS.map(id => [id, { present: false }])),
  profilesPresent: profiles.length > 0,
  profiles: profiles.map((id, index) => ({ index, value: { id, name: id, provider: 'slp-test' } })),
  injectIntoAgents: { present: false },
});

const snapshotFixture = () => {
  const owned = projection([]);
  return {
    rawConfigSha256: sha('0'), owned, ownedSha256: canonicalSha256(owned),
    allProfilesSha256: sha('1'), unrelatedPersistedSha256: sha('2'),
    effectiveEnabled: true, effectiveInjection: true,
  };
};

function bindingFixture(stableRoot, overrides = {}) {
  const owned = projection();
  const candidateSha256 = overrides.candidateSha256 ?? sha('c');
  const payloadSha256 = overrides.payloadSha256 ?? sha('d');
  const launchSetSha256 = overrides.launchSetSha256 ?? sha('e');
  return {
    bindingSha256: canonicalSha256({ candidateSha256, payloadSha256, launchSetSha256, owned }),
    candidateSha256,
    payloadSha256,
    runtimePath: overrides.runtimePath ?? join(stableRoot, candidateSha256),
    launchSetSha256,
    launchManifestSha256: sha('f'),
    launcherFiles: [{ path: join(stableRoot, 'launchers', launchSetSha256, 'slp-x'), sha256: sha('7'), mode: 0o755 }],
    node: { path: process.execPath, version: 'v24.0.0' },
    binaries: Object.fromEntries(FAMILY_IDS.map(id => [id, { available: false, path: null, version: null }])),
    baseline: 'fresh',
    beforeActivation: snapshotFixture(),
    mcpBefore: {
      enabled: { raw: { present: false }, effective: false },
      injectIntoAgents: { raw: { present: false }, effective: false },
    },
    owned,
    postPatchPersistedShapeSha256: canonicalSha256(owned),
    activatedAt: NOW,
    verifiedAt: NOW,
  };
}

const pendingOp = operationId => ({
  operationId,
  requestSha256: sha('9'),
  kind: 'activate',
  bootId: randomUUID(),
  phase: 'accepted',
  outcome: 'pending',
  candidateSha256: null,
  recoveryOf: null,
  recoveryAction: null,
  acceptedAt: NOW,
  updatedAt: NOW,
  completedAt: null,
  plan: null,
  patchAttempts: [],
  conflicts: [],
});

function receiptFor(f, overrides = {}) {
  return {
    schemaVersion: 1,
    pluginId: 'paseo-slp',
    target: { hostId: overrides.hostId ?? HOST, daemonHome: f.canonical },
    stableRoot: f.stableRoot,
    revision: 0,
    state: overrides.state ?? 'ACTIVE',
    createdAt: NOW,
    updatedAt: NOW,
    binding: overrides.binding ?? null,
    lastDeactivatedBindingSha256: null,
    activeOperationId: overrides.activeOperationId ?? null,
    retained: [],
    operations: overrides.operations ?? [],
  };
}

// Seed a receipt through the journal's real write path (revision 0).
function seed(f, receipt) {
  journal.write(f.stableRoot, receiptFor(f, receipt));
  return JSON.parse(readFileSync(join(f.stableRoot, 'state', 'receipt.json'), 'utf8'));
}

const depsFor = (f, extra = {}) => ({
  journal,
  verifyPublished: verifyOk,
  detectDaemonHome: detectFor(f.home),
  ...extra,
});

// ---------------------------------------------------------------------------
// §3 predicate — one fixture per failing step plus the all-pass bound fixture.
// ---------------------------------------------------------------------------

test('step 1 — PASEO_HOME not exported → not-bound unverified-home; receipt never read', async t => {
  const f = homeFixture(t);
  const counted = countingJournal(null);
  const verify = verifyCounted();
  const out = await readRuntimePin(caller(f.home), {
    journal: counted.journal,
    verifyPublished: verify.verifyPublished,
    detectDaemonHome: detectFor(f.home, 'default'),
  });
  assert.deepEqual(out, { result: 'not-bound', reason: 'unverified-home' });
  assert.equal(counted.reads(), 0);
  assert.equal(verify.calls(), 0);
});

test('step 2a — served home fails verification → HOME_UNVERIFIED fault; receipt never read', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'slp-p2b-noconf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(join(home, 'slp-runtime'), { recursive: true }); // no config.json
  const counted = countingJournal(null);
  await conflict(readRuntimePin(caller(home), {
    journal: counted.journal,
    verifyPublished: verifyOk,
    detectDaemonHome: detectFor(home),
  }), 'HOME_UNVERIFIED');
  assert.equal(counted.reads(), 0);
});

test('step 2b — caller home resolves elsewhere → not-bound target-mismatch; receipt never read', async t => {
  const f = homeFixture(t);
  const other = join(f.dir, 'other');
  mkdirSync(other);
  const counted = countingJournal(null);
  const out = await readRuntimePin(caller(other), { ...depsFor(f), journal: counted.journal });
  assert.deepEqual(out, { result: 'not-bound', reason: 'target-mismatch' });
  assert.equal(counted.reads(), 0);
});

test('step 3 — no receipt on disk → not-bound no-receipt', async t => {
  const f = homeFixture(t);
  const out = await readRuntimePin(caller(f.home), depsFor(f));
  assert.deepEqual(out, { result: 'not-bound', reason: 'no-receipt' });
});

test('step 3 — corrupt receipt bytes → RECOVERY_REQUIRED fault passes through', async t => {
  const f = homeFixture(t);
  writeFileSync(join(f.stableRoot, 'state', 'receipt.json'), 'not json{');
  await conflict(readRuntimePin(caller(f.home), depsFor(f)), 'RECOVERY_REQUIRED');
});

test('step 4 — receipt names another host → not-bound target-mismatch', async t => {
  const f = homeFixture(t);
  seed(f, { hostId: 'other-host' });
  const out = await readRuntimePin(caller(f.home), depsFor(f));
  assert.deepEqual(out, { result: 'not-bound', reason: 'target-mismatch' });
});

test('step 5 — receipt not ACTIVE → not-bound state-not-active (one fixture + the enum suite below)', async t => {
  const f = homeFixture(t);
  seed(f, { state: 'INACTIVE' });
  const out = await readRuntimePin(caller(f.home), depsFor(f));
  assert.deepEqual(out, { result: 'not-bound', reason: 'state-not-active' });
});

test('state suite — every non-ACTIVE enum value is state-not-active, ACTIVE proceeds', async t => {
  for (const state of State.options.filter(s => s !== 'ACTIVE')) {
    const f = homeFixture(t);
    seed(f, { state });
    const out = await readRuntimePin(caller(f.home), depsFor(f));
    assert.deepEqual(out, { result: 'not-bound', reason: 'state-not-active' }, `state ${state}`);
  }
  const f = homeFixture(t);
  seed(f, { state: 'ACTIVE' });
  const out = await readRuntimePin(caller(f.home), depsFor(f));
  assert.deepEqual(out, { result: 'not-bound', reason: 'no-binding' }, 'ACTIVE passes the state check and reaches no-binding');
});

test('step 6 — a pending operation → not-bound operation-pending', async t => {
  const f = homeFixture(t);
  const opId = randomUUID();
  seed(f, { activeOperationId: opId, operations: [pendingOp(opId)] });
  const out = await readRuntimePin(caller(f.home), depsFor(f));
  assert.deepEqual(out, { result: 'not-bound', reason: 'operation-pending' });
});

test('step 7 — ACTIVE without a binding → not-bound no-binding', async t => {
  const f = homeFixture(t);
  seed(f, { state: 'ACTIVE' });
  const out = await readRuntimePin(caller(f.home), depsFor(f));
  assert.deepEqual(out, { result: 'not-bound', reason: 'no-binding' });
});

test('step 8 — a tampered published candidate → RUNTIME_INTEGRITY fault', async t => {
  const f = homeFixture(t);
  const published = await materializer.materialize(f.stableRoot, `op-${process.pid}-tamper`);
  writeFileSync(join(published.runtimePath, 'stray.txt'), 'tampered\n');
  seed(f, { binding: bindingFixture(f.stableRoot, { candidateSha256: published.candidateSha256, payloadSha256: published.payloadSha256, runtimePath: published.runtimePath }) });
  await conflict(readRuntimePin(caller(f.home), {
    ...depsFor(f),
    verifyPublished: materializer.verifyPublished,
  }), 'RUNTIME_INTEGRITY');
});

test('step 8 — a foreign OperationConflict code from the oracle passes through verbatim', async t => {
  const f = homeFixture(t);
  seed(f, { binding: bindingFixture(f.stableRoot) });
  await conflict(readRuntimePin(caller(f.home), {
    ...depsFor(f),
    verifyPublished: () => Promise.reject(new OperationConflict('SCHEMA_LOSS', 'oracle said so')),
  }), 'SCHEMA_LOSS');
});

test('step 9 — verified ACTIVE binding → bound, schema-valid pin, recomputed pinSha256', async t => {
  const f = homeFixture(t);
  const published = await materializer.materialize(f.stableRoot, `op-${process.pid}-bound`);
  const binding = bindingFixture(f.stableRoot, {
    candidateSha256: published.candidateSha256,
    payloadSha256: published.payloadSha256,
    runtimePath: published.runtimePath,
  });
  seed(f, { binding });
  const out = await readRuntimePin(caller(f.home), { ...depsFor(f), verifyPublished: materializer.verifyPublished });
  assert.equal(out.result, 'bound');
  assert.ok(RuntimePin.safeParse(out.pin).success, 'pin must satisfy the wire schema');
  assert.equal(out.pinSha256, canonicalSha256(out.pin));
  const pin = out.pin;
  assert.equal(pin.state, 'ACTIVE');
  assert.equal(pin.candidateSha256, published.candidateSha256);
  assert.equal(pin.payloadSha256, published.payloadSha256);
  assert.equal(pin.bindingSha256, binding.bindingSha256);
  assert.equal(pin.launchSetSha256, binding.launchSetSha256);
  assert.equal(pin.launchManifestSha256, binding.launchManifestSha256);
  assert.equal(pin.policyBundleSha256, canonicalSha256(binding.owned));
  assert.equal(pin.binariesSha256, canonicalSha256(binding.binaries));
  assert.deepEqual(pin.node, binding.node);
  assert.equal(pin.bridgeSha256, null);
  assert.equal(pin.bridgeProtocolVersion, null);
  assert.deepEqual(pin.target, { hostId: HOST, daemonHome: f.canonical });
  assert.equal(pin.receiptRevision, 0);
  assert.equal(pin.snapshotAlgorithmVersion, 'slp-snapshot/package.mjs');
  assert.equal(pin.recordContractVersion, 1);
});

test('fault mapping — an unexpected error inside the predicate is IO_FAILURE, never not-bound', async t => {
  const f = homeFixture(t);
  await conflict(readRuntimePin(caller(f.home), {
    journal: { read: () => { throw new Error('disk went sideways'); } },
    verifyPublished: verifyOk,
    detectDaemonHome: detectFor(f.home),
  }), 'IO_FAILURE');
  // A non-OperationConflict from the integrity oracle is IO_FAILURE too.
  const g = homeFixture(t);
  seed(g, { binding: bindingFixture(g.stableRoot) });
  await conflict(readRuntimePin(caller(g.home), {
    ...depsFor(g),
    verifyPublished: () => Promise.reject(new TypeError('foreign fault')),
  }), 'IO_FAILURE');
  // A caller home whose realpath throws is an exception → IO_FAILURE (2b is
  // the resolved-path comparison, not a catch-all for unreadable callers).
  const h = homeFixture(t);
  await conflict(readRuntimePin({ hostId: HOST, daemonHome: join(h.dir, 'absent') }, depsFor(h)), 'IO_FAILURE');
});

test('completeness — every RuntimePinReason is produced by a fixture above', () => {
  // The predicate suite assigns one fixture per reason; this pins the enum
  // so a new reason lands loudly instead of silently shipping uncovered.
  assert.deepEqual(RuntimePinReason.options, [
    'unverified-home', 'target-mismatch', 'no-receipt',
    'state-not-active', 'operation-pending', 'no-binding',
  ]);
});

test('no mutation — the bound fixture leaves the home tree byte-identical', async t => {
  const listing = root => readdirSync(root, { withFileTypes: true, recursive: true })
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
    .map(path => {
      const stat = lstatSync(path);
      return `${path}:${stat.isFile() ? hash(readFileSync(path)) : stat.isDirectory() ? 'dir' : 'other'}`;
    });
  const f = homeFixture(t);
  const published = await materializer.materialize(f.stableRoot, `op-${process.pid}-nomut`);
  seed(f, { binding: bindingFixture(f.stableRoot, { candidateSha256: published.candidateSha256, payloadSha256: published.payloadSha256, runtimePath: published.runtimePath }) });
  const before = listing(f.home);
  const out = await readRuntimePin(caller(f.home), { ...depsFor(f), verifyPublished: materializer.verifyPublished });
  assert.equal(out.result, 'bound');
  assert.deepEqual(listing(f.home), before, 'the predicate must not create, modify or delete anything under the home');
});

// ---------------------------------------------------------------------------
// §4 RPC surface — input validation, output coupling, emit guard.
// ---------------------------------------------------------------------------

test('RPC — bound path emits the pinned output through the guard', async t => {
  const f = homeFixture(t);
  const published = await materializer.materialize(f.stableRoot, `op-${process.pid}-rpc`);
  seed(f, { binding: bindingFixture(f.stableRoot, { candidateSha256: published.candidateSha256, payloadSha256: published.payloadSha256, runtimePath: published.runtimePath }) });
  const view = await readRuntimePinView(
    { schemaVersion: 1, target: caller(f.home) },
    { ...depsFor(f), verifyPublished: materializer.verifyPublished, now: () => new Date(NOW) },
  );
  assert.ok(GetRuntimePinOutput.safeParse(view).success);
  assert.equal(view.result, 'bound');
  assert.equal(view.reason, null);
  assert.equal(view.pinSha256, canonicalSha256(view.pin));
  assert.equal(view.generatedAt, NOW);
  assert.deepEqual(view.limitations, [...RUNTIME_PIN_LIMITATIONS]);
  assert.equal(view.acceptance, 'not-established-by-this-view');
});

test('RPC — not-bound carries reason, pin:null and pinSha256:null', async t => {
  const f = homeFixture(t);
  const view = await readRuntimePinView({ schemaVersion: 1, target: caller(f.home) }, depsFor(f));
  assert.ok(GetRuntimePinOutput.safeParse(view).success);
  assert.equal(view.result, 'not-bound');
  assert.equal(view.reason, 'no-receipt');
  assert.equal(view.pin, null);
  assert.equal(view.pinSha256, null);
});

test('RPC — predicate faults surface their OperationConflict code on the wire', async t => {
  const f = homeFixture(t);
  writeFileSync(join(f.stableRoot, 'state', 'receipt.json'), '{"garbage"');
  await conflict(readRuntimePinView({ schemaVersion: 1, target: caller(f.home) }, depsFor(f)), 'RECOVERY_REQUIRED');
});

test('RPC — invalid input is INVALID_REQUEST', async t => {
  const f = homeFixture(t);
  for (const input of [
    null,
    { schemaVersion: 1 },
    { schemaVersion: 1, target: { hostId: HOST } },
    { schemaVersion: 1, target: { hostId: HOST, daemonHome: 'relative/path' } },
    { schemaVersion: 1, target: caller(f.home), extra: true },
    { schemaVersion: 2, target: caller(f.home) },
  ]) {
    await conflict(readRuntimePinView(input, depsFor(f)), 'INVALID_REQUEST');
  }
  // An over-sized request object is INVALID_REQUEST as well — the byte
  // guard shares that code path (schema rejection lands first).
  const huge = { schemaVersion: 1, target: { hostId: 'h'.repeat(WIRE_LIMITS.targetHostId + 1), daemonHome: f.home } };
  await conflict(readRuntimePinView(huge, depsFor(f)), 'INVALID_REQUEST');
});

// P2B-C1/S2 — the clock seam is part of the RPC mapping layer: exceptions
// and invalid Dates from `now()` must surface as IO_FAILURE, never raw.
test('RPC — a throwing now seam is IO_FAILURE, not a raw Error', async t => {
  const f = homeFixture(t);
  await conflict(
    readRuntimePinView(
      { schemaVersion: 1, target: caller(f.home) },
      { ...depsFor(f), now: () => { throw new Error('clock seam'); } },
    ),
    'IO_FAILURE',
  );
});

test('RPC — an invalid Date from the now seam is IO_FAILURE', async t => {
  const f = homeFixture(t);
  await conflict(
    readRuntimePinView(
      { schemaVersion: 1, target: caller(f.home) },
      { ...depsFor(f), now: () => new Date('not-a-date') },
    ),
    'IO_FAILURE',
  );
});

// P2B-C1 residual — only predicate steps 2a/3/8 keep their conflict code;
// an OperationConflict thrown by the emit-layer clock seam still becomes
// IO_FAILURE, never the seam's own code.
test('RPC — an OperationConflict thrown by now() is remapped to IO_FAILURE', async t => {
  const f = homeFixture(t);
  await conflict(
    readRuntimePinView(
      { schemaVersion: 1, target: caller(f.home) },
      { ...depsFor(f), now: () => { throw new OperationConflict('HOME_UNVERIFIED', 'seam imitates a predicate code'); } },
    ),
    'IO_FAILURE',
  );
});

// ---------------------------------------------------------------------------
// §4/§6 emit guard + builder fixtures (normative worst-case recipe; every
// length is read from the schema/WIRE_LIMITS export, never restated).
// ---------------------------------------------------------------------------

const ESCAPE_SEED = String.fromCodePoint(1) + 'é' + String.fromCharCode(34, 92, 10);
const escapeFill = n => ESCAPE_SEED.repeat(Math.ceil(n / ESCAPE_SEED.length)).slice(0, n);

function builderPin() {
  const pin = {
    schemaVersion: 1,
    state: 'ACTIVE',
    candidateSha256: sha('a'),
    payloadSha256: sha('a'),
    launchSetSha256: sha('a'),
    launchManifestSha256: sha('a'),
    bindingSha256: sha('a'),
    policyBundleSha256: sha('a'),
    binariesSha256: sha('a'),
    node: {
      path: `/${escapeFill(WIRE_LIMITS.runtimePinPath - 1)}`,
      version: escapeFill(WIRE_LIMITS.runtimePinNodeVersion),
    },
    bridgeSha256: null,
    bridgeProtocolVersion: null,
    target: {
      hostId: escapeFill(WIRE_LIMITS.targetHostId),
      daemonHome: `/${escapeFill(WIRE_LIMITS.targetDaemonHome - 1)}`,
    },
    receiptRevision: Number.MAX_SAFE_INTEGER,
    snapshotAlgorithmVersion: 'slp-snapshot/package.mjs',
    recordContractVersion: 1,
  };
  return { pin, pinSha256: canonicalSha256(pin) };
}

function builderOutput(generatedAt) {
  const { pin, pinSha256 } = builderPin();
  return {
    schemaVersion: 1,
    target: {
      hostId: escapeFill(WIRE_LIMITS.targetHostId),
      daemonHome: `/${escapeFill(WIRE_LIMITS.targetDaemonHome - 1)}`,
    },
    generatedAt,
    result: 'bound',
    reason: null,
    pin,
    pinSha256,
    limitations: [...RUNTIME_PIN_LIMITATIONS],
    acceptance: 'not-established-by-this-view',
  };
}

// Literal pins for the normative fixtures — assert, don't compute per-run
// expectations that could drift silently.
const NORMAL_LITERAL_BYTES = 15871;
const NORMAL_LITERAL_SHA256 = 'c058ab57a5607dfd2dda01a9bd8833ed01c5d343b19c718bd7dd4ce354449e8f';
const OVERFLOW_LITERAL_SHA256 = 'a151eabc12c04a5a7286688b8c89b00607801404c8c4a4bfa5894c096aab85b3';

test('builder lengths come from the exported caps', () => {
  const { pin } = builderPin();
  assert.equal(pin.node.path.length, WIRE_LIMITS.runtimePinPath);
  assert.equal(pin.node.version.length, WIRE_LIMITS.runtimePinNodeVersion);
  assert.equal(pin.target.hostId.length, WIRE_LIMITS.targetHostId);
  assert.equal(pin.target.daemonHome.length, WIRE_LIMITS.targetDaemonHome);
});

test('normal fixture — schema-valid worst case under the byte budget, literal SHA pinned', t => {
  const normal = builderOutput('2026-01-01T00:00:00.000Z');
  assert.ok(GetRuntimePinOutput.safeParse(normal).success);
  const bytes = Buffer.byteLength(JSON.stringify(normal), 'utf8');
  assert.ok(bytes < MAX_RPC_BYTES, `worst-case output ${bytes} must stay under ${MAX_RPC_BYTES}`);
  assert.equal(bytes, NORMAL_LITERAL_BYTES);
  const digest = hash(Buffer.from(JSON.stringify(normal), 'utf8'));
  t.diagnostic(`normal fixture bytes=${bytes} sha256=${digest}`);
  assert.equal(digest, NORMAL_LITERAL_SHA256, 'normal fixture bytes drifted — re-pin if the view change is intended');
  assert.equal(boundRuntimePinView(normal).pinSha256, normal.pinSha256);
});

test('overflow fixture — schema-valid generatedAt past the byte budget → guard IO_FAILURE', t => {
  const base = builderOutput('2026-01-01T00:00:00.000Z');
  const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
  // '000' fractional → k zeros: each added digit is one byte. Smallest k
  // with base + (k - 3) > MAX.
  const k = MAX_RPC_BYTES - baseBytes + 3 + 1;
  const overflow = builderOutput(`2026-01-01T00:00:00.${'0'.repeat(k)}Z`);
  const overflowBytes = Buffer.byteLength(JSON.stringify(overflow), 'utf8');
  assert.ok(overflowBytes > MAX_RPC_BYTES, `${overflowBytes} must exceed ${MAX_RPC_BYTES}`);
  const smaller = builderOutput(`2026-01-01T00:00:00.${'0'.repeat(k - 1)}Z`);
  assert.ok(Buffer.byteLength(JSON.stringify(smaller), 'utf8') <= MAX_RPC_BYTES, 'k must be minimal');
  assert.ok(GetRuntimePinOutput.safeParse(overflow).success, 'overflow fixture stays schema-valid (Time has no fractional bound)');
  const digest = hash(Buffer.from(JSON.stringify(overflow), 'utf8'));
  t.diagnostic(`overflow fixture bytes=${overflowBytes} sha256=${digest} k=${k}`);
  assert.equal(digest, OVERFLOW_LITERAL_SHA256, 'overflow fixture bytes drifted — re-pin if the view change is intended');
  assert.throws(() => boundRuntimePinView(overflow), error => error instanceof OperationConflict && error.code === 'IO_FAILURE');
});

test('guard — schema-invalid and cross-field violations are IO_FAILURE before emit', () => {
  const { pin, pinSha256 } = builderPin();
  const base = builderOutput('2026-01-01T00:00:00.000Z');
  const bad = [
    { ...base, pinSha256: flip(pinSha256) },                                   // digest mismatch
    { ...base, pin: null },                                                    // bound without a pin
    { ...base, reason: 'no-receipt' },                                         // bound carrying a reason
    { ...base, result: 'not-bound', reason: 'no-receipt' },                    // not-bound with pin material
    { ...base, result: 'not-bound', reason: null, pin: null, pinSha256: null },// not-bound without reason
    { ...base, limitations: ['x'.repeat(WIRE_LIMITS.runtimePinLimitationLen + 1)] },
    { ...base, limitations: Array.from({ length: WIRE_LIMITS.runtimePinLimitations + 1 }, (_, i) => `l${i}`) },
    { ...base, acceptance: 'yes' },
    { ...base, pin: { ...pin, bridgeSha256: sha('b') } },
  ];
  for (const [index, output] of bad.entries()) {
    assert.throws(() => boundRuntimePinView(output), error =>
      error instanceof OperationConflict && error.code === 'IO_FAILURE', `case ${index} must fail closed`);
  }
  // The valid counterparts pass.
  assert.equal(boundRuntimePinView(base).result, 'bound');
  const notBound = boundRuntimePinView({ ...base, result: 'not-bound', reason: 'no-receipt', pin: null, pinSha256: null });
  assert.equal(notBound.result, 'not-bound');
});

test('schema — RuntimePin rejects non-ACTIVE state and populated bridge fields', () => {
  const { pin } = builderPin();
  assert.ok(RuntimePin.safeParse(pin).success);
  assert.ok(!RuntimePin.safeParse({ ...pin, state: 'INACTIVE' }).success);
  assert.ok(!RuntimePin.safeParse({ ...pin, bridgeProtocolVersion: 1 }).success);
  assert.ok(!RuntimePin.safeParse({ ...pin, node: { ...pin.node, path: 'relative' } }).success);
  assert.ok(!RuntimePin.safeParse({ ...pin, extra: 1 }).success);
});

test('GetRuntimePinInput reuses the P0 enforcement-status input schema', () => {
  assert.equal(GetRuntimePinInput, GetEnforcementStatusInput, 'the runtime-pin input IS the P0 input schema object');
  assert.ok(GetRuntimePinInput.safeParse({ schemaVersion: 1, target: { hostId: 'h', daemonHome: '/h' } }).success);
  assert.ok(!GetRuntimePinInput.safeParse({ schemaVersion: 1, target: { hostId: 'h', daemonHome: 'rel' } }).success);
});
