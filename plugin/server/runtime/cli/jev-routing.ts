import type { CatalogOption } from './routing.ts';
import type { JevQuestion, JevOptions } from './jev.ts';
// plugin/server/runtime/cli/jev-routing.ts — first Jev consumer: seat-selection routing decisions.
//
// Jev runs ONLY through the explicit `route-decide` helper command — never in
// a background loop, a schedule, or inside prepare (prepare stays offline and
// merely verifies the receipt this module's output carries).
//
// Deterministic eligibility (optionExclusions, shared with catalogBinding)
// runs BEFORE any model call: Jev may only pick inside the eligible candidate
// set plus the explicit no-suitable-option sentinel. The state sent to Jev is
// the Lead-authored routing brief plus a bounded option surface — never raw
// assignmentFile bytes (the package passes assignments by pointer; shipping
// their bytes to a SaaS self-contradicts), and never catalog `notes` (they
// are Vietnamese; Jev is English-primary). The brief is the entire evidence
// surface — starve it and answers drift toward chance.
//
// Brief contract (hard, validated): `brief` is a nonempty string of raw
// task/assignment text. Structured forms were removed — a `signals` field let
// the caller pre-classify the task with Jev's own decision vocabulary,
// turning the seat choice into a rubber stamp. Standard tokens quoted
// verbatim inside the text are unverified mentions: the instructions tell
// Jev to read them as prose and the caller sees them flagged in `warnings`.
// Brief guidance stays procedural: carry the task description, risk/effort
// signals, constraints and dependencies — the same evidence a Lead would
// weigh. `brief: "x"` validates but starves the model, which is exactly the
// failure mode shadow evaluation exists to measure before the capability may
// be armed.

import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { readCatalog, optionExclusions, eligibleOptions, paseoHome, poolDriftWarnings,
  ROUTE_DECISION_QUESTION, ROUTE_DECLINE_CANDIDATE } from './routing.ts';
import { resolveJev, askJev, JevError } from './jev.ts';
import { roles } from './profiles.ts';
import { JEV_SUITABILITY_GUIDANCE, JEV_TOKEN_DEFINITIONS, ROUTING_VOCABULARY_VERSION,
  isStandardToken, seatTokenConflict } from "../../../shared/runtime/routing-vocabulary.ts";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const jevError = (code: string, message: string, details?: JevError['details']) => new JevError(code, message, details);

const describeOption = (option: CatalogOption) =>
  `${option.provider} ${option.model}; thinking: ${option.thinkingOptionId ?? 'provider default'}; suitable for: ${option.suitableFor.join(', ') || 'unspecified'}; avoid for: ${option.avoidFor.join(', ') || 'none'}`;

