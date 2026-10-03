import { validateReportRecordV1 } from './report-records.ts';
import { isAbsolute } from 'node:path';

type Row = Record<string, unknown>;

const isObject = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const rows = (value: unknown): Row[] | null => Array.isArray(value) && value.every(isObject) ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(nonBlank) : [];
const has = (value: Row, key: string) => Object.hasOwn(value, key);

function sourceRows(input: Row, key: string, missingCode: string, requiredFields: string[], gaps: string[], nullableFields: string[] = []): Row[] {
  if (!has(input, key)) { gaps.push(missingCode); return []; }
  const value = rows(input[key]);
  if (!value) { gaps.push(`${key}-source-invalid`); return []; }
  value.forEach((item, index) => {
    if (!nonBlank(item.sourceRef)) gaps.push(`${key}-source-ref-missing:${index}`);
    const missing = requiredFields.filter(field => !nonBlank(item[field]));
    for (const field of nullableFields) {
      if (!has(item, field) || (item[field] !== null && !nonBlank(item[field]))) missing.push(field);
    }
    if (missing.length) gaps.push(`${key}-row-invalid:${index}:${missing.join(',')}`);
  });
  return value;
}

function candidateMeasurement(value: unknown, gaps: string[]): Row | null {
  if (!isObject(value)) { gaps.push('candidate-measurement-missing'); return null; }
  const repository = value.repository ?? value.root;
  const head = value.head;
  const snapshotSha256 = value.snapshotSha256 ?? value.sha256;
  const incompleteFields = [value.incomplete, value.nestedIncomplete].filter(entry => entry !== undefined);
  const incompleteInvalid = incompleteFields.some(entry => !Array.isArray(entry) || entry.some(item => !nonBlank(item)));
  const incomplete = [...strings(value.incomplete), ...strings(value.nestedIncomplete)];
  if (!nonBlank(repository) || !isAbsolute(repository) || incompleteInvalid || (!nonBlank(head) && !nonBlank(snapshotSha256))
    || (nonBlank(head) && !/^[0-9a-f]{40,64}$/u.test(head))
    || (nonBlank(snapshotSha256) && !/^[0-9a-f]{64}$/u.test(snapshotSha256))) {
    gaps.push('candidate-measurement-invalid');
    return null;
  }
  if (incomplete.length) gaps.push('candidate-measurement-incomplete');
  return {
    repository,
    head: nonBlank(head) ? head : null,
    snapshotSha256: nonBlank(snapshotSha256) ? snapshotSha256 : null,
    incomplete,
  };
}

function candidatePin(candidate: unknown): { repository: string; pinKind: 'head' | 'snapshotSha256'; pin: string } | null {
  if (!isObject(candidate) || !nonBlank(candidate.repository)) return null;
  if (nonBlank(candidate.head) && /^[0-9a-f]{40,64}$/u.test(candidate.head)) return { repository: candidate.repository, pinKind: 'head', pin: candidate.head };
  if (nonBlank(candidate.snapshotSha256) && /^[0-9a-f]{64}$/u.test(candidate.snapshotSha256)) return { repository: candidate.repository, pinKind: 'snapshotSha256', pin: candidate.snapshotSha256 };
  return null;
}

/**
 * Projects explicitly supplied artifacts into a transfer recap. It reads no
 * files or host state; every sourceRef remains an unverified pointer.
 */
