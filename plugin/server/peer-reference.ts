import { canonicalJson } from "./runtime/cli/jev.ts";
// Read the explicitly named reference seat. Runtime-family names do not prove
// model vendor; Human-declared model-provider identity is resolved by the pool.
import type { PresetRoutingContext } from './runtime/cli/preset-routing.ts';
export type ReferenceHost = { agents?: { ref(id: string): { refresh(): Promise<{ agent: { id: string; provider?: string; model?: string | null } | null } | null> } } };
export async function observePeerReference(host: ReferenceHost, requirements?: { crossProvider?: boolean; referenceAgentId?: string }): Promise<PresetRoutingContext> {
  if (!requirements) return {};
  const context: PresetRoutingContext = {};
  if (requirements.crossProvider !== undefined) context.crossProvider = requirements.crossProvider;
  if (requirements.referenceAgentId !== undefined) {
    if (!host.agents) throw new Error('Reference seat observation is unavailable');
    const agent = (await host.agents.ref(requirements.referenceAgentId).refresh())?.agent;
    if (!agent || agent.id !== requirements.referenceAgentId || !agent.provider || !agent.model) throw new Error('Reference seat has no verified provider/model runtime');
    context.reference = { agentId: agent.id, provider: agent.provider, model: agent.model };
  }
  return context;
}
export async function reobservePeerReference(host: ReferenceHost, pinned: PresetRoutingContext | undefined) {
  if (!pinned) return;
  if (pinned.reference && !pinned.reference.agentId) throw new Error('Native formation/dispatch requires a reference agent ID, not a claimed runtime');
  const fresh = await observePeerReference(host, { ...(pinned.crossProvider !== undefined ? { crossProvider: pinned.crossProvider } : {}),
    ...(pinned.reference ? { referenceAgentId: pinned.reference.agentId } : {}) });
  if (canonicalJson(fresh) !== canonicalJson(pinned)) throw new Error('Reference runtime changed since selection');
}
