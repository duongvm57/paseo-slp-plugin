// Supervision wire contracts + role predicates (spec docs/spec/supervision-
// integration.md §Configuration and authority). The store holds daemon-wide
// defaults for discovered SLP Leads plus explicit per-Lead routes; an
// explicit route always wins, including an explicit `off`. IDs are exact
// agent UUIDs, never inferred from title, cwd, workspace, or "nearest active
// Supervisor". `notify` is shadow observation plus Supervisor delivery.
import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { Id, Sha, Target } from "./contracts.ts";
import { OWNED_PROVIDER_ID_RE, ROLES } from "./families.ts";
import type { RoleName } from "./families.ts";

// Exact SLP role predicates — derived from the shared family/role registry,
// never a parallel provider list (spec: "derive role from
// plugin/shared/families.ts, not a new provider list").
export function roleFromProviderId(provider: unknown): RoleName | null {
  if (typeof provider !== "string") return null;
  const match = provider.match(OWNED_PROVIDER_ID_RE);
  if (!match) return null;
  const role = match[2];
  return (ROLES as readonly string[]).includes(role) ? (role as RoleName) : null;
}
export const isSlpLead = (provider: unknown): boolean => roleFromProviderId(provider) === "lead";
export const isSlpSupervisor = (provider: unknown): boolean => roleFromProviderId(provider) === "supervisor";
export const isSlpPeer = (provider: unknown): boolean => roleFromProviderId(provider) === "peer";

/** Statuses that can receive a Supervisor alert. `error` and `closed` are
 *  not deliverable — same rule as upstream isActiveSupervisorStatus. */
export const isActiveAgentStatus = (status: unknown): boolean =>
  status === "initializing" || status === "idle" || status === "running";

// 3: Claude Code and Devin content became transmissible (per-axis capture
// evidence). Files of schema 1 or 2 read as a migration view with
// everything off until the Human re-saves after the coverage disclosure.
export const SUPERVISION_SCHEMA_VERSION = 3;
export const SUPERVISION_PENDING_DELAY_DEFAULT_MS = 60_000;
// A pending-delay bound: anything past 24h would outlive the case itself,
// so the schema rejects it instead of storing a checkpoint that never fires.
export const SUPERVISION_PENDING_DELAY_MAX_MS = 86_400_000;
// Daemon-wide confidence threshold for every axis used in a finding — one
// value the Manager and the evaluator share (upstream alertConfidence range).
export const SUPERVISION_CONFIDENCE_DEFAULT = 0.9;
export const SUPERVISION_CONFIDENCE_MIN = 0.5;
export const SUPERVISION_CONFIDENCE_MAX = 1;

export const SupervisionMode = z.enum(["off", "shadow", "notify"]);
export type SupervisionMode = z.infer<typeof SupervisionMode>;

const PendingDelay = z.number().int().min(0).max(SUPERVISION_PENDING_DELAY_MAX_MS);

export const SupervisionRoute = z
  .object({
    leadAgentId: Id,
    leadWorkspaceId: z.string().min(1),
    supervisorAgentId: Id.nullable(),
    /** Workspace of the route's Supervisor — places the header bell. Server-
     *  derived on save when the Supervisor refreshes; otherwise the value the
     *  Manager's agent picker supplied. Null = fall back to the Lead's
     *  workspace (schema-2 files written before this field). */
    supervisorWorkspaceId: z.string().min(1).nullable().default(null),
    mode: SupervisionMode,
    pendingDelayMs: PendingDelay.default(SUPERVISION_PENDING_DELAY_DEFAULT_MS),
  })
  .strict()
  .check(ctx => {
    const route = ctx.value;
    if (route.mode === "notify" && route.supervisorAgentId === null) {
      ctx.issues.push({
        code: "custom",
        path: ["supervisorAgentId"],
        message: 'mode "notify" requires a Supervisor agent ID',
        input: route.supervisorAgentId,
      });
    }
    if (route.supervisorAgentId !== null && route.supervisorAgentId === route.leadAgentId) {
      ctx.issues.push({
        code: "custom",
        path: ["supervisorAgentId"],
        message: "supervisorAgentId must differ from leadAgentId",
        input: route.supervisorAgentId,
      });
    }
    if (route.supervisorAgentId === null && route.supervisorWorkspaceId !== null) {
      ctx.issues.push({
        code: "custom",
        path: ["supervisorWorkspaceId"],
        message: "supervisorWorkspaceId requires a Supervisor agent ID",
        input: route.supervisorWorkspaceId,
      });
    }
  });
