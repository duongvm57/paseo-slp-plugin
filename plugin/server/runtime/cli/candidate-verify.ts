import type { Snapshot, SnapshotEntry } from './types.ts';
export interface VerifyInput {
  reportPath: string;
  repo?: string;
  paseoHome: string;
  expectParent?: string | null;
  expectWorkspace?: string | null;
  expectContract?: {
    path: string;
    sha256: string;
  };
  expectFiles?: {
    path: string;
    sha256: string;
  }[];
  expectRuntime?: string | null;
  [key: string]: unknown;
}
interface ProbeResult {
  error?: NodeJS.ErrnoException;
  signal?: string | null;
  status: number | null;
  stdout?: Buffer | null;
}
type Probe = (argv: string[]) => ProbeResult;
type ClassifiedProbe = {
  state: 'timeout';
} | {
  state: 'byte-cap';
} | {
  state: 'failed';
  detail: string;
  status?: never;
} | {
  state: 'exit';
  status: number | null;
  detail?: never;
} | {
  state: 'ok';
  stdout: Buffer;
};
interface CapturedPair {
  state: 'ok';
  snap: Snapshot;
  status: string;
}
type Capture = CapturedPair | {
  state: 'timeout';
} | {
  state: 'byte-cap';
};
type PinRead = {
  state: 'missing';
} | {
  state: 'over-cap';
} | {
  state: 'ok';
  bytes: Buffer;
};
interface VerifyInternals {
  probe?: Probe;
  readPin?: (path: string) => PinRead;
}
interface PinDeclaration {
  declared: string;
  expected: string;
  kind: string;
  absolute?: string;
}
interface GitRepository {
  commonDir: string;
  toplevel: string;
}
interface HandbackRecord {
  candidate: {
    repository: string;
    head?: string;
    snapshotSha256?: string;
    incomplete?: string[];
  } | null;
  checks: {
    cmd?: string;
    exit?: number;
  }[];
  seat: {
    agentId?: string;
    role?: string;
  };
}
interface Comparison {
  claim: unknown;
  observed: unknown;
  result: string;
  reason: string | null;
}
interface CandidateComparison {
  repository: Comparison;
  head: Comparison;
  snapshotSha256: Comparison;
  clean: Comparison;
  claimIncomplete: {
    claim: string[];
    result: string;
    reason: string;
  } | null;
}
interface ProjectedCheck {
  index: number;
  cmdSha256: string | null;
  exit: number | null | undefined;
  provenance: string;
  consistency: string;
}
interface SeatInput {
  agentId: string;
  roleClaim: string | null;
  expectParent: string | null;
  expectWorkspace: string | null;
  paseoHome: string;
  repoGit: GitRepository | null;
  captureState: string | null;
  probe: Probe;
}
interface SeatComparison {
  expected: unknown;
  observed: unknown;
  result: string;
  reason: string | null;
  relation?: string | null;
}
interface SeatObservation {
  agentId: string | null;
  result: string;
  observed: {
    provider: string | null;
    family: string | null;
    role: string | null;
    parentAgentId: string | null;
    workspaceId: string | null;
    cwd: string | null;
  } | null;
  comparisons: {
    exists: SeatComparison;
    role: SeatComparison;
    parent: SeatComparison;
    workspace: SeatComparison;
    cwd: SeatComparison | null;
  } | null;
}
import type { RuntimeError } from './types.ts';
// plugin/server/runtime/cli/candidate-verify.ts — handback-record verifier engine (P1 contract
// .local-checks/mech-p1/contract-p1.vi.md rev 5). One Interface:
// verifyHandback(input) -> view. The verifier measures a report's slp-record
// claims against the caller-pinned --repo root — the root a record declares is
// only a claim to compare, never a measurement root (X3). Every git/snapshot
// probe runs bounded in a child process with --no-optional-locks; the
// capability preflight is the single source of CAPABILITY_GAP, and after it
// every child failure is IO_FAILURE. The view is evidence, not acceptance:
// checks stay claimed, quiescence is never established.
import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hash, identity } from './package.ts';
import { extractRecords, requireRecordKind, REPOSITORY_RELATIVE_PATH_PATTERN, SHA256_PATTERN, GIT_HEAD_PATTERN } from './report-records.ts';
import { readAgentStates } from './agent-state.ts';
import { OWNED_PROVIDER_ID_RE } from "../../../shared/runtime/families.ts";

