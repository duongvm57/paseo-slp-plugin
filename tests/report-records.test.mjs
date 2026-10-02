import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractRecords, recordSchema, recomputeSha, requireRecordKind, validateRecord } from '../plugin/server/runtime/cli/report-records.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const head = 'a'.repeat(40);
const output = 'typecheck passed\n';

function handback(changes = {}) {
  return {
    version: 1,
    kind: 'handback',
    seat: { role: 'peer', disposition: 'engineer' },
    verdict: 'APPROVE',
    candidate: { repository: '/repo', head },
    checks: [{ cmd: 'npm run typecheck', exit: 0, sha: recomputeSha(output), output }],
    ...changes
  };
}

function settlement(changes = {}) {
  return {
    version: 1,
    kind: 'settlement',
    task: 'paseo-slp-7li',
    seat: { provider: 'slp-codex-peer', title: 'Peer Engineer' },
    timeline: { nativeHandle: 'rollout-id', sessionId: null, via: 'paseo-logs', export: null, gap: 'no-export-capability' },
    recordedBy: 'slp-lead-example',
    at: '2026-09-27T10:00:00Z',
    ...changes
  };
}

function block(record) { return `\n\`\`\`slp-record\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`; }

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-records-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('extracts one valid handback block and verifies inline UTF-8 output bytes', () => {
  const result = extractRecords(`Handback prose.${block(handback())}`);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].record.kind, 'handback');
  assert.equal(result.records[0].selected, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('keeps duplicate blocks, selects the last record of a kind, and reports its count', () => {
  const result = extractRecords(block(handback()) + block(handback({ verdict: 'FINDINGS' })));
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].selected, false);
  assert.equal(result.records[1].selected, true);
  assert.deepEqual(result.warnings.map(warning => [warning.code, warning.count]), [['multiple-records', 2]]);
});

test('reports malformed JSON with the fenced block index', () => {
  const result = extractRecords('```slp-record\n{broken}\n```');
  assert.equal(result.records.length, 0);
  assert.equal(result.errors[0].code, 'invalid-json');
  assert.equal(result.errors[0].blockIndex, 1);
});

test('reports missing fields, unsupported versions, and unknown kinds', () => {
  const missing = validateRecord({ version: 1, kind: 'handback' });
  assert.ok(missing.errors.some(error => error.code === 'invalid-record' && error.field === 'seat'));
  assert.ok(validateRecord({ kind: 'handback' }).errors.some(error => error.code === 'invalid-record' && error.field === 'version'));
  assert.ok(validateRecord(handback({ version: 2 })).errors.some(error => error.code === 'unsupported-version'));
  assert.ok(validateRecord(handback({ kind: 'future' })).errors.some(error => error.code === 'unknown-kind'));
});

test('uses the peer verdict enum in validation and schema', () => {
  assert.equal(validateRecord(handback({ verdict: 'APPROVE' })).valid, true);
  assert.equal(validateRecord(handback({ verdict: 'BLOCKED' })).valid, true);
  assert.ok(validateRecord(handback({ verdict: 'ACCEPT' })).errors.some(error => error.field === 'verdict'));
  const schema = recordSchema().oneOf.find(entry => entry.properties.kind.const === 'handback');
  assert.deepEqual(schema.properties.verdict.enum, ['APPROVE', 'FINDINGS', 'BLOCKED', 'REOPEN_REQUEST', 'DEPENDENCY_REQUEST', null]);
});

