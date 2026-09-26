// tests/plugin-supervision-observer.test.mjs — communication supervision
// observer: provider-aware capture (per-family fixtures), rubric-2 question
// building and strict parsing, per-axis gates and independent findings, the
// serialized queue, archive generations, monotonic chronology, packet-basis
// invalidation, the spec scenarios, the bounded metadata ring, and notify
// delivery. The Jev transport and the Paseo SDK are injected seams — no
// network, no daemon, isolated homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSupervisionObserver, buildEvidencePayload, linkCandidates } from '../plugin/server/supervision/observer.ts';
import {
  axisGates, buildQuestions, judge, localGate, parseAssessmentResponse, SUPERVISION_QUESTIONS,
} from '../plugin/server/supervision/assessment.ts';
import { resolveSupervision, askJevDecision, assertRedacted, JevRequestError } from '../plugin/server/jev.ts';
import { makeHome } from './helpers/plugin-doubles.mjs';
import { roleDelivery } from '../src/role-bundle.mjs';

const LEAD = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const PEER2 = '55555555-5555-4555-8555-555555555555';
const SUP = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const OTHER_LEAD = '66666666-6666-4666-8666-666666666666';
const WKS = 'wks_testworkspace';

const PROVIDER = { kind: 'openrouter', baseUrl: 'https://openrouter.ai', model: 'typesafe/jev-1.13' };
const GATE_OK = { ok: true, provider: PROVIDER, authorization: 'Bearer test-key' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Schema-2 store. `routes` are explicit Lead routes; `defaults` applies to
// discovered SLP Leads (off unless a test opts in).
const writeConfig = (home, { routes = [], defaults = {}, confidenceThreshold = 0.9 } = {}) => {
  const dir = join(home, 'slp-runtime', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'supervision.json'), JSON.stringify({
    schemaVersion: 3,
    confidenceThreshold,
    defaults: { mode: 'off', supervisorAgentId: null, supervisorWorkspaceId: null, pendingDelayMs: 60000, ...defaults },
    routes,
  }, null, 2) + '\n', { mode: 0o600 });
};
const writeRoutes = (home, routes) => writeConfig(home, { routes });
// Default delay 80ms: the checkpoint for brief/handback delivery; the
// assessment itself runs as soon as the handback lands.
const route = (over = {}) => ({
  leadAgentId: LEAD, leadWorkspaceId: WKS, supervisorAgentId: SUP, mode: 'shadow', pendingDelayMs: 80, ...over,
});

const agent = (id, provider, over = {}) => ({
  id, provider, workspaceId: WKS, parentAgentId: null, cwd: '/tmp', title: null, ...over,
});
const leadHook = (over = {}) => agent(LEAD, 'slp-codex-lead', over);
const peerHook = (id = PEER, over = {}) => agent(id, 'slp-codex-peer', { parentAgentId: LEAD, ...over });

// Snapshot double for ref.refresh() — labels carry parentage on refresh.
const snap = (id, provider, over = {}) => ({
  id, provider, workspaceId: WKS, status: 'idle', archivedAt: null, labels: {}, ...over,
});
// SDK double: refresh from `agents`, send recorded (or failed via sendImpl).
const makePaseo = (agents, { sendImpl } = {}) => {
  const refreshed = [];
  const sent = [];
  const paseo = {
    refreshed,
    sent,
    agents: {
      ref(id) {
        return {
          refresh: async () => { refreshed.push(id); return { agent: agents[id] ?? null }; },
          send: async (text, options) => {
            sent.push({ id, text, options });
            if (sendImpl) await sendImpl(id, text, options);
          },
        };
      },
    },
  };
  return paseo;
};

const userMsg = (text, messageId = 'm-user') => ({ type: 'user_message', text, messageId });
const asstMsg = (text, messageId = 'm-asst') => ({ type: 'assistant_message', text, messageId });
const codexSend = (callId, recipient, prompt, over = {}) => ({
  type: 'tool_call', callId, name: 'paseo.send_agent_prompt', status: 'completed', error: null,
  detail: { type: 'unknown', input: { agentId: recipient, prompt }, output: { isError: false, structuredContent: { success: true } } },
  ...over,
});
// Devin-family send — the probe records every parsed call UNCONFIRMED
// (transport success only), so it lands in the uncertain lane.
const devinSend = (callId, recipient, prompt) => ({
  type: 'tool_call', callId, name: 'Calling send_agent_prompt from paseo', status: 'completed', error: null,
  detail: { type: 'unknown', input: { agentId: recipient, prompt }, output: null },
});

const peerEnd = (timeline, over = {}) => ({
  agent: peerHook(over.peerId ?? PEER, over.agent ?? {}),
  turnId: over.turnId ?? 'turn-p1',
  outcome: over.outcome ?? { kind: 'completed' },
  timeline,
});
const leadEnd = (timeline, over = {}) => ({
  agent: leadHook(over.agent ?? {}),
  turnId: over.turnId ?? 'turn-l1',
  outcome: over.outcome ?? { kind: 'completed' },
  timeline,
});
const leadStart = (turnId, over = {}) => ({ agent: leadHook(over.agent ?? {}), turnId });
// The host's notify-on-finish envelope (agent-prompt.js
// formatSystemNotificationPrompt + formatFinishNotificationBody): the status
// line names the child agent id and the agent-response section embeds the
// child's last assistant message verbatim (truncated at 4000 chars).
const finishEnvelope = (peerId, responseBody, reason = 'finished') =>
  `<paseo-system>\nAgent ${peerId} (peer title) ${reason}.\n\n<agent-response>\n${responseBody}\n</agent-response>\n</paseo-system>`;
const HANDBACK = 'Done — X implemented, tests pass';

// --- Jev doubles --------------------------------------------------------------

/** A valid strict answer over a question's declared choices: unique-max
 *  probabilities summing to 1. An undeclared value answers unknown. */
const answerOver = (question, value, confidence = 0.95) => {
  const keys = Object.keys(question.criteria);
  const choice = keys.includes(value) ? value : 'unknown';
  const probabilities = Object.fromEntries(keys.map(k => [k, k === choice ? 0.9 : 0.1 / (keys.length - 1)]));
  return { type: 'choice', choice, confidence, probabilities };
};
/** The newest candidate key (link questions list m1..mN, then none/unknown). */
const LAST = request => {
  const keys = Object.keys(Object.values(request.questions).find(q => 'none' in q.criteria)?.criteria ?? {})
    .filter(k => k !== 'none' && k !== 'unknown');
  return keys[keys.length - 1] ?? 'none';
};
/** A spec answers only the ASKED questions: id → choice (or fn(request)).
 *  `confidence` optionally overrides per id. */
const respond = (request, spec, model = PROVIDER.model) => ({
  model,
  answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const value = typeof spec[id] === 'function' ? spec[id](request) : spec[id];
    return [id, answerOver(question, value, spec.confidence?.[id] ?? 0.95)];
  })),
  usage: { input_tokens: 10, output_tokens: 5 },
});
const makeAsk = (specs = [HANDLED]) => {
  const calls = [];
  let i = 0;
  const ask = async (provider, auth, request) => {
    calls.push(request);
    const spec = specs[Math.min(i++, specs.length - 1)];
    if (spec instanceof Error) throw spec;
    const raw = respond(request, spec);
    return { model: raw.model, answers: raw.answers, usage: raw.usage, raw };
  };
  return { ask, calls };
};
// Named answer specs. dispositionMessage/corrections pick the newest
// candidate by default.
const HANDLED = { leadBrief: 'satisfied', peerHandback: 'satisfied', leadHandling: 'handled', dispositionMessage: LAST };
const PENDING = { leadBrief: 'satisfied', peerHandback: 'satisfied', leadHandling: 'pending' };
const MISHANDLED = { leadBrief: 'satisfied', peerHandback: 'satisfied', leadHandling: 'drift', dispositionMessage: LAST };
const BRIEF_GAP = { leadBrief: 'drift', peerHandback: 'satisfied', leadHandling: 'pending' };
const NO_ACTION = { leadBrief: 'satisfied', peerHandback: 'satisfied', leadHandling: 'no_action_required' };
const HANDLED_NO_ACTION = () => ({ ...NO_ACTION });

const makeObserver = (t, { home, gate = GATE_OK, ask, agents = {}, localGate: caseGate, sendImpl, deferRetryMs, now } = {}) => {
  const stableRoot = join(home, 'slp-runtime');
  const observer = createSupervisionObserver({
    stableRoot,
    // A function value is used as the resolver itself so tests can flip the
    // gate mid-flight (the file-stamp cache still applies between calls).
    gate: typeof gate === 'function' ? gate : () => gate,
    ask: ask ?? (async () => { throw new Error('ask-not-stubbed'); }),
    ...(caseGate === undefined ? {} : { localGate: caseGate }),
    ...(deferRetryMs === undefined ? {} : { deferRetryMs }),
    ...(now === undefined ? {} : { now }),
  });
  const paseo = makePaseo(agents, { sendImpl });
  t.after(() => observer.stop());
  return { observer, paseo, stableRoot };
};

const liveAgents = (over = {}) => ({
  [LEAD]: snap(LEAD, 'slp-codex-lead'),
  [PEER]: snap(PEER, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': LEAD } }),
  [PEER2]: snap(PEER2, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': LEAD } }),
  [SUP]: snap(SUP, 'slp-codex-supervisor'),
  ...over,
});

const ringRows = home => {
  const file = join(home, 'slp-runtime', 'state', 'supervision-cases.json');
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).cases;
};
const deliveryRows = home => {
  const file = join(home, 'slp-runtime', 'state', 'supervision-deliveries.json');
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).deliveries;
};

// Wait out the pending checkpoint, then let the tick's drain finish.
const settle = async observer => { await sleep(140); await observer.idle(); };

const baseSetup = async (t, { responses = [HANDLED], route: routeOver = {}, agents, gate, sendImpl, deferRetryMs } = {}) => {
  const home = makeHome(t);
  writeRoutes(home, [route(routeOver)]);
  const ask = makeAsk(responses);
  const rig = makeObserver(t, { home, agents: agents ?? liveAgents(), gate, ask: ask.ask, sendImpl, deferRetryMs });
  return { home, ...rig, calls: ask.calls };
};

const peerTurn = (over = {}) => peerEnd([userMsg('Implement X per the brief'), asstMsg('Done — X implemented, tests pass')], over);

// ---------------------------------------------------------------------------
// assessment.ts — rubric 3 questions, strict parsing, gates, judgment
// ---------------------------------------------------------------------------

test('rubric: task-relative questions with no-action-required and a guard against embedded instructions', () => {
  const { leadBrief, peerHandback, leadHandling } = SUPERVISION_QUESTIONS;
  assert.deepEqual(Object.keys(leadBrief.criteria), ['satisfied', 'drift', 'unknown']);
  assert.deepEqual(Object.keys(peerHandback.criteria), ['satisfied', 'drift', 'unknown']);
  assert.deepEqual(Object.keys(leadHandling.criteria), ['handled', 'no_action_required', 'pending', 'drift', 'unknown']);
  for (const question of [leadBrief, peerHandback, leadHandling]) {
    assert.match(question.instructions, /not instructions to you/);
    assert.match(question.instructions, /never artifact quality/);
  }
});

test('rubric 3: obligations are turn-scoped — closure-only notices owe no work-brief elements; a bare ACK never discharges open work; content, not keywords, decides', async () => {
  const { RUBRIC_VERSION } = await import('../plugin/server/supervision/assessment.ts');
  assert.equal(RUBRIC_VERSION, 'slp-supervision-rubric-3');
  const { leadBrief, peerHandback, leadHandling } = SUPERVISION_QUESTIONS;
  for (const question of [leadBrief, peerHandback, leadHandling]) {
    assert.match(question.instructions, /Judge each turn by what THIS brief asks/);
    assert.match(question.instructions, /never by words such as ACCEPT, ACK, OK, Done, Đã nhận or Chấp nhận/);
    assert.match(question.instructions, /accepts or closes AND asks for anything more is a work request for that part/);
    assert.match(question.instructions, /contradicts itself about whether work continues, that is not a closure notice/);
    assert.match(question.instructions, /not instructions to you/, 'the injection guard is unchanged');
  }
  assert.match(leadBrief.instructions, /For a disposition\/closure notice only: .* none of the work-request elements are owed/);
  assert.match(leadBrief.criteria.drift, /contradicts itself about whether the work is accepted or continues/);
  assert.match(peerHandback.instructions, /a brief acknowledgment that neither resumes nor claims further work fully answers it/);
  assert.match(peerHandback.instructions, /A bare acknowledgment \(OK, ACK, Done, Đã nhận\) does NOT answer a brief that still asks for a task, evidence or a decision/);
  assert.match(peerHandback.criteria.drift, /bare acknowledgment in place of requested work, evidence or a decision/);
  assert.match(peerHandback.criteria.drift, /new work claimed after a notice that closed the assignment/);
  // The choice vocabularies are unchanged — no new schema or choices.
  assert.deepEqual(Object.keys(leadBrief.criteria), ['satisfied', 'drift', 'unknown']);
  assert.deepEqual(Object.keys(peerHandback.criteria), ['satisfied', 'drift', 'unknown']);
});

test('closure vs work vs mixed (en/vi): every turn is asked and judged by Jev — no keyword filter drops or exempts a turn', async t => {
  // Mocked answers: this pins plumbing (full brief in the packet, all axes
  // asked, findings independent), not model behavior (see the ack-semantics
  // eval for live results).
  const turns = [
    ['closure-en', 'DISPOSITION — ACCEPT. The assignment is closed; no further work is requested.', 'Acknowledged — closed.', HANDLED_NO_ACTION()],
    ['closure-vi', 'KẾT LUẬN: CHẤP NHẬN. Assignment kết thúc, không cần làm thêm.', 'Đã nhận, đã đóng.', HANDLED_NO_ACTION()],
    ['mixed-en', 'ACCEPT the price module. Before closing, add a README section and send the diff.', 'Thanks, acknowledged — closing this out.', { leadBrief: 'satisfied', peerHandback: 'drift', leadHandling: 'pending' }],
    ['mixed-vi', 'CHẤP NHẬN phần slugify. Trước khi đóng, bổ sung test chuỗi rỗng và gửi kết quả npm test.', 'OK, đã nhận ACCEPT, xong.', { leadBrief: 'satisfied', peerHandback: 'drift', leadHandling: 'pending' }],
  ];
  for (const [name, brief, handback, spec] of turns) {
    const { observer, paseo, home, calls } = await baseSetup(t, { responses: [spec], route: { pendingDelayMs: 0 } });
    observer.onCreated(peerHook(), paseo);
    observer.onTurn(peerEnd([userMsg(brief), asstMsg(handback)]), paseo);
    await settle(observer);
    assert.equal(calls.length, 1, `${name}: the turn is assessed, never filtered out`);
    assert.deepEqual(Object.keys(calls[0].questions).sort(), ['leadBrief', 'leadHandling', 'peerHandback'], name);
    assert.equal(calls[0].state.brief.text, brief, `${name}: the full brief reaches Jev`);
    assert.equal(calls[0].state.handback.text, handback, name);
    assert.equal(calls[0].state.rubricVersion, 'slp-supervision-rubric-3', name);
    const row = ringRows(home)[0];
    if (name.startsWith('mixed')) assert.deepEqual(row.findings.map(f => f.axis), ['handback'], `${name}: a bare ACK to open follow-up work is a handback finding`);
    else assert.deepEqual([row.state, row.findings], ['evaluated', []], `${name}: a fitting ACK of a closure notice closes clean`);
  }
});

test('ack-closure eval set: explicit labels, both languages, ≥4 negative controls, packets build and pass the credential guard', () => {
  const dataset = JSON.parse(readFileSync(new URL('./fixtures/supervision/ack-closure-eval.json', import.meta.url), 'utf8'));
  const { leadBrief, peerHandback } = SUPERVISION_QUESTIONS;
  assert.ok(dataset.cases.length >= 8 && dataset.cases.length <= 12);
  assert.deepEqual(new Set(dataset.cases.map(c => c.lang)), new Set(['en', 'vi']));
  const negatives = dataset.cases.filter(c => c.negativeControl);
  assert.ok(negatives.length >= 4);
  for (const kind of ['mixed', 'contradiction', 'ambiguity']) assert.ok(negatives.some(c => c.kind === kind), kind);
  assert.ok(negatives.some(c => c.kind === 'work' && c.expected.peerHandback === 'drift'), 'an ACK that dodges an open task');
  for (const c of dataset.cases) {
    assert.ok(Object.keys(leadBrief.criteria).includes(c.expected.leadBrief), c.id);
    assert.ok(Object.keys(peerHandback.criteria).includes(c.expected.peerHandback), c.id);
    const payload = buildEvidencePayload({
      id: c.id, leadId: LEAD, peerId: PEER, peerTurnId: 't',
      evidence: { brief: { text: c.brief, messageId: null, flags: [] }, handback: { text: c.handback, messageId: null },
        roomMessages: [], uncertainRoomMessages: [], otherRoomMessages: [], reportMessages: [], peerSends: [],
        flags: ['report-route-unverifiable'], laneFlags: [], pendingDelayElapsed: false },
    }, { supervisorAgentId: null });
    assert.deepEqual(axisGates(payload), { brief: null, handback: null, handling: null }, c.id);
    assertRedacted({ state: payload, questions: buildQuestions({ leadBrief: true, peerHandback: true, leadHandling: false, briefCorrection: false, handbackCorrection: false, candidates: [] }) });
  }
});

test('buildQuestions: link questions exist only with candidates and their choices ARE the candidate set', () => {
  const none = buildQuestions({ leadBrief: true, peerHandback: true, leadHandling: true, briefCorrection: true, handbackCorrection: false, candidates: [] });
  assert.deepEqual(Object.keys(none).sort(), ['leadBrief', 'leadHandling', 'peerHandback'], 'no candidates → no link questions');
  const linked = buildQuestions({ leadBrief: false, peerHandback: false, leadHandling: true, briefCorrection: true, handbackCorrection: false, candidates: ['m1', 'm2'] });
  assert.deepEqual(Object.keys(linked).sort(), ['briefCorrection', 'dispositionMessage', 'leadHandling']);
  assert.deepEqual(Object.keys(linked.dispositionMessage.criteria), ['m1', 'm2', 'none', 'unknown']);
  const gated = buildQuestions({ leadBrief: true, peerHandback: true, leadHandling: false, briefCorrection: false, handbackCorrection: false, candidates: ['m1'] });
  assert.equal(gated.dispositionMessage, undefined, 'no disposition link when handling is not asked');
});

