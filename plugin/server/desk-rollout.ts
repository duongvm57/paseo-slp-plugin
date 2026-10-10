// desk-rollout.ts — the P5 rollout machinery (contract R1 §P3–P5). A
// rollout is a durable, assignment+scope-bound, owner-administered stream:
// `(assignmentId, scopeId, rolloutId, ownerAgentId, candidateSnapshot)` is
// pinned at declare time; the candidate must resolve to a durable observed
// candidate of the assignment; `requiredChecks` pins
// (checkId, definitionDigest) pairs resolved against the scope's declared
// definitions. `declare` opens the transition stream with the
// (none → declared) edge — it is not a caller-visible transition.
//
// Every machine move is an explicit owner command through
// `rollout.transition`; state legality comes from ONE shared seam —
// ROLLOUT_TRANSITIONS / rolloutTransitionEdge in shared/enforcement.ts —
// consulted identically by this decide and by the store's durable
// refinement. Nothing auto-promotes: `checks-passed`/`promote` are gated
// on durable passed-run evidence for every required check pinned to the
// declaration's candidate; `promote` is additionally gated on the scope's
// standing approved review round (every required legacy axis or named lens
// discharged, unless the pinned plan is explicitly exempt) bound to the
// exact candidate, current scope and operative-brief revisions; `start-canary`
// pins a bounded membership
// snapshot (owner + seats, sorted+unique, digest-recomputable);
// `canary-passed`/`promote` are gated on that cohort still describing the
// assignment's roster — drift typed-rejects COHORT_DRIFT and the cohort
// never auto-expands. `rollback` is explicit, append-only, and pins a
// known-good observed candidate of the same assignment. No transition is
// a deployment, a live effect or an acceptance — the desk records the
// decision, nothing else acts on it.

import { z } from "zod";
import { Sha } from "../shared/contracts.ts";
import {
  DeskRolloutDeclareInput,
  DeskRolloutTransitionInput,
  ROLLOUT_CHECK_GATED_COMMANDS,
  ROLLOUT_COHORT_GATED_COMMANDS,
  ROLLOUT_REVIEW_GATED_COMMANDS,
  WIRE_LIMITS,
  rolloutTransitionEdge,
  type CheckClassValue,
  type DeskRejectionValue,
  type DeskRolloutDeclareInputValue,
  type DeskRolloutTransitionInputValue,
  type RolloutStateValue,
} from "../shared/enforcement.ts";
import {
  effectiveOwner,
  LEDGER_LIMITS,
  assignmentStructuralRevision,
  type AssignmentValue,
  type CheckDefinitionValue,
  type CheckRunValue,
  type DecideOutcome,
  type LedgerValue,
  type MembershipValue,
  type RolloutTransitionValue,
  type RolloutValue,
} from "./desk-store.ts";
import { currentScopeReviewQualification } from "./desk-scope.ts";
import { deskWorkflowParticipant } from "./desk-ownership.ts";
import { assignmentCurrentBriefRevision } from "./desk-assignment.ts";
import { isRejection, readLedger, repoEnvelope, type DeskRunnerDeps, type RunnerCtx } from "./desk-runner.ts";
import { canonicalJson, sha256Hex } from "./config-view.ts";
import {
  deriveId,
  requireActor as requireDeskActor,
  requireLead as requireDeskLead,
  requireOwnedOpenAssignment as requireDeskOwnedOpenAssignment,
} from "./desk-command.ts";

// ---------------------------------------------------------------------------
// command schemas — `actorAgentId` is server-derived (the bound
// membership's agentId) and rides the command so a replayed envelope
// re-decides under the same actor.
// ---------------------------------------------------------------------------

const ActorAgentId = z.string().min(1).max(WIRE_LIMITS.agentId);
const BoundedId = z.string().min(1).max(WIRE_LIMITS.deskEntityId);

const RolloutDeclareCommand = DeskRolloutDeclareInput.extend({
  kind: z.literal("rollout.declare"),
  actorAgentId: ActorAgentId,
}).strict();

const RolloutTransitionCommand = DeskRolloutTransitionInput.extend({
  kind: z.literal("rollout.transition"),
  actorAgentId: ActorAgentId,
}).strict();

const DeskRolloutCommand = z.discriminatedUnion("kind", [RolloutDeclareCommand, RolloutTransitionCommand]);

