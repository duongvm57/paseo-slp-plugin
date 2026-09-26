// plugin/server/supervision/observer.ts — communication supervision observer.
// Spec: docs/spec/supervision-integration.md §Observation, §Jev assessment,
// §Notification delivery, §Failure and privacy boundaries.
//
// Lifecycle hooks do the minimum synchronously (normalize + enqueue) and
// return; everything async — SDK refresh, Jev HTTP, persistence, Supervisor
// delivery — runs in a single serialized queue owned by the plugin process.
// Archive events tombstone agent ids so a late event from the old generation
// cannot re-enter. A monotonic callback-order counter stamps every
// observation; Lead handling is provable when a matching non-null
// turn-start landed strictly after the Peer's handback — or, when no usable
// start reached this observer instance (plugin reload clears the in-memory
// start maps, lifecycle hook RPC timeouts drop calls, gate pauses drop
// starts at the hook — all observed on host 0.9.1), when the handback's own
// delivery is the user_message opening the ended turn's current slice. The
// end-derived path only reads ordering the event itself records; it never
// fabricates a start, and whatever it cannot prove stays uncertain.
//
// Leads are observed under an explicit route or, when the Human enables
// daemon defaults, as DISCOVERED SLP Leads (exact slp-<family>-lead from a
// lifecycle record or refresh). A case is assessed as soon as its handback
// lands, re-assessed when its packet changes, and its independent findings
// are delivered to the route's Supervisor in `notify` mode — brief/handback
// findings only after the pending-delay checkpoint, handling mishandling as
// soon as it is linked to a confirmed message.
//
// Queue/generation mechanics and the refresh-before-send / mark-before-send
// delivery shape are adapted from hoangnb24/paseo-supervision
// server/observer.ts @ 1bad19b8ee6c58482494f56a3d8c6edb4f969ee1
// (Apache-2.0). The client-bootstrap supervisor sync RPC is not ported: the
// server reads the private store itself.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  defaultsActive, effectiveRoute, explicitRoute, isSlpLead, isSlpPeer,
  normalizeSupervisionFile, SUPERVISION_CONFIDENCE_DEFAULT, SupervisionObservation,
} from "../../shared/supervision.ts";
import type {
  EffectiveRoute, SupervisionConfig, SupervisionDelivery, SupervisionFinding,
  SupervisionObservation as Observation,
} from "../../shared/supervision.ts";
import { writePrivate } from "../state-store.ts";
import { CAPTURE_VERSION, capture, FINISH_MESSAGE_LIMIT, handbackAnchorIndex, isAcceptedSend, sendCoverageOf, VISIBILITY } from "./capture.ts";
import type { Capture, CapturedMessage, Evidence, Send, TurnEnded, TurnStarted } from "./capture.ts";
import {
  axisGates, buildQuestions, judge, localGate, MAX_LINK_CANDIDATES, PACKET_VERSION,
  parseAssessmentResponse, RUBRIC_VERSION,
  type Answer, type Answers, type EvidencePayload, type RecipientRole,
} from "./assessment.ts";
import {
  alertMessageId, buildAlertPrompt, checkRecipient, createDeliveryStore, deliveryKey,
  type FindingAxis,
} from "./delivery.ts";
import { askJevDecision, assertRedacted, resolveSupervision, JevRequestError, type SupervisionGate } from "../jev.ts";

// Gate reasons that mean the Human has supervision (or Jev) switched off —
// not a paused window worth counting as dropped events.
const DELIBERATELY_OFF: ReadonlySet<string> = new Set(["jev-capability-off", "jev-disabled", "jev-unconfigured"]);

// Spec §Observer bounds — exceeding any becomes unknown + a metadata-only
// diagnostic; evidence is never truncated into apparently-complete content.
const MAX_CASES = 64;
const MAX_QUEUE = 128;
const MAX_EVIDENCE_BYTES = 64 * 1024;
// Initial assessment plus re-assessments when the packet changes (new
// confirmed message bodies, new flags); an unchanged packet never pays.
const MAX_ASSESSMENTS = 6;
const CASE_LIFE_MS = 24 * 60 * 60 * 1000;
const RING_MAX = 200;
const RING_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SDK_TIMEOUT_MS = 15_000;
// Parity with the shared Jev helper's default bound (5s, same as
// src/jev.mjs) — the deadline covers the whole request including the body
// read; a longer observer-only override would silently widen the cost of a
// stalled provider.
const HTTP_TIMEOUT_MS = 5_000;
// A running Supervisor is not prompted (the host would interrupt its turn);
// the alert is re-checked with backoff until the Supervisor is idle or the
// case expires.
const DEFER_RETRY_MIN_MS = 30_000;
const DEFER_RETRY_MAX_MS = 10 * 60_000;
const MAX_DIAGNOSTIC_REASONS = 20;
const CASES_FILE = join("state", "supervision-cases.json");

// ---------------------------------------------------------------------------
// Case model + bounded metadata ring
// ---------------------------------------------------------------------------

/** seq: observer-wide append order, so a case's messages keep one
 *  chronological order across lanes (and stable link keys m1..mN). */
export interface MessageRef { callId: string; turnId: string | null; recipient: string; prompt: string; seq: number }

export interface CaseEvidence {
  brief: { text: string; messageId: string | null; flags: string[] } | null;
  handback: { text: string; messageId: string | null } | null;
  roomMessages: MessageRef[];          // confirmed Lead→this Peer sends after the handback
  uncertainRoomMessages: MessageRef[]; // parsed sends whose start/success cannot be proven
  otherRoomMessages: MessageRef[];     // confirmed Lead→other direct-Peer sends after the handback
  reportMessages: MessageRef[];        // confirmed Lead→Supervisor sends (separate provenance)
  peerSends: MessageRef[];             // confirmed Peer→recipient sends (delivered communication)
  /** Case/body provenance flags (Peer capture, gate marks). */
  flags: string[];
  /** Lead send-lane and chronology flags — gate the handling axis only. */
  laneFlags: string[];
  /** Pending-delay checkpoint reached — gates brief/handback delivery;
   *  never sent to Jev (elapsed time is not evidence). */
  pendingDelayElapsed: boolean;
}

interface Case {
  id: string;
  leadId: string;
  peerId: string;
  peerTurnId: string | null;
  evidence: CaseEvidence;
  due: number;
  expiresAt: number;
  timerUsed: boolean;
  handbackOrder: number;
  dirty: boolean;
  /** Per-case evaluation-basis generation — bumped on EVERY mutation an
   *  assessment could see (evidence appends, flag changes, body clears).
   *  The per-lead `enqPending` counter covers evidence still QUEUED; this
   *  counter covers in-place mutations that never pass an enqueue. An
   *  in-flight Jev ask compares it at accept-time — spec: "New evidence
   *  arriving during an assessment invalidates that assessment." */
  evidenceVersion: number;
  gatedReason: string | null;
  disposition: "observed" | "unknown";
  assessments: number;
  observedAt: number;
  lastAssessment: Observation["lastAssessment"];
  /** Held base answers (leadBrief/peerHandback/leadHandling) — in-process
   *  only. Brief/handback bodies are immutable per case, so their axes are
   *  asked once; handling is re-asked when the packet changes. */
  answers: Answers;
  /** Link answers + the key→callId map of the packet they were asked on. */
  links: { answers: Answers; candidates: Map<string, string> };
  /** sha256 of the last assessed state+questions — an identical rebuilt
   *  packet re-judges from held answers without a new call. */
  packetHash: string | null;
  axes: { brief: string | null; handback: string | null; handling: string | null } | null;
  handling: "clean" | "gap" | "open" | "unjudged";
  exhausted: boolean;
  findings: SupervisionFinding[];
  delivery: SupervisionDelivery | null;
  retryAt: number | null;
  deferCount: number;
  route: { source: "route" | "default"; mode: "shadow" | "notify" };
}

const CasesFileSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(SupervisionObservation),
}).strict();

type Job =
  | { t: "tick"; order: number; leadId: null }
  // leadGen/peerGen = archive generations AT ENQUEUE — an archive→restore
  // crossing the queue is invisible to the tombstone flag (restore clears
  // it) but bumps the monotonic generation, so the compare at apply is
  // ABA-safe. peerGen is undefined for lead events (they fan out to every
  // open case — each case's peer is checked per-case instead).
  | { t: "turn-end"; order: number; leadId: string; leadGen: number | undefined; peerGen: number | undefined; capture: Capture; startSeq: number | null; overlap: boolean }
  // gens = archive generations AT ENQUEUE — a queued verification answers
  // a question asked at hook time; an archive landing before the job
  // executes already changed the generation, so the job must discard
  // itself before spending a refresh (spec §Observation: "Archive
  // generations invalidate pending work"). Generations are MONOTONIC —
  // never reset on restore — so a stale job from an older archive era can
  // never alias a newer one.
  | { t: "verify-peer"; order: number; leadId: string; peerId: string; peerGen: number | undefined; leadGen: number | undefined }
  | { t: "restore-lead"; order: number; leadId: string; gen: number | undefined }
  | { t: "archive"; order: number; leadId: string | null; agent: PluginHookAgent };

const roleOf = (lane: "room" | "other" | "report"): RecipientRole =>
  lane === "room" ? "case-peer" : lane === "other" ? "other-peer" : "supervisor";

/** The exact outbound evidence state (spec §Jev: bound ids, case and
 *  turn/message ids, the complete captured brief and session handback
 *  bodies, confirmed post-handback room/report prompts, ids-only uncertain
 *  sends, and visibility flags — nothing else). Module-level so the
 *  field-allowlist test exercises THIS function, not a re-declared literal:
 *  adding a field here must fail that test. `omitOtherBodies` withholds
 *  cross-Peer bodies (the byte-cap fallback). Axes are filled by the caller
 *  from the gates, which read this payload. */
export function buildEvidencePayload(
  item: {
    id: string; leadId: string; peerId: string; peerTurnId: string | null;
    evidence: CaseEvidence; findings?: readonly SupervisionFinding[];
  },
  route: { supervisorAgentId: string | null },
  opts: { omitOtherBodies?: boolean } = {},
): EvidencePayload {
  const lanes: { lane: "room" | "other" | "report"; message: MessageRef }[] = [
    ...item.evidence.roomMessages.map(message => ({ lane: "room" as const, message })),
    ...item.evidence.otherRoomMessages.map(message => ({ lane: "other" as const, message })),
    ...item.evidence.reportMessages.map(message => ({ lane: "report" as const, message })),
  ].sort((a, b) => a.message.seq - b.message.seq);
  const laneFlags = [...item.evidence.laneFlags];
  if (opts.omitOtherBodies === true && !laneFlags.includes(VISIBILITY.otherRoomBodiesOmitted)) {
    laneFlags.push(VISIBILITY.otherRoomBodiesOmitted);
  }
  const handback = item.evidence.handback;
  return {
    packetVersion: PACKET_VERSION,
    rubricVersion: RUBRIC_VERSION,
    bound: { leadAgentId: item.leadId, peerId: item.peerId, supervisorAgentId: route.supervisorAgentId },
    caseId: item.id,
    peerTurnId: item.peerTurnId,
    axes: {
      brief: { judgeable: true, reason: null },
      handback: { judgeable: true, reason: null },
      handling: { judgeable: true, reason: null },
    },
    brief: item.evidence.brief === null ? null : {
      text: item.evidence.brief.text, messageId: item.evidence.brief.messageId,
      visibility: item.evidence.brief.flags,
    },
    handback: handback === null ? null : {
      text: handback.text, messageId: handback.messageId,
      exceedsNotificationLimit: handback.text.trim().length > FINISH_MESSAGE_LIMIT,
    },
    messages: lanes.map(({ lane, message }, index) => ({
      key: `m${index + 1}`,
      callId: message.callId,
      turnId: message.turnId,
      recipient: message.recipient,
      recipientRole: roleOf(lane),
      prompt: lane === "other" && opts.omitOtherBodies === true ? null : message.prompt,
    })),
    uncertainMessages: item.evidence.uncertainRoomMessages.map(m => ({ callId: m.callId, turnId: m.turnId, recipient: m.recipient })),
    peerSends: item.evidence.peerSends.map(m => ({ callId: m.callId, recipient: m.recipient, prompt: m.prompt })),
    priorFindings: (item.findings ?? []).filter(f => f.status === "open").map(f => ({ axis: f.axis, choice: f.choice })),
    flags: item.evidence.flags,
    laneFlags,
  };
}

