// Reporting layer: run summary, the pre-seal attempt status preview and the
// cross-run index. Read-only over the layers below; it never mutates a run.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../plugin/server/runtime/cli/package.ts';
import { loadAttempt, loadRun } from './runs.mjs';
import { evidenceStatus } from './ledger.mjs';
import { reviewHistory, verifiedReport } from './integrity.mjs';

export function summary(directory) {
  const loaded = loadRun(directory);
  // Declared at init; an absent scope means the whole manifest is in scope.
  const scope = loaded.run.scope;
  const rows = loaded.frozen.scenarios.map(scenario => {
    const parent = join(loaded.directory, scenario.id);
    const names = existsSync(parent) ? readdirSync(parent).sort() : [];
    const attempts = names.filter(name => /^attempt-\d+$/.test(name)).map(name => {
      const path = join(parent, name);
      let status = 'NOT_RUN', reason = 'Attempt needs evidence seal and independent review';
      if (existsSync(join(path, 'report.json'))) verifiedReport(path);
      const history = reviewHistory(path);
      if (history) {
        status = history.latest.status;
        reason = history.integrity === 'VERIFIED' ? 'Independent review recorded; byte identity verified'
          : 'Historical review; byte identity unverified, unavailable for new gates';
      }
      return { attempt: name, status, reason, path, reviewIntegrity: history?.integrity ?? 'NOT_REVIEWED' };
    });
    const deferredNames = names.filter(name => /^deferred-\d+\.json$/.test(name));
    const deferrals = deferredNames.map(name => readJson(join(parent, name)));
    const passCount = attempts.filter(item => item.status === 'PASS').length;
    const verifiedPassCount = attempts.filter(item => item.status === 'PASS' && item.reviewIntegrity === 'VERIFIED').length;
    // A failure remains visible for this candidate. Retries never erase it.
    let status = attempts.some(item => item.status === 'FAIL') ? 'FAIL'
      : attempts.some(item => item.status === 'NOT_RUN') ? 'NOT_RUN'
      : passCount >= scenario.repetitions ? 'PASS'
      : attempts.some(item => item.status === 'BLOCKED') || deferrals.at(-1)?.status === 'BLOCKED' ? 'BLOCKED' : 'NOT_RUN';
    return { id: scenario.id, group: scenario.group, status, repetitions: scenario.repetitions,
      inScope: !scope || scope.includes(scenario.id), passCount,
      verifiedPassCount, gateReady: status === 'PASS' && verifiedPassCount >= scenario.repetitions, attempts, deferrals };
  });
  const counts = Object.fromEntries(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].map(status => [status, rows.filter(row => row.status === status).length]));
  const status = counts.FAIL ? 'FAIL' : counts.BLOCKED ? 'BLOCKED' : counts.NOT_RUN ? 'NOT_RUN' : 'PASS';
  return { status,
    gateReady: status === 'PASS' && rows.every(row => row.gateReady),
    // The declared scope completed without implying the full suite passed.
    scopeReady: rows.filter(row => row.inScope).every(row => row.gateReady),
    scope: scope ?? loaded.frozen.scenarios.map(row => row.id),
    packageSha256: loaded.frozen.candidate.sha256, harnessSha256: loaded.frozen.harness.sha256, counts, scenarios: rows };
}
// Read-only attempt inspection: which collected records discharge their kind,
// which required kinds remain missing, and the review state once sealed. The
// pre-seal counterpart of seal()'s gate; it writes nothing.
export function attemptStatus(attempt) {
  const loaded = loadAttempt(attempt);
  const { evidence, missing } = evidenceStatus(loaded);
  const history = reviewHistory(attempt);
  const result = {
    attempt: loaded.attempt, scenarioId: loaded.scenario.id, createdAt: loaded.data.createdAt,
    sealed: existsSync(join(loaded.attempt, 'report.json')),
    evidence, missingEvidence: missing,
    review: history ? { status: history.latest.status, integrity: history.integrity, assessments: history.nextAddendum } : null,
  };
  if (!result.sealed) return { ...result, sealable: evidence.length > 0 && missing.length === 0 };
  const { report, reportSha256 } = verifiedReport(attempt);
  return { ...result, sealedAt: report.sealedAt, reportSha256,
    evidenceGaps: report.evidenceGaps, sourceUnchanged: report.sourceUnchanged };
}
// Cross-run index for regression and trend inspection: every immediate child
// holding a run.json is summarized; an unreadable run is reported, not fatal.
export function listRuns(directory) {
  directory = realpathSync(directory);
  const runs = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(directory, entry.name, 'run.json')))
    .map(entry => join(directory, entry.name));
  return { directory, runs: runs.map(path => {
    try {
      const run = readJson(join(path, 'run.json'));
      const { status, gateReady, scopeReady, counts, packageSha256, harnessSha256 } = summary(path);
      return { run: path, createdAt: run.createdAt, status, gateReady, scopeReady, counts, packageSha256, harnessSha256 };
    } catch (error) {
      return { run: path, error: error.message };
    }
  }) };
}
