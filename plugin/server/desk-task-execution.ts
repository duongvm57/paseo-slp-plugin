// Task-execution adapter — the supervised host/action orchestration for
// the native task workflow. Consumes Core's desk-task runners and entry
// accessors through the injected `task` seam and performs bounded
// host/Git/fs effects through the adapter seams. No adapter-owned tables,
// no state machine outside the ledger, no blind retries: every durable
// transition is committed by Core; every external effect is bounded and
// observed.

import { randomBytes } from "node:crypto";
import type {
  DeskRejectionValue, DeskTaskActionEntryValue,
  DeskTaskAttemptEntryValue, DeskTaskDispatchInputValue,
  DeskTaskEffectPermitValue, DeskTaskCheckRunRowValue, DeskTaskProofRecipeRowValue,
  DeskTaskIntegrateInputValue, DeskTaskMeasurePinValue, DeskTaskPlacementValue,
  DeskTaskReconcileInputValue, DeskTaskResultEntryValue, DeskTaskRuntimePinValue,
  DeskTaskSeatPinValue,
  DeskTaskDependencyObservationValue, DeskTaskIntegrationRecoveryPlanValue,
  DeskTaskIntegrationCleanupCandidateValue, DeskTaskIntegrationCleanupBundleValue,
  DeskTaskIntegrationCleanupResourcePinValue, DeskTaskIntegrationCleanupObservedResourceValue,
  DeskTaskIntegrationCleanupGitRegistrationValue, DeskTaskIntegrationEntryRefValue,
  DeskTaskIntegrationCleanupPermitValue, DeskTaskIntegrationCleanupVerificationValue,
} from "../shared/enforcement.ts";
import { WIRE_LIMITS, DeskTaskDependencyPin, DeskTaskPlacement, DeskTaskDependencyObservation,
  DeskTaskDispatchInput, DeskTaskIntegrateInput, DeskTaskReconcileInput, DeskTaskIntegrationRecoveryPlan,
  DeskTaskIntegrationCleanupCandidate, DeskTaskIntegrationCleanupBundle,
  DeskTaskIntegrationCleanupInventoryEntry, DeskTaskIntegrationCleanupResourcePin,
  DeskTaskIntegrationCleanupGitRegistration, DeskTaskIntegrationCleanupObserverResponse,
  DeskTaskIntegrationCleanupPermit, DeskTaskIntegrationCleanupVerification, DeskTaskIntegrationCleanupTrigger,
  DeskTaskIntegrationCleanupPreflightEvidence, DeskTaskIntegrationControlPins } from "../shared/enforcement.ts";
import {
  latestTask, latestTaskEntity, taskEntriesOf, type TaskObserver,
  type TaskRunnerDeps,
  type TaskDependencyObservation,
  taskIntegrationCleanupBundleBytes, taskIntegrationCleanupArtifactPath, taskIntegrationCleanupSourceControlDigest,
  taskIntegrationCleanupAdmissionSha256,
  type DeskTaskIntegrationCleanupObserverRequest, type DeskTaskIntegrationCleanupObserverResponse as CleanupObserverResponse,
} from "./desk-task.ts";
import type { TaskRuntimeBinding, TaskRuntimeSelection } from "./desk-task-runtime.ts";
import type { RunnerCtx } from "./desk-runner.ts";
import { readLedger, isRejection } from "./desk-runner.ts";
import type { DeskStore, LedgerValue, MembershipValue } from "./desk-store.ts";
import { DESK_TASK_CREATE_TICKET_KEY } from "./desk-seat.ts";
import type { MutationOutcome } from "./desk-handback.ts";
import { canonicalSha256, canonicalJson } from "./config-view.ts";
import {
  adapterPaths, applyDeltaToTarget, backupDeltaPaths, computeDelta,
  constrainDelta, expectedStageMap, materializeIsolatedPlacement,
  materializeStage, scanUnsupported, stageMatches,
  threeWay, DEFAULT_IO_LIMITS, planBackupDeltaPaths, backupManifestBytes, verifyBackupIntegrity,
  recoveryMapBytes, parseRecoveryMap, recoveryMapSha256, collectCleanupInventoryBytes,
} from "./desk-task-execution-git.ts";
import type { TaskIoLimits } from "./desk-task-execution-git.ts";
import {
  effectIdentity, sha256Hex, parseRepositoryMeasure, TaskMeasurementError, measureMapSha256,
} from "./desk-task-execution-host.ts";
import type {
  RepositoryMeasure, TaskBoundedExec, TaskFsIo, TaskGitIo, TaskHostApi,
  TaskMeasure,
} from "./desk-task-execution-host.ts";

// ---------------------------------------------------------------------------
// Consumed task-core seam — the real desk-task runner signatures. Production
// binds the module itself (`taskCoreApi`); tests inject doubles.
// ---------------------------------------------------------------------------

export type TaskCoreApi = Pick<typeof import("./desk-task.ts"), "runTaskCommand" | "runTaskEffect">;

export type { TaskObserver, TaskRunnerDeps };
export type TaskEffectPermit = DeskTaskEffectPermitValue;

// ---------------------------------------------------------------------------
// Adapter deps — production wiring supplies these; tests inject fixtures.
// ---------------------------------------------------------------------------

export type TaskExecutionDeps = {
  store: DeskStore;
  /** Core runners — production binds the desk-task module object. */
  task: TaskCoreApi;
  /** Connected SDK accessor (bridge paseoRef). */
  host: () => TaskHostApi | null;
  /** Git-aware measure (bounded child in production, direct snapshot in tests). */
  measure: TaskMeasure;
  /** Non-git scratch measure — the content-map kind. */
  measureContentMap?: TaskMeasure;
  /** Digested bounded argv — proof recipe runs. */
  exec: TaskBoundedExec;
  fs: TaskFsIo;
  git: TaskGitIo;
  /** Verified desk-owned root for placements/stage/backup/artifacts. */
  scratch: { stableRoot: string };
  /**
   * Typed routing resolution — the production binding is the task-runtime
   * resolver (desk-task-runtime): bound installed launch/routing ABI +
   * fresh providers.snapshot observation under the verified daemon home.
   * The adapter resolves before reservation and revalidates before
   * create; drift fails closed. Pool eligibility, decision receipts and
   * the quota-fallback pin stay inside the resolver.
   */
  resolveSeat(
    repository: string, selection: TaskRuntimeSelection, disposition?: string,
  ): Promise<TaskRuntimeBinding | DeskRejectionValue>;
  now?: () => Date;
  ioLimits?: Partial<TaskIoLimits>;
};

// ---------------------------------------------------------------------------
// Public input shapes — the strict shared wire schemas inferred. `phase`
// discriminates; each handler re-validates its required pins and narrows
// internally — no bridge casts.
// ---------------------------------------------------------------------------

/** Routing selection pin — the fresh eligible pool option + catalog sha,
 *  optionally carrying the verified Jev decision receipt and the designated
 *  quota-fallback source. */
export type TaskRuntimePin = DeskTaskRuntimePinValue;

/** Resolved seat binding — the resolver's output over the bound
 *  launch/routing ABI: base managed provider + model, mode, thinking,
 *  features, the routing echo (catalogFile/scope/decision state), and
 *  warnings. Type owned by desk-task-runtime. */
export type TaskResolvedSeat = TaskRuntimeBinding;

/** The durable seat pin — the strict shared shape including the resolved
 *  runtime tuple slots Core widened for route-drift revalidation. */
export type TaskSeatPin = DeskTaskSeatPinValue;

export type TaskPlacementRequest = DeskTaskPlacementValue;

export type TaskDispatchInput = DeskTaskDispatchInputValue;

export type TaskIntegrateInput = DeskTaskIntegrateInputValue;

export type TaskReconcileInput = DeskTaskReconcileInputValue;

const dispatchControlPins = (input: Extract<TaskDispatchInput, { phase: "send" | "archive" }>) => ({
  assignmentId: input.assignmentId, taskId: input.taskId,
  expectedLedgerRevision: input.expectedLedgerRevision, expectedBriefRevision: input.expectedBriefRevision,
  expectedOwnershipRevision: input.expectedOwnershipRevision, expectedTaskRevision: input.expectedTaskRevision,
  expectedAttemptRevision: input.expectedAttemptRevision,
});
const integrationControlPins = (input: Exclude<TaskIntegrateInput, { phase: "stage" }>) => ({
  assignmentId: input.assignmentId, taskId: input.taskId, resultId: input.resultId,
  expectedLedgerRevision: input.expectedLedgerRevision, expectedResultRevision: input.expectedResultRevision,
  expectedAdjudicationRevision: input.expectedAdjudicationRevision, expectedActionRevision: input.expectedActionRevision,
});

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

type Rejection = DeskRejectionValue;
const rejected = (code: DeskRejectionValue["code"], message: string, recovery: string): Rejection =>
  ({ ok: false, code, message, recovery });

const taskDeps = (ctx: RunnerCtx, deps: TaskExecutionDeps): TaskRunnerDeps => ({
  store: deps.store,
  observe: createTaskObserver(ctx, deps),
});

/** Fresh state gate — revalidated after every awaited host/Git call and
 *  before the next durable commit or external effect (Core §6). */
function recheck(deps: TaskExecutionDeps, ctx: RunnerCtx): Readonly<LedgerValue> | Rejection {
  return readLedger(deps, ctx.repoKey);
}

type AttemptStreamRow = DeskTaskAttemptEntryValue;
type IntegrationRow = DeskTaskActionEntryValue;
type ResultStreamRow = DeskTaskResultEntryValue;

/** One outer requestId fans out to several committed envelopes (reserve,
 *  intent, issue, observe, admit). The store's idempotency key is
 *  (actorKey, assignmentId, requestId) and a repeated requestId commits
 *  only an identical body — so every call site gets its own deterministic
 *  sub-request id derived from the outer requestId. Retrying the same
 *  outer call replays each leg under the same key; divergent receipts
 *  commit under different site keys instead of false conflicts. */
export const subRequestId = (outerRequestId: string, site: string): string =>
  outerRequestId.length + site.length < WIRE_LIMITS.deskRequestId
    ? `${outerRequestId}:${site}`
    : `request:${sha256Hex(JSON.stringify([outerRequestId, site]))}`;

function latestAttempt(ledger: Readonly<LedgerValue>, attemptId: string): AttemptStreamRow | null {
  const row = latestTaskEntity<AttemptStreamRow>(ledger, attemptId);
  return row !== undefined && row.kind === "attempt" ? row : null;
}

function latestIntegration(ledger: Readonly<LedgerValue>, actionId: string): IntegrationRow | null {
  const row = latestTaskEntity<IntegrationRow>(ledger, actionId);
  return row !== undefined && row.kind === "action" && row.actionKind === "integration" ? row : null;
}

const actionRows = (ledger: Readonly<LedgerValue>): IntegrationRow[] => {
  const latest = new Map<string, IntegrationRow>();
  for (const row of taskEntriesOf(ledger, "action")) {
    if (row.kind !== "action") continue;
    const prior = latest.get(row.actionId);
    if (prior === undefined || prior.revision < row.revision) latest.set(row.actionId, row);
  }
  return [...latest.values()];
};

const resultRows = (ledger: Readonly<LedgerValue>): ResultStreamRow[] =>
  taskEntriesOf(ledger, "result").filter((r): r is ResultStreamRow => r.kind === "result");

/** The exact registered membership row for a created seat — host-created
 *  or empty listings never satisfy this. */
function registeredMembership(
  ledger: Readonly<LedgerValue>,
  pin: { agentId: string; provider?: string; createCwd?: string; workspaceId: string | null },
): MembershipValue | null {
  const row = ledger.memberships.find(
    m => m.agentId === pin.agentId
      && (pin.provider === undefined || m.provider === pin.provider)
      && (pin.createCwd === undefined || m.createCwd === pin.createCwd)
      && m.workspaceId === pin.workspaceId,
  );
  if (row === undefined) return null;
  if (row.registeredAt === null || row.revokedAt !== null) return null;
  return row;
}

const stopHeld = (attempt: AttemptStreamRow): boolean =>
  attempt.state === "stop-requested" || attempt.stop.requested === true
  || attempt.state === "stopped" || attempt.state === "settled";

// ---------------------------------------------------------------------------
// runTaskDispatch — closed phases: bootstrap | reuse | send | archive.
// ---------------------------------------------------------------------------

export async function runTaskDispatch(
  ctx: RunnerCtx, input: TaskDispatchInput, deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  const parsed = DeskTaskDispatchInput.safeParse(input);
  if (!parsed.success) return rejected("INVALID_RECORD", "dispatch input failed strict phase validation", "supply the required phase fields and exact revision pins");
  input = parsed.data;
  try {
    switch (input.phase) {
      case "bootstrap": return await dispatchBootstrap(ctx, input, deps);
      case "reuse": return await dispatchReuse(ctx, input, deps);
      case "send": return await dispatchSend(ctx, input, deps);
      case "archive": return await dispatchArchive(ctx, input, deps);
    }
  } catch (error) {
    if (error instanceof TaskMeasurementError) return rejected(error.code, error.message, "provide complete supported repository proof");
    throw error;
  }
}

