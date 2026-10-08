# Ordinary delegation and observation

For desk-managed task dispatch, use task-execution.md without duplicating its bookkeeping.

## Classify and brief

Classify from the actual assignment, not available sessions:

| Assignment | Action |
|---|---|
| New bounded team/outcome | Its parent forms Lead/Peer under Form and deliver. |
| Reliable continuation/correction/re-review or phase of the same outcome | send_agent_prompt to the verified child with the added grant. |
| Observe existing work | Pin owner ID, observation scope and explicit report recipient; retain real parentage and write owner. |

When Human asks
to form a standby Lead for a future task, record that formation exception:
read-only orientation and ownership/handback acknowledgment complete its
first phase, not the future project. Its acknowledgment covers current scope,
report route and readiness; broader document audits belong to the concrete
task. The concrete task/grant continues this Lead; it relaxes no Peer outcome
boundary.

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
Lead formation resolves the fresh saved slp-lead
profile; Peer formation additionally needs explicit runtime option/hash and
any required Jev decision under provider-routing.md. The bound caller supplies
native parent/workspace/cwd. No caller request file, copied create arguments
or task queue enrollment is required. The server creates without work, observes
the exact native tuple and only then hands off the assignment. By default
(delivery "caller") it does not send: the result is awaiting-caller-delivery
with delivery.prompt; send exactly that prompt through send_agent_prompt with
notifyOnFinish=true so the host arms the finish callback. delivery "server"
sends in the server without a callback; use it only when none is needed.
The created assignment names the verified parent agent ID and requires exactly
one native report to that parent at handback. A standby Lead reports readiness
separately from technical verdicts; create no back-and-forth acknowledgment loop.

Read the operation's result and phases, not just its outer ok. Replaying the
same input reads the immutable receipt; slp_operation_get reads it by original
kind/requestId. Partial or uncertain create/send never continues on replay. Identity stays
stable across caller membership epochs; the receipt keeps the original epoch.
A fresh bound native caller can read its own historical receipt with
callerEpochMatches=false, but invoking it under another epoch is denied.
Retained early-format addresses are located without copying or resealing;
ambiguous, corrupt or over-budget legacy evidence blocks a new invocation.
Retain any returned agentId and scope, reconcile original host evidence and
use a separately authorized explicit follow-up only when safe. Receipts retain
resources and do not establish acceptance or cleanup. The native report establishes the handback route, not acceptance.

For unbound/older hosts or declared isolated placement, use provider-routing.md, prepare --emit create
and agent-scoped Paseo create_agent with its emitted record and notifyOnFinish=true;
pass taskLabel/disposition (review taskLabel uses `<task> / <lens>`).
assignmentFile or validated opt-in snapshot supplies the brief. Use an available
final-report callback to retrieve the actual report; inspect its evidence before a verdict.
Default placement is the pinned parent workspace, including read-only review;
a different checkout/lane needs declared paths/reason; if protocol/references
are missing, use authorized `slp.mjs materialize <target> --from <source>` with
explicit --include inputs before preparation, without installation/host authority.

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
