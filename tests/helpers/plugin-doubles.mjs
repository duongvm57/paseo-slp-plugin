// tests/helpers/plugin-doubles.mjs — shared test harness for the plugin lane:
// MiniStore (line-faithful port of S/daemon-config-store.js semantics), honest
// seam doubles doing real filesystem work, and deterministic fixtures. The real
// installed @getpaseo/server backend is used when resolvable; resolution order:
//   1. PASEO_CLI_MODULES env (verbatim, authoritative)
//   2. `npm root -g` → <root>/@getpaseo/cli/node_modules
//   3. `which paseo` → realpath → <prefix>/lib/node_modules/@getpaseo/cli/node_modules
//   4. ~/.local/share/fnm/node-versions/*/installation/... (fnm installs)
// When no host modules resolve, the harness falls back to MiniStore and warns
// LOUDLY — real-backend parity coverage is skipped rather than silently lost.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import {
  MutableDaemonConfigPatchSchema,
  MutableDaemonConfigSchema,
} from '@getpaseo/protocol/messages';
import { ProviderOverrideSchema } from '@getpaseo/protocol/provider-config';
import { PinnedPersistedConfigSchema } from '../../plugin/server/config-transaction.ts';
import { OperationConflict } from '../../plugin/shared/contracts.ts';

export const FAMILIES = ['codex', 'pi', 'devin', 'claude', 'opencode'];
export const ROLES = ['supervisor', 'lead', 'peer'];
export const OWNED_IDS = FAMILIES.flatMap(f => ROLES.map(r => `slp-${f}-${r}`)).sort();
export const sha256 = data => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------
// Host module resolution (installed @getpaseo/cli backend, optional)
// ---------------------------------------------------------------------------

const HOST_SERVER_REL = '@getpaseo/server/dist/server/server';
const HOST_STORE_REL = `${HOST_SERVER_REL}/daemon-config-store.js`;
const HOST_PERSISTED_REL = `${HOST_SERVER_REL}/persisted-config.js`;

