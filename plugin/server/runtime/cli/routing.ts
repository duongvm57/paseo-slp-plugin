import type { Provider, Route } from './types.ts';
export interface CatalogOption extends Record<string, unknown> {
  id: string;
  provider: string;
  model: string;
  roles: string[];
  enabled: boolean;
  availability: string;
  thinkingOptionId?: string | null;
  modeId?: string | null;
  features?: Record<string, unknown> | null;
  suitableFor: string[];
  avoidFor: string[];
  notes: string;
}
export interface Catalog extends Record<string, unknown> {
  version: number;
  policy: string;
  quotaFallback?: {
    enabled: boolean;
    optionId?: string | null;
    optionIds?: string[];
  } | null;
  options: CatalogOption[];
}
interface UserPool {
  path: string;
  sha256: string;
  catalog?: Catalog;
  error?: string;
}
interface DriftOption {
  id: string;
  onlyIn?: string;
  fields?: Record<string, {
    catalog: unknown;
    pool: unknown;
  }>;
}
export interface PoolDrift {
  userPoolPath: string;
  catalogSha256: string;
  userPoolSha256: string;
  identical: boolean;
  error?: string;
  options?: DriftOption[];
}
export interface ResolvedCatalog extends Catalog {
  path: string;
  scope: string;
  sha256: string;
  tokenConflicts: ReturnType<typeof catalogTokenConflicts>;
  userPool?: UserPool | null;
  poolDrift?: PoolDrift | null;
}
import type { RuntimeError } from './types.ts';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { hash } from './package.ts';
import { families, roles, providerId } from './profiles.ts';
import { settingIdPattern, unsafeModelPattern, rejectRouteKeys, verifyProvider,
  runtimeSettingKeys, profileRouteKeys, swe2ModelPattern } from './binding.ts';
import { readJevConfig, verifyReceipt } from './jev.ts';
import { catalogTokenConflicts, seatTokenConflict, ROUTING_VOCABULARY_VERSION } from "../../../shared/runtime/routing-vocabulary.ts";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const statuses = ['ready', 'quota-exhausted', 'paused', 'unknown'];
export const emptyCatalog = (): Catalog => ({ version: 1, policy: 'Human maintains model suitability and quota. Lead chooses within the current assignment budget.', quotaFallback: { enabled: false, optionId: null }, options: [] });

