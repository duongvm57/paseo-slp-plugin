import { z } from "zod";
import { DeskTaskCommandBody, DeskTaskPlacement, DeskTaskRuntimePin, WIRE_LIMITS } from "./enforcement.ts";

const id = z.string().min(1).max(WIRE_LIMITS.deskRequestId);
const ref = z.string().min(1).max(WIRE_LIMITS.deskAuthorityRef);
const text = z.string().min(1).max(WIRE_LIMITS.deskTaskText);
const formation = {
  requestId: id, grantRef: ref.describe("Human grant pointer (assignment sentence/date); verbatim claim, never authenticated."),
  taskLabel: z.string().min(1).max(100).regex(/^[^\r\n]+$/),
  assignment: text,
  // Absent means "caller": the caller delivers through host send_agent_prompt so the host arms finish notification.
  delivery: z.enum(["caller", "server"]).optional(),
};
/** Placement/parent come from the authenticated seat, never caller labels.
 * Profiles and complete settings are server-resolved, with no overrides. */
export const DeskSeatCreateInput = z.discriminatedUnion("role", [
  z.object({ ...formation, role: z.literal("lead") }).strict(),
  z.object({ ...formation, role: z.literal("peer"), runtime: DeskTaskRuntimePin,
    disposition: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/).optional() }).strict(),
]);
export type DeskSeatCreateInputValue = z.infer<typeof DeskSeatCreateInput>;

export const DeskOperationGetInput = z.object({
  requestId: id, kind: z.enum(["seat-create", "task-deliver"]),
}).strict();

/** One new bounded outcome. Existing tasks/continuations retain the explicit
 * define/dispatch interfaces; no semantic reuse decision is automated. */
export const DeskTaskDeliverInput = z.object({
  requestId: id, assignmentId: id,
  expectedLedgerRevision: z.number().int().nonnegative(),
  expectedBriefRevision: z.number().int().nonnegative(),
  expectedOwnershipRevision: z.number().int().nonnegative(),
  task: DeskTaskCommandBody.refine(body => body.state === "open", "delivery declares a new open task"),
  runtime: DeskTaskRuntimePin, placement: DeskTaskPlacement.optional(),
  taskLabel: text.optional(), text,
  effectBudget: z.number().int().min(1).max(WIRE_LIMITS.deskTaskActions).optional(),
}).strict();
export type DeskTaskDeliverInputValue = z.infer<typeof DeskTaskDeliverInput>;

export const DeskTaskGetInput = z.object({
  assignmentId: id, taskId: id, attemptId: id.optional(),
  expectedLedgerRevision: z.number().int().nonnegative().optional(),
}).strict();
export type DeskTaskGetInputValue = z.infer<typeof DeskTaskGetInput>;
