// Durable assignment workflow records and the shared read-only projection.
// Authority and provenance pointers are retained as claims; this module
// never opens a referenced file or decides project acceptance.

import { z } from "zod";
import {
  DeskAssignmentAmendInput,
  DeskAssignmentAmendResult,
  DeskDecisionAppendInput,
  DeskDecisionAppendResult,
  DeskWorkflowProjection,
  DeskWorkflowProjectionPageInput,
  DeskWorkflowSection,
  WIRE_LIMITS,
  type DeskAssignmentAmendInputValue,
  type DeskDecisionAppendInputValue,
  type DeskRejectionValue,
  type DeskWorkflowProjectionItemValue,
  type DeskWorkflowProjectionPageInputValue,
  type DeskWorkflowProjectionValue,
} from "../shared/enforcement.ts";
import {
  effectiveOwner,
  LEDGER_LIMITS,
  type AssignmentValue,
  type BriefRevisionValue,
  type DecisionEntryValue,
  type DecideOutcome,
  type HandbackValue,
  type LedgerValue,
  type MembershipValue,
} from "./desk-store.ts";
import { canonicalJson, canonicalSha256 } from "./config-view.ts";
import { requireActor as requireDeskActor } from "./desk-command.ts";
import { deskWorkflowParticipant } from "./desk-ownership.ts";
import { currentScopeReviewQualification } from "./desk-scope.ts";
import { isRejection, readLedger, repoEnvelope, type DeskRunnerDeps, type RunnerCtx } from "./desk-runner.ts";

const ActorAgentId = z.string().min(1).max(WIRE_LIMITS.agentId);
const AssignmentAmendCommand = DeskAssignmentAmendInput.extend({
  kind: z.literal("assignment.amend"), actorAgentId: ActorAgentId,
}).strict();
const DecisionAppendCommand = DeskDecisionAppendInput.extend({
  kind: z.literal("decision.append"), actorAgentId: ActorAgentId,
}).strict();
const DeskAssignmentCommand = z.discriminatedUnion("kind", [AssignmentAmendCommand, DecisionAppendCommand]);

const reject = (code: DeskRejectionValue["code"], message: string, recovery: string): DeskRejectionValue => ({
  ok: false, code, message, recovery,
});

const ok = (events: { kind: string; payload: Record<string, unknown> }[], tables: {
  briefRevisions?: BriefRevisionValue[];
  decisionEntries?: DecisionEntryValue[];
} = {}): DecideOutcome => ({ ok: true, events, ...tables });

function assignmentForMutation(
  ledger: Readonly<LedgerValue>,
  actor: MembershipValue,
  assignmentId: string,
): AssignmentValue | DeskRejectionValue {
  const assignment = ledger.assignments.find(row => row.assignmentId === assignmentId);
  if (assignment === undefined) return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "mutations require the durable assignment binding");
  const owner = effectiveOwner(ledger, assignment);
  if (owner.agentId !== actor.agentId || owner.membershipId !== actor.membershipId) {
    return reject("AUTHORITY_REQUIRED", "only the current effective owner may amend assignment records", "attached seats may read and report, but only the owner's exact live membership mutates this assignment");
  }
  if (assignment.state !== "open") return reject("AUTHORITY_REQUIRED", "the assignment is closed", "closed assignments retain history and accept no new workflow mutations");
  return assignment;
}

function currentBriefRows(ledger: Readonly<LedgerValue>, assignmentId: string): BriefRevisionValue[] {
  return ledger.briefRevisions.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.revision - b.revision);
}

function currentBriefRevision(ledger: Readonly<LedgerValue>, assignmentId: string): number {
  const rows = currentBriefRows(ledger, assignmentId);
  return rows.at(-1)?.revision ?? 0;
}

function briefEntryDigest(row: Omit<BriefRevisionValue, "entrySha256">): string {
  return canonicalSha256(row);
}

function decisionEntryDigest(row: Omit<DecisionEntryValue, "entrySha256">): string {
  return canonicalSha256(row);
}

/** Pure owner/CAS decision. The store supplies the transaction mutex and
 *  idempotency key; this function never observes clocks or filesystem state. */
