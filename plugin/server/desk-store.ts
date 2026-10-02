import { REPO_KEY_ALGORITHM, REPO_KEY_PATTERN, DESK_BRIDGE_REPO, deskReposDir, deskRepoPaths, repoKeyFor } from "./runtime/desk-paths.ts";
export { REPO_KEY_ALGORITHM, REPO_KEY_PATTERN, DESK_BRIDGE_REPO, deskReposDir, deskRepoPaths, repoKeyFor } from "./runtime/desk-paths.ts";
// plugin/server/desk-store.ts — the durable desk store kernel (P2-a).
//
// One store per repoKey under <stableRoot>/state/enforcement/repos/<repoKey>/:
//   ledger.json        — the atomic document: header, repo binding, revision,
//                        bounded requests table (idempotency), last event tip
//   lock               — O_EXCL lockfile {pid, instanceNonce, startedAt};
//                        never stolen, never deleted for another instance
//   events/<f>-<l>.jsonl — immutable per-commit segments carrying the hash
//                        chain; the ledger.json rename is the commit point
//
// Invariants (contract §1):
//   - an acknowledged mutation is never lost: crash anywhere in the commit
//     protocol leaves either the old ledger or the committed one, plus at
//     most an orphan segment and an orphan lock (recovery is P2-e's);
//   - replay of (actorKey, assignmentId, requestId) with the same body
//     returns the recorded result verbatim; a different body is
//     IDEMPOTENCY_CONFLICT;
//   - the lockfile is never preempted: a live holder answers CAPABILITY_GAP,
//     a dead or unreadable holder answers RECOVERY_REQUIRED;
//   - a corrupt, schema-invalid, future-version, broken-chain or unsafe-path
//     ledger fails closed — only an ABSENT ledger is empty;
//   - decide is synchronous and pure; a thenable is a caller error, never a
//     commit.
//
// Only the journal's canonicalizer is used (canonicalSha256), receipt I/O is
// untouched, and the module writes nowhere outside <stableRoot>/state/
// enforcement/.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Family, OperationConflict, Sha, Time } from "../shared/contracts.ts";
import {
  CHECK_CLASSES,
  CHECK_RUN_STATUSES,
  DeskRejection,
  ROLLOUT_CHECK_GATED_COMMANDS,
  ROLLOUT_COHORT_GATED_COMMANDS,
  ROLLOUT_REVIEW_GATED_COMMANDS,
  ROLLOUT_COMMANDS,
  ROLLOUT_STATES,
  SCOPE_REVIEW_AXES,
  SCOPE_REVIEW_GATED_COMMANDS,
  SCOPE_STATES,
  SETTLEMENT_RESOURCE_DISPOSITIONS,
  WIRE_LIMITS,
  rolloutTransitionEdge,
  scopeTransitionEdge,
  type CheckRunStatusValue,
  type DeskRejectionValue,
  type ScopeStateValue,
} from "../shared/enforcement.ts";
import { SETTLEMENT_VIA } from "./desk-records.ts";
import { ROLES } from "../shared/runtime/families.ts";
import { canonicalJson, canonicalSha256, sha256Hex } from "./config-view.ts";
import { classifyLockHolderProcess, parseLockHolder, type LockHolder } from "./runtime/lock-holder.ts";
import {
  ensurePrivateDirectory,
  fsyncDirectory,
  lstatOrNull,
  PRIVATE_FILE_MODE,
} from "./kept-files.ts";

// ---------------------------------------------------------------------------
// Limits and identities — LEDGER_LIMITS is the sole owner of these caps.
// ---------------------------------------------------------------------------

export const LEDGER_LIMITS = {
  requests: 4096,
  eventsPerCommit: 64,
  eventKind: 64,
  eventPayloadBytes: 16384,
  idLen: 128,
  lockWaitMs: 2000,
  ledgerBytes: 16777216,
  memberships: 4096,
  pathLen: 4096,
  unboundTtlMs: 86400000,
  registrationWindowMs: 600000,
  ttlSweepPerCommit: 60,
  hookGitProbeMs: 2000,
  hookDeskTransactMs: 5000,
  // P3-a — the structured handback surface. Table row caps bound growth;
  // field caps bound a single row; the submit-time observed capture runs
  // bounded by the same 60s/32MiB budget VERIFY_LIMITS pins for probes.
  assignments: 1024,
  assignmentSeats: 128,
  candidates: 4096,
  handbacks: 4096,
  handbackRecordBytes: 262144,
  handbackGaps: 16,
  authorityRefLen: 1024,
  objectiveLen: 2048,
  snapshotIncomplete: 256,
  captureTimeoutMs: 60000,
  captureMaxBytes: 33554432,
  captureDetailLen: 512,
  // P3-b — the settlement mirror table. Row/field caps are NOT restated
  // here: the durable SettlementSchema reads the WIRE_LIMITS.desk*
  // keys directly so durable, wire and producer bounds share one source
  // (the F-STD-4 rule — a replayed durable row can never fail the wire
  // schema it is served under).
  settlements: 4096,
  // P4 — the scope/review/transition tables; identical F-STD-4 rule,
  // their row/field caps read WIRE_LIMITS.deskScope*/deskStatusScope*
  // directly.
  scopes: 2048,
  scopeReviews: 4096,
  scopeTransitions: 8192,
  // P5 — the check-runner/rollout tables; identical F-STD-4 rule, their
  // row/field caps read WIRE_LIMITS.deskCheck*/deskRollout* directly.
  // `checkTimeoutMs`/`checkOutputBytes` are the absolute ceilings a
  // definition's limits may only narrow; `cohortMembers` bounds the canary
  // membership snapshot; `checkRunAttempts` is the structural ceiling on
  // per-(rollout,checkId,candidate) retries — a definition's maxRetries
  // narrows it further, never widens it.
  checkDefinitions: 2048,
  checkRuns: 8192,
  checkRunAttempts: 2,
  rollouts: 1024,
  rolloutTransitions: 8192,
  checkTimeoutMs: 60000,
  checkOutputBytes: 1048576,
  cohortMembers: 32,
} as const;

const LEDGER_FORMAT = "paseo-slp/enforcement";
const LEDGER_SCHEMA_VERSION = 6;
const CANONICALIZATION = "slp-canonical-json/1";
const SEGMENT_NAME = /^(\d+)-(\d+)\.jsonl$/;
const LOCK_RETRY_MS = 25;

/** P2-d — the desk-bridge transport paths. The Unix socket lives at the
 *  enforcement root (not inside a repo namespace — it serves every seat
 *  repo); the lifecycle lockfile reuses the reserved repo namespace above so
 *  acquisition, staleness and recovery follow exactly the repo-lock rules. */
export function deskBridgePaths(stableRoot: string): {
  enforcementDir: string;
  socketPath: string;
  /** The self-installed bridge binary — a stable non-SHA path the
   *  agent.create graft points at (the candidate sha-dir is GC-able). */
  bridgePath: string;
  repoKey: string;
  repoDir: string;
  lockPath: string;
} {
  const repoKey = repoKeyFor(DESK_BRIDGE_REPO);
  const paths = deskRepoPaths(stableRoot, repoKey);
  return {
    enforcementDir: paths.enforcementDir,
    socketPath: join(paths.enforcementDir, "desk.sock"),
    bridgePath: join(paths.enforcementDir, "slp-desk-mcp.mjs"),
    repoKey,
    repoDir: paths.repoDir,
    lockPath: paths.lockPath,
  };
}

// ---------------------------------------------------------------------------
// Schemas — strict zod, header-first read, cross-field refinement layered on.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BoundedId = z.string().min(1).max(LEDGER_LIMITS.idLen);
const JsonObject = z
  .record(z.string(), z.unknown())
  .refine(value => isRecord(value), { message: "expected a JSON object" });

const EventSchema = z
  .object({
    seq: z.number().int().min(1),
    prevSha256: Sha.nullable(),
    sha256: Sha,
    at: Time,
    requestId: BoundedId,
    actorKey: BoundedId,
    assignmentId: BoundedId,
    kind: z.string().min(1).max(LEDGER_LIMITS.eventKind),
    payload: JsonObject,
  })
  .strict()
  .superRefine((event, ctx) => {
    try {
      const bytes = Buffer.byteLength(canonicalJson(event.payload), "utf8");
      if (bytes > LEDGER_LIMITS.eventPayloadBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload"],
          message: `payload exceeds ${LEDGER_LIMITS.eventPayloadBytes} canonical bytes`,
        });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "payload is not canonicalizable JSON" });
    }
  });

const RequestRecordSchema = z
  .object({
    actorKey: BoundedId,
    assignmentId: BoundedId,
    requestId: BoundedId,
    bodySha256: Sha,
    canonicalization: z.literal(CANONICALIZATION),
    receiptId: z.string().uuid(),
    revision: z.number().int().min(0),
    outcome: z.enum(["committed", "rejected"]),
    eventSeqs: z.tuple([z.number().int().min(1), z.number().int().min(1)]).nullable(),
    rejection: DeskRejection.nullable(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.outcome === "committed" && record.rejection !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "committed record carries a rejection" });
    }
    if (record.outcome === "rejected" && (record.rejection === null || record.eventSeqs !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rejected record must carry its rejection and eventSeqs:null",
      });
    }
    if (record.eventSeqs !== null && record.eventSeqs[0] > record.eventSeqs[1]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "eventSeqs range is inverted" });
    }
  });

const RepoSchema = z
  .object({
    repoKey: Sha,
    repoKeyAlgorithm: z.literal(REPO_KEY_ALGORITHM),
    hostId: z.string().min(1).max(WIRE_LIMITS.targetHostId),
    gitCommonDir: z.string().min(1).max(WIRE_LIMITS.targetDaemonHome),
  })
  .strict();

const isAbsolutePath = (value: string): boolean => value.startsWith("/");

/** P2-c membership states — the subset of SeatBindingState the handshake
 *  writes; `attached`/`active` belong to P2-e and no P2-c path creates
 *  them (guard is checked again in the seat decide). */
const MEMBERSHIP_STATES = ["unbound-open", "host-confirmed", "revoked"] as const;
/** Exported for the P2-e limitation table — the `revoked: <reason>` row
 *  limitation's worst-case entry derives from this enum, never a copy. */
export const REVOKE_REASONS = [
  "archived",
  "expired-unbound",
  "registration-mismatch",
  "registration-timeout",
] as const;

/** v2 membership row (contract §2). Deliberately narrower than the P0 §5
 *  Membership: duty/epoch/seatRuntime/hostSessionId/nativeHandle/
 *  observedParentAgentId arrive in v3 (P2-e) by another additive
 *  migration — P2-c has no writer for them. The raw handle is never
 *  stored; only its SHA-256. */
const MembershipSchema = z
  .object({
    membershipId: z.string().uuid(),
    state: z.enum(MEMBERSHIP_STATES),
    bindingHandleSha256: Sha,
    provider: z.string().min(1).max(WIRE_LIMITS.providerLen),
    family: Family,
    role: z.enum(ROLES),
    createCwd: z.string().min(1).max(WIRE_LIMITS.createCwdLen).refine(isAbsolutePath),
    openGeneration: z.literal(1),
    agentId: z.string().min(1).max(WIRE_LIMITS.agentId).nullable(),
    workspaceId: z.string().min(1).max(WIRE_LIMITS.workspaceIdLen).nullable(),
    createdAt: Time,
    hostConfirmedAt: Time.nullable(),
    registeredAt: Time.nullable(),
    revokedAt: Time.nullable(),
    revokeReason: z.enum(REVOKE_REASONS).nullable(),
  })
  .strict();

/** A Git object id — 40-hex full sha or the 64-hex sha256 form, mirroring
 *  plugin/server/runtime/cli/report-records.ts GIT_HEAD_PATTERN. */
const GitHead = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

/** P3-a — one seat binding inside an assignment row. The seat's agentId is
 *  the durable identity (a membership rebind keeps the seat attached);
 *  membershipId records the row that was live at attach time. */
const AssignmentSeatSchema = z
  .object({
    agentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    membershipId: z.string().uuid(),
  })
  .strict();

/** P3-a — a durable assignment binding. Minimal by contract: no scopes, no
 *  reservation/transfer, no parent linkage (those are P4). `authorityRef`
 *  is a verbatim pointer to the grant that created the row — stored, never
 *  dereferenced. `ownerAgentId` is denormalized so the owner check survives
 *  a membership rebind of the owning lead. Rows carry no timestamps —
 *  commit time lives on the hash-chained events. */
const AssignmentSchema = z
  .object({
    assignmentId: BoundedId,
    /** The register request's id — lets a replayed register rebuild its
     *  response from the durable row. */
    requestId: BoundedId,
    authorityRef: z.string().min(1).max(LEDGER_LIMITS.authorityRefLen),
    objective: z.string().min(1).max(LEDGER_LIMITS.objectiveLen).nullable(),
    ownerMembershipId: z.string().uuid(),
    ownerAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    workspaceId: z.string().min(1).max(WIRE_LIMITS.workspaceIdLen).nullable(),
    state: z.enum(["open", "closed"]),
    seats: z.array(AssignmentSeatSchema).max(LEDGER_LIMITS.assignmentSeats),
  })
  .strict();

/** P3-a — a plugin-observed candidate measurement. Rows exist only for a
 *  successful capture; a failed capture lands in the handback's `observed`
 *  block and `gaps`, never as a phantom candidate. `repository` is the
 *  measured root the server chose (the seat's membership createCwd). */
const CandidateSchema = z
  .object({
    candidateId: BoundedId,
    assignmentId: BoundedId,
    kind: z.literal("observed"),
    seatAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    seatMembershipId: z.string().uuid(),
    repository: z.string().min(1).max(LEDGER_LIMITS.pathLen).refine(isAbsolutePath),
    snapshotSha256: Sha,
    head: GitHead.nullable(),
    incomplete: z.array(z.string().min(1).max(LEDGER_LIMITS.pathLen)).max(LEDGER_LIMITS.snapshotIncomplete),
    measuredAt: Time,
  })
  .strict();

