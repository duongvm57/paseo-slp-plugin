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
  /** Exact P0 inventory: 14 host-wide rows + 6 rows × 4 families. Growth
   *  without a pin raise is producer-invalid, never a row-limit shed. */
  capabilities: 38,
  /** Exact P0 inventory: the mandatory `providerTools-projection` row +
   *  4 probe gaps × 4 families. */
  gaps: 17,
  /** P0 emits `bindings: []` — a non-empty view is producer-invalid. */
  bindings: 0,
  // enforcement-runtime-pin (P2-b): pin field and limitation caps. The pin's
  // node.path pins at the manager's daemonHome cap, not the narrower
  // enforcement target cap.
  runtimePinPath: 4096,
  runtimePinNodeVersion: 64,
  runtimePinLimitations: 4,
  runtimePinLimitationLen: 160,
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
  /** Desk-issued seat bindings — P0 has none: always literal `[]`, never
   *  inferred from observed host agents. */
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
