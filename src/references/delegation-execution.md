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
ownership/handback acknowledgment complete its first phase, not the future
project. Record that exception and current scope/report route/readiness.
Broader audits await the concrete task; its grant continues this Lead
without relaxing any Peer outcome boundary.

Supply outcome/acceptance, real constraints, provisional choices/unknowns,
owned/excluded scope, current phase/grants, dependencies, relevant skills,
proof/effort bounds and your exact report-recipient ID. Use review-gates.md's
neutral brief for review and pin sealed visibility when selected. Keep
formation in that brief/receipt: parent, seat, workspace/cwd, reason for any
isolation and baseline work/resources. Need no separate formation file.
For parallel work use orchestration.md's actual paths/shared-resource preflight.

## Form and deliver

Use bound slp_seat_create by default with requestId, role, taskLabel, assignment and grantRef.
grantRef is a declared pointer to the Human grant (e.g. assignment sentence
and date), a claim, never authenticated; verify authority, one writer and review sufficiency.
Lead formation resolves the saved slp-lead profile; Peer runtime is optional.
The server selects once under provider-routing.md, retaining full-pin compatibility.
Use selection for independent choice; no settings overrides.
Placement defaults to caller; existing worktrees need declared paths/reason.
It qualifies same-Git workspace/cwd and pins routing/protocol separately.
Placement/automatic runtime/selection waits briefly for exact registration;
legacy omitted full-pin Peer/Lead keeps its delivery path. Pending directs
slp_operation_get with the same requestId: immutable evidence, no resume/recreate.
SDK open may revive archived workspaces; prefer active IDs. Source configuration
drift blocks delivery; same-Git identity alone grants no authority.
Need a worktree? Lead uses Paseo create_workspace, owns its host setup within
the grant, then calls slp_seat_create with placement existing and that workspace
ID. Do not return to create_agent. V1 kind=worktree reports a gap before effects.
The server creates without work, observes the exact tuple, then hands off. By default
(delivery "caller") it does not send: the result is awaiting-caller-delivery
with delivery.prompt; send exactly that prompt through send_agent_prompt with
notifyOnFinish=true so the host arms the finish callback. delivery "server"
sends without a callback; use only when none is needed.
The created assignment names the verified parent agent ID and requires exactly
one native report to that parent at handback. A standby Lead reports readiness
separately from technical verdicts; create no back-and-forth acknowledgment loop.

Read result/phases, not outer ok. Same-input replay and slp_operation_get
read immutable evidence by original kind/requestId; partial/uncertain effects
never continue. Native identity survives membership epochs; original epoch
stays pinned. Fresh callers may read historical evidence with
callerEpochMatches=false; mutation under another epoch is denied.
Legacy addresses remain untouched; ambiguous/corrupt/over-budget evidence
blocks admission. Retain returned IDs/scope and reconcile host evidence;
follow-up needs separate authority and safety. Receipts establish no acceptance
or cleanup; the native report establishes the route, not acceptance.

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

Use monitoring.md for event waits and bounded fallback wakes. On a finish,
retrieve the actual report/artifact through status/activity/timeline access;
curated tails may omit it. Missing report access blocks acceptance; idle is
no verdict. Same-assignment follow-ups preserve the verified child with
background/notifyOnFinish. A separately Human-authorized stock Codex/Pi
prepare fallback may render role bytes; a legacy provider/title proves no load.