export function decideDeskAssignment(ledger: Readonly<LedgerValue>, command: Record<string, unknown>): DecideOutcome {
  const parsed = DeskAssignmentCommand.safeParse(command);
  if (!parsed.success) return reject("INVALID_RECORD", "command does not match a desk workflow mutation schema", "send only the fields declared for this mutation");
  const cmd = parsed.data;
  const actor = requireDeskActor(ledger, cmd.actorAgentId, "a workflow mutation requires a current live desk membership");
  if ("ok" in actor) return actor;
  const assignment = assignmentForMutation(ledger, actor, cmd.assignmentId);
  if ("ok" in assignment) return assignment;
  const latestBrief = currentBriefRevision(ledger, assignment.assignmentId);
  if (cmd.expectedBriefRevision !== latestBrief) {
    return reject("REVISION_CONFLICT", `expected brief revision ${cmd.expectedBriefRevision} but the current revision is ${latestBrief}`, "re-read the assignment and retry the intended change with its current brief revision");
  }

  if (cmd.kind === "assignment.amend") {
    if (ledger.briefRevisions.length >= LEDGER_LIMITS.briefRevisions) {
      return reject("INVALID_RECORD", `briefRevisions table is at the ${LEDGER_LIMITS.briefRevisions} cap`, "the revision history is bounded and is never pruned by this workflow");
    }
    const stream = currentBriefRows(ledger, assignment.assignmentId);
    const prior = stream.at(-1);
    const revision = latestBrief + 1;
    const withoutDigest = {
      assignmentId: assignment.assignmentId,
      revision,
      priorRevision: prior?.revision ?? 0,
      priorEntrySha256: prior?.entrySha256 ?? null,
      body: cmd.brief,
      bodySha256: canonicalSha256(cmd.brief),
      authorityRef: cmd.authorityRef,
      changeReason: cmd.changeReason,
      affectedOwners: cmd.affectedOwners,
      actorMembershipId: actor.membershipId,
      actorAgentId: actor.agentId as string,
      requestId: cmd.requestId,
    } satisfies Omit<BriefRevisionValue, "entrySha256">;
    const row: BriefRevisionValue = { ...withoutDigest, entrySha256: briefEntryDigest(withoutDigest) };
    const rows = [...ledger.briefRevisions, row];
    return ok([{
      kind: "brief-revision-appended",
      payload: {
        assignmentId: row.assignmentId, revision: row.revision, priorRevision: row.priorRevision,
        priorEntrySha256: row.priorEntrySha256, requestId: row.requestId,
        actorAgentId: row.actorAgentId, actorMembershipId: row.actorMembershipId,
        authorityRef: row.authorityRef, changeReason: row.changeReason,
        affectedOwners: row.affectedOwners, bodySha256: row.bodySha256, entrySha256: row.entrySha256,
      },
    }], { briefRevisions: rows });
  }

  if (latestBrief === 0 || cmd.decision.affectedBriefRevision !== latestBrief) {
    return reject("REVISION_CONFLICT", "a material decision must name the current operative brief revision", "publish a meaningful brief first and bind the decision to its current revision");
  }
  if (ledger.decisionEntries.length >= LEDGER_LIMITS.decisionEntries) {
    return reject("INVALID_RECORD", `decisionEntries table is at the ${LEDGER_LIMITS.decisionEntries} cap`, "the decision history is bounded and is never pruned by this workflow");
  }
  const stream = ledger.decisionEntries.filter(row => row.assignmentId === assignment.assignmentId).sort((a, b) => a.revision - b.revision);
  const prior = stream.at(-1);
  const revision = (prior?.revision ?? 0) + 1;
  const decisionId = `decision-${canonicalSha256({ assignmentId: assignment.assignmentId, actorAgentId: actor.agentId, requestId: cmd.requestId }).slice(0, 32)}`;
  const withoutDigest = {
    decisionId,
    assignmentId: assignment.assignmentId,
    revision,
    priorDecisionId: prior?.decisionId ?? null,
    priorEntrySha256: prior?.entrySha256 ?? null,
    body: cmd.decision,
    bodySha256: canonicalSha256(cmd.decision),
    authorityRef: cmd.authorityRef,
    actorMembershipId: actor.membershipId,
    actorAgentId: actor.agentId as string,
    requestId: cmd.requestId,
  } satisfies Omit<DecisionEntryValue, "entrySha256">;
  const row: DecisionEntryValue = { ...withoutDigest, entrySha256: decisionEntryDigest(withoutDigest) };
  return ok([{
    kind: "decision-entry-appended",
    payload: {
      assignmentId: row.assignmentId, decisionId: row.decisionId, revision: row.revision,
      priorDecisionId: row.priorDecisionId, priorEntrySha256: row.priorEntrySha256,
      requestId: row.requestId, actorAgentId: row.actorAgentId, actorMembershipId: row.actorMembershipId,
      authorityRef: row.authorityRef, bodySha256: row.bodySha256, entrySha256: row.entrySha256,
    },
  }], { decisionEntries: [...ledger.decisionEntries, row] });
}

