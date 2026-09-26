# Supervision host-capability evidence and sanitized family fixtures

Evidence collected 2026-09-23 for `docs/spec/supervision-integration.md`
(implementation order step 1: host evidence first — record missing shapes
before any parser workaround). Sources, all read-only:

- Installed plugin SDK declarations `@getpaseo/plugin@0.8.0`,
  `@getpaseo/client@0.8.0`, `@getpaseo/protocol@0.8.0` under `node_modules/`
  (this checkout, after `npm ci`).
- Installed daemon provider mappers `@getpaseo/server@0.9.1` under
  `~/.local/share/fnm/.../@getpaseo/cli/node_modules/@getpaseo/server/dist/
  server/server/agent/providers/` (the running daemon's normalization layer —
  a different package than the 0.8.0 plugin SDK; cited as `S/...` below where
  `S` = that providers directory).
- Upstream `hoangnb24/paseo-supervision` `docs/INPUT_SHAPES.md` @
  `1bad19b8ee6c58482494f56a3d8c6edb4f969ee1` (read via GitHub; it documents one
  normalized Codex `send_agent_prompt` shape and explicitly does not establish
  the same shape for other providers).
- Provider-side session records observed read-only on this machine:
  Devin `~/.local/share/devin/cli/sessions.db` `tool_call_state` rows,
  Pi `~/.pi/agent/sessions/*.jsonl` toolCall/toolResult pairs,
  Claude `~/.claude/projects/*/*.jsonl` tool_use/tool_result blocks.
- This session's own agent record: `labels["paseo.parent-agent-id"]` is the
  parent-link carrier on snapshots (verified live).

## Host capability matrix