async function dispatchBootstrap(
  ctx: RunnerCtx,
  input: Extract<TaskDispatchInput, { phase: "bootstrap" }>,
  deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  const historical = await replayBootstrap(ctx, input, deps);
  if (historical !== null) return historical;
  const host = deps.host();
  if (host === null) return rejected("CAPABILITY_GAP", "the host SDK is not connected", "retry after the plugin context is connected");

  // 0. Routing resolution — the pool option resolves under the verified
  //    daemon home before anything is reserved. The resolved seat rides
  //    every durable pin; raw provider config never reaches create.
  const repository = await repoTopOf(ctx, deps);
  const resolved = await deps.resolveSeat(repository, input.runtime);
  if (isRejection(resolved)) return resolved;

  // 1. Reservation — Core commits the attempt, placement intent and the
  //    intent-time resource obligations under the store lock.
  const reserved = await deps.task.runTaskCommand(ctx, {
    operation: "reserve",
    requestId: subRequestId(input.requestId, "reserve"),
    assignmentId: input.assignmentId,
    taskId: input.taskId,
    grantRef: input.grantRef,
    expectedTaskRevision: input.expectedTaskRevision,
    expectedBriefRevision: input.expectedBriefRevision,
    expectedOwnershipRevision: input.expectedOwnershipRevision,
    expectedLedgerRevision: input.expectedLedgerRevision,
    placement: input.placement,
    runtime: input.runtime,
    seatPin: seatPinOf(resolved, input.runtime),
    reuseTarget: "new",
    effectBudget: input.effectBudget,
  }, taskDeps(ctx, deps));
  if (isRejection(reserved)) return reserved;
  const attemptId = typeof reserved.attemptId === "string" ? reserved.attemptId : null;
  if (attemptId === null) return rejected("CAPABILITY_GAP", "reserve committed but returned no attemptId", "replay the same requestId");

  // The reservation mints the place action as `intended` — the durable
  // admission for every placement effect. No minted action means the
  // reservation committed half its contract: fail closed, never
  // materialize without authority.
  const placementActionId = reserved.next?.actionId ?? null;
  if (placementActionId === null) {
    return rejected("CAPABILITY_GAP", "reserve committed no place action", "replay the same requestId — the replay rebuilds the reservation");
  }
  let placementCwd: string;
  let sourceBaseMeasure: RepositoryMeasure | null = null;
  let baseArtifactSha: string | null = null;

  // 2. Placement materialization — shared-checkout verifies the desk
  //    binding; isolated materializes a desk-owned worktree. Native
  //    daemon-side placements were rejected at schema/preflight.
  const issuedPlace = await deps.task.runTaskEffect(ctx, {
    operation: "issue", requestId: subRequestId(input.requestId, "place-issue"),
    attemptId, actionId: placementActionId, actionKind: "place",
  }, taskDeps(ctx, deps));
  if (isRejection(issuedPlace)) return issuedPlace;
  if (issuedPlace.perform === false) return { ok: true, attemptId, state: "reserved", perform: false };

  if (input.placement.kind === "isolated") {
    const fresh = recheck(deps, ctx);
    if (isRejection(fresh)) return fresh;
    if (typeof input.placement.baseRef !== "string" || input.placement.baseRef === "") {
      return rejected("INVALID_RECORD", "isolated placement requires a baseRef", "name the revision the worktree forks from");
    }
    const scratchDir = adapterPaths(deps.scratch.stableRoot, ctx.repoKey).placements(attemptId);
    const repoRoot = await repoTopOf(ctx, deps);
    let placed: { cwd: string; commonDir: string; head: string | null };
    try {
      placed = await materializeIsolatedPlacement({
        fs: deps.fs, git: deps.git, repoRoot,
        scratchDir, baseRef: input.placement.baseRef,
      });
    } catch (error) {
      const failure = await deps.task.runTaskEffect(ctx, {
        operation: "observe", requestId: subRequestId(input.requestId, "place-observe-fail"), attemptId,
        actionId: placementActionId, actionKind: "place",
        receipt: { status: "failed", error: String((error as Error).message).slice(0, 512) },
      }, taskDeps(ctx, deps));
      if (isRejection(failure)) return failure;
      return rejected("CAPABILITY_GAP", `isolated placement failed: ${(error as Error).message.slice(0, 256)}`, "inspect the recorded failure");
    }
    placementCwd = placed.cwd;
    sourceBaseMeasure = await deps.measure(placementCwd);
    const referenceGap = await referenceBaseGap(ctx, deps, attemptId, sourceBaseMeasure);
    if (referenceGap !== null) {
      const held = await deps.task.runTaskEffect(ctx, {
        operation: "observe", requestId: subRequestId(input.requestId, "place-observe-reference-held"),
        attemptId, actionId: placementActionId, actionKind: "place",
        receipt: { status: "held", reason: referenceGap, cwd: placementCwd,
          mapSha256: measureMapSha256(sourceBaseMeasure), gitCommonDir: placed.commonDir, resolvedHead: placed.head },
      }, taskDeps(ctx, deps));
      if (isRejection(held)) return held;
      return { ok: true, attemptId, held: referenceGap, state: "held", placementCwd };
    }
    baseArtifactSha = persistMeasureArtifact(deps, ctx.repoKey, `attempts/${attemptId}`, "base", sourceBaseMeasure).artifactSha256;
    const observedPlace = await deps.task.runTaskEffect(ctx, {
      operation: "observe", requestId: subRequestId(input.requestId, "place-observe"), attemptId,
      actionId: placementActionId, actionKind: "place",
      receipt: {
        status: "observed", cwd: placementCwd,
        base: { ...pinOf(sourceBaseMeasure), artifactSha256: baseArtifactSha },
        artifactSha256: baseArtifactSha, commonDir: placed.commonDir,
        gitCommonDir: placed.commonDir, resolvedHead: placed.head,
        mapSha256: measureMapSha256(sourceBaseMeasure),
      },
    }, taskDeps(ctx, deps));
    if (isRejection(observedPlace)) return observedPlace;
  } else {
    const fresh = recheck(deps, ctx);
    if (isRejection(fresh)) return fresh;
    if (typeof input.placement.cwd !== "string" || input.placement.cwd === "") {
      return rejected("INVALID_RECORD", "shared-checkout placement requires a cwd", "supply the checkout path to verify");
    }
    let shared: string;
    try { shared = deps.fs.realpath(input.placement.cwd); }
    catch {
      return rejected("SCOPE_CONFLICT", "the shared checkout does not resolve inside the allowed roots", "choose a checkout of the desk repo");
    }
    const ledger = readLedger(deps, ctx.repoKey);
    if (isRejection(ledger)) return ledger;
    const common = await deps.git.commonDir(shared).catch(() => null);
    if (common === null || common !== ledger.repo.gitCommonDir) {
      return rejected("SCOPE_CONFLICT", "the shared checkout is not bound to this desk's repository", "choose a checkout of the desk repo");
    }
    placementCwd = shared;
    sourceBaseMeasure = await deps.measure(placementCwd);
    baseArtifactSha = persistMeasureArtifact(deps, ctx.repoKey, `attempts/${attemptId}`, "base", sourceBaseMeasure).artifactSha256;
    const observedPlace = await deps.task.runTaskEffect(ctx, {
      operation: "observe", requestId: subRequestId(input.requestId, "place-observe"), attemptId,
      actionId: placementActionId, actionKind: "place",
      receipt: {
        status: "observed", cwd: placementCwd,
        base: { ...pinOf(sourceBaseMeasure), artifactSha256: baseArtifactSha },
        artifactSha256: baseArtifactSha,
      },
    }, taskDeps(ctx, deps));
    if (isRejection(observedPlace)) return observedPlace;
  }

  // 3. Bootstrap create — no work prompt anywhere. Intent → issue →
  //    create → verify → observe. Workspace-bound create is preferred
  //    when the exact workspace descriptor is known.
  const labels = {
    "slp.repo": ctx.repoKey,
    "slp.task": input.taskId,
    "slp.attempt": attemptId,
    "slp.assignment": input.assignmentId,
  };
  const idempotencyKey = effectIdentity("create", input.requestId);
  const hostRequestId = effectIdentity("host-create", input.requestId);

  // Routing revalidation — the pool option must still resolve to the same
  // seat tuple the reservation pinned. Drift fails closed: a seat created
  // under a shifted catalog is never the one we committed.
  const reResolved = await deps.resolveSeat(repository, input.runtime);
  if (isRejection(reResolved)) return reResolved;
  const drift = seatDrift(resolved, reResolved);
  if (drift !== null) {
    return rejected("ROUTE_DRIFT", `routing resolution drifted on ${drift} between reservation and create`, "re-read routes and dispatch against a fresh catalog");
  }

  const createHistory = recheck(deps, ctx);
  if (isRejection(createHistory)) return createHistory;
  const originalCreate = taskEntriesOf(createHistory, "action").find(row => row.kind === "action"
    && row.requestId === subRequestId(input.requestId, "create-intent") && row.actorAgentId === ctx.row.agentId
    && row.actorMembershipId === ctx.row.membershipId && row.assignmentId === input.assignmentId && row.attemptId === attemptId
    && row.actionKind === "create");
  if (originalCreate?.kind === "action" && originalCreate.body === null) return rejected("CAPABILITY_GAP", "historical create intent lacks its immutable body", "retain the exact action and reconcile; never retrofit host claim pins");
  // The original intent is immutable. A lost private ticket cannot be
  // reconstructed from its digest or replaced on a historical invocation.
  const createTicket = originalCreate === undefined ? randomBytes(32).toString("hex") : null;

  const createIntent = await deps.task.runTaskEffect(ctx, {
    operation: "intent", requestId: subRequestId(input.requestId, "create-intent"), attemptId,
    actionKind: "create",
    body: originalCreate?.kind === "action" ? originalCreate.body! : {
      runtime: input.runtime, seat: seatPinOf(resolved, input.runtime),
      placement: { cwd: placementCwd, kind: input.placement.kind },
      sourceBase: { ...pinOf(sourceBaseMeasure), artifactSha256: baseArtifactSha },
      idempotencyKey, hostRequestId, labels, createTicketSha256: sha256Hex(createTicket!),
      publicRequestId: input.requestId, publicRequestSha256: canonicalSha256(input),
      parent: ctx.row.agentId, grantRef: input.grantRef,
      resourceIntents: ["agent-archive", "membership", ...(input.placement.kind === "isolated" ? ["worktree-remove"] : [])],
    },
  }, taskDeps(ctx, deps));
  if (isRejection(createIntent)) return createIntent;
  const createActionId = createIntent.actionId ?? null;
  if (createActionId === null) return rejected("CAPABILITY_GAP", "the create intent committed but returned no actionId", "replay the same requestId");

  const issue = await deps.task.runTaskEffect(ctx, {
    operation: "issue", requestId: subRequestId(input.requestId, "create-issue"), attemptId,
    actionId: createActionId, actionKind: "create",
  }, taskDeps(ctx, deps));
  if (isRejection(issue)) return issue;
  if (issue.perform === false) return { ok: true, attemptId, state: "create-issued", perform: false };
  if (createTicket === null) return rejected("CAPABILITY_GAP", "the original create ticket is unavailable", "retain the exact issued create; explicitly reconcile known native creation or settle supported obligations without resubmitting create");
  if (originalCreate?.kind === "action" && originalCreate.body?.hostRequestId !== hostRequestId) {
    return rejected("CAPABILITY_GAP", "legacy create has no exact host request claim pin", "retain historical body/credit; do not retrofit a claim or repeat the create");
  }

  let agentId: string | null = null;
  let createError: string | null = null;
  try {
    agentId = await createSeat(host, input, input.placement, resolved, placementCwd, ctx,
      { ...labels, "slp.create-action": createActionId }, idempotencyKey, hostRequestId, createTicket);
  } catch (error) {
    createError = privateCreateError(error, createTicket, 512);
  }
  const freshAfterCreate = recheck(deps, ctx);
  if (isRejection(freshAfterCreate)) return freshAfterCreate;

  if (createError !== null || agentId === null) {
    const observedFailure = await deps.task.runTaskEffect(ctx, {
      operation: "observe", requestId: subRequestId(input.requestId, "create-observe-uncertain"), attemptId,
      actionId: createActionId, actionKind: "create",
      receipt: { status: "uncertain", error: createError ?? "create returned no handle" },
    }, taskDeps(ctx, deps));
    if (isRejection(observedFailure)) return observedFailure;
    return { ok: true, attemptId, state: "uncertain", error: createError };
  }

  // 4. Post-create verification — the returned handle is not writable;
  //    every claimed pin is re-read from the host.
  const verification = await verifySeat(host, agentId, {
    provider: resolved.provider, model: resolved.model ?? null, cwd: placementCwd,
    workspaceId: input.placement.workspaceId ?? null, parent: ctx.row.agentId ?? null,
    modeId: resolved.modeId ?? null, thinkingOptionId: resolved.thinkingOptionId ?? null,
    features: resolved.features ?? null,
    labels: { ...labels, "slp.create-action": createActionId },
  }, createTicket);
  const observedCreate = await deps.task.runTaskEffect(ctx, {
    operation: "observe", requestId: subRequestId(input.requestId, "create-observe"), attemptId,
    actionId: createActionId, actionKind: "create",
    receipt: {
      status: verification.ok ? "observed" : "uncertain",
      agentId, verification,
    },
  }, taskDeps(ctx, deps));
  if (isRejection(observedCreate)) return observedCreate;
  if (!verification.ok) {
    return { ok: true, attemptId, agentId, state: "uncertain", verification };
  }

  // 5. Bind — exact registered membership + valid moving scope, under the
  //    Core lock. Not yet registered ⇒ seat-pending, never a re-create.
  const bound = await tryBind(ctx, deps, {
    attemptId, agentId, provider: resolved.provider,
    createCwd: placementCwd, workspaceId: input.placement.workspaceId ?? null,
    requestId: subRequestId(input.requestId, "bind"),
  });
  if (isRejection(bound)) return bound;
  return {
    ok: true, attemptId, agentId,
    state: bound.bound ? "bound" : "seat-pending",
    workspaceId: verification.workspaceId ?? null,
  };
}

async function replayBootstrap(
  ctx: RunnerCtx, input: Extract<TaskDispatchInput, {phase: "bootstrap"}>, deps: TaskExecutionDeps,
): Promise<MutationOutcome | null> {
  const ledger = readLedger(deps, ctx.repoKey); if (isRejection(ledger)) return ledger;
  const reserveId = subRequestId(input.requestId, "reserve");
  const prior = ledger.requests?.find(record => record.actorKey === `agent:${ctx.row.agentId}`
    && record.assignmentId === input.assignmentId && record.requestId === reserveId);
  if (prior === undefined) return null;
  const original = taskEntriesOf(ledger, "attempt").find(row => row.kind === "attempt" && row.requestId === reserveId
    && row.actorAgentId === ctx.row.agentId && row.actorMembershipId === ctx.row.membershipId
    && row.assignmentId === input.assignmentId && row.taskId === input.taskId && row.revision === 1);
  if (original?.kind !== "attempt") return rejected("ACTOR_MISMATCH", "the original reservation has no exact caller/task revision", "retain the historical reservation and reconcile its original actor lineage");
  // Core owns live membership/openGeneration and the canonical original
  // request hash. No historical generation or canonical command is mirrored.
  const reserved = await deps.task.runTaskCommand(ctx, {
    operation: "reserve", requestId: reserveId, assignmentId: input.assignmentId, taskId: input.taskId,
    grantRef: input.grantRef, expectedTaskRevision: input.expectedTaskRevision,
    expectedBriefRevision: input.expectedBriefRevision, expectedOwnershipRevision: input.expectedOwnershipRevision,
    expectedLedgerRevision: input.expectedLedgerRevision, placement: input.placement, runtime: input.runtime,
    seatPin: original.seatPin, reuseTarget: "new", effectBudget: input.effectBudget,
  }, taskDeps(ctx, deps));
  if (isRejection(reserved)) return reserved;
  if (reserved.replayed !== true || reserved.attemptId !== original.attemptId) return rejected("CAPABILITY_GAP", "the original reservation did not replay exactly", "retain the recorded reservation; no new placement or create follows");
  const create = taskEntriesOf(ledger, "action").find(row => row.kind === "action" && row.actionKind === "create"
    && row.requestId === subRequestId(input.requestId, "create-intent") && row.actorAgentId === ctx.row.agentId
    && row.actorMembershipId === ctx.row.membershipId && row.assignmentId === input.assignmentId
    && row.taskId === input.taskId && row.attemptId === original.attemptId);
  if (create?.kind !== "action" || typeof create.body?.publicRequestId !== "string"
    || typeof create.body.publicRequestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(create.body.publicRequestSha256)) {
    return rejected("CAPABILITY_GAP", "historical bootstrap lacks its original complete public CREATE context", "retain the partial or legacy reservation; explicitly reconcile or settle supported obligations without issuing placement or retrying create");
  }
  if (create.body.publicRequestId !== input.requestId || create.body.publicRequestSha256 !== canonicalSha256(input)) {
    return rejected("IDEMPOTENCY_CONFLICT", "bootstrap differs from its immutable original public CREATE context", "resend the exact original request; never replace its title, pins or private carrier");
  }
  const issueId = subRequestId(input.requestId, "place-issue");
  const issueRequest = ledger.requests?.find(record => record.actorKey === `agent:${ctx.row.agentId}`
    && record.assignmentId === input.assignmentId && record.requestId === issueId && record.outcome === "committed");
  const place = taskEntriesOf(ledger, "action").find(row => row.kind === "action" && row.actionKind === "place"
    && row.requestId === issueId && row.state === "issued" && row.actorAgentId === ctx.row.agentId
    && row.actorMembershipId === ctx.row.membershipId && row.assignmentId === input.assignmentId && row.attemptId === original.attemptId);
  if (issueRequest === undefined || place?.kind !== "action") return rejected("CAPABILITY_GAP", "historical bootstrap has no exact recorded placement ISSUE", "retain the intended place; historical replay cannot issue a new permit");
  const issued = await deps.task.runTaskEffect(ctx, {operation: "issue", requestId: issueId,
    attemptId: original.attemptId, actionId: place.actionId, actionKind: "place"}, taskDeps(ctx, deps));
  if (isRejection(issued)) return issued;
  if (issued.perform !== false || issued.replayed !== true) return rejected("CAPABILITY_GAP", "recorded placement ISSUE did not replay without a permit", "retain the original action; no external effect follows this historical replay");
  const sites = new Set(["reserve", "place-observe", "place-observe-reference-held", "create-observe", "create-observe-uncertain", "bind"]
    .map(site => subRequestId(input.requestId, site)));
  const recordedAttempt = taskEntriesOf(ledger, "attempt").filter(row => row.kind === "attempt" && row.attemptId === original.attemptId
    && row.actorAgentId === ctx.row.agentId && row.actorMembershipId === ctx.row.membershipId && sites.has(row.requestId)).at(-1);
  const recordedCreate = taskEntriesOf(ledger, "action").filter(row => row.kind === "action" && row.actionId === create.actionId
    && row.actorAgentId === ctx.row.agentId && row.actorMembershipId === ctx.row.membershipId
    && (sites.has(row.requestId) || row.requestId === create.requestId || row.requestId === subRequestId(input.requestId, "create-issue"))).at(-1);
  return {ok: true, attemptId: original.attemptId, state: "historical-replay", perform: false, replayed: true,
    recordedAttemptState: recordedAttempt?.kind === "attempt" ? recordedAttempt.state : original.state,
    recordedAttemptRevision: recordedAttempt?.revision ?? original.revision,
    recordedPhase: "create", recordedActionState: recordedCreate?.kind === "action" ? recordedCreate.state : create.state,
    ...(recordedCreate?.kind === "action" && recordedCreate.state === "observed" ? {} : {
      gap: "private-create-ticket-unavailable",
      recovery: "retain the recorded create/claim/resource uncertainty; explicitly reconcile known native creation or supported settlement without regenerating the ticket or resubmitting create",
    })};
}

/** The durable seat pin — routing selection + resolved provider/model. */
const seatPinOf = (seat: TaskRuntimeBinding, runtime: TaskRuntimePin): TaskSeatPin => ({
  provider: seat.provider, model: seat.model ?? null,
  optionId: runtime.optionId, catalogSha256: runtime.catalogSha256,
  ...(seat.modeId != null ? { modeId: seat.modeId } : {}),
  ...(seat.thinkingOptionId != null ? { thinkingOptionId: seat.thinkingOptionId } : {}),
  ...(seat.features != null ? { features: seat.features } : {}),
});

/** Tuple drift between the reservation pin and the pre-create re-resolve. */
const seatDrift = (a: TaskRuntimeBinding, b: TaskRuntimeBinding): string | null => {
  for (const key of ["provider", "model", "modeId", "thinkingOptionId"] as const) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return key;
  }
  if (canonicalSha256(a.features ?? {}) !== canonicalSha256(b.features ?? {})) return "features";
  return null;
};

async function createSeat(
  host: TaskHostApi,
  input: Extract<TaskDispatchInput, { phase: "bootstrap" }>,
  placement: DeskTaskPlacementValue,
  resolved: TaskResolvedSeat,
  placementCwd: string,
  ctx: RunnerCtx,
  labels: Record<string, string>,
  idempotencyKey: string,
  hostRequestId: string,
  createTicket: string,
): Promise<string> {
  const config = {
    // provider/model join matches the launch binding convention.
    provider: resolved.model ? `${resolved.provider}/${resolved.model}` : resolved.provider,
    ...(resolved.modeId != null ? { modeId: resolved.modeId } : {}),
    ...(resolved.thinkingOptionId != null ? { thinkingOptionId: resolved.thinkingOptionId } : {}),
    ...(resolved.features != null ? { featureValues: resolved.features } : {}),
  };
  const base = {
    config, ...(ctx.row.agentId !== null ? { parent: ctx.row.agentId } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    labels, idempotencyKey, requestId: hostRequestId, env: { [DESK_TASK_CREATE_TICKET_KEY]: createTicket },
  };
  const workspaceId = placement.workspaceId;
  if (workspaceId !== undefined && placement.kind === "shared-checkout") {
    const handle = await host.workspaces.ref(workspaceId).agents.create(base);
    return handle.id;
  }
  const handle = await host.agents.create({ ...base, cwd: placementCwd });
  return handle.id;
}

type SeatVerification = {
  ok: boolean;
  mismatches: string[];
  workspaceId?: string | null;
  parent?: string | null;
};

const privateCreateError = (error: unknown, ticket: string | null, limit: number): string => {
  const message = error instanceof Error ? error.message : String(error);
  return (ticket === null ? message : message.replaceAll(ticket, "[REDACTED]")).slice(0, limit);
};

/** Exact original managed-create labels. Reused seats have no new create
 * lineage; a managed attempt with missing provenance fails closed. */
function managedCreateLabels(
  ledger: Readonly<LedgerValue>, attempt: AttemptStreamRow, repoKey: string,
): Record<string, string> | null | undefined {
  if (attempt.reuseTarget !== null && attempt.reuseTarget !== undefined) return undefined;
  const create = taskEntriesOf(ledger, "action").find(row => row.kind === "action" && row.actionKind === "create"
    && row.attemptId === attempt.attemptId && row.assignmentId === attempt.assignmentId && row.taskId === attempt.taskId);
  if (create?.kind !== "action") return null;
  const labels = create.body?.labels;
  const expected = {"slp.repo": repoKey, "slp.task": attempt.taskId, "slp.attempt": attempt.attemptId,
    "slp.assignment": attempt.assignmentId, "slp.create-action": create.actionId};
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)
    || Object.entries(expected).some(([key, value]) => key !== "slp.create-action"
      && !Object.entries(labels).some(([storedKey, storedValue]) => storedKey === key && storedValue === value))) return null;
  return expected;
}

/** Required evidence semantics: a field the snapshot does not report is
 *  missing evidence — uncertain — never an exact verified tuple. Optional
 *  pins verify only when a value was requested, but a request without
 *  reported evidence still fails closed. */
async function verifySeat(
  host: TaskHostApi, agentId: string,
  pin: {
    provider: string; model: string | null; cwd: string;
    workspaceId: string | null; parent: string | null;
    modeId?: string | null; thinkingOptionId?: string | null;
    features?: Record<string, unknown> | null;
    labels?: Readonly<Record<string, string>> | null;
  },
  privateTicket: string | null = null,
): Promise<SeatVerification> {
  let refetched;
  try { refetched = await host.agents.ref(agentId).refresh(); }
  catch (error) { return { ok: false, mismatches: [`refresh-failed:${privateCreateError(error, privateTicket, 128)}`] }; }
  const agent = refetched?.agent ?? null;
  if (agent === null) {
    return { ok: false, mismatches: ["refresh returned no agent snapshot"] };
  }
  const mismatches: string[] = [];
  if (pin.labels === null) mismatches.push("label:create-provenance-unavailable");
  else for (const [key, value] of Object.entries(pin.labels ?? {})) {
    if (agent.labels?.[key] !== value) mismatches.push(`label:${key}:mismatch`);
  }
  if (agent.id !== agentId) mismatches.push(`agentId:${agent.id ?? "unreported"}`);
  if (agent.provider !== pin.provider) {
    mismatches.push(`provider:${agent.provider ?? "unreported"}`);
  }
  if (agent.cwd !== pin.cwd) {
    mismatches.push(`cwd:${agent.cwd ?? "unreported"}`);
  }
  if (agent.model === undefined || agent.model !== pin.model) {
    mismatches.push(`model:${agent.model === undefined ? "unreported" : agent.model}`);
  }
  if (pin.workspaceId !== null) {
    if (agent.workspaceId !== pin.workspaceId) {
      mismatches.push(`workspaceId:${agent.workspaceId ?? "unreported"}`);
    }
  } else if (agent.workspaceId !== null) {
    mismatches.push(`workspaceId:${agent.workspaceId ?? "unreported"}`);
  }
  // The parent label is the only snapshot-side parent evidence.
  const parentLabel = agent.labels?.["paseo.parent-agent-id"] ?? null;
  if (pin.parent !== null) {
    if (parentLabel !== pin.parent) {
      mismatches.push(`parent:${parentLabel ?? "unreported"}`);
    }
  } else if (parentLabel !== null) {
    mismatches.push(`parent:${parentLabel}`);
  }
  // Requested runtime tuple — verified against the snapshot's applied
  // fields; a seat that can't report the request is not the bound seat.
  if (pin.modeId != null && agent.currentModeId !== pin.modeId) {
    mismatches.push(`mode:${agent.currentModeId === undefined ? "unreported" : agent.currentModeId}`);
  }
  if (pin.thinkingOptionId != null) {
    const reported = agent.thinkingOptionId ?? agent.effectiveThinkingOptionId;
    if (reported !== pin.thinkingOptionId) {
      mismatches.push(`thinking:${reported == null ? "unreported" : reported}`);
    }
  }
  const wantedFeatures = pin.features ?? null;
  if (wantedFeatures !== null && Object.keys(wantedFeatures).length > 0) {
    if (agent.features === undefined) {
      mismatches.push("features:unreported");
    } else {
      for (const [id, value] of Object.entries(wantedFeatures)) {
        const entry = agent.features.find(f => f.id === id);
        if (entry === undefined) mismatches.push(`feature:${id}:absent`);
        else if (entry.value !== value) mismatches.push(`feature:${id}:${String(entry.value)}`);
      }
    }
  }
  if (agent.archivedAt !== null) {
    mismatches.push(`archivedAt:${agent.archivedAt ?? "unreported"}`);
  }
  return {
    ok: mismatches.length === 0,
    mismatches: privateTicket === null ? mismatches : mismatches.map(value => value.replaceAll(privateTicket, "[REDACTED]")),
    workspaceId: agent.workspaceId ?? null, parent: parentLabel,
  };
}

