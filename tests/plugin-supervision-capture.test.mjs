// tests/plugin-supervision-capture.test.mjs — the capture module through its
// one entry point: agent.turn_ended event → brief/handback evidence, per-call
// send input and outcome, send coverage and issues. Positive cases replay
// sanitized normalized timelines observed in the 2026-09-26 live smoke
// (tests/fixtures/supervision/live-*.timeline.json); negatives are labelled
// "synthetic" and mutate one part of an observed envelope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  capture, handbackAnchorIndex, sendCoverageOf, stripAcpRolePrefix, ROLE_PREFIX_TERMINAL,
} from '../plugin/server/supervision/capture.ts';
import { roleDelivery } from '../src/role-bundle.mjs';
import { prompt as launchPrompt } from '../src/launch.mjs';

const LEAD = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';
const ROUTED = new Set([LEAD]);
const REPO = fileURLToPath(new URL('..', import.meta.url));

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/supervision/${name}`, import.meta.url), 'utf8'));
const LIVE = {
  claude: fixture('live-claude-peer.timeline.json'),
  codex: fixture('live-codex-peer.timeline.json'),
  devin: fixture('live-devin-peer.timeline.json'),
  devinLaunch: fixture('live-devin-launch-peer.timeline.json'),
  devinLead: fixture('live-devin-lead.timeline.json'),
  pi: fixture('live-pi-peer.timeline.json'),
};

/** The first Peer turn of a live fixture: every item before the second user_message. */
const firstTurn = items => {
  const second = items.findIndex((item, index) => index > 0 && item.type === 'user_message');
  return second < 0 ? items : items.slice(0, second);
};
const peerEvent = (family, timeline, over = {}) => ({
  agent: { id: PEER, provider: `slp-${family}-peer`, workspaceId: 'wks', parentAgentId: LEAD, cwd: '/tmp', title: null },
  turnId: 'turn-p1',
  outcome: { kind: 'completed' },
  timeline,
  ...over,
});
const leadEvent = (family, timeline, over = {}) => ({
  agent: { id: LEAD, provider: `slp-${family}-lead`, workspaceId: 'wks', parentAgentId: null, cwd: '/tmp', title: null },
  turnId: 'turn-l1',
  outcome: { kind: 'completed' },
  timeline,
  ...over,
});
const sendItems = items => items.filter(item => item.type === 'tool_call' && item.name.includes('send_agent_prompt'));
const user = (text, messageId = 'm-user') => ({ type: 'user_message', text, messageId });
const asst = (text, messageId = 'm-asst') => ({ type: 'assistant_message', text, messageId });
const clone = value => structuredClone(value);

// ---------------------------------------------------------------------------
// Observed shapes — each family through the same interface
// ---------------------------------------------------------------------------

test('live claude Peer: brief, handback and the report send are verified; the send is accepted', () => {
  const turn = firstTurn(LIVE.claude.items);
  const got = capture(peerEvent('claude', turn), ROUTED);
  assert.equal(got.kind, 'peer');
  assert.equal(got.brief.state, 'verified');
  assert.equal(got.brief.shapeId, 'claude-message-v1');
  assert.equal(got.brief.value.text, 'Sanitized brief body (item 0).', 'launch binding metadata is not communication evidence');
  assert.equal(got.brief.value.messageId, turn[0].messageId);
  assert.equal(got.handback.state, 'verified');
  assert.equal(got.handback.value.text, turn.filter(item => item.type === 'assistant_message').at(-1).text,
    'the last assistant message, not earlier commentary');
  assert.equal(got.sends.length, 1);
  assert.deepEqual(got.sends[0].outcome, { state: 'accepted', shapeId: 'claude-mcp-send-v1' });
  assert.equal(got.sends[0].input.state, 'verified');
  assert.equal(got.sends[0].input.value.recipient, LEAD);
  assert.equal(got.sends[0].input.value.prompt, 'Sanitized prompt.');
  assert.deepEqual(got.sendCoverage, { state: 'verified' });
});

test('live claude follow-up turn: the latest user_message opens the slice', () => {
  const got = capture(peerEvent('claude', LIVE.claude.items), ROUTED);
  const second = LIVE.claude.items.findIndex((item, index) => index > 0 && item.type === 'user_message');
  assert.equal(got.brief.value.text, LIVE.claude.items[second].text);
  assert.equal(got.handback.value.text, LIVE.claude.items.at(-1).text);
  assert.equal(got.sends.length, 0, 'the first turn\'s send is not part of the follow-up slice');
});

test('live codex Peer: the existing verified shape is unchanged (regression anchor)', () => {
  const got = capture(peerEvent('codex', firstTurn(LIVE.codex.items)), ROUTED);
  assert.equal(got.brief.shapeId, 'codex-message-v1');
  assert.equal(got.brief.value.text, 'Sanitized brief body (item 0).', 'launch binding metadata is not communication evidence');
  assert.equal(got.handback.state, 'verified');
  assert.deepEqual(got.sends.map(send => [send.input.state, send.outcome.state]), [['verified', 'accepted']]);
  assert.equal(got.sends[0].outcome.shapeId, 'codex-mcp-send-v1');
});

test('live devin Peer: brief after the exact role-prefix strip, handback verified; send outcome unknown and bodiless', () => {
  const turn = firstTurn(LIVE.devin.items);
  const got = capture(peerEvent('devin', turn), ROUTED);
  assert.equal(got.brief.state, 'verified');
  assert.equal(got.brief.shapeId, 'devin-acp-message-v1');
  assert.equal(got.brief.value.text, 'Sanitized brief body (item 0).', 'both the role policy and launch metadata are stripped');
  assert.ok(!got.brief.value.text.includes(ROLE_PREFIX_TERMINAL));
  assert.equal(got.brief.value.messageId, null, 'Devin user messages carry no id');
  assert.equal(got.handback.state, 'verified');
  assert.equal(got.handback.value.text, turn.filter(item => item.type === 'assistant_message').at(-1).text);
  assert.equal(got.sends.length, 1);
  assert.equal(got.sends[0].input.state, 'verified');
  assert.equal(got.sends[0].input.value.recipient, LEAD);
  assert.equal(got.sends[0].input.value.prompt, '', 'no accepted outcome → no body leaves capture');
  assert.deepEqual(got.sends[0].outcome, { state: 'unknown', reason: 'send-result-unobservable' });
  assert.deepEqual(got.sendCoverage, { state: 'unverified', reason: 'send-coverage-unverified' });
});

test('live Devin i4 compact launch envelope: brief and handback are verified', () => {
  const turn = firstTurn(LIVE.devinLaunch.items);
  const got = capture(peerEvent('devin', turn), ROUTED);
  assert.equal(got.brief.state, 'verified');
  assert.equal(got.brief.shapeId, 'devin-acp-message-v1');
  assert.equal(got.brief.value.text, 'Sanitized brief body.');
  assert.equal(got.brief.value.messageId, 'sanitized-message-i4-01');
  assert.equal(got.handback.state, 'verified');
});

test('live devin follow-up: the anchor() prefix strips to the Lead message', () => {
  const items = LIVE.devin.items;
  const second = items.findIndex((item, index) => index > 0 && item.type === 'user_message');
  const third = items.findIndex((item, index) => index > second && item.type === 'user_message');
  const got = capture(peerEvent('devin', items.slice(0, third)), ROUTED);
  assert.equal(got.brief.state, 'verified');
  assert.equal(got.brief.value.text, `Sanitized follow-up message (item ${second}).`);
});

test('live devin Lead: sends are recognized with verified recipients but unknown outcomes', () => {
  const items = LIVE.devinLead.items;
  const sends = sendItems(items);
  assert.ok(sends.length >= 3);
  const got = capture(leadEvent('devin', items.slice(0, items.indexOf(sends[0]) + 1)), ROUTED);
  assert.equal(got.kind, 'lead');
  assert.deepEqual(got.sends.map(send => [send.input.state, send.outcome.state, send.input.value.prompt]), [['verified', 'unknown', '']]);
  assert.equal(got.sends[0].input.value.recipient, PEER);
  assert.deepEqual(got.sendCoverage, { state: 'unverified', reason: 'send-coverage-unverified' });
});

test('send coverage by provider comes from the same registry; null or foreign providers are unverified', () => {
  assert.deepEqual(sendCoverageOf('slp-codex-lead'), { state: 'verified' });
  assert.deepEqual(sendCoverageOf('slp-claude-lead'), { state: 'verified' });
  assert.deepEqual(sendCoverageOf('slp-devin-lead'), { state: 'unverified', reason: 'send-coverage-unverified' });
  assert.deepEqual(sendCoverageOf('slp-pi-lead'), { state: 'verified' }, 'pi send shape observed (Lead-role live run not done)');
  assert.deepEqual(sendCoverageOf(null), { state: 'unverified', reason: 'lead-provider-unknown' });
  assert.deepEqual(sendCoverageOf('codex'), { state: 'unverified', reason: 'unsupported-family' });
});

// ---------------------------------------------------------------------------
// Devin role prefix — pinned against the real renderer
// ---------------------------------------------------------------------------

test('role prefix: the real roleDelivery entry() and anchor() strip to exactly the prompt', () => {
  const delivery = roleDelivery(REPO, 'peer', {});
  const prompt = 'SLP role=peer\n\nLaunch binding: {"provider":"slp-codex-peer","model":"gpt-6-luna"}\nAssignment:\nDo X.\n';
  for (const [name, prefix] of [['entry', delivery.entry({ explicitLanguageState: true })], ['anchor', delivery.anchor()]]) {
    assert.equal(stripAcpRolePrefix(prefix + prompt, 'peer'), 'Do X.', name);
    assert.equal(stripAcpRolePrefix(prefix, 'peer'), '', `${name}: prefix alone leaves an empty body`);
  }
  const lead = roleDelivery(REPO, 'lead', {});
  assert.equal(stripAcpRolePrefix(lead.entry({ explicitLanguageState: true }) + 'Go.', 'lead'), 'Go.');
});

test('Devin launch prompt: the non-stock provider envelope is verified from the real prompt builder', () => {
  const assignment = 'Read-only audit: compare TASK.md with src/ and test/.';
  const launchBinding = {
    provider: 'slp-devin-peer', model: 'swe-2-high', modeId: 'bypass',
    thinkingOptionId: 'high', features: { auto_accept: true },
  };
  const text = launchPrompt(REPO, 'peer', assignment, launchBinding);
  const got = capture(peerEvent('devin', [user(text), asst('Audit complete.')]), ROUTED);
  assert.equal(got.brief.state, 'verified');
  assert.equal(got.brief.shapeId, 'devin-acp-message-v1');
  assert.equal(got.brief.value.text, assignment);
  assert.equal(stripAcpRolePrefix(text.replace('Assignment:\n', 'Task:\n'), 'peer'), null, 'an unknown envelope label is not parsed');
  assert.equal(stripAcpRolePrefix(text.replace('"model":"swe-2-high"', '"model":7'), 'peer'), null, 'binding schema is validated');
  assert.equal(stripAcpRolePrefix(text.replace('"provider":"slp-devin-peer"', '"provider":"slp-codex-lead"'), 'peer'), null,
    'the launch binding must match the Peer role');
});

test('Devin launch role: a Lead envelope delivered to a Peer is unverified', () => {
  const text = launchPrompt(REPO, 'lead', 'Lead-only instructions.', {
    provider: 'slp-devin-lead', model: 'swe-2-high', modeId: 'bypass',
    thinkingOptionId: 'high', features: { auto_accept: true },
  });
  const got = capture(peerEvent('devin', [user(text), asst('Handback.')]), ROUTED);
  assert.deepEqual(got.brief, { state: 'unverified', reason: 'role-prefix-unrecognized' });
  assert.equal(got.handback.state, 'verified', 'role rejection applies only to the user-message mapping');

  const policy = roleDelivery(REPO, 'lead', {});
  const nested = capture(peerEvent('devin', [
    user(policy.entry({ explicitLanguageState: true }) + text), asst('Handback.'),
  ]), ROUTED);
  assert.deepEqual(nested.brief, { state: 'unverified', reason: 'role-prefix-unrecognized' },
    'the outer ACP role is checked against the recipient before a nested launch is stripped');

  // The remaining mismatch layouts, each through capture (Peer recipient):
  const peerPolicy = roleDelivery(REPO, 'peer', {});
  const peerLaunch = launchPrompt(REPO, 'peer', 'Peer assignment.', {
    provider: 'slp-devin-peer', model: 'swe-2-high', modeId: 'bypass',
    thinkingOptionId: 'high', features: { auto_accept: true },
  });
  const cases = {
    'Peer ACP bundle wrapping a Lead launch (nested role mismatch)': peerPolicy.entry({ explicitLanguageState: true }) + text,
    'Peer anchor wrapping a Lead launch': peerPolicy.anchor() + text,
    'Lead ACP bundle wrapping a Peer launch (outer role mismatch)': policy.entry({ explicitLanguageState: true }) + peerLaunch,
    'Lead anchor wrapping plain text': policy.anchor() + 'Lead-only instructions.',
  };
  for (const [name, message] of Object.entries(cases)) {
    const got = capture(peerEvent('devin', [user(message), asst('Handback.')]), ROUTED);
    assert.deepEqual(got.brief, { state: 'unverified', reason: 'role-prefix-unrecognized' }, name);
    assert.equal(stripAcpRolePrefix(message, 'peer', 'devin'), null, name);
  }
  // Control: the matching layouts still verify.
  assert.equal(stripAcpRolePrefix(peerPolicy.entry({ explicitLanguageState: true }) + peerLaunch, 'peer', 'devin'), 'Peer assignment.');
  assert.equal(stripAcpRolePrefix(policy.anchor() + 'Lead-only instructions.', 'lead', 'devin'), 'Lead-only instructions.');
  // Lead-side anchors use the Lead role: a Peer-role bundle never becomes a Lead anchor body.
  const leadCapture = capture(leadEvent('devin', [user(peerPolicy.anchor() + 'x'), devinSend()]), ROUTED);
  assert.equal(leadCapture.anchors[0].text, peerPolicy.anchor() + 'x', 'unverified mapping keeps raw text, which can never match an envelope');
});

test('SLP launch prompt envelope: only the assignment body is captured for each hook family (synthetic Pi)', () => {
  const assignment = 'Bounded assignment body.';
  for (const [family, model] of [['codex', 'gpt-6-luna'], ['claude', 'claude-sonnet-5'], ['pi', 'openai-codex/gpt-6-luna']]) {
    const text = launchPrompt(REPO, 'peer', assignment, { provider: `slp-${family}-peer`, model });
    const got = capture(peerEvent(family, [user(text), asst('Handback.')]), ROUTED);
    assert.equal(got.brief.state, 'verified', family);
    assert.equal(got.brief.value.text, assignment, `${family}: binding metadata is stripped`);
    const malformed = capture(peerEvent(family, [user(text.replace('Assignment:\n', 'Task:\n')), asst('Handback.')]), ROUTED);
    assert.equal(malformed.brief.state, 'unverified', `${family}: malformed wrapper fails closed`);
    const otherFamily = family === 'codex' ? 'claude' : 'codex';
    const misbound = capture(peerEvent(family, [user(text.replace(`slp-${family}-peer`, `slp-${otherFamily}-peer`)), asst('Handback.')]), ROUTED);
    assert.equal(misbound.brief.state, 'unverified', `${family}: binding for another family fails closed`);
  }
});

test('role prefix: anything but one exact prefix is unrecognized (synthetic)', () => {
  const delivery = roleDelivery(REPO, 'peer', {});
  const anchor = delivery.anchor();
  assert.equal(stripAcpRolePrefix('Plain text with no prefix', 'peer'), null);
  assert.equal(stripAcpRolePrefix(`SLP role=admin\n${ROLE_PREFIX_TERMINAL}x`, 'peer'), null, 'unknown role');
  assert.equal(stripAcpRolePrefix(anchor.replace(ROLE_PREFIX_TERMINAL, '') + 'x', 'peer'), null, 'no terminal line');
  assert.equal(stripAcpRolePrefix(`${anchor}first${anchor}second`, 'peer'), null, 'merged prompts are ambiguous');
  const entry = delivery.entry({ explicitLanguageState: true });
  const broken = entry.replace(/Policy locators — [^\n]*\n/, 'Policy locators missing\n');
  assert.equal(stripAcpRolePrefix(`${broken}x`, 'peer'), null, 'a carrier block in another format');
  // Through capture: a transport trace that is not one exact wrapper makes
  // the brief unverified, not missing (a message with NO trace is plain —
  // see the plain follow-up test).
  const got = capture(peerEvent('devin', [user(`Hello\n${anchor}`), asst('done')]), ROUTED);
  assert.deepEqual(got.brief, { state: 'unverified', reason: 'role-prefix-unrecognized' });
  assert.equal(got.handback.state, 'verified', 'the handback mapping is independent of the brief prefix');
});

test('devin plain follow-up (synthetic, r4 shape): a user_message with no transport trace is captured verbatim; any trace stays strict', () => {
  // r4 root verification (metadata only): a host-verified slp-devin-peer
  // timeline held an ordinary user_message with no SLP role/launch wrapper,
  // then the assistant reply. No r4 body is used here.
  const initial = firstTurn(LIVE.devin.items);
  const plain = 'Follow-up: please confirm the report covers src/price.js.';
  const timeline = [...initial, user(plain, 'm-follow'), asst('Confirmed.', 'm-reply')];
  const got = capture(peerEvent('devin', timeline), ROUTED);
  assert.deepEqual(got.brief, { state: 'verified', value: { text: plain, messageId: 'm-follow' }, shapeId: 'devin-plain-message-v1' });
  assert.deepEqual(got.handback, { state: 'verified', value: { text: 'Confirmed.', messageId: 'm-reply' }, shapeId: 'devin-acp-message-v1' });
  // The wrapped initial turn of the same live fixture still parses strictly.
  const first = capture(peerEvent('devin', initial), ROUTED);
  assert.equal(first.brief.shapeId, 'devin-acp-message-v1');
  assert.ok(first.brief.value.text.length > 0 && !first.brief.value.text.includes(ROLE_PREFIX_TERMINAL));
  // A plain message is never role-checked from its text: the same text is
  // plain for a Peer and a Lead actor alike.
  assert.equal(stripAcpRolePrefix(plain, 'peer'), null, 'the strict parser alone still rejects it');

  // Any transport trace keeps the strict path — wrong role, malformed,
  // merged, truncated or embedded wrappers stay unverified.
  const peerPolicy = roleDelivery(REPO, 'peer', {});
  const leadPolicy = roleDelivery(REPO, 'lead', {});
  const [terminalHead, terminalTail] = ROLE_PREFIX_TERMINAL.trim().split('. ');
  const traces = {
    'wrong-role anchor': leadPolicy.anchor() + plain,
    'wrong-role launch': launchPrompt(REPO, 'lead', plain, { provider: 'slp-devin-lead', model: 'swe-2-high' }),
    'merged: plain then anchor': `${plain}\n${peerPolicy.anchor()}second`,
    'merged: two anchors': `${peerPolicy.anchor()}one${peerPolicy.anchor()}two`,
    'role line mid-text': `${plain}\nSLP role=peer\nmore`,
    'terminal first half only': `${plain}\n${terminalHead}.`,
    'terminal second half only': `${plain}\n${terminalTail}`,
    'launch binding mid-text': `${plain}\nLaunch binding: {}`,
    'carrier head mid-text': `${plain}\nSpawn kit — role-scoped Paseo MCP signatures (x):`,
    'recovery line mid-text': `${plain}\nPolicy recovery command: node slp.mjs instructions peer`,
    'malformed carrier': peerPolicy.entry({ explicitLanguageState: true }).replace(/Policy locators — [^\n]*\n/, 'Policy locators missing\n') + plain,
  };
  for (const [name, message] of Object.entries(traces)) {
    const trace = capture(peerEvent('devin', [...initial, user(message), asst('reply')]), ROUTED);
    assert.deepEqual(trace.brief, { state: 'unverified', reason: 'role-prefix-unrecognized' }, name);
  }
  // Matching wrappers still verify after a plain turn existed earlier.
  const wrapped = capture(peerEvent('devin', [...timeline, user(peerPolicy.anchor() + 'Next step.'), asst('ok')]), ROUTED);
  assert.deepEqual([wrapped.brief.value.text, wrapped.brief.shapeId], ['Next step.', 'devin-acp-message-v1']);
});

test('devin transport markers: every fixed structural line of the renderers keeps the strict path, alone or mid-text', () => {
  // Each fixed text is pinned to its renderer source, so a wording change
  // there fails here instead of silently widening the plain path.
  const roleBundleSrc = readFileSync(new URL('../src/role-bundle.mjs', import.meta.url), 'utf8');
  const workTrackerSrc = readFileSync(new URL('../src/work-tracker.mjs', import.meta.url), 'utf8');
  const structures = [
    // [fixed text in the source, a rendered-looking fragment, source]
    ['Snapshot command: ', "Snapshot command: node '/r/bin/slp.mjs' snapshot <repository>", roleBundleSrc],
    ['For repo setup/update, use ', 'For repo setup/update, use /r/skills/paseo-slp-onboarding/SKILL.md.', roleBundleSrc],
    ['Managed runtime helpers (SLP_MANAGED_RUNTIME=1)', 'Managed runtime helpers (SLP_MANAGED_RUNTIME=1) — always this verified Node, stable runtime CLI and explicit daemon home:', roleBundleSrc],
    ['the request must carry "paseoHome": ', `  node x monitor <request.json> — the request must carry "paseoHome": "/h"`, roleBundleSrc],
    ["standalone installs only; the plugin owns this runtime's lifecycle", "  node x install <dir> --paseo-home '/h' — standalone installs only; the plugin owns this runtime's lifecycle", roleBundleSrc],
    ['upgrade/uninstall take no home flag', "  upgrade/uninstall take no home flag — the target installation's paseo-binding.json must record '/h'; verify it before running them", roleBundleSrc],
    ['init/materialize/snapshot/prepare/prepare-handoff/verify are repo-scoped', '  init/materialize/snapshot/prepare/prepare-handoff/verify are repo-scoped: they take explicit paths and never touch a daemon home.', roleBundleSrc],
    ['Communication language: ', 'Communication language: vi — all text you send to other seats uses it', roleBundleSrc],
    ['Communication language: not set', 'Communication language: not set — this replaces earlier runtime language settings', roleBundleSrc],
    ['Work tracker: setting unreadable', 'Work tracker: setting unreadable — bad json; continuing without the tracker, record this gap.', workTrackerSrc],
    ['Work tracker: beads (enabled in SLP settings)', 'Work tracker: beads (enabled in SLP settings) — read /r/src/references/work-tracking.md before tracked work', workTrackerSrc],
  ];
  const plain = 'Follow-up: please confirm the report covers src/price.js.';
  const initial = firstTurn(LIVE.devin.items);
  for (const [fixed, fragment, source] of structures) {
    assert.ok(source.includes(fixed), `renderer still emits: ${fixed}`);
    for (const [where, message] of [['alone', fragment], ['mid-text', `${plain}\n${fragment}\nmore text`], ['inline', `${plain} ${fragment}`]]) {
      const got = capture(peerEvent('devin', [...initial, user(message), asst('reply')]), ROUTED);
      assert.deepEqual(got.brief, { state: 'unverified', reason: 'role-prefix-unrecognized' }, `${fixed} (${where})`);
    }
  }
  // The plain path is unchanged for a message with none of them.
  const clean = capture(peerEvent('devin', [...initial, user(plain), asst('reply')]), ROUTED);
  assert.deepEqual([clean.brief.state, clean.brief.shapeId], ['verified', 'devin-plain-message-v1']);
  // A real unmanaged entry() render carries the snapshot and onboarding lines
  // (language/helper/tracker lines are managed-only) and still strips.
  const lead = roleDelivery(REPO, 'lead', {});
  const entry = lead.entry({ explicitLanguageState: true });
  for (const fixed of ['Snapshot command: ', 'For repo setup/update, use ']) assert.ok(entry.includes(fixed), fixed);
  assert.equal(stripAcpRolePrefix(entry + 'Go.', 'lead', 'devin'), 'Go.');
});

test('devin Lead anchors: a plain finish notification anchors; a wrong-role wrapper keeps raw text', () => {
  const HB = 'Done — X implemented, tests pass';
  const envelope = `<paseo-system>\nAgent ${PEER} (peer title) finished.\n\n<agent-response>\n${HB}\n</agent-response>\n</paseo-system>`;
  const send = devinSend(); send.detail.input.agentId = PEER;
  const plain = capture(leadEvent('devin', [user(envelope), send]), ROUTED);
  assert.equal(handbackAnchorIndex(plain.anchors, PEER, HB), 0, 'a plain host notification is read verbatim');
  const wrongRole = roleDelivery(REPO, 'peer', {}).anchor() + envelope;
  const wrapped = capture(leadEvent('devin', [user(wrongRole), send]), ROUTED);
  assert.equal(wrapped.anchors[0].text, wrongRole, 'unverified mapping keeps raw text');
  assert.equal(handbackAnchorIndex(wrapped.anchors, PEER, HB), -1);
});

// ---------------------------------------------------------------------------
// Send outcomes — one mutated part of an observed envelope at a time
// ---------------------------------------------------------------------------

const claudeSend = () => clone(sendItems(firstTurn(LIVE.claude.items))[0]);
const codexSend = () => clone(sendItems(firstTurn(LIVE.codex.items))[0]);
const devinSend = () => clone(sendItems(firstTurn(LIVE.devin.items))[0]);
const leadSends = (family, items) => capture(leadEvent(family, [user('w'), ...items]), ROUTED)?.sends ?? [];
const outcomeOf = (family, item) => leadSends(family, [item])[0]?.outcome;

test('claude outcomes (synthetic mutations): explicit false/failed reject; missing, non-JSON or canceled stay unknown; contradictions unknown', () => {
  const falsy = claudeSend(); falsy.detail.output.output.success = false;
  assert.deepEqual(outcomeOf('claude', falsy), { state: 'rejected', reason: 'send-result-unsuccessful' });
  const failed = claudeSend(); Object.assign(failed, { status: 'failed', error: { message: 'Permission denied' } }); failed.detail.output = null;
  assert.deepEqual(outcomeOf('claude', failed), { state: 'rejected', reason: 'send-result-unsuccessful' });
  const canceled = claudeSend(); canceled.status = 'canceled'; canceled.detail.output = null;
  assert.deepEqual(outcomeOf('claude', canceled), { state: 'unknown', reason: 'send-not-completed' }, 'canceled never proves non-delivery');
  const missing = claudeSend(); missing.detail.output = null;
  assert.deepEqual(outcomeOf('claude', missing), { state: 'unknown', reason: 'send-result-unobservable' });
  const text = claudeSend(); text.detail.output = { output: 'sent!' };
  assert.deepEqual(outcomeOf('claude', text), { state: 'unknown', reason: 'send-result-unobservable' }, 'prose is never a receipt');
  const flat = claudeSend(); flat.detail.output = { success: true };
  assert.deepEqual(outcomeOf('claude', flat), { state: 'unknown', reason: 'send-result-unobservable' }, 'only the observed nesting is decoded');
  const both = claudeSend(); both.error = { message: 'boom' };
  assert.deepEqual(outcomeOf('claude', both), { state: 'unknown', reason: 'send-result-contradictory' });
  const failedWithSuccess = claudeSend(); failedWithSuccess.status = 'failed'; failedWithSuccess.error = { message: 'x' };
  assert.deepEqual(outcomeOf('claude', failedWithSuccess), { state: 'unknown', reason: 'send-result-contradictory' });
});

test('codex outcomes (synthetic mutations): isError/false reject, isError+success contradicts, string output not decoded', () => {
  const falsy = codexSend(); falsy.detail.output.structuredContent.success = false;
  assert.deepEqual(outcomeOf('codex', falsy), { state: 'rejected', reason: 'send-result-unsuccessful' });
  const error = codexSend(); error.detail.output.isError = true; error.detail.output.structuredContent.success = false;
  assert.equal(outcomeOf('codex', error).state, 'rejected');
  const contradiction = codexSend(); contradiction.detail.output.isError = true;
  assert.deepEqual(outcomeOf('codex', contradiction), { state: 'unknown', reason: 'send-result-contradictory' });
  const nested = codexSend(); nested.detail.output = JSON.stringify(nested.detail.output);
  assert.deepEqual(outcomeOf('codex', nested), { state: 'unknown', reason: 'send-result-unobservable' }, 'no recursive decoding of strings');
  const failed = codexSend(); Object.assign(failed, { status: 'failed', error: { message: 'Tool call failed' } }); failed.detail.output = null;
  assert.equal(outcomeOf('codex', failed).state, 'rejected');
  const running = codexSend(); running.status = 'running';
  assert.deepEqual(outcomeOf('codex', running), { state: 'unknown', reason: 'send-not-completed' });
});

test('codex input (synthetic): alias and JSON-string input stay unverified; malformed input is unparsed; bodies never leak', () => {
  const alias = codexSend(); alias.name = 'mcp__paseo__send_agent_prompt';
  const [aliased] = leadSends('codex', [alias]);
  assert.deepEqual(aliased.input, { state: 'unverified', reason: 'send-shape-unverified' });
  assert.equal(aliased.outcome.state, 'accepted', 'the outcome is still decoded — but no usable send without a verified input');
  const string = codexSend(); string.detail.input = JSON.stringify(string.detail.input);
  assert.deepEqual(leadSends('codex', [string])[0].input, { state: 'unverified', reason: 'send-shape-unverified' });
  const malformed = codexSend(); malformed.detail.input = { agentId: '', prompt: 'x' };
  assert.deepEqual(leadSends('codex', [malformed])[0].input, { state: 'unverified', reason: 'send-input-unparsed' });
  const rejected = codexSend(); rejected.detail.output.structuredContent.success = false;
  const [kept] = leadSends('codex', [rejected]);
  assert.equal(kept.input.value.prompt, '', 'a rejected send keeps its recipient, never its body');
  assert.equal(kept.input.value.recipient, LEAD);
});

test('devin (synthetic): only the observed title is a send; a plain_text detail is an unverified shape', () => {
  const variant = devinSend(); variant.name = 'Calling send_agent_prompt from paseo-mcp';
  assert.equal(leadSends('devin', [variant]).length, 0, 'an unknown title is never guessed into a send');
  const seen = capture(leadEvent('devin', [user('w'), variant]), ROUTED);
  assert.deepEqual(seen.sendCoverage, { state: 'unverified', reason: 'send-shape-unverified' },
    'the turn-level fact stays visible even for a family whose coverage is already unverified');
  const plain = devinSend(); plain.detail = { type: 'plain_text', text: '{"success":true}' };
  const [decoded] = leadSends('devin', [plain]);
  assert.deepEqual(decoded.input, { state: 'unverified', reason: 'send-shape-unverified' });
  assert.equal(decoded.outcome.state, 'unknown', 'plain_text is not decoded into a receipt');
  const canceled = devinSend(); canceled.status = 'canceled';
  assert.deepEqual(leadSends('devin', [canceled])[0].outcome, { state: 'unknown', reason: 'send-not-completed' });
});

test('coverage (synthetic): an unrecognized send-shaped call makes the turn unverified; shell commands are never sends', () => {
  const unknownAlias = codexSend(); unknownAlias.name = 'paseo.send_agent_prompt_v2';
  const got = capture(leadEvent('codex', [user('w'), unknownAlias]), ROUTED);
  assert.deepEqual(got.sends, []);
  assert.deepEqual(got.sendCoverage, { state: 'unverified', reason: 'send-shape-unverified' });
  const shell = { type: 'tool_call', callId: 's1', name: 'Bash', status: 'completed', error: null,
    detail: { type: 'shell', command: 'paseo send_agent_prompt --to x', output: 'ok' } };
  assert.equal(capture(leadEvent('claude', [user('w'), shell]), ROUTED), null, 'a shell call is not a send and adds nothing');
});

test('live pi Peer: brief, handback and the proxied report send are verified; discovery calls are not sends', () => {
  const turn = firstTurn(LIVE.pi.items);
  const got = capture(peerEvent('pi', turn), ROUTED);
  assert.equal(got.brief.state, 'verified');
  assert.equal(got.brief.shapeId, 'pi-message-v1');
  assert.equal(got.brief.value.text, turn[0].text);
  assert.equal(got.brief.value.messageId, turn[0].messageId);
  assert.equal(got.handback.state, 'verified');
  assert.equal(got.handback.value.text, turn.filter(item => item.type === 'assistant_message').at(-1).text);
  // The `mcp` search/list/connect/describe calls precede the send; only the
  // proxied mcp__paseo call is one.
  assert.equal(turn.filter(item => item.type === 'tool_call' && item.name === 'mcp').length, 4);
  assert.equal(got.sends.length, 1);
  assert.deepEqual(got.sends[0].input, { state: 'verified', value: { recipient: LEAD, prompt: 'Sanitized prompt.' }, shapeId: 'pi-mcp-send-input-v1' });
  assert.deepEqual(got.sends[0].outcome, { state: 'accepted', shapeId: 'pi-mcp-send-v1' });
  assert.deepEqual(got.sendCoverage, { state: 'verified' }, 'a discovery call naming the tool is not a suspect send');
});

test('live pi follow-up turn: the latest user_message opens the slice', () => {
  const got = capture(peerEvent('pi', LIVE.pi.items), ROUTED);
  const second = LIVE.pi.items.findIndex((item, index) => index > 0 && item.type === 'user_message');
  assert.equal(got.brief.value.text, LIVE.pi.items[second].text);
  assert.equal(got.handback.value.text, LIVE.pi.items.at(-1).text);
  assert.equal(got.sends.length, 0);
});

const piSend = () => clone(firstTurn(LIVE.pi.items).find(item => item.name === 'mcp__paseo'));
test('pi outcomes (synthetic mutations): explicit false/isError reject, contradictions unknown, text copies never parsed', () => {
  const falsy = piSend(); falsy.detail.output.details.mcpResult.structuredContent.success = false;
  assert.deepEqual(outcomeOf('pi', falsy), { state: 'rejected', reason: 'send-result-unsuccessful' });
  const isError = piSend(); isError.detail.output.details.mcpResult.isError = true; isError.detail.output.details.mcpResult.structuredContent.success = false;
  assert.equal(outcomeOf('pi', isError).state, 'rejected');
  const contradiction = piSend(); contradiction.detail.output.details.mcpResult.isError = true;
  assert.deepEqual(outcomeOf('pi', contradiction), { state: 'unknown', reason: 'send-result-contradictory' });
  const textOnly = piSend(); delete textOnly.detail.output.details.mcpResult.structuredContent;
  assert.deepEqual(outcomeOf('pi', textOnly), { state: 'unknown', reason: 'send-result-unobservable' }, 'the JSON text copy is never decoded');
  const wrongTool = piSend(); wrongTool.detail.output.details.tool = 'list_agents';
  assert.deepEqual(outcomeOf('pi', wrongTool), { state: 'unknown', reason: 'send-result-unobservable' }, 'a result of another tool is not this call\'s receipt');
  const notCall = piSend(); notCall.detail.output.details.mode = 'describe';
  assert.equal(outcomeOf('pi', notCall).state, 'unknown');
  const canceled = piSend(); canceled.status = 'canceled'; canceled.detail.output = null;
  assert.deepEqual(outcomeOf('pi', canceled), { state: 'unknown', reason: 'send-not-completed' });
  const failed = piSend(); Object.assign(failed, { status: 'failed', error: { content: [{ type: 'text', text: 'Sanitized error.' }] } }); failed.detail.output = null;
  assert.deepEqual(outcomeOf('pi', failed), { state: 'rejected', reason: 'send-result-unsuccessful' });
  const both = piSend(); both.error = { content: [] };
  assert.deepEqual(outcomeOf('pi', both), { state: 'unknown', reason: 'send-result-contradictory' });
});

test('pi input (synthetic): only the observed proxy + object args is verified; mapper-derived forms stay unverified and bodiless', () => {
  const stringArgs = piSend(); stringArgs.detail.input.args = JSON.stringify(stringArgs.detail.input.args);
  const [a] = leadSends('pi', [stringArgs]);
  assert.deepEqual(a.input, { state: 'unverified', reason: 'send-shape-unverified' });
  const bare = piSend(); bare.name = 'mcp';
  const [b] = leadSends('pi', [bare]);
  assert.deepEqual([b.input.state, b.outcome.state], ['unverified', 'unknown']);
  const named = piSend(); named.name = 'paseo.send_agent_prompt';
  assert.deepEqual(leadSends('pi', [named])[0].input, { state: 'unverified', reason: 'send-shape-unverified' });
  const malformed = piSend(); malformed.detail.input.args = { agentId: 7 };
  assert.deepEqual(leadSends('pi', [malformed])[0].input, { state: 'unverified', reason: 'send-input-unparsed' });
  const rejected = piSend(); rejected.detail.output.details.mcpResult.structuredContent.success = false;
  assert.equal(leadSends('pi', [rejected])[0].input.value.prompt, '', 'a rejected pi send keeps its recipient, never its body');
  for (const item of [stringArgs, bare, named]) {
    assert.ok(!JSON.stringify(leadSends('pi', [item])).includes('Sanitized prompt.'), 'no unverified body leaves capture');
  }
});

test('pi coverage (synthetic): a proxied tool name that looks like a send but is not the observed one is a suspect', () => {
  const variant = piSend(); variant.detail.input.tool = 'paseo_send_agent_prompt_v2';
  const got = capture(leadEvent('pi', [user('w'), variant]), ROUTED);
  assert.deepEqual(got.sends, []);
  assert.deepEqual(got.sendCoverage, { state: 'unverified', reason: 'send-shape-unverified' });
  const describe = firstTurn(LIVE.pi.items).find(item => item.name === 'mcp' && item.detail.input.describe);
  assert.equal(capture(leadEvent('pi', [user('w'), clone(describe)]), ROUTED), null, 'describing the tool is not sending');
});

test('pi proxy fail-closed (synthetic): an mcp__paseo call whose target cannot be read makes coverage unverified — never a send, never a body', () => {
  const BODY = 'HIDDEN-PROXY-BODY';
  const base = () => { const item = piSend(); item.detail.input.args.prompt = BODY; return item; };
  const stringInput = base(); stringInput.detail.input = JSON.stringify(stringInput.detail.input);
  const arrayInput = base(); arrayInput.detail.input = [stringInput.detail.input];
  const nullInput = base(); nullInput.detail.input = null;
  const noTool = base(); delete noTool.detail.input.tool;
  const numericTool = base(); numericTool.detail.input.tool = 7;
  const plainText = base(); plainText.detail = { type: 'plain_text', text: JSON.stringify({ tool: 'paseo_send_agent_prompt', args: { agentId: LEAD, prompt: BODY } }) };
  const shell = base(); shell.detail = { type: 'shell', command: 'x', output: BODY };
  for (const [name, item] of Object.entries({ stringInput, arrayInput, nullInput, noTool, numericTool, plainText, shell })) {
    for (const event of [leadEvent('pi', [user('w'), item]), peerEvent('pi', [user('brief'), item, asst('done')])]) {
      const got = capture(event, ROUTED);
      assert.ok(got, `${name}: the unreadable proxy call is recorded`);
      assert.deepEqual(got.sends, [], `${name}: never classified as a send`);
      assert.deepEqual(got.sendCoverage, { state: 'unverified', reason: 'send-shape-unverified' }, name);
      assert.ok(!JSON.stringify(got.sends).includes(BODY), `${name}: no body retained`);
    }
  }
  // Brief/handback of the Peer turn are untouched by the coverage gap.
  const peer = capture(peerEvent('pi', [user('brief'), stringInput, asst('done')]), ROUTED);
  assert.deepEqual([peer.brief.state, peer.handback.state], ['verified', 'verified']);
  // A readable proxied call to another tool is not a suspect.
  const other = base(); other.detail.input = { tool: 'paseo_list_agents', args: {} };
  assert.equal(capture(leadEvent('pi', [user('w'), other]), ROUTED), null);
});

test('pi bare mcp proxy (synthetic): observed discovery inputs stay exempt; an unreadable or unknown target is a suspect', () => {
  const discovery = firstTurn(LIVE.pi.items).filter(item => item.name === 'mcp');
  assert.equal(discovery.length, 4);
  assert.deepEqual(capture(peerEvent('pi', firstTurn(LIVE.pi.items)), ROUTED).sendCoverage, { state: 'verified' },
    'search/list/connect/describe as observed never downgrade coverage');
  for (const item of discovery) assert.equal(capture(leadEvent('pi', [user('w'), clone(item)]), ROUTED), null);
  const mutate = change => { const item = clone(discovery[0]); change(item); return item; };
  const cases = {
    stringInput: mutate(item => { item.detail.input = 'paseo_send_agent_prompt {...}'; }),
    unknownKey: mutate(item => { item.detail.input = { call: 'paseo_send_agent_prompt', args: {} }; }),
    emptyInput: mutate(item => { item.detail.input = {}; }),
    nonUnknownDetail: mutate(item => { item.detail = { type: 'plain_text', text: 'x' }; }),
  };
  for (const [name, item] of Object.entries(cases)) {
    const got = capture(leadEvent('pi', [user('w'), item]), ROUTED);
    assert.deepEqual(got.sends, [], name);
    assert.deepEqual(got.sendCoverage, { state: 'unverified', reason: 'send-shape-unverified' }, name);
  }
  // The observed send path is unchanged.
  const observed = capture(peerEvent('pi', firstTurn(LIVE.pi.items)), ROUTED);
  assert.deepEqual(observed.sends.map(send => [send.input.state, send.outcome.state]), [['verified', 'accepted']]);
});

// ---------------------------------------------------------------------------
// Turn slice, missing vs unverified, whole-turn issues
// ---------------------------------------------------------------------------

test('missing only where the region is known; an unknown turn boundary is unverified', () => {
  const noUser = capture(peerEvent('codex', [asst('done')]), ROUTED);
  assert.deepEqual(noUser.brief, { state: 'unverified', reason: 'turn-boundary-unverified' });
  assert.deepEqual(noUser.handback, { state: 'unverified', reason: 'turn-boundary-unverified' });
  const briefOnly = capture(peerEvent('claude', [user('brief only')]), ROUTED);
  assert.equal(briefOnly.brief.state, 'verified');
  assert.deepEqual(briefOnly.handback, { state: 'missing', reason: 'handback-missing' });
  assert.ok(!briefOnly.issues.includes('no-observable-communication'), 'a brief is observable communication');
  const empty = capture(peerEvent('codex', [user('   '), asst('done')]), ROUTED);
  assert.deepEqual(empty.brief, { state: 'missing', reason: 'brief-missing' });
  const silent = capture(peerEvent('codex', [user(''), { type: 'tool_call', callId: 'c9', name: 'unrelated.tool', status: 'completed', error: null, detail: { type: 'unknown', input: {}, output: {} } }]), ROUTED);
  assert.ok(silent.issues.includes('no-observable-communication'), 'silence is still a metadata-only case');
  const pointer = capture(peerEvent('claude', [user('Read the assignment file at .local-checks/x.md'), asst('ok')]), ROUTED);
  assert.ok(pointer.issues.includes('brief-references-assignment-file'));
  assert.ok(pointer.issues.includes('report-route-unverifiable'));
});

test('a failed Peer turn keeps only accepted sends and reads no brief/handback', () => {
  const turn = firstTurn(LIVE.claude.items);
  const failed = capture(peerEvent('claude', turn, { outcome: { kind: 'failed', error: { message: 'x' } } }), ROUTED);
  assert.deepEqual(failed.brief, { state: 'unverified', reason: 'peer-turn-not-completed' });
  assert.equal(failed.sends.length, 1);
  assert.ok(failed.issues.includes('peer-turn-not-completed'));
  assert.equal(capture(peerEvent('devin', firstTurn(LIVE.devin.items), { outcome: { kind: 'canceled', reason: 'x' } }), ROUTED), null,
    'without an accepted send a failed turn contributes nothing');
});

test('a canceled Lead turn with no send contributes nothing; a failed send still records', () => {
  const canceled = { kind: 'canceled', reason: 'interrupted' };
  assert.equal(capture(leadEvent('codex', [user('w'), asst('thinking…')], { outcome: canceled }), ROUTED), null);
  const failedSend = codexSend(); Object.assign(failedSend, { status: 'failed', error: { message: 'send failed' } }); failedSend.detail.output = null;
  const kept = capture(leadEvent('codex', [user('w'), failedSend], { outcome: canceled }), ROUTED);
  assert.deepEqual(kept.issues, ['lead-turn-not-completed']);
  assert.equal(kept.sends[0].outcome.state, 'rejected');
});

test('capture is deterministic and never throws on malformed items', () => {
  const weird = [user('b'), { type: 'tool_call', callId: 'x', name: 'mcp__paseo__send_agent_prompt', status: 'completed', error: null, detail: { type: 'unknown', input: null, output: undefined } }, asst('d')];
  const a = capture(peerEvent('claude', weird), ROUTED);
  const b = capture(peerEvent('claude', clone(weird)), ROUTED);
  assert.deepEqual(a, b);
  assert.deepEqual(a.sends[0].input, { state: 'unverified', reason: 'send-input-unparsed' });
  assert.equal(capture(peerEvent('claude', weird, { agent: { id: PEER, provider: 'slp-claude-peer', parentAgentId: OTHER } }), ROUTED), null,
    'a Peer of an unrouted Lead is not captured');
});

// ---------------------------------------------------------------------------
// End-only chronology anchor
// ---------------------------------------------------------------------------

const HANDBACK = 'Done — X implemented, tests pass';
const finishEnvelope = (peerId, responseBody, reason = 'finished') =>
  `<paseo-system>\nAgent ${peerId} (peer title) ${reason}.\n\n<agent-response>\n${responseBody}\n</agent-response>\n</paseo-system>`;

test('handbackAnchorIndex — only the finish envelope anchors; everything else stays unproven', () => {
  const anchors = texts => texts.map((text, index) => ({ index, text }));
  const env = finishEnvelope(PEER, HANDBACK);
  assert.equal(handbackAnchorIndex(anchors(['earlier input', env, 'x']), PEER, HANDBACK), 1);
  assert.equal(handbackAnchorIndex(anchors(['REPORT: X done']), PEER, null), -1, 'a bare report body is not authenticated delivery');
  assert.equal(handbackAnchorIndex(anchors([env]), OTHER, HANDBACK), -1, 'another agent\'s notification');
  const foreignEnv = `<paseo-system>\nAgent ${OTHER} (relay for Agent ${PEER} (x)) finished.\n\n<agent-response>\n${HANDBACK}\n</agent-response>\n</paseo-system>`;
  assert.equal(handbackAnchorIndex(anchors([foreignEnv]), PEER, HANDBACK), -1, 'peer id inside a foreign status line is not identity');
  assert.equal(handbackAnchorIndex(anchors([finishEnvelope(PEER, 'a different body')]), PEER, HANDBACK), -1, 'mismatched handback body');
  assert.equal(handbackAnchorIndex(anchors(['Agent x finished']), PEER, HANDBACK), -1, 'not an envelope');
  assert.equal(handbackAnchorIndex(anchors(['']), PEER, null), -1, 'scrubbed bodies never match');
  assert.equal(handbackAnchorIndex(
    anchors([`<paseo-system>\nAgent ${PEER} (t) finished.\n\n<agent-response>\n\n</agent-response>\n</paseo-system>`]),
    PEER, ''), -1, 'an empty handback cannot verify content');
  const long = 'x'.repeat(4100);
  const truncatedEnv = finishEnvelope(PEER, `${'x'.repeat(4000)}\n[truncated 100 chars; use get_agent_activity for the full response]`);
  assert.equal(handbackAnchorIndex(anchors([truncatedEnv]), PEER, long), 0);
});

test('a Devin Lead anchor is read after the role prefix, so its finish envelope can anchor', () => {
  const anchor = roleDelivery(REPO, 'lead', {}).anchor();
  const send = devinSend(); send.detail.input.agentId = PEER;
  const got = capture(leadEvent('devin', [user(anchor + finishEnvelope(PEER, HANDBACK)), send]), ROUTED);
  assert.equal(handbackAnchorIndex(got.anchors, PEER, HANDBACK), 0);
});
