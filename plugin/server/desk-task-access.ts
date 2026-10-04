// Build task IO from the bound repository and a private per-repository root.
// A declared target path never expands access to another Git repository.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { assertRealComponents, ensurePrivateDirectory } from "./kept-files.ts";
import { repoKeyFor } from "./runtime/desk-paths.ts";
import { createTaskFsIo, createTaskGitIo } from "./desk-task-execution-host.ts";
import type { TaskGitIo } from "./desk-task-execution-host.ts";

const MAX_CHECKOUT_ROOTS = 64;

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
    if (await git.commonDir(canonical) !== input.repo.gitCommonDir) {
      throw new Error("task checkout is outside the bound repository");
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
