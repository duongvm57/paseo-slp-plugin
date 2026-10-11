// v2 routing is isolated from the retained v1 token/archetype contract.
import type { Catalog, CatalogOption, ResolvedCatalog } from './routing.ts';
import type { Provider, Route } from './types.ts';
import type { PresetFields } from '../../../shared/runtime/peer-presets.ts';
import { PRESET_ROUTING_VERSION, isAutomaticEffort } from '../../../shared/runtime/peer-presets.ts';
import { providerId, families } from './profiles.ts';
import { verifyProvider, rejectRouteKeys, runtimeSettingKeys, profileRouteKeys } from './binding.ts';
import { canonicalJson, verifyReceipt, readJevConfig, resolveJev, askJev } from './jev.ts';
import type { JevOptions, JevQuestion } from './jev.ts';
import { hash } from './package.ts';

export type PresetRoutingContext = {
  crossProvider?: boolean;
  reference?: { agentId?: string; provider: string; model: string };
};
export type PresetChoice = { candidateId: string; optionId: string; displayName: string; description: string;
  selectionHints: string; provider: string; model: string; modelProvider: string | null;
  thinkingOptionId: string | null; runtimeRule: string };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function validateRoutingContext(value: unknown): PresetRoutingContext {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).some(k => !['crossProvider', 'reference'].includes(k))
    || (value.crossProvider !== undefined && typeof value.crossProvider !== 'boolean')) throw new Error('Invalid preset routing context');
  const ref = value.reference;
  if (ref !== undefined && (!object(ref) || Object.keys(ref).some(k => !['agentId', 'provider', 'model'].includes(k))
    || ['provider', 'model'].some(k => typeof ref[k] !== 'string' || !(ref[k] as string).trim() || (ref[k] as string).length > 512)
    || (ref.agentId !== undefined && (typeof ref.agentId !== 'string' || !ref.agentId || ref.agentId.length > 256)))) throw new Error('Invalid reference runtime');
  return value as PresetRoutingContext;
}
const vendor = (s: unknown) => typeof s === 'string' && s.trim() ? s.trim().toLowerCase() : null;
const family = (provider: string) => families.find(f => provider === f || ['peer', 'lead', 'supervisor'].some(r => provider === providerId(r, f)));
function referenceVendor(catalog: Catalog, context: PresetRoutingContext) {
  if (!context.reference) return null;
  const found = new Set(catalog.options.filter(o => o.provider === family(context.reference!.provider) && o.model === context.reference!.model)
    .map(o => vendor(o.modelProvider)).filter(v => v !== null));
  return found.size === 1 ? [...found][0] : null;
}
export function presetChoiceSet(catalog: Catalog, role: string, providers: Provider[] | undefined, rawContext?: unknown) {
  const context = validateRoutingContext(rawContext), referenceModelProvider = referenceVendor(catalog, context);
  const choices: PresetChoice[] = [], excluded: { optionId: string; reasons: string[] }[] = [];
  const capabilities: { provider: string; model: string; thinkingOptions: unknown; defaultThinkingOptionId: unknown }[] = [];
  for (const option of catalog.options) {
    const preset = option as CatalogOption & PresetFields, reasons: string[] = [];
    if (!option.enabled) reasons.push('disabled');
    if (option.availability !== 'ready') reasons.push(`availability:${option.availability}`);
    if (!option.roles.includes(role)) reasons.push('role-not-listed');
    if (reasons.length) { excluded.push({ optionId: option.id, reasons }); continue; }
    const provider = providerId(role, option.provider), observed = providers?.find(p => p.id === provider);
    try { verifyProvider(providers, provider, () => option.provider); } catch { reasons.push('provider-unavailable'); }
    const model = observed?.models?.find(m => m.id === option.model && m.isSelectable !== false);
    if (!model) reasons.push('model-capability-unavailable');
    if (context.crossProvider || preset.runtimeRule === 'different-model-provider') {
      if (!context.reference || !referenceModelProvider) reasons.push('reference-model-provider-unknown');
      if (!vendor(preset.modelProvider)) reasons.push('model-provider-unknown');
      else if (vendor(preset.modelProvider) === referenceModelProvider) reasons.push('same-model-provider');
    }
    let efforts: (string | null)[] = [];
    if (model) {
      capabilities.push({ provider, model: model.id, thinkingOptions: model.thinkingOptions ?? [], defaultThinkingOptionId: model.defaultThinkingOptionId ?? null });
      const declared = model.thinkingOptions ?? [];
      if (preset.effortPolicy?.kind === 'fixed') {
        const fixed = preset.effortPolicy.thinkingOptionId;
        if (fixed !== null && !declared.some(e => e.id === fixed)) reasons.push('fixed-effort-unsupported');
        else efforts = [fixed];
      } else if (preset.effortPolicy?.kind === 'select') {
        efforts = declared.length === 0 && preset.effortPolicy.allowed === undefined ? [null]
          : declared.filter(isAutomaticEffort).filter(e => !preset.effortPolicy || preset.effortPolicy.kind !== 'select'
            || preset.effortPolicy.allowed === undefined || preset.effortPolicy.allowed.includes(e.id)).map(e => e.id);
        if (!efforts.length) reasons.push('no-supported-allowed-effort');
      } else reasons.push('invalid-effort-policy');
    }
    if (reasons.length) { excluded.push({ optionId: option.id, reasons }); continue; }
    for (const thinkingOptionId of [...new Set(efforts)]) choices.push({
      candidateId: `pair-${hash(canonicalJson([option.id, thinkingOptionId]))}`, optionId: option.id,
      displayName: preset.displayName!, description: preset.description!, selectionHints: preset.selectionHints ?? '',
      provider: option.provider, model: option.model, modelProvider: preset.modelProvider ?? null,
      thinkingOptionId, runtimeRule: preset.runtimeRule!,
    });
  }
  const selectionSha256 = hash(canonicalJson({ semantics: PRESET_ROUTING_VERSION, context, referenceModelProvider, capabilities, choices, excluded }));
  return { choices, excluded, selectionSha256, context, referenceModelProvider };
}
export function boundedPresetChoices(set: ReturnType<typeof presetChoiceSet>) {
  if (set.choices.length === 0) throw new Error(`No eligible preset + effort pair: ${JSON.stringify(set.excluded)}`);
  if (set.choices.length > 64 || Buffer.byteLength(JSON.stringify(set)) > 24 * 1024) throw new Error('Preset choices exceed 64 pairs / 24 KiB; narrow the pool or allowed efforts before selecting (no candidates were truncated)');
  return set;
}
export async function decidePresetRoute(catalog: ResolvedCatalog, request: { role: string; brief: string; providers?: Provider[]; routingContext?: unknown; paseoHome: string }, options: JevOptions = {}) {
  const set = boundedPresetChoices(presetChoiceSet(catalog, request.role, request.providers, request.routingContext));
  const { provider, key, armed } = resolveJev(request.paseoHome, 'routing', { allowShadow: true });
  const criteria = Object.fromEntries(set.choices.map(c => [c.candidateId, `${c.displayName}: ${c.description}; ${c.provider}/${c.model}; effort ${c.thinkingOptionId ?? 'runtime default'}; ${c.selectionHints}`]));
  criteria['no-suitable-option'] = 'None of the configured preset + effort pairs meets the task; decline rather than guess.';
  const questions: Record<string, JevQuestion> = { route_option: { type: 'choice',
    instructions: 'Choose one configured preset + effort pair for the task brief. Read each Human-authored description and hints, including custom presets. Names, list order, template origin and disposition are not fixed routing classes. Weigh uncertainty, constraints, proof obligations and capability; do not equate effort with model tier or infer price/health. Eligibility and explicit runtime rules are precomputed and cannot be overridden by prose. Decline when none fits. Do not propose retries or model/effort overrides.', criteria } };
  const { receipt, answers } = await askJev({ provider, key, state: { task: request.brief, role: request.role,
    semantics: PRESET_ROUTING_VERSION, options: set.choices, reference: set.context.reference ?? null,
    crossProvider: set.context.crossProvider === true }, questions,
    context: { capability: 'routing', role: request.role, armed, catalogSha256: catalog.sha256,
      vocabularyVersion: PRESET_ROUTING_VERSION, selectionSha256: set.selectionSha256,
      candidates: [...set.choices.map(c => c.candidateId)], declineCandidate: 'no-suitable-option' } }, options);
  const candidateId = (answers.route_option as { choice: string }).choice;
  const chosen = set.choices.find(c => c.candidateId === candidateId);
  return { schemaVersion: 2, optionId: chosen?.optionId ?? null, thinkingOptionId: chosen?.thinkingOptionId ?? null,
    candidateId, selectionSha256: set.selectionSha256, routingContext: set.context,
    catalogSha256: catalog.sha256, declined: candidateId === 'no-suitable-option', role: request.role,
    tokenConflicts: [], warnings: [], decision: receipt };
}
export function bindPresetCatalog(catalog: ResolvedCatalog, role: string, providers: Provider[] | undefined, route: Route, home: string) {
  const set = boundedPresetChoices(presetChoiceSet(catalog, role, providers, route.routingContext));
  if (route.selectionSha256 !== set.selectionSha256) throw new Error('Preset capabilities, reference or selection inputs changed; discover choices again');
  if (!Object.hasOwn(route, 'thinkingOptionId')) throw new Error('v2 requires an explicit selected thinkingOptionId (null for runtime default)');
  const choice = set.choices.find(c => c.optionId === route.optionId && c.thinkingOptionId === route.thinkingOptionId);
  if (!choice) throw new Error('Selected preset + effort is not eligible');
  rejectRouteKeys(route, [...profileRouteKeys, ...runtimeSettingKeys.filter(k => k !== 'thinkingOptionId')], key => `Preset runtime is complete; conflicting route.${key}`);
  const option = catalog.options.find(o => o.id === choice.optionId)!;
  const config = readJevConfig(home), armed = config?.enabled === true && config.capabilities.routing === true;
  const receipt = route.decision as import('./jev.ts').VerifiedJevReceipt | undefined;
  let jevChoice: string | undefined;
  if (receipt) {
    verifyReceipt(receipt);
    const context = receipt.context;
    if (context.capability !== 'routing' || context.catalogSha256 !== catalog.sha256 || context.role !== role
      || context.vocabularyVersion !== PRESET_ROUTING_VERSION || context.selectionSha256 !== set.selectionSha256
      || Object.keys(receipt.questions).length !== 1 || !receipt.questions.route_option
      || canonicalJson(context.candidates) !== canonicalJson(set.choices.map(c => c.candidateId))
      || canonicalJson(Object.keys(receipt.questions.route_option.criteria ?? {}).sort()) !== canonicalJson([...set.choices.map(c => c.candidateId), 'no-suitable-option'].sort())
      || (config?.provider && receipt.model !== config.provider.model)) throw new Error('Preset decision receipt inputs do not match fresh routing inputs');
    jevChoice = (receipt.answers.route_option as { choice: string }).choice;
    if (jevChoice !== 'no-suitable-option' && !set.choices.some(c => c.candidateId === jevChoice)) throw new Error('Unknown preset choice in receipt');
    if (armed && jevChoice !== choice.candidateId) throw new Error('Selected preset + effort differs from armed Jev (or Jev declined)');
  } else if (armed) throw new Error('Armed Jev requires a matching preset decision receipt');
  if (route.quotaFallbackFrom !== undefined) {
    const from = catalog.options.find(o => o.id === route.quotaFallbackFrom);
    if (!from || from.id === option.id || !from.roles.includes(role) || !catalog.quotaFallback?.enabled || catalog.quotaFallback.optionId !== option.id) throw new Error('Invalid designated quota fallback');
  }
  return { binding: { provider: providerId(role, option.provider), model: option.model, modeId: option.modeId,
    thinkingOptionId: choice.thinkingOptionId, features: structuredClone(option.features ?? {}) },
    routing: { catalogFile: catalog.path, catalogScope: catalog.scope, catalogSha256: catalog.sha256, optionId: option.id,
      thinkingOptionId: choice.thinkingOptionId, selectionSha256: set.selectionSha256, routingContext: set.context,
      jev: { required: armed, decision: receipt ? 'verified' : 'none', ...(receipt ? { jevChoice, declined: jevChoice === 'no-suitable-option' } : {}) },
      ...(route.quotaFallbackFrom ? { quotaFallbackFrom: route.quotaFallbackFrom } : {}) }, warnings: [] as string[] };
}
