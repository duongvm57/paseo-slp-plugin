// §6: immutable launch-set generation and publication.
//
// A launch set lives at <stable-root>/launchers/<launch-set-sha256>/ and holds
// launch.json plus executable POSIX launchers — one real argv[0] per provider
// entry, in two kinds since Phase 2 (settings-driven-providers.md §6):
// devin keeps the v1 shim+wrapper launcher; hook families (codex/pi/claude)
// get a trivial gate launcher that exports the frozen SLP_FAMILY_BIN and
// execs the candidate's bin/slp-gate.mjs. Every argv[0] must answer the
// host's bare `--version` probe — which runs with provider env entirely
// absent — so a single shared candidate-level gate script cannot work (no
// node path, no family binary); per-entry generated files are the only
// shape that carries the frozen resolution into the probe. The manifest
// keeps the full four-family resolution record because the shipped devin
// shim validates the complete family/role sets before entering the wrapper
// (verifyLaunchManifest stays generic — that is the documented choice).
// `launchSetSha256` is the sha256 of the canonical launch.json bytes; the
// manifest carries no self-reference, so the set hash and the manifest hash
// coincide (the receipt records the same value as launchManifestSha256).
// Launcher bytes are a pure function of the manifest plus the set
// directory, so equal inputs reproduce an identical set and an existing
// verified directory is reused rather than rewritten.
//
// Publication follows §5: build in memory, stage under .staging/<op-id>,
// verify staged bytes/modes from disk, fsync, rename into place, re-verify.
// Windows is fail-closed (UNSUPPORTED_PLATFORM) per spec §6.

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";
import { OperationConflict } from "../shared/contracts.ts";
import { DESK_BRIDGE_PROTOCOL } from "../shared/enforcement.ts";
import type {
  BinaryResolution,
  FamilyName,
  LauncherBuilder,
  LauncherFileValue,
  LaunchSet,
  LaunchSetRequest,
} from "../shared/contracts.ts";
import { FAMILY_IDS, HOOK_FAMILY_IDS, ROLES, type RoleName } from "../shared/families.ts";

// The family/role axes derive from the shared registry (families.ts) — the
// exports keep their historical names so existing imports keep working.
export const FAMILIES: readonly FamilyName[] = FAMILY_IDS;
export { ROLES };
type Role = RoleName;
export const LAUNCHER_MODE = 0o755;
export const MANIFEST_MODE = 0o644;
const PRIVATE_DIR_MODE = 0o700;
const MANIFEST_NAME = "launch.json";
const SHIM_RELATIVE_PATH = join("bin", "slp-shim.mjs");
const GATE_RELATIVE_PATH = join("bin", "slp-gate.mjs");

/** Phase 2: families whose launchers exec the sentinel gate instead of the
 *  shim+wrapper (see the file header) — the registry's `transport === "hook"`
 *  entries. Devin is absent — its ACP adapter drops systemPrompt, so
 *  slp-devin-* keeps the full shim path. */
export const GATE_FAMILIES: readonly FamilyName[] = HOOK_FAMILY_IDS;

interface LaunchManifest {
  schemaVersion: 1;
  daemonHome: string;
  candidate: { sha256: string; path: string };
  node: { path: string; version: string };
  binaries: Record<FamilyName, BinaryResolution>;
  families: FamilyName[];
  roles: Role[];
  /** The subset of `families` whose role launchers this set contains.
   *  Absent on legacy manifests, which replan as the v1 all-shim
   *  twelve-launcher layout so pre-Phase-2 sets still verify under this
   *  builder; `["devin"]` replays the transitional devin-only layout.
   *  The field also makes new manifests digest-different from a legacy
   *  manifest with identical inputs, so layouts never collide on a
   *  directory name. */
  launcherFamilies?: FamilyName[];
  /** The subset of `launcherFamilies` whose launchers exec the sentinel
   *  gate rather than the shim+wrapper. Absent means every launcher is
   *  shim-style (the v1 and devin-only layouts). Must be a subset of
   *  `launcherFamilies`. */
  gateFamilies?: FamilyName[];
  /** P2-d — the desk-bridge provenance pin recorded at publish: sha256 of
   *  the candidate's packaged bin/slp-desk-mcp.mjs plus the bridge protocol
   *  literal. Optional so pre-P2-d manifests still verify; a candidate that
   *  ships the binary always publishes both fields. */
  bridgeSha256?: string;
  bridgeProtocolVersion?: string;
}

const sha256 = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** POSIX single-quote escaping for fixed launcher arguments. "$@" is emitted
 * verbatim by launcherScript — user arguments are never evaluated. */
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function launcherName(family: FamilyName, role: Role): string {
  return `slp-${family}-${role}`;
}

