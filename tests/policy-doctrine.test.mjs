import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { installUnitPaths } from '../plugin/server/runtime/cli/package.ts';
import { scenarios } from '../e2e/scenarios.mjs';
import { HANDBACK_VERDICTS } from '../plugin/server/runtime/report-records.ts';

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
    /known unchanged.*sha256sum.*delivered Policy locators.*summary is insufficient.*fresh catalog hash/,
    /Measure a file with wc -c before reading it; read large files in bounded ranges/,
    /Resume only on a new Human instruction/,
    /First full reads of applicable policy files are required; policy delivered in your bundle needs no re-read or hash check unless lost to compaction/,
    /Reuse full relevant references\/ or protocol text only when known unchanged/,
    /Re-read on mismatch, lost context or uncertainty; a summary is insufficient/,
    /once per session.*get_agent_status on your PASEO_AGENT_ID.*snapshot.labels\["paseo.parent-agent-id"\].*complete managed attempt evidence.*re-verify only after context loss or a new binding/);
});

test('bounded direct Lead writes need actual grants and required independent review', () => {
  pins('src/common.md', /Peer writing is the managed-implementation default/,
    /Peer uses the authorized project pool option/,
    /Tiny labels and missing\/stale protocols grant no exception/,
    /Review selection never waives a Human, assignment or protocol obligation/,
    /A Lead writer never stands in for required independent review/);
  pins('src/delegation.md', /Supervisor\/Lead use saved profiles/,
    /direct Lead write requires an explicit Human assignment or current effective protocol grant/,
    /clear, reversible work, bounded scope, one writer and exact candidate proof/,
    /cancel only their owned task agents through Paseo cancel_agent.*stop their task-local wakes.*preserve sessions\/artifacts/);
  pins(template, /Direct Lead write grant.*None by default/);
  pins('docs/contract.md', /Common policy owns authority, language, host boundaries, one writer, required gates, inbound route, Human stop and recovery; delegation owns the direct-Lead-write exception/);
});

test('formation distinguishes managed admissions from ordinary host verification', () => {
  pins('src/delegation.md', /dispatching desk tasks, not forming seats.*task-execution.md.*consume admission receipts for reservations, seat pins and effects/,
    /ordinary\/Lean creation or observation.*delegation-execution.md for receipts\/compatibility verification/);
  pins(direct, /Its parent forms Lead\/Peer under Form and deliver/,
    /For desk-managed task dispatch, use task-execution.md without duplicating its bookkeeping/,
    /Use bound slp_seat_create by default with requestId, role, taskLabel, assignment and grantRef/,
    /delivery.prompt; send exactly that prompt through send_agent_prompt with notifyOnFinish=true/,
    /grantRef is a declared pointer to the Human grant.*assignment sentence and date.*claim, never authenticated/,
    /For unbound\/older hosts or required compatibility.*prepare --emit create.*agent-scoped Paseo create_agent/,
    /different checkout\/lane needs declared paths\/reason/,
    /Verify the returned ID against actual host parent\/workspace\/cwd and bundle/,
    /Confirm the brief's report route when its first report arrives/,
    /the native report establishes the route, not acceptance/,
    /Empty inventory alone proves no absence/,
    /original cannot still create and any old owner is settled/);
  pins(desk, /Ordinary role creation can remain unbound if desk mint\/registration fails/);
});

test('new tasks discover desk formation in always-loaded delegation policy', () => {
  pins('src/delegation.md',
    /Check desk binding first \(slp_status if available\); use bound slp_seat_create for Lead\/Peer, including existing worktrees/,
    /New worktree: Paseo create_workspace under host-setup authority, then slp_seat_create placement existing/,
    /create_agent remains compatibility\/recovery/);
  assert.doesNotMatch(read('src/delegation.md'), /create_agent remains for .*declared isolated placement/);
});

