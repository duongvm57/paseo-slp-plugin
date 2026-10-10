import { supportsNodeVersion, SUPPORTED_NODE_RANGE } from "../shared/runtime/node-version.mjs";
// §6: Node and family-binary resolution for the manager plugin.
//
// Resolution order (Node): explicit nodePath -> prior verified receipt path ->
// executable `node` entries in absolute PATH directories, in order.
// Family binaries use explicit -> current daemon PATH -> prior verified path
// so legacy realpath pins migrate to stable aliases at the next activation.
// An invalid explicit path is an error, never a fallback trigger. process.execPath is
// never a candidate (it may be Electron); no login shells, version managers or
// installs. Every accepted executable is probe-verified and must resolve to an
// absolute existing executable outside the SLP runtime root and the managed
// plugin checkout area (<daemon-home>/plugins).
//
// Windows is fail-closed (UNSUPPORTED_PLATFORM) per spec §6.

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { OperationConflict } from "../shared/contracts.ts";
import type {
  BinaryResolution,
  ExecutableRequest,
  ExecutableResolution,
  ExecutableResolver,
  FamilyName,
  ResolvedNode,
} from "../shared/contracts.ts";

import { FAMILY_IDS } from "../shared/runtime/families.ts";
import { supportsOpenCodeVersion, OPENCODE_VERSION_REQUIREMENT } from "../shared/runtime/opencode-version.mjs";

// The family set derives from the shared registry (families.ts) — the export
// keeps its historical name so existing imports keep working.
export const FAMILIES: readonly FamilyName[] = FAMILY_IDS;

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BUFFER = 64 * 1024;
/** Bound on recorded version strings: probe output is already capped by
 * PROBE_MAX_BUFFER, but a version line itself must stay small — a degenerate
 * or hostile --version must not bloat receipts/status responses. */
const MAX_VERSION_LENGTH = 256;

// Paseo/Electron runtime-control variables, mirroring the installed host list
// (server/server/paseo-env.js RUNTIME_CONTROL_ENV_KEYS). Probes and shim child
// environments must not carry them.
export const RUNTIME_CONTROL_ENV_KEYS: readonly string[] = [
  "PASEO_NODE_ENV",
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ESBUILD_BINARY_PATH",
];

// Runs under `node -e` (CJS): builtin imports must succeed (a failure exits
// nonzero) and the JSON report is the only stdout payload.
const NODE_PROBE_SCRIPT =
  "require('node:fs');require('node:crypto');require('node:child_process');" +
  "process.stdout.write(JSON.stringify({node:process.versions.node," +
  "electron:process.versions.electron??null,execPath:process.execPath}));";

export interface ProbeResult {
  /** Exit code; null when the process never produced one (spawn failure,
   * timeout kill, signal termination). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Human-readable failure description (spawn error, timeout, maxBuffer). */
  error?: string;
}
export type ProbeRunner = (
  file: string,
  args: string[],
  options: { env: Record<string, string>; timeoutMs: number; maxBuffer: number },
) => Promise<ProbeResult>;

export interface ExecutableResolverDeps {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  run?: ProbeRunner;
}

const defaultRun: ProbeRunner = (file, args, options) =>
  new Promise(done => {
    const child = execFile(
      file,
      args,
      {
        shell: false,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code =
          error == null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : child.exitCode;
        done({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
          error: error ? error.message : undefined,
        });
      },
    );
  });

function probeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  for (const key of RUNTIME_CONTROL_ENV_KEYS) delete out[key];
  delete out["NODE_OPTIONS"];
  return out;
}

/** Absolute existing executable, symlinks resolved. Null when missing,
 * non-regular, or not executable by this daemon account. */
async function executableRealpath(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    if (!(await stat(real)).isFile()) return null;
    await access(real, constants.X_OK);
    return real;
  } catch {
    return null;
  }
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Canonicalized directories a managed executable must never live in: the SLP
 * runtime root (immutable candidates + launcher sets) and the managed plugin
 * checkout area under the daemon home. */
async function forbiddenPrefixes(request: ExecutableRequest): Promise<string[]> {
  const roots = [request.stableRoot, join(request.daemonHome, "plugins")];
  const out: string[] = [];
  for (const root of roots) {
    try {
      out.push(await realpath(root));
    } catch {
      out.push(resolvePath(root));
    }
  }
  return out;
}

interface Ctx {
  env: NodeJS.ProcessEnv;
  run: ProbeRunner;
  forbidden: string[];
  cleanEnv: Record<string, string>;
}

function rejectCandidate(real: string, ctx: Ctx): string | null {
  for (const dir of ctx.forbidden) {
    if (isInside(real, dir)) return `inside managed directory ${dir}`;
  }
  return null;
}

