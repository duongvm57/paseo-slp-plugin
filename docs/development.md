# Development

How this package is tested, and how to dogfood it live. Contributor rules
are in [AGENTS.md](../AGENTS.md).

## Testing

```bash
slp_check_home=$(mktemp -d)
trap 'rm -rf "$slp_check_home"' EXIT
env -i HOME="$HOME" PATH="$PATH" PASEO_HOME="$slp_check_home" npm test
npm run typecheck
npm run check
npm run check:plugin-payload
```

The isolated home and clean environment keep managed runtime and enabled
service settings out of test fixtures. The canonical-fixture check currently
requires `tmpdir()` to resolve to `/tmp`; local runs here use that default.

Local checks cover the manager's transaction/recovery logic, the
materializer, launch-shim generation, config preservation, protocol and the
stdio adapter, native desk history, selected review, owner continuity and
bounded workspace reads. These checks do not prove live role compliance.
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