test('parse: exactly the asked questions validate; pin rule; malformed distributions and ties rejected', () => {
  const questions = buildQuestions({ leadBrief: true, peerHandback: true, leadHandling: true, briefCorrection: false, handbackCorrection: false, candidates: ['m1'] });
  const request = { questions };
  const ok = respond(request, HANDLED);
  assert.ok(parseAssessmentResponse(ok, PROVIDER, questions));
  assert.ok(parseAssessmentResponse({ ...ok, model: 'typesafe/jev-1.13-20260917' }, PROVIDER, questions), 'resolved sub-version is within the pin');
  assert.equal(parseAssessmentResponse({ ...ok, model: 'other/model-9' }, PROVIDER, questions), null);
  assert.equal(parseAssessmentResponse({ ...ok, model: 'typesafe/jev-2.0' }, PROVIDER, questions), null);
  // A missing asked question or an extra unasked one is rejected.
  const missing = structuredClone(ok); delete missing.answers.dispositionMessage;
  assert.equal(parseAssessmentResponse(missing, PROVIDER, questions), null);
  const extra = structuredClone(ok); extra.answers.briefCorrection = extra.answers.dispositionMessage;
  assert.equal(parseAssessmentResponse(extra, PROVIDER, questions), null);
  // A link answer naming a message the code did not offer is schema-invalid.
  const forged = structuredClone(ok);
  forged.answers.dispositionMessage = { type: 'choice', choice: 'm9', confidence: 0.95, probabilities: { m9: 0.9, m1: 0.05, none: 0.03, unknown: 0.02 } };
  assert.equal(parseAssessmentResponse(forged, PROVIDER, questions), null);
  const bad = structuredClone(ok);
  bad.answers.leadBrief = { type: 'choice', choice: 'satisfied', confidence: 0.95, probabilities: { satisfied: 0.5, drift: 0.5, unknown: 0.5 } };
  assert.equal(parseAssessmentResponse(bad, PROVIDER, questions), null);
  const tied = structuredClone(ok);
  tied.answers.peerHandback = { type: 'choice', choice: 'satisfied', confidence: 0.95, probabilities: { satisfied: 0.5, drift: 0.5, unknown: 0 } };
  assert.equal(parseAssessmentResponse(tied, PROVIDER, questions), null);
});

// A payload for the gate unit tests — shaped by the production builder.
const payloadWith = (over = {}, evidenceOver = {}) => ({
  ...buildEvidencePayload({
    id: 'case-x', leadId: LEAD, peerId: PEER, peerTurnId: 'turn-p1',
    evidence: {
      brief: { text: 'brief body', messageId: 'm-brief', flags: [] },
      handback: { text: 'handback body', messageId: 'm-handback' },
      roomMessages: [], uncertainRoomMessages: [], otherRoomMessages: [], reportMessages: [], peerSends: [],
      flags: [], laneFlags: [], pendingDelayElapsed: false,
      ...evidenceOver,
    },
  }, { supervisorAgentId: SUP }),
  ...over,
});

test('evidence payload carries only the allowed fields — asserted on the production builder', () => {
  // Any field added to the outbound state must fail this test (spec §Jev:
  // bound ids, case/turn/message ids, complete brief and handback bodies,
  // confirmed post-handback room/cross-Peer/report prompts, ids-only
  // uncertain sends, confirmed Peer sends, prior finding axes, flags).
  const payload = buildEvidencePayload(
    {
      id: 'case-x', leadId: LEAD, peerId: PEER, peerTurnId: 'turn-p1',
      findings: [{ axis: 'brief', choice: 'drift', confidence: 0.95, at: 'x', status: 'open', evidenceCallId: null, resolvedBy: null, resolvedAt: null }],
      evidence: {
        brief: { text: 'brief body', messageId: 'm-brief', flags: [] },
        handback: { text: 'handback body', messageId: 'm-handback' },
        roomMessages: [{ callId: 'c1', turnId: 'turn-l1', recipient: PEER, prompt: 'ack', seq: 3 }],
        uncertainRoomMessages: [{ callId: 'c2', turnId: 'turn-l2', recipient: PEER2, prompt: 'SECRET-UNCERTAIN-BODY', seq: 4 }],
        otherRoomMessages: [{ callId: 'c3', turnId: 'turn-l1', recipient: PEER2, prompt: 'other', seq: 1 }],
        reportMessages: [{ callId: 'c4', turnId: 'turn-l1', recipient: SUP, prompt: 'report', seq: 2 }],
        peerSends: [{ callId: 'c5', turnId: 'turn-p1', recipient: LEAD, prompt: 'report', seq: 0 }],
        flags: ['report-route-unverifiable'],
        laneFlags: ['lead-start-end-derived'],
        pendingDelayElapsed: true,
      },
    },
    { supervisorAgentId: SUP },
  );
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['axes', 'bound', 'brief', 'caseId', 'flags', 'handback', 'laneFlags', 'messages', 'packetVersion',
      'peerSends', 'peerTurnId', 'priorFindings', 'rubricVersion', 'uncertainMessages'],
  );
  assert.equal(payload.pendingWindowElapsed, undefined, 'elapsed time is never evidence sent to Jev');
  assert.deepEqual(Object.keys(payload.bound).sort(), ['leadAgentId', 'peerId', 'supervisorAgentId']);
  assert.deepEqual(Object.keys(payload.handback).sort(), ['exceedsNotificationLimit', 'messageId', 'text']);
  // One chronological message list across lanes, with stable keys.
  assert.deepEqual(payload.messages.map(m => [m.key, m.callId, m.recipientRole]), [
    ['m1', 'c3', 'other-peer'], ['m2', 'c4', 'supervisor'], ['m3', 'c1', 'case-peer'],
  ]);
  assert.deepEqual(Object.keys(payload.messages[0]).sort(), ['callId', 'key', 'prompt', 'recipient', 'recipientRole', 'turnId']);
  assert.equal(payload.messages[0].prompt, 'other', 'cross-Peer bodies are transmitted');
  // Uncertain sends carry ids + recipient only — never bodies.
  assert.deepEqual(Object.keys(payload.uncertainMessages[0]).sort(), ['callId', 'recipient', 'turnId']);
  assert.ok(!JSON.stringify(payload).includes('SECRET-UNCERTAIN-BODY'));
  assert.deepEqual(Object.keys(payload.peerSends[0]).sort(), ['callId', 'prompt', 'recipient']);
  assert.deepEqual(payload.priorFindings, [{ axis: 'brief', choice: 'drift' }]);
  // Byte-cap fallback withholds cross-Peer bodies explicitly.
  const reduced = buildEvidencePayload({ id: 'case-x', leadId: LEAD, peerId: PEER, peerTurnId: null, evidence: {
    brief: null, handback: null, roomMessages: [], uncertainRoomMessages: [], reportMessages: [], peerSends: [],
    otherRoomMessages: [{ callId: 'c3', turnId: 't', recipient: PEER2, prompt: 'other', seq: 1 }],
    flags: [], laneFlags: [], pendingDelayElapsed: false,
  } }, { supervisorAgentId: null }, { omitOtherBodies: true });
  assert.equal(reduced.messages[0].prompt, null);
  assert.ok(reduced.laneFlags.includes('other-room-bodies-omitted'));
  assert.equal(linkCandidates(reduced).size, 0, 'a withheld body is never a link candidate');
  assert.deepEqual([...linkCandidates(payload).entries()], [['m1', 'c3'], ['m2', 'c4'], ['m3', 'c1']]);
});

test('localGate: only whole-window provenance gaps close the case before Jev', () => {
  for (const flag of ['capture-paused', 'credential-shaped-content', 'evidence-oversize', 'peer-turn-not-completed', 'no-observable-communication']) {
    assert.equal(localGate(payloadWith({ flags: [flag] })), flag, flag);
  }
  // Family coverage never closes a case: an unverified brief/handback/send
  // gates only the axes that depend on it.
  for (const flag of ['family-shape-unverified', 'unsupported-family', 'brief-unverified', 'handback-unverified']) {
    assert.equal(localGate(payloadWith({ flags: [flag] })), null, flag);
  }
  // Lane and report-route flags never close the case.
  for (const flag of ['report-route-unverifiable', 'lead-start-unmatched', 'send-not-completed', 'recipient-refresh-failed', 'queue-overflow']) {
    assert.equal(localGate(payloadWith({ laneFlags: [flag], flags: ['report-route-unverifiable'] })), null, flag);
  }
  assert.equal(localGate(payloadWith({ brief: null, handback: null })), 'no-observable-communication');
  // Unreadable is not silent: an unverified brief/handback is communication.
  assert.equal(localGate(payloadWith({ brief: null, handback: null, flags: ['brief-unverified', 'handback-unverified'] })), null);
});

test('axisGates: one applicability — handback and handling need a usable brief; the report route gates nothing', () => {
  assert.deepEqual(axisGates(payloadWith({ flags: ['report-route-unverifiable'] })), { brief: null, handback: null, handling: null });
  // Pointer brief: the brief is unusable, so is the request-relative
  // handback, and (packet 3) so is handling — its reason is the brief's.
  const pointer = payloadWith({}, { brief: { text: 'see .local-checks/brief.md', messageId: 'm', flags: ['brief-references-assignment-file'] } });
  assert.deepEqual(axisGates(pointer), { brief: 'brief-references-assignment-file', handback: 'brief-unobservable', handling: 'brief-references-assignment-file' });
  assert.deepEqual(axisGates(payloadWith({ brief: null })), { brief: 'brief-missing', handback: 'brief-unobservable', handling: 'brief-missing' });
  // Missing vs unverified is kept apart.
  assert.deepEqual(axisGates(payloadWith({ brief: null, flags: ['brief-unverified', 'role-prefix-unrecognized'] })),
    { brief: 'brief-unverified', handback: 'brief-unobservable', handling: 'brief-unverified' });
  assert.deepEqual(axisGates(payloadWith({ handback: null, flags: ['handback-unverified'] })),
    { brief: null, handback: 'handback-unverified', handling: 'handback-unverified' });
  // No handback: nothing to judge on handback or handling.
  assert.deepEqual(axisGates(payloadWith({ handback: null })), { brief: null, handback: 'handback-missing', handling: 'handback-missing' });
  // Lead send-lane / coverage / chronology problems gate only handling.
  for (const flag of ['lead-start-unmatched', 'send-not-completed', 'send-result-unobservable', 'send-coverage-unverified', 'send-result-unsuccessful',
    'send-result-contradictory', 'lead-provider-unknown', 'recipient-refresh-failed', 'recipient-inactive', 'family-shape-unverified',
    'queue-overflow', 'other-room-bodies-omitted', 'send-shape-unverified']) {
    const gates = axisGates(payloadWith({ laneFlags: [flag] }));
    assert.equal(gates.brief, null, flag);
    assert.equal(gates.handback, null, flag);
    assert.equal(gates.handling, flag, flag);
  }
  // A Peer-side send reason (case flags) never gates anything.
  assert.deepEqual(axisGates(payloadWith({ flags: ['send-result-unobservable'] })), { brief: null, handback: null, handling: null });
  assert.equal(axisGates(payloadWith({ uncertainMessages: [{ callId: 'u', turnId: null, recipient: PEER }] })).handling, 'chronology-or-delivery-uncertain');
});

const ans = (choice, confidence = 0.95) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: 0.9 } });
const OPEN = { brief: null, handback: null, handling: null };
const CANDS = new Map([['m1', 'call-1'], ['m2', 'call-2']]);

test('judge: findings are independent — an unknown or gated axis never erases another finding', () => {
  const j = judge({ leadBrief: ans('satisfied'), peerHandback: ans('drift'), leadHandling: ans('unknown') }, OPEN, 0.9, CANDS);
  assert.equal(j.handback.status, 'gap');
  assert.equal(j.brief.status, 'clean');
  assert.equal(j.handling.status, 'unjudged');
  // Gated handling cannot veto a confident handback gap.
  const gated = judge({ leadBrief: ans('drift'), peerHandback: ans('drift'), leadHandling: ans('drift'), dispositionMessage: ans('m1') },
    { ...OPEN, handling: 'lead-start-unmatched' }, 0.9, CANDS);
  assert.equal(gated.brief.status, 'gap');
  assert.equal(gated.handback.status, 'gap');
  assert.equal(gated.handling.status, 'unjudged', 'a gated axis produces no finding');
  // Low confidence (below the configured threshold) is never a finding.
  assert.equal(judge({ leadBrief: ans('drift', 0.85) }, OPEN, 0.9, CANDS).brief.status, 'unjudged');
  assert.equal(judge({ leadBrief: ans('drift', 0.85) }, OPEN, 0.8, CANDS).brief.status, 'gap', 'the threshold is configurable');
  // An unobservable axis cannot produce a gap whatever the model says.
  assert.equal(judge({ leadBrief: ans('drift') }, { ...OPEN, brief: 'brief-references-assignment-file' }, 0.9, CANDS).brief.status, 'unjudged');
});

test('judge: handled and mishandling must link a code-offered message; silence and pending never alert', () => {
  const noLink = judge({ leadHandling: ans('handled') }, OPEN, 0.9, CANDS);
  assert.equal(noLink.handling.status, 'unjudged', 'handled without a linked message is not a disposition');
  const linked = judge({ leadHandling: ans('handled'), dispositionMessage: ans('m2') }, OPEN, 0.9, CANDS);
  assert.deepEqual([linked.handling.status, linked.handling.callId], ['clean', 'call-2']);
  const driftNoLink = judge({ leadHandling: ans('drift'), dispositionMessage: ans('none') }, OPEN, 0.9, CANDS);
  assert.equal(driftNoLink.handling.status, 'unjudged', 'drift over no linked message is silence — never a finding');
  const drift = judge({ leadHandling: ans('drift'), dispositionMessage: ans('m1') }, OPEN, 0.9, CANDS);
  assert.deepEqual([drift.handling.status, drift.handling.callId], ['gap', 'call-1']);
  assert.equal(judge({ leadHandling: ans('pending') }, OPEN, 0.9, CANDS).handling.status, 'open');
  assert.equal(judge({ leadHandling: ans('no_action_required') }, OPEN, 0.9, CANDS).handling.status, 'clean', 'informational handback owes no reply');
  // A link outside the candidate map links nothing.
  assert.equal(judge({ leadHandling: ans('handled'), dispositionMessage: ans('m7') }, OPEN, 0.9, CANDS).handling.status, 'unjudged');
  // Corrections link per axis.
  const corr = judge({ briefCorrection: ans('m1'), handbackCorrection: ans('none') }, OPEN, 0.9, CANDS);
  assert.deepEqual(corr.corrections, { brief: 'call-1', handback: null });
});

// ---------------------------------------------------------------------------
// jev.ts — resolver gates + transport parity
// ---------------------------------------------------------------------------

const writeJev = (home, config, { key, padBytes = 0 } = {}) => {
  const dir = join(home, 'slp-runtime', 'state');
  mkdirSync(dir, { recursive: true });
  // padBytes appends trailing whitespace — still valid JSON, but the
  // mtime+size stamp cache sees a new stamp even when mtime collides.
  if (config !== undefined) writeFileSync(join(dir, 'jev.json'), JSON.stringify(config, null, 2) + '\n' + ' '.repeat(padBytes), { mode: 0o600 });
  if (key !== undefined) writeFileSync(join(dir, 'jev-openrouter.key'), `${key}\n`, { mode: 0o600 });
};
const JEV_CFG = { schemaVersion: 1, enabled: true, capabilities: { supervision: true, routing: false }, provider: PROVIDER };

test('jev resolveSupervision: fail-closed gates in order', t => {
  const home = makeHome(t);
  const root = join(home, 'slp-runtime');
  assert.deepEqual(resolveSupervision(root), { ok: false, reason: 'jev-unconfigured' });
  writeJev(home, { ...JEV_CFG, enabled: false });
  assert.equal(resolveSupervision(root).reason, 'jev-disabled');
  writeJev(home, { ...JEV_CFG, capabilities: { supervision: false } });
  assert.equal(resolveSupervision(root).reason, 'jev-capability-off');
  writeJev(home, JEV_CFG);
  assert.equal(resolveSupervision(root).reason, 'jev-key-missing');
  writeJev(home, JEV_CFG, { key: 'sk-or-testkey' });
  const ok = resolveSupervision(root);
  assert.equal(ok.ok, true);
  assert.equal(ok.authorization, 'Bearer sk-or-testkey');
});

test('jev askJevDecision: endpoint join, extras, single-shot (no retry)', async t => {
  const home = makeHome(t);
  writeJev(home, JEV_CFG, { key: 'sk-or-testkey' });
  const gate = resolveSupervision(join(home, 'slp-runtime'));
  assert.equal(gate.ok, true);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ model: PROVIDER.model, answers: { q: { type: 'choice', choice: 'a', confidence: 1 } } }) };
  };
  const out = await askJevDecision(gate.provider, gate.authorization, {
    state: { caseId: 'c1' },
    questions: { q: { type: 'choice', instructions: 'pick', criteria: { a: 'a', b: 'b' } } },
  }, { fetchImpl });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://openrouter.ai/api/alpha/decisions');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, PROVIDER.model);
  assert.deepEqual(body.provider, { allow_fallbacks: false });
  assert.equal(out.answers.q.choice, 'a');
});

test('jev askJevDecision: typesafe transport hits /v1/systemone without a provider field', async t => {
  // Transport parity (spec §Jev: the same TypeSafe Jev request format the
  // routing path uses): the typesafe endpoint takes NO provider object —
  // sending OpenRouter's allow_fallbacks pin would corrupt the request.
  const provider = { kind: 'typesafe', baseUrl: 'https://typesafe.example/base', model: 'typesafe/jev-1.13' };
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ model: provider.model, answers: { q: { type: 'choice', choice: 'a', confidence: 1 } } }) };
  };
  const out = await askJevDecision(provider, 'Bearer ts-key', {
    state: { caseId: 'c1' },
    questions: { q: { type: 'choice', instructions: 'pick', criteria: { a: 'a', b: 'b' } } },
  }, { fetchImpl });
  assert.equal(seen.length, 1, 'single-shot — no retry');
  assert.equal(seen[0].url, 'https://typesafe.example/base/v1/systemone');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, provider.model);
  assert.equal('provider' in body, false, 'typesafe requests carry no provider field');
  assert.equal(out.answers.q.choice, 'a');
});

