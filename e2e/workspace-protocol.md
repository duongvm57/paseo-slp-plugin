# Package dogfood protocol

This is the repository tactic for running the package's E2E suite. It does not
change global SLP roles or grant runtime authority. A run tests one frozen package
candidate on explicitly identified host/provider/model/effort configurations.

## Basic flow launch

For `basic-*` scenarios, this section takes precedence over the
independent prelaunch confirmation and evidence-access launch gates below.
The objective is to exercise Supervisor → Lead → Peer on a real repair.

Use the current Paseo host and an independent fixture workspace. A separate daemon
or host selector is not required for basic flows; isolation requirements belong
to scenarios that explicitly test installation, global scope or host faults.
Preserve unrelated host resources and obtain runtime cutover authority if needed.

The coordinator checks the installed candidate/bindings, matching saved profiles
and provider availability, then writes the attempt config, creates the fixture,
completes its protocol and records the failing baseline. Use the checked-in public
contract and `e2e/check-outcome.mjs`; no paid confirmer or Human approval of a draft
is required. Launch the Supervisor as soon as these checks pass. Missing draft
fields are coordinator work to complete, not a reason to defer the scenario.

Record a bounded time/agent budget from the assignment. If Human supplied no
budget, use 45 minutes and at most six agents including coordinator, the three
SLP actors and final suite reviewer, with one spare slot. A new explicit request
to run again supplies a new default window; on resume retain elapsed history and
record the renewed window rather than silently rewriting it. An explicit Human
cap or stop remains binding. A future deadline is not a blocker: use remaining
time; at expiry settle activity and report unfinished work.

Collect available evidence during execution. An unavailable native transcript or
other observability path does not prevent the basic task launch: record the gap
and let final review mark the affected criteria BLOCKED. Do not fabricate proof
or claim PASS. Keep final outcome checks, independent acceptance review, frozen
evidence and resource settlement. Report task execution separately from evidence
qualification so an evidence gap cannot be mistaken for an unattempted workflow.

## One-session ownership

The coordinating session owns suite progress, evidence and the consolidated
handback. Paseo owns all live scenario actors, independent reviewers, workspaces
and wake sources. Actors use installed SLP entry paths; the coordinator gives the
initial assignment and declared external stimuli. Lead still selects runtime
options, creates its Peers, reconciles their evidence and owns task acceptance.
An external suite reviewer owns only the E2E verdict.

Use one writer for the run ledger. Persist each created resource's host ID, owner,
scenario/attempt, creation receipt and required settlement action immediately.
After interruption, read the ledger and inspect the recorded resources before
resuming; an unfinished attempt is resumed, not launched again. Do not infer
parentage from labels or relocate existing user agents into the suite.

Every prompt entering the SLP tree from outside reads as a direct Human
instruction. A driving session never reveals an intermediate layer: no
"via coordinator", "on behalf of Human", or "Human says resume". Exposing an
intermediate agent layer adds an authority gradient and distorts what the run
measures. This conductor rule binds the coordinator and any external driving
session; it does not govern Supervisor/Lead/Peer exchanges inside the tree.

## Preflight and authority

Resolve the Human's existing mandate once for the whole run: fixture locations,
isolated host installation/reload, project/global skill placement, agents,
worktrees, model/effort/budget, controlled faults, permission responses, stop,
recovery and resource cleanup. Reuse it for all scenarios it covers. Commit,
push, deployment and changes to unrelated repositories require their own grants.
Fixture worktree scenarios need an authorized fixture-only base commit; the
fixture helper itself only initializes Git and never commits.

Prefer an isolated test daemon/home with existing authorized provider access.
Discover how the actual host accepts configuration and tool calls; a directory
called “test home” does not prove process isolation. Global skill scenarios need
an isolated user scope or specific permission to change and restore the real
scope. Record existing sessions, config, workspaces, scripts, terminals, schedules
and observable task processes before mutations. Preserve unrelated resources.
Missing isolation/authority marks the affected rows BLOCKED; continue other rows
whose prerequisites are available.

