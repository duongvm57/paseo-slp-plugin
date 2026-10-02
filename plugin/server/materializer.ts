// Immutable candidate install-unit publication for the paseo-slp manager
// plugin (spec §5). The embedded payload is server-bundled; no runtime fetch
// or checkout read is permitted here. Publication is stage → verify → fsync →
// rename; a verified existing directory is reused, a mismatch is
// RUNTIME_INTEGRITY and is never repaired in place. This module writes no
// journal — operation intent is the manager's job.
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { OperationConflict } from "../shared/contracts.ts";
import type { EmbeddedPayload, Materializer, MaterializeResult } from "../shared/contracts.ts";

const sha256hex = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");
// The §5 candidate identity serializer (same shape as plugin/server/runtime/cli/package.ts `json`;
// the plugin boundary forbids importing it). Distinct from the §7 canonical
// receipt JSON.
const prettyJson = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

const SHA256_RE = /^[0-9a-f]{64}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

interface DecodedFile {
  path: string;
  sha256: string;
  mode: number;
  bytes: Buffer;
}

const integrity = (message: string, path?: string | null, detail?: { expectedSha256?: string | null; actualSha256?: string | null }) =>
  new OperationConflict("RUNTIME_INTEGRITY", message, { path: path ?? null, ...detail });

const ioFailure = (error: unknown, message: string, path?: string | null) =>
  new OperationConflict("IO_FAILURE", `${message}: ${error instanceof Error ? error.message : String(error)}`, { path: path ?? null });

/** §5 lexical rules: relative POSIX keys only — no absolute/drive-prefixed
 * paths, no empty/dot/dot-dot components, no backslash or NUL. */
const isValidPayloadPath = (path: unknown): path is string =>
  typeof path === "string" && path.length > 0 && path.length <= 4096
  && !path.includes("\0") && !path.includes("\\")
  && !path.startsWith("/") && !/^[A-Za-z]:/.test(path)
  && path.split("/").every(part => part !== "" && part !== "." && part !== "..");

const isSortedUnique = (paths: string[]): boolean =>
  paths.every((path, index) => index === 0 || paths[index - 1] < path);

/** Step 1: validate the whole embedded payload in memory — every path, hash,
 * mode, the candidate identity and the payload digest — before any filesystem
 * access. Returns decoded bytes keyed by payload order. */
const validatePayload = (payload: EmbeddedPayload): DecodedFile[] => {
  if (!payload || typeof payload !== "object" || payload.schemaVersion !== 1) {
    throw integrity("unsupported embedded payload schema");
  }
  const { candidate, files } = payload;
  if (!candidate || !SHA256_RE.test(candidate.sha256 ?? "") || !Array.isArray(candidate.files)
    || !SHA256_RE.test(payload.payloadSha256 ?? "") || !Array.isArray(files)) {
    throw integrity("malformed embedded payload");
  }
  const decoded: DecodedFile[] = files.map(file => {
    if (!isValidPayloadPath(file?.path) || !SHA256_RE.test(file?.sha256 ?? "")
      || !Number.isInteger(file?.mode) || file.mode < 0 || file.mode > 0o777
      || typeof file?.base64 !== "string") {
      throw integrity("invalid embedded file entry", typeof file?.path === "string" ? file.path : null);
    }
    const bytes = Buffer.from(file.base64, "base64");
    if (sha256hex(bytes) !== file.sha256) {
      throw integrity("embedded file bytes do not match declared sha256", file.path,
        { expectedSha256: file.sha256, actualSha256: sha256hex(bytes) });
    }
    return { path: file.path, sha256: file.sha256, mode: file.mode, bytes };
  });
  const paths = decoded.map(file => file.path);
  if (!isSortedUnique(paths)) throw integrity("embedded payload paths are not strictly sorted");
  if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length) {
    throw integrity("case-colliding embedded payload paths");
  }
  const candidateFiles = decoded.map(({ path, sha256 }) => ({ path, sha256 }));
  if (JSON.stringify(candidate.files) !== JSON.stringify(candidateFiles)) {
    throw integrity("embedded candidate file list does not match payload files");
  }
  if (sha256hex(prettyJson(candidate.files)) !== candidate.sha256) {
    throw integrity("embedded candidate sha256 mismatch", null,
      { expectedSha256: candidate.sha256, actualSha256: sha256hex(prettyJson(candidate.files)) });
  }
  const modes = decoded.map(({ path, sha256, mode }) => ({ path, sha256, mode }));
  if (sha256hex(prettyJson(modes)) !== payload.payloadSha256) {
    throw integrity("embedded payloadSha256 mismatch");
  }
  return decoded;
};

