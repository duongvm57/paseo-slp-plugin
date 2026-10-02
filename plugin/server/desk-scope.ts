// desk-scope.ts — the P4 scope machinery (contract R2). A scope is a
// durable, assignment-bound unit of work owned by the receiving
// owner/lead: `(assignmentId, scopeId, ownerAgentId, assignmentRevision)`
// is pinned at declare time and never rebindable — the caller never
// chooses the owner, and a declaration revision is immutable (an
// amendment appends a new revision with explicit lineage, it never edits
// in place). The scope itself is opaque: `scopeId` plus a bounded
// declaration digest and claimed `refs`; no filesystem path set, no
// filesystem authority — refs are provenance only and NEVER discharge a
// required-review gate.
//
// Three append-only tables carry the machinery: `scopes` (declaration
// revisions), `scopeReviews` (reviewer observations bound to
// assignment/scope/scopeRevision/candidate/reviewer seat+axis), and
// `scopeTransitions` (the state-machine walk). State legality comes from
// one shared seam — SCOPE_TRANSITIONS / scopeTransitionEdge in
// shared/enforcement.ts — consulted identically by this decide and by the
// store's durable refinement, so no producer can commit an edge the
// refinement would not re-verify. `close` is never acceptance: it is a
// terminal desk state; acceptance is a review disposition.
//
// Actor matrix (decide-enforced, refinement-rechecked):
//   - owner/lead (live bound membership, role "lead", assignment owner):
//     declare, claim, submit-for-review, review-observed, approve, reject,
//     advance, close — always within its own assignment.
//   - reviewer (a seat attached to the assignment, not the owner, not the
//     scope's bound seat — self-review is prohibited): records
//     observations for one axis at a time.
//   - every other actor (non-owner, foreign seat, revoked membership,
//     foreign assignment/scope) gets a typed rejection; a missing
//     required axis rejects REVIEW_INCOMPLETE and commits nothing.
//   - Supervisor/Human is never an implicit writer: every row's actor
//     resolves from the bound membership, not a claimed identity.
//
// A review round is pinned by submit-for-review: the transition row
// carries the round's (scopeRevision, candidateSnapshot, candidateHead)
// and every review + every gated transition must bind to that exact pin.
// Candidate drift or declaration-revision drift rejects typed. A mid-round
// amendment advances the declaration stream but the round pin holds —
// the gate still requires observations against the round pin. `claim`
// remains an explicit edge (declared → claimed); it is present because
// claim is where a reviewer-visible candidate pin does not yet exist, so
// the pre-candidate states stay reachable without inventing one.

import { z } from "zod";
import { Sha, Time } from "../shared/contracts.ts";
import {
  DeskRejection,
  DeskScopeDeclareInput,
  DeskScopeReviewInput,
  DeskScopeTransitionInput,
  SCOPE_REVIEW_AXES,
  SCOPE_REVIEW_GATED_COMMANDS,
  ScopeCommand,
  ScopeReviewAxis,
  ScopeReviewVerdict,
  WIRE_LIMITS,
  scopeTransitionEdge,
  type DeskRejectionValue,
  type DeskScopeDeclareInputValue,
  type DeskScopeReviewInputValue,
  type DeskScopeTransitionInputValue,
  type ScopeCommandValue,
  type ScopeReviewAxisValue,
  type ScopeStateValue,
} from "../shared/enforcement.ts";
import {
  LEDGER_LIMITS,
  assignmentStructuralRevision,
  type AssignmentValue,
  type CandidateValue,
  type DecideOutcome,
  type LedgerValue,
  type MembershipValue,
  type ScopeReviewValue,
  type ScopeTransitionValue,
  type ScopeValue,
} from "./desk-store.ts";
import { isRejection, readLedger, repoEnvelope, type DeskRunnerDeps, type RunnerCtx } from "./desk-runner.ts";
import {
  deriveId,
  requireActor as requireDeskActor,
  requireLead as requireDeskLead,
  requireOwnedOpenAssignment as requireDeskOwnedOpenAssignment,
} from "./desk-command.ts";

// ---------------------------------------------------------------------------
// command schemas — the durable command body. `actorAgentId` is
// server-derived (the bound membership's agentId) and rides the command so a
// replayed envelope re-decides under the same actor.
// ---------------------------------------------------------------------------

