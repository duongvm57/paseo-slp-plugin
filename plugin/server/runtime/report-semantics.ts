// Pure, dependency-free semantics for the optional v1 structured report.
// Evidence provenance stays in the enclosing slp-record.

export type SlpReportIssue = { code: string; field?: string; message: string };
export type SlpReportValidation = { valid: boolean; errors: SlpReportIssue[]; warnings: SlpReportIssue[] };
export type SlpReportContext = { candidate?: unknown };

export const SLP_REPORT_FORMAT = 'slp-report';
export const SLP_REPORT_VERSION = 1;
export const SLP_REPORT_PURPOSES = Object.freeze(['execution', 'review', 'adjudication'] as const);

const nb = { type: 'string', minLength: 1, pattern: '\\S' };
const nullableNb = { anyOf: [{ type: 'null' }, nb] };
const stringList = { type: 'array', items: nb };
const objectSchema = (required: string[], properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'object', required, properties, additionalProperties: false, ...extra,
});
const arraySchema = (items: unknown, minItems?: number) => ({
  type: 'array', items, ...(minItems === undefined ? {} : { minItems }),
});
const evidenceSchema = objectSchema(['summary', 'source', 'basis', 'ref'], {
  summary: nb, source: nb, basis: { enum: ['observed', 'self-report', 'inference'] }, ref: nb,
});
const findingSchema = objectSchema(['id', 'state', 'obligation', 'evidence', 'remedy'], {
  id: nb, state: { enum: ['hypothesis', 'confirmed'] }, obligation: nb,
  evidence: arraySchema(evidenceSchema, 1), remedy: nb,
}, {
  allOf: [{
    if: { properties: { state: { const: 'confirmed' } }, required: ['state'] },
    then: {
      properties: {
        evidence: {
          contains: { properties: { basis: { const: 'observed' } }, required: ['basis'] },
        },
      },
    },
  }],
});
const executionSchema = objectSchema(['result', 'completed', 'unfinished'], {
  result: nb, completed: stringList,
  unfinished: arraySchema(objectSchema(['item', 'state', 'ownerId', 'reason'], {
    item: nb, state: { enum: ['open', 'blocked', 'waiting'] }, ownerId: nullableNb, reason: nb,
  })),
});
const reviewSchema = objectSchema(['outcome', 'mandate', 'findingRefs'], {
  outcome: nb,
  mandate: objectSchema(['id', 'assignmentRevision', 'scopeRevision', 'candidateRef'], {
    id: nb, assignmentRevision: nb, scopeRevision: nb, candidateRef: nb,
  }),
  findingRefs: stringList,
});
const decisionSchema = objectSchema([
  'proposition', 'ruling', 'reason', 'supportingEvidence', 'contraryEvidence', 'unresolvedRisk',
  'affectedRevision', 'affectedOwners', 'notificationRefs', 'outcomeRefs',
], {
  proposition: nb, ruling: nb, reason: nb, supportingEvidence: stringList, contraryEvidence: stringList,
  unresolvedRisk: nb, affectedRevision: nb, affectedOwners: stringList, notificationRefs: stringList, outcomeRefs: stringList,
});
const unresolvedSchema = objectSchema(['proposition', 'reason', 'ownerId'], {
  proposition: nb, reason: nb, ownerId: nullableNb,
});
const adjudicationSchema = objectSchema(['summary', 'state', 'decisions', 'unresolved'], {
  summary: nb, state: { enum: ['decided', 'pending', 'no-material-decision'] },
  decisions: arraySchema(decisionSchema), unresolved: arraySchema(unresolvedSchema),
}, {
  anyOf: [
    { properties: { state: { const: 'decided' }, decisions: { minItems: 1 } }, required: ['state', 'decisions'] },
    { properties: { state: { const: 'pending' }, unresolved: { minItems: 1 } }, required: ['state', 'unresolved'] },
    { properties: { state: { const: 'no-material-decision' }, decisions: { maxItems: 0 }, unresolved: { maxItems: 0 } }, required: ['state', 'decisions', 'unresolved'] },
  ],
});
const assignmentSchema = objectSchema(['id', 'revision', 'scopeRevision', 'sourceRef', 'objective', 'acceptance', 'authority', 'scope'], {
  id: nullableNb, revision: nullableNb, scopeRevision: nullableNb, sourceRef: nullableNb, objective: nb,
  acceptance: arraySchema(nb, 1),
  authority: arraySchema(objectSchema(['claim', 'sourceRef'], { claim: nb, sourceRef: nb }), 1),
  scope: objectSchema(['owned', 'excluded'], { owned: arraySchema(nb, 1), excluded: stringList }),
});
const ownerSchema = objectSchema(['surface', 'ownerId', 'role', 'state', 'basis', 'sourceRef'], {
  surface: nb, ownerId: nullableNb, role: nullableNb,
  state: { enum: ['active', 'paused', 'unverified', 'unassigned'] },
  basis: { enum: ['assignment', 'host-observation', 'self-report', 'unknown'] }, sourceRef: nullableNb,
});
const dependencySchema = objectSchema(['need', 'state', 'ownerId', 'sourceRef'], {
  need: nb, state: { enum: ['ready', 'open', 'blocked', 'unknown'] }, ownerId: nullableNb, sourceRef: nullableNb,
});
const resourceSchema = objectSchema(['kind', 'id', 'ownerId', 'state', 'sourceRef'], {
  kind: nb, id: nb, ownerId: nullableNb, state: { enum: ['retained', 'paused', 'unknown', 'released'] }, sourceRef: nullableNb,
});
const reportProperties = {
  format: { const: SLP_REPORT_FORMAT }, version: { const: SLP_REPORT_VERSION }, purpose: { enum: [...SLP_REPORT_PURPOSES] },
  assignment: assignmentSchema, assumptions: stringList,
  unknowns: arraySchema(objectSchema(['question', 'impact', 'ownerId'], { question: nb, impact: nb, ownerId: nullableNb })),
  selfReport: objectSchema(['read', 'ran'], { read: stringList, ran: stringList }),
  execution: { oneOf: [executionSchema, { type: 'null' }] },
  review: { oneOf: [reviewSchema, { type: 'null' }] },
  adjudication: { oneOf: [adjudicationSchema, { type: 'null' }] },
  findings: arraySchema(findingSchema), owners: arraySchema(ownerSchema), dependencies: arraySchema(dependencySchema),
  nextAction: objectSchema(['state', 'action', 'ownerId'], {
    state: { enum: ['ready', 'blocked', 'none'] }, action: nullableNb, ownerId: nullableNb,
  }, {
    allOf: [{
      if: { properties: { state: { const: 'none' } }, required: ['state'] },
      then: { properties: { action: { type: 'null' }, ownerId: { type: 'null' } } },
      else: { properties: { action: nb } },
    }],
  }),
  resources: arraySchema(resourceSchema),
};

