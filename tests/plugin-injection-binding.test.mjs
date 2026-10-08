// tests/plugin-injection-binding.test.mjs — O1 usable-for-injection
// predicate (contract-o1 §2/§3). The finite domain is generated from the
// State enum: 5 states × binding{null,present} × pending{none,present} ×
// target{match,mismatch} = 40 rows, each seeded through the journal's real
// write path (schema + refinements + derived-hash checks) inside a tmpdir
// daemon home — nothing touches the real daemon home, the repo tree, or
// git history. The oracle asserts the contract's outcome per row and that
// the pending axis never changes it. Three off-table rows cover an absent
// receipt, a corrupt receipt (the journal's RECOVERY_REQUIRED propagates)
// and a realpath failure. The Q1 regression and the agentCreate
// integration pin the deliberate differences from readRuntimePin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournal } from '../plugin/server/journal.ts';
import { readInjectionBinding } from '../plugin/server/injection-binding.ts';
import { createRoleInjection } from '../plugin/server/role-injection.ts';
import { OperationConflict, State } from '../plugin/shared/contracts.ts';
import { FAMILY_IDS } from '../plugin/shared/runtime/families.ts';
import { OWNED_PROFILE_IDS, OWNED_PROVIDER_IDS, canonicalSha256 } from '../plugin/server/config-view.ts';
import { identity, install } from '../plugin/server/runtime/cli/package.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const journal = createJournal();
const NOW = '2026-01-01T00:00:00.000Z';
const sha = ch => ch.repeat(64);
const HOST = 'host-test';

function tmp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

// A temporary daemon home: real directory holding slp-runtime/state. The
// injection predicate canonicalizes whatever detectDaemonHome returns, so
// all receipt paths are recorded against the realpath'd home.
function homeFixture(t) {
  const dir = tmp(t, 'slp-o1-');
  const home = join(dir, 'home');
  mkdirSync(join(home, 'slp-runtime', 'state'), { recursive: true });
  const canonical = realpathSync(home);
  return { dir, home, canonical, stableRoot: join(canonical, 'slp-runtime') };
}

const detectFor = (daemonHome, source = 'env') => () => ({ daemonHome, source });

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

// A binding whose recorded digests and paths satisfy journal.write's
// derived-hash and path refinements for the given (claimed) stable root.
function bindingFixture(stableRoot, overrides = {}) {
  const owned = projection();
  const candidateSha256 = overrides.candidateSha256 ?? sha('c');
  const payloadSha256 = overrides.payloadSha256 ?? sha('d');
  const launchSetSha256 = overrides.launchSetSha256 ?? sha('e');
  return {
    bindingSha256: canonicalSha256({ candidateSha256, payloadSha256, launchSetSha256, owned }),
    candidateSha256,
    payloadSha256,
    runtimePath: join(stableRoot, candidateSha256),
    launchSetSha256,
    launchManifestSha256: sha('f'),
    launcherFiles: [{ path: join(stableRoot, 'launchers', launchSetSha256, 'slp-codex-peer'), sha256: sha('7'), mode: 0o755 }],
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

// claimedHome is the receipt's target.daemonHome — the canonical fixture
// home on match rows, another real home on mismatch rows. stableRoot and
// binding paths derive from it so the receipt survives journal.write's
// path and derived-hash refinements.
function receiptFor(claimedHome, overrides = {}) {
  const stableRoot = join(claimedHome, 'slp-runtime');
  const pending = pendingOp(randomUUID());
  return {
    schemaVersion: 1,
    pluginId: 'paseo-slp',
    target: { hostId: HOST, daemonHome: claimedHome },
    stableRoot,
    revision: 0,
    state: overrides.state,
    createdAt: NOW,
    updatedAt: NOW,
    binding:
      overrides.binding === 'present'
        ? bindingFixture(stableRoot, { candidateSha256: overrides.candidateSha256 })
        : null,
    lastDeactivatedBindingSha256: null,
    activeOperationId: overrides.pending === 'present' ? pending.operationId : null,
    retained: [],
    operations: overrides.pending === 'present' ? [pending] : [],
  };
}

// Seed the receipt through the journal's real write path under the fixture
// home (revision 0), then hand the predicate the real journal + the home
// detection seam pointed at the un-canonicalized path.
function seed(f, row, source = 'env') {
  const claimed = row.target === 'match' ? f.canonical : f.otherCanonical;
  journal.write(f.stableRoot, receiptFor(claimed, row));
  return {
    journal,
    detectDaemonHome: detectFor(f.home, source),
  };
}

// homeFixture plus a second real home to claim as a mismatched target.
function pairFixture(t) {
  const f = homeFixture(t);
  const other = homeFixture(t);
  return { ...f, otherCanonical: other.canonical };
}

// The §2 outcome oracle for one (state, binding, pending, target) row.
function expected(row) {
  if (row.target === 'mismatch') return 'target-mismatch';
  if (row.state === 'DEACTIVATING') return 'state-deactivating';
  if (row.state === 'RECOVERY_REQUIRED') return 'state-recovery-required';
  if (row.state === 'INACTIVE' && row.binding === 'present') return 'state-inconsistent';
  return row.binding === 'present' ? 'usable' : 'null';
}

// The ActiveBinding fields the predicate must return for a usable row —
// verbatim from the recorded binding + receipt target.
function expectedBinding(receipt) {
  const binding = receipt.binding;
  return {
    candidateSha256: binding.candidateSha256,
    payloadSha256: binding.payloadSha256,
    runtimePath: binding.runtimePath,
    nodePath: binding.node.path,
    daemonHome: receipt.target.daemonHome,
  };
}

// §3 — the full enum product: every (state, binding, pending, target) row
// is run through the real journal and the predicate. Outcomes are compared
// pairwise across the pending axis, proving pending never changes one.
test('§3 domain — all 5×2×2×2 enum-product rows through the journal', t => {
  assert.equal(State.options.length, 5, 'the table is pinned to a 5-state enum');
  const rows = [];
  for (const state of State.options) {
    for (const binding of [null, 'present']) {
      for (const pending of ['none', 'present']) {
        for (const target of ['match', 'mismatch']) {
          rows.push({ state, binding, pending, target });
        }
      }
    }
  }
  assert.equal(rows.length, 40, 'the domain is exactly 5×2×2×2');
  const seen = new Set();
  const byCell = new Map();
  for (const row of rows) {
    const cell = `${row.state}|${row.binding}|${row.target}`;
    seen.add(`${cell}|${row.pending}`);
    const f = pairFixture(t);
    const deps = seed(f, row);
    const want = expected(row);
    let got;
    try {
      const out = readInjectionBinding(deps);
      if (want === 'usable') {
        const receipt = JSON.parse(
          readFileSync(join(f.stableRoot, 'state', 'receipt.json'), 'utf8'),
        );
        assert.deepEqual(out, expectedBinding(receipt), `${cell} binding fields`);
      }
      got = out === null ? 'null' : 'usable';
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(want), `${cell}: message must carry ${want}, got ${error.message}`);
      got = want;
    }
    assert.equal(got, want, `${cell}|${row.pending}`);
    // pending-invariance: the sibling row on the pending axis agrees.
    if (byCell.has(cell)) {
      assert.equal(byCell.get(cell), got, `${cell}: pending changed the outcome`);
    } else {
      byCell.set(cell, got);
    }
  }
  assert.equal(seen.size, 40, 'every row of the product was exercised');
});

// ---------------------------------------------------------------------------
// Off-table rows — the three special cases of §3.
// ---------------------------------------------------------------------------

test('absent receipt → null (unchanged pre-O1 behavior)', t => {
  const f = homeFixture(t);
  assert.equal(readInjectionBinding({ journal, detectDaemonHome: detectFor(f.home) }), null);
});

const thrown = fn => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
};

