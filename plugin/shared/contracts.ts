// Shared contracts for the paseo-slp manager plugin (Option A v1).
// Normative sources: docs/spec/paseo-plugin-implementation.md §3 (wire RPCs) and
// §7 (receipt/operation-intent journal schema). The seam interfaces at the
// bottom freeze the §12 module boundaries for the implementation lanes.
//
// Host-compiler boundary: shared/ modules may import only zod, react-family
// specifiers and @getpaseo/plugin SDK specifiers — no node builtins, and no
// type imports the plugin checkout cannot resolve. Keep this file pure.

import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { JEV_TRANSPORTS } from "./runtime/jev-transport.ts";
import { FAMILY_IDS, OWNED_PROVIDER_ID_RE, PROVIDER_EXTENDS_IDS, ROLES, persistedProviderIds, persistedFamilyIds } from "./runtime/families.ts";

/** The serialized-RPC byte contract: every request and response envelope
 *  stays inside this many UTF-8 bytes. Defined once here — producers bound
 *  or shed to it, never restate the literal. */
export const MAX_RPC_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// §3 wire schemas
// ---------------------------------------------------------------------------

export const Sha = z.string().regex(/^[0-9a-f]{64}$/);
export const Time = z.string().datetime({ offset: true });
export const Id = z.string().uuid();
// The family domain derives from the shared registry (families.ts) — adding a
// family is a registry entry, not an edit here. The inferred FamilyName union
// is unchanged (the registry ids are the previous literal enum).
export const Family = z.enum(FAMILY_IDS);
/** One schema keyed per registry family — keeps `binaries` shapes aligned
 *  with the family set; the inferred type stays Record<FamilyName, …>. */
const familyKeyed = <S extends z.ZodType>(schema: S): Record<FamilyName, S> =>
  Object.fromEntries(FAMILY_IDS.map(id => [id, schema])) as Record<FamilyName, S>;
export const isAbsolutePath = (s: string): boolean =>
  !s.includes("\0") && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(s);
export const AbsolutePath = z.string().min(1).max(4096).refine(isAbsolutePath);
export const Target = z.object({
  hostId: z.string().min(1).max(256),
  daemonHome: AbsolutePath,
}).strict();
export const Authority = z.object({
  exclusiveAdministrativeWindow: z.literal(true),
  verifiedHostHomeMapping: z.literal(true),
}).strict();
export const State = z.enum([
  "INACTIVE", "ACTIVATING", "ACTIVE", "DEACTIVATING", "RECOVERY_REQUIRED",
]);
export const OperationKind = z.enum(["activate", "reconcile", "deactivate"]);
export const Phase = z.enum([
  "accepted", "materialized", "prepared", "patch-dispatched", "verified", "terminal",
]);
export const Conflict = z.object({
  code: z.enum([
    "BUSY", "IDEMPOTENCY_CONFLICT", "TARGET_MISMATCH", "HOME_UNVERIFIED",
    "UNSUPPORTED_PLATFORM", "EXECUTABLE_UNAVAILABLE", "MCP_DISABLED",
    "RAW_LIVE_DIVERGENCE", "COLLISION", "OWNERSHIP_DRIFT", "SCHEMA_LOSS",
    "DEPENDENT_REFERENCE", "RUNTIME_INTEGRITY", "RECOVERY_REQUIRED",
    "PATCH_OUTCOME_UNKNOWN", "IO_FAILURE", "INVALID_REQUEST", "NOT_FOUND",
  ]),
  path: z.string().max(4096).nullable(),
  message: z.string().min(1).max(2048),
  expectedSha256: Sha.nullable(),
  actualSha256: Sha.nullable(),
}).strict();
export const OperationView = z.object({
  operationId: Id,
  kind: OperationKind,
  phase: Phase,
  outcome: z.enum(["pending", "succeeded", "no-op", "failed", "recovery-required"]),
  startedAt: Time,
  updatedAt: Time,
  completedAt: Time.nullable(),
}).strict();
export const StartOutput = z.object({
  schemaVersion: z.literal(1),
  accepted: z.boolean(),
  state: State,
  operation: OperationView.nullable(),
  conflicts: z.array(Conflict).max(64),
  pollAfterMs: z.number().int().min(0).max(5000),
}).strict();
const Start = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  operationId: Id,
  authority: Authority,
}).strict();
/** Human-supplied preferences merged into an owned profile. Optional
 *  everywhere — the plugin never invents model, mode, or feature defaults.
 *  On first activation an absent field is simply not written; on an existing
 *  binding `activate` treats the object as an explicit edit — absent fields
 *  preserve the live value, `null` clears it, and `family` repoints the
 *  profile at that family's managed provider for the profile's role. */
export const ProfilePrefs = z.object({
  family: Family.optional(),
  model: z.string().min(1).nullable().optional(),
  modeId: z.string().min(1).nullable().optional(),
  thinkingOptionId: z.string().min(1).nullable().optional(),
  featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();
export const ActivateInput = Start.extend({
  candidateSha256: Sha,
  adoptIdentical: z.boolean().default(false),
  nodePath: AbsolutePath.optional(),
  binaries: z.object(familyKeyed(AbsolutePath.optional())).strict().default({}),
  initialProfileFamily: Family.optional(),
  profiles: z.object({
    supervisor: ProfilePrefs.optional(),
    lead: ProfilePrefs.optional(),
  }).strict().optional(),
}).strict();
export const ReconcileInput = Start.extend({
  action: z.enum(["inspect", "complete", "restore-before"]),
  interruptedOperationId: Id.optional(),
}).strict();
export const DeactivateInput = Start.extend({
  expectedBindingSha256: Sha,
}).strict();
export const StatusInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  operationId: Id.optional(),
}).strict();
export const BindingView = z.object({
  bindingSha256: Sha,
  candidateSha256: Sha,
  payloadSha256: Sha,
  launchSetSha256: Sha,
  runtimePath: AbsolutePath,
  nodePath: AbsolutePath,
  baseline: z.enum(["fresh", "adopted-observed"]),
}).strict();
export const FamilyView = z.object({
  family: Family,
  availability: z.enum(["available", "unavailable", "unresolved"]),
  binaryPath: AbsolutePath.nullable(),
  observedVersion: z.string().nullable(),
}).strict();
/** Live tunable fields of one managed profile, read from daemon config —
 *  lets the surface prefill the bound-state profile editor with the same
 *  values the host's profile editor would show. Empty when no binding. */
