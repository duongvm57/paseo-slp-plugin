// plugin/server/desk-seat.ts — P2-c seat binding handshake (env-only).
// Mint at agent.create, bind at agent.session_open, register-confirm at
// agent.created, revoke at agent.archived — every write goes through the
// P2-a desk store with the internal `seat.*` commands, and row state
// reaches the ledger through the §2.2 decide → state channel.
//
// Policy is data (E1/E2): DESK_FIELD_POLICY below is the §2.1 table. The
// phase code dispatches comparisons/records through it and the tests
// iterate it — there is no second field list. ExactKeys binds every policy
// branch to its SDK source type two-way at compile time (W8), so a field
// added to or removed from the SDK fails `npm run typecheck`.
//
// Fail-open (Q3): no error on these paths aborts a create or an open,
// nothing escapes a seam, and no promise is left unhandled (§5.1 G4). Each
// failure emits exactly one bounded `console.warn` line with a
// `DeskSeatDiagnostic` code — never the handle.
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type {
  PluginHookAgent,
  PluginLifecycleEvents,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { canTransitionSeatBinding, WIRE_LIMITS, type DeskRejectionValue,
  type DeskTaskActionEntryValue, type DeskTaskAttemptEntryValue, type DeskTaskDeclarationEntryValue } from "../shared/enforcement.ts";
import { Family, OperationConflict, Sha, Time } from "../shared/contracts.ts";
import { familyFromProviderId, ROLES, type FamilyId } from "../shared/runtime/families.ts";
import {
  LEDGER_LIMITS,
  createDeskStore,
  effectiveOwner,
  repoKeyFor,
  type DeskStore,
  type LedgerValue,
  type MembershipValue,
  type AssignmentValue,
  type TransactResult,
} from "./desk-store.ts";
import { canonicalJson, canonicalSha256, sha256Hex } from "./config-view.ts";

type PluginCreateRequest = {
  config: AgentSessionConfig;
  env?: Record<string, string>;
};

/** Ephemeral plugin-only ticket and the exact bounded config projection that
 *  SDK 0.10 exposes to the native before-hook. Raw request IDs, labels,
 *  parentage, workspace and keys are deliberately unavailable here. */
export interface DeskSeatTaskCreateTicketContext {
  ticket: string;
  config: {
    provider: string;
    model: string | null;
    cwd: string;
    modeId: string | null;
    thinkingOptionId: string | null;
    featureValues: Record<string, unknown> | null;
  };
}

const DeskSeatTaskCreateTicketContextSchema = z.object({
  ticket: z.string().regex(/^[0-9a-f]{64}$/),
  config: z.object({
    provider: z.string().min(1).max(WIRE_LIMITS.providerLen),
    model: z.string().min(1).max(WIRE_LIMITS.providerLen).nullable(),
    cwd: z.string().min(1).max(WIRE_LIMITS.createCwdLen).refine(isAbsolute),
    modeId: z.string().min(1).max(WIRE_LIMITS.providerLen).nullable(),
    thinkingOptionId: z.string().min(1).max(WIRE_LIMITS.providerLen).nullable(),
    featureValues: z.record(z.string().min(1).max(256), z.unknown()).nullable(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  try {
    if (Buffer.byteLength(canonicalJson(value), "utf8") > 64 * 1024) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "task ticket/config context exceeds its bounded byte size" });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "task ticket/config context is not canonical JSON" });
  }
});

type CreatedEvent = PluginLifecycleEvents["agent.created"];
type ArchivedEvent = PluginLifecycleEvents["agent.archived"];

// ---------------------------------------------------------------------------
// Field policy — the §2.1 table as data (E1). Single source; the phase code
// and the tests both read it.
// ---------------------------------------------------------------------------

export const FIELD_CELLS = ["COMPARE_EXACT", "RECORD", "JOIN", "GATE", "ROUTE", "IGNORED"] as const;
export type FieldCell = (typeof FIELD_CELLS)[number];

/** One §2.1 cell: the comparison role plus its normative rationale. */
export interface FieldRule {
  cell: FieldCell;
  note: string;
}

/** The desk env key — the only key the handshake reads or writes. */
export const DESK_HANDLE_KEY = "SLP_DESK_HANDLE";
export const DESK_TASK_CREATE_TICKET_KEY = "SLP_TASK_CREATE_TICKET";

/** The §2.1 table, verbatim. `mint.config` ↔ AgentSessionConfig,
 *  `mint` ↔ the create request, `bind` ↔ PluginSessionOpenRequest,
 *  `register`/`revoke` ↔ the lifecycle payloads — pinned two-way by the
 *  ExactKeys constants below (W8). */