function autoModuleCandidates() {
  const candidates = [];
  try {
    const root = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (root) candidates.push(join(root, '@getpaseo/cli', 'node_modules'));
  } catch {
    /* npm not resolvable */
  }
  try {
    const which = execFileSync('which', ['paseo'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (which) {
      const prefix = dirname(dirname(realpathSync(which)));
      candidates.push(join(prefix, 'lib', 'node_modules', '@getpaseo/cli', 'node_modules'));
      candidates.push(join(prefix, 'node_modules', '@getpaseo/cli', 'node_modules'));
    }
  } catch {
    /* paseo not on PATH */
  }
  try {
    const fnmVersions = join(homedir(), '.local', 'share', 'fnm', 'node-versions');
    for (const version of readdirSync(fnmVersions)) {
      candidates.push(
        join(fnmVersions, version, 'installation', 'lib', 'node_modules', '@getpaseo/cli', 'node_modules'),
      );
    }
  } catch {
    /* no fnm installs */
  }
  return candidates;
}

let resolvedModules;
/** PASEO_CLI_MODULES wins verbatim (even a bad path — used to force the fallback).
 *  Otherwise probes npm-root -g, the paseo bin prefix, then fnm installs. */
export function hostModulesDir() {
  if (resolvedModules !== undefined) return resolvedModules;
  const env = process.env.PASEO_CLI_MODULES;
  if (env !== undefined) {
    resolvedModules = env === '' ? null : env;
    return resolvedModules;
  }
  resolvedModules =
    autoModuleCandidates().find(dir => existsSync(join(dir, HOST_STORE_REL))) ?? null;
  return resolvedModules;
}

let backendWarned = false;
export function warnBackendUnavailable(dir) {
  if (backendWarned) return;
  backendWarned = true;
  console.warn(
    '\n[plugin-tests] ⚠️  real @getpaseo/server backend NOT FOUND — MiniStore fallback active, real-backend parity coverage SKIPPED.\n' +
      '  resolution order tried: PASEO_CLI_MODULES env → `npm root -g` → `which paseo` prefix → fnm node-versions scan\n' +
      `  modules dir resolved to: ${dir ?? '<none>'}\n` +
      '  set PASEO_CLI_MODULES=<.../@getpaseo/cli/node_modules> to restore parity coverage.\n',
  );
}

let realBackend = null;
export async function loadRealBackend() {
  if (realBackend !== null) return realBackend;
  const dir = hostModulesDir();
  const storePath = dir ? join(dir, HOST_STORE_REL) : null;
  const persistedPath = dir ? join(dir, HOST_PERSISTED_REL) : null;
  if (!dir || !existsSync(storePath) || !existsSync(persistedPath)) {
    warnBackendUnavailable(dir);
    realBackend = false;
    return realBackend;
  }
  try {
    const storeMod = await import(storePath);
    const persistedMod = await import(persistedPath);
    realBackend = { ...storeMod, ...persistedMod };
  } catch {
    warnBackendUnavailable(dir);
    realBackend = false;
  }
  return realBackend;
}

/** Import one module from the installed host server tree, or null + loud warn. */
export async function loadHostModule(relName) {
  const dir = hostModulesDir();
  const target = dir ? join(dir, HOST_SERVER_REL, relName) : null;
  if (!target || !existsSync(target)) {
    warnBackendUnavailable(dir);
    return null;
  }
  try {
    return await import(target);
  } catch {
    warnBackendUnavailable(dir);
    return null;
  }
}

// ---------------------------------------------------------------------------
// MiniStore — line-faithful port of S/daemon-config-store.js semantics
// (deep merge, skills/plugins replacement, provider omission, fresh-disk
// persistence through the pinned schema). Real protocol schemas throughout.
// ---------------------------------------------------------------------------

export function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function deepMerge(current, patch) {
  const next = { ...current };
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue;
    const currentValue = next[key];
    next[key] = isRecord(currentValue) && isRecord(patchValue) ? deepMerge(currentValue, patchValue) : patchValue;
  }
  return next;
}
function omitProvidersFromConfig(config, providers) {
  if (providers.length === 0 || !config.providers) return config;
  let changed = false;
  const nextProviders = { ...config.providers };
  for (const provider of providers) {
    if (provider in nextProviders) {
      delete nextProviders[provider];
      changed = true;
    }
  }
  return changed ? { ...config, providers: nextProviders } : config;
}
function omitMetadataGenerationProvidersFromConfig(config, providers) {
  if (providers.length === 0 || !config.metadataGeneration?.providers) return config;
  const removed = new Set(providers);
  const nextProviders = config.metadataGeneration.providers.filter(
    entry => typeof entry.provider !== 'string' || !removed.has(entry.provider),
  );
  if (nextProviders.length === config.metadataGeneration.providers.length) return config;
  return { ...config, metadataGeneration: { ...config.metadataGeneration, providers: nextProviders } };
}
function omitProvidersFromOverrides(overrides, providers) {
  if (!overrides) return undefined;
  const next = { ...overrides };
  for (const provider of providers) delete next[provider];
  return Object.keys(next).length > 0 ? next : undefined;
}
function applyMutableProviderConfigToOverrides(baseOverrides, mutableProviders) {
  if (!baseOverrides && (!mutableProviders || Object.keys(mutableProviders).length === 0)) return undefined;
  const nextOverrides = { ...baseOverrides };
  for (const [providerId, providerConfig] of Object.entries(mutableProviders ?? {})) {
    const previousOverride = nextOverrides[providerId];
    const parsedOverride = ProviderOverrideSchema.strip().parse(providerConfig);
    nextOverrides[providerId] = {
      ...previousOverride,
      ...parsedOverride,
      ...(parsedOverride.paseoTools
        ? { paseoTools: { ...previousOverride?.paseoTools, ...parsedOverride.paseoTools } }
        : {}),
    };
  }
  return nextOverrides;
}
function pickSupportedPatchFields(patch) {
  return {
    ...(patch.relay?.enabled !== undefined ? { relay: { enabled: patch.relay.enabled } } : {}),
    ...(patch.mcp?.injectIntoAgents !== undefined
      ? { mcp: { injectIntoAgents: patch.mcp.injectIntoAgents } }
      : {}),
    ...(patch.browserTools?.enabled !== undefined
      ? { browserTools: { enabled: patch.browserTools.enabled } }
      : {}),
    ...(patch.providers !== undefined ? { providers: patch.providers } : {}),
    ...(patch.removeProviders !== undefined ? { removeProviders: patch.removeProviders } : {}),
    ...(patch.metadataGeneration?.providers !== undefined
      ? { metadataGeneration: { providers: patch.metadataGeneration.providers } }
      : {}),
    ...(patch.autoArchiveAfterMerge !== undefined ? { autoArchiveAfterMerge: patch.autoArchiveAfterMerge } : {}),
    ...(patch.enableTerminalAgentHooks !== undefined ? { enableTerminalAgentHooks: patch.enableTerminalAgentHooks } : {}),
    ...(patch.appendSystemPrompt !== undefined ? { appendSystemPrompt: patch.appendSystemPrompt } : {}),
    ...(patch.terminalProfiles !== undefined ? { terminalProfiles: patch.terminalProfiles } : {}),
    ...(patch.agentProfiles !== undefined ? { agentProfiles: patch.agentProfiles } : {}),
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
  };
}
function stripRemovedConfigFields(parsed) {
  if (!isRecord(parsed)) return parsed;
  const root = { ...parsed };
  const providers = root.providers;
  if (!isRecord(providers)) return root;
  const next = { ...providers };
  if (isRecord(next.local)) {
    const local = { ...next.local };
    delete local.autoDownload;
    next.local = local;
  }
  if (isRecord(next.openai)) {
    const openai = { ...next.openai };
    delete openai.voice;
    next.openai = openai;
  }
  root.providers = next;
  return root;
}
function mergeMutableDaemonPatch(persistedDaemon, patch, persistRelayEnabled) {
  const next = { ...persistedDaemon };
  if (persistRelayEnabled && patch.relay?.enabled !== undefined) next.relay = { ...next.relay, enabled: patch.relay.enabled };
  if (patch.mcp?.injectIntoAgents !== undefined) next.mcp = { ...next.mcp, injectIntoAgents: patch.mcp.injectIntoAgents };
  if (patch.browserTools?.enabled !== undefined) next.browserTools = { ...next.browserTools, enabled: patch.browserTools.enabled };
  if (patch.autoArchiveAfterMerge !== undefined) next.autoArchiveAfterMerge = patch.autoArchiveAfterMerge;
  if (patch.enableTerminalAgentHooks !== undefined) next.enableTerminalAgentHooks = patch.enableTerminalAgentHooks;
  if (patch.appendSystemPrompt !== undefined) next.appendSystemPrompt = patch.appendSystemPrompt;
  if (patch.terminalProfiles !== undefined) next.terminalProfiles = patch.terminalProfiles;
  if (patch.agentProfiles !== undefined) next.agentProfiles = patch.agentProfiles;
  return Object.keys(next).length > 0 ? next : undefined;
}
function mergeMutableAgentPatch(persistedAgents, patch, removeProviders) {
  if (patch.providers === undefined && patch.metadataGeneration === undefined && patch.skills === undefined && removeProviders.length === 0) {
    return persistedAgents;
  }
  const next = { ...persistedAgents };
  const persistedOverrides = omitProvidersFromOverrides(persistedAgents?.providers, removeProviders);
  const providerOverrides = applyMutableProviderConfigToOverrides(persistedOverrides, patch.providers);
  if (providerOverrides) next.providers = providerOverrides;
  else delete next.providers;
  if (patch.metadataGeneration?.providers !== undefined) {
    next.metadataGeneration = { providers: patch.metadataGeneration.providers };
  } else if (removeProviders.length > 0 && persistedAgents?.metadataGeneration?.providers) {
    const removed = new Set(removeProviders);
    next.metadataGeneration = {
      providers: persistedAgents.metadataGeneration.providers.filter(entry => !removed.has(entry.provider)),
    };
  }
  if (patch.skills?.selection !== undefined) next.skills = { selection: patch.skills.selection };
  return Object.keys(next).length > 0 ? next : undefined;
}
function mergeMutablePatchIntoPersistedConfig({ persisted, patch, removeProviders, persistRelayEnabled }) {
  const daemon = mergeMutableDaemonPatch(persisted.daemon, patch, persistRelayEnabled);
  const agents = mergeMutableAgentPatch(persisted.agents, patch, removeProviders);
  return {
    ...persisted,
    ...(patch.pluginsEnabled !== undefined ? { pluginsEnabled: patch.pluginsEnabled } : {}),
    ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
    ...(daemon ? { daemon } : { daemon: undefined }),
    ...(agents ? { agents } : { agents: undefined }),
  };
}
function miniLoadPersisted(home) {
  const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const result = PinnedPersistedConfigSchema.safeParse(stripRemovedConfigFields(raw));
  if (!result.success) throw new Error(`Invalid config: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return result.data;
}
function miniSavePersisted(home, config) {
  const result = PinnedPersistedConfigSchema.safeParse(config);
  if (!result.success) throw new Error(`Invalid config to save: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  writeFileSync(join(home, 'config.json'), JSON.stringify(result.data, null, 2) + '\n', { mode: 0o600 });
}
const isEqualValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export class MiniStore {
  constructor(home, overrides = {}) {
    this.home = home;
    this.current = MutableDaemonConfigSchema.parse({
      ...initialMutable(miniLoadPersisted(home), overrides),
      relay: { enabled: true },
    });
  }
  get() {
    return this.current;
  }
  patch(partial) {
    const parsedPatch = pickSupportedPatchFields(MutableDaemonConfigPatchSchema.parse(partial));
    const { removeProviders = [], ...configPatch } = parsedPatch;
    const removed = [...new Set(removeProviders)];
    const merged = deepMerge(this.current, configPatch);
    if (parsedPatch.skills?.selection !== undefined) merged.skills = { selection: parsedPatch.skills.selection };
    if (parsedPatch.plugins !== undefined) merged.plugins = parsedPatch.plugins;
    const next = MutableDaemonConfigSchema.parse(
      omitMetadataGenerationProvidersFromConfig(omitProvidersFromConfig(merged, removed), removed),
    );
    const configChanged = !isEqualValue(this.current, next);
    if (!configChanged && removed.length === 0) return this.current;
    const persisted = miniLoadPersisted(this.home);
    const nextPersisted = mergeMutablePatchIntoPersistedConfig({
      persisted,
      patch: configPatch,
      removeProviders: removed,
      persistRelayEnabled: true,
    });
    miniSavePersisted(this.home, nextPersisted);
    this.current = next;
    return this.current;
  }
}
export function initialMutable(persisted, overrides = {}) {
  return {
    relay: { enabled: persisted.daemon?.relay?.enabled ?? true },
    mcp: {
      enabled: overrides.mcpEnabled ?? persisted.daemon?.mcp?.enabled ?? true,
      injectIntoAgents: overrides.mcpInjectIntoAgents ?? persisted.daemon?.mcp?.injectIntoAgents ?? false,
    },
    cors: { allowedOrigins: persisted.daemon?.cors?.allowedOrigins ?? [] },
    trustedProxies: persisted.daemon?.trustedProxies ?? ['loopback'],
    providers: persisted.agents?.providers ?? {},
    metadataGeneration: { providers: persisted.agents?.metadataGeneration?.providers ?? [] },
    autoArchiveAfterMerge: persisted.daemon?.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: persisted.daemon?.enableTerminalAgentHooks ?? false,
    appendSystemPrompt: persisted.daemon?.appendSystemPrompt ?? '',
    pluginsEnabled: persisted.pluginsEnabled ?? false,
    plugins: persisted.plugins ?? {},
    ...(persisted.daemon?.agentProfiles !== undefined ? { agentProfiles: persisted.daemon.agentProfiles } : {}),
    ...(persisted.daemon?.terminalProfiles !== undefined ? { terminalProfiles: persisted.daemon.terminalProfiles } : {}),
  };
}

// ---------------------------------------------------------------------------
// Honest seam doubles — real filesystem work, failure injection stays external
// ---------------------------------------------------------------------------

export function makePayload(fileContents = { 'bin/slp-shim.mjs': '#!/usr/bin/env node\n', 'roles/peer.md': '# peer\n' }) {
  const files = Object.entries(fileContents).map(([path, text]) => {
    const bytes = Buffer.from(text);
    return { path, sha256: sha256(bytes), mode: 0o644, base64: bytes.toString('base64') };
  });
  const candidateFiles = files.map(({ path, sha256: s }) => ({ path, sha256: s }));
  return {
    schemaVersion: 1,
    candidate: { sha256: sha256(JSON.stringify(candidateFiles)), files: candidateFiles },
    payloadSha256: sha256(JSON.stringify(files.map(({ path, sha256: s, mode }) => ({ path, sha256: s, mode })))),
    files,
  };
}

export function makeMaterializer(payload, hooks = {}) {
  return {
    async materialize(stableRoot, operationId) {
      await hooks.beforeMaterialize?.(operationId);
      const staging = join(stableRoot, '.staging', operationId);
      const dest = join(stableRoot, payload.candidate.sha256);
      mkdirSync(staging, { recursive: true });
      for (const f of payload.files) {
        const target = join(staging, f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(f.base64, 'base64'), { mode: f.mode });
        if (sha256(readFileSync(target)) !== f.sha256) throw new OperationConflict('RUNTIME_INTEGRITY', `staged ${f.path} hash mismatch`);
      }
      writeFileSync(join(staging, 'installed.json'), JSON.stringify({ schemaVersion: 1, candidate: payload.candidate, payloadSha256: payload.payloadSha256 }, null, 2) + '\n');
      const dropStagingParent = () => {
        try {
          rmdirSync(join(stableRoot, '.staging'));
        } catch {
          /* sibling staging dirs may remain */
        }
      };
      if (existsSync(dest)) {
        rmSync(staging, { recursive: true, force: true });
        dropStagingParent();
        await this.verifyPublished(dest);
        return { candidateSha256: payload.candidate.sha256, payloadSha256: payload.payloadSha256, runtimePath: dest, reused: true };
      }
      renameSync(staging, dest);
      dropStagingParent();
      return { candidateSha256: payload.candidate.sha256, payloadSha256: payload.payloadSha256, runtimePath: dest, reused: false };
    },
    async verifyPublished(runtimePath, candidateSha256, payloadSha256) {
      if (candidateSha256 !== undefined && candidateSha256 !== payload.candidate.sha256) {
        throw new OperationConflict('RUNTIME_INTEGRITY', `recorded candidate ${candidateSha256} does not match embedded ${payload.candidate.sha256}`);
      }
      if (payloadSha256 !== undefined && payloadSha256 !== payload.payloadSha256) {
        throw new OperationConflict('RUNTIME_INTEGRITY', `recorded payload ${payloadSha256} does not match embedded ${payload.payloadSha256}`);
      }
      const installedPath = join(runtimePath, 'installed.json');
      if (!existsSync(installedPath)) throw new OperationConflict('RUNTIME_INTEGRITY', `${runtimePath} lacks installed.json`);
      const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
      if (candidateSha256 !== undefined && installed.candidate?.sha256 !== candidateSha256) {
        throw new OperationConflict('RUNTIME_INTEGRITY', `${runtimePath} installed.json candidate does not match the recorded identity`);
      }
      if (payloadSha256 !== undefined && installed.payloadSha256 !== payloadSha256) {
        throw new OperationConflict('RUNTIME_INTEGRITY', `${runtimePath} installed.json payload does not match the recorded identity`);
      }
      for (const f of payload.files) {
        const target = join(runtimePath, f.path);
        if (!existsSync(target) || sha256(readFileSync(target)) !== f.sha256) throw new OperationConflict('RUNTIME_INTEGRITY', `${target} missing or corrupted`);
      }
    },
    async discardStaging(stableRoot, operationId) {
      rmSync(join(stableRoot, '.staging', operationId), { recursive: true, force: true });
      try {
        rmdirSync(join(stableRoot, '.staging'));
      } catch {
        /* sibling staging dirs may remain */
      }
    },
  };
}

const LAUNCHER_MODE = 0o755;

export function makeLaunchers(hooks = {}) {
  // Mirrors the real builder: all twelve owned ids get a launch-set file —
  // devin shim launchers plus the Phase-2 hook-family gate launchers.
  const launcherIds = () => OWNED_IDS.slice().sort();
  const launcherBytes = (req, id) =>
    `#!/bin/sh\nexec "${req.node.path}" "${req.candidate.runtimePath}/bin/slp-shim.mjs" "${id}"\n`;
  const manifestBytes = req => JSON.stringify({
    version: 1,
    daemonHome: req.daemonHome,
    candidate: req.candidate,
    node: req.node,
    binaries: req.binaries,
    launchers: launcherIds().map(id => ({ id, sha256: sha256(launcherBytes(req, id)), mode: LAUNCHER_MODE })),
  }, null, 2) + '\n';
  const setSha = (manifestSha, files) => sha256(manifestSha + files.map(f => f.sha256).join(''));
  return {
    async publish(req) {
      await hooks.beforePublish?.();
      const manifest = manifestBytes(req);
      const manifestSha = sha256(manifest);
      const files = launcherIds().map(id => ({ sha256: sha256(launcherBytes(req, id)), mode: LAUNCHER_MODE, id, path: null }));
      const dirSha = setSha(manifestSha, files);
      const dir = join(req.stableRoot, 'launchers', dirSha);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'launch.json'), manifest);
      for (const f of files) {
        f.path = join(dir, f.id);
        writeFileSync(f.path, launcherBytes(req, f.id), { mode: LAUNCHER_MODE });
      }
      return { launchSetSha256: dirSha, launchManifestSha256: manifestSha, directory: dir, files: files.map(({ path, sha256: s, mode }) => ({ path, sha256: s, mode })) };
    },
    async verify(directory) {
      const manifestPath = join(directory, 'launch.json');
      if (!existsSync(manifestPath)) throw new OperationConflict('RUNTIME_INTEGRITY', `${directory} lacks launch.json`);
      const read = readFileSync(manifestPath);
      const manifestSha = sha256(read);
      const manifest = JSON.parse(read.toString('utf8'));
      const files = manifest.launchers.map(entry => ({ path: join(directory, entry.id), sha256: entry.sha256, mode: entry.mode }));
      const dirSha = setSha(manifestSha, files);
      if (dirSha !== directory.split('/').pop()) throw new OperationConflict('RUNTIME_INTEGRITY', `${directory} name does not match manifest digest`);
      for (const f of files) {
        if (!existsSync(f.path) || sha256(readFileSync(f.path)) !== f.sha256) throw new OperationConflict('RUNTIME_INTEGRITY', `${f.path} missing or corrupted`);
        if ((lstatSync(f.path).mode & 0o777) !== f.mode) throw new OperationConflict('RUNTIME_INTEGRITY', `${f.path} mode drifted`);
      }
      return { launchSetSha256: dirSha, launchManifestSha256: manifestSha, directory, files: files.map(({ path, sha256: s, mode }) => ({ path, sha256: s, mode })) };
    },
  };
}

