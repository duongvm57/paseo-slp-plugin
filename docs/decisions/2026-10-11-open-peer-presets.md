# Open Peer presets and formation-time effort

- Status: Accepted
- Date: 2026-10-11
- Decided by: Human
- Source: Human review of Peer pool HTML plan; five defaults plus custom presets, followed by implementation instruction
- Supersedes: none

## Context

Fixed task archetypes made Human model configuration difficult and coupled
suitability to a closed vocabulary. Model capability and effort vary independently.

## Decision

Seed new pools with Fast, Balanced, Advanced, Frontier and Cross-provider;
allow arbitrary editable entries. Human chooses model bundles. Lead/Jev reads
all entry descriptions and selects a supported effort pair at formation.
Cross-provider is an explicit runtime rule relative to a named reference seat.
Retain v1 behavior until the Human explicitly previews and saves a v2 conversion.

## Consequences

Pool schema, editor, policy, Jev choices and receipt checks change together.
Existing effort migrates as Fixed; downgrade after conversion needs the original
v1 backup. Missing model/vendor metadata is an explicit capability gap.
