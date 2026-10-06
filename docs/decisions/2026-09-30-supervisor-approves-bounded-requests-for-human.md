# Supervisor approves bounded requests on the Human's behalf

- Status: Accepted
- Date: 2026-09-30
- Decided by: Human (duongvm)
- Source: Supervisor notebook (local, gitignored), entry 2026-09-30 "P3-a ACCEPT + commit grant + approval delegation"
- Supersedes: none

## Context

Every bounded Lead request (correction rounds, scope clarifications, local
commit grants) waited on the Human, which stalled long mechanization slices.

## Decision

From 2026-09-30 the Supervisor approves bounded Lead requests in place of the
Human. Irreversible or external actions still go to the Human: push, install,
release, tags, live probes and host configuration. Review-round budgets are
not widened by this delegation; extra rounds remain a Human grant.

## Consequences

Supervisor rulings made under this delegation are recorded as "Supervisor on
behalf of Human" (PR "Decisions in this task", ADR `Decided by`). A grant for
one slice does not carry to the next. Revisit if the Human narrows or revokes
the delegation.