/** Exact registered membership + valid scope under Core's lock — the only
 *  path from created to writable. */
async function tryBind(
  ctx: RunnerCtx, deps: TaskExecutionDeps,
  pin: {
    attemptId: string; agentId: string; provider?: string;
    createCwd: string; workspaceId: string | null; requestId: string;
  },
): Promise<{ bound: true } | { bound: false; reason: string } | Rejection> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const membership = registeredMembership(ledger, {
    agentId: pin.agentId, provider: pin.provider,
    createCwd: pin.createCwd, workspaceId: pin.workspaceId,
  });
  if (membership === null) {
    return { bound: false, reason: "registered-membership-absent" };
  }
  const result = await deps.task.runTaskEffect(ctx, {
    operation: "bind", requestId: pin.requestId, attemptId: pin.attemptId,
    member: { agentId: membership.agentId, membershipId: membership.membershipId },
    observed: {
      provider: pin.provider, createCwd: pin.createCwd,
      workspaceId: pin.workspaceId,
    },
  }, taskDeps(ctx, deps));
  if (isRejection(result)) return result;
  return { bound: true };
}

async function dispatchReuse(
  ctx: RunnerCtx,
  input: Extract<TaskDispatchInput, { phase: "reuse" }>,
  deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  const host = deps.host();
  if (host === null) return rejected("CAPABILITY_GAP", "the host SDK is not connected", "retry after the plugin context is connected");
  const ledger = recheck(deps, ctx);
  if (isRejection(ledger)) return ledger;

  // Routing resolution — reuse binds an existing seat to the pool option,
  // so the option resolves under the verified daemon home first.
  const repository = await repoTopOf(ctx, deps);
  const resolved = await deps.resolveSeat(repository, input.runtime);
  if (isRejection(resolved)) return resolved;

  // Eligibility reads the live seat BEFORE anything reserves — every
  // check fails closed to SEAT_INELIGIBLE with zero sends, and a field
  // the snapshot does not report is missing evidence, never a match.
  if (input.reuseTarget === undefined || typeof input.reuseTarget.agentId !== "string" || input.reuseTarget.agentId === "") {
    return rejected("INVALID_RECORD", "reuse requires a reuseTarget agent pin", "name the existing seat to bind");
  }
  const refetched = await host.agents.ref(input.reuseTarget.agentId).refresh();
  const agent = refetched?.agent ?? null;
  const ineligible = (reason: string) =>
    rejected("SEAT_INELIGIBLE", `reuse target fails eligibility: ${reason}`, "choose another seat or create a fresh one");
  if (agent === null) return ineligible("agent refresh returned no snapshot");
  if (agent.archivedAt === undefined) return ineligible("archive-state-unreported");
  if (agent.archivedAt !== null) return ineligible("archived");
  if (agent.status == null) return ineligible("status-unreported");
  if (agent.status !== "idle") return ineligible(`status:${agent.status}`);
  if (agent.activeTurn === undefined) return ineligible("active-turn-unreported");
  if (agent.activeTurn !== null) return ineligible("active turn");
  if (agent.cwd === undefined || agent.cwd === null) return ineligible("cwd-unreported");
  // Placement: an asserted cwd compares exact-realpath; an absent pin
  // still requires the seat to sit inside this desk's repository.
  let cwd = agent.cwd;
  if (typeof input.placement?.cwd === "string" && input.placement.cwd !== "") {
    let want: string;
    try { want = deps.fs.realpath(input.placement.cwd); }
    catch { return ineligible("cwd-unresolvable"); }
    if (agent.cwd !== want) return ineligible("cwd");
    cwd = want;
  } else {
    const common = await deps.git.commonDir(agent.cwd).catch(() => null);
    if (common === null || common !== ledger.repo.gitCommonDir) return ineligible("cwd-desk");
  }
  if (agent.provider === undefined || agent.provider === null) return ineligible("provider-unreported");
  if (agent.provider !== resolved.provider) return ineligible("provider");
  if (agent.model === undefined) return ineligible("model-unreported");
  if ((agent.model ?? null) !== (resolved.model ?? null)) return ineligible("model");
  const parentLabel = agent.labels?.["paseo.parent-agent-id"] ?? null;
  if (ctx.row.agentId !== null) {
    if (parentLabel !== ctx.row.agentId) return ineligible(parentLabel === null ? "parent-route-unreported" : "parent-route");
  } else if (parentLabel !== null) return ineligible("parent-route");
  const verified = await verifySeat(host, input.reuseTarget.agentId, {
    provider: resolved.provider, model: resolved.model ?? null, cwd,
    workspaceId: input.placement.workspaceId ?? null, parent: ctx.row.agentId,
    modeId: resolved.modeId, thinkingOptionId: resolved.thinkingOptionId, features: resolved.features,
  });
  if (!verified.ok) return ineligible(verified.mismatches.join(","));

  const reserved = await deps.task.runTaskCommand(ctx, {
    operation: "reserve",
    requestId: subRequestId(input.requestId, "reserve"),
    assignmentId: input.assignmentId,
    taskId: input.taskId,
    grantRef: input.grantRef,
    expectedTaskRevision: input.expectedTaskRevision,
    expectedBriefRevision: input.expectedBriefRevision,
    expectedOwnershipRevision: input.expectedOwnershipRevision,
    expectedLedgerRevision: input.expectedLedgerRevision,
    placement: { kind: "shared-checkout", cwd, ...(agent.workspaceId != null ? { workspaceId: agent.workspaceId } : {}) },
    runtime: input.runtime,
    seatPin: seatPinOf(resolved, input.runtime),
    reuseTarget: { agentId: input.reuseTarget.agentId },
    effectBudget: input.effectBudget,
  }, taskDeps(ctx, deps));
  if (isRejection(reserved)) return reserved;
  const attemptId = typeof reserved.attemptId === "string" ? reserved.attemptId : null;
  if (attemptId === null) return rejected("CAPABILITY_GAP", "reserve committed but returned no attemptId", "replay the same requestId");

  // The reserved place action is issued + observed so the attempt carries
  // the durable placement cwd and BASE measure pin — integration reads
  // them from the committed row, never from re-derivation.
  const placeActionId = reserved.next?.actionId ?? null;
  if (placeActionId === null) {
    return rejected("CAPABILITY_GAP", "reserve committed no place action", "replay the same requestId");
  }
  const issuedPlace = await deps.task.runTaskEffect(ctx, {
    operation: "issue", requestId: subRequestId(input.requestId, "place-issue"),
    attemptId, actionId: placeActionId, actionKind: "place",
  }, taskDeps(ctx, deps));
  if (isRejection(issuedPlace)) return issuedPlace;
  if (issuedPlace.perform === false) return { ok: true, attemptId, state: "reserved", perform: false };
  const reuseBaseMeasure = await deps.measure(cwd);
  const reuseArtifactSha = persistMeasureArtifact(deps, ctx.repoKey, `attempts/${attemptId}`, "base", reuseBaseMeasure).artifactSha256;
  const observedPlace = await deps.task.runTaskEffect(ctx, {
    operation: "observe", requestId: subRequestId(input.requestId, "place-observe"),
    attemptId, actionId: placeActionId, actionKind: "place",
    receipt: {
      status: "observed", cwd,
      base: { ...pinOf(reuseBaseMeasure), artifactSha256: reuseArtifactSha },
      artifactSha256: reuseArtifactSha,
    },
  }, taskDeps(ctx, deps));
  if (isRejection(observedPlace)) return observedPlace;

  const bound = await tryBind(ctx, deps, {
    attemptId, agentId: input.reuseTarget.agentId, provider: resolved.provider,
    createCwd: cwd, workspaceId: agent.workspaceId ?? null,
    requestId: subRequestId(input.requestId, "bind"),
  });
  if (isRejection(bound)) return bound;
  return {
    ok: true, attemptId, agentId: input.reuseTarget.agentId,
    state: bound.bound ? "bound" : "seat-pending",
  };
}

async function dispatchSend(
  ctx: RunnerCtx,
  input: Extract<TaskDispatchInput, { phase: "send" }>,
  deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  const host = deps.host();
  if (host === null) return rejected("CAPABILITY_GAP", "the host SDK is not connected", "retry after the plugin context is connected");
  if (input.attemptId === null) return rejected("INVALID_RECORD", "send requires an attempt pin", "dispatch reserves attempts before sends");
  if (typeof input.text !== "string" || input.text === "") {
    return rejected("INVALID_RECORD", "send requires a text body", "supply the message to dispatch");
  }
  const attemptId = input.attemptId;
  const ledger = recheck(deps, ctx);
  if (isRejection(ledger)) return ledger;
  const attempt = latestAttempt(ledger, attemptId);
  if (attempt === null) return rejected("ACTOR_MISMATCH", `unknown attempt ${attemptId}`, "dispatch reserves attempts before sends");
  if (stopHeld(attempt)) return rejected("STOP_REQUESTED", "the attempt is stop-requested", "reconcile before any new effect");
  if (attempt.member === null || !["bound", "dispatched", "running"].includes(attempt.state)) {
    return { ok: true, attemptId, state: "seat-pending", sent: false,
      recovery: "invoke slp_task_reconcile with this attemptId and action observation, then reload exact pins before send" };
  }
  const agentId = attempt.host.agentId ?? null;
  if (agentId === null) return { ok: true, attemptId, state: "seat-pending", sent: false };
  if (attempt.runtime === null) return rejected("ROUTE_DRIFT", "the attempt has no pinned runtime selection", "retain the attempt and reconcile its routing evidence");
  const resolved = await deps.resolveSeat(await repoTopOf(ctx, deps), attempt.runtime);
  if (isRejection(resolved)) return resolved;
  const pinnedSeat = seatPinOf(resolved, attempt.runtime);
  if (canonicalSha256(pinnedSeat) !== canonicalSha256(attempt.seatPin)) {
    return rejected("ROUTE_DRIFT", "the runtime selection differs from the reserved seat tuple", "retain the reservation and reconcile the catalog/runtime pins");
  }
  if (attempt.placement.kind === "isolated") {
    const base = await readBaseMeasure(deps, ctx, attempt);
    if (base === null) return rejected("EVIDENCE_INCOMPLETE", "isolated source BASE artifact is unavailable", "retain the reservation and reconcile its base evidence");
    const referenceGap = await referenceBaseGap(ctx, deps, attemptId, base);
    if (referenceGap !== null) return rejected("CANDIDATE_DRIFT", referenceGap, "reconcile the pinned reference and materialized base before delivery");
    if (attempt.state === "bound") {
      const actual = await deps.measure(attempt.placement.cwd ?? "");
      if (measureMapSha256(actual) !== measureMapSha256(base) || actual.head !== base.head) {
        return rejected("CANDIDATE_DRIFT", "the materialized base changed before writable delivery", "reconcile before first send");
      }
    }
  }
  const verified = await verifySeat(host, agentId, {
    provider: attempt.seatPin.provider, model: attempt.seatPin.model, cwd: attempt.placement.cwd ?? "",
    workspaceId: attempt.placement.workspaceId, parent: ctx.row.agentId,
    modeId: attempt.seatPin.modeId, thinkingOptionId: attempt.seatPin.thinkingOptionId, features: attempt.seatPin.features,
    labels: managedCreateLabels(ledger, attempt, ctx.repoKey),
  });
  if (!verified.ok) return rejected("SEAT_INELIGIBLE", `send target tuple is unverified: ${verified.mismatches.join(",")}`, "reconcile the exact reserved seat before delivery");

  // Delayed registration binds only through explicit reconciliation. Send
  // preserves its caller's initial CAS and never advances its own scope first.

  const textSha256 = sha256Hex(input.text);
  const messageId = effectIdentity("send", input.requestId);
  const intent = await deps.task.runTaskEffect(ctx, {
    operation: "intent", requestId: subRequestId(input.requestId, "send-intent"), attemptId,
    actionKind: "send",
    body: { textSha256, messageId, grantRef: input.grantRef, controlPins: dispatchControlPins(input) },
  }, taskDeps(ctx, deps));
  if (isRejection(intent)) return intent;
  const sendActionId = intent.actionId ?? null;
  if (sendActionId === null) return rejected("CAPABILITY_GAP", "the send intent committed but returned no actionId", "replay the same requestId");
  const issue = await deps.task.runTaskEffect(ctx, {
    operation: "issue", requestId: subRequestId(input.requestId, "send-issue"), attemptId,
    actionId: sendActionId, actionKind: "send",
  }, taskDeps(ctx, deps));
  if (isRejection(issue)) return issue;
  if (issue.perform === false) return { ok: true, attemptId, sent: false, perform: false };
  const bodySha = issue.permit?.body.textSha256;
  if (bodySha !== textSha256) {
    return rejected("STATE_UNREADABLE", "the issued send body does not match the intended text", "replay the same requestId");
  }

  let accepted = false;
  let sendError: string | null = null;
  try {
    await host.agents.ref(agentId).send(input.text, { messageId });
    accepted = true;
  } catch (error) {
    sendError = String((error as Error).message ?? error).slice(0, 512);
  }
  const fresh = recheck(deps, ctx);
  if (isRejection(fresh)) return fresh;
  const observedSend = await deps.task.runTaskEffect(ctx, {
    operation: "observe", requestId: subRequestId(input.requestId, "send-observe"), attemptId,
    actionId: sendActionId, actionKind: "send",
    receipt: accepted
      ? { status: "observed", accepted: true, messageId }
      : { status: "uncertain", error: sendError, messageId },
  }, taskDeps(ctx, deps));
  if (isRejection(observedSend)) return observedSend;
  return accepted
    ? { ok: true, attemptId: input.attemptId, sent: true, state: "running", messageId }
    : { ok: true, attemptId: input.attemptId, sent: false, state: "uncertain", messageId };
}

async function dispatchArchive(
  ctx: RunnerCtx,
  input: Extract<TaskDispatchInput, { phase: "archive" }>,
  deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  const host = deps.host();
  if (host === null) return rejected("CAPABILITY_GAP", "the host SDK is not connected", "retry after the plugin context is connected");
  if (input.attemptId === null) return rejected("INVALID_RECORD", "archive requires an attempt pin", "dispatch reserves attempts before archive");
  const attemptId = input.attemptId;
  const ledger = recheck(deps, ctx);
  if (isRejection(ledger)) return ledger;
  const attempt = latestAttempt(ledger, attemptId);
  if (attempt === null) return rejected("ACTOR_MISMATCH", `unknown attempt ${attemptId}`, "dispatch reserves attempts before archive");
  const agentId = attempt.host.agentId ?? null;
  if (agentId === null) return { ok: true, attemptId, state: "no-agent", archived: false };
  const verified = await verifySeat(host, agentId, {
    provider: attempt.seatPin.provider, model: attempt.seatPin.model, cwd: attempt.placement.cwd ?? "",
    workspaceId: attempt.placement.workspaceId, parent: ctx.row.agentId,
    modeId: attempt.seatPin.modeId, thinkingOptionId: attempt.seatPin.thinkingOptionId, features: attempt.seatPin.features,
    labels: managedCreateLabels(ledger, attempt, ctx.repoKey),
  });
  if (!verified.ok) return rejected("SEAT_INELIGIBLE", `archive target tuple is unverified: ${verified.mismatches.join(",")}`, "reconcile the exact reserved seat before archive");

  const intent = await deps.task.runTaskEffect(ctx, {
    operation: "intent", requestId: subRequestId(input.requestId, "archive-intent"), attemptId,
    actionKind: "archive",
    body: { grantRef: input.grantRef, cascade: input.cascade ?? null, controlPins: dispatchControlPins(input) },
  }, taskDeps(ctx, deps));
  if (isRejection(intent)) return intent;
  const actionId = intent.actionId ?? null;
  if (actionId === null) return rejected("CAPABILITY_GAP", "the archive intent committed but returned no actionId", "replay the same requestId");
  const issue = await deps.task.runTaskEffect(ctx, {
    operation: "issue", requestId: subRequestId(input.requestId, "archive-issue"), attemptId,
    actionId, actionKind: "archive",
  }, taskDeps(ctx, deps));
  if (isRejection(issue)) return issue;
  if (issue.perform === false) return { ok: true, attemptId, archived: false, perform: false };

  let archivedAt: string | null = null;
  let archiveError: string | null = null;
  try {
    const result = await host.agents.ref(agentId).archive();
    archivedAt = result.archivedAt;
  } catch (error) {
    archiveError = String((error as Error).message ?? error).slice(0, 512);
  }
  const fresh = recheck(deps, ctx);
  if (isRejection(fresh)) return fresh;
  const observedArchive = await deps.task.runTaskEffect(ctx, {
    operation: "observe", requestId: subRequestId(input.requestId, "archive-observe"), attemptId,
    actionId, actionKind: "archive",
    receipt: archivedAt !== null
      ? { status: "observed", archivedAt }
      : { status: "uncertain", error: archiveError },
  }, taskDeps(ctx, deps));
  if (isRejection(observedArchive)) return observedArchive;
  return archivedAt !== null
    ? { ok: true, attemptId: input.attemptId, archived: true, archivedAt }
    : { ok: true, attemptId: input.attemptId, archived: false, state: "uncertain" };
}

// ---------------------------------------------------------------------------
// runTaskIntegration — closed steps: stage | check | land | reconcile |
// discharge. Target-serialized by Core's resource reservation; the adapter
// measures, stages outside the real target, and applies only the verified
// BASE→source delta under a durable landing intent.
// ---------------------------------------------------------------------------

export async function runTaskIntegration(
  ctx: RunnerCtx, input: TaskIntegrateInput, deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  const parsed = DeskTaskIntegrateInput.safeParse(input);
  if (!parsed.success) return rejected("INVALID_RECORD", "integration input failed strict phase validation", "supply the required phase fields and exact revision pins");
  input = parsed.data;
  try {
    switch (input.phase) {
      case "stage": return await integrateStage(ctx, input, deps);
      case "check": return await integrateCheck(ctx, input, deps);
      case "land": return await integrateLand(ctx, input, deps);
      case "reconcile": return await integrateReconcile(ctx, input, deps);
      case "discharge": return await integrateDischarge(ctx, input, deps);
    }
  } catch (error) {
    if (error instanceof TaskMeasurementError) return rejected(error.code, error.message, "provide complete supported repository proof");
    throw error;
  }
}

const pinOf = (measure: RepositoryMeasure | null): DeskTaskMeasurePinValue | null =>
  measure === null ? null : {
    snapshotSha256: measure.sha256, head: measure.head ?? null, root: measure.root,
    kind: measure.kind,
    measuredAt: measure.measuredAt, incomplete: measure.incomplete ?? [], artifactSha256: null,
  };

