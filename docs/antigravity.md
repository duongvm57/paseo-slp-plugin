# Antigravity support

SLP recognizes Antigravity for saved role routing and Peer pool choices. The
manager plugin registers `slp-antigravity-supervisor`, `slp-antigravity-lead`
and `slp-antigravity-peer`, using `agy` stream-json. Install and sign in to
Antigravity separately. This integration requires **agy 1.4.4 or newer**, the
first CLI version qualified by the isolated native transport probes. An
explicit `binaries.antigravity` selects an executable outside PATH. Catalog
admission checks the version before opening a session; models come from native
discovery.

The adapter derives from Paseo v0.12.0 and retains its Apache-2.0 license and
source notice. It uses public SDK interfaces and registers native providers
without `extends`. Owned configuration points at verified session-grant
launchers. An inert Node failure is the registration's default command;
callbacks reject it before discovery/connect. This prevents unguarded `agy`
when older hosts ignore `requiresConfiguration`, while allowing their command
override resolution. Paseo dependency pins and `requirements.paseo` are unchanged.

## MCP and role delivery

The adapter passes Paseo's current `mcpServers` to native custom-agent MCP
relays. Stdio servers receive their command, args, cwd and env. Streamable HTTP
servers receive their URL and headers through a stdio relay, including session
headers and JSON/SSE response handling. Requests with uncertain HTTP outcomes
are reported as errors without replay. Legacy SSE transport is rejected before
native session startup. The per-open environment bundle is limited to 64 KiB.

Each open creates a private temporary customization directory, discovered with
`--add-dir` and selected with `--agent`. The original cwd stays unchanged.
Declarations contain inline relay code and private server aliases; endpoints and
credentials come from the current process environment. No shared Antigravity
config or workspace customization file is edited. Temporary carriers are
removed when the provider session closes, including failed opens.

This indirection matters on resume: agy retains the old MCP declarations even
when a new `--agent` is supplied. The retained relay therefore reads fresh
per-open configuration. Every conversation receives a random namespace for its
native MCP aliases, retained on resume. This avoids collisions with inherited
global MCP names without disabling user rules/skills. Each prompt supplies the
logical-to-native server mapping. Inherited servers remain separate services;
this mapping is routing information, not a tool sandbox.

Persistence v3 pins the namespace, server-name set, Node executable and relay
ABI. Changing a server's endpoint, command, args, env or transport is
allowed; adding/removing server names or changing the relay ABI requires a new
conversation and fails explicitly instead of using stale transport. A v1/v2
conversation cannot resume with MCP servers because it has no retained safe
namespace. Histories without MCP migrate to v3 on resume.

Current role instructions are prepended to **every user prompt**, including
follow-ups and resume, so the next prompt reasserts them after compaction.
This is a user-message carrier; it does not prove native model compliance or
policy survival within an uninterrupted long turn.

Full access remains the only mode. The provider does not negotiate explicit
`toolPolicy` preapproval; CLI full access auto-approves tools, subject to native
policy denial. Paseo's provider-specific tool catalog filtering still belongs
to the host. Registration requires the manager plugin; standalone CLI
installations do not emit these native providers.

## Evidence limits

Local tests and isolated native CLI probes cover the MCP relay and its
configuration, startup/resume and simultaneous sessions using fake services,
including a global MCP decoy with the same logical name. HTTP empty/202/204
request responses produce an outcome-uncertain error without replay.
The probe has no host network or real credentials and calls no real model.
This is not live Paseo fleet/desk E2E acceptance. Antigravity supervision
brief/handback/send mappings remain unverified until actual normalized host
fixtures are available.
