// Shared enforcement wire/view contracts for the mechanize-enforcement desk
// (P0). Same boundary rules as contracts.ts: shared/ modules may import only
// zod, react-family specifiers and @getpaseo/plugin — no node builtins. This
// file holds client-safe wire and view shapes ONLY: durable ledger records
// (assignments, memberships, candidates, review/decision/settlement state)
// are server-internal schemas and must not live here.
//
// Two guarantees the schemas encode by shape:
//   - `acceptance` is a literal "not-established-by-this-view" — a read view
//     can never be parsed as a verdict or an acceptance record.
//   - Capability status defaults are the producer's concern; the wire marks
//     every record with its evidence kind so `source-static-compat` and
//     `live-probe` can never be silently conflated downstream.

import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { Family, Sha, Time, isAbsolutePath } from "./contracts.ts";

/** The closed ledger vocabulary (§2.1): every collection the producer may
 *  charge an omission against. Enum order is the canonical ledger sort order —
 *  ordinal, never locale. providerTools moved to the P1 backlog (gap
 *  `providerTools-projection`); `view` is absent because a producer-invalid
 *  output throws IO_FAILURE rather than emitting a marker. */
export const CompletenessCollection = z.enum([
  /** One envelope observation of the endpoint — not per-agent rows. */
  "agents.list",
  "capabilities",
  "gaps",
  "bindings",
  "limitations",
  /** One ledger entry dropped by the producer (normally zero). */
  "completeness",
]);

/** Why a value, field or row did not make it into the view. */
export const CompletenessReason = z.enum([
  /** A value exceeded its wire bound and could not be represented raw. */
  "field-overflow",
  /** A source entry did not match the expected shape. */
  "malformed",
  /** A membership row without an agentId cannot be projected to a seat —
   *  counted, never shown (P2-e §4.2). */
  "state-excluded",
  /** A wire-required field was present but empty. */
  "empty",
  /** A collection cap dropped trailing (sorted) rows. */
  "row-limit",
  /** The source itself reports more data exists than was delivered —
   *  reserved for projected collections; distinct from producer caps. */
  "source-incomplete",
  /** Reserved for an aggregate emit bound — unreachable under the pinned P0
   *  capacity vector (the final guard throws instead of shedding). */
  "aggregate-shed",
]);

/** Wire bounds — the ONE authoritative source for every collection and
 *  field cap on this surface. Schemas and the server producer both read
 *  from here; no observer or schema may restate a literal. The producer's
 *  rule is raw-or-elide: a value is emitted verbatim when it satisfies the
 *  bound, else the field/row is omitted and recorded in `completeness` —
 *  a prefix is never an identity. */
export const WIRE_LIMITS = {
  // Capability / gap / binding records — the pinned P0 scalar maxima.
  capabilityId: 64,
  sourceRef: 128,
  evidenceRef: 128,
  missingPrimitive: 128,
  neededBy: 64,
  ownerAction: 128,
  membershipId: 128,
  agentId: 128,
  /** Per-record free-form limitation strings and their collection cap. */
  limitationLen: 128,
  recordLimitations: 4,
  mcpToolRefLen: 256,
  rejectionMessage: 2048,
  rejectionRecovery: 1024,
  /** Install-receipt projection bounds — typed, never raw file content. */
  installationState: 64,
  installationError: 256,
  /** Caller-supplied enforcement target bounds (chars) — narrower than the
   *  manager's `Target`, whose daemonHome stays at 4096. */
  targetHostId: 256,
  targetDaemonHome: 256,
  // enforcement-status view
  /** Page bound for the agents.list endpoint observation (no rows are
   *  projected — the fetch only proves the surface answered). */
  agentsListPage: 64,
  limitations: 16,
  /** Ledger slots = every (collection, reason) pair — computed from the
   *  enums, never hand-written, so the ledger can hold one entry per kind. */
  completenessEntries: CompletenessCollection.options.length * CompletenessReason.options.length,
  /** Per-pair omission count ceiling — finite so a count can never be a
   *  float or an escape past the capacity contract. */
  completenessCount: Number.MAX_SAFE_INTEGER,
  /** Exact P0+P2-d inventory: 15 host-wide rows + 6 rows × 4 families.
   *  Growth without a pin raise is producer-invalid, never a row-limit
   *  shed. */
  capabilities: 39,
  /** Exact P0+P2-d inventory: the mandatory `providerTools-projection`
   *  row + the P2-d `invoke-plugin-rpc-mcp` operator-transport gap +
   *  4 probe gaps × 4 families. */
  gaps: 18,
  /** P2-e membership projection — the cap is the largest of {64, 32, 16}
   *  whose worst-case enforcement-status output stays under MAX_RPC_BYTES
   *  (measured by the capacity fixture, §4.4); rows beyond it shed
   *  oldest-first into `row-limit`. */
  bindings: 16,
  /** Repo-ledger scan bound for the bindings projection — an interactive
   *  call, each ledger up to LEDGER_LIMITS.ledgerBytes; 16 caps the
   *  worst-case read cost. Repos beyond the cap are source-incomplete. */
  bindingsRepos: 16,
  // enforcement-runtime-pin (P2-b): pin field and limitation caps. The pin's
  // node.path pins at the manager's daemonHome cap, not the narrower
  // enforcement target cap.
  runtimePinPath: 4096,
  runtimePinNodeVersion: 64,
  runtimePinLimitations: 4,
  runtimePinLimitationLen: 160,
  // enforcement-recover-lock (P2-e): actor key (prefix + username) is
  // refused, never truncated, past the cap; the nonce is opaque and
  // bounded by length only — the writer emits randomUUID, the reader
  // accepts any nonempty string up to the cap; the result name bound
  // covers the longest result string.
  recoverActorKey: 128,
  recoverNonce: 64,
  recoverResult: 32,
  // desk MCP bridge (P2-d): raw UTF-8 line caps per direction — inbound
  // request frames to the adapter (and seat-side stdin) vs outbound
  // response frames (adapter writes and socket→stdout relay). Both are
  // 256 KiB; keeping them as separate keys lets a later phase widen one
  // without touching the other. Plus the bounded handle/tool-name/args
  // lengths on the hello and tools/call envelope.
  deskBridgeRequestBytes: 262144,
  deskBridgeResponseBytes: 262144,
  deskBridgeHandle: 512,
  deskBridgeToolName: 64,
  deskBridgeToolDescription: 256,
  deskBridgeLimitations: 8,
  // Desk mutations (P3-a): request ids and entity ids are bounded opaque
  // strings; authorityRef is a verbatim pointer the desk stores but never
  // dereferences; recordV1 rides inside the 256KiB frame cap and the
  // durable row re-caps it at LEDGER_LIMITS.handbackRecordBytes. Status
  // projections shed rows beyond the per-view caps into limitations.
  deskRequestId: 128,
  deskEntityId: 128,
  deskAuthorityRef: 1024,
  deskObjective: 2048,
  deskStatusAssignments: 64,
  deskStatusSeats: 32,
  deskStatusHandbacks: 64,
  deskStatusGaps: 16,
  /** Seat/membership field bounds shared durable↔wire: the durable
   *  MembershipSchema consumes the same keys, so a ledger-valid row can
   *  never fail the status schema — identity fields are never truncated.
   *  Values equal the durable maxima the fields had under LEDGER_LIMITS. */
  providerLen: 128,
  workspaceIdLen: 128,
  createCwdLen: 4096,
  roleLen: 32,
  /** Handback gap strings — the durable HandbackSchema reads this same
   *  key, so a ledger-valid row's gaps always parse under the submit
   *  result schema (the producer returns them verbatim; F-STD-4). */
  gapLen: 256,
  // Desk settlement mirror (P3-b): pointer refs are claimed provenance
  // pointers (delivery evidence, rework closure, sink, external decision)
  // bounded like authorityRef and stored verbatim — the desk never
  // dereferences them. Refs/resources are bounded collections; the
  // durable SettlementSchema reads the SAME keys so a ledger-valid row
  // can never exceed what a wire input or result schema accepts.
  deskSettlementPointer: 1024,
  deskSettlementRefs: 64,
  deskSettlementResources: 32,
  deskSettlementTitle: 256,
  deskTimelineField: 1024,
  deskExportPath: 1024,
  /** Per-assignment settlements cap inside the status projection. */
  deskStatusSettlements: 32,
  // Desk scope/review machinery (P4): a scope declaration is an opaque
  // bounded id plus a canonical label, a declaration digest the caller
  // attests and bounded claimed refs — never a filesystem path set or
  // filesystem authority. The durable scope/review/transition schemas read
  // the SAME keys so a ledger-valid row can never exceed what a wire
  // input or result schema accepts (the F-STD-4 rule).
  deskScopeLabel: 256,
  deskScopeRefs: 32,
  deskScopePointer: 1024,
  /** Per-assignment scopes cap inside the status projection, plus the
   *  per-scope review-row cap the projection carries. */
  deskStatusScopes: 32,
  deskStatusScopeReviews: 32,
} as const;

