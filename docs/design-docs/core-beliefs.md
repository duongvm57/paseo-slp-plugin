# Core Beliefs

Beliefs every design in this repo must preserve. Sourced from `AGENTS.md` +
`docs/contract.md` — this file indexes them, it does not replace them.

1. **Delegation goes through Paseo `create_agent`.** No native sub-agent tools,
   ever — including when a skill asks for sub-agents.
2. **Authority comes from the Human assignment.** Installed role policy and
   workspace protocol implement it; nothing below them invents authority.
3. **Evidence is mechanical, not testimonial.** R1 pins mutation logs with
   verbatim `sha256sum`; R2 makes the replayed log the record. A claim without
   its artifact is not evidence.
4. **The payload is byte-compared.** Anything under `installUnitPaths`
   (package.json, install.sh, bin/, skills/, src/, plugin/{server,shared}/runtime)
   must keep content AND file modes stable, or `check:plugin-payload` fails.
5. **release-please owns versioning.** Never hand-edit CHANGELOG release
   sections, the version field, or create tags/releases.
6. **One writer per moving scope.** Preserve unrelated work; keep repo tactics
   in `e2e/workspace-protocol.md`, out of global role policy.
