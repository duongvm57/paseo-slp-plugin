// plugin/server/config-view.ts — lossless raw/effective config views (§8.1).
//
// Raw reads go straight to <home>/config.json with read-only filesystem APIs
// and Object.hasOwn presence semantics — never through the host's
// loadPersistedConfig, which would create/rewrite the file. Effective views
// read the connected `config.get()` shape. This module also owns the
// canonical-JSON hashing the receipt hashes are defined over (§7): recursive
// key sort, array order preserved, compact JSON plus one newline, non-JSON
// values rejected.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import {
  PersistedProvider,
  Profile,
  OperationConflict,
  type ConflictCode,
  type ProjectionValue,
  type SnapshotValue,
} from "../shared/contracts.ts";

// Domain constants derive from the shared family registry
// (../shared/runtime/families.ts) — the plugin bundle may not import ../src/*.mjs
// across the plugin boundary (§2), and there is no second literal family
// list. The historical export names stay so consumers keep one import site.
import {
  FAMILY_IDS,
  OWNED_PROVIDER_ID_RE,
  OWNED_PROVIDER_IDS,
  PROVIDER_EXTENDS,
  ROLES,
  persistedProviderIds,
  type FamilyId,
  type RoleName,
} from "../shared/runtime/families.ts";
export { OWNED_PROVIDER_IDS, PROVIDER_EXTENDS, ROLES };
export const FAMILIES = FAMILY_IDS;
/** Historical keys are an ownership boundary, not implicit false slots. */
export function projectionProviderIds(projection: ProjectionValue): readonly string[] {
  const ids = persistedProviderIds(Object.keys(projection.providers));
  if (ids === null) throw new Error("projection requires exact legacy12 or current15 provider keys");
  return ids;
}
export type FamilyName = FamilyId;
export type { RoleName };

export const OWNED_PROFILE_IDS = ["slp-supervisor", "slp-lead"];
export const ROLE_DISPLAY: Record<RoleName, string> = {
  supervisor: "Supervisor",
  lead: "Lead",
  peer: "Peer",
};

export function providerExtendsForId(id: string): string | null {
  const match = OWNED_PROVIDER_ID_RE.exec(id);
  return match ? PROVIDER_EXTENDS[match[1] as FamilyName] : null;
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing (§7)
// ---------------------------------------------------------------------------

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) throw new Error(`canonical JSON rejects undefined at key ${key}`);
      out[key] = canonicalValue(child);
    }
    return out;
  }
  throw new Error(`canonical JSON rejects value of type ${typeof value}`);
}

/** Compact canonical serialization: recursively sorted keys, trailing "\n". */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) + "\n";
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalEqual(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Presence helpers — Object.hasOwn semantics, no prototype walks
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PresenceOf<T> {
  present: boolean;
  value: T | undefined;
}

export function getPath(value: unknown, segments: string[]): PresenceOf<unknown> {
  let current = value;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return { present: false, value: undefined };
    }
    current = current[segment];
  }
  return { present: true, value: current };
}

export function getKey(value: unknown, key: string): PresenceOf<unknown> {
  return getPath(value, [key]);
}

// ---------------------------------------------------------------------------
// Raw config read — original bytes retained, no host loader
// ---------------------------------------------------------------------------

export interface RawConfigView {
  path: string;
  /** Original file bytes, formatting included — rawConfigSha256 hashes this. */
  bytes: Uint8Array;
  json: unknown;
}

export function readRawConfig(configPath: string): RawConfigView {
  const stat = lstatSync(configPath); // throws ENOENT — caller maps to HOME_UNVERIFIED/IO_FAILURE
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new OperationConflict("HOME_UNVERIFIED", "config.json is not a regular file", {
      path: configPath,
    });
  }
  const bytes = readFileSync(configPath);
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    // V8 parse messages quote raw input fragments — a config may carry
    // secrets, so only the byte position (never the bytes) may surface.
    const position = /position (\d+)/.exec((error as Error).message)?.[1];
    throw new OperationConflict(
      "SCHEMA_LOSS",
      `config.json is not valid JSON${position ? ` (at position ${position})` : ""}; persisted-schema validation cannot run`,
      { path: configPath },
    );
  }
  return { path: configPath, bytes, json };
}

