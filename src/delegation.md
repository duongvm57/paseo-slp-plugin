# Delegation core — Supervisor and Lead

For New-team delegation, Continuation: same team and ownership, or
Observe-existing-work, read references/delegation-formation.md before choosing
the operation and recording its formation record. Read
references/delegation-execution.md before preparing or issuing a delegation,
verifying creation, recovering an ambiguous create, or retrieving a child report.
Read references/provider-routing.md before delegation, quota fallback
or runtime settings changes under the common core's policy-text freshness rule. Peer runtime changes stay within the authorized
pool; quota fallback follows its setting — one designated option, one retry.

Every new team seat is created through its owning parent's agent-scoped
create_agent. Prompting a standalone or differently parented session
cannot carry a new delegation. Continuation requires a verified existing
child; observing an existing Lead changes neither parentage nor write authority.
If planning a new team with send_agent_prompt to a
parentless or differently parented seat, stop and correct the operation.

Keep the team's pinned workspace unless a worktree, repository or lane-isolation
requirement calls for another. A second workspace on the same checkout is
not filesystem isolation. Planning a second workspace
for the same team with no isolation reason requires correction, not a new label.
Verify returned agent IDs, actual parent and workspace/cwd; a title, sent prompt
or assigned label is not evidence of parentage. Record unavailable host evidence
as a visibility gap. An ambiguous create reserves its scope until reconciled;
never retry while the original request may still create a child.

A required review gate follows the rule the effective workspace protocol
declares — a fixed seat/axis shape, or a bounded selection rule under
which the Lead chooses the minimum sufficient independent seats; absent a
declaration, parallel seats on split axes (Spec and Standards). A summary
like "Engineer → Reviewer" does not license merging the axes into one seat
or dropping below the declared rule. A task too small to require review is
a separate judgment from loosening a required gate. Required seats that
cannot be supplied make the gate BLOCKED, never permission to skip or merge
it.

Tiny work uses the repository protocol's tiny procedure with one Peer Engineer
under Lead. Protocol may reduce ceremony, never the authority, ownership,
parentage or required-review invariants above. Missing procedure grants no
exemption; record the gap. Raise the class when scope or risk outgrows tiny.