/** P3-a — the observed-capture outcome stored beside the claim. `pending`
 *  is the declared-but-unmeasured window between the submit commit and the
 *  observe commit (a crash leaves it resumable, never torn); `ok` carries
 *  the created candidate; `failed` carries the bounded reason the capture
 *  could not produce one. */
const HandbackObservedSchema = z
  .object({
    status: z.enum(["pending", "ok", "failed"]),
    candidateId: BoundedId.nullable(),
    repository: z.string().min(1).max(LEDGER_LIMITS.pathLen).refine(isAbsolutePath),
    measuredAt: Time.nullable(),
    error: z.string().min(1).max(LEDGER_LIMITS.captureDetailLen).nullable(),
  })
  .strict()
  .superRefine((observed, ctx) => {
    if (observed.status === "pending" && (observed.candidateId !== null || observed.measuredAt !== null || observed.error !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pending observation carries no outcome fields" });
    }
    if (observed.status === "ok" && (observed.candidateId === null || observed.measuredAt === null || observed.error !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ok observation must carry candidateId, measuredAt and error:null" });
    }
    if (observed.status === "failed" && (observed.candidateId !== null || observed.measuredAt === null || observed.error === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "failed observation carries error, measuredAt and candidateId:null" });
    }
  });

/** P3-a — an immutable handback revision. `record` is the seat's claim
 *  verbatim (provenance claimed); `observed` is the plugin's own
 *  measurement — the two never merge, and a `handback.observe` commit may
 *  only rewrite `observed`/`gaps`, never the claim fields. `requestId` is
 *  stored so a replayed submit can rebuild its response from the durable
 *  row. The revision stream is per (assignmentId, agentId). */
const HandbackSchema = z
  .object({
    handbackId: BoundedId,
    assignmentId: BoundedId,
    agentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    seatMembershipId: z.string().uuid(),
    requestId: BoundedId,
    revision: z.number().int().min(1),
    /** The seat's recordV1 claim, verbatim. */
    record: JsonObject,
    recordSha256: Sha,
    claimedCandidateId: BoundedId.nullable(),
    observed: HandbackObservedSchema,
    gaps: z.array(z.string().min(1).max(WIRE_LIMITS.gapLen)).max(LEDGER_LIMITS.handbackGaps),
  })
  .strict()
  .superRefine((row, ctx) => {
    try {
      const bytes = Buffer.byteLength(canonicalJson(row.record), "utf8");
      if (bytes > LEDGER_LIMITS.handbackRecordBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["record"],
          message: `record exceeds ${LEDGER_LIMITS.handbackRecordBytes} canonical bytes`,
        });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["record"], message: "record is not canonicalizable JSON" });
    }
  });

/** P3-b — a resource disposition entry inside a settlement row. `ref` is a
 *  claimed pointer (issue, handle, path, receipt — the desk never resolves
 *  it); `disposition` is the owner's attestation. `unknown` records a
 *  resource whose fate could not be attested — it never silently means
 *  released. */
const SettlementResourceSchema = z
  .object({
    ref: z.string().min(1).max(WIRE_LIMITS.deskSettlementPointer),
    disposition: z.enum(SETTLEMENT_RESOURCE_DISPOSITIONS),
  })
  .strict();

/** P3-b — the settlement timeline block, durable shape. `via` reads the
 *  closed SETTLEMENT_VIA enum from desk-records (the authoritative v1
 *  vocabulary); every other field shares its cap with the wire schema so a
 *  committed row always re-exports schema-valid. */
const SettlementTimelineSchema = z
  .object({
    nativeHandle: z.string().min(1).max(WIRE_LIMITS.deskTimelineField).nullable(),
    sessionId: z.string().min(1).max(WIRE_LIMITS.deskTimelineField).nullable(),
    via: z.enum(SETTLEMENT_VIA),
    export: z
      .object({
        path: z.string().min(1).max(WIRE_LIMITS.deskExportPath),
        sha256: Sha,
        bytes: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    gap: z.string().min(1).max(WIRE_LIMITS.gapLen).nullable(),
  })
  .strict();

/** P3-b — an immutable settlement revision. The mirror is evidence storage,
 *  never the official sink: `deliveryRef`/`reworkClosureRef`/`sinkRef`/
 *  `decisionRef` and `resources[].ref` are claimed pointers the desk stores
 *  verbatim and never dereferences (`decisionRef` in particular names an
 *  external decision the desk cannot resolve — P4 machinery does not
 *  exist). `ownerAgentId`/`seatAgentId`/`seatProvider` are denormalized so
 *  the row keeps the original identities across membership rebinds;
 *  `status`/`gaps` are the decide-computed disposition at commit time —
 *  later revisions append, they never rewrite. `requestId` is stored so a
 *  replayed record rebuilds its response from the durable row.
 *  `exportVerification` (P3-b R1) is the durable verdict of the
 *  server-side artifact seam over `timeline.export`: `verified` means the
 *  claimed artifact proved itself under the bound repository root,
 *  `unavailable` means the seam could not prove it — such a claim stays
 *  claimed-only and the row can never read completed. `null` iff no
 *  export was claimed. Disproven claims (absent/outside-root/mismatch)
 *  never persist — decide rejects them before a row exists. */
const SettlementSchema = z
  .object({
    settlementId: BoundedId,
    assignmentId: BoundedId,
    requestId: BoundedId,
    revision: z.number().int().min(1),
    ownerMembershipId: z.string().uuid(),
    ownerAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    seatAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    seatMembershipId: z.string().uuid(),
    seatProvider: z.string().min(1).max(WIRE_LIMITS.providerLen),
    seatTitle: z.string().min(1).max(WIRE_LIMITS.deskSettlementTitle),
    at: Time,
    deliveryRef: z.string().min(1).max(WIRE_LIMITS.deskSettlementPointer).nullable(),
    reworkClosureRef: z.string().min(1).max(WIRE_LIMITS.deskSettlementPointer).nullable(),
    sinkRef: z.string().min(1).max(WIRE_LIMITS.deskSettlementPointer).nullable(),
    decisionRef: z.string().min(1).max(WIRE_LIMITS.deskSettlementPointer).nullable(),
    handbackRefs: z.array(BoundedId).max(WIRE_LIMITS.deskSettlementRefs),
    candidateRefs: z.array(BoundedId).max(WIRE_LIMITS.deskSettlementRefs),
    resources: z.array(SettlementResourceSchema).max(WIRE_LIMITS.deskSettlementResources),
    timeline: SettlementTimelineSchema,
    exportVerification: z
      .object({
        status: z.enum(["verified", "unavailable"]),
        detail: z.string().min(1).max(WIRE_LIMITS.gapLen).nullable(),
      })
      .strict()
      .nullable(),
    status: z.enum(["completed", "partial", "blocked"]),
    gaps: z.array(z.string().min(1).max(WIRE_LIMITS.gapLen)).max(WIRE_LIMITS.deskStatusGaps),
  })
  .strict();

// ---------------------------------------------------------------------------
// P4 — scope ownership and required-review transitions. Three append-only
// tables: immutable declaration revisions (`scopes`), reviewer observations
// (`scopeReviews`) and the accepted transition stream (`scopeTransitions`).
// Claimed refs are stored verbatim and never dereferenced; the state-machine
// vocabulary lives in shared/enforcement.ts so wire, decide and the
// refinement layer share one legality source.
// ---------------------------------------------------------------------------

/** P4 — the structural revision of an assignment row: register is 1, every
 *  effective seat attach adds one, close adds one. Derivable from durable
 *  content only — a v4-migrated row yields the same value its history
 *  implies, so scope rows pinned at declare stay checkable. */
export function assignmentStructuralRevision(assignment: {
  state: "open" | "closed";
  seats: unknown[];
}): number {
  return 1 + assignment.seats.length + (assignment.state === "closed" ? 1 : 0);
}

/** P4 — one immutable scope declaration revision. The row binds
 *  (assignmentId, scopeId, ownerAgentId) plus the assignment's structural
 *  revision at declare time; `priorRevision` is the explicit lineage link
 *  (null on revision 1). `declarationSha256` attests the declaration body
 *  the caller holds; `refs` are claimed provenance only — a scope grants
 *  no filesystem authority. Rows carry no timestamps: commit time lives on
 *  the hash-chained events. */
const ScopeSchema = z
  .object({
    assignmentId: BoundedId,
    scopeId: BoundedId,
    requestId: BoundedId,
    revision: z.number().int().min(1),
    priorRevision: z.number().int().min(1).nullable(),
    ownerMembershipId: z.string().uuid(),
    ownerAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    assignmentRevision: z.number().int().min(1),
    seatAgentId: z.string().min(1).max(WIRE_LIMITS.agentId).nullable(),
    label: z.string().min(1).max(WIRE_LIMITS.deskScopeLabel),
    declarationSha256: Sha,
    refs: z.array(z.string().min(1).max(WIRE_LIMITS.deskScopePointer)).max(WIRE_LIMITS.deskScopeRefs),
  })
  .strict();

/** P4 — one immutable reviewer observation revision, bound to
 *  (assignmentId, scopeId, scopeRevision, candidateSnapshot, axis,
 *  reviewerAgentId, reviewerSeatId). An observation is durable evidence,
 *  never a state change: only an owner transition command moves the
 *  machine. `revision` streams per (scopeId, axis, reviewerAgentId);
 *  `findingsRef` is claimed provenance, never discharge proof. */
const ScopeReviewSchema = z
  .object({
    reviewId: BoundedId,
    assignmentId: BoundedId,
    scopeId: BoundedId,
    requestId: BoundedId,
    revision: z.number().int().min(1),
    scopeRevision: z.number().int().min(1),
    candidateSnapshot: Sha,
    axis: z.enum(SCOPE_REVIEW_AXES),
    verdict: z.enum(["approve", "reject", "findings"]),
    reviewerAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    reviewerSeatId: z.string().uuid(),
    findingsRef: z.string().min(1).max(WIRE_LIMITS.deskScopePointer).nullable(),
  })
  .strict();

/** P4 — one accepted transition of the scope state machine. `revision`
 *  streams per (assignmentId, scopeId); `from`/`to`/`command` must form a
 *  legal edge of SCOPE_TRANSITIONS against the previous row's `to`.
 *  `scopeRevision` pins the declaration revision the transition operated
 *  under (always the latest at commit). `candidateSnapshot`/`candidateHead`
 *  are the round pin — set only on submit-for-review rows. `discharged`
 *  records the (axis, reviewId) pairs the review gate consumed; it is
 *  empty on ungated transitions. `actorAgentId` is the server-derived
 *  owner identity. */
const ScopeTransitionSchema = z
  .object({
    transitionId: BoundedId,
    assignmentId: BoundedId,
    scopeId: BoundedId,
    requestId: BoundedId,
    revision: z.number().int().min(1),
    command: z.enum(["declare", "claim", "submit-for-review", "review-observed", "approve", "reject", "advance", "close"]),
    from: z.enum(SCOPE_STATES).nullable(),
    to: z.enum(SCOPE_STATES),
    scopeRevision: z.number().int().min(1),
    candidateSnapshot: Sha.nullable(),
    candidateHead: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).nullable(),
    discharged: z
      .array(
        z.object({
          axis: z.enum(SCOPE_REVIEW_AXES),
          reviewId: BoundedId,
        }).strict(),
      )
      .max(SCOPE_REVIEW_AXES.length),
    actorAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
  })
  .strict();

// ---------------------------------------------------------------------------
// P5 — independent check runner, canary cohort and rollout state. Four
// append-only tables: immutable check-definition revisions
// (`checkDefinitions`), immutable run results (`checkRuns`), immutable
// rollout declaration revisions (`rollouts`) and the accepted rollout
// transition stream (`rolloutTransitions`). The state-machine vocabulary
// and the allowlisted class names live in shared/enforcement.ts; the runner
// seam itself lives in desk-check-runner.ts.
// ---------------------------------------------------------------------------

/** P5 — one immutable check-definition revision. The row binds
 *  (assignmentId, scopeId, checkId, ownerAgentId) plus the assignment's
 *  structural revision at declare time. `checkClass` is a closed
 *  allowlisted name — never argv; `limits` may only narrow the LEDGER
 *  ceilings; `requiredEvidence`/`refs` are bounded claimed provenance. */
const CheckDefinitionSchema = z
  .object({
    checkId: BoundedId,
    assignmentId: BoundedId,
    scopeId: BoundedId,
    requestId: BoundedId,
    revision: z.number().int().min(1),
    priorRevision: z.number().int().min(1).nullable(),
    ownerMembershipId: z.string().uuid(),
    ownerAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    assignmentRevision: z.number().int().min(1),
    checkClass: z.enum(CHECK_CLASSES),
    label: z.string().min(1).max(WIRE_LIMITS.deskScopeLabel),
    definitionSha256: Sha,
    limits: z
      .object({
        timeoutMs: z.number().int().min(1).max(LEDGER_LIMITS.checkTimeoutMs),
        maxOutputBytes: z.number().int().min(1).max(LEDGER_LIMITS.checkOutputBytes),
        maxRetries: z.number().int().min(0).max(1),
      })
      .strict(),
    requiredEvidence: z
      .array(z.string().min(1).max(WIRE_LIMITS.deskCheckPointer))
      .max(WIRE_LIMITS.deskCheckEvidence),
    refs: z.array(z.string().min(1).max(WIRE_LIMITS.deskCheckPointer)).max(WIRE_LIMITS.deskScopeRefs),
  })
  .strict();

/** P5 — one immutable check run result. The row binds
 *  (assignmentId, rolloutId, checkId) to the definition revision+digest it
 *  executed under and to the rollout's candidate pin; `environment` is the
 *  server-measured fingerprint. `attempt`/`retryOf` form the per
 *  (assignmentId, rolloutId, checkId, candidateSnapshot) retry stream (structural cap
 *  LEDGER_LIMITS.checkRunAttempts). `gap` is the durable capability-gap
 *  record — non-null iff status is `blocked`; a blocked run never
 *  executed, so its execution fields stay null/false. `outputTail` is the
 *  bounded raw tail, `outputSha256` the digest of the full captured
 *  output, `outputPointer`/`evidenceRef` claimed provenance only. */
const CheckRunSchema = z
  .object({
    runId: BoundedId,
    assignmentId: BoundedId,
    rolloutId: BoundedId,
    checkId: BoundedId,
    requestId: BoundedId,
    rolloutRevision: z.number().int().min(1),
    definitionRevision: z.number().int().min(1),
    definitionSha256: Sha,
    candidateSnapshot: Sha,
    candidateHead: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).nullable(),
    environment: z
      .object({
        node: z.string().min(1).max(64),
        platform: z.string().min(1).max(64),
      })
      .strict(),
    status: z.enum(CHECK_RUN_STATUSES),
    attempt: z.number().int().min(1).max(LEDGER_LIMITS.checkRunAttempts),
    retryOf: BoundedId.nullable(),
    actorAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    actorSeatId: z.string().uuid(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().min(0).nullable(),
    outputSha256: Sha.nullable(),
    outputTail: z.string().max(WIRE_LIMITS.deskCheckOutputTail).nullable(),
    outputTruncated: z.boolean(),
    outputPointer: z.string().min(1).max(WIRE_LIMITS.deskCheckPointer).nullable(),
    evidenceRef: z.string().min(1).max(WIRE_LIMITS.deskCheckPointer).nullable(),
    gap: z
      .object({
        capability: z.string().min(1).max(128),
        detail: z.string().min(1).max(WIRE_LIMITS.gapLen),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.status === "blocked") {
      if (row.gap === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gap"], message: "a blocked run carries the durable capability-gap record" });
      }
      if (row.exitCode !== null || row.durationMs !== null || row.outputSha256 !== null || row.outputTail !== null || row.timedOut) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a blocked run never executed — execution fields stay empty" });
      }
    } else if (row.gap !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gap"], message: "only a blocked run carries a capability gap" });
    }
    if (row.attempt === 1 && row.retryOf !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retryOf"], message: "attempt 1 has no predecessor" });
    }
    if (row.attempt > 1 && row.retryOf === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retryOf"], message: "a retry names the run it retries" });
    }
  });

/** P5 — one immutable rollout declaration revision. Binds
 *  (assignmentId, scopeId, rolloutId, ownerAgentId, candidateSnapshot) —
 *  the candidate must resolve to a durable observed candidate of the
 *  assignment at declare time; `requiredChecks` pins the
 *  (checkId, definitionDigest) pairs the checks-passed/promote gates
 *  measure against. `refs` are claimed provenance only. */
const RolloutSchema = z
  .object({
    rolloutId: BoundedId,
    assignmentId: BoundedId,
    scopeId: BoundedId,
    requestId: BoundedId,
    revision: z.number().int().min(1),
    priorRevision: z.number().int().min(1).nullable(),
    ownerMembershipId: z.string().uuid(),
    ownerAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    assignmentRevision: z.number().int().min(1),
    label: z.string().min(1).max(WIRE_LIMITS.deskScopeLabel),
    declarationSha256: Sha,
    candidateSnapshot: Sha,
    candidateHead: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).nullable(),
    requiredChecks: z
      .array(
        z.object({
          checkId: BoundedId,
          definitionDigest: Sha,
        }).strict(),
      )
      .max(WIRE_LIMITS.deskRolloutRequiredChecks),
    refs: z.array(z.string().min(1).max(WIRE_LIMITS.deskCheckPointer)).max(WIRE_LIMITS.deskScopeRefs),
  })
  .strict();

