// plugin/server/supervision/capture.ts — the capture module: one entry point
// that turns an agent.turn_ended event into communication EVIDENCE with
// provenance (spec docs/spec/supervision-integration.md §Observation and
// correlation; design .local-checks/supervision-provider-design-20260926/
// design.v2.vi.md §4).
//
// Structure informed by hoangnb24/paseo-supervision server/communication.ts
// @ 1bad19b8ee6c58482494f56a3d8c6edb4f969ee1 (Apache-2.0) — the correlation
// idea (latest user_message boundary, confirmed-send evidence) is adapted;
// the per-family adapters below are SLP-specific and open shapes backed by
// real normalized fixtures (tests/fixtures/supervision/). The common launch
// envelope parser is source-derived from src/launch.mjs and synthetically
// pinned for Pi, whose live message had no such wrapper.
//
// Evidence is separate for the brief, the handback, each send's INPUT and
// each send's OUTCOME — a family never gates a whole case. `verified` means
// the mapping has a real normalized fixture and the current item matches
// that shape; it never means the content is right, the author is
// authenticated, the recipient read it or the work is accepted.
//
// Pure and deterministic: no I/O, never throws; an unexpected item becomes a
// local reason. Unverified evidence never carries a body out of this module,
// and neither does a send whose outcome is not accepted.
import { createHash } from "node:crypto";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { z } from "zod";
import { familyFromProviderId, ROLES } from "../../shared/families.ts";
import type { FamilyId } from "../../shared/families.ts";
import { isSlpLead, isSlpPeer, isSlpSupervisor } from "../../shared/supervision.ts";

export type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
export type TurnStarted = PluginLifecycleEvents["agent.turn_started"];

/** Parser generation recorded with every assessment (ring metadata). */
export const CAPTURE_VERSION = "slp-capture-6";

// Bounded reason vocabulary (wire-visible in the observations list — reason
// codes only, never message text). Codes no longer produced stay listed so
// older ring rows keep reading.
export const VISIBILITY = {
  unsupportedFamily: "unsupported-family",
  briefAssignmentFile: "brief-references-assignment-file",
  // Legacy code kept for older ring rows.
  briefSourceAmbiguous: "brief-source-ambiguous",
  briefMissing: "brief-missing",
  handbackMissing: "handback-missing",
  // The message exists but its mapping is not verified for this item.
  briefUnverified: "brief-unverified",
  handbackUnverified: "handback-unverified",
  // Causes behind an unverified message.
  turnBoundaryUnverified: "turn-boundary-unverified",
  rolePrefixUnrecognized: "role-prefix-unrecognized",
  peerTurnNotCompleted: "peer-turn-not-completed",
  leadTurnNotCompleted: "lead-turn-not-completed",
  sendNotCompleted: "send-not-completed",
  sendInputUnparsed: "send-input-unparsed",
  sendResultUnobservable: "send-result-unobservable",
  // Provider-family coverage is unavailable even when this timeline contains
  // no send call. Keep it distinct from one call whose result is missing.
  sendCoverageUnverified: "send-coverage-unverified",
  sendResultUnsuccessful: "send-result-unsuccessful",
  sendResultContradictory: "send-result-contradictory",
  recipientRefreshFailed: "recipient-refresh-failed",
  recipientInactive: "recipient-inactive",
  leadStartUnmatched: "lead-start-unmatched",
  // Chronology proven by the ended turn's own ordering rather than an
  // observed turn-start — informational only, never a gate reason (the
  // derivation is honest evidence, not an ambiguity).
  leadStartEndDerived: "lead-start-end-derived",
  // No verified host record names the Lead's provider, so its send
  // coverage cannot be looked up.
  leadProviderUnknown: "lead-provider-unknown",
  reportRouteUnverifiable: "report-route-unverifiable",
  familyShapeUnverified: "family-shape-unverified",
  // A send recognized by a known alias or a JSON-string input whose exact
  // normalized shape has no real-timeline fixture — parsed, never confirmed.
  sendShapeUnverified: "send-shape-unverified",
  // The packet exceeded its byte cap with cross-Peer bodies, so they were
  // withheld (ids kept) — cross-Peer disposition is unjudgeable.
  otherRoomBodiesOmitted: "other-room-bodies-omitted",
  noCommunication: "no-observable-communication",
  capturePaused: "capture-paused",
  queueOverflow: "queue-overflow",
  caseCeiling: "case-ceiling",
  evidenceOversize: "evidence-oversize",
  assessmentCeiling: "assessment-ceiling",
  caseExpired: "case-expired",
  credentialGuard: "credential-shaped-content",
} as const;

// --- evidence model ----------------------------------------------------------

/** missing: the timeline region is known and the message is not there.
 *  unverified: the message cannot be read with a verified mapping (unknown
 *  turn region, unverified family shape, unrecognized envelope). */
export type Evidence<T> =
  | { state: "verified"; value: T; shapeId: string }
  | { state: "missing"; reason: string }
  | { state: "unverified"; reason: string };

export interface CapturedMessage { text: string; messageId: string | null }

/** accepted: semantic success of exactly this call in a verified shape.
 *  rejected: an explicit failure result tied to this call. unknown:
 *  anything else (running, canceled, missing output, unverified shape,
 *  contradictory envelopes) — a canceled call may still have delivered. */
