// Pure post-state capacity accounting for task recovery obligations.
// Keep this module dependency-light: the store supplies the complete candidate
// tables and this module does not know about store transactions or authority.
import { WIRE_LIMITS } from "../shared/enforcement.ts";

type Row = Record<string, unknown>;

export type DeskTaskCapacitySnapshot = {
  taskEntries: readonly unknown[];
  memberships: readonly unknown[];
  assignments: readonly unknown[];
  scopes: readonly unknown[];
  scopeTransitions: readonly unknown[];
};

export type DeskTaskCapacityLimits = { eventPayloadBytes: number };

export type DeskTaskCapacityReserve = {
  requests: number;
  taskEntries: number;
  bytes: number;
  memberships: number;
  scopes: number;
  scopeTransitions: number;
  assignmentSeats: ReadonlyMap<string, number>;
  futureEvents: number;
};

const TASK_ENTRY_BYTES = WIRE_LIMITS.deskTaskEntryBytes * 2 + 4096;
const REQUEST_BYTES = 4096;
const ASSIGNMENT_SEAT_BYTES = 4096;
const GLOBAL_RECOVERY = {
  requests: WIRE_LIMITS.deskTaskRecoveryRequests,
  entries: WIRE_LIMITS.deskTaskRecoveryEntries,
  bytes: WIRE_LIMITS.deskTaskRecoveryBytes,
} as const;

function record(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
}

function rows(values: readonly unknown[]): Row[] {
  return values.map(record).filter((value): value is Row => value !== null);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function latestByEntity(entries: readonly Row[]): Map<string, Row> {
  const latest = new Map<string, Row>();
  for (const row of entries) {
    const id = text(row.entityId);
    if (id === null) continue;
    const previous = latest.get(id);
    if (previous === undefined || integer(previous.revision) < integer(row.revision)) latest.set(id, row);
  }
  return latest;
}

function utf8JsonBytes(value: unknown, fallback: number): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return fallback;
  }
}

/** Calculate future credits from exact current heads and immutable action history.
 *
 * The reserved floor applies to every caller, including legacy decides and
 * recorded rejections. Per-obligation credits are released only when the
 * after-state proves that exact edge or resource credit was consumed.
 */
