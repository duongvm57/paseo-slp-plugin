// One ordinary/Lean invocation: fresh plan → durable issue → native create
// without work → positive tuple observation → durable send (or caller handoff). No queue needed.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { candidateModulePath } from "./candidate-module.ts";
import { canonicalSha256, profilesArray, readRawConfig } from "./config-view.ts";
import { createDeskOperations, type OperationIdentity } from "./desk-operation.ts";
import { verifySeat } from "./desk-seat-observation.ts";
import { createTaskBoundedHost } from "./desk-task-host.ts";
import type { TaskHostApi } from "./desk-task-execution-host.ts";
import { observeTaskProviders, type TaskRuntimeApi } from "./desk-task-runtime.ts";
import { WIRE_LIMITS, type DeskRejectionValue } from "../shared/enforcement.ts";
import type { DeskSeatCreateInputValue } from "../shared/delegation.ts";
import type { MembershipValue } from "./desk-store.ts";
import type { PeerSelectionRequest, SelectedPeer } from "./runtime/cli/seat-selection.ts";
import type { TrustedLaunchContext } from "./runtime/cli/types.ts";
import { FormationPlacementError, FormationPlacementUncertain, type FormationTargetPin, type FormationSourcePin, type createFormationPlacement } from "./desk-placement.ts";
import { registeredMembership } from "./desk-membership.ts";

type ModeSupport = { provider: string; modes: string[] };
type Plan = {
  create: { provider: string; workspaceId: string; title: string; initialPrompt: string;
    settings: { modeId?: string; thinkingOptionId?: string; features: Record<string, unknown> } };
  modeSupport: ModeSupport;
  profileId?: string; routing?: unknown; warnings?: string[];
};
type FormationRequest = {
  repository: string; workspaceId: string; role: string; assignment: string; taskLabel: string;
  paseoHome: string; providers: { id: string; enabled: boolean; status: string; extends?: string }[];
  profiles?: unknown[]; route?: unknown;
};
type FormationModule = {
  launchPlan(root: string, request: FormationRequest, context?: TrustedLaunchContext): Omit<Plan, "modeSupport">;
  FORMATION_CAPABILITIES?: { existingPlacement?: number };
  preflightPeerChoice?: typeof import("./runtime/cli/seat-selection.ts").preflightPeerChoice;
  selectPeerSeat?: typeof import("./runtime/cli/seat-selection.ts").selectPeerSeat;
  revalidatePeerSelection?: typeof import("./runtime/cli/seat-selection.ts").revalidatePeerSelection;
  verifyFormationCandidate?: (root: string) => unknown;
};
type SelectionContext = { selected?: SelectedPeer; target?: FormationTargetPin; sourceRepository?: string; source?: FormationSourcePin };
type PhaseWriter = (name: string, value: unknown) => void;
const formationEvidenceTooLarge = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value)) * 3 > WIRE_LIMITS.deskBridgeRequestBytes - 32768;
function selectionFailure(error: unknown): DeskRejectionValue {
  const e = error as { name?: unknown; code?: unknown } | null;
  if (e?.name === "SeatSelectionError" && ["INVALID_RECORD", "ROUTE_DRIFT", "REQUEST_TOO_LARGE"].includes(e.code as string)) {
    return reject(e.code as DeskRejectionValue["code"], "Peer selection failed; inspect pool eligibility, independent choice and Jev receipt/configuration");
  }
  if (error instanceof FormationPlanningError) return reject(error.code, error.message);
  const reason = typeof e?.code === "string" && /^jev-[a-z-]+$/.test(e.code) ? ` (${e.code})` : "";
  return reject("INVALID_RECORD", `Peer selection failed${reason}; resolve the pool/Jev configuration or decision failure without provider fallback`);
}
const reject = (code: DeskRejectionValue["code"], message: string): DeskRejectionValue => ({
  ok: false, code, message,
  recovery: "inspect retained formation evidence; resolve the missing capability or drift without repeating an uncertain create/send",
});
export class FormationPlanningError extends Error {
  readonly code: DeskRejectionValue["code"];
  constructor(code: DeskRejectionValue["code"], message: string) { super(message); this.code = code; }
}

