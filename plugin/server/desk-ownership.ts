// Planned succession on one assignment identity — the ownership/history
// core. An offer is a current owner's append-only nomination of one exact
// live lead membership: it binds both tuples and the base ownership
// revision and transfers no authority (the nominee joins neither the
// execution nor the canary cohort by receiving it). An accept is the exact
// nominee's observed acknowledgment — the prior owner's live or retired
// session is irrelevant because every required prior-owner action was
// complete in the offer; the committed ownership revision, not archival,
// atomically removes the former owner's fresh mutation authority. The
// original registration tuple stays immutable history.
//
// Two deliberately different owner predicates live here:
//  - effectiveOwner (current custody) guards every fresh mutation;
//  - ownerAtEventSeq (historical validity) lets the store validate a row
//    under the owner who held custody at that row's own append point.
// A missing bound event is never treated as authorization, and there is no
// unauthenticated recovery path: no offer means no succession.

import { z } from "zod";
import {
  DeskAssignmentAcceptInput,
  DeskAssignmentAcceptResult,
  DeskAssignmentOfferInput,
  DeskAssignmentOfferResult,
  WIRE_LIMITS,
  type DeskAssignmentAcceptInputValue,
  type DeskAssignmentOfferInputValue,
  type DeskRejectionValue,
  type DeskScopeOwnershipValue,
} from "../shared/enforcement.ts";
import {
  effectiveOwner,
  LEDGER_LIMITS,
  lineageOwners,
  type AssignmentValue,
  type DecideOutcome,
  type LedgerValue,
  type MembershipValue,
  type OwnershipAcceptValue,
  type OwnershipOfferValue,
} from "./desk-store.ts";
import { canonicalJson, sha256Hex } from "./config-view.ts";
import { deriveId, liveMembership, requireActor, requireLead } from "./desk-command.ts";
import { isRejection, readLedger, repoEnvelope, type DeskRunnerDeps, type RunnerCtx } from "./desk-runner.ts";

export type { OwnershipAcceptValue, OwnershipOfferValue } from "./desk-store.ts";
export { effectiveOwner, lineageOwners, ownerAtEventSeq } from "./desk-store.ts";
export type { DeskOwnerTuple } from "./desk-store.ts";

const ActorAgentId = z.string().min(1).max(WIRE_LIMITS.agentId);
const OwnershipOfferCommand = DeskAssignmentOfferInput.extend({
  kind: z.literal("ownership.offer"), actorAgentId: ActorAgentId,
}).strict();
const OwnershipAcceptCommand = DeskAssignmentAcceptInput.extend({
  kind: z.literal("ownership.accept"), actorAgentId: ActorAgentId,
}).strict();
const DeskOwnershipCommand = z.discriminatedUnion("kind", [OwnershipOfferCommand, OwnershipAcceptCommand]);

const reject = (code: DeskRejectionValue["code"], message: string, recovery: string): DeskRejectionValue => ({
  ok: false, code, message, recovery,
});

const ok = (events: { kind: string; payload: Record<string, unknown> }[], tables: {
  ownershipOffers?: OwnershipOfferValue[];
  ownershipAccepts?: OwnershipAcceptValue[];
} = {}): DecideOutcome => ({ ok: true, events, ...tables });

/** The single read/discovery predicate for desk workflow content. `actor`
 *  is the caller's bound membership row; participation requires it to be
 *  its agent's live exact row — a stale or revoked pin participates in
 *  nothing. Owner-family participants (current, prior, nominee) share the
 *  owner-scoped read; attached seats keep their seat-scoped visibility. A
 *  stale or losing offer confers no read at all: the nominee predicate
 *  only fires on a still-usable offer at the CURRENT ownership revision of
 *  an OPEN assignment. */
export function deskWorkflowParticipant(
  ledger: Readonly<LedgerValue>,
  actor: MembershipValue,
  assignment: AssignmentValue,
): "current-owner" | "prior-owner" | "attached-seat" | "offer-nominee" | null {
  if (actor.agentId === null) return null;
  const live = liveMembership(ledger, actor.agentId);
  if (live === undefined || live.membershipId !== actor.membershipId) return null;
  const owner = effectiveOwner(ledger, assignment);
  if (owner.agentId === actor.agentId && owner.membershipId === actor.membershipId) return "current-owner";
  const accepts = ledger.ownershipAccepts.filter(row => row.assignmentId === assignment.assignmentId);
  if (lineageOwners(assignment, accepts).some(tuple => tuple.agentId === actor.agentId && tuple.membershipId === actor.membershipId)) {
    return "prior-owner";
  }
  if (assignment.seats.some(seat => seat.agentId === actor.agentId && seat.membershipId === actor.membershipId)) {
    return "attached-seat";
  }
  if (assignment.state === "open" && ledger.ownershipOffers.some(row =>
    row.assignmentId === assignment.assignmentId &&
    row.toAgentId === actor.agentId && row.toMembershipId === actor.membershipId &&
    row.ownershipRevision === owner.ownershipRevision
  )) {
    return "offer-nominee";
  }
  return null;
}

