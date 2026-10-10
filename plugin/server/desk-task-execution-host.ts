// Host-side seams for the task-execution adapter. Everything here is a
// narrow, typed boundary over the connected SDK (TaskHostApi), bounded
// argv/fs children, and repository measurement — no ledger knowledge and
// no Core imports. The desk-task-execution orchestrator composes these.

import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fchmodSync,
  fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { candidateModulePath } from "./candidate-module.ts";

const defaultExec = promisify(execFileCb);
export const sha256Hex = (bytes: string | NodeJS.ArrayBufferView) =>
  createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// TaskHostApi — structural narrowing of the connected host client surface
// the adapter may touch. Workspace-handle create forwards cwd+workspaceId,
// parent→callerAgentId, idempotencyKey/mode/thinking; send forwards
// messageId; errors propagate once; no cancel method exists.
// ---------------------------------------------------------------------------

export type TaskAgentSnapshot = {
  id: string;
  provider?: string;
  model?: string | null;
  cwd?: string;
  workspaceId?: string | null;
  status?: string | null;
  archivedAt?: string | null;
  activeTurn?: { turnId?: string; startedAt?: string | null } | null;
  labels?: Record<string, string>;
  currentModeId?: string | null;
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
  features?: TaskAgentFeature[];
};

/** Host-reported feature entry — toggle carries a boolean value, select a
 *  string-or-null option id. Label/description/option metadata is ignored
 *  here; verification compares only id+value. */
export type TaskAgentFeature =
  | { type?: string; id: string; value: boolean }
  | { type?: string; id: string; value: string | null };

/** Host refetch returns { agent, project }. */
export type TaskRefetchResult = { agent: TaskAgentSnapshot | null; project: unknown };

/** user_message timeline items carry messageId/clientMessageId; entries
 *  beyond the correlation fields are ignored. */
export type TaskTimelineItem = {
  type: string;
  messageId?: string;
  clientMessageId?: string;
};

/** FetchAgentTimelinePayload.entries — each entry wraps the item. */
export type TaskTimelinePage = {
  entries?: { item?: TaskTimelineItem }[];
};

export type TaskAgentHandle = {
  readonly id: string;
  refresh(requestId?: string): Promise<TaskRefetchResult | null>;
  send(text: string, options?: { messageId?: string }): Promise<void>;
  archive(): Promise<{ archivedAt: string }>;
  waitForFinish(timeoutMs?: number): Promise<unknown>;
  timeline: {
    refetch(options?: { limit?: number; requestId?: string }): Promise<TaskTimelinePage>;
  };
};

/** Bootstrap create carries NO prompt/clientMessageId/systemPrompt/
 *  toolPolicy/mcpServers/git/worktree/autoArchive — the seat's own hooks
 *  mint/register it. idempotencyKey is sent but never relied on: keyed
 *  create does not establish exactly-once host effects. workspaceId is
 *  not a public create option — it is a post-create verification or the
 *  workspace-bound create path below. */
export type TaskCreateOptions = {
  config: {
    /** provider/model joined — the launch binding convention. */
    provider: string;
    modeId?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
  };
  cwd: string;
  parent?: string;
  title?: string;
  labels?: Record<string, string>;
  idempotencyKey?: string;
  requestId?: string;
  /** Private issued-create carrier, generated only by the server adapter.
   * Public dispatch inputs expose no environment override. */
  env?: { SLP_TASK_CREATE_TICKET: string };
};

/** PaseoWorkspaceAgentCreateOptions = Omit<PaseoAgentCreateOptions, "cwd"> —
 *  the workspace handle supplies cwd from its bound directory. */
export type TaskWorkspaceCreateOptions = Omit<TaskCreateOptions, "cwd">;

export type TaskAgentListPage = {
  entries: { agent: TaskAgentSnapshot }[];
  pageInfo?: { hasMore?: boolean; prevCursor?: string | null };
};