function placementFailure(error: unknown, agentId?: string, target?: FormationTargetPin) {
  if (error instanceof FormationPlacementUncertain) return { ok: true, state: "placement-uncertain", agentId: agentId ?? null,
    workspaceId: error.workspaceId, cwd: error.cwd, correlationKey: error.correlationKey, sent: false, resourceDisposition: "retained" };
  return { ...(error instanceof FormationPlacementError ? reject(error.code, error.message) : reject("CAPABILITY_GAP", "placement could not be qualified")),
    ...(agentId ? { agentId } : {}), ...(target ? { workspaceId: target.workspaceId } : error instanceof FormationPlacementError && error.workspaceId ? { workspaceId: error.workspaceId } : {}),
    sent: false, resourceDisposition: "retained" };
}

export function createFormationPlanner(deps: {
  runtimePath: string; daemonHome: string; host: () => (TaskHostApi & TaskRuntimeApi) | null;
  importModule?: (specifier: string) => Promise<unknown>;
}) {
  const loadLaunch = async (): Promise<FormationModule> => {
    const load = deps.importModule ?? (specifier => import(specifier));
    try { return await load(pathToFileURL(candidateModulePath(deps.runtimePath, "launch")).href) as FormationModule; }
    catch { throw new FormationPlanningError("RUNTIME_INTEGRITY", "the bound candidate launch module is unavailable"); }
  };
  const peerRequest = (row: MembershipValue, input: DeskSeatCreateInputValue, context?: SelectionContext): PeerSelectionRequest => ({
    repository: context?.target?.source.repository ?? context?.source?.repository ?? context?.sourceRepository ?? row.createCwd, assignment: input.assignment, paseoHome: deps.daemonHome,
    ...(input.role === "peer" && input.selection ? { selection: input.selection } : {}),
  });
  const observeProviders = async (row: MembershipValue, context?: SelectionContext) => {
    const host = deps.host();
    if (host === null) throw new FormationPlanningError("CAPABILITY_GAP", "connected host unavailable");
    try {
      const observed = await observeTaskProviders(createTaskBoundedHost(host), context?.target?.cwd ?? row.createCwd);
      if (observed.error) throw new Error("provider snapshot failed");
      return observed;
    } catch { throw new FormationPlanningError("CAPABILITY_GAP", "connected provider snapshot failed"); }
  };
  const providerInventory = (observed: Awaited<ReturnType<typeof observeProviders>>) => observed.entries.map(entry => ({
    id: entry.provider, enabled: entry.enabled === true, status: entry.status === "ready" && !entry.error ? "available" : "unavailable",
    ...(entry.extends !== undefined ? { extends: entry.extends } : {}),
  }));
  const requireSelection = (launch: FormationModule) => {
    if (typeof launch.preflightPeerChoice !== "function" || typeof launch.selectPeerSeat !== "function"
      || typeof launch.revalidatePeerSelection !== "function" || typeof launch.verifyFormationCandidate !== "function") {
      throw new FormationPlanningError("CAPABILITY_GAP", "bound candidate lacks automatic Peer selection; use supported full runtime pins");
    }
    try { launch.verifyFormationCandidate(deps.runtimePath); }
    catch { throw new FormationPlanningError("RUNTIME_INTEGRITY", "bound candidate bytes changed before Peer selection"); }
  };
  const requirePlacement = (launch: FormationModule) => {
    if (launch.FORMATION_CAPABILITIES?.existingPlacement !== 1 || typeof launch.verifyFormationCandidate !== "function") {
      throw new FormationPlanningError("CAPABILITY_GAP", "bound candidate lacks source-pinned existing placement");
    }
    try { launch.verifyFormationCandidate(deps.runtimePath); }
    catch { throw new FormationPlanningError("RUNTIME_INTEGRITY", "bound candidate bytes changed during placement"); }
  };
  const planner = async (row: MembershipValue, input: DeskSeatCreateInputValue, context?: SelectionContext): Promise<Plan> => {
    if (row.workspaceId === null && !context?.target) throw new FormationPlanningError("CAPABILITY_GAP", "formation requires an exact workspace");
    const host = deps.host();
    if (host === null) throw new FormationPlanningError("CAPABILITY_GAP", "connected host unavailable");
    const launch = await loadLaunch();
    if (context?.target || context?.source) requirePlacement(launch);
    const saved = () => profilesArray(readRawConfig(join(deps.daemonHome, "config.json")).json).value;
    let profiles: unknown[] | undefined;
    try { profiles = input.role === "lead" ? saved() : undefined; }
    catch { throw new FormationPlanningError("INVALID_RECORD", "saved profile configuration is unreadable or invalid"); }
    const observed = await observeProviders(row, context);
    // Profile reads straddle the awaited provider observation. Full bundles
    // are compared, and then re-planned before every native effect.
    if (profiles !== undefined) {
      let after: unknown[];
      try { after = saved(); } catch { throw new FormationPlanningError("INVALID_RECORD", "saved profile configuration is unreadable or invalid"); }
      if (canonicalSha256(profiles) !== canonicalSha256(after)) throw new FormationPlanningError("ROUTE_DRIFT", "saved profiles changed during formation");
    }
    if (context?.selected !== undefined) {
      requireSelection(launch);
      try { launch.revalidatePeerSelection!(peerRequest(row, input, context), context.selected, providerInventory(observed)); }
      catch { throw new FormationPlanningError("ROUTE_DRIFT", "fixed Peer selection or provider evidence changed before the next effect"); }
    }
    let planned: Omit<Plan, "modeSupport">;
    try { planned = launch.launchPlan(deps.runtimePath, {
      repository: context?.target?.cwd ?? row.createCwd, workspaceId: context?.target?.workspaceId ?? row.workspaceId!, role: input.role,
      assignment: `${input.assignment}\nHandback route: the verified parent agent ID is ${row.agentId}.\nAt handback, send exactly one native report to the verified parent above.\nA finish notification only signals the event; it does not replace the report or establish acceptance.\nA standby Lead reports readiness separately; readiness is not a technical verdict.\nAuthority reference (claim): ${input.grantRef}`,
      taskLabel: input.taskLabel, paseoHome: deps.daemonHome,
      providers: providerInventory(observed),
      ...(profiles !== undefined ? { profiles } : {}),
      ...(input.role === "peer" ? { route: { ...(context?.selected?.route ?? input.runtime), disposition: input.disposition } } : {}),
    }, context?.target || context?.source ? {
      routingRepository: (context.target?.source ?? context.source!).repository,
      protocolRepository: (context.target?.source ?? context.source!).repository,
      protocolPinned: (context.target?.source ?? context.source!).configuration["workspace-protocol.md"] !== null,
    } : undefined); }
    catch { throw new FormationPlanningError("INVALID_RECORD", "fresh saved profile/pool/provider validation failed; refresh the preparation evidence"); }
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
          "The selected provider advertises modes=[]; the plugin omits modeId when creating the native seat.",
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
  return Object.assign(planner, {
    placementCapability: async () => { requirePlacement(await loadLaunch()); },
    preflightPeer: async (row: MembershipValue, input: DeskSeatCreateInputValue, context?: SelectionContext) => {
      if (row.workspaceId === null && input.placement?.kind !== "existing") throw new FormationPlanningError("CAPABILITY_GAP", "formation requires an exact workspace");
      const launch = await loadLaunch(); requireSelection(launch);
      return launch.preflightPeerChoice!(peerRequest(row, input, context));
    },
    selectPeer: async (row: MembershipValue, input: DeskSeatCreateInputValue, phase: PhaseWriter, guard: () => Promise<DeskRejectionValue | null>, context?: SelectionContext) => {
      if (row.workspaceId === null && !context?.target) throw new FormationPlanningError("CAPABILITY_GAP", "formation requires an exact workspace");
      const launch = await loadLaunch(); requireSelection(launch);
      const observed = await observeProviders(row, context);
      const refused = await guard();
      if (refused !== null) throw new FormationPlanningError(refused.code, refused.message);
      requireSelection(launch);
      return launch.selectPeerSeat!(peerRequest(row, input, context), { providers: providerInventory(observed), phase });
    },
  });
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
  plan: (row: MembershipValue, input: DeskSeatCreateInputValue, context?: SelectionContext) => Promise<Plan>;
  preflightPeer?: (row: MembershipValue, input: DeskSeatCreateInputValue, context?: SelectionContext) => Promise<unknown | null>;
  selectPeer?: (row: MembershipValue, input: DeskSeatCreateInputValue, phase: PhaseWriter, guard: () => Promise<DeskRejectionValue | null>, context?: SelectionContext) => Promise<SelectedPeer>;
  placementCapability?: () => Promise<void>;
  placement?: ReturnType<typeof createFormationPlacement>;
  readMemberships?: () => readonly MembershipValue[] | null;
  membershipWaitMs?: number;
  guard: () => Promise<DeskRejectionValue | null>;
}) {
  if (row.agentId === null || !["lead", "supervisor"].includes(row.role)) return reject("AUTHORITY_REQUIRED", "only an orchestrating bound seat can form a child");
  const identity: OperationIdentity = { repoKey: deps.repoKey, membershipId: row.membershipId,
    agentId: row.agentId, kind: "seat-create", requestId: input.requestId };
  // The intent binds the input exactly as received (absent stays absent, so an
  // earlier receipt replays unchanged). The "caller" default applies only here
  // at execution; absent vs explicit "caller" are different bodies.
  const delivery = input.delivery ?? "caller";
  const automaticPeer = input.role === "peer" && input.runtime === undefined;
  const placed = input.placement !== undefined;
  const preflight = (automaticPeer || placed) && input.placement?.kind !== "worktree" ? async () => {
    const guard = await deps.guard(); if (guard !== null) return guard;
    // Reject oversized input before admission or a paid decision; retained
    // invocations still replay first. Full runtime pins keep their old path.
    if (formationEvidenceTooLarge(input)) return reject("REQUEST_TOO_LARGE", "automatic formation input exceeds the wire allowance; shorten it before retrying this requestId");
    let context: SelectionContext | undefined;
    if (placed) {
      if (!deps.placement || !deps.placementCapability) return reject("CAPABILITY_GAP", "connected placement capabilities unavailable");
      try { await deps.placementCapability(); context = { sourceRepository: (await deps.placement.source(row)).repository }; }
      catch (error) { return error instanceof FormationPlanningError ? selectionFailure(error) : placementFailure(error); }
    } else if (deps.placement) {
      try { await deps.placement.assertCaller(row); const source = await deps.placement.inheritedSource(row); if (source) { await deps.placementCapability?.(); context = { source }; } }
      catch (error) { return placementFailure(error); }
    }
    if (!automaticPeer) return null;
    if (!deps.preflightPeer || !deps.selectPeer) return reject("CAPABILITY_GAP", "automatic Peer selection is unavailable");
    try { return await deps.preflightPeer(row, input, context); }
    catch (error) { return selectionFailure(error); }
  } : undefined;
  return createDeskOperations(deps.stableRoot).run(identity, input, async phase => {
    const hostApi = deps.host();
    if (hostApi === null) return reject("CAPABILITY_GAP", "the connected SDK is unavailable");
    const host = createTaskBoundedHost(hostApi);
    const initialGuard = await deps.guard(); if (initialGuard !== null) return initialGuard;
    if (input.placement?.kind === "worktree") return reject("CAPABILITY_GAP", "new worktree creation cannot suppress host setup; use Paseo to create the workspace, then slp_seat_create placement existing");
    let target: FormationTargetPin | undefined;
    if (placed) {
      try { await deps.placementCapability!(); target = await deps.placement!.resolve(row, input, phase, deps.guard); }
      catch (error) { return error instanceof FormationPlanningError ? selectionFailure(error) : placementFailure(error); }
    }
    let source: FormationSourcePin | undefined;
    if (!target && deps.placement) {
      try { source = await deps.placement.inheritedSource(row); if (source) await deps.placementCapability!(); }
      catch (error) { return error instanceof FormationPlanningError ? selectionFailure(error) : placementFailure(error); }
    }
    const verifySource = async () => { if (source) await deps.placement!.verifySource(row, source); };
    let selected: SelectedPeer | undefined;
    if (automaticPeer) {
      const decisionGuard = async () => {
        const refused = await deps.guard(); if (refused !== null) return refused;
        if (target) { await deps.placement!.verify(row, target); return deps.guard(); }
        await verifySource(); return null;
      };
      try { selected = await deps.selectPeer!(row, input, phase, decisionGuard, target ? { target } : source ? { source } : undefined); }
      catch (error) { return error instanceof FormationPlacementError || error instanceof FormationPlacementUncertain ? placementFailure(error, undefined, target) : selectionFailure(error); }
      // This durable pin precedes every create/observe/delivery replan.
      phase("route-selected", selected);
    }
    const prepare = async (): Promise<Plan | DeskRejectionValue> => {
      try {
        await verifySource();
        const plan = await deps.plan(row, input, selected || target || source ? {
          ...(selected ? { selected } : {}), ...(target ? { target } : {}), ...(source ? { source } : {}),
        } : undefined);
        return modeSupportError(plan) ?? plan;
      }
      catch (error) {
        return error instanceof FormationPlacementError || error instanceof FormationPlanningError ? reject(error.code, error.message)
          : reject("INVALID_RECORD", "fresh formation preparation failed");
      }
    };
    // Qualification immediately before create and delivery shares one order.
    // The awaited actor guard is not a lease: observe the target again after it.
    // Decision and delayed-registration checks have different orders and stay local.
    const verifyEffectPlacement = async (agentId?: string) => {
      if (target) {
        try { await deps.placement!.verify(row, target); }
        catch (error) { return placementFailure(error, agentId, target); }
        const afterTarget = await deps.guard();
        if (afterTarget !== null) return agentId === undefined ? afterTarget : { ...afterTarget, agentId };
        try { await deps.placement!.verify(row, target); }
        catch (error) { return placementFailure(error, agentId, target); }
      } else {
        if (agentId === undefined && !deps.placement) return reject("CAPABILITY_GAP", "caller repository/workspace qualification unavailable");
        try { await deps.placement!.verifyCaller(row); await verifySource(); }
        catch (error) { return placementFailure(error, agentId); }
      }
      return null;
    };
    const plan = await prepare(); if ("ok" in plan) return plan;
    const { create } = plan;
    if ((selected || target) && formationEvidenceTooLarge({ ...(selected ? { selected } : {}), ...(target ? { target } : {}), plan })) {
      // Reserve room for phase/result copies, JSON-RPC string escaping and
      // bounded native tuple evidence before allocating a child. Legacy
      // full-pin invocations keep their original validation/receipt path.
      return reject("REQUEST_TOO_LARGE", "automatic formation evidence/prompt exceeds the wire allowance");
    }
    const pin = canonicalSha256({ create, modeSupport: plan.modeSupport });
    const { initialPrompt, ...createMetadata } = create;
    phase("prepared", { pin, create: createMetadata, promptSha256: canonicalSha256(initialPrompt),
      modeSupport: plan.modeSupport,
      ...(source ? { source } : {}), profileId: plan.profileId ?? null, routing: plan.routing ?? null, warnings: plan.warnings ?? [] });
    const guard = await deps.guard(); if (guard !== null) return guard;
    const createPlan = await prepare(); if ("ok" in createPlan) return createPlan;
    if (canonicalSha256({ create: createPlan.create, modeSupport: createPlan.modeSupport }) !== pin) return reject("ROUTE_DRIFT", "formation bundle or provider mode evidence changed before create");
    const beforeCreate = await deps.guard(); if (beforeCreate !== null) return beforeCreate;
    const createPlacement = await verifyEffectPlacement(); if (createPlacement !== null) return createPlacement;
    const label = canonicalSha256(identity);
    phase("create-issued", { label, parent: row.agentId, workspaceId: create.workspaceId, runtimePin: pin,
      ...(target ? { target } : {}) });
    let agentId: string;
    try {
      const options = {
        config: { provider: create.provider,
          ...(create.settings.modeId !== undefined ? { modeId: create.settings.modeId } : {}),
          ...(create.settings.thinkingOptionId !== undefined ? { thinkingOptionId: create.settings.thinkingOptionId } : {}),
          featureValues: create.settings.features },
        parent: row.agentId!, title: create.title, labels: { "slp.formation": label },
        idempotencyKey: label, requestId: label,
      };
      agentId = (await deps.placement!.create({ workspaceId: create.workspaceId }, options)).id;
    } catch { return { ok: true, state: "create-uncertain", agentId: null, sent: false, resourceDisposition: "retained" }; }
    phase("create-returned", { agentId });
    const split = create.provider.indexOf("/");
    const verification = await verifySeat(host, agentId, {
      provider: create.provider.slice(0, split), model: create.provider.slice(split + 1),
      cwd: target?.cwd ?? row.createCwd, workspaceId: create.workspaceId, parent: row.agentId,
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
    const sendPlacement = await verifyEffectPlacement(agentId); if (sendPlacement !== null) return sendPlacement;
    // Full-runtime/Lead requests without placement preserve historical delivery
    // and bytes. Only the new formation semantics wait for event registration.
    if (placed || automaticPeer || input.role === "peer" && input.selection !== undefined) {
      const memberPin = { agentId, provider: create.provider.slice(0, split), createCwd: target?.cwd ?? row.createCwd,
        workspaceId: create.workspaceId, role: input.role };
      const readMember = () => {
        try { return registeredMembership(deps.readMemberships?.() ?? [], memberPin); }
        catch { return null; } // Missing/unreadable registration never establishes readiness.
      };
      const waitMs = deps.membershipWaitMs ?? 1500;
      if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 1500) throw new Error("invalid membership wait budget");
      const deadline = performance.now() + waitMs;
      let member = readMember(), waited = false, backoff = 25;
      while (member === null && performance.now() < deadline) {
        waited = true;
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(backoff, Math.max(0, deadline - performance.now()))));
        member = readMember(); backoff = Math.min(backoff * 2, 200);
      }
      if (waited && member !== null) {
        // A read-only registration wait is not a freshness lease for delivery.
        const refused = await deps.guard(); if (refused !== null) return { ...refused, agentId };
        const current = await prepare(); if ("ok" in current) return { ...current, agentId };
        if (canonicalSha256({ create: current.create, modeSupport: current.modeSupport }) !== pin) {
          return { ...reject("ROUTE_DRIFT", "formation changed during membership registration wait"), agentId };
        }
        try { if (target) await deps.placement!.verify(row, target); else { await deps.placement!.verifyCaller(row); await verifySource(); } }
        catch (error) { return placementFailure(error, agentId, target); }
        const afterWait = await deps.guard(); if (afterWait !== null) return { ...afterWait, agentId };
        member = readMember();
      }
      if (target) phase("membership-observed", { agentId, registered: member !== null, membershipId: member?.membershipId ?? null });
      if (member === null) return { ok: true, state: "seat-pending", agentId, workspaceId: create.workspaceId,
        parent: verification.parent, sent: false, verification, resourceDisposition: "retained",
        readiness: `exact live membership not established within ${waitMs}ms; read slp_operation_get with this requestId, retain the agent ID, do not recreate or send the assignment without fresh identity/membership/authority proof; this receipt does not auto-resume`,
        nextAction: { tool: "slp_operation_get", arguments: { kind: "seat-create", requestId: input.requestId } },
        assignmentEvidence: { prompt: create.initialPrompt, promptSha256: canonicalSha256(create.initialPrompt) } };
    }
    if (delivery === "caller") {
      const promptSha256 = canonicalSha256(create.initialPrompt);
      phase("delivery-handed-off", { agentId, promptSha256 });
      return { ok: true, state: "awaiting-caller-delivery", agentId, workspaceId: verification.workspaceId, parent: verification.parent,
        sent: false, verification, runtime: { provider: create.provider, ...create.settings, modeSupport: plan.modeSupport }, resourceDisposition: "retained",
        delivery: { tool: "send_agent_prompt", agentId, notifyOnFinish: true, prompt: create.initialPrompt, promptSha256 },
        notification: "caller must send the exact prompt with send_agent_prompt notifyOnFinish=true; the finish notification is an event, not the report or acceptance" };
    }
    phase("send-issued", { agentId, messageId: label, promptSha256: canonicalSha256(create.initialPrompt) });
    try { await host.agents.ref(agentId).send(create.initialPrompt, { messageId: label }); }
    catch { return { ok: true, state: "send-uncertain", agentId, sent: null, verification, resourceDisposition: "retained" }; }
    return { ok: true, state: "host-accepted", agentId, workspaceId: verification.workspaceId, parent: verification.parent,
      sent: true, verification, runtime: { provider: create.provider, ...create.settings, modeSupport: plan.modeSupport }, resourceDisposition: "retained",
      notification: "native-finish-callback-not-established; child reports to observed parent" };
  }, preflight);
}
