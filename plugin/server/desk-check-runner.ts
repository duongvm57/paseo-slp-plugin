// desk-check-runner.ts — the P5 check-runner machinery (contract R1
// §P1–P2). A check definition is a durable, assignment+scope-bound,
// immutable revision row owned by the receiving owner/lead; it names one
// ALLOWLISTED class from CHECK_CLASSES — never argv, a path or general
// code. The execution seam is local and repository-scoped: it measures the
// environment server-side, runs the named class against the rollout's
// pinned candidate checkout, applies the definition's timeout/output/retry
// bounds (which may only narrow the LEDGER ceilings), and commits exactly
// one immutable `checkRuns` row. A missing host capability commits a
// `blocked` row carrying the durable gap record — never a silent skip.
// The runner never spawns, cancels or reparents agents; it only executes
// the bounded class body.
//
// Two append-only commit paths: `check.declare` (definition revisions)
// and `check.run.commit` (run results). Both re-validate eligibility
// inside the pure decide — orchestration executes outside the lock, so the
// decide is the fail-closed gate a replayed envelope re-verifies.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { Sha } from "../shared/contracts.ts";
import {
  CHECK_RUN_STATUSES,
  DeskCheckDeclareInput,
  DeskCheckRunInput,
  WIRE_LIMITS,
  type CheckClassValue,
  type CheckRunStatusValue,
  type DeskRejectionValue,
} from "../shared/enforcement.ts";
import {
  LEDGER_LIMITS,
  assignmentStructuralRevision,
  type AssignmentValue,
  type CheckDefinitionValue,
  type CheckRunValue,
  type DecideOutcome,
  type LedgerValue,
  type MembershipValue,
  type RolloutValue,
} from "./desk-store.ts";
import type { DeskRunnerDeps } from "./desk-handback.ts";
import { canonicalJson, sha256Hex } from "./config-view.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// command schemas — `actorAgentId` is server-derived (the bound
// membership's agentId) so a replayed envelope re-decides under the same
// actor. `check.run.commit` carries the measured outcome — execution is an
// orchestration-side effect, the decide stays synchronous and pure.
// ---------------------------------------------------------------------------

const ActorAgentId = z.string().min(1).max(WIRE_LIMITS.agentId);
const BoundedId = z.string().min(1).max(WIRE_LIMITS.deskEntityId);

const CheckDeclareCommand = DeskCheckDeclareInput.extend({
  kind: z.literal("check.declare"),
  actorAgentId: ActorAgentId,
}).strict();

const CheckEnvironment = z
  .object({
    node: z.string().min(1).max(64),
    platform: z.string().min(1).max(64),
  })
  .strict();

const CheckOutcome = z
  .object({
    status: z.enum(CHECK_RUN_STATUSES),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().min(0).nullable(),
    outputSha256: Sha.nullable(),
    outputTail: z.string().max(WIRE_LIMITS.deskCheckOutputTail).nullable(),
    outputTruncated: z.boolean(),
    outputPointer: z.string().min(1).max(WIRE_LIMITS.deskCheckPointer).nullable(),
    gap: z
      .object({
        capability: z.string().min(1).max(128),
        detail: z.string().min(1).max(WIRE_LIMITS.gapLen),
      })
      .strict()
      .nullable(),
  })
  .strict();

const CheckRunCommitCommand = DeskCheckRunInput.extend({
  kind: z.literal("check.run.commit"),
  actorAgentId: ActorAgentId,
  // The execution pins — resolved by the runner's preflight and carried
  // through the awaited execution, so the decide can typed-reject a
  // rollout/definition that drifted mid-flight instead of attaching the
  // outcome to a pin it never measured.
  rolloutRevision: z.number().int().min(1),
  candidateSnapshot: Sha,
  candidateHead: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/).nullable(),
  environment: CheckEnvironment,
  outcome: CheckOutcome,
}).strict();

const DeskCheckCommand = z.discriminatedUnion("kind", [CheckDeclareCommand, CheckRunCommitCommand]);

const reject = (code: DeskRejectionValue["code"], message: string, recovery: string): DeskRejectionValue => ({
  ok: false,
  code,
  message,
  recovery,
});

const ok = (
  events: { kind: string; payload: Record<string, unknown> }[],
  tables: { checkDefinitions?: CheckDefinitionValue[]; checkRuns?: CheckRunValue[] } = {},
): DecideOutcome => ({ ok: true, events, ...tables });

