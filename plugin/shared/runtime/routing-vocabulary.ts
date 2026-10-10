// Canonical routing-criteria vocabulary for the CLI, plugin server and Manager.
// Definitions, reserved seat token sets and reading rules are versioned together
// under ROUTING_VOCABULARY_VERSION (docs/spec/routing-criteria.md §2–§4, §6).

export const ROUTING_VOCABULARY_VERSION = "routing-criteria-v1";

// ---------------------------------------------------------------------------
// §2 — the four axes shared by suitableFor and avoidFor
// ---------------------------------------------------------------------------

export interface SuitabilityAxis {
  id: string;
  question: string;
  values: string[];
  why: string;
}

export const SUITABILITY_AXES: readonly SuitabilityAxis[] = [
  {
    id: "work",
    question: "Which primary output makes the current assignment complete?",
    values: ["enumerate", "investigate", "design", "change", "verify"],
    why: "Distinguishes collecting, understanding, deciding, producing a change and verifying, even when they use the same tools.",
  },
  {
    id: "depth",
    question: "Before starting, which kinds of indeterminacy remain that must be resolved?",
    values: ["mechanical", "bounded", "open"],
    why: "Distinguishes an already-determined rule from a local decision and a still-open question; difficulty is not inferred from size.",
  },
  {
    id: "domain",
    question: "Which domain does the primary expertise obligation belong to?",
    values: ["software", "tests", "prose", "data", "security", "evidence"],
    why: "Covers the specializations already present in the archetypes and Proof Auditor without turning a worker's name into a token.",
  },
  {
    id: "flow",
    question: "Is there a mandatory intermediate checkpoint that decides the next step?",
    values: ["direct", "staged"],
    why: "Recognizes the need for coordination across phases with a signal readable before the run.",
  },
];

// ---------------------------------------------------------------------------
// §3 — the 16 standard tokens: `axis:value`, lowercase, exact-match. No
// synonyms, wildcards, self-made tokens or implicit inclusion relations
// (depth:bounded does not include depth:mechanical).
// ---------------------------------------------------------------------------

export interface SuitabilityToken {
  id: string;
  axis: string;
  sign: string;
  example: string;
  counterExample: string;
  boundary: string;
}