The attempt config pins host/provider versions, actual model/thinking/mode/features,
candidate install paths, budget and the independent confirmer's prelaunch approval
of checklist/outcome check. Use fresh Human-configured role profiles; no model
defaults belong in this protocol. Bound total
run cost/agents/time as well as each attempt, counting reviewers and retries.
Where cost telemetry is absent, record that limit; agent/time caps do not prove a
monetary cap. Record startedAt and deadline before run preparation begins; include
setup, confirmation, retries, collection and review in elapsed time. Reserve time
and an agent slot for final review. The init run config carries the declared
bound (`scope`, `budget`, `deadline`); `begin` refuses new launches past a
recorded deadline, so a resume preserves it and a new budget
requires Human authority. At the deadline stop launches and observation, then
finish authorized settlement and report any unperformed review as NOT_RUN.

### Prelaunch confirmation

Give the confirmer the frozen checklist, public task contract, external check
implementation and a completed draft containing candidate/binding, actual host
discovery, role settings, budget/deadline, evidence paths and cleanup/retention.
It judges whether the proposed check and procedure can test the assignment.
The fixture is created after approval and `begin`; its failing baseline and final
profile/settings verification are subsequent launch gates. Spawn parentage, proof, verdict and
cleanup are postlaunch evidence, not prerequisites for approving this plan.
Correct an incomplete draft and have the same confirmer reassess the corrections.

Compare the installed candidate with the frozen source and verify host bindings.
For basic-* scenarios, Supervisor/Lead saved profiles use the corresponding
slp-{family}-{role} providers. Human chooses their models/settings in Paseo.
Peer uses the fixture's project pool; prepare eligible options for the row family
under setup authority. No saved slp-peer is required. Mixed-peer uses both Peer
families and does not require switching Supervisor/Lead profiles to match each Peer.

Basic begin requires settings.source="profiles-and-peer-pool", settings.profiles,
settings.providers and settings.peerPool (the proposed catalog). It records
settings.roles for Supervisor/Lead only; ordinary Peer formation resolves its
option on the server, with independent Lead choice when requested.
Raw receipts, model capability discovery and matching fixture pool bytes still need
review. Frozen older manifests retain their saved-profile criteria. Candidate
alignment uses upgrade/reload only under current runtime authority.

Before task launch, inspect the selected modes and permission behavior for the
role's required reads, delegation and fixture writes. Record the authorized
permission-response policy; mode names alone do not prove permission-free use.
Resolve known setup gaps within existing authority. Preserve explicit mode choices
and host safeguards; record any remaining gate rather than silently broadening
access. Any permission response during observation remains an intervention.

## Execution and evidence gate

Honor a Human-selected subset; record unselected rows NOT_RUN with the scope reason.
For full-suite runs, run isolated setup/onboarding and basic-* rows first. Advanced
rows list their basic-flow dependencies in the manifest. These gates apply to
the same candidate and host setup. A gate failure blocks dependent rows; direct
Lead, transport, routing and independently runnable notification checks may
continue within the selected scope. Every row remains in the report. Report a
scoped basic run as such, without implying the full suite passed.

Before a paid launch, prove an available collection path for its required
evidence. Inventory tool declarations and inspect actual read-only output to
establish access. Required U2 evidence includes provider command, installed bytes,
actual initial/resume input, launch settings, parent create arguments and the
triggered reference reads. Curated activity summaries and agent self-reports do
not replace those records. Record a host gap before choosing an authorized
fallback. An inaccessible instruction/timeline/resource path leaves the matching
criterion BLOCKED even when the task result is correct.

