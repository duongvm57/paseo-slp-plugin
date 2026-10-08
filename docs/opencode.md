# OpenCode support

Managed and standalone OpenCode use the host's generic `acp` adapter and the
package's `bin/opencode-role.mjs` wrapper, running `opencode acp` over stdio.
The registry generates all three `slp-opencode-{supervisor,lead,peer}` aliases
with `extends: acp`. The complete launch bundle keeps model IDs (including
every slash), mode, thinking option and features. An owned OpenCode alias
extending native `opencode` is refused by launch-plan validation.

The shared ACP transform prepends role core, recovery and language instructions
to every `session/prompt`. First prompts and prompts re-armed by load/resume/fork
also carry the entry helpers and measured policy carrier. Other protocol frames
retain their original bytes. `config.systemPrompt` is preserved in the create
request, but generic ACP does not deliver that field: role delivery depends on
the wrapper rather than on that hook field. This transport does not introduce
an OpenCode plugin, API proxy or `AGENTS.md` installation workaround.

Managed launchers verify the frozen manifest and installed candidate before
entering the wrapper. For a daemon-stamped session (`PASEO_AGENT_ID`), the
shim requires a nonempty per-open `SLP_SESSION_OPEN_GRANT` from the enabled
`agent.session_open` hook before spawning the ACP child. The wrapper consumes
and strips the grant; nested children cannot reuse it. Plugin disable/removal
or a reload gap therefore refuses a new managed session open. An already open
session is not stopped by disable. On the measured host, an early wrapper
exit can leave Generic ACP initialization waiting: disabled create/reload/resume
requests may time out instead of returning a typed rejection. The guard still
refuses the real ACP child before session start or user work. Capability/catalog initialization without
an agent ID and a bare `--version` probe remain available. Standalone ACP
remains usable without the managed plugin or a session-open grant.

This lifecycle invariant belongs to the package launcher: the repository
protocol cannot prevent an ungranted subprocess from starting. It adds no
permission grant, setting, task workflow or repository ceremony. Native `serve`
and other non-ACP session invocations are refused by the OpenCode wrapper.

Executable selection requires a recognized OpenCode V2 version >=2.0.10,
rejecting V1, too-old V2, unknown majors and malformed output. The wrapper
re-probes before ACP launch because a validated PATH alias may change targets.
This is an eligibility check, not proof for every eligible build. The measured
host tuple is installed Paseo 0.10.3 / OpenCode 2.0.24; the plugin manifest
requires Paseo >=0.10.3. Future builds are not automatically live-tested or
E2E-accepted. No install, update, authentication or config repair is attempted
as a fallback. Standalone `--version` preserves argv, env, stdout/stderr and
exit status without opening a session.

Paseo generic ACP forwards advertised MCP/config-option support. Preserving
an SLP bundle does not prove that every host maps every feature or thinking
option to OpenCode. Unsupported selections belong to host validation; this
wrapper does not invent native-to-ACP conversions. OpenCode 2.0.24 exposes
`build`/`plan`, nested model IDs and effort `low`/`high`/`max`/`default`.
Exact MCP tool preapproval, child-env delivery, actual role delivery at the
model and ACP model generation remain unproven. No-prompt session/catalog
proof and local protocol assertions are not E2E acceptance. OpenCode
supervision brief/handback/send-result shapes also remain unverified; the
observer reports the gap instead of borrowing another family.

Native OpenCode V2 is unsupported as an SLP managed transport. Earlier native
proof on 0.10.3/2.0.24 showed `systemPrompt` reaching
`session.instructions.entry.put`, but a healthy plugin-disabled create
without that field could bypass the sentinel: the host acquired a shared
runtime without the session environment. That route was removed as the
managed default. Its prior successful model call does not prove ACP model
delivery. Separately, the native cold selector can fall back to a legacy
singleton after failed version discovery and lose alias settings; the package
does not claim that unsupported route fails closed. Existing native runtime
candidates retain their recorded bytes and require explicit rebind to the
current ACP configuration. The manifest serializer recognizes recorded
native gate scripts for byte verification; the current gate refuses that
retired marker even with a live grant. No native opt-in is offered and no
host/upstream code is patched.

V2 [instructions configuration](https://dev.opencode.ai/v2/docs/instructions/)
parses file/glob/URL entries without resolving their contents into model
instructions. V1 [rules](https://opencode.ai/docs/rules/) and
[inline configuration](https://opencode.ai/docs/config/) do not establish a
V2 file transport; the package does not use one.

Persisted compatibility is historical-aware: exact legacy4/legacy12 and
current5/current15 domains are admitted; partial, mixed and unknown sets are
refused. Persisted observations also retain the bounded native `extends:
opencode` field verbatim; it is not a current authored provider or launch
transport. New owned OpenCode entries require `extends: acp`. Reading old bindings, plans, snapshots and standalone receipts adds
no default OpenCode fields and verifies their original recorded digests.
New activation plans/snapshots/bindings use current5/current15 while retaining
the exact original baseline and legacy history. Recovery may restore an
already pinned legacy binding verbatim; it cannot author a modified legacy
artifact. Legacy profile-preference acknowledgment requires activation into
the current domain rather than rewriting old hashes through reconcile.

An ID missing from a historical vocabulary carries no old ownership. Rebind
requires newly introduced IDs to be absent or explicitly and exactly adopted.
Deactivation and historical recovery patch only their recorded ownership
sets, preserving unrelated new-family entries. Historical endpoint comparison
also computes unrelated-state hashes using its original provider domain.
Legacy launch sets are verified against their recorded four-family manifests;
new publication requires the complete current domain. These are package
receipt/transaction invariants: a repository protocol cannot validate another
daemon's persisted ownership, hashes or CAS writes.

The standalone installer additionally reads a distinct, previously supported
Codex3 format: exactly three `slp-codex-{role}` providers and three matching
Supervisor/Lead/Peer profiles. It verifies the installed manifest and raw
binding digest first, then validates that historical shape without rewriting.
Successful upgrade writes current15, preserving old files, original MCP
baseline and preferences, and archives the retired `slp-peer` row. This domain
never enters the plugin journal or launch-manifest decoder.