| # | Spec row / capability claim | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Lifecycle hooks `server.on("agent.created" | "agent.archived" | "agent.turn_started" | "agent.turn_ended")` and `server.before("agent.create" | "agent.session_open")` exist in the pinned 0.8.0 SDK | confirmed | `node_modules/@getpaseo/plugin/dist/server/lifecycle.d.ts:44-90` — `PluginLifecycleEvents` (turn_started/turn_ended/permission_*/archived/created/workspace.*) and `PluginBeforeRequests` (agent.create/agent.session_open/workspace.create) with `on`/`before` registrations. Hook context is `{paseo: PaseoApi, signal: AbortSignal}` (same file, lines 4-7). |
| 2 | Hook agent record carries `parentAgentId` directly | confirmed | `lifecycle.d.ts:15-22` — `PluginHookAgent {id, workspaceId, parentAgentId, provider, cwd, title}`. `agent.turn_ended` payload is `{agent, turnId: string\|null, outcome: PluginTurnOutcome, timeline: readonly AgentTimelineItem[]}` (lines 49-54); `PluginTurnOutcome` also repeats `parentAgentId` + `labels` (lines 32-43). |
| 3 | Snapshot/agent record exposes parentage | confirmed-with-indirection | `AgentSnapshotPayloadSchema` (`@getpaseo/protocol/dist/messages.d.ts:465-530`) has NO `parentAgentId` field; parentage is `labels["paseo.parent-agent-id"]` (line 520 labels record). Verified live: this session's own agent labels carry the Lead's ID under that key. `archivedAt` is optional-nullable (line 528), `workspaceId` optional (line 469). |
| 4 | `registerSettings()` gives the server a read/subscription handle | **gap confirmed** | `node_modules/@getpaseo/plugin/dist/server/contracts.d.ts:11` — `registerSettings(...)` returns `void` in pinned 0.8.0. No server-side settings read exists. Design response per spec: private `slp-runtime/state/supervision.json` file, loaded at plugin start — no client bootstrap. |
| 5 | `AgentTimelineItem` shape (user_message, assistant_message, tool_call) | confirmed | `@getpaseo/protocol/dist/agent-types.d.ts:303-325` — the union; tool_call items are `ToolCallTimelineItem` (lines 255-280): `{type:"tool_call", callId, name, detail: ToolCallDetail, metadata?, status: running\|completed\|failed\|canceled, error}` with `detail.type:"unknown"` carrying free-form `input`/`output`. |
| 6 | Per-item turn ID on timeline messages | **gap confirmed (hook path)** | `AgentTimelineItem` union (agent-types.d.ts:303-325) carries no `turnId`. `agent.turn_ended` hook items are bare `AgentTimelineItem[]` (lifecycle.d.ts:49-54) and its event-level `turnId` may be `null`. Wrappers do carry optional `turnId`: stream `timeline` events (agent-types.d.ts:369-374) and timeline-refetch entries `AgentTimelineEntryPayloadSchema` (messages.d.ts:10737-10751, plus `timestamp`/`seqStart`/`seqEnd`/`sourceSeqRanges`). Design response: correlate on matched start/end observation order; ambiguity is unknown. |
| 7 | Normalized `send_agent_prompt` shape per SLP family | partial — per family below | Upstream observed the emitted item only for Codex. Devin/Pi/Claude fixtures here are provider-record + mapper-source derived; the daemon-emitted item was not directly observable (row 11). Families without a verified fixture stay `unknown` in the parser. |
| 8 | Agent refresh through the connected SDK | confirmed | `@getpaseo/client/dist/index.d.ts:259` — `PaseoAgentHandle.refresh(requestId?) → Promise<PaseoAgentRefetchResult \| null>`; result `{agent: PaseoAgent, project}` (lines 170-173); `null` when the agent is unknown. `PaseoAgent` carries `provider`, `workspaceId?`, `archivedAt?`, `labels`, `status` (snapshot schema above). |
| 9 | Cancel an already-issued `agents.ref(id).send()` | **gap confirmed** | `index.d.ts:260` — `send(text, options?: PaseoAgentSendOptions): Promise<void>`; options are `messageId`/`images`/`attachments` only (lines 181-188). No abort parameter. Design response (implemented in `plugin/server/supervision/delivery.ts` + observer dispatch): revalidate before send, bound the wait, mark before dispatch, report uncertain outcome without retry. |
| 10 | `assignmentFile` visibility / Lead read receipts | **gap confirmed** | Lifecycle events (lifecycle.d.ts:44-76, complete list) carry no file-read or read-receipt signal; a brief can embed only a path string. Design response: mark brief-visibility and Lead-receipt unknown; never read arbitrary files. |
| 11 | Structured report-recipient ID distinct from parent | **gap confirmed** | Hook record has `parentAgentId` (lifecycle.d.ts:18) and snapshots have only the parent label; neither carries the assignment's report route. This session's own assignment names a report recipient — it arrives in prompt text only. Route compliance stays unknown. |
| 12 | Read-only daemon/SDK timeline fetch from a Peer session | **gap confirmed** | `connect()` to the local daemon WS (127.0.0.1:6767) fails from this context (close 1006; the hello handshake needs session-bound auth). Provider-side stores (Devin `sessions.db`, Pi/Claude transcripts) remain readable; fixtures below derive normalized items from those records through the installed mapper source. |
| 13 | Non-interrupting send to a running agent | **gap confirmed** | `PaseoAgentSendOptions` (`@getpaseo/client/dist/index.d.ts:181-188`) exposes `messageId`/`images`/`attachments` only; host 0.9.1 `session.js` applies `activeTurnBehavior ?? "interrupt"` (protocol enum `interrupt`/`steer`). Design response: defer delivery while the refreshed Supervisor is `running`; no undeclared option is passed. |
| 14 | Host-side idempotency for a repeated `messageId` | confirmed (host 0.9.1 only) | `…/server/message-receipts/index.js`: receipts keyed by (agentId, messageId) with a request fingerprint — completed replay is a no-op, pending replay throws `agent_request_outcome_unknown`, different body throws `agent_request_key_conflict`. Design response: deterministic message id and alert body as defence in depth; the plugin's own attempt store stays authoritative. |
| 15 | Plugin-session refresh of a live SLP agent | **observed, root cause unconfirmed** | Live 2026-09-26 (host 0.9.1, app via relay): `set-supervision` for a live `slp-devin-lead` failed `Agent not found … requestType=plugin.rpc.invoke.request code=handler_error` from `paseo.agents.ref(id).refresh()` in the plugin handler, while the app listed the agent. Host `getAgentPayloadById` returns null only via `isProviderVisibleToClient`. Design response: a save without a snapshot records the agent `unverified` and lands; routes observe only on host evidence (discovery with matching workspace); delivery re-checks the recipient before every send. |
| 16 | Normalized timeline items of the smoke actors | confirmed (2026-09-26) | Read-only `client.fetchAgentTimeline(id, {projection:"projected"})` for the authorized smoke Peers (codex, claude, devin) and their devin Lead only. The projection rows are the ones `agent.turn_ended` receives (`agent-manager.js:3483` passes `timelineStore.getItems(agentId)`; `agent-timeline-store.js` `getItems` and `fetch` read the same `projection.getRows()`; the session filters only item types a client cannot render). The worker restarted after the smoke and re-seeded the store from committed durable rows (`loadCommittedTimelineSeed`), i.e. rows committed from the live stream. Sanitized into `live-*.timeline.json` (collector and sanitizer: `.local-checks/supervision-provider-design-20260926/implementation/`). |
| 17 | Claude send result shape | confirmed | Live item: `detail.output = { output: { success, status, lastMessage, permission } }` — host `claude/agent.js` `buildToolOutput` wraps `JSON.parse(tool_result text)` under `output`. The earlier probe read `output.success`, so the smoke's `send-result-unsuccessful` was a parser miss, not a failed send. `is_error` or a denied permission → status `failed`, `output` null, `error` set. |
| 18 | Devin send result | **gap confirmed at the provider** | Live items (Peer and Lead): title `Calling send_agent_prompt from paseo`, input `{prompt, agentId, …}`, `output: null`; every Devin MCP tool has `output: null`. The provider's own ACP record for the smoke Peer (`sessions.db` `tool_call_state`) holds `rawInput` + `_meta` on the call and only `{status:"completed"}` on the update — no `rawOutput`, no `content`. The host mapper would keep either (`acp-agent.js` `mergeToolSnapshot` / `buildDefaultToolDetail`), so a mapper fix cannot help; a provider change or a daemon send receipt would. Devin outcomes stay unknown. Devin user messages have two observed wrappers: the full SLP ACP role prefix from `src/role-transport.mjs`/`src/role-bundle.mjs`, and a compact non-stock launch envelope from `src/launch.mjs`. The capture adapter accepts only those exact shapes. |
| 19 | Pi normalized items | confirmed (2026-09-26, one authorized pi Peer) | Coordinator capture of pi Peer `slp-pi-peer` (model openai-codex/gpt-6-luna), same `fetchAgentTimeline` projection as row 16; sanitized into `live-pi-peer.timeline.json` (`rawSha256` 3381787b…). Items are `{type, callId, name, status, error, detail}`; user messages carry no role prefix (policy via `--append-system-prompt`). The send is the proxied tool `mcp__paseo` with `detail.input = {tool:"paseo_send_agent_prompt", args:{agentId, prompt}}` — **args is an object** — and `detail.output = {content:[{text:<JSON copy>}], details:{mode:"call", server:"paseo", tool:"send_agent_prompt", mcpResult:{content, structuredContent:{success,…}}}}`. Before it the Peer made four `mcp` proxy discovery calls (`search`, list, `connect`, `describe` of `paseo_send_agent_prompt`) — not sends. A failed pi tool (`bash`) carries `status:"failed"` and `error:{content:[…]}`. Not observed: a failed/rejected pi send, the bare `mcp` proxy naming the send tool, string args, a pi Lead. |
| 20 | Compact SLP launch envelope | observed in live Codex, Claude and Devin rows (2026-09-26); Pi is synthetic-only | Projected `user_message` may begin `SLP role=<role>\n\nLaunch binding: <JSON>\nAssignment:\n<body>`. Capture validates role against the actor and bound SLP provider family, then retains only `<body>`; launch metadata never enters the Jev packet. The i4 Devin timeline SHA is pinned in `live-devin-launch-peer.timeline.json`, with assignment text replaced. Devin can also have the full ACP role policy wrapping this compact envelope; the parser strips both exact layers. Malformed, wrong-role, merged or cross-family bindings stay unverified. |
| 21 | Devin plain follow-up | observed in r4 (metadata only, 2026-09-27) | Root verification of the single r4 Devin Peer projection (shape only — no body read or committed): the audit turn parsed; an ACK/follow-up turn opened with an ordinary `user_message` carrying no `SLP role`/launch wrapper, then the assistant reply, and was rejected as `role-prefix-unrecognized` by the strict parser. Capture `slp-capture-5`/`-6` reads a Devin message with no SLP transport trace verbatim (`devin-plain-message-v1`); any fixed structural line of the renderers (role line, terminal-line halves, recovery/snapshot lines, onboarding locator, managed-runtime helper block, communication-language line, work-tracker line, carrier, launch binding — `-6` added the snapshot/onboarding/helper/language/tracker lines) keeps the strict path. Free role-file policy prose is not a marker (disclosed residual). Not established from metadata: whether that message was recorded by the host from the submitted prompt or echoed by the provider. Pinned by synthetic tests; no r4 fixture is committed. |

