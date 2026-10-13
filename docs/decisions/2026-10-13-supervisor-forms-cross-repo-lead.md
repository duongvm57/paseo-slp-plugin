# Supervisor forms a Lead in another repository

- Status: Accepted
- Date: 2026-10-13
- Decided by: duongvm (Human)
- Source: Human ruling "a2" relayed by the Supervisor on the cross-repository seat placement fork
- Supersedes: none

## Context

`slp_seat_create` rejected every placement outside the caller's Git repository,
so a Supervisor could not natively form a Lead for a second project.

## Decision

Keep one desk per repository. A Supervisor may form a Lead with existing
placement in a separate repository, where no checkout of either repository
contains or is contained by a checkout of the other; that repository supplies
source and target pins, its desk registers the Lead and is read by the membership wait,
and the receipt stays on the Supervisor's desk. Lead callers, Peer children,
caller/omitted placement, nested repositories and task access stay
same-repository. Rejected: (a1) only clarify the rejection, leaving Supervisors on
compatibility `create_agent`; (b) allow every role, which breaks the
per-repository desk and needs cross-desk handback/review semantics.

## Consequences

The plugin owns this invariant: only it observes Git common dirs, live workspace
descriptors and desk ledgers at formation; protocol/harness text cannot qualify
SDK identity or the registering desk. Cross-workspace parentage needs live E2E.
