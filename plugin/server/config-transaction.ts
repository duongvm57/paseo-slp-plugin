// plugin/server/config-transaction.ts — pure transaction planner (§8, §13).
//
// No filesystem, no SDK, no clocks: every function maps inputs to a Plan plus
// the single plain-JSON patch object that would reach `config.patch`. The
// compatibility validator reproduces the pinned host's persisted schema and
// migration behavior (S/persisted-config.js for @getpaseo/server 0.8.0) so a
// field that host persistence would drop or reject is reported as SCHEMA_LOSS
// before any mutation — the file is never "fixed" by stripping.

import { z } from "zod";
import { join } from "node:path";
import {
  AgentProfileSchema,
  AgentSkillSelectionSchema,
  PluginIdSchema,
  PluginSourceSchema,
  TerminalProfileSchema,
} from "@getpaseo/protocol/messages";
import {
  AgentProviderRuntimeSettingsMapSchema,
  ProviderOverrideSchema,
  ProviderOverridesSchema,
  ProviderRuntimeSettingsSchema,
} from "@getpaseo/protocol/provider-config";
import { PaseoServicePortAllocationSchema } from "@getpaseo/protocol/paseo-config-schema";
import {
  OperationConflict,
  PEER_PASEO_TOOLS_POLICY,
  type ActivateRequest,
  type BindingValue,
  type ExecutableResolution,
  type FamilyName,
  type LaunchSet,
  type OperationKindValue,
  type OwnedProviderValue,
  type PlanValue,
  type ProfilePrefsValue,
  type ProfileValue,
  type ProjectionValue,
  type RoleChoiceValue,
  type RoleRoutingValue,
} from "../shared/contracts.ts";
import {
  FAMILY_BIN_ENV,
  FAMILY_LABEL,
  HOOK_FAMILY_IDS,
  OWNED_PROVIDER_ID_RE,
  ownedProviderId,
} from "../shared/families.ts";
import {
  FAMILIES,
  OWNED_PROFILE_IDS,
  OWNED_PROVIDER_IDS,
  PROVIDER_EXTENDS,
  ROLE_DISPLAY,
  allProfilesHash,
  canonicalEqual,
  canonicalSha256,
  effectiveView,
  extractProjection,
  getKey,
  getPath,
  isRecord,
  mcpFlagPresence,
  profilesArray,
  profilesHashOf,
  providerWrittenFieldsEqual,
  providersRecord,
  snapshotFrom,
  unrelatedPersistedView,
  assertRawLiveAgreement,
  type EffectiveView,
  type RawConfigView,
} from "./config-view.ts";

// ---------------------------------------------------------------------------
// Pinned persisted-schema reproduction — @getpaseo/server 0.8.0
// S/persisted-config.js. Kept byte-faithful in behavior: strict where the host
// is strict, passthrough where the host passes through, same migrations.
// ---------------------------------------------------------------------------

