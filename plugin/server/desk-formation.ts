// One ordinary/Lean invocation: fresh plan → durable issue → native create
// without work → positive tuple observation → durable send. No queue needed.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { candidateModulePath } from "./candidate-module.ts";
import { canonicalSha256, profilesArray, readRawConfig } from "./config-view.ts";
import { createDeskOperations, type OperationIdentity } from "./desk-operation.ts";
import { verifySeat } from "./desk-task-execution.ts";
import { createTaskBoundedHost } from "./desk-task-host.ts";
import type { TaskHostApi } from "./desk-task-execution-host.ts";
import type { TaskRuntimeApi } from "./desk-task-runtime.ts";
import type { DeskRejectionValue } from "../shared/enforcement.ts";
import type { DeskSeatCreateInputValue } from "../shared/delegation.ts";
import type { MembershipValue } from "./desk-store.ts";

type ModeSupport = { provider: string; modes: string[] };
type Plan = {
  create: { provider: string; workspaceId: string; title: string; initialPrompt: string;
    settings: { modeId?: string; thinkingOptionId?: string; features: Record<string, unknown> } };
  modeSupport: ModeSupport;
  profileId?: string; routing?: unknown; warnings?: string[];
};
type FormationRequest = {
  repository: string; workspaceId: string; role: string; assignment: string; taskLabel: string;
  paseoHome: string; providers: { id: string; enabled: boolean; status: string }[];
  profiles?: unknown[]; route?: unknown;
};
type FormationModule = { launchPlan(root: string, request: FormationRequest): Omit<Plan, "modeSupport"> };
const reject = (code: DeskRejectionValue["code"], message: string): DeskRejectionValue => ({
  ok: false, code, message,
  recovery: "inspect retained formation evidence; resolve the missing capability or drift without repeating an uncertain create/send",
});
export class FormationPlanningError extends Error {
  readonly code: DeskRejectionValue["code"];
  constructor(code: DeskRejectionValue["code"], message: string) { super(message); this.code = code; }
}

