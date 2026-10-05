# Ordinary delegation and observation

Use for Supervisor/Lead formation outside desk-managed task dispatch.
For managed tasks, task-execution.md owns the operating path; avoid repeating
its reservation, runtime verification or effect bookkeeping manually.

## Classify and brief

Classify from the actual assignment, not available sessions:

| Assignment | Action |
|---|---|
| New bounded team/outcome | Its parent creates Lead/Peer through agent-scoped create_agent. |
| Reliable continuation/correction/re-review or phase of the same outcome | send_agent_prompt to the verified child with the added grant. |
| Observe existing work | Pin owner ID, observation scope and explicit report recipient; retain real parentage and write owner. |

A direct Human-assigned Lead is valid without a Supervisor. When Human asks
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

When advertised, use slp_seat_create with requestId, role, taskLabel,
assignment and grantRef. Lead formation resolves the fresh saved slp-lead
profile; Peer formation additionally needs explicit runtime option/hash and
any required Jev decision under provider-routing.md. The bound caller supplies
native parent/workspace/cwd. No caller request file, copied create arguments
or task queue enrollment is required. The server creates without work, observes
the exact native tuple and only then sends the assignment. grantRef is a claim;
the caller still verifies authority, one writer and review sufficiency.
The assignment names outcome, constraints, granted effects and proof/handback.
Assignment được tạo ghi rõ parent agent ID đã xác minh và yêu cầu đúng một
native report tới parent đó khi handback. Với Lead standby, báo readiness
riêng với phán quyết kỹ thuật; không tạo vòng acknowledgment qua lại.

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
resources and do not establish acceptance or cleanup. SDK create/send path
này không xác lập finish callback; yêu cầu child gửi đúng một native report
đến observed parent và dùng monitoring.md cho phần giám sát còn lại. Báo cáo
đó thiết lập tuyến handback, không phải acceptance.

For an unbound/older host or declared isolated placement, CLI prepare remains
compatible: use provider-routing.md, prepare --emit create and agent-scoped
Paseo create_agent with the emitted record and notifyOnFinish=true. Pass
taskLabel/disposition; review taskLabel uses `<task> / <lens>`. An assignmentFile
pointer or validated opt-in snapshot remains available on that CLI path.
Khi compatibility host hỗ trợ final-report callback, dùng callback để lấy
báo cáo thực tế của child. `notifyOnFinish` hay callback chỉ báo delivery;
hãy đọc report và evidence trước khi đưa verdict.
Default placement is the pinned parent workspace, including read-only review;
a different checkout/lane needs its declared paths/reason. If it lacks
protocol/references, use authorized `slp.mjs materialize <target> --from <source>`
and explicit --include inputs before preparation; this grants no installation
or host edit.

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