function deriveId(prefix: "chk" | "run", parts: string[]): string {
  return `${prefix}-${sha256Hex(canonicalJson(parts)).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// actor + target resolution — server-side, decide-level.
// ---------------------------------------------------------------------------

function liveMembership(ledger: Readonly<LedgerValue>, agentId: string): MembershipValue | undefined {
  return ledger.memberships.find(
    row => row.agentId === agentId && row.state !== "revoked" && row.registeredAt !== null,
  );
}

function requireActor(ledger: Readonly<LedgerValue>, agentId: string): MembershipValue | DeskRejectionValue {
  const actor = liveMembership(ledger, agentId);
  if (actor === undefined) {
    return reject(
      "AUTHORITY_REQUIRED",
      "the actor has no live bound membership on this desk",
      "a check command needs a host-bound, registered row — peers and revoked seats cannot move check state",
    );
  }
  return actor;
}

function requireLead(actor: MembershipValue): DeskRejectionValue | null {
  if (actor.role !== "lead") {
    return reject(
      "AUTHORITY_REQUIRED",
      `role ${JSON.stringify(actor.role)} may not administer checks — the receiving owner holds a bound lead membership`,
      "the role pin is a durable membership field, not a claim",
    );
  }
  return null;
}

function requireOwnedOpenAssignment(
  ledger: Readonly<LedgerValue>,
  actor: MembershipValue,
  assignmentId: string,
): AssignmentValue | DeskRejectionValue {
  const assignment = ledger.assignments.find(a => a.assignmentId === assignmentId);
  if (assignment === undefined) {
    return reject(
      "AUTHORITY_REQUIRED",
      "the assignment is not registered on this desk",
      "check commands name a durable assignment binding of this repo desk",
    );
  }
  if (assignment.ownerAgentId !== actor.agentId) {
    return reject(
      "ACTOR_MISMATCH",
      "only the assignment's receiving owner may administer its checks",
      "the registering lead's agentId is bound into the row — a peer, another lead, or a supervisor cannot run or declare checks",
    );
  }
  if (assignment.state !== "open") {
    return reject(
      "ROLLOUT_CONFLICT",
      "the assignment is closed — its checks keep their recorded state",
      "closed assignments take no new definitions or runs",
    );
  }
  return assignment;
}

/** The check's definition stream (assignmentId, checkId) — sorted by
 *  revision, latest last. */
function definitionStream(ledger: Readonly<LedgerValue>, assignmentId: string, checkId: string): CheckDefinitionValue[] {
  return ledger.checkDefinitions
    .filter(d => d.assignmentId === assignmentId && d.checkId === checkId)
    .sort((a, b) => a.revision - b.revision);
}

/** The rollout's latest declaration revision on this assignment. */
function latestRolloutDeclaration(ledger: Readonly<LedgerValue>, assignmentId: string, rolloutId: string): RolloutValue | undefined {
  const stream = ledger.rollouts
    .filter(r => r.assignmentId === assignmentId && r.rolloutId === rolloutId)
    .sort((a, b) => a.revision - b.revision);
  return stream[stream.length - 1];
}

/** The rollout's current machine state — the last transition row's `to`,
 *  or "declared" when only the opening edge exists. */
function rolloutState(ledger: Readonly<LedgerValue>, assignmentId: string, rolloutId: string): string | null {
  const stream = ledger.rolloutTransitions
    .filter(t => t.assignmentId === assignmentId && t.rolloutId === rolloutId)
    .sort((a, b) => a.revision - b.revision);
  return stream.length === 0 ? null : stream[stream.length - 1]!.to;
}

/** Runs of one retry stream — (assignmentId, rolloutId, checkId,
 *  candidateSnapshot) — sorted by attempt. */
function retryStream(
  ledger: Readonly<LedgerValue>,
  assignmentId: string,
  rolloutId: string,
  checkId: string,
  candidateSnapshot: string,
): CheckRunValue[] {
  return ledger.checkRuns
    .filter(r => r.assignmentId === assignmentId && r.rolloutId === rolloutId && r.checkId === checkId && r.candidateSnapshot === candidateSnapshot)
    .sort((a, b) => a.attempt - b.attempt);
}

// ---------------------------------------------------------------------------
// decide — synchronous and pure.
// ---------------------------------------------------------------------------

export function decideDeskCheck(ledger: Readonly<LedgerValue>, command: Record<string, unknown>): DecideOutcome {
  const parsed = DeskCheckCommand.safeParse(command);
  if (!parsed.success) {
    return reject("INVALID_RECORD", "command does not match any desk-check command schema", "commands are strict JSON objects with a kind discriminator");
  }
  const cmd = parsed.data;

  const actor = requireActor(ledger, cmd.actorAgentId);
  if ("ok" in actor) return actor;
  const leadError = requireLead(actor);
  if (leadError !== null) return leadError;
  const assignment = requireOwnedOpenAssignment(ledger, actor, cmd.assignmentId);
  if ("ok" in assignment) return assignment;

  if (cmd.kind === "check.declare") {
    if (ledger.checkDefinitions.length >= LEDGER_LIMITS.checkDefinitions) {
      return reject("INVALID_RECORD", `checkDefinitions table is at the ${LEDGER_LIMITS.checkDefinitions} cap`, "the check-definition table is bounded per repo desk");
    }
    // The scope must be a declared scope of this assignment — a check
    // binds work the assignment's owner already declared.
    const scopeExists = ledger.scopes.some(s => s.assignmentId === cmd.assignmentId && s.scopeId === cmd.scopeId);
    if (!scopeExists) {
      return reject(
        "SCOPE_CONFLICT",
        "the check names a scope that is not declared on this assignment",
        "declare the scope first — a check definition binds a durable assignment scope",
      );
    }
    const stream = definitionStream(ledger, cmd.assignmentId, cmd.checkId);
    const latest = stream[stream.length - 1];
    if (latest !== undefined && latest.scopeId !== cmd.scopeId) {
      return reject(
        "SCOPE_CONFLICT",
        "the checkId is already declared under a different scope of this assignment",
        "a check's scope binding is fixed at first declaration — choose a new checkId",
      );
    }
    const revision = (latest?.revision ?? 0) + 1;
    const row: CheckDefinitionValue = {
      checkId: cmd.checkId,
      assignmentId: cmd.assignmentId,
      scopeId: cmd.scopeId,
      requestId: cmd.requestId,
      revision,
      priorRevision: latest?.revision ?? null,
      ownerMembershipId: actor.membershipId,
      ownerAgentId: actor.agentId as string,
      assignmentRevision: assignmentStructuralRevision(assignment),
      checkClass: cmd.checkClass,
      label: cmd.label,
      definitionSha256: cmd.definitionSha256,
      limits: cmd.limits,
      requiredEvidence: cmd.requiredEvidence,
      refs: cmd.refs,
    };
    return ok(
      [{
        kind: "check-declared",
        payload: {
          assignmentId: cmd.assignmentId,
          scopeId: cmd.scopeId,
          checkId: cmd.checkId,
          checkClass: cmd.checkClass,
          ownerAgentId: actor.agentId,
          revision,
        },
      }],
      { checkDefinitions: [...ledger.checkDefinitions, row] },
    );
  }

  // check.run.commit — orchestration already executed the class; the decide
  // re-validates every precondition so a replayed/double commit stays
  // fail-closed.
  const eligibility = checkRunEligibility(ledger, assignment, cmd);
  if ("ok" in eligibility) return eligibility;
  const { definition, declaration, prior } = eligibility;
  const run: CheckRunValue = {
    runId: deriveId("run", [actor.agentId as string, cmd.assignmentId, cmd.rolloutId, cmd.checkId, cmd.requestId]),
    assignmentId: cmd.assignmentId,
    rolloutId: cmd.rolloutId,
    checkId: cmd.checkId,
    requestId: cmd.requestId,
    rolloutRevision: declaration.revision,
    definitionRevision: definition.revision,
    definitionSha256: definition.definitionSha256,
    candidateSnapshot: declaration.candidateSnapshot,
    candidateHead: declaration.candidateHead,
    environment: cmd.environment,
    status: cmd.outcome.status,
    attempt: prior.length + 1,
    retryOf: prior.length === 0 ? null : prior[prior.length - 1]!.runId,
    actorAgentId: actor.agentId as string,
    actorSeatId: actor.membershipId,
    exitCode: cmd.outcome.exitCode,
    timedOut: cmd.outcome.timedOut,
    durationMs: cmd.outcome.durationMs,
    outputSha256: cmd.outcome.outputSha256,
    outputTail: cmd.outcome.outputTail,
    outputTruncated: cmd.outcome.outputTruncated,
    outputPointer: cmd.outcome.outputPointer,
    evidenceRef: cmd.evidenceRef,
    gap: cmd.outcome.gap,
  };
  return ok(
    [{
      kind: "check-run-committed",
      payload: {
        assignmentId: cmd.assignmentId,
        rolloutId: cmd.rolloutId,
        checkId: cmd.checkId,
        runId: run.runId,
        status: run.status,
        attempt: run.attempt,
        actorAgentId: actor.agentId,
      },
    }],
    { checkRuns: [...ledger.checkRuns, run] },
  );
}

/** The shared run-eligibility gate — the pure half of run orchestration.
 *  Used once before execution (so a pointless run never spawns) and again
 *  inside the decide (so the commit is fail-closed against drift between
 *  preflight and the lock). Returns the pinned definition + declaration
 *  plus the existing retry stream. */
function checkRunEligibility(
  ledger: Readonly<LedgerValue>,
  assignment: AssignmentValue,
  cmd: {
    rolloutId: string;
    checkId: string;
    definitionRevision: number;
    // `check.run.commit` commands carry the pins the run executed under;
    // the gate re-verifies them against the latest declaration under the
    // lock — a drift between preflight and commit typed-rejects instead
    // of rebinding the measured outcome.
    rolloutRevision?: number;
    candidateSnapshot?: string;
    candidateHead?: string | null;
  },
): { definition: CheckDefinitionValue; declaration: RolloutValue; prior: CheckRunValue[] } | DeskRejectionValue {
  if (ledger.checkRuns.length >= LEDGER_LIMITS.checkRuns) {
    return reject("INVALID_RECORD", `checkRuns table is at the ${LEDGER_LIMITS.checkRuns} cap`, "the run table is bounded per repo desk");
  }
  const declaration = latestRolloutDeclaration(ledger, assignment.assignmentId, cmd.rolloutId);
  if (declaration === undefined) {
    return reject(
      "ROLLOUT_CONFLICT",
      "the rollout is not declared on this assignment",
      "a run binds a declared rollout — declare the rollout before running its checks",
    );
  }
  if (cmd.rolloutRevision !== undefined && cmd.rolloutRevision !== declaration.revision) {
    return reject(
      "REVISION_CONFLICT",
      `the run executed under rollout revision ${cmd.rolloutRevision} but the declaration is now ${declaration.revision}`,
      "a redeclared rollout voids an in-flight run — re-run the check so its evidence binds the pin it measured",
    );
  }
  if (
    cmd.candidateSnapshot !== undefined &&
    (cmd.candidateSnapshot !== declaration.candidateSnapshot || (cmd.candidateHead ?? null) !== declaration.candidateHead)
  ) {
    return reject(
      "CANDIDATE_DRIFT",
      "the run's carried candidate pin no longer matches the declaration",
      "the outcome measured another candidate — re-run under the pinned candidate so the evidence binds what it measured",
    );
  }
  const defs = definitionStream(ledger, assignment.assignmentId, cmd.checkId);
  const definition = defs.find(d => d.revision === cmd.definitionRevision);
  const latestDef = defs[defs.length - 1];
  if (definition === undefined) {
    return reject(
      "INVALID_RECORD",
      "the check names a definition revision that does not exist on this assignment",
      "declare the check definition first — a run binds a durable definition revision",
    );
  }
  if (latestDef === undefined || cmd.definitionRevision !== latestDef.revision) {
    return reject(
      "REVISION_CONFLICT",
      `definitionRevision ${cmd.definitionRevision} is superseded by revision ${latestDef!.revision}`,
      "runs pin the latest definition revision — re-read the definition and retry with a new requestId",
    );
  }
  if (definition.scopeId !== declaration.scopeId) {
    return reject(
      "SCOPE_CONFLICT",
      "the check is declared under a different scope than the rollout",
      "a run binds a check of the rollout's own scope",
    );
  }
  const state = rolloutState(ledger, assignment.assignmentId, cmd.rolloutId);
  if (state !== "checks-running") {
    return reject(
      "ROLLOUT_CONFLICT",
      `the rollout is in ${JSON.stringify(state)} — checks only run in checks-running`,
      "start-checks opens the run window; every other state takes no new runs",
    );
  }
  const prior = retryStream(ledger, assignment.assignmentId, cmd.rolloutId, cmd.checkId, declaration.candidateSnapshot);
  if (prior.length > 0) {
    // A retry stream runs one definition revision — the first run pins it.
    // Amending the definition never reopens the stream: a new definition
    // needs a new candidate pin (a new rollout declaration revision).
    if (prior[0]!.definitionRevision !== definition.revision) {
      return reject(
        "REVISION_CONFLICT",
        `this check's stream already ran under definition revision ${prior[0]!.definitionRevision}`,
        "amending the definition does not reopen a committed stream — move the rollout's candidate pin to run a fresh stream",
      );
    }
    if (prior.some(r => r.status === "passed")) {
      return reject(
        "ROLLOUT_CONFLICT",
        "this check already has a passed run on the pinned candidate",
        "a passed run is immutable evidence — rerun only after the rollout's candidate pin moves",
      );
    }
    if (prior.length >= 1 + definition.limits.maxRetries) {
      return reject(
        "RETRY_EXHAUSTED",
        `the check's retry budget is spent (${prior.length}/${1 + definition.limits.maxRetries} attempts on this candidate)`,
        "the retry budget binds (assignmentId, rolloutId, checkId, candidateSnapshot) — move the rollout's candidate pin for a fresh stream",
      );
    }
  }
  return { definition, declaration, prior };
}