export const COMPARISON = Object.freeze(['match', 'mismatch', 'report-only', 'incomplete']);
export const REASON = Object.freeze(['timeout', 'byte-cap', 'drift', 'gitlink-non-clean', 'claim-incomplete', 'claim-unresolvable', 'seat-source-unavailable', 'agent-record-unreadable', 'duplicate-agent-records', 'not-slp-provider', 'parent-label-absent', 'cwd-not-git', 'missing', 'over-cap']);
export const RECORD_CODES = Object.freeze(['invalid-json', 'invalid-record', 'unknown-kind', 'unsupported-version', 'required-kind-missing', 'sha-mismatch', 'check-evidence-missing', 'candidate-incomplete', 'repository-mismatch', 'multiple-records', 'no-record']);
export const RECORD_VALIDATION = Object.freeze(['valid', 'invalid', 'unsupported-version', 'no-handback']);
export const CHECK_CONSISTENCY = Object.freeze(['consistent', 'inconsistent', 'unverified']);
export const SUMMARY_VALUES = Object.freeze(['match', 'mismatch', 'incomplete', 'record-invalid']);
export const COMPLETENESS_COLLECTIONS = Object.freeze(['checks', 'record.errors', 'record.warnings', 'incompletePaths', 'limitations']);
export const COMPLETENESS_REASONS = Object.freeze(['row-limit', 'field-overflow']);
export const VERIFY_ERROR_CODES = Object.freeze(['INVALID_REQUEST', 'IO_FAILURE', 'CAPABILITY_GAP']);
export const CWD_RELATIONS = Object.freeze(['same-worktree', 'other-worktree']);
// The closed §5.1 verification domain, exported so the test completeness
// oracle and every row fixture agree on the value vocabulary.
export const AXES = Object.freeze({
  S: Object.freeze(['absent', 'equal', 'different']),
  H: Object.freeze(['absent', 'equal', 'different']),
  R: Object.freeze(['absent', 'equal', 'different']),
  I: Object.freeze(['absent', 'present']),
  T: Object.freeze(['clean', 'modified-tracked', 'staged-only', 'untracked', 'deleted', 'mode-change', 'symlink-retarget', 'nested-repo-dirty', 'gitlink-non-clean']),
  C: Object.freeze(['ok', 'timeout', 'byte-cap', 'drift']),
  V: Object.freeze(['valid', 'invalid', 'unsupported-version', 'no-handback']),
  M: Object.freeze(['false', 'true']),
  K: Object.freeze(['output-consistent', 'output-inconsistent', 'outputRef-consistent', 'outputRef-inconsistent', 'outputRef-unreadable', 'no-evidence']),
  P: Object.freeze(['equal', 'different', 'missing', 'over-cap', 'drift']),
  G: Object.freeze(['all-match', 'agentId-absent', 'agent-absent', 'agent-record-unreadable', 'role-different', 'not-slp-provider', 'parent-label-absent', 'parent-different', 'no-expect-parent', 'workspace-different', 'no-expect-workspace', 'cwd-other-repo', 'cwd-worktree-same-repo', 'cwd-not-git', 'seat-source-unavailable', 'duplicate-agent-records']),
});

export const VERIFY_LIMITS = Object.freeze({
  reportMaxBytes: 1048576,
  pins: 16,
  pinMaxBytes: 16777216,
  checks: 64,
  recordCodes: 32,
  incompletePaths: 256,
  pathLen: 1024,
  limitations: 16,
  limitationLen: 160,
  completenessEntries: COMPLETENESS_COLLECTIONS.length * COMPLETENESS_REASONS.length,
  completenessCount: Number.MAX_SAFE_INTEGER,
  captureTimeoutMs: 60000,
  captureMaxBytes: 33554432,
  errorMessageLen: 512,
});

const PACKAGE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url) as import('node:url').URL);
const PACKAGE_MODULE_URL = pathToFileURL(join(PACKAGE_ROOT, 'plugin/server/runtime/cli/package.ts')).href;
const SEAT_LIMITATION = 'seat observation reads daemon files (host-internal format)';
const FIXED_LIMITATIONS = Object.freeze([
  'match means claims agree with observation at capture time; writer quiescence and write-then-restore are not observed',
  'no assignment/epoch binding: the desk ledger arrives in P2',
  'checks are claimed evidence; this view never runs a command',
  'runtime is checked only against a caller-supplied candidate hash (--expect-runtime); the pin authority is the plugin runtime-pin view',
  "the contract pin proves the hash of the caller-named file; which file governs the task is the caller's declaration",
]);
const SLP_PROVIDER_PATTERN = new RegExp(OWNED_PROVIDER_ID_RE.source, 'u');

export class VerifyError extends Error {
  declare code: string;
  constructor(code: string, message: unknown) {
    if (!VERIFY_ERROR_CODES.includes(code)) throw new Error(`unknown verify error code: ${code}`);
    super(String(message).slice(0, VERIFY_LIMITS.errorMessageLen));
    this.name = 'VerifyError';
    this.code = code;
  }
}

const invalidRequest = (message: string) => new VerifyError('INVALID_REQUEST', message);
const ioFailure = (message: string) => new VerifyError('IO_FAILURE', message);
// The single site allowed to build CAPABILITY_GAP — only the capability
// preflight may call it (rev-5 invariant for R4-M1; a test asserts there is
// exactly one construction site in this file).
const capabilityGap = (message: string) => new VerifyError('CAPABILITY_GAP', message);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const summarize = (error: unknown) => String(error instanceof Error ? (error as RuntimeError).message : error).slice(0, 160);

// Every child stdout that gets parsed is decoded UTF-8 fatal (§6.1 step 4):
// undecodable bytes are IO_FAILURE, never a silent replacement character.
const decodeUtf8 = (bytes: Uint8Array, what: string) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw ioFailure(`${what} emitted non-UTF-8 stdout`); }
};

