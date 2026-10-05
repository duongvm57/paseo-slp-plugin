// Server entry for the paseo-slp manager plugin (Option A v1, spec §2).
// Synchronous contribution returning cleanup; the connected API arrives in
// handlers. Lead wires the lane modules here; manager alone owns the mutation
// mutex, state transitions and connected SDK calls.
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { activate, reconcile, deactivate, status, localTarget, catalog, setLanguage, getRoleRouting, setRoleRouting, getPeerPool, setPeerPool, getJev, setJev, setJevKey, testJev } from "./shared/contracts.ts";
import { disableSupervisionNotifications, getSupervision, getSupervisionStatus, setSupervision } from "./shared/supervision.ts";
import { enforcementStatus, enforcementRecoverLock, enforcementRuntimePin } from "./shared/enforcement.ts";
import type { Manager } from "./shared/contracts.ts";
import { loadCatalog } from "./server/provider-catalog.ts";
import { createManager } from "./server/manager.ts";
import { createJev } from "./server/jev.ts";
import { createStateStore } from "./server/state-store.ts";
import { createSupervisionState } from "./server/supervision/state.ts";
import { createSupervisionObserver, type SupervisionObserver } from "./server/supervision/observer.ts";
import { detectDaemonHome, resolveDaemonHome } from "./server/daemon-home.ts";
import { readInjectionBinding } from "./server/injection-binding.ts";
import { createDeskSeat } from "./server/desk-seat.ts";
import { createMaterializer } from "./server/materializer.ts";
import { embeddedPayload } from "./server/generated/runtime-payload.ts";
import { createExecutableResolver } from "./server/executables.ts";
import { createLauncherBuilder } from "./server/launchers.ts";
import { createJournal } from "./server/journal.ts";
import { createRoleInjection } from "./server/role-injection.ts";
import { createEnforcement } from "./server/enforcement.ts";
import { recoverLockView } from "./server/desk-recovery.ts";
import { readRuntimePinView } from "./server/runtime-pin.ts";
import { createDeskBridge } from "./server/desk-bridge.ts";
import { getWorkspaceWorkflow } from "./shared/workflow-view.ts";
import { readWorkspaceWorkflow } from "./server/workflow-view.ts";
import type { TaskHostApi } from "./server/desk-task-execution-host.ts";
import type { TaskRuntimeApi } from "./server/desk-task-runtime.ts";
// Host note: this must stay a hoisted function declaration, not a const —
// the daemon compiler's Hermes interop eagerly copies export values before
// module bodies run, so `export default const` evaluates to undefined.
export default function contribute(server: Parameters<PluginServerContribution>[0]): ReturnType<PluginServerContribution> {
  let taskApi: (TaskHostApi & TaskRuntimeApi) | null = null;
  const noteTaskApi = (paseo: (TaskHostApi & TaskRuntimeApi) | undefined) => { if (paseo !== undefined) taskApi = paseo; };
  const materializer = createMaterializer(embeddedPayload);
  const manager: Manager = createManager({
    payload: embeddedPayload,
    materializer,
    executables: createExecutableResolver(),
    launchers: createLauncherBuilder(),
  });
  server.handle(activate, (input, { paseo }) => manager.activate(input, paseo));
  server.handle(reconcile, (input, { paseo }) => manager.reconcile(input, paseo));
  server.handle(deactivate, (input, { paseo }) => manager.deactivate(input, paseo));
  server.handle(status, (input, { paseo }) => manager.status(input, paseo));
  server.handle(localTarget, () => detectDaemonHome());
  server.handle(getWorkspaceWorkflow, (input, { paseo }) => {
    noteTaskApi(paseo);
    deskBridge.noteDispatch(paseo);
    return readWorkspaceWorkflow(input, paseo);
  });
  server.handle(catalog, (input, { paseo }) => loadCatalog(input, paseo));
  // Plugin-owned state files under slp-runtime/state — same class of
  // operation as jev: no journal, no mutex, no authority gate.
  const store = createStateStore();
  server.handle(setLanguage, input => store.setLanguage(input));
  server.handle(getRoleRouting, input => store.getRoleRouting(input));
  server.handle(setRoleRouting, input => store.setRoleRouting(input));
  server.handle(getPeerPool, input => store.getPeerPool(input));
  server.handle(setPeerPool, input => store.setPeerPool(input));
  // Jev (OpenRouter Decisions) — per-daemon config/key under slp-runtime/state;
  // test-jev is the only handler that touches the network (explicit action).
  const jev = createJev();
  server.handle(getJev, input => jev.getJev(input));
  server.handle(setJev, input => jev.setJev(input));
  server.handle(setJevKey, input => jev.setJevKey(input));
  server.handle(testJev, input => jev.testJev(input));
  // Supervision config (spec supervision-integration.md §Configuration):
  // private supervision.json under the SERVED daemon home — the store binds
  // the state path to the home this process actually serves (PASEO_HOME env),
  // refusing reads/writes it cannot verify. Agent validation on save goes
  // through the connected SDK; the Command Center/bell actions use the same
  // CAS writer.
  // Observer: lifecycle hooks capture the minimal normalized communication
  // synchronously; a serialized plugin-lifetime queue owns SDK refreshes,
  // Jev HTTP (via the gated supervision resolver), the bounded metadata ring
  // and — for `notify` routes only — Supervisor delivery through the hook
  // context's connected SDK. An unverifiable served home leaves the observer
  // inert (shadow = null).
  let observer: SupervisionObserver | null = null;
  try {
    const served = detectDaemonHome();
    // Inert unless the served home is VERIFIED: a default-guessed home would
    // observe the wrong daemon's state files. Only an exported PASEO_HOME
    // ("env") proves which home this process serves (spec §Configuration:
    // the local-target value is a prefill, not proof of host-home mapping).
    if (served.source === "env") {
      const binding = resolveDaemonHome(
        { hostId: "local", daemonHome: served.daemonHome },
        "config.json must be a regular file, not a link",
      );
      observer = createSupervisionObserver({ stableRoot: binding.stableRoot });
    }
  } catch {
    observer = null;
  }
  const supervision = createSupervisionState({
    shadow: stableRoot => observer?.shadow(stableRoot) ?? null,
  });
  server.handle(getSupervision, input => supervision.getSupervision(input));
  server.handle(setSupervision, (input, { paseo }) => supervision.setSupervision(input, paseo));
  server.handle(getSupervisionStatus, input => supervision.getStatus(input));
  server.handle(disableSupervisionNotifications, (input, { paseo }) => supervision.disableNotifications(input, paseo));
  // Phase 2 (settings-driven-providers.md §6): the hook-family thin aliases
  // need the two halves the sentinel gate cannot supply — role-bundle
  // injection at agent.create and the session-open grant overlay. Both hooks
  // read the binding lazily per call, so a later activation or rebind is
  // picked up without re-registering; failures propagate to the host, which
  // is what makes the managed path fail closed during a hook gap.
  const journal = createJournal();
  // Enforcement desk (P0 + P2-e projection): read-only capability rows plus
  // the membership projection over the verified home's repo ledgers — no
  // provider-policy or per-agent model projection, no mutation; the desk
  // seam itself lives in server/enforcement.ts so P1+ state lands behind
  // the same Interface, not in this handler.
  // Desk MCP bridge (P2-d): the seat↔desk transport — one UDS adapter plus
  // lifecycle lock under the verified stable root, and the agent.create
  // graft that hands managed seats their stdio MCP server. start() is
  // fire-and-forget: a failed lifecycle leaves the bridge "unavailable",
  // never throws — graft/dispatch fail closed on their own. The before-hook
  // registrations land AFTER role-injection's below, on purpose.
  const deskBridge = createDeskBridge({
    journal,
    launchers: createLauncherBuilder(),
    payload: embeddedPayload,
    paseoRef: { current: null },
    taskHost: () => taskApi,
  });
  void deskBridge.start();
  const enforcement = createEnforcement({
    journal,
    // T6: wire the live bridge lifecycle into the capability audit —
    // "starting" is genuinely unobserved (null → unknown), never a fake
    // supported/unsupported claim.
    observeDeskBridge: () => {
      const kind = deskBridge.state().kind;
      return kind === "listening" ? "listening" : kind === "unavailable" ? "unavailable" : null;
    },
  });
  server.handle(enforcementStatus, (input, { paseo }) => {
    // Only real daemon→plugin RPC handlers record dispatch evidence;
    // lifecycle hook stashes never count as an RPC observation.
    noteTaskApi(paseo);
    deskBridge.noteDispatch(paseo);
    return enforcement.readView(input, paseo);
  });
  // Desk lock recovery (P2-e): operator-only RPC — the provenance gate
  // (exported PASEO_HOME + realpath match) runs before the algorithm, so an
  // unverified or foreign home is never mutated. No hook reaches this path.
  server.handle(enforcementRecoverLock, input => recoverLockView(input));
  // RuntimePin (P2-b): read-only verdict on the served home's active
  // binding — journal reads only, the materializer's verifyPublished is the
  // integrity oracle. No paseo surface, no mutex, no mutation.
  const runtimePinDeps = { journal, verifyPublished: materializer.verifyPublished };
  server.handle(enforcementRuntimePin, input => readRuntimePinView(input, runtimePinDeps));
  // Desk seat handshake (P2-c): one store per stable root, created lazily
  // inside desk-seat on first use. Ordinary hooks are fail-open and budgeted;
  // an issued task ticket requires a validated mint before native creation.
  const deskSeat = createDeskSeat({
    stableRoot: join(realpathSync(detectDaemonHome().daemonHome), "slp-runtime"),
  });
  const injection = createRoleInjection({
    readActiveBinding: () => readActiveBinding(journal),
    // O1: the create-hook re-verifies the published candidate (cached once
    // per sha) before importing its role bundle — same verifyPublished the
    // management plane uses; covers the gate transitively (see
    // role-injection.ts header).
    verifyCandidate: binding =>
      materializer.verifyPublished(binding.runtimePath, binding.candidateSha256, binding.payloadSha256),
    // P2-c: mint at create (env handle after the seat.mint commit), bind at
    // session_open (env echo). Task-ticket validation fails closed at create.
    deskMint: deskSeat.deskMint,
    deskBind: deskSeat.deskBind,
  });
  const offAgentCreate = server.before("agent.create", injection.agentCreate);
  const offSessionOpen = server.before("agent.session_open", injection.sessionOpen);
  // P2-c registration confirm + revoke — separate handlers on the same
  // events the shadow observer uses; the observer's registrations are
  // untouched. Both fail-open, never reject.
  const offDeskRegister = server.on("agent.created", event => deskSeat.deskRegister(event));
  const offDeskRevoke = server.on("agent.archived", event => deskSeat.deskRevoke(event));
  // P2-d hook registrations — ordered AFTER role-injection's hooks above:
  // before-handlers compose sequentially in registration order, so the
  // graft sees request.env already carrying the minted SLP_DESK_HANDLE.
  // The session_open stash only supplies the connected SDK (no request
  // change — the host rejects non-env changes anyway).
  const offBridgeGraft = server.before("agent.create", (input, ctx) => {
    noteTaskApi(ctx.paseo);
    return deskBridge.agentCreateGraft(input, ctx);
  });
  const offBridgeStash = server.before("agent.session_open", (input, ctx) => {
    noteTaskApi(ctx.paseo);
    return deskBridge.sessionOpenStash(input, ctx);
  });
  const offTaskEnded = server.on("agent.turn_ended", (event, { paseo }) => {
    noteTaskApi(paseo);
    deskBridge.notePaseo(paseo);
    return deskBridge.taskTurnEnded({
      agentId: event.agent.id, ...(event.turnId === null ? {} : { turnId: event.turnId }), outcome: event.outcome.kind,
      timeline: event.timeline.map(item => item.type === "user_message"
        ? { type: item.type, messageId: item.messageId, clientMessageId: item.clientMessageId }
        : { type: item.type }),
    });
  });
  // A resumed ACP turn can dispatch Desk tools before an RPC, create hook,
  // session_open or turn_ended handler has supplied this process's SDK slot.
  // Keep this unconditional and independent of the optional observer; it
  // stashes host identity context only and never marks plugin-RPC evidence.
  const offDeskContextStart = server.on("agent.turn_started", (_event, { paseo }) => {
    noteTaskApi(paseo);
    deskBridge.notePaseo(paseo);
  });
  // Observer lifecycle hooks — synchronous capture only; every async step
  // (refresh, Jev HTTP, ring write, notify delivery) runs on the observer's
  // own queue.
  const ob = observer;
  const offCreated = ob === null ? null : server.on("agent.created", (event, { paseo }) => ob.onCreated(event.agent, paseo));
  const offArchived = ob === null ? null : server.on("agent.archived", (event, { paseo }) => ob.onArchived(event.agent, paseo));
  const offStarted = ob === null ? null : server.on("agent.turn_started", event => ob.onStart(event));
  const offEnded = ob === null ? null : server.on("agent.turn_ended", (event, { paseo }) => ob.onTurn(event, paseo));
  return () => {
    offAgentCreate();
    offSessionOpen();
    offBridgeGraft();
    offBridgeStash();
    offDeskRegister();
    offDeskRevoke();
    offTaskEnded();
    offDeskContextStart();
    offCreated?.();
    offArchived?.();
    offStarted?.();
    offEnded?.();
    void ob?.stop();
    deskBridge.stop();
    manager.close();
  };
}

// The hooks resolve the live binding via the O1 usable-for-injection
// predicate (server/injection-binding.ts): the journal receipt under this
// daemon's own <home>/slp-runtime, the same canonical home resolution the
// manager uses (realpath before the stable-root join). null when no
// receipt/binding exists; journal integrity failures and unusable states
// (DEACTIVATING, RECOVERY_REQUIRED, target/state inconsistency) throw —
// fail closed for managed providers, never a silently unroled spawn.
function readActiveBinding(journal: ReturnType<typeof createJournal>) {
  return readInjectionBinding({ journal });
}