test('record schema constrains timestamps, absolute repositories, safe relative paths and task ids', () => {
  const schema = recordSchema();
  const settlementSchema = schema.oneOf.find(entry => entry.properties.kind.const === 'settlement');
  const exportPath = new RegExp(settlementSchema.properties.timeline.properties.export.oneOf[1].properties.path.pattern, 'u');
  const taskString = settlementSchema.properties.task.anyOf.find(entry => entry.type === 'string');
  const taskPattern = new RegExp(taskString.pattern, 'u');
  const handbackSchema = schema.oneOf.find(entry => entry.properties.kind.const === 'handback');
  const outputRef = new RegExp(handbackSchema.properties.checks.items.properties.outputRef.pattern, 'u');

  assert.match(settlementSchema.properties.at.pattern, /Z\$$/u);
  assert.equal(exportPath.test('../secret.txt'), false);
  assert.equal(exportPath.test('/tmp/secret.txt'), false);
  assert.equal(exportPath.test('logs/session.txt'), true);
  assert.equal(outputRef.test('..\\secret.txt'), false);
  assert.equal(outputRef.test('logs/check.txt'), true);
  assert.equal(taskString.minLength, 1);
  assert.equal(taskPattern.test('  '), false);
  assert.equal(taskPattern.test('paseo-slp-7li'), true);
  assert.match(handbackSchema.properties.candidate.oneOf[1].properties.repository.allOf[0].pattern, /^\^\\\//u);
});

test('schema nonblank constraints match validator rules for required and nullable strings', () => {
  const schema = recordSchema();
  const handbackSchema = schema.oneOf.find(entry => entry.properties.kind.const === 'handback');
  const settlementSchema = schema.oneOf.find(entry => entry.properties.kind.const === 'settlement');
  const stringSchema = value => value.anyOf?.find(entry => entry.type === 'string') ?? value;
  const pinNonblank = value => {
    assert.equal(stringSchema(value).minLength, 1);
    assert.equal(stringSchema(value).pattern, '\\S');
  };

  for (const field of [
    handbackSchema.properties.seat.properties.role,
    handbackSchema.properties.seat.properties.disposition,
    handbackSchema.properties.checks.items.properties.cmd,
    settlementSchema.properties.seat.properties.provider,
    settlementSchema.properties.seat.properties.title,
    settlementSchema.properties.recordedBy,
    settlementSchema.properties.task
  ]) pinNonblank(field);
  for (const field of [
    handbackSchema.properties.seat.properties.agentId,
    handbackSchema.properties.timeline.properties.sessionId,
    settlementSchema.properties.seat.properties.agentId,
    settlementSchema.properties.timeline.properties.nativeHandle,
    settlementSchema.properties.timeline.properties.sessionId,
    settlementSchema.properties.timeline.properties.gap
  ]) {
    assert.ok(field.anyOf.some(entry => entry.type === 'null'));
    pinNonblank(field);
  }

  const invalid = [
    ['seat.role', handback({ seat: { role: '  ', disposition: 'engineer' } })],
    ['seat.disposition', handback({ seat: { role: 'peer', disposition: '' } })],
    ['checks[0].cmd', handback({ checks: [{ cmd: ' ', exit: 0, sha: null }] })],
    ['candidate.repository', handback({ candidate: { repository: 'relative', head } })],
    ['task', settlement({ task: '  ' })],
    ['seat.provider', settlement({ seat: { provider: ' ', title: 'Peer' } })],
    ['seat.title', settlement({ seat: { provider: 'codex', title: '' } })],
    ['recordedBy', settlement({ recordedBy: '  ' })],
    ['seat.agentId', handback({ seat: { role: 'peer', disposition: 'engineer', agentId: '' } })],
    ['timeline.sessionId', handback({ timeline: { sessionId: ' ' } })],
    ['timeline.nativeHandle', settlement({ timeline: { ...settlement().timeline, nativeHandle: '' } })],
    ['timeline.sessionId', settlement({ timeline: { ...settlement().timeline, sessionId: ' ' } })],
    ['timeline.gap', settlement({ timeline: { ...settlement().timeline, gap: ' ' } })]
  ];
  for (const [field, record] of invalid) {
    assert.ok(validateRecord(record).errors.some(error => error.field === field), `${field} rejects a blank string`);
  }
  assert.equal(validateRecord(handback({ seat: { role: 'peer', disposition: 'engineer', agentId: null }, timeline: { sessionId: null } })).valid, true);
  assert.equal(validateRecord(settlement({ task: null, timeline: { ...settlement().timeline, nativeHandle: null, sessionId: null, gap: null } })).valid, true);
});

test('validates inline SHA format and detects output mismatch', () => {
  const badFormat = validateRecord(handback({ checks: [{ cmd: 'check', exit: 0, sha: 'abc', output }] }));
  assert.ok(badFormat.errors.some(error => error.field === 'checks[0].sha'));
  const mismatch = validateRecord(handback({ checks: [{ cmd: 'check', exit: 0, sha: '0'.repeat(64), output }] }));
  assert.ok(mismatch.errors.some(error => error.code === 'sha-mismatch'));
});

test('distinguishes a missing sha key, sha:null and output paired with sha:null', () => {
  const missing = validateRecord(handback({ checks: [{ cmd: 'check', exit: 0 }] }));
  assert.ok(missing.errors.some(error => error.field === 'checks[0].sha'));
  assert.equal(missing.warnings.find(warning => warning.code === 'check-evidence-missing').message,
    'sha key is missing; check evidence cannot be verified');

  const nullWithoutOutput = validateRecord(handback({ checks: [{ cmd: 'check', exit: 0, sha: null }] }));
  assert.equal(nullWithoutOutput.valid, true);
  assert.equal(nullWithoutOutput.warnings.find(warning => warning.code === 'check-evidence-missing').message,
    'sha is null; check evidence is missing');

  const outputWithNull = validateRecord(handback({ checks: [{ cmd: 'check', exit: 0, sha: null, output }] }));
  assert.equal(outputWithNull.warnings.find(warning => warning.code === 'check-evidence-missing').message,
    'output evidence is present but sha is null');
});

test('--repo overrides declared roots, compares realpaths, and hides the computed digest', t => {
  const dir = temp(t), cliRoot = join(dir, 'checker'), recordRoot = join(dir, 'record');
  mkdirSync(cliRoot);
  mkdirSync(recordRoot);
  mkdirSync(join(dir, 'unused'));
  const cliOutput = 'checker output\n';
  writeFileSync(join(cliRoot, 'evidence.txt'), cliOutput);
  writeFileSync(join(recordRoot, 'evidence.txt'), 'record output\n');
  const record = handback({ candidate: { repository: recordRoot, head }, checks: [{ cmd: 'check', exit: 0, sha: recomputeSha(cliOutput), outputRef: 'evidence.txt' }] });
  const withoutRepo = extractRecords(block(record));
  assert.ok(withoutRepo.errors.some(error => error.code === 'sha-mismatch'));

  const overridden = extractRecords(block(record), { repo: cliRoot });
  assert.deepEqual(overridden.errors, []);
  assert.ok(overridden.warnings.some(warning => warning.code === 'repository-mismatch'
    && warning.message.includes(recordRoot) && warning.message.includes(cliRoot)));
  const candidateOnly = extractRecords(block(handback({ candidate: { repository: recordRoot, head }, checks: [] })), { repo: cliRoot });
  assert.ok(candidateOnly.warnings.some(warning => warning.code === 'repository-mismatch'));

  const equivalentRoot = `${dir}/unused/../checker`;
  const sameRoot = extractRecords(block(handback({
    candidate: { repository: equivalentRoot, head },
    checks: [{ cmd: 'check', exit: 0, sha: recomputeSha(cliOutput), outputRef: 'evidence.txt' }]
  })), { repo: cliRoot });
  assert.deepEqual(sameRoot.errors, []);
  assert.ok(!sameRoot.warnings.some(warning => warning.code === 'repository-mismatch'));

  const expectedSha = '0'.repeat(64);
  const mismatch = extractRecords(block({ ...record, checks: [{ ...record.checks[0], sha: expectedSha }] }), { repo: cliRoot });
  assert.ok(mismatch.errors.some(error => error.code === 'sha-mismatch'));
  const message = mismatch.errors.find(error => error.code === 'sha-mismatch').message;
  assert.doesNotMatch(message, new RegExp(recomputeSha(cliOutput), 'u'));
  assert.doesNotMatch(message, new RegExp(expectedSha, 'u'));
});

test('rejects outputRef traversal and reports unreadable references as missing evidence', t => {
  const invalid = validateRecord(handback({ checks: [{ cmd: 'check', exit: 0, sha: null, outputRef: '../outside' }] }));
  assert.ok(invalid.errors.some(error => error.field === 'checks[0].outputRef'));
  assert.ok(!invalid.warnings.some(warning => warning.code === 'check-evidence-missing'));
  const dir = temp(t);
  const unreadable = extractRecords(block(handback({ candidate: null, checks: [{ cmd: 'check', exit: 0, sha: '0'.repeat(64), outputRef: 'missing.txt' }] })), { repo: dir });
  assert.ok(unreadable.warnings.some(warning => warning.code === 'check-evidence-missing'));
});

test('relative candidate repositories are invalid and cannot root outputRef reads', () => {
  const record = handback({
    candidate: { repository: 'relative-root', head },
    checks: [{ cmd: 'check', exit: 0, sha: null, outputRef: 'evidence.txt' }]
  });
  const result = extractRecords(block(record));
  assert.ok(result.errors.some(error => error.code === 'invalid-record' && error.field === 'candidate.repository'));
  const missing = result.warnings.find(warning => warning.code === 'check-evidence-missing');
  assert.ok(missing);
  assert.match(missing.message, /not absolute/u);
});

test('uses per-check then record candidate roots only when --repo is absent', t => {
  const dir = temp(t);
  const cliRoot = join(dir, 'cli'), recordRoot = join(dir, 'record'), checkRoot = join(dir, 'check');
  for (const repository of [cliRoot, recordRoot, checkRoot]) mkdirSync(repository);
  const cliOutput = 'cli output\n';
  writeFileSync(join(cliRoot, 'evidence.txt'), cliOutput);
  writeFileSync(join(recordRoot, 'evidence.txt'), 'record output\n');
  writeFileSync(join(checkRoot, 'evidence.txt'), output);

  const record = handback({
    candidate: { repository: recordRoot, head },
    checks: [{ cmd: 'check', exit: 0, sha: recomputeSha(cliOutput), outputRef: 'evidence.txt', candidate: { repository: checkRoot, head } }]
  });
  const overridden = extractRecords(block(record), { repo: cliRoot });
  assert.deepEqual(overridden.errors, []);
  assert.equal(overridden.warnings.filter(warning => warning.code === 'repository-mismatch').length, 2);
  assert.ok(extractRecords(block(record)).errors.some(error => error.code === 'sha-mismatch'));

  const checkCandidateRecord = handback({
    candidate: { repository: recordRoot, head },
    checks: [{ cmd: 'check', exit: 0, sha: recomputeSha(output), outputRef: 'evidence.txt', candidate: { repository: checkRoot, head } }]
  });
  const checkCandidate = extractRecords(block(checkCandidateRecord));
  assert.deepEqual(checkCandidate.errors, []);
  assert.deepEqual(checkCandidate.warnings, []);

  const recordCandidate = handback({
    candidate: { repository: recordRoot, head },
    checks: [{ cmd: 'check', exit: 0, sha: recomputeSha('record output\n'), outputRef: 'evidence.txt' }]
  });
  const recordCandidateResult = extractRecords(block(recordCandidate));
  assert.deepEqual(recordCandidateResult.errors, []);
  assert.deepEqual(recordCandidateResult.warnings, []);
});

test('warns for incomplete candidate scope and accepts a per-check candidate override', () => {
  const record = handback({
    candidate: { repository: '/repo', snapshotSha256: 'b'.repeat(64), incomplete: ['plugin'] },
    checks: [{ cmd: 'check', exit: 0, sha: recomputeSha(output), output, candidate: { repository: '/other', head } }]
  });
  const result = extractRecords(block(record));
  assert.ok(result.warnings.some(warning => warning.code === 'candidate-incomplete'));
  assert.deepEqual(result.errors, []);
});

test('validates and round-trips a settlement record', () => {
  const record = settlement();
  assert.equal(validateRecord(record).valid, true);
  const result = extractRecords(block(record));
  assert.equal(result.records[0].record.kind, 'settlement');
  assert.equal(result.records[0].selected, true);
  assert.deepEqual(result.errors, []);
});

test('prose-only input returns no-record without becoming invalid', () => {
  const result = extractRecords('A prose handback without a candidate or check claim.');
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some(warning => warning.code === 'no-record'));
});