export const ManagedProfileView = z.object({
  id: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  featureValues: z.record(z.string(), z.unknown()).nullable(),
}).strict();
export const StatusOutput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  state: State,
  embeddedCandidateSha256: Sha,
  binding: BindingView.nullable(),
  managedProfiles: z.array(ManagedProfileView).max(2),
  families: z.array(FamilyView).length(FAMILY_IDS.length),
  operation: OperationView.nullable(),
  conflicts: z.array(Conflict).max(64),
  verifiedAt: Time.nullable(),
  retainedRuntimeCount: z.number().int().nonnegative(),
  /** Communication language injected into managed sessions — the content of
   *  slp-runtime/state/communication-language, or null when unset (seats then
   *  keep their model default; nothing is injected). */
  communicationLanguage: z.string().nullable(),
  liveAcceptance: z.literal("not-established-by-this-rpc"),
}).strict();
/** Plugin-owned state mutation: writes or removes the communication-language
 *  file under the target's slp-runtime/state. No authority gate — it touches
 *  no config.json entry, only a plugin-owned file, and takes effect at the
 *  next session entry without re-activation. */
export const SetLanguageInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  /** null clears the setting (toggle off); a non-empty string sets it. */
  value: z.string().trim().min(1).max(256).nullable(),
}).strict();
export const SetLanguageOutput = z.object({
  schemaVersion: z.literal(1),
  value: z.string().nullable(),
}).strict();
/** One role's settings-driven provider choice (settings-driven-providers.md
 *  §5 Phase 1). `family` picks the managed `slp-<family>-<role>` provider the
 *  role's profile binds to; absent optional fields are simply not applied to
 *  the generated profile — the plugin invents no model/mode defaults. */
export const RoleChoice = z.object({
  family: Family,
  model: z.string().min(1).optional(),
  modeId: z.string().min(1).optional(),
  thinkingOptionId: z.string().min(1).optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
}).strict();
/** Plugin-owned mutable state at slp-runtime/state/role-routing.json —
 *  strict, so unknown keys are rejected rather than silently widening the
 *  routing surface. Peers stay pool-driven and are not part of the schema. */
export const RoleRouting = z.object({
  schemaVersion: z.literal(1),
  supervisor: RoleChoice,
  lead: RoleChoice,
}).strict();
export const GetRoleRoutingInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
}).strict();
export const GetRoleRoutingOutput = z.object({
  schemaVersion: z.literal(1),
  /** The stored routing, or null when no routing file exists (activation
   *  then keeps the v1 all-family provider generation). */
  routing: RoleRouting.nullable(),
}).strict();
/** Plugin-owned state mutation, same shape as set-language: writes
 *  slp-runtime/state/role-routing.json under the target's stable root. No
 *  authority gate — it touches no config.json entry and takes effect at the
 *  next activation, which regenerates providers/profiles from the choice. */
export const SetRoleRoutingInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  routing: RoleRouting,
}).strict();
export const SetRoleRoutingOutput = z.object({
  schemaVersion: z.literal(1),
  routing: RoleRouting,
}).strict();
/** One seat in the user-scope Peer pool — the wire mirror of the package's
 *  routing-catalog option (plugin/server/runtime/cli/routing.ts validateCatalog). `provider` and
 *  `model` may be empty while `enabled` is false: an archetype-seeded seat
 *  stays parked until the Human fills both from live catalog discovery. The
 *  editor writes availability:"ready" and roles:["peer"] always; the schema
 *  keeps the full file vocabulary so a stored pool round-trips verbatim.
 *  Passthrough, not strict — the package validator tolerates extra option
 *  keys (a legacy file may still carry `priority`), so the wire does too. */
// These three patterns mirror settingIdPattern / unsafeModelPattern /
// swe2ModelPattern in plugin/server/runtime/cli/binding.ts — the shared boundary cannot import the
// package, so the parity test in tests/plugin-routing.test.mjs pins this
// schema to the same accept/reject verdicts as validateCatalog.
const POOL_SETTING_ID = /^[a-zA-Z0-9._-]+$/;
const POOL_UNSAFE_MODEL = /[\s\x00-\x1f\x7f]/;
const POOL_SWE2_MODEL = /^swe-2($|-)/;
const poolNonempty = (s: string) => s.trim().length > 0;

/** The Jev decline sentinel (plugin/server/runtime/cli/routing.ts ROUTE_DECLINE_CANDIDATE) — a
 *  seat may never take it as an id; validateCatalog rejects it the same way. */
export const ROUTE_DECLINE_OPTION_ID = "no-suitable-option";

export const PeerPoolOption = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/).refine(id => id !== ROUTE_DECLINE_OPTION_ID, {
    message: `id is reserved for the Jev decline sentinel`,
  }),
  provider: z.union([Family, z.literal("")]),
  roles: z.array(z.enum(["supervisor", "lead", "peer"])).min(1),
  model: z.string().refine(v => !POOL_UNSAFE_MODEL.test(v)),
  enabled: z.boolean(),
  availability: z.enum(["ready", "quota-exhausted", "paused", "unknown"]),
  // validateCatalog treats explicit null like absence on these four keys.
  thinkingOptionId: z.string().regex(POOL_SETTING_ID).nullish(),
  modeId: z.string().regex(POOL_SETTING_ID).nullish(),
  features: z.record(z.string(), z.unknown()).nullish(),
  suitableFor: z.array(z.string().refine(poolNonempty)),
  avoidFor: z.array(z.string().refine(poolNonempty)),
  notes: z.string().refine(poolNonempty),
}).passthrough().superRefine((option, ctx) => {
  // Cross-field rules validateCatalog enforces that field shapes alone cannot:
  // a blank provider parks the seat (enabled must stay false), an enabled seat
  // needs a model, and an enabled devin seat needs a swe-2 model.
  if (option.provider === "" && option.enabled === true) {
    ctx.addIssue({ code: "custom", path: ["provider"], message: "enabled options require a provider family" });
  }
  if (option.enabled === true && !option.model) {
    ctx.addIssue({ code: "custom", path: ["model"], message: "enabled options require a model" });
  }
  if (option.provider === "devin" && option.enabled === true && !POOL_SWE2_MODEL.test(option.model)) {
    ctx.addIssue({ code: "custom", path: ["model"], message: "devin options require a swe-2 model" });
  }
});
/** Plugin-owned mutable state at slp-runtime/state/peer-pool.json — the
 *  user-scope Peer pool, whole-file-overwrite under sha256 CAS. quotaFallback
 *  is strict because the package validator is strict there (unknown keys
 *  fail); the top-level object stays passthrough like the option schema. */