export type SupervisionRoute = z.infer<typeof SupervisionRoute>;

/** Defaults applied to every SLP Lead the observer discovers on this daemon
 *  that has no explicit route. Off unless the Human selects a mode.
 *  supervisorWorkspaceId is server-derived from the refreshed Supervisor on
 *  save (it places the header bell); a client value is overwritten. */
export const SupervisionDefaults = z
  .object({
    mode: SupervisionMode,
    supervisorAgentId: Id.nullable(),
    supervisorWorkspaceId: z.string().min(1).nullable(),
    pendingDelayMs: PendingDelay,
  })
  .strict()
  .check(ctx => {
    const defaults = ctx.value;
    if (defaults.mode === "notify" && defaults.supervisorAgentId === null) {
      ctx.issues.push({
        code: "custom",
        path: ["supervisorAgentId"],
        message: 'default mode "notify" requires a default Supervisor agent ID',
        input: defaults.supervisorAgentId,
      });
    }
    if (defaults.supervisorAgentId === null && defaults.supervisorWorkspaceId !== null) {
      ctx.issues.push({
        code: "custom",
        path: ["supervisorWorkspaceId"],
        message: "supervisorWorkspaceId requires a default Supervisor agent ID",
        input: defaults.supervisorWorkspaceId,
      });
    }
  });
export type SupervisionDefaults = z.infer<typeof SupervisionDefaults>;

export const DEFAULT_SUPERVISION_DEFAULTS: SupervisionDefaults = {
  mode: "off",
  supervisorAgentId: null,
  supervisorWorkspaceId: null,
  pendingDelayMs: SUPERVISION_PENDING_DELAY_DEFAULT_MS,
};

// On-disk shape of <daemonHome>/slp-runtime/state/supervision.json (schema
// 3). Duplicate leadAgentId is a file-level invariant enforced by the reader
// (broken file = off with a visible error) and by the writer.
const configShape = {
  confidenceThreshold: z.number().min(SUPERVISION_CONFIDENCE_MIN).max(SUPERVISION_CONFIDENCE_MAX),
  defaults: SupervisionDefaults,
  routes: z.array(SupervisionRoute),
};
export const SupervisionConfig = z
  .object({
    schemaVersion: z.literal(3),
    ...configShape,
  })
  .strict();
export type SupervisionConfig = z.infer<typeof SupervisionConfig>;

export const emptySupervisionConfig = (): SupervisionConfig => ({
  schemaVersion: 3,
  confidenceThreshold: SUPERVISION_CONFIDENCE_DEFAULT,
  defaults: { ...DEFAULT_SUPERVISION_DEFAULTS },
  routes: [],
});

// Schema 1 (per-Lead routes only) and schema 2 (schema 3's fields, before
// Claude/Devin content could leave the host) — read for migration, never
// written.
const LegacySupervisionFile = z
  .object({
    schemaVersion: z.literal(1),
    routes: z.array(SupervisionRoute),
  })
  .strict();
const LegacyV2SupervisionFile = z.object({ schemaVersion: z.literal(2), ...configShape }).strict();

/** An older file is presented as schema 3 with EVERY route and the defaults
 *  off: each upgrade widened what can leave the host (schema 2 added
 *  cross-Peer bodies and delivery; schema 3 added Claude Code and Devin
 *  message content), so an upgrade never widens what an earlier Human
 *  choice enabled. Previous modes and recipients stay visible so the Human
 *  can re-enable explicitly after reading the new disclosure; the file is
 *  untouched until a save, and the delivery attempt history is not reset. */
export const SupervisionMigration = z
  .object({
    fromSchemaVersion: z.union([z.literal(1), z.literal(2)]),
    disabledRoutes: z.array(z.object({
      leadAgentId: Id,
      previousMode: z.enum(["shadow", "notify"]),
    }).strict()),
    /** Schema 2 defaults that were observing (null when they were off). */
    disabledDefaults: z.object({ previousMode: z.enum(["shadow", "notify"]) }).strict().nullable().default(null),
  })
  .strict();
export type SupervisionMigration = z.infer<typeof SupervisionMigration>;

export type NormalizedSupervisionFile =
  | { ok: true; config: SupervisionConfig; migration: SupervisionMigration | null }
  | { ok: false; error: string };

const schemaDetail = (error: z.ZodError): string =>
  error.issues
    .map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ")
    .slice(0, 400);