/** The single reviewer-independence qualification every current-discharge
 *  consumer shares — the scope approval gate's fresh discharge resolution,
 *  the rollout promote's standing-approval requalification, and downstream
 *  read surfaces that mark which observations are independent all consume
 *  this one set. A review authored by the CURRENT effective owner or by the
 *  scope declaration's recorded writer stays valid immutable history at its
 *  own event time; it is simply never independent evidence for the
 *  approving owner's gate. Exact-pinned third-party observations keep
 *  reusing across a succession. */
export function currentReviewExclusions(
  ledger: Readonly<Pick<LedgerValue, "ownershipAccepts">>,
  assignment: AssignmentValue,
  declaration: { ownership: DeskScopeOwnershipValue | null },
): ReadonlySet<string> {
  const excluded = new Set<string>([effectiveOwner(ledger, assignment).agentId]);
  const writer = declaration.ownership?.writerAgentId;
  if (writer !== undefined && writer !== null) excluded.add(writer);
  return excluded;
}

/** Pure owner/CAS decision. The store supplies the transaction mutex and
 *  idempotency key; this function never observes clocks or filesystem
 *  state. Both commands derive the actor from the bound live membership —
 *  caller-supplied identity fields do not exist. */
export function decideDeskOwnership(ledger: Readonly<LedgerValue>, command: Record<string, unknown>): DecideOutcome {
  const parsed = DeskOwnershipCommand.safeParse(command);
  if (!parsed.success) return reject("INVALID_RECORD", "command does not match a desk ownership mutation schema", "send only the fields declared for this mutation");
  const cmd = parsed.data;
  const actor = requireActor(ledger, cmd.actorAgentId, "an ownership mutation requires a current live desk membership");
  if ("ok" in actor) return actor;
  const lead = requireLead(actor, "ownership custody moves only between registered leads", "seats participate in workflow but never hold or receive ownership");
  if (lead !== null) return lead;
  const assignment = ledger.assignments.find(row => row.assignmentId === cmd.assignmentId);
  if (assignment === undefined) return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "look up registered assignments with slp_status; tell the Lead to register the assignment under the current Human grant");
  if (assignment.state !== "open") return reject("AUTHORITY_REQUIRED", "the assignment is closed", "closed assignments retain history and accept no ownership mutations");
  const owner = effectiveOwner(ledger, assignment);

  if (cmd.kind === "ownership.offer") {
    if (owner.agentId !== actor.agentId || owner.membershipId !== actor.membershipId) {
      return reject("AUTHORITY_REQUIRED", "only the current effective owner may offer this assignment", "ownership offers bind the owner's exact live membership");
    }
    if (cmd.expectedOwnershipRevision !== owner.ownershipRevision) {
      return reject("REVISION_CONFLICT", `expected ownership revision ${cmd.expectedOwnershipRevision} but the current revision is ${owner.ownershipRevision}`, "re-read the assignment and retry the offer against its current ownership revision");
    }
    const target = liveMembership(ledger, cmd.targetAgentId);
    if (target === undefined || target.role !== "lead" || target.membershipId !== cmd.targetMembershipId) {
      return reject("ACTOR_MISMATCH", "the nomination target is not a live registered lead membership", "offer to the target's exact current membership — a rebound or revoked pin cannot be nominated");
    }
    if (cmd.targetAgentId === actor.agentId && cmd.targetMembershipId === actor.membershipId) {
      return reject("INVALID_RECORD", "an owner cannot offer the assignment to its own pinned membership", "succession requires a different exact live lead membership");
    }
    if (ledger.ownershipOffers.length >= LEDGER_LIMITS.ownershipOffers) {
      return reject("INVALID_RECORD", `ownershipOffers table is at the ${LEDGER_LIMITS.ownershipOffers} cap`, "the offer history is bounded and is never pruned by this workflow");
    }
    const row: OwnershipOfferValue = {
      offerId: deriveId("ofr", [actor.agentId as string, assignment.assignmentId, cmd.requestId]),
      assignmentId: assignment.assignmentId,
      requestId: cmd.requestId,
      ownershipRevision: owner.ownershipRevision,
      fromAgentId: actor.agentId as string,
      fromMembershipId: actor.membershipId,
      toAgentId: cmd.targetAgentId,
      toMembershipId: cmd.targetMembershipId,
      authorityRef: cmd.authorityRef,
      contextRef: cmd.contextRef,
    };
    return ok([{
      kind: "ownership-offered",
      payload: {
        offerId: row.offerId, assignmentId: row.assignmentId, requestId: row.requestId,
        ownershipRevision: row.ownershipRevision,
        fromAgentId: row.fromAgentId, fromMembershipId: row.fromMembershipId,
        toAgentId: row.toAgentId, toMembershipId: row.toMembershipId,
        authorityRef: row.authorityRef, contextRef: row.contextRef,
      },
    }], { ownershipOffers: [...ledger.ownershipOffers, row] });
  }

  // ownership.accept — only the offer's exact nominee tuple may write it.
  // Every pin is re-checked under the store lock: a stale offer, a
  // moved ownership/ledger/brief revision, or a competing accept that
  // landed first all reject as revision conflicts.
  const offer = ledger.ownershipOffers.find(row => row.offerId === cmd.offerId && row.assignmentId === cmd.assignmentId);
  if (offer === undefined) {
    return reject("AUTHORITY_REQUIRED", "no ownership offer authorizes this acceptance", "acceptance requires an offer row naming the caller's exact membership");
  }
  if (offer.toAgentId !== actor.agentId || offer.toMembershipId !== actor.membershipId) {
    return reject("AUTHORITY_REQUIRED", "only the offer's exact nominee membership may accept it", "acceptance binds the nominated tuple — no other caller or membership qualifies");
  }
  // The prior owner's session state is deliberately not a gate: every
  // required prior-owner action was complete at offer time, so the
  // receiving owner may acknowledge while the old exact membership is
  // still live or after it retired. The committed ownership revision is
  // what atomically denies the former owner's fresh writes — liveness is
  // never an ownership mutex or a cleanup receipt.
  if (offer.ownershipRevision !== owner.ownershipRevision || cmd.expectedOwnershipRevision !== owner.ownershipRevision) {
    return reject("REVISION_CONFLICT", "the offer is stale against the current ownership revision", "a successor already accepted or the revision moved — restart from the current ownership state");
  }
  if (ledger.ownershipAccepts.some(row => row.offerId === offer.offerId)) {
    return reject("REVISION_CONFLICT", "this offer is already accepted", "an accepted offer is immutable history — it cannot be accepted twice");
  }
  if (cmd.expectedLedgerRevision !== ledger.revision) {
    return reject("REVISION_CONFLICT", `expected ledger revision ${cmd.expectedLedgerRevision} but the current revision is ${ledger.revision}`, "re-read the ledger and retry the acceptance against its current revision");
  }
  const briefRevision = ledger.briefRevisions.filter(row => row.assignmentId === assignment.assignmentId).at(-1)?.revision ?? 0;
  if (cmd.expectedBriefRevision !== briefRevision) {
    return reject("REVISION_CONFLICT", `expected brief revision ${cmd.expectedBriefRevision} but the current revision is ${briefRevision}`, "re-read the assignment and retry the acceptance against its current operative brief");
  }
  if (ledger.ownershipAccepts.length >= LEDGER_LIMITS.ownershipAccepts) {
    return reject("INVALID_RECORD", `ownershipAccepts table is at the ${LEDGER_LIMITS.ownershipAccepts} cap`, "the acceptance history is bounded and is never pruned by this workflow");
  }
  const gaps: string[] = [];
  if (cmd.settlementRef === null && cmd.resources.length === 0) gaps.push("settlement-account-missing");
  const row: OwnershipAcceptValue = {
    acceptId: deriveId("acc", [actor.agentId as string, assignment.assignmentId, cmd.requestId]),
    offerId: offer.offerId,
    assignmentId: assignment.assignmentId,
    requestId: cmd.requestId,
    ownershipRevision: offer.ownershipRevision + 1,
    // The bound tuples copy the offer verbatim — an acceptance cannot
    // re-point either side of the succession it completes.
    fromAgentId: offer.fromAgentId,
    fromMembershipId: offer.fromMembershipId,
    toAgentId: offer.toAgentId,
    toMembershipId: offer.toMembershipId,
    acknowledgment: cmd.acknowledgment,
    settlementRef: cmd.settlementRef,
    resources: cmd.resources,
    gaps,
    ledgerRevision: ledger.revision,
    briefRevision,
  };
  return ok([{
    kind: "ownership-accepted",
    payload: {
      acceptId: row.acceptId, offerId: row.offerId, assignmentId: row.assignmentId, requestId: row.requestId,
      ownershipRevision: row.ownershipRevision,
      fromAgentId: row.fromAgentId, fromMembershipId: row.fromMembershipId,
      toAgentId: row.toAgentId, toMembershipId: row.toMembershipId,
      acknowledgment: row.acknowledgment, settlementRef: row.settlementRef,
      ledgerRevision: row.ledgerRevision, briefRevision: row.briefRevision,
      resourcesSha256: sha256Hex(canonicalJson(row.resources)),
      gapsSha256: sha256Hex(canonicalJson(row.gaps)),
    },
  }], { ownershipAccepts: [...ledger.ownershipAccepts, row] });
}

