// plugin/server/manager.ts — sole owner of the mutation mutex, state
// transitions and connected SDK calls (§3 RPCs, §8 flows, §9 machine).
//
// Every mutation is journaled before it is executed: acceptance writes the
// pending intent synchronously (no materialize/patch await in the handler),
// then one worker per process drives phases accepted → materialized → prepared
// → patch-dispatched → verified → terminal, with each phase a single atomic
// receipt replacement. A patch attempt's settlement is journaled both ways;
// outcome-unknown results never get a blind compensating patch — they become
// RECOVERY_REQUIRED and wait for reconcile inspect/complete/restore-before.

import { randomUUID } from "node:crypto";

import { join } from "node:path";
import {
  ActivateInput,
  DeactivateInput,
  MAX_RPC_BYTES,
  OperationConflict,
  ReconcileInput,
  StatusInput,
  normalizeConflict,
  type ActivateRequest,
  type BindingValue,
  type ConflictCode,
  type ConflictValue,
  type ConnectedDaemon,
  type DeactivateRequest,
  type IntentValue,
  type Manager,
  type ManagerDeps,
  type OperationViewValue,
  type PlanValue,
  type ReceiptValue,
  type ReconcileRequest,
  type StartResult,
  type StateValue,
  type StatusRequest,
  type StatusResult,
} from "../shared/contracts.ts";
import { createJournal, emptyReceipt, findOperation, pendingOperation } from "./journal.ts";
import { receiptMatchesTarget, resolveDaemonHome } from "./daemon-home.ts";
import { readLanguage, readRoleRouting } from "./state-store.ts";
import { OWNED_PROVIDER_ID_RE } from "../shared/runtime/families.ts";
import {
  FAMILIES,
  OWNED_PROVIDER_IDS,
  OWNED_PROFILE_IDS,
  canonicalSha256,
  effectiveView,
  extractProjection,
  profilesArray,
  readRawConfig,
  sha256Hex,
  snapshotFrom,
  assertMetadataGenerationAgreement,
  assertRawLiveAgreement,
  canonicalEqual,
  canonicalJson,
  isRecord,
  mcpFlagPresence,
  providersRecord,
  type EffectiveView,
} from "./config-view.ts";
import {
  assertNoDependentReferences,
  assertPersistedCompatible,
  classifyState,
  patchForDirection,
  planActivation,
  planDeactivation,
} from "./config-transaction.ts";

const MAX_CONFLICTS = 64;
const POLL_PENDING_MS = 1000;
const POLL_TERMINAL_MS = 0;

interface HomeContext {
  canonicalHome: string;
  configPath: string;
  stableRoot: string;
}

function conflictOf(
  code: ConflictCode,
  message: string,
  detail?: { path?: string | null; expectedSha256?: string | null; actualSha256?: string | null },
): ConflictValue {
  return normalizeConflict({
    code,
    path: detail?.path ?? null,
    message,
    expectedSha256: detail?.expectedSha256 ?? null,
    actualSha256: detail?.actualSha256 ?? null,
  });
}

function toConflict(error: unknown): ConflictValue {
  if (error instanceof OperationConflict) return error.toConflict();
  const err = error as NodeJS.ErrnoException;
  const tag = typeof err?.code === "string" ? `${err.code}: ` : "";
  return conflictOf("IO_FAILURE", `${tag}${(error as Error)?.message ?? String(error)}`.slice(0, 2000));
}

function opView(intent: IntentValue): OperationViewValue {
  return {
    operationId: intent.operationId,
    kind: intent.kind,
    phase: intent.phase,
    outcome: intent.outcome,
    startedAt: intent.acceptedAt,
    updatedAt: intent.updatedAt,
    completedAt: intent.completedAt,
  };
}

/** Truncate the conflict list to schema+size bounds; the last entry reports omissions. */
function boundConflicts(conflicts: ConflictValue[]): ConflictValue[] {
  if (conflicts.length > MAX_CONFLICTS) {
    const omitted = conflicts.length - (MAX_CONFLICTS - 1);
    conflicts = conflicts.slice(0, MAX_CONFLICTS - 1);
    conflicts.push(conflictOf("IO_FAILURE", `${omitted} additional conflict(s) omitted`));
  }
  return conflicts;
}

function bounded(output: StartResult): StartResult;
function bounded(output: StatusResult): StatusResult;
function bounded(output: StartResult | StatusResult): StartResult | StatusResult {
  const fits = (v: StartResult | StatusResult) =>
    Buffer.byteLength(JSON.stringify(v)) <= MAX_RPC_BYTES;
  let result = output;
  // The bound applies to the ENTIRE serialized response, not just conflicts:
  // shed conflicts first (largest unbounded collection)...
  while (!fits(result) && result.conflicts.length > 1) {
    const conflicts = result.conflicts.slice(0, result.conflicts.length - 1);
    conflicts[conflicts.length - 1] = {
      ...conflicts[conflicts.length - 1],
      message: "additional conflicts omitted to fit the RPC size bound",
    };
    result = { ...result, conflicts };
  }
  // ...then cap free-form fields — family paths/version strings come from
  // the executable seam and are not size-guaranteed upstream.
  if (!fits(result) && "families" in result) {
    const cap = (s: string | null, n: number) =>
      s !== null && s.length > n ? `${s.slice(0, n)}…` : s;
    result = {
      ...result,
      families: result.families.map(f => ({
        ...f,
        binaryPath: cap(f.binaryPath, 512),
        observedVersion: cap(f.observedVersion, 512),
      })),
    };
  }
  // ...last resort: rebuild a minimal shape that is schema-valid and small
  // by construction. Elided data must never be rendered as absent: state,
  // operation, binding identity and the retained count stay real — only
  // over-long free-form strings are shortened (with an ellipsis marker),
  // which still parses as AbsolutePath/plain strings. The bound is enforced
  // on the SERIALIZED result of the final step, not assumed: each tier sheds
  // more diagnostics and re-checks, down to a floor that is small by
  // construction. The marker conflict tells the client the response was
  // truncated.
  if (!fits(result)) {
    const marker = conflictOf("IO_FAILURE", "response truncated to fit the 64 KiB RPC bound");
    const cap = (s: string | null, n: number): string | null =>
      s !== null && s.length > n ? `${s.slice(0, n)}…` : s;
    // A preserved-shape rebuild at a given string cap: identity fields
    // (shas, state, operation, counts, timestamps) always survive verbatim.
    const shrinkTo = (n: number): StartResult | StatusResult => {
      const conflicts = [
        ...result.conflicts.map(c => ({
          ...c,
          path: cap(c.path, n),
          message: cap(c.message, n) as string,
        })),
        marker,
      ];
      if ("families" in result) {
        return {
          schemaVersion: 1,
          target: { ...result.target, daemonHome: cap(result.target.daemonHome, n) as string },
          state: result.state,
          embeddedCandidateSha256: result.embeddedCandidateSha256,
          binding: result.binding === null
            ? null
            : {
                ...result.binding,
                runtimePath: cap(result.binding.runtimePath, n) as string,
                nodePath: cap(result.binding.nodePath, n) as string,
              },
          families: result.families,
          operation: result.operation,
          conflicts,
          verifiedAt: result.verifiedAt,
          retainedRuntimeCount: result.retainedRuntimeCount,
          managedProfiles: result.managedProfiles,
          communicationLanguage: cap(result.communicationLanguage, n),
          liveAcceptance: "not-established-by-this-rpc",
        };
      }
      return {
        schemaVersion: 1,
        accepted: result.accepted,
        state: result.state,
        operation: result.operation,
        conflicts,
        pollAfterMs: result.pollAfterMs,
      };
    };
    result = shrinkTo(512);
    // Still over: prior conflicts are the largest remaining diagnostics —
    // shed them, keeping the truncation marker.
    if (!fits(result)) result = { ...result, conflicts: [marker] };
    // Still over: family probe detail is the next-largest block — report it
    // honestly as unresolved rather than shrinking paths past usefulness.
    if (!fits(result) && "families" in result) {
      result = {
        ...result,
        families: result.families.map(f => ({
          family: f.family,
          availability: "unresolved" as const,
          binaryPath: null,
          observedVersion: null,
        })),
      };
    }
    // Absolute floor: shrink every remaining free-form string hard.
    if (!fits(result)) result = shrinkTo(64);
  }
  return result;
}

