import type { HostConfig, Profile } from './types.ts';
interface ObservedReceipt {
  state?: unknown;
  revision?: unknown;
  pluginId?: unknown;
  target?: {
    daemonHome?: string;
  };
  createdAt?: unknown;
  updatedAt?: unknown;
  activeOperationId?: unknown;
  retained?: unknown[];
  binding?: {
    runtimePath?: string;
    candidateSha256?: string;
    payloadSha256?: unknown;
    node?: {
      path?: unknown;
    };
    nodePath?: unknown;
    baseline?: unknown;
    activatedAt?: unknown;
    verifiedAt?: unknown;
    launcherFiles?: {
      path: string;
      sha256: string;
    }[];
    binaries?: Record<string, string | {
      path: string;
    }>;
    owned?: {
      providers?: Record<string, {
        present?: boolean;
      }>;
      profiles?: {
        value?: Profile;
      }[];
    };
  };
  operations?: {
    operationId?: unknown;
    kind?: unknown;
    phase?: unknown;
    outcome?: unknown;
    conflicts?: unknown[];
    acceptedAt?: unknown;
    completedAt?: unknown;
  }[];
}
interface RuntimeChecks {
  targetMatch?: boolean;
  runtime?: {
    ok: boolean;
    detail?: string;
    candidateSha256?: string;
  };
  launchers?: {
    path: string;
    ok: boolean;
    detail?: string;
  }[];
  configDrift?: {
    missingProviders: string[];
    missingProfiles: (string | undefined)[];
  };
}
import type { RuntimeError } from './types.ts';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { hash, readJson, verifyInstall } from './package.ts';
import { isManagedRuntime, managedHome } from './managed-home.ts';
import { readJevConfig } from './jev.ts';
import { observeJevKey } from '../jev-state.ts';

// H13: the plugin's RPC surface (status, local-target, ...) is reachable only
// through the Manager UI or a hand-rolled WS frame — no `paseo plugin invoke`
// CLI or MCP tool exists. These probes recompute the file-derivable parts of
// the daemon's views from <daemonHome>/slp-runtime/state and config.json.
// Everything not derivable from local files is reported as a gap, never
// guessed; mutations stay Human-authority and are not exposed here. Retire
// when the host ships `paseo plugin invoke` or MCP `invoke_plugin_rpc`.

// Same detection as the plugin's local-target RPC: the daemon home this
// process would serve. Explicit flag wins; a managed session falls back to
// its bound SLP_DAEMON_HOME/PASEO_HOME (fail closed, never ~/.paseo); an
// unmanaged process mirrors the host default chain.
export function localTarget(explicit?: string | null) {
  if (explicit != null) {
    if (!isAbsolute(explicit)) throw new Error('Absolute path required for --paseo-home');
    return { daemonHome: explicit, source: 'flag' };
  }
  if (isManagedRuntime()) return { daemonHome: managedHome(), source: 'managed-env' };
  if (process.env.PASEO_HOME) return { daemonHome: process.env.PASEO_HOME, source: 'env' };
  return { daemonHome: join(homedir(), '.paseo'), source: 'default' };
}

const readStateFile = <T>(path: string, { jsonFile }: { jsonFile: boolean }): T | null => {
  try {
    const bytes = readFileSync(path, 'utf8');
    return jsonFile ? JSON.parse(bytes) : bytes as T;
  } catch (error) {
    if ((error as RuntimeError).code === 'ENOENT' || (error as RuntimeError).code === 'ENOTDIR') return null;
    // Corrupt plugin-owned state is evidence, not absence — fail closed.
    throw new Error(`Cannot read ${path}: ${(error as RuntimeError).message}`);
  }
};

