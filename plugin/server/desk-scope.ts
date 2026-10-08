// desk-scope.ts — the P4 scope machinery (contract R2). A scope is a
// durable, assignment-bound unit of work owned by the receiving
// owner/lead: `(assignmentId, scopeId, ownerAgentId, assignmentRevision)`
// is pinned at declare time and never rebindable — the caller never
// chooses the owner, and a declaration revision is immutable (an
// amendment appends a new revision with explicit lineage, it never edits
// in place). Optional structured ownership names declared moving surfaces,
// state owners, dependencies and notification intent; it grants no
// filesystem authority. `refs` remain provenance claims and NEVER discharge
// a required-review gate.
//
// Three append-only tables carry the machinery: `scopes` (declaration
// revisions), `scopeReviews` (reviewer observations bound to
// assignment/scope/scopeRevision/candidate/reviewer seat+axis-or-lens), and
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
//     scope's bound seat or declared writer — self-review is prohibited):
//     records one legacy axis or one pinned named lens at a time.
//   - every other actor (non-owner, foreign seat, revoked membership,
//     foreign assignment/scope) gets a typed rejection; a missing
//     required axis rejects REVIEW_INCOMPLETE and commits nothing.
//   - Supervisor/Human is never an implicit writer: every row's actor
//     resolves from the bound membership, not a claimed identity.
//
// A review round is pinned by submit-for-review: the transition row
// carries the round's (scopeRevision, candidateSnapshot, candidateHead)
// and every review + every gated transition must bind to that exact pin.
// Candidate drift or declaration, brief or mandate change makes the round
// stale; old observations remain pinned to their original event-time claims.
// `claim`
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
  DeskScopeDischarge,
  SCOPE_REVIEW_AXES,
  SCOPE_REVIEW_GATED_COMMANDS,
  ScopeCommand,
  ScopeReviewAxis,
  ScopeReviewVerdict,
  WIRE_LIMITS,
  scopeTransitionEdge,
  canonicalWorkspacePath,
  workspacePathsOverlap,
  type DeskRejectionValue,
  type DeskScopeDeclareInputValue,
  type DeskScopeReviewInputValue,
  type DeskScopeDischargeValue,
  type DeskScopeTransitionInputValue,
  type ScopeCommandValue,
  type ScopeReviewAxisValue,
  type ScopeStateValue,
} from "../shared/enforcement.ts";
import {
  effectiveOwner,
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
import { currentReviewExclusions, deskWorkflowParticipant } from "./desk-ownership.ts";
import { isRejection, readLedger, repoEnvelope, type DeskRunnerDeps, type RunnerCtx } from "./desk-runner.ts";
import { canonicalJson, canonicalSha256, sha256Hex } from "./config-view.ts";
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
  // Distinguish new explicit null from omission without rewriting old hashes.
  reviewPlanInput: z.enum(["explicit", "omitted"]).optional(),
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
      "look up registered assignments with slp_status; tell the Lead to register the assignment under the current Human grant",
    ),
    ownerMismatch: reject(
      "AUTHORITY_REQUIRED",
      "only the assignment's receiving owner may administer its scopes",
      "the current owner is bound by agent and membership — another participant cannot move scope state",
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
type ScopeRoundPin = {
  scopeRevision: number;
  candidateSnapshot: string;
  candidateHead: string | null;
  briefRevision: number;
  mandateSha256: string | null;
};

function activeRound(stream: ScopeTransitionValue[]): ScopeRoundPin | null {
  let pin: ScopeRoundPin | null = null;
  for (const row of stream) {
    if (row.command === "submit-for-review") {
      pin = {
        scopeRevision: row.scopeRevision,
        candidateSnapshot: row.candidateSnapshot as string,
        candidateHead: row.candidateHead,
        briefRevision: row.briefRevision,
        mandateSha256: row.mandateSha256,
      };
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
  expected?: { briefRevision?: number; scopeRevision?: number; mandateSha256?: string | null; includeClosedApproval?: boolean },
): {
  scopeRevision: number;
  candidateSnapshot: string;
  candidateHead: string | null;
  discharged: ScopeTransitionValue["discharged"];
  briefRevision: number;
  mandateSha256: string | null;
} | null {
  let pin: ScopeRoundPin | null = null;
  let observed: ScopeTransitionValue["discharged"] | null = null;
  let approved: ScopeRoundPin & { discharged: ScopeTransitionValue["discharged"] } | null = null;
  let state: ScopeTransitionValue["to"] | null = null;
  for (const row of stream) {
    if (row.command === "submit-for-review") {
      pin = {
        scopeRevision: row.scopeRevision,
        candidateSnapshot: row.candidateSnapshot as string,
        candidateHead: row.candidateHead,
        briefRevision: row.briefRevision,
        mandateSha256: row.mandateSha256,
      };
      observed = null;
    }
    if (row.command === "review-observed") observed = row.discharged;
    // Approval is independently freshness-gated and carries the exact review
    // rows resolved in that transaction. Use its durable discharge as the
    // standing approval proof, including an explicitly empty exemption.
    if (row.to === "approved" && pin !== null) {
      // Earlier persisted rows predate approval-level discharge and carry an
      // empty array even when review-observed recorded the required evidence.
      const discharge = row.discharged.length === 0 && observed !== null && observed.length > 0
        ? observed
        : row.discharged;
      approved = { ...pin, discharged: discharge };
    }
    state = row.to;
  }
  const terminal = expected?.includeClosedApproval === true && state === "closed" && stream.at(-1)?.command === "close" && stream.at(-1)?.from === "approved";
  if (state !== "approved" && state !== "advanced" && !terminal) return null;
  if (approved !== null && (
    (expected?.briefRevision !== undefined && approved.briefRevision !== expected.briefRevision) ||
    (expected?.scopeRevision !== undefined && approved.scopeRevision !== expected.scopeRevision) ||
    (expected !== undefined && Object.hasOwn(expected, "mandateSha256") && approved.mandateSha256 !== expected.mandateSha256)
  )) return null;
  return approved;
}

type ReviewRequirement = { axis: ScopeReviewAxisValue; lensId: null } | { axis: null; lensId: string };

function requiredReviews(declaration: ScopeValue): ReviewRequirement[] {
  if (declaration.reviewPlan === null) return SCOPE_REVIEW_AXES.map(axis => ({ axis, lensId: null }));
  if (declaration.reviewPlan.kind === "exempt" || declaration.reviewPlan.kind === "not-required") return [];
  return declaration.reviewPlan.lenses.map(lens => ({ axis: null, lensId: lens.id }));
}

function mandateDigest(declaration: ScopeValue): string | null {
  return declaration.reviewPlan === null ? null : sha256Hex(canonicalJson(declaration.reviewPlan));
}

/** The discharge evidence a gated transition commits with: for every
 *  required axis, the latest review revision bound to the round pin —
 *  matching (assignmentId, scopeId, axis, scopeRevision, candidateSnapshot)
 *  exactly. Observations requalify against the CURRENT owner/writer at
 *  discharge time: a review authored by the effective owner approving the
 *  gate, or by the pinned declaration's declared writer, never discharges
 *  it — the row remains valid history, it simply cannot serve as this
 *  owner's independent evidence. A missing axis yields null and the
 *  transition rejects. */
function qualifyRoundReviews(
  ledger: Readonly<LedgerValue>,
  assignmentId: string,
  scopeId: string,
  round: ScopeRoundPin,
  declaration: ScopeValue,
  excludedReviewerIds: ReadonlySet<string>,
): { eligibleReviewIds: string[]; discharged: DeskScopeDischargeValue[] | null } {
  const requirements = requiredReviews(declaration);
  const eligible = ledger.scopeReviews.filter(r =>
    r.assignmentId === assignmentId && r.scopeId === scopeId &&
    r.scopeRevision === round.scopeRevision && r.briefRevision === round.briefRevision &&
    r.mandateSha256 === round.mandateSha256 && r.candidateSnapshot === round.candidateSnapshot &&
    !excludedReviewerIds.has(r.reviewerAgentId) &&
    requirements.some(required => r.axis === required.axis && r.lensId === required.lensId));
  const eligibleReviewIds = eligible.map(row => row.reviewId);
  const discharged: DeskScopeDischargeValue[] = [];
  for (const required of requirements) {
    const bound = eligible
      .filter(
        r =>
          r.axis === required.axis &&
          r.lensId === required.lensId,
      )
      .sort((a, b) => {
        const eventSeq = (row: ScopeReviewValue) => ledger.requests.find(request => request.assignmentId === row.assignmentId && request.requestId === row.requestId && request.actorKey === `agent:${row.reviewerAgentId}`)?.eventSeqs?.[1] ?? 0;
        return eventSeq(a) - eventSeq(b) || a.revision - b.revision || a.reviewerAgentId.localeCompare(b.reviewerAgentId);
      });
    const latest = bound[bound.length - 1];
    if (latest === undefined) return { eligibleReviewIds, discharged: null };
    discharged.push(required.axis !== null
      ? { axis: required.axis, reviewId: latest.reviewId }
      : { lensId: required.lensId, reviewId: latest.reviewId });
  }
  return { eligibleReviewIds, discharged };
}

function currentBriefRevision(ledger: Readonly<LedgerValue>, assignmentId: string): number {
  return ledger.briefRevisions.filter(row => row.assignmentId === assignmentId).reduce((max, row) => Math.max(max, row.revision), 0);
}

/** Current qualification shared by scope gates, promotion and read views.
 * Historical observations remain intact; only the current pins and owner/
 * writer independence determine whether they can carry a present gate. */
export function currentScopeReviewQualification(
  ledger: Readonly<LedgerValue>,
  assignment: AssignmentValue,
  scopeId: string,
  options: { includeClosedApproval?: boolean } = {},
) {
  const declaration = declarationStream(ledger, assignment.assignmentId, scopeId).at(-1) ?? null;
  const transitions = transitionStream(ledger, assignment.assignmentId, scopeId);
  const active = activeRound(transitions);
  const briefRevision = currentBriefRevision(ledger, assignment.assignmentId);
  const approved = declaration === null ? null : approvedScopeRound(transitions, {
    briefRevision, scopeRevision: declaration.revision, mandateSha256: mandateDigest(declaration), includeClosedApproval: options.includeClosedApproval,
  });
  const round = active ?? approved;
  const roundCurrent = declaration !== null && round !== null &&
    declaration.briefRevision === briefRevision && round.briefRevision === briefRevision &&
    round.scopeRevision === declaration.revision && round.mandateSha256 === mandateDigest(declaration);
  const qualified = roundCurrent
    ? qualifyRoundReviews(ledger, assignment.assignmentId, scopeId, round, declaration,
      currentReviewExclusions(ledger, assignment, declaration))
    : { eligibleReviewIds: [] as string[], discharged: null };
  const independentApproval = approved !== null && roundCurrent &&
    approved.discharged.every(entry => qualified.eligibleReviewIds.includes(entry.reviewId));
  return {
    declaration, activeRound: active, round, roundCurrent,
    eligibleReviewIds: qualified.eligibleReviewIds, discharged: qualified.discharged,
    standingApproval: independentApproval && transitions.at(-1)?.to !== "closed" ? approved : null,
    terminalApproval: independentApproval && transitions.at(-1)?.to === "closed" && transitions.at(-1)?.command === "close" && transitions.at(-1)?.from === "approved" ? approved : null,
  };
}

function currentLiveSeat(ledger: Readonly<LedgerValue>, assignment: AssignmentValue, agentId: string): boolean {
  if (effectiveOwner(ledger, assignment).agentId === agentId) return true;
  const seat = assignment.seats.find(row => row.agentId === agentId);
  if (seat === undefined) return false;
  const member = ledger.memberships.find(row => row.membershipId === seat.membershipId);
  return member !== undefined && member.agentId === agentId && member.state !== "revoked" && member.registeredAt !== null;
}

function latestScopeDeclarations(ledger: Readonly<LedgerValue>, assignmentId: string): Map<string, ScopeValue> {
  const latest = new Map<string, ScopeValue>();
  for (const row of ledger.scopes.filter(scope => scope.assignmentId === assignmentId).sort((a, b) => a.revision - b.revision)) {
    const prior = latest.get(row.scopeId);
    if (prior === undefined || row.revision > prior.revision) latest.set(row.scopeId, row);
  }
  return latest;
}

function dependencyProblem(
  ledger: Readonly<LedgerValue>,
  assignmentId: string,
  scopeId: string,
  ownership: ScopeValue["ownership"],
): DeskRejectionValue | null {
  if (ownership === null) return null;
  const latest = latestScopeDeclarations(ledger, assignmentId);
  for (const dependency of ownership.dependsOnScopeIds) {
    if (dependency === scopeId || !latest.has(dependency)) {
      return reject("SCOPE_CONFLICT", `scope dependency ${JSON.stringify(dependency)} does not resolve to another declared scope`, "dependencies name an existing different scope on the same assignment");
    }
  }
  const edges = new Map([...latest].map(([id, row]) => [id, row.ownership?.dependsOnScopeIds ?? []]));
  edges.set(scopeId, ownership.dependsOnScopeIds);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const next of [...(edges.get(id) ?? [])].sort()) if (!visit(next)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const id of [...edges.keys()].sort()) {
    if (!visit(id)) return reject("SCOPE_CONFLICT", "declared scope dependencies contain a cycle", "remove an edge in the dependency cycle before declaring the moving scope");
  }
  return null;
}

function ownershipShapeProblem(
  ledger: Readonly<LedgerValue>,
  assignment: AssignmentValue,
  ownership: ScopeValue["ownership"],
): DeskRejectionValue | null {
  if (ownership === null) return null;
  if (!currentLiveSeat(ledger, assignment, ownership.writerAgentId)) {
    return reject("AUTHORITY_REQUIRED", "the declared writer is not the assignment owner or a current live attached seat", "bind a live writer to the assignment before declaring the moving scope");
  }
  if (ownership.writerAgentId === effectiveOwner(ledger, assignment).agentId) {
    if (ownership.writerAuthorityRef === null) return reject("AUTHORITY_REQUIRED", "a direct owner-writer declaration needs an explicit bounded grant pointer", "record the direct-write grant reference; the pointer remains a claim");
  } else if (ownership.writerAuthorityRef !== null) {
    return reject("INVALID_RECORD", "writerAuthorityRef is only used for an owner Lead direct-write grant", "attached-seat writers inherit no direct-write grant claim");
  }
  const stateRefs = new Set<string>();
  const moduleRefs = new Set<string>();
  for (const owner of ownership.stateOwners) {
    if (stateRefs.has(owner.stateRef) || moduleRefs.has(owner.moduleRef) || canonicalWorkspacePath(owner.moduleRef) !== owner.moduleRef) {
      return reject("INVALID_RECORD", "stateOwners must name distinct canonical state and module owners", "use one canonical module owner for each distinct state owner");
    }
    stateRefs.add(owner.stateRef);
    moduleRefs.add(owner.moduleRef);
  }
  for (const notification of ownership.notifications) {
    if (!currentLiveSeat(ledger, assignment, notification.recipientAgentId)) {
      return reject("INVALID_RECORD", "a notification intent names no current assignment owner or attached seat", "notification intent records a recipient and event but does not send a message");
    }
  }
  return null;
}

function overlapProblem(
  ledger: Readonly<LedgerValue>,
  assignmentId: string,
  scopeId: string,
  ownership: ScopeValue["ownership"],
): DeskRejectionValue | null {
  if (ownership === null) return null;
  const conflicts: string[] = [];
  for (const assignment of ledger.assignments.filter(row => row.state === "open").sort((a, b) => a.assignmentId.localeCompare(b.assignmentId))) {
    const latest = latestScopeDeclarations(ledger, assignment.assignmentId);
    for (const other of [...latest.values()].sort((a, b) => a.scopeId.localeCompare(b.scopeId))) {
      if (assignment.assignmentId === assignmentId && other.scopeId === scopeId) continue;
      if (other.ownership === null) continue;
      const stream = transitionStream(ledger, other.assignmentId, other.scopeId);
      const state = stream.at(-1)?.to ?? "declared";
      if (state === "advanced" || state === "closed") continue;
      for (const left of ownership.paths) {
        for (const right of other.ownership.paths) {
          if (workspacePathsOverlap(left, right)) conflicts.push(`${other.assignmentId}/${other.scopeId}:path:${right}`);
        }
      }
      for (const left of ownership.resources) {
        for (const right of other.ownership.resources) if (left === right) conflicts.push(`${other.assignmentId}/${other.scopeId}:resource:${right}`);
      }
      for (const left of ownership.stateOwners) {
        for (const right of other.ownership.stateOwners) {
          if (left.stateRef === right.stateRef) conflicts.push(`${other.assignmentId}/${other.scopeId}:state:${right.stateRef}`);
          if (left.moduleRef === right.moduleRef) conflicts.push(`${other.assignmentId}/${other.scopeId}:module:${right.moduleRef}`);
        }
      }
    }
  }
  if (conflicts.length === 0) return null;
  conflicts.sort();
  return reject("SCOPE_CONFLICT", `declared moving scope overlaps ${conflicts[0]}`, "active moving scopes cannot claim overlapping declared paths, resources or state ownership");
}

function validateOwnership(
  ledger: Readonly<LedgerValue>,
  assignment: AssignmentValue,
  scopeId: string,
  ownership: ScopeValue["ownership"],
): DeskRejectionValue | null {
  if (ownership === null) return null;
  for (const path of ownership.paths) {
    if (canonicalWorkspacePath(path) !== path) return reject("INVALID_RECORD", `scope path ${JSON.stringify(path)} is not canonical relative POSIX`, "paths are canonical relative workspace surfaces; no glob or parent segment is accepted");
  }
  const shape = ownershipShapeProblem(ledger, assignment, ownership);
  if (shape !== null) return shape;
  const dependency = dependencyProblem(ledger, assignment.assignmentId, scopeId, ownership);
  if (dependency !== null) return dependency;
  return overlapProblem(ledger, assignment.assignmentId, scopeId, ownership);
}

// ---------------------------------------------------------------------------
// decide — synchronous and pure.
// ---------------------------------------------------------------------------

export function decideDeskScope(ledger: Readonly<LedgerValue>, command: Record<string, unknown>): DecideOutcome {
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
    const briefRevision = currentBriefRevision(ledger, assignment.assignmentId);
    if ((cmd.expectedBriefRevision ?? (briefRevision === 0 ? 0 : undefined)) !== briefRevision) {
      return reject("REVISION_CONFLICT", "scope declaration must pin the current operative brief revision", "re-read the assignment brief and declare against its current revision");
    }
    const ownership = cmd.ownership ?? null;
    const ownershipError = validateOwnership(ledger, assignment, cmd.scopeId, ownership);
    if (ownershipError !== null) return ownershipError;
    const stream = declarationStream(ledger, cmd.assignmentId, cmd.scopeId);
    const latest = stream[stream.length - 1];
    if (cmd.reviewPlan === undefined && latest === undefined) {
      return reject("AUTHORITY_REQUIRED", "a new scope requires an explicit review decision", "select a required, exempt or not-required plan; explicit null opts into the legacy two-axis rule");
    }
    // Resolve omission under the writer lock; hashing the omitted request
    // preserves its original outcome on replay after later plan amendments.
    const reviewPlan = cmd.reviewPlan === undefined ? latest!.reviewPlan : cmd.reviewPlan;
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
      briefRevision,
      ownership,
      reviewPlan,
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
              briefRevision,
              mandateSha256: reviewPlan === null ? null : sha256Hex(canonicalJson(reviewPlan)),
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
          briefRevision,
          mandateSha256: scopeRow.reviewPlan === null ? null : sha256Hex(canonicalJson(scopeRow.reviewPlan)),
          ownershipSha256: scopeRow.ownership === null ? null : sha256Hex(canonicalJson(scopeRow.ownership)),
          reviewPlanSha256: scopeRow.reviewPlan === null ? null : sha256Hex(canonicalJson(scopeRow.reviewPlan)),
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
    const currentBrief = currentBriefRevision(ledger, cmd.assignmentId);
    if (latestDeclaration.briefRevision !== currentBrief ||
        (cmd.briefRevision ?? (currentBrief === 0 ? 0 : undefined)) !== currentBrief) {
      return reject("REVISION_CONFLICT", "the scope is stale against the operative brief", "amend the scope declaration to pin the current brief before moving its state");
    }
    const mandateSha256 = mandateDigest(latestDeclaration);
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
      const overlap = overlapProblem(ledger, cmd.assignmentId, cmd.scopeId, latestDeclaration.ownership);
      if (overlap !== null) return overlap;
    } else if (cmd.candidateSnapshot !== null || cmd.candidateHead !== null) {
      return reject(
        "INVALID_RECORD",
        "only submit-for-review carries a candidate pin",
        "candidate fields on another transition are a malformed command, not a rebind",
      );
    }
    // The review gate — requirements come only from the immutable scope
    // revision and its pinned authority-backed plan. A changed declaration,
    // brief or mandate invalidates the standing round until a fresh round
    // binds the current pins. Every review-dependent edge, including approve,
    // resolves the exact active round again in this transaction so an
    // amendment between review-observed and approval cannot rebind old work.
    // A gated command with no round typed-rejects; early close is also not an
    // edge in the shared transition table.
    const gated = (SCOPE_REVIEW_GATED_COMMANDS as readonly string[]).includes(cmd.transition);
    const qualification = currentScopeReviewQualification(ledger, assignment, cmd.scopeId);
    const round = qualification.activeRound;
    let discharged: DeskScopeDischargeValue[] = [];
    if (gated && round !== null) {
      if (
        round.scopeRevision !== latestDeclaration.revision ||
        round.briefRevision !== currentBrief ||
        round.briefRevision !== latestDeclaration.briefRevision ||
        round.mandateSha256 !== mandateSha256
      ) {
        return reject("REVISION_CONFLICT", "the active review round is stale against the current scope, brief or review mandate", "redeclare against the current brief and submit a fresh candidate round");
      }
      const roundDeclaration = declarations.find(row => row.revision === round.scopeRevision);
      if (roundDeclaration === undefined) return reject("INVALID_RECORD", "the active round scope revision is absent", "the store history is inconsistent and needs inspection");
      // Discharge requalifies existing observations against the CURRENT
      // owner and the round declaration's writer through the shared
      // resolver: an observation authored by either stays valid history
      // but is not independent evidence — an exact-pinned third-party
      // review still reuses.
      const excludedReviewerIds = currentReviewExclusions(ledger, assignment, roundDeclaration);
      const resolved = qualification.discharged;
      if (resolved === null) {
        const missing = requiredReviews(roundDeclaration).filter(required => !ledger.scopeReviews.some(review =>
          review.assignmentId === cmd.assignmentId && review.scopeId === cmd.scopeId &&
          review.axis === required.axis && review.lensId === required.lensId &&
          review.scopeRevision === round.scopeRevision && review.briefRevision === round.briefRevision &&
          review.mandateSha256 === round.mandateSha256 && review.candidateSnapshot === round.candidateSnapshot &&
          !excludedReviewerIds.has(review.reviewerAgentId),
        )).map(required => required.axis ?? required.lensId);
        return reject(
          "REVIEW_INCOMPLETE",
          missing.length === 0
            ? `transition ${JSON.stringify(cmd.transition)} is missing a review observation for the active round`
            : `transition ${JSON.stringify(cmd.transition)} requires review on ${missing.join(", ")} for the active round`,
          "a bound independent reviewer records each pinned legacy axis or named lens; explicit exemptions resolve to an empty required set",
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
      briefRevision: currentBrief,
      mandateSha256,
      candidateSnapshot,
      candidateHead,
      discharged,
      actorAgentId: actor.agentId as string,
    };
    return ok(
      [{
        kind: "scope-transitioned",
        payload: { assignmentId: cmd.assignmentId, scopeId: cmd.scopeId, command: cmd.transition, from, to: edge.to, revision, scopeRevision: cmd.scopeRevision, briefRevision: currentBrief, mandateSha256, discharged },
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
    return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "look up registered assignments with slp_status; tell the Lead to register the assignment under the current Human grant");
  }
  if (reviewAssignment.state !== "open") {
    return reject("SCOPE_CONFLICT", "the assignment is closed", "closed assignments take no new review observations");
  }
  if (effectiveOwner(ledger, reviewAssignment).agentId === cmd.actorAgentId) {
    return reject(
      "AUTHORITY_REQUIRED",
      "the current assignment owner may not record a review observation",
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
  if (latestDeclaration.seatAgentId === cmd.actorAgentId || latestDeclaration.ownership?.writerAgentId === cmd.actorAgentId) {
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
      "a mid-round change never rebinds the old round — submit and review the current declaration again",
    );
  }
  const currentBrief = currentBriefRevision(ledger, cmd.assignmentId);
  const currentMandate = mandateDigest(latestDeclaration);
  if (
    round.scopeRevision !== latestDeclaration.revision ||
    latestDeclaration.briefRevision !== currentBrief ||
    round.briefRevision !== currentBrief ||
    round.mandateSha256 !== currentMandate ||
    (cmd.briefRevision ?? (currentBrief === 0 ? 0 : undefined)) !== currentBrief
  ) {
    return reject("REVISION_CONFLICT", "the active review round is stale against the current scope, brief or review mandate", "redeclare against the current brief and submit a fresh candidate round");
  }
  if (cmd.candidateSnapshot !== round.candidateSnapshot) {
    return reject(
      "CANDIDATE_DRIFT",
      "the review's candidate does not match the active round's pinned candidate",
      "observations bind the submitted candidate — drift is never a quiet rebind",
    );
  }
  const required = requiredReviews(latestDeclaration);
  const selectedAxis = cmd.axis;
  const selectedLens = cmd.lensId;
  if (!required.some(item => item.axis === (selectedAxis ?? null) && item.lensId === (selectedLens ?? null))) {
    return reject("AUTHORITY_REQUIRED", "the selected axis or named lens is not required by the active review mandate", "record only a review observation named by the pinned authority-backed review plan");
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
        r.axis === (cmd.axis ?? null) &&
        r.lensId === (cmd.lensId ?? null) &&
        r.reviewerAgentId === cmd.actorAgentId,
      )
      .reduce((max, r) => Math.max(max, r.revision), 0) + 1;
  const reviewId = deriveId("srv", [cmd.actorAgentId, cmd.assignmentId, cmd.scopeId, cmd.axis ?? cmd.lensId!, cmd.requestId]);
  const row: ScopeReviewValue = {
    reviewId,
    assignmentId: cmd.assignmentId,
    scopeId: cmd.scopeId,
    requestId: cmd.requestId,
    revision,
    scopeRevision: cmd.scopeRevision,
    candidateSnapshot: cmd.candidateSnapshot,
    axis: cmd.axis ?? null,
    lensId: cmd.lensId ?? null,
    briefRevision: round.briefRevision,
    mandateSha256: round.mandateSha256,
    verdict: cmd.verdict,
    reviewerAgentId: cmd.actorAgentId,
    reviewerSeatId: seat.membershipId,
    findingsRef: cmd.findingsRef,
  };
  return ok(
    [{
      kind: "scope-review-recorded",
      payload: { reviewId, assignmentId: cmd.assignmentId, scopeId: cmd.scopeId, axis: cmd.axis ?? null, lensId: cmd.lensId ?? null, briefRevision: round.briefRevision, mandateSha256: round.mandateSha256, verdict: cmd.verdict, reviewerAgentId: cmd.actorAgentId, revision },
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
  requiredLenses: string[];
  dischargedLenses: string[];
  reviewExempt: boolean;
  reviewDecision: "legacy" | "required" | "exempt" | "not-required";
  transitionCount: number;
    reviews: {
      reviewId: string;
    axis: ScopeReviewAxisValue | null;
    lensId: string | null;
    verdict: ScopeReviewValue["verdict"];
    scopeRevision: number;
    briefRevision: number;
    mandateSha256: string | null;
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
    const participant = deskWorkflowParticipant(ledger, row, assignment);
    if (participant === null) continue;
    const owner = participant !== "attached-seat";
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
        lensId: r.lensId,
        verdict: r.verdict,
        scopeRevision: r.scopeRevision,
        briefRevision: r.briefRevision,
        mandateSha256: r.mandateSha256,
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
                .filter(r => r.briefRevision === round.briefRevision && r.mandateSha256 === round.mandateSha256)
                .map(r => r.axis),
            )];
      const dischargedLenses =
        round === null
          ? []
          : [...new Set(
              ledger.scopeReviews
                .filter(r => r.assignmentId === assignment.assignmentId && r.scopeId === scopeId &&
                  r.scopeRevision === round.scopeRevision && r.candidateSnapshot === round.candidateSnapshot &&
                  r.briefRevision === round.briefRevision && r.mandateSha256 === round.mandateSha256)
                .map(r => r.lensId)
                .filter((lensId): lensId is string => lensId !== null),
            )];
      const required = round === null ? [] : requiredReviews(declarations.find(row => row.revision === round.scopeRevision) ?? latest);
      projected.push({
        scopeId,
        revision: latest.revision,
        label: latest.label,
        declarationSha256: latest.declarationSha256,
        seatAgentId: latest.seatAgentId,
        state,
        activeScopeRevision: round?.scopeRevision ?? null,
        activeCandidateSnapshot: round?.candidateSnapshot ?? null,
        requiredAxes: required.flatMap(item => item.axis === null ? [] : [item.axis]),
        dischargedAxes: [...new Set(dischargedAxes.filter((axis): axis is ScopeReviewAxisValue => axis !== null))],
        requiredLenses: required.flatMap(item => item.lensId === null ? [] : [item.lensId]),
        dischargedLenses,
        reviewExempt: round !== null && (declarations.find(row => row.revision === round.scopeRevision) ?? latest).reviewPlan?.kind === "exempt",
        reviewDecision: (round === null ? latest : declarations.find(row => row.revision === round.scopeRevision) ?? latest).reviewPlan?.kind ?? "legacy",
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
  let command: z.infer<typeof ScopeDeclareCommand> = {
    kind: "scope.declare" as const,
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId as string,
    assignmentId: input.assignmentId,
    scopeId: input.scopeId,
    label: input.label,
    declarationSha256: input.declarationSha256,
    refs: input.refs,
    seatAgentId: input.seatAgentId,
    ...(input.expectedBriefRevision === undefined ? {} : { expectedBriefRevision: input.expectedBriefRevision }),
    ownership: input.ownership ?? null,
    ...(input.reviewPlan === undefined ? {} : { reviewPlan: input.reviewPlan }),
    reviewPlanInput: input.reviewPlan === undefined ? "omitted" : "explicit",
  };
  // Historical runners normalized omission to null before request hashing.
  // Reuse those bytes only for an exact recorded hash, never for new work.
  {
    const prior = ledger.requests.find(row => row.actorKey === `agent:${ctx.row.agentId}` &&
      row.assignmentId === input.assignmentId && row.requestId === input.requestId);
    const { reviewPlanInput: _reviewPlanInput, ...unmarked } = command;
    const legacyCommand = { ...unmarked, reviewPlan: input.reviewPlan ?? null };
    if (prior?.bodySha256 === canonicalSha256({ repo: repoEnvelope(ledger), command: legacyCommand })) {
      command = legacyCommand;
    }
  }
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
    ...(input.briefRevision === undefined ? {} : { briefRevision: input.briefRevision }),
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
    ...(input.axis === undefined ? {} : { axis: input.axis }),
    ...(input.lensId === undefined ? {} : { lensId: input.lensId }),
    ...(input.briefRevision === undefined ? {} : { briefRevision: input.briefRevision }),
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
  return { ok: true, reviewId: row.reviewId, scopeId: row.scopeId, axis: row.axis, lensId: row.lensId, revision: row.revision, receiptId: settled.receipt.receiptId };
}

/** Internal task cancellation. The public scope transition parser has no
 * cancellation verb/context. Core composes terminal task/control rows and
 * discharged obligations in the same transaction before calling this seam. */
export function decideTaskScopeCancellation(
  ledger: Readonly<LedgerValue>, context: {
    actorAgentId: string; actorMembershipId: string; assignmentId: string;
    attemptId: string; controlId: string; requestId: string;
  },
): DecideOutcome {
  const actor = ledger.memberships.find(row => row.membershipId === context.actorMembershipId && row.agentId === context.actorAgentId);
  if (!actor || actor.state === "revoked" || actor.registeredAt === null) return reject("ACTOR_MISMATCH", "cancellation has no exact live actor", "use the current owner tuple");
  const assignment = requireOwnedOpenAssignment(ledger, actor, context.assignmentId);
  if ("ok" in assignment) return assignment;
  const head = (id: string) => ledger.taskEntries.filter(row => row.entityId === id).at(-1);
  const attempt = head(context.attemptId), control = head(context.controlId);
  if (attempt?.kind !== "attempt" || attempt.assignmentId !== context.assignmentId || attempt.state !== "stopped" ||
      attempt.requestId !== context.requestId || attempt.actorMembershipId !== actor.membershipId || attempt.terminalProof == null ||
      control?.kind !== "control" || control.requestId !== context.requestId || control.assignmentId !== context.assignmentId ||
      control.targetAttemptId !== attempt.attemptId || control.state !== "stop-observed" || control.actorMembershipId !== actor.membershipId) {
    return reject("EVIDENCE_INCOMPLETE", "cancellation lacks same-request terminal attempt and owner control proof", "retain the moving scope until supported cancellation is composed");
  }
  if (attempt.boundScopeId === null) return ok([]);
  const declaration = declarationStream(ledger, assignment.assignmentId, attempt.boundScopeId).at(-1);
  const transitions = transitionStream(ledger, assignment.assignmentId, attempt.boundScopeId);
  const current = transitions.at(-1);
  if (!declaration || declaration.revision !== attempt.boundScopeRevision || current === undefined || current.to === "closed" ||
      declaration.ownership?.writerAgentId !== attempt.member?.agentId) return reject("SCOPE_CONFLICT", "cancellation scope/writer pins differ", "reconcile the exact current writer declaration before cancellation");
  const currentRows = [...new Map(ledger.taskEntries.map(row => [row.entityId, row])).values()];
  if (currentRows.some(row =>
    (row.kind === "action" && row.attemptId === attempt.attemptId && ['intended','issued','uncertain','held'].includes(row.state)) ||
    (row.kind === "resource" && row.attemptId === attempt.attemptId && row.disposition !== "released") ||
    (row.kind === "delivery" && row.attemptId === attempt.attemptId && row.state !== "handled"))) {
    return reject("EVIDENCE_INCOMPLETE", "cancellation still has effect/delivery/resource obligations", "discharge supported obligations under owner authority first");
  }
  const proof = attempt.terminalProof;
  if (proof.kind === "never-authorized-work") {
    if (ledger.taskEntries.some(row => row.kind === "action" && row.attemptId === attempt.attemptId &&
        (row.actionKind === "send" || row.actionKind === "create") && ['issued','observed','uncertain','held'].includes(row.state))) {
      return reject("EVIDENCE_INCOMPLETE", "work may have been authorized or a seat created", "never-authorized-work cannot stand in for process quiescence");
    }
  } else if (proof.observationRefs.length === 0) return reject("EVIDENCE_INCOMPLETE", "quiescence has no positive observation references", "retain uncertain workers and scopes");
  const briefRevision = currentBriefRevision(ledger, assignment.assignmentId);
  if (attempt.briefRevision !== briefRevision || control.briefRevision !== briefRevision) return reject("REVISION_CONFLICT", "cancellation pins a stale scope/brief", "amend the declaration under the current brief before resolving it");
  const taskCancellation = {
    attemptId: attempt.attemptId, attemptRevision: attempt.revision, attemptEntrySha256: attempt.entrySha256,
    controlId: control.controlId, controlEntrySha256: control.entrySha256, proofSha256: canonicalSha256(proof),
  };
  const row: ScopeTransitionValue = {
    transitionId: deriveId("stn", [context.assignmentId, declaration.scopeId, context.requestId, "task-cancel"]),
    assignmentId: context.assignmentId, scopeId: declaration.scopeId, requestId: context.requestId,
    revision: current.revision + 1, command: "task-cancel", from: current.to, to: "closed",
    scopeRevision: declaration.revision, briefRevision, mandateSha256: mandateDigest(declaration),
    candidateSnapshot: null, candidateHead: null, discharged: [], actorAgentId: actor.agentId!, taskCancellation,
  };
  return ok([{ kind: "scope-transitioned", payload: {
    scopeId: row.scopeId, revision: row.revision, scopeRevision: row.scopeRevision, command: row.command,
    from: row.from, to: row.to, briefRevision, mandateSha256: row.mandateSha256, discharged: [], taskCancellation,
  } }], { scopeTransitions: [...ledger.scopeTransitions, row] });
}
