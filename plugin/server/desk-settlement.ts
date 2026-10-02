// plugin/server/desk-settlement.ts — the P3-b settlement mirror.
//
// Commands (decide is pure — no ids, clocks, or IO inside):
//   settlement.record — the receiving owner's immutable attestation
//     revision: delivery/rework-closure/sink pointers, resource
//     dispositions, internal handback/candidate refs, the timeline block,
//     and the owner-claimed `at` — bound to the durable assignment and
//     the settled seat, never to a live identity claim.
//
// The desk is evidence storage, not the official settlement sink: nothing
// here writes a tracker, notebook or any external system, and a committed
// row never asserts acceptance — `status` is the decide-computed
// disposition (completed | partial | blocked) at commit time, with every
// missing prerequisite recorded as a durable gap. The exported v1 record
// (slp_settlement_export) re-derives exactly the fields the row committed
// under; the owner places it in an authorized sink itself.
//
// Authority: only the assignment's durable owner may record — the actor
// resolves to a live bound lead membership server-side, and the settled
// seat must be attached to that assignment. Internal refs resolve against
// THIS seat's rows on THIS assignment, so a settlement can never rebind a
// foreign handback or candidate as its provenance. `decisionRef` is
// claimed/external only — no P4 machinery exists to resolve it.
//
// A claimed `timeline.export` pointer is only evidence once the
// server-side artifact seam proves it under the desk's bound repository
// root (P3-b R1): the runner resolves the claim through the injected
// verifier and attaches the verdict to the command body, decide consumes
// the verdict — never the bytes. Disproven claims reject; an unverifiable
// one commits as claimed-only with a durable gap and can never read
// `completed`.
//
// Idempotency rides the store unchanged: the command body carries only
// owner input plus the server-derived actor id, so a same-body replay
// returns the recorded receipt and a different body under the same request
// key is IDEMPOTENCY_CONFLICT. The settlementId is derived inside decide
// from the request key, so a replay names the same row.

import { z } from "zod";
import { Time } from "../shared/contracts.ts";
import {
  SETTLEMENT_RESOURCE_DISPOSITIONS,
  WIRE_LIMITS,
  type DeskRejectionValue,
  type DeskSettlementExportInputValue,
  type DeskSettlementRecordInputValue,
} from "../shared/enforcement.ts";
import { ROLES } from "../shared/runtime/families.ts";
import { deriveId, requireActor as requireDeskActor, requireLead as requireDeskLead } from "./desk-command.ts";
import {
  LEDGER_LIMITS,
  type LedgerValue,
  type MembershipValue,
  type SettlementValue,
} from "./desk-store.ts";
import { isRejection, readLedger, repoEnvelope, type DeskRunnerDeps, type RunnerCtx } from "./desk-runner.ts";
import { SETTLEMENT_VIA, validateReportRecordV1 } from "./desk-records.ts";

// ---------------------------------------------------------------------------
// Command schemas — parsed inside decide (the store's command slot is an
// opaque JsonObject; the kind dispatch here is the command catalog).
// ---------------------------------------------------------------------------

const CommandId = z.string().min(1).max(LEDGER_LIMITS.idLen);
const AgentIdField = z.string().min(1).max(WIRE_LIMITS.agentId);
const Pointer = z.string().min(1).max(WIRE_LIMITS.deskSettlementPointer);

/** The settlement timeline block — `via` is validated against the closed
 *  SETTLEMENT_VIA vocabulary here (server-side; the wire schema carries a
 *  bounded string because shared code cannot import this enum). */
