import type { Provider } from "./runtime/cli/types.ts";
import type { PresetRoutingContext } from "./runtime/cli/preset-routing.ts";
import { reobservePeerReference, type ReferenceHost } from "./peer-reference.ts";
// Resolve a task's Peer runtime through the verified installed candidate.
// Pool precedence, eligibility and Jev receipts remain owned by its launch
// module. This adapter supplies fresh connected-host provider observations.
import { pathToFileURL } from "node:url";
import { candidateModulePath } from "./candidate-module.ts";
import { getPath } from "./config-view.ts";
import type { DeskRejectionValue } from "../shared/enforcement.ts";

export type TaskRuntimeSelection = {
  optionId: string;
  catalogSha256: string;
  decision?: unknown;
  quotaFallbackFrom?: string;
  thinkingOptionId?: string | null;
  selectionSha256?: string;
  routingContext?: PresetRoutingContext;
};

export type TaskRuntimeBinding = {
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  features: Record<string, unknown>;
  routing: unknown;
  warnings: string[];
};

export type TaskRuntimeApi = ReferenceHost & {
  providers: {
    snapshot(options?: { cwd?: string }): Promise<{
      entries: { provider: string; enabled?: boolean; status: string; error?: string | null; modes?: { id: string }[]; extends?: string; models?: Provider["models"] }[];
      error?: string | null;
    }>;
  };
  /** Current SDK snapshots omit transport; the connected mutable config
   * supplies the observed custom-provider extends field, not availability. */
  config?: { get(requestId?: string): Promise<{ config: unknown }> };
};

export type ProviderWarmup = { budgetMs: number; pollMs: number };
/** The daemon answers a cwd's first snapshot with enabled providers still
 * "loading" (no models) and warms them in the background. */
export const PROVIDER_WARMUP: ProviderWarmup = { budgetMs: 10_000, pollMs: 250 };

/** Re-read while an enabled provider is still warming up, within the budget.
 * The last read stands: a provider still loading stays unavailable. */
async function warmedSnapshot(host: TaskRuntimeApi, cwd: string, warmup: ProviderWarmup) {
  const deadline = Date.now() + warmup.budgetMs;
  let observed = await host.providers.snapshot({ cwd });
  while (!observed.error && observed.entries.some(entry => entry.enabled === true && entry.status === "loading")
    && Date.now() + warmup.pollMs < deadline) {
    await new Promise(resolve => setTimeout(resolve, warmup.pollMs));
    observed = await host.providers.snapshot({ cwd });
  }
  return observed;
}

/** Preserve published transport facts. For current snapshots lacking OpenCode
 * transport, read the live daemon config around a fresh snapshot. Never infer
 * ACP from an alias or use config to invent ready/enabled provider evidence. */
export async function observeTaskProviders(host: TaskRuntimeApi, cwd: string, warmup: ProviderWarmup = PROVIDER_WARMUP) {
  let observed = await warmedSnapshot(host, cwd, warmup);
  if (observed.error) return observed;
  const missing = new Set(observed.entries.filter(entry => /^slp-opencode-(supervisor|lead|peer)$/.test(entry.provider)
    && entry.enabled === true && entry.status === "ready" && !entry.error && entry.extends === undefined).map(entry => entry.provider));
  if (missing.size === 0 || typeof host.config?.get !== "function") return observed;
  const transport = (config: unknown, id: string) => {
    const value = getPath(config, ["providers", id, "extends"]).value;
    return typeof value === "string" ? value : undefined;
  };
  const unavailable = (entry: typeof observed.entries[number]) => ({ ...entry, status: "unavailable",
    error: "OpenCode transport evidence is missing, changed or unavailable" });
  try {
    const beforeConfig = (await host.config.get()).config;
    const before = new Map([...missing].map(id => [id, transport(beforeConfig, id)]));
    observed = await host.providers.snapshot({ cwd });
    if (observed.error) return observed;
    const afterConfig = (await host.config.get()).config;
    return { ...observed, entries: observed.entries.map(entry => {
      if (!missing.has(entry.provider)) return entry;
      const value = before.get(entry.provider);
      if (value === undefined || value !== transport(afterConfig, entry.provider)
        || (entry.extends !== undefined && entry.extends !== value)) return unavailable(entry);
      return { ...entry, extends: value };
    }) };
  } catch {
    // A failed config read refuses only dependent OpenCode observations. Its
    // possibly sensitive SDK error and unrelated provider config never escape.
    return { ...observed, entries: observed.entries.map(entry => missing.has(entry.provider) ? unavailable(entry) : entry) };
  }
}

