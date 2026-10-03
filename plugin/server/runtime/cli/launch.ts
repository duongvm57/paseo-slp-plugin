import type { Binding, LaunchRequest, Provider, Route, NestedSnapshot } from './types.ts';
interface ResolvedBinding {
  binding: Binding;
  routing?: ReturnType<typeof catalogBinding>['routing'];
  warnings?: string[];
}
interface BindingSource {
  name: string;
  token: string;
  selects(request: LaunchRequest): boolean;
  resolve(role: string, request: LaunchRequest, route: Route): ResolvedBinding;
}
type HandoffPacket = ReturnType<typeof handoffPacket>;
interface LaunchCheck {
  name: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
  skipped?: boolean;
}
import type { RuntimeError } from './types.ts';
import { join, isAbsolute, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { savedProfileBinding, roleProvider, providerId, profileId, roles } from './profiles.ts';
import { verifyInstall, snapshot, readJson } from './package.ts';
import { catalogBinding, readCatalog } from './routing.ts';
import { bindingCheck, dispositionPattern, verifyProvider } from './binding.ts';
import { roleInstructions, orchestrates, policyLocators, carrierBlock } from './role-bundle.ts';
import { spawnKit } from './spawn-kit.ts';
import { assignmentFileSelection, assignmentCarrier } from './assignment-file.ts';
import { SLP_ROLE_PREFIX, LAUNCH_BINDING_PREFIX, ASSIGNMENT_HEADER, PLAN_LOCATOR_CAPTION } from '../../../shared/runtime/session-delivery.ts';
import { buildHandoffRecap } from '../handoff-recap.ts';

// Every Binding source normalises to { binding, routing? } right here, so nothing
// downstream unwraps a source-specific shape. Order is precedence, highest first.
const bindingSources: BindingSource[] = [
  {
    name: 'saved profiles',
    token: 'saved-profile',
    selects: request => request.profiles != null,
    resolve: (role, request, route) => ({ binding: savedProfileBinding(role, request.profiles!, request.providers!, route) }),
  },
  {
    name: 'catalog routing',
    token: 'catalog-option',
    selects: request => request.route?.optionId != null,
    resolve: (role, request, route) => catalogBinding(request.repository, role, request.providers, route, request.paseoHome),
  },
  {
    name: 'an explicit binding',
    token: 'explicit-binding',
    selects: request => request.binding != null,
    resolve: (role, request) => ({ binding: request.binding! }),
  },
];

export function resolveBinding(role: string, request: LaunchRequest, disposition?: string) {
  if (role === 'peer') {
    if (request.binding != null) throw new Error('Peer requires a project pool option; explicit bindings cannot bypass routing');
    // Profile inventory may accompany discovery, but never selects a Peer runtime.
    if (!request.route?.optionId) throw new Error('Peer requires a project routing option; run onboarding and select route.optionId with catalogSha256');
    return { ...catalogBinding(request.repository, role, request.providers, { ...request.route, disposition }, request.paseoHome), bindingSource: 'catalog-option' };
  }
  const source = bindingSources.find(candidate => candidate.selects(request));
  if (!source) throw new Error('Binding source required: saved profiles, catalog routing or an explicit binding');
  if (request.binding != null && source.name !== 'an explicit binding') {
    throw new Error(`Choose ${source.name} or an explicit binding, not both`);
  }
  return { ...source.resolve(role, request, { ...request.route, disposition }), bindingSource: source.token };
}

export function prompt(root: string, role: string, assignment: string, binding: Binding) {
  bindingCheck(binding);
  // Stock providers carry role instructions inside the prompt; the carrier is
  // appended by plan(), so the inline copy opts out to avoid a duplicate block.
  const instructions = binding.provider === roleProvider(role, binding.provider)
    ? roleInstructions(root, role, process.env, { carrier: false }) : `${SLP_ROLE_PREFIX}${role}\n`;
  return `${instructions}\n${LAUNCH_BINDING_PREFIX} ${JSON.stringify(binding)}\n${ASSIGNMENT_HEADER}\n${assignment}\n`;
}

// Provider switching creates a new session; it never mutates provider identity
// or reparents agents. The packet is evidence, gathered before anything is planned.
function handoffPacket(request: LaunchRequest) {
  const handoff = request.handoff;
  for (const key of ['previousAgentId', 'reason', 'authority', 'state']) {
    if (typeof handoff?.[key] !== 'string' || !(handoff[key] as string).trim()) throw new Error(`Missing handoff ${key}`);
  }
  if (handoff!.previousOwner?.settled !== true || typeof handoff!.previousOwner.evidence !== 'string' || !handoff!.previousOwner.evidence.trim()) {
    throw new Error('Handoff requires old-owner settlement evidence; quota failure or idle alone is insufficient');
  }
  if (!Array.isArray(handoff!.resources)) throw new Error('Handoff requires a resources list (including remaining Peer IDs and wake owners)');
  const candidate = snapshot(request.repository);
  const nestedIncomplete: string[] = [];
  const collect = (subs: NestedSnapshot[] | undefined, prefix = ''): void => subs?.forEach(sub => {
    sub.incomplete?.forEach(path => nestedIncomplete.push(`${prefix}${sub.path}/${path}`));
    collect(sub.nested, `${prefix}${sub.path}/`);
  });
  collect(candidate.nested);
  const measurement = { repository: candidate.root, head: candidate.head, sha256: candidate.sha256,
    ...(candidate.incomplete ? { incomplete: candidate.incomplete } : {}),
    ...(nestedIncomplete.length ? { nestedIncomplete } : {}) };
  const recap = buildHandoffRecap(handoff!.recapInputs, measurement);
  return { ...handoff, candidate: { head: candidate.head, sha256: candidate.sha256,
    ...(candidate.incomplete ? { incomplete: candidate.incomplete } : {}),
    ...(nestedIncomplete.length ? { nestedIncomplete } : {}) }, recap };
}

const unprovenScope = (packet: HandoffPacket | null) => [...(packet?.candidate?.incomplete ?? []), ...(packet?.candidate?.nestedIncomplete ?? [])];

const handoffNotice = (role: string, packet: HandoffPacket) => `\nProvider handoff evidence:\n${JSON.stringify(packet, null, 2)}\n` +
  'Before taking ownership, verify the current candidate and old-owner settlement against host/repository evidence. ' +
  'The caller-supplied settlement entry is a request claim; settlement remains unverified and receiving-owner acknowledgment has not been observed. ' +
  'Reconcile existing Peer/workspace/resource ownership with the Human or assigned Supervisor. ' +
  'Parentage has not changed; do not claim control of old descendants or create duplicate writers. ' +
  (packet.recap.gaps.length ? `Structured handoff context is incomplete: ${packet.recap.gaps.join(', ')}. ` : '') +
  (unprovenScope(packet).length
    ? `Snapshot evidence gap: ${unprovenScope(packet).join(', ')} ${unprovenScope(packet).length > 1 ? 'are' : 'is'} unproven submodule scope — do not claim full-candidate coverage for it. `
    : '') +
  'Acknowledge the transferred assignment. ' +
  (orchestrates(role) ? 'Use references/provider-routing.md for the handoff procedure.\n' : 'Return bounded findings to Lead; do not manage agents.\n');

// request.inventoryFile fills providers/profiles the request did not inline;
// explicit inline arrays always win. The file must be a JSON object whose
// providers/profiles fields, when present, are arrays.
function mergeInventory(request: LaunchRequest) {
  if (request.inventoryFile == null) return request;
  if (typeof request.inventoryFile !== 'string' || !isAbsolute(request.inventoryFile)) throw new Error('Absolute inventoryFile required');
  let inventory: Pick<LaunchRequest, 'providers' | 'profiles'>;
  try { inventory = (readJson(request.inventoryFile) as Pick<LaunchRequest, 'providers' | 'profiles'>); }
  catch (error) { throw new Error(`inventoryFile is not a readable JSON file: ${request.inventoryFile} (${(error as RuntimeError).message})`); }
  if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory)) throw new Error('inventoryFile must be a JSON object');
  for (const key of ['providers', 'profiles'] as const) {
    if (inventory[key] != null && !Array.isArray(inventory[key])) throw new Error(`inventoryFile.${key} must be an array`);
    if (request[key] == null && inventory[key] != null) request = { ...request, [key]: inventory[key] };
  }
  return request;
}