## Provider-family fixtures

One file per family: `<family>.send-agent-prompt.json`. Each carries
`providerRecord` (the sanitized provider-side evidence where observed),
`items[]` (the normalized `AgentTimelineItem` the daemon mapper produces),
and `expect` (what the phase-B parser must extract: recipient, prompt,
confirmed flag). All IDs, bodies and call IDs are synthetic — no real session
content.

| Family | File | Status | Normalized `send_agent_prompt` shape |
| --- | --- | --- | --- |
| codex | `codex.send-agent-prompt.json` | **confirmed** (upstream observed the emitted item; mapper verified) | `name: "paseo.send_agent_prompt"`, `detail:{type:"unknown", input:{agentId,prompt,...}, output:{structuredContent:{success:true,...}}}`. Mapper: `S/codex/tool-call-mapper.js:461-470,704-722`, `S/codex/tool-call-detail-parser.js` deriveCodexToolDetail unknown fallback. |
| devin | `devin.send-agent-prompt.json` (+ `live-devin-peer/lead.timeline.json`, observed) | name/input observed; outcome not emitted by the provider | `name` is the ACP title `"Calling send_agent_prompt from paseo"` (kind is absent on MCP calls → title wins); `detail:{type:"unknown", input: rawInput, output: null}` — **the provider emits no result for MCP calls (row 18), so `structuredContent.success` is not observable**; `status:"completed"` is the only delivery signal. Failed calls with text content normalize to `detail.type:"plain_text"`. Mapper: `S/acp-agent.js:2444-2452,2463-2492,2506-2548,2605-2626`. Provider record: `tool_call_state` rows with `_meta["cognition.ai/toolName"]="mcp__paseo__send_agent_prompt"`. |
| pi | `pi.send-agent-prompt.json` (superseded by `live-pi-peer.timeline.json`, observed — row 19) | mapper-derived; **contradicted by the live item** (name `mcp__paseo`, object args, result under `details`) | `name:"paseo.send_agent_prompt"` (resolved from `result.details.server`+`details.tool`, else from `args.tool` split); `detail:{type:"unknown", input:{tool:"paseo_send_agent_prompt", args:"<JSON STRING>"}, output:{details:{mcpResult:{structuredContent:{success:true}},server,tool}, isError:false}}`. **The args payload is a nested JSON string** — a second `JSON.parse` is required; malformed args stay unknown. Mapper: `S/pi/tool-call-mapper.js:135-165` + `mapToolDetail` default. Provider records: `~/.pi/agent/sessions/…/*.jsonl`. |
| claude | `claude.send-agent-prompt.json` (superseded by `live-claude-peer.timeline.json`, observed) | **confirmed** (row 17) | `name` keeps the verbatim wire form `"mcp__paseo__send_agent_prompt"`; `detail:{type:"unknown", input:{agentId,prompt,...}, output:{output:{success,…}}}` — the mapper parses the tool_result text and nests it under `output`. The older mapper-derived fixture's flat `output` string was wrong for the emitted item. Mapper: `S/claude/tool-call-mapper.js` resolveClaudeToolKind→`unknown`, name passthrough; `S/claude/tool-call-detail-parser.js:107-128`. |