/** P5 — one accepted rollout transition. `revision` streams per
 *  (assignmentId, rolloutId); `from`/`to`/`command` must form a legal edge
 *  of ROLLOUT_TRANSITIONS against the previous row's `to`. `rolloutRevision`
 *  pins the latest declaration revision at commit. `cohort` is set only on
 *  start-canary — the bounded membership snapshot the canary binds; the
 *  digest recomputes from `members` so a forged roster is corrupt.
 *  `targetSnapshot`/`targetHead` ride `rollback` only and resolve to an
 *  observed candidate of the assignment. `dischargedChecks` records the
 *  (checkId, runId) evidence a check-gated transition consumed;
 *  `cohortDigestAtGate` records the recomputed membership digest a
 *  cohort-gated transition observed. `evidenceRefs` are claimed
 *  provenance pointers, stored verbatim. */
const RolloutTransitionSchema = z
  .object({
    transitionId: BoundedId,
    assignmentId: BoundedId,
    rolloutId: BoundedId,
    requestId: BoundedId,
    revision: z.number().int().min(1),
    command: z.enum(["declare", ...ROLLOUT_COMMANDS]),
    from: z.enum(ROLLOUT_STATES).nullable(),
    to: z.enum(ROLLOUT_STATES),
    rolloutRevision: z.number().int().min(1),
    actorAgentId: z.string().min(1).max(WIRE_LIMITS.agentId),
    cohort: z
      .object({
        members: z.array(z.string().min(1).max(WIRE_LIMITS.agentId)).max(LEDGER_LIMITS.cohortMembers),
        digest: Sha,
        assignmentRevision: z.number().int().min(1),
      })
      .strict()
      .nullable(),
    targetSnapshot: Sha.nullable(),
    targetHead: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).nullable(),
    evidenceRefs: z.array(z.string().min(1).max(WIRE_LIMITS.deskCheckPointer)).max(WIRE_LIMITS.deskCheckEvidence),
    dischargedChecks: z
      .array(
        z.object({
          checkId: BoundedId,
          runId: BoundedId,
        }).strict(),
      )
      .max(WIRE_LIMITS.deskRolloutRequiredChecks),
    /** P5 — on review-gated commands (promote) this records the
     *  (axis, reviewId) evidence the scope's approved round discharged —
     *  every required axis once, each review row bound to the rollout's
     *  scope and candidate pin. Additive field: pre-correction v6 rows
     *  load with the empty default. */
    dischargedReviews: z
      .array(
        z.object({
          axis: z.enum(SCOPE_REVIEW_AXES),
          reviewId: BoundedId,
        }).strict(),
      )
      .max(SCOPE_REVIEW_AXES.length)
      .default([]),
    /** P5 — on cohort-gated commands (canary-passed, promote) this records
     *  the membership digest the decide recomputed at gate time; it must
     *  equal the digest the stream's start-canary row pinned, which makes
     *  cohort stability replayable from durable state alone. */
    cohortDigestAtGate: Sha.nullable(),
  })
  .strict();

const LedgerBodyFields = {
  format: z.literal(LEDGER_FORMAT),
  repo: RepoSchema,
  revision: z.number().int().min(0),
  createdAt: Time,
  updatedAt: Time,
  lastEventSeq: z.number().int().min(0),
  lastEventSha256: Sha.nullable(),
  requests: z.array(RequestRecordSchema).max(LEDGER_LIMITS.requests),
} as const;

/** Tables in durable introduction order. This registry owns each table's
 * schema/cap and first persisted version; historical schemas, additive
 * migrations, replacement channels and rejected-write projection reuse it. */
const TABLE_FIELDS_BY_VERSION = {
  2: { memberships: z.array(MembershipSchema).max(LEDGER_LIMITS.memberships) },
  3: {
    assignments: z.array(AssignmentSchema).max(LEDGER_LIMITS.assignments),
    candidates: z.array(CandidateSchema).max(LEDGER_LIMITS.candidates),
    handbacks: z.array(HandbackSchema).max(LEDGER_LIMITS.handbacks),
  },
  4: { settlements: z.array(SettlementSchema).max(LEDGER_LIMITS.settlements) },
  5: {
    scopes: z.array(ScopeSchema).max(LEDGER_LIMITS.scopes),
    scopeReviews: z.array(ScopeReviewSchema).max(LEDGER_LIMITS.scopeReviews),
    scopeTransitions: z.array(ScopeTransitionSchema).max(LEDGER_LIMITS.scopeTransitions),
  },
  6: {
    checkDefinitions: z.array(CheckDefinitionSchema).max(LEDGER_LIMITS.checkDefinitions),
    checkRuns: z.array(CheckRunSchema).max(LEDGER_LIMITS.checkRuns),
    rollouts: z.array(RolloutSchema).max(LEDGER_LIMITS.rollouts),
    rolloutTransitions: z.array(RolloutTransitionSchema).max(LEDGER_LIMITS.rolloutTransitions),
  },
} as const;

const LedgerTableFields = {
  ...TABLE_FIELDS_BY_VERSION[2],
  ...TABLE_FIELDS_BY_VERSION[3],
  ...TABLE_FIELDS_BY_VERSION[4],
  ...TABLE_FIELDS_BY_VERSION[5],
  ...TABLE_FIELDS_BY_VERSION[6],
};
type LedgerTableName = keyof typeof LedgerTableFields;
type LedgerTables = Pick<LedgerValue, LedgerTableName>;
const LEDGER_TABLE_NAMES = Object.keys(LedgerTableFields) as LedgerTableName[];

/** Strict historical schemas remain explicit: a version accepts only the
 * tables that existed then. No historical shape is written on success. */
const LedgerSchemaV1 = z.object({ ...LedgerBodyFields, schemaVersion: z.literal(1) }).strict();
const LedgerSchemaV2 = LedgerSchemaV1.extend({ schemaVersion: z.literal(2), ...TABLE_FIELDS_BY_VERSION[2] });
const LedgerSchemaV3 = LedgerSchemaV2.extend({ schemaVersion: z.literal(3), ...TABLE_FIELDS_BY_VERSION[3] });
const LedgerSchemaV4 = LedgerSchemaV3.extend({ schemaVersion: z.literal(4), ...TABLE_FIELDS_BY_VERSION[4] });
const LedgerSchemaV5 = LedgerSchemaV4.extend({ schemaVersion: z.literal(5), ...TABLE_FIELDS_BY_VERSION[5] });
const LedgerSchema = LedgerSchemaV5.extend({ schemaVersion: z.literal(LEDGER_SCHEMA_VERSION), ...TABLE_FIELDS_BY_VERSION[6] });
const LEDGER_SCHEMAS = {
  1: LedgerSchemaV1, 2: LedgerSchemaV2, 3: LedgerSchemaV3,
  4: LedgerSchemaV4, 5: LedgerSchemaV5, 6: LedgerSchema,
} as const;

type LedgerValueV2 = z.infer<typeof LedgerSchemaV2>;
type LedgerValueV3 = z.infer<typeof LedgerSchemaV3>;
type LedgerValueV4 = z.infer<typeof LedgerSchemaV4>;
type LedgerValueV5 = z.infer<typeof LedgerSchemaV5>;

function emptyTables<Fields extends Record<string, z.ZodArray>>(fields: Fields): { [K in keyof Fields]: z.infer<Fields[K]> } {
  // Every registered field is an array; every call creates distinct empties.
  return Object.fromEntries(Object.keys(fields).map(name => [name, []])) as { [K in keyof Fields]: z.infer<Fields[K]> };
}

/** Pure additive hops: existing rows, requests and events are carried
 * verbatim. read() chains these hops in memory; a rejection keeps its
 * persisted version, and only the next successful commit writes the bump. */
export const MIGRATIONS = {
  1: (ledger: z.infer<typeof LedgerSchemaV1>): LedgerValueV2 => ({
    ...ledger, schemaVersion: 2, ...emptyTables(TABLE_FIELDS_BY_VERSION[2]),
  }),
  2: (ledger: LedgerValueV2): LedgerValueV3 => ({
    ...ledger, schemaVersion: 3, ...emptyTables(TABLE_FIELDS_BY_VERSION[3]),
  }),
  3: (ledger: LedgerValueV3): LedgerValueV4 => ({
    ...ledger, schemaVersion: 4, ...emptyTables(TABLE_FIELDS_BY_VERSION[4]),
  }),
  4: (ledger: LedgerValueV4): LedgerValueV5 => ({
    ...ledger, schemaVersion: 5, ...emptyTables(TABLE_FIELDS_BY_VERSION[5]),
  }),
  5: (ledger: LedgerValueV5): LedgerValue => ({
    ...ledger, schemaVersion: LEDGER_SCHEMA_VERSION, ...emptyTables(TABLE_FIELDS_BY_VERSION[6]),
  }),
} as const;

function tableSnapshot(ledger: LedgerValue): LedgerTables {
  return Object.fromEntries(LEDGER_TABLE_NAMES.map(name => [name, ledger[name]])) as LedgerTables;
}

function replaceTable<K extends LedgerTableName>(tables: LedgerTables, name: K, value: unknown): z.ZodError | null {
  const parsed = LedgerTableFields[name].safeParse(value);
  if (!parsed.success) return parsed.error;
  // Indexing the schema and destination by the same registry key preserves
  // the row type even though TypeScript widens the schema union's output.
  tables[name] = parsed.data as LedgerTables[K];
  return null;
}

function persistedLedgerShape(ledger: LedgerValue, version: keyof typeof LEDGER_SCHEMAS): Record<string, unknown> {
  const shape: Record<string, unknown> = { ...ledger, schemaVersion: version };
  for (const [introduced, fields] of Object.entries(TABLE_FIELDS_BY_VERSION)) {
    if (Number(introduced) > version) for (const name of Object.keys(fields)) delete shape[name];
  }
  return shape;
}

const EnvelopeSchema = z
  .object({
    repo: z
      .object({
        hostId: z.string().min(1).max(WIRE_LIMITS.targetHostId),
        gitCommonDir: z.string().min(1).max(WIRE_LIMITS.targetDaemonHome),
      })
      .strict(),
    actorKey: BoundedId,
    assignmentId: BoundedId,
    requestId: BoundedId,
    command: JsonObject,
  })
  .strict();

