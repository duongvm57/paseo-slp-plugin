// plugin/server/desk-bridge.ts — P2-d desk MCP bridge adapter.
//
// The plugin-side half of the seat↔desk transport: one Unix-domain socket
// under the verified stable root, one lifecycle lock in the reserved repo
// namespace, and the agent.create graft that hands managed seats their
// stdio MCP server (bin/slp-desk-mcp.mjs). UDS only — no TCP path exists;
// Windows is a typed CAPABILITY_GAP, not a fake adapter.
//
// Trust model (contract §4): the ONLY caller-supplied identity is the
// minted desk handle in the connection hello. The adapter resolves the
// membership row server-side (handle sha → ledger row → agentId); role and
// cwd claims from the bridge are never trusted. Every dispatch re-validates
// the full guard chain — envelope, catalog, fresh membership row, epoch,
// live SDK identity, capability row, strict input, desk state — and fails
// closed with the typed DeskErrorCode vocabulary.
//
// Lifecycle: contribute() calls start(); cleanup calls stop(). The lock is
// O_EXCL under repos/<reserved>/lock carrying {pid, instanceNonce,
// startedAt}; a live foreign holder is never stolen from — bounded wait,
// then a typed desk-busy gap. A proven-dead bridge instance is reclaimed
// through the serialized, audited recovery seam; identity doubt remains
// RECOVERY_REQUIRED. Repository locks retain operator-only recovery.
// stop() closes connections, closes the server,
// unlinks the socket and releases the lock — in that order.

import { z } from "zod";
import { createServer, type Server, type Socket } from "node:net";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import {
  LEDGER_LIMITS,
  REPO_KEY_PATTERN,
  createDeskStore,
  deskBridgePaths,
  deskRepoPaths,
  deskReposDir,
  type DeskStore,
  type DeskStoreRead,
  type MembershipValue,
} from "./desk-store.ts";
import { assertRealComponents, ensurePrivateDirectory } from "./kept-files.ts";
import { classifyLockHolderProcess, parseLockHolder, readProcessIdentity, type LockHolder, type LockHolderProcess } from "./runtime/lock-holder.ts";
import { recoverDeskLockAsync } from "./runtime/desk-recovery.ts";
import { detectDaemonHome } from "./daemon-home.ts";
import { sha256Hex } from "./config-view.ts";
import type { Journal } from "./journal.ts";
import type { LauncherBuilder } from "../shared/contracts.ts";
import { MAX_RPC_BYTES } from "../shared/contracts.ts";
import {
  DESK_BRIDGE_PROTOCOL,
  DeskAssignmentAcceptInput,
  DeskAssignmentAmendInput,
  DeskAssignmentAttachInput,
  DeskAssignmentCloseInput,
  DeskAssignmentOfferInput,
  DeskAssignmentRegisterInput,
  DeskBridgeAck,
  DeskBridgeFrameError,
  DeskBridgeHello,
  DeskBridgeToolCall,
  DeskBridgeToolEntry,
  DeskCheckDeclareInput,
  DeskCheckRunInput,
  DeskDecisionAppendInput,
  DeskErrorCode as DeskErrorCodeSchema,
  DeskHandbackSubmitInput,
  DeskWorkflowGetInput,
  DeskRolloutDeclareInput,
  DeskRolloutTransitionInput,
  DeskScopeDeclareInput,
  DeskScopeReviewInput,
  DeskScopeTransitionInput,
  DeskSeatStatus,
  DeskSettlementExportInput,
  DeskSettlementRecordInput,
  DeskTaskDefineInput,
  DeskTaskDispatchInput,
  DeskTaskResultInput,
  DeskTaskRuleInput,
  DeskTaskHoldInput,
  DeskTaskStopInput,
  DeskTaskAcknowledgeInput,
  DeskTaskReconcileInput,
  DeskTaskIntegrateInput,
  DeskTaskRecapInput,
  DeskTaskRecapResult,
  WIRE_LIMITS,
  type DeskRejectionValue,
  type DeskSeatStatusValue,
  type DeskTaskCommandInputValue,
} from "../shared/enforcement.ts";
import { auditCapabilities, CAPABILITY_IDS } from "./capabilities.ts";
import { canReadDeskWorkflow, projectDeskWorkflow, runAssignmentAmend, runDecisionAppend } from "./desk-assignment.ts";
import { runAssignmentAccept, runAssignmentOffer } from "./desk-ownership.ts";
import { runTaskCommand } from "./desk-task.ts";
import { createTaskServices } from "./desk-task-services.ts";
import { createTaskHostEventObserver, createTaskObserver, runTaskDispatch, runTaskIntegration, runTaskReconciliation } from "./desk-task-execution.ts";
import type { TaskExecutionDeps, TaskTurnEndedEvent } from "./desk-task-execution.ts";
import type { TaskHostApi } from "./desk-task-execution-host.ts";
import type { TaskRuntimeApi } from "./desk-task-runtime.ts";
import { buildTaskRecap } from "./runtime/handoff-recap.ts";
import { DeskSeatCreateInput, DeskOperationGetInput, DeskTaskDeliverInput, DeskTaskGetInput } from "../shared/delegation.ts";
import { createFormationPlanner, runSeatCreate } from "./desk-formation.ts";
import { createDeskOperations } from "./desk-operation.ts";
import { projectTaskCurrent, runTaskDeliver } from "./desk-delivery.ts";
import { isRejection } from "./desk-runner.ts";
import {
  captureSeatSnapshot,
  runAssignmentAttach,
  runAssignmentClose,
  runAssignmentRegister,
  runHandbackSubmit,
  seatAssignmentsView,
  type HandbackRunnerDeps,
  type ObservedCaptureValue,
} from "./desk-handback.ts";
import {
  runSettlementExport,
  runSettlementRecord,
  seatSettlementsView,
  type ExportVerifier,
  type SettlementRunnerDeps,
} from "./desk-settlement.ts";
import {
  runScopeDeclare,
  runScopeReview,
  runScopeTransition,
  seatScopesView,
} from "./desk-scope.ts";
import {
  runCheckDeclare,
  runCheckRun,
  type CheckRunnerDeps,
} from "./desk-check-runner.ts";
import {
  runRolloutDeclare,
  runRolloutTransition,
  seatRolloutsView,
} from "./desk-rollout.ts";

type AgentCreateRequest = PluginBeforeRequests["agent.create"];
type SessionOpenRequest = PluginBeforeRequests["agent.session_open"];

const REQUEST_CAP = WIRE_LIMITS.deskBridgeRequestBytes;
const RESPONSE_CAP = WIRE_LIMITS.deskBridgeResponseBytes;
const MAX_CONNECTIONS = 64;
const HANDSHAKE_BUDGET_MS = 10000;
const IDENTITY_BUDGET_MS = 8000;
const REPO_SCAN_LIMIT = 64;
const LOCK_POLL_MS = 50;
const BRIDGE_FILE = join("bin", "slp-desk-mcp.mjs");
const HIDDEN_TOOL = "slp_desk_internal";
const STATUS_TOOL = "slp_status";
const HANDBACK_SUBMIT_TOOL = "slp_handback_submit";
const ASSIGNMENT_REGISTER_TOOL = "slp_assignment_register";
const ASSIGNMENT_ATTACH_TOOL = "slp_assignment_attach";
const ASSIGNMENT_CLOSE_TOOL = "slp_assignment_close";
const ASSIGNMENT_AMEND_TOOL = "slp_assignment_amend";
const DECISION_APPEND_TOOL = "slp_decision_append";
const WORKFLOW_GET_TOOL = "slp_workflow_get";
const SETTLEMENT_RECORD_TOOL = "slp_settlement_record";
const SETTLEMENT_EXPORT_TOOL = "slp_settlement_export";
const SCOPE_DECLARE_TOOL = "slp_scope_declare";
const SCOPE_TRANSITION_TOOL = "slp_scope_transition";
const SCOPE_REVIEW_TOOL = "slp_scope_review";
const CHECK_DECLARE_TOOL = "slp_check_declare";
const CHECK_RUN_TOOL = "slp_check_run";
const ROLLOUT_DECLARE_TOOL = "slp_rollout_declare";
const ROLLOUT_TRANSITION_TOOL = "slp_rollout_transition";
const ASSIGNMENT_OFFER_TOOL = "slp_assignment_offer";
const ASSIGNMENT_ACCEPT_TOOL = "slp_assignment_accept";
const TASK_DEFINE_TOOL = "slp_task_define";
const TASK_DISPATCH_TOOL = "slp_task_dispatch";
const TASK_RESULT_TOOL = "slp_task_result";
const TASK_RULE_TOOL = "slp_task_rule";
const TASK_HOLD_TOOL = "slp_task_hold";
const TASK_STOP_TOOL = "slp_task_stop";
const TASK_ACKNOWLEDGE_TOOL = "slp_task_acknowledge";
const TASK_RECONCILE_TOOL = "slp_task_reconcile";
const TASK_INTEGRATE_TOOL = "slp_task_integrate";
const TASK_RECAP_TOOL = "slp_task_recap";

/** The bridge's own limitation literals — the seat-facing read view's
 *  bounded flag strings (kept in one table, same discipline as
 *  limitations.ts; that table is owned by P2-e and not extended here). */
const BRIDGE_LIMITATIONS = {
  deskRecoveryRequired:
    "desk lock orphaned or unreadable — operator recovery required before desk mutations",
  deskDegraded: "desk ledger is not readable — seat view is best-effort",
  assignmentsWithheld: "assignments view withheld — the desk ledger cannot be read",
} as const;

/** The desk tool catalog's wire contract — metadata lives at module level so
 *  the whole catalog (visible and hidden rows) is enumerable for cap checks.
 *  createDeskBridge binds each row's input schema and run implementation; a
 *  row that fails DeskBridgeToolEntry is a producer bug, never an emitted
 *  tool. */