// ---------------------------------------------------------------------------
// Projection extraction — the owned slice of a raw config (§7)
// ---------------------------------------------------------------------------

export function providersRecord(rawJson: unknown): Record<string, unknown> {
  const agents = getKey(rawJson, "agents");
  const providers = getKey(agents.value, "providers");
  return isRecord(providers.value) ? (providers.value as Record<string, unknown>) : {};
}

export function providersPresent(rawJson: unknown): boolean {
  return getPath(rawJson, ["agents", "providers"]).present;
}

export function profilesArray(rawJson: unknown): { present: boolean; value: unknown[] } {
  const found = getPath(rawJson, ["daemon", "agentProfiles"]);
  return { present: found.present, value: Array.isArray(found.value) ? found.value : [] };
}

export function mcpFlagPresence(rawJson: unknown, key: "enabled" | "injectIntoAgents") {
  const found = getPath(rawJson, ["daemon", "mcp", key]);
  if (!found.present) return { present: false as const };
  return { present: true as const, value: found.value };
}

/**
 * Extract the owned projection from raw JSON. Present entries must satisfy the
 * owned persisted shapes (OwnedProvider / Profile); anything else is a
 * collision or drift — the caller picks the conflict code.
 */
export function extractProjection(rawJson: unknown, code: ConflictCode, ids: readonly string[] = OWNED_PROVIDER_IDS): ProjectionValue {
  if (persistedProviderIds(ids) === null) throw new Error("unknown projection domain");
  const providers = providersRecord(rawJson);
  const projectedProviders: ProjectionValue["providers"] = {};
  for (const id of ids) {
    if (!Object.hasOwn(providers, id)) {
      projectedProviders[id] = { present: false };
      continue;
    }
    const parsed = PersistedProvider.safeParse(providers[id]);
    if (!parsed.success) {
      throw new OperationConflict(
        code,
        `owned provider ${id} does not match the SLP persisted shape`,
        { path: `agents.providers.${id}` },
      );
    }
    // Validation is read-only: preserve the raw field order and values.
    projectedProviders[id] = { present: true, value: providers[id] as typeof parsed.data };
  }
  const profiles = profilesArray(rawJson);
  const slots: ProjectionValue["profiles"] = [];
  const seen = new Set<string>();
  profiles.value.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !OWNED_PROFILE_IDS.includes(entry.id)) {
      return;
    }
    if (seen.has(entry.id)) {
      throw new OperationConflict(code, `duplicate owned profile ${entry.id}`, {
        path: `daemon.agentProfiles[${index}]`,
      });
    }
    seen.add(entry.id);
    const parsed = Profile.safeParse(entry);
    if (!parsed.success) {
      throw new OperationConflict(code, `owned profile ${entry.id} is not schema-valid`, {
        path: `daemon.agentProfiles[${index}]`,
      });
    }
    slots.push({ index, value: parsed.data });
  });
  const injection = mcpFlagPresence(rawJson, "injectIntoAgents");
  if (injection.present && typeof injection.value !== "boolean") {
    throw new OperationConflict(code, "daemon.mcp.injectIntoAgents is not a boolean", {
      path: "daemon.mcp.injectIntoAgents",
    });
  }
  return {
    providers: projectedProviders,
    // Raw key presence — an explicit [] records true; the absent≡empty
    // equivalence exists only at §8.3 comparison sites, never in the receipt.
    profilesPresent: profiles.present,
    profiles: slots.sort((a, b) => a.index - b.index),
    injectIntoAgents: injection.present
      ? { present: true, value: injection.value as boolean }
      : { present: false },
  };
}

/**
 * Raw JSON minus the registry-owned providers, the two owned profiles and
 * daemon.mcp.injectIntoAgents, with empty containers normalized away (§7):
 * missing/empty agents.providers and daemon.agentProfiles compare equal, and
 * empty agents / daemon.mcp / daemon containers are pruned so intentional
 * container creation does not masquerade as unrelated drift.
 */