const DecideEventSchema = z.object({ kind: z.string().min(1).max(LEDGER_LIMITS.eventKind), payload: JsonObject }).strict();

export type LedgerValue = z.infer<typeof LedgerSchema>;
export type MembershipValue = z.infer<typeof MembershipSchema>;
export type AssignmentValue = z.infer<typeof AssignmentSchema>;
export type CandidateValue = z.infer<typeof CandidateSchema>;
export type HandbackValue = z.infer<typeof HandbackSchema>;
export type SettlementValue = z.infer<typeof SettlementSchema>;
export type ScopeValue = z.infer<typeof ScopeSchema>;
export type ScopeReviewValue = z.infer<typeof ScopeReviewSchema>;
export type ScopeTransitionValue = z.infer<typeof ScopeTransitionSchema>;
export type CheckDefinitionValue = z.infer<typeof CheckDefinitionSchema>;
export type CheckRunValue = z.infer<typeof CheckRunSchema>;
export type RolloutValue = z.infer<typeof RolloutSchema>;
export type RolloutTransitionValue = z.infer<typeof RolloutTransitionSchema>;
export type RequestRecordValue = z.infer<typeof RequestRecordSchema>;
export type EventValue = z.infer<typeof EventSchema>;
export type DeskStoreEnvelope = z.infer<typeof EnvelopeSchema>;

/** Read outcomes — `diagnostics.code` is a closed vocabulary, never a free
 *  string: corrupt (invalid-json | header-invalid | schema-invalid |
 *  refinement-failed | hash-chain-broken | oversized), future
 *  (future-version), unsafe (unsafe-path | not-regular-file |
 *  repo-key-invalid | repo-mismatch). */
export type DeskStoreRead =
  | { state: "absent" }
  | { state: "ok"; ledger: LedgerValue; persistedSchemaVersion: 1 | 2 | 3 | 4 | 5 | 6 }
  | { state: "corrupt" | "future" | "unsafe"; diagnostics: { code: string; schemaVersion: number | null } };

export type TransactReceipt = {
  receiptId: string;
  revision: number;
  replayed: boolean;
  eventSeqs: [number, number] | null;
};
export type TransactResult = { ok: true; receipt: TransactReceipt } | DeskRejectionValue;

export type DecideOutcome =
  | ({
      ok: true;
      events: { kind: string; payload: Record<string, unknown> }[];
      /** §2.2 decide → state channels: each present collection is a FULL
       * replacement table; absent collections carry over verbatim. Store
       * schema/refinements enforce safety; seat semantics stay in decide. */
    } & Partial<LedgerTables>)
  | DeskRejectionValue;
export type DecideFunction = (ledger: Readonly<LedgerValue>, command: Record<string, unknown>) => DecideOutcome;

/** Internal test seam — production never passes `faults`. Each hook runs
 *  synchronously at its commit-protocol point; a hook may throw (maps to
 *  IO_FAILURE) or SIGKILL the process, and `lockHeld`/`lockWait` may return
 *  a promise so cross-process tests can barrier deterministically over IPC. */
export interface DeskStoreFaults {
  beforeLock?: () => void | Promise<void>;
  lockHeld?: () => void | Promise<void>;
  lockWait?: () => void | Promise<void>;
  segmentTempWritten?: () => void | Promise<void>;
  segmentRenamed?: () => void | Promise<void>;
  ledgerCommitted?: () => void | Promise<void>;
  afterComplete?: () => void | Promise<void>;
}

export interface DeskStoreDeps {
  stableRoot: string;
  platform?: string;
  uuid?: () => string;
  now?: () => Date;
  faults?: DeskStoreFaults;
}