// ---------------------------------------------------------------------------
// Capability audit records (P0)
// ---------------------------------------------------------------------------

/** Tri-state with an explicit floor: records never invent support — absent
 *  evidence renders `unknown`, never `supported`. */
export const CapabilityStatus = z.enum(["supported", "unsupported", "unknown"]);

/** How the record's status was established. `source-static-compat` is
 *  source/type inspection of the host — plumbing existence, never live
 *  delivery proof. `live-probe` is reserved for an observed provider run. */
export const CapabilityEvidenceKind = z.enum([
  "source-static-compat",
  "host-observation",
  "live-probe",
  "none",
]);

/** The four mandated delivery probes of the P0 assignment. */
export const CapabilityProbeId = z.enum(["a", "b", "c", "d"]);

export const CapabilitySource = z.enum([
  "paseo-src",
  "paseo-sdk",
  "host-rpc",
  "host-file",
  "none",
]);

export const CapabilityRecord = z.object({
  schemaVersion: z.literal(1),
  capabilityId: z.string().min(1).max(WIRE_LIMITS.capabilityId),
  /** Provider family the row is about; null = host-wide surface. */
  family: Family.nullable(),
  /** Which mandated probe (a)–(d) this record speaks for, if any. */
  probeId: CapabilityProbeId.nullable(),
  status: CapabilityStatus,
  source: CapabilitySource,
  /** Path/RPC/manifest ref for the source; version-pinned when known. */
  sourceRef: z.string().min(1).max(WIRE_LIMITS.sourceRef).nullable(),
  evidenceKind: CapabilityEvidenceKind,
  /** Inspectable pointer for the evidence (file@rev, RPC name, artifact). */
  evidenceRef: z.string().min(1).max(WIRE_LIMITS.evidenceRef).nullable(),
  observedAt: Time.nullable(),
  limitations: z.array(z.string().min(1).max(WIRE_LIMITS.limitationLen)).max(WIRE_LIMITS.recordLimitations),
}).strict();

/** An explicit capability gap: what is missing, what it blocks, who acts. */
export const CapabilityGap = z.object({
  capabilityId: z.string().min(1).max(WIRE_LIMITS.capabilityId),
  family: Family.nullable(),
  /** Exact missing host/owner primitive — not a workaround description. */
  missingPrimitive: z.string().min(1).max(WIRE_LIMITS.missingPrimitive),
  /** The probe/command/view that needs it. */
  neededBy: z.string().min(1).max(WIRE_LIMITS.neededBy),
  /** Owner and action that could supply it (Human grant, host feature, seat). */
  ownerAction: z.string().min(1).max(WIRE_LIMITS.ownerAction),
}).strict();

// ---------------------------------------------------------------------------
// Seat-binding view (binding-state types are the P0 seam; the durable
// membership/binding records behind them are P2 server-only schemas)
// ---------------------------------------------------------------------------

/** Desk binding handshake: an open socket of authority nothing can write
 *  through until the host confirms the seat and an owner attaches it. A
 *  binding handle is a bearer credential in practice — `revoked` is the only
 *  terminal state and is reachable from every prior state. */
export const SeatBindingState = z.enum([
  "unbound-open",
  "host-confirmed",
  "attached",
  "active",
  "revoked",
]);

export const SeatBindingView = z.object({
  schemaVersion: z.literal(1),
  membershipId: z.string().min(1).max(WIRE_LIMITS.membershipId).nullable(),
  agentId: z.string().min(1).max(WIRE_LIMITS.agentId),
  family: Family.nullable(),
  state: SeatBindingState,
  epoch: z.number().int().nonnegative().nullable(),
  observedAt: Time.nullable(),
  limitations: z.array(z.string().min(1).max(WIRE_LIMITS.limitationLen)).max(WIRE_LIMITS.recordLimitations),
}).strict();

type SeatBindingStateValue = z.infer<typeof SeatBindingState>;

/** Pure transition vocabulary: the only edges the handshake permits. The
 *  P2 transition engine consumes this same map; a test enumerates every
 *  (from, to) pair so no silent edge exists. */
export const BINDING_TRANSITIONS = {
  "unbound-open": ["host-confirmed", "revoked"],
  "host-confirmed": ["attached", "revoked"],
  attached: ["active", "revoked"],
  active: ["revoked"],
  revoked: [],
} as const satisfies Record<SeatBindingStateValue, readonly SeatBindingStateValue[]>;

export function canTransitionSeatBinding(
  from: SeatBindingStateValue,
  to: SeatBindingStateValue,
): boolean {
  return (BINDING_TRANSITIONS[from] as readonly SeatBindingStateValue[]).includes(to);
}

// ---------------------------------------------------------------------------
// toolPolicy — preapproval only. The host shape is
//   { preapproved: [{ kind: "mcp", server, tool }] }
// It suppresses prompts for tools an authority layer already allowed. It is
// NOT a deny list and cannot remove tools — deny lives in the separate
// `paseoTools.disabledTools` mechanism. There is deliberately no `denied`
// field here: strict parsing rejects one.
// ---------------------------------------------------------------------------

export const McpToolRef = z.object({
  kind: z.literal("mcp"),
  server: z.string().min(1).max(WIRE_LIMITS.mcpToolRefLen),
  tool: z.string().min(1).max(WIRE_LIMITS.mcpToolRefLen),
}).strict();

/** Single source for the preapproval bound — the wire schema and the merge
 *  fail-closed check share it so a drift between them is impossible. */
export const TOOL_POLICY_MAX_PREAPPROVED = 1024;

export const ToolPolicy = z.object({
  preapproved: z.array(McpToolRef).max(TOOL_POLICY_MAX_PREAPPROVED),
}).strict();

export type McpToolRefValue = z.infer<typeof McpToolRef>;
export type ToolPolicyValue = z.infer<typeof ToolPolicy>;

export interface ToolPolicyMergeSuccess {
  ok: true;
  /** Fresh policy value: existing grants verbatim, then new grants. */
  toolPolicy: ToolPolicyValue;
  /** Grants appended by this merge (wire-new, not previously present). */
  added: McpToolRefValue[];
  /** Requested grants skipped as already present. */
  duplicates: McpToolRefValue[];
}

/** `ok: true` + the merged policy, or a typed desk rejection when the merge
 *  would exceed the wire bound. Never a policy ToolPolicy.safeParse would
 *  reject, and never a silently trimmed grant set. */
export type ToolPolicyMerge = ToolPolicyMergeSuccess | DeskRejectionValue;

// JSON tuple key: boundary-safe even for separator bytes in names.
const refKey = (ref: McpToolRefValue) => JSON.stringify([ref.server, ref.tool]);