function buildManifest(request: LaunchSetRequest): LaunchManifest {
  const binaries = {} as Record<FamilyName, BinaryResolution>;
  for (const family of FAMILIES) {
    const entry = request.binaries[family];
    if (entry === undefined) {
      throw new OperationConflict(
        "INVALID_REQUEST",
        `Launch set request is missing a binaries.${family} resolution`,
      );
    }
    binaries[family] = entry.available
      ? { available: true, path: entry.path, version: entry.version }
      : { available: false, path: null, version: null };
  }
  const manifest: LaunchManifest = {
    schemaVersion: 1,
    daemonHome: request.daemonHome,
    candidate: { sha256: request.candidate.sha256, path: request.candidate.runtimePath },
    node: { path: request.node.path, version: request.node.version },
    binaries,
    families: [...FAMILIES],
    roles: [...ROLES],
    launcherFamilies: [...FAMILIES],
    gateFamilies: [...GATE_FAMILIES],
  };
  // P2-d — the bridge pin is recorded at publish, inside the manifest the
  // binding's launchManifestSha256 already commits to (P2-b amend seam:
  // the manager's Binding record carries no per-file fields). A candidate
  // that ships bin/slp-desk-mcp.mjs always publishes the pin; an older
  // candidate without the file simply omits it.
  try {
    manifest.bridgeSha256 = sha256(
      readFileSync(join(request.candidate.runtimePath, "bin", "slp-desk-mcp.mjs")),
    );
    manifest.bridgeProtocolVersion = DESK_BRIDGE_PROTOCOL;
  } catch {
    /* candidate ships no bridge binary — the pin stays absent */
  }
  return manifest;
}

const manifestBytes = (manifest: LaunchManifest): Buffer =>
  Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");

function launcherScript(
  manifestPath: string,
  manifestSha256: string,
  node: { path: string },
  shimPath: string,
  family: FamilyName,
  role: Role,
): string {
  // `unset NODE_OPTIONS` protects the shim's own node boot: an inherited
  // --require/--import would execute inside the dispatcher before its code
  // runs. POSIX unset, not `env -u`; other SLP_* vars are frozen by the shim.
  return (
    "#!/bin/sh\n" +
    "unset NODE_OPTIONS\n" +
    `exec ${quote(node.path)} ${quote(shimPath)} ${quote(manifestPath)} ` +
    `${quote(manifestSha256)} ${quote(family)} ${quote(role)} -- "$@"\n`
  );
}

/** Phase-2 gate launcher (settings-driven-providers.md §6): a real argv[0]
 *  that exports the frozen family binary and execs the candidate's sentinel
 *  gate under the frozen Node — nothing else is baked because the gate's
 *  only jobs are the grant check and the exec-through. `unset NODE_OPTIONS`
 *  protects the gate's own node boot, same as the shim launcher. The
 *  bare `--version` probe drops provider env entirely, so the binary the
 *  gate answers through must come from these baked bytes, never from env. */
function gateLauncherScript(
  node: { path: string },
  gatePath: string,
  binaryPath: string,
): string {
  return (
    "#!/bin/sh\n" +
    "unset NODE_OPTIONS\n" +
    `export SLP_FAMILY_BIN=${quote(binaryPath)}\n` +
    `exec ${quote(node.path)} ${quote(gatePath)} "$@"\n`
  );
}

interface PlannedFile {
  name: string;
  bytes: Buffer;
  mode: number;
}

/** The set members, deterministic from the manifest and set directory:
 *  launch.json plus the launchers the manifest records — `launcherFamilies`
 *  picks which families get files (absent = all four, the legacy layout),
 *  `gateFamilies` picks which of those are gate execs rather than shim
 *  launchers (absent = all shim). */
function planFiles(manifest: LaunchManifest, directory: string): PlannedFile[] {
  const manifestPath = join(directory, MANIFEST_NAME);
  const digest = sha256(manifestBytes(manifest));
  const shimPath = join(manifest.candidate.path, SHIM_RELATIVE_PATH);
  const gatePath = join(manifest.candidate.path, GATE_RELATIVE_PATH);
  const gate = new Set(manifest.gateFamilies ?? []);
  const files: PlannedFile[] = [
    { name: MANIFEST_NAME, bytes: manifestBytes(manifest), mode: MANIFEST_MODE },
  ];
  for (const family of manifest.launcherFamilies ?? manifest.families) {
    for (const role of manifest.roles) {
      const bytes = gate.has(family)
        ? gateLauncherScript(
            manifest.node,
            gatePath,
            manifest.binaries[family]?.path ?? "",
          )
        : launcherScript(manifestPath, digest, manifest.node, shimPath, family, role);
      files.push({
        name: launcherName(family, role),
        bytes: Buffer.from(bytes, "utf8"),
        mode: LAUNCHER_MODE,
      });
    }
  }
  return files;
}

