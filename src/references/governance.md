# Supervision, causal notebook and recovery

Supervisor reads this when establishing supervision, handling failed coordination
or evolving policy. Governance authority and project technical authority are distinct;
Human holds final owner authority. Use assigned scope rather than a fixed hierarchy.

## Establish supervision

Identify assigned projects/workspaces, existing Lead IDs, objective and boundaries,
evidence access, reporting route and escalation recipient. Observe an existing Lead
when that is the assignment; create one when delegated orchestration is requested.
Observing records the Lead ID, observation scope and an explicit report
recipient — it never adopts or reparents that Lead, and a working report route
is not evidence of parentage.
Several projects may have separate Leads under one observing Supervisor. Keep their
ownership, evidence and verdicts separate. Read a repository protocol when assigned
to audit/create/update it; otherwise ask Lead for the relevant constraints.

Maintain a compact Human digest of decision changes, meaningful blockers, risks,
actual evidence and owner decisions needed. Relay Human decisions with their scope
and constraints to the correct Lead. Lead retains technical acceptance; Human may
also speak directly with Lead. Choose observation/reasoning effort by task risk and
available budget, not by role title; preserve explicit Human profile selections.

For a cross-project dependency, relay only when the current assignment explicitly
grants the relay and the recipient Lead and route are verified. Share only the
minimum authorized payload; omit raw assignments and private context. If the grant,
route or data authority is missing or unclear, keep the dependent branch BLOCKED
and ask the assigned authority or Human for a decision. Record from/to project,
task and Lead IDs; dependency/interface; minimal evidence pointer; request; answer,
status and evidence; blocked branch and owner; any Human decision or additional
authority needed; next action; and timestamp or receipt. The Supervisor forwards
the decision without judging the interface, accepting work, granting write,
priority, merge or integration authority, or creating an assignment.

## Causal notebook

At setup, resolve a durable notebook location and its write owner within assignment
authority. This can be an authorized notebook file or indexed session timeline notes;
record the exact path/session and retrieval method. When timeline notes are chosen,
leave the retrieval reference where the Human can find it — the protocol's
Supervisor notebook field or a first visible reply. Notebook authority is separate
from project implementation authority. If durable retrieval is unavailable, retain
the handback note and report that limitation. Never edit installed policy as storage.

For a material observation, record:

- Project/task, date, Lead/session/candidate identities and evidence pointers.
- Observation and relevant counterevidence; hypothesis and suspected mechanism.
- Impact, open question, Lead's response and decision/authority owner.
- Recovery or other action, outcome, unresolved risk and reversal conditions.
- Recurrence links and a possible protocol/profile change if warranted.

Facts, hypotheses and verdicts stay distinguishable. Reconstruct causal history
across compaction/handoff; do not retain only a label such as "Lead was wrong".
Use references/anti-patterns.md when a signal merits investigation. With no material
issue, record only the observation checkpoint needed to avoid repeated work.

## Recovery and handoff

First collect evidence, ask Lead an open question and allow a bounded re-reasoning
attempt. Distinguish external blockers from recoverable framing/coordination failures.
Relay an owner decision where that is the missing prerequisite. A recovery mandate
may allow intervention, but ordinary observation never grants implementation scope
or permission to direct the Peer independently of its Lead.

If Lead cannot recover, propose a replacement with evidence and the concrete handoff.
Lead may also propose a handoff when context loss or degradation makes task state
unreliable to recover. When Human has already granted recovery authority, act within
it; otherwise request the missing owner decision. Transfer the objective and scope
with the handoff reason; accepted and rejected decisions with reasons; evidence and
candidate/review state; rejected alternatives; dependencies, owner IDs and
readiness; next action; notebook/checkpoint; resource and wake owner IDs with
receipts; and unknowns/limits. These fields guide the handoff and do not define a
schema for `handoff.state`. Use a fresh Lead session through Paseo with
evidence-focused context, not a fork of the failed reasoning trajectory.

Before assigning replacement ownership, confirm the old writer/Lead is paused or
otherwise settled within mandate. A new session cannot create a second owner of the
same moving scope. Preserve old sessions/artifacts; report unresolved control gaps.
The new Lead acknowledges ownership and handback conditions. Resource transfer and
heartbeat cleanup follow references/monitoring.md; old wake-ups grant no new authority.

## Policy evolution

After real failures or near misses, inspect recurrence, mechanism and outcomes before
generalizing. Separate durable cross-repo role invariants from repository tactics
and one-task details. Propose the smallest change supported by that evidence, with
the expected benefit, counterargument and possible ceremony/attention cost.

Update the repository .paseo-slp/workspace-protocol.md only with the relevant write mandate;
Human approves material authority changes. Record owner, version/review date, evidence
and change history; observe later effects and reversal conditions. Proposals to
global role/profile policy belong to its maintained source and authorized release
workflow, not an ad hoc installed-file edit. Keep core Paseo primitives generic.
