import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { hash } from './package.mjs';

export const RECORD_KINDS = Object.freeze(['handback', 'settlement']);
export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const HANDBACK_VERDICTS = Object.freeze(['APPROVE', 'FINDINGS', 'BLOCKED', 'REOPEN_REQUEST', 'DEPENDENCY_REQUEST']);
export const SETTLEMENT_VIA = Object.freeze(['paseo-logs', 'host-transcript', 'sessions-db', 'unreadable', 'unchecked']);
export const GIT_HEAD_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d\d-\d\dT.*Z$/u;
export const REPOSITORY_RELATIVE_PATH_PATTERN = /^(?=[\s\S]*\S)(?![\\/])(?![A-Za-z]:)(?![\s\S]*(?:^|[\\/])\.\.(?:[\\/]|$))[\s\S]+$/u;
const absoluteRepositoryPathPattern = process.platform === 'win32'
  ? /^(?:[A-Za-z]:[\\/]|\\\\)/u
  : /^\//u;
const nonBlankStringSchema = { type: 'string', minLength: 1, pattern: '\\S' };
const nullableNonBlankStringSchema = { anyOf: [{ type: 'null' }, nonBlankStringSchema] };

const kindSet = new Set(RECORD_KINDS);
const handbackVerdicts = new Set(HANDBACK_VERDICTS);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const absolutePath = value => typeof value === 'string' && isAbsolute(value);
const issue = (code, field, message) => ({ code, ...(field ? { field } : {}), message });

