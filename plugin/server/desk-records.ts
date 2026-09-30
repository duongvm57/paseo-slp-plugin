/**
 * desk-records.ts — report-record v1 validation for the desk server.
 *
 * A TypeScript port of src/report-records.mjs's validateRecord — that file
 * stays the authoritative, read-only semantics source. Same field checks,
 * same {code, field, message} issue shape, same code vocabulary, same
 * warning strings. Two deliberate differences:
 *
 *   - no filesystem: the JS validator resolves and reads `outputRef`
 *     evidence (and realpaths repositories for mismatch warnings) inline.
 *     Here those reads sit behind injected seams — `readEvidence` and
 *     `realpath` — which production never passes (decide is pure; the desk
 *     never dereferences a seat-claimed path). With no seams, outputRef
 *     evidence reports `unreadable` — the same warning branch the JS takes
 *     when a read fails. The parity test injects real-fs seams and proves
 *     identical verdicts against the shared fixture corpus.
 *
 *   - structured result instead of {records, errors, warnings} extraction:
 *     the desk validates a single record object, not report prose.
 */
import { isAbsolute, win32 } from "node:path";
import { sha256Hex } from "./config-view.ts";

// ---------------------------------------------------------------------------
// Vocabulary — byte-identical with src/report-records.mjs.
// ---------------------------------------------------------------------------

export const RECORD_KINDS = ["handback", "settlement"] as const;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const HANDBACK_VERDICTS = [
  "APPROVE",
  "FINDINGS",
  "BLOCKED",
  "REOPEN_REQUEST",
  "DEPENDENCY_REQUEST",
] as const;
export const SETTLEMENT_VIA = ["paseo-logs", "host-transcript", "sessions-db", "unreadable", "unchecked"] as const;
export const GIT_HEAD_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d\d-\d\dT.*Z$/u;
export const REPOSITORY_RELATIVE_PATH_PATTERN =
  /^(?=[\s\S]*\S)(?![\\/])(?![A-Za-z]:)(?![\s\S]*(?:^|[\\/])\.{2}(?:[\\/]|$))[\s\S]+$/u;

const kindSet = new Set<string>(RECORD_KINDS);
const handbackVerdicts = new Set<string>(HANDBACK_VERDICTS);

export type RecordIssue = { code: string; field?: string; message: string };

export type RecordValidation = {
  valid: boolean;
  errors: RecordIssue[];
  warnings: RecordIssue[];
};

/** Outcome of resolving and reading one outputRef under an effective
 *  repository root. `outside` mirrors the JS "resolves outside root" error;
 *  `unreadable` mirrors the JS read/realpath failure warning. */
export type EvidenceReadResult =
  | { status: "ok"; bytes: Uint8Array }
  | { status: "outside" }
  | { status: "unreadable" };

export type ReadEvidence = (repositoryRoot: string, outputRef: string) => EvidenceReadResult;
export type Realpath = (path: string) => string;

