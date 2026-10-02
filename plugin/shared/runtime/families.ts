// plugin/shared/runtime/families.ts — the provider-family registry: the single source
// of truth for the slp-<family>-<role> owned id space and the role axis it
// pairs with (settings-driven-providers.md §5–§6). Shared so server AND client
// modules import the same derivation — pure data plus derived constants, no
// imports at all (same host-compiler boundary as contracts.ts: no node
// builtins, nothing the plugin checkout cannot resolve).
//
// Family lists, regexes, labels and env/extends maps in plugin/ and src/ derive from
// this table — there is no second literal list. Adding a family is one entry
// here plus executable detection and a payload regen; the remaining steps are
// documented in docs/spec/settings-driven-providers.md ("Adding a family").
// This source ships in the install unit. The bootstrap shim alone keeps its
// recorded family/role sets: it must validate argv and report unsupported Node
// before any TypeScript import, and reject incomplete launch manifests.

export interface FamilySpec {
  /** The `<family>` segment of every owned `slp-<family>-<role>` provider id —
   *  also the PATH-probe binary name and the catalog provider query. */
  id: string;
  /** Human display name: status chips, pickers, generated provider labels. */
  label: string;
  /** How role bytes reach the seat (settings-driven-providers.md §6):
   *  "hook"    — thin alias + sentinel-gate launcher; `agent.create` injects
   *              roleBundle() via config.systemPrompt and `agent.session_open`
   *              overlays the grant (codex/pi/claude).
   *  "wrapper" — shim + role wrapper; the ACP adapter drops systemPrompt, so
   *              the role bytes travel through the shim's session/new rewrite
   *              (devin). */
  transport: "hook" | "wrapper";
  /** Provider-env variable that carries the frozen binary resolution —
   *  `SLP_<ID>_BIN`; the shim's per-family source and the provider env block. */
  binEnv: string;
  /** Base provider a generated `slp-*` entry extends. */
  extends: string;
  /** Position in pickers that offer a family choice — lower sorts first.
   *  Canonical order (FAMILY_IDS) stays the declaration order; the UI's
   *  PROFILE_FAMILY_ORDER derives from this rank. */
  pickerRank: number;
}

export const FAMILIES = [
  { id: "codex", label: "Codex", transport: "hook", binEnv: "SLP_CODEX_BIN", extends: "codex", pickerRank: 1 },
  { id: "pi", label: "Pi", transport: "hook", binEnv: "SLP_PI_BIN", extends: "pi", pickerRank: 2 },
  { id: "devin", label: "Devin", transport: "wrapper", binEnv: "SLP_DEVIN_BIN", extends: "acp", pickerRank: 3 },
  { id: "claude", label: "Claude Code", transport: "hook", binEnv: "SLP_CLAUDE_BIN", extends: "claude", pickerRank: 0 },
] as const satisfies readonly FamilySpec[];

export type FamilyId = (typeof FAMILIES)[number]["id"];
export type FamilyTransport = (typeof FAMILIES)[number]["transport"];
export type ProviderExtends = (typeof FAMILIES)[number]["extends"];

/** The role axis of the owned id space — saved profiles exist only for
 *  supervisor/lead; peers stay pool-driven. Registry-adjacent rather than a
 *  family property, kept here so every `slp-<family>-<role>` regex and id
 *  derives both axes from one module (this also retires the ROLES literals
 *  launchers.ts and config-view.ts each carried). */
export const ROLES = ["supervisor", "lead", "peer"] as const;
export type RoleName = (typeof ROLES)[number];

// ---------------------------------------------------------------------------
// Derived lists — never write a family literal list downstream
// ---------------------------------------------------------------------------

export const FAMILY_IDS: readonly FamilyId[] = FAMILIES.map(f => f.id);
/** `transport === "hook"` — gate launcher + agent.create injection. */
export const HOOK_FAMILY_IDS: readonly FamilyId[] =
  FAMILIES.filter(f => f.transport === "hook").map(f => f.id);
/** `transport === "wrapper"` — shim + role wrapper. */
export const WRAPPER_FAMILY_IDS: readonly FamilyId[] =
  FAMILIES.filter(f => f.transport === "wrapper").map(f => f.id);

const perFamily = <V>(pick: (f: (typeof FAMILIES)[number]) => V): Record<FamilyId, V> =>
  Object.fromEntries(FAMILIES.map(f => [f.id, pick(f)])) as Record<FamilyId, V>;

export const FAMILY_LABEL: Readonly<Record<FamilyId, string>> = perFamily(f => f.label);
export const PROVIDER_EXTENDS: Readonly<Record<FamilyId, ProviderExtends>> = perFamily(f => f.extends);
export const FAMILY_BIN_ENV: Readonly<Record<FamilyId, string>> = perFamily(f => f.binEnv);
/** Deduped `extends` values, registry order — the OwnedProvider.extends enum
 *  domain (devin contributes "acp", the rest extend their own id). */
export const PROVIDER_EXTENDS_IDS: readonly ProviderExtends[] = [
  ...new Set(FAMILIES.map(f => f.extends)),
];
/** Picker order (the UI's PROFILE_FAMILY_ORDER) — registry `pickerRank`. */
export const FAMILY_PICKER_ORDER: readonly FamilyId[] =
  [...FAMILIES].sort((a, b) => a.pickerRank - b.pickerRank).map(f => f.id);

// ---------------------------------------------------------------------------
// The slp-<family>-<role> id space — ids, sets and regexes
// ---------------------------------------------------------------------------

export const ownedProviderId = (family: FamilyId, role: RoleName): string =>
  `slp-${family}-${role}`;

/** Every owned provider id — family × role, sorted (receipt/projection key
 *  order). Exactly FAMILY_IDS.length × ROLES.length entries. */
export const OWNED_PROVIDER_IDS: string[] = FAMILY_IDS.flatMap(family =>
  ROLES.map(role => ownedProviderId(family, role)),
).sort();

const familyPattern = (ids: readonly FamilyId[]): string => ids.join("|");
const ROLE_PATTERN = ROLES.join("|");

/** `slp-<family>-<role>` over the full owned id space — group 1 family,
 *  group 2 role. */
export const OWNED_PROVIDER_ID_RE = new RegExp(
  `^slp-(${familyPattern(FAMILY_IDS)})-(${ROLE_PATTERN})$`,
);
/** Owned ids on the hook transport (thin alias + gate launcher). */
export const HOOK_PROVIDER_ID_RE = new RegExp(
  `^slp-(${familyPattern(HOOK_FAMILY_IDS)})-(${ROLE_PATTERN})$`,
);
/** Owned ids on the wrapper transport (shim). */
export const WRAPPER_PROVIDER_ID_RE = new RegExp(
  `^slp-(${familyPattern(WRAPPER_FAMILY_IDS)})-(${ROLE_PATTERN})$`,
);
/** Family-prefix match with no role anchor — group 1 is the family. */
export const MANAGED_FAMILY_PREFIX_RE = new RegExp(`^slp-(${familyPattern(FAMILY_IDS)})-`);

/** Family of a managed `slp-<family>-<role>` provider id, or null. */
export function familyFromProviderId(provider: string): FamilyId | null {
  return (OWNED_PROVIDER_ID_RE.exec(provider)?.[1] ?? null) as FamilyId | null;
}