export type SendOutcome =
  | { state: "accepted"; shapeId: string }
  | { state: "rejected"; reason: string }
  | { state: "unknown"; reason: string };

export interface SendInput { recipient: string; prompt: string }

/** One send_agent_prompt call. The prompt is present only when the input is
 *  verified AND the outcome accepted; otherwise it is emptied here so no
 *  caller can transmit it (ids and recipient stay for relatedness). */
export interface Send {
  callId: string;
  input: Evidence<SendInput>;
  outcome: SendOutcome;
}

/** Whether this family's send shapes are recognized, decoded and their
 *  outcomes verifiable — not that every send in the turn was accepted. */
export type Coverage = { state: "verified" } | { state: "unverified"; reason: string };

export type Capture =
  | {
      kind: "peer";
      id: string;
      leadId: string;
      peerId: string;
      turnId: string | null;
      brief: Evidence<CapturedMessage>;
      handback: Evidence<CapturedMessage>;
      /** The Peer's own sends (its reports) — informational lane only. */
      sends: Send[];
      sendCoverage: Coverage;
      /** Whole-turn provenance and content facts (reason codes). */
      issues: string[];
    }
  | {
      kind: "lead";
      id: string;
      leadId: string;
      turnId: string | null;
      sends: Send[];
      sendCoverage: Coverage;
      issues: string[];
      /** user_message positions inside the CURRENT turn slice — the same
       *  slice send extraction used, so at most the turn-opening message
       *  (latestTurn starts at the last user_message; nothing older can
       *  anchor this turn's handling). The raw material for the end-only
       *  chronology fallback (see handbackAnchorIndex). Text is the
       *  family-verified message body (a role prefix removed); an
       *  unverified mapping leaves the raw text, which can never match an
       *  envelope. Bodies live in-process only; the gate-down scrub empties
       *  them like every other captured body. */
      anchors: { index: number; text: string }[];
    };

export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The latest user_message is a CANDIDATE boundary — v0.8 timeline items carry
// no per-item turn id, so a handback can only be read as "last assistant
// message of the latest turn slice" (spec point 3). Never scan older turns.
export function latestTurn(timeline: readonly AgentTimelineItem[]): readonly AgentTimelineItem[] {
  // ES2022 lib — no findLastIndex; the slice starts at the last user_message.
  const start = turnStart(timeline);
  // No user_message at all: the event items are this turn's own records (a
  // Lead turn that consists of a single send_agent_prompt has no fresh user
  // input). Dropping them would lose a delivered send entirely — fall back
  // to the whole item list; chronology gating still applies downstream.
  return start < 0 ? timeline : timeline.slice(start);
}
const turnStart = (timeline: readonly AgentTimelineItem[]): number => {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (timeline[i]?.type === "user_message") return i;
  }
  return -1;
};

// A brief that delegates its content to a file is not observable — a
// content fact the assessment turns into an unusable brief (never reads the
// path).
const ASSIGNMENT_FILE_RE = /assignment\s*file|assignmentFile|\.local-checks\//i;

type ToolCall = Extract<AgentTimelineItem, { type: "tool_call" }>;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const sendInputSchema = z.object({ agentId: z.string().min(1), prompt: z.string().min(1) });

// --- message mapping ----------------------------------------------------------

// The SLP ACP role transport (src/role-transport.mjs acpRolePrompt) puts the
// role policy in front of every Devin prompt: `entry()` on the first prompt
// of a session, `anchor()` after (src/role-bundle.mjs roleDelivery). Both
// start with `SLP role=<role>\n` and end with this exact line; `entry()` is
// followed by the measured carrier block. The strip accepts only that
// rendering (pinned by a test that renders the real bundle).
export const ROLE_PREFIX_TERMINAL =
  "Use the current authorized Human or delegated assignment and its Paseo workspace. Notifications and heartbeat prompts do not replace that assignment.\n";
const CARRIER_HEAD_RE = /^Spawn kit — role-scoped Paseo MCP signatures \(.*\):$/;
const CARRIER_LOCATORS_RE = /^Policy locators — .+:$/;
const CARRIER_LOCATOR_RE = /^- .+ — (\d+ bytes, sha256 [0-9a-f]{64}|declared but missing on disk)$/;
type LaunchEnvelope = { matched: false } | { matched: true; assignment: string | null };
const stripLaunchEnvelope = (text: string, expectedRole: string, expectedFamily?: FamilyId): LaunchEnvelope => {
  const launch = /^SLP role=([a-z]+)\n\nLaunch binding: ([^\n]+)\nAssignment:\n/.exec(text);
  if (launch === null) return { matched: false };
  if (launch[1] !== expectedRole) return { matched: true, assignment: null };
  let binding: unknown;
  try { binding = JSON.parse(launch[2] ?? ""); } catch { return { matched: true, assignment: null }; }
  if (!isRecord(binding) || typeof binding.provider !== "string" || binding.provider.length === 0 ||
      (binding.model !== undefined && (typeof binding.model !== "string" || binding.model.length === 0))) {
    return { matched: true, assignment: null };
  }
  const allowed = new Set(["provider", "model", "modeId", "thinkingOptionId", "features"]);
  if (Object.keys(binding).some(key => !allowed.has(key))) return { matched: true, assignment: null };
  if ((binding.modeId != null && typeof binding.modeId !== "string") ||
      (binding.thinkingOptionId != null && typeof binding.thinkingOptionId !== "string") ||
      (binding.features != null && !isRecord(binding.features))) {
    return { matched: true, assignment: null };
  }
  const bindingMatchesRole = expectedRole === "peer" ? isSlpPeer(binding.provider)
    : expectedRole === "lead" ? isSlpLead(binding.provider)
      : expectedRole === "supervisor" ? isSlpSupervisor(binding.provider)
        : false;
  if (!bindingMatchesRole || (expectedFamily !== undefined && familyFromProviderId(binding.provider) !== expectedFamily)) {
    return { matched: true, assignment: null };
  }
  const assignment = text.slice(launch[0].length);
  return { matched: true, assignment: assignment.endsWith("\n") ? assignment.slice(0, -1) : assignment };
};

