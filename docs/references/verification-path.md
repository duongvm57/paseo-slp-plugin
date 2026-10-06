# Reference: Verification Path

The repo's verification ladder, cheapest first. `./init.sh` runs all of it.
`docs/development.md` covers the contributor test workflow generally; this
file is the terse gate list for sessions.

| Step | Command | What it proves |
|---|---|---|
| deps | `npm ci` | lockfile-resolved install |
| types | `npm run typecheck` | `tsc --noEmit -p tsconfig.json` clean |
| payload identity | `npm run check` | `bin/slp.mjs identity` prints manifest |
| payload integrity | `npm run check:plugin-payload` | committed `runtime-payload.ts` matches disk |
| tests | `npm test` (PASEO_HOME-isolated) | `node --test tests/*.test.mjs` |

## Known caveats

- **Node version**: `node --test tests/` (bare dir) fails MODULE_NOT_FOUND on
  Node 24 — always use the glob form.
- **PASEO_HOME**: tests that touch `~/.paseo` need isolation — CI does
  `PASEO_HOME="$(mktemp -d)"`; `./init.sh` does the same.
- **Baseline**: `feat/enforcement-mechanization` currently has pre-existing
  WIP failures (~76 local, ~3 on CI Node 22). Treat the fail-set as data:
  diff it against the base branch before blaming a change.
- **File modes**: payload files byte-compare modes (`mode & 0o777`). A umask
  of 002 silently breaks `check:plugin-payload` — keep 644/755.