export const DESK_FIELD_POLICY = {
  mint: {
    config: {
      provider: { cell: "RECORD", note: "→ row.provider; also feeds the existing R1/R3 family/role derivation" },
      cwd: { cell: "RECORD", note: "→ row.createCwd = realpath(cwd); also ROUTE — resolves the repo (§4.2)" },
      systemPrompt: { cell: "IGNORED", note: "rendered by role injection; not identity" },
      modeId: { cell: "IGNORED", note: "runtime setting, legitimately mutable; not identity" },
      model: { cell: "IGNORED", note: "runtime setting, legitimately mutable; not identity" },
      thinkingOptionId: { cell: "IGNORED", note: "runtime setting, legitimately mutable; not identity" },
      featureValues: { cell: "IGNORED", note: "runtime setting, legitimately mutable; not identity" },
      title: { cell: "IGNORED", note: "display label, mutable; not identity" },
      providerOptions: { cell: "IGNORED", note: "provider configuration; not identity" },
      toolPolicy: { cell: "IGNORED", note: "tool policy; outside P2-c identity scope" },
      mcpServers: { cell: "IGNORED", note: "graft belongs to P2-d (C1); P2-c neither reads nor writes it" },
      internal: { cell: "IGNORED", note: "the daemon never calls the hook for internal agents (agent-manager.js:684 gates on !config.internal), so the hook never sees true" },
    },
    env: { cell: "JOIN", note: "only the SLP_DESK_HANDLE key: already present → env-collision, no mint; every other key IGNORED (not the desk's)" },
  },
  bind: {
    agentId: { cell: "RECORD", note: "→ row.agentId; at most one live row per agentId (§3)" },
    workspaceId: { cell: "RECORD", note: "→ row.workspaceId (string or null). Not comparable: the create request carries only {config, env} (agent-manager.js:684-686), no workspace" },
    provider: { cell: "COMPARE_EXACT", note: "against row.provider" },
    cwd: { cell: "COMPARE_EXACT", note: "realpath(cwd) against row.createCwd; also ROUTE — resolves the repo (§4.2)" },
    reason: { cell: "GATE", note: 'only "create"; resume/refresh/import do not echo env (agent-manager.js:753,783,849)' },
    purpose: { cell: "GATE", note: 'only "interactive"; history opens no working seat' },
    env: { cell: "JOIN", note: "only the SLP_DESK_HANDLE key: absent → no-op (the seat has no membership); every other key IGNORED" },
  },
  register: {
    agent: {
      id: { cell: "JOIN", note: "live row with agentId === id" },
      workspaceId: { cell: "COMPARE_EXACT", note: "against row.workspaceId (recorded at bind); null === null matches" },
      parentAgentId: { cell: "IGNORED", note: "derived from the paseo.parent-agent-id label (plugins/lifecycle/index.js:41-50); no mint/bind-side value to compare against; the label is mutable and observed absent on this host (visibility gap). observedParentAgentId belongs to v3/P2-e" },
      provider: { cell: "COMPARE_EXACT", note: "against row.provider" },
      cwd: { cell: "COMPARE_EXACT", note: "realpath(cwd) against row.createCwd; also ROUTE — resolves the repo (§4.2)" },
      title: { cell: "IGNORED", note: "display label, mutable; not identity" },
    },
  },
  revoke: {
    agent: {
      id: { cell: "JOIN", note: "live row with agentId === id" },
      workspaceId: { cell: "IGNORED", note: "revoke is monotonic toward safety: a live row of agentId is always revoked on archived — comparing cannot change the outcome" },
      parentAgentId: { cell: "IGNORED", note: "as at register" },
      provider: { cell: "IGNORED", note: "as above" },
      cwd: { cell: "ROUTE", note: "only to locate the ledger (§4.2)" },
      title: { cell: "IGNORED", note: "as above" },
    },
    archivedAt: { cell: "IGNORED", note: "one clock source: revokedAt = at (the server clock, which also orders the sweep). archivedAt is an unbounded Time with no consumer; P2-e reconciliation may add it" },
  },
} as const satisfies {
  mint: { config: Record<string, FieldRule>; env: FieldRule };
  bind: Record<string, FieldRule>;
  register: { agent: Record<string, FieldRule> };
  revoke: { agent: Record<string, FieldRule>; archivedAt: FieldRule };
};

/** Two-way exact-key check: true iff P and T have exactly the same keys.
 *  Instantiated against the EXPORTED policy value — not an object literal —
 *  so excess-property checking never applies and the bind is real (W8). */
export type ExactKeys<P, T> =
  [Exclude<keyof P, keyof T>] extends [never]
    ? [Exclude<keyof T, keyof P>] extends [never] ? true : false
    : false;

// W8 — the seven completeness pairs. Each alias is `true` only while the
// policy branch's key set equals the SDK source's key set; adding or
// removing a source field turns it `false` and `npm run typecheck` fails.
export type MintCreateKeys = ExactKeys<typeof DESK_FIELD_POLICY.mint, { config: AgentSessionConfig; env?: Record<string, string> }>;
export type MintConfigKeys = ExactKeys<typeof DESK_FIELD_POLICY.mint.config, AgentSessionConfig>;
export type BindKeys = ExactKeys<typeof DESK_FIELD_POLICY.bind, PluginSessionOpenRequest>;
export type RegisterKeys = ExactKeys<typeof DESK_FIELD_POLICY.register, { agent: PluginHookAgent }>;
export type RegisterAgentKeys = ExactKeys<typeof DESK_FIELD_POLICY.register.agent, PluginHookAgent>;
export type RevokeKeys = ExactKeys<typeof DESK_FIELD_POLICY.revoke, { agent: PluginHookAgent; archivedAt: string }>;
export type RevokeAgentKeys = ExactKeys<typeof DESK_FIELD_POLICY.revoke.agent, PluginHookAgent>;
const _oracle: [MintCreateKeys, MintConfigKeys, BindKeys, RegisterKeys, RegisterAgentKeys, RevokeKeys, RevokeAgentKeys] = [
  true, true, true, true, true, true, true,
];
void _oracle;

// ---------------------------------------------------------------------------
// Diagnostics (§6) — one closed enum, one warn line per error.
// ---------------------------------------------------------------------------

export const DESK_SEAT_DIAGNOSTICS = [
  "no-cwd",
  "cwd-unresolvable",
  "path-too-long",
  "not-git",
  "git-probe-failed",
  "store-unreadable",
  "store-busy",
  "store-recovery-required",
  "store-io",
  "store-timeout",
  "memberships-full",
  "env-collision",
  "rejected",
] as const;
export type DeskSeatDiagnostic = (typeof DESK_SEAT_DIAGNOSTICS)[number];

export type DeskSeatOp = "mint" | "bind" | "register" | "revoke";

/** The handle is 256 bits of CSPRNG output, hex — bearer-in-practice for
 *  the seat's env (P0 §6) and never persisted anywhere (§5). */
function defaultRandomHandle(): string {
  return randomBytes(32).toString("hex");
}

/** §3 rejection-message prefixes — the store's INVALID_RECORD messages for
 *  a full table and a handle collision start with these; the §6 mapping
 *  reads them back. */