function persistMeasureArtifact(
  deps: TaskExecutionDeps, repoKey: string, scopeDir: string, name: string, measure: RepositoryMeasure,
): { path: string; artifactSha256: string } {
  const dir = joinAdapter(deps, repoKey, scopeDir);
  deps.fs.ensureDir(dir);
  const path = `${dir}/${name}.measure.json`;
  const bytes = Buffer.from(JSON.stringify(measure, null, 2));
  deps.fs.writeFile(path, bytes, 0o600);
  return { path, artifactSha256: sha256Hex(bytes) };
}

const joinAdapter = (deps: TaskExecutionDeps, repoKey: string, scopeDir: string) =>
  `${deps.scratch.stableRoot}/task-exec/${repoKey}/${scopeDir}`;

async function repoTopOf(ctx: RunnerCtx, deps: TaskExecutionDeps): Promise<string> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) throw new Error("ledger unreadable");
  const common = ledger.repo.gitCommonDir;
  return deps.git.top(common.replace(/\/\.git\/?$/, "") || common);
}

async function integrateStage(
  ctx: RunnerCtx,
  input: Extract<TaskIntegrateInput, { phase: "stage" }>,
  deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  if (input.grant === undefined || typeof input.grant.authorityRef !== "string"
    || !Array.isArray(input.grant.paths) || typeof input.grant.target?.cwd !== "string"
    || input.grant.target.cwd === "") {
    return rejected("INVALID_RECORD", "stage requires a grant with authorityRef, paths and a target cwd", "supply the admission grant the caller is authorized under");
  }
  const grant = input.grant;
  const grantTargetCwd = grant.target.cwd;
  const stageKind = input.stageKind ?? "git-worktree";
  const ledger = recheck(deps, ctx);
  if (isRejection(ledger)) return ledger;

  // Resolve the task/result/attempt pins — the attempt carries the
  // placement-time BASE measure artifact.
  const attempt = findAttemptForResult(ledger, input.resultId);
  if (attempt === null) return rejected("ACTOR_MISMATCH", `no attempt produced result ${input.resultId}`, "the result pin must resolve to a bound attempt");
  const sourceCwd = attempt.placement?.cwd ?? null;
  if (sourceCwd === null) return rejected("CAPABILITY_GAP", "the attempt lacks a placement cwd", "the source checkout must be measured");

  // Source result must still measure to its pinned sha — drift holds.
  const sourceMeasure = await deps.measure(sourceCwd);
  const resultSha = readResultSha(ledger, input.resultId);
  if (resultSha !== null && sourceMeasure.sha256 !== resultSha) {
    return rejected("CANDIDATE_DRIFT", "the source checkout no longer measures to the pinned result", "adjudicate a fresh result or reconcile the drift");
  }
  const baseMeasure = await readBaseMeasure(deps, ctx, attempt);
  if (baseMeasure === null) {
    return rejected("CAPABILITY_GAP", "the pinned BASE measure artifact is unavailable", "the placement-time measure artifact is required for the delta");
  }

  const delta = computeDelta(baseMeasure, sourceMeasure);
  const confined = constrainDelta(delta, grant.paths, { maxDeltaPaths: deps.ioLimits?.maxDeltaPaths ?? DEFAULT_IO_LIMITS.maxDeltaPaths });
  if (!confined.ok) {
    return rejected("INTEGRATION_CONFLICT", `delta paths outside the grant: ${confined.paths.join(", ")}`, "narrow the delta or extend the grant");
  }
  const unsupported = scanUnsupported([
    { label: "source-base", measure: baseMeasure },
    { label: "source-result", measure: sourceMeasure },
  ]);
  if (unsupported.length > 0) {
    return rejected("INTEGRATION_UNSUPPORTED", `unsupported shapes: ${unsupported.map(u => `${u.path}(${u.shape})`).join(", ").slice(0, 512)}`, "land them through a granted manual path");
  }

  let targetCwd: string;
  try { targetCwd = deps.fs.realpath(grantTargetCwd); }
  catch {
    return rejected("SCOPE_CONFLICT", "the integration target does not resolve inside the allowed roots", "integrate into a checkout of the desk repo");
  }
  const targetCommon = await deps.git.commonDir(targetCwd).catch(() => null);
  if (targetCommon === null || targetCommon !== ledger.repo.gitCommonDir) {
    return rejected("SCOPE_CONFLICT", "the integration target is not bound to this desk's repository", "integrate into a checkout of the desk repo");
  }
  const targetMeasure = await deps.measure(targetCwd);
  const preview = threeWay(baseMeasure, sourceMeasure, targetMeasure, confined.delta);

  // Admission — Core evaluates adjudication, scope qualification, grant,
  // proof policy and the measured pins, then reserves the actual target
  // resources plus the integration action intent.
  const admitted = await deps.task.runTaskEffect(ctx, {
    operation: "integration-admit",
    requestId: subRequestId(input.requestId, "stage-admit"),
    assignmentId: input.assignmentId,
    taskId: input.taskId,
    resultId: input.resultId,
    expectedResultRevision: input.expectedResultRevision,
    expectedAdjudicationRevision: input.expectedAdjudicationRevision,
    expectedLedgerRevision: input.expectedLedgerRevision,
    grant,
    ...(input.verification !== undefined ? { verification: input.verification } : {}),
    body: {
      sourceBase: attempt.sourceBase,
      sourceBaseSha: baseMeasure.sha256,
      sourceResult: pinOf(sourceMeasure),
      sourceResultSha: sourceMeasure.sha256,
      deltaDigest: confined.delta.digest,
      changedPaths: confined.delta.changedPaths,
      target: pinOf(targetMeasure),
      targetBaseSha: targetMeasure.sha256,
      targetCwd, sourceCwd,
      conflicts: preview.conflicts,
      noopPaths: preview.noop,
      stageKind,
    },
  }, taskDeps(ctx, deps));
  if (isRejection(admitted)) return admitted;
  const actionId = admitted.actionId ?? null;
  if (admitted.perform === false || preview.conflicts.length > 0) {
    return {
      ok: true, integrationActionId: actionId, staged: false,
      conflicts: preview.conflicts, noop: preview.noop,
    };
  }

  // Materialize the staged candidate in owned scratch — the real target
  // is never written in this step.
  const paths = adapterPaths(deps.scratch.stableRoot, ctx.repoKey);
  const stageDir = paths.stage(actionId ?? subRequestId(input.requestId, "stage"));
  let resultArtifact: { path: string; artifactSha256: string };
  let worktreePaths: string[] | undefined;
  try {
    resultArtifact = persistMeasureArtifact(deps, ctx.repoKey, `integrations/${actionId}`, "source-result", sourceMeasure);
    // Stage admission covers immutable proof retention outside removable dirs.
    const proofRoot = paths.integration(actionId!);
    deps.fs.writeFile(`${proofRoot}/original.actual-fs.map.json`, recoveryMapBytes(targetMeasure), 0o600);
    deps.fs.writeFile(`${proofRoot}/expected-combined.actual-fs.map.json`, recoveryMapBytes(targetMeasure, expectedStageMap(targetMeasure, confined.delta)), 0o600);
    if (stageKind === "git-worktree") {
      if (targetMeasure.head === null) {
        return rejected("CAPABILITY_GAP", "the target has no HEAD to stage from", "stage as content-dir or commit a base first");
      }
      deps.fs.ensureEmptyDir(stageDir);
      await deps.git.worktreeAdd(targetCwd, stageDir, targetMeasure.head);
      worktreePaths = await deps.git.lsFiles(stageDir, { cached: true });
    } else {
      deps.fs.ensureEmptyDir(stageDir);
    }
    materializeStage({
      fs: deps.fs, stageRoot: stageDir, stageKind, worktreePaths,
      targetRoot: targetCwd, targetBase: targetMeasure,
      sourceRoot: sourceCwd, delta: confined.delta,
      limits: { ...DEFAULT_IO_LIMITS, ...deps.ioLimits },
    });
  } catch (error) {
    if (actionId !== null) {
      const observedFailure = await deps.task.runTaskEffect(ctx, {
        operation: "observe", requestId: subRequestId(input.requestId, "stage-observe-failure"),
        actionId, actionKind: "integration",
        receipt: { status: "failed", phase: "stage", stageDir, stageKind,
          error: String(error).slice(0, 256) },
      }, taskDeps(ctx, deps));
      if (isRejection(observedFailure)) return observedFailure;
    }
    return rejected("CAPABILITY_GAP", `stage materialization failed: ${(error as Error).message.slice(0, 256)}`, "inspect the scratch dir and retry the same request");
  }
  const stageMeasure = stageKind === "git-worktree"
    ? await deps.measure(stageDir)
    : await (deps.measureContentMap ?? deps.measure)(stageDir);
  const expected = expectedStageMap(targetMeasure, confined.delta);
  const expectedSha = sha256Hex([...expected.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join("\n"));
  const match = stageMatches(stageMeasure, expected);
  const stageSha = match.ok ? stageMeasure.sha256 : null;
  if (actionId === null) {
    return rejected("CAPABILITY_GAP", "the admission returned no action row", "replay the same requestId — the replay rebuilds the admission");
  }
  const observedStage = await deps.task.runTaskEffect(ctx, {
    operation: "observe", requestId: subRequestId(input.requestId, "stage-observe"),
    taskId: input.taskId, resultId: input.resultId,
    actionId, actionKind: "integration",
    receipt: {
      status: match.ok ? "observed" : "failed",
      stageBase: pinOf(stageMeasure),
      stagedSha: stageSha,
      expectedStageSha: stageSha,
      expectedSha,
      stageDir, expectedMatched: match.ok, mismatches: match.mismatches,
      stageKind, phase: "stage",
      sourceResult: { ...pinOf(sourceMeasure), artifactSha256: resultArtifact.artifactSha256 },
    },
  }, taskDeps(ctx, deps));
  if (isRejection(observedStage)) return observedStage;
  if (!match.ok) {
    return { ok: true, integrationActionId: actionId, staged: false, mismatches: match.mismatches };
  }
  return {
    ok: true, integrationActionId: actionId, staged: true,
    stageDir, stagedSha: stageSha, appliedPlan: preview.apply.length, noop: preview.noop.length,
  };
}

function findAttemptForResult(ledger: Readonly<LedgerValue>, resultId: string): AttemptStreamRow | null {
  const result = resultRows(ledger).find(row => row.resultId === resultId);
  return result === undefined ? null : latestAttempt(ledger, result.attemptId);
}

function readResultSha(ledger: Readonly<LedgerValue>, resultId: string): string | null {
  const result = resultRows(ledger).find(row => row.resultId === resultId);
  return result === undefined ? null : (result.candidate?.snapshotSha256 ?? result.snapshotSha256);
}

/** Read the placement-time BASE measure artifact written at dispatch.
 *  The durable artifactSha256 pin binds the persisted BYTES — the file's
 *  embedded sha256 is a mutable self-declaration, not evidence. A missing
 *  byte pin or malformed shape is a verification gap, never a pass. */
async function readBaseMeasure(
  deps: TaskExecutionDeps, ctx: RunnerCtx, attempt: AttemptStreamRow,
): Promise<RepositoryMeasure | null> {
  return readMeasureArtifact(deps, ctx.repoKey, `attempts/${attempt.attemptId}`, "base", attempt.sourceBase);
}

function readMeasureArtifact(
  deps: TaskExecutionDeps, repoKey: string, scopeDir: string, name: string,
  pin: DeskTaskMeasurePinValue | null,
): RepositoryMeasure | null {
  const path = `${joinAdapter(deps, repoKey, scopeDir)}/${name}.measure.json`;
  if (!deps.fs.exists(path)) return null;
  try {
    const bytes = deps.fs.readFile(path);
    if (pin === null || pin === undefined || typeof pin.artifactSha256 !== "string"
      || sha256Hex(bytes) !== pin.artifactSha256) return null;
    const parsed = parseRepositoryMeasure(JSON.parse(bytes.toString()));
    if (typeof pin.snapshotSha256 === "string" && parsed.sha256 !== pin.snapshotSha256) return null;
    if (parsed.root !== pin.root || parsed.head !== pin.head || parsed.kind !== pin.kind) return null;
    return parsed;
  } catch {
    return null;
  }
}

type TaskCheckRun = DeskTaskCheckRunRowValue;

async function integrateCheck(
  ctx: RunnerCtx,
  input: Extract<TaskIntegrateInput, { phase: "check" }>,
  deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  if (input.integrationActionId === null) {
    return rejected("INVALID_RECORD", "check requires an integrationActionId", "stage commits the action to check");
  }
  const actionId = input.integrationActionId;
  const ledger = recheck(deps, ctx);
  if (isRejection(ledger)) return ledger;
  const row = latestIntegration(ledger, actionId);
  if (row === null || typeof row.stageDir !== "string") {
    return rejected("ACTOR_MISMATCH", `unknown staged integration ${actionId}`, "stage before check");
  }
  const stageDir = row.stageDir;
  const measureStage = (): Promise<RepositoryMeasure> =>
    row.stageKind === "git-worktree"
      ? deps.measure(stageDir)
      : (deps.measureContentMap ?? deps.measure)(stageDir);

  // Durable check intent + admission BEFORE any recipe runs — a refused
  // phase executes zero argv and mutates nothing.
  const intent = await deps.task.runTaskEffect(ctx, {
    operation: "intent", requestId: subRequestId(input.requestId, "check-intent"),
    actionId, actionKind: "integration",
    body: { phase: "check", recoveryPlan: row.recoveryPlan ?? null, controlPins: integrationControlPins(input) },
  }, taskDeps(ctx, deps));
  if (isRejection(intent)) return intent;
  const issue = await deps.task.runTaskEffect(ctx, {
    operation: "issue", requestId: subRequestId(input.requestId, "check-issue"),
    actionId, actionKind: "integration",
  }, taskDeps(ctx, deps));
  if (isRejection(issue)) return issue;
  if (issue.perform === false) {
    return { ok: true, integrationActionId: actionId, checkRuns: [], blocked: false, perform: false };
  }

  // Freshness — the staged candidate must still equal the staged pin
  // before any recipe runs; a mutated candidate never checks clean.
  const pinnedStageSha = row.stagedSha ?? null;
  const before = await measureStage().catch(() => null);
  if (before === null || (pinnedStageSha !== null && before.sha256 !== pinnedStageSha)) {
    const drift = await deps.task.runTaskEffect(ctx, {
      operation: "observe", requestId: subRequestId(input.requestId, "check-observe-drift"),
      actionId, actionKind: "integration",
      receipt: { recoveryPlan: row.recoveryPlan ?? null, controlPins: integrationControlPins(input), status: "held", reason: "stage-drift", stageBase: pinOf(before), phase: "check" },
    }, taskDeps(ctx, deps));
    if (isRejection(drift)) return drift;
    return { ok: true, integrationActionId: actionId, checkRuns: [], blocked: true, held: "stage-drift" };
  }

  const { recipes, missing } = resolveRecipes(ledger, row);
  const runs: TaskCheckRun[] = [];
  const details: Record<string, unknown>[] = [];
  for (const id of missing) {
    runs.push({ recipeId: id, status: "blocked", exitCode: null, outputSha256: "", durationMs: 0 });
    details.push({ recipeId: id, status: "blocked", reason: "recipe-missing", required: true });
  }

  // Every executor call is bracketed by a staged-candidate measure — a
  // recipe that mutates the checked bytes invalidates its own evidence.
  let stageSha = before.sha256;
  const recheckStage = async (): Promise<boolean> => {
    const m = await measureStage().catch(() => null);
    if (m === null) return false;
    const intact = m.sha256 === stageSha;
    stageSha = m.sha256;
    return intact;
  };
  let stop = false;
  for (const recipe of recipes) {
    if (stop) break;
    const run: TaskCheckRun = { recipeId: recipe.recipeId, status: "passed", exitCode: null, outputSha256: "", durationMs: 0 };
    const detail: Record<string, unknown> = { recipeId: recipe.recipeId, required: recipe.required === true };
    const block = (reason: string): void => {
      run.status = "blocked";
      detail.status = "blocked"; detail.reason = reason;
      runs.push(run); details.push(detail);
    };
    if (recipe.argv.length === 0) { block("recipe-empty"); continue; }
    if (recipe.requiresGitContext === true && row.stageKind !== "git-worktree") { block("requires-git-context"); continue; }
    const runCwd = resolveRecipeCwd(deps.fs, stageDir, recipe.cwd);
    if (runCwd === null) { block("cwd-uncontained"); continue; }
    // Prep — declared bounded argv inside the stage. A failing or
    // mutating prep step blocks the recipe; it never silently passes.
    let prepFailed: string | null = null;
    const prepRuns: Record<string, unknown>[] = [];
    detail.prepRuns = prepRuns;
    for (const step of recipe.prep ?? []) {
      if (step.argv.length === 0) { prepFailed = "prep-empty"; break; }
      const stepCwd = resolveRecipeCwd(deps.fs, runCwd, step.cwd);
      if (stepCwd === null) { prepFailed = "prep-cwd-uncontained"; break; }
      const prep = await deps.exec(step.argv[0], step.argv.slice(1), {
        cwd: stepCwd,
        limits: {
          timeoutMs: step.timeoutMs ?? recipe.timeoutMs,
          maxOutputBytes: step.maxOutputBytes ?? recipe.maxOutputBytes,
        },
      });
      prepRuns.push({ status: prep.status, exitCode: prep.exitCode, durationMs: prep.durationMs,
        outputSha256: prep.outputSha256, outputBytes: prep.outputBytes, truncated: prep.status === "byte-cap" });
      if (!(await recheckStage())) { prepFailed = "prep-mutated"; break; }
      if (prep.status !== "passed") { prepFailed = `prep:${prep.status}`; break; }
    }
    if (prepFailed !== null) {
      block(prepFailed);
      if (prepFailed === "prep-mutated") stop = true;
      continue;
    }
    const result = await deps.exec(recipe.argv[0], recipe.argv.slice(1), {
      cwd: runCwd,
      limits: { timeoutMs: recipe.timeoutMs, maxOutputBytes: recipe.maxOutputBytes },
    });
    run.status = result.status;
    run.exitCode = result.exitCode;
    run.outputSha256 = result.outputSha256;
    run.durationMs = result.durationMs;
    detail.status = result.status; detail.outputBytes = result.outputBytes;
    detail.truncated = result.status === "byte-cap";
    runs.push(run); details.push(detail);
    if (!(await recheckStage())) {
      run.status = "mutated";
      detail.status = "mutated"; detail.reason = "stage-mutated";
      stop = true;
    }
  }

  // `checkRuns` lifts onto the row under the strict shared row schema —
  // only the declared fields. Rich per-run detail rides the receipt under
  // a non-lifted key so evidence stays complete without breaking the row.
  const observed = await deps.task.runTaskEffect(ctx, {
    operation: "observe", requestId: subRequestId(input.requestId, "check-observe"),
    actionId, actionKind: "integration",
    receipt: {
      recoveryPlan: row.recoveryPlan ?? null, controlPins: integrationControlPins(input), status: "observed", phase: "check", checkRuns: runs, runDetails: details,
      stageBefore: before.sha256, stageAfter: stageSha,
    },
  }, taskDeps(ctx, deps));
  if (isRejection(observed)) return observed;
  const blocked = runs.filter(r => r.status !== "passed");
  return { ok: true, integrationActionId: actionId, checkRuns: runs, runDetails: details, blocked: blocked.length > 0 };
}

type TaskRecipe = DeskTaskProofRecipeRowValue;

/** Pinned recipe ids resolve against the task's current pinned proof
 *  policy — the latest revision, never a first match. An id with no
 *  declared recipe is `missing`: a required check that cannot run is a
 *  block, never a silent empty pass. */
function resolveRecipes(ledger: Readonly<LedgerValue>, row: IntegrationRow): { recipes: TaskRecipe[]; missing: string[] } {
  const task = latestTask(ledger, row.assignmentId, row.taskId);
  const declared = task?.proofPolicy?.verificationRecipes ?? [];
  const byId = new Map(declared.map(r => [r.recipeId, r]));
  const recipes: TaskRecipe[] = [];
  const missing: string[] = [];
  for (const id of row.verification?.recipeIds ?? []) {
    const recipe = byId.get(id);
    if (recipe === undefined) missing.push(id);
    else recipes.push(recipe);
  }
  return { recipes, missing };
}

/** recipe.cwd / prep.cwd resolve strictly inside the stage — relative
 *  only, containment-verified realpath. Escapes and missing dirs block. */
const resolveRecipeCwd = (fs: TaskFsIo, stageDir: string, declared?: string): string | null => {
  const raw = declared === undefined || declared === "" ? "." : declared;
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return null;
  try {
    const base = fs.realpath(stageDir);
    const real = fs.realpath(`${stageDir}/${raw}`);
    if (real !== base && !real.startsWith(`${base}/`)) return null;
    return real;
  } catch {
    return null;
  }
};

function ownedRecoveryPaths(ctx: RunnerCtx, deps: TaskExecutionDeps, actionId: string) {
  const paths = adapterPaths(deps.scratch.stableRoot, ctx.repoKey);
  const root = paths.integration(actionId);
  return {stageDir: paths.stage(actionId), backupDir: paths.backup(actionId), manifestPath: `${root}/backup.manifest.json`,
    originalPath: `${root}/original.actual-fs.map.json`, combinedPath: `${root}/expected-combined.actual-fs.map.json`};
}

function readPrivateProof(deps: TaskExecutionDeps, path: string): Buffer {
  const st = deps.fs.lstat(path);
  if (!st.isFile || st.isSymlink || st.mode !== 0o600) throw new Error("RECOVERY_INTEGRITY: proof kind/mode");
  const bytes = deps.fs.readFile(path);
  if (bytes.byteLength > DEFAULT_IO_LIMITS.maxTotalBytes) throw new Error("RECOVERY_INTEGRITY: proof cap");
  return bytes;
}

function recoveryEvidence(ctx: RunnerCtx, deps: TaskExecutionDeps, row: DeskTaskActionEntryValue) {
  const plan = DeskTaskIntegrationRecoveryPlan.parse(row.recoveryPlan);
  const owned = ownedRecoveryPaths(ctx, deps, row.actionId);
  if (plan.stageDir !== owned.stageDir || plan.backupDir !== owned.backupDir || plan.manifestPath !== owned.manifestPath
    || plan.targetOriginal.path !== owned.originalPath || plan.expectedCombined.path !== owned.combinedPath
    || row.stageDir !== plan.stageDir || row.targetCwd === null) throw new Error("RECOVERY_INTEGRITY: owned path mismatch");
  const load = (pin: DeskTaskIntegrationRecoveryPlanValue["targetOriginal"]) => {
    const bytes = readPrivateProof(deps, pin.path);
    if (bytes.byteLength !== pin.bytes || sha256Hex(bytes) !== pin.artifactSha256) throw new Error("RECOVERY_INTEGRITY: map bytes/hash");
    const map = parseRecoveryMap(bytes);
    if (map.root !== row.targetCwd || map.head !== pin.head || recoveryMapSha256(map.map) !== pin.mapSha256) throw new Error("RECOVERY_INTEGRITY: map metadata");
    return map;
  };
  const original = load(plan.targetOriginal), combined = load(plan.expectedCombined);
  if (original.head !== combined.head || plan.expectedCombined.mapSha256 !== row.expectedSha) throw new Error("RECOVERY_INTEGRITY: expected map lineage");
  const manifestBytes = readPrivateProof(deps, plan.manifestPath);
  if (sha256Hex(manifestBytes) !== plan.backupManifest.artifactSha256 || manifestBytes.byteLength !== plan.backupManifest.bytes) throw new Error("RECOVERY_INTEGRITY: manifest bytes/hash");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (Object.keys(manifest).sort().join(",") !== "entries,modeSemantics,version" || manifest.version !== 1
    || manifest.modeSemantics !== "actual-filesystem-bits" || !Array.isArray(manifest.entries)) throw new Error("RECOVERY_INTEGRITY: manifest format");
  verifyBackupIntegrity({fs: deps.fs, backupDir: plan.backupDir, manifest: manifest.entries, limits: {...DEFAULT_IO_LIMITS, ...deps.ioLimits}});
  const changed = [...(row.changedPaths ?? [])].sort();
  if (JSON.stringify(manifest.entries.map((entry: {path: string}) => entry.path).sort()) !== JSON.stringify(changed)) throw new Error("RECOVERY_INTEGRITY: backup path account mismatch");
  for (const entry of manifest.entries) {
    const key = original.map.get(entry.path);
    if (entry.existed ? key !== `${entry.kind}:${entry.sha256}:${entry.mode}` : key !== undefined) throw new Error("RECOVERY_INTEGRITY: backup differs from admitted original");
  }
  if (!backupManifestBytes(manifest.entries).equals(manifestBytes)) throw new Error("RECOVERY_INTEGRITY: noncanonical manifest");
  return {plan, original, combined};
}

async function integrateLand(
  ctx: RunnerCtx, input: Extract<TaskIntegrateInput, {phase: "land"}>, deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  const actionId = input.integrationActionId;
  const ledger = recheck(deps, ctx); if (isRejection(ledger)) return ledger;
  const row = latestIntegration(ledger, actionId);
  if (row === null) return rejected("ACTOR_MISMATCH", `unknown integration ${actionId}`, "stage before land");
  const {stageDir, targetCwd, sourceCwd} = row;
  if (typeof stageDir !== "string" || typeof targetCwd !== "string" || typeof sourceCwd !== "string") return rejected("CAPABILITY_GAP", "integration lacks stage/source/target pins", "retain and reconcile the action");
  const owned = ownedRecoveryPaths(ctx, deps, actionId);
  const attempt = findAttemptForResult(ledger, input.resultId);
  const base = attempt === null ? null : await readBaseMeasure(deps, ctx, attempt);
  if (base === null) return rejected("CAPABILITY_GAP", "pinned BASE map unavailable", "retain the integration proof");
  let recoveryPlan: DeskTaskIntegrationRecoveryPlanValue;
  let planned: ReturnType<typeof planBackupDeltaPaths>;
  try {
    if (row.recoveryPlan != null) {
      // Replays retain the original request plan. Core decides perform:false;
      // an existing plan never authorizes a blind retry or overwrite.
      recoveryPlan = DeskTaskIntegrationRecoveryPlan.parse(row.recoveryPlan);
      planned = []; // Core replay/admission decides before any backup/apply.
    } else {
      if (await deps.git.commonDir(targetCwd) !== ledger.repo.gitCommonDir || await deps.git.commonDir(sourceCwd) !== ledger.repo.gitCommonDir) throw new Error("RECOVERY_INTEGRITY: repository route mismatch");
      const target = await deps.measure(targetCwd), source = await deps.measure(sourceCwd);
      if (target.sha256 !== row.targetBaseSha) return {ok: true, integrationActionId: actionId, landed: false, held: "target-drift"};
      if (source.sha256 !== row.sourceResultSha) return {ok: true, integrationActionId: actionId, landed: false, held: "candidate-drift"};
      if (row.stageKind === "git-worktree" && await deps.git.commonDir(stageDir) !== ledger.repo.gitCommonDir) throw new Error("RECOVERY_INTEGRITY: stage route mismatch");
      const stage = await (row.stageKind === "git-worktree" ? deps.measure(stageDir) : (deps.measureContentMap ?? deps.measure)(stageDir));
      if (stage.sha256 !== row.stagedSha) return {ok: true, integrationActionId: actionId, landed: false, held: "stage-drift"};
      const delta = computeDelta(base, source);
      const confined = constrainDelta(delta, row.grant?.paths ?? []);
      if (!confined.ok || delta.digest !== row.deltaDigest) throw new Error("RECOVERY_INTEGRITY: delta grant/pin mismatch");
      const pin = (path: string, expected: Map<string, string>) => {
        const bytes = readPrivateProof(deps, path), map = parseRecoveryMap(bytes);
        if (map.root !== targetCwd || map.head !== target.head || recoveryMapSha256(map.map) !== recoveryMapSha256(expected)) throw new Error("RECOVERY_INTEGRITY: retained map mismatch");
        return {path, artifactSha256: sha256Hex(bytes), bytes: bytes.byteLength, mapSha256: recoveryMapSha256(map.map), head: map.head};
      };
      const original = pin(owned.originalPath, expectedStageMap(target, {entries: [], changedPaths: [], digest: ""}));
      const combined = pin(owned.combinedPath, expectedStageMap(target, delta));
      if (combined.mapSha256 !== row.expectedSha || !stageMatches(stage, expectedStageMap(target, delta)).ok) throw new Error("RECOVERY_INTEGRITY: stage expected mismatch");
      planned = planBackupDeltaPaths({fs: deps.fs, targetRoot: targetCwd, delta, limits: {...DEFAULT_IO_LIMITS, ...deps.ioLimits}});
      const manifestBytes = backupManifestBytes(planned);
      recoveryPlan = DeskTaskIntegrationRecoveryPlan.parse({version: 1, stageDir, backupDir: owned.backupDir, manifestPath: owned.manifestPath,
        targetOriginal: original, expectedCombined: combined, backupManifest: {artifactSha256: sha256Hex(manifestBytes), bytes: manifestBytes.byteLength}});
    }
  } catch (error) { return rejected("RUNTIME_INTEGRITY", String(error).slice(0, 256), "retain maps and resources; recover only from exact admitted proof"); }
  const controlPins = integrationControlPins(input);
  const intent = await deps.task.runTaskEffect(ctx, {operation: "intent", requestId: subRequestId(input.requestId, "land-intent"), actionId,
    actionKind: "integration", body: {phase: "land", controlPins, recoveryPlan}}, taskDeps(ctx, deps));
  if (isRejection(intent)) return intent;
  const issue = await deps.task.runTaskEffect(ctx, {operation: "issue", requestId: subRequestId(input.requestId, "land-issue"), actionId, actionKind: "integration"}, taskDeps(ctx, deps));
  if (isRejection(issue)) return issue;
  if (issue.perform === false) return {ok: true, integrationActionId: actionId, landed: false, perform: false};
  const observe = async (receipt: Record<string, unknown>) => deps.task.runTaskEffect(ctx, {operation: "observe", requestId: subRequestId(input.requestId, "land-observe"),
    actionId, actionKind: "integration", receipt: {phase: "land", recoveryPlan, controlPins, ...receipt}}, taskDeps(ctx, deps));
  const applied: string[] = [];
  let final: RepositoryMeasure;
  try {
    if (await deps.git.commonDir(targetCwd) !== ledger.repo.gitCommonDir || await deps.git.commonDir(sourceCwd) !== ledger.repo.gitCommonDir
      || (row.stageKind === "git-worktree" && await deps.git.commonDir(stageDir) !== ledger.repo.gitCommonDir)) throw new Error("RECOVERY_INTEGRITY: repository route changed after issue");
    const target = await deps.measure(targetCwd), source = await deps.measure(sourceCwd);
    const stage = await (row.stageKind === "git-worktree" ? deps.measure(stageDir) : (deps.measureContentMap ?? deps.measure)(stageDir));
    if (target.sha256 !== row.targetBaseSha || source.sha256 !== row.sourceResultSha || stage.sha256 !== row.stagedSha) throw new Error("RECOVERY_INTEGRITY: freshness drift after issue");
    const delta = computeDelta(base, source), apply = threeWay(base, source, target, delta);
    if (apply.conflicts.length > 0 || delta.digest !== row.deltaDigest) throw new Error("RECOVERY_INTEGRITY: three-way/delta drift");
    deps.fs.ensureEmptyDir(recoveryPlan.backupDir);
    // Exact manifest is already durable in LAND intent before these effects.
    deps.fs.writeFile(recoveryPlan.manifestPath, backupManifestBytes(planned), 0o600);
    backupDeltaPaths({fs: deps.fs, targetRoot: targetCwd, backupDir: recoveryPlan.backupDir, delta, planned, limits: {...DEFAULT_IO_LIMITS, ...deps.ioLimits}});
    const admitted = {...row, recoveryPlan};
    recoveryEvidence(ctx, deps, admitted); // verify every map/manifest/blob BEFORE first target write
    for (const entry of apply.apply) applied.push(...applyDeltaToTarget({fs: deps.fs, targetRoot: targetCwd, sourceRoot: sourceCwd, apply: [entry]}).applied);
    final = await deps.measure(targetCwd);
    const proof = recoveryEvidence(ctx, deps, admitted);
    const match = final.root === targetCwd && final.head === proof.combined.head && stageMatches(final, proof.combined.map).ok;
    const observed = await observe({status: match ? "observed" : "held", recoveryClassification: match ? "full-applied" : "unknown", backupIntegrity: true,
      finalMatchesExpected: match, ...(match ? {final: pinOf(final)} : {measuredFinal: pinOf(final)}), applied, backupDir: recoveryPlan.backupDir, backupManifest: planned});
    if (isRejection(observed)) return observed;
    return {ok: true, integrationActionId: actionId, landed: match, finalMatchesExpected: match, ...(match ? {finalSha: final.sha256} : {held: "final-mismatch"}), backupDir: recoveryPlan.backupDir, applied: applied.length};
  } catch (error) {
    const failed = await observe({status: "held", recoveryClassification: "unknown", backupIntegrity: false, finalMatchesExpected: false,
      backupDir: recoveryPlan.backupDir, applied, error: String(error).slice(0, 256)});
    if (isRejection(failed)) return failed;
    return {ok: true, integrationActionId: actionId, landed: false, held: "apply-failed", backupDir: recoveryPlan.backupDir, applied, error: String(error).slice(0, 256)};
  }
}

async function integrateReconcile(
  ctx: RunnerCtx, input: Extract<TaskIntegrateInput, {phase: "reconcile"}>, deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  const actionId = input.integrationActionId;
  const ledger = recheck(deps, ctx); if (isRejection(ledger)) return ledger;
  const row = latestIntegration(ledger, actionId);
  if (row === null) return rejected("ACTOR_MISMATCH", `unknown integration ${actionId}`, "nothing to reconcile");
  const requestId = subRequestId(input.requestId, "reconcile-observe");
  const triggerIdentity = {controlPins: integrationControlPins(input), publicRequestId: input.requestId, publicRequestSha256: canonicalSha256(input)};
  const recorded = taskEntriesOf(ledger, "action").find(entry => entry.kind === "action" && entry.requestId === requestId
    && entry.actorAgentId === ctx.row.agentId && entry.actorMembershipId === ctx.row.membershipId);
  if (recorded?.kind === "action" && recorded.receipt !== null) {
    if (recorded.actionId !== actionId || recorded.assignmentId !== input.assignmentId || recorded.taskId !== input.taskId || recorded.resultId !== input.resultId
      || recorded.receipt.phase !== "reconcile" || canonicalSha256(recorded.receipt.controlPins ?? null) !== canonicalSha256(integrationControlPins(input))) {
      return rejected("IDEMPOTENCY_CONFLICT", "reconcile request differs from its immutable recorded phase", "use a new request with fresh explicit pins");
    }
    const stored = recorded.receipt;
    const originalTrigger = stored.cleanupTrigger === undefined ? null : DeskTaskIntegrationCleanupTrigger.parse(stored.cleanupTrigger);
    if (originalTrigger !== null && (originalTrigger.publicRequestId !== input.requestId || originalTrigger.publicRequestSha256 !== canonicalSha256(input)
      || canonicalSha256(originalTrigger.controlPins) !== canonicalSha256(integrationControlPins(input)))) {
      return rejected("IDEMPOTENCY_CONFLICT", "cleanup replay differs from its immutable trigger identity", "resend the exact original public phase");
    }
    const replayReceipt = originalTrigger ?? stored;
    const replay = await deps.task.runTaskEffect(ctx, {operation: "observe", requestId, actionId, actionKind: "integration", receipt: replayReceipt}, taskDeps(ctx, deps));
    if (isRejection(replay)) return replay;
    return {ok: true, integrationActionId: actionId, replayed: true, perform: false,
      ...(stored.cleanupStep ? {cleanupStep: stored.cleanupStep} : {recoveryClassification: stored.recoveryClassification, backupIntegrity: stored.backupIntegrity,
        landed: stored.recoveryClassification === "full-applied"})};
  }
  const history = cleanupActionHistory(ledger, actionId);
  const verifyIntended = history.find(entry => entry.state === "intended" && entry.body?.cleanupStep === "verify-account");
  if (verifyIntended !== undefined || row.cleanupVerification != null) {
    const pendingIssue = [...history].reverse().find(entry => entry.state === "issued" && entry.phase === "discharge"
      && (entry.body?.cleanupStep === "verify-account" || entry.body?.cleanupStep === "remove-resource"));
    if (pendingIssue === undefined) return rejected("EVIDENCE_INCOMPLETE", "cleanup has no issued verification/resource progress to reconcile", "read the exact retained admission and use a funded fresh phase");
    if (pendingIssue.body?.cleanupStep === "verify-account") {
      const candidate = DeskTaskIntegrationCleanupCandidate.parse(pendingIssue.body.cleanupCandidate);
      let bytes: Buffer;
      try { bytes = await reconstructCleanupBundle(deps, ledger, row, candidate); }
      catch (error) { return rejected("EVIDENCE_INCOMPLETE", String(error).slice(0, 256), "retain the original proof candidate and untouched resources"); }
      const observeDeps: TaskRunnerDeps = {...taskDeps(ctx, deps), cleanupArtifactBytes: {candidateSha256: canonicalSha256(candidate), bytes: new Uint8Array(bytes)}};
      const observed = await deps.task.runTaskEffect(ctx, {operation: "observe", requestId, actionId, actionKind: "integration",
        receipt: DeskTaskIntegrationCleanupTrigger.parse({phase: "reconcile", cleanupStep: "verify-account", verifyIssueRef: cleanupEntryRef(pendingIssue), ...triggerIdentity})}, observeDeps);
      if (isRejection(observed)) return observed;
      return cleanupReturn(ctx, deps, actionId, {cleanupStep: "verify-account"});
    }
    const permit = DeskTaskIntegrationCleanupPermit.parse(pendingIssue.body?.permit);
    const observed = await deps.task.runTaskEffect(ctx, {operation: "observe", requestId, actionId, actionKind: "integration",
      receipt: DeskTaskIntegrationCleanupTrigger.parse({phase: "reconcile", cleanupStep: "reconcile-progress", verificationRef: permit.verificationRef, issuedPermitRef: cleanupEntryRef(pendingIssue), ...triggerIdentity})}, taskDeps(ctx, deps));
    if (isRejection(observed)) return observed;
    return cleanupReturn(ctx, deps, actionId, {cleanupStep: "reconcile-progress"});
  }
  let classification: "full-applied" | "original" | "partial" | "unknown" = "unknown";
  let backupIntegrity = false, target: RepositoryMeasure | null = null, reason: string | null = null;
  try {
    const proof = recoveryEvidence(ctx, deps, row);
    backupIntegrity = true;
    if (await deps.git.commonDir(row.targetCwd!) !== ledger.repo.gitCommonDir) throw new Error("RECOVERY_INTEGRITY: target repository mismatch");
    target = await deps.measure(row.targetCwd!);
    if (target.root !== row.targetCwd || target.head !== proof.original.head) throw new Error("RECOVERY_INTEGRITY: target identity/head drift");
    if (stageMatches(target, proof.combined.map).ok) classification = "full-applied";
    else if (stageMatches(target, proof.original.map).ok) classification = "original";
    else {
      const actual = expectedStageMap(target, {entries: [], changedPaths: [], digest: ""});
      const paths = new Set([...actual.keys(), ...proof.original.map.keys(), ...proof.combined.map.keys()]);
      if ([...paths].every(p => actual.get(p) === proof.original.map.get(p) || actual.get(p) === proof.combined.map.get(p))) classification = "partial";
    }
  } catch (error) { reason = String(error).slice(0, 256); }
  const observed = await deps.task.runTaskEffect(ctx, {operation: "observe", requestId: subRequestId(input.requestId, "reconcile-observe"), actionId, actionKind: "integration",
    receipt: {status: classification === "full-applied" || classification === "original" ? "observed" : "held", phase: "reconcile", controlPins: integrationControlPins(input),
      recoveryPlan: row.recoveryPlan ?? null, recoveryClassification: classification, backupIntegrity, finalMatchesExpected: classification === "full-applied",
      ...(classification === "full-applied" ? {recoveredLand: pinOf(target)} : {}), target: pinOf(target), reason}}, taskDeps(ctx, deps));
  if (isRejection(observed)) return observed;
  return {ok: true, integrationActionId: actionId, recoveryClassification: classification, backupIntegrity, landed: classification === "full-applied", ...(reason ? {gap: reason} : {})};
}

async function referenceBaseGap(
  ctx: RunnerCtx, deps: TaskExecutionDeps, attemptId: string, base: RepositoryMeasure,
): Promise<string | null> {
  const ledger = recheck(deps, ctx);
  if (isRejection(ledger)) return ledger.message;
  const place = actionRows(ledger).filter(row => row.actionKind === "place" && row.attemptId === attemptId)
    .sort((a, b) => b.revision - a.revision)[0];
  const parsed = DeskTaskDependencyObservation.safeParse(place?.body?.dependencyObservation);
  if (!parsed.success || parsed.data.reference === null) {
    const attempt = latestAttempt(ledger, attemptId);
    return attempt !== null && attempt.consumedDependencies?.length > 0 ? "reference-evidence-unavailable" : null;
  }
  const reference = parsed.data.reference;
  if (base.head !== reference.resolvedHead || measureMapSha256(base) !== reference.mapSha256) {
    return "reference-materialization-mismatch";
  }
  try {
    const current = await deps.git.measureReference(await repoTopOf(ctx, deps), reference.baseRef);
    if (current.reference?.gitCommonDir !== reference.gitCommonDir || current.head !== reference.resolvedHead
      || current.reference?.mapSha256 !== reference.mapSha256) return "reference-drift";
  } catch { return "reference-unavailable"; }
  return null;
}

const cleanupEntryRef = (row: Pick<DeskTaskActionEntryValue, "entryId" | "entrySha256">): DeskTaskIntegrationEntryRefValue =>
  ({entryId: row.entryId, entrySha256: row.entrySha256});

function cleanupActionHistory(ledger: Readonly<LedgerValue>, actionId: string): DeskTaskActionEntryValue[] {
  return taskEntriesOf(ledger, "action").filter((row): row is DeskTaskActionEntryValue => row.kind === "action" && row.actionId === actionId)
    .sort((a, b) => a.revision - b.revision);
}

async function cleanupGitRegistration(
  deps: TaskExecutionDeps, row: DeskTaskActionEntryValue, path: string,
  expected: DeskTaskIntegrationCleanupGitRegistrationValue | null = null,
): Promise<DeskTaskIntegrationCleanupGitRegistrationValue | null> {
  if (row.targetCwd === null) throw new Error("CLEANUP_GIT: target route unavailable");
  const raw = await deps.git.worktreeList(row.targetCwd);
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("CLEANUP_GIT: registration cap");
  const records = raw.split("\0\0").filter(Boolean).map(record => record.split("\0").filter(Boolean));
  const matches = records.filter(fields => fields.includes(`worktree ${path}`));
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("CLEANUP_GIT: duplicate registration");
  const head = matches[0]!.find(field => field.startsWith("HEAD "))?.slice(5);
  if (head === undefined) throw new Error("CLEANUP_GIT: registration has no HEAD");
  const commonDir = await deps.git.commonDir(row.targetCwd);
  // After a partial owned deletion the .git pointer may be gone. Exact
  // retained admin registration is observed read-only through its pinned dir.
  const gitDir = expected?.gitDir ?? await deps.git.absoluteGitDir(path);
  const admin = deps.fs.lstat(gitDir);
  if (!admin.isDirectory || admin.isSymlink) throw new Error("CLEANUP_GIT: invalid admin directory");
  if (deps.fs.realpath(gitDir) !== gitDir || deps.fs.listDirectory(gitDir).includes("locked")) {
    throw new Error("CLEANUP_GIT: aliased or locked admin registration");
  }
  const readAdmin = (name: string) => {
    const path = `${gitDir}/${name}`, stat = deps.fs.lstat(path);
    if (!stat.isFile || stat.isSymlink || stat.bytes > 4096) throw new Error("CLEANUP_GIT: unsupported admin metadata");
    return deps.fs.readFile(path);
  };
  const pointer = readAdmin("gitdir");
  if (pointer.byteLength > 4096 || pointer.toString().trim() !== `${path}/.git`) throw new Error("CLEANUP_GIT: admin pointer mismatch");
  const adminHead = readAdmin("HEAD");
  if (adminHead.byteLength > 4096 || adminHead.toString().trim() !== head) throw new Error("CLEANUP_GIT: admin HEAD mismatch");
  return DeskTaskIntegrationCleanupGitRegistration.parse({path, commonDir, gitDir, head});
}

async function observedCleanupResources(
  deps: TaskExecutionDeps, ledger: Readonly<LedgerValue>, row: DeskTaskActionEntryValue,
  pins: readonly DeskTaskIntegrationCleanupResourcePinValue[],
): Promise<DeskTaskIntegrationCleanupObservedResourceValue[]> {
  const resources: DeskTaskIntegrationCleanupObservedResourceValue[] = [];
  for (const pin of pins) {
    const resource = latestTaskEntity(ledger, pin.resourceId);
    if (resource?.kind !== "resource" || resource.actionId !== row.actionId || resource.resourceKey !== pin.resourceKey
      || resource.resourceKind !== pin.resourceKind) throw new Error("CLEANUP_RESOURCE: identity mismatch");
    const entries = deps.fs.exists(pin.resourceKey)
      ? DeskTaskIntegrationCleanupInventoryEntry.array().parse(JSON.parse(collectCleanupInventoryBytes(deps.fs, pin.resourceKey, {...DEFAULT_IO_LIMITS, ...deps.ioLimits}).toString())) : [];
    const root = entries.find(entry => entry.path === ".");
    resources.push({resourceId: resource.resourceId, resourceRevision: resource.revision, resourceKey: resource.resourceKey,
      resourceKind: pin.resourceKind, rootMode: root?.mode ?? null, entries,
      gitRegistration: pin.resourceKind === "worktree" ? await cleanupGitRegistration(deps, row, pin.resourceKey, pin.gitRegistration) : null});
  }
  return resources;
}

async function createCleanupCandidate(
  ctx: RunnerCtx, deps: TaskExecutionDeps, ledger: Readonly<LedgerValue>, row: DeskTaskActionEntryValue,
): Promise<{candidate: DeskTaskIntegrationCleanupCandidateValue; bytes: Buffer}> {
  const history = cleanupActionHistory(ledger, row.actionId), plan = row.recoveryPlan ?? null;
  const basis = plan === null ? "stage-only" : "land-recovery";
  const sourceAdmission = basis === "stage-only" ? history.find(entry => entry.revision === 1 && entry.phase === "stage")
    : history.find(entry => entry.state === "intended" && entry.phase === "land" && canonicalSha256(entry.body?.recoveryPlan) === canonicalSha256(plan));
  const proof = [...history].reverse().find(entry => basis === "stage-only"
    ? entry.receipt?.phase === "stage" && entry.receipt.status === "observed" && entry.stageDir === row.stageDir
    : ["land", "reconcile"].includes(String(entry.receipt?.phase)) && entry.receipt?.status === "observed" && entry.receipt.backupIntegrity === true
      && ["full-applied", "original"].includes(String(entry.receipt.recoveryClassification)) && canonicalSha256(entry.receipt.recoveryPlan) === canonicalSha256(plan));
  if (sourceAdmission === undefined || proof === undefined || row.stageDir === null || row.targetCwd === null || row.grant === null) throw new Error("CLEANUP_SOURCE: immutable admission/proof unavailable");
  const request = ledger.requests.find(entry => entry.actorKey === `agent:${sourceAdmission.actorAgentId}` && entry.assignmentId === row.assignmentId && entry.requestId === sourceAdmission.requestId);
  if (request === undefined) throw new Error("CLEANUP_SOURCE: original request digest unavailable");
  const target = await deps.measure(row.targetCwd);
  if (await deps.git.commonDir(row.targetCwd) !== ledger.repo.gitCommonDir) throw new Error("CLEANUP_SOURCE: target repository mismatch");
  if (plan !== null) recoveryEvidence(ctx, deps, row); // full backup/map proof before initial destructive account
  else if (history.some(entry => entry.phase === "land") || row.backupDir !== null || row.landed !== null) throw new Error("CLEANUP_SOURCE: nullable plan has LAND provenance");
  const owned = ownedRecoveryPaths(ctx, deps, row.actionId);
  const resourcePins: DeskTaskIntegrationCleanupResourcePinValue[] = [];
  const bundleResources: DeskTaskIntegrationCleanupBundleValue["resources"][number][] = [];
  for (const [index, resourceId] of (row.resourceIds ?? []).entries()) {
    const resource = latestTaskEntity(ledger, resourceId);
    const path = index === 0 ? owned.stageDir : owned.backupDir;
    if (resource?.kind !== "resource" || resource.actionId !== row.actionId || resource.disposition !== "retained" || resource.resourceKey !== path
      || !["worktree", "scratch"].includes(resource.resourceKind)) throw new Error("CLEANUP_RESOURCE: incomplete retained account");
    const entries = DeskTaskIntegrationCleanupInventoryEntry.array().parse(JSON.parse(collectCleanupInventoryBytes(deps.fs, path, {...DEFAULT_IO_LIMITS, ...deps.ioLimits}).toString()));
    const root = entries.find(entry => entry.path === ".");
    if (root?.kind !== "directory") throw new Error("CLEANUP_RESOURCE: missing root inventory");
    const pin = DeskTaskIntegrationCleanupResourcePin.parse({role: index === 0 ? "stage" : "backup", resourceId, resourceRevision: resource.revision,
      resourceKey: path, resourceKind: resource.resourceKind, cleanupRecipe: resource.resourceKind === "worktree" ? "git-worktree-remove" : "owned-directory-remove",
      inventoryMapSha256: sha256Hex(Buffer.from(canonicalJson(entries))), entryCount: entries.length,
      contentBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), rootMode: root.mode,
      gitRegistration: resource.resourceKind === "worktree" ? await cleanupGitRegistration(deps, row, path) : null});
    resourcePins.push(pin);bundleResources.push({pin, entries});
  }
  const sourceProofKind = basis === "stage-only" ? "stage-observed" : proof.receipt!.recoveryClassification;
  const base = {version: 1, basis, actionId: row.actionId, recoveryPlanSha256: plan === null ? null : canonicalSha256(plan),
    sourceAdmissionRef: cleanupEntryRef(sourceAdmission), sourceProofRef: cleanupEntryRef(proof), sourceProofKind,
    sourceGrantRef: row.grant.authorityRef, sourceControlSha256: taskIntegrationCleanupSourceControlDigest(sourceAdmission, request.bodySha256, row.grant.authorityRef),
    targetBefore: pinOf(target)};
  const bundle = DeskTaskIntegrationCleanupBundle.parse({...base, modeSemantics: "actual-filesystem-bits", resources: bundleResources});
  const bytes = Buffer.from(taskIntegrationCleanupBundleBytes(bundle));
  const candidate = DeskTaskIntegrationCleanupCandidate.parse({...base, resources: resourcePins,
    artifact: {path: taskIntegrationCleanupArtifactPath(row.stageDir), artifactSha256: sha256Hex(bytes), bytes: bytes.byteLength, bundleSha256: canonicalSha256(bundle), mode: 0o600}});
  return {candidate, bytes};
}