Use fresh fixture copies. Basic repairs use the quantity defect; integration,
council and dependency trials use independent line-total and discount defects.
Keep external acceptance vectors outside actor workspaces and confirm the public
contract before launch. The coordinator can configure initial eligibility and
scenario constraints, but must not precreate Lead's descendants, choose its
per-spawn routes or supply the code fix. Dependency and sealed-review cases must
use observable scope/visibility boundaries. Record actual boundary violations;
policy instructions alone do not prove filesystem/tool isolation.

### Fixture setup and launch gate

The coordinator runs in the package checkout; task actors run in a separate
fixture Git root. A package checkout with no `.paseo-slp` files is valid. Never
initialize it as a substitute for the fixture or copy this test protocol into
the fixture as its role protocol. The fixture helper creates only the code task.
The E2E skill's **Prepare the task repository** procedure supplies the missing
onboarding step, even when only a basic scenario is selected.

Complete the fixture's `.paseo-slp/workspace-protocol.md` from the installed
template and current assignment. Set the actual root/owner, writable and excluded
scope, task class, topology/proof gates, concrete time/agent budget, allowed
operations, quota fallback boundary, observation and cleanup policy. For
`basic-*` scenarios, require Supervisor → Lead → an Engineer Peer for this
test, followed by proof, Lead inspection/verdict and Supervisor handback. This
fixture tactic follows the policy that implementation writes belong to
Peers. Preserve the public task contract and Human note; use bounded event-driven observation and
create heartbeat only when the selected scenario and mandate require it.
Include this task acceptance tactic in the fixture protocol: for each changed
behavior, Lead derives an expected result from the public task contract and
checks it against the stable candidate independently of the Peer's expected
values. Record the input, contract-based calculation, actual result and verdict.
If the contract supports conflicting interpretations, resolve that premise before
acceptance. Re-running the Peer's tests alone does not establish their oracle.
For a newly generated fixture, replace the template with the resolved tactics
directly; there is no need to retain unused template sections. Existing Human
protocol/routing choices on resume remain authoritative.

For task scenarios, record the saved Supervisor/Lead profiles and the project Peer
pool separately. Populate complete eligible pool options with suitability notes;
init writes no catalog — a fixture without one is not ready for Peer delegation.
Routing scenarios change this same pool at their declared trigger. Do not
preselect each Peer option for Lead.

Capture protocol/pool bytes and raw profile/provider/model/capability discovery
before root launch. Refresh the two saved profiles and compare with preflight;
reconcile Human changes before launching. Preserve prior receipts on resume.
Verify the workspace's actual path equals fixtureRoot on the target host.

Create only Supervisor using its saved profile through Paseo create_agent. Record
profile bytes, exact request/response and actual runtime settings. Supervisor
forms Lead through slp_seat_create from the fresh saved slp-lead profile.
Lead forms ordinary Peers through slp_seat_create with runtime/selection omitted;
when choices are returned, it supplies an independent selection.optionId.
The server pins the pool/Jev route; record the returned option/hash/settings and,
under armed Jev, the retained decision receipt's distribution. The
routes/prepare/create_agent chain is only CLI compatibility on its assigned path.
Profile inventories cannot override the Peer pool. U2 traces profiles for
Supervisor/Lead and project option/hash/settings for Peer, including both families
when mixed-peer is selected.

For every seat the scenario tree forms, record the formation evidence: the
calling parent's ID, the desk formation receipt and native SDK create evidence
(or agent-scoped create_agent request/response on compatibility), the returned
child ID with its host parent, workspace/cwd and the report recipient named in
the brief. A prompt sent into a pre-existing session is not a create and
establishes no parentage; observe-existing assignments keep the seat's real
parent and record their own explicit report recipient. Same-team seats share
the assignment's pinned workspace unless a declared worktree, repository or
lane-isolation reason is recorded with its resulting paths — a second
workspace on the same checkout does not count as isolation. Continuation
reuses the verified existing child; respawning a seat per correction round is
a formation defect to record, not a routine choice.