test('jev askJevDecision: credential-shaped payload refused before transport', async t => {
  const home = makeHome(t);
  writeJev(home, JEV_CFG, { key: 'sk-or-testkey' });
  const gate = resolveSupervision(join(home, 'slp-runtime'));
  let called = 0;
  await assert.rejects(
    askJevDecision(gate.provider, gate.authorization, {
      state: { prompt: `token ${'sk-or-' + 'a'.repeat(20)}` },
      questions: { q: { type: 'choice', instructions: 'x', criteria: { a: 'a' } } },
    }, { fetchImpl: async () => { called += 1; throw new Error('must not fetch'); } }),
    error => error instanceof JevRequestError && error.code === 'jev-redacted',
  );
  assert.equal(called, 0);
  assert.throws(() => assertRedacted({ [`Bearer ${'x'.repeat(20)}`]: 'v' }), /credential-shaped/);
});

test('jev askJevDecision: a response error is single-shot — no automatic retry', async t => {
  const home = makeHome(t);
  writeJev(home, JEV_CFG, { key: 'sk-or-testkey' });
  const gate = resolveSupervision(join(home, 'slp-runtime'));
  const calls = [];
  await assert.rejects(
    askJevDecision(gate.provider, gate.authorization, {
      state: { caseId: 'c1' },
      questions: { q: { type: 'choice', instructions: 'pick', criteria: { a: 'a', b: 'b' } } },
    }, {
      fetchImpl: async () => {
        calls.push(1);
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream boom' } }) };
      },
    }),
    error => error instanceof JevRequestError && error.code === 'jev-http' && /HTTP 500/.test(error.message),
  );
  assert.equal(calls.length, 1, 'no retry after a response error');
});

test('jev askJevDecision: a stalled body read rejects after the deadline — no retry', async t => {
  const home = makeHome(t);
  writeJev(home, JEV_CFG, { key: 'sk-or-testkey' });
  const gate = resolveSupervision(join(home, 'slp-runtime'));
  const calls = [];
  const started = Date.now();
  await assert.rejects(
    askJevDecision(gate.provider, gate.authorization, {
      state: { caseId: 'c1' },
      questions: { q: { type: 'choice', instructions: 'pick', criteria: { a: 'a', b: 'b' } } },
    }, {
      timeoutMs: 60,
      // Headers resolve; the body read never settles AND ignores the abort
      // signal — the deadline must still fire (whole-request bound).
      fetchImpl: async () => {
        calls.push(1);
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
      },
    }),
    error => error instanceof JevRequestError && error.code === 'jev-timeout',
  );
  assert.ok(Date.now() - started < 5000, 'the request rejects at the deadline, not never');
  assert.equal(calls.length, 1, 'no retry after a timeout');
});

test('jev askJevDecision: a network throw is single-shot — no automatic retry', async t => {
  const home = makeHome(t);
  writeJev(home, JEV_CFG, { key: 'sk-or-testkey' });
  const gate = resolveSupervision(join(home, 'slp-runtime'));
  const calls = [];
  await assert.rejects(
    askJevDecision(gate.provider, gate.authorization, {
      state: { caseId: 'c1' },
      questions: { q: { type: 'choice', instructions: 'pick', criteria: { a: 'a', b: 'b' } } },
    }, { fetchImpl: async () => { calls.push(1); throw new TypeError('socket hangup'); } }),
    error => error instanceof JevRequestError && error.code === 'jev-network',
  );
  assert.equal(calls.length, 1, 'no retry after a network error');
});

// ---------------------------------------------------------------------------
// observer — the spec scenarios
// ---------------------------------------------------------------------------

// Host truth: every Peer case carries report-route-unverifiable (no
// machine-readable report-recipient signal exists). Since rubric 2 it is a
// disclosed visibility flag, not a gate: a handling disposition or
// mishandling must be LINKED to a confirmed post-handback message, so the
// flag is never needed to rule out silence.
const ROUTE_FLAG = 'report-route-unverifiable';
const until = async cond => { while (!cond()) await sleep(2); };

test('observer: assess at handback, re-assess on a new message, close evaluated on a linked disposition', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.equal(calls.length, 1, 'assessed as soon as the handback landed — no waiting for the delay');
  assert.deepEqual(Object.keys(calls[0].questions).sort(), ['leadBrief', 'leadHandling', 'peerHandback']);
  // "handled" with nothing to link is not a disposition — the case stays open.
  assert.equal(ringRows(home)[0].state, 'unknown');
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'accepted — the scope question is settled: keep module A')]), paseo);
  await observer.idle();
  assert.equal(calls.length, 2, 'the new message body changed the packet → one fresh assessment');
  assert.deepEqual(Object.keys(calls[1].questions).sort(), ['dispositionMessage', 'leadHandling'],
    'brief/handback bodies are immutable per case — judged once');
  assert.equal(calls[1].state.messages[0].prompt, 'accepted — the scope question is settled: keep module A');
  const rows = ringRows(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'evaluated');
  assert.equal(rows[0].reason, null);
  assert.equal(rows[0].counts.roomMessages, 1);
  assert.deepEqual(rows[0].messageIds, { brief: 'm-user', handback: 'm-asst', sendCallIds: ['c1'], sendTurnIds: ['turn-l1'] });
  assert.equal(rows[0].assessmentsUsed, 2);
  assert.equal(rows[0].lastAssessment.rubricVersion, 'slp-supervision-rubric-3');
  assert.equal(rows[0].lastAssessment.links.dispositionMessage, 'c1');
  assert.ok(rows[0].visibility.includes(ROUTE_FLAG), 'the report-route limit stays visible');
  assert.deepEqual(rows[0].findings, []);
});

test('observer: an informational handback owing no reply closes evaluated without any Lead message', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t, { responses: [NO_ACTION] });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.equal(calls.length, 1);
  assert.equal(ringRows(home)[0].state, 'evaluated', 'no manufactured silence alert');
});

test('observer scenario 1: different room — a send to another Lead\'s Peer is never room communication', async t => {
  const agents = liveAgents({
    [OTHER]: snap(OTHER, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': OTHER_LEAD } }),
  });
  const { observer, paseo, home, calls } = await baseSetup(t, { responses: [MISHANDLED], agents });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', OTHER, 'unrelated work')]), paseo);
  await settle(observer);
  assert.ok(paseo.refreshed.includes(OTHER), 'the unrelated recipient went through refresh verification');
  assert.equal(calls.length, 1, 'nothing entered this room — no re-assessment');
  const rows = ringRows(home);
  assert.equal(rows[0].counts.roomMessages + rows[0].counts.otherRoomMessages, 0);
  assert.deepEqual(rows[0].findings, [], 'a drift answer with nothing to link is silence, never a finding');
  assert.notEqual(rows[0].state, 'suspected_drift');
});

test('observer scenarios 2+4: direct action or final prose without a send is never handling or drift', async t => {
  for (const timeline of [
    [userMsg('next'), asstMsg('I fixed it myself — no message sent')],
    [asstMsg('Looks good, thanks')],
  ]) {
    const { observer, paseo, home, calls } = await baseSetup(t, { responses: [MISHANDLED] });
    observer.onCreated(peerHook(), paseo);
    observer.onTurn(peerTurn(), paseo);
    await observer.idle();
    observer.onStart(leadStart('turn-l1'));
    observer.onTurn(leadEnd(timeline), paseo);
    await settle(observer);
    assert.equal(calls.length, 1);
    const rows = ringRows(home);
    assert.deepEqual(rows[0].findings, [], 'silence is never drift');
    assert.equal(rows[0].counts.roomMessages, 0);
    assert.equal(rows[0].counts.peerSends, 0);
  }
});

test('observer scenario 3: assignmentFile pointer — no usable axis, so no Jev call at all', async t => {
  // Packet 3: handling needs a usable brief too (the obligation's request).
  // A pointer brief leaves brief, handback and handling unusable → zero HTTP.
  const { observer, paseo, home, calls } = await baseSetup(t, { route: { pendingDelayMs: 0 }, responses: [BRIEF_GAP] });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerEnd([
    userMsg('Work the assignment file at .local-checks/brief.md'),
    asstMsg('Done'),
  ]), paseo);
  await observer.idle();
  assert.equal(calls.length, 0, 'Jev never judges what the brief cannot show');
  const rows = ringRows(home);
  assert.deepEqual(rows[0].findings, [], 'a pointer brief plus "Done" is not a missing-evidence finding');
  assert.equal(rows[0].state, 'unknown');
  assert.equal(rows[0].reason, 'brief-references-assignment-file');
});

test('observer scenario 5: overlapping Lead turns — ambiguous chronology gates handling only', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-a'));
  observer.onStart(leadStart('turn-b'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'ack')], { turnId: 'turn-a' }), paseo);
  await settle(observer);
  assert.equal(calls.length, 1, 'a gated handling axis has nothing new to ask');
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'unknown');
  assert.equal(rows[0].reason, 'lead-start-unmatched');
  assert.equal(rows[0].counts.roomMessages, 0);
  assert.equal(rows[0].counts.uncertainRoomMessages, 1);
});

// ---------------------------------------------------------------------------
// End-only chronology fallback — the turn_ended event's own ordering is the
// only honest fallback when no usable start reached this observer.
// ---------------------------------------------------------------------------

test('observer: end-only chronology — the finish envelope qualifies the send and the case can close', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onTurn(leadEnd([userMsg(finishEnvelope(PEER, HANDBACK)), codexSend('c1', PEER, 'acknowledged — continue')]), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].counts.roomMessages, 1, 'end-derived ordering qualifies the confirmed send');
  assert.equal(rows[0].counts.uncertainRoomMessages, 0);
  assert.ok(rows[0].visibility.includes('lead-start-end-derived'), 'the derivation is recorded, not hidden');
  assert.ok(!rows[0].visibility.includes('lead-start-unmatched'));
  assert.equal(rows[0].state, 'evaluated');
  assert.equal(calls.length, 2);
});

for (const [name, timeline] of [
  ['no start and no handback anchor', [userMsg('an unrelated input'), codexSend('c1', PEER, 'maybe-early ack')]],
  ['an anchor in an OLDER turn slice', [userMsg(finishEnvelope(PEER, HANDBACK)), asstMsg('earlier slice'), userMsg('new input'), codexSend('c1', PEER, 'ack')]],
  ['a foreign envelope naming the peer in its title', [userMsg(`<paseo-system>\nAgent ${OTHER} (relay for Agent ${PEER} (p)) finished.\n\n<agent-response>\n${HANDBACK}\n</agent-response>\n</paseo-system>`), codexSend('c1', PEER, 'ack')]],
]) {
  test(`observer: end-only fallback fabricates nothing — ${name}`, async t => {
    const { observer, paseo, home, calls } = await baseSetup(t);
    observer.onCreated(peerHook(), paseo);
    observer.onTurn(peerTurn(), paseo);
    await observer.idle();
    observer.onTurn(leadEnd(timeline), paseo);
    await settle(observer);
    assert.equal(calls.length, 1);
    const rows = ringRows(home);
    assert.equal(rows[0].counts.roomMessages, 0);
    assert.equal(rows[0].counts.uncertainRoomMessages, 1);
    assert.ok(rows[0].visibility.includes('lead-start-unmatched'));
    assert.ok(!rows[0].visibility.includes('lead-start-end-derived'));
    assert.equal(rows[0].reason, 'lead-start-unmatched');
  });
}

test('observer: a report prompt body claimed by two peers anchors neither case', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onCreated(peerHook(PEER2), paseo);
  observer.onTurn(peerEnd([userMsg('brief A'), codexSend('r1', LEAD, 'SHARED REPORT'), asstMsg('handback A')]), paseo);
  observer.onTurn(peerEnd([userMsg('brief B'), codexSend('r2', LEAD, 'SHARED REPORT'), asstMsg('handback B')], { peerId: PEER2, turnId: 'turn-p2' }), paseo);
  await observer.idle();
  observer.onTurn(leadEnd([userMsg('SHARED REPORT'), codexSend('c1', PEER, 'ack')]), paseo);
  await settle(observer);
  assert.equal(calls.length, 2, 'one assessment per case');
  for (const peerId of [PEER, PEER2]) {
    const row = ringRows(home).find(r => r.peerId === peerId);
    assert.ok(row !== undefined, `a case exists for ${peerId}`);
    assert.equal(row.counts.roomMessages, 0);
    assert.equal(row.counts.uncertainRoomMessages, 1);
    assert.ok(row.visibility.includes('lead-start-unmatched'), `unauthenticated body stays unmatched for ${peerId}`);
  }
});

test('observer: a steered finish notification qualifies sends on a pre-handback start', async t => {
  const { observer, paseo, home } = await baseSetup(t);
  observer.onStart(leadStart('turn-l1'));
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onTurn(leadEnd([userMsg(finishEnvelope(PEER, HANDBACK)), codexSend('c1', PEER, 'ack')], { turnId: 'turn-l1' }), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].counts.roomMessages, 1, 'the steered handback anchors the turn');
  assert.ok(rows[0].visibility.includes('lead-start-end-derived'));
  assert.ok(!rows[0].visibility.includes('lead-start-unmatched'));
});

test('observer: a bare report-prompt user_message does not anchor — only the envelope proves delivery', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerEnd([userMsg('Implement X per the brief'), codexSend('r1', LEAD, 'REPORT: X done, tests pass'), asstMsg(HANDBACK)]), paseo);
  await observer.idle();
  observer.onTurn(leadEnd([userMsg('REPORT: X done, tests pass'), codexSend('c1', PEER, 'ack')]), paseo);
  await settle(observer);
  assert.equal(calls.length, 1);
  const rows = ringRows(home);
  assert.equal(rows[0].counts.roomMessages, 0);
  assert.equal(rows[0].counts.uncertainRoomMessages, 1);
  assert.equal(rows[0].counts.peerSends, 1, 'the peer report send is still captured evidence');
  assert.ok(rows[0].visibility.includes('lead-start-unmatched'));
});

test('observer scenario 6: failed tool send — a handling-lane gap, never a verdict', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t, { responses: [MISHANDLED] });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  const failed = codexSend('c1', PEER, 'ack', { status: 'failed', error: { message: 'send failed' } });
  failed.detail = { ...failed.detail, output: null };
  observer.onTurn(leadEnd([failed]), paseo);
  await settle(observer);
  assert.equal(calls.length, 1, 'only the initial brief/handback assessment — the lane gap asks nothing');
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'unknown');
  assert.equal(rows[0].reason, 'send-result-unsuccessful', 'an explicit failure is a rejected send — handling unknown, never pending');
  assert.ok(rows[0].visibility.includes('send-result-unsuccessful'));
  assert.equal(rows[0].counts.roomMessages, 0, 'a rejected send is never a link candidate');
  assert.deepEqual(rows[0].findings, []);
});

test('observer scenario 7: canceled Lead turn — a confirmed send still counts', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'ack with decision')], { outcome: { kind: 'canceled', reason: 'user stop' } }), paseo);
  await settle(observer);
  assert.equal(calls.length, 2);
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'evaluated');
  assert.equal(rows[0].counts.roomMessages, 1);
  assert.ok(rows[0].visibility.includes('lead-turn-not-completed'));
});

test('observer scenario 8: stale assessment — evidence landing mid-ask discards it, the re-ask sees the new basis', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 0 })]);
  const calls = [];
  let release;
  const firstAskHeld = new Promise(resolve => { release = resolve; });
  const ask = async (provider, auth, request) => {
    calls.push(request);
    if (calls.length === 1) await firstAskHeld;
    const raw = respond(request, HANDLED);
    return { model: raw.model, answers: raw.answers, usage: raw.usage, raw };
  };
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  while (calls.length === 0) await sleep(2);
  assert.equal(calls[0].state.messages.length, 0, 'first ask saw no Lead message');
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'late decision')]), paseo);
  release();
  await observer.idle();
  assert.equal(calls.length, 2, 'stale ask discarded, fresh ask spent');
  assert.equal(calls[1].state.messages.length, 1, 'the re-ask carries the late send');
  assert.ok('leadBrief' in calls[1].questions, 'answers of a discarded ask are never held');
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'evaluated');
  assert.equal(rows[0].assessmentsUsed, 2, 'both spends count against the ceiling');
});

// ---------------------------------------------------------------------------
// Chronology scoping — a canceled turn that sent nothing orders nothing.
// ---------------------------------------------------------------------------

test('observer: a pre-handback Lead turn canceled by the handback delivery stamps no chronology gap', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onStart(leadStart('turn-l0'));
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onTurn(leadEnd([userMsg('earlier work'), asstMsg('partial')], {
    turnId: 'turn-l0', outcome: { kind: 'canceled', reason: 'interrupted' },
  }), paseo);
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([userMsg(finishEnvelope(PEER, HANDBACK)), codexSend('c1', PEER, 'decision: proceed with B')], { turnId: 'turn-l1' }), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].visibility.includes('lead-start-unmatched'), 'the canceled no-send turn ordered nothing');
  assert.ok(!rows[0].visibility.includes('lead-turn-not-completed'), 'a no-send canceled turn is not evidence');
  assert.equal(rows[0].counts.roomMessages, 1);
  assert.equal(rows[0].state, 'evaluated');
  assert.equal(calls.length, 2);
});

test('observer: a post-handback Lead turn canceled with no send stamps no gap and spends nothing extra', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t, { responses: [PENDING] });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([userMsg(finishEnvelope(PEER, HANDBACK)), asstMsg('reading…')], {
    turnId: 'turn-l1', outcome: { kind: 'canceled', reason: 'interrupted' },
  }), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.deepEqual(rows[0].visibility, [ROUTE_FLAG]);
  assert.equal(rows[0].counts.roomMessages + rows[0].counts.uncertainRoomMessages, 0);
  assert.equal(calls.length, 1, 'the empty canceled turn never re-armed an evaluation');
  assert.equal(rows[0].reason, 'handling-pending', 'a disposition is still owed — open, not an alert');
});