export const SUITABILITY_TOKENS: readonly SuitabilityToken[] = [
  {
    id: "work:enumerate",
    axis: "work",
    sign: "The output is an inventory, extraction or summary of a designated source; not a conclusion about cause, a design choice or an independent verdict.",
    example: "List the places that read avoidFor and record the paths.",
    counterExample: "\"List the usage sites then determine why routing is wrong\" requires a causal conclusion — that is investigate.",
    boundary: "Triage by an existing state or rubric is enumerate; finding a cause or basis not yet known is investigate, because \"triage\" itself does not say what the output must be.",
  },
  {
    id: "work:investigate",
    axis: "work",
    sign: "There is a question with no known answer about cause, feasibility or technology choice; the primary output is an evidence-backed conclusion, possibly needing a throwaway prototype.",
    example: "Find the cause of a flaky test, returning the mechanism and reproduction evidence.",
    counterExample: "Fixing a flaky test once the cause and fix direction are settled is change.",
    boundary: "An investigation phase ends when the conclusion suffices to determine the next step with supporting evidence; the fix is a change phase, because finding the answer must be separated from applying it.",
  },
  {
    id: "work:design",
    axis: "work",
    sign: "The output must propose or settle behavior, a contract, ownership or a structure not yet decided.",
    example: "Propose ownership and lifecycle for a new routing module.",
    counterExample: "Writing test cases from settled requirements is not by itself design; it is change or verify depending on the primary output.",
    boundary: "Choosing how to organize functions under a settled contract is still change; use design only when the contract/behavior decision itself is the deliverable.",
  },
  {
    id: "work:change",
    axis: "work",
    sign: "Success requires handing over an altered artifact or state to be kept: code, tests, documentation or data; self-verification is part of proving the change.",
    example: "Apply an approved codemod then hand over the diff and test results.",
    counterExample: "A prototype whose only purpose is answering \"does the API meet the requirement?\" is investigate; the code is not a deliverable to keep.",
    boundary: "If a task has both research and a lasting deliverable, classify by the current phase; do not use the existence of a new file to decide work.",
  },
  {
    id: "work:verify",
    axis: "work",
    sign: "There is a designated candidate, proposal, claim or evidence chain; the primary output is an independent verdict/findings against criteria.",
    example: "QC: design and run test cases on a frozen candidate.",
    counterExample: "An engineer running unit tests for the patch they are writing is still change; self-proof is not independent verification.",
    boundary: "A second opinion on an existing proposal is verify even before code exists; building a still-incomplete proposal yourself is design, because the object to be verified must exist.",
  },
  {
    id: "depth:mechanical",
    axis: "depth",
    sign: "The brief has a transformation rule/checklist plus exception handling known well enough to decide the cases in scope; no new logic, cause explanation or exception design is needed.",
    example: "Rename symbols by a defined mapping within an approved scope.",
    counterExample: "Also a rename, but requiring decisions on API compatibility and alias behavior: the mapping does not yet determine the answer, so it is no longer mechanical.",
    boundary: "Only count a rule as sufficient when the exceptions seen also have determined handling, because \"most files are alike\" does not guarantee the rest needs no judgment.",
  },
  {
    id: "depth:bounded",
    axis: "depth",
    sign: "The goal, acceptance and related contracts are stable; implementation choices or ways of checking remain within those boundaries, with no major unknown handed over to be resolved.",
    example: "Add validation per a settled spec and error format, choosing the function organization and tests yourself.",
    counterExample: "\"Only fix one file\" but the cause of the race condition is unknown: small size does not make a problem bounded.",
    boundary: "A choice that only varies how an existing contract is implemented is bounded if not already mechanical, because no file-count or line-count threshold is needed.",
  },
  {
    id: "depth:open",
    axis: "depth",
    sign: "The task must resolve unknowns that can change acceptance, correct behavior, the causal mechanism, feasibility, compatibility or ownership; it needs hypotheses built/refuted or options weighed.",
    example: "Find the mechanism behind lost updates when multiple writers run concurrently, and distinguish the hypotheses.",
    counterExample: "A codemod over thousands of files under a complete rule is still mechanical; large volume does not by itself create openness.",
    boundary: "One of those unknowns suffices to assign open when it is a question the task must answer; reading documentation to find an existing function name is not by itself open, because looking up a fact differs from resolving an unknown in the problem.",
  },
  {
    id: "domain:software",
    axis: "domain",
    sign: "Acceptance requires judging or changing software behavior, an API, a module, a lifecycle or a runtime error.",
    example: "Investigate a binding-resolution failure or implement an API per spec.",
    counterExample: "Fixing a typo in a README produces prose; it does not by itself need software.",
    boundary: "Documentation only adds software when it must establish/verify technical behavior, because naming an API does not create an independent technical obligation.",
  },
  {
    id: "domain:tests",
    axis: "domain",
    sign: "A test-case set, test harness, requirement coverage or a test campaign is the primary obligation handed over.",
    example: "Generate a test set from a spec then check a candidate with those cases.",
    counterExample: "An engineer adding unit tests to prove a feature is still primarily software; not automatically an independent test-authoring task.",
    boundary: "Assign tests when the test set or test results are separately accepted; only add software when there is a separate obligation about implementation or contract beyond the test product, because writing tests in code does not create a second obligation.",
  },
  {
    id: "domain:prose",
    axis: "domain",
    sign: "The quality, meaning or accuracy of documentation/translation is the product or primary object of acceptance.",
    example: "Rewrite an installation guide or translate a document whose content is settled.",
    counterExample: "A report on a regression's cause uses prose but its acceptance lies in the failure mechanism; not by itself prose.",
    boundary: "A spec recording existing decisions is change/prose; a spec that must decide software behavior is design/software, plus prose if the document also has its own acceptance requirements.",
  },
  {
    id: "domain:data",
    axis: "domain",
    sign: "Acceptance checks record invariants, persisted schema, mappings, backfill or the target data format.",
    example: "A backfill with checks on counts, mappings and recoverability.",
    counterExample: "Renaming a type in source without changing persisted schema or data is software.",
    boundary: "A not-yet-run script still belongs to data if the accepted product is a persisted schema/data transformation; whether it has run does not decide the domain.",
  },
  {
    id: "domain:security",
    axis: "domain",
    sign: "The brief requires judgment about a threat model, abuse cases, trust boundaries, auth, secrets or dependency risk from an adversarial viewpoint.",
    example: "Check auth bypass against a threat model.",
    counterExample: "Adding a display field to the response of an authenticated endpoint is not by itself security if it neither changes nor checks a security boundary.",
    boundary: "Always add security when a task changes/checks a trust boundary, access rights or secret handling; merely using an authenticated component is not enough, to avoid turning every feature into a security task.",
  },
  {
    id: "domain:evidence",
    axis: "domain",
    sign: "The primary evaluation target is an evidence chain: did the command run, does the output prove the claim, is the candidate identity correct.",
    example: "Cross-check a test log against the snapshot a report claims to have checked.",
    counterExample: "Reading a log to find an error's cause is still software; the output is not a verdict about the report's trustworthiness.",
    boundary: "Assign evidence when the provenance, identity or probative strength of a claim must be checked; not merely because the task reads logs, since logs are a tool of many kinds of work.",
  },
  {
    id: "flow:direct",
    axis: "flow",
    sign: "The assignment and protocol allow completing the scope then handing back once, with no mandatory intermediate checkpoint conditioning the next phase.",
    example: "Look up inventory then return a report in the session.",
    counterExample: "A migration that must verify a trial batch before running in full is staged even if each batch is very fast.",
    boundary: "Direct can contain many commands or run long; an ordinary check before handback creates no new stage, because the number of operations says nothing about the permission/dependency structure.",
  },
  {
    id: "flow:staged",
    axis: "flow",
    sign: "There are mandatory phases/checkpoints; evidence or decisions there determine whether to continue, change scope, or require wait/resume.",
    example: "A backfill in waves, confirming invariants and recovery conditions before the next wave.",
    counterExample: "A single analysis that takes hours then returns results is not by itself staged; duration does not prove a checkpoint exists.",
    boundary: "Only count a checkpoint that lies inside the assignment/protocol or is an actual condition of the next step; do not add one just to match a seat's name.",
  },
];

