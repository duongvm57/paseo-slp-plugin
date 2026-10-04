// plugin/server/desk-task.ts — the native task-execution ledger domain (v9).
//
// One authoritative entry point pair plus pure read resolvers:
//   runTaskCommand — define/reserve/result/rule/hold/stop/acknowledge/reconcile
//   runTaskEffect  — intent/issue/observe/bind/integration-admit (internal,
//                    driven by the execution adapters under the desk lock)
//
// Authority: every write resolves a live actor membership and, except the
// narrowly scoped observe path, the assignment's exact effective-owner
// tuple. An observe may also be committed by the attempt's own bound member
// tuple (server-resolved from the durable rows — never a claimed identity):
// the seat's stream correlates its own committed action outcome, so the
// entry honestly attributes the observation to that seat rather than to any
// owner. When neither principal resolves the observation stays uncommitted
// and surfaces through taskPendingObservations as a typed gap; an explicit
// owner-driven reconcile (which drives deps.observe internally) is the
// recovery path — no actor is ever fabricated.
//
// Revisions: each entity (task/attempt/result/adjudication/hold/action/
// delivery/resource/control) is an immutable per-entity revision stream —
// every committed row carries the complete current state, a self-hash and a
// chain link; the store re-verifies streams, digests, ordinals and the
// one-live-attempt invariant against the event chain on every read.

import { z } from "zod";
import { dirname, join } from "node:path";
import {
  DeskTaskDependency,
  DeskTaskDependencyObservation,
  DeskTaskAmendment,
  DeskTaskReleaseRuling,
  DeskTaskAttemptRuling,
  type DeskTaskDependencyObservationValue,
  type DeskTaskPlacementValue,
  type DeskTaskTargetPinValue,
  DeskTaskReceipt,
  DeskTaskIntegrationRecoveryPlan,
  DeskTaskIntegrationControlPins,
  DeskTaskIntegrationEntryRef,
  DeskTaskIntegrationCleanupBundle,
  DeskTaskIntegrationCleanupCandidate,
  DeskTaskIntegrationCleanupVerification,
  DeskTaskIntegrationCleanupPermit,
  DeskTaskIntegrationCleanupObservation,
  DeskTaskIntegrationCleanupPreflightEvidence,
  DeskTaskIntegrationCleanupObserverResponse,
  DeskTaskIntegrationCleanupTrigger,
  DeskTaskEffectReceipt,
  DeskTaskMeasurePin,
  DeskTaskResultBody,
  DeskTaskAdjudicationBody,
  DeskTaskHoldBody,
  DeskTaskHoldRuling,
  DeskTaskCommandBody,
  DeskTaskMemberPin,
  DeskTaskPlacement,
  DeskTaskRuntimePin,
  DeskTaskSeatPin,
  DeskTaskActionKind,
  DeskTaskCommandInput,
  DeskTaskEffectInput,
  WIRE_LIMITS,
  type DeskRejectionValue,
  type DeskTaskCommandResultValue,
  type DeskTaskEffectResultValue,
  type DeskTaskEntryValue,
  type DeskTaskDeclarationEntryValue,
  type DeskTaskAttemptEntryValue,
  type DeskTaskResultEntryValue,
  type DeskTaskAdjudicationEntryValue,
  type DeskTaskHoldEntryValue,
  type DeskTaskActionEntryValue,
  type DeskTaskDeliveryEntryValue,
  type DeskTaskResourceEntryValue,
  type DeskTaskIntegrationRecoveryPlanValue,
  type DeskTaskIntegrationControlPinsValue,
  type DeskTaskIntegrationCleanupBundleValue,
  type DeskTaskIntegrationEntryRefValue,
  type DeskTaskIntegrationCleanupCandidateValue,
  type DeskTaskIntegrationCleanupVerificationValue,
  type DeskTaskIntegrationCleanupPermitValue,
  type DeskTaskIntegrationCleanupObservationValue,
  type DeskTaskIntegrationCleanupObserverResponseValue,
  type DeskTaskIntegrationCleanupTriggerValue,
  type DeskTaskEffectReceiptValue,
  type DeskTaskIntegrationCleanupResourcePinValue,
  type DeskTaskIntegrationCleanupResourceObservationValue,
  type DeskTaskIntegrationCleanupObservedResourceValue,
  type DeskTaskIntegrationCleanupInventoryEntryValue,
  type DeskTaskIntegrationCleanupPreflightEvidenceValue,
  type DeskTaskControlEntryValue,
  type DeskTaskCommandInputValue,
  type DeskTaskEffectInputValue,
  type DeskTaskDependencyPinValue,
  type DeskTaskDependencyValue,
  type DeskTaskMeasurePinValue,
  type DeskTaskReadinessValue,
  type DeskTaskReadinessBucketValue,
  type DeskTaskResultQualificationValue,
  type DeskTaskRecapItemValue,
  type DeskTaskQueueCountsValue,
  type DeskTaskReasonCodeValue,
  type DeskTaskCommandBodyValue,
  type DeskTaskProofPolicyRowValue,
  type DeskWorkflowProjectionItemValue,
} from "../shared/enforcement.ts";
import {
  effectiveOwner,
  LEDGER_LIMITS,
  type AssignmentValue,
  type LedgerValue,
  type MembershipValue,
  type DecideOutcome,
  type ScopeValue,
  type ScopeTransitionValue,
} from "./desk-store.ts";
import { deriveId } from "./desk-command.ts";
import { deskWorkflowParticipant } from "./desk-ownership.ts";
import { canonicalJson, canonicalSha256, sha256Hex } from "./config-view.ts";
import { isRejection, readLedger, repoEnvelope, type RunnerCtx } from "./desk-runner.ts";
import type { DeskStore } from "./desk-store.ts";
import { taskGraphValid, taskIntegrationReconcileEdgeAllowed } from "./desk-task-history.ts";
import { decideDeskHandback } from "./desk-handback.ts";
import { decideDeskScope, decideTaskScopeCancellation, currentScopeReviewQualification } from "./desk-scope.ts";

// ---------------------------------------------------------------------------
// Public dependency and result types — the seam the execution adapter binds.
// ---------------------------------------------------------------------------

export type TaskDependencyObservationRequest = {
  pins: DeskTaskDependencyPinValue[]; placement: DeskTaskPlacementValue; ledgerRevision: number;
};
export type TaskDependencyObservation = Omit<DeskTaskDependencyObservationValue, "ledgerRevision" | "placement">;

export type DeskTaskIntegrationCleanupPublicAdmission =
  | {
      phase: "discharge";
      publicRequestId: string;
      publicRequestSha256: string;
      grantRef: string;
      controlPins: DeskTaskIntegrationControlPinsValue;
      intentRef: DeskTaskIntegrationEntryRefValue;
      issueRef: DeskTaskIntegrationEntryRefValue;
    }
  | {
      phase: "reconcile";
      publicRequestId: string;
      publicRequestSha256: string;
      grantRef: null;
      controlPins: DeskTaskIntegrationControlPinsValue;
      intentRef: null;
      issueRef: DeskTaskIntegrationEntryRefValue;
    };

export type DeskTaskIntegrationCleanupObserverAdmission = DeskTaskIntegrationCleanupPublicAdmission |
  (Omit<Extract<DeskTaskIntegrationCleanupPublicAdmission, { phase: "discharge" }>, "issueRef"> & { issueRef: null });

export type DeskTaskIntegrationCleanupPriorPermit = {
  permit: DeskTaskIntegrationCleanupPermitValue;
  issueRef: DeskTaskIntegrationEntryRefValue;
};

export type DeskTaskIntegrationCleanupObserverRequest =
  | {
      version: 1;
      purpose: "verify-account";
      progressKind: "initial";
      admission: Extract<DeskTaskIntegrationCleanupPublicAdmission, { phase: "discharge" }>;
      actionId: string;
      expectedActionRevision: number;
      sourceBase: DeskTaskMeasurePinValue;
      sourceResult: DeskTaskMeasurePinValue;
      candidate: DeskTaskIntegrationCleanupCandidateValue;
      candidateArtifactBytes: Uint8Array;
      verification: null;
      verificationRef: null;
      permit: null;
    }
  | {
      version: 1;
      purpose: "reconcile-progress";
      progressKind: "verify-account";
      admission: Extract<DeskTaskIntegrationCleanupPublicAdmission, { phase: "reconcile" }>;
      actionId: string;
      expectedActionRevision: number;
      sourceBase: DeskTaskMeasurePinValue;
      sourceResult: DeskTaskMeasurePinValue;
      candidate: DeskTaskIntegrationCleanupCandidateValue;
      candidateArtifactBytes: Uint8Array;
      verifyIssueRef: DeskTaskIntegrationEntryRefValue;
      verification: null;
      verificationRef: null;
      permit: null;
    }
  | {
      version: 1;
      purpose: "reconcile-progress";
      progressKind: "resource-preflight";
      admission: Omit<Extract<DeskTaskIntegrationCleanupPublicAdmission, { phase: "discharge" }>, "issueRef"> & { issueRef: null };
      actionId: string;
      expectedActionRevision: number;
      sourceBase: DeskTaskMeasurePinValue;
      sourceResult: DeskTaskMeasurePinValue;
      candidate: null;
      candidateArtifactBytes: null;
      verification: DeskTaskIntegrationCleanupVerificationValue;
      verificationRef: DeskTaskIntegrationEntryRefValue;
      permit: DeskTaskIntegrationCleanupPermitValue;
      priorIssuedPermit: DeskTaskIntegrationCleanupPriorPermit | null;
    }
  | {
      version: 1;
      purpose: "reconcile-progress";
      progressKind: "resource";
      admission: DeskTaskIntegrationCleanupPublicAdmission;
      actionId: string;
      expectedActionRevision: number;
      sourceBase: DeskTaskMeasurePinValue;
      sourceResult: DeskTaskMeasurePinValue;
      candidate: null;
      candidateArtifactBytes: null;
      verification: DeskTaskIntegrationCleanupVerificationValue;
      verificationRef: DeskTaskIntegrationEntryRefValue;
      permit: DeskTaskIntegrationCleanupPermitValue;
    };

export type DeskTaskIntegrationCleanupObserverResponse = DeskTaskIntegrationCleanupObserverResponseValue;