/** The role-authored text after one SLP ACP role prefix, or null when the
 *  text is not exactly one recognized prefix + body for the expected actor.
 *  `expectedRole` is the captured actor's role and is required: the role
 *  written inside the text is never trusted on its own. */
export function stripAcpRolePrefix(
  text: string,
  expectedRole: "lead" | "peer" | "supervisor",
  expectedFamily?: FamilyId,
): string | null {
  const firstLine = text.slice(0, text.indexOf("\n") + 1);
  const role = /^SLP role=([a-z]+)\n$/.exec(firstLine)?.[1];
  if (role === undefined || !(ROLES as readonly string[]).includes(role) || role !== expectedRole) return null;
  // Non-stock providers do not receive the full inline role bundle. The
  // launch builder emits a compact envelope instead. Validate its binding
  // against the role, then keep only the assignment body; provider/runtime
  // metadata is not communication evidence for Jev.
  const directLaunch = stripLaunchEnvelope(text, role, expectedFamily);
  if (directLaunch.matched) return directLaunch.assignment;
  const end = text.indexOf(ROLE_PREFIX_TERMINAL);
  if (end < 0) return null;
  let body = text.slice(end + ROLE_PREFIX_TERMINAL.length);
  if (body.startsWith("\nSpawn kit — ")) {
    const lines = body.slice(1).split("\n");
    let i = 0;
    if (!CARRIER_HEAD_RE.test(lines[i] ?? "")) return null;
    i += 1;
    while (i < lines.length && (lines[i] ?? "").startsWith("- ")) i += 1;
    if (!CARRIER_LOCATORS_RE.test(lines[i] ?? "")) return null;
    i += 1;
    const firstLocator = i;
    while (i < lines.length && CARRIER_LOCATOR_RE.test(lines[i] ?? "")) i += 1;
    if (i === firstLocator) return null;
    body = lines.slice(i).join("\n");
  }
  // The ACP role transport can wrap the launch builder's compact envelope.
  // Strip both layers and reject a second malformed/role-mismatched marker.
  if (/^SLP role=[a-z]+\n/.test(body)) {
    const nestedRole = /^SLP role=([a-z]+)\n/.exec(body)?.[1];
    if (nestedRole === undefined || nestedRole !== role) return null;
    const nestedLaunch = stripLaunchEnvelope(body, role, expectedFamily);
    return nestedLaunch.matched ? nestedLaunch.assignment : null;
  }
  // A second prefix means prompts were merged into one message — the brief
  // boundary is ambiguous, so it is not read.
  if (body.includes(ROLE_PREFIX_TERMINAL)) return null;
  return body;
}

type MessageAdapter = {
  /** The Lead/host-authored body of a user_message and the mapping that
   *  produced it, or null if the item does not match a verified mapping. */
  userMessage(text: string, role: "lead" | "peer"): { text: string; shapeId: string } | null;
};

