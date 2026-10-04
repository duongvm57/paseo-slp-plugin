// Bound task SDK calls without treating an expired wait as cancellation.
// Effect callers retain the durable intent and reconcile a late host result.
import type { TaskAgentHandle, TaskHostApi } from "./desk-task-execution-host.ts";
import type { TaskRuntimeApi } from "./desk-task-runtime.ts";

type ConnectedTaskApi = TaskHostApi & TaskRuntimeApi;
type HostBudgets = { readMs: number; effectMs: number };
const DEFAULT_BUDGETS: HostBudgets = { readMs: 8000, effectMs: 20000 };

export class TaskHostWaitExpired extends Error {
  readonly operation: string;
  readonly effectMayContinue: boolean;
  constructor(operation: string, effectMayContinue: boolean) {
    super(`task host ${operation} wait expired; ${effectMayContinue ? "the effect may still complete" : "no observation was established"}`);
    this.name = "TaskHostWaitExpired";
    this.operation = operation;
    this.effectMayContinue = effectMayContinue;
  }
}

export function createTaskBoundedHost(
  api: ConnectedTaskApi,
  budgets: Partial<HostBudgets> = {},
): ConnectedTaskApi {
  const limits = { ...DEFAULT_BUDGETS, ...budgets };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("task host wait budgets must be positive integers");
  }
  const call = async <T>(operation: string, effect: boolean, invoke: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(invoke),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TaskHostWaitExpired(operation, effect)), effect ? limits.effectMs : limits.readMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const handle = (agent: TaskAgentHandle): TaskAgentHandle => ({
    id: agent.id,
    refresh: requestId => call("refresh", false, () => agent.refresh(requestId)),
    send: (text, options) => call("send", true, () => agent.send(text, options)),
    archive: () => call("archive", true, () => agent.archive()),
    waitForFinish: timeoutMs => call("waitForFinish", false, () => agent.waitForFinish(timeoutMs)),
    timeline: { refetch: options => call("timeline", false, () => agent.timeline.refetch(options)) },
  });
  return {
    providers: { snapshot: options => call("providers.snapshot", false, () => api.providers.snapshot(options)) },
    agents: {
      ref: id => handle(api.agents.ref(id)),
      create: async options => handle(await call("create", true, () => api.agents.create(options))),
      list: options => call("list", false, () => api.agents.list(options)),
    },
    workspaces: {
      ref: id => ({
        agents: {
          create: async options => handle(await call("workspace.create", true, () => api.workspaces.ref(id).agents.create(options))),
        },
      }),
    },
  };
}