export type TaskObserver = {
  observePlacement?(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  observeDependencies?(request: TaskDependencyObservationRequest): Promise<TaskDependencyObservation>;
  observeArtifacts?(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  observeAction?(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  observeResources?(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  observeIntegrationCleanup?(request: DeskTaskIntegrationCleanupObserverRequest): Promise<DeskTaskIntegrationCleanupObserverResponse>;
};

export type TaskRunnerDeps = {
  store: DeskStore;
  observe?: TaskObserver;
  /** One-call, in-memory cleanup proof bytes supplied by the integration
   *  adapter. This value is deliberately excluded from public input,
   *  commands, request hashes and durable rows. Core reads it only after an
   *  exact replay miss for verify-account observation/reconciliation. */
  cleanupArtifactBytes?: { candidateSha256: string; bytes: Uint8Array };
};

export type TaskEffectPermit = {
  actionId: string;
  entrySha256: string;
  ownershipRevision: number;
  attemptRevision: number;
  body: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Read-side accessors — pure ledger-in, same row vocabulary everywhere.
// ---------------------------------------------------------------------------

type TaskEntry = DeskTaskEntryValue;

export function taskEntriesOf(ledger: Readonly<LedgerValue>, kind?: TaskEntry["kind"]): TaskEntry[] {
  return ledger.taskEntries.filter(row => kind === undefined || row.kind === kind);
}

export function taskEntriesForTask(ledger: Readonly<LedgerValue>, taskId: string, kind?: TaskEntry["kind"]): TaskEntry[] {
  return ledger.taskEntries.filter(row => row.taskId === taskId && (kind === undefined || row.kind === kind));
}

export function latestTaskEntity<T extends TaskEntry>(ledger: Readonly<LedgerValue>, entityId: string): T | undefined {
  let latest: TaskEntry | undefined;
  for (const row of ledger.taskEntries) {
    if (row.entityId === entityId && (latest === undefined || row.revision > latest.revision)) latest = row;
  }
  return latest as T | undefined;
}

export function latestTask(ledger: Readonly<LedgerValue>, assignmentId: string, taskId: string): DeskTaskDeclarationEntryValue | undefined {
  const row = latestTaskEntity(ledger, taskId);
  return row !== undefined && row.kind === "task" && row.assignmentId === assignmentId
    ? (row as DeskTaskDeclarationEntryValue)
    : undefined;
}

function latestAttemptsForTask(ledger: Readonly<LedgerValue>, taskId: string): DeskTaskAttemptEntryValue[] {
  const byId = new Map<string, DeskTaskAttemptEntryValue>();
  for (const row of ledger.taskEntries) {
    if (row.kind !== "attempt" || row.taskId !== taskId) continue;
    const prior = byId.get(row.attemptId);
    if (prior === undefined || prior.revision < row.revision) byId.set(row.attemptId, row as DeskTaskAttemptEntryValue);
  }
  return [...byId.values()];
}

export function liveAttemptForTask(ledger: Readonly<LedgerValue>, taskId: string): DeskTaskAttemptEntryValue | undefined {
  return latestAttemptsForTask(ledger, taskId).find(row => row.state !== "settled" && row.state !== "stopped");
}

function latestActions(ledger: Readonly<LedgerValue>, filter: { taskId?: string; attemptId?: string }): DeskTaskActionEntryValue[] {
  const byId = new Map<string, DeskTaskActionEntryValue>();
  for (const row of ledger.taskEntries) {
    if (row.kind !== "action") continue;
    if (filter.taskId !== undefined && row.taskId !== filter.taskId) continue;
    if (filter.attemptId !== undefined && row.attemptId !== filter.attemptId) continue;
    const prior = byId.get(row.actionId);
    if (prior === undefined || prior.revision < row.revision) byId.set(row.actionId, row as DeskTaskActionEntryValue);
  }
  return [...byId.values()];
}

function latestResultsForTask(ledger: Readonly<LedgerValue>, taskId: string): DeskTaskResultEntryValue[] {
  const byId = new Map<string, DeskTaskResultEntryValue>();
  for (const row of ledger.taskEntries) {
    if (row.kind !== "result" || row.taskId !== taskId) continue;
    const prior = byId.get(row.resultId);
    if (prior === undefined || prior.revision < row.revision) byId.set(row.resultId, row as DeskTaskResultEntryValue);
  }
  return [...byId.values()];
}

function latestAdjudicationForResult(ledger: Readonly<LedgerValue>, resultId: string): DeskTaskAdjudicationEntryValue | undefined {
  return ledger.taskEntries.filter((row): row is DeskTaskAdjudicationEntryValue =>
    row.kind === "adjudication" && row.resultId === resultId).at(-1);
}

function latestHoldsForTask(ledger: Readonly<LedgerValue>, taskId: string): DeskTaskHoldEntryValue[] {
  const byId = new Map<string, DeskTaskHoldEntryValue>();
  for (const row of ledger.taskEntries) {
    if (row.kind !== "hold" || row.taskId !== taskId) continue;
    const prior = byId.get(row.holdId);
    if (prior === undefined || prior.revision < row.revision) byId.set(row.holdId, row as DeskTaskHoldEntryValue);
  }
  return [...byId.values()];
}

function latestResourcesForTask(ledger: Readonly<LedgerValue>, taskId: string): DeskTaskResourceEntryValue[] {
  const byId = new Map<string, DeskTaskResourceEntryValue>();
  for (const row of ledger.taskEntries) {
    if (row.kind !== "resource" || row.taskId !== taskId) continue;
    const prior = byId.get(row.resourceId);
    if (prior === undefined || prior.revision < row.revision) byId.set(row.resourceId, row as DeskTaskResourceEntryValue);
  }
  return [...byId.values()];
}

function latestDeliveriesForTask(ledger: Readonly<LedgerValue>, taskId: string): DeskTaskDeliveryEntryValue[] {
  const byId = new Map<string, DeskTaskDeliveryEntryValue>();
  for (const row of ledger.taskEntries) {
    if (row.kind !== "delivery" || row.taskId !== taskId) continue;
    const prior = byId.get(row.deliveryId);
    if (prior === undefined || prior.revision < row.revision) byId.set(row.deliveryId, row as DeskTaskDeliveryEntryValue);
  }
  return [...byId.values()];
}

function latestControlsForTask(ledger: Readonly<LedgerValue>, taskId: string): DeskTaskControlEntryValue[] {
  const byId = new Map<string, DeskTaskControlEntryValue>();
  for (const row of ledger.taskEntries) {
    if (row.kind !== "control" || row.taskId !== taskId) continue;
    const prior = byId.get(row.controlId);
    if (prior === undefined || prior.revision < row.revision) byId.set(row.controlId, row as DeskTaskControlEntryValue);
  }
  return [...byId.values()];
}

function briefRevisionOf(ledger: Readonly<LedgerValue>, assignmentId: string): number {
  let revision = 0;
  for (const row of ledger.briefRevisions) {
    if (row.assignmentId === assignmentId && row.revision > revision) revision = row.revision;
  }
  return revision;
}

function ownershipRevisionOf(ledger: Readonly<LedgerValue>, assignmentId: string): number {
  let revision = 0;
  for (const row of ledger.ownershipAccepts) {
    if (row.assignmentId === assignmentId && row.ownershipRevision > revision) revision = row.ownershipRevision;
  }
  return revision;
}

// ---------------------------------------------------------------------------
// Dependency resolution — the pin a reserve consumes, resolved against the
// producer's current accepted result. The same resolver feeds readiness and
// the reserve gate, so a view never shows a row the gate would refuse.
// ---------------------------------------------------------------------------

function resolveDependencyPin(
  ledger: Readonly<LedgerValue>,
  dep: DeskTaskDependencyValue,
): { pin: DeskTaskDependencyPinValue } | { reason: DeskTaskReasonCodeValue } {
  const producer = latestTaskEntity(ledger, dep.taskId);
  if (producer === undefined || producer.kind !== "task") return { reason: "dependency-unruled" };
  if (!currentTaskResultQualification(ledger, producer.assignmentId, dep.taskId).qualified) return { reason: "dependency-unruled" };
  const results = latestResultsForTask(ledger, dep.taskId);
  const result = results.at(-1);
  if (result === undefined) return { reason: "dependency-unruled" };
  const ruling = latestAdjudicationForResult(ledger, result.resultId);
  if (ruling === undefined || ruling.verdict !== "accepted") return { reason: "dependency-unruled" };
  if (dep.availability === "artifact") {
    if (dep.artifactKey === null) return { reason: "artifact-unavailable" };
    const artifact = result.artifacts.find(item => item.key === dep.artifactKey);
    if (artifact === undefined) return { reason: "artifact-unavailable" };
    return {
      pin: {
        taskId: dep.taskId,
        taskRevision: producer.revision,
        briefRevision: briefRevisionOf(ledger, result.assignmentId),
        attemptId: result.attemptId,
        resultId: result.resultId,
        resultRevision: result.revision,
        resultEntrySha256: result.entrySha256,
        adjudicationId: ruling.adjudicationId,
        adjudicationRevision: ruling.revision,
        adjudicationEntrySha256: ruling.entrySha256,
        availability: "artifact",
        artifactKey: dep.artifactKey,
        artifactSha256: artifact.sha256,
        targetPath: dep.targetPath,
        integrationActionId: null,
        actualTargetPin: null,
      },
    };
  }
  // integrated-code: the producer's landed integration action supplies the
  // actual target pin the consumer's base must still contain.
  const integration = latestActions(ledger, { taskId: dep.taskId })
    .filter(row => row.actionKind === "integration" && row.resultId === result.resultId && row.landed !== null && row.state === "observed" &&
      row.sourceResult?.snapshotSha256 === result.snapshotSha256 && (row.phase === "land" || row.phase === "discharge"))
    .at(-1);
  if (integration === undefined) {
    return { reason: "target-availability-unverified" };
  }
  return {
    pin: {
      taskId: dep.taskId,
      taskRevision: producer.revision,
      briefRevision: briefRevisionOf(ledger, result.assignmentId),
      attemptId: result.attemptId,
      resultId: result.resultId,
      resultRevision: result.revision,
      resultEntrySha256: result.entrySha256,
      adjudicationId: ruling.adjudicationId,
      adjudicationRevision: ruling.revision,
      adjudicationEntrySha256: ruling.entrySha256,
      availability: "integrated-code",
      artifactKey: null,
      artifactSha256: null,
      targetPath: null,
      integrationActionId: integration.actionId,
      actualTargetPin: null,
    },
  };

}

function validateDependencyObservation(
  ledger: Readonly<LedgerValue>, pins: DeskTaskDependencyPinValue[], placement: DeskTaskPlacementValue,
  observation: DeskTaskDependencyObservationValue | null,
): DeskRejectionValue | null {
  if (pins.length === 0) return null;
  if (observation === null) return reject("CAPABILITY_GAP", "dependencies have no measured consumer base", "wire the bounded dependency observer before admission");
  if (observation.ledgerRevision !== ledger.revision || canonicalSha256(observation.placement) !== canonicalSha256(placement) || !dependencyPinsCurrent(ledger, pins)) {
    return reject("REVISION_CONFLICT", "dependency measurement no longer binds the current ledger/placement/result pins", "repeat measurement from one fresh ledger observation");
  }
  const base = observation.consumerBase;
  if (base === null || base.incomplete.length > 0) return reject("EVIDENCE_INCOMPLETE", "consumer base is absent or incomplete", "measure the actual bounded consumer base");
  if (placement.cwd !== undefined && base.root !== placement.cwd) return reject("CANDIDATE_DRIFT", "dependency base root differs from placement", "measure the selected consumer, not a different checkout");
  if (placement.kind === "isolated" && placement.cwd === undefined) {
    const ref = observation.reference;
    if (base.kind !== "git-reference" || ref === null || ref.baseRef !== placement.baseRef || ref.resolvedHead !== base.head || ref.gitCommonDir !== ledger.repo.gitCommonDir) {
      return reject("EVIDENCE_INCOMPLETE", "isolated dependencies lack the exact resolved Git reference/base map", "measure the declared baseRef read-only before reserving");
    }
  }
  if (observation.results.length !== pins.length || new Set(observation.results.map(row => row.taskId)).size !== pins.length) {
    return reject("EVIDENCE_INCOMPLETE", "dependency observations are not a one-to-one full pin set", "measure every declared dependency once");
  }
  for (const pin of pins) {
    const result = observation.results.find(row => row.taskId === pin.taskId);
    if (result === undefined || !result.available || result.resultEntrySha256 !== pin.resultEntrySha256 ||
        result.adjudicationEntrySha256 !== pin.adjudicationEntrySha256 || result.evidence.length === 0) {
      return reject("EVIDENCE_INCOMPLETE", "dependency availability does not bind the exact result/ruling evidence", "measure current artifact or integrated delta availability");
    }
    if (pin.availability === "artifact" && result.sha256 !== pin.artifactSha256) return reject("CANDIDATE_DRIFT", "artifact bytes differ from the required digest", "restore or re-adjudicate the required artifact");
    if (pin.availability === "integrated-code") {
      const target = result.actualTargetPin;
      if (target === null || target.hostId !== ledger.repo.hostId || target.repoKey !== ledger.repo.repoKey ||
          target.gitCommonDir !== ledger.repo.gitCommonDir || target.checkoutRoot !== base.root ||
          target.snapshotSha256 !== base.snapshotSha256 || target.head !== base.head || target.incomplete.length > 0) {
        return reject("EVIDENCE_INCOMPLETE", "integrated dependency is not observed in this consumer base", "verify each producer delta in the actual measured base");
      }
    }
  }
  return null;
}

async function measureDependencies(
  ledger: Readonly<LedgerValue>, pins: DeskTaskDependencyPinValue[], placement: DeskTaskPlacementValue,
  deps: TaskRunnerDeps,
): Promise<DeskTaskDependencyObservationValue | DeskRejectionValue | null> {
  if (pins.length === 0) return null;
  if (deps.observe?.observeDependencies === undefined) return reject("CAPABILITY_GAP", "the dependency observer is unavailable", "wire bounded actual artifact/base measurement");
  try {
    const result = await deps.observe.observeDependencies({ pins, placement, ledgerRevision: ledger.revision });
    const parsed = DeskTaskDependencyObservation.safeParse({ ...result, ledgerRevision: ledger.revision, placement });
    if (!parsed.success) return reject("EVIDENCE_INCOMPLETE", "dependency observer returned an incomplete or malformed pin set", "return the strict TaskDependencyObservation shape");
    return parsed.data;
  } catch (error) {
    return reject("CAPABILITY_GAP", `dependency measurement failed: ${String(error).slice(0, 160)}`, "retain obligations until the bounded observer is available");
  }
}

function dependencyPinsCurrent(ledger: Readonly<LedgerValue>, pins: DeskTaskDependencyPinValue[], visiting = new Set<string>()): boolean {
  for (const pin of pins) {
    const producer = latestTaskEntity<DeskTaskDeclarationEntryValue>(ledger, pin.taskId);
    if (producer === undefined || producer.kind !== "task" || producer.revision !== pin.taskRevision ||
        briefRevisionOf(ledger, producer.assignmentId) !== pin.briefRevision || visiting.has(pin.taskId)) return false;
    if (!currentTaskResultQualification(ledger, producer.assignmentId, pin.taskId, visiting).qualified) return false;
    const results = latestResultsForTask(ledger, pin.taskId);
    const current = results.at(-1);
    if (current === undefined || current.resultId !== pin.resultId || current.revision !== pin.resultRevision || current.entrySha256 !== pin.resultEntrySha256) return false;
    const ruling = latestAdjudicationForResult(ledger, pin.resultId);
    if (ruling === undefined || ruling.adjudicationId !== pin.adjudicationId ||
        ruling.revision !== pin.adjudicationRevision || ruling.entrySha256 !== pin.adjudicationEntrySha256 || ruling.verdict !== "accepted") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Readiness — the single resolver shared by the reserve gate, the tasks
// projection and the recap. Ledger in, closed vocabulary out.
// ---------------------------------------------------------------------------

export function currentTaskReadiness(
  ledger: Readonly<LedgerValue>,
  assignment: AssignmentValue,
  task: DeskTaskDeclarationEntryValue,
): DeskTaskReadinessValue {
  const reasons: DeskTaskReasonCodeValue[] = [];
  const dependencyRevisions: Record<string, number> = {};
  const pins = {
    briefRevision: briefRevisionOf(ledger, task.assignmentId),
    taskRevision: task.revision,
    dependencyRevisions,
  };
  const done = (bucket: DeskTaskReadinessBucketValue, eligible: boolean): DeskTaskReadinessValue => ({
    bucket, reasons, eligible, pins,
  });
  if (task.briefRevision !== pins.briefRevision) { reasons.push("brief-changed"); return done("held", false); }
  if (task.state === "withdrawn") {
    reasons.push("task-withdrawn");
    return done("settled", false);
  }
  const liveAttempt = liveAttemptForTask(ledger, task.taskId);
  if (liveAttempt !== undefined) {
    if (liveAttempt.taskRevision !== task.revision || liveAttempt.briefRevision !== pins.briefRevision) reasons.push("task-superseded");
    const owner = effectiveOwner(ledger, assignment);
    if (owner.agentId !== liveAttempt.ownerAgentId || owner.membershipId !== liveAttempt.ownerMembershipId) reasons.push("owner-changed");
    if (!dependencyPinsCurrent(ledger, liveAttempt.consumedDependencies)) reasons.push("dependency-pin-changed");
    if (latestHoldsForTask(ledger, task.taskId).some(row => row.state === "open" || row.ruling?.outcome === "retain")) reasons.push("question-open");
    if (reasons.length > 0) return done("held", false);
    if (liveAttempt.stop.requested || liveAttempt.state === "stop-requested") {
      reasons.push("stop-requested");
      return done("held", false);
    }
    const integrations = latestActions(ledger, { taskId: task.taskId }).filter(
      row => row.actionKind === "integration" &&
        (row.state === "intended" || row.state === "issued" || row.state === "uncertain"),
    );
    if (integrations.length > 0) return done("integrating", false);
    if (liveAttempt.state === "reconciliation-required") {
      reasons.push("effect-uncertain");
      return done("held", false);
    }
    return done("running", false);
  }
  const results = latestResultsForTask(ledger, task.taskId);
  const latestResult = results.at(-1);
  if (latestResult !== undefined && latestResult.taskRevision === task.revision) {
    const ruling = latestAdjudicationForResult(ledger, latestResult.resultId);
    if (ruling !== undefined && (currentTaskResultQualification(ledger, task.assignmentId, task.taskId).qualified || ruling.verdict === "rejected")) {
      return done("settled", false);
    }
    reasons.push("result-unruled");
    return done("held", false);
  }
  const openHolds = latestHoldsForTask(ledger, task.taskId).filter(row => row.state === "open" || row.ruling?.outcome === "retain");
  if (openHolds.length > 0) {
    reasons.push("question-open");
    return done("held", false);
  }
  // Dependency freshness — a pin resolved only inside an earlier attempt is
  // never reused; readiness resolves declared dependencies against current
  // producer streams every time.
  let unruled = false;
  for (const dep of task.dependencies) {
    const resolved = resolveDependencyPin(ledger, dep);
    if ("reason" in resolved) {
      reasons.push(resolved.reason);
      unruled = true;
    } else {
      dependencyRevisions[dep.taskId] = resolved.pin.taskRevision;
    }
  }
  if (unruled) return done("backlog", false);
  return done("ready", reasons.length === 0);
}

// ---------------------------------------------------------------------------
// Result qualification — landability's ledger-side facts. Integration
// admission adds the explicit grant; this resolver answers whether the
// pinned result currently stands ruled and scope-qualified.
// ---------------------------------------------------------------------------

export function currentTaskResultQualification(
  ledger: Readonly<LedgerValue>, assignmentId: string, taskId: string, visiting = new Set<string>(),
): DeskTaskResultQualificationValue {
  let scopeProof: DeskTaskResultQualificationValue["scopeProof"] = null;
  const reasons: DeskTaskReasonCodeValue[] = [];
  const result = latestResultsForTask(ledger, taskId).at(-1);
  const ruling = result === undefined ? undefined : latestAdjudicationForResult(ledger, result.resultId);
  const task = latestTask(ledger, assignmentId, taskId);
  const producedAttempt=result===undefined?undefined:latestTaskEntity<DeskTaskAttemptEntryValue>(ledger,result.attemptId);
  if(result!==undefined && (producedAttempt?.kind!=="attempt" || producedAttempt.state==="stopped" || producedAttempt.stop.requested))reasons.push("stop-requested");
  const assignment = ledger.assignments.find(row => row.assignmentId === assignmentId);
  const owner = assignment === undefined ? null : effectiveOwner(ledger, assignment);
  if (visiting.has(taskId)) reasons.push("dependency-pin-changed");
  if (result === undefined || ruling === undefined || ruling.verdict !== "accepted" || task === undefined || assignment === undefined) reasons.push("result-unruled");
  if (task !== undefined && result !== undefined && ruling !== undefined && owner !== null) {
    if (result.assignmentId !== assignmentId || result.taskRevision !== task.revision || ruling.taskRevision !== task.revision ||
        ruling.resultRevision !== result.revision || ruling.resultEntrySha256 !== result.entrySha256 || ruling.attemptId !== result.attemptId) reasons.push("task-superseded");
    if (result.briefRevision !== briefRevisionOf(ledger, assignmentId) || ruling.briefRevision !== briefRevisionOf(ledger, assignmentId)) reasons.push("brief-changed");
    if (ruling.actorAgentId !== owner.agentId || ruling.actorMembershipId !== owner.membershipId || ruling.ownershipRevision !== ownershipRevisionOf(ledger, assignmentId)) reasons.push("owner-changed");
    if (task.state === "withdrawn") reasons.push("task-withdrawn");
    if (task.proofPolicy === null) reasons.push("proof-policy-missing");
    if (ruling.proofPolicyDigest !== (task.proofPolicy === null ? null : canonicalSha256(task.proofPolicy))) reasons.push("proof-incomplete");
    if (canonicalSha256(ruling.dependencyPins) !== canonicalSha256(result.consumedDependencies)) reasons.push("dependency-pin-changed");
    if (!visiting.has(taskId) && !dependencyPinsCurrent(ledger, result.consumedDependencies, new Set([...visiting, taskId]))) reasons.push("dependency-pin-changed");
    // Applicable scope mandates stand regardless of a task's reviewRequired flag.
    if (result.scopeId !== null) {
      const qualified = currentScopeReviewQualification(ledger, assignment!, result.scopeId, { includeClosedApproval: true });
      const round = qualified.standingApproval ?? qualified.terminalApproval;
      scopeProof = qualified.standingApproval !== null ? "standing-approval" : qualified.terminalApproval !== null ? "terminal-approved-round" : null;
      if (round === null || round.scopeRevision !== result.scopeRevision || round.candidateSnapshot !== result.snapshotSha256 ||
          result.reviewRound === null || result.reviewRound.scopeRevision !== round.scopeRevision ||
          result.reviewRound.candidateSnapshot !== round.candidateSnapshot || result.reviewRound.briefRevision !== round.briefRevision ||
          result.reviewRound.mandateSha256 !== round.mandateSha256) reasons.push("scope-unqualified");
    } else if (task.scope !== null || task.proofPolicy?.reviewRequired) reasons.push("scope-unqualified");
    else scopeProof = "none";
    const required = task.proofPolicy?.requiredChecks ?? [];
    for (const pin of required) {
      const ref = result.checkRuns.find(row => row.checkId === pin.checkId && row.definitionSha256 === pin.definitionDigest);
      const run = ref === undefined ? undefined : ledger.checkRuns.find(row => row.runId === ref.runId);
      if (run === undefined || run.assignmentId !== assignmentId || run.status !== "passed" ||
          run.candidateSnapshot !== result.snapshotSha256 || run.definitionSha256 !== pin.definitionDigest) reasons.push("proof-incomplete");
    }
    if ((task.proofPolicy?.requiredEvidence ?? []).some(ref => !ruling.evidence.includes(ref))) reasons.push("proof-incomplete");
    if (latestHoldsForTask(ledger, taskId).some(row => row.state === "open" || row.ruling?.outcome === "retain")) reasons.push("question-open");
  }
  return { qualified: reasons.length === 0, scopeProof, reasons: [...new Set(reasons)], resultId: result?.resultId ?? null,
    adjudicationId: ruling?.adjudicationId ?? null,
    pins: { resultRevision: result?.revision ?? 0, adjudicationRevision: ruling?.revision ?? 0,
      scopeId: result?.scopeId ?? null, scopeRevision: result?.scopeRevision ?? null } };
}

// ---------------------------------------------------------------------------
// Pending observations — the typed gap Root's hooks surface when no live
// principal may commit an observation (e.g. the bound member was revoked).
// ---------------------------------------------------------------------------

export type TaskPendingObservation = {
  kind: "action-observation" | "resource-observation" | "seat-pending";
  attemptId: string | null;
  actionId: string | null;
  resourceId: string | null;
  taskId: string;
  reason: string;
};

export function taskPendingObservations(ledger: Readonly<LedgerValue>, taskId: string): TaskPendingObservation[] {
  const pending: TaskPendingObservation[] = [];
  for (const action of latestActions(ledger, { taskId })) {
    if (action.state !== "issued" && action.state !== "uncertain") continue;
    pending.push({
      kind: "action-observation",
      attemptId: action.attemptId,
      actionId: action.actionId,
      resourceId: null,
      taskId,
      reason: `action ${action.actionId} awaits a committed observation`,
    });
  }
  for (const attempt of latestAttemptsForTask(ledger, taskId)) {
    if (attempt.state === "reserved" && attempt.member === null &&
        latestActions(ledger, { attemptId: attempt.attemptId }).some(a => a.actionKind === "create" && a.state === "observed")) {
      pending.push({
        kind: "seat-pending",
        attemptId: attempt.attemptId,
        actionId: null,
        resourceId: null,
        taskId,
        reason: `attempt ${attempt.attemptId} has an observed create but no bound membership`,
      });
    }
  }
  for (const resource of latestResourcesForTask(ledger, taskId)) {
    if (resource.disposition === "transfer-pending") {
      pending.push({
        kind: "resource-observation",
        attemptId: resource.attemptId,
        actionId: resource.actionId,
        resourceId: resource.resourceId,
        taskId,
        reason: `resource ${resource.resourceId} awaits a declared discharge observation`,
      });
    }
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Workflow projection + queue counts — the View seam. Counts return zeros
// on a migrated-empty table (supported-empty, never schema-unavailable).
// ---------------------------------------------------------------------------

function taskRecapSummary(row: TaskEntry, ordinal: number): DeskTaskRecapItemValue {
  const state =
    row.kind === "task" ? row.state :
    row.kind === "attempt" ? row.state :
    row.kind === "result" ? row.provenance :
    row.kind === "adjudication" ? row.verdict :
    row.kind === "hold" ? row.state :
    row.kind === "action" ? row.state :
    row.kind === "delivery" ? row.state :
    row.kind === "resource" ? row.disposition : row.state;
  const summary =
    row.kind === "task" ? row.outcome :
    row.kind === "hold" ? row.question :
    row.kind === "adjudication" ? row.reason :
    row.kind === "control" ? row.reason :
    null;
  return {
    entryId: row.entryId,
    taskId: row.taskId,
    kind: row.kind,
    state,
    summary,
    entrySha256: row.entrySha256,
    ordinal,
  };
}

/** One committed task entry becomes one projection item — the section's own
 *  sort/paging applies after this returns every row for the assignment. */
export function taskWorkflowItems(
  ledger: Readonly<LedgerValue>,
  assignment: AssignmentValue,
): DeskWorkflowProjectionItemValue[] {
  const rows = ledger.taskEntries.filter(row => row.assignmentId === assignment.assignmentId);
  const tasks = new Map<string, DeskTaskDeclarationEntryValue>();
  for (const row of rows) {
    if (row.kind !== "task") continue;
    const prior = tasks.get(row.taskId);
    if (prior === undefined || prior.revision < row.revision) tasks.set(row.taskId, row as DeskTaskDeclarationEntryValue);
  }
  return rows.map((row, index) => {
    const task = row.taskId !== null ? tasks.get(row.taskId) : undefined;
    return {
      kind: "taskEntry",
      row,
      current: latestTaskEntity(ledger, row.entityId)?.entryId === row.entryId,
      resultQualification: task !== undefined ? currentTaskResultQualification(ledger, assignment.assignmentId, task.taskId) : null,
      currentRuling: task !== undefined ? (() => { const result = latestResultsForTask(ledger, task.taskId).at(-1); return result === undefined ? null : latestAdjudicationForResult(ledger, result.resultId) ?? null; })() : null,
      readiness: task !== undefined ? currentTaskReadiness(ledger, assignment, task) : null,
      summary: taskRecapSummary(row, index),
    };
  });
}

export function taskQueueCounts(ledger: Readonly<LedgerValue>, assignment: AssignmentValue): DeskTaskQueueCountsValue {
  const counts: DeskTaskQueueCountsValue = {
    backlog: 0, ready: 0, held: 0, running: 0, integrating: 0, settled: 0, superseded: 0,
    openHolds: 0, pendingAcks: 0, resources: 0, controls: 0,
  };
  const tasks = new Map<string, DeskTaskDeclarationEntryValue>();
  for (const row of ledger.taskEntries) {
    if (row.kind !== "task" || row.assignmentId !== assignment.assignmentId) continue;
    const prior = tasks.get(row.taskId);
    if (prior === undefined || prior.revision < row.revision) tasks.set(row.taskId, row as DeskTaskDeclarationEntryValue);
  }
  for (const task of tasks.values()) counts[currentTaskReadiness(ledger, assignment, task).bucket] += 1;
  const current = new Map<string, TaskEntry>();
  for (const row of ledger.taskEntries) if (row.assignmentId === assignment.assignmentId) current.set(row.entityId, row);
  for (const row of current.values()) {
    if (row.kind === "hold" && (row.state === "open" || row.ruling?.outcome === "retain")) counts.openHolds += 1;
    if (row.kind === "delivery" && (row.state === "pending" || row.state === "host-accepted")) counts.pendingAcks += 1;
    if (row.kind === "resource" && row.disposition !== "released") counts.resources += 1;
    if (row.kind === "control" && row.state === "stop-requested") counts.controls += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// decide — synchronous and pure; the store supplies the mutex, idempotency
// and the refinement re-check.
// ---------------------------------------------------------------------------

const TaskActor = z.string().min(1).max(WIRE_LIMITS.agentId);
const TaskEntityField = z.string().min(1).max(WIRE_LIMITS.deskEntityId);
const TaskRequestField = z.string().min(1).max(WIRE_LIMITS.deskRequestId);
const TaskJsonField = z.record(z.string(), z.unknown());

const CasFields = {
  expectedLedgerRevision: z.number().int().min(0).optional(),
  expectedBriefRevision: z.number().int().min(0).optional(),
  expectedOwnershipRevision: z.number().int().min(0).optional(),
};

const DispatchControlPins = z.object({ assignmentId: TaskEntityField, taskId: TaskEntityField,
  expectedLedgerRevision: z.number().int().min(0), expectedBriefRevision: z.number().int().min(0),
  expectedOwnershipRevision: z.number().int().min(0), expectedTaskRevision: z.number().int().min(1),
  expectedAttemptRevision: z.number().int().min(1),
}).strict();
function phaseControlGate(ledger: Readonly<LedgerValue>, target: DeskTaskAttemptEntryValue | DeskTaskActionEntryValue,
  value: unknown): DeskRejectionValue | null {
  if (target.kind === "attempt") {
    const parsed = DispatchControlPins.safeParse(value);
    if (!parsed.success) return reject("INVALID_RECORD", "dispatch phase lacks strict controlPins", "derive controlPins from the public phase request");
    const pin = parsed.data;
    if (pin.assignmentId !== target.assignmentId || pin.taskId !== target.taskId || pin.expectedAttemptRevision !== target.revision) return reject("REVISION_CONFLICT", "attempt phase pin does not match", "read the current attempt and submit a fresh phase request");
    return checkCas(ledger, target.assignmentId, pin, latestTask(ledger, target.assignmentId, target.taskId));
  }
  const parsed = DeskTaskIntegrationControlPins.safeParse(value);
  if (!parsed.success) return reject("INVALID_RECORD", "integration phase lacks strict controlPins", "derive controlPins from the public phase request");
  const pin = parsed.data;
  const result = pin.resultId === target.resultId ? latestTaskEntity<DeskTaskResultEntryValue>(ledger, pin.resultId) : undefined;
  const qualification = currentTaskResultQualification(ledger, target.assignmentId, target.taskId);
  if (pin.assignmentId !== target.assignmentId || pin.taskId !== target.taskId || pin.expectedActionRevision !== target.revision ||
      pin.expectedLedgerRevision !== ledger.revision || result?.kind !== "result" || result.revision !== pin.expectedResultRevision ||
      qualification.adjudicationId === null || qualification.pins.adjudicationRevision !== pin.expectedAdjudicationRevision || !qualification.qualified) {
    return reject("REVISION_CONFLICT", "integration phase/result/ruling/ledger pins do not match", "read the current pinned result and action before a fresh phase request");
  }
  return null;
}

const TaskDefineCmd = z.object({
  kind: z.literal("task.define"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  taskId: TaskEntityField.nullable(),
  expectedLedgerRevision: z.number().int().min(0), expectedBriefRevision: z.number().int().min(0),
  expectedOwnershipRevision: z.number().int().min(0), expectedTaskRevision: z.number().int().min(0),
  task: DeskTaskCommandBody,
}).strict();

const TaskUpdateCmd = z.object({ kind: z.literal("task.update"), actorAgentId: TaskActor,
  actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  operation: z.enum(["amend", "reopen", "abandon"]), taskId: TaskEntityField,
  expectedTaskRevision: z.number().int().min(1), ...CasFields,
  task: DeskTaskAmendment.nullable(), reason: z.string().min(1).max(WIRE_LIMITS.deskTaskText).nullable(),
}).strict();

const TaskReserveCmd = z.object({
  kind: z.literal("task.reserve"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  taskId: TaskEntityField, grantRef: z.string().min(1).max(WIRE_LIMITS.deskAuthorityRef),
  ...CasFields,
  placement: DeskTaskPlacement, runtime: DeskTaskRuntimePin.nullable(), seatPin: DeskTaskSeatPin,
  expectedTaskRevision: z.number().int().min(0).optional(),
  reuseTarget: z.union([z.literal("new"), z.object({ agentId: TaskActor }).strict()]),
  effectBudget: z.number().int().min(1).max(WIRE_LIMITS.deskTaskActions).optional(),
  predecessor: z.object({ attemptId: TaskEntityField, resultId: TaskEntityField }).strict().nullable().optional(),
  dependencyObservation: DeskTaskDependencyObservation.nullable().optional(),
}).strict();

const TaskResultCmd = z.object({
  kind: z.literal("task.result"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  taskId: TaskEntityField, attemptId: TaskEntityField, expectedTaskRevision: z.number().int().min(0),
  ...CasFields,
  result: DeskTaskResultBody,
}).strict();

const TaskRuleCmd = z.object({
  kind: z.literal("task.rule"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  taskId: TaskEntityField, expectedTaskRevision: z.number().int().min(0),
  ...CasFields,
  adjudication: DeskTaskAdjudicationBody,
}).strict();

const TaskHoldCmd = z.object({
  kind: z.literal("task.hold"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  taskId: TaskEntityField, attemptId: TaskEntityField.nullable(), holdId: TaskEntityField.nullable(),
  expectedTaskRevision: z.number().int().min(0).optional(),
  ...CasFields,
  hold: DeskTaskHoldBody.nullable(), ruling: DeskTaskHoldRuling.nullable(),
}).strict();

const TaskStopCmd = z.object({
  kind: z.literal("task.stop"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  taskId: TaskEntityField.nullable(), attemptId: TaskEntityField.nullable(),
  expectedTaskRevision: z.number().int().min(0).optional(),
  ...CasFields,
  reason: z.string().min(1).max(WIRE_LIMITS.deskBriefText),
}).strict();

const TaskAcknowledgeCmd = z.object({
  kind: z.literal("task.acknowledge"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  deliveryId: TaskEntityField,
  ...CasFields,
  acknowledgment: z.enum(["responsibility-acknowledged", "handled"]),
  reason: z.string().min(1).max(WIRE_LIMITS.deskTaskText).nullable(),
}).strict();

const ReconcileActionMark = z.object({
  actionId: TaskEntityField,
  outcome: z.enum(["observed", "failed", "abandoned", "still-uncertain"]),
  evidence: z.array(z.object({ kind: z.string().min(1).max(WIRE_LIMITS.deskCheckPointer), ref: z.string().min(1).max(WIRE_LIMITS.deskPathSurface) }).strict()).max(WIRE_LIMITS.deskBriefRefs),
  receipt: TaskJsonField.optional(),
}).strict();
const ReconcileResourceMark = z.object({
  resourceId: TaskEntityField,
  disposition: z.enum(["retained", "released"]),
  observedState: z.string().min(1).max(WIRE_LIMITS.deskTaskText).nullable(),
  positive: z.boolean(), quiescent: z.boolean(),
  evidence: z.array(z.object({ kind: z.string().min(1).max(WIRE_LIMITS.deskCheckPointer), ref: z.string().min(1).max(WIRE_LIMITS.deskPathSurface) }).strict()).max(WIRE_LIMITS.deskBriefRefs),
}).strict();
const ReconcileBindMark = z.object({
  attemptId: TaskEntityField,
  membershipId: z.string().uuid(),
  evidence: z.array(z.object({ kind: z.string().min(1).max(WIRE_LIMITS.deskCheckPointer), ref: z.string().min(1).max(WIRE_LIMITS.deskPathSurface) }).strict()).max(WIRE_LIMITS.deskBriefRefs),
}).strict();

const TaskReconcileCmd = z.object({
  kind: z.literal("task.reconcile"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  taskId: TaskEntityField.nullable(),
  expectedLedgerRevision: z.number().int().min(0).optional(),
  marks: z.array(ReconcileActionMark).max(WIRE_LIMITS.deskTaskReconcileMarks),
  resourceMarks: z.array(ReconcileResourceMark).max(WIRE_LIMITS.deskTaskReconcileMarks),
  attemptBinds: z.array(ReconcileBindMark).max(WIRE_LIMITS.deskTaskReconcileMarks),
  attemptStops: z.array(TaskEntityField).max(WIRE_LIMITS.deskTaskReconcileMarks),
  attemptSettles: z.array(TaskEntityField).max(WIRE_LIMITS.deskTaskReconcileMarks),
  observedLedgerRevision: z.number().int().min(0),
  releaseRulings: z.array(DeskTaskReleaseRuling).max(WIRE_LIMITS.deskTaskReconcileMarks),
  attemptRulings: z.array(DeskTaskAttemptRuling).max(WIRE_LIMITS.deskTaskReconcileMarks),
}).strict();

const TaskIntentCmd = z.object({
  kind: z.literal("task.effect.intent"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  taskId: TaskEntityField.nullable(), attemptId: TaskEntityField.nullable(), actionId: TaskEntityField.nullable(),
  resultId: TaskEntityField.nullable(),
  actionKind: DeskTaskActionKind, body: TaskJsonField,
}).strict();

const TaskIssueCmd = z.object({
  kind: z.literal("task.effect.issue"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  attemptId: TaskEntityField.nullable(), actionId: TaskEntityField, actionKind: DeskTaskActionKind.nullable(),
  dependencyObservation: DeskTaskDependencyObservation.nullable().optional(),
  cleanupIssueEvidence: DeskTaskIntegrationCleanupPreflightEvidence.optional(),
}).strict();

const TaskObserveCmd = z.object({
  kind: z.literal("task.effect.observe"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  taskId: TaskEntityField.nullable(), attemptId: TaskEntityField.nullable(), resultId: TaskEntityField.nullable(),
  actionId: TaskEntityField, actionKind: DeskTaskActionKind, receipt: DeskTaskEffectReceipt,
  cleanupObservation: DeskTaskIntegrationCleanupObservation.optional(),
}).strict();

const TaskBindCmd = z.object({
  kind: z.literal("task.effect.bind"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  attemptId: TaskEntityField,
  member: DeskTaskMemberPin,
  observed: z.object({
    provider: z.string().min(1).max(WIRE_LIMITS.providerLen),
    createCwd: z.string().min(1).max(WIRE_LIMITS.deskPathSurface).nullable().optional(),
    workspaceId: z.string().min(1).max(WIRE_LIMITS.workspaceIdLen).nullable().optional(),
  }).strict(),
}).strict();

const TaskIntegrationAdmitCmd = z.object({
  kind: z.literal("task.effect.integration-admit"), actorAgentId: TaskActor, actorMembershipId: z.string().uuid(), actorOpenGeneration: z.number().int().min(1), assignmentId: TaskEntityField, requestId: TaskRequestField,
  taskId: TaskEntityField, resultId: TaskEntityField,
  expectedResultRevision: z.number().int().min(0).optional(),
  expectedAdjudicationRevision: z.number().int().min(0).optional(),
  expectedLedgerRevision: z.number().int().min(0).optional(),
  grant: z.object({
    authorityRef: z.string().min(1).max(WIRE_LIMITS.deskAuthorityRef),
    paths: z.array(z.string().min(1).max(WIRE_LIMITS.deskPathSurface)).max(WIRE_LIMITS.deskBriefItems),
    target: z.object({ cwd: z.string().min(1).max(WIRE_LIMITS.deskPathSurface) }).strict().optional(),
  }).strict(),
  verification: z.object({ recipeIds: z.array(TaskEntityField).max(WIRE_LIMITS.deskCheckEvidence) }).strict().optional(),
  body: TaskJsonField,
}).strict();

const DeskTaskStoreCommand = z.discriminatedUnion("kind", [
  TaskDefineCmd, TaskUpdateCmd, TaskReserveCmd, TaskResultCmd, TaskRuleCmd, TaskHoldCmd, TaskStopCmd,
  TaskAcknowledgeCmd, TaskReconcileCmd, TaskIntentCmd, TaskIssueCmd, TaskObserveCmd,
  TaskBindCmd, TaskIntegrationAdmitCmd,
]);
type StoreCmd = z.infer<typeof DeskTaskStoreCommand>;

const reject = (code: DeskRejectionValue["code"], message: string, recovery: string): DeskRejectionValue => ({
  ok: false, code, message, recovery,
});
const decided = (events: { kind: string; payload: Record<string, unknown> }[], taskEntries: TaskEntry[]): Extract<DecideOutcome, { ok: true }> => ({
  ok: true, events, taskEntries,
});

/** Operative brief revision for an assignment — mirrors the scope module's
 *  private helper; the bind compose passes it through decideDeskScope's own
 *  brief pins rather than trusting a caller-supplied value. */
function currentBriefRevision(ledger: Readonly<LedgerValue>, assignmentId: string): number {
  return ledger.briefRevisions.filter(row => row.assignmentId === assignmentId).reduce((max, row) => Math.max(max, row.revision), 0);
}

function entryEvent(row: TaskEntry): { kind: string; payload: Record<string, unknown> } {
  return {
    kind: "task-entry-appended",
    payload: {
      entryId: row.entryId, entityId: row.entityId, entryKind: row.kind,
      revision: row.revision, entrySha256: row.entrySha256, taskId: row.taskId,
      actorMembershipId: row.actorMembershipId,
      briefRevision: row.briefRevision, ownershipRevision: row.ownershipRevision,
    },
  };
}

/** Builds the next immutable revision for an entity. The stamp binds the
 *  actor tuple, ownership revision and brief revision at commit time. */
const STAMP_KEYS = new Set([
  "entryId", "assignmentId", "entityId", "revision", "priorEntryId", "priorEntrySha256",
  "entrySha256", "requestId", "actorAgentId", "actorMembershipId", "ownershipRevision", "briefRevision",
]);

function nextEntry<T extends TaskEntry>(
  actor: MembershipValue,
  ledger: Readonly<LedgerValue>,
  assignmentId: string,
  requestId: string,
  entityId: string,
  prior: TaskEntry | null,
  fields: Record<string, unknown>,
): T {
  const revision = (prior?.revision ?? 0) + 1;
  // Callers spread the prior row for carried fields — the fresh stamp always
  // wins over any stale stamp keys that spread carried along.
  const cleaned = Object.fromEntries(Object.entries(fields).filter(([key]) => !STAMP_KEYS.has(key)));
  const without = {
    ...cleaned,
    entryId: deriveId("te", [actor.membershipId, requestId, entityId, String(revision)]),
    assignmentId,
    entityId,
    revision,
    priorEntryId: prior?.entryId ?? null,
    priorEntrySha256: prior?.entrySha256 ?? null,
    requestId,
    actorAgentId: actor.agentId as string,
    actorMembershipId: actor.membershipId,
    ownershipRevision: ownershipRevisionOf(ledger, assignmentId),
    briefRevision: briefRevisionOf(ledger, assignmentId),
  };
  return { ...without, entrySha256: canonicalSha256(without) } as T;
}

function newDelivery(actor: MembershipValue, ledger: Readonly<LedgerValue>, requestId: string,
  taskId: string, assignmentId: string, recipient: {agentId: string; membershipId: string},
  kind: DeskTaskDeliveryEntryValue["deliveryKind"], attemptId: string, actionId: string | null, resultId: string | null,
  bodySha256: string | null): DeskTaskDeliveryEntryValue {
  const id = deriveId("dlv", [assignmentId, requestId, kind]);
  return nextEntry(actor, ledger, assignmentId, requestId, id, null, { kind: "delivery", taskId, deliveryId: id,
    deliveryKind: kind, senderAgentId: actor.agentId, senderMembershipId: actor.membershipId,
    recipientAgentId: recipient.agentId, recipientMembershipId: recipient.membershipId, bodySha256, bodyRef: null,
    actionId, attemptId, resultId, state: "pending", ackEvidence: [], handlingEvidence: null, reason: null });
}

function fitsEntry(row: TaskEntry): boolean {
  const { entrySha256: _drop, ...rest } = row as Record<string, unknown>;
  return Buffer.byteLength(canonicalJson(rest), "utf8") <= WIRE_LIMITS.deskTaskEntryBytes;
}

function checkCas(ledger: Readonly<LedgerValue>, assignmentId: string, cmd: Record<string, unknown>, currentTask?: { revision: number }): DeskRejectionValue | null {
  if (typeof cmd.expectedLedgerRevision === "number" && cmd.expectedLedgerRevision !== ledger.revision) {
    return reject("REVISION_CONFLICT", `expected ledger revision ${cmd.expectedLedgerRevision} but the current revision is ${ledger.revision}`, "re-read the ledger and retry with its current revision");
  }
  if (typeof cmd.expectedBriefRevision === "number") {
    const current = briefRevisionOf(ledger, assignmentId);
    if (cmd.expectedBriefRevision !== current) {
      return reject("REVISION_CONFLICT", `expected brief revision ${cmd.expectedBriefRevision} but the current revision is ${current}`, "re-read the brief and retry the intended change");
    }
  }
  if (typeof cmd.expectedOwnershipRevision === "number") {
    const current = ownershipRevisionOf(ledger, assignmentId);
    if (cmd.expectedOwnershipRevision !== current) {
      return reject("REVISION_CONFLICT", `expected ownership revision ${cmd.expectedOwnershipRevision} but the current revision is ${current}`, "re-resolve the current owner and retry under the latest tuple");
    }
  }
  if (typeof cmd.expectedTaskRevision === "number" && currentTask !== undefined && cmd.expectedTaskRevision !== currentTask.revision) {
    return reject("REVISION_CONFLICT", `expected task revision ${cmd.expectedTaskRevision} but the current revision is ${currentTask.revision}`, "re-read the task and retry with its current revision");
  }
  return null;
}

/** Capacity headroom: ordinary commits must leave the recovery slice free
 *  so a reconcile/settle write can always land; recovery ops may use it. */
function entryHeadroom(ledger: Readonly<LedgerValue>, needed: number, recovery: boolean): DeskRejectionValue | null {
  const limit = recovery ? LEDGER_LIMITS.taskEntries : LEDGER_LIMITS.taskEntries - WIRE_LIMITS.deskTaskRecoveryEntries;
  if (ledger.taskEntries.length + needed > limit) {
    return reject("INVALID_RECORD", `taskEntries capacity would be exceeded (${ledger.taskEntries.length}+${needed} over ${limit})`, "the task history is bounded; settle or archive finished work before opening more");
  }
  return null;
}

function measurePinOf(value: unknown): DeskTaskMeasurePinValue | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const sha = typeof record.snapshotSha256 === "string" ? record.snapshotSha256 : typeof record.sha256 === "string" ? record.sha256 : null;
  if (sha === null || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return {
    snapshotSha256: sha,
    head: typeof record.head === "string" ? record.head : null,
    root: typeof record.root === "string" ? record.root : "",
    kind: record.kind === "content-map" ? "content-map" : record.kind === "git-reference" ? "git-reference" : "git-snapshot",
    measuredAt: typeof record.measuredAt === "string" ? record.measuredAt : "1970-01-01T00:00:00.000Z",
    incomplete: Array.isArray(record.incomplete) ? record.incomplete.filter(item => typeof item === "string") : [],
    artifactSha256: typeof record.artifactSha256 === "string" ? record.artifactSha256 : null,
  };
}

function sameRecoveryPlan(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return (left ?? null) === (right ?? null);
  return DeskTaskIntegrationRecoveryPlan.safeParse(left).success &&
    DeskTaskIntegrationRecoveryPlan.safeParse(right).success && canonicalJson(left) === canonicalJson(right);
}

/** Server-owned proof path for the one immutable inventory bundle attached to
 *  an integration action. It stays beside the stage but outside both
 *  removable stage and backup roots. */
export function taskIntegrationCleanupArtifactPath(stageDir: string): string {
  return join(dirname(stageDir), "cleanup-account.v1.json");
}

/** Canonical durable bytes used by both the adapter and Core. The bundle is
 *  bounded/strict before serialization; no per-file ledger rows are created. */
export function taskIntegrationCleanupBundleBytes(bundleValue: unknown): Uint8Array {
  const parsed = DeskTaskIntegrationCleanupBundle.parse(bundleValue);
  return Buffer.from(canonicalJson(parsed), "utf8");
}

/** The immutable source-control digest names the original request and action
 *  entry. Stage admission has no phase action revision; this recipe preserves
 *  its actual event/request provenance instead of inventing one. */
export function taskIntegrationCleanupSourceControlDigest(
  admission: Pick<DeskTaskActionEntryValue, "requestId" | "entryId" | "entrySha256" | "body">,
  requestBodySha256: string,
  grantRef: string | null,
): string {
  return canonicalSha256({
    domain: "paseo-slp/task-integration-cleanup-source-controls/v1",
    requestId: admission.requestId,
    requestBodySha256,
    entry: { entryId: admission.entryId, entrySha256: admission.entrySha256 },
    grantRef,
    controlPins: admission.body?.controlPins ?? null,
  });
}

/** The adapter and Core use one canonical digest for the current cleanup
 *  request admission. Immutable source controls remain in the Candidate and
 *  are never replaced by a continuation's current CAS tuple. */
export function taskIntegrationCleanupAdmissionSha256(admission: DeskTaskIntegrationCleanupObserverAdmission): string {
  return canonicalSha256({ domain: "paseo-slp/task-integration-cleanup-public-admission/v1", admission });
}

function integrationEntryRef(row: Pick<TaskEntry, "entryId" | "entrySha256">): DeskTaskIntegrationEntryRefValue {
  return { entryId: row.entryId, entrySha256: row.entrySha256 };
}

function findEntryByRef(ledger: Readonly<LedgerValue>, ref: unknown): TaskEntry | undefined {
  const parsed = DeskTaskIntegrationEntryRef.safeParse(ref);
  if (!parsed.success) return undefined;
  return ledger.taskEntries.find(row => row.entryId === parsed.data.entryId && row.entrySha256 === parsed.data.entrySha256);
}

function requestBodySha256ForEntry(ledger: Readonly<LedgerValue>, row: TaskEntry): string | null {
  const request = ledger.requests.find(candidate => candidate.assignmentId === row.assignmentId &&
    candidate.actorKey === `agent:${row.actorAgentId}` && candidate.requestId === row.requestId);
  return request?.bodySha256 ?? null;
}

function integrationResourceRows(
  ledger: Readonly<LedgerValue>, action: DeskTaskActionEntryValue,
): DeskTaskResourceEntryValue[] | null {
  const ids = action.resourceIds;
  if (ids === null || new Set(ids).size !== ids.length) return null;
  const rows = ids.map(id => latestTaskEntity<DeskTaskResourceEntryValue>(ledger, id));
  if (rows.some(row => row?.kind !== "resource" || row.assignmentId !== action.assignmentId || row.taskId !== action.taskId || row.actionId !== action.actionId)) return null;
  return rows as DeskTaskResourceEntryValue[];
}

type CleanupSourceAdmission = {
  admission: DeskTaskActionEntryValue;
  proof: DeskTaskActionEntryValue;
  requestBodySha256: string;
  grantRef: string;
  sourceControlSha256: string;
  sourceProofKind: "stage-observed" | "full-applied" | "original";
};

function measureContentEqual(left: DeskTaskMeasurePinValue, right: DeskTaskMeasurePinValue): boolean {
  return left.root === right.root && left.head === right.head && left.kind === right.kind &&
    left.snapshotSha256 === right.snapshotSha256 && canonicalJson(left.incomplete) === canonicalJson(right.incomplete) &&
    left.artifactSha256 === right.artifactSha256;
}

function cleanupSourceAdmission(
  ledger: Readonly<LedgerValue>, action: DeskTaskActionEntryValue, basis: "stage-only" | "land-recovery",
): CleanupSourceAdmission | DeskRejectionValue {
  const grantRef = action.grant?.authorityRef;
  if (grantRef === undefined || grantRef === null) return reject("AUTHORITY_REQUIRED", "cleanup source has no admitted integration grant", "retain the stage/target until an exact cleanup grant exists");
  const history = ledger.taskEntries.filter((row): row is DeskTaskActionEntryValue => row.kind === "action" && row.actionId === action.actionId);
  let admission: DeskTaskActionEntryValue | undefined;
  let proof: DeskTaskActionEntryValue | undefined;
  let sourceProofKind: CleanupSourceAdmission["sourceProofKind"];
  if (basis === "stage-only") {
    admission = history.find(row => row.revision === 1 && row.phase === "stage" && row.actionKind === "integration");
    proof = history.filter(row => row.phase === "stage" && row.stageDir === action.stageDir && row.receipt?.phase === "stage" && row.receipt.status === "observed")
      .sort((a, b) => b.revision - a.revision)[0];
    sourceProofKind = "stage-observed";
  } else {
    admission = history.find(row => row.phase === "land" && row.state === "intended" && row.body?.phase === "land" &&
      sameRecoveryPlan(row.body.recoveryPlan, action.recoveryPlan ?? null));
    proof = history.filter(row => (row.receipt?.phase === "land" || row.receipt?.phase === "reconcile") &&
      row.receipt.status === "observed" && row.receipt.backupIntegrity === true &&
      (row.receipt.recoveryClassification === "full-applied" || row.receipt.recoveryClassification === "original") &&
      sameRecoveryPlan(row.receipt.recoveryPlan, action.recoveryPlan ?? null))
      .sort((a, b) => b.revision - a.revision)[0];
    const classification = proof?.receipt?.recoveryClassification;
    if (classification !== "full-applied" && classification !== "original") {
      return reject("EVIDENCE_INCOMPLETE", "cleanup source has no exact full/original LAND proof", "reconcile the immutable LAND plan before verifying cleanup");
    }
    sourceProofKind = classification;
  }
  if (admission === undefined || proof === undefined) return reject("EVIDENCE_INCOMPLETE", "cleanup source admission/proof entry is absent from action history", "retain the resource and identify exact immutable admission receipts");
  const requestBodySha256 = requestBodySha256ForEntry(ledger, admission);
  if (requestBodySha256 === null) return reject("EVIDENCE_INCOMPLETE", "cleanup source request digest is absent", "retain the resource; source controls require the original request receipt");
  return {
    admission, proof, requestBodySha256, grantRef, sourceProofKind,
    sourceControlSha256: taskIntegrationCleanupSourceControlDigest(admission, requestBodySha256, grantRef),
  };
}

function cleanupSourcePins(action: DeskTaskActionEntryValue): { sourceBase: DeskTaskMeasurePinValue; sourceResult: DeskTaskMeasurePinValue } | DeskRejectionValue {
  const sourceBase = DeskTaskMeasurePin.safeParse(action.sourceBase);
  const sourceResult = DeskTaskMeasurePin.safeParse(action.sourceResult);
  if (!sourceBase.success || !sourceResult.success || sourceBase.data.incomplete.length !== 0 || sourceResult.data.incomplete.length !== 0 ||
      sourceBase.data.artifactSha256 === null || sourceResult.data.artifactSha256 === null) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup has no complete byte-pinned immutable BASE and RESULT source maps", "retain all resources; restore or remeasure only the exact retained source artifacts under the existing source guards");
  }
  return { sourceBase: sourceBase.data, sourceResult: sourceResult.data };
}

function cleanupObserverAdmission(
  ledger: Readonly<LedgerValue>, action: DeskTaskActionEntryValue, trigger: DeskTaskIntegrationCleanupTriggerValue,
  preflight = false,
): DeskTaskIntegrationCleanupObserverAdmission | DeskRejectionValue {
  const body = action.body;
  if (body === null || body.phase !== "discharge" || action.phase !== "discharge") {
    return reject("REVISION_CONFLICT", "cleanup trigger has no current discharge intent", "re-read the action and use the exact admitted cleanup phase");
  }
  const expectedBodyStep = trigger.cleanupStep === "reconcile-progress" ? "remove-resource" : trigger.cleanupStep;
  if (body.cleanupStep !== expectedBodyStep) return reject("REVISION_CONFLICT", "cleanup trigger step differs from the immutable admitted action body", "use the action's exact verification or resource permit phase");
  const grantRef = action.grant?.authorityRef;
  if (grantRef === undefined || grantRef === null) return reject("AUTHORITY_REQUIRED", "cleanup action has no admitted integration grant", "retain all resources until exact grant provenance resolves");
  const sourceControlPins = DeskTaskIntegrationControlPins.safeParse(body.controlPins);
  if (trigger.phase === "discharge") {
    if (!sourceControlPins.success || canonicalJson(sourceControlPins.data) !== canonicalJson(trigger.controlPins) ||
        body.publicRequestId !== trigger.publicRequestId || body.publicRequestSha256 !== trigger.publicRequestSha256 ||
        body.grantRef !== action.grant?.authorityRef) {
      return reject("REVISION_CONFLICT", "discharge trigger differs from its original public request/control/grant admission", "repeat only the exact admitted current discharge request");
    }
    const intent = ledger.taskEntries.filter((row): row is DeskTaskActionEntryValue => row.kind === "action" && row.actionId === action.actionId &&
      row.phase === "discharge" && row.state === "intended" && row.bodySha256 === action.bodySha256 &&
      canonicalJson(row.body) === canonicalJson(action.body)).sort((a, b) => b.revision - a.revision)[0];
    if (intent === undefined || (preflight ? action.state !== "intended" : action.state !== "issued")) return reject("EVIDENCE_INCOMPLETE", "cleanup discharge has no exact issued intent lineage", "retain resources until the matching phase issue is read back");
    if (preflight) return {
      phase: "discharge", publicRequestId: trigger.publicRequestId, publicRequestSha256: trigger.publicRequestSha256,
      grantRef, controlPins: trigger.controlPins, intentRef: integrationEntryRef(intent), issueRef: null,
    };
    return {
      phase: "discharge", publicRequestId: trigger.publicRequestId, publicRequestSha256: trigger.publicRequestSha256,
      grantRef, controlPins: trigger.controlPins,
      intentRef: integrationEntryRef(intent), issueRef: integrationEntryRef(action),
    };
  }
  if (preflight || action.state !== "issued") return reject("REVISION_CONFLICT", "cleanup continuation is not a fresh issued-action reconciliation", "only reconcile an exact in-flight cleanup issue under current public control pins");
  return {
    phase: "reconcile", publicRequestId: trigger.publicRequestId, publicRequestSha256: trigger.publicRequestSha256,
    grantRef: null, controlPins: trigger.controlPins, intentRef: null, issueRef: integrationEntryRef(action),
  };
}

function cleanupVerificationRef(ledger: Readonly<LedgerValue>, action: DeskTaskActionEntryValue): DeskTaskIntegrationEntryRefValue | DeskRejectionValue {
  const row = ledger.taskEntries.filter((entry): entry is DeskTaskActionEntryValue => entry.kind === "action" && entry.actionId === action.actionId &&
    entry.cleanupVerification != null).sort((a, b) => a.revision - b.revision)[0];
  if (row === undefined || !DeskTaskIntegrationCleanupVerification.safeParse(row.cleanupVerification).success) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup resource has no immutable verified-account history reference", "verify and read back the account before permitting any removal");
  }
  return integrationEntryRef(row);
}

function exactCleanupArtifactBytes(
  deps: TaskRunnerDeps, candidate: DeskTaskIntegrationCleanupCandidateValue,
): Uint8Array | DeskRejectionValue {
  const transient = deps.cleanupArtifactBytes;
  if (transient === undefined) return reject("CAPABILITY_GAP", "this cleanup verification call has no transient candidate artifact bytes", "supply only the exact in-memory bytes for this admitted verify-account candidate");
  if (transient.bytes.byteLength > 64 * 1024 * 1024 || transient.candidateSha256 !== canonicalSha256(candidate) ||
      transient.bytes.byteLength !== candidate.artifact.bytes || sha256Hex(transient.bytes) !== candidate.artifact.artifactSha256) {
    return reject("EVIDENCE_INCOMPLETE", "transient candidate bytes do not match the exact admitted artifact hash/length", "retain all resources; resend only the candidate's bounded canonical bytes");
  }
  return transient.bytes;
}

function validateCleanupCandidate(
  ledger: Readonly<LedgerValue>, action: DeskTaskActionEntryValue, candidateValue: unknown,
): { candidate: DeskTaskIntegrationCleanupCandidateValue; source: CleanupSourceAdmission; resources: DeskTaskResourceEntryValue[] } | DeskRejectionValue {
  const parsed = DeskTaskIntegrationCleanupCandidate.safeParse(candidateValue);
  if (!parsed.success) return reject("INVALID_RECORD", "cleanup candidate does not match the strict Core schema", "send the exact bounded stage-only or land-recovery candidate");
  const candidate = parsed.data;
  if (candidate.actionId !== action.actionId || candidate.artifact.path !== taskIntegrationCleanupArtifactPath(action.stageDir ?? "") ||
      candidate.artifact.bytes > 64 * 1024 * 1024) return reject("EVIDENCE_INCOMPLETE", "cleanup artifact path or action identity is not the server-owned integration path", "use the Core-derived action-local bundle path and bounded bytes");
  const source = cleanupSourceAdmission(ledger, action, candidate.basis);
  if ("ok" in source) return source;
  const proofTarget = candidate.basis === "stage-only" ? action.target :
    (source.proof.landed ?? measurePinOf(source.proof.receipt?.recoveredLand) ??
      measurePinOf(source.proof.receipt?.target) ?? measurePinOf(source.proof.receipt?.final) ?? action.target);
  if (candidate.targetBefore.incomplete.length !== 0 || candidate.targetBefore.root !== action.targetCwd ||
      proofTarget === null || !measureContentEqual(candidate.targetBefore, proofTarget)) {
    return reject("CANDIDATE_DRIFT", "cleanup target-before pin differs from the exact admitted target proof", "refresh and re-admit only while the immutable target/source pins still match");
  }
  if (candidate.sourceAdmissionRef.entryId !== source.admission.entryId) return reject("EVIDENCE_INCOMPLETE", "cleanup candidate source admission entry ID differs from the original integration action", "rebuild only from the exact immutable revision-1 admission entry");
  if(candidate.sourceAdmissionRef.entrySha256!==source.admission.entrySha256)return reject("EVIDENCE_INCOMPLETE","cleanup candidate source admission hash differs from the original integration action","rebuild only from the exact immutable revision-1 admission entry");
  if(candidate.sourceProofRef.entryId!==source.proof.entryId || candidate.sourceProofRef.entrySha256!==source.proof.entrySha256) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup candidate source proof ref differs from the latest positive full/original LAND history row", "rebuild the exact admitted recovery classification reference");
  }
  if(candidate.sourceProofKind!==source.sourceProofKind || candidate.sourceGrantRef!==source.grantRef) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup candidate source proof kind/grant differs from the immutable admission", "retain resources and use only the exact original source grant and proof classification");
  }
  if(candidate.sourceControlSha256!==source.sourceControlSha256) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup candidate source-control digest differs from the original request record", "rebuild the digest from the exact original request body hash, action row and source grant");
  }
  const resources = integrationResourceRows(ledger, action);
  if (resources === null) return reject("EVIDENCE_INCOMPLETE", "cleanup resource rows do not resolve exactly", "retain all obligations and reconcile exact resource history");
  const expected = candidate.resources;
  if (resources.length !== expected.length || resources.some((row, index) => {
    const pin = expected[index]!;
    const expectedKind = pin.resourceKind === "worktree" ? "worktree" : "scratch";
    return row.resourceId !== pin.resourceId || row.revision !== pin.resourceRevision || row.resourceKey !== pin.resourceKey ||
      row.resourceKind !== expectedKind || row.disposition !== "retained";
  })) return reject("REVISION_CONFLICT", "cleanup candidate resource IDs/revisions/keys differ from current retained rows", "read fresh resources and preserve the exact inventory source pins");
  if (candidate.basis === "stage-only") {
    const everIssuedLand = historyHasIssuedLand(ledger, action.actionId);
    if (action.recoveryPlan != null || action.backupDir !== null || action.landIntent !== null || action.landed !== null || everIssuedLand ||
        resources.length !== 1 || resources[0]!.resourceKey !== action.stageDir || candidate.recoveryPlanSha256 !== null) {
      return reject("CAPABILITY_GAP", "stage-only cleanup cannot carry any issued LAND or backup provenance", "retain the action and use only a proven stage-only account");
    }
  } else {
    if (action.recoveryPlan == null || candidate.recoveryPlanSha256 !== canonicalSha256(action.recoveryPlan) || resources.length !== 2 ||
        expected[0]!.resourceKey !== action.recoveryPlan.stageDir || expected[1]!.resourceKey !== action.recoveryPlan.backupDir) {
      return reject("RECOVERY_REQUIRED", "LAND cleanup candidate differs from the immutable two-resource recovery plan", "retain the target fence and use the original admitted plan");
    }
  }
  return { candidate, source, resources };
}

function historyHasIssuedLand(ledger: Readonly<LedgerValue>, actionId: string): boolean {
  return ledger.taskEntries.some(row => row.kind === "action" && row.actionId === actionId && row.phase === "land" &&
    (row.state === "issued" || row.state === "uncertain" || row.state === "observed" || row.state === "held" || row.state === "failed"));
}

type VerifiedCleanupBundle = {
  bundle: DeskTaskIntegrationCleanupBundleValue;
  bytes: Uint8Array;
  status: "observed" | "held";
  observerResponseSha256: string;
  resources: DeskTaskIntegrationCleanupResourceObservationValue[];
};

function verifyCleanupBundleObservation(
  candidate: DeskTaskIntegrationCleanupCandidateValue,
  responseValue: unknown,
  expectedAdmissionSha256: string,
  candidateArtifactBytes: Uint8Array | null,
  expectedSourceBase: DeskTaskMeasurePinValue,
  expectedSourceResult: DeskTaskMeasurePinValue,
  purpose: DeskTaskIntegrationCleanupObserverResponseValue["purpose"],
  progressKind: DeskTaskIntegrationCleanupObserverResponseValue["progressKind"],
): VerifiedCleanupBundle | DeskRejectionValue {
  const parsedResponse = DeskTaskIntegrationCleanupObserverResponse.safeParse(responseValue);
  if (!parsedResponse.success) return reject("INVALID_RECORD", "cleanup observer response is not the strict Core response shape", "retain all resources and return complete bounded inventory evidence");
  const response = parsedResponse.data;
  if (response.purpose !== purpose || response.progressKind !== progressKind || response.admissionSha256 !== expectedAdmissionSha256 ||
      response.sourceProofRef.entryId !== candidate.sourceProofRef.entryId || response.sourceProofRef.entrySha256 !== candidate.sourceProofRef.entrySha256 ||
      response.sourceProofKind !== candidate.sourceProofKind || response.target === null || !measureContentEqual(response.target, candidate.targetBefore)) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup observer source, target or public admission digest differs from the pinned candidate", "retain the target fence and reconcile exact source/target history");
  }
  if (expectedSourceBase.incomplete.length !== 0 || expectedSourceResult.incomplete.length !== 0 ||
      expectedSourceBase.artifactSha256 === null || expectedSourceResult.artifactSha256 === null ||
      response.sourceBase === null || response.sourceResult === null ||
      response.sourceBase.incomplete.length !== 0 || response.sourceResult.incomplete.length !== 0 ||
      !measureContentEqual(response.sourceBase, expectedSourceBase) || !measureContentEqual(response.sourceResult, expectedSourceResult)) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup observer did not freshly verify the byte-pinned historical BASE and RESULT source maps", "retain every resource and target fence; verify original BASE artifacts and current source RESULT against their admitted pins");
  }
  if (response.resources.length !== candidate.resources.length) return reject("EVIDENCE_INCOMPLETE", "cleanup observer omitted an admitted resource inventory", "measure every exact stage/backup resource before cleanup");
  const bundleResources: { pin: DeskTaskIntegrationCleanupResourcePinValue; entries: DeskTaskIntegrationCleanupInventoryEntryValue[] }[] = [];
  const summaries: DeskTaskIntegrationCleanupResourceObservationValue[] = [];
  for (let index = 0; index < candidate.resources.length; index += 1) {
    const pin = candidate.resources[index]!;
    const observed = response.resources[index]!;
    if (observed.resourceId !== pin.resourceId || observed.resourceRevision !== pin.resourceRevision ||
        observed.resourceKey !== pin.resourceKey || observed.resourceKind !== pin.resourceKind ||
        canonicalJson(observed.gitRegistration) !== canonicalJson(pin.gitRegistration)) {
      return reject("EVIDENCE_INCOMPLETE", "cleanup observer resource identity/revision/registration differs from the immutable account", "retain the resource and verify the exact issued permit lineage");
    }
    const entries = observed.entries;
    const paths = entries.map(entry => entry.path);
    if (entries.length !== pin.entryCount || entries[0]?.path !== "." || entries[0]?.kind !== "directory" ||
        entries[0].mode !== pin.rootMode || new Set(paths).size !== paths.length ||
        paths.some((path, pathIndex) => pathIndex > 0 && Buffer.compare(Buffer.from(paths[pathIndex - 1]!), Buffer.from(path)) >= 0)) {
      return reject("EVIDENCE_INCOMPLETE", "cleanup inventory is incomplete, unsorted or has a mismatched root mode", "retain the resource and capture the complete no-follow inventory");
    }
    const contentBytes = entries.reduce((total, entry) => total + (entry.kind === "file" || entry.kind === "symlink" ? entry.bytes : 0), 0);
    const mapSha256 = sha256Hex(Buffer.from(canonicalJson(entries), "utf8"));
    if (contentBytes !== pin.contentBytes || mapSha256 !== pin.inventoryMapSha256 || observed.rootMode !== pin.rootMode) {
      return reject("EVIDENCE_INCOMPLETE", "cleanup inventory bytes/mode do not match the immutable account", "retain the resource; no removal is authorized from changed content");
    }
    bundleResources.push({ pin, entries });
    summaries.push({
      resourceId: pin.resourceId,
      resourceRevision: pin.resourceRevision,
      resourceKey: pin.resourceKey,
      expectedInventoryMapSha256: pin.inventoryMapSha256,
      observedInventoryMapSha256: mapSha256,
      expectedEntryCount: pin.entryCount,
      observedEntryCount: entries.length,
      missingPathsSha256: null,
      missingPathCount: 0,
      survivorMapSha256: mapSha256,
      survivorEntryCount: entries.length,
      rootMode: observed.rootMode,
      gitRegistration: pin.resourceKind === "worktree" ? "matched" : "not-applicable",
    });
  }
  const bundleValue = {
    version: 1 as const,
    modeSemantics: "actual-filesystem-bits" as const,
    actionId: candidate.actionId,
    basis: candidate.basis,
    recoveryPlanSha256: candidate.recoveryPlanSha256,
    sourceAdmissionRef: candidate.sourceAdmissionRef,
    sourceProofRef: candidate.sourceProofRef,
    sourceProofKind: candidate.sourceProofKind,
    sourceGrantRef: candidate.sourceGrantRef,
    sourceControlSha256: candidate.sourceControlSha256,
    targetBefore: candidate.targetBefore,
    resources: bundleResources,
  };
  const parsedBundle = DeskTaskIntegrationCleanupBundle.safeParse(bundleValue);
  if (!parsedBundle.success) return reject("INVALID_RECORD", "complete cleanup bundle does not match its strict shared schema", "retain resources and correct the exact inventory representation");
  const bytes = taskIntegrationCleanupBundleBytes(parsedBundle.data);
  const bundleSha256 = sha256Hex(bytes);
  if (candidate.artifact.mode !== 0o600 || candidate.artifact.bytes !== bytes.byteLength ||
      candidate.artifact.artifactSha256 !== bundleSha256 || candidate.artifact.bundleSha256 !== canonicalSha256(parsedBundle.data) ||
      candidateArtifactBytes === null || Buffer.compare(Buffer.from(candidateArtifactBytes), Buffer.from(bytes)) !== 0) {
    return reject("EVIDENCE_INCOMPLETE", "in-memory cleanup bundle differs from the immutable candidate bytes", "retain resources and use only the exact pinned proof bytes");
  }
  const persisted = response.artifact.path === candidate.artifact.path && response.artifact.kind === "regular" && response.artifact.mode === 0o600 &&
    response.artifact.bytes !== null && Buffer.compare(Buffer.from(response.artifact.bytes), Buffer.from(bytes)) === 0 &&
    sha256Hex(response.artifact.bytes) === candidate.artifact.artifactSha256 && response.artifact.bytes.byteLength === candidate.artifact.bytes;
  const recoverablePrefix = response.artifact.path === candidate.artifact.path && response.artifact.kind === "regular" && response.artifact.mode === 0o600 &&
    response.artifact.bytes !== null && response.artifact.bytes.byteLength < bytes.byteLength &&
    Buffer.compare(Buffer.from(response.artifact.bytes), Buffer.from(bytes.subarray(0, response.artifact.bytes.byteLength))) === 0;
  const recoverableMissing = response.artifact.path === candidate.artifact.path && response.artifact.kind === "missing" &&
    response.artifact.mode === null && response.artifact.bytes === null;
  if (!persisted && !recoverablePrefix && !recoverableMissing) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup bundle is noncanonical or its persisted bytes are not a recoverable exact prefix", "retain resources and use only the one bounded verification continuation");
  }
  const status: VerifiedCleanupBundle["status"] = persisted ? "observed" : "held";
  const observerResponseSha256 = canonicalSha256({
    domain: "paseo-slp/task-integration-cleanup-observer-response/v1",
    version: response.version,
    purpose: response.purpose,
    progressKind: response.progressKind,
    admissionSha256: response.admissionSha256,
    artifact: { path: response.artifact.path, kind: response.artifact.kind, mode: response.artifact.mode,
      bytes: response.artifact.bytes?.byteLength ?? null, sha256: response.artifact.bytes === null ? null : sha256Hex(response.artifact.bytes) },
    target: response.target,
    sourceBase: response.sourceBase,
    sourceResult: response.sourceResult,
    sourceProofRef: response.sourceProofRef,
    sourceProofKind: response.sourceProofKind,
    resources: response.resources.map((resource, index) => ({
      resourceId: resource.resourceId,
      resourceRevision: resource.resourceRevision,
      resourceKey: resource.resourceKey,
      resourceKind: resource.resourceKind,
      rootMode: resource.rootMode,
      inventoryMapSha256: summaries[index]!.observedInventoryMapSha256,
      entryCount: resource.entries.length,
      gitRegistration: resource.gitRegistration,
    })),
  });
  return { bundle: parsedBundle.data, bytes, status, observerResponseSha256, resources: summaries };
}

type CleanupIssuedPermit = { permit: DeskTaskIntegrationCleanupPermitValue; row: DeskTaskActionEntryValue };

function latestIssuedCleanupPermit(
  ledger: Readonly<LedgerValue>, actionId: string, resourceId: string,
): CleanupIssuedPermit | null {
  const row = ledger.taskEntries.filter((entry): entry is DeskTaskActionEntryValue => entry.kind === "action" && entry.actionId === actionId &&
    entry.phase === "discharge" && entry.state === "issued" && entry.body?.cleanupStep === "remove-resource")
    .sort((a, b) => b.revision - a.revision)
    .find(entry => DeskTaskIntegrationCleanupPermit.safeParse(entry.body?.permit).success &&
      (entry.body!.permit as { resourceId?: unknown }).resourceId === resourceId);
  if (row === undefined) return null;
  const parsed = DeskTaskIntegrationCleanupPermit.safeParse(row.body?.permit);
  return parsed.success ? { permit: parsed.data, row } : null;
}

type VerifiedCleanupResourceProgress = {
  target: DeskTaskMeasurePinValue;
  resources: DeskTaskIntegrationCleanupResourceObservationValue[];
  observerResponseSha256: string;
  targetResourceRemoved: boolean;
};

function verifyCleanupResourceProgress(
  ledger: Readonly<LedgerValue>, action: DeskTaskActionEntryValue,
  verification: DeskTaskIntegrationCleanupVerificationValue,
  permit: DeskTaskIntegrationCleanupPermitValue,
  responseValue: unknown,
  expectedAdmissionSha256: string,
  expectedSourceBase: DeskTaskMeasurePinValue,
  expectedSourceResult: DeskTaskMeasurePinValue,
  purpose: DeskTaskIntegrationCleanupObserverResponseValue["purpose"],
  progressKind: "resource-preflight" | "resource",
  priorIssuedPermit: CleanupIssuedPermit | null,
  currentIssuedPermit: CleanupIssuedPermit | null,
): VerifiedCleanupResourceProgress | DeskRejectionValue {
  const parsedResponse = DeskTaskIntegrationCleanupObserverResponse.safeParse(responseValue);
  if (!parsedResponse.success) return reject("INVALID_RECORD", "cleanup resource observer response is not the strict Core shape", "retain the resource and reconcile bounded inventory/source evidence");
  const response = parsedResponse.data;
  const candidate = verification.candidate;
  if (response.purpose !== purpose || response.progressKind !== progressKind || response.admissionSha256 !== expectedAdmissionSha256 ||
      response.sourceProofRef.entryId !== candidate.sourceProofRef.entryId || response.sourceProofRef.entrySha256 !== candidate.sourceProofRef.entrySha256 ||
      response.sourceProofKind !== candidate.sourceProofKind || response.target === null || !measureContentEqual(response.target, candidate.targetBefore) ||
      response.sourceBase === null || response.sourceResult === null || response.sourceBase.incomplete.length !== 0 || response.sourceResult.incomplete.length !== 0 ||
      expectedSourceBase.incomplete.length !== 0 || expectedSourceResult.incomplete.length !== 0 || expectedSourceBase.artifactSha256 === null ||
      expectedSourceResult.artifactSha256 === null || !measureContentEqual(response.sourceBase, expectedSourceBase) ||
      !measureContentEqual(response.sourceResult, expectedSourceResult)) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup preflight/reconcile lacks the exact source BASE, current RESULT or target measure pins", "retain every resource and target fence; remeasure only the admitted source artifacts and actual result checkout");
  }
  if (response.artifact.path !== candidate.artifact.path || response.artifact.kind !== "regular" || response.artifact.mode !== 0o600 ||
      response.artifact.bytes === null || response.artifact.bytes.byteLength !== candidate.artifact.bytes ||
      sha256Hex(response.artifact.bytes) !== candidate.artifact.artifactSha256) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup account artifact is missing or differs from its immutable byte pin", "do not remove anything; restore only the exact retained verified account bytes");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(response.artifact.bytes).toString("utf8")); }
  catch { return reject("EVIDENCE_INCOMPLETE", "cleanup account artifact is not valid canonical JSON", "retain all resources and preserve the original proof artifact"); }
  const parsedBundle = DeskTaskIntegrationCleanupBundle.safeParse(decoded);
  if (!parsedBundle.success) return reject("EVIDENCE_INCOMPLETE", "cleanup account artifact no longer parses as the strict verified bundle", "retain all resources and target fence; no replacement account may be inferred");
  const bundle = parsedBundle.data;
  const bundleBytes = taskIntegrationCleanupBundleBytes(bundle);
  if (Buffer.compare(Buffer.from(response.artifact.bytes), Buffer.from(bundleBytes)) !== 0 ||
      sha256Hex(bundleBytes) !== candidate.artifact.artifactSha256 || canonicalSha256(bundle) !== candidate.artifact.bundleSha256 ||
      bundle.actionId !== candidate.actionId || bundle.basis !== candidate.basis || bundle.recoveryPlanSha256 !== candidate.recoveryPlanSha256 ||
      canonicalJson(bundle.sourceAdmissionRef) !== canonicalJson(candidate.sourceAdmissionRef) ||
      canonicalJson(bundle.sourceProofRef) !== canonicalJson(candidate.sourceProofRef) || bundle.sourceProofKind !== candidate.sourceProofKind ||
      bundle.sourceGrantRef !== candidate.sourceGrantRef || bundle.sourceControlSha256 !== candidate.sourceControlSha256 ||
      canonicalJson(bundle.targetBefore) !== canonicalJson(candidate.targetBefore) ||
      canonicalJson(bundle.resources.map(row => row.pin)) !== canonicalJson(candidate.resources)) {
    return reject("RECOVERY_REQUIRED", "cleanup artifact bytes no longer prove the exact verified-before inventory", "retain every obligation; never re-derive missing paths after cleanup has begun");
  }
  const rows = integrationResourceRows(ledger, action);
  if (rows === null || rows.length !== candidate.resources.length || response.resources.length !== candidate.resources.length) {
    return reject("EVIDENCE_INCOMPLETE", "cleanup observer omitted an exact admitted resource row", "retain all resource obligations and reconcile the action-bound inventory");
  }
  const responseSummaries: DeskTaskIntegrationCleanupResourceObservationValue[] = [];
  for (let index = 0; index < candidate.resources.length; index += 1) {
    const pin = candidate.resources[index]!;
    const expectedEntries = bundle.resources[index]!.entries;
    const current = rows.find(row => row.resourceId === pin.resourceId);
    const observed = response.resources[index]!;
    if (current === undefined || observed.resourceId !== current.resourceId || observed.resourceRevision !== current.revision ||
        observed.resourceKey !== current.resourceKey || observed.resourceKind !== current.resourceKind ||
        observed.resourceKey !== pin.resourceKey || observed.resourceKind !== pin.resourceKind) {
      return reject("REVISION_CONFLICT", "cleanup observer resource identity/revision differs from current history", "refresh only the exact current resource revision under its verified account");
    }
    const paths = observed.entries.map(entry => entry.path);
    if (new Set(paths).size !== paths.length || paths.some((path, pathIndex) => pathIndex > 0 &&
        Buffer.compare(Buffer.from(paths[pathIndex - 1]!), Buffer.from(path)) >= 0)) {
      return reject("EVIDENCE_INCOMPLETE", "cleanup current inventory is duplicated or not UTF-8 sorted", "retain the resource and use a complete no-follow inventory");
    }
    const rootMissing = observed.entries.length === 0;
    if (rootMissing ? observed.rootMode !== null : observed.entries[0]?.path !== "." || observed.entries[0]?.kind !== "directory" ||
        observed.rootMode !== pin.rootMode || observed.entries[0]?.mode !== pin.rootMode) {
      return reject("EVIDENCE_INCOMPLETE", "cleanup current root/mode differs from the verified inventory", "retain the resource and target fence");
    }
    const expectedByPath = new Map(expectedEntries.map(entry => [entry.path, entry]));
    if (observed.entries.some(entry => {
      const original = expectedByPath.get(entry.path);
      return original === undefined || canonicalJson(original) !== canonicalJson(entry);
    })) return reject("EVIDENCE_INCOMPLETE", "cleanup survivor content/kind/mode is not present in the verified-before inventory", "do not remove or release a tampered resource");
    const present = new Set(paths);
    const missing = expectedEntries.filter(entry => !present.has(entry.path)).map(entry => entry.path);
    if (current.disposition === "released") {
      if (missing.length !== expectedEntries.length || !rootMissing) return reject("EVIDENCE_INCOMPLETE", "released cleanup resource is not positively absent", "retain the target fence until all previously released paths remain absent");
    } else if (missing.length > 0) {
      const prior = priorIssuedPermit?.permit.resourceId === current.resourceId ? priorIssuedPermit : null;
      const issued = currentIssuedPermit?.permit.resourceId === current.resourceId ? currentIssuedPermit : null;
      const authorization = progressKind === "resource-preflight" ? prior : issued;
      if (authorization === null || authorization === undefined || authorization.permit.actionId !== action.actionId ||
          authorization.permit.resourceKey !== current.resourceKey || authorization.permit.inventoryMapSha256 !== pin.inventoryMapSha256 ||
          authorization.permit.cleanupRecipe !== pin.cleanupRecipe ||
          (progressKind === "resource-preflight" ? authorization.permit.ordinal >= permit.ordinal :
            canonicalJson(authorization.permit) !== canonicalJson(permit))) {
        return reject("EVIDENCE_INCOMPLETE", "missing cleanup paths lack a prior issued permit for this exact resource", "the current intended permit cannot explain absence; retain the resource and target fence");
      }
    }
    const expectedRegistration = pin.gitRegistration;
    if (pin.resourceKind === "worktree") {
      const registrationMatches = !rootMissing && canonicalJson(observed.gitRegistration) === canonicalJson(expectedRegistration);
      const registrationRemoved = rootMissing && observed.gitRegistration === null;
      if (!registrationMatches && !registrationRemoved) return reject("EVIDENCE_INCOMPLETE", "cleanup worktree registration is mismatched or unexpectedly present/absent", "keep the worktree resource retained until its exact registration state is proven");
    } else if (observed.gitRegistration !== null) return reject("EVIDENCE_INCOMPLETE", "scratch cleanup reported an unrelated Git registration", "retain the scratch resource and reject foreign registration evidence");
    const mapSha = observed.entries.length === 0 ? null : sha256Hex(Buffer.from(canonicalJson(observed.entries), "utf8"));
    const missingSha = missing.length === 0 ? null : sha256Hex(Buffer.from(canonicalJson(missing), "utf8"));
    responseSummaries.push({
      resourceId: pin.resourceId,
      resourceRevision: current.revision,
      resourceKey: pin.resourceKey,
      expectedInventoryMapSha256: pin.inventoryMapSha256,
      observedInventoryMapSha256: mapSha,
      expectedEntryCount: pin.entryCount,
      observedEntryCount: observed.entries.length,
      missingPathsSha256: missingSha,
      missingPathCount: missing.length,
      survivorMapSha256: mapSha,
      survivorEntryCount: observed.entries.length,
      rootMode: observed.rootMode,
      gitRegistration: pin.resourceKind !== "worktree" ? "not-applicable" : rootMissing ? "missing" : "matched",
    });
  }
  const targetSummary = responseSummaries.find(row => row.resourceId === permit.resourceId);
  if (targetSummary === undefined) return reject("EVIDENCE_INCOMPLETE", "cleanup permit resource is absent from observed account", "retain the resource and verify the exact permit target");
  const targetResourceRemoved = targetSummary.missingPathCount === targetSummary.expectedEntryCount && targetSummary.survivorEntryCount === 0;
  const observerResponseSha256 = canonicalSha256({
    domain: "paseo-slp/task-integration-cleanup-observer-response/v1",
    version: response.version, purpose: response.purpose, progressKind: response.progressKind,
    admissionSha256: response.admissionSha256,
    artifact: { path: response.artifact.path, kind: response.artifact.kind, mode: response.artifact.mode,
      bytes: response.artifact.bytes.byteLength, sha256: sha256Hex(response.artifact.bytes) },
    target: response.target, sourceBase: response.sourceBase, sourceResult: response.sourceResult,
    sourceProofRef: response.sourceProofRef, sourceProofKind: response.sourceProofKind,
    resources: responseSummaries,
  });
  return { target: response.target, resources: responseSummaries, observerResponseSha256, targetResourceRemoved };
}

async function cleanupObservationFromTrigger(
  ledger: Readonly<LedgerValue>, action: DeskTaskActionEntryValue, trigger: DeskTaskIntegrationCleanupTriggerValue,
  deps: TaskRunnerDeps,
): Promise<DeskTaskIntegrationCleanupObservationValue | DeskRejectionValue> {
  if (action.actionKind !== "integration" || action.phase !== "discharge" || action.body === null) {
    return reject("REVISION_CONFLICT", "cleanup observation is not attached to an integration discharge action", "retain resources and reconcile the exact action phase");
  }
  const currentRef = integrationEntryRef(action);
  const expectedRef = trigger.cleanupStep === "verify-account" ? trigger.verifyIssueRef : trigger.issuedPermitRef;
  if (canonicalJson(expectedRef) !== canonicalJson(currentRef)) {
    return reject("REVISION_CONFLICT", "cleanup trigger history ref is not the exact current issued action row", "use the immutable issue entry returned by Core for this action revision");
  }
  const admission = cleanupObserverAdmission(ledger, action, trigger);
  if ("ok" in admission) return admission;
  const currentAdmission = admission as DeskTaskIntegrationCleanupPublicAdmission;
  const sourcePins = cleanupSourcePins(action);
  if ("ok" in sourcePins) return sourcePins;
  const observe = deps.observe?.observeIntegrationCleanup;
  if (observe === undefined) return reject("CAPABILITY_GAP", "the typed integration cleanup observer is unavailable", "retain the action-bound resources and supply the bounded read-only cleanup observer");

  if (trigger.cleanupStep === "verify-account") {
    const checkedCandidate = validateCleanupCandidate(ledger, action, action.body.cleanupCandidate);
    if ("ok" in checkedCandidate) return checkedCandidate;
    const candidate = checkedCandidate.candidate;
    if (trigger.phase === "discharge" && trigger.candidateSha256 !== canonicalSha256(candidate)) {
      return reject("REVISION_CONFLICT", "verify trigger candidate digest differs from the exact admitted candidate", "replay only the original canonical proof bundle bytes");
    }
    if (trigger.phase === "reconcile" && action.cleanupVerification !== null) {
      return reject("REVISION_CONFLICT", "verification reconcile would replace a committed immutable account", "use a new exact resource permit phase after the account is verified");
    }
    const candidateArtifactBytes = exactCleanupArtifactBytes(deps, candidate);
    if (!(candidateArtifactBytes instanceof Uint8Array)) return candidateArtifactBytes;
    const request: DeskTaskIntegrationCleanupObserverRequest = trigger.phase === "discharge"
      ? {
          version: 1, purpose: "verify-account", progressKind: "initial", admission: currentAdmission as Extract<DeskTaskIntegrationCleanupPublicAdmission, { phase: "discharge" }>,
          actionId: action.actionId, expectedActionRevision: action.revision,
          sourceBase: sourcePins.sourceBase, sourceResult: sourcePins.sourceResult,
          candidate, candidateArtifactBytes, verification: null, verificationRef: null, permit: null,
        }
      : {
          version: 1, purpose: "reconcile-progress", progressKind: "verify-account", admission: currentAdmission as Extract<DeskTaskIntegrationCleanupPublicAdmission, { phase: "reconcile" }>,
          actionId: action.actionId, expectedActionRevision: action.revision,
          sourceBase: sourcePins.sourceBase, sourceResult: sourcePins.sourceResult,
          candidate, candidateArtifactBytes, verifyIssueRef: trigger.verifyIssueRef,
          verification: null, verificationRef: null, permit: null,
        };
    let response: DeskTaskIntegrationCleanupObserverResponseValue;
    try { response = await observe(request); }
    catch { return reject("CAPABILITY_GAP", "the read-only cleanup verification observer did not complete", "retain the issued verification intent and reconcile once under fresh controls"); }
    const verified = verifyCleanupBundleObservation(candidate, response, taskIntegrationCleanupAdmissionSha256(currentAdmission), candidateArtifactBytes,
      sourcePins.sourceBase, sourcePins.sourceResult, request.purpose, request.progressKind);
    if ("ok" in verified) return verified;
    const parsedResponse = DeskTaskIntegrationCleanupObserverResponse.safeParse(response);
    if (!parsedResponse.success) return reject("INVALID_RECORD", "cleanup observer returned a noncanonical verification response", "retain resources and supply a complete strict observer result");
    const observation = DeskTaskIntegrationCleanupObservation.safeParse({
      phase: trigger.phase, cleanupStep: "verify-account", status: verified.status,
      candidateSha256: canonicalSha256(candidate), verifyIssueRef: currentRef, artifact: candidate.artifact,
      sourceProofRef: candidate.sourceProofRef, target: parsedResponse.data.target,
      resources: verified.resources, observerResponseSha256: verified.observerResponseSha256,
    });
    if (!observation.success) return reject("INVALID_RECORD", "Core verification observation failed its strict compact schema", "retain all resources and use the bounded observer contract");
    return observation.data;
  }

  const verificationParsed = DeskTaskIntegrationCleanupVerification.safeParse(action.cleanupVerification);
  const permitParsed = DeskTaskIntegrationCleanupPermit.safeParse(action.body.permit);
  if (!verificationParsed.success || !permitParsed.success) return reject("EVIDENCE_INCOMPLETE", "resource observation lacks its verified account or exact permit", "retain the resource and reread the original immutable verification/permit rows");
  const verification = verificationParsed.data;
  const permit = permitParsed.data;
  const verificationRef = cleanupVerificationRef(ledger, action);
  if ("ok" in verificationRef) return verificationRef;
  if (canonicalJson(trigger.verificationRef) !== canonicalJson(verificationRef) || permit.actionId !== action.actionId ||
      permit.verificationRef.entryId !== verificationRef.entryId || permit.verificationRef.entrySha256 !== verificationRef.entrySha256 ||
      permit.resourceId === "" || permit.expectedResourceRevision < 1) {
    return reject("REVISION_CONFLICT", "resource trigger or permit differs from the immutable cleanup account/action", "use the exact verified-account and currently issued permit refs");
  }
  const request: DeskTaskIntegrationCleanupObserverRequest = {
    version: 1, purpose: "reconcile-progress", progressKind: "resource", admission: currentAdmission,
    actionId: action.actionId, expectedActionRevision: action.revision,
    sourceBase: sourcePins.sourceBase, sourceResult: sourcePins.sourceResult,
    candidate: null, candidateArtifactBytes: null, verification, verificationRef, permit,
  };
  let response: DeskTaskIntegrationCleanupObserverResponseValue;
  try { response = await observe(request); }
  catch { return reject("CAPABILITY_GAP", "the read-only cleanup resource observer did not complete", "retain the issued permit and reconcile once under fresh public controls"); }
  const verified = verifyCleanupResourceProgress(ledger, action, verification, permit, response,
    taskIntegrationCleanupAdmissionSha256(currentAdmission), sourcePins.sourceBase, sourcePins.sourceResult,
    "reconcile-progress", "resource", null, { permit, row: action });
  if ("ok" in verified) return verified;
  const observation = DeskTaskIntegrationCleanupObservation.safeParse({
    phase: trigger.phase, cleanupStep: trigger.cleanupStep, status: verified.targetResourceRemoved ? "observed" : "held",
    verificationRef, issuedPermitRef: currentRef, permit, target: verified.target,
    resources: verified.resources, observerResponseSha256: verified.observerResponseSha256,
  });
  if (!observation.success) return reject("INVALID_RECORD", "Core cleanup resource observation failed its strict compact schema", "retain all resources and use the bounded observer contract");
  return observation.data;
}

function validateCleanupPreflightEvidence(
  ledger: Readonly<LedgerValue>, action: DeskTaskActionEntryValue, evidenceValue: unknown,
): DeskTaskIntegrationCleanupPreflightEvidenceValue | DeskRejectionValue {
  const evidenceParsed=DeskTaskIntegrationCleanupPreflightEvidence.safeParse(evidenceValue);
  const verification=DeskTaskIntegrationCleanupVerification.safeParse(action.cleanupVerification);
  const permit=DeskTaskIntegrationCleanupPermit.safeParse(action.body?.permit);
  if(!evidenceParsed.success || !verification.success || !permit.success || action.state!=="intended" || action.phase!=="discharge" ||
      action.body?.phase!=="discharge" || action.body.cleanupStep!=="remove-resource") {
    return reject("EVIDENCE_INCOMPLETE","resource issue lacks its exact verified account, current intent and readonly preflight receipt","do not issue a removal effect until Core has measured the current resource set");
  }
  const evidence=evidenceParsed.data;
  const candidate=verification.data.candidate;
  const currentRef=integrationEntryRef(action);
  const verificationRef=cleanupVerificationRef(ledger,action);
  const sourcePins=cleanupSourcePins(action);
  const controls=DeskTaskIntegrationControlPins.safeParse(action.body.controlPins);
  const publicRequestId=action.body.publicRequestId;
  const publicRequestSha256=action.body.publicRequestSha256;
  const grantRef=action.grant?.authorityRef;
  const intentAdmission=(controls.success && typeof publicRequestId==="string" && typeof publicRequestSha256==="string" && grantRef!==null && grantRef!==undefined)
    ? {phase:"discharge" as const,publicRequestId,publicRequestSha256,grantRef,controlPins:controls.data,intentRef:currentRef,issueRef:null}
    : null;
  if("ok" in verificationRef || "ok" in sourcePins || intentAdmission===null || canonicalJson(evidence.verificationRef)!==canonicalJson(verificationRef) ||
      canonicalJson(evidence.permit)!==canonicalJson(permit.data) || !measureContentEqual(evidence.target,candidate.targetBefore) ||
      evidence.admissionSha256!==taskIntegrationCleanupAdmissionSha256(intentAdmission) || permit.data.actionId!==action.actionId ||
      permit.data.verificationRef.entryId!==verificationRef.entryId || permit.data.verificationRef.entrySha256!==verificationRef.entrySha256) {
    return reject("REVISION_CONFLICT","readonly resource evidence differs from the exact current public intent/account/permit/source admission","re-read fresh owner/CAS pins and preserve immutable source controls");
  }
  const resources=integrationResourceRows(ledger,action);
  if(resources===null || evidence.resources.length!==candidate.resources.length)return reject("EVIDENCE_INCOMPLETE","readonly cleanup preflight omitted a current admitted resource","retain all resource rows and target reservation");
  const prior=latestIssuedCleanupPermit(ledger,action.actionId,permit.data.resourceId);
  const expectedPriorRef=prior===null?null:integrationEntryRef(prior.row);
  if(canonicalJson(evidence.priorIssuedPermitRef)!==canonicalJson(expectedPriorRef) ||
      (prior!==null && (canonicalJson(evidence.priorIssuedPermitRef)!==canonicalJson(integrationEntryRef(prior.row)) ||
        prior.permit.ordinal>=permit.data.ordinal || prior.permit.resourceKey!==permit.data.resourceKey || prior.permit.inventoryMapSha256!==permit.data.inventoryMapSha256))) {
    return reject("REVISION_CONFLICT","preflight missing-subset proof is not tied to the exact prior issued resource permit","the intended permit cannot authorize unexplained prior absence");
  }
  const targetPin=candidate.resources.find(pin=>pin.resourceId===permit.data.resourceId);
  const targetRow=resources.find(row=>row.resourceId===permit.data.resourceId);
  if(targetPin===undefined || targetRow===undefined || targetRow.disposition!=="retained" || targetRow.revision!==permit.data.expectedResourceRevision ||
      targetRow.resourceKey!==permit.data.resourceKey || targetPin.inventoryMapSha256!==permit.data.inventoryMapSha256 ||
      permit.data.ordinal<1 || permit.data.ordinal>2) return reject("REVISION_CONFLICT","preflight permit differs from the exact retained resource revision/key/map","refresh the verified account and current resource row before issuing");
  const targetSummary=evidence.resources.find(summary=>summary.resourceId===permit.data.resourceId);
  if(targetSummary===undefined || (targetSummary.missingPathCount===targetSummary.expectedEntryCount && targetSummary.survivorEntryCount===0)) {
    return reject("RECOVERY_REQUIRED","the target resource is already completely absent under an earlier permit","reconcile that exact issued receipt; do not issue a no-op cleanup cycle");
  }
  for(const pin of candidate.resources) {
    const row=resources.find(resource=>resource.resourceId===pin.resourceId);
    const summary=evidence.resources.find(item=>item.resourceId===pin.resourceId);
    if(row===undefined || summary===undefined || summary.resourceRevision!==row.revision || summary.resourceKey!==row.resourceKey ||
        summary.expectedInventoryMapSha256!==pin.inventoryMapSha256 || summary.expectedEntryCount!==pin.entryCount ||
        summary.survivorEntryCount+summary.missingPathCount!==pin.entryCount ||
        (row.disposition==="released" && (summary.missingPathCount!==pin.entryCount || summary.survivorEntryCount!==0)) ||
        (row.disposition!=="released" && row.resourceId!==permit.data.resourceId && summary.missingPathCount!==0) ||
        (row.disposition!=="released" && row.resourceId===permit.data.resourceId && summary.missingPathCount>0 &&
          (prior===null || prior.permit.resourceId!==row.resourceId || prior.permit.ordinal>=permit.data.ordinal)) ||
        (summary.missingPathCount===0 && (summary.observedInventoryMapSha256!==pin.inventoryMapSha256 ||
          summary.survivorMapSha256!==pin.inventoryMapSha256 || summary.survivorEntryCount!==pin.entryCount || summary.missingPathsSha256!==null)) ||
        (summary.missingPathCount>0 && summary.missingPathsSha256===null) ||
        summary.rootMode!==(summary.missingPathCount===pin.entryCount?null:pin.rootMode) ||
        summary.gitRegistration!==(pin.resourceKind!=="worktree"?"not-applicable":summary.missingPathCount===pin.entryCount?"missing":"matched")) {
      return reject("EVIDENCE_INCOMPLETE","preflight resource inventory has foreign, unexplained or changed content","do not issue or remove; preserve every resource and remeasure exact survivors");
    }
  }
  return evidence;
}

function integrationDischargeComplete(ledger: Readonly<LedgerValue>, action: DeskTaskActionEntryValue): boolean {
  const receipt = action.receipt as Record<string, unknown> | null;
  if (receipt === null || action.state !== "observed" || receipt.status !== "observed") return false;
  const plan = action.recoveryPlan ?? null;
  const paths = plan === null ? (action.stageDir === null ? [] : [action.stageDir]) : [plan.stageDir, plan.backupDir];
  if (paths.length === 0 || !sameRecoveryPlan(receipt.recoveryPlan ?? null, plan)) return false;
  const cleanupObservation = DeskTaskIntegrationCleanupObservation.safeParse(receipt.cleanupObservation);
  if (cleanupObservation.success) {
    if ((receipt.phase !== "discharge" && receipt.phase !== "reconcile") ||
        cleanupObservation.data.status !== "observed" ||
        (cleanupObservation.data.cleanupStep !== "remove-resource" && cleanupObservation.data.cleanupStep !== "reconcile-progress") ||
        (receipt.phase === "discharge" && receipt.grantRef !== action.grant?.authorityRef)) return false;
  } else {
    if (action.phase !== "discharge" || receipt.phase !== "discharge" || receipt.grantRef !== action.grant?.authorityRef ||
        !Array.isArray(receipt.admittedPaths) || !Array.isArray(receipt.removed) || !Array.isArray(receipt.errors) || receipt.errors.length !== 0 ||
        canonicalJson(receipt.admittedPaths) !== canonicalJson(paths) || canonicalJson(receipt.removed) !== canonicalJson(paths)) return false;
  }
  // A nullable legacy plan can only discharge a stage-only action with its
  // observed stage pin. It cannot imply that an unrecorded backup is absent.
  if (plan === null && (action.backupDir !== null || action.landed !== null || action.landIntent !== null)) return false;
  const resources = integrationResourceRows(ledger, action);
  return resources !== null && resources.length === paths.length && paths.every(path => resources.some(row =>
    row.resourceKey === path && row.disposition === "released" && row.releaseRuling !== null && row.releaseRuling.evidence.length > 0));
}

function integrationTargetReserved(ledger: Readonly<LedgerValue>, action: DeskTaskActionEntryValue): boolean {
  return action.actionKind === "integration" && !integrationDischargeComplete(ledger, action);
}

type ReservationSurfaces = { paths: string[]; resources: string[]; stateOwners: { stateRef: string; moduleRef: string }[] };

function reservationSurfaces(scope: DeskTaskCommandBodyValue["scope"], cwd: string | null): ReservationSurfaces {
  const ownership = scope?.ownership;
  return {
    paths: ownership?.paths ?? [],
    resources: ownership?.resources ?? [],
    stateOwners: ownership?.stateOwners ?? [],
  };
}

function surfacesOverlap(a: ReservationSurfaces, b: ReservationSurfaces): boolean {
  const pathOverlap = a.paths.some(left =>
    b.paths.some(right => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
  if (pathOverlap) return true;
  return a.resources.some(item => b.resources.includes(item))
    || a.stateOwners.some(left => b.stateOwners.some(right => left.stateRef === right.stateRef));
}

/** Attempt-side gate evaluated before any new external effect commits. */
function attemptEffectGate(
  ledger: Readonly<LedgerValue>,
  attempt: DeskTaskAttemptEntryValue,
  actionKind: string,
): DeskRejectionValue | null {
  const task = latestTask(ledger, attempt.assignmentId, attempt.taskId);
  if (task === undefined || task.revision !== attempt.taskRevision || briefRevisionOf(ledger, attempt.assignmentId) !== task.briefRevision) {
    return reject("REVISION_CONFLICT", "attempt/task/brief pins are no longer operative", "retain the old reservation and reconcile under the current brief");
  }
  if (latestHoldsForTask(ledger, attempt.taskId).some(row => row.state === "open" || row.ruling?.outcome === "retain")) {
    return reject("EFFECT_INADMISSIBLE", "a task question or retained hold prevents new effects", "the current owner must rule the hold first");
  }
  const assignment = ledger.assignments.find(row => row.assignmentId === attempt.assignmentId)!;
  const owner = effectiveOwner(ledger, assignment);
  if (owner.agentId !== attempt.ownerAgentId || owner.membershipId !== attempt.ownerMembershipId) {
    return reject("REVISION_CONFLICT", "attempt belongs to the prior owner", "succession preserves obligations; reconcile rather than silently continuing prior effects");
  }
  if (actionKind === "send") {
    const member = attempt.member === null ? undefined : ledger.memberships.find(row => row.membershipId === attempt.member!.membershipId);
    if (member === undefined || member.state === "revoked" || member.agentId !== attempt.member!.agentId || member.registeredAt === null ||
        member.createCwd !== attempt.placement.cwd || member.workspaceId !== attempt.placement.workspaceId || member.provider !== attempt.seatPin.provider) {
      return reject("ACTOR_MISMATCH", "writable delivery lost its exact live registered member", "reconcile the membership and placement obligation");
    }
    if (task.scope !== null) {
      const scope = ledger.scopes.filter(row => row.assignmentId === attempt.assignmentId && row.scopeId === attempt.boundScopeId).at(-1);
      const transition = ledger.scopeTransitions.filter(row => row.assignmentId === attempt.assignmentId && row.scopeId === attempt.boundScopeId).at(-1);
      if (scope === undefined || scope.revision !== attempt.boundScopeRevision || scope.briefRevision !== task.briefRevision ||
          scope.ownership?.writerAgentId !== member.agentId || transition?.to !== "claimed") {
        return reject("SCOPE_CONFLICT", "writable delivery has no exact current claimed writer scope", "attach, declare and claim atomically before writable delivery");
      }
    }
  }
  if (attempt.stop.requested || attempt.state === "stop-requested") {
    if (actionKind !== "archive") {
      return reject("STOP_REQUESTED", `attempt ${attempt.attemptId} is fenced by a stop request`, "only archive effects may commit while a stop is outstanding; reconcile discharges the stop");
    }
  }
  if (attempt.state === "reconciliation-required") {
    return reject("RECOVERY_REQUIRED", `attempt ${attempt.attemptId} has an uncertain effect`, "run a bounded reconcile before any new effect of the same class");
  }
  if (attempt.state === "settled" || attempt.state === "stopped") {
    return reject("INVALID_RECORD", `attempt ${attempt.attemptId} is ${attempt.state}`, "terminal attempts accept no new effects");
  }
  const sameKindUncertain = latestActions(ledger, { attemptId: attempt.attemptId })
    .some(row => row.actionKind === actionKind && row.state === "uncertain");
  if (sameKindUncertain) {
    return reject("RECOVERY_REQUIRED", `attempt ${attempt.attemptId} has an uncertain ${actionKind} effect`, "reconcile the recorded uncertainty before any new effect of this class");
  }
  if (!dependencyPinsCurrent(ledger, attempt.consumedDependencies)) {
    return reject("REVISION_CONFLICT", "a consumed dependency pin no longer matches its producer's current accepted result", "re-resolve the task's dependencies and reserve a fresh attempt");
  }
  return null;
}

function actionCapacityGate(ledger: Readonly<LedgerValue>, attempt: DeskTaskAttemptEntryValue): DeskRejectionValue | null {
  const cap = attempt.effectBudget ?? WIRE_LIMITS.deskTaskActions;
  const count = latestActions(ledger, { attemptId: attempt.attemptId }).length;
  if (count >= cap) {
    return reject("INVALID_RECORD", `attempt ${attempt.attemptId} reached its ${cap}-action effect budget`, "settle or archive the attempt rather than widening its budget");
  }
  return null;
}

export function decideDeskTask(ledger: Readonly<LedgerValue>, command: Record<string, unknown>): DecideOutcome {
  const parsed = DeskTaskStoreCommand.safeParse(command);
  if (!parsed.success) {
    return reject("INVALID_RECORD", "command does not match any desk-task command schema", "task commands are strict JSON objects with a kind discriminator");
  }
  const cmd = parsed.data;
  // Exact-tuple authority: the caller's ctx row resolves by BOTH ids — a
  // stale or rebound membership for the same agentId is a different caller,
  // never a stand-in.
  const actorRow = ledger.memberships.find(row => row.membershipId === cmd.actorMembershipId);
  const actor: MembershipValue | DeskRejectionValue =
    actorRow !== undefined && actorRow.agentId === cmd.actorAgentId &&
    actorRow.state !== "revoked" && actorRow.registeredAt !== null && actorRow.openGeneration === cmd.actorOpenGeneration
      ? actorRow
      : reject("AUTHORITY_REQUIRED", "the actor's exact membership tuple is not live on this desk", "a task mutation needs the exact live bound membership — a rebound row is a different caller");

  // Registered + open assignment is the floor for every remaining command;
  // owner-vs-bound-member authority is enforced per op below.
  const openAssignment = (): AssignmentValue | DeskRejectionValue => {
    const row = ledger.assignments.find(candidate => candidate.assignmentId === cmd.assignmentId);
    if (row === undefined) {
      return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "mutations require the durable assignment binding");
    }
    if (row.state !== "open") {
      return reject("AUTHORITY_REQUIRED", "the assignment is closed", "closed assignments retain history and accept no new task mutations");
    }
    return row;
  };

  if (cmd.kind === "task.effect.observe") {
    // Seat-scoped path: the actor may be the attempt's bound member instead
    // of the owner. The tuple must resolve live AND equal the bound tuple —
    // a rebound membershipId cannot stand in for the bound one.
    if ("ok" in actor) return actor;
    const action = latestTaskEntity<DeskTaskActionEntryValue>(ledger, cmd.actionId);
    if (action === undefined || action.kind !== "action" || action.assignmentId !== cmd.assignmentId) {
      return reject("ACTOR_MISMATCH", `unknown action ${cmd.actionId}`, "observe only actions the ledger already committed");
    }
    if (cmd.actionKind !== action.actionKind || (cmd.taskId !== null && cmd.taskId !== action.taskId) ||
        (cmd.attemptId !== null && cmd.attemptId !== action.attemptId) || (cmd.resultId !== null && cmd.resultId !== action.resultId)) {
      return reject("ACTOR_MISMATCH", "observation references differ from the admitted action", "observe the exact action/attempt/result identity");
    }
    const cleanupTriggerResult = DeskTaskIntegrationCleanupTrigger.safeParse(cmd.receipt);
    if ((cleanupTriggerResult.success && cmd.cleanupObservation === undefined) ||
        (!cleanupTriggerResult.success && cmd.cleanupObservation !== undefined)) {
      return reject("EVIDENCE_INCOMPLETE", "cleanup observation must be Core-derived for exactly one strict status-free cleanup trigger", "preserve the original trigger and let Core call the typed observer after replay checks");
    }
    const cleanupTrigger = cleanupTriggerResult.success ? cleanupTriggerResult.data : null;
    const cleanupObservation = cmd.cleanupObservation;
    const receiptRecord: Record<string, unknown> = cleanupTrigger !== null && cleanupObservation !== undefined ? {
      phase: cleanupTrigger.phase,
      cleanupStep: cleanupTrigger.cleanupStep,
      status: cleanupObservation.status,
      controlPins: cleanupTrigger.controlPins,
      publicRequestId: cleanupTrigger.publicRequestId,
      publicRequestSha256: cleanupTrigger.publicRequestSha256,
      grantRef: cleanupTrigger.phase === "discharge" ? action.grant?.authorityRef ?? null : null,
      recoveryPlan: action.recoveryPlan ?? null,
      cleanupTrigger,
      cleanupObservation,
      ...(cleanupTrigger.cleanupStep === "verify-account" ? { verifyIssueRef: cleanupTrigger.verifyIssueRef } : {
        verificationRef: cleanupTrigger.verificationRef, issuedPermitRef: cleanupTrigger.issuedPermitRef,
      }),
    } : cmd.receipt as Record<string, unknown>;
    const integrationPhase=action.actionKind==="integration" ? (receiptRecord.phase??null) : null;
    if (action.actionKind === "integration" && integrationPhase === "reconcile") {
      const pins = phaseControlGate(ledger, action, receiptRecord.controlPins); if (pins !== null) return pins;
    } else if(action.actionKind==="integration" && (integrationPhase==="land" || integrationPhase==="discharge")) {
      if(action.body?.phase!==integrationPhase || canonicalJson((action.body as Record<string,unknown>).controlPins??null)!==canonicalJson(receiptRecord.controlPins??null) ||
          (cleanupTrigger !== null && (action.body.publicRequestId!==cleanupTrigger.publicRequestId || action.body.publicRequestSha256!==cleanupTrigger.publicRequestSha256))) {
        return reject("REVISION_CONFLICT","phase receipt control pins do not match its admitted intent","use the exact initial phase control pins across the intent/issue/observe lineage");
      }
    }
    const owner = effectiveOwner(ledger, ledger.assignments.find(a => a.assignmentId === cmd.assignmentId)!);
    const isOwner = owner.agentId === actor.agentId && owner.membershipId === actor.membershipId;
    let attempt: DeskTaskAttemptEntryValue | undefined;
    if (action.attemptId !== null) {
      attempt = latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, action.attemptId);
    } else if (cmd.attemptId !== undefined && cmd.attemptId !== null) {
      attempt = latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, cmd.attemptId);
    }
    const isBoundMember =
      attempt !== undefined && attempt.member !== null &&
      actor.membershipId === attempt.member.membershipId && actor.agentId === attempt.member.agentId;
    if (!isOwner && !isBoundMember) {
      return reject("ACTOR_MISMATCH", "the observer is neither the exact owner nor the attempt's bound member tuple", "an observation commits under the current owner or the bound seat only; anything else stays a pending observation gap");
    }
    const integrationResources=action.actionKind==="integration" ? integrationResourceRows(ledger,action) : null;
    const statusToState: Record<string, DeskTaskActionEntryValue["state"]> = {
      observed: "observed", uncertain: "uncertain", failed: "failed", held: "held", conflict: "held",
    };
    const integrationReplayableReconcile=action.actionKind==="integration" && integrationPhase==="reconcile" &&
      taskIntegrationReconcileEdgeAllowed(action, statusToState[String(receiptRecord.status)] ?? "failed", receiptRecord, integrationResources ?? []);
    if (action.state !== "issued" && action.state !== "uncertain" && action.state !== "held" && !integrationReplayableReconcile) {
      return reject("INVALID_RECORD", `action ${cmd.actionId} is ${action.state} — only issued/uncertain actions accept observations`, "replays of committed observations come back through reconcile, not a fresh observe");
    }
    const assignment = ledger.assignments.find(a => a.assignmentId === cmd.assignmentId)!;
    if (assignment.state !== "open") {
      return reject("AUTHORITY_REQUIRED", "the assignment is closed", "closed assignments retain history and accept no new task mutations");
    }
    const phase = typeof receiptRecord.phase === "string" ? receiptRecord.phase : null;
    const expectedPlan=action.recoveryPlan??null;
    let integrationNextState:DeskTaskActionEntryValue["state"]|null=null;
    let integrationLanded:DeskTaskMeasurePinValue|null=null;
    let cleanupRemoved:string[]=[];
    let cleanupPaths:string[]=[];
    let cleanupVerificationNext:DeskTaskIntegrationCleanupVerificationValue|null=null;
    if(action.actionKind==="integration") {
      if(!sameRecoveryPlan(receiptRecord.recoveryPlan??null,expectedPlan))return reject("RECOVERY_REQUIRED","receipt recoveryPlan differs from the immutable LAND intent","retain the action and use only its admitted maps/backup provenance");
      if(cleanupTrigger!==null && cleanupObservation!==undefined) {
        if(!isOwner)return reject("ACTOR_MISMATCH","cleanup observation must commit under the exact current owner","a former or worker actor cannot release integration resources");
        const expectedBodyStep=cleanupTrigger.cleanupStep==="reconcile-progress"?"remove-resource":cleanupTrigger.cleanupStep;
        if(action.body?.phase!=="discharge" || action.body.cleanupStep!==expectedBodyStep || action.state!=="issued" ||
            cleanupObservation.phase!==cleanupTrigger.phase || cleanupObservation.cleanupStep!==cleanupTrigger.cleanupStep ||
            cleanupObservation.status!==receiptRecord.status || canonicalJson(receiptRecord.controlPins)!==canonicalJson(cleanupTrigger.controlPins)) {
          return reject("REVISION_CONFLICT","Core cleanup observation does not match its exact current trigger/action/phase lineage","retain resources and replay only the original status-free trigger");
        }
        if(cleanupTrigger.cleanupStep==="verify-account") {
          const verificationObservation=cleanupObservation as Extract<DeskTaskIntegrationCleanupObservationValue,{cleanupStep:"verify-account"}>;
          const parsedCandidate=DeskTaskIntegrationCleanupCandidate.safeParse(action.body.cleanupCandidate);
          const resources=integrationResourceRows(ledger,action);
          if(!parsedCandidate.success || resources===null || verificationObservation.candidateSha256!==canonicalSha256(parsedCandidate.data) ||
              canonicalJson(verificationObservation.verifyIssueRef)!==canonicalJson(cleanupTrigger.verifyIssueRef) ||
              canonicalJson(verificationObservation.artifact)!==canonicalJson(parsedCandidate.data.artifact) ||
              canonicalJson(verificationObservation.sourceProofRef)!==canonicalJson(parsedCandidate.data.sourceProofRef) ||
              verificationObservation.target===null || !measureContentEqual(verificationObservation.target,parsedCandidate.data.targetBefore) ||
              verificationObservation.resources.length!==parsedCandidate.data.resources.length ||
              verificationObservation.resources.some((summary,index)=>{
                const pin=parsedCandidate.data.resources[index]!;const row=resources.find(item=>item.resourceId===pin.resourceId);
                return row===undefined || row.disposition!=="retained" || summary.resourceId!==pin.resourceId || summary.resourceRevision!==row.revision ||
                  summary.resourceKey!==pin.resourceKey || summary.expectedInventoryMapSha256!==pin.inventoryMapSha256 ||
                  summary.observedInventoryMapSha256!==pin.inventoryMapSha256 || summary.expectedEntryCount!==pin.entryCount ||
                  summary.observedEntryCount!==pin.entryCount || summary.missingPathCount!==0 || summary.missingPathsSha256!==null ||
                  summary.survivorMapSha256!==pin.inventoryMapSha256 || summary.survivorEntryCount!==pin.entryCount || summary.rootMode!==pin.rootMode ||
                  summary.gitRegistration!==(pin.resourceKind==="worktree"?"matched":"not-applicable");
              }))return reject("EVIDENCE_INCOMPLETE","verification observation does not prove every exact source/target/resource byte map intact","retain the target and resources until the immutable account is positively verified");
          if(verificationObservation.status==="observed") {
            cleanupVerificationNext={candidate:parsedCandidate.data,verifyIssueRef:cleanupTrigger.verifyIssueRef,
              observerResponseSha256:verificationObservation.observerResponseSha256};
          } else if(action.cleanupVerification!==null) {
            return reject("REVISION_CONFLICT","a held proof-persistence observation cannot replace a committed cleanup account","retain the immutable verified account and its resource permits");
          }
        } else {
          const resourceObservation=cleanupObservation as Extract<DeskTaskIntegrationCleanupObservationValue,{cleanupStep:"remove-resource"|"reconcile-progress"}>;
          const verification=DeskTaskIntegrationCleanupVerification.safeParse(action.cleanupVerification);
          const permit=DeskTaskIntegrationCleanupPermit.safeParse(action.body.permit);
          const verificationRef=cleanupVerificationRef(ledger,action);
          const resources=integrationResourceRows(ledger,action);
          if(!verification.success || !permit.success || "ok" in verificationRef || resources===null ||
              canonicalJson(verificationRef)!==canonicalJson(cleanupTrigger.verificationRef) ||
              canonicalJson(resourceObservation.permit)!==canonicalJson(permit.data) || permit.data.actionId!==action.actionId ||
              canonicalJson(resourceObservation.verificationRef)!==canonicalJson(verificationRef) ||
              canonicalJson(resourceObservation.issuedPermitRef)!==canonicalJson(cleanupTrigger.issuedPermitRef) ||
              resourceObservation.resources.length!==verification.data.candidate.resources.length ||
              resourceObservation.target===null || !measureContentEqual(resourceObservation.target,verification.data.candidate.targetBefore)) {
            return reject("REVISION_CONFLICT","resource observation does not match its immutable account, current permit and measured target","retain the resource and target fence");
          }
          const targetSummary=resourceObservation.resources.find(summary=>summary.resourceId===permit.data.resourceId);
          const targetPin=verification.data.candidate.resources.find(pin=>pin.resourceId===permit.data.resourceId);
          const targetRow=resources.find(row=>row.resourceId===permit.data.resourceId);
          if(targetSummary===undefined || targetPin===undefined || targetRow===undefined || targetRow.revision!==permit.data.expectedResourceRevision ||
              targetRow.disposition!=="retained" || targetRow.resourceKey!==permit.data.resourceKey || targetPin.inventoryMapSha256!==permit.data.inventoryMapSha256 ||
              targetSummary.resourceRevision!==targetRow.revision || targetSummary.resourceKey!==targetRow.resourceKey ||
              targetSummary.expectedInventoryMapSha256!==targetPin.inventoryMapSha256 || targetSummary.expectedEntryCount!==targetPin.entryCount ||
              targetSummary.missingPathCount<0 || targetSummary.missingPathCount>targetSummary.expectedEntryCount ||
              (resourceObservation.status==="observed" && (targetSummary.missingPathCount!==targetSummary.expectedEntryCount || targetSummary.survivorEntryCount!==0)) ||
              (resourceObservation.status==="held" && targetSummary.missingPathCount===targetSummary.expectedEntryCount && targetSummary.survivorEntryCount===0)) {
            return reject("EVIDENCE_INCOMPLETE","resource status is not supported by the exact issued permit and complete account inventory","retain the resource until admitted removal is positively observed");
          }
          for(const summary of resourceObservation.resources) {
            const row=resources.find(resource=>resource.resourceId===summary.resourceId);
            const pin=verification.data.candidate.resources.find(resource=>resource.resourceId===summary.resourceId);
            if(row===undefined || pin===undefined || summary.resourceRevision!==row.revision || summary.resourceKey!==row.resourceKey ||
                summary.expectedInventoryMapSha256!==pin.inventoryMapSha256 || summary.expectedEntryCount!==pin.entryCount ||
                (row.disposition==="released" && summary.missingPathCount!==summary.expectedEntryCount) ||
                (row.disposition!=="released" && row.resourceId!==permit.data.resourceId && summary.missingPathCount!==0)) {
              return reject("EVIDENCE_INCOMPLETE","another resource has unaccounted missing entries or a changed pin","retain the complete target reservation and every resource obligation");
            }
          }
          if(resourceObservation.status==="observed")cleanupRemoved=[targetRow.resourceKey];
        }
        integrationNextState=cleanupObservation.status==="observed"?"observed":"held";
      } else if(phase==="land") {
        if(expectedPlan===null || action.body?.phase!=="land" || !sameRecoveryPlan((action.body as Record<string,unknown>).recoveryPlan,expectedPlan))return reject("RECOVERY_REQUIRED","LAND receipt has no matching durable intent plan","persist the strict plan before issue/backup/apply");
        const classification=receiptRecord.recoveryClassification;
        const integrity=receiptRecord.backupIntegrity===true;
        const finalMatches=receiptRecord.finalMatchesExpected===true;
        if(typeof receiptRecord.backupIntegrity!=="boolean" || typeof receiptRecord.finalMatchesExpected!=="boolean")return reject("INVALID_RECORD","LAND receipt lacks strict backup/final classification","report full-applied or an explicit held uncertainty");
        if(classification==="full-applied") {
          const pin=DeskTaskMeasurePin.safeParse(receiptRecord.final);
          if(receiptRecord.status!=="observed" || !integrity || !finalMatches || !pin.success || action.targetCwd===null ||
              pin.data.root!==action.targetCwd || pin.data.head!==expectedPlan.expectedCombined.head || pin.data.incomplete.length!==0 ||
              (action.target!==null && pin.data.kind!==action.target.kind))return reject("EVIDENCE_INCOMPLETE","full LAND lacks exact plan/control, verified backup, and complete expected target measure","retain the target/resources and reconcile positive full/original evidence");
          integrationNextState="observed";integrationLanded=pin.data;
        } else if(classification==="partial" || classification==="unknown") {
          if(receiptRecord.status!=="held" || finalMatches || receiptRecord.final!==undefined || receiptRecord.recoveredLand!==undefined)return reject("INVALID_RECORD","partial/unknown LAND cannot carry an observed/final landing pin","record held uncertainty with the immutable plan and backup state");
          integrationNextState="held";
        } else return reject("INVALID_RECORD","LAND recoveryClassification is outside the frozen vocabulary","use full-applied, partial, or unknown");
      } else if(phase==="reconcile") {
        const classification=receiptRecord.recoveryClassification;
        const integrity=receiptRecord.backupIntegrity===true;
        const finalMatches=receiptRecord.finalMatchesExpected===true;
        if(typeof receiptRecord.backupIntegrity!=="boolean" || typeof receiptRecord.finalMatchesExpected!=="boolean")return reject("INVALID_RECORD","reconcile receipt lacks strict backup/final classification","return a measured classification and retained gap when proof is incomplete");
        if(expectedPlan===null) {
          if(receiptRecord.status!=="held" || classification!=="unknown" || finalMatches || receiptRecord.recoveredLand!==undefined ||
              typeof receiptRecord.reason!=="string" || receiptRecord.reason.length===0)return reject("EVIDENCE_INCOMPLETE","legacy LAND lacks an admitted recovery plan and positive equivalent provenance","retain a named gap; do not invent backup absence or landed evidence");
          integrationNextState="held";
        } else if(classification==="full-applied") {
          const targetPin=DeskTaskMeasurePin.safeParse(receiptRecord.target), recovered=DeskTaskMeasurePin.safeParse(receiptRecord.recoveredLand);
          if(receiptRecord.status!=="observed" || !integrity || !finalMatches || !targetPin.success || !recovered.success || action.targetCwd===null ||
              targetPin.data.root!==action.targetCwd || recovered.data.root!==action.targetCwd ||
              targetPin.data.head!==expectedPlan.expectedCombined.head || recovered.data.head!==expectedPlan.expectedCombined.head ||
              targetPin.data.kind!==recovered.data.kind || targetPin.data.snapshotSha256!==recovered.data.snapshotSha256 ||
              targetPin.data.incomplete.length!==0 || recovered.data.incomplete.length!==0 ||
              (action.target!==null && targetPin.data.kind!==action.target.kind))return reject("EVIDENCE_INCOMPLETE","full-applied reconcile lacks exact admitted plan, backup integrity, and complete expected target/recoveredLand pins","retain the fence until the exact expected map/head is positively measured");
          integrationNextState="observed";integrationLanded=recovered.data;
        } else if(classification==="original") {
          const targetPin=DeskTaskMeasurePin.safeParse(receiptRecord.target);
          if(receiptRecord.status!=="observed" || !integrity || finalMatches || receiptRecord.recoveredLand!==undefined || !targetPin.success || action.targetCwd===null ||
              targetPin.data.root!==action.targetCwd || targetPin.data.head!==expectedPlan.targetOriginal.head || targetPin.data.incomplete.length!==0 ||
              (action.target!==null && (targetPin.data.kind!==action.target.kind || targetPin.data.snapshotSha256!==action.target.snapshotSha256)))return reject("EVIDENCE_INCOMPLETE","original classification lacks positive exact original target and backup proof","retain the target fence if the target differs from its admitted original");
          integrationNextState=action.landed===null?"observed":"held";
        } else if(classification==="partial" || classification==="unknown") {
          if(receiptRecord.status!=="held" || finalMatches || receiptRecord.recoveredLand!==undefined)return reject("INVALID_RECORD","partial/unknown reconcile cannot mint landed evidence","keep the target and all recovery resources held");
          const targetPin=receiptRecord.target===null||receiptRecord.target===undefined?null:DeskTaskMeasurePin.safeParse(receiptRecord.target);
          if(targetPin!==null && (!targetPin.success || action.targetCwd===null || targetPin.data.root!==action.targetCwd || targetPin.data.incomplete.length!==0))return reject("EVIDENCE_INCOMPLETE","held reconcile target pin is malformed or incomplete","retain the original target pin and remeasure through the bounded observer");
          integrationNextState="held";
        } else return reject("INVALID_RECORD","reconcile recoveryClassification is outside the frozen vocabulary","use full-applied, original, partial, or unknown");
      } else if(phase==="discharge") {
        const admittedResources=integrationResourceRows(ledger,action);
        const plan=expectedPlan;
        cleanupPaths=plan===null?(action.stageDir===null?[]:[action.stageDir]):[plan.stageDir,plan.backupDir];
        const errors=receiptRecord.errors;
        const removed=receiptRecord.removed;
        if(receiptRecord.grantRef!==action.grant?.authorityRef || !Array.isArray(errors) || errors.some(value=>typeof value!=="string") ||
            !Array.isArray(removed) || removed.some(value=>typeof value!=="string") || new Set(removed).size!==removed.length ||
            !Array.isArray(receiptRecord.admittedPaths) || canonicalJson(receiptRecord.admittedPaths)!==canonicalJson(cleanupPaths) ||
            removed.some(path=>!cleanupPaths.includes(path)) || admittedResources===null || admittedResources.length!==cleanupPaths.length ||
            !cleanupPaths.every(path=>admittedResources.some(row=>row.resourceKey===path && row.disposition!=="transfer-pending")))return reject("EVIDENCE_INCOMPLETE","discharge receipt does not account for every exact action-bound resource/path/grant","retain the target reservation and reconcile before another cleanup phase");
        cleanupRemoved=removed as string[];
        if(receiptRecord.status==="observed") {
          if(errors.length!==0 || canonicalJson(cleanupRemoved)!==canonicalJson(cleanupPaths))return reject("EVIDENCE_INCOMPLETE","successful discharge omitted an admitted path or retained an error","release only after every admitted directory is positively missing");
          integrationNextState="observed";
        } else if(receiptRecord.status==="failed") {
          if(errors.length===0)return reject("INVALID_RECORD","failed cleanup receipt has no recorded error","a failed label must retain its concrete cleanup gap");
          integrationNextState="failed";
        } else return reject("INVALID_RECORD","discharge status must distinguish complete observation from failure","report observed only for the complete admitted path set");
      }
    }
    const lifted: Record<string, unknown> = {};
    const pinFields: [string, string][] = [
      ["sourceBase", "sourceBase"], ["sourceResult", "sourceResult"],
      ["stageBase", "stageBase"], ["prepared", "prepared"], ["base", "sourceBase"],
    ];
    for (const [receiptKey, field] of pinFields) {
      if ((field === "landed") && (receiptRecord.status !== "observed" || receiptRecord.finalMatchesExpected !== true || receiptRecord.phase !== "land")) continue;
      const pin = measurePinOf(receiptRecord[receiptKey]);
      if (pin !== null && lifted[field] === undefined) lifted[field] = pin;
    }
    for (const key of ["stageDir", "stagedSha", "expectedStageSha", "expectedSha", "backupDir", "targetCwd", "sourceCwd", "targetBaseSha", "sourceResultSha", "sourceBaseSha", "deltaDigest"] as const) {
      if (typeof receiptRecord[key] === "string") lifted[key] = receiptRecord[key];
    }
    if (Array.isArray(receiptRecord.checkRuns)) lifted.checkRuns = receiptRecord.checkRuns;
    if (Array.isArray(receiptRecord.conflicts)) lifted.conflicts = receiptRecord.conflicts;
    if (Array.isArray(receiptRecord.changedPaths)) lifted.changedPaths = receiptRecord.changedPaths;
    if (action.actionKind === "integration" && ["stage","check","land","reconcile","discharge"].includes(String(receiptRecord.phase))) lifted.phase = receiptRecord.phase;
    if (receiptRecord.stageKind === "git-worktree" || receiptRecord.stageKind === "content-dir") lifted.stageKind = receiptRecord.stageKind;
    if(action.actionKind==="integration" && expectedPlan!==null && ["land","reconcile","discharge"].includes(String(phase))) {
      if((typeof receiptRecord.stageDir==="string" && receiptRecord.stageDir!==expectedPlan.stageDir) ||
          (typeof receiptRecord.backupDir==="string" && receiptRecord.backupDir!==expectedPlan.backupDir) ||
          (typeof receiptRecord.targetCwd==="string" && receiptRecord.targetCwd!==action.targetCwd) ||
          (typeof receiptRecord.expectedSha==="string" && receiptRecord.expectedSha!==expectedPlan.expectedCombined.mapSha256)) {
        return reject("RECOVERY_REQUIRED","integration receipt rewrites an admitted stage/backup/target/map pin","retain the original target pin and every recovery resource");
      }
    }
    if(action.actionKind==="integration" && integrationLanded!==null)lifted.landed=integrationLanded;
    if(action.actionKind==="integration" && integrationNextState!==null)lifted.state=integrationNextState;
    const stageResourcePath=action.actionKind==="integration" && phase==="stage" && typeof receiptRecord.stageDir==="string"
      ? receiptRecord.stageDir : null;
    const nextResourceIds=[...(action.resourceIds??[])];
    let stageResource:DeskTaskResourceEntryValue|null=null;
    if(stageResourcePath!==null) {
      if(action.stageDir!==null && action.stageDir!==stageResourcePath)return reject("ACTOR_MISMATCH","stage receipt changes its already pinned directory","retain the original integration stage resource");
      const stageId=deriveId("rsc",[action.actionId,"integration-stage"]);
      const existing=latestTaskEntity<DeskTaskResourceEntryValue>(ledger,stageId);
      if(existing===undefined) {
        const kind=receiptRecord.stageKind=== "git-worktree" || action.stageKind==="git-worktree" ? "worktree" : "scratch";
        stageResource=nextEntry<DeskTaskResourceEntryValue>(actor,ledger,cmd.assignmentId,cmd.requestId,stageId,null,{kind:"resource",taskId:action.taskId,
          resourceId:stageId,resourceKind:kind,resourceKey:stageResourcePath,ownerAgentId:actor.agentId as string,ownerMembershipId:actor.membershipId,
          attemptId:null,actionId:action.actionId,disposition:"retained",observedState:"materialized-stage",observedVia:"receipt",
          obligations:[{kind:"remove",ref:stageResourcePath}],releaseRuling:null});
        nextResourceIds.push(stageId);
      } else if(existing.kind!=="resource" || existing.actionId!==action.actionId || existing.resourceKey!==stageResourcePath || existing.disposition==="released") {
        return reject("RECOVERY_REQUIRED","stage identity conflicts with its retained resource row","reconcile the exact action-bound stage resource");
      }
    }
    const resourceUpdates:DeskTaskResourceEntryValue[]=[];
    if(action.actionKind==="integration" && receiptRecord.status==="observed" && cleanupRemoved.length>0) {
      const resources=integrationResourceRows(ledger,action);
      if(resources===null)return reject("EVIDENCE_INCOMPLETE","discharge action has no complete resource identity set","retain and reconcile the admitted resource rows");
      for(const resource of resources)if(cleanupRemoved.includes(resource.resourceKey) && resource.disposition!=="released") {
        resourceUpdates.push(nextEntry<DeskTaskResourceEntryValue>(actor,ledger,cmd.assignmentId,cmd.requestId,resource.resourceId,resource,{...resource,
          disposition:"released",observedState:"missing-after-admitted-cleanup",observedVia:"observer",
          releaseRuling:{reason:"The admitted cleanup phase positively confirmed this path is absent",evidence:[`cleanup:${action.actionId}`],entryId:null}}));
      }
    }
    const baseRows=action.actionKind==="integration"?1:2;
    const headroom=entryHeadroom(ledger,baseRows+(stageResource===null?0:1)+resourceUpdates.length,true);
    if(headroom!==null)return headroom;
    const newAction = nextEntry<DeskTaskActionEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, action.actionId, action, {
      ...action,
      ...lifted,
      kind: "action",
      taskId: action.taskId,
      actionId: action.actionId,
      attemptId: action.attemptId,
      resultId: action.resultId,
      actionKind: action.actionKind,
      ordinal: action.ordinal,
      state: integrationNextState??statusToState[String(receiptRecord.status)] ?? "uncertain",
      receipt: receiptRecord,
      body: action.body,
      bodySha256: action.bodySha256,
      ...(cleanupVerificationNext===null?{}:{cleanupVerification:cleanupVerificationNext}),
      resourceIds:nextResourceIds,
    });
    const rows: TaskEntry[] = [newAction];
    if (!fitsEntry(newAction)) return reject("REQUEST_TOO_LARGE", `action revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the receipt evidence before observing again");
    for(const resource of [...(stageResource===null?[]:[stageResource]),...resourceUpdates]) {
      if(!fitsEntry(resource))return reject("REQUEST_TOO_LARGE",`integration resource revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`,`shrink the retained resource proof`);
      rows.push(resource);
    }
    // Attempt side-effects pinned by kind — the receipt's positive fields
    // land on the attempt only under their declared meaning.
    if (attempt !== undefined && (attempt.state === "reserved" || attempt.state === "bound" || attempt.state === "dispatched" || attempt.state === "running" || attempt.state === "reconciliation-required" || attempt.state === "stop-requested")) {
      let nextState: DeskTaskAttemptEntryValue["state"] = attempt.state;
      let hostAgentId = attempt.host.agentId;
      let placement = attempt.placement;
      let sourceBase = attempt.sourceBase;
      let resultId = attempt.resultId;
      if (receiptRecord.status === "uncertain") {
        nextState = "reconciliation-required";
      } else if (receiptRecord.status === "observed") {
        if (action.actionKind === "place") {
          const observed = DeskTaskDependencyObservation.safeParse(action.body?.dependencyObservation);
          if (attempt.consumedDependencies.length > 0) {
            if (!observed.success || observed.data.consumerBase === null) return reject("EVIDENCE_INCOMPLETE", "placement lost its measured dependency admission", "retain the reservation and reconcile exact base evidence");
            const reference = observed.data.reference;
            const actualBase = measurePinOf(receiptRecord.base) ?? measurePinOf(receiptRecord.sourceBase);
            if (actualBase === null || actualBase.incomplete.length > 0 || (reference !== null
                ? actualBase.head !== reference.resolvedHead || receiptRecord.resolvedHead !== reference.resolvedHead ||
                  receiptRecord.mapSha256 !== reference.mapSha256 || receiptRecord.gitCommonDir !== reference.gitCommonDir
                : actualBase.snapshotSha256 !== observed.data.consumerBase.snapshotSha256)) {
              return reject("CANDIDATE_DRIFT", "materialized consumer base differs from the measured admission/reference map", "preserve the placement and reconcile; do not deliver writable work");
            }
          }
          const cwd = typeof receiptRecord.cwd === "string" ? receiptRecord.cwd : null;
          const base = measurePinOf(receiptRecord.base) ?? measurePinOf(receiptRecord.sourceBase);
          if (cwd !== null) placement = { ...placement, cwd };
          if (base !== null) {
            if (typeof receiptRecord.artifactSha256 === "string") base.artifactSha256 = receiptRecord.artifactSha256;
            sourceBase = base;
          }
        } else if (action.actionKind === "create") {
          const agent = typeof receiptRecord.agentId === "string" ? receiptRecord.agentId
            : (receiptRecord.verification as Record<string, unknown> | undefined)?.agentId;
          if (typeof agent === "string") hostAgentId = agent;
        } else if (action.actionKind === "send") {
          nextState = "running";
        } else if (action.actionKind === "archive") {
          // Archive is host lifecycle evidence, never process quiescence.
          nextState = "stop-requested";
        } else if (action.actionKind === "integration") {
          const landed = measurePinOf(receiptRecord.landed) ?? measurePinOf(receiptRecord.final);
          if (landed !== null) resultId = attempt.resultId;
        }
      } else if (receiptRecord.status === "failed" && action.actionKind === "send") {
        nextState = "bound";
      }
      const stateChanged = nextState !== attempt.state || hostAgentId !== attempt.host.agentId ||
        placement !== attempt.placement || sourceBase !== attempt.sourceBase;
      if (stateChanged) {
        const newAttempt = nextEntry<DeskTaskAttemptEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, attempt.attemptId, attempt, {
          ...attempt, kind: "attempt", taskId: attempt.taskId, attemptId: attempt.attemptId,
          state: nextState, placement, sourceBase, host: { agentId: hostAgentId }, resultId,
        });
        if (!fitsEntry(newAttempt)) return reject("REQUEST_TOO_LARGE", `attempt revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the receipt evidence before observing again");
        rows.push(newAttempt);
      }
    }
    if (action.actionKind === "place" && attempt?.placement.kind === "isolated" && typeof receiptRecord.cwd === "string") {
      const id = deriveId("rsc", [attempt.attemptId, "worktree"]);
      const prior = latestTaskEntity<DeskTaskResourceEntryValue>(ledger, id);
      if (prior === undefined) rows.push(nextEntry<DeskTaskResourceEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, id, null, {
        kind: "resource", taskId: attempt.taskId, resourceId: id, resourceKind: "worktree", resourceKey: receiptRecord.cwd,
        ownerAgentId: actor.agentId, ownerMembershipId: actor.membershipId, attemptId: attempt.attemptId, actionId: action.actionId,
        disposition: "retained", observedState: receiptRecord.status === "observed" ? "materialized" : "materialization-held",
        observedVia: "receipt", obligations: [{ kind: "remove-after-quiescence", ref: receiptRecord.cwd }], releaseRuling: null,
      }));
    }
    if (action.actionKind === "send" && receiptRecord.status === "observed") {
      if (typeof action.body?.messageId !== "string" || receiptRecord.messageId !== action.body.messageId) return reject("EVIDENCE_INCOMPLETE", "delivery receipt has no exact admitted message identity", "keep the action uncertain until its positive message receipt is observed");
      const delivery = latestDeliveriesForTask(ledger, action.taskId).find(row => row.actionId === action.actionId);
      if (delivery !== undefined && delivery.state === "pending") rows.push(nextEntry<DeskTaskDeliveryEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, delivery.deliveryId, delivery, { ...delivery, state: "host-accepted" }));
    }
    const events = rows.map(entryEvent);
    return decided(events, [...ledger.taskEntries, ...rows]);
  }

  // Exact effective owner, or the attempt/delivery-bound member tuple for
  // the ops a bound seat legitimately drives (result, raise, acknowledge).
  const assignment = openAssignment();
  if ("ok" in assignment) return assignment;
  if ("ok" in actor) return actor;
  const refs: string[] = [];
  for (const key of ["taskId", "attemptId", "actionId", "resultId", "deliveryId", "holdId"] as const) {
    const value = (cmd as Record<string, unknown>)[key]; if (typeof value === "string") refs.push(value);
  }
  if (cmd.kind === "task.rule") refs.push(cmd.adjudication.resultId);
  if (cmd.kind === "task.reconcile") refs.push(...cmd.marks.map(row => row.actionId), ...cmd.resourceMarks.map(row => row.resourceId),
    ...cmd.attemptBinds.map(row => row.attemptId), ...cmd.attemptStops, ...cmd.attemptSettles);
  if (refs.some(id => { const row = latestTaskEntity(ledger, id); return row !== undefined && row.assignmentId !== cmd.assignmentId; })) {
    return reject("ACTOR_MISMATCH", "a task reference belongs to another assignment", "all target identities must belong to the exact current assignment");
  }
  const owner = effectiveOwner(ledger, assignment);
  const isOwner = owner.agentId === actor.agentId && owner.membershipId === actor.membershipId;
  const ownerRequired = (): DeskRejectionValue | null =>
    isOwner ? null : reject("ACTOR_MISMATCH", "the actor is not the exact current effective owner tuple", "re-resolve the current owner; a rebound or successor membership is a different authority");
  const boundAttemptMember = (attemptId: string | null | undefined): boolean => {
    if (attemptId === null || attemptId === undefined) return false;
    const row = latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, attemptId);
    return row !== undefined && row.kind === "attempt" && row.member !== null
      && row.member.agentId === actor.agentId && row.member.membershipId === actor.membershipId;
  };
  const cas = checkCas(ledger, cmd.assignmentId, cmd as Record<string, unknown>);
  if (cas !== null) return cas;

  if (cmd.kind === "task.update") {
    const ownerGate = ownerRequired(); if (ownerGate !== null) return ownerGate;
    const prior = latestTask(ledger, cmd.assignmentId, cmd.taskId);
    if (prior === undefined) return reject("INVALID_RECORD", "task update names no committed task", "define the bounded task first");
    const taskCas = checkCas(ledger, cmd.assignmentId, cmd as Record<string, unknown>, prior); if (taskCas !== null) return taskCas;
    const recipes = prior.proofPolicy?.verificationRecipes.map(({ recipeSha256: _digest, ...recipe }) => recipe) ?? [];
    const body = { state: prior.state, outcome: prior.outcome, objective: prior.objective, authorityRef: prior.authorityRef,
      dependencies: prior.dependencies, scope: prior.scope,
      proofPolicy: prior.proofPolicy === null ? null : { ...prior.proofPolicy, verificationRecipes: recipes },
      grants: prior.grants, budgets: prior.budgets, reason: cmd.reason,
      ...(cmd.operation === "amend" ? cmd.task ?? {} : { state: cmd.operation === "reopen" ? "reopened" : "withdrawn" }),
    };
    const parsedBody = DeskTaskCommandBody.safeParse(body); if (!parsedBody.success) return reject("INVALID_RECORD", "updated task body is invalid", "keep the task body bounded and complete");
    return decideDeskTask(ledger, { kind: "task.define", actorAgentId: cmd.actorAgentId, actorMembershipId: cmd.actorMembershipId,
      actorOpenGeneration: cmd.actorOpenGeneration, assignmentId: cmd.assignmentId, requestId: cmd.requestId, taskId: cmd.taskId,
      expectedTaskRevision: cmd.expectedTaskRevision, expectedLedgerRevision: cmd.expectedLedgerRevision ?? ledger.revision,
      expectedBriefRevision: cmd.expectedBriefRevision ?? briefRevisionOf(ledger, cmd.assignmentId),
      expectedOwnershipRevision: cmd.expectedOwnershipRevision ?? ownershipRevisionOf(ledger, cmd.assignmentId), task: parsedBody.data });
  }

  if (cmd.kind === "task.define") {
    const ownerGate = ownerRequired();
    if (ownerGate !== null) return ownerGate;
    const isNew = cmd.expectedTaskRevision === 0;
    const taskId = cmd.taskId ?? deriveId("tsk", [actor.membershipId, cmd.requestId]);
    const prior = latestTask(ledger, cmd.assignmentId, taskId);
    if (isNew && prior !== undefined) {
      return reject("INVALID_RECORD", `task ${taskId} already exists`, "amend an existing task with its current expectedTaskRevision");
    }
    if (!isNew && prior === undefined) {
      return reject("INVALID_RECORD", `task ${taskId} is not declared`, "declare the task before amending it");
    }
    const taskCas = checkCas(ledger, cmd.assignmentId, cmd as Record<string, unknown>, prior);
    if (taskCas !== null) return taskCas;
    const headroom = entryHeadroom(ledger, 1, false);
    if (headroom !== null) return headroom;
    const body = cmd.task;
    const proofPolicy: DeskTaskProofPolicyRowValue | null = body.proofPolicy === null
      ? null
      : {
          ...body.proofPolicy,
          verificationRecipes: body.proofPolicy.verificationRecipes.map(recipe => ({
            ...recipe,
            recipeSha256: canonicalSha256(recipe),
          })),
        };
    const fields: Record<string, unknown> = {
      kind: "task", taskId, state: body.state, outcome: body.outcome, objective: body.objective,
      authorityRef: body.authorityRef, dependencies: body.dependencies, scope: body.scope,
      proofPolicy, grants: body.grants, budgets: body.budgets, reason: body.reason,
    };
    const row = nextEntry<DeskTaskDeclarationEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, taskId, prior ?? null, fields);
    if (!taskGraphValid([...ledger.taskEntries, row])) return reject("SCOPE_CONFLICT", "task dependencies are unknown, repeated, cross-assignment or cyclic", "declare a bounded acyclic dependency graph with exact producer identities");
    if (!fitsEntry(row)) return reject("REQUEST_TOO_LARGE", `task revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "split the declaration or shrink its surfaces");
    return decided([entryEvent(row)], [...ledger.taskEntries, row]);
  }

  if (cmd.kind === "task.reserve") {
    const ownerGate = ownerRequired();
    if (ownerGate !== null) return ownerGate;
    const task = latestTask(ledger, cmd.assignmentId, cmd.taskId);
    if (task === undefined) return reject("INVALID_RECORD", `task ${cmd.taskId} is not declared`, "declare the task before reserving an attempt");
    const taskCas = checkCas(ledger, cmd.assignmentId, cmd as Record<string, unknown>, task);
    if (taskCas !== null) return taskCas;
    if (task.state === "withdrawn") return reject("INVALID_RECORD", `task ${cmd.taskId} is withdrawn`, "withdrawn tasks accept no new attempts");
    if(cmd.grantRef !== (cmd.reuseTarget==="new" ? task.grants.create : task.grants.send)) return reject("AUTHORITY_REQUIRED","reservation grant differs from current task operation grant","creation and reuse/send require their own grants");
    const readiness = currentTaskReadiness(ledger, assignment, task);
    if (!readiness.eligible) {
      return reject("INVALID_RECORD", `task ${cmd.taskId} is not dispatch-ready (${readiness.reasons.join(",") || readiness.bucket})`, "resolve the recorded hold/dependency reasons and re-check readiness");
    }
    if(cmd.effectBudget!==undefined && cmd.effectBudget>(task.budgets.maxActionsPerAttempt??WIRE_LIMITS.deskTaskActions))return reject("RETRY_EXHAUSTED","effect budget exceeds the declared task budget","amend budgets under current owner authority before another reservation");
    const attemptCount = latestAttemptsForTask(ledger, cmd.taskId).length;
    if (task.budgets.maxAttempts !== null && attemptCount >= task.budgets.maxAttempts) {
      return reject("RETRY_EXHAUSTED", `task ${cmd.taskId} exhausted its ${task.budgets.maxAttempts}-attempt budget`, "amend the task budget under owner authority before another attempt");
    }
    // Reservation overlap — declared scope surfaces plus the placement cwd,
    // against live task attempts AND the legacy scope table, both directions.
    const reservation = reservationSurfaces(task.scope, cmd.placement.cwd ?? null);
    for (const attempt of ledger.taskEntries) {
      if (attempt.kind !== "attempt" || attempt.state === "settled" || attempt.state === "stopped") continue;
      const live = latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, attempt.attemptId);
      if (live === undefined || live.kind !== "attempt" || live.state === "settled" || live.state === "stopped") continue;
      const liveTask = ledger.taskEntries.find(row=>row.kind==="task" && row.assignmentId===live.assignmentId && row.taskId===live.taskId && row.revision===live.taskRevision);
      const liveReservation = reservationSurfaces(liveTask?.kind === "task" ? liveTask.scope : null, live.placement.cwd);
      if (surfacesOverlap(reservation, liveReservation)) {
        return reject("SCOPE_CONFLICT", `reservation overlaps live attempt ${live.attemptId}`, "hold the new attempt until the overlapping reservation discharges");
      }
    }
    for (const scope of ledger.scopes) {
      const current = ledger.scopes.filter(row => row.assignmentId === scope.assignmentId && row.scopeId === scope.scopeId).at(-1);
      const transition = ledger.scopeTransitions.filter(row => row.assignmentId === scope.assignmentId && row.scopeId === scope.scopeId).at(-1);
      if (current?.revision !== scope.revision || transition?.to === "closed" || transition?.to === "advanced") continue;
      const ownership = scope.ownership;
      if (ownership === null || ownership === undefined) continue;
      const legacy: ReservationSurfaces = {
        paths: ownership.paths ?? [], resources: ownership.resources ?? [],
        stateOwners: ownership.stateOwners ?? [],
      };
      if (surfacesOverlap(reservation, legacy)) {
        return reject("SCOPE_CONFLICT", `reservation overlaps declared scope ${scope.scopeId}`, "discharge the overlapping scope or narrow the task reservation");
      }
    }
    const headroom = entryHeadroom(ledger, 2, false);
    if (headroom !== null) return headroom;
    const pins: DeskTaskDependencyPinValue[] = [];
    for (const dep of task.dependencies) {
      const resolved = resolveDependencyPin(ledger, dep);
      if ("reason" in resolved) {
        return reject("INVALID_RECORD", `dependency ${dep.taskId} is ${resolved.reason}`, "reserve only when every declared dependency stands ruled");
      }
      pins.push(resolved.pin);
    }
    const measured = validateDependencyObservation(ledger, pins, cmd.placement, cmd.dependencyObservation ?? null);
    if (measured !== null) return measured;
    for (const pin of pins) {
      if (pin.availability === "integrated-code") pin.actualTargetPin = cmd.dependencyObservation!.results.find(row => row.taskId === pin.taskId)!.actualTargetPin;
    }
    const attemptId = deriveId("att", [cmd.taskId, String(attemptCount + 1)]);
    const attempt = nextEntry<DeskTaskAttemptEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, attemptId, null, {
      kind: "attempt", taskId: cmd.taskId, attemptId,
      attemptNo: attemptCount + 1, taskRevision: task.revision,
      state: "reserved",
      placement: {
        kind: cmd.placement.kind,
        cwd: cmd.placement.cwd ?? null,
        baseRef: cmd.placement.baseRef ?? null,
        workspaceId: cmd.placement.workspaceId ?? null,
      },
      sourceBase: null, consumedDependencies: pins,
      ownerAgentId: actor.agentId as string, ownerMembershipId: actor.membershipId,
      seatPin: cmd.seatPin, runtime: cmd.runtime,
      reuseTarget: cmd.reuseTarget === "new" ? null : { agentId: cmd.reuseTarget.agentId },
      member: null, host: { agentId: null },
      boundScopeId: null, boundScopeRevision: null,
      stop: { requested: false, reason: null },
      predecessor: cmd.predecessor ?? null,
      resultId: null, integrationActionId: null,
      capacityCredits: {
        // The active store reserve is derived from each actual unresolved
        // action/resource/delivery plus the fixed terminal attempt pair.
        // Keep this persisted admission context to that terminal minimum;
        // the former blanket twelve-slot promise hid headroom consumers.
        requestSlots: 1,
        entrySlots: 2,
        byteBudget: 2 * (WIRE_LIMITS.deskTaskEntryBytes * 2 + 4096) + 4096,
      },
      effectBudget: cmd.effectBudget ?? Math.min(task.budgets.maxActionsPerAttempt??WIRE_LIMITS.deskTaskActions,WIRE_LIMITS.deskTaskActions),
    });
    if (!fitsEntry(attempt)) return reject("REQUEST_TOO_LARGE", `attempt revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the reservation before reserving again");
    const placeActionId = deriveId("act", [attemptId, "place", "1"]);
    const placeBody = {
      placement: cmd.placement,
      dependencyObservation: cmd.dependencyObservation ?? null,
      reuseTarget: cmd.reuseTarget === "new" ? null : cmd.reuseTarget,
    };
    const placeAction = nextEntry<DeskTaskActionEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, placeActionId, null, {
      kind: "action", taskId: cmd.taskId, actionId: placeActionId,
      attemptId, resultId: null, actionKind: "place", ordinal: 1, phase: null,
      body: placeBody, bodySha256: canonicalSha256(placeBody),
      state: "intended", callerAgentId: actor.agentId as string, parentAgentId: null, reportTo: null,
      receipt: null, grant: null, verification: null,
      sourceBase: null, sourceResult: null, target: null,
      sourceBaseSha: null, sourceResultSha: null, targetBaseSha: null,
      targetCwd: null, sourceCwd: null, stageKind: null, stageDir: null,
      stagedSha: null, expectedStageSha: null, expectedSha: null, backupDir: null,
      checkRuns: null, conflicts: null, changedPaths: null, deltaDigest: null,
      scopeWriter: null, qualificationDigest: null, proofPolicyDigest: null,
      requiredChecks: null, commitGrantRef: null, stageBase: null, prepared: null,
      landIntent: null, recoveryPlan: null, cleanupVerification: null, cleanupIssueEvidence: null,
      landed: null, uncertainties: null, resourceIds: null,
    });
    if (!fitsEntry(placeAction)) return reject("REQUEST_TOO_LARGE", `action revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the intent body before reserving again");
    return decided([entryEvent(attempt), entryEvent(placeAction)], [...ledger.taskEntries, attempt, placeAction]);
  }

  if (cmd.kind === "task.result") {
    const task = latestTask(ledger, cmd.assignmentId, cmd.taskId);
    if (task === undefined) return reject("INVALID_RECORD", `task ${cmd.taskId} is not declared`, "declare the task before committing its result");
    const taskCas = checkCas(ledger, cmd.assignmentId, cmd as Record<string, unknown>, task);
    if (taskCas !== null) return taskCas;
    const attempt = latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, cmd.attemptId);
    if (attempt === undefined || attempt.kind !== "attempt" || attempt.taskId !== cmd.taskId) {
      return reject("ACTOR_MISMATCH", `unknown attempt ${cmd.attemptId}`, "results name an attempt of the same task");
    }
    if (!isOwner && !boundAttemptMember(attempt.attemptId)) {
      return reject("ACTOR_MISMATCH", "the actor is neither the current owner nor this attempt's bound member tuple", "results commit under the owner or the bound seat that produced the output");
    }
    if (attempt.state === "settled" || attempt.state === "stopped" || attempt.state === "reserved") {
      return reject("INVALID_RECORD", `attempt ${cmd.attemptId} is ${attempt.state}`, "a result commits only for an attempt that produced output");
    }
    if (cmd.result.scopeId !== attempt.boundScopeId || cmd.result.scopeRevision !== attempt.boundScopeRevision ||
        (cmd.result.candidate !== null && cmd.result.candidate.snapshotSha256 !== cmd.result.snapshotSha256)) {
      return reject("CANDIDATE_DRIFT", "result does not carry its exact bound scope/candidate pins", "retain the output under the attempt that produced it");
    }
    const headroom = entryHeadroom(ledger, 2, false);
    if (headroom !== null) return headroom;
    const resultId = deriveId("res", [cmd.attemptId, cmd.requestId]);
    const body = cmd.result;
    const result = nextEntry<DeskTaskResultEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, resultId, null, {
      kind: "result", taskId: cmd.taskId, resultId, attemptId: cmd.attemptId,
      taskRevision: attempt.taskRevision,
      snapshotSha256: body.snapshotSha256, candidate: body.candidate,
      handbackId: body.handbackId, handbackDigest: body.handbackDigest,
      artifacts: body.artifacts, scopeId: body.scopeId, scopeRevision: body.scopeRevision,
      reviewRound: body.reviewRound, checkRuns: body.checkRuns,
      consumedDependencies: attempt.consumedDependencies,
      findings: body.findings, provenance: body.provenance,
    });
    if (!fitsEntry(result)) return reject("REQUEST_TOO_LARGE", `result revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the result evidence before committing again");
    const newAttempt = nextEntry<DeskTaskAttemptEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, cmd.attemptId, attempt, {
      ...attempt, kind: "attempt", taskId: attempt.taskId, attemptId: attempt.attemptId, resultId,
    });
    if (!fitsEntry(newAttempt)) return reject("REQUEST_TOO_LARGE", `attempt revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the result evidence before committing again");
    const delivery = newDelivery(actor, ledger, cmd.requestId, cmd.taskId, cmd.assignmentId,
      { agentId: owner.agentId, membershipId: owner.membershipId }, "handback", attempt.attemptId, null, resultId, result.entrySha256);
    return decided([result, newAttempt, delivery].map(entryEvent), [...ledger.taskEntries, result, newAttempt, delivery]);
  }

  if (cmd.kind === "task.rule") {
    const ownerGate = ownerRequired();
    if (ownerGate !== null) return ownerGate;
    const task = latestTask(ledger, cmd.assignmentId, cmd.taskId);
    if (task === undefined) return reject("INVALID_RECORD", `task ${cmd.taskId} is not declared`, "declare the task before ruling its result");
    const taskCas = checkCas(ledger, cmd.assignmentId, cmd as Record<string, unknown>, task);
    if (taskCas !== null) return taskCas;
    const body = cmd.adjudication;
    const result = latestTaskEntity<DeskTaskResultEntryValue>(ledger, body.resultId);
    if (result === undefined || result.kind !== "result" || result.taskId !== cmd.taskId) {
      return reject("INVALID_RECORD", `unknown result ${body.resultId}`, "an adjudication names a committed result of the same task");
    }
    if (result.revision !== body.expectedResultRevision) {
      return reject("REVISION_CONFLICT", `expected result revision ${body.expectedResultRevision} but the current revision is ${result.revision}`, "re-read the result and rule its current revision");
    }
    if(body.verdict==="accepted" && (result.taskRevision!==task.revision || result.briefRevision!==briefRevisionOf(ledger,cmd.assignmentId) || !dependencyPinsCurrent(ledger,result.consumedDependencies)))return reject("REVISION_CONFLICT","accepted ruling targets stale task/brief/dependency output","retain historical output and request rework with current pins");
    const headroom = entryHeadroom(ledger, 1, false);
    if (headroom !== null) return headroom;
    const adjudicationId = deriveId("adj", [body.resultId, cmd.requestId]);
    const ruling = nextEntry<DeskTaskAdjudicationEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, adjudicationId, null, {
      kind: "adjudication", taskId: cmd.taskId, adjudicationId,
      resultId: result.resultId, resultRevision: result.revision, resultEntrySha256: result.entrySha256,
      taskRevision: task.revision, attemptId: result.attemptId,
      verdict: body.verdict, reason: body.reason, evidence: body.evidence,
      counterevidence: body.counterevidence, residualRisk: body.residualRisk, findings: body.findings,
      proofPolicyDigest: task.proofPolicy !== null ? canonicalSha256(task.proofPolicy) : null,
      dependencyPins: result.consumedDependencies,
    });
    if (!fitsEntry(ruling)) return reject("REQUEST_TOO_LARGE", `adjudication revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the ruling evidence before committing again");
    return decided([entryEvent(ruling)], [...ledger.taskEntries, ruling]);
  }

  if (cmd.kind === "task.hold") {
    // A ruling is owner-only; a bound seat may RAISE a hold (question) on
    // its own attempt without borrowing owner authority.
    if (cmd.ruling !== null) {
      const ownerGate = ownerRequired();
      if (ownerGate !== null) return ownerGate;
    } else if (!isOwner && !boundAttemptMember(cmd.attemptId)) {
      return reject("ACTOR_MISMATCH", "the actor is neither the current owner nor this attempt's bound member tuple", "a bound seat raises holds on its own attempt; rulings are owner-only");
    }
    const task = latestTask(ledger, cmd.assignmentId, cmd.taskId);
    if (task === undefined) return reject("INVALID_RECORD", `task ${cmd.taskId} is not declared`, "declare the task before holding it");
    const taskCas = checkCas(ledger, cmd.assignmentId, cmd as Record<string, unknown>, task);
    if (taskCas !== null) return taskCas;
    if(cmd.attemptId!==null){const attempt=latestTaskEntity<DeskTaskAttemptEntryValue>(ledger,cmd.attemptId);if(attempt?.kind!=="attempt" || attempt.taskId!==cmd.taskId)return reject("ACTOR_MISMATCH","hold names another task's attempt","questions remain bound to the exact worker attempt");}
    if (cmd.holdId === null && cmd.hold === null) {
      return reject("INVALID_RECORD", "a hold command needs either a new hold body or a ruling", "create a hold or rule an existing one");
    }
    const headroom = entryHeadroom(ledger, 1, false);
    if (headroom !== null) return headroom;
    if (cmd.hold !== null) {
      const body = cmd.hold;
      const holdId = cmd.holdId ?? deriveId("hld", [cmd.taskId, cmd.requestId]);
      const hold = nextEntry<DeskTaskHoldEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, holdId, null, {
        kind: "hold", taskId: cmd.taskId, holdId, attemptId: cmd.attemptId,
        holdKind: body.holdKind, question: body.question, proposition: body.proposition,
        claimRefs: body.claimRefs, resourceIds: body.resourceIds,
        state: "open", ruling: null,
      });
      if (!fitsEntry(hold)) return reject("REQUEST_TOO_LARGE", `hold revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the hold before committing again");
      return decided([entryEvent(hold)], [...ledger.taskEntries, hold]);
    }
    const holdId = cmd.holdId!;
    const prior = latestTaskEntity<DeskTaskHoldEntryValue>(ledger, holdId);
    if (prior === undefined || prior.kind !== "hold" || prior.taskId !== cmd.taskId) {
      return reject("INVALID_RECORD", `unknown hold ${holdId}`, "rule only a hold the ledger committed");
    }
    const releasableRetain = prior.state === "ruled" && prior.ruling?.outcome === "retain" &&
      (cmd.ruling?.outcome === "release" || cmd.ruling?.outcome === "withdraw");
    if (prior.state !== "open" && !releasableRetain) {
      return reject("INVALID_RECORD", `hold ${holdId} is terminal`, "only a current owner may release or withdraw a retained hold; release and withdraw do not reopen");
    }
    if (cmd.ruling === null) {
      return reject("INVALID_RECORD", "a ruling command needs its ruling body", "supply reason and outcome");
    }
    const ruled = nextEntry<DeskTaskHoldEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, holdId, prior, {
      ...prior, kind: "hold", taskId: prior.taskId, holdId,
      state: "ruled",
      ruling: {
        reason: cmd.ruling.reason, outcome: cmd.ruling.outcome,
        ownerAgentId: actor.agentId as string, ownerMembershipId: actor.membershipId,
        briefRevision: briefRevisionOf(ledger, cmd.assignmentId),
      },
    });
    if (!fitsEntry(ruled)) return reject("REQUEST_TOO_LARGE", `hold revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the ruling before committing again");
    return decided([entryEvent(ruled)], [...ledger.taskEntries, ruled]);
  }

  if (cmd.kind === "task.stop") {
    const ownerGate = ownerRequired();
    if (ownerGate !== null) return ownerGate;
    const attemptId = cmd.attemptId ?? (cmd.taskId !== null ? liveAttemptForTask(ledger, cmd.taskId)?.attemptId : undefined);
    if (attemptId === undefined) {
      return reject("INVALID_RECORD", "no live attempt matches the stop target", "name an attemptId or a taskId with a live attempt");
    }
    const attempt = latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, attemptId);
    if (attempt === undefined || attempt.kind !== "attempt") {
      return reject("INVALID_RECORD", `unknown attempt ${attemptId}`, "stop only a committed attempt");
    }
    if(cmd.taskId!==null && attempt.taskId!==cmd.taskId)return reject("ACTOR_MISMATCH","stop task and attempt identity differ","target the attempt belonging to the named task");
    if (attempt.state === "settled" || attempt.state === "stopped") {
      return reject("INVALID_RECORD", `attempt ${attemptId} is ${attempt.state}`, "terminal attempts need no stop");
    }
    const headroom = entryHeadroom(ledger, 2, true);
    if (headroom !== null) return headroom;
    const stopped = nextEntry<DeskTaskAttemptEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, attemptId, attempt, {
      ...attempt, kind: "attempt", taskId: attempt.taskId, attemptId,
      state: "stop-requested", stop: { requested: true, reason: cmd.reason },
    });
    const outstanding = latestActions(ledger, { attemptId })
      .filter(row => row.state === "issued" || row.state === "uncertain" || row.state === "intended")
      .map(row => row.actionId);
    const controlId = deriveId("ctl", [attemptId, cmd.requestId]);
    const control = nextEntry<DeskTaskControlEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, controlId, null, {
      kind: "control", taskId: attempt.taskId, controlId,
      targetTaskId: cmd.taskId ?? attempt.taskId, targetAttemptId: attemptId,
      state: "stop-requested", reason: cmd.reason,
      outstandingActionIds: outstanding, outstandingResourceIds: [],
    });
    if (!fitsEntry(stopped) || !fitsEntry(control)) return reject("REQUEST_TOO_LARGE", `stop revisions exceed the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the stop reason before committing again");
    return decided([entryEvent(stopped), entryEvent(control)], [...ledger.taskEntries, stopped, control]);
  }

  if (cmd.kind === "task.acknowledge") {
    const delivery = latestTaskEntity<DeskTaskDeliveryEntryValue>(ledger, cmd.deliveryId);
    if (delivery === undefined || delivery.kind !== "delivery") {
      return reject("INVALID_RECORD", `unknown delivery ${cmd.deliveryId}`, "acknowledge only a committed delivery");
    }
    const isRecipient = delivery.recipientAgentId === actor.agentId && delivery.recipientMembershipId === actor.membershipId;
    if (!isRecipient) {
      return reject("ACTOR_MISMATCH", "the actor is neither the current owner nor this delivery's recipient tuple", "acknowledgments commit under the owner or the exact recipient seat");
    }
    const order: Record<string, number> = { pending: 0, "host-accepted": 1, "responsibility-acknowledged": 2, handled: 3 };
    const target = cmd.acknowledgment === "responsibility-acknowledged" ? "responsibility-acknowledged" : "handled";
    if (order[delivery.state] >= order[target]) {
      return reject("INVALID_RECORD", `delivery ${cmd.deliveryId} is already ${delivery.state}`, "acknowledgments advance the delivery state monotonically");
    }
    if (target === "handled" && delivery.state !== "responsibility-acknowledged") {
      return reject("INVALID_RECORD", `delivery ${cmd.deliveryId} is ${delivery.state} — a responsibility acknowledgment must land first`, "the receiving side acknowledges responsibility before the delivery is handled");
    }
    const headroom = entryHeadroom(ledger, 1, true);
    if (headroom !== null) return headroom;
    const next = nextEntry<DeskTaskDeliveryEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, cmd.deliveryId, delivery, {
      ...delivery, kind: "delivery", taskId: delivery.taskId, deliveryId: cmd.deliveryId,
      state: target, reason: cmd.reason,
      ...(target === "responsibility-acknowledged" ? { ackEvidence: cmd.reason === null ? [] : [cmd.reason] } : { handlingEvidence: cmd.reason === null ? [] : [cmd.reason] }),
    });
    if (!fitsEntry(next)) return reject("REQUEST_TOO_LARGE", `delivery revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the acknowledgment before committing again");
    return decided([entryEvent(next)], [...ledger.taskEntries, next]);
  }

  if (cmd.kind === "task.reconcile") {
    const ownerGate = ownerRequired(); if (ownerGate !== null) return ownerGate;
    if(cmd.observedLedgerRevision!==ledger.revision)return reject("REVISION_CONFLICT","ledger changed during reconciliation observation","observe again against one pinned revision");
    const unique = (ids: string[]) => new Set(ids).size === ids.length;
    if (!unique(cmd.marks.map(row => row.actionId)) || !unique(cmd.resourceMarks.map(row => row.resourceId)) ||
        !unique(cmd.releaseRulings.map(row => row.resourceId)) || !unique(cmd.attemptRulings.map(row => row.attemptId))) return reject("INVALID_RECORD", "reconciliation repeats an entity", "rule each exact obligation once per request");
    let working: LedgerValue = { ...ledger };
    const events: {kind:string;payload:Record<string,unknown>}[] = [];
    const apply = (outcome: DecideOutcome): DeskRejectionValue | null => {
      if (!outcome.ok) return outcome;
      const {ok:_ok, events:added, ...tables} = outcome;
      working = { ...working, ...tables }; events.push(...added); return null;
    };
    const append = (row: TaskEntry) => { working = {...working,taskEntries:[...working.taskEntries,row]}; events.push(entryEvent(row)); };
    for (const mark of cmd.marks) {
      const action = latestTaskEntity<DeskTaskActionEntryValue>(working, mark.actionId);
      if (action?.kind !== "action" || action.assignmentId !== cmd.assignmentId) return reject("ACTOR_MISMATCH", "unknown/foreign reconciliation action", "observe the exact assignment action");
      if (!["issued","uncertain","held","intended"].includes(action.state)) return reject("INVALID_RECORD", "action is no longer unresolved", "read current action pins");
      if (mark.outcome === "abandoned") {
        if (action.state !== "intended") return reject("EVIDENCE_INCOMPLETE", "issued actions cannot be abandoned by lack of evidence", "retain uncertainty until positive reconciliation");
        append(nextEntry(actor, working, cmd.assignmentId, cmd.requestId, action.actionId, action, {...action,state:"abandoned",receipt:{status:"failed",phase:"reconciled",reason:"never-issued-intent",evidence:mark.evidence}}));
      } else {
        if (action.state === "intended") continue;
        const observation = decideDeskTask(working, {kind:"task.effect.observe",actorAgentId:cmd.actorAgentId,actorMembershipId:cmd.actorMembershipId,actorOpenGeneration:cmd.actorOpenGeneration,
          assignmentId:cmd.assignmentId,requestId:cmd.requestId,taskId:action.taskId,attemptId:action.attemptId,resultId:action.resultId,actionId:action.actionId,actionKind:action.actionKind,
          receipt:{...(mark.receipt ?? {}),status:mark.outcome === "still-uncertain" ? "uncertain" : mark.outcome,phase:"reconciled",evidence:mark.evidence}});
        const error=apply(observation); if(error!==null)return error;
      }
    }
    for (const mark of cmd.attemptBinds) {
      const attempt=latestTaskEntity<DeskTaskAttemptEntryValue>(working,mark.attemptId);
      const member=working.memberships.find(row=>row.membershipId===mark.membershipId);
      if(attempt?.kind!=="attempt" || attempt.assignmentId!==cmd.assignmentId || member?.agentId==null)return reject("ACTOR_MISMATCH","reconciliation bind has no exact observed membership","retain seat-pending until exact registration");
      const error=apply(decideDeskTask(working,{kind:"task.effect.bind",actorAgentId:cmd.actorAgentId,actorMembershipId:cmd.actorMembershipId,actorOpenGeneration:cmd.actorOpenGeneration,
        assignmentId:cmd.assignmentId,requestId:cmd.requestId,attemptId:attempt.attemptId,member:{agentId:member.agentId,membershipId:member.membershipId},
        observed:{provider:member.provider,createCwd:member.createCwd,workspaceId:member.workspaceId}}));if(error!==null)return error;
    }
    for (const ruling of cmd.releaseRulings) {
      const resource=latestTaskEntity<DeskTaskResourceEntryValue>(working,ruling.resourceId);
      if(resource?.kind!=="resource" || resource.assignmentId!==cmd.assignmentId)return reject("ACTOR_MISMATCH","unknown/foreign resource ruling","rule the exact assignment obligation");
      if(resource.revision!==ruling.expectedResourceRevision)return reject("REVISION_CONFLICT","resource ruling revision changed","read its current retained revision");
      const resourceAction=resource.actionId===null?undefined:latestTaskEntity<DeskTaskActionEntryValue>(working,resource.actionId);
      if(resourceAction?.kind==="action" && resourceAction.actionKind==="integration")return reject("EVIDENCE_INCOMPLETE","integration resources require the immutable verified cleanup account and exact issued per-resource permit","retain the target fence and use the admitted integration discharge path");
      const mark=cmd.resourceMarks.find(row=>row.resourceId===ruling.resourceId);
      const neverAuthorized=resource.attemptId!==null && !ledger.taskEntries.some(row=>row.kind==="action" && row.attemptId===resource.attemptId &&
        (row.actionKind==="create" || row.actionKind==="send") && ["issued","observed","uncertain","held"].includes(row.state));
      if(!mark?.positive || mark.evidence.length===0 || ((resource.resourceKind==="agent" || resource.resourceKind==="process" || resource.resourceKind==="membership") && !mark.quiescent && !neverAuthorized)) {
        return reject("EVIDENCE_INCOMPLETE","resource release has no positive kind-specific observation and adequate quiescence","archive/revoke/idle/absence alone retain obligations");
      }
      const releaseRuling={reason:ruling.reason,evidence:[...ruling.evidence,...mark.evidence.map(item=>item.ref)].slice(0,WIRE_LIMITS.deskBriefRefs),entryId:null};
      append(nextEntry(actor,working,cmd.assignmentId,cmd.requestId,resource.entityId,resource,{...resource,disposition:"released",observedState:mark.observedState,observedVia:"observer",releaseRuling}));
    }
    for (const ruling of cmd.attemptRulings) {
      const original=latestTaskEntity<DeskTaskAttemptEntryValue>(ledger,ruling.attemptId);
      const attempt=latestTaskEntity<DeskTaskAttemptEntryValue>(working,ruling.attemptId);
      if(original?.kind!=="attempt" || attempt?.kind!=="attempt" || attempt.assignmentId!==cmd.assignmentId)return reject("ACTOR_MISMATCH","unknown/foreign terminal attempt ruling","rule the retained exact attempt");
      if(original.revision!==ruling.expectedAttemptRevision)return reject("REVISION_CONFLICT","terminal attempt ruling revision changed","read the current retained attempt");
      const outstanding=latestActions(working,{attemptId:attempt.attemptId}).some(row=>["issued","uncertain","intended","held"].includes(row.state));
      const resources=latestResourcesForTask(working,attempt.taskId).filter(row=>row.attemptId===attempt.attemptId);
      const deliveries=latestDeliveriesForTask(working,attempt.taskId).filter(row=>row.attemptId===attempt.attemptId);
      if(outstanding || resources.some(row=>row.disposition!=="released") || deliveries.some(row=>row.state!=="handled"))return reject("EVIDENCE_INCOMPLETE","terminal attempt has unresolved effect/delivery/resource obligations","retain its reservation and writer until every supported obligation is discharged");
      const neverAuthorized=!ledger.taskEntries.some(row=>row.kind==="action" && row.attemptId===attempt.attemptId && (row.actionKind==="send" || row.actionKind==="create") && ["issued","observed","uncertain","held"].includes(row.state));
      const observationRefs=cmd.resourceMarks.filter(row=>row.quiescent && row.positive).flatMap(row=>row.evidence.map(item=>item.ref));
      if(!neverAuthorized && observationRefs.length===0)return reject("EVIDENCE_INCOMPLETE","worker/process quiescence is unproved","retain reservation; lifecycle archive or turn end is insufficient");
      const proof={kind:neverAuthorized?"never-authorized-work" as const:"observed-quiescence" as const,reason:ruling.reason,evidence:ruling.evidence,observationRefs};
      if(ruling.disposition==="settled") {
        if(!currentTaskResultQualification(working,cmd.assignmentId,attempt.taskId).qualified)return reject("EVIDENCE_INCOMPLETE","completed attempt lacks a current accepted qualified result","completion and cancellation are separate");
        if(attempt.boundScopeId!==null) {
          const scope=working.scopes.filter(row=>row.scopeId===attempt.boundScopeId && row.assignmentId===cmd.assignmentId).at(-1)!;
          const transition=working.scopeTransitions.filter(row=>row.scopeId===attempt.boundScopeId && row.assignmentId===cmd.assignmentId).at(-1);
          if(transition?.to!=="closed") {
            const error=apply(decideDeskScope(working,{kind:"scope.transition",requestId:cmd.requestId,actorAgentId:cmd.actorAgentId,assignmentId:cmd.assignmentId,
              scopeId:scope.scopeId,scopeRevision:scope.revision,transition:"close",candidateSnapshot:null,candidateHead:null,briefRevision:briefRevisionOf(working,cmd.assignmentId)})); if(error!==null)return error;
          }
        }
      }
      const terminal=nextEntry<DeskTaskAttemptEntryValue>(actor,working,cmd.assignmentId,cmd.requestId,attempt.entityId,attempt,{...attempt,state:ruling.disposition,terminalProof:proof});append(terminal);
      if(ruling.disposition==="stopped") {
        const priorControl=latestControlsForTask(working,attempt.taskId).find(row=>row.targetAttemptId===attempt.attemptId);
        const id=priorControl?.controlId ?? deriveId("ctl",[attempt.attemptId,cmd.requestId]);
        const control=nextEntry<DeskTaskControlEntryValue>(actor,working,cmd.assignmentId,cmd.requestId,id,priorControl??null,{kind:"control",taskId:attempt.taskId,controlId:id,
          targetTaskId:attempt.taskId,targetAttemptId:attempt.attemptId,state:"stop-observed",reason:ruling.reason,outstandingActionIds:[],outstandingResourceIds:[]});append(control);
        const error=apply(decideTaskScopeCancellation(working,{actorAgentId:cmd.actorAgentId,actorMembershipId:cmd.actorMembershipId,assignmentId:cmd.assignmentId,attemptId:attempt.attemptId,controlId:id,requestId:cmd.requestId}));if(error!==null)return error;
      }
    }
    const added=working.taskEntries.slice(ledger.taskEntries.length);
    if(added.some(row=>!fitsEntry(row)))return reject("REQUEST_TOO_LARGE","reconciliation evidence exceeds entry bounds","bound the proof without pruning history");
    const headroom=entryHeadroom(ledger,added.length,true);if(headroom!==null)return headroom;
    return {ok:true,events,taskEntries:working.taskEntries,assignments:working.assignments,scopes:working.scopes,scopeTransitions:working.scopeTransitions};
  }

  if (cmd.kind === "task.effect.intent") {
    const ownerGate = ownerRequired();
    if (ownerGate !== null) return ownerGate;
    if (cmd.actionId !== null) {
      // Phase intent on an existing action — currently the land/discharge
      // intents on an integration action.
      const action = latestTaskEntity<DeskTaskActionEntryValue>(ledger, cmd.actionId);
      if (action === undefined || action.kind !== "action") {
        return reject("ACTOR_MISMATCH", `unknown action ${cmd.actionId}`, "a phase intent names a committed action");
      }
      if (action.actionKind !== "integration") {
        return reject("INVALID_RECORD", `action ${cmd.actionId} is not an integration action`, "phase intents apply to integration actions only");
      }
      const controlGate = phaseControlGate(ledger, action, cmd.body.controlPins);
      if (controlGate !== null) return controlGate;
      const phase = typeof (cmd.body as Record<string, unknown>).phase === "string" ? (cmd.body as Record<string, unknown>).phase as string : null;
      if (phase !== "land" && phase !== "discharge" && phase !== "check") {
        return reject("INVALID_RECORD", `phase intent ${JSON.stringify(phase)} is not land/discharge/check`, "integration phase intents are closed");
      }
      const cleanupStep = phase === "discharge" ? cmd.body.cleanupStep : null;
      const currentTask = latestTask(ledger, cmd.assignmentId, cmd.taskId ?? action.taskId);
      if (phase === "discharge" && (action.grant?.authorityRef == null || cmd.body.grantRef !== action.grant.authorityRef ||
          currentTask?.grants.integrate !== action.grant.authorityRef)) return reject("AUTHORITY_REQUIRED", "cleanup grant differs from the admitted/current integration grant", "cleanup is separately granted; preserve proof and resources on denial");
      if(phase==="discharge" && (cleanupStep!=="verify-account" && cleanupStep!=="remove-resource"))return reject("INVALID_RECORD","discharge intent requires a closed internal cleanupStep","verify the account first, then issue one exact stage/backup resource permit");
      if(phase==="discharge" && (typeof cmd.body.publicRequestId!=="string" || cmd.body.publicRequestId.length===0 ||
          cmd.body.publicRequestId.length>WIRE_LIMITS.deskRequestId || typeof cmd.body.publicRequestSha256!=="string" ||
          !/^[0-9a-f]{64}$/.test(cmd.body.publicRequestSha256)))return reject("INVALID_RECORD","cleanup intent lacks the current original public request ID/hash","preserve the exact strict public input digest separately from immutable source provenance");
      const unissuedCleanupContinuation = phase === "discharge" && action.state === "intended" && action.phase === "discharge" &&
        action.receipt === null && action.body?.cleanupStep === cleanupStep;
      if (action.state !== "observed" && action.state !== "held" && !unissuedCleanupContinuation) {
        return reject("INTEGRATION_CONFLICT", `action ${cmd.actionId} is ${action.state} — the prior phase has no committed observation`, "land only after the staged/check phases observed clean");
      }
      const existingPlan=action.recoveryPlan??null;
      let nextPlan:DeskTaskIntegrationRecoveryPlanValue|null=existingPlan;
      let nextBackupDir=action.backupDir;
      let nextResourceIds=[...(action.resourceIds??[])];
      const resourceRows=integrationResourceRows(ledger,action);
      if(phase==="land") {
        const parsedPlan=DeskTaskIntegrationRecoveryPlan.safeParse(cmd.body.recoveryPlan);
        if(!parsedPlan.success)return reject("INVALID_RECORD","LAND intent lacks a strict immutable recoveryPlan v1","pin original/combined map bytes and backup manifest before issue");
        const plan=parsedPlan.data;
        if(existingPlan!==null)return reject("RECOVERY_REQUIRED","this action already pinned a LAND recovery plan","do not overwrite an admitted backup/apply plan; reconcile or discharge it first");
        if(action.phase!=="stage" && action.phase!=="check")return reject("INTEGRATION_CONFLICT","LAND requires the current staged/check phase","observe the exact stage before admitting a first LAND intent");
        const absolute=(value:string)=>value.startsWith("/")||/^[A-Za-z]:[\\/]/.test(value);
        const hasDotSegment=(value:string)=>value.split(/[\\/]+/).some(part=>part==="."||part==="..");
        const pathParent=(value:string)=>{const i=Math.max(value.lastIndexOf("/"),value.lastIndexOf("\\"));return i<=0?"":value.slice(0,i);};
        const proofRoot=pathParent(plan.manifestPath),proofPaths=[plan.backupDir,plan.targetOriginal.path,plan.expectedCombined.path];
        const under=(value:string,root:string)=>value===root||value.startsWith(`${root}/`)||value.startsWith(`${root}\\`);
        const proofOutsideRemovable=proofPaths.slice(1).every(path=>!under(path,plan.stageDir)&&!under(path,plan.backupDir));
        if(action.stageDir===null || plan.stageDir!==action.stageDir || action.targetCwd===null || action.target===null ||
            plan.targetOriginal.head!==action.target.head || plan.expectedCombined.head!==plan.targetOriginal.head ||
            plan.expectedCombined.mapSha256!==action.expectedSha || proofRoot==="" ||
            [plan.stageDir,plan.backupDir,plan.manifestPath,plan.targetOriginal.path,plan.expectedCombined.path].some(path=>!absolute(path)||hasDotSegment(path)) ||
            proofPaths.some(path=>pathParent(path)!==proofRoot) || !proofOutsideRemovable ||
            new Set([plan.stageDir,plan.backupDir,plan.manifestPath,plan.targetOriginal.path,plan.expectedCombined.path]).size!==5) {
          return reject("EVIDENCE_INCOMPLETE","LAND recoveryPlan does not match the admitted target/stage and retained proof paths","re-measure the staged maps and derive contained immutable proof paths before issue");
        }
        if(resourceRows===null || resourceRows.length!==1 || resourceRows[0]!.resourceKey!==plan.stageDir ||
            resourceRows[0]!.disposition!=="retained" || !["worktree","scratch"].includes(resourceRows[0]!.resourceKind)) {
          return reject("EVIDENCE_INCOMPLETE","LAND has no exact retained stage resource row","retain the admitted stage until its action-bound resource is recorded");
        }
        const backupId=deriveId("rsc",[action.actionId,"integration-backup"]);
        if(nextResourceIds.includes(backupId))return reject("INVALID_RECORD","LAND backup resource identity already exists","reuse the original request receipt or reconcile the pinned resource");
        nextPlan=plan;nextBackupDir=plan.backupDir;nextResourceIds=[...nextResourceIds,backupId];
      } else if(phase==="check") {
        if(existingPlan!==null || (cmd.body.recoveryPlan!==undefined && cmd.body.recoveryPlan!==null))return reject("INVALID_RECORD","check cannot replace or pre-pin a LAND recovery plan","only the first LAND intent commits recovery provenance");
      } else {
        if (!sameRecoveryPlan(cmd.body.recoveryPlan ?? null, existingPlan)) return reject("REVISION_CONFLICT", "discharge plan differs from the immutable LAND intent", "use the exact admitted plan from LAND intent");
        if (cleanupStep === "verify-account") {
          if (action.cleanupVerification != null) return reject("INVALID_RECORD", "the immutable cleanup account is already verified", "only the recorded account and its exact resource permits may continue");
          const candidateCheck = validateCleanupCandidate(ledger, action, cmd.body.cleanupCandidate);
          if ("ok" in candidateCheck) return candidateCheck;
          const previousVerificationIntents = ledger.taskEntries.filter((row): row is DeskTaskActionEntryValue => row.kind === "action" && row.actionId === action.actionId &&
            row.actionKind === "integration" && row.phase === "discharge" && row.state === "intended" && row.body?.cleanupStep === "verify-account");
          if (previousVerificationIntents.length >= 2) return reject("CAPABILITY_GAP", "the two total cleanup verification cycles are exhausted", "retain the unverified resources and report the remaining gap");
          if (previousVerificationIntents.length === 1) {
            const priorCandidate = previousVerificationIntents[0]!.body?.cleanupCandidate;
            if (canonicalJson(priorCandidate) !== canonicalJson(candidateCheck.candidate)) return reject("REVISION_CONFLICT", "verification continuation changed the immutable candidate", "reuse the same source, target, inventory and proof-bundle pins");
            const priorObservation = action.receipt as Record<string, unknown> | null;
            const priorUnissued = action.state === "intended" && action.receipt === null;
            if (!priorUnissued && (action.state !== "held" || priorObservation?.phase !== "discharge" || priorObservation.cleanupStep !== "verify-account" || priorObservation.status !== "held")) {
              return reject("CAPABILITY_GAP", "the first verification cycle has no retained held observation to continue", "reconcile the original verification issue before using the sole continuation");
            }
          } else if (action.cleanupVerification != null) {
            return reject("INVALID_RECORD", "verified cleanup provenance cannot be replaced", "use the immutable verified account");
          }
        } else if (cleanupStep === "remove-resource") {
          const verification = DeskTaskIntegrationCleanupVerification.safeParse(action.cleanupVerification);
          if (!verification.success) return reject("EVIDENCE_INCOMPLETE", "resource removal has no committed positive cleanup account", "complete proof-only intent/issue/observation before any resource permit");
          const verificationEntry = ledger.taskEntries.filter(row => row.kind === "action" && row.actionId === action.actionId &&
            row.cleanupVerification != null).sort((a, b) => a.revision - b.revision)[0];
          if (verificationEntry === undefined) return reject("EVIDENCE_INCOMPLETE", "verified account has no immutable source entry", "retain resources and recover the exact account entry/hash");
          const verificationRef = integrationEntryRef(verificationEntry);
          const parsedPermit = DeskTaskIntegrationCleanupPermit.safeParse(cmd.body.permit);
          if (!parsedPermit.success) return reject("INVALID_RECORD", "resource cleanup intent lacks the strict Core permit", "pin the exact current resource under the verified account");
          const permit = parsedPermit.data;
          const bodyVerificationRef = DeskTaskIntegrationEntryRef.safeParse(cmd.body.verificationRef);
          if (!bodyVerificationRef.success || canonicalJson(bodyVerificationRef.data) !== canonicalJson(verificationRef))return reject("REVISION_CONFLICT","resource intent verificationRef differs from the immutable account entry","submit the exact verification entry ref returned by Core");
          if(canonicalJson(permit.verificationRef)!==canonicalJson(verificationRef))return reject("REVISION_CONFLICT","resource permit verificationRef differs from the immutable account entry","submit the exact verification entry ref returned by Core");
          if(permit.actionId!==action.actionId || permit.resourceId==="" || permit.ordinal<1 || !sameRecoveryPlan(cmd.body.recoveryPlan??null,existingPlan)) {
            return reject("REVISION_CONFLICT", "resource permit differs from the immutable action/plan refs", "submit the exact action and admitted recovery plan");
          }
          const candidate = verification.data.candidate;
          const pin = candidate.resources.find(row => row.resourceId === permit.resourceId);
          const resource = resourceRows?.find(row => row.resourceId === permit.resourceId);
          if (pin === undefined || resource === undefined || resource.disposition !== "retained" || resource.revision !== permit.expectedResourceRevision ||
              pin.resourceRevision !== resource.revision || pin.resourceKey !== resource.resourceKey || permit.resourceKey !== resource.resourceKey ||
              permit.inventoryMapSha256 !== pin.inventoryMapSha256 || permit.cleanupRecipe !== pin.cleanupRecipe) {
            return reject("REVISION_CONFLICT", "resource permit differs from the exact currently retained resource revision/key/map", "re-read the verified account and resource row");
          }
          const priorPermits = ledger.taskEntries.filter(row => row.kind === "action" && row.actionId === action.actionId && row.phase === "discharge" &&
            row.state === "intended" && row.body?.cleanupStep === "remove-resource" &&
            (row.body.permit as Record<string, unknown> | undefined)?.resourceId === permit.resourceId);
          if (priorPermits.length >= 2 || permit.ordinal !== priorPermits.length + 1) return reject("CAPABILITY_GAP", "the two total resource cycles are exhausted or the ordinal is not next", "retain the resource and use only its one funded continuation");
          if (pin.role === "backup") {
            const stage = resourceRows?.find(row => row.resourceKey === existingPlan?.stageDir);
            if (stage?.disposition !== "released") return reject("EVIDENCE_INCOMPLETE", "backup permit is forbidden before positive stage release", "complete the exact stage resource first");
          }
        } else {
          return reject("INVALID_RECORD", "discharge requires an explicit verify-account or remove-resource step", "verify the immutable account before issuing an exact resource permit");
        }
      }
      const task = latestTask(ledger, cmd.assignmentId, cmd.taskId ?? action.taskId!);
      if (task !== undefined && phase === "land") {
        const required = task.proofPolicy?.verificationRecipes.filter(recipe => recipe.required) ?? [];
        const runs = action.checkRuns ?? [];
        const missing = required.filter(recipe => !runs.some(run => run.recipeId === recipe.recipeId && run.status === "passed"));
        if (missing.length > 0) {
          return reject("INTEGRATION_CONFLICT", `required proof is missing or unrunnable for ${missing.map(recipe => recipe.recipeId).join(",")}`, "land only after every required verification recipe has a passing run");
        }
      }
      const addingBackupResource=phase==="land" && nextPlan!==null && nextResourceIds.length===(action.resourceIds?.length??0)+1;
      const headroom = entryHeadroom(ledger, 1+(addingBackupResource?1:0), false);
      if (headroom !== null) return headroom;
      const revision = nextEntry<DeskTaskActionEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, action.actionId, action, {
        ...action, kind: "action", taskId: action.taskId, actionId: action.actionId,
        state: "intended", phase, body: cmd.body, bodySha256: canonicalSha256(cmd.body), receipt: null,
        ...(phase === "discharge" ? { cleanupIssueEvidence: null } : {}),
        recoveryPlan:nextPlan, backupDir:nextBackupDir, resourceIds:nextResourceIds,
      });
      if (!fitsEntry(revision)) return reject("REQUEST_TOO_LARGE", `action revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the intent body before committing again");
      const rows:TaskEntry[]=[revision];
      if(addingBackupResource && nextPlan!==null) {
        const id=nextResourceIds.at(-1)!;
        const resource=nextEntry<DeskTaskResourceEntryValue>(actor,ledger,cmd.assignmentId,cmd.requestId,id,null,{kind:"resource",taskId:action.taskId,
          resourceId:id,resourceKind:"scratch",resourceKey:nextPlan.backupDir,ownerAgentId:actor.agentId as string,ownerMembershipId:actor.membershipId,
          attemptId:null,actionId:action.actionId,disposition:"retained",observedState:"admitted-before-land",observedVia:"receipt",
          obligations:[{kind:"remove",ref:nextPlan.backupDir}],releaseRuling:null});
        if(!fitsEntry(resource))return reject("REQUEST_TOO_LARGE",`LAND backup resource exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`,`retain the plan and shrink its path`);
        rows.push(resource);
      }
      return decided(rows.map(entryEvent), [...ledger.taskEntries, ...rows]);
    }
    const attemptId = cmd.attemptId;
    if (attemptId === null) {
      return reject("INVALID_RECORD", "a new effect intent names its attempt", "supply attemptId for a fresh action intent");
    }
    const attempt = latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, attemptId);
    if (attempt === undefined || attempt.kind !== "attempt") {
      return reject("ACTOR_MISMATCH", `unknown attempt ${attemptId}`, "effects bind to committed attempts only");
    }
    if (cmd.actionKind === "send" || cmd.actionKind === "archive") {
      const controlGate = phaseControlGate(ledger, attempt, cmd.body.controlPins); if (controlGate !== null) return controlGate;
    }
    const gate = attemptEffectGate(ledger, attempt, cmd.actionKind);
    if (gate !== null) return gate;
    if (cmd.actionKind === "integration") {
      return reject("INVALID_RECORD", "integration actions commit through integration-admit", "use the admission path so landability checks run");
    }
    if (cmd.actionKind === "create" && attempt.placement.cwd === null) {
      return reject("INVALID_RECORD", `attempt ${attemptId} has no observed placement`, "materialize and observe the placement before create");
    }
    if (cmd.actionKind === "send" && attempt.member === null) {
      return reject("ACTOR_MISMATCH", `attempt ${attemptId} has no bound membership`, "bind the observed seat before any writable send");
    }
    if (cmd.actionKind === "send" && attempt.state !== "bound" && attempt.state !== "dispatched" && attempt.state !== "running") {
      return reject("INVALID_RECORD", `attempt ${attemptId} is ${attempt.state} — not writable`, "bind the seat before sending");
    }
    if (cmd.actionKind === "create" && Object.hasOwn(cmd.body, "createTicketSha256")) {
      if (typeof cmd.body.createTicketSha256 !== "string" || !/^[0-9a-f]{64}$/.test(cmd.body.createTicketSha256) ||
          typeof cmd.body.publicRequestId !== "string" || cmd.body.publicRequestId.length === 0 ||
          cmd.body.publicRequestId.length > WIRE_LIMITS.deskRequestId || typeof cmd.body.publicRequestSha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(cmd.body.publicRequestSha256)) {
        return reject("INVALID_RECORD", "ticketed create intent lacks strict original public request pins", "persist only the server-derived publicRequestId and canonical input SHA-256");
      }
    }
    const task = latestTask(ledger, cmd.assignmentId, attempt.taskId)!;
    const operationGrant = cmd.actionKind === "create" ? task.grants.create : cmd.actionKind === "send" ? task.grants.send : cmd.actionKind === "archive" ? task.grants.archive : null;
    if (operationGrant === null || cmd.body.grantRef !== operationGrant) return reject("AUTHORITY_REQUIRED", "effect lacks its distinct current operation grant", "create, send and archive retain separate task grants");
    const capacity = actionCapacityGate(ledger, attempt);
    if (capacity !== null) return capacity;
    const headroom = entryHeadroom(ledger, 2, false);
    if (headroom !== null) return headroom;
    const ordinal = latestActions(ledger, { attemptId }).length + 1;
    const actionId = deriveId("act", [attemptId, cmd.actionKind, String(ordinal)]);
    const body = cmd.body as Record<string, unknown>;
    const rows: TaskEntry[] = [];
    const action = nextEntry<DeskTaskActionEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, actionId, null, {
      kind: "action", taskId: attempt.taskId, actionId, attemptId,
      resultId: cmd.resultId ?? null,
      actionKind: cmd.actionKind, ordinal, phase: null,
      body, bodySha256: canonicalSha256(body),
      state: "intended", callerAgentId: actor.agentId as string, parentAgentId: null, reportTo: null,
      receipt: null, grant: null, verification: null,
      sourceBase: null, sourceResult: null, target: null,
      sourceBaseSha: null, sourceResultSha: null, targetBaseSha: null,
      targetCwd: null, sourceCwd: null, stageKind: null, stageDir: null,
      stagedSha: null, expectedStageSha: null, expectedSha: null, backupDir: null,
      checkRuns: null, conflicts: null, changedPaths: null, deltaDigest: null,
      scopeWriter: null, qualificationDigest: null, proofPolicyDigest: null,
      requiredChecks: null, commitGrantRef: null, stageBase: null, prepared: null,
      landIntent: null, recoveryPlan: null, cleanupVerification: null, cleanupIssueEvidence: null,
      landed: null, uncertainties: null, resourceIds: null,
    });
    rows.push(action);
    if (cmd.actionKind === "send") {
      rows.push(newDelivery(actor, ledger, cmd.requestId, attempt.taskId, cmd.assignmentId, attempt.member!,
        attempt.predecessor === null ? "dispatch" : "rework", attempt.attemptId, actionId, null,
        typeof body.textSha256 === "string" ? body.textSha256 : action.bodySha256));
      const dispatched = nextEntry<DeskTaskAttemptEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, attemptId, attempt, {
        ...attempt, kind: "attempt", taskId: attempt.taskId, attemptId, state: "dispatched",
      });
      rows.push(dispatched);
    }
    for (const row of rows) {
      if (!fitsEntry(row)) return reject("REQUEST_TOO_LARGE", `revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the intent body before committing again");
    }
    return decided(rows.map(entryEvent), [...ledger.taskEntries, ...rows]);
  }

  if (cmd.kind === "task.effect.issue") {
    const ownerGate = ownerRequired();
    if (ownerGate !== null) return ownerGate;
    const action = latestTaskEntity<DeskTaskActionEntryValue>(ledger, cmd.actionId);
    if (action === undefined || action.kind !== "action") {
      return reject("ACTOR_MISMATCH", `unknown action ${cmd.actionId}`, "issue only a committed action intent");
    }
    if (cmd.actionKind !== null && cmd.actionKind !== undefined && action.actionKind !== cmd.actionKind) {
      return reject("INVALID_RECORD", `action ${cmd.actionId} is ${action.actionKind}, not ${cmd.actionKind}`, "the issue kind must match the intent's kind");
    }
    if (action.state !== "intended") {
      return reject("EFFECT_INADMISSIBLE", `action ${cmd.actionId} is ${action.state} — only an intended action issues`, "a committed issue is replayed by its requestId, not re-issued");
    }
    const admission = ledger.requests.find(row => row.assignmentId === action.assignmentId && row.actorKey === `agent:${action.actorAgentId}` && row.requestId === action.requestId);
    if (admission?.outcome !== "committed" || admission.revision !== ledger.revision) return reject("EFFECT_INADMISSIBLE", "unrelated ledger drift after the admitted intent", "reconcile the unissued intent instead of replacing its original pins");
    if (action.actionKind === "integration") {
      const qualification = currentTaskResultQualification(ledger, cmd.assignmentId, action.taskId);
      if (!qualification.qualified || qualification.resultId !== action.resultId ||
          action.proofPolicyDigest !== (latestTask(ledger, cmd.assignmentId, action.taskId)?.proofPolicy === null ? null : canonicalSha256(latestTask(ledger, cmd.assignmentId, action.taskId)!.proofPolicy))) {
        return reject("EFFECT_INADMISSIBLE", "integration qualification drifted after admission", "reconcile against a current explicitly ruled candidate");
      }
    }
    const attempt = action.attemptId !== null ? latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, action.attemptId) : undefined;
    if (attempt !== undefined && attempt.kind === "attempt") {
      const gate = attemptEffectGate(ledger, attempt, action.actionKind);
      if (gate !== null && action.actionKind !== "archive") {
        return reject("EFFECT_INADMISSIBLE", gate.message, gate.recovery);
      }
    }
    if (action.briefRevision !== briefRevisionOf(ledger, cmd.assignmentId) || action.ownershipRevision !== ownershipRevisionOf(ledger, cmd.assignmentId)) {
      return reject("EFFECT_INADMISSIBLE", "intent has stale owner or brief pins", "reconcile the retained old intent; do not continue it under new authority");
    }
    if (attempt !== undefined) {
      const observationGate = validateDependencyObservation(ledger, attempt.consumedDependencies,
        { kind: attempt.placement.kind, ...(attempt.placement.cwd === null ? {} : { cwd: attempt.placement.cwd }),
          ...(attempt.placement.baseRef === null ? {} : { baseRef: attempt.placement.baseRef }),
          ...(attempt.placement.workspaceId === null ? {} : { workspaceId: attempt.placement.workspaceId }) }, cmd.dependencyObservation ?? null);
      if (observationGate !== null) return observationGate;
    }
    let cleanupIssueEvidence:DeskTaskIntegrationCleanupPreflightEvidenceValue|null=null;
    if(action.actionKind==="integration" && action.phase==="discharge" && action.body?.cleanupStep==="remove-resource") {
      if(cmd.cleanupIssueEvidence===undefined)return reject("EVIDENCE_INCOMPLETE","resource ISSUE has no read-only prior-permit survivor preflight","observe the exact verified account/source/target/resource set before authorizing removal");
      const checked=validateCleanupPreflightEvidence(ledger,action,cmd.cleanupIssueEvidence);
      if("ok" in checked)return checked;
      cleanupIssueEvidence=checked;
    } else if(cmd.cleanupIssueEvidence!==undefined) {
      return reject("INVALID_RECORD","cleanup preflight evidence is attached to a non-resource cleanup issue","reuse only the exact resource-preflight issue path");
    }
    const headroom = entryHeadroom(ledger, 1, false);
    if (headroom !== null) return headroom;
    const issued = nextEntry<DeskTaskActionEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, action.actionId, action, {
      ...action, kind: "action", taskId: action.taskId, actionId: action.actionId,
      state: "issued",
      ...(cleanupIssueEvidence===null?{}:{cleanupIssueEvidence}),
    });
    if (!fitsEntry(issued)) return reject("REQUEST_TOO_LARGE", `action revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the action before issuing again");
    return decided([entryEvent(issued)], [...ledger.taskEntries, issued]);
  }

  if (cmd.kind === "task.effect.bind") {
    const ownerGate = ownerRequired();
    if (ownerGate !== null) return ownerGate;
    const attempt = latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, cmd.attemptId);
    if (attempt === undefined || attempt.kind !== "attempt") {
      return reject("ACTOR_MISMATCH", `unknown attempt ${cmd.attemptId}`, "bind only a committed attempt");
    }
    const bindGate=attemptEffectGate(ledger,attempt,"bind");if(bindGate!==null)return bindGate;
    if (attempt.state !== "reserved") {
      return reject("INVALID_RECORD", `attempt ${cmd.attemptId} is ${attempt.state} — only a reserved attempt binds`, "a bound or terminal attempt never rebinds");
    }
    if (attempt.member !== null) {
      return reject("INVALID_RECORD", `attempt ${cmd.attemptId} already has a bound member`, "the bound member tuple is immutable once recorded");
    }
    const membership = ledger.memberships.find(row => row.membershipId === cmd.member.membershipId);
    if (membership === undefined || membership.agentId !== cmd.member.agentId ||
        membership.state !== "host-confirmed" || membership.registeredAt === null || membership.revokedAt !== null) {
      return reject("ACTOR_MISMATCH", `membership ${cmd.member.membershipId} is not the live registered row for ${cmd.member.agentId}`, "binds require the exact registered membership — no claim substitutes");
    }
    if(attempt.reuseTarget===null && (attempt.host.agentId===null || !latestActions(ledger,{attemptId:attempt.attemptId}).some(row=>row.actionKind==="create" && row.state==="observed")))return reject("EVIDENCE_INCOMPLETE","new seat has no positively observed create identity","bind only the exact created seat after its durable positive receipt");
    if (attempt.host.agentId !== null && attempt.host.agentId !== cmd.member.agentId) {
      return reject("ACTOR_MISMATCH", `bound candidate ${cmd.member.agentId} does not match the observed host seat ${attempt.host.agentId}`, "the bound membership must be the created seat's own registration");
    }
    if (cmd.observed.provider !== attempt.seatPin.provider) {
      return reject("ROUTE_DRIFT", `observed provider ${cmd.observed.provider} differs from the pinned ${attempt.seatPin.provider}`, "a seat that resolves differently than its routing pin must not bind");
    }
    if (membership.provider !== cmd.observed.provider || membership.createCwd !== attempt.placement.cwd ||
        cmd.observed.createCwd !== attempt.placement.cwd ||
        membership.workspaceId !== attempt.placement.workspaceId || cmd.observed.workspaceId !== attempt.placement.workspaceId) {
      return reject("ROUTE_DRIFT", "registered and observed placement/provider tuple differs from the attempt pin", "bind the exact observed registered seat; no rebinding of placement is permitted");
    }
    const attach = decideDeskHandback(ledger, {
      kind: "assignment.attach", requestId: cmd.requestId, actorAgentId: cmd.actorAgentId,
      assignmentId: cmd.assignmentId, agentId: cmd.member.agentId,
    });
    if (!attach.ok) return attach;
    const attachedLedger = { ...ledger, assignments: attach.assignments ?? ledger.assignments };
    const attached = attachedLedger.assignments.find(a => a.assignmentId === cmd.assignmentId)!;
    if (!attached.seats.some(seat => seat.agentId === membership.agentId && seat.membershipId === membership.membershipId)) {
      return reject("ACTOR_MISMATCH", "assignment attachment names a different membership", "stale attachments cannot authorize a rebound worker");
    }
    if(taskEntriesOf(ledger,"attempt").some(row=>row.kind==="attempt" && row.attemptId!==attempt.attemptId &&
      latestTaskEntity<DeskTaskAttemptEntryValue>(ledger,row.attemptId)?.entryId===row.entryId &&
      !["settled","stopped"].includes(row.state) && row.member?.membershipId===membership.membershipId)) {
      return reject("SCOPE_CONFLICT","the registered worker is already reserved by another unsettled attempt","retain one work delivery per active seat until its obligations settle");
    }
    // Atomic attach + scope compose — when the task carries a scope
    // template, the bound seat's scope is declared and claimed inside THIS
    // commit by the shared scope decide itself: identical gates, identical
    // rows, and the attempt's boundScope pin lands in the same transaction
    // or not at all.
    const task = latestTask(ledger, cmd.assignmentId, attempt.taskId!);
    let scopeEvents: { kind: string; payload: Record<string, unknown> }[] = [];
    let scopeTables: { scopes?: ScopeValue[]; scopeTransitions?: ScopeTransitionValue[] } = {};
    let boundScope: { scopeId: string; scopeRevision: number } | null = null;
    if (task !== undefined && task.scope !== null) {
      const scopeId = deriveId("scp", [attempt.attemptId, "scope"]);
      const briefRevision = currentBriefRevision(ledger, cmd.assignmentId);
      const declared = decideDeskScope(attachedLedger, {
        kind: "scope.declare", requestId: cmd.requestId, actorAgentId: cmd.actorAgentId,
        assignmentId: cmd.assignmentId, scopeId,
        label: task.scope.label, declarationSha256: sha256Hex(canonicalJson(task.scope)),
        refs: task.scope.refs, seatAgentId: cmd.member.agentId,
        expectedBriefRevision: briefRevision,
        ownership: task.scope.ownership === null ? null : { ...task.scope.ownership, writerAgentId: cmd.member.agentId }, reviewPlan: task.scope.reviewPlan, reviewPlanInput: "explicit",
      });
      if (declared.ok !== true) return declared;
      const withScope = { ...attachedLedger, scopes: declared.scopes ?? ledger.scopes, scopeTransitions: declared.scopeTransitions ?? ledger.scopeTransitions };
      const claimed = decideDeskScope(withScope, {
        kind: "scope.transition", requestId: cmd.requestId, actorAgentId: cmd.actorAgentId,
        assignmentId: cmd.assignmentId, scopeId, transition: "claim", scopeRevision: 1,
        candidateSnapshot: null, candidateHead: null, briefRevision,
      });
      if (claimed.ok !== true) return claimed;
      scopeEvents = [...declared.events, ...claimed.events];
      scopeTables = { scopes: claimed.scopes ?? declared.scopes, scopeTransitions: claimed.scopeTransitions ?? declared.scopeTransitions };
      boundScope = { scopeId, scopeRevision: 1 };
    }
    const headroom = entryHeadroom(ledger, 4, false);
    if (headroom !== null) return headroom;
    const placement = {
      ...attempt.placement,
      cwd: cmd.observed.createCwd ?? attempt.placement.cwd,
      workspaceId: cmd.observed.workspaceId ?? attempt.placement.workspaceId,
    };
    const bound = nextEntry<DeskTaskAttemptEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, attempt.attemptId, attempt, {
      ...attempt, kind: "attempt", taskId: attempt.taskId, attemptId: attempt.attemptId,
      state: "bound", member: { agentId: cmd.member.agentId, membershipId: cmd.member.membershipId },
      host: { agentId: cmd.member.agentId }, placement,
      ...(boundScope !== null ? { boundScopeId: boundScope.scopeId, boundScopeRevision: boundScope.scopeRevision } : {}),
    });
    const rows: TaskEntry[] = [bound];
    const agentResource = nextEntry<DeskTaskResourceEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId,
      deriveId("rsc", [attempt.attemptId, "agent"]), null, {
        kind: "resource", taskId: attempt.taskId,
        resourceId: deriveId("rsc", [attempt.attemptId, "agent"]),
        resourceKind: "agent", resourceKey: cmd.member.agentId,
        ownerAgentId: actor.agentId as string, ownerMembershipId: actor.membershipId,
        attemptId: attempt.attemptId, actionId: null,
        disposition: "retained", observedState: "bound", observedVia: "receipt",
        obligations: [{ kind: "archive", ref: cmd.member.agentId }],
        releaseRuling: null,
      });
    rows.push(agentResource);
    const memberResource = nextEntry<DeskTaskResourceEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId,
      deriveId("rsc", [attempt.attemptId, "membership"]), null, {
        kind: "resource", taskId: attempt.taskId,
        resourceId: deriveId("rsc", [attempt.attemptId, "membership"]),
        resourceKind: "membership", resourceKey: cmd.member.membershipId,
        ownerAgentId: actor.agentId as string, ownerMembershipId: actor.membershipId,
        attemptId: attempt.attemptId, actionId: null,
        disposition: "retained", observedState: "host-confirmed", observedVia: "receipt",
        obligations: [{ kind: "revoke-or-release", ref: cmd.member.membershipId }],
        releaseRuling: null,
      });
    rows.push(memberResource);
    if (attempt.placement.kind === "isolated" && placement.cwd !== null && latestTaskEntity(ledger, deriveId("rsc", [attempt.attemptId, "worktree"])) === undefined) {
      const worktreeResource = nextEntry<DeskTaskResourceEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId,
        deriveId("rsc", [attempt.attemptId, "worktree"]), null, {
          kind: "resource", taskId: attempt.taskId,
          resourceId: deriveId("rsc", [attempt.attemptId, "worktree"]),
          resourceKind: "worktree", resourceKey: placement.cwd,
          ownerAgentId: actor.agentId as string, ownerMembershipId: actor.membershipId,
          attemptId: attempt.attemptId, actionId: null,
          disposition: "retained", observedState: "materialized", observedVia: "receipt",
          obligations: [{ kind: "remove", ref: placement.cwd }],
          releaseRuling: null,
        });
      rows.push(worktreeResource);
    }
    for (const row of rows) {
      if (!fitsEntry(row)) return reject("REQUEST_TOO_LARGE", `bind revisions exceed the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the bind evidence before committing again");
    }
    return { ...decided([...attach.events, ...scopeEvents, ...rows.map(entryEvent)], [...ledger.taskEntries, ...rows]), assignments: attachedLedger.assignments, ...scopeTables };
  }

  if (cmd.kind === "task.effect.integration-admit") {
    const ownerGate = ownerRequired();
    if (ownerGate !== null) return ownerGate;
    const task = latestTask(ledger, cmd.assignmentId, cmd.taskId);
    if (task === undefined) return reject("INVALID_RECORD", `task ${cmd.taskId} is not declared`, "integrations name a declared task");
    if(task.grants.integrate===null || cmd.grant.authorityRef!==task.grants.integrate)return reject("AUTHORITY_REQUIRED","integration grant differs from the current explicit task grant","integrate/commit/push/cleanup grants remain separate");
    const targetCwd=cmd.grant.target?.cwd;
    if(targetCwd===undefined)return reject("INVALID_RECORD","integration requires exact target cwd","pin the actual declared integration resource");
    if(latestActions(ledger,{}).some(row=>row.actionKind==="integration" && row.targetCwd===targetCwd && integrationTargetReserved(ledger,row)))return reject("SCOPE_CONFLICT","integration target is reserved by retained stage/backup or landing obligations","serialize integration until every admitted resource has a positive discharge receipt");
    const qualification = currentTaskResultQualification(ledger, cmd.assignmentId, cmd.taskId);
    if (!qualification.qualified || qualification.resultId !== cmd.resultId) {
      return reject("INTEGRATION_CONFLICT", `task ${cmd.taskId} has no landable result (${qualification.reasons.join(",") || "result-unruled"})`, "landability needs a current accepted ruling plus scope qualification and an explicit grant");
    }
    const result = latestTaskEntity<DeskTaskResultEntryValue>(ledger, cmd.resultId);
    if (result === undefined || result.kind !== "result") {
      return reject("INVALID_RECORD", `unknown result ${cmd.resultId}`, "integrations name the pinned result");
    }
    if (cmd.expectedResultRevision !== undefined && cmd.expectedResultRevision !== result.revision) {
      return reject("REVISION_CONFLICT", `expected result revision ${cmd.expectedResultRevision} but the current revision is ${result.revision}`, "re-read the result before admitting the integration");
    }
    const ruling = latestAdjudicationForResult(ledger, result.resultId);
    if (ruling !== undefined && cmd.expectedAdjudicationRevision !== undefined &&
        cmd.expectedAdjudicationRevision !== ruling.revision) {
      return reject("REVISION_CONFLICT", `expected adjudication revision ${cmd.expectedAdjudicationRevision} but the current revision is ${ruling.revision}`, "re-read the ruling before admitting the integration");
    }
    const headroom = entryHeadroom(ledger, 1, false);
    if (headroom !== null) return headroom;
    const attempt = latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, result.attemptId);
    const body = cmd.body as Record<string, unknown>;
    const sourceBase = measurePinOf(body.sourceBase) ?? (attempt?.kind === "attempt" ? attempt.sourceBase : null);
    const sourceResult = measurePinOf(body.sourceResult) ??
      (result.candidate !== null
        ? { snapshotSha256: result.candidate.snapshotSha256, head: result.candidate.head, root: "", kind: "git-snapshot" as const, measuredAt: "1970-01-01T00:00:00.000Z", incomplete: [], artifactSha256: null }
        : { snapshotSha256: result.snapshotSha256, head: null, root: "", kind: "git-snapshot" as const, measuredAt: "1970-01-01T00:00:00.000Z", incomplete: [], artifactSha256: null });
    const target = measurePinOf(body.target);
    if(sourceBase===null || sourceResult===null || target===null || sourceBase.incomplete.length>0 || sourceResult.incomplete.length>0 || target.incomplete.length>0 ||
        sourceResult.snapshotSha256!==result.snapshotSha256 || target.root!==targetCwd || sourceResult.root!==body.sourceCwd) return reject("EVIDENCE_INCOMPLETE","integration admission lacks exact measured source/base/target pins","measure the original source and consumer before staging");
    const actionId = deriveId("act", [cmd.taskId, "integration", cmd.requestId]);
    const integrationCount = latestActions(ledger, { taskId: cmd.taskId }).filter(row => row.actionKind === "integration").length;
    const action = nextEntry<DeskTaskActionEntryValue>(actor, ledger, cmd.assignmentId, cmd.requestId, actionId, null, {
      kind: "action", taskId: cmd.taskId, actionId,
      attemptId: null, resultId: cmd.resultId,
      actionKind: "integration", ordinal: integrationCount + 1, phase: "stage",
      body, bodySha256: canonicalSha256(body),
      // Admission IS the issue — the stage effect is admitted atomically so
      // its observe lands on the issued row; check/land/discharge phases
      // re-drive intent/issue/observe on this same actionId.
      state: "issued", callerAgentId: actor.agentId as string, parentAgentId: null, reportTo: null,
      receipt: null,
      grant: {
        authorityRef: cmd.grant.authorityRef,
        paths: cmd.grant.paths,
        target: cmd.grant.target ?? null,
      },
      verification: cmd.verification ?? null,
      sourceBase, sourceResult, target,
      sourceBaseSha: sourceBase?.snapshotSha256 ?? (typeof body.sourceBaseSha === "string" ? body.sourceBaseSha : null),
      sourceResultSha: sourceResult?.snapshotSha256 ?? (typeof body.sourceResultSha === "string" ? body.sourceResultSha : null),
      targetBaseSha: target?.snapshotSha256 ?? (typeof body.targetBaseSha === "string" ? body.targetBaseSha : null),
      targetCwd: cmd.grant.target?.cwd ?? (typeof body.targetCwd === "string" ? body.targetCwd : null),
      sourceCwd: typeof body.sourceCwd === "string" ? body.sourceCwd : (attempt?.kind === "attempt" ? attempt.placement.cwd : null),
      stageKind: body.stageKind === "git-worktree" || body.stageKind === "content-dir" ? body.stageKind : null,
      stageDir: null, stagedSha: null, expectedStageSha: null, expectedSha: null, backupDir: null,
      checkRuns: null,
      conflicts: Array.isArray(body.conflicts) ? (body.conflicts as { path: string; reason: string }[]) : null,
      changedPaths: Array.isArray(body.changedPaths) ? (body.changedPaths as string[]) : null,
      deltaDigest: typeof body.deltaDigest === "string" ? body.deltaDigest : null,
      scopeWriter: result.scopeId===null || result.scopeRevision===null ? null : {scopeId:result.scopeId,scopeRevision:result.scopeRevision,writerAgentId:attempt?.kind==="attempt" ? attempt.member?.agentId??actor.agentId! : actor.agentId!}, qualificationDigest: canonicalSha256(qualification),
      proofPolicyDigest: task.proofPolicy !== null ? canonicalSha256(task.proofPolicy) : null,
      requiredChecks: task.proofPolicy?.requiredChecks ?? null,
      commitGrantRef: null, stageBase: null, prepared: null, landIntent: null, recoveryPlan: null,
      cleanupVerification: null, cleanupIssueEvidence: null, landed: null,
      uncertainties: null, resourceIds: null,
    });
    if (!fitsEntry(action)) return reject("REQUEST_TOO_LARGE", `integration revision exceeds the ${WIRE_LIMITS.deskTaskEntryBytes}-byte entry bound`, "shrink the integration body before admitting again");
    return decided([entryEvent(action)], [...ledger.taskEntries, action]);
  }

  return reject("INVALID_RECORD", `unknown task command kind`, "task commands are a closed discriminated union");
}

// ---------------------------------------------------------------------------
// Runners — fresh read, command build, single locked transact, fresh
// post-commit read for the response row.
// ---------------------------------------------------------------------------

/** Optional command fields a caller did not send must not reach the
 *  canonical envelope — canonical JSON rejects `undefined`. */
/** Replay fidelity — a replayed request returns the rows its own commit
 *  stamped (requestId + actor tuple), never today's stream-latest row. */
const requestRows = (
  ledger: Readonly<LedgerValue>,
  requestId: string,
  actorAgentId: string,
  assignmentId: string,
  kind?: TaskEntry["kind"],
): TaskEntry[] =>
  ledger.taskEntries.filter(row =>
    row.requestId === requestId && row.actorAgentId === actorAgentId &&
    row.assignmentId === assignmentId && (kind === undefined || row.kind === kind));

const requestRow = <T extends TaskEntry>(
  ledger: Readonly<LedgerValue>,
  requestId: string,
  actorAgentId: string,
  assignmentId: string,
  kind: TaskEntry["kind"],
  entityId?: string,
): T | undefined =>
  requestRows(ledger, requestId, actorAgentId, assignmentId, kind)
    .filter(row => entityId === undefined || row.entityId === entityId)
    .at(-1) as T | undefined;

const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, field]) => field !== undefined)
        .map(([key, field]) => [key, stripUndefined(field)]),
    );
  }
  return value;
};

