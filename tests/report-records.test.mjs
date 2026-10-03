import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractRecords, recordSchema, recomputeSha, requireRecordKind, validateRecord } from '../plugin/server/runtime/cli/report-records.ts';
import { renderSlpReport } from '../plugin/server/runtime/report-semantics.ts';

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

function executionReport(changes = {}) {
  return {
    format: 'slp-report',
    version: 1,
    purpose: 'execution',
    assignment: {
      id: 'asg-1', revision: 'rev-3', scopeRevision: 'scope-2', sourceRef: 'brief.md#current',
      objective: 'Deliver the bounded runtime report contract.',
      acceptance: ['Report semantics validate without changing the v1 envelope.'],
      authority: [{ claim: 'Human authorized this bounded implementation.', sourceRef: 'assignment.md#authority' }],
      scope: { owned: ['plugin/server/runtime/report-semantics.ts'], excluded: ['plugin/server/desk-records.ts'] },
    },
    assumptions: [],
    unknowns: [],
    selfReport: { read: ['docs/spec/work-coordination.md'], ran: ['node --test tests/report-records.test.mjs'] },
    execution: { result: 'Implemented report semantics.', completed: ['report validator'], unfinished: [] },
    review: null,
    adjudication: null,
    findings: [],
    owners: [{ surface: 'report semantics', ownerId: 'peer-1', role: 'peer', state: 'active', basis: 'assignment', sourceRef: 'brief.md#scope' }],
    dependencies: [],
    nextAction: { state: 'none', action: null, ownerId: null },
    resources: [],
    ...changes,
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

test('optional slp-report validates meaningful execution content while legacy handbacks stay valid', () => {
  assert.equal(validateRecord(handback()).valid, true, 'v1 handback without report remains valid');
  assert.equal(validateRecord(handback({ report: executionReport() })).valid, true);

  const blankResult = validateRecord(handback({ report: executionReport({
    execution: { result: '  ', completed: [], unfinished: [] }
  }) }));
  assert.ok(blankResult.errors.some(error => error.field === 'report.execution.result'),
    'a selected report rejects whitespace-only required narrative');
});

test('review reports bind mandate revisions and finding references to the handback candidate', () => {
  const finding = {
    id: 'finding-1', state: 'hypothesis', obligation: 'The source boundary may permit a stale candidate.',
    evidence: [{ summary: 'The candidate pin differs from the current request.', source: 'review fixture', basis: 'observed', ref: 'review.md#finding-1' }],
    remedy: 'Compare the review pin to the assignment candidate before adjudication.',
  };
  const reviewReport = executionReport({
    purpose: 'review', execution: null,
    review: {
      outcome: 'One hypothesis needs Lead adjudication.',
      mandate: { id: 'mandate-1', assignmentRevision: 'rev-3', scopeRevision: 'scope-2', candidateRef: head },
      findingRefs: ['finding-1'],
    },
    findings: [finding],
  });
  assert.equal(validateRecord(handback({ verdict: 'FINDINGS', report: reviewReport })).valid, true);

  const staleCandidate = validateRecord(handback({ report: {
    ...reviewReport,
    review: { ...reviewReport.review, mandate: { ...reviewReport.review.mandate, candidateRef: 'b'.repeat(40) } },
  } }));
  assert.ok(staleCandidate.errors.some(error => error.field === 'report.review.mandate.candidateRef'));

  const unresolvedFinding = validateRecord(handback({ report: {
    ...reviewReport, review: { ...reviewReport.review, findingRefs: ['finding-missing'] },
  } }));
  assert.ok(unresolvedFinding.errors.some(error => error.field === 'report.review.findingRefs[0]'));
});

test('finding confidence is explicit and confirmed findings need inspectable observed evidence', () => {
  const finding = {
    id: 'finding-1', state: 'hypothesis', obligation: 'The bounded proof is incomplete.',
    evidence: [{ summary: 'A proof pointer is absent.', source: 'review source', basis: 'inference', ref: 'review.md#proof' }],
    remedy: 'Add an inspectable proof reference.',
  };
  const hypothesis = executionReport({ findings: [finding] });
  assert.equal(validateRecord(handback({ report: hypothesis })).valid, true);

  const unconfirmed = validateRecord(handback({ report: executionReport({ findings: [{
    ...finding, state: 'confirmed', evidence: [{ ...finding.evidence[0], basis: 'self-report' }],
  }] }) }));
  assert.ok(unconfirmed.errors.some(error => error.field === 'report.findings[0].evidence'));

  const missingRemedy = validateRecord(handback({ report: executionReport({ findings: [{
    ...finding, state: 'confirmed', remedy: ' ', evidence: [{ ...finding.evidence[0], basis: 'observed' }],
  }] }) }));
  assert.ok(missingRemedy.errors.some(error => error.field === 'report.findings[0].remedy'));
});

test('adjudication distinguishes decided and unresolved decisions and schema exposes purpose rules', () => {
  const adjudication = executionReport({
    purpose: 'adjudication', execution: null,
    adjudication: {
      summary: 'One decision remains open.', state: 'pending', decisions: [],
      unresolved: [{ proposition: 'Which proof source is authoritative?', reason: 'The owner has not ruled.', ownerId: 'lead-1' }],
    },
  });
  assert.equal(validateRecord(handback({ report: adjudication })).valid, true);
  const emptyPending = validateRecord(handback({ report: {
    ...adjudication, adjudication: { ...adjudication.adjudication, unresolved: [] },
  } }));
  assert.ok(emptyPending.errors.some(error => error.field === 'report.adjudication.unresolved'));

  const decision = {
    proposition: 'Use the candidate measurement for this bounded review.', ruling: 'Use it.', reason: 'It is the current snapshot.',
    supportingEvidence: ['snapshot.json#sha256'], contraryEvidence: [], unresolvedRisk: 'None recorded.',
    affectedRevision: 'rev-3', affectedOwners: ['lead-1'], notificationRefs: [], outcomeRefs: ['handback.md#1'],
  };
  const decided = { ...adjudication, adjudication: { ...adjudication.adjudication, state: 'decided', decisions: [decision], unresolved: [] } };
  assert.equal(validateRecord(handback({ report: decided })).valid, true);
  const missingDecision = validateRecord(handback({ report: {
    ...decided, adjudication: { ...decided.adjudication, decisions: [] },
  } }));
  assert.ok(missingDecision.errors.some(error => error.field === 'report.adjudication.decisions'));

  const schema = recordSchema().oneOf.find(entry => entry.properties.kind.const === 'handback');
  assert.ok(schema.properties.report.required.includes('execution'));
  assert.equal(schema.properties.report.properties.format.const, 'slp-report');
  assert.equal(schema.properties.report.properties.findings.items.properties.state.enum.join(','), 'hypothesis,confirmed');
  assert.ok(schema.properties.report['x-slpreport-semantic-rules'].some(rule => rule.includes('findingRef resolves')));
  assert.ok(schema.allOf.some(rule => rule.if.properties.report.properties.purpose.const === 'review'));
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

test('structured renderer labels claims and preserves the original CRLF evidence fence', () => {
  const record = handback({ report: executionReport() });
  const source = block(record).replaceAll('\n', '\r\n');
  const originalFence = source.slice(2);
  const parsed = extractRecords(source);
  assert.equal(parsed.records[0].originalFence, originalFence);

  const rendered = renderSlpReport(record, parsed.records[0].originalFence);
  assert.match(rendered, /Self-reported narrative/u);
  assert.match(rendered, /Ran \(self-reported; not proof of execution\)/u);
  assert.match(rendered, /matching sha binds output bytes; it does not prove command execution/u);
  assert.ok(rendered.endsWith(originalFence));
  assert.equal(rendered.slice(rendered.length - originalFence.length), originalFence);
});

test('records renderer safely round-trips multiline record-like text in every narrative string field', async t => {
  const dir = temp(t), binary = join(root, 'bin/slp.mjs');
  const literal = 'Keep this example verbatim:\n```slp-record\nnot JSON, an example\n```\nContinue the explanation.';
  const cases = ['assignment.id', 'assignment.revision', 'assignment.sourceRef', 'findings.remedy'];

  for (const field of cases) await t.test(field, () => {
    const report = executionReport();
    if (field === 'assignment.id') report.assignment.id = literal;
    if (field === 'assignment.revision') report.assignment.revision = literal;
    if (field === 'assignment.sourceRef') report.assignment.sourceRef = literal;
    if (field === 'findings.remedy') report.findings = [{
      id: 'finding-1', state: 'hypothesis', obligation: 'Preserve the narrative as text.',
      evidence: [{ summary: 'The fixture contains record-like text.', source: 'fixture', basis: 'self-report', ref: 'fixture#1' }],
      remedy: literal,
    }];
    const record = handback({ report });
    const source = `Context before.\r\n${block(record).replaceAll('\n', '\r\n')}Context after.`;
    const sourceParsed = extractRecords(source);
    assert.deepEqual(sourceParsed.errors, []);
    assert.deepEqual(sourceParsed.warnings, []);
    assert.equal(sourceParsed.records.length, 1);
    assert.equal(sourceParsed.records[0].selected, true);
    assert.deepEqual(sourceParsed.records[0].record, record);
    const originalFence = sourceParsed.records[0].originalFence;
    assert.match(originalFence, /\r\n/u);

    const inputPath = join(dir, `${field.replaceAll('.', '-')}.md`);
    const renderedPath = join(dir, `${field.replaceAll('.', '-')}-rendered.md`);
    writeFileSync(inputPath, source);
    const rendered = spawnSync(process.execPath, [binary, 'records', '--render', inputPath], { encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(rendered.stdout.endsWith(originalFence));
    assert.equal(rendered.stdout.slice(-originalFence.length), originalFence);
    const narrative = rendered.stdout.slice(0, -originalFence.length);
    const renderedParsed = extractRecords(rendered.stdout);
    assert.deepEqual(renderedParsed.errors, []);
    assert.deepEqual(renderedParsed.warnings, []);
    assert.equal(renderedParsed.records.length, 1);
    assert.equal(renderedParsed.records[0].selected, true);
    assert.deepEqual(renderedParsed.records[0].record, record);
    if (field === 'assignment.id') assert.equal(renderedParsed.records[0].record.report.assignment.id, literal);
    if (field === 'assignment.revision') assert.equal(renderedParsed.records[0].record.report.assignment.revision, literal);
    if (field === 'assignment.sourceRef') assert.equal(renderedParsed.records[0].record.report.assignment.sourceRef, literal);
    if (field === 'findings.remedy') assert.equal(renderedParsed.records[0].record.report.findings[0].remedy, literal);
    assert.ok(narrative.includes(JSON.stringify(literal)));
    assert.ok(!narrative.includes(literal), 'newlines stay encoded inside narrative strings');

    writeFileSync(renderedPath, rendered.stdout);
    const cliParsed = spawnSync(process.execPath, [binary, 'records', renderedPath], { encoding: 'utf8' });
    assert.equal(cliParsed.status, 0, cliParsed.stderr);
    const cliResult = JSON.parse(cliParsed.stdout);
    assert.deepEqual(cliResult.errors, []);
    assert.deepEqual(cliResult.warnings, []);
    assert.equal(cliResult.records.length, 1);
    assert.equal(cliResult.records[0].valid, true);
    assert.equal(cliResult.records[0].selected, true);
    assert.deepEqual(cliResult.records[0].record, record);
  });
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
  const publishedSchema = JSON.parse(schema.stdout);
  assert.equal(publishedSchema.title, recordSchema().title);
  assert.equal(publishedSchema.oneOf[0].properties.report.properties.format.const, 'slp-report');
});

test('records --render <file> outputs narrative followed by the original fenced record', t => {
  const dir = temp(t), reportFile = join(dir, 'handoff.md');
  const source = block(handback({ report: executionReport() })).replaceAll('\n', '\r\n');
  const originalFence = source.slice(2);
  writeFileSync(reportFile, source);
  const rendered = spawnSync(process.execPath, [join(root, 'bin/slp.mjs'), 'records', '--render', reportFile], { encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Self-reported narrative/u);
  assert.match(rendered.stdout, /Ran \(self-reported; not proof of execution\)/u);
  assert.ok(rendered.stdout.endsWith(originalFence));

  const invalid = join(dir, 'legacy.md');
  writeFileSync(invalid, block(handback()));
  const missingReport = spawnSync(process.execPath, [join(root, 'bin/slp.mjs'), 'records', '--render', invalid], { encoding: 'utf8' });
  assert.equal(missingReport.status, 1);
  assert.ok(JSON.parse(missingReport.stdout).errors.some(error => error.code === 'structured-report-required'));
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
