# Reliability

Failure handling and recovery built into the repo.

## Resume / recovery machinery

- `plugin/server/runtime/desk-recovery.ts` + `cli/desk-recovery.ts` — desk
  restart/restore path
- `plugin/server/runtime/jev-state.ts`, `runtime-state.ts` — persisted run
  state
- `plugin/server/runtime/lock-holder.ts` — single-writer enforcement
- `plugin/server/runtime/report-records.ts`, `handoff-recap.ts` — evidence
  and recap records

## Session-level reliability (harness layer)

- `./init.sh` fails fast on any unhealthy step (`set -e`)
- `feature_list.json` + `progress.md` + `session-handoff.md` let a cold
  session resume without transcript archaeology
- `docs/exec-plans/` keeps durable plan history across sessions

## Watch items

- Base branch carries WIP failures — `init.sh` will fail at `npm test` until
  enforcement lands; that is correct behavior (baseline repair precedes scope).
