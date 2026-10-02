// Independent review integrity: verdict validation, byte-identified records,
// addendum history, legacy-run handling and criterion support kinds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { begin, collect, review, reviewAddendum, summary } from '../e2e/collector.mjs';
import { evidenceKinds } from '../e2e/evidence.mjs';
import { criterionEvidence } from '../e2e/criteria.mjs';
import { hash } from '../plugin/server/runtime/cli/package.ts';
import { config, setup, fakeReview } from './helpers.mjs';

test('review requires independent identity, all criteria, assertions and real evidence references', t => {
  const data = setup(t), input = fakeReview(data);
  assert.throws(() => review(data.attempt, { ...input, reviewerId: config.operatorId }), /independent/);
  assert.throws(() => review(data.attempt, { ...input, reviewerId: 'test-actor' }), /independent/);
  assert.throws(() => review(data.attempt, { ...input, reportSha256: 'wrong' }), /frozen report hash/);
  assert.throws(() => review(data.attempt, { ...input, criteria: {} }), /exactly/);
  assert.throws(() => review(data.attempt, { ...input, assertions: [] }), /every scenario assertion/);
  const bad = structuredClone(input);
  bad.criteria.U2.evidence = ['../../invented'];
  assert.throws(() => review(data.attempt, bad), /invalid evidence reference/);
  review(data.attempt, input);
  assert.equal(summary(data.run).counts.PASS, 1);
  assert.notEqual(summary(data.run).status, 'PASS');
  assert.throws(() => review(data.attempt, input), /EEXIST/);
});
test('sealing prevents additions; changed evidence and configuration invalidate reviews', t => {
  const data = setup(t), input = fakeReview(data);
  assert.throws(() => collect(data.attempt, 'checks', join(data.dir, 'checks.txt')), /sealed/);
  review(data.attempt, input);
  const path = join(data.attempt, input.criteria.U1.evidence[0]);
  const original = readFileSync(path);
  writeFileSync(path, original.toString().replace('preflight', 'launch'));
  assert.throws(() => summary(data.run), /Sealed evidence changed/);
  writeFileSync(path, original);
  writeFileSync(join(data.attempt, 'attempt.json'), '{}');
  assert.throws(() => summary(data.run));
});
test('editing a stored review status cannot turn a failed criterion into PASS', t => {
  const data = setup(t), input = fakeReview(data, 'FAIL');
  const result = review(data.attempt, input);
  writeFileSync(join(data.attempt, 'review.json'), JSON.stringify({ ...result, status: 'PASS' }));
  assert.throws(() => summary(data.run), /Review record changed/);
});
test('review identity detects narrative, evidence, identity and synchronized verdict changes at every consumer', t => {
  const data = setup(t), input = fakeReview(data);
  input.criteria.U1.status = 'FAIL';
  review(data.attempt, input);
  const path = join(data.attempt, 'review.json'), bytes = readFileSync(path);
  const correction = { ...input, supersedesReviewSha256: hash(bytes), basis: 'Synthetic correction' };
  const changes = [
    value => { value.criteria.U6.reason = 'Rewritten after review'; },
    value => { value.criteria.U6.evidence = [input.criteria.U6.evidence[evidenceKinds.indexOf('coordinator')]]; },
    value => { value.reviewerId = 'another-independent-reviewer'; },
    value => { value.criteria.U1.status = 'PASS'; value.status = 'PASS'; },
  ];
  for (const change of changes) {
    const value = JSON.parse(bytes);
    change(value);
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => summary(data.run), /Review record changed/);
    assert.throws(() => reviewAddendum(data.attempt, correction), /Review record changed/);
    assert.throws(() => begin(data.run, data.id, config), /Review record changed/);
    writeFileSync(path, bytes);
  }
  const row = summary(data.run).scenarios.find(row => row.id === data.id);
  assert.equal(row.status, 'FAIL');
  assert.equal(row.attempts[0].reviewIntegrity, 'VERIFIED');
});
test('all addenda retain byte identity, including earlier assessments superseded by a later one', t => {
  const data = setup(t), input = fakeReview(data);
  review(data.attempt, input);
  const originalBytes = readFileSync(join(data.attempt, 'review.json'));
  const correction = { ...input, supersedesReviewSha256: hash(originalBytes), basis: 'Synthetic clarification' };
  const first = reviewAddendum(data.attempt, correction);
  const second = reviewAddendum(data.attempt, correction);
  for (const { path } of [first, second]) {
    const bytes = readFileSync(path), value = JSON.parse(bytes);
    value.basis = 'Changed after recording';
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => summary(data.run), /Review record changed/);
    assert.throws(() => reviewAddendum(data.attempt, correction), /Review record changed/);
    writeFileSync(path, bytes);
  }
  assert.equal(summary(data.run).scenarios.find(row => row.id === data.id).gateReady, true);
  assert.deepEqual(readFileSync(join(data.attempt, 'review.json')), originalBytes);
});
test('missing review identity and partial records fail closed instead of becoming legacy history', t => {
  const data = setup(t), input = fakeReview(data);
  review(data.attempt, input);
  const original = join(data.attempt, 'review.json');
  const addendum = reviewAddendum(data.attempt, { ...input,
    supersedesReviewSha256: hash(readFileSync(original)), basis: 'Synthetic clarification' });
  for (const path of [original, addendum.path]) {
    const digestPath = path.replace(/\.json$/, '.sha256'), digest = readFileSync(digestPath);
    rmSync(digestPath);
    assert.throws(() => summary(data.run), /Review identity missing/);
    writeFileSync(digestPath, digest);
  }
  const originalBytes = readFileSync(original), originalDigest = readFileSync(join(data.attempt, 'review.sha256'));
  const unmarked = JSON.parse(originalBytes);
  delete unmarked.reviewIntegrityVersion;
  writeFileSync(original, JSON.stringify(unmarked));
  rmSync(join(data.attempt, 'review.sha256'));
  assert.throws(() => summary(data.run), /Review identity missing/, 'New manifest prevents downgrade even if the record marker is removed');
  writeFileSync(original, originalBytes);
  writeFileSync(join(data.attempt, 'review.sha256'), originalDigest);
  const bytes = readFileSync(addendum.path);
  rmSync(addendum.path);
  assert.throws(() => summary(data.run), /Review record missing/);
  writeFileSync(addendum.path, bytes);

  const interrupted = setup(t), pending = fakeReview(interrupted);
  const digestPath = join(interrupted.attempt, 'review.sha256');
  writeFileSync(digestPath, '0'.repeat(64) + '\n');
  assert.throws(() => summary(interrupted.run), /Review record missing/);
  assert.throws(() => review(interrupted.attempt, pending), /Review record missing/);
  assert.throws(() => begin(interrupted.run, interrupted.id, config), /Review record missing/);
  assert.equal(existsSync(join(interrupted.attempt, 'review.json')), false);
});
test('legitimate addendum can correct FAIL to PASS while preserving the original verified assessment', t => {
  const data = setup(t), input = fakeReview(data);
  const failed = structuredClone(input);
  failed.criteria.U1.status = 'FAIL';
  review(data.attempt, failed);
  const path = join(data.attempt, 'review.json'), originalBytes = readFileSync(path);
  reviewAddendum(data.attempt, { ...input, supersedesReviewSha256: hash(originalBytes), basis: 'Independent factual correction against frozen evidence' });
  const row = summary(data.run).scenarios.find(row => row.id === data.id);
  assert.equal(row.status, 'PASS');
  assert.equal(row.verifiedPassCount, 1);
  assert.equal(row.gateReady, true);
  assert.deepEqual(readFileSync(path), originalBytes);
  assert.equal(JSON.parse(originalBytes).status, 'FAIL');
});
test('legacy judgments remain readable without being resealed or opening dependency and retry gates', t => {
  const data = setup(t, 'basic-codex', manifest => {
    delete manifest.reviewIntegrityVersion;
    manifest.scenarios.find(row => row.id === 'direct-codex').dependsOn = ['basic-codex'];
  });
  const input = fakeReview(data);
  const path = join(data.attempt, 'review.json');
  // The format emitted by the pre-integrity collector, not a current review call.
  const bytes = Buffer.from(JSON.stringify({ ...input, status: 'PASS', reviewedAt: '2026-01-01T00:00:00Z' }));
  writeFileSync(path, bytes);
  const row = () => summary(data.run).scenarios.find(row => row.id === data.id);
  assert.equal(row().status, 'PASS');
  assert.equal(row().passCount, 1);
  assert.equal(row().verifiedPassCount, 0);
  assert.equal(row().gateReady, false);
  assert.equal(row().attempts[0].reviewIntegrity, 'UNVERIFIED_LEGACY');
  assert.match(row().attempts[0].reason, /Historical review/);
  assert.throws(() => begin(data.run, 'direct-codex', config), /Unmet scenario gate.*verified review integrity/);
  assert.equal(existsSync(join(data.run, 'direct-codex')), false);
  assert.throws(() => begin(data.run, data.id, config), /Unverified review integrity/);
  assert.equal(existsSync(join(data.run, data.id, 'attempt-002')), false);
  assert.throws(() => review(data.attempt, input), /EEXIST/);
  assert.equal(existsSync(join(data.attempt, 'review.sha256')), false);
  // A newly protected addendum binds today's bytes but cannot retroactively prove
  // the identity of the original historical assessment.
  const addendum = reviewAddendum(data.attempt, { ...input, supersedesReviewSha256: hash(bytes), basis: 'Clarify historical judgment without asserting original integrity' });
  assert.equal(row().attempts[0].reviewIntegrity, 'UNVERIFIED_LEGACY');
  assert.equal(row().gateReady, false);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(existsSync(join(data.attempt, 'review.sha256')), false);
  rmSync(addendum.path.replace(/\.json$/, '.sha256'));
  assert.throws(() => summary(data.run), /Review identity missing/);
});
test('adding a checksum to a legacy judgment does not retroactively verify its recorded identity', t => {
  const data = setup(t, 'basic-codex', manifest => { delete manifest.reviewIntegrityVersion; });
  const input = fakeReview(data), bytes = Buffer.from(JSON.stringify({ ...input, status: 'PASS' }));
  writeFileSync(join(data.attempt, 'review.json'), bytes);
  writeFileSync(join(data.attempt, 'review.sha256'), hash(bytes) + '\n');
  const row = summary(data.run).scenarios.find(row => row.id === data.id);
  assert.equal(row.attempts[0].reviewIntegrity, 'UNVERIFIED_LEGACY');
  assert.equal(row.gateReady, false);
});
test('new assessments in a legacy run receive identity protection from the time they are recorded', t => {
  const data = setup(t, 'basic-codex', manifest => { delete manifest.reviewIntegrityVersion; });
  review(data.attempt, fakeReview(data));
  const row = summary(data.run).scenarios.find(row => row.id === data.id);
  assert.equal(row.attempts[0].reviewIntegrity, 'VERIFIED');
  assert.equal(row.gateReady, true);
  rmSync(join(data.attempt, 'review.sha256'));
  assert.throws(() => summary(data.run), /Review identity missing/);
});
test('review addenda supersede the original assessment without rewriting it', t => {
  const data = setup(t), input = fakeReview(data);
  const original = review(data.attempt, input);
  const originalBytes = readFileSync(join(data.attempt, 'review.json'));
  const corrected = structuredClone(input);
  corrected.criteria.U6.status = 'FAIL';
  corrected.criteria.U6.reason = 'Material limitation omitted from the final handback';
  corrected.assertions[1].status = 'FAIL';
  corrected.assertions[1].reason = 'Faithful handback assertion failed';
  const addendum = reviewAddendum(data.attempt, {
    ...corrected,
    supersedesReviewSha256: hash(originalBytes),
    basis: 'Independent correction against the same frozen report',
  });
  assert.equal(addendum.status, 'FAIL');
  assert.equal(JSON.parse(readFileSync(join(data.attempt, 'review.json'))).status, original.status);
  assert.equal(summary(data.run).scenarios.find(row => row.id === data.id).status, 'FAIL');
});
test('reordering digested addenda cannot change the verdict or open a dependency gate', t => {
  const data = setup(t, 'basic-codex', manifest => {
    manifest.scenarios.find(row => row.id === 'direct-codex').dependsOn = ['basic-codex'];
  });
  const input = fakeReview(data);
  const failed = structuredClone(input);
  failed.criteria.U1.status = 'FAIL';
  review(data.attempt, failed);
  const original = hash(readFileSync(join(data.attempt, 'review.json')));
  reviewAddendum(data.attempt, { ...input, supersedesReviewSha256: original, basis: 'First correction restores PASS' });
  const again = structuredClone(input);
  again.criteria.U1.status = 'FAIL';
  reviewAddendum(data.attempt, { ...again, supersedesReviewSha256: original, basis: 'Second correction finds FAIL again' });
  const row = () => summary(data.run).scenarios.find(item => item.id === data.id);
  assert.equal(row().status, 'FAIL');
  assert.equal(row().gateReady, false);
  // Swap complete record+digest pairs: every digest still matches its bytes, so
  // only the sequence inside the record can catch the reordering.
  const first = join(data.attempt, 'review-addendum-001'), second = join(data.attempt, 'review-addendum-002');
  const swap = () => {
    for (const ext of ['.json', '.sha256']) {
      renameSync(`${first}${ext}`, `${first}.tmp${ext}`);
      renameSync(`${second}${ext}`, `${first}${ext}`);
      renameSync(`${first}.tmp${ext}`, `${second}${ext}`);
    }
  };
  swap();
  assert.throws(() => summary(data.run), /sequence changed/);
  assert.throws(() => begin(data.run, 'direct-codex', config), /sequence changed/);
  swap();
  assert.equal(row().status, 'FAIL');
  assert.equal(row().attempts[0].reviewIntegrity, 'VERIFIED');
});
test('ambiguous addendum positions fail closed instead of inheriting a sequence slot', t => {
  const data = setup(t), input = fakeReview(data);
  review(data.attempt, input);
  const original = hash(readFileSync(join(data.attempt, 'review.json')));
  reviewAddendum(data.attempt, { ...input, supersedesReviewSha256: original, basis: 'First correction' });
  // The same digested record under a second numeric alias is not a new position.
  for (const ext of ['.json', '.sha256']) {
    copyFileSync(join(data.attempt, `review-addendum-001${ext}`), join(data.attempt, `review-addendum-1${ext}`));
  }
  assert.throws(() => summary(data.run), /Noncanonical review addendum name/);
  for (const ext of ['.json', '.sha256']) rmSync(join(data.attempt, `review-addendum-1${ext}`));
  const row = () => summary(data.run).scenarios.find(item => item.id === data.id);
  assert.equal(row().attempts[0].reviewIntegrity, 'VERIFIED');
  // A hole in the surviving set cannot quietly become a contiguous history.
  reviewAddendum(data.attempt, { ...input, supersedesReviewSha256: original, basis: 'Second correction' });
  rmSync(join(data.attempt, 'review-addendum-001.json'));
  rmSync(join(data.attempt, 'review-addendum-001.sha256'));
  assert.throws(() => summary(data.run), /not contiguous/);
});
test('a digested addendum without recorded position cannot keep the history verified', t => {
  const data = setup(t), input = fakeReview(data);
  review(data.attempt, input);
  const originalBytes = readFileSync(join(data.attempt, 'review.json'));
  // Format from between digest introduction and position binding: authentic
  // bytes, but nothing in them claims where the record sits in the history.
  const record = { ...input, status: 'PASS', supersedesReviewSha256: hash(originalBytes), basis: 'Recorded before position binding',
    reviewedAt: '2026-01-01T00:00:00Z', reviewIntegrityVersion: 1 };
  const bytes = Buffer.from(JSON.stringify(record));
  writeFileSync(join(data.attempt, 'review-addendum-001.json'), bytes);
  writeFileSync(join(data.attempt, 'review-addendum-001.sha256'), `${hash(bytes)}\n`);
  const row = summary(data.run).scenarios.find(item => item.id === data.id);
  assert.equal(row.status, 'PASS');
  assert.equal(row.attempts[0].reviewIntegrity, 'UNVERIFIED_LEGACY');
  assert.equal(row.gateReady, false);
});
test('an addendum whose declared position was rewritten fails closed', t => {
  const data = setup(t), input = fakeReview(data);
  review(data.attempt, input);
  const original = hash(readFileSync(join(data.attempt, 'review.json')));
  reviewAddendum(data.attempt, { ...input, supersedesReviewSha256: original, basis: 'Correction' });
  const path = join(data.attempt, 'review-addendum-001.json');
  const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(readFileSync(path)), addendumSequence: 2 }));
  writeFileSync(path, bytes);
  writeFileSync(join(data.attempt, 'review-addendum-001.sha256'), `${hash(bytes)}\n`);
  assert.throws(() => summary(data.run), /sequence changed/);
});
test('sealed report edits and orphan addenda fail closed', t => {
  const data = setup(t), input = fakeReview(data);
  review(data.attempt, input);
  const reportPath = join(data.attempt, 'report.json');
  const report = JSON.parse(readFileSync(reportPath));
  report.sourceUnchanged = !report.sourceUnchanged;
  writeFileSync(reportPath, JSON.stringify(report));
  assert.throws(() => summary(data.run), /Sealed report changed/);

  const orphan = setup(t);
  fakeReview(orphan);
  writeFileSync(join(orphan.attempt, 'review-addendum-001.json'), JSON.stringify({ basis: 'orphan' }));
  assert.throws(() => summary(orphan.run), /original review/);
});
test('a criterion is only discharged by evidence of a kind that can support it', t => {
  const data = setup(t), input = fakeReview(data);
  // fakeReview collects one receipt per kind, in evidenceKinds order.
  const all = input.criteria.U1.evidence;
  const pathFor = kind => all[evidenceKinds.indexOf(kind)];
  assert.deepEqual(criterionEvidence.U7, ['resources']);
  assert.deepEqual(criterionEvidence.U1, ['checks', 'artifacts']);

  const unrelated = structuredClone(input);
  unrelated.criteria.U7 = { status: 'PASS', reason: 'Settlement claimed from an unrelated receipt', evidence: [pathFor('checks')] };
  assert.throws(() => review(data.attempt, unrelated), /U7: observed verdict needs resources evidence/);

  const wrongWayRound = structuredClone(input);
  wrongWayRound.criteria.U1 = { status: 'FAIL', reason: 'Outcome claimed from a settlement receipt', evidence: [pathFor('resources')] };
  assert.throws(() => review(data.attempt, wrongWayRound), /U1: observed verdict needs checks or artifacts evidence/);

  // BLOCKED needs no evidence at all, so the support rule does not apply to it.
  const blocked = structuredClone(input);
  blocked.criteria.U7 = { status: 'BLOCKED', reason: 'Host settlement receipts unavailable', evidence: [] };
  assert.equal(review(data.attempt, blocked).status, 'BLOCKED');
});