// slp-owned config entries: provider ids slp-<family>-<role> under
// agents.providers, profile ids slp-<role> under daemon.agentProfiles, and
// daemon.mcp.injectIntoAgents. Presence-only — byte equality against the
// injected projection is a daemon-side concern.
function ownedConfigScan(config: HostConfig) {
  const providers = Object.keys(config?.agents?.providers ?? {}).filter(id => id.startsWith('slp-'));
  const profiles = (Array.isArray(config?.daemon?.agentProfiles) ? config.daemon.agentProfiles : [])
    .map(profile => (profile as { id?: unknown } | null)?.id).filter(id => typeof id === 'string' && id.startsWith('slp-'));
  return { providers, profiles, injectIntoAgents: config?.daemon?.mcp?.injectIntoAgents === true };
}

// Jev surface: presence-only, never key material. hasKey is an lstat probe of
// jev-<kind>.key; keyPermissionsOk reports whether the file denies group/other
// access. A corrupt jev.json is reported as an error string, not silently OFF.
const jevStatus = (home: string) => {
  const keyFileProbe = (kind: string) => observeJevKey(join(home, 'slp-runtime'), kind);
  try {
    const config = readJevConfig(home);
    const kind = config?.provider?.kind ?? 'openrouter';
    const { hasKey, keyPermissionsOk } = keyFileProbe(kind);
    if (config === null) return { configured: false, hasKey, keyPermissionsOk };
    return {
      configured: true, enabled: config.enabled, capabilities: config.capabilities,
      // A disabled config exposes no provider — the enabled-only fields are
      // not validated on the OFF path, so they are reported as absent.
      provider: config.provider === null ? null : { kind: config.provider.kind, baseUrl: config.provider.baseUrl, model: config.provider.model },
      hasKey, keyPermissionsOk,
    };
  } catch (error) {
    return { configured: true, ...keyFileProbe('openrouter'), error: (error as RuntimeError).message };
  }
};

