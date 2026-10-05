import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { installUnitPaths } from '../plugin/server/runtime/cli/package.ts';
import { scenarios } from '../e2e/scenarios.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const raw = path => readFileSync(join(root, path), 'utf8');
const read = path => raw(path).replace(/\s+/gu, ' ');
const pins = (path, ...rules) => { for (const rule of rules) assert.match(read(path), rule, `${path}: ${rule}`); };
const review = 'src/references/review-gates.md';
const records = 'src/references/report-records.md';
const orchestration = 'src/references/orchestration.md';
const monitoring = 'src/references/monitoring.md';
const governance = 'src/references/governance.md';
const desk = 'src/references/task-execution.md';
const direct = 'src/references/delegation-execution.md';
const template = 'src/templates/workspace-protocol.md';
const protocol = '.paseo-slp/workspace-protocol.md';

test('semantic authority and actual writer survive guarded operations', () => {
  pins('src/common.md', /Human authority is the ceiling/, /separately authorized/,
    /One moving write scope has one writer/, /Permissions do not expand task authority/,
    /Desk guards apply to admitted tool operations, not arbitrary shell\/filesystem work/,
    /never authenticate Human grants, choose sufficient proof\/review or establish project acceptance/);
  pins(desk, /does not decide sufficiency or risk|does not decide sufficient mandates|neither.*chooses sufficient mandates/,
    /It neither detects undeclared shell writes nor chooses sufficient mandates/);
});

test('all seats receive communication, stop and recovery responsibilities', () => {
  pins('src/common.md', /All seat-facing text uses the configured communication language/,
    /direct replies to the Human mirror the Human's current language/,
    /identifiers, paths and commands verbatim/,
    /Human stop overrides objectives and callbacks: stop work and follow-ups immediately/,
    /policy recovery restores no task state/,
    /known unchanged.*summary is insufficient.*fresh catalog hash/);
});

test('bounded direct Lead writes need actual grants and required independent review', () => {
  pins('src/common.md', /Peer writing is the managed-implementation default/,
    /direct Lead write requires an explicit Human assignment or current effective protocol grant/,
    /clear, reversible work, bounded scope, one writer and exact candidate proof/,
    /Lead writer never stands in for required independent review/,
    /Tiny labels and missing\/stale protocols grant no exception/,
    /Review selection never waives a Human, assignment or protocol obligation/);
  pins(template, /Direct Lead write grant.*None by default/);
});

test('formation distinguishes managed admissions from ordinary host verification', () => {
  pins('src/delegation.md', /task-execution.md.*Runtime admission records and verifies reservations, seat pins and effects/,
    /ordinary\/Lean creation or observation.*delegation-execution.md.*manual verification still applies/);
  pins(direct, /Its parent creates Lead\/Peer through agent-scoped create_agent/,
    /Verify the returned ID against actual host parent\/workspace\/cwd and bundle/,
    /Confirm the brief's report route when its first report arrives/,
    /Empty inventory alone proves no absence/,
    /original cannot still create and any old owner is settled/);
  pins(desk, /Ordinary role creation can remain unbound if desk mint\/registration fails/);
});

test('session boundary is semantic, not a task ID or runtime capability', () => {
  pins(orchestration, /fresh Peer for a new assignment by default/,
    /assignment's continuation, authorized phases, correction or re-review/,
    /task IDs and host dispatch.reuse capability do not decide.*outcome boundary or grant a reuse exception/,
    /grantRef string is a claim, not authenticated Human authority/,
    /unless an explicit Human exception applies/,
    /Reliable compaction may continue; no numeric compaction threshold/);
  pins(direct, /Human asks to form a standby Lead for a future task.*formation exception/,
    /first phase, not the future project.*relaxes no Peer outcome boundary/);
});