// The repository's declared default spawn mode — the `agent_mode` key in
// .paseo-slp/workspace-protocol.md frontmatter. A binding-level modeId wins;
// this fills the gap before the plan reports 'none'. Read advisory-only:
// absent file, missing key or an empty value all yield null.
function agentMode(repository: string) {
  let text;
  try { text = readFileSync(join(repository, '.paseo-slp', 'workspace-protocol.md'), 'utf8'); }
  catch { return null; }
  if (!text.startsWith('---')) return null;
  const parts = text.split(/^---[ \t]*$/m);
  if (parts.length < 3) return null;
  const line = parts[1].match(/^agent_mode:[ \t]*(.*?)[ \t]*$/m);
  if (!line) return null;
  const raw = line[1];
  const value = raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))
    ? raw.slice(1, -1) : raw;
  return value === '' ? null : value;
}

// modeId provenance, emitted on every plan: `binding` for an explicit
// request.binding, `bundle` for the saved-profile or catalog-option pin,
// `agent_mode` for the protocol frontmatter fallback, `none` when nothing
// resolves. A permission mode never expands task authority, and the host
// refuses cross-family inheritance — 'none' is a gap to fix by pinning the
// mode in the Human-owned option/profile or asking the Human, never a silent
// inherit. The provenance warnings live here so plan() and launchCheck report
// the same words for the same resolution.
function resolveMode(binding: Binding, bindingSource: string | undefined, repository: string) {
  if (binding?.modeId != null) {
    return { modeId: binding.modeId, modeIdSource: bindingSource === 'explicit-binding' ? 'binding' : 'bundle', warnings: [] };
  }
  const fallback = agentMode(repository);
  return fallback != null
    ? { modeId: fallback, modeIdSource: 'agent_mode', warnings: [`modeId '${fallback}' resolved from .paseo-slp/workspace-protocol.md agent_mode, not pinned in the binding — prefer pinning modeId in the pool option or saved profile so the plan is self-describing`] }
    : { modeId: null, modeIdSource: 'none', warnings: ['no modeId resolved (none in the binding and no agent_mode in .paseo-slp/workspace-protocol.md) — the spawn would inherit the caller default and cross-family inheritance fails at the host; pin modeId in the pool option or saved profile, or ask the Human'] };
}