/** Merge grants into an existing policy without mutation: existing entries
 *  keep their order, additions dedupe on the exact (server, tool) pair —
 *  the same tool name under a different server is a different grant. Both
 *  inputs are validated first; an unparseable existing policy is a caller
 *  error, never a silent replace. The merge is atomic at the wire bound:
 *  when the result would exceed TOOL_POLICY_MAX_PREAPPROVED the caller gets
 *  a typed rejection and nothing is applied — a policy must never come back
 *  that ToolPolicy.safeParse rejects. */
export function mergeToolPolicyPreapprovals(
  existing: ToolPolicyValue | null | undefined,
  additions: readonly McpToolRefValue[],
): ToolPolicyMerge {
  const base = existing === null || existing === undefined
    ? { preapproved: [] as McpToolRefValue[] }
    : ToolPolicy.parse(existing);
  const seen = new Set(base.preapproved.map(refKey));
  const added: McpToolRefValue[] = [];
  const duplicates: McpToolRefValue[] = [];
  for (const candidate of additions) {
    const ref = McpToolRef.parse(candidate);
    const key = refKey(ref);
    if (seen.has(key)) {
      duplicates.push(ref);
    } else {
      seen.add(key);
      added.push(ref);
    }
  }
  const merged = [...base.preapproved, ...added];
  if (merged.length > TOOL_POLICY_MAX_PREAPPROVED) {
    return DeskRejection.parse({
      ok: false,
      code: "INVALID_RECORD",
      message:
        `toolPolicy merge would hold ${merged.length} preapproved grants, ` +
        `exceeding the ${TOOL_POLICY_MAX_PREAPPROVED} bound — no grants applied`,
      recovery:
        "revoke or split existing preapprovals before adding more; the desk never trims a grant set silently",
    });
  }
  return {
    ok: true,
    toolPolicy: { preapproved: merged },
    added,
    duplicates,
  };
}

// ---------------------------------------------------------------------------
// Desk error vocabulary — the closed enum the desk's Rejection envelope uses
// across all transports (P2+). P0 dispatch rejects every command with
// CAPABILITY_GAP through this same shape.
// ---------------------------------------------------------------------------

export const DeskErrorCode = z.enum([
  "AUTHORITY_REQUIRED",
  "ACTOR_MISMATCH",
  "SCOPE_CONFLICT",
  "STALE_EPOCH",
  "REVISION_CONFLICT",
  "CANDIDATE_DRIFT",
  "EVIDENCE_INCOMPLETE",
  "REVIEW_INCOMPLETE",
  "INVALID_RECORD",
  "CAPABILITY_GAP",
  "SESSION_REBIND_REQUIRED",
  "STATE_UNREADABLE",
  "IDEMPOTENCY_CONFLICT",
  "RECOVERY_REQUIRED",
  "EXECUTION_UNKNOWN",
  "JOB_RUNNING",
  // P2-d typed frame-limit codes — the desk bridge surfaces an over-cap
  // frame as a machine-readable code, never just a message string.
  "REQUEST_TOO_LARGE",
  "RESPONSE_TOO_LARGE",
  // A path component under the verified stable root is a symlink or not a
  // real directory — the host filesystem itself failed integrity.
  "RUNTIME_INTEGRITY",
]);

export const DeskRejection = z.object({
  ok: z.literal(false),
  code: DeskErrorCode,
  message: z.string().min(1).max(WIRE_LIMITS.rejectionMessage),
  /** What an operator may legitimately do next — never a silent retry hint. */
  recovery: z.string().min(1).max(WIRE_LIMITS.rejectionRecovery),
}).strict();

export type DeskRejectionValue = z.infer<typeof DeskRejection>;

// ---------------------------------------------------------------------------
// Desk MCP bridge (P2-d) — the stdio↔UDS transport contract. The seat-facing
// binary relays raw NDJSON lines to the adapter's Unix socket; the first
// line on every connection is the hello carrying the minted desk handle —
// the ONLY caller-supplied identity (the adapter resolves membership and
// actor server-side; role/cwd claims are never trusted). A bounded
// connection-level schema keeps the wire honest end to end.
// ---------------------------------------------------------------------------

/** The pinned bridge protocol literal — handshake, graft manifest and the
 *  packaged binary all carry exactly this string. */
export const DESK_BRIDGE_PROTOCOL = "slp-desk-bridge/1";

export const DeskBridgeHello = z.object({
  schemaVersion: z.literal(1),
  protocol: z.literal(DESK_BRIDGE_PROTOCOL),
  handle: z.string().min(1).max(WIRE_LIMITS.deskBridgeHandle),
  /** sha256 of the packaged bin/slp-desk-mcp.mjs the seat is running —
   *  self-reported drift check against the binding's recorded pin; never a
   *  trust decision on its own. */
  bridgeSha256: Sha,
  pid: z.number().int().positive().optional(),
}).strict();

/** The adapter's single-line handshake answer. Rejections carry the same
 *  typed vocabulary as every other desk surface; on `ok:false` the adapter
 *  closes the connection. */
export const DeskBridgeAck = z.union([
  z.object({
    schemaVersion: z.literal(1),
    protocol: z.literal(DESK_BRIDGE_PROTOCOL),
    ok: z.literal(true),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    protocol: z.literal(DESK_BRIDGE_PROTOCOL),
    ok: z.literal(false),
    error: z.object({
      code: DeskErrorCode,
      message: z.string().min(1).max(WIRE_LIMITS.rejectionMessage),
    }).strict(),
  }).strict(),
]);

