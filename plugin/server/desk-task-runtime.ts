// Resolve a task's Peer runtime through the verified installed candidate.
// Pool precedence, eligibility and Jev receipts remain owned by its launch
// module. This adapter supplies fresh connected-host provider observations.
import { pathToFileURL } from "node:url";
import { candidateModulePath } from "./candidate-module.ts";
import type { DeskRejectionValue } from "../shared/enforcement.ts";

export type TaskRuntimeSelection = {
  optionId: string;
  catalogSha256: string;
  decision?: unknown;
  quotaFallbackFrom?: string;
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

export type TaskRuntimeApi = {
  providers: {
    snapshot(options?: { cwd?: string }): Promise<{
      entries: { provider: string; enabled?: boolean; status: string; error?: string | null }[];
      error?: string | null;
    }>;
  };
};

type LaunchModule = {
  resolveBinding(role: string, request: {
    repository: string;
    assignment: string;
    paseoHome: string;
    providers: { id: string; enabled: boolean; status: string }[];
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
      observed = await host.providers.snapshot({ cwd: repository });
    } catch (error) {
      return reject("CAPABILITY_GAP", `provider snapshot failed: ${(error as Error).message}`);
    }
    if (observed.error) return reject("CAPABILITY_GAP", `provider snapshot failed: ${observed.error}`);
    try {
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
        providers: observed.entries.map(entry => ({
          id: entry.provider, enabled: entry.enabled === true,
          status: entry.status === "ready" && !entry.error ? "available" : "unavailable",
        })),
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