async function probeNode(real: string, ctx: Ctx): Promise<ResolvedNode> {
  const result = await ctx.run(real, ["-e", NODE_PROBE_SCRIPT], {
    env: ctx.cleanEnv,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
  });
  if (result.code !== 0) {
    throw new Error(
      `probe failed (${result.error ?? `exit ${String(result.code)}`})`,
    );
  }
  let report: { node?: unknown; electron?: unknown; execPath?: unknown };
  try {
    report = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("probe did not return a JSON report");
  }
  if (typeof report.node !== "string" || report.node.length === 0) {
    throw new Error("probe report lacks node version");
  }
  if (report.node.length > MAX_VERSION_LENGTH) {
    throw new Error(`probe report node version exceeds ${MAX_VERSION_LENGTH} characters`);
  }
  if (report.electron != null) throw new Error("executable reports an Electron runtime");
  if (!supportsNodeVersion(report.node)) {
    throw new Error(`Node ${report.node} does not satisfy required range ${SUPPORTED_NODE_RANGE}`);
  }
  if (typeof report.execPath !== "string" || !isAbsolute(report.execPath)) {
    throw new Error("probe report lacks an absolute execPath");
  }
  let reported: string;
  try {
    reported = await realpath(report.execPath);
  } catch {
    reported = resolvePath(report.execPath);
  }
  if (reported !== real) {
    throw new Error(`probe execPath ${reported} does not match resolved path ${real}`);
  }
  return { path: real, version: report.node };
}

/** Validates one concrete Node path. Throws Error with the rejection reason. */
async function checkNode(path: string, ctx: Ctx): Promise<ResolvedNode> {
  if (!isAbsolute(path)) throw new Error("path is not absolute");
  const real = await executableRealpath(path);
  if (real === null) throw new Error("not an existing executable file");
  const forbidden = rejectCandidate(real, ctx);
  if (forbidden) throw new Error(forbidden);
  return probeNode(real, ctx);
}

/** Absolute PATH directories in order; empty and relative entries ignored. */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env["PATH"] ?? env["Path"] ?? "";
  return raw.split(delimiter).filter(dir => dir.length > 0 && isAbsolute(dir));
}

async function resolveNode(request: ExecutableRequest, ctx: Ctx): Promise<ResolvedNode> {
  const failures: string[] = [];
  if (request.nodePath !== undefined) {
    try {
      return await checkNode(request.nodePath, ctx);
    } catch (error) {
      throw new OperationConflict(
        "EXECUTABLE_UNAVAILABLE",
        `Explicit nodePath ${request.nodePath} is not a usable Node.js runtime: ` +
          `${(error as Error).message}. Supply a valid nodePath or omit it.`,
        { path: request.nodePath },
      );
    }
  }
  const prior = request.prior?.node?.path;
  if (prior) {
    try {
      return await checkNode(prior, ctx);
    } catch (error) {
      failures.push(`prior receipt path ${prior}: ${(error as Error).message}`);
    }
  }
  for (const dir of pathDirs(ctx.env)) {
    const candidate = join(dir, "node");
    const real = await executableRealpath(candidate);
    if (real === null || rejectCandidate(real, ctx)) continue;
    try {
      return await probeNode(real, ctx);
    } catch (error) {
      failures.push(`${candidate}: ${(error as Error).message}`);
    }
  }
  throw new OperationConflict(
    "EXECUTABLE_UNAVAILABLE",
    `No usable ordinary Node.js ${SUPPORTED_NODE_RANGE} executable resolved` +
      (failures.length ? ` (${failures.join("; ")})` : "") +
      `. Supply an explicit nodePath in the activate request.`,
  );
}

/** Follow verified vendor-owned current handles for self-updating CLIs.
 *  Devin uses `_versions/<ver>/bin`; standalone Codex uses
 *  `standalone/releases/<ver>/bin` with `standalone/current`. A realpath pin
 *  on a prior release otherwise keeps answering an old model catalog even
 *  after Paseo's base provider discovers the updated binary. */
async function vendorCurrentHandle(real: string): Promise<string | null> {
  const layouts = [
    { marker: `${sep}_versions${sep}`, currentRoot: (root: string) => join(root, "current") },
    { marker: `${sep}standalone${sep}releases${sep}`, currentRoot: (root: string) => join(root, "..", "current") },
  ];
  for (const layout of layouts) {
    const at = real.indexOf(layout.marker);
    if (at < 0) continue;
    const releasesRoot = real.slice(0, at + layout.marker.length);
    const tail = real.slice(at + layout.marker.length);
    const slash = tail.indexOf(sep);
    if (slash < 0) continue;
    if (layout.marker.includes("standalone") && !tail.endsWith(`${sep}bin${sep}codex`)) continue;
    const handle = join(layout.currentRoot(releasesRoot), tail.slice(slash + 1));
    try {
      if (isInside(await realpath(handle), releasesRoot)) return handle;
    } catch {
      // Missing or broken current handle: retain the verified release path.
    }
  }
  return null;
}

