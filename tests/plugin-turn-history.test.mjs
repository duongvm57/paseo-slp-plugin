import test from 'node:test';
import assert from 'node:assert/strict';
import { readTurnHistory } from '../plugin/server/turn-history.ts';

const event = (over = {}) => ({ agent: { id: 'peer', provider: 'slp-codex-peer', parentAgentId: 'lead', workspaceId: null, cwd: '/tmp', title: null },
  turnId: 'ended', outcome: { kind: 'completed' }, timeline: [], ...over });
const row = (turnId, text) => ({ turnId, item: { type: 'user_message', text } });
const page = over => ({ agentId: 'peer', entries: [row('ended', 'brief')], hasOlder: false, hasNewer: false,
  error: null, reset: false, staleCursor: false, gap: false, ...over });
const api = (result, calls = []) => ({ agents: { ref(id) { return { timeline: { refetch: async options => {
  calls.push({ id, options }); return typeof result === 'function' ? result() : result;
} } }; } } });

test('legacy turn payload stays untouched and never reads history', async () => {
  const original = event({ timeline: [{ type: 'assistant_message', text: 'original' }] });
  const calls = [];
  assert.equal(await readTurnHistory(original, api(page(), calls)), original);
  assert.equal(calls.length, 0);
});

test('empty hooks fetch only the exact ended turn, excluding older and newer turns', async () => {
  const calls = [];
  const response = page({ hasOlder: true, entries: [row('older', 'old'), row('ended', 'brief'),
    { turnId: 'ended', item: { type: 'assistant_message', text: 'handback' } }, row('newer', 'foreign')] });
  const observed = await readTurnHistory(event(), api(response, calls));
  assert.deepEqual(observed.timeline.map(item => item.text), ['brief', 'handback']);
  assert.deepEqual(calls, [{ id: 'peer', options: { direction: 'tail', limit: 500, projection: 'projected' } }]);
});

for (const [name, over] of [
  ['foreign agent', { agentId: 'other' }], ['missing turn', { entries: [row('newer', 'foreign')] }],
  ['truncated beginning', { hasOlder: true }], ['truncated end', { hasNewer: true }],
  ['unknown preceding boundary', { entries: [row(undefined, 'unknown'), row('ended', 'brief')] }],
  ['unknown trailing boundary', { entries: [row('ended', 'brief'), row(undefined, 'unknown')] }],
  ['discontinuous turn', { entries: [row('ended', 'brief'), row('other', 'other'), row('ended', 'late')] }],
  ['oversized page', { entries: Array.from({ length: 501 }, () => row('ended', 'large')) }],
  ['missing bounds', { hasOlder: undefined }], ['error', { error: 'history unavailable' }],
  ['reset', { reset: true }], ['stale cursor', { staleCursor: true }], ['gap', { gap: true }],
]) {
  test(`history cannot establish evidence: ${name}`, async () => {
    assert.equal(await readTurnHistory(event(), api(page(over))), null);
  });
}

test('missing turn IDs or history capability never fall back to latest messages', async () => {
  const calls = [];
  assert.equal(await readTurnHistory(event({ turnId: null }), api(page(), calls)), null);
  assert.equal(calls.length, 0);
  assert.equal(await readTurnHistory(event(), { agents: { ref: () => ({}) } }), null);
});

test('rejection, bounded timeout and abort leave history unverified without retries', async () => {
  assert.equal(await readTurnHistory(event(), api(() => { throw Error('offline'); })), null);
  const calls = [];
  assert.equal(await readTurnHistory(event(), api(() => new Promise(() => {}), calls), new AbortController().signal, 10), null);
  assert.equal(calls.length, 1);
  const controller = new AbortController();
  const pending = readTurnHistory(event(), api(() => new Promise(() => {})), controller.signal);
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(await readTurnHistory(event(), api(page(), calls), controller.signal), null);
  assert.equal(calls.length, 1);
});