const duplicateLead = (routes: readonly SupervisionRoute[]): string | null => {
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.leadAgentId)) return route.leadAgentId;
    seen.add(route.leadAgentId);
  }
  return null;
};

/** The ONE reader for supervision.json content — used by the state RPCs and
 *  the observer, so both apply the same migration and validation. */
export function normalizeSupervisionFile(raw: unknown): NormalizedSupervisionFile {
  const version = typeof raw === "object" && raw !== null ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version === 1) {
    const legacy = LegacySupervisionFile.safeParse(raw);
    if (!legacy.success) return { ok: false, error: `supervision.json failed schema validation: ${schemaDetail(legacy.error)}` };
    const duplicate = duplicateLead(legacy.data.routes);
    if (duplicate !== null) return { ok: false, error: `supervision.json has duplicate leadAgentId ${duplicate} — one route per Lead` };
    const disabledRoutes: SupervisionMigration["disabledRoutes"] = [];
    for (const route of legacy.data.routes) {
      if (route.mode !== "off") disabledRoutes.push({ leadAgentId: route.leadAgentId, previousMode: route.mode });
    }
    return {
      ok: true,
      config: {
        ...emptySupervisionConfig(),
        routes: legacy.data.routes.map(route => ({ ...route, supervisorWorkspaceId: null, mode: "off" as const })),
      },
      migration: { fromSchemaVersion: 1, disabledRoutes, disabledDefaults: null },
    };
  }
  if (version === 2) {
    const legacy = LegacyV2SupervisionFile.safeParse(raw);
    if (!legacy.success) return { ok: false, error: `supervision.json failed schema validation: ${schemaDetail(legacy.error)}` };
    const duplicate = duplicateLead(legacy.data.routes);
    if (duplicate !== null) return { ok: false, error: `supervision.json has duplicate leadAgentId ${duplicate} — one route per Lead` };
    const disabledRoutes: SupervisionMigration["disabledRoutes"] = [];
    for (const route of legacy.data.routes) {
      if (route.mode !== "off") disabledRoutes.push({ leadAgentId: route.leadAgentId, previousMode: route.mode });
    }
    const { defaults } = legacy.data;
    return {
      ok: true,
      config: {
        schemaVersion: 3,
        confidenceThreshold: legacy.data.confidenceThreshold,
        defaults: { ...defaults, mode: "off" },
        routes: legacy.data.routes.map(route => ({ ...route, mode: "off" as const })),
      },
      migration: {
        fromSchemaVersion: 2,
        disabledRoutes,
        disabledDefaults: defaults.mode === "off" ? null : { previousMode: defaults.mode },
      },
    };
  }
  const parsed = SupervisionConfig.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `supervision.json failed schema validation: ${schemaDetail(parsed.error)}` };
  const duplicate = duplicateLead(parsed.data.routes);
  if (duplicate !== null) return { ok: false, error: `supervision.json has duplicate leadAgentId ${duplicate} — one route per Lead` };
  return { ok: true, config: parsed.data, migration: null };
}

/** The route a Lead is actually observed under. `source: "default"` means
 *  the Lead was discovered and follows the daemon defaults; its workspace is
 *  the discovered one (presentation only — no binding to verify). */
export interface EffectiveRoute {
  leadAgentId: string;
  leadWorkspaceId: string | null;
  supervisorAgentId: string | null;
  mode: "shadow" | "notify";
  pendingDelayMs: number;
  source: "route" | "default";
}

export function explicitRoute(config: SupervisionConfig | null, leadId: string): SupervisionRoute | undefined {
  return config?.routes.find(route => route.leadAgentId === leadId);
}

/** Resolution order: an explicit route wins (an explicit off observes
 *  nothing); otherwise a DISCOVERED SLP Lead follows active defaults. The
 *  caller decides discovery — a Lead is discovered only from a lifecycle
 *  record or refresh whose provider is an exact slp-<family>-lead.
 *  An explicit active route also needs discovery: a save may accept a Lead
 *  the host could not refresh (pending verification), so the route observes
 *  only once host evidence shows an exact SLP Lead in the route's workspace. */