/** Link candidates: the newest confirmed messages that carry a body. */
export function linkCandidates(payload: EvidencePayload): Map<string, string> {
  const withBodies = payload.messages.filter(message => message.prompt !== null && message.prompt !== "");
  return new Map(withBodies.slice(-MAX_LINK_CANDIDATES).map(message => [message.key, message.callId]));
}

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

// The SDK does not offer cancellation on refresh/send — bound our wait and
// detach on stop (spec: "bound SDK waits"). An already issued request
// cannot be retracted; never initiate one after stop.
function bounded<T>(work: Promise<T>, signal: AbortSignal, timeoutMs = SDK_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => done(() => reject(new Error("stopped")));
    const timer = setTimeout(() => done(() => reject(new Error("sdk-timeout"))), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => done(() => resolve(value)), () => done(() => reject(new Error("sdk-failure"))));
    if (signal.aborted) abort();
  });
}

// The connected-SDK surface the observer needs — a structural subset of
// PaseoApi (same narrowing as the PaseoLike in state.ts): tests double it
// without the daemon, and plugin/package.json carries no runtime
// @getpaseo/client dependency a standalone install would have to resolve
// for a type-only import.
type PaseoAgentSnapshot = {
  id?: unknown;
  provider?: unknown;
  status?: unknown;
  archivedAt?: unknown;
  workspaceId?: unknown;
  labels?: Record<string, unknown> | null;
};
type PaseoLike = {
  agents: {
    ref(id: string): {
      refresh(): Promise<{ agent: PaseoAgentSnapshot | null | undefined } | null>;
      send(text: string, options?: { messageId?: string }): Promise<void>;
    };
  };
};

export interface ObserverDeps {
  stableRoot: string;
  now?: () => number;
  signal?: AbortSignal;
  uuid?: () => string;
  /** Test seams — default to the real Jev module / case gate. */
  gate?: (stableRoot: string) => SupervisionGate;
  ask?: typeof askJevDecision;
  localGate?: (evidence: EvidencePayload) => string | null;
  httpTimeoutMs?: number;
  deferRetryMs?: number;
}

