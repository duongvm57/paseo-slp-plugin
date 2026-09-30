// tests/plugin-desk-records-parity.test.mjs — P3-a parity oracle (contract
// §4): the TypeScript port in plugin/server/desk-records.ts must answer
// the same {valid, errors, warnings} as the authoritative
// src/report-records.mjs validateRecord on a shared fixture corpus.
//
// Both sides run with the same capabilities: the test injects the JS-side
// evidence behavior into the port through its readEvidence/realpath seams
// (real fs realpath + resolve + bounds-check + read), so identical inputs
// produce identical issues. Without a `repo` override both resolve
// outputRef under the record's own declared root, exactly as validateRecord
// does. Fixtures live under tmpdir().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateRecord } from '../src/report-records.mjs';
import { validateReportRecordV1, recomputeSha } from '../plugin/server/desk-records.ts';

function fixtureRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slp-records-parity-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = bytes => recomputeSha(bytes);
const EVIDENCE = 'line one\nline two\n';
const EVIDENCE_SHA = sha(Buffer.from(EVIDENCE, 'utf8'));
const FAKE_SHA = 'a'.repeat(64);
const HEAD = 'b'.repeat(40);
const SNAP = 'c'.repeat(64);

const seat = { role: 'peer', disposition: 'engineer', agentId: 'agent-1' };
const check = (over = {}) => ({ cmd: 'node test.mjs', exit: 0, sha: EVIDENCE_SHA, output: EVIDENCE, ...over });

const baseHandback = repo => ({
  version: 1,
  kind: 'handback',
  seat: { ...seat },
  verdict: 'APPROVE',
  candidate: { repository: repo, snapshotSha256: SNAP },
  checks: [check()],
});