Onboarding scenarios deliberately start with their declared absent/existing-file
baseline and test fresh-session skill discovery. Let those setup actors produce
the files; coordinator initialization must not pre-satisfy their assertions.
Neither this exception nor an installation trial permits a subsequent code task
to launch with unresolved repo protocol or required profile settings. Negative routing rows may invalidate
config after recording a valid baseline, at the declared trigger; a removed repository catalog resolves the
user-scope pool, so rejection requires invalidating the resolved catalog or both scopes.

For each row pin the outcome appropriate to the branch. Repair/integration uses
the external checkout contract. Onboarding uses discovery and preserved config;
installation uses live loading and config preservation. Stop tests succeed by
honoring the stop and settling resources, and may leave the code task unfinished.
Negative routing tests expect explicit rejection without a spawn, followed by an
authorized positive control. An expected rejected action is not itself suite FAIL.

Capture raw evidence as it becomes available. Append each operator action with
timestamp, actor/request ID, action/response, authority, phase (setup, observation,
settlement) and source receipt. Include permission approvals/denials and corrective
prompts even when authorized or sent by another coordinating session. Reconcile
the ledger with coordinator transcripts before reporting duration and counts;
unknown counts remain unknown. Authorized permission handling is still intervention,
and task success with assistance is distinct from an unassisted workflow.
Predeclared Human decisions, stop stimuli and fault injection are part of a test;
coaching a stalled role, doing its work or editing the candidate to rescue the
attempt is assistance and prevents an unassisted PASS. Keep that attempt and use
a fresh one after a repair. Unexpected product decisions return to Human within
the original mandate, without repeatedly asking routine setup questions.

## Faults, waiting and settlement

For Human-stop trials, use [the executing stop watcher](stop-boundary.md).
A declared observer JSON file is not a running observer. Verify its startup PID,
readiness dispatch and actual owner receipt before claiming an active-stop boundary.

For a controlled cancellation trial, use [the inspection-first boundary procedure](recovery-boundary.md)
before task launch. It separates initial read-only authority from post-settlement
implementation and checks the actual call order. A prerequisite violation is an
observed failure even if the ordinary repair later passes; a missed cancellation
window alone remains NOT_REPRODUCED. Neither result qualifies recovery.

Declare the trigger, target and injection layer before each fault test. Quota JSON
changes test catalog selection only. A quota simulation must enter the discovered
provider/host error boundary and expose the corresponding real host signal;
label it simulated. Genuine provider quota behavior remains unqualified unless
actually observed. An unavailable injection facility blocks that scenario.

For `role-transport` (resume-*) rows, the default stimulus is the supported
per-agent boundary `paseo agent reload <id>`: the daemon closes the session
process and rebuilds it from the persistence handle via `session/load`, which
re-arms the role bytes on the next prompt. Fire it while the target role holds
an unfinished assignment — Supervisor/Lead mid-orchestration (descendant live,
verdict pending) or Peer mid-repair — then prompt the same agent to continue
and verify in the native session store that the resume prompt carries the
re-injected role block; the activity view may show only the prompt tail. Record
the reload receipt and both boundary settings in `instructions`, and the reload
itself as the declared intervention. `agent reload` cancels an in-flight turn
cleanly, so it qualifies resume semantics, not mid-tool-call crash recovery.
`paseo daemon restart` is a Human action: host-wide, it kills every transport
on the daemon including unrelated projects — never run it as a routine stimulus
and only with explicit Human authority when the scenario intends daemon-loss
recovery. Killing an individual wrapper process is not a valid boundary: the
daemon does not respawn dead children and the next prompt stalls — record that
host gap rather than working around it.