export function recomputeSha(bytes) {
  return hash(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
}

function validateCandidate(candidate, field, errors, warnings) {
  if (candidate === null) return;
  if (!isObject(candidate)) {
    errors.push(issue('invalid-record', field, `${field} must be an object or null`));
    return;
  }
  if (!nonempty(candidate.repository)) errors.push(issue('invalid-record', `${field}.repository`, 'repository must be a non-empty absolute path'));
  else if (!absolutePath(candidate.repository)) errors.push(issue('invalid-record', `${field}.repository`, 'repository must be an absolute path'));

  const hasSnapshot = candidate.snapshotSha256 !== undefined;
  const hasHead = candidate.head !== undefined;
  if (hasSnapshot === hasHead) {
    errors.push(issue('invalid-record', field, 'provide exactly one of snapshotSha256 or head'));
  }
  if (hasSnapshot && (typeof candidate.snapshotSha256 !== 'string' || !SHA256_PATTERN.test(candidate.snapshotSha256))) {
    errors.push(issue('invalid-record', `${field}.snapshotSha256`, 'snapshotSha256 must be a 64-character lowercase SHA-256'));
  }
  if (hasHead && (typeof candidate.head !== 'string' || !GIT_HEAD_PATTERN.test(candidate.head))) {
    errors.push(issue('invalid-record', `${field}.head`, 'head must be a full 40- or 64-character lowercase Git object id'));
  }
  if (candidate.incomplete !== undefined && (!Array.isArray(candidate.incomplete) || candidate.incomplete.some(item => typeof item !== 'string'))) {
    errors.push(issue('invalid-record', `${field}.incomplete`, 'incomplete must be an array of strings'));
  } else if (candidate.incomplete?.length) {
    warnings.push(issue('candidate-incomplete', field, 'candidate has scope that is not proven clean'));
  }
}

function safeOutputRef(value) {
  return typeof value === 'string' && REPOSITORY_RELATIVE_PATH_PATTERN.test(value)
    && !isAbsolute(value) && !win32.isAbsolute(value);
}

function warnRepositoryMismatch(repository, field, repo, warnings, reported) {
  if (!absolutePath(repository) || !absolutePath(repo)) return;
  try {
    const declaredRoot = realpathSync(repository);
    const verifierRoot = realpathSync(repo);
    const mismatchKey = `${declaredRoot}\0${verifierRoot}`;
    if (declaredRoot !== verifierRoot && !reported.has(mismatchKey)) {
      warnings.push(issue('repository-mismatch', field, `${field} resolves to ${declaredRoot}, which differs from verifier --repo ${verifierRoot}; outputRef uses verifier --repo`));
      reported.add(mismatchKey);
    }
  } catch {
    // A missing root cannot be compared after realpath.
  }
}

function validateChecks(checks, errors, warnings, { repo, recordRepository, reportedRepositoryMismatches = new Set() } = {}) {
  if (!Array.isArray(checks)) {
    errors.push(issue('invalid-record', 'checks', 'checks must be an array'));
    return;
  }
  for (const [index, check] of checks.entries()) {
    const field = `checks[${index}]`;
    if (!isObject(check)) {
      errors.push(issue('invalid-record', field, `${field} must be an object`));
      continue;
    }
    for (const key of ['cmd', 'exit', 'sha']) {
      if (!Object.hasOwn(check, key)) errors.push(issue('invalid-record', `${field}.${key}`, `missing required field ${field}.${key}`));
    }
    if (!nonempty(check.cmd)) errors.push(issue('invalid-record', `${field}.cmd`, 'cmd must be a non-empty string'));
    if (!Number.isInteger(check.exit)) errors.push(issue('invalid-record', `${field}.exit`, 'exit must be an integer'));
    if (Object.hasOwn(check, 'sha') && check.sha !== null && (typeof check.sha !== 'string' || !SHA256_PATTERN.test(check.sha))) {
      errors.push(issue('invalid-record', `${field}.sha`, 'sha must be a 64-character lowercase SHA-256 or null'));
    }
    if (check.output !== undefined && typeof check.output !== 'string') errors.push(issue('invalid-record', `${field}.output`, 'output must be a string'));
    if (check.outputRef !== undefined && !safeOutputRef(check.outputRef)) {
      errors.push(issue('invalid-record', `${field}.outputRef`, 'outputRef must be a repository-relative path without parent traversal'));
    }
    if (check.candidate !== undefined) validateCandidate(check.candidate, `${field}.candidate`, errors, warnings);

    if (check.candidate !== undefined) {
      warnRepositoryMismatch(check.candidate?.repository, `${field}.candidate.repository`, repo, warnings, reportedRepositoryMismatches);
    }

    let evidence;
    let invalidOutputRef = check.outputRef !== undefined && !safeOutputRef(check.outputRef);
    let missingReported = false;
    if (typeof check.output === 'string') evidence = Buffer.from(check.output, 'utf8');
    else if (check.outputRef !== undefined && safeOutputRef(check.outputRef)) {
      const evidenceRepo = repo !== undefined ? repo : check.candidate?.repository ?? recordRepository;
      if (!absolutePath(evidenceRepo)) {
        const reason = evidenceRepo === undefined
          ? 'no effective repository root is available; outputRef was not read because the root is not absolute'
          : `effective repository root ${String(evidenceRepo)} is not absolute; outputRef was not read`;
        warnings.push(issue('check-evidence-missing', `${field}.outputRef`, reason));
        missingReported = true;
      } else {
        try {
          const repoPath = realpathSync(evidenceRepo);
          const outputPath = realpathSync(resolve(repoPath, check.outputRef));
          const relativePath = relative(repoPath, outputPath);
          if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
            errors.push(issue('invalid-record', `${field}.outputRef`, 'outputRef resolves outside the effective candidate repository root'));
            invalidOutputRef = true;
          } else evidence = readFileSync(outputPath);
        } catch {
          warnings.push(issue('check-evidence-missing', `${field}.outputRef`, 'outputRef could not be read with its effective candidate repository root'));
          missingReported = true;
        }
      }
    }

    if (!evidence && !invalidOutputRef && !missingReported) {
      const message = !Object.hasOwn(check, 'sha')
        ? 'sha key is missing; check evidence cannot be verified'
        : check.sha === null
          ? 'sha is null; check evidence is missing'
          : 'sha is present, but no readable output evidence is available to verify it';
      warnings.push(issue('check-evidence-missing', field, message));
    } else if (evidence && typeof check.sha === 'string' && SHA256_PATTERN.test(check.sha)) {
      const actual = recomputeSha(evidence);
      if (actual !== check.sha) errors.push(issue('sha-mismatch', `${field}.sha`, 'sha does not match output evidence'));
    } else if (evidence && !Object.hasOwn(check, 'sha')) {
      warnings.push(issue('check-evidence-missing', `${field}.sha`, 'output evidence is present but the sha key is missing'));
    } else if (evidence && check.sha === null) {
      warnings.push(issue('check-evidence-missing', `${field}.sha`, 'output evidence is present but sha is null'));
    }
  }
}

