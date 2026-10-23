# Preserve Desk correlation across attributed agent deliveries

- Status: Accepted
- Date: 2026-10-22
- Decided by: Lead
- Source: Human request to implement the Paseo 0.12 changelog assessment
- Supersedes: none

## Context

Paseo 0.12 projects attributed agent inputs into tool calls. Desk confirmation
previously matched only user messages; default listings also omit background
workspaces. Episode labels describe work context, rather than message authors.

## Decision

Send the verified Desk caller as optional sourceAgentId, retaining message IDs
and existing interrupt/steer behavior. Share semantic decoding with capture;
confirm projected sends only for event=message and the persisted caller.
Accept legacy message IDs as delivery correlation with unknown author origin.
Include background agents in attempt-label reconciliation. Keep pins/floor.
Public old clients drop additive fields; new clients own capability preflight.
A capability rejection remains unresolved, without plain fallback or retry.
No new setting or capability cache is needed; the SDK enforces compatibility.

## Consequences

Keep episode labels and source-first analyzer contracts. Neither sender nor
message ID proves Human authority, a new lifecycle turn or work acceptance.
Actual client probes are local wire checks, not live daemon/fleet acceptance.