// The bounded child-process runner: one shape for the preflight git probe,
// the snapshot child (the running Node plus this package's snapshot()), the
// git status oracle and the seat cwd probe. classifyProbe maps its result
// onto the closed §6.1 outcome set.
function defaultProbe(argv: string[]): ProbeResult {
  return spawnSync(argv[0], argv.slice(1), {
    timeout: VERIFY_LIMITS.captureTimeoutMs,
    maxBuffer: VERIFY_LIMITS.captureMaxBytes,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function classifyProbe(result: ProbeResult): ClassifiedProbe {
  if (result?.error?.code === 'ETIMEDOUT') return { state: 'timeout' };
  if (result?.error?.code === 'ENOBUFS') return { state: 'byte-cap' };
  if (!result || result.error) return { state: 'failed', detail: `spawn failed: ${result?.error?.code ?? 'no result'}` };
  if (result.signal) return { state: 'failed', detail: `killed by ${result.signal}` };
  if (result.status !== 0) return { state: 'exit', status: result.status };
  return { state: 'ok', stdout: result.stdout ?? Buffer.alloc(0) };
}

// Capability preflight — runs once after input validation and before every
// probe, including the --repo work-tree check. The only source of
// CAPABILITY_GAP: git or the running Node not executable from this process's
// PATH resolution. A git that runs but fails is IO_FAILURE, not a gap.
function capabilityPreflight(probe: Probe) {
  try { accessSync(process.execPath, constants.X_OK); }
  catch { throw capabilityGap(`the running node binary is not executable: ${process.execPath}`); }
  let result;
  try { result = probe(['git', '--no-optional-locks', '--version']); }
  catch (error) {
    if ((error as RuntimeError).code === 'ENOENT' || (error as RuntimeError).code === 'EACCES') throw capabilityGap(`git is not executable: ${(error as RuntimeError).code}`);
    throw ioFailure(`git --version probe failed: ${summarize(error)}`);
  }
  if (result.error?.code === 'ENOENT' || result.error?.code === 'EACCES') {
    throw capabilityGap(`git is not executable: ${result.error.code}`);
  }
  if (result.error || result.signal || result.status !== 0) {
    throw ioFailure(`git --version probe failed: ${summarize(result.error ?? `exit ${result.status} signal ${result.signal}`)}`);
  }
}

// The snapshot oracle runs in a bounded child built from the same Node and
// the same package root as this process — the child prints the snapshot
// payload; the parent classifies per §6.1 and validates the payload against
// the minimal shape snapshot() emits (file/symlink entries, deleted markers,
// gitlink entries with their state vocabulary).
const GITLINK_STATES = new Set(['missing', 'uninitialized', 'clean', 'dirty', 'conflicted']);
const oidOrNull = (value: unknown) => value === null || (typeof value === 'string' && GIT_HEAD_PATTERN.test(value));
function validSnapshotEntry(entry: SnapshotEntry) {
  if (!isObject(entry) || typeof entry.path !== 'string' || entry.path === '') return false;
  if ((entry as { deleted?: boolean }).deleted === true) return true;
  if (entry.kind === 'file' || entry.kind === 'symlink') {
    return Number.isInteger(entry.mode) && typeof entry.sha256 === 'string' && SHA256_PATTERN.test(entry.sha256);
  }
  if (entry.kind === 'gitlink') return oidOrNull(entry.indexOid) && oidOrNull(entry.headOid) && GITLINK_STATES.has(entry.state);
  return false;
}

function parseSnapshotPayload(stdout: Buffer) {
  let parsed: Snapshot;
  try { parsed = JSON.parse(decodeUtf8(stdout, 'snapshot probe')); }
  catch (error) {
    if (error instanceof VerifyError) throw error;
    throw ioFailure('snapshot probe emitted non-JSON output');
  }
  if (!isObject(parsed)
    || typeof parsed.sha256 !== 'string' || !SHA256_PATTERN.test(parsed.sha256)
    || !(parsed.head === null || (typeof parsed.head === 'string' && GIT_HEAD_PATTERN.test(parsed.head)))
    || !Array.isArray(parsed.files) || !parsed.files.every(validSnapshotEntry)
    || (parsed.nested !== undefined && (!Array.isArray(parsed.nested) || !parsed.nested.every(isObject)))
    || (parsed.incomplete !== undefined && (!Array.isArray(parsed.incomplete) || !parsed.incomplete.every(path => typeof path === 'string')))) {
    throw ioFailure('snapshot probe payload is missing required fields');
  }
  return parsed;
}

// git status --porcelain=v1: every line is two status characters, one space,
// then the path (rename/copied entries append ' -> orig' inside the path
// field). The v1 status set is ' ', M, T, A, D, R, C, U, ?, ! — T is a real
// typechange (file<->symlink), not noise. A trailing newline yields one
// empty tail element; anything else malformed is IO_FAILURE — partial
// output never becomes a clean oracle.
const PORCELAIN_LINE = /^[ MADTCRU?!]{2} [^\n]+$/u;
function parseStatus(stdout: Buffer) {
  const text = decodeUtf8(stdout, 'status probe');
  if (text === '') return '';
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  for (const line of body.split('\n')) {
    if (!PORCELAIN_LINE.test(line)) throw ioFailure('status probe emitted malformed porcelain output');
  }
  return text;
}

// rev-parse lines: split, drop the single trailing newline element, require
// exactly the expected non-empty lines. Extra or missing lines are IO_FAILURE;
// the caller keeps the two defined non-zero-exit exceptions (§6.1).
function parseRevParse(stdout: Buffer, what: string, expected: number) {
  const lines = decodeUtf8(stdout, what).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length !== expected || lines.some(line => line === '')) {
    throw ioFailure(`${what} returned malformed output`);
  }
  return lines;
}

function capturePair(repoReal: string, probe: Probe): Capture {
  const script = `import { snapshot } from ${JSON.stringify(PACKAGE_MODULE_URL)};\nprocess.stdout.write(JSON.stringify(snapshot(${JSON.stringify(repoReal)})));`;
  const snap = classifyProbe(probe([process.execPath, '--input-type=module', '-e', script]));
  if (snap.state === 'failed' || snap.state === 'exit') throw ioFailure(`snapshot probe failed: ${snap.detail ?? `exit ${snap.status}`}`);
  if (snap.state !== 'ok') return snap;
  const snapParsed = parseSnapshotPayload(snap.stdout);
  const status = classifyProbe(probe(['git', '--no-optional-locks', '-C', repoReal, 'status', '--porcelain=v1', '--untracked-files=all']));
  if (status.state === 'failed' || status.state === 'exit') throw ioFailure(`status probe failed: ${status.detail ?? `exit ${status.status}`}`);
  if (status.state !== 'ok') return status;
  return { state: 'ok', snap: snapParsed, status: parseStatus(status.stdout) };
}

const pairsEqual = (a: CapturedPair, b: CapturedPair) => a.snap.sha256 === b.snap.sha256 && a.snap.head === b.snap.head
  && a.status === b.status;

// One bounded read of a pin file — over-cap is decided on fstat so a giant
// file is never read past pinMaxBytes.
function readPinOnce(path: string): PinRead {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return { state: 'missing' }; }
  try {
    const { size } = fstatSync(fd);
    if (size > VERIFY_LIMITS.pinMaxBytes) return { state: 'over-cap' };
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) offset += readSync(fd, bytes, offset, size - offset, offset);
    return { state: 'ok', bytes };
  } catch { return { state: 'missing' }; }
  finally { closeSync(fd); }
}

