# Supervisor keeps a protocol inventory and relay provenance across repositories

- Status: Accepted
- Date: 2026-10-13
- Decided by: duongvm (Human)
- Source: Human, relayed by the Supervisor: "fix luôn, đây là sai spec slp mà" (answering: with one workspace protocol per repository, what stops a Supervisor mixing protocol information between workspaces?)
- Supersedes: none

## Context

Each repository owns its workspace protocol, but a Supervisor with several
assigned repositories had no duty to track which protocol it read, no provenance
rule for tactics relayed between repositories, and no shared record for
decisions that span repositories. The Supervisor named these three gaps; the
Human ruled the omission a spec defect. This is a spec correction, not a
response to recurring failures.

## Decision

Maintained role source now requires: (1) the Supervisor keeps a protocol
inventory per assigned repository (path, sha256, routing_intent), refreshed at
entry and handback; (2) the Supervisor reads governance before cross-project
relay; (3) each relayed tactic names its source repository and carries only
what the target's protocol/policy supports; (4) a cross-repository decision is
recorded in each affected repository per its protocol (a gap if none), with a
pointer in the Supervisor's notebook. The text names no repository's tactic.
Rejected: a plugin gate or inventory state file (snapshot already exposes
hashes; no consumer needs enforcement yet); a shared cross-repository decision
store (breaks per-repository ownership).

## Consequences

Evolve-policy: smallest useful change, +43 words in total (supervisor.md +13,
governance.md +30), no new state, tool or gate. Benefit: traceable relays and
detectable protocol drift. Counterargument: a behavioral rule is unenforced and
refresh adds attention per entry/handback. Reverse if audits show no mix-up risk
or a plugin consumer makes the inventory mechanical.

Two-way rule: the invariant is that every relayed tactic traces to its source
repository and only crosses when the target supports it. It is held by the
source-named relay rule plus the read trigger, not by protocol: cross-repository
behavior belongs to no single repository's protocol, and the harness exposes
hashes via snapshot but not the rule. Effective only after release and
reinstall (Human authority); installed policy is untouched.