export function unrelatedPersistedView(rawJson: unknown, ids: readonly string[] = OWNED_PROVIDER_IDS): unknown {
  if (persistedProviderIds(ids) === null) throw new Error("unknown projection domain");
  if (!isRecord(rawJson)) return rawJson;
  const clone = structuredClone(rawJson);
  const agents = getKey(clone, "agents");
  if (isRecord(agents.value)) {
    const providers = getKey(agents.value, "providers");
    if (isRecord(providers.value)) {
      for (const id of ids) delete providers.value[id];
      if (Object.keys(providers.value).length === 0) delete agents.value.providers;
    }
    if (Object.keys(agents.value).length === 0) delete clone.agents;
  }
  const daemon = getKey(clone, "daemon");
  if (isRecord(daemon.value)) {
    const profiles = getKey(daemon.value, "agentProfiles");
    if (Array.isArray(profiles.value)) {
      const kept = profiles.value.filter(
        entry => !(isRecord(entry) && typeof entry.id === "string" && OWNED_PROFILE_IDS.includes(entry.id)),
      );
      if (kept.length === 0) delete daemon.value.agentProfiles;
      else daemon.value.agentProfiles = kept;
    } else {
      delete daemon.value.agentProfiles;
    }
    const mcp = getKey(daemon.value, "mcp");
    if (isRecord(mcp.value)) {
      delete mcp.value.injectIntoAgents;
      if (Object.keys(mcp.value).length === 0) delete daemon.value.mcp;
    }
    if (Object.keys(daemon.value).length === 0) delete clone.daemon;
  }
  return clone;
}

/** Canonical hash of a profile array PLUS its raw key presence — §7 format:
 *  absent hashes `{present:false}`, present hashes `{present:true,value}`,
 *  so absent and present-but-empty hash distinctly (recorded truth). The
 *  absent≡empty equivalence is applied by callers only at §8.3 comparison
 *  sites. */
export function profilesHashOf(present: boolean, value: unknown[]): string {
  return canonicalSha256(present ? { present: true, value } : { present: false });
}

export function allProfilesHash(rawJson: unknown): string {
  const profiles = profilesArray(rawJson);
  return profilesHashOf(profiles.present, profiles.value);
}

// ---------------------------------------------------------------------------
// Effective view — the connected config.get() shape (mutable config)
// ---------------------------------------------------------------------------

export interface EffectiveView {
  /** resolved daemon.mcp.enabled (pinned host default: true). */
  enabled: boolean;
  /** resolved daemon.mcp.injectIntoAgents (pinned host default: false). */
  injectIntoAgents: boolean;
  providers: Record<string, unknown>;
  agentProfiles: { present: boolean; value: unknown[] };
  metadataProviders: unknown[];
}

export function effectiveView(config: unknown): EffectiveView {
  const enabled = getPath(config, ["mcp", "enabled"]);
  const inject = getPath(config, ["mcp", "injectIntoAgents"]);
  const providers = getKey(config, "providers");
  const profiles = getKey(config, "agentProfiles");
  const metadata = getPath(config, ["metadataGeneration", "providers"]);
  return {
    enabled: enabled.value === true,
    injectIntoAgents: inject.value === true,
    providers: isRecord(providers.value) ? providers.value : {},
    agentProfiles: {
      present: profiles.present,
      value: Array.isArray(profiles.value) ? profiles.value : [],
    },
    metadataProviders: Array.isArray(metadata.value) ? metadata.value : [],
  };
}

/** The six fields this plugin writes on a provider entry (§8.1). */
const WRITTEN_PROVIDER_FIELDS = ["extends", "label", "command", "env", "enabled", "paseoTools"] as const;

export function providerWrittenFieldsEqual(rawEntry: unknown, liveEntry: unknown): boolean {
  for (const field of WRITTEN_PROVIDER_FIELDS) {
    const rawField = getKey(rawEntry, field);
    const liveField = getKey(liveEntry, field);
    if (rawField.present !== liveField.present) return false;
    if (rawField.present && !canonicalEqual(rawField.value, liveField.value)) return false;
  }
  return true;
}

/**
 * §8.1 agreement check: raw MCP flag presence vs resolved defaults, owned
 * provider written fields, and the full profile array must agree with live
 * state. Throws RAW_LIVE_DIVERGENCE listing the divergent paths.
 */