// route-decide <request.json>: { repository, role? (default peer), brief,
// paseoHome? }. `brief` is the Lead-authored routing brief — a nonempty string
// of raw task/assignment text; it is the only task context Jev sees (carry
// task description, risk/effort signals, constraints, dependencies — see
// module header). Returns { schemaVersion, optionId, catalogSha256, declined,
// role, tokenConflicts, warnings, decision } where `decision` is the Jev
// receipt prepare later verifies offline.
//
// Mode: resolveJev gates on `enabled` alone with allowShadow — an enabled
// daemon whose routing capability is not yet armed runs shadow evaluation
// (receipt emitted, context.armed=false, Lead still chooses; prepare records
// both picks). Armed requires capabilities.routing=true and makes the receipt
// binding at plan time.
export async function routeDecide(request: { repository: string; role?: string; brief: unknown; paseoHome?: string }, { home, fetchImpl, now }: JevOptions & { home?: string } = {}) {
  if (!record(request)) throw jevError('jev-request-invalid', 'route-decide request must be a JSON object');
  const repository = request.repository;
  let repoStat;
  try {
    repoStat = typeof repository === 'string' && isAbsolute(repository) ? lstatSync(repository) : null;
  } catch {
    repoStat = null;
  }
  if (!repoStat?.isDirectory()) {
    throw jevError('jev-request-invalid', 'route-decide requires an absolute repository directory');
  }
  const role = request.role ?? 'peer';
  if (!roles.includes(role)) throw jevError('jev-request-invalid', `route-decide role must be one of ${roles.join(', ')}`);
  const brief = request.brief;
  if (typeof brief !== 'string' || brief.trim().length === 0) {
    throw jevError('jev-request-invalid', 'route-decide requires brief — a nonempty string of raw task/assignment text (never assignmentFile bytes); structured forms (object/array, e.g. a signals field) are not accepted: inline the relevant facts as prose so suitability classification stays Jev’s, not the caller’s');
  }
  // Standard tokens quoted verbatim inside the brief text stay unverified
  // prose mentions — the instructions below tell Jev to read them that way
  // and the caller sees every hit flagged in `warnings`.
  const briefTokens = [...new Set((brief.match(/\b[a-z]+:[a-z]+\b/g) ?? []).filter(isStandardToken))];
  const warnings = briefTokens.length > 0
    ? [`brief quotes ${briefTokens.length} verbatim suitability token(s) (${briefTokens.join(', ')}) — unverified mentions, not classification; suitability is Jev's call, never the caller's`]
    : [];

  const daemonHome = home ?? request.paseoHome ?? paseoHome();
  const { provider, key, armed } = resolveJev(daemonHome, 'routing', { allowShadow: true });
  const catalog = readCatalog(repository, daemonHome);

  const eligible = eligibleOptions(catalog, role);
  if (eligible.length === 0) {
    const reasons = catalog.options
      .map(option => `${option.id}: ${optionExclusions(option, role).join(', ') || 'eligible'}`)
      .join('; ');
    throw jevError('jev-no-candidates', `No eligible routing options for ${role} — every catalog option is excluded (${reasons})`);
  }
  if (eligible.some(option => option.id === ROUTE_DECLINE_CANDIDATE)) {
    throw jevError('jev-request-invalid', `Catalog option id "${ROUTE_DECLINE_CANDIDATE}" collides with the Jev decline sentinel`);
  }
  // A seat under a reserved standard id whose tokens diverge from the package
  // set is in Token conflict — it is neither a valid standard seat nor a
  // valid custom one, so it cannot be a candidate; it is reported here and
  // refused again at prepare (catalogBinding) if picked anyway.
  const conflicted = eligible.filter(option => seatTokenConflict(option));
  const usable = eligible.filter(option => !seatTokenConflict(option));
  if (usable.length === 0) {
    throw jevError('jev-no-candidates', `No eligible routing options for ${role} — every eligible option is in Token conflict (${conflicted.map(option => option.id).join(', ')}); resolve the conflicts in the SLP Manager surface`);
  }
  const candidates = usable.map(option => option.id);
  const state = {
    task: brief,
    role,
    // §1/§9 — bare tokens carry no meaning to a reader who never saw the
    // table: the state ships each standard token's packaged sign/boundary
    // under the vocabulary version the receipt binds.
    vocabulary: { version: ROUTING_VOCABULARY_VERSION, tokens: JEV_TOKEN_DEFINITIONS },
    // The option surface is fixed-shape — thinkingOptionId ships as explicit
    // null when absent so Jev never guesses whether the key was dropped; null
    // means provider default — the provider's own default level, or a model
    // with no separate thinking knob (baked into the model).
    options: usable.map(option => ({
      id: option.id, provider: option.provider, model: option.model,
      thinkingOptionId: option.thinkingOptionId ?? null,
      suitableFor: option.suitableFor, avoidFor: option.avoidFor,
    })),
  };
  const questions: Record<string, JevQuestion> = {
    [ROUTE_DECISION_QUESTION]: {
      type: 'choice',
      instructions: `Choose exactly one criteria key as the seat for this task. Judge the task brief against each option's provider, model, thinking option and suitability fields. ${JEV_SUITABILITY_GUIDANCE} Standard tokens quoted inside the brief text are unverified mentions, not the caller's classification — derive suitability only from the obligations the text describes. Answer no-suitable-option when none of the listed options fits.`,
      criteria: {
        ...Object.fromEntries(usable.map(option => [option.id, describeOption(option)])),
        [ROUTE_DECLINE_CANDIDATE]: 'None of the listed options is a suitable seat for this task — decline rather than guess',
      },
    },
  };
  const context = {
    capability: 'routing', role, armed,
    catalogSha256: catalog.sha256,
    candidates,
    declineCandidate: ROUTE_DECLINE_CANDIDATE,
    vocabularyVersion: ROUTING_VOCABULARY_VERSION,
    // §7.2 — the read path reports every Token conflict in the catalog, not
    // just the ones that survived eligibility: a disabled-but-conflicted
    // seat still misleads anyone reading the pool as a standard seat.
    tokenConflicts: (catalog.tokenConflicts ?? []).map(conflict => conflict.id),
  };
  const { answers, receipt } = await askJev({ provider, key, state, questions, context }, { fetchImpl, now });
  const choice = (answers[ROUTE_DECISION_QUESTION] as { choice: string }).choice;
  const declined = choice === ROUTE_DECLINE_CANDIDATE;
  // Repository catalog vs the live user-scope pool — the catalog already won
  // this decision; drift is surfaced so the two Human-owned sources get
  // reconciled rather than silently diverging.
  warnings.push(...poolDriftWarnings(catalog.poolDrift, declined ? null : choice));
  return {
    schemaVersion: 1,
    optionId: declined ? null : choice,
    catalogSha256: catalog.sha256,
    declined,
    role,
    tokenConflicts: (catalog.tokenConflicts ?? []).map(conflict => conflict.id),
    warnings,
    poolDrift: catalog.poolDrift ?? null,
    decision: receipt,
  };
}