export function runtimeStatus(explicit?: string | null) {
  const { daemonHome, source } = localTarget(explicit);
  const home = existsSync(daemonHome) ? realpathSync(daemonHome) : resolve(daemonHome);
  const stableRoot = join(home, 'slp-runtime');
  const stateDir = join(stableRoot, 'state');
  const gaps: string[] = [];
  const receipt = readStateFile<ObservedReceipt>(join(stateDir, 'receipt.json'), { jsonFile: true });
  const roleRouting = readStateFile<unknown>(join(stateDir, 'role-routing.json'), { jsonFile: true });
  const communicationLanguage = readStateFile<string>(join(stateDir, 'communication-language'), { jsonFile: false });
  const config = (() => {
    try { return (readJson(join(home, 'config.json')) as HostConfig); }
    catch (error) {
      if ((error as RuntimeError).code === 'ENOENT' || (error as RuntimeError).code === 'ENOTDIR') return null;
      gaps.push(`config.json unreadable (${(error as RuntimeError).message}) — orphan/drift scan skipped`);
      return undefined;
    }
  })();
  // null = config absent (nothing to scan); undefined = present but unreadable.
  const ownedScan = config == null ? config : ownedConfigScan(config);

  if (!receipt) {
    // Mirror the daemon heuristic: no receipt + orphaned slp-* entries in
    // config means an interrupted activation — RECOVERY_REQUIRED, not clean.
    const orphaned = ownedScan
      ? [...ownedScan.providers, ...ownedScan.profiles]
      : [];
    return {
      derivedFrom: 'local-files', daemonHome: home, homeSource: source, stableRoot,
      state: ownedScan === null ? 'INACTIVE'
        : ownedScan === undefined ? 'UNKNOWN'
        : orphaned.length ? 'RECOVERY_REQUIRED' : 'INACTIVE',
      receipt: null, roleRouting, communicationLanguage, jev: jevStatus(home),
      ...(orphaned.length ? { orphanedEntries: orphaned } : {}),
      gaps: [...gaps,
        'no receipt — live conflicts, family availability and managedProfiles are daemon-computed views'],
    };
  }

  const checks: RuntimeChecks = {};
  checks.targetMatch = receipt.target?.daemonHome === home;
  const binding = receipt.binding;
  if (binding) {
    // Runtime integrity: the bound runtime dir must still verify and carry
    // the recorded candidate hash.
    checks.runtime = (() => {
      const runtimePath = binding.runtimePath;
      if (typeof runtimePath !== 'string' || !existsSync(runtimePath)) {
        return { ok: false, detail: `runtimePath ${runtimePath} missing` };
      }
      try {
        const manifest = verifyInstall(runtimePath);
        const match = manifest.candidate.sha256 === binding.candidateSha256;
        return { ok: match, candidateSha256: manifest.candidate.sha256,
          ...(match ? {} : { detail: `candidate ${manifest.candidate.sha256} != binding ${binding.candidateSha256}` }) };
      } catch (error) {
        return { ok: false, detail: (error as RuntimeError).message };
      }
    })();
    // Launcher bytes the receipt recorded, re-hashed from disk.
    checks.launchers = (binding.launcherFiles ?? []).map(file => {
      if (!existsSync(file.path)) return { path: file.path, ok: false, detail: 'missing' };
      const actual = hash(readFileSync(file.path));
      return { path: file.path, ok: actual === file.sha256,
        ...(actual === file.sha256 ? {} : { detail: 'sha256 drift' }) };
    });
    // Config drift, presence-only: entries the activation injected must still
    // be present. Value comparison stays a daemon concern.
    if (ownedScan) {
      const expected = Object.entries(binding.owned?.providers ?? {})
        .filter(([, entry]) => entry.present).map(([id]) => id);
      checks.configDrift = {
        missingProviders: expected.filter(id => !ownedScan.providers.includes(id)),
        missingProfiles: (binding.owned?.profiles ?? [])
          .map(entry => entry.value?.id).filter(id => id && !ownedScan.profiles.includes(id)),
      };
    }
  }
  if (!ownedScan) gaps.push('config.json absent — config-drift presence check skipped');
  gaps.push('live conflict recomputation and family availability probes are daemon-computed — recorded binary paths are receipt data, not fresh probes');

  return {
    derivedFrom: 'local-files', daemonHome: home, homeSource: source, stableRoot,
    state: receipt.state,
    receipt: {
      revision: receipt.revision, state: receipt.state, pluginId: receipt.pluginId,
      target: receipt.target, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt,
      activeOperationId: receipt.activeOperationId,
      binding: binding ? {
        candidateSha256: binding.candidateSha256, payloadSha256: binding.payloadSha256,
        runtimePath: binding.runtimePath, nodePath: binding.node?.path ?? binding.nodePath,
        baseline: binding.baseline, activatedAt: binding.activatedAt, verifiedAt: binding.verifiedAt,
        launcherCount: (binding.launcherFiles ?? []).length,
        binaries: Object.fromEntries(Object.entries(binding.binaries ?? {})
          .map(([family, value]) => [family, { path: (value as { path?: string })?.path ?? value as string, exists: existsSync((value as { path?: string })?.path ?? value as string) }])),
        ownedProviders: Object.entries(binding.owned?.providers ?? {})
          .filter(([, entry]) => entry.present).map(([id]) => id),
        managedProfiles: (binding.owned?.profiles ?? []).map(entry => ({
          id: entry.value?.id, provider: entry.value?.provider ?? null,
          model: entry.value?.model ?? null, modeId: entry.value?.modeId ?? null,
          thinkingOptionId: entry.value?.thinkingOptionId ?? null,
          featureValues: entry.value?.featureValues ?? null,
        })),
      } : null,
      operations: (receipt.operations ?? []).map(op => ({
        operationId: op.operationId, kind: op.kind, phase: op.phase, outcome: op.outcome,
        conflicts: (op.conflicts ?? []).length,
        acceptedAt: op.acceptedAt, completedAt: op.completedAt ?? null,
      })),
      retainedCount: (receipt.retained ?? []).length,
    },
    roleRouting, communicationLanguage, jev: jevStatus(home),
    checks, gaps,
  };
}
