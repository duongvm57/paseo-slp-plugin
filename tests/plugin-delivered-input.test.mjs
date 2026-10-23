import test from 'node:test';
import assert from 'node:assert/strict';
import { agentMessageOf, deliveryMessageIds, matchesDelivery, deliveryTimelineItem } from '../plugin/server/delivered-input.ts';

const projected = (changes = {}) => ({
  type: 'tool_call', name: 'agent_message', status: 'completed', error: null,
  callId: 'paseo-agent-message:delivery',
  agentMessage: { event: 'message', sender: { id: 'lead' }, text: 'Assignment' },
  detail: { type: 'plain_text', text: 'presentation must not determine identity' },
  ...changes,
});
test('legacy inputs retain both correlation IDs without proving Human origin', () => {
  const item = { type: 'user_message', messageId: 'delivery', clientMessageId: 'client' };
  assert.deepEqual(deliveryMessageIds(item), ['delivery', 'client']);
  assert.equal(matchesDelivery(item, 'client', 'lead'), true);
  assert.equal(agentMessageOf(item), null);
});
test('semantic projected input preserves source, body and ID through lifecycle forwarding', () => {
  const item = projected();
  assert.deepEqual(agentMessageOf(item), { event: 'message', sender: { id: 'lead' }, text: 'Assignment', messageId: 'delivery' });
  const forwarded = deliveryTimelineItem(item);
  assert.equal(matchesDelivery(forwarded, 'delivery', 'lead'), true);
  assert.equal('detail' in forwarded, false);
  assert.equal(matchesDelivery(forwarded, 'delivery', 'foreign'), false);
  assert.equal(matchesDelivery(forwarded, 'delivery', undefined), false);
  assert.deepEqual(deliveryTimelineItem({ type: 'assistant_message', text: 'private output' }), { type: 'assistant_message' });
});
test('finish and other notifications cannot confirm a Desk send', () => {
  for (const event of ['finished', 'errored', 'closed', 'permission-required']) {
    const item = projected({ agentMessage: { event, sender: { id: 'lead' }, text: 'Notification' } });
    assert.equal(agentMessageOf(item).event, event, 'capture still receives notification semantics');
    assert.deepEqual(deliveryMessageIds(item), []);
    assert.equal(matchesDelivery(item, 'delivery', 'lead'), false);
  }
});
test('malformed projected inputs cannot borrow IDs or provenance from presentation fields', () => {
  for (const change of [
    { status: 'running' }, { error: 'failed' }, { name: 'other' },
    { callId: 'paseo-agent-message:' }, { callId: 'delivery' },
    { agentMessage: undefined }, { agentMessage: { event: 'message', sender: { id: 'lead' } } },
    { agentMessage: { event: 'message', sender: { id: '' }, text: 'Assignment' } },
  ]) {
    const item = projected({ messageId: 'delivery', clientMessageId: 'delivery', ...change });
    assert.deepEqual(deliveryMessageIds(item), []);
    assert.equal(matchesDelivery(item, 'delivery', 'lead'), false);
  }
});
