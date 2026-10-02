// Run/attempt storage layer: directory layout, frozen manifest verification and
// scenario lookup. Nothing above this module is imported here — gates and
// reports live in the layers on top.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, files, hash, json, readJson } from '../plugin/server/runtime/cli/package.ts';
import { criterionIds, criterionEvidence } from './criteria.mjs';
import { evidenceKinds, evidenceVersion } from './evidence.mjs';
import { createFixture } from './fixture.mjs';

export const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
export const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export const put = (path, data) => writeFileSync(path, json(data), { flag: 'wx' });
export const now = () => new Date().toISOString();
export const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
export const reviewIntegrityVersion = 1;

export function harnessIdentity(root) {
  const entries = [...files(root, 'e2e'), 'docs/review-checklist.md', 'docs/contract.md', 'AGENTS.md']
    .sort().map(path => ({ path, sha256: hash(readFileSync(join(root, path))) }));
  return { sha256: hash(json(entries)), files: entries };
}
export function loadRun(directory, current = false) {
  directory = realpathSync(directory);
  const run = readJson(join(directory, 'run.json'));
  for (const [name, digest] of [['manifest.json', run.manifestSha256], ['review-checklist.md', run.checklistSha256], ['contract.md', run.contractSha256]]) {
    requireValue(hash(readFileSync(join(directory, 'frozen', name))) === digest, `Frozen ${name} changed`);
  }
  const frozen = readJson(join(directory, 'frozen', 'manifest.json'));
  requireValue(frozen.reviewIntegrityVersion === undefined || frozen.reviewIntegrityVersion === reviewIntegrityVersion,
    'Unsupported review integrity version');
  if (current) {
    requireValue(identity(run.sourceRoot).sha256 === frozen.candidate.sha256, 'Package candidate changed; initialize a new run');
    requireValue(harnessIdentity(run.sourceRoot).sha256 === frozen.harness.sha256, 'Harness changed; initialize a new run');
  }
  return { directory, run, frozen };
}
export function getScenario(directory, id, current = false) {
  const loaded = loadRun(directory, current);
  const scenario = loaded.frozen.scenarios.find(item => item.id === id);
  requireValue(scenario, 'Unknown scenario');
  return { ...loaded, scenario };
}
export function loadAttempt(attempt, current = false) {
  attempt = realpathSync(attempt);
  const data = readJson(join(attempt, 'attempt.json'));
  const loaded = getScenario(dirname(dirname(attempt)), data.scenarioId, current);
  requireValue(basename(dirname(attempt)) === data.scenarioId && /^attempt-\d+$/.test(basename(attempt)), 'Attempt location mismatch');
  requireValue(data.runManifestSha256 === loaded.run.manifestSha256, 'Attempt manifest mismatch');
  requireValue(loaded.frozen.evidenceVersion === undefined || loaded.frozen.evidenceVersion === evidenceVersion,
    'Unsupported evidence version; initialize a new run');
  return { ...loaded, attempt, data };
}
export function fixture(attempt) {
  const loaded = loadAttempt(attempt, true);
  requireValue(!existsSync(join(loaded.attempt, 'report.json')), 'Attempt sealed');
  return createFixture(join(loaded.attempt, 'workspace'), loaded.scenario.fixture);
}
export function defer(directory, id, input) {
  const loaded = getScenario(directory, id);
  requireValue(['BLOCKED', 'NOT_RUN'].includes(input.status) && nonempty(input.reason), 'Deferral status/reason required');
  requireValue(Array.isArray(input.missing) && input.missing.every(nonempty), 'List missing capabilities/authority/budget in missing');
  const parent = join(loaded.directory, id);
  mkdirSync(parent, { recursive: true });
  const count = readdirSync(parent).filter(name => /^deferred-\d+\.json$/.test(name)).length;
  const path = join(parent, `deferred-${String(count + 1).padStart(3, '0')}.json`);
  put(path, { ...input, recordedAt: now() });
  return { path };
}