export const PeerPool = z.object({
  version: z.literal(1),
  policy: z.string().refine(poolNonempty),
  quotaFallback: z.preprocess((value, ctx) => {
    // Wave-6 migration: the legacy ordered optionIds list predates the
    // single designated-option contract. ≤1 unambiguously maps to optionId
    // (0 → null, 1 → that id); a longer list is an ambiguous choice — fail
    // closed with a clear reason, never take-first.
    if (value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.hasOwn(value, "optionIds") && !Object.hasOwn(value, "optionId")) {
      const { optionIds, ...rest } = value as Record<string, unknown> & { optionIds: unknown };
      if (Array.isArray(optionIds) && optionIds.every(id => typeof id === "string")) {
        if (optionIds.length > 1) {
          ctx.addIssue({ code: "custom", path: ["optionIds"], message: `quotaFallback lists ${optionIds.length} options — the designated-option model requires exactly one; edit the pool to choose it` });
        }
        return { ...rest, optionId: (optionIds[0] as string | undefined) ?? null };
      }
    }
    return value;
  }, z.object({
    enabled: z.boolean(),
    optionId: z.string().nullable(),
  }).strict().nullish()),
  options: z.array(PeerPoolOption),
}).passthrough().superRefine((pool, ctx) => {
  const ids = new Set<string>();
  pool.options.forEach((option, index) => {
    if (ids.has(option.id)) {
      ctx.addIssue({ code: "custom", path: ["options", index, "id"], message: `duplicate option id ${option.id}` });
    }
    ids.add(option.id);
  });
  const fallback = pool.quotaFallback;
  if (fallback != null) {
    if (fallback.optionId !== null && !ids.has(fallback.optionId)) {
      ctx.addIssue({ code: "custom", path: ["quotaFallback", "optionId"], message: `quotaFallback option ${fallback.optionId} is not in this pool` });
    }
    if (fallback.enabled && fallback.optionId === null) {
      ctx.addIssue({ code: "custom", path: ["quotaFallback", "optionId"], message: "enabled quotaFallback needs a designated pool option" });
    }
  }
});
export const GetPeerPoolInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
}).strict();
export const GetPeerPoolOutput = z.object({
  schemaVersion: z.literal(1),
  /** The stored user-scope pool, or null when no peer-pool.json exists or its
   *  content fails schema parsing (then `error` carries the evidence). */
  pool: PeerPool.nullable(),
  /** sha256 of the raw file bytes — the optimistic-concurrency token
   *  set-peer-pool requires. Present whenever the file exists, even when
   *  `pool` is null. null means the file is absent. */
  sha256: Sha.nullable(),
  error: z.string().nullable(),
  /** One-time import source: the retired <daemonHome>/slp-routing.json,
   *  parsed when present and valid. Read-only — the plugin never writes or
   *  deletes the legacy file. */
  legacy: PeerPool.nullable(),
  legacyError: z.string().nullable(),
}).strict();
/** Whole-file overwrite of the user-scope pool. `expectedSha256` is the
 *  sha256 get-peer-pool returned (null = expect the file to be absent); a
 *  mismatch is an IDEMPOTENCY_CONFLICT and the client must reload first. */
export const SetPeerPoolInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  pool: PeerPool,
  expectedSha256: Sha.nullable(),
}).strict();
export const SetPeerPoolOutput = z.object({
  schemaVersion: z.literal(1),
  pool: PeerPool,
  /** sha256 of the written file — the next expectedSha256 token. */
  sha256: Sha,
}).strict();
/** Jev provider block stored at slp-runtime/state/jev.json — two kinds.
 *  openrouter: model must be a pinned `<owner>/jev-<version>` id; aliases
 *  (~typesafe/jev-latest, jev-latest, jev-preview) drift and are rejected.
 *  baseUrl accepts the bare origin or the documented prefixed form …/api/v1.
 *  typesafe (first-party, verified against docs.typesafe.ai): model is a
 *  pinned bare `jev-<semver>` id; baseUrl accepts a bare https origin or an
 *  origin+path prefix (custom endpoint/proxy). Both require https and reject
 *  query/hash (parity with plugin/server/runtime/cli/jev.ts readJevConfig); absent baseUrl → the
 *  kind's default origin. */
const jevBaseUrl = (allowPath: (path: string) => boolean) =>
  z.string().min(1).max(512)
    .refine(s => {
      try {
        const u = new URL(s);
        return u.protocol === "https:" && allowPath(u.pathname.replace(/\/+$/, "")) && u.search === "" && u.hash === "";
      } catch { return false; }
    });
export const JevProvider = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("openrouter"),
    baseUrl: jevBaseUrl(JEV_TRANSPORTS.openrouter.baseUrlPathAllowed).default(JEV_TRANSPORTS.openrouter.defaultBaseUrl),
    model: z.string().regex(JEV_TRANSPORTS.openrouter.modelPattern),
  }).strict(),
  z.object({
    kind: z.literal("typesafe"),
    baseUrl: jevBaseUrl(JEV_TRANSPORTS.typesafe.baseUrlPathAllowed).default(JEV_TRANSPORTS.typesafe.defaultBaseUrl),
    model: z.string().regex(JEV_TRANSPORTS.typesafe.modelPattern),
  }).strict(),
]);
/** Per-daemon Jev config — all toggles default off; capabilities is a bool
 *  record so a future capability arrives without a schema bump (a missing
 *  capability defaults to off, matching plugin/server/runtime/cli/jev.ts). Stored as
 *  jev.json (0600); the key lives in a separate jev-<kind>.key file. */