/** tools/call parameter envelope — validated before any dispatch. */
export const DeskBridgeToolCall = z.object({
  name: z.string().min(1).max(WIRE_LIMITS.deskBridgeToolName),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** A bridge-emitted JSON-RPC error object: the numeric JSON-RPC code stays
 *  for wire compatibility while the typed SLP desk code rides in
 *  `data.slpCode` — adapters never smuggle the vocabulary through free-form
 *  message text. Emitted errors parse against this before they are sent. */
export const DeskBridgeFrameError = z.object({
  code: z.number().int(),
  message: z.string().min(1).max(WIRE_LIMITS.rejectionMessage),
  data: z.object({
    slpCode: DeskErrorCode,
  }).strict(),
}).strict();

/** One catalog row — `visible:false` entries exist to prove the mechanism
 *  (a direct dispatch is still rejected by a typed code), never as usable
 *  tools. The adapter owns the input schema and the run implementation. */
export const DeskBridgeToolEntry = z.object({
  name: z.string().min(1).max(WIRE_LIMITS.deskBridgeToolName),
  visible: z.boolean(),
  mutation: z.boolean(),
  description: z.string().min(1).max(WIRE_LIMITS.deskBridgeToolDescription),
}).strict();

// ---------------------------------------------------------------------------
// Desk mutation tools (P3-a) — strict input schemas for the bridge catalog.
// Actor identity is never an input field: the server derives it from the
// bound membership. `requestId` is the seat-chosen idempotency key part.
// ---------------------------------------------------------------------------

const DeskRequestId = z.string().min(1).max(WIRE_LIMITS.deskRequestId);
const DeskEntityId = z.string().min(1).max(WIRE_LIMITS.deskEntityId);
const DeskRecordJson = z.record(z.string(), z.unknown());

/** slp_handback_submit — a bound seat's claimed report record. `recordV1`
 *  is the JSON record object itself (never prose or a fenced block);
 *  `candidateId` names a durable candidate row of the same assignment or
 *  is null for a report-only handback. */
export const DeskHandbackSubmitInput = z.object({
  requestId: DeskRequestId,
  assignmentId: DeskEntityId,
  recordV1: DeskRecordJson,
  candidateId: DeskEntityId.nullable(),
}).strict();

/** slp_assignment_register — lead-only: create a durable assignment
 *  binding. `authorityRef` is a verbatim pointer to the grant, stored and
 *  never dereferenced. `objective` is optional descriptive text. */
export const DeskAssignmentRegisterInput = z.object({
  requestId: DeskRequestId,
  authorityRef: z.string().min(1).max(WIRE_LIMITS.deskAuthorityRef),
  objective: z.string().min(1).max(WIRE_LIMITS.deskObjective).nullable(),
}).strict();

/** slp_assignment_attach — lead owner binds a live seat to an open
 *  assignment; idempotent on an already-bound seat. */
export const DeskAssignmentAttachInput = z.object({
  requestId: DeskRequestId,
  assignmentId: DeskEntityId,
  agentId: z.string().min(1).max(WIRE_LIMITS.agentId),
}).strict();

/** slp_assignment_close — lead owner closes an assignment; submissions
 *  against a closed assignment reject. */
export const DeskAssignmentCloseInput = z.object({
  requestId: DeskRequestId,
  assignmentId: DeskEntityId,
}).strict();

/** The mutation response shapes the tools answer. `revision` is the
 *  handback revision (submit) — 0 when the tool's outcome has no revision
 *  stream. Rejections keep the shared DeskRejection shape. */
export const DeskHandbackSubmitResult = z.object({
  ok: z.literal(true),
  revision: z.number().int().min(1),
  receiptId: z.string().min(1).max(WIRE_LIMITS.deskEntityId),
  gaps: z.array(z.string().min(1).max(WIRE_LIMITS.gapLen)).max(WIRE_LIMITS.deskStatusGaps),
  handbackId: DeskEntityId,
  observedCandidateId: DeskEntityId.nullable(),
}).strict();

export const DeskAssignmentResult = z.object({
  ok: z.literal(true),
  receiptId: z.string().min(1).max(WIRE_LIMITS.deskEntityId),
  assignmentId: DeskEntityId,
  state: z.enum(["open", "closed"]),
  seat: z
    .object({
      agentId: z.string().min(1).max(WIRE_LIMITS.agentId),
      membershipId: z.string().min(1).max(WIRE_LIMITS.membershipId),
    })
    .strict()
    .optional(),
}).strict();

export type DeskHandbackSubmitInputValue = z.infer<typeof DeskHandbackSubmitInput>;
export type DeskAssignmentRegisterInputValue = z.infer<typeof DeskAssignmentRegisterInput>;
export type DeskAssignmentAttachInputValue = z.infer<typeof DeskAssignmentAttachInput>;
export type DeskAssignmentCloseInputValue = z.infer<typeof DeskAssignmentCloseInput>;
export type DeskHandbackSubmitResultValue = z.infer<typeof DeskHandbackSubmitResult>;
export type DeskAssignmentResultValue = z.infer<typeof DeskAssignmentResult>;

// ---------------------------------------------------------------------------
// Desk settlement tools (P3-b) — the durable settlement mirror. The desk is
// evidence storage, not the official sink: `slp_settlement_record` commits an
// immutable owner attestation revision; `slp_settlement_export` re-derives the
// v1 `slp-record` (kind "settlement") so the receiving owner can place it in
// an authorized sink itself. Actor identity stays server-derived; every
// pointer field is claimed provenance the desk stores verbatim and never
// dereferences.
// ---------------------------------------------------------------------------

/** The closed resource-disposition vocabulary a settlement records — the
 *  shared module owns it so the durable SettlementSchema and the wire
 *  input can never drift apart. `unknown` is the honest disposition for a
 *  resource whose fate the owner cannot attest; it never becomes
 *  `released` by omission. */
export const SETTLEMENT_RESOURCE_DISPOSITIONS = ["released", "retained", "unknown"] as const;

/** The closed settlement-status vocabulary — `completed` is reachable only
 *  through the decide's prerequisite check; it is never inferred from
 *  assignment state, idle signals or an accepted handback. */
export const SettlementStatus = z.enum(["completed", "partial", "blocked"]);
export type SettlementStatusValue = z.infer<typeof SettlementStatus>;

const DeskSettlementPointer = z.string().min(1).max(WIRE_LIMITS.deskSettlementPointer);

/** The transcript-export pointer a settlement timeline may carry — the
 *  v1 record's repository-relative export triple (path/sha256/bytes). */
export const DeskSettlementExport = z.object({
  path: z.string().min(1).max(WIRE_LIMITS.deskExportPath),
  sha256: Sha,
  bytes: z.number().int().min(0),
}).strict();

/** The settlement timeline block. `via` rides the wire as a bounded string:
 *  the closed SETTLEMENT_VIA vocabulary lives in desk-records.ts, which is
 *  server-internal — shared code cannot import it, so the decide enforces
 *  the enum (the same split as recordV1: wire validates shape, decide
 *  validates semantics). */
export const DeskSettlementTimeline = z.object({
  nativeHandle: z.string().min(1).max(WIRE_LIMITS.deskTimelineField).nullable(),
  sessionId: z.string().min(1).max(WIRE_LIMITS.deskTimelineField).nullable(),
  via: z.string().min(1).max(WIRE_LIMITS.capabilityId),
  export: DeskSettlementExport.nullable(),
  gap: z.string().min(1).max(WIRE_LIMITS.gapLen).nullable(),
}).strict();

export const DeskSettlementResource = z.object({
  ref: DeskSettlementPointer,
  disposition: z.enum(SETTLEMENT_RESOURCE_DISPOSITIONS),
}).strict();

/** slp_settlement_record — the receiving owner's settlement attestation.
 *  `seatAgentId` names the seat whose report this settles; `seatTitle` and
 *  `at` are owner-claimed export fields (who/what-when is the attestation,
 *  identity is server-derived). `deliveryRef`/`reworkClosureRef`/`sinkRef`
 *  carry the exact evidence pointers the owner attests; `decisionRef` is an
 *  external reference (P4 machinery does not exist — it is claimed, never
 *  resolved). `handbackRefs`/`candidateRefs` name durable rows of THIS
 *  assignment and THIS seat. */
export const DeskSettlementRecordInput = z.object({
  requestId: DeskRequestId,
  assignmentId: DeskEntityId,
  seatAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
  seatTitle: z.string().min(1).max(WIRE_LIMITS.deskSettlementTitle),
  at: z.string().min(1).max(64),
  deliveryRef: DeskSettlementPointer.nullable(),
  reworkClosureRef: DeskSettlementPointer.nullable(),
  sinkRef: DeskSettlementPointer.nullable(),
  decisionRef: DeskSettlementPointer.nullable(),
  handbackRefs: z.array(DeskEntityId).max(WIRE_LIMITS.deskSettlementRefs),
  candidateRefs: z.array(DeskEntityId).max(WIRE_LIMITS.deskSettlementRefs),
  resources: z.array(DeskSettlementResource).max(WIRE_LIMITS.deskSettlementResources),
  timeline: DeskSettlementTimeline,
}).strict();

/** slp_settlement_export — re-emit the derived v1 record of a committed
 *  settlement revision; read-only, scoped to the owner or the settled
 *  seat. */
export const DeskSettlementExportInput = z.object({
  settlementId: DeskEntityId,
}).strict();

/** The emitted v1 settlement record — identical to the fields the durable
 *  row was committed under (the decide validated it against report-records
 *  v1 semantics before the commit landed). */
export const DeskSettlementRecordV1 = z.object({
  version: z.literal(1),
  kind: z.literal("settlement"),
  task: DeskSettlementPointer.nullable(),
  seat: z.object({
    provider: z.string().min(1).max(WIRE_LIMITS.providerLen),
    title: z.string().min(1).max(WIRE_LIMITS.deskSettlementTitle),
    agentId: z.string().min(1).max(WIRE_LIMITS.agentId).nullable(),
  }).strict(),
  timeline: DeskSettlementTimeline,
  recordedBy: z.string().min(1).max(WIRE_LIMITS.agentId),
  at: z.string().min(1).max(64),
}).strict();

/** The durable verdict of the server-side transcript-export artifact seam
 *  (P3-b R1): a claimed `timeline.export` pointer must prove existence and
 *  content under the desk's bound repository root before it can ground
 *  `completed`. `verified` = the artifact matched; `unavailable` = the
 *  seam could not prove it — the claim stays recorded as claimed-only and
 *  the revision can never read completed. Disproven claims never persist:
 *  decide rejects them before a row is committed. `null` when no export
 *  was claimed. */
export const DeskSettlementExportVerification = z
  .object({
    status: z.enum(["verified", "unavailable"]),
    detail: z.string().min(1).max(WIRE_LIMITS.gapLen).nullable(),
  })
  .strict()
  .nullable();

export const DeskSettlementRecordResult = z.object({
  ok: z.literal(true),
  settlementId: DeskEntityId,
  revision: z.number().int().min(1),
  receiptId: z.string().min(1).max(WIRE_LIMITS.deskEntityId),
  status: SettlementStatus,
  gaps: z.array(z.string().min(1).max(WIRE_LIMITS.gapLen)).max(WIRE_LIMITS.deskStatusGaps),
  exportVerification: DeskSettlementExportVerification,
}).strict();

export const DeskSettlementExportResult = z.object({
  ok: z.literal(true),
  settlementId: DeskEntityId,
  assignmentId: DeskEntityId,
  seatAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
  revision: z.number().int().min(1),
  status: SettlementStatus,
  gaps: z.array(z.string().min(1).max(WIRE_LIMITS.gapLen)).max(WIRE_LIMITS.deskStatusGaps),
  record: DeskSettlementRecordV1,
  exportVerification: DeskSettlementExportVerification,
}).strict();

export type DeskSettlementRecordInputValue = z.infer<typeof DeskSettlementRecordInput>;
export type DeskSettlementExportInputValue = z.infer<typeof DeskSettlementExportInput>;
export type DeskSettlementRecordResultValue = z.infer<typeof DeskSettlementRecordResult>;
export type DeskSettlementExportResultValue = z.infer<typeof DeskSettlementExportResult>;

// ---------------------------------------------------------------------------
// Desk scope/review machinery (P4) — durable scope ownership and the
// required-review transition gate. A scope declaration is durable assignment
// data bound to (assignmentId, scopeId, ownerAgentId, assignmentRevision),
// created only by the assignment's receiving owner/lead; its representation
// is an opaque scopeId plus a bounded label/digest/refs — never a filesystem
// path set, never filesystem authority. Three durable tables carry the
// semantics: declaration revisions (immutable, explicit lineage), review
// observations (seat/axis/candidate-bound) and the append-only transition
// stream. Claimed refs stay provenance — they never discharge a required
// review axis.
// ---------------------------------------------------------------------------

/** The closed scope state vocabulary (contract P4 R2 §P4). `closed` is a
 *  terminal desk state, never an acceptance: acceptance is a review
 *  disposition, not a transition outcome. */
export const SCOPE_STATES = [
  "declared",
  "claimed",
  "submitted-for-review",
  "review-observed",
  "approved",
  "rejected",
  "advanced",
  "closed",
] as const;
export type ScopeStateValue = (typeof SCOPE_STATES)[number];
export const ScopeState = z.enum(SCOPE_STATES);

/** The transition commands the owner may issue (the wire enum). `declare`
 *  is not a transition command: a declaration revision is created by
 *  slp_scope_declare, which also opens the stream with the (none →
 *  declared) edge. Amendments append declaration revisions, never
 *  transitions. */
export const SCOPE_COMMANDS = [
  "claim",
  "submit-for-review",
  "review-observed",
  "approve",
  "reject",
  "advance",
  "close",
] as const;
export type ScopeCommandValue = (typeof SCOPE_COMMANDS)[number];
export const ScopeCommand = z.enum(SCOPE_COMMANDS);

/** The closed review-axis vocabulary — the protocol's required Spec +
 *  Standards split. Required axes are SERVER-derived (transition type +
 *  the bound declaration): no caller field may shrink the gate. */
export const SCOPE_REVIEW_AXES = ["spec", "standards"] as const;
export type ScopeReviewAxisValue = (typeof SCOPE_REVIEW_AXES)[number];
export const ScopeReviewAxis = z.enum(SCOPE_REVIEW_AXES);

/** A review observation's verdict. A verdict never mutates scope state by
 *  itself — only an owner transition command moves the machine. */
export const SCOPE_REVIEW_VERDICTS = ["approve", "reject", "findings"] as const;
export type ScopeReviewVerdictValue = (typeof SCOPE_REVIEW_VERDICTS)[number];
export const ScopeReviewVerdict = z.enum(SCOPE_REVIEW_VERDICTS);

/** The explicit state-machine table — the single legality authority shared
 *  by the decide and the store refinement so no silent edge can exist.
 *  `close` exists only on states that carry a review round — closing before
 *  a round exists is not an edge at all (early close typed-rejects, never
 *  commits; B4). A resubmit edge lets the owner pin a fresh candidate for
 *  the next round from submitted-for-review, rejected or advanced. */
export const SCOPE_TRANSITIONS = [
  { from: "declared", command: "claim", to: "claimed" },
  { from: "claimed", command: "submit-for-review", to: "submitted-for-review" },
  { from: "submitted-for-review", command: "submit-for-review", to: "submitted-for-review" },
  { from: "submitted-for-review", command: "review-observed", to: "review-observed" },
  { from: "submitted-for-review", command: "reject", to: "rejected" },
  { from: "submitted-for-review", command: "close", to: "closed" },
  { from: "review-observed", command: "approve", to: "approved" },
  { from: "review-observed", command: "reject", to: "rejected" },
  { from: "approved", command: "advance", to: "advanced" },
  { from: "approved", command: "close", to: "closed" },
  { from: "rejected", command: "advance", to: "advanced" },
  { from: "rejected", command: "submit-for-review", to: "submitted-for-review" },
  { from: "rejected", command: "close", to: "closed" },
  { from: "advanced", command: "submit-for-review", to: "submitted-for-review" },
] as const satisfies readonly { from: ScopeStateValue; command: ScopeCommandValue; to: ScopeStateValue }[];

export type ScopeTransitionEdge = (typeof SCOPE_TRANSITIONS)[number];

/** The review-required transition commands (contract B4): these may commit
 *  only while a candidate round is active and every required axis carries a
 *  durable observation bound exactly to the round's (scopeRevision,
 *  candidateSnapshot). `close`/`advance` are gated by B4 verbatim — an
 *  early `close` is not even an edge: closing before a round exists typed-
 *  rejects with no durable commit. `review-observed` is itself the gate
 *  transition; `approve` needs no separate gate — it is only reachable
 *  through a committed review-observed, which already discharged every
 *  axis of the round. */
export const SCOPE_REVIEW_GATED_COMMANDS = ["review-observed", "advance", "close"] as const;
export type ScopeReviewGatedCommand = (typeof SCOPE_REVIEW_GATED_COMMANDS)[number];

/** Legality lookup — one seam. Returns the edge or undefined. */
export function scopeTransitionEdge(
  from: ScopeStateValue,
  command: ScopeCommandValue,
): ScopeTransitionEdge | undefined {
  return SCOPE_TRANSITIONS.find(edge => edge.from === from && edge.command === command);
}

const DeskScopePointer = z.string().min(1).max(WIRE_LIMITS.deskScopePointer);

/** slp_scope_declare — the receiving owner/lead's scope declaration (P4).
 *  `scopeId` is the opaque caller-chosen scope name inside the assignment;
 *  redeclaring the same scopeId appends a new immutable declaration
 *  revision with server-derived lineage — declarations are never edited in
 *  place. `declarationSha256` attests the declaration body the caller
 *  holds; `refs` are claimed provenance pointers only. `seatAgentId` binds
 *  the scope to one attached seat of the assignment, or null for a
 *  scope owned by no particular seat. */
export const DeskScopeDeclareInput = z.object({
  requestId: DeskRequestId,
  assignmentId: DeskEntityId,
  scopeId: DeskEntityId,
  label: z.string().min(1).max(WIRE_LIMITS.deskScopeLabel),
  declarationSha256: Sha,
  refs: z.array(DeskScopePointer).max(WIRE_LIMITS.deskScopeRefs),
  seatAgentId: z.string().min(1).max(WIRE_LIMITS.agentId).nullable(),
}).strict();

/** slp_scope_transition — owner-only state-machine move. `scopeRevision`
 *  is the caller-pinned declaration revision the transition operates under;
 *  it must equal the scope's latest declaration revision (a superseded pin
 *  is REVISION_CONFLICT, not a silent rebind). `candidateSnapshot`
 *  (+ optional `candidateHead`) is carried only by submit-for-review — it
 *  pins the review round and must resolve to a durable observed candidate
 *  of this assignment. */
export const DeskScopeTransitionInput = z.object({
  requestId: DeskRequestId,
  assignmentId: DeskEntityId,
  scopeId: DeskEntityId,
  transition: ScopeCommand,
  scopeRevision: z.number().int().min(1),
  candidateSnapshot: Sha.nullable(),
  candidateHead: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).nullable(),
}).strict();

/** slp_scope_review — a bound reviewer seat's observation. The review must
 *  hit the active round's exact pin: `scopeRevision`/`candidateSnapshot`
 *  that differ from the round pin are REVISION_CONFLICT / CANDIDATE_DRIFT,
 *  never a quiet rebind. `findingsRef` is claimed provenance only. */
export const DeskScopeReviewInput = z.object({
  requestId: DeskRequestId,
  assignmentId: DeskEntityId,
  scopeId: DeskEntityId,
  scopeRevision: z.number().int().min(1),
  candidateSnapshot: Sha,
  axis: ScopeReviewAxis,
  verdict: ScopeReviewVerdict,
  findingsRef: DeskScopePointer.nullable(),
}).strict();

/** The (axis, reviewId) discharge a gated transition committed with — the
 *  durable evidence of which observation satisfied which required axis. */
export const DeskScopeDischarge = z.object({
  axis: ScopeReviewAxis,
  reviewId: DeskEntityId,
}).strict();

export const DeskScopeDeclareResult = z.object({
  ok: z.literal(true),
  scopeId: DeskEntityId,
  revision: z.number().int().min(1),
  receiptId: z.string().min(1).max(WIRE_LIMITS.deskEntityId),
}).strict();

export const DeskScopeTransitionResult = z.object({
  ok: z.literal(true),
  transitionId: DeskEntityId,
  scopeId: DeskEntityId,
  revision: z.number().int().min(1),
  state: ScopeState,
  receiptId: z.string().min(1).max(WIRE_LIMITS.deskEntityId),
  discharged: z.array(DeskScopeDischarge).max(SCOPE_REVIEW_AXES.length),
}).strict();

export const DeskScopeReviewResult = z.object({
  ok: z.literal(true),
  reviewId: DeskEntityId,
  scopeId: DeskEntityId,
  axis: ScopeReviewAxis,
  revision: z.number().int().min(1),
  receiptId: z.string().min(1).max(WIRE_LIMITS.deskEntityId),
}).strict();

export type DeskScopeDeclareInputValue = z.infer<typeof DeskScopeDeclareInput>;
export type DeskScopeTransitionInputValue = z.infer<typeof DeskScopeTransitionInput>;
export type DeskScopeReviewInputValue = z.infer<typeof DeskScopeReviewInput>;
export type DeskScopeDeclareResultValue = z.infer<typeof DeskScopeDeclareResult>;
export type DeskScopeTransitionResultValue = z.infer<typeof DeskScopeTransitionResult>;
export type DeskScopeReviewResultValue = z.infer<typeof DeskScopeReviewResult>;

/** One review revision as projected into slp_status — identifiers, axis
 *  and verdict only; the claimed findingsRef stays in the ledger. */
export const DeskStatusScopeReview = z.object({
  reviewId: DeskEntityId,
  axis: ScopeReviewAxis,
  verdict: ScopeReviewVerdict,
  scopeRevision: z.number().int().min(1),
  reviewerAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
  revision: z.number().int().min(1),
}).strict();

/** One scope as projected into slp_status (P4) — the declaration identity,
 *  the derived machine state and the active review round's pin plus its
 *  required/discharged axes. Claimed refs and the findingsRef stay in the
 *  ledger — a status view never re-serves claimed provenance. */
export const DeskStatusScope = z.object({
  scopeId: DeskEntityId,
  revision: z.number().int().min(1),
  label: z.string().min(1).max(WIRE_LIMITS.deskScopeLabel),
  declarationSha256: Sha,
  seatAgentId: z.string().min(1).max(WIRE_LIMITS.agentId).nullable(),
  state: ScopeState,
  /** The active review round's pin — null when no submit-for-review round
   *  is open (declared/claimed) or after it resolved. Reviewers read this
   *  pin to bind their observation. */
  activeScopeRevision: z.number().int().min(1).nullable(),
  activeCandidateSnapshot: Sha.nullable(),
  requiredAxes: z.array(ScopeReviewAxis).max(SCOPE_REVIEW_AXES.length),
  dischargedAxes: z.array(ScopeReviewAxis).max(SCOPE_REVIEW_AXES.length),
  transitionCount: z.number().int().min(0),
  reviews: z.array(DeskStatusScopeReview).max(WIRE_LIMITS.deskStatusScopeReviews),
}).strict();

/** One handback revision as projected into slp_status — identifiers and
 *  counts only; the claimed record's bytes stay in the ledger (a status
 *  view never re-serves record payloads). */
export const DeskStatusHandback = z.object({
  handbackId: DeskEntityId,
  agentId: z.string().min(1).max(WIRE_LIMITS.agentId),
  revision: z.number().int().min(1),
  recordSha256: Sha,
  claimedCandidateId: DeskEntityId.nullable(),
  observedStatus: z.enum(["pending", "ok", "failed"]),
  observedCandidateId: DeskEntityId.nullable(),
  gapsCount: z.number().int().min(0),
}).strict();

/** One settlement revision as projected into slp_status (P3-b) —
 *  identifiers and counts only, same rule as DeskStatusHandback: the
 *  mirror row's pointers stay in the ledger, never re-served in a view. */
export const DeskStatusSettlement = z.object({
  settlementId: DeskEntityId,
  seatAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
  revision: z.number().int().min(1),
  status: SettlementStatus,
  gapsCount: z.number().int().min(0),
  /** Whether the row's claimed transcript export verified under the bound
   *  repository root at commit time — false when no export was claimed or
   *  the seam could not prove it. */
  exportVerified: z.boolean(),
}).strict();

/** One assignment as projected into slp_status — caller-scoped: a lead's
 *  owned assignments carry every handback; a bound seat sees only its own
 *  rows on assignments it is attached to. `settlements` follows the same
 *  scoping: the owner sees every settlement on an owned assignment; a seat
 *  sees only the rows that settle its own seat. */
export const DeskStatusAssignment = z.object({
  assignmentId: DeskEntityId,
  state: z.enum(["open", "closed"]),
  ownerAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
  seats: z.array(z.string().min(1).max(WIRE_LIMITS.agentId)).max(WIRE_LIMITS.deskStatusSeats),
  handbacks: z.array(DeskStatusHandback).max(WIRE_LIMITS.deskStatusHandbacks),
  settlements: z.array(DeskStatusSettlement).max(WIRE_LIMITS.deskStatusSettlements),
  /** P4 — the caller-scoped scope projection: the owner sees every scope
   *  on an owned assignment; a bound seat sees scopes on assignments it is
   *  attached to (any attached seat is a potential bound reviewer). */
  scopes: z.array(DeskStatusScope).max(WIRE_LIMITS.deskStatusScopes),
}).strict();

/** The seat-facing status view slp_status answers — the caller's own
 *  membership row plus desk availability; same `acceptance` guard literal
 *  as every other read view. */
export const DeskSeatStatus = z.object({
  schemaVersion: z.literal(1),
  generatedAt: Time,
  seat: z.object({
    membershipId: z.string().min(1).max(WIRE_LIMITS.membershipId),
    agentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    state: SeatBindingState,
    family: Family,
    role: z.string().min(1).max(WIRE_LIMITS.roleLen),
    provider: z.string().min(1).max(WIRE_LIMITS.providerLen),
    workspaceId: z.string().min(1).max(WIRE_LIMITS.workspaceIdLen).nullable(),
    createCwd: z.string().min(1).max(WIRE_LIMITS.createCwdLen),
    openGeneration: z.number().int().nonnegative(),
    createdAt: Time,
    hostConfirmedAt: Time.nullable(),
    registeredAt: Time.nullable(),
  }).strict(),
  desk: z.object({
    /** The repo ledger the bound seat lives under. */
    repoKey: Sha,
    state: z.enum(["available", "recovery-required", "degraded"]),
    protocol: z.literal(DESK_BRIDGE_PROTOCOL),
  }).strict(),
  /** P3-a — the caller-scoped assignment/handback projection. A lead sees
   *  its owned assignments with every handback; any other bound seat sees
   *  only its own rows on assignments it is attached to. */
  assignments: z.array(DeskStatusAssignment).max(WIRE_LIMITS.deskStatusAssignments),
  limitations: z.array(z.string().min(1).max(WIRE_LIMITS.limitationLen)).max(WIRE_LIMITS.deskBridgeLimitations),
  acceptance: z.literal("not-established-by-this-view"),
}).strict();

export type DeskBridgeHelloValue = z.infer<typeof DeskBridgeHello>;
export type DeskBridgeAckValue = z.infer<typeof DeskBridgeAck>;
export type DeskBridgeToolCallValue = z.infer<typeof DeskBridgeToolCall>;
export type DeskBridgeToolEntryValue = z.infer<typeof DeskBridgeToolEntry>;
export type DeskSeatStatusValue = z.infer<typeof DeskSeatStatus>;

// ---------------------------------------------------------------------------
// enforcement-status RPC — read-only desk status. It mutates nothing, assigns
// no authority, and carries no review verdicts or other axes' contents.
// ---------------------------------------------------------------------------

/** The enforcement caller-supplied target — narrower than the manager's
 *  `Target` (whose daemonHome cap stays 4096): both fields pin at
 *  WIRE_LIMITS.targetHostId/targetDaemonHome characters, daemonHome still
 *  an absolute path. */
export const EnforcementTarget = z.object({
  hostId: z.string().min(1).max(WIRE_LIMITS.targetHostId),
  daemonHome: z.string().min(1).max(WIRE_LIMITS.targetDaemonHome).refine(isAbsolutePath),
}).strict();

export const GetEnforcementStatusInput = z.object({
  schemaVersion: z.literal(1),
  target: EnforcementTarget,
}).strict();

/** One structured omission record — nothing leaves the view silently.
 *  §2.1b: `detail` is always null on the P0 wire; provider ids and error
 *  text stay diagnostic input for the producer, never wire data. */
export const CompletenessEntry = z.object({
  collection: CompletenessCollection,
  reason: CompletenessReason,
  /** How many rows/fields were omitted — always >= 1 when present. */
  count: z.number().int().min(1).max(WIRE_LIMITS.completenessCount),
  detail: z.null(),
}).strict();

/** The canonical ledger array: at most one entry per (collection, reason)
 *  pair, bounded by the enum product. A duplicate key is producer-invalid. */
export const CompletenessEntriesSchema = z.array(CompletenessEntry)
  .max(WIRE_LIMITS.completenessEntries)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.collection}\0${entry.reason}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: `duplicate completeness key ${key}` });
      }
      seen.add(key);
    }
  });