export function validateCatalog(catalog: unknown): Catalog {
  if (!record(catalog) || catalog.version !== 1 || !nonempty(catalog.policy) || !Array.isArray(catalog.options)) throw new Error('Routing catalog requires version=1, policy and options[]');
  const ids = new Set();
  for (const option of catalog.options as unknown[]) {
    if (!record(option) || !nonempty(option.id) || !/^[a-z][a-z0-9-]*$/.test(option.id) || ids.has(option.id)) throw new Error('Invalid or duplicate routing option id');
    // The id collides with the Jev decline sentinel — letting a seat take it
    // would hard-error every route-decide on this pool, so it is refused at
    // the same shape gate as any other invalid id.
    if (option.id === ROUTE_DECLINE_CANDIDATE) throw new Error(`Routing option id "${ROUTE_DECLINE_CANDIDATE}" is reserved for the Jev decline sentinel`);
    ids.add(option.id);
    if (!families.includes(option.provider as string) && !(option.provider === '' && option.enabled !== true)) throw new Error(`Routing option ${option.id}: provider must be one of ${families.join(', ')}`);
    if (!Array.isArray(option.roles) || !option.roles.length || option.roles.some(role => !roles.includes(role))) throw new Error(`Routing option ${option.id}: invalid roles`);
    if (typeof option.enabled !== 'boolean' || !statuses.includes(option.availability as string)) throw new Error(`Routing option ${option.id}: explicit enabled and availability required`);
    if (typeof option.model !== 'string' || (option.enabled && !option.model) || unsafeModelPattern.test(option.model)) throw new Error(`Routing option ${option.id}: invalid model`);
    if (option.provider === 'devin' && option.enabled && !swe2ModelPattern.test(option.model)) throw new Error(`Routing option ${option.id}: devin options require a swe-2 model`);
    for (const key of ['thinkingOptionId', 'modeId'] as const) {
      if (option[key] != null && (typeof option[key] !== 'string' || !settingIdPattern.test(option[key]))) throw new Error(`Routing option ${option.id}: invalid ${key}`);
    }
    if (option.features != null && !record(option.features)) throw new Error(`Routing option ${option.id}: invalid features`);
    for (const key of ['suitableFor', 'avoidFor'] as const) {
      if (!Array.isArray(option[key]) || option[key].some(value => !nonempty(value))) throw new Error(`Routing option ${option.id}: ${key} must be a string list`);
    }
    if (!nonempty(option.notes)) throw new Error(`Routing option ${option.id}: suitability notes required`);
  }
  if (catalog.quotaFallback != null) {
    // Legacy migration (wave 6): the ordered optionIds list predates the
    // single designated-option contract. A stored list of ≤1 unambiguously
    // maps to optionId (0 → null, 1 → that id); a longer list is an
    // ambiguous choice the Human must make — fail closed, never take-first.
    const fallback = catalog.quotaFallback;
    if (record(fallback) && Object.hasOwn(fallback, 'optionIds')) {
      if (Object.hasOwn(fallback, 'optionId')) throw new Error('quotaFallback carries both optionId and legacy optionIds — remove the legacy key');
      if (!Array.isArray(fallback.optionIds) || fallback.optionIds.some(id => typeof id !== 'string')) {
        throw new Error('quotaFallback optionIds must be a string list');
      }
      if (fallback.optionIds.length > 1) {
        throw new Error(`quotaFallback lists ${fallback.optionIds.length} options — the designated-option model requires exactly one; edit the pool to choose it`);
      }
      catalog.quotaFallback = { enabled: fallback.enabled, optionId: fallback.optionIds[0] ?? null };
    }
    const normalized = catalog.quotaFallback;
    if (!record(normalized) || typeof normalized.enabled !== 'boolean'
        || (normalized.optionId !== null && (typeof normalized.optionId !== 'string' || !ids.has(normalized.optionId)))
        || Object.keys(normalized).some(key => !['enabled', 'optionId'].includes(key))) {
      throw new Error('quotaFallback requires enabled and optionId naming a seat in this pool');
    }
    if (normalized.enabled && normalized.optionId === null) throw new Error('Enabled quotaFallback needs a designated pool option');
  }
  return catalog as unknown as Catalog;
}

export function routingPath(repository: string) {
  if (typeof repository !== 'string' || !isAbsolute(repository) || !lstatSync(repository).isDirectory()) throw new Error('Absolute repository directory required');
  return join(realpathSync(repository), '.paseo-slp', 'slp-routing.json');
}

export const paseoHome = () => process.env.PASEO_HOME || join(homedir(), '.paseo');

// The live user-scope pool the plugin owns (<home>/slp-runtime/state/
// peer-pool.json). Probed advisory-only: absent → null; a file that fails
// JSON/schema validation still reports its sha256 and the parse error so the
// disagreement surfaces as evidence rather than reading as no pool.
export function probeUserPool(home: string): UserPool | null {
  const path = join(home, 'slp-runtime', 'state', 'peer-pool.json');
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as RuntimeError).code === 'ENOENT' || (error as RuntimeError).code === 'ENOTDIR') return null; throw error; }
  if (!stat.isFile()) return null;
  const bytes = readFileSync(path, 'utf8');
  const sha256 = hash(bytes);
  try { return { path, sha256, catalog: validateCatalog(JSON.parse(bytes)) }; }
  catch (error) { return { path, sha256, error: error instanceof Error ? (error as RuntimeError).message : String(error) }; }
}

// Runtime bundle fields compared for drift — the fields a bound seat ships
// to the host (notes, priority, enabled/availability and suitability are
// Lead-facing or eligibility inputs, not the runtime bundle).
const DRIFT_FIELDS = ['provider', 'model', 'thinkingOptionId', 'modeId', 'features'];