test('observer: a pre-handback turn that DID send still gates the handling axis as unmatched', async t => {
  const { observer, paseo, home } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onStart(leadStart('turn-l0'));
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onTurn(leadEnd([userMsg('earlier work'), codexSend('c0', PEER, 'early note')], { turnId: 'turn-l0' }), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.ok(rows[0].visibility.includes('lead-start-unmatched'));
  assert.equal(rows[0].counts.uncertainRoomMessages, 1);
  assert.equal(rows[0].reason, 'lead-start-unmatched');
});

// ---------------------------------------------------------------------------
// Independent findings — history kept, resolution only by a linked correction
// ---------------------------------------------------------------------------

test('findings: a brief gap is resolved only by a correction linked to a specific later message', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t, {
    route: { pendingDelayMs: 60_000 },
    responses: [
      BRIEF_GAP,
      // Cross-Peer activity: still pending, links nothing.
      { leadHandling: 'pending', dispositionMessage: 'none', briefCorrection: 'none' },
      // The Lead supplies the missing scope to THIS Peer.
      { leadHandling: 'handled', dispositionMessage: LAST, briefCorrection: LAST },
    ],
  });
  observer.onCreated(peerHook(), paseo);
  observer.onCreated(peerHook(PEER2), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  let rows = ringRows(home);
  assert.equal(rows[0].state, 'suspected_drift');
  assert.deepEqual(rows[0].findings.map(f => [f.axis, f.choice, f.status]), [['brief', 'drift', 'open']]);
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER2, 'other task')], { turnId: 'turn-l1' }), paseo);
  await observer.idle();
  assert.equal(calls.length, 2);
  assert.ok('briefCorrection' in calls[1].questions, 'an open finding asks for its linked correction');
  assert.deepEqual(calls[1].state.priorFindings, [{ axis: 'brief', choice: 'drift' }]);
  rows = ringRows(home);
  assert.equal(rows[0].findings[0].status, 'open', 'a send\'s mere presence repairs nothing');
  observer.onStart(leadStart('turn-l2'));
  observer.onTurn(leadEnd([codexSend('c2', PEER, 'scope: only module A; read-only elsewhere; report test output')], { turnId: 'turn-l2' }), paseo);
  await observer.idle();
  assert.equal(calls.length, 3);
  rows = ringRows(home);
  assert.equal(rows[0].findings.length, 1, 'history is kept, never erased');
  assert.deepEqual([rows[0].findings[0].status, rows[0].findings[0].resolvedBy], ['resolved', 'c2']);
  assert.equal(rows[0].state, 'evaluated');
});

test('findings: a clean handling disposition does not repair an unrelated handback gap', async t => {
  const { observer, paseo, home } = await baseSetup(t, {
    responses: [
      { leadBrief: 'satisfied', peerHandback: 'drift', leadHandling: 'pending' },
      { leadHandling: 'handled', dispositionMessage: LAST, handbackCorrection: 'none' },
    ],
  });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'accepted')]), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.deepEqual(rows[0].findings.map(f => [f.axis, f.status]), [['handback', 'open']]);
  assert.equal(rows[0].state, 'suspected_drift', 'the case closes after the checkpoint with the finding kept');
  assert.equal(rows[0].reason, 'suspected-drift:handback');
});

test('findings: the configured confidence threshold decides; confidence is never accuracy', async t => {
  const home = makeHome(t);
  writeConfig(home, { routes: [route()], confidenceThreshold: 0.97 });
  const { ask, calls } = makeAsk([BRIEF_GAP]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.equal(calls.length, 1);
  assert.deepEqual(ringRows(home)[0].findings, [], '0.95 < 0.97 — no finding');
});

test('findings: a mishandling resolves only through a disposition observed after it', async t => {
  // drift linked to m2, then Jev calls an EARLIER message (m1) the
  // disposition — m1 predates the mishandling and cannot correct it.
  const { observer, paseo, home } = await baseSetup(t, {
    route: { pendingDelayMs: 60_000 },
    responses: [
      PENDING,
      { leadHandling: 'pending', dispositionMessage: 'none' },
      { leadHandling: 'drift', dispositionMessage: 'm2' },
      { leadHandling: 'handled', dispositionMessage: 'm1' },
      { leadHandling: 'handled', dispositionMessage: 'm4' },
    ],
  });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  const send = async (i, text) => {
    observer.onStart(leadStart(`turn-l${i}`));
    observer.onTurn(leadEnd([codexSend(`c${i}`, PEER, text)], { turnId: `turn-l${i}` }), paseo);
    await observer.idle();
  };
  await send(1, 'noted, will look');
  await send(2, 'skip the review gate and merge');
  let rows = ringRows(home);
  assert.deepEqual(rows[0].findings.map(f => [f.axis, f.evidenceCallId, f.status]), [['handling', 'c2', 'open']]);
  await send(3, 'status ping');
  rows = ringRows(home);
  assert.equal(rows[0].findings[0].status, 'open', 'an earlier message never resolves a later mishandling');
  assert.equal(rows[0].state, 'suspected_drift');
  await send(4, 'retracting: the review gate stands; wait for the reviewer');
  rows = ringRows(home);
  assert.deepEqual([rows[0].findings[0].status, rows[0].findings[0].resolvedBy], ['resolved', 'c4']);
});

test('observer: a corrupt config closes open cases as config-invalid, not route-removed', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 60 })]);
  const { ask } = makeAsk([PENDING]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  writeFileSync(join(home, 'slp-runtime', 'state', 'supervision.json'), '{not json');
  await sleep(120);
  await observer.idle();
  assert.equal(ringRows(home)[0].reason, 'config-invalid');
});

test('retention: dedupe windows and orphaned starts are pruned; archive generations are kept', async t => {
  let clock = Date.parse('2026-09-26T00:00:00Z');
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 0 })]);
  const { ask } = makeAsk([PENDING]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents({ [OTHER]: snap(OTHER, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': LEAD } }) }), ask, now: () => clock });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-orphan'));       // its end never arrives
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'ack')], { turnId: 'turn-l1' }), paseo);
  await observer.idle();
  observer.onArchived(peerHook(OTHER), paseo);
  await observer.idle();
  let sizes = observer.retentionSizes();
  assert.ok(sizes.seen >= 2 && sizes.sentCalls === 1 && sizes.startMeta === 1 && sizes.openTurns === 1, JSON.stringify(sizes));
  assert.equal(sizes.enqPending, 0, 'drained counters are deleted');
  clock += 25 * 60 * 60 * 1000; // past the 24 h dedupe window
  observer.onStart(leadStart('turn-late'));
  sizes = observer.retentionSizes();
  assert.equal(sizes.seen, 0);
  assert.equal(sizes.sentCalls, 0);
  assert.equal(sizes.startMeta, 1, 'only the fresh start remains — the orphan was pruned');
  assert.equal(sizes.leadStarts, 1);
  assert.equal(sizes.openTurns, 1);
  assert.equal(sizes.archiveGen, 1, 'generations stay: they are the archive/ABA authority');
  assert.equal(sizes.archivedNow, 1, 'tombstones stay');
});

test('retention: the in-memory metadata ring holds what disk holds (≤200)', async t => {
  const home = makeHome(t);
  const dir = join(home, 'slp-runtime', 'state');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString();
  const rows = Array.from({ length: 230 }, (_, i) => ({
    fingerprint: i.toString(16).padStart(64, '0'), leadAgentId: LEAD, peerId: PEER, peerTurnId: null,
    observedAt: stamp, updatedAt: stamp, state: 'unknown', reason: null, visibility: [],
  }));
  writeFileSync(join(dir, 'supervision-cases.json'), JSON.stringify({ schemaVersion: 1, cases: rows }));
  writeRoutes(home, [route({ pendingDelayMs: 0 })]);
  const { ask } = makeAsk([PENDING]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  assert.equal(observer.shadow(join(home, 'slp-runtime')).observations.length, 230, 'an oversized file loads for review');
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.equal(observer.retentionSizes().ring, 200);
  assert.equal(ringRows(home).length, 200);
  assert.ok(ringRows(home).some(row => row.peerId === PEER && row.lastAssessment !== null), 'the live case row is kept');
});

test('observer: the assessment ceiling stops spending and never reuses a stale answer', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t, { responses: [PENDING], route: { pendingDelayMs: 60_000 } });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  for (let i = 1; i <= 7; i += 1) {
    observer.onStart(leadStart(`turn-l${i}`));
    observer.onTurn(leadEnd([codexSend(`c${i}`, PEER, `update ${i}`)], { turnId: `turn-l${i}` }), paseo);
    await observer.idle();
  }
  assert.equal(calls.length, 6, 'initial + re-assessments stop at the ceiling');
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'unknown');
  assert.equal(rows[0].reason, 'assessment-ceiling');
  assert.equal(rows[0].assessmentsUsed, 6);
});

test('observer scenario 9: archive/restore — tombstone drops work, refresh verifies restoration', async t => {
  const { observer, paseo, home } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onArchived(leadHook(), paseo);
  await observer.idle();
  let rows = ringRows(home);
  assert.equal(rows[0].state, 'unknown');
  assert.equal(rows[0].reason, 'lead-archived');
  observer.onTurn(leadEnd([codexSend('c3', PEER, 'ghost')]), paseo);
  await observer.idle();
  observer.onCreated(leadHook(), paseo);
  await observer.idle();
  observer.onCreated(peerHook(PEER2), paseo);
  observer.onTurn(peerEnd([userMsg('new brief'), asstMsg('done')], { peerId: PEER2, turnId: 'turn-p2' }), paseo);
  await settle(observer);
  rows = ringRows(home);
  assert.equal(rows.length, 2);
  const restored = rows.find(r => r.peerId === PEER2);
  assert.ok(restored.lastAssessment !== null, 'the restored lead is observed again');
});

// ---------------------------------------------------------------------------
// Gates, bounds, persistence
// ---------------------------------------------------------------------------

test('observer: failed Jev gate pauses capture entirely', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route()]);
  const calls = [];
  const { observer, paseo } = makeObserver(t, {
    home, agents: liveAgents(),
    gate: { ok: false, reason: 'jev-capability-off' },
    ask: async () => { calls.push(1); throw new Error('unreachable'); },
  });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.equal(calls.length, 0);
  assert.equal(ringRows(home).length, 0, 'paused capture records no case');
  const view = observer.shadow(join(home, 'slp-runtime'));
  assert.equal(view.gates[LEAD], 'jev-capability-off');
});

test('observer: off is inert — no host call, no queue, no case, no file, no diagnostics', async t => {
  // Two ways to be off: the Jev capability off (with a stale route still
  // stored), and capability on with supervision settings off. Neither may
  // refresh or prompt any agent, spend on Jev, write a ring, or count drops.
  const scenarios = [
    { name: 'capability off, route stored', gate: { ok: false, reason: 'jev-capability-off' }, config: { routes: [route()] } },
    { name: 'Jev disabled, defaults stored', gate: { ok: false, reason: 'jev-disabled' }, config: { defaults: { mode: 'notify', supervisorAgentId: SUP, supervisorWorkspaceId: WKS } } },
    { name: 'capability on, settings off', gate: GATE_OK, config: {} },
  ];
  for (const scenario of scenarios) {
    const home = makeHome(t);
    writeConfig(home, scenario.config);
    const calls = [];
    const { observer, paseo } = makeObserver(t, {
      home, agents: liveAgents(), gate: scenario.gate,
      ask: async () => { calls.push(1); throw new Error('unreachable'); },
    });
    observer.onCreated(leadHook(), paseo);
    observer.onCreated(peerHook(), paseo);
    observer.onStart(leadStart('turn-l1'));
    observer.onTurn(peerTurn(), paseo);
    observer.onTurn(leadEnd([codexSend('c1', PEER, 'thanks')]), paseo);
    await observer.idle();
    assert.deepEqual(paseo.refreshed, [], `${scenario.name}: no refresh`);
    assert.deepEqual(paseo.sent, [], `${scenario.name}: no prompt`);
    assert.equal(calls.length, 0, `${scenario.name}: no Jev call`);
    assert.equal(ringRows(home).length, 0, `${scenario.name}: no case`);
    assert.equal(existsSync(join(home, 'slp-runtime', 'state', 'supervision-cases.json')), false, `${scenario.name}: no ring file`);
    assert.equal(existsSync(join(home, 'slp-runtime', 'state', 'supervision-deliveries.json')), false, `${scenario.name}: no delivery file`);
    const view = observer.shadow(join(home, 'slp-runtime'));
    assert.deepEqual([view.diagnostics.droppedEvents, view.diagnostics.reasons], [0, []], `${scenario.name}: no diagnostics`);
    assert.equal(observer.retentionSizes().cases, 0, scenario.name);
  }
});

test('observer: the pending delay is a delivery checkpoint, not an assessment wait', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 60_000 })]);
  const { ask, calls } = makeAsk([PENDING]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.equal(calls.length, 1, 'assessed immediately');
  assert.equal(calls[0].state.pendingWindowElapsed, undefined, 'elapsed time is never sent as evidence');
});

test('observer: ring persists metadata only — no bodies, survives reload', async t => {
  const { observer, paseo, home } = await baseSetup(t, { responses: [BRIEF_GAP] });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  const file = join(home, 'slp-runtime', 'state', 'supervision-cases.json');
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes('Implement X per the brief'), 'brief body must never persist');
  assert.ok(!raw.includes('Done — X implemented'), 'handback body must never persist');
  const rig2 = makeObserver(t, { home, agents: liveAgents() });
  const view = rig2.observer.shadow(join(home, 'slp-runtime'));
  assert.equal(view.observations.length, 1);
  assert.equal(view.observations[0].findings[0].axis, 'brief', 'findings survive as metadata');
  assert.deepEqual(view.observations[0].route, { source: 'route', mode: 'shadow' });
});

test('observer: cross-Peer disposition — a verified message to another direct Peer can carry handling', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onCreated(peerHook(PEER2), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER2, `${PEER2}: investigate the scope decision raised by the other Peer; owner you, report by EOD`)]), paseo);
  await settle(observer);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].state.messages.map(m => [m.callId, m.recipientRole]), [['c1', 'other-peer']]);
  assert.ok(calls[1].state.messages[0].prompt.includes('investigate'), 'cross-Peer bodies reach Jev');
  const rows = ringRows(home);
  assert.equal(rows.length, 1, 'PEER2 never had a turn — only this case exists');
  assert.equal(rows[0].counts.otherRoomMessages, 1);
  assert.equal(rows[0].state, 'evaluated');
  assert.equal(rows[0].lastAssessment.links.dispositionMessage, 'c1');
});

test('observer: a Jev-gate failure mid-flight pauses capture — no new evidence lands, case closes unknown', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 60 })]);
  let currentGate = GATE_OK;
  const calls = [];
  const { observer, paseo } = makeObserver(t, {
    home, agents: liveAgents(),
    gate: () => currentGate,
    ask: async () => { calls.push(1); throw new Error('transport down'); },
  });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.equal(calls.length, 1, 'the handback was assessed (and failed) while the gate was green');
  currentGate = { ok: false, reason: 'jev-key-missing' };
  writeJev(home, JEV_CFG);
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'ack')]), paseo);
  await settle(observer);
  assert.equal(calls.length, 1, 'no spend while the gate is down');
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'unknown');
  assert.equal(rows[0].reason, 'jev-key-missing');
  assert.ok(rows[0].visibility.includes('capture-paused'));
  assert.equal(rows[0].counts.roomMessages, 0, 'no new evidence lands while the gate is down');
});

test('observer: UTF-8 byte ceiling — a unicode payload over 64KiB gates before Jev', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t, { route: { pendingDelayMs: 0 } });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerEnd([userMsg('brief'), asstMsg('é'.repeat(33_000))]), paseo);
  await settle(observer);
  assert.equal(calls.length, 0);
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'unknown');
  assert.equal(rows[0].reason, 'evidence-oversize');
});

test('observer: over the byte cap with cross-Peer bodies — bodies are withheld and handling becomes unobservable', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t, { responses: [PENDING] });
  observer.onCreated(peerHook(), paseo);
  observer.onCreated(peerHook(PEER2), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER2, 'x'.repeat(40_000)), codexSend('c2', PEER2, 'y'.repeat(30_000))]), paseo);
  await settle(observer);
  assert.equal(calls.length, 1, 'with handling unobservable there is nothing new to ask');
  const rows = ringRows(home);
  assert.ok(rows[0].visibility.includes('other-room-bodies-omitted'));
  assert.equal(rows[0].reason, 'other-room-bodies-omitted');
  assert.equal(rows[0].counts.otherRoomMessages, 2);
});

test('observer: archive during peer-refresh — a stale verification cannot admit a tombstoned generation', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 0 })]);
  const calls = [];
  const agents = liveAgents();
  let refreshStarted = false;
  let releaseRefresh;
  const gate = new Promise(resolve => { releaseRefresh = resolve; });
  const paseo = {
    agents: {
      ref: id => ({
        refresh: async () => {
          if (id === PEER) { refreshStarted = true; await gate; }
          return { agent: agents[id] ?? null };
        },
        send: async () => {},
      }),
    },
  };
  const { observer } = makeObserver(t, {
    home,
    ask: async () => { calls.push(1); throw new Error('unreachable'); },
  });
  observer.onTurn(peerTurn(), paseo);
  while (!refreshStarted) await sleep(1);
  observer.onArchived(peerHook(), paseo);
  releaseRefresh();
  await observer.idle();
  assert.equal(calls.length, 0);
  const rows = ringRows(home);
  assert.ok(rows.length > 0, 'the dropped turn still records a metadata row');
  assert.ok(rows.every(row => row.state === 'unknown'));
  assert.ok(rows.every(row => row.reason === 'peer-archived'));
});