const lstatOrNull = async (path: string) => {
  try { return await fsp.lstat(path); } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const fsyncDirectory = async (path: string): Promise<void> => {
  const handle = await fsp.open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
};

/** Per-file expectation. mode:null means "no recorded mode — require only
 * that no setuid/setgid/sticky bits are set" (foreign-only files); a numeric
 * mode requires an exact 0o7777 match. sha256:null skips the byte digest
 * (installed.json is verified by content instead). */
interface TreeSpec { sha256: string | null; mode: number | null }

/** Walk a candidate directory, rejecting symlinks and non-regular entries. */
const collectTree = async (directory: string): Promise<{ files: string[]; dirs: string[] }> => {
  const files: string[] = [];
  const dirs: string[] = [];
  const collect = async (relative: string): Promise<void> => {
    let entries;
    try { entries = await fsp.readdir(join(directory, relative), { withFileTypes: true }); }
    catch (error) { throw ioFailure(error, "cannot read candidate directory", join(directory, relative)); }
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw integrity("symlink inside published candidate", path);
      if (entry.isDirectory()) { dirs.push(path); await collect(path); }
      else if (entry.isFile()) files.push(path);
      else throw integrity("non-regular entry inside published candidate", path);
    }
  };
  await collect("");
  files.sort();
  return { files, dirs };
};

const verifyTreeShape = (files: string[], dirs: string[], expectedPaths: string[]): void => {
  const sortedExpected = [...expectedPaths].sort();
  const expectedDirs = new Set(sortedExpected.flatMap(path => {
    const parts = path.split("/");
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
  }));
  for (const directory of dirs) {
    if (!expectedDirs.has(directory)) throw integrity("unexpected directory inside published candidate", directory);
  }
  if (JSON.stringify(files) !== JSON.stringify(sortedExpected)) {
    const missing = sortedExpected.filter(path => !files.includes(path));
    const extra = files.filter(path => !sortedExpected.includes(path));
    throw integrity(`candidate file set diverged (missing: ${missing.join(",") || "none"}; extra: ${extra.join(",") || "none"})`,
      missing[0] ?? extra[0] ?? null);
  }
};