const ActorAgentId = z.string().min(1).max(WIRE_LIMITS.agentId);
const BoundedId = z.string().min(1).max(WIRE_LIMITS.deskEntityId);
const RequestId = z.string().min(1).max(WIRE_LIMITS.deskRequestId);
const ScopePointer = z.string().min(1).max(WIRE_LIMITS.deskScopePointer);

const ScopeDeclareCommand = DeskScopeDeclareInput.extend({
  kind: z.literal("scope.declare"),
  actorAgentId: ActorAgentId,
}).strict();

const ScopeTransitionCommand = DeskScopeTransitionInput.extend({
  kind: z.literal("scope.transition"),
  actorAgentId: ActorAgentId,
}).strict();

const ScopeReviewCommand = DeskScopeReviewInput.extend({
  kind: z.literal("scope.review"),
  actorAgentId: ActorAgentId,
}).strict();

const DeskScopeCommand = z.discriminatedUnion("kind", [
  ScopeDeclareCommand,
  ScopeTransitionCommand,
  ScopeReviewCommand,
]);

const reject = (code: DeskRejectionValue["code"], message: string, recovery: string): DeskRejectionValue => ({
  ok: false,
  code,
  message,
  recovery,
});

const ok = (
  events: { kind: string; payload: Record<string, unknown> }[],
  tables: { scopes?: ScopeValue[]; scopeReviews?: ScopeReviewValue[]; scopeTransitions?: ScopeTransitionValue[] } = {},
): DecideOutcome => ({ ok: true, events, ...tables });

// ---------------------------------------------------------------------------
// actor + target resolution — server-side, decide-level.
// ---------------------------------------------------------------------------

function requireActor(ledger: Readonly<LedgerValue>, agentId: string): MembershipValue | DeskRejectionValue {
  return requireDeskActor(ledger, agentId, "a scope command needs a host-bound, registered row — peers and revoked seats cannot move scope state");
}

function requireLead(actor: MembershipValue): DeskRejectionValue | null {
  return requireDeskLead(
    actor,
    `role ${JSON.stringify(actor.role)} may not administer scopes — the receiving owner holds a bound lead membership`,
    "the role pin is a durable membership field, not a claim",
  );
}

/** The durable assignment the command names, owned by the actor and still
 *  open — a closed assignment's scopes keep their state but take no new
 *  declarations, transitions or reviews. */
function requireOwnedOpenAssignment(
  ledger: Readonly<LedgerValue>,
  actor: MembershipValue,
  assignmentId: string,
): AssignmentValue | DeskRejectionValue {
  return requireDeskOwnedOpenAssignment(ledger, actor, assignmentId, {
    missing: reject(
      "AUTHORITY_REQUIRED",
      "the assignment is not registered on this desk",
      "scope commands name a durable assignment binding of this repo desk",
    ),
    ownerMismatch: reject(
      "AUTHORITY_REQUIRED",
      "only the assignment's receiving owner may administer its scopes",
      "the registering lead's agentId is bound into the row — a peer, another lead, or a supervisor cannot move scope state",
    ),
    closed: reject(
      "SCOPE_CONFLICT",
      "the assignment is closed — its scopes keep their recorded state",
      "closed assignments take no new declarations, transitions or reviews",
    ),
  });
}

/** The scope's declaration stream (assignmentId, scopeId) — sorted by
 *  revision, latest last. */
function declarationStream(ledger: Readonly<LedgerValue>, assignmentId: string, scopeId: string): ScopeValue[] {
  return ledger.scopes
    .filter(s => s.assignmentId === assignmentId && s.scopeId === scopeId)
    .sort((a, b) => a.revision - b.revision);
}

/** The scope's transition stream (assignmentId, scopeId) — sorted by
 *  revision. The current machine state is the last row's `to`; an empty
 *  stream means the scope was never declared. */
function transitionStream(ledger: Readonly<LedgerValue>, assignmentId: string, scopeId: string): ScopeTransitionValue[] {
  return ledger.scopeTransitions
    .filter(t => t.assignmentId === assignmentId && t.scopeId === scopeId)
    .sort((a, b) => a.revision - b.revision);
}

/** The active review round's pin — set by the latest submit-for-review
 *  transition, cleared when the machine returns to declared/claimed or
 *  reaches a terminal state. A round lives through submitted-for-review,
 *  review-observed, approved and rejected; `advanced` and `closed` end it,
 *  and the machine can only leave `advanced` through a fresh submit. */