Use the same boundary for recovery when an actor's transport dies mid-run but
its native persistence survives (observed: an ACP transport error failing even
a retried prompt). The ordering is reload > respawn > reassign: `paseo agent
reload` first, preserving parentage and context; respawn a fresh actor only
when reload cannot recover it; reassign the assignment to a new owner only
after the old owner's settlement is verified. Retrying a prompt on the dead
transport is not a recovery move. Record whether each reload was stimulus (a
declared role-transport intervention) or recovery (a repair on the attempt
timeline); only the former satisfies a resume-* assertion.

Use Paseo's finish/error/permission notifications; collect evidence when signalled.
Heartbeat trials use actual timed delivery to the caller/owner with maxRuns or
expiry and owner-scoped deletion receipts. Discover the host's actual semantics.
Neither a manual prompt nor a new-agent schedule substitutes for a heartbeat.
Record gaps in list/delete/access capabilities instead of assuming a schedule
inventory lists heartbeats.

Polling/loop debt (§9.10) binds in-tree agents holding a live turn with
sleep/status loops. It does not bind sessions outside the tree — a
coordinator or observer between turns — whose periodic external inspection
is bounded by its declared cadence, logging and settlement instead. Keep one
fixed file-backed poller running for the whole run: it accumulates
observations while the coordinator is asleep, and on each wake the
coordinator diffs its log against the Supervisor notebook. Removing the
poller "because §9.10" is a misapplication; fix its defects in place.

An observer outside the tree may poll friction and evidence at its declared
cadence and feed the Supervisor open questions — never verdicts, and never
direct prompts to Peers (§9.17 supervisor overreach). It is a supplementary
observation channel beside event-driven waits, not an actor with authority
in the tree.

A non-agent coordinating session has no agent-scoped wake source: it cannot
arm a heartbeat, and notifyOnFinish covers only the prompted turn. The
default coordinator-wake design is a cheap watcher agent that runs
`paseo agent wait` on the tree (or its root actor) and finishes; the
watcher's own finish notification wakes the coordinator. An accepted
alternative is the Supervisor pinging a coordinator-visible channel at
declared milestones. The watcher is a coordinator-owned resource: record its
ID and spawn receipt, and cancel it during settlement once the awaited actors
reach terminal state or observation closes.

A time budget ending closes observation, not lifecycle. Execute only authorized
stop/cleanup. Settle descendants, pending permissions, scripts, terminals,
task-owned processes and wake sources, then collect after-state and a bounded
late-wake observation for applicable rows. Preserve receipts even if cleanup fails.
For this repository's dogfood, retain agents and workspace visibly for Human
inspection by default. Carry this retention choice in the fixture protocol and
root assignment so descendants follow it. Cleanup means settling activity and
wake sources; archive requires an explicit request. Retained agents are intentional
resources: record IDs, owner, stopped/finished activity and absence of pending
task work, callbacks or processes. Idle alone is insufficient. When archive is
requested, save artifact bytes first and collect its actual receipt before seal.
Unknown settlement is U7 BLOCKED; observed abandoned resources are U7 FAIL.
Freeze the final evidence after settlement. The suite reviewer is a suite-owned
resource outside the scenario tree: record its launch/result/settlement beside
its separate review before the suite handback, and account for the coordinator's
own wake sources. Review must not mutate the scenario's frozen report.

### Before sealing

Apply this audit after task handback (or stop/failure settlement), before `seal`:

1. Copy each actor's raw transcript again after its last relevant event. Keep
   earlier copies as checkpoints. Correlate agent/runtime IDs, capture time and
   final event with the host record; verify that final copies include each parent
   spawn request/response, Peer proof, Lead inspection/verdict and Supervisor
   handback where required. For stop/failure, capture that branch's final report.
2. Collect the coordinator's relevant raw requests/responses as kind `coordinator`, including root
   launch, operator interventions and settlement. Preserve source provenance;
   use a fresh run-only coordinator context so its native transcript is safe to
   freeze. Agent ID labels or a curated summary do not replace host parentage and
   actual spawn evidence. Use `collect-coordinator <attempt>
   <native-session.jsonl> <native-session-id>` to embed the native transcript bytes,
   then decode the collected record to inspect them. Version 2 rejects sources
   inside the run directory and requires the session ID in both filename and JSONL.
   If native bytes are unavailable or require redaction, declare the gap rather
   than reconstructing a transcript from the ledger.
