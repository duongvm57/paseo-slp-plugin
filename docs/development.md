# Development

How this package is tested, and how to dogfood it live. Contributor rules
are in [AGENTS.md](../AGENTS.md).

## Testing

```bash
npm test
npm run typecheck
npm run check
npm run check:plugin-payload
```

This is the order in `.github/workflows/ci.yml`. `npm test` runs
`scripts/test-isolated.mjs`: it creates a temporary `PASEO_HOME`, runs
`node --test` with a clean environment (only `HOME`, `PATH` and that
`PASEO_HOME`), forwards the exit code and removes the directory. An inherited
live `PASEO_HOME`, managed runtime or enabled service therefore cannot reach
test fixtures, so no manual `env -i`/`mktemp` wrapper is needed. CI still sets
its own temporary home around `npm test`; that is redundant but harmless. The
canonical-fixture check currently requires `tmpdir()` to resolve to `/tmp`;
local runs here use that default.

Run one file (or a few) through the same wrapper; arguments are passed to
`node --test` after the isolation is set up:

```bash
npm test -- tests/plugin-desk-store.test.mjs
node scripts/test-isolated.mjs tests/plugin-desk-store.test.mjs   # same thing
```

Which test covers which area, from what each file imports:

| Area (code) | Tests |
|---|---|
| `plugin/server/desk-store.ts`, `desk-assignment.ts`, `desk-ownership.ts` | `plugin-desk-store`, `plugin-desk-store-migrations`, `plugin-desk-continuity`, `plugin-desk-workflow-continuity` |
| `plugin/server/desk-scope.ts`, `desk-rollout.ts`, `desk-check-runner.ts`, `desk-settlement.ts`, `desk-handback.ts` | `plugin-desk-scope`, `plugin-desk-rollout`, `plugin-desk-check-freshness`, `plugin-desk-settlement`, `plugin-desk-handback`, `plugin-desk-records-parity`, `plugin-workflow-view` |
| `plugin/server/desk-task*.ts`, `desk-task-execution-*.ts` | `plugin-desk-task-*` (access, bridge, capacity, capacity-boundaries, contract, core, execution, host, runtime), `plugin-desk-workflow-tasks`, `plugin-task-recap` |
| `plugin/server/desk-bridge.ts`, `desk-seat.ts`, `desk-operation.ts`, `desk-formation.ts` | `plugin-desk-bridge`, `plugin-desk-seat`, `plugin-desk-operation`, `plugin-desk-formation`, `plugin-desk-formation-bridge` |
| `plugin/server/desk-recovery.ts`, `runtime/lock-holder.ts`, `runtime/cli/desk-recovery.ts` | `plugin-desk-recovery`, `plugin-lock-holder`, `desk-recovery-cli` |
| `plugin/server/enforcement.ts`, `runtime-pin.ts`, `injection-binding.ts`, `role-injection.ts` | `plugin-enforcement`, `plugin-runtime-pin`, `plugin-injection-binding`, `plugin-role-injection` |
| `plugin/server/manager.ts`, `config-transaction.ts`, `state-store.ts`, `materializer.ts`, `launchers.ts`, `executables.ts` | `plugin-transaction`, `plugin-recovery`, `plugin-routing`, `plugin-materializer`, `plugin-launchers`, `plugin-families`, `plugin-helpers`, `plugin-provider-catalog`, `plugin-entrypoints`, `runtime-layout` |
| `plugin/server/jev.ts`, `plugin/server/runtime/cli/jev*.ts`, `routing.ts` | `plugin-jev`, `jev`, `routing`, `routing-criteria`, `runtime-state` |
| `plugin/server/supervision/*`, `plugin/shared/supervision.ts` | `plugin-supervision`, `plugin-supervision-capture`, `-card`, `-delivery`, `-observer` |
| `plugin/client/*` (cards, catalog demand, workflow panel, manager state) | `client-catalog-demand`, `client-target-async`, `client-workflow-view`, `plugin-ui`; hooks load through `tests/helpers/*-entry.mts` |
| `plugin/server/runtime/cli/*` (install, launch, inventory, monitor, notebook, host config, profiles, package) | `install`, `local`, `materialize`, `launch`, `inventory`, `monitor`, `notebook`, `runtime-core-install` |
| `plugin/server/runtime/cli/candidate-verify.ts`, `report-records.ts`, `report-semantics.ts` | `candidate-verify`, `verify-handback-cli`, `report-records` |
| `scripts/review-copy.mjs`, `scripts/runtime-graph.mjs` | `review-copy`, `runtime-graph` |
| `e2e/*.mjs` (collector, criteria, evidence, fixture, scenarios, stop-watcher) | `harness-cli`, `harness-gate`, `harness-ledger`, `harness-review`, `stop-watcher` |
| Role policy text (`src/`, protocol template) | `policy-doctrine` |

