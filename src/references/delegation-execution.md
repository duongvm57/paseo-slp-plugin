# Ordinary delegation and observation

For desk-managed task dispatch, use task-execution.md without duplicating its bookkeeping.

## Classify and brief

Classify from the actual assignment, not available sessions:

| Assignment | Action |
|---|---|
| New bounded team/outcome | Its parent forms Lead/Peer under Form and deliver. |
| Reliable continuation/correction/re-review or phase of the same outcome | send_agent_prompt to the verified child with the added grant. |
| Observe existing work | Pin owner ID, observation scope and explicit report recipient; retain real parentage and write owner. |

Human may explicitly form a standby Lead: read-only orientation and
ownership/handback acknowledgment finish its first phase, not the future
project. Record that exception, scope/report route.
Broader audits await assignment; continue this Lead without relaxing
any Peer outcome boundary.

Brief outcome/acceptance, constraints/unknowns, owned/excluded scope,
phase/grants, dependencies/skills, proof/effort bounds and exact report-recipient ID.
Use review-gates.md's neutral/sealed brief. Record parent, seat,
workspace/cwd, isolation reason and baseline resources there.
For parallel work use orchestration.md's actual paths/shared-resource preflight.

## Form and deliver

Use bound slp_seat_create by default with requestId, role, taskLabel, assignment and grantRef.
grantRef is a declared pointer to the Human grant (e.g. assignment sentence
and date), a claim, never authenticated; verify authority, one writer and review sufficiency.
Lead: saved slp-lead. Ordinary Peer: omit runtime/selection for server
pool/Jev choice (provider-routing.md). Unique requestId/task:

```json
{"requestId":"peer-implementation-1","role":"peer","taskLabel":"bounded implementation","assignment":"Implement the assigned slice and return candidate-bound proof.","grantRef":"current Human assignment"}
```

selection-required with operationAdmitted=false returns choices: choose
independently and add selection.optionId before admission. Shadow needs that
choice; armed obtains its decision server-side. Full-pin compatibility validates
complete pool/Jev pins; no settings overrides.
Placement defaults to caller; existing worktrees need declared paths/reason.
It qualifies same-Git workspace/cwd and pins routing/protocol separately.
Placement/automatic runtime/selection waits briefly for exact registration;
legacy omitted full-pin Peer/Lead keeps its delivery path. Pending directs
slp_operation_get with the same requestId: immutable evidence, no resume/recreate.
SDK open may revive archived workspaces; prefer active IDs. Source configuration
drift blocks delivery; same-Git identity alone grants no authority.
Lead uses Paseo create_workspace, owns its host setup within
the grant, then calls slp_seat_create with placement existing and that workspace
ID. Do not return to create_agent. V1 kind=worktree reports a gap before effects.
Server creates without work, verifies the tuple and returns awaiting-caller-delivery
with delivery.prompt; send exactly that prompt through send_agent_prompt with
notifyOnFinish=true. delivery "server" sends without callback; use only when
none is needed. Assignment names the verified parent ID and requires one native
report there at handback. Standby readiness differs from technical verdict;
avoid acknowledgment loops.

Read result/phases, not outer ok. Replay/operation_get read immutable evidence
by original kind/requestId; never continue partial/uncertain effects. Native
identity survives epochs; original epoch stays pinned. callerEpochMatches=false
permits historical reads only; mutation requires current epoch. Preserve legacy
addresses, IDs and gaps; corrupt/ambiguous/oversized evidence blocks admission.
Receipts grant no acceptance, cleanup or follow-up authority;
the native report establishes the route, not acceptance.

## Refused or uncertain formation

A recorded refusal keeps its original body and requestId. Correct invalid input
with a new requestId only after the retained phases prove no create/send was
issued. After any issued or uncertain effect, keep its IDs and reconcile it;
changing runtime or moving to CLI is not recovery for an uncertain create.

## Compatibility formation

For unbound/older hosts or required compatibility, use provider-routing.md,
prepare --emit create and agent-scoped Paseo create_agent with emitted settings and
notifyOnFinish=true; preserve taskLabel/disposition and the actual parent.
Default placement is the parent workspace, including read-only review;
a different checkout/lane needs declared paths/reason. Existing worktrees use slp_seat_create.
Never install dependencies or materialize to hide a gap; Lead owns the setup
triggered by its authorized Paseo workspace creation.
Retrieve the actual report through the callback before a verdict.

Verify the returned ID against actual host parent/workspace/cwd and bundle.
Confirm the brief's report route when its first report arrives. Titles,
labels supplied by callers and sent prompts prove no relation. Record
unexposed metadata as gaps; take mismatches to the owning parent/Human.
An uncertain create reserves its scope: reconcile the original request with
host evidence before replacement. Empty inventory alone proves no absence.
A replacement needs proof the original cannot still create and any old owner
is settled; unresolved effects BLOCK this branch. Preserve original sessions.

## Retrieve

Use monitoring.md's event waits and bounded fallback wakes. On finish,
retrieve the actual report/artifact through status/activity/timeline access;
curated tails may omit it. Missing report access blocks acceptance; idle is
no verdict. Same-assignment follow-ups preserve the verified child with
background/notifyOnFinish. A Human-authorized stock Codex/Pi
prepare fallback may render role bytes; a legacy provider/title proves no load.
