# Reusable full-suite evidence from the test wrapper

- Status: Proposed
- Date: 2026-10-06
- Decided by: Lead
- Source: Lead assignment on review-gate speed, 2026-10-06
- Supersedes: none

## Context

One review gate re-ran the roughly nine-minute full suite many times on the same
candidate across Engineer, Lead and Reviewer, because no measured,
candidate-bound result existed to share. A host shell timeout also cut the
summary line and orphaned the `node --test` child and its temporary home.

## Decision

`scripts/test-isolated.mjs` gains an opt-in record mode that writes a log and an
atomic receipt pinning the candidate snapshot (before and after), argv, node,
platform and structured counts, and fails closed on drift, crash, signal or
missing counts, and classifies each receipt `default-suite` or `partial`. On a caught signal it signals its descendants and removes the temporary home; the child shares the wrapper's process group, so a group SIGKILL leaves no orphan.
Receipts pin measurements only; whether to reuse one is the reader's judgment.

Invariant and owner (Two-way rule, repo to plugin):

- The plugin does not own this. The desk check class allowlist does not run
  tests; a proof recipe belongs only to the desk task integration, check and
  land flow, and is not a substitute for a local test run.
- The protocol already says to reuse valid candidate-bound evidence but has no
  mechanism to pin one for `npm test`; the wrapper supplies the pin, the
  protocol keeps the reuse policy.

## Consequences

Default behaviour and CI are unchanged. The acceptance owner still replays per
R1/R2. Known limits: a name filter matching nothing is reported by node as one
passing file (hence `selection`), and a SIGKILL aimed only at the wrapper pid orphans the runner. Revisit if the plugin gains a test-running check class.
