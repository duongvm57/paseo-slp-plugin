# Register native Antigravity role providers

- Status: Accepted
- Date: 2026-10-22
- Decided by: Lead
- Source: Human assignment to fix Paseo 0.12 compatibility and add Antigravity support
- Supersedes: none

## Context

Paseo v0.12.0 ships a native `agy` stream-json adapter. Its public provider
configuration cannot alias arbitrary native registrations through `extends`,
and the public SDK does not expose an adapter-decorating interface. The
upstream implementation does not consume MCP configuration.

## Decision

Register three role-specific native providers through the public plugin SDK.
Maintain a local adaptation of the upstream Apache-2.0 adapter with its license
and source notice. Share its implementation across roles; use an inert Node failure as the
default command and require configuration. Reject that default before any
discovery/connect callback. Host launch resolution needs a default command
even to resolve an explicit override. Owned entries omit `extends` only for these
registered provider IDs and point at verified session-grant launchers. Existing
create hooks supply role instructions. Stock provider configuration stays
Human-owned. Registration and bound launch transport must be enforced before
native process startup; protocol instructions cannot own that invariant.

Retain exact four/five-family histories and hashes while expanding new records
to six families. Historical receipts acquire no ownership of new slots until
a collision-checked rebind. The standalone CLI keeps its existing families;
it cannot register native providers without the manager plugin.

The Human additionally authorized isolated native CLI probes under
`.local-checks/skill-upstream-sync/0.12.0/`, using fake MCP services and no real
model/account. CLI 1.4.4 discovers a private custom agent through `--add-dir`,
but resume retains old MCP declarations. Use secret-free inline relays that
read current per-open environment. Give native server names a conversation
namespace and retain it across resume, avoiding global name collisions without
disabling the user's inherited rules/skills. Supply the current name mapping
on each prompt and pin the namespace, ABI and server-name set in v3 persistence.
Reject v1/v2 resumes with MCP; migrate histories without MCP. Private temporary carriers belong to the plugin's session
lifecycle; shared native config is never a transport mailbox. This preserves
per-session identity where protocol instructions cannot enforce launch data.

Reassert the current role bundle on every prompt. Retain native full access;
explicit toolPolicy preapproval and legacy SSE transport remain unsupported.

## Consequences

MCP plumbing now covers stdio and Streamable HTTP, including fresh credentials
on resume. Adding/removing MCP server names or changing the retained relay ABI
requires a new conversation. Require agy 1.4.4, the qualified CLI version, for
this new family. The Paseo compatibility floor and dependency pins do not move.
Native probes use fake services and prove transport, not live fleet acceptance
or model compliance. Supervision mappings still need normalized host fixtures.
No daemon install/reload, shared host config or publication follows from this
implementation.
