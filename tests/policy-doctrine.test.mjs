import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scenarios } from '../e2e/scenarios.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');

test('Lead implementation ownership stays with Peer Engineers across doctrine and dogfood docs', () => {
  const lead = read('src/roles/lead.md');
  const template = read('src/templates/workspace-protocol.md');
  const surfaces = [
    ['src/roles/lead.md', lead],
    ['src/templates/workspace-protocol.md', template],
    ['.paseo-slp/workspace-protocol.md', read('.paseo-slp/workspace-protocol.md')],
    ['docs/review-checklist.md', read('docs/review-checklist.md')],
    ['docs/architecture.md', read('docs/architecture.md')],
    ['e2e/workspace-protocol.md', read('e2e/workspace-protocol.md')],
  ];
  const staleAllowances = [
    /Lead may implement\b/i,
    /Lead can implement\b/i,
    /Lead directly if protocol permits/i,
    /or Lead for permitted tiny work/i,
    /not a global prohibition on Lead direct work/i,
    /Lead self-work/i,
  ];

  assert.match(lead, /Lead frames, inspects\s+and verifies, but does not implement\./i);
  assert.match(template, /every implementation write\s+belongs to a Peer/i);
  for (const [name, contents] of surfaces) {
    for (const allowance of staleAllowances) {
      assert.doesNotMatch(contents, allowance, `${name} retains ${allowance}`);
    }
  }
});

test('premise-reopen scenario repeats the seeded false premise across every Peer family', () => {
  const variants = scenarios.filter(item => item.id.startsWith('premise-reopen-'));
  assert.deepEqual(variants.map(item => item.providerFamily).sort(), ['claude', 'codex', 'devin', 'pi']);
  for (const scenario of variants) {
    assert.equal(scenario.repetitions, 2);
    assert.equal(scenario.runtimeSource, 'profiles-and-peer-pool');
    assert.match(scenario.trigger, /false premise/i);
    assert.match(scenario.trigger, /TASK\.md/);
    assert.match(scenario.trigger, /REOPEN_REQUEST/);
    assert.match(scenario.assertions[0], /Before writing, Peer returns REOPEN_REQUEST/);
    assert.match(scenario.assertions[1], /Lead checks the same evidence.*corrected premise/s);
  }
});

test('direct-Lead dogfood assigns implementation to a Peer', () => {
  const scenario = scenarios.find(item => item.id === 'direct-codex');
  assert.ok(scenario, 'scenario manifest contains direct-codex');
  assert.match(scenario.trigger, /Peer Engineer as implementation owner/);
  assert.match(scenario.assertions.join(' '), /Peer supplies proof/);
});

test('Lead context handoff trigger uses the single governance state checklist', () => {
  const lead = read('src/roles/lead.md');
  const governance = read('src/references/governance.md');
  const template = read('src/templates/workspace-protocol.md');
  const guide = read('docs/reports/guide-coverage.md');

  assert.match(lead, /When context loss or degradation makes task decisions or evidence unreliable to\s+recover, propose an authorized handoff without a numeric compaction threshold/);
  for (const field of ['objective and scope', 'handoff reason', 'accepted and rejected decisions with reasons',
    'evidence and candidate/review state', 'rejected alternatives', 'dependencies, owner IDs and readiness',
    'next action', 'notebook/checkpoint', 'resource and wake owner IDs with receipts', 'unknowns/limits']) {
    assert.match(governance, new RegExp(field.replaceAll(' ', '\\s+')), `governance includes ${field}`);
  }
  assert.match(governance, /do not define a\s+schema for `handoff\.state`/);
  assert.match(template, /using the state fields in installed governance rules/);
  assert.doesNotMatch(template, /accepted and rejected decisions with reasons|evidence and candidate\/review state|resource and wake owner IDs with receipts/);
  assert.match(guide, /\| H15 \|.*lastUsage\.contextWindowUsedTokens=.*lastUsage\.contextWindowMaxTokens=/);
  assert.match(guide, /No verified compaction count, usage trend, degradation event or host threshold/);
});