test('observer: gate-down clears retained bodies globally — the Jev gate is daemon-global', async t => {
  const LEAD_B = '88888888-8888-4888-8888-888888888888';
  const PEER_B = '99999999-9999-4999-8999-999999999999';
  const home = makeHome(t);
  writeRoutes(home, [
    route({ pendingDelayMs: 60_000 }),
    route({ leadAgentId: LEAD_B, pendingDelayMs: 60_000 }),
  ]);
  const agents = liveAgents({
    [LEAD_B]: snap(LEAD_B, 'slp-codex-lead'),
    [PEER_B]: snap(PEER_B, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': LEAD_B } }),
  });
  writeJev(home, JEV_CFG);
  let currentGate = GATE_OK;
  const { ask } = makeAsk([PENDING]);
  const { observer, paseo } = makeObserver(t, { home, agents, gate: () => currentGate, ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  observer.onCreated(peerHook(PEER_B, { parentAgentId: LEAD_B }), paseo);
  observer.onTurn(peerEnd([userMsg('brief B'), asstMsg('handback B')], { peerId: PEER_B, turnId: 'turn-pB', agent: { parentAgentId: LEAD_B } }), paseo);
  await observer.idle();
  const rowA = ringRows(home).find(r => r.peerId === PEER);
  const rowB = ringRows(home).find(r => r.peerId === PEER_B);
  assert.ok(observer.retainedBodies(rowA.fingerprint) > 0, 'case A retains bodies pre-gate-down');
  assert.ok(observer.retainedBodies(rowB.fingerprint) > 0, 'case B retains bodies pre-gate-down');
  currentGate = { ok: false, reason: 'jev-key-missing' };
  writeJev(home, JEV_CFG, { key: 'k'.repeat(32) });
  observer.onTurn(leadEnd([asstMsg('gate-observing event')]), paseo);
  assert.equal(observer.retainedBodies(rowA.fingerprint), 0, 'event-observing lead cleared');
  assert.equal(observer.retainedBodies(rowB.fingerprint), 0, 'other lead cleared — the gate is global');
});

test('observer: a verify job queued before an archive never admits the stale generation', async t => {
  const { observer, paseo, home } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onArchived(peerHook(), paseo);
  await observer.idle();
  observer.onTurn(peerTurn({ turnId: 'after-archive' }), paseo);
  await observer.idle();
  assert.equal(ringRows(home).length, 0, 'a queued-then-archived verification must not admit a later turn');
  assert.ok(observer.shadow(join(home, 'slp-runtime')).diagnostics.reasons.includes('peer-archived'));
});

test('observer: a tombstoned send recipient is never admitted — not even via refresh', async t => {
  const agents = liveAgents({
    [OTHER]: snap(OTHER, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': LEAD } }),
  });
  const { observer, paseo, home } = await baseSetup(t, { agents });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onArchived(peerHook(OTHER), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', OTHER, 'post-archive send')]), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].counts.otherRoomMessages, 0, 'an archived recipient is never room communication');
  assert.ok(rows[0].visibility.includes('recipient-inactive'));
});

test('observer: an archive landing during evaluation refresh closes peer-archived', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 40 })]);
  const agents = liveAgents();
  let evalRefreshStarted = false;
  let releaseEval;
  const evalGate = new Promise(resolve => { releaseEval = resolve; });
  let peerRefreshes = 0;
  const paseo = {
    agents: {
      ref: id => ({
        refresh: async () => {
          if (id === PEER && ++peerRefreshes === 2) { evalRefreshStarted = true; await evalGate; }
          return { agent: agents[id] ?? null };
        },
        send: async () => {},
      }),
    },
  };
  const calls = [];
  const { observer } = makeObserver(t, { home, agents, ask: async () => { calls.push(1); throw new Error('unreachable'); } });
  observer.onTurn(peerTurn(), paseo);
  while (!evalRefreshStarted) await sleep(1);
  observer.onArchived(peerHook(), paseo);
  releaseEval();
  await observer.idle();
  assert.equal(calls.length, 0, 'no Jev spend on a stale generation');
  const rows = ringRows(home);
  assert.equal(rows[rows.length - 1].reason, 'peer-archived', 'archive mid-evaluation wins over the snapshot');
});

test('observer: a pi Peer (observed proxy send shape) is assessed on all three axes; its accepted report is a delivered send', async t => {
  const PI_PEER = '77777777-7777-4777-8777-777777777777';
  const agents = liveAgents({
    [PI_PEER]: snap(PI_PEER, 'slp-pi-peer', { labels: { 'paseo.parent-agent-id': LEAD } }),
  });
  const { observer, paseo, home, calls } = await baseSetup(t, { agents, responses: [PENDING, HANDLED] });
  // live-pi-peer.timeline.json shape: the proxied mcp__paseo call.
  const piReport = {
    type: 'tool_call', callId: 'call_p1|fc_p1', name: 'mcp__paseo', status: 'completed', error: null,
    detail: { type: 'unknown', input: { tool: 'paseo_send_agent_prompt', args: { agentId: LEAD, prompt: 'pi report' } },
      output: { content: [{ type: 'text', text: '{"success":true}' }], details: { mode: 'call', server: 'paseo', tool: 'send_agent_prompt',
        mcpResult: { content: [], structuredContent: { success: true, status: 'running', lastMessage: null, permission: null } } } } },
  };
  observer.onCreated(peerHook(PI_PEER, { provider: 'slp-pi-peer' }), paseo);
  observer.onTurn(peerEnd([userMsg('Implement X per the brief'), piReport, asstMsg(HANDBACK)], { peerId: PI_PEER, agent: { provider: 'slp-pi-peer' } }), paseo);
  await observer.idle();
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].questions).sort(), ['leadBrief', 'leadHandling', 'peerHandback']);
  assert.deepEqual(calls[0].state.peerSends.map(send => send.prompt), ['pi report']);
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PI_PEER, 'decision: proceed with B')]), paseo);
  await settle(observer);
  const row = ringRows(home).find(r => r.peerId === PI_PEER);
  assert.equal(row.state, 'evaluated');
  assert.ok(!row.visibility.includes('family-shape-unverified'));
});

test('observer: a devin Lead\'s unconfirmed sends gate only handling — brief/handback still judged', async t => {
  const agents = liveAgents({ [LEAD]: snap(LEAD, 'slp-devin-lead') });
  const { observer, paseo, home, calls } = await baseSetup(t, { agents, responses: [BRIEF_GAP] });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1', { agent: { provider: 'slp-devin-lead' } }));
  observer.onTurn(leadEnd([devinSend('d1', PEER, 'ack')], { agent: { provider: 'slp-devin-lead' } }), paseo);
  await observer.idle();
  const rows = ringRows(home);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].questions).sort(), ['leadBrief', 'peerHandback'],
    'a devin Lead can never have an accepted disposition — handling is unusable from the first assessment');
  assert.equal(calls[0].state.axes.handling.reason, 'send-coverage-unverified');
  assert.equal(rows[0].counts.uncertainRoomMessages, 1);
  assert.ok(rows[0].visibility.includes('send-result-unobservable'));
  assert.ok(rows[0].visibility.includes('send-coverage-unverified'), 'family coverage stays distinct from this call\'s missing result');
  assert.deepEqual(rows[0].findings.map(f => f.axis), ['brief'], 'the brief finding survives the handling gate');
});

test('observer: route removed after capture closes route-removed, never judged further', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 60 })]);
  const { ask, calls } = makeAsk([PENDING]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  writeRoutes(home, []);
  await sleep(120);
  await observer.idle();
  assert.equal(calls.length, 1);
  assert.equal(ringRows(home)[0].reason, 'route-removed');
});

test('observer: agent.created never trusts the payload — membership needs refresh-verified parentage', async t => {
  const agents = liveAgents({
    [PEER]: snap(PEER, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': OTHER_LEAD } }),
  });
  const { observer, paseo, home, calls } = await baseSetup(t, { agents });
  observer.onCreated(peerHook(), paseo);
  await observer.idle();
  assert.ok(paseo.refreshed.includes(PEER), 'created peer went through refresh verification');
  observer.onTurn(peerTurn(), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].reason, 'recipient-refresh-failed', 'refreshed parentage disagrees — never registered');
  assert.equal(calls.length, 0);
});

test('observer: agent.created admits a peer once refresh verifies the claimed parent', async t => {
  const { observer, paseo, home } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  await observer.idle();
  observer.onTurn(peerTurn(), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.ok(rows[0].lastAssessment !== null, 'a real case was created — not the unverified-membership stub');
  assert.ok(!rows[0].visibility.includes('recipient-refresh-failed'));
});

test('observer: gate-down empties retained bodies at detection, not at evaluation', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 60_000 })]);
  writeJev(home, JEV_CFG);
  let currentGate = GATE_OK;
  const { ask } = makeAsk([PENDING]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), gate: () => currentGate, ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  const fp = ringRows(home)[0].fingerprint;
  assert.ok(observer.retainedBodies(fp) > 0, 'bodies retained while the gate is green');
  currentGate = { ok: false, reason: 'jev-key-missing' };
  writeJev(home, JEV_CFG, { key: 'k'.repeat(32) });
  observer.onTurn(leadEnd([codexSend('c9', PEER, 'post-gate send')]), paseo);
  assert.equal(observer.retainedBodies(fp), 0, 'retained bodies emptied at gate-down detection');
  assert.equal(ringRows(home)[0].counts.roomMessages, 0, 'nothing appended while the gate is down');
});

test('observer: an in-place mutation re-arms the case and it closes on the new basis', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 40 })]);
  let currentGate = GATE_OK;
  const { ask, calls } = makeAsk([PENDING]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), gate: () => currentGate, ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  const fp = ringRows(home)[0].fingerprint;
  currentGate = { ok: false, reason: 'jev-key-missing' };
  writeJev(home, JEV_CFG, { key: 'k'.repeat(32) });
  observer.onTurn(leadEnd([codexSend('c9', PEER, 'dropped')]), paseo);
  assert.equal(observer.retainedBodies(fp), 0);
  currentGate = GATE_OK;
  writeJev(home, JEV_CFG, { key: 'z'.repeat(64) });
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'unknown');
  assert.ok(rows[0].reason === 'jev-key-missing' || rows[0].reason === 'capture-paused', rows[0].reason);
  assert.ok(rows[0].visibility.includes('capture-paused'));
  assert.equal(calls.length, 1, 'never spends on the purged basis');
  assert.equal(observer.retainedBodies(fp), null, 'closed case is gone from the open map');
});

test('observer: a non-qualifying report send lands in the uncertain lane, symmetric with room sends', async t => {
  const { observer, paseo, home } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onTurn(leadEnd([codexSend('c1', SUP, 'status report'), codexSend('c2', PEER, 'maybe-early ack')]), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].counts.reportMessages, 0);
  assert.equal(rows[0].counts.roomMessages, 0);
  assert.equal(rows[0].counts.uncertainRoomMessages, 2);
  assert.equal(rows[0].reason, 'lead-start-unmatched');
});

test('observer: a qualifying escalation to the route Supervisor can be the disposition', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t);
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', SUP, 'Owner decision needed: scope of X; Peer paused until you decide')]), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].counts.reportMessages, 1);
  assert.equal(calls[1].state.messages[0].recipientRole, 'supervisor');
  assert.equal(rows[0].messageIds.sendTurnIds.includes('turn-l1'), true);
  assert.equal(rows[0].state, 'evaluated');
});

test('observer: ring rows persisted before the new fields existed still load', async t => {
  const home = makeHome(t);
  const dir = join(home, 'slp-runtime', 'state');
  mkdirSync(dir, { recursive: true });
  const oldRow = {
    fingerprint: 'a'.repeat(64), leadAgentId: LEAD, peerId: PEER, peerTurnId: 'turn-p1',
    observedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    state: 'unknown', reason: 'report-route-unverifiable',
    visibility: ['report-route-unverifiable'],
    counts: { roomMessages: 1, uncertainRoomMessages: 0, reportMessages: 0, peerSends: 0 },
    assessmentsUsed: 0, lastAssessment: { at: 'x', model: 'm', usage: null, choices: { leadBrief: 'satisfied' } },
  };
  const rubric1Row = {
    ...oldRow, fingerprint: 'b'.repeat(64),
    lastAssessment: { at: 'x', model: 'm', usage: null, choices: {
      leadBrief: { choice: 'satisfied', confidence: 0.95 }, peerHandback: { choice: 'satisfied', confidence: 0.95 }, leadHandling: { choice: 'handled', confidence: 0.95 },
    } },
  };
  writeFileSync(join(dir, 'supervision-cases.json'), JSON.stringify({ schemaVersion: 1, cases: [oldRow, rubric1Row] }, null, 2));
  const { observer } = makeObserver(t, { home, agents: liveAgents() });
  const view = observer.shadow(join(home, 'slp-runtime'));
  assert.equal(view.observations.length, 2, 'older ring rows load, never silently dropped');
  const row = view.observations.find(r => r.fingerprint === 'a'.repeat(64));
  assert.equal(row.counts.otherRoomMessages, 0);
  assert.equal(row.lastAssessment, null);
  assert.deepEqual([row.route, row.findings, row.delivery], [null, [], null]);
  const legacy = view.observations.find(r => r.fingerprint === 'b'.repeat(64));
  assert.equal(legacy.lastAssessment.rubricVersion, 'legacy-1', 'old choices never inherit rubric-2 meaning');
});

// ---------------------------------------------------------------------------
// Discovery and migration
// ---------------------------------------------------------------------------

test('discovery: daemon defaults observe a discovered SLP Lead without any per-Lead route', async t => {
  const home = makeHome(t);
  writeConfig(home, { defaults: { mode: 'shadow', pendingDelayMs: 0 } });
  const { ask, calls } = makeAsk([PENDING]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  // After a reload no Lead event has been seen: the Peer event alone drives
  // verification of BOTH the Lead (exact slp lead, active) and the Peer.
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.ok(paseo.refreshed.includes(LEAD), 'the discovered Lead was verified by refresh');
  assert.equal(calls.length, 1);
  const rows = ringRows(home);
  assert.deepEqual(rows[0].route, { source: 'default', mode: 'shadow' });
  assert.ok(LEAD in observer.shadow(join(home, 'slp-runtime')).gates, 'the discovered Lead shows a gate line');
});

test('discovery: an explicit off route wins over defaults; defaults off observe nothing; non-SLP parents never qualify', async t => {
  const scenarios = [
    { name: 'explicit off', config: { routes: [route({ mode: 'off' })], defaults: { mode: 'shadow' } }, agents: liveAgents() },
    { name: 'defaults off', config: {}, agents: liveAgents() },
    { name: 'non-SLP lead', config: { defaults: { mode: 'shadow' } }, agents: liveAgents({ [LEAD]: snap(LEAD, 'codex-lead') }) },
    { name: 'default Supervisor is never its own Lead', config: { defaults: { mode: 'shadow', supervisorAgentId: LEAD, supervisorWorkspaceId: WKS } }, agents: liveAgents() },
  ];
  for (const scenario of scenarios) {
    const home = makeHome(t);
    writeConfig(home, scenario.config);
    const calls = [];
    const { observer, paseo } = makeObserver(t, { home, agents: scenario.agents, ask: async () => { calls.push(1); throw new Error('unreachable'); } });
    observer.onTurn(peerTurn(), paseo);
    await observer.idle();
    assert.equal(calls.length, 0, scenario.name);
    assert.ok(ringRows(home).every(row => row.state !== 'observed' || row.lastAssessment === null), scenario.name);
    assert.equal(ringRows(home).filter(row => row.reason !== 'recipient-refresh-failed').length, 0, `${scenario.name}: no case`);
  }
});

test('discovery: an explicit route observes only once host evidence shows its Lead in the route workspace', async t => {
  // A save can accept a Lead the plugin could not refresh (pending
  // verification). The observer then waits for host evidence: the gate
  // reads lead-not-seen-yet, a Lead seen in another workspace reads
  // lead-workspace-mismatch, and a Peer event refreshes the Lead first.
  const home = makeHome(t);
  writeRoutes(home, [route({ pendingDelayMs: 0 })]);
  const { ask, calls } = makeAsk([PENDING]);
  const moved = liveAgents({ [LEAD]: snap(LEAD, 'slp-codex-lead', { workspaceId: 'wks_elsewhere' }) });
  const { observer, paseo } = makeObserver(t, { home, agents: moved, ask });
  const root = join(home, 'slp-runtime');
  assert.equal(observer.shadow(root).gates[LEAD], 'lead-not-seen-yet');
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.ok(paseo.refreshed.includes(LEAD), 'a Peer event verifies an undiscovered explicit-route Lead');
  assert.equal(calls.length, 0, 'a Lead in another workspace does not match the route');
  assert.equal(observer.shadow(root).gates[LEAD], 'lead-workspace-mismatch');

  const home2 = makeHome(t);
  writeRoutes(home2, [route({ pendingDelayMs: 0 })]);
  const second = makeAsk([PENDING]);
  const rig = makeObserver(t, { home: home2, agents: liveAgents(), ask: second.ask });
  const root2 = join(home2, 'slp-runtime');
  rig.observer.onStart(leadStart('turn-l0'));
  assert.equal(rig.observer.shadow(root2).gates[LEAD], null, 'a Lead turn is host evidence');
  rig.observer.onTurn(peerTurn(), rig.paseo);
  await rig.observer.idle();
  assert.equal(second.calls.length, 1);
  assert.deepEqual(ringRows(home2)[0].route, { source: 'route', mode: 'shadow' });
});

test('migration: a schema-1 file observes nothing until re-saved — no silent widening on upgrade', async t => {
  const home = makeHome(t);
  const dir = join(home, 'slp-runtime', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'supervision.json'), JSON.stringify({ schemaVersion: 1, routes: [route({ mode: 'shadow' })] }));
  const calls = [];
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask: async () => { calls.push(1); throw new Error('unreachable'); } });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.equal(calls.length, 0);
  assert.equal(ringRows(home).length, 0);
});

// ---------------------------------------------------------------------------
// Mixed families — per-axis evidence, never a family-wide block
// ---------------------------------------------------------------------------

// Observed shapes (tests/fixtures/supervision/live-*.timeline.json).
const claudeSend = (callId, recipient, prompt, success = true) => ({
  type: 'tool_call', callId, name: 'mcp__paseo__send_agent_prompt', status: 'completed', error: null,
  detail: { type: 'unknown', input: { agentId: recipient, prompt }, output: { output: { success, status: 'running', lastMessage: null, permission: null } } },
});
const DEVIN_PEER_PREFIX = roleDelivery(new URL('..', import.meta.url).pathname, 'peer', {}).entry({ explicitLanguageState: true });

test('mixed: devin Peer + codex Lead — brief/handback from the stripped prompt, handling judged from the accepted Lead disposition', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t, { responses: [PENDING, HANDLED] });
  const devinPeer = { agent: { provider: 'slp-devin-peer' } };
  observer.onCreated(peerHook(PEER, { provider: 'slp-devin-peer' }), paseo);
  observer.onTurn(peerEnd([
    userMsg(`${DEVIN_PEER_PREFIX}Implement X per the brief`),
    devinSend('d1', LEAD, 'report body'),
    asstMsg(HANDBACK),
  ], devinPeer), paseo);
  await observer.idle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.brief.text, 'Implement X per the brief', 'the SLP role prefix never reaches Jev');
  assert.deepEqual(calls[0].state.peerSends, [], 'a Peer send with no observable outcome carries no body');
  assert.ok(!JSON.stringify(calls[0].state).includes('report body'));
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'decision: proceed with B')]), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'evaluated', 'the Peer\'s missing receipt does not block handling');
  assert.equal(calls[1].state.messages[0].prompt, 'decision: proceed with B');
});

