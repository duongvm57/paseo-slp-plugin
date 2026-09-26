# Paseo upstream baseline

Operational facts for the `paseo-slp-upstream-sync` skill
(`.agents/skills/paseo-slp-upstream-sync/SKILL.md`). Each sync reads this file
to start from the last assessed release and updates it at handback, including
a "no plugin change" outcome.

- **Pinned**: the version this checkout builds against (lockfile, or the host
  runtime for unpinned packages). Compatibility is judged against it.
- **Assessed**: the newest release whose delta from Pinned was classified.
  The next sync diffs and reads release notes from Assessed to its target.

| Package | Pinned | Assessed | Coverage | Date | Outcome |
|---|---|---|---|---|---|
| `@getpaseo/plugin` | 0.8.0 | 0.9.2 | Full `.d.ts`/`.js` diff | 2026-09-25 | Additive; bump recommended, undecided |
| `@getpaseo/client` | 0.8.0 | 0.9.2 | Full `.d.ts`/`.js` diff | 2026-09-25 | Additive; bump recommended, undecided |
| `@getpaseo/protocol` | 0.8.0 | 0.9.2 | Full diff; moved schemas still re-exported from `messages` | 2026-09-25 | Additive; bump recommended, undecided |
| `@getpaseo/server` | host 0.9.1 (unpinned) | 0.9.2 | Touchpoint-map files only; rest of the 215 changed dist files unreviewed | 2026-09-25 | No break found in reviewed files |
| `@getpaseo/cli` | host 0.9.1 (unpinned) | — | Not assessed | — | Next sync starts from the host version |

`requirements.paseo` in `plugin/paseo-plugin.json`: `>=0.8.0 <0.10.0`, kept
unchanged by the 0.9.2 assessment.

## Open items from the last assessment

- Bump `@getpaseo/{plugin,client,protocol}` to 0.9.2, root and
  `plugin/package.json`: recommended, awaiting a Human decision.
- `plugin/server/config-view.ts` parses config without stripping a UTF-8 BOM,
  which daemon 0.9.2 accepts: consider mirroring the strip.
- Docs pinned to 0.8.0 need re-baselining with a bump:
  `docs/spec/paseo-plugin-implementation.md`,
  `docs/spec/paseo-plugin-feasibility.md`, `docs/contract.md`.
- No live test on daemon 0.9.2; `tests/fixtures/supervision/*.json` were not
  re-recorded on 0.9.x.

## Evidence

2026-09-25 assessment, Lead `32b06c91-c7d3-4286-af49-4653e71661ef`:
`.local-checks/upstream-v092/report.md` with tarball diffs beside it. That
directory is gitignored and exists only on the machine that ran it; the rows
above are the tracked record.