export function createFormationPlanner(deps: {
  runtimePath: string; daemonHome: string; host: () => (TaskHostApi & TaskRuntimeApi) | null;
  importModule?: (specifier: string) => Promise<unknown>;
}) {
  return async (row: MembershipValue, input: DeskSeatCreateInputValue): Promise<Plan> => {
    if (row.workspaceId === null) throw new FormationPlanningError("CAPABILITY_GAP", "formation requires the caller's exact workspace");
    const host = deps.host();
    if (host === null) throw new FormationPlanningError("CAPABILITY_GAP", "connected host unavailable");
    const load = deps.importModule ?? (specifier => import(specifier));
    let launch: FormationModule;
    try { launch = await load(pathToFileURL(candidateModulePath(deps.runtimePath, "launch")).href) as FormationModule; }
    catch { throw new FormationPlanningError("RUNTIME_INTEGRITY", "the bound candidate launch module is unavailable"); }
    const saved = () => profilesArray(readRawConfig(join(deps.daemonHome, "config.json")).json).value;
    let profiles: unknown[] | undefined;
    try { profiles = input.role === "lead" ? saved() : undefined; }
    catch { throw new FormationPlanningError("INVALID_RECORD", "saved profile configuration is unreadable or invalid"); }
    let observed: Awaited<ReturnType<TaskRuntimeApi["providers"]["snapshot"]>>;
    try { observed = await createTaskBoundedHost(host).providers.snapshot({ cwd: row.createCwd }); }
    catch { throw new FormationPlanningError("CAPABILITY_GAP", "connected provider snapshot failed"); }
    if (observed.error) throw new FormationPlanningError("CAPABILITY_GAP", "connected provider snapshot failed");
    // Profile reads straddle the awaited provider observation. Full bundles
    // are compared, and then re-planned before every native effect.
    if (profiles !== undefined) {
      let after: unknown[];
      try { after = saved(); } catch { throw new FormationPlanningError("INVALID_RECORD", "saved profile configuration is unreadable or invalid"); }
      if (canonicalSha256(profiles) !== canonicalSha256(after)) throw new FormationPlanningError("ROUTE_DRIFT", "saved profiles changed during formation");
    }
    let planned: Omit<Plan, "modeSupport">;
    try { planned = launch.launchPlan(deps.runtimePath, {
      repository: row.createCwd, workspaceId: row.workspaceId, role: input.role,
      assignment: `${input.assignment}\nTuyến handback: parent agent ID đã xác minh là ${row.agentId}.\nỞ handback, gửi đúng một native report đến parent đã xác minh ở trên.\nThông báo hoàn tất chỉ báo sự kiện; nó không thay báo cáo hoặc xác lập acceptance.\nVới Lead standby, thông báo readiness riêng; readiness không phải phán quyết kỹ thuật.\nTham chiếu authority (claim): ${input.grantRef}`,
      taskLabel: input.taskLabel, paseoHome: deps.daemonHome,
      providers: observed.entries.map(entry => ({ id: entry.provider, enabled: entry.enabled === true,
        status: entry.status === "ready" && !entry.error ? "available" : "unavailable" })),
      ...(profiles !== undefined ? { profiles } : {}),
      ...(input.role === "peer" ? { route: { ...input.runtime, disposition: input.disposition } } : {}),
    }); } catch { throw new FormationPlanningError("INVALID_RECORD", "fresh saved profile/pool/provider validation failed; refresh the preparation evidence"); }
    const separator = planned.create.provider.indexOf("/");
    if (separator <= 0) throw new FormationPlanningError("INVALID_RECORD", "fresh formation plan has no exact provider identity");
    const provider = planned.create.provider.slice(0, separator);
    const matching = observed.entries.filter(entry => entry.provider === provider);
    if (matching.length !== 1) throw new FormationPlanningError("CAPABILITY_GAP", "fresh provider snapshot has no unique exact selected-provider entry");
    const modes = matching[0].modes;
    if (!Array.isArray(modes)) throw new FormationPlanningError("CAPABILITY_GAP", "fresh selected-provider snapshot does not expose permission modes");
    const modeIds: string[] = [];
    for (const mode of modes) {
      if (typeof mode?.id !== "string" || mode.id.length === 0 || modeIds.includes(mode.id)) {
        throw new FormationPlanningError("CAPABILITY_GAP", "fresh selected-provider permission mode catalog is malformed or ambiguous");
      }
      modeIds.push(mode.id);
    }
    if (modeIds.length === 0) {
      if (planned.create.settings.modeId !== undefined) {
        throw new FormationPlanningError("INVALID_RECORD", "saved profile mode is unsupported by the fresh selected-provider snapshot");
      }
      return {
        ...planned,
        warnings: [
          ...(planned.warnings ?? []).filter(warning => !warning.startsWith("no modeId resolved (")),
          "Nhà cung cấp hiện quảng cáo modes=[]; plugin bỏ trường modeId khi tạo native seat.",
        ],
        modeSupport: { provider, modes: modeIds },
      };
    }
    if (planned.create.settings.modeId === undefined) {
      throw new FormationPlanningError("CAPABILITY_GAP", "selected provider advertises permission modes but the saved profile has no resolved mode");
    }
    if (!modeIds.includes(planned.create.settings.modeId)) {
      throw new FormationPlanningError("INVALID_RECORD", "saved profile mode is absent from the fresh selected-provider snapshot");
    }
    return { ...planned, modeSupport: { provider, modes: modeIds } };
  };
}

function modeSupportError(plan: Plan): DeskRejectionValue | null {
  const separator = plan.create.provider.indexOf("/");
  const provider = separator > 0 ? plan.create.provider.slice(0, separator) : "";
  const support = plan.modeSupport;
  if (!provider || support?.provider !== provider || !Array.isArray(support.modes)
    || support.modes.some(mode => typeof mode !== "string" || mode.length === 0)
    || new Set(support.modes).size !== support.modes.length) {
    return reject("CAPABILITY_GAP", "fresh exact-provider permission mode evidence is unavailable");
  }
  const modeId = plan.create.settings.modeId;
  if (support.modes.length === 0) {
    return modeId === undefined ? null : reject("INVALID_RECORD", "the selected provider advertises no permission modes, but the plan still selects one");
  }
  if (modeId === undefined) return reject("CAPABILITY_GAP", "selected provider advertises permission modes but the plan has no resolved mode");
  if (!support.modes.includes(modeId)) return reject("INVALID_RECORD", "the selected permission mode is absent from the fresh exact-provider snapshot");
  return null;
}

