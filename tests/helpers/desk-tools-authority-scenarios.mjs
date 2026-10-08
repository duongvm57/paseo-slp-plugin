import assert from 'node:assert/strict';
import test from 'node:test';
import { realDesk, realLifecycle } from './task-execution-fixtures.mjs';
import { latestTask, latestTaskEntity, runTaskCommand } from '../../plugin/server/desk-task.ts';
import { runTaskDispatch } from '../../plugin/server/desk-task-execution.ts';

test('role authority witnesses use the existing real task lifecycle', async t => {
  await realLifecycle(t);
});

test('bound worker hold and acknowledgment, owner stop and reconciliation witnesses', async t => {
  const d = await realDesk(t);
  await d.define();
  const boot = await runTaskDispatch(d.ctx, d.bootInput(), d.deps);
  assert.equal(boot.ok, true, JSON.stringify(boot));
  const sent = await runTaskDispatch(d.ctx, d.sendInput(boot.attemptId), d.deps);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const pins = () => ({ assignmentId: d.assignmentId, expectedLedgerRevision: d.ledger().revision,
    expectedBriefRevision: 0, expectedOwnershipRevision: 0 });
  const worker = { repoKey: d.repoKey, row: d.seat };
  const delivery = d.ledger().taskEntries.filter(row => row.kind === 'delivery').at(-1);
  const ack = await runTaskCommand(worker, { ...pins(), operation: 'acknowledge', requestId: 'role-ack',
    deliveryId: delivery.deliveryId, acknowledgment: 'responsibility-acknowledged', reason: 'fixture receipt' }, { store: d.store });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const held = await runTaskCommand(worker, { ...pins(), operation: 'hold', requestId: 'role-hold', taskId: 'task-1',
    attemptId: boot.attemptId, holdId: null, expectedTaskRevision: latestTask(d.ledger(), d.assignmentId, 'task-1').revision,
    hold: { holdKind: 'manual', question: 'Role fixture question', proposition: null, claimRefs: [], resourceIds: [] },
    ruling: null }, { store: d.store });
  assert.equal(held.ok, true, JSON.stringify(held));
  const stopped = await d.taskCommand({ ...pins(), operation: 'stop', requestId: 'role-stop',
    taskId: 'task-1', attemptId: boot.attemptId, reason: 'fixture bounded stop',
    expectedTaskRevision: latestTask(d.ledger(), d.assignmentId, 'task-1').revision });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  const reconciled = await d.taskCommand({ operation: 'reconcile', requestId: 'role-reconcile', assignmentId: d.assignmentId,
    expectedLedgerRevision: d.ledger().revision, attemptIds: [boot.attemptId], actionIds: [], resourceIds: [], observationTypes: [] });
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.ok(latestTaskEntity(d.ledger(), boot.attemptId));
});