// The orientation manifest carries mechanical locators only — installed root,
// routing catalog hash, and the byte size + sha256 of each policy file the
// role's bundle loads — so a new seat skips the filesystem hunt. It must never
// pre-solve interpretation: entries sort by path so the list carries no
// bundle/load-order hint, and there are no load-bearing markers or digested
// content (note #33: seat-side re-derivation is the check that catches upstream
// premise errors). A receipt-declared file absent from disk is still listed,
// marked missing, so a broken install stays visible to the seat.
function orientation(root: string, role: string, routing?: ResolvedBinding['routing']) {
  return {
    installedRoot: root,
    catalogSha256: routing?.catalogSha256 ?? null,
    policyBytes: policyLocators(root, role),
  };
}

// The carrier is the self-contained block that actually reaches the spawned
// seat: create_agent transmits only create.initialPrompt, so plan-level
// spawnKit/orientation alone would never arrive. carrierBlock() (shared with
// role-bundle) repeats the same data in compact text — absolute policy
// locators (missing markers included) and the approximate kit signatures —
// with no file contents inlined. This caption is pinned by contract: the
// values are plan-time, measured where prepare ran.

// The prompt-side carrier is dropped only when the target is this package's
// canonical role wrapper for the requested role AND the request's provider
// inventory observed it live — the wrapper injects the same carrier at
// session entry, so shipping both duplicates the block in one session. A
// bare slp-* prefix or caller env proves nothing about the receiving
// provider; a legacy or unverified target keeps the fallback carrier. When
// in doubt the block stays: a duplicate is recoverable, a missing carrier
// is not.
function targetInjectsCarrier(role: string, binding: Binding, providers?: Provider[]) {
  try {
    const family = roleProvider(role, binding.provider);
    if (binding.provider !== providerId(role, family)) return false;
    verifyProvider(providers, binding.provider, () => family);
    return true;
  } catch { return false; }
}

