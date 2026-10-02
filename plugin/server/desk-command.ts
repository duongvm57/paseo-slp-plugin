// Pure invariants shared by desk commands. Features retain their schemas,
// state machines and rejection diagnostics; these predicates own authority
// resolution so the command surfaces cannot drift independently.

import type { DeskRejectionValue } from "../shared/enforcement.ts";
import { canonicalJson, sha256Hex } from "./config-view.ts";
import type { AssignmentValue, LedgerValue, MembershipValue } from "./desk-store.ts";

/** Derive ids from canonical-JSON tuples, never bare concatenation (which
 *  aliases ["ab", "c"] and ["a", "bc"]). Stored ids keep their identity;
 *  response lookups use durable request fields rather than re-deriving ids. */
export function deriveId(prefix: "asg" | "hb" | "cand" | "stl" | "scp" | "srv" | "stn" | "chk" | "run" | "rol" | "rtn", parts: string[]): string {
  return `${prefix}-${sha256Hex(canonicalJson(parts)).slice(0, 32)}`;
}

/** Decide-side equivalent of the bridge's freshRow membership check. */
export function liveMembership(ledger: Readonly<LedgerValue>, agentId: string): MembershipValue | undefined {
  return ledger.memberships.find(
    row => row.agentId === agentId && row.state !== "revoked" && row.registeredAt !== null,
  );
}

export function requireActor(
  ledger: Readonly<LedgerValue>,
  agentId: string,
  recovery: string,
): MembershipValue | DeskRejectionValue {
  return liveMembership(ledger, agentId) ?? {
    ok: false,
    code: "AUTHORITY_REQUIRED",
    message: "the actor has no live bound membership on this desk",
    recovery,
  };
}

export function requireLead(actor: MembershipValue, message: string, recovery: string): DeskRejectionValue | null {
  return actor.role === "lead" ? null : { ok: false, code: "AUTHORITY_REQUIRED", message, recovery };
}

/** Resolve in the same order for every feature: registered assignment,
 *  durable receiving owner, then open state. The feature supplies its
 *  diagnostics because scope and rollout use different closed codes. */
export function requireOwnedOpenAssignment(
  ledger: Readonly<LedgerValue>,
  actor: MembershipValue,
  assignmentId: string,
  rejections: {
    missing: DeskRejectionValue;
    ownerMismatch: DeskRejectionValue;
    closed: DeskRejectionValue;
  },
): AssignmentValue | DeskRejectionValue {
  const assignment = ledger.assignments.find(a => a.assignmentId === assignmentId);
  if (assignment === undefined) return rejections.missing;
  if (assignment.ownerAgentId !== actor.agentId) return rejections.ownerMismatch;
  if (assignment.state !== "open") return rejections.closed;
  return assignment;
}
