# Desk lock recovery is operator-only and automatic-mode only

- Status: Superseded
- Date: 2026-09-29
- Decided by: Supervisor on behalf of Human
- Source: Supervisor notebook (local, gitignored), entry 2026-09-29 "P2-e: design note + quyết định S1/S2/S3"
- Supersedes: none

## Context

P2-e needed a way to clear orphaned desk locks. Roadmap scope also tempted a
broader enforcement registration surface with no consumer yet.

## Decision

- Cut `enforcement.register` (grants, assignments, reservations, attestation)
  until a consumer exists; the contract states that membership rows exist
  without a confirming consumer.
- Recovery is an operator action, automatic mode only: unlink only when the
  holder is readable, its pid is numeric and `kill(pid, 0)` returns ESRCH.
  No force mode, and no call path from a hook.
- Ship it as an RPC plus the `desk-recover` CLI verb; defer a UI surface until
  a live probe, which is Human authority, can prove it.

## Consequences

Residual cases (pid reuse, unreadable holder) need manual cleanup by the
Human. Proposed because the Supervisor ruled before the 2026-09-30 delegation
and the later CLI-versus-RPC-only question was left to the Human. Details are
in `docs/contract.md`.