const reject = (code: DeskRejectionValue["code"], message: string, recovery: string): DeskRejectionValue => ({
  ok: false,
  code,
  message,
  recovery,
});

const ok = (
  events: { kind: string; payload: Record<string, unknown> }[],
  tables: { rollouts?: RolloutValue[]; rolloutTransitions?: RolloutTransitionValue[] } = {},
): DecideOutcome => ({ ok: true, events, ...tables });

// ---------------------------------------------------------------------------
// actor + target resolution — server-side, decide-level.
// ---------------------------------------------------------------------------

function requireActor(ledger: Readonly<LedgerValue>, agentId: string): MembershipValue | DeskRejectionValue {
  return requireDeskActor(ledger, agentId, "a rollout command needs a host-bound, registered row — peers and revoked seats cannot move rollout state");
}

function requireLead(actor: MembershipValue): DeskRejectionValue | null {
  return requireDeskLead(
    actor,
    `role ${JSON.stringify(actor.role)} may not administer rollouts — the receiving owner holds a bound lead membership`,
    "the role pin is a durable membership field, not a claim",
  );
}

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
      "ACTOR_MISMATCH",
      "only the assignment's receiving owner may administer its rollouts",
      "the current owner's exact agent and membership are bound — another participant cannot move rollout state",
    ),
    closed: reject(
      "ROLLOUT_CONFLICT",
      "the assignment is closed — its rollouts keep their recorded state",
      "closed assignments take no new declarations or transitions",
    ),
  });
}

/** The rollout's declaration stream (assignmentId, rolloutId) — sorted by
 *  revision, latest last. */
function declarationStream(ledger: Readonly<LedgerValue>, assignmentId: string, rolloutId: string): RolloutValue[] {
  return ledger.rollouts
    .filter(r => r.assignmentId === assignmentId && r.rolloutId === rolloutId)
    .sort((a, b) => a.revision - b.revision);
}

/** The rollout's transition stream — sorted by revision. The current
 *  machine state is the last row's `to`. */
function transitionStream(ledger: Readonly<LedgerValue>, assignmentId: string, rolloutId: string): RolloutTransitionValue[] {
  return ledger.rolloutTransitions
    .filter(t => t.assignmentId === assignmentId && t.rolloutId === rolloutId)
    .sort((a, b) => a.revision - b.revision);
}

/** The membership snapshot a canary binds: the assignment's durable
 *  roster (current effective owner + seats), sorted and de-duplicated,
 *  pinned to the structural revision the snapshot was taken at. The
 *  digest recomputes canonically — the same roster always digests
 *  identically. At ownership revision 0 the recipe stays the legacy
 *  {members, assignmentRevision} so a migrated or pre-succession pin
 *  keeps its validity; any accepted succession changes ownershipRevision
 *  and the digest recipe, so the pinned cohort drifts even when the
 *  member list is unchanged. */
function cohortSnapshot(
  ledger: Readonly<LedgerValue>,
  assignment: AssignmentValue,
): { members: string[]; digest: string; assignmentRevision: number; ownershipRevision: number } {
  const owner = effectiveOwner(ledger, assignment);
  const members = [...new Set([owner.agentId, ...assignment.seats.map(seat => seat.agentId)])].sort();
  const assignmentRevision = assignmentStructuralRevision(assignment);
  const digest = owner.ownershipRevision === 0
    ? sha256Hex(canonicalJson({ members, assignmentRevision }))
    : sha256Hex(canonicalJson({ members, assignmentRevision, ownershipRevision: owner.ownershipRevision }));
  return { members, digest, assignmentRevision, ownershipRevision: owner.ownershipRevision };
}

/** The cohort the stream's latest start-canary pinned, or null. */
function pinnedCohort(stream: RolloutTransitionValue[]): { members: string[]; digest: string; assignmentRevision: number } | null {
  let pinned: { members: string[]; digest: string; assignmentRevision: number } | null = null;
  for (const row of stream) {
    if (row.command === "start-canary" && row.cohort !== null) pinned = row.cohort;
  }
  return pinned;
}

/** The check evidence a check-gated transition commits with: for every
 *  required check of the pinned declaration revision, the latest PASSED
 *  run bound to (rolloutId, checkId, declaration.candidateSnapshot) whose
 *  pinned definitionSha256 matches the required digest. A missing piece
 *  yields null and the transition rejects CHECK_INCOMPLETE. */