// ---------------------------------------------------------------------------
// Execution seam — one local, repo-scoped, bounded executor per allowlisted
// class. The caller supplies nothing executable: argv is fixed per class,
// cwd is the pinned candidate's measured repository, env is minimal (no
// ambient secrets), and timeout/output bounds come from the definition
// clamped to the LEDGER ceilings. `blocked` outcomes carry the capability
// the probe found missing.
// ---------------------------------------------------------------------------

export type CheckExecContext = {
  /** The pinned candidate's measured repository — the only cwd a class
   *  may use. */
  repository: string;
  /** The candidate's measured head (the pin repo-git-head verifies), or
   *  null when the candidate carried none. */
  candidateHead: string | null;
  /** The bound repo ledger's current read state, measured by the runner
   *  just before execution — the ledger-integrity class's input. */
  ledgerState: string;
  /** The run's effective limits (definition limits clamped to LEDGER
   *  ceilings — already ceiling-bound by schema). */
  limits: { timeoutMs: number; maxOutputBytes: number };
};

export type CheckExecResult = {
  status: Exclude<CheckRunStatusValue, "blocked">;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
};

export type CheckCapabilityGap = { capability: string; detail: string };

export type CheckRunnerDeps = {
  store: DeskRunnerDeps["store"];
  uuid: () => string;
  now: () => Date;
  /** The execution primitive — injectable so tests never spawn. */
  exec?: typeof execFileAsync;
  /** Capability probes — injectable so tests exercise gap paths. */
  probe?: (className: CheckClassValue, ctx: CheckExecContext) => CheckCapabilityGap | null;
  /** Environment fingerprint — injectable for deterministic tests. */
  environment?: () => { node: string; platform: string };
};

