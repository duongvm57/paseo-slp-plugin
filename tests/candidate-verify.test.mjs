// candidate-verify.test.mjs — Interface + §5.4 fixture suite for the P1
// handback verifier. The fixture table is generated from the exported axis
// vocabulary (AXES), never hand-listed: the T×C spine is the full product,
// the remaining core axes rotate over it, and a patch pass appends rows until
// every feasible cross-axis pair is covered — the completeness oracle test
// fails if a new enum value lands without coverage. Fault seams (capture
// timeout/byte-cap/drift, pin drift) enter through the same verifyHandback
// Interface via internals, never through verb input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyHandback, VerifyError, AXES, COMPARISON, REASON, RECORD_CODES,
  RECORD_VALIDATION, CHECK_CONSISTENCY, SUMMARY_VALUES, CWD_RELATIONS,
  COMPLETENESS_COLLECTIONS, COMPLETENESS_REASONS, VERIFY_LIMITS,
} from '../src/candidate-verify.mjs';
import { snapshot, hash } from '../src/package.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const ENGINE_PATH = join(PKG, 'src', 'candidate-verify.mjs');
const GITLINK_OID = '0123456789012345678901234567890123456789';

// Pinned author/committer dates keep fixture commits byte-identical — the
// canonical fixture (C-S4) asserts a literal SHA-256 over the emitted view.
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const git = (repo, args, options) => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV, ...options });
const flip = (sha, at = 0) => `${sha.slice(0, at)}${sha[at] === 'a' ? 'b' : 'a'}${sha.slice(at + 1)}`;
const sha256hex = bytes => hash(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);

function world(t, dir = mkdtempSync(join(tmpdir(), 'slp-verify-'))) {
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  const other = join(dir, 'other');
  mkdirSync(repo);
  mkdirSync(other); // a resolvable non-repo directory for R=different claims
  mkdirSync(join(home, 'agents'), { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'verify@example.test']);
  git(repo, ['config', 'user.name', 'Verify Test']);
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  writeFileSync(join(repo, 'CONTRACT.md'), 'contract bytes\n');
  writeFileSync(join(repo, 'pin.txt'), 'pin bytes\n');
  symlinkSync('seed.txt', join(repo, 'link'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'seed']);
  let reportSeq = 0;
  return {
    dir, repo, home, other,
    contract: { path: 'CONTRACT.md', sha256: sha256hex(readFileSync(join(repo, 'CONTRACT.md'))) },
    measure() { const s = snapshot(repo); return { head: s.head, sha256: s.sha256, incomplete: s.incomplete ?? [], nested: s.nested ?? [] }; },
    writeReport(blocks) {
      const path = join(dir, `report-${++reportSeq}.md`);
      writeFileSync(path, renderReport(blocks));
      return path;
    },
    seatFile(id, fields, group = 'grp-a') {
      const dirPath = join(home, 'agents', group);
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, `${id}.json`), typeof fields === 'string' ? fields : JSON.stringify(fields));
    },
  };
}

const renderReport = blocks => `# fixture report\n\n${blocks
  .map(block => (typeof block === 'string' ? block : `\`\`\`slp-record\n${JSON.stringify(block)}\n\`\`\``))
  .join('\n\n')}\n`;

// T-axis mutations against the seeded repo (seed.txt, CONTRACT.md, pin.txt,
// link -> seed.txt, one commit).
function mutate(w, T) {
  switch (T) {
    case 'clean': return;
    case 'modified-tracked': writeFileSync(join(w.repo, 'seed.txt'), 'seed\nmodified\n'); return;
    case 'staged-only': {
      const blob = git(w.repo, ['hash-object', '-w', '--stdin'], { input: 'staged blob\n' }).trim();
      git(w.repo, ['update-index', '--cacheinfo', `100644,${blob},seed.txt`]);
      return;
    }
    case 'untracked': writeFileSync(join(w.repo, 'untracked.txt'), 'untracked\n'); return;
    case 'deleted': unlinkSync(join(w.repo, 'seed.txt')); return;
    case 'mode-change': chmodSync(join(w.repo, 'seed.txt'), 0o755); return;
    case 'symlink-retarget': unlinkSync(join(w.repo, 'link')); symlinkSync('CONTRACT.md', join(w.repo, 'link')); return;
    case 'nested-repo-dirty': {
      const nested = join(w.repo, 'nested');
      mkdirSync(nested);
      git(nested, ['init', '-q']);
      git(nested, ['config', 'user.email', 'verify@example.test']);
      git(nested, ['config', 'user.name', 'Verify Test']);
      writeFileSync(join(nested, 'inner.txt'), 'inner\n');
      git(nested, ['add', '-A']);
      git(nested, ['commit', '-qm', 'nested']);
      writeFileSync(join(nested, 'inner.txt'), 'inner dirty\n');
      return;
    }
    case 'gitlink-non-clean': {
      // Committed gitlink, then an initialized-but-commitless repo inside it:
      // porcelain stays empty while snapshot() lists the path in `incomplete`.
      git(w.repo, ['update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},glink`]);
      git(w.repo, ['commit', '-qm', 'gitlink']);
      mkdirSync(join(w.repo, 'glink'));
      git(join(w.repo, 'glink'), ['init', '-q']);
      return;
    }
    default: throw new Error(`unknown T value ${T}`);
  }
}

