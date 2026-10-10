// Evidence ledger and seal gate: collection paths, per-kind discharge rules,
// explicit gaps, and the read-only status preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { begin, collect, collectCoordinator, collectResources, fixture, review, seal, summary, attemptStatus } from '../e2e/collector.mjs';
import { scenarios } from '../e2e/scenarios.mjs';
import { evidenceKinds, satisfiesEvidence } from '../e2e/evidence.mjs';
import { criterionIds as criteria } from '../e2e/criteria.mjs';
import { hash } from '../plugin/server/runtime/cli/package.ts';
import { cli, config, temporary, setup, coordinatorTranscript, resourceSettlement, checksReceipt, interventionsReceipt, kindPayload, collectAll, reviewInput, fakeReview } from './helpers.mjs';

test('coordinator path and hash references cannot substitute for frozen transcript bytes', t => {
  const data = setup(t), path = join(data.dir, 'receipt.json');
  for (const kind of evidenceKinds) {
    writeFileSync(path, JSON.stringify(kind === 'coordinator'
      ? { nativeTranscriptPath: '/outside/live.jsonl', sourceProvenance: { bytesSha256: 'external-hash' } }
      : ['checks', 'interventions'].includes(kind) ? JSON.parse(kindPayload(kind))
        : { receipt: 'synthetic' }));
    collect(data.attempt, kind, path);
  }
  assert.throws(() => seal(data.attempt), /Missing required evidence: coordinator/);
  assert.equal(existsSync(join(data.attempt, 'report.json')), false);
});
test('coordinator collection rejects a run-authored transcript presented as native evidence', t => {
  const data = setup(t), sessionId = 'synthetic-session';
  const path = join(data.run, `coordinator-final-${sessionId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId } })}\n`);
  assert.throws(() => collectCoordinator(data.attempt, path, sessionId), /outside the E2E run directory/);
});
test('coordinator CLI freezes transcript bytes independently of the source file', t => {
  const data = setup(t), path = join(data.dir, 'rollout-synthetic-session.jsonl');
  writeFileSync(path, 'not JSONL');
  assert.throws(() => collectCoordinator(data.attempt, path, 'synthetic-session'), /JSONL object records/);
  const transcript = '{"type":"session_meta","payload":{"id":"synthetic-session"}}\n{"type":"response","id":"synthetic"}\n';
  writeFileSync(path, transcript);
  const command = spawnSync(process.execPath, [cli, 'collect-coordinator', data.attempt, path, 'synthetic-session'], { encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  const receipt = JSON.parse(command.stdout);
  rmSync(path);
  const payload = JSON.parse(Buffer.from(JSON.parse(readFileSync(join(data.attempt, receipt.path))).bytes, 'base64'));
  assert.equal(payload.transcript, transcript);
  assert.equal(payload.transcriptSha256, hash(Buffer.from(transcript)));
  assert.equal(payload.operatorId, config.operatorId);
  assert.equal(payload.sessionId, 'synthetic-session');
  collectAll(data, { except: ['coordinator', 'resources'] });
  collectResources(data.attempt, resourceSettlement(data));
  for (const changed of [{ operatorId: 'wrong-operator' }, { transcriptSha256: 'wrong-hash' }, { transcript: '[]', transcriptSha256: hash(Buffer.from('[]')) }]) {
    // An invalid earlier capture stays visible and cannot satisfy the gate.
    const recordPath = join(data.attempt, receipt.path);
    const original = readFileSync(recordPath);
    const record = JSON.parse(original), bytes = Buffer.from(JSON.stringify({ ...payload, ...changed }));
    writeFileSync(recordPath, JSON.stringify({ ...record, bytes: bytes.toString('base64'), sha256: hash(bytes) }));
    assert.throws(() => seal(data.attempt), /Missing required evidence: coordinator/);
    writeFileSync(recordPath, original);
  }
  assert.doesNotThrow(() => seal(data.attempt));
});
test('seal rejects resource settlement with unresolved actor lifecycle state', t => {
  const data = setup(t), sessionId = 'synthetic-session';
  const coordinator = join(data.dir, `rollout-${sessionId}.jsonl`);
  writeFileSync(coordinator, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId } })}\n`);
  collectAll(data, { except: ['coordinator', 'resources'] });
  collectCoordinator(data.attempt, coordinator, sessionId);
  const resources = join(data.dir, 'resources.json');
  writeFileSync(resources, JSON.stringify({
    version: 1,
    capturedAt: new Date().toISOString(),
    workspace: { status: 'retained' },
    taskActors: [{ id: 'supervisor', role: 'supervisor', status: 'finished/retained', pendingPermissions: [] }],
    settlement: {
      observed: 'Finished notification received, but the runtime still reports running.',
      actions: ['waited for finish notification'],
      unresolved: ['Supervisor reports running and finished at the same time'],
    },
  }));
  collect(data.attempt, 'resources', resources);
  assert.throws(() => seal(data.attempt), /Missing required evidence: resources/);
  assert.equal(existsSync(join(data.attempt, 'report.json')), false);
});
test('seal rejects an empty report without freezing the attempt', t => {
  const data = setup(t);
  assert.throws(() => seal(data.attempt), /No collected evidence/);
  assert.equal(existsSync(join(data.attempt, 'report.json')), false);
  assert.equal(existsSync(join(data.attempt, 'report.sha256')), false);
  assert.doesNotThrow(() => fakeReview(data), 'Collection and sealing remain possible after rejection');
});
test('seal requires coordinator evidence even when all other evidence kinds exist', t => {
  const data = setup(t);
  const path = join(data.dir, 'receipt.txt');
  collectAll(data, { except: ['coordinator', 'resources'] });
  collectResources(data.attempt, resourceSettlement(data));
  assert.throws(() => seal(data.attempt), /Missing required evidence: coordinator/);
  assert.equal(existsSync(join(data.attempt, 'report.json')), false);
  writeFileSync(path, '');
  collect(data.attempt, 'coordinator', path);
  assert.throws(() => seal(data.attempt), /Missing required evidence: coordinator/);
  collectCoordinator(data.attempt, coordinatorTranscript(data), 'synthetic-session');
  assert.doesNotThrow(() => seal(data.attempt));
});
test('a coordinator envelope only discharges the kind through verified capture', t => {
  const data = setup(t);
  collectAll(data, { except: ['coordinator'] });
  const transcript = `${JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session' } })}\n`;
  const outside = join(data.dir, 'rollout-synthetic-session.jsonl');
  writeFileSync(outside, transcript);
  // A self-authored envelope satisfies every payload rule — real source outside
  // the run, session marker, matching hash — yet stays a raw capture and cannot
  // discharge the kind.
  const envelope = join(data.dir, 'envelope.json');
  writeFileSync(envelope, JSON.stringify({ operatorId: config.operatorId, sessionId: 'synthetic-session',
    source: outside, transcript, transcriptSha256: hash(Buffer.from(transcript)) }));
  collect(data.attempt, 'coordinator', envelope);
  assert.throws(() => seal(data.attempt), /Missing required evidence: coordinator/);
  collectCoordinator(data.attempt, outside, 'synthetic-session');
  assert.doesNotThrow(() => seal(data.attempt));
});
test('resource settlement needs declared terminal states, not merely absent live labels', t => {
  const settlement = status => Buffer.from(JSON.stringify({
    version: 1, capturedAt: new Date().toISOString(), workspace: { status: 'retained' },
    taskActors: [{ id: 'actor-1', role: 'supervisor', status, pendingPermissions: [] }],
    settlement: { observed: 'Synthetic reread', actions: ['status reread'], unresolved: [] },
  }));
  for (const status of ['running', 'working', 'pending', 'unknown', 'initializing', 'awaiting-input', 'waiting-for-callback', 'in_progress']) {
    assert.equal(satisfiesEvidence('resources', settlement(status)), false, status);
  }
  for (const status of ['idle', 'closed', 'completed', 'failed', 'finished/retained', 'settled-error']) {
    assert.equal(satisfiesEvidence('resources', settlement(status)), true, status);
  }
  const data = setup(t);
  collectAll(data, { except: ['resources'] });
  const pending = join(data.dir, 'resources-pending.json');
  writeFileSync(pending, settlement('awaiting-input'));
  collectResources(data.attempt, pending);
  assert.throws(() => seal(data.attempt), /Missing required evidence: resources/);
});
test('explicit evidence gaps preserve incomplete attempts but cannot receive PASS', t => {
  const data = setup(t);
  const collected = collectResources(data.attempt, resourceSettlement(data));
  const gaps = evidenceKinds.filter(kind => kind !== 'resources').map(kind => ({ kind, reason: 'Host capability unavailable in this synthetic failure branch' }));
  assert.throws(() => seal(data.attempt, { gaps: [{ kind: 'coordinator', reason: '' }] }), /concrete reason/);
  assert.throws(() => seal(data.attempt, { gaps: [...gaps, gaps[0]] }), /Duplicate/);
  assert.throws(() => seal(data.attempt, { gaps: [...gaps, { kind: 'resources', reason: 'Not missing' }] }), /must name missing/);
  const frozen = seal(data.attempt, { gaps });
  assert.deepEqual(JSON.parse(readFileSync(frozen.report)).evidenceGaps, gaps);
  const item = status => ({ status, reason: 'Synthetic collector validation only', evidence: [collected.path] });
  const input = status => ({
    reviewerId: 'test-reviewer', participantIds: ['test-actor'], independenceEvidence: 'synthetic review session',
    reportSha256: frozen.reportSha256, criteria: Object.fromEntries(criteria.map(id => [id, item(status)])),
    assertions: scenarios.find(row => row.id === data.id).assertions.map(() => item(status)),
  });
  assert.throws(() => review(data.attempt, input('PASS')), /PASS forbidden with declared evidence gaps/);
  assert.equal(review(data.attempt, input('BLOCKED')).status, 'BLOCKED');
  assert.equal(summary(data.run).counts.BLOCKED, 1);
});