export function effectiveRoute(
  config: SupervisionConfig | null,
  leadId: string,
  discovered: { workspaceId: string | null } | null,
): EffectiveRoute | null {
  if (config === null) return null;
  const route = explicitRoute(config, leadId);
  if (route !== undefined) {
    if (route.mode === "off") return null;
    if (discovered === null || discovered.workspaceId !== route.leadWorkspaceId) return null;
    return {
      leadAgentId: route.leadAgentId,
      leadWorkspaceId: route.leadWorkspaceId,
      supervisorAgentId: route.supervisorAgentId,
      mode: route.mode,
      pendingDelayMs: route.pendingDelayMs,
      source: "route",
    };
  }
  if (config.defaults.mode === "off" || discovered === null) return null;
  // A Supervisor is never observed as its own Lead.
  if (config.defaults.supervisorAgentId === leadId) return null;
  return {
    leadAgentId: leadId,
    leadWorkspaceId: discovered.workspaceId,
    supervisorAgentId: config.defaults.supervisorAgentId,
    mode: config.defaults.mode,
    pendingDelayMs: config.defaults.pendingDelayMs,
    source: "default",
  };
}

/** True when defaults could admit a not-yet-verified Lead — the hook uses
 *  it to decide whether a Peer event of an unknown parent is worth a
 *  verification job. */
export const defaultsActive = (config: SupervisionConfig | null): boolean =>
  config !== null && config.defaults.mode !== "off";

/** Delivery recipients that are live in notify mode, with the workspace the
 *  header bell belongs to: the recorded Supervisor workspace (a route
 *  written before that field falls back to its Lead's workspace). */
export function notifyRecipients(config: SupervisionConfig | null): { agentId: string; workspaceId: string; source: "route" | "default" }[] {
  if (config === null) return [];
  const out = new Map<string, { agentId: string; workspaceId: string; source: "route" | "default" }>();
  const { defaults } = config;
  if (defaults.mode === "notify" && defaults.supervisorAgentId !== null && defaults.supervisorWorkspaceId !== null) {
    out.set(`${defaults.supervisorAgentId}\0${defaults.supervisorWorkspaceId}`,
      { agentId: defaults.supervisorAgentId, workspaceId: defaults.supervisorWorkspaceId, source: "default" });
  }
  for (const route of config.routes) {
    if (route.mode !== "notify" || route.supervisorAgentId === null) continue;
    const workspaceId = route.supervisorWorkspaceId ?? route.leadWorkspaceId;
    const key = `${route.supervisorAgentId}\0${workspaceId}`;
    if (!out.has(key)) out.set(key, { agentId: route.supervisorAgentId, workspaceId, source: "route" });
  }
  return [...out.values()];
}

/** Disable-notifications transform: every notify becomes shadow (observation
 *  continues, nothing is delivered). Recipients are kept so re-enabling is
 *  one explicit choice. */
export function withoutNotify(config: SupervisionConfig): SupervisionConfig {
  return {
    ...config,
    defaults: config.defaults.mode === "notify" ? { ...config.defaults, mode: "shadow" } : config.defaults,
    routes: config.routes.map(route => (route.mode === "notify" ? { ...route, mode: "shadow" as const } : route)),
  };
}

// ---------------------------------------------------------------------------
// Observer metadata (spec §Shadow evidence and operator surface) —
// METADATA ONLY: no message bodies, no keys. The bounded ring
// (state/supervision-cases.json, ≤200 entries or 30 days) survives restarts
// so a pilot keeps its review trail.
// ---------------------------------------------------------------------------

/** UI-visible case states (spec: "distinguish observed, evaluated, unknown,
 *  suspected drift, and notification delivery uncertain"). */
export const SupervisionCaseState = z.enum([
  "observed",
  "evaluated",
  "unknown",
  "suspected_drift",
  "notification_uncertain",
]);
export type SupervisionCaseState = z.infer<typeof SupervisionCaseState>;

// Per-axis choice + confidence (+ the full distribution since rubric 2).
const SupervisionAxis = z.object({
  choice: z.string().max(40),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string().max(40), z.number().min(0).max(1)).optional(),
}).strict();

export const SupervisionAssessmentSummary = z.object({
  at: z.string(),
  model: z.string(),
  /** Rows written before rubric versioning read as "legacy-1" — their
   *  choices mean the old presence-checking rubric, never rubric 2. */
  rubricVersion: z.string().max(80).default("legacy-1"),
  /** Capture parser generation the packet was built with ("legacy-1" on
   *  rows written before per-axis capture evidence). */
  captureVersion: z.string().max(80).default("legacy-1"),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }).nullable(),
  choices: z.object({
    leadBrief: SupervisionAxis,
    peerHandback: SupervisionAxis,
    leadHandling: SupervisionAxis,
  }).strict(),
  /** Code-offered candidate links Jev selected (call ids, never bodies). */
  links: z.object({
    dispositionMessage: z.string().max(200).nullable(),
    briefCorrection: z.string().max(200).nullable(),
    handbackCorrection: z.string().max(200).nullable(),
  }).strict().default({ dispositionMessage: null, briefCorrection: null, handbackCorrection: null }),
}).strict();
export type SupervisionAssessmentSummary = z.infer<typeof SupervisionAssessmentSummary>;

