// plugin/server/supervision/state.ts — private supervision.json store
// (spec docs/spec/supervision-integration.md §Configuration and authority).
// Daemon defaults for discovered SLP Leads plus explicit per-Lead routes,
// raw-file SHA-256 CAS on every write, atomic 0600 writes through the shared
// writePrivate helper, and a served-home binding: the file lives only under
// the daemon home THIS plugin process serves — the client-supplied
// target/local-target value is a prefill, not proof of host-home mapping.
//
// Same class of operation as jev: plugin-owned file under
// <stableRoot>/state, no journal, no mutex, no authority gate. An absent
// file is "not configured" (empty defaults-off config, no error); an invalid
// or unreadable file is off with a visible error — never an empty config the
// UI could present as a successful save. A schema-1 file reads as a
// migration view with every route off (normalizeSupervisionFile) and is only
// rewritten, as schema 2, by an explicit save.
//
// Every writer — the Manager card and the bell's disable-notifications
// action — goes through commit(): one CAS token read, awaited agent
// validation, token recheck, atomic write.
import { readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { OperationConflict } from "../../shared/contracts.ts";
import {
  DisableSupervisionNotificationsInput,
  GetSupervisionInput,
  SetSupervisionInput,
  SupervisionStatusInput,
  emptySupervisionConfig,
  isActiveAgentStatus,
  isSlpLead,
  isSlpSupervisor,
  normalizeSupervisionFile,
  notifyRecipients,
  withoutNotify,
} from "../../shared/supervision.ts";
import type {
  GetSupervisionResult,
  SupervisionConfig,
  SupervisionMigration,
  SupervisionStatusResult,
  SupervisionUnverified,
} from "../../shared/supervision.ts";
import { sha256Hex } from "../config-view.ts";
import { detectDaemonHome, resolveDaemonHome } from "../daemon-home.ts";
import { writePrivate } from "../state-store.ts";

export const SUPERVISION_FILE = join("state", "supervision.json");
export const supervisionPath = (stableRoot: string): string => join(stableRoot, SUPERVISION_FILE);

const invalid = (rpc: string, error: { issues: { message: string }[] }): OperationConflict =>
  new OperationConflict("INVALID_REQUEST", `invalid ${rpc} input: ${error.issues[0]?.message ?? "schema"}`);

export interface SupervisionFileRead {
  config: SupervisionConfig | null;
  sha256: string | null;
  migration: SupervisionMigration | null;
  error: string | null;
}

// Reads the raw file once. sha256 is the CAS token over the raw bytes
// (present even for a broken file so a stale client can overwrite it under
// CAS).
export function readSupervisionFile(file: string): SupervisionFileRead {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: emptySupervisionConfig(), sha256: null, migration: null, error: null };
    }
    // Unreadable is evidence, same class as corrupt — off with a visible
    // error, never an empty config (spec §Configuration).
    return { config: null, sha256: null, migration: null, error: `supervision.json is not readable: ${(error as Error).message}` };
  }
  const sha256 = sha256Hex(raw);
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    return { config: null, sha256, migration: null, error: `supervision.json is not valid JSON: ${(error as Error).message}` };
  }
  const normalized = normalizeSupervisionFile(json);
  if (!normalized.ok) return { config: null, sha256, migration: null, error: normalized.error };
  return { config: normalized.config, sha256, migration: normalized.migration, error: null };
}

type ServedHome = () => { daemonHome: string; source: "env" | "default" };

// The refresh surface the validator needs — a structural subset of PaseoApi
// so tests can double it without the daemon.
type PaseoLike = {
  agents: { ref(id: string): { refresh(): Promise<{ agent: unknown } | null> } };
};
type AgentSnapshot = { provider?: unknown; archivedAt?: unknown; workspaceId?: unknown; status?: unknown };