export type TaskHostApi = {
  agents: {
    ref(id: string): TaskAgentHandle;
    create(options: TaskCreateOptions): Promise<TaskAgentHandle>;
    list(options?: {
      filter?: { labels?: Record<string, string> };
      page?: { limit: number; cursor?: string };
    }): Promise<TaskAgentListPage>;
  };
  /** Exact workspace binding: ref(workspaceId) fetches the workspace, then
   *  agents.create supplies the daemon-authoritative workspaceDirectory as
   *  cwd. A fabricated descriptor cannot satisfy PaseoWorkspace's required
   *  fields — the id path is the type-safe binding seam. */
  workspaces: {
    ref(id: string): {
      agents: { create(options: TaskWorkspaceCreateOptions): Promise<TaskAgentHandle> };
    };
  };
};

// ---------------------------------------------------------------------------
// Bounded argv execution — argv-only, no shell, minimal env. Output is
// digested and preview-bounded; raw bytes stay inside the child boundary.
// ---------------------------------------------------------------------------

export type TaskExecLimits = { timeoutMs: number; maxOutputBytes: number };
export type TaskExecResult = {
  status: "passed" | "failed" | "timeout" | "byte-cap" | "spawn-failed";
  exitCode: number | null;
  durationMs: number;
  outputBytes: number;
  outputSha256: string;
  outputPreview: string;
};
export type TaskExecLike = typeof defaultExec;
export type TaskBoundedExec = (
  cmd: string, argv: string[], ctx: { cwd: string; limits: TaskExecLimits },
) => Promise<TaskExecResult>;

const OUTPUT_PREVIEW_BYTES = 4096;