test('mixed: claude in both roles — all three axes, the accepted Lead send links the disposition', async t => {
  const agents = liveAgents({
    [LEAD]: snap(LEAD, 'slp-claude-lead'),
    [PEER]: snap(PEER, 'slp-claude-peer', { labels: { 'paseo.parent-agent-id': LEAD } }),
  });
  const { observer, paseo, home, calls } = await baseSetup(t, { agents, responses: [PENDING, HANDLED] });
  const claudeLead = { agent: { provider: 'slp-claude-lead' } };
  observer.onCreated(peerHook(PEER, { provider: 'slp-claude-peer' }), paseo);
  observer.onTurn(peerEnd([userMsg('Implement X per the brief'), claudeSend('p1', LEAD, 'report'), asstMsg(HANDBACK)],
    { agent: { provider: 'slp-claude-peer' } }), paseo);
  await observer.idle();
  assert.deepEqual(Object.keys(calls[0].questions).sort(), ['leadBrief', 'leadHandling', 'peerHandback']);
  assert.deepEqual(calls[0].state.peerSends.map(send => send.prompt), ['report'], 'an accepted Peer send is a delivered report');
  observer.onStart(leadStart('turn-l1', claudeLead));
  observer.onTurn(leadEnd([claudeSend('c1', PEER, 'decision: proceed with B')], claudeLead), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'evaluated');
  assert.equal(rows[0].lastAssessment.links.dispositionMessage, 'c1');
  assert.equal(rows[0].lastAssessment.captureVersion, 'slp-capture-6');
});

test('mixed: a related rejected or canceled Lead send keeps handling unknown, offers no candidate and sends no body', async t => {
  for (const [name, send, reason] of [
    ['rejected', claudeSend('c1', PEER, 'SECRET-REJECTED-BODY', false), 'send-result-unsuccessful'],
    ['canceled', { ...claudeSend('c1', PEER, 'SECRET-CANCELED-BODY'), status: 'canceled', detail: { type: 'unknown', input: { agentId: PEER, prompt: 'SECRET-CANCELED-BODY' }, output: null } }, 'send-not-completed'],
  ]) {
    const agents = liveAgents({ [LEAD]: snap(LEAD, 'slp-claude-lead') });
    const { observer, paseo, home, calls } = await baseSetup(t, { agents, responses: [PENDING] });
    const claudeLead = { agent: { provider: 'slp-claude-lead' } };
    observer.onCreated(peerHook(), paseo);
    // Peer and Lead turns land before the first evaluation → one ask sees both.
    observer.onTurn(peerTurn(), paseo);
    observer.onStart(leadStart('turn-l1', claudeLead));
    observer.onTurn(leadEnd([send], claudeLead), paseo);
    await settle(observer);
    assert.equal(calls.length, 1, name);
    assert.deepEqual(Object.keys(calls[0].questions).sort(), ['leadBrief', 'peerHandback'], `${name}: handling is not asked`);
    assert.equal(calls[0].state.axes.handling.reason, reason, name);
    assert.deepEqual(calls[0].state.messages, [], `${name}: never a link candidate`);
    assert.deepEqual(calls[0].state.uncertainMessages, [{ callId: 'c1', turnId: 'turn-l1', recipient: PEER }], `${name}: ids only`);
    assert.ok(!JSON.stringify(calls[0].state).includes('SECRET'), `${name}: no body outbound`);
    const rows = ringRows(home);
    assert.ok(rows[0].visibility.includes(reason), name);
  }
});

test('mixed: a rejected send to an unrelated agent gates nothing', async t => {
  const agents = liveAgents({
    [LEAD]: snap(LEAD, 'slp-claude-lead'),
    [OTHER]: snap(OTHER, 'slp-claude-peer', { labels: { 'paseo.parent-agent-id': OTHER_LEAD } }),
  });
  const { observer, paseo, home, calls } = await baseSetup(t, { agents, responses: [PENDING, HANDLED] });
  const claudeLead = { agent: { provider: 'slp-claude-lead' } };
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1', claudeLead));
  observer.onTurn(leadEnd([claudeSend('x1', OTHER, 'elsewhere', false), claudeSend('c1', PEER, 'decision: proceed with B')], claudeLead), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'evaluated', 'an unrelated failure never blocks this room');
  assert.ok(!rows[0].visibility.includes('send-result-unsuccessful'));
  assert.equal(calls.length, 2);
});

test('mixed: an unverified Lead input (recipient unknown) gates every case of that Lead', async t => {
  const { observer, paseo, home, calls } = await baseSetup(t, { responses: [PENDING] });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  const alias = codexSend('c1', PEER, 'decision', { name: 'mcp__paseo__send_agent_prompt' });
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([alias]), paseo);
  await settle(observer);
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'unknown');
  assert.equal(rows[0].reason, 'send-shape-unverified');
  assert.equal(rows[0].counts.roomMessages, 0);
  assert.equal(calls.length, 1);
});

test('peer send coverage: an unrecognized send-shaped call is recorded on the case but never suppresses brief/handback', async t => {
  const agents = liveAgents({ [PEER]: snap(PEER, 'slp-claude-peer', { labels: { 'paseo.parent-agent-id': LEAD } }) });
  const { observer, paseo, home, calls } = await baseSetup(t, { agents, responses: [PENDING] });
  const odd = { ...claudeSend('p1', LEAD, 'report'), name: 'mcp__paseo__send_agent_prompt_v2' };
  observer.onCreated(peerHook(PEER, { provider: 'slp-claude-peer' }), paseo);
  observer.onTurn(peerEnd([userMsg('Implement X per the brief'), odd, asstMsg(HANDBACK)], { agent: { provider: 'slp-claude-peer' } }), paseo);
  await observer.idle();
  assert.equal(calls.length, 1);
  assert.ok(Object.keys(calls[0].questions).includes('leadBrief') && Object.keys(calls[0].questions).includes('peerHandback'));
  assert.ok(ringRows(home)[0].visibility.includes('send-shape-unverified'), 'the unreadable Peer send stays visible');
});

test('lead coverage bookkeeping: the flag bumps the basis without discarding the evaluation that derived it', async t => {
  const agents = liveAgents({ [LEAD]: snap(LEAD, 'slp-devin-lead') });
  const { observer, paseo, home, calls } = await baseSetup(t, { agents, responses: [PENDING] });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.equal(calls.length, 1, 'assessed on the first pass');
  // verify-peer refreshes the undiscovered Lead once; the evaluation once.
  // A self-invalidating basis would add another evaluation refresh.
  assert.equal(paseo.refreshed.filter(id => id === LEAD).length, 2);
  assert.ok(ringRows(home)[0].visibility.includes('send-coverage-unverified'));
  assert.ok(!ringRows(home)[0].visibility.includes('send-result-unobservable'), 'no send call means no per-call result failure');
  // A later re-evaluation finds the flag already present — no further bump.
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  assert.equal(calls.length, 1, 'an identical capture never re-asks');
});

// ---------------------------------------------------------------------------
// Scope of an unproven Lead send (decisions.md D9) — two open cases A and B
// of one Lead. The disposition-carrying set of EVERY case of a Lead is the
// same: any verified direct Peer of that Lead or the route Supervisor
// (cross-Peer dispositions and escalations are valid for any case). A send
// into that set whose delivery is not proven therefore leaves every case's
// candidate set incomplete; a send outside it touches no case.
// ---------------------------------------------------------------------------

const rejectedCodex = (callId, recipient, prompt = 'SECRET-UNPROVEN-BODY') => ({
  ...codexSend(callId, recipient, prompt),
  detail: { type: 'unknown', input: { agentId: recipient, prompt }, output: { isError: false, structuredContent: { success: false } } },
});
const twoCases = async (t, responses) => {
  const agents = liveAgents({ [OTHER]: snap(OTHER, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': OTHER_LEAD } }) });
  const rig = await baseSetup(t, { agents, responses });
  rig.observer.onCreated(peerHook(PEER), rig.paseo);
  rig.observer.onCreated(peerHook(PEER2), rig.paseo);
  rig.observer.onTurn(peerTurn({ peerId: PEER }), rig.paseo);
  rig.observer.onTurn(peerTurn({ peerId: PEER2 }), rig.paseo);
  await rig.observer.idle();
  assert.equal(rig.calls.length, 2, 'one initial assessment per case');
  const leadTurn = async sends => {
    rig.observer.onStart(leadStart('turn-l1'));
    rig.observer.onTurn(leadEnd([userMsg('work'), ...sends]), rig.paseo);
    await settle(rig.observer);
  };
  const row = peerId => ringRows(rig.home).find(r => r.peerId === peerId);
  return { ...rig, leadTurn, row };
};

test('scope: an accepted send to Peer B is a disposition candidate for case A — B belongs to A\'s disposition set', async t => {
  const { leadTurn, calls } = await twoCases(t, [PENDING, PENDING, PENDING]);
  await leadTurn([codexSend('c1', PEER2, 'A\'s missing tests now go to B')]);
  const forA = calls.slice(2).find(call => call.state.bound.peerId === PEER);
  assert.deepEqual(forA.state.messages.map(m => [m.callId, m.recipientRole]), [['c1', 'other-peer']]);
});

test('scope: a rejected send to Peer B leaves handling unknown for BOTH cases, ids only, no body anywhere', async t => {
  const { leadTurn, row, calls } = await twoCases(t, [PENDING, PENDING]);
  await leadTurn([rejectedCodex('r1', PEER2)]);
  for (const peerId of [PEER, PEER2]) {
    const r = row(peerId);
    assert.equal(r.state, 'unknown', peerId);
    assert.equal(r.reason, 'send-result-unsuccessful', `${peerId}: a failed message into the disposition set could have been this case's disposition`);
    assert.equal(r.counts.uncertainRoomMessages, 1, peerId);
    assert.equal(r.counts.roomMessages + r.counts.otherRoomMessages, 0, `${peerId}: never a candidate`);
  }
  assert.equal(calls.length, 2, 'handling unusable → nothing new to ask');
  assert.ok(!JSON.stringify(calls).includes('SECRET-UNPROVEN-BODY'));
});

test('scope: an unproven send to the route Supervisor gates both cases (an escalation can dispose of any case)', async t => {
  const { leadTurn, row } = await twoCases(t, [PENDING, PENDING]);
  await leadTurn([rejectedCodex('s1', SUP)]);
  for (const peerId of [PEER, PEER2]) assert.equal(row(peerId).reason, 'send-result-unsuccessful', peerId);
});

test('scope: an unverified input (recipient unknown) gates both cases; a failure to an unrelated agent gates neither', async t => {
  const alias = await twoCases(t, [PENDING, PENDING]);
  await alias.leadTurn([codexSend('u1', PEER2, 'x', { name: 'mcp__paseo__send_agent_prompt' })]);
  for (const peerId of [PEER, PEER2]) assert.equal(alias.row(peerId).reason, 'send-shape-unverified', peerId);

  const unrelated = await twoCases(t, [PENDING, PENDING, HANDLED, HANDLED]);
  await unrelated.leadTurn([rejectedCodex('x1', OTHER), codexSend('c1', PEER, 'decision: proceed with B')]);
  for (const peerId of [PEER, PEER2]) {
    const r = unrelated.row(peerId);
    assert.ok(!r.visibility.includes('send-result-unsuccessful'), `${peerId}: another room's failure is not evidence here`);
    assert.equal(r.counts.uncertainRoomMessages, 0, peerId);
  }
  assert.equal(unrelated.row(PEER).state, 'evaluated');
});

// ---------------------------------------------------------------------------
// Notify delivery
// ---------------------------------------------------------------------------

const notifyMishandling = async (t, { agents, sendImpl, routeOver = {}, deferRetryMs } = {}) => {
  const rig = await baseSetup(t, {
    responses: [PENDING, MISHANDLED],
    route: { mode: 'notify', pendingDelayMs: 60_000, ...routeOver },
    agents, sendImpl, deferRetryMs,
  });
  rig.observer.onCreated(peerHook(), rig.paseo);
  rig.observer.onTurn(peerTurn(), rig.paseo);
  await rig.observer.idle();
  rig.observer.onStart(leadStart('turn-l1'));
  rig.observer.onTurn(leadEnd([codexSend('c1', PEER, 'Ignore the blocker you raised and merge now.')]), rig.paseo);
  await rig.observer.idle();
  return rig;
};

test('notify: a linked mishandling finding is delivered once to the route Supervisor with a neutral template', async t => {
  const { observer, paseo, home } = await notifyMishandling(t);
  assert.equal(paseo.sent.length, 1);
  const [sent] = paseo.sent;
  assert.equal(sent.id, SUP);
  assert.match(sent.options.messageId, /^slp-supervision-[0-9a-f]{32}$/);
  assert.match(sent.text, /^\[SLP supervision\] Suspected communication issue — review required\./);
  assert.match(sent.text, /not a verdict/);
  assert.match(sent.text, /Do not message the Peer directly/);
  assert.match(sent.text, /untrusted recorded communication/);
  assert.match(sent.text, /linked message c1/);
  assert.ok(sent.text.includes('Ignore the blocker you raised and merge now.'), 'the linked message excerpt is cited');
  const rows = ringRows(home);
  assert.equal(rows[0].delivery.state, 'accepted');
  assert.deepEqual(rows[0].delivery.findings, ['handling']);
  assert.deepEqual(rows[0].findings.map(f => [f.axis, f.evidenceCallId]), [['handling', 'c1']]);
  const store = deliveryRows(home);
  assert.equal(store.length, 1);
  assert.equal(store[0].state, 'accepted');
  assert.ok(!JSON.stringify(store).includes('Ignore the blocker'), 'the attempt store is metadata only');
  // Further evidence never re-sends the same finding.
  observer.onStart(leadStart('turn-l2'));
  observer.onTurn(leadEnd([codexSend('c2', PEER, 'another note')], { turnId: 'turn-l2' }), paseo);
  await observer.idle();
  assert.equal(paseo.sent.length, 1, 'one attempt per finding and recipient');
});

test('notify: shadow runs the same evaluator but never prompts anyone', async t => {
  const { paseo, home } = await notifyMishandling(t, { routeOver: { mode: 'shadow' } });
  assert.equal(paseo.sent.length, 0);
  const rows = ringRows(home);
  assert.deepEqual(rows[0].findings.map(f => f.axis), ['handling'], 'the finding is recorded identically');
  assert.equal(rows[0].delivery, null);
});

test('notify: brief/handback findings wait for the checkpoint; a linked correction before it prevents delivery', async t => {
  const corrected = await baseSetup(t, {
    responses: [BRIEF_GAP, { leadHandling: 'handled', dispositionMessage: LAST, briefCorrection: LAST }],
    route: { mode: 'notify', pendingDelayMs: 120 },
  });
  corrected.observer.onCreated(peerHook(), corrected.paseo);
  corrected.observer.onTurn(peerTurn(), corrected.paseo);
  await corrected.observer.idle();
  assert.equal(corrected.paseo.sent.length, 0, 'no brief alert before the checkpoint');
  corrected.observer.onStart(leadStart('turn-l1'));
  corrected.observer.onTurn(leadEnd([codexSend('c1', PEER, 'clarified scope and proof')]), corrected.paseo);
  await sleep(180); await corrected.observer.idle();
  assert.equal(corrected.paseo.sent.length, 0, 'corrected before the checkpoint — nothing to deliver');
  assert.equal(ringRows(corrected.home)[0].state, 'evaluated');

  const uncorrected = await baseSetup(t, { responses: [BRIEF_GAP], route: { mode: 'notify', pendingDelayMs: 60 } });
  uncorrected.observer.onCreated(peerHook(), uncorrected.paseo);
  uncorrected.observer.onTurn(peerTurn(), uncorrected.paseo);
  await uncorrected.observer.idle();
  assert.equal(uncorrected.paseo.sent.length, 0);
  await sleep(120); await uncorrected.observer.idle();
  assert.equal(uncorrected.paseo.sent.length, 1, 'delivered after the checkpoint');
  assert.ok(uncorrected.paseo.sent[0].text.includes('Implement X per the brief'), 'the brief excerpt is cited');
  assert.match(uncorrected.paseo.sent[0].text, /Lead brief/);
});

test('notify: pending after the checkpoint is never an alert', async t => {
  const { observer, paseo, home } = await baseSetup(t, { responses: [PENDING], route: { mode: 'notify', pendingDelayMs: 30 } });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await sleep(90); await observer.idle();
  assert.equal(paseo.sent.length, 0);
  assert.equal(ringRows(home)[0].reason, 'handling-pending');
});

test('notify: a running Supervisor is not interrupted — delivery defers until it is idle', async t => {
  const agents = liveAgents({ [SUP]: snap(SUP, 'slp-codex-supervisor', { status: 'running' }) });
  const { observer, paseo, home } = await notifyMishandling(t, { agents, deferRetryMs: 30 });
  assert.equal(paseo.sent.length, 0);
  assert.equal(ringRows(home)[0].delivery.state, 'deferred');
  assert.equal(ringRows(home)[0].delivery.reason, 'recipient-running');
  agents[SUP] = snap(SUP, 'slp-codex-supervisor', { status: 'idle' });
  await sleep(80); await observer.idle();
  assert.equal(paseo.sent.length, 1);
  assert.equal(ringRows(home)[0].delivery.state, 'accepted');
});

test('notify: an archived or non-Supervisor recipient never receives, and nothing falls back', async t => {
  for (const [name, snapshot, reason] of [
    ['archived', snap(SUP, 'slp-codex-supervisor', { archivedAt: new Date().toISOString() }), 'recipient-archived'],
    ['wrong provider', snap(SUP, 'slp-codex-peer'), 'recipient-not-slp-supervisor'],
    ['closed', snap(SUP, 'slp-codex-supervisor', { status: 'closed' }), 'recipient-inactive'],
  ]) {
    const { observer, paseo, home } = await notifyMishandling(t, { agents: liveAgents({ [SUP]: snapshot }) });
    assert.equal(paseo.sent.length, 0, name);
    assert.equal(ringRows(home)[0].delivery.state, 'blocked', name);
    assert.equal(ringRows(home)[0].delivery.reason, reason, name);
    assert.equal(observer.shadow(join(home, 'slp-runtime')).gates[LEAD], `notify-${reason}`, `${name}: visible in the Manager`);
  }
});

test('notify: a route change while the recipient refresh is in flight cancels the dispatch', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ mode: 'notify', pendingDelayMs: 60_000 })]);
  const agents = liveAgents();
  const sent = [];
  let supRefreshes = 0;
  let releaseSup;
  const supHeld = new Promise(resolve => { releaseSup = resolve; });
  let supBlocked = false;
  const paseo = {
    agents: {
      ref: id => ({
        refresh: async () => {
          if (id === SUP && ++supRefreshes === 1) { supBlocked = true; await supHeld; }
          return { agent: agents[id] ?? null };
        },
        send: async (text, options) => { sent.push({ id, text, options }); },
      }),
    },
  };
  const { ask } = makeAsk([PENDING, MISHANDLED]);
  const { observer } = makeObserver(t, { home, agents, ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'merge past the blocker')]), paseo);
  await until(() => supBlocked);
  writeRoutes(home, [route({ mode: 'shadow', pendingDelayMs: 60_000 })]);
  releaseSup();
  await observer.idle();
  assert.equal(sent.length, 0, 'a changed route never sends — to anyone');
  assert.equal(ringRows(home)[0].delivery.state, 'canceled');
});