const verifyTreeFile = async (directory: string, path: string, spec: TreeSpec): Promise<void> => {
  const absolute = join(directory, path);
  const stat = await lstatOrNull(absolute);
  if (!stat) throw integrity("missing candidate file", path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw integrity("candidate entry is not a regular file", path);
  if (spec.mode === null) {
    if (stat.mode & 0o7000) {
      throw integrity(`candidate file carries special mode bits: ${(stat.mode & 0o7777).toString(8)}`, path);
    }
  } else if ((stat.mode & 0o7777) !== spec.mode) {
    throw integrity(`candidate file mode diverged: expected ${spec.mode.toString(8)}, found ${(stat.mode & 0o7777).toString(8)}`, path);
  }
  if (spec.sha256 !== null) {
    const actualSha = sha256hex(await fsp.readFile(absolute));
    if (actualSha !== spec.sha256) {
      throw integrity("candidate file bytes diverged", path,
        { expectedSha256: spec.sha256, actualSha256: actualSha });
    }
  }
};

const verifyTree = async (directory: string, specs: Map<string, TreeSpec>): Promise<void> => {
  const { files, dirs } = await collectTree(directory);
  const expectedPaths = [...specs.keys()];
  verifyTreeShape(files, dirs, expectedPaths);
  for (const path of expectedPaths) await verifyTreeFile(directory, path, specs.get(path)!);
};

const readReceipt = async (directory: string): Promise<{ source?: unknown; candidate?: unknown }> => {
  let receipt: { source?: unknown; candidate?: unknown };
  try { receipt = JSON.parse(await fsp.readFile(join(directory, "installed.json"), "utf8")); }
  catch { throw integrity("installed.json is missing or not readable JSON", join(directory, "installed.json")); }
  return receipt;
};

/** The sorted {path, sha256, mode} list — the payloadSha256 record, and the
 * auxiliary per-file mode record written into installed.json since round 4
 * (candidate.files itself must stay {path,sha256} for verifyInstall). */
const modeRecords = (payload: EmbeddedPayload): { path: string; sha256: string; mode: number }[] =>
  payload.files.map(({ path, sha256, mode }) => ({ path, sha256, mode }));

/** Exact verification of a published candidate directory: the file set must be
 * exactly the payload files plus installed.json — every entry a regular file
 * (no symlinks), byte-identical, with the recorded permission bits and no
 * setuid/setgid/sticky drift — and installed.json must carry this candidate. */
const verifyCandidateTree = async (directory: string, payload: EmbeddedPayload): Promise<void> => {
  const specs = new Map<string, TreeSpec>(
    payload.files.map(file => [file.path, { sha256: file.sha256, mode: file.mode }]),
  );
  specs.set("installed.json", { sha256: null, mode: 0o600 });
  await verifyTree(directory, specs);
  const receipt = await readReceipt(directory) as { source?: unknown; candidate?: unknown; files?: unknown };
  if (receipt.source !== `embedded:${payload.candidate.sha256}`
    || JSON.stringify(receipt.candidate) !== JSON.stringify(payload.candidate)) {
    throw integrity("installed.json does not record this candidate", join(directory, "installed.json"));
  }
  // Receipts written before the mode record existed lack `files`; when present
  // it must equal this candidate's recorded modes exactly.
  if (receipt.files !== undefined
    && JSON.stringify(receipt.files) !== JSON.stringify(modeRecords(payload))) {
    throw integrity("installed.json file-mode record diverges from this candidate", join(directory, "installed.json"));
  }
};

/** Self-consistency verification of a recorded foreign candidate (§8
 * rebind/retained/restore paths): installed.json must anchor the recorded
 * sha, and the tree must match the candidate's own record — never the current
 * embedded payload. The `files` mode record is mandatory and hash-anchored:
 * its pretty-JSON digest must equal the recorded payloadSha256, so tampering
 * file modes or the mode record breaks the anchor. Receipts lacking the mode
 * record fail closed. A directory whose only evidence is its name is never
 * accepted. */
const verifyForeignCandidateTree = async (
  directory: string,
  candidateSha256: string,
  payloadSha256: string,
): Promise<void> => {
  const receipt = await readReceipt(directory) as {
    source?: unknown; candidate?: unknown; files?: unknown;
  };
  if (receipt.source !== `embedded:${candidateSha256}`) {
    throw integrity("installed.json does not record an embedded source for this candidate", join(directory, "installed.json"));
  }
  const candidate = receipt.candidate as { sha256?: unknown; files?: unknown } | undefined;
  if (!candidate || candidate.sha256 !== candidateSha256 || !Array.isArray(candidate.files)) {
    throw integrity("installed.json does not record this candidate", join(directory, "installed.json"));
  }
  const entries = candidate.files as { path?: unknown; sha256?: unknown }[];
  for (const entry of entries) {
    if (!isValidPayloadPath(entry?.path) || typeof entry?.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      throw integrity("installed.json records an invalid candidate file entry", join(directory, "installed.json"));
    }
  }
  const entryPaths = entries.map(entry => entry.path as string);
  if (!isSortedUnique(entryPaths)) {
    throw integrity("installed.json candidate files are not strictly sorted", join(directory, "installed.json"));
  }
  if (sha256hex(prettyJson(entries)) !== candidateSha256) {
    throw integrity("installed.json candidate sha does not match its recorded file list", join(directory, "installed.json"));
  }

  // The mode record is mandatory and hash-anchored: sha256 of its pretty-JSON
  // serialization must equal the recorded payloadSha256, binding every file
  // mode to the caller's recorded identity.
  if (!Array.isArray(receipt.files)) {
    throw integrity("installed.json lacks a readable file-mode record", join(directory, "installed.json"));
  }
  const records = receipt.files as { path?: unknown; sha256?: unknown; mode?: unknown }[];
  for (const record of records) {
    if (!isValidPayloadPath(record?.path) || typeof record?.sha256 !== "string" || !SHA256_RE.test(record.sha256)
      || !Number.isInteger(record?.mode) || (record.mode as number) < 0 || (record.mode as number) > 0o777) {
      throw integrity("installed.json records an invalid file-mode entry", join(directory, "installed.json"));
    }
  }
  const recordPaths = records.map(record => record.path as string);
  if (!isSortedUnique(recordPaths)) {
    throw integrity("installed.json file-mode records are not strictly sorted", join(directory, "installed.json"));
  }
  if (sha256hex(prettyJson(records)) !== payloadSha256) {
    throw integrity("installed.json file-mode record does not match the recorded payload identity", join(directory, "installed.json"),
      { expectedSha256: payloadSha256, actualSha256: sha256hex(prettyJson(records)) });
  }
  // The mode record must describe exactly the candidate's anchored file set.
  if (JSON.stringify(records.map(({ path, sha256 }) => ({ path, sha256 }))) !== JSON.stringify(entries)) {
    throw integrity("installed.json file-mode record diverges from its candidate record", join(directory, "installed.json"));
  }
  const specs = new Map<string, TreeSpec>(records.map(record => [
    record.path as string,
    { sha256: record.sha256 as string, mode: record.mode as number },
  ]));
  specs.set("installed.json", { sha256: null, mode: 0o600 });
  await verifyTree(directory, specs);
};

const validOperationId = (operationId: string): void => {
  if (!OPERATION_ID_RE.test(operationId) || operationId === "." || operationId === "..") {
    throw new OperationConflict("INVALID_REQUEST", `invalid operation id: ${JSON.stringify(operationId)}`);
  }
};

/** Create `directory` privately (0700) if absent; a concurrent creator's
 * EEXIST is fine, but whatever exists must be a real directory. */
const ensurePrivateDirectory = async (directory: string, what: string): Promise<void> => {
  try { await fsp.mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw ioFailure(error, `cannot create ${what}`, directory);
    }
  }
  const stat = await lstatOrNull(directory);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw integrity(`${what} is not a real directory`, directory);
  }
};