// The request-shape rules — one validator shared by plan() and launchCheck so
// the preflight can never drift from what the planner enforces.
function requestShape(request: LaunchRequest, role: string, disposition?: string) {
  if (!roles.includes(role)) throw new Error('Unknown role');
  if (disposition != null && (role !== 'peer' || typeof disposition !== 'string' || !dispositionPattern.test(disposition))) throw new Error('Invalid Peer disposition');
  for (const key of ['workspaceId', 'repository', 'assignment']) {
    if (typeof request[key] !== 'string' || !request[key].trim()) throw new Error(`Missing ${key}`);
  }
  if (!isAbsolute(request.repository)) throw new Error('Absolute repository required');
}

function agentTitle(role: string, disposition: string | undefined, request: LaunchRequest, packet: HandoffPacket | null) {
  const label = request.taskLabel ?? (basename(request.repository) || 'Task');
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 100 || /[\x00-\x1f\x7f]/.test(label)) {
    throw new Error('taskLabel must be a nonempty single-line string of at most 100 characters');
  }
  const display = (value: string) => value[0].toUpperCase() + value.slice(1).toLowerCase();
  return [display(role), ...(role === 'peer' ? [display(disposition ?? 'general')] : []),
    label.trim(), ...(packet ? ['Handoff'] : [])].join(' — ');
}

// One owner for preparation state and validation operations. Diagnostics retain
// their historical inventory-first order and continue after individual failures;
// planning checks request shape first and throws immediately. Nothing is cached
// across calls: launchCheck's final plan must read the live inputs again.
function prepareInputs(request: LaunchRequest, inspect?: (name: string, fn: () => unknown) => unknown) {
  const role = request.role ?? 'supervisor';
  const disposition = request.disposition ?? request.route?.disposition;
  let merged = request, assignmentSelection: ReturnType<typeof assignmentFileSelection> | undefined, resolved: (ResolvedBinding & { bindingSource: string }) | undefined;
  const operations = {
    request: () => requestShape(request, role, disposition),
    inventoryFile: () => { merged = mergeInventory(request); },
    assignmentFile: () => { assignmentSelection = assignmentFileSelection(merged); },
    binding: () => {
      const result = resolveBinding(role, merged, disposition);
      roleProvider(role, result.binding?.provider);
      resolved = result;
      return result;
    },
  };
  const order = inspect
    ? ['inventoryFile', 'assignmentFile', 'request', 'binding']
    : ['request', 'inventoryFile', 'assignmentFile', 'binding'];
  for (const name of order as (keyof typeof operations)[]) {
    if (inspect) inspect(name, operations[name]);
    else operations[name]();
  }
  return { request: merged, role, disposition, assignmentSelection, ...resolved };
}

