// Semantic composition over the existing task owner. This module owns no
// task transitions: define/bootstrap/send still cross the Core admission seam.
import type { DeskTaskDeliverInputValue, DeskTaskGetInputValue } from "../shared/delegation.ts";
import type { DeskRejectionValue } from "../shared/enforcement.ts";
import { MAX_RPC_BYTES } from "../shared/contracts.ts";
import { canReadDeskWorkflow } from "./desk-assignment.ts";
import { effectiveOwner, type LedgerValue } from "./desk-store.ts";
import { currentTaskReadiness, latestTask, latestTaskEntity, runTaskCommand } from "./desk-task.ts";
import { createTaskObserver, runTaskDispatch, subRequestId, type TaskExecutionDeps } from "./desk-task-execution.ts";
import { createDeskOperations } from "./desk-operation.ts";
import { isRejection, readLedger, type RunnerCtx } from "./desk-runner.ts";

const reject = (code: DeskRejectionValue["code"], message: string): DeskRejectionValue => ({
  ok: false, code, message, recovery: "read the targeted current task/attempt pins; reconcile the recorded operation before any new delivery",
});

/** A single fully verified ledger supplies current entities and pins. History
 * remains in workflow_get; no unrelated history needs paging to send work. */
export function projectTaskCurrent(ledger: Readonly<LedgerValue>, ctx: RunnerCtx, input: DeskTaskGetInputValue) {
  if (!canReadDeskWorkflow(ledger, ctx.row, input.assignmentId)) return reject("AUTHORITY_REQUIRED", "caller has no participant access to this assignment");
  if (input.expectedLedgerRevision !== undefined && input.expectedLedgerRevision !== ledger.revision) return reject("REVISION_CONFLICT", "requested ledger revision is stale");
  const assignment = ledger.assignments.find(row => row.assignmentId === input.assignmentId);
  const task = latestTask(ledger, input.assignmentId, input.taskId);
  if (assignment === undefined || task === undefined) return reject("EVIDENCE_INCOMPLETE", "task is not present in the requested assignment");
  const attempt = input.attemptId === undefined ? null : latestTaskEntity(ledger, input.attemptId);
  if (input.attemptId !== undefined && (attempt?.kind !== "attempt" || attempt.assignmentId !== input.assignmentId || attempt.taskId !== input.taskId)) return reject("ACTOR_MISMATCH", "attempt does not belong to the requested task");
  const brief = ledger.briefRevisions.filter(row => row.assignmentId === input.assignmentId).at(-1);
  const owner = effectiveOwner(ledger, assignment);
  const current = new Map<string, typeof ledger.taskEntries[number]>();
  for (const row of ledger.taskEntries) {
    if (row.assignmentId !== input.assignmentId || row.taskId !== input.taskId) continue;
    if (input.attemptId !== undefined && "attemptId" in row && row.attemptId !== input.attemptId) continue;
    const prior = current.get(row.entityId);
    if (prior === undefined || row.revision > prior.revision) current.set(row.entityId, row);
  }
  // Effect/resource observations are compact identities and dispositions.
  // Full action bodies, proof maps and handbacks stay on existing views.
  const entities = [...current.values()].filter(row => row.kind !== "task" && row.kind !== "attempt").map(row => ({
    kind: row.kind, entityId: row.entityId, revision: row.revision, entrySha256: row.entrySha256,
    state: "state" in row ? row.state : "disposition" in row ? row.disposition : null,
  }));
  const view = { ok: true as const, assignmentId: input.assignmentId, taskId: input.taskId,
    pins: { expectedLedgerRevision: ledger.revision, expectedBriefRevision: brief?.revision ?? 0,
      expectedOwnershipRevision: owner.ownershipRevision, expectedTaskRevision: task.revision,
      ...(attempt?.kind === "attempt" ? { attemptId: attempt.attemptId, expectedAttemptRevision: attempt.revision } : {}) },
    owner, task, attempt, readiness: currentTaskReadiness(ledger, assignment, task), entities,
    acceptance: "not-established-by-this-view" as const };
  if (Buffer.byteLength(JSON.stringify(view)) > MAX_RPC_BYTES) return reject("VIEW_TOO_LARGE", "complete targeted task view exceeds its budget");
  return view;
}