const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
const LogFormatSchema = z.enum(["pretty", "json"]);
const LogConfigSchema = z
  .object({
    level: LogLevelSchema.optional(),
    format: LogFormatSchema.optional(),
    console: z
      .object({ level: LogLevelSchema.optional(), format: LogFormatSchema.optional() })
      .strict()
      .optional(),
    file: z
      .object({
        level: LogLevelSchema.optional(),
        path: z.string().min(1).optional(),
        rotate: z
          .object({
            maxSize: z.string().min(1).optional(),
            maxFiles: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const OpenAiSpeechEndpointSchema = z
  .object({ apiKey: z.string().trim().min(1).optional(), baseUrl: z.string().trim().min(1).optional() })
  .strict();
const OpenAiProviderSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    stt: OpenAiSpeechEndpointSchema.optional(),
    tts: OpenAiSpeechEndpointSchema.optional(),
  })
  .strict();
const LocalSpeechProviderSchema = z.object({ modelsDir: z.string().min(1).optional() }).strict();
const ProvidersSchema = z
  .object({
    openai: OpenAiProviderSchema.optional(),
    local: LocalSpeechProviderSchema.optional(),
  })
  .strict();
const WorktreesConfigSchema = z
  .object({
    root: z.string().min(1).optional(),
    servicePorts: PaseoServicePortAllocationSchema.optional(),
  })
  .strict();
const BcryptHashSchema = z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, {
  message: "Expected a bcrypt hash",
});
const DaemonAuthSchema = z.object({ password: BcryptHashSchema.optional() }).strict();
const SpeechProviderIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["openai", "local"]));
const FeatureDictationSchema = z
  .object({
    enabled: z.boolean().optional(),
    stt: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        language: z.string().trim().min(1).optional(),
        confidenceThreshold: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const FeatureVoiceModeSchema = z
  .object({
    enabled: z.boolean().optional(),
    llm: z
      .object({ provider: z.string().optional(), model: z.string().min(1).optional() })
      .strict()
      .optional(),
    stt: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        language: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    turnDetection: z.object({ provider: SpeechProviderIdSchema.optional() }).strict().optional(),
    tts: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).optional(),
        speakerId: z.number().int().optional(),
        speed: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const FeatureWebUiSchema = z
  .object({ enabled: z.boolean().optional(), distDir: z.string().min(1).optional() })
  .strict();
const StructuredGenerationProviderConfigSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .strict();
const AgentMetadataGenerationSchema = z
  .object({ providers: z.array(StructuredGenerationProviderConfigSchema).optional() })
  .strict();
const BUILTIN_PROVIDER_IDS = ["claude", "codex", "copilot", "opencode", "pi", "omp"];

function isLegacyProviderEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const command = value.command;
  if (!isRecord(command)) return false;
  return typeof command.mode === "string";
}

/** Port of S/agent/provider-launch-config.js `migrateProviderSettings`. */
function migrateProviderSettings(
  raw: Record<string, unknown>,
  builtinProviderIds: string[],
): Record<string, unknown> {
  const migrated: Record<string, unknown> = {};
  const builtinProviderIdSet = new Set(builtinProviderIds);
  for (const [providerId, value] of Object.entries(raw)) {
    const parsedNew = ProviderOverrideSchema.safeParse(value);
    if (parsedNew.success) {
      migrated[providerId] = parsedNew.data;
      continue;
    }
    const parsedOld = ProviderRuntimeSettingsSchema.safeParse(value);
    if (!parsedOld.success) continue;
    const nextEntry: Record<string, unknown> = {};
    const command = parsedOld.data.command;
    if (command?.mode === "append") continue;
    if (command?.mode === "replace") nextEntry.command = command.argv;
    if (parsedOld.data.env) nextEntry.env = parsedOld.data.env;
    if (!builtinProviderIdSet.has(providerId) && nextEntry.extends === undefined) {
      delete nextEntry.extends;
    }
    migrated[providerId] = nextEntry;
  }
  return ProviderOverridesSchema.parse(migrated);
}

/** Port of the `normalizeAgentProviders` preprocess in S/persisted-config.js —
 *  the one legacy normalization shared by every provider-config consumer. */
function normalizeAgentProviders(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const rawProviders = value;
  const hasLegacyEntries = Object.values(rawProviders).some(entry => isLegacyProviderEntry(entry));
  if (!hasLegacyEntries) return value;
  const legacyEntries: Record<string, unknown> = {};
  const normalizedEntries: Record<string, unknown> = {};
  for (const [providerId, providerValue] of Object.entries(rawProviders)) {
    if (isLegacyProviderEntry(providerValue)) {
      legacyEntries[providerId] = providerValue;
      continue;
    }
    normalizedEntries[providerId] = providerValue;
  }
  const parsedLegacyEntries = AgentProviderRuntimeSettingsMapSchema.safeParse(legacyEntries);
  if (!parsedLegacyEntries.success) return value;
  return {
    ...normalizedEntries,
    ...migrateProviderSettings(parsedLegacyEntries.data, [...BUILTIN_PROVIDER_IDS]),
  };
}

/** Port of `stripRemovedConfigFields` — discarded, not migrated, host fields. */
function stripRemovedConfigFields(parsed: unknown): unknown {
  if (!isRecord(parsed)) return parsed;
  const root = { ...parsed };
  const providers = root.providers;
  if (!isRecord(providers)) return root;
  const providersRecord = { ...providers };
  const local = providersRecord.local;
  if (isRecord(local)) {
    const localRecord = { ...local };
    delete localRecord.autoDownload;
    providersRecord.local = localRecord;
  }
  const openai = providersRecord.openai;
  if (isRecord(openai)) {
    const openaiRecord = { ...openai };
    // COMPAT(openaiVoiceConfig): mirrors the host's removed-field strip — a
    // leftover providers.openai.voice block is discarded, not migrated.
    delete openaiRecord.voice;
    providersRecord.openai = openaiRecord;
  }
  root.providers = providersRecord;
  return root;
}

export const PinnedPersistedConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).optional(),
    daemon: z
      .object({
        listen: z.string().optional(),
        hostnames: z.union([z.literal(true), z.array(z.string())]).optional(),
        allowedHosts: z.union([z.literal(true), z.array(z.string())]).optional(),
        trustedProxies: z.union([z.literal(true), z.array(z.string())]).optional(),
        mcp: z
          .object({
            enabled: z.boolean().optional(),
            injectIntoAgents: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        browserTools: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
        git: z
          .object({
            maxProcessesPerSecond: z.number().int().positive().optional(),
            maxProcessConcurrency: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        autoArchiveAfterMerge: z.boolean().optional(),
        enableTerminalAgentHooks: z.boolean().optional(),
        appendSystemPrompt: z.string().optional(),
        terminalProfiles: z.array(TerminalProfileSchema).optional(),
        agentProfiles: z.array(AgentProfileSchema).optional(),
        cors: z
          .object({ allowedOrigins: z.array(z.string()).optional() })
          .strict()
          .optional(),
        relay: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            publicEndpoint: z.string().optional(),
            useTls: z.boolean().optional(),
            publicUseTls: z.boolean().optional(),
          })
          .strict()
          .optional(),
        serviceProxy: z
          .object({
            enabled: z.boolean().optional(),
            listen: z.string().optional(),
            publicBaseUrl: z.url().optional(),
          })
          .strict()
          .optional(),
        auth: DaemonAuthSchema.optional(),
      })
      .strict()
      .transform(({ allowedHosts, ...daemon }) => {
        const hostnames = daemon.hostnames ?? allowedHosts;
        return hostnames === undefined ? daemon : { ...daemon, hostnames };
      })
      .optional(),
    app: z.object({ baseUrl: z.string().optional() }).strict().optional(),
    providers: ProvidersSchema.optional(),
    pluginsEnabled: z.boolean().optional(),
    plugins: z.record(PluginIdSchema, PluginSourceSchema).optional(),
    worktrees: WorktreesConfigSchema.optional(),
    agents: z
      .object({
        providers: z.preprocess(normalizeAgentProviders, ProviderOverridesSchema).optional(),
        catalogRefreshTimeoutMs: z.number().int().positive().max(2147483647).optional(),
        metadataGeneration: AgentMetadataGenerationSchema.optional(),
        skills: z.object({ selection: AgentSkillSelectionSchema.optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    features: z
      .object({
        dictation: FeatureDictationSchema.optional(),
        voiceMode: FeatureVoiceModeSchema.optional(),
        webUi: FeatureWebUiSchema.optional(),
      })
      .strict()
      .optional(),
    log: LogConfigSchema.optional(),
  })
  .strict();

/**
 * Every raw field must survive the host's strip+migrate+parse pipeline. Any
 * key present in the raw document but absent from the parsed output would be
 * discarded by the next `savePersistedConfig` — that is SCHEMA_LOSS.
 */
function collectDroppedFields(
  raw: unknown,
  parsed: unknown,
  path: string,
  out: string[],
): void {
  if (!isRecord(raw)) return;
  if (!isRecord(parsed)) {
    out.push(path === "" ? "(root)" : path);
    return;
  }
  for (const key of Object.keys(raw)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (!Object.hasOwn(parsed, key)) {
      out.push(childPath);
      continue;
    }
    const rawChild = raw[key];
    const parsedChild = parsed[key];
    if (Array.isArray(rawChild) && Array.isArray(parsedChild)) {
      const count = Math.min(rawChild.length, parsedChild.length);
      for (let i = 0; i < count; i += 1) {
        collectDroppedFields(rawChild[i], parsedChild[i], `${childPath}[${i}]`, out);
      }
      for (let i = count; i < rawChild.length; i += 1) out.push(`${childPath}[${i}]`);
      continue;
    }
    collectDroppedFields(rawChild, parsedChild, childPath, out);
  }
}

const MAX_REPORTED = 16;

export function assertPersistedCompatible(rawJson: unknown): void {
  if (!isRecord(rawJson)) {
    throw new OperationConflict("SCHEMA_LOSS", "config.json root is not a JSON object");
  }
  const migrated = stripRemovedConfigFields(rawJson);
  let result: z.ZodSafeParseResult<unknown>;
  try {
    result = PinnedPersistedConfigSchema.safeParse(migrated);
  } catch (error) {
    throw new OperationConflict(
      "SCHEMA_LOSS",
      `provider settings migration rejects the config: ${(error as Error).message}`,
    );
  }
  if (!result.success) {
    const shown = result.error.issues
      .slice(0, MAX_REPORTED)
      .map((issue: { path: PropertyKey[]; message: string }) => `${issue.path.join(".")}: ${issue.message}`);
    const rest = result.error.issues.length > MAX_REPORTED
      ? ` (+${result.error.issues.length - MAX_REPORTED} more)`
      : "";
    throw new OperationConflict(
      "SCHEMA_LOSS",
      `config.json fails the pinned persisted schema: ${shown.join("; ")}${rest}`,
      { path: result.error.issues[0]?.path.join(".") || null },
    );
  }
  const dropped: string[] = [];
  collectDroppedFields(rawJson, result.data, "", dropped);
  if (dropped.length > 0) {
    const shown = dropped.slice(0, MAX_REPORTED).join(", ");
    const rest = dropped.length > MAX_REPORTED ? ` (+${dropped.length - MAX_REPORTED} more)` : "";
    throw new OperationConflict(
      "SCHEMA_LOSS",
      `host persistence would drop ${dropped.length} field(s): ${shown}${rest}; remove or migrate them outside this transaction`,
      { path: dropped[0] },
    );
  }
}

// ---------------------------------------------------------------------------
// Desired owned configuration (§6 provider/env shape; src/paseo-install.mjs
// label/profile conventions, duplicated per the no-cross-boundary rule)
// ---------------------------------------------------------------------------

/** Hook-injected families (settings-driven-providers.md §6 Phase 2): their
 *  provider entries are sentinel-gated thin aliases — `slp-*` identity +
 *  native `extends`, no shim, no wrapper. The alias keeps agent.provider as
 *  `slp-codex-lead` (managed-seat visibility) and its argv[0] is the launch
 *  set's gate launcher: a generated script that exports the frozen
 *  SLP_FAMILY_BIN and execs the candidate's bin/slp-gate.mjs under the
 *  binding's verified Node. argv[0] must be a generated per-entry file —
 *  the host's bare `--version` probe drops provider env entirely, so a
 *  candidate-level script could resolve neither Node nor the family
 *  binary. The gate refuses any launch that arrives without the
 *  session-open hook's grant — a pure `extends`-only alias would silently
 *  spawn unroled during a hook gap (plugin disabled or reloading), so the
 *  sentinel is mandatory. Devin is absent from this set: the ACP adapter
 *  drops systemPrompt, so slp-devin-* keeps the existing shim+wrapper
 *  launcher transport. The set is the registry's `transport === "hook"`
 *  entries — no second literal list. */
const HOOK_GATE_FAMILIES: ReadonlySet<FamilyName> = new Set(HOOK_FAMILY_IDS);

function desiredProviderEnv(
  family: FamilyName,
  args: { runtimePath: string; nodePath: string; binaryPath: string | null; daemonHome: string },
): Record<string, string> {
  return {
    SLP_SESSION_OPEN_GRANT: "",
    [FAMILY_BIN_ENV[family]]: args.binaryPath ?? "",
    SLP_RUNTIME_ROOT: args.runtimePath,
    SLP_NODE_BIN: args.nodePath,
    SLP_DAEMON_HOME: args.daemonHome,
    PASEO_HOME: args.daemonHome,
    SLP_MANAGED_RUNTIME: "1",
  };
}

function launcherPathFor(launchSet: LaunchSet, providerId: string): string {
  const file = launchSet.files.find(entry => entry.path.endsWith(`/${providerId}`));
  if (!file) {
    throw new Error(`launch set ${launchSet.launchSetSha256} lacks launcher ${providerId}`);
  }
  return file.path;
}

/** The generated provider entries for a launch set + resolution.
 *
 *  Settings-driven generation (settings-driven-providers.md §5 Phase 1):
 *  when `routing` is set, only the chosen supervisor combo, the chosen lead
 *  combo and all four `slp-<family>-peer` entries are emitted — peers stay
 *  pool-driven per Lead delegation, so they are always generated. Ids absent
 *  from the returned map record `present:false` in the plan endpoint, which
 *  the patch turns into a removal on rebind. A null routing keeps the v1
 *  all-twelve generation — the documented backward-compatibility decision
 *  for an absent or legacy routing file. */
export function desiredProviderEntries(
  launchSet: LaunchSet,
  resolution: ExecutableResolution,
  runtimePath: string,
  daemonHome: string,
  routing: RoleRoutingValue | null = null,
): Record<string, OwnedProviderValue> {
  const combos: { family: FamilyName; role: "supervisor" | "lead" | "peer" }[] = [];
  if (routing === null) {
    for (const family of FAMILIES) {
      for (const role of ["supervisor", "lead", "peer"] as const) {
        combos.push({ family, role });
      }
    }
  } else {
    combos.push(
      { family: routing.supervisor.family, role: "supervisor" },
      { family: routing.lead.family, role: "lead" },
    );
    for (const family of FAMILIES) combos.push({ family, role: "peer" });
  }
  const entries: Record<string, OwnedProviderValue> = {};
  for (const { family, role } of combos) {
    const binary = resolution.binaries[family];
    const binaryPath = binary.available ? binary.path : null;
    const id = ownedProviderId(family, role);
    const paseoTools = role === "peer"
      ? { disabledTools: [...PEER_PASEO_TOOLS_POLICY.disabledTools] }
      : undefined;
    if (HOOK_GATE_FAMILIES.has(family)) {
      // Thin alias: slp-* identity + native extends, argv[0] is the launch
      // set's gate launcher (frozen binary + gate exec, env-free-probe
      // safe). env carries the same managed backstop the wrapper path
      // freezes, plus the empty grant sentinel the session_open hook
      // overlays and SLP_FAMILY_BIN — the launcher's baked export is the
      // probe-time source, the env copy is the spawn-time source.
      entries[id] = {
        extends: PROVIDER_EXTENDS[family],
        // One label template for every transport (§9): `SLP <Family> <Role>`
        // with FAMILY_LABEL as the single display-name source — the hook
        // branch previously emitted '<family> — <Role> (SLP)' while the
        // wrapper branch already emitted this form. `label` sits inside
        // WRITTEN_PROVIDER_FIELDS, so live entries keep their old labels
        // until the next activation rewrites them; no migration.
        label: `SLP ${FAMILY_LABEL[family]} ${ROLE_DISPLAY[role]}`,
        command: [launcherPathFor(launchSet, id)],
        env: {
          ...desiredProviderEnv(family, {
            runtimePath,
            nodePath: resolution.node.path,
            binaryPath,
            daemonHome,
          }),
          SLP_FAMILY_BIN: binaryPath ?? "",
        },
        enabled: binary.available,
        ...(paseoTools ? { paseoTools } : {}),
      };
      continue;
    }
    entries[id] = {
      extends: PROVIDER_EXTENDS[family],
      label: `SLP ${FAMILY_LABEL[family]} ${ROLE_DISPLAY[role]}`,
      command: [launcherPathFor(launchSet, id)],
      env: desiredProviderEnv(family, {
        runtimePath,
        nodePath: resolution.node.path,
        binaryPath,
        daemonHome,
      }),
      enabled: binary.available,
      ...(paseoTools ? { paseoTools } : {}),
    };
  }
  return entries;
}

/** The two owned saved profiles for a fresh binding (§6, src conventions).
 *  Human-supplied preferences are merged verbatim — the plugin invents no
 *  model, mode, or feature defaults of its own. `family` picks the managed
 *  provider for that role; absent fields are simply not written, and a
 *  `null` pref field is an explicit clear — it deletes the field even when
 *  the routing supplied it (same semantics as the rebind path's
 *  applyProfilePrefs).
 *
 *  Precedence under a stored routing (Phase 1): the routing choice supplies
 *  the provider (`slp-<routing.family>-<role>`) plus whichever of model,
 *  modeId, thinkingOptionId and featureValues it sets; an explicit
 *  `profiles` input on `activate` remains the override applied after
 *  routing — a per-role `family` pref still repoints the provider. */
export function desiredProfiles(
  family: FamilyName,
  prefs?: { supervisor?: ProfilePrefsValue; lead?: ProfilePrefsValue },
  routing: RoleRoutingValue | null = null,
): ProfileValue[] {
  const notes = (role: string) =>
    `Managed by the paseo-slp plugin — remove via the SLP surface, not by deleting this profile. SLP ${role}; installed role instructions load automatically. Use Paseo delegation and finish notifications.`;
  const providerFor = (role: "supervisor" | "lead") =>
    ownedProviderId(prefs?.[role]?.family ?? routing?.[role].family ?? family, role);
  const fields = (role: "supervisor" | "lead") => {
    const { family: _family, ...prefRest } = prefs?.[role] ?? {};
    const { family: _routingFamily, ...routingRest } = routing?.[role] ?? {};
    // Same explicit-edit semantics as the rebind path (applyProfilePrefs):
    // absent pref fields let the routing value stand, a pref value writes,
    // and `null` clears — including clearing a field the routing supplied.
    // (Before this was asymmetric: fresh-path `null` was filtered out, so
    // the routing value silently won where rebind would have deleted.)
    const merged: Record<string, unknown> = { ...routingRest };
    for (const [key, value] of Object.entries(prefRest)) {
      if (value === undefined) continue;
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return merged as Pick<ProfileValue, "model" | "modeId" | "thinkingOptionId" | "featureValues">;
  };
  return [
    {
      id: "slp-supervisor",
      name: "SLP Supervisor",
      provider: providerFor("supervisor"),
      notes: notes("supervisor"),
      ...fields("supervisor"),
    },
    {
      id: "slp-lead",
      name: "SLP Lead",
      provider: providerFor("lead"),
      notes: notes("lead"),
      ...fields("lead"),
    },
  ];
}

/** Apply explicit profile preferences onto a live owned profile under a
 *  binding: absent fields preserve the live value, `null` clears the field,
 *  and `family` repoints the provider at that family's managed provider for
 *  the profile's role. The caller must have already validated the live entry
 *  and the family's availability. */
export function applyProfilePrefs(
  live: ProfileValue,
  prefs: ProfilePrefsValue | undefined,
  role: "supervisor" | "lead",
): ProfileValue {
  if (!prefs) return live;
  const next: Record<string, unknown> = { ...live };
  if (prefs.family !== undefined) {
    next.provider = ownedProviderId(prefs.family, role);
  }
  for (const key of ["model", "modeId", "thinkingOptionId", "featureValues"] as const) {
    const value = prefs[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as ProfileValue;
}

/** Settings-driven repoint of a live owned profile under a binding (Phase
 *  1): the routing choice always supplies the provider and whichever
 *  optional fields it sets; absent optional fields are simply not applied —
 *  they preserve the live value. `input.profiles` stays the override applied
 *  after this (absent = preserve, null = clear, family = repoint). */
function applyRoleRouting(
  live: ProfileValue,
  choice: RoleChoiceValue,
  role: "supervisor" | "lead",
): ProfileValue {
  const next: Record<string, unknown> = { ...live, provider: ownedProviderId(choice.family, role) };
  for (const key of ["model", "modeId", "thinkingOptionId", "featureValues"] as const) {
    if (choice[key] !== undefined) next[key] = choice[key];
  }
  return next as ProfileValue;
}

/** An effective routing (stored choice plus any `profiles` family override)
 *  that names an unavailable family can never produce a working seat — fail
 *  closed rather than bind a profile to a disabled provider, the same rule
 *  `profiles`/`initialProfileFamily` requests already follow. */
function assertRoutingAvailable(
  resolution: ExecutableResolution,
  routing: RoleRoutingValue,
): void {
  const available = availableFamilies(resolution);
  for (const role of ["supervisor", "lead"] as const) {
    const family = routing[role].family;
    if (!available.includes(family)) {
      throw new OperationConflict(
        "EXECUTABLE_UNAVAILABLE",
        `provider family ${family} selected for ${role} is unavailable; the binding would point at a disabled provider`,
        { path: `daemon.agentProfiles.slp-${role}` },
      );
    }
  }
}

const PROFILE_ROLE: Record<string, string> = {
  "slp-supervisor": "supervisor",
  "slp-lead": "lead",
};

/**
 * Insert owned profile slots into a profile array that has no owned ids —
 * each slot lands at its recorded index in the full array (§8.2.3 ordering).
 */
export function applyOwnedSlots(baseArray: unknown[], slots: { index: number; value: unknown }[]): unknown[] {
  const withoutOwned = baseArray.filter(
    entry => !(isRecord(entry) && typeof entry.id === "string" && OWNED_PROFILE_IDS.includes(entry.id)),
  );
  const result = [...withoutOwned];
  for (const slot of [...slots].sort((a, b) => a.index - b.index)) {
    result.splice(Math.min(slot.index, result.length), 0, slot.value);
  }
  return result;
}

// Slot index = position the profile occupies in the final array. A profile
// whose id already exists keeps that index; otherwise it appends after the
// FULL base array, in declaration order. (§8.1 mixed absent/exact-present
// adoption: indexing off the non-owned count would collide with an owned
// profile already present in the array.)
function computeSlots(baseArray: unknown[], profiles: ProfileValue[]): { index: number; value: ProfileValue }[] {
  let appended = 0;
  const slots = profiles.map(profile => {
    const existing = baseArray.findIndex(entry => isRecord(entry) && entry.id === profile.id);
    const index = existing >= 0 ? existing : baseArray.length + appended++;
    return { index, value: profile };
  });
  // Index order is the canonical slot order everywhere: extractProjection
  // sorts by index and the verifier compares order-sensitively, so a
  // declaration-ordered list whose indexes interleave ([1,0]) would
  // miscompare against the disk projection of the identical array.
  return slots.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Endpoint matching — used by plan-needed checks, post-patch verify, classify
// ---------------------------------------------------------------------------

interface EndpointMatch {
  match: boolean;
  problems: string[];
}

/** Does raw JSON equal an endpoint projection + profile-array + unrelated hash? */
function diskMatchesEndpoint(
  rawJson: unknown,
  owned: ProjectionValue,
  allProfilesSha256: string,
  unrelatedPersistedSha256: string,
): EndpointMatch {
  const problems: string[] = [];
  let observed: ProjectionValue;
  try {
    observed = extractProjection(rawJson, "OWNERSHIP_DRIFT");
  } catch (error) {
    problems.push((error as Error).message);
    return { match: false, problems };
  }
  const rawProviders = providersRecord(rawJson);
  for (const id of OWNED_PROVIDER_IDS) {
    const expected = owned.providers[id];
    const present = Object.hasOwn(rawProviders, id);
    if (expected.present !== present) {
      problems.push(`agents.providers.${id} presence differs`);
      continue;
    }
    if (expected.present && present && !canonicalEqual(expected.value, rawProviders[id])) {
      problems.push(`agents.providers.${id}`);
    }
  }
  // §8.3 semantic restore: the recorded flag is raw truth, but at this
  // compare site an empty owned set is equivalent whether the persisted key
  // is absent or explicit [] — patches can only write, never unwrite.
  const presenceMatches =
    observed.profilesPresent === owned.profilesPresent ||
    (observed.profiles.length === 0 && owned.profiles.length === 0);
  if (!presenceMatches || observed.profiles.length !== owned.profiles.length) {
    problems.push("daemon.agentProfiles owned set differs");
  } else {
    for (let i = 0; i < owned.profiles.length; i += 1) {
      if (
        observed.profiles[i].index !== owned.profiles[i].index ||
        !canonicalEqual(observed.profiles[i].value, owned.profiles[i].value)
      ) {
        problems.push(`daemon.agentProfiles[${observed.profiles[i].index}]`);
      }
    }
  }
  // injectIntoAgents restores semantically: the patch can only write a
  // boolean, so "absent" in an endpoint means effective false — an explicit
  // false on disk satisfies it (§8.3 restore rule).
  const injection = mcpFlagPresence(rawJson, "injectIntoAgents");
  const observedInject = injection.present ? injection.value === true : false;
  const expectedInject = owned.injectIntoAgents.present ? owned.injectIntoAgents.value === true : false;
  if (observedInject !== expectedInject) {
    problems.push("daemon.mcp.injectIntoAgents");
  }
  // Whole-array check: the recorded hash binds raw presence, but presence is
  // compared semantically here — an empty array satisfies either recorded
  // presence value (§8.3). A non-empty array forces present anyway.
  const wholeProfiles = profilesArray(rawJson);
  const wholeProfilesMatch =
    profilesHashOf(wholeProfiles.present, wholeProfiles.value) === allProfilesSha256 ||
    (wholeProfiles.value.length === 0 &&
      profilesHashOf(!wholeProfiles.present, wholeProfiles.value) === allProfilesSha256);
  if (!wholeProfilesMatch) {
    problems.push("daemon.agentProfiles (whole array)");
  }
  if (canonicalSha256(unrelatedPersistedView(rawJson)) !== unrelatedPersistedSha256) {
    problems.push("unrelated persisted config changed");
  }
  return { match: problems.length === 0, problems };
}

/**
 * Does live config equal the endpoint on the fields the plugin writes — plus
 * daemon.mcp.enabled, which must still equal the plan's recorded effective
 * value (§8.2.6 verifies both MCP flags after patch).
 */
function liveMatchesEndpoint(
  effective: EffectiveView,
  owned: ProjectionValue,
  allProfilesSha256: string,
  expectedEnabled: boolean,
): EndpointMatch {
  const problems: string[] = [];
  if (effective.enabled !== expectedEnabled) {
    problems.push("live mcp.enabled");
  }
  for (const id of OWNED_PROVIDER_IDS) {
    const expected = owned.providers[id];
    const livePresent = Object.hasOwn(effective.providers, id);
    if (expected.present !== livePresent) {
      problems.push(`live providers.${id} presence differs`);
      continue;
    }
    if (expected.present && livePresent && !providerWrittenFieldsEqual(expected.value, effective.providers[id])) {
      problems.push(`live providers.${id}`);
    }
  }
  const liveProfiles = effective.agentProfiles;
  const liveProfilesMatch =
    profilesHashOf(liveProfiles.present, liveProfiles.value) === allProfilesSha256 ||
    (liveProfiles.value.length === 0 &&
      profilesHashOf(!liveProfiles.present, liveProfiles.value) === allProfilesSha256);
  if (!liveProfilesMatch) {
    problems.push("live agentProfiles");
  }
  const expectedInject = owned.injectIntoAgents.present ? owned.injectIntoAgents.value : false;
  if (effective.injectIntoAgents !== expectedInject) {
    problems.push("live mcp.injectIntoAgents");
  }
  return { match: problems.length === 0, problems };
}

export type ObservedClass = "before" | "after" | "divergent" | "partial";

export interface Classification {
  class: ObservedClass;
  problems: string[];
  /** True when disk and live satisfy BOTH endpoints — the plan's before and
   *  after describe the same state (identical-config adoption). Recovery must
   *  verify and finalize the requested endpoint without dispatching a
   *  redundant patch; callers normalize `class` to their direction's target. */
  endpointsEqual: boolean;
}

/**
 * §8.4 classification: before/after require disk and live to agree on the same
 * endpoint; disk on one endpoint with live on the other (or live on neither)
 * is divergent; anything else is partial. When the observed state satisfies
 * both endpoints the plan endpoints are equivalent — reported via
 * endpointsEqual with class 'after' (the forward target is reached).
 */
export function classifyState(
  rawJson: unknown,
  effectiveConfig: unknown,
  plan: PlanValue,
): Classification {
  const effective = effectiveView(effectiveConfig);
  const diskBefore = diskMatchesEndpoint(rawJson, plan.before.owned, plan.before.allProfilesSha256, plan.before.unrelatedPersistedSha256);
  const diskAfter = diskMatchesEndpoint(rawJson, plan.afterOwned, plan.afterAllProfilesSha256, plan.before.unrelatedPersistedSha256);
  const liveBefore = liveMatchesEndpoint(
    effective, plan.before.owned, plan.before.allProfilesSha256, plan.before.effectiveEnabled,
  );
  const liveAfter = liveMatchesEndpoint(
    effective, plan.afterOwned, plan.afterAllProfilesSha256, plan.before.effectiveEnabled,
  );
  if (diskBefore.match && liveBefore.match && diskAfter.match && liveAfter.match) {
    return { class: "after", problems: [], endpointsEqual: true };
  }
  if (diskBefore.match && liveBefore.match) return { class: "before", problems: [], endpointsEqual: false };
  if (diskAfter.match && liveAfter.match) return { class: "after", problems: [], endpointsEqual: false };
  if ((diskBefore.match || diskAfter.match || liveBefore.match || liveAfter.match)) {
    const problems = [
      ...diskBefore.problems.map(p => `disk-before: ${p}`),
      ...diskAfter.problems.map(p => `disk-after: ${p}`),
      ...liveBefore.problems.map(p => `live-before: ${p}`),
      ...liveAfter.problems.map(p => `live-after: ${p}`),
    ];
    return { class: "divergent", problems, endpointsEqual: false };
  }
  const problems = [
    ...diskAfter.problems.map(p => `disk: ${p}`),
    ...liveAfter.problems.map(p => `live: ${p}`),
  ];
  return { class: "partial", problems, endpointsEqual: false };
}

/** Build the single patch object for a plan direction against a fresh raw doc. */
export function patchForDirection(
  plan: PlanValue,
  kind: OperationKindValue,
  direction: "forward" | "inverse",
  freshRawJson: unknown,
): Record<string, unknown> {
  const owned = direction === "forward" ? plan.afterOwned : plan.before.owned;
  const injection = direction === "forward"
    ? (plan.afterOwned.injectIntoAgents.present ? plan.afterOwned.injectIntoAgents.value : false)
    : plan.before.effectiveInjection;
  const baseArray = profilesArray(freshRawJson).value;
  const desiredArray = applyOwnedSlots(baseArray, owned.profiles);
  const providers: Record<string, unknown> = {};
  const removeProviders: string[] = [];
  for (const id of OWNED_PROVIDER_IDS) {
    const presence = owned.providers[id];
    if (presence.present) providers[id] = presence.value;
    else removeProviders.push(id);
  }
  const patch: Record<string, unknown> = { mcp: { injectIntoAgents: injection } };
  if (Object.keys(providers).length > 0) patch.providers = providers;
  if (removeProviders.length > 0) patch.removeProviders = removeProviders;
  patch.agentProfiles = desiredArray;
  void kind;
  return patch;
}

// ---------------------------------------------------------------------------
// Dependent references (collision rule 4 — before removal)
// ---------------------------------------------------------------------------

/** §6 check-before-removal: refuse while foreign profiles or
 *  metadataGeneration entries reference a provider the patch actually
 *  removes. `removedIds` is the patch's removal set — callers derive it the
 *  same way patchForDirection derives removeProviders (endpoint providers
 *  whose presence is absent); the default is the full owned set, which is
 *  what a deactivation removes. A reference to a provider the patch KEEPS
 *  (e.g. an inverse rebind that restores values) is legitimate state. */
export function assertNoDependentReferences(
  rawJson: unknown,
  removedIds: readonly string[] = OWNED_PROVIDER_IDS,
): void {
  const owned = new Set(removedIds);
  const profiles = profilesArray(rawJson);
  profiles.value.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    if (typeof entry.id === "string" && OWNED_PROFILE_IDS.includes(entry.id)) return;
    if (typeof entry.provider === "string" && owned.has(entry.provider)) {
      throw new OperationConflict(
        "DEPENDENT_REFERENCE",
        `agent profile ${entry.id ?? index} references owned provider ${entry.provider}; retarget it before removal`,
        { path: `daemon.agentProfiles[${index}].provider` },
      );
    }
  });
  const metadata = getPath(rawJson, ["agents", "metadataGeneration", "providers"]);
  if (Array.isArray(metadata.value)) {
    metadata.value.forEach((entry, index) => {
      if (isRecord(entry) && typeof entry.provider === "string" && owned.has(entry.provider)) {
        throw new OperationConflict(
          "DEPENDENT_REFERENCE",
          `metadataGeneration provider ${entry.provider} references an owned provider; retarget it before removal`,
          { path: `agents.metadataGeneration.providers[${index}].provider` },
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Collision rules (§8.2.2)
// ---------------------------------------------------------------------------

function legacyProfileConflicts(rawJson: unknown): void {
  const profiles = profilesArray(rawJson);
  profiles.value.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return;
    if (entry.id === "slp-peer" || entry.id.startsWith("slp-peer-")) {
      throw new OperationConflict(
        "COLLISION",
        `legacy SLP peer profile ${entry.id} requires a separately authorized migration`,
        { path: `daemon.agentProfiles[${index}]` },
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Activation / rebind plan (§8.2)
// ---------------------------------------------------------------------------

export interface ActivationPlanArgs {
  raw: RawConfigView;
  effectiveConfig: unknown;
  input: Pick<ActivateRequest, "adoptIdentical" | "initialProfileFamily" | "profiles">;
  previousBinding: BindingValue | null;
  resolution: ExecutableResolution;
  launchSet: LaunchSet;
  /** Settings-driven role routing read from slp-runtime/state/role-routing.json
   *  (Phase 1): drives which supervisor/lead provider combos are generated and
   *  what the owned profiles bind to. null → legacy all-twelve generation. */
  roleRouting: RoleRoutingValue | null;
  /** Candidate identity: freshly materialized result or reused binding assets. */
  candidateSha256: string;
  payloadSha256: string;
  runtimePath: string;
  daemonHome: string;
  now: string;
}

export interface PlanResult {
  plan: PlanValue;
  /** The single config.patch object; null when raw state already equals after. */
  patch: Record<string, unknown> | null;
}

function availableFamilies(resolution: ExecutableResolution): FamilyName[] {
  return FAMILIES.filter(family => resolution.binaries[family]?.available === true);
}

function selectProfileFamily(
  resolution: ExecutableResolution,
  effective: EffectiveView,
  requested: FamilyName | undefined,
): FamilyName {
  const available = availableFamilies(resolution);
  if (requested !== undefined) {
    if (!available.includes(requested)) {
      throw new OperationConflict(
        "EXECUTABLE_UNAVAILABLE",
        `initialProfileFamily ${requested} has no available binary`,
      );
    }
    return requested;
  }
  const enabledBase = FAMILIES.find(
    family => available.includes(family) && effective.providers[family]
      && isRecord(effective.providers[family])
      && (effective.providers[family] as Record<string, unknown>).enabled === true,
  );
  if (enabledBase) return enabledBase;
  if (available.includes("codex")) return "codex";
  throw new OperationConflict(
    "EXECUTABLE_UNAVAILABLE",
    "no explicitly enabled base family is available and codex is unavailable; activation fails rather than picking an arbitrary family",
  );
}

/** Rule for the owned profiles under a binding: values must be valid edits. */
function validateOwnedProfilesForRebind(
  rawJson: unknown,
  resolution: ExecutableResolution,
): ProfileValue[] {
  const available = availableFamilies(resolution);
  const profiles = profilesArray(rawJson);
  const result: ProfileValue[] = [];
  for (const id of OWNED_PROFILE_IDS) {
    const matches = profiles.value.filter(
      entry => isRecord(entry) && entry.id === id,
    );
    if (matches.length !== 1) {
      throw new OperationConflict(
        "OWNERSHIP_DRIFT",
        `owned profile ${id} is missing or duplicated (${matches.length} entries)`,
        { path: "daemon.agentProfiles" },
      );
    }
    const entry = matches[0] as Record<string, unknown>;
    const provider = entry.provider;
    const providerMatch = typeof provider === "string"
      ? OWNED_PROVIDER_ID_RE.exec(provider)
      : null;
    if (
      providerMatch === null ||
      providerMatch[2] !== PROFILE_ROLE[id] ||
      !available.includes(providerMatch[1] as FamilyName)
    ) {
      throw new OperationConflict(
        "OWNERSHIP_DRIFT",
        `owned profile ${id} points at ${String(provider)}; expected an available slp-<family>-${PROFILE_ROLE[id]} provider`,
        { path: `daemon.agentProfiles.${id}` },
      );
    }
    result.push(entry as ProfileValue);
  }
  return result;
}

export function planActivation(args: ActivationPlanArgs): PlanResult {
  const { raw, input, previousBinding, resolution, launchSet } = args;
  const routing = args.roleRouting;
  // Effective provider generation follows the same precedence as the
  // profiles themselves (§5 Phase 1): the routing supplies each role's
  // family, and an explicit `profiles` input family repoint is the later
  // override — which must also generate its provider, since a profile may
  // never bind to a provider this very patch removes.
  const effectiveRouting: RoleRoutingValue | null = routing === null
    ? null
    : {
        ...routing,
        supervisor: { ...routing.supervisor, family: input.profiles?.supervisor?.family ?? routing.supervisor.family },
        lead: { ...routing.lead, family: input.profiles?.lead?.family ?? routing.lead.family },
      };
  const effective = effectiveView(args.effectiveConfig);
  if (effective.enabled !== true) {
    throw new OperationConflict(
      "MCP_DISABLED",
      "daemon.mcp.enabled must be true; enable it outside this transaction",
      { path: "daemon.mcp.enabled" },
    );
  }
  assertPersistedCompatible(raw.json);
  assertRawLiveAgreement(raw.json, effective);
  legacyProfileConflicts(raw.json);
  const before = snapshotFrom(raw, effective, previousBinding ? "OWNERSHIP_DRIFT" : "COLLISION");

  const desiredProviders = desiredProviderEntries(
    launchSet,
    resolution,
    args.runtimePath,
    args.daemonHome,
    effectiveRouting,
  );
  const rawProviders = providersRecord(raw.json);
  const rawProfiles = profilesArray(raw.json);

  let desiredProfiles_: ProfileValue[];
  let baseline: "fresh" | "adopted-observed";

  if (previousBinding) {
    // Rule 2 — exact recorded provider equality; profiles are refreshed from
    // raw after validity checks.
    for (const id of OWNED_PROVIDER_IDS) {
      const expected = previousBinding.owned.providers[id];
      const present = Object.hasOwn(rawProviders, id);
      if (expected.present !== present) {
        throw new OperationConflict(
          "OWNERSHIP_DRIFT",
          `owned provider ${id} ${present ? "appeared" : "disappeared"} outside the journal`,
          { path: `agents.providers.${id}` },
        );
      }
      if (expected.present && present && !canonicalEqual(expected.value, rawProviders[id])) {
        throw new OperationConflict(
          "OWNERSHIP_DRIFT",
          `owned provider ${id} was modified outside the journal`,
          {
            path: `agents.providers.${id}`,
            expectedSha256: canonicalSha256(expected.value),
            actualSha256: canonicalSha256(rawProviders[id]),
          },
        );
      }
    }
    const expectedInject = previousBinding.owned.injectIntoAgents;
    const rawInject = mcpFlagPresence(raw.json, "injectIntoAgents");
    if (
      expectedInject.present !== rawInject.present ||
      (expectedInject.present && rawInject.present && expectedInject.value !== rawInject.value)
    ) {
      throw new OperationConflict(
        "OWNERSHIP_DRIFT",
        "daemon.mcp.injectIntoAgents was modified outside the journal",
        { path: "daemon.mcp.injectIntoAgents" },
      );
    }
    desiredProfiles_ = validateOwnedProfilesForRebind(raw.json, resolution);
    if (routing !== null) {
      // Phase 1: the stored routing repoints each profile at its chosen
      // provider and supplies the fields it sets — applied over the
      // validated live entries, before the explicit `profiles` override.
      // Availability is asserted on the effective families so a `profiles`
      // family override cannot bind a provider whose binary is missing.
      assertRoutingAvailable(resolution, effectiveRouting as RoleRoutingValue);
      desiredProfiles_ = desiredProfiles_.map(entry =>
        applyRoleRouting(
          entry,
          routing[PROFILE_ROLE[entry.id] as "supervisor" | "lead"],
          PROFILE_ROLE[entry.id] as "supervisor" | "lead",
        ),
      );
    }
    if (input.profiles) {
      // Explicit profile edit on an existing binding: apply each role's prefs
      // over the validated live entry. A requested provider family must be
      // available — the plan never points a profile at an unusable provider.
      const available = availableFamilies(resolution);
      for (const role of ["supervisor", "lead"] as const) {
        const family = input.profiles[role]?.family;
        if (family !== undefined && !available.includes(family)) {
          throw new OperationConflict(
            "INVALID_REQUEST",
            `profile ${role}: family ${family} is unavailable; pick an available family`,
            { path: `daemon.agentProfiles.slp-${role}` },
          );
        }
      }
      desiredProfiles_ = desiredProfiles_.map(entry =>
        applyProfilePrefs(
          entry,
          input.profiles?.[PROFILE_ROLE[entry.id] as "supervisor" | "lead"],
          PROFILE_ROLE[entry.id] as "supervisor" | "lead",
        ),
      );
    }
    baseline = previousBinding.baseline;
  } else {
    // Rule 1 — present SLP entries adoptable only with adoptIdentical and
    // exact canonical equality to the generated shape.
    let adoptedAny = false;
    for (const id of OWNED_PROVIDER_IDS) {
      if (!Object.hasOwn(rawProviders, id)) continue;
      adoptedAny = true;
      if (!input.adoptIdentical) {
        throw new OperationConflict(
          "COLLISION",
          `provider ${id} already exists; pass adoptIdentical to adopt identical SLP entries`,
          { path: `agents.providers.${id}` },
        );
      }
      if (!canonicalEqual(rawProviders[id], desiredProviders[id])) {
        throw new OperationConflict(
          "COLLISION",
          `provider ${id} exists with different content; it cannot be adopted`,
          {
            path: `agents.providers.${id}`,
            expectedSha256: canonicalSha256(desiredProviders[id]),
            actualSha256: canonicalSha256(rawProviders[id]),
          },
        );
      }
    }
    if (routing !== null) {
      // Phase 1: routing is the source of truth for the initial binding —
      // the supervisor/lead families come from the stored choice (each must
      // resolve to an available binary), and `initialProfileFamily` no
      // longer applies. `profiles` input still overrides per role; a family
      // override is checked through the effective families so the plan never
      // binds a provider whose binary is missing.
      assertRoutingAvailable(resolution, effectiveRouting as RoleRoutingValue);
      desiredProfiles_ = desiredProfiles(routing.supervisor.family, input.profiles, routing);
    } else {
      const family = selectProfileFamily(resolution, effective, input.initialProfileFamily);
      desiredProfiles_ = desiredProfiles(family, input.profiles);
    }
    for (const wanted of desiredProfiles_) {
      const existing = rawProfiles.value.filter(
        entry => isRecord(entry) && entry.id === wanted.id,
      );
      if (existing.length === 0) continue;
      adoptedAny = true;
      if (existing.length > 1) {
        throw new OperationConflict(
          "COLLISION",
          `duplicate profile ${wanted.id} cannot be adopted`,
          { path: "daemon.agentProfiles" },
        );
      }
      if (!input.adoptIdentical) {
        throw new OperationConflict(
          "COLLISION",
          `profile ${wanted.id} already exists; pass adoptIdentical to adopt identical SLP entries`,
          { path: "daemon.agentProfiles" },
        );
      }
      if (!canonicalEqual(existing[0], wanted)) {
        throw new OperationConflict(
          "COLLISION",
          `profile ${wanted.id} exists with different content; it cannot be adopted`,
          {
            path: "daemon.agentProfiles",
            expectedSha256: canonicalSha256(wanted),
            actualSha256: canonicalSha256(existing[0]),
          },
        );
      }
    }
    baseline = adoptedAny ? "adopted-observed" : "fresh";
  }

  const slots = computeSlots(rawProfiles.value, desiredProfiles_);
  const desiredArray = applyOwnedSlots(rawProfiles.value, slots);
  const afterOwned: ProjectionValue = {
    // The projection still covers the full twelve-id ownership set; under a
    // routing the non-chosen combos record present:false, which the patch
    // turns into a removal and the endpoint matchers treat as absent.
    providers: Object.fromEntries(
      OWNED_PROVIDER_IDS.map(id => [
        id,
        desiredProviders[id] !== undefined
          ? { present: true as const, value: desiredProviders[id] }
          : { present: false as const },
      ]),
    ),
    profilesPresent: true,
    profiles: slots,
    injectIntoAgents: { present: true, value: true },
  };
  const afterOwnedSha256 = canonicalSha256(afterOwned);
  // The patch always writes agentProfiles explicitly → the after endpoint's
  // raw key presence is true even for an empty array.
  const afterAllProfilesSha256 = profilesHashOf(true, desiredArray);

  // The patch is needed unless raw state already equals the after endpoint.
  const alreadyThere = diskMatchesEndpoint(
    raw.json, afterOwned, afterAllProfilesSha256, before.unrelatedPersistedSha256,
  ).match && effective.injectIntoAgents === true;
  // Owned ids the generation did not emit are removed by this patch. The §6
  // check-before-removal guard applies to exactly that set: a foreign profile
  // or metadataGeneration entry referencing a non-chosen provider would be
  // stranded by a routing-driven removal, so the plan refuses first.
  const removedProviderIds = OWNED_PROVIDER_IDS.filter(id => desiredProviders[id] === undefined);
  if (removedProviderIds.length > 0 && !alreadyThere) {
    assertNoDependentReferences(raw.json, removedProviderIds);
  }
  const patch = alreadyThere
    ? null
    : {
        providers: desiredProviders,
        ...(removedProviderIds.length > 0 ? { removeProviders: removedProviderIds } : {}),
        agentProfiles: desiredArray,
        mcp: { injectIntoAgents: true },
      };

  const mcpBefore = previousBinding?.mcpBefore ?? {
    enabled: {
      raw: (() => {
        const p = mcpFlagPresence(raw.json, "enabled");
        return p.present ? { present: true as const, value: p.value === true } : { present: false as const };
      })(),
      effective: effective.enabled,
    },
    injectIntoAgents: {
      raw: (() => {
        const p = mcpFlagPresence(raw.json, "injectIntoAgents");
        return p.present ? { present: true as const, value: p.value === true } : { present: false as const };
      })(),
      effective: effective.injectIntoAgents,
    },
  };
  const beforeActivation = previousBinding?.beforeActivation ?? before;

  const nextBinding: BindingValue = {
    bindingSha256: canonicalSha256({
      candidateSha256: args.candidateSha256,
      payloadSha256: args.payloadSha256,
      launchSetSha256: launchSet.launchSetSha256,
      owned: afterOwned,
    }),
    candidateSha256: args.candidateSha256,
    payloadSha256: args.payloadSha256,
    runtimePath: args.runtimePath,
    launchSetSha256: launchSet.launchSetSha256,
    launchManifestSha256: launchSet.launchManifestSha256,
    launcherFiles: launchSet.files,
    node: resolution.node,
    binaries: resolution.binaries,
    baseline,
    beforeActivation,
    mcpBefore,
    owned: afterOwned,
    postPatchPersistedShapeSha256: afterOwnedSha256,
    activatedAt: args.now,
    verifiedAt: args.now,
  };

  const plan: PlanValue = {
    before,
    afterOwned,
    afterOwnedSha256,
    afterAllProfilesSha256,
    previousBinding,
    nextBinding,
    restoreInjectionTo: before.effectiveInjection,
  };
  return { plan, patch };
}

// ---------------------------------------------------------------------------
// Deactivation plan (§8.3)
// ---------------------------------------------------------------------------

export interface DeactivationPlanArgs {
  raw: RawConfigView;
  effectiveConfig: unknown;
  binding: BindingValue;
}

export function planDeactivation(args: DeactivationPlanArgs): PlanResult {
  const { raw, binding } = args;
  const effective = effectiveView(args.effectiveConfig);
  if (effective.enabled !== true) {
    throw new OperationConflict(
      "MCP_DISABLED",
      "daemon.mcp.enabled changed since activation; restore it before deactivating",
      { path: "daemon.mcp.enabled" },
    );
  }
  assertPersistedCompatible(raw.json);
  assertRawLiveAgreement(raw.json, effective, { includeMetadataGeneration: true });
  const before = snapshotFrom(raw, effective, "OWNERSHIP_DRIFT");

  // Exact receipt equality for every owned entry.
  const rawProviders = providersRecord(raw.json);
  for (const id of OWNED_PROVIDER_IDS) {
    const expected = binding.owned.providers[id];
    const present = Object.hasOwn(rawProviders, id);
    if (expected.present !== present) {
      throw new OperationConflict(
        "OWNERSHIP_DRIFT",
        `owned provider ${id} ${present ? "appeared" : "disappeared"} outside the journal; reconcile first`,
        { path: `agents.providers.${id}` },
      );
    }
    if (expected.present && present && !canonicalEqual(expected.value, rawProviders[id])) {
      throw new OperationConflict(
        "OWNERSHIP_DRIFT",
        `owned provider ${id} was modified outside the journal; reconcile first`,
        {
          path: `agents.providers.${id}`,
          expectedSha256: canonicalSha256(expected.value),
          actualSha256: canonicalSha256(rawProviders[id]),
        },
      );
    }
  }
  const observed = extractProjection(raw.json, "OWNERSHIP_DRIFT");
  if (observed.profiles.length !== binding.owned.profiles.length) {
    throw new OperationConflict("OWNERSHIP_DRIFT", "owned profile set changed; reconcile first", {
      path: "daemon.agentProfiles",
    });
  }
  for (let i = 0; i < binding.owned.profiles.length; i += 1) {
    const expected = binding.owned.profiles[i];
    const actual = observed.profiles[i];
    if (expected.index !== actual.index || !canonicalEqual(expected.value, actual.value)) {
      throw new OperationConflict(
        "OWNERSHIP_DRIFT",
        `owned profile ${binding.owned.profiles[i].value.id} was modified outside the journal; reconcile first`,
        { path: `daemon.agentProfiles[${actual.index}]` },
      );
    }
  }
  const expectedInject = binding.owned.injectIntoAgents;
  const rawInject = mcpFlagPresence(raw.json, "injectIntoAgents");
  if (
    expectedInject.present !== rawInject.present ||
    (expectedInject.present && rawInject.present && expectedInject.value !== rawInject.value)
  ) {
    throw new OperationConflict(
      "OWNERSHIP_DRIFT",
      "daemon.mcp.injectIntoAgents was modified outside the journal; reconcile first",
      { path: "daemon.mcp.injectIntoAgents" },
    );
  }
  assertNoDependentReferences(raw.json);

  const desiredArray = rawProfilesFiltered(raw.json);
  const restoreTo = binding.mcpBefore.injectIntoAgents.effective;
  const afterOwned: ProjectionValue = {
    providers: Object.fromEntries(
      OWNED_PROVIDER_IDS.map(id => [id, { present: false as const }]),
    ),
    // Raw key presence: the inverse patch writes agentProfiles explicitly, so
    // the key is present after the endpoint even when the remaining array is
    // empty (the absent≡[] equivalence only applies at §8.3 compare sites).
    profilesPresent: true,
    profiles: [],
    injectIntoAgents: { present: true, value: restoreTo },
  };
  const afterOwnedSha256 = canonicalSha256(afterOwned);
  const afterAllProfilesSha256 = profilesHashOf(true, desiredArray);

  const alreadyThere = diskMatchesEndpoint(
    raw.json, afterOwned, afterAllProfilesSha256, before.unrelatedPersistedSha256,
  ).match && effective.injectIntoAgents === restoreTo;
  const patch = alreadyThere
    ? null
    : {
        removeProviders: [...OWNED_PROVIDER_IDS],
        agentProfiles: desiredArray,
        mcp: { injectIntoAgents: restoreTo },
      };

  const plan: PlanValue = {
    before,
    afterOwned,
    afterOwnedSha256,
    afterAllProfilesSha256,
    previousBinding: binding,
    nextBinding: null,
    restoreInjectionTo: restoreTo,
  };
  return { plan, patch };
}

function rawProfilesFiltered(rawJson: unknown): unknown[] {
  return profilesArray(rawJson).value.filter(
    entry => !(isRecord(entry) && typeof entry.id === "string" && OWNED_PROFILE_IDS.includes(entry.id)),
  );
}
