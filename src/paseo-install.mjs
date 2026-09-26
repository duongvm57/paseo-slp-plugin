import { existsSync, readFileSync, writeFileSync, rmSync, lstatSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { json, readJson, hash, identity, install, verifyInstall, files, stageInstall, swapIn, verifyReplaceable } from './package.mjs';
import { roles, profileRoles, families, profileId, providerId } from './profiles.mjs';
import { transportOf } from './binding.mjs';
import { validateCatalog, routingPath, probeUserPool, catalogPoolDrift } from './routing.mjs';
import { configFile, writeConfig, mcpFlags, requireMcp, verifyOwnedProviders, verifyOwnedProfiles,
  providers as hostProviders, agentProfiles as hostAgentProfiles } from './host-config.mjs';

// Platform data dir: %LOCALAPPDATA% on Windows, ~/Library/Application Support
// on macOS, $XDG_DATA_HOME (~/.local/share) elsewhere.
export function installHome(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'paseo-slp');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'paseo-slp');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'paseo-slp');
}

// Default saved-profile family follows the host's enabled base provider; every
// role family is still installed, so this only picks the starting default.
function defaultFamily(config) {
  const provs = hostProviders(config);
  return families.find(family => provs[family]?.enabled === true) ?? 'codex';
}

export function configurationPlan(destination, config) {
  const providers = {}, profiles = [];
  const existing = hostAgentProfiles(config);
  const family = defaultFamily(config);
  for (const role of roles) for (const family of families) {
    const id = providerId(role, family);
    if (Object.hasOwn(hostProviders(config), id) || (profileRoles.includes(role) && existing.some(p => p.id === profileId(role)))) {
      throw new Error(`SLP entry already exists: ${role}; uninstall its owning installation first`);
    }
    providers[id] = { extends: transportOf(family), label: `SLP ${family} ${role}`, command: [process.execPath, join(destination, `bin/${family}-role.mjs`), role] };
  }
  for (const role of profileRoles) {
    profiles.push({ id: profileId(role), name: `SLP ${role[0].toUpperCase() + role.slice(1)}`,
      provider: providerId(role, family),
      notes: `SLP ${role}; installed role instructions load automatically. Use Paseo delegation and finish notifications.` });
  }
  return { providers, profiles };
}