export function validateRecord(record, { repo } = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(record)) return { valid: false, errors: [issue('invalid-record', '', 'record must be an object')], warnings };
  if (!Object.hasOwn(record, 'version')) errors.push(issue('invalid-record', 'version', 'missing required field version'));
  else if (record.version !== 1) errors.push(issue('unsupported-version', 'version', 'only record version 1 is supported'));
  if (!Object.hasOwn(record, 'kind')) errors.push(issue('invalid-record', 'kind', 'missing required field kind'));
  else if (!kindSet.has(record.kind)) errors.push(issue('unknown-kind', 'kind', `kind must be ${RECORD_KINDS.join(' or ')}`));

  if (record.kind === 'handback') {
    for (const key of ['seat', 'verdict', 'candidate', 'checks']) {
      if (!Object.hasOwn(record, key)) errors.push(issue('invalid-record', key, `missing required field ${key}`));
    }
    if (isObject(record.seat)) {
      if (!nonempty(record.seat.role)) errors.push(issue('invalid-record', 'seat.role', 'seat.role must be a non-empty string'));
      if (!nonempty(record.seat.disposition)) errors.push(issue('invalid-record', 'seat.disposition', 'seat.disposition must be a non-empty string'));
      if (record.seat.agentId !== undefined && record.seat.agentId !== null && !nonempty(record.seat.agentId)) errors.push(issue('invalid-record', 'seat.agentId', 'seat.agentId must be a non-empty string or null'));
    } else if (record.seat !== undefined) errors.push(issue('invalid-record', 'seat', 'seat must be an object'));
    if (record.verdict !== undefined && record.verdict !== null && !handbackVerdicts.has(record.verdict)) {
      errors.push(issue('invalid-record', 'verdict', 'verdict must be APPROVE, FINDINGS, BLOCKED, REOPEN_REQUEST, DEPENDENCY_REQUEST, or null'));
    }
    const reportedRepositoryMismatches = new Set();
    if (Object.hasOwn(record, 'candidate')) {
      validateCandidate(record.candidate, 'candidate', errors, warnings);
      warnRepositoryMismatch(record.candidate?.repository, 'candidate.repository', repo, warnings, reportedRepositoryMismatches);
    }
    if (Object.hasOwn(record, 'checks')) validateChecks(record.checks, errors, warnings, {
      repo,
      recordRepository: record.candidate?.repository,
      reportedRepositoryMismatches
    });
    if (record.timeline !== undefined && !isObject(record.timeline)) errors.push(issue('invalid-record', 'timeline', 'timeline must be an object when present'));
    if (isObject(record.timeline) && record.timeline.sessionId !== undefined && record.timeline.sessionId !== null && !nonempty(record.timeline.sessionId)) {
      errors.push(issue('invalid-record', 'timeline.sessionId', 'timeline.sessionId must be a non-empty string or null'));
    }
  } else if (record.kind === 'settlement') {
    for (const key of ['task', 'seat', 'timeline', 'recordedBy', 'at']) {
      if (!Object.hasOwn(record, key)) errors.push(issue('invalid-record', key, `missing required field ${key}`));
    }
    if (record.task !== undefined && record.task !== null && !nonempty(record.task)) errors.push(issue('invalid-record', 'task', 'task must be a non-empty issue id or assignment slug, or null'));
    if (isObject(record.seat)) {
      for (const key of ['provider', 'title']) if (!nonempty(record.seat[key])) errors.push(issue('invalid-record', `seat.${key}`, `seat.${key} must be a non-empty string`));
      if (record.seat.agentId !== undefined && record.seat.agentId !== null && !nonempty(record.seat.agentId)) errors.push(issue('invalid-record', 'seat.agentId', 'seat.agentId must be a non-empty string or null'));
    } else if (record.seat !== undefined) errors.push(issue('invalid-record', 'seat', 'seat must be an object'));
    if (isObject(record.timeline)) {
      for (const key of ['nativeHandle', 'sessionId', 'via', 'export', 'gap']) {
        if (!Object.hasOwn(record.timeline, key)) errors.push(issue('invalid-record', `timeline.${key}`, `missing required field timeline.${key}`));
      }
      for (const key of ['nativeHandle', 'sessionId']) if (Object.hasOwn(record.timeline, key) && record.timeline[key] !== null && !nonempty(record.timeline[key])) errors.push(issue('invalid-record', `timeline.${key}`, `${key} must be a non-empty string or null`));
      if (Object.hasOwn(record.timeline, 'via') && !SETTLEMENT_VIA.includes(record.timeline.via)) {
        errors.push(issue('invalid-record', 'timeline.via', 'timeline.via is not a supported evidence source'));
      }
      if (Object.hasOwn(record.timeline, 'export') && record.timeline.export !== null) {
        const exported = record.timeline.export;
        if (!isObject(exported)) errors.push(issue('invalid-record', 'timeline.export', 'timeline.export must be an object or null'));
        else {
          if (!safeOutputRef(exported.path)) errors.push(issue('invalid-record', 'timeline.export.path', 'export path must be repository-relative'));
          if (typeof exported.sha256 !== 'string' || !SHA256_PATTERN.test(exported.sha256)) errors.push(issue('invalid-record', 'timeline.export.sha256', 'export sha256 must be a 64-character lowercase SHA-256'));
          if (!Number.isInteger(exported.bytes) || exported.bytes < 0) errors.push(issue('invalid-record', 'timeline.export.bytes', 'export bytes must be a non-negative integer'));
        }
      }
      if (Object.hasOwn(record.timeline, 'gap') && record.timeline.gap !== null && !nonempty(record.timeline.gap)) errors.push(issue('invalid-record', 'timeline.gap', 'timeline.gap must be a non-empty string or null'));
    } else if (record.timeline !== undefined) errors.push(issue('invalid-record', 'timeline', 'timeline must be an object'));
    if (Object.hasOwn(record, 'recordedBy') && !nonempty(record.recordedBy)) errors.push(issue('invalid-record', 'recordedBy', 'recordedBy must be a non-empty string'));
    if (Object.hasOwn(record, 'at') && (!nonempty(record.at) || !UTC_TIMESTAMP_PATTERN.test(record.at) || Number.isNaN(Date.parse(record.at)))) {
      errors.push(issue('invalid-record', 'at', 'at must be a valid UTC timestamp'));
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function extractRecords(text, { repo } = {}) {
  const records = [];
  const errors = [];
  const warnings = [];
  const lines = String(text).split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  let blockIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/^```slp-record\s*$/u.test(lines[i])) continue;
    blockIndex++;
    let end = i + 1;
    while (end < lines.length && !/^```\s*$/u.test(lines[end])) end++;
    if (end === lines.length) {
      errors.push({ ...issue('invalid-json', undefined, 'slp-record fence has no closing ``` line'), blockIndex });
      break;
    }
    const source = lines.slice(i + 1, end).join('\n');
    i = end;
    let record;
    try { record = JSON.parse(source); }
    catch (error) {
      errors.push({ ...issue('invalid-json', undefined, error.message), blockIndex });
      continue;
    }
    const validation = validateRecord(record, { repo });
    records.push({ blockIndex, record, valid: validation.valid, selected: false });
    errors.push(...validation.errors.map(item => ({ ...item, blockIndex })));
    warnings.push(...validation.warnings.map(item => ({ ...item, blockIndex })));
  }

  const byKind = new Map();
  for (const entry of records) {
    const kind = entry.record?.kind;
    if (!kindSet.has(kind)) continue;
    const entries = byKind.get(kind) ?? [];
    entries.push(entry);
    byKind.set(kind, entries);
  }
  for (const [kind, entries] of byKind) {
    entries.at(-1).selected = true;
    if (entries.length > 1) warnings.push({
      code: 'multiple-records', kind, count: entries.length,
      selectedBlockIndex: entries.at(-1).blockIndex,
      message: 'the last record of this kind is authoritative; earlier blocks are retained for inspection'
    });
  }
  if (blockIndex === 0) warnings.push({ code: 'no-record', message: 'report contains no slp-record block' });
  return { records, errors, warnings };
}