// Fixture-backed message mappings: first user_message of the turn slice is
// the brief, the last assistant_message is the handback.
//   codex  — live-codex-peer.timeline.json (+ upstream corpus)
//   claude — live-claude-peer.timeline.json
//   devin  — live-devin-peer.timeline.json (after role policy + launch wrapper)
//   pi     — live-pi-peer.timeline.json (role policy rides
//            --append-system-prompt, so user messages carry no prefix)
const stripCompactLaunch = (text: string, family: FamilyId, role: "lead" | "peer"): string | null => {
  const launch = stripLaunchEnvelope(text, role, family);
  if (launch.matched) return launch.assignment;
  // A message that starts like our wrapper but diverges from its exact,
  // fixture-backed envelope is ambiguous; never pass the wrapper to Jev as
  // if it were assignment prose.
  return /^SLP role=[a-z]+\n\nLaunch binding:/.test(text) ? null : text;
};
// Any trace of the SLP ACP role transport or launch builder anywhere in a
// Devin user_message — every fixed structural line the renderers emit
// (src/role-bundle.mjs roleDelivery/managedHelpers/communicationLanguage/
// carrierBlock, src/work-tracker.mjs workTrackerBlock, src/launch.mjs):
// the role line, either half of the terminal line, the recovery and snapshot
// lines, the onboarding locator, the managed-runtime helper block, the
// communication-language line, the work-tracker line, the carrier block, or
// a launch binding. Such a message goes through the strict parser (exact
// prefix, actor role, family); a trace in any other position — a merged or
// truncated wrapper — therefore fails closed. Free policy prose from the
// role files is not a fixed line and is not a marker.
const DEVIN_TRANSPORT_MARKERS: readonly RegExp[] = [
  /(^|\n)SLP role=/,
  /Use the current authorized Human or delegated assignment/,
  /heartbeat prompts do not replace that assignment/,
  /Installed policy directory: /,
  /Policy recovery command: /,
  /Snapshot command: /,
  /For repo setup\/update, use /,
  /Managed runtime helpers \(SLP_MANAGED_RUNTIME=1\)/,
  /the request must carry "paseoHome": /,
  /standalone installs only; the plugin owns this runtime's lifecycle/,
  /upgrade\/uninstall take no home flag/,
  /init\/materialize\/snapshot\/prepare\/prepare-handoff\/verify are repo-scoped/,
  /Communication language: /,
  /Work tracker: /,
  /Spawn kit — role-scoped Paseo MCP signatures/,
  /Policy locators — /,
  /Launch binding:/,
];
const hasDevinTransport = (text: string): boolean => DEVIN_TRANSPORT_MARKERS.some(marker => marker.test(text));
const mapped = (text: string | null, shapeId: string) => (text === null ? null : { text, shapeId });
const MESSAGE_ADAPTERS: Partial<Record<FamilyId, MessageAdapter>> = {
  codex: { userMessage: (text, role) => mapped(stripCompactLaunch(text, "codex", role), "codex-message-v1") },
  claude: { userMessage: (text, role) => mapped(stripCompactLaunch(text, "claude", role), "claude-message-v1") },
  // devin: a wrapped message must be exactly one recognized wrapper for the
  // captured actor's role; a message with no transport trace at all is the
  // prompt text as the host timeline records it (a plain follow-up, seen live
  // in r4) and is captured verbatim — the role comes from the host-verified
  // provider, never from the text.
  devin: {
    userMessage: (text, role) => hasDevinTransport(text)
      ? mapped(stripAcpRolePrefix(text, role, "devin"), "devin-acp-message-v1")
      : { text, shapeId: "devin-plain-message-v1" },
  },
  pi: { userMessage: (text, role) => mapped(stripCompactLaunch(text, "pi", role), "pi-message-v1") },
};

// The handback mapping (last assistant_message of the slice) is one shape per
// family, independent of how the opening user_message was wrapped.
const HANDBACK_SHAPES: Record<FamilyId, string> = {
  codex: "codex-message-v1", claude: "claude-message-v1", devin: "devin-acp-message-v1", pi: "pi-message-v1",
};

const unverifiedMessage = (reason: string): Evidence<CapturedMessage> => ({ state: "unverified", reason });

function peerMessages(family: FamilyId | null, timeline: readonly AgentTimelineItem[]): {
  brief: Evidence<CapturedMessage>;
  handback: Evidence<CapturedMessage>;
} {
  const adapter = family === null ? undefined : MESSAGE_ADAPTERS[family];
  if (adapter === undefined) {
    const reason = family === null ? VISIBILITY.unsupportedFamily : VISIBILITY.familyShapeUnverified;
    return { brief: unverifiedMessage(reason), handback: unverifiedMessage(reason) };
  }
  const start = turnStart(timeline);
  if (start < 0) {
    return {
      brief: unverifiedMessage(VISIBILITY.turnBoundaryUnverified),
      handback: unverifiedMessage(VISIBILITY.turnBoundaryUnverified),
    };
  }
  const opening = timeline[start] as Extract<AgentTimelineItem, { type: "user_message" }>;
  const body = adapter.userMessage(opening.text, "peer");
  const brief: Evidence<CapturedMessage> = body === null
    ? unverifiedMessage(VISIBILITY.rolePrefixUnrecognized)
    : body.text.trim() === ""
      ? { state: "missing", reason: VISIBILITY.briefMissing }
      : { state: "verified", value: { text: body.text, messageId: opening.messageId ?? null }, shapeId: body.shapeId };
  let handback: Evidence<CapturedMessage> = { state: "missing", reason: VISIBILITY.handbackMissing };
  for (let i = timeline.length - 1; i > start; i -= 1) {
    const item = timeline[i];
    if (item?.type !== "assistant_message") continue;
    if (item.text.trim() !== "") {
      handback = { state: "verified", value: { text: item.text, messageId: item.messageId ?? null }, shapeId: HANDBACK_SHAPES[family as FamilyId] };
    }
    break;
  }
  return { brief, handback };
}

// --- send adapters -------------------------------------------------------------

type SendParse = { input: Evidence<SendInput>; outcome: SendOutcome };
type SendAdapter = {
  /** Every family's outcomes decodable + input shape verified. */
  coverage: Coverage;
  /** null = not this family's send call. */
  parse(item: ToolCall): SendParse | null;
};

const unknown = (reason: string): SendOutcome => ({ state: "unknown", reason });
const rejected = (reason = VISIBILITY.sendResultUnsuccessful): SendOutcome => ({ state: "rejected", reason });
const unverifiedInput = (reason: string): Evidence<SendInput> => ({ state: "unverified", reason });