/** Run one bounded child process for a class — fixed argv, repo cwd,
 *  minimal env, definition-bounded timeout/output. Maps the exit
 *  vocabulary onto the run's result shape: a non-zero exit is `failed`
 *  (the check completed, its condition did not hold); spawn/timeout/
 *  byte-cap faults are `error`. */
async function boundedExec(
  cmd: string,
  argv: string[],
  ctx: CheckExecContext,
  exec: typeof execFileAsync,
): Promise<CheckExecResult> {
  const start = Date.now();
  try {
    const result = await exec(cmd, argv, {
      timeout: ctx.limits.timeoutMs,
      maxBuffer: ctx.limits.maxOutputBytes,
      windowsHide: true,
      cwd: ctx.repository,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
      },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return {
      status: "passed",
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - start,
      output,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    const durationMs = Date.now() - start;
    if (err.code === "ENOBUFS" || /maxBuffer/i.test(err.message ?? "")) {
      return { status: "error", exitCode: null, timedOut: false, durationMs, output: `${output}\n[output exceeded the ${ctx.limits.maxOutputBytes}-byte cap]` };
    }
    if (err.killed === true || typeof err.signal === "string") {
      return { status: "error", exitCode: null, timedOut: true, durationMs, output: `${output}\n[run exceeded the ${ctx.limits.timeoutMs}ms bound]` };
    }
    if (typeof err.code === "number") {
      return { status: "failed", exitCode: err.code, timedOut: false, durationMs, output };
    }
    return { status: "error", exitCode: null, timedOut: false, durationMs, output: `spawn-failed: ${String(err.code ?? "spawn-error")}: ${(err.message ?? "").split("\n")[0]}` };
  }
}

/** The allowlisted executor registry — one bounded body per class name,
 *  keyed by the same CHECK_CLASSES the durable schema enumerates. Adding a
 *  class is a contract change in shared/enforcement.ts plus an entry here. */
export const CHECK_EXECUTORS: Record<CheckClassValue, (ctx: CheckExecContext, exec: typeof execFileAsync) => Promise<CheckExecResult>> = {
  /** The desk's own durable ledger reads cleanly and its event chain
   *  verifies — the runner already measured `ledgerState` via store.read;
   *  this class never spawns. */
  "ledger-integrity": async ctx => ({
    status: ctx.ledgerState === "ok" ? "passed" : "failed",
    exitCode: 0,
    timedOut: false,
    durationMs: 0,
    output: `ledger state: ${ctx.ledgerState}`,
  }),
  /** The repo's generated-plugin payload check, run inside the pinned
   *  candidate's checkout — fixed script path, fixed flag. */
  "repo-payload-check": async (ctx, exec) =>
    boundedExec(
      process.execPath,
      [join("scripts", "generate-plugin-payload.mjs"), "--check"],
      ctx,
      exec,
    ),
  /** `git rev-parse HEAD` inside the pinned candidate's checkout — passes
   *  when the measured head matches the candidate's pin (or, for a null
   *  pin, when any valid head resolves). */
  "repo-git-head": async (ctx, exec) => {
    const result = await boundedExec("git", ["rev-parse", "HEAD"], ctx, exec);
    if (result.status !== "passed") return result;
    const head = result.output.trim();
    if (ctx.candidateHead !== null && head !== ctx.candidateHead) {
      return { ...result, status: "failed", output: `${result.output}\n[head ${head} != pinned ${ctx.candidateHead}]` };
    }
    return result;
  },
};

/** The capability probe per class — what the host must expose before the
 *  executor may run. A gap commits a `blocked` row with this record. */
function defaultProbe(className: CheckClassValue, ctx: CheckExecContext): CheckCapabilityGap | null {
  if (className === "ledger-integrity") return null;
  if (!existsSync(ctx.repository)) {
    return { capability: "repo-checkout", detail: `candidate repository ${ctx.repository} is not readable on this host` };
  }
  if (className === "repo-payload-check" && !existsSync(join(ctx.repository, "scripts", "generate-plugin-payload.mjs"))) {
    return { capability: "payload-check-script", detail: "scripts/generate-plugin-payload.mjs is absent from the pinned checkout" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runner orchestration — the bridge calls these from ToolDef.run.
// ---------------------------------------------------------------------------

type RunnerCtx = { repoKey: string; row: MembershipValue };

function readLedger(deps: CheckRunnerDeps, repoKey: string): Readonly<LedgerValue> | DeskRejectionValue {
  const read = deps.store.read(repoKey);
  if (read.state !== "ok") {
    return {
      ok: false,
      code: "STATE_UNREADABLE",
      message: `the bound repo ledger reads ${read.state}`,
      recovery: "the desk must read cleanly for a tool call to be answered",
    };
  }
  return read.ledger;
}

const isRejection = (value: unknown): value is DeskRejectionValue =>
  typeof value === "object" && value !== null && "ok" in value && (value as { ok: unknown }).ok === false;

const repoEnvelope = (ledger: Readonly<LedgerValue>) => ({
  hostId: ledger.repo.hostId,
  gitCommonDir: ledger.repo.gitCommonDir,
});

export async function runCheckDeclare(
  ctx: RunnerCtx,
  input: {
    requestId: string;
    assignmentId: string;
    scopeId: string;
    checkId: string;
    checkClass: CheckClassValue;
    label: string;
    definitionSha256: string;
    limits: { timeoutMs: number; maxOutputBytes: number; maxRetries: number };
    requiredEvidence: string[];
    refs: string[];
  },
  deps: CheckRunnerDeps,
): Promise<{ ok: true; [key: string]: unknown } | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  const command = {
    kind: "check.declare" as const,
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId as string,
    assignmentId: input.assignmentId,
    scopeId: input.scopeId,
    checkId: input.checkId,
    checkClass: input.checkClass,
    label: input.label,
    definitionSha256: input.definitionSha256,
    limits: input.limits,
    requiredEvidence: input.requiredEvidence,
    refs: input.refs,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskCheck,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.checkDefinitions.find(
    d => d.requestId === input.requestId && d.assignmentId === input.assignmentId && d.ownerAgentId === ctx.row.agentId,
  );
  if (row === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the declaration committed but its row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return { ok: true, checkId: row.checkId, revision: row.revision, receiptId: settled.receipt.receiptId };
}

export async function runCheckRun(
  ctx: RunnerCtx,
  input: {
    requestId: string;
    assignmentId: string;
    rolloutId: string;
    checkId: string;
    definitionRevision: number;
    evidenceRef: string | null;
  },
  deps: CheckRunnerDeps,
): Promise<{ ok: true; [key: string]: unknown} | DeskRejectionValue> {
  const ledger = readLedger(deps, ctx.repoKey);
  if (isRejection(ledger)) return ledger;
  // Preflight authority BEFORE any replay answer — a committed row never
  // returns before the membership, lead, and owner-binding gates pass.
  const actor = liveMembership(ledger, ctx.row.agentId as string);
  if (actor === undefined) {
    return reject("AUTHORITY_REQUIRED", "the actor has no live bound membership on this desk", "a run needs a host-bound, registered row");
  }
  const leadError = requireLead(actor);
  if (leadError !== null) return leadError;
  const assignment = ledger.assignments.find(a => a.assignmentId === input.assignmentId);
  if (assignment === undefined) {
    return reject("AUTHORITY_REQUIRED", "the assignment is not registered on this desk", "check commands name a durable assignment binding of this repo desk");
  }
  if (assignment.ownerAgentId !== actor.agentId) {
    return reject("ACTOR_MISMATCH", "only the assignment's receiving owner may administer its checks", "the registering lead's agentId is bound into the row — a peer, another lead, or a supervisor cannot run or declare checks");
  }
  // Idempotent fast-path — bound to THIS actor and the committed request
  // body. The store's request idempotency cannot cover runs (the command
  // embeds the measured outcome), so the lookup here mirrors it: a
  // requestId committed under a different actor, or the same requestId
  // carrying a different (rolloutId, checkId, definitionRevision,
  // evidenceRef), is a typed conflict — never a row reveal. A matching
  // replay returns the durable row and never re-executes the class.
  const replayed = ledger.checkRuns.find(r => r.requestId === input.requestId && r.assignmentId === input.assignmentId);
  if (replayed !== undefined) {
    if (replayed.actorAgentId !== actor.agentId) {
      return reject("IDEMPOTENCY_CONFLICT", "the requestId is committed under a different actor", "requestIds are actor-scoped — resubmit under a new requestId");
    }
    if (
      replayed.rolloutId !== input.rolloutId ||
      replayed.checkId !== input.checkId ||
      replayed.definitionRevision !== input.definitionRevision ||
      replayed.evidenceRef !== input.evidenceRef
    ) {
      return reject("IDEMPOTENCY_CONFLICT", "the requestId was committed with a different run body", "resubmit under a new requestId or resend the identical body");
    }
    const record = ledger.requests.find(
      r => r.actorKey === `agent:${actor.agentId}` && r.assignmentId === input.assignmentId && r.requestId === input.requestId,
    );
    if (record === undefined) {
      return reject("RECOVERY_REQUIRED", "the committed run has no request record", "a run row without its durable request record is corruption — inspect the desk under maintenance authority");
    }
    return {
      ok: true,
      runId: replayed.runId,
      rolloutId: replayed.rolloutId,
      checkId: replayed.checkId,
      status: replayed.status,
      attempt: replayed.attempt,
      receiptId: record.receiptId,
    };
  }
  // Open-state gates fresh runs only — mirroring the store's
  // idempotency-before-guards order, a committed row replays verbatim even
  // after the assignment closes.
  if (assignment.state !== "open") {
    return reject("ROLLOUT_CONFLICT", "the assignment is closed — its checks keep their recorded state", "closed assignments take no new definitions or runs");
  }
  // Preflight — the same pure gate the decide re-runs under the lock. A
  // rejection here means no child ever spawned.
  const eligibility = checkRunEligibility(ledger, assignment, input);
  if ("ok" in eligibility) return eligibility;
  const { definition, declaration } = eligibility;
  const candidate = ledger.candidates.find(
    c => c.snapshotSha256 === declaration.candidateSnapshot && c.assignmentId === input.assignmentId,
  );
  if (candidate === undefined) {
    return reject("CANDIDATE_DRIFT", "the rollout's pinned candidate is not durable on this assignment", "the ledger refinement guarantees this — inspect the desk under maintenance authority");
  }
  const exec = deps.exec ?? execFileAsync;
  const probe = deps.probe ?? defaultProbe;
  const environment = deps.environment?.() ?? { node: process.version, platform: process.platform };
  const execCtx: CheckExecContext = {
    repository: candidate.repository,
    candidateHead: declaration.candidateHead,
    ledgerState: deps.store.read(ctx.repoKey).state,
    limits: {
      timeoutMs: Math.min(definition.limits.timeoutMs, LEDGER_LIMITS.checkTimeoutMs),
      maxOutputBytes: Math.min(definition.limits.maxOutputBytes, LEDGER_LIMITS.checkOutputBytes),
    },
  };
  // Capability gap → durable `blocked` outcome; the class never executes.
  const gap = probe(definition.checkClass, execCtx);
  let outcome: z.infer<typeof CheckOutcome>;
  if (gap !== null) {
    outcome = {
      status: "blocked",
      exitCode: null,
      timedOut: false,
      durationMs: null,
      outputSha256: null,
      outputTail: null,
      outputTruncated: false,
      outputPointer: null,
      gap,
    };
  } else {
    const result = await CHECK_EXECUTORS[definition.checkClass](execCtx, exec);
    const tail = result.output.length > WIRE_LIMITS.deskCheckOutputTail
      ? result.output.slice(-WIRE_LIMITS.deskCheckOutputTail)
      : result.output;
    outcome = {
      status: result.status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      outputSha256: sha256Hex(result.output),
      outputTail: tail,
      outputTruncated: tail.length < result.output.length,
      outputPointer: null,
      gap: null,
    };
  }
  // The commit carries the pins this run measured under — revision,
  // candidate snapshot/head resolved at preflight. The decide re-verifies
  // them under the lock: a rollout redeclared during the awaited
  // execution typed-rejects rather than absorbing a stale outcome.
  const command = {
    kind: "check.run.commit" as const,
    requestId: input.requestId,
    actorAgentId: ctx.row.agentId as string,
    assignmentId: input.assignmentId,
    rolloutId: input.rolloutId,
    checkId: input.checkId,
    definitionRevision: input.definitionRevision,
    evidenceRef: input.evidenceRef,
    rolloutRevision: declaration.revision,
    candidateSnapshot: declaration.candidateSnapshot,
    candidateHead: declaration.candidateHead,
    environment,
    outcome,
  };
  const settled = await deps.store.transact(
    ctx.repoKey,
    { repo: repoEnvelope(ledger), actorKey: `agent:${ctx.row.agentId}`, assignmentId: input.assignmentId, requestId: input.requestId, command },
    decideDeskCheck,
  );
  if (!settled.ok) return settled;
  const after = readLedger(deps, ctx.repoKey);
  if (isRejection(after)) return after;
  const row = after.checkRuns.find(r => r.requestId === input.requestId && r.assignmentId === input.assignmentId);
  if (row === undefined) {
    return { ok: false, code: "CAPABILITY_GAP", message: "the run committed but its row is not readable", recovery: "retry the same requestId — the idempotent replay rebuilds the response" };
  }
  return {
    ok: true,
    runId: row.runId,
    rolloutId: row.rolloutId,
    checkId: row.checkId,
    status: row.status,
    attempt: row.attempt,
    receiptId: settled.receipt.receiptId,
  };
}