async function reconstructCleanupBundle(
  deps: TaskExecutionDeps, ledger: Readonly<LedgerValue>, row: DeskTaskActionEntryValue,
  candidate: DeskTaskIntegrationCleanupCandidateValue,
): Promise<Buffer> {
  // Verification continuation uses the ORIGINAL pinned target/source fields,
  // never a new measurement timestamp or an inventory of removed leftovers.
  const observed = await observedCleanupResources(deps, ledger, row, candidate.resources);
  const resources = observed.map((resource, index) => {
    const pin = candidate.resources[index]!;
    if (resource.resourceRevision !== pin.resourceRevision || resource.rootMode !== pin.rootMode
      || canonicalSha256(resource.entries) !== pin.inventoryMapSha256 || canonicalSha256(resource.gitRegistration) !== canonicalSha256(pin.gitRegistration)) {
      throw new Error("CLEANUP_VERIFY: complete before inventory no longer matches original candidate");
    }
    return {pin, entries: resource.entries};
  });
  const bundle = DeskTaskIntegrationCleanupBundle.parse({version: 1, modeSemantics: "actual-filesystem-bits", basis: candidate.basis,
    actionId: candidate.actionId, recoveryPlanSha256: candidate.recoveryPlanSha256,
    sourceAdmissionRef: candidate.sourceAdmissionRef, sourceProofRef: candidate.sourceProofRef, sourceProofKind: candidate.sourceProofKind,
    sourceGrantRef: candidate.sourceGrantRef, sourceControlSha256: candidate.sourceControlSha256, targetBefore: candidate.targetBefore, resources});
  const bytes = Buffer.from(taskIntegrationCleanupBundleBytes(bundle));
  if (sha256Hex(bytes) !== candidate.artifact.artifactSha256 || bytes.byteLength !== candidate.artifact.bytes || canonicalSha256(bundle) !== candidate.artifact.bundleSha256) {
    throw new Error("CLEANUP_VERIFY: original bundle bytes cannot be reconstructed from intact evidence");
  }
  return bytes;
}