export function assertRawLiveAgreement(
  rawJson: unknown,
  effective: EffectiveView,
  options: { includeMetadataGeneration?: boolean } = {},
): void {
  const divergent: string[] = [];
  const rawEnabled = mcpFlagPresence(rawJson, "enabled");
  const expectedEnabled = rawEnabled.present ? rawEnabled.value === true : true;
  if (effective.enabled !== expectedEnabled) divergent.push("daemon.mcp.enabled");
  const rawInject = mcpFlagPresence(rawJson, "injectIntoAgents");
  const expectedInject = rawInject.present ? rawInject.value === true : false;
  if (effective.injectIntoAgents !== expectedInject) {
    divergent.push("daemon.mcp.injectIntoAgents");
  }
  const rawProviders = providersRecord(rawJson);
  for (const id of OWNED_PROVIDER_IDS) {
    const rawPresent = Object.hasOwn(rawProviders, id);
    const livePresent = Object.hasOwn(effective.providers, id);
    if (rawPresent !== livePresent) {
      divergent.push(`agents.providers.${id} (raw ${rawPresent ? "present" : "absent"}, live ${livePresent ? "present" : "absent"})`);
      continue;
    }
    if (rawPresent && !providerWrittenFieldsEqual(rawProviders[id], effective.providers[id])) {
      divergent.push(`agents.providers.${id}`);
    }
  }
  const rawProfiles = profilesArray(rawJson);
  // Absent ≡ empty (§7): presence alone never counts as divergence.
  if (!canonicalEqual(rawProfiles.value, effective.agentProfiles.value)) {
    divergent.push("daemon.agentProfiles");
  }
  if (options.includeMetadataGeneration) {
    const rawMetadata = getPath(rawJson, ["agents", "metadataGeneration", "providers"]);
    const rawList = Array.isArray(rawMetadata.value) ? rawMetadata.value : [];
    if (!canonicalEqual(rawList, effective.metadataProviders)) {
      divergent.push("agents.metadataGeneration.providers");
    }
  }
  if (divergent.length > 0) {
    const shown = divergent.slice(0, 8).join(", ");
    const rest = divergent.length > 8 ? ` (+${divergent.length - 8} more)` : "";
    throw new OperationConflict(
      "RAW_LIVE_DIVERGENCE",
      `raw persisted config and live config disagree at: ${shown}${rest}; an administrator must resolve overrides or reload outside this transaction`,
      { path: divergent[0].split(" ")[0] },
    );
  }
}

/**
 * §8.2.4 metadataGeneration-scoped agreement: the plugin never writes
 * agents.metadataGeneration.providers, so raw/live divergence there is never
 * resolvable by a config.patch — unlike owned fields mid-recovery, where
 * disk and live may legitimately sit on different endpoints. Removal paths
 * (normal deactivation via assertRawLiveAgreement, and recovery-time
 * removal) must refuse before the host's implicit filtering silently drops
 * unapproved live references.
 */
export function assertMetadataGenerationAgreement(
  rawJson: unknown,
  effective: EffectiveView,
): void {
  const rawMetadata = getPath(rawJson, ["agents", "metadataGeneration", "providers"]);
  const rawList = Array.isArray(rawMetadata.value) ? rawMetadata.value : [];
  if (!canonicalEqual(rawList, effective.metadataProviders)) {
    throw new OperationConflict(
      "RAW_LIVE_DIVERGENCE",
      "agents.metadataGeneration.providers diverges between raw and live config; an administrator must resolve overrides or reload outside this transaction",
      { path: "agents.metadataGeneration.providers" },
    );
  }
}

/** Assemble a §7 Snapshot from a raw view plus the live effective flags. */
export function snapshotFrom(
  raw: RawConfigView,
  effective: EffectiveView,
  code: ConflictCode,
): SnapshotValue {
  const owned = extractProjection(raw.json, code);
  return {
    rawConfigSha256: sha256Hex(raw.bytes),
    owned,
    ownedSha256: canonicalSha256(owned),
    allProfilesSha256: allProfilesHash(raw.json),
    unrelatedPersistedSha256: canonicalSha256(unrelatedPersistedView(raw.json)),
    effectiveEnabled: effective.enabled,
    effectiveInjection: effective.injectIntoAgents,
  };
}