/** JSON Schema fragment composed into the canonical v1 envelope. */
export const SLP_REPORT_V1_SCHEMA = objectSchema([
  'format', 'version', 'purpose', 'assignment', 'assumptions', 'unknowns', 'selfReport',
  'execution', 'review', 'adjudication', 'findings', 'owners', 'dependencies', 'nextAction', 'resources',
], reportProperties, {
  description: 'Optional structured report v1. Narrative strings must contain non-whitespace text.',
  allOf: [
    { if: { properties: { purpose: { const: 'execution' } }, required: ['purpose'] },
      then: { properties: { execution: executionSchema, review: { type: 'null' }, adjudication: { type: 'null' } } } },
    { if: { properties: { purpose: { const: 'review' } }, required: ['purpose'] },
      then: { properties: { execution: { type: 'null' }, review: reviewSchema, adjudication: { type: 'null' } } } },
    { if: { properties: { purpose: { const: 'adjudication' } }, required: ['purpose'] },
      then: { properties: { execution: { type: 'null' }, review: { type: 'null' }, adjudication: adjudicationSchema } } },
  ],
  'x-slpreport-semantic-rules': [
    'review requires an envelope candidate and matching assignment/scope revisions and candidate pin',
    'every review findingRef resolves to a report finding id',
    'confirmed findings include evidence with basis observed; source/ref do not prove the claim',
    'selfReport.read, selfReport.ran, checks and candidate remain claims, not execution proof or acceptance',
  ],
});

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const issue = (field: string, message: string): SlpReportIssue => ({ code: 'invalid-report', field, message });
const err = (errors: SlpReportIssue[], field: string, message: string) => errors.push(issue(field, message));
const keysAt = (value: Record<string, unknown>, field: string, allowed: string[], errors: SlpReportIssue[]) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) err(errors, field + '.' + key, 'unexpected field ' + key);
};
function objectAt(value: unknown, field: string, errors: SlpReportIssue[]): Record<string, unknown> | undefined {
  if (isObject(value)) return value;
  err(errors, field, field + ' must be an object');
  return undefined;
}
function requiredAt(value: Record<string, unknown>, key: string, field: string, errors: SlpReportIssue[]): unknown {
  if (Object.hasOwn(value, key)) return value[key];
  err(errors, field + '.' + key, key + ' is required');
  return undefined;
}
function stringAt(value: unknown, field: string, errors: SlpReportIssue[], nullable = false): void {
  if (nullable && value === null) return;
  if (!nonBlank(value)) err(errors, field, field + ' must contain non-whitespace text' + (nullable ? ' or be null' : ''));
}
function enumAt(value: unknown, field: string, choices: readonly string[], errors: SlpReportIssue[]): void {
  if (typeof value !== 'string' || !choices.includes(value)) err(errors, field, field + ' must be one of ' + choices.join(', '));
}
function listAt(value: unknown, field: string, errors: SlpReportIssue[], min = 0): string[] | undefined {
  if (!Array.isArray(value)) { err(errors, field, field + ' must be an array'); return undefined; }
  if (value.length < min) err(errors, field, field + ' must contain at least ' + min + ' item(s)');
  value.forEach((item, index) => stringAt(item, field + '[' + index + ']', errors));
  return value.filter((item): item is string => typeof item === 'string');
}
function rowsAt(value: unknown, field: string, errors: SlpReportIssue[], visit: (row: Record<string, unknown>, at: string) => void): void {
  if (!Array.isArray(value)) { err(errors, field, field + ' must be an array'); return; }
  value.forEach((item, index) => { const at = field + '[' + index + ']'; const row = objectAt(item, at, errors); if (row) visit(row, at); });
}
function validateEvidence(value: unknown, field: string, errors: SlpReportIssue[]): unknown {
  const row = objectAt(value, field, errors);
  if (!row) return undefined;
  keysAt(row, field, ['summary', 'source', 'basis', 'ref'], errors);
  stringAt(requiredAt(row, 'summary', field, errors), field + '.summary', errors);
  stringAt(requiredAt(row, 'source', field, errors), field + '.source', errors);
  enumAt(requiredAt(row, 'basis', field, errors), field + '.basis', ['observed', 'self-report', 'inference'], errors);
  stringAt(requiredAt(row, 'ref', field, errors), field + '.ref', errors);
  return row.basis;
}
function validateFindings(value: unknown, errors: SlpReportIssue[]): Map<string, true> {
  const ids = new Map<string, true>();
  rowsAt(value, 'report.findings', errors, (row, field) => {
    keysAt(row, field, ['id', 'state', 'obligation', 'evidence', 'remedy'], errors);
    const id = requiredAt(row, 'id', field, errors); stringAt(id, field + '.id', errors);
    if (typeof id === 'string' && id.trim()) { if (ids.has(id)) err(errors, field + '.id', 'duplicate finding id'); ids.set(id, true); }
    const state = requiredAt(row, 'state', field, errors); enumAt(state, field + '.state', ['hypothesis', 'confirmed'], errors);
    stringAt(requiredAt(row, 'obligation', field, errors), field + '.obligation', errors);
    const evidence = requiredAt(row, 'evidence', field, errors);
    if (!Array.isArray(evidence)) err(errors, field + '.evidence', field + '.evidence must be an array');
    else {
      if (!evidence.length) err(errors, field + '.evidence', field + '.evidence must contain at least one item');
      const bases = evidence.map((item, index) => validateEvidence(item, field + '.evidence[' + index + ']', errors));
      if (state === 'confirmed' && !bases.includes('observed')) err(errors, field + '.evidence', 'confirmed findings require an observed source/ref');
    }
    stringAt(requiredAt(row, 'remedy', field, errors), field + '.remedy', errors);
  });
  return ids;
}
function validateAssignment(value: unknown, errors: SlpReportIssue[]): Record<string, unknown> | undefined {
  const field = 'report.assignment'; const row = objectAt(value, field, errors); if (!row) return undefined;
  keysAt(row, field, ['id', 'revision', 'scopeRevision', 'sourceRef', 'objective', 'acceptance', 'authority', 'scope'], errors);
  for (const key of ['id', 'revision', 'scopeRevision', 'sourceRef']) stringAt(requiredAt(row, key, field, errors), field + '.' + key, errors, true);
  stringAt(requiredAt(row, 'objective', field, errors), field + '.objective', errors);
  listAt(requiredAt(row, 'acceptance', field, errors), field + '.acceptance', errors, 1);
  const authorityValue = requiredAt(row, 'authority', field, errors);
  if (Array.isArray(authorityValue) && authorityValue.length === 0) err(errors, field + '.authority', 'authority must contain at least one source');
  rowsAt(authorityValue, field + '.authority', errors, (authority, at) => {
    keysAt(authority, at, ['claim', 'sourceRef'], errors);
    stringAt(requiredAt(authority, 'claim', at, errors), at + '.claim', errors);
    stringAt(requiredAt(authority, 'sourceRef', at, errors), at + '.sourceRef', errors);
  });
  const scopeField = field + '.scope'; const scope = objectAt(requiredAt(row, 'scope', field, errors), scopeField, errors);
  if (scope) {
    keysAt(scope, scopeField, ['owned', 'excluded'], errors);
    listAt(requiredAt(scope, 'owned', scopeField, errors), scopeField + '.owned', errors, 1);
    listAt(requiredAt(scope, 'excluded', scopeField, errors), scopeField + '.excluded', errors);
  }
  return row;
}
function validateCommon(report: Record<string, unknown>, errors: SlpReportIssue[]): void {
  listAt(requiredAt(report, 'assumptions', 'report', errors), 'report.assumptions', errors);
  rowsAt(requiredAt(report, 'unknowns', 'report', errors), 'report.unknowns', errors, (row, field) => {
    keysAt(row, field, ['question', 'impact', 'ownerId'], errors);
    stringAt(requiredAt(row, 'question', field, errors), field + '.question', errors);
    stringAt(requiredAt(row, 'impact', field, errors), field + '.impact', errors);
    stringAt(requiredAt(row, 'ownerId', field, errors), field + '.ownerId', errors, true);
  });
  const self = objectAt(requiredAt(report, 'selfReport', 'report', errors), 'report.selfReport', errors);
  if (self) {
    keysAt(self, 'report.selfReport', ['read', 'ran'], errors);
    listAt(requiredAt(self, 'read', 'report.selfReport', errors), 'report.selfReport.read', errors);
    listAt(requiredAt(self, 'ran', 'report.selfReport', errors), 'report.selfReport.ran', errors);
  }
  rowsAt(requiredAt(report, 'owners', 'report', errors), 'report.owners', errors, (row, field) => {
    keysAt(row, field, ['surface', 'ownerId', 'role', 'state', 'basis', 'sourceRef'], errors);
    stringAt(requiredAt(row, 'surface', field, errors), field + '.surface', errors);
    stringAt(requiredAt(row, 'ownerId', field, errors), field + '.ownerId', errors, true);
    stringAt(requiredAt(row, 'role', field, errors), field + '.role', errors, true);
    enumAt(requiredAt(row, 'state', field, errors), field + '.state', ['active', 'paused', 'unverified', 'unassigned'], errors);
    enumAt(requiredAt(row, 'basis', field, errors), field + '.basis', ['assignment', 'host-observation', 'self-report', 'unknown'], errors);
    stringAt(requiredAt(row, 'sourceRef', field, errors), field + '.sourceRef', errors, true);
  });
  rowsAt(requiredAt(report, 'dependencies', 'report', errors), 'report.dependencies', errors, (row, field) => {
    keysAt(row, field, ['need', 'state', 'ownerId', 'sourceRef'], errors);
    stringAt(requiredAt(row, 'need', field, errors), field + '.need', errors);
    enumAt(requiredAt(row, 'state', field, errors), field + '.state', ['ready', 'open', 'blocked', 'unknown'], errors);
    stringAt(requiredAt(row, 'ownerId', field, errors), field + '.ownerId', errors, true);
    stringAt(requiredAt(row, 'sourceRef', field, errors), field + '.sourceRef', errors, true);
  });
  const actionField = 'report.nextAction'; const action = objectAt(requiredAt(report, 'nextAction', 'report', errors), actionField, errors);
  if (action) {
    keysAt(action, actionField, ['state', 'action', 'ownerId'], errors);
    const state = requiredAt(action, 'state', actionField, errors); enumAt(state, actionField + '.state', ['ready', 'blocked', 'none'], errors);
    const verb = requiredAt(action, 'action', actionField, errors); const owner = requiredAt(action, 'ownerId', actionField, errors);
    if (state === 'none') {
      if (verb !== null) err(errors, actionField + '.action', 'action must be null when state is none');
      if (owner !== null) err(errors, actionField + '.ownerId', 'ownerId must be null when state is none');
    } else { stringAt(verb, actionField + '.action', errors); stringAt(owner, actionField + '.ownerId', errors, true); }
  }
  rowsAt(requiredAt(report, 'resources', 'report', errors), 'report.resources', errors, (row, field) => {
    keysAt(row, field, ['kind', 'id', 'ownerId', 'state', 'sourceRef'], errors);
    stringAt(requiredAt(row, 'kind', field, errors), field + '.kind', errors);
    stringAt(requiredAt(row, 'id', field, errors), field + '.id', errors);
    stringAt(requiredAt(row, 'ownerId', field, errors), field + '.ownerId', errors, true);
    enumAt(requiredAt(row, 'state', field, errors), field + '.state', ['retained', 'paused', 'unknown', 'released'], errors);
    stringAt(requiredAt(row, 'sourceRef', field, errors), field + '.sourceRef', errors, true);
  });
}
function validateExecution(value: unknown, errors: SlpReportIssue[]): void {
  const field = 'report.execution'; const row = objectAt(value, field, errors); if (!row) return;
  keysAt(row, field, ['result', 'completed', 'unfinished'], errors);
  stringAt(requiredAt(row, 'result', field, errors), field + '.result', errors);
  listAt(requiredAt(row, 'completed', field, errors), field + '.completed', errors);
  rowsAt(requiredAt(row, 'unfinished', field, errors), field + '.unfinished', errors, (item, at) => {
    keysAt(item, at, ['item', 'state', 'ownerId', 'reason'], errors);
    stringAt(requiredAt(item, 'item', at, errors), at + '.item', errors);
    enumAt(requiredAt(item, 'state', at, errors), at + '.state', ['open', 'blocked', 'waiting'], errors);
    stringAt(requiredAt(item, 'ownerId', at, errors), at + '.ownerId', errors, true);
    stringAt(requiredAt(item, 'reason', at, errors), at + '.reason', errors);
  });
}
function validateReview(value: unknown, report: Record<string, unknown>, context: SlpReportContext, ids: Map<string, true>, errors: SlpReportIssue[]): void {
  const field = 'report.review'; const row = objectAt(value, field, errors); if (!row) return;
  keysAt(row, field, ['outcome', 'mandate', 'findingRefs'], errors);
  stringAt(requiredAt(row, 'outcome', field, errors), field + '.outcome', errors);
  const mandateField = field + '.mandate'; const mandate = objectAt(requiredAt(row, 'mandate', field, errors), mandateField, errors);
  if (mandate) {
    keysAt(mandate, mandateField, ['id', 'assignmentRevision', 'scopeRevision', 'candidateRef'], errors);
    for (const key of ['id', 'assignmentRevision', 'scopeRevision', 'candidateRef']) stringAt(requiredAt(mandate, key, mandateField, errors), mandateField + '.' + key, errors);
    const assignment = isObject(report.assignment) ? report.assignment : undefined;
    if (assignment && nonBlank(mandate.assignmentRevision) && mandate.assignmentRevision !== assignment.revision) err(errors, mandateField + '.assignmentRevision', 'mandate assignment revision must match assignment revision');
    if (assignment && nonBlank(mandate.scopeRevision) && mandate.scopeRevision !== assignment.scopeRevision) err(errors, mandateField + '.scopeRevision', 'mandate scope revision must match assignment scope revision');
    if (!isObject(context.candidate)) err(errors, 'candidate', 'review reports require a non-null envelope candidate');
    else {
      const pin = context.candidate.head ?? context.candidate.snapshotSha256;
      if (nonBlank(mandate.candidateRef) && mandate.candidateRef !== pin) err(errors, mandateField + '.candidateRef', 'mandate candidateRef must match envelope candidate pin');
    }
  }
  const refs = listAt(requiredAt(row, 'findingRefs', field, errors), field + '.findingRefs', errors);
  refs?.forEach((id, index) => { if (!ids.has(id)) err(errors, field + '.findingRefs[' + index + ']', 'finding reference does not resolve'); });
}
function validateAdjudication(value: unknown, errors: SlpReportIssue[]): void {
  const field = 'report.adjudication'; const row = objectAt(value, field, errors); if (!row) return;
  keysAt(row, field, ['summary', 'state', 'decisions', 'unresolved'], errors);
  stringAt(requiredAt(row, 'summary', field, errors), field + '.summary', errors);
  const state = requiredAt(row, 'state', field, errors); enumAt(state, field + '.state', ['decided', 'pending', 'no-material-decision'], errors);
  const decisions = requiredAt(row, 'decisions', field, errors);
  rowsAt(decisions, field + '.decisions', errors, (decision, at) => {
    const keys = ['proposition', 'ruling', 'reason', 'supportingEvidence', 'contraryEvidence', 'unresolvedRisk', 'affectedRevision', 'affectedOwners', 'notificationRefs', 'outcomeRefs'];
    keysAt(decision, at, keys, errors);
    for (const key of ['proposition', 'ruling', 'reason', 'unresolvedRisk', 'affectedRevision']) stringAt(requiredAt(decision, key, at, errors), at + '.' + key, errors);
    for (const key of ['supportingEvidence', 'contraryEvidence', 'affectedOwners', 'notificationRefs', 'outcomeRefs']) listAt(requiredAt(decision, key, at, errors), at + '.' + key, errors);
  });
  const unresolved = requiredAt(row, 'unresolved', field, errors);
  rowsAt(unresolved, field + '.unresolved', errors, (decision, at) => {
    keysAt(decision, at, ['proposition', 'reason', 'ownerId'], errors);
    stringAt(requiredAt(decision, 'proposition', at, errors), at + '.proposition', errors);
    stringAt(requiredAt(decision, 'reason', at, errors), at + '.reason', errors);
    stringAt(requiredAt(decision, 'ownerId', at, errors), at + '.ownerId', errors, true);
  });
  if (state === 'decided' && Array.isArray(decisions) && !decisions.length) err(errors, field + '.decisions', 'decided adjudication requires a decision');
  if (state === 'pending' && Array.isArray(unresolved) && !unresolved.length) err(errors, field + '.unresolved', 'pending adjudication requires unresolved work');
  if (state === 'no-material-decision' && ((Array.isArray(decisions) && decisions.length) || (Array.isArray(unresolved) && unresolved.length))) err(errors, field, 'no-material-decision requires empty decisions and unresolved arrays');
}