const ensureStableRoot = async (stableRoot: string): Promise<string> => {
  const absolute = resolve(stableRoot);
  await ensurePrivateDirectory(absolute, "stable root");
  try { return await fsp.realpath(absolute); }
  catch (error) { throw ioFailure(error, "cannot resolve stable root", absolute); }
};

/** `<stable>/.staging` exists and is a real private directory. */
const ensureStagingRoot = async (stable: string): Promise<string> => {
  const stagingRoot = join(stable, ".staging");
  const existed = await lstatOrNull(stagingRoot);
  await ensurePrivateDirectory(stagingRoot, "staging root");
  if (!existed) await fsyncDirectory(stable).catch(() => {});
  return stagingRoot;
};

/** mkdir for every missing parent component of `target` under `staging`;
 * every component encountered must be a real directory, never a symlink. */
const ensureParents = async (staging: string, target: string): Promise<void> => {
  const created: string[] = [];
  let current = dirname(target);
  while (current !== staging && current.startsWith(`${staging}/`)) {
    const stat = await lstatOrNull(current);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw integrity("symlink or non-directory on staging write path", current);
      }
      break;
    }
    created.unshift(current);
    current = dirname(current);
  }
  for (const directory of created) {
    try { await fsp.mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const stat = await lstatOrNull(directory);
        if (stat && stat.isDirectory() && !stat.isSymbolicLink()) continue;
      }
      throw ioFailure(error, "cannot create staging directory", directory);
    }
  }
};