test('extracts CRLF fenced blocks', () => {
  const result = extractRecords(block(handback()).replaceAll('\n', '\r\n'));
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.errors, []);
});

test('accepts trailing whitespace after the opening and closing record fences', () => {
  const source = block(handback())
    .replace('```slp-record\n', '```slp-record  \t\n')
    .replace('\n```\n', '\n``` \t\n');
  const result = extractRecords(source);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.errors, []);
});

test('requireRecordKind adds the required-kind diagnostic without mutating parser output', () => {
  const parsed = extractRecords('A report without a record.');
  const required = requireRecordKind(parsed, 'handback');
  assert.ok(required.errors.some(error => error.code === 'required-kind-missing'));
  assert.deepEqual(parsed.errors, []);
  assert.throws(() => requireRecordKind(parsed, 'future'), /unsupported required record kind/u);
});

test('records CLI supports --require failure, stdin, and schema output', () => {
  const binary = join(root, 'bin/slp.mjs');
  const missing = spawnSync(process.execPath, [binary, 'records', '-', '--require', 'handback'], { input: 'plain report', encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.ok(JSON.parse(missing.stdout).errors.some(error => error.code === 'required-kind-missing'));
  const invalidPresent = spawnSync(process.execPath, [binary, 'records', '-', '--require', 'handback'], {
    input: block(handback({ verdict: 'ACCEPT' })), encoding: 'utf8'
  });
  assert.equal(invalidPresent.status, 1);
  const invalidParsed = JSON.parse(invalidPresent.stdout);
  assert.ok(invalidParsed.errors.some(error => error.field === 'verdict'));
  assert.ok(!invalidParsed.errors.some(error => error.code === 'required-kind-missing'));
  const parsed = spawnSync(process.execPath, [binary, 'records', '-'], { input: block(handback()), encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(JSON.parse(parsed.stdout).records[0].record.kind, 'handback');
  const schema = spawnSync(process.execPath, [binary, 'records', '--schema'], { encoding: 'utf8' });
  assert.equal(schema.status, 0, schema.stderr);
  assert.equal(JSON.parse(schema.stdout).title, recordSchema().title);
});

test('records CLI reads a file and filters returned kinds', t => {
  const dir = temp(t), report = join(dir, 'report.md');
  writeFileSync(report, block(handback()) + block(settlement()));
  const result = spawnSync(process.execPath, [join(root, 'bin/slp.mjs'), 'records', report, '--kind', 'settlement'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.records.map(entry => entry.record.kind), ['settlement']);
});

test('records CLI keeps errors for records hidden by --kind and rejects a relative --repo', t => {
  const dir = temp(t), report = join(dir, 'report.md');
  writeFileSync(report, block(handback({ verdict: 'ACCEPT' })) + block(settlement()));
  const binary = join(root, 'bin/slp.mjs');
  const filtered = spawnSync(process.execPath, [binary, 'records', report, '--kind', 'settlement'], { encoding: 'utf8' });
  assert.equal(filtered.status, 1);
  const parsed = JSON.parse(filtered.stdout);
  assert.deepEqual(parsed.records.map(entry => entry.record.kind), ['settlement']);
  assert.ok(parsed.errors.some(error => error.field === 'verdict'));

  const relativeRepo = spawnSync(process.execPath, [binary, 'records', report, '--repo', 'relative'], { encoding: 'utf8' });
  assert.equal(relativeRepo.status, 1);
  assert.match(relativeRepo.stderr, /Absolute path required for --repo/u);
});