export function resolveDeskTaskCapacityReserve(snapshot: DeskTaskCapacitySnapshot, limits: DeskTaskCapacityLimits): DeskTaskCapacityReserve {
  const auxRowBytes = WIRE_LIMITS.deskTaskEntryBytes + limits.eventPayloadBytes + 4096;
  const membershipRowBytes = auxRowBytes;
  const history = rows(snapshot.taskEntries);
  const heads = latestByEntity(history);
  const members = rows(snapshot.memberships);
  const assignments = rows(snapshot.assignments);
  const scopes = rows(snapshot.scopes);
  const transitions = rows(snapshot.scopeTransitions);
  let requests = GLOBAL_RECOVERY.requests;
  let taskEntries = GLOBAL_RECOVERY.entries;
  let memberships = 0;
  let scopeRows = 0;
  let scopeTransitions = 0;
  let bytes = GLOBAL_RECOVERY.bytes;
  let futureEvents = 0;
  const assignmentSeats = new Map<string, number>();

  const add = (cost: {
    requests?: number; taskEntries?: number; memberships?: number; scopes?: number;
    scopeTransitions?: number; bytes?: number; futureEvents?: number;
  }): void => {
    const req = cost.requests ?? 0;
    const taskRows = cost.taskEntries ?? 0;
    const memberRows = cost.memberships ?? 0;
    const scopesRows = cost.scopes ?? 0;
    const transitionRows = cost.scopeTransitions ?? 0;
    requests += req;
    taskEntries += taskRows;
    memberships += memberRows;
    scopeRows += scopesRows;
    scopeTransitions += transitionRows;
    futureEvents += cost.futureEvents ?? (taskRows + memberRows + scopesRows + transitionRows);
    bytes += cost.bytes ?? taskRows * TASK_ENTRY_BYTES + req * REQUEST_BYTES + memberRows * membershipRowBytes +
      scopesRows * auxRowBytes + transitionRows * auxRowBytes;
  };
  const addSeat = (assignmentId: string, count = 1): void => {
    assignmentSeats.set(assignmentId, (assignmentSeats.get(assignmentId) ?? 0) + count);
    bytes += count * ASSIGNMENT_SEAT_BYTES;
    futureEvents += count;
  };

  const current = [...heads.values()];
  const attempts = current.filter(row => row.kind === "attempt");
  const resources = current.filter(row => row.kind === "resource");
  const deliveries = current.filter(row => row.kind === "delivery");
  const actions = current.filter(row => row.kind === "action");
  const integrations = actions.filter(row => row.actionKind === "integration");
  const integrationIds = new Set(integrations.map(row => text(row.actionId)).filter((id): id is string => id !== null));
  const resourceByAttempt = (attemptId: string): Row[] => resources.filter(row => row.attemptId === attemptId);
  const resourceByIntegration = (actionId: string): Row[] => resources.filter(row => row.actionId === actionId);
  const actionHistory = (actionId: string): Row[] => history.filter(row => row.kind === "action" && row.actionId === actionId)
    .sort((a, b) => integer(a.revision) - integer(b.revision));

  // Current open scopes keep one exact terminal transition credit. New task
  // scope templates reserve their declaration, claim and terminal close path
  // until the atomic bind consumes the first two transitions.
  const latestScope = new Map<string, Row>();
  for (const scope of scopes) {
    const id = text(scope.scopeId);
    if (id === null) continue;
    const previous = latestScope.get(id);
    if (previous === undefined || integer(previous.revision) < integer(scope.revision)) latestScope.set(id, scope);
  }
  const latestTransition = new Map<string, Row>();
  for (const transition of transitions) {
    const id = text(transition.scopeId);
    if (id === null) continue;
    const previous = latestTransition.get(id);
    if (previous === undefined || integer(previous.revision) < integer(transition.revision)) latestTransition.set(id, transition);
  }
  const openScopeIds = new Set<string>();
  for (const [id] of latestScope) {
    const state = text(latestTransition.get(id)?.to);
    if (state !== "closed" && state !== "advanced") openScopeIds.add(id);
  }
  if (openScopeIds.size > 0) add({ scopeTransitions: openScopeIds.size, bytes: openScopeIds.size * auxRowBytes, futureEvents: openScopeIds.size });

  for (const attempt of attempts) {
    const attemptId = text(attempt.attemptId);
    const assignmentId = text(attempt.assignmentId);
    const taskId = text(attempt.taskId);
    if (attemptId === null || assignmentId === null || taskId === null) continue;
    const terminal = attempt.state === "settled" || attempt.state === "stopped";
    if (!terminal) {
      // The final ruling can stop (attempt + control) or settle (attempt).
      // Retain the larger exact supported terminal path until it commits.
      add({ requests: 1, taskEntries: 2, futureEvents: 2 });
      const stop = record(attempt.stop);
      if (stop?.requested !== true && attempt.state !== "stop-requested") add({ requests: 1, taskEntries: 2, futureEvents: 2 });
    }

    const stop = record(attempt.stop);
    const mayBind = !terminal && stop?.requested !== true && attempt.state !== "stop-requested" && attempt.member === null;
    const attemptActions = actions.filter(row => row.attemptId === attemptId && row.actionKind !== "integration" &&
      ["intended", "issued", "uncertain", "held"].includes(String(row.state)));
    const hasWorktree = resourceByAttempt(attemptId).some(row => row.resourceKind === "worktree");
    const placement = record(attempt.placement);
    // Place receipts may retain a worktree even when held/failed/uncertain,
    // and even after stop. Its birth is shared with the bind fallback, once
    // per attempt, and does not depend on an already-materialized cwd. The
    // receipt/atomic bind pays its own request; the later release is distinct.
    const mayObservePlace = attemptActions.some(row => row.actionKind === "place");
    if (placement?.kind === "isolated" && !hasWorktree && (mayBind || mayObservePlace)) {
      add({ taskEntries: 1, futureEvents: 1 });
      add({ requests: 1, taskEntries: 1, futureEvents: 1 });
    }
    if (mayBind) {
      const bindResourceRows = 2;
      // bind atomically appends the attempt and agent/membership resources,
      // and may declare+claim the pinned task scope. A possible worktree is
      // accounted independently above, so an issued place cannot borrow bind.
      const pinnedTask = history.find(row => row.kind === "task" && row.taskId === taskId && row.assignmentId === assignmentId &&
        row.revision === attempt.taskRevision);
      const pinnedScope = record(pinnedTask?.scope);
      const scopeTemplatePresent = pinnedTask !== undefined && pinnedTask.scope !== null;
      const scopeTemplateBytes = scopeTemplatePresent ? utf8JsonBytes(pinnedTask.scope, auxRowBytes) : 0;
      const transitionsForBind = scopeTemplatePresent ? 2 : 0;
      const scopeTerminal = scopeTemplatePresent ? 1 : 0;
      add({ requests: 1, taskEntries: 1 + bindResourceRows, scopes: scopeTemplatePresent ? 1 : 0,
        scopeTransitions: transitionsForBind + scopeTerminal,
      bytes: (1 + bindResourceRows) * TASK_ENTRY_BYTES + REQUEST_BYTES +
          (scopeTemplatePresent ? Math.max(auxRowBytes, scopeTemplateBytes * 2 + 8192) : 0) +
          (transitionsForBind + scopeTerminal) * auxRowBytes,
        futureEvents: 2 + bindResourceRows + (scopeTemplatePresent ? 3 : 0) });
      // The bound agent/membership rows each keep their own later positive
      // release edge. Worktree birth/release is accounted independently.
      add({ requests: bindResourceRows, taskEntries: bindResourceRows, futureEvents: bindResourceRows });

      const existingClaim = members.some(member => {
        const claim = record(member.capacityClaim);
        return claim?.attemptId === attemptId;
      });
      const hostAgentId = text(record(attempt.host)?.agentId);
      const alreadyMintedHost = hostAgentId !== null && members.some(member => member.agentId === hostAgentId);
      const reuse = record(attempt.reuseTarget);
      const needsMembership = reuse === null && !existingClaim && !alreadyMintedHost;
      if (needsMembership) add({ requests: 1, memberships: 1, futureEvents: 1 });

      if (reuse === null) {
        const assignment = assignments.find(row => row.assignmentId === assignmentId);
        const seats = Array.isArray(assignment?.seats) ? assignment.seats.map(record).filter((row): row is Row => row !== null) : [];
        const claimedSeatIds = new Set(members.filter(member => {
          const claim = record(member.capacityClaim);
          return claim?.attemptId === attemptId;
        }).map(member => text(member.membershipId)).filter((id): id is string => id !== null));
        const attachedClaim = seats.some(seat => claimedSeatIds.has(text(seat.membershipId) ?? ""));
        if (!attachedClaim) addSeat(assignmentId);
      }
    }

    for (const action of attemptActions) {
      // An accepted nonintegration receipt always appends an action. It can
      // also revise its live attempt (place/base, host ID, running/bound/stop
      // state). A positive send additionally advances its exact pending
      // delivery; the two acknowledgment revisions remain separately funded.
      // Keep the positive-resolution edge for held/uncertain heads. Fresh
      // unresolved receipts consume unreserved slack, not this terminal
      // credit; no retry quota or unlimited loop is promised here.
      const receiptMayChangeAttempt = ["reserved", "bound", "dispatched", "running",
        "reconciliation-required", "stop-requested"].includes(String(attempt.state));
      const pendingSendDelivery = action.actionKind === "send" && deliveries.some(row =>
        row.taskId === action.taskId && row.actionId === action.actionId && row.state === "pending");
      const receiptRows = 1 + (receiptMayChangeAttempt ? 1 : 0) + (pendingSendDelivery ? 1 : 0);
      const issueRows = action.state === "intended" ? 1 : 0;
      add({ requests: 1 + issueRows, taskEntries: receiptRows + issueRows, futureEvents: receiptRows + issueRows });
    }
    // `resourceByAttempt` rows are accounted once below with assignment-level
    // resources; it includes taskId:null history and never infers by page.
  }

  // Every pending delivery has exact remaining responsibility/handling edges.
  // Each edge is a distinct Core request and immutable delivery revision.
  for (const delivery of deliveries) {
    if (delivery.state === "handled") continue;
    const remaining = delivery.state === "responsibility-acknowledged" ? 1 : 2;
    add({ requests: remaining, taskEntries: remaining, futureEvents: remaining });
  }

  // Assignment and attempt resources, including taskId:null rows, retain one
  // positive release row each. Integration stage/backup paths use the stricter
  // proof cycles below instead of the generic observer credit.
  for (const resource of resources) {
    if (resource.disposition === "released") continue;
    const actionId = text(resource.actionId);
    if (actionId !== null && integrationIds.has(actionId)) continue;
    add({ requests: 1, taskEntries: 1, futureEvents: 1 });
  }

  const verifyCycleRemaining = (historyRows: readonly Row[], latest: Row, hasVerification: boolean): { requests: number; entries: number } => {
    if (hasVerification) return { requests: 0, entries: 0 };
    const intents = historyRows.filter(row => row.phase === "discharge" && row.state === "intended" && record(row.body)?.cleanupStep === "verify-account");
    const used = intents.length;
    const latestBody = record(latest.body);
    const latestStep = latestBody?.cleanupStep;
    let currentCycle = 0;
    if (latestStep === "verify-account" && latest.phase === "discharge") {
      if (latest.state === "intended") currentCycle = 2;
      else if (latest.state === "issued") currentCycle = 1;
    }
    const futureCycles = Math.max(0, 2 - used);
    // An issued cycle has exactly one terminal observe OR lost-observe
    // reconcile; a persisted held receipt consumes the cycle and leaves only
    // the single bounded continuation, if any. The current second intent is
    // already one of the two cycles, but its own issue/observe credits remain
    // funded until those exact rows commit.
    const remaining = currentCycle + futureCycles * 3;
    return { requests: remaining, entries: remaining };
  };

  const resourceCycleRemaining = (historyRows: readonly Row[], latest: Row, resourceId: string, released: boolean): {
    requests: number; entries: number; releaseEntry: number; canComplete: boolean;
  } => {
    if (released) return { requests: 0, entries: 0, releaseEntry: 0, canComplete: false };
    const permitId = (row: Row): string | null => text(record(record(row.body)?.permit)?.resourceId);
    const intents = historyRows.filter(row => row.phase === "discharge" && row.state === "intended" &&
      record(row.body)?.cleanupStep === "remove-resource" && permitId(row) === resourceId);
    const used = intents.length;
    if (used >= 2) {
      const body = record(latest.body);
      const inFlight = latest.phase === "discharge" && record(body)?.cleanupStep === "remove-resource" && permitId(latest) === resourceId &&
        (latest.state === "intended" || latest.state === "issued");
      if (!inFlight) return { requests: 0, entries: 0, releaseEntry: 0, canComplete: false };
    }
    const body = record(latest.body);
    const active = latest.phase === "discharge" && record(body)?.cleanupStep === "remove-resource" && permitId(latest) === resourceId &&
      (latest.state === "intended" || latest.state === "issued");
    const current = active ? (latest.state === "intended" ? 2 : 1) : 0;
    const future = Math.max(0, 2 - used);
    const cycles = current + future * 3;
    const canComplete = current > 0 || future > 0;
    return { requests: cycles, entries: cycles, releaseEntry: canComplete ? 1 : 0, canComplete };
  };

  for (const action of integrations) {
    const actionId = text(action.actionId);
    if (actionId === null) continue;
    const historyRows = actionHistory(actionId);
    const body = record(action.body) ?? {};
    const receipt = record(action.receipt) ?? {};
    const resourcesForAction = resourceByIntegration(actionId);
    const plan = record(action.recoveryPlan);
    const verification = record(action.cleanupVerification);
    const verifiedCandidate = record(verification?.candidate);
    const candidate = verifiedCandidate ?? record(body.cleanupCandidate);
    const candidateResources = Array.isArray(candidate?.resources)
      ? candidate.resources.map(record).filter((value): value is Row => value !== null)
      : [];
    const positiveLandProof = historyRows.some(row => {
      const rowReceipt = record(row.receipt);
      return rowReceipt?.status === "observed" && rowReceipt.backupIntegrity === true &&
        (rowReceipt.recoveryClassification === "full-applied" || rowReceipt.recoveryClassification === "original") &&
        (rowReceipt.phase === "land" || rowReceipt.phase === "reconcile");
    });
    const phase = text(action.phase);
    const state = text(action.state);
    const hasDischarge = phase === "discharge";
    const cleanupOnly = hasDischarge || phase === "reconcile" && (receipt.cleanupObservation !== undefined || receipt.cleanupTrigger !== undefined);
    let phaseRequests = 0;
    let phaseEntries = 0;

    if (!cleanupOnly) {
      if (phase === "stage" && state === "issued") { phaseRequests += 1; phaseEntries += 1; }
      const verificationPlan = record(action.verification);
      const checkRequired = Array.isArray(verificationPlan?.recipeIds) && verificationPlan.recipeIds.length > 0;
      if (phase === "stage" && checkRequired) { phaseRequests += 3; phaseEntries += 3; }
      else if (phase === "check") {
        const remainingCheck = state === "intended" ? 2 : state === "issued" ? 1 : 0;
        phaseRequests += remainingCheck; phaseEntries += remainingCheck;
      }
      if (phase === "stage" || phase === "check") { phaseRequests += 4; phaseEntries += 4; }
      else if (phase === "land") {
        const remainingLand = state === "intended" ? 3 : state === "issued" ? 2 : 1;
        phaseRequests += remainingLand; phaseEntries += remainingLand;
      } else if (phase === "reconcile" && !positiveLandProof) {
        // A held partial/unknown classification has one supported fresh
        // observation edge; it cannot start cleanup without positive proof.
        phaseRequests += 1; phaseEntries += 1;
      }
    }

    const pathStage = text(plan?.stageDir) ?? text(action.stageDir) ??
      text(candidateResources.find(item => item.role === "stage")?.resourceKey) ?? null;
    const pathBackup = text(plan?.backupDir) ?? text(action.backupDir) ??
      text(candidateResources.find(item => item.role === "backup")?.resourceKey) ?? null;
    const findResource = (path: string | null, role: string): Row | undefined => {
      if (path !== null) return resourcesForAction.find(item => item.resourceKey === path);
      const candidatePin = candidateResources.find(item => item.role === role);
      const id = text(candidatePin?.resourceId);
      return id === null ? undefined : resourcesForAction.find(item => item.resourceId === id);
    };
    const stageResource = findResource(pathStage, "stage");
    const backupResource = findResource(pathBackup, "backup");
    const canReachLand = !cleanupOnly && (phase === "stage" || phase === "check" || phase === "land" || phase === "reconcile");
    const needsStageRow = canReachLand && stageResource === undefined;
    const needsBackupRow = canReachLand && backupResource === undefined;
    if (needsStageRow) add({ taskEntries: 1, futureEvents: 1 });
    if (needsBackupRow) add({ taskEntries: 1, futureEvents: 1 });

    const positiveCleanupSource = positiveLandProof || candidate?.basis === "stage-only";
    const resourceDefs = candidateResources.length > 0 ? candidateResources : plan !== null || canReachLand
      ? [
          { role: "stage", resourceId: text(stageResource?.resourceId), resourceKey: pathStage, disposition: stageResource?.disposition ?? "retained" },
          { role: "backup", resourceId: text(backupResource?.resourceId), resourceKey: pathBackup, disposition: backupResource?.disposition ?? "retained" },
        ]
      : stageResource !== undefined ? [{ role: "stage", resourceId: stageResource.resourceId, resourceKey: stageResource.resourceKey, disposition: stageResource.disposition }] : [];

    if (positiveCleanupSource || canReachLand) {
      const verify = verifyCycleRemaining(historyRows, action, verification !== null);
      phaseRequests += verify.requests; phaseEntries += verify.entries;
      const stageDef = resourceDefs.find(item => item.role === "stage");
      const backupDef = resourceDefs.find(item => item.role === "backup");
      const stageId = text(stageDef?.resourceId) ?? text(stageResource?.resourceId);
      const backupId = text(backupDef?.resourceId) ?? text(backupResource?.resourceId);
      const stageRow = stageId === null ? stageResource : resourcesForAction.find(item => item.resourceId === stageId) ?? stageResource;
      const backupRow = backupId === null ? backupResource : resourcesForAction.find(item => item.resourceId === backupId) ?? backupResource;
      const stageCost = resourceCycleRemaining(historyRows, action, stageId ?? "__stage__", stageRow?.disposition === "released");
      const backupCanRun = stageRow?.disposition === "released" || stageCost.canComplete;
      const backupCost = backupCanRun
        ? resourceCycleRemaining(historyRows, action, backupId ?? "__backup__", backupRow?.disposition === "released")
        : { requests: 0, entries: 0, releaseEntry: 0, canComplete: false };
      phaseRequests += stageCost.requests + backupCost.requests;
      phaseEntries += stageCost.entries + backupCost.entries + stageCost.releaseEntry + backupCost.releaseEntry;
    }

    if (phaseRequests > 0 || phaseEntries > 0) add({ requests: phaseRequests, taskEntries: phaseEntries, futureEvents: phaseEntries });
  }

  return { requests, taskEntries, bytes, memberships, scopes: scopeRows, scopeTransitions,
    assignmentSeats, futureEvents };
}