function validateRead(read: PinRead, path: string) {
  if (!isObject(read) || !['ok', 'missing', 'over-cap'].includes(read.state)
    || (read.state === 'ok' && !Buffer.isBuffer(read.bytes))) {
    throw ioFailure(`pin read for ${path} returned an unknown result`);
  }
  return read;
}

function pinResult(declared: string, expected: string, first: PinRead, second: PinRead) {
  if (first.state === 'missing' || second.state === 'missing') {
    return { path: declared, expected, observed: null, result: 'incomplete', reason: 'missing' };
  }
  if (first.state === 'over-cap' || second.state === 'over-cap') {
    return { path: declared, expected, observed: null, result: 'incomplete', reason: 'over-cap' };
  }
  if (!first.bytes.equals(second.bytes)) {
    return { path: declared, expected, observed: null, result: 'incomplete', reason: 'drift' };
  }
  const observed = hash(first.bytes);
  return { path: declared, expected, observed, result: observed === expected ? 'match' : 'mismatch', reason: null };
}

// A pin path must be lexically inside --repo and its realpath (of the nearest
// existing ancestor when the file itself is absent) must not escape the
// realpath'd root — an escape is the caller's input error, not a missing pin.
function resolvePinPath(repoReal: string, declared: string) {
  const absolute = resolve(repoReal, declared);
  const rel = relative(repoReal, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw invalidRequest(`pin path resolves to the repository root itself or escapes it: ${declared}`);
  }
  let probe = absolute;
  for (;;) {
    try {
      const real = realpathSync(probe);
      const inside = relative(repoReal, real);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        throw invalidRequest(`pin path escapes the repository root: ${declared}`);
      }
      return absolute;
    } catch (error) {
      if (error instanceof VerifyError) throw error;
      if ((error as RuntimeError).code !== 'ENOENT' && (error as RuntimeError).code !== 'ENOTDIR') {
        throw invalidRequest(`pin path cannot be resolved: ${declared}`);
      }
      const parent = dirname(probe);
      if (parent === probe) throw invalidRequest(`pin path escapes the repository root: ${declared}`);
      probe = parent;
    }
  }
}

const isAbsoluteString = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value);

function validatePin(pin: unknown, field: string) {
  if (!isObject(pin)) throw invalidRequest(`${field} must be an object {path, sha256}`);
  for (const key of Object.keys(pin)) {
    if (key !== 'path' && key !== 'sha256') throw invalidRequest(`${field} has unknown key ${key}`);
  }
  if (typeof pin.path !== 'string' || !REPOSITORY_RELATIVE_PATH_PATTERN.test(pin.path)) {
    throw invalidRequest(`${field}.path must match REPOSITORY_RELATIVE_PATH_PATTERN`);
  }
  if (typeof pin.sha256 !== 'string' || !SHA256_PATTERN.test(pin.sha256)) {
    throw invalidRequest(`${field}.sha256 must be a 64-character lowercase sha256`);
  }
  return { path: pin.path, sha256: pin.sha256 };
}

const INPUT_KEYS = Object.freeze(['reportPath', 'repo', 'paseoHome', 'expectParent', 'expectWorkspace', 'expectContract', 'expectFiles', 'expectRuntime']);

function validateInput(input: VerifyInput) {
  if (!isObject(input)) throw invalidRequest('input must be an object');
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.includes(key)) throw invalidRequest(`input has unknown key ${key}`);
  }
  for (const key of ['reportPath', 'repo', 'paseoHome'] as const) {
    if (!isAbsoluteString(input[key])) throw invalidRequest(`${key} must be an absolute path`);
  }
  for (const key of ['expectParent', 'expectWorkspace'] as const) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') {
      throw invalidRequest(`${key} must be a string or null`);
    }
  }
  if (input.expectContract === undefined) throw invalidRequest('expectContract is required');
  const expectContract = validatePin(input.expectContract, 'expectContract');
  const expectFiles = input.expectFiles === undefined ? [] : input.expectFiles;
  if (!Array.isArray(expectFiles) || expectFiles.length > VERIFY_LIMITS.pins) {
    throw invalidRequest(`expectFiles must be an array of at most ${VERIFY_LIMITS.pins} pins`);
  }
  if (input.expectRuntime !== undefined && input.expectRuntime !== null
    && (typeof input.expectRuntime !== 'string' || !SHA256_PATTERN.test(input.expectRuntime))) {
    throw invalidRequest('expectRuntime must be a 64-character lowercase sha256');
  }
  return {
    reportPath: input.reportPath,
    repo: input.repo,
    paseoHome: input.paseoHome,
    expectParent: input.expectParent ?? null,
    expectWorkspace: input.expectWorkspace ?? null,
    expectContract,
    expectFiles: expectFiles.map((pin, index) => validatePin(pin, `expectFiles[${index}]`)),
    expectRuntime: input.expectRuntime ?? null,
  };
}