export type ValidateOptions = {
  /** Verifier-side repository override, same role as the JS `{repo}`. */
  repo?: string;
  /** Evidence reader — when omitted, every outputRef is `unreadable`. */
  readEvidence?: ReadEvidence;
  /** realpath seam for repository-mismatch warnings — when omitted, no
   *  mismatch comparison runs (the JS try/catch no-op branch). */
  realpath?: Realpath;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const absolutePath = (value: unknown): value is string => typeof value === "string" && isAbsolute(value);
const issue = (code: string, field: string | undefined, message: string): RecordIssue => ({
  code,
  ...(field ? { field } : {}),
  message,
});

/** sha256 of the evidence bytes — the JS uses package.mjs hash(); the desk
 *  equivalent is config-view's sha256Hex over the same utf8/bytes input. */
export function recomputeSha(bytes: string | Uint8Array): string {
  return sha256Hex(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
}

function validateCandidate(
  candidate: unknown,
  field: string,
  errors: RecordIssue[],
  warnings: RecordIssue[],
): void {
  if (candidate === null) return;
  if (!isObject(candidate)) {
    errors.push(issue("invalid-record", field, `${field} must be an object or null`));
    return;
  }
  if (!nonempty(candidate.repository)) errors.push(issue("invalid-record", `${field}.repository`, "repository must be a non-empty absolute path"));
  else if (!absolutePath(candidate.repository)) errors.push(issue("invalid-record", `${field}.repository`, "repository must be an absolute path"));

  const hasSnapshot = candidate.snapshotSha256 !== undefined;
  const hasHead = candidate.head !== undefined;
  if (hasSnapshot === hasHead) {
    errors.push(issue("invalid-record", field, "provide exactly one of snapshotSha256 or head"));
  }
  if (hasSnapshot && (typeof candidate.snapshotSha256 !== "string" || !SHA256_PATTERN.test(candidate.snapshotSha256))) {
    errors.push(issue("invalid-record", `${field}.snapshotSha256`, "snapshotSha256 must be a 64-character lowercase SHA-256"));
  }
  if (hasHead && (typeof candidate.head !== "string" || !GIT_HEAD_PATTERN.test(candidate.head))) {
    errors.push(issue("invalid-record", `${field}.head`, "head must be a full 40- or 64-character lowercase Git object id"));
  }
  if (candidate.incomplete !== undefined && (!Array.isArray(candidate.incomplete) || candidate.incomplete.some(item => typeof item !== "string"))) {
    errors.push(issue("invalid-record", `${field}.incomplete`, "incomplete must be an array of strings"));
  } else if ((candidate.incomplete as unknown[] | undefined)?.length) {
    warnings.push(issue("candidate-incomplete", field, "candidate has scope that is not proven clean"));
  }
}

function safeOutputRef(value: unknown): value is string {
  return typeof value === "string" && REPOSITORY_RELATIVE_PATH_PATTERN.test(value)
    && !isAbsolute(value) && !win32.isAbsolute(value);
}

function warnRepositoryMismatch(
  repository: unknown,
  field: string,
  repo: string | undefined,
  warnings: RecordIssue[],
  reported: Set<string>,
  realpath: Realpath | undefined,
): void {
  if (!absolutePath(repository) || !absolutePath(repo)) return;
  if (realpath === undefined) return;
  try {
    const declaredRoot = realpath(repository);
    const verifierRoot = realpath(repo);
    const mismatchKey = `${declaredRoot}${verifierRoot}`;
    if (declaredRoot !== verifierRoot && !reported.has(mismatchKey)) {
      warnings.push(issue("repository-mismatch", field, `${field} resolves to ${declaredRoot}, which differs from verifier --repo ${verifierRoot}; outputRef uses verifier --repo`));
      reported.add(mismatchKey);
    }
  } catch {
    // A missing root cannot be compared after realpath.
  }
}

type CheckContext = {
  repo?: string;
  recordRepository?: unknown;
  reportedRepositoryMismatches?: Set<string>;
  readEvidence?: ReadEvidence;
  realpath?: Realpath;
};

function validateChecks(checks: unknown, errors: RecordIssue[], warnings: RecordIssue[], context: CheckContext = {}): void {
  const { repo, recordRepository, reportedRepositoryMismatches = new Set(), readEvidence, realpath } = context;
  if (!Array.isArray(checks)) {
    errors.push(issue("invalid-record", "checks", "checks must be an array"));
    return;
  }
  for (const [index, check] of checks.entries()) {
    const field = `checks[${index}]`;
    if (!isObject(check)) {
      errors.push(issue("invalid-record", field, `${field} must be an object`));
      continue;
    }
    for (const key of ["cmd", "exit", "sha"]) {
      if (!Object.hasOwn(check, key)) errors.push(issue("invalid-record", `${field}.${key}`, `missing required field ${field}.${key}`));
    }
    if (!nonempty(check.cmd)) errors.push(issue("invalid-record", `${field}.cmd`, "cmd must be a non-empty string"));
    if (!Number.isInteger(check.exit)) errors.push(issue("invalid-record", `${field}.exit`, "exit must be an integer"));
    if (Object.hasOwn(check, "sha") && check.sha !== null && (typeof check.sha !== "string" || !SHA256_PATTERN.test(check.sha))) {
      errors.push(issue("invalid-record", `${field}.sha`, "sha must be a 64-character lowercase SHA-256 or null"));
    }
    if (check.output !== undefined && typeof check.output !== "string") errors.push(issue("invalid-record", `${field}.output`, "output must be a string"));
    if (check.outputRef !== undefined && !safeOutputRef(check.outputRef)) {
      errors.push(issue("invalid-record", `${field}.outputRef`, "outputRef must be a repository-relative path without parent traversal"));
    }
    if (check.candidate !== undefined) validateCandidate(check.candidate, `${field}.candidate`, errors, warnings);

    if (check.candidate !== undefined) {
      warnRepositoryMismatch(
        isObject(check.candidate) ? check.candidate.repository : undefined,
        `${field}.candidate.repository`,
        repo,
        warnings,
        reportedRepositoryMismatches,
        realpath,
      );
    }

    let evidence: Uint8Array | undefined;
    let invalidOutputRef = check.outputRef !== undefined && !safeOutputRef(check.outputRef);
    let missingReported = false;
    if (typeof check.output === "string") evidence = Buffer.from(check.output, "utf8");
    else if (check.outputRef !== undefined && safeOutputRef(check.outputRef)) {
      const candidateRepo = isObject(check.candidate) ? check.candidate.repository : undefined;
      const evidenceRepo = repo !== undefined ? repo : candidateRepo ?? recordRepository;
      if (!absolutePath(evidenceRepo)) {
        const reason = evidenceRepo === undefined
          ? "no effective repository root is available; outputRef was not read because the root is not absolute"
          : `effective repository root ${String(evidenceRepo)} is not absolute; outputRef was not read`;
        warnings.push(issue("check-evidence-missing", `${field}.outputRef`, reason));
        missingReported = true;
      } else {
        // The JS inlines realpath+resolve+bounds-check+readFileSync here;
        // the desk delegates the whole read behind the injected seam. With
        // no seam the outcome is `unreadable` — the same warning branch the
        // JS takes when a read throws.
        const result = readEvidence !== undefined
          ? readEvidence(evidenceRepo, check.outputRef)
          : { status: "unreadable" as const };
        if (result.status === "outside") {
          errors.push(issue("invalid-record", `${field}.outputRef`, "outputRef resolves outside the effective candidate repository root"));
          invalidOutputRef = true;
        } else if (result.status === "ok") {
          evidence = result.bytes;
        } else {
          warnings.push(issue("check-evidence-missing", `${field}.outputRef`, "outputRef could not be read with its effective candidate repository root"));
          missingReported = true;
        }
      }
    }

    if (!evidence && !invalidOutputRef && !missingReported) {
      const message = !Object.hasOwn(check, "sha")
        ? "sha key is missing; check evidence cannot be verified"
        : check.sha === null
          ? "sha is null; check evidence is missing"
          : "sha is present, but no readable output evidence is available to verify it";
      warnings.push(issue("check-evidence-missing", field, message));
    } else if (evidence && typeof check.sha === "string" && SHA256_PATTERN.test(check.sha)) {
      const actual = recomputeSha(evidence);
      if (actual !== check.sha) errors.push(issue("sha-mismatch", `${field}.sha`, "sha does not match output evidence"));
    } else if (evidence && !Object.hasOwn(check, "sha")) {
      warnings.push(issue("check-evidence-missing", `${field}.sha`, "output evidence is present but the sha key is missing"));
    } else if (evidence && check.sha === null) {
      warnings.push(issue("check-evidence-missing", `${field}.sha`, "output evidence is present but sha is null"));
    }
  }
}

/**
 * Validate a v1 report record — a direct port of validateRecord(). Without
 * `readEvidence`/`realpath` seams this is filesystem-free; the desk calls it
 * that way inside the pure decide.
 */
export function validateReportRecordV1(record: unknown, options: ValidateOptions = {}): RecordValidation {
  const { repo, readEvidence, realpath } = options;
  const errors: RecordIssue[] = [];
  const warnings: RecordIssue[] = [];
  if (!isObject(record)) return { valid: false, errors: [issue("invalid-record", "", "record must be an object")], warnings };
  if (!Object.hasOwn(record, "version")) errors.push(issue("invalid-record", "version", "missing required field version"));
  else if (record.version !== 1) errors.push(issue("unsupported-version", "version", "only record version 1 is supported"));
  if (!Object.hasOwn(record, "kind")) errors.push(issue("invalid-record", "kind", "missing required field kind"));
  else if (!kindSet.has(record.kind as string)) errors.push(issue("unknown-kind", "kind", `kind must be ${RECORD_KINDS.join(" or ")}`));

  if (record.kind === "handback") {
    for (const key of ["seat", "verdict", "candidate", "checks"]) {
      if (!Object.hasOwn(record, key)) errors.push(issue("invalid-record", key, `missing required field ${key}`));
    }
    if (isObject(record.seat)) {
      if (!nonempty(record.seat.role)) errors.push(issue("invalid-record", "seat.role", "seat.role must be a non-empty string"));
      if (!nonempty(record.seat.disposition)) errors.push(issue("invalid-record", "seat.disposition", "seat.disposition must be a non-empty string"));
      if (record.seat.agentId !== undefined && record.seat.agentId !== null && !nonempty(record.seat.agentId)) errors.push(issue("invalid-record", "seat.agentId", "seat.agentId must be a non-empty string or null"));
    } else if (record.seat !== undefined) errors.push(issue("invalid-record", "seat", "seat must be an object"));
    if (record.verdict !== undefined && record.verdict !== null && !handbackVerdicts.has(record.verdict as string)) {
      errors.push(issue("invalid-record", "verdict", "verdict must be APPROVE, FINDINGS, BLOCKED, REOPEN_REQUEST, DEPENDENCY_REQUEST, or null"));
    }
    const reportedRepositoryMismatches = new Set<string>();
    if (Object.hasOwn(record, "candidate")) {
      validateCandidate(record.candidate, "candidate", errors, warnings);
      warnRepositoryMismatch(
        isObject(record.candidate) ? record.candidate.repository : undefined,
        "candidate.repository",
        repo,
        warnings,
        reportedRepositoryMismatches,
        realpath,
      );
    }
    if (Object.hasOwn(record, "checks")) validateChecks(record.checks, errors, warnings, {
      repo,
      recordRepository: isObject(record.candidate) ? record.candidate.repository : undefined,
      reportedRepositoryMismatches,
      readEvidence,
      realpath,
    });
    if (record.timeline !== undefined && !isObject(record.timeline)) errors.push(issue("invalid-record", "timeline", "timeline must be an object when present"));
    if (isObject(record.timeline) && record.timeline.sessionId !== undefined && record.timeline.sessionId !== null && !nonempty(record.timeline.sessionId)) {
      errors.push(issue("invalid-record", "timeline.sessionId", "timeline.sessionId must be a non-empty string or null"));
    }
  } else if (record.kind === "settlement") {
    for (const key of ["task", "seat", "timeline", "recordedBy", "at"]) {
      if (!Object.hasOwn(record, key)) errors.push(issue("invalid-record", key, `missing required field ${key}`));
    }
    if (record.task !== undefined && record.task !== null && !nonempty(record.task)) errors.push(issue("invalid-record", "task", "task must be a non-empty issue id or assignment slug, or null"));
    if (isObject(record.seat)) {
      for (const key of ["provider", "title"]) if (!nonempty(record.seat[key])) errors.push(issue("invalid-record", `seat.${key}`, `seat.${key} must be a non-empty string`));
      if (record.seat.agentId !== undefined && record.seat.agentId !== null && !nonempty(record.seat.agentId)) errors.push(issue("invalid-record", "seat.agentId", "seat.agentId must be a non-empty string or null"));
    } else if (record.seat !== undefined) errors.push(issue("invalid-record", "seat", "seat must be an object"));
    if (isObject(record.timeline)) {
      for (const key of ["nativeHandle", "sessionId", "via", "export", "gap"]) {
        if (!Object.hasOwn(record.timeline, key)) errors.push(issue("invalid-record", `timeline.${key}`, `missing required field timeline.${key}`));
      }
      for (const key of ["nativeHandle", "sessionId"]) if (Object.hasOwn(record.timeline, key) && record.timeline[key] !== null && !nonempty(record.timeline[key])) errors.push(issue("invalid-record", `timeline.${key}`, `${key} must be a non-empty string or null`));
      if (Object.hasOwn(record.timeline, "via") && !SETTLEMENT_VIA.includes(record.timeline.via as (typeof SETTLEMENT_VIA)[number])) {
        errors.push(issue("invalid-record", "timeline.via", "timeline.via is not a supported evidence source"));
      }
      if (Object.hasOwn(record.timeline, "export") && record.timeline.export !== null) {
        const exported = record.timeline.export;
        if (!isObject(exported)) errors.push(issue("invalid-record", "timeline.export", "timeline.export must be an object or null"));
        else {
          if (!safeOutputRef(exported.path)) errors.push(issue("invalid-record", "timeline.export.path", "export path must be repository-relative"));
          if (typeof exported.sha256 !== "string" || !SHA256_PATTERN.test(exported.sha256)) errors.push(issue("invalid-record", "timeline.export.sha256", "export sha256 must be a 64-character lowercase SHA-256"));
          if (!Number.isInteger(exported.bytes) || (exported.bytes as number) < 0) errors.push(issue("invalid-record", "timeline.export.bytes", "export bytes must be a non-negative integer"));
        }
      }
      if (Object.hasOwn(record.timeline, "gap") && record.timeline.gap !== null && !nonempty(record.timeline.gap)) errors.push(issue("invalid-record", "timeline.gap", "timeline.gap must be a non-empty string or null"));
    } else if (record.timeline !== undefined) errors.push(issue("invalid-record", "timeline", "timeline must be an object"));
    if (Object.hasOwn(record, "recordedBy") && !nonempty(record.recordedBy)) errors.push(issue("invalid-record", "recordedBy", "recordedBy must be a non-empty string"));
    if (Object.hasOwn(record, "at") && (!nonempty(record.at) || !UTC_TIMESTAMP_PATTERN.test(record.at) || Number.isNaN(Date.parse(record.at)))) {
      errors.push(issue("invalid-record", "at", "at must be a valid UTC timestamp"));
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}