3. Bind actor checks, external outcome checks, artifact bytes and before/after
   verification snapshots to the stable task candidate. Record actual commands,
   outputs and exit codes; a hand-written success summary is not a check receipt.
4. Reconcile intervention counts and elapsed time, and collect actual resource
   settlement receipts plus the retained-resource inventory. After a finish event,
   read each actor again until the host exposes a terminal state. If it still shows
   an active turn, use the authorized lifecycle settlement operation and re-read it;
   do not combine `running` and `finished` into a synthetic terminal label. Freeze
   the reconciled version 1 receipt with `collect-resources`. An unresolved entry,
   active/unknown actor state, cleanup plan or path to a live log cannot satisfy U7.
5. Index the required events to collected files for each assertion and U1–U7.
   Inspect decoded collected bytes, not only original source files or evidence
   kind names. `status <attempt>` previews which records discharge their kind
   and which required kinds are still missing. Fill accessible gaps before
   sealing; if proof is unavailable,
   collect the available receipts and use `seal <attempt> <gaps.json>` with
   `{ "gaps": [{ "kind": "missing-kind", "reason": "concrete host gap" }] }`
   for every missing kind. The incomplete report cannot receive PASS.

`seal` requires a nonempty evidence index and a nonempty payload for every
required kind, including valid `coordinator` and `resources` receipts, unless that kind has an explicit
unavailability declaration. Rejection leaves the attempt open for collection.
These are integrity and structural checks, not event completeness or a verdict. The reviewer must be able to reach
its judgment from these frozen bytes. After sealing, keep new evidence in a
clearly labelled supplement; never rewrite the report or imply an earlier review
covered later evidence. A later reassessment needs a separately identified evidence
set and independent review under remaining authority and budget.

## Acceptance and reruns

Task review follows the installed Lead policy. Within a correction attempt, the
same independent task Reviewer may recheck candidate B; renewed review means new
verification of B, not a compulsory new agent. Reuse the Engineer for corrections
when one already owns that assignment. Preserve A's findings and identities and
record why any replacement or additional independent seat was needed. This does
not relax a scenario's explicit fresh-seat, sealed-boundary or recovery requirement.
The suite acceptance reviewer below evaluates the orchestration evidence and is
separate from the task's Reviewer; its fresh-session rule does not govern every
task re-review.

For non-basic scenarios, Human or a fresh independent reviewer confirms the
outcome check and frozen docs/review-checklist.md before launch. At completion, a fresh Paseo reviewer gets
the objective, public contract, frozen evidence, assertions and checklist, with a
neutral brief. It verifies participant/parentage evidence and the unchanged task
candidate. Reviewer assertions are judgments; the collector checks integrity and
completeness and cannot certify their truth.

PASS requires every U1–U7 criterion and scenario assertion supported by evidence.
FAIL means observed violation. BLOCKED means missing prerequisites or proof.
NOT_RUN means unattempted/unreviewed, or budget/stop prevented execution. Record
the reason, source and scope for each deferral. Default repetitions are declared
per row; they are bounded trials, not a statistical reliability claim. Any failed
attempt keeps the row FAIL for this candidate even if a retry passes.

Seal task evidence and keep independent reviews separate. Package, skill, harness
or acceptance changes require a new run identity. The previous run remains intact;
record impacted scenarios, rerun them and identify any older unaffected evidence
explicitly rather than marking unexecuted rows PASS in the new run. Hand back the
whole matrix, attempts, exact evidence/review artifacts, checks, interventions,
budget use, and all unsettled resources. Textual policy coverage stays separate
from observed live behavior.