export const GetEnforcementStatusOutput = z.object({
  schemaVersion: z.literal(1),
  target: EnforcementTarget,
  generatedAt: Time,
  /** Install receipt projection: null when the target is unverified or the
   *  receipt is absent; `error` carries a bounded typed conflict code, never
   *  raw file content, so a corrupt receipt surfaces instead of passing as
   *  clean. */
  installation: z.object({
    state: z.string().min(1).max(WIRE_LIMITS.installationState).nullable(),
    revision: z.number().int().nonnegative().nullable(),
    bound: z.boolean(),
    error: z.string().min(1).max(WIRE_LIMITS.installationError).nullable(),
  }).strict().nullable(),
  capabilities: z.array(CapabilityRecord).max(WIRE_LIMITS.capabilities),
  gaps: z.array(CapabilityGap).max(WIRE_LIMITS.gaps),
  /** Desk-issued seat bindings — P2-e projects membership rows that carry
   *  an agentId from the verified served home's repo ledgers; an
   *  unverified home withholds the collection with source-incomplete. */
  bindings: z.array(SeatBindingView).max(WIRE_LIMITS.bindings),
  limitations: z.array(z.string().min(1).max(WIRE_LIMITS.limitationLen)).max(WIRE_LIMITS.limitations),
  /** Structured omission/completeness report — every producer elision,
   *  source-incomplete notice and aggregate shed is recorded here; nothing
   *  is dropped silently. Empty means the emitted view carried everything
   *  the producer observed. */
  completeness: CompletenessEntriesSchema,
  /** Hard literal: a read view is not an acceptance verdict, ever. */
  acceptance: z.literal("not-established-by-this-view"),
}).strict();