function activeRound(stream: ScopeTransitionValue[]): { scopeRevision: number; candidateSnapshot: string; candidateHead: string | null } | null {
  let pin: { scopeRevision: number; candidateSnapshot: string; candidateHead: string | null } | null = null;
  for (const row of stream) {
    if (row.command === "submit-for-review") {
      pin = { scopeRevision: row.scopeRevision, candidateSnapshot: row.candidateSnapshot as string, candidateHead: row.candidateHead };
    } else if (row.to === "advanced" || row.to === "closed") {
      pin = null;
    }
  }
  return pin;
}

/** The scope review round currently standing approved or advanced, for the
 *  rollout promote gate. A fresh round supersedes the prior approval.
 *  The store's durable refinement separately verifies historical approve
 *  edges: later scope transitions must not invalidate a committed rollout. */
export function approvedScopeRound(
  stream: ScopeTransitionValue[],
): {
  scopeRevision: number;
  candidateSnapshot: string;
  candidateHead: string | null;
  discharged: ScopeTransitionValue["discharged"];
} | null {
  let pin: { scopeRevision: number; candidateSnapshot: string; candidateHead: string | null } | null = null;
  let observed: ScopeTransitionValue["discharged"] | null = null;
  let approved: { scopeRevision: number; candidateSnapshot: string; candidateHead: string | null; discharged: ScopeTransitionValue["discharged"] } | null = null;
  let state: ScopeTransitionValue["to"] | null = null;
  for (const row of stream) {
    if (row.command === "submit-for-review") {
      pin = { scopeRevision: row.scopeRevision, candidateSnapshot: row.candidateSnapshot as string, candidateHead: row.candidateHead };
      observed = null;
    }
    // The gate transition carries the round's discharged set; approve is
    // reachable only through it, so the standing approval's evidence is
    // always the matching review-observed row's.
    if (row.command === "review-observed") observed = row.discharged;
    if (row.to === "approved" && pin !== null && observed !== null) {
      approved = { ...pin, discharged: observed };
    }
    state = row.to;
  }
  if (state !== "approved" && state !== "advanced") return null;
  return approved;
}

/** The required review axes for a gated transition — server-derived, the
 *  contract's required-review set. Callers never see or shrink it; the
 *  status projection exposes it on an active round. */
function requiredAxes(_command?: ScopeCommandValue): ScopeReviewAxisValue[] {
  return [...SCOPE_REVIEW_AXES];
}

/** The discharge evidence a gated transition commits with: for every
 *  required axis, the latest review revision bound to the round pin —
 *  matching (assignmentId, scopeId, axis, scopeRevision, candidateSnapshot)
 *  exactly. A missing axis yields null and the transition rejects. */
function resolveDischarges(
  ledger: Readonly<LedgerValue>,
  assignmentId: string,
  scopeId: string,
  round: { scopeRevision: number; candidateSnapshot: string },
): { axis: ScopeReviewAxisValue; reviewId: string }[] | null {
  const discharged: { axis: ScopeReviewAxisValue; reviewId: string }[] = [];
  for (const axis of SCOPE_REVIEW_AXES) {
    const bound = ledger.scopeReviews
      .filter(
        r =>
          r.assignmentId === assignmentId &&
          r.scopeId === scopeId &&
          r.axis === axis &&
          r.scopeRevision === round.scopeRevision &&
          r.candidateSnapshot === round.candidateSnapshot,
      )
      .sort((a, b) => a.revision - b.revision);
    const latest = bound[bound.length - 1];
    if (latest === undefined) return null;
    discharged.push({ axis, reviewId: latest.reviewId });
  }
  return discharged;
}

// ---------------------------------------------------------------------------
// decide — synchronous and pure.
// ---------------------------------------------------------------------------