test('checks evidence needs a structured receipt carrying each command exit status', t => {
  const receipt = checks => Buffer.from(JSON.stringify({ checks }));
  // A failing baseline is still check evidence: the receipt proves the check ran.
  assert.equal(satisfiesEvidence('checks', receipt([{ command: 'node e2e/check-outcome.mjs /w', exitCode: 1, output: 'failing baseline' }])), true);
  assert.equal(satisfiesEvidence('checks', receipt([{ command: 'c', exitCode: 0 }, { command: 'd', exitCode: 2 }])), true);
  for (const bad of [
    Buffer.from('check passed, trust me\n'),
    Buffer.from('not json'),
    receipt([]),
    receipt([{ command: 'c' }]),
    receipt([{ exitCode: 0 }]),
    receipt([{ command: 'c', exitCode: '0' }]),
    receipt([{ command: '  ', exitCode: 0 }]),
  ]) assert.equal(satisfiesEvidence('checks', bad), false);

  // A freeform receipt stays visible in the ledger but cannot discharge the kind.
  const data = setup(t);
  const freeform = join(data.dir, 'checks.txt');
  writeFileSync(freeform, 'Synthetic freeform receipt; no exit status.\n');
  collect(data.attempt, 'checks', freeform);
  collectAll(data, { except: ['checks', 'coordinator', 'resources'] });
  collectCoordinator(data.attempt, coordinatorTranscript(data), 'synthetic-session');
  collectResources(data.attempt, resourceSettlement(data));
  assert.throws(() => seal(data.attempt), /Missing required evidence: checks/);
  assert.equal(existsSync(join(data.attempt, 'report.json')), false);
  const valid = join(data.dir, 'checks.json');
  writeFileSync(valid, checksReceipt(0));
  collect(data.attempt, 'checks', valid);
  assert.doesNotThrow(() => seal(data.attempt));
});
test('interventions evidence needs the explicit ledger receipt, including declared zero', t => {
  const receipt = value => Buffer.from(JSON.stringify(value));
  assert.equal(satisfiesEvidence('interventions', interventionsReceipt()), true, 'Explicit zero interventions');
  assert.equal(satisfiesEvidence('interventions', interventionsReceipt([{ at: '2026-01-01T00:00:00Z', action: 'Approved permission' }])), true);
  for (const bad of [
    Buffer.from('No interventions, trust me\n'),
    receipt({ interventions: [], assistanceCount: 0 }),
    receipt({ interventions: [], durationSeconds: 10 }),
    receipt({ interventions: [], assistanceCount: -1, durationSeconds: 10 }),
    receipt({ interventions: [{ at: 'x' }], assistanceCount: 0, durationSeconds: 10 }),
    receipt({ interventions: [{ action: 'Approved' }], assistanceCount: 1, durationSeconds: 10 }),
  ]) assert.equal(satisfiesEvidence('interventions', bad), false);
  // An unknown duration is declarable as null; an absent field is not.
  assert.equal(satisfiesEvidence('interventions',
    receipt({ interventions: [], assistanceCount: 0, durationSeconds: null })), true);

  const data = setup(t);
  const freeform = join(data.dir, 'interventions.txt');
  writeFileSync(freeform, 'No interventions during the attempt.\n');
  collect(data.attempt, 'interventions', freeform);
  collectAll(data, { except: ['interventions', 'coordinator', 'resources'] });
  collectCoordinator(data.attempt, coordinatorTranscript(data), 'synthetic-session');
  collectResources(data.attempt, resourceSettlement(data));
  assert.throws(() => seal(data.attempt), /Missing required evidence: interventions/);
  const valid = join(data.dir, 'interventions.json');
  writeFileSync(valid, interventionsReceipt());
  collect(data.attempt, 'interventions', valid);
  assert.doesNotThrow(() => seal(data.attempt));
});
test('status previews discharging records and missing kinds, then reports review state', t => {
  const data = setup(t);
  const empty = attemptStatus(data.attempt);
  assert.equal(empty.sealed, false);
  assert.equal(empty.sealable, false);
  assert.equal(empty.evidence.length, 0);
  assert.equal(empty.missingEvidence.length, evidenceKinds.length);
  assert.equal(empty.review, null);

  // A non-discharging record is visible before seal, not only as a seal error.
  const bad = join(data.dir, 'checks.txt');
  writeFileSync(bad, 'No exit status recorded.\n');
  collect(data.attempt, 'checks', bad);
  const partial = attemptStatus(data.attempt);
  assert.equal(partial.evidence[0].kind, 'checks');
  assert.equal(partial.evidence[0].discharges, false);
  assert.ok(partial.missingEvidence.includes('checks'));
  assert.equal(partial.sealable, false);

  const paths = collectAll(data);
  const ready = attemptStatus(data.attempt);
  assert.equal(ready.sealable, true);
  assert.equal(ready.missingEvidence.length, 0);
  assert.equal(ready.evidence.filter(item => item.kind === 'checks').length, 2, 'The bad record stays visible beside the discharging one');
  const frozen = seal(data.attempt);
  review(data.attempt, reviewInput(data, paths, frozen));
  const sealed = attemptStatus(data.attempt);
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.missingEvidence.length, 0);
  assert.equal(sealed.evidence[0].discharges, false, 'The non-discharging record stays visible after sealing');
  assert.ok(sealed.evidence.slice(1).every(item => item.discharges));
  assert.deepEqual(sealed.evidenceGaps, []);
  assert.equal(sealed.sourceUnchanged, true);
  assert.deepEqual(sealed.review, { status: 'PASS', integrity: 'VERIFIED', assessments: 1 });
  assert.match(sealed.reportSha256, /^[0-9a-f]{64}$/);

  const command = spawnSync(process.execPath, [cli, 'status', data.attempt], { encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  const output = JSON.parse(command.stdout);
  assert.equal(output.sealed, true);
  assert.equal(output.review.status, 'PASS');
});
test('unknown evidence kinds and fixture on a sealed attempt fail closed', t => {
  const data = setup(t);
  fakeReview(data); // Seals the attempt; no review recorded yet.
  const path = join(data.dir, 'receipt.txt');
  writeFileSync(path, 'x');
  assert.throws(() => collect(data.attempt, 'nonsense', path), /Unknown evidence kind/);
  assert.throws(() => fixture(data.attempt), /Attempt sealed/);
  assert.throws(() => begin(data.run, data.id, config), undefined, 'Sealed unreviewed attempt still blocks a respawn');
});
test('reviewing an unsealed attempt and resealing a sealed one fail with clear errors', t => {
  const data = setup(t);
  assert.throws(() => review(data.attempt, {}), /Attempt not sealed/);
  fakeReview(data);
  assert.throws(() => seal(data.attempt), /Attempt sealed/);
});
