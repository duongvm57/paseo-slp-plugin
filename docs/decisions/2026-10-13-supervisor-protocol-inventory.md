# Supervisor keeps a protocol inventory and relay provenance across repositories

- Status: Accepted
- Date: 2026-10-13
- Decided by: duongvm (Human)
- Source: Human, relayed by the Supervisor: "fix luôn, đây là sai spec slp mà" (answering: with one workspace protocol per repository, what stops a Supervisor mixing protocol information between workspaces?)
- Supersedes: none

## Context

Each repository owns its workspace protocol, but a Supervisor governing several
repositories had no duty to track which protocol it read, no provenance rule for
tactics relayed between repositories, and no shared record for decisions that
span repositories. The Supervisor identified these three gaps; the Human ruled
the omission a spec defect.

## Decision

Maintained role source now requires: (1) the Supervisor keeps a protocol
inventory per governed repository (path, sha256, routing_intent), refreshed at
entry and handback; (2) each relayed tactic names its source repository and
carries only what the target's protocol/policy supports; (3) a cross-repository
decision is recorded in each affected repository per its settlement rule, with a
pointer in the Supervisor's notebook. The text names no repository's tactic.
Rejected: a plugin gate or inventory state file (snapshot already exposes
hashes; no consumer needs enforcement yet); a shared cross-repository decision
store (breaks per-repository ownership).

## Consequences

Evolve-policy: smallest useful change, +43 words (supervisor.md +15,
governance.md +28), no new state, tool or gate. Benefit: traceable relays and
detectable protocol drift. Counterargument: a behavioral rule is unenforced and
refresh adds attention per entry/handback. Reverse if audits show no mix-up risk
or a plugin consumer makes the inventory mechanical.

Two-way rule: the invariant is that a Supervisor never mixes tactics between
repositories and every relay traces to its source. Protocol cannot own it:
cross-repository behavior belongs to no single repository's protocol, and the
harness exposes hashes via snapshot but not the rule. Effective only after
release and reinstall (Human authority); installed policy is untouched.