async function probeBinary(tracked: string, ctx: Ctx): Promise<BinaryResolution> {
  const result = await ctx.run(tracked, ["--version"], {
    env: ctx.cleanEnv,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
  });
  if (result.code !== 0) {
    throw new Error(
      `--version probe failed (${result.error ?? `exit ${String(result.code)}`})`,
    );
  }
  const version =
    result.stdout.split("\n").map(line => line.trim()).find(line => line.length > 0) ??
    result.stderr.split("\n").map(line => line.trim()).find(line => line.length > 0);
  if (!version) throw new Error("--version produced no version output");
  if (version.length > MAX_VERSION_LENGTH) {
    throw new Error(`--version line exceeds ${MAX_VERSION_LENGTH} characters`);
  }
  return { available: true, path: tracked, version };
}

/** A family binary must never resolve into the SLP runtime/launcher tree, a
 * managed plugin checkout, or the Node executable itself (recursion). */
function rejectBinary(real: string, node: ResolvedNode, ctx: Ctx): string | null {
  const forbidden = rejectCandidate(real, ctx);
  if (forbidden) return forbidden;
  if (real === node.path) return "resolves to the Node.js executable";
  return null;
}

async function checkBinary(
  path: string,
  node: ResolvedNode,
  ctx: Ctx,
  followVendorCurrent = true,
  family?: FamilyName,
): Promise<BinaryResolution> {
  if (!isAbsolute(path)) throw new Error("path is not absolute");
  const real = await executableRealpath(path);
  if (real === null) throw new Error("not an existing executable file");
  const rejected = rejectBinary(real, node, ctx);
  if (rejected) throw new Error(rejected);
  // Preserve a validated stable alias. All registered providers may update the
  // target of their PATH symlink; realpath would freeze an old release.
  const tracked = path === real && followVendorCurrent ? (await vendorCurrentHandle(real)) ?? real : path;
  const result = await probeBinary(tracked, ctx);
  if (family === "opencode" && result.available && !supportsOpenCodeVersion(result.version)) {
    throw new Error(`requires ${OPENCODE_VERSION_REQUIREMENT}; observed ${result.version}`);
  }
  return result;
}

const UNAVAILABLE: BinaryResolution = { available: false, path: null, version: null };

async function resolveBinary(
  family: FamilyName,
  request: ExecutableRequest,
  node: ResolvedNode,
  ctx: Ctx,
): Promise<BinaryResolution> {
  const explicit = request.binaries?.[family];
  if (explicit !== undefined) {
    try {
      return await checkBinary(explicit, node, ctx, false, family);
    } catch (error) {
      throw new OperationConflict(
        "EXECUTABLE_UNAVAILABLE",
        `Explicit binaries.${family} ${explicit} is not a usable ${family} executable: ` +
          `${(error as Error).message}. Supply a valid path or omit it.`,
        { path: explicit },
      );
    }
  }
  // Prefer the daemon's current PATH alias to migrate legacy receipts that
  // pinned a versioned realpath. Once recorded, the alias follows future
  // vendor updates without another SLP activation.
  for (const dir of pathDirs(ctx.env)) {
    const candidate = join(dir, family);
    const real = await executableRealpath(candidate);
    if (real === null || rejectBinary(real, node, ctx)) continue;
    try {
      return await checkBinary(candidate, node, ctx, true, family);
    } catch {
      continue;
    }
  }
  const prior = request.prior?.binaries?.[family];
  if (prior?.available === true) {
    try {
      return await checkBinary(prior.path, node, ctx, true, family);
    } catch {
      // The last verified path is unavailable too.
    }
  }
  return UNAVAILABLE;
}

export function createExecutableResolver(deps: ExecutableResolverDeps = {}): ExecutableResolver {
  const platform = deps.platform ?? process.platform;
  return {
    async resolve(request: ExecutableRequest): Promise<ExecutableResolution> {
      if (platform === "win32") {
        throw new OperationConflict(
          "UNSUPPORTED_PLATFORM",
          "SLP managed launch is POSIX-only in v1; Windows activation is fail-closed (spec §6).",
        );
      }
      const env = deps.env ?? process.env;
      const ctx: Ctx = {
        env,
        run: deps.run ?? defaultRun,
        forbidden: await forbiddenPrefixes(request),
        cleanEnv: probeEnv(env),
      };
      const node = await resolveNode(request, ctx);
      const binaries = {} as Record<FamilyName, BinaryResolution>;
      for (const family of FAMILIES) {
        binaries[family] = await resolveBinary(family, request, node, ctx);
      }
      return { node, binaries };
    },
  };
}
