import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scenarios } from '../e2e/scenarios.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');

test('contract text pins: peer locators, review gate shape, bounded settle, heartbeat cleanup', () => {
  const contract = read('docs/contract.md').replace(/\s+/gu, ' ');
  const monitoring = read('src/references/monitoring.md').replace(/\s+/gu, ' ');

  assert.ok(contract.includes('Peer locators contain `common.md` and `roles/peer.md`'));
  assert.match(contract, /a required gate follows the rule the effective workspace protocol declares/);
  assert.match(read('src/delegation.md'), /Required review cannot be weakened because seats are unavailable or findings are adverse/);
  assert.ok(monitoring.includes('settle each bounded task after Delivery completes and no correction or re-review remains open'));
  assert.ok(monitoring.includes('Each heartbeat owner deletes its recorded task heartbeat and records the receipt.'));
  assert.ok(monitoring.includes('bounded fallback for gaps in event coverage'));
});

test('Peer handbacks project candidate and check claims through slp-record', () => {
  const peer = read('src/roles/peer.md');
  assert.match(peer, /handback that asserts a candidate or checks includes a fenced JSON block marked\s+`slp-record`/);
  assert.match(peer, /the record projects the same\s+facts and never replaces the report/);
  assert.match(peer, /does not prove a command ran/);
  assert.match(peer, /`seat\.role` and `seat\.disposition` are required; `seat\.agentId` is\s+optional/);
  assert.match(peer, /`APPROVE`, `FINDINGS`, `BLOCKED`, `REOPEN_REQUEST`,\s+`DEPENDENCY_REQUEST` or `null`/);
  assert.match(peer, /exactly one of\s+`snapshotSha256` or a full clean commit `head`/);
  assert.match(peer, /Every `checks\[\]` entry requires\s+`cmd`, integer `exit` and `sha`/);
  assert.match(peer, /managed runtime's `bin\/slp\.mjs` \(same path family as the snapshot command\)/);
  assert.match(peer, /Pass `--repo <absolute-path>` for the verifier's candidate checkout when reading\s+referenced output; it overrides record-declared roots/);
  assert.doesNotMatch(peer, /report-only records use a null candidate|Set `seat\.agentId` only when known/);
  assert.match(peer, /`records --schema`[\s\S]*`records <report> --require handback`/);
});

test('report records document safe settlement sinks and effective output roots', () => {
  const records = read('src/references/report-records.md');
  const monitoring = read('src/references/monitoring.md');
  const orchestration = read('src/references/orchestration.md');

  assert.match(records, /When supplied, `--repo <absolute-path>` is the verifier's authoritative\s+root and overrides every record-declared `candidate\.repository`/);
  assert.match(records, /otherwise it names an absolute `repository`/);
  assert.match(records, /Without it, an\s+`outputRef` uses the per-check `candidate\.repository`, then the record's\s+`candidate\.repository`/);
  assert.match(records, /warn `repository-mismatch` with both resolved paths and still read\s+only from `--repo`/);
  assert.match(records, /A settlement record\s+or export contains no raw transcript or secrets/);
  assert.match(records, /the relevant evidence-pointer fields in its authorized causal notebook/);
  assert.match(records, /When no Supervisor is assigned, the\s+Lead writes the Lead's own\s+settlement pointer/);
  assert.match(records, /If neither sink is available, the Lead\s+includes the Peer settlement block in the Lead's handback to the assigned\s+Supervisor/);
  assert.match(records, /`--require` makes a kind mandatory; it is satisfied when a record\s+of that kind is present, while validation errors still make the command exit 1/);
  assert.match(records, /required-kind-missing[\s\S]*multiple-records[\s\S]*repository-mismatch/);
  assert.match(records, /`--kind` filters returned\s+records only; parse and validation errors remain complete for every block/);
  assert.match(orchestration, /Pass `--repo <absolute-path>` for the verifier's\s+candidate checkout when checking referenced output; it overrides roots declared\s+in the record/);
  assert.match(monitoring, /references\/report-records\.md/);
  assert.doesNotMatch(monitoring, /root Beads issue comment|causal notebook|durable note location/);
  assert.match(read('docs/contract.md'), /verifier's `--repo` when supplied, otherwise record-declared candidate roots/);
});

test('optional structured reports preserve legacy claims and explicit-source recap limits', () => {
  const records = read('src/references/report-records.md');

  assert.match(records, /A handback may include an optional top-level `report` in the v1 record/);
  assert.match(records, /handbacks without it\s+remain valid, and settlement records do not accept it/);
  assert.match(records, /`purpose` selects the substantive body:[\s\S]+The\s+selected branch carries the meaningful body, with the other purpose branches\s+null/);
  assert.match(records, /Findings distinguish `hypothesis` from `confirmed`[\s\S]+that\s+label and its source\s+pointer are still a claim/);
  assert.match(records, /`selfReport\.read` and `selfReport\.ran`, `report\.assignment\.authority`, and the\s+enclosing record's candidate and checks are reported claims/);
  assert.match(records, /When the current runtime advertises this mode, `records --render <file\|->/);
  assert.match(records, /original `slp-record` fence unchanged, including its line endings/);
  assert.match(records, /`handoff\.recapInputs`[\s\S]+It does not\s+search arbitrary files or host state/);
  assert.match(records, /An omitted source group is a visible gap; an explicit\s+empty list reports that source as having no rows/);
  assert.match(records, /can flag invalid\s+rows and detected revision or candidate-pin conflicts, but does not validate\s+the referenced source files themselves/);
  assert.match(records, /leaves settlement unverified\s+and recipient\s+acknowledgment unobserved; it performs no transfer or lifecycle\s+operation/);
});

test('common policy pins seat-facing text communication language', () => {
  const common = read('src/common.md').replace(/\s+/gu, ' ');
  const communicationRule = "Seat-facing text is anything another seat or the Human reads: prompts, assignments, reports, agent-responses, handbacks, briefs and notebook entries. All seat-facing text uses the configured communication language; direct replies to the Human mirror the Human's current language; keep identifiers, paths and commands verbatim.";

  assert.ok(common.includes(communicationRule));
});

test('implementation defaults to Peer while bounded direct Lead writes retain independent review', () => {
  const common = read('src/common.md');
  const lead = read('src/roles/lead.md');
  const delegation = read('src/delegation.md');
  const template = read('src/templates/workspace-protocol.md');
  const policy = `${common}\n${lead}\n${delegation}\n${template}`;

  assert.match(common, /Peer writing is the managed-implementation\s+default/i);
  assert.match(policy, /direct Lead write requires an explicit Human\s+assignment[^.]+or (?:a )?current effective protocol grant/i);
  assert.match(policy, /clear, reversible work[^.]+bounded\s+scope[^.]+exact candidate proof/i);
  assert.match(policy, /Tiny\s+classification may reduce ceremony, never authority, ownership, parentage or a\s+required gate/i);
  assert.match(common, /Lead writer never stands in for required\s+independent review/i);
  assert.match(template, /Lead writer cannot fill its own independent review\s+seat/i);
});

test('open rework retains its actual write owner, independent seats and candidate-bound gate', () => {
  const orchestration = read('src/references/orchestration.md');
  const monitoring = read('src/references/monitoring.md');
  const review = read('src/references/review-gates.md');

  assert.match(orchestration, /Send authorized corrections to the same write owner/i);
  assert.match(monitoring, /Keep the same authorized write owner and\s+independent review seats available while that task has rework/i);
  assert.match(monitoring, /each correction\s+remains within its grant and re-enters the declared gate on its exact frozen\s+candidate/i);
  assert.match(review, /Any repair gets one authorized writer,\s+Peer by default or Lead only under the bounded direct-write grant in common\s+policy/i);
  assert.match(review, /the resulting candidate freezes and re-enters the declared gate/i);
});

test('parallel execution chooses isolation only after scope and shared-resource preflight', () => {
  const common = read('src/common.md');
  const orchestration = read('src/references/orchestration.md');
  const execution = read('src/references/delegation-execution.md');
  const template = read('src/templates/workspace-protocol.md');

  assert.match(common, /One moving write scope has one writer/i);
  assert.match(orchestration, /effective repo protocol or Lead tactic chooses shared checkout,\s+worktree or another isolation boundary after declaring scopes and resources\s+merge-safe/i);
  assert.match(orchestration, /shared checkout is permitted only when that tactic makes nonconflict\s+explicit; workspace IDs alone do not isolate/i);
  assert.match(orchestration, /Overlapping writes require serial\s+ownership transfer or a safe decomposition\/isolation choice/i);
  assert.match(execution, /merge-safe scope,\s+shared-resource ownership, actual paths, the protocol-selected isolation tactic\s+and integration\/candidate freeze/i);
  assert.match(template, /declare\s+merge-safe scopes, dependencies, shared-resource owners, actual checkout\/cwd paths,\s+integration owner and candidate freeze/i);
});

test('review policy uses risk-selected mandates and neutral, candidate-bound briefs', () => {
  const review = read('src/references/review-gates.md');
  const execution = read('src/references/delegation-execution.md');
  const template = read('src/templates/workspace-protocol.md');
  const protocol = read('.paseo-slp/workspace-protocol.md');

  assert.match(review, /minimum sufficient independent mandates for material decision-changing\s+questions/i);
  assert.match(review, /Provider-family diversity may add a useful lens, but does not\s+prove independence and is not a default seat/i);
  assert.match(review, /Consecutive rounds with the same finding class signal a shared mechanism/);
  assert.match(review, /Investigate that mechanism, enumerate affected sites and\s+refactor the broken invariant where evidence supports it/i);
  assert.match(review, /Follow the correction,\s+review and challenge bounds in the assignment and effective protocol; establish\s+an authorized bound before continuing if none is set/i);
  assert.match(review, /Peer by default or Lead only under the bounded direct-write grant in common\s+policy/i);
  assert.match(review, /objective and\s+acceptance criteria, actual authority constraints, current candidate identity[\s\S]+reviewer mandate and lens, relevant source paths,\s+observed facts and unknowns, and focused proof questions/i);
  assert.match(review, /Withhold the desired verdict, writer identity and prior findings/i);
  assert.match(review, /that seat's prior findings[\s\S]+Do not provide another lens's findings or\s+verdict as an answer key/i);
  assert.match(execution, /review-gates.md's neutral brief[\s\S]+omit the desired verdict, writer identity and\s+prior findings on a first review/i);
  assert.match(template, /minimum sufficient independent lenses for unresolved\s+decision-changing questions under the assignment and effective protocol/i);
  assert.match(protocol, /Lead selects the minimum sufficient independent mandates/);
  assert.match(protocol, /task-selected stop condition and\s+authorized effort\/resource bound/);
  assert.doesNotMatch(protocol, /at most \*\*two correction\/re-check|at most one challenge|two-axis gate/);
});

test('review selection distinguishes not-required from waiver and preserves declared obligations', () => {
  const review = read('src/references/review-gates.md').replace(/\s+/gu, ' ');
  const delegation = read('src/delegation.md');
  const common = read('src/common.md');
  const peer = read('src/roles/peer.md');

  assert.match(review, /`not-required` is a reasoned selection decision/);
  assert.match(review, /`exempt` is an authority-backed waiver of an otherwise required gate/);
  assert.match(review, /New scope declarations choose an explicit review plan/);
  assert.match(review, /explicit `reviewPlan: null`[\s\S]+compatibility opt-in/);
  assert.match(review, /Omitted plans on redeclaration retain the prior decision/);
  assert.match(review, /Exact request retries retain their original effective decision/);
  assert.match(review, /Legacy stored null plans and historical rounds retain their obligations/);
  assert.match(review, /authorityRef`, `ruleRef` and `reason` remain claims/);
  assert.match(review, /zero lenses and null `exemptionClass`/);
  assert.match(review, /nonblank `exemptionClass`/);
  assert.match(review, /empty observation set[\s\S]+measured candidate[\s\S]+standing and historical approval/);
  assert.match(review, /Brief, declaration or mandate changes invalidate dependent standing reviews/);
  assert.match(review, /No transition can supply a smaller required set/);
  assert.match(review, /Dropping mandates after adverse findings to evade obligations is prohibited/);
  assert.match(common, /Review selection never waives a Human, assignment or protocol obligation/);
  assert.match(delegation, /An absent explicit selection is an open decision/);
  assert.match(peer, /Reviewer and optional Auditor mandates remain independent of the writer and\s+accepting owner/);
});

test('Lead adjudicates material findings without consensus or reproduction-only acceptance', () => {
  const review = read('src/references/review-gates.md').replace(/\s+/gu, ' ');
  const lead = read('src/roles/lead.md');

  assert.match(review, /distinct from the writer and accepting owner/);
  assert.match(review, /A single seat may cover related questions/);
  assert.match(review, /Additional seats address distinct unresolved risks or separation needs/);
  assert.match(review, /Spec and Standards are optional descriptive lenses/);
  assert.match(review, /Lead adjudicates each material finding with a reason, supporting or contrary\s+evidence and residual risk/);
  assert.match(review, /Unanimity, severity alone or successful reproduction is not a verdict rule/);
  assert.match(review, /Missing Human-required proof or constraints cannot be accepted as recorded risk/);
  assert.match(lead, /Record the review selection and its reason before the candidate round/);
  assert.match(lead, /With no material review question or trigger, require candidate and adequate proof/);
  assert.doesNotMatch(review, /Two default axes|package default is separate Peer seats|fixed baseline applying even/i);
});

test('maintained onboarding and protocol use selection and task bounds without fixed review recipes', () => {
  const paths = ['src/delegation.md', 'src/references/review-gates.md',
    'src/references/orchestration.md', 'src/templates/workspace-protocol.md',
    'skills/paseo-slp-onboarding/SKILL.md',
    'skills/paseo-slp-onboarding/references/custom-interview.md',
    'skills/paseo-slp-onboarding/references/repository-configuration.md'];
  for (const path of paths) {
    assert.doesNotMatch(read(path), /parallel seats on split axes|Two default axes|gate defaults to independent Spec \+ Standards|frozen candidate → Spec\/Standards|default one\)/i, path);
  }
  const protocol = read('.paseo-slp/workspace-protocol.md');
  const template = read('src/templates/workspace-protocol.md');
  assert.match(protocol, /Exhaustion is not ACCEPT/);
  assert.match(template, /task-selected stop condition and\s+authorized effort\/resource bound/);
  assert.match(protocol, /\*\*R1:\*\*[\s\S]+verbatim `sha256sum <test file>` output captured immediately before mutation/);
  assert.match(protocol, /\*\*R2:\*\*[\s\S]+replayed, pinned log is the evidence of record/);
  assert.match(protocol, /do\s+not turn mutation testing into a check for every task/);
});

test('Supervisor recovery contact preserves Lead decisions and shared-state reconciliation', () => {
  const supervisor = read('src/roles/supervisor.md');
  const governance = read('src/references/governance.md');

  assert.match(supervisor, /discuss architecture and direction with Human[\s\S]+Lead owns project technical decisions and acceptance/i);
  assert.match(supervisor, /Human explicitly grants recovery contact with\s+that Peer/i);
  assert.match(supervisor, /reconcile\s+its evidence and any proposed work change into Lead's shared task state/i);
  assert.match(governance, /Human may explicitly\s+grant Supervisor recovery contact with a named Peer for a bounded purpose/i);
  assert.match(governance, /reconcile the exchange,\s+evidence and any proposed change into Lead's current brief or checkpoint before the\s+work direction changes/i);
  assert.match(governance, /Contact alone grants no Peer write scope or authority to\s+change objective, technical decisions, priority, integration or acceptance/i);
});

test('task continuity points to material state and keeps claims separate from proof', () => {
  const orchestration = read('src/references/orchestration.md');
  const records = read('src/references/report-records.md');

  assert.match(orchestration, /For\s+multi-owner or changing work, identify the operative brief revision and point to\s+material decisions, outcome evidence, notifications, open dependencies and next\s+actions/i);
  assert.match(orchestration, /single bounded task may use one inline brief/i);
  assert.match(orchestration, /Messages and semantic claims are\s+coordination inputs, not proof of work or acceptance/i);
  assert.match(records, /A handback is the seat's bounded result and evidence for its assignment; it is\s+not project acceptance, a write grant or resource settlement/i);
  assert.match(records, /handoff changes\s+ownership only through the authorized transfer process after the old owner is\s+settled and the successor acknowledges it/i);
  assert.match(records, /Messages and record claims route\s+information but do not prove work occurred or accept a candidate/i);
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

  assert.match(lead, /When context loss or degradation makes task decisions or evidence unreliable to\s+recover, propose an authorized handoff without a numeric compaction threshold/);
  for (const field of ['objective and scope', 'handoff reason', 'accepted and rejected decisions with reasons',
    'evidence and candidate/review state', 'rejected alternatives', 'dependencies, owner IDs and readiness',
    'next action', 'notebook/checkpoint', 'resource and wake owner IDs with receipts', 'unknowns/limits']) {
    assert.match(governance, new RegExp(field.replaceAll(' ', '\\s+')), `governance includes ${field}`);
  }
  assert.match(governance, /do not define a\s+schema for `handoff\.state`/);
  assert.match(template, /using the state fields in installed governance rules/);
  assert.doesNotMatch(template, /accepted and rejected decisions with reasons|evidence and candidate\/review state|resource and wake owner IDs with receipts/);
});

test('bounded task settlement waits for Delivery and open correction or re-review closure', () => {
  const orchestration = read('src/references/orchestration.md');
  const monitoring = read('src/references/monitoring.md');
  const template = read('src/templates/workspace-protocol.md');
  const protocol = read('.paseo-slp/workspace-protocol.md');

  for (const [name, body] of [['orchestration', orchestration], ['monitoring', monitoring], ['template', template]]) {
    assert.match(body, /Delivery\s+completes/iu, `${name} names Delivery completion`);
    assert.match(body, /no\s+correction or re-review remains open/iu, `${name} waits for rework closure`);
  }
  assert.match(orchestration, /same write owner\. Ask the same independent\s+Reviewer to recheck the new stable candidate/);
  assert.match(monitoring, /same authorized write owner and\s+independent review seats available while that task has rework/);
  assert.match(template, /Keep the same write owner and\s+independent review seats available for correction or re-review/);
  assert.match(template, /Settlement does not\s+itself archive, kill or reparent sessions/);
  assert.doesNotMatch(template, /assignment that formed the team closes|batch archive/i);
  assert.match(protocol, /Keep an idle session only for assigned rework with an expiry\./);
  assert.match(protocol, /Monitoring needs\s+an assignment, owner and stop condition\./);
  assert.match(protocol, /\| Delivery\/completion \| Artifact and evidence for Human acceptance unless the assignment specifies otherwise \|/);
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
  assert.match(provider, conditionalJevPointer);
  assert.match(execution, /Read `references\/provider-routing\.md` before runtime selection/);
  assert.doesNotMatch(execution, /When `routes` reports\s+`jevRouting\.routing`/);
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
  assert.match(repoProtocol, /^version: ['"]?11['"]?$/m);
  assert.match(repoProtocol, /^## Gate$/m);
});

test('cross-project dependency relay preserves Lead authority and uses an authorized bounded digest', () => {
  const governance = read('src/references/governance.md');
  const orchestration = read('src/references/orchestration.md');
  const contract = read('docs/contract.md');

  assert.match(governance, /only when the current assignment explicitly\s+grants the relay and the recipient Lead and route are verified/);
  for (const field of ['from/to project,', 'task and Lead IDs', 'dependency/interface', 'minimal evidence pointer',
    'request; answer,', 'blocked branch and owner', 'Human decision or additional authority needed', 'timestamp or receipt']) {
    assert.match(governance, new RegExp(field.replaceAll(' ', '\\s+')), `governance digest includes ${field}`);
  }
  assert.match(governance, /If the grant,\s+route or data authority is missing or unclear, keep the dependent branch BLOCKED/);
  assert.match(governance, /without\s+judging the interface, accepting work, granting write,\s+priority, merge or\s+integration authority/);
  assert.match(orchestration, /For cross-project relay, follow references\/governance\.md/);
  assert.match(contract, /cross-project relay/);
});
