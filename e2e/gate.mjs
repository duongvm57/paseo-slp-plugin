// Creation-time gates: run initialization records the run-level bound the
// protocol requires, and attempt begin enforces dependency, deadline, config
// and runtime-source gates before anything may launch.
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { identity, hash } from '../plugin/server/runtime/cli/package.ts';
import { scenarios } from './scenarios.mjs';
import { criterionIds, criterionEvidence } from './criteria.mjs';
import { evidenceKinds, evidenceVersion } from './evidence.mjs';
import { savedProfileBinding, roles, profileRoles, providerId } from '../plugin/server/runtime/cli/profiles.ts';
import { validateCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { bindingCheck, verifyProvider } from '../plugin/server/runtime/cli/binding.ts';
import { getScenario, harnessIdentity, nonempty, now, put, requireValue, reviewIntegrityVersion, sourceRoot } from './runs.mjs';
import { summary } from './report.mjs';
import { reviewHistory } from './integrity.mjs';

export function initialize(directory, { root = sourceRoot, scope, budget, deadline } = {}) {
  const candidate = identity(root), harness = harnessIdentity(root);
  directory = resolve(directory);
  mkdirSync(dirname(directory), { recursive: true });
  mkdirSync(directory); // Exclusive; never reset a previous run.
  mkdirSync(join(directory, 'frozen'));
  const frozen = { scenarios, criteria: criterionIds, criterionEvidence, evidenceKinds, evidenceVersion, reviewIntegrityVersion, candidate, harness };
  put(join(directory, 'frozen', 'manifest.json'), frozen);
  for (const name of ['review-checklist.md', 'contract.md']) {
    writeFileSync(join(directory, 'frozen', name), readFileSync(join(root, 'docs', name)), { flag: 'wx' });
  }
  const run = {
    version: 2, createdAt: now(), sourceRoot: realpathSync(root),
    manifestSha256: hash(readFileSync(join(directory, 'frozen', 'manifest.json'))),
    checklistSha256: hash(readFileSync(join(directory, 'frozen', 'review-checklist.md'))),
    contractSha256: hash(readFileSync(join(directory, 'frozen', 'contract.md'))),
  };
  if (scope !== undefined) {
    requireValue(Array.isArray(scope) && scope.length > 0 && new Set(scope).size === scope.length
      && scope.every(id => scenarios.some(row => row.id === id)),
      'Scope must list unique scenario ids from the manifest');
    run.scope = scope;
  }
  if (budget !== undefined) {
    for (const key of ['maxAgents', 'maxWallTimeSeconds']) {
      requireValue(Number.isInteger(budget?.[key]) && budget[key] > 0, `Positive budget.${key} required`);
    }
    run.budget = { maxAgents: budget.maxAgents, maxWallTimeSeconds: budget.maxWallTimeSeconds };
  }
  if (deadline !== undefined) {
    const at = Date.parse(deadline);
    requireValue(Number.isFinite(at) && at > Date.now(), 'Run deadline must be a future ISO timestamp');
    run.deadline = new Date(at).toISOString();
  }
  put(join(directory, 'run.json'), run);
  return { directory, ...summary(directory) };
}
export function begin(directory, id, config) {
  const loaded = getScenario(directory, id, true);
  // A recorded run deadline closes launches; settlement and review continue.
  requireValue(!loaded.run.deadline || Date.parse(loaded.run.deadline) > Date.now(),
    'Run deadline expired; a new budget requires Human authority');
  if (loaded.scenario.dependsOn.length) {
    const rows = summary(directory).scenarios;
    for (const dependency of loaded.scenario.dependsOn) {
      requireValue(rows.find(row => row.id === dependency)?.gateReady,
        `Unmet scenario gate: ${dependency}; PASS with verified review integrity required`);
    }
  }
  requireValue(nonempty(config.operatorId), 'operatorId required');
  requireValue(nonempty(config.authority?.source), 'Current assignment authority source required');
  for (const key of ['maxAgents', 'maxWallTimeSeconds']) {
    requireValue(Number.isInteger(config.budget?.[key]) && config.budget[key] > 0, `Positive budget.${key} required`);
  }
  requireValue(nonempty(config.host?.id) && nonempty(config.host?.version), 'Pinned host id/version required');
  requireValue(config.settings && typeof config.settings === 'object', 'Discovered settings required');
  if (loaded.scenario.prelaunchConfirmation !== 'coordinator') {
    requireValue(nonempty(config.confirmer?.id) && config.confirmer.id !== config.operatorId && nonempty(config.confirmer?.evidence), 'Independent prelaunch confirmer and evidence required');
  }
  const source = loaded.scenario.runtimeSource;
  if (source === 'profiles' || source === 'profiles-and-peer-pool') {
    requireValue(config.settings.source === source, `Basic E2E requires ${source} settings`);
    const bindings = Object.fromEntries((source === 'profiles' ? roles : profileRoles).map(role => {
      const binding = savedProfileBinding(role, config.settings.profiles, config.settings.providers);
      requireValue(binding.provider === providerId(role, loaded.scenario.providerFamily),
        `Human must configure ${binding.profileId} with ${providerId(role, loaded.scenario.providerFamily)} for ${id}; observed ${binding.provider}`);
      bindingCheck(binding);
      return [role, binding];
    }));
    if (source === 'profiles-and-peer-pool') {
      const pool = validateCatalog(config.settings.peerPool);
      const eligible = pool.options.filter(option => option.enabled && option.availability === 'ready' && option.roles.includes('peer') && option.provider === loaded.scenario.providerFamily);
      requireValue(eligible.length > 0, `Peer pool needs an eligible ${loaded.scenario.providerFamily} option for ${id}`);
      verifyProvider(config.settings.providers, providerId('peer', loaded.scenario.providerFamily),
        () => loaded.scenario.providerFamily, 'Peer pool provider');
    }
    config = { ...config, settings: { ...config.settings, roles: bindings } };
  }
  const parent = join(loaded.directory, id);
  mkdirSync(parent, { recursive: true });
  const existing = readdirSync(parent).filter(name => /^attempt-\d+$/.test(name));
  // One coordinator writes the ledger. Never resume a live attempt by spawning again.
  for (const name of existing) {
    const history = reviewHistory(join(parent, name));
    requireValue(history, `Unreviewed attempt ${name}; resume it first`);
    requireValue(history.integrity === 'VERIFIED', `Unverified review integrity for ${name}; historical review cannot authorize a retry`);
  }
  const attempt = join(parent, `attempt-${String(existing.length + 1).padStart(3, '0')}`);
  mkdirSync(attempt);
  mkdirSync(join(attempt, 'evidence'));
  put(join(attempt, 'attempt.json'), { version: 1, scenarioId: id, createdAt: now(), runManifestSha256: loaded.run.manifestSha256, config });
  return { attempt, scenario: loaded.scenario };
}