/** Validates report semantics without filesystem, host, CLI, or schema-library access. */
export function validateSlpReportV1(value: unknown, context: SlpReportContext = {}): SlpReportValidation {
  const errors: SlpReportIssue[] = [];
  const report = objectAt(value, 'report', errors);
  if (!report) return { valid: false, errors, warnings: [] };
  keysAt(report, 'report', [
    'format', 'version', 'purpose', 'assignment', 'assumptions', 'unknowns', 'selfReport',
    'execution', 'review', 'adjudication', 'findings', 'owners', 'dependencies', 'nextAction', 'resources',
  ], errors);
  if (!Object.hasOwn(report, 'format')) err(errors, 'report.format', 'format is required');
  else if (report.format !== SLP_REPORT_FORMAT) err(errors, 'report.format', 'format must be slp-report');
  if (!Object.hasOwn(report, 'version')) err(errors, 'report.version', 'version is required');
  else if (report.version !== SLP_REPORT_VERSION) err(errors, 'report.version', 'only slp-report version 1 is supported');
  const purpose = requiredAt(report, 'purpose', 'report', errors); enumAt(purpose, 'report.purpose', SLP_REPORT_PURPOSES, errors);
  const assignment = validateAssignment(requiredAt(report, 'assignment', 'report', errors), errors);
  validateCommon(report, errors);
  const ids = validateFindings(requiredAt(report, 'findings', 'report', errors), errors);
  for (const key of ['execution', 'review', 'adjudication']) requiredAt(report, key, 'report', errors);
  if (purpose === 'execution') {
    validateExecution(report.execution, errors);
    if (report.review !== null) err(errors, 'report.review', 'execution reports require review to be null');
    if (report.adjudication !== null) err(errors, 'report.adjudication', 'execution reports require adjudication to be null');
  } else if (purpose === 'review') {
    if (report.execution !== null) err(errors, 'report.execution', 'review reports require execution to be null');
    validateReview(report.review, report, context, ids, errors);
    if (report.adjudication !== null) err(errors, 'report.adjudication', 'review reports require adjudication to be null');
    if (assignment && (!nonBlank(assignment.revision) || !nonBlank(assignment.scopeRevision))) err(errors, 'report.assignment', 'review reports require assignment and scope revisions');
  } else if (purpose === 'adjudication') {
    if (report.execution !== null) err(errors, 'report.execution', 'adjudication reports require execution to be null');
    if (report.review !== null) err(errors, 'report.review', 'adjudication reports require review to be null');
    validateAdjudication(report.adjudication, errors);
  } else {
    for (const key of ['execution', 'review', 'adjudication']) if (report[key] !== null) err(errors, 'report.' + key, 'unsupported purpose requires branch to be null');
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}

function renderList(title: string, values: unknown): string[] {
  const rows = Array.isArray(values) ? values : [];
  return ['### ' + title, ...(rows.length ? rows.map(value => '- ' + JSON.stringify(value)) : ['- None recorded.'])];
}

/** Renders a validated report and appends the original fenced record text unchanged. */
export function renderSlpReport(recordValue: unknown, originalFence: string): string {
  if (!isObject(recordValue) || !isObject(recordValue.report)) throw new TypeError('structured report required for rendering');
  if (typeof originalFence !== 'string') throw new TypeError('original slp-record fence is required');
  const validation = validateSlpReportV1(recordValue.report, { candidate: recordValue.candidate });
  if (!validation.valid) throw new TypeError('invalid slp-report cannot be rendered');
  const report = recordValue.report;
  const assignment = report.assignment as Record<string, unknown>;
  const self = report.selfReport as Record<string, unknown>;
  const purpose = String(report.purpose);
  const findings = report.findings as Record<string, unknown>[];
  const rowLines = (title: string, values: Record<string, unknown>[]) => [
    '### ' + title, ...(values.length ? values.map(value => '- ' + JSON.stringify(value)) : ['- None recorded.']),
  ];
  return [
    '# Structured handback report: ' + purpose,
    '',
    '> Self-reported narrative. This rendering does not establish that a command ran, runtime success was observed, or work was accepted.',
    '',
    '## Assignment',
    '- Objective: ' + JSON.stringify(assignment.objective),
    '- Reference: ' + JSON.stringify(assignment.id ?? 'unknown') + ' / ' + JSON.stringify(assignment.revision ?? 'unknown') + ' (' + JSON.stringify(assignment.sourceRef ?? 'source unavailable') + ')',
    '- Acceptance claims: ' + JSON.stringify(assignment.acceptance),
    '- Authority claims: ' + JSON.stringify(assignment.authority),
    '- Scope: ' + JSON.stringify(assignment.scope),
    '',
    '## ' + purpose.charAt(0).toUpperCase() + purpose.slice(1) + ' outcome',
    JSON.stringify(report[purpose], null, 2),
    '',
    ...renderList('Assumptions', report.assumptions),
    '',
    '### Unknowns',
    ...(Array.isArray(report.unknowns) && report.unknowns.length ? report.unknowns.map(value => '- ' + JSON.stringify(value)) : ['- None recorded.']),
    '',
    '## Findings',
    ...(findings.length ? findings.map(value => '- Finding ' + JSON.stringify(value.id) + ' (' + JSON.stringify(value.state) + ') — ' + JSON.stringify(value.obligation)
      + '\n  Evidence: ' + JSON.stringify(value.evidence) + '\n  Remedy: ' + JSON.stringify(value.remedy)) : ['- None recorded.']),
    '',
    '## Ownership and continuity',
    ...rowLines('Owners', report.owners as Record<string, unknown>[]),
    ...rowLines('Dependencies', report.dependencies as Record<string, unknown>[]),
    '### Next action\n- ' + JSON.stringify(report.nextAction),
    ...rowLines('Resources', report.resources as Record<string, unknown>[]),
    '',
    '## Self-reported activity',
    ...renderList('Read (self-reported)', self.read),
    ...renderList('Ran (self-reported; not proof of execution)', self.ran),
    '',
    '## Original v1 evidence block',
    '> The enclosing candidate and checks are claims. A matching sha binds output bytes; it does not prove command execution.',
    '',
    originalFence,
  ].join('\n');
}
