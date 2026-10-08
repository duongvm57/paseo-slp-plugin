import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideDeskAssignment, projectDeskWorkflow } from '../plugin/server/desk-assignment.ts';
import { decideDeskHandback } from '../plugin/server/desk-handback.ts';
import { decideDeskOwnership } from '../plugin/server/desk-ownership.ts';
import { decideDeskCheck, runCheckRun } from '../plugin/server/desk-check-runner.ts';
import { decideDeskScope } from '../plugin/server/desk-scope.ts';
import { decideDeskRollout } from '../plugin/server/desk-rollout.ts';
import { decideDeskSettlement } from '../plugin/server/desk-settlement.ts';
import { decideDeskTask } from '../plugin/server/desk-task.ts';
import { sha256Hex } from '../plugin/server/config-view.ts';
import {
  BIN_SOURCE, bridgeFixture, gitRepo, memberRow, repoOf, seedMemberships, seedStore,
} from './helpers/desk-bridge-fixture.mjs';

const LOOKUP = 'look up registered assignments with slp_status; tell the Lead to register the assignment under the current Human grant';
const NO_LIVE = 'look up current bindings with slp_status; tell the Lead — retrying cannot rebind a revoked seat';
const AT = '2026-01-01T00:00:00.000Z';
const SHA = 'a'.repeat(64);

