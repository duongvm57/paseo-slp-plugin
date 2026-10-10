// Async safety mechanisms for plugin-only immutable candidate/launch-set
// publication. Verification, collision policy and lifecycle stay with callers.
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { OperationConflict } from "../shared/contracts.ts";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./runtime/filesystem.ts";
export { PRIVATE_DIR_MODE } from "./runtime/filesystem.ts";

export function isSafeStagingOperationId(operationId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(operationId)
    && operationId !== "." && operationId !== "..";
}

/** After caller validation: materializer claims operation; launchers re-enters
 * it and owns only launchSet. Never change this shared on-disk namespace. */
export function publicationStagingPaths(stableRoot: string, operationId: string) {
  const root = join(stableRoot, ".staging");
  const operation = join(root, operationId);
  return { root, operation, launchSet: join(operation, "launch-set") };
}

export async function lstatOrNull(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Callers retain their write/chmod/sync/close order and failure mapping. */
export const openExclusiveFile = (path: string) => open(path, "wx", PRIVATE_FILE_MODE);

/** Only mkdir failures carry this tag: lstat errors must keep their precedence
 * and propagate, while each domain maps creation failures to its own wording. */
export class PrivateDirectoryCreationError extends Error {
  constructor(cause: unknown) {
    super("cannot create private publication directory", { cause });
  }
}

/** A racing mkdir's EEXIST is allowed only after proving the path real. */
export async function ensurePrivateDirectory(directory: string, what: string): Promise<void> {
  try { await mkdir(directory, { mode: PRIVATE_DIR_MODE }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new PrivateDirectoryCreationError(error);
    }
  }
  const info = await lstatOrNull(directory);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw new OperationConflict("RUNTIME_INTEGRITY", `${what} is not a real directory`, {
      path: directory,
    });
  }
}

/** Observe in caller-specified order and stop at the first gap/refusal. The
 * domain decides whether a missing level means return or integrity failure. */
export async function inspectDirectoryChain(
  levels: readonly string[],
): Promise<{ kind: "missing" | "unsafe"; path: string } | null> {
  for (const path of levels) {
    const info = await lstatOrNull(path);
    if (!info) return { kind: "missing", path };
    if (info.isSymbolicLink() || !info.isDirectory()) return { kind: "unsafe", path };
  }
  return null;
}