function resolveCheckDischarges(
  ledger: Readonly<LedgerValue>,
  declaration: RolloutValue,
): { checkId: string; runId: string }[] | null {
  const discharged: { checkId: string; runId: string }[] = [];
  for (const required of declaration.requiredChecks) {
    const candidates = ledger.checkRuns
      .filter(
        r =>
          r.assignmentId === declaration.assignmentId &&
          r.rolloutId === declaration.rolloutId &&
          r.checkId === required.checkId &&
          r.status === "passed" &&
          r.candidateSnapshot === declaration.candidateSnapshot &&
          r.definitionSha256 === required.definitionDigest,
      )
      .sort((a, b) => a.attempt - b.attempt);
    const latest = candidates[candidates.length - 1];
    if (latest === undefined) return null;
    discharged.push({ checkId: required.checkId, runId: latest.runId });
  }
  return discharged;
}

// ---------------------------------------------------------------------------
// decide — synchronous and pure.
// ---------------------------------------------------------------------------

export function decideDeskRollout(ledger: Readonly<LedgerValue>, command: Record<string, unknown>): DecideOutcome {
  const parsed = DeskRolloutCommand.safeParse(command);
  if (!parsed.success) {
    return reject("INVALID_RECORD", "command does not match any desk-rollout command schema", "commands are strict JSON objects with a kind discriminator");
  }
  const cmd = parsed.data;

  const actor = requireActor(ledger, cmd.actorAgentId);
  if ("ok" in actor) return actor;
  const leadError = requireLead(actor);
  if (leadError !== null) return leadError;
  const assignment = requireOwnedOpenAssignment(ledger, actor, cmd.assignmentId);
  if ("ok" in assignment) return assignment;

  if (cmd.kind === "rollout.declare") {
    if (ledger.rollouts.length >= LEDGER_LIMITS.rollouts) {
      return reject("INVALID_RECORD", `rollouts table is at the ${LEDGER_LIMITS.rollouts} cap`, "the rollout table is bounded per repo desk");
    }
    const scopeStream = ledger.scopes
      .filter(s => s.assignmentId === cmd.assignmentId && s.scopeId === cmd.scopeId)
      .sort((a, b) => a.revision - b.revision);
    const latestScope = scopeStream[scopeStream.length - 1];
    if (latestScope === undefined) {
      return reject(
        "SCOPE_CONFLICT",
        "the rollout names a scope that is not declared on this assignment",
        "declare the scope first — a rollout binds a durable assignment scope",
      );
    }
    // The candidate pin must resolve to a durable observed candidate of
    // THIS assignment — and of the scope's bound seat when one is declared
    // (same discipline as the P4 review round pin).
    const candidate = ledger.candidates.find(
      c => c.snapshotSha256 === cmd.candidateSnapshot && c.assignmentId === cmd.assignmentId,
    );
    if (candidate === undefined) {
      return reject(
        "CANDIDATE_DRIFT",
        "the pinned candidate is not an observed candidate of this assignment",
        "a rollout binds a durable observed candidate — capture one through the handback seam and retry",
      );
    }
    if (latestScope.seatAgentId !== null && candidate.seatAgentId !== latestScope.seatAgentId) {
      return reject(
        "CANDIDATE_DRIFT",
        "the pinned candidate belongs to a different seat than the scope's bound seat",
        "a seat-bound scope's rollout candidate is observed from that seat's captures",
      );
    }
    if (cmd.candidateHead !== null && candidate.head !== cmd.candidateHead) {
      return reject(
        "CANDIDATE_DRIFT",
        "the claimed candidate head does not match the durable candidate's measured head",
        "the head pin is evidence, not input — resubmit with the measured head or null",
      );
    }
    // Every required check resolves to a declared definition of THIS
    // scope whose stored digest equals the pin — the digest binds the
    // exact immutable definition revision the rollout measures against.
    const requiredIds = new Set<string>();
    for (const required of cmd.requiredChecks) {
      if (requiredIds.has(required.checkId)) {
        return reject("INVALID_RECORD", `requiredChecks names ${required.checkId} twice`, "each required check appears once");
      }
      requiredIds.add(required.checkId);
      const def = ledger.checkDefinitions.find(
        d =>
          d.assignmentId === cmd.assignmentId &&
          d.checkId === required.checkId &&
          d.scopeId === cmd.scopeId &&
          d.definitionSha256 === required.definitionDigest,
      );
      if (def === undefined) {
        return reject(
          "INVALID_RECORD",
          `required check ${required.checkId} does not resolve to a declared definition of this scope at the pinned digest`,
          "declare the check definition first — a rollout pins existing (checkId, definitionSha256) pairs",
        );
      }
    }
    const stream = declarationStream(ledger, cmd.assignmentId, cmd.rolloutId);
    const latest = stream[stream.length - 1];
    if (latest !== undefined && latest.scopeId !== cmd.scopeId) {
      return reject(
        "SCOPE_CONFLICT",
        "the rolloutId is already declared under a different scope of this assignment",
        "a rollout's scope binding is fixed at first declaration — choose a new rolloutId",
      );
    }
    const revision = (latest?.revision ?? 0) + 1;
    const row: RolloutValue = {
      rolloutId: cmd.rolloutId,
      assignmentId: cmd.assignmentId,
      scopeId: cmd.scopeId,
      requestId: cmd.requestId,
      revision,
      priorRevision: latest?.revision ?? null,
      ownerMembershipId: actor.membershipId,
      ownerAgentId: actor.agentId as string,
      assignmentRevision: assignmentStructuralRevision(assignment),
      label: cmd.label,
      declarationSha256: cmd.declarationSha256,
      candidateSnapshot: candidate.snapshotSha256,
      candidateHead: candidate.head,
      requiredChecks: cmd.requiredChecks,
      refs: cmd.refs,
    };
    // The first declaration also opens the transition stream with the
    // (none → declared) edge — `declare` is the stream-opening command.
    // Later revisions amend provenance/pins only; the machine state stays
    // put.
    const transitions =
      revision === 1
        ? [
            ...ledger.rolloutTransitions,
            {
              transitionId: deriveId("rtn", [actor.agentId as string, cmd.assignmentId, cmd.rolloutId, cmd.requestId, "declare"]),
              assignmentId: cmd.assignmentId,
              rolloutId: cmd.rolloutId,
              requestId: cmd.requestId,
              revision: 1,
              command: "declare" as const,
              from: null,
              to: "declared" as const,
              rolloutRevision: 1,
              actorAgentId: actor.agentId as string,
              cohort: null,
              targetSnapshot: null,
              targetHead: null,
              evidenceRefs: [],
              dischargedChecks: [],
              dischargedReviews: [],
              cohortDigestAtGate: null,
            } satisfies RolloutTransitionValue,
          ]
        : ledger.rolloutTransitions;
    return ok(
      [{
        kind: "rollout-declared",
        payload: {
          assignmentId: cmd.assignmentId,
          scopeId: cmd.scopeId,
          rolloutId: cmd.rolloutId,
          ownerAgentId: actor.agentId,
          revision,
          candidateSnapshot: candidate.snapshotSha256,
        },
      }],
      { rollouts: [...ledger.rollouts, row], rolloutTransitions: transitions },
    );
  }

  // rollout.transition — one explicit owner move per command.
  const declarations = declarationStream(ledger, cmd.assignmentId, cmd.rolloutId);
  if (declarations.length === 0) {
    return reject(
      "ROLLOUT_CONFLICT",
      "the rollout is not declared on this assignment",
      "declare the rollout before moving its machine — the (none → declared) edge is the declaration itself",
    );
  }
  const latestDeclaration = declarations[declarations.length - 1]!;
  if (cmd.rolloutRevision !== latestDeclaration.revision) {
    return reject(
      "REVISION_CONFLICT",
      `rolloutRevision ${cmd.rolloutRevision} is superseded by declaration revision ${latestDeclaration.revision}`,
      "transitions pin the latest declaration revision — re-read the rollout and retry with a new requestId",
    );
  }
  const transitions = transitionStream(ledger, cmd.assignmentId, cmd.rolloutId);
  const from = transitions[transitions.length - 1]?.to ?? null;
  if (from === null) {
    return reject("ROLLOUT_CONFLICT", "the rollout has no declared edge", "a declaration revision opens the stream");
  }
  const edge = rolloutTransitionEdge(from, cmd.transition);
  if (edge === undefined) {
    return reject(
      "ROLLOUT_CONFLICT",
      `transition ${JSON.stringify(cmd.transition)} is not legal from ${JSON.stringify(from)}`,
      "the shared ROLLOUT_TRANSITIONS table is the only legality authority — move along an existing edge",
    );
  }
  if (ledger.rolloutTransitions.length >= LEDGER_LIMITS.rolloutTransitions) {
    return reject("INVALID_RECORD", `rolloutTransitions table is at the ${LEDGER_LIMITS.rolloutTransitions} cap`, "the transition table is bounded per repo desk");
  }

  // Command-carried fields — each pins on exactly its command, never
  // otherwise.
  let cohort: RolloutTransitionValue["cohort"] = null;
  let targetSnapshot: string | null = null;
  let targetHead: string | null = null;
  let cohortDigestAtGate: string | null = null;
  let dischargedChecks: { checkId: string; runId: string }[] = [];
  let dischargedReviews: RolloutTransitionValue["dischargedReviews"] = [];

  if (cmd.transition === "start-canary") {
    // The cohort is the server-derived membership snapshot — bounded by
    // the LEDGER cap, sorted+unique, digest-recomputable. A roster that
    // cannot fit the bound cannot be cohort-ed.
    const snapshot = cohortSnapshot(ledger, assignment);
    if (snapshot.members.length > LEDGER_LIMITS.cohortMembers) {
      return reject(
        "INVALID_RECORD",
        `the assignment roster is ${snapshot.members.length} members — over the ${LEDGER_LIMITS.cohortMembers} cohort cap`,
        "the canary cohort is bounded; the assignment's roster must fit the bound",
      );
    }
    cohort = {
      members: snapshot.members,
      digest: snapshot.digest,
      assignmentRevision: snapshot.assignmentRevision,
      ...(snapshot.ownershipRevision > 0 ? { ownershipRevision: snapshot.ownershipRevision } : {}),
    };
  } else if (cmd.transition === "rollback") {
    if (cmd.targetSnapshot === null) {
      return reject(
        "INVALID_RECORD",
        "rollback requires a targetSnapshot pin",
        "rollback pins a known-good observed candidate of this assignment",
      );
    }
    const target = ledger.candidates.find(
      c => c.snapshotSha256 === cmd.targetSnapshot && c.assignmentId === cmd.assignmentId,
    );
    if (target === undefined) {
      return reject(
        "CANDIDATE_DRIFT",
        "the rollback target is not an observed candidate of this assignment",
        "rollback binds a durable observed candidate — never a claimed hash",
      );
    }
    targetSnapshot = target.snapshotSha256;
    targetHead = target.head;
  } else if (cmd.targetSnapshot !== null) {
    return reject(
      "INVALID_RECORD",
      "only rollback carries a target pin",
      "targetSnapshot on another transition is a malformed command, not a rebind",
    );
  }

  // The check gate — required-check evidence is server-derived and never
  // shrinks: every required check of the pinned revision must hold a
  // durable passed run bound to the declaration's candidate and digest
  // pins.
  if ((ROLLOUT_CHECK_GATED_COMMANDS as readonly string[]).includes(cmd.transition)) {
    const resolved = resolveCheckDischarges(ledger, latestDeclaration);
    if (resolved === null) {
      const missing = latestDeclaration.requiredChecks
        .filter(
          required =>
            !ledger.checkRuns.some(
              r =>
                r.assignmentId === cmd.assignmentId &&
                r.rolloutId === cmd.rolloutId &&
                r.checkId === required.checkId &&
                r.status === "passed" &&
                r.candidateSnapshot === latestDeclaration.candidateSnapshot &&
                r.definitionSha256 === required.definitionDigest,
            ),
        )
        .map(required => required.checkId);
      return reject(
        "CHECK_INCOMPLETE",
        `transition ${JSON.stringify(cmd.transition)} requires a passed run for ${missing.join(", ")} on the pinned candidate`,
        "check pass never auto-promotes — commit each required check's passed run under slp_check_run first",
      );
    }
    dischargedChecks = resolved;
  }

  // The review gate — promote additionally requires the scope's durable
  // approval in force: a review round bound to the declaration's exact
  // candidate pin, current scope and operative-brief revisions, which
  // discharged the pinned legacy axes or named lenses (or an explicit
  // exemption) before the owner's approve edge. A passed check run or an already-promoted row is not
  // review evidence; a foreign-scope, foreign-candidate or superseded
  // approval never discharges this gate.
  if ((ROLLOUT_REVIEW_GATED_COMMANDS as readonly string[]).includes(cmd.transition)) {
    const scopeStream = ledger.scopes
      .filter(s => s.assignmentId === cmd.assignmentId && s.scopeId === latestDeclaration.scopeId)
      .sort((a, b) => a.revision - b.revision);
    const latestScope = scopeStream[scopeStream.length - 1];
    if (latestScope === undefined) {
      return reject(
        "SCOPE_CONFLICT",
        "the rollout's scope is not declared on this assignment",
        "the declaration binds a durable scope — inspect the desk under maintenance authority",
      );
    }
    const operativeBriefRevision = assignmentCurrentBriefRevision(ledger, cmd.assignmentId);
    if (latestScope.briefRevision !== operativeBriefRevision) {
      return reject(
        "REVIEW_INCOMPLETE",
        `the scope declaration pins brief revision ${latestScope.briefRevision} but the operative brief is ${operativeBriefRevision}`,
        "redeclare the scope against the current brief and submit a fresh review round before promotion",
      );
    }
    const approved = currentScopeReviewQualification(ledger, assignment, latestDeclaration.scopeId).standingApproval;
    if (approved === null) {
      return reject(
        "REVIEW_INCOMPLETE",
        `promote requires the scope's standing approved review round on ${latestDeclaration.scopeId}`,
        "a bound reviewer seat records the pinned legacy axes or named lenses, or the pinned authority plan expressly exempts review, then the owner approves",
      );
    }
    if (approved.scopeRevision !== latestScope.revision) {
      return reject(
        "REVIEW_INCOMPLETE",
        `the approved review round pins scope revision ${approved.scopeRevision} but the scope is at ${latestScope.revision}`,
        "a scope amendment supersedes the standing approval — re-submit for review on the current revision",
      );
    }
    if (
      approved.candidateSnapshot !== latestDeclaration.candidateSnapshot ||
      approved.candidateHead !== latestDeclaration.candidateHead
    ) {
      return reject(
        "REVIEW_INCOMPLETE",
        "the approved review round binds a different candidate than the rollout's pin",
        "the review must cover the exact candidate the rollout promotes — re-submit for review under the pinned candidate",
      );
    }
    // Qualification above shares current pins and independence with scope
    // gates and read views; the historical discharge itself stays intact.
    dischargedReviews = approved.discharged;
  }

  // The cohort gate — the membership snapshot start-canary pinned must
  // still describe the assignment's roster exactly. Drift typed-rejects;
  // the cohort never auto-expands (the owner holds or rolls back
  // explicitly).
  if ((ROLLOUT_COHORT_GATED_COMMANDS as readonly string[]).includes(cmd.transition)) {
    const pinned = pinnedCohort(transitions);
    if (pinned === null) {
      // Unreachable through the edge table — cohort-gated edges exist only
      // after start-canary — but keep the refusal typed.
      return reject("COHORT_DRIFT", "no canary cohort is pinned on this rollout", "start-canary binds the cohort the gate measures");
    }
    const current = cohortSnapshot(ledger, assignment);
    if (current.digest !== pinned.digest) {
      return reject(
        "COHORT_DRIFT",
        "the assignment roster changed since the cohort was pinned — the canary no longer describes it",
        "the cohort never auto-expands: hold or roll back explicitly, or declare a fresh rollout revision",
      );
    }
    cohortDigestAtGate = current.digest;
  }

  const revision = (transitions[transitions.length - 1]?.revision ?? 0) + 1;
  const row: RolloutTransitionValue = {
    transitionId: deriveId("rtn", [actor.agentId as string, cmd.assignmentId, cmd.rolloutId, cmd.requestId, cmd.transition]),
    assignmentId: cmd.assignmentId,
    rolloutId: cmd.rolloutId,
    requestId: cmd.requestId,
    revision,
    command: cmd.transition,
    from,
    to: edge.to,
    rolloutRevision: cmd.rolloutRevision,
    actorAgentId: actor.agentId as string,
    cohort,
    targetSnapshot,
    targetHead,
    evidenceRefs: cmd.evidenceRefs,
    dischargedChecks,
    dischargedReviews,
    cohortDigestAtGate,
  };
  return ok(
    [{
      kind: "rollout-transitioned",
      payload: {
        assignmentId: cmd.assignmentId,
        rolloutId: cmd.rolloutId,
        transitionId: row.transitionId,
        rolloutRevision: row.rolloutRevision,
        command: cmd.transition,
        from,
        to: edge.to,
        revision,
        dischargedChecks,
        dischargedReviews,
        cohortDigestAtGate,
      },
    }],
    { rolloutTransitions: [...ledger.rolloutTransitions, row] },
  );
}