test('rewritten authority recovery is exact at every rejection site', async t => {
  const pin = sha256Hex(readFileSync(BIN_SOURCE));
  const store = seedStore(bridgeFixture(t, 'slp-recovery-sites-', pin));
  const repo = repoOf(gitRepo(t, 'slp-recovery-sites-repo-'));
  const lead = memberRow('lead', { provider: 'slp-codex-lead', at: AT }, { role: 'lead', agentId: 'lead' });
  const repoKey = await seedMemberships(store, repo, [lead]);
  const ledger = store.read(repoKey).ledger;
  const revoked = { ...lead, state: 'revoked', revokedAt: AT, revokeReason: 'archived' };
  const revokedLedger = { ...ledger, memberships: [revoked] };
  const revokedStore = seedStore(bridgeFixture(t, 'slp-recovery-revoked-', pin));
  await seedMemberships(revokedStore, repo, [revoked]);
  // Task commands resolve the assignment before returning their actor rejection.
  const registered = decideDeskHandback(ledger, { kind: 'assignment.register', requestId: 'register',
    actorAgentId: lead.agentId, authorityRef: 'Human grant', objective: null });
  assert.equal(registered.ok, true);
  const taskRevokedLedger = { ...revokedLedger,
    assignments: registered.assignments.map(row => ({ ...row, assignmentId: 'missing' })) };
  const base = { requestId: 'recovery', assignmentId: 'missing', actorAgentId: lead.agentId };
  // One triggering call per distinct lookup site. A membershipPrefix marks
  // one representative call through each feature's shared requireActor seam.
  const calls = [
    { site: 'desk-assignment.ts assignmentForMutation', decide: decideDeskAssignment, kind: 'assignment.amend',
      membershipPrefix: 'a workflow mutation requires a current live desk membership',
      args: { expectedBriefRevision: 0, authorityRef: 'Human grant', changeReason: 'change', affectedOwners: [],
        brief: { objective: 'artifact', acceptanceCriteria: ['proof'], constraints: [], provisionalDesign: 'design',
          assumptions: [], unknowns: [], requiredEvidence: [], ownedSurfaces: [], excludedSurfaces: [],
          dependencies: [], notifications: [] } } },
    { site: 'desk-handback.ts attach', decide: decideDeskHandback, kind: 'assignment.attach', args: { agentId: 'worker' },
      membershipPrefix: 'a handback commit needs a host-bound, registered seat row' },
    { site: 'desk-handback.ts close', decide: decideDeskHandback, kind: 'assignment.close', args: {} },
    { site: 'desk-handback.ts submit', decide: decideDeskHandback, kind: 'handback.submit',
      args: { recordV1: {}, candidateId: null } },
    { site: 'desk-ownership.ts ownership lookup', decide: decideDeskOwnership, kind: 'ownership.offer',
      membershipPrefix: 'an ownership mutation requires a current live desk membership',
      args: { expectedOwnershipRevision: 0, targetAgentId: 'worker', targetMembershipId: lead.membershipId,
        authorityRef: 'Human grant', contextRef: 'context' } },
    { site: 'desk-check-runner.ts declaration lookup', decide: decideDeskCheck, kind: 'check.declare',
      membershipPrefix: 'a check command needs a host-bound, registered row — peers and revoked seats cannot move check state',
      args: { scopeId: 'scope', checkId: 'check', checkClass: 'ledger-integrity', label: 'check', definitionSha256: SHA,
        limits: { timeoutMs: 1000, maxOutputBytes: 1024, maxRetries: 0 }, requiredEvidence: [], refs: [] } },
    { site: 'desk-scope.ts owner scope lookup', decide: decideDeskScope, kind: 'scope.declare',
      membershipPrefix: 'a scope command needs a host-bound, registered row — peers and revoked seats cannot move scope state',
      args: { scopeId: 'scope', label: 'scope', declarationSha256: SHA, refs: [], seatAgentId: null } },
    { site: 'desk-scope.ts review lookup', decide: decideDeskScope, kind: 'scope.review',
      args: { scopeId: 'scope', scopeRevision: 1, candidateSnapshot: SHA, axis: 'spec', verdict: 'approve', findingsRef: null } },
    { site: 'desk-rollout.ts rollout lookup', decide: decideDeskRollout, kind: 'rollout.declare',
      membershipPrefix: 'a rollout command needs a host-bound, registered row — peers and revoked seats cannot move rollout state',
      args: { scopeId: 'scope', rolloutId: 'rollout', label: 'rollout', declarationSha256: SHA,
        candidateSnapshot: SHA, candidateHead: null, requiredChecks: [], refs: [] } },
    { site: 'desk-settlement.ts settlement lookup', decide: decideDeskSettlement, kind: 'settlement.record',
      membershipPrefix: 'a settlement commit needs a host-bound, registered lead row',
      args: { seatAgentId: 'worker', seatTitle: 'worker', at: AT, deliveryRef: null, reworkClosureRef: null,
        sinkRef: null, decisionRef: null, handbackRefs: [], candidateRefs: [], resources: [],
        timeline: { nativeHandle: null, sessionId: null, via: 'unchecked', export: null, gap: null },
        exportVerification: null } },
    { site: 'desk-task.ts openAssignment', decide: decideDeskTask, kind: 'task.update',
      membershipPrefix: null,
      args: { actorMembershipId: lead.membershipId, actorOpenGeneration: lead.openGeneration,
        operation: 'abandon', taskId: 'task', expectedTaskRevision: 1, task: null, reason: null } },
  ];
  const invoke = (call, state) => call.decide(state, { ...base, kind: call.kind, ...call.args });
  const check = { requestId: 'run', assignmentId: 'missing', rolloutId: 'rollout', checkId: 'check',
    definitionRevision: 1, evidenceRef: null };
  const rows = [
    ...calls.map(call => ({ site: `${call.site}: assignment lookup`, run: () => invoke(call, ledger), expected: LOOKUP })),
    { site: 'desk-assignment.ts projectDeskWorkflow: assignment lookup', expected: LOOKUP,
      run: () => projectDeskWorkflow(ledger, 'missing', { section: 'briefs', expectedLedgerRevision: null,
        expectedBriefRevision: null, cursor: null, limit: 1 }) },
    { site: 'desk-check-runner.ts runCheckRun: assignment lookup', expected: LOOKUP,
      run: () => runCheckRun({ repoKey, row: lead }, check, { store }) },
    ...calls.filter(call => call.membershipPrefix !== undefined).map(call => ({
      site: `${call.site}: no live membership`, run: () => invoke(call, call.decide === decideDeskTask ? taskRevokedLedger : revokedLedger),
      expected: call.membershipPrefix === null ? `${NO_LIVE}; a rebound row is a different caller` : `${call.membershipPrefix}; ${NO_LIVE}`,
    })),
    { site: 'desk-check-runner.ts runCheckRun: no live membership', expected: NO_LIVE,
      run: () => runCheckRun({ repoKey, row: lead }, check, { store: revokedStore }) },
  ];
  for (const { site, run, expected } of rows) {
    await t.test(site, async () => {
      const result = await run();
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.code, 'AUTHORITY_REQUIRED', JSON.stringify(result));
      assert.equal(result.recovery, expected);
    });
  }
});