test('generic inspectable Paseo delegation rules admit desk creation under the authority ceiling', () => {
  pins('src/delegation.md',
    /slp_seat_create creates a Paseo agent through the desk that the Human can inspect and chat with, satisfying generic Paseo create_agent or inspectability rules; repository rules, protocol clauses or Human instructions forbidding desk creation or requiring another formation path exclusively override this default/);
});

for (const scenario of [
  {
    name: 'Human instruction can require prepare/create for a reviewable record',
    instruction: 'form the Peer via prepare --emit create + create_agent so I can review the record',
    authority: /Human instructions forbidding desk creation or requiring another formation path exclusively override this default/,
  },
  {
    name: 'protocol clause can require prepare/create for all seats',
    instruction: 'all seats are created via prepare + create_agent',
    authority: /protocol clauses or Human instructions forbidding desk creation or requiring another formation path exclusively override this default/,
  },
  {
    name: 'repository rule can require plain create_agent only',
    instruction: 'plain create_agent only',
    authority: /repository rules, protocol clauses or Human instructions forbidding desk creation or requiring another formation path exclusively override this default/,
  },
]) {
  test(scenario.name, () => {
    const policy = read('src/delegation.md');
    assert.match(policy, scenario.authority, `Exclusive formation instruction: ${scenario.instruction}`);
    assert.doesNotMatch(policy, /only a repository rule naming the desk can forbid that path/);
    pins('src/common.md', /Human authority is the ceiling/);
  });
}

test('Supervisor reference reads follow the activity instead of team formation', () => {
  pins('src/roles/supervisor.md',
    /Read references\/governance.md before causal recording, recovery, policy evolution, audit, drift\/failure investigation or lost momentum/,
    /references\/monitoring.md before observation and settlement/);
  assert.doesNotMatch(read('src/roles/supervisor.md'), /when establishing supervision/);
  pins(governance, /Supervisor uses this for causal recording, coordination recovery, authorized cross-project relay and policy evolution/);
  pins('src/delegation.md', /before Peer reuse, read references\/orchestration.md for continuation and Human exceptions/,
    /Before selecting reviewers, read references\/review-gates.md/,
    /Before runtime choice\/settings\/fallback, read references\/provider-routing.md/);
});

test('session boundary is semantic, not a task ID or runtime capability', () => {
  pins(orchestration, /fresh Peer for a new assignment by default/,
    /assignment's continuation, authorized phases, correction or re-review/,
    /task IDs and host dispatch.reuse capability do not decide.*outcome boundary or grant a reuse exception/,
    /grantRef is a claim, not authenticated Human authority/,
    /unless an explicit Human exception applies/,
    /Reliable compaction may continue; no numeric compaction threshold/);
  pins(direct, /Human may explicitly form a standby Lead.*Record that exception/,
    /first phase, not the future project.*without relaxing any Peer outcome boundary/);
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
    /Outside those tools.*manually keep candidate\/declaration\/mandate current/,
    /slp_scope_declare → slp_scope_transition claim → Engineer slp_handback_submit.*observe.*slp_scope_transition submit-for-review → reviewers slp_scope_review → slp_scope_transition review-observed → approve\/advance/,
    /slp_workflow_get.*observedCandidateId.*snapshotSha256.*head.*round.*revision.*mandate.*pins/,
    /Drop SLP_\* and PASEO_HOME from the environment before running a suite in a probe/);
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
    /Installed policy directory in the bundle resolves references\/report-records.md/,
    /Run checks after the final write; a receipt predating the last delta does not cover it/,
    /ordinary CLI validation or referenced evidence/,
    /slp_handback_submit.*observed capture\/gaps/);
  pins(records, /slp.mjs verify-handback <report> --repo <absolute-checkout> --expect-contract <repo-path>=<sha256> --paseo-home <verified-home>/,
    /slp.mjs review-packet <absolute-checkout> --base <git-ref>/,
    /R1: every mutation log, including the acceptance owner's replay.*verbatim `sha256sum <test file>` output captured immediately before each mutant run.*product hashes before, mutant and after revert.*candidate identity/,
    /R2: the acceptance owner's replay.*pinned log.*evidence of record.*writer's log.*supporting.*sha mismatch between log, meta and.*handback candidate voids the claim/,
    /Candidate\/check claims need a handback record; report-only work may omit it or use candidate:null/,
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
  pins(monitoring, /If timeline access fails.*provider unregistered or CLI cannot reach the daemon home.*record the gap.*host's get_agent_activity.*read-only.*daemon home's agent records.*permitted evidence.*do not probe CLI subcommands/,
    /notifyOnFinish=true/,
    /bounded fallback for gaps in event coverage/,
    /Each heartbeat owner deletes its recorded task heartbeat and records the receipt/,
    /missing authorized controls leave unknown settlement without a new work prompt/);
  pins('src/common.md', /When only armed events remain and no local action is useful, end the turn with text/);
});

