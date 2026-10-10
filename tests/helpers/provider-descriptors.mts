// Actual installed protocol descriptor types; future keys extend the host surface.
// The installed 0.10 type pin predates desktopTrigger, so its extension is explicit.
import type {
  AgentFeatureToggle, AgentFeatureSelect, AgentModelDefinition,
  AgentMode, AgentSelectOption,
} from "@getpaseo/protocol/agent-types";

type FutureHostField = { futureHostKey: boolean };
export const thinking = {
  id: "high", label: "High", description: "More reasoning", isDefault: true,
  metadata: { tier: 2 }, futureHostKey: true,
} satisfies AgentSelectOption & FutureHostField;
export const model = {
  provider: "codex", id: "host-model", label: "Host model",
  contextWindowMaxTokens: 65536, thinkingOptions: [thinking],
  defaultThinkingOptionId: "high", futureHostKey: true,
} satisfies AgentModelDefinition & FutureHostField;
export const mode = {
  id: "full-access", label: "Full access", description: "Host description",
  futureHostKey: true,
} satisfies AgentMode & FutureHostField;
export const toggle = {
  type: "toggle", id: "fast", label: "Fast", description: "Faster replies",
  tooltip: "Host tooltip", icon: "zap", value: true,
  desktopTrigger: "icon", futureHostKey: true,
} satisfies AgentFeatureToggle & FutureHostField & {desktopTrigger: string};
export const select = {
  type: "select", id: "thinking", label: "Thinking", value: null,
  options: [thinking], desktopTrigger: "label", futureHostKey: true,
} satisfies AgentFeatureSelect & FutureHostField & {desktopTrigger: string};
export const features = [toggle, select];
export const futureFeatures = features.map(feature => ({ ...feature, desktopTrigger: "both" }));
