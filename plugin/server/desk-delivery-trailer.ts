// Desk-observed delivery identity, never an authority grant. Quoted opaque
// IDs cannot inject lines; UTF-8 byte limits also bound UTF-16 schema lengths.
import { WIRE_LIMITS } from "../shared/enforcement.ts";

export function taskDeliveryTrailer(textSha256: string, assignmentId: string, taskId: string, attemptId: string, parentAgentId: string): string {
  return `\n\nDesk delivery (claim; no authority grant):\nLead text sha256: ${textSha256}\nAssignment id: ${JSON.stringify(assignmentId)}\nTask id: ${JSON.stringify(taskId)}\nAttempt id: ${JSON.stringify(attemptId)}\nHandback route: the verified parent agent ID is ${JSON.stringify(parentAgentId)}.\n`;
}

/** Before composition allocates task/attempt IDs, reserve their full opaque
 * wire bounds (JSON control escapes cost six bytes per code unit). Known
 * assignment/parent IDs use their exact encoding. No caller text is cut. */
export function taskDeliveryTrailerBudget(assignmentId: string, parentAgentId: string): number {
  const unknownId = "\0".repeat(WIRE_LIMITS.deskEntityId);
  return Buffer.byteLength(taskDeliveryTrailer("0".repeat(64), assignmentId, unknownId, unknownId, parentAgentId));
}