function corpus(t, repo) {
  return [
    ['non-object', []],
    ['missing version', { kind: 'handback' }],
    ['bad version', { version: 2, kind: 'handback' }],
    ['missing kind', { version: 1 }],
    ['unknown kind', { version: 1, kind: 'notebook' }],
    ['handback missing fields', { version: 1, kind: 'handback' }],
    ['handback seat not object', { ...baseHandback(repo), seat: 'peer' }],
    ['handback seat empty role', { ...baseHandback(repo), seat: { ...seat, role: ' ' } }],
    ['handback seat empty disposition', { ...baseHandback(repo), seat: { ...seat, disposition: '' } }],
    ['handback seat bad agentId', { ...baseHandback(repo), seat: { ...seat, agentId: ' ' } }],
    ['handback bad verdict', { ...baseHandback(repo), verdict: 'LGTM' }],
    ['handback verdict null', { ...baseHandback(repo), verdict: null }],
    ['valid handback snapshot', baseHandback(repo)],
    ['valid handback head', { ...baseHandback(repo), candidate: { repository: repo, head: HEAD } }],
    ['candidate null', { ...baseHandback(repo), candidate: null }],
    ['candidate not object', { ...baseHandback(repo), candidate: 'repo' }],
    ['candidate relative repository', { ...baseHandback(repo), candidate: { repository: 'rel/path', snapshotSha256: SNAP } }],
    ['candidate empty repository', { ...baseHandback(repo), candidate: { repository: '', snapshotSha256: SNAP } }],
    ['candidate both pins', { ...baseHandback(repo), candidate: { repository: repo, snapshotSha256: SNAP, head: HEAD } }],
    ['candidate no pin', { ...baseHandback(repo), candidate: { repository: repo } }],
    ['candidate bad snapshot', { ...baseHandback(repo), candidate: { repository: repo, snapshotSha256: 'XYZ' } }],
    ['candidate bad head', { ...baseHandback(repo), candidate: { repository: repo, head: 'abc' } }],
    ['candidate incomplete non-array', { ...baseHandback(repo), candidate: { repository: repo, snapshotSha256: SNAP, incomplete: 'src' } }],
    ['candidate incomplete non-string item', { ...baseHandback(repo), candidate: { repository: repo, snapshotSha256: SNAP, incomplete: [1] } }],
    ['candidate incomplete warning', { ...baseHandback(repo), candidate: { repository: repo, snapshotSha256: SNAP, incomplete: ['src/a.ts'] } }],
    ['checks not array', { ...baseHandback(repo), checks: 'nope' }],
    ['check not object', { ...baseHandback(repo), checks: ['x'] }],
    ['check missing cmd key', { ...baseHandback(repo), checks: [{ exit: 0, sha: EVIDENCE_SHA, output: EVIDENCE }] }],
    ['check missing exit key', { ...baseHandback(repo), checks: [{ cmd: 'x', sha: EVIDENCE_SHA, output: EVIDENCE }] }],
    ['check missing sha key', { ...baseHandback(repo), checks: [{ cmd: 'x', exit: 0 }] }],
    ['check undefined cmd', { ...baseHandback(repo), checks: [check({ cmd: undefined })] }],
    ['check undefined sha', { ...baseHandback(repo), checks: [check({ sha: undefined })] }],
    ['check blank cmd', { ...baseHandback(repo), checks: [check({ cmd: ' ' })] }],
    ['check non-integer exit', { ...baseHandback(repo), checks: [check({ exit: '0' })] }],
    ['check bad sha shape', { ...baseHandback(repo), checks: [check({ sha: 'zz' })] }],
    ['check output non-string', { ...baseHandback(repo), checks: [check({ output: 5 })] }],
    ['check sha mismatch', { ...baseHandback(repo), checks: [check({ sha: FAKE_SHA })] }],
    ['check sha null no output', { ...baseHandback(repo), checks: [check({ sha: null, output: undefined })] }],
    ['check sha null with output', { ...baseHandback(repo), checks: [check({ sha: null })] }],
    ['check output no sha key', { ...baseHandback(repo), checks: [{ cmd: 'x', exit: 0, output: EVIDENCE }] }],
    ['check no evidence at all', { ...baseHandback(repo), checks: [{ cmd: 'x', exit: 0, sha: EVIDENCE_SHA }] }],
    ['check outputRef absolute', { ...baseHandback(repo), checks: [check({ output: undefined, outputRef: '/abs/out.txt' })] }],
    ['check outputRef traversal', { ...baseHandback(repo), checks: [check({ output: undefined, outputRef: '../escape.txt' })] }],
    ['check outputRef unreadable', { ...baseHandback(repo), checks: [check({ output: undefined, outputRef: 'missing.txt', sha: EVIDENCE_SHA })] }],
    ['check outputRef readable sha match', { ...baseHandback(repo), checks: [check({ output: undefined, outputRef: 'evidence.txt', sha: EVIDENCE_SHA })] }],
    ['check outputRef readable sha mismatch', { ...baseHandback(repo), checks: [check({ output: undefined, outputRef: 'evidence.txt', sha: FAKE_SHA })] }],
    ['check outputRef no root', { ...baseHandback(repo), candidate: null, checks: [check({ output: undefined, outputRef: 'evidence.txt', sha: EVIDENCE_SHA })] }],
    ['check candidate sub-record', { ...baseHandback(repo), checks: [check({ candidate: { repository: repo, head: HEAD } })] }],
    ['check candidate sub-record bad', { ...baseHandback(repo), checks: [check({ candidate: { repository: 'rel' } })] }],
    ['timeline non-object', { ...baseHandback(repo), timeline: 'x' }],
    ['timeline bad sessionId', { ...baseHandback(repo), timeline: { sessionId: ' ' } }],
    ['timeline sessionId null ok', { ...baseHandback(repo), timeline: { sessionId: null } }],
    ['settlement missing fields', { version: 1, kind: 'settlement' }],
    ['settlement minimal valid-ish', {
      version: 1, kind: 'settlement', task: 'p3', seat: { provider: 'codex', title: 'P3', agentId: null },
      timeline: { nativeHandle: null, sessionId: 's1', via: 'unchecked', export: null, gap: null },
      recordedBy: 'lead', at: '2026-01-01T00:00:00Z',
    }],
    ['settlement bad via', {
      version: 1, kind: 'settlement', task: null, seat: { provider: 'codex', title: 'x' },
      timeline: { nativeHandle: 'h', sessionId: null, via: 'dreams', export: null, gap: null },
      recordedBy: 'lead', at: '2026-01-01T00:00:00Z',
    }],
    ['settlement bad at', {
      version: 1, kind: 'settlement', task: 't', seat: { provider: 'codex', title: 'x' },
      timeline: { nativeHandle: null, sessionId: null, via: 'unchecked', export: null, gap: 'none' },
      recordedBy: 'lead', at: 'not-a-date',
    }],
    ['settlement export bad sha', {
      version: 1, kind: 'settlement', task: 't', seat: { provider: 'codex', title: 'x' },
      timeline: { nativeHandle: null, sessionId: null, via: 'unchecked', export: { path: 'o.txt', sha256: 'zz', bytes: 1 }, gap: null },
      recordedBy: 'lead', at: '2026-01-01T00:00:00Z',
    }],
  ];
}