/** One independent finding. Immutable once recorded; a later linked
 *  correction marks it resolved without erasing it. */
export const SupervisionFinding = z.object({
  axis: z.enum(["brief", "handback", "handling"]),
  choice: z.string().max(40),
  confidence: z.number().min(0).max(1),
  at: z.string(),
  status: z.enum(["open", "resolved"]),
  /** callId of the linked message: the mishandling send for a handling
   *  finding; the correcting send once resolved. */
  evidenceCallId: z.string().max(200).nullable(),
  resolvedBy: z.string().max(200).nullable(),
  resolvedAt: z.string().nullable(),
}).strict();
export type SupervisionFinding = z.infer<typeof SupervisionFinding>;

/** Supervisor delivery state for a case. accepted = the host accepted the
 *  prompt request (not proof it was read); uncertain = failure/timeout after
 *  the attempt was reserved (never retried); deferred = the Supervisor was
 *  running, no attempt made yet; canceled = route/recipient changed before
 *  dispatch; blocked = a precondition failed (store, recipient, guard). */
export const SupervisionDelivery = z.object({
  state: z.enum(["reserved", "accepted", "uncertain", "deferred", "canceled", "blocked"]),
  recipient: Id,
  at: z.string(),
  reason: z.string().max(200).nullable(),
  findings: z.array(z.enum(["brief", "handback", "handling"])).max(3),
}).strict();
export type SupervisionDelivery = z.infer<typeof SupervisionDelivery>;

// Ring-row compatibility: fields added after the first persisted format are
// optional-with-default (never silently drop a readable older row — a strict
// rejection would reset the whole ring file on load). `.catch(null)` keeps
// an older lastAssessment shape readable as "no summary" instead of losing
// the entire observation.
export const SupervisionObservation = z.object({
  fingerprint: Sha,
  leadAgentId: Id,
  peerId: Id,
  peerTurnId: z.string().nullable(),
  /** Turn/message IDs where available (spec §Shadow evidence): the brief and
   *  handback message ids plus the observed send call ids AND the Lead turn
   *  ids that issued them — bounded, ids only, never bodies. sendTurnIds is
   *  index-aligned with sendCallIds. */
  messageIds: z.object({
    brief: z.string().nullable(),
    handback: z.string().nullable(),
    sendCallIds: z.array(z.string().max(200)).max(24),
    sendTurnIds: z.array(z.string().max(200).nullable()).max(24).default([]),
  }).strict().default({ brief: null, handback: null, sendCallIds: [], sendTurnIds: [] }),
  observedAt: z.string(),
  updatedAt: z.string(),
  state: SupervisionCaseState,
  /** Bounded local reason code — never carries message text. */
  reason: z.string().max(400).nullable(),
  /** Visibility-limit flags (bounded vocabulary from capture.ts). */
  visibility: z.array(z.string().max(80)),
  counts: z.object({
    roomMessages: z.number().int().nonnegative().default(0),
    uncertainRoomMessages: z.number().int().nonnegative().default(0),
    otherRoomMessages: z.number().int().nonnegative().default(0),
    reportMessages: z.number().int().nonnegative().default(0),
    peerSends: z.number().int().nonnegative().default(0),
  }).strict().default({ roomMessages: 0, uncertainRoomMessages: 0, otherRoomMessages: 0, reportMessages: 0, peerSends: 0 }),
  assessmentsUsed: z.number().int().nonnegative().default(0),
  lastAssessment: SupervisionAssessmentSummary.nullable().catch(null).default(null),
  /** Route the case was observed under (null on rows from before discovery). */
  route: z.object({
    source: z.enum(["route", "default"]),
    mode: z.enum(["shadow", "notify"]),
  }).strict().nullable().catch(null).default(null),
  findings: z.array(SupervisionFinding).max(3).catch([]).default([]),
  delivery: SupervisionDelivery.nullable().catch(null).default(null),
}).strict();
export type SupervisionObservation = z.infer<typeof SupervisionObservation>;

