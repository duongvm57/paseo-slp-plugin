# Supervision evidence fixtures

These fixtures support the capture contract in
[communication supervision](../../../docs/spec/supervision-integration.md).
They establish observed normalized shapes, not current-host compatibility or
model calibration. New parser/transmission lanes require actual host evidence;
a mapper-derived example alone never qualifies a positive lane.

## Provenance and sanitization

The live timelines were observed on 2026-09-26 with Paseo host 0.9.1. Initial
source inspection used plugin/client/protocol declarations 0.8.0; those are
historical evidence versions, not this checkout's dependency pins.
The host timeline projection is the normalized input to `agent.turn_ended`.
Each fixture's `provenance.rawSha256` pins its unsanitized source.

IDs, free-text bodies, commands, paths and output were remapped/replaced.
Booleans, numbers, nulls, key sets, nesting, statuses, errors, tool names and
ACP titles retain their emitted structure. Devin messages keep transport
prefix/carrier structure with the policy core elided. No fixture should contain
real prompts, credentials or native session identities.

| Fixture | Observed shape and limits |
|---|---|
| `live-codex-peer.timeline.json` | Codex brief/handback and confirmed sends; normalized `paseo.send_agent_prompt` with `structuredContent.success`. |
| `live-claude-peer.timeline.json` | Claude brief/handback and sends; verbatim `mcp__paseo__send_agent_prompt`, semantic result nested under `output.output`. |
| `live-pi-peer.timeline.json` | Pi brief/handback and sends; proxy `mcp__paseo`, object `args`, semantic result under `details.mcpResult`. Discovery calls are not sends. No failed Pi send or Pi Lead was observed. |
| `live-devin-peer.timeline.json`, `live-devin-lead.timeline.json` | Exact ACP role wrappers and send input; MCP updates expose only completion status, no semantic result. Send outcomes stay unknown, including Lead handling. |
| `live-devin-launch-peer.timeline.json` | ACP role wrapper around the compact launch envelope; capture strips both exact validated layers. |

Live Claude/Pi evidence contradicted the earlier derived string-args/flat-result
examples. Those examples are not supported positive shapes. Current negative
controls mutate the observed envelopes in `plugin-supervision-capture.test.mjs`.
Pi's compact launch wrapper has a real-builder synthetic test, not live evidence.
Devin plain follow-ups were observed only as metadata in a later run; synthetic
tests pin the strict transport-trace distinction without claiming a live fixture.
OpenCode and Antigravity timeline/send shapes remain unverified.
The Paseo 0.12 `agent_message` tests are source-derived host projection
controls, including mid-turn steering and malformed metadata. They preserve
existing family verification and do not qualify a new live provider lane.

## Host capability limits

- Lifecycle records do not supply authoritative report recipients, assignment
  file contents or Lead read receipts. Pointer files are never read by capture;
  validated inline assignment snapshots are ordinary brief text.
- A saved route whose agent cannot be refreshed stays unverified until matching
  lifecycle evidence arrives. Returned snapshots must match the exact role and
  workspace. A title or provider alias alone cannot qualify a route.
- Delivery revalidates recipient and route, records intent before send and
  never retries an uncertain result. It defers for a running Supervisor; an
  idle-to-running race can still interrupt. Host-side message-ID deduplication
  is defence in depth, not the plugin's attempt-store oracle.
- Normalized per-family success is independent from tool completion. Unknown
  or contradictory shapes remain unknown; a related send cannot prove success
  for another call.

`ack-closure-eval.json` is a bounded synthetic rubric diagnostic. It does not
establish live task fitness or calibration. The current Human shadow pilot,
false-alert classes, sample and cost ceiling remain explicit acceptance choices.