function decideDeskScope(ledger: Readonly<LedgerValue>, command: Record<string, unknown>): DecideOutcome {
  const parsed = DeskScopeCommand.safeParse(command);
  if (!parsed.success) {
    return reject("INVALID_RECORD", "command does not match any desk-scope command schema", "commands are strict JSON objects with a kind discriminator");
  }
  const cmd = parsed.data;

  const actor = requireActor(ledger, cmd.actorAgentId);
  if ("ok" in actor) return actor;

  if (cmd.kind === "scope.review") {
    return decideScopeReview(ledger, actor, cmd);
  }

  // scope.declare / scope.transition — owner/lead only, on an open
  // assignment the actor durably owns.
  const leadError = requireLead(actor);
  if (leadError !== null) return leadError;
  const assignment = requireOwnedOpenAssignment(ledger, actor, cmd.assignmentId);
  if ("ok" in assignment) return assignment;

  if (cmd.kind === "scope.declare") {
    if (ledger.scopes.length >= LEDGER_LIMITS.scopes) {
      return reject("INVALID_RECORD", `scopes table is at the ${LEDGER_LIMITS.scopes} cap`, "the scope table is bounded per repo desk");
    }
    if (cmd.seatAgentId !== null && !assignment.seats.some(seat => seat.agentId === cmd.seatAgentId)) {
      return reject(
        "INVALID_RECORD",
        "seatAgentId is not bound to this assignment",
        "a declaration binds an attached seat of this assignment, or null for a scope owned by the assignment itself",
      );
    }
    const stream = declarationStream(ledger, cmd.assignmentId, cmd.scopeId);
    const latest = stream[stream.length - 1];
    const revision = (latest?.revision ?? 0) + 1;
    const scopeRow: ScopeValue = {
      assignmentId: cmd.assignmentId,
      scopeId: cmd.scopeId,
      requestId: cmd.requestId,
      revision,
      priorRevision: latest?.revision ?? null,
      ownerMembershipId: actor.membershipId,
      ownerAgentId: actor.agentId as string,
      assignmentRevision: assignmentStructuralRevision(assignment),
      seatAgentId: cmd.seatAgentId,
      label: cmd.label,
      declarationSha256: cmd.declarationSha256,
      refs: cmd.refs,
    };
    // The first declaration also opens the transition stream with the
    // (none → declared) edge — `declare` is the stream-opening command,
    // not a caller-visible transition. Later revisions amend provenance
    // only; the machine state stays put.
    const transitions =
      revision === 1
        ? [
            ...ledger.scopeTransitions,
            {
              transitionId: deriveId("stn", [actor.agentId as string, cmd.assignmentId, cmd.scopeId, cmd.requestId, "declare"]),
              assignmentId: cmd.assignmentId,
              scopeId: cmd.scopeId,
              requestId: cmd.requestId,
              revision: 1,
              command: "declare" as const,
              from: null,
              to: "declared" as const,
              scopeRevision: 1,
              candidateSnapshot: null,
              candidateHead: null,
              discharged: [],
              actorAgentId: actor.agentId as string,
            } satisfies ScopeTransitionValue,
          ]
        : ledger.scopeTransitions;
    return ok(
      [{
        kind: "scope-declared",
        payload: {
          assignmentId: cmd.assignmentId,
          scopeId: cmd.scopeId,
          ownerAgentId: actor.agentId,
          revision,
          assignmentRevision: scopeRow.assignmentRevision,
        },
      }],
      { scopes: [...ledger.scopes, scopeRow], scopeTransitions: transitions },
    );
  }

  if (cmd.kind === "scope.transition") {
    const declarations = declarationStream(ledger, cmd.assignmentId, cmd.scopeId);
    if (declarations.length === 0) {
      return reject(
        "SCOPE_CONFLICT",
        "the scope is not declared on this assignment",
        "declare the scope before moving its machine — the (none → declared) edge is the declaration itself",
      );
    }
    const latestDeclaration = declarations[declarations.length - 1]!;
    if (cmd.scopeRevision !== latestDeclaration.revision) {
      return reject(
        "REVISION_CONFLICT",
        `scopeRevision ${cmd.scopeRevision} is superseded by declaration revision ${latestDeclaration.revision}`,
        "transitions pin the latest declaration revision — re-read the scope and retry with a new requestId",
      );
    }
    const transitions = transitionStream(ledger, cmd.assignmentId, cmd.scopeId);
    const from = transitions[transitions.length - 1]?.to ?? null;
    if (from === null) {
      return reject("SCOPE_CONFLICT", "the scope has no declared edge", "a declaration revision opens the stream");
    }
    const edge = scopeTransitionEdge(from, cmd.transition);
    if (edge === undefined) {
      return reject(
        "SCOPE_CONFLICT",
        `transition ${JSON.stringify(cmd.transition)} is not legal from ${JSON.stringify(from)}`,
        "the shared SCOPE_TRANSITIONS table is the only legality authority — move along an existing edge",
      );
    }
    // submit-for-review pins a review round: the candidate must be a
    // durable observed candidate of THIS assignment — and of the scope's
    // bound seat when one is declared. Every other command carries no
    // candidate fields.
    let candidateSnapshot: string | null = null;
    let candidateHead: string | null = null;
    if (cmd.transition === "submit-for-review") {
      if (cmd.candidateSnapshot === null) {
        return reject(
          "INVALID_RECORD",
          "submit-for-review requires a candidate pin",
          "the review round binds an observed candidate — snapshotSha256 of a durable candidate row on this assignment",
        );
      }
      const candidate = ledger.candidates.find(
        c => c.snapshotSha256 === cmd.candidateSnapshot && c.assignmentId === cmd.assignmentId,
      );
      if (candidate === undefined) {
        return reject(
          "CANDIDATE_DRIFT",
          "the pinned candidate is not an observed candidate of this assignment",
          "submit-for-review binds a durable observed candidate — re-measure with a handback observe and retry",
        );
      }
      if (latestDeclaration.seatAgentId !== null && candidate.seatAgentId !== latestDeclaration.seatAgentId) {
        return reject(
          "CANDIDATE_DRIFT",
          "the pinned candidate belongs to a different seat than the scope's bound seat",
          "a seat-bound scope's round candidate is observed from that seat's captures",
        );
      }
      if (cmd.candidateHead !== null && candidate.head !== cmd.candidateHead) {
        return reject(
          "CANDIDATE_DRIFT",
          "the claimed candidate head does not match the durable candidate's measured head",
          "the head pin is evidence, not input — resubmit with the measured head or null",
        );
      }
      candidateSnapshot = candidate.snapshotSha256;
      candidateHead = candidate.head;
    } else if (cmd.candidateSnapshot !== null || cmd.candidateHead !== null) {
      return reject(
        "INVALID_RECORD",
        "only submit-for-review carries a candidate pin",
        "candidate fields on another transition are a malformed command, not a rebind",
      );
    }
    // The review gate — required axes are server-derived and never shrink.
    // Gated commands (review-observed, advance, close) may commit only when
    // the ACTIVE round carries a durable observation per required axis —
    // an early close is not even an edge, so a gated command with no round
    // typed-rejects. `approve` needs no separate gate: it is only
    // reachable through a committed review-observed, which already
    // discharged every axis of the round.
    const gated = (SCOPE_REVIEW_GATED_COMMANDS as readonly string[]).includes(cmd.transition);
    const round = activeRound(transitions);
    let discharged: { axis: ScopeReviewAxisValue; reviewId: string }[] = [];
    if (gated && round !== null) {
      const resolved = resolveDischarges(ledger, cmd.assignmentId, cmd.scopeId, round);
      if (resolved === null) {
        const missing = SCOPE_REVIEW_AXES.filter(
          axis =>
            !ledger.scopeReviews.some(
              r =>
                r.assignmentId === cmd.assignmentId &&
                r.scopeId === cmd.scopeId &&
                r.axis === axis &&
                r.scopeRevision === round.scopeRevision &&
                r.candidateSnapshot === round.candidateSnapshot,
            ),
        );
        return reject(
          "REVIEW_INCOMPLETE",
          `transition ${JSON.stringify(cmd.transition)} requires review on ${missing.join(", ")} for the active round`,
          "a bound reviewer seat records scope.review observations against the round's scopeRevision+candidateSnapshot — nothing else discharges the gate",
        );
      }
      discharged = resolved;
    } else if (gated && round === null) {
      // Unreachable through the edge table — no gated edge exists before a
      // round is submitted — but keep the refusal typed rather than rely
      // on the table alone.
      return reject("REVIEW_INCOMPLETE", "no review round is active on this scope", "submit-for-review opens the round the gate measures");
    }
    const revision = (transitions[transitions.length - 1]?.revision ?? 0) + 1;
    const row: ScopeTransitionValue = {
      transitionId: deriveId("stn", [actor.agentId as string, cmd.assignmentId, cmd.scopeId, cmd.requestId, cmd.transition]),
      assignmentId: cmd.assignmentId,
      scopeId: cmd.scopeId,
      requestId: cmd.requestId,
      revision,
      command: cmd.transition,
      from,
      to: edge.to,
      scopeRevision: cmd.scopeRevision,
      candidateSnapshot,
      candidateHead,
      discharged,
      actorAgentId: actor.agentId as string,
    };
    return ok(
      [{
        kind: "scope-transitioned",
        payload: { assignmentId: cmd.assignmentId, scopeId: cmd.scopeId, command: cmd.transition, from, to: edge.to, revision, discharged },
      }],
      { scopeTransitions: [...ledger.scopeTransitions, row] },
    );
  }

  return reject("INVALID_RECORD", "unreachable scope command", "the discriminated union is closed");
}

