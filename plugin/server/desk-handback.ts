// plugin/server/desk-handback.ts — the P3-a structured handback surface.
//
// Commands (decide is pure — no ids, clocks, or IO inside):
//   assignment.register  — lead-owned open binding; seats start empty
//   assignment.attach    — lead owner binds a live seat membership
//   assignment.close     — lead owner closes the binding; submits refuse
//   handback.submit      — a bound seat's claimed recordV1 commit; the row
//                          lands with observed.status 'pending' and only
//                          claim fields — the capture that follows runs in
//                          the handler, then handback.observe finalizes it
//   handback.observe     — the plugin's own measurement joins the row;
//                          writes `observed`/`gaps` only, never the claim
//
// Idempotency rides the store unchanged: every command carries only seat/
// operator input plus the server-derived actor id — no generated ids or
// timestamps — so a retry of the same input replays the recorded receipt
// verbatim and a different body under the same request key is a real
// IDEMPOTENCY_CONFLICT. Entity ids are derived deterministically inside
// decide (sha256 of the request key), and commit timestamps stay on the
// hash-chained events rather than the rows.
//
// The observed capture runs between the two commits, under the bound
// runtime — a bounded subprocess (60s / 32MiB, VERIFY_LIMITS parity) that
// imports the installed runtime's src/package.mjs snapshot(). Its outcome
// is fed back as command input; capture failure is recorded as `failed`
// plus a gaps entry, never a rejection of the handback.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { Time } from "../shared/contracts.ts";
import { WIRE_LIMITS, type DeskRejectionValue } from "../shared/enforcement.ts";
import { ROLES } from "../shared/families.ts";
import { canonicalJson, canonicalSha256, sha256Hex } from "./config-view.ts";
import {
  LEDGER_LIMITS,
  type AssignmentValue,
  type CandidateValue,
  type DeskStoreRead,
  type HandbackValue,
  type LedgerValue,
  type MembershipValue,
  type TransactResult,
} from "./desk-store.ts";
import { validateReportRecordV1 } from "./desk-records.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Command schemas — parsed inside decide (the store's command slot is an
// opaque JsonObject; the kind dispatch here is the command catalog).
// ---------------------------------------------------------------------------

const CommandId = z.string().min(1).max(LEDGER_LIMITS.idLen);
const AgentIdField = z.string().min(1).max(WIRE_LIMITS.agentId);
const AbsolutePath = z
  .string()
  .min(1)
  .max(LEDGER_LIMITS.pathLen)
  .refine(value => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
const GitHead = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
const JsonObject = z.record(z.string(), z.unknown()).refine(value => value !== null && !Array.isArray(value));

export const AssignmentRegisterCommand = z
  .object({
    kind: z.literal("assignment.register"),
    requestId: CommandId,
    actorAgentId: AgentIdField,
    authorityRef: z.string().min(1).max(LEDGER_LIMITS.authorityRefLen),
    objective: z.string().min(1).max(LEDGER_LIMITS.objectiveLen).nullable(),
  })
  .strict();

export const AssignmentAttachCommand = z
  .object({
    kind: z.literal("assignment.attach"),
    requestId: CommandId,
    actorAgentId: AgentIdField,
    assignmentId: CommandId,
    agentId: AgentIdField,
  })
  .strict();

export const AssignmentCloseCommand = z
  .object({
    kind: z.literal("assignment.close"),
    requestId: CommandId,
    actorAgentId: AgentIdField,
    assignmentId: CommandId,
  })
  .strict();

export const HandbackSubmitCommand = z
  .object({
    kind: z.literal("handback.submit"),
    requestId: CommandId,
    actorAgentId: AgentIdField,
    assignmentId: CommandId,
    recordV1: JsonObject,
    candidateId: CommandId.nullable(),
  })
  .strict();

/** The plugin-side measurement a submit hands back. `ok` carries the
 *  snapshot fields; `failed` carries a bounded reason/detail pair — the
 *  subprocess's raw stdout/stderr is never recorded, only the classified
 *  outcome. */
export const ObservedCapture = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      repository: AbsolutePath,
      measuredAt: Time,
      snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
      head: GitHead.nullable(),
      incomplete: z.array(z.string().min(1).max(LEDGER_LIMITS.pathLen)).max(LEDGER_LIMITS.snapshotIncomplete),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      repository: AbsolutePath,
      measuredAt: Time,
      reason: z.enum(["spawn-failed", "timeout", "exit", "byte-cap", "invalid-output"]),
      detail: z.string().min(1).max(LEDGER_LIMITS.captureDetailLen),
    })
    .strict(),
]);
export type ObservedCaptureValue = z.infer<typeof ObservedCapture>;