const SettlementTimelineCommand = z
  .object({
    nativeHandle: z.string().min(1).max(WIRE_LIMITS.deskTimelineField).nullable(),
    sessionId: z.string().min(1).max(WIRE_LIMITS.deskTimelineField).nullable(),
    via: z.enum(SETTLEMENT_VIA),
    export: z
      .object({
        path: z.string().min(1).max(WIRE_LIMITS.deskExportPath),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    gap: z.string().min(1).max(WIRE_LIMITS.gapLen).nullable(),
  })
  .strict();

const SettlementResourceCommand = z
  .object({
    ref: Pointer,
    disposition: z.enum(SETTLEMENT_RESOURCE_DISPOSITIONS),
  })
  .strict();

/** The artifact-seam verdict the runner computes over a claimed
 *  `timeline.export` and attaches to the command body — riding the
 *  envelope hash keeps a replay bound to the verdict it committed under.
 *  `verified`/`absent`/`outside-root`/`mismatch` are definitive outcomes;
 *  `unavailable` means the seam itself could not prove anything. */
const ExportVerificationCommand = z
  .object({
    status: z.enum(["verified", "absent", "outside-root", "mismatch", "unavailable"]),
    detail: z.string().min(1).max(WIRE_LIMITS.gapLen).nullable(),
  })
  .strict()
  .nullable();

const SettlementRecordCommand = z
  .object({
    kind: z.literal("settlement.record"),
    requestId: CommandId,
    actorAgentId: AgentIdField,
    assignmentId: CommandId,
    seatAgentId: AgentIdField,
    seatTitle: z.string().min(1).max(WIRE_LIMITS.deskSettlementTitle),
    at: Time,
    deliveryRef: Pointer.nullable(),
    reworkClosureRef: Pointer.nullable(),
    sinkRef: Pointer.nullable(),
    decisionRef: Pointer.nullable(),
    handbackRefs: z.array(CommandId).max(WIRE_LIMITS.deskSettlementRefs),
    candidateRefs: z.array(CommandId).max(WIRE_LIMITS.deskSettlementRefs),
    resources: z.array(SettlementResourceCommand).max(WIRE_LIMITS.deskSettlementResources),
    timeline: SettlementTimelineCommand,
    exportVerification: ExportVerificationCommand,
  })
  .strict();

const DeskSettlementCommand = z.discriminatedUnion("kind", [SettlementRecordCommand]);

type DecideOutcome =
  | {
      ok: true;
      events: { kind: string; payload: Record<string, unknown> }[];
      settlements?: SettlementValue[];
    }
  | DeskRejectionValue;

const reject = (code: DeskRejectionValue["code"], message: string, recovery: string): DeskRejectionValue => ({
  ok: false,
  code,
  message,
  recovery,
});

const ok = (events: { kind: string; payload: Record<string, unknown> }[], tables: Partial<DecideOutcome & { ok: true }> = {}): DecideOutcome => ({
  ok: true,
  events,
  ...tables,
});

function requireActor(
  ledger: Readonly<LedgerValue>,
  agentId: string,
): MembershipValue | DeskRejectionValue {
  return requireDeskActor(ledger, agentId, "a settlement commit needs a host-bound, registered lead row");
}

function requireLead(actor: MembershipValue): DeskRejectionValue | null {
  return requireDeskLead(
    actor,
    `role ${JSON.stringify(actor.role)} may not record settlement — the receiving owner holds a bound lead membership`,
    `the ${ROLES.join("/")} role pin is a durable membership field, not a claim`,
  );
}

// ---------------------------------------------------------------------------
// decide — synchronous and pure.
// ---------------------------------------------------------------------------

export function decideDeskSettlement(ledger: Readonly<LedgerValue>, command: Record<string, unknown>): DecideOutcome {
  const parsed = DeskSettlementCommand.safeParse(command);
  if (!parsed.success) {
    return reject("INVALID_RECORD", "command does not match any desk-settlement command schema", "commands are strict JSON objects with a kind discriminator");
  }
  const cmd = parsed.data;

  const actor = requireActor(ledger, cmd.actorAgentId);
  if ("ok" in actor) return actor;
  const leadError = requireLead(actor);
  if (leadError !== null) return leadError;
  const assignment = ledger.assignments.find(a => a.assignmentId === cmd.assignmentId);
  if (assignment === undefined) {
    return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "a settlement settles a durable assignment binding");
  }
  if (assignment.ownerAgentId !== actor.agentId) {
    return reject(
      "AUTHORITY_REQUIRED",
      "only the assignment's receiving owner may record settlement",
      "the registering lead's agentId is bound into the row — a peer, another lead, or a supervisor cannot settle it",
    );
  }
  const seat = assignment.seats.find(s => s.agentId === cmd.seatAgentId);
  if (seat === undefined) {
    return reject(
      "INVALID_RECORD",
      "seatAgentId is not bound to this assignment",
      "a settlement names a seat the owner attached — cross-assignment and unbound seats are not settleable",
    );
  }
  // The refinement layer guarantees this link; decide still resolves it so
  // the row's denormalized provider is the durable membership's value, not
  // anything the caller claimed.
  const seatRow = ledger.memberships.find(m => m.membershipId === seat.membershipId);
  if (seatRow === undefined || seatRow.agentId !== cmd.seatAgentId) {
    return reject(
      "INVALID_RECORD",
      "the seat's membership row does not carry the claimed agentId",
      "the seat binding is corrupt — inspect the desk under maintenance authority",
    );
  }
  // Internal refs resolve against THIS seat's rows on THIS assignment —
  // a handback or candidate from another seat or another assignment is a
  // rebind attempt, never valid provenance.
  for (const ref of cmd.handbackRefs) {
    const hb = ledger.handbacks.find(h => h.handbackId === ref);
    if (hb === undefined || hb.assignmentId !== cmd.assignmentId || hb.agentId !== cmd.seatAgentId) {
      return reject(
        "INVALID_RECORD",
        `handbackRef ${JSON.stringify(ref)} does not resolve to this seat's revision on this assignment`,
        "handbackRefs name durable revisions the settled seat submitted on this assignment",
      );
    }
  }
  for (const ref of cmd.candidateRefs) {
    const candidate = ledger.candidates.find(c => c.candidateId === ref);
    if (candidate === undefined || candidate.assignmentId !== cmd.assignmentId || candidate.seatAgentId !== cmd.seatAgentId) {
      return reject(
        "INVALID_RECORD",
        `candidateRef ${JSON.stringify(ref)} does not resolve to this seat's observed candidate on this assignment`,
        "candidateRefs name durable candidates the settled seat's handbacks observed on this assignment",
      );
    }
  }
  if (
    new Set(cmd.handbackRefs).size !== cmd.handbackRefs.length ||
    new Set(cmd.candidateRefs).size !== cmd.candidateRefs.length ||
    new Set(cmd.resources.map(r => r.ref)).size !== cmd.resources.length
  ) {
    return reject("INVALID_RECORD", "refs/resource entries must be unique", "a duplicate pointer is malformed input, not two dispositions");
  }
  if (ledger.settlements.length >= LEDGER_LIMITS.settlements) {
    return reject("INVALID_RECORD", `settlements table is at the ${LEDGER_LIMITS.settlements} cap`, "the settlement table is bounded per repo desk");
  }

  // The transcript-export claim must carry the runner's artifact-seam
  // verdict (F-STD-P3B-1 / B5-B10): a claimed pointer is only evidence once
  // the seam proves the artifact under the bound repository root. A
  // disproven claim — absent, outside-root or content mismatch — is a
  // malformed attestation and rejects outright; `unavailable` means the
  // seam could not prove anything, so the claim commits as claimed-only
  // and can never ground `completed`.
  if (cmd.timeline.export === null) {
    if (cmd.exportVerification !== null) {
      return reject(
        "INVALID_RECORD",
        "exportVerification has no export claim to verify",
        "the runner attaches the seam verdict only when timeline.export is claimed",
      );
    }
  } else if (cmd.exportVerification === null) {
    return reject(
      "INVALID_RECORD",
      "a claimed transcript export requires the server-side verification verdict",
      "the record runner resolves the claim under the bound repository root before decide runs",
    );
  } else if (cmd.exportVerification.status !== "verified" && cmd.exportVerification.status !== "unavailable") {
    return reject(
      "INVALID_RECORD",
      `the claimed transcript export disproved under the bound repository root: ${cmd.exportVerification.status}`,
      "fix the pointer to an artifact that exists inside the repository worktree with matching sha256/bytes, or record the claim as export:null",
    );
  }

  // The derived v1 record is validated against the authoritative semantics
  // BEFORE commit — a durable row is schema-valid-by-construction, so an
  // export can never emit a record the records surface would reject.
  const record = buildSettlementRecordFields(cmd, seatRow.provider, actor.agentId as string);
  const validation = validateReportRecordV1(record);
  if (!validation.valid) {
    const first = validation.errors[0];
    const detail = first === undefined
      ? "derived settlement record is invalid"
      : `derived settlement record invalid: ${first.code}${first.field ? ` ${first.field}` : ""} — ${first.message}`;
    return reject("INVALID_RECORD", detail.slice(0, LEDGER_LIMITS.captureDetailLen), "fix the attestation fields against report-records v1 semantics and retry with a new requestId");
  }

  // Status is computed, never claimed: completed requires the owner's
  // delivery evidence, a closed correction/re-review pointer, every
  // resource disposition attested (none unknown) and the timeline honestly
  // covered — a VERIFIED export, or (when no export is claimed) a native
  // handle plus the recorded capability gap. A claimed export the seam
  // could not prove is claimed-only: it covers nothing and the revision
  // never reads completed, even beside an honest handle — the unproven
  // pointer itself is a durable gap. A missing delivery evidence means
  // blocked; any other missing prerequisite means partial. Nothing here
  // reads assignment state, idle signals or an accepted handback as proof
  // of completion.
  const gaps: string[] = [];
  const unknownResources = cmd.resources.filter(r => r.disposition === "unknown").length;
  const transcriptExportMissing = cmd.timeline.export === null;
  const exportProven =
    !transcriptExportMissing &&
    (cmd.exportVerification as { status: string }).status === "verified";
  const transcriptCovered = transcriptExportMissing
    ? (cmd.timeline.nativeHandle !== null && cmd.timeline.gap !== null)
    : exportProven;
  if (cmd.deliveryRef === null) gaps.push("delivery-evidence-missing");
  if (cmd.reworkClosureRef === null) gaps.push("rework-closure-evidence-missing");
  if (unknownResources > 0) gaps.push(`resource-dispositions-unknown:${unknownResources}`);
  if (cmd.sinkRef === null) gaps.push("sink-pointer-missing");
  if (transcriptExportMissing) gaps.push("transcript-export-unavailable");
  if (!transcriptExportMissing && !exportProven) gaps.push("transcript-export-unverified");
  if (cmd.decisionRef === null) gaps.push("decision-reference-missing");
  const status: SettlementValue["status"] =
    cmd.deliveryRef === null
      ? "blocked"
      : (cmd.reworkClosureRef === null || cmd.sinkRef === null || unknownResources > 0 || !transcriptCovered)
        ? "partial"
        : "completed";

  const ownerAgentId = actor.agentId as string;
  const settlementId = deriveId("stl", [ownerAgentId, cmd.assignmentId, cmd.seatAgentId, cmd.requestId]);
  const revision =
    ledger.settlements
      .filter(s => s.assignmentId === cmd.assignmentId && s.seatAgentId === cmd.seatAgentId)
      .reduce((max, s) => Math.max(max, s.revision), 0) + 1;
  const row: SettlementValue = {
    settlementId,
    assignmentId: cmd.assignmentId,
    requestId: cmd.requestId,
    revision,
    ownerMembershipId: actor.membershipId,
    ownerAgentId,
    seatAgentId: cmd.seatAgentId,
    seatMembershipId: seat.membershipId,
    seatProvider: seatRow.provider,
    seatTitle: cmd.seatTitle,
    at: cmd.at,
    deliveryRef: cmd.deliveryRef,
    reworkClosureRef: cmd.reworkClosureRef,
    sinkRef: cmd.sinkRef,
    decisionRef: cmd.decisionRef,
    handbackRefs: cmd.handbackRefs,
    candidateRefs: cmd.candidateRefs,
    resources: cmd.resources,
    timeline: cmd.timeline,
    exportVerification:
      cmd.timeline.export === null
        ? null
        : { status: cmd.exportVerification!.status as "verified" | "unavailable", detail: cmd.exportVerification!.detail },
    status,
    gaps,
  };
  return ok(
    [{
      kind: "settlement-recorded",
      payload: { settlementId, assignmentId: cmd.assignmentId, seatAgentId: cmd.seatAgentId, ownerAgentId, revision, status },
    }],
    { settlements: [...ledger.settlements, row] },
  );
}

// ---------------------------------------------------------------------------
// Export derivation — the v1 slp-record a committed row emits.
// ---------------------------------------------------------------------------

type SettlementCommandFields = {
  assignmentId: string;
  seatAgentId: string;
  seatTitle: string;
  at: string;
  timeline: SettlementValue["timeline"];
};

/** The v1 record fields shared by decide-time validation and export — task
 *  binds the settlement to the durable assignment slug, recordedBy is the
 *  server-derived owner, the seat block carries the durable provider plus
 *  the owner-claimed title/agentId, and the timeline rides verbatim. */
function buildSettlementRecordFields(
  source: SettlementCommandFields,
  seatProvider: string,
  ownerAgentId: string,
): Record<string, unknown> {
  return {
    version: 1,
    kind: "settlement",
    task: source.assignmentId,
    seat: { provider: seatProvider, title: source.seatTitle, agentId: source.seatAgentId },
    timeline: {
      nativeHandle: source.timeline.nativeHandle,
      sessionId: source.timeline.sessionId,
      via: source.timeline.via,
      export: source.timeline.export === null
        ? null
        : { path: source.timeline.export.path, sha256: source.timeline.export.sha256, bytes: source.timeline.export.bytes },
      gap: source.timeline.gap,
    },
    recordedBy: ownerAgentId,
    at: source.at,
  };
}

/** The exported v1 record of a committed settlement row — derived from the
 *  durable fields only; claimed pointer refs (delivery/sink/decision)
 *  belong to the desk row and are deliberately NOT part of the v1 record
 *  shape. */
export function buildSettlementRecord(row: SettlementValue): Record<string, unknown> {
  return buildSettlementRecordFields(row, row.seatProvider, row.ownerAgentId);
}

// ---------------------------------------------------------------------------
// Status projection — settlement rows per assignment, caller-scoped like
// seatAssignmentsView: the assignment's owner sees every row; a bound seat
// sees only the rows that settle its own seat. Identifiers and counts only.
// ---------------------------------------------------------------------------

export type StatusSettlement = {
  settlementId: string;
  seatAgentId: string;
  revision: number;
  status: "completed" | "partial" | "blocked";
  gapsCount: number;
  /** Whether the row's claimed transcript export verified under the bound
   *  repository root at commit time (false when none was claimed or the
   *  seam could not prove it). */
  exportVerified: boolean;
};

export function seatSettlementsView(
  ledger: Readonly<LedgerValue>,
  row: MembershipValue,
  limits: { settlements: number },
): { byAssignment: Map<string, StatusSettlement[]>; truncated: number } {
  const byAssignment = new Map<string, StatusSettlement[]>();
  let truncated = 0;
  for (const assignment of ledger.assignments) {
    const owner = assignment.ownerAgentId === row.agentId;
    const attached = assignment.seats.some(seat => seat.agentId === row.agentId);
    if (!owner && !attached) continue;
    const rows = ledger.settlements.filter(
      s => s.assignmentId === assignment.assignmentId && (owner || s.seatAgentId === row.agentId),
    );
    if (rows.length === 0) continue;
    if (rows.length > limits.settlements) truncated += 1;
    byAssignment.set(
      assignment.assignmentId,
      rows.slice(0, limits.settlements).map(s => ({
        settlementId: s.settlementId,
        seatAgentId: s.seatAgentId,
        revision: s.revision,
        status: s.status,
        gapsCount: s.gaps.length,
        exportVerified: s.exportVerification?.status === "verified",
      })),
    );
  }
  return { byAssignment, truncated };
}

// ---------------------------------------------------------------------------
// Handler orchestration — the bridge calls these from ToolDef.run. Each
// builds a pure-input envelope, commits through the store, then derives the
// response from the durable rows (a replayed record returns the same fields
// because the command body carries no generated ids or timestamps).
// ---------------------------------------------------------------------------

/** The artifact-seam verdict over a claimed `timeline.export` pointer.
 *  `verified` proves the artifact exists inside the bound repository
 *  worktree with matching sha256/bytes; `absent`/`outside-root`/
 *  `mismatch` disprove the claim and decide rejects; `unavailable` means
 *  the seam could not prove anything — the claim commits as claimed-only
 *  with a durable gap and can never ground `completed`. */
export type ExportVerification = {
  status: "verified" | "absent" | "outside-root" | "mismatch" | "unavailable";
  detail: string | null;
};

/** The authorized-artifact seam (P3-b R1): resolves the claim under the
 *  durable repo binding — the server-selected worktree root derived from
 *  `repo.gitCommonDir`, never a caller-supplied path — and proves
 *  existence + content. Production wires the FS implementation in the
 *  bridge; tests inject a structural double. */
export type ExportVerifier = (
  claim: { path: string; sha256: string; bytes: number },
  repo: { gitCommonDir: string },
) => Promise<ExportVerification>;

/** Recording verifies claimed exports through the injected artifact seam. */
export type SettlementRunnerDeps = DeskRunnerDeps & {
  verifyExport: ExportVerifier;
};

export type MutationOk = { ok: true; [key: string]: unknown };
export type SettlementOutcome = MutationOk | DeskRejectionValue;

export async function runSettlementRecord(
  ctx: RunnerCtx,
  input: DeskSettlementRecordInputValue,
  deps: SettlementRunnerDeps,
): Promise<SettlementOutcome> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  // The claimed transcript export resolves through the artifact seam
  // BEFORE the command is built — the verdict rides the command body so a
  // replayed envelope stays bound to the verdict it committed under, and
  // decide itself stays pure.
  const exportVerification = input.timeline.export === null
    ? null
    : await deps.verifyExport(input.timeline.export, ledger.repo);
  const command = {
    kind: "settlement.record",
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId,
    assignmentId: input.assignmentId,
    seatAgentId: input.seatAgentId,
    seatTitle: input.seatTitle,
    at: input.at,
    deliveryRef: input.deliveryRef,
    reworkClosureRef: input.reworkClosureRef,
    sinkRef: input.sinkRef,
    decisionRef: input.decisionRef,
    handbackRefs: input.handbackRefs,
    candidateRefs: input.candidateRefs,
    resources: input.resources,
    timeline: input.timeline,
    exportVerification,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskSettlement,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  // The response row resolves by the durable (assignmentId, ownerAgentId,
  // requestId) request key — never the live membershipId, which a rebind
  // replaces while the settlement keeps its original ownerMembershipId.
  const row = after.settlements.find(
    s => s.requestId === input.requestId && s.assignmentId === input.assignmentId && s.ownerAgentId === ctx.row.agentId,
  );
  if (row === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the settlement committed but its row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return {
    ok: true,
    settlementId: row.settlementId,
    revision: row.revision,
    receiptId: settled.receipt.receiptId,
    status: row.status,
    gaps: row.gaps,
    exportVerification: row.exportVerification,
  };
}

/** Explicit export — read-only, scoped: the receiving owner and the settled
 *  seat may re-derive the record; nobody else may observe the row. The
 *  derived record is re-validated against v1 semantics before it leaves —
 *  a durable row that would emit invalid is a producer fault, answered
 *  closed rather than exported. */
export async function runSettlementExport(
  ctx: RunnerCtx,
  input: DeskSettlementExportInputValue,
  deps: DeskRunnerDeps,
): Promise<SettlementOutcome> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const row = ledger.settlements.find(s => s.settlementId === input.settlementId);
  if (row === undefined) {
    return {
      ok: false,
      code: "AUTHORITY_REQUIRED",
      message: "the settlementId does not resolve on this desk",
      recovery: "export targets a committed settlement revision of this repo desk",
    };
  }
  if (row.ownerAgentId !== ctx.row.agentId && row.seatAgentId !== ctx.row.agentId) {
    return {
      ok: false,
      code: "AUTHORITY_REQUIRED",
      message: "only the receiving owner or the settled seat may export a settlement",
      recovery: "the export is scoped to the settlement's two parties — ask the owner",
    };
  }
  const record = buildSettlementRecord(row);
  const validation = validateReportRecordV1(record);
  if (!validation.valid) {
    return {
      ok: false,
      code: "CAPABILITY_GAP",
      message: "the durable settlement row no longer derives a schema-valid v1 record",
      recovery: "the desk mirror is inconsistent — inspect it under maintenance authority",
    };
  }
  return {
    ok: true,
    settlementId: row.settlementId,
    assignmentId: row.assignmentId,
    seatAgentId: row.seatAgentId,
    revision: row.revision,
    status: row.status,
    gaps: row.gaps,
    record,
    exportVerification: row.exportVerification,
  };
}
