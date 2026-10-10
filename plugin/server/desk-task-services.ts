// Production task services share the desk's verified runtime and repository
// binding. An input checkout can widen IO only within that same Git repository.
import type { DeskStore, LedgerValue } from "./desk-store.ts";
import type { RunnerCtx } from "./desk-runner.ts";
import type { TaskExecutionDeps } from "./desk-task-execution.ts";
import type { TaskHostApi } from "./desk-task-execution-host.ts";
import type { TaskRuntimeApi } from "./desk-task-runtime.ts";
import { createTaskRepositoryAccess } from "./desk-task-access.ts";
import { createTaskBoundedHost } from "./desk-task-host.ts";
import { createTaskRuntimeResolver } from "./desk-task-runtime.ts";
import { boundedArgv, createBoundedMeasure, createContentMapMeasure } from "./desk-task-execution-host.ts";
import { runTaskCommand, runTaskEffect } from "./desk-task.ts";

export async function createTaskServices(input: {
  ctx: RunnerCtx;
  ledger: Readonly<LedgerValue>;
  store: DeskStore;
  binding: { runtimePath: string; nodePath: string };
  stableRoot: string;
  daemonHome: string;
  host: () => (TaskHostApi & TaskRuntimeApi) | null;
  checkoutRoots?: string[];
  now: () => Date;
}): Promise<TaskExecutionDeps> {
  const access = await createTaskRepositoryAccess({
    repo: input.ledger.repo,
    repoKey: input.ctx.repoKey,
    createCwd: input.ctx.row.createCwd,
    stableRoot: input.stableRoot,
    checkoutRoots: input.checkoutRoots,
  });
  const host = () => {
    const connected = input.host();
    return connected === null ? null : createTaskBoundedHost(connected);
  };
  const measure = createBoundedMeasure({ ...input.binding, now: input.now });
  return {
    store: input.store,
    task: { runTaskCommand, runTaskEffect },
    host,
    measure: async root => {
      access.fs.resolve(root);
      if (await access.git.commonDir(root) !== input.ledger.repo.gitCommonDir) {
        throw new Error("task measurement is outside the bound repository");
      }
      return measure(root);
    },
    measureContentMap: createContentMapMeasure(access.fs, input.now),
    exec: boundedArgv(),
    fs: access.fs,
    git: access.git,
    scratch: { stableRoot: input.stableRoot },
    resolveSeat: createTaskRuntimeResolver({
      runtimePath: input.binding.runtimePath,
      daemonHome: input.daemonHome,
      host,
    }),
    now: input.now,
  };
}
