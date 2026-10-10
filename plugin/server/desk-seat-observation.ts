// Native seat observation shared by ordinary formation and managed tasks.
// This module reads one fresh SDK snapshot; it owns no task state or effects.
import type { TaskAgentHandle } from "./desk-task-execution-host.ts";

// Both the SDK adapter and snapshot fixtures satisfy this read-only seam.
// Creating, sending, listing and workspace access are deliberately unnecessary.
type SeatObservationHost = { agents: { ref(id: string): Pick<TaskAgentHandle, "refresh"> } };

type SeatVerification = {
  ok: boolean;
  mismatches: string[];
  workspaceId?: string | null;
  parent?: string | null;
};

// The private managed-create carrier must not escape create/refresh diagnostics.
// Keep redaction before truncation for both consumers of the same ticket.
export const privateCreateError = (error: unknown, ticket: string | null, limit: number): string => {
  const message = error instanceof Error ? error.message : String(error);
  return (ticket === null ? message : message.replaceAll(ticket, "[REDACTED]")).slice(0, limit);
};

/** Required evidence semantics: a field the snapshot does not report is
 *  missing evidence — uncertain — never an exact verified tuple. Optional
 *  pins verify only when a value was requested, but a request without
 *  reported evidence still fails closed. */
export async function verifySeat(
  host: SeatObservationHost, agentId: string,
  pin: {
    provider: string; model: string | null; cwd: string;
    workspaceId: string | null; parent: string | null;
    modeId?: string | null; thinkingOptionId?: string | null;
    modeIdUnsupported?: boolean;
    features?: Record<string, unknown> | null;
    labels?: Readonly<Record<string, string>> | null;
  },
  privateTicket: string | null = null,
): Promise<SeatVerification> {
  let refetched;
  try { refetched = await host.agents.ref(agentId).refresh(); }
  catch (error) { return { ok: false, mismatches: [`refresh-failed:${privateCreateError(error, privateTicket, 128)}`] }; }
  const agent = refetched?.agent ?? null;
  if (agent === null) {
    return { ok: false, mismatches: ["refresh returned no agent snapshot"] };
  }
  const mismatches: string[] = [];
  if (pin.labels === null) mismatches.push("label:create-provenance-unavailable");
  else for (const [key, value] of Object.entries(pin.labels ?? {})) {
    if (agent.labels?.[key] !== value) mismatches.push(`label:${key}:mismatch`);
  }
  if (agent.id !== agentId) mismatches.push(`agentId:${agent.id ?? "unreported"}`);
  if (agent.provider !== pin.provider) {
    mismatches.push(`provider:${agent.provider ?? "unreported"}`);
  }
  if (agent.cwd !== pin.cwd) {
    mismatches.push(`cwd:${agent.cwd ?? "unreported"}`);
  }
  if (agent.model === undefined || agent.model !== pin.model) {
    mismatches.push(`model:${agent.model === undefined ? "unreported" : agent.model}`);
  }
  if (pin.workspaceId !== null) {
    if (agent.workspaceId !== pin.workspaceId) {
      mismatches.push(`workspaceId:${agent.workspaceId ?? "unreported"}`);
    }
  } else if (agent.workspaceId !== null) {
    mismatches.push(`workspaceId:${agent.workspaceId ?? "unreported"}`);
  }
  // The parent label is the only snapshot-side parent evidence.
  const parentLabel = agent.labels?.["paseo.parent-agent-id"] ?? null;
  if (pin.parent !== null) {
    if (parentLabel !== pin.parent) {
      mismatches.push(`parent:${parentLabel ?? "unreported"}`);
    }
  } else if (parentLabel !== null) {
    mismatches.push(`parent:${parentLabel}`);
  }
  // Requested runtime tuple — verified against the snapshot's applied
  // fields; a seat that can't report the request is not the bound seat.
  if (pin.modeId != null && agent.currentModeId !== pin.modeId) {
    mismatches.push(`mode:${agent.currentModeId === undefined ? "unreported" : agent.currentModeId}`);
  }
  if (pin.modeIdUnsupported === true && agent.currentModeId !== null) {
    mismatches.push(`mode:unsupported:${agent.currentModeId === undefined ? "unreported" : String(agent.currentModeId)}`);
  }
  if (pin.thinkingOptionId != null) {
    const reported = agent.thinkingOptionId ?? agent.effectiveThinkingOptionId;
    if (reported !== pin.thinkingOptionId) {
      mismatches.push(`thinking:${reported == null ? "unreported" : reported}`);
    }
  }
  const wantedFeatures = pin.features ?? null;
  if (wantedFeatures !== null && Object.keys(wantedFeatures).length > 0) {
    if (agent.features === undefined) {
      mismatches.push("features:unreported");
    } else {
      for (const [id, value] of Object.entries(wantedFeatures)) {
        const entry = agent.features.find(f => f.id === id);
        if (entry === undefined) mismatches.push(`feature:${id}:absent`);
        else if (entry.value !== value) mismatches.push(`feature:${id}:${String(entry.value)}`);
      }
    }
  }
  if (agent.archivedAt !== null) {
    mismatches.push(`archivedAt:${agent.archivedAt ?? "unreported"}`);
  }
  return {
    ok: mismatches.length === 0,
    mismatches: privateTicket === null ? mismatches : mismatches.map(value => value.replaceAll(privateTicket, "[REDACTED]")),
    workspaceId: agent.workspaceId ?? null, parent: parentLabel,
  };
}