async function cleanupSourceEvidence(
  ctx: RunnerCtx, deps: TaskExecutionDeps, ledger: Readonly<LedgerValue>, row: DeskTaskActionEntryValue,
): Promise<[DeskTaskMeasurePinValue, DeskTaskMeasurePinValue]> {
  const attempt = row.resultId === null ? null : findAttemptForResult(ledger, row.resultId);
  if (attempt === null || row.sourceBase === null || row.sourceResult === null || row.sourceCwd === null) throw new Error("CLEANUP_SOURCE: absent admitted map provenance");
  const basePath = `${joinAdapter(deps, ctx.repoKey, `attempts/${attempt.attemptId}`)}/base.measure.json`;
  const resultPath = `${joinAdapter(deps, ctx.repoKey, `integrations/${row.actionId}`)}/source-result.measure.json`;
  const baseBytes = readPrivateProof(deps, basePath), resultBytes = readPrivateProof(deps, resultPath);
  if (row.sourceBase.artifactSha256 === null || sha256Hex(baseBytes) !== row.sourceBase.artifactSha256
    || row.sourceResult.artifactSha256 === null || sha256Hex(resultBytes) !== row.sourceResult.artifactSha256) throw new Error("CLEANUP_SOURCE: retained artifact byte drift");
  const base = parseRepositoryMeasure(JSON.parse(baseBytes.toString())), result = parseRepositoryMeasure(JSON.parse(resultBytes.toString()));
  const matches = (measure: RepositoryMeasure, pin: DeskTaskMeasurePinValue) => measure.root === pin.root && measure.head === pin.head
    && measure.kind === pin.kind && measure.sha256 === pin.snapshotSha256 && measure.incomplete.length === 0 && pin.incomplete.length === 0;
  if (!matches(base, row.sourceBase) || !matches(result, row.sourceResult)) throw new Error("CLEANUP_SOURCE: retained map identity drift");
  const current = await deps.measure(row.sourceCwd);
  if (!matches(current, row.sourceResult) || await deps.git.commonDir(row.sourceCwd) !== ledger.repo.gitCommonDir) throw new Error("CLEANUP_SOURCE: fresh source RESULT drift");
  // BASE remains historical byte-pinned evidence; it is never relabeled as
  // today's measured checkout. RESULT carries the fresh measurement time.
  return [{...row.sourceBase, measuredAt: base.measuredAt}, {...row.sourceResult, measuredAt: current.measuredAt}];
}

async function observeIntegrationCleanup(
  ctx: RunnerCtx, deps: TaskExecutionDeps, request: DeskTaskIntegrationCleanupObserverRequest,
): Promise<CleanupObserverResponse> {
  const ledger = recheck(deps, ctx); if (isRejection(ledger)) throw new Error(ledger.message);
  const row = latestIntegration(ledger, request.actionId);
  if (row === null || row.revision !== request.expectedActionRevision || row.targetCwd === null) throw new Error("CLEANUP_OBSERVE: action revision mismatch");
  const candidate = request.candidate ?? request.verification!.candidate;
  const owned = taskIntegrationCleanupArtifactPath(ownedRecoveryPaths(ctx, deps, row.actionId).stageDir);
  if (candidate.artifact.path !== owned) throw new Error("CLEANUP_OBSERVE: artifact outside owned proof path");
  // Retained land maps/manifest remain mandatory after backup is removed.
  if (row.recoveryPlan != null) {
    const plan = row.recoveryPlan;
    for (const pin of [plan.targetOriginal, plan.expectedCombined]) {
      const bytes = readPrivateProof(deps, pin.path), map = parseRecoveryMap(bytes);
      if (sha256Hex(bytes) !== pin.artifactSha256 || bytes.byteLength !== pin.bytes || recoveryMapSha256(map.map) !== pin.mapSha256
        || map.head !== pin.head || map.root !== row.targetCwd) throw new Error("CLEANUP_OBSERVE: retained map drift");
    }
    const manifest = readPrivateProof(deps, plan.manifestPath);
    if (sha256Hex(manifest) !== plan.backupManifest.artifactSha256 || manifest.byteLength !== plan.backupManifest.bytes) throw new Error("CLEANUP_OBSERVE: retained manifest drift");
  }
  const proof = ledger.taskEntries.find(entry => entry.entryId === candidate.sourceProofRef.entryId && entry.entrySha256 === candidate.sourceProofRef.entrySha256);
  const [sourceBase, sourceResult] = await cleanupSourceEvidence(ctx, deps, ledger, row);
  const sourceIdentity = (pin: DeskTaskMeasurePinValue) => ({...pin, measuredAt: null});
  if (canonicalSha256(sourceIdentity(sourceBase)) !== canonicalSha256(sourceIdentity(request.sourceBase))
    || canonicalSha256(sourceIdentity(sourceResult)) !== canonicalSha256(sourceIdentity(request.sourceResult))) throw new Error("CLEANUP_OBSERVE: request source pins mismatch");
  const target = await deps.measure(row.targetCwd);
  if (await deps.git.commonDir(row.targetCwd) !== ledger.repo.gitCommonDir) throw new Error("CLEANUP_OBSERVE: target route drift");
  let artifact: CleanupObserverResponse["artifact"];
  if (!deps.fs.exists(owned)) artifact = {path: owned, kind: "missing", mode: null, bytes: null};
  else {
    const stat = deps.fs.lstat(owned);
    artifact = {path: owned, kind: stat.isSymlink ? "symlink" : stat.isFile ? "regular" : "other", mode: stat.mode,
      bytes: stat.isFile && !stat.isSymlink && stat.bytes <= DEFAULT_IO_LIMITS.maxTotalBytes ? new Uint8Array(deps.fs.readFile(owned)) : null};
  }
  return DeskTaskIntegrationCleanupObserverResponse.parse({version: 1, purpose: request.purpose, progressKind: request.progressKind,
    admissionSha256: taskIntegrationCleanupAdmissionSha256(request.admission), artifact, target: pinOf(target), sourceBase, sourceResult, sourceProofRef: candidate.sourceProofRef,
    sourceProofKind: proof?.kind === "action" ? candidate.sourceProofKind : null,
    resources: await observedCleanupResources(deps, ledger, row, candidate.resources)});
}