test('Supervisor decision relays suppress acknowledgment finish wakes and preserve material wakes', () => {
  pins(monitoring,
    /Use notifyOnFinish=true on create\/follow-up except Supervisor relays of rulings\/decisions to Lead: send_agent_prompt with notifyOnFinish=false avoids acknowledgment wakes;/,
    /Lead-level pushes \(BLOCKED, handback, milestones\), bounded heartbeat and Human wakes remain\./);
  assert.doesNotMatch(read(monitoring), /Use notifyOnFinish=true on create\/follow-up\./);
  // The relay exception must fit the file's preceding whitespace-word budget.
  assert.ok(raw(monitoring).trim().split(/\s+/u).length <= 910);
});

test('Lead pushes Lead-level state; Supervisor checks objective continuity on every wake', () => {
  // Triggers live in role bytes (system prompt) so they survive compaction.
  pins('src/roles/lead.md', /Report to that Supervisor only Lead-level state: BLOCKED, cross-scope dependencies/,
    /project milestones\/completion, your degraded context\/lifecycle and owner decisions; never internal progress or acknowledgments of relayed decisions/);
  pins('src/roles/supervisor.md', /scan monitoring's signals/,
    /inspect Lead, not each Peer/,
    /Each wake, before answering\/relaying, confirm each wait blocking the Human objective has a live owner\/wake path from Lead-level activity, not reported status/,
    /Take stalls\/waits within your authority to Human with options/,
    /arm a bounded Lead-level heartbeat under monitoring.md/);
  pins(monitoring, /no material delta and a live objective need no intervention/,
    /Peers report material decisions.*to Lead, bounded with evidence and attention needed; Lead reports to Supervisor under its role/);
  pins(protocol, /arms one Lead-level fallback heartbeat.*intermediate reports keep it, and it is deleted at Lead handback, Human stop or reassignment/);
});

