// Host delivery metadata is correlation evidence, never Human authority.
// A plain user_message may also originate from an older SDK or a plugin.
import { z } from "zod";

const payload = z.object({
  event: z.enum(["message", "finished", "errored", "permission-required", "closed"]),
  sender: z.object({ id: z.string().min(1), title: z.string().min(1).optional() }),
  text: z.string(),
});
export type DeliveryTimelineItem = {
  type: string;
  messageId?: string;
  clientMessageId?: string;
  name?: string;
  status?: unknown;
  error?: unknown;
  callId?: string;
  agentMessage?: unknown;
};
export function agentMessageOf(item: DeliveryTimelineItem) {
  if (item.type !== "tool_call" || item.name !== "agent_message" || item.status !== "completed"
    || item.error !== null || typeof item.callId !== "string") return null;
  const parsed = payload.safeParse(item.agentMessage);
  if (!parsed.success) return null;
  const prefix = "paseo-agent-message:";
  return { ...parsed.data, messageId: item.callId.startsWith(prefix) && item.callId.length > prefix.length
    ? item.callId.slice(prefix.length) : null };
}
export function deliveryMessageIds(item: DeliveryTimelineItem): string[] {
  if (item.type === "user_message") return [item.messageId, item.clientMessageId]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const message = agentMessageOf(item);
  return message?.event === "message" && message.messageId !== null ? [message.messageId] : [];
}
export function matchesDelivery(item: DeliveryTimelineItem, messageId: string, senderId: string | null | undefined): boolean {
  if (item.type === "user_message") return deliveryMessageIds(item).includes(messageId);
  const message = agentMessageOf(item);
  return message?.event === "message" && message.messageId === messageId && message.sender.id === senderId;
}
/** Keep lifecycle forwarding limited to delivered-input metadata. The agent
 * envelope body is transient parser input; it never enters a task receipt. */
export function deliveryTimelineItem(item: DeliveryTimelineItem): DeliveryTimelineItem {
  if (item.type === "user_message") return { type: item.type, messageId: item.messageId, clientMessageId: item.clientMessageId };
  if (item.type === "tool_call" && item.name === "agent_message") return {
    type: item.type, name: item.name, callId: item.callId, status: item.status, error: item.error, agentMessage: item.agentMessage,
  };
  return { type: item.type };
}