test('parallel scope and shared-resource preflight precede the isolation choice', () => {
  pins(orchestration, /Before concurrent work, declare merge-safe scopes\/resources.*shared-resource and state owners.*actual checkout\/cwd\/ worktree paths.*integration owner and acceptance owner/,
    /Then choose shared checkout, worktrees or another boundary under protocol\/Lead tactic/,
    /Shared checkout requires explicit nonconflict; workspace IDs alone do not isolate/,
    /Overlap needs serial ownership transfer or safe decomposition\/isolation/);
  pins(direct, /parallel work use orchestration.md's actual paths\/shared-resource preflight/);
  pins(template, /Before concurrency: writer\/reviewer limits, merge-safe scopes\/resources, actual paths\/dependencies, integration owner and candidate freeze; then choose shared checkout or isolation/);
});

test('runtime-owned records replace duplicated state but not judgment or notification', () => {
  pins(desk, /slp_assignment_register\/attach.*slp_assignment_amend.*slp_decision_append/,
    /slp_workflow_get.*returned revisions\/cursors; omissions mean partial context/,
    /Do not maintain a competing ledger in notes/,
    /notify affected owners.*not their semantic truth or actual delivery/);
  pins(orchestration, /amend brief\/decisions through its tools instead of copying a second owner\/revision ledger/);
});

test('managed dispatch explains pending and uncertain effects without inventing retries', () => {
  pins(desk, /slp_task_dispatch bootstrap.*creates without work/,
    /seat-pending\/sent:false requires slp_task_reconcile.*fresh pins; no second create/,
    /Replaying the identical requestId retrieves its recorded result, never re-executes a host effect/,
    /EXECUTION_UNKNOWN\/uncertain means reconcile that original identity, not retry with another ID/,
    /host timeout can still complete later/,
    /REVISION_CONFLICT or ROUTE_DRIFT/);
});

test('review preserves selected obligations, neutral independent judgment and adjudication', () => {
  pins(review, /minimum sufficient independent mandates for material decision-changing questions/,
    /Required seats, axes and obligations remain binding despite unavailability or adverse findings/,
    /not-required only with no material trigger.*exempt only with explicit waiver authority/,
    /distinct from writer and accepting owner/,
    /Withhold desired verdict, writer identity and prior findings/,
    /Other lenses' findings\/verdicts are not answer keys/,
    /Lead rules on each material finding with reason, supporting\/contrary evidence and residual risk/,
    /Missing required proof or constraints cannot be accepted as recorded risk/,
    /Unanimity, severity or reproduction alone is no verdict rule/);
});

test('scope tools pin declared plans and candidates while prompt policy owns sufficient review', () => {
  pins(review, /Runtime enforces the declared set.*does not decide sufficiency or risk/,
    /reviewPlan:null opts into legacy Spec\/Standards compatibility/,
    /Dropping mandates after adverse findings to evade obligations is prohibited/,
    /Outside those tools.*manually keep candidate\/declaration\/mandate current/);
  pins(desk, /slp_scope_declare.*slp_scope_transition.*slp_scope_review/,
    /independent actor and candidate\/revision pins/);
});

test('proof consumes measured execution and independently verifies remaining claims', () => {
  pins(review, /Inspect actual measured check\/integration records.*class, output and candidate pins/,
    /Independently verify shell-reported checks.*outcome.*do not cover/);
  pins(desk, /ledger-integrity, repo-payload-check, repo-git-head/,
    /do not run arbitrary tests or prove feature behavior/,
    /Rollout transitions perform no deployment/);
  pins(orchestration, /Record consistency proves no execution/,
    /Human owns subjective and reserved trade-offs/);
});

test('handback uses actual schema/submit and preserves referenced-evidence gap', () => {
  pins('src/roles/peer.md', /Candidate\/check claims|candidate or checks/,
    /slp_handback_submit.*observed capture\/gaps.*ordinary CLI validation or referenced evidence/);
  pins(records, /Candidate\/check claims need a handback record; report-only work may omit it or use candidate:null/,
    /records --schema.*exact fields/,
    /slp_handback_submit.*observedCandidateId\/gaps/,
    /stored claim, pending observation.*proves neither execution nor acceptance/,
    /may leave outputRef unreadable.*CLI or authorized evidence inspection/,
    /--repo wins over declared roots.*constrains outputRef/,
    /Inline output wins over outputRef; sha:null records missing evidence/);
});

test('optional structured reports and recaps remain claims and partial context', () => {
  pins(records, /slp-report read\/ran\/authority\/findings remain claims/,
    /Rendering keeps original evidence fence bytes/,
    /handoff.recapInputs uses only supplied sources.*omissions\/conflicting pins.*no settlement, acknowledgment or transfer/);
});

test('settlement distinguishes delivery, closed rework, mirror and official sink', () => {
  pins(monitoring, /Delivery completes and no correction or re-review remains open/,
    /same write owner and independent seats for open rework/);
  pins(records, /slp_settlement_record.*slp_settlement_export.*instead of manually assembling duplicate IDs/,
    /Neither mirror nor export performs cleanup or creates project acceptance/,
    /protocol's durable task sink.*Supervisor's authorized causal notebook/,
    /Without either, Lead includes Peer settlement.*Without Supervisor, Lead uses its own authorized task\/note/,
    /Lead does not write a Supervisor-owned notebook/,
    /no raw transcript or secrets/);
});

test('unsupported stop, quiescence, cold succession and Human principal remain explicit', () => {
  pins(desk, /slp_task_stop prevents new task effects.*does not cancel a live turn/,
    /Archive, idle, revocation, turn end or absent listings prove no process quiescence/,
    /No-offer cold loss is an authority gap.*no Human RPC principal/,
    /slp_assignment_offer\/accept.*does not reparent sessions, settle old writers or authenticate the Human grant/);
  pins(orchestration, /After acceptance, Delivery, closed rework and resource reconciliation.*archive settled Peers through authorized host controls/);
});

test('monitoring stays event-first with bounded owned wakes and no guessed cleanup', () => {
  pins(monitoring, /notifyOnFinish=true/,
    /bounded fallback for gaps in event coverage/,
    /Each heartbeat owner deletes its recorded task heartbeat and records the receipt/,
    /missing authorized controls leave unknown settlement without a new work prompt/);
  pins('src/common.md', /When only armed events remain and no local action is useful, end the turn with text/);
});

test('governance owns evidence-led investigation, bounded contact and authorized cross-project relay', () => {
  pins('src/roles/supervisor.md', /Lead owns project technical decisions and acceptance/,
    /unless Human grants recovery contact with a named Peer.*Keep that contact bounded/,
    /reconcile evidence and proposed changes into Lead's shared state before direction changes/);
  pins(governance, /Human may grant recovery contact with a named Peer for a bounded purpose/,
    /reconcile exchange, evidence\/proposed change into its current brief\/checkpoint before direction changes/,
    /Contact alone grants no Peer write, objective\/priority\/technical verdict, integration or acceptance authority/,
    /Relay only when the current assignment explicitly grants it and recipient Lead\/route are verified/,
    /Missing grant, route or data authority makes the dependent branch BLOCKED/,
    /Treat.*as hypotheses.*what disproves it.*within authority/);
});

test('workflow investigation reaches the conditional twenty-pattern evidence catalogue', () => {
  const catalogue = 'src/references/anti-patterns.md';
  pins(governance, /pattern-specific evidence\/questions during workflow audit, material drift\/failure, repeated correction or uncertain architecture\/reasoning, read anti-patterns.md and select relevant hypotheses/);
  pins(catalogue, /These 20 guide §9 patterns are hypotheses, not validated detectors/,
    /Inspect evidence and counterevidence, ask an open question and reconcile before intervention/,
    /Peer assignments receive relevant guards, not this whole catalog/,
    /Record evidence, mechanism, impact, question\/response and outcome under governance.md/);
  const rows = raw(catalogue).split('\n').filter(line => /^\| \d+ /u.test(line))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.map(row => Number(row[0].split(' ')[0])),
    Array.from({ length: 20 }, (_, index) => index + 1));
  for (const row of rows) {
    assert.equal(row.length, 3, `${row[0]} retains pattern, Inspect and question/response`);
    assert.ok(row[1].length > 0 && row[2].includes('?'), `${row[0]} retains tailored evidence/question`);
  }
  assert.ok(installUnitPaths(root).includes(catalogue));
});

test('context handoff keeps concrete state, old-owner settlement and successor acknowledgment', () => {
  pins('src/roles/lead.md', /references\/governance.md for handoff when degraded context makes decisions\/evidence unreliable/);
  for (const field of [/objective\/scope\/reason/, /accepted\/rejected decisions, reasons and alternatives/,
    /candidate\/proof\/review and findings/, /dependencies\/owners\/readiness/,
    /next action\/checkpoint/, /resources\/ wake owners\/receipts/, /unknowns\/limits/]) pins(governance, field);
  pins(governance, /handoff content, not a schema for handoff.state/,
    /Verify old ownership paused\/settled before replacing it/,
    /Successor acknowledges ownership and handback conditions/);
  pins(protocol, /evidence-based handoff/);
});

test('mechanism recurrence still reopens premise under authorized bounds', () => {
  pins(review, /same authorized writer.*same independent seat/,
    /Consecutive same-class findings call for mechanism investigation/,
    /establish an authorized bound before continuing if absent/,
    /Exhaustion is not ACCEPT.*Recurrence after mechanism work reopens the premise\/strategy/);
  pins(protocol, /R1.*acceptance owner's replay.*verbatim `sha256sum <test file>`.*immediately before the mutant runs/,
    /R2.*replayed, pinned log is the evidence of record.*mismatch.*voids the log's claim/);
});

test('onboarding adapts actual decision/tool paths without mandatory queue setup', () => {
  pins('skills/paseo-slp-onboarding/SKILL.md', /current Human authority.*ask only missing risk, budget, review, execution or delivery/,
    /current workflow view instead of inventing parallel bookkeeping.*Lean needs no queue/,
    /Human grant covers them, proceed.*missing confirmation/,
    /healthy role injection can still lack desk membership/,
    /Source code or a tool name proves no ready runtime/);
});

test('routing delegates actual bundle checks to runtime without granting fallback authority', () => {
  pins('src/references/provider-routing.md', /optionId\/catalogSha256.*runtime resolves the complete bundle against fresh host providers/,
    /jevRouting.routing` as `shadow`, `armed` or `error`.*read references\/jev-routing.md; skip unconfigured\/off.*Error blocks the branch/,
    /ordinary\/Lean launch.*live list_providers/,
    /refresh routes.*quotaFallbackFrom/,
    /Quota alone creates no switch\/cost authority/,
    /mode needs Human/);
  pins('src/references/jev-routing.md', /Shadow evaluation is the gate before arming/,
    /Unreadable error blocks dependent routing; unconfigured\/off needs no Jev path/,
    /armed routing requires the receipt's option, with decline failing closed/,
    /consistency, not cryptographic authenticity/);
});

test('role gate-policy reads stay conditional even with desk-enforced pins', () => {
  pins('src/roles/lead.md', /When the assignment or protocol requires independent review/,
    /re-read.*references\/orchestration.md and references\/review-gates.md.*immediately before choosing reviewer seats/,
    /Unavailable, stale or unclear applicable gate rules make that branch BLOCKED/);
});

test('existing scenario obligations remain independent of text consolidation', () => {
  const variants = scenarios.filter(item => item.id.startsWith('premise-reopen-'));
  assert.deepEqual(variants.map(item => item.providerFamily).sort(), ['claude', 'codex', 'devin', 'pi']);
  for (const scenario of variants) {
    assert.equal(scenario.repetitions, 2);
    assert.equal(scenario.runtimeSource, 'profiles-and-peer-pool');
    assert.match(scenario.assertions[0], /Before writing, Peer returns REOPEN_REQUEST/);
    assert.match(scenario.assertions[1], /Lead checks the same evidence.*corrected premise/s);
  }
  const directScenario = scenarios.find(item => item.id === 'direct-codex');
  assert.match(directScenario.trigger, /Peer Engineer as implementation owner/);
  assert.match(directScenario.assertions.join(' '), /Peer supplies proof/);
});

test('resulting policy/install graph has no dangling or retired active pointers', () => {
  const walk = dir => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith('.md') ? [`${dir}/${entry.name}`] : []);
  const retired = ['src/references/delegation-formation.md',
    'skills/paseo-slp-onboarding/references/custom-interview.md',
    'skills/paseo-slp-onboarding/references/repository-configuration.md'];
  const unit = installUnitPaths(root);
  for (const path of retired) {
    assert.equal(existsSync(join(root, path)), false, `retired source ${path}`);
    assert.ok(!unit.includes(path), `retired install entry ${path}`);
  }
  for (const path of [...walk('src'), ...walk('skills/paseo-slp-onboarding')]) {
    assert.ok(unit.includes(path), `${path} must ship`);
    for (const gone of retired) assert.ok(!raw(path).includes(gone.split('/').at(-1)), `${path} points to retired ${gone}`);
    for (const pointer of raw(path).matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (!/^[a-z]+:/i.test(pointer[1])) assert.ok(existsSync(resolve(root, dirname(path), pointer[1])), `${path}: ${pointer[1]}`);
    }
    for (const pointer of raw(path).matchAll(/(?:src\/)?references\/([a-z][a-z-]*\.md)\b/g)) {
      const target = path.startsWith('skills/') && existsSync(resolve(root, dirname(path), `references/${pointer[1]}`))
        ? resolve(root, dirname(path), `references/${pointer[1]}`) : join(root, 'src/references', pointer[1]);
      assert.ok(existsSync(target), `${path} → ${pointer[0]}`);
    }
  }
  for (const role of ['supervisor', 'lead', 'peer']) assert.ok(unit.includes(`src/roles/${role}.md`));
  const sha = createHash('sha256').update(raw(template)).digest('hex');
  assert.match(raw(protocol), new RegExp(`^current_source_template_sha256: '${sha}'$`, 'm'));
  assert.match(raw(protocol), /^version: '13'$/m);
  assert.match(raw(protocol), /^template_sha256: 'c5b6db392e3d9646d931cda658c3364fe64287caf1f9717ad323681f2e860ad1'$/m);
});