/** Runner preflight — the exact current live caller membership must verify
 *  before any historical receipt is answered: a replay resolves its
 *  original immutable row and is never a fresh write, but it is only
 *  answered to a currently-live exact member. */
function requireLiveCaller(
  ledger: Readonly<LedgerValue>,
  ctx: RunnerCtx,
): MembershipValue | DeskRejectionValue {
  if (ctx.row.agentId === null) {
    return reject("ACTOR_MISMATCH", "the caller's membership is not bound to an agent", "ownership tools require an agent-bound live membership");
  }
  const live = liveMembership(ledger, ctx.row.agentId);
  if (live === undefined || live.membershipId !== ctx.row.membershipId) {
    return reject("STALE_EPOCH", "the caller's membership is no longer the live exact row", "rebind the session and retry — no receipt is answered to a stale membership");
  }
  return live;
}

export async function runAssignmentOffer(
  ctx: RunnerCtx,
  input: DeskAssignmentOfferInputValue,
  deps: DeskRunnerDeps,
): Promise<Record<string, unknown> | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const caller = requireLiveCaller(ledger, ctx);
  if ("ok" in caller) return caller;
  const command = { kind: "ownership.offer", ...input, actorAgentId: ctx.row.agentId as string };
  const settled = await deps.store.transact(ctx.repoKey, {
    repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId,
    requestId: input.requestId, command,
  }, decideDeskOwnership);
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  // The durable (fromAgentId, requestId) key resolves the ORIGINAL
  // immutable offer row — a replayed request returns the same row even
  // after a successor has replaced this owner.
  const row = after.ownershipOffers.find(candidate =>
    candidate.assignmentId === input.assignmentId && candidate.requestId === input.requestId &&
    candidate.fromAgentId === ctx.row.agentId);
  if (row === undefined) return reject("CAPABILITY_GAP", "the offer committed but its row is not readable", "retry the identical request to rebuild its response from the immutable offer");
  return DeskAssignmentOfferResult.parse({
    ok: true, receiptId: settled.receipt.receiptId, assignmentId: row.assignmentId,
    offerId: row.offerId, ownershipRevision: row.ownershipRevision,
  });
}

export async function runAssignmentAccept(
  ctx: RunnerCtx,
  input: DeskAssignmentAcceptInputValue,
  deps: DeskRunnerDeps,
): Promise<Record<string, unknown> | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const caller = requireLiveCaller(ledger, ctx);
  if ("ok" in caller) return caller;
  const command = { kind: "ownership.accept", ...input, actorAgentId: ctx.row.agentId as string };
  const settled = await deps.store.transact(ctx.repoKey, {
    repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId,
    requestId: input.requestId, command,
  }, decideDeskOwnership);
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.ownershipAccepts.find(candidate =>
    candidate.assignmentId === input.assignmentId && candidate.requestId === input.requestId &&
    candidate.toAgentId === ctx.row.agentId);
  if (row === undefined) return reject("CAPABILITY_GAP", "the acceptance committed but its row is not readable", "retry the identical request to rebuild its response from the immutable acceptance");
  return DeskAssignmentAcceptResult.parse({
    ok: true, receiptId: settled.receipt.receiptId, assignmentId: row.assignmentId,
    offerId: row.offerId, acceptId: row.acceptId, ownershipRevision: row.ownershipRevision, gaps: row.gaps,
  });
}