/** Model metadata is an additive installed-candidate ABI, not a host capability.
 * Older v1 consumers reject unknown provider keys even for saved Lead profiles. */
export function taskProviderInventory(observed: Awaited<ReturnType<typeof observeTaskProviders>>, supportsPresets: boolean) {
  return observed.entries.map(entry => ({
    id: entry.provider, enabled: entry.enabled === true,
    status: entry.status === "ready" && !entry.error ? "available" : "unavailable",
    ...(entry.extends !== undefined ? { extends: entry.extends } : {}),
    ...(supportsPresets && entry.models !== undefined ? { models: entry.models } : {}),
  }));
}

type LaunchModule = {
  FORMATION_CAPABILITIES?: { peerPresets?: number };
  resolveBinding(role: string, request: {
    repository: string;
    assignment: string;
    paseoHome: string;
    providers: { id: string; enabled: boolean; status: string; extends?: string }[];
    route: TaskRuntimeSelection;
  }, disposition?: string): {
    binding: {
      provider: string;
      model?: string | null;
      modeId?: string | null;
      thinkingOptionId?: string | null;
      features?: Record<string, unknown> | null;
    };
    routing?: unknown;
    warnings?: string[];
  };
};

/** The caller establishes candidate authority before this resolver is built.
 * A failed import never selects another retained layout or a source module. */
export function createTaskRuntimeResolver(deps: {
  runtimePath: string;
  daemonHome: string;
  host: () => TaskRuntimeApi | null;
  importModule?: (specifier: string) => Promise<LaunchModule>;
}) {
  return async (
    repository: string,
    selection: TaskRuntimeSelection,
    disposition?: string,
  ): Promise<TaskRuntimeBinding | DeskRejectionValue> => {
    const reject = (code: DeskRejectionValue["code"], message: string): DeskRejectionValue => ({
      ok: false, code, message: message.slice(0, 512),
      recovery: "read the current Peer pool and host availability before dispatching again",
    });
    const host = deps.host();
    if (host === null) return reject("CAPABILITY_GAP", "the connected provider snapshot API is unavailable");
    let observed: Awaited<ReturnType<TaskRuntimeApi["providers"]["snapshot"]>>;
    try {
      observed = await observeTaskProviders(host, repository);
    } catch (error) {
      return reject("CAPABILITY_GAP", `provider snapshot failed: ${(error as Error).message}`);
    }
    if (observed.error) return reject("CAPABILITY_GAP", `provider snapshot failed: ${observed.error}`);
    try {
      await reobservePeerReference(host, selection.routingContext);
      const specifier = pathToFileURL(candidateModulePath(deps.runtimePath, "launch")).href;
      const module = await (deps.importModule ?? (specifier => import(specifier)))(specifier);
      if (typeof module.resolveBinding !== "function") {
        return reject("CAPABILITY_GAP", "the bound candidate has no Peer binding resolver");
      }
      const resolved = module.resolveBinding("peer", {
        repository, assignment: "Resolve the task runtime; no work prompt is issued here.",
        paseoHome: deps.daemonHome, route: selection,
        // SDK snapshots use `provider`, while the installed launch ABI uses
        // `id`. Only a ready, enabled observation grants usable inventory;
        // unknown/loading/error remains unavailable. No config fallback.
        providers: taskProviderInventory(observed, module.FORMATION_CAPABILITIES?.peerPresets === 2),
      }, disposition);
      const binding = resolved.binding;
      if (!binding?.provider || !binding.model) return reject("CAPABILITY_GAP", "the bound resolver returned no complete provider/model bundle");
      return {
        provider: binding.provider, model: binding.model,
        ...(binding.modeId != null ? { modeId: binding.modeId } : {}),
        ...(binding.thinkingOptionId != null ? { thinkingOptionId: binding.thinkingOptionId } : {}),
        features: binding.features ?? {}, routing: resolved.routing ?? null,
        warnings: resolved.warnings ?? [],
      };
    } catch (error) {
      return reject("INVALID_RECORD", `Peer runtime could not be resolved: ${(error as Error).message}`);
    }
  };
}
