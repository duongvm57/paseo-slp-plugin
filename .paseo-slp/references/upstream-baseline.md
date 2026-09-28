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
| `@getpaseo/plugin` | 0.10.0 | 0.10.0 | Full `.d.ts`/`.js` diff (no code delta) | 2026-09-28 | Additive; bump landed |
| `@getpaseo/client` | 0.10.0 | 0.10.0 | Full `.d.ts`/`.js` diff | 2026-09-28 | Additive; bump landed |
| `@getpaseo/protocol` | 0.10.0 | 0.10.0 | Full diff | 2026-09-28 | Additive; bump landed |
| `@getpaseo/server` | host 0.9.1 (unpinned) | 0.10.0 | Touchpoint-map files + parity backend exercised at 0.10.0 | 2026-09-28 | No break found; auth internals renamed, unused |
| `@getpaseo/cli` | host 0.9.1 (unpinned) | 0.10.0 | Full `.d.ts`/`.js` diff 0.9.1→0.10.0 | 2026-09-28 | Additive; `paseo run` caller-agent verify is strictly safer |

`requirements.paseo` in `plugin/paseo-plugin.json`: `>=0.8.0 <0.11.0`, extended
from `>=0.8.0 <0.10.0` by the 0.10.0 assessment (widening only; the 0.8.0
floor stands). Manifest verified by the real 0.10.0 `readPluginManifest`.

## Open items from the last assessment

- `plugin/server/config-view.ts` parses config without stripping a UTF-8 BOM,
  which daemon ≥0.9.2 accepts: consider mirroring the strip. Still undecided.
- Docs pinned to 0.8.0 need re-baselining with a bump:
  `docs/spec/paseo-plugin-implementation.md`,
  `docs/spec/paseo-plugin-feasibility.md`, `docs/contract.md`.
- No live daemon exercise on 0.10.0; `tests/fixtures/supervision/*.json` were
  recorded on host 0.9.1 and not re-recorded.

## Evidence

2026-09-28 assessment, Devin session 9ab88406b1f14e58948532f68a932d30:
`.local-checks/skill-upstream-sync/v0.10.0/report.md` with tarball diffs and
check receipts beside it (`receipts/`). That directory is gitignored and
exists only on the machine that ran it; the rows above are the tracked
record. Notable this run: parity tests ran against a real 0.10.0 server
backend (`PASEO_CLI_MODULES` → extracted tarball + `which`/`semver`
shims), so manifest validation, `compilePlugin`, `DaemonConfigStore` merge
and `loadPersistedConfig` schema parity are verified on the target, not
skipped.