// Cross-check a resolved repository catalog against the probed live pool
// (catalog.userPool, attached by readCatalog). The repository catalog still
// wins the binding — drift is reported, never reconciled: the pool file is
// Human-owned. Returns null when there is no live pool to compare.
export function catalogPoolDrift(catalog: Catalog & { sha256: string; userPool?: UserPool | null }): PoolDrift | null {
  const pool = catalog.userPool;
  if (pool == null) return null;
  const base = { userPoolPath: pool.path, catalogSha256: catalog.sha256, userPoolSha256: pool.sha256, identical: catalog.sha256 === pool.sha256 };
  if (pool.error != null) return { ...base, error: pool.error };
  const poolById = new Map(pool.catalog!.options.map(option => [option.id, option]));
  const catalogById = new Map(catalog.options.map(option => [option.id, option]));
  const options: DriftOption[] = [];
  for (const option of catalog.options) {
    const seat = poolById.get(option.id);
    if (!seat) { options.push({ id: option.id, onlyIn: 'catalog' }); continue; }
    const fields = Object.fromEntries(DRIFT_FIELDS
      .filter(key => JSON.stringify(option[key] ?? null) !== JSON.stringify(seat[key] ?? null))
      .map(key => [key, { catalog: option[key] ?? null, pool: seat[key] ?? null }]));
    if (Object.keys(fields).length) options.push({ id: option.id, fields });
  }
  for (const option of pool.catalog!.options) {
    if (!catalogById.has(option.id)) options.push({ id: option.id, onlyIn: 'pool' });
  }
  return { ...base, options };
}

// Advisory drift lines for one chosen option (or the pool file itself when it
// cannot be compared). The repository catalog wins either way — the warnings
// name the disagreement so callers reconcile the two Human-owned sources
// instead of silently binding a seat the runtime pool no longer matches.
export function poolDriftWarnings(drift: PoolDrift | null | undefined, optionId: string | null | undefined) {
  if (drift == null) return [];
  const warnings = [];
  if (drift.error != null) {
    warnings.push(`live user-scope pool ${drift.userPoolPath} could not be compared (${drift.error}) — the repository catalog wins the binding; reconcile the two sources`);
  }
  const entry = optionId == null ? null : drift.options?.find(item => item.id === optionId);
  if (entry?.fields != null) {
    const detail = Object.entries(entry.fields).map(([key, pair]) => `${key} ${JSON.stringify(pair.catalog)} (catalog) vs ${JSON.stringify(pair.pool)} (pool)`).join('; ');
    warnings.push(`routing option ${optionId} differs from the live user-scope pool ${drift.userPoolPath}: ${detail} — the repository catalog wins the binding; reconcile the two sources`);
  } else if (entry?.onlyIn === 'catalog') {
    warnings.push(`routing option ${optionId} has no seat in the live user-scope pool ${drift.userPoolPath} — the repository catalog wins the binding; reconcile the two sources`);
  }
  return warnings;
}

// Resolution is skill-style: the repository catalog wins when present, otherwise
// the plugin-owned user-scope pool <paseoHome>/slp-runtime/state/peer-pool.json
// is the declared fallback. A malformed or structurally invalid repository file
// is an authoring error, not a fallback trigger; never substitute another
// repository's catalog. When the repository catalog wins, the live pool (if
// any) is attached as `userPool` plus its `poolDrift` report — advisory
// evidence of the two sources disagreeing, never a rewrite of either file.
export function readCatalog(repository: string, home = paseoHome()): ResolvedCatalog {
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('Absolute Paseo home required');
  // ENOENT and ENOTDIR both mean "no catalog at this path" — the user-scope
  // path nests two levels (slp-runtime/state), so a regular file squatting on
  // either level surfaces as ENOTDIR; the missing-pool message explains the
  // resolution order better than a bare errno.
  const stat = (path: string) => { try { return lstatSync(path); } catch (error) { if ((error as RuntimeError).code === 'ENOENT' || (error as RuntimeError).code === 'ENOTDIR') return null; throw error; } };
  const repoPath = routingPath(repository);
  const dirStat = stat(join(repoPath, '..'));
  if (dirStat && !dirStat.isDirectory()) throw new Error('Repository .paseo-slp must be a regular directory');
  let path = repoPath, scope = 'repository', fileStat = stat(repoPath);
  if (dirStat == null || fileStat == null) {
    path = join(home, 'slp-runtime', 'state', 'peer-pool.json'); scope = 'user';
    fileStat = stat(path);
    if (fileStat == null) throw new Error(`Missing Peer pool: no repository catalog at ${repoPath} and no user-scope pool at ${path}; author the pool in the SLP Manager surface, or run slp.mjs init <repo> --routing-from <file> --apply for a repository-scoped pool`);
  }
  if (!fileStat.isFile()) throw new Error(`${scope === 'repository' ? 'Repository' : 'User-scope'} Peer pool must be a regular file`);
  const bytes = readFileSync(path, 'utf8');
  const catalog = validateCatalog(JSON.parse(bytes));
  // §7.2 semantic report: an option on a reserved standard-seat id whose
  // tokens diverge from the package set is a Token conflict — reported on
  // every read so the routing/prepare path surfaces it before that seat is
  // used as a standard seat. It is a content error, not a schema rejection:
  // validateCatalog stays shape-only so custom seats keep free strings.
  const tokenConflicts = catalogTokenConflicts(catalog);
  const sha256 = hash(bytes);
  const userPool = scope === 'repository' ? probeUserPool(home) : null;
  const result: ResolvedCatalog = { ...catalog, path, scope, sha256, tokenConflicts };
  if (userPool) Object.assign(result, { userPool, poolDrift: catalogPoolDrift({ ...result, userPool }) });
  return result;
}