export function makeExecutables(opts = {}) {
  const isAbsolute = p => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p));
  return {
    async resolve(req) {
      const nodePath = req.nodePath ?? req.prior?.node?.path ?? opts.node ?? process.execPath;
      if (req.nodePath !== undefined && (!isAbsolute(req.nodePath) || !existsSync(req.nodePath))) {
        throw new OperationConflict('EXECUTABLE_UNAVAILABLE', `explicit nodePath ${req.nodePath} is not usable`);
      }
      const binaries = {};
      for (const family of FAMILIES) {
        const explicit = req.binaries?.[family];
        const prior = req.prior?.binaries?.[family];
        const candidate = explicit ?? (prior?.available ? prior.path : undefined) ?? opts.binaries?.[family];
        if (explicit !== undefined && (!isAbsolute(explicit) || !existsSync(explicit))) {
          throw new OperationConflict('EXECUTABLE_UNAVAILABLE', `explicit ${family} binary ${explicit} is not usable`);
        }
        if (candidate !== undefined && existsSync(candidate)) {
          binaries[family] = { available: true, path: candidate, version: opts.versions?.[family] ?? '1.0.0-test' };
        } else {
          binaries[family] = { available: false, path: null, version: null };
        }
      }
      return { node: { path: nodePath, version: process.version }, binaries };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake daemon — real store semantics + injectable failures
// ---------------------------------------------------------------------------

export async function makeDaemon(t, home, opts = {}) {
  const backend = await loadRealBackend();
  let store;
  let using = 'mini';
  if (backend && !opts.forceMini) {
    const persisted = backend.loadPersistedConfig(home);
    store = new backend.DaemonConfigStore(home, initialMutable(persisted, opts.overrides), undefined, {
      startupPersisted: persisted,
      relayEnabledMutable: true,
    });
    using = 'real';
  } else {
    store = new MiniStore(home, opts.overrides);
  }
  const patchCalls = [];
  let getCalls = 0;
  const daemon = {
    __backend: using,
    __store: store,
    patchCalls,
    get getCalls() {
      return getCalls;
    },
    config: {
      async get(requestId) {
        getCalls += 1;
        return { requestId: requestId ?? randomUUID(), config: store.get() };
      },
      patch(patch, requestId) {
        const index = patchCalls.length;
        patchCalls.push(structuredClone(patch));
        const script = opts.patchScript?.[index] ?? 'ok';
        if (script === 'sync-throw') throw new Error('injected synchronous dispatch failure');
        return (async () => {
          if (script === 'reject') throw new Error('injected patch rejection');
          if (script === 'hang') return new Promise(() => {});
          store.patch(patch);
          if (script === 'apply-then-reject') throw new Error('injected lost response');
          return { requestId: requestId ?? randomUUID(), config: store.get() };
        })();
      },
    },
  };
  return daemon;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

export function makeHome(t, config) {
  const home = mkdtempSync(join(tmpdir(), 'slp-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), JSON.stringify(config ?? { version: 1, daemon: { mcp: { enabled: true } } }, null, 2) + '\n', { mode: 0o600 });
  return home;
}

export function makeBinaries(t, families = FAMILIES) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-bin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binaries = {};
  for (const family of families) {
    const path = join(dir, `${family}-bin`);
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    binaries[family] = path;
  }
  return binaries;
}

export const POISON_UUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
let uuidSalt = 0;
export function seqUuid() {
  const salt = String(++uuidSalt).padStart(4, '0') + '0000';
  let n = 0;
  return () => `${salt}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}
/** Counted uuid() with poison indices: poisonOnly hits one call, poisonFrom hits all ≥ n.
 *  Each instance carries a distinct salt so every manager's bootId differs. */
export function makeUuid() {
  const salt = String(++uuidSalt).padStart(4, '0') + '0000';
  const state = { n: 0, poisonFrom: null, poisonOnly: null };
  const uuid = () => {
    state.n += 1;
    if (state.poisonOnly === state.n) return POISON_UUID;
    if (state.poisonFrom !== null && state.n >= state.poisonFrom) return POISON_UUID;
    return `${salt}-0000-4000-8000-${String(state.n).padStart(12, '0')}`;
  };
  return { uuid, state };
}
// Offsets from the operation boundary, after the manager's bootId. These are
// characterization of UUID consumption, not production fault hooks. Recovery
// tests must still prove the durable phase/patch state so mapping drift is loud.
const recoveryFaultPoints = {
  activate: { accepted: 1, materialized: 2, prepared: 3, 'request-id': 4, 'patch-dispatched': 5, settled: 6, verified: 7, committed: 8 },
  deactivate: { accepted: 1, prepared: 2, 'request-id': 3, 'patch-dispatched': 4, settled: 5, verified: 6, committed: 7 },
  'adopt-identical': { verified: 4 },
  'complete-after': { finalized: 2 },
  'restore-before': { 'patch-dispatched': 2 },
  inspect: { 'subject-marked': 2 },
};

// Arm before creating the manager or immediately before its next operation.
// Blockers stay explicit: FILE fails once (cleanup removes it); DIR keeps
// failing, including recordFailure, leaving an interrupted pending operation.
export function armRecoveryFault(deps, operation, point, { once = false } = {}) {
  const offset = recoveryFaultPoints[operation]?.[point];
  if (!Number.isInteger(offset)) throw new Error(`Unknown recovery fault point: ${operation}/${point}`);
  const state = deps.uuidBox.state;
  const boundary = state.n || 1; // a not-yet-created manager still needs its bootId
  state[once ? 'poisonOnly' : 'poisonFrom'] = boundary + offset;
}

export function seqNow() {
  let t = Date.parse('2026-09-18T00:00:00.000Z');
  return () => new Date((t += 1000));
}

export function makeDeps(opts = {}) {
  const payload = opts.payload ?? makePayload();
  const uuidBox = opts.uuidBox ?? (opts.uuid ? null : makeUuid());
  return {
    payload,
    materializer: opts.materializer ?? makeMaterializer(payload, opts.materializerHooks),
    executables: opts.executables ?? makeExecutables(opts.execOpts),
    launchers: opts.launchers ?? makeLaunchers(opts.launcherHooks),
    now: opts.now ?? seqNow(),
    uuid: opts.uuid ?? uuidBox.uuid,
    uuidBox,
    platform: opts.platform,
  };
}

// A fresh daemon and its matching filesystem/dependency fixtures. Leave
// manager creation and operation starts to the test: crash cases must be able
// to install journal blockers before the manager consumes its first UUID.
export async function makePluginFixture(t, config) {
  const home = makeHome(t, config);
  const binaries = makeBinaries(t);
  const daemon = await makeDaemon(t, home);
  const deps = makeDeps({ execOpts: { binaries } });
  return { home, binaries, daemon, deps };
}

export const authority = { exclusiveAdministrativeWindow: true, verifiedHostHomeMapping: true };
export const targetOf = home => ({ hostId: 'test-host', daemonHome: home });
export function activateInput(home, payload, operationId, extra = {}) {
  return { schemaVersion: 1, target: targetOf(home), operationId, authority, candidateSha256: payload.candidate.sha256, adoptIdentical: false, binaries: {}, ...extra };
}
export function deactivateInput(home, operationId, expectedBindingSha256) {
  return { schemaVersion: 1, target: targetOf(home), operationId, authority, expectedBindingSha256 };
}
export function reconcileInput(home, operationId, action, interruptedOperationId) {
  return { schemaVersion: 1, target: targetOf(home), operationId, authority, action, ...(interruptedOperationId ? { interruptedOperationId } : {}) };
}
export function statusInput(home, operationId) {
  return { schemaVersion: 1, target: targetOf(home), ...(operationId ? { operationId } : {}) };
}

export const receiptPath = home => join(home, 'slp-runtime', 'state', 'receipt.json');
export function readReceipt(home) {
  return JSON.parse(readFileSync(receiptPath(home), 'utf8'));
}
export function opOf(home, operationId) {
  return readReceipt(home).operations.find(o => o.operationId === operationId);
}
export function opCodes(home, operationId) {
  return (opOf(home, operationId)?.conflicts ?? []).map(c => c.code);
}
export const opConflicts = opCodes;

const blockerPath = home => join(home, 'slp-runtime', 'state', `receipt.json.${POISON_UUID}.tmp`);
export function fileBlocker(home) {
  mkdirSync(dirname(blockerPath(home)), { recursive: true });
  writeFileSync(blockerPath(home), 'journal fault injection', { mode: 0o600 });
}
export function dirBlocker(home) {
  mkdirSync(blockerPath(home), { recursive: true });
}

export async function waitTerminal(manager, home, operationId, daemon, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = await manager.status(statusInput(home, operationId), daemon);
    if (out.operation && out.operation.outcome !== 'pending') return out;
    if (Date.now() > deadline) throw new Error(`operation ${operationId} never settled`);
    await new Promise(r => setTimeout(r, 15));
  }
}
/** Wait until the crashing manager observes its own op as interrupted. */
export async function waitRecovery(manager, home, daemon, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = await manager.status(statusInput(home), daemon);
    if (out.state === 'RECOVERY_REQUIRED') return out;
    if (Date.now() > deadline) throw new Error('worker never reached dead/interrupted state');
    await new Promise(r => setTimeout(r, 10));
  }
}
export function readConfigJson(home) {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
}
export function slpProvidersOf(config) {
  const providers = config.agents?.providers ?? {};
  return Object.fromEntries(Object.entries(providers).filter(([id]) => OWNED_IDS.includes(id)));
}