const objectInput = (raw: unknown, shapeId: string): Evidence<SendInput> => {
  if (!isRecord(raw)) return unverifiedInput(VISIBILITY.sendInputUnparsed);
  const parsed = sendInputSchema.safeParse(raw);
  return parsed.success
    ? { state: "verified", value: { recipient: parsed.data.agentId, prompt: parsed.data.prompt }, shapeId }
    : unverifiedInput(VISIBILITY.sendInputUnparsed);
};

/** Shared status rule: only a completed call can be accepted; running and
 *  canceled prove nothing either way. `failedOutcome` decides a failed
 *  call from its own evidence. */
const byStatus = (item: ToolCall, completed: () => SendOutcome, failedOutcome: () => SendOutcome): SendOutcome => {
  if (item.status === "completed") return item.error !== null ? unknown(VISIBILITY.sendResultContradictory) : completed();
  if (item.status === "failed") return failedOutcome();
  return unknown(VISIBILITY.sendNotCompleted);
};

// codex — verified shape (live-codex-peer.timeline.json, codex.send-agent-
// prompt.json): name `paseo.send_agent_prompt`, object input, output object
// with structuredContent.success boolean and optional isError. The alias
// `mcp__paseo__send_agent_prompt` and a JSON-string input (upstream accepts
// both) have no SLP fixture → input unverified.
const CODEX_SEND = "paseo.send_agent_prompt";
const CODEX_ALIAS = "mcp__paseo__send_agent_prompt";
const codexOutcome = (output: unknown): SendOutcome => {
  if (!isRecord(output) || !isRecord(output.structuredContent) || typeof output.structuredContent.success !== "boolean") {
    return unknown(VISIBILITY.sendResultUnobservable);
  }
  const success = output.structuredContent.success;
  const isError = output.isError === true;
  if (isError && success) return unknown(VISIBILITY.sendResultContradictory);
  if (isError || !success) return rejected();
  return { state: "accepted", shapeId: "codex-mcp-send-v1" };
};
const codexSends: SendAdapter = {
  coverage: { state: "verified" },
  parse(item) {
    if (item.name !== CODEX_SEND && item.name !== CODEX_ALIAS) return null;
    if (item.detail.type !== "unknown") {
      return { input: unverifiedInput(VISIBILITY.sendShapeUnverified), outcome: unknown(VISIBILITY.sendResultUnobservable) };
    }
    const { input: rawInput, output } = item.detail;
    const input = item.name === CODEX_SEND && typeof rawInput !== "string"
      ? objectInput(rawInput, "codex-mcp-send-input-v1")
      : unverifiedInput(VISIBILITY.sendShapeUnverified);
    const outcome = byStatus(item, () => codexOutcome(output), () => {
      const decoded = codexOutcome(output);
      if (decoded.state === "accepted") return unknown(VISIBILITY.sendResultContradictory);
      return item.error !== null ? rejected() : unknown(VISIBILITY.sendNotCompleted);
    });
    return { input, outcome };
  },
};

// claude — verified shape (live-claude-peer.timeline.json): name
// `mcp__paseo__send_agent_prompt`, object input; a completed result is
// `{ output: { success: boolean, … } }` (host claude/agent.js buildToolOutput
// wraps the parsed tool_result text under `output`). is_error or a denied
// permission arrives as status `failed` with an error and no output.
const CLAUDE_SEND = "mcp__paseo__send_agent_prompt";
const claudeOutcome = (output: unknown): SendOutcome => {
  const inner = isRecord(output) ? output.output : undefined;
  if (!isRecord(inner) || typeof inner.success !== "boolean") return unknown(VISIBILITY.sendResultUnobservable);
  return inner.success ? { state: "accepted", shapeId: "claude-mcp-send-v1" } : rejected();
};
const claudeSends: SendAdapter = {
  coverage: { state: "verified" },
  parse(item) {
    if (item.name !== CLAUDE_SEND) return null;
    if (item.detail.type !== "unknown") {
      return { input: unverifiedInput(VISIBILITY.sendShapeUnverified), outcome: unknown(VISIBILITY.sendResultUnobservable) };
    }
    const { input: rawInput, output } = item.detail;
    const outcome = byStatus(item, () => claudeOutcome(output), () => {
      if (output !== null && output !== undefined) return unknown(VISIBILITY.sendResultContradictory);
      return item.error !== null ? rejected() : unknown(VISIBILITY.sendNotCompleted);
    });
    return { input: objectInput(rawInput, "claude-mcp-send-input-v1"), outcome };
  },
};

// devin — the ACP title `Calling send_agent_prompt from paseo` with an object
// input is verified (live-devin-peer/lead timelines). The provider's ACP
// update carries no rawOutput/content for MCP tools (sessions.db
// tool_call_state of the smoke Peer), so no outcome is ever observable:
// every send is unknown and the family's coverage is unverified.
const DEVIN_SEND = "Calling send_agent_prompt from paseo";
const devinSends: SendAdapter = {
  coverage: { state: "unverified", reason: VISIBILITY.sendCoverageUnverified },
  parse(item) {
    if (item.name !== DEVIN_SEND) return null;
    if (item.detail.type !== "unknown") {
      return { input: unverifiedInput(VISIBILITY.sendShapeUnverified), outcome: unknown(VISIBILITY.sendResultUnobservable) };
    }
    const outcome = item.status === "completed" || item.status === "failed"
      ? unknown(VISIBILITY.sendResultUnobservable)
      : unknown(VISIBILITY.sendNotCompleted);
    return { input: objectInput(item.detail.input, "devin-acp-send-input-v1"), outcome };
  },
};