// ---------------------------------------------------------------------------
// Status projection — caller-scoped like seatScopesView: the owner sees
// every check definition and rollout on its owned assignment; a bound seat
// sees the same rows on assignments it is attached to (any attached seat
// is a potential checker/reviewer). Identifiers, derived state, pins and
// bounded run summaries only — output tails and claimed refs stay in the
// ledger.
// ---------------------------------------------------------------------------

export type StatusCheckDef = {
  checkId: string;
  scopeId: string;
  checkClass: CheckClassValue;
  revision: number;
  maxRetries: number;
};

export type StatusCheckRun = {
  runId: string;
  checkId: string;
  status: CheckRunValue["status"];
  attempt: number;
  actorAgentId: string;
};

export type StatusRollout = {
  rolloutId: string;
  scopeId: string;
  revision: number;
  state: RolloutStateValue;
  candidateSnapshot: string;
  cohortDigest: string | null;
  cohortSize: number | null;
  requiredChecks: string[];
  dischargedChecks: string[];
  transitionCount: number;
  runs: StatusCheckRun[];
};

export function seatRolloutsView(
  ledger: Readonly<LedgerValue>,
  row: MembershipValue,
  limits: { rollouts: number; runs: number; checkDefs: number },
): {
  defsByAssignment: Map<string, StatusCheckDef[]>;
  rolloutsByAssignment: Map<string, StatusRollout[]>;
  truncated: number;
  defsTruncated: number;
  runsTruncated: number;
} {
  const defsByAssignment = new Map<string, StatusCheckDef[]>();
  const rolloutsByAssignment = new Map<string, StatusRollout[]>();
  let truncated = 0;
  let defsTruncated = 0;
  let runsTruncated = 0;
  for (const assignment of ledger.assignments) {
    const participant = deskWorkflowParticipant(ledger, row, assignment);
    if (participant === null) continue;
    const owner = participant !== "attached-seat";
    // Check definitions: owner sees all; a seat sees definitions of scopes
    // it is bound to plus unbound scopes (same visibility rule as scopes).
    const defs = new Map<string, CheckDefinitionValue>();
    for (const d of ledger.checkDefinitions) {
      if (d.assignmentId !== assignment.assignmentId) continue;
      const scopeRow = ledger.scopes
        .filter(s => s.assignmentId === assignment.assignmentId && s.scopeId === d.scopeId)
        .sort((a, b) => b.revision - a.revision)[0];
      if (!owner && scopeRow !== undefined && scopeRow.seatAgentId !== null && scopeRow.seatAgentId !== row.agentId) continue;
      const prev = defs.get(d.checkId);
      if (prev === undefined || d.revision > prev.revision) defs.set(d.checkId, d);
    }
    if (defs.size > limits.checkDefs) defsTruncated += 1;
    const projectedDefs = [...defs.values()]
      .sort((a, b) => a.checkId.localeCompare(b.checkId))
      .slice(0, limits.checkDefs)
      .map(d => ({
        checkId: d.checkId,
        scopeId: d.scopeId,
        checkClass: d.checkClass,
        revision: d.revision,
        maxRetries: d.limits.maxRetries,
      }));
    if (projectedDefs.length > 0) defsByAssignment.set(assignment.assignmentId, projectedDefs);

    const rolloutIds = new Set<string>();
    for (const r of ledger.rollouts) {
      if (r.assignmentId !== assignment.assignmentId) continue;
      const scopeRow = ledger.scopes
        .filter(s => s.assignmentId === assignment.assignmentId && s.scopeId === r.scopeId)
        .sort((a, b) => b.revision - a.revision)[0];
      if (!owner && scopeRow !== undefined && scopeRow.seatAgentId !== null && scopeRow.seatAgentId !== row.agentId) continue;
      rolloutIds.add(r.rolloutId);
    }
    if (rolloutIds.size > limits.rollouts) truncated += 1;
    const projected: StatusRollout[] = [];
    for (const rolloutId of [...rolloutIds].sort().slice(0, limits.rollouts)) {
      const declarations = declarationStream(ledger, assignment.assignmentId, rolloutId);
      const latest = declarations[declarations.length - 1];
      if (latest === undefined) continue;
      const transitions = transitionStream(ledger, assignment.assignmentId, rolloutId);
      const state: RolloutStateValue = transitions[transitions.length - 1]?.to ?? "declared";
      const cohort = pinnedCohort(transitions);
      const scopedRuns = ledger.checkRuns
        .filter(r => r.assignmentId === assignment.assignmentId && r.rolloutId === rolloutId)
        .sort((a, b) => a.runId.localeCompare(b.runId));
      // The per-rollout run cap must never silently omit rows — the
      // envelope's limitations array carries the count marker instead.
      if (scopedRuns.length > limits.runs) runsTruncated += 1;
      const runs = scopedRuns.slice(0, limits.runs).map(r => ({
        runId: r.runId,
        checkId: r.checkId,
        status: r.status,
        attempt: r.attempt,
        actorAgentId: r.actorAgentId,
      }));
      const discharged = resolveCheckDischarges(ledger, latest) ?? [];
      projected.push({
        rolloutId,
        scopeId: latest.scopeId,
        revision: latest.revision,
        state,
        candidateSnapshot: latest.candidateSnapshot,
        cohortDigest: cohort?.digest ?? null,
        cohortSize: cohort?.members.length ?? null,
        requiredChecks: latest.requiredChecks.map(r => r.checkId),
        dischargedChecks: discharged.map(d => d.checkId),
        transitionCount: transitions.length,
        runs,
      });
    }
    if (projected.length > 0) rolloutsByAssignment.set(assignment.assignmentId, projected);
  }
  return { defsByAssignment, rolloutsByAssignment, truncated, defsTruncated, runsTruncated };
}

