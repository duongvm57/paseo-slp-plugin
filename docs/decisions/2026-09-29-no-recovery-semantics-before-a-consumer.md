# No recovery or maintenance semantics before a consumer exists

- Status: Proposed
- Date: 2026-09-29
- Decided by: Supervisor on behalf of Human
- Source: Supervisor notebook (local, gitignored), entry 2026-09-28 "Human cấp round 8 (FINAL)", bullet dated 2026-09-29 (P2-a stop-condition)
- Supersedes: none

## Context

Designing stale-lock takeover for the desk store repeated the same Major
finding for three review rounds (lock theft, then a race, then precedence)
because no production consumer or authority model existed to constrain it.

## Decision

A mechanization slice does not design recovery, takeover or maintenance
semantics before a consumer exists. It fails closed (report
`RECOVERY_REQUIRED`, do not steal the lock) and defers the semantics to the
slice that owns a consumer and its authority.

## Consequences

Slices ship smaller and the review loop ends sooner; manual cleanup remains
until the deferred slice lands. Proposed because the ruling was made by the
Supervisor before the 2026-09-30 delegation; the Human has not confirmed it.
