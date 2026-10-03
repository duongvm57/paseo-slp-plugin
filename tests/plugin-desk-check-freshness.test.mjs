import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createDeskStore, repoKeyFor } from '../plugin/server/desk-store.ts';
import { captureSeatSnapshot, runAssignmentRegister, runAssignmentAttach, runAssignmentClose, runHandbackSubmit } from '../plugin/server/desk-handback.ts';
import { runScopeDeclare } from '../plugin/server/desk-scope.ts';
import { runCheckDeclare, runCheckRun } from '../plugin/server/desk-check-runner.ts';
import { runRolloutDeclare, runRolloutTransition } from '../plugin/server/desk-rollout.ts';
import { snapshot } from '../plugin/server/runtime/cli/package.ts';
import { memberRow, seedMemberships } from './helpers/desk-bridge-fixture.mjs';

const exec = promisify(execFile);
const now = () => new Date('2026-10-03T06:00:00.000Z');
const accepted = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'check-fresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repo');
  const runtimePath = join(root, 'runtime');
  mkdirSync(repository);
  const git = (...argv) => {
    const result = spawnSync('git', ['--no-optional-locks', ...argv], {
      cwd: repository, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init', '-q');
  writeFileSync(join(repository, 'mode.txt'), 'steered\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'chore: isolated fixture');
  const modulePath = 'plugin/server/runtime/cli/package.ts';
  mkdirSync(join(runtimePath, 'plugin/server/runtime/cli'), { recursive: true });
  for (const name of ['package.ts', 'types.ts']) {
    copyFileSync(new URL(`../plugin/server/runtime/cli/${name}`, import.meta.url), join(runtimePath, 'plugin/server/runtime/cli', name));
  }
  // Receipt chỉ nối seam capture của fixture; không xác nhận host installation.
  writeFileSync(join(runtimePath, 'installed.json'), JSON.stringify({ candidate: { files: [{ path: modulePath }] } }));
  const binding = { runtimePath, nodePath: process.execPath };
  const store = createDeskStore({ stableRoot: join(root, 'store') });
  const repo = { hostId: 'fixture', gitCommonDir: join(repository, '.git') };
  const repoKey = repoKeyFor(repo);
  const member = (agentId, role) => memberRow(`fixture-${agentId}`, { provider: `slp-codex-${role}`, at: now().toISOString() }, {
    agentId, role, workspaceId: 'fixture-workspace', createCwd: repository,
  });
  const lead = member('owner', 'lead');
  const writer = member('writer', 'peer');
  await seedMemberships(store, repo, [lead, writer]);
  const ctx = { repoKey, row: lead };
  const deps = { store, binding, capture: captureSeatSnapshot, uuid: randomUUID, now };
  const assignmentId = accepted(await runAssignmentRegister(ctx, { requestId: 'register', authorityRef: 'fixture:grant', objective: 'Kiểm chứng exact candidate' }, deps)).assignmentId;
  accepted(await runAssignmentAttach(ctx, { requestId: 'attach', assignmentId, agentId: 'writer' }, deps));
  accepted(await runScopeDeclare(ctx, { requestId: 'scope', assignmentId, scopeId: 'scope', label: 'fixture', declarationSha256: 'a'.repeat(64), refs: [], seatAgentId: 'writer',
    reviewPlan: { kind: 'not-required', authorityRef: 'fixture:grant', ruleRef: 'fixture:local-proof', reason: 'Fixture source-local không tuyên bố acceptance', lenses: [], exemptionClass: null } }, deps));
  const pinned = snapshot(repository);
  accepted(await runHandbackSubmit({ repoKey, row: writer }, { requestId: 'candidate', assignmentId, candidateId: null,
    recordV1: { version: 1, kind: 'handback', seat: { role: 'peer', disposition: 'Engineer', agentId: 'writer' }, verdict: null,
      candidate: { repository, snapshotSha256: pinned.sha256 }, checks: [] } }, deps));
  accepted(await runCheckDeclare(ctx, { requestId: 'declare-check', assignmentId, scopeId: 'scope', checkId: 'head', checkClass: 'repo-git-head', label: 'Fixed head check',
    definitionSha256: 'b'.repeat(64), limits: { timeoutMs: 5000, maxOutputBytes: 16384, maxRetries: 0 }, requiredEvidence: [], refs: [] }, deps));
  accepted(await runRolloutDeclare(ctx, { requestId: 'rollout', assignmentId, scopeId: 'scope', rolloutId: 'rollout', label: 'fixture', declarationSha256: 'c'.repeat(64),
    candidateSnapshot: pinned.sha256, candidateHead: pinned.head, requiredChecks: [{ checkId: 'head', definitionDigest: 'b'.repeat(64) }], refs: [] }, deps));
  accepted(await runRolloutTransition(ctx, { requestId: 'start', assignmentId, rolloutId: 'rollout', transition: 'start-checks', rolloutRevision: 1, targetSnapshot: null, evidenceRefs: [] }, deps));
  const input = { requestId: 'run', assignmentId, rolloutId: 'rollout', checkId: 'head', definitionRevision: 1, evidenceRef: null };
  const executions = [];
  const captures = [];
  deps.exec = async (...args) => {
    const result = await exec(...args);
    executions.push({ cmd: args[0], argv: args[1], stdout: result.stdout, stderr: result.stderr });
    t.diagnostic(JSON.stringify({ execution: executions.at(-1) }));
    return result;
  };
  deps.capture = async args => {
    const result = await captureSeatSnapshot(args);
    captures.push(result);
    t.diagnostic(JSON.stringify({ capture: result }));
    return result;
  };
  const ledger = () => { const read = store.read(repoKey); assert.equal(read.state, 'ok'); return read.ledger; };
  const dirty = () => writeFileSync(join(repository, 'mode.txt'), 'drift\n');
  return { ctx, deps, input, repository, pinned, executions, captures, ledger, dirty, repo, lead, writer };
}

test('dirty drift with the same HEAD rejects before the fixed check executes', async t => {
  const f = await fixture(t);
  f.dirty();
  const actual = snapshot(f.repository);
  assert.equal(actual.head, f.pinned.head);
  assert.notEqual(actual.sha256, f.pinned.sha256);
  t.diagnostic(JSON.stringify({ pinned: f.pinned.sha256, actual: actual.sha256, head: actual.head }));
  const result = await runCheckRun(f.ctx, f.input, f.deps);
  t.diagnostic(JSON.stringify({ result }));
  assert.equal(result.ok, false, 'Dirty cùng HEAD không được ghi passed dưới snapshot cũ');
  assert.equal(result.code, 'CANDIDATE_DRIFT');
  assert.equal(f.executions.length, 0);
  assert.equal(f.ledger().checkRuns.length, 0);
});

test('dirty drift during real execution keeps raw output but cannot commit the old candidate', async t => {
  const f = await fixture(t);
  const execute = f.deps.exec;
  f.deps.exec = async (...args) => {
    const result = await execute(...args);
    f.dirty();
    return result;
  };
  const result = await runCheckRun(f.ctx, f.input, f.deps);
  t.diagnostic(JSON.stringify({ result, actual: snapshot(f.repository).sha256 }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANDIDATE_DRIFT');
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].stdout, `${f.pinned.head}\n`);
  assert.equal(f.ledger().checkRuns.length, 0);
});

test('unchanged candidate passes and exact replay stays historical after dirty drift and closure', async t => {
  const f = await fixture(t);
  const result = accepted(await runCheckRun(f.ctx, f.input, f.deps));
  assert.equal(result.status, 'passed');
  assert.equal(f.executions.length, 1);
  assert.deepEqual(f.executions[0].argv, ['rev-parse', 'HEAD']);
  assert.equal(f.captures.length, 2);
  const row = f.ledger().checkRuns[0];
  assert.equal(row.candidateSnapshot, f.pinned.sha256);
  assert.equal(row.candidateHead, f.pinned.head);
  f.dirty();
  accepted(await runAssignmentClose(f.ctx, { requestId: 'close', assignmentId: f.input.assignmentId }, f.deps));
  f.deps.binding = null;
  f.deps.capture = async () => { assert.fail('Historical replay must not capture'); };
  f.deps.exec = async () => { assert.fail('Historical replay must not execute'); };
  assert.deepEqual(await runCheckRun(f.ctx, f.input, f.deps), result);
  assert.equal(f.ledger().checkRuns.length, 1);
  // Replay vẫn kiểm tra membership hiện hành trước khi trả row lịch sử.
  await seedMemberships(f.deps.store, f.repo, [{ ...f.lead, state: 'revoked', revokedAt: now().toISOString(), revokeReason: 'archived' }, f.writer]);
  const denied = await runCheckRun(f.ctx, f.input, f.deps);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'AUTHORITY_REQUIRED');
});

for (const fault of ['missing-capture', 'missing-binding', 'throw', 'failed', 'incomplete', 'invalid']) {
  test(`unavailable or incomplete capture fails closed before execution: ${fault}`, async t => {
    const f = await fixture(t);
    const capture = f.deps.capture;
    if (fault === 'missing-capture') delete f.deps.capture;
    else if (fault === 'missing-binding') f.deps.binding = null;
    else f.deps.capture = async args => {
      if (fault === 'throw') throw new Error('Fixture capture unavailable');
      const observed = await capture(args);
      if (fault === 'failed') return { status: 'failed', repository: args.repository, measuredAt: now().toISOString(), reason: 'exit', detail: 'Fixture unavailable' };
      if (fault === 'incomplete') return { ...observed, incomplete: ['mode.txt'] };
      return { ...observed, snapshotSha256: 'invalid' };
    };
    const result = await runCheckRun(f.ctx, f.input, f.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CAPABILITY_GAP');
    assert.equal(f.executions.length, 0);
    assert.equal(f.ledger().checkRuns.length, 0);
  });
}

for (const field of ['repository', 'head']) {
  test(`capture with a different ${field} cannot qualify the pinned candidate`, async t => {
    const f = await fixture(t);
    const capture = f.deps.capture;
    f.deps.capture = async args => ({ ...await capture(args), [field]: field === 'repository' ? '/other-repository' : 'f'.repeat(40) });
    const result = await runCheckRun(f.ctx, f.input, f.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CANDIDATE_DRIFT');
    assert.equal(f.executions.length, 0);
    assert.equal(f.ledger().checkRuns.length, 0);
  });
}

for (const fault of ['failed', 'incomplete']) {
  test(`capture ${fault} after execution cannot commit a measured pass`, async t => {
    const f = await fixture(t);
    const capture = f.deps.capture;
    let executed = false;
    const execute = f.deps.exec;
    f.deps.exec = async (...args) => { const result = await execute(...args); executed = true; return result; };
    f.deps.capture = async args => {
      const observed = await capture(args);
      if (!executed) return observed;
      return fault === 'incomplete' ? { ...observed, incomplete: ['mode.txt'] }
        : { status: 'failed', repository: args.repository, measuredAt: now().toISOString(), reason: 'exit', detail: 'Fixture unavailable after execution' };
    };
    const result = await runCheckRun(f.ctx, f.input, f.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CAPABILITY_GAP');
    assert.equal(f.executions.length, 1);
    assert.equal(f.executions[0].stdout, `${f.pinned.head}\n`);
    assert.equal(f.ledger().checkRuns.length, 0);
  });
}
