// Formation-only placement. Git/common-dir and configuration pins are local;
// workspace identity comes from the connected SDK. No worktree creation/setup.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeskSeatCreateInputValue } from "../shared/delegation.ts";
import type { DeskRejectionValue } from "../shared/enforcement.ts";
import type { MembershipValue } from "./desk-store.ts";
import { canonicalSha256 } from "./config-view.ts";
import { TaskRepositoryMismatchError } from "./desk-task-access.ts";
import { createTaskGitIo, type TaskGitIo, type TaskWorkspaceCreateOptions, type TaskAgentHandle } from "./desk-task-execution-host.ts";
import { TaskHostWaitExpired } from "./desk-task-host.ts";

export type FormationWorkspaceSnapshot = {
  id: string; workspaceDirectory?: string; status: string;
  archivingAt?: string | null; archivedAt?: string | null;
};
export type FormationWorkspaceHandle = {
  readonly id: string;
  refresh(options?: { requestId?: string }): Promise<FormationWorkspaceSnapshot | null>;
  agents: { create(options: TaskWorkspaceCreateOptions): Promise<TaskAgentHandle> };
};
/** Narrow structural SDK contract; intentionally no workspace.create or scripts. */
export type FormationWorkspaceApi = { workspaces: {
  ref(id: string): FormationWorkspaceHandle;
  open(input: { cwd: string; requestId?: string }): Promise<FormationWorkspaceHandle>;
} };
export type FormationSourcePin = {
  repository: string; gitCommonDir: string; head: string;
  configuration: Record<string, string | null>;
};
export type FormationTargetPin = {
  workspaceId: string; cwd: string; head: string; gitCommonDir: string;
  source: FormationSourcePin; reason: string | null;
};
type Phase = (name: string, value: unknown) => void;
type Guard = () => Promise<DeskRejectionValue | null>;
type Git = Pick<TaskGitIo, "commonDir" | "top" | "revParse">;

export class FormationPlacementError extends Error {
  readonly code: DeskRejectionValue["code"];
  readonly workspaceId?: string;
  constructor(code: DeskRejectionValue["code"], message: string, workspaceId?: string) {
    super(message); this.code = code; this.workspaceId = workspaceId;
  }
}
export class FormationPlacementUncertain extends Error {
  readonly workspaceId: string | null;
  readonly cwd: string | null;
  readonly correlationKey: string;
  constructor(workspaceId: string | null, cwd: string | null, correlationKey: string) {
    super("placement observation/open is uncertain; retain identities and do not repeat effects");
    this.workspaceId = workspaceId; this.cwd = cwd; this.correlationKey = correlationKey;
  }
}