// pi — verified shape (live-pi-peer.timeline.json): after `mcp({connect})`
// the pi MCP proxy exposes the server as the tool `mcp__paseo`; a send is
// detail.input `{ tool: "paseo_send_agent_prompt", args: { agentId, prompt,
// … } }` (args an OBJECT) and a completed result is detail.output.details
// `{ mode: "call", server: "paseo", tool: "send_agent_prompt", mcpResult: {
// structuredContent: { success, … } } }`. The text copy in content[].text is
// never parsed. Recognized but never verified (mapper-derived only, no live
// item): the bare `mcp` proxy naming the tool, the name
// `paseo.send_agent_prompt`, and JSON-string args. The proxy's discovery
// calls (`mcp` search/list/connect/describe) are not sends.
const PI_PROXY = "mcp__paseo";
const PI_SEND_TOOL = "paseo_send_agent_prompt";
const piOutcome = (output: unknown): SendOutcome => {
  const details = isRecord(output) ? output.details : undefined;
  if (!isRecord(details) || details.mode !== "call" || details.tool !== "send_agent_prompt") {
    return unknown(VISIBILITY.sendResultUnobservable);
  }
  const result = details.mcpResult;
  if (!isRecord(result) || !isRecord(result.structuredContent) || typeof result.structuredContent.success !== "boolean") {
    return unknown(VISIBILITY.sendResultUnobservable);
  }
  const success = result.structuredContent.success;
  const isError = result.isError === true || (isRecord(output) && output.isError === true);
  if (isError && success) return unknown(VISIBILITY.sendResultContradictory);
  if (isError || !success) return rejected();
  return { state: "accepted", shapeId: "pi-mcp-send-v1" };
};
const piSends: SendAdapter = {
  coverage: { state: "verified" },
  parse(item) {
    const input = item.detail.type === "unknown" && isRecord(item.detail.input) ? item.detail.input : null;
    const proxied = item.name === PI_PROXY && input?.tool === PI_SEND_TOOL;
    const derived = item.name === "paseo.send_agent_prompt" || (item.name === "mcp" && input?.tool === PI_SEND_TOOL);
    if (!proxied && !derived) return null;
    if (!proxied || item.detail.type !== "unknown") {
      return { input: unverifiedInput(VISIBILITY.sendShapeUnverified), outcome: unknown(VISIBILITY.sendShapeUnverified) };
    }
    const output = item.detail.output;
    const outcome = byStatus(item, () => piOutcome(output), () => {
      if (piOutcome(output).state === "accepted") return unknown(VISIBILITY.sendResultContradictory);
      return item.error !== null ? rejected() : unknown(VISIBILITY.sendNotCompleted);
    });
    const args = input?.args;
    return {
      input: isRecord(args) ? objectInput(args, "pi-mcp-send-input-v1") : unverifiedInput(VISIBILITY.sendShapeUnverified),
      outcome,
    };
  },
};

const SEND_ADAPTERS: Record<FamilyId, SendAdapter> = {
  codex: codexSends,
  claude: claudeSends,
  devin: devinSends,
  pi: piSends,
};

/** Send coverage for a provider named by a verified host record; null or a
 *  non-registry provider is unverified. The observer calls this with the
 *  Lead's refreshed snapshot so a Peer case knows whether the Lead's
 *  dispositions can ever be accepted. */
export function sendCoverageOf(provider: string | null): Coverage {
  if (provider === null) return { state: "unverified", reason: VISIBILITY.leadProviderUnknown };
  const family = familyFromProviderId(provider);
  return family === null ? { state: "unverified", reason: VISIBILITY.unsupportedFamily } : SEND_ADAPTERS[family].coverage;
}

// A call that names send_agent_prompt but no adapter recognizes (a new title,
// alias or proxied tool name) might be a send — coverage becomes unverified;
// it is never guessed into one, and a shell command is never read as a send.
// Only the tool name and a proxy's `tool` field count: a discovery call that
// merely searches for or describes the tool is not a send.
//
// MCP proxy surfaces (pi: `mcp__paseo` for the connected server, the bare
// `mcp` proxy) hide their target in the input. When that target cannot be
// read — input not an object, a detail type other than `unknown`, or no
// `tool` — a send could be hidden there, so coverage fails closed. The one
// exemption is the bare proxy's own discovery surface as observed
// (live-pi-peer.timeline.json): an object input made only of
// search/connect/describe/server keys.
const SUSPECT_SEND_RE = /send_agent_prompt/i;
const PROXY_SURFACES: ReadonlySet<string> = new Set(["mcp__paseo", "mcp"]);
const PROXY_DISCOVERY_KEYS: ReadonlySet<string> = new Set(["search", "connect", "describe", "server"]);
const isProxyDiscovery = (input: Record<string, unknown>): boolean => {
  const keys = Object.keys(input);
  return keys.length > 0 && keys.every(key => PROXY_DISCOVERY_KEYS.has(key));
};
const suspectSend = (item: ToolCall): boolean => {
  if (SUSPECT_SEND_RE.test(item.name)) return true;
  const input = item.detail.type === "unknown" && isRecord(item.detail.input) ? item.detail.input : null;
  if (typeof input?.tool === "string") return SUSPECT_SEND_RE.test(input.tool);
  if (!PROXY_SURFACES.has(item.name)) return false;
  // A proxy call whose target is unreadable.
  return !(item.name === "mcp" && input !== null && isProxyDiscovery(input));
};

