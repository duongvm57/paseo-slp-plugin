// One exact live registration predicate; native creation alone is not desk readiness.
import type { MembershipValue } from "./desk-store.ts";

export function registeredMembership(memberships: readonly MembershipValue[], pin: {
  agentId: string; provider?: string; createCwd?: string; workspaceId: string | null; role?: string;
}): MembershipValue | null {
  const row = memberships.find(m => m.agentId === pin.agentId
    && (pin.provider === undefined || m.provider === pin.provider)
    && (pin.createCwd === undefined || m.createCwd === pin.createCwd)
    && (pin.role === undefined || m.role === pin.role)
    && m.workspaceId === pin.workspaceId);
  return row !== undefined && row.registeredAt !== null && row.revokedAt === null ? row : null;
}
