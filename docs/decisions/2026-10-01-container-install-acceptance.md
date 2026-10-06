# Install acceptance runs in a disposable container

- Status: Accepted
- Date: 2026-10-01
- Decided by: Human (duongvm)
- Source: Supervisor notebook (local, gitignored), entry 2026-10-01 "P5 handback verified, gate dispatched"
- Supersedes: none

## Context

Proving that Paseo plus the plugin installs and loads needed an environment
independent of the developer host. Host installs touch the real Paseo home
and daemon, which the local checks must not do.

## Decision

Install-and-load acceptance uses the container harness under
`tests/container/` (`./tests/container/run`). It builds from this checkout and
runs inside Docker: no host install, no real home, no host daemon, no real
auth. It supplements, and does not replace, the isolated `npm test` run.

## Consequences

Needs a Docker daemon and outbound network for image build. A passing run is
install/load evidence only; it is not live E2E acceptance. Revisit if CI
gains a container runner.