function extractSends(family: FamilyId | null, turn: readonly AgentTimelineItem[]): { sends: Send[]; coverage: Coverage } {
  const adapter = family === null ? undefined : SEND_ADAPTERS[family];
  let coverage: Coverage = adapter?.coverage ?? { state: "unverified", reason: VISIBILITY.unsupportedFamily };
  const sends: Send[] = [];
  for (const item of turn) {
    if (item.type !== "tool_call") continue;
    const parsed = adapter?.parse(item) ?? null;
    if (parsed === null) {
      // The turn-level fact (a call we could not read) outranks the family
      // default reason, so it stays visible for families already unverified.
      if (suspectSend(item)) {
        coverage = { state: "unverified", reason: VISIBILITY.sendShapeUnverified };
      }
      continue;
    }
    // Invariant: a body leaves capture only for a verified input whose
    // outcome is accepted.
    const input = parsed.input.state === "verified" && parsed.outcome.state !== "accepted"
      ? { ...parsed.input, value: { recipient: parsed.input.value.recipient, prompt: "" } }
      : parsed.input;
    sends.push({ callId: item.callId, input, outcome: parsed.outcome });
  }
  return { sends, coverage };
}

/** Route membership from hook payloads only — the hook agent record carries
 *  parentAgentId directly. A route to a differently parented Lead is allowed
 *  when explicitly assigned; Peer membership still requires that Lead's
 *  actual parent link (spec point 1). */
export const captureLead = (agent: PluginHookAgent): boolean => isSlpLead(agent.provider);
export const capturePeer = (agent: PluginHookAgent, leadId: string): boolean =>
  isSlpPeer(agent.provider) && agent.parentAgentId === leadId;

/** Whether a send is a delivered message the observer may use as evidence. */
export const isAcceptedSend = (send: Send): send is Send & { input: { state: "verified"; value: SendInput; shapeId: string } } =>
  send.input.state === "verified" && send.outcome.state === "accepted";

/** `activeLeads` answers whether a Lead id is observed right now (explicit
 *  route or a discovered Lead following active defaults). */
export function capture(event: TurnEnded, activeLeads: { has(id: string): boolean }): Capture | null {
  const family = familyFromProviderId(event.agent.provider);
  const lead = captureLead(event.agent) && activeLeads.has(event.agent.id);
  const leadId = lead ? event.agent.id : event.agent.parentAgentId;
  const peer = !lead && leadId !== null && capturePeer(event.agent, leadId) && activeLeads.has(leadId);
  if (!lead && !peer) return null;
  if (leadId === null) return null;

  const turn = latestTurn(event.timeline);
  const extraction = extractSends(family, turn);
  const sendKey = extraction.sends.map(send => [send.callId, send.input.state, send.outcome.state]);

  if (peer) {
    const issues = new Set<string>();
    const accepted = extraction.sends.filter(isAcceptedSend);
    if (event.outcome.kind !== "completed") {
      // Failed/canceled Peer turns cannot establish a completed session
      // handback — an individually accepted send still records delivery.
      issues.add(VISIBILITY.peerTurnNotCompleted);
      if (accepted.length === 0) return null;
      const notRead: Evidence<CapturedMessage> = { state: "unverified", reason: VISIBILITY.peerTurnNotCompleted };
      return {
        kind: "peer", leadId, peerId: event.agent.id, turnId: event.turnId,
        id: fingerprint([leadId, event.agent.id, event.turnId, "sends-only", sendKey]),
        brief: notRead, handback: notRead,
        sends: extraction.sends, sendCoverage: extraction.coverage,
        issues: [...issues],
      };
    }
    const { brief, handback } = peerMessages(family, event.timeline);
    // A completed Peer turn with NO observable communication is still a
    // case — "absent observable communication is unknown", and the gap must
    // be visible on the observation list, not silently dropped. Unverified
    // messages are communication that exists but is unreadable — not this.
    if (brief.state === "missing" && handback.state === "missing" && accepted.length === 0) {
      issues.add(VISIBILITY.noCommunication);
    }
    if (brief.state === "verified" && ASSIGNMENT_FILE_RE.test(brief.value.text)) issues.add(VISIBILITY.briefAssignmentFile);
    // The assignment's report route is not machine-readable on this host —
    // route compliance and Lead receipt stay unknown (README row 11). The
    // flag is disclosed to Jev and the Supervisor but gates nothing: a
    // handling disposition or mishandling must be linked to an accepted
    // message whose content addresses the obligation, and silence never
    // becomes a finding (assessment.ts judge).
    issues.add(VISIBILITY.reportRouteUnverifiable);
    const bodyOf = (evidence: Evidence<CapturedMessage>) => evidence.state === "verified" ? [evidence.value.messageId, evidence.value.text] : [evidence.state, evidence.reason];
    return {
      kind: "peer", leadId, peerId: event.agent.id, turnId: event.turnId,
      id: fingerprint([leadId, event.agent.id, event.turnId, ...bodyOf(brief), ...bodyOf(handback)]),
      brief, handback,
      sends: extraction.sends, sendCoverage: extraction.coverage,
      issues: [...issues],
    };
  }

  // Lead turn: a failed/canceled Lead turn can still contain delivered sends —
  // keep them; only the issues record the gap. A turn with no send-shaped
  // call contributes nothing, even when it did not complete: on host 0.9.1
  // every prompt to a running agent replaces its run (sendPromptToAgent
  // replaceRunning), so the Peer's own handback delivery routinely cancels
  // an idle-looking Lead turn. Recording that as evidence would only stamp
  // a gap on every open case and re-arm evaluation for nothing.
  const suspect = extraction.coverage.state === "unverified" && extraction.coverage.reason === VISIBILITY.sendShapeUnverified;
  if (extraction.sends.length === 0 && !suspect) return null;
  const issues = new Set<string>();
  if (event.outcome.kind !== "completed") issues.add(VISIBILITY.leadTurnNotCompleted);
  const adapter = family === null ? undefined : MESSAGE_ADAPTERS[family];
  return {
    kind: "lead", leadId, turnId: event.turnId,
    id: fingerprint([leadId, event.turnId, sendKey, extraction.coverage]),
    sends: extraction.sends,
    sendCoverage: extraction.coverage,
    issues: [...issues],
    anchors: turn.flatMap((item, index) =>
      item.type === "user_message" ? [{ index, text: adapter?.userMessage(item.text, "lead")?.text ?? item.text }] : []),
  };
}


