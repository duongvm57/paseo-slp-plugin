# Spec: SLP Plugin Surface

**Status:** draft

## What the installed unit contains

Payload paths (from `plugin/server/runtime/cli/package.ts` `installUnitPaths`):

- `package.json`, `install.sh`
- `bin/` — CLI entrypoints and role wrappers (`slp.mjs`, `slp-gate.mjs`,
  `*-role.mjs`, `slp-desk-mcp.mjs`, `slp-shim.mjs`)
- `skills/` — `paseo-slp-onboarding`, `paseo-slp-e2e`
- `src/` — role policy: `common.md`, `delegation.md`, `roles/{supervisor,lead,peer}.md`,
  `references/*`, `templates/workspace-protocol.md`
- `plugin/server/runtime/`, `plugin/shared/runtime/` — Paseo integration

## Invariants

- Embedded payload `plugin/server/generated/runtime-payload.ts` must match disk
  bytes AND modes — `npm run check:plugin-payload` enforces.
- File modes under payload paths: executables 755, everything else 644.
- Harness/session files must stay OUTSIDE these paths.

## Verification

- `npm run check` — `bin/slp.mjs identity` prints payload manifest
- `npm run check:plugin-payload` — regenerated payload byte-compare
