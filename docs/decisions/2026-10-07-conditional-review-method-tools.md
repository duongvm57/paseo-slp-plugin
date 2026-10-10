# Conditional review-method tools in the plugin policy

- Status: Accepted
- Date: 2026-10-07
- Decided by: Human
- Source: Human direction in the Lead session of 2026-10-07, after a two-model committee report
- Supersedes: none

## Context

One review gate needed two correction rounds. The round-2 findings came from the
corrections themselves: a ruling named an implementation instead of a property,
older docs were not re-checked, and trade-offs were not recorded when chosen.
Reviewers also spent many steps on re-running results, digging through long
logs, cleaning stray processes and probing schemas.

## Decision

The plugin policy (`review-gates.md`, `roles/peer.md`) carries two kinds of text.
Properties of elements already required: proof questions are falsifiable,
Reviewers state coverage, Engineers self-check their delta. Conditional tools,
used when they fit: lens ordering, findings then addendum, reuse of a receipt
bound to the same candidate pin, command and scope, property-first repair
rulings and effort-bound checkpoints. No new gate is added. Lead keeps
verification sufficiency, R1/R2 replay and acceptance. This repository's reuse
rule is split by claim scope: a full-suite claim needs a `default-suite` receipt,
a narrow claim may use a matching `partial` one.

## Consequences

Seat counts, gates and thinking routing do not change. The onboarding template
change is deferred: its sha is pinned in Human-owned protocol metadata. Revisit
after review speed and correction loops are measured on real tasks.