export async function runAssignmentAmend(
  ctx: RunnerCtx,
  input: DeskAssignmentAmendInputValue,
  deps: DeskRunnerDeps,
): Promise<Record<string, unknown> | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = { kind: "assignment.amend", ...input, actorAgentId: ctx.row.agentId as string };
  const settled = await deps.store.transact(ctx.repoKey, {
    repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId,
    requestId: input.requestId, command,
  }, decideDeskAssignment);
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.briefRevisions.find(candidate => candidate.assignmentId === input.assignmentId && candidate.requestId === input.requestId && candidate.actorAgentId === ctx.row.agentId);
  if (row === undefined) return reject("CAPABILITY_GAP", "the amendment committed but its revision is not readable", "retry the identical request to rebuild its response from the immutable revision");
  return DeskAssignmentAmendResult.parse({ ok: true, assignmentId: row.assignmentId, revision: row.revision, entrySha256: row.entrySha256, receiptId: settled.receipt.receiptId });
}

export async function runDecisionAppend(
  ctx: RunnerCtx,
  input: DeskDecisionAppendInputValue,
  deps: DeskRunnerDeps,
): Promise<Record<string, unknown> | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = { kind: "decision.append", ...input, actorAgentId: ctx.row.agentId as string };
  const settled = await deps.store.transact(ctx.repoKey, {
    repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId,
    requestId: input.requestId, command,
  }, decideDeskAssignment);
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.decisionEntries.find(candidate => candidate.assignmentId === input.assignmentId && candidate.requestId === input.requestId && candidate.actorAgentId === ctx.row.agentId);
  if (row === undefined) return reject("CAPABILITY_GAP", "the decision committed but its entry is not readable", "retry the identical request to rebuild its response from the immutable decision");
  return DeskDecisionAppendResult.parse({ ok: true, assignmentId: row.assignmentId, decisionId: row.decisionId, revision: row.revision, entrySha256: row.entrySha256, receiptId: settled.receipt.receiptId });
}

function itemRevision(item: DeskWorkflowProjectionItemValue): number {
  if ("row" in item) return "revision" in item.row ? item.row.revision : ("ownershipRevision" in item.row ? item.row.ownershipRevision : 0);
  if ("summary" in item) return item.summary.revision;
  return item.scopeRevision;
}

function itemKey(item: DeskWorkflowProjectionItemValue): string {
  if ("row" in item) {
    const row = item.row as Record<string, unknown>;
    return String(row.scopeId ?? row.decisionId ?? row.revision ?? row.candidateId ?? row.runId ?? row.checkId ?? row.offerId ?? row.acceptId ?? "");
  }
  if ("summary" in item) return "handbackId" in item.summary ? item.summary.handbackId : item.summary.settlementId;
  return `${item.scopeId}\0${item.reason}\0${item.candidateSnapshot}`;
}

/** Typed handback summary — the claim body stays ledger-only; only its
 *  digest, measured size, declared-vs-observed candidate, recorded seat,
 *  gaps and genuinely supplied check output refs are projected. Refs that
 *  cannot ride the wire are counted as omitted, never clipped or
 *  fabricated. */
function handbackSummaryOf(row: HandbackValue) {
  const checks = Array.isArray(row.record["checks"]) ? row.record["checks"] : [];
  const refs: string[] = [];
  let omitted = 0;
  for (const check of checks) {
    const ref = (check as Record<string, unknown> | null)?.outputRef;
    if (typeof ref !== "string" || ref.length === 0) continue;
    if (ref.length <= WIRE_LIMITS.deskPathSurface && refs.length < WIRE_LIMITS.deskBriefRefs) refs.push(ref);
    else omitted += 1;
  }
  return {
    handbackId: row.handbackId, assignmentId: row.assignmentId, revision: row.revision,
    requestId: row.requestId, seatAgentId: row.agentId, seatMembershipId: row.seatMembershipId,
    recordSha256: row.recordSha256, recordBytes: Buffer.byteLength(canonicalJson(row.record), "utf8"),
    recordAvailability: "ledger" as const,
    claimedCandidateId: row.claimedCandidateId,
    observed: row.observed, gaps: row.gaps,
    suppliedCheckCount: checks.length, suppliedOutputRefs: refs, outputRefsOmitted: omitted,
  };
}

