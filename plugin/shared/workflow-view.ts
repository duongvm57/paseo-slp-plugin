import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { DeskWorkflowProjection, DeskWorkflowProjectionPageInput } from "./enforcement.ts";
import { Sha } from "./contracts.ts";

export const WorkflowAssignmentCursor = z.object({
  ledgerRevision: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
}).strict();

export const GetWorkspaceWorkflowInput = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1).max(256),
  assignmentId: z.string().min(1).max(1024).nullable().default(null),
  assignmentCursor: WorkflowAssignmentCursor.nullable().default(null),
  limit: z.number().int().min(1).max(50).default(20),
  page: DeskWorkflowProjectionPageInput,
}).strict().superRefine((input, ctx) => {
  if (input.assignmentId === null && input.page.cursor !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["page", "cursor"], message: "a history cursor requires an assignment" });
  }
  if (input.assignmentId !== null && input.assignmentCursor !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assignmentCursor"], message: "a list cursor cannot read assignment detail" });
  }
});

export const GetWorkspaceWorkflowOutput = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().min(1).max(256),
  state: z.enum(["ready", "absent", "unavailable", "conflict"]),
  generatedAt: z.string().datetime(),
  target: z.object({
    daemonHome: z.string().min(1).max(4096),
    workspaceDirectory: z.string().min(1).max(4096),
    repoKey: Sha,
  }).strict().nullable(),
  ledgerRevision: z.number().int().nonnegative().nullable(),
  assignments: z.array(z.object({
    id: z.string().min(1).max(1024),
    /** The whole current operative-brief objective (up to 4096 chars) when
     *  a structured brief exists; otherwise the legacy registration
     *  objective (which may be absent). `objectiveBasis` records which —
     *  a discovered summary is never authority or acceptance. */
    objective: z.string().max(4096).nullable(),
    objectiveBasis: z.enum(["brief", "registration"]),
    briefRevision: z.number().int().nonnegative(),
    state: z.enum(["open", "closed"]),
    /** Effective current owner tuple and revision — recorded desk state,
     *  not an observation of host-agent liveness. */
    ownerAgentId: z.string().min(1).max(256),
    ownerMembershipId: z.string().uuid(),
    ownershipRevision: z.number().int().nonnegative(),
    workspaceId: z.string().min(1).max(256).nullable(),
  }).strict()).max(50),
  assignmentTotal: z.number().int().nonnegative(),
  assignmentOffset: z.number().int().nonnegative(),
  assignmentNextCursor: WorkflowAssignmentCursor.nullable(),
  view: DeskWorkflowProjection.nullable(),
  problem: z.object({ code: z.string().min(1).max(80), detail: z.string().min(1).max(8192) }).strict().nullable(),
  acceptance: z.literal("not-established-by-this-view"),
}).strict();

export const getWorkspaceWorkflow = defineRpc({
  name: "get-workspace-workflow", input: GetWorkspaceWorkflowInput, output: GetWorkspaceWorkflowOutput,
});
export type WorkspaceWorkflowRequest = z.input<typeof GetWorkspaceWorkflowInput>;
export type WorkspaceWorkflowResult = z.infer<typeof GetWorkspaceWorkflowOutput>;