export async function runTaskDeliver(ctx: RunnerCtx, input: DeskTaskDeliverInputValue, deps: TaskExecutionDeps) {
  if (ctx.row.agentId === null || ctx.row.role !== "lead") return reject("AUTHORITY_REQUIRED", "task delivery requires a live Lead owner");
  const createGrant = input.task.grants.create, sendGrant = input.task.grants.send;
  if (createGrant === null || sendGrant === null) return reject("AUTHORITY_REQUIRED", "task delivery requires separate declared create and send grants");
  const ops = createDeskOperations(deps.scratch.stableRoot);
  return ops.run({ repoKey: ctx.repoKey, agentId: ctx.row.agentId, membershipId: ctx.row.membershipId,
    kind: "task-deliver", requestId: input.requestId }, input, async phase => {
    const taskDeps = { store: deps.store, observe: createTaskObserver(ctx, deps) };
    phase("define-issued", { requestId: subRequestId(input.requestId, "define") });
    const defined = await runTaskCommand(ctx, {
      operation: "define", requestId: subRequestId(input.requestId, "define"), assignmentId: input.assignmentId,
      taskId: null, expectedTaskRevision: 0, expectedLedgerRevision: input.expectedLedgerRevision,
      expectedBriefRevision: input.expectedBriefRevision, expectedOwnershipRevision: input.expectedOwnershipRevision,
      task: input.task,
    }, taskDeps);
    phase("defined", defined);
    if (isRejection(defined) || defined.taskId == null) return defined;
    const taskId = defined.taskId;
    const ledger = readLedger(deps, ctx.repoKey); if (isRejection(ledger)) return ledger;
    const task = latestTask(ledger, input.assignmentId, taskId);
    if (task === undefined || task.revision !== 1) return reject("REVISION_CONFLICT", "new task changed before reservation");
    const placement = input.placement ?? { kind: "shared-checkout", cwd: ctx.row.createCwd,
      ...(ctx.row.workspaceId !== null ? { workspaceId: ctx.row.workspaceId } : {}) };
    phase("bootstrap-issued", { taskId, requestId: subRequestId(input.requestId, "bootstrap") });
    const created = await runTaskDispatch(ctx, {
      phase: "bootstrap", requestId: subRequestId(input.requestId, "bootstrap"), assignmentId: input.assignmentId,
      taskId, expectedLedgerRevision: ledger.revision,
      expectedBriefRevision: input.expectedBriefRevision, expectedOwnershipRevision: input.expectedOwnershipRevision,
      expectedTaskRevision: task.revision, attemptId: null, expectedAttemptRevision: 0,
      runtime: input.runtime, placement, grantRef: createGrant,
      ...(input.taskLabel !== undefined ? { title: input.taskLabel } : {}),
      ...(input.effectBudget !== undefined ? { effectBudget: input.effectBudget } : {}),
    }, deps);
    phase("bootstrapped", created);
    if (isRejection(created) || created.state !== "bound" || typeof created.attemptId !== "string") return { taskId, ...created };
    const after = readLedger(deps, ctx.repoKey); if (isRejection(after)) return after;
    const view = projectTaskCurrent(after, ctx, { assignmentId: input.assignmentId, taskId, attemptId: created.attemptId });
    if (isRejection(view)) return view;
    if (view.pins.expectedBriefRevision !== input.expectedBriefRevision || view.pins.expectedOwnershipRevision !== input.expectedOwnershipRevision || view.pins.expectedTaskRevision !== task.revision) {
      return { ...reject("REVISION_CONFLICT", "brief/owner/task changed during composition"), taskId, attemptId: created.attemptId };
    }
    if (view.attempt?.kind !== "attempt") return reject("EVIDENCE_INCOMPLETE", "created attempt cannot supply send pins");
    phase("send-issued", { taskId, attemptId: created.attemptId, requestId: subRequestId(input.requestId, "send"), pins: view.pins });
    const sent = await runTaskDispatch(ctx, {
      phase: "send", requestId: subRequestId(input.requestId, "send"), assignmentId: input.assignmentId, taskId,
      expectedLedgerRevision: after.revision, expectedBriefRevision: input.expectedBriefRevision,
      expectedOwnershipRevision: input.expectedOwnershipRevision, expectedTaskRevision: task.revision,
      attemptId: view.attempt.attemptId, expectedAttemptRevision: view.attempt.revision,
      grantRef: sendGrant, text: input.text,
    }, deps);
    phase("sent", sent);
    const final = readLedger(deps, ctx.repoKey);
    return { taskId, attemptId: created.attemptId, delivery: sent,
      current: isRejection(final) ? final : projectTaskCurrent(final, ctx, { assignmentId: input.assignmentId, taskId, attemptId: created.attemptId }) };
  });
}