export const JevConfig = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  capabilities: z.object({ routing: z.boolean().default(false) }).catchall(z.boolean()),
  provider: JevProvider,
}).strict();
/** Wire view of the Jev setup — hasKey only; the key material never leaves
 *  the daemon home. `sha256` is the raw jev.json byte hash — the optimistic-
 *  concurrency token set-jev requires so a stale save cannot silently
 *  overwrite another client's capability keys (supervision-integration.md
 *  §Configuration); null means the file is absent, and it stays present on a
 *  broken file so the CAS overwrite path still works. */
export const JevView = z.object({
  configured: z.boolean(),
  enabled: z.boolean().nullable(),
  capabilities: z.record(z.string(), z.boolean()).nullable(),
  provider: JevProvider.nullable(),
  hasKey: z.boolean(),
  keyPermissionsOk: z.boolean().nullable(),
  sha256: Sha.nullable(),
  error: z.string().nullable(),
}).strict();
export const GetJevInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
}).strict();
export const GetJevOutput = z.object({
  schemaVersion: z.literal(1),
  jev: JevView,
}).strict();
/** Plugin-owned state mutation, same class as set-role-routing: writes
 *  slp-runtime/state/jev.json atomically (0600). Toggling off never removes
 *  the stored key. `expectedSha256` is the sha256 get-jev returned (null =
 *  expect the file to be absent); a mismatch is an IDEMPOTENCY_CONFLICT and
 *  the client must reload first — this is what keeps one card's routing edit
 *  from overwriting another's supervision toggle. */
export const SetJevInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  jev: JevConfig,
  expectedSha256: Sha.nullable(),
}).strict();
export const SetJevOutput = z.object({
  schemaVersion: z.literal(1),
  jev: JevView,
}).strict();
/** Key lifecycle: `key` writes jev-openrouter.key (0600, atomic); `null`
 *  removes it. The key value itself is never echoed back or journaled. */
export const SetJevKeyInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
  key: z.string().min(1).max(512).nullable(),
}).strict();
export const SetJevKeyOutput = z.object({
  schemaVersion: z.literal(1),
  hasKey: z.boolean(),
}).strict();
/** Live key probe: GET {baseUrl}/api/v1/auth/key with the stored key. This is
 *  the only Jev RPC that touches the network — an explicit human action, not
 *  a poll. */
export const TestJevInput = z.object({
  schemaVersion: z.literal(1),
  target: Target,
}).strict();
export const TestJevOutput = z.object({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  detail: z.string().max(512).nullable(),
  latencyMs: z.number().nonnegative(),
}).strict();
export const LocalTargetInput = z.object({
  schemaVersion: z.literal(1),
}).strict();
export const LocalTargetOutput = z.object({
  // The daemon home the plugin process believes it serves: $PASEO_HOME when the
  // daemon exported it, else the platform default ~/.paseo. The client may
  // prefill from this but the verifiedHostHomeMapping acknowledgment stays a
  // human decision — detection is a suggestion, never proof.
  daemonHome: AbsolutePath,
  source: z.enum(["env", "default"]),
}).strict();
/** Read-only catalog query: the model/mode list a managed slp-<family>-*
 *  provider inherits from its base provider (`extends`), resolved live via
 *  PaseoApi.providers — available before any binding exists, which is exactly
 *  when the initial-profile picker needs it. */
export const CatalogInput = z.object({
  schemaVersion: z.literal(1),
  family: Family,
  // Which managed provider entry to read in a providers.snapshot response —
  // slp-<family>-<role>, the same entry the host agent profile resolves.
  // Optional for wire back-compat; absent scopes the query to the base
  // family entry.
  role: z.enum(ROLES).optional(),
  // Feature listing runs on a draft agent config — cwd is required by the
  // host API; model/modeId refine which features a provider reports.
  cwd: AbsolutePath.optional(),
  model: z.string().min(1).optional(),
  modeId: z.string().min(1).optional(),
}).strict();
// Host-owned descriptors may gain fields independently of this plugin.
// Strip unknown descriptor keys; the plugin-owned RPC envelopes stay strict.
export const CatalogOption = z.object({
  id: z.string().min(1),
  label: z.string(),
});
/** One selectable option inside a provider feature or model descriptor —
 *  id + display label plus optional description, default marker and
 *  free-form metadata. Shared by CatalogFeature's select options and a
 *  model's thinkingOptions (§9 corrected finding: the host's
 *  AgentModelDefinition exposes them; the plugin interface had
 *  over-narrowed the listing). */
export const CatalogSelectOption = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
/** One catalog model: the picker identity plus the thinking options the
 *  model declares and its declared default option id. Providers that bake
 *  thinking into model ids declare an empty/absent list. */
export const CatalogModel = CatalogOption.extend({
  thinkingOptions: z.array(CatalogSelectOption).optional(),
  defaultThinkingOptionId: z.string().min(1).optional(),
});
/** Provider feature definition — the same descriptor the host's profile
 *  editor renders as a toggle or select. `value` is the provider default;
 *  profile-level overrides live in `featureValues`. */