export const MEMBERSHIPS_FULL_PREFIX = "memberships-full:";
export const HANDLE_COLLISION_PREFIX = "handle-collision:";

/** The internal op identity (C7): hook-driven writes are never Human
 *  commands. */
const DESK_SEAT_ACTOR = "desk:hook";
const DESK_SEAT_ASSIGNMENT = "unassigned";

// ---------------------------------------------------------------------------
// Repo resolution (§4.2) — one error, one code.
// ---------------------------------------------------------------------------

export interface DeskRepo {
  cwdReal: string;
  gitCommonDir: string;
}
export type DeskRepoResult = { ok: true; repo: DeskRepo } | { ok: false; diagnostic: DeskSeatDiagnostic };

function isAbsolute(value: string): boolean {
  return value.startsWith("/");
}

/** §4.2 — normalize the cwd, probe the git common dir with a bounded
 *  spawnSync, and classify every failure with exactly one code. */
function resolveDeskRepo(
  cwd: unknown,
  io: { realpath: (path: string) => string; spawnGit: (cwdReal: string) => ReturnType<typeof spawnSync> },
): DeskRepoResult {
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) return { ok: false, diagnostic: "no-cwd" };
  let cwdReal: string;
  try {
    cwdReal = io.realpath(cwd);
  } catch (error) {
    // ENOENT is structural absence; every other errno (or a bare exception)
    // is an unexpected resolution failure.
    return { ok: false, diagnostic: (error as NodeJS.ErrnoException).code === "ENOENT" ? "no-cwd" : "cwd-unresolvable" };
  }
  if (cwdReal.length > LEDGER_LIMITS.pathLen) return { ok: false, diagnostic: "path-too-long" };
  const probe = io.spawnGit(cwdReal);
  if (probe.error !== undefined) return { ok: false, diagnostic: "git-probe-failed" };
  if (probe.signal !== null) return { ok: false, diagnostic: "git-probe-failed" };
  if (probe.status !== 0) return { ok: false, diagnostic: "not-git" };
  const commonDir = typeof probe.stdout === "string" ? probe.stdout.trim() : "";
  if (commonDir.length === 0) return { ok: false, diagnostic: "git-probe-failed" };
  let commonReal: string;
  try {
    commonReal = io.realpath(commonDir);
  } catch {
    return { ok: false, diagnostic: "git-probe-failed" };
  }
  if (commonReal.length > WIRE_LIMITS.targetDaemonHome) return { ok: false, diagnostic: "path-too-long" };
  return { ok: true, repo: { cwdReal, gitCommonDir: commonReal } };
}

// ---------------------------------------------------------------------------
// Internal seat commands (§3) — strict union, one `at` each, fields exactly
// the RECORD/JOIN/COMPARE_EXACT cells of the phase (§2.1), normalized.
// ---------------------------------------------------------------------------

const SeatMintCommand = z
  .object({
    kind: z.literal("seat.mint"),
    at: Time,
    membershipId: z.string().uuid(),
    bindingHandleSha256: Sha,
    provider: z.string().min(1).max(LEDGER_LIMITS.idLen),
    family: Family,
    role: z.enum(ROLES),
    createCwd: z.string().min(1).max(LEDGER_LIMITS.pathLen),
    taskCreateTicketSha256: Sha.optional(),
  })
  .strict();
const SeatBindCommand = z
  .object({
    kind: z.literal("seat.bind"),
    at: Time,
    bindingHandleSha256: Sha,
    agentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    workspaceId: z.string().min(1).max(LEDGER_LIMITS.idLen).nullable(),
    provider: z.string().min(1).max(LEDGER_LIMITS.idLen),
    cwd: z.string().min(1).max(LEDGER_LIMITS.pathLen),
  })
  .strict();
const SeatRegisterCommand = z
  .object({
    kind: z.literal("seat.register"),
    at: Time,
    agentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    workspaceId: z.string().min(1).max(LEDGER_LIMITS.idLen).nullable(),
    provider: z.string().min(1).max(LEDGER_LIMITS.idLen),
    cwd: z.string().min(1).max(LEDGER_LIMITS.pathLen),
  })
  .strict();
const SeatRevokeCommand = z
  .object({
    kind: z.literal("seat.revoke"),
    at: Time,
    agentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    reason: z.literal("archived"),
  })
  .strict();
const SeatCommand = z.discriminatedUnion("kind", [
  SeatMintCommand,
  SeatBindCommand,
  SeatRegisterCommand,
  SeatRevokeCommand,
]);

type SeatCommandValue = z.infer<typeof SeatCommand>;
type SeatDecideOk = { ok: true; events: { kind: string; payload: Record<string, unknown> }[]; memberships?: MembershipValue[] };
type SeatDecideOutcome = SeatDecideOk | DeskRejectionValue;
type DeskSeatTaskMintDecisionContext = { repoKey: string; taskCreateTicketContext: DeskSeatTaskCreateTicketContext };

function seatRejection(code: DeskRejectionValue["code"], message: string, recovery: string): DeskRejectionValue {
  return { ok: false, code, message: message.slice(0, 300), recovery: recovery.slice(0, 200) };
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "unknown issue";
}