/** Bounded observer diagnostics — dropped-event / ceiling reasons only. */
export const SupervisionDiagnostics = z.object({
  droppedEvents: z.number().int().nonnegative(),
  reasons: z.array(z.string().max(200)),
}).strict();
export type SupervisionDiagnostics = z.infer<typeof SupervisionDiagnostics>;

/** Per-Lead gate reason (explicit routes and discovered Leads following
 *  defaults) — null means green; a string is the paused reason the Manager
 *  must show. */
export const SupervisionGates = z.record(z.string(), z.string().nullable());
export type SupervisionGates = z.infer<typeof SupervisionGates>;

export const SupervisionUnverified = z.object({
  agentId: Id,
  role: z.enum(["lead", "supervisor"]),
  reason: z.string().max(400),
}).strict();
export type SupervisionUnverified = z.infer<typeof SupervisionUnverified>;

// config: null = the file is invalid or the target is not the served daemon
// home — off with a visible error, never presented as an empty saved list.
// sha256: raw-file CAS token (null when no file exists).
// migration: non-null while the stored file is still schema 1 or 2.
// observations/gates/diagnostics: the live observer's readout; null when the
// observer is not running for that home.
export const GetSupervisionOutput = z.object({
  schemaVersion: z.literal(2),
  config: SupervisionConfig.nullable(),
  sha256: Sha.nullable(),
  migration: SupervisionMigration.nullable(),
  observations: z.array(SupervisionObservation).nullable(),
  gates: SupervisionGates.nullable(),
  diagnostics: SupervisionDiagnostics.nullable(),
  /** Agents a save accepted without a host snapshot (the refresh failed or
   *  returned nothing). Their routes stay inactive until the observer sees
   *  host evidence. Always [] on get-supervision. */
  unverified: z.array(SupervisionUnverified).default([]),
  error: z.string().nullable(),
}).strict();
export type GetSupervisionResult = z.infer<typeof GetSupervisionOutput>;

export const GetSupervisionInput = z.object({
  schemaVersion: z.literal(2),
  target: Target,
}).strict();
export const getSupervision = defineRpc({ name: "get-supervision", input: GetSupervisionInput, output: GetSupervisionOutput });
export type GetSupervisionRequest = z.input<typeof GetSupervisionInput>;

/** Whole-file overwrite of the store. `expectedSha256` is the sha256
 *  get-supervision returned (null = expect the file to be absent); a
 *  mismatch is an IDEMPOTENCY_CONFLICT and the client must reload first.
 *  The server rechecks the token after the awaited agent validation so a
 *  concurrent save cannot land in between. */
export const SetSupervisionInput = z.object({
  schemaVersion: z.literal(2),
  target: Target,
  config: SupervisionConfig,
  expectedSha256: Sha.nullable(),
}).strict();
export const setSupervision = defineRpc({ name: "set-supervision", input: SetSupervisionInput, output: GetSupervisionOutput });
export type SetSupervisionRequest = z.input<typeof SetSupervisionInput>;
export type SetSupervisionResult = z.infer<typeof GetSupervisionOutput>;

// --- served-home actions (header bell) ---------------------------------------
// These act on the daemon home the plugin process serves (no target: the
// bell runs on the host that owns the plugin instance). Writes go through
// the same server-side CAS writer as set-supervision.

/** Header-bell readout: notify recipients and their workspaces. */
export const SupervisionStatusOutput = z.object({
  schemaVersion: z.literal(2),
  recipients: z.array(z.object({
    agentId: Id,
    workspaceId: z.string().min(1),
    source: z.enum(["route", "default"]),
  }).strict()),
  defaultSupervisorAgentId: Id.nullable(),
  defaultMode: SupervisionMode.nullable(),
  sha256: Sha.nullable(),
  error: z.string().nullable(),
}).strict();
export type SupervisionStatusResult = z.infer<typeof SupervisionStatusOutput>;

export const SupervisionStatusInput = z.object({ schemaVersion: z.literal(2) }).strict();
export const getSupervisionStatus = defineRpc({ name: "get-supervision-status", input: SupervisionStatusInput, output: SupervisionStatusOutput });

/** notify → shadow everywhere (defaults and routes). Off stays off. */
export const DisableSupervisionNotificationsInput = z.object({ schemaVersion: z.literal(2) }).strict();
export const disableSupervisionNotifications = defineRpc({
  name: "disable-supervision-notifications",
  input: DisableSupervisionNotificationsInput,
  output: SupervisionStatusOutput,
});