test('corrupt receipt → the journal conflict propagates', t => {
  const f = homeFixture(t);
  writeFileSync(join(f.stableRoot, 'state', 'receipt.json'), 'not json {', 'utf8');
  const error = thrown(() =>
    readInjectionBinding({ journal, detectDaemonHome: detectFor(f.home) }));
  assert.ok(error instanceof OperationConflict, `expected OperationConflict, got ${error}`);
  assert.equal(error.code, 'RECOVERY_REQUIRED');
});

test('realpath failure on the detected home propagates', t => {
  const gone = join(tmp(t, 'slp-o1-gone-'), 'no-such-home');
  const error = thrown(() =>
    readInjectionBinding({ journal, detectDaemonHome: detectFor(gone) }));
  assert.equal(error.code, 'ENOENT');
});

// ---------------------------------------------------------------------------
// Deliberate differences from readRuntimePin (contract §2) — asserted
// explicitly even though the table covers both rows.
// ---------------------------------------------------------------------------

test('Q1 regression — source "default" (no PASEO_HOME) is still usable', t => {
  const f = homeFixture(t);
  const deps = seed(f, { state: 'ACTIVE', binding: 'present', pending: 'none', target: 'match' }, 'default');
  const out = readInjectionBinding(deps);
  assert.equal(out.daemonHome, f.canonical);
  assert.equal(typeof out.candidateSha256, 'string');
});

test('ACTIVATING + pending operation + old binding → usable (pin would not bind)', t => {
  const f = homeFixture(t);
  const deps = seed(f, { state: 'ACTIVATING', binding: 'present', pending: 'present', target: 'match' });
  const out = readInjectionBinding(deps);
  assert.ok(out !== null, 'an op pending must not unbind the intact old binding');
});

// ---------------------------------------------------------------------------
// Integration — the predicate behind the real agentCreate hook.
// ---------------------------------------------------------------------------

function fixtureCandidate(t) {
  const f = homeFixture(t);
  const candidateSha256 = identity(root).sha256;
  install(root, join(f.stableRoot, candidateSha256));
  return { ...f, candidateSha256 };
}

const injectionFor = f =>
  createRoleInjection({
    readActiveBinding: () => readInjectionBinding({ journal, detectDaemonHome: detectFor(f.home) }),
    verifyCandidate: async () => {},
  });

const createReq = provider => ({ request: { config: { provider, cwd: '/work' } } });

test('agentCreate — RECOVERY_REQUIRED aborts the managed spawn', async t => {
  const f = fixtureCandidate(t);
  seed(f, {
    state: 'RECOVERY_REQUIRED', binding: 'present', pending: 'none',
    target: 'match', candidateSha256: f.candidateSha256,
  });
  await assert.rejects(
    injectionFor(f).agentCreate(createReq('slp-codex-lead')),
    /state-recovery-required/,
  );
});

test('agentCreate — ACTIVATING carrying the old binding injects', async t => {
  const f = fixtureCandidate(t);
  seed(f, {
    state: 'ACTIVATING', binding: 'present', pending: 'present',
    target: 'match', candidateSha256: f.candidateSha256,
  });
  const out = await injectionFor(f).agentCreate(createReq('slp-codex-lead'));
  assert.ok(out.config.systemPrompt.startsWith('SLP role=lead'), 'the old binding still renders the role');
});