// --- end-only chronology fallback -------------------------------------------
//
// Host 0.9.1 does emit `agent.turn_started` (plugins/lifecycle publishAgentStream
// maps turn_started → { agent, turnId }), but that event reaching the host's
// dispatch is not the same as a start record inside THIS observer instance:
// plugin reloads clear the in-memory start maps, lifecycle hook RPC calls can
// time out (observed in daemon logs: "Lifecycle hook agent.turn_ended failed:
// Plugin RPC timed out"), and gate-pause windows drop starts at the hook.
// When no usable start is on record, the only honest fallback is ordering the
// turn_ended event proves INSIDE the same slice the sends were extracted
// from: the turn-opening user_message is this case's handback delivery — the
// host's <paseo-system> finish notification embedding the handback body
// (agent-prompt.js formatFinishNotificationBody; the peer's identity must
// hold at the status-line position, not anywhere in the body). A bare
// send_agent_prompt report body is NOT an anchor: timeline user_messages
// carry no authenticated sender (host send_agent_prompt passes the prompt
// through verbatim — no wrapper, no sender field), so a text-only match
// cannot tell the peer's delivery from a manual message or another agent's
// identical input. A match in an older turn or a scrubbed body proves
// nothing either — the fallback never invents evidence and never fabricates
// a start timestamp.
export function handbackAnchorIndex(
  anchors: readonly { index: number; text: string }[],
  peerId: string,
  handbackText: string | null,
): number {
  let first = -1;
  for (const anchor of anchors) {
    const matched = handbackText !== null && isFinishAnchor(anchor.text, peerId, handbackText);
    if (matched && (first < 0 || anchor.index < first)) first = anchor.index;
  }
  return first;
}

// Mirrors the host's formatSystemNotificationPrompt envelope
// (agent-prompt.js): "<paseo-system>\n<body>\n</paseo-system>".
const SYSTEM_PREFIX = "<paseo-system>\n";
const SYSTEM_SUFFIX = "\n</paseo-system>";
const AGENT_RESPONSE_OPEN = "<agent-response>\n";
const AGENT_RESPONSE_CLOSE = "\n</agent-response>";
// FINISH_NOTIFICATION_MESSAGE_LIMIT in the host's agent-prompt.js — the
// embedded agent-response body is the child's last assistant message trimmed,
// then truncated to this many chars plus a "[truncated N chars; …]" line.
export const FINISH_MESSAGE_LIMIT = 4000;

const isFinishAnchor = (text: string, peerId: string, handbackText: string): boolean => {
  // The status line is the body's FIRST line — `Agent ${childAgentId}
  // (${title}) ${reason}.` (sections[0] of formatFinishNotificationBody).
  // Identity must hold at that exact position: a foreign agent's envelope
  // naming this peer inside its title or reason must never anchor.
  if (!text.startsWith(`${SYSTEM_PREFIX}Agent ${peerId} (`)) return false;
  if (!text.endsWith(SYSTEM_SUFFIX)) return false;
  const open = text.indexOf(AGENT_RESPONSE_OPEN);
  if (open < 0) return false;
  const start = open + AGENT_RESPONSE_OPEN.length;
  const close = text.indexOf(AGENT_RESPONSE_CLOSE, start);
  if (close < 0) return false;
  const trimmed = handbackText.trim();
  if (trimmed === "") return false;
  const expected = trimmed.length <= FINISH_MESSAGE_LIMIT
    ? trimmed
    : `${trimmed.slice(0, FINISH_MESSAGE_LIMIT)}\n[truncated ${trimmed.length - FINISH_MESSAGE_LIMIT} chars; use get_agent_activity for the full response]`;
  return text.slice(start, close) === expected;
};