const CONFIG_FILES = ["slp-routing.json", "workspace-protocol.md"];
function configuration(repository: string): Record<string, string | null> {
  const pins: Record<string, string | null> = {};
  for (const name of CONFIG_FILES) {
    let fd: number;
    try { fd = openSync(join(repository, ".paseo-slp", name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { pins[name] = null; continue; }
      throw new FormationPlacementError("CAPABILITY_GAP", "placement configuration is not readable as a regular file");
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("unsupported configuration");
      pins[name] = canonicalSha256(readFileSync(fd, "utf8"));
    } catch { throw new FormationPlacementError("CAPABILITY_GAP", "placement configuration exceeds its regular-file budget"); }
    finally { closeSync(fd); }
  }
  return pins;
}
function directory(value: string): string {
  try {
    if (!isAbsolute(value)) throw new Error("relative path");
    const canonical = realpathSync(value);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch { throw new FormationPlacementError("CAPABILITY_GAP", "placement requires an existing absolute checkout directory"); }
}

export function createFormationPlacement(deps: {
  repo: { gitCommonDir: string }; host: () => FormationWorkspaceApi | null; git?: Git;
  budgets?: { readMs: number; effectMs: number };
}) {
  const git = deps.git ?? createTaskGitIo();
  const budgets = deps.budgets ?? { readMs: 8000, effectMs: 20000 };
  if (!Object.values(budgets).every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid formation wait budget");
  let handle: FormationWorkspaceHandle | undefined;
  const wait = async <T>(effect: boolean, operation: string, fn: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TaskHostWaitExpired(operation, effect)), effect ? budgets.effectMs : budgets.readMs);
    })]); } finally { clearTimeout(timer); }
  };
  const common = async (cwd: string) => {
    let actual: string;
    try { actual = await git.commonDir(cwd); }
    catch { throw new FormationPlacementError("CAPABILITY_GAP", "placement Git repository cannot be observed"); }
    if (actual !== deps.repo.gitCommonDir) {
      throw new FormationPlacementError("CAPABILITY_GAP", new TaskRepositoryMismatchError(deps.repo.gitCommonDir, actual).message.replace(/^task checkout/, "seat placement"));
    }
    return actual;
  };
  const head = async (cwd: string) => {
    const value = await git.revParse(cwd, "HEAD");
    if (value === null || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) {
      throw new FormationPlacementError("CAPABILITY_GAP", "placement requires a resolvable Git HEAD");
    }
    return value;
  };
  const locateSource = async (row: MembershipValue) => {
    const cwd = directory(row.createCwd); await common(cwd);
    const top = directory(await git.top(cwd)); await common(top);
    const local = configuration(top);
    // Preserve a checkout's own configuration (including protocol-only user
    // pools). A linked checkout lacking both files inherits only its same-Git
    // main checkout, never an unrelated ancestor or the user pool by accident.
    if (Object.values(local).some(value => value !== null)) return { repository: top, configuration: local, inherited: false };
    const main = dirname(deps.repo.gitCommonDir);
    if (top === main) return { repository: top, configuration: local, inherited: false };
    try {
      const repository = directory(main); await common(repository);
      if (directory(await git.top(repository)) !== repository) throw new Error("not the main checkout");
      const pins = configuration(repository);
      if (Object.values(pins).some(value => value !== null)) return { repository, configuration: pins, inherited: true };
    } catch (error) { if (error instanceof FormationPlacementError && error.code === "ROUTE_DRIFT") throw error; }
    throw new FormationPlacementError("CAPABILITY_GAP", "linked checkout has no trustworthy same-repository configuration source; restore the main checkout routing/protocol configuration before formation; no implicit user-pool fallback");
  };
  const source = async (row: MembershipValue): Promise<FormationSourcePin> => {
    const located = await locateSource(row);
    return { repository: located.repository, gitCommonDir: deps.repo.gitCommonDir,
      head: await head(located.repository), configuration: located.configuration };
  };
  const liveDirectory = async (workspaceId: string, cwd: string | null, key: string) => {
    if (!handle || handle.id !== workspaceId) {
      const api = deps.host();
      if (!api || typeof api.workspaces?.ref !== "function") throw new FormationPlacementError("CAPABILITY_GAP", "host lacks workspace ref/refresh", workspaceId);
      handle = api.workspaces.ref(workspaceId);
    }
    if (typeof handle.refresh !== "function") throw new FormationPlacementError("CAPABILITY_GAP", "host lacks workspace refresh", workspaceId);
    const readKey = canonicalSha256([key, randomUUID()]);
    let snapshot: FormationWorkspaceSnapshot | null;
    try { snapshot = await wait(false, "workspace.refresh", () => handle!.refresh({ requestId: readKey })); }
    catch { throw new FormationPlacementUncertain(workspaceId, cwd, readKey); }
    if (!snapshot || snapshot.id !== workspaceId || handle.id !== workspaceId
      || typeof snapshot.status !== "string" || !snapshot.status
      || snapshot.archivingAt !== null || snapshot.archivedAt != null || typeof snapshot.workspaceDirectory !== "string") {
      throw new FormationPlacementError("CAPABILITY_GAP", "workspace is missing, archiving or has no exact live descriptor", workspaceId);
    }
    const actual = directory(snapshot.workspaceDirectory);
    await common(actual);
    // SDK create carries workspaceId; the server resolves cwd from its registry.
    // Qualify the descriptor now, then verify the actual agent cwd after create.
    if (snapshot.workspaceDirectory !== actual || (cwd !== null && cwd !== actual)) {
      throw new FormationPlacementError("ROUTE_DRIFT", "workspace directory differs from its canonical declared cwd", workspaceId);
    }
    return actual;
  };
  const observe = async (workspaceId: string, cwd: string | null, key: string) => {
    const actual = await liveDirectory(workspaceId, cwd, key);
    return { cwd: actual, head: await head(actual) };
  };
  const checkConfiguration = async (pin: FormationSourcePin, cwd: string) => {
    const targetRoot = directory(await git.top(cwd));
    await common(targetRoot);
    const target = configuration(targetRoot);
    for (const name of CONFIG_FILES) if (target[name] !== null && target[name] !== pin.configuration[name]) {
      throw new FormationPlacementError("ROUTE_DRIFT", "target routing/protocol configuration conflicts with the pinned source");
    }
  };
  return {
    source,
    async inheritedSource(row: MembershipValue): Promise<FormationSourcePin | undefined> {
      const located = await locateSource(row);
      return located.inherited ? { repository: located.repository, gitCommonDir: deps.repo.gitCommonDir,
        head: await head(located.repository), configuration: located.configuration } : undefined;
    },
    async verifySource(row: MembershipValue, pin: FormationSourcePin) {
      if (canonicalSha256(await source(row)) !== canonicalSha256(pin)) {
        throw new FormationPlacementError("ROUTE_DRIFT", "inherited formation source/configuration changed");
      }
    },
    async assertCaller(row: MembershipValue) { await common(directory(row.createCwd)); },
    async verifyCaller(row: MembershipValue) {
      if (row.workspaceId === null) throw new FormationPlacementError("CAPABILITY_GAP", "caller requires its exact bound workspace");
      const cwd = directory(row.createCwd); await common(cwd);
      await liveDirectory(row.workspaceId, cwd, canonicalSha256([row.agentId, row.workspaceId, "caller-read"]));
      // No HEAD/config lease is introduced for historical omitted-placement
      // calls, including orientation in an unborn repository. No extra phase.
    },
    async resolve(row: MembershipValue, input: DeskSeatCreateInputValue, phase: Phase, guard: Guard): Promise<FormationTargetPin> {
      const placement = input.placement;
      if (!placement || placement.kind === "worktree") throw new FormationPlacementError("CAPABILITY_GAP", "only caller/existing placement can be resolved");
      if (placement.kind === "caller" && row.workspaceId === null) throw new FormationPlacementError("CAPABILITY_GAP", "caller placement requires its exact bound workspace");
      const sourcePin = await source(row);
      phase("placement-planned", { source: sourcePin, placement });
      const key = canonicalSha256([sourcePin.gitCommonDir, row.agentId, input.requestId, "workspace-open"]);
      let workspaceId = placement.kind === "caller" ? row.workspaceId : placement.workspaceId;
      const wanted = placement.kind === "caller" ? directory(row.createCwd) : placement.cwd === undefined ? null : directory(placement.cwd);
      let wantedHead: string | null = null;
      if (wanted !== null) { await common(wanted); wantedHead = await head(wanted); await checkConfiguration(sourcePin, wanted); }
      if (workspaceId == null) {
        if (wanted === null) throw new FormationPlacementError("CAPABILITY_GAP", "placement has no workspace or cwd");
        const api = deps.host();
        if (!api || typeof api.workspaces?.open !== "function") throw new FormationPlacementError("CAPABILITY_GAP", "host lacks workspace open");
        const refused = await guard(); if (refused !== null) throw new FormationPlacementError(refused.code, refused.message);
        // Parent verification awaited the SDK; re-read the qualified Git
        // inputs before issuing open, without treating discovery as a lease.
        await common(wanted);
        if (await head(wanted) !== wantedHead || canonicalSha256(await source(row)) !== canonicalSha256(sourcePin)) {
          throw new FormationPlacementError("ROUTE_DRIFT", "placement changed before workspace open");
        }
        await checkConfiguration(sourcePin, wanted);
        phase("workspace-open-issued", { cwd: wanted, head: wantedHead, gitCommonDir: sourcePin.gitCommonDir, correlationKey: key });
        try { handle = await wait(true, "workspace.open", () => api.workspaces.open({ cwd: wanted, requestId: key })); }
        catch { throw new FormationPlacementUncertain(null, wanted, key); }
        if (typeof handle?.id !== "string" || !handle.id) throw new FormationPlacementUncertain(null, wanted, key);
        workspaceId = handle.id;
        phase("workspace-open-returned", { workspaceId });
      }
      const observed = await observe(workspaceId, wanted, key);
      if (wantedHead !== null && observed.head !== wantedHead) throw new FormationPlacementError("ROUTE_DRIFT", "target HEAD changed during workspace resolution", workspaceId);
      await checkConfiguration(sourcePin, observed.cwd);
      const target: FormationTargetPin = { workspaceId, ...observed, gitCommonDir: deps.repo.gitCommonDir,
        source: sourcePin, reason: placement.kind === "existing" ? placement.reason : null };
      await this.verify(row, target);
      phase("target-observed", target);
      return target;
    },
    async verify(row: MembershipValue, pin: FormationTargetPin) {
      const now = await source(row);
      if (canonicalSha256(now) !== canonicalSha256(pin.source)) throw new FormationPlacementError("ROUTE_DRIFT", "placement source/configuration changed", pin.workspaceId);
      const observed = await observe(pin.workspaceId, pin.cwd, canonicalSha256([row.agentId, pin.workspaceId, "workspace-read"]));
      if (observed.head !== pin.head || pin.gitCommonDir !== deps.repo.gitCommonDir) throw new FormationPlacementError("ROUTE_DRIFT", "target Git HEAD/repository changed", pin.workspaceId);
      await checkConfiguration(pin.source, observed.cwd);
    },
    async create(pin: Pick<FormationTargetPin, "workspaceId">, options: TaskWorkspaceCreateOptions) {
      if (!handle || handle.id !== pin.workspaceId) throw new FormationPlacementError("CAPABILITY_GAP", "qualified workspace handle unavailable", pin.workspaceId);
      // Use the same refreshed SDK handle, avoiding an implicit fresh handle
      // lookup whose directory was never qualified. No atomic host/Git fence.
      return wait(true, "workspace.agent.create", () => handle!.agents.create(options));
    },
  };
}