const TOKEN_ID_SET = new Set(SUITABILITY_TOKENS.map(token => token.id));
const TOKEN_BY_ID = new Map(SUITABILITY_TOKENS.map(token => [token.id, token]));

/** True for a verbatim standard token string — `axis:value`, exact match. */
export const isStandardToken = (token: string): boolean => TOKEN_ID_SET.has(token);

/** The packaged definition entry for a standard token, or undefined for any
 *  other string — a custom seat's free text never borrows a near-match's
 *  meaning (§7.3, §7.4.F). */
export const tokenDefinition = (token: string): SuitabilityToken | undefined => TOKEN_BY_ID.get(token);

// ---------------------------------------------------------------------------
// §6 — the package-owned token sets of the 12 standard seats. The id set is
// the reserved-name registry (§7.2): an option carrying one of these ids is a
// standard seat and its tokens must equal this set (unordered); every other
// id is a custom seat whose strings are free.
// ---------------------------------------------------------------------------

export interface StandardSeatTokens {
  suitableFor: string[];
  avoidFor: string[];
}

export const STANDARD_SEAT_TOKENS: Record<string, StandardSeatTokens> = {
  "lightweight-recon": {
    suitableFor: ["work:enumerate", "depth:mechanical", "depth:bounded"],
    avoidFor: ["work:change", "work:design", "work:verify", "depth:open"],
  },
  "standard-coding": {
    suitableFor: ["work:change", "depth:mechanical", "depth:bounded", "domain:software", "domain:tests"],
    avoidFor: ["work:design", "depth:open"],
  },
  "deep-reasoning": {
    suitableFor: ["work:investigate", "work:design", "work:verify", "depth:bounded", "depth:open"],
    avoidFor: ["depth:mechanical"],
  },
  "independent-second-opinion": {
    suitableFor: ["work:verify"],
    avoidFor: [],
  },
  "autonomous-long-running": {
    suitableFor: ["flow:staged"],
    avoidFor: ["flow:direct"],
  },
  "test-authoring": {
    suitableFor: ["work:change", "work:verify", "domain:tests"],
    avoidFor: ["work:design", "domain:software"],
  },
  "spec-docs-writing": {
    suitableFor: ["work:change", "domain:prose"],
    avoidFor: ["domain:software"],
  },
  "security-review": {
    suitableFor: ["work:design", "work:verify", "domain:security"],
    avoidFor: ["work:change"],
  },
  "debugging-root-cause": {
    suitableFor: ["work:investigate", "depth:open", "domain:software"],
    avoidFor: ["work:change", "domain:prose"],
  },
  "mechanical-refactor": {
    suitableFor: ["work:change", "depth:mechanical", "domain:software"],
    avoidFor: ["depth:bounded", "depth:open"],
  },
  "research-spike": {
    suitableFor: ["work:investigate", "depth:open", "domain:software"],
    avoidFor: ["work:change"],
  },
  "data-migration": {
    suitableFor: ["work:change", "domain:data", "flow:direct", "flow:staged"],
    avoidFor: [],
  },
};