export const CatalogFeature = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("toggle"),
    id: z.string().min(1),
    label: z.string(),
    description: z.string().optional(),
    tooltip: z.string().optional(),
    icon: z.string().optional(),
    desktopTrigger: z.string().optional(),
    value: z.boolean(),
  }),
  z.object({
    type: z.literal("select"),
    id: z.string().min(1),
    label: z.string(),
    description: z.string().optional(),
    tooltip: z.string().optional(),
    icon: z.string().optional(),
    desktopTrigger: z.string().optional(),
    value: z.string().nullable(),
    options: z.array(CatalogSelectOption),
  }),
]);
export const CatalogOutput = z.object({
  schemaVersion: z.literal(1),
  models: z.array(CatalogModel),
  modes: z.array(CatalogOption),
  features: z.array(CatalogFeature),
  /** Non-fatal: a provider that cannot answer reports here instead of rejecting. */
  error: z.string().nullable(),
  /** The provider id whose snapshot entry actually served this catalog —
   *  the managed `slp-<family>-<role>` id, or the base family on fallback.
   *  Absent on the legacy listModels/listModes path (pre-snapshot daemons). */
  resolvedProvider: z.string().min(1).optional(),
}).strict();
export const activate = defineRpc({ name: "activate", input: ActivateInput, output: StartOutput });
export const reconcile = defineRpc({ name: "reconcile", input: ReconcileInput, output: StartOutput });
export const deactivate = defineRpc({ name: "deactivate", input: DeactivateInput, output: StartOutput });
export const status = defineRpc({ name: "status", input: StatusInput, output: StatusOutput });
export const localTarget = defineRpc({ name: "local-target", input: LocalTargetInput, output: LocalTargetOutput });
export const catalog = defineRpc({ name: "catalog", input: CatalogInput, output: CatalogOutput });
export const setLanguage = defineRpc({ name: "set-language", input: SetLanguageInput, output: SetLanguageOutput });
export const getRoleRouting = defineRpc({ name: "get-role-routing", input: GetRoleRoutingInput, output: GetRoleRoutingOutput });
export const setRoleRouting = defineRpc({ name: "set-role-routing", input: SetRoleRoutingInput, output: SetRoleRoutingOutput });
export const getPeerPool = defineRpc({ name: "get-peer-pool", input: GetPeerPoolInput, output: GetPeerPoolOutput });
export const setPeerPool = defineRpc({ name: "set-peer-pool", input: SetPeerPoolInput, output: SetPeerPoolOutput });
export const getJev = defineRpc({ name: "get-jev", input: GetJevInput, output: GetJevOutput });
export const setJev = defineRpc({ name: "set-jev", input: SetJevInput, output: SetJevOutput });
export const setJevKey = defineRpc({ name: "set-jev-key", input: SetJevKeyInput, output: SetJevKeyOutput });
export const testJev = defineRpc({ name: "test-jev", input: TestJevInput, output: TestJevOutput });

// ---------------------------------------------------------------------------
// §7 receipt / operation-intent journal schemas (server-internal; the client
// bundle never imports them at runtime beyond shared-module presence).
// ---------------------------------------------------------------------------

export const Json = z.json();
export const ProviderId = z.string().regex(OWNED_PROVIDER_ID_RE);
export const Presence = <T extends z.ZodType>(value: T) => z.discriminatedUnion("present", [
  z.object({ present: z.literal(false) }).strict(),
  z.object({ present: z.literal(true), value }).strict(),
]);
export const FlagBefore = z.object({ raw: Presence(z.boolean()), effective: z.boolean() }).strict();
export const Profile = z.object({
  id: z.string(), name: z.string(), provider: z.string(),
  icon: z.string().optional(), color: z.string().optional(),
  model: z.string().optional(), modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), Json).optional(),
  notes: z.string().optional(),
}).catchall(Json);
/** Paseo MCP tools withheld from every package-owned Peer provider. */
export const PEER_PASEO_TOOLS_POLICY = {
  disabledTools: [
    "archive_agent",
    "archive_workspace",
    "cancel_agent",
    "create_agent",
    "create_heartbeat",
    "create_schedule",
    "create_workspace",
    "delete_heartbeat",
    "delete_schedule",
    "update_agent",
  ],
} as const;