export function installPaseo(source, destination, home, apply = false) {
  destination = resolve(destination);
  const homeWithinInstall = relative(destination, resolve(home));
  if (!homeWithinInstall || (!homeWithinInstall.startsWith('..') && !isAbsolute(homeWithinInstall))) throw new Error('Paseo home must be outside the installation directory');
  const file = configFile(home);
  if (existsSync(destination)) {
    // A pre-existing directory that was never installed would crash inside
    // verifyInstall with a raw ENOENT — report the business condition instead.
    if (!existsSync(join(destination, 'installed.json')))
      throw new Error(`Not an installed SLP directory (missing installed.json): ${destination} — install the runtime there first`);
    const manifest = verifyInstall(destination);
    const binding = readJson(join(destination, 'paseo-binding.json'));
    if (binding.configPath !== file.path) throw new Error('Installation belongs to a different Paseo home');
    verifyOwnedProviders(file.config, binding.providers);
    const saved = verifyOwnedProfiles(file.config, binding.profiles, 'bound');
    requireMcp(file.config);
    if (manifest.candidate.sha256 === identity(source).sha256)
      return { destination, configPath: file.path, applied: false, alreadyInstalled: true, reloadRequired: true };
    return updatePaseo(source, destination, file, binding, saved, apply);
  }
  const proposal = configurationPlan(destination, file.config);
  const result = { destination, configPath: file.path, applied: apply, ...proposal,
    mcp: { enabled: true, injectIntoAgents: true }, reloadRequired: true };
  if (!apply) return result;
  const candidate = install(source, destination).candidate;
  const next = structuredClone(file.config);
  next.agents ??= {};
  next.agents.providers = { ...next.agents.providers, ...proposal.providers };
  next.daemon ??= {};
  next.daemon.agentProfiles = [...(next.daemon.agentProfiles ?? []), ...proposal.profiles];
  const mcpBefore = Object.fromEntries(mcpFlags.map(key => [key, next.daemon.mcp?.[key] ?? null]));
  next.daemon.mcp = { ...next.daemon.mcp, ...Object.fromEntries(mcpFlags.map(key => [key, true])) };
  try {
    // Only owned entries and two shared MCP flags are recorded, never credentials.
    mkdirSync(home, { recursive: true });
    const binding = json({ configPath: file.path, ...proposal, mcpBefore });
    writeFileSync(join(destination, 'paseo-binding.json'), binding, { flag: 'wx', mode: 0o600 });
    const manifest = readJson(join(destination, 'installed.json'));
    writeFileSync(join(destination, 'installed.json'), json({ ...manifest, paseoBindingSha256: hash(binding) }));
    writeConfig(file, next);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { ...result, candidate };
}

// In-place update of an intact installation: provider commands keep pointing
// at the same paths, so only files, the binding receipt and installed.json
// change. Staged and swapped as one move; a drifted install was already
// refused by verifyInstall, and extra files are refused rather than silently
// dropped by the swap. Human-modified profiles keep their settings.
function updatePaseo(source, destination, file, prior, saved, apply) {
  const manifest = verifyInstall(destination);
  verifyReplaceable(destination, manifest);
  const base = structuredClone(file.config);
  for (const id of Object.keys(prior.providers)) delete base.agents.providers[id];
  base.daemon.agentProfiles = base.daemon.agentProfiles.filter(p => !saved.has(p.id));
  const proposal = configurationPlan(destination, base);
  proposal.profiles = proposal.profiles.map(p => saved.get(p.id) ?? p);
  const retiredProfiles = [...saved.values()].filter(profile => !proposal.profiles.some(p => p.id === profile.id));
  const result = { destination, configPath: file.path, applied: apply, ...proposal,
    updated: true, retiredProfiles: retiredProfiles.map(p => p.id), reloadRequired: true };
  if (!apply) return result;
  const { staging, candidate } = stageInstall(source, destination);
  try {
    const binding = json({ configPath: file.path, ...proposal, mcpBefore: prior.mcpBefore,
      retiredProfiles: [...(prior.retiredProfiles ?? []), ...retiredProfiles] });
    writeFileSync(join(staging, 'paseo-binding.json'), binding, { flag: 'wx', mode: 0o600 });
    const staged = readJson(join(staging, 'installed.json'));
    writeFileSync(join(staging, 'installed.json'), json({ ...staged, paseoBindingSha256: hash(binding) }));
    verifyInstall(staging);
    const next = structuredClone(base);
    next.agents.providers = { ...next.agents.providers, ...proposal.providers };
    next.daemon.agentProfiles = [...next.daemon.agentProfiles, ...proposal.profiles];
    const replaced = swapIn(staging, destination);
    try { writeConfig(file, next); rmSync(replaced, { recursive: true, force: true }); }
    catch (error) {
      rmSync(destination, { recursive: true, force: true });
      renameSync(replaced, destination);
      throw error;
    }
    return { ...result, candidate };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function uninstallPaseo(destination, apply = false) {
  verifyInstall(destination);
  const bindingPath = join(destination, 'paseo-binding.json');
  const binding = readJson(bindingPath);
  const file = configFile(resolve(binding.configPath, '..'));
  const next = structuredClone(file.config);
  verifyOwnedProviders(next, binding.providers);
  for (const id of Object.keys(binding.providers)) delete next.agents.providers[id];
  verifyOwnedProfiles(next, binding.profiles, 'exact');
  next.daemon.agentProfiles = next.daemon.agentProfiles.filter(p => !binding.profiles.some(owned => owned.id === p.id));
  for (const [key, before] of Object.entries(binding.mcpBefore)) {
    if (next.daemon.mcp?.[key] !== true) throw new Error(`Modified MCP setting ${key}; preserve installation`);
    if (before === null) delete next.daemon.mcp[key]; else next.daemon.mcp[key] = before;
  }
  // Validate removal before detaching host entries, including user-added files.
  const candidate = verifyInstall(destination).candidate;
  const expectedPaths = [...candidate.files.map(f => f.path), 'installed.json', 'paseo-binding.json'].sort();
  if (!isDeepStrictEqual(files(destination).sort(), expectedPaths)) throw new Error('Extra files: preserve directory for manual review');
  if (apply) {
    writeConfig(file, next);
    rmSync(destination, { recursive: true });
  }
  return { destination, configPath: file.path, applied: apply, reloadRequired: true };
}

// Explicit side-by-side cutover: keep the old bytes for sessions already using them.
export function upgradePaseo(source, destination, previous, apply = false) {
  if (!isAbsolute(destination) || !isAbsolute(previous)) throw new Error('Absolute new and previous installation paths required');
  destination = resolve(destination); previous = resolve(previous);
  const within = relative(previous, destination);
  if (!within || (!within.startsWith('..') && !isAbsolute(within))) throw new Error('New installation must be outside the previous installation');
  if (existsSync(destination)) throw new Error('Upgrade requires a new destination');
  const priorManifest = verifyInstall(previous);
  if (!priorManifest.paseoBindingSha256) throw new Error('Upgrade requires a Paseo-integrated previous installation');
  const prior = readJson(join(previous, 'paseo-binding.json'));
  const home = resolve(prior.configPath, '..');
  const homeWithinInstall = relative(destination, home);
  if (!homeWithinInstall || (!homeWithinInstall.startsWith('..') && !isAbsolute(homeWithinInstall))) throw new Error('Paseo home must be outside the installation directory');
  const file = configFile(home);
  const base = structuredClone(file.config);
  verifyOwnedProviders(base, prior.providers, 'previous installation');
  for (const id of Object.keys(prior.providers)) delete base.agents.providers[id];
  const saved = verifyOwnedProfiles(base, prior.profiles, 'bound');
  base.daemon.agentProfiles = base.daemon.agentProfiles.filter(p => !saved.has(p.id));
  const proposal = configurationPlan(destination, base);
  proposal.profiles = proposal.profiles.map(p => saved.get(p.id) ?? p);
  const retainedIds = new Set(proposal.profiles.map(profile => profile.id));
  const retiredProfiles = [...saved.values()].filter(profile => !retainedIds.has(profile.id));
  const result = { destination, retainedInstallation: previous, configPath: file.path, applied: apply, ...proposal,
    retiredProfiles: retiredProfiles.map(profile => profile.id), reloadRequired: true };
  if (!apply) return result;
  const candidate = install(source, destination).candidate;
  try {
    const next = structuredClone(base);
    next.agents.providers = { ...next.agents.providers, ...proposal.providers };
    next.daemon.agentProfiles = [...next.daemon.agentProfiles, ...proposal.profiles];
    const binding = json({ configPath: file.path, ...proposal, mcpBefore: prior.mcpBefore,
      retiredProfiles: [...(prior.retiredProfiles ?? []), ...retiredProfiles] });
    requireMcp(next);
    writeFileSync(join(destination, 'paseo-binding.json'), binding, { flag: 'wx', mode: 0o600 });
    const manifest = readJson(join(destination, 'installed.json'));
    writeFileSync(join(destination, 'installed.json'), json({ ...manifest, paseoBindingSha256: hash(binding) }));
    writeConfig(file, next);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { ...result, candidate };
}

const lstat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

// Check all existing targets and ancestors before mutation, including dangling links.
function stageEntries(entries, repository, apply) {
  for (const entry of entries) {
    for (let parent = resolve(entry.path, '..'); parent !== resolve(repository); parent = resolve(parent, '..')) {
      const stat = lstat(parent);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Expected repo directory: ${parent}`);
      if (parent === resolve(parent, '..')) throw new Error('Repo file path escaped repository');
    }
    const stat = lstat(entry.path);
    if (stat && !stat.isFile()) throw new Error(`Expected regular repo file: ${entry.path}`);
    entry.preserved = Boolean(stat);
  }
  const result = entries.map(({ path, bytes, preserved }) => ({ path, preserved, applied: apply && !preserved, ...(!preserved ? { sha256: hash(bytes) } : {}) }));
  if (apply) {
    for (const { path, bytes, preserved } of entries) {
      if (preserved) continue;
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path, bytes, { flag: 'wx' });
    }
  }
  return result;
}

export function initWorkspace(source, repository, apply = false, routingFrom) {
  const catalogPath = routingPath(repository);
  repository = resolve(catalogPath, '../..');
  // Validate an explicit import before writing any repo files. Never consult host defaults.
  if (routingFrom != null && !isAbsolute(routingFrom)) throw new Error('Absolute --routing-from path required');
  // A repository catalog is a deliberate opt-in: init writes it only for an
  // explicit --routing-from import. With no repo file the runtime resolves the
  // plugin-owned user-scope pool instead.
  const catalog = routingFrom == null ? null : validateCatalog(readJson(routingFrom));
  const entries = [
    { path: join(repository, '.paseo-slp/workspace-protocol.md'), bytes: readFileSync(join(source, 'src/templates/workspace-protocol.md')) },
    ...(catalog === null ? [] : [{ path: catalogPath, bytes: json(catalog) }]),
    { path: join(repository, '.paseo-slp/notebook.md'), bytes: '# Supervisor notebook\n\nPurpose and owner are recorded in .paseo-slp/workspace-protocol.md.\n' },
  ];
  const result = stageEntries(entries, repository, apply);
  return { repository, files: result, applied: result.some(file => file.applied), preserved: result.every(file => file.preserved) };
}

// Rebase absolute paths inside the simple `key: 'value'` frontmatter from the
// source root to the target root; a prefix replace on that block is
// sufficient — no YAML parser. The source match must end at a path boundary
// ('/', a non-path character or end of value) so a longer sibling path like
// `<source>-old` is left alone. Reports whether anything was rebased.
function rebaseFrontmatter(text, source, target) {
  if (source === target || !text.startsWith('---\n')) return { text, rebased: false };
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) return { text, rebased: false };
  const frontmatter = text.slice(0, end);
  const pattern = new RegExp(`${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|/|[^\\w.~+-])`, 'g');
  if (!pattern.test(frontmatter)) return { text, rebased: false };
  return { text: frontmatter.replace(pattern, target) + text.slice(end), rebased: true };
}

// An --include path is a repository-relative POSIX path: no absolute or
// drive-prefixed forms, no backslashes, no empty/dot/dot-dot segments — the
// same shape rules the plugin payload enforces. `.paseo-slp` stays managed by
// the materialize contract itself, never through includes.
function includeRelative(raw) {
  const valid = typeof raw === 'string' && raw.length > 0 && !raw.includes('\0') && !raw.includes('\\')
    && !raw.startsWith('/') && !/^[A-Za-z]:/.test(raw)
    && raw.split('/').every(part => part !== '' && part !== '.' && part !== '..');
  if (!valid) throw new Error(`Invalid include path — a repository-relative POSIX path is required: ${JSON.stringify(raw)}`);
  if (raw === '.paseo-slp' || raw.startsWith('.paseo-slp/')) {
    throw new Error(`Include path ${raw} is managed by materialize — .paseo-slp entries stage from the protocol/catalog/references contract, not --include`);
  }
  return raw;
}

// Recursive copy plan: regular files only — a symlink or anything else
// exotic is refused loudly rather than followed or silently skipped.
function collectIncludes(root, rel, out, label = 'Include path') {
  const stat = lstat(join(root, rel));
  if (stat == null) throw new Error(`${label} does not exist in the source checkout: ${rel}`);
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink, not copied: ${rel}`);
  if (stat.isFile()) { out.set(rel, readFileSync(join(root, rel))); return; }
  if (!stat.isDirectory()) throw new Error(`${label} is not a regular file or directory: ${rel}`);
  for (const name of readdirSync(join(root, rel)).sort()) collectIncludes(root, `${rel}/${name}`, out, label);
}

// Clone an initialized checkout's .paseo-slp into a target checkout: a fresh
// worktree lacks the gitignored local state, and a manual copy leaves source
// absolute paths behind. Explicit source only — never the user-scope catalog
// or the package template. references/ — the operational facts the protocol
// points to — travels with it when present, so no pointer dangles.
// notebook.md is Supervisor-owned state and is deliberately not copied.
// `options.includePaths` stages additional repository-relative files
// (untracked spec/evidence the seats must see) — copied verbatim, deduped by
// target path, preserved when already present.
// `options.home` enables the advisory catalog↔live-pool drift report.
export function materializeWorkspace(from, repository, apply = false, options = {}) {
  const { includePaths = [], home = null } = options;
  const source = resolve(routingPath(from), '../..');
  repository = resolve(routingPath(repository), '../..');
  const sourceFile = name => {
    const path = join(source, '.paseo-slp', name);
    if (!lstat(path)?.isFile()) throw new Error(`Source checkout lacks .paseo-slp/${name}`);
    return path;
  };
  // The catalog is a deliberate repo pin, not an init default — a source that
  // never created one materializes the protocol alone and the target resolves
  // the user-scope pool exactly like the source does. When the source does
  // pin a catalog, read it once and validate those exact bytes: the target
  // keeps them verbatim so a route.catalogSha256 pinned against the source
  // stays valid after materialize — reserializing the parsed object would
  // drift formatting and hash.
  const catalogSource = join(source, '.paseo-slp', 'slp-routing.json');
  const catalogBytes = lstat(catalogSource)?.isFile() ? readFileSync(catalogSource) : null;
  const catalog = catalogBytes === null ? null : validateCatalog(JSON.parse(catalogBytes.toString('utf8')));
  // Advisory cross-check with the live user-scope pool — the staged catalog
  // and the pool are two Human-owned sources that drift silently otherwise.
  const poolDrift = home != null && catalog != null
    ? catalogPoolDrift({ ...catalog, sha256: hash(catalogBytes), userPool: probeUserPool(home) })
    : null;
  // Validate every include before staging anything — a bad entry must not
  // leave a half-materialized plan.
  const references = new Map();
  if (lstat(join(source, '.paseo-slp', 'references')) != null) {
    collectIncludes(source, '.paseo-slp/references', references, 'Protocol reference');
  }
  const includes = new Map();
  for (const raw of includePaths) collectIncludes(source, includeRelative(raw), includes);
  const protocol = rebaseFrontmatter(readFileSync(sourceFile('workspace-protocol.md'), 'utf8'), source, repository);
  const entries = [
    { path: join(repository, '.paseo-slp/workspace-protocol.md'), bytes: protocol.text },
    ...(catalogBytes !== null ? [{ path: join(repository, '.paseo-slp/slp-routing.json'), bytes: catalogBytes }] : []),
    ...[...references.entries()].map(([rel, bytes]) => ({ path: join(repository, rel), bytes })),
    ...[...includes.entries()].map(([rel, bytes]) => ({ path: join(repository, rel), bytes })),
  ];
  const result = stageEntries(entries, repository, apply);
  const protocolFile = result.find(file => file.path.endsWith('workspace-protocol.md'));
  protocolFile.rebased = protocol.rebased;
  // A protocol may legitimately carry no absolute path, so silence is a
  // warning on the file entry, not an error — but an applied file that kept
  // stale source paths would reproduce the exact friction this fixes.
  if (!protocolFile.preserved && !protocol.rebased) {
    protocolFile.warning = 'frontmatter has no source-root path; absolute paths left verbatim';
  }
  return { repository, source, files: result, applied: result.some(file => file.applied), preserved: result.every(file => file.preserved), ...(poolDrift ? { poolDrift } : {}) };
}
