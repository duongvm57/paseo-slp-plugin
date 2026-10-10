// Shared synthetic harness fixtures. Everything here is collector-level test
// data: no live actors, no host grants, no real Paseo sessions.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialize, begin, collect, collectCoordinator, collectResources, seal, sourceRoot } from '../e2e/collector.mjs';
import { scenarios } from '../e2e/scenarios.mjs';
import { evidenceKinds } from '../e2e/evidence.mjs';
import { criterionIds as criteria } from '../e2e/criteria.mjs';
import { hash } from '../plugin/server/runtime/cli/package.ts';

export const cli = join(sourceRoot, 'e2e', 'cli.mjs');
export const config = {
  operatorId: 'local-test-operator', authority: { source: 'local collector tests only; no live grant' },
  budget: { maxAgents: 4, maxWallTimeSeconds: 60 }, host: { id: 'test-only', version: 'fixture' },
  settings: { source: 'profiles-and-peer-pool',
    peerPool: { version: 1, policy: 'Synthetic test pool', options: [{ id: 'peer-test', provider: 'codex', roles: ['peer'], model: 'test-peer', enabled: true, availability: 'ready', priority: 1, suitableFor: ['tests'], avoidFor: [], notes: 'Synthetic only' }] },
    profiles: ['supervisor', 'lead'].map(role => ({ id: `slp-${role}`, provider: `slp-codex-${role}`, model: `test-${role}` })),
    providers: ['supervisor', 'lead', 'peer'].map(role => ({ id: `slp-codex-${role}`, enabled: true, status: 'available' })),
  }, confirmer: { id: 'test-confirmer', evidence: 'synthetic test data, no live acceptance' },
};
export function temporary(t) {
  mkdirSync(join(sourceRoot, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(sourceRoot, '.local-checks/e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
export function setup(t, id = 'basic-codex', editManifest) {
  const dir = temporary(t), run = join(dir, 'nested', 'run');
  initialize(run);
  if (editManifest) {
    // Historical-format fixtures are frozen before any attempt, never a migration
    // of already-recorded evidence or judgments.
    const manifestPath = join(run, 'frozen', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath));
    editManifest(manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const runPath = join(run, 'run.json'), metadata = JSON.parse(readFileSync(runPath));
    writeFileSync(runPath, JSON.stringify({ ...metadata, manifestSha256: hash(readFileSync(manifestPath)) }));
  }
  const { attempt } = begin(run, id, config);
  return { dir, run, attempt, id };
}
export function coordinatorTranscript(data, sessionId = 'synthetic-session') {
  const native = join(data.dir, 'native');
  mkdirSync(native, { recursive: true });
  const path = join(native, `rollout-${sessionId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId } })}\n${JSON.stringify({ type: 'response', payload: { text: 'synthetic test event' } })}\n`);
  return path;
}
export function resourceSettlement(data) {
  const path = join(data.dir, 'resources.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    capturedAt: new Date().toISOString(),
    workspace: { status: 'retained' },
    taskActors: [{ id: 'test-actor', role: 'supervisor', status: 'finished/retained', pendingPermissions: [] }],
    settlement: { observed: 'All synthetic actors finished.', actions: ['final status read'], unresolved: [] },
  }));
  return path;
}
export const checksReceipt = (exitCode = 0) => JSON.stringify({ checks: [{ command: 'synthetic check; not a live run', exitCode, output: 'Synthetic collector payload' }] });
export const interventionsReceipt = (interventions = []) => JSON.stringify({ interventions, assistanceCount: interventions.length, durationSeconds: 42 });
export const kindPayload = kind => kind === 'checks' ? checksReceipt()
  : kind === 'interventions' ? interventionsReceipt()
    : 'Synthetic collector test payload; not live evidence.\n';
export function collectAll(data, { except = [] } = {}) {
  const paths = [];
  for (const kind of evidenceKinds.filter(kind => !except.includes(kind))) {
    const path = join(data.dir, `${kind}.txt`);
    writeFileSync(path, kindPayload(kind));
    const result = kind === 'coordinator'
      ? collectCoordinator(data.attempt, coordinatorTranscript(data), 'synthetic-session')
      : kind === 'resources' ? collectResources(data.attempt, resourceSettlement(data))
        : collect(data.attempt, kind, path);
    paths.push(result.path);
  }
  return paths;
}
export function reviewInput(data, paths, frozen, status = 'PASS') {
  const item = () => ({ status, reason: 'Synthetic collector validation only', evidence: paths });
  return {
    reviewerId: 'test-reviewer', participantIds: ['test-actor'], independenceEvidence: 'synthetic review session',
    reportSha256: frozen.reportSha256, criteria: Object.fromEntries(criteria.map(id => [id, item()])),
    assertions: scenarios.find(row => row.id === data.id).assertions.map(item),
  };
}
export function fakeReview(data, status = 'PASS') {
  return reviewInput(data, collectAll(data), seal(data.attempt), status);
}