/** scope.review — a bound reviewer seat's observation. The reviewer must
 *  be a seat of the assignment, never the owner (the owner administers; it
 *  never reviews its own scope) and never the scope's bound seat —
 *  self-review is prohibited even across roles. */
function decideScopeReview(
  ledger: Readonly<LedgerValue>,
  actor: MembershipValue,
  cmd: z.infer<typeof ScopeReviewCommand>,
): DecideOutcome {
  const reviewAssignment = ledger.assignments.find(a => a.assignmentId === cmd.assignmentId);
  if (reviewAssignment === undefined) {
    return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "a review binds a durable assignment of this repo desk");
  }
  if (reviewAssignment.state !== "open") {
    return reject("SCOPE_CONFLICT", "the assignment is closed", "closed assignments take no new review observations");
  }
  if (reviewAssignment.ownerAgentId === cmd.actorAgentId) {
    return reject(
      "AUTHORITY_REQUIRED",
      "the assignment owner may not record a review observation",
      "self-review is prohibited — a bound peer seat records each axis",
    );
  }
  const seat = reviewAssignment.seats.find(s => s.agentId === cmd.actorAgentId);
  if (seat === undefined) {
    return reject(
      "AUTHORITY_REQUIRED",
      "the reviewer is not a bound seat of this assignment",
      "observations come from seats attached to the scope's assignment",
    );
  }
  const seatRow = ledger.memberships.find(m => m.membershipId === seat.membershipId);
  if (seatRow === undefined || seatRow.agentId !== cmd.actorAgentId) {
    return reject("INVALID_RECORD", "the seat's membership row does not carry the reviewer agentId", "the seat binding is corrupt — inspect the desk under maintenance authority");
  }
  const declarations = declarationStream(ledger, cmd.assignmentId, cmd.scopeId);
  if (declarations.length === 0) {
    return reject("SCOPE_CONFLICT", "the scope is not declared on this assignment", "a review binds a declared scope's active round");
  }
  const latestDeclaration = declarations[declarations.length - 1]!;
  if (latestDeclaration.seatAgentId === cmd.actorAgentId) {
    return reject(
      "AUTHORITY_REQUIRED",
      "the scope's bound seat may not review its own scope",
      "self-review is prohibited — another bound seat or the review pool records the axis",
    );
  }
  const transitions = transitionStream(ledger, cmd.assignmentId, cmd.scopeId);
  const round = activeRound(transitions);
  if (round === null) {
    return reject(
      "SCOPE_CONFLICT",
      "no review round is active on this scope",
      "a review observation binds the round a submit-for-review pinned",
    );
  }
  if (cmd.scopeRevision !== round.scopeRevision) {
    return reject(
      "REVISION_CONFLICT",
      `the review pins declaration revision ${cmd.scopeRevision} but the active round binds ${round.scopeRevision}`,
      "a mid-round amendment does not rebind the round — review the pinned declaration revision",
    );
  }
  if (cmd.candidateSnapshot !== round.candidateSnapshot) {
    return reject(
      "CANDIDATE_DRIFT",
      "the review's candidate does not match the active round's pinned candidate",
      "observations bind the submitted candidate — drift is never a quiet rebind",
    );
  }
  if (ledger.scopeReviews.length >= LEDGER_LIMITS.scopeReviews) {
    return reject("INVALID_RECORD", `scopeReviews table is at the ${LEDGER_LIMITS.scopeReviews} cap`, "the review table is bounded per repo desk");
  }
  const revision =
    ledger.scopeReviews
      .filter(
        r =>
          r.assignmentId === cmd.assignmentId &&
          r.scopeId === cmd.scopeId &&
          r.axis === cmd.axis &&
          r.reviewerAgentId === cmd.actorAgentId,
      )
      .reduce((max, r) => Math.max(max, r.revision), 0) + 1;
  const reviewId = deriveId("srv", [cmd.actorAgentId, cmd.assignmentId, cmd.scopeId, cmd.axis, cmd.requestId]);
  const row: ScopeReviewValue = {
    reviewId,
    assignmentId: cmd.assignmentId,
    scopeId: cmd.scopeId,
    requestId: cmd.requestId,
    revision,
    scopeRevision: cmd.scopeRevision,
    candidateSnapshot: cmd.candidateSnapshot,
    axis: cmd.axis,
    verdict: cmd.verdict,
    reviewerAgentId: cmd.actorAgentId,
    reviewerSeatId: seat.membershipId,
    findingsRef: cmd.findingsRef,
  };
  return ok(
    [{
      kind: "scope-review-recorded",
      payload: { reviewId, assignmentId: cmd.assignmentId, scopeId: cmd.scopeId, axis: cmd.axis, verdict: cmd.verdict, reviewerAgentId: cmd.actorAgentId, revision },
    }],
    { scopeReviews: [...ledger.scopeReviews, row] },
  );
}