export const OwnedProvider = z.object({
  extends: z.enum(PROVIDER_EXTENDS_IDS),
  label: z.string(),
  // argv of one or two absolute elements. Every generated entry is
  // single-element — the launch-set launcher argv[0] (the host's argv0
  // --version probe drops the tail); two-element commands were emitted only
  // by the transitional [node, gate] thin-alias shape, and max(2) keeps
  // receipts written by that build readable.
  command: z.array(AbsolutePath).min(1).max(2),
  env: z.record(z.string(), z.string()), enabled: z.boolean(),
  paseoTools: z.object({
    enabled: z.boolean().optional(),
    disabledTools: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict();
// Persisted observations retain the already-recorded native OpenCode field.
// Current authored providers still use OwnedProvider/current emission values;
// this decoder does not normalize native records into ACP or widen ID domains.
export const PersistedProvider = OwnedProvider.extend({
  extends: z.enum([...PROVIDER_EXTENDS_IDS, "opencode"]),
});
export const OwnedProfileSlot = z.object({
  index: z.number().int().nonnegative(), value: Profile,
}).strict();
export const Projection = z.object({
  providers: z.record(ProviderId, Presence(PersistedProvider)),
  profilesPresent: z.boolean(),
  profiles: z.array(OwnedProfileSlot).max(2),
  injectIntoAgents: Presence(z.boolean()),
}).strict().superRefine((projection, ctx) => {
  if (persistedProviderIds(Object.keys(projection.providers)) === null) {
    ctx.addIssue({ code: "custom", path: ["providers"], message: "projection requires exact legacy12 or current15 provider keys" });
  }
});
export const Snapshot = z.object({
  rawConfigSha256: Sha,
  owned: Projection,
  ownedSha256: Sha,
  allProfilesSha256: Sha,
  unrelatedPersistedSha256: Sha,
  effectiveEnabled: z.boolean(),
  effectiveInjection: z.boolean(),
}).strict();
export const Binary = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true), path: AbsolutePath, version: z.string().min(1) }).strict(),
  z.object({ available: z.literal(false), path: z.null(), version: z.null() }).strict(),
]);
export const LauncherFile = z.object({
  path: AbsolutePath, sha256: Sha, mode: z.number().int().min(0).max(511),
}).strict();
export const Binding = z.object({
  bindingSha256: Sha,
  candidateSha256: Sha,
  payloadSha256: Sha,
  runtimePath: AbsolutePath,
  launchSetSha256: Sha,
  launchManifestSha256: Sha,
  // Legacy bindings record all twelve shim launchers; Phase 2 bindings
  // current bindings record fifteen — twelve gates plus the three
  // devin shim launchers (the transitional devin-only layout also
  // validates). The launch manifest's launcherFamilies/gateFamilies fields
  // carry the per-file kind.
  launcherFiles: z.array(LauncherFile).min(1),
  node: z.object({ path: AbsolutePath, version: z.string().min(1) }).strict(),
  // No defaults: absence belongs to the historical domain and must stay
  // absent when old fields and their digests are verified.
  binaries: z.object({ ...familyKeyed(Binary), opencode: Binary.optional() }).strict(),
  baseline: z.enum(["fresh", "adopted-observed"]),
  beforeActivation: Snapshot,
  mcpBefore: z.object({ enabled: FlagBefore, injectIntoAgents: FlagBefore }).strict(),
  owned: Projection,
  postPatchPersistedShapeSha256: Sha,
  activatedAt: Time,
  verifiedAt: Time,
}).strict().superRefine((binding, ctx) => {
  const families = persistedFamilyIds(Object.keys(binding.binaries));
  const ids = persistedProviderIds(Object.keys(binding.owned.providers));
  if (families === null || ids === null || ids.length !== families.length * ROLES.length) {
    ctx.addIssue({ code: "custom", path: ["binaries"], message: "binding binary/owned domains must both be exact legacy4/12 or current5/15" });
  }
  if (ids !== null && Object.keys(binding.beforeActivation.owned.providers).length > ids.length) {
    ctx.addIssue({ code: "custom", path: ["beforeActivation"], message: "a historical binding cannot have a newer baseline vocabulary" });
  }
  const names = binding.launcherFiles.map(file => file.path.split(/[\\/]/).at(-1)!);
  if (new Set(names).size !== names.length || names.some(name => {
    const match = OWNED_PROVIDER_ID_RE.exec(name);
    return match === null || !families?.includes(match[1] as FamilyName);
  })) {
    ctx.addIssue({ code: "custom", path: ["launcherFiles"], message: "launcher IDs must be unique owned IDs in the binding's recorded family domain" });
  }
});
export const Plan = z.object({
  before: Snapshot,
  afterOwned: Projection,
  afterOwnedSha256: Sha,
  afterAllProfilesSha256: Sha,
  previousBinding: Binding.nullable(),
  nextBinding: Binding.nullable(),
  restoreInjectionTo: z.boolean().nullable(),
}).strict().superRefine((plan, ctx) => {
  if (Object.keys(plan.before.owned.providers).length !== Object.keys(plan.afterOwned.providers).length) {
    ctx.addIssue({ code: "custom", path: ["afterOwned"], message: "plan endpoints require one exact legacy12 or current15 domain" });
  }
  const size = Object.keys(plan.afterOwned.providers).length;
  if ((plan.nextBinding !== null && Object.keys(plan.nextBinding.owned.providers).length !== size)
    || (plan.previousBinding !== null && Object.keys(plan.previousBinding.owned.providers).length > size)) {
    ctx.addIssue({ code: "custom", path: ["nextBinding"], message: "plan binding vocabularies must match the intended endpoint and cannot reverse history" });
  }
});
export const Intent = z.object({
  operationId: Id,
  requestSha256: Sha,
  kind: OperationKind,
  bootId: Id,
  phase: Phase,
  outcome: z.enum(["pending", "succeeded", "no-op", "failed", "recovery-required"]),
  candidateSha256: Sha.nullable(),
  recoveryOf: Id.nullable(),
  recoveryAction: z.enum(["inspect", "complete", "restore-before"]).nullable(),
  acceptedAt: Time,
  updatedAt: Time,
  completedAt: Time.nullable(),
  plan: Plan.nullable(),
  /** Receipt state to restore if this op fails without an ambiguous patch
   *  settlement — recorded at acceptance. Absent on intents journaled by
   *  older builds; readers fall back per op kind. */
  priorState: State.optional(),
  patchAttempts: z.array(z.object({
    requestId: Id,
    dispatchedAt: Time,
    settledAt: Time.nullable(),
    result: z.enum(["pending", "returned", "threw", "outcome-unknown"]),
  }).strict()),
  conflicts: z.array(Conflict).max(64),
}).strict();
export const Receipt = z.object({
  schemaVersion: z.literal(1),
  pluginId: z.literal("paseo-slp"),
  target: Target,
  stableRoot: AbsolutePath,
  revision: z.number().int().nonnegative(),
  state: State,
  createdAt: Time,
  updatedAt: Time,
  binding: Binding.nullable(),
  lastDeactivatedBindingSha256: Sha.nullable(),
  activeOperationId: Id.nullable(),
  retained: z.array(z.object({
    candidateSha256: Sha, payloadSha256: Sha, runtimePath: AbsolutePath,
    launchSetSha256: Sha.nullable(), retainedAt: Time,
  }).strict()),
  operations: z.array(Intent),
}).strict();

// ---------------------------------------------------------------------------
// Derived wire/journal types
// ---------------------------------------------------------------------------

