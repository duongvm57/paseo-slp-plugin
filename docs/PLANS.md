# Plans

Entry point for execution planning. Detailed documents live in `docs/exec-plans/`.

- `docs/exec-plans/active/index.md` — what's in flight right now
- `docs/exec-plans/active/<date>-<slug>.md` — one dated file per active plan
- `docs/exec-plans/completed/` — archived plans (immutable record)
- `docs/exec-plans/tech-debt-tracker.md` — deferred work that must not be lost

## Rules

- A plan file is created when work spans more than one session or touches
  contract-owned scope.
- When a plan finishes, move it to `completed/` — do not delete; it is the
  durable record `progress.md` does not keep.
- `progress.md` only reflects *current* state; it must never grow into a log.
  History = exec-plans + git log.
- Deferred items go to `tech-debt-tracker.md` with an explicit reason, not
  into a memory or a chat message.