// ---------------------------------------------------------------------------
// Status projection — caller-scoped like seatSettlementsView: the owner sees
// every scope on its owned assignment; a bound seat sees only the scopes it
// is bound to or (when unbound) the scopes it may review. Identifiers,
// derived state and the round pin only — claimed refs/findingsRef stay in
// the ledger.
// ---------------------------------------------------------------------------

export type StatusScope = {
  scopeId: string;
  revision: number;
  label: string;
  declarationSha256: string;
  seatAgentId: string | null;
  state: ScopeStateValue;
  activeScopeRevision: number | null;
  activeCandidateSnapshot: string | null;
  requiredAxes: ScopeReviewAxisValue[];
  dischargedAxes: ScopeReviewAxisValue[];
  transitionCount: number;
  reviews: {
    reviewId: string;
    axis: ScopeReviewAxisValue;
    verdict: ScopeReviewValue["verdict"];
    scopeRevision: number;
    reviewerAgentId: string;
    revision: number;
  }[];
};

export function seatScopesView(
  ledger: Readonly<LedgerValue>,
  row: MembershipValue,
  limits: { scopes: number; reviews: number },
): { byAssignment: Map<string, StatusScope[]>; truncated: number; reviewsTruncated: number } {
  const byAssignment = new Map<string, StatusScope[]>();
  let truncated = 0;
  let reviewsTruncated = 0;
  for (const assignment of ledger.assignments) {
    const owner = assignment.ownerAgentId === row.agentId;
    const attached = assignment.seats.some(seat => seat.agentId === row.agentId);
    if (!owner && !attached) continue;
    const scopeIds = new Set<string>();
    for (const s of ledger.scopes) {
      if (s.assignmentId !== assignment.assignmentId) continue;
      // A seat sees the scopes it is bound to plus unbound scopes (it may
      // review them); the owner sees all.
      if (!owner && s.seatAgentId !== null && s.seatAgentId !== row.agentId) continue;
      scopeIds.add(s.scopeId);
    }
    if (scopeIds.size === 0) continue;
    if (scopeIds.size > limits.scopes) truncated += 1;
    const projected: StatusScope[] = [];
    for (const scopeId of [...scopeIds].sort().slice(0, limits.scopes)) {
      const declarations = declarationStream(ledger, assignment.assignmentId, scopeId);
      const latest = declarations[declarations.length - 1];
      if (latest === undefined) continue;
      const transitions = transitionStream(ledger, assignment.assignmentId, scopeId);
      const state: ScopeStateValue = transitions[transitions.length - 1]?.to ?? "declared";
      const round = activeRound(transitions);
      const scopedReviews = ledger.scopeReviews
        .filter(r => r.assignmentId === assignment.assignmentId && r.scopeId === scopeId)
        .sort((a, b) => a.revision - b.revision);
      // The per-scope cap must never silently omit rows — the envelope's
      // limitations array carries the count marker instead (B9).
      if (scopedReviews.length > limits.reviews) reviewsTruncated += 1;
      const reviews = scopedReviews.slice(0, limits.reviews).map(r => ({
        reviewId: r.reviewId,
        axis: r.axis,
        verdict: r.verdict,
        scopeRevision: r.scopeRevision,
        reviewerAgentId: r.reviewerAgentId,
        revision: r.revision,
      }));
      const dischargedAxes =
        round === null
          ? []
          : [...new Set(
              ledger.scopeReviews
                .filter(
                  r =>
                    r.assignmentId === assignment.assignmentId &&
                    r.scopeId === scopeId &&
                    r.scopeRevision === round.scopeRevision &&
                    r.candidateSnapshot === round.candidateSnapshot,
                )
                .map(r => r.axis),
            )];
      projected.push({
        scopeId,
        revision: latest.revision,
        label: latest.label,
        declarationSha256: latest.declarationSha256,
        seatAgentId: latest.seatAgentId,
        state,
        activeScopeRevision: round?.scopeRevision ?? null,
        activeCandidateSnapshot: round?.candidateSnapshot ?? null,
        requiredAxes: round === null ? [] : requiredAxes(),
        dischargedAxes,
        transitionCount: transitions.length,
        reviews,
      });
    }
    if (projected.length > 0) byAssignment.set(assignment.assignmentId, projected);
  }
  return { byAssignment, truncated, reviewsTruncated };
}