export function buildHandoffRecap(recapInputs: unknown, measuredCandidate: unknown) {
  const input = isObject(recapInputs) ? recapInputs : {};
  const gaps: string[] = [];
  const warnings: string[] = [];

  let assignment: Row | null = null;
  if (!isObject(input.assignment)) gaps.push('assignment-source-missing');
  else {
    assignment = input.assignment;
    if (!nonBlank(assignment.sourceRef) || !Array.isArray(assignment.authority) || !assignment.authority.length
      || !nonBlank(assignment.id) || !nonBlank(assignment.revision)) gaps.push('assignment-source-missing');
    if (Array.isArray(assignment.authority)) assignment.authority.forEach((row, index) => {
      if (!isObject(row) || !nonBlank(row.claim) || !nonBlank(row.sourceRef)) gaps.push(`assignment-authority-source-invalid:${index}`);
    });
  }

  const decisions = sourceRows(input, 'decisions', 'decisions-source-missing', ['proposition', 'ruling', 'reason'], gaps);
  const assumptions = sourceRows(input, 'assumptions', 'assumptions-source-missing', ['statement'], gaps);
  const unresolved = sourceRows(input, 'unresolved', 'unresolved-source-missing', ['proposition', 'reason'], gaps, ['ownerId']);
  const owners = sourceRows(input, 'ownerPins', 'owner-pins-source-missing', ['surface', 'state', 'basis'], gaps, ['ownerId']);
  const dependencies = sourceRows(input, 'dependencies', 'dependencies-source-missing', ['need', 'state'], gaps, ['ownerId']);
  const resources = sourceRows(input, 'resources', 'resources-source-missing', ['kind', 'id', 'state'], gaps, ['ownerId']);
  let nextAction: Row | null = null;
  if (!has(input, 'nextAction')) gaps.push('next-action-source-missing');
  else if (!isObject(input.nextAction) || !['ready', 'blocked', 'none'].includes(String(input.nextAction.state))
    || (input.nextAction.state === 'none' ? input.nextAction.action !== null : !nonBlank(input.nextAction.action))
    || (has(input.nextAction, 'ownerId') && input.nextAction.ownerId !== null && !nonBlank(input.nextAction.ownerId))) gaps.push('next-action-source-invalid');
  else nextAction = input.nextAction;

  const measured = candidateMeasurement(measuredCandidate, gaps);
  const claims: Row[] = [];
  const findings: Row[] = [];
  if (!has(input, 'reportArtifacts')) gaps.push('report-artifacts-source-missing');
  else if (!Array.isArray(input.reportArtifacts)) gaps.push('report-artifacts-source-invalid');
  else input.reportArtifacts.forEach((artifact, index) => {
    const sourceRef = isObject(artifact) && nonBlank(artifact.sourceRef) ? artifact.sourceRef : `unreferenced-artifact-${index}`;
    if (!isObject(artifact) || !isObject(artifact.record) || artifact.record.kind !== 'handback') {
      gaps.push(`report-artifact-invalid:${sourceRef}`);
      return;
    }
    const record = artifact.record;
    const validation = validateReportRecordV1(record);
    if (!validation.valid) {
      gaps.push(`report-artifact-invalid:${sourceRef}`);
      return;
    }
    if (validation.warnings.some(warning => warning.code === 'candidate-incomplete')) gaps.push(`candidate-claim-incomplete:${sourceRef}`);
    if (validation.warnings.some(warning => warning.code === 'check-evidence-missing')) gaps.push(`check-evidence-incomplete:${sourceRef}`);
    if (!nonBlank(artifact.sourceRef)) gaps.push(`report-artifact-source-ref-missing:${index}`);
    const report = isObject(record.report) ? record.report : null;
    if (!report) gaps.push(`report-artifact-report-missing:${sourceRef}`);
    const reportedAssignment = report && isObject(report.assignment) ? report.assignment : null;
    if (assignment && reportedAssignment && nonBlank(assignment.id) && nonBlank(assignment.revision)
      && (reportedAssignment.id !== assignment.id || reportedAssignment.revision !== assignment.revision
        || (nonBlank(assignment.scopeRevision) && reportedAssignment.scopeRevision !== assignment.scopeRevision))) {
      gaps.push(`report-assignment-stale:${sourceRef}`);
    }
    if (!candidatePin(record.candidate)) gaps.push(`candidate-claim-missing:${sourceRef}`);
    const rowsFound = report && Array.isArray(report.findings) ? report.findings.filter(isObject) : [];
    for (const finding of rowsFound) findings.push({ sourceRef, ...finding });
    claims.push({
      sourceRef,
      candidate: record.candidate ?? null,
      checks: Array.isArray(record.checks) ? record.checks : [],
      findings: rowsFound,
      reportedOnly: true,
    });
  });

  const candidatePins = claims.map(claim => candidatePin(claim.candidate)).filter((pin): pin is NonNullable<ReturnType<typeof candidatePin>> => pin !== null);
  let comparison: 'matched-pin' | 'mismatch' | 'no-claim' | 'unavailable' = 'unavailable';
  if (!measured) comparison = 'unavailable';
  else if (!candidatePins.length) comparison = 'no-claim';
  else if (candidatePins.length !== claims.length || gaps.some(gap => gap.startsWith('report-artifact-invalid:'))) comparison = 'unavailable';
  else {
    const matches = candidatePins.every(pin => pin.repository === measured.repository
      && (pin.pinKind === 'head' ? pin.pin === measured.head : pin.pin === measured.snapshotSha256));
    comparison = matches ? 'matched-pin' : 'mismatch';
    if (!matches) claims.forEach(claim => {
      const pin = candidatePin(claim.candidate);
      if (pin && (pin.repository !== measured.repository
        || (pin.pinKind === 'head' ? pin.pin !== measured.head : pin.pin !== measured.snapshotSha256))) {
        gaps.push(`candidate-claim-mismatch:${claim.sourceRef}`);
      }
    });
  }

  gaps.sort();
  warnings.push('Source references are carried as supplied and were not independently resolved.');
  warnings.push('Owner pins are carried as source claims; this recap does not refresh host ownership state.');
  warnings.push('Candidate/check values and report findings are self-reported claims; this recap does not attest command execution.');
  warnings.push('Settlement remains unverified and receiving-owner acknowledgment has not been observed.');
  if (gaps.length) warnings.push('Structured handoff context is incomplete; consult gaps before transfer.');

  return {
    contextStatus: gaps.length ? 'partial' : 'complete',
    assignment,
    decisions,
    assumptions,
    unresolved,
    owners,
    dependencies,
    candidate: {
      measurement: measured,
      claims,
      comparison,
      incomplete: measured?.incomplete ?? [],
    },
    findings,
    nextAction,
    resources,
    transfer: { settlement: 'unverified', recipientAcknowledgment: 'not-observed' },
    gaps: [...new Set(gaps)],
    warnings,
  };
}