const envelopeFor = (ledger: Readonly<LedgerValue>, ctx: RunnerCtx, assignmentId: string, requestId: string, command: Record<string, unknown>) => ({
  repo: repoEnvelope(ledger),
  actorKey: `agent:${ctx.row.agentId}`,
  assignmentId,
  requestId,
  command: stripUndefined({ ...command, actorMembershipId: ctx.row.membershipId, actorOpenGeneration: ctx.row.openGeneration }) as Record<string, unknown>,
});

export async function runTaskCommand(
  ctx: RunnerCtx,
  wireInput: DeskTaskCommandInputValue | Record<string, unknown>,
  deps: TaskRunnerDeps,
): Promise<DeskTaskCommandResultValue | DeskRejectionValue> {
  const parsed = DeskTaskCommandInput.safeParse(wireInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, code: "INVALID_RECORD", message: `task command failed wire validation${issue !== undefined ? `: ${issue.path.join(".")} ${issue.message}` : ""}`, recovery: "send a member of the DeskTaskCommandInput union" };
  }
  const input = parsed.data;
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const actorAgentId = ctx.row.agentId as string;

  if (input.operation === "amend" || input.operation === "reopen" || input.operation === "abandon") {
    const command = { kind: "task.update", actorAgentId, assignmentId: input.assignmentId, requestId: input.requestId,
      operation: input.operation, taskId: input.taskId, expectedTaskRevision: input.expectedTaskRevision,
      ...("expectedBriefRevision" in input ? { expectedBriefRevision: input.expectedBriefRevision } : {}),
      task: input.operation === "amend" ? input.task : null, reason: input.operation === "amend" ? null : input.reason };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, input.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    return { ok: true, receiptId: settled.receipt.receiptId, taskId: input.taskId, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed };
  }

  if (input.operation === "define") {
    const command = {
      kind: "task.define", actorAgentId, assignmentId: input.assignmentId, requestId: input.requestId,
      taskId: input.taskId, expectedLedgerRevision: input.expectedLedgerRevision,
      expectedBriefRevision: input.expectedBriefRevision, expectedOwnershipRevision: input.expectedOwnershipRevision,
      expectedTaskRevision: input.expectedTaskRevision, task: input.task,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, input.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    const taskId = input.taskId ?? deriveId("tsk", [ctx.row.membershipId, input.requestId]);
    const row = requestRow<DeskTaskDeclarationEntryValue>(after,input.requestId,actorAgentId,input.assignmentId,"task",taskId);
    if (row === undefined) return { ok: false, code: "CAPABILITY_GAP", message: "the define committed but its task row is not readable", recovery: "retry the same requestId — the replay rebuilds the response" };
    return { ok: true, receiptId: settled.receipt.receiptId, taskId: row.taskId, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed };
  }

  if (input.operation === "reserve") {
    const prior = ledger.requests.find(row => row.actorKey === `agent:${actorAgentId}` && row.assignmentId === input.assignmentId && row.requestId === input.requestId);
    if (prior !== undefined) {
      const live = ledger.memberships.find(row => row.membershipId === ctx.row.membershipId && row.agentId === actorAgentId &&
        row.openGeneration === ctx.row.openGeneration && row.state !== "revoked" && row.registeredAt !== null);
      if (live === undefined) {
        return reject("AUTHORITY_REQUIRED", "the original reserve caller's exact membership tuple is no longer live", "a revoked, unregistered, or rebound membership may not replay a task reservation");
      }
    }
    const candidate = latestTask(ledger, input.assignmentId, input.taskId);
    const pins = candidate?.dependencies.flatMap(dep => { const resolved = resolveDependencyPin(ledger, dep); return "pin" in resolved ? [resolved.pin] : []; }) ?? [];
    const observation = prior === undefined ? await measureDependencies(ledger, pins, input.placement, deps) : null;
    if (observation !== null && "ok" in observation) return observation;
    const command = {
      kind: "task.reserve", actorAgentId, assignmentId: input.assignmentId, requestId: input.requestId,
      taskId: input.taskId, grantRef: input.grantRef,
      expectedLedgerRevision: input.expectedLedgerRevision, expectedBriefRevision: input.expectedBriefRevision,
      expectedOwnershipRevision: input.expectedOwnershipRevision, expectedTaskRevision: input.expectedTaskRevision,
      placement: input.placement, runtime: input.runtime, seatPin: input.seatPin,
      reuseTarget: input.reuseTarget, effectBudget: input.effectBudget, predecessor: input.predecessor,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, input.assignmentId, input.requestId, command), (locked, stable) => decideDeskTask(locked, { ...stable, dependencyObservation: observation }));
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    const attempt = requestRow<DeskTaskAttemptEntryValue>(after, input.requestId, actorAgentId, input.assignmentId, "attempt");
    const place = requestRow<DeskTaskActionEntryValue>(after, input.requestId, actorAgentId, input.assignmentId, "action");
    if (attempt === undefined) return { ok: false, code: "CAPABILITY_GAP", message: "the reserve committed but its attempt row is not readable", recovery: "retry the same requestId — the replay rebuilds the response" };
    return {
      ok: true, receiptId: settled.receipt.receiptId, taskId: input.taskId,
      attemptId: attempt.attemptId, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed,
      ...(place !== undefined ? { next: { operation: "issue", actionId: place.actionId } } : {}),
    };
  }

  if (input.operation === "result") {
    const command = {
      kind: "task.result", actorAgentId, assignmentId: input.assignmentId, requestId: input.requestId,
      taskId: input.taskId, attemptId: input.attemptId, expectedTaskRevision: input.expectedTaskRevision,
      expectedLedgerRevision: input.expectedLedgerRevision, expectedBriefRevision: input.expectedBriefRevision,
      expectedOwnershipRevision: input.expectedOwnershipRevision, result: input.result,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, input.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    const result = requestRow<DeskTaskResultEntryValue>(after, input.requestId, actorAgentId, input.assignmentId, "result");
    return { ok: true, receiptId: settled.receipt.receiptId, taskId: input.taskId, attemptId: input.attemptId, actionId: null, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed, resultId: result?.resultId ?? null };
  }

  if (input.operation === "rule") {
    const command = {
      kind: "task.rule", actorAgentId, assignmentId: input.assignmentId, requestId: input.requestId,
      taskId: input.taskId, expectedTaskRevision: input.expectedTaskRevision,
      expectedLedgerRevision: input.expectedLedgerRevision, expectedBriefRevision: input.expectedBriefRevision,
      expectedOwnershipRevision: input.expectedOwnershipRevision, adjudication: input.adjudication,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, input.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    const ruling = requestRow<DeskTaskAdjudicationEntryValue>(after, input.requestId, actorAgentId, input.assignmentId, "adjudication")
;
    return { ok: true, receiptId: settled.receipt.receiptId, taskId: input.taskId, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed, adjudicationId: ruling?.adjudicationId ?? null };
  }

  if (input.operation === "hold") {
    const command = {
      kind: "task.hold", actorAgentId, assignmentId: input.assignmentId, requestId: input.requestId,
      taskId: input.taskId, attemptId: input.attemptId, holdId: input.holdId,
      expectedLedgerRevision: input.expectedLedgerRevision, expectedBriefRevision: input.expectedBriefRevision,
      expectedOwnershipRevision: input.expectedOwnershipRevision, expectedTaskRevision: input.expectedTaskRevision,
      hold: input.hold, ruling: input.ruling,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, input.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    const hold = requestRow<DeskTaskHoldEntryValue>(after, input.requestId, actorAgentId, input.assignmentId, "hold")
;
    return { ok: true, receiptId: settled.receipt.receiptId, taskId: input.taskId, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed, holdId: hold?.holdId ?? null, state: hold?.state ?? null };
  }

  if (input.operation === "stop") {
    const command = {
      kind: "task.stop", actorAgentId, assignmentId: input.assignmentId, requestId: input.requestId,
      taskId: input.taskId, attemptId: input.attemptId,
      expectedLedgerRevision: input.expectedLedgerRevision, expectedBriefRevision: input.expectedBriefRevision,
      expectedOwnershipRevision: input.expectedOwnershipRevision, expectedTaskRevision: input.expectedTaskRevision,
      reason: input.reason,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, input.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    return {
      ok: true, receiptId: settled.receipt.receiptId, taskId: input.taskId,
      ...(input.attemptId !== null ? { attemptId: input.attemptId } : {}),
      ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed,
    };
  }

  if (input.operation === "acknowledge") {
    const command = {
      kind: "task.acknowledge", actorAgentId, assignmentId: input.assignmentId, requestId: input.requestId,
      deliveryId: input.deliveryId,
      expectedLedgerRevision: input.expectedLedgerRevision, expectedBriefRevision: input.expectedBriefRevision,
      expectedOwnershipRevision: input.expectedOwnershipRevision,
      acknowledgment: input.acknowledgment, reason: input.reason,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, input.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    const delivery = requestRow<DeskTaskDeliveryEntryValue>(after, input.requestId, actorAgentId, input.assignmentId, "delivery")
;
    return { ok: true, receiptId: settled.receipt.receiptId, taskId: delivery?.taskId ?? null, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed, state: delivery?.state ?? null };
  }

  if (input.operation === "reconcile") {
    const actor=ledger.memberships.find(row=>row.membershipId===ctx.row.membershipId && row.agentId===actorAgentId &&
      row.openGeneration===ctx.row.openGeneration && row.state!=="revoked" && row.registeredAt!==null);
    const assignment=ledger.assignments.find(row=>row.assignmentId===input.assignmentId);
    if(actor===undefined || assignment===undefined) return reject("AUTHORITY_REQUIRED","reconciliation caller lacks a live exact membership and registered assignment","use the same registered membership tuple that owns or participates in this assignment");
    const participant=deskWorkflowParticipant(ledger,actor,assignment);
    if(participant===null) return reject("ACTOR_MISMATCH","reconciliation caller is not an exact live assignment participant","only a current/prior owner, attached seat, or authorized nominee may read its receipt");
    const stableCommand={kind:"task.reconcile",actorAgentId,assignmentId:input.assignmentId,requestId:input.requestId,taskId:input.taskId??null,
      expectedLedgerRevision:input.expectedLedgerRevision,attemptIds:input.attemptIds,actionIds:input.actionIds,resourceIds:input.resourceIds,observationTypes:input.observationTypes,
      releaseRulings:input.releaseRulings??[],attemptRulings:input.attemptRulings??[]};
    const prior=ledger.requests.find(row=>row.actorKey===`agent:${actorAgentId}` && row.assignmentId===input.assignmentId && row.requestId===input.requestId);
    if(prior!==undefined){
      const settled=await deps.store.transact(ctx.repoKey,envelopeFor(ledger,ctx,input.assignmentId,input.requestId,stableCommand),()=>reject("INVALID_RECORD","unreachable replay","resend the original request"));
      if(!settled.ok)return settled;
      const own=requestRows(ledger,input.requestId,actorAgentId,input.assignmentId);
      return {ok:true,receiptId:settled.receipt.receiptId,taskId:input.taskId??null,ledgerRevision:settled.receipt.revision,replayed:true,
        resolved:own.filter(row=>row.kind==="action" && row.state!=="uncertain").map(row=>row.entityId),outstanding:own.filter(row=>row.kind==="action" && row.state==="uncertain").map(row=>row.entityId),bound:own.filter(row=>row.kind==="attempt" && row.member!==null).map(row=>row.entityId)};
    }
    if (participant !== "current-owner") return reject("ACTOR_MISMATCH","fresh reconciliation requires the exact current owner","a former owner may only replay its own identical live receipt");
    if (assignment.state !== "open") return reject("AUTHORITY_REQUIRED","the assignment is closed","closed assignments retain history and accept no fresh reconciliation");
    if (input.expectedLedgerRevision !== undefined && input.expectedLedgerRevision !== ledger.revision) {
      return reject("REVISION_CONFLICT",`expected ledger revision ${input.expectedLedgerRevision} but the current revision is ${ledger.revision}`,"re-read current reconciliation pins before observing");
    }
    const referenced=[...input.attemptIds,...input.actionIds,...input.resourceIds,...(input.releaseRulings??[]).map(row=>row.resourceId),...(input.attemptRulings??[]).map(row=>row.attemptId)];
    if(referenced.some(id=>{const row=latestTaskEntity(ledger,id);return row===undefined || row.assignmentId!==input.assignmentId;}))return reject("ACTOR_MISMATCH","unknown or foreign reconciliation reference","all target entities belong to this assignment");
    for(const ruling of input.releaseRulings??[]) {
      const resource=latestTaskEntity<DeskTaskResourceEntryValue>(ledger,ruling.resourceId);
      const action=resource?.kind==="resource" && resource.actionId!==null?latestTaskEntity<DeskTaskActionEntryValue>(ledger,resource.actionId):undefined;
      if(action?.kind==="action" && action.actionKind==="integration")return reject("EVIDENCE_INCOMPLETE","integration resources cannot be released through generic reconciliation","verify the immutable cleanup account and use one exact issued resource permit");
    }
    // The adapter supplies observations through deps.observe — Core owns
    // the durable commit. Marks are built from what the observer returns;
    // the decide then applies them under the same invariants.
    const observe = deps.observe;
    const marks: { actionId: string; outcome: "observed" | "failed" | "abandoned" | "still-uncertain"; evidence: { kind: string; ref: string }[]; receipt?: Record<string, unknown> }[] = [];
    const resourceMarks: { resourceId: string; disposition: "retained" | "released"; observedState: string | null; positive:boolean;quiescent:boolean; evidence: { kind: string; ref: string }[] }[] = [];
    const attemptBinds: { attemptId: string; membershipId: string; evidence: { kind: string; ref: string }[] }[] = [];
    const targets = new Set<string>();
    const targetAttempts = new Map<string, DeskTaskAttemptEntryValue>();
    const targetActions = new Map<string, DeskTaskActionEntryValue>();
    const targetResources = new Map<string, DeskTaskResourceEntryValue>();
    for (const attemptId of [...new Set([...input.attemptIds,...(input.attemptRulings??[]).map(row=>row.attemptId)])]) {
      const attempt = latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, attemptId);
      if (attempt !== undefined && attempt.kind === "attempt") {
        targetAttempts.set(attemptId, attempt);
        for (const action of latestActions(ledger, { attemptId })) {
          if (action.state === "uncertain" || action.state === "issued" || (action.actionKind==="create" && action.state==="observed" && attempt.member===null && attempt.state==="reserved")) targetActions.set(action.actionId, action);
        }
      }
    }
    for (const actionId of input.actionIds) {
      const action = latestTaskEntity<DeskTaskActionEntryValue>(ledger, actionId);
      if (action !== undefined && action.kind === "action") targetActions.set(actionId, action);
    }
    for (const resourceId of [...new Set([...input.resourceIds,...(input.releaseRulings??[]).map(row=>row.resourceId)])]) {
      const resource = latestTaskEntity<DeskTaskResourceEntryValue>(ledger, resourceId);
      if (resource !== undefined && resource.kind === "resource") targetResources.set(resourceId, resource);
    }
    for(const ruling of input.attemptRulings??[]) {
      for(const action of latestActions(ledger,{attemptId:ruling.attemptId}))if(action.state==="intended")marks.push({actionId:action.actionId,outcome:"abandoned",evidence:[{kind:"never-issued-ledger-intent",ref:action.entrySha256}]});
    }
    const types = new Set(input.observationTypes);
    if (observe !== undefined) {
      if (types.has("action") && observe.observeAction !== undefined) {
        for (const action of targetActions.values()) {
          const attempt = action.attemptId !== null ? targetAttempts.get(action.attemptId) ?? latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, action.attemptId) : undefined;
          const request: Record<string, unknown> = {
            actionId: action.actionId, actionKind: action.actionKind,
            agentId: attempt?.host.agentId ?? null,
            messageId: typeof action.body?.messageId === "string" ? action.body.messageId : null,
            attemptId: action.attemptId,
          };
          let result: Record<string, unknown>;
          try {
            result = await observe.observeAction(request);
          } catch (error) {
            marks.push({ actionId: action.actionId, outcome: "still-uncertain", evidence: [{ kind: "observer-error", ref: (error as Error).message.slice(0, 256) }] });
            continue;
          }
          const resolved = result.resolved === true && (action.actionKind !== "create" ||
            (result.verification as {ok?:boolean}|undefined)?.ok === true) &&
            (action.actionKind !== "send" || ((result.evidence as {messageId?:string}|undefined)?.messageId === action.body?.messageId && typeof action.body?.messageId === "string"));
          if (resolved && action.state!=="observed") {
            marks.push({ actionId: action.actionId, outcome: "observed", evidence: [{ kind: "observeAction", ref: JSON.stringify(result.evidence ?? result).slice(0, 512) }], receipt: { status: "observed", phase: "reconciled", ...result, ...(action.actionKind==="send" ? {messageId:action.body?.messageId} : {}) } });
          } else if(action.state!=="observed") {
            marks.push({ actionId: action.actionId, outcome: "still-uncertain", evidence: [{ kind: "observeAction", ref: JSON.stringify(result).slice(0, 512) }] });
          }
          if (action.actionKind === "create" && attempt !== undefined && attempt.state === "reserved" && attempt.member === null && resolved) {
            const agent = (result.agent ?? null) as { id?: string } | null;
            const agentId = agent?.id ?? attempt.host.agentId;
            if (agentId !== null) {
              const membership = ledger.memberships.find(row => row.agentId === agentId && row.state === "host-confirmed" && row.revokedAt === null);
              if (membership !== undefined) {
                attemptBinds.push({ attemptId: attempt.attemptId, membershipId: membership.membershipId, evidence: [{ kind: "observeAction", ref: `seat-pending:${agentId}` }] });
              }
            }
          }
        }
      }
      if (types.has("resources") && observe.observeResources !== undefined && targetResources.size > 0) {
        const request = {
          ledgerRevision:ledger.revision,
          resources: [...targetResources.values()].map(resource => ({
            resourceId:resource.resourceId,kind:resource.resourceKind,resourceKey:resource.resourceKey,
            attemptId:resource.attemptId,actionId:resource.actionId,
            releaseRuling:(input.releaseRulings??[]).find(row=>row.resourceId===resource.resourceId)??null,
            agentId: resource.resourceKind === "agent" ? resource.resourceKey : undefined,
            path: resource.resourceKind === "worktree" || resource.resourceKind === "scratch" ? resource.resourceKey : undefined,
            membershipId: resource.resourceKind === "membership" ? resource.resourceKey : undefined,
          })),
        };
        let result: Record<string, unknown>;
        try {
          result = await observe.observeResources(request);
        } catch {
          result = { results: [] };
        }
        const results = Array.isArray(result.results) ? result.results : [];
        for (const resource of targetResources.values()) {
          const observed = results.find(value => typeof value==='object' && value!==null && (value as Record<string,unknown>).resourceId===resource.resourceId && (value as Record<string,unknown>).kind===resource.resourceKind) as Record<string,unknown>|undefined;
          if(observed===undefined)continue;
          const evidence=Array.isArray(observed.evidence)?observed.evidence.filter((item):item is {kind:string;ref:string}=>typeof item==='object' && item!==null && typeof item.kind==='string' && typeof item.ref==='string'):[];
          resourceMarks.push({resourceId:resource.resourceId,disposition:"retained",observedState:JSON.stringify(observed).slice(0,256),
            positive:observed.positive===true,quiescent:observed.quiescent===true,evidence});
        }
      }
      if (types.has("placement") && observe.observePlacement !== undefined) {
        for (const attempt of targetAttempts.values()) {
          if (attempt.placement.cwd === null) continue;
          try {
            await observe.observePlacement({ attemptId: attempt.attemptId, cwd: attempt.placement.cwd });
          } catch {
            // bounded observation failures leave the attempt as recorded —
            // reconcile never infers state from an absent observation.
          }
        }
      }
      if (types.has("dependencies") && observe.observeDependencies !== undefined) {
        for (const attempt of targetAttempts.values()) {
          if (attempt.consumedDependencies.length === 0) continue;
          try {
            await observe.observeDependencies({
              pins: attempt.consumedDependencies, ledgerRevision: ledger.revision,
              placement: { kind: attempt.placement.kind, ...(attempt.placement.cwd === null ? {} : { cwd: attempt.placement.cwd }),
                ...(attempt.placement.baseRef === null ? {} : { baseRef: attempt.placement.baseRef }) },
            });
          } catch {
            // observation failure is evidence-free — no mark is derived.
          }
        }
      }
      if (types.has("artifacts") && observe.observeArtifacts !== undefined) {
        for (const attempt of targetAttempts.values()) {
          const refs = attempt.consumedDependencies
            .filter(pin => pin.availability === "artifact" && pin.artifactKey !== null)
            .map(pin => ({ key: pin.artifactKey, path: pin.targetPath ?? pin.artifactKey, expectedSha256: pin.artifactSha256 }));
          if (refs.length === 0) continue;
          try {
            await observe.observeArtifacts({ attemptId: attempt.attemptId, refs });
          } catch {
            // observation failure is evidence-free — no mark is derived.
          }
        }
      }
    }
    const observedCommand={kind:"task.reconcile",actorAgentId,assignmentId:input.assignmentId,requestId:input.requestId,taskId:input.taskId??null,
      expectedLedgerRevision:input.expectedLedgerRevision,observedLedgerRevision:ledger.revision,marks,resourceMarks,attemptBinds,attemptStops:[],attemptSettles:[],
      releaseRulings:input.releaseRulings??[],attemptRulings:input.attemptRulings??[]};
    const settled=await deps.store.transact(ctx.repoKey,envelopeFor(ledger,ctx,input.assignmentId,input.requestId,stableCommand),
      (locked,stable)=>decideDeskTask(locked,{...observedCommand,actorMembershipId:stable.actorMembershipId,actorOpenGeneration:stable.actorOpenGeneration}));
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    return {
      ok: true, receiptId: settled.receipt.receiptId, taskId: input.taskId ?? null,
      ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed,
      resolved: marks.filter(mark => mark.outcome !== "still-uncertain").map(mark => mark.actionId),
      outstanding: marks.filter(mark => mark.outcome === "still-uncertain").map(mark => mark.actionId),
      bound: attemptBinds.map(mark => mark.attemptId),
    };
  }

  return { ok: false, code: "INVALID_RECORD", message: `unsupported task command operation`, recovery: "operations are a closed set" };
}

export async function runTaskEffect(
  ctx: RunnerCtx,
  wireInput: DeskTaskEffectInputValue | Record<string, unknown>,
  deps: TaskRunnerDeps,
): Promise<DeskTaskEffectResultValue | DeskRejectionValue> {
  const parsed = DeskTaskEffectInput.safeParse(wireInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, code: "INVALID_RECORD", message: `task effect failed wire validation${issue !== undefined ? `: ${issue.path.join(".")} ${issue.message}` : ""}`, recovery: "send a member of the DeskTaskEffectInput union" };
  }
  const input = parsed.data;
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const actorAgentId = ctx.row.agentId as string;

  const resolveAssignment = (): { assignmentId: string } | DeskRejectionValue => {
    if ("assignmentId" in input && typeof input.assignmentId === "string") return { assignmentId: input.assignmentId };
    if ("attemptId" in input && typeof input.attemptId === "string") {
      const attempt = latestTaskEntity(ledger, input.attemptId);
      if (attempt !== undefined) return { assignmentId: attempt.assignmentId };
    }
    if ("actionId" in input && typeof input.actionId === "string") {
      const action = latestTaskEntity(ledger, input.actionId);
      if (action !== undefined) return { assignmentId: action.assignmentId };
    }
    if ("taskId" in input && typeof input.taskId === "string") {
      const row = latestTaskEntity(ledger, input.taskId);
      if (row !== undefined) return { assignmentId: row.assignmentId };
    }
    return { ok: false, code: "INVALID_RECORD", message: "the effect cannot resolve its assignment", recovery: "name an attemptId/actionId/taskId the ledger committed" };
  };

  if (input.operation === "intent") {
    const resolved = resolveAssignment();
    if (isRejection(resolved)) return resolved;
    const command = {
      kind: "task.effect.intent", actorAgentId, assignmentId: resolved.assignmentId, requestId: input.requestId,
      taskId: input.taskId ?? null, attemptId: input.attemptId ?? null, actionId: input.actionId ?? null,
      resultId: input.resultId ?? null,
      actionKind: input.actionKind, body: input.body,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, resolved.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    const actionId = input.actionId
      ?? requestRow<DeskTaskActionEntryValue>(after, input.requestId, actorAgentId, resolved.assignmentId, "action")?.actionId
      ?? (input.attemptId !== undefined
        ? latestActions(after, { attemptId: input.attemptId }).filter(row => row.state === "intended" && row.actionKind === input.actionKind).at(-1)?.actionId
        : undefined);
    if (actionId === undefined) return { ok: false, code: "CAPABILITY_GAP", message: "the intent committed but its action row is not readable", recovery: "retry the same requestId — the replay rebuilds the response" };
    return { ok: true, actionId, actionPin: { actionId }, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed };
  }

  if (input.operation === "issue") {
    const resolved = resolveAssignment();
    if (isRejection(resolved)) return resolved;
    const existing = latestTaskEntity<DeskTaskActionEntryValue>(ledger, input.actionId);
    const stableIssue={kind:"task.effect.issue",actorAgentId,assignmentId:resolved.assignmentId,requestId:input.requestId,
      attemptId:input.attemptId??null,actionId:input.actionId,actionKind:input.actionKind??null};
    const prior=ledger.requests.find(row=>row.actorKey===`agent:${actorAgentId}` && row.assignmentId===resolved.assignmentId && row.requestId===input.requestId);
    if(prior!==undefined){
      const settled=await deps.store.transact(ctx.repoKey,envelopeFor(ledger,ctx,resolved.assignmentId,input.requestId,stableIssue),()=>reject("INVALID_RECORD","unreachable replay","send the identical request"));
      if(!settled.ok)return settled;
      return {ok:true,actionId:input.actionId,perform:false,replayed:true,ledgerRevision:settled.receipt.revision};
    }
    if(existing?.kind==="action" && existing.state!=="intended") return {ok:true,actionId:input.actionId,perform:false,reason:"the action has no unissued current intent"};
    let cleanupIssueEvidence:DeskTaskIntegrationCleanupPreflightEvidenceValue|null=null;
    if(existing?.kind==="action" && existing.actionKind==="integration" && existing.phase==="discharge" && existing.body?.cleanupStep==="remove-resource") {
      const owner=effectiveOwner(ledger,ledger.assignments.find(row=>row.assignmentId===existing.assignmentId)!);
      if(owner.agentId!==actorAgentId || owner.membershipId!==ctx.row.membershipId)return reject("ACTOR_MISMATCH","resource preflight requires the exact current owner","do not inspect or remove a resource under a former owner tuple");
      const verification=DeskTaskIntegrationCleanupVerification.safeParse(existing.cleanupVerification);
      const permit=DeskTaskIntegrationCleanupPermit.safeParse(existing.body.permit);
      const sourcePins=cleanupSourcePins(existing);
      const verificationRef=cleanupVerificationRef(ledger,existing);
      const controlPins=DeskTaskIntegrationControlPins.safeParse(existing.body.controlPins);
      const grantRef=existing.grant?.authorityRef;
      if(!verification.success || !permit.success || "ok" in sourcePins || "ok" in verificationRef || !controlPins.success ||
          typeof existing.body.publicRequestId!=="string" || typeof existing.body.publicRequestSha256!=="string" || grantRef==null) {
        return reject("EVIDENCE_INCOMPLETE","resource issue lacks exact source, current intent controls, grant, account or permit","retain all resources and reread the immutable preflight inputs");
      }
      const admission:Omit<Extract<DeskTaskIntegrationCleanupPublicAdmission,{phase:"discharge"}> ,"issueRef"> & {issueRef:null}={
        phase:"discharge",publicRequestId:existing.body.publicRequestId,publicRequestSha256:existing.body.publicRequestSha256,
        grantRef,controlPins:controlPins.data,intentRef:integrationEntryRef(existing),issueRef:null,
      };
      const priorIssued=latestIssuedCleanupPermit(ledger,existing.actionId,permit.data.resourceId);
      const priorValue=priorIssued===null?null:{permit:priorIssued.permit,issueRef:integrationEntryRef(priorIssued.row)};
      const observer=deps.observe?.observeIntegrationCleanup;
      if(observer===undefined)return reject("CAPABILITY_GAP","the readonly cleanup resource preflight observer is unavailable","retain the intent and supply bounded source/target/resource measurements before ISSUE");
      const request:DeskTaskIntegrationCleanupObserverRequest={
        version:1,purpose:"reconcile-progress",progressKind:"resource-preflight",admission,
        actionId:existing.actionId,expectedActionRevision:existing.revision,
        sourceBase:sourcePins.sourceBase,sourceResult:sourcePins.sourceResult,
        candidate:null,candidateArtifactBytes:null,verification:verification.data,verificationRef,
        permit:permit.data,priorIssuedPermit:priorValue,
      };
      let response:DeskTaskIntegrationCleanupObserverResponseValue;
      try{response=await observer(request);}catch{return reject("CAPABILITY_GAP","readonly cleanup resource preflight did not complete","retain all resources; no ISSUE or deletion follows");}
      const verified=verifyCleanupResourceProgress(ledger,existing,verification.data,permit.data,response,
        taskIntegrationCleanupAdmissionSha256(admission),sourcePins.sourceBase,sourcePins.sourceResult,
        "reconcile-progress","resource-preflight",priorIssued,null);
      if("ok" in verified)return verified;
      if(verified.targetResourceRemoved)return reject("RECOVERY_REQUIRED","preflight found the target resource fully absent under an earlier issued permit","reconcile that exact issued receipt; do not create a no-op removal effect");
      cleanupIssueEvidence={version:1,admissionSha256:taskIntegrationCleanupAdmissionSha256(admission),
        verificationRef,permit:permit.data,priorIssuedPermitRef:priorValue===null?null:priorValue.issueRef,
        observerResponseSha256:verified.observerResponseSha256,target:verified.target,resources:verified.resources};
    }
    const attempt = existing?.attemptId != null ? latestTaskEntity<DeskTaskAttemptEntryValue>(ledger, existing.attemptId) : undefined;
    const placement: DeskTaskPlacementValue = attempt === undefined ? { kind: "shared-checkout" } : {
      kind: attempt.placement.kind, ...(attempt.placement.cwd === null ? {} : { cwd: attempt.placement.cwd }),
      ...(attempt.placement.baseRef === null ? {} : { baseRef: attempt.placement.baseRef }),
      ...(attempt.placement.workspaceId === null ? {} : { workspaceId: attempt.placement.workspaceId }),
    };
    const observation = await measureDependencies(ledger, attempt?.consumedDependencies ?? [], placement, deps);
    if (observation !== null && "ok" in observation) return observation;
    const command = {
      kind: "task.effect.issue", actorAgentId, assignmentId: resolved.assignmentId, requestId: input.requestId,
      attemptId: input.attemptId ?? null, actionId: input.actionId, actionKind: input.actionKind ?? null,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, resolved.assignmentId, input.requestId, command),
      (locked, stable) => decideDeskTask(locked, { ...stable, dependencyObservation: observation, ...(cleanupIssueEvidence===null?{}:{cleanupIssueEvidence}) }));
    if (!settled.ok) {
      // Non-admission is a clean refusal, never an error — the caller runs
      // zero host/filesystem effects and no observe follows.
      if (settled.code === "EFFECT_INADMISSIBLE") {
        return { ok: true, actionId: input.actionId, perform: false, reason: settled.message };
      }
      return settled;
    }
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    const action = requestRow<DeskTaskActionEntryValue>(after, input.requestId, actorAgentId, resolved.assignmentId, "action", input.actionId)
      ?? latestTaskEntity<DeskTaskActionEntryValue>(after, input.actionId);
    if (action === undefined || action.state !== "issued") {
      return { ok: false, code: "CAPABILITY_GAP", message: "the issue committed but its action row is not readable", recovery: "retry the same requestId — the replay rebuilds the response" };
    }
    const issuedAttempt = action.attemptId !== null ? latestTaskEntity<DeskTaskAttemptEntryValue>(after, action.attemptId) : undefined;
    const permit: TaskEffectPermit = {
      actionId: action.actionId,
      entrySha256: action.entrySha256,
      ownershipRevision: action.ownershipRevision,
      attemptRevision: issuedAttempt?.revision ?? 0,
      body: (action.body ?? {}) as Record<string, unknown>,
    };
    return { ok: true, actionId: action.actionId, perform: !settled.receipt.replayed, ...(settled.receipt.replayed ? {} : { permit }), ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed };
  }

  if (input.operation === "observe") {
    const resolved = resolveAssignment();
    if (isRejection(resolved)) return resolved;
    const cleanupTriggerResult = DeskTaskIntegrationCleanupTrigger.safeParse(input.receipt);
    const command = {
      kind: "task.effect.observe", actorAgentId, assignmentId: resolved.assignmentId, requestId: input.requestId,
      taskId: input.taskId ?? null, attemptId: input.attemptId ?? null, resultId: input.resultId ?? null,
      actionId: input.actionId, actionKind: input.actionKind, receipt: input.receipt,
    };
    if (input.actionKind === "integration" && input.receipt.phase === "reconcile") {
      const priorAction = ledger.taskEntries.find(row => row.kind === "action" && row.requestId === input.requestId &&
        row.actorAgentId === actorAgentId && row.actionKind === "integration" && row.receipt?.phase === "reconcile");
      if (priorAction?.kind === "action") {
        if (priorAction.actionId !== input.actionId || priorAction.assignmentId !== resolved.assignmentId) {
          return reject("IDEMPOTENCY_CONFLICT", "reconcile action/assignment differs from its recorded phase receipt", "resend the exact action-bound reconciliation request");
        }
        const member = ledger.memberships.find(row => row.membershipId === ctx.row.membershipId && row.agentId === actorAgentId &&
          row.openGeneration === ctx.row.openGeneration && row.state !== "revoked" && row.registeredAt !== null);
        const assignment = ledger.assignments.find(row => row.assignmentId === resolved.assignmentId);
        if (member === undefined || assignment === undefined || deskWorkflowParticipant(ledger, member, assignment) === null) {
          return reject("AUTHORITY_REQUIRED", "reconcile receipt replay lacks its original live participant tuple", "revoked, rebound, or foreign actors cannot recover the receipt");
        }
        // Store idempotency checks the complete original body, including
        // actor membership/open generation, before decide/current-owner CAS.
        // This returns only the committed receipt and never authorizes an
        // effect or a fresh observation.
        const replay = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, resolved.assignmentId, input.requestId, command), decideDeskTask);
        if (!replay.ok) return replay;
        return { ok: true, actionId: input.actionId, ledgerRevision: replay.receipt.revision, replayed: true };
      }
    }
    const priorObserve = ledger.requests.find(row => row.actorKey === `agent:${actorAgentId}` && row.assignmentId === resolved.assignmentId && row.requestId === input.requestId);
    if (priorObserve !== undefined) {
      // Historical request bodies contain the exact status-free trigger. This
      // replay runs before reading cleanupArtifactBytes or invoking any
      // adapter observer, and the store compares the original trigger hash.
      const replay = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, resolved.assignmentId, input.requestId, command), decideDeskTask);
      if (!replay.ok) return replay;
      return { ok: true, actionId: input.actionId, ledgerRevision: replay.receipt.revision, replayed: true };
    }
    if (cleanupTriggerResult.success) {
      const action = latestTaskEntity<DeskTaskActionEntryValue>(ledger, input.actionId);
      if (action === undefined || action.kind !== "action" || action.assignmentId !== resolved.assignmentId) {
        return reject("ACTOR_MISMATCH", "cleanup trigger names no exact committed integration action", "observe only the matching action history under its assignment");
      }
      const cleanupObservation = await cleanupObservationFromTrigger(ledger, action, cleanupTriggerResult.data, deps);
      if ("ok" in cleanupObservation) return cleanupObservation;
      const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, resolved.assignmentId, input.requestId, command),
        (locked, stable) => decideDeskTask(locked, { ...stable, cleanupObservation }));
      if (!settled.ok) return settled;
      return { ok: true, actionId: input.actionId, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed };
    }
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, resolved.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    return { ok: true, actionId: input.actionId, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed };
  }

  if (input.operation === "bind") {
    const resolved = resolveAssignment();
    if (isRejection(resolved)) return resolved;
    const command = {
      kind: "task.effect.bind", actorAgentId, assignmentId: resolved.assignmentId, requestId: input.requestId,
      attemptId: input.attemptId, member: input.member, observed: input.observed,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, resolved.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    return { ok: true, bound: true, attemptId: input.attemptId, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed };
  }

  if (input.operation === "integration-admit") {
    const command = {
      kind: "task.effect.integration-admit", actorAgentId, assignmentId: input.assignmentId, requestId: input.requestId,
      taskId: input.taskId, resultId: input.resultId,
      expectedResultRevision: input.expectedResultRevision, expectedAdjudicationRevision: input.expectedAdjudicationRevision,
      expectedLedgerRevision: input.expectedLedgerRevision,
      grant: input.grant, verification: input.verification, body: input.body,
    };
    const settled = await deps.store.transact(ctx.repoKey, envelopeFor(ledger, ctx, input.assignmentId, input.requestId, command), decideDeskTask);
    if (!settled.ok) return settled;
    const after = readLedger(deps, ctx.repoKey);
    if (isRejection(after)) return after;
    const action = requestRow<DeskTaskActionEntryValue>(after, input.requestId, actorAgentId, input.assignmentId, "action")
;
    if (action === undefined) return { ok: false, code: "CAPABILITY_GAP", message: "the admission committed but its action row is not readable", recovery: "retry the same requestId — the replay rebuilds the response" };
    return { ok: true, actionId: action.actionId, actionPin: { actionId: action.actionId }, perform: !settled.receipt.replayed, ledgerRevision: settled.receipt.revision, replayed: settled.receipt.replayed };
  }

  return { ok: false, code: "INVALID_RECORD", message: `unsupported task effect operation`, recovery: "operations are a closed set" };
}