function parseManifest(bytes: Buffer): LaunchManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new OperationConflict("RUNTIME_INTEGRITY", "launch.json is not valid JSON");
  }
  const m = value as Partial<LaunchManifest> | null;
  function fail(why: string): never {
    throw new OperationConflict("RUNTIME_INTEGRITY", `launch.json ${why}`);
  }
  if (m === null || typeof m !== "object" || Array.isArray(m)) fail("is not an object");
  if (m.schemaVersion !== 1) fail("schemaVersion is not 1");
  if (typeof m.daemonHome !== "string" || !isAbsolute(m.daemonHome)) fail("daemonHome is not absolute");
  const candidate = m.candidate;
  if (
    !candidate ||
    typeof candidate.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.sha256) ||
    typeof candidate.path !== "string" ||
    !isAbsolute(candidate.path)
  ) {
    fail("candidate is malformed");
  }
  const node = m.node;
  if (!node || typeof node.path !== "string" || !isAbsolute(node.path) || typeof node.version !== "string" || node.version.length === 0) {
    fail("node is malformed");
  }
  const binaries = m.binaries;
  if (!binaries || typeof binaries !== "object") fail("binaries is missing");
  for (const family of FAMILIES) {
    const b = (binaries as Record<string, unknown>)[family] as BinaryResolution | undefined;
    if (
      !b ||
      (b.available === true &&
        (typeof b.path !== "string" || !isAbsolute(b.path) || typeof b.version !== "string" || b.version.length === 0)) ||
      (b.available === false && (b.path !== null || b.version !== null)) ||
      (b.available !== true && b.available !== false)
    ) {
      fail(`binaries.${family} is malformed`);
    }
  }
  if (
    !Array.isArray(m.families) ||
    m.families.length !== FAMILIES.length ||
    !FAMILIES.every(f => (m.families as string[]).includes(f)) ||
    !Array.isArray(m.roles) ||
    m.roles.length !== ROLES.length ||
    !ROLES.every(r => (m.roles as string[]).includes(r))
  ) {
    fail("families/roles sets are malformed");
  }
  if (
    m.launcherFamilies !== undefined &&
    (!Array.isArray(m.launcherFamilies) ||
      !m.launcherFamilies.every(f => (FAMILIES as readonly string[]).includes(f)))
  ) {
    fail("launcherFamilies is malformed");
  }
  if (m.gateFamilies !== undefined) {
    const launchers = m.launcherFamilies ?? FAMILIES;
    if (
      !Array.isArray(m.gateFamilies) ||
      !m.gateFamilies.every(f => launchers.includes(f as FamilyName))
    ) {
      fail("gateFamilies is malformed or outside launcherFamilies");
    }
  }
  if (
    m.bridgeSha256 !== undefined &&
    (typeof m.bridgeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.bridgeSha256))
  ) {
    fail("bridgeSha256 is malformed");
  }
  if (m.bridgeProtocolVersion !== undefined && m.bridgeProtocolVersion !== DESK_BRIDGE_PROTOCOL) {
    fail("bridgeProtocolVersion is not the pinned bridge protocol");
  }
  return m as LaunchManifest;
}

async function writeExclusive(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Modes are applied explicitly after writing; creation mode is umask-bound.
  await chmod(path, mode);
}