export const enforcementStatus = defineRpc({
  name: "enforcement-status",
  input: GetEnforcementStatusInput,
  output: GetEnforcementStatusOutput,
});

// ---------------------------------------------------------------------------
// enforcement-recover-lock RPC (P2-e) — operator recovery of an orphan desk
// repo lock. Unlink happens only when the lock reads, its pid is a positive
// integer, kill(pid, 0) throws ESRCH, the bytes are unchanged, and the
// pre-unlink audit line is durable. No force mode, no `expected` field: the
// schema below is the only input. The provenance gate (exported PASEO_HOME +
// realpath match) runs before the algorithm.
// ---------------------------------------------------------------------------

/** The closed recovery-result vocabulary — exactly 17 values (P2-e §3.2–3.3).
 *  Precedence group E adds none: it keeps the original result and only swaps
 *  the envelope + recoverLockReleased. Tests enumerate this enum. */
export const DeskRecoveryResult = z.enum([
  "home-unverified",
  "target-mismatch",
  "actor-invalid",
  "unsafe",
  "recover-lock-io",
  "busy",
  "recover-lock-orphan",
  "no-lock",
  "unreadable",
  "held",
  "undetermined",
  "changed",
  "audit-failed",
  "unlink-failed",
  "unlink-unsynced",
  "recovered",
  "internal-error",
]);

