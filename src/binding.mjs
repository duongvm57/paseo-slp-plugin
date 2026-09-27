// A Binding is the complete runtime bundle handed to Paseo create_agent:
// provider, model and the optional mode/thinking/features settings.
// This module owns every rule a Binding must satisfy, whatever produced it.
// Leaf module: it imports nothing from the package, so every producer can use it.

export const settingIdPattern = /^[a-zA-Z0-9._-]+$/;
export const unsafeModelPattern = /[\s\x00-\x1f\x7f]/;
export const dispositionPattern = /^[a-z][a-z0-9-]*$/i;

// Paseo resolves an installed wrapper through its `extends` base adapter.
// Devin itself is a derived ACP provider (`extends: acp`), so slp-devin-*
// wrappers must extend the acp adapter; codex/pi/claude extend their own builtins.
export const providerTransports = { codex: 'codex', pi: 'pi', devin: 'acp', claude: 'claude' };
export const transportOf = family => providerTransports[family] ?? family;

// Devin bindings run swe-2 models only (host policy for this provider family).
export const devinProviderPattern = /^(devin|slp-devin-[a-z-]+)$/;
export const swe2ModelPattern = /^swe-2($|-)/;

// Route keys a caller may never use to override a chosen runtime bundle.
export const runtimeSettingKeys = ['provider', 'model', 'modeId', 'thinkingOptionId', 'features'];
// Keys that only mean something on the catalog path...
export const catalogRouteKeys = ['optionId', 'catalogSha256', 'catalogFile'];
// ...and the key that only means something on the saved-profile path.
export const profileRouteKeys = ['profileId'];

export function rejectRouteKeys(route, keys, message) {
  for (const key of keys) if (Object.hasOwn(route, key)) throw new Error(message(key));
}

// The top-level vocabulary of a verbatim provider record — the contract
// verifyProvider enforces. `id` and `enabled` are required in effect — the
// find and the fail-closed enabled gate below refuse their absence before
// this list is consulted; `status`, `label`, `description`, `modes` ride
// along — normalized reads (src/inventory.mjs) legitimately omit them.
// `extends` appears on derived providers (devin extends acp). Anything else —
// including a forged provenance — means the entry was edited after the call.
export const providerRecordAllowedKeys = ['id', 'enabled', 'status', 'label', 'description', 'modes', 'extends', 'paseoTools', 'disallowedTools'];

// One provider-health rule for every Binding source. familyFor resolves the
// expected provider family from the observed provider id, and may itself reject.
export function verifyProvider(inventory, id, familyFor, label = id) {
  if (!Array.isArray(inventory)) throw new Error('Paseo list_providers inventory required: pass the discovered providers array verbatim as request.providers — the live list_providers array, not the tool response envelope, a configured inventory or hand-edited entries');
  const observed = inventory?.find(item => item.id === id);
  // Fail closed on enabled: only an observed true proves the provider is
  // usable — a tri-state null (unknown) or a stripped key must not slip past
  // targetInjectsCarrier into dropping the prompt-carrier fallback.
  if (!observed || observed.enabled !== true || observed.status === 'unavailable') throw new Error(`Unverified provider ${label}: no entry with enabled===true for that id in the live list_providers inventory (observed enabled: ${observed ? JSON.stringify(observed.enabled) : 'no matching entry'}) — provider objects must be verbatim from list_providers, unedited`);
  // Managed-runtime inventory entries carry provenance:"configured" — static
  // config reads, never live provider state. Launch planning requires live
  // selected-connection inventory, so the enabled/status checks alone are
  // insufficient here (spec §10).
  if (observed.provenance === 'configured') throw new Error(`Unverified provider ${label}: configured inventory is not live evidence — pass provider objects verbatim from list_providers on the same daemon`);
  // Verbatim shape: an added key (forged marker, injected flag) means the
  // entry was edited after list_providers returned it — removed required keys
  // already refused above. The check runs after the provenance refusal so
  // configured reads keep their tailored error.
  const extraKeys = Object.keys(observed).filter(key => !providerRecordAllowedKeys.includes(key));
  if (extraKeys.length) throw new Error(`Unverified provider ${label}: unexpected field(s) ${extraKeys.map(key => `'${key}'`).join(', ')} — the provider object must be verbatim from list_providers; do not add, remove or edit fields`);
  const family = familyFor(observed.id);
  if (observed.extends != null && observed.extends !== transportOf(family)) throw new Error(`Unverified provider family ${label}: the entry's 'extends' (${observed.extends}) does not match the '${family}' transport '${transportOf(family)}' — the provider object must be verbatim from list_providers; do not add, remove or edit fields`);
  return { observed, family };
}

export function bindingCheck(binding) {
  if (!binding || typeof binding.provider !== 'string' || !settingIdPattern.test(binding.provider)) throw new Error('Provider required');
  if (binding.modeId != null && (typeof binding.modeId !== 'string' || !settingIdPattern.test(binding.modeId))) throw new Error('Invalid mode');
  if (typeof binding.model !== 'string' || !binding.model || unsafeModelPattern.test(binding.model)) throw new Error('Explicit model required');
  if (devinProviderPattern.test(binding.provider) && !swe2ModelPattern.test(binding.model)) throw new Error('Devin bindings require a swe-2 model');
  if (binding.thinkingOptionId != null && (typeof binding.thinkingOptionId !== 'string' || !settingIdPattern.test(binding.thinkingOptionId))) throw new Error('Invalid thinking option');
  // create_agent declares features an object; an absent value becomes {} at launch.
  if (binding.features != null && (typeof binding.features !== 'object' || Array.isArray(binding.features))) throw new Error('Invalid features');
}