async function fsyncDir(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPlanned(directory: string, file: PlannedFile): Promise<void> {
  const path = join(directory, file.name);
  let info;
  try {
    // lstat, not stat: a member that is a symlink (to bytes that happen to
    // match) is not an immutable launch-set member and is rejected outright.
    info = await lstat(path);
  } catch {
    throw new OperationConflict("RUNTIME_INTEGRITY", `missing launch-set member ${file.name}`, {
      path,
    });
  }
  if (!info.isFile()) {
    throw new OperationConflict("RUNTIME_INTEGRITY", `launch-set member ${file.name} is not a regular file`, { path });
  }
  const actual = await readFile(path);
  if (!actual.equals(file.bytes)) {
    throw new OperationConflict("RUNTIME_INTEGRITY", `launch-set member ${file.name} bytes differ`, {
      path,
      expectedSha256: sha256(file.bytes),
      actualSha256: sha256(actual),
    });
  }
  // Full permission + special bits: 0o7777 so setuid/setgid/sticky drift is
  // caught, not just the rwx triple.
  const mode = info.mode & 0o7777;
  if (mode !== file.mode) {
    throw new OperationConflict(
      "RUNTIME_INTEGRITY",
      `launch-set member ${file.name} mode ${mode.toString(8)} != ${file.mode.toString(8)}`,
      { path },
    );
  }
}

function validateRequest(request: LaunchSetRequest): void {
  if (!isAbsolute(request.daemonHome)) {
    throw new OperationConflict("INVALID_REQUEST", "daemonHome must be an absolute path");
  }
  if (!isAbsolute(request.stableRoot)) {
    throw new OperationConflict("INVALID_REQUEST", "stableRoot must be an absolute path");
  }
  if (!/^[0-9a-f]{64}$/.test(request.candidate.sha256)) {
    throw new OperationConflict("INVALID_REQUEST", "candidate.sha256 is not a sha256 digest");
  }
  if (!isAbsolute(request.candidate.runtimePath)) {
    throw new OperationConflict("INVALID_REQUEST", "candidate.runtimePath must be absolute");
  }
  if (dirname(request.candidate.runtimePath) !== request.stableRoot) {
    throw new OperationConflict(
      "INVALID_REQUEST",
      "candidate.runtimePath must be a direct child of stableRoot",
      { path: request.candidate.runtimePath },
    );
  }
  if (basename(request.candidate.runtimePath) !== request.candidate.sha256) {
    throw new OperationConflict(
      "INVALID_REQUEST",
      "candidate.runtimePath basename must equal candidate.sha256",
      { path: request.candidate.runtimePath },
    );
  }
  if (!isAbsolute(request.node.path)) {
    throw new OperationConflict("INVALID_REQUEST", "node.path must be absolute");
  }
  // Same operation-id space as materializer.ts OPERATION_ID_RE — both modules
  // stage under .staging/<operationId>/.
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(request.operationId) ||
    request.operationId === "." ||
    request.operationId === ".."
  ) {
    throw new OperationConflict("INVALID_REQUEST", "operationId is not a safe staging name");
  }
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const lstatOrNull = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** mkdir(0700) if absent; whatever exists must be a real directory, never a
 * symlink — same staging discipline as materializer.ts. */
async function ensurePrivateDirectory(directory: string, what: string): Promise<void> {
  try {
    await mkdir(directory, { mode: PRIVATE_DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new OperationConflict("IO_FAILURE", `cannot create ${what}`, { path: directory });
    }
  }
  const info = await lstatOrNull(directory);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw new OperationConflict("RUNTIME_INTEGRITY", `${what} is not a real directory`, {
      path: directory,
    });
  }
}

export function createLauncherBuilder(deps: { platform?: string } = {}): LauncherBuilder {
  const platform = deps.platform ?? process.platform;
  const unsupported = (): never => {
    throw new OperationConflict(
      "UNSUPPORTED_PLATFORM",
      "SLP managed launch is POSIX-only in v1; Windows activation is fail-closed (spec §6).",
    );
  };

  /** lstat every component of the launch-set path inside the stable root:
   * the set directory, its launchers/ parent and the stable root itself must
   * all be real directories — never symlinks. A symlink at any level would
   * silently redirect verification (and every launcher's argv) onto a
   * different launch set (§4 symlink rejection). */
  async function assertRealSetPath(directory: string): Promise<void> {
    const levels = [directory, dirname(directory), dirname(dirname(directory))];
    for (const level of levels) {
      const info = await lstatOrNull(level);
      if (info === null) {
        throw new OperationConflict("RUNTIME_INTEGRITY", `launch set path ${level} does not exist`, {
          path: level,
        });
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new OperationConflict(
          "RUNTIME_INTEGRITY",
          `launch set path ${level} is not a real directory`,
          { path: level },
        );
      }
    }
  }

  async function verifyDirectory(directory: string): Promise<LaunchSet> {
    await assertRealSetPath(directory);
    let real: string;
    try {
      real = await realpath(directory);
    } catch {
      throw new OperationConflict("RUNTIME_INTEGRITY", `launch set ${directory} does not resolve`, {
        path: directory,
      });
    }
    let manifestRaw: Buffer;
    try {
      manifestRaw = await readFile(join(real, MANIFEST_NAME));
    } catch {
      throw new OperationConflict("RUNTIME_INTEGRITY", `launch set ${real} lacks ${MANIFEST_NAME}`, {
        path: real,
      });
    }
    const launchManifestSha256 = sha256(manifestRaw);
    if (basename(real) !== launchManifestSha256) {
      throw new OperationConflict(
        "RUNTIME_INTEGRITY",
        `launch set directory ${basename(real)} does not match its manifest digest`,
        { path: real, expectedSha256: launchManifestSha256 },
      );
    }
    const manifest = parseManifest(manifestRaw);
    // The set is location-bound: its manifest and baked launcher arguments must
    // describe this exact directory layout.
    const stableRoot = dirname(dirname(real));
    if (manifest.daemonHome !== dirname(stableRoot)) {
      throw new OperationConflict(
        "RUNTIME_INTEGRITY",
        `launch.json daemonHome ${manifest.daemonHome} does not match set location`,
        { path: real },
      );
    }
    if (manifest.candidate.path !== join(stableRoot, manifest.candidate.sha256)) {
      throw new OperationConflict(
        "RUNTIME_INTEGRITY",
        "launch.json candidate.path does not match the stable root",
        { path: real },
      );
    }
    const planned = planFiles(manifest, real);
    const names = new Set(planned.map(file => file.name));
    for (const entry of await readdir(real)) {
      if (!names.has(entry)) {
        throw new OperationConflict("RUNTIME_INTEGRITY", `unexpected launch-set member ${entry}`, {
          path: join(real, entry),
        });
      }
    }
    const files: LauncherFileValue[] = [];
    for (const file of planned) {
      await readPlanned(real, file);
      if (file.name !== MANIFEST_NAME) {
        files.push({ path: join(real, file.name), sha256: sha256(file.bytes), mode: file.mode });
      }
    }
    return {
      launchSetSha256: launchManifestSha256,
      launchManifestSha256,
      directory: real,
      files,
      // P2-d — project the verified manifest's bridge pin so the desk
      // bridge can compare it against the packaged/runtime binary without
      // re-reading the manifest a second time.
      ...(manifest.bridgeSha256 !== undefined ? { bridgeSha256: manifest.bridgeSha256 } : {}),
      ...(manifest.bridgeProtocolVersion !== undefined
        ? { bridgeProtocolVersion: manifest.bridgeProtocolVersion }
        : {}),
    };
  }

  return {
    async publish(request: LaunchSetRequest): Promise<LaunchSet> {
      if (platform === "win32") unsupported();
      validateRequest(request);
      const manifest = buildManifest(request);
      const digest = sha256(manifestBytes(manifest));
      const directory = join(request.stableRoot, "launchers", digest);
      if (await pathIsDirectory(directory)) {
        // Same name means the same manifest digest; a verified directory is
        // authoritative, a mismatch is integrity drift — never overwrite.
        return verifyDirectory(directory);
      }
      const stagingRoot = join(request.stableRoot, ".staging");
      await ensurePrivateDirectory(stagingRoot, "staging root");
      const opStaging = join(stagingRoot, request.operationId);
      await ensurePrivateDirectory(opStaging, "operation staging directory");
      const staging = join(opStaging, "launch-set");
      const leftover = await lstatOrNull(staging);
      if (leftover) {
        // A pre-placed symlink or non-directory is never traversed or removed.
        if (leftover.isSymbolicLink() || !leftover.isDirectory()) {
          throw new OperationConflict(
            "RUNTIME_INTEGRITY",
            "symlink or non-directory on staging write path",
            { path: staging },
          );
        }
        await rm(staging, { recursive: true });
      }
      try {
        await mkdir(staging, { mode: PRIVATE_DIR_MODE });
      } catch {
        throw new OperationConflict("IO_FAILURE", "cannot create launch staging directory", {
          path: staging,
        });
      }
      const planned = planFiles(manifest, directory);
      for (const file of planned) {
        await writeExclusive(join(staging, file.name), file.bytes, file.mode);
      }
      await fsyncDir(staging);
      for (const file of planned) {
        await readPlanned(staging, file);
      }
      const launchersRoot = join(request.stableRoot, "launchers");
      await ensurePrivateDirectory(launchersRoot, "launchers root");
      try {
        await rename(staging, directory);
      } catch (error) {
        // A racing publisher may have installed the identical set; verify the
        // winner and discard only this operation's staging.
        if (await pathIsDirectory(directory)) {
          await rm(staging, { recursive: true, force: true });
          return verifyDirectory(directory);
        }
        throw error;
      }
      await fsyncDir(launchersRoot);
      return verifyDirectory(directory);
    },

    async verify(directory: string): Promise<LaunchSet> {
      if (platform === "win32") unsupported();
      return verifyDirectory(directory);
    },
  };
}
