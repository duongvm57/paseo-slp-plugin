// Open, Human-authored Peer options. These defaults seed a new pool only;
// template names/ids never determine routing behavior.
export const PRESET_ROUTING_VERSION = 'peer-presets-v2-runtime-provider';
export type EffortPolicy = { kind: 'select'; allowed?: string[] } | { kind: 'fixed'; thinkingOptionId: string | null };
// Historical v2 literal retained for saved-pool compatibility; it now compares
// runtime providers, not Human-declared model vendors.
export type PresetRuntimeRule = 'none' | 'different-model-provider';
export interface PresetFields {
  displayName?: string; description?: string; selectionHints?: string;
  modelProvider?: string; templateOrigin?: string | null;
  effortPolicy?: EffortPolicy; runtimeRule?: PresetRuntimeRule;
}
export const PEER_PRESETS = [
  { id: 'fast', displayName: 'Fast', description: 'Prioritize responsiveness and efficiency when a lighter model is sufficient.' },
  { id: 'balanced', displayName: 'Balanced', description: 'Balance capability, responsiveness, and execution cost for general work.' },
  { id: 'advanced', displayName: 'Advanced', description: 'Favor stronger capability for complex reasoning and sustained work.' },
  { id: 'frontier', displayName: 'Frontier', description: 'Offer the strongest configured capability for the most demanding problems.' },
  { id: 'cross-provider', displayName: 'Cross-provider', description: 'Use a different runtime provider from the reference seat for an alternative perspective, such as Codex reviewing work done by Devin.' },
] as const;
export function starterPeerOptions() {
  return PEER_PRESETS.map(p => ({ ...p, templateOrigin: p.id, provider: '' as const, model: '', roles: ['peer'],
    enabled: false, availability: 'ready', suitableFor: [] as string[], avoidFor: [] as string[], notes: '',
    effortPolicy: { kind: 'select' as const },
    runtimeRule: p.id === 'cross-provider' ? 'different-model-provider' as const : 'none' as const }));
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const setting = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9._-]+$/.test(v);
/** Dependency-free validator shared by CLI and RPC; never validates v1 as v2. */
export function presetOptionError(o: Record<string, unknown>): string | null {
  for (const [key, max] of [['displayName', 120], ['description', 4000], ['selectionHints', 4000], ['modelProvider', 160]] as const) {
    if (key === 'displayName' || key === 'description' || o[key] !== undefined) {
      if (typeof o[key] !== 'string' || o[key].length > max) return `${key} must be text of at most ${max} characters`;
    }
  }
  if (o.enabled && (!(o.displayName as string).trim() || !(o.description as string).trim())) return 'enabled presets require a name and description';
  if (o.runtimeRule !== 'none' && o.runtimeRule !== 'different-model-provider') return 'invalid runtimeRule';
  if (o.templateOrigin != null && (typeof o.templateOrigin !== 'string' || o.templateOrigin.length > 120)) return 'invalid templateOrigin';
  const policy = o.effortPolicy;
  if (!object(policy)) return 'effortPolicy is required';
  if (policy.kind === 'fixed') {
    if (policy.thinkingOptionId !== null && !setting(policy.thinkingOptionId)) return 'fixed effort requires a thinkingOptionId or explicit null (runtime default)';
    if (Object.keys(policy).some(k => !['kind', 'thinkingOptionId'].includes(k))) return 'unexpected fixed effort field';
    if (o.thinkingOptionId != null && o.thinkingOptionId !== policy.thinkingOptionId) return 'thinkingOptionId conflicts with fixed effortPolicy';
  } else if (policy.kind === 'select') {
    if (Object.keys(policy).some(k => !['kind', 'allowed'].includes(k))) return 'unexpected selectable effort field';
    if (policy.allowed !== undefined && (!Array.isArray(policy.allowed) || !policy.allowed.length || policy.allowed.some(v => !setting(v)) || new Set(policy.allowed).size !== policy.allowed.length)) return 'allowed efforts must be a nonempty unique setting-id list (omit for all supported effort values)';
    if (o.thinkingOptionId != null) return 'selectable effort cannot carry a fixed thinkingOptionId';
  } else return 'effortPolicy kind must be select or fixed';
  return null;
}
/** Known pure effort identifiers, or an explicit host semantic declaration.
 * Unknown choices (e.g. orchestration modes) remain available only as Fixed. */
export const isAutomaticEffort = (option: { id: string; metadata?: Record<string, unknown> }) =>
  option.metadata?.kind === 'effort' || /^(minimal|low|medium|high|xhigh|max)$/.test(option.id);