export const DESK_TOOL_CATALOG = [
  {
    name: STATUS_TOOL,
    visible: true,
    mutation: false,
    description: "Seat-facing desk status: this seat's own membership view plus desk availability.",
  },
  {
    name: HANDBACK_SUBMIT_TOOL,
    visible: true,
    mutation: true,
    description:
      "Submit a structured handback record (v1, kind handback) against an assignment this seat is bound to. " +
      "Input: {requestId, assignmentId, recordV1, candidateId|null}. " +
      "Response: {ok, revision, receiptId, gaps, handbackId, observedCandidateId}.",
  },
  {
    name: ASSIGNMENT_REGISTER_TOOL,
    visible: true,
    mutation: true,
    description:
      "Lead-only: register a durable assignment binding on this desk. " +
      "Input: {requestId, authorityRef, objective|null}. authorityRef is stored verbatim as a pointer to the grant — never dereferenced. " +
      "Response: {ok, receiptId, assignmentId, state}.",
  },
  {
    name: ASSIGNMENT_ATTACH_TOOL,
    visible: true,
    mutation: true,
    description:
      "Lead owner only: bind a live seat to an open assignment. " +
      "Input: {requestId, assignmentId, agentId}. Idempotent on an already-bound seat. " +
      "Response: {ok, receiptId, assignmentId, seat}.",
  },
  {
    name: ASSIGNMENT_CLOSE_TOOL,
    visible: true,
    mutation: true,
    description:
      "Lead owner only: close an assignment; submissions against a closed assignment reject. " +
      "Input: {requestId, assignmentId}. Response: {ok, receiptId, assignmentId, state}.",
  },
  {
    name: ASSIGNMENT_AMEND_TOOL,
    visible: true,
    mutation: true,
    description: "Chủ assignment: thêm brief theo revision CAS. Input: {requestId, assignmentId, expectedBriefRevision, brief, changeReason, authorityRef, affectedOwners}. Pointer chỉ là claim.",
  },
  {
    name: DECISION_APPEND_TOOL,
    visible: true,
    mutation: true,
    description: "Chủ assignment: ghi quyết định material bất biến theo brief CAS. Input: {requestId, assignmentId, expectedBriefRevision, authorityRef, decision}. Refs chỉ là claim.",
  },
  {
    name: WORKFLOW_GET_TOOL,
    visible: true,
    mutation: false,
    description: "Đọc workflow theo trang: chủ hoặc seat đang gắn với membership hiện hành. Input: {assignmentId, section, expectedLedgerRevision, expectedBriefRevision, cursor, limit}. Không mở refs.",
  },
  {
    name: SETTLEMENT_RECORD_TOOL,
    visible: true,
    mutation: true,
    description:
      "Receiving-owner only: record an immutable settlement mirror revision for a bound seat. " +
      "Input: {requestId, assignmentId, seatAgentId, seatTitle, at, pointers, refs, resources, timeline}. " +
      "Response: {ok, settlementId, revision, receiptId, status, gaps}.",
  },
  {
    name: SETTLEMENT_EXPORT_TOOL,
    visible: true,
    mutation: false,
    description:
      "Owner or settled seat: re-derive the committed revision's v1 slp-record for manual sink placement. " +
      "Input: {settlementId}. Read-only, no side effects.",
  },
  {
    name: SCOPE_DECLARE_TOOL,
    visible: true,
    mutation: true,
    description: "Chủ assignment: khai báo scope bất biến, ownership và review plan tùy chọn. Input có expectedBriefRevision; refs authority là claim.",
  },
  {
    name: SCOPE_TRANSITION_TOOL,
    visible: true,
    mutation: true,
    description: "Chủ assignment: chuyển state scope sau khi pin declaration và brief revision hiện hành; submit-for-review pin candidate.",
  },
  {
    name: SCOPE_REVIEW_TOOL,
    visible: true,
    mutation: true,
    description: "Reviewer seat độc lập: ghi axis legacy hoặc named lens theo scope, brief, mandate và candidate pin; refs chỉ là claim.",
  },
  {
    name: CHECK_DECLARE_TOOL,
    visible: true,
    mutation: true,
    description:
      "Owner/lead only: declare an allowlisted check definition on an assignment scope (P5). " +
      "Input: {requestId, assignmentId, scopeId, checkId, checkClass, label, definitionSha256, limits, requiredEvidence, refs}. " +
      "Response: {ok, checkId, revision, receiptId}.",
  },
  {
    name: CHECK_RUN_TOOL,
    visible: true,
    mutation: true,
    description:
      "Owner/lead only: run an allowlisted check on the rollout's pinned candidate (P5). " +
      "Input: {requestId, assignmentId, rolloutId, checkId, definitionRevision, evidenceRef|null}. " +
      "Response: {ok, runId, status, attempt, receiptId}.",
  },
  {
    name: ROLLOUT_DECLARE_TOOL,
    visible: true,
    mutation: true,
    description:
      "Owner/lead only: declare a rollout pinned to scope + candidate (P5). " +
      "Input: {requestId, assignmentId, scopeId, rolloutId, label, declarationSha256, candidateSnapshot, candidateHead, requiredChecks, refs}. " +
      "Response: {ok, rolloutId, revision, receiptId}.",
  },
  {
    name: ROLLOUT_TRANSITION_TOOL,
    visible: true,
    mutation: true,
    description:
      "Owner/lead only: one explicit move along the shared rollout machine (P5). " +
      "Input: {requestId, assignmentId, rolloutId, transition, rolloutRevision, targetSnapshot, evidenceRefs}. " +
      "Response: {ok, transitionId, state, receiptId, dischargedChecks}.",
  },
  {
    name: ASSIGNMENT_OFFER_TOOL,
    visible: true,
    mutation: true,
    description:
      "Owner only: nominate an exact live lead for succession (no authority transfer). " +
      "{requestId, assignmentId, expectedOwnershipRevision, targetAgentId, targetMembershipId, authorityRef, contextRef} " +
      "→ {ok, offerId, ownershipRevision}.",
  },
  {
    name: ASSIGNMENT_ACCEPT_TOOL,
    visible: true,
    mutation: true,
    description:
      "Exact nominee only: take custody; prior liveness is no mutex. " +
      "{requestId, assignmentId, offerId, expectedOwnershipRevision, expectedLedgerRevision, expectedBriefRevision, acknowledgment, settlementRef, resources} " +
      "→ {ok, acceptId, ownershipRevision, gaps}.",
  },
  {
    name: TASK_DEFINE_TOOL,
    visible: true,
    mutation: true,
    description: "Define or amend an outcome task with dependency, scope, proof and effect-grant pins. Current owner only; a declaration does not launch a worker.",
  },
  {
    name: TASK_DISPATCH_TOOL,
    visible: true,
    mutation: true,
    description: "Current owner: perform one supervised bootstrap, reuse, send or archive phase. Reservation and exact registered membership precede work; uncertain effects require reconciliation.",
  },
  {
    name: TASK_RESULT_TOOL,
    visible: true,
    mutation: true,
    description: "Record a bound attempt result and supplied evidence. Capture, check completion and a handback do not establish an accepted task result.",
  },
  {
    name: TASK_RULE_TOOL,
    visible: true,
    mutation: true,
    description: "Current owner: adjudicate the exact task/result revisions with reasons and evidence. A usable ruling remains qualified only while its dependency, review and proof pins stand.",
  },
  {
    name: TASK_HOLD_TOOL,
    visible: true,
    mutation: true,
    description: "Raise a bounded task question or hold; current-owner rulings release or retain obligations. Brief changes never silently release a hold.",
  },
  {
    name: TASK_STOP_TOOL,
    visible: true,
    mutation: true,
    description: "Current owner: durably stop further task effect issuance. In-flight work and resources remain obligations; this tool does not cancel a host turn.",
  },
  {
    name: TASK_ACKNOWLEDGE_TOOL,
    visible: true,
    mutation: true,
    description: "Exact recipient: acknowledge a recorded delivery obligation. Host acceptance, responsibility acknowledgment, handling and resource settlement are distinct.",
  },
  {
    name: TASK_RECONCILE_TOOL,
    visible: true,
    mutation: true,
    description: "Current owner: observe known attempts, effects and resources without retrying an uncertain effect. Missing or negative evidence never proves absence.",
  },
  {
    name: TASK_INTEGRATE_TOOL,
    visible: true,
    mutation: true,
    description: "Current owner: stage, check, land, reconcile or discharge a pinned result under its integration grant. Three-way checks preserve target work; cleanup requires separate admission.",
  },
  {
    name: TASK_RECAP_TOOL,
    visible: true,
    mutation: false,
    description: "Read a bounded task recap from the same authorized, revision-pinned workflow projection. Omissions and unresolved obligations remain visible; a recap grants no authority.",
  },
  { name: "slp_seat_create", visible: true, mutation: true,
    description: "Form a Lead (saved profile) or Lean Peer (pool pins). Derives parent/workspace, creates without work, observes, then returns the exact prompt for the caller's send_agent_prompt notifyOnFinish=true (delivery=caller, default) or sends it (delivery=server)" },
  { name: "slp_operation_get", visible: true, mutation: false,
    description: "Read this caller's exact formation/delivery operation receipt and partial phases by original requestId. Read-only; missing evidence never authorizes resubmission." },
  { name: "slp_task_deliver", visible: true, mutation: true,
    description: "Current Lead owner: declare one new bounded task, bootstrap a fresh Peer and send using current derived pins. Partial outcomes remain retained; no scheduler, retry or result acceptance." },
  { name: "slp_task_get", visible: true, mutation: false,
    description: "Read one authorized task and optional exact attempt with current identity, CAS pins, readiness and compact effect/resource markers. No unrelated assignment history pages." },
  {
    name: HIDDEN_TOOL,
    visible: false,
    mutation: false,
    description: "Internal mechanism entry — exists to prove hidden-catalog dispatch rejection.",
  },
] as const;

/** The SDK surface the dispatch guards need — a structural subset of
 *  PaseoApi (same narrowing convention as supervision/state.ts): tests
 *  double it without the daemon and the plugin bundle keeps no runtime
 *  @getpaseo/client dependency. */
type PaseoLike = {
  agents: {
    ref(id: string): {
      refresh(): Promise<{
        agent: {
          provider?: unknown;
          workspaceId?: unknown;
          archivedAt?: unknown;
        } | null;
      } | null>;
    };
  };
};

type DeskErrorCode = DeskRejectionValue["code"];

export interface DeskBridgeDeps {
  /** Durable receipt read — the binding/launch-set provenance chain. */
  journal: Pick<Journal, "read">;
  /** Launch-set verify — the launch-manifest → daemonHome provenance seam. */
  launchers: Pick<LauncherBuilder, "verify">;
  /** The embedded payload — its `bin/slp-desk-mcp.mjs` entry is the
   *  graft-time and handshake integrity oracle (same sha verifyPublished
   *  enforces). */
  payload: { files: { path: string; sha256: string }[] };
  /** Served-home detection — real env/default probe by default. */
  detectDaemonHome?: () => { daemonHome: string; source: "env" | "default" };
  realpath?: (path: string) => string;
  /** Store factory — tests substitute a store on a fixture root. */
  createStore?: (stableRoot: string) => DeskStore;
  audit?: typeof auditCapabilities;
  /** The connected-SDK slot — hook/RPC contexts fill it via notePaseo. */
  paseoRef: { current: PaseoLike | null };
  /** The actual connected task SDK, supplied by hook/RPC contexts. */
  taskHost?: () => (TaskHostApi & TaskRuntimeApi) | null;
  platform?: string;
  now?: () => Date;
  uuid?: () => string;
  kill?: (pid: number, signal?: number) => void;
  /** Kernel boot/start identity; null means this host cannot prove reuse. */
  processIdentity?: (pid: number) => string | null;
  warn?: (line: string) => void;
  /** P3-a observed capture — tests substitute a deterministic double; the
   *  default spawns the bound runtime's snapshot under 60s/32MiB. */
  capture?: (deps: {
    nodePath: string;
    runtimePath: string;
    repository: string;
    now: () => Date;
  }) => Promise<ObservedCaptureValue>;
  /** P3-b transcript-export artifact seam — tests substitute a structural
   *  double; the default resolves the claim under the durable repo
   *  binding's worktree root and proves existence + sha256/bytes. */
  verifyExport?: ExportVerifier;
  /** P5 check-runner seams — tests substitute deterministic doubles; the
   *  defaults spawn fixed-argv bounded children under the definition's
   *  limits and probe the host's real capabilities. */
  checkExec?: CheckRunnerDeps["exec"];
  checkProbe?: CheckRunnerDeps["probe"];
  checkEnvironment?: CheckRunnerDeps["environment"];
}

export type DeskBridgeState =
  | { kind: "starting" }
  | { kind: "listening"; socketPath: string }
  | { kind: "unavailable"; code: DeskErrorCode; reason: string };

type BoundSeat = {
  repoKey: string;
  handleSha256: string;
  membershipId: string;
  agentId: string;
  openGeneration: number;
  /** The handshake-resolved membership row — the only honest snapshot the
   *  status tool can still answer from when the ledger itself stops
   *  reading. Never written back; never a substitute for a live row on any
   *  other tool. */
  row: SeatRow;
};

type SeatRow = MembershipValue;

type Availability = "available" | "recovery-required" | "degraded";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The wire schema caps the limitations array itself — an aggregate that
 *  would exceed the cap sheds trailing entries into one counting marker so
 *  a saturated view stays schema-valid instead of failing the reply. */
const boundLimitations = (entries: string[], cap: number): string[] =>
  entries.length <= cap
    ? entries
    : [...entries.slice(0, cap - 1), `${entries.length - (cap - 1)} more limitation(s) elided`];