// ---------------------------------------------------------------------------
// Runner orchestration — the bridge calls these from ToolDef.run. The
// command body carries the server-derived actorAgentId so a replayed
// envelope re-decides identically; the response resolves by the durable
// request key, never a live membershipId.
// ---------------------------------------------------------------------------

export async function runScopeDeclare(
  ctx: RunnerCtx,
  input: DeskScopeDeclareInputValue,
  deps: DeskRunnerDeps,
): Promise<{ ok: true; [key: string]: unknown } | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = {
    kind: "scope.declare" as const,
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId as string,
    assignmentId: input.assignmentId,
    scopeId: input.scopeId,
    label: input.label,
    declarationSha256: input.declarationSha256,
    refs: input.refs,
    seatAgentId: input.seatAgentId,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskScope,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.scopes.find(
    s => s.requestId === input.requestId && s.assignmentId === input.assignmentId && s.ownerAgentId === ctx.row.agentId,
  );
  if (row === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the declaration committed but its row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return { ok: true, scopeId: row.scopeId, revision: row.revision, receiptId: settled.receipt.receiptId };
}

export async function runScopeTransition(
  ctx: RunnerCtx,
  input: DeskScopeTransitionInputValue,
  deps: DeskRunnerDeps,
): Promise<{ ok: true; [key: string]: unknown } | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = {
    kind: "scope.transition" as const,
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId as string,
    assignmentId: input.assignmentId,
    scopeId: input.scopeId,
    transition: input.transition,
    scopeRevision: input.scopeRevision,
    candidateSnapshot: input.candidateSnapshot,
    candidateHead: input.candidateHead,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskScope,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.scopeTransitions.find(
    t => t.requestId === input.requestId && t.assignmentId === input.assignmentId && t.actorAgentId === ctx.row.agentId,
  );
  if (row === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the transition committed but its row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return {
    ok: true,
    transitionId: row.transitionId,
    scopeId: row.scopeId,
    revision: row.revision,
    state: row.to,
    receiptId: settled.receipt.receiptId,
    discharged: row.discharged,
  };
}

export async function runScopeReview(
  ctx: RunnerCtx,
  input: DeskScopeReviewInputValue,
  deps: DeskRunnerDeps,
): Promise<{ ok: true; [key: string]: unknown } | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = {
    kind: "scope.review" as const,
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId as string,
    assignmentId: input.assignmentId,
    scopeId: input.scopeId,
    scopeRevision: input.scopeRevision,
    candidateSnapshot: input.candidateSnapshot,
    axis: input.axis,
    verdict: input.verdict,
    findingsRef: input.findingsRef,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskScope,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.scopeReviews.find(
    r => r.requestId === input.requestId && r.assignmentId === input.assignmentId && r.reviewerAgentId === ctx.row.agentId,
  );
  if (row === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the review committed but its row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return { ok: true, reviewId: row.reviewId, scopeId: row.scopeId, axis: row.axis, revision: row.revision, receiptId: settled.receipt.receiptId };
}