export const HandbackObserveCommand = z
  .object({
    kind: z.literal("handback.observe"),
    requestId: CommandId,
    actorAgentId: AgentIdField,
    handbackId: CommandId,
    capture: ObservedCapture,
  })
  .strict();

const DeskHandbackCommand = z.discriminatedUnion("kind", [
  AssignmentRegisterCommand,
  AssignmentAttachCommand,
  AssignmentCloseCommand,
  HandbackSubmitCommand,
  HandbackObserveCommand,
]);

type DecideOutcome =
  | {
      ok: true;
      events: { kind: string; payload: Record<string, unknown> }[];
      assignments?: AssignmentValue[];
      candidates?: CandidateValue[];
      handbacks?: HandbackValue[];
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

/** Entity ids are deterministic — derived inside the pure decide from the
 *  request key, so a replayed command always names the same row. Parts are
 *  canonical-JSON encoded before hashing: bare concatenation aliases
 *  distinct tuples (["ab","c"] and ["a","bc"] both hash "abc"). Rows keep
 *  their stored id forever — response resolvers locate rows by the durable
 *  request fields, never by re-deriving a legacy id. */
function deriveId(prefix: "asg" | "hb" | "cand", parts: string[]): string {
  return `${prefix}-${sha256Hex(canonicalJson(parts)).slice(0, 32)}`;
}

/** The caller's live bound+registered membership for an agentId — the
 *  decide-side authority check, mirroring the bridge's freshRow semantics
 *  (host-bound, registered, unrevoked). */
function liveMembership(ledger: Readonly<LedgerValue>, agentId: string): MembershipValue | undefined {
  return ledger.memberships.find(
    row => row.agentId === agentId && row.state !== "revoked" && row.registeredAt !== null,
  );
}

function requireActor(
  ledger: Readonly<LedgerValue>,
  agentId: string,
): MembershipValue | DeskRejectionValue {
  const actor = liveMembership(ledger, agentId);
  if (actor === undefined) {
    return reject(
      "AUTHORITY_REQUIRED",
      "the actor has no live bound membership on this desk",
      "a handback commit needs a host-bound, registered seat row",
    );
  }
  return actor;
}

function requireLead(actor: MembershipValue): DeskRejectionValue | null {
  if (actor.role !== "lead") {
    return reject(
      "AUTHORITY_REQUIRED",
      `role ${JSON.stringify(actor.role)} may not administer assignments — a bound lead membership is required`,
      `the ${ROLES.join("/")} role pin is a durable membership field, not a claim`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// decide — synchronous and pure.
// ---------------------------------------------------------------------------

export function decideDeskHandback(ledger: Readonly<LedgerValue>, command: Record<string, unknown>): DecideOutcome {
  const parsed = DeskHandbackCommand.safeParse(command);
  if (!parsed.success) {
    return reject("INVALID_RECORD", "command does not match any desk-handback command schema", "commands are strict JSON objects with a kind discriminator");
  }
  const cmd = parsed.data;

  if (cmd.kind === "assignment.register") {
    const actor = requireActor(ledger, cmd.actorAgentId);
    if ("ok" in actor) return actor;
    const leadError = requireLead(actor);
    if (leadError !== null) return leadError;
    if (ledger.assignments.length >= LEDGER_LIMITS.assignments) {
      return reject("INVALID_RECORD", `assignments table is at the ${LEDGER_LIMITS.assignments} cap`, "close finished assignments before registering more");
    }
    const assignmentId = deriveId("asg", [actor.agentId as string, cmd.requestId]);
    if (ledger.assignments.some(a => a.assignmentId === assignmentId)) {
      return reject("INVALID_RECORD", "derived assignmentId already exists on this desk", "requestId reuse with a different body is an idempotency conflict upstream");
    }
    const row: AssignmentValue = {
      assignmentId,
      requestId: cmd.requestId,
      authorityRef: cmd.authorityRef,
      objective: cmd.objective,
      ownerMembershipId: actor.membershipId,
      ownerAgentId: actor.agentId as string,
      workspaceId: actor.workspaceId,
      state: "open",
      seats: [],
    };
    return ok(
      [{ kind: "assignment-registered", payload: { assignmentId, ownerAgentId: row.ownerAgentId, authorityRef: row.authorityRef } }],
      { assignments: [...ledger.assignments, row] },
    );
  }

  if (cmd.kind === "assignment.attach") {
    const actor = requireActor(ledger, cmd.actorAgentId);
    if ("ok" in actor) return actor;
    const leadError = requireLead(actor);
    if (leadError !== null) return leadError;
    const assignment = ledger.assignments.find(a => a.assignmentId === cmd.assignmentId);
    if (assignment === undefined) {
      return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "assignment bindings are created by a lead register, never by peers");
    }
    if (assignment.ownerAgentId !== actor.agentId) {
      return reject("AUTHORITY_REQUIRED", "only the assignment owner may attach seats", "the registering lead's agentId is bound into the row");
    }
    if (assignment.state !== "open") {
      return reject("AUTHORITY_REQUIRED", "the assignment is closed", "closed assignments take no new seat bindings");
    }
    if (assignment.seats.some(seat => seat.agentId === cmd.agentId)) {
      return ok([]); // idempotent: the seat is already bound
    }
    const target = liveMembership(ledger, cmd.agentId);
    if (target === undefined) {
      return reject("INVALID_RECORD", `no live bound membership for agentId ${JSON.stringify(cmd.agentId)}`, "attach targets a live seat row on the same desk");
    }
    if (assignment.seats.length >= LEDGER_LIMITS.assignmentSeats) {
      return reject("INVALID_RECORD", `assignment seats are at the ${LEDGER_LIMITS.assignmentSeats} cap`, "the seat table is bounded per assignment");
    }
    const seat = { agentId: target.agentId as string, membershipId: target.membershipId };
    const assignments = ledger.assignments.map(a =>
      a.assignmentId === cmd.assignmentId ? { ...a, seats: [...a.seats, seat] } : a,
    );
    return ok(
      [{ kind: "assignment-seat-attached", payload: { assignmentId: cmd.assignmentId, agentId: seat.agentId, membershipId: seat.membershipId } }],
      { assignments },
    );
  }

  if (cmd.kind === "assignment.close") {
    const actor = requireActor(ledger, cmd.actorAgentId);
    if ("ok" in actor) return actor;
    const leadError = requireLead(actor);
    if (leadError !== null) return leadError;
    const assignment = ledger.assignments.find(a => a.assignmentId === cmd.assignmentId);
    if (assignment === undefined) {
      return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "close targets a registered assignment");
    }
    if (assignment.ownerAgentId !== actor.agentId) {
      return reject("AUTHORITY_REQUIRED", "only the assignment owner may close it", "the registering lead's agentId is bound into the row");
    }
    if (assignment.state === "closed") {
      return ok([]); // idempotent
    }
    const assignments = ledger.assignments.map(a =>
      a.assignmentId === cmd.assignmentId ? { ...a, state: "closed" as const } : a,
    );
    return ok([{ kind: "assignment-closed", payload: { assignmentId: cmd.assignmentId } }], { assignments });
  }

  if (cmd.kind === "handback.submit") {
    const actor = requireActor(ledger, cmd.actorAgentId);
    if ("ok" in actor) return actor;
    const assignment = ledger.assignments.find(a => a.assignmentId === cmd.assignmentId);
    if (assignment === undefined) {
      return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "a seat submits only against a durable assignment binding");
    }
    if (assignment.state !== "open") {
      return reject("AUTHORITY_REQUIRED", "the assignment is closed", "closed assignments take no new handback revisions");
    }
    if (!assignment.seats.some(seat => seat.agentId === actor.agentId)) {
      return reject("AUTHORITY_REQUIRED", "this seat is not bound to the assignment", "the assignment owner attaches seats; a seat submits only for its own binding");
    }
    const validation = validateReportRecordV1(cmd.recordV1);
    if (!validation.valid) {
      const first = validation.errors[0];
      const detail = first === undefined
        ? "recordV1 is invalid"
        : `recordV1 invalid: ${first.code}${first.field ? ` ${first.field}` : ""} — ${first.message}`;
      return reject("INVALID_RECORD", detail.slice(0, LEDGER_LIMITS.captureDetailLen), "fix the record against report-records semantics and retry with a new requestId");
    }
    if (cmd.recordV1.kind !== "handback") {
      return reject("INVALID_RECORD", "recordV1.kind must be handback on this surface", "settlement records are a different slice (P3-b)");
    }
    let recordBytes: number;
    try {
      recordBytes = Buffer.byteLength(canonicalJson(cmd.recordV1), "utf8");
    } catch {
      return reject("INVALID_RECORD", "recordV1 is not canonicalizable JSON", "the record must be a plain JSON object");
    }
    if (recordBytes > LEDGER_LIMITS.handbackRecordBytes) {
      return reject("INVALID_RECORD", `recordV1 is ${recordBytes} canonical bytes, over the ${LEDGER_LIMITS.handbackRecordBytes} cap`, "move large evidence to outputRef and keep the record under the cap");
    }
    if (cmd.candidateId !== null) {
      const resolved = ledger.candidates.find(c => c.candidateId === cmd.candidateId && c.assignmentId === cmd.assignmentId);
      if (resolved === undefined) {
        return reject("INVALID_RECORD", "candidateId does not resolve to a candidate of this assignment", "candidateId is null or a durable candidateId produced by this assignment's observed capture");
      }
    }
    if (ledger.handbacks.length >= LEDGER_LIMITS.handbacks) {
      return reject("INVALID_RECORD", `handbacks table is at the ${LEDGER_LIMITS.handbacks} cap`, "the handback table is bounded per repo desk");
    }
    const agentId = actor.agentId as string;
    const handbackId = deriveId("hb", [agentId, cmd.assignmentId, cmd.requestId]);
    const revision =
      ledger.handbacks.filter(h => h.assignmentId === cmd.assignmentId && h.agentId === agentId)
        .reduce((max, h) => Math.max(max, h.revision), 0) + 1;
    const gaps = validation.warnings
      .map(w => `record-warning:${w.code}`)
      .slice(0, LEDGER_LIMITS.handbackGaps);
    const row: HandbackValue = {
      handbackId,
      assignmentId: cmd.assignmentId,
      agentId,
      seatMembershipId: actor.membershipId,
      requestId: cmd.requestId,
      revision,
      record: cmd.recordV1,
      recordSha256: canonicalSha256(cmd.recordV1),
      claimedCandidateId: cmd.candidateId,
      observed: {
        status: "pending",
        candidateId: null,
        repository: actor.createCwd,
        measuredAt: null,
        error: null,
      },
      gaps,
    };
    return ok(
      [{
        kind: "handback-submitted",
        payload: {
          handbackId,
          assignmentId: cmd.assignmentId,
          agentId,
          revision,
          recordSha256: row.recordSha256,
          claimedCandidateId: cmd.candidateId,
        },
      }],
      { handbacks: [...ledger.handbacks, row] },
    );
  }

  // handback.observe — the plugin's measurement joins the committed claim.
  const actor = requireActor(ledger, cmd.actorAgentId);
  if ("ok" in actor) return actor;
  const handback = ledger.handbacks.find(h => h.handbackId === cmd.handbackId);
  if (handback === undefined) {
    return reject("INVALID_RECORD", "unknown handbackId", "observe targets a committed handback row");
  }
  if (handback.agentId !== actor.agentId) {
    return reject("AUTHORITY_REQUIRED", "the handback belongs to another seat", "observations join only the submitting seat's row");
  }
  if (handback.observed.status !== "pending") {
    return ok([]); // convergent: an observation is already recorded
  }
  if (cmd.capture.repository !== handback.observed.repository) {
    return reject("INVALID_RECORD", "observed repository does not match the bound capture root", "the measured root is the seat's bound createCwd, never a claimed path");
  }
  if (cmd.capture.status === "failed") {
    const error = `${cmd.capture.reason}: ${cmd.capture.detail}`.slice(0, LEDGER_LIMITS.captureDetailLen);
    const gaps = [...handback.gaps, `observed-capture-failed:${cmd.capture.reason}`].slice(0, LEDGER_LIMITS.handbackGaps);
    const observed: HandbackValue["observed"] = {
      status: "failed",
      candidateId: null,
      repository: cmd.capture.repository,
      measuredAt: cmd.capture.measuredAt,
      error,
    };
    const handbacks = ledger.handbacks.map(h =>
      h.handbackId === cmd.handbackId ? { ...h, observed, gaps } : h,
    );
    return ok(
      [{ kind: "handback-observed", payload: { handbackId: cmd.handbackId, status: "failed" } }],
      { handbacks },
    );
  }
  if (ledger.candidates.length >= LEDGER_LIMITS.candidates) {
    return reject("INVALID_RECORD", `candidates table is at the ${LEDGER_LIMITS.candidates} cap`, "the candidate table is bounded per repo desk");
  }
  const candidateId = deriveId("cand", [cmd.handbackId]);
  const candidate: CandidateValue = {
    candidateId,
    assignmentId: handback.assignmentId,
    kind: "observed",
    seatAgentId: handback.agentId,
    seatMembershipId: handback.seatMembershipId,
    repository: cmd.capture.repository,
    snapshotSha256: cmd.capture.snapshotSha256,
    head: cmd.capture.head,
    incomplete: cmd.capture.incomplete,
    measuredAt: cmd.capture.measuredAt,
  };
  const observed: HandbackValue["observed"] = {
    status: "ok",
    candidateId,
    repository: cmd.capture.repository,
    measuredAt: cmd.capture.measuredAt,
    error: null,
  };
  const handbacks = ledger.handbacks.map(h =>
    h.handbackId === cmd.handbackId ? { ...h, observed } : h,
  );
  return ok(
    [
      { kind: "candidate-captured", payload: { candidateId, handbackId: cmd.handbackId, snapshotSha256: candidate.snapshotSha256, head: candidate.head } },
      { kind: "handback-observed", payload: { handbackId: cmd.handbackId, status: "ok", candidateId } },
    ],
    { handbacks, candidates: [...ledger.candidates, candidate] },
  );
}

// ---------------------------------------------------------------------------
// Observed capture — the bound-runtime snapshot subprocess (contract X4):
// 60s timeout, 32MiB output cap, minimal env (no ambient secrets), and a
// typed outcome vocabulary. Only the classified fields are ever recorded;
// raw process output stays inside the child.
// ---------------------------------------------------------------------------

export type CaptureDeps = {
  nodePath: string;
  runtimePath: string;
  repository: string;
  now: () => Date;
  exec?: typeof execFileAsync;
};

const CAPTURE_SCRIPT = [
  'const spec = process.env.SLP_CAPTURE_SPEC;',
  'const repository = process.env.SLP_CAPTURE_REPO;',
  'import(spec).then(mod => {',
  '  const s = mod.snapshot(repository);',
  '  process.stdout.write(JSON.stringify({ sha256: s.sha256, head: s.head ?? null, incomplete: s.incomplete ?? [] }));',
  '}).catch(error => {',
  '  process.stderr.write(String(error && error.message ? error.message : error).slice(0, 512));',
  '  process.exit(2);',
  '});',
].join("\n");

export async function captureSeatSnapshot(deps: CaptureDeps): Promise<ObservedCaptureValue> {
  const { nodePath, runtimePath, repository, now } = deps;
  const exec = deps.exec ?? execFileAsync;
  const measuredAt = () => now().toISOString();
  const spec = pathToFileURL(join(runtimePath, "src", "package.mjs")).href;
  const fail = (reason: "spawn-failed" | "timeout" | "exit" | "byte-cap" | "invalid-output", detail: string): ObservedCaptureValue => ({
    status: "failed",
    repository,
    measuredAt: measuredAt(),
    reason,
    detail: detail.slice(0, LEDGER_LIMITS.captureDetailLen),
  });
  let stdout: string;
  try {
    const result = await exec(
      nodePath,
      ["--input-type", "module", "--eval", CAPTURE_SCRIPT],
      {
        timeout: LEDGER_LIMITS.captureTimeoutMs,
        maxBuffer: LEDGER_LIMITS.captureMaxBytes,
        windowsHide: true,
        cwd: repository,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          SLP_CAPTURE_SPEC: spec,
          SLP_CAPTURE_REPO: repository,
        },
      },
    );
    stdout = result.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
    if (err.code === "ENOBUFS" || /maxBuffer/i.test(err.message ?? "")) return fail("byte-cap", "capture output exceeded the 32MiB cap");
    if (err.killed === true || typeof err.signal === "string") return fail("timeout", `capture exceeded the ${LEDGER_LIMITS.captureTimeoutMs}ms bound`);
    if (typeof err.code === "number") return fail("exit", `capture exited ${err.code}: ${(err.message ?? "").split("\n")[0]}`);
    return fail("spawn-failed", `${String(err.code ?? "spawn-error")}: ${(err.message ?? "").split("\n")[0]}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail("invalid-output", "capture produced no parseable JSON");
  }
  const outcome = z
    .object({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      head: GitHead.nullable(),
      incomplete: z.array(z.string().min(1).max(LEDGER_LIMITS.pathLen)).max(LEDGER_LIMITS.snapshotIncomplete),
    })
    .strict()
    .safeParse(parsed);
  if (!outcome.success) return fail("invalid-output", "capture output failed the snapshot fields schema");
  return {
    status: "ok",
    repository,
    measuredAt: measuredAt(),
    snapshotSha256: outcome.data.sha256,
    head: outcome.data.head,
    incomplete: outcome.data.incomplete,
  };
}

// ---------------------------------------------------------------------------
// Status projection — the caller-scoped assignments/handbacks view (X7).
// A lead sees its owned assignments with every handback; any other bound
// seat sees only assignments it is attached to and only its own rows.
// ---------------------------------------------------------------------------

export type StatusHandback = {
  handbackId: string;
  agentId: string;
  revision: number;
  recordSha256: string;
  claimedCandidateId: string | null;
  observedStatus: "pending" | "ok" | "failed";
  observedCandidateId: string | null;
  gapsCount: number;
};

export type StatusAssignment = {
  assignmentId: string;
  state: "open" | "closed";
  ownerAgentId: string;
  seats: string[];
  handbacks: StatusHandback[];
};

export function seatAssignmentsView(
  ledger: Readonly<LedgerValue>,
  row: MembershipValue,
  limits: { assignments: number; seats: number; handbacks: number },
): { assignments: StatusAssignment[]; limitations: string[] } {
  // Elision is reported as one counting marker per cap class, never one line
  // per dropped row — the wire schema caps the limitations array itself, so
  // a saturated projection must still produce a schema-valid status view.
  const owned = row.role === "lead";
  const relevant = ledger.assignments.filter(a =>
    owned ? a.ownerAgentId === row.agentId : a.seats.some(seat => seat.agentId === row.agentId),
  );
  const sliced = relevant.slice(0, limits.assignments);
  let seatTruncated = 0;
  let handbackTruncated = 0;
  const assignments = sliced.map(assignment => {
    const seats = assignment.seats.map(seat => seat.agentId);
    const handbackRows = ledger.handbacks.filter(
      h => h.assignmentId === assignment.assignmentId && (owned || h.agentId === row.agentId),
    );
    const handbacks = handbackRows.slice(0, limits.handbacks).map(h => ({
      handbackId: h.handbackId,
      agentId: h.agentId,
      revision: h.revision,
      recordSha256: h.recordSha256,
      claimedCandidateId: h.claimedCandidateId,
      observedStatus: h.observed.status,
      observedCandidateId: h.observed.candidateId,
      gapsCount: h.gaps.length,
    }));
    if (seats.length > limits.seats) seatTruncated += 1;
    if (handbackRows.length > handbacks.length) handbackTruncated += 1;
    return {
      assignmentId: assignment.assignmentId,
      state: assignment.state,
      ownerAgentId: assignment.ownerAgentId,
      seats: seats.slice(0, limits.seats),
      handbacks,
    };
  });
  const limitations: string[] = [];
  const shed = relevant.length - sliced.length;
  if (shed > 0) limitations.push(`${shed} assignment(s) not shown — view capped at ${limits.assignments}`);
  if (seatTruncated > 0) limitations.push(`${seatTruncated} assignment(s) have seat lists truncated at ${limits.seats}`);
  if (handbackTruncated > 0) {
    limitations.push(`${handbackTruncated} assignment(s) have handback lists truncated at ${limits.handbacks}`);
  }
  return { assignments, limitations };
}

// ---------------------------------------------------------------------------
// Handler orchestration — the bridge calls these from ToolDef.run. Each
// builds a pure-input envelope, commits through the store, then derives the
// response from the durable rows (a replayed submit returns the same
// fields because the command body carries no generated ids or timestamps).
// ---------------------------------------------------------------------------

export type DeskRunnerDeps = {
  store: {
    transact(
      repoKey: string,
      envelope: Record<string, unknown>,
      decide: (ledger: Readonly<LedgerValue>, command: Record<string, unknown>) => DecideOutcome,
    ): Promise<TransactResult>;
    read(repoKey: string): DeskStoreRead;
  };
  capture: (deps: { nodePath: string; runtimePath: string; repository: string; now: () => Date }) => Promise<ObservedCaptureValue>;
  uuid: () => string;
  now: () => Date;
  binding: { runtimePath: string; nodePath: string } | null;
};

export type MutationOk = { ok: true; [key: string]: unknown };
export type MutationOutcome = MutationOk | DeskRejectionValue;

type RunnerCtx = { repoKey: string; row: MembershipValue };

/** Read the ledger fresh inside a run — the seat row was already re-checked
 *  by the dispatch guard, this read supplies the envelope's repo binding
 *  and the response's row lookups. A DeskRejectionValue is distinguished
 *  from a ledger by its `ok` field. */
function readLedger(
  deps: DeskRunnerDeps,
  repoKey: string,
): Readonly<LedgerValue> | DeskRejectionValue {
  const read = deps.store.read(repoKey);
  if (read.state !== "ok") {
    return {
      ok: false,
      code: "STATE_UNREADABLE",
      message: `the bound repo ledger reads ${read.state}`,
      recovery: "the desk must read cleanly for a tool call to be answered",
    };
  }
  return read.ledger;
}

const isRejection = (value: unknown): value is DeskRejectionValue =>
  typeof value === "object" && value !== null && "ok" in value && (value as { ok: unknown }).ok === false;

/** The envelope's repo slot is the strict {hostId, gitCommonDir} pair —
 *  the ledger's own binding row carries derived fields that would fail
 *  the envelope schema, so it is narrowed back here. */
const repoEnvelope = (ledger: Readonly<LedgerValue>) => ({
  hostId: ledger.repo.hostId,
  gitCommonDir: ledger.repo.gitCommonDir,
});

export async function runAssignmentRegister(
  ctx: RunnerCtx,
  input: { requestId: string; authorityRef: string; objective: string | null },
  deps: DeskRunnerDeps,
): Promise<MutationOutcome> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = {
    kind: "assignment.register",
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId,
    authorityRef: input.authorityRef,
    objective: input.objective,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: "assignment-admin", requestId: input.requestId, command },
    decideDeskHandback,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  // The response row resolves by the durable (ownerAgentId, requestId)
  // request key — never the live membershipId, which a rebind replaces
  // while the assignment keeps its original ownerMembershipId.
  const row = after.assignments.find(
    a => a.requestId === input.requestId && a.ownerAgentId === ctx.row.agentId,
  );
  if (row === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the register committed but its row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return { ok: true, receiptId: settled.receipt.receiptId, assignmentId: row.assignmentId, state: row.state };
}

export async function runAssignmentAttach(
  ctx: RunnerCtx,
  input: { requestId: string; assignmentId: string; agentId: string },
  deps: DeskRunnerDeps,
): Promise<MutationOutcome> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = {
    kind: "assignment.attach",
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId,
    assignmentId: input.assignmentId,
    agentId: input.agentId,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskHandback,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.assignments.find(a => a.assignmentId === input.assignmentId);
  const seat = row?.seats.find(s => s.agentId === input.agentId);
  if (row === undefined || seat === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the attach committed but the seat row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return { ok: true, receiptId: settled.receipt.receiptId, assignmentId: row.assignmentId, state: row.state, seat };
}

export async function runAssignmentClose(
  ctx: RunnerCtx,
  input: { requestId: string; assignmentId: string },
  deps: DeskRunnerDeps,
): Promise<MutationOutcome> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = {
    kind: "assignment.close",
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId,
    assignmentId: input.assignmentId,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskHandback,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.assignments.find(a => a.assignmentId === input.assignmentId);
  if (row === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the close committed but the row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return { ok: true, receiptId: settled.receipt.receiptId, assignmentId: row.assignmentId, state: row.state };
}

/** Submit is a two-commit flow: the claim lands under the seat's requestId
 *  (pure input → the store's own replay/conflict rules apply verbatim),
 *  then the bounded capture runs and `handback.observe` finalizes the
 *  `observed` block. A crash between the two leaves a `pending` row that
 *  the seat's retry converges — an acknowledged handback is never lost
 *  and a claim is never rewritten. */
export async function runHandbackSubmit(
  ctx: RunnerCtx,
  input: { requestId: string; assignmentId: string; recordV1: Record<string, unknown>; candidateId: string | null },
  deps: DeskRunnerDeps,
): Promise<MutationOutcome> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const agentId = ctx.row.agentId as string;
  const repo = repoEnvelope(ledger);
  const command = {
    kind: "handback.submit",
    requestId: input.requestId,
    actorAgentId: agentId,
    assignmentId: input.assignmentId,
    recordV1: input.recordV1,
    candidateId: input.candidateId,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo, actorKey: `agent:${agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskHandback,
  );
  if (!settled.ok) return settled;
  const locate = (candidate: Readonly<LedgerValue>) =>
    candidate.handbacks.find(
      h => h.requestId === input.requestId && h.assignmentId === input.assignmentId && h.agentId === agentId,
    );
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const handback = locate(after);
  if (handback === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the submit committed but its row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  let final = handback;
  let observeGap: string | null = null;
  if (handback.observed.status === "pending") {
    if (deps.binding === null) {
      observeGap = "observation-incomplete:no-bound-runtime";
    } else {
      const capture = await deps.capture({
        nodePath: deps.binding.nodePath,
        runtimePath: deps.binding.runtimePath,
        repository: handback.observed.repository,
        now: deps.now,
      });
      const observeId = deps.uuid();
      const observe = await deps.store.transact(
        ctx.repoKey,
        {
          repo,
          actorKey: `agent:${agentId}`,
          assignmentId: input.assignmentId,
          requestId: observeId,
          command: {
            kind: "handback.observe",
            requestId: observeId,
            actorAgentId: agentId,
            handbackId: handback.handbackId,
            capture,
          },
        },
        decideDeskHandback,
      );
      if (!observe.ok) {
        observeGap = `observation-incomplete:${observe.code}`;
      } else {
        const refreshed = readLedger(deps, ctx.repoKey);
        if (isRejection(refreshed)) {
          observeGap = "observation-incomplete:STATE_UNREADABLE";
        } else {
          final = locate(refreshed) ?? handback;
          if (final.observed.status === "pending") observeGap = "observation-incomplete:pending";
        }
      }
    }
  }
  // The claim is committed either way — a pending observation is reported
  // as a gap, never as a rejection of the handback.
  const gaps = final.observed.status === "pending"
    ? [...final.gaps, (observeGap ?? "observation-incomplete").slice(0, WIRE_LIMITS.gapLen)].slice(0, LEDGER_LIMITS.handbackGaps)
    : final.gaps;
  return {
    ok: true,
    revision: final.revision,
    receiptId: settled.receipt.receiptId,
    gaps,
    handbackId: final.handbackId,
    observedCandidateId: final.observed.candidateId,
  };
}
