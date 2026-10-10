// Integrity layer: sealing the frozen report and the byte-identified review
// history that gates PASS, retries and dependency rows.
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, identity, json, readJson, snapshot } from '../plugin/server/runtime/cli/package.ts';
import { harnessIdentity, loadAttempt, nonempty, now, requireValue, reviewIntegrityVersion } from './runs.mjs';
import { evidenceIndex, missingEvidence } from './ledger.mjs';

export function seal(attempt, { gaps = [] } = {}) {
  const loaded = loadAttempt(attempt);
  requireValue(!existsSync(join(loaded.attempt, 'report.json')), 'Attempt sealed');
  const evidence = evidenceIndex(loaded.attempt);
  requireValue(evidence.length > 0, 'No collected evidence; collect actual receipts before sealing');
  const missing = missingEvidence(loaded, evidence);
  requireValue(Array.isArray(gaps) && gaps.every(gap => nonempty(gap?.kind) && nonempty(gap?.reason)), 'Evidence gaps require kind and concrete reason');
  requireValue(new Set(gaps.map(gap => gap.kind)).size === gaps.length, 'Duplicate evidence gap');
  requireValue(gaps.every(gap => missing.includes(gap.kind)), 'Evidence gaps must name missing required evidence');
  const undeclared = missing.filter(kind => !gaps.some(gap => gap.kind === kind));
  requireValue(undeclared.length === 0, `Missing required evidence: ${undeclared.join(', ')}; collect it before sealing, or declare unavailable proof with explicit gaps`);
  const report = {
    version: 1, scenarioId: loaded.scenario.id, sealedAt: now(),
    attemptSha256: hash(readFileSync(join(loaded.attempt, 'attempt.json'))),
    manifestSha256: loaded.run.manifestSha256,
    packageSha256: loaded.frozen.candidate.sha256, harnessSha256: loaded.frozen.harness.sha256,
    sourceUnchanged: identity(loaded.run.sourceRoot).sha256 === loaded.frozen.candidate.sha256
      && harnessIdentity(loaded.run.sourceRoot).sha256 === loaded.frozen.harness.sha256,
    evidence, evidenceGaps: gaps,
    taskSnapshot: existsSync(join(loaded.attempt, 'workspace')) ? snapshot(join(loaded.attempt, 'workspace')) : null,
    review: 'NOT_RUN',
  };
  const reportBytes = Buffer.from(json(report));
  writeFileSync(join(loaded.attempt, 'report.json'), reportBytes, { flag: 'wx' });
  // Keep the seal outside the report so report edits cannot be mistaken for a
  // new frozen candidate during a later review or summary.
  writeFileSync(join(loaded.attempt, 'report.sha256'), `${hash(reportBytes)}\n`, { flag: 'wx' });
  return { report: join(loaded.attempt, 'report.json'), reportSha256: hash(reportBytes) };
}
export function verifiedReport(attempt) {
  const loaded = loadAttempt(attempt);
  const reportPath = join(loaded.attempt, 'report.json');
  requireValue(existsSync(reportPath), 'Attempt not sealed');
  const bytes = readFileSync(reportPath);
  const report = JSON.parse(bytes);
  requireValue(readFileSync(join(loaded.attempt, 'report.sha256'), 'utf8').trim() === hash(bytes), 'Sealed report changed');
  requireValue(report.scenarioId === loaded.scenario.id, 'Report scenario mismatch');
  requireValue(report.attemptSha256 === hash(readFileSync(join(loaded.attempt, 'attempt.json'))), 'Attempt configuration changed after sealing');
  requireValue(report.manifestSha256 === loaded.run.manifestSha256 && report.packageSha256 === loaded.frozen.candidate.sha256 && report.harnessSha256 === loaded.frozen.harness.sha256, 'Report identity mismatch');
  requireValue(json(report.evidence) === json(evidenceIndex(loaded.attempt)), 'Sealed evidence changed');
  return { ...loaded, report, reportSha256: hash(bytes) };
}
function validateReview(attempt, input, loaded = verifiedReport(attempt)) {
  const participantIds = input.participantIds;
  requireValue(Array.isArray(participantIds) && participantIds.every(nonempty) && participantIds.length > 0, 'Host actor participantIds required (include all scenario actors)');
  requireValue(nonempty(input.reviewerId) && input.reviewerId !== loaded.data.config.operatorId && !participantIds.includes(input.reviewerId), 'Reviewer must be independent of operator and actors');
  requireValue(input.reportSha256 === loaded.reportSha256, 'Review must reference frozen report hash');
  requireValue(nonempty(input.independenceEvidence), 'Reviewer host session/neutral brief evidence required');
  requireValue(json(Object.keys(input.criteria ?? {}).sort()) === json([...loaded.frozen.criteria].sort()), 'Review exactly U1–U7');
  const paths = new Set(loaded.report.evidence.map(item => item.path));
  const kindOfPath = new Map(loaded.report.evidence.map(item => [item.path, item.kind]));
  // A criterion cannot be asked for evidence the seal already recorded as unavailable.
  const declaredGaps = new Set((loaded.report.evidenceGaps ?? []).map(gap => gap.kind));
  const check = (item, label, supportKinds) => {
    const support = (supportKinds ?? []).filter(kind => !declaredGaps.has(kind));
    requireValue(item && ['PASS', 'FAIL', 'BLOCKED'].includes(item.status) && nonempty(item.reason), `${label}: status/reason required`);
    requireValue(Array.isArray(item.evidence) && item.evidence.every(path => paths.has(path)), `${label}: invalid evidence reference`);
    requireValue(item.status === 'BLOCKED' || item.evidence.length > 0, `${label}: observed verdict needs evidence`);
    if (support?.length && item.status !== 'BLOCKED') {
      requireValue(item.evidence.some(path => support.includes(kindOfPath.get(path))),
        `${label}: observed verdict needs ${support.join(' or ')} evidence`);
    }
  };
  for (const criterion of loaded.frozen.criteria) check(input.criteria?.[criterion], criterion, loaded.frozen.criterionEvidence?.[criterion]);
  requireValue(Array.isArray(input.assertions) && input.assertions.length === loaded.scenario.assertions.length, 'Review every scenario assertion in manifest order');
  input.assertions.forEach((item, i) => check(item, `Assertion ${i + 1}`));
  const checks = [...Object.values(input.criteria), ...input.assertions];
  let status = checks.some(item => item.status === 'FAIL') ? 'FAIL' : checks.some(item => item.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  if (status === 'PASS') {
    requireValue(loaded.report.sourceUnchanged, 'PASS requires unchanged package and harness during the attempt');
    requireValue(!loaded.report.evidenceGaps?.length, 'PASS forbidden with declared evidence gaps');
    requireValue(missingEvidence(loaded, loaded.report.evidence).length === 0, 'PASS requires nonempty payloads for all required evidence kinds');
    for (const kind of loaded.frozen.evidenceKinds) requireValue(loaded.report.evidence.some(item => item.kind === kind), `PASS missing ${kind} evidence`);
  }
  return { ...input, status };
}
export function review(attempt, input) {
  requireValue(!reviewHistory(attempt), 'EEXIST: Review already recorded; use an addendum');
  return writeReviewRecord(attempt, 'review.json', validateReview(attempt, input));
}
export function reviewAddendum(attempt, input) {
  const history = reviewHistory(attempt);
  requireValue(history, 'Review addendum requires an original review');
  requireValue(input.supersedesReviewSha256 === history.originalSha256, 'Addendum must bind the original review hash');
  requireValue(nonempty(input.basis), 'Review addendum basis required');
  requireValue(input.reviewerId === history.original.reviewerId, 'Review addendum must keep the original reviewer');
  const sequence = history.nextAddendum;
  const name = `review-addendum-${String(sequence).padStart(3, '0')}.json`;
  const result = writeReviewRecord(attempt, name, { ...validateReview(attempt, input), addendumSequence: sequence });
  const path = join(realpathSync(attempt), name);
  return { ...result, path };
}

// Review records own their byte identity separately from the report they assess.
// Write the digest first: interruption leaves an explicit incomplete record, never
// an unsigned assessment that a legacy run could silently treat as historical.
function writeReviewRecord(attempt, name, input) {
  const path = join(attempt, name);
  requireValue(!existsSync(path), `EEXIST: Review already recorded: ${name}`);
  const result = { ...input, reviewedAt: now(), reviewIntegrityVersion };
  const bytes = Buffer.from(json(result));
  writeFileSync(path.replace(/\.json$/, '.sha256'), `${hash(bytes)}\n`, { flag: 'wx' });
  writeFileSync(path, bytes, { flag: 'wx' });
  return result;
}

// Every consumer uses the same history: byte identity, assessment validity,
// original-review links, and whether the entire history can support a new gate.
export function reviewHistory(attempt) {
  const names = readdirSync(attempt);
  const canonical = sequence => `review-addendum-${String(sequence).padStart(3, '0')}.json`;
  const addenda = [...new Set(names.filter(name => /^review-addendum-\d+\.(json|sha256)$/.test(name))
    .map(name => name.replace(/\.sha256$/, '.json')))];
  // Only canonical positions count as history; an ambiguous alias like
  // review-addendum-1 must fail closed instead of inheriting a slot.
  for (const name of addenda) {
    requireValue(name === canonical(Number(name.match(/(\d+)/)[1])), `Noncanonical review addendum name: ${name}`);
  }
  addenda.sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  addenda.forEach((name, index) => requireValue(name === canonical(index + 1),
    `Review addendum history is not contiguous at ${name}`));
  requireValue(!addenda.length || names.includes('review.json'), 'Review addendum requires an original review');
  if (!names.includes('review.json') && !names.includes('review.sha256')) return null;
  const loaded = verifiedReport(attempt);
  const read = name => {
    const path = join(attempt, name), digestPath = path.replace(/\.json$/, '.sha256');
    requireValue(existsSync(path), `Review record missing: ${name}; identity receipt retained`);
    const bytes = readFileSync(path), sha256 = hash(bytes);
    const hasDigest = existsSync(digestPath);
    if (hasDigest) requireValue(readFileSync(digestPath, 'utf8').trim() === sha256, `Review record changed: ${name}`);
    const value = JSON.parse(bytes);
    requireValue(value.reviewIntegrityVersion === undefined || value.reviewIntegrityVersion === reviewIntegrityVersion,
      `Unsupported review integrity version: ${name}`);
    const protectedRecord = loaded.frozen.reviewIntegrityVersion === reviewIntegrityVersion
      || value.reviewIntegrityVersion === reviewIntegrityVersion;
    requireValue(!protectedRecord || hasDigest, `Review identity missing: ${name}`);
    const validated = validateReview(attempt, value, loaded);
    requireValue(value.status === validated.status, `Review status inconsistent with criteria/assertions: ${name}`);
    return { value: validated, sha256, verified: protectedRecord && hasDigest };
  };
  const original = read('review.json');
  let latest = original.value, verified = original.verified;
  for (const [index, name] of addenda.entries()) {
    const record = read(name), value = record.value;
    requireValue(value.supersedesReviewSha256 === original.sha256, `Review addendum binding changed: ${name}`);
    requireValue(nonempty(value.basis), `Review addendum basis missing: ${name}`);
    requireValue(value.reviewerId === original.value.reviewerId, `Review addendum reviewer changed: ${name}`);
    // Position is part of the record's protected bytes: renaming a signed
    // addendum is a change, while a record that predates position binding just
    // stops being evidence of ordering.
    if (value.addendumSequence === undefined) record.verified = false;
    else requireValue(value.addendumSequence === index + 1, `Review addendum sequence changed: ${name}`);
    latest = value;
    verified = verified && record.verified;
  }
  return { original: original.value, originalSha256: original.sha256, latest,
    integrity: verified ? 'VERIFIED' : 'UNVERIFIED_LEGACY',
    nextAddendum: addenda.length + 1 };
}