function cleanupPublicBody(input: Extract<TaskIntegrateInput, {phase: "discharge"}>): Record<string, unknown> {
  return {phase: "discharge", grantRef: input.grantRef, controlPins: integrationControlPins(input),
    publicRequestId: input.requestId, publicRequestSha256: canonicalSha256(input)};
}

async function cleanupReturn(
  ctx: RunnerCtx, deps: TaskExecutionDeps, actionId: string, extra: Record<string, unknown> = {},
): Promise<MutationOutcome> {
  const ledger = recheck(deps, ctx); if (isRejection(ledger)) return ledger;
  const row = latestIntegration(ledger, actionId); if (row === null) return rejected("CAPABILITY_GAP", "cleanup action unavailable", "retain its exact history");
  const resources = (row.resourceIds ?? []).map(id => latestTaskEntity(ledger, id));
  const complete = resources.length > 0 && resources.every(resource => resource?.kind === "resource" && resource.disposition === "released");
  return {ok: true, integrationActionId: actionId, discharged: complete, ledgerRevision: ledger.revision, actionRevision: row.revision,
    state: row.state, removed: resources.flatMap(resource => resource?.kind === "resource" && resource.disposition === "released" ? [resource.resourceKey] : []),
    ...extra, ...(complete ? {} : {recovery: "reread the action and resources, then invoke one fresh granted discharge phase"})};
}

/** Recheck the exact committed resource preflight before a narrow owned
 * pointer restoration. Core alone admits the permit; this comparison holds
 * the physical effect if its already-approved source/material drifted. */
async function restoreIssuedStagePointer(
  ctx: RunnerCtx, deps: TaskExecutionDeps, issuedLedger: Readonly<LedgerValue>, issued: DeskTaskActionEntryValue,
  permit: DeskTaskIntegrationCleanupPermitValue,
): Promise<void> {
  const verification = DeskTaskIntegrationCleanupVerification.parse(issued.cleanupVerification);
  const evidence = DeskTaskIntegrationCleanupPreflightEvidence.parse(issued.cleanupIssueEvidence);
  const candidate = verification.candidate;
  const stage = candidate.resources.find(pin => pin.resourceId === permit.resourceId);
  if (stage === undefined || stage.role !== "stage" || stage.resourceKind !== "worktree" || stage.gitRegistration === null
    || stage.resourceKey !== ownedRecoveryPaths(ctx, deps, issued.actionId).stageDir || issued.stageDir !== stage.resourceKey
    || canonicalSha256(evidence.permit) !== canonicalSha256(permit) || canonicalSha256(evidence.verificationRef) !== canonicalSha256(permit.verificationRef)) {
    throw new Error("CLEANUP_POINTER: exact admitted stage/account/permit unavailable");
  }
  const leaf = `${stage.resourceKey}/.git`;
  // Only ENOENT establishes absence; an existing leaf still needs the
  // complete post-ISSUE drift check before the ordinary Git removal.
  let absent = false;
  try { deps.fs.lstat(leaf); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; absent = true; }
  if (deps.fs.realpath(stage.resourceKey) !== stage.resourceKey || deps.fs.resolve(leaf) !== leaf) {
    throw new Error("CLEANUP_POINTER: noncanonical owned stage path");
  }
  const priorRef = evidence.priorIssuedPermitRef;
  const prior = priorRef === null ? undefined : cleanupActionHistory(issuedLedger, issued.actionId).find(row =>
    row.entryId === priorRef.entryId && row.entrySha256 === priorRef.entrySha256 && row.state === "issued"
    && row.phase === "discharge" && row.actionKind === "integration" && row.body?.cleanupStep === "remove-resource");
  const priorPermit = DeskTaskIntegrationCleanupPermit.safeParse(prior?.body?.permit);
  if (absent && (prior === undefined || prior.entryId === issued.entryId || !priorPermit.success
    || priorPermit.data.ordinal >= permit.ordinal || priorPermit.data.actionId !== permit.actionId
    || priorPermit.data.resourceId !== permit.resourceId || priorPermit.data.resourceKey !== permit.resourceKey
    || priorPermit.data.inventoryMapSha256 !== permit.inventoryMapSha256 || priorPermit.data.cleanupRecipe !== permit.cleanupRecipe
    || canonicalSha256(priorPermit.data.verificationRef) !== canonicalSha256(permit.verificationRef))) {
    throw new Error("CLEANUP_POINTER: absence has no different prior issued resource permit");
  }
  const intent = cleanupActionHistory(issuedLedger, issued.actionId).find(row => row.entryId === issued.priorEntryId
    && row.entrySha256 === issued.priorEntrySha256 && row.state === "intended" && canonicalSha256(row.body) === canonicalSha256(issued.body));
  const controls = DeskTaskIntegrationControlPins.parse(issued.body?.controlPins);
  if (intent === undefined || issued.sourceBase === null || issued.sourceResult === null || issued.grant === null
    || typeof issued.body?.publicRequestId !== "string" || typeof issued.body.publicRequestSha256 !== "string") {
    throw new Error("CLEANUP_POINTER: exact issued current admission unavailable");
  }
  const request: Extract<DeskTaskIntegrationCleanupObserverRequest, {progressKind: "resource-preflight"}> = {
    version: 1, purpose: "reconcile-progress", progressKind: "resource-preflight",
    admission: {phase: "discharge", publicRequestId: issued.body.publicRequestId, publicRequestSha256: issued.body.publicRequestSha256,
      grantRef: issued.grant.authorityRef, controlPins: controls, intentRef: cleanupEntryRef(intent), issueRef: null},
    actionId: issued.actionId, expectedActionRevision: issued.revision, sourceBase: issued.sourceBase, sourceResult: issued.sourceResult,
    candidate: null, candidateArtifactBytes: null, verification, verificationRef: permit.verificationRef, permit,
    priorIssuedPermit: prior !== undefined && priorPermit.success ? {permit: priorPermit.data, issueRef: cleanupEntryRef(prior)} : null,
  };
  const fresh = await observeIntegrationCleanup(ctx, deps, request);
  const stableMeasure = (pin: DeskTaskMeasurePinValue | null) => pin === null ? null : {...pin, measuredAt: null};
  if (fresh.admissionSha256 !== evidence.admissionSha256 || fresh.target === null
    || canonicalSha256(stableMeasure(fresh.target)) !== canonicalSha256(stableMeasure(evidence.target))
    || canonicalSha256(stableMeasure(fresh.sourceBase)) !== canonicalSha256(stableMeasure(issued.sourceBase))
    || canonicalSha256(stableMeasure(fresh.sourceResult)) !== canonicalSha256(stableMeasure(issued.sourceResult))
    || fresh.resources.length !== evidence.resources.length || fresh.artifact.kind !== "regular" || fresh.artifact.mode !== 0o600
    || fresh.artifact.bytes === null || fresh.artifact.bytes.byteLength !== candidate.artifact.bytes
    || sha256Hex(fresh.artifact.bytes) !== candidate.artifact.artifactSha256) {
    throw new Error("CLEANUP_POINTER: source/target/admission or retained artifact changed after ISSUE");
  }
  for (const [index, resource] of fresh.resources.entries()) {
    const admitted = evidence.resources[index]!, pin = candidate.resources[index]!;
    const actualMap = resource.entries.length === 0 ? null : canonicalSha256(resource.entries);
    if (resource.resourceId !== admitted.resourceId || resource.resourceRevision !== admitted.resourceRevision
      || resource.resourceKey !== admitted.resourceKey || resource.resourceKind !== pin.resourceKind || resource.rootMode !== admitted.rootMode
      || actualMap !== admitted.observedInventoryMapSha256
      || canonicalSha256(resource.gitRegistration) !== canonicalSha256(pin.gitRegistration === null ? null
        : resource.entries.length === 0 ? null : pin.gitRegistration)) {
      throw new Error("CLEANUP_POINTER: survivor/path/mode/registration changed after ISSUE");
    }
  }
  const finalLedger = recheck(deps, ctx); if (isRejection(finalLedger)) throw new Error(finalLedger.message);
  const currentAction = latestIntegration(finalLedger, issued.actionId);
  if (finalLedger.revision !== issuedLedger.revision || currentAction?.entrySha256 !== issued.entrySha256
    || issued.actorAgentId !== ctx.row.agentId || issued.actorMembershipId !== ctx.row.membershipId) {
    throw new Error("CLEANUP_POINTER: current issued actor/admission changed before removal");
  }
  if (!absent) return;
  const bundle = DeskTaskIntegrationCleanupBundle.parse(JSON.parse(Buffer.from(fresh.artifact.bytes).toString()));
  if (canonicalSha256(bundle) !== candidate.artifact.bundleSha256 || bundle.actionId !== issued.actionId
    || canonicalSha256(bundle.resources.map(resource => resource.pin)) !== canonicalSha256(candidate.resources)) {
    throw new Error("CLEANUP_POINTER: immutable bundle identity unavailable");
  }
  const before = bundle.resources.find(resource => resource.pin.resourceId === permit.resourceId)?.entries.find(entry => entry.path === ".git");
  const current = fresh.resources.find(resource => resource.resourceId === permit.resourceId);
  const bytes = Buffer.from(`gitdir: ${stage.gitRegistration.gitDir}\n`);
  if (before?.kind !== "file" || bytes.byteLength > 4096 || before.bytes !== bytes.byteLength || before.sha256 !== sha256Hex(bytes)
    || current === undefined || current.entries.some(entry => entry.path === ".git") || current.gitRegistration === null
    || canonicalSha256(current.gitRegistration) !== canonicalSha256(stage.gitRegistration)) {
    throw new Error("CLEANUP_POINTER: absent original regular pointer bytes cannot be established");
  }
  const exclusive = deps.fs.writeFileExclusive;
  if (exclusive === undefined) throw new Error("CAPABILITY_GAP: exclusive owned-stage pointer restoration unavailable");
  // The helper must refuse every existing leaf, links and path races. It
  // creates no parent and performs no overwrite; no fallback is permitted.
  exclusive(leaf, bytes, before.mode);
  const created = deps.fs.lstat(leaf);
  if (!created.isFile || created.isSymlink || created.mode !== before.mode || created.bytes !== bytes.byteLength
    || !deps.fs.readFile(leaf).equals(bytes)) throw new Error("CLEANUP_POINTER: created bytes/mode are not the original verified survivor");
}

async function integrateDischarge(
  ctx: RunnerCtx, input: Extract<TaskIntegrateInput, {phase: "discharge"}>, deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  const actionId = input.integrationActionId;
  const ledger = recheck(deps, ctx); if (isRejection(ledger)) return ledger;
  const row = latestIntegration(ledger, actionId);
  if (row === null) return rejected("ACTOR_MISMATCH", `unknown integration ${actionId}`, "nothing to discharge");
  const history = cleanupActionHistory(ledger, actionId);
  const intentRequestId = subRequestId(input.requestId, "discharge-intent");
  const prior = history.find(entry => entry.requestId === intentRequestId && entry.actorAgentId === ctx.row.agentId && entry.actorMembershipId === ctx.row.membershipId);
  if (prior !== undefined) {
    // Replay before candidate generation, artifact/payload inspection or IO.
    if (prior.body?.publicRequestId !== input.requestId || prior.body.publicRequestSha256 !== canonicalSha256(input)
      || canonicalSha256(prior.body.controlPins) !== canonicalSha256(integrationControlPins(input))) {
      return rejected("IDEMPOTENCY_CONFLICT", "cleanup request differs from its immutable phase admission", "use a new request with exact freshly read pins");
    }
    const intent = await deps.task.runTaskEffect(ctx, {operation: "intent", requestId: intentRequestId, actionId, actionKind: "integration", body: prior.body}, taskDeps(ctx, deps));
    if (isRejection(intent)) return intent;
    const issueId = subRequestId(input.requestId, "discharge-issue");
    const issueRequest = ledger.requests.find(record => record.actorKey === `agent:${ctx.row.agentId}`
      && record.assignmentId === input.assignmentId && record.requestId === issueId && record.outcome === "committed");
    const originalIssue = history.find(entry => entry.requestId === issueId && entry.actorAgentId === ctx.row.agentId
      && entry.actorMembershipId === ctx.row.membershipId && entry.assignmentId === input.assignmentId
      && entry.taskId === input.taskId && entry.resultId === input.resultId && entry.actionId === actionId
      && entry.actionKind === "integration" && entry.state === "issued" && entry.phase === "discharge"
      && canonicalSha256(entry.body) === canonicalSha256(prior.body));
    if (issueRequest === undefined || originalIssue === undefined) return {ok: true, integrationActionId: actionId,
      discharged: false, perform: false, replayed: true, gap: "historical-cleanup-issue-uncommitted",
      recordedState: prior.state, recordedActionRevision: prior.revision,
      recovery: "retain the original intended cleanup; historical replay cannot issue a new permit or a later intent"};
    const issue = await deps.task.runTaskEffect(ctx, {operation: "issue", requestId: subRequestId(input.requestId, "discharge-issue"), actionId, actionKind: "integration"}, taskDeps(ctx, deps));
    if (isRejection(issue)) return issue;
    if (issue.perform !== false || issue.replayed !== true) return rejected("CAPABILITY_GAP", "original cleanup ISSUE did not replay exactly without a permit", "retain the historical phase; no proof write or removal follows replay");
    const priorObservation = history.find(entry => entry.requestId === subRequestId(input.requestId, "discharge-observe")
      && entry.actorAgentId === ctx.row.agentId && entry.actorMembershipId === ctx.row.membershipId);
    if (priorObservation?.receipt?.cleanupTrigger !== undefined) {
      const trigger = DeskTaskIntegrationCleanupTrigger.parse(priorObservation.receipt.cleanupTrigger);
      if (trigger.publicRequestId !== input.requestId || trigger.publicRequestSha256 !== canonicalSha256(input)
        || canonicalSha256(trigger.controlPins) !== canonicalSha256(integrationControlPins(input))) return rejected("IDEMPOTENCY_CONFLICT", "historical cleanup trigger differs from its original public request", "resend the exact phase request");
      const replayed = await deps.task.runTaskEffect(ctx, {operation: "observe", requestId: subRequestId(input.requestId, "discharge-observe"),
        actionId, actionKind: "integration", receipt: trigger}, taskDeps(ctx, deps));
      if (isRejection(replayed)) return replayed;
      return cleanupReturn(ctx, deps, actionId, {perform: false, replayed: true});
    }
    // A committed issued phase with a lost observation is explicitly
    // reconciled; historical replay never repeats its proof/delete IO.
    return {ok: true, integrationActionId: actionId, discharged: false, perform: false, replayed: true,
      recovery: "read fresh pins and explicitly reconcile the recorded cleanup phase"};
  }
  const base = cleanupPublicBody(input), plan = row.recoveryPlan ?? null;
  const verification = DeskTaskIntegrationCleanupVerification.safeParse(row.cleanupVerification);
  let body: Record<string, unknown>, bytes: Buffer | null = null;
  try {
    if (!verification.success) {
      const previous = history.find(entry => entry.state === "intended" && entry.body?.cleanupStep === "verify-account");
      const prepared = previous === undefined ? await createCleanupCandidate(ctx, deps, ledger, row)
        : {candidate: DeskTaskIntegrationCleanupCandidate.parse(previous.body?.cleanupCandidate),
          bytes: await reconstructCleanupBundle(deps, ledger, row, DeskTaskIntegrationCleanupCandidate.parse(previous.body?.cleanupCandidate))};
      bytes = prepared.bytes;
      body = {...base, cleanupStep: "verify-account", cleanupCandidate: prepared.candidate, recoveryPlan: plan};
    } else {
      const verificationEntry = history.find(entry => entry.cleanupVerification != null);
      if (verificationEntry === undefined) throw new Error("CLEANUP_ACCOUNT: verified history entry unavailable");
      const remaining = verification.data.candidate.resources.find(pin => {
        const resource = latestTaskEntity(ledger, pin.resourceId); return resource?.kind === "resource" && resource.disposition !== "released";
      });
      if (remaining === undefined) return cleanupReturn(ctx, deps, actionId);
      const resource = latestTaskEntity(ledger, remaining.resourceId);
      if (resource?.kind !== "resource") throw new Error("CLEANUP_RESOURCE: current resource unavailable");
      const cycles = history.filter(entry => entry.state === "intended" && entry.body?.cleanupStep === "remove-resource"
        && DeskTaskIntegrationCleanupPermit.safeParse(entry.body.permit).success
        && DeskTaskIntegrationCleanupPermit.parse(entry.body.permit).resourceId === remaining.resourceId).length;
      const permit = DeskTaskIntegrationCleanupPermit.parse({version: 1, cleanupStep: "remove-resource", actionId,
        verificationRef: cleanupEntryRef(verificationEntry), resourceId: remaining.resourceId, expectedResourceRevision: resource.revision,
        resourceKey: remaining.resourceKey, inventoryMapSha256: remaining.inventoryMapSha256, ordinal: cycles + 1, cleanupRecipe: remaining.cleanupRecipe});
      body = {...base, cleanupStep: "remove-resource", permit, verificationRef: permit.verificationRef, recoveryPlan: plan};
    }
  } catch (error) { return rejected("EVIDENCE_INCOMPLETE", String(error).slice(0, 256), "retain the account/resources; reconcile the exact admitted progress before a fresh phase"); }
  const intent = await deps.task.runTaskEffect(ctx, {operation: "intent", requestId: intentRequestId, actionId, actionKind: "integration", body}, taskDeps(ctx, deps));
  if (isRejection(intent)) return intent;
  const issue = await deps.task.runTaskEffect(ctx, {operation: "issue", requestId: subRequestId(input.requestId, "discharge-issue"), actionId, actionKind: "integration"}, taskDeps(ctx, deps));
  if (isRejection(issue)) return issue;
  if (issue.perform === false) return {ok: true, integrationActionId: actionId, discharged: false, perform: false};
  const issuedLedger = recheck(deps, ctx); if (isRejection(issuedLedger)) return issuedLedger;
  const issued = latestIntegration(issuedLedger, actionId);
  if (issued === null || issued.state !== "issued" || issued.body === null) return rejected("CAPABILITY_GAP", "exact cleanup issue row unavailable", "retain the issued phase and reconcile its immutable refs");
  const issueRef = cleanupEntryRef(issued);
  if (body.cleanupStep === "verify-account") {
    const candidate = DeskTaskIntegrationCleanupCandidate.parse(body.cleanupCandidate);
    let writeError: string | null = null;
    try {
      if (bytes === null || sha256Hex(bytes) !== candidate.artifact.artifactSha256) throw new Error("CLEANUP_VERIFY: candidate bytes unavailable");
      const artifact = candidate.artifact.path;
      // Only an absent artifact or exact prefix can use the same proof-only
      // write issue. Wrong kind/mode/non-prefix retains the verified source.
      if (deps.fs.exists(artifact)) {
        const existing = readPrivateProof(deps, artifact);
        if (existing.byteLength > bytes.byteLength || !bytes.subarray(0, existing.byteLength).equals(existing)) throw new Error("CLEANUP_VERIFY: artifact is not the exact original prefix");
      }
      deps.fs.writeFile(artifact, bytes, 0o600);
    } catch (error) { writeError = String(error).slice(0, 256); }
    const observeDeps: TaskRunnerDeps = {...taskDeps(ctx, deps), cleanupArtifactBytes: {candidateSha256: canonicalSha256(candidate), bytes: new Uint8Array(bytes ?? [])}};
    const observed = await deps.task.runTaskEffect(ctx, {operation: "observe", requestId: subRequestId(input.requestId, "discharge-observe"), actionId,
      actionKind: "integration", receipt: DeskTaskIntegrationCleanupTrigger.parse({phase: "discharge", cleanupStep: "verify-account", verifyIssueRef: issueRef,
        candidateSha256: canonicalSha256(candidate), controlPins: integrationControlPins(input), publicRequestId: input.requestId, publicRequestSha256: canonicalSha256(input)})}, observeDeps);
    if (isRejection(observed)) return observed;
    return cleanupReturn(ctx, deps, actionId, {cleanupStep: "verify-account", ...(writeError ? {gap: writeError} : {})});
  }
  const permit = DeskTaskIntegrationCleanupPermit.parse(body.permit);
  let error: string | null = null;
  try {
    if (permit.cleanupRecipe === "git-worktree-remove") {
      await restoreIssuedStagePointer(ctx, deps, issuedLedger, issued, permit);
      await deps.git.worktreeRemove(row.targetCwd!, permit.resourceKey, {force: true});
    }
    else deps.fs.rmrf(permit.resourceKey);
  } catch (caught) { error = String(caught).slice(0, 256); }
  const observed = await deps.task.runTaskEffect(ctx, {operation: "observe", requestId: subRequestId(input.requestId, "discharge-observe"), actionId,
    actionKind: "integration", receipt: DeskTaskIntegrationCleanupTrigger.parse({phase: "discharge", cleanupStep: "remove-resource", verificationRef: permit.verificationRef, issuedPermitRef: issueRef,
      controlPins: integrationControlPins(input), publicRequestId: input.requestId, publicRequestSha256: canonicalSha256(input)})}, taskDeps(ctx, deps));
  if (isRejection(observed)) return observed;
  return cleanupReturn(ctx, deps, actionId, {cleanupStep: "remove-resource", ...(error ? {gap: error} : {})});
}

