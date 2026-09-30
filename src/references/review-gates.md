# Review gates

A review gate runs independent reviewer seats against a frozen candidate.
When the assignment or protocol requires independent review of a stable
candidate, the gate takes the shape the effective workspace protocol
declares; absent a declaration, the package default applies: parallel Peer
seats on split Spec and Standards axes so no axis can mask another. A single
reviewer is a degenerate gate — valid only for the change classes the
protocol lists explicitly (for example docs-only edits that touch no
semantics, generated-payload regeneration, typo or metadata fixes) or where
the protocol declares a one-seat shape; a required gate over doctrine,
delegation, packaging, behaviour or code keeps the split default unless the
protocol records otherwise.

## Policy provenance

The package default is a two-seat gate on separate Spec and Standards axes —
stricter than corpus §§9–11, which leaves each repository to choose its
review rigor. The Human chose this default in `cc80974` (2026-09-24) so one
review axis cannot mask the other, then made the shape itself protocol-owned
(2026-09-30): the workspace protocol defines its gate's seats and axes and
may set them stricter or looser than this default — including a declared
one-seat gate — as a Human protocol decision recorded under Overrides. A
required gate always has at least one independent seat; removing review for
a change class is the listed-class mechanism, not a gate shape. What no
protocol or Lead relaxes: a required gate is never skipped or merged ad hoc,
and declared seats that cannot be supplied BLOCK the gate rather than
license merging or skipping.

## Axes

Two default axes, each on its own fresh seat — a protocol that declares
other axes replaces or adds to this set:

- **Spec** — does the candidate implement what the spec/assignment asked?
  Findings: requirements missing or partial; behaviour beyond the ask
  (scope creep); requirements that look implemented but are wrong. Quote
  the spec line per finding.
- **Standards** — does the candidate follow the repo's documented
  conventions? Sources: the repo's standards documents (AGENTS.md, style
  or contract docs) plus the smell baseline below. Distinguish hard
  violations (documented standards) from judgement calls (baseline
  smells); a documented repo standard overrides the baseline; skip
  whatever tooling already enforces.

The protocol's declared seats — the two split seats under the default — are
the complete required gate. A **cross-family** seat — one reviewer running
the declared axes from a provider family different from the writer's, whose
blind spots differ — is a suggested extra for a second opinion worth its
cost, never a required seat. When routing declines the cross-family option
or the pool holds no other-family seat, that seat reports BLOCKED: the gate
does not fail and still runs on its declared seats. A blocked seat is never
permission to merge axes into one seat or to skip the gate.

## Verification stays with the Lead

Reviewer seats read and report findings; verification executes — re-running
the established checks and pinning the candidate snapshot before and after
review. Verification is the Lead's own duty around the gate, not a council
seat, and it binds the same frozen candidate the reviewers saw.

## Smell baseline

Fixed baseline applying even when the repo documents nothing — labelled
heuristics, never hard violations: Mysterious Name, Duplicated Code,
Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches,
Shotgun Surgery, Divergent Change, Speculative Generality, Message
Chains, Middle Man, Refused Bequest.

## Seat briefs

Every fresh seat gets a neutral first-review brief: the frozen candidate
identity (snapshot hash or exact commit), its axis, the spec/standards source paths — and
nothing else. No prior findings, no Lead verdict, no writer identity.
The seat verifies the candidate identity before reviewing; a changed
snapshot invalidates the attempt.

For re-review within the same assignment, continue the same independent seat
with the new candidate identity, changes and that seat's prior findings so it
can check closure and regressions. Another seat's verdict or the Lead's desired
verdict is never an answer key. A fresh replacement receives the neutral
first-review brief, not the previous reviewer's conclusions.

Reports stay in-session, bounded: findings quoted against the axis source,
hard violations separated from judgement calls.

## Aggregation

Report axes side by side; never merge or rerank findings into one verdict
list — a candidate can pass one axis and fail the other, and merged
rankings let one axis mask the failure. Corrections route to the owning
lane; re-review returns to the same seat under session continuity. The
protocol owns the gate's seats and axes in either direction through a
recorded Overrides decision; a listed-class exception removes the
requirement rather than relaxing it, and the Lead decides it and records
the call in the task's brief or reconcile checkpoint. Inside a task the
declared shape is fixed: the Lead cannot merge, drop or add seats on its
own.

## Correction loops

Consecutive rounds returning findings of one class — the same root
mechanism surfacing at different sites — is the signal to stop briefing
point-fixes: each correction clears one site while the mechanism produces
the next. Require an enumeration of the mechanism's sites or a refactor of
the broken invariant instead of another local patch. When the sweep needs
independent design judgment, or majors in one cluster repeat across two
consecutive rounds, escalate to a findings committee rather than issue the
next correction brief.

Committee shape: two seats from provider families different from the
writer's — and from each other where the pool allows — briefed neutrally on
the findings history and the frozen candidate; at most two rounds of
cross-examination between them; the Lead reconciles and records one binding
decision. The committee analyzes and recommends; it holds no write
authority over the candidate.

The same cluster surfacing after the invariant refactor marks the class as
beyond point-fixing: escalate the strategy as an explicit decision, not the
default loop. The committee itself still holds no write authority. When the
decision is a direct patch, the Lead issues a separate Engineer assignment
— agent-scoped under the Lead, naming the write scope and its single
owner; the assignee may be a former committee member, but the authority
comes from that assignment, never from membership. The patch forms a new
candidate that re-freezes and re-enters the gate — frozen identity, split
seats, Lead verification — without bypass. The alternative branch is a
property or enumeration test covering the whole matrix.