function reviewLens(row: LedgerValue["scopeReviews"][number]): string | null {
  return row.lensId ?? row.axis;
}

function disagreementItems(ledger: Readonly<LedgerValue>, assignmentId: string, currentRevision: number): DeskWorkflowProjectionItemValue[] {
  const result: DeskWorkflowProjectionItemValue[] = [];
  const scopeIds = [...new Set(ledger.scopes.filter(row => row.assignmentId === assignmentId).map(row => row.scopeId))].sort();
  for (const scopeId of scopeIds) {
    const declaration = ledger.scopes.filter(row => row.assignmentId === assignmentId && row.scopeId === scopeId).sort((a, b) => a.revision - b.revision).at(-1);
    const transitions = ledger.scopeTransitions.filter(row => row.assignmentId === assignmentId && row.scopeId === scopeId).sort((a, b) => a.revision - b.revision);
    const latestTransition = transitions.at(-1);
    // Only submission carries the candidate pin. Review observation records
    // discharge, not a new candidate or an owner adjudication.
    const round = transitions.filter(row => row.command === "submit-for-review").at(-1);
    if (declaration === undefined || latestTransition === undefined || declaration.briefRevision !== currentRevision ||
        latestTransition.to !== "submitted-for-review" && latestTransition.to !== "review-observed" ||
        round === undefined || round.candidateSnapshot === null || round.scopeRevision !== declaration.revision ||
        round.briefRevision !== currentRevision || round.mandateSha256 !== (declaration.reviewPlan === null ? null : canonicalSha256(declaration.reviewPlan)) ||
        latestTransition.scopeRevision !== round.scopeRevision || latestTransition.briefRevision !== round.briefRevision ||
        latestTransition.mandateSha256 !== round.mandateSha256) continue;
    const roundReviews = ledger.scopeReviews.filter(row => row.assignmentId === assignmentId && row.scopeId === scopeId &&
      row.scopeRevision === round.scopeRevision && row.briefRevision === currentRevision &&
      row.candidateSnapshot === round.candidateSnapshot && row.mandateSha256 === round.mandateSha256);
    const keys = [...new Set(roundReviews.map(reviewLens).filter((value): value is string => value !== null))].sort();
    for (const lensId of keys) {
      const latestByReviewer = new Map<string, typeof roundReviews[number]>();
      for (const review of roundReviews.filter(row => reviewLens(row) === lensId).sort((a, b) => a.revision - b.revision || a.reviewId.localeCompare(b.reviewId))) {
        latestByReviewer.set(review.reviewerAgentId, review);
      }
      const observations = [...latestByReviewer.values()].sort((a, b) => a.reviewId.localeCompare(b.reviewId));
      const verdicts = new Set(observations.map(row => row.verdict));
      const add = (rows: typeof observations, reason: "conflicting-verdicts" | "unresolved-findings") => {
        if (rows.length === 0) return;
        result.push({
          kind: "reviewDisagreement", assignmentId, scopeId, scopeRevision: declaration.revision,
          briefRevision: currentRevision, mandateSha256: round.mandateSha256,
          candidateSnapshot: round.candidateSnapshot as string,
          reviewIds: rows.map(row => row.reviewId), reason,
        });
      };
      if (verdicts.size > 1) add(observations, "conflicting-verdicts");
      add(observations.filter(row => row.verdict === "findings"), "unresolved-findings");
    }
  }
  return result;
}

/** Pure, ACL-free projection shared by the agent bridge and verified-home
 *  Human RPC. Callers supply one already-read ledger; this function never
 *  resolves authority, evidence, paths or refs. */
