// Build task IO from the bound repository and a private per-repository root.
// A declared target path never expands access to another Git repository.
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { assertRealComponents, ensurePrivateDirectory } from "./kept-files.ts";
import { repoKeyFor } from "./runtime/desk-paths.ts";
import { createTaskFsIo, createTaskGitIo } from "./desk-task-execution-host.ts";
import type { TaskGitIo } from "./desk-task-execution-host.ts";
import { credentialShaped } from "../shared/runtime/jev-transport.ts";

const MAX_CHECKOUT_ROOTS = 64;

/** Names are display hints; only canonical common-dir equality grants access.
 * Nonstandard/bare Git directories use their metadata name instead. */
function repositoryIdentity(commonDir: string): string {
  const anchor = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
  const rawName = basename(anchor);
  const printable = rawName.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  // Detect before truncation and on both forms: stripping a tab can hide a
  // Bearer match, while stripping an inserted format character can reveal one.
  const safeName = credentialShaped(rawName) || credentialShaped(printable) ? "<redacted>" : printable;
  const name = Array.from(safeName).slice(0, 24).join("") || "unknown";
  const hash = createHash("sha256").update(commonDir).digest("hex").slice(0, 12);
  return `${JSON.stringify(name)} (${hash})`;
}

/** Both readable identities fit the bridge's 240-character diagnostic slice. */
export class TaskRepositoryMismatchError extends Error {
  readonly recovery = "bind the Lead to the task's Git repository or form its seat in that repository's workspace under the assignment; preserve outstanding effects for reconciliation";

  constructor(expected: string, actual: string) {
    super(`task checkout belongs to a different Git repository; expected repo ${repositoryIdentity(expected)}, actual repo ${repositoryIdentity(actual)}`);
  }
}

export async function createTaskRepositoryAccess(input: {
  repo: { hostId: string; gitCommonDir: string };
  repoKey: string;
  createCwd: string;
  stableRoot: string;
  checkoutRoots?: string[];
}, git: TaskGitIo = createTaskGitIo()) {
  if (repoKeyFor(input.repo) !== input.repoKey) throw new Error("task repository key does not match its binding");
  const requested = [...new Set([input.createCwd, ...(input.checkoutRoots ?? [])])];
  if (requested.length > MAX_CHECKOUT_ROOTS) throw new Error("task checkout root limit exceeded");
  const roots = new Set<string>();
  for (const path of requested) {
    const canonical = realpathSync(path);
    const actualCommonDir = await git.commonDir(canonical);
    if (actualCommonDir !== input.repo.gitCommonDir) {
      throw new TaskRepositoryMismatchError(input.repo.gitCommonDir, actualCommonDir);
    }
    roots.add(await git.top(canonical));
  }
  const stableRoot = realpathSync(input.stableRoot);
  const namespace = join(stableRoot, "task-exec");
  const privateRoot = join(namespace, input.repoKey);
  assertRealComponents(stableRoot, privateRoot, "task execution root");
  ensurePrivateDirectory(namespace, process.platform);
  ensurePrivateDirectory(privateRoot, process.platform);
  return { fs: createTaskFsIo([...roots, privateRoot]), git, privateRoot };
}
