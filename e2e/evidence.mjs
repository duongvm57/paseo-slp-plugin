import { basename, relative, resolve, isAbsolute } from 'node:path';
import { hash } from '../plugin/server/runtime/cli/package.ts';

// One contract per evidence kind. The ledger keeps a registry; it does not know
// what a Paseo coordinator transcript or a host resource inventory looks like.
// Bumped whenever any validator below changes meaning.
export const evidenceVersion = 5;

const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function within(parent, path) {
  const value = relative(parent, path);
  return value === '' || (!value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && value !== '..' && !isAbsolute(value));
}

function containsValue(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some(item => containsValue(item, expected));
  return value !== null && typeof value === 'object'
    && Object.values(value).some(item => containsValue(item, expected));
}

function validCoordinatorTranscript(bytes, { operatorId, runDirectory } = {}) {
  const payload = JSON.parse(bytes);
  if (payload?.operatorId !== operatorId || !nonempty(payload?.sessionId)
      || !nonempty(payload?.source) || !nonempty(payload?.transcript)) return false;
  if (runDirectory && within(runDirectory, resolve(payload.source))) return false;
  if (!basename(payload.source).includes(payload.sessionId)) return false;
  if (hash(Buffer.from(payload.transcript)) !== payload.transcriptSha256) return false;
  const records = payload.transcript.trim().split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  return records.length > 0
    && records.every(record => record !== null && typeof record === 'object' && !Array.isArray(record))
    && records.some(record => containsValue(record, payload.sessionId));
}

function resourceSettlementShape(bytes) {
  const payload = JSON.parse(bytes);
  return payload?.version === 1 && nonempty(payload?.capturedAt)
    && payload.workspace !== null && typeof payload.workspace === 'object' && nonempty(payload.workspace.status)
    && Array.isArray(payload.taskActors)
    && payload.settlement !== null && typeof payload.settlement === 'object'
    && nonempty(payload.settlement.observed)
    && Array.isArray(payload.settlement.actions)
    && Array.isArray(payload.settlement.unresolved);
}

function settledResources(bytes) {
  if (!resourceSettlementShape(bytes)) return false;
  const payload = JSON.parse(bytes);
  if (payload.settlement.unresolved.length > 0) return false;
  if (payload.taskActors.length === 0) {
    return payload.settlement.noActorsCreated === true && nonempty(payload.settlement.noActorsReason);
  }
  // A live-sounding label is not a terminal state, and neither is one the host
  // never declared: every status segment must name a terminal state.
  return payload.taskActors.every(actor => nonempty(actor?.id) && nonempty(actor?.role)
    && nonempty(actor?.status) && Array.isArray(actor.pendingPermissions)
    && actor.pendingPermissions.length === 0
    && actor.status.toLowerCase().split(/[\s/_,-]+/).every(segment => terminalActorStatus.has(segment)));
}

const terminalActorStatus = new Set(['idle', 'closed', 'completed', 'finished', 'failed', 'error',
  'stopped', 'archived', 'exited', 'retained', 'interrupted', 'cancelled', 'canceled', 'settled', 'done', 'terminated']);

// A checks receipt names each verification command and its real exit status, so
// the outcome criterion rests on recorded runs rather than a success narrative.
// A failing baseline keeps its nonzero exitCode: the receipt proves the check
// ran, not that it passed.
function checksReceipt(bytes) {
  const payload = JSON.parse(bytes);
  return Array.isArray(payload?.checks) && payload.checks.length > 0
    && payload.checks.every(entry => entry !== null && typeof entry === 'object'
      && nonempty(entry.command) && Number.isInteger(entry.exitCode));
}

// An interventions receipt is the explicit ledger U5 stands on: every stimulus,
// assistance and decision with its time, plus totals — so "no interventions" is
// a recorded claim, not an absent file.
function interventionsReceipt(bytes) {
  const payload = JSON.parse(bytes);
  return Array.isArray(payload?.interventions)
    && payload.interventions.every(entry => entry !== null && typeof entry === 'object'
      && nonempty(entry.at) && nonempty(entry.action))
    && Number.isInteger(payload.assistanceCount) && payload.assistanceCount >= 0
    && Object.hasOwn(payload, 'durationSeconds')
    && (payload.durationSeconds === null || Number.isFinite(payload.durationSeconds));
}

const capturedBytes = bytes => bytes.length > 0;
// accept: gate at collection time, with the message a coordinator sees.
// satisfies: does this payload actually discharge its kind's requirement at seal time.
const registry = {
  preflight: { satisfies: capturedBytes },
  launch: { satisfies: capturedBytes },
  instructions: { satisfies: capturedBytes },
  timeline: { satisfies: capturedBytes },
  coordinator: {
    accept: validCoordinatorTranscript,
    message: 'Coordinator transcript must contain nonempty JSONL object records and the native session marker',
    satisfies: validCoordinatorTranscript,
    // A self-authored envelope can satisfy every payload rule; only the
    // dedicated capture verifies the native source exists outside the run.
    sourceVerified: true,
  },
  artifacts: { satisfies: capturedBytes },
  checks: { satisfies: checksReceipt },
  interventions: { satisfies: interventionsReceipt },
  resources: {
    accept: resourceSettlementShape,
    message: 'Resource settlement must use the version 1 structured receipt',
    satisfies: settledResources,
  },
};

export const evidenceKinds = Object.keys(registry);
export const knownEvidenceKind = kind => Object.hasOwn(registry, kind);

const attempt = (check, bytes, context) => { try { return Boolean(check(bytes, context)); } catch { return false; } };

// Throws the kind's own message when a payload may not enter the ledger at all.
export function acceptEvidence(kind, bytes, context = {}) {
  const entry = registry[kind];
  if (!entry) throw new Error('Unknown evidence kind');
  if (entry.accept && !attempt(entry.accept, bytes, context)) throw new Error(entry.message);
}

export function satisfiesEvidence(kind, bytes, context = {}) {
  const entry = registry[kind];
  return Boolean(entry) && attempt(entry.satisfies, bytes, context);
}

// Whether a ledger record discharges its kind: the payload rule, plus capture
// provenance for kinds whose evidence only exists outside the run. The caller
// guarantees the run was frozen under this evidenceVersion, so provenance is
// unconditional here.
export function dischargesEvidence(kind, record, context = {}) {
  const entry = registry[kind];
  if (!entry) return false;
  const bytes = Buffer.from(record.bytes, 'base64');
  if (!attempt(entry.satisfies, bytes, context)) return false;
  return !entry.sourceVerified || record.capture === 'verified';
}