/** Reserved ids — exact-match only; `security-review-2` and
 *  `my-security-review` are custom names (§7.2). */
export const STANDARD_SEAT_IDS: readonly string[] = Object.keys(STANDARD_SEAT_TOKENS);
export const isStandardSeatId = (id: string): boolean =>
  Object.hasOwn(STANDARD_SEAT_TOKENS, id);

export interface SeatTokenDiff {
  missing: string[];
  extra: string[];
}

export interface SeatTokenConflict {
  id: string;
  suitableFor: SeatTokenDiff;
  avoidFor: SeatTokenDiff;
}

const setDiff = (actual: readonly string[], expected: readonly string[]): SeatTokenDiff => ({
  missing: expected.filter(token => !actual.includes(token)),
  extra: actual.filter(token => !expected.includes(token)),
});

/** Token-conflict check (§7.2): an option on a reserved id whose
 *  suitableFor/avoidFor differ from the package set — compared as unordered
 *  sets. Returns null for custom ids and for in-sync standard seats. */
export function seatTokenConflict(option: {
  id: string;
  suitableFor?: readonly string[];
  avoidFor?: readonly string[];
}): SeatTokenConflict | null {
  const standard = STANDARD_SEAT_TOKENS[option.id];
  if (!standard) return null;
  const suitableFor = setDiff(option.suitableFor ?? [], standard.suitableFor);
  const avoidFor = setDiff(option.avoidFor ?? [], standard.avoidFor);
  if (!suitableFor.missing.length && !suitableFor.extra.length
      && !avoidFor.missing.length && !avoidFor.extra.length) return null;
  return { id: option.id, suitableFor, avoidFor };
}

/** Every token conflict in a catalog — the routing-read/prepare path reports
 *  these before using a seat as a standard seat. */
export const catalogTokenConflicts = (catalog: {
  options?: readonly { id: string; suitableFor?: readonly string[]; avoidFor?: readonly string[] }[];
}): SeatTokenConflict[] =>
  (catalog?.options ?? []).map(seatTokenConflict).filter((c): c is SeatTokenConflict => c !== null);

// ---------------------------------------------------------------------------
// §4 — how the flat token lists read. `task` = { work?, depth?, flow?,
// domains?: string[] } with bare axis values (domains as `software`, not
// `domain:software`).
// ---------------------------------------------------------------------------

const tokensByAxis = (tokens: readonly string[]): Record<string, string[]> => {
  const grouped: Record<string, string[]> = {};
  for (const token of tokens) {
    const def = TOKEN_BY_ID.get(token);
    if (def) (grouped[def.axis] ??= []).push(def.id.slice(def.axis.length + 1));
  }
  return grouped;
};

export interface SuitabilityTask {
  work?: string;
  depth?: string;
  flow?: string;
  domains?: string[];
}

/** OR among the seat's values of one axis, AND across the axes the seat
 *  declares — checked on work/depth/flow (domain coverage is the separate
 *  priority group). A task axis left unclassified creates no contradiction:
 *  missing facts are not infeasibility. Custom (non-standard) strings on a
 *  custom seat never satisfy or violate an axis — they are free text. */
export function suitabilityMatch(suitableFor: readonly string[], task: SuitabilityTask): boolean {
  const declared = tokensByAxis(suitableFor);
  for (const axis of ["work", "depth", "flow"] as const) {
    const required = task?.[axis];
    if (required != null && axis in declared && !declared[axis].includes(required)) return false;
  }
  return true;
}