// ---------------------------------------------------------------------------
// Runner orchestration — the bridge calls these from ToolDef.run. The
// command body carries the server-derived actorAgentId so a replayed
// envelope re-decides identically; the response resolves by the durable
// request key.
// ---------------------------------------------------------------------------

export async function runRolloutDeclare(
  ctx: RunnerCtx,
  input: DeskRolloutDeclareInputValue,
  deps: DeskRunnerDeps,
): Promise<{ ok: true; [key: string]: unknown } | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = {
    kind: "rollout.declare" as const,
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId as string,
    assignmentId: input.assignmentId,
    scopeId: input.scopeId,
    rolloutId: input.rolloutId,
    label: input.label,
    declarationSha256: input.declarationSha256,
    candidateSnapshot: input.candidateSnapshot,
    candidateHead: input.candidateHead,
    requiredChecks: input.requiredChecks,
    refs: input.refs,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskRollout,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.rollouts.find(
    r => r.requestId === input.requestId && r.assignmentId === input.assignmentId && r.ownerAgentId === ctx.row.agentId,
  );
  if (row === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the declaration committed but its row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return { ok: true, rolloutId: row.rolloutId, revision: row.revision, receiptId: settled.receipt.receiptId };
}

export async function runRolloutTransition(
  ctx: RunnerCtx,
  input: DeskRolloutTransitionInputValue,
  deps: DeskRunnerDeps,
): Promise<{ ok: true; [key: string]: unknown } | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = {
    kind: "rollout.transition" as const,
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId as string,
    assignmentId: input.assignmentId,
    rolloutId: input.rolloutId,
    transition: input.transition,
    rolloutRevision: input.rolloutRevision,
    targetSnapshot: input.targetSnapshot,
    evidenceRefs: input.evidenceRefs,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskRollout,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.rolloutTransitions.find(
    t => t.requestId === input.requestId && t.assignmentId === input.assignmentId && t.actorAgentId === ctx.row.agentId,
  );
  if (row === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the transition committed but its row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return {
    ok: true,
    transitionId: row.transitionId,
    rolloutId: row.rolloutId,
    revision: row.revision,
    state: row.to,
    receiptId: settled.receipt.receiptId,
    dischargedChecks: row.dischargedChecks,
    dischargedReviews: row.dischargedReviews,
  };
}
