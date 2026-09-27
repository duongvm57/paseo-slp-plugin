# Development

How this package is tested, and how to dogfood it live. Contributor rules
are in [AGENTS.md](../AGENTS.md).

## Testing

```bash
npm test
npm run check
```

Inside a managed session, isolate the suite from ambient runtime env —
`env -i HOME="$HOME" PATH="$PATH" PASEO_HOME="$(mktemp -d)" npm test`, or
unset the full `SLP_*` set (`SLP_DAEMON_HOME SLP_MANAGED_RUNTIME
SLP_RUNTIME_ROOT SLP_NODE_BIN`); a partial unset leaks the runtime into
the suite and fakes failures.

Local checks cover the manager's transaction/recovery logic, the
materializer, launch-shim generation, config preservation, protocol and the
stdio adapter; they do not prove role compliance with the operating guide.
The plugin has additionally been verified live on a real Paseo 0.8.0 daemon:
Git-source install, management surface, activate/deactivate/reconcile RPCs,
provider/profile patching, collision and drift refusals, and recovery
classification — see `.local-checks/` for the evidence ledger. Roles are
behavioral instructions, not a filesystem/MCP sandbox. The transport supports
Codex, Pi, Devin and Claude; routing, adapter and handoff have local checks.
Live provider switching, heartbeat, council and the full E2E manifest are
not yet E2E-accepted. Capability and policy-load paths are recorded in the
trace table below.

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