export async function runSeatCreate(row: MembershipValue, input: DeskSeatCreateInputValue, deps: {
  stableRoot: string; repoKey: string;
  host: () => (TaskHostApi & TaskRuntimeApi) | null;
  plan: (row: MembershipValue, input: DeskSeatCreateInputValue) => Promise<Plan>;
  guard: () => Promise<DeskRejectionValue | null>;
}) {
  if (row.agentId === null || !["lead", "supervisor"].includes(row.role)) return reject("AUTHORITY_REQUIRED", "only an orchestrating bound seat can form a child");
  const identity: OperationIdentity = { repoKey: deps.repoKey, membershipId: row.membershipId,
    agentId: row.agentId, kind: "seat-create", requestId: input.requestId };
  return createDeskOperations(deps.stableRoot).run(identity, input, async phase => {
    const hostApi = deps.host();
    if (hostApi === null) return reject("CAPABILITY_GAP", "the connected SDK is unavailable");
    const host = createTaskBoundedHost(hostApi);
    const initialGuard = await deps.guard(); if (initialGuard !== null) return initialGuard;
    const prepare = async (): Promise<Plan | DeskRejectionValue> => {
      try {
        const plan = await deps.plan(row, input);
        return modeSupportError(plan) ?? plan;
      }
      catch (error) {
        return error instanceof FormationPlanningError ? reject(error.code, error.message)
          : reject("INVALID_RECORD", "fresh formation preparation failed");
      }
    };
    const plan = await prepare(); if ("ok" in plan) return plan;
    const { create } = plan;
    const pin = canonicalSha256({ create, modeSupport: plan.modeSupport });
    const { initialPrompt, ...createMetadata } = create;
    phase("prepared", { pin, create: createMetadata, promptSha256: canonicalSha256(initialPrompt),
      modeSupport: plan.modeSupport,
      profileId: plan.profileId ?? null, routing: plan.routing ?? null, warnings: plan.warnings ?? [] });
    const guard = await deps.guard(); if (guard !== null) return guard;
    const createPlan = await prepare(); if ("ok" in createPlan) return createPlan;
    if (canonicalSha256({ create: createPlan.create, modeSupport: createPlan.modeSupport }) !== pin) return reject("ROUTE_DRIFT", "formation bundle or provider mode evidence changed before create");
    const beforeCreate = await deps.guard(); if (beforeCreate !== null) return beforeCreate;
    const label = canonicalSha256(identity);
    phase("create-issued", { label, parent: row.agentId, workspaceId: row.workspaceId, runtimePin: pin });
    let agentId: string;
    try {
      agentId = (await host.workspaces.ref(create.workspaceId).agents.create({
        config: { provider: create.provider,
          ...(create.settings.modeId !== undefined ? { modeId: create.settings.modeId } : {}),
          ...(create.settings.thinkingOptionId !== undefined ? { thinkingOptionId: create.settings.thinkingOptionId } : {}),
          featureValues: create.settings.features },
        parent: row.agentId!, title: create.title, labels: { "slp.formation": label },
        idempotencyKey: label, requestId: label,
      })).id;
    } catch { return { ok: true, state: "create-uncertain", agentId: null, sent: false, resourceDisposition: "retained" }; }
    phase("create-returned", { agentId });
    const split = create.provider.indexOf("/");
    const verification = await verifySeat(host, agentId, {
      provider: create.provider.slice(0, split), model: create.provider.slice(split + 1),
      cwd: row.createCwd, workspaceId: create.workspaceId, parent: row.agentId,
      modeId: create.settings.modeId, thinkingOptionId: create.settings.thinkingOptionId,
      modeIdUnsupported: plan.modeSupport.modes.length === 0,
      features: create.settings.features, labels: { "slp.formation": label },
    });
    phase("create-observed", { agentId, verification });
    if (!verification.ok) return { ok: true, state: "identity-uncertain", agentId, sent: false, verification, resourceDisposition: "retained" };
    const beforePlan = await deps.guard(); if (beforePlan !== null) return { ...beforePlan, agentId };
    const sendPlan = await prepare(); if ("ok" in sendPlan) return { ...sendPlan, agentId };
    if (canonicalSha256({ create: sendPlan.create, modeSupport: sendPlan.modeSupport }) !== pin) return { ...reject("ROUTE_DRIFT", "bundle or provider mode evidence changed before assignment delivery"), agentId };
    const beforeSend = await deps.guard(); if (beforeSend !== null) return { ...beforeSend, agentId };
    phase("send-issued", { agentId, messageId: label, promptSha256: canonicalSha256(create.initialPrompt) });
    try { await host.agents.ref(agentId).send(create.initialPrompt, { messageId: label }); }
    catch { return { ok: true, state: "send-uncertain", agentId, sent: null, verification, resourceDisposition: "retained" }; }
    return { ok: true, state: "host-accepted", agentId, workspaceId: verification.workspaceId, parent: verification.parent,
      sent: true, verification, runtime: { provider: create.provider, ...create.settings, modeSupport: plan.modeSupport }, resourceDisposition: "retained",
      notification: "native-finish-callback-not-established; child reports to observed parent" };
  });
}
