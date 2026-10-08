import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realDesk, taskSpec, bootstrapInput } from './helpers/task-execution-fixtures.mjs';
import { runTaskDispatch, subRequestId } from '../plugin/server/desk-task-execution.ts';
import { runTaskDeliver } from '../plugin/server/desk-delivery.ts';
import { createDeskOperations } from '../plugin/server/desk-operation.ts';
import { effectIdentity } from '../plugin/server/desk-task-execution-host.ts';
import { WIRE_LIMITS } from '../plugin/shared/enforcement.ts';

const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const trailer = (text, assignmentId, taskId, attemptId, parentId) =>
  `\n\nDesk delivery (claim; no authority grant):\nLead text sha256: ${hash(text)}\nAssignment id: ${JSON.stringify(assignmentId)}\nTask id: ${JSON.stringify(taskId)}\nAttempt id: ${JSON.stringify(attemptId)}\nHandback route: the verified parent agent ID is ${JSON.stringify(parentId)}.\n`;

test('dispatch appends one desk claim with byte-identical Lead text and verified sender pins', async t => {
  const d = await realDesk(t); await d.define();
  const boot = await runTaskDispatch(d.ctx, d.bootInput(), d.deps);
  assert.equal(boot.state, 'bound', JSON.stringify(boot));
  const request = { ...d.sendInput(boot.attemptId), text: 'Read café 🐋.\r\nKeep trailing whitespace. \n' };
  const out = await runTaskDispatch(d.ctx, request, d.deps);
  assert.equal(out.sent, true, JSON.stringify(out));
  assert.equal(d.host.calls.send.length, 1);
  const sent = d.host.calls.send[0].text;
  assert.deepEqual(Buffer.from(sent).subarray(0, Buffer.byteLength(request.text)), Buffer.from(request.text));
  assert.equal(sent, request.text + trailer(request.text, d.assignmentId, request.taskId, boot.attemptId, d.ctx.row.agentId));
  assert.equal(sent.split('Desk delivery (claim; no authority grant):').length, 2);
  const action = d.ledger().taskEntries.find(row => row.kind === 'action' && row.actionKind === 'send');
  assert.equal(action.body.textSha256, hash(request.text), 'existing Lead-text pin retains its meaning');
  assert.equal(action.body.sentTextSha256, hash(sent));
  assert.equal(action.body.sentTextBytes, Buffer.byteLength(sent));
  assert.equal(action.body.deliveryTrailer, sent.slice(request.text.length));
  const replay = await runTaskDispatch(d.ctx, request, d.deps);
  assert.equal(replay.perform, false, JSON.stringify(replay));
  assert.equal(d.host.calls.send.length, 1, 'exact phased replay never sends twice');
  assert.equal(d.host.calls.send[0].text, sent);
  const altered = await runTaskDispatch(d.ctx, { ...request, text: request.text + 'changed' }, d.deps);
  assert.equal(altered.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(d.host.calls.send.length, 1);
});

for (const text of ['x'.repeat(WIRE_LIMITS.deskTaskText), '漢'.repeat(12000)]) {
  test(`dispatch rejects composed prompt overflow before send admission (${Buffer.byteLength(text)} Lead bytes)`, async t => {
    const d = await realDesk(t); await d.define();
    const boot = await runTaskDispatch(d.ctx, d.bootInput(), d.deps);
    const before = d.ledger().revision;
    const out = await runTaskDispatch(d.ctx, { ...d.sendInput(boot.attemptId), text }, d.deps);
    assert.equal(out.code, 'REQUEST_TOO_LARGE', JSON.stringify(out));
    assert.equal(d.ledger().revision, before);
    assert.equal(d.host.calls.send.length, 0);
  });
}

const deliveryRequest = (d, text) => ({ requestId: 'semantic-trailer', assignmentId: d.assignmentId,
  expectedLedgerRevision: d.ledger().revision, expectedBriefRevision: 0, expectedOwnershipRevision: 0,
  task: taskSpec(), runtime: bootstrapInput().runtime, text });

test('semantic delivery rejects near-cap text before defining a task or creating a seat', async t => {
  const d = await realDesk(t);
  const before = d.ledger().revision;
  const out = await runTaskDeliver(d.ctx, deliveryRequest(d, 'x'.repeat(WIRE_LIMITS.deskTaskText)), d.deps);
  assert.equal(out.result.code, 'REQUEST_TOO_LARGE', JSON.stringify(out));
  assert.equal(d.ledger().revision, before);
  assert.equal(d.host.calls.create.length, 0);
  assert.equal(d.host.calls.send.length, 0);
});

test('dispatch accepts exactly the composed UTF-8 byte cap and rejects one extra byte', async t => {
  const d = await realDesk(t); await d.define();
  const boot = await runTaskDispatch(d.ctx, d.bootInput(), d.deps);
  const suffixBytes = Buffer.byteLength(trailer('', d.assignmentId, 'task-1', boot.attemptId, d.ctx.row.agentId));
  const text = 'x'.repeat(WIRE_LIMITS.deskTaskText - suffixBytes);
  const out = await runTaskDispatch(d.ctx, { ...d.sendInput(boot.attemptId), text }, d.deps);
  assert.equal(out.sent, true, JSON.stringify(out));
  assert.equal(Buffer.byteLength(d.host.calls.send[0].text), WIRE_LIMITS.deskTaskText);
  const before = d.ledger().revision;
  const extra = await runTaskDispatch(d.ctx, { ...d.sendInput(boot.attemptId, 'one-extra'), text: text + 'x' }, d.deps);
  assert.equal(extra.code, 'REQUEST_TOO_LARGE', JSON.stringify(extra));
  assert.equal(d.ledger().revision, before);
  assert.equal(d.host.calls.send.length, 1);
});

test('semantic delivery and operation lookup replay identical receipt and prompt bytes without a second send', async t => {
  const d = await realDesk(t);
  const request = deliveryRequest(d, 'Read café 🐋 and report.\n');
  const out = await runTaskDeliver(d.ctx, request, d.deps);
  assert.equal(out.result.delivery.sent, true, JSON.stringify(out));
  const bytes = Buffer.from(request.text + trailer(request.text, d.assignmentId, out.result.taskId, out.result.attemptId, d.ctx.row.agentId));
  assert.deepEqual(Buffer.from(d.host.calls.send[0].text), bytes);
  const replay = await runTaskDeliver(d.ctx, request, d.deps);
  assert.equal(replay.replayed, true);
  assert.equal(replay.receiptSha256, out.receiptSha256);
  assert.deepEqual(replay.result, out.result);
  const receipt = createDeskOperations(d.deps.scratch.stableRoot).get(out.identity);
  assert.equal(receipt.receiptSha256, out.receiptSha256);
  assert.deepEqual(receipt.result, out.result);
  assert.equal(d.host.calls.send.length, 1);
  assert.deepEqual(Buffer.from(d.host.calls.send[0].text), bytes);
  assert.equal(d.host.calls.create.length, 1);
});

test('unchanged Lead text and recorded identity pins produce identical bytes on separate admitted deliveries', async t => {
  const d = await realDesk(t); await d.define();
  const boot = await runTaskDispatch(d.ctx, d.bootInput(), d.deps);
  const sent = [];
  for (let index = 0; index < 2; index++) {
    const out = await runTaskDispatch(d.ctx, { ...d.sendInput(boot.attemptId, `deterministic-${index}`),
      text: 'Inspect only; report evidence.\r\n' }, d.deps);
    assert.equal(out.sent, true, JSON.stringify(out));
    sent.push(Buffer.from(d.host.calls.send[index].text));
  }
  assert.deepEqual(sent[0], sent[1]);
});

test('pre-trailer ledger sends and operation receipts remain readable and exactly replayable, including old cap text', async t => {
  const d = await realDesk(t); await d.define();
  const boot = await runTaskDispatch(d.ctx, d.bootInput(), d.deps);
  const request = { ...d.sendInput(boot.attemptId), text: 'x'.repeat(WIRE_LIMITS.deskTaskText) };
  const messageId = effectIdentity('send', request.requestId);
  const { assignmentId, taskId, expectedLedgerRevision, expectedBriefRevision, expectedOwnershipRevision,
    expectedTaskRevision, expectedAttemptRevision } = request;
  const body = { textSha256: hash(request.text), messageId, grantRef: request.grantRef,
    controlPins: { assignmentId, taskId, expectedLedgerRevision, expectedBriefRevision, expectedOwnershipRevision,
      expectedTaskRevision, expectedAttemptRevision } };
  const intent = await d.deps.task.runTaskEffect(d.ctx, { operation: 'intent',
    requestId: subRequestId(request.requestId, 'send-intent'), attemptId: boot.attemptId, actionKind: 'send', body }, { store: d.store });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  const issue = await d.deps.task.runTaskEffect(d.ctx, { operation: 'issue',
    requestId: subRequestId(request.requestId, 'send-issue'), attemptId: boot.attemptId,
    actionId: intent.actionId, actionKind: 'send' }, { store: d.store });
  assert.equal(issue.perform, true, JSON.stringify(issue));
  await d.deps.host().agents.ref(boot.agentId).send(request.text, { messageId });
  const observed = await d.deps.task.runTaskEffect(d.ctx, { operation: 'observe',
    requestId: subRequestId(request.requestId, 'send-observe'), attemptId: boot.attemptId,
    actionId: intent.actionId, actionKind: 'send', receipt: { status: 'observed', accepted: true, messageId } }, { store: d.store });
  assert.equal(observed.ok, true, JSON.stringify(observed));
  const before = d.ledger().revision;
  const replay = await runTaskDispatch(d.ctx, request, d.deps);
  assert.equal(replay.perform, false, JSON.stringify(replay));
  assert.equal(d.ledger().revision, before);
  assert.deepEqual(d.ledger().taskEntries.find(row => row.kind === 'action' && row.actionKind === 'send').body, body);
  assert.equal(d.host.calls.send.length, 1);
  assert.equal(d.host.calls.send[0].text, request.text);

  const ops = createDeskOperations(d.deps.scratch.stableRoot);
  const oldRequest = deliveryRequest(d, request.text);
  const identity = { repoKey: d.repoKey, membershipId: d.ctx.row.membershipId, agentId: d.ctx.row.agentId,
    kind: 'task-deliver', requestId: oldRequest.requestId };
  const oldResult = { taskId, attemptId: boot.attemptId, delivery: { ok: true, sent: true, messageId } };
  const old = await ops.run(identity, oldRequest, async phase => { phase('sent', oldResult.delivery); return oldResult; });
  const oldReplay = await runTaskDeliver(d.ctx, oldRequest, d.deps);
  assert.equal(oldReplay.receiptSha256, old.receiptSha256);
  assert.deepEqual(oldReplay.result, oldResult);
  assert.equal(ops.get(identity).receiptSha256, old.receiptSha256);
  assert.equal(d.host.calls.send.length, 1);
  assert.equal(d.ledger().revision, before);
});