// Refresh a single agent through the connected SDK. A snapshot is checked
// exactly; no snapshot (the SDK returned nothing or threw) is NOT a verdict:
// live evidence showed the plugin session can be refused a live SLP agent
// ("Agent not found", tests/fixtures/supervision/README.md row 15), so the
// save proceeds with the agent recorded as unverified and the observer
// activates the route only on host evidence (effectiveRoute).
type Refreshed = { agent: AgentSnapshot } | { agent: null; reason: string };
async function refreshAgent(paseo: PaseoLike, agentId: string): Promise<Refreshed> {
  try {
    const result = await paseo.agents.ref(agentId).refresh();
    const agent = (result?.agent ?? null) as AgentSnapshot | null;
    return agent === null ? { agent: null, reason: "the host returned no agent for this id" } : { agent };
  } catch (error) {
    return { agent: null, reason: `refresh failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
  }
}

const SERVED_GAP =
  "cannot verify the selected target is the daemon home this plugin serves — the daemon did not export PASEO_HOME to the plugin process, so its own home is only a default guess (host capability gap, tests/fixtures/supervision/README.md row 4); supervision state stays untouched";

export function createSupervisionState(deps: {
  servedHome?: ServedHome;
  uuid?: () => string;
  /** Live observer readout for the served home — the observer injects it
   *  at registration; null when no observer runs (tests, a disabled build).
   *  Metadata only — never bodies or keys. */
  shadow?: (stableRoot: string) => {
    observations: GetSupervisionResult["observations"];
    gates: GetSupervisionResult["gates"];
    diagnostics: GetSupervisionResult["diagnostics"];
  } | null;
} = {}) {
  const servedHome = deps.servedHome ?? detectDaemonHome;
  const uuid = deps.uuid ?? randomUUID;

  // Binds the state file to the daemon home this plugin process actually
  // serves. The daemon exports PASEO_HOME when it has one; without it the
  // process's home is a platform-default guess and a UI-selected target can
  // only be verified when it realpath-matches the exported home. A mismatch
  // or missing env is a host capability gap — refuse rather than read or
  // write another daemon home's files.
  function servedBinding(target: { hostId: string; daemonHome: string }): { stableRoot: string; error: string | null } {
    const resolved = resolveDaemonHome(target, "daemon home lacks a readable regular config.json");
    const served = servedHome();
    if (served.source !== "env") return { stableRoot: resolved.stableRoot, error: SERVED_GAP };
    let servedReal: string | null = null;
    try {
      servedReal = realpathSync(served.daemonHome);
    } catch {
      servedReal = null;
    }
    if (servedReal === null || servedReal !== resolved.canonicalHome) {
      return {
        stableRoot: resolved.stableRoot,
        error: `selected target ${resolved.canonicalHome} is not the daemon home this plugin serves (${servedReal ?? "unresolvable"}) — supervision state binds to the served home only`,
      };
    }
    return { stableRoot: resolved.stableRoot, error: null };
  }

  // The served home itself — the bell actions carry no target.
  function servedRoot(): { stableRoot: string | null; error: string | null } {
    const served = servedHome();
    if (served.source !== "env") return { stableRoot: null, error: SERVED_GAP };
    try {
      const resolved = resolveDaemonHome({ hostId: "local", daemonHome: served.daemonHome }, "daemon home lacks a readable regular config.json");
      return { stableRoot: resolved.stableRoot, error: null };
    } catch (error) {
      return { stableRoot: null, error: `served daemon home is not usable: ${(error as Error).message}` };
    }
  }

  // A snapshot is checked exactly; its workspace is server-derived. Without
  // a snapshot the agent is recorded unverified and the client-supplied
  // workspace (from the Manager's agent picker) is kept.
  async function checkSupervisor(
    paseo: PaseoLike,
    agentId: string,
    label: string,
    clientWorkspace: string | null,
    unverified: SupervisionUnverified[],
  ): Promise<string | null> {
    const refreshed = await refreshAgent(paseo, agentId);
    if (refreshed.agent === null) {
      unverified.push({ agentId, role: "supervisor", reason: refreshed.reason });
      return clientWorkspace;
    }
    const agent = refreshed.agent;
    if (!isSlpSupervisor(agent.provider)) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `${label} ${agentId} has provider ${JSON.stringify(agent.provider)} — a recipient must be an exact slp-<family>-supervisor provider`,
      );
    }
    if (agent.archivedAt != null) throw new OperationConflict("INVALID_REQUEST", `${label} ${agentId} is archived`);
    if (!isActiveAgentStatus(agent.status)) {
      throw new OperationConflict("INVALID_REQUEST", `${label} ${agentId} is ${JSON.stringify(agent.status)} — a recipient must be an active agent`);
    }
    if (typeof agent.workspaceId !== "string" || agent.workspaceId === "") {
      throw new OperationConflict("INVALID_REQUEST", `${label} ${agentId} has no workspace — cannot place its notification controls`);
    }
    return agent.workspaceId;
  }

  // Exact validation through the connected SDK, returning the config with
  // server-derived fields filled plus the agents that could not be
  // refreshed. A returned snapshot must match exactly: explicit routes need
  // an active exact Lead in the declared workspace; a named Supervisor must
  // be an active exact Supervisor (any workspace — its own workspace places
  // the bell). With defaults off an unchanged default recipient keeps its
  // recorded workspace. No fallback recipient, no inference from
  // title/cwd/workspace.
  async function validateConfig(
    paseo: PaseoLike,
    config: SupervisionConfig,
    stored: SupervisionConfig | null,
  ): Promise<{ config: SupervisionConfig; unverified: SupervisionUnverified[] }> {
    const unverified: SupervisionUnverified[] = [];
    const seen = new Set<string>();
    const routes: SupervisionConfig["routes"] = [];
    for (const route of config.routes) {
      if (seen.has(route.leadAgentId)) {
        throw new OperationConflict("INVALID_REQUEST", `duplicate leadAgentId ${route.leadAgentId} — one route per Lead`);
      }
      seen.add(route.leadAgentId);
      if (route.mode === "off") { routes.push(route); continue; } // inert route — no liveness required
      const refreshed = await refreshAgent(paseo, route.leadAgentId);
      if (refreshed.agent === null) {
        unverified.push({ agentId: route.leadAgentId, role: "lead", reason: refreshed.reason });
      } else {
        const lead = refreshed.agent;
        if (!isSlpLead(lead.provider)) {
          throw new OperationConflict(
            "INVALID_REQUEST",
            `Lead ${route.leadAgentId} has provider ${JSON.stringify(lead.provider)} — routes require an exact slp-<family>-lead provider`,
          );
        }
        if (lead.archivedAt != null) {
          throw new OperationConflict("INVALID_REQUEST", `Lead ${route.leadAgentId} is archived — archived agents cannot carry a supervision route`);
        }
        if (lead.status === "closed") {
          throw new OperationConflict("INVALID_REQUEST", `Lead ${route.leadAgentId} is closed — routes require an active agent`);
        }
        if (lead.workspaceId !== route.leadWorkspaceId) {
          throw new OperationConflict(
            "INVALID_REQUEST",
            `Lead ${route.leadAgentId} is in workspace ${JSON.stringify(lead.workspaceId)}, not ${route.leadWorkspaceId} — the workspace binding is exact`,
          );
        }
      }
      const supervisorWorkspaceId = route.supervisorAgentId === null ? null
        : await checkSupervisor(paseo, route.supervisorAgentId, "Supervisor", route.supervisorWorkspaceId, unverified);
      routes.push({ ...route, supervisorWorkspaceId });
    }
    const defaults = config.defaults;
    if (defaults.supervisorAgentId === null) {
      return { config: { ...config, routes, defaults: { ...defaults, supervisorWorkspaceId: null } }, unverified };
    }
    const unchanged = stored !== null && stored.defaults.supervisorAgentId === defaults.supervisorAgentId &&
      stored.defaults.supervisorWorkspaceId !== null;
    if (defaults.mode === "off" && unchanged) {
      return { config: { ...config, routes, defaults: { ...defaults, supervisorWorkspaceId: stored.defaults.supervisorWorkspaceId } }, unverified };
    }
    const workspaceId = await checkSupervisor(paseo, defaults.supervisorAgentId, "Default Supervisor", defaults.supervisorWorkspaceId, unverified);
    return { config: { ...config, routes, defaults: { ...defaults, supervisorWorkspaceId: workspaceId } }, unverified };
  }

  // The single CAS writer. expectedSha256 undefined = "whatever is on disk
  // now" (served-home actions read-modify-write in one call); the token is
  // still rechecked after every awaited validation.
  // `validate`: "full" for a Manager save; "none" for a pure reduction
  // (notify → shadow) — disabling must succeed even when an unrelated
  // route's Lead is gone.
  async function commit(
    stableRoot: string,
    expectedSha256: string | null | undefined,
    paseo: PaseoLike,
    build: (current: SupervisionConfig) => SupervisionConfig,
    validate: "full" | "none" = "full",
  ): Promise<{ config: SupervisionConfig; sha256: string; unverified: SupervisionUnverified[] }> {
    const file = supervisionPath(stableRoot);
    const before = readSupervisionFile(file);
    const token = expectedSha256 === undefined ? before.sha256 : expectedSha256;
    if (before.sha256 !== token) {
      throw new OperationConflict(
        "IDEMPOTENCY_CONFLICT",
        `supervision.json changed since the client's read — reload and retry (expected sha256 ${token ?? "<none>"}, found ${before.sha256 ?? "<none>"})`,
      );
    }
    if (expectedSha256 === undefined && before.config === null) {
      throw new OperationConflict("INVALID_REQUEST", `supervision.json is broken — fix it in the SLP Manager first (${before.error ?? "unreadable"})`);
    }
    const draft = build(before.config ?? emptySupervisionConfig());
    const validated = validate === "none" ? { config: draft, unverified: [] }
      : await validateConfig(paseo, draft, before.config);
    // Recheck the token after the awaited agent validation — a concurrent
    // save could have landed while the SDK calls were in flight.
    const after = readSupervisionFile(file);
    if (after.sha256 !== token) {
      throw new OperationConflict("IDEMPOTENCY_CONFLICT", "supervision.json changed during agent validation — reload and retry");
    }
    const body = `${JSON.stringify(validated.config, null, 2)}\n`;
    writePrivate(stableRoot, SUPERVISION_FILE, body, uuid);
    return { config: validated.config, sha256: sha256Hex(body), unverified: validated.unverified };
  }

  const shadowFor = (stableRoot: string) =>
    deps.shadow?.(stableRoot) ?? { observations: null, gates: null, diagnostics: null };

  const brokenView = (error: string): GetSupervisionResult => ({
    schemaVersion: 2, config: null, sha256: null, migration: null,
    observations: null, gates: null, diagnostics: null, unverified: [], error,
  });

  async function getSupervision(input: unknown): Promise<GetSupervisionResult> {
    const parsed = GetSupervisionInput.safeParse(input);
    if (!parsed.success) throw invalid("get-supervision", parsed.error);
    const binding = servedBinding(parsed.data.target);
    if (binding.error !== null) return brokenView(binding.error);
    const stored = readSupervisionFile(supervisionPath(binding.stableRoot));
    return {
      schemaVersion: 2, config: stored.config, sha256: stored.sha256, migration: stored.migration,
      ...shadowFor(binding.stableRoot), unverified: [], error: stored.error,
    };
  }

  async function setSupervision(input: unknown, paseo: PaseoLike): Promise<GetSupervisionResult> {
    const parsed = SetSupervisionInput.safeParse(input);
    if (!parsed.success) throw invalid("set-supervision", parsed.error);
    const binding = servedBinding(parsed.data.target);
    if (binding.error !== null) throw new OperationConflict("HOME_UNVERIFIED", binding.error);
    const written = await commit(binding.stableRoot, parsed.data.expectedSha256, paseo, () => parsed.data.config);
    return {
      schemaVersion: 2, config: written.config, sha256: written.sha256, migration: null,
      ...shadowFor(binding.stableRoot), unverified: written.unverified, error: null,
    };
  }

  const statusOf = (config: SupervisionConfig | null, sha256: string | null, error: string | null): SupervisionStatusResult => ({
    schemaVersion: 2,
    recipients: notifyRecipients(config),
    defaultSupervisorAgentId: config?.defaults.supervisorAgentId ?? null,
    defaultMode: config?.defaults.mode ?? null,
    sha256,
    error,
  });

  async function getStatus(input: unknown): Promise<SupervisionStatusResult> {
    const parsed = SupervisionStatusInput.safeParse(input);
    if (!parsed.success) throw invalid("get-supervision-status", parsed.error);
    const root = servedRoot();
    if (root.stableRoot === null) return statusOf(null, null, root.error);
    const stored = readSupervisionFile(supervisionPath(root.stableRoot));
    return statusOf(stored.config, stored.sha256, stored.error);
  }

  async function disableNotifications(input: unknown, paseo: PaseoLike): Promise<SupervisionStatusResult> {
    const parsed = DisableSupervisionNotificationsInput.safeParse(input);
    if (!parsed.success) throw invalid("disable-supervision-notifications", parsed.error);
    const root = servedRoot();
    if (root.stableRoot === null) throw new OperationConflict("HOME_UNVERIFIED", root.error ?? SERVED_GAP);
    const current = readSupervisionFile(supervisionPath(root.stableRoot));
    if (current.config !== null &&
        current.config.defaults.mode !== "notify" && !current.config.routes.some(route => route.mode === "notify")) {
      return statusOf(current.config, current.sha256, null); // nothing to disable — no write
    }
    const written = await commit(root.stableRoot, undefined, paseo, withoutNotify, "none");
    return statusOf(written.config, written.sha256, null);
  }

  return { getSupervision, setSupervision, getStatus, disableNotifications };
}
