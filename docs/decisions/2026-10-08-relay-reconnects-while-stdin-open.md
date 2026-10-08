# Desk relay reconnects for the lifetime of stdin

- Status: Accepted
- Date: 2026-10-08
- Decided by: Human
- Source: Human assignment B/C and startup/reconnect hold corrections
- Supersedes: none

## Context

The host never respawns an exited stdio MCP; the plugin may take seconds to bind.

## Decision

Reconnect while stdin is open, with a pinned hello each time.
Hold initial stdin for 11500ms until ACK, expiry or permanent hello rejection.
Dials/transient hellos retry throughout; backoff is 100/200/400/800/1600ms (last repeats).
Each hello has a 10000ms cap. After a drop hold for 700ms (100+200+400), never renewed.
ACK forwards held frames in order; expiry yields CAPABILITY_GAP until connected.
Accepted unanswered frames get EXECUTION_UNKNOWN once, never replay; expiry survives late ACKs.
Preserve caps, backpressure, bounded buffers/IDs, flush, diagnostics, UDS and all five guards.

## Consequences

EOF drains held input; stdin close/destroy discards it; stdout loss is terminal. Transport owns availability.