// Completeness ledger (P0 CompletenessLedger precedent): one entry per
// (collection, reason) pair in enum order, raw-or-elide drops counted, and
// the conservation law emitted + Σcount == source is checked for every
// collection before the view is emitted — a violation is IO_FAILURE.
function completenessLedger() {
  const counts = new Map<string, number>();
  const source = new Map<string, number>();
  const emitted = new Map<string, number>();
  const drop = (collection: string, reason: string) => {
    if (!COMPLETENESS_COLLECTIONS.includes(collection) || !COMPLETENESS_REASONS.includes(reason)) {
      throw ioFailure(`completeness drop outside the closed vocabulary: ${collection}/${reason}`);
    }
    const key = `${collection}${reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const cap = <T>(collection: string, items: T[], rowCap: number, fieldOf?: (item: T) => unknown, fieldCap?: number): T[] => {
    const out = [];
    for (const item of items) {
      const field = fieldOf ? fieldOf(item) : undefined;
      if (typeof field === 'string' && field.length > fieldCap!) { drop(collection, 'field-overflow'); continue; }
      if (out.length >= rowCap) { drop(collection, 'row-limit'); continue; }
      out.push(item);
    }
    source.set(collection, (source.get(collection) ?? 0) + items.length);
    emitted.set(collection, (emitted.get(collection) ?? 0) + out.length);
    return out;
  };
  const entries = () => {
    for (const collection of COMPLETENESS_COLLECTIONS) {
      const dropped = COMPLETENESS_REASONS.reduce((sum, reason) => sum + (counts.get(`${collection}${reason}`) ?? 0), 0);
      if ((emitted.get(collection) ?? 0) + dropped !== (source.get(collection) ?? 0)) {
        throw ioFailure(`completeness ledger broke conservation on '${collection}'`);
      }
    }
    const entries = [];
    for (const collection of COMPLETENESS_COLLECTIONS) {
      for (const reason of COMPLETENESS_REASONS) {
        const count = counts.get(`${collection}${reason}`) ?? 0;
        if (count > 0) entries.push({ collection, reason, count });
      }
    }
    if (entries.length > VERIFY_LIMITS.completenessEntries || new Set(entries.map(e => `${e.collection}${e.reason}`)).size !== entries.length) {
      throw ioFailure('completeness entries exceed the derived cap');
    }
    if (entries.some(e => !Number.isInteger(e.count) || e.count < 1 || e.count > VERIFY_LIMITS.completenessCount)) {
      throw ioFailure('completeness entry count out of range');
    }
    return entries;
  };
  return { cap, entries };
}

export async function verifyHandback(input: VerifyInput, internals: VerifyInternals = {}) {
  try {
    return run(input, internals);
  } catch (error) {
    if (error instanceof VerifyError) throw error;
    // Any non-VerifyError escaping the engine is a producer failure, not a
    // caller error — wrap it rather than leak an untyped throw.
    throw ioFailure(`verifier internal failure: ${summarize(error)}`);
  }
}

function run(input: VerifyInput, internals: VerifyInternals) {
  const probe = typeof internals.probe === 'function' ? internals.probe : defaultProbe;
  const readPin = typeof internals.readPin === 'function' ? internals.readPin : readPinOnce;
  const request = validateInput(input);

  let reportBytes;
  try { reportBytes = readFileSync(request.reportPath); }
  catch (error) { throw invalidRequest(`report cannot be read: ${summarize(error)}`); }
  if (reportBytes.length > VERIFY_LIMITS.reportMaxBytes) throw invalidRequest(`report exceeds ${VERIFY_LIMITS.reportMaxBytes} bytes`);
  let reportText;
  try { reportText = new TextDecoder('utf-8', { fatal: true }).decode(reportBytes); }
  catch { throw invalidRequest('report is not valid UTF-8'); }

  let repoReal;
  try { repoReal = realpathSync(request.repo!); }
  catch (error) { throw invalidRequest(`--repo does not resolve: ${summarize(error)}`); }

  // Pin paths are caller input: normalize, dedupe against the contract pin
  // and each other, and prove realpath containment before any probe runs.
  const pinDecl: PinDeclaration[] = [{ declared: request.expectContract.path, expected: request.expectContract.sha256, kind: 'contract' }];
  for (const pin of request.expectFiles) pinDecl.push({ declared: pin.path, expected: pin.sha256, kind: 'file' });
  const seen = new Set();
  for (const pin of pinDecl) {
    pin.absolute = resolvePinPath(repoReal, pin.declared);
    const key = relative(repoReal, pin.absolute!);
    if (seen.has(key)) throw invalidRequest(`duplicate pin path: ${pin.declared}`);
    seen.add(key);
  }
  const contractAbs = pinDecl[0].absolute;

  capabilityPreflight(probe);

  // The --repo validation probe — the only probe whose non-zero exit maps to
  // INVALID_REQUEST (§6.1 exception a). A timeout/byte-cap here degrades the
  // whole observation the same way a failed capture does.
  const repoProbe = classifyProbe(probe(['git', '--no-optional-locks', '-C', repoReal, 'rev-parse', '--is-inside-work-tree', '--git-common-dir', '--show-toplevel']));
  let repoGit: GitRepository | null = null;
  let captureState: string | null = null;
  if (repoProbe.state === 'exit') throw invalidRequest(`--repo is not a git work tree (exit ${repoProbe.status})`);
  if (repoProbe.state === 'failed') throw ioFailure(`repo probe failed: ${repoProbe.detail}`);
  if (repoProbe.state === 'timeout' || repoProbe.state === 'byte-cap') captureState = repoProbe.state;
  else {
    // §6.1 exception (a): a first line that is not 'true' is the caller's bad
    // input; once 'true' is read the output must be exactly the expected lines.
    const firstLine = decodeUtf8(repoProbe.stdout, 'repo probe').split('\n', 1)[0];
    if (firstLine !== 'true') throw invalidRequest('--repo is not a git work tree');
    const lines = parseRevParse(repoProbe.stdout, 'repo probe', 3);
    try {
      repoGit = { commonDir: realpathSync(resolve(repoReal, lines[1])), toplevel: realpathSync(resolve(repoReal, lines[2])) };
    } catch (error) { throw ioFailure(`repo probe paths unresolvable: ${summarize(error)}`); }
  }

  // Pins are read twice: once before the first capture and once after the
  // last, so bytes that changed mid-measurement read as drift.
  const pinFirst = pinDecl.map(pin => validateRead(readPin(pin.absolute!), pin.declared));

  let pair: CapturedPair | null = null;
  let captures = 0;
  if (captureState === null) {
    const first = capturePair(repoReal, probe);
    captures += 1;
    if (first.state === 'ok') pair = first;
    else captureState = first.state;
  }

  // Report parse sits between the two captures — the measurement window
  // brackets the record interpretation (§6.1 double capture).
  const parsed = requireRecordKind(extractRecords(reportText, { repo: repoReal }), 'handback');
  const issueCodes = [...parsed.errors, ...parsed.warnings].map(item => item.code);
  const recordCodeSet = new Set(RECORD_CODES);
  for (const code of issueCodes) {
    if (!recordCodeSet.has(code)) throw ioFailure(`parser emitted an unknown record code: ${code}`);
  }
  const hasCode = (code: string) => issueCodes.includes(code);
  const validation = hasCode('required-kind-missing') || hasCode('no-record') ? 'no-handback'
    : hasCode('invalid-json') || hasCode('invalid-record') || hasCode('unknown-kind') ? 'invalid'
    : hasCode('unsupported-version') ? 'unsupported-version' : 'valid';
  const selected = parsed.records.find(entry => entry.selected && (entry.record as { kind?: string } | null)?.kind === 'handback') ?? null;
  const multiple = parsed.records.filter(entry => (entry.record as { kind?: string } | null)?.kind === 'handback').length > 1;
  const record = validation === 'valid' ? selected!.record as HandbackRecord : null;

  if (pair !== null) {
    const second = capturePair(repoReal, probe);
    captures += 1;
    if (second.state !== 'ok') { captureState = second.state; pair = null; }
    else if (!pairsEqual(pair, second)) {
      const third = capturePair(repoReal, probe);
      captures += 1;
      if (third.state !== 'ok') { captureState = third.state; pair = null; }
      else if (!pairsEqual(second, third)) { captureState = 'drift'; pair = null; }
      else pair = third;
    }
  }
  const captureDegraded = captureState !== null;
  const snapshotIncomplete = pair?.snap.incomplete ?? [];
  const gitlinkDirty = snapshotIncomplete.length > 0;

  const pinSecond = pinDecl.map(pin => validateRead(readPin(pin.absolute!), pin.declared));
  const pinsResolved = pinDecl.map((pin, index) => pinResult(pin.declared, pin.expected, pinFirst[index], pinSecond[index]));
  const contractResult = pinsResolved[0];
  const pinResults = pinsResolved.slice(1);

  const ledger = completenessLedger();

  const rawIncompletePaths = pair === null ? [] : snapshotIncomplete;
  let pathsElided = false;
  const incompletePaths = ledger.cap('incompletePaths', rawIncompletePaths, VERIFY_LIMITS.incompletePaths, p => p, VERIFY_LIMITS.pathLen);
  pathsElided = rawIncompletePaths.length !== incompletePaths.length;

  const observation = {
    head: pair?.snap.head ?? null,
    snapshotSha256: pair?.snap.sha256 ?? null,
    clean: pair === null ? null : pair.status.length > 0 ? false : gitlinkDirty ? null : true,
    incompletePaths,
    nestedCount: pair?.snap.nested?.length ?? 0,
    captures,
    state: captureDegraded || gitlinkDirty || pathsElided ? 'incomplete' : 'complete',
    reason: captureState ?? (gitlinkDirty || pathsElided ? 'gitlink-non-clean' : null),
  };

  const comparison = (claim: unknown, observed: unknown, result: string, reason: string | null) => ({ claim: claim ?? null, observed: observed ?? null, result, reason });

  let candidate: CandidateComparison | null = null;
  let checks: ProjectedCheck[] = [];
  let seat: SeatObservation | null = null;
  let seatRead = false;
  if (record !== null) {
    if (isObject(record.candidate)) {
      const claim = record.candidate;
      let claimReal = null;
      try { claimReal = realpathSync(claim.repository); } catch { /* unresolvable claim */ }
      const repository = comparison(claim.repository, repoReal,
        claimReal === null ? 'mismatch' : claimReal === repoReal ? 'match' : 'mismatch',
        claimReal === null ? 'claim-unresolvable' : null);
      const degraded = (claimValue: unknown) => comparison(claimValue, null, 'incomplete', captureState);
      const head = claim.head === undefined
        ? comparison(null, observation.head, 'report-only', null)
        : captureDegraded ? degraded(claim.head)
        : comparison(claim.head, observation.head, claim.head === observation.head ? 'match' : 'mismatch', null);
      const snapshotSha256 = claim.snapshotSha256 === undefined
        ? comparison(null, observation.snapshotSha256, 'report-only', null)
        : captureDegraded ? degraded(claim.snapshotSha256)
        : gitlinkDirty ? comparison(claim.snapshotSha256, observation.snapshotSha256, 'incomplete', 'gitlink-non-clean')
        : comparison(claim.snapshotSha256, observation.snapshotSha256, claim.snapshotSha256 === observation.snapshotSha256 ? 'match' : 'mismatch', null);
      const cleanClaim = claim.head !== undefined && claim.snapshotSha256 === undefined;
      const clean = !cleanClaim
        ? comparison(null, observation.clean, 'report-only', null)
        : captureDegraded ? comparison(true, null, 'incomplete', captureState)
        : observation.clean === null ? comparison(true, null, 'incomplete', 'gitlink-non-clean')
        : comparison(true, observation.clean, observation.clean ? 'match' : 'mismatch', null);
      const claimIncomplete = Array.isArray(claim.incomplete) && claim.incomplete.length > 0
        ? { claim: claim.incomplete, result: 'incomplete', reason: 'claim-incomplete' }
        : null;
      candidate = { repository, head, snapshotSha256, clean, claimIncomplete };
    }

    const checkIssues = new Map<number, { mismatch: boolean; missing: boolean }>();
    if (Array.isArray(record.checks)) {
      for (const issueItem of [...parsed.errors, ...parsed.warnings]) {
        if (issueItem.blockIndex !== selected!.blockIndex) continue;
        const match = /^checks\[(\d+)\]/u.exec(issueItem.field ?? '');
        if (!match) continue;
        const index = Number(match[1]);
        const entry = checkIssues.get(index) ?? { mismatch: false, missing: false };
        if (issueItem.code === 'sha-mismatch') entry.mismatch = true;
        if (issueItem.code === 'check-evidence-missing') entry.missing = true;
        checkIssues.set(index, entry);
      }
    }
    const projected = (Array.isArray(record.checks) ? record.checks : []).map((check, index) => {
      const flags = checkIssues.get(index);
      return {
        index,
        cmdSha256: typeof check.cmd === 'string' ? hash(Buffer.from(check.cmd, 'utf8')) : null,
        exit: Number.isInteger(check.exit) ? check.exit : null,
        provenance: 'claimed',
        consistency: flags?.mismatch ? 'inconsistent' : flags?.missing ? 'unverified' : 'consistent',
      };
    });
    checks = ledger.cap('checks', projected, VERIFY_LIMITS.checks);

    const agentId = typeof record.seat?.agentId === 'string' && record.seat.agentId ? record.seat.agentId : null;
    if (agentId !== null) {
      seatRead = true;
      seat = observeSeat({ agentId, roleClaim: typeof record.seat?.role === 'string' ? record.seat.role : null, expectParent: request.expectParent, expectWorkspace: request.expectWorkspace, paseoHome: request.paseoHome, repoGit, captureState, probe });
    } else {
      seat = { agentId: null, result: 'report-only', observed: null, comparisons: null };
    }
  }

  const recordErrors = ledger.cap('record.errors', parsed.errors.map(item => ({ code: item.code, blockIndex: Number.isInteger(item.blockIndex) ? item.blockIndex : null })), VERIFY_LIMITS.recordCodes);
  const recordWarnings = ledger.cap('record.warnings', parsed.warnings.map(item => ({ code: item.code, blockIndex: Number.isInteger(item.blockIndex) ? item.blockIndex : null })), VERIFY_LIMITS.recordCodes);

  const limitations = ledger.cap('limitations', seatRead ? [...FIXED_LIMITATIONS, SEAT_LIMITATION] : [...FIXED_LIMITATIONS], VERIFY_LIMITS.limitations, l => l, VERIFY_LIMITS.limitationLen);

  // Runtime measurement (P2-b amend): identity() is a local measurement with
  // no incomplete branch — a throw is IO_FAILURE, and a null expectation is
  // report-only (the P1 behavior) rather than a comparison.
  let runtimeSha256;
  try { runtimeSha256 = identity(PACKAGE_ROOT).sha256; }
  catch (error) { throw ioFailure(`runtime identity measurement failed: ${summarize(error)}`); }
  const runtime = {
    expected: request.expectRuntime,
    observed: runtimeSha256,
    result: request.expectRuntime === null ? 'report-only'
      : request.expectRuntime === runtimeSha256 ? 'match' : 'mismatch',
    reason: null,
  };

  // summary is a fold, never a verdict (§5.3): record-invalid wins first,
  // then any mismatch or inconsistent check, then any incomplete.
  const outcomes = [];
  if (candidate !== null) {
    for (const field of ['repository', 'head', 'snapshotSha256', 'clean'] as const) outcomes.push(candidate[field].result);
    if (candidate.claimIncomplete !== null) outcomes.push('incomplete');
  }
  if (seat !== null && seat.result !== 'report-only') outcomes.push(seat.result);
  outcomes.push(contractResult.result);
  for (const pin of pinResults) outcomes.push(pin.result);
  outcomes.push(runtime.result);
  const conclusive = outcomes.filter(result => result === 'mismatch' || result === 'incomplete' || result === 'match');
  const summary = validation !== 'valid' ? 'record-invalid'
    : conclusive.includes('mismatch') || checks.some(check => check.consistency === 'inconsistent') ? 'mismatch'
    : conclusive.includes('incomplete') || observation.state === 'incomplete' ? 'incomplete'
    : 'match';

  return {
    schemaVersion: 1,
    kind: 'slp-verify-handback',
    generatedAt: new Date().toISOString(),
    measurement: {
      snapshotAlgorithm: 'slp-snapshot/package.mjs',
      packageRoot: realpathSync(PACKAGE_ROOT),
      runtimeSha256,
      runtime,
    },
    input: {
      reportSha256: hash(reportBytes),
      reportBytes: reportBytes.length,
      repo: repoReal,
      paseoHome: request.paseoHome,
      expect: {
        parent: request.expectParent,
        workspace: request.expectWorkspace,
        contract: { path: request.expectContract.path, sha256: request.expectContract.sha256 },
        files: request.expectFiles.length,
      },
    },
    record: {
      validation,
      selectedBlockIndex: selected?.blockIndex ?? null,
      multiple,
      errors: recordErrors,
      warnings: recordWarnings,
    },
    observation,
    candidate,
    checks,
    seat,
    contract: contractResult,
    pins: pinResults,
    summary,
    limitations,
    completeness: ledger.entries(),
    quiescence: 'not-established-by-this-view',
    acceptance: 'not-established-by-this-view',
  };
}

// The X6 seat observation, width A: only the record-named agentId is
// resolved, and only through daemon-owned state files under paseoHome. The
// ladder is fail-closed — an unreadable source degrades every comparison to
// incomplete with its reason, never to a fabricated absence or presence.
function observeSeat({ agentId, roleClaim, expectParent, expectWorkspace, paseoHome, repoGit, captureState, probe }: SeatInput): SeatObservation {
  const cmp = (expected: unknown, observed: unknown, result: string, reason: string | null, extra?: { relation: string | null }): SeatComparison => ({ expected: expected ?? null, observed: observed ?? null, result, reason, ...(extra ?? {}) });
  const allIncomplete = (reason: string) => ({
    exists: cmp(agentId, null, 'incomplete', reason),
    role: cmp(roleClaim, null, 'incomplete', reason),
    parent: cmp(expectParent, null, 'incomplete', reason),
    workspace: cmp(expectWorkspace, null, 'incomplete', reason),
    cwd: cmp(repoGit?.commonDir ?? null, null, 'incomplete', reason, { relation: null }),
  });
  const reportOnlyRest = () => ({
    role: cmp(roleClaim, null, 'report-only', null),
    parent: cmp(expectParent, null, 'report-only', null),
    workspace: cmp(expectWorkspace, null, 'report-only', null),
    cwd: cmp(repoGit?.commonDir ?? null, null, 'report-only', null, { relation: null }),
  });

  const agentsDir = join(paseoHome, 'agents');
  let groups;
  try { groups = readdirSync(agentsDir); }
  catch { return { agentId, result: 'incomplete', observed: null, comparisons: allIncomplete('seat-source-unavailable') }; }

  // Independent file enumeration first — a matching <agentId>.json that the
  // oracle cannot parse is 'agent-record-unreadable', not 'agent-absent'.
  let files = 0;
  for (const group of groups) {
    const groupDir = join(agentsDir, group);
    try {
      if (!lstatSync(groupDir).isDirectory()) continue;
      if (readdirSync(groupDir).includes(`${agentId}.json`)) files += 1;
    } catch { /* broken groups are skipped like the oracle skips them */ }
  }
  if (files === 0) {
    return {
      agentId, result: 'mismatch', observed: null,
      comparisons: { exists: cmp(agentId, null, 'mismatch', null), ...reportOnlyRest() },
    };
  }

  let matches;
  try { matches = readAgentStates(paseoHome).filter(state => state.id === agentId); }
  catch (error) { throw ioFailure(`seat oracle readAgentStates failed: ${summarize(error)}`); }
  if (matches.length === 0) {
    return { agentId, result: 'incomplete', observed: null, comparisons: allIncomplete('agent-record-unreadable') };
  }
  if (matches.length > 1) {
    return { agentId, result: 'incomplete', observed: null, comparisons: allIncomplete('duplicate-agent-records') };
  }

  const state = matches[0];
  const provider = typeof state.provider === 'string' ? state.provider : null;
  const providerMatch = provider === null ? null : SLP_PROVIDER_PATTERN.exec(provider);
  const observedRole = providerMatch?.[2] ?? null;
  const labels = isObject(state.labels) ? state.labels : {};
  const parentLabel = typeof labels['paseo.parent-agent-id'] === 'string' ? labels['paseo.parent-agent-id'] : null;
  const workspaceId = typeof state.workspaceId === 'string' ? state.workspaceId : null;
  const cwd = typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : null;

  const comparisons: NonNullable<SeatObservation['comparisons']> = {
    exists: cmp(agentId, state.id, 'match', null),
    role: providerMatch === null
      ? cmp(roleClaim, observedRole, 'mismatch', 'not-slp-provider')
      : cmp(roleClaim, observedRole, observedRole === roleClaim ? 'match' : 'mismatch', null),
    parent: expectParent === null
      ? cmp(null, parentLabel, 'report-only', null)
      : parentLabel === null
        ? cmp(expectParent, null, 'incomplete', 'parent-label-absent')
        : cmp(expectParent, parentLabel, parentLabel === expectParent ? 'match' : 'mismatch', null),
    workspace: expectWorkspace === null
      ? cmp(null, workspaceId, 'report-only', null)
      : cmp(expectWorkspace, workspaceId, workspaceId !== null && workspaceId === expectWorkspace ? 'match' : 'mismatch', null),
    cwd: null,
  };

  if (captureState !== null) {
    // C ≠ ok: the repo-side measurement is degraded, so the cwd comparison is
    // incomplete with the capture reason — the cwd probe is not even run
    // (§5.3: seat.cwd inherits the capture axis's reason).
    comparisons.cwd = cmp(repoGit?.commonDir ?? null, null, 'incomplete', captureState, { relation: null });
  } else if (repoGit === null) {
    comparisons.cwd = cmp(null, null, 'incomplete', 'cwd-not-git', { relation: null });
  } else if (cwd === null) {
    comparisons.cwd = cmp(repoGit.commonDir, null, 'incomplete', 'cwd-not-git', { relation: null });
  } else {
    let isDir = false;
    try { isDir = lstatSync(cwd).isDirectory(); } catch { /* absent or unreadable */ }
    if (!isDir) {
      comparisons.cwd = cmp(repoGit.commonDir, null, 'incomplete', 'cwd-not-git', { relation: null });
    } else {
      const cwdProbe = classifyProbe(probe(['git', '--no-optional-locks', '-C', cwd, 'rev-parse', '--git-common-dir', '--show-toplevel']));
      if (cwdProbe.state === 'failed') throw ioFailure(`seat cwd probe failed: ${cwdProbe.detail}`);
      if (cwdProbe.state === 'timeout' || cwdProbe.state === 'byte-cap') {
        comparisons.cwd = cmp(repoGit.commonDir, null, 'incomplete', cwdProbe.state, { relation: null });
      } else if (cwdProbe.state === 'exit') {
        comparisons.cwd = cmp(repoGit.commonDir, null, 'incomplete', 'cwd-not-git', { relation: null });
      } else {
        const lines = parseRevParse(cwdProbe.stdout, 'seat cwd probe', 2);
        let commonDir, toplevel;
        try {
          commonDir = realpathSync(resolve(cwd, lines[0]));
          toplevel = realpathSync(resolve(cwd, lines[1]));
        } catch (error) { throw ioFailure(`seat cwd probe paths unresolvable: ${summarize(error)}`); }
        comparisons.cwd = commonDir === repoGit.commonDir
          ? cmp(repoGit.commonDir, commonDir, 'match', null, { relation: toplevel === repoGit.toplevel ? 'same-worktree' : 'other-worktree' })
          : cmp(repoGit.commonDir, commonDir, 'mismatch', null, { relation: null });
      }
    }
  }

  const results = Object.values(comparisons).map(entry => entry!.result);
  const result = results.includes('mismatch') ? 'mismatch' : results.includes('incomplete') ? 'incomplete' : 'match';
  return {
    agentId,
    result,
    observed: { provider, family: providerMatch?.[1] ?? null, role: observedRole, parentAgentId: parentLabel, workspaceId, cwd },
    comparisons,
  };
}
