// Adapted from getpaseo/paseo v0.12.0, Antigravity provider (Apache-2.0).
// See LICENSE in this directory; native wire behavior follows that release.
import type {
  ProviderCatalog,
  ProviderLaunch,
  ProviderModel,
  ProviderMode,
  ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { probe } from "./process.ts";
import { AntigravityError } from "./wire.ts";

const modes: readonly ProviderMode[] = [
  {
    id: "full-access",
    icon: "ShieldOff",
    colorTier: "dangerous",
    label: "Full access",
    description:
      "Antigravity cannot ask for permission when another app drives it. Paseo starts it with --dangerously-skip-permissions.",
    isUnattended: true,
  },
];

export async function getCatalog(launch: ProviderLaunch, cwd?: string): Promise<ProviderCatalog> {
  const version = (await probe({ launch, args: ["--version"] })).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new AntigravityError("Could not read the Antigravity version; use agy 1.4.4 or later", "UNSUPPORTED_VERSION");
  const [, major, minor, patch] = match.map(Number);
  if (!(major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 4))))) {
    throw new AntigravityError(`Antigravity ${version} is unsupported; use agy 1.4.4 or later`, "UNSUPPORTED_VERSION");
  }
  const output = await probe({ launch, args: ["models"], cwd });
  const models: ProviderModel[] = [];
  for (const line of output.trim().split(/\r?\n/)) {
    const [id, label, ...extra] = line.split("\t");
    if (!id || !label || extra.length > 0)
      throw new AntigravityError("Invalid `agy models` output", "INVALID_CATALOG");
    if (models.some((model) => model.id === id))
      throw new AntigravityError(`Duplicate Antigravity model: ${id}`, "INVALID_CATALOG");
    models.push({ id, label });
  }
  return { models, modes, thinkingOptions: [], defaultMode: "full-access" };
}

export async function getStatus(launch: ProviderLaunch): Promise<ProviderStatus> {
  try { await getCatalog(launch); return { available: true }; }
  catch (error) {
    if (!(error instanceof AntigravityError)) throw error;
    return { available: false, diagnostic: error.message };
  }
}

export function validateSelection(
  config: { model?: string; mode?: string; thinkingOption?: string },
  catalog: ProviderCatalog,
): void {
  if (config.model && !catalog.models.some((model) => model.id === config.model))
    throw new AntigravityError(`Unknown Antigravity model: ${config.model}`, "INVALID_MODEL");
  if (config.mode && !catalog.modes.some((mode) => mode.id === config.mode))
    throw new AntigravityError(`Unknown Antigravity mode: ${config.mode}`, "INVALID_MODE");
  if (config.thinkingOption)
    throw new AntigravityError(
      "Antigravity effort is selected through the model ID",
      "UNSUPPORTED_THINKING",
    );
}