export type DeskRecoveryResultValue = z.infer<typeof DeskRecoveryResult>;

export const RecoverLockInput = z.object({
  schemaVersion: z.literal(1),
  target: EnforcementTarget,
  repo: z.union([
    z.object({
      gitCommonDir: z.string().min(1).max(WIRE_LIMITS.targetDaemonHome).refine(isAbsolutePath),
    }).strict(),
    // E-P2D-3 — the explicit sentinel descriptor: the P2-d desk-bridge
    // lifecycle lock lives under the reserved DESK_BRIDGE_REPO namespace;
    // only this literal reaches it — a caller-supplied repoKey is never
    // accepted, and real-repo derivation is untouched.
    z.object({
      sentinel: z.literal("desk-bridge"),
    }).strict(),
  ]),
}).strict();

/** The recovery receipt — returned on every outcome, ok or rejection, with
 *  keys in exactly this order. `recoverLockReleased` is null when the
 *  recoverer never held the recover.lock (precedence groups A and B). */
export const DeskRecoveryReceipt = z.object({
  schemaVersion: z.literal(1),
  repoKey: Sha,
  /** The attempted actor key, verbatim — an actor-invalid receipt records
   *  the rejected key raw (never truncated, never invented), so no wire cap
   *  applies here; the acceptance cap lives in the A3 check. */
  actorKey: z.string(),
  at: Time,
  result: DeskRecoveryResult,
  pid: z.number().int().min(1).nullable(),
  instanceNonce: z.string().min(1).max(WIRE_LIMITS.recoverNonce).nullable(),
  auditAppended: z.boolean(),
  recoverLockReleased: z.boolean().nullable(),
}).strict();