### Live timeline fixtures (observed)

`live-{codex,claude,devin,pi}-peer.timeline.json` and `live-devin-lead.timeline.json`
are whole sanitized projected timelines (rows 16–19): ids remapped, every
free-text body/prompt/command/path/output replaced, while booleans, numbers,
nulls, key sets, nesting, statuses, errors, tool names and ACP titles are kept
verbatim. Devin user messages keep the role-prefix structure (first line,
verbatim terminal line, carrier line formats) with the policy core elided.
`provenance.rawSha256` pins the unsanitized source. They back all observed
shapes; the shared compact launch-envelope wrapper also has a real-builder
synthetic test for Pi because its live Peer message did not carry that wrapper.

### Known caveats carried into phase B

- Before 2026-09-26 only codex had an *observed normalized* item (upstream).
  Live observation contradicted both the mapper-derived claude fixture
  (row 17) and the mapper-derived pi fixture (row 19: name, args encoding and
  result location all differ), which is why derived fixtures never open a
  shape; the shapes only they show stay unverified.
- Devin cannot prove `structuredContent.success`; its `completed` status is
  weaker evidence than the other families' result bodies.
- Pi's nested-string args and Claude's `mcp__`-prefixed name mean a naive
  `name === "paseo.send_agent_prompt" && typeof input.agentId === "string"`
  parser misses them entirely — they need per-family extraction, and anything
  unrecognized must return `unknown`, never a guess.
- No fixture contains credentials, real prompts, real agent IDs, or native
  session IDs.