// route-decide --schema: the request contract routeDecide() consumes,
// descriptive only — emitted so callers author request files without guessing.
export function routeDecideSchema() {
  return {
    description: 'Request contract for slp.mjs route-decide — the explicit Jev network call (the only path that calls Jev; never inside prepare)',
    request: {
      repository: 'required — absolute path to the work repository; its .paseo-slp/slp-routing.json (or the user-scope pool) supplies the candidate set',
      brief: 'required — a nonempty STRING of raw task/assignment text: task description, risk/effort signals, constraints, dependencies. Structured forms (object/array, e.g. a signals field) are refused — inline the facts as prose so suitability classification stays Jev’s, not the caller’s. Verbatim axis:value tokens inside the text ship as unverified mentions and are flagged in warnings.',
      role: 'optional — supervisor | lead | peer; default peer',
      paseoHome: 'optional — absolute daemon home for the user-scope pool and jev.json (the --paseo-home flag or PASEO_HOME also resolves it)',
    },
    output: '{ schemaVersion, optionId, catalogSha256, declined, role, tokenConflicts, warnings, poolDrift, decision } — decision is the consistency receipt (an offline-verifiable artifact, not a cryptographic signature); feed optionId/catalogSha256/decision into route.* of a prepare request. declined=true is a successful run whose answer is "no suitable option" (exit 1).',
    notes: [
      'Never assignmentFile bytes — pass a Lead-authored task text; eligibility is computed deterministically and Jev only sees {task, role, vocabulary, options}.',
      'Requires the daemon’s jev.json to be enabled; capabilities.routing=true arms the receipt as binding, otherwise it is a shadow receipt (the Lead’s choice still binds).',
      'Fails closed on missing config/key, outage, timeout, empty eligible set, out-of-set choice or stale catalog.',
      'Use --out <path> to persist this response — it writes the result bytes (receipt-bearing output), never the request file.',
    ],
    example: {
      repository: '<absolute path to the repository>',
      brief: '<raw task/assignment text — obligations, constraints, dependencies; no structured signals>',
      role: 'peer',
    },
  };
}