export type Sha256 = z.infer<typeof Sha>;
export type FamilyName = z.infer<typeof Family>;
export type StateValue = z.infer<typeof State>;
export type OperationKindValue = z.infer<typeof OperationKind>;
export type PhaseValue = z.infer<typeof Phase>;
export type ConflictValue = z.infer<typeof Conflict>;
export type ConflictCode = ConflictValue["code"];
export type OperationViewValue = z.infer<typeof OperationView>;
export type TargetValue = z.infer<typeof Target>;
export type AuthorityValue = z.infer<typeof Authority>;
export type ActivateRequest = z.infer<typeof ActivateInput>;
export type ProfilePrefsValue = z.infer<typeof ProfilePrefs>;
export type CatalogOptionValue = z.infer<typeof CatalogOption>;
export type CatalogSelectOptionValue = z.infer<typeof CatalogSelectOption>;
export type CatalogModelValue = z.infer<typeof CatalogModel>;
export type CatalogRequest = z.infer<typeof CatalogInput>;
export type CatalogResult = z.infer<typeof CatalogOutput>;
export type ReconcileRequest = z.infer<typeof ReconcileInput>;
export type DeactivateRequest = z.infer<typeof DeactivateInput>;
export type StatusRequest = z.infer<typeof StatusInput>;
export type SetLanguageRequest = z.infer<typeof SetLanguageInput>;
export type SetLanguageResult = z.infer<typeof SetLanguageOutput>;
export type RoleChoiceValue = z.infer<typeof RoleChoice>;
export type RoleRoutingValue = z.infer<typeof RoleRouting>;
export type GetRoleRoutingRequest = z.infer<typeof GetRoleRoutingInput>;
export type GetRoleRoutingResult = z.infer<typeof GetRoleRoutingOutput>;
export type SetRoleRoutingRequest = z.infer<typeof SetRoleRoutingInput>;
export type SetRoleRoutingResult = z.infer<typeof SetRoleRoutingOutput>;
export type PeerPoolOptionValue = z.infer<typeof PeerPoolOption>;
export type PeerPoolValue = z.infer<typeof PeerPool>;
export type GetPeerPoolRequest = z.infer<typeof GetPeerPoolInput>;
export type GetPeerPoolResult = z.infer<typeof GetPeerPoolOutput>;
export type SetPeerPoolRequest = z.infer<typeof SetPeerPoolInput>;
export type SetPeerPoolResult = z.infer<typeof SetPeerPoolOutput>;
export type JevProviderValue = z.infer<typeof JevProvider>;
export type JevConfigValue = z.infer<typeof JevConfig>;
export type JevViewValue = z.infer<typeof JevView>;
export type GetJevRequest = z.infer<typeof GetJevInput>;
export type GetJevResult = z.infer<typeof GetJevOutput>;
export type SetJevRequest = z.infer<typeof SetJevInput>;
export type SetJevResult = z.infer<typeof SetJevOutput>;
export type SetJevKeyRequest = z.infer<typeof SetJevKeyInput>;
export type SetJevKeyResult = z.infer<typeof SetJevKeyOutput>;
export type TestJevRequest = z.infer<typeof TestJevInput>;
export type TestJevResult = z.infer<typeof TestJevOutput>;
export type StartResult = z.infer<typeof StartOutput>;
export type StatusResult = z.infer<typeof StatusOutput>;
export type BindingViewValue = z.infer<typeof BindingView>;
export type FamilyViewValue = z.infer<typeof FamilyView>;
export type ReceiptValue = z.infer<typeof Receipt>;
export type IntentValue = z.infer<typeof Intent>;
export type PlanValue = z.infer<typeof Plan>;
export type BindingValue = z.infer<typeof Binding>;
export type SnapshotValue = z.infer<typeof Snapshot>;
export type ProjectionValue = z.infer<typeof Projection>;
export type OwnedProviderValue = z.infer<typeof OwnedProvider>;
export type ProfileValue = z.infer<typeof Profile>;
export type OwnedProfileSlotValue = z.infer<typeof OwnedProfileSlot>;
export type BinaryValue = z.infer<typeof Binary>;
export type LauncherFileValue = z.infer<typeof LauncherFile>;

// ---------------------------------------------------------------------------
// §12 frozen module seams (server-internal; type-only below this point).
// Lanes implement against these signatures; Lead owns this file.
// ---------------------------------------------------------------------------

/** §3 wire bounds applied at construction: a conflict field that exceeds the
 * schema would fail Receipt/RPC validation downstream, so normalize before the
 * value can be persisted or returned. */
const CONFLICT_MESSAGE_MAX = 2048;
const CONFLICT_PATH_MAX = 4096;
const CONFLICT_TRUNCATION = "…[truncated]";

export function normalizeConflict(conflict: ConflictValue): ConflictValue {
  const message =
    conflict.message.length > CONFLICT_MESSAGE_MAX
      ? `${conflict.message.slice(0, CONFLICT_MESSAGE_MAX - CONFLICT_TRUNCATION.length)}${CONFLICT_TRUNCATION}`
      : conflict.message;
  const path =
    conflict.path !== null && conflict.path.length > CONFLICT_PATH_MAX
      ? `${conflict.path.slice(0, CONFLICT_PATH_MAX - 1)}…`
      : conflict.path;
  return {
    ...conflict,
    path,
    message: message.length > 0 ? message : "conflict detail unavailable",
  };
}

/** Typed conflict vocabulary shared by every lane. Throw this for any failure
 * that maps to a declared §3 conflict code; the manager converts it. */
export class OperationConflict extends Error {
  readonly code: ConflictCode;
  readonly path: string | null;
  readonly expectedSha256: string | null;
  readonly actualSha256: string | null;
  constructor(
    code: ConflictCode,
    message: string,
    detail?: { path?: string | null; expectedSha256?: string | null; actualSha256?: string | null },
  ) {
    super(message);
    this.name = "OperationConflict";
    this.code = code;
    this.path = detail?.path ?? null;
    this.expectedSha256 = detail?.expectedSha256 ?? null;
    this.actualSha256 = detail?.actualSha256 ?? null;
  }
  toConflict(): ConflictValue {
    return normalizeConflict({
      code: this.code,
      path: this.path,
      message: this.message,
      expectedSha256: this.expectedSha256,
      actualSha256: this.actualSha256,
    });
  }
}

/** Export contract of plugin/server/generated/runtime-payload.ts. The
 * generated module must export `embeddedPayload` satisfying this type. */
export interface EmbeddedPayload {
  schemaVersion: 1;
  candidate: { sha256: string; files: { path: string; sha256: string }[] };
  payloadSha256: string;
  files: { path: string; sha256: string; mode: number; base64: string }[];
}