// ---------------------------------------------------------------------------
// runTaskReconciliation — bounded fresh observations through the production
// observer; Core commits pins/uncertainty. No blind retry, no absence
// inference.
// ---------------------------------------------------------------------------

export async function runTaskReconciliation(
  ctx: RunnerCtx, input: TaskReconcileInput, deps: TaskExecutionDeps,
): Promise<MutationOutcome> {
  const parsed = DeskTaskReconcileInput.safeParse(input);
  if (!parsed.success) return rejected("INVALID_RECORD", "reconcile input failed strict validation", "supply the required targets, rules and revision pins");
  input = parsed.data;
  const result = await deps.task.runTaskCommand(ctx, {
    operation: "reconcile",
    requestId: subRequestId(input.requestId, "reconcile"),
    assignmentId: input.assignmentId,
    ...(input.taskId !== undefined && input.taskId !== null ? { taskId: input.taskId } : {}),
    attemptIds: input.attemptIds,
    actionIds: input.actionIds,
    resourceIds: input.resourceIds,
    observationTypes: input.observationTypes,
    ...(input.releaseRulings !== undefined ? { releaseRulings: input.releaseRulings } : {}),
    ...(input.attemptRulings !== undefined ? { attemptRulings: input.attemptRulings } : {}),
    ...(input.expectedLedgerRevision !== undefined ? { expectedLedgerRevision: input.expectedLedgerRevision } : {}),
  }, taskDeps(ctx, deps));
  if (isRejection(result)) return result;
  return result;
}

// ---------------------------------------------------------------------------
// Production TaskObserver — bounded read-only observations for Core's
// measured admission and reconciliation. Never mutates host/Git.
// ---------------------------------------------------------------------------

export function createTaskObserver(ctx: RunnerCtx, deps: TaskExecutionDeps): TaskObserver {
  const host = () => deps.host();
  return {
    observeIntegrationCleanup: request => observeIntegrationCleanup(ctx, deps, request),
    observePlacement: async request => {
      const cwd = typeof request.cwd === "string" ? request.cwd : (request.placement as { cwd?: string } | undefined)?.cwd;
      if (typeof cwd !== "string") return { available: false, reason: "no-cwd" };
      if (!deps.fs.exists(cwd)) return { available: false, reason: "absent" };
      try {
        const measure = await deps.measure(cwd);
        return { available: true, measure: pinOf(measure) };
      } catch (error) {
        return { available: false, reason: `measure-failed:${(error as Error).message.slice(0, 128)}` };
      }
    },
    observeDependencies: async request => {
      const pins = DeskTaskDependencyPin.array().parse(request.pins);
      const placement = DeskTaskPlacement.parse(request.placement);
      const ledger = recheck(deps, ctx);
      if (isRejection(ledger)) throw new Error(ledger.message);
      if (request.ledgerRevision !== ledger.revision) throw new Error("dependency ledger revision changed");
      let measure: RepositoryMeasure | null = null;
      let gap = "consumer-base-unavailable";
      try {
        if (placement.kind === "isolated" && placement.cwd === undefined) {
          if (placement.baseRef === undefined) throw new Error("isolated consumer has no baseRef");
          measure = await deps.git.measureReference(await repoTopOf(ctx, deps), placement.baseRef);
          if (measure.reference?.gitCommonDir !== ledger.repo.gitCommonDir) throw new Error("reference repository mismatch");
        } else if (placement.cwd !== undefined) {
          const cwd = deps.fs.realpath(placement.cwd);
          if (await deps.git.commonDir(cwd) !== ledger.repo.gitCommonDir) throw new Error("consumer repository mismatch");
          measure = await deps.measure(cwd);
        }
      } catch (error) { measure = null; gap = String(error).slice(0, 240); }
      const observation: TaskDependencyObservation = {
        consumerBase: pinOf(measure),
        reference: measure?.reference ?? null, results: [],
      };
      for (const pin of pins) {
        const result = latestTaskEntity(ledger, pin.resultId);
        const ruling = latestTaskEntity(ledger, pin.adjudicationId);
        const report: DeskTaskDependencyObservationValue["results"][number] = {
          taskId: pin.taskId, resultEntrySha256: pin.resultEntrySha256,
          adjudicationEntrySha256: pin.adjudicationEntrySha256,
          available: false, sha256: null, actualTargetPin: null,
          evidence: [{ kind: "gap", ref: gap }],
        };
        observation.results.push(report);
        if (measure === null) continue;
        if (result?.kind !== "result" || result.entrySha256 !== pin.resultEntrySha256
          || ruling?.kind !== "adjudication" || ruling.entrySha256 !== pin.adjudicationEntrySha256
          || ruling.verdict !== "accepted" || ruling.resultId !== result.resultId) {
          report.evidence = [{ kind: "gap", ref: "producer-pins-mismatch" }]; continue;
        }
        if (pin.availability === "artifact") {
          const path = pin.targetPath ?? pin.artifactKey;
          const entry = measure.entries.find(entry => entry.path === path);
          if (entry !== undefined && "kind" in entry && entry.kind === "file") {
            report.sha256 = entry.sha256;
            report.available = entry.sha256 === pin.artifactSha256;
            report.evidence = [{ kind: measure.kind, ref: `${measure.sha256}:${path}` }];
          } else report.evidence = [{ kind: "gap", ref: "artifact-not-regular-or-absent" }];
          continue;
        }
        const action = pin.integrationActionId === null ? null : latestIntegration(ledger, pin.integrationActionId);
        const attempt = latestAttempt(ledger, pin.attemptId);
        if (action === null || action.resultId !== pin.resultId || action.landed === null || attempt === null
          || action.sourceResult?.snapshotSha256 !== (result.candidate?.snapshotSha256 ?? result.snapshotSha256)) {
          report.evidence = [{ kind: "gap", ref: "integration-pins-unavailable" }]; continue;
        }
        const base = await readBaseMeasure(deps, ctx, attempt);
        const saved = readMeasureArtifact(deps, ctx.repoKey, `integrations/${action.actionId}`, "source-result", action.sourceResult);
        if (base === null || saved === null) {
          report.evidence = [{ kind: "gap", ref: "dependency-map-artifacts-unavailable" }]; continue;
        }
        const delta = computeDelta(base, saved);
        if (delta.digest !== action.deltaDigest) {
          report.evidence = [{ kind: "gap", ref: "dependency-delta-pin-mismatch" }]; continue;
        }
        const actual = new Map(measure.entries.map(entry => [entry.path, entry]));
        const expected = expectedStageMap(saved, { entries: [], changedPaths: [], digest: "" });
        const mismatches = delta.changedPaths.filter(path => {
          const entry = actual.get(path);
          const want = expected.get(path);
          if (want === undefined) return entry !== undefined && !("deleted" in entry);
          return entry === undefined || "deleted" in entry || entry.kind === "gitlink"
            || `${entry.kind}:${entry.sha256}:${entry.mode}` !== want;
        });
        report.available = mismatches.length === 0;
        report.actualTargetPin = {
          hostId: ledger.repo.hostId, repoKey: ctx.repoKey, gitCommonDir: ledger.repo.gitCommonDir,
          checkoutRoot: measure.root, ref: measure.reference?.baseRef ?? null, head: measure.head,
          snapshotSha256: measure.sha256, incomplete: measure.incomplete, measuredAt: measure.measuredAt,
        };
        report.evidence = [{ kind: "dependency-delta", ref: delta.digest },
          { kind: report.available ? measure.kind : "changed-paths-mismatch", ref: report.available ? measure.sha256 : mismatches.slice(0, 4).join(",") }];
      }
      return observation;
    },
    observeArtifacts: async request => {
      const refs = (request.refs ?? request.artifacts ?? []) as { key?: string; path?: string; expectedSha256?: string }[];
      const results = refs.map(ref => {
        const path = typeof ref.path === "string" ? ref.path : null;
        if (path === null) return { key: ref.key, available: false, reason: "no-path" };
        try {
          const resolved = deps.fs.resolve(path);
          if (!deps.fs.exists(resolved)) return { key: ref.key, available: false, reason: "absent" };
          const st = deps.fs.lstat(resolved);
          if (!st.isFile || st.isSymlink) return { key: ref.key, available: false, reason: "not-regular-file" };
          const bytes = deps.fs.readFile(resolved);
          const sha = sha256Hex(bytes);
          return {
            key: ref.key, available: ref.expectedSha256 === undefined || ref.expectedSha256 === sha,
            sha256: sha, bytes: bytes.byteLength,
            ...(ref.expectedSha256 !== undefined && ref.expectedSha256 !== sha ? { reason: "sha-mismatch" } : {}),
          };
        } catch (error) {
          return { key: ref.key, available: false, reason: (error as Error).message.slice(0, 128) };
        }
      });
      return { results };
    },
    observeAction: async request => {
      const kind = typeof request.actionKind === "string" ? request.actionKind : (request.action as { kind?: string } | undefined)?.kind;
      const agentId = typeof request.agentId === "string" ? request.agentId : ((request.action as { host?: { agentId?: string } } | undefined)?.host?.agentId ?? null);
      const api = host();
      if (api === null) return { resolved: false, reason: "host-unconnected" };
      if (kind === "send" && typeof agentId === "string") {
        const messageId = typeof request.messageId === "string" ? request.messageId : null;
        const ledger = recheck(deps, ctx);
        if (isRejection(ledger)) return { resolved: false, reason: "ledger-unreadable" };
        const action = typeof request.actionId === "string" ? latestTaskEntity(ledger, request.actionId) : null;
        const attempt = action?.kind === "action" && action.attemptId !== null ? latestAttempt(ledger, action.attemptId) : null;
        if (action?.kind !== "action" || action.actionKind !== "send" || action.body?.messageId !== messageId
          || attempt?.host.agentId !== agentId) return { resolved: false, reason: "send-identity-mismatch" };
        const page = await api.agents.ref(agentId).timeline.refetch({ limit: 50 });
        const items = page.entries ?? [];
        const found = messageId !== null && items.some(e =>
          e.item?.type === "user_message" && (e.item.messageId === messageId || e.item.clientMessageId === messageId));
        return { resolved: found, evidence: found ? { kind: "timeline-messageId", messageId } : { kind: "timeline-page", scanned: items.length } };
      }
      if (kind === "archive" && typeof agentId === "string") {
        const refetched = await api.agents.ref(agentId).refresh();
        const agent = refetched?.agent ?? null;
        return { resolved: false, reason: "archive-effect-identity-unavailable", agent };
      }
      if (kind === "create" && typeof request.attemptId === "string") {
        // Adoption scan — label-filtered listing; empty page is never
        // absence proof, a single positive match adopts.
        const ledger = recheck(deps, ctx);
        if (isRejection(ledger)) return { resolved: false, reason: "ledger-unreadable" };
        const attempt = latestAttempt(ledger, request.attemptId);
        const action = typeof request.actionId === "string" ? latestTaskEntity(ledger, request.actionId) : null;
        if (attempt === null || action?.kind !== "action" || action.actionKind !== "create"
          || action.attemptId !== attempt.attemptId || attempt.placement.cwd === null) {
          return { resolved: false, reason: "create-identity-unavailable" };
        }
        const page = typeof agentId === "string"
          ? { entries: [{ agent: (await api.agents.ref(agentId).refresh())?.agent ?? null }], pageInfo: { hasMore: false } }
          : await api.agents.list({ filter: { labels: { "slp.attempt": request.attemptId } }, page: { limit: 50 } });
        const entries = page.entries;
        const candidate = entries.length === 1 && page.pageInfo?.hasMore === false ? entries[0].agent : null;
        if (candidate === null) return { resolved: false, candidates: entries.length, reason: "create-candidates-incomplete-or-ambiguous" };
        const verification = await verifySeat(api, candidate.id, {
          provider: attempt.seatPin.provider, model: attempt.seatPin.model, cwd: attempt.placement.cwd,
          workspaceId: attempt.placement.workspaceId, parent: action.callerAgentId,
          modeId: attempt.seatPin.modeId, thinkingOptionId: attempt.seatPin.thinkingOptionId, features: attempt.seatPin.features,
          labels: managedCreateLabels(ledger, attempt, ctx.repoKey),
        });
        const labels = action.body?.labels;
        const labelMatch = typeof labels === "object" && labels !== null && !Array.isArray(labels)
          && Object.entries(labels).every(([key, value]) => candidate.labels?.[key] === value);
        return {
          resolved: verification.ok && labelMatch, agent: candidate, verification,
          evidence: { kind: "exact-create-label-tuple", actionId: action.actionId, attemptId: attempt.attemptId },
        };
      }
      return { resolved: false, reason: `unsupported action kind ${String(kind)}` };
    },
    observeResources: async request => {
      const resources = Array.isArray(request.resources) ? request.resources : [];
      const api = host();
      const results = await Promise.all(resources.map(async resource => {
        if (typeof resource !== "object" || resource === null) return { resolved: false, positive: false, reason: "resource-shape" };
        const ledger = recheck(deps, ctx);
        if (isRejection(ledger)) return { resolved: false, positive: false, reason: "ledger-unreadable" };
        if (request.ledgerRevision !== ledger.revision) return { resourceId: resource.resourceId ?? null,
          kind: resource.kind ?? "unknown", positive: false, quiescent: false, evidence: [], reason: "resource-ledger-drift" };
        const row = typeof resource.resourceId === "string" ? latestTaskEntity(ledger, resource.resourceId) : null;
        const exact = row?.kind === "resource" && row.resourceKind === resource.kind
          && row.resourceKey === resource.resourceKey && row.attemptId === resource.attemptId && row.actionId === resource.actionId;
        const identity = { resourceId: resource.resourceId ?? null, kind: resource.kind ?? "unknown", positive: false, evidence: [] };
        if (resource.kind === "agent" && typeof resource.agentId === "string" && api !== null) {
          const refetched = await api.agents.ref(resource.agentId).refresh();
          const agent = refetched?.agent ?? null;
          return {
            ...identity, agentId: resource.agentId,
            archived: agent !== null && agent.archivedAt !== null && agent.archivedAt !== undefined,
            status: agent?.status ?? null,
            quiescent: false, reason: "host-process-quiescence-unavailable",
          };
        }
        if ((resource.kind === "worktree" || resource.kind === "scratch") && typeof resource.path === "string") {
          const exists = deps.fs.exists(resource.path);
          const action = exact && row.actionId !== null ? latestIntegration(ledger, row.actionId) : null;
          const removed = action?.receipt?.removed;
          const errors = action?.receipt?.errors;
          const ruled = typeof resource.releaseRuling === "object" && resource.releaseRuling !== null
            && resource.releaseRuling.resourceId === row?.entityId && resource.releaseRuling.expectedResourceRevision === row?.revision;
          const positive = exact && ruled && !exists && action?.state === "observed" && action.phase === "discharge"
            && action.receipt?.status === "observed" && Array.isArray(removed) && removed.includes(row.resourceKey)
            && Array.isArray(errors) && errors.length === 0 && resource.path === row.resourceKey;
          return { ...identity, path: resource.path, exists, positive,
            quiescent: positive,
            ...(positive ? { evidence: [{ kind: "admitted-discharge", ref: action.entrySha256 }] }
              : { reason: "matching-positive-discharge-unavailable" }) };
        }
        if (resource.kind === "membership" && typeof resource.membershipId === "string") {
          const membership = ledger.memberships.find(m => m.membershipId === resource.membershipId);
          return { ...identity, membershipId: resource.membershipId, state: membership?.state ?? "absent",
            revoked: membership?.revokedAt !== null && membership?.revokedAt !== undefined,
            quiescent: false, reason: "membership-state-is-not-process-quiescence" };
        }
        return { ...identity, resolved: false, quiescent: false, reason: "unsupported resource kind" };
      }));
      return { results };
    },
  };
}

const joinAdapterFree = (root: string, rel: string) => `${root.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;

// ---------------------------------------------------------------------------
// Host event observer — the bounded, fail-open lifecycle seam wired into
// at index.server.ts. Positive messageId correlation only; a matching
// user_message inside turn_ended.timeline binds the turn to the issued
// send action. Never upgrades on unrelated turn_started/refresh evidence.
// ---------------------------------------------------------------------------

export type TaskTurnEndedEvent = {
  agentId: string;
  turnId?: string;
  outcome?: "completed" | "failed" | "canceled" | string;
  timeline?: { type: string; messageId?: string; clientMessageId?: string }[];
};

export function createTaskHostEventObserver(deps: TaskExecutionDeps): {
  onTurnEnded(ctx: RunnerCtx, event: TaskTurnEndedEvent): Promise<void>;
} {
  return {
    onTurnEnded: async (ctx, event) => {
      try {
        const ledger = readLedger(deps, ctx.repoKey);
        if (isRejection(ledger)) return;
        const messageIds = new Set(
          (event.timeline ?? [])
            .filter(i => i.type === "user_message")
            .flatMap(i => [i.messageId, i.clientMessageId].filter((v): v is string => typeof v === "string")),
        );
        if (messageIds.size === 0) return;
        const pending = actionRows(ledger).find(row => {
          const body = row.body;
          const attempt = row.attemptId === null ? null : latestAttempt(ledger, row.attemptId);
          return typeof body?.messageId === "string" && messageIds.has(body.messageId)
            && (row.state === "issued" || row.state === "uncertain")
            && row.actionKind === "send" && attempt?.host.agentId === event.agentId;
        });
        if (pending === undefined) return;
        const actionId = pending.actionId;
        await deps.task.runTaskEffect(ctx, {
          operation: "observe", requestId: `turn-ended-${actionId}`,
          actionId, actionKind: "send",
          receipt: {
            status: "observed", turnId: event.turnId ?? null,
            outcome: event.outcome ?? "unknown",
            correlation: "messageId",
            messageId: pending.body?.messageId,
          },
        }, taskDeps(ctx, deps));
      } catch {
        // Fail-open by contract — lifecycle observation never throws into
        // the hook layer.
      }
    },
  };
}