export function requireRecordKind(parsed, requiredKind) {
  if (!kindSet.has(requiredKind)) throw new TypeError(`unsupported required record kind: ${requiredKind}`);
  if (parsed.records.some(entry => entry.record?.kind === requiredKind)) return parsed;
  return {
    ...parsed,
    errors: [...parsed.errors, {
      code: 'required-kind-missing',
      kind: requiredKind,
      message: `required ${requiredKind} record is missing`
    }]
  };
}

export function recordSchema() {
  const sha = { type: 'string', pattern: SHA256_PATTERN.source };
  const candidate = {
    oneOf: [
      { type: 'null' },
      {
        type: 'object', required: ['repository'],
        properties: {
          repository: { ...nonBlankStringSchema, allOf: [{ pattern: absoluteRepositoryPathPattern.source }] },
          head: { type: 'string', pattern: GIT_HEAD_PATTERN.source },
          snapshotSha256: sha,
          incomplete: { type: 'array', items: { type: 'string' } }
        },
        oneOf: [{ required: ['head'], not: { required: ['snapshotSha256'] } }, { required: ['snapshotSha256'], not: { required: ['head'] } }]
      }
    ]
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Paseo SLP report record v1',
    oneOf: [
      {
        type: 'object', required: ['version', 'kind', 'seat', 'verdict', 'candidate', 'checks'],
        properties: {
          version: { const: 1 }, kind: { const: RECORD_KINDS[0] },
          seat: { type: 'object', required: ['role', 'disposition'], properties: { agentId: nullableNonBlankStringSchema, role: nonBlankStringSchema, disposition: nonBlankStringSchema } },
          verdict: { enum: [...HANDBACK_VERDICTS, null] }, candidate,
          checks: { type: 'array', items: { type: 'object', required: ['cmd', 'exit', 'sha'], properties: { cmd: nonBlankStringSchema, exit: { type: 'integer' }, sha: { oneOf: [sha, { type: 'null' }] }, output: { type: 'string' }, outputRef: { type: 'string', pattern: REPOSITORY_RELATIVE_PATH_PATTERN.source }, candidate } } },
          timeline: { type: 'object', properties: { sessionId: nullableNonBlankStringSchema } }
        }
      },
      {
        type: 'object', required: ['version', 'kind', 'task', 'seat', 'timeline', 'recordedBy', 'at'],
        properties: {
          version: { const: 1 }, kind: { const: RECORD_KINDS[1] }, task: nullableNonBlankStringSchema,
          seat: { type: 'object', required: ['provider', 'title'], properties: { agentId: nullableNonBlankStringSchema, provider: nonBlankStringSchema, title: nonBlankStringSchema } },
          timeline: {
            type: 'object', required: ['nativeHandle', 'sessionId', 'via', 'export', 'gap'], properties: {
              nativeHandle: nullableNonBlankStringSchema, sessionId: nullableNonBlankStringSchema,
              via: { enum: [...SETTLEMENT_VIA] },
              export: { oneOf: [{ type: 'null' }, { type: 'object', required: ['path', 'sha256', 'bytes'], properties: { path: { type: 'string', pattern: REPOSITORY_RELATIVE_PATH_PATTERN.source }, sha256: sha, bytes: { type: 'integer', minimum: 0 } } }] },
              gap: nullableNonBlankStringSchema
            }
          },
          recordedBy: nonBlankStringSchema, at: { type: 'string', format: 'date-time', pattern: UTC_TIMESTAMP_PATTERN.source }
        }
      }
    ]
  };
}