/** The port's evidence seam, implemented with the same realpath+resolve+
 *  bounds-check+read steps the JS validator performs inline. */
function realEvidence(repositoryRoot, outputRef) {
  try {
    const repoPath = realpathSync(repositoryRoot);
    const outputPath = realpathSync(resolve(repoPath, outputRef));
    const relativePath = relative(repoPath, outputPath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return { status: 'outside' };
    }
    return { status: 'ok', bytes: readFileSync(outputPath) };
  } catch {
    return { status: 'unreadable' };
  }
}

test('parity: identical verdicts/errors/warnings across the corpus', t => {
  const repo = fixtureRepo(t);
  writeFileSync(join(repo, 'evidence.txt'), EVIDENCE);
  let checked = 0;
  for (const [name, record] of corpus(t, repo)) {
    const js = validateRecord(record);
    const ts = validateReportRecordV1(record, { realpath: realpathSync, readEvidence: realEvidence });
    assert.equal(ts.valid, js.valid, `${name}: valid`);
    assert.deepEqual(ts.errors, js.errors, `${name}: errors`);
    assert.deepEqual(ts.warnings, js.warnings, `${name}: warnings`);
    checked++;
  }
  assert.ok(checked >= 45, `corpus coverage — ${checked} cases`);
});

test('parity: verifier --repo override resolves outputRef identically', t => {
  const declared = fixtureRepo(t); // record-declared candidate root (empty)
  const verifier = fixtureRepo(t); // the verifier's checkout with evidence
  writeFileSync(join(verifier, 'evidence.txt'), EVIDENCE);
  for (const [name, record] of [
    ['readable under --repo', { ...baseHandback(declared), checks: [check({ output: undefined, outputRef: 'evidence.txt', sha: EVIDENCE_SHA })] }],
    ['mismatch --repo', { ...baseHandback(declared), checks: [check({ output: undefined, outputRef: 'missing.txt', sha: FAKE_SHA })] }],
  ]) {
    const js = validateRecord(record, { repo: verifier });
    const ts = validateReportRecordV1(record, { repo: verifier, realpath: realpathSync, readEvidence: realEvidence });
    assert.equal(ts.valid, js.valid, `${name}: valid`);
    assert.deepEqual(ts.errors, js.errors, `${name}: errors`);
    assert.deepEqual(ts.warnings, js.warnings, `${name}: warnings`);
  }
});

test('parity: production call shape (no seams) never reads the filesystem', t => {
  const repo = fixtureRepo(t);
  writeFileSync(join(repo, 'evidence.txt'), EVIDENCE);
  // The desk calls with no seams — outputRef evidence reports unreadable
  // rather than dereferencing a seat-claimed path.
  const record = { ...baseHandback(repo), checks: [check({ output: undefined, outputRef: 'evidence.txt', sha: EVIDENCE_SHA })] };
  const ts = validateReportRecordV1(record);
  assert.equal(ts.valid, true);
  assert.equal(ts.warnings.length, 1);
  assert.equal(ts.warnings[0].code, 'check-evidence-missing');
  assert.match(ts.warnings[0].message, /could not be read/);
});