All paths in the Tests column are `tests/<name>.test.mjs`. The table lists the
primary tests per area, not every test that touches a module.

Local checks cover the manager's transaction/recovery logic, the
materializer, launch-shim generation, config preservation, protocol and the
stdio adapter, native desk history, selected review, owner continuity,
bounded workspace reads and supervised task execution. Task fixtures exercise
the real Core, durable store, membership hooks, socket bridge and temporary
Git repositories, including a dependency diamond and integration conflicts.
Recovery fixtures also exercise issued-create ticket minting, interrupted
verification and per-resource cleanup, exact replay and capacity boundaries.
SDK effects remain fixtures; these checks do not prove live delivery, process
quiescence or role compliance. See [task execution](task-execution.md) for the
operational limits.

Native task adapters are checked against the published SDK 0.10 contracts;
installation compatibility with an older daemon does not establish its execution
capabilities. Installed dependency checks and extracted-target typechecks are
reported separately.

An earlier candidate was additionally verified live on a real Paseo 0.8.0 daemon:
Git-source install, management surface, activate/deactivate/reconcile RPCs,
provider/profile patching, collision and drift refusals, and recovery
classification — see `.local-checks/` for the evidence ledger. Roles are
behavioral instructions, not a filesystem/MCP sandbox. The transport supports
Codex, Pi, Devin and Claude; routing, adapter and handoff have local checks.
Live provider switching, heartbeat, council and the full E2E manifest are
not yet E2E-accepted. The [candidate contract](contract.md) records capability
and policy-load ownership; the [E2E review checklist](review-checklist.md)
defines the evidence required for a live workflow claim.

### Independent review probes

For a proof audit that needs writes, materialize the frozen candidate outside
the working checkout before probing:

```bash
node bin/slp.mjs snapshot /absolute/repository
node scripts/review-copy.mjs /absolute/repository <snapshot-sha256>
```

The harness returns a private scratch directory, its candidate path and a
receipt. It measures source identity before and after copying and requires the
copy's snapshot to match the requested pin. An ordinary committed repository,
including modified/untracked files, modes, symlinks and tracked deletions, is
supported. Nested repositories, gitlinks and files beneath symlink ancestors
require separate materialization; the helper refuses them before allocating a
copy. Ignored dependencies, build
outputs, processes and external proof are not included. Regular-file staging
intent is not mirrored. Install any needed dependencies only within the audit's
grant, and record those prerequisites separately.

The caller owns the copy, probe resources and removal after settlement. Copying
is neither a sandbox nor a check execution or acceptance receipt. Preserve the
source candidate; record each probe, its changed bytes and revert. Mutation
evidence still follows R1/R2 in `AGENTS.md`.

## E2E

To dogfood from an open session on this **source checkout**, ask: **"run the
package's full E2E"**. The [E2E skill](../skills/paseo-slp-e2e/SKILL.md) walks
the session through the whole [scenario manifest](../e2e/scenarios.mjs), using
child sessions on a real Paseo, collecting evidence, reviewing independently
and cleaning up, then returns one combined report. Granted permissions, host
and budget are reused; branches missing prerequisites are recorded BLOCKED.
`npm run e2e` only prints the session entrypoint (exit 2, does not run live);
the fixture/evidence/verdict subcommands are described in the
[E2E guide](../e2e/README.md). This harness has no live acceptance yet; adding
the entrypoint does not change the unverified E2E states above.

To run a `basic-*` scenario, configure the two Supervisor/Lead
profiles and the fixture's Peer pool for the matching family. The coordinator
prepares fixture/protocol, pool and baseline; the Supervisor creates a Lead
per the saved profile, the Lead picks the Peer option itself. There is no
pre-launch confirmer for basic. U2 cross-checks profiles for Supervisor/Lead
and option/hash for the Peer. `mixed-peer` checks a pool containing both
Codex/Pi — no extra saved profile needed and no forcing the Lead's family per
Peer. Scenarios outside the scope stay NOT_RUN.

The offline CLI's `prepare <request.json>` emits `create_agent` arguments with
a role envelope. It registers no profile and creates no agent itself.