export function projectDeskWorkflow(
  ledger: Readonly<LedgerValue>,
  assignmentId: string,
  page: DeskWorkflowProjectionPageInputValue,
): DeskWorkflowProjectionValue | DeskRejectionValue {
  const parsedPage = DeskWorkflowProjectionPageInput.safeParse(page);
  if (!parsedPage.success) return reject("INVALID_RECORD", "workflow page request is invalid", "use the strict section, revision pins and cursor shape");
  const input = parsedPage.data;
  const assignment = ledger.assignments.find(row => row.assignmentId === assignmentId);
  if (assignment === undefined) return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "read a registered assignment on this repo desk");
  if (input.expectedLedgerRevision !== null && input.expectedLedgerRevision !== ledger.revision) {
    return reject("REVISION_CONFLICT", "the requested ledger revision is no longer current", "reload the first page and continue from its returned pin");
  }
  const briefs = currentBriefRows(ledger, assignmentId);
  const current = briefs.at(-1);
  const briefRevision = current?.revision ?? 0;
  if (input.expectedBriefRevision !== null && input.expectedBriefRevision !== briefRevision) {
    return reject("REVISION_CONFLICT", "the requested operative brief revision is no longer current", "reload the operative brief before continuing");
  }
  if (input.cursor !== null && (input.cursor.assignmentId !== assignmentId || input.cursor.section !== input.section || input.cursor.ledgerRevision !== ledger.revision)) {
    return reject("REVISION_CONFLICT", "workflow continuation does not match this assignment, section and ledger revision", "restart the section with a fresh page request");
  }

  let items: DeskWorkflowProjectionItemValue[];
  switch (input.section) {
    case "briefs":
      items = briefs.map(row => ({ kind: "briefRevision", row }));
      break;
    case "decisions":
      items = ledger.decisionEntries.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.revision - b.revision)
        .map(row => ({ kind: "decisionEntry", row }));
      break;
    case "ownership":
      items = [
        ...ledger.scopes.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.revision - b.revision || a.scopeId.localeCompare(b.scopeId))
          .map(row => ({ kind: "scopeDeclaration", row } as const)),
        ...ledger.ownershipOffers.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.ownershipRevision - b.ownershipRevision || a.offerId.localeCompare(b.offerId))
          .map(row => ({ kind: "ownershipOffer", row } as const)),
        ...ledger.ownershipAccepts.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.ownershipRevision - b.ownershipRevision || a.acceptId.localeCompare(b.acceptId))
          .map(row => ({ kind: "ownershipAccept", row } as const)),
      ];
      break;
    case "reviews": {
      // Current standing qualification reuses the gates' own resolver —
      // one call per scope — so the page marks which immutable rows carry
      // the present gate without reinterpreting authority or rewriting
      // the history.
      const qualifications = new Map<string, ReturnType<typeof currentScopeReviewQualification>>();
      const qualificationFor = (scopeId: string) => {
        let qualification = qualifications.get(scopeId);
        if (qualification === undefined) {
          qualification = currentScopeReviewQualification(ledger, assignment, scopeId);
          qualifications.set(scopeId, qualification);
        }
        return qualification;
      };
      const reviews = ledger.scopeReviews.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.revision - b.revision || a.reviewId.localeCompare(b.reviewId))
        .map(row => {
          const qualification = qualificationFor(row.scopeId);
          const discharging = new Set((qualification.discharged ?? []).map(entry => entry.reviewId));
          const standing = new Set((qualification.standingApproval?.discharged ?? []).map(entry => entry.reviewId));
          return { kind: "scopeReview", row, qualification: {
            eligible: qualification.eligibleReviewIds.includes(row.reviewId),
            discharging: discharging.has(row.reviewId),
            standingApproval: standing.has(row.reviewId),
          } } as const;
        });
      const transitions = ledger.scopeTransitions.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.revision - b.revision || a.transitionId.localeCompare(b.transitionId))
        .map(row => ({ kind: "scopeTransition", row } as const));
      items = [...reviews, ...transitions, ...disagreementItems(ledger, assignmentId, briefRevision)];
      break;
    }
    case "evidence":
      items = [
        ...ledger.candidates.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.candidateId.localeCompare(b.candidateId)).map(row => ({ kind: "candidateObservation", row } as const)),
        ...ledger.checkDefinitions.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.checkId.localeCompare(b.checkId) || a.revision - b.revision).map(row => ({ kind: "checkDefinition", row } as const)),
        ...ledger.checkRuns.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.rolloutId.localeCompare(b.rolloutId) || a.checkId.localeCompare(b.checkId) || a.attempt - b.attempt || a.runId.localeCompare(b.runId)).map(row => ({ kind: "checkRun", row } as const)),
        ...ledger.handbacks.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.revision - b.revision || a.handbackId.localeCompare(b.handbackId))
          .map(row => ({ kind: "handbackSummary", summary: handbackSummaryOf(row) } as const)),
        ...ledger.settlements.filter(row => row.assignmentId === assignmentId).sort((a, b) => a.revision - b.revision || a.settlementId.localeCompare(b.settlementId))
          .map(row => ({ kind: "settlementSummary", summary: row } as const)),
      ];
      break;
  }
  items.sort((a, b) => itemRevision(a) - itemRevision(b) || itemKey(a).localeCompare(itemKey(b)) || a.kind.localeCompare(b.kind));
  if (items.length > WIRE_LIMITS.deskWorkflowHistory) return reject("INVALID_RECORD", "workflow history exceeds the bounded projection history", "the ledger is outside the supported history bound");
  const offset = input.cursor?.offset ?? 0;
  if (offset > items.length) return reject("INVALID_RECORD", "workflow continuation offset is outside the section", "restart the section from its first page");
  const selected = items.slice(offset, offset + input.limit);
  const nextOffset = offset + selected.length;
  const owner = effectiveOwner(ledger, assignment);
  const ownerMembership = ledger.memberships.find(row => row.membershipId === owner.membershipId) ?? null;
  // The tip accept row is the durable provenance of the current owner —
  // revision N's accept is what installed the revision-N tuple. Pending
  // offers stay bounded page items, never an unbounded header list.
  const tipAccept = owner.ownershipRevision === 0 ? null
    : ledger.ownershipAccepts.find(row =>
        row.assignmentId === assignmentId && row.ownershipRevision === owner.ownershipRevision) ?? null;
  const result = {
    ok: true as const,
    assignmentId,
    ledgerRevision: ledger.revision,
    briefRevision,
    ownership: {
      registeredOwnerAgentId: assignment.ownerAgentId,
      registeredOwnerMembershipId: assignment.ownerMembershipId,
      ownerAgentId: owner.agentId,
      ownerMembershipId: owner.membershipId,
      ownershipRevision: owner.ownershipRevision,
      ownerMembership: ownerMembership === null ? null : {
        state: ownerMembership.state, registeredAt: ownerMembership.registeredAt, revokedAt: ownerMembership.revokedAt,
      },
      acceptedAcknowledgment: tipAccept === null ? null : {
        acceptId: tipAccept.acceptId, offerId: tipAccept.offerId, requestId: tipAccept.requestId,
        acknowledgment: tipAccept.acknowledgment, settlementRef: tipAccept.settlementRef, gaps: tipAccept.gaps,
        ledgerRevision: tipAccept.ledgerRevision, briefRevision: tipAccept.briefRevision,
      },
    },
    currentBrief: current === undefined ? null : {
      revision: current.revision, body: current.body, bodySha256: current.bodySha256,
      entrySha256: current.entrySha256, authorityRef: current.authorityRef, actorAgentId: current.actorAgentId,
    },
    legacyObjective: current === undefined ? assignment.objective : null,
    section: input.section,
    items: selected,
    total: items.length,
    omittedBefore: offset,
    omittedAfter: items.length - nextOffset,
    nextCursor: nextOffset < items.length ? { assignmentId, ledgerRevision: ledger.revision, section: input.section, offset: nextOffset } : null,
    acceptance: "not-established-by-this-view" as const,
  };
  const parsed = DeskWorkflowProjection.safeParse(result);
  return parsed.success ? parsed.data : reject("INVALID_RECORD", "stored workflow values cannot be represented by the shared projection contract", "inspect the ledger schema and preserve the full stored value");
}

export function canReadDeskWorkflow(
  ledger: Readonly<LedgerValue>,
  actor: MembershipValue,
  assignmentId: string,
): boolean {
  const assignment = ledger.assignments.find(row => row.assignmentId === assignmentId);
  if (assignment === undefined) return false;
  return deskWorkflowParticipant(ledger, actor, assignment) !== null;
}

export function assignmentCurrentBriefRevision(ledger: Readonly<LedgerValue>, assignmentId: string): number {
  return currentBriefRevision(ledger, assignmentId);
}