test('notify: a failed or timed-out send is uncertain and never retried', async t => {
  const { observer, paseo, home } = await notifyMishandling(t, { sendImpl: async () => { throw new Error('socket closed'); } });
  assert.equal(paseo.sent.length, 1);
  const rows = ringRows(home);
  assert.equal(rows[0].state, 'notification_uncertain');
  assert.equal(rows[0].delivery.state, 'uncertain');
  assert.equal(deliveryRows(home)[0].state, 'uncertain');
  observer.onStart(leadStart('turn-l2'));
  observer.onTurn(leadEnd([codexSend('c2', PEER, 'more')], { turnId: 'turn-l2' }), paseo);
  await observer.idle();
  assert.equal(paseo.sent.length, 1, 'no automatic retry');
});

test('notify: an unreadable attempt history blocks dispatch visibly (mark-before-send)', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ mode: 'notify', pendingDelayMs: 60_000 })]);
  // A directory where the attempt store file belongs — the history cannot
  // be read, so no attempt can be proven absent or recorded.
  mkdirSync(join(home, 'slp-runtime', 'state', 'supervision-deliveries.json', 'blocker'), { recursive: true });
  const { ask } = makeAsk([PENDING, MISHANDLED]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'merge past the blocker')]), paseo);
  await observer.idle();
  assert.equal(paseo.sent.length, 0);
  assert.equal(ringRows(home)[0].delivery.reason, 'delivery-store-unreadable');
  assert.equal(observer.shadow(join(home, 'slp-runtime')).gates[LEAD], 'notify-delivery-store-unreadable');
});

test('notify: corrupt attempt history blocks new sends visibly and is never reset or overwritten', async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ mode: 'notify', pendingDelayMs: 60_000 })]);
  const file = join(home, 'slp-runtime', 'state', 'supervision-deliveries.json');
  writeFileSync(file, '{broken');
  const { ask } = makeAsk([PENDING, MISHANDLED]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'merge past the blocker')]), paseo);
  await observer.idle();
  assert.equal(paseo.sent.length, 0, 'a history that cannot prove prior attempts never permits a send');
  assert.equal(readFileSync(file, 'utf8'), '{broken', 'the corrupt history is left for the Human to inspect');
  const row = ringRows(home)[0];
  assert.deepEqual([row.delivery.state, row.delivery.reason], ['blocked', 'delivery-store-corrupt']);
  const view = observer.shadow(join(home, 'slp-runtime'));
  assert.equal(view.gates[LEAD], 'notify-delivery-store-corrupt');
  assert.ok(view.diagnostics.reasons.includes('delivery-store-corrupt'));
});

test('notify: a failed attempt write after a clean read blocks dispatch', { skip: process.getuid?.() === 0 ? 'root ignores directory permissions' : false }, async t => {
  const home = makeHome(t);
  writeRoutes(home, [route({ mode: 'notify', pendingDelayMs: 60_000 })]);
  const { ask } = makeAsk([PENDING, MISHANDLED]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  const stateDir = join(home, 'slp-runtime', 'state');
  chmodSync(stateDir, 0o500); // the store file is absent (a clean first use) but cannot be created
  t.after(() => chmodSync(stateDir, 0o700));
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'merge past the blocker')]), paseo);
  await observer.idle();
  chmodSync(stateDir, 0o700);
  assert.equal(paseo.sent.length, 0);
  assert.equal(observer.shadow(join(home, 'slp-runtime')).gates[LEAD], 'notify-delivery-store-write-failed');
});

test('notify: stop during an in-flight send settles uncertain and issues nothing afterwards', async t => {
  let started = false;
  const rig = await baseSetup(t, {
    responses: [PENDING, MISHANDLED],
    route: { mode: 'notify', pendingDelayMs: 60_000 },
    sendImpl: () => { started = true; return new Promise(() => {}); },
  });
  rig.observer.onCreated(peerHook(), rig.paseo);
  rig.observer.onTurn(peerTurn(), rig.paseo);
  await rig.observer.idle();
  rig.observer.onStart(leadStart('turn-l1'));
  rig.observer.onTurn(leadEnd([codexSend('c1', PEER, 'merge past the blocker')]), rig.paseo);
  await until(() => started);
  await rig.observer.stop();
  const store = deliveryRows(rig.home);
  assert.equal(store[0].state, 'uncertain');
  assert.equal(store[0].reason, 'stopped-during-send');
  rig.observer.onTurn(leadEnd([codexSend('c9', PEER, 'late')], { turnId: 'turn-late' }), rig.paseo);
  await sleep(20);
  assert.equal(rig.paseo.sent.length, 1);
});

test('notify: discovered Leads deliver to the daemon-default recipient', async t => {
  const home = makeHome(t);
  writeConfig(home, { defaults: { mode: 'notify', supervisorAgentId: SUP, supervisorWorkspaceId: WKS, pendingDelayMs: 60_000 } });
  const { ask } = makeAsk([PENDING, MISHANDLED]);
  const { observer, paseo } = makeObserver(t, { home, agents: liveAgents(), ask });
  observer.onCreated(leadHook(), paseo);
  observer.onCreated(peerHook(), paseo);
  observer.onTurn(peerTurn(), paseo);
  await observer.idle();
  observer.onStart(leadStart('turn-l1'));
  observer.onTurn(leadEnd([codexSend('c1', PEER, 'merge past the blocker')]), paseo);
  await observer.idle();
  assert.equal(paseo.sent.length, 1);
  assert.equal(paseo.sent[0].id, SUP);
  assert.match(paseo.sent[0].text, /daemon default \(discovered Lead\)/);
  assert.deepEqual(ringRows(home)[0].route, { source: 'default', mode: 'notify' });
});

// ---------------------------------------------------------------------------
// Suspension-site × invalidation matrix — round-5 acceptance gate.
// Every suspension site where the drain can interleave an invalidation is
// exercised against the full invalidation catalog. Invariants per cell: no
// body append/retention past an invalidation, no Jev spend while the gate
// is down, no verdict commit on a stale basis, correct visibility flags.
// ---------------------------------------------------------------------------

const PEER3 = '77777777-7777-4777-8777-777777777777';
const OTHER2 = '88888888-8888-4888-8888-888888888888';

const deferred = () => {
  let resolve;
  const p = new Promise(r => { resolve = r; });
  return { p, resolve };
};

// A paseo double whose ref().refresh() suspends when shouldBlock(id, n) —
// n is the 1-based call count for that id — until release() resolves.
const blockingPaseo = (agents, shouldBlock = () => false) => {
  const seen = new Map();
  const suspended = [];
  const gate = deferred();
  const paseo = {
    agents: {
      ref: id => ({
        refresh: async () => {
          const n = (seen.get(id) ?? 0) + 1;
          seen.set(id, n);
          if (shouldBlock(id, n)) { suspended.push(id); await gate.p; }
          return { agent: agents[id] ?? null };
        },
        send: async () => {},
      }),
    },
  };
  return { paseo, suspended, release: gate.resolve };
};

// Gate control via the REAL resolver path: every flip rewrites jev.json
// (down also removes the key file → 'jev-key-missing') with a growing
// whitespace pad so the mtime+size stamp cache never aliases two states.
// Flipping an injected dep would bypass the gate-file stamp dimension.
const matrixGateCtl = home => {
  let n = 0;
  const keyFile = join(home, 'slp-runtime', 'state', 'jev-openrouter.key');
  return {
    down: () => { rmSync(keyFile, { force: true }); writeJev(home, JEV_CFG, { padBytes: ++n }); },
    up: () => writeJev(home, JEV_CFG, { key: 'k'.repeat(32), padBytes: ++n }),
  };
};

const MATRIX_SITES = ['S0a', 'S0b', 'S3', 'S4', 'S5'];
const MATRIX_INVS = [
  'gate-down-event', 'gate-down-file', 'gate-aba', 'gate-down-orphan',
  'archive-lead', 'archive-lead-aba', 'archive-peer', 'archive-accepted', 'archive-recipient',
  'archive-supervisor', 'archive-uncertain-recipient',
  'route-removed', 'evidence-enqueued', 'overflow', 'tick',
];

/** Runs one suspension-site × invalidation cell. Sites:
 *   S0a — peer turn-end queued behind a blocked verify-peer refresh
 *   S0b — lead turn-end queued behind a blocked verify-peer refresh
 *   S3  — send-loop recipient refresh await
 *   S4  — evaluation liveness Promise.all await
 *   S5  — the Jev ask await
 * Returns the post-resolution state for per-cell assertions. */