export function createMaterializer(payload: EmbeddedPayload): Materializer {
  // Payload validation is pure and identical for every call; run it once at
  // factory time so a corrupt bundle fails before any operation starts.
  const decoded = validatePayload(payload);
  const candidateSha = payload.candidate.sha256;

  const verifyPublished = async (runtimePath: string, candidateSha256: string, payloadSha256: string): Promise<void> => {
    if (!SHA256_RE.test(candidateSha256)) {
      throw new OperationConflict("INVALID_REQUEST", `invalid candidate sha256: ${JSON.stringify(candidateSha256)}`);
    }
    if (!SHA256_RE.test(payloadSha256)) {
      throw new OperationConflict("INVALID_REQUEST", `invalid payload sha256: ${JSON.stringify(payloadSha256)}`);
    }
    const directory = resolve(runtimePath);
    if (basename(directory) !== candidateSha256) {
      throw integrity("published path does not name the recorded candidate", directory);
    }
    const stat = await lstatOrNull(directory);
    if (!stat) throw integrity("published candidate is missing", directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw integrity("published candidate is not a real directory", directory);
    }
    if (candidateSha256 === candidateSha) {
      // The recorded pair must equal the embedded payload's identity.
      if (payloadSha256 !== payload.payloadSha256) {
        throw integrity("recorded payload identity does not match the embedded candidate", directory,
          { expectedSha256: payload.payloadSha256, actualSha256: payloadSha256 });
      }
      await verifyCandidateTree(directory, payload);
    } else {
      await verifyForeignCandidateTree(directory, candidateSha256, payloadSha256);
    }
  };

  const discardStaging = async (stableRoot: string, operationId: string): Promise<void> => {
    validOperationId(operationId);
    const stable = await lstatOrNull(resolve(stableRoot));
    if (!stable || stable.isSymbolicLink() || !stable.isDirectory()) return;
    const root = await fsp.realpath(resolve(stableRoot));
    // Verify the whole managed ancestor chain before any removal: every level
    // from the canonical root through .staging down to <operationId> must be a
    // real directory. A symlink (or other non-directory) at any level means
    // the path no longer names our staging — delete nothing, leave it all.
    const staging = join(root, ".staging", operationId);
    for (const level of [join(root, ".staging"), staging]) {
      const stat = await lstatOrNull(level);
      if (!stat) return;
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw integrity("refusing to discard staging through a non-directory chain entry", level);
      }
    }
    try { await fsp.rm(staging, { recursive: true }); }
    catch (error) { throw ioFailure(error, "cannot discard staging", staging); }
  };

  const materialize = async (stableRoot: string, operationId: string): Promise<MaterializeResult> => {
    validOperationId(operationId);
    const stable = await ensureStableRoot(stableRoot);
    const destination = join(stable, candidateSha);

    // Step 2: an existing destination is reused only on exact match; any
    // divergence (including an interrupted candidate without a valid manifest)
    // is RUNTIME_INTEGRITY, never an in-place repair or overwrite.
    const existing = await lstatOrNull(destination);
    if (existing) {
      await verifyPublished(destination, candidateSha, payload.payloadSha256);
      return { candidateSha256: candidateSha, payloadSha256: payload.payloadSha256, runtimePath: destination, reused: true };
    }

    // Step 3: exclusive private staging on the same filesystem.
    const stagingRoot = await ensureStagingRoot(stable);
    const staging = join(stagingRoot, operationId);
    try { await fsp.mkdir(staging, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new OperationConflict("COLLISION", "staging directory already exists for this operation", { path: staging });
      }
      throw ioFailure(error, "cannot create staging directory", staging);
    }

    const directories = new Set<string>();
    try {
      for (const file of decoded) {
        const target = join(staging, file.path);
        await ensureParents(staging, target);
        for (let dir = dirname(target); dir !== staging; dir = dirname(dir)) directories.add(dir);
        let handle;
        try { handle = await fsp.open(target, "wx", 0o600); }
        catch (error) { throw ioFailure(error, "cannot exclusively create staged file", target); }
        try {
          await handle.writeFile(file.bytes);
          await handle.chmod(file.mode);
          await handle.sync();
        } catch (error) {
          throw ioFailure(error, "cannot write staged file", target);
        } finally {
          await handle.close();
        }
        // Verify each file back from disk: regular file, exact mode, exact bytes.
        const stat = await lstatOrNull(target);
        if (!stat || stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o7777) !== file.mode) {
          throw integrity("staged file failed disk verification", file.path);
        }
        const actualSha = sha256hex(await fsp.readFile(target));
        if (actualSha !== file.sha256) {
          throw integrity("staged file bytes failed disk verification", file.path,
            { expectedSha256: file.sha256, actualSha256: actualSha });
        }
      }

      // Step 4: installed.json receipt — embedded source marker plus the exact
      // candidate and its mode record (`files`); no paseoBindingSha256 (the
      // plugin receipt is external). `candidate` stays {sha256, files:
      // [{path,sha256}]} so the production verifyInstall() contract holds;
      // `files` records modes for later foreign-candidate verification.
      const receipt = join(staging, "installed.json");
      const receiptBytes = prettyJson({
        source: `embedded:${candidateSha}`,
        candidate: payload.candidate,
        files: modeRecords(payload),
      });
      let receiptHandle;
      try { receiptHandle = await fsp.open(receipt, "wx", 0o600); }
      catch (error) { throw ioFailure(error, "cannot write installed.json", receipt); }
      try {
        await receiptHandle.writeFile(receiptBytes);
        await receiptHandle.sync();
      } catch (error) {
        throw ioFailure(error, "cannot write installed.json", receipt);
      } finally {
        await receiptHandle.close();
      }

      // Step 5: fsync every touched directory, then publish by rename.
      for (const directory of directories) await fsyncDirectory(directory);
      await fsyncDirectory(staging);
      await fsyncDirectory(stagingRoot);
      try {
        await fsp.rename(staging, destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EISDIR") {
          // Another publisher won: verify its destination completely, then
          // drop only this operation's staging (finally below).
          await verifyPublished(destination, candidateSha, payload.payloadSha256);
          return { candidateSha256: candidateSha, payloadSha256: payload.payloadSha256, runtimePath: destination, reused: true };
        }
        throw ioFailure(error, "cannot publish staged candidate", destination);
      }
      try { await fsyncDirectory(stable); } catch (error) { throw ioFailure(error, "cannot flush stable root", stable); }
      // Reverify the published destination after rename.
      await verifyCandidateTree(destination, payload);
      return { candidateSha256: candidateSha, payloadSha256: payload.payloadSha256, runtimePath: destination, reused: false };
    } finally {
      // Discard only this operation's unpublished staging; published
      // directories and other operations' staging are never touched. The
      // .staging ancestor must still be a real directory — a symlinked
      // ancestor means the path no longer names our staging, so delete
      // nothing and leave the rejected tree untouched (X1).
      const ancestor = await lstatOrNull(stagingRoot);
      const leaf = await lstatOrNull(staging);
      if (ancestor && ancestor.isDirectory() && !ancestor.isSymbolicLink()
        && leaf && leaf.isDirectory() && !leaf.isSymbolicLink()) {
        try { await fsp.rm(staging, { recursive: true }); }
        catch { /* staging cleanup is best-effort; recovery reconciles it */ }
      }
    }
  };

  return { materialize, verifyPublished, discardStaging };
}