// Deterministic eligibility — one predicate, two consumers (view and
// enforcement): catalogBinding refuses on these tokens and jev-routing builds
// its candidate set from the empty-token set. Closed vocabulary, never a
// fused sentence: `disabled`, `availability:<state>`, `role-not-listed`.
export function optionExclusions(option: CatalogOption, role: string) {
  const excluded = [];
  if (!option.enabled) excluded.push('disabled');
  if (option.availability !== 'ready') excluded.push(`availability:${option.availability}`);
  if (!option.roles.includes(role)) excluded.push('role-not-listed');
  return excluded;
}

export const eligibleOptions = (catalog: Catalog, role: string) => catalog.options.filter(option => optionExclusions(option, role).length === 0);

// The routing-decision contract shared with jev-routing.ts: exactly one
// choice question; its answer is an eligible option id or the decline
// sentinel — an explicit "no suitable option" outcome recorded on the receipt.
export const ROUTE_DECISION_QUESTION = 'route_option';
export const ROUTE_DECLINE_CANDIDATE = 'no-suitable-option';

// Lead chooses the option, not an enum/disposition-to-profile mapping.
// Jev routing has two live modes (per-daemon jev.enabled + capabilities.routing):
//   - ARMED (capabilities.routing===true): a route.decision receipt is
//     REQUIRED and binding — route.optionId must equal the receipt choice; a
//     decline receipt fails closed (escalate, do not retry).
//   - SHADOW (enabled but capability not armed): a supplied receipt is still
//     verified for consistency — hash, capability, catalog hash, the exact
//     route_option question set, context.role, candidate membership — but the
//     Lead's route.optionId decides; the plan records BOTH picks (jevChoice,
//     declined) so agreement rate and asymmetric error classes can be measured
//     before the Human arms the capability.
// Verification is offline consistency (internal hash, catalog hash, candidate
// membership) — consistency, not cryptographic authenticity.
export function catalogBinding(repository: string, role: string, providers: Provider[] | undefined, route: Route, home?: string) {
  if (Object.hasOwn(route, 'catalogFile')) throw new Error('Routing is repository-scoped; use repository/.paseo-slp/slp-routing.json, not route.catalogFile');
  const catalog = readCatalog(repository, home);
  if (route.catalogSha256 !== catalog.sha256) throw new Error('Routing catalog changed or hash missing; read routes again before selecting');
  const decision = route.decision as import('./jev.ts').VerifiedJevReceipt | null | undefined;
  const jevConfig = readJevConfig(home ?? paseoHome());
  const jevMode = jevConfig !== null && jevConfig.enabled === true && jevConfig.capabilities.routing === true;
  let jevChoice;
  let jevDeclined = false;
  if (decision != null) {
    verifyReceipt(decision);
    if (decision.context?.capability !== 'routing') throw new Error('Jev decision receipt is not a routing decision');
    if (decision.context.catalogSha256 !== catalog.sha256) throw new Error('Jev decision receipt was issued against a different catalog — run route-decide again');
    // The receipt is bound to the vocabulary version it was issued under —
    // a semantic change to the token set ships as a new version, and a stale
    // receipt must not route under a different meaning (§7.2, §9).
    if (decision.context.vocabularyVersion !== ROUTING_VOCABULARY_VERSION) {
      throw new Error(`Jev decision receipt was issued under vocabulary ${decision.context.vocabularyVersion ?? 'none'} — the package now speaks ${ROUTING_VOCABULARY_VERSION}; run route-decide again`);
    }
    const questionNames = Object.keys(decision.questions);
    if (questionNames.length !== 1 || questionNames[0] !== ROUTE_DECISION_QUESTION) {
      throw new Error(`Jev routing decision receipt must carry exactly the ${ROUTE_DECISION_QUESTION} question`);
    }
    if (decision.context.role !== role) throw new Error(`Jev decision receipt was issued for a different role — run route-decide for ${role}`);
    // A disabled config carries no provider — there is no configured model to
    // compare the receipt against, so that check applies only while Jev is on.
    if (jevConfig?.provider != null && decision.model !== jevConfig.provider.model) {
      throw new Error('Jev decision receipt was issued by a different model than the configured provider — run route-decide again');
    }
    jevChoice = (decision.answers[ROUTE_DECISION_QUESTION] as { choice?: unknown } | null)?.choice;
    if (typeof jevChoice !== 'string') throw new Error(`Jev decision receipt lacks a ${ROUTE_DECISION_QUESTION} choice answer`);
    jevDeclined = jevChoice === ROUTE_DECLINE_CANDIDATE;
    if (jevDeclined && jevMode) throw new Error('Jev declined to route: the receipt records "no suitable option" — the pool is Human-owned, escalate rather than retry');
  } else if (jevMode) {
    throw new Error('Jev routing mode is on for this daemon: prepare requires a route.decision receipt — run slp route-decide to obtain one (the Human can disable Jev routing to restore Lead judgment)');
  }
  const option = catalog.options.find(item => item.id === route.optionId);
  if (!option) throw new Error(`Unknown routing option ${route.optionId}`);
  // A conflicted seat is neither a valid standard seat nor a valid custom one
  // (the reserved-name registry refuses custom ids on it) — refuse it here
  // rather than routing on divergent tokens while the reader believes it is
  // the standard set (§7.2).
  if (seatTokenConflict(option)) {
    throw new Error(`Routing option ${option.id} is a Token conflict — it carries the reserved standard-seat id but its suitability tokens differ from the package set. Resolve it in the SLP Manager surface (use the standard set or convert the seat to a custom id) before routing.`);
  }
  const excluded = optionExclusions(option, role);
  if (excluded.length) throw new Error(`Routing option ${option.id} excluded for ${role}: ${excluded.join(', ')}`);
  if (decision != null) {
    if (!Array.isArray(decision.context.candidates) || !decision.context.candidates.includes(option.id)) {
      throw new Error(`Routing option ${option.id} was not a Jev candidate in the receipt — run route-decide again`);
    }
    if (jevMode && jevChoice !== option.id) throw new Error(`route.optionId ${route.optionId} does not match the Jev receipt choice ${jevChoice}`);
  }
  rejectRouteKeys(route, [...profileRouteKeys, ...runtimeSettingKeys],
    key => `Routing option settings are complete; conflicting route.${key}`);
  if (Object.hasOwn(route, 'quotaFallbackFrom')) {
    const from = catalog.options.find(item => item.id === route.quotaFallbackFrom);
    if (!from || from.id === option.id || !from.roles.includes(role)) throw new Error('Quota fallback requires a different source option for this role');
    if (catalog.quotaFallback?.enabled !== true || catalog.quotaFallback.optionId !== option.id) {
      throw new Error('Quota fallback is disabled or target option is not the designated option');
    }
  }
  const provider = providerId(role, option.provider);
  verifyProvider(providers, provider, () => option.provider, provider);
  const jev: { required: boolean; decision: string; jevChoice?: string; declined?: boolean } = { required: jevMode, decision: decision != null ? 'verified' : 'none' };
  if (decision != null) Object.assign(jev, { jevChoice, declined: jevDeclined });
  // The repository catalog already won this binding — drift with the live
  // user-scope pool is reported so the two Human-owned sources get
  // reconciled instead of silently diverging.
  const warnings = poolDriftWarnings(catalog.poolDrift, option.id);
  return {
    binding: { provider, model: option.model, modeId: option.modeId, thinkingOptionId: option.thinkingOptionId, features: structuredClone(option.features ?? {}) },
    routing: { catalogFile: catalog.path, catalogScope: catalog.scope, catalogSha256: catalog.sha256, optionId: option.id, jev, ...(route.quotaFallbackFrom ? { quotaFallbackFrom: route.quotaFallbackFrom } : {}), ...(catalog.poolDrift ? { poolDrift: catalog.poolDrift } : {}) },
    warnings,
  };
}