export function createManager(deps: ManagerDeps): Manager {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const uuid = deps.uuid ?? (() => randomUUID());
  const platform = deps.platform ?? process.platform;
  const bootId = uuid();
  const journal = createJournal({ uuid, platform });

  let closed = false;
  let mutexHeld = false;
  let inFlightOpId: string | null = null;
  /** Pending ops whose worker died without a terminal journal write. */
  const deadOps = new Set<string>();

  function tryAcquire(): (() => void) | null {
    if (mutexHeld) return null;
    mutexHeld = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        mutexHeld = false;
      }
    };
  }

  // -------------------------------------------------------------------------
  // Output helpers
  // -------------------------------------------------------------------------

  function startReject(
    state: StateValue,
    conflicts: ConflictValue[],
  ): StartResult {
    return bounded({
      schemaVersion: 1,
      accepted: false,
      state,
      operation: null,
      conflicts: boundConflicts(conflicts.length > 0 ? conflicts : [conflictOf("IO_FAILURE", "rejected")]),
      pollAfterMs: POLL_TERMINAL_MS,
    });
  }

  function startAccepted(
    state: StateValue,
    intent: IntentValue | null,
    conflicts: ConflictValue[] = [],
  ): StartResult {
    return bounded({
      schemaVersion: 1,
      accepted: true,
      state,
      operation: intent ? opView(intent) : null,
      conflicts: boundConflicts(conflicts),
      pollAfterMs: intent && intent.outcome === "pending" ? POLL_PENDING_MS : POLL_TERMINAL_MS,
    });
  }

  function rejectWith(state: StateValue, error: unknown): StartResult {
    if (error instanceof OperationConflict) return startReject(state, [error.toConflict()]);
    return startReject(state, [toConflict(error)]);
  }

  // -------------------------------------------------------------------------
  // Home verification (§8.1): canonical realpath, regular config.json, real dirs
  // — shared implementation in server/daemon-home.ts; this caller keeps its
  // distinct "not a link" message for a non-regular config.json.
  // -------------------------------------------------------------------------

  const resolveHome = (target: { hostId: string; daemonHome: string }): HomeContext =>
    resolveDaemonHome(target, "config.json must be a regular file, not a link");

  // -------------------------------------------------------------------------
  // Journal transitions — one atomic receipt replacement per phase
  // -------------------------------------------------------------------------

  function transition(
    ctx: HomeContext,
    mutate: (receipt: ReceiptValue) => void,
  ): ReceiptValue {
    const receipt = journal.read(ctx.stableRoot);
    if (!receipt) throw new Error("receipt vanished during operation");
    const next = JSON.parse(JSON.stringify(receipt)) as ReceiptValue;
    mutate(next);
    next.revision = receipt.revision + 1;
    next.updatedAt = now();
    journal.write(ctx.stableRoot, next);
    return next;
  }

  /** Like transition, but creates the revision-0 receipt when none exists. */
  function transitionOrInit(
    ctx: HomeContext,
    hostId: string,
    mutate: (receipt: ReceiptValue) => void,
  ): ReceiptValue {
    const receipt = journal.read(ctx.stableRoot);
    const next = receipt
      ? (JSON.parse(JSON.stringify(receipt)) as ReceiptValue)
      : emptyReceipt({
          hostId,
          canonicalHome: ctx.canonicalHome,
          stableRoot: ctx.stableRoot,
          now: now(),
        });
    mutate(next);
    next.revision = (receipt?.revision ?? -1) + 1;
    next.updatedAt = now();
    journal.write(ctx.stableRoot, next);
    return next;
  }

  function requestSha256(method: string, input: unknown): string {
    return canonicalSha256({ method, input });
  }

  /** Prior steady state to restore after a prepatch failure. */
  function priorState(receipt: ReceiptValue): StateValue {
    return receipt.binding ? "ACTIVE" : "INACTIVE";
  }

  /**
   * A pending op is "interrupted" when it belongs to another boot, or to this
   * boot but its worker ended without a durable outcome (journal failure).
   */
  function isInterrupted(intent: IntentValue): boolean {
    return intent.bootId !== bootId || deadOps.has(intent.operationId);
  }

  // -------------------------------------------------------------------------
  // Terminal write inside a worker
  // -------------------------------------------------------------------------

  function recordFailure(ctx: HomeContext, opId: string, error: unknown): void {
    const conflict = toConflict(error);
    try {
      transition(ctx, receipt => {
        const op = findOperation(receipt, opId);
        if (!op) return;
        const ambiguous = op.patchAttempts.some(
          attempt => attempt.result === "pending" || attempt.result === "outcome-unknown" || attempt.result === "returned",
        );
        op.conflicts = [...op.conflicts, conflict].slice(0, MAX_CONFLICTS);
        op.updatedAt = now();
        if (ambiguous) {
          // A patch attempt exists whose settlement did not cleanly classify:
          // mark recovery-required, keep evidence, prohibit normal mutation.
          if (op.patchAttempts.some(a => a.result === "pending" || a.result === "outcome-unknown")) {
            op.conflicts = [
              ...op.conflicts,
              conflictOf(
                "PATCH_OUTCOME_UNKNOWN",
                "a dispatched config.patch may still be running; establish a quiescent daemon, then reconcile",
              ),
            ].slice(0, MAX_CONFLICTS);
          }
          op.outcome = "recovery-required";
          receipt.state = "RECOVERY_REQUIRED";
          receipt.activeOperationId = null;
        } else {
          op.outcome = "failed";
          op.phase = "terminal";
          op.completedAt = now();
          // Restore the state recorded at this op's acceptance, not a
          // binding-derived recomputation: reconcile/inspect-with-subject ops
          // enter under RECOVERY_REQUIRED, and falling back to
          // priorState(binding) would mask the unresolved recovery evidence
          // the op just re-observed. Intents journaled by older builds lack
          // the field — reconcile-kind ops recover RECOVERY_REQUIRED (their
          // acceptance always entered recovery bookkeeping), while
          // activate/deactivate keep the binding-derived semantics their
          // pre-op state genuinely is.
          receipt.state =
            op.priorState ??
            (op.kind === "reconcile" ? "RECOVERY_REQUIRED" : priorState(receipt));
          receipt.activeOperationId = null;
        }
      });
    } catch {
      // Even the failure record failed — mark the op dead so status and new
      // starts report RECOVERY_REQUIRED instead of a stuck ACTIVATING.
      deadOps.add(opId);
    }
  }

  function effectiveSnapshotEqual(a: EffectiveView, b: EffectiveView): boolean {
    return (
      a.enabled === b.enabled &&
      a.injectIntoAgents === b.injectIntoAgents &&
      canonicalEqual(a.agentProfiles.value, b.agentProfiles.value) &&
      a.agentProfiles.present === b.agentProfiles.present &&
      // §8.2.4 — metadataGeneration.providers also carries dependent
      // references to owned providers; a change landing between plan and
      // dispatch must surface as divergence, not be silently filtered.
      canonicalEqual(a.metadataProviders, b.metadataProviders) &&
      OWNED_PROVIDER_IDS.every(id => {
        const pa = a.providers[id];
        const pb = b.providers[id];
        if (pa === undefined || pb === undefined) return pa === pb;
        return canonicalEqual(pa, pb);
      })
    );
  }

  /** §8.2.4 — re-read and compare to the recorded plan before dispatch. */
  function assertPlanCurrent(
    ctx: HomeContext,
    plan: PlanValue,
    liveBefore: EffectiveView,
    liveAfter: EffectiveView,
  ): void {
    const raw2 = readRawConfig(ctx.configPath);
    if (sha256Hex(raw2.bytes) !== plan.before.rawConfigSha256) {
      throw new OperationConflict(
        "RAW_LIVE_DIVERGENCE",
        "config.json changed while the plan was being prepared",
        { path: ctx.configPath },
      );
    }
    if (!effectiveSnapshotEqual(liveBefore, liveAfter)) {
      throw new OperationConflict(
        "RAW_LIVE_DIVERGENCE",
        "live daemon config changed while the plan was being prepared",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Patch dispatch with settlement journaling (§8.2.5–8.2.6)
  // -------------------------------------------------------------------------

  type PatchSettlement = "returned" | "threw" | "outcome-unknown";

  async function dispatchPatch(
    ctx: HomeContext,
    daemon: ConnectedDaemon,
    opId: string,
    patch: Record<string, unknown>,
  ): Promise<PatchSettlement> {
    const attempt = {
      requestId: uuid(),
      dispatchedAt: now(),
      settledAt: null as string | null,
      result: "pending" as IntentValue["patchAttempts"][number]["result"],
    };
    transition(ctx, receipt => {
      const op = findOperation(receipt, opId);
      if (!op) throw new Error("operation vanished");
      op.phase = "patch-dispatched";
      op.updatedAt = now();
      op.patchAttempts.push(attempt);
    });
    let settlement: PatchSettlement;
    let promise: Promise<unknown>;
    try {
      promise = daemon.config.patch(patch, attempt.requestId);
    } catch {
      // A synchronous throw means the request never reached the wire.
      settlement = "threw";
      transition(ctx, receipt => {
        const op = findOperation(receipt, opId);
        if (op) {
          const last = op.patchAttempts[op.patchAttempts.length - 1];
          if (last.requestId === attempt.requestId) {
            last.result = "threw";
            last.settledAt = now();
          }
          op.updatedAt = now();
        }
      });
      return settlement;
    }
    try {
      await promise;
      settlement = "returned";
    } catch {
      settlement = "outcome-unknown";
    }
    transition(ctx, receipt => {
      const op = findOperation(receipt, opId);
      if (op) {
        const last = op.patchAttempts[op.patchAttempts.length - 1];
        if (last.requestId === attempt.requestId) {
          last.result = settlement;
          last.settledAt = settlement === "outcome-unknown" ? null : now();
        }
        op.updatedAt = now();
      }
    });
    return settlement;
  }

  /** Terminal 'failed' write: prepatch/settled-no-op failure, prior state. */
  function failTerminal(ctx: HomeContext, opId: string, conflicts: ConflictValue[]): void {
    transition(ctx, receipt => {
      const op = findOperation(receipt, opId);
      if (!op) return;
      op.outcome = "failed";
      op.phase = "terminal";
      op.completedAt = now();
      op.updatedAt = now();
      op.conflicts = [...op.conflicts, ...conflicts].slice(0, MAX_CONFLICTS);
      // Same rule as recordFailure: restore the state the op recorded at
      // acceptance — a reconcile that found its post-patch endpoint unmet
      // must not restore a binding-derived state over recovery evidence.
      receipt.state =
        op.priorState ??
        (op.kind === "reconcile" ? "RECOVERY_REQUIRED" : priorState(receipt));
      receipt.activeOperationId = null;
    });
  }

  /** Nonterminal 'recovery-required' write with state RECOVERY_REQUIRED. */
  function markRecovery(ctx: HomeContext, opId: string, conflicts: ConflictValue[]): void {
    transition(ctx, receipt => {
      const op = findOperation(receipt, opId);
      if (!op) return;
      op.outcome = "recovery-required";
      op.updatedAt = now();
      op.conflicts = [...op.conflicts, ...conflicts].slice(0, MAX_CONFLICTS);
      receipt.state = "RECOVERY_REQUIRED";
      receipt.activeOperationId = null;
    });
  }

  /**
   * §8.2.6 settle classification after a returned patch. 'after' → caller
   * proceeds to commit; 'before' → finish failed in the prior state;
   * divergent/partial → RECOVERY_REQUIRED with the evidence recorded.
   */
  function settleAfterPatch(
    ctx: HomeContext,
    opId: string,
    plan: PlanValue,
    liveConfig: unknown,
  ): "after" | "done" {
    const cls = classifyState(readRawConfig(ctx.configPath).json, liveConfig, plan);
    if (cls.class === "after") return "after";
    if (cls.class === "before") {
      failTerminal(ctx, opId, [
        conflictOf("IO_FAILURE", "config.patch returned but persisted state did not change"),
      ]);
      return "done";
    }
    markRecovery(ctx, opId, [
      conflictOf(
        cls.class === "divergent" ? "RAW_LIVE_DIVERGENCE" : "RECOVERY_REQUIRED",
        `post-patch state is ${cls.class}: ${cls.problems.slice(0, 8).join("; ") || "no detail"}`,
        { path: ctx.configPath },
      ),
    ]);
    return "done";
  }

  // -------------------------------------------------------------------------
  // Shared preconditions evaluated at acceptance time
  // -------------------------------------------------------------------------

  /** Home verification + journal read + target match. Idempotency callers run next. */
  function resolveReceipt(input: {
    target: { hostId: string; daemonHome: string };
  }): { ctx: HomeContext; receipt: ReceiptValue | null } {
    const ctx = resolveHome(input.target);
    const receipt = journal.read(ctx.stableRoot);
    if (
      receipt &&
      !receiptMatchesTarget(receipt.target, {
        hostId: input.target.hostId,
        canonicalHome: ctx.canonicalHome,
      })
    ) {
      throw new OperationConflict(
        "TARGET_MISMATCH",
        "receipt target does not match this daemon home/host; refusing to retarget silently",
        { path: journal.receiptPath(ctx.stableRoot) },
      );
    }
    return { ctx, receipt };
  }

  /**
   * Mutation admission, after the idempotency check: one worker per process,
   * foreign-boot pending ops are recovery subjects, RECOVERY_REQUIRED bars
   * normal mutation.
   */
  function assertMutationAdmission(
    receipt: ReceiptValue | null,
    opts: { adoptIdentical?: boolean } = {},
  ): void {
    if (inFlightOpId !== null) {
      throw new OperationConflict("BUSY", `operation ${inFlightOpId} is in flight`);
    }
    if (!receipt) return;
    const pending = pendingOperation(receipt);
    if (pending) {
      if (isInterrupted(pending)) {
        throw new OperationConflict(
          "RECOVERY_REQUIRED",
          `operation ${pending.operationId} interrupted at phase ${pending.phase}; reconcile inspect first`,
        );
      }
      throw new OperationConflict("BUSY", `operation ${pending.operationId} is in flight`);
    }
    if (receipt.state === "RECOVERY_REQUIRED") {
      // Distinguish unresolved-patch recovery from recovery whose resolution
      // IS adoption/inspection (§8.4): a binding-less receipt holding
      // RECOVERY_REQUIRED with no recovery-required op is the
      // "pending explicit adoption" state — adoptIdentical is the sanctioned
      // exit. Unresolved-patch ops keep blocking every mutation.
      const unresolvedPatch = receipt.operations.some(op => op.outcome === "recovery-required");
      const adoptionResolves =
        opts.adoptIdentical === true && receipt.binding === null && !unresolvedPatch;
      if (!adoptionResolves) {
        throw new OperationConflict(
          "RECOVERY_REQUIRED",
          "journal requires reconciliation before further mutation",
        );
      }
    }
  }

  /** Reconcile admission: a foreign/dead pending op is the recovery subject. */
  function assertReconcileAdmission(receipt: ReceiptValue | null): void {
    if (inFlightOpId !== null) {
      throw new OperationConflict("BUSY", `operation ${inFlightOpId} is in flight`);
    }
    if (!receipt) return;
    const pending = pendingOperation(receipt);
    if (pending && !isInterrupted(pending)) {
      throw new OperationConflict("BUSY", `operation ${pending.operationId} is in flight`);
    }
  }

  function existingOperationReply(
    receipt: ReceiptValue,
    requestSha: string,
    operationId: string,
  ): StartResult | "conflict" | null {
    const existing = findOperation(receipt, operationId);
    if (!existing) return null;
    if (existing.requestSha256 !== requestSha) return "conflict";
    return startAccepted(receipt.state, existing, existing.conflicts);
  }

  /**
   * Shared mutation preamble: schema parse, closed/size/platform gates, mutex
   * acquisition, receipt resolution, idempotent replay (BEFORE admission —
   * an accepted op replays even when admission would reject a new one), and
   * the per-kind admission check. A completed `{ reply }` always returns with
   * the mutex released — including when the preamble throws before any
   * context exists. A successful admission transfers `release` ownership to
   * the caller, which must release on every exit; workers are only ever
   * scheduled to run after the critical section ends. `adoptIdentical` is an
   * activate-only admission parameter.
   */
  function admitMutation<
    Req extends { operationId: string; target: { hostId: string; daemonHome: string } },
  >(args: {
    schema: {
      safeParse(
        input: unknown,
      ):
        | { success: true; data: Req }
        | { success: false; error: { issues: { message?: string }[] } };
    };
    input: unknown;
    kind: "activate" | "deactivate" | "reconcile";
  }):
    | { reply: StartResult }
    | {
        request: Req;
        ctx: HomeContext;
        receipt: ReceiptValue | null;
        state: StateValue;
        requestSha: string;
        release: () => void;
      } {
    const { schema, input, kind } = args;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return {
        reply: startReject("INACTIVE", [
          conflictOf(
            "INVALID_REQUEST",
            `invalid ${kind} input: ${parsed.error.issues[0]?.message ?? "schema"}`,
          ),
        ]),
      };
    }
    const request = parsed.data;
    if (closed) {
      return { reply: startReject("INACTIVE", [conflictOf("INVALID_REQUEST", "manager is closed")]) };
    }
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_RPC_BYTES) {
      return {
        reply: startReject("INACTIVE", [
          conflictOf("INVALID_REQUEST", "input exceeds the 64 KiB bound"),
        ]),
      };
    }
    if (platform === "win32") {
      return {
        reply: startReject("INACTIVE", [
          conflictOf("UNSUPPORTED_PLATFORM", "SLP plugin transport is POSIX-only in v1"),
        ]),
      };
    }
    const release = tryAcquire();
    if (!release) {
      return {
        reply: startReject("INACTIVE", [
          conflictOf("BUSY", "another request is being evaluated"),
        ]),
      };
    }
    // The mutex is held from here on: every reply or throw below releases it;
    // only a successful admission hands `release` to the caller.
    let owned = true;
    try {
      const { ctx, receipt } = resolveReceipt(request);
      const state = receipt?.state ?? "INACTIVE";
      const requestSha = requestSha256(kind, request);
      if (receipt) {
        const reply = existingOperationReply(receipt, requestSha, request.operationId);
        if (reply === "conflict") {
          return {
            reply: startReject(state, [
              conflictOf(
                "IDEMPOTENCY_CONFLICT",
                `operationId ${request.operationId} was already used with a different payload`,
              ),
            ]),
          };
        }
        if (reply) return { reply };
      }
      if (kind === "reconcile") {
        assertReconcileAdmission(receipt);
      } else {
        assertMutationAdmission(receipt, {
          adoptIdentical:
            kind === "activate"
              ? (request as { adoptIdentical?: boolean }).adoptIdentical
              : undefined,
        });
      }
      owned = false;
      return { request, ctx, receipt, state, requestSha, release };
    } catch (error) {
      const receipt = safeRead(ctx_or_null(input as { target: { daemonHome: string } }));
      return { reply: rejectWith(receipt?.state ?? "INACTIVE", error) };
    } finally {
      if (owned) release();
    }
  }

  // -------------------------------------------------------------------------
  // activate
  // -------------------------------------------------------------------------

  async function activate(input: ActivateRequest, daemon: ConnectedDaemon): Promise<StartResult> {
    const admission = admitMutation({ schema: ActivateInput, input, kind: "activate" });
    if ("reply" in admission) return admission.reply;
    const { request, ctx, receipt, state, requestSha, release } = admission;
    try {
      if (request.candidateSha256 !== deps.payload.candidate.sha256) {
        return startReject(state, [
          conflictOf("INVALID_REQUEST", "candidateSha256 must equal the embedded candidate", {
            expectedSha256: deps.payload.candidate.sha256,
            actualSha256: request.candidateSha256,
          }),
        ]);
      }
      if (request.initialProfileFamily !== undefined && receipt?.binding) {
        return startReject(state, [
          conflictOf(
            "INVALID_REQUEST",
            "initialProfileFamily applies only to a new binding; existing profile preferences are preserved on rebind",
          ),
        ]);
      }
      // `profiles` is accepted on an existing binding too: planActivation then
      // treats each role's prefs as an explicit edit applied over the live
      // entries (absent = preserve, null = clear, family = repoint provider)
      // under the same serialized operation and receipt as any other verify.
      const intent: IntentValue = {
        operationId: request.operationId,
        requestSha256: requestSha,
        kind: "activate",
        bootId,
        phase: "accepted",
        outcome: "pending",
        candidateSha256: request.candidateSha256,
        recoveryOf: null,
        recoveryAction: null,
        acceptedAt: now(),
        updatedAt: now(),
        completedAt: null,
        plan: null,
        // Pre-acceptance receipt state — the honest restore target if this op
        // fails before any patch settlement becomes ambiguous.
        priorState: state,
        patchAttempts: [],
        conflicts: [],
      };
      const next = transitionOrInit(ctx, request.target.hostId, r => {
        r.state = "ACTIVATING";
        r.activeOperationId = intent.operationId;
        r.operations.push(intent);
      });
      const recorded = findOperation(next, intent.operationId);
      inFlightOpId = intent.operationId;
      setImmediate(() => {
        runActivate(ctx, request, daemon).finally(() => {
          inFlightOpId = null;
        });
      });
      return startAccepted("ACTIVATING", recorded ?? intent);
    } catch (error) {
      const receipt = safeRead(ctx_or_null(input));
      return rejectWith(receipt?.state ?? "INACTIVE", error);
    } finally {
      release();
    }
  }

  function ctx_or_null(input: { target: { daemonHome: string } }): HomeContext | null {
    try {
      return resolveHome(input.target as { hostId: string; daemonHome: string });
    } catch {
      return null;
    }
  }

  function safeRead(ctx: HomeContext | null): ReceiptValue | null {
    if (!ctx) return null;
    try {
      return journal.read(ctx.stableRoot);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // activate worker
  // -------------------------------------------------------------------------

  async function runActivate(
    ctx: HomeContext,
    request: ActivateRequest,
    daemon: ConnectedDaemon,
  ): Promise<void> {
    const opId = request.operationId;
    try {
      const receipt = journal.read(ctx.stableRoot);
      if (!receipt) throw new Error("receipt vanished");
      const binding = receipt.binding;

      // 1. Resolve Node (explicit → prior → PATH) and family binaries
      //    (explicit → current PATH alias → prior).
      const resolution = await deps.executables.resolve({
        daemonHome: ctx.canonicalHome,
        stableRoot: ctx.stableRoot,
        nodePath: request.nodePath,
        binaries: request.binaries,
        prior: binding
          ? { node: binding.node, binaries: binding.binaries }
          : null,
      });

      // 2. Reuse published assets when the target is identical; otherwise
      //    materialize the candidate and publish a fresh launch set.
      const sameCandidate = binding?.candidateSha256 === request.candidateSha256;
      const sameResolution =
        binding !== null &&
        resolution.node.path === binding.node.path &&
        resolution.node.version === binding.node.version &&
        FAMILIES.every(family => {
          const next = resolution.binaries[family];
          const prev = binding.binaries[family];
          if (next.available !== prev.available) return false;
          if (!next.available) return true;
          return next.path === (prev as { path: string }).path && next.version === (prev as { version: string }).version;
        });
      let launchSet;
      let runtimePath: string;
      let payloadSha256: string;
      let activeCandidateSha256: string;
      if (binding && sameCandidate && sameResolution) {
        await deps.materializer.verifyPublished(binding.runtimePath, binding.candidateSha256, binding.payloadSha256);
        launchSet = await deps.launchers.verify(
          join(ctx.stableRoot, "launchers", binding.launchSetSha256),
        );
        runtimePath = binding.runtimePath;
        payloadSha256 = binding.payloadSha256;
        activeCandidateSha256 = binding.candidateSha256;
      } else {
        // §5.6 ordering is authoritative here: generate and publish first,
        // then record 'materialized' in the journal. §4's journal-first
        // phrasing conflicts with that verbatim sequence; the chosen order is
        // safe because an unjournaled published directory is content-
        // addressed, reusable by the next activation, and never by itself
        // proof of activation — only the durable journal binds it.
        const materialized = await deps.materializer.materialize(ctx.stableRoot, opId);
        launchSet = await deps.launchers.publish({
          daemonHome: ctx.canonicalHome,
          stableRoot: ctx.stableRoot,
          operationId: opId,
          candidate: { sha256: materialized.candidateSha256, runtimePath: materialized.runtimePath },
          node: resolution.node,
          binaries: resolution.binaries,
        });
        runtimePath = materialized.runtimePath;
        payloadSha256 = materialized.payloadSha256;
        activeCandidateSha256 = materialized.candidateSha256;
        const launchSetSha = launchSet.launchSetSha256;
        transition(ctx, r => {
          const op = findOperation(r, opId);
          if (!op) throw new Error("operation vanished");
          op.phase = "materialized";
          op.updatedAt = now();
          r.retained.push({
            candidateSha256: materialized.candidateSha256,
            payloadSha256: materialized.payloadSha256,
            runtimePath: materialized.runtimePath,
            launchSetSha256: launchSetSha,
            retainedAt: now(),
          });
        });
      }

      // 3. Preflight + plan.
      const raw = readRawConfig(ctx.configPath);
      const liveConfig = (await daemon.config.get()).config;
      const liveBefore = effectiveView(liveConfig);
      const { plan, patch } = planActivation({
        raw,
        effectiveConfig: liveConfig,
        input: request,
        previousBinding: binding,
        resolution,
        launchSet,
        candidateSha256: request.candidateSha256,
        payloadSha256,
        runtimePath,
        daemonHome: ctx.canonicalHome,
        // Settings-driven provider generation (Phase 1): read once at plan
        // time inside the serialized operation; a null/legacy routing keeps
        // the v1 all-twelve generation.
        roleRouting: readRoleRouting(ctx.stableRoot),
        now: now(),
      });
      transition(ctx, r => {
        const op = findOperation(r, opId);
        if (!op) throw new Error("operation vanished");
        op.phase = "prepared";
        op.updatedAt = now();
        op.plan = plan;
      });

      // 4. Re-read before dispatch.
      const liveAfter = effectiveView((await daemon.config.get()).config);
      assertPlanCurrent(ctx, plan, liveBefore, liveAfter);

      // 5. Exactly one patch when the raw state does not already match after.
      if (patch !== null) {
        const settlement = await dispatchPatch(ctx, daemon, opId, patch);
        if (settlement === "threw") {
          // Never dispatched: the before-state is intact by construction.
          throw new OperationConflict("IO_FAILURE", "config.patch threw before dispatch");
        }
        if (settlement === "outcome-unknown") {
          transition(ctx, r => {
            const op = findOperation(r, opId);
            if (!op) return;
            op.outcome = "recovery-required";
            op.updatedAt = now();
            op.conflicts = [
              ...op.conflicts,
              conflictOf(
                "PATCH_OUTCOME_UNKNOWN",
                "config.patch settlement unknown; the daemon operation may still be running — reconcile after quiescing",
              ),
            ].slice(0, MAX_CONFLICTS);
            r.state = "RECOVERY_REQUIRED";
            r.activeOperationId = null;
          });
          return;
        }
        // 6a. A dispatched patch needs endpoint classification: 'after' →
        // commit; 'before' → failed in the prior state; divergent/partial →
        // RECOVERY_REQUIRED. When patch is null the plan already proved the
        // raw state sits on the after endpoint, so no classification runs.
        const livePost = (await daemon.config.get()).config;
        if (settleAfterPatch(ctx, opId, plan, livePost) !== "after") return;
      }
      await deps.materializer.verifyPublished(runtimePath, activeCandidateSha256, payloadSha256);
      await deps.launchers.verify(
        join(ctx.stableRoot, "launchers", launchSet.launchSetSha256),
      );
      const verifiedSha = canonicalSha256(
        extractProjection(readRawConfig(ctx.configPath).json, "OWNERSHIP_DRIFT"),
      );
      transition(ctx, r => {
        const op = findOperation(r, opId);
        if (!op) throw new Error("operation vanished");
        op.phase = "verified";
        op.updatedAt = now();
      });

      // 7. Commit the binding.
      const identicalNoOp =
        binding !== null &&
        sameCandidate &&
        sameResolution &&
        patch === null &&
        canonicalEqual(binding.owned, plan.afterOwned);
      const committed = transition(ctx, r => {
        const op = findOperation(r, opId);
        if (!op) throw new Error("operation vanished");
        const nextBinding: BindingValue = {
          ...plan.nextBinding!,
          activatedAt:
            identicalNoOp && binding ? binding.activatedAt : (plan.nextBinding!.activatedAt),
          verifiedAt: now(),
          postPatchPersistedShapeSha256: verifiedSha,
        };
        r.binding = nextBinding;
        r.state = "ACTIVE";
        r.activeOperationId = null;
        op.outcome = identicalNoOp ? "no-op" : "succeeded";
        op.phase = "terminal";
        op.updatedAt = now();
        op.completedAt = now();
      });
      void committed;
    } catch (error) {
      await deps.materializer.discardStaging(ctx.stableRoot, opId).catch(() => {});
      recordFailure(ctx, opId, error);
    }
  }

  // -------------------------------------------------------------------------
  // deactivate
  // -------------------------------------------------------------------------

  async function deactivate(input: DeactivateRequest, daemon: ConnectedDaemon): Promise<StartResult> {
    const admission = admitMutation({ schema: DeactivateInput, input, kind: "deactivate" });
    if ("reply" in admission) return admission.reply;
    const { request, ctx, receipt, state, requestSha, release } = admission;
    try {
      if (!receipt?.binding) {
        // §8.3.2 no-op rules: matching last-deactivated binding, or a journal
        // that never owned a binding with no SLP entries present.
        const raw = readRawConfig(ctx.configPath);
        const projection = extractProjection(raw.json, "COLLISION");
        const anyOwned =
          OWNED_PROVIDER_IDS.some(id => projection.providers[id].present) ||
          projection.profiles.length > 0;
        const neverOwned =
          !receipt || (!receipt.binding && receipt.lastDeactivatedBindingSha256 === null);
        if (anyOwned) {
          return startReject(state, [
            conflictOf(
              "COLLISION",
              "SLP entries exist but no binding owns them; inspect or activate with adoptIdentical",
              { path: "agents.providers" },
            ),
          ]);
        }
        if (!neverOwned && request.expectedBindingSha256 !== receipt!.lastDeactivatedBindingSha256) {
          return startReject(state, [
            conflictOf(
              "COLLISION",
              "expectedBindingSha256 does not match the last deactivated binding",
              {
                expectedSha256: request.expectedBindingSha256,
                actualSha256: receipt!.lastDeactivatedBindingSha256,
              },
            ),
          ]);
        }
        const intent = terminalIntent(request, "deactivate", requestSha, "no-op", state);
        transitionOrInit(ctx, request.target.hostId, r => {
          r.operations.push(intent);
        });
        return startAccepted(state, intent);
      }

      if (request.expectedBindingSha256 !== receipt.binding.bindingSha256) {
        return startReject(state, [
          conflictOf("COLLISION", "expectedBindingSha256 does not match the active binding", {
            expectedSha256: request.expectedBindingSha256,
            actualSha256: receipt.binding.bindingSha256,
          }),
        ]);
      }

      const intent: IntentValue = {
        operationId: request.operationId,
        requestSha256: requestSha,
        kind: "deactivate",
        bootId,
        phase: "accepted",
        outcome: "pending",
        candidateSha256: receipt.binding.candidateSha256,
        recoveryOf: null,
        recoveryAction: null,
        acceptedAt: now(),
        updatedAt: now(),
        completedAt: null,
        plan: null,
        priorState: state,
        patchAttempts: [],
        conflicts: [],
      };
      const next = transition(ctx, r => {
        r.state = "DEACTIVATING";
        r.activeOperationId = intent.operationId;
        r.operations.push(intent);
      });
      const recorded = findOperation(next, intent.operationId);
      inFlightOpId = intent.operationId;
      setImmediate(() => {
        runDeactivate(ctx, request, daemon).finally(() => {
          inFlightOpId = null;
        });
      });
      return startAccepted("DEACTIVATING", recorded ?? intent);
    } catch (error) {
      const receipt = safeRead(ctx_or_null(input));
      return rejectWith(receipt?.state ?? "INACTIVE", error);
    } finally {
      release();
    }
  }

  function terminalIntent(
    request: { operationId: string },
    kind: IntentValue["kind"],
    requestSha: string,
    outcome: IntentValue["outcome"],
    priorStateValue: StateValue,
  ): IntentValue {
    return {
      operationId: request.operationId,
      requestSha256: requestSha,
      kind,
      bootId,
      phase: "terminal",
      outcome,
      candidateSha256: null,
      recoveryOf: null,
      recoveryAction: null,
      acceptedAt: now(),
      updatedAt: now(),
      completedAt: now(),
      plan: null,
      priorState: priorStateValue,
      patchAttempts: [],
      conflicts: [],
    };
  }

  async function runDeactivate(
    ctx: HomeContext,
    request: DeactivateRequest,
    daemon: ConnectedDaemon,
  ): Promise<void> {
    const opId = request.operationId;
    try {
      const receipt = journal.read(ctx.stableRoot);
      if (!receipt?.binding) throw new Error("binding vanished during deactivation");
      const binding = receipt.binding;

      // §8.3.1 — runtime integrity is part of the deactivation contract.
      await deps.materializer.verifyPublished(binding.runtimePath, binding.candidateSha256, binding.payloadSha256);
      await deps.launchers.verify(join(ctx.stableRoot, "launchers", binding.launchSetSha256));

      const raw = readRawConfig(ctx.configPath);
      const liveConfig = (await daemon.config.get()).config;
      const liveBefore = effectiveView(liveConfig);
      const { plan, patch } = planDeactivation({
        raw,
        effectiveConfig: liveConfig,
        binding,
      });
      transition(ctx, r => {
        const op = findOperation(r, opId);
        if (!op) throw new Error("operation vanished");
        op.phase = "prepared";
        op.updatedAt = now();
        op.plan = plan;
      });

      const liveAfter = effectiveView((await daemon.config.get()).config);
      assertPlanCurrent(ctx, plan, liveBefore, liveAfter);

      if (patch !== null) {
        const settlement = await dispatchPatch(ctx, daemon, opId, patch);
        if (settlement === "threw") {
          throw new OperationConflict("IO_FAILURE", "config.patch threw before dispatch");
        }
        if (settlement === "outcome-unknown") {
          transition(ctx, r => {
            const op = findOperation(r, opId);
            if (!op) return;
            op.outcome = "recovery-required";
            op.updatedAt = now();
            op.conflicts = [
              ...op.conflicts,
              conflictOf(
                "PATCH_OUTCOME_UNKNOWN",
                "config.patch settlement unknown; the daemon operation may still be running — reconcile after quiescing",
              ),
            ].slice(0, MAX_CONFLICTS);
            r.state = "RECOVERY_REQUIRED";
            r.activeOperationId = null;
          });
          return;
        }
        const livePost = (await daemon.config.get()).config;
        if (settleAfterPatch(ctx, opId, plan, livePost) !== "after") return;
      }

      transition(ctx, r => {
        const op = findOperation(r, opId);
        if (!op) throw new Error("operation vanished");
        op.phase = "verified";
        op.updatedAt = now();
      });

      transition(ctx, r => {
        const op = findOperation(r, opId);
        if (!op) throw new Error("operation vanished");
        r.binding = null;
        r.lastDeactivatedBindingSha256 = binding.bindingSha256;
        r.state = "INACTIVE";
        r.activeOperationId = null;
        op.outcome = patch === null ? "no-op" : "succeeded";
        op.phase = "terminal";
        op.updatedAt = now();
        op.completedAt = now();
      });
    } catch (error) {
      recordFailure(ctx, opId, error);
    }
  }

  // -------------------------------------------------------------------------
  // reconcile (§8.4)
  // -------------------------------------------------------------------------

  async function reconcile(input: ReconcileRequest, daemon: ConnectedDaemon): Promise<StartResult> {
    const admission = admitMutation({ schema: ReconcileInput, input, kind: "reconcile" });
    if ("reply" in admission) return admission.reply;
    const { request, ctx, receipt, state, requestSha, release } = admission;
    try {
      if (request.action === "inspect") {
        // Inspect is journaled like every other operation: the intent lands
        // before execution so status(operationId) resolves and an identical
        // retry replays the recorded reply (idempotency).
        const intent: IntentValue = {
          operationId: request.operationId,
          requestSha256: requestSha,
          kind: "reconcile",
          bootId,
          phase: "accepted",
          outcome: "pending",
          candidateSha256: null,
          recoveryOf: null,
          recoveryAction: "inspect",
          acceptedAt: now(),
          updatedAt: now(),
          completedAt: null,
          plan: null,
          priorState: state,
          patchAttempts: [],
          conflicts: [],
        };
        const fresh = !receipt;
        const next = transitionOrInit(ctx, request.target.hostId, r => {
          // The recovery subject is the pending op, or — when none is
          // pending — an unresolved PRE-PLAN op left recovery-required by an
          // earlier inspect that died before its terminal write. A plan-null
          // subject is always resolvable: this inspect re-verifies the
          // binding and marks it failed, restoring its recorded priorState.
          // Ops carrying a plan stay excluded — they need complete/
          // restore-before, and selecting them would mask real patch
          // evidence behind a planless re-inspection.
          const subject =
            pendingOperation(r) ??
            r.operations.find(op => op.outcome === "recovery-required" && op.plan === null);
          if (subject) {
            // Admission guarantees any pending op is foreign/dead-boot; it is
            // the inspect's recovery subject. Mark it recovery-required in
            // the same write so the journal never holds two pending intents —
            // the worker's classification refines this to failed when the
            // subject never reached a durable plan.
            subject.outcome = "recovery-required";
            subject.updatedAt = now();
            intent.recoveryOf = subject.operationId;
            r.state = "RECOVERY_REQUIRED";
            // The subject is unresolved recovery evidence this op entered
            // under — a failed inspect must not restore a state that masks it.
            intent.priorState = "RECOVERY_REQUIRED";
          }
          r.activeOperationId = intent.operationId;
          r.operations.push(intent);
        });
        const recorded = findOperation(next, intent.operationId);
        inFlightOpId = intent.operationId;
        setImmediate(() => {
          runInspect(ctx, intent, daemon, fresh).finally(() => {
            inFlightOpId = null;
          });
        });
        return startAccepted(next.state, recorded ?? intent);
      }

      if (request.interruptedOperationId === undefined) {
        return startReject(state, [
          conflictOf(
            "INVALID_REQUEST",
            `reconcile ${request.action} requires interruptedOperationId`,
          ),
        ]);
      }
      if (!receipt) {
        return startReject("INACTIVE", [
          conflictOf("NOT_FOUND", "no receipt exists for this target"),
        ]);
      }
      const original = findOperation(receipt, request.interruptedOperationId);
      if (!original) {
        return startReject(state, [
          conflictOf("NOT_FOUND", `no operation ${request.interruptedOperationId} in this journal`),
        ]);
      }
      if (original.outcome !== "pending" && original.outcome !== "recovery-required") {
        return startReject(state, [
          conflictOf(
            "INVALID_REQUEST",
            `operation ${original.operationId} is already ${original.outcome}`,
          ),
        ]);
      }
      if (original.plan === null) {
        return startReject(state, [
          conflictOf(
            "INVALID_REQUEST",
            `operation ${original.operationId} has no durable plan; nothing to complete or restore`,
          ),
        ]);
      }
      // Same-boot gate only: 'the original call may still be running' is
      // possible solely while bootId matches — the async patch promise is
      // alive in this process. A foreign-boot pending/outcome-unknown attempt
      // means the caller process is dead; classifyState resolves the outcome
      // from disk+live state instead (unresolvable → RECOVERY_REQUIRED per
      // §602, i.e. blocked, never a blind re-dispatch). The check covers the
      // whole recovery CHAIN containing the requested op — not just the op
      // itself: a same-boot reconcile that dispatched an inverse whose
      // outcome is still unknown shares the chain, and letting a mutation
      // through against its root would race the still-live attempt.
      const chainRootIdOf = (op: IntentValue): string => {
        let cursor = op;
        const seen = new Set<string>([cursor.operationId]);
        while (cursor.recoveryOf !== null && !seen.has(cursor.recoveryOf)) {
          const parent = findOperation(receipt, cursor.recoveryOf);
          if (!parent) break;
          seen.add(parent.operationId);
          cursor = parent;
        }
        return cursor.operationId;
      };
      const chainRootId = chainRootIdOf(original);
      if (
        receipt.operations.some(
          op =>
            op.bootId === bootId &&
            chainRootIdOf(op) === chainRootId &&
            op.patchAttempts.some(a => a.result === "pending" || a.result === "outcome-unknown"),
        )
      ) {
        return startReject(state, [
          conflictOf(
            "PATCH_OUTCOME_UNKNOWN",
            "a dispatched config.patch may still be running; establish a quiescent daemon first",
          ),
        ]);
      }

      const intent: IntentValue = {
        operationId: request.operationId,
        requestSha256: requestSha,
        kind: "reconcile",
        bootId,
        phase: "accepted",
        outcome: "pending",
        candidateSha256: original.candidateSha256,
        recoveryOf: original.operationId,
        recoveryAction: request.action,
        acceptedAt: now(),
        updatedAt: now(),
        completedAt: null,
        plan: original.plan,
        // Acceptance unconditionally enters recovery bookkeeping below — the
        // honest restore target on failure is RECOVERY_REQUIRED regardless of
        // what the binding currently records.
        priorState: "RECOVERY_REQUIRED",
        patchAttempts: [],
        conflicts: [],
      };
      const next = transition(ctx, r => {
        const target = findOperation(r, original.operationId);
        if (target && target.outcome === "pending") {
          target.outcome = "recovery-required";
          target.updatedAt = now();
        }
        r.state = "RECOVERY_REQUIRED";
        r.activeOperationId = intent.operationId;
        r.operations.push(intent);
      });
      const recorded = findOperation(next, intent.operationId);
      inFlightOpId = intent.operationId;
      setImmediate(() => {
        runReconcile(ctx, intent, daemon).finally(() => {
          inFlightOpId = null;
        });
      });
      return startAccepted("RECOVERY_REQUIRED", recorded ?? intent);
    } catch (error) {
      const receipt = safeRead(ctx_or_null(input));
      return rejectWith(receipt?.state ?? "INACTIVE", error);
    } finally {
      release();
    }
  }

  /** §8.4 inspect worker — classify; mark safe interrupts; refresh healthy
   *  bindings. Runs on the journaled intent: terminal outcome + conflicts are
   *  written to the operation record so status() and idempotent retries
   *  replay the recorded reply. */
  async function runInspect(
    ctx: HomeContext,
    intent: IntentValue,
    daemon: ConnectedDaemon,
    freshReceipt: boolean,
  ): Promise<void> {
    const opId = intent.operationId;
    // Terminal settle for the inspect intent: outcome + findings are journaled
    // atomically with any verdict state transition. `succeeded` means the
    // inspect ran to completion — findings live in the op's conflicts and the
    // receipt state carries the verdict; `failed` means the inspect itself
    // could not complete (see recordFailure).
    const settle = (
      outcome: "succeeded" | "failed",
      conflicts: ConflictValue[],
      state?: StateValue,
    ): ReceiptValue =>
      transition(ctx, r => {
        const op = findOperation(r, opId);
        if (op) {
          op.outcome = outcome;
          op.phase = "terminal";
          op.completedAt = now();
          op.updatedAt = now();
          op.conflicts = [...op.conflicts, ...conflicts].slice(0, MAX_CONFLICTS);
        }
        if (state !== undefined) r.state = state;
        r.activeOperationId = null;
      });
    try {
      const receipt = journal.read(ctx.stableRoot);
      if (!receipt) throw new Error("receipt vanished during inspect");

      const subject = intent.recoveryOf !== null
        ? findOperation(receipt, intent.recoveryOf)
        : undefined;
      if (subject) {
        await inspectInterrupted(ctx, receipt, subject, settle, daemon);
        return;
      }

      if (freshReceipt) {
        // No prior receipt: report observed SLP entries, never invent
        // ownership (the receipt on disk is the one this inspect just
        // journaled its intent into). The same persisted/live invariants the
        // binding path runs apply here too — a verdict must never skip them:
        // a schema-rejected field or a raw/live split is recovery evidence
        // whether or not a binding exists.
        const conflicts: ConflictValue[] = [];
        let raw;
        try {
          raw = readRawConfig(ctx.configPath);
          assertPersistedCompatible(raw.json);
        } catch (error) {
          conflicts.push(toConflict(error));
          settle("succeeded", conflicts, "RECOVERY_REQUIRED");
          return;
        }
        try {
          assertRawLiveAgreement(raw.json, effectiveView((await daemon.config.get()).config));
        } catch (error) {
          conflicts.push(toConflict(error));
        }
        const rawProviders = providersRecord(raw.json);
        for (const id of OWNED_PROVIDER_IDS) {
          if (Object.hasOwn(rawProviders, id)) {
            conflicts.push(
              conflictOf("COLLISION", `observed unmanaged SLP provider ${id} without a receipt`, {
                path: `agents.providers.${id}`,
              }),
            );
          }
        }
        const profiles = profilesArray(raw.json);
        profiles.value.forEach((entry, index) => {
          if (isRecord(entry) && typeof entry.id === "string" && entry.id.startsWith("slp-")) {
            conflicts.push(
              conflictOf("COLLISION", `observed unmanaged SLP profile ${entry.id} without a receipt`, {
                path: `daemon.agentProfiles[${index}]`,
              }),
            );
          }
        });
        settle("succeeded", conflicts, conflicts.length > 0 ? "RECOVERY_REQUIRED" : "INACTIVE");
        return;
      }

      // Healthy inspect: verify the binding is still honest.
      const conflicts: ConflictValue[] = [];
      const raw = readRawConfig(ctx.configPath);
      try {
        assertPersistedCompatible(raw.json);
      } catch (error) {
        conflicts.push(toConflict(error));
      }
      const live = effectiveView((await daemon.config.get()).config);
      if (receipt.binding) {
        const binding = receipt.binding;
        // Valid human profile edits/positions are refreshed into the receipt
        // only after EVERY binding invariant below has passed — drift,
        // runtime, launchers, executables and retained sets. Writing earlier
        // would stamp a new verifiedAt/bindingSha256 onto a binding whose
        // integrity checks are about to fail, losing the last trustworthy
        // record.
        let pendingSlots: BindingValue["owned"]["profiles"] | null = null;
        try {
          assertRawLiveAgreement(raw.json, live);
        } catch (error) {
          conflicts.push(toConflict(error));
        }
        try {
          // §8.1 precondition: the binding was recorded under effective
          // mcp.enabled === true (raw absent resolves true in the pinned
          // host). An explicit false on either side is drift the plugin
          // cannot repair — the binding precondition no longer holds.
          const rawEnabled = mcpFlagPresence(raw.json, "enabled");
          const observedEnabled = rawEnabled.present ? rawEnabled.value === true : true;
          if (!observedEnabled || live.enabled !== true) {
            throw new OperationConflict(
              "OWNERSHIP_DRIFT",
              "daemon.mcp.enabled diverges from the binding precondition (expected effective true)",
              { path: "daemon.mcp.enabled" },
            );
          }
          const observed = extractProjection(raw.json, "OWNERSHIP_DRIFT");
          const profiles = profilesArray(raw.json).value;
          for (const slot of binding.owned.profiles) {
            const current = profiles.find(
              entry => isRecord(entry) && entry.id === slot.value.id,
            );
            if (!current) {
              throw new OperationConflict(
                "OWNERSHIP_DRIFT",
                `owned profile ${slot.value.id} is missing`,
                { path: "daemon.agentProfiles" },
              );
            }
            // A human-edited profile stays bound only while it still targets
            // an available same-role SLP provider.
            const provider = isRecord(current) ? current.provider : undefined;
            const match = typeof provider === "string"
              ? OWNED_PROVIDER_ID_RE.exec(provider)
              : null;
            const role = slot.value.id === "slp-supervisor" ? "supervisor" : "lead";
            if (
              match === null ||
              match[2] !== role ||
              binding.binaries[match[1] as keyof typeof binding.binaries]?.available !== true
            ) {
              throw new OperationConflict(
                "OWNERSHIP_DRIFT",
                `owned profile ${slot.value.id} points at ${String(provider)}; expected an available slp-<family>-${role} provider`,
                { path: "daemon.agentProfiles" },
              );
            }
            // Refresh covers positions too: an unrelated profile inserted
            // earlier in the array shifts owned slot indexes — the profile
            // stays valid but the recorded position must track the array,
            // or the next deactivate compares against a stale index.
            const observedIndex = observed.profiles.find(s => s.value.id === slot.value.id)?.index;
            if (!canonicalEqual(current, slot.value) || observedIndex !== slot.index) {
              pendingSlots = observed.profiles;
            }
          }
          // Provider entries must match the receipt exactly.
          const rawProviders = providersRecord(raw.json);
          for (const id of OWNED_PROVIDER_IDS) {
            const expected = binding.owned.providers[id];
            const present = Object.hasOwn(rawProviders, id);
            if (expected.present !== present) {
              throw new OperationConflict(
                "OWNERSHIP_DRIFT",
                `owned provider ${id} ${present ? "appeared" : "disappeared"} outside the journal`,
                { path: `agents.providers.${id}` },
              );
            }
            if (expected.present && present && !canonicalEqual(expected.value, rawProviders[id])) {
              throw new OperationConflict(
                "OWNERSHIP_DRIFT",
                `owned provider ${id} was modified outside the journal`,
                { path: `agents.providers.${id}` },
              );
            }
          }
          // Injection is part of the bound projection: raw and live must both
          // satisfy the recorded flag (absent counts as false, per §8.3) — a
          // silent flip on both sides is drift, not agreement.
          const expectedInject = binding.owned.injectIntoAgents.present
            ? binding.owned.injectIntoAgents.value === true
            : false;
          const rawInject = mcpFlagPresence(raw.json, "injectIntoAgents");
          const observedInject = rawInject.present ? rawInject.value === true : false;
          if (observedInject !== expectedInject || live.injectIntoAgents !== expectedInject) {
            throw new OperationConflict(
              "OWNERSHIP_DRIFT",
              `daemon.mcp.injectIntoAgents diverges from the bound receipt (expected ${expectedInject})`,
              { path: "daemon.mcp.injectIntoAgents" },
            );
          }
        } catch (error) {
          conflicts.push(toConflict(error));
          settle("succeeded", conflicts, "RECOVERY_REQUIRED");
          return;
        }
        // Runtime/launch/executable integrity is part of the binding verdict:
        // a failure here is not cosmetic — it journals the conflict and
        // transitions the receipt to RECOVERY_REQUIRED (same pattern as
        // OWNERSHIP_DRIFT above).
        try {
          await deps.materializer.verifyPublished(binding.runtimePath, binding.candidateSha256, binding.payloadSha256);
          const boundSet = await deps.launchers.verify(join(ctx.stableRoot, "launchers", binding.launchSetSha256));
          // The verified identity must BE the recorded one — a verify that
          // resolves to a different valid set is not proof of this binding.
          if (boundSet.launchSetSha256 !== binding.launchSetSha256) {
            throw new OperationConflict(
              "RUNTIME_INTEGRITY",
              "verified launch set identity does not match the recorded binding",
              {
                path: join(ctx.stableRoot, "launchers", binding.launchSetSha256),
                expectedSha256: binding.launchSetSha256,
                actualSha256: boundSet.launchSetSha256,
              },
            );
          }
          await probeRecordedExecutables(ctx, binding, "binding");
          // Retained candidates/launchers other than the active binding's.
          // A retained entry may share the active runtimePath while pointing
          // at an OLDER launch set — only skip what was verified above; every
          // retained launch-set identity still needs its own verification.
          for (const retained of receipt.retained) {
            if (retained.runtimePath !== binding.runtimePath) {
              await deps.materializer.verifyPublished(retained.runtimePath, retained.candidateSha256, retained.payloadSha256);
            }
            if (
              retained.launchSetSha256 !== null &&
              retained.launchSetSha256 !== binding.launchSetSha256
            ) {
              const retainedSet = await deps.launchers.verify(join(ctx.stableRoot, "launchers", retained.launchSetSha256));
              if (retainedSet.launchSetSha256 !== retained.launchSetSha256) {
                throw new OperationConflict(
                  "RUNTIME_INTEGRITY",
                  "verified launch set identity does not match the retained record",
                  {
                    path: join(ctx.stableRoot, "launchers", retained.launchSetSha256),
                    expectedSha256: retained.launchSetSha256,
                    actualSha256: retainedSet.launchSetSha256,
                  },
                );
              }
            }
          }
        } catch (error) {
          conflicts.push(toConflict(error));
          settle("succeeded", conflicts, "RECOVERY_REQUIRED");
          return;
        }
        if (pendingSlots !== null && conflicts.length === 0) {
          // Every invariant passed: publish the deferred refresh atomically.
          // Slot indexes come from the fresh raw read; the binding hash is
          // recomputed over the refreshed projection.
          const observedSlots = pendingSlots;
          transition(ctx, r => {
            const b = r.binding;
            if (!b) return;
            b.owned = { ...b.owned, profiles: observedSlots };
            b.postPatchPersistedShapeSha256 = canonicalSha256(b.owned);
            b.verifiedAt = now();
            b.bindingSha256 = canonicalSha256({
              candidateSha256: b.candidateSha256,
              payloadSha256: b.payloadSha256,
              launchSetSha256: b.launchSetSha256,
              owned: b.owned,
            });
          });
        }
      } else {
        // No binding: verify no owned entries linger and retained dirs intact.
        // The same raw/live agreement invariant the binding path runs applies
        // here — a split is recovery evidence with or without a binding.
        try {
          assertRawLiveAgreement(raw.json, live);
        } catch (error) {
          conflicts.push(toConflict(error));
        }
        const observed = extractProjection(raw.json, "COLLISION");
        for (const id of OWNED_PROVIDER_IDS) {
          if (observed.providers[id].present) {
            conflicts.push(
              conflictOf("COLLISION", `unowned SLP provider ${id} present`, {
                path: `agents.providers.${id}`,
              }),
            );
          }
        }
        for (const slot of observed.profiles) {
          conflicts.push(
            conflictOf("COLLISION", `unowned SLP profile ${slot.value.id} present`, {
              path: `daemon.agentProfiles[${slot.index}]`,
            }),
          );
        }
        try {
          for (const retained of receipt.retained) {
            await deps.materializer.verifyPublished(retained.runtimePath, retained.candidateSha256, retained.payloadSha256);
            if (retained.launchSetSha256 !== null) {
              await deps.launchers.verify(join(ctx.stableRoot, "launchers", retained.launchSetSha256));
            }
          }
        } catch (error) {
          conflicts.push(toConflict(error));
          settle("succeeded", conflicts, "RECOVERY_REQUIRED");
          return;
        }
      }
      // Verdict: any observed conflict — schema loss, raw/live divergence,
      // unmanaged entries, precondition drift — is recovery evidence, and any
      // unresolved-patch op (pending or recovery-required) keeps the receipt
      // in RECOVERY_REQUIRED regardless of this inspect's findings. A clean
      // inspect with neither restores the verified state, which is also how a
      // state-level recovery resolves once the drift is fixed (§9).
      const unresolvedPatch = receipt.operations.some(
        op => op.operationId !== opId && (op.outcome === "pending" || op.outcome === "recovery-required"),
      );
      const verdict =
        conflicts.length > 0 || unresolvedPatch
          ? "RECOVERY_REQUIRED"
          : receipt.binding
            ? "ACTIVE"
            : "INACTIVE";
      settle("succeeded", conflicts, verdict);
    } catch (error) {
      recordFailure(ctx, opId, error);
    }
  }

  /** Classify an interrupted op; auto-fail prepatch stages, mark the rest. */
  async function inspectInterrupted(
    ctx: HomeContext,
    receipt: ReceiptValue,
    interrupted: IntentValue,
    settle: (outcome: "succeeded" | "failed", conflicts: ConflictValue[], state?: StateValue) => ReceiptValue,
    daemon: ConnectedDaemon,
  ): Promise<void> {
    const conflicts: ConflictValue[] = [];
    if (interrupted.plan === null) {
      // Reaching this branch means the op is legitimately pre-plan: the
      // journal refinement rejects prepared-or-later phases without a plan
      // at read time, so only accepted/materialized intents arrive here.
      // §8.4: even with no durable plan, inspect verifies the retained current
      // binding (if any) — runtime, launch set and the owned config projection —
      // before marking the op failed, so tampering inside the crash window is
      // reported immediately instead of surfacing as drift later. The recorded
      // priorState does not replace checking the CURRENT endpoint: the same
      // healthy-inspect invariants (persisted schema, raw/live agreement,
      // mcp.enabled) must hold before the op is confirmed failed, or a
      // corrupted/disabled config would be masked by the restore.
      if (receipt.binding) {
        const binding = receipt.binding;
        let raw;
        try {
          raw = readRawConfig(ctx.configPath);
          assertPersistedCompatible(raw.json);
        } catch (error) {
          conflicts.push(toConflict(error));
          raw = undefined;
        }
        let live;
        try {
          live = effectiveView((await daemon.config.get()).config);
        } catch (error) {
          conflicts.push(toConflict(error));
          live = undefined;
        }
        if (raw !== undefined && live !== undefined) {
          try {
            assertRawLiveAgreement(raw.json, live);
          } catch (error) {
            conflicts.push(toConflict(error));
          }
          try {
            const rawEnabled = mcpFlagPresence(raw.json, "enabled");
            const observedEnabled = rawEnabled.present ? rawEnabled.value === true : true;
            if (!observedEnabled || live.enabled !== true) {
              throw new OperationConflict(
                "OWNERSHIP_DRIFT",
                "daemon.mcp.enabled diverges from the binding precondition (expected effective true)",
                { path: "daemon.mcp.enabled" },
              );
            }
          } catch (error) {
            conflicts.push(toConflict(error));
          }
        }
        try {
          await deps.materializer.verifyPublished(binding.runtimePath, binding.candidateSha256, binding.payloadSha256);
          await deps.launchers.verify(join(ctx.stableRoot, "launchers", binding.launchSetSha256));
          await probeRecordedExecutables(ctx, binding, "binding");
          // Retained assets get the same verification the healthy inspect
          // applies — a deleted retained launch set is integrity evidence
          // whether or not a durable plan exists.
          for (const retained of receipt.retained) {
            if (retained.runtimePath !== binding.runtimePath) {
              await deps.materializer.verifyPublished(retained.runtimePath, retained.candidateSha256, retained.payloadSha256);
            }
            if (
              retained.launchSetSha256 !== null &&
              retained.launchSetSha256 !== binding.launchSetSha256
            ) {
              await deps.launchers.verify(join(ctx.stableRoot, "launchers", retained.launchSetSha256));
            }
          }
          if (raw !== undefined) {
            const observed = extractProjection(raw.json, "OWNERSHIP_DRIFT");
            if (!canonicalEqual(observed, binding.owned)) {
              throw new OperationConflict(
                "OWNERSHIP_DRIFT",
                "owned config projection diverges from the bound receipt",
                { path: ctx.configPath },
              );
            }
          }
        } catch (error) {
          conflicts.push(toConflict(error));
        }
      } else {
        // No binding under an interrupted op: the same persisted/live and
        // retained checks the healthy no-binding inspect runs must hold
        // before any verdict — a schema-rejected field, a raw/live split, an
        // unmanaged SLP entry or a missing retained asset is recovery
        // evidence, not a clean restore.
        let raw;
        try {
          raw = readRawConfig(ctx.configPath);
          assertPersistedCompatible(raw.json);
        } catch (error) {
          conflicts.push(toConflict(error));
          raw = undefined;
        }
        let live;
        try {
          live = effectiveView((await daemon.config.get()).config);
        } catch (error) {
          conflicts.push(toConflict(error));
          live = undefined;
        }
        if (raw !== undefined && live !== undefined) {
          try {
            assertRawLiveAgreement(raw.json, live);
          } catch (error) {
            conflicts.push(toConflict(error));
          }
        }
        if (raw !== undefined) {
          const observed = extractProjection(raw.json, "COLLISION");
          for (const id of OWNED_PROVIDER_IDS) {
            if (observed.providers[id].present) {
              conflicts.push(
                conflictOf("COLLISION", `unowned SLP provider ${id} present`, {
                  path: `agents.providers.${id}`,
                }),
              );
            }
          }
          for (const slot of observed.profiles) {
            conflicts.push(
              conflictOf("COLLISION", `unowned SLP profile ${slot.value.id} present`, {
                path: `daemon.agentProfiles[${slot.index}]`,
              }),
            );
          }
        }
        try {
          for (const retained of receipt.retained) {
            await deps.materializer.verifyPublished(retained.runtimePath, retained.candidateSha256, retained.payloadSha256);
            if (retained.launchSetSha256 !== null) {
              await deps.launchers.verify(join(ctx.stableRoot, "launchers", retained.launchSetSha256));
            }
          }
        } catch (error) {
          conflicts.push(toConflict(error));
        }
      }
      if (conflicts.length > 0) {
        settle("succeeded", conflicts, "RECOVERY_REQUIRED");
        transition(ctx, r => {
          const op = findOperation(r, interrupted.operationId);
          if (op && op.phase !== "terminal") {
            op.conflicts = [...op.conflicts, ...conflicts].slice(0, MAX_CONFLICTS);
            op.updatedAt = now();
          }
        });
        return;
      }
      // No durable plan → nothing was ever dispatched; failed is honest.
      // (The subject was marked recovery-required when this inspect was
      // accepted; refine it now that classification proved a pre-plan stop.)
      // The restore target is the op's own recorded priorState, not a
      // binding-derived recomputation: an interrupted inspect op may have
      // entered under RECOVERY_REQUIRED (its subject's evidence must not be
      // erased by restoring ACTIVE/INACTIVE), and ops journaled by older
      // builds fall back per kind — reconcile-kind recovers RECOVERY_REQUIRED.
      const isInspectOp = interrupted.recoveryAction === "inspect";
      const written = transition(ctx, r => {
        const op = findOperation(r, interrupted.operationId);
        if (op) {
          op.outcome = "failed";
          op.phase = "terminal";
          op.updatedAt = now();
          op.completedAt = now();
          op.conflicts = [
            ...op.conflicts,
            conflictOf(
              "RECOVERY_REQUIRED",
              isInspectOp
                ? "inspect interrupted before its terminal journal; marked failed"
                : `interrupted at phase ${interrupted.phase} before any patch dispatch; marked failed`,
            ),
          ].slice(0, MAX_CONFLICTS);
        }
        r.state =
          interrupted.priorState ??
          (interrupted.kind === "reconcile" ? "RECOVERY_REQUIRED" : priorState(r));
      });
      settle("succeeded", conflicts, written.state);
      return;
    }

    // A durable plan exists: classify observed state against its endpoints.
    const raw = readRawConfig(ctx.configPath);
    const liveConfig = (await daemon.config.get()).config;
    const cls = classifyState(raw.json, liveConfig, interrupted.plan);
    const unknownAttempt = interrupted.patchAttempts.some(
      a => a.result === "pending" || a.result === "outcome-unknown",
    );
    if (unknownAttempt) {
      conflicts.push(
        conflictOf(
          "PATCH_OUTCOME_UNKNOWN",
          `operation ${interrupted.operationId} has a patch attempt whose outcome is unknown`,
        ),
      );
    }
    conflicts.push(
      conflictOf(
        "RECOVERY_REQUIRED",
        `operation ${interrupted.operationId} interrupted at phase ${interrupted.phase}; observed state classifies as "${cls.class}"${
          cls.problems.length > 0 ? `: ${cls.problems.slice(0, 6).join("; ")}` : ""
        }`,
      ),
    );
    transition(ctx, r => {
      const op = findOperation(r, interrupted.operationId);
      if (op) {
        op.conflicts = [...op.conflicts, ...conflicts].slice(0, MAX_CONFLICTS);
        op.updatedAt = now();
      }
    });
    settle("succeeded", conflicts, "RECOVERY_REQUIRED");
  }

  // -------------------------------------------------------------------------
  // reconcile worker — complete / restore-before
  // -------------------------------------------------------------------------

  /** §6 — re-probe the executables recorded on a binding: the recorded node
   *  path and every recorded family binary go in as EXPLICIT inputs, so the
   *  seam probes exactly those paths and a dead path fails instead of falling
   *  back to PATH. The result must match the recording — the published launch
   *  manifest is immutable, so a substitute is never acceptable. */
  async function probeRecordedExecutables(
    ctx: HomeContext,
    recorded: { node: { path: string }; binaries: Record<string, { available: boolean; path: string | null }> },
    what: string,
  ): Promise<void> {
    const binaries: Record<string, string> = {};
    for (const family of FAMILIES) {
      const entry = recorded.binaries[family];
      if (entry?.available && entry.path !== null) binaries[family] = entry.path;
    }
    const resolution = await deps.executables.resolve({
      daemonHome: ctx.canonicalHome,
      stableRoot: ctx.stableRoot,
      nodePath: recorded.node.path,
      binaries,
      prior: null,
    });
    if (resolution.node.path !== recorded.node.path) {
      throw new OperationConflict(
        "EXECUTABLE_UNAVAILABLE",
        `${what}: recorded node ${recorded.node.path} resolved to ${resolution.node.path}`,
      );
    }
    for (const family of FAMILIES) {
      const entry = recorded.binaries[family];
      if (!entry?.available || entry.path === null) continue;
      const got = resolution.binaries[family];
      if (!got.available || got.path !== entry.path) {
        throw new OperationConflict(
          "EXECUTABLE_UNAVAILABLE",
          `${what}: recorded ${family} binary ${entry.path} no longer probes clean`,
          { path: entry.path },
        );
      }
    }
  }

  async function runReconcile(
    ctx: HomeContext,
    intent: IntentValue,
    daemon: ConnectedDaemon,
  ): Promise<void> {
    const opId = intent.operationId;
    try {
      const receipt = journal.read(ctx.stableRoot);
      if (!receipt) throw new Error("receipt vanished");
      const original = findOperation(receipt, intent.recoveryOf!);
      const plan = intent.plan;
      if (!original || !plan) {
        throw new OperationConflict("INVALID_REQUEST", "interrupted operation or plan missing");
      }

      // Resolve the recovery chain: the recovered op may itself be a reconcile
      // (reconcile-of-reconcile). The effective endpoint is the ROOT
      // operation's forward target unless a link in the chain — or this
      // request — redirected toward the before state. Every op in the chain
      // carries the same plan, so direction + root kind fully determine the
      // patch and the binding to finalize.
      const targetOfChain = (op: IntentValue): "forward" | "before" => {
        if (op.kind !== "reconcile") return "forward";
        if (op.recoveryAction === "restore-before") return "before";
        const parent = op.recoveryOf ? findOperation(receipt, op.recoveryOf) : undefined;
        return parent ? targetOfChain(parent) : "forward";
      };
      let root = original;
      while (root.kind === "reconcile") {
        const parent = root.recoveryOf ? findOperation(receipt, root.recoveryOf) : undefined;
        if (!parent) break;
        root = parent;
      }
      const rootKind = root.kind;
      const direction = intent.recoveryAction === "restore-before" ? "before" : targetOfChain(original);
      const action = intent.recoveryAction!;

      // Settle every op on the chain root..original: each reaches the outcome
      // its own target endpoint earned (target reached → succeeded; rolled
      // back → failed). The reconcile intent itself always succeeds — it did
      // its job of settling the chain.
      const settleChain = (r: ReceiptValue, reached: "forward" | "before") => {
        let cursor: IntentValue | undefined = original;
        while (cursor) {
          const op = findOperation(r, cursor.operationId);
          if (op && op.phase !== "terminal") {
            op.outcome = targetOfChain(cursor) === reached ? "succeeded" : "failed";
            op.phase = "terminal";
            op.completedAt = now();
            op.updatedAt = now();
          }
          cursor = cursor.kind === "reconcile" && cursor.recoveryOf
            ? findOperation(receipt, cursor.recoveryOf)
            : undefined;
        }
      };

      const raw = readRawConfig(ctx.configPath);
      const liveConfig = (await daemon.config.get()).config;
      const cls = classifyState(raw.json, liveConfig, plan);
      // Equal endpoints (identical-config adoption leaves before==after):
      // the observed state already satisfies the requested endpoint — drive
      // straight into the matching verify/finalize branch and never dispatch
      // a redundant patch for it.
      if (cls.endpointsEqual) {
        cls.class = direction === "forward" ? "after" : "before";
      }

      const finalizeIntended = () => {
        transition(ctx, r => {
          const recovery = findOperation(r, opId);
          if (rootKind === "activate") {
            const postSha = canonicalSha256(
              extractProjection(readRawConfig(ctx.configPath).json, "OWNERSHIP_DRIFT"),
            );
            r.binding = {
              ...plan.nextBinding!,
              verifiedAt: now(),
              postPatchPersistedShapeSha256: postSha,
            };
            r.state = "ACTIVE";
          } else {
            r.binding = null;
            r.lastDeactivatedBindingSha256 = plan.previousBinding?.bindingSha256 ?? null;
            r.state = "INACTIVE";
          }
          r.activeOperationId = null;
          settleChain(r, "forward");
          if (recovery) {
            recovery.outcome = "succeeded";
            recovery.phase = "terminal";
            recovery.completedAt = now();
            recovery.updatedAt = now();
          }
        });
      };

      const finalizePrevious = () => {
        // Callers verify the previous binding's runtime/launch set before
        // invoking this; the binding is only reinstated when intact.
        transition(ctx, r => {
          const recovery = findOperation(r, opId);
          r.binding = plan.previousBinding;
          r.state = plan.previousBinding ? "ACTIVE" : "INACTIVE";
          r.activeOperationId = null;
          settleChain(r, "before");
          if (recovery) {
            recovery.outcome = "succeeded";
            recovery.phase = "terminal";
            recovery.completedAt = now();
            recovery.updatedAt = now();
          }
        });
      };

      const failRecovery = (conflicts: ConflictValue[]) => {
        transition(ctx, r => {
          const recovery = findOperation(r, opId);
          if (recovery) {
            recovery.outcome = "failed";
            recovery.phase = "terminal";
            recovery.completedAt = now();
            recovery.updatedAt = now();
            recovery.conflicts = [...recovery.conflicts, ...conflicts].slice(0, MAX_CONFLICTS);
          }
          r.state = "RECOVERY_REQUIRED";
          r.activeOperationId = null;
        });
      };

      if (cls.class === "divergent") {
        failRecovery([
          conflictOf("RAW_LIVE_DIVERGENCE", `disk and live disagree: ${cls.problems.slice(0, 8).join("; ")}`),
        ]);
        return;
      }
      if (cls.class === "partial") {
        failRecovery([
          conflictOf("RECOVERY_REQUIRED", `observed state is partial: ${cls.problems.slice(0, 8).join("; ")}`),
        ]);
        return;
      }

      if (direction === "forward" && cls.class === "after") {
        if (rootKind === "activate" && plan.nextBinding) {
          await deps.materializer.verifyPublished(plan.nextBinding.runtimePath, plan.nextBinding.candidateSha256, plan.nextBinding.payloadSha256);
          await deps.launchers.verify(
            join(ctx.stableRoot, "launchers", plan.nextBinding.launchSetSha256),
          );
          await probeRecordedExecutables(ctx, plan.nextBinding, "next binding");
        }
        finalizeIntended();
        return;
      }
      if (direction === "before" && cls.class === "before") {
        if (plan.previousBinding) {
          await deps.materializer.verifyPublished(plan.previousBinding.runtimePath, plan.previousBinding.candidateSha256, plan.previousBinding.payloadSha256);
          await deps.launchers.verify(
            join(ctx.stableRoot, "launchers", plan.previousBinding.launchSetSha256),
          );
          await probeRecordedExecutables(ctx, plan.previousBinding, "previous binding");
        }
        finalizePrevious();
        return;
      }

      if (direction === "forward" && cls.class === "before") {
        // Redispatch the recorded forward plan exactly once.
        if (rootKind === "activate") {
          if (!plan.nextBinding) throw new OperationConflict("RECOVERY_REQUIRED", "activate plan lacks nextBinding");
          const live = effectiveView(liveConfig);
          if (live.enabled !== true) {
            throw new OperationConflict("MCP_DISABLED", "daemon.mcp.enabled is not true");
          }
          await deps.materializer.verifyPublished(plan.nextBinding.runtimePath, plan.nextBinding.candidateSha256, plan.nextBinding.payloadSha256);
          await deps.launchers.verify(
            join(ctx.stableRoot, "launchers", plan.nextBinding.launchSetSha256),
          );
          await probeRecordedExecutables(ctx, plan.nextBinding, "next binding");
        } else {
          // Deactivate-forward removes providers; new dependents may have
          // appeared since the original plan was prepared. The plugin never
          // writes metadataGeneration.providers, so raw/live divergence
          // there is not patch-resolvable — refuse rather than let the
          // host's implicit filtering silently drop unapproved live
          // references (same rule as normal deactivation).
          assertMetadataGenerationAgreement(raw.json, effectiveView(liveConfig));
          assertNoDependentReferences(raw.json);
          // Revalidate the endpoint's files before dispatching the removal:
          // a runtime that corrupted since the crash must be reported, not
          // silently erased by the cleanup patch. §8.3: detaching a
          // verifiable binding does NOT require the external provider
          // binaries to still be installed — runtime and launch-set
          // integrity are the removal prerequisites, not availability.
          if (plan.previousBinding) {
            await deps.materializer.verifyPublished(plan.previousBinding.runtimePath, plan.previousBinding.candidateSha256, plan.previousBinding.payloadSha256);
            await deps.launchers.verify(
              join(ctx.stableRoot, "launchers", plan.previousBinding.launchSetSha256),
            );
          }
        }
        const patch = patchForDirection(plan, rootKind, "forward", raw.json);
        const settlement = await dispatchPatch(ctx, daemon, opId, patch);
        if (settlement === "threw") {
          throw new OperationConflict("IO_FAILURE", "config.patch threw before dispatch");
        }
        if (settlement === "outcome-unknown") {
          transition(ctx, r => {
            const recovery = findOperation(r, opId);
            if (recovery) {
              recovery.outcome = "recovery-required";
              recovery.updatedAt = now();
              recovery.conflicts = [
                ...recovery.conflicts,
                conflictOf("PATCH_OUTCOME_UNKNOWN", "redispatched patch outcome unknown"),
              ].slice(0, MAX_CONFLICTS);
            }
            r.state = "RECOVERY_REQUIRED";
            r.activeOperationId = null;
          });
          return;
        }
        const livePost = (await daemon.config.get()).config;
        if (settleAfterPatch(ctx, opId, plan, livePost) !== "after") return;
        // Post-patch verify before publishing ACTIVE: the config landed, but
        // the endpoint's runtime/launch assets must still be intact — a file
        // lost in the crash window turns finalize into recovery evidence.
        if (rootKind === "activate" && plan.nextBinding) {
          await deps.materializer.verifyPublished(plan.nextBinding.runtimePath, plan.nextBinding.candidateSha256, plan.nextBinding.payloadSha256);
          await deps.launchers.verify(
            join(ctx.stableRoot, "launchers", plan.nextBinding.launchSetSha256),
          );
          await probeRecordedExecutables(ctx, plan.nextBinding, "next binding");
        }
        finalizeIntended();
        return;
      }

      if (direction === "before" && cls.class === "after") {
        // Inverse once only. The dependency/metadata guards apply only to
        // providers the inverse patch actually REMOVES (§6 check-before-
        // removal): patchForDirection derives its removeProviders from ids
        // absent in plan.before.owned — for a rebind restore that set is
        // empty (the inverse restores provider values and removes nothing),
        // and for a partial-adoption restore it holds only the providers the
        // forward patch added. References to a provider the patch KEEPS are
        // legitimate state, not a blocker. Only a fresh-activate restore —
        // whose before endpoint has no owned providers — removes the full
        // set, and there live-only references would be silently emptied by
        // the removal patch.
        const removedByInverse = OWNED_PROVIDER_IDS.filter(
          id => plan.before.owned.providers[id]?.present !== true,
        );
        if (removedByInverse.length > 0) {
          assertMetadataGenerationAgreement(raw.json, effectiveView(liveConfig));
          assertNoDependentReferences(raw.json, removedByInverse);
        }
        if (plan.previousBinding) {
          await deps.materializer.verifyPublished(plan.previousBinding.runtimePath, plan.previousBinding.candidateSha256, plan.previousBinding.payloadSha256);
          await deps.launchers.verify(
            join(ctx.stableRoot, "launchers", plan.previousBinding.launchSetSha256),
          );
          await probeRecordedExecutables(ctx, plan.previousBinding, "previous binding");
        }
        const patch = patchForDirection(plan, rootKind, "inverse", raw.json);
        const settlement = await dispatchPatch(ctx, daemon, opId, patch);
        if (settlement === "threw") {
          throw new OperationConflict("IO_FAILURE", "config.patch threw before dispatch");
        }
        if (settlement === "outcome-unknown") {
          transition(ctx, r => {
            const recovery = findOperation(r, opId);
            if (recovery) {
              recovery.outcome = "recovery-required";
              recovery.updatedAt = now();
              recovery.conflicts = [
                ...recovery.conflicts,
                conflictOf("PATCH_OUTCOME_UNKNOWN", "inverse patch outcome unknown"),
              ].slice(0, MAX_CONFLICTS);
            }
            r.state = "RECOVERY_REQUIRED";
            r.activeOperationId = null;
          });
          return;
        }
        const livePost = (await daemon.config.get()).config;
        const post = classifyState(readRawConfig(ctx.configPath).json, livePost, plan);
        if (post.class !== "before") {
          throw new OperationConflict(
            post.class === "divergent" ? "RAW_LIVE_DIVERGENCE" : "RECOVERY_REQUIRED",
            `inverse patch did not restore the before endpoint: ${post.problems.slice(0, 8).join("; ")}`,
          );
        }
        // Post-patch verify before publishing the restored binding as ACTIVE.
        if (plan.previousBinding) {
          await deps.materializer.verifyPublished(plan.previousBinding.runtimePath, plan.previousBinding.candidateSha256, plan.previousBinding.payloadSha256);
          await deps.launchers.verify(
            join(ctx.stableRoot, "launchers", plan.previousBinding.launchSetSha256),
          );
          await probeRecordedExecutables(ctx, plan.previousBinding, "previous binding");
        }
        finalizePrevious();
        return;
      }
      throw new OperationConflict("INVALID_REQUEST", `unsupported action ${action}`);
    } catch (error) {
      recordFailure(ctx, opId, error);
    }
  }

  // -------------------------------------------------------------------------
  // status — read-only; never waits on config I/O, never mutates
  // -------------------------------------------------------------------------

  async function status(input: StatusRequest, _daemon: ConnectedDaemon): Promise<StatusResult> {
    const parsed = StatusInput.safeParse(input);
    if (!parsed.success) {
      return bounded({
        schemaVersion: 1,
        target: { hostId: "unknown", daemonHome: "/" },
        state: "INACTIVE",
        embeddedCandidateSha256: deps.payload.candidate.sha256,
        binding: null,
        managedProfiles: [],
        families: FAMILIES.map(family => ({
          family,
          availability: "unresolved" as const,
          binaryPath: null,
          observedVersion: null,
        })),
        operation: null,
        conflicts: [
          conflictOf("INVALID_REQUEST", `invalid status input: ${parsed.error.issues[0]?.message ?? "schema"}`),
        ],
        verifiedAt: null,
        retainedRuntimeCount: 0,
        communicationLanguage: null,
        liveAcceptance: "not-established-by-this-rpc",
      });
    }
    const request = parsed.data;
    const unresolvedFamilies = FAMILIES.map(family => ({
      family,
      availability: "unresolved" as const,
      binaryPath: null,
      observedVersion: null,
    }));
    let ctx: HomeContext;
    try {
      ctx = resolveHome(request.target);
    } catch (error) {
      return bounded({
        schemaVersion: 1,
        target: request.target,
        state: "INACTIVE",
        embeddedCandidateSha256: deps.payload.candidate.sha256,
        binding: null,
        managedProfiles: [],
        families: unresolvedFamilies,
        operation: null,
        conflicts: [toConflict(error)],
        verifiedAt: null,
        retainedRuntimeCount: 0,
        communicationLanguage: null,
        liveAcceptance: "not-established-by-this-rpc",
      });
    }
    // Advisory field: a language read failure must not degrade the status.
    const language = (() => {
      try {
        return readLanguage(ctx.stableRoot);
      } catch {
        return null;
      }
    })();
    let receipt: ReceiptValue | null;
    try {
      receipt = journal.read(ctx.stableRoot);
    } catch (error) {
      return bounded({
        schemaVersion: 1,
        target: { hostId: request.target.hostId, daemonHome: ctx.canonicalHome },
        state: "RECOVERY_REQUIRED",
        embeddedCandidateSha256: deps.payload.candidate.sha256,
        binding: null,
        managedProfiles: [],
        families: unresolvedFamilies,
        operation: null,
        conflicts: [toConflict(error)],
        verifiedAt: null,
        retainedRuntimeCount: 0,
        communicationLanguage: language,
        liveAcceptance: "not-established-by-this-rpc",
      });
    }
    if (!receipt) {
      // No receipt: a bounded local read decides INACTIVE vs RECOVERY_REQUIRED
      // — orphaned slp-* entries in raw config are evidence of an interrupted
      // activation whose journal vanished, not a clean home. This stays within
      // §3's read-only contract: it is a local file read, never a blocking
      // daemon/remote call, and status still performs no mutation.
      const conflicts: ConflictValue[] = [];
      let ownedPresent = false;
      try {
        const raw = readRawConfig(ctx.configPath);
        const projection = extractProjection(raw.json, "COLLISION");
        ownedPresent =
          OWNED_PROVIDER_IDS.some(id => projection.providers[id].present) ||
          projection.profiles.length > 0;
      } catch (error) {
        conflicts.push(toConflict(error));
      }
      if (request.operationId) {
        conflicts.push(conflictOf("NOT_FOUND", `no operation ${request.operationId} in this journal`));
      }
      return bounded({
        schemaVersion: 1,
        target: { hostId: request.target.hostId, daemonHome: ctx.canonicalHome },
        state: ownedPresent ? "RECOVERY_REQUIRED" : "INACTIVE",
        embeddedCandidateSha256: deps.payload.candidate.sha256,
        binding: null,
        managedProfiles: [],
        families: unresolvedFamilies,
        operation: null,
        conflicts: boundConflicts(conflicts),
        verifiedAt: null,
        retainedRuntimeCount: 0,
        communicationLanguage: language,
        liveAcceptance: "not-established-by-this-rpc",
      });
    }

    const conflicts: ConflictValue[] = [];
    if (
      receipt.target.hostId !== request.target.hostId ||
      receipt.target.daemonHome !== ctx.canonicalHome
    ) {
      conflicts.push(
        conflictOf("TARGET_MISMATCH", "receipt target does not match this daemon home/host", {
          path: journal.receiptPath(ctx.stableRoot),
        }),
      );
    }

    let state = receipt.state;
    const pending = pendingOperation(receipt);
    if (pending && isInterrupted(pending)) {
      state = "RECOVERY_REQUIRED";
      conflicts.push(
        conflictOf(
          "RECOVERY_REQUIRED",
          `operation ${pending.operationId} interrupted at phase ${pending.phase} (boot ${pending.bootId})`,
        ),
      );
    }
    if (
      (receipt.state === "ACTIVATING" || receipt.state === "DEACTIVATING") &&
      (!pending || isInterrupted(pending))
    ) {
      state = "RECOVERY_REQUIRED";
    }

    let operation: OperationViewValue | null = null;
    if (request.operationId) {
      const found = findOperation(receipt, request.operationId);
      if (found) {
        operation = opView(found);
        // The queried op's journaled findings are part of the response —
        // same surface the latest-op branch exposes below.
        if (found.conflicts.length > 0) conflicts.push(...found.conflicts);
      } else {
        conflicts.push(conflictOf("NOT_FOUND", `no operation ${request.operationId} in this journal`));
      }
    } else {
      const active = receipt.activeOperationId
        ? findOperation(receipt, receipt.activeOperationId)
        : undefined;
      const latest = active ?? receipt.operations[receipt.operations.length - 1];
      if (latest) operation = opView(latest);
      if (latest && latest.conflicts.length > 0) {
        conflicts.push(...latest.conflicts);
      }
    }

    const binding = receipt.binding;
    // Live values of the two managed profiles, for the surface's bound-state
    // editor — read-only, same local config read the no-receipt branch does.
    // A read failure reports as a conflict rather than hiding the profiles.
    let managedProfiles: StatusResult["managedProfiles"] = [];
    if (binding) {
      try {
        const raw = readRawConfig(ctx.configPath);
        managedProfiles = profilesArray(raw.json).value
          .filter(
            (entry): entry is Record<string, unknown> =>
              isRecord(entry) && typeof entry.id === "string" && OWNED_PROFILE_IDS.includes(entry.id),
          )
          .map(entry => ({
            id: entry.id as string,
            provider: typeof entry.provider === "string" ? entry.provider : null,
            model: typeof entry.model === "string" ? entry.model : null,
            modeId: typeof entry.modeId === "string" ? entry.modeId : null,
            thinkingOptionId: typeof entry.thinkingOptionId === "string" ? entry.thinkingOptionId : null,
            featureValues: isRecord(entry.featureValues) ? entry.featureValues : null,
          }));
      } catch (error) {
        conflicts.push(toConflict(error));
      }
    }
    return bounded({
      schemaVersion: 1,
      target: { hostId: request.target.hostId, daemonHome: ctx.canonicalHome },
      state,
      embeddedCandidateSha256: deps.payload.candidate.sha256,
      managedProfiles,
      binding: binding
        ? {
            bindingSha256: binding.bindingSha256,
            candidateSha256: binding.candidateSha256,
            payloadSha256: binding.payloadSha256,
            launchSetSha256: binding.launchSetSha256,
            runtimePath: binding.runtimePath,
            nodePath: binding.node.path,
            baseline: binding.baseline,
          }
        : null,
      families: binding
        ? FAMILIES.map(family => {
            const binary = binding.binaries[family];
            return binary.available
              ? {
                  family,
                  availability: "available" as const,
                  binaryPath: binary.path,
                  observedVersion: binary.version,
                }
              : {
                  family,
                  availability: "unavailable" as const,
                  binaryPath: null,
                  observedVersion: null,
                };
          })
        : unresolvedFamilies,
      operation,
      conflicts: boundConflicts(conflicts),
      verifiedAt: binding?.verifiedAt ?? null,
      retainedRuntimeCount: receipt.retained.length,
      communicationLanguage: language,
      liveAcceptance: "not-established-by-this-rpc",
    });
  }

  function close(): void {
    closed = true;
  }

  return { activate, deactivate, reconcile, status, close };
}
