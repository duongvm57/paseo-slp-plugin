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

// ---------------------------------------------------------------------------
// Task queue recap — a pure wrapper over the authorized shared projection.
// ---------------------------------------------------------------------------

/** Minimal structural envelope required to keep this builder inside the
 *  runtime install unit. The generic preserves the complete caller projection
 *  and its exact queue-count type; the outside-runtime type-contract test
 *  checks compatibility with the shared schemas. */
type TaskRecapProjection = {
  section: string;
  items: readonly { kind: string }[];
  taskCounts?: object;
  omittedBefore: number;
  omittedAfter: number;
};

type CurrentTaskRecapProjection<View extends TaskRecapProjection> = View & {
  section: 'tasks';
  taskCounts: NonNullable<View['taskCounts']>;
};

export type TaskRecapRowShape =
  | { kind: 'task'; entryId: string; state: string }
  | { kind: 'attempt'; entryId: string; state: string }
  | { kind: 'result' | 'adjudication'; entryId: string }
  | {
    kind: 'hold';
    entryId: string;
    state: 'open' | 'ruled';
    ruling: { outcome: 'release' | 'retain' | 'withdraw' } | null;
  }
  | { kind: 'action'; entryId: string; state: string }
  | { kind: 'delivery'; entryId: string; state: string }
  | { kind: 'resource'; entryId: string; disposition: string }
  | { kind: 'control'; entryId: string; state: string };

export type TaskRecapEntryShape = { kind: 'taskEntry'; current: boolean; row: TaskRecapRowShape };

type TaskRecapOutput<View extends TaskRecapProjection> = {
  ok: true;
  contextStatus: 'complete' | 'partial';
  view: CurrentTaskRecapProjection<View>;
  counts: NonNullable<View['taskCounts']>;
  unresolved: {
    tasks: string[];
    holds: string[];
    resources: string[];
    deliveries: string[];
    effects: string[];
    attempts: string[];
    controls: string[];
  };
  gaps: string[];
  warnings: string[];
  acceptance: 'not-established-by-this-recap';
};

/**
 * Wraps one already-authorized tasks-section projection for succession and
 * review. The projection owns readiness, qualification, rulings, current-row
 * identity, counts, pins, history and omission accounting. This function adds
 * no second resolver and performs no ledger, filesystem, SDK or host reads.
 */
export function buildTaskRecap<View extends TaskRecapProjection>(view: View): TaskRecapOutput<View> {
  if (view.section !== 'tasks') {
    throw new TypeError('buildTaskRecap requires a tasks-section projection');
  }
  if (view.taskCounts === undefined) {
    throw new TypeError('buildTaskRecap requires full-ledger task counts from the projection');
  }
  const taskView = view as CurrentTaskRecapProjection<View>;

  const gaps: string[] = [];
  const warnings = [
    'Task rows, readiness, current result qualification, current ruling and queue counts are carried from the shared projection; this recap does not recompute them.',
    'Queue counts cover current task identities across the full ledger. Unresolved ids include only current entity rows; superseded history remains in view.',
    'Owner and membership data, evidence references, delivery states, host effects and resource dispositions remain ledger claims; this recap performs no host or filesystem reads.',
    'Task rulings and integration receipts do not establish project acceptance. Resource settlement and recipient acknowledgment are not established by this recap.',
  ];
  const unresolved: TaskRecapOutput<View>['unresolved'] = {
    tasks: [],
    holds: [],
    resources: [],
    deliveries: [],
    effects: [],
    attempts: [],
    controls: [],
  };

  for (const candidate of taskView.items) {
    if (candidate.kind !== 'taskEntry') {
      gaps.push('tasks-section-contained-non-task-entry');
      continue;
    }
    const item = candidate as TaskRecapEntryShape;
    if (!item.current) continue;

    const row = item.row;
    switch (row.kind) {
      case 'task':
        if (row.state === 'open' || row.state === 'reopened') unresolved.tasks.push(row.entryId);
        break;
      case 'attempt':
        if (row.state !== 'settled' && row.state !== 'stopped') unresolved.attempts.push(row.entryId);
        break;
      case 'result':
      case 'adjudication':
        break;
      case 'hold':
        if (row.state === 'open' || row.ruling?.outcome === 'retain') unresolved.holds.push(row.entryId);
        break;
      case 'action':
        if (row.state !== 'observed' && row.state !== 'failed' && row.state !== 'abandoned') {
          unresolved.effects.push(row.entryId);
        }
        break;
      case 'delivery':
        if (row.state !== 'handled') unresolved.deliveries.push(row.entryId);
        break;
      case 'resource':
        if (row.disposition !== 'released') unresolved.resources.push(row.entryId);
        break;
      case 'control':
        if (row.state === 'stop-requested') unresolved.controls.push(row.entryId);
        break;
    }
  }

  const hasOmissions = taskView.omittedBefore > 0 || taskView.omittedAfter > 0;
  if (hasOmissions) {
    gaps.push('task-history-page-incomplete');
    warnings.push('This recap carries one task-history page; omitted rows remain counted by view.omittedBefore and view.omittedAfter, not summarized.');
  }
  if (gaps.length > 0) {
    warnings.push('The shared projection contains an incomplete task-page shape; consult gaps while the original rows remain available in view.');
  }

  return {
    ok: true,
    contextStatus: gaps.length > 0 ? 'partial' : 'complete',
    view: taskView,
    counts: taskView.taskCounts,
    unresolved,
    gaps,
    warnings,
    acceptance: 'not-established-by-this-recap',
  };
}