const rejection = (code: DeskErrorCode, message: string, recovery: string): DeskRejectionValue => ({
  ok: false,
  code,
  message,
  recovery,
});

/** MCP protocol version echoed when the caller declares none. */
const MCP_PROTOCOL_FALLBACK = "2024-11-05";

/** The production artifact seam for settlement transcript exports (P3-b
 *  R1). The allowed evidence domain is the bound repository's worktree —
 *  `realpath(dirname(repo.gitCommonDir))`, derived server-side from the
 *  durable repo binding, never from the caller's claim. An artifact must
 *  resolve strictly inside that root and match the claimed sha256/bytes
 *  before it can ground `completed`; `absent`/`outside-root`/`mismatch`
 *  disprove the claim, `unavailable` means the seam itself could not
 *  prove anything. */
function makeExportVerifier(realpath: (path: string) => string): ExportVerifier {
  return async (claim, repo) => {
    let root: string;
    try {
      root = dirname(realpath(repo.gitCommonDir));
    } catch {
      return { status: "unavailable", detail: "repository-worktree-root-unresolvable" };
    }
    let candidate: string;
    try {
      candidate = realpath(resolve(root, claim.path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR"
        ? { status: "absent", detail: null }
        : { status: "unavailable", detail: `export-path-unresolvable:${code ?? "error"}` };
    }
    const rel = relative(root, candidate);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return { status: "outside-root", detail: null };
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR"
        ? { status: "absent", detail: null }
        : { status: "unavailable", detail: `export-read-failed:${code ?? "error"}` };
    }
    if (bytes.length !== claim.bytes || sha256Hex(bytes) !== claim.sha256) {
      return { status: "mismatch", detail: null };
    }
    return { status: "verified", detail: null };
  };
}

export function createDeskBridge(deps: DeskBridgeDeps) {
  const platform = deps.platform ?? process.platform;
  const uuid = deps.uuid ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 0));
  const detectHome = deps.detectDaemonHome ?? detectDaemonHome;
  const realpath = deps.realpath ?? realpathSync;
  const createStore = deps.createStore ?? (stableRoot => createDeskStore({ stableRoot }));
  const audit = deps.audit ?? auditCapabilities;
  const capture = deps.capture ?? captureSeatSnapshot;
  const verifyExport = deps.verifyExport ?? makeExportVerifier(realpath);
  const instanceNonce = uuid();
  /** The connected-SDK slot — every hook/handler context that reaches the
   *  plugin stashes it here so dispatch guards can verify live identity
   *  even on resumed sessions where no create ran this process lifetime.
   *  E-P2D-4: a stash is hook evidence only — it never proves an RPC
   *  dispatch reached this plugin. */
  const stashPaseo = (paseo: PaseoLike | null | undefined): void => {
    if (paseo !== null && paseo !== undefined) deps.paseoRef.current = paseo;
  };
  /** E-P2D-4 — plugin-RPC dispatch evidence: set ONLY by `noteDispatch`,
   *  which a real daemon→plugin RPC handler invokes. Hook contexts (stash
   *  above) never flip this — `plugin-rpc.dispatch` stays `unknown` until a
   *  genuine dispatch lands. */
  let rpcDispatched = false;
  const noteDispatch = (paseo: PaseoLike | null | undefined): void => {
    rpcDispatched = true;
    stashPaseo(paseo);
  };
  // One bounded warn per key — diagnostics never repeat.
  const warned = new Set<string>();
  const warn = (key: string, line: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    (deps.warn ?? console.warn)(line.slice(0, 400));
  };

  let state: DeskBridgeState = { kind: "starting" };
  let stableRoot: string | null = null;
  let paths: ReturnType<typeof deskBridgePaths> | null = null;
  let binding: {
    bindingSha256: string;
    runtimePath: string;
    nodePath: string;
    candidateSha256: string;
    payloadSha256: string;
    launchSetSha256: string;
    launchManifestSha256: string;
    /** The launch-set manifest's bridge pin — the P2-b amend seam records
     *  it; undefined means the bound candidate predates the bridge and no
     *  graft/hello may proceed (fail closed). */
    bridgeSha256: string | undefined;
  } | null = null;
  let store: DeskStore | null = null;
  let server: Server | null = null;
  let lockHeld = false;
  let socketOwned = false;
  let stopped = false;
  const connections = new Set<Socket>();

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  /** Strict UTF-8 frame decode: malformed byte sequences become null instead
   *  of silently decoding to U+FFFD — a substituted frame must never be
   *  parsed and relayed as if it were the sender's bytes (E-P2D-1). */
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const decodeFrame = (line: Buffer): string | null => {
    try {
      return utf8.decode(line);
    } catch {
      return null;
    }
  };

  const pidAlive = (pid: number): boolean => classifyLockHolderProcess(pid, kill) === "alive";
  const processIdentity = deps.processIdentity ?? readProcessIdentity;
  const holderProcess = (holder: LockHolder): LockHolderProcess => {
    const status = classifyLockHolderProcess(holder.pid, kill);
    if (status !== "alive" || holder.processIdentity === undefined) return status;
    let identity: string | null;
    try { identity = processIdentity(holder.pid); } catch { return "undetermined"; }
    if (identity === null) return "undetermined";
    return identity === holder.processIdentity ? "alive" : "esrch";
  };

  // ---------------------------------------------------------------------
  // stable-root provenance (D7) — receipt → verified launch set → the
  // manifest's own ancestry. Never a blind default: an unreadable or
  // binding-less receipt leaves the bridge inert.
  // ---------------------------------------------------------------------

  async function resolveStableRoot(): Promise<{
    stableRoot: string;
    binding: NonNullable<typeof binding>;
  }> {
    const home = realpath(detectHome().daemonHome);
    const provisional = join(home, "slp-runtime");
    const receipt = deps.journal.read(provisional);
    if (receipt === null || receipt.binding === null) {
      throw rejection(
        "CAPABILITY_GAP",
        "no active SLP binding under the detected daemon home — desk bridge stays inert",
        "activate the manager for this home; a binding-less home has no desk to serve",
      );
    }
    // The verified launch set proves <daemonHome>/slp-runtime/launchers/<sha>
    // ancestry — its manifest.daemonHome must equal the real directory
    // ancestry, so the stable root we serve is the one activation pinned
    // (contract §5: this proof path is independent of PASEO_HOME).
    const launchSet = await deps.launchers.verify(
      join(provisional, "launchers", receipt.binding.launchSetSha256),
    );
    const stableRoot = dirname(dirname(launchSet.directory));
    // Receipt vs verified manifest: the binding's recorded runtimePath must
    // be the candidate directory the launch set itself verified — a
    // divergence is integrity drift, never a path to follow.
    const bound = receipt.binding;
    if (bound.runtimePath !== join(stableRoot, bound.candidateSha256)) {
      throw rejection(
        "CANDIDATE_DRIFT",
        "the binding's runtimePath diverges from the verified launch set's candidate root",
        "inspect the install receipt and launch set; the bridge never follows an unverified path",
      );
    }
    return {
      stableRoot,
      binding: {
        bindingSha256: bound.bindingSha256,
        runtimePath: bound.runtimePath,
        nodePath: bound.node.path,
        candidateSha256: bound.candidateSha256,
        payloadSha256: bound.payloadSha256,
        launchSetSha256: bound.launchSetSha256,
        launchManifestSha256: bound.launchManifestSha256,
        bridgeSha256: launchSet.bridgeSha256,
      },
    };
  }

  // ---------------------------------------------------------------------
  // lifecycle lock — O_EXCL under the reserved repo namespace
  // ---------------------------------------------------------------------

  async function acquireLock(lockPath: string): Promise<
    | { ok: true }
    | { ok: false; code: DeskErrorCode; reason: string }
  > {
    const deadline = Date.now() + LEDGER_LIMITS.lockWaitMs;
    for (;;) {
      let fd: number | null = null;
      try {
        const selfIdentity = processIdentity(process.pid);
        fd = openSync(lockPath, "wx", 0o600);
        writeSync(
          fd,
          JSON.stringify({ pid: process.pid, instanceNonce, startedAt: now().toISOString(),
            ...(selfIdentity !== null ? { processIdentity: selfIdentity } : {}) }) + "\n",
        );
        fsyncSync(fd);
        lockHeld = true;
        return { ok: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return {
            ok: false,
            code: "CAPABILITY_GAP",
            reason: `bridge lock cannot be created: ${(error as Error).message}`,
          };
        }
      } finally {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* already closed */ }
        }
      }
      let holder: LockHolder | null = null;
      try {
        holder = parseLockHolder(readFileSync(lockPath));
      } catch {
        return { ok: false, code: "RECOVERY_REQUIRED", reason: "bridge lock is unreadable" };
      }
      if (holder !== null && holder.pid === process.pid && holder.instanceNonce === instanceNonce) {
        // Re-entry by THIS instance — adopt rather than steal. A live pid
        // with a different nonce is a stacked holder: bounded wait below.
        lockHeld = true;
        return { ok: true };
      }
      if (holder === null) {
        return {
          ok: false,
          code: "RECOVERY_REQUIRED",
          reason: "bridge lock holder record is malformed — operator recovery required",
        };
      }
      const processState = holderProcess(holder);
      if (processState === "esrch" && stableRoot !== null && paths !== null) {
        const recovery = await recoverDeskLockAsync({
          stableRoot, repoKey: paths.repoKey, kill, now, holderProcess,
        }, { actorKey: "plugin:desk-bridge" });
        if (recovery.ok) continue; // O_EXCL still decides who binds next.
        return { ok: false, code: recovery.code, reason: recovery.message };
      }
      if (processState !== "alive") {
        return {
          ok: false, code: "RECOVERY_REQUIRED",
          reason: `bridge lock held by dead pid or uncertain identity ${holder.pid} — operator recovery required`,
        };
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          code: "CAPABILITY_GAP",
          reason: `desk-busy: bridge lock held by live pid ${holder.pid} (nonce ${holder.instanceNonce})`,
        };
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  /** Release deletes a lock only while THIS instance still owns it —
   *  identical pid AND nonce, the same rule desk-store's releaseLock
   *  enforces. A missing, unreadable or foreign-held lock is left in place
   *  and logged; the file is never unlinked blind. */
  function releaseLock(): void {
    if (paths === null || !lockHeld) return;
    lockHeld = false;
    const path = paths.lockPath;
    let holder: LockHolder | null = null;
    try {
      holder = parseLockHolder(readFileSync(path));
    } catch {
      warn("release-unreadable", `slp: desk bridge lock at ${path} is unreadable — left in place`);
      return;
    }
    if (holder === null || holder.pid !== process.pid || holder.instanceNonce !== instanceNonce) {
      warn(
        "release-foreign",
        `slp: desk bridge lock at ${path} is not owned by this instance ` +
          `(pid ${String(holder?.pid)}, nonce ${String(holder?.instanceNonce)}) — left in place`,
      );
      return;
    }
    try { unlinkSync(path); } catch { /* already gone */ }
  }

  // ---------------------------------------------------------------------
  // seat resolution — handle sha → {repoKey, row}; server-side identity
  // ---------------------------------------------------------------------

  function resolveSeat(handleSha: string):
    | { row: SeatRow; repoKey: string }
    | { error: DeskRejectionValue } {
    if (store === null || stableRoot === null) {
      return {
        error: rejection(
          "CAPABILITY_GAP",
          "desk store is not open",
          "the bridge must be listening before seats resolve",
        ),
      };
    }
    let repos: string[];
    try {
      repos = readdirSync(deskReposDir(stableRoot)).filter(name => REPO_KEY_PATTERN.test(name));
    } catch {
      return {
        error: rejection(
          "STATE_UNREADABLE",
          "the repos directory cannot be read",
          "the desk has no seat state to resolve against",
        ),
      };
    }
    if (repos.length > REPO_SCAN_LIMIT) {
      return {
        error: rejection(
          "CAPABILITY_GAP",
          `repo scan over the ${REPO_SCAN_LIMIT} bound — resolution refused`,
          "the seat scan is bounded; prune stale repos before dispatch",
        ),
      };
    }
    for (const repoKey of repos) {
      let read: DeskStoreRead;
      try {
        read = store.read(repoKey);
      } catch {
        // A repo that throws cannot prove the handle absent — refuse the
        // handshake typed rather than skip it and fabricate ACTOR_MISMATCH.
        return {
          error: rejection(
            "STATE_UNREADABLE",
            "a desk ledger cannot be read while resolving the seat",
            "inspect the desk state on disk; the hello stays unbound",
          ),
        };
      }
      if (read.state !== "ok") continue;
      const row = read.ledger.memberships.find(m => m.bindingHandleSha256 === handleSha);
      if (row !== undefined) return { row, repoKey };
    }
    return {
      error: rejection(
        "ACTOR_MISMATCH",
        "no membership row matches the supplied handle",
        "the handle comes from the minted seat env — an unmatched handle is not a seat",
      ),
    };
  }

  // ---------------------------------------------------------------------
  // dispatch guards (D5) — every call, fail closed
  // ---------------------------------------------------------------------

  /** The fresh membership read behind every dispatch. The carried `read` is
   *  the single ledger observation the status tool also derives
   *  availability and its projection from — identity, availability and
   *  projection can never disagree inside one call. A THROWN read is still
   *  a bounded outcome: it maps to STATE_UNREADABLE like a non-ok state. */
  function freshRow(bound: BoundSeat):
    | { row: SeatRow; read: DeskStoreRead }
    | { error: DeskRejectionValue; read: DeskStoreRead | null } {
    if (store === null) {
      return { error: rejection("STATE_UNREADABLE", "desk store closed", "restart the plugin session"), read: null };
    }
    let read: DeskStoreRead;
    try {
      read = store.read(bound.repoKey);
    } catch (error) {
      return {
        error: rejection(
          "STATE_UNREADABLE",
          `the bound repo ledger read threw: ${(error as Error).message.slice(0, 120)}`,
          "inspect the ledger on disk; dispatch refuses a desk it cannot read",
        ),
        read: null,
      };
    }
    if (read.state === "absent") {
      return {
        error: rejection(
          "STALE_EPOCH",
          "the bound repo ledger is gone",
          "the desk state no longer records this seat — rebind the session",
        ),
        read,
      };
    }
    if (read.state !== "ok") {
      return {
        error: rejection(
          "STATE_UNREADABLE",
          `the bound repo ledger reads ${read.state}`,
          "inspect the ledger on disk; dispatch refuses a desk it cannot read",
        ),
        read,
      };
    }
    const row = read.ledger.memberships.find(m => m.membershipId === bound.membershipId);
    if (
      row === undefined ||
      row.bindingHandleSha256 !== bound.handleSha256 ||
      row.openGeneration !== bound.openGeneration ||
      row.state === "revoked"
    ) {
      return {
        error: rejection(
          "STALE_EPOCH",
          "the membership row vanished, re-bound or ended its epoch",
          "the seat epoch ended — reconnect with a fresh handle",
        ),
        read,
      };
    }
    if (row.agentId === null) {
      return {
        error: rejection(
          "ACTOR_MISMATCH",
          "the membership is not host-bound to an agent",
          "the seat handshake completes at session_open — a bridge cannot bind a seat",
        ),
        read,
      };
    }
    if (row.registeredAt === null) {
      return {
        error: rejection(
          "STALE_EPOCH",
          "the seat registration is not host-confirmed yet",
          "registration confirms on agent.created — retry once the seat is live",
        ),
        read,
      };
    }
    return { row, read };
  }

  /** Guard item — live SDK identity (contract §4 guard). `agents.ref`
   *  refresh is the "current identity" oracle only; contract §2 forbids it
   *  for REBIND, which this path never performs — a mismatch here rejects
   *  the call, it does not rebind anything. */
  async function sdkIdentity(row: SeatRow): Promise<DeskRejectionValue | null> {
    const paseo = deps.paseoRef.current;
    if (paseo === null) {
      return rejection(
        "CAPABILITY_GAP",
        "no host SDK context has reached the plugin this run",
        "identity cannot be verified without a connected paseo context — dispatch stays closed",
      );
    }
    let result: { agent: { provider?: unknown; workspaceId?: unknown; archivedAt?: unknown } | null } | null;
    try {
      result = await Promise.race([
        paseo.agents.ref(row.agentId as string).refresh(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("identity refresh budget exceeded")), IDENTITY_BUDGET_MS),
        ),
      ]);
    } catch (error) {
      return rejection(
        "CAPABILITY_GAP",
        `SDK identity refresh failed: ${(error as Error).message.slice(0, 200)}`,
        "the seat identity cannot be verified — dispatch stays closed",
      );
    }
    const agent = result?.agent ?? null;
    if (agent === null) {
      return rejection(
        "ACTOR_MISMATCH",
        "the bound agent is gone from the host",
        "the seat epoch ended when its agent disappeared",
      );
    }
    if (agent.archivedAt !== null && agent.archivedAt !== undefined) {
      return rejection(
        "ACTOR_MISMATCH",
        "the bound agent is archived",
        "an archived seat cannot dispatch — rebind a live session",
      );
    }
    // workspaceId is optional on the live snapshot and nullable on the row —
    // compare on the same null normalization or undefined !== null rejects
    // a healthy seat.
    const liveWorkspace = typeof agent.workspaceId === "string" ? agent.workspaceId : null;
    if (agent.provider !== row.provider || liveWorkspace !== row.workspaceId) {
      return rejection(
        "ACTOR_MISMATCH",
        "the bound agent's provider/workspace diverged from the membership record",
        "the recorded binding no longer describes a live seat — rebind the session",
      );
    }
    return null;
  }

  function capabilityGate(): DeskRejectionValue | null {
    // UDS tools depend on this bridge's measured transport, not on the
    // separate operator plugin-RPC surface. Hook stashes still never count
    // as RPC evidence; that audit row remains unknown until noteDispatch.
    const { records } = audit({
      now: now().toISOString(),
      observed: {
        rpcDispatched,
        providersSnapshot: null,
        agentsList: null,
        deskBridge: state.kind === "listening" ? "listening" : "unavailable",
      },
    });
    const row = records.find(r => r.capabilityId === CAPABILITY_IDS.deskBridgeTransport);
    if (row?.status !== "supported") {
      return rejection(
        "CAPABILITY_GAP",
        "the desk-bridge.transport capability row is not supported in this audit",
        "dispatch stays closed until the capability audit reports the surface",
      );
    }
    return null;
  }

  /** The lock-holder probe — deliberately ledger-free so the status tool
   *  can combine it with the single freshRow observation instead of paying
   *  a second ledger read that could diverge mid-call. */
  function probeLock(repoKey: string): "clear" | "recovery-required" {
    if (stableRoot === null) return "recovery-required";
    const { lockPath } = deskRepoPaths(stableRoot, repoKey);
    if (existsSync(lockPath)) {
      let holder: LockHolder | null = null;
      try {
        holder = parseLockHolder(readFileSync(lockPath));
      } catch {
        return "recovery-required";
      }
      if (holder === null || !pidAlive(holder.pid)) return "recovery-required";
    }
    return "clear";
  }

  function probeAvailability(repoKey: string): Availability {
    if (stableRoot === null || store === null) return "degraded";
    if (probeLock(repoKey) === "recovery-required") return "recovery-required";
    let read: DeskStoreRead;
    try {
      read = store.read(repoKey);
    } catch {
      // A thrown read still answers: degraded — mutations reject via the
      // availability gate, status reports the desk it cannot read.
      return "degraded";
    }
    if (read.state !== "ok" && read.state !== "absent") return "degraded";
    return "available";
  }

  // ---------------------------------------------------------------------
  // tool catalog — server-side source of truth (D3)
  // ---------------------------------------------------------------------

  interface ToolContext {
    row: SeatRow;
    bound: BoundSeat;
    availability: Availability;
    /** The one ledger observation behind this dispatch — the status
     *  runner projects it directly; mutations re-read under the lock. */
    seatRead: DeskStoreRead | null;
  }

  interface ToolHandler {
    input: z.ZodType;
    prepare(input: unknown): ((ctx: ToolContext) => Promise<unknown>) | null;
  }

  interface ToolDef extends ToolHandler {
    name: string;
    visible: boolean;
    mutation: boolean;
    description: string;
  }

  /** Parse at the strict-input guard, then retain the schema's output type
   *  until execution after the availability guard. No unchecked input cast
   *  or second parse is needed when heterogeneous tools share the catalog. */
  function defineTool<S extends z.ZodType>(
    input: S,
    run: (ctx: ToolContext & { input: z.output<S> }) => Promise<unknown>,
  ): ToolHandler {
    return {
      input,
      prepare(value) {
        const parsed = input.safeParse(value);
        return parsed.success ? ctx => run({ ...ctx, input: parsed.data }) : null;
      },
    };
  }

  /** Runner deps shared by the mutation tools — the store and bound-runtime
   *  capture wiring live in the bridge scope; the P3-b export seam joins
   *  the same assembly so every record call verifies through one path. */
  const runnerDeps = (): HandbackRunnerDeps & SettlementRunnerDeps & CheckRunnerDeps => ({
    store: store as DeskStore,
    capture,
    uuid,
    now,
    binding: binding === null ? null : { runtimePath: binding.runtimePath, nodePath: binding.nodePath },
    verifyExport,
    exec: deps.checkExec,
    probe: deps.checkProbe,
    environment: deps.checkEnvironment,
  });

  async function taskServices(ctx: ToolContext, input: {
    assignmentId: string;
    taskId?: string | null;
    attemptId?: string | null;
    integrationActionId?: string | null;
    attemptIds?: string[];
    placement?: { cwd?: string } | null;
    grant?: { target: { cwd: string } };
  }): Promise<TaskExecutionDeps | DeskRejectionValue> {
    if (store === null || binding === null || stableRoot === null || ctx.seatRead?.state !== "ok") {
      return rejection("STATE_UNREADABLE", "task services require the verified runtime and repository ledger", "restore the desk binding before task execution");
    }
    const ledger = ctx.seatRead.ledger;
    const roots = new Set<string>();
    if (input.placement?.cwd !== undefined) roots.add(input.placement.cwd);
    if (input.grant !== undefined) roots.add(input.grant.target.cwd);
    for (const entry of ledger.taskEntries) {
      if (entry.assignmentId !== input.assignmentId) continue;
      if (entry.kind === "attempt" && (entry.attemptId === input.attemptId ||
          input.attemptIds?.includes(entry.attemptId) || entry.taskId === input.taskId)) {
        if (entry.placement.cwd !== null && existsSync(entry.placement.cwd)) roots.add(entry.placement.cwd);
      }
      if (entry.kind === "action" && (entry.actionId === input.integrationActionId || entry.taskId === input.taskId)) {
        for (const path of [entry.sourceCwd, entry.targetCwd]) {
          if (path !== null && existsSync(path)) roots.add(path);
        }
      }
    }
    try {
      return await createTaskServices({
        ctx: { repoKey: ctx.bound.repoKey, row: ctx.row }, ledger, store,
        binding, stableRoot, daemonHome: dirname(stableRoot),
        host: deps.taskHost ?? (() => null), checkoutRoots: [...roots], now,
      });
    } catch (error) {
      return rejection("CAPABILITY_GAP", `task repository services are unavailable: ${(error as Error).message.slice(0, 240)}`, "use checkout roots in the bound repository and preserve outstanding effects for reconciliation");
    }
  }

  async function taskCommand(ctx: ToolContext, input: DeskTaskCommandInputValue) {
    const services = await taskServices(ctx, input);
    if (isRejection(services)) return services;
    const actor = { repoKey: ctx.bound.repoKey, row: ctx.row };
    return runTaskCommand(actor, input, { store: services.store, observe: createTaskObserver(actor, services) });
  }

  /** A native lifecycle event supplies an agent identity, not owner
   *  authority. Only the exact registered bound worker may observe its own
   *  positively correlated send; missing principals leave reconciliation
   *  with the current owner. Nothing here establishes work acceptance. */
  async function taskTurnEnded(event: TaskTurnEndedEvent): Promise<void> {
    try {
      if (stopped || state.kind !== "listening" || store === null || stableRoot === null || capabilityGate() !== null) return;
      if (!event.timeline?.some(item => item.type === "user_message" && (item.messageId || item.clientMessageId))) return;
      const messageIds = new Set(event.timeline.filter(item => item.type === "user_message")
        .flatMap(item => [item.messageId, item.clientMessageId].filter((id): id is string => typeof id === "string")));
      const repos = readdirSync(deskReposDir(stableRoot)).filter(name => REPO_KEY_PATTERN.test(name));
      if (repos.length > REPO_SCAN_LIMIT) return;
      const matches: { repoKey: string; row: SeatRow; read: Extract<DeskStoreRead, { state: "ok" }>; attemptId: string; assignmentId: string }[] = [];
      for (const repoKey of repos) {
        const read = store.read(repoKey);
        if (read.state !== "ok") continue;
        const row = read.ledger.memberships.find(member => member.agentId === event.agentId &&
          member.state === "host-confirmed" && member.registeredAt !== null && member.revokedAt === null);
        if (row === undefined) continue;
        const attempts = new Map<string, typeof read.ledger.taskEntries[number]>();
        const actions = new Map<string, typeof read.ledger.taskEntries[number]>();
        for (const entry of read.ledger.taskEntries) {
          if (entry.kind === "action") {
            const prior = actions.get(entry.actionId);
            if (prior === undefined || prior.revision < entry.revision) actions.set(entry.actionId, entry);
          }
          if (entry.kind !== "attempt") continue;
          const prior = attempts.get(entry.attemptId);
          if (prior === undefined || prior.revision < entry.revision) attempts.set(entry.attemptId, entry);
        }
        for (const attempt of attempts.values()) {
          if (attempt.kind !== "attempt" || attempt.host.agentId !== event.agentId ||
              attempt.member?.agentId !== row.agentId || attempt.member.membershipId !== row.membershipId) continue;
          if (![...actions.values()].some(action => action.kind === "action" && action.actionKind === "send" &&
              action.attemptId === attempt.attemptId && (action.state === "issued" || action.state === "uncertain") &&
              typeof action.body?.messageId === "string" && messageIds.has(action.body.messageId))) continue;
          matches.push({ repoKey, row, read, attemptId: attempt.attemptId, assignmentId: attempt.assignmentId });
        }
      }
      if (matches.length !== 1) return;
      const match = matches[0];
      if (await sdkIdentity(match.row) !== null || probeAvailability(match.repoKey) !== "available" || stopped) return;
      const bound: BoundSeat = {
        repoKey: match.repoKey, membershipId: match.row.membershipId,
        handleSha256: match.row.bindingHandleSha256, agentId: event.agentId,
        openGeneration: match.row.openGeneration, row: match.row,
      };
      const fresh = freshRow(bound);
      if ("error" in fresh || fresh.read.state !== "ok") return;
      const services = await taskServices({ row: fresh.row, bound, seatRead: fresh.read, availability: "available" }, {
        assignmentId: match.assignmentId, attemptId: match.attemptId,
      });
      if (isRejection(services) || stopped) return;
      await createTaskHostEventObserver(services).onTurnEnded({ repoKey: match.repoKey, row: fresh.row }, event);
    } catch {
      // Hooks fail open; unresolved effects stay visible in durable state.
    }
  }

  const TOOL_IMPLS: Record<(typeof DESK_TOOL_CATALOG)[number]["name"], ToolHandler> = {
    slp_seat_create: defineTool(DeskSeatCreateInput, async ctx => {
      if (stableRoot === null || binding === null) return rejection("CAPABILITY_GAP", "formation has no verified installed binding", "restore the active runtime");
      const pinnedRoot = stableRoot;
      // The listener may outlive an activation/rebind. Resolve the current
      // receipt and its launch set for each new invocation, then pin that
      // tuple across every effect. A rebind before the call is admissible
      // after verification; a rebind after pinning remains fail-closed.
      let fresh: Awaited<ReturnType<typeof resolveStableRoot>>;
      try { fresh = await resolveStableRoot(); }
      catch (error) {
        if (isRejection(error)) return error;
        const parsed = isRecord(error) ? DeskErrorCodeSchema.safeParse(error.code) : null;
        const code = parsed?.success === true ? parsed.data : "CANDIDATE_DRIFT";
        return rejection(code,
          "the current installed binding could not be verified before formation",
          "retain the invocation and reconcile the active binding before a new request");
      }
      if (fresh.stableRoot !== pinnedRoot) return rejection(
        "CANDIDATE_DRIFT",
        "the active runtime moved outside this bridge's verified stable root",
        "retain the invocation and start a bridge bound to the current runtime",
      );
      const pinnedBinding = fresh.binding;
      const host = deps.taskHost ?? (() => null);
      const plan = createFormationPlanner({ runtimePath: pinnedBinding.runtimePath, daemonHome: dirname(pinnedRoot), host });
      return runSeatCreate(ctx.row, ctx.input, { stableRoot: pinnedRoot, repoKey: ctx.bound.repoKey, host, plan,
        guard: async () => {
          if (stopped) return rejection("CAPABILITY_GAP", "bridge stopped during formation", "retain the original operation");
          const capability = capabilityGate(); if (capability !== null) return capability;
          const receipt = deps.journal.read(pinnedRoot);
          const active = receipt?.binding;
          if (receipt === null || !["ACTIVE", "ACTIVATING"].includes(receipt.state) || active == null
              || active.bindingSha256 !== pinnedBinding.bindingSha256
              || active.runtimePath !== pinnedBinding.runtimePath
              || active.candidateSha256 !== pinnedBinding.candidateSha256
              || active.payloadSha256 !== pinnedBinding.payloadSha256
              || active.launchSetSha256 !== pinnedBinding.launchSetSha256
              || active.launchManifestSha256 !== pinnedBinding.launchManifestSha256
              || active.node.path !== pinnedBinding.nodePath) {
            return rejection("CANDIDATE_DRIFT", "active runtime changed during formation", "retain the created seat and reconcile binding");
          }
          const fresh = freshRow(ctx.bound); if ("error" in fresh) return fresh.error;
          const identity = await sdkIdentity(fresh.row); if (identity !== null) return identity;
          const after = freshRow(ctx.bound); return "error" in after ? after.error : null;
        },
      });
    }),
    slp_operation_get: defineTool(DeskOperationGetInput, async ({ row, bound, input }) => {
      if (stableRoot === null || row.agentId === null) return rejection("CAPABILITY_GAP", "operation receipt has no bound caller", "restore desk identity");
      return createDeskOperations(stableRoot).get({ repoKey: bound.repoKey, membershipId: row.membershipId,
        agentId: row.agentId, requestId: input.requestId, kind: input.kind });
    }),
    slp_task_deliver: defineTool(DeskTaskDeliverInput, async ctx => {
      const services = await taskServices(ctx, ctx.input);
      return isRejection(services) ? services : runTaskDeliver({ repoKey: ctx.bound.repoKey, row: ctx.row }, ctx.input, services);
    }),
    slp_task_get: defineTool(DeskTaskGetInput, async ({ row, bound, input, seatRead }) => {
      if (seatRead?.state !== "ok") return rejection("STATE_UNREADABLE", "targeted task view requires a verified ledger", "restore desk readability");
      return projectTaskCurrent(seatRead.ledger, { repoKey: bound.repoKey, row }, input);
    }),
    [STATUS_TOOL]: defineTool(z.object({}).strict(), async ({ row, bound, availability, seatRead }) => {
      const limitations: string[] = [];
      if (availability === "recovery-required") {
        limitations.push(BRIDGE_LIMITATIONS.deskRecoveryRequired);
      } else if (availability === "degraded") {
        limitations.push(BRIDGE_LIMITATIONS.deskDegraded);
      }
      let assignments: DeskSeatStatusValue["assignments"] = [];
      if (availability === "available" && seatRead !== null && seatRead.state === "ok") {
        // The projection reads the SAME ledger observation that resolved
        // this seat's identity — availability and assignments can never
        // come from different ledger versions inside one status call.
        const projection = seatAssignmentsView(seatRead.ledger, row, {
          assignments: WIRE_LIMITS.deskStatusAssignments,
          seats: WIRE_LIMITS.deskStatusSeats,
          handbacks: WIRE_LIMITS.deskStatusHandbacks,
        });
        // P3-b — the settlement mirror joins the same observation, scoped
        // like the handback list: the owner sees every row on its owned
        // assignment; a seat sees only the revisions that settle its own
        // seat.
        const settlementProjection = seatSettlementsView(seatRead.ledger, row, {
          settlements: WIRE_LIMITS.deskStatusSettlements,
        });
        // P4 — the scope machinery joins the same observation: the owner
        // sees every scope; a bound seat sees the scopes it is bound to or
        // may review, with the active round pin so it can bind its
        // observation. Claimed refs/findingsRef never leave the ledger.
        const scopeProjection = seatScopesView(seatRead.ledger, row, {
          scopes: WIRE_LIMITS.deskStatusScopes,
          reviews: WIRE_LIMITS.deskStatusScopeReviews,
        });
        // P5 — the check-runner/rollout machinery joins the same
        // observation: the owner sees every definition/rollout; a bound
        // seat sees the rows of scopes it is bound to or may review.
        // Cohort pins and run identifiers surface; output and claimed
        // refs never leave the ledger.
        const rolloutProjection = seatRolloutsView(seatRead.ledger, row, {
          rollouts: WIRE_LIMITS.deskStatusRollouts,
          runs: WIRE_LIMITS.deskStatusCheckRuns,
          checkDefs: WIRE_LIMITS.deskStatusCheckDefs,
        });
        assignments = projection.assignments.map(a => ({
          ...a,
          settlements: settlementProjection.byAssignment.get(a.assignmentId) ?? [],
          scopes: scopeProjection.byAssignment.get(a.assignmentId) ?? [],
          checkDefinitions: rolloutProjection.defsByAssignment.get(a.assignmentId) ?? [],
          rollouts: rolloutProjection.rolloutsByAssignment.get(a.assignmentId) ?? [],
        }));
        limitations.push(...projection.limitations);
        if (settlementProjection.truncated > 0) {
          limitations.push(`${settlementProjection.truncated} assignment(s) have settlement lists truncated at ${WIRE_LIMITS.deskStatusSettlements}`);
        }
        if (scopeProjection.truncated > 0) {
          limitations.push(`${scopeProjection.truncated} assignment(s) have scope lists truncated at ${WIRE_LIMITS.deskStatusScopes}`);
        }
        if (scopeProjection.reviewsTruncated > 0) {
          limitations.push(`${scopeProjection.reviewsTruncated} scope(s) have review lists truncated at ${WIRE_LIMITS.deskStatusScopeReviews}`);
        }
        if (rolloutProjection.defsTruncated > 0) {
          limitations.push(`${rolloutProjection.defsTruncated} assignment(s) have check-definition lists truncated at ${WIRE_LIMITS.deskStatusCheckDefs}`);
        }
        if (rolloutProjection.truncated > 0) {
          limitations.push(`${rolloutProjection.truncated} assignment(s) have rollout lists truncated at ${WIRE_LIMITS.deskStatusRollouts}`);
        }
        if (rolloutProjection.runsTruncated > 0) {
          limitations.push(`${rolloutProjection.runsTruncated} rollout(s) have run lists truncated at ${WIRE_LIMITS.deskStatusCheckRuns}`);
        }
      } else if (availability !== "available") {
        // The projection is withheld, not faked — a desk that cannot be
        // read cannot serve a trustworthy seat view; the limitation
        // records the elision instead of silently returning [].
        limitations.push(BRIDGE_LIMITATIONS.assignmentsWithheld);
      } else {
        limitations.push("assignments view unavailable — ledger did not read cleanly");
      }
      const view: DeskSeatStatusValue = {
        schemaVersion: 1,
        generatedAt: now().toISOString(),
        seat: {
          membershipId: row.membershipId,
          agentId: row.agentId as string,
          state: row.state,
          family: row.family,
          role: row.role,
          provider: row.provider,
          workspaceId: row.workspaceId,
          createCwd: row.createCwd,
          openGeneration: row.openGeneration,
          createdAt: row.createdAt,
          hostConfirmedAt: row.hostConfirmedAt,
          registeredAt: row.registeredAt,
        },
        desk: { repoKey: bound.repoKey, state: availability, protocol: DESK_BRIDGE_PROTOCOL },
        assignments,
        limitations: boundLimitations(limitations, WIRE_LIMITS.deskBridgeLimitations),
        acceptance: "not-established-by-this-view",
      };
      return DeskSeatStatus.parse(view);
    }),
    [HANDBACK_SUBMIT_TOOL]: defineTool(DeskHandbackSubmitInput, async ({ row, bound, input }) => {
      return runHandbackSubmit(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [ASSIGNMENT_REGISTER_TOOL]: defineTool(DeskAssignmentRegisterInput, async ({ row, bound, input }) => {
      return runAssignmentRegister(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [ASSIGNMENT_ATTACH_TOOL]: defineTool(DeskAssignmentAttachInput, async ({ row, bound, input }) => {
      return runAssignmentAttach(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [ASSIGNMENT_CLOSE_TOOL]: defineTool(DeskAssignmentCloseInput, async ({ row, bound, input }) => {
      return runAssignmentClose(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [ASSIGNMENT_AMEND_TOOL]: defineTool(DeskAssignmentAmendInput, async ({ row, bound, input }) => {
      return runAssignmentAmend({ repoKey: bound.repoKey, row }, input, runnerDeps());
    }),
    [DECISION_APPEND_TOOL]: defineTool(DeskDecisionAppendInput, async ({ row, bound, input }) => {
      return runDecisionAppend({ repoKey: bound.repoKey, row }, input, runnerDeps());
    }),
    [WORKFLOW_GET_TOOL]: defineTool(DeskWorkflowGetInput, async ({ row, input, seatRead }) => {
      if (seatRead === null || seatRead.state !== "ok") {
        return rejection("STATE_UNREADABLE", "the bound repo ledger cannot supply a complete workflow view", "read the current desk ledger before requesting assignment history");
      }
      if (!canReadDeskWorkflow(seatRead.ledger, row, input.assignmentId)) {
        return rejection("AUTHORITY_REQUIRED", "this live membership has no participant read access to the assignment", "use the exact live membership of a current owner, prior owner, attached seat or nominee of a still-usable ownership offer");
      }
      const { assignmentId, ...page } = input;
      return projectDeskWorkflow(seatRead.ledger, assignmentId, page);
    }),
    [SETTLEMENT_RECORD_TOOL]: defineTool(DeskSettlementRecordInput, async ({ row, bound, input }) => {
      return runSettlementRecord(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [SETTLEMENT_EXPORT_TOOL]: defineTool(DeskSettlementExportInput, async ({ row, bound, input }) => {
      return runSettlementExport(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [SCOPE_DECLARE_TOOL]: defineTool(DeskScopeDeclareInput, async ({ row, bound, input }) => {
      return runScopeDeclare(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [SCOPE_TRANSITION_TOOL]: defineTool(DeskScopeTransitionInput, async ({ row, bound, input }) => {
      return runScopeTransition(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [SCOPE_REVIEW_TOOL]: defineTool(DeskScopeReviewInput, async ({ row, bound, input }) => {
      return runScopeReview(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [CHECK_DECLARE_TOOL]: defineTool(DeskCheckDeclareInput, async ({ row, bound, input }) => {
      return runCheckDeclare(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [CHECK_RUN_TOOL]: defineTool(DeskCheckRunInput, async ({ row, bound, input }) => {
      return runCheckRun(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [ROLLOUT_DECLARE_TOOL]: defineTool(DeskRolloutDeclareInput, async ({ row, bound, input }) => {
      return runRolloutDeclare(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [ROLLOUT_TRANSITION_TOOL]: defineTool(DeskRolloutTransitionInput, async ({ row, bound, input }) => {
      return runRolloutTransition(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [ASSIGNMENT_OFFER_TOOL]: defineTool(DeskAssignmentOfferInput, async ({ row, bound, input }) => {
      return runAssignmentOffer(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [ASSIGNMENT_ACCEPT_TOOL]: defineTool(DeskAssignmentAcceptInput, async ({ row, bound, input }) => {
      return runAssignmentAccept(
        { repoKey: bound.repoKey, row },
        input,
        runnerDeps(),
      );
    }),
    [TASK_DEFINE_TOOL]: defineTool(DeskTaskDefineInput, ctx => taskCommand(ctx, { ...ctx.input, operation: "define" })),
    [TASK_RESULT_TOOL]: defineTool(DeskTaskResultInput, ctx => taskCommand(ctx, { ...ctx.input, operation: "result" })),
    [TASK_RULE_TOOL]: defineTool(DeskTaskRuleInput, ctx => taskCommand(ctx, { ...ctx.input, operation: "rule" })),
    [TASK_HOLD_TOOL]: defineTool(DeskTaskHoldInput, ctx => taskCommand(ctx, { ...ctx.input, operation: "hold" })),
    [TASK_STOP_TOOL]: defineTool(DeskTaskStopInput, ctx => taskCommand(ctx, { ...ctx.input, operation: "stop" })),
    [TASK_ACKNOWLEDGE_TOOL]: defineTool(DeskTaskAcknowledgeInput, ctx => taskCommand(ctx, { ...ctx.input, operation: "acknowledge" })),
    [TASK_DISPATCH_TOOL]: defineTool(DeskTaskDispatchInput, async ctx => {
      const services = await taskServices(ctx, ctx.input);
      return isRejection(services) ? services : runTaskDispatch({ repoKey: ctx.bound.repoKey, row: ctx.row }, ctx.input, services);
    }),
    [TASK_RECONCILE_TOOL]: defineTool(DeskTaskReconcileInput, async ctx => {
      const services = await taskServices(ctx, ctx.input);
      return isRejection(services) ? services : runTaskReconciliation({ repoKey: ctx.bound.repoKey, row: ctx.row }, ctx.input, services);
    }),
    [TASK_INTEGRATE_TOOL]: defineTool(DeskTaskIntegrateInput, async ctx => {
      const services = await taskServices(ctx, ctx.input);
      return isRejection(services) ? services : runTaskIntegration({ repoKey: ctx.bound.repoKey, row: ctx.row }, ctx.input, services);
    }),
    [TASK_RECAP_TOOL]: defineTool(DeskTaskRecapInput, async ({ row, input, seatRead }) => {
      if (seatRead?.state !== "ok") return rejection("STATE_UNREADABLE", "the bound ledger cannot supply a task recap", "read the current desk ledger");
      if (!canReadDeskWorkflow(seatRead.ledger, row, input.assignmentId)) {
        return rejection("AUTHORITY_REQUIRED", "this live membership has no participant read access to the assignment", "use an authorized workflow participant");
      }
      let limit = input.limit;
      while (true) {
        const view = projectDeskWorkflow(seatRead.ledger, input.assignmentId, {
          section: "tasks", expectedLedgerRevision: input.expectedLedgerRevision,
          expectedBriefRevision: input.expectedBriefRevision, cursor: input.cursor, limit,
        });
        if (isRejection(view)) return view;
        if (input.expectedOwnershipRevision !== undefined && input.expectedOwnershipRevision !== view.ownership.ownershipRevision) {
          return rejection("REVISION_CONFLICT", "the requested ownership revision no longer stands", "reload the task page under the current ownership pin");
        }
        const parsed = DeskTaskRecapResult.safeParse(buildTaskRecap(view));
        if (!parsed.success) {
          return rejection("INVALID_RECORD", "the authorized task page cannot supply the shared recap contract", "preserve the page and inspect the recap producer before continuing");
        }
        if (Buffer.byteLength(JSON.stringify(parsed.data)) <= MAX_RPC_BYTES) return parsed.data;
        if (limit === 1) {
          return rejection("VIEW_TOO_LARGE", "a complete task recap record exceeds the view budget", "read a smaller bounded artifact; no proof was shortened or omitted silently");
        }
        limit = Math.max(1, Math.floor(limit / 2));
      }
    }),
    [HIDDEN_TOOL]: defineTool(z.object({}).strict(), async () => {
      throw new Error("hidden tool must never run");
    }),
  };
  // Producer contract: every catalog row — visible or hidden — must satisfy
  // the centralized DeskBridgeToolEntry caps and bind an implementation
  // before one can be served.
  const TOOLS: ToolDef[] = DESK_TOOL_CATALOG.map(meta => {
    DeskBridgeToolEntry.parse(meta);
    const impl = TOOL_IMPLS[meta.name];
    if (impl === undefined) throw new Error(`desk tool ${meta.name} has no run implementation`);
    return { ...meta, ...impl };
  });

  function mcpToolsList() {
    return TOOLS.filter(t => t.visible).map(t => {
      const schema = z.toJSONSchema(t.input);
      return {
        name: t.name,
        description: t.description,
        // MCP ToolSchema requires an object root. Intersecting this root type
        // with the untouched zod JSON Schema preserves every anyOf/oneOf
        // branch and its strict additionalProperties constraints.
        inputSchema: { ...schema, type: "object" },
      };
    });
  }

  type McpToolResult = { content: { type: "text"; text: string }[]; isError?: true };

  async function callTool(params: unknown, bound: BoundSeat): Promise<McpToolResult> {
    const text = (value: unknown) => JSON.stringify(value);
    const fail = (value: DeskRejectionValue): McpToolResult => ({
      content: [{ type: "text", text: text(value) }],
      isError: true,
    });
    const call = DeskBridgeToolCall.safeParse(params);
    if (!call.success) {
      return fail(rejection(
        "INVALID_RECORD",
        "tools/call params fail the bridge envelope schema",
        "the params must be {name, arguments?, _meta?} within the wire bounds",
      ));
    }
    const tool = TOOLS.find(t => t.name === call.data.name);
    if (tool === undefined) {
      return fail(rejection(
        "INVALID_RECORD",
        `unknown desk tool ${JSON.stringify(call.data.name.slice(0, WIRE_LIMITS.deskBridgeToolName))}`,
        "tools/list enumerates every callable tool",
      ));
    }
    if (!tool.visible) {
      return fail(rejection(
        "AUTHORITY_REQUIRED",
        `${tool.name} is a hidden mechanism entry, not a seat tool`,
        "no caller may dispatch hidden catalog entries — the rejection is the mechanism",
      ));
    }
    const rowOrError = freshRow(bound);
    let row: SeatRow;
    let seatRead: DeskStoreRead | null;
    if ("error" in rowOrError) {
      // slp_status is the seat's own health reporter — a ledger that cannot
      // be read at all is exactly what it must describe: the
      // handshake-bound row still answers, desk.state degrades and the
      // assignments projection is withheld. Every other tool — and every
      // other error class — fails closed unchanged.
      if (tool.name !== STATUS_TOOL || rowOrError.error.code !== "STATE_UNREADABLE") {
        return fail(rowOrError.error);
      }
      row = bound.row;
      seatRead = rowOrError.read;
    } else {
      row = rowOrError.row;
      seatRead = rowOrError.read;
    }
    const identityError = await sdkIdentity(row);
    if (identityError !== null) return fail(identityError);
    const capError = capabilityGate();
    if (capError !== null) return fail(capError);
    const run = tool.prepare(call.data.arguments ?? {});
    if (run === null) {
      return fail(rejection(
        "INVALID_RECORD",
        `tool arguments fail the strict input schema for ${tool.name}`,
        "dispatch carries only the fields the tool's schema declares",
      ));
    }
    let availability: Availability;
    if (tool.mutation) {
      availability = probeAvailability(bound.repoKey);
      if (availability !== "available") {
        return fail(rejection(
          "RECOVERY_REQUIRED",
          "desk-unavailable: the bound desk is recovery-required",
          "run the operator desk recovery before mutating desk state",
        ));
      }
    } else {
      // Status answers from the ONE read that resolved the seat row: the
      // lock probe is a filesystem check, while availability and the
      // assignments projection share freshRow's ledger observation — a
      // mid-call read transition can never split the view.
      availability =
        probeLock(bound.repoKey) === "recovery-required"
          ? "recovery-required"
          : seatRead !== null && seatRead.state === "ok"
            ? "available"
            : "degraded";
    }
    try {
      const result = await run({ row, bound, availability, seatRead });
      return { content: [{ type: "text", text: text(result) }] };
    } catch (error) {
      return fail(rejection(
        "EXECUTION_UNKNOWN",
        `tool ${tool.name} failed: ${(error as Error).message.slice(0, 200)}`,
        "the dispatch result is unknown — do not assume it landed",
      ));
    }
  }

  // ---------------------------------------------------------------------
  // connection handling — hello → bound seat → serialized JSON-RPC
  // ---------------------------------------------------------------------

  function ackLine(ok: boolean, error?: { code: DeskErrorCode; message: string }): string {
    const ack = ok
      ? { schemaVersion: 1 as const, protocol: DESK_BRIDGE_PROTOCOL, ok: true as const }
      : {
          schemaVersion: 1 as const,
          protocol: DESK_BRIDGE_PROTOCOL,
          ok: false as const,
          error: error ?? { code: "CAPABILITY_GAP" as const, message: "unknown" },
        };
    return JSON.stringify(DeskBridgeAck.parse(ack)) + "\n";
  }

  function rejectConn(conn: Socket, code: DeskErrorCode, message: string): void {
    try {
      conn.write(ackLine(false, { code, message }), () => conn.destroy());
    } catch {
      conn.destroy();
    }
  }

  function dispatchMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
    const hasId = "id" in msg && msg.id !== undefined;
    if (!hasId) return null; // notifications never answer
    const id = msg.id;
    const answer = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (msg.method) {
      case "initialize": {
        const params = isRecord(msg.params) ? msg.params : {};
        const protocolVersion =
          typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_FALLBACK;
        return answer({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "slp-desk", version: DESK_BRIDGE_PROTOCOL },
        });
      }
      case "ping":
        return answer({});
      case "tools/list":
        return answer({ tools: mcpToolsList() });
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `slp-desk: unknown method ${JSON.stringify(String(msg.method).slice(0, 64))}`,
          },
        };
    }
  }

  function handleConnection(conn: Socket): void {
    if (connections.size >= MAX_CONNECTIONS) {
      rejectConn(conn, "CAPABILITY_GAP", "desk bridge connection limit reached");
      return;
    }
    connections.add(conn);
    let bound: BoundSeat | null = null;
    let pending: Promise<void> = Promise.resolve();
    const handshakeTimer = setTimeout(() => {
      if (bound === null) {
        rejectConn(conn, "INVALID_RECORD", "hello not received within the handshake budget");
      }
    }, HANDSHAKE_BUDGET_MS);
    handshakeTimer.unref();

    let carry = Buffer.alloc(0);
    const write = (line: string) => {
      try {
        conn.write(line + "\n");
      } catch { /* closing */ }
    };
    /** Every adapter-emitted error frame carries the typed SLP desk code in
     *  `error.data.slpCode` (schema-validated against DeskBridgeFrameError)
     *  alongside the numeric JSON-RPC code — the vocabulary is
     *  machine-readable, never just message text (D3/errata T5). */
    const writeError = (id: unknown, code: number, message: string, slpCode: DeskErrorCode) => {
      const error = DeskBridgeFrameError.safeParse({ code, message, data: { slpCode } });
      write(JSON.stringify(error.success
        ? { jsonrpc: "2.0", id, error: error.data }
        : { jsonrpc: "2.0", id, error: { code: -32603, message: "slp-desk: error frame failed schema", data: { slpCode: "INVALID_RECORD" } } }));
    };
    /** Outbound frames obey the response byte cap (D3): an oversized result
     *  is replaced by a bounded typed error, never truncated. */
    const writeResult = (id: unknown, result: unknown) => {
      const line = JSON.stringify({ jsonrpc: "2.0", id, result });
      if (Buffer.byteLength(line, "utf8") <= RESPONSE_CAP) {
        write(line);
        return;
      }
      writeError(
        id,
        -32603,
        `RESPONSE_TOO_LARGE: desk reply exceeds the ${RESPONSE_CAP}-byte frame cap`,
        "RESPONSE_TOO_LARGE",
      );
    };

    const onLine = async (line: Buffer): Promise<void> => {
      if (bound === null) {
        clearTimeout(handshakeTimer);
        let hello: unknown;
        const helloText = decodeFrame(line);
        if (helloText === null) {
          rejectConn(conn, "INVALID_RECORD", "hello is not valid UTF-8");
          return;
        }
        try {
          hello = JSON.parse(helloText);
        } catch {
          rejectConn(conn, "INVALID_RECORD", "hello is not valid JSON");
          return;
        }
        const parsed = DeskBridgeHello.safeParse(hello);
        if (!parsed.success) {
          rejectConn(conn, "INVALID_RECORD", "hello fails the bridge handshake schema");
          return;
        }
        // The hello's self-reported binary sha must equal the launch-set
        // pin — absence of a pin is also a refusal: a candidate that never
        // recorded one has no bridge contract to serve.
        const pin = binding?.bridgeSha256;
        if (pin === undefined || parsed.data.bridgeSha256 !== pin) {
          rejectConn(conn, "CANDIDATE_DRIFT", "the running bridge binary does not match the bound candidate's recorded pin");
          return;
        }
        const seat = resolveSeat(sha256Hex(parsed.data.handle));
        if ("error" in seat) {
          rejectConn(conn, seat.error.code, seat.error.message);
          return;
        }
        if (seat.row.agentId === null) {
          rejectConn(conn, "ACTOR_MISMATCH", "the membership is not host-bound to an agent yet");
          return;
        }
        if (seat.row.state === "revoked") {
          rejectConn(conn, "STALE_EPOCH", "the membership is revoked");
          return;
        }
        bound = {
          repoKey: seat.repoKey,
          handleSha256: sha256Hex(parsed.data.handle),
          membershipId: seat.row.membershipId,
          agentId: seat.row.agentId,
          openGeneration: seat.row.openGeneration,
          row: seat.row,
        };
        // ackLine already terminates its own frame — write it raw so no
        // empty line follows the handshake answer.
        try {
          conn.write(ackLine(true));
        } catch { /* closing */ }
        return;
      }
      let msg: unknown;
      const msgText = decodeFrame(line);
      if (msgText === null) {
        writeError(null, -32700, "slp-desk: malformed NDJSON frame (invalid UTF-8)", "INVALID_RECORD");
        return;
      }
      try {
        msg = JSON.parse(msgText);
      } catch {
        writeError(null, -32700, "slp-desk: malformed NDJSON frame", "INVALID_RECORD");
        return;
      }
      if (!isRecord(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
        writeError(null, -32600, "slp-desk: malformed JSON-RPC frame", "INVALID_RECORD");
        return;
      }
      if (msg.method === "tools/call" && "id" in msg && msg.id !== undefined) {
        try {
          const result = await callTool(msg.params, bound);
          writeResult(msg.id, result);
        } catch (error) {
          // No frame may go unacknowledged — a guard or runner fault still
          // answers with a bounded typed error, never a silent timeout.
          writeError(
            msg.id,
            -32603,
            `slp-desk: dispatch fault — ${(error as Error).message.slice(0, 200)}`,
            "EXECUTION_UNKNOWN",
          );
        }
        return;
      }
      const reply = dispatchMessage(msg);
      if (reply !== null) {
        if ("error" in reply) {
          const error = reply.error as { code: number; message: string };
          writeError(reply.id, error.code, error.message, "CAPABILITY_GAP");
        } else {
          writeResult(reply.id, reply.result);
        }
      }
    };

    // An unterminated over-cap frame is swallowed whole: once the cap
    // trips mid-frame, every byte up to the next newline is discarded so
    // the flood's tail can never re-parse as a fresh request. A complete
    // over-cap line is already bounded by its newline — reject it and
    // resume on the next frame.
    let dropping = false;
    const overCap = (swallow: boolean) => {
      if (bound === null) {
        clearTimeout(handshakeTimer);
        rejectConn(
          conn,
          "REQUEST_TOO_LARGE",
          `hello frame exceeds the ${REQUEST_CAP}-byte cap`,
        );
        return;
      }
      dropping = swallow;
      writeError(null, -32600, `REQUEST_TOO_LARGE: slp-desk frame exceeds ${REQUEST_CAP} bytes`, "REQUEST_TOO_LARGE");
    };
    conn.on("data", chunk => {
      carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let start = 0;
      for (;;) {
        const nl = carry.indexOf(0x0a, start);
        if (nl === -1) {
          if (dropping) {
            carry = Buffer.alloc(0);
            return;
          }
          const rest = carry.subarray(start);
          if (rest.length > REQUEST_CAP) {
            overCap(true);
            carry = Buffer.alloc(0);
          } else {
            carry = rest;
          }
          return;
        }
        if (dropping) {
          start = nl + 1;
          dropping = false;
          continue;
        }
        const line = carry.subarray(start, nl);
        start = nl + 1;
        if (line.length > REQUEST_CAP) {
          overCap(false);
          continue;
        }
        // Serialize per-connection dispatch — a frame never starts until
        // the previous one fully answered.
        pending = pending.then(() => onLine(line)).catch(error => {
          warn("dispatch-fault", `slp: desk bridge dispatch fault: ${(error as Error).message}`);
          // Warn-only is not a response: a fault outside the guarded
          // callTool path still owes the client one bounded frame.
          try {
            if (bound === null) {
              rejectConn(conn, "EXECUTION_UNKNOWN", "slp-desk: dispatch fault during the handshake");
            } else {
              writeError(null, -32603, `slp-desk: dispatch fault — ${(error as Error).message.slice(0, 200)}`, "EXECUTION_UNKNOWN");
            }
          } catch { /* the connection is already closing */ }
        });
      }
    });
    conn.on("error", () => { /* close owns cleanup */ });
    conn.on("close", () => {
      clearTimeout(handshakeTimer);
      connections.delete(conn);
    });
  }

  // ---------------------------------------------------------------------
  // start / stop / graft / stash
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // stable bridge binary (F1) — self-install under enforcementDir
  // ---------------------------------------------------------------------

  /** Self-install the verified bridge binary at the stable, non-SHA path
   *  `paths.bridgePath` and return that path — or null with one bounded
   *  diagnostic when integrity fails. Verified chain: the candidate bytes
   *  at `binding.runtimePath/bin/slp-desk-mcp.mjs` must hash to BOTH the
   *  launch-manifest pin and the embedded payload declaration before any
   *  byte is installed; the installed file is then re-hashed so a graft
   *  never points at bytes that diverge from the pin. The lifecycle lock
   *  makes this instance the only writer, so an atomic tmp+rename
   *  replacement is safe — a GC'd or drifted stable file is re-installed,
   *  never served as-is. */
  function stableBridgePath(): string | null {
    if (paths === null || binding === null) return null;
    const pin = binding.bridgeSha256;
    const declared = deps.payload.files.find(f => f.path === BRIDGE_FILE)?.sha256;
    const shorten = (v: string | undefined) => (v === undefined ? "absent" : `${v.slice(0, 12)}…`);
    if (pin === undefined || declared === undefined || pin !== declared) {
      warn(
        "graft-drift",
        `slp: desk bridge pin divergence (manifest ${shorten(pin)}, payload ${shorten(declared)}) — no stable binary installed`,
      );
      return null;
    }
    const target = paths.bridgePath;
    // Already installed and intact — a regular file hashing to the pin.
    // Checked BEFORE the candidate read so a GC'd candidate directory
    // cannot strand a verified install (the whole point of F1).
    try {
      const stat = lstatSync(target);
      if (stat.isFile() && !stat.isSymbolicLink() &&
          sha256Hex(readFileSync(target)) === pin) {
        return target;
      }
    } catch { /* absent or unreadable — install below */ }
    const source = join(binding.runtimePath, BRIDGE_FILE);
    let bytes: Buffer;
    try {
      bytes = readFileSync(source);
    } catch (error) {
      warn("graft-read", `slp: desk bridge binary unreadable at ${source}: ${(error as Error).message}`);
      return null;
    }
    if (sha256Hex(bytes) !== pin) {
      warn("graft-drift", `slp: desk bridge candidate bytes fail the manifest pin (${sha256Hex(bytes).slice(0, 12)}…) — no stable binary installed`);
      return null;
    }
    const tmp = join(paths.enforcementDir, `.slp-desk-mcp.${process.pid}.${instanceNonce}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "w", 0o600);
      writeSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, target);
      if (sha256Hex(readFileSync(target)) !== pin) {
        warn("graft-drift", `slp: desk bridge stable file at ${target} failed post-install verification — graft refused`);
        return null;
      }
      return target;
    } catch (error) {
      warn("graft-install", `slp: desk bridge stable install failed: ${(error as Error).message}`);
      return null;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* closed */ }
      }
      try { unlinkSync(tmp); } catch { /* renamed or never created */ }
    }
  }

  let readyResolve!: (s: "listening" | "unavailable") => void;
  const ready = new Promise<"listening" | "unavailable">(resolve => {
    readyResolve = resolve;
  });

  async function start(): Promise<void> {
    if (stopped) return;
    if (platform === "win32") {
      state = { kind: "unavailable", code: "CAPABILITY_GAP", reason: "no Windows transport — unix-socket only" };
      readyResolve("unavailable");
      return;
    }
    /** F8: stop() may run while an await below is still pending — after each
     *  resumption re-check the flag and undo whatever this attempt already
     *  acquired so nothing outlives plugin cleanup. */
    const abortIfStopped = async (): Promise<boolean> => {
      if (!stopped) return false;
      if (server !== null) {
        await new Promise<void>(resolve => server!.close(() => resolve()));
        server = null;
      }
      if (paths !== null && socketOwned) {
        try { unlinkSync(paths.socketPath); } catch { /* never created */ }
        socketOwned = false;
      }
      releaseLock();
      state = { kind: "unavailable", code: "CAPABILITY_GAP", reason: "desk bridge stopped" };
      readyResolve("unavailable");
      return true;
    };
    try {
      const resolved = await resolveStableRoot();
      if (await abortIfStopped()) return;
      stableRoot = resolved.stableRoot;
      binding = resolved.binding;
      paths = deskBridgePaths(stableRoot);
      // F7: lstat every path component under the verified root — a symlinked
      // or non-directory intermediate would silently place the socket, lock
      // and installed binary outside it (launchers assertRealSetPath rule).
      assertRealComponents(stableRoot, paths.enforcementDir, "desk bridge");
      assertRealComponents(stableRoot, deskReposDir(stableRoot), "desk bridge");
      assertRealComponents(stableRoot, paths.repoDir, "desk bridge");
      assertRealComponents(stableRoot, dirname(paths.socketPath), "desk bridge");
      assertRealComponents(stableRoot, dirname(paths.lockPath), "desk bridge");
      assertRealComponents(stableRoot, dirname(paths.bridgePath), "desk bridge");
      ensurePrivateDirectory(paths.enforcementDir, platform);
      ensurePrivateDirectory(deskReposDir(stableRoot), platform);
      ensurePrivateDirectory(paths.repoDir, platform);
      const lock = await acquireLock(paths.lockPath);
      if (await abortIfStopped()) {
        return;
      }
      if (!lock.ok) {
        state = { kind: "unavailable", code: lock.code, reason: lock.reason };
        warn(`bridge-${lock.code}`, `slp: desk bridge ${lock.code}: ${lock.reason}`);
        readyResolve("unavailable");
        return;
      }
      // The socket file without a live lock holder is leftover, never a
      // peer — only we hold the lock here, so replacing it is safe.
      try { unlinkSync(paths.socketPath); } catch { /* absent */ }
      // F1: install the verified stable binary eagerly while the lifecycle
      // lock still makes this instance the sole writer — a drifted or
      // missing install only warns; the graft re-verifies per call and
      // fails closed on its own.
      stableBridgePath();
      server = createServer(handleConnection);
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(paths!.socketPath, () => {
          server!.removeListener("error", reject);
          socketOwned = true;
          resolve();
        });
      });
      if (await abortIfStopped()) return;
      try {
        chmodSync(paths.socketPath, 0o600);
      } catch (error) {
        await new Promise<void>(resolve => server!.close(() => resolve()));
        server = null;
        try { unlinkSync(paths.socketPath); } catch { /* already gone */ }
        socketOwned = false;
        releaseLock();
        state = {
          kind: "unavailable",
          code: "CAPABILITY_GAP",
          reason: `socket mode could not be pinned: ${(error as Error).message}`,
        };
        readyResolve("unavailable");
        return;
      }
      store = createStore(stableRoot);
      state = { kind: "listening", socketPath: paths.socketPath };
      readyResolve("listening");
    } catch (error) {
      releaseLock();
      const reason = (error as Error).message ?? String(error);
      const parsed = isRecord(error) ? DeskErrorCodeSchema.safeParse(error.code) : null;
      const code: DeskErrorCode = parsed?.success === true ? parsed.data : "CAPABILITY_GAP";
      state = { kind: "unavailable", code, reason: `stable-root resolution failed: ${reason.slice(0, 300)}` };
      readyResolve("unavailable");
    }
  }

  function stop(): void {
    stopped = true;
    // Cleanup order (contract §3.3): connections → server → socket → lock.
    for (const conn of connections) {
      try { conn.destroy(); } catch { /* already gone */ }
    }
    connections.clear();
    const srv = server;
    server = null;
    const finish = () => {
      if (paths !== null && socketOwned) {
        try { unlinkSync(paths.socketPath); } catch { /* already gone */ }
        socketOwned = false;
      }
      releaseLock();
      if (state.kind === "listening" || state.kind === "starting") {
        state = { kind: "unavailable", code: "CAPABILITY_GAP", reason: "desk bridge stopped" };
        readyResolve("unavailable");
      }
    };
    if (srv !== null) {
      srv.close(finish);
      return;
    }
    finish();
  }

  /** The agent.create graft (contract §4 amend P2-c): when the P2-c mint
   *  already placed a handle in request.env and the bridge is listening,
   *  graft the stdio server into config.mcpServers.slp_desk with env
   *  carrying the same handle plus the socket path. Registered AFTER
   *  role-injection's hook, so a missing handle means the mint fail-opened
   *  and the graft follows suit. Unrelated entries pass through verbatim;
   *  a foreign slp_desk entry or a failed integrity check leaves the
   *  request untouched (fail-open, one bounded diagnostic each). */
  async function agentCreateGraft(
    input: { request: AgentCreateRequest },
    ctx?: PluginHookContext,
  ): Promise<AgentCreateRequest | undefined> {
    stashPaseo(ctx?.paseo);
    const request = input.request;
    const config = request.config;
    const provider = config?.provider;
    if (typeof provider !== "string" || !provider.startsWith("slp-") || config === undefined) {
      return undefined;
    }
    const handle = request.env?.SLP_DESK_HANDLE;
    if (typeof handle !== "string" || handle.length === 0) return undefined;
    // A create can race contribute(): wait the bounded budget for start()
    // to settle, then fail open — a bridge that never started never blocks
    // the mint, it just adds no transport.
    await Promise.race([ready, sleep(LEDGER_LIMITS.lockWaitMs)]);
    if (state.kind !== "listening") {
      warn("graft-unavailable", "slp: desk bridge is not listening — seat mints keep env handle only");
      return undefined;
    }
    if (binding === null || paths === null) {
      warn("graft-no-binding", "slp: desk bridge has no active binding — graft skipped");
      return undefined;
    }
    const mcpServers = config.mcpServers ?? {};
    if ("slp_desk" in mcpServers) {
      warn("graft-collision", "slp: config.mcpServers.slp_desk already exists — graft skipped, entry preserved");
      return undefined;
    }
    // Integrity (F1): the graft points at the STABLE binary under the
    // enforcement dir — never the GC-able candidate sha-dir. The install
    // helper verifies candidate bytes == manifest pin == payload
    // declaration before serving the path, and re-installs a drifted or
    // GC'd copy from the verified source.
    const bridgePath = stableBridgePath();
    if (bridgePath === null) {
      warn("graft-refused", "slp: desk bridge stable binary fails integrity — graft refused");
      return undefined;
    }
    return {
      ...request,
      config: {
        ...config,
        mcpServers: {
          ...mcpServers,
          slp_desk: {
            type: "stdio",
            command: binding.nodePath,
            args: [bridgePath],
            env: {
              SLP_DESK_HANDLE: handle,
              SLP_DESK_SOCK: paths.socketPath,
            },
          },
        },
      },
    };
  }

  /** A stash-only session_open before-hook — supplies the connected SDK
   *  context to dispatch guards on resume/refresh opens where no create
   *  ever ran this process lifetime. Returns undefined (no request change). */
  function sessionOpenStash(
    _input: { request: SessionOpenRequest },
    ctx?: PluginHookContext,
  ): undefined {
    stashPaseo(ctx?.paseo);
    return undefined;
  }

  return {
    /** Kick the lifecycle — resolves the verified stable root, takes the
     *  lock, binds the socket. Safe to fire-and-forget; state/ready carry
     *  the outcome. */
    start,
    /** Resolves "listening" or "unavailable" exactly once. */
    whenReady: () => ready,
    state: () => state,
    socketPath: () => (state.kind === "listening" ? state.socketPath : null),
    /** Hook-only SDK stash — never counts as RPC-dispatch evidence. */
    notePaseo: stashPaseo,
    /** Called from a real daemon→plugin RPC handler: records dispatch
     *  evidence AND stashes the SDK context. */
    noteDispatch,
    taskTurnEnded,
    agentCreateGraft,
    sessionOpenStash,
    stop,
  };
}

export type DeskBridge = ReturnType<typeof createDeskBridge>;
