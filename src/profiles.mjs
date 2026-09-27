import { dispositionPattern, rejectRouteKeys, verifyProvider,
  runtimeSettingKeys, catalogRouteKeys } from './binding.mjs';

export const roles = ['supervisor', 'lead', 'peer'];
export const profileRoles = ['supervisor', 'lead'];
export const peerPaseoToolsPolicy = {
  disabledTools: [
    'archive_agent',
    'archive_workspace',
    'cancel_agent',
    'create_agent',
    'create_heartbeat',
    'create_schedule',
    'create_workspace',
    'delete_heartbeat',
    'delete_schedule',
    'update_agent',
  ],
};
// Supervisor and Lead orchestrate; Peer owns one bounded outcome and never spawns.
export const orchestrates = role => role !== 'peer';
export const families = ['codex', 'pi', 'devin', 'claude'];
const profilePrefix = 'slp-';
export const profileId = role => `${profilePrefix}${role}`;
// Inverse of profileId. Only Peer ever had legacy `slp-peer-<disposition>` profiles.
export const roleOfProfileId = id =>
  id.startsWith(`${profileId('peer')}-`) ? 'peer' : id.slice(profilePrefix.length);
export const providerId = (role, family = 'codex') => `slp-${family}-${role}`;

export function roleProvider(role, provider) {
  if (!roles.includes(role)) throw new Error('Unknown role');
  const family = families.find(f => provider === f || provider === providerId(role, f));
  if (!family) throw new Error(`Provider must be a stock family (${families.join('/')}) or a matching SLP ${role} provider`);
  return family;
}

// Builder for the explicit-binding source: turns a saved profile plus an optional
// provider switch into a Binding a caller can hand to launchPlan as request.binding.
// The saved-profile source below wraps it and forbids every runtime override.
export function resolveProfile(role, profiles, providers, route = {}) {
  if (!roles.includes(role)) throw new Error('Unknown role');
  if (route.disposition != null && (typeof route.disposition !== 'string' || !dispositionPattern.test(route.disposition))) throw new Error('Invalid Peer disposition');
  const disposition = route.disposition?.toLowerCase();
  if (disposition && role !== 'peer') throw new Error('Disposition requires Peer role');
  const id = route.profileId ?? profileId(role);
  const profile = profiles.find(p => p.id === id);
  if (!profile) throw new Error(`Missing Paseo profile ${id}`);
  const { observed: provider, family } = verifyProvider(providers, route.provider ?? profile.provider,
    id => roleProvider(role, id), `for ${id}`);
  const switched = family !== roleProvider(role, profile.provider);
  if (switched && !route.model) throw new Error('Provider switch requires an explicit target model; old provider settings are not portable');
  const setting = (key, fallback) => Object.hasOwn(route, key) ? route[key] : switched ? undefined : fallback;
  return { profileId: id, profileProvider: profile.provider, provider: provider.id,
    model: setting('model', profile.model), modeId: setting('modeId', profile.modeId),
    thinkingOptionId: setting('thinkingOptionId', profile.thinkingOptionId),
    features: structuredClone(setting('features', profile.featureValues) ?? {}) };
}

// Saved profiles are complete Human-owned runtime bundles.
export function savedProfileBinding(role, profiles, providers, route = {}) {
  rejectRouteKeys(route, [...runtimeSettingKeys, ...catalogRouteKeys],
    key => `Saved profile settings cannot be overridden by route.${key}; ask Human to configure the agent profile`);
  if (!Array.isArray(profiles)) throw new Error('Paseo list_profiles inventory required');
  if (!Array.isArray(providers)) throw new Error('Paseo list_providers inventory required');
  const binding = resolveProfile(role, profiles, providers, route);
  const family = roleProvider(role, binding.provider);
  if (binding.provider !== providerId(role, family)) throw new Error(`Human must configure ${binding.profileId} with the matching SLP role provider`);
  if (typeof binding.model !== 'string' || !binding.model.trim()) throw new Error(`Human must configure a model in agent profile ${binding.profileId}`);
  if (binding.features === null || typeof binding.features !== 'object' || Array.isArray(binding.features)) throw new Error(`Invalid features in agent profile ${binding.profileId}`);
  return binding;
}