// The single owner of the create_agent argument record. Nothing edits it afterwards.
function plan(root: string, request: LaunchRequest, packet: HandoffPacket | null) {
  verifyInstall(root);
  const prepared = prepareInputs(request) as ReturnType<typeof prepareInputs> & ResolvedBinding;
  const { role, disposition, assignmentSelection, binding, routing, bindingSource } = prepared;
  request = prepared.request;
  const assignment = `Repository: ${request.repository}\nWorkspace ID: ${request.workspaceId}\n${disposition ? `Disposition: ${disposition}\n` : ''}${request.assignment}`
    + assignmentCarrier(assignmentSelection);
  // Surface the intended mode once, at plan level, with its provenance: an
  // unresolved mode would silently fall back to the caller's default at
  // create_agent time — and cross-family inheritance fails at the host.
  const { modeId, modeIdSource, warnings: modeWarnings } = resolveMode(binding, bindingSource, request.repository);
  const warnings = [...(prepared.warnings ?? []), ...modeWarnings];
  const kit = spawnKit(role);
  const manifest = orientation(root, role, routing);
  return {
    transport: 'Paseo create_agent; settings.features must be preserved',
    role, instructionPath: join(root, `src/roles/${role}.md`),
    modeId,
    modeIdSource,
    ...(warnings.length ? { warnings } : {}),
    ...(routing ? { routing } : {}),
    ...(binding?.profileId ? { profileId: binding.profileId } : {}),
    create: {
      title: agentTitle(role, disposition, request, packet),
      notifyOnFinish: true,
      provider: `${binding.provider}/${binding.model}`,
      workspaceId: request.workspaceId,
      initialPrompt: prompt(root, role, assignment, binding)
        + (targetInjectsCarrier(role, binding, request.providers) ? '' : carrierBlock(kit, manifest.policyBytes, PLAN_LOCATOR_CAPTION))
        + (packet ? handoffNotice(role, packet) : ''),
      settings: {
        ...(modeId != null ? { modeId } : {}),
        ...(binding.thinkingOptionId ? { thinkingOptionId: binding.thinkingOptionId } : {}),
        features: binding.features ?? {},
      },
    },
    spawnKit: kit,
    orientation: manifest,
    ...(packet ? { handoff: packet, activation: 'Paseo create_agent after current settlement verification; no agent started by this command' } : {}),
  };
}

export const launchPlan = (root: string, request: LaunchRequest) => plan(root, request, null);
export const handoffPlan = (root: string, request: LaunchRequest) => plan(root, request, handoffPacket(request));

// The provider id the request points at, for the live-verification diagnostic
// when binding resolution already failed — a lookup of the same fields the
// resolvers read, never a second resolution rule.
function providerGuess(role: string, request: LaunchRequest) {
  if (typeof request.binding?.provider === 'string') return request.binding.provider;
  if (role === 'peer' || request.route?.optionId != null) {
    try {
      const catalog = readCatalog(request.repository, request.paseoHome);
      const option = catalog.options.find(item => item.id === request.route?.optionId);
      return option ? providerId(role, option.provider) : undefined;
    } catch { return undefined; }
  }
  const id = request.route?.profileId ?? profileId(role);
  return request.profiles?.find(profile => profile.id === id)?.provider;
}

// prepare --check: the same stages plan() runs, in the same order, with each
// failure captured into a named check instead of aborting — one report lists
// every blocker. No second rule set: each step calls the validators the
// planner itself calls, and the final 'plan' step is the planner verbatim.
// Provider live verification is its own check so a complete profile is never
// conflated with a verified provider: 'binding' can fail on a missing profile
// while 'provider' still reports the target's observed state, or the profile
// resolves cleanly while 'provider' refuses configured-only inventory.
export function launchCheck(root: string, request: LaunchRequest, { handoff = false } = {}) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, checks: [{ name: 'request', ok: false, error: 'Request must be a JSON object' }] };
  }
  const checks: LaunchCheck[] = [];
  const step = <T>(name: string, fn: () => T): T | undefined => {
    try {
      const detail = fn();
      checks.push(detail === undefined ? { name, ok: true } : { name, ok: true, detail });
      return detail;
    } catch (error) {
      checks.push({ name, ok: false, error: (error as RuntimeError).message });
      return undefined;
    }
  };
  step('install', () => { verifyInstall(root); });
  const { request: merged, role, binding, bindingSource, warnings: bindingWarnings } = prepareInputs(request, step);
  const provider = binding?.provider ?? providerGuess(role, merged);
  // Live verification is mandatory for profile/catalog resolutions (their
  // resolvers embed verifyProvider); for a pure explicit binding the planner
  // only uses it to dedup the carrier, so an unverified provider is reported
  // as advisory, not a failure — the prompt keeps the fallback block.
  const providerRequired = role === 'peer' || merged.route?.optionId != null || merged.profiles != null;
  if (provider === undefined) {
    checks.push(providerRequired
      ? { name: 'provider', ok: false, error: 'Target provider undetermined — resolve the binding first' }
      : { name: 'provider', ok: true, detail: 'no provider to verify — prompt carrier retained' });
  } else {
    step('provider', () => {
      try {
        verifyProvider(merged.providers, provider, id => roleProvider(role, id));
        return `live-verified: ${provider}`;
      } catch (error) {
        if (!providerRequired) return `not live-verified (${(error as RuntimeError).message}) — prompt carrier retained`;
        throw error;
      }
    });
  }
  if (binding) step('settings', () => bindingCheck(binding));
  else checks.push({ name: 'settings', ok: true, skipped: true, detail: 'skipped — no resolved binding to check' });
  const warnings = [...(bindingWarnings ?? []),
    ...(binding != null ? resolveMode(binding, bindingSource, merged.repository).warnings : [])];
  if (handoff) step('handoff', () => { handoffPacket(request); });
  step('plan', () => { (handoff ? handoffPlan : launchPlan)(root, request); });
  return { ok: checks.every(check => check.ok), checks, ...(warnings.length ? { warnings } : {}) };
}