export interface DeskStore {
  read(repoKey: string): DeskStoreRead;
  transact(repoKey: string, envelope: unknown, decide: DecideFunction): Promise<TransactResult>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function summarize(error: unknown, max = 200): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rejection(code: DeskRejectionValue["code"], message: string, recovery: string): DeskRejectionValue {
  return {
    ok: false,
    code,
    message: message.slice(0, WIRE_LIMITS.rejectionMessage),
    recovery: recovery.slice(0, WIRE_LIMITS.rejectionRecovery),
  };
}

const invalidRecord = (message: string, recovery = "correct the record and resubmit") =>
  rejection("INVALID_RECORD", message, recovery);

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".")}: ${issue.message}` : "schema";
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createDeskStore(deps: DeskStoreDeps): DeskStore {
  const platform = deps.platform ?? process.platform;
  const uuid = deps.uuid ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());
  const faults = deps.faults ?? {};
  const instanceNonce = uuid();
  const mutex = new Map<string, Promise<void>>();

  /** Every path under the stable root comes from the single owner,
   *  deskRepoPaths — the store never restates a join rule. */
  const repoPaths = (repoKey: string) => deskRepoPaths(deps.stableRoot, repoKey);

  /** The ancestor chain must be real directories all the way down; a
   *  symlinked or non-directory component makes the namespace unsafe. */
  function unsafeAncestors(repoKey: string): boolean {
    const paths = repoPaths(repoKey);
    for (const path of [
      deps.stableRoot,
      paths.stateDir,
      paths.enforcementDir,
      paths.baseDir,
      paths.repoDir,
      paths.eventsDir,
    ]) {
      const stat = lstatOrNull(path);
      if (stat !== null && (!stat.isDirectory() || stat.isSymbolicLink())) return true;
    }
    return false;
  }

  /** §2 cross-field refinement — everything the body schema cannot express.
   *  Returns the read-state classification: repo/namespace violations are
   *  unsafe, the rest are corrupt. The algorithm label is pinned by the
   *  z.literal in RepoSchema — a divergent value never reaches this layer. */
  function checkRefinements(ledger: LedgerValue, repoKey: string): DeskStoreRead | null {
    if (ledger.repo.repoKey !== repoKeyFor(ledger.repo) || ledger.repo.repoKey !== repoKey) {
      return { state: "unsafe", diagnostics: { code: "repo-mismatch", schemaVersion: ledger.schemaVersion } };
    }
    const keys = new Set<string>();
    for (const record of ledger.requests) {
      const key = JSON.stringify([record.actorKey, record.assignmentId, record.requestId]);
      if (keys.has(key)) {
        return { state: "corrupt", diagnostics: { code: "refinement-failed", schemaVersion: ledger.schemaVersion } };
      }
      keys.add(key);
      if (record.eventSeqs !== null && record.eventSeqs[1] > ledger.lastEventSeq) {
        return { state: "corrupt", diagnostics: { code: "refinement-failed", schemaVersion: ledger.schemaVersion } };
      }
    }
    if ((ledger.lastEventSeq === 0) !== (ledger.lastEventSha256 === null)) {
      return { state: "corrupt", diagnostics: { code: "refinement-failed", schemaVersion: ledger.schemaVersion } };
    }
    // Membership refinements (contract §2): state ⇔ null invariants, a
    // unique handle hash, and at most one live row per agentId.
    const corrupt = (): DeskStoreRead => ({
      state: "corrupt",
      diagnostics: { code: "refinement-failed", schemaVersion: ledger.schemaVersion },
    });
    const handles = new Set<string>();
    const liveAgents = new Set<string>();
    const membershipIds = new Set<string>();
    for (const row of ledger.memberships) {
      const unboundNulls =
        row.agentId === null &&
        row.workspaceId === null &&
        row.hostConfirmedAt === null &&
        row.registeredAt === null &&
        row.revokedAt === null;
      if (row.state === "unbound-open" && !unboundNulls) return corrupt();
      if (
        row.state === "host-confirmed" &&
        !(row.agentId !== null && row.hostConfirmedAt !== null && row.revokedAt === null)
      ) {
        return corrupt();
      }
      if (row.state === "revoked" && !(row.revokedAt !== null && row.revokeReason !== null)) return corrupt();
      if (row.registeredAt !== null && row.hostConfirmedAt === null) return corrupt();
      if (handles.has(row.bindingHandleSha256)) return corrupt();
      handles.add(row.bindingHandleSha256);
      // membershipId is the join key every P3-a table resolves through —
      // a duplicate makes the Map below pick one of two identities.
      if (membershipIds.has(row.membershipId)) return corrupt();
      membershipIds.add(row.membershipId);
      if (row.agentId !== null && row.state !== "revoked") {
        if (liveAgents.has(row.agentId)) return corrupt();
        liveAgents.add(row.agentId);
      }
    }
    // P3-a table refinements: unique ids, referential integrity into the
    // tables above, per-assignment seat uniqueness and a unique
    // (assignmentId, agentId, revision) handback stream. Beyond existence,
    // every identity link the decide relies on is cross-checked — owner and
    // seat memberships must carry the same agentId the referencing row
    // records (the owner's role must be lead, matching the register guard),
    // a handback/candidate row's seat identity must be attached to its own
    // assignment, and a referenced candidate must belong to the same
    // assignment. These are identity checks only — a closed assignment or a
    // revoked membership keeps its agentId, so valid history stays valid.
    const membershipsById = new Map(ledger.memberships.map(row => [row.membershipId, row]));
    const assignmentsById = new Map<string, AssignmentValue>();
    // The register response resolver looks its row up by the durable
    // (ownerAgentId, requestId) pair — the envelope layer already pins one
    // request per (actorKey, scope, requestId), so a duplicate pair here is
    // corruption, not a race.
    const ownerRequestKeys = new Set<string>();
    for (const row of ledger.assignments) {
      if (assignmentsById.has(row.assignmentId)) return corrupt();
      assignmentsById.set(row.assignmentId, row);
      const ownerRequestKey = JSON.stringify([row.ownerAgentId, row.requestId]);
      if (ownerRequestKeys.has(ownerRequestKey)) return corrupt();
      ownerRequestKeys.add(ownerRequestKey);
      const owner = membershipsById.get(row.ownerMembershipId);
      if (owner === undefined || owner.agentId !== row.ownerAgentId || owner.role !== "lead") return corrupt();
      const seatMemberships = new Set<string>();
      const seatAgents = new Set<string>();
      for (const seat of row.seats) {
        if (seatMemberships.has(seat.membershipId) || seatAgents.has(seat.agentId)) return corrupt();
        const seatRow = membershipsById.get(seat.membershipId);
        if (seatRow === undefined || seatRow.agentId !== seat.agentId) return corrupt();
        seatMemberships.add(seat.membershipId);
        seatAgents.add(seat.agentId);
      }
    }
    const candidatesById = new Map<string, CandidateValue>();
    for (const row of ledger.candidates) {
      if (candidatesById.has(row.candidateId)) return corrupt();
      candidatesById.set(row.candidateId, row);
      const assignment = assignmentsById.get(row.assignmentId);
      if (assignment === undefined) return corrupt();
      const seatRow = membershipsById.get(row.seatMembershipId);
      if (seatRow === undefined || seatRow.agentId !== row.seatAgentId) return corrupt();
      if (!assignment.seats.some(seat => seat.agentId === row.seatAgentId)) return corrupt();
    }
    const handbackIds = new Set<string>();
    const handbackRevisions = new Set<string>();
    // The submit response resolver looks its row up by the durable
    // (assignmentId, agentId, requestId) triple — unambiguous by the same
    // request-key invariant as ownerRequestKeys above.
    const submitKeys = new Set<string>();
    for (const row of ledger.handbacks) {
      if (handbackIds.has(row.handbackId)) return corrupt();
      handbackIds.add(row.handbackId);
      const assignment = assignmentsById.get(row.assignmentId);
      if (assignment === undefined) return corrupt();
      const seatRow = membershipsById.get(row.seatMembershipId);
      if (seatRow === undefined || seatRow.agentId !== row.agentId) return corrupt();
      if (!assignment.seats.some(seat => seat.agentId === row.agentId)) return corrupt();
      // Tuple keys are JSON-array encoded — a bare string concatenation
      // aliases distinct tuples (["x1",2] vs ["x",12] both hit "x12").
      const stream = JSON.stringify([row.assignmentId, row.agentId, row.revision]);
      if (handbackRevisions.has(stream)) return corrupt();
      handbackRevisions.add(stream);
      const submitKey = JSON.stringify([row.assignmentId, row.agentId, row.requestId]);
      if (submitKeys.has(submitKey)) return corrupt();
      submitKeys.add(submitKey);
      // The stored sha is the integrity check of the verbatim claim —
      // a mismatch is corrupt, never silently re-hashed or repaired.
      if (canonicalSha256(row.record) !== row.recordSha256) return corrupt();
      if (row.claimedCandidateId !== null) {
        const claimed = candidatesById.get(row.claimedCandidateId);
        if (claimed === undefined || claimed.assignmentId !== row.assignmentId) return corrupt();
      }
      if (row.observed.candidateId !== null) {
        const observed = candidatesById.get(row.observed.candidateId);
        if (
          observed === undefined ||
          observed.assignmentId !== row.assignmentId ||
          observed.seatMembershipId !== row.seatMembershipId
        ) {
          return corrupt();
        }
      }
    }
    // P3-b settlement refinements — the same fail-closed discipline:
    // unique ids, a unique revision stream per (assignmentId, seatAgentId),
    // a unique request key per (assignmentId, ownerAgentId), and every
    // identity link cross-checked. The owner must resolve to a live-role
    // lead membership matching the assignment's durable owner; the settled
    // seat must be a seat of that assignment whose membership carries the
    // same agentId and provider. Internal refs must resolve to THIS
    // seat's rows on THIS assignment — a foreign handback or candidate is
    // corruption, never a valid provenance link. `decisionRef` is claimed
    // provenance only: it is stored, never resolved here.
    const settlementIds = new Set<string>();
    const settlementStreams = new Set<string>();
    const settlementRequests = new Set<string>();
    for (const row of ledger.settlements) {
      if (settlementIds.has(row.settlementId)) return corrupt();
      settlementIds.add(row.settlementId);
      const stream = JSON.stringify([row.assignmentId, row.seatAgentId, row.revision]);
      if (settlementStreams.has(stream)) return corrupt();
      settlementStreams.add(stream);
      const requestKey = JSON.stringify([row.assignmentId, row.ownerAgentId, row.requestId]);
      if (settlementRequests.has(requestKey)) return corrupt();
      settlementRequests.add(requestKey);
      const assignment = assignmentsById.get(row.assignmentId);
      if (assignment === undefined) return corrupt();
      const owner = membershipsById.get(row.ownerMembershipId);
      if (owner === undefined || owner.agentId !== row.ownerAgentId || owner.role !== "lead") return corrupt();
      if (assignment.ownerAgentId !== row.ownerAgentId) return corrupt();
      const seat = assignment.seats.find(s => s.agentId === row.seatAgentId);
      if (seat === undefined || seat.membershipId !== row.seatMembershipId) return corrupt();
      const seatRow = membershipsById.get(row.seatMembershipId);
      if (seatRow === undefined || seatRow.agentId !== row.seatAgentId || seatRow.provider !== row.seatProvider) {
        return corrupt();
      }
      for (const ref of row.handbackRefs) {
        const hb = ledger.handbacks.find(h => h.handbackId === ref);
        if (hb === undefined || hb.assignmentId !== row.assignmentId || hb.agentId !== row.seatAgentId) {
          return corrupt();
        }
      }
      for (const ref of row.candidateRefs) {
        const cand = candidatesById.get(ref);
        if (cand === undefined || cand.assignmentId !== row.assignmentId || cand.seatAgentId !== row.seatAgentId) {
          return corrupt();
        }
      }
      // The transcript-export seam verdict couples with the claim: a null
      // export records no verdict; a claimed export must carry the seam's
      // persisted outcome. An `unavailable` verdict means the artifact
      // could not be proven — the row can never read completed and the
      // durable gap must name it; a `verified` row carrying the
      // unverified gap marker is equally inconsistent.
      if (row.timeline.export === null) {
        if (row.exportVerification !== null) return corrupt();
      } else {
        if (row.exportVerification === null) return corrupt();
        if (row.exportVerification.status === "unavailable") {
          if (row.status === "completed" || !row.gaps.includes("transcript-export-unverified")) {
            return corrupt();
          }
        } else if (row.gaps.includes("transcript-export-unverified")) {
          return corrupt();
        }
      }
    }
    // P4 scope refinements — the same fail-closed discipline. Declaration
    // rows: unique (assignmentId, scopeId, revision) streams that form a
    // contiguous 1..N lineage, a unique request key per
    // (assignmentId, ownerAgentId), owner resolves to a lead membership
    // carrying the row's agentId and matching the assignment's durable
    // owner, an optional bound seat must be attached to that assignment,
    // and the pinned assignmentRevision can never exceed the assignment's
    // current structural revision (it was pinned at declare time, so it
    // may only lag, never lead). `refs` stay claimed provenance.
    const scopeStreams = new Map<string, ScopeValue[]>();
    const scopeRequestKeys = new Set<string>();
    for (const row of ledger.scopes) {
      const streamKey = JSON.stringify([row.assignmentId, row.scopeId]);
      const stream = scopeStreams.get(streamKey) ?? [];
      if (stream.some(prev => prev.revision === row.revision)) return corrupt();
      stream.push(row);
      scopeStreams.set(streamKey, stream);
      const requestKey = JSON.stringify([row.assignmentId, row.ownerAgentId, row.requestId]);
      if (scopeRequestKeys.has(requestKey)) return corrupt();
      scopeRequestKeys.add(requestKey);
      const assignment = assignmentsById.get(row.assignmentId);
      if (assignment === undefined) return corrupt();
      const owner = membershipsById.get(row.ownerMembershipId);
      if (owner === undefined || owner.agentId !== row.ownerAgentId || owner.role !== "lead") return corrupt();
      if (assignment.ownerAgentId !== row.ownerAgentId) return corrupt();
      if (row.seatAgentId !== null && !assignment.seats.some(seat => seat.agentId === row.seatAgentId)) {
        return corrupt();
      }
      if (
        row.assignmentRevision < 1 ||
        row.assignmentRevision > assignmentStructuralRevision(assignment)
      ) {
        return corrupt();
      }
    }
    // Declaration lineage: each stream is contiguous 1..N and every
    // amendment names its immediate predecessor — a skipped or forked
    // lineage is corruption.
    for (const stream of scopeStreams.values()) {
      const revisions = new Set(stream.map(row => row.revision));
      if (revisions.size !== stream.length || Math.max(...revisions) !== stream.length) return corrupt();
      for (const row of stream) {
        if (row.revision === 1) {
          if (row.priorRevision !== null) return corrupt();
        } else if (row.priorRevision !== row.revision - 1) {
          return corrupt();
        }
      }
    }
    // scopeReviews: unique ids, a unique revision stream per
    // (assignmentId, scopeId, axis, reviewerAgentId) forming a contiguous
    // 1..N, a unique request key per (assignmentId, reviewerAgentId), and
    // every identity link cross-checked: the reviewer must be a seat of
    // the assignment whose membership carries the same agentId
    // (reviewerSeatId), the reviewer may never be the assignment owner or
    // the scope's bound seat (self-review is corruption), the pinned
    // scopeRevision must be a real declaration revision of that scope, and
    // a pinned candidate must resolve to an observed candidate of THIS
    // assignment — matching the scope's bound seat when one is declared.
    const reviewIds = new Set<string>();
    const reviewStreams = new Map<string, number[]>();
    const reviewRequestKeys = new Set<string>();
    const reviewsById = new Map<string, ScopeReviewValue>();
    for (const row of ledger.scopeReviews) {
      if (reviewIds.has(row.reviewId)) return corrupt();
      reviewIds.add(row.reviewId);
      reviewsById.set(row.reviewId, row);
      const streamKey = JSON.stringify([row.assignmentId, row.scopeId, row.axis, row.reviewerAgentId]);
      const revisions = reviewStreams.get(streamKey) ?? [];
      revisions.push(row.revision);
      reviewStreams.set(streamKey, revisions);
      const requestKey = JSON.stringify([row.assignmentId, row.reviewerAgentId, row.requestId]);
      if (reviewRequestKeys.has(requestKey)) return corrupt();
      reviewRequestKeys.add(requestKey);
      const assignment = assignmentsById.get(row.assignmentId);
      if (assignment === undefined) return corrupt();
      if (assignment.ownerAgentId === row.reviewerAgentId) return corrupt();
      const seat = assignment.seats.find(s => s.agentId === row.reviewerAgentId);
      if (seat === undefined || seat.membershipId !== row.reviewerSeatId) return corrupt();
      const seatRow = membershipsById.get(row.reviewerSeatId);
      if (seatRow === undefined || seatRow.agentId !== row.reviewerAgentId) return corrupt();
      const stream = scopeStreams.get(JSON.stringify([row.assignmentId, row.scopeId]));
      if (stream === undefined) return corrupt();
      const declaration = stream.find(s => s.revision === row.scopeRevision);
      if (declaration === undefined) return corrupt();
      const latestDeclaration = stream.reduce((max, s) => (s.revision > max.revision ? s : max));
      if (latestDeclaration.seatAgentId !== null && latestDeclaration.seatAgentId === row.reviewerAgentId) {
        return corrupt();
      }
      const candidate = ledger.candidates.find(
        c => c.snapshotSha256 === row.candidateSnapshot && c.assignmentId === row.assignmentId,
      );
      if (candidate === undefined) return corrupt();
      if (latestDeclaration.seatAgentId !== null && candidate.seatAgentId !== latestDeclaration.seatAgentId) {
        return corrupt();
      }
    }
    for (const revisions of reviewStreams.values()) {
      const set = new Set(revisions);
      if (set.size !== revisions.length || Math.max(...revisions) !== revisions.length) return corrupt();
    }
    // scopeTransitions: unique ids, a unique contiguous 1..N revision
    // stream per (assignmentId, scopeId), a unique request key per
    // (assignmentId, actorAgentId), actor bound to the durable owner, and
    // the chain must walk the shared SCOPE_TRANSITIONS legality table
    // exactly — the first edge is (none → declared) by `declare`, every
    // later row continues from its predecessor's `to`. The round pin the
    // latest submit-for-review established tracks through the walk; a
    // gated command's `discharged` must name real review rows bound to
    // exactly that pin (scopeRevision and candidateSnapshot of the ROUND,
    // which the gate transition's own scopeRevision may already have
    // passed when a mid-round amendment landed).
    const transitionIds = new Set<string>();
    const transitionRequestKeys = new Set<string>();
    const transitionsByScope = new Map<string, ScopeTransitionValue[]>();
    for (const row of ledger.scopeTransitions) {
      if (transitionIds.has(row.transitionId)) return corrupt();
      transitionIds.add(row.transitionId);
      const streamKey = JSON.stringify([row.assignmentId, row.scopeId]);
      const stream = transitionsByScope.get(streamKey) ?? [];
      stream.push(row);
      transitionsByScope.set(streamKey, stream);
      const requestKey = JSON.stringify([row.assignmentId, row.actorAgentId, row.requestId]);
      if (transitionRequestKeys.has(requestKey)) return corrupt();
      transitionRequestKeys.add(requestKey);
      const assignment = assignmentsById.get(row.assignmentId);
      if (assignment === undefined) return corrupt();
      if (assignment.ownerAgentId !== row.actorAgentId) return corrupt();
      const declStream = scopeStreams.get(streamKey);
      if (declStream === undefined) return corrupt();
      if (!declStream.some(s => s.revision === row.scopeRevision)) return corrupt();
      if (row.command !== "submit-for-review") {
        if (row.candidateSnapshot !== null || row.candidateHead !== null) return corrupt();
      } else if (row.candidateSnapshot === null) {
        return corrupt();
      }
    }
    for (const stream of transitionsByScope.values()) {
      stream.sort((a, b) => a.revision - b.revision);
      const set = new Set(stream.map(row => row.revision));
      if (set.size !== stream.length || stream[stream.length - 1]!.revision !== stream.length) {
        return corrupt();
      }
      let previousTo: ScopeStateValue | null = null;
      let roundPin: { scopeRevision: number; candidateSnapshot: string } | null = null;
      for (const row of stream) {
        if (row.revision === 1) {
          if (row.command !== "declare" || row.from !== null || row.to !== "declared") return corrupt();
        } else {
          if (row.command === "declare") return corrupt();
          if (row.from !== previousTo) return corrupt();
          if (row.from === null || scopeTransitionEdge(row.from, row.command) === undefined) return corrupt();
          if (scopeTransitionEdge(row.from, row.command)!.to !== row.to) return corrupt();
        }
        if (row.command === "submit-for-review") {
          roundPin = { scopeRevision: row.scopeRevision, candidateSnapshot: row.candidateSnapshot as string };
        }
        const gated = (SCOPE_REVIEW_GATED_COMMANDS as readonly string[]).includes(row.command);
        if (!gated) {
          if (row.discharged.length > 0) return corrupt();
        } else if (roundPin === null) {
          // No gated command is legal before a round exists — the edge
          // table carries no pre-round gated edge at all (early close is
          // not an edge since B4). Any such row is corruption.
          return corrupt();
        } else {
          const axes = new Set<string>();
          for (const entry of row.discharged) {
            if (axes.has(entry.axis)) return corrupt();
            axes.add(entry.axis);
            const review = reviewsById.get(entry.reviewId);
            if (
              review === undefined ||
              review.assignmentId !== row.assignmentId ||
              review.scopeId !== row.scopeId ||
              review.axis !== entry.axis ||
              review.scopeRevision !== roundPin.scopeRevision ||
              review.candidateSnapshot !== roundPin.candidateSnapshot
            ) {
              return corrupt();
            }
          }
          for (const axis of SCOPE_REVIEW_AXES) {
            if (!axes.has(axis)) return corrupt();
          }
        }
        previousTo = row.to;
      }
    }
    // P5 check-definition refinements — the same fail-closed discipline as
    // scopes: unique (assignmentId, checkId, revision) streams forming a
    // contiguous 1..N lineage, a unique request key per
    // (assignmentId, ownerAgentId), owner resolves to the assignment's
    // lead membership, the scope must exist on that assignment, and the
    // pinned assignmentRevision may only lag, never lead. `checkClass`
    // is already enum-bound by schema; `refs`/`requiredEvidence` stay
    // claimed provenance.
    const checkDefStreams = new Map<string, CheckDefinitionValue[]>();
    const checkDefRequestKeys = new Set<string>();
    for (const row of ledger.checkDefinitions) {
      const streamKey = JSON.stringify([row.assignmentId, row.checkId]);
      const stream = checkDefStreams.get(streamKey) ?? [];
      if (stream.some(prev => prev.revision === row.revision)) return corrupt();
      stream.push(row);
      checkDefStreams.set(streamKey, stream);
      const requestKey = JSON.stringify([row.assignmentId, row.ownerAgentId, row.requestId]);
      if (checkDefRequestKeys.has(requestKey)) return corrupt();
      checkDefRequestKeys.add(requestKey);
      const assignment = assignmentsById.get(row.assignmentId);
      if (assignment === undefined) return corrupt();
      const owner = membershipsById.get(row.ownerMembershipId);
      if (owner === undefined || owner.agentId !== row.ownerAgentId || owner.role !== "lead") return corrupt();
      if (assignment.ownerAgentId !== row.ownerAgentId) return corrupt();
      if (scopeStreams.get(JSON.stringify([row.assignmentId, row.scopeId])) === undefined) return corrupt();
      if (row.assignmentRevision < 1 || row.assignmentRevision > assignmentStructuralRevision(assignment)) {
        return corrupt();
      }
    }
    for (const stream of checkDefStreams.values()) {
      const revisions = new Set(stream.map(row => row.revision));
      if (revisions.size !== stream.length || Math.max(...revisions) !== stream.length) return corrupt();
      for (const row of stream) {
        if (row.revision === 1) {
          if (row.priorRevision !== null) return corrupt();
        } else if (row.priorRevision !== row.revision - 1) {
          return corrupt();
        }
      }
    }
    // P5 rollout declaration refinements — identical lineage/owner/scope
    // discipline, plus: the pinned candidate must resolve to an observed
    // candidate of this assignment, and every required check must name a
    // check definition ON THIS scope whose stored definitionSha256 equals
    // the pinned digest — a required entry that resolves to a different
    // scope or a phantom digest is corruption.
    const rolloutStreams = new Map<string, RolloutValue[]>();
    const rolloutRequestKeys = new Set<string>();
    for (const row of ledger.rollouts) {
      const streamKey = JSON.stringify([row.assignmentId, row.rolloutId]);
      const stream = rolloutStreams.get(streamKey) ?? [];
      if (stream.some(prev => prev.revision === row.revision)) return corrupt();
      stream.push(row);
      rolloutStreams.set(streamKey, stream);
      const requestKey = JSON.stringify([row.assignmentId, row.ownerAgentId, row.requestId]);
      if (rolloutRequestKeys.has(requestKey)) return corrupt();
      rolloutRequestKeys.add(requestKey);
      const assignment = assignmentsById.get(row.assignmentId);
      if (assignment === undefined) return corrupt();
      const owner = membershipsById.get(row.ownerMembershipId);
      if (owner === undefined || owner.agentId !== row.ownerAgentId || owner.role !== "lead") return corrupt();
      if (assignment.ownerAgentId !== row.ownerAgentId) return corrupt();
      if (scopeStreams.get(JSON.stringify([row.assignmentId, row.scopeId])) === undefined) return corrupt();
      if (row.assignmentRevision < 1 || row.assignmentRevision > assignmentStructuralRevision(assignment)) {
        return corrupt();
      }
      const candidate = ledger.candidates.find(
        c => c.snapshotSha256 === row.candidateSnapshot && c.assignmentId === row.assignmentId,
      );
      if (candidate === undefined) return corrupt();
      const requiredIds = new Set<string>();
      for (const required of row.requiredChecks) {
        if (requiredIds.has(required.checkId)) return corrupt();
        requiredIds.add(required.checkId);
        const defs = checkDefStreams.get(JSON.stringify([row.assignmentId, required.checkId]));
        const def = defs?.find(
          d => d.scopeId === row.scopeId && d.definitionSha256 === required.definitionDigest,
        );
        if (def === undefined) return corrupt();
      }
    }
    for (const stream of rolloutStreams.values()) {
      const revisions = new Set(stream.map(row => row.revision));
      if (revisions.size !== stream.length || Math.max(...revisions) !== stream.length) return corrupt();
      for (const row of stream) {
        if (row.revision === 1) {
          if (row.priorRevision !== null) return corrupt();
        } else if (row.priorRevision !== row.revision - 1) {
          return corrupt();
        }
      }
    }
    // P5 check-run refinements: unique runIds, a unique request key per
    // (assignmentId, actorAgentId), and every identity link cross-checked —
    // the run's (checkId, definitionRevision) must resolve to a definition
    // row whose stored digest matches, its (rolloutId, rolloutRevision)
    // must resolve to a declaration whose candidateSnapshot the run pins
    // verbatim, and the actor must be the rollout's owner resolved through
    // the actor membership. Retry streams are keyed by
    // (assignmentId, rolloutId, checkId, candidateSnapshot): contiguous
    // 1..N capped by
    // the definition's maxRetries, every attempt>1 naming its predecessor.
    const runIds = new Set<string>();
    const runRequestKeys = new Set<string>();
    const runRetryStreams = new Map<string, CheckRunValue[]>();
    const runsById = new Map<string, CheckRunValue>();
    for (const row of ledger.checkRuns) {
      if (runIds.has(row.runId)) return corrupt();
      runIds.add(row.runId);
      runsById.set(row.runId, row);
      const requestKey = JSON.stringify([row.assignmentId, row.actorAgentId, row.requestId]);
      if (runRequestKeys.has(requestKey)) return corrupt();
      runRequestKeys.add(requestKey);
      const assignment = assignmentsById.get(row.assignmentId);
      if (assignment === undefined) return corrupt();
      const defs = checkDefStreams.get(JSON.stringify([row.assignmentId, row.checkId]));
      const def = defs?.find(d => d.revision === row.definitionRevision);
      if (def === undefined || def.definitionSha256 !== row.definitionSha256) return corrupt();
      const decls = rolloutStreams.get(JSON.stringify([row.assignmentId, row.rolloutId]));
      const decl = decls?.find(d => d.revision === row.rolloutRevision);
      if (decl === undefined) return corrupt();
      if (row.candidateSnapshot !== decl.candidateSnapshot || row.candidateHead !== decl.candidateHead) {
        return corrupt();
      }
      if (decl.scopeId !== def.scopeId) return corrupt();
      if (row.actorAgentId !== decl.ownerAgentId) return corrupt();
      const actorRow = membershipsById.get(row.actorSeatId);
      if (actorRow === undefined || actorRow.agentId !== row.actorAgentId) return corrupt();
      // A passed run on a definition that requires evidence must carry the
      // evidence pointer — a bare claim is corruption.
      if (row.status === "passed" && def.requiredEvidence.length > 0 && row.evidenceRef === null) {
        return corrupt();
      }
      const streamKey = JSON.stringify([row.assignmentId, row.rolloutId, row.checkId, row.candidateSnapshot]);
      const stream = runRetryStreams.get(streamKey) ?? [];
      if (stream.some(prev => prev.attempt === row.attempt)) return corrupt();
      stream.push(row);
      runRetryStreams.set(streamKey, stream);
    }
    for (const stream of runRetryStreams.values()) {
      stream.sort((a, b) => a.attempt - b.attempt);
      // A retry stream runs one definition: mixing pinned revisions is
      // corruption (an amended check is a fresh stream under a new
      // candidate pin or an explicit re-run).
      const first = stream[0]!;
      for (const row of stream) {
        if (row.definitionRevision !== first.definitionRevision || row.definitionSha256 !== first.definitionSha256) {
          return corrupt();
        }
      }
      const defs = checkDefStreams.get(JSON.stringify([first.assignmentId, first.checkId]));
      const def = defs?.find(d => d.revision === first.definitionRevision);
      if (def === undefined) return corrupt();
      if (stream.length > 1 + def.limits.maxRetries) return corrupt();
      for (const [index, row] of stream.entries()) {
        if (row.attempt !== index + 1) return corrupt();
        if (index === 0) {
          if (row.retryOf !== null) return corrupt();
        } else if (row.retryOf !== stream[index - 1]!.runId) {
          return corrupt();
        }
      }
    }
    // rolloutTransitions: unique ids, a unique contiguous 1..N revision
    // stream per (assignmentId, rolloutId), a unique request key per
    // (assignmentId, actorAgentId), actor bound to the durable rollout
    // owner, and the chain must walk the shared ROLLOUT_TRANSITIONS
    // legality table exactly — the first edge is (none → declared) by
    // `declare`, every later row continues from its predecessor's `to`.
    // The cohort pinned by start-canary and the check evidence discharged
    // by gated commands are re-resolved here, so a forged roster, a
    // phantom gate pass or a drifted-cohort commit is corruption.
    const rolloutTransitionIds = new Set<string>();
    const rolloutTransitionRequestKeys = new Set<string>();
    const rolloutTransitionsByRollout = new Map<string, RolloutTransitionValue[]>();
    for (const row of ledger.rolloutTransitions) {
      if (rolloutTransitionIds.has(row.transitionId)) return corrupt();
      rolloutTransitionIds.add(row.transitionId);
      const streamKey = JSON.stringify([row.assignmentId, row.rolloutId]);
      const stream = rolloutTransitionsByRollout.get(streamKey) ?? [];
      stream.push(row);
      rolloutTransitionsByRollout.set(streamKey, stream);
      const requestKey = JSON.stringify([row.assignmentId, row.actorAgentId, row.requestId]);
      if (rolloutTransitionRequestKeys.has(requestKey)) return corrupt();
      rolloutTransitionRequestKeys.add(requestKey);
      const assignment = assignmentsById.get(row.assignmentId);
      if (assignment === undefined) return corrupt();
      const declStream = rolloutStreams.get(streamKey);
      if (declStream === undefined) return corrupt();
      const decl = declStream.find(d => d.revision === row.rolloutRevision);
      if (decl === undefined) return corrupt();
      if (row.actorAgentId !== decl.ownerAgentId) return corrupt();
      // Cohort/target/digest fields ride exactly the commands that pin
      // them — a stray payload is corruption.
      if (row.command === "start-canary") {
        if (row.cohort === null) return corrupt();
      } else if (row.cohort !== null) {
        return corrupt();
      }
      if (row.command === "rollback") {
        if (row.targetSnapshot === null) return corrupt();
        const target = ledger.candidates.find(
          c => c.snapshotSha256 === row.targetSnapshot && c.assignmentId === row.assignmentId,
        );
        if (target === undefined) return corrupt();
      } else if (row.targetSnapshot !== null || row.targetHead !== null) {
        return corrupt();
      }
      const cohortGated = (ROLLOUT_COHORT_GATED_COMMANDS as readonly string[]).includes(row.command);
      if (cohortGated !== (row.cohortDigestAtGate !== null)) return corrupt();
      if (row.cohort !== null) {
        // The roster re-digests to its own stored digest and may only name
        // the assignment's durable roster (owner + current seats — the
        // same current-row rule the scope-review refinement applies).
        const digest = canonicalSha256({ members: row.cohort.members, assignmentRevision: row.cohort.assignmentRevision });
        if (digest !== row.cohort.digest) return corrupt();
        const sorted = [...row.cohort.members].sort();
        if (row.cohort.members.length !== new Set(row.cohort.members).size) return corrupt();
        if (row.cohort.members.some((m, i) => m !== sorted[i])) return corrupt();
        if (row.cohort.assignmentRevision < 1 || row.cohort.assignmentRevision > assignmentStructuralRevision(assignment)) {
          return corrupt();
        }
        for (const member of row.cohort.members) {
          if (member !== assignment.ownerAgentId && !assignment.seats.some(seat => seat.agentId === member)) {
            return corrupt();
          }
        }
      }
    }
    for (const stream of rolloutTransitionsByRollout.values()) {
      stream.sort((a, b) => a.revision - b.revision);
      const set = new Set(stream.map(row => row.revision));
      if (set.size !== stream.length || stream[stream.length - 1]!.revision !== stream.length) {
        return corrupt();
      }
      const declStream = rolloutStreams.get(JSON.stringify([stream[0]!.assignmentId, stream[0]!.rolloutId]))!;
      let previousTo: string | null = null;
      let cohortDigest: string | null = null;
      for (const row of stream) {
        if (row.revision === 1) {
          if (row.command !== "declare" || row.from !== null || row.to !== "declared") return corrupt();
        } else {
          if (row.command === "declare") return corrupt();
          if (row.from !== previousTo) return corrupt();
          if (row.from === null) return corrupt();
          const edge = rolloutTransitionEdge(row.from as Parameters<typeof rolloutTransitionEdge>[0], row.command);
          if (edge === undefined || edge.to !== row.to) return corrupt();
        }
        if (row.command === "start-canary") {
          cohortDigest = row.cohort!.digest;
        }
        const checkGated = (ROLLOUT_CHECK_GATED_COMMANDS as readonly string[]).includes(row.command);
        if (!checkGated) {
          if (row.dischargedChecks.length > 0) return corrupt();
        } else {
          // The discharged set must exactly cover the required checks of
          // the declaration revision this transition pins: one passed run
          // per required checkId, bound to that rollout and to the
          // declaration's candidate pin.
          const decl = declStream.find(d => d.revision === row.rolloutRevision)!;
          const seen = new Set<string>();
          for (const entry of row.dischargedChecks) {
            if (seen.has(entry.checkId)) return corrupt();
            seen.add(entry.checkId);
            const run = runsById.get(entry.runId);
            if (
              run === undefined ||
              run.assignmentId !== row.assignmentId ||
              run.rolloutId !== row.rolloutId ||
              run.checkId !== entry.checkId ||
              run.status !== "passed" ||
              run.candidateSnapshot !== decl.candidateSnapshot
            ) {
              return corrupt();
            }
          }
          for (const required of decl.requiredChecks) {
            if (!seen.has(required.checkId)) return corrupt();
          }
          if (seen.size !== decl.requiredChecks.length) return corrupt();
        }
        const reviewGated = (ROLLOUT_REVIEW_GATED_COMMANDS as readonly string[]).includes(row.command);
        if (!reviewGated) {
          if (row.dischargedReviews.length > 0) return corrupt();
        } else {
          // The review discharge must be the exact set the scope's
          // approved round consumed: every required axis once, each
          // review row bound to the rollout's scope, and the review rows'
          // shared round pin (scopeRevision, candidateSnapshot) must be
          // the pin of an approve edge on that scope's stream — a forged,
          // foreign-candidate or unapproved discharge is corruption.
          const decl = declStream.find(d => d.revision === row.rolloutRevision)!;
          const seenAxes = new Set<string>();
          const pinKeys = new Set<string>();
          for (const entry of row.dischargedReviews) {
            if (seenAxes.has(entry.axis)) return corrupt();
            seenAxes.add(entry.axis);
            const review = reviewsById.get(entry.reviewId);
            if (
              review === undefined ||
              review.assignmentId !== row.assignmentId ||
              review.scopeId !== decl.scopeId ||
              review.axis !== entry.axis ||
              review.candidateSnapshot !== decl.candidateSnapshot
            ) {
              return corrupt();
            }
            pinKeys.add(JSON.stringify([review.scopeRevision, review.candidateSnapshot]));
          }
          for (const axis of SCOPE_REVIEW_AXES) {
            if (!seenAxes.has(axis)) return corrupt();
          }
          if (pinKeys.size !== 1) return corrupt();
          const scopeStream = transitionsByScope.get(JSON.stringify([row.assignmentId, decl.scopeId]));
          if (scopeStream === undefined) return corrupt();
          const dischargedKey = (list: { axis: string; reviewId: string }[]) =>
            canonicalSha256([...list].sort((a, b) => a.axis.localeCompare(b.axis)).map(e => [e.axis, e.reviewId]));
          let scopePin: { scopeRevision: number; candidateSnapshot: string } | null = null;
          let observedKey: string | null = null;
          let approvalMatched = false;
          for (const srow of scopeStream) {
            if (srow.command === "submit-for-review") {
              scopePin = { scopeRevision: srow.scopeRevision, candidateSnapshot: srow.candidateSnapshot as string };
              observedKey = null;
            }
            if (srow.command === "review-observed") observedKey = dischargedKey(srow.discharged);
            if (
              srow.to === "approved" &&
              scopePin !== null &&
              pinKeys.has(JSON.stringify([scopePin.scopeRevision, scopePin.candidateSnapshot])) &&
              observedKey === dischargedKey(row.dischargedReviews)
            ) {
              approvalMatched = true;
            }
          }
          if (!approvalMatched) return corrupt();
        }
        if (row.cohortDigestAtGate !== null && row.cohortDigestAtGate !== cohortDigest) {
          return corrupt();
        }
        previousTo = row.to;
      }
    }
    return null;
  }

  /** Recompute the event hash chain from segments covering seq
   *  1..lastEventSeq. Segments entirely above lastEventSeq are orphans —
   *  renamed but uncommitted — and carry no authority (A3); a segment whose
   *  range straddles lastEventSeq is verified up to the tip and its tail is
   *  ignored. A missing events dir or any structural deviation breaks the
   *  chain. */
  function verifyChain(repoKey: string, ledger: LedgerValue): boolean {
    if (ledger.lastEventSeq === 0) return true;
    const dir = repoPaths(repoKey).eventsDir;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      // Absence is structural (a chain gap → corrupt); every other fs error
      // is an unexpected I/O fault → IO_FAILURE via read()'s outer catch.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
    const segments = names
      .map(name => SEGMENT_NAME.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => ({ name: match[0], first: Number(match[1]), last: Number(match[2]) }))
      .filter(segment => segment.first >= 1 && segment.first <= segment.last)
      .sort((a, b) => a.first - b.first);
    let expected = 1;
    let prevSha256: string | null = null;
    for (const segment of segments) {
      if (segment.first > ledger.lastEventSeq) continue; // orphan segment
      if (segment.first !== expected) return false; // gap or overlap
      let bytes: string;
      try {
        bytes = readFileSync(join(dir, segment.name), "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return false;
        throw error;
      }
      const lines = bytes.split("\n").filter(line => line.length > 0);
      if (lines.length !== segment.last - segment.first + 1) return false;
      for (const [index, line] of lines.entries()) {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          return false;
        }
        const parsed = EventSchema.safeParse(json);
        if (!parsed.success) return false;
        const event = parsed.data;
        if (event.seq !== segment.first + index) return false;
        const { sha256, ...rest } = event;
        if (sha256 !== canonicalSha256(rest)) return false;
        if (event.seq > ledger.lastEventSeq) break; // orphan tail
        if (event.prevSha256 !== prevSha256) return false;
        prevSha256 = sha256;
        expected += 1;
      }
    }
    return expected - 1 === ledger.lastEventSeq && prevSha256 === ledger.lastEventSha256;
  }

  function read(repoKey: string): DeskStoreRead {
    try {
      if (!REPO_KEY_PATTERN.test(repoKey)) {
        return { state: "unsafe", diagnostics: { code: "repo-key-invalid", schemaVersion: null } };
      }
      if (unsafeAncestors(repoKey)) {
        return { state: "unsafe", diagnostics: { code: "unsafe-path", schemaVersion: null } };
      }
      const path = repoPaths(repoKey).ledgerPath;
      const stat = lstatOrNull(path);
      if (stat === null) return { state: "absent" };
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { state: "unsafe", diagnostics: { code: "not-regular-file", schemaVersion: null } };
      }
      if (stat.size > LEDGER_LIMITS.ledgerBytes) {
        return { state: "corrupt", diagnostics: { code: "oversized", schemaVersion: null } };
      }
      let bytes: string;
      try {
        bytes = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
        throw error;
      }
      let json: unknown;
      try {
        json = JSON.parse(bytes);
      } catch {
        return { state: "corrupt", diagnostics: { code: "invalid-json", schemaVersion: null } };
      }
      if (!isRecord(json)) {
        return { state: "corrupt", diagnostics: { code: "schema-invalid", schemaVersion: null } };
      }
      // Header-first: format and schemaVersion are read before the body so a
      // future version can never be mistaken for corruption or for empty.
      const { format, schemaVersion } = json as { format?: unknown; schemaVersion?: unknown };
      if (format !== LEDGER_FORMAT || typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
        return { state: "corrupt", diagnostics: { code: "header-invalid", schemaVersion: null } };
      }
      if (schemaVersion > LEDGER_SCHEMA_VERSION) {
        return { state: "future", diagnostics: { code: "future-version", schemaVersion } };
      }
      // Older ledgers migrate in-memory through the MIGRATIONS chain and
      // read as ok with their persistedSchemaVersion; the on-disk bytes are
      // never touched by read — the bump happens in the next transact's
      // commit.
      let ledger: LedgerValue;
      let persistedSchemaVersion: 1 | 2 | 3 | 4 | 5 | 6;
      if (schemaVersion === 1) {
        const v1 = LedgerSchemaV1.safeParse(json);
        if (!v1.success) {
          return { state: "corrupt", diagnostics: { code: "schema-invalid", schemaVersion } };
        }
        ledger = MIGRATIONS[5](MIGRATIONS[4](MIGRATIONS[3](MIGRATIONS[2](MIGRATIONS[1](v1.data)))));
        persistedSchemaVersion = 1;
      } else if (schemaVersion === 2) {
        const v2 = LedgerSchemaV2.safeParse(json);
        if (!v2.success) {
          return { state: "corrupt", diagnostics: { code: "schema-invalid", schemaVersion } };
        }
        ledger = MIGRATIONS[5](MIGRATIONS[4](MIGRATIONS[3](MIGRATIONS[2](v2.data))));
        persistedSchemaVersion = 2;
      } else if (schemaVersion === 3) {
        const v3 = LedgerSchemaV3.safeParse(json);
        if (!v3.success) {
          return { state: "corrupt", diagnostics: { code: "schema-invalid", schemaVersion } };
        }
        ledger = MIGRATIONS[5](MIGRATIONS[4](MIGRATIONS[3](v3.data)));
        persistedSchemaVersion = 3;
      } else if (schemaVersion === 4) {
        const v4 = LedgerSchemaV4.safeParse(json);
        if (!v4.success) {
          return { state: "corrupt", diagnostics: { code: "schema-invalid", schemaVersion } };
        }
        ledger = MIGRATIONS[5](MIGRATIONS[4](v4.data));
        persistedSchemaVersion = 4;
      } else if (schemaVersion === 5) {
        const v5 = LedgerSchemaV5.safeParse(json);
        if (!v5.success) {
          return { state: "corrupt", diagnostics: { code: "schema-invalid", schemaVersion } };
        }
        ledger = MIGRATIONS[5](v5.data);
        persistedSchemaVersion = 5;
      } else {
        const parsed = LedgerSchema.safeParse(json);
        if (!parsed.success) {
          return { state: "corrupt", diagnostics: { code: "schema-invalid", schemaVersion } };
        }
        ledger = parsed.data;
        persistedSchemaVersion = 6;
      }
      const refinement = checkRefinements(ledger, repoKey);
      if (refinement !== null) return refinement;
      if (!verifyChain(repoKey, ledger)) {
        return { state: "corrupt", diagnostics: { code: "hash-chain-broken", schemaVersion } };
      }
      return { state: "ok", ledger, persistedSchemaVersion };
    } catch (error) {
      if (error instanceof OperationConflict) throw error;
      throw new OperationConflict("IO_FAILURE", `ledger read failed: ${summarize(error)}`);
    }
  }

  function ensureRepoDir(repoKey: string): void {
    const paths = repoPaths(repoKey);
    ensurePrivateDirectory(paths.stateDir, platform);
    ensurePrivateDirectory(paths.enforcementDir, platform);
    ensurePrivateDirectory(paths.baseDir, platform);
    ensurePrivateDirectory(paths.repoDir, platform);
  }

  /** wx-create the lockfile and retry until lockWaitMs expires; on expiry,
   *  classify the holder — a live pid answers desk-busy, anything else is
   *  RECOVERY_REQUIRED. The file is never deleted or overwritten. */
  async function acquireLock(repoKey: string): Promise<{ held: true } | { rejection: DeskRejectionValue }> {
    const path = repoPaths(repoKey).lockPath;
    const content = JSON.stringify({
      pid: process.pid,
      instanceNonce,
      startedAt: now().toISOString(),
    });
    const deadline = Date.now() + LEDGER_LIMITS.lockWaitMs;
    for (;;) {
      try {
        const fd = openSync(path, "wx", PRIVATE_FILE_MODE);
        try {
          writeSync(fd, content);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return { held: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new OperationConflict("IO_FAILURE", `cannot create desk lock: ${summarize(error)}`);
        }
        if (Date.now() < deadline) {
          await faults.lockWait?.();
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        // Expired: classify the holder. kill(pid, 0) success or EPERM means
        // the process is alive; ESRCH means dead; an unreadable lock means
        // unknown — the lock is never removed either way.
        let holder: LockHolder | null = null;
        try {
          holder = parseLockHolder(readFileSync(path));
        } catch {
          holder = null;
        }
        if (holder !== null) {
          const { pid, instanceNonce: holderNonce } = holder;
          const state = classifyLockHolderProcess(pid, pid => process.kill(pid, 0));
          if (state === "alive" || state === "eperm") {
            return {
              rejection: rejection(
                "CAPABILITY_GAP",
                `desk lock held by live pid ${pid} (instance ${holderNonce})`,
                "desk-busy: another instance holds the repo lock",
              ),
            };
          }
          // ESRCH or an undetermined kill → recovery-required.
          return {
            rejection: rejection(
              "RECOVERY_REQUIRED",
              `desk lock holder pid ${pid} is dead or undetermined (instance ${holderNonce}) — stale lock, recovery is P2-e`,
              "manual desk-lock recovery under maintenance authority",
            ),
          };
        }
        return {
          rejection: rejection(
            "RECOVERY_REQUIRED",
            "desk lock is unreadable or unparseable — stale lock, recovery is P2-e",
            "manual desk-lock recovery under maintenance authority",
          ),
        };
      }
    }
  }

  /** Release only deletes a lock still owned by this instance — identical
   *  pid AND nonce. Anything else is IO_FAILURE; a foreign lock is never
   *  removed. */
  function releaseLock(repoKey: string): void {
    const path = repoPaths(repoKey).lockPath;
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      throw new OperationConflict("IO_FAILURE", `cannot read desk lock for release: ${summarize(error)}`);
    }
    const holder = parseLockHolder(content);
    if (holder?.pid !== process.pid || holder.instanceNonce !== instanceNonce) {
      throw new OperationConflict("IO_FAILURE", `desk lock at ${path} is not owned by this instance — left in place`);
    }
    try {
      unlinkSync(path);
      fsyncDirectory(repoPaths(repoKey).repoDir, platform);
    } catch (error) {
      throw new OperationConflict("IO_FAILURE", `cannot release desk lock: ${summarize(error)}`);
    }
  }

  /** Temp-sibling + fsync + rename + directory fsync — the same durable
   *  write idiom the journal uses. renameSync replaces an orphan segment of
   *  the same name; the temp is cleaned on any failure. */
  function atomicWrite(path: string, bytes: string, dir: string): void {
    const temp = `${path}.${uuid()}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(temp, "wx", PRIVATE_FILE_MODE);
      writeSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, path);
      fsyncDirectory(dir, platform);
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closing on the failure path
        }
      }
      rmSync(temp, { force: true });
      if (error instanceof OperationConflict) throw error;
      throw new OperationConflict("IO_FAILURE", `desk write failed for ${path}: ${summarize(error)}`);
    }
  }

  function freshLedger(repo: DeskStoreEnvelope["repo"], repoKey: string): LedgerValue {
    const stamp = now().toISOString();
    return {
      format: LEDGER_FORMAT,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      repo: { ...repo, repoKey, repoKeyAlgorithm: REPO_KEY_ALGORITHM },
      revision: 0,
      createdAt: stamp,
      updatedAt: stamp,
      lastEventSeq: 0,
      lastEventSha256: null,
      requests: [],
      ...emptyTables(LedgerTableFields),
    };
  }

  /** Validate a committed decide result's event list against the caps —
   *  every violation is a caller error: INVALID_RECORD, nothing recorded. */
  function checkDecideEvents(events: unknown[]): { ok: true } | { rejection: DeskRejectionValue } {
    if (events.length > LEDGER_LIMITS.eventsPerCommit) {
      return { rejection: invalidRecord(`decide returned ${events.length} events — over the ${LEDGER_LIMITS.eventsPerCommit}-event bound`) };
    }
    for (const [index, event] of events.entries()) {
      const parsed = DecideEventSchema.safeParse(event);
      if (!parsed.success) {
        return { rejection: invalidRecord(`decide event ${index} is malformed: ${firstIssue(parsed.error)}`) };
      }
      try {
        const bytes = Buffer.byteLength(canonicalJson(parsed.data.payload), "utf8");
        if (bytes > LEDGER_LIMITS.eventPayloadBytes) {
          return { rejection: invalidRecord(`decide event ${index} payload exceeds ${LEDGER_LIMITS.eventPayloadBytes} canonical bytes`) };
        }
      } catch (error) {
        return { rejection: invalidRecord(`decide event ${index} payload is not canonicalizable JSON: ${summarize(error)}`) };
      }
    }
    return { ok: true };
  }

  async function commit(
    repoKey: string,
    envelope: DeskStoreEnvelope,
    decide: DecideFunction,
    bodySha256: string,
  ): Promise<TransactResult> {
    // c1 — before the lock attempt; a crash here leaves no lock, no dirs.
    await faults.beforeLock?.();
    ensureRepoDir(repoKey);
    const lock = await acquireLock(repoKey);
    if ("rejection" in lock) return lock.rejection;
    try {
      // The deterministic-concurrency barrier (C1–C3): the holder pauses
      // while owning the lockfile; other processes' acquire retries observe
      // it exactly like a slow writer.
      await faults.lockHeld?.();
      const state = read(repoKey);
      if (state.state !== "ok" && state.state !== "absent") {
        return rejection(
          "STATE_UNREADABLE",
          `desk ledger is ${state.state} (${state.diagnostics.code}${state.diagnostics.schemaVersion !== null ? `, schemaVersion ${state.diagnostics.schemaVersion}` : ""})`,
          "inspect the ledger under maintenance authority and restore or re-initialize it",
        );
      }
      const ledger = state.state === "absent" ? freshLedger(envelope.repo, repoKey) : state.ledger;
      // An older-version ledger read under this lock migrates in-memory;
      // this commit is the first write after the bump, so it records the
      // current schemaVersion plus the schema-migrated event (contract §2).
      const migratedFrom =
        state.state === "ok" && state.persistedSchemaVersion < LEDGER_SCHEMA_VERSION
          ? state.persistedSchemaVersion
          : null;
      if (state.state === "ok") {
        if (ledger.repo.hostId !== envelope.repo.hostId || ledger.repo.gitCommonDir !== envelope.repo.gitCommonDir) {
          return invalidRecord("envelope repo does not match the ledger's repo binding", "transact against the repo the ledger is bound to");
        }
      }
      // Idempotency precedes every other guard: the recorded outcome replays
      // verbatim — a committed receipt returns its record's fields, a
      // rejected request returns the rejection it committed.
      const prior = ledger.requests.find(
        record =>
          record.actorKey === envelope.actorKey &&
          record.assignmentId === envelope.assignmentId &&
          record.requestId === envelope.requestId,
      );
      if (prior !== undefined) {
        if (prior.bodySha256 !== bodySha256) {
          return rejection(
            "IDEMPOTENCY_CONFLICT",
            `requestId ${envelope.requestId} was recorded with a different body`,
            "resubmit under a new requestId or resend the identical body",
          );
        }
        if (prior.outcome === "rejected") return prior.rejection!;
        return {
          ok: true,
          receipt: {
            receiptId: prior.receiptId,
            revision: prior.revision,
            replayed: true,
            eventSeqs: prior.eventSeqs,
          },
        };
      }
      if (ledger.requests.length >= LEDGER_LIMITS.requests) {
        return invalidRecord(
          `requests table is full (${LEDGER_LIMITS.requests})`,
          "maintenance compaction required",
        );
      }
      // decide is synchronous and pure — a thenable or a throw is a caller
      // error, recorded nowhere.
      let outcome: unknown;
      try {
        outcome = decide(deepFreeze(structuredClone(ledger)), envelope.command);
      } catch (error) {
        return invalidRecord(`decide threw: ${summarize(error)}`, "fix the decide function and resubmit");
      }
      if (isThenable(outcome)) {
        return invalidRecord("decide must be synchronous — it returned a promise", "return the decision synchronously");
      }
      if (!isRecord(outcome) || (outcome.ok !== true && outcome.ok !== false)) {
        return invalidRecord("decide must return {ok:true, events} or a DeskRejection", "return a valid decision shape");
      }
      if (outcome.ok === false) {
        const parsed = DeskRejection.safeParse(outcome);
        if (!parsed.success) {
          return invalidRecord(`decide returned a malformed rejection: ${firstIssue(parsed.error)}`, "return a schema-valid DeskRejection");
        }
      }
      const decided = outcome as DecideOutcome;
      const decidedEvents = decided.ok === true ? decided.events : [];
      if (!Array.isArray(decidedEvents)) {
        return invalidRecord("decide must return an events array", "return {ok:true, events:[...]}");
      }
      // E-P2C-2 — the migration event rides the first SUCCESSFUL commit
      // after an in-memory bump. A rejection on an older-version ledger
      // commits into the persisted shape (no new tables, no event); the
      // next successful commit migrates.
      const events =
        migratedFrom !== null && decided.ok === true
          ? [{ kind: "schema-migrated", payload: { from: migratedFrom, to: LEDGER_SCHEMA_VERSION } }, ...decidedEvents]
          : decidedEvents;
      const eventsCheck = checkDecideEvents(events);
      if ("rejection" in eventsCheck) return eventsCheck.rejection;

      // §2.2 — the decide → state channels, checked after decide and before
      // the segment write, schema-level only: each replacement table must
      // parse strict and the candidate ledger (all channels applied) must
      // pass the same refinements read() applies. A violation is a
      // consumer error — INVALID_RECORD, nothing recorded (the
      // decide-threw branch of P2-a step 5).
      const nextTables = tableSnapshot(ledger);
      if (decided.ok === true) {
        const proposed: LedgerTableName[] = [];
        for (const name of LEDGER_TABLE_NAMES) {
          if (decided[name] === undefined) continue;
          proposed.push(name);
          const error = replaceTable(nextTables, name, decided[name]);
          if (error !== null) {
            return invalidRecord(
              `decide returned invalid ${name}: ${firstIssue(error)}`,
              `fix the decide function to return a schema-valid ${name} table`,
            );
          }
        }
        if (proposed.length > 0) {
          const candidateInvalid = checkRefinements({ ...ledger, ...nextTables }, repoKey);
          if (candidateInvalid !== null) {
            return invalidRecord(
              `decide returned invalid ${proposed.length === 1 ? proposed[0] : "state tables"} (refinement failed)`,
              "fix the decide function to return tables that satisfy the ledger refinements",
            );
          }
        }
      }

      const receiptId = uuid();
      const revision = ledger.revision + 1;
      const rejectionForRecord = decided.ok === false ? (decided as DeskRejectionValue) : null;
      const stamp = now().toISOString();
      let eventSeqs: [number, number] | null = null;
      let lastEventSeq = ledger.lastEventSeq;
      let lastEventSha256 = ledger.lastEventSha256;

      // Build the chain in memory first: the serialized-byte check below
      // must fire before ANY durable write, so the event segment only lands
      // after the candidate ledger is proven to fit LEDGER_LIMITS.ledgerBytes.
      // Seqs continue lastEventSeq, prevSha256 links to the prior event's
      // digest (or the recorded tip).
      const built: EventValue[] = [];
      if (decided.ok === true && events.length > 0) {
        let prev = ledger.lastEventSha256;
        for (const event of events) {
          const seq = lastEventSeq + 1;
          const withoutDigest = {
            seq,
            prevSha256: prev,
            at: stamp,
            requestId: envelope.requestId,
            actorKey: envelope.actorKey,
            assignmentId: envelope.assignmentId,
            kind: event.kind,
            payload: event.payload,
          };
          const sha256 = canonicalSha256(withoutDigest);
          built.push({ ...withoutDigest, sha256 });
          prev = sha256;
          lastEventSeq = seq;
        }
        lastEventSha256 = prev;
        eventSeqs = [built[0]!.seq, built[built.length - 1]!.seq];
      }

      const record: RequestRecordValue = {
        actorKey: envelope.actorKey,
        assignmentId: envelope.assignmentId,
        requestId: envelope.requestId,
        bodySha256,
        canonicalization: CANONICALIZATION,
        receiptId,
        revision,
        outcome: decided.ok === true ? "committed" : "rejected",
        eventSeqs,
        rejection: rejectionForRecord,
      };
      const candidate: LedgerValue = {
        ...ledger,
        revision,
        updatedAt: stamp,
        lastEventSeq,
        lastEventSha256,
        requests: [...ledger.requests, record],
        ...nextTables,
      };
      // The pre-commit refinement pass is the same one read() applies — a
      // ledger that would read as unsafe/corrupt is never written.
      const invalid = checkRefinements(candidate, repoKey);
      if (invalid !== null) {
        throw new OperationConflict("IO_FAILURE", "refusing to commit a ledger that would not read back cleanly");
      }
      // E-P2C-2 — a rejection on an older-version ledger keeps the on-disk
      // shape at that version: the migrated tables are dropped and the
      // version literal stays at the persisted value, so the bump (with
      // its schema-migrated event) happens on the first successful commit
      // instead.
      let nextBytes: string;
      if (migratedFrom !== null && decided.ok === false) {
        const persistedShape = persistedLedgerShape(candidate, migratedFrom);
        const persistedParses = LEDGER_SCHEMAS[migratedFrom].safeParse(persistedShape).success;
        if (!persistedParses) {
          throw new OperationConflict("IO_FAILURE", "refusing to commit a ledger that would not read back cleanly");
        }
        nextBytes = JSON.stringify(persistedShape, null, 2) + "\n";
      } else {
        if (!LedgerSchema.safeParse(candidate).success) {
          throw new OperationConflict("IO_FAILURE", "refusing to commit a ledger that would not read back cleanly");
        }
        nextBytes = JSON.stringify(candidate, null, 2) + "\n";
      }
      // The serialized-byte cap is the durable bound: read() classifies a
      // ledger file above LEDGER_LIMITS.ledgerBytes as corrupt, so a commit
      // that would push past it is refused BEFORE any durable write — an
      // oversized file would silently drop every acknowledged mutation. The
      // rejection is unrecorded (a record is itself part of the bytes).
      const nextSize = Buffer.byteLength(nextBytes, "utf8");
      if (nextSize > LEDGER_LIMITS.ledgerBytes) {
        return invalidRecord(
          `the committed ledger would be ${nextSize} bytes — over the ${LEDGER_LIMITS.ledgerBytes}-byte cap`,
          "maintenance compaction required before more desk mutations",
        );
      }
      if (eventSeqs !== null) {
        const evDir = repoPaths(repoKey).eventsDir;
        ensurePrivateDirectory(evDir, platform);
        const segmentPath = join(evDir, `${eventSeqs[0]}-${eventSeqs[1]}.jsonl`);
        const temp = `${segmentPath}.${uuid()}.tmp`;
        let fd: number | null = null;
        try {
          fd = openSync(temp, "wx", PRIVATE_FILE_MODE);
          writeSync(fd, built.map(event => JSON.stringify(event)).join("\n") + "\n");
          fsyncSync(fd);
          closeSync(fd);
          fd = null;
          // c2 — temp segment durable, not yet renamed.
          await faults.segmentTempWritten?.();
          renameSync(temp, segmentPath);
          fsyncDirectory(evDir, platform);
          // c3 — segment renamed (durable), ledger not yet committed.
          await faults.segmentRenamed?.();
        } catch (error) {
          if (fd !== null) {
            try {
              closeSync(fd);
            } catch {
              // already closing on the failure path
            }
          }
          rmSync(temp, { force: true });
          if (error instanceof OperationConflict) throw error;
          throw new OperationConflict("IO_FAILURE", `event segment write failed: ${summarize(error)}`);
        }
      }
      const commitPaths = repoPaths(repoKey);
      atomicWrite(commitPaths.ledgerPath, nextBytes, commitPaths.repoDir);
      // c4 — the commit point passed; only release and the reply remain.
      await faults.ledgerCommitted?.();

      if (decided.ok === false) return decided;
      return {
        ok: true,
        receipt: { receiptId, revision, replayed: false, eventSeqs },
      };
    } finally {
      releaseLock(repoKey);
    }
  }

  async function transact(repoKey: string, envelope: unknown, decide: DecideFunction): Promise<TransactResult> {
    try {
      // Caller-error validation precedes the mutex and the lock: a
      // malformed envelope never touches the store.
      if (typeof repoKey !== "string" || !REPO_KEY_PATTERN.test(repoKey)) {
        return invalidRecord(`repoKey must match ${REPO_KEY_PATTERN.source}`);
      }
      const parsed = EnvelopeSchema.safeParse(envelope);
      if (!parsed.success) {
        return invalidRecord(`invalid envelope: ${firstIssue(parsed.error)}`);
      }
      const env = parsed.data;
      if (repoKeyFor(env.repo) !== repoKey) {
        return invalidRecord("repoKey does not equal repoKeyFor(envelope.repo)");
      }
      let bodySha256: string;
      try {
        bodySha256 = canonicalSha256({ repo: env.repo, command: env.command });
      } catch (error) {
        return invalidRecord(`envelope repo/command is not canonicalizable JSON: ${summarize(error)}`);
      }
      if (unsafeAncestors(repoKey)) {
        return rejection(
          "STATE_UNREADABLE",
          "desk ledger path is not safe (symlinked or non-directory ancestor)",
          "restore a real directory path under maintenance authority",
        );
      }

      // §4 step 1 — the in-process mutex serializes commits per repoKey.
      const prior = mutex.get(repoKey) ?? Promise.resolve();
      const run = prior.then(async () => {
        const result = await commit(repoKey, env, decide, bodySha256);
        // c5 — after the lock release that closed commit(); a crash here is
        // indistinguishable from one at c4: the commit is durable either way.
        await faults.afterComplete?.();
        return result;
      });
      const tracked = run.then(
        () => undefined,
        () => undefined,
      );
      mutex.set(repoKey, tracked);
      void tracked.finally(() => {
        if (mutex.get(repoKey) === tracked) mutex.delete(repoKey);
      });
      return await run;
    } catch (error) {
      if (error instanceof OperationConflict) throw error;
      throw new OperationConflict("IO_FAILURE", `desk transact failed: ${summarize(error)}`);
    }
  }

  return { read, transact };
}
