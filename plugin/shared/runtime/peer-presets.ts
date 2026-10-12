// Open, Human-authored Peer options. These defaults seed a new pool only;
// template names/ids never determine routing behavior.
export const PRESET_ROUTING_VERSION = 'peer-presets-v2-sufficient-fit';
/** One decision objective for both Human/Lead discovery and Jev. Advisory
 * task fit never overrides eligibility or ranks arbitrary preset names. */
export const PRESET_SELECTION_GUIDANCE = 'Follow the Human pool policy and assignment constraints. Choose the smallest sufficient configured capability and the least supported effort sufficient for the actual outcome and verification. Assess unresolved ambiguity, dependency interactions, novelty, stakes and how hard correctness is to check. Source-grounded extraction, inventory, formatting and bounded synthesis usually need less reasoning than novel solutions or uncertain premises. A long brief, many files, documentation, review or architecture labels alone do not justify stronger capability or higher effort. Justify extra capability or effort by a concrete unresolved difficulty or Human requirement; verification remains required at every level. Compare model capability and effort separately, using Human descriptions/hints and host effort descriptions. Preset names, ordering, provider identity and model-name suffixes do not define rank or price. If fit cannot be established, decline. Selection grants no retries, budget expansion or changes to the configured bundle.';
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
  { id: 'fast', displayName: 'Fast', description: 'Use for clear, bounded work with settled steps: source lookup, extraction, formatting or mechanical edits. Prefer lighter effort when the result is easy to verify.' },
  { id: 'balanced', displayName: 'Balanced', description: 'Use for ordinary work with several connected steps: implementation, debugging or source-grounded synthesis. Keep scope and checks explicit; choose effort for unresolved reasoning, not output length.' },
  { id: 'advanced', displayName: 'Advanced', description: 'Use when substantial uncertainty, interacting dependencies or hard-to-check correctness needs deeper reasoning. State the concrete difficulty that a lighter configured option cannot adequately handle.' },
  { id: 'frontier', displayName: 'Frontier', description: 'Reserve for exceptionally demanding or novel problems with difficult premises, broad dependencies or consequential tradeoffs beyond other configured options. Documentation, review or architecture alone is not a reason to use this preset.' },
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