export function boundedArgv(exec: TaskExecLike = defaultExec): TaskBoundedExec {
  return async (cmd, argv, ctx) => {
    const start = Date.now();
    const finish = (over: Partial<TaskExecResult> & { status: TaskExecResult["status"] }, output: string): TaskExecResult => ({
      exitCode: null, durationMs: Date.now() - start,
      outputBytes: Buffer.byteLength(output), outputSha256: sha256Hex(output),
      outputPreview: output.slice(0, OUTPUT_PREVIEW_BYTES),
      ...over,
    });
    try {
      const result = await exec(cmd, argv, {
        timeout: ctx.limits.timeoutMs,
        maxBuffer: ctx.limits.maxOutputBytes,
        windowsHide: true,
        cwd: ctx.cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
        },
      });
      return finish({ status: "passed", exitCode: 0 }, `${result.stdout ?? ""}${result.stderr ?? ""}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        killed?: boolean; signal?: string | null; stdout?: string; stderr?: string;
      };
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      if (err.code === "ENOBUFS" || /maxBuffer/i.test(err.message ?? "")) {
        return finish({ status: "byte-cap" }, `${output}\n[output exceeded the ${ctx.limits.maxOutputBytes}-byte cap]`);
      }
      if (err.killed === true || typeof err.signal === "string") {
        return finish({ status: "timeout" }, `${output}\n[run exceeded the ${ctx.limits.timeoutMs}ms bound]`);
      }
      if (typeof err.code === "number") {
        return finish({ status: "failed", exitCode: err.code }, output);
      }
      return finish({ status: "spawn-failed" }, `spawn-failed: ${String(err.code ?? "spawn-error")}: ${(err.message ?? "").split("\n")[0]}`);
    }
  };
}

// ---------------------------------------------------------------------------
// TaskFsIo — realpath-guarded filesystem. Every mutating path must resolve
// inside an allowed root, so staged/backup writes can never escape the
// desk-owned scratch or the declared target checkout.
// ---------------------------------------------------------------------------

export type TaskFsIo = {
  /** Resolve path; throws ESCAPED_ROOT when it lands outside the roots. */
  resolve(path: string): string;
  realpath(path: string): string;
  ensureDir(path: string): string;
  ensureEmptyDir(path: string): string;
  exists(path: string): boolean;
  lstat(path: string): { isFile: boolean; isSymlink: boolean; isDirectory: boolean; mode: number; bytes: number };
  /** Complete direct children, including ignored files; never follows links. */
  listDirectory(path: string): string[];
  readFile(path: string): Buffer;
  readlink(path: string): string;
  writeFile(path: string, bytes: Buffer, mode: number): void;
  /** Exclusive no-follow create of a new leaf inside a guarded root. Refuses
   *  any existing entry — including dangling links — creates no parents,
   *  and verifies size/mode through the descriptor. A created-but-failed
   *  leaf is left for the caller's reconcile; it is never unlinked here. */
  writeFileExclusive?(path: string, bytes: Buffer, mode: number): void;
  copyFile(src: string, dst: string, mode: number): void;
  symlink(target: string, dst: string): void;
  unlink(path: string): void;
  rmrf(path: string): void;
};

const insideRoots = (roots: string[], candidate: string): boolean =>
  roots.some(root => candidate === root || candidate.startsWith(root + sep));

/** Resolve path for guarding: realpath the nearest existing ANCESTOR plus
 *  the remaining segments — never the final component itself. A symlink at
 *  the guarded path must stay a symlink: readlink/lstat/unlink/rmrf would
 *  otherwise operate on its target, and writeFile would write through it. */
const resolveUnder = (path: string): string => {
  const abs = resolve(normalize(path));
  // Final component: never follow a symlink — the guarded path itself
  // must stay observable/removable as a link. Intermediate components
  // still resolve through realpath (the OS follows them).
  const isLink = lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() === true;
  const rest: string[] = isLink ? [basename(abs)] : [];
  let probe = isLink ? dirname(abs) : abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    rest.unshift(basename(probe));
    probe = parent;
  }
  const base = existsSync(probe) ? realpathSync(probe) : probe;
  return join(base, ...rest);
};

export function createTaskFsIo(allowedRoots: string[]): TaskFsIo {
  const roots = allowedRoots.map(root => realpathSync(root));
  const guard = (path: string): string => {
    const resolved = resolveUnder(path);
    if (!insideRoots(roots, resolved)) {
      throw new Error(`ESCAPED_ROOT: ${path} resolves outside the allowed roots`);
    }
    return resolved;
  };
  return {
    resolve: guard,
    realpath: path => realpathSync(guard(path)),
    ensureDir: path => {
      const dst = guard(path);
      mkdirSync(dst, { recursive: true });
      return dst;
    },
    ensureEmptyDir: path => {
      const dst = guard(path);
      mkdirSync(dst, { recursive: true });
      if (readdirSync(dst).length > 0) throw new Error(`STAGE_NOT_EMPTY: ${path}`);
      return dst;
    },
    exists: path => lstatSync(path, { throwIfNoEntry: false }) !== undefined,
    lstat: path => {
      const st = lstatSync(guard(path));
      return { isFile: st.isFile(), isSymlink: st.isSymbolicLink(), isDirectory: st.isDirectory(), mode: st.mode & 0o777, bytes: st.size };
    },
    listDirectory: path => {
      const dir = guard(path), st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("INVENTORY_UNSUPPORTED: directory listing requires an actual directory");
      return readdirSync(dir);
    },
    readFile: path => readFileSync(guard(path)),
    readlink: path => readlinkSync(guard(path)),
    writeFile: (path, bytes, mode) => {
      const dst = guard(path);
      if (lstatSync(dst, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(dst);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, bytes, { mode });
      chmodSync(dst, mode); // writeFileSync mode applies on create only
    },
    writeFileExclusive: (path, bytes, mode) => {
      const dst = guard(path);
      let fd: number;
      try {
        fd = openSync(dst, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
      } catch (error) {
        throw new Error(`EXCLUSIVE_CREATE: ${path} refused (${(error as NodeJS.ErrnoException).code ?? error})`);
      }
      try {
        let written = 0;
        while (written < bytes.byteLength) written += writeSync(fd, bytes, written);
        fchmodSync(fd, mode);
        const st = fstatSync(fd);
        if (!st.isFile() || st.size !== bytes.byteLength || (st.mode & 0o777) !== mode) throw new Error(`EXCLUSIVE_CREATE: ${path} descriptor mismatch`);
      } catch (error) {
        throw error instanceof Error && error.message.startsWith("EXCLUSIVE_CREATE:") ? error
          : new Error(`EXCLUSIVE_CREATE: ${path} failed after create (${String(error).slice(0, 160)})`);
      } finally {
        closeSync(fd);
      }
    },
    copyFile: (src, dst, mode) => {
      const d = guard(dst);
      if (lstatSync(d, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(d);
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(guard(src), d);
      chmodSync(d, mode);
    },
    symlink: (target, dst) => {
      const d = guard(dst);
      mkdirSync(dirname(d), { recursive: true });
      symlinkSync(target, d);
    },
    unlink: path => unlinkSync(guard(path)),
    rmrf: path => rmSync(guard(path), { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// TaskGitIo — bounded git for placement/staging. Raw stdout is required
// (rev-parse / ls-files -z), so this uses the exec seam directly rather
// than the digesting boundedArgv used for proof-recipe runs.
// ---------------------------------------------------------------------------

export type TaskGitIo = {
  commonDir(repoRoot: string): Promise<string>;
  top(repoRoot: string): Promise<string>;
  revParse(repoRoot: string, ref: string): Promise<string | null>;
  worktreeAdd(repoRoot: string, dir: string, ref: string): Promise<void>;
  worktreeRemove(repoRoot: string, dir: string, opts?: { force?: boolean }): Promise<void>;
  lsFiles(repoRoot: string, opts?: { cached?: boolean }): Promise<string[]>;
  /** Read-only raw registration evidence; the shared observer parses it. */
  worktreeList(repoRoot: string): Promise<string>;
  absoluteGitDir(repoRoot: string): Promise<string>;
  measureReference(repoRoot: string, baseRef: string): Promise<RepositoryMeasure>;
};

const GIT_LIMITS = { timeoutMs: 30000, maxBuffer: 16 * 1024 * 1024 };
const GIT_ENV = () => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
});

export function createTaskGitIo(exec: TaskExecLike = defaultExec): TaskGitIo {
  const run = async (repoRoot: string, argv: string[]): Promise<string> => {
    const result = await exec("git", ["--no-optional-locks", "-C", repoRoot, ...argv], {
      timeout: GIT_LIMITS.timeoutMs, maxBuffer: GIT_LIMITS.maxBuffer,
      windowsHide: true, cwd: repoRoot, env: GIT_ENV(),
    });
    return result.stdout;
  };
  const runOrNull = async (repoRoot: string, argv: string[]): Promise<string | null> => {
    try {
      return await run(repoRoot, argv);
    } catch {
      return null;
    }
  };
  return {
    commonDir: async repoRoot => {
      const out = await run(repoRoot, ["rev-parse", "--git-common-dir"]);
      const resolved = resolve(repoRoot, out.trim());
      return realpathSync(resolved);
    },
    top: async repoRoot => {
      const out = await run(repoRoot, ["rev-parse", "--show-toplevel"]);
      return realpathSync(out.trim());
    },
    revParse: async (repoRoot, ref) => {
      const out = await runOrNull(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
      return out === null ? null : out.trim() || null;
    },
    worktreeAdd: async (repoRoot, dir, ref) => {
      await run(repoRoot, ["worktree", "add", dir, ref]);
    },
    worktreeRemove: async (repoRoot, dir, opts = {}) => {
      await run(repoRoot, ["worktree", "remove", ...(opts.force ? ["--force"] : []), dir]);
    },
    worktreeList: repoRoot => run(repoRoot, ["worktree", "list", "--porcelain", "-z"]),
    absoluteGitDir: async repoRoot => realpathSync((await run(repoRoot, ["rev-parse", "--absolute-git-dir"])).trim()),
    lsFiles: async (repoRoot, opts = {}) => {
      const out = await run(repoRoot, ["ls-files", "-z", ...(opts.cached ? ["--cached"] : ["--cached", "--others", "--exclude-standard"])]);
      return out.split("\0").filter(Boolean);
    },
    measureReference: async (repoRoot, baseRef) => {
      const deadline = Date.now() + 30000;
      const bounded = async (cwd: string, argv: string[], maxBuffer: number): Promise<Buffer> => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new TaskMeasurementError("reference measurement exceeded its 30s bound");
        const result = await exec("git", ["--no-optional-locks", "-C", cwd, ...argv], {
          timeout: remaining, maxBuffer, encoding: "buffer", windowsHide: true, cwd, env: GIT_ENV(),
        });
        return Buffer.from(result.stdout);
      };
      if (baseRef === "" || baseRef.includes("\0")) throw new TaskMeasurementError("invalid base reference");
      const root = realpathSync((await bounded(repoRoot, ["rev-parse", "--show-toplevel"], 4096)).toString().trim());
      const gitCommonDir = realpathSync(resolve(root, (await bounded(root, ["rev-parse", "--git-common-dir"], 4096)).toString().trim()));
      const head = (await bounded(root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], 4096)).toString().trim();
      if (!/^[a-f0-9]{40,64}$/.test(head)) throw new TaskMeasurementError("reference did not resolve to a commit");
      const tree = await bounded(root, ["ls-tree", "-rz", "--full-tree", head], 1024 * 1024);
      if (!Buffer.from(tree.toString("utf8")).equals(tree)) throw new TaskMeasurementError("non-UTF8 reference paths are unsupported");
      const entries: RepoEntry[] = [];
      let totalBytes = 0;
      for (const record of tree.toString("utf8").split("\0").filter(Boolean)) {
        if (entries.length >= 4096) throw new TaskMeasurementError("reference exceeds the 4096-entry measurement cap");
        const tab = record.indexOf("\t");
        const [mode, kind, oid] = record.slice(0, tab).split(" ");
        const path = record.slice(tab + 1);
        if (tab < 0 || !safeRel(path) || kind !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
          throw new TaskMeasurementError(`unsupported reference entry: ${path} (${mode}:${kind})`);
        }
        const bytes = await bounded(root, ["cat-file", "blob", oid], 8 * 1024 * 1024);
        totalBytes += bytes.byteLength;
        if (totalBytes > 64 * 1024 * 1024) throw new TaskMeasurementError("reference exceeds the 64 MiB measurement cap");
        const digest = sha256Hex(bytes);
        entries.push(mode === "120000"
          ? { path, kind: "symlink", mode: 0o777, sha256: digest }
          : { path, kind: "file", mode: mode === "100755" ? 0o755 : 0o644, sha256: digest });
      }
      const mapSha256 = measureMapSha256({ entries });
      return {
        kind: "git-reference", root, head, entries, incomplete: [],
        sha256: sha256Hex(JSON.stringify({ kind: "git-reference", head, mapSha256 })),
        measuredAt: new Date().toISOString(),
        reference: { gitCommonDir, baseRef, resolvedHead: head, mapSha256, modeSemantics: "git-tree-executable-class" },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Repository measurement — package.ts snapshot semantics as a typed seam.
// kind "git-snapshot" runs the real Git-aware snapshot; kind "content-map"
// walks an owned non-Git scratch dir and is never labeled snapshot-native.
// ---------------------------------------------------------------------------

export type RepoEntry =
  | { path: string; kind: "file"; mode: number; sha256: string }
  | { path: string; kind: "symlink"; mode: number; sha256: string; linkTarget?: string }
  | { path: string; kind: "gitlink"; indexOid: string | null; headOid: string | null; state: string }
  | { path: string; deleted: true };

export type RepositoryMeasure = {
  kind: "git-snapshot" | "content-map" | "git-reference";
  root: string;
  head: string | null;
  entries: RepoEntry[];
  incomplete: string[];
  sha256: string;
  measuredAt: string;
  reference?: { gitCommonDir: string; baseRef: string; resolvedHead: string; mapSha256: string;
    modeSemantics: "git-tree-executable-class" };
};

/** Entry-map digest omits root and HEAD so a materialized checkout can be
 * compared with its pinned commit tree without relabeling either measure. */
export function measureMapSha256(measure: Pick<RepositoryMeasure, "entries">): string {
  const entries = measure.entries.filter((entry): entry is Exclude<RepoEntry, { deleted: true }> => !("deleted" in entry)).map(entry =>
    entry.kind === "file" || entry.kind === "symlink"
      ? { path: entry.path, kind: entry.kind, mode: entry.mode, sha256: entry.sha256 }
      : entry).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return sha256Hex(JSON.stringify(entries));
}

export type TaskMeasure = (root: string) => Promise<RepositoryMeasure>;

export class TaskMeasurementError extends Error {
  readonly code = "INTEGRATION_UNSUPPORTED";
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const safeRel = (value: unknown): value is string => typeof value === "string" && value !== ""
  && !value.startsWith("/") && !value.includes("\0") && !value.includes("\\")
  && !value.split("/").some(part => part === ".." || part === "." || part === "" || part === ".git");

function measureEntries(value: unknown): RepoEntry[] {
  if (!Array.isArray(value)) throw new TaskMeasurementError("snapshot entries are not an array");
  const seen = new Set<string>();
  return value.map(entry => {
    if (!object(entry) || !safeRel(entry.path) || seen.has(entry.path)) {
      throw new TaskMeasurementError("snapshot has an unsafe or duplicate entry path");
    }
    seen.add(entry.path);
    if (entry.deleted === true && entry.kind === undefined && Object.keys(entry).every(k => k === "path" || k === "deleted")) {
      return { path: entry.path, deleted: true };
    }
    if ((entry.kind === "file" || entry.kind === "symlink") && sha(entry.sha256)
      && typeof entry.mode === "number" && Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777
      && Object.keys(entry).every(k => ["path", "kind", "sha256", "mode", "linkTarget"].includes(k))) {
      if (entry.linkTarget !== undefined && typeof entry.linkTarget !== "string") {
        throw new TaskMeasurementError(`unsupported link target: ${entry.path}`);
      }
      return { path: entry.path, kind: entry.kind, mode: entry.mode, sha256: entry.sha256,
        ...(entry.kind === "symlink" && typeof entry.linkTarget === "string" ? { linkTarget: entry.linkTarget } : {}) };
    }
    throw new TaskMeasurementError(`unsupported snapshot entry: ${entry.path} (${String(entry.kind)})`);
  });
}

function complete(value: Record<string, unknown>): void {
  if (value.nested !== undefined && (!Array.isArray(value.nested) || value.nested.length > 0)) {
    throw new TaskMeasurementError("nested repositories require an explicit integration adapter");
  }
  if (value.incomplete !== undefined && (!Array.isArray(value.incomplete) || value.incomplete.length > 0)) {
    throw new TaskMeasurementError("incomplete snapshot content cannot establish integration proof");
  }
}

function snapshotToMeasure(value: unknown, measuredAt: string): RepositoryMeasure {
  if (!object(value) || typeof value.root !== "string" || !sha(value.sha256)
    || !(value.head === null || typeof value.head === "string")
    || Object.keys(value).some(k => !["root", "head", "sha256", "files", "nested", "incomplete"].includes(k))) {
    throw new TaskMeasurementError("unsupported snapshot shape");
  }
  complete(value);
  return { kind: "git-snapshot", root: value.root, head: value.head,
    entries: measureEntries(value.files), incomplete: [], sha256: value.sha256, measuredAt };
}

/** Validate retained artifact bytes using the same supported entry contract. */
export function parseRepositoryMeasure(value: unknown): RepositoryMeasure {
  if (!object(value) || (value.kind !== "git-snapshot" && value.kind !== "content-map")
    || typeof value.root !== "string" || !sha(value.sha256) || typeof value.measuredAt !== "string"
    || !(value.head === null || typeof value.head === "string")
    || Object.keys(value).some(k => !["kind", "root", "head", "sha256", "entries", "incomplete", "measuredAt"].includes(k))) {
    throw new TaskMeasurementError("unsupported retained measure shape");
  }
  complete(value);
  return { kind: value.kind, root: value.root, head: value.head, sha256: value.sha256,
    measuredAt: value.measuredAt, entries: measureEntries(value.entries), incomplete: [] };
}

/** In-process measure — direct package.ts snapshot call. Bounded by the
 *  caller's judgment; tests and small fixture checkouts use this. */
export function createDirectMeasure(
  snapshotFn: (root: string) => unknown,
  now: () => Date = () => new Date(),
): TaskMeasure {
  return async root => snapshotToMeasure(snapshotFn(root), now().toISOString());
}

/** Production measure — runs the bound-runtime snapshot as a bounded child
 *  (captureSeatSnapshot pattern) but returns the full entry list. */
export function createBoundedMeasure(deps: {
  nodePath: string;
  runtimePath: string;
  now: () => Date;
  exec?: TaskExecLike;
  limits?: Partial<TaskExecLimits>;
}): TaskMeasure {
  const exec = deps.exec ?? defaultExec;
  const limits: TaskExecLimits = {
    timeoutMs: deps.limits?.timeoutMs ?? 60000,
    maxOutputBytes: deps.limits?.maxOutputBytes ?? 32 * 1024 * 1024,
  };
  const script = [
    'const spec = process.env.SLP_MEASURE_SPEC;',
    'const repository = process.env.SLP_MEASURE_REPO;',
    'import(spec).then(mod => {',
    '  const s = mod.snapshot(repository);',
    '  process.stdout.write(JSON.stringify(s));',
    '}).catch(error => {',
    '  process.stderr.write(String(error && error.message ? error.message : error).slice(0, 512));',
    '  process.exit(2);',
    '});',
  ].join("\n");
  return async root => {
    const spec = pathToFileURL(candidateModulePath(deps.runtimePath, "package")).href;
    let stdout: string;
    try {
      const result = await exec(deps.nodePath, ["--input-type", "module", "--eval", script], {
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxOutputBytes,
        windowsHide: true,
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          SLP_MEASURE_SPEC: spec,
          SLP_MEASURE_REPO: root,
        },
      });
      stdout = result.stdout;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      throw new Error(`MEASURE_FAILED: ${(err.message ?? "bounded measure failed").split("\n")[0]}`);
    }
    const parsed: unknown = JSON.parse(stdout);
    return snapshotToMeasure(parsed, deps.now().toISOString());
  };
}

/** Content-map measure — walks an owned non-Git scratch dir. Distinctly
 *  typed: never presented as a git snapshot candidate. */
export function createContentMapMeasure(
  fs: TaskFsIo,
  now: () => Date = () => new Date(),
  limits: { maxEntries?: number; maxFileBytes?: number } = {},
): TaskMeasure {
  const maxEntries = limits.maxEntries ?? 4096;
  const maxFileBytes = limits.maxFileBytes ?? 16 * 1024 * 1024;
  return async root => {
    const resolvedRoot = fs.realpath(root);
    const entries: RepoEntry[] = [];
    const walk = (rel: string): void => {
      if (entries.length >= maxEntries) throw new Error(`CONTENT_MAP_CAP: more than ${maxEntries} entries`);
      const abs = join(resolvedRoot, rel);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(abs);
        entries.push({ path: rel, kind: "symlink", mode: st.mode & 0o777, sha256: sha256Hex(target), linkTarget: target });
        return;
      }
      if (st.isDirectory()) {
        for (const name of readdirSync(abs).sort()) walk(rel === "" ? name : `${rel}/${name}`);
        return;
      }
      if (!st.isFile()) throw new Error(`CONTENT_MAP_UNSUPPORTED: ${rel}`);
      if (st.size > maxFileBytes) throw new Error(`CONTENT_MAP_CAP: ${rel} exceeds ${maxFileBytes} bytes`);
      entries.push({ path: rel, kind: "file", mode: st.mode & 0o777, sha256: sha256Hex(readFileSync(abs)) });
    };
    walk("");
    const payload = { kind: "content-map", entries };
    return {
      kind: "content-map",
      root: resolvedRoot,
      head: null,
      entries,
      incomplete: [],
      sha256: sha256Hex(JSON.stringify(payload)),
      measuredAt: now().toISOString(),
    };
  };
}

/** Request-correlated ids — deterministic per (kind, requestId) so
 *  replays never mint a second identity. */
export const effectIdentity = (kind: string, requestId: string) =>
  `slp-task-${kind}-${sha256Hex(`${kind}:${requestId}`).slice(0, 32)}`;
