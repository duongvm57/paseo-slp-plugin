# Tech Debt Tracker

Deferred work that must not be lost. Each item needs: what, why deferred,
and the trigger to pick it back up.

| Item | Why deferred | Pick up when |
|---|---|---|
| 76 pre-existing test failures on `feat/enforcement-mechanization` (C2/EF-1 families; ~3 on CI Node 22) | Owned by the enforcement workstream, not harness PRs | Base branch lands its fixes |
| Harness adoption decision (`feat-003`) | Needs Human authority | PR #42 / #41 review |
| Route harness entry points from `docs/contract.md` (`feat-004`) | Depends on feat-003 | Harness model chosen |
| `docs/` doc-set overlap with PR #41 (`docs/plans/` vs `docs/exec-plans/`, `docs/decisions/` vs `docs/design-docs/`) | Two candidate models in flight | One model survives |
