import type { Provider } from './types.ts';
import type { RuntimeError } from './types.ts';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { configFile, providers as hostProviders, agentProfiles } from './host-config.ts';
import { isManagedRuntime, resolveHome } from './managed-home.ts';

// Provider/profile inventory in exactly the shapes launchPlan consumes:
// providers satisfy verifyProvider ({id, enabled, status, extends}) and
// profiles satisfy resolveProfile ({id, provider, model, modeId,
// thinkingOptionId, featureValues}). Live `paseo provider ls --json` wins for
// providers, but only when the requested home has a running daemon — spawning
// the CLI against a home without one can auto-create the directory and fall
// back to a foreign default daemon. Under SLP_MANAGED_RUNTIME=1 the CLI listing
// is never invoked: providers come only from the exact home's config.json and
// are labeled configured-not-live (see below). config.json supplies profiles
// (no live listing exists) and is the fallback source when the daemon is absent
// or the call fails. Read-only.
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// Tri-state: only the observed states map to a boolean; anything else stays
// null so a future third state is never silently read as enabled.
const enabledOf = (value: unknown) =>
  value === 'Enabled' || value === true ? true
    : value === 'Disabled' || value === false ? false : null;

// paseo provider ls --json uses `provider` for the id, "Enabled"/"Disabled"
// strings for enabled, and carries no `extends`; verifyProvider's pass rule is
// fail-closed — enabled === true and status !== 'unavailable'.
const liveProvider = (entry: Record<string, unknown>) => ({
  id: entry.provider,
  enabled: enabledOf(entry.enabled),
  ...(entry.status != null ? { status: entry.status } : {}),
});

// agents.providers is a map keyed by id; absent enabled means enabled.
const configProvider = (id: string, entry: unknown): Provider => ({
  id,
  enabled: !record(entry) || entry.enabled == null ? true : enabledOf(entry.enabled),
  ...((entry as { extends?: unknown } | null)?.extends != null ? { extends: (entry as { extends: unknown }).extends } : {}),
});

const profile = (entry: Record<string, unknown>) => ({
  id: entry.id,
  provider: entry.provider,
  model: entry.model,
  ...(entry.modeId != null ? { modeId: entry.modeId } : {}),
  ...(entry.thinkingOptionId != null ? { thinkingOptionId: entry.thinkingOptionId } : {}),
  ...(entry.featureValues != null ? { featureValues: entry.featureValues } : {}),
});

// A running daemon for this home leaves paseo.pid; EPERM still means alive.
const liveDaemon = (home: string) => {
  try {
    const pid = JSON.parse(readFileSync(join(home, 'paseo.pid'), 'utf8')).pid;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) { return (error as RuntimeError).code === 'EPERM'; }
};

export function inventory(home?: string | null) {
  const managed = isManagedRuntime();
  home = resolveHome(home);
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('Absolute Paseo home required');
  const file = configFile(home);
  const source = { providers: file.path, profiles: file.path };
  if (managed) {
    // Never the default-target `paseo provider ls` fallback: an inherited
    // PASEO_LISTEN or stale pid can target another daemon, and the CLI degrades
    // to static manifest data that would still look live. Exact-home config
    // entries only, each marked provenance:"configured" so verifyProvider
    // (plugin/server/runtime/cli/binding.ts) refuses them as launch evidence.
    return {
      providers: Object.entries(hostProviders(file.config))
        .map(([id, entry]) => ({ ...configProvider(id, entry), provenance: 'configured' })),
      profiles: agentProfiles(file.config).filter(record).map(profile),
      source,
      providersProvenance: 'configured, not live',
    };
  }
  let providers: Provider[] | undefined;
  if (liveDaemon(home)) {
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, PASEO_HOME: home };
      delete env.PASEO_HOST;
      const listed = JSON.parse(execFileSync('paseo', ['provider', 'ls', '--json'], {
        env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      }));
      if (!Array.isArray(listed)) throw new Error('Unexpected provider listing');
      providers = listed.filter(record).map(liveProvider).filter(entry => typeof entry.id === 'string' && entry.id) as Provider[];
      source.providers = 'paseo provider ls --json';
    } catch { /* stale pid or mid-restart daemon: fall back to config */ }
  }
  providers ??= Object.entries(hostProviders(file.config)).map(([id, entry]) => configProvider(id, entry));
  return { providers, profiles: agentProfiles(file.config).filter(record).map(profile), source };
}