function validateTaskMembershipClaim(
  ledger: Readonly<LedgerValue>, command: Extract<SeatCommandValue, { kind: "seat.mint" }>,
  decisionContext: DeskSeatTaskMintDecisionContext | undefined,
): NonNullable<MembershipValue["capacityClaim"]> | DeskRejectionValue {
  const deny = () => seatRejection("ACTOR_MISMATCH", "task create ticket does not match one current issued create", "retain the reserved credit; only the exact current owner/runtime/placement ticket may mint its seat");
  if (command.taskCreateTicketSha256 === undefined || decisionContext === undefined) return deny();
  const contextParsed = DeskSeatTaskCreateTicketContextSchema.safeParse(decisionContext.taskCreateTicketContext);
  if (!contextParsed.success || command.taskCreateTicketSha256 !== sha256Hex(contextParsed.data.ticket)) return deny();
  const context = contextParsed.data;
  const observedConfig = context.config;
  if (command.provider !== observedConfig.provider || command.createCwd !== observedConfig.cwd ||
      familyFromProviderId(observedConfig.provider) !== command.family) return deny();
  const roleSuffix = /-(supervisor|lead|peer)$/.exec(observedConfig.provider)?.[1];
  const markerRole = observedConfig.featureValues?.["slp_role"];
  const expectedRole = roleSuffix ?? (typeof markerRole === "string" && ROLES.includes(markerRole as typeof ROLES[number]) ? markerRole : null);
  if (expectedRole !== command.role) return deny();

  const latestCreates = new Map<string, DeskTaskActionEntryValue>();
  for (const row of ledger.taskEntries) {
    if (row.kind !== "action" || row.actionKind !== "create" || row.body?.createTicketSha256 !== command.taskCreateTicketSha256) continue;
    const prior = latestCreates.get(row.actionId);
    if (prior === undefined || prior.revision < row.revision) latestCreates.set(row.actionId, row);
  }
  const actionMatches = [...latestCreates.values()];
  if (actionMatches.length !== 1 || actionMatches[0]!.state !== "issued") return deny();
  const action = actionMatches[0]!;
  const body = action.body;
  if (body === null || action.attemptId === null || action.taskId === null) return deny();
  const attemptId = action.attemptId;
  const taskId = action.taskId;
  const assignmentId = action.assignmentId;
  const assignment = ledger.assignments.find(row => row.assignmentId === assignmentId);
  if (assignment === undefined || assignment.state !== "open") return deny();
  const owner = effectiveOwner(ledger, assignment);
  const ownerMembership = ledger.memberships.find(row => row.membershipId === owner.membershipId);
  if (ownerMembership === undefined || ownerMembership.agentId !== owner.agentId || ownerMembership.role !== "lead" ||
      ownerMembership.registeredAt === null || ownerMembership.revokedAt !== null) return deny();
  const task = ledger.taskEntries.filter((row): row is DeskTaskDeclarationEntryValue => row.kind === "task" &&
    row.assignmentId === assignmentId && row.taskId === taskId)
    .sort((a, b) => b.revision - a.revision)[0];
  const attempt = ledger.taskEntries.filter((row): row is DeskTaskAttemptEntryValue => row.kind === "attempt" &&
    row.assignmentId === assignmentId && row.attemptId === attemptId)
    .sort((a, b) => b.revision - a.revision)[0];
  if (task === undefined || attempt === undefined ||
      task.revision !== attempt.taskRevision || task.state === "withdrawn" || attempt.state !== "reserved" || attempt.member !== null ||
      attempt.ownerAgentId !== owner.agentId || attempt.ownerMembershipId !== owner.membershipId ||
      attempt.ownershipRevision !== owner.ownershipRevision || task.actorAgentId !== owner.agentId || task.actorMembershipId !== owner.membershipId) return deny();
  const currentBriefRevision = ledger.briefRevisions.filter(row => row.assignmentId === assignmentId)
    .reduce((revision, row) => Math.max(revision, row.revision), 0);
  if (attempt.briefRevision !== currentBriefRevision || task.briefRevision !== currentBriefRevision) return deny();
  const liveCreates = ledger.taskEntries.filter((row): row is DeskTaskActionEntryValue => row.kind === "action" && row.actionKind === "create" &&
    row.attemptId === attempt.attemptId).reduce((latest, row) => {
      const prior = latest.get(row.actionId);
      if (prior === undefined || prior.revision < row.revision) latest.set(row.actionId, row);
      return latest;
    }, new Map<string, DeskTaskActionEntryValue>());
  const currentIssued = [...liveCreates.values()].filter(row => row.state === "issued");
  const bodyLabels = body.labels;
  const bodyPlacement = body.placement;
  if (action.actionKind !== "create" || action.state !== "issued" || action.phase !== null || action.attemptId !== attempt.attemptId ||
      action.taskId !== task.taskId || action.callerAgentId !== owner.agentId || action.actorAgentId !== owner.agentId ||
      action.actorMembershipId !== owner.membershipId || action.ownershipRevision !== owner.ownershipRevision ||
      action.briefRevision !== currentBriefRevision || currentIssued.length !== 1 || currentIssued[0]!.actionId !== action.actionId ||
      body.createTicketSha256 !== command.taskCreateTicketSha256 || !/^[0-9a-f]{64}$/.test(String(body.publicRequestSha256 ?? "")) ||
      typeof body.publicRequestId !== "string" || body.publicRequestId.length === 0 || body.publicRequestId.length > WIRE_LIMITS.deskRequestId ||
      typeof body.hostRequestId !== "string" || body.hostRequestId.length === 0 || body.hostRequestId.length > WIRE_LIMITS.deskRequestId ||
      typeof body.idempotencyKey !== "string" || body.idempotencyKey.length === 0 || body.parent !== owner.agentId ||
      body.grantRef !== task.grants.create ||
      observedConfig.cwd !== attempt.placement.cwd || observedConfig.provider !== attempt.seatPin.provider ||
      observedConfig.model !== (attempt.seatPin.model ?? null) || observedConfig.modeId !== (attempt.seatPin.modeId ?? null) ||
      observedConfig.thinkingOptionId !== (attempt.seatPin.thinkingOptionId ?? null) ||
      canonicalSha256(observedConfig.featureValues) !== canonicalSha256(attempt.seatPin.features ?? null) ||
      canonicalSha256(body.seat) !== canonicalSha256(attempt.seatPin) || canonicalSha256(body.runtime) !== canonicalSha256(attempt.runtime) ||
      !isRecordValue(bodyLabels) || bodyLabels["slp.repo"] !== decisionContext.repoKey || bodyLabels["slp.assignment"] !== assignmentId ||
      bodyLabels["slp.task"] !== task.taskId || bodyLabels["slp.attempt"] !== attempt.attemptId || Object.hasOwn(bodyLabels, "slp.create-action") ||
      !isRecordValue(bodyPlacement) || bodyPlacement.cwd !== attempt.placement.cwd || bodyPlacement.kind !== attempt.placement.kind ||
      bodyPlacement.workspaceId !== attempt.placement.workspaceId && Object.hasOwn(bodyPlacement, "workspaceId")) return deny();
  if (ledger.memberships.some(row => row.capacityClaim?.createActionId === action.actionId)) return deny();
  return {
    version: 2,
    basis: "create-ticket",
    attemptId: attempt.attemptId,
    createActionId: action.actionId,
    createIssueRef: { entryId: action.entryId, entrySha256: action.entrySha256 },
    ticketSha256: command.taskCreateTicketSha256!,
    hostRequestId: body.hostRequestId,
    idempotencyKeySha256: sha256Hex(body.idempotencyKey),
    intendedBodySha256: action.bodySha256!,
    observedConfigSha256: canonicalSha256(observedConfig),
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The P2-c state set — no P2-c path targets `attached`/`active` (§3). */
const P2C_TARGET_STATES = new Set<string>(["unbound-open", "host-confirmed", "revoked"]);

/** §3 guard — explicit target check before the transition vocabulary; the
 *  `attached` edges of BINDING_TRANSITIONS are unreachable from P2-c. */
function guardTransition(from: MembershipValue["state"], to: MembershipValue["state"]): void {
  if (!P2C_TARGET_STATES.has(to) || !canTransitionSeatBinding(from, to)) {
    throw new Error(`seat transition ${from} → ${to} is outside the P2-c state set`);
  }
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return [...items.slice(0, index), value, ...items.slice(index + 1)];
}

/** §3 sweep — bounded, oldest first (createdAt, then membershipId), run
 *  before every command inside the same decide. Each swept row gets one
 *  `seat-revoked` event; rows beyond the cap wait for later commits. */
function sweepExpired(
  memberships: readonly MembershipValue[],
  at: string,
): { table: MembershipValue[]; changed: boolean; events: { kind: string; payload: Record<string, unknown> }[] } {
  const atMs = Date.parse(at);
  const due = memberships
    .filter(row => {
      if (row.state === "unbound-open") {
        return Date.parse(row.createdAt) + LEDGER_LIMITS.unboundTtlMs < atMs;
      }
      if (row.state === "host-confirmed") {
        return (
          row.registeredAt === null &&
          row.hostConfirmedAt !== null &&
          Date.parse(row.hostConfirmedAt) + LEDGER_LIMITS.registrationWindowMs < atMs
        );
      }
      return false;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.membershipId.localeCompare(b.membershipId))
    .slice(0, LEDGER_LIMITS.ttlSweepPerCommit);
  if (due.length === 0) return { table: [...memberships], changed: false, events: [] };
  const reasons = new Map(due.map(row => [row.membershipId, row.state === "unbound-open" ? "expired-unbound" : "registration-timeout"] as const));
  const table = memberships.map(row => {
    const reason = reasons.get(row.membershipId);
    return reason === undefined
      ? row
      : { ...row, state: "revoked" as const, revokedAt: at, revokeReason: reason };
  });
  const events = due.map(row => ({
    kind: "seat-revoked",
    payload: { membershipId: row.membershipId, reason: reasons.get(row.membershipId) },
  }));
  return { table, changed: true, events };
}

/** The §2.2 output rule: a branch that created or changed any row (sweep
 *  included) returns the full replacement table; a no-op ok branch omits
 *  it. Event ↔ table consistency is the seat decide's duty (§2.2). */
function seatOk(swept: { table: MembershipValue[]; changed: boolean; events: { kind: string; payload: Record<string, unknown> }[] }, event?: { kind: string; payload: Record<string, unknown> }): SeatDecideOk {
  const events = event === undefined ? swept.events : [...swept.events, event];
  if (event === undefined && !swept.changed) return { ok: true, events };
  return { ok: true, events, memberships: swept.table };
}

/** §3 — the pure seat decide: bounded sweep first, then the command. */
export function decideSeatCommand(
  ledger: Readonly<LedgerValue>,
  rawCommand: Record<string, unknown>,
  taskMintContext?: DeskSeatTaskMintDecisionContext,
): SeatDecideOk | DeskRejectionValue {
  const parsed = SeatCommand.safeParse(rawCommand);
  if (!parsed.success) {
    return seatRejection("INVALID_RECORD", `seat command malformed: ${firstIssue(parsed.error)}`, "seat commands are internal — this is a desk-seat bug");
  }
  const cmd = parsed.data;
  const swept = sweepExpired(ledger.memberships, cmd.at);

  if (cmd.kind === "seat.mint") {
    let capacityClaim: NonNullable<MembershipValue["capacityClaim"]> | null = null;
    if (cmd.taskCreateTicketSha256 !== undefined || taskMintContext !== undefined) {
      const checked = validateTaskMembershipClaim(ledger, cmd, taskMintContext);
      if ("ok" in checked) return checked;
      capacityClaim = checked;
    }
    if (swept.table.length >= LEDGER_LIMITS.memberships) {
      return seatRejection(
        "INVALID_RECORD",
        `${MEMBERSHIPS_FULL_PREFIX}the memberships table holds ${LEDGER_LIMITS.memberships} rows`,
        "membership compaction is maintenance authority (P2-e)",
      );
    }
    if (swept.table.some(row => row.bindingHandleSha256 === cmd.bindingHandleSha256)) {
      return seatRejection(
        "INVALID_RECORD",
        `${HANDLE_COLLISION_PREFIX}a membership already carries this handle hash`,
        "retry mints a fresh handle",
      );
    }
    // Mint creates a row — there is no prior state, so the guard is the
    // explicit target check only (§3); canTransitionSeatBinding applies to
    // state changes of existing rows.
    if (!P2C_TARGET_STATES.has("unbound-open")) {
      throw new Error("seat mint target is outside the P2-c state set");
    }
    const row: MembershipValue = {
      membershipId: cmd.membershipId,
      state: "unbound-open",
      bindingHandleSha256: cmd.bindingHandleSha256,
      provider: cmd.provider,
      family: cmd.family,
      role: cmd.role,
      createCwd: cmd.createCwd,
      openGeneration: 1,
      agentId: null,
      workspaceId: null,
      createdAt: cmd.at,
      hostConfirmedAt: null,
      registeredAt: null,
      revokedAt: null,
      revokeReason: null,
      ...(capacityClaim === null ? {} : { capacityClaim }),
    };
    return {
      ok: true,
      events: [...swept.events, { kind: "seat-minted", payload: {
        membershipId: cmd.membershipId,
        ...(capacityClaim === null ? {} : { capacityClaimSha256: canonicalSha256(capacityClaim) }),
      } }],
      memberships: [...swept.table, row],
    };
  }

  if (cmd.kind === "seat.bind") {
    const index = swept.table.findIndex(row => row.bindingHandleSha256 === cmd.bindingHandleSha256);
    if (index === -1) {
      return seatRejection("ACTOR_MISMATCH", "no membership row carries the presented handle", "mint a membership at agent.create before opening the seat");
    }
    const row = swept.table[index]!;
    if (row.state === "revoked") {
      return seatRejection("STALE_EPOCH", `membership ${row.membershipId} is revoked (${row.revokeReason})`, "spawn a new seat; binding does not resurrect");
    }
    // COMPARE_EXACT per the §2.1 bind table — the policy is the switch.
    for (const [field, rule] of Object.entries(DESK_FIELD_POLICY.bind)) {
      if (rule.cell !== "COMPARE_EXACT") continue;
      const observed = (cmd as Record<string, unknown>)[field];
      const stored = (row as unknown as Record<string, unknown>)[field === "cwd" ? "createCwd" : field];
      if (observed !== stored) {
        return seatRejection("ACTOR_MISMATCH", `bind field ${field} does not match the minted row`, "open the seat from the same provider and cwd as the create");
      }
    }
    if (row.state === "host-confirmed") {
      if (row.agentId === cmd.agentId) return seatOk(swept); // repeated bind — no change, no event
      return seatRejection("ACTOR_MISMATCH", `the handle is already bound to agent ${row.agentId}`, "each seat binds its own handle exactly once");
    }
    guardTransition(row.state, "host-confirmed");
    if (swept.table.some(other => other.agentId === cmd.agentId && other.state !== "revoked" && other.membershipId !== row.membershipId)) {
      return seatRejection("ACTOR_MISMATCH", `agent ${cmd.agentId} already holds a live membership`, "one live membership per agent");
    }
    const table = replaceAt(swept.table, index, {
      ...row,
      state: "host-confirmed",
      agentId: cmd.agentId,
      workspaceId: cmd.workspaceId,
      hostConfirmedAt: cmd.at,
    });
    return { ok: true, events: [...swept.events, { kind: "seat-host-confirmed", payload: { membershipId: row.membershipId, agentId: cmd.agentId } }], memberships: table };
  }

  if (cmd.kind === "seat.register") {
    const index = swept.table.findIndex(row => row.agentId === cmd.agentId && row.state !== "revoked");
    if (index === -1) return seatOk(swept); // no live row — fail-open, no event
    const row = swept.table[index]!;
    if (row.registeredAt !== null) return seatOk(swept); // already registered — no change
    for (const [field, rule] of Object.entries(DESK_FIELD_POLICY.register.agent)) {
      if (rule.cell !== "COMPARE_EXACT") continue;
      const observed = (cmd as Record<string, unknown>)[field];
      const stored = (row as Record<string, unknown>)[field === "cwd" ? "createCwd" : field];
      if (observed !== stored) {
        guardTransition(row.state, "revoked");
        const table = replaceAt(swept.table, index, {
          ...row,
          state: "revoked",
          revokedAt: cmd.at,
          revokeReason: "registration-mismatch",
        });
        return {
          ok: true,
          events: [...swept.events, { kind: "seat-revoked", payload: { membershipId: row.membershipId, reason: "registration-mismatch" } }],
          memberships: table,
        };
      }
    }
    // Setting registeredAt keeps the state host-confirmed — no transition,
    // so only the mismatch-revoke path above consults the vocabulary.
    const table = replaceAt(swept.table, index, { ...row, registeredAt: cmd.at });
    return { ok: true, events: [...swept.events, { kind: "seat-registered", payload: { membershipId: row.membershipId, agentId: row.agentId! } }], memberships: table };
  }

  // seat.revoke
  const index = swept.table.findIndex(row => row.agentId === cmd.agentId && row.state !== "revoked");
  if (index === -1) return seatOk(swept); // nothing live — ok, no event
  const row = swept.table[index]!;
  guardTransition(row.state, "revoked");
  const table = replaceAt(swept.table, index, {
    ...row,
    state: "revoked" as const,
    revokedAt: cmd.at,
    revokeReason: cmd.reason === "archived" ? ("archived" as const) : row.revokeReason,
  });
  return {
    ok: true,
    events: [...swept.events, { kind: "seat-revoked", payload: { membershipId: row.membershipId, reason: "archived" } }],
    memberships: table,
  };
}

// ---------------------------------------------------------------------------
// Seams (§5) — the four fail-open, budgeted entry points the composer and
// the lifecycle handlers call. Promises never reject; every store promise
// gets handlers before the budget race (G3); nothing is fire-and-forget.
// ---------------------------------------------------------------------------

export interface DeskSeatDeps {
  /** `<realpath(daemonHome)>/slp-runtime` — the store's base, resolved the
   *  same way the O1 predicate resolves it (Q1; no env-source requirement). */
  stableRoot: string;
  /** Store seam — defaults to one lazily created `createDeskStore` instance
   *  kept for the plugin process lifetime (§4.2). */
  store?: DeskStore;
  /** realpath seam — defaults to realpathSync. */
  realpath?: (path: string) => string;
  /** git-probe seam — defaults to the real bounded spawnSync probe. */
  spawnGit?: (cwdReal: string) => ReturnType<typeof spawnSync>;
  /** Handle source — defaults to 32 random bytes, hex. Never persisted. */
  randomHandle?: () => string;
  uuid?: () => string;
  now?: () => Date;
  /** warn seam — defaults to console.warn; one line per failure. */
  warn?: (line: string) => void;
  /** §7 budget seam — defaults to LEDGER_LIMITS.hookDeskTransactMs. */
  transactBudgetMs?: number;
}

export interface DeskSeat {
  deskMint(input: {
    provider: string;
    family: FamilyId;
    role: string;
    cwd: string | undefined;
    env: Record<string, string>;
    taskCreateTicketContext?: DeskSeatTaskCreateTicketContext;
  }): Promise<{ handle: string } | null>;
  deskBind(input: {
    agentId: string;
    workspaceId: string | null;
    provider: string;
    cwd: string;
    reason: PluginSessionOpenRequest["reason"];
    purpose: PluginSessionOpenRequest["purpose"];
    env: Record<string, string>;
  }): Promise<void>;
  deskRegister(event: CreatedEvent): Promise<void>;
  deskRevoke(event: ArchivedEvent): Promise<void>;
}

export function createDeskSeat(deps: DeskSeatDeps): DeskSeat {
  const uuid = deps.uuid ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const realpath = deps.realpath ?? realpathSync;
  const spawnGit = deps.spawnGit ?? ((cwdReal: string) =>
    spawnSync("git", ["--no-optional-locks", "-C", cwdReal, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      timeout: LEDGER_LIMITS.hookGitProbeMs,
      encoding: "utf8",
    }));
  const randomHandle = deps.randomHandle ?? (() => randomBytes(32).toString("hex"));
  const budgetMs = deps.transactBudgetMs ?? LEDGER_LIMITS.hookDeskTransactMs;
  // One store per stableRoot for the process lifetime, created lazily on
  // first use (§4.2) — construction touches no filesystem.
  let storeInstance: DeskStore | null = null;
  const store = (): DeskStore => (storeInstance ??= deps.store ?? createDeskStore({ stableRoot: deps.stableRoot }));
  const io = { realpath, spawnGit };

  const diagnose = (op: DeskSeatOp, code: DeskSeatDiagnostic): null => {
    warn(`slp: desk ${op} skipped: ${code}`);
    return null;
  };

  /** §6 map — one store outcome, one diagnostic code. */
  function diagnosticForRejection(rejection: DeskRejectionValue): DeskSeatDiagnostic {
    if (rejection.code === "STATE_UNREADABLE") return "store-unreadable";
    if (rejection.code === "CAPABILITY_GAP") return "store-busy";
    if (rejection.code === "RECOVERY_REQUIRED") return "store-recovery-required";
    if (rejection.code === "INVALID_RECORD" && rejection.message.startsWith(MEMBERSHIPS_FULL_PREFIX)) {
      return "memberships-full";
    }
    return "rejected";
  }

  function diagnosticForError(_error: unknown): DeskSeatDiagnostic {
    // Every unexpected failure on a seat path is an I/O-class surprise —
    // the store's typed conflicts are mapped before this point.
    return "store-io";
  }

  /** G2/G3 — race the store promise against the budget timer. The store
   *  promise gets its handlers attached BEFORE the race, so a late settle
   *  (commit or rejection) is consumed here and can never surface as an
   *  unhandled rejection; a late mint leaves an orphan row for the TTL
   *  sweep, and a late bind still lands before the same agent's register
   *  thanks to the store's FIFO per-repoKey mutex (§5.1 G3). */
  function withBudget<T>(promise: Promise<T>): Promise<
    | { timedOut: true }
    | { failed: true; error: unknown }
    | { timedOut: false; value: T }
  > {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<{ timedOut: true }>(resolve => {
      const t = setTimeout(() => resolve({ timedOut: true }), budgetMs);
      t.unref();
      timer = t;
    });
    const tracked = promise.then(
      value => ({ timedOut: false as const, value }),
      // F5 (§6): a rejected store promise is a distinct variant — a foreign
      // exception must reach diagnosticForError (store-io), never be
      // misread as a DeskRejection ("rejected").
      (error: unknown) => ({ failed: true as const, error }),
    );
    return Promise.race([budget, tracked]).finally(() => clearTimeout(timer));
  }

  /** One bounded transact: the git probe is already done by the caller; the
   *  budget covers only the store round-trip. A rejected store promise is a
   *  distinct variant so a foreign exception maps to store-io (§6). */
  async function transactFor(
    gitCommonDir: string,
    command: Record<string, unknown>,
    taskCreateTicketContext?: DeskSeatTaskCreateTicketContext,
  ): Promise<
    | { timedOut: true }
    | { failed: true; error: unknown }
    | { timedOut: false; value: TransactResult | OperationConflict }
  > {
    const repo = { hostId: "local", gitCommonDir };
    const repoKey = repoKeyFor(repo);
    const envelope = {
      repo,
      actorKey: DESK_SEAT_ACTOR,
      assignmentId: DESK_SEAT_ASSIGNMENT,
      requestId: uuid(),
      command,
    };
    const decide = taskCreateTicketContext === undefined
      ? decideSeatCommand
      : (ledger: Readonly<LedgerValue>, raw: Record<string, unknown>) => decideSeatCommand(ledger, raw, { repoKey, taskCreateTicketContext });
    return withBudget(store().transact(repoKey, envelope, decide));
  }

  async function deskMint(input: {
    provider: string;
    family: FamilyId;
    role: string;
    cwd: string | undefined;
    env: Record<string, string>;
    taskCreateTicketContext?: DeskSeatTaskCreateTicketContext;
  }): Promise<{ handle: string } | null> {
    const op: DeskSeatOp = "mint";
    try {
      // JOIN (mint.env): a present handle key is a collision — never mint.
      if (input.env[DESK_HANDLE_KEY] !== undefined) return diagnose(op, "env-collision");
      const envTicket = input.env[DESK_TASK_CREATE_TICKET_KEY];
      if ((envTicket === undefined) !== (input.taskCreateTicketContext === undefined)) return diagnose(op, "rejected");
      let taskCreateTicketContext: DeskSeatTaskCreateTicketContext | undefined;
      if (input.taskCreateTicketContext !== undefined) {
        const parsed = DeskSeatTaskCreateTicketContextSchema.safeParse(input.taskCreateTicketContext);
        if (!parsed.success || envTicket !== parsed.data.ticket || parsed.data.config.provider !== input.provider ||
            parsed.data.config.cwd !== input.cwd || input.cwd === undefined) return diagnose(op, "rejected");
        taskCreateTicketContext = parsed.data;
      }
      const resolved = resolveDeskRepo(input.cwd, io);
      if (!("repo" in resolved)) return diagnose(op, resolved.diagnostic);
      const handle = (deps.randomHandle ?? defaultRandomHandle)();
      const command = {
        kind: "seat.mint",
        at: now().toISOString(),
        membershipId: uuid(),
        bindingHandleSha256: sha256Hex(handle),
        provider: input.provider,
        family: input.family,
        role: input.role,
        createCwd: resolved.repo.cwdReal,
        ...(taskCreateTicketContext === undefined ? {} : { taskCreateTicketSha256: sha256Hex(taskCreateTicketContext.ticket) }),
      };
      const settled = await transactFor(resolved.repo.gitCommonDir, command, taskCreateTicketContext);
      if ("failed" in settled) return diagnose(op, diagnosticForError(settled.error));
      if (settled.timedOut) return diagnose(op, "store-timeout");
      const result = settled.value;
      if (result instanceof OperationConflict) return diagnose(op, "store-io");
      if (result.ok) return { handle };
      return diagnose(op, diagnosticForRejection(result));
    } catch (error) {
      return diagnose(op, diagnosticForError(error));
    }
  }

  async function deskBind(input: {
    agentId: string;
    workspaceId: string | null;
    provider: string;
    cwd: string;
    reason: PluginSessionOpenRequest["reason"];
    purpose: PluginSessionOpenRequest["purpose"];
    env: Record<string, string>;
  }): Promise<void> {
    const op: DeskSeatOp = "bind";
    try {
      // GATE cells (§2.1 bind): only create × interactive runs the phase.
      if (input.reason !== "create" || input.purpose !== "interactive") return;
      // JOIN (bind.env): no handle → the seat has no membership — no-op.
      const handle = input.env[DESK_HANDLE_KEY];
      if (handle === undefined) return;
      const resolved = resolveDeskRepo(input.cwd, io);
      if (!("repo" in resolved)) return void diagnose(op, resolved.diagnostic);
      const command = {
        kind: "seat.bind",
        at: now().toISOString(),
        bindingHandleSha256: sha256Hex(handle),
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        cwd: resolved.repo.cwdReal,
      };
      const settled = await transactFor(resolved.repo.gitCommonDir, command);
      if ("failed" in settled) return void diagnose(op, diagnosticForError(settled.error));
      if (settled.timedOut) return void diagnose(op, "store-timeout");
      const result = settled.value;
      if (result instanceof OperationConflict) return void diagnose(op, "store-io");
      if (result.ok) return;
      void diagnose(op, diagnosticForRejection(result));
    } catch (error) {
      void diagnose(op, diagnosticForError(error));
    }
  }

  async function deskRegister(event: CreatedEvent): Promise<void> {
    const op: DeskSeatOp = "register";
    try {
      const agent = event.agent;
      if (!agent.provider.startsWith("slp-")) return;
      const resolved = resolveDeskRepo(agent.cwd, io);
      if (!("repo" in resolved)) return void diagnose(op, resolved.diagnostic);
      const command = {
        kind: "seat.register",
        at: now().toISOString(),
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        provider: agent.provider,
        cwd: resolved.repo.cwdReal,
      };
      const settled = await transactFor(resolved.repo.gitCommonDir, command);
      if ("failed" in settled) return void diagnose(op, diagnosticForError(settled.error));
      if (settled.timedOut) return void diagnose(op, "store-timeout");
      const result = settled.value;
      if (result instanceof OperationConflict) return void diagnose(op, "store-io");
      if (result.ok) return;
      void diagnose(op, diagnosticForRejection(result));
    } catch (error) {
      void diagnose(op, diagnosticForError(error));
    }
  }

  async function deskRevoke(event: ArchivedEvent): Promise<void> {
    const op: DeskSeatOp = "revoke";
    try {
      const agent = event.agent;
      if (!agent.provider.startsWith("slp-")) return;
      const resolved = resolveDeskRepo(agent.cwd, io);
      if (!("repo" in resolved)) return void diagnose(op, resolved.diagnostic);
      const command = { kind: "seat.revoke", at: now().toISOString(), agentId: agent.id, reason: "archived" as const };
      const settled = await transactFor(resolved.repo.gitCommonDir, command);
      if ("failed" in settled) return void diagnose(op, diagnosticForError(settled.error));
      if (settled.timedOut) return void diagnose(op, "store-timeout");
      const result = settled.value;
      if (result instanceof OperationConflict) return void diagnose(op, "store-io");
      if (result.ok) return;
      void diagnose(op, diagnosticForRejection(result));
    } catch (error) {
      void diagnose(op, diagnosticForError(error));
    }
  }

  return { deskMint, deskBind, deskRegister, deskRevoke };
}