// prepare --schema: the request contract plan() consumes, emitted so Humans
// and tools can author request files without a request file, an installed
// receipt or a daemon. Descriptive only — it validates nothing; --check runs
// the planner's own validators against a real request.
export function requestSchema(handoff = false) {
  const doc = {
    description: 'Request contract for slp.mjs prepare — descriptive only; --check runs the same stages the planner runs',
    base: {
      repository: 'required — absolute path to the work repository',
      workspaceId: 'required — the existing Paseo workspace ID the seat joins',
      assignment: 'required — bounded objective: scope, authority, report-recipient agent ID, verification and handback',
      role: 'supervisor | lead | peer — default supervisor',
      taskLabel: 'optional — at most 100 chars, single line; defaults to the repository directory name',
      assignmentFile: 'optional — absolute path to the per-seat full assignment; referenced in pointer mode, read and inlined only in snapshot mode',
      assignmentFileMode: 'optional — pointer (default, preserves read-first prompt) | snapshot (read and inline a guarded repository-contained copy during prepare)',
      inventoryFile: 'optional — absolute path to a {providers, profiles} object; inline arrays (even []) take precedence',
      paseoHome: 'optional — absolute daemon home for the user-scope peer pool (slp-runtime/state/peer-pool.json)',
    },
    bindingSources: {
      'saved profiles — supervisor/lead': {
        profiles: 'list_profiles array; the slp-<role> profile must exist with model and settings configured',
        providers: 'live list_providers array from the same daemon — each provider object verbatim, unedited; configured-provenance entries are refused',
        'route.profileId': 'optional — defaults to slp-<role>',
      },
      'catalog routing — required for peer': {
        'route.optionId': 'an option id from the routes output',
        'route.catalogSha256': 'the sha256 routes returned — stale or missing fails',
        'route.disposition': 'peer only — the bounded specialism (engineer, architect, reviewer, scout, …)',
        'route.decision': 'Jev receipt from `route-decide` — verified when supplied (shadow mode records jevChoice/declined in the plan), and REQUIRED + binding when the daemon arms jev.capabilities.routing (a bare optionId then fails)',
        providers: 'live list_providers array, each provider object verbatim — the option’s canonical slp-<family>-<role> wrapper must be observed',
      },
      'explicit binding — supervisor/lead': {
        binding: '{ provider, model, modeId?, thinkingOptionId?, features? }; provider is a stock family or the canonical slp-<family>-<role> wrapper',
      },
    },
    notes: [
      'The planner emits a plan only — it never creates agents or mutates host state.',
      'Provider objects must be verbatim entries from live list_providers (request.providers) — no added, removed or edited fields; a mismatched extends or a configured/static inventory is refused, not adapted.',
      'The plan emits the resolved modeId plus modeIdSource (binding | bundle | agent_mode | none) — a catalog option or saved profile pin reports bundle, an explicit binding reports binding, the .paseo-slp/workspace-protocol.md agent_mode frontmatter is the declared fallback, and none means pin the mode in the Human-owned option/profile or ask the Human (cross-family inheritance fails at the host; a permission mode never expands task authority).',
      'prepare --check <request.json> reports each stage failure; prepare <request.json> --emit create prints the audit artifact { modeId, modeIdSource, create } — create is the verbatim create_agent argument record.',
      'Peer launches only through the project pool option: an explicit binding is refused, and profiles may accompany the request for discovery but never select the runtime.',
      'Jev routing mode is per-daemon and evaluated at plan time for both prepare and prepare-handoff (they share the plan builder): a route.decision receipt is always verified, is required whenever jev.capabilities.routing is armed, and only then binds route.optionId to the receipt choice — an enabled-but-unarmed daemon verifies and records both picks (shadow evaluation). prepare never calls the network — receipts are produced only by the explicit route-decide helper command.',
    ],
    examples: {
      supervisor: {
        repository: '<absolute path to the repository>',
        workspaceId: '<existing workspace id, e.g. wks-…>',
        role: 'supervisor',
        taskLabel: '<short task label>',
        assignment: '<bounded objective: scope, authority, report-recipient agent ID, verification, handback>',
        profiles: [{ id: 'slp-supervisor', provider: 'slp-codex-supervisor', model: '<model configured in the profile>', modeId: '<configured mode>', featureValues: {} }],
        providers: [{ id: 'slp-codex-supervisor', enabled: true, status: 'available', extends: 'codex' }],
      },
      lead: {
        repository: '<absolute path to the repository>',
        workspaceId: '<existing workspace id, e.g. wks-…>',
        role: 'lead',
        taskLabel: '<short task label>',
        assignment: '<bounded objective: scope, authority, report-recipient agent ID, verification, handback>',
        profiles: [{ id: 'slp-lead', provider: 'slp-codex-lead', model: '<model configured in the profile>', modeId: '<configured mode>', featureValues: {} }],
        providers: [{ id: 'slp-codex-lead', enabled: true, status: 'available', extends: 'codex' }],
      },
      peer: {
        repository: '<absolute path to the repository>',
        workspaceId: '<existing workspace id, e.g. wks-…>',
        role: 'peer',
        disposition: '<engineer | architect | reviewer | scout | …>',
        taskLabel: '<short task label>',
        assignment: '<bounded objective: scope, authority, report-recipient agent ID, verification, handback>',
        providers: [{ id: 'slp-<family>-peer', enabled: true, status: 'available', extends: '<family transport>' }],
        route: { optionId: '<option id from routes output>', catalogSha256: '<sha256 from routes output>' },
      },
    },
  };
  if (!handoff) return doc;
  return {
    ...doc,
    description: 'Request contract for slp.mjs prepare-handoff — the prepare base fields plus old-owner settlement evidence',
    handoff: {
      previousAgentId: 'required — the agent being replaced',
      reason: 'required — why the seat changes hands',
      authority: 'required — who authorized the replacement',
      state: 'required — the old seat’s settlement state',
      previousOwner: { settled: 'required true', evidence: 'required — settlement receipt text; quota failure or idle alone is insufficient' },
      resources: 'required array — remaining Peer IDs, wake owners and unsettled descendants',
      recapInputs: {
        optional: true,
        description: 'Explicit structured source projections only; prepare-handoff does not read arbitrary host state or source files for this recap.',
        assignment: 'source object with id, revision, sourceRef, authority claims and optional scope/objective details',
        decisions: 'source rows with proposition/ruling/reason/sourceRef; an explicit empty array means none supplied',
        assumptions: 'source rows with statement/sourceRef; an explicit empty array means none supplied',
        unresolved: 'source rows with proposition/reason/ownerId/sourceRef',
        ownerPins: 'source rows with surface/ownerId/state/basis/sourceRef',
        dependencies: 'source rows with need/state/ownerId/sourceRef',
        nextAction: 'source object with state/action/ownerId',
        resources: 'source rows with kind/id/ownerId/state/sourceRef',
        reportArtifacts: 'rows with sourceRef and an existing v1 handback record; report, candidate, checks and findings remain claims',
      },
    },
  };
}
