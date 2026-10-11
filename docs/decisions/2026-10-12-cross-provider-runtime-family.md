# Cross-provider compares runtime providers

- Status: Accepted
- Date: 2026-10-12
- Decided by: Human
- Source: Human clarification that Devin coding followed by Luna review is cross-provider
- Supersedes: none

## Context

Requiring Human-declared model vendors made the Cross-provider preset harder
to configure than intended. The desired boundary is the runtime used for work.

## Decision

Compare the candidate runtime family with the explicitly observed reference
seat's family. Devin to Codex qualifies. Normalize managed role wrappers; no
model-vendor declaration or reference model pool entry is required.

## Consequences

Keep saved pools readable without rewriting the historical v2 rule literal.
Change the routing semantics pin so prior receipts cannot replay. Retain
reference freshness, eligible model/effort checks and explicit authority.