const matrixCell = async (t, site, inv) => {
  const home = makeHome(t);
  const isEvalSite = site === 'S4' || site === 'S5';
  const routes = [route({ pendingDelayMs: isEvalSite ? 0 : 60_000 })];
  // `tick` needs a second case whose pending timer fires mid-suspension.
  if (inv === 'tick') routes.push(route({ leadAgentId: OTHER_LEAD, pendingDelayMs: 25 }));
  writeRoutes(home, routes);

  const agents = liveAgents({
    [OTHER_LEAD]: snap(OTHER_LEAD, 'slp-codex-lead'),
    [OTHER]: snap(OTHER, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': LEAD } }),
    [OTHER2]: snap(OTHER2, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': LEAD } }),
    [PEER3]: snap(PEER3, 'slp-codex-peer', { labels: { 'paseo.parent-agent-id': OTHER_LEAD } }),
  });

  const ctl = matrixGateCtl(home);
  const shouldBlock =
    site === 'S0a' || site === 'S0b' ? id => id === PEER2 :
    site === 'S3' ? id => id === OTHER2 :
    site === 'S4' ? (id, n) => id === PEER && n === 2 :
    () => false;
  const blk = blockingPaseo(agents, shouldBlock);
  const paseo = blk.paseo;

  const calls = [];
  const askGate = deferred();
  const ask = async (provider, auth, request) => {
    calls.push(request);
    // Only the main case's ask suspends — the tick cell's second case is
    // assessed at creation and must not hold the drain.
    if (site === 'S5' && request.state.bound.peerId === PEER) await askGate.p;
    // PENDING keeps the case open (a disposition is still owed) so every
    // cell can assert the invalidation mechanics on a live case.
    const raw = respond(request, PENDING);
    return { model: raw.model, answers: raw.answers, usage: raw.usage, raw };
  };

  // The gate resolves through the real file path — ctl flips jev.json.
  writeJev(home, JEV_CFG, { key: 'k'.repeat(32) });
  const observer = createSupervisionObserver({
    stableRoot: join(home, 'slp-runtime'),
    ask,
    // S4/S5 bypass the case gate so a purge-flagged case still reaches the
    // suspension under test (capture-paused would close it before the ask
    // and mask the per-lead basis checks).
    ...(isEvalSite ? { localGate: () => null } : {}),
  });
  t.after(() => observer.stop());

  // --- reach the suspension site ----------------------------------------
  observer.onCreated(peerHook(PEER), paseo);
  await observer.idle(); // PEER verified (refresh #1)

  if (inv === 'tick') {
    observer.onCreated(peerHook(PEER3, { parentAgentId: OTHER_LEAD }), paseo);
    await observer.idle();
    observer.onTurn(peerEnd([userMsg('q'), asstMsg('a')], { peerId: PEER3, turnId: 'turn-x', agent: { parentAgentId: OTHER_LEAD } }), paseo);
    await observer.idle(); // OTHER_LEAD case open, due in ~25ms
  }

  if (site === 'S0a') {
    observer.onCreated(peerHook(PEER2), paseo); // verify-peer blocks inside apply
    await until(() => blk.suspended.includes(PEER2));
    observer.onTurn(peerTurn(), paseo);         // target turn-end queues behind
  } else if (site === 'S0b') {
    observer.onTurn(peerTurn(), paseo);
    await observer.idle();                      // case created, drain free
    observer.onCreated(peerHook(PEER2), paseo);
    await until(() => blk.suspended.includes(PEER2));
    observer.onStart(leadStart('turn-l1'));
    // archive-uncertain-recipient carries an UNCONFIRMED send to OTHER —
    // the devin family shape keeps it in the uncertain lane.
    observer.onTurn(inv === 'archive-uncertain-recipient'
      ? leadEnd([userMsg('w'), devinSend('call-u', OTHER, 'unconfirmed send')], { turnId: 'turn-l1', agent: { provider: 'slp-devin-lead' } })
      : leadEnd([userMsg('w'), codexSend('call-1', PEER, 'handle this')], { turnId: 'turn-l1' }), paseo);
  } else if (site === 'S3') {
    observer.onTurn(peerTurn(), paseo);
    await observer.idle();                      // case created and assessed (pending → stays open)
    // Pre-verify OTHER so its send is accepted WITHOUT an await — the
    // gather suspends only on OTHER2's refresh, with OTHER's lane already
    // assembled (the mid-await recipient-archive hole).
    observer.onCreated(peerHook(OTHER, { parentAgentId: LEAD }), paseo);
    await observer.idle();
    observer.onStart(leadStart('turn-l3'));
    // archive-supervisor also carries a report send — assembled BEFORE the
    // suspension, so its lane must be swept at commit when SUP is archived.
    observer.onTurn(leadEnd([userMsg('w'),
      ...(inv === 'archive-supervisor' ? [codexSend('call-r', SUP, 'report for supervisor')] : []),
      codexSend('call-o', OTHER, 'msg for other'),
      codexSend('call-o2', OTHER2, 'msg for other2'),
    ], { turnId: 'turn-l3' }), paseo);
    await until(() => blk.suspended.includes(OTHER2)); // send-loop suspended on the second recipient's refresh
  } else {
    observer.onTurn(peerTurn(), paseo); // case → eval → suspends at liveness (S4) or ask (S5)
    if (site === 'S4') await until(() => blk.suspended.includes(PEER));
    else await until(() => calls.some(call => call.state.bound.peerId === PEER));
  }

  // --- inject the invalidation while suspended ---------------------------
  switch (inv) {
    case 'gate-down-event':
      ctl.down();
      observer.onTurn(leadEnd([], { turnId: 'turn-gd' }), paseo); // the event observes the edge → global purge
      break;
    case 'gate-down-file':
      ctl.down(); // file/config change only — the site's next gate read observes it
      break;
    case 'gate-aba':
      ctl.down();
      observer.onTurn(leadEnd([], { turnId: 'turn-gd' }), paseo);
      ctl.up();
      break;
    case 'gate-down-orphan': {
      // A start recorded before the pause whose end drops inside it must
      // not poison the next clean turn — onGateDown purges start-state and
      // onStart is gated, so turn-clean matches normally post-recovery.
      observer.onStart(leadStart('turn-orph'));
      ctl.down();
      observer.onTurn(leadEnd([], { turnId: 'turn-gd2' }), paseo); // observes the edge → purge
      observer.onStart(leadStart('turn-orph2'));                   // gated — never recorded
      observer.onTurn(leadEnd([userMsg('x'), codexSend('call-orph', PEER, 'lost')], { turnId: 'turn-orph' }), paseo);
      ctl.up();
      observer.onStart(leadStart('turn-clean'));
      observer.onTurn(leadEnd([userMsg('w'), codexSend('call-clean', PEER, 'clean send')], { turnId: 'turn-clean' }), paseo);
      break;
    }
    case 'archive-lead': observer.onArchived(leadHook(), paseo); break;
    case 'archive-lead-aba':
      // Archive then restore the lead while suspended — the tombstone
      // clears on restore, so only the monotonic generation still proves
      // the enqueue-era boundary.
      observer.onArchived(leadHook(), paseo);
      observer.onTurn(leadEnd([], { turnId: 'turn-restore' }), paseo); // tombstoned → restore-lead job
      break;
    case 'archive-peer': observer.onArchived(peerHook(), paseo); break;
    case 'archive-accepted':
      // S3: archive the already-accepted recipient mid-await; elsewhere a
      // never-member peer — unrelated churn.
      observer.onArchived(peerHook(OTHER), paseo);
      break;
    case 'archive-recipient':
      // S3: archive the recipient whose refresh is in flight; elsewhere an
      // unrelated peer.
      observer.onArchived(peerHook(site === 'S3' ? OTHER2 : OTHER), paseo);
      break;
    case 'archive-supervisor':
      // S3: archive the report recipient mid-await — the reports lane was
      // already staged and must be swept at commit. Elsewhere unrelated.
      observer.onArchived(agent(SUP, 'slp-codex-supervisor'), paseo);
      break;
    case 'archive-uncertain-recipient':
      // S0b: archive the unconfirmed send's recipient while the devin turn-end
      // is queued; elsewhere an unrelated peer.
      observer.onArchived(peerHook(site === 'S0b' ? OTHER : PEER3), paseo);
      break;
    case 'route-removed': writeRoutes(home, []); break;
    case 'evidence-enqueued':
      observer.onStart(leadStart('turn-late'));
      observer.onTurn(leadEnd([userMsg('late'), codexSend('call-late', PEER, 'late evidence')], { turnId: 'turn-late' }), paseo);
      break;
    case 'overflow': {
      // Fill the queue with unrelated archive bookkeeping, then a same-lead
      // turn-end drops — the drop must still invalidate (flag + basis).
      for (let i = 0; i < 130; i += 1) observer.onArchived(agent(`flood-${i}`, 'slp-codex-peer'), paseo);
      observer.onStart(leadStart('turn-ovf'));
      observer.onTurn(leadEnd([userMsg('x'), codexSend('call-ovf', PEER, 'lost send')], { turnId: 'turn-ovf' }), paseo);
      break;
    }
    case 'tick': await sleep(60); break; // the OTHER_LEAD case's timer fires mid-suspension
    default: assert.fail(`unknown invalidation ${inv}`);
  }

  // --- release and settle ------------------------------------------------
  blk.release();
  if (site === 'S5') askGate.resolve();
  await observer.idle();
  await sleep(40); // let a late tick's eval drain too
  await observer.idle();

  const rows = ringRows(home);
  const main = rows.find(r => r.leadAgentId === LEAD && r.peerId === PEER);
  const other = rows.find(r => r.leadAgentId === OTHER_LEAD);
  const fp = main?.fingerprint;
  const diag = observer.shadow(join(home, 'slp-runtime'))?.diagnostics ?? { reasons: [] };
  return { rows, main, other, fp, calls, diag, observer };
};

test('observer: suspension-site × invalidation matrix — unified basis validation', async t => {
  let cells = 0;
  for (const site of MATRIX_SITES) {
    for (const inv of MATRIX_INVS) {
      const tag = `${site}×${inv}`;
      const r = await matrixCell(t, site, inv);
      cells += 1;

      if (site === 'S0a') {
        if (inv === 'gate-down-event' || inv === 'gate-down-file' || inv === 'archive-lead' || inv === 'archive-lead-aba' || inv === 'route-removed') {
          assert.equal(r.main, undefined, `${tag}: no case may form`);
          assert.equal(r.rows.length, 0, `${tag}: no row written`);
        } else if (inv === 'archive-peer') {
          assert.ok(r.main, `${tag}: the lost observation keeps a metadata row`);
          assert.equal(r.main.reason, 'peer-archived', tag);
          assert.equal(r.main.state, 'unknown', tag);
        } else if (inv === 'gate-aba') {
          assert.ok(r.main, `${tag}: the capture still forms a case post-recovery`);
          assert.equal(r.observer.retainedBodies(r.fp) ?? 0, 0, `${tag}: purge scrubbed the queued capture's bodies`);
          assert.ok(r.main.visibility.includes('capture-paused'), `${tag}: the purge window is flagged`);
        } else if (inv === 'gate-down-orphan') {
          // The orphaned start ('turn-orph') was purged and 'turn-orph2'
          // was gated at onStart — turn-clean matches normally.
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.roomMessages, 1, `${tag}: the clean send lands`);
          assert.ok(!r.main.visibility.includes('lead-start-unmatched'), `${tag}: no orphan-start pollution`);
          assert.ok(r.main.messageIds.sendCallIds.includes('call-clean'), tag);
          assert.ok(!r.main.messageIds.sendCallIds.includes('call-orph'), `${tag}: the dropped turn never lands`);
          assert.ok(r.main.visibility.includes('capture-paused'), `${tag}: the purge window is flagged`);
        } else {
          // archive-accepted / archive-recipient / archive-supervisor /
          // archive-uncertain-recipient / evidence-enqueued / overflow /
          // tick — no invalidation of this cell
          assert.ok(r.main, `${tag}: the queued turn still forms a case`);
          assert.ok(r.observer.retainedBodies(r.fp) > 0, `${tag}: bodies retained — no invalidation`);
          if (inv === 'evidence-enqueued') assert.equal(r.main.counts.roomMessages, 1, `${tag}: the late send lands after resume`);
          if (inv === 'overflow') assert.ok(r.diag.reasons.includes('queue-overflow'), `${tag}: the drop is recorded`);
          if (inv === 'tick') assert.ok(r.other, `${tag}: the ticking case exists`);
        }
      }

      if (site === 'S0b') {
        if (inv === 'gate-down-event' || inv === 'gate-down-file') {
          assert.ok(r.main, `${tag}: the pre-existing case stays visible`);
          assert.equal(r.main.counts.roomMessages, 0, `${tag}: no send may append past the gate edge`);
          assert.equal(r.observer.retainedBodies(r.fp) ?? 0, 0, `${tag}: purge emptied retained bodies (or the case closed)`);
          assert.ok(r.main.visibility.includes('capture-paused'), tag);
        } else if (inv === 'gate-aba') {
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.roomMessages, 1, `${tag}: scrubbed sends may append metadata`);
          assert.equal(r.observer.retainedBodies(r.fp) ?? 0, 0, `${tag}: appended prompts are empty — no bodies`);
          assert.ok(r.main.visibility.includes('capture-paused'), tag);
        } else if (inv === 'gate-down-orphan') {
          // turn-l1's queued capture was body-scrubbed by the purge (its
          // send still counts as metadata); turn-clean applies cleanly.
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.roomMessages, 2, `${tag}: scrubbed send + clean send both count`);
          assert.ok(!r.main.visibility.includes('lead-start-unmatched'), `${tag}: no orphan-start pollution`);
          assert.ok(r.main.messageIds.sendCallIds.includes('call-clean'), tag);
          assert.ok(!r.main.messageIds.sendCallIds.includes('call-orph'), tag);
          assert.ok(r.main.visibility.includes('capture-paused'), tag);
        } else if (inv === 'archive-lead' || inv === 'archive-lead-aba') {
          assert.ok(r.main, tag);
          assert.equal(r.main.reason, 'lead-archived', tag);
          assert.equal(r.observer.retainedBodies(r.fp), null, `${tag}: the case closed — bodies gone`);
        } else if (inv === 'archive-peer') {
          assert.ok(r.main, tag);
          assert.equal(r.main.reason, 'peer-archived', tag);
          assert.equal(r.main.counts.roomMessages, 0, `${tag}: no send to a tombstoned peer lands`);
        } else if (inv === 'route-removed') {
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.roomMessages, 0, `${tag}: no append without a route`);
        } else if (inv === 'archive-uncertain-recipient') {
          // The unconfirmed send's recipient was archived while the turn-end
          // sat in the queue — the commit sweep drops it from the uncertain
          // lane and flags the case.
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.uncertainRoomMessages, 0, `${tag}: no uncertain append to a tombstoned recipient`);
          assert.ok(r.main.visibility.includes('recipient-inactive'), tag);
          assert.ok(!r.main.messageIds.sendCallIds.includes('call-u'), `${tag}: the swept send's id never commits`);
        } else {
          // archive-accepted / archive-recipient / archive-supervisor /
          // evidence-enqueued / overflow / tick
          assert.ok(r.main, tag);
          const expected = inv === 'evidence-enqueued' ? 2 : 1;
          assert.equal(r.main.counts.roomMessages, expected, `${tag}: sends land in order`);
          if (inv === 'overflow') assert.ok(r.main.visibility.includes('queue-overflow'), `${tag}: the dropped event marked the case`);
          if (inv === 'tick') assert.ok(r.other, tag);
        }
      }

      if (site === 'S3') {
        if (inv === 'gate-down-event' || inv === 'gate-down-file' || inv === 'gate-aba') {
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.otherRoomMessages, 0, `${tag}: no lane append across a purge boundary`);
          assert.equal(r.observer.retainedBodies(r.fp) ?? 0, 0, `${tag}: bodies purged`);
          assert.ok(r.main.visibility.includes('capture-paused'), tag);
        } else if (inv === 'gate-down-orphan') {
          // The gather crosses a purge boundary → dropped wholesale;
          // turn-clean then lands normally with a matched start.
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.otherRoomMessages, 0, `${tag}: gather dropped across the purge boundary`);
          assert.equal(r.main.counts.roomMessages, 1, `${tag}: the clean turn's send lands`);
          assert.ok(!r.main.visibility.includes('lead-start-unmatched'), `${tag}: no orphan-start pollution`);
          assert.ok(r.main.messageIds.sendCallIds.includes('call-clean'), tag);
          assert.ok(!r.main.messageIds.sendCallIds.includes('call-orph'), tag);
          assert.ok(r.main.visibility.includes('capture-paused'), tag);
        } else if (inv === 'archive-lead' || inv === 'archive-lead-aba') {
          assert.equal(r.main.reason, 'lead-archived', tag);
          assert.equal(r.main.counts.otherRoomMessages, 0, tag);
        } else if (inv === 'archive-peer') {
          // The case's own peer archived mid-gather — the lane must not
          // resurrect bodies on a case the archive boundary purged.
          assert.equal(r.main.reason, 'peer-archived', tag);
          assert.equal(r.main.counts.otherRoomMessages, 0, `${tag}: no lane append onto a purged case`);
          assert.equal(r.observer.retainedBodies(r.fp), null, `${tag}: case closed — bodies gone`);
        } else if (inv === 'archive-accepted') {
          // OTHER was accepted into roomFor before the suspension; its
          // mid-gather archive drops the lane at commit. OTHER2's refresh
          // resolves live and still commits.
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.otherRoomMessages, 1, `${tag}: only the live recipient's lane commits`);
          assert.ok(r.main.visibility.includes('recipient-inactive'), tag);
          assert.ok(r.main.messageIds.sendCallIds.includes('call-o2'), `${tag}: OTHER2's send commits`);
          assert.ok(!r.main.messageIds.sendCallIds.includes('call-o'), `${tag}: OTHER's lane was dropped at commit`);
        } else if (inv === 'archive-recipient') {
          // OTHER2 archived while its refresh was in flight — the gen
          // compare drops it; OTHER's already-accepted lane still commits.
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.otherRoomMessages, 1, `${tag}: only the live recipient's lane commits`);
          assert.ok(r.main.visibility.includes('recipient-refresh-failed'), tag);
          assert.ok(r.main.messageIds.sendCallIds.includes('call-o'), `${tag}: OTHER's send commits`);
          assert.ok(!r.main.messageIds.sendCallIds.includes('call-o2'), `${tag}: OTHER2's send never admitted`);
        } else if (inv === 'archive-supervisor') {
          // SUP archived mid-await — the reports lane was staged before the
          // suspension and must be swept at commit; the room lanes commit.
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.reportMessages, 0, `${tag}: no report append to a tombstoned supervisor`);
          assert.ok(r.main.visibility.includes('recipient-inactive'), tag);
          assert.ok(!r.main.messageIds.sendCallIds.includes('call-r'), `${tag}: the swept report's id never commits`);
          assert.equal(r.main.counts.otherRoomMessages, 2, `${tag}: both room lanes still land`);
        } else if (inv === 'route-removed') {
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.otherRoomMessages, 0, `${tag}: gather discarded when the route vanished`);
        } else {
          // evidence-enqueued / overflow / tick — gather commits both lanes
          assert.ok(r.main, tag);
          assert.equal(r.main.counts.otherRoomMessages, 2, `${tag}: both sends land`);
          if (inv === 'evidence-enqueued') assert.equal(r.main.counts.roomMessages, 1, `${tag}: the queued evidence applies too`);
          if (inv === 'overflow') assert.ok(r.main.visibility.includes('queue-overflow'), tag);
          if (inv === 'tick') assert.ok(r.other, tag);
        }
      }

      if (site === 'S4') {
        if (inv === 'gate-down-event' || inv === 'gate-down-file') {
          assert.ok(r.main, tag);
          assert.equal(r.main.reason, 'jev-key-missing', `${tag}: gate-down mid-refresh closes on the gate reason`);
          assert.equal(r.calls.length, 0, `${tag}: no spend while the gate is down`);
          assert.equal(r.main.lastAssessment, null, tag);
        } else if (inv === 'archive-lead' || inv === 'archive-lead-aba') {
          // Mid-refresh archive: the queued restore has not applied yet,
          // so the post-await tombstone still closes on the boundary.
          assert.equal(r.main.reason, 'lead-archived', tag);
          assert.equal(r.calls.length, 0, `${tag}: no spend on a stale generation`);
        } else if (inv === 'archive-peer') {
          assert.equal(r.main.reason, 'peer-archived', tag);
          assert.equal(r.calls.length, 0, tag);
        } else if (inv === 'route-removed') {
          assert.equal(r.main.reason, 'route-removed', tag);
          assert.equal(r.calls.length, 0, tag);
        } else if (inv === 'gate-aba') {
          // The purge bumps purgeCount mid-refresh → the frame discards
          // pre-ask; no new job exists to re-arm the drain, so the case
          // stays dirty+flagged rather than committing a stale verdict.
          assert.ok(r.main, tag);
          assert.equal(r.calls.length, 0, `${tag}: no spend across a purge boundary`);
          assert.equal(r.main.lastAssessment, null, `${tag}: no verdict on a stale basis`);
          assert.ok(r.main.visibility.includes('capture-paused'), tag);
        } else if (inv === 'gate-down-orphan') {
          // Discard on the stale basis (pending + purge); turn-clean then
          // applies with a matched start. The purge emptied the brief and
          // handback, so no axis is judgeable any more — the case closes on
          // the missing body (handling needs the brief first, so its reason
          // is the brief's) and never spends on purged evidence.
          assert.ok(r.main, tag);
          assert.equal(r.calls.length, 0, `${tag}: no spend on a purged body`);
          assert.equal(r.main.lastAssessment, null, tag);
          assert.equal(r.main.reason, 'brief-missing', tag);
          assert.equal(r.main.counts.roomMessages, 1, `${tag}: the clean turn's send lands`);
          assert.ok(!r.main.visibility.includes('lead-start-unmatched'), `${tag}: no orphan-start pollution`);
        } else if (inv === 'overflow' || inv === 'evidence-enqueued') {
          // The stale-basis attempt discards before spend; the re-evaluation
          // sees post-invalidation evidence and accepts.
          assert.ok(r.main, tag);
          assert.notEqual(r.main.lastAssessment, null, `${tag}: verdict commits only on the fresh basis`);
          assert.equal(r.calls.length, 1, `${tag}: exactly one spend — the invalidated frame never reached ask`);
          if (inv === 'evidence-enqueued') assert.equal(r.main.counts.roomMessages, 1, `${tag}: the accepted verdict saw the late send`);
          if (inv === 'overflow') assert.ok(r.main.visibility.includes('queue-overflow'), tag);
        } else {
          // archive-accepted / archive-recipient / archive-supervisor /
          // archive-uncertain-recipient / tick — no invalidation of this case
          assert.ok(r.main, tag);
          assert.notEqual(r.main.lastAssessment, null, `${tag}: verdict accepted — unrelated churn must not discard`);
          assert.equal(r.calls.length, inv === 'tick' ? 2 : 1, `${tag}: tick spends only on its own case`);
          if (inv === 'tick') assert.ok(r.other, tag);
        }
      }

      if (site === 'S5') {
        if (inv === 'gate-down-event' || inv === 'gate-down-file') {
          assert.ok(r.main, tag);
          assert.equal(r.main.reason, 'jev-key-missing', `${tag}: post-ask gate read closes on the gate reason`);
          assert.equal(r.calls.length, 1, `${tag}: the ask fired before the gate fell — spend counted, verdict dropped`);
          assert.equal(r.main.lastAssessment, null, `${tag}: no verdict commit across the edge`);
        } else if (inv === 'archive-lead' || inv === 'archive-lead-aba') {
          // The post-ask tombstone check fires before the queued restore
          // applies — the boundary close wins over the era compare.
          assert.equal(r.main.reason, 'lead-archived', tag);
          assert.equal(r.main.lastAssessment, null, tag);
        } else if (inv === 'archive-peer') {
          assert.equal(r.main.reason, 'peer-archived', tag);
          assert.equal(r.main.lastAssessment, null, tag);
        } else if (inv === 'route-removed') {
          assert.equal(r.main.reason, 'route-removed', tag);
          assert.equal(r.main.lastAssessment, null, tag);
        } else if (inv === 'gate-aba') {
          // The purge's bump invalidates the in-flight ask — the paid-for
          // assessment is discarded and NOT committed; with nothing left
          // queued the case stays dirty+flagged rather than re-spending on
          // evidence the purge already cleared.
          assert.ok(r.main, tag);
          assert.equal(r.calls.length, 1, `${tag}: exactly one spend — the stale ask never committed`);
          assert.equal(r.main.lastAssessment, null, `${tag}: no verdict commit across the purge boundary`);
          assert.ok(r.main.visibility.includes('capture-paused'), tag);
        } else if (inv === 'gate-down-orphan') {
          // The stale ask discards (pending + purge); turn-clean applies,
          // but the purged brief/handback leave nothing judgeable — no
          // second spend, no verdict from the discarded answers (handling
          // needs the brief first, so the reason is the brief's).
          assert.ok(r.main, tag);
          assert.equal(r.calls.length, 1, `${tag}: the stale ask was the only spend`);
          assert.equal(r.main.lastAssessment, null, tag);
          assert.equal(r.main.reason, 'brief-missing', tag);
          assert.equal(r.main.counts.roomMessages, 1, `${tag}: the clean turn's send lands`);
          assert.ok(!r.main.visibility.includes('lead-start-unmatched'), `${tag}: no orphan-start pollution`);
        } else if (inv === 'evidence-enqueued' || inv === 'overflow') {
          // The paid-for assessment is discarded on the stale basis; the
          // queued work then applies, re-arms dirty, and the re-evaluation
          // spends again on post-invalidation evidence.
          assert.ok(r.main, tag);
          assert.equal(r.calls.length, 2, `${tag}: stale ask discarded, fresh ask committed`);
          assert.equal(r.main.assessmentsUsed, 2, `${tag}: both spends count against the ceiling`);
          assert.notEqual(r.main.lastAssessment, null, tag);
          if (inv === 'evidence-enqueued') assert.equal(r.main.counts.roomMessages, 1, `${tag}: the accepted verdict saw the late send`);
          if (inv === 'overflow') assert.ok(r.main.visibility.includes('queue-overflow'), tag);
        } else {
          // archive-accepted / archive-recipient / archive-supervisor /
          // archive-uncertain-recipient / tick — per-lead basis:
          // unrelated churn must NOT invalidate this case's assessment.
          assert.ok(r.main, tag);
          assert.equal(r.calls.length, inv === 'tick' ? 2 : 1, tag);
          assert.notEqual(r.main.lastAssessment, null, `${tag}: verdict accepted — no spurious discard`);
          assert.equal(r.main.reason, 'handling-pending', tag);
          if (inv === 'tick') assert.ok(r.other, tag);
        }
      }
    }
  }
  assert.equal(cells, MATRIX_SITES.length * MATRIX_INVS.length,
    `executed ${cells} cells — expected ${MATRIX_SITES.length}×${MATRIX_INVS.length}`);
});