// The capture fault seam: wraps the default bounded-probe behavior and only
// faults the snapshot child or the git-status probe — the preflight, repo
// validation and seat cwd probes keep real semantics.
const realProbe = argv => spawnSync(argv[0], argv.slice(1), {
  timeout: VERIFY_LIMITS.captureTimeoutMs, maxBuffer: VERIFY_LIMITS.captureMaxBytes,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const isSnapshotProbe = argv => argv[0] === process.execPath;
const isStatusProbe = argv => argv[0] === 'git' && argv.includes('status');
function captureFault(kind) {
  let snapCalls = 0;
  return argv => {
    if (isSnapshotProbe(argv)) {
      snapCalls += 1;
      if (kind === 'timeout') return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (kind === 'byte-cap') return { error: Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS' }), status: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (kind === 'drift') {
        const result = realProbe(argv);
        const parsed = JSON.parse(result.stdout.toString('utf8'));
        parsed.sha256 = flip(parsed.sha256, snapCalls % 60); // a different sha every call
        return { ...result, stdout: Buffer.from(JSON.stringify(parsed), 'utf8') };
      }
      return realProbe(argv);
    }
    if (isStatusProbe(argv)) {
      if (kind === 'timeout') return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (kind === 'byte-cap') return { error: Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS' }), status: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    return realProbe(argv);
  };
}

const internalsFor = row => (row.C === 'ok' ? {} : { probe: captureFault(row.C) });

function buildRecord(w, row, after) {
  let candidate = null;
  if (row.R !== 'absent') {
    candidate = { repository: row.R === 'equal' ? w.repo : w.other };
    if (row.S !== 'absent') candidate.snapshotSha256 = row.S === 'equal' ? after.sha256 : flip(after.sha256);
    if (row.H !== 'absent') candidate.head = row.H === 'equal' ? after.head : flip(after.head, 8);
    if (row.I === 'present') candidate.incomplete = ['unverified/scope'];
  }
  return {
    version: 1, kind: 'handback',
    seat: { role: 'peer', disposition: 'Engineer', ...(row.agentId ? { agentId: row.agentId } : {}) },
    verdict: 'APPROVE', candidate,
    checks: row.checks ?? [],
  };
}

// Turn one normalized row into report blocks on a mutated repo.
function blocksFor(w, row, after) {
  const record = buildRecord(w, row, after);
  switch (row.V) {
    case 'valid':
      return row.M === 'true'
        ? [{ ...record, verdict: 'BLOCKED', seat: { role: 'lead', disposition: 'Lead' } }, record]
        : [record];
    case 'invalid': {
      const bad = '```slp-record\n{bad json\n```';
      const decoy = { ...record, verdict: 'BLOCKED', seat: { role: 'lead', disposition: 'Lead' } };
      return row.M === 'true' ? [bad, decoy, record] : [bad, record];
    }
    case 'unsupported-version': {
      const v99 = { ...record, version: 99 };
      // M needs two parsed handbacks; the version-1 decoy stays valid while
      // the v99 selected record carries the claims.
      return row.M === 'true' ? [{ ...record, verdict: 'BLOCKED', seat: { role: 'lead', disposition: 'Lead' } }, v99] : [v99];
    }
    case 'no-handback':
      return ['plain markdown — no record block'];
    default: throw new Error(`unknown V value ${row.V}`);
  }
}

// Feasibility is the record-schema v1 constraint set, not a coverage
// shortcut — errata E2 (.local-checks/mech-p1/contract-p1-errata.vi.md)
// enumerates the classes a fixture cannot construct: a record claims at most
// one of snapshotSha256/head (parser enforces exactly-one); a claim needs a
// candidate object; and no-handback excludes both claims and
// multiple-records. The third E2 class — a candidate with no claim axis — is
// a triple (R set, S=H=absent), not a pair; completeRow normalizes it by
// filling a claim. Pairs outside these classes must all be covered.
function pairFeasible(xa, xv, ya, yv) {
  const s = { [xa]: xv, [ya]: yv };
  const claimed = k => s[k] !== undefined && s[k] !== 'absent' && s[k] !== 'false';
  if (claimed('S') && claimed('H')) return false;
  if (s.R === 'absent' && (claimed('S') || claimed('H') || s.I === 'present')) return false;
  if (s.V === 'no-handback' && (claimed('S') || claimed('H') || claimed('R') || s.I === 'present' || s.M === 'true')) return false;
  return true;
}

function completeRow(spec) {
  const r = { S: 'absent', H: 'absent', R: 'absent', I: 'absent', T: 'clean', C: 'ok', V: 'valid', M: 'false', ...spec };
  if (r.V === 'no-handback') { r.S = 'absent'; r.H = 'absent'; r.R = 'absent'; r.I = 'absent'; r.M = 'false'; }
  if (spec.R === undefined) r.R = r.S !== 'absent' || r.H !== 'absent' || r.I === 'present' ? 'equal' : 'absent';
  if (r.R !== 'absent' && r.S === 'absent' && r.H === 'absent') {
    // A candidate object needs exactly one claim — fill whichever claim axis
    // the spec did not pin to 'absent'.
    if (spec.S === 'absent') r.H = 'equal'; else r.S = 'equal';
  }
  return r;
}

const CORE_AXES = ['S', 'H', 'R', 'I', 'T', 'C', 'V', 'M'];
function uncoveredPairs(rows) {
  const missing = [];
  for (let a = 0; a < CORE_AXES.length; a++) {
    for (let b = a + 1; b < CORE_AXES.length; b++) {
      const [xa, ya] = [CORE_AXES[a], CORE_AXES[b]];
      for (const xv of AXES[xa]) {
        for (const yv of AXES[ya]) {
          if (!pairFeasible(xa, xv, ya, yv)) continue;
          if (!rows.some(r => r[xa] === xv && r[ya] === yv)) missing.push([xa, xv, ya, yv]);
        }
      }
    }
  }
  return missing;
}

// The domain table: the 36-row T×C spine with rotated claim axes, then patch
// rows until every feasible pair in the core pairwise group is covered.
const ROWS = (() => {
  const rows = [];
  const vPattern = ['valid', 'valid', 'valid', 'invalid', 'valid', 'valid', 'unsupported-version', 'no-handback'];
  let i = 0;
  for (const T of AXES.T) {
    for (const C of AXES.C) {
      const spec = { T, C };
      spec.S = AXES.S[i % 3];
      spec.H = spec.S === 'absent' ? AXES.H[i % 3] : 'absent';
      if (spec.S === 'absent' && spec.H === 'absent') spec.R = i % 2 === 0 ? 'absent' : 'equal';
      else spec.R = ['equal', 'different', 'equal'][i % 3];
      spec.I = i % 4 === 1 ? 'present' : 'absent';
      spec.V = vPattern[i % vPattern.length];
      spec.M = i % 5 === 0 ? 'true' : 'false';
      rows.push(completeRow(spec));
      i += 1;
    }
  }
  let guard = 0;
  for (let missing = uncoveredPairs(rows); missing.length > 0 && guard < 300; missing = uncoveredPairs(rows)) {
    const [xa, xv, ya, yv] = missing[0];
    rows.push(completeRow({ [xa]: xv, [ya]: yv }));
    guard += 1;
  }
  return rows;
})();

async function exercise(t, row) {
  const w = world(t);
  if (row.T) mutate(w, row.T);
  const after = w.measure();
  const blocks = row.blocks ?? blocksFor(w, row, after);
  const reportPath = w.writeReport(blocks);
  const input = {
    reportPath, repo: w.repo, paseoHome: row.paseoHome ?? w.home,
    expectParent: row.expectParent ?? null, expectWorkspace: row.expectWorkspace ?? null,
    expectContract: row.contractPin ?? w.contract,
    ...(row.expectFiles ? { expectFiles: row.expectFiles } : {}),
  };
  const internals = { ...internalsFor(row), ...(row.internals ?? {}) };
  const view = await verifyHandback(input, internals);
  return { w, view };
}

// §5.3 oracle re-derived in test: what the view must say for a row.
function assertRow(row, view) {
  assert.equal(view.schemaVersion, 1);
  assert.equal(view.kind, 'slp-verify-handback');
  assert.equal(view.record.validation, row.V);
  assert.equal(view.record.multiple, row.M === 'true');
  assert.ok(COMPARISON.includes(view.contract.result));
  assert.equal(view.contract.result, 'match'); // spine pins always match

  const degraded = row.C !== 'ok';
  const gitlinkDirty = row.C === 'ok' && row.T === 'gitlink-non-clean';
  if (degraded) {
    assert.equal(view.observation.state, 'incomplete');
    assert.equal(view.observation.reason, row.C);
    assert.equal(view.observation.head, null);
    assert.equal(view.observation.snapshotSha256, null);
    assert.equal(view.observation.clean, null);
    assert.equal(view.observation.captures, row.C === 'drift' ? 3 : 1);
  } else if (gitlinkDirty) {
    assert.equal(view.observation.state, 'incomplete');
    assert.equal(view.observation.reason, 'gitlink-non-clean');
    assert.deepEqual(view.observation.incompletePaths, ['glink']);
    assert.equal(view.observation.clean, null);
    assert.equal(view.observation.captures, 2);
  } else {
    assert.equal(view.observation.state, 'complete');
    assert.equal(view.observation.reason, null);
    assert.equal(view.observation.clean, row.T === 'clean');
    assert.equal(view.observation.captures, 2);
    assert.notEqual(view.observation.head, null);
    assert.notEqual(view.observation.snapshotSha256, null);
  }
  assert.equal(view.observation.nestedCount, degraded ? 0 : row.T === 'nested-repo-dirty' ? 1 : 0);

  if (row.V !== 'valid') {
    assert.equal(view.candidate, null);
    assert.deepEqual(view.checks, []);
    assert.equal(view.seat, null);
    assert.equal(view.summary, 'record-invalid');
    return;
  }

  const cand = view.candidate;
  if (row.R === 'absent') assert.equal(cand, null);
  else {
    assert.equal(cand.repository.result, row.R === 'equal' ? 'match' : 'mismatch');
    if (row.R === 'different') assert.equal(cand.repository.reason, null);
    const claim = (field, value) => {
      const c = cand[field];
      if (value === 'absent') {
        assert.equal(c.result, 'report-only', `${field} report-only`);
        assert.equal(c.claim, null);
      } else if (degraded) {
        assert.equal(c.result, 'incomplete', `${field} incomplete under C=${row.C}`);
        assert.equal(c.reason, row.C);
        assert.equal(c.observed, null);
      } else if (field === 'snapshotSha256' && gitlinkDirty) {
        assert.equal(c.result, 'incomplete');
        assert.equal(c.reason, 'gitlink-non-clean');
      } else assert.equal(c.result, value === 'equal' ? 'match' : 'mismatch', `${field} ${value}`);
    };
    claim('snapshotSha256', row.S);
    claim('head', row.H);
    const cleanClaimed = row.H !== 'absent' && row.S === 'absent';
    if (!cleanClaimed) assert.equal(cand.clean.result, 'report-only');
    else if (degraded) assert.deepEqual([cand.clean.result, cand.clean.reason], ['incomplete', row.C]);
    else if (gitlinkDirty) assert.deepEqual([cand.clean.result, cand.clean.reason], ['incomplete', 'gitlink-non-clean']);
    else assert.equal(cand.clean.result, row.T === 'clean' ? 'match' : 'mismatch');
    if (row.I === 'absent') assert.equal(cand.claimIncomplete, null);
    else assert.deepEqual([cand.claimIncomplete.result, cand.claimIncomplete.reason], ['incomplete', 'claim-incomplete']);
  }

  assert.equal(view.seat.result, 'report-only'); // spine rows never name a seat
  assert.ok(!view.limitations.includes('seat observation reads daemon files (host-internal format)'));
  const issueCodes = [...view.record.errors, ...view.record.warnings].map(e => e.code);
  if (row.M === 'true') assert.ok(issueCodes.includes('multiple-records'));
  if (row.I === 'present') assert.ok(issueCodes.includes('candidate-incomplete'));
  if (row.R === 'different') assert.ok(issueCodes.includes('repository-mismatch'));
  for (const entry of [...view.record.errors, ...view.record.warnings]) {
    assert.ok(RECORD_CODES.includes(entry.code), `issue code ${entry.code} in closed vocabulary`);
    assert.ok(entry.blockIndex === null || Number.isInteger(entry.blockIndex));
  }
  const outcomes = [];
  if (cand !== null) {
    for (const field of ['repository', 'head', 'snapshotSha256', 'clean']) outcomes.push(cand[field].result);
    if (cand.claimIncomplete !== null) outcomes.push('incomplete');
  }
  outcomes.push(view.contract.result);
  const expectedSummary = outcomes.includes('mismatch') ? 'mismatch'
    : outcomes.includes('incomplete') || view.observation.state === 'incomplete' ? 'incomplete' : 'match';
  assert.equal(view.summary, expectedSummary);
  assert.equal(view.quiescence, 'not-established-by-this-view');
  assert.equal(view.acceptance, 'not-established-by-this-view');
}

test('spine T×C (36 rows) plus patched pairwise coverage', async t => {
  for (const [index, row] of ROWS.entries()) {
    await t.test(`row ${index}: ${JSON.stringify(row)}`, async t2 => {
      const { view } = await exercise(t2, row);
      assertRow(row, view);
    });
  }
});

test('coverage oracle — every axis value and every feasible core pair appears', () => {
  for (const axis of CORE_AXES) {
    for (const value of AXES[axis]) {
      assert.ok(ROWS.some(row => row[axis] === value), `axis ${axis} value ${value} never appears`);
    }
  }
  assert.deepEqual(uncoveredPairs(ROWS), [], 'feasible core pairs left uncovered');
});

// Errata E2: the predicate must exclude exactly the infeasible classes — no
// more (that would mask coverage) and no less (those pairs cannot be built).
test('coverage oracle — pairFeasible excludes exactly the errata-E2 classes', () => {
  const infeasible = [];
  for (let a = 0; a < CORE_AXES.length; a++) {
    for (let b = a + 1; b < CORE_AXES.length; b++) {
      for (const xv of AXES[CORE_AXES[a]]) {
        for (const yv of AXES[CORE_AXES[b]]) {
          if (!pairFeasible(CORE_AXES[a], xv, CORE_AXES[b], yv)) {
            infeasible.push(`${CORE_AXES[a]}=${xv}|${CORE_AXES[b]}=${yv}`);
          }
        }
      }
    }
  }
  const expected = [];
  // S and H both claimed — the parser's exactly-one rule makes them exclusive.
  for (const s of ['equal', 'different']) for (const h of ['equal', 'different']) expected.push(`S=${s}|H=${h}`);
  // No candidate object (R=absent) cannot carry an S/H/I claim. Keys are in
  // CORE_AXES order — R precedes I, so the I pair renders as R=absent|I=present.
  for (const [ax, v] of [['S', 'equal'], ['S', 'different'], ['H', 'equal'], ['H', 'different']]) {
    expected.push(`${ax}=${v}|R=absent`);
  }
  expected.push('R=absent|I=present');
  // no-handback carries no record at all: no claim axes, and M=true needs
  // two handbacks, contradicting zero.
  for (const [ax, v] of [['S', 'equal'], ['S', 'different'], ['H', 'equal'], ['H', 'different'], ['R', 'equal'], ['R', 'different'], ['I', 'present']]) {
    expected.push(`${ax}=${v}|V=no-handback`);
  }
  expected.push('V=no-handback|M=true');
  assert.deepEqual(infeasible.sort(), expected.sort());
});

// ---- K suite: every check-evidence value on a clean repo -------------------
const EVIDENCE_OUTPUT = 'tests passed\n';
const EVIDENCE_SHA = sha256hex(EVIDENCE_OUTPUT);
const K_CHECKS = {
  'output-consistent': { cmd: 'npm test', exit: 0, sha: EVIDENCE_SHA, output: EVIDENCE_OUTPUT },
  'output-inconsistent': { cmd: 'npm test', exit: 0, sha: flip(EVIDENCE_SHA), output: EVIDENCE_OUTPUT },
  'outputRef-consistent': { cmd: 'npm test', exit: 0, sha: EVIDENCE_SHA, outputRef: 'evidence.txt' },
  'outputRef-inconsistent': { cmd: 'npm test', exit: 0, sha: flip(EVIDENCE_SHA), outputRef: 'evidence.txt' },
  'outputRef-unreadable': { cmd: 'npm test', exit: 0, sha: EVIDENCE_SHA, outputRef: 'missing.txt' },
  'no-evidence': { cmd: 'npm test', exit: 0, sha: null },
};
const K_CONSISTENCY = {
  'output-consistent': 'consistent', 'output-inconsistent': 'inconsistent',
  'outputRef-consistent': 'consistent', 'outputRef-inconsistent': 'inconsistent',
  'outputRef-unreadable': 'unverified', 'no-evidence': 'unverified',
};
test('K suite — one fixture per check-evidence value', async t => {
  assert.deepEqual(Object.keys(K_CHECKS).sort(), [...AXES.K].sort(), 'K table must name every axis value');
  for (const k of AXES.K) {
    await t.test(k, async t2 => {
      const w = world(t2);
      if (k.startsWith('outputRef-') && k !== 'outputRef-unreadable') writeFileSync(join(w.repo, 'evidence.txt'), EVIDENCE_OUTPUT);
      const after = w.measure();
      const record = buildRecord(w, completeRow({ S: 'equal' }), after);
      record.checks = [K_CHECKS[k]];
      const view = await verifyHandback({
        reportPath: w.writeReport([record]), repo: w.repo, paseoHome: w.home,
        expectParent: null, expectWorkspace: null, expectContract: w.contract,
      });
      assert.equal(view.checks.length, 1);
      assert.equal(view.checks[0].provenance, 'claimed');
      assert.equal(view.checks[0].consistency, K_CONSISTENCY[k]);
      assert.equal(view.checks[0].cmdSha256, sha256hex(K_CHECKS[k].cmd));
      assert.equal(view.checks[0].exit, 0);
      const codes = [...view.record.errors, ...view.record.warnings].map(e => e.code);
      if (K_CONSISTENCY[k] === 'inconsistent') assert.ok(codes.includes('sha-mismatch'));
      if (k === 'outputRef-unreadable' || k === 'no-evidence') assert.ok(codes.includes('check-evidence-missing'));
      if (K_CONSISTENCY[k] === 'consistent') assert.ok(!codes.includes('sha-mismatch') && !codes.includes('check-evidence-missing'));
    });
  }
});

// ---- P suite: contract pin and artifact pin -------------------------------
test('P suite — contract pin values', async t => {
  for (const p of AXES.P) {
    await t.test(`contract ${p}`, async t2 => {
      const w = world(t2);
      const after = w.measure();
      const record = buildRecord(w, completeRow({ S: 'equal' }), after);
      const input = {
        reportPath: w.writeReport([record]), repo: w.repo, paseoHome: w.home,
        expectParent: null, expectWorkspace: null, expectContract: w.contract,
      };
      let internals = {};
      if (p === 'different') input.expectContract = { path: 'CONTRACT.md', sha256: flip(w.contract.sha256) };
      if (p === 'missing') input.expectContract = { path: 'MISSING.md', sha256: w.contract.sha256 };
      if (p === 'over-cap') {
        writeFileSync(join(w.repo, 'BIG.md'), Buffer.alloc(VERIFY_LIMITS.pinMaxBytes + 1, 0x61));
        input.expectContract = { path: 'BIG.md', sha256: w.contract.sha256 };
      }
      if (p === 'drift') {
        let reads = 0;
        internals = {
          readPin: path => {
            reads += 1;
            try {
              const bytes = readFileSync(path);
              if (bytes.length > VERIFY_LIMITS.pinMaxBytes) return { state: 'over-cap' };
              return { state: 'ok', bytes: path.endsWith('CONTRACT.md') && reads === 2 ? Buffer.concat([bytes, Buffer.from('x')]) : bytes };
            } catch { return { state: 'missing' }; }
          },
        };
      }
      const view = await verifyHandback(input, internals);
      const expected = { equal: 'match', different: 'mismatch', missing: 'incomplete', 'over-cap': 'incomplete', drift: 'incomplete' }[p];
      assert.equal(view.contract.result, expected);
      if (expected === 'incomplete') assert.equal(view.contract.reason, p);
      assert.ok(view.summary === 'mismatch' || view.summary === 'incomplete' || view.summary === 'match');
    });
  }
});

test('P suite — artifact pin values (contract stays matched)', async t => {
  for (const p of AXES.P) {
    await t.test(`artifact ${p}`, async t2 => {
      const w = world(t2);
      const after = w.measure();
      const record = buildRecord(w, completeRow({ S: 'equal' }), after);
      const pinSha = sha256hex(readFileSync(join(w.repo, 'pin.txt')));
      const pin = { path: 'pin.txt', sha256: pinSha };
      const input = {
        reportPath: w.writeReport([record]), repo: w.repo, paseoHome: w.home,
        expectParent: null, expectWorkspace: null, expectContract: w.contract,
        expectFiles: [pin],
      };
      let internals = {};
      if (p === 'different') pin.sha256 = flip(pinSha);
      if (p === 'missing') pin.path = 'MISSING.txt';
      if (p === 'over-cap') {
        writeFileSync(join(w.repo, 'big.txt'), Buffer.alloc(VERIFY_LIMITS.pinMaxBytes + 1, 0x62));
        pin.path = 'big.txt';
      }
      if (p === 'drift') {
        const target = resolve(w.repo, 'pin.txt');
        let reads = 0;
        internals = {
          readPin: path => {
            try {
              const bytes = readFileSync(path);
              if (bytes.length > VERIFY_LIMITS.pinMaxBytes) return { state: 'over-cap' };
              if (path === target) { reads += 1; if (reads === 2) return { state: 'ok', bytes: Buffer.concat([bytes, Buffer.from('x')]) }; }
              return { state: 'ok', bytes };
            } catch { return { state: 'missing' }; }
          },
        };
      }
      const view = await verifyHandback(input, internals);
      assert.equal(view.pins.length, 1);
      const expected = { equal: 'match', different: 'mismatch', missing: 'incomplete', 'over-cap': 'incomplete', drift: 'incomplete' }[p];
      assert.equal(view.pins[0].result, expected);
      if (expected === 'incomplete') assert.equal(view.pins[0].reason, p);
      assert.equal(view.contract.result, 'match');
    });
  }
});

// ---- G suite: seat observation over a fake <paseoHome>/agents/ ------------
const SEAT_ID = 'seat-0000-1111-2222-333344445555';
const seatState = (w, over = {}) => ({
  id: SEAT_ID, provider: 'slp-devin-peer',
  labels: { 'paseo.parent-agent-id': 'lead-aaaa' },
  workspaceId: 'wks_seat', cwd: w.repo, ...over,
});
test('G suite — one fixture per seat value', async t => {
  const cases = {
    'all-match': {},
    'agentId-absent': { agentId: null, file: null },
    'agent-absent': { file: null },
    'agent-record-unreadable': { file: '{broken json' },
    'role-different': { file: { provider: 'slp-devin-lead' } },
    'not-slp-provider': { file: { provider: 'devin-peer' } },
    'parent-label-absent': { file: { labels: {} } },
    'parent-different': { file: { labels: { 'paseo.parent-agent-id': 'lead-bbbb' } } },
    'no-expect-parent': { expectParent: null, parentSet: false },
    'workspace-different': { file: { workspaceId: 'wks_other' } },
    'no-expect-workspace': { expectWorkspace: null, workspaceSet: false },
    'cwd-other-repo': { otherRepo: true },
    'cwd-worktree-same-repo': { worktree: true },
    'cwd-not-git': { file: { cwd: w => w.other } },
    'seat-source-unavailable': { homeNoAgents: true },
    'duplicate-agent-records': { duplicate: true },
  };
  assert.deepEqual(Object.keys(cases).sort(), [...AXES.G].sort(), 'G table must name every axis value');

  for (const g of AXES.G) {
    await t.test(g, async t2 => {
      const w = world(t2);
      const spec = cases[g];
      const after = w.measure();
      const agentId = spec.agentId === null ? undefined : SEAT_ID;
      const record = buildRecord(w, completeRow({ S: 'equal' }), after);
      if (agentId) record.seat.agentId = agentId;
      const expectParent = spec.parentSet === false ? null : 'lead-aaaa';
      const expectWorkspace = spec.workspaceSet === false ? null : 'wks_seat';
      let paseoHome = w.home;
      if (spec.homeNoAgents) { paseoHome = join(w.dir, 'noagents'); mkdirSync(paseoHome); }
      if (spec.file !== null && !spec.homeNoAgents) {
        const fields = typeof spec.file === 'string' ? spec.file : seatState(w, spec.file ? mapSpecFields(w, spec.file) : {});
        w.seatFile(SEAT_ID, fields);
        if (spec.duplicate) w.seatFile(SEAT_ID, fields, 'grp-b');
      }
      if (spec.otherRepo) {
        const other = join(w.dir, 'other-repo');
        mkdirSync(other); git(other, ['init', '-q']); git(other, ['config', 'user.email', 'v@t']); git(other, ['config', 'user.name', 'V']);
        writeFileSync(join(other, 'f'), 'x'); git(other, ['add', '-A']); git(other, ['commit', '-qm', 'o']);
        w.seatFile(SEAT_ID, seatState(w, { cwd: other }));
      }
      if (spec.worktree) {
        const wt = join(w.dir, 'wt');
        git(w.repo, ['worktree', 'add', '-q', wt, 'HEAD']);
        w.seatFile(SEAT_ID, seatState(w, { cwd: wt }));
      }
      const view = await verifyHandback({
        reportPath: w.writeReport([record]), repo: w.repo, paseoHome,
        expectParent, expectWorkspace, expectContract: w.contract,
      });
      assertG(g, view, w);
    });
  }
});
function mapSpecFields(w, fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = typeof v === 'function' ? v(w) : v;
  return out;
}

function assertG(g, view, w) {
  const seat = view.seat;
  if (g === 'agentId-absent') {
    assert.deepEqual(seat, { agentId: null, result: 'report-only', observed: null, comparisons: null });
    assert.ok(!view.limitations.includes('seat observation reads daemon files (host-internal format)'));
    return;
  }
  assert.ok(view.limitations.includes('seat observation reads daemon files (host-internal format)'));
  const cmp = seat.comparisons;
  const allIncomplete = reason => {
    for (const key of ['exists', 'role', 'parent', 'workspace', 'cwd']) {
      assert.equal(cmp[key].result, 'incomplete', `${key}`);
      assert.equal(cmp[key].reason, reason, `${key} reason`);
    }
  };
  switch (g) {
    case 'seat-source-unavailable': allIncomplete('seat-source-unavailable'); assert.equal(seat.result, 'incomplete'); return;
    case 'agent-record-unreadable': allIncomplete('agent-record-unreadable'); assert.equal(seat.result, 'incomplete'); return;
    case 'duplicate-agent-records': allIncomplete('duplicate-agent-records'); assert.equal(seat.result, 'incomplete'); return;
    case 'agent-absent':
      assert.equal(cmp.exists.result, 'mismatch');
      assert.equal(cmp.exists.observed, null);
      assert.equal(seat.result, 'mismatch');
      for (const key of ['role', 'parent', 'workspace', 'cwd']) assert.equal(cmp[key].result, 'report-only');
      return;
    case 'all-match':
      assert.equal(seat.result, 'match');
      assert.equal(cmp.cwd.relation, 'same-worktree');
      for (const key of ['exists', 'role', 'parent', 'workspace', 'cwd']) assert.equal(cmp[key].result, 'match', key);
      return;
    case 'role-different':
      assert.equal(cmp.role.result, 'mismatch'); assert.equal(cmp.role.reason, null);
      assert.equal(seat.observed.role, 'lead'); assert.equal(seat.result, 'mismatch'); return;
    case 'not-slp-provider':
      assert.equal(cmp.role.result, 'mismatch'); assert.equal(cmp.role.reason, 'not-slp-provider');
      assert.equal(seat.observed.role, null); assert.equal(seat.observed.family, null); return;
    case 'parent-label-absent':
      assert.equal(cmp.parent.result, 'incomplete'); assert.equal(cmp.parent.reason, 'parent-label-absent');
      assert.equal(seat.observed.parentAgentId, null); assert.equal(seat.result, 'incomplete'); return;
    case 'parent-different':
      assert.equal(cmp.parent.result, 'mismatch'); assert.equal(cmp.parent.observed, 'lead-bbbb'); return;
    case 'no-expect-parent':
      assert.equal(cmp.parent.result, 'report-only'); assert.equal(cmp.parent.expected, null);
      assert.equal(seat.result, 'match'); return;
    case 'workspace-different':
      assert.equal(cmp.workspace.result, 'mismatch'); assert.equal(cmp.workspace.observed, 'wks_other'); return;
    case 'no-expect-workspace':
      assert.equal(cmp.workspace.result, 'report-only'); assert.equal(seat.result, 'match'); return;
    case 'cwd-other-repo':
      assert.equal(cmp.cwd.result, 'mismatch'); assert.equal(cmp.cwd.relation, null); return;
    case 'cwd-worktree-same-repo':
      assert.equal(cmp.cwd.result, 'match'); assert.equal(cmp.cwd.relation, 'other-worktree'); return;
    case 'cwd-not-git':
      assert.equal(cmp.cwd.result, 'incomplete'); assert.equal(cmp.cwd.reason, 'cwd-not-git'); return;
    default: throw new Error(`unasserted G value ${g}`);
  }
}

// ---- Typed error suite -----------------------------------------------------
const expectCode = (code, promise) => assert.rejects(promise, error => {
  assert.ok(error instanceof VerifyError, `expected VerifyError, got ${error}`);
  assert.equal(error.code, code);
  assert.ok(error.message.length <= VERIFY_LIMITS.errorMessageLen);
  return true;
});

async function invalidInput(t, over) {
  const w = world(t);
  const base = {
    reportPath: w.writeReport([buildRecord(w, completeRow({}), w.measure())]),
    repo: w.repo, paseoHome: w.home, expectParent: null, expectWorkspace: null,
    expectContract: w.contract,
  };
  return verifyHandback({ ...base, ...over });
}

test('typed errors — INVALID_REQUEST branches', async t => {
  await t.test('unknown input key', t2 => expectCode('INVALID_REQUEST', invalidInput(t2, { bogus: 1 })));
  await t.test('relative repo', t2 => expectCode('INVALID_REQUEST', invalidInput(t2, { repo: 'relative/path' })));
  await t.test('missing expectContract', t2 => expectCode('INVALID_REQUEST', invalidInput(t2, { expectContract: undefined })));
  await t.test('pin path escapes root', t2 => expectCode('INVALID_REQUEST', invalidInput(t2, { expectContract: { path: '../escape', sha256: 'a'.repeat(64) } })));
  await t.test('pin bad sha', t2 => expectCode('INVALID_REQUEST', invalidInput(t2, { expectContract: { path: 'CONTRACT.md', sha256: 'ZZZ' } })));
  await t.test('duplicate pin paths', t2 => expectCode('INVALID_REQUEST', invalidInput(t2, { expectFiles: [{ path: 'CONTRACT.md', sha256: 'a'.repeat(64) }] })));
  await t.test('pins over cap', t2 => expectCode('INVALID_REQUEST', invalidInput(t2, {
    expectFiles: Array.from({ length: VERIFY_LIMITS.pins + 1 }, (_, i) => ({ path: `f${i}.txt`, sha256: 'a'.repeat(64) })),
  })));
  await t.test('missing report', t2 => expectCode('INVALID_REQUEST', invalidInput(t2, { reportPath: join(tmpdir(), 'does-not-exist-slp-verify.md') })));
  await t.test('report over cap', async t2 => {
    const w = world(t2);
    const big = join(w.dir, 'big.md');
    writeFileSync(big, Buffer.alloc(VERIFY_LIMITS.reportMaxBytes + 1, 0x78));
    await expectCode('INVALID_REQUEST', verifyHandback({
      reportPath: big, repo: w.repo, paseoHome: w.home,
      expectParent: null, expectWorkspace: null, expectContract: w.contract,
    }));
  });
  await t.test('report not UTF-8', async t2 => {
    const w = world(t2);
    const bad = join(w.dir, 'bad.md');
    writeFileSync(bad, Buffer.from([0xff, 0xfe, 0xfd, 0x80]));
    await expectCode('INVALID_REQUEST', verifyHandback({
      reportPath: bad, repo: w.repo, paseoHome: w.home,
      expectParent: null, expectWorkspace: null, expectContract: w.contract,
    }));
  });
  await t.test('repo not a git work tree', async t2 => {
    const w = world(t2);
    await expectCode('INVALID_REQUEST', verifyHandback({
      reportPath: w.writeReport([buildRecord(w, completeRow({}), w.measure())]),
      repo: w.other, paseoHome: w.home, expectParent: null, expectWorkspace: null, expectContract: w.contract,
    }));
  });
});

test('typed errors — CAPABILITY_GAP only from preflight', async t => {
  await t.test('git ENOENT at preflight', async t2 => {
    const w = world(t2);
    await expectCode('CAPABILITY_GAP', verifyHandback({
      reportPath: w.writeReport([buildRecord(w, completeRow({}), w.measure())]),
      repo: w.repo, paseoHome: w.home, expectParent: null, expectWorkspace: null, expectContract: w.contract,
    }, { probe: argv => argv[0] === 'git' ? { error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), status: null, signal: null } : realProbe(argv) }));
  });
  await t.test('git EACCES at preflight', async t2 => {
    const w = world(t2);
    await expectCode('CAPABILITY_GAP', verifyHandback({
      reportPath: w.writeReport([buildRecord(w, completeRow({}), w.measure())]),
      repo: w.repo, paseoHome: w.home, expectParent: null, expectWorkspace: null, expectContract: w.contract,
    }, { probe: argv => argv[0] === 'git' ? { error: Object.assign(new Error('spawn git EACCES'), { code: 'EACCES' }), status: null, signal: null } : realProbe(argv) }));
  });
  await t.test('git --version exit!=0 is IO_FAILURE not GAP', async t2 => {
    const w = world(t2);
    await expectCode('IO_FAILURE', verifyHandback({
      reportPath: w.writeReport([buildRecord(w, completeRow({}), w.measure())]),
      repo: w.repo, paseoHome: w.home, expectParent: null, expectWorkspace: null, expectContract: w.contract,
    }, { probe: argv => argv[0] === 'git' ? { status: 2, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } : realProbe(argv) }));
  });
});

test('typed errors — post-preflight child failures are IO_FAILURE', async t => {
  const worldWith = t2 => {
    const w = world(t2);
    return [w, {
      reportPath: w.writeReport([buildRecord(w, completeRow({}), w.measure())]),
      repo: w.repo, paseoHome: w.home, expectParent: null, expectWorkspace: null, expectContract: w.contract,
    }];
  };
  await t.test('snapshot child ENOENT after preflight', async t2 => {
    const [w, input] = worldWith(t2);
    await expectCode('IO_FAILURE', verifyHandback(input, {
      probe: argv => isSnapshotProbe(argv) ? { error: Object.assign(new Error('gone'), { code: 'ENOENT' }), status: null, signal: null } : realProbe(argv),
    }));
  });
  await t.test('snapshot child exit != 0', async t2 => {
    const [w, input] = worldWith(t2);
    await expectCode('IO_FAILURE', verifyHandback(input, {
      probe: argv => isSnapshotProbe(argv) ? { status: 3, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } : realProbe(argv),
    }));
  });
  await t.test('snapshot child killed by signal', async t2 => {
    const [w, input] = worldWith(t2);
    await expectCode('IO_FAILURE', verifyHandback(input, {
      probe: argv => isSnapshotProbe(argv) ? { status: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } : realProbe(argv),
    }));
  });
  await t.test('snapshot child stdout not JSON', async t2 => {
    const [w, input] = worldWith(t2);
    await expectCode('IO_FAILURE', verifyHandback(input, {
      probe: argv => isSnapshotProbe(argv) ? { status: 0, signal: null, stdout: Buffer.from('not json{'), stderr: Buffer.alloc(0) } : realProbe(argv),
    }));
  });
  await t.test('status probe exit != 0', async t2 => {
    const [w, input] = worldWith(t2);
    await expectCode('IO_FAILURE', verifyHandback(input, {
      probe: argv => isStatusProbe(argv) ? { status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } : realProbe(argv),
    }));
  });
});

// F1/C-S1 — child output that parses but is malformed must fail loud
// (§6.1 step 4), never degrade into an observation. Every seam below runs
// through the same verifyHandback Interface; each case must surface
// IO_FAILURE (the CLI maps it to `IO_FAILURE:` stderr, exit 1, empty stdout —
// that mapping is asserted in tests/verify-handback-cli.test.mjs).
test('typed errors — malformed child output after exit 0 is IO_FAILURE', async t => {
  const worldWith = t2 => {
    const w = world(t2);
    return [w, {
      reportPath: w.writeReport([buildRecord(w, completeRow({}), w.measure())]),
      repo: w.repo, paseoHome: w.home, expectParent: null, expectWorkspace: null, expectContract: w.contract,
    }];
  };
  const isRepoProbe = argv => argv[0] === 'git' && argv.includes('--is-inside-work-tree');
  const snapshotProbe = (t2, stdout) => verifyHandback(worldWith(t2)[1], {
    probe: argv => isSnapshotProbe(argv) ? { status: 0, signal: null, stdout, stderr: Buffer.alloc(0) } : realProbe(argv),
  });

  // (a) a 0xff byte inside the sha256 string — non-UTF-8, fatal decode fails.
  await t.test('snapshot sha256 carries a non-UTF-8 byte', async t2 => {
    const stdout = Buffer.concat([Buffer.from('{"sha256":"'), Buffer.from([0xff, 0xfe]), Buffer.from('","head":null,"files":[]}')]);
    await expectCode('IO_FAILURE', snapshotProbe(t2, stdout));
  });
  // (b) valid JSON, but sha256 fails SHA256_PATTERN.
  await t.test('snapshot sha256 is not a sha256', async t2 => {
    const stdout = Buffer.from(JSON.stringify({ sha256: 'not-a-sha', head: null, files: [] }));
    await expectCode('IO_FAILURE', snapshotProbe(t2, stdout));
  });
  await t.test('snapshot head is not an oid', async t2 => {
    const stdout = Buffer.from(JSON.stringify({ sha256: 'a'.repeat(64), head: 'HEAD~1', files: [] }));
    await expectCode('IO_FAILURE', snapshotProbe(t2, stdout));
  });
  await t.test('snapshot files entry is off-shape', async t2 => {
    const stdout = Buffer.from(JSON.stringify({ sha256: 'a'.repeat(64), head: null, files: [{ path: 42 }] }));
    await expectCode('IO_FAILURE', snapshotProbe(t2, stdout));
  });
  await t.test('snapshot incomplete carries a non-string', async t2 => {
    const stdout = Buffer.from(JSON.stringify({ sha256: 'a'.repeat(64), head: null, files: [], incomplete: [42] }));
    await expectCode('IO_FAILURE', snapshotProbe(t2, stdout));
  });
  // (c) repo rev-parse emits a correct prefix but an extra GARBAGE line.
  await t.test('repo rev-parse carries an extra line', async t2 => {
    const [, input] = worldWith(t2);
    await expectCode('IO_FAILURE', verifyHandback(input, {
      probe: argv => {
        const result = realProbe(argv);
        if (isRepoProbe(argv) && result.status === 0) return { ...result, stdout: Buffer.concat([result.stdout, Buffer.from('GARBAGE\n')]) };
        return result;
      },
    }));
  });
  await t.test('repo rev-parse drops a line', async t2 => {
    const [, input] = worldWith(t2);
    await expectCode('IO_FAILURE', verifyHandback(input, {
      probe: argv => {
        const result = realProbe(argv);
        if (isRepoProbe(argv) && result.status === 0) return { ...result, stdout: Buffer.from('true\n') };
        return result;
      },
    }));
  });
  // (d) status output that is not porcelain v1 line format.
  await t.test('status probe emits a non-porcelain line', async t2 => {
    const [, input] = worldWith(t2);
    await expectCode('IO_FAILURE', verifyHandback(input, {
      probe: argv => isStatusProbe(argv) ? { status: 0, signal: null, stdout: Buffer.from('this is not porcelain\n'), stderr: Buffer.alloc(0) } : realProbe(argv),
    }));
  });
  await t.test('status probe emits a truncated status line', async t2 => {
    const [, input] = worldWith(t2);
    await expectCode('IO_FAILURE', verifyHandback(input, {
      probe: argv => isStatusProbe(argv) ? { status: 0, signal: null, stdout: Buffer.from('M \n'), stderr: Buffer.alloc(0) } : realProbe(argv),
    }));
  });
  await t.test('status probe emits non-UTF-8', async t2 => {
    const [, input] = worldWith(t2);
    await expectCode('IO_FAILURE', verifyHandback(input, {
      probe: argv => isStatusProbe(argv) ? { status: 0, signal: null, stdout: Buffer.from([0x4d, 0x20, 0xff, 0x0a]), stderr: Buffer.alloc(0) } : realProbe(argv),
    }));
  });
});

test('F3 — a tracked file type-changed to a symlink reads as T, dirty', async t => {
  // Porcelain v1 status 'T' (typechange): replace a tracked regular file
  // with a symlink. The parser must accept the line — before the F3 fix this
  // would IO_FAILURE — and the tree must read dirty, so a head-only claim
  // (clean-commit oracle) mismatches on clean.
  const w = world(t);
  unlinkSync(join(w.repo, 'seed.txt'));
  symlinkSync('CONTRACT.md', join(w.repo, 'seed.txt'));
  const after = w.measure();
  const record = buildRecord(w, completeRow({ H: 'equal' }), after);
  const view = await verifyHandback({
    reportPath: w.writeReport([record]), repo: w.repo, paseoHome: w.home,
    expectParent: null, expectWorkspace: null, expectContract: w.contract,
  });
  assert.equal(view.observation.state, 'complete');
  assert.equal(view.observation.clean, false);
  assert.equal(view.candidate.clean.result, 'mismatch');
});

// F2 — the single-source predicate is quote- and spacing-tolerant: any
// `new VerifyError('CAPABILITY_GAP'` construction is caught regardless of
// quote style (single, double, template) or interior whitespace, and the
// call-site guard counts capabilityGap( occurrences inside vs outside the
// preflight function body.
const GAP_CONSTRUCTION = /new\s+VerifyError\s*\(\s*['"`]CAPABILITY_GAP['"`]/g;
const GAP_CALL = /capabilityGap\(/g;
const PREFLIGHT_FN = /function capabilityPreflight\([^)]*\)\s*\{[\s\S]*?\n\}/;
const countMatches = (src, re) => (src.match(re) ?? []).length;

test('static — CAPABILITY_GAP has exactly one construction site and only the preflight calls it', () => {
  const source = readFileSync(ENGINE_PATH, 'utf8');
  assert.equal(countMatches(source, GAP_CONSTRUCTION), 1, 'exactly one VerifyError(CAPABILITY_GAP) construction');
  const preflight = source.match(PREFLIGHT_FN);
  assert.ok(preflight, 'capabilityPreflight function exists');
  assert.equal(countMatches(source, GAP_CALL), countMatches(preflight[0], GAP_CALL),
    'every capabilityGap( call must live inside capabilityPreflight');
});

test('static — the predicate fails on a second construction or call (mutation)', () => {
  const source = readFileSync(ENGINE_PATH, 'utf8');
  const mutants = [
    `${source}\nconst injected = new VerifyError("CAPABILITY_GAP", 'm');`,
    `${source}\nconst injected = new VerifyError(\`CAPABILITY_GAP\`, 'm');`,
    `${source}\nconst injected = new VerifyError(  'CAPABILITY_GAP'  , 'm');`,
    `${source}\nconst injected = new VerifyError(\n  'CAPABILITY_GAP',\n  'm'\n);`,
  ];
  for (const mutant of mutants) {
    assert.equal(countMatches(mutant, GAP_CONSTRUCTION), 2, 'a second construction must be detected in any quote/spacing style');
  }
  const callMutant = `${source}\ncapabilityGap('outside-preflight');`;
  const preflight = source.match(PREFLIGHT_FN)[0];
  assert.equal(countMatches(callMutant, GAP_CALL), countMatches(preflight, GAP_CALL) + 1,
    'a capabilityGap( call outside the preflight must unbalance the call-site guard');
});

// ---- Completeness ledger behavior ------------------------------------------
test('completeness ledger — checks row cap elides whole entries with a counted drop', async t => {
  const w = world(t);
  const after = w.measure();
  const record = buildRecord(w, completeRow({ S: 'equal' }), after);
  const over = VERIFY_LIMITS.checks + 3;
  record.checks = Array.from({ length: over }, (_, i) => ({ cmd: `check-${i}`, exit: 0, sha: null }));
  const view = await verifyHandback({
    reportPath: w.writeReport([record]), repo: w.repo, paseoHome: w.home,
    expectParent: null, expectWorkspace: null, expectContract: w.contract,
  });
  assert.equal(view.checks.length, VERIFY_LIMITS.checks);
  // The over-cap checks also over-fill record.warnings (each sha:null check
  // warns once) — both collections drop whole entries under row-limit.
  assert.deepEqual(view.completeness, [
    { collection: 'checks', reason: 'row-limit', count: over - VERIFY_LIMITS.checks },
    { collection: 'record.warnings', reason: 'row-limit', count: over - VERIFY_LIMITS.recordCodes },
  ]);
});

// ---- Integration fixtures --------------------------------------------------
test('integration — all-match (contract match, seat match)', async t => {
  const w = world(t);
  const after = w.measure();
  const record = buildRecord(w, completeRow({ S: 'equal', H: 'absent' }), after);
  record.seat.agentId = SEAT_ID;
  w.seatFile(SEAT_ID, seatState(w));
  const view = await verifyHandback({
    reportPath: w.writeReport([record]), repo: w.repo, paseoHome: w.home,
    expectParent: 'lead-aaaa', expectWorkspace: 'wks_seat', expectContract: w.contract,
  });
  assert.equal(view.summary, 'match');
  assert.equal(view.seat.result, 'match');
  assert.equal(view.candidate.snapshotSha256.result, 'match');
  assert.equal(view.contract.result, 'match');
});

test('integration — all-incomplete', async t => {
  const w = world(t);
  const after = w.measure();
  const record = buildRecord(w, completeRow({ S: 'equal' }), after);
  record.seat.agentId = SEAT_ID;
  w.seatFile(SEAT_ID, seatState(w));
  const view = await verifyHandback({
    reportPath: w.writeReport([record]), repo: w.repo, paseoHome: w.home,
    expectParent: 'lead-aaaa', expectWorkspace: 'wks_seat',
    expectContract: { path: 'MISSING.md', sha256: w.contract.sha256 },
  }, { probe: captureFault('timeout') });
  assert.equal(view.observation.state, 'incomplete');
  assert.equal(view.candidate.snapshotSha256.result, 'incomplete');
  assert.equal(view.seat.comparisons.cwd.result, 'incomplete');
  assert.equal(view.contract.result, 'incomplete');
  assert.equal(view.summary, 'incomplete');
});

test('integration — mismatch-mix', async t => {
  // candidate has exactly one of snapshotSha256/head (parser), so the
  // contract's "S match + H mismatch" cannot coexist in one record; this row
  // exercises the fold across snapshot-match, repository-mismatch and a
  // head-claim mismatch row alongside an absent seat.
  const w = world(t);
  const after = w.measure();
  const record = buildRecord(w, completeRow({ S: 'equal', R: 'different' }), after);
  record.seat.agentId = 'seat-absent-0000';
  const view = await verifyHandback({
    reportPath: w.writeReport([record]), repo: w.repo, paseoHome: w.home,
    expectParent: null, expectWorkspace: null, expectContract: w.contract,
  });
  assert.equal(view.candidate.snapshotSha256.result, 'match');
  assert.equal(view.candidate.repository.result, 'mismatch');
  assert.equal(view.seat.comparisons.exists.result, 'mismatch');
  assert.equal(view.seat.result, 'mismatch');
  assert.equal(view.summary, 'mismatch');
});

test('integration — no-handback pure observation', async t => {
  const w = world(t);
  const view = await verifyHandback({
    reportPath: w.writeReport(['plain markdown only — no slp-record']),
    repo: w.repo, paseoHome: w.home, expectParent: null, expectWorkspace: null,
    expectContract: w.contract,
  });
  assert.equal(view.record.validation, 'no-handback');
  assert.equal(view.candidate, null);
  assert.equal(view.seat, null);
  assert.equal(view.observation.state, 'complete');
  assert.equal(view.contract.result, 'match');
  assert.equal(view.summary, 'record-invalid');
});

// ---- Canonical fixture artifact -------------------------------------------
// C-S4 — the canonical fixture must re-derive byte-identical bytes. The
// fixture world is built on a fixed path under tmpdir so every embedded
// path/reportSha256 is deterministic, and fixture commits carry pinned dates
// (GIT_ENV). Three fields legitimately vary by machine or run and are
// normalized to literal tokens before hashing: generatedAt (wall clock),
// measurement.packageRoot and measurement.runtimeSha256 (the producing
// checkout's path and content). Everything else — claims, comparisons,
// contract/pin results, record codes, completeness — stays real, so the
// literal asserts the canonical view, not a scrubbed shell.
// R2-C1 — the test writes nothing into the repo tree: the artifact bytes are
// asserted in memory and dropped into the (cleaned) fixture dir for
// inspection, so a clean checkout without .local-checks passes on CI.
const CANONICAL_LITERAL_BYTES = 4542;
const CANONICAL_LITERAL_SHA256 = '962def198c809068f0cf075533fa972e75ea10e89f4ba6c8e0416a77d0c36ec1';
test('canonical representative fixture — reproducible bytes + sha256', async t => {
  const dir = join(tmpdir(), 'slp-p1-canonical-fixture');
  rmSync(dir, { recursive: true, force: true });
  const w = world(t, dir);
  const after = w.measure();
  const record = buildRecord(w, completeRow({ S: 'equal' }), after);
  record.checks = [K_CHECKS['output-consistent']];
  record.seat.agentId = SEAT_ID;
  w.seatFile(SEAT_ID, seatState(w));
  const view = await verifyHandback({
    reportPath: w.writeReport([record]), repo: w.repo, paseoHome: w.home,
    expectParent: 'lead-aaaa', expectWorkspace: 'wks_seat', expectContract: w.contract,
    expectFiles: [{ path: 'pin.txt', sha256: sha256hex(readFileSync(join(w.repo, 'pin.txt'))) }],
  });
  assert.equal(view.summary, 'match');
  const canonical = JSON.parse(JSON.stringify(view));
  canonical.generatedAt = '2000-01-01T00:00:00.000Z';
  canonical.measurement.packageRoot = '<package-root>';
  canonical.measurement.runtimeSha256 = '<runtime-sha256>';
  const bytes = Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
  writeFileSync(join(w.dir, 'canonical-fixture.json'), bytes);
  assert.equal(bytes.length, CANONICAL_LITERAL_BYTES);
  assert.equal(sha256hex(bytes), CANONICAL_LITERAL_SHA256, 'canonical fixture bytes drifted — re-derive and re-pin if the view change is intended');
  t.diagnostic(`canonical-fixture bytes=${bytes.length} sha256=${sha256hex(bytes)} (artifact at ${join(w.dir, 'canonical-fixture.json')} during the run)`);
});