/** avoidFor is OR over the whole list: any one listed token that intersects
 *  the task's classification warns — including a single shared domain. */
export function avoidWarnings(avoidFor: readonly string[], task: SuitabilityTask): string[] {
  const hits: string[] = [];
  const domains = task?.domains ?? [];
  for (const token of avoidFor) {
    const def = TOKEN_BY_ID.get(token);
    if (!def) continue;
    if (def.axis === "domain"
      ? domains.includes(def.id.slice(7))
      : task?.[def.axis as "work" | "depth" | "flow"] === def.id.slice(def.axis.length + 1)) {
      hits.push(token);
    }
  }
  return hits;
}

/** The §4 step-3 group: 'full' when the seat declares every domain the task
 *  requires, 'fallback' when it declares only part or omits the axis. No
 *  score: two seats fully covering are equal on this criterion regardless of
 *  token count; unrelated extra domains create no advantage. */
export function domainCoverage(suitableFor: readonly string[], domains: readonly string[]): "full" | "fallback" {
  const declared = tokensByAxis(suitableFor).domain ?? [];
  return (domains ?? []).every(domain => declared.includes(domain)) ? "full" : "fallback";
}

// ---------------------------------------------------------------------------
// §7.4.F + §9 — the guidance Jev receives under this vocabulary version.
// ---------------------------------------------------------------------------

export const JEV_SUITABILITY_GUIDANCE = `Suitability vocabulary ${ROUTING_VOCABULARY_VERSION}: suitableFor lists standard axis:value tokens — OR among values of the same axis, AND across the axes the seat declares. An axis a seat does not declare is no assertion on that axis, not proof it fits every value. avoidFor is OR over the whole list and is an advisory warning, not a ban — a warned seat may still be picked when the task's specifics justify it, but say why. When the task needs domains (domain:software/tests/prose/data/security/evidence), a seat declaring every required domain beats one that omits or only partially declares them — full domain coverage is chosen before cost. Among adequate seats in the same group, prefer the lowest expected execution cost from trustworthy metadata; when no reliable price exists, prefer the lighter thinking option when the seats share provider and model and the provider publishes a clear thinking order — an option's thinkingOptionId is that seat's thinking level, null meaning provider default — the provider's own default level, or a model with no separate thinking knob (its catalog publishes no thinking options) — so all-null seats tie on this tier; when the thinking order is unclear or seats still tie, choose the lexicographically smallest option id — never decline because of a tie, and never claim the id tie-break proves the cheapest seat. A seat missing some required domain is a fallback: pick it only when the brief supplies a concrete basis for each missing obligation. Strings that are not standard tokens are unverified free text — read them as hints, never as a standard domain assertion. Missing facts in the brief are not by themselves infeasibility, and an avoid warning or a tie among adequate seats is not a reason to decline — answer no-suitable-option only when no option can actually take the task.`;

// §1/§9 — the compact glossary Jev receives in the decision state, under the
// same vocabulary version: a bare `axis:value` token does not convey its
// meaning to a reader who never saw this table, so each standard token ships
// its packaged sign and boundary (kept short — the full definition with
// examples lives in SUITABILITY_TOKENS for the Manager's lookup).
export const JEV_TOKEN_DEFINITIONS = SUITABILITY_TOKENS.map(({ id, axis, sign, boundary }) => ({ id, axis, sign, boundary }));

/** Short how-to-read text for the Manager's token lookup (§7.4.F) — the same
 *  semantics as the Jev guidance, restated for the pool editor. */
export const HOW_TO_READ: readonly string[] = [
  "suitableFor reads OR among values of the same axis, AND across the axes the seat declares.",
  "avoidFor reads OR over the whole list — a warning to weigh, never a runtime prohibition.",
  "A task needing several domains requires a seat declaring every one of them; full domain coverage is chosen before cost.",
  "An axis the seat does not declare is no assertion on that axis — not a promise it fits every value.",
  "depth describes how determined the problem is — it is not a capability scale or a model ranking.",
  "The standard set is exact-match axis:value — no synonyms or wildcards; any other string on a custom seat is free text the package does not define.",
];