test('governance owns evidence-led investigation, bounded contact and authorized cross-project relay', () => {
  pins('src/roles/supervisor.md', /Lead owns technical decisions and acceptance within its mandate/,
    /unless Human grants recovery contact with a named Peer.*Keep contact bounded/,
    /reconcile evidence\/proposed changes into Lead's shared state before direction changes/);
  pins(governance, /Resolve.*notebook.*Expose.*supervisor_notebook/,
    /Read the tail only when the assignment or a decision needs it/,
    /Human may grant recovery contact with a named Peer for a bounded purpose/,
    /reconcile exchange, evidence\/proposed change into its current brief\/checkpoint before direction changes/,
    /Contact alone grants no Peer write, objective\/priority\/technical verdict, integration or acceptance authority/,
    /Relay only when the current assignment explicitly grants it and recipient Lead\/route are verified/,
    /Missing grant, route or data authority makes the dependent branch BLOCKED/,
    /read anti-patterns.md and select relevant hypotheses.*what disproves it.*within authority/);
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
  pins(review, /Any repair needs an authorized write phase; direct Lead writes follow delegation policy's explicit grant/,
    /same authorized writer.*same independent seat/,
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
  pins('src/references/provider-routing.md', /common policy's once-per-session route verification.*PASEO_AGENT_ID is unavailable.*slp_status\(\{\}\).*one bounded host lookup.*missing parent\/report metadata as a gap/,
    /optionId\/catalogSha256.*runtime resolves the complete bundle against fresh host providers/,
    /error blocks the branch.*Read references\/jev-routing.md for shadow\/armed\/error, skipping unconfigured\/off/,
    /CLI compatibility uses.*live list_providers/,
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
    /Before each review selection or revision, including not-required, reviewer choice, re-review or acceptance, read applicable gate rules in references\/orchestration.md and references\/review-gates.md under common policy's hash-anchored reuse; record selection\/reason before the candidate round/,
    /After mandatory reads, the next action is formation or dispatch; orientation is not a stopping point/,
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
  assert.match(raw(protocol), /^version: '15'$/m);
  assert.match(raw(protocol), /^template_sha256: 'c5b6db392e3d9646d931cda658c3364fe64287caf1f9717ad323681f2e860ad1'$/m);
});

test('review method tools stay conditional and keep Lead obligations', () => {
  pins(review, /Lead ordering lenses by risk/, /each falsifiable, drawn from facts and carrying no conclusion/,
    /state which failure classes were checked and which were not/,
    /send findings first, naming pending proof, then its own addendum/,
    /rely on a valid measured result bound to the same candidate pin, command and scope instead of rerunning it/,
    /rerun or probe narrowly only on pin drift, a missing\/invalid result or an unresolved proof question/,
    /narrow result proves only its scope; verification sufficiency, R1\/R2 replay \(report-records.md\) and acceptance stay with Lead/,
    /state the property to restore.*allowlist over blacklist; not the implementation.*trade-off to publish when chosen; an accepted risk reopens only on new evidence/,
    /Exhaustion is not ACCEPT but a checkpoint.*Lead extends, records a proof gap or escalates/);
  pins('src/roles/peer.md', /which enumeration may be missing, which docs sentence describes it, which failure class lacks a falsifying test; evidence or "unknown"/,
    /trigger → consequence → evidence → counterevidence\/unknown, list coverage checked\/unchecked/,
    /write only in assigned scratch.*kill only recorded PIDs.*pass env explicitly per command, read summary\/receipt before long logs/);
  pins('docs/development.md', /the claim decides which receipt qualifies.*full-suite claim needs `selection: default-suite`.*narrow claim may use a `partial` receipt but only for exactly its argv and file list, never as full-suite evidence/,
    /Either way the receipt's snapshot sha256, argv\/file list and node\/platform must all match/,
    /pass `SLP_TEST_ISOLATED_ROOT` explicitly on every command/);
});


test('ordinary formation requires no caller routing choreography and preserves truthful pending recovery', () => {
  pins(direct, /Peer runtime is optional.*server selects once.*full-pin compatibility/,
    /Use selection for independent choice; no settings overrides/,
    /same-Git workspace\/cwd and pins routing\/protocol separately/,
    /Placement\/automatic runtime\/selection waits briefly for exact registration; legacy omitted full-pin Peer\/Lead keeps its delivery path/,
    /Pending directs slp_operation_get with the same requestId: immutable evidence, no resume\/recreate/,
    /Lead uses Paseo create_workspace, owns its host setup within the grant, then calls slp_seat_create with placement existing/,
    /V1 kind=worktree reports a gap before effects/,
    /SDK open may revive archived workspaces; prefer active IDs/,
    /Never install dependencies or materialize to hide a gap/);
  pins('src/references/provider-routing.md', /no routes\/prepare\/route-decide choreography is required/,
    /linked caller without local routing\/protocol inherits its configured same-Git main checkout/,
    /no trustworthy source means gap, not silent user fallback/,
    /Shadow requires independent Lead selection even for one option; errors block/,
    /Off\/unconfigured selects a sole eligible option; several options return choices for selection.optionId/,
    /armed decline\/config\/key\/network failure blocks without default substitution/);
  pins('src/references/jev-routing.md', /route-decide or slp_seat_create invokes it; admitted formation pins once, replay never re-decides/,
    /prepare and --check verify receipts offline/);
});

test('bounded scope counts context and dependencies, not an issue count or timeout', () => {
  pins(orchestration, /Bounded means finishable within one Peer's context/,
    /Estimate update rounds\/comments, flows\/screens, touched files and the provider's context window/,
    /required implementation\/proof.*anticipated correction\/review rounds.*label unmeasured context estimates/,
    /split dependency-ordered slices with one Peer and explicit scope each; do not size by issue count alone/,
    /Supervisor briefs state outcome and authority; Lead chooses execution topology/);
  pins('src/roles/peer.md', /reading consumes about 1\/3 of your context without recorded artifact\/proof, return a scope question/,
    /telemetry or a labelled estimate, remaining obligations and proposed slices/,
    /Never write to evade this checkpoint; Lead decides scope. No timeout\/quota/);
});

test('Peer verdict vocabulary matches the shared schema and testcase dispositions keep proof separate', () => {
  const peer = read('src/roles/peer.md');
  pins('src/roles/peer.md', /Reviewer verdict is APPROVE or FINDINGS, never Lead's acceptance verdict/,
    /REOPEN_REQUEST for failed premises, DEPENDENCY_REQUEST for missing owner\/results, or BLOCKED for missing authority\/capability/,
    /TestcaseAuthor.*Requirement-linked cases, prerequisites, inputs, expected results and coverage\/unknowns; no product acceptance/,
    /TestEngineer.*Granted test artifacts and executed checks on the pinned candidate; commands\/results, coverage and gaps; no product verdict/);
  const vocabulary = [...new Set(peer.match(/\b(?:APPROVE|FINDINGS|BLOCKED|REOPEN_REQUEST|DEPENDENCY_REQUEST|ACCEPT|CHANGES_REQUESTED|PASS|FAIL)\b/gu))].sort();
  assert.deepEqual(vocabulary, [...HANDBACK_VERDICTS].sort());
});

test('Supervisor relays Human words faithfully and STOP never waits for or revives the owner', () => {
  pins('src/roles/supervisor.md', /Supervisor assignments state outcome and authority, not topology/,
    /Relay Human instructions verbatim; label inferences separately; never attribute added constraints to Human/,
    /On Human STOP, retain existing evidence\/receipts and cancel the verified Lead immediately; never wait for a report or prompt its owner again/,
    /Lead cancellation does not cancel Peers.*list_agents for paseo.parent-agent-id matching the Lead ID and cancel identified children directly/,
    /control replies \(including failures\).*activeTurn\/permission observations with timestamps/,
    /Missing receipts, unidentified children or incomplete inventory remain unknown settlement/,
    /No cleanup agents or owner revival; resume only on a new Human instruction/);
});

test('seat formation policy stays within frozen per-file and total word budgets', () => {
  const caps = {
  "src/common.md": 562,
  "src/delegation.md": 266,
  "src/roles/supervisor.md": 324,
  "src/roles/lead.md": 419,
  "src/roles/peer.md": 541,
  "src/templates/workspace-protocol.md": 997,
  "src/references/provider-routing.md": 619,
  "src/references/report-records.md": 529,
  "src/references/task-execution.md": 949,
  "src/references/review-gates.md": 896,
  "src/references/orchestration.md": 1148,
  "src/references/delegation-execution.md": 745,
  "src/references/anti-patterns.md": 612,
  "src/references/governance.md": 635,
  "src/references/monitoring.md": 910,
  "src/references/jev-routing.md": 233
};
  const words = text => text.trim().split(/\s+/u).length;
  for (const [path, cap] of Object.entries(caps)) assert.ok(words(raw(path)) <= cap, `${path} exceeds ${cap} words`);
  const all = installUnitPaths(root).filter(path => path.startsWith('src/') && path.endsWith('.md'));
  assert.deepEqual([...all].sort(), Object.keys(caps).sort(), 'account for every installed policy file');
  assert.equal(all.reduce((total, path) => total + words(raw(path)), 0), 10385, 'net-zero total policy words');
});
