# Deprecate v1 Peer pools with an explicit upgrade path

- Status: Accepted
- Date: 2026-10-12
- Decided by: Human
- Source: Human request to recognize old pools, recommend upgrading and prepare for ending legacy support
- Supersedes: none

## Context

Existing users keep their v1 pools after upgrading. They need a visible path
to adopt v2 or replace their entries with the five starter presets.

## Decision

Mark v1 pools deprecated and recommend v2 in the Manager. Removal is planned
for a future release, with no removal release selected. Retain v1 behavior
until that separately authorized removal. Offer both conversion preserving
entries and confirmed replacement with five defaults as drafts requiring Save.

## Consequences

No automatic conversion or overwrite. Preserve the saved pool backup path,
target isolation, CAS and active-runtime compatibility checks. Release timing
and actual removal remain a separate Human decision.