/** One output shape per outcome (P2-e §3.4): success carries only
 *  `{ ok: true, receipt }`; rejection adds `code`, `message`, `recovery`.
 *  `recovery` is null on CAPABILITY_GAP results and always present on
 *  RECOVERY_REQUIRED ones (it carries the bounded file pointer). */
export const RecoverLockOutput = z.union([
  z.object({
    ok: z.literal(true),
    receipt: DeskRecoveryReceipt,
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: DeskErrorCode,
    message: z.string().min(1).max(WIRE_LIMITS.rejectionMessage),
    recovery: z.string().min(1).max(WIRE_LIMITS.rejectionRecovery).nullable(),
    receipt: DeskRecoveryReceipt,
  }).strict(),
]);

export const enforcementRecoverLock = defineRpc({
  name: "enforcement-recover-lock",
  input: RecoverLockInput,
  output: RecoverLockOutput,
});

export type RecoverLockOutputValue = z.infer<typeof RecoverLockOutput>;

// enforcement-runtime-pin RPC (P2-b) — read-only RuntimePin of the active
// receipt binding. The pin is the P0 §5 measurement/runtime pin: the seat and
// engine pins are separate pins under later slices. The producer's closed
// predicate decides between exactly two shapes on the wire — `bound` with a
// pin and its canonical digest, or `not-bound` with one closed reason; every
// predicate fault surfaces as a thrown OperationConflict, never a row.
// ---------------------------------------------------------------------------

/** Why no pin was emitted. Closed vocabulary — first-failure order is the
 *  predicate's sequential check order, not this declaration order. */
export const RuntimePinReason = z.enum([
  /** No exported PASEO_HOME: the served home is unverified as this daemon's. */
  "unverified-home",
  /** The caller's target is not the verified served home, or the receipt's
   *  recorded target is not the caller's (deliberate not-bound, matching the
   *  P0 readView TARGET_MISMATCH degrade). */
  "target-mismatch",
  /** No receipt exists under the verified home's stable root. */
  "no-receipt",
  /** The receipt exists but is not ACTIVE. */
  "state-not-active",
  /** An operation intent is pending or one is recorded active. */
  "operation-pending",
  /** The ACTIVE receipt carries no binding. */
  "no-binding",
]);

/** The wire pin: digest fields are canonicalSha256 values computed by the
 *  server producer (config-view.ts — the only canonicalizer); `binaries` and
 *  `owned` enter as digests, never verbatim, so the pin stays small and
 *  client-safe. `bridgeSha256`/`bridgeProtocolVersion` are always null at
 *  P2-b — a later slice amends the literals when bridge values land. */
export const RuntimePin = z.object({
  schemaVersion: z.literal(1),
  /** Literal: a pin exists only while the receipt reads ACTIVE. */
  state: z.literal("ACTIVE"),
  candidateSha256: Sha,
  payloadSha256: Sha,
  launchSetSha256: Sha,
  launchManifestSha256: Sha,
  bindingSha256: Sha,
  /** canonicalSha256(receipt.binding.owned) — the P0 §5 "policy bundle". */
  policyBundleSha256: Sha,
  /** canonicalSha256(receipt.binding.binaries) — per-family resolution. */
  binariesSha256: Sha,
  node: z.object({
    path: z.string().min(1).max(WIRE_LIMITS.runtimePinPath).refine(isAbsolutePath),
    version: z.string().min(1).max(WIRE_LIMITS.runtimePinNodeVersion),
  }).strict(),
  bridgeSha256: z.null(),
  bridgeProtocolVersion: z.null(),
  /** Canonical target — daemonHome is the realpath'd served home. */
  target: EnforcementTarget,
  receiptRevision: z.number().int().nonnegative(),
  snapshotAlgorithmVersion: z.literal("slp-snapshot/package.mjs"),
  recordContractVersion: z.literal(1),
}).strict();

/** Same input shape as enforcement-status (P0): the caller-supplied target. */
export const GetRuntimePinInput = GetEnforcementStatusInput;

export const GetRuntimePinOutput = z.object({
  schemaVersion: z.literal(1),
  target: EnforcementTarget,
  generatedAt: Time,
  result: z.enum(["bound", "not-bound"]),
  reason: RuntimePinReason.nullable(),
  pin: RuntimePin.nullable(),
  pinSha256: Sha.nullable(),
  limitations: z.array(z.string().min(1).max(WIRE_LIMITS.runtimePinLimitationLen)).max(WIRE_LIMITS.runtimePinLimitations),
  /** Hard literal: a read view is not an acceptance verdict, ever. */
  acceptance: z.literal("not-established-by-this-view"),
}).strict().superRefine((output, ctx) => {
  // The wire-level coupling: bound carries a pin and its digest and no
  // reason; not-bound carries a reason and no pin material. The remaining
  // cross-constraint — pinSha256 === canonicalSha256(pin) — is enforced by
  // the server emit guard (boundRuntimePinView): this shared module stays
  // client-safe and cannot hash.
  if (output.result === "bound") {
    if (output.pin === null || output.pinSha256 === null || output.reason !== null) {
      ctx.addIssue({ code: "custom", message: "bound output must carry pin, pinSha256 and reason:null" });
    }
  } else if (output.pin !== null || output.pinSha256 !== null || output.reason === null) {
    ctx.addIssue({ code: "custom", message: "not-bound output must carry a reason and pin/pinSha256:null" });
  }
});

export const enforcementRuntimePin = defineRpc({
  name: "enforcement-runtime-pin",
  input: GetRuntimePinInput,
  output: GetRuntimePinOutput,
});

// ---------------------------------------------------------------------------
// Value types (z.infer — same idiom as contracts.ts)
// ---------------------------------------------------------------------------

export type CapabilityRecordValue = z.infer<typeof CapabilityRecord>;
export type CapabilityGapValue = z.infer<typeof CapabilityGap>;
export type SeatBindingViewValue = z.infer<typeof SeatBindingView>;
export type CompletenessCollectionValue = z.infer<typeof CompletenessCollection>;
export type CompletenessReasonValue = z.infer<typeof CompletenessReason>;
export type CompletenessEntryValue = z.infer<typeof CompletenessEntry>;
export type GetEnforcementStatusInputValue = z.infer<typeof GetEnforcementStatusInput>;
export type GetEnforcementStatusOutputValue = z.infer<typeof GetEnforcementStatusOutput>;
export type RuntimePinReasonValue = z.infer<typeof RuntimePinReason>;
export type RuntimePinValue = z.infer<typeof RuntimePin>;
export type GetRuntimePinInputValue = z.infer<typeof GetRuntimePinInput>;
export type GetRuntimePinOutputValue = z.infer<typeof GetRuntimePinOutput>;
