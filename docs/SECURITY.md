# Security

## Trust boundaries

- **Payload**: `installUnitPaths` content ships inside the Paseo plugin unit.
  Tamper evidence = `check:plugin-payload` byte+mode compare plus
  `bin/slp.mjs identity` manifest (sha256 per file).
- **Authority**: task authority comes from the Human assignment — no file,
  test, or agent self-declares permission (`docs/contract.md`).
- **Evidence**: R1/R2 rules make mutation claims verifiable without trusting
  the claimant (see `AGENTS.md`).

## Rules for contributors

- Never commit credentials, tokens, or host-specific secrets. Repo history is
  scanned by GitGuardian in CI.
- Do not weaken gates: policy-doctrine pins, payload byte-checks, and review
  gates are the security model — bypassing them is a policy change, not a fix.
- Other repositories are read-only unless the assignment explicitly grants
  write scope.