/** server/materializer.ts — immutable candidate install-unit publication (§5). */
export interface MaterializeResult {
  candidateSha256: Sha256;
  payloadSha256: Sha256;
  /** Absolute path of the published <stable-root>/<candidate-sha> directory. */
  runtimePath: string;
  /** true when an existing verified directory was reused, false when staged. */
  reused: boolean;
}
export interface Materializer {
  /** Stage, verify and publish the embedded candidate under stableRoot.
   * Returns the published identity; throws OperationConflict on integrity or
   * IO failures. Records nothing in the journal — the manager owns intent. */
  materialize(stableRoot: string, operationId: string): Promise<MaterializeResult>;
  /** Re-verify a previously published candidate directory (status/reconcile/
   * deactivate paths). `candidateSha256` is the recorded candidate identity
   * and `payloadSha256` the recorded payload identity — the embedded sha pair
   * verifies against the embedded payload; a foreign pair (binding/retained
   * evidence) verifies self-consistency anchored on the directory's
   * installed.json, whose mode record must hash to `payloadSha256`. Throws
   * OperationConflict (RUNTIME_INTEGRITY) on any deviation. */
  verifyPublished(runtimePath: string, candidateSha256: string, payloadSha256: string): Promise<void>;
  /** Remove only this operation's unpublished staging under stableRoot.
   * Never touches published directories or other operations' staging. */
  discardStaging(stableRoot: string, operationId: string): Promise<void>;
}
export type MaterializerFactory = (payload: EmbeddedPayload) => Materializer;

/** server/executables.ts — Node + family binary resolution and probes (§6). */
export type BinaryResolution = BinaryValue;
export interface ResolvedNode {
  /** Verified absolute ordinary-Node path; never Electron/plugin/shim paths. */
  path: string;
  version: string;
}
export interface ExecutableResolution {
  node: ResolvedNode;
  binaries: Record<FamilyName, BinaryResolution>;
}
export interface ExecutableRequest {
  /** Canonical daemon home (realpath already applied by caller). */
  daemonHome: string;
  /** <daemon-home>/slp-runtime; resolved executables must lie outside it and
   * outside managed plugin checkouts. */
  stableRoot: string;
  /** Administrator-supplied Node path; an invalid value is an error, never a
   * fallback trigger. */
  nodePath?: string;
  /** Administrator-supplied per-family binary paths. */
  binaries?: Partial<Record<FamilyName, string>>;
  /** Previous binding's verified resolution, when rebinding/reconciling. */
  prior?: {
    node?: { path: string; version?: string } | null;
    binaries?: Partial<Record<FamilyName, BinaryResolution>> | null;
  } | null;
}
export interface ExecutableResolver {
  /** Node: explicit → prior → PATH. Family binaries: explicit → PATH → prior.
   * Every positive result is probe-verified; failures yield available:false
   * binaries or throw OperationConflict(EXECUTABLE_UNAVAILABLE) for Node. */
  resolve(request: ExecutableRequest): Promise<ExecutableResolution>;
}
export type ExecutableResolverFactory = () => ExecutableResolver;

/** server/launchers.ts — immutable launch-set generation/publication (§6). */
export interface LaunchSetRequest {
  daemonHome: string;
  stableRoot: string;
  operationId: string;
  candidate: { sha256: Sha256; runtimePath: string };
  node: ResolvedNode;
  binaries: Record<FamilyName, BinaryResolution>;
}
export interface LaunchSet {
  launchSetSha256: Sha256;
  /** sha256 of the exact launch.json bytes. */
  launchManifestSha256: Sha256;
  /** <stableRoot>/launchers/<launchSetSha256> */
  directory: string;
  /** The generated launcher files (Phase 2: the three devin wrapper
   *  launchers), with recorded sha256/mode. */
  files: LauncherFileValue[];
  /** P2-d — the manifest's desk-bridge pin, when the published manifest
   *  carries it. Absent on pre-P2-d launch sets; the bridge treats absence
   *  as "no pin recorded" and refuses graft/hello rather than guessing. */
  bridgeSha256?: string;
  bridgeProtocolVersion?: string;
}
export interface LauncherBuilder {
  /** Build launch.json deterministically, stage the POSIX launchers, verify
   * bytes/modes, publish by rename. Throws OperationConflict on failure. */
  publish(request: LaunchSetRequest): Promise<LaunchSet>;
  /** Re-verify a published launch set: manifest digest, every launcher
   * bytes/modes. Throws OperationConflict(RUNTIME_INTEGRITY) on deviation. */
  verify(directory: string): Promise<LaunchSet>;
}
export type LauncherBuilderFactory = () => LauncherBuilder;

/** Narrowed connected-API surface the manager may use (§2): config get/patch
 * only. The SDK PaseoApi is structurally assignable to this. */
export interface DaemonConfigConnection {
  get(requestId?: string): Promise<{ requestId: string; config: Record<string, unknown> }>;
  patch(patch: Record<string, unknown>, requestId?: string): Promise<{ requestId: string; config: Record<string, unknown> }>;
}
export interface ConnectedDaemon {
  config: DaemonConfigConnection;
}

/** server/manager.ts — sole owner of the mutation mutex, state transitions and
 * connected SDK calls (§3, §8–9). index.server.ts wires the real deps; tests
 * may inject honest doubles. */
export interface ManagerDeps {
  payload: EmbeddedPayload;
  materializer: Materializer;
  executables: ExecutableResolver;
  launchers: LauncherBuilder;
  /** Deterministic seams for tests; production wiring leaves them absent. */
  now?: () => Date;
  uuid?: () => string;
  platform?: string;
}
export interface Manager {
  activate(input: ActivateRequest, daemon: ConnectedDaemon): Promise<StartResult>;
  reconcile(input: ReconcileRequest, daemon: ConnectedDaemon): Promise<StartResult>;
  deactivate(input: DeactivateRequest, daemon: ConnectedDaemon): Promise<StartResult>;
  status(input: StatusRequest, daemon: ConnectedDaemon): Promise<StatusResult>;
  /** Stop accepting work and close owned resources. Does not deactivate SLP
   * or remove files; recovery stays journal-driven. */
  close(): void;
}
export type ManagerFactory = (deps: ManagerDeps) => Manager;