test('bounded task settlement waits for Delivery and open correction or re-review closure', () => {
  const orchestration = read('src/references/orchestration.md');
  const monitoring = read('src/references/monitoring.md');
  const template = read('src/templates/workspace-protocol.md');
  const protocol = read('.paseo-slp/workspace-protocol.md');

  for (const [name, body] of [['orchestration', orchestration], ['monitoring', monitoring], ['template', template], ['protocol', protocol]]) {
    assert.match(body, /Delivery\s+completes/iu, `${name} names Delivery completion`);
    assert.match(body, /no\s+correction or re-review remains open/iu, `${name} waits for rework closure`);
  }
  assert.match(orchestration, /same\s+Engineer and independent review seats for open rework/);
  assert.match(monitoring, /Keep the same Engineer and independent review\s+seats available while that task has rework/);
  assert.match(template, /Keep the same Engineer and\s+independent review seats available for correction or re-review/);
  assert.match(template, /Settlement does not\s+itself archive, kill or reparent sessions/);
  assert.doesNotMatch(template, /assignment that formed the team closes|batch archive/i);
  assert.match(protocol, /Accepted seats stay idle\s+for correction or re-review in that bounded task/);
  assert.match(protocol, /settlement does not itself\s+archive, kill or reparent sessions/);
  assert.doesNotMatch(protocol, /assignment that formed the team settles|team's assignment settles/i);
});

test('Jev routing procedure is conditional and unreadable mode fails closed', () => {
  const jev = read('src/references/jev-routing.md');
  const provider = read('src/references/provider-routing.md');
  const execution = read('src/references/delegation-execution.md');
  const onboarding = read('skills/paseo-slp-onboarding/references/peer-pool.md');
  const template = read('src/templates/workspace-protocol.md');

  assert.ok(jev.length > 0, 'the installed src/references Jev target exists');
  assert.match(jev, /jevRouting\.routing` set to\s+`shadow`, `armed` or `error`/);
  assert.match(jev, /Do not read it for `unconfigured` or `off`/);
  assert.match(jev, /`error` means the configured state is unreadable: block the dependent routing branch/);
  assert.match(jev, /Shadow evaluation is the gate before arming/);
  assert.match(provider, /references\/jev-routing\.md/);
  const conditionalJevPointer = /When `routes` reports\s+`jevRouting\.routing` as\s+`shadow`, `armed` or\s+`error`, read `references\/jev-routing\.md`; skip it for `unconfigured` or\s+`off`\. `error` blocks the dependent routing branch\./;
  assert.match(execution, conditionalJevPointer);
  const onboardingJevPointer = /When `routes` reports\s+`jevRouting\.routing` as\s+`shadow`, `armed` or\s+`error`, read installed `src\/references\/jev-routing\.md`; skip it for `unconfigured` or\s+`off`\. `error` blocks the dependent routing branch\./;
  assert.match(onboarding, onboardingJevPointer);
  assert.doesNotMatch(provider, /Shadow evaluation is the gate before arming/);
  assert.doesNotMatch(execution, /enabled-but-unarmed daemon/);
  assert.match(template, /Jev-specific\s+routing guidance is conditional on `jevRouting\.routing`/);
  assert.doesNotMatch(template, /Jev receipts/);
});

test('Lead reloads review gates only when a gate applies and blocks when its rules are unavailable', () => {
  const lead = read('src/roles/lead.md');
  const repoProtocol = read('.paseo-slp/workspace-protocol.md');

  assert.match(lead, /When the assignment or protocol\s+requires independent review/);
  assert.match(lead, /If applicable gate rules are unavailable, stale or unclear, mark the branch BLOCKED/);
  assert.match(lead, /When the assignment or protocol\s+requires independent review, follow its gate rules and references\/review-gates\.md\.\s+While that gate applies, re-read the gate rules in references\/orchestration\.md and\s+references\/review-gates\.md from the installed candidate immediately before each\s+decision to choose reviewer seats, reuse reviewers for re-review or issue\s+acceptance, including after resume or compaction; a surviving summary like\s+"Engineer → Reviewer" is not the rule/);
  assert.match(repoProtocol, /^version: ['"]?7['"]?$/m);
  assert.match(repoProtocol, /^## Gate$/m);
});

test('cross-project dependency relay preserves Lead authority and uses an authorized bounded digest', () => {
  const governance = read('src/references/governance.md');
  const orchestration = read('src/references/orchestration.md');
  const contract = read('docs/contract.md');
  const guide = read('docs/reports/guide-coverage.md');

  assert.match(governance, /only when the current assignment explicitly\s+grants the relay and the recipient Lead and route are verified/);
  for (const field of ['from/to project,', 'task and Lead IDs', 'dependency/interface', 'minimal evidence pointer',
    'request; answer,', 'blocked branch and owner', 'Human decision or additional authority needed', 'timestamp or receipt']) {
    assert.match(governance, new RegExp(field.replaceAll(' ', '\\s+')), `governance digest includes ${field}`);
  }
  assert.match(governance, /If the grant,\s+route or data authority is missing or unclear, keep the dependent branch BLOCKED/);
  assert.match(governance, /without\s+judging the interface, accepting work, granting write,\s+priority, merge or\s+integration authority/);
  assert.match(orchestration, /For cross-project relay, follow references\/governance\.md/);
  assert.match(contract, /cross-project relay/);
  assert.match(guide, /cross-project relay requires an explicit assignment grant, a verified Lead route and minimum authorized data/);
});