export function createSupervisionObserver(deps: ObserverDeps) {
  const stableRoot = deps.stableRoot;
  const now = () => (deps.now ?? Date.now)();
  const uuid = deps.uuid ?? randomUUID;
  const gateOf = deps.gate ?? resolveSupervision;
  const ask = deps.ask ?? askJevDecision;
  const evidenceGate = deps.localGate ?? localGate;
  const httpTimeoutMs = deps.httpTimeoutMs ?? HTTP_TIMEOUT_MS;
  const deferMin = deps.deferRetryMs ?? DEFER_RETRY_MIN_MS;
  // Live cases pin their attempt records (the no-repeat authority); `cases`
  // is declared below and read lazily.
  const deliveries = createDeliveryStore(stableRoot, { now, uuid, liveCases: () => new Set(cases.keys()) });

  const abort = new AbortController();
  const signal = abort.signal;
  const outerSignal = deps.signal;
  if (outerSignal !== undefined) {
    if (outerSignal.aborted) abort.abort();
    else outerSignal.addEventListener("abort", () => abort.abort(), { once: true });
  }

  let order = 0;                    // monotonic callback-order counter
  let messageSeq = 0;               // monotonic message append order
  let version = 0;                  // bumped on every enqueue — drain scheduling only; per-lead enqPending is the eval basis
  let running = false;
  let stopped = false;
  const jobs: Job[] = [];
  const cases = new Map<string, Case>();
  // Dedupe windows keyed to first-seen time — pruned after CASE_LIFE_MS (a
  // duplicate hook delivery arrives within moments; nothing a closed or
  // expired case could still use is dropped). See sweepRetention().
  const seen = new Map<string, number>();       // capture fingerprint → first seen
  const sentCalls = new Map<string, number>();  // leadId\0callId → committed at
  const peers = new Map<string, string>();      // verified peerId → leadId
  // Discovered SLP Leads (exact lead provider from a hook record or a
  // refresh) → their workspace. Only these can follow daemon defaults.
  const knownLeads = new Map<string, { workspaceId: string | null }>();
  // Archive dimension is split in two: `archiveGen` is a MONOTONIC counter
  // per id — bumped on every archive hook, never deleted. `archivedNow`
  // holds the tombstone flag a restore clears. A reset-on-restore counter
  // would alias generations across archive eras (ABA): a job queued in
  // era 1 could "match" era 2's fresh 1 and un-tombstone a live archive.
  const archiveGen = new Map<string, number>();
  const archivedNow = new Set<string>();
  // Per-lead count of enqueued-not-applied jobs — the queued-evidence
  // dimension of an evaluation basis. Global `version` stays for drain
  // scheduling only; per-lead scoping keeps unrelated-lead churn from
  // discarding a paid assessment.
  const enqPending = new Map<string, number>();
  // Bumped on every OBSERVED gate-down edge — part of every evaluation
  // basis, so a down→up flip inside an await (invisible to a re-read,
  // which sees "ok" again) still invalidates work whose gather spanned
  // the purge.
  let purgeCount = 0;
  let gateWasDown = false;
  const leadStarts = new Map<string, number>(); // leadId\0turnId → callback order
  const startMeta = new Map<string, { seq: number; overlapped: boolean; at: number }>();
  const openTurns = new Map<string, Set<string>>(); // leadId → started-not-ended turnIds
  const routeReasons = new Map<string, string>();
  const diagnostics = { droppedEvents: 0, reasons: [] as string[] };
  let lastPaseo: PaseoLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ring: Map<string, Observation> | null = null;
  let ringDirty = false;

  const diag = (reason: string) => {
    if (!diagnostics.reasons.includes(reason) && diagnostics.reasons.length < MAX_DIAGNOSTIC_REASONS) {
      diagnostics.reasons.push(reason);
    }
  };

  // --- config + gate reads (mtime-cached; hooks must stay cheap) -----------

  const configFile = join(stableRoot, "state", "supervision.json");
  // invalid = the file exists but cannot be read or validated (a visible
  // Manager error) — distinct from an absent file or a removed route.
  let configCache: { stamp: string; config: SupervisionConfig | null; invalid: boolean } | null = null;
  /** The store through the shared normalizer. An unreadable/invalid file
   *  reads as null — invalid config means observation is off (state.ts
   *  surfaces the same condition as a visible error). A schema-1 file reads
   *  with every route off (migration). The cache key is mtime+size so a
   *  same-millisecond rewrite still re-reads. */
  const readConfig = (): SupervisionConfig | null => {
    try {
      const stat = lstatSync(configFile);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (configCache === null || configCache.stamp !== stamp) {
        let normalized: ReturnType<typeof normalizeSupervisionFile>;
        try {
          normalized = normalizeSupervisionFile(JSON.parse(readFileSync(configFile, "utf8")));
        } catch {
          normalized = { ok: false, error: "unreadable" };
        }
        configCache = { stamp, config: normalized.ok ? normalized.config : null, invalid: !normalized.ok };
      }
    } catch (error) {
      configCache = { stamp: "-", config: null, invalid: (error as NodeJS.ErrnoException).code !== "ENOENT" };
    }
    return configCache.config;
  };
  const tombstoned = (id: string): boolean => archivedNow.has(id);

  /** Close reason when a case's Lead no longer resolves to a route. An
   *  archived Lead leaves discovery (and so every route, explicit ones
   *  included — effectiveRoute needs host evidence), so the archive is named
   *  rather than read as a removed route. */
  const unroutedReason = (leadId: string): string =>
    tombstoned(leadId) ? "lead-archived" : configCache?.invalid === true ? "config-invalid" : "route-removed";

  /** The route a Lead is observed under right now, or null (an archived
   *  Lead has left discovery, so it has none; unroutedReason names it). */
  const routeFor = (leadId: string): EffectiveRoute | null =>
    effectiveRoute(readConfig(), leadId, knownLeads.get(leadId) ?? null);

  /** Whether the config could observe this Lead: an explicit route decides
   *  alone (an explicit off never observes); otherwise active defaults can
   *  admit it once it is discovered as an exact SLP Lead. */
  const routableLead = (leadId: string): boolean => {
    const config = readConfig();
    const explicit = explicitRoute(config, leadId);
    if (explicit !== undefined) return explicit.mode !== "off";
    return defaultsActive(config) && config?.defaults.supervisorAgentId !== leadId;
  };
  /** Whether an event for this Lead is worth capturing right now. */
  const candidateLead = (leadId: string): boolean => !tombstoned(leadId) && routableLead(leadId);

  const discoverLead = (agent: { id: string; provider: string; workspaceId: string | null }): void => {
    if (isSlpLead(agent.provider) && !tombstoned(agent.id)) knownLeads.set(agent.id, { workspaceId: agent.workspaceId });
  };

  let gateCache: { stamp: string; gate: SupervisionGate } | null = null;
  /** Daemon-global Jev gate — a failed capability/key/target pauses capture
   *  for every route (the gate is per-daemon, so all routes pause together). */
  const jevGate = (): SupervisionGate => {
    const stamp = statStamp(join(stableRoot, "state", "jev.json")) + "|" + keyStamps();
    if (gateCache === null || gateCache.stamp !== stamp) {
      gateCache = { stamp, gate: gateOf(stableRoot) };
    }
    return gateCache.gate;
  };
  const statStamp = (file: string): string => {
    try {
      const stat = lstatSync(file);
      // mode included — chmod changes keyPermissionsOk (a gate input)
      // without touching mtime or size, so a permission-only change must
      // still bust the cache.
      return `${stat.mtimeMs}:${stat.size}:${stat.mode}`;
    } catch {
      return "-";
    }
  };
  const keyStamps = (): string =>
    ["openrouter", "typesafe"].map(kind => statStamp(join(stableRoot, "state", `jev-${kind}.key`))).join("|");

  // The ONE gate-down reaction — every detection point funnels through
  // observeGate(). Purge = flag `capture-paused` + clear bodies on EVERY
  // open case + scrub bodies still sitting in queued turn-end captures
  // (`jobs[]` is a retention store the case loop cannot reach) + bump
  // `purgeCount` so a later down→up edge cannot alias the basis of work
  // whose gather spanned this purge.
  const onGateDown = (): void => {
    purgeCount += 1;
    // Start bookkeeping purges with everything else: a turn whose start
    // was recorded pre-pause but whose end is dropped inside the pause
    // would orphan its openTurns/leadStarts/startMeta entries and poison
    // the NEXT start (overlap → lead-start-unmatched). Chronology across
    // a paused window is untrusted — post-recovery turns whose starts are
    // gone resolve conservatively to the uncertain lane.
    openTurns.clear();
    leadStarts.clear();
    startMeta.clear();
    for (const item of cases.values()) {
      if (!item.evidence.flags.includes(VISIBILITY.capturePaused)) item.evidence.flags.push(VISIBILITY.capturePaused);
      // clearBodies bumps evidenceVersion — an in-flight assessment must
      // discard at accept-time.
      clearBodies(item);
      item.dirty = true;
      recordRing(item, stateOf(item), item.gatedReason);
    }
    for (const job of jobs) {
      if (job.t === "turn-end") scrubCaptureBodies(job.capture);
    }
  };

  /** The single gate read — any observation of a down edge runs the global
   *  purge, no matter which caller saw it first. */
  const observeGate = (): SupervisionGate => {
    const gate = jevGate();
    if (gate.ok) {
      gateWasDown = false;
      return gate;
    }
    if (!gateWasDown) {
      gateWasDown = true;
      onGateDown();
    }
    return gate;
  };

  const captureAllowed = (): boolean => observeGate().ok;

  /** Metadata survives a purge; bodies do not. Scrubbing also stamps the
   *  capture's flags so a case created after gate recovery still records
   *  the purge window on its observation row. */
  const scrubMessage = (evidence: Evidence<CapturedMessage>): Evidence<CapturedMessage> =>
    evidence.state === "verified" ? { ...evidence, value: { text: "", messageId: evidence.value.messageId } } : evidence;
  const scrubCaptureBodies = (captured: Capture): void => {
    if (!captured.issues.includes(VISIBILITY.capturePaused)) captured.issues.push(VISIBILITY.capturePaused);
    if (captured.kind === "peer") {
      captured.brief = scrubMessage(captured.brief);
      captured.handback = scrubMessage(captured.handback);
    }
    for (const send of captured.sends) {
      if (send.input.state === "verified") send.input = { ...send.input, value: { recipient: send.input.value.recipient, prompt: "" } };
    }
    if (captured.kind === "lead") {
      for (const anchor of captured.anchors) anchor.text = "";
    }
  };

  // --- metadata ring (state/supervision-cases.json) ------------------------

  const loadRing = (): Map<string, Observation> => {
    if (ring !== null) return ring;
    ring = new Map();
    try {
      const parsed = CasesFileSchema.safeParse(
        JSON.parse(readFileSync(join(stableRoot, CASES_FILE), "utf8")),
      );
      if (parsed.success) {
        const cutoff = now() - RING_AGE_MS;
        for (const entry of parsed.data.cases) {
          if (Date.parse(entry.updatedAt) >= cutoff) ring.set(entry.fingerprint, entry);
        }
      }
    } catch { /* absent or corrupt — a fresh ring; the file is rewritten on next change */ }
    return ring;
  };

  const persistRing = (): void => {
    if (!ringDirty || ring === null) return;
    ringDirty = false;
    const cutoff = now() - RING_AGE_MS;
    const entries = [...ring.values()]
      .filter(entry => Date.parse(entry.updatedAt) >= cutoff)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, RING_MAX);
    // Memory holds exactly what disk holds — an open case re-records its
    // row on its next change, so dropping an old row loses nothing live.
    const kept = new Set(entries.map(entry => entry.fingerprint));
    for (const fingerprint of ring.keys()) if (!kept.has(fingerprint)) ring.delete(fingerprint);
    try {
      writePrivate(stableRoot, CASES_FILE, `${JSON.stringify({ schemaVersion: 1, cases: entries }, null, 2)}\n`, uuid);
    } catch {
      diag("ring-persist-failed");
      ringDirty = true;
    }
  };

  // Turn/message IDs where available — ids only, bounded (spec §Shadow
  // evidence: "turn/message IDs where available"). sendTurnIds stays
  // index-aligned with sendCallIds: the Lead turn that issued each send.
  const messageIdsOf = (item: Case): Observation["messageIds"] => {
    const sends = [
      ...item.evidence.roomMessages,
      ...item.evidence.uncertainRoomMessages,
      ...item.evidence.otherRoomMessages,
      ...item.evidence.reportMessages,
      ...item.evidence.peerSends,
    ].slice(0, 24);
    return {
      brief: item.evidence.brief?.messageId ?? null,
      handback: item.evidence.handback?.messageId ?? null,
      sendCallIds: sends.map(message => message.callId),
      sendTurnIds: sends.map(message => message.turnId),
    };
  };

  const openFindings = (item: Case): SupervisionFinding[] => item.findings.filter(finding => finding.status === "open");

  /** UI state: an uncertain delivery outranks everything (the Supervisor
   *  may or may not have it); an open finding is suspected drift. */
  const stateOf = (item: Case): Observation["state"] => {
    if (item.delivery?.state === "uncertain") return "notification_uncertain";
    if (openFindings(item).length > 0) return "suspected_drift";
    return item.disposition;
  };

  const recordRing = (item: Case, state: Observation["state"], reason: string | null): void => {
    const entries = loadRing();
    const stamp = new Date(now()).toISOString();
    const prior = entries.get(item.id);
    entries.set(item.id, {
      fingerprint: item.id,
      leadAgentId: item.leadId,
      peerId: item.peerId,
      peerTurnId: item.peerTurnId,
      messageIds: messageIdsOf(item),
      observedAt: prior?.observedAt ?? new Date(item.observedAt).toISOString(),
      updatedAt: stamp,
      state,
      reason: reason?.slice(0, 400) ?? null,
      visibility: [...item.evidence.flags, ...item.evidence.laneFlags.filter(f => !item.evidence.flags.includes(f))].slice(0, 24),
      counts: {
        roomMessages: item.evidence.roomMessages.length,
        uncertainRoomMessages: item.evidence.uncertainRoomMessages.length,
        otherRoomMessages: item.evidence.otherRoomMessages.length,
        reportMessages: item.evidence.reportMessages.length,
        peerSends: item.evidence.peerSends.length,
      },
      assessmentsUsed: item.assessments,
      lastAssessment: item.lastAssessment,
      route: item.route,
      findings: item.findings.map(finding => ({ ...finding })),
      delivery: item.delivery,
    });
    ringDirty = true;
  };

  /** Metadata-only row for a capture that never became a case. */
  const recordDropped = (captured: Extract<Capture, { kind: "peer" }>, reason: string): void => {
    const entries = loadRing();
    const stamp = new Date(now()).toISOString();
    entries.set(captured.id, {
      fingerprint: captured.id, leadAgentId: captured.leadId, peerId: captured.peerId,
      peerTurnId: captured.turnId, observedAt: stamp, updatedAt: stamp,
      messageIds: { brief: null, handback: null, sendCallIds: [], sendTurnIds: [] },
      state: "unknown", reason, visibility: [reason],
      counts: { roomMessages: 0, uncertainRoomMessages: 0, otherRoomMessages: 0, reportMessages: 0, peerSends: 0 },
      assessmentsUsed: 0, lastAssessment: null, route: null, findings: [], delivery: null,
    });
    ringDirty = true;
    persistRing();
  };

  /** Close a case. Open findings keep the case suspected drift; a notify
   *  alert that was due but never attempted is recorded canceled with the
   *  close reason (route change, archive, gate, expiry) — never sent later. */
  const closeCase = (item: Case, state: Observation["state"], reason: string | null): void => {
    const open = openFindings(item);
    if (item.route.mode === "notify" && open.length > 0 &&
        (item.delivery === null || item.delivery.state === "deferred")) {
      const recipient = item.delivery?.recipient ?? routeFor(item.leadId)?.supervisorAgentId ?? null;
      if (recipient !== null) {
        item.delivery = {
          state: "canceled", recipient, at: new Date(now()).toISOString(),
          reason: `closed-before-dispatch:${reason ?? "closed"}`.slice(0, 200),
          findings: open.map(finding => finding.axis),
        };
      }
    }
    const final = state === "unknown" || state === "evaluated" ? (open.length > 0 ? stateOf(item) : state) : state;
    recordRing(item, final, reason);
    cases.delete(item.id);
    persistRing();
  };

  // --- retention -------------------------------------------------------------
  //
  // Process-lifetime id state, and what bounds it:
  //   seen / sentCalls     dedupe windows, pruned after CASE_LIFE_MS; an
  //                        archived Lead's sends are dropped at archive.
  //   leadStarts/startMeta/openTurns
  //                        removed at turn end; a start whose end never
  //                        arrives (dropped hook) is pruned after
  //                        CASE_LIFE_MS — its turn then reads unmatched,
  //                        the conservative outcome.
  //   enqPending           deleted when drained to zero.
  //   routeReasons         kept only for explicit routes, discovered Leads
  //                        and Leads with open cases.
  //   peers / knownLeads   removed at archive; otherwise one entry per live
  //                        verified agent.
  //   archiveGen / archivedNow
  //                        deliberately NOT pruned: monotonic generations
  //                        and tombstones are the archive/ABA authority for
  //                        queued work and late events. One small entry per
  //                        archived id for the process lifetime.
  const RETENTION_SWEEP_MS = 60_000;
  let lastSweep = 0;
  const sweepRetention = (): void => {
    const at = now();
    if (at - lastSweep < RETENTION_SWEEP_MS) return;
    lastSweep = at;
    const cutoff = at - CASE_LIFE_MS;
    for (const [id, first] of seen) if (first < cutoff) seen.delete(id);
    for (const [key, committed] of sentCalls) if (committed < cutoff) sentCalls.delete(key);
    for (const [key, meta] of startMeta) {
      if (meta.at >= cutoff) continue;
      startMeta.delete(key);
      leadStarts.delete(key);
      const split = key.indexOf("\0");
      openTurns.get(key.slice(0, split))?.delete(key.slice(split + 1));
    }
    for (const [leadId, open] of openTurns) if (open.size === 0) openTurns.delete(leadId);
    const config = readConfig();
    const withCases = new Set([...cases.values()].map(item => item.leadId));
    for (const leadId of routeReasons.keys()) {
      if (explicitRoute(config, leadId) === undefined && !knownLeads.has(leadId) && !withCases.has(leadId)) routeReasons.delete(leadId);
    }
  };

  // --- synchronous hook handlers -------------------------------------------

  /** The lead whose state a job can mutate — the queued-evidence basis
   *  dimension. Null for lead-agnostic work (tick) or an archive whose
   *  peer membership was already swept before enqueue resolved it. */
  const jobLead = (job: Job): string | null => job.leadId;
  const startKey = (leadId: string, turnId: string | null): string | null =>
    turnId === null ? null : `${leadId}\0${turnId}`;

  function onCreated(agent: PluginHookAgent, paseo: PaseoLike): void {
    if (signal.aborted) return;
    lastPaseo = paseo;
    // Off means off: with the Jev gate down nothing is queued and no host
    // refresh is issued — only local discovery bookkeeping runs. A Peer
    // created meanwhile is verified from its first turn after the gate is up.
    const gateUp = captureAllowed();
    if (isSlpLead(agent.provider)) {
      if (tombstoned(agent.id)) {
        if (gateUp && routableLead(agent.id)) enqueue({ t: "restore-lead", order: ++order, leadId: agent.id, gen: archiveGen.get(agent.id) });
        return;
      }
      discoverLead(agent);
      return;
    }
    if (gateUp && isSlpPeer(agent.provider) && agent.parentAgentId !== null && candidateLead(agent.parentAgentId)) {
      // agent.created is NOT creation-proof on this host: when a persisted
      // record lacks a provider persistence handle, ensureAgentLoaded
      // recreates the agent through createAgent, which emits the same event
      // (paseo packages/server agent-loading.ts:104-128 →
      // agent-manager.ts:1258; describeHookAgent maps parentAgentId from the
      // persisted label, lifecycle/index.ts:85). The payload's
      // parentAgentId is therefore a persisted claim, never fresh-creation
      // proof — verify membership through the same bounded refresh path as
      // post-restart discovery before registering. The job carries BOTH
      // enqueue-time generations — an archived lead cannot adopt a peer,
      // and a peer archived while the job sits queued is a stale question.
      enqueue({
        t: "verify-peer", order: ++order, leadId: agent.parentAgentId, peerId: agent.id,
        peerGen: archiveGen.get(agent.id), leadGen: archiveGen.get(agent.parentAgentId),
      });
    }
  }

  function onArchived(agent: PluginHookAgent, paseo: PaseoLike): void {
    if (signal.aborted) return;
    lastPaseo = paseo;
    // Tombstone + generation bump are synchronous so a late event cannot
    // re-enter. The generation is MONOTONIC — a restore clears only the
    // `archivedNow` flag, so a stale queued job can never alias a newer
    // archive era.
    archiveGen.set(agent.id, (archiveGen.get(agent.id) ?? 0) + 1);
    archivedNow.add(agent.id);
    knownLeads.delete(agent.id);
    // Enqueue BEFORE the peers sweep so the job resolves its lead
    // dimension while the membership entry still exists.
    enqueue({
      t: "archive", order: ++order, agent,
      leadId: isSlpLead(agent.provider) ? agent.id : peers.get(agent.id) ?? null,
    });
    // The body purge CANNOT ride the queued job — a queue-full drop would
    // leave bodies retained until expiry. Synchronously: drop the archived
    // id's membership, every peers entry pointing at an archived lead, and
    // every body of cases touching the archived id (≤ MAX_CASES — bounded,
    // and the evidenceVersion bump invalidates any in-flight ask). The
    // queued job only does bookkeeping (ring close). An archived Supervisor
    // is caught by the recipient re-check before any dispatch.
    peers.delete(agent.id);
    for (const [peerId, leadId] of peers) if (leadId === agent.id) peers.delete(peerId);
    if (isSlpLead(agent.provider)) routeReasons.set(agent.id, "lead-archived");
    for (const item of cases.values()) {
      if (item.leadId === agent.id || item.peerId === agent.id) {
        clearBodies(item);
        item.dirty = true;
      }
    }
    // An archived Lead's send dedupe can go: any capture from its dead era
    // is dropped by the generation compare before it could re-append.
    for (const key of sentCalls.keys()) if (key.startsWith(`${agent.id}\0`)) sentCalls.delete(key);
    for (const key of leadStarts.keys()) if (key.startsWith(`${agent.id}\0`)) leadStarts.delete(key);
    for (const key of startMeta.keys()) if (key.startsWith(`${agent.id}\0`)) startMeta.delete(key);
    openTurns.delete(agent.id);
  }

  function onStart(event: TurnStarted): void {
    if (signal.aborted) return;
    // A start inside a paused window is never recorded — its end will be
    // dropped at the hook anyway, and the entry would orphan into
    // overlap/unmatched pollution for the next clean turn.
    if (!observeGate().ok) return;
    sweepRetention();
    if (!isSlpLead(event.agent.provider) || tombstoned(event.agent.id)) return;
    discoverLead(event.agent);
    if (routeFor(event.agent.id) === null) return;
    const seq = ++order;
    // Null ids cannot be reliably matched; repeated starts keep the earliest
    // observed order so an old turn cannot slide across a handback boundary.
    const key = startKey(event.agent.id, event.turnId);
    if (key === null) return;
    const open = openTurns.get(event.agent.id) ?? new Set<string>();
    if (!openTurns.has(event.agent.id)) openTurns.set(event.agent.id, open);
    const overlapped = open.size > 0;
    // Overlap is mutual: a turn that starts while another is open also makes
    // the ALREADY-open turn's chronology ambiguous — mark every open start.
    if (overlapped) {
      for (const openId of open) {
        const meta = startMeta.get(`${event.agent.id}\0${openId}`);
        if (meta) meta.overlapped = true;
      }
    }
    open.add(event.turnId as string);
    if (!leadStarts.has(key)) {
      leadStarts.set(key, seq);
      startMeta.set(key, { seq, overlapped, at: now() });
    }
  }

  function onTurn(event: TurnEnded, paseo: PaseoLike): void {
    if (signal.aborted) return;
    lastPaseo = paseo;
    const gate = observeGate();
    if (!gate.ok) {
      // observeGate already ran the ONE global purge (all open cases
      // flagged capture-paused + bodies cleared + queued captures
      // scrubbed — a failed gate "does not retain new message bodies or
      // spend on assessments while delivery is impossible"; the Jev gate
      // is daemon-global, not lead-scoped). This event contributes no
      // evidence — record the drop so a paused window is inspectable. A
      // deliberately-off gate is not a pause: nothing is recorded.
      if (!DELIBERATELY_OFF.has(gate.reason)) {
        diagnostics.droppedEvents += 1;
        diag(VISIBILITY.capturePaused);
      }
      return;
    }
    const isLead = isSlpLead(event.agent.provider);
    if (isLead) discoverLead(event.agent);
    // Peer membership: known-verified pairs observe directly; unknown pairs
    // queue a refresh-verified restore first (post-restart self-healing —
    // "restore discovery only after read-only refresh verifies active
    // parentage"; a Lead discovered only through a Peer event is verified
    // by the same job). Tombstoned ids never shortcut.
    const leadId = isLead ? event.agent.id : event.agent.parentAgentId;
    if (leadId === null) return;
    const isLeadEvent = event.agent.id === leadId;
    if (isLeadEvent && tombstoned(leadId)) {
      if (routableLead(leadId)) enqueue({ t: "restore-lead", order: ++order, leadId, gen: archiveGen.get(leadId) });
      return; // the capture is dropped — a pre-restore turn cannot be trusted
    }
    if (!isLeadEvent) {
      if (!isSlpPeer(event.agent.provider)) return;
      // A peer event inside the lead's dead window cannot be trusted —
      // its membership was swept at the archive boundary and a
      // restore-lead may re-admit it on the next live turn.
      if (tombstoned(leadId)) { diag("lead-archived"); return; }
      if (!candidateLead(leadId)) return;
      if (tombstoned(event.agent.id)) {
        // A turn event while the peer is tombstoned cannot open a case —
        // the capture is dropped (archive generations "block old turns
        // from restoring an archived agent") and a verify job re-checks
        // live parentage before any future admission.
        diag("peer-archived");
        enqueue({
          t: "verify-peer", order: ++order, leadId, peerId: event.agent.id,
          peerGen: archiveGen.get(event.agent.id), leadGen: archiveGen.get(leadId),
        });
        return;
      }
      if (peers.get(event.agent.id) !== leadId) {
        enqueue({
          t: "verify-peer", order: ++order, leadId, peerId: event.agent.id,
          peerGen: archiveGen.get(event.agent.id), leadGen: archiveGen.get(leadId),
        });
      }
    } else if (routeFor(leadId) === null) {
      return;
    }
    const captured = capture(event, { has: candidateLead });
    if (captured === null || seen.has(captured.id)) return;
    seen.set(captured.id, now());
    const seq = ++order;
    const key = startKey(leadId, captured.turnId);
    const meta = key === null ? null : startMeta.get(key) ?? null;
    if (key !== null) {
      leadStarts.delete(key);
      startMeta.delete(key);
      openTurns.get(leadId)?.delete(captured.turnId as string);
    }
    enqueue({
      t: "turn-end", order: seq, leadId: captured.leadId, capture: captured,
      leadGen: archiveGen.get(captured.leadId),
      peerGen: captured.kind === "peer" ? archiveGen.get(captured.peerId) : undefined,
      startSeq: captured.kind === "lead" ? meta?.seq ?? null : null,
      overlap: captured.kind === "lead" ? meta?.overlapped ?? false : false,
    });
  }

  // --- queue machinery ------------------------------------------------------

  function enqueue(job: Job): void {
    if (signal.aborted) return;
    // Invalidation precedes the drop decision — a queue-full drop still
    // means "an event existed that no evaluation basis may ignore": the
    // global version re-arms drain scheduling, the per-lead pending
    // counter keeps every in-flight basis stale, and the overflow marks
    // below carry the per-case flags.
    version++;
    const pendingLead = jobLead(job);
    if (pendingLead !== null) enqPending.set(pendingLead, (enqPending.get(pendingLead) ?? 0) + 1);
    if (jobs.length >= MAX_QUEUE) {
      // Never lands — unwind the pending count; the overflow flags below
      // still mark affected cases through evidenceVersion.
      if (pendingLead !== null) {
        const left = Math.max(0, (enqPending.get(pendingLead) ?? 1) - 1);
        if (left === 0) enqPending.delete(pendingLead);
        else enqPending.set(pendingLead, left);
      }
      diagnostics.droppedEvents += 1;
      diag(VISIBILITY.queueOverflow);
      // Metadata-only diagnostic record for a dropped capture — the case
      // never existed, so there is nothing else to persist.
      if (job.t === "turn-end" && job.capture.kind === "peer") recordDropped(job.capture, VISIBILITY.queueOverflow);
      // A dropped lead turn-end loses sends for every open case of that
      // lead — mark the handling lane so evaluation sees the gap instead of
      // silence. The flag mutation bumps evidenceVersion: an in-flight
      // assessment must not accept against the pre-gap basis.
      if (job.t === "turn-end" && job.capture.kind === "lead") {
        for (const item of cases.values()) {
          if (item.leadId !== job.capture.leadId) continue;
          if (!item.evidence.laneFlags.includes(VISIBILITY.queueOverflow)) item.evidence.laneFlags.push(VISIBILITY.queueOverflow);
          item.evidenceVersion += 1;
          item.dirty = true;
        }
      }
      return;
    }
    jobs.push(job);
    if (!running) {
      running = true;
      queueMicrotask(() => { void drain(); });
    }
  }

  async function apply(job: Job): Promise<void> {
    const paseo = lastPaseo;
    const pendingLead = jobLead(job);
    if (pendingLead !== null) {
      // A drained counter is deleted, not kept at 0 — every reader treats
      // an absent entry as 0, so the basis compare is unchanged.
      const left = Math.max(0, (enqPending.get(pendingLead) ?? 1) - 1);
      if (left === 0) enqPending.delete(pendingLead);
      else enqPending.set(pendingLead, left);
    }
    if (job.t === "tick") {
      for (const item of cases.values()) {
        if (!item.timerUsed && item.due <= now()) {
          // The checkpoint only unlocks brief/handback delivery — it is
          // not evidence and triggers no re-assessment.
          item.timerUsed = true;
          item.evidence.pendingDelayElapsed = true;
        }
        if (item.expiresAt <= now()) closeCase(item, "unknown", VISIBILITY.caseExpired);
      }
      return;
    }
    if (job.t === "archive") {
      // Bookkeeping only — the tombstone, peers sweep, and body purge all
      // ran synchronously in onArchived (a dropped job can never leave
      // bodies retained). What remains is the ring close per case.
      const { agent } = job;
      if (isSlpLead(agent.provider)) {
        for (const [, item] of cases) if (item.leadId === agent.id) {
          clearBodies(item);
          closeCase(item, "unknown", "lead-archived");
        }
      } else {
        for (const [, item] of cases) if (item.peerId === agent.id) {
          clearBodies(item);
          closeCase(item, "unknown", "peer-archived");
        }
      }
      return;
    }
    if (job.t === "restore-lead") {
      if (paseo === undefined) return;
      // Enqueue-time generation check: an archive landing while this job
      // sat queued already invalidated the question it answers — discard
      // before spending a refresh on a stale generation.
      if (archiveGen.get(job.leadId) !== job.gen) return;
      try {
        const result = await bounded(paseo.agents.ref(job.leadId).refresh(), signal);
        // Strict compare — also catches "archived while the refresh was in
        // flight". Generations are monotonic, so an era-1 job can never
        // alias era 2 (ABA-safe).
        if (archiveGen.get(job.leadId) !== job.gen) return;
        const agent = result?.agent;
        if (!agent || agent.archivedAt !== null || agent.status === "closed" || !isSlpLead(agent.provider)) return;
        archivedNow.delete(job.leadId);
        knownLeads.set(job.leadId, { workspaceId: typeof agent.workspaceId === "string" ? agent.workspaceId : null });
      } catch { /* stays tombstoned — visibility gap recorded on next view */ }
      return;
    }
    if (job.t === "verify-peer") {
      if (paseo === undefined) return;
      // Both generations were sampled at enqueue — an archived lead cannot
      // adopt a peer (the membership would feed a dead lead's cases), and
      // a peer archived while the job sat queued is a stale question.
      // A tombstoned lead at commit time rejects regardless of the gen
      // compare — the tombstone flag, not the era, is what blocks.
      const stale = () => archiveGen.get(job.peerId) !== job.peerGen ||
        archiveGen.get(job.leadId) !== job.leadGen ||
        archivedNow.has(job.leadId);
      if (stale()) return;
      try {
        // A Lead not yet discovered must itself be verified as an active
        // exact SLP Lead before it can adopt a Peer — for defaults and for
        // explicit routes alike (a save may have accepted the Lead without
        // a host snapshot; the route activates only on host evidence).
        let discovered: { workspaceId: string | null } | null = null;
        if (!knownLeads.has(job.leadId)) {
          const leadResult = await bounded(paseo.agents.ref(job.leadId).refresh(), signal);
          if (stale()) return;
          const lead = leadResult?.agent;
          if (!lead || lead.archivedAt !== null || lead.status === "closed" || !isSlpLead(lead.provider)) return;
          discovered = { workspaceId: typeof lead.workspaceId === "string" ? lead.workspaceId : null };
        }
        const result = await bounded(paseo.agents.ref(job.peerId).refresh(), signal);
        // Post-await strict compare on BOTH ids — an archive landing
        // mid-refresh discards the verification; a raced live-looking
        // snapshot must never admit an agent that is tombstoned again.
        if (stale()) return;
        const agent = result?.agent;
        if (!agent || agent.archivedAt !== null || agent.status === "closed" || !isSlpPeer(agent.provider)) return;
        const parent = agent.labels?.["paseo.parent-agent-id"] ?? null;
        if (parent !== job.leadId) return;
        if (discovered !== null) knownLeads.set(job.leadId, discovered);
        archivedNow.delete(job.peerId);
        peers.set(job.peerId, job.leadId);
      } catch { /* unverified — subsequent turn events retry */ }
      return;
    }
    // turn-end
    const event = job.capture;
    // Job-top fail-closed: a gate-down edge observed here already ran the
    // global purge — and this job's queued capture was body-scrubbed by it.
    // The event contributes no evidence, same drop semantics as the hook.
    if (!observeGate().ok) { diag(VISIBILITY.capturePaused); return; }
    // A lead archived between enqueue and apply must not grow a case —
    // the archive's synchronous purge already ran; the queued job closes
    // the rows. The generation compare also catches archive→restore: the
    // tombstone cleared on restore but the monotonic gen moved, so a turn
    // captured in the dead era is still dropped.
    if (tombstoned(event.leadId) || archiveGen.get(event.leadId) !== job.leadGen) {
      diag("lead-archived"); return;
    }
    if (event.kind === "peer") {
      if (tombstoned(event.peerId) || archiveGen.get(event.peerId) !== job.peerGen) {
        // Captured live, archived (or archived→restored) while queued —
        // record a metadata-only row so the lost observation stays
        // inspectable (an event ARRIVING tombstoned drops at the hook
        // instead, no row).
        recordDropped(event, "peer-archived");
        return;
      }
      if (peers.get(event.peerId) !== event.leadId) {
        // Unverified membership — persist a metadata-only unknown, no bodies.
        recordDropped(event, VISIBILITY.recipientRefreshFailed);
        return;
      }
      if (cases.size >= MAX_CASES && !cases.has(event.id)) {
        diag(VISIBILITY.caseCeiling);
        recordDropped(event, VISIBILITY.caseCeiling);
        return;
      }
      const route = routeFor(event.leadId);
      if (route === null) return; // route removed/off between hook and apply
      const evidence: CaseEvidence = {
        ...peerEvidence(event),
        roomMessages: [], uncertainRoomMessages: [], otherRoomMessages: [],
        reportMessages: [],
        laneFlags: [],
        pendingDelayElapsed: route.pendingDelayMs === 0,
      };
      const item: Case = {
        id: event.id, leadId: event.leadId, peerId: event.peerId, peerTurnId: event.turnId,
        evidence,
        due: now() + route.pendingDelayMs,
        expiresAt: now() + CASE_LIFE_MS,
        timerUsed: route.pendingDelayMs === 0,
        handbackOrder: job.order,
        dirty: true,
        evidenceVersion: 0,
        gatedReason: null,
        disposition: "observed",
        assessments: 0,
        observedAt: now(),
        lastAssessment: null,
        answers: {},
        links: { answers: {}, candidates: new Map() },
        packetHash: null,
        axes: null,
        handling: "unjudged",
        exhausted: false,
        findings: [],
        delivery: null,
        retryAt: null,
        deferCount: 0,
        route: { source: route.source, mode: route.mode },
      };
      // 64 KiB of SERIALIZED bytes — JS string length counts UTF-16 code
      // units, so multibyte text would slip past a `.length` check.
      if (bytesOf(buildEvidencePayload(item, route)) > MAX_EVIDENCE_BYTES) {
        item.evidence.flags.push(VISIBILITY.evidenceOversize);
        item.gatedReason = VISIBILITY.evidenceOversize;
      }
      cases.set(item.id, item);
      recordRing(item, "observed", null);
      return;
    }
    // lead turn-end: attach accepted/unproven sends to every open case of
    // this lead; chronology is decided per case by strict start order.
    const route = routeFor(event.leadId);
    if (route === null) return;
    const newFlags = new Set(event.issues);
    // Send coverage of THIS turn (an unrecognized send-shaped call, or a
    // family whose outcomes are never observable) is a room-wide handling
    // gap — which room it touched is unknown.
    if (event.sendCoverage.state === "unverified") newFlags.add(event.sendCoverage.reason);
    const roomFor = new Map<string, MessageRef[]>();
    const reports: MessageRef[] = [];
    // Related sends whose delivery is not proven — ids only, never a body.
    const unproven: MessageRef[] = [];
    // callIds consumed into a lane during THIS gather — committed to
    // `sentCalls` only if the gather commits, so a discarded gather never
    // burns a call's dedup slot (a later identical capture may retry it).
    const accepted = new Set<string>();
    // Membership verified during THIS gather — staged, not committed:
    // `peers.set` inside the loop would survive a dropped gather and leak
    // a mid-gather archive's stale membership.
    const pendingPeers = new Map<string, string>();
    // The gather's own basis: a purge landing mid-gather invalidates every
    // lane assembled from pre-purge prompts.
    const purgeAt = purgeCount;
    for (const send of event.sends) {
      if (signal.aborted) return;
      // Per-iteration gate read — the funnel purges globally on a down
      // edge, so a send classified after a mid-loop gate-down (observed or
      // file-only) never lands a body.
      if (!observeGate().ok) { newFlags.add(VISIBILITY.capturePaused); break; }
      // An unverified input names no reliable recipient: the room it
      // touched is unknown, so every case of this Lead carries the gap.
      if (send.input.state !== "verified") { newFlags.add(send.input.reason); continue; }
      const recipient = send.input.value.recipient;
      const delivered = isAcceptedSend(send);
      const callKey = `${event.leadId}\0${send.callId}`;
      if (sentCalls.has(callKey) || accepted.has(callKey)) continue;
      const refOf = (): MessageRef => ({
        callId: send.callId, turnId: event.turnId, recipient,
        prompt: delivered ? send.input.value.prompt : "", seq: ++messageSeq,
      });
      // A send whose outcome is not accepted gates handling only for the
      // room it relates to (this Lead's direct Peers or its Supervisor);
      // its reason is recorded, its body never kept.
      const unprovenReason = send.outcome.state === "accepted" ? null : send.outcome.reason;
      if (route.supervisorAgentId !== null && recipient === route.supervisorAgentId) {
        if (delivered) reports.push(refOf());
        else { unproven.push(refOf()); newFlags.add(unprovenReason as string); }
        accepted.add(callKey);
        continue;
      }
      if (recipient === event.leadId) continue;
      // A send counts as room communication only toward a verified direct
      // Peer. A tombstoned recipient is archived on local evidence — never
      // admit it via a stale peers entry, and never refresh a
      // stale-generation id.
      let leadOfRecipient = tombstoned(recipient) ? undefined : peers.get(recipient);
      if (leadOfRecipient === undefined && lastPaseo !== undefined) {
        if (tombstoned(recipient)) {
          newFlags.add(VISIBILITY.recipientInactive);
          continue;
        }
        const gen = archiveGen.get(recipient);
        try {
          const result = await bounded(lastPaseo.agents.ref(recipient).refresh(), signal);
          if (signal.aborted) return;
          // Post-await, gate first: a mid-await gate-down already ran the
          // global purge — this prompt must not become a fresh body.
          if (!observeGate().ok) { newFlags.add(VISIBILITY.capturePaused); break; }
          // Post-await generation compare — an archive landing mid-refresh
          // makes the returned snapshot stale; treat it as refresh failure,
          // never admit the send.
          if (archiveGen.get(recipient) !== gen) {
            newFlags.add(VISIBILITY.recipientRefreshFailed);
            continue;
          }
          const agent = result?.agent;
          if (!agent || agent.archivedAt !== null || agent.status === "closed") {
            newFlags.add(VISIBILITY.recipientInactive);
            continue;
          }
          if (isSlpPeer(agent.provider) && (agent.labels?.["paseo.parent-agent-id"] ?? null) === event.leadId) {
            leadOfRecipient = event.leadId;
            pendingPeers.set(recipient, event.leadId);
          }
        } catch {
          if (signal.aborted) return;
          newFlags.add(VISIBILITY.recipientRefreshFailed);
          continue;
        }
      }
      if (leadOfRecipient !== event.leadId) continue; // unrelated recipient — never proof, never a gap
      accepted.add(callKey);
      if (!delivered) { unproven.push(refOf()); newFlags.add(unprovenReason as string); continue; }
      const list = roomFor.get(recipient) ?? [];
      list.push(refOf());
      roomFor.set(recipient, list);
    }
    // Commit segment — NO await between this validation and the mutations.
    // A gate-down observed here, a purge boundary crossed mid-gather, a
    // lead archive (tombstone now, or an archive→restore era change via
    // the enqueue-time gen), or a route removal/supervisor change all
    // invalidate the assembled lanes — the purge/archive already flagged
    // and cleared every affected case, so the gather is simply dropped.
    if (signal.aborted) return;
    const routeNow = routeFor(event.leadId);
    if (!observeGate().ok || purgeCount !== purgeAt || tombstoned(event.leadId) ||
        archiveGen.get(event.leadId) !== job.leadGen ||
        routeNow === null || routeNow.supervisorAgentId !== route.supervisorAgentId) {
      for (const item of cases.values()) if (item.leadId === event.leadId) item.dirty = true;
      return;
    }
    // Per-recipient tombstone sweep: a recipient archived while a LATER
    // send's refresh was in flight invalidates the lane accepted earlier —
    // drop it and flag, same as the in-loop recipient-inactive path. The
    // unproven lane follows the same rule.
    for (const recipient of roomFor.keys()) {
      if (tombstoned(recipient)) { roomFor.delete(recipient); newFlags.add(VISIBILITY.recipientInactive); }
    }
    for (let i = reports.length - 1; i >= 0; i -= 1) {
      if (tombstoned(reports[i].recipient)) { reports.splice(i, 1); newFlags.add(VISIBILITY.recipientInactive); }
    }
    const uncertainKept = unproven.filter(ref => {
      if (!tombstoned(ref.recipient)) return true;
      newFlags.add(VISIBILITY.recipientInactive);
      return false;
    });
    // Verified memberships commit only inside the guard — and only for
    // recipients still outside the tombstone set.
    for (const [id, lead] of pendingPeers) if (!tombstoned(id)) peers.set(id, lead);
    for (const callKey of accepted) sentCalls.set(callKey, now());
    const startProven = job.startSeq !== null && !job.overlap;
    for (const item of cases.values()) {
      if (item.leadId !== event.leadId) continue;
      // A case-peer archived mid-gather sits on the archive boundary —
      // onArchived already purged its bodies; appending lanes now would
      // resurrect bodies the boundary invalidated.
      if (tombstoned(item.peerId)) continue;
      const startQualifies = startProven && (job.startSeq as number) > item.handbackOrder;
      // End-only fallback (spec §Observation point 5): when no usable
      // turn-start is on record — reload erased the start maps, the hook
      // RPC timed out, or a gate pause dropped it — the ended turn's own
      // ordering can still prove chronology, but only inside the turn
      // slice extraction used: the turn-opening user_message IS this
      // case's handback delivery — the finish-notification envelope with
      // the peer's id at the status-line position and the handback in the
      // agent-response section. The envelope is correlation evidence from
      // text, not an authenticated sender; a bare prompt body is not
      // accepted, and an anchor in an older turn or a scrubbed body never
      // qualifies — the fallback invents nothing and fabricates no start.
      const endDerived = handbackAnchorIndex(
        event.anchors, item.peerId,
        item.evidence.handback?.text ?? null,
      ) >= 0;
      const qualifies = startQualifies || endDerived;
      // One chronology rule for EVERY send class: a qualifying send to
      // THIS case's Peer is the room lane; to another verified direct Peer
      // the cross-Peer lane; to the route Supervisor the report lane — all
      // three can carry a disposition. ANY non-qualifying send lands in the
      // uncertain lane: ambiguous chronology is never handling.
      // `laned` = this ended turn put at least one send into one of this
      // case's lanes. Only then is the turn's chronology evidence about
      // the case at all: a turn with no sends — typically the Lead turn the
      // host cancels when the Peer's own handback delivery replaces the
      // running run (sendPromptToAgent replaceRunning) — orders nothing
      // and must not stamp lead-start-unmatched on every open case.
      let mutated = false;
      let laned = false;
      for (const [recipient, list] of roomFor) {
        if (list.length === 0) continue;
        mutated = true;
        laned = true;
        if (qualifies) {
          (recipient === item.peerId ? item.evidence.roomMessages : item.evidence.otherRoomMessages).push(...list.map(m => ({ ...m })));
        } else {
          item.evidence.uncertainRoomMessages.push(...list.map(m => ({ ...m })));
        }
      }
      if (uncertainKept.length > 0) {
        mutated = true;
        laned = true;
        item.evidence.uncertainRoomMessages.push(...uncertainKept.map(m => ({ ...m })));
      }
      if (reports.length > 0) {
        mutated = true;
        laned = true;
        (qualifies ? item.evidence.reportMessages : item.evidence.uncertainRoomMessages).push(...reports.map(m => ({ ...m })));
      }
      // Lead-turn flags describe the handling lane only — they never touch
      // the brief/handback bodies' provenance.
      for (const flag of newFlags) {
        const target = flag === VISIBILITY.capturePaused ? item.evidence.flags : item.evidence.laneFlags;
        if (!target.includes(flag)) { target.push(flag); mutated = true; }
      }
      // Per-case chronology flags — only for a turn that laned a send into
      // this case: unmatched start stays a handling-axis gap only when
      // neither path proved ordering; an end-derived proof is recorded
      // honestly instead (informational, never a gate reason).
      const chronFlag = !laned ? null
        : !qualifies ? VISIBILITY.leadStartUnmatched
        : !startQualifies ? VISIBILITY.leadStartEndDerived
        : null;
      if (chronFlag !== null && !item.evidence.laneFlags.includes(chronFlag)) {
        item.evidence.laneFlags.push(chronFlag);
        mutated = true;
      }
      // Every applied mutation bumps the case's evaluation basis — an
      // in-flight assessment must not accept against stale evidence.
      if (mutated) { item.evidenceVersion += 1; item.dirty = true; }
      recordRing(item, stateOf(item), item.gatedReason);
    }
  }

  /** Case body evidence from a Peer capture — the one mapping from capture
   *  evidence to case state. A brief/handback that is not verified is stored
   *  absent, its reason recorded in the case flags (missing, or unverified
   *  plus the cause) — applicability reads exactly that. The Peer's own
   *  sends are informational: only accepted ones are kept as delivered
   *  reports; any other outcome adds its reason and gates nothing (a Peer
   *  send receipt never removes the brief/handback axes). */
  const peerEvidence = (event: Extract<Capture, { kind: "peer" }>): Pick<CaseEvidence, "brief" | "handback" | "peerSends" | "flags"> => {
    const flags = new Set(event.issues);
    const message = (evidence: Evidence<CapturedMessage>, unverified: string): CapturedMessage | null => {
      if (evidence.state === "verified") return evidence.value;
      if (evidence.state === "missing") flags.add(evidence.reason);
      else { flags.add(unverified); flags.add(evidence.reason); }
      return null;
    };
    const brief = message(event.brief, VISIBILITY.briefUnverified);
    const handback = message(event.handback, VISIBILITY.handbackUnverified);
    // Coverage of this Peer turn's send-shaped calls (e.g. a call naming
    // send_agent_prompt that no adapter recognizes) — informational only.
    const sendShaped = event.sends.length > 0 || (event.sendCoverage.state === "unverified" && event.sendCoverage.reason === VISIBILITY.sendShapeUnverified);
    if (event.sendCoverage.state === "unverified" && sendShaped) flags.add(event.sendCoverage.reason);
    const peerSends: MessageRef[] = [];
    for (const send of event.sends) {
      if (isAcceptedSend(send)) {
        peerSends.push({ callId: send.callId, turnId: event.turnId, recipient: send.input.value.recipient, prompt: send.input.value.prompt, seq: ++messageSeq });
      } else {
        flags.add(send.input.state !== "verified" ? send.input.reason : (send.outcome as { reason: string }).reason);
      }
    }
    return {
      brief: brief === null ? null : {
        text: brief.text, messageId: brief.messageId,
        flags: flags.has(VISIBILITY.briefAssignmentFile) ? [VISIBILITY.briefAssignmentFile] : [],
      },
      handback,
      peerSends,
      flags: [...flags],
    };
  };

  const clearBodies = (item: Case): void => {
    item.evidence.brief = item.evidence.brief === null ? null : { text: "", messageId: item.evidence.brief.messageId, flags: item.evidence.brief.flags };
    item.evidence.handback = item.evidence.handback === null ? null : { text: "", messageId: item.evidence.handback.messageId };
    for (const lane of [item.evidence.roomMessages, item.evidence.uncertainRoomMessages, item.evidence.otherRoomMessages, item.evidence.reportMessages, item.evidence.peerSends]) {
      for (const message of lane) message.prompt = "";
    }
    // Body loss changes the evaluation basis — an in-flight assessment
    // built on the pre-clear payload is stale and must be discarded.
    item.evidenceVersion += 1;
  };

  // --- evaluation -----------------------------------------------------------

  /** The packet actually sent: full bodies when they fit the byte cap;
   *  otherwise cross-Peer bodies are withheld (handling becomes
   *  unobservable via other-room-bodies-omitted); still over the cap →
   *  null (the case gates evidence-oversize). Never a silent truncation. */
  const packetFor = (item: Case, route: EffectiveRoute): EvidencePayload | null => {
    const full = buildEvidencePayload(item, route);
    if (bytesOf(full) <= MAX_EVIDENCE_BYTES) return full;
    const reduced = buildEvidencePayload(item, route, { omitOtherBodies: true });
    return bytesOf(reduced) <= MAX_EVIDENCE_BYTES ? reduced : null;
  };

  const gateClose = (item: Case, reason: string): void => {
    routeReasons.set(item.leadId, reason);
    item.disposition = "unknown";
    closeCase(item, "unknown", reason);
  };

  async function evaluateCase(item: Case): Promise<void> {
    const route = routeFor(item.leadId);
    if (route === null) { closeCase(item, "unknown", unroutedReason(item.leadId)); return; }
    item.route = { source: route.source, mode: route.mode };
    const gate = observeGate();
    if (!gate.ok) {
      // A failed gate pauses the route: record the reason, drop every
      // captured body, keep the metadata-only ring row (spec: "does not
      // retain new message bodies or spend on assessments while delivery is
      // impossible"). The case closes unknown — evidence already cleared
      // can never support a later judgment anyway.
      clearBodies(item);
      gateClose(item, gate.reason);
      return;
    }
    routeReasons.delete(item.leadId);
    if (item.gatedReason !== null) { closeCase(item, "unknown", item.gatedReason); return; }
    if (item.expiresAt <= now()) { closeCase(item, "unknown", VISIBILITY.caseExpired); return; }
    const paseo = lastPaseo;
    if (paseo === undefined) {
      item.disposition = "unknown";
      recordRing(item, stateOf(item), "sdk-unavailable");
      return;
    }
    // Liveness gates: refresh Lead and Peer — an archived/closed seat pauses
    // and is surfaced, never treated as drift. An id already tombstoned is
    // archived on local evidence — close on the archive boundary without
    // spending a refresh on a stale generation.
    if (tombstoned(item.leadId)) { clearBodies(item); closeCase(item, "unknown", "lead-archived"); return; }
    if (tombstoned(item.peerId)) { clearBodies(item); closeCase(item, "unknown", "peer-archived"); return; }

    // Evaluation basis — sampled BEFORE the first await so every
    // dimension's invalidation window covers the whole suspension (spec:
    // "New evidence arriving during an assessment invalidates that
    // assessment"). Dimensions:
    //   pending    — this lead's enqueued-not-applied jobs (per-LEAD, so an
    //                unrelated lead's enqueue or a tick never discards a
    //                paid assessment of THIS case).
    //   evidence   — in-place case mutations (lane pushes, body clears,
    //                flag adds).
    //   leadGen / peerGen — monotonic archive generations.
    //   purge      — observed gate-down edges; closes the down→up ABA that
    //                a gate re-read cannot see.
    //   configStamp / gateStamp — the files can flip without any event
    //                reaching this observer.
    const basis = {
      pending: enqPending.get(item.leadId) ?? 0,
      evidence: item.evidenceVersion,
      leadGen: archiveGen.get(item.leadId),
      peerGen: archiveGen.get(item.peerId),
      purge: purgeCount,
      configStamp: configCache?.stamp ?? "-",
      gateStamp: gateCache?.stamp ?? "-",
    };
    // Evidence inbound for this lead — defer rather than assess a
    // snapshot the queue is about to change.
    if (basis.pending !== 0) { item.dirty = true; return; }
    const basisStale = (): boolean => {
      readConfig();
      jevGate();
      return (enqPending.get(item.leadId) ?? 0) !== basis.pending ||
        item.evidenceVersion !== basis.evidence ||
        archiveGen.get(item.leadId) !== basis.leadGen ||
        archiveGen.get(item.peerId) !== basis.peerGen ||
        purgeCount !== basis.purge ||
        (configCache?.stamp ?? "-") !== basis.configStamp ||
        (gateCache?.stamp ?? "-") !== basis.gateStamp;
    };

    let leadSnap, peerSnap;
    try {
      [leadSnap, peerSnap] = await Promise.all([
        bounded(paseo.agents.ref(item.leadId).refresh(), signal),
        bounded(paseo.agents.ref(item.peerId).refresh(), signal),
      ]);
    } catch {
      if (signal.aborted) return;
      item.disposition = "unknown";
      recordRing(item, stateOf(item), VISIBILITY.recipientRefreshFailed);
      return;
    }
    if (signal.aborted) return;
    // Post-await archive re-check: onArchived tombstones synchronously at
    // hook time, so an archive landing mid-refresh is visible here even
    // though its job is still queued behind this evaluation.
    if (tombstoned(item.leadId)) { clearBodies(item); closeCase(item, "unknown", "lead-archived"); return; }
    if (tombstoned(item.peerId)) { clearBodies(item); closeCase(item, "unknown", "peer-archived"); return; }
    // A gate-down edge during the refresh already ran the global purge —
    // this case included.
    const gateMid = observeGate();
    if (!gateMid.ok) { gateClose(item, gateMid.reason); return; }
    // Route presence before the generic basis compare — a removed route
    // closes with its own reason instead of discarding into a deferred
    // re-evaluation that would close on it anyway one pass later.
    const routeMid = routeFor(item.leadId);
    if (routeMid === null) { closeCase(item, "unknown", unroutedReason(item.leadId)); return; }
    if (basisStale()) { item.dirty = true; return; }
    const lead = leadSnap?.agent;
    // The exact workspace binding belongs to explicit routes; a discovered
    // Lead's workspace is presentation only.
    if (!lead || lead.archivedAt !== null || lead.status === "closed" || !isSlpLead(lead.provider) ||
        (routeMid.source === "route" && lead.workspaceId !== routeMid.leadWorkspaceId)) {
      item.disposition = "unknown";
      clearBodies(item);
      closeCase(item, "unknown", "lead-inactive");
      return;
    }
    // Lead send coverage from the Lead's own refreshed host record (never
    // inferred from the Peer): a family whose dispositions can never be
    // accepted leaves handling unusable from the first assessment. The
    // provider of an agent id is immutable, so the fact only accumulates.
    // Like every applied mutation it bumps the case's evaluation basis; this
    // evaluation re-bases onto it because the fact comes from its OWN refresh
    // in the same synchronous segment (evaluations are serialized, so no
    // other assessment of this case is in flight) — without the re-base the
    // evaluation would discard itself and re-refresh once per case.
    const leadCoverage = sendCoverageOf(typeof lead.provider === "string" ? lead.provider : null);
    if (leadCoverage.state === "unverified" && !item.evidence.laneFlags.includes(leadCoverage.reason)) {
      item.evidence.laneFlags.push(leadCoverage.reason);
      item.evidenceVersion += 1;
      basis.evidence = item.evidenceVersion;
    }
    const peer = peerSnap?.agent;
    if (!peer || peer.archivedAt !== null || peer.status === "closed" ||
        !isSlpPeer(peer.provider) || (peer.labels?.["paseo.parent-agent-id"] ?? null) !== item.leadId) {
      item.disposition = "unknown";
      clearBodies(item);
      closeCase(item, "unknown", "peer-inactive");
      return;
    }
    const payload = packetFor(item, routeMid);
    if (payload === null) {
      item.gatedReason = VISIBILITY.evidenceOversize;
      item.disposition = "unknown";
      if (!item.evidence.flags.includes(VISIBILITY.evidenceOversize)) item.evidence.flags.push(VISIBILITY.evidenceOversize);
      closeCase(item, "unknown", VISIBILITY.evidenceOversize);
      return;
    }
    // The withheld-bodies fact is monotonic (lanes only grow) — record it on
    // the case so the ring shows why handling is unobservable.
    if (payload.laneFlags.includes(VISIBILITY.otherRoomBodiesOmitted) &&
        !item.evidence.laneFlags.includes(VISIBILITY.otherRoomBodiesOmitted)) {
      item.evidence.laneFlags.push(VISIBILITY.otherRoomBodiesOmitted);
    }
    const caseReason = evidenceGate(payload);
    if (caseReason !== null) {
      item.gatedReason = caseReason;
      item.disposition = "unknown";
      if (!item.evidence.flags.includes(caseReason)) item.evidence.flags.push(caseReason);
      closeCase(item, "unknown", caseReason);
      return;
    }
    const gates = axisGates(payload);
    payload.axes = {
      brief: { judgeable: gates.brief === null, reason: gates.brief },
      handback: { judgeable: gates.handback === null, reason: gates.handback },
      handling: { judgeable: gates.handling === null, reason: gates.handling },
    };
    item.axes = gates;
    const candidates = linkCandidates(payload);
    const open = new Set(openFindings(item).map(finding => finding.axis));
    const questions = buildQuestions({
      leadBrief: gates.brief === null && item.answers.leadBrief === undefined,
      peerHandback: gates.handback === null && item.answers.peerHandback === undefined,
      leadHandling: gates.handling === null,
      briefCorrection: open.has("brief"),
      handbackCorrection: open.has("handback"),
      candidates: [...candidates.keys()],
    });
    const packetHash = createHash("sha256").update(JSON.stringify({ payload, questions })).digest("hex");
    // Nothing to ask, or the identical packet was already assessed: the
    // verdict is re-derived from held answers — no second spend.
    if (Object.keys(questions).length === 0 || packetHash === item.packetHash) {
      applyJudgment(item, gates);
      return;
    }
    if (item.assessments >= MAX_ASSESSMENTS) {
      item.exhausted = true;
      diag(VISIBILITY.assessmentCeiling);
      applyJudgment(item, gates, VISIBILITY.assessmentCeiling);
      return;
    }
    // Spec: "Before every prompt, re-read the gates and refresh the
    // recipient" — recipients were refreshed above; the gate is re-read
    // NOW, immediately before the spend, and the freshly read object is
    // what the ask uses. The final basis validation sits in the same
    // synchronous segment as `assessments += 1`.
    const gateNow = observeGate();
    if (!gateNow.ok) { gateClose(item, gateNow.reason); return; }
    if (basisStale()) { item.dirty = true; return; }
    item.assessments += 1;
    let assessment: { answers: Answers; model: string; usage: { input_tokens: number; output_tokens: number } | null } | null = null;
    let failed = "jev-request-failed";
    try {
      const envelope = await ask(gateNow.provider, gateNow.authorization, { state: payload, questions }, { timeoutMs: httpTimeoutMs, signal });
      const parsed = parseAssessmentResponse(envelope.raw, gateNow.provider, questions);
      if (parsed !== null) assessment = parsed;
      else failed = "jev-response-invalid";
    } catch (error) {
      failed = error instanceof JevRequestError && error.code === "jev-redacted"
        ? VISIBILITY.credentialGuard
        : error instanceof JevRequestError ? error.code : "jev-request-failed";
    }
    if (signal.aborted) return;
    // Post-ask revalidation, ordered so the most precise close reason wins:
    // a down edge purges (and explains itself), a removed route closes
    // route-removed, an archive closes on its boundary, and any remaining
    // basis drift discards the paid-for assessment (the spend is still
    // counted — the ceiling exists to bound calls, not verdicts).
    const gateAfter = observeGate();
    if (!gateAfter.ok) { gateClose(item, gateAfter.reason); return; }
    if (routeFor(item.leadId) === null) { closeCase(item, "unknown", unroutedReason(item.leadId)); return; }
    if (tombstoned(item.leadId)) { clearBodies(item); closeCase(item, "unknown", "lead-archived"); return; }
    if (tombstoned(item.peerId)) { clearBodies(item); closeCase(item, "unknown", "peer-archived"); return; }
    if (basisStale()) { item.dirty = true; return; }
    if (assessment === null) {
      // A failed/malformed Jev call never proves anything and a failed
      // request never auto-retries (spec). The case stays open — new
      // evidence re-arms dirty; the ceiling bounds total calls.
      // Credential-guard refusals are permanent — close immediately.
      item.dirty = false;
      item.disposition = "unknown";
      if (failed === VISIBILITY.credentialGuard) { closeCase(item, "unknown", VISIBILITY.credentialGuard); return; }
      if (item.assessments >= MAX_ASSESSMENTS) item.exhausted = true;
      recordRing(item, stateOf(item), failed);
      settle(item);
      return;
    }
    const { leadBrief, peerHandback, leadHandling, dispositionMessage, briefCorrection, handbackCorrection } = assessment.answers;
    if (leadBrief !== undefined) item.answers.leadBrief = leadBrief;
    if (peerHandback !== undefined) item.answers.peerHandback = peerHandback;
    if (leadHandling !== undefined) item.answers.leadHandling = leadHandling;
    const links: Answers = {};
    if (dispositionMessage !== undefined) links.dispositionMessage = dispositionMessage;
    if (briefCorrection !== undefined) links.briefCorrection = briefCorrection;
    if (handbackCorrection !== undefined) links.handbackCorrection = handbackCorrection;
    item.links = { answers: links, candidates };
    item.packetHash = packetHash;
    item.lastAssessment = summarize(item, assessment.model, assessment.usage);
    applyJudgment(item, gates);
  }

  const axisSummary = (answer: Answer | undefined) => answer === undefined
    ? { choice: "not-asked", confidence: 0 }
    : { choice: answer.choice, confidence: answer.confidence, probabilities: { ...answer.probabilities } };

  const summarize = (item: Case, model: string, usage: { input_tokens: number; output_tokens: number } | null): NonNullable<Observation["lastAssessment"]> => {
    const link = (id: "dispositionMessage" | "briefCorrection" | "handbackCorrection"): string | null => {
      const answer = item.links.answers[id];
      return answer === undefined ? null : item.links.candidates.get(answer.choice) ?? null;
    };
    return {
      at: new Date(now()).toISOString(),
      model,
      rubricVersion: RUBRIC_VERSION,
      captureVersion: CAPTURE_VERSION,
      usage,
      choices: {
        leadBrief: axisSummary(item.answers.leadBrief),
        peerHandback: axisSummary(item.answers.peerHandback),
        leadHandling: axisSummary(item.answers.leadHandling),
      },
      links: {
        dispositionMessage: link("dispositionMessage"),
        briefCorrection: link("briefCorrection"),
        handbackCorrection: link("handbackCorrection"),
      },
    };
  };

  /** Record independent findings and linked resolutions from held answers.
   *  A finding is immutable history; only a correction LINKED to a specific
   *  confirmed message resolves it (a handling finding: a later linked
   *  disposition). An unknown axis never erases another axis's finding. */
  function applyJudgment(item: Case, gates: NonNullable<Case["axes"]>, note: string | null = null): void {
    const threshold = readConfig()?.confidenceThreshold ?? SUPERVISION_CONFIDENCE_DEFAULT;
    const verdict = judge({ ...item.answers, ...item.links.answers }, gates, threshold, item.links.candidates);
    const stamp = new Date(now()).toISOString();
    const record = (axis: FindingAxis, answer: Answer | null, evidenceCallId: string | null) => {
      if (answer === null || item.findings.some(finding => finding.axis === axis)) return;
      item.findings.push({
        axis, choice: answer.choice, confidence: answer.confidence, at: stamp,
        status: "open", evidenceCallId, resolvedBy: null, resolvedAt: null,
      });
    };
    if (verdict.brief.status === "gap") record("brief", verdict.brief.answer, null);
    if (verdict.handback.status === "gap") record("handback", verdict.handback.answer, null);
    if (verdict.handling.status === "gap") record("handling", verdict.handling.answer, verdict.handling.callId);
    const resolve = (axis: FindingAxis, callId: string | null) => {
      const finding = item.findings.find(f => f.axis === axis && f.status === "open");
      if (finding === undefined || callId === null || callId === finding.evidenceCallId) return;
      // A mishandling is corrected only by a disposition observed AFTER it:
      // both messages must be in this case's confirmed lanes and the
      // resolving one strictly later in append order. A missing order
      // proves nothing. (Brief/handback findings concern the original
      // bodies, which every confirmed post-handback message follows.)
      if (axis === "handling") {
        const mishandled = finding.evidenceCallId === null ? undefined : seqOf(item, finding.evidenceCallId);
        const disposition = seqOf(item, callId);
        if (mishandled === undefined || disposition === undefined || disposition <= mishandled) return;
      }
      finding.status = "resolved";
      finding.resolvedBy = callId;
      finding.resolvedAt = stamp;
    };
    resolve("brief", verdict.corrections.brief);
    resolve("handback", verdict.corrections.handback);
    if (verdict.handling.status === "clean") resolve("handling", verdict.handling.callId);
    item.handling = verdict.handling.status;
    item.dirty = false;
    if (item.disposition === "observed" && item.lastAssessment !== null) item.disposition = "unknown";
    recordRing(item, stateOf(item), note ?? reasonOf(item));
    settle(item);
  }

  /** Append order of a confirmed post-handback message in this case. */
  const seqOf = (item: Case, callId: string): number | undefined =>
    [...item.evidence.roomMessages, ...item.evidence.otherRoomMessages, ...item.evidence.reportMessages]
      .find(message => message.callId === callId)?.seq;

  const reasonOf = (item: Case): string | null => {
    const open = openFindings(item);
    if (open.length > 0) return `suspected-drift:${open.map(finding => finding.axis).join(",")}`;
    if (item.handling === "open") return "handling-pending";
    if (item.axes?.handling !== null && item.axes?.handling !== undefined) return item.axes.handling;
    return item.lastAssessment === null ? null : "assessment-inconclusive";
  };

  /** Closure rules — a case closes only when nothing more can change its
   *  outcome or delivery:
   *  - no open finding: handling clean and both body axes judged or
   *    unobservable → evaluated; handling permanently gated (every gate
   *    input only accumulates) → unknown with the gate reason; ceiling
   *    exhausted → unknown.
   *  - open findings: once handling is settled (clean) or the ceiling is
   *    exhausted, after the pending-delay checkpoint and once any notify
   *    delivery is settled → suspected drift. A permanently gated handling
   *    axis keeps the case open until expiry so a linked correction can
   *    still resolve the finding. */
  function settle(item: Case): void {
    if (!cases.has(item.id)) return;
    const axes = item.axes;
    if (axes === null) return;
    const bodiesDone = (axes.brief !== null || item.answers.leadBrief !== undefined) &&
      (axes.handback !== null || item.answers.peerHandback !== undefined);
    const open = openFindings(item);
    if (open.length === 0) {
      if (item.handling === "clean" && bodiesDone) closeCase(item, "evaluated", null);
      else if (axes.handling !== null && bodiesDone) closeCase(item, "unknown", axes.handling);
      else if (item.exhausted) closeCase(item, "unknown", VISIBILITY.assessmentCeiling);
      return;
    }
    if ((item.handling === "clean" || item.exhausted) && now() >= item.due && deliverySettled(item)) {
      closeCase(item, stateOf(item), item.exhausted ? VISIBILITY.assessmentCeiling : reasonOf(item));
    }
  }

  /** Nothing is left to deliver: not notify, the recipient was blocked or
   *  the dispatch canceled (neither is retried), or every open finding was
   *  attempted or no longer meets the current threshold. A deferred
   *  delivery is not settled. */
  const deliverySettled = (item: Case): boolean => {
    if (item.route.mode !== "notify") return true;
    const state = item.delivery?.state;
    if (state === "blocked" || state === "canceled") return true;
    const recipient = routeFor(item.leadId)?.supervisorAgentId ?? null;
    if (recipient === null) return true;
    const threshold = readConfig()?.confidenceThreshold ?? SUPERVISION_CONFIDENCE_DEFAULT;
    const attempted = deliveries.attempted(item.id, recipient);
    return openFindings(item).every(finding => finding.confidence < threshold || attempted.has(finding.axis));
  };

  // --- delivery (notify) -------------------------------------------------------

  const routeKeyOf = (route: EffectiveRoute | null): string =>
    route === null ? "-" : `${route.mode}\0${route.supervisorAgentId ?? "-"}\0${route.source}`;

  const setDelivery = (item: Case, state: SupervisionDelivery["state"], recipient: string, reason: string | null, findings: FindingAxis[]) => {
    item.delivery = { state, recipient, at: new Date(now()).toISOString(), reason, findings };
    recordRing(item, stateOf(item), reason ?? reasonOf(item));
  };

  /** Findings eligible for delivery right now: open, confident under the
   *  CURRENT threshold, not yet attempted for this recipient; handling
   *  mishandling immediately, brief/handback only after the checkpoint. */
  const eligibleFindings = (item: Case, recipient: string): FindingAxis[] => {
    const threshold = readConfig()?.confidenceThreshold ?? SUPERVISION_CONFIDENCE_DEFAULT;
    const attempted = deliveries.attempted(item.id, recipient);
    return openFindings(item)
      .filter(finding => finding.confidence >= threshold && !attempted.has(finding.axis))
      .filter(finding => finding.axis === "handling" || item.evidence.pendingDelayElapsed || now() >= item.due)
      .map(finding => finding.axis);
  };

  async function dispatch(item: Case, route: EffectiveRoute, recipient: string, axes: FindingAxis[]): Promise<void> {
    const paseo = lastPaseo;
    if (paseo === undefined) return;
    const routeKey = routeKeyOf(route);
    if (tombstoned(recipient)) { setDelivery(item, "blocked", recipient, "recipient-archived", axes); routeReasons.set(item.leadId, "notify-recipient-archived"); return; }
    let snapshot: PaseoAgentSnapshot | null | undefined;
    try {
      snapshot = (await bounded(paseo.agents.ref(recipient).refresh(), signal))?.agent;
    } catch {
      if (signal.aborted) return;
      // Availability unknown — no attempt was made; retry with backoff.
      deferDelivery(item, recipient, "recipient-refresh-failed", axes);
      return;
    }
    if (signal.aborted) return;
    // Post-await revalidation: the case, the finding set, the effective
    // route (mode/recipient) and the recipient's archive state must all be
    // unchanged — a changed route never falls back to another recipient.
    if (!cases.has(item.id) || !observeGate().ok) return;
    if (routeKeyOf(routeFor(item.leadId)) !== routeKey || tombstoned(recipient) ||
        tombstoned(item.leadId) || tombstoned(item.peerId)) {
      setDelivery(item, "canceled", recipient, "route-changed-before-dispatch", axes);
      return;
    }
    const check = checkRecipient(snapshot, recipient);
    if (!check.ok) {
      routeReasons.set(item.leadId, `notify-${check.reason}`);
      setDelivery(item, "blocked", recipient, check.reason, axes);
      return;
    }
    if (routeReasons.get(item.leadId)?.startsWith("notify-")) routeReasons.delete(item.leadId);
    if (check.running) { deferDelivery(item, recipient, "recipient-running", axes); return; }
    const still = eligibleFindings(item, recipient).filter(axis => axes.includes(axis));
    if (still.length === 0) return;
    const findings = item.findings.filter(finding => finding.status === "open" && still.includes(finding.axis));
    const linked = new Set(findings.map(finding => finding.evidenceCallId).filter((id): id is string => id !== null));
    const payload = buildEvidencePayload(item, route);
    const prompt = buildAlertPrompt({
      caseFingerprint: item.id,
      leadAgentId: item.leadId,
      peerId: item.peerId,
      peerTurnId: item.peerTurnId,
      route: { source: route.source, mode: "notify" },
      rubricVersion: RUBRIC_VERSION,
      model: item.lastAssessment?.model ?? null,
      confidenceThreshold: readConfig()?.confidenceThreshold ?? SUPERVISION_CONFIDENCE_DEFAULT,
      findings: findings.map(finding => ({ axis: finding.axis, choice: finding.choice, confidence: finding.confidence, evidenceCallId: finding.evidenceCallId })),
      visibility: [...payload.flags, ...payload.laneFlags.filter(flag => !payload.flags.includes(flag))],
      brief: still.includes("brief") && payload.brief !== null ? { messageId: payload.brief.messageId, text: payload.brief.text } : null,
      handback: (still.includes("handback") || still.includes("handling")) && payload.handback !== null
        ? { messageId: payload.handback.messageId, text: payload.handback.text } : null,
      messages: payload.messages
        .filter(message => linked.has(message.callId) && message.prompt !== null)
        .map(message => ({ callId: message.callId, recipient: message.recipient, recipientRole: message.recipientRole, text: message.prompt ?? "" })),
    });
    try {
      assertRedacted(prompt);
    } catch {
      setDelivery(item, "blocked", recipient, VISIBILITY.credentialGuard, still);
      return;
    }
    const key = deliveryKey(item.id, still, recipient);
    // Mark before send — no await between this check, the reservation and
    // the SDK call. A reservation that cannot be persisted blocks dispatch:
    // an unrecorded attempt could be repeated after a restart.
    const reserved = deliveries.reserve({ key, caseFingerprint: item.id, leadAgentId: item.leadId, peerId: item.peerId, recipient, findings: still, messageId: alertMessageId(key) });
    if (!reserved.ok) {
      // An unusable attempt history blocks every notify Lead visibly until
      // the file is repaired — never reset, never overwritten.
      if (reserved.reason.startsWith("delivery-store-")) {
        routeReasons.set(item.leadId, `notify-${reserved.reason}`);
        diag(reserved.reason);
      }
      setDelivery(item, "blocked", recipient, reserved.reason, still);
      return;
    }
    setDelivery(item, "reserved", recipient, null, still);
    persistRing();
    try {
      await bounded(paseo.agents.ref(recipient).send(prompt, { messageId: alertMessageId(key) }), signal);
      deliveries.settle(key, "accepted", null);
      setDelivery(item, "accepted", recipient, null, still);
    } catch (error) {
      // Delivery unknown — a timeout or lost reply can follow a landed
      // prompt. Intentionally no retry; the store keeps the attempt.
      const reason = signal.aborted ? "stopped-during-send" : (error as Error).message === "sdk-timeout" ? "send-timeout" : "send-failed";
      deliveries.settle(key, "uncertain", reason);
      setDelivery(item, "uncertain", recipient, reason, still);
    }
  }

  function deferDelivery(item: Case, recipient: string, reason: string, axes: FindingAxis[]): void {
    item.deferCount += 1;
    const wait = Math.min(DEFER_RETRY_MAX_MS, deferMin * 2 ** Math.min(item.deferCount - 1, 10));
    item.retryAt = now() + wait;
    setDelivery(item, "deferred", recipient, reason, axes);
  }

  /** One pass over open cases: dispatch eligible findings on notify routes
   *  (one attempt per finding and recipient), then apply closure rules. */
  async function dispatchPass(): Promise<void> {
    for (const item of [...cases.values()]) {
      if (signal.aborted) return;
      if (!cases.has(item.id)) continue;
      // An archive boundary closes the case through its queued job — never
      // deliver about a tombstoned seat.
      if (tombstoned(item.leadId) || tombstoned(item.peerId)) continue;
      const route = routeFor(item.leadId);
      if (route === null) { closeCase(item, "unknown", unroutedReason(item.leadId)); continue; }
      item.route = { source: route.source, mode: route.mode };
      // A recipient that was blocked stays blocked for this case until the
      // route names a different one — no refresh loop on an unusable seat.
      const blocked = item.delivery?.state === "blocked" && item.delivery.recipient === route.supervisorAgentId;
      if (route.mode === "notify" && route.supervisorAgentId !== null && !blocked &&
          (item.retryAt === null || item.retryAt <= now()) && observeGate().ok) {
        const axes = eligibleFindings(item, route.supervisorAgentId);
        if (axes.length > 0) await dispatch(item, route, route.supervisorAgentId, axes);
      }
      if (cases.has(item.id) && item.axes !== null) settle(item);
    }
    persistRing();
  }

  async function drain(): Promise<void> {
    try {
      while (jobs.length && !signal.aborted) {
        while (jobs.length && !signal.aborted) {
          const job = jobs.shift();
          if (job) await apply(job);
        }
        // Assess immediately when a case is new or its evidence changed —
        // the pending delay is a checkpoint, not a wait.
        const pre = version;
        for (const item of cases.values()) {
          if (signal.aborted || pre !== version) break;
          if (!item.dirty) continue;
          await evaluateCase(item);
        }
        if (!signal.aborted && pre === version) await dispatchPass();
      }
    } finally {
      running = false;
      sweepRetention();
      persistRing();
      schedule();
    }
  }

  function schedule(): void {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (signal.aborted) return;
    const times: number[] = [];
    for (const item of cases.values()) {
      if (!item.timerUsed) times.push(item.due);
      if (item.retryAt !== null && item.delivery?.state === "deferred") times.push(item.retryAt);
      times.push(item.expiresAt);
    }
    const next = Math.min(...times);
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => {
      timer = undefined;
      enqueue({ t: "tick", order: ++order, leadId: null });
    }, Math.max(0, next - now()));
  }

  // --- surface ---------------------------------------------------------------

  /** get-supervision extras for the served home — metadata only. Gates list
   *  explicit active routes and discovered Leads following defaults. An
   *  explicit route whose Lead has no host evidence yet reads
   *  lead-not-seen-yet; one seen in another workspace reads
   *  lead-workspace-mismatch (both observe nothing — effectiveRoute). */
  function shadow(targetStableRoot: string) {
    if (targetStableRoot !== stableRoot) return null;
    const entries = [...loadRing().values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const gates: Record<string, string | null> = {};
    // A view that observes a down edge is a detection point like any
    // other — the funnel runs the same global purge.
    const gate = observeGate();
    const config = readConfig();
    const leads = new Set<string>([
      ...(config?.routes.filter(route => route.mode !== "off").map(route => route.leadAgentId) ?? []),
      ...[...knownLeads.keys()].filter(id => routeFor(id) !== null),
    ]);
    for (const leadId of leads) {
      const explicit = explicitRoute(config, leadId);
      const known = knownLeads.get(leadId);
      const pending = explicit === undefined || tombstoned(leadId) ? null
        : known === undefined ? "lead-not-seen-yet"
        : known.workspaceId !== explicit.leadWorkspaceId ? "lead-workspace-mismatch"
        : null;
      // A down Jev gate is the daemon-wide cause and outranks per-Lead waiting.
      gates[leadId] = routeReasons.get(leadId) ?? (gate.ok ? pending : gate.reason);
    }
    return {
      observations: entries,
      gates,
      diagnostics: { droppedEvents: diagnostics.droppedEvents, reasons: [...diagnostics.reasons] },
    };
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    abort.abort();
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    jobs.length = 0;
    // Wait for an in-flight drain to detach (bounded awaits reject on abort).
    while (running) await new Promise(resolve => setTimeout(resolve, 10));
    cases.clear();
    peers.clear();
    knownLeads.clear();
    enqPending.clear();
    archivedNow.clear();
    leadStarts.clear();
    startMeta.clear();
    openTurns.clear();
    persistRing();
  }

  /** Test/diagnostic seam: resolves when the queue is applied and no drain
   *  is running. Not part of the lifecycle surface. */
  async function idle(): Promise<void> {
    while (running || jobs.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  /** Test/diagnostic seam — count of non-empty body fields one open case
   *  still retains (brief, handback, lane prompts). Count only, never
   *  content, so the privacy invariant "gate-down empties retained bodies
   *  at detection" stays assertable without exposing bodies. */
  function retainedBodies(fingerprint: string): number | null {
    const item = cases.get(fingerprint);
    if (item === undefined) return null;
    let n = 0;
    if (item.evidence.brief !== null && item.evidence.brief.text !== "") n += 1;
    if (item.evidence.handback !== null && item.evidence.handback.text !== "") n += 1;
    for (const lane of [
      item.evidence.roomMessages, item.evidence.uncertainRoomMessages,
      item.evidence.otherRoomMessages, item.evidence.reportMessages, item.evidence.peerSends,
    ]) {
      for (const message of lane) if (message.prompt !== "") n += 1;
    }
    return n;
  }

  /** Test/diagnostic seam — sizes of every retained structure (counts only). */
  function retentionSizes() {
    return {
      cases: cases.size, seen: seen.size, sentCalls: sentCalls.size, peers: peers.size,
      knownLeads: knownLeads.size, archiveGen: archiveGen.size, archivedNow: archivedNow.size,
      leadStarts: leadStarts.size, startMeta: startMeta.size, openTurns: openTurns.size,
      routeReasons: routeReasons.size, enqPending: enqPending.size,
      ring: ring?.size ?? 0, deliveries: deliveries.size(),
    };
  }

  return { onCreated, onArchived, onStart, onTurn, shadow, stop, idle, retainedBodies, retentionSizes, signal };
}

export type SupervisionObserver = ReturnType<typeof createSupervisionObserver>;
