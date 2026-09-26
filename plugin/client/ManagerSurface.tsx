// Management surface for the paseo-slp plugin (spec §2, §10).
// PluginSurfaceProps carry host.id/host.label only — the daemon home is
// administrator input, never a prop. No auto-activation: every mutation is an
// explicit press behind the two §4 authority acknowledgments, and status is
// fetched on demand, then polled every second only while an operation pends.
//
// The layout is a guided top-down flow — target, status, authority, activate —
// with recovery and override controls collapsed behind their own headers so
// the default view shows only what an activation needs.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { activate, catalog, deactivate, reconcile, status, localTarget, setLanguage, getRoleRouting, setRoleRouting, getJev, setJev, setJevKey, testJev, getPeerPool, setPeerPool, getWorkTracker, setWorkTracker } from "../shared/contracts.ts";
import { getSupervision, setSupervision } from "../shared/supervision.ts";
import { FAMILY_IDS, FAMILY_LABEL, FAMILY_PICKER_ORDER } from "../shared/families.ts";
import type { RoleName } from "../shared/families.ts";
import { PEER_SEAT_ARCHETYPES } from "../shared/archetypes.ts";
import {
  HOW_TO_READ,
  STANDARD_SEAT_TOKENS,
  SUITABILITY_AXES,
  SUITABILITY_TOKENS,
  tokenDefinition,
} from "../shared/routing-vocabulary.ts";
import type { CatalogOptionValue, CatalogResult, FamilyName, StartResult, StatusResult, TargetValue } from "../shared/contracts.ts";
import {
  DISABLE_REMOVE_NOTICE,
  EXCLUSIVE_WINDOW_NOTICE,
  RESTORATION_NOTICE,
  RETAINED_RUNTIME_NOTICE,
  STATUS_POLL_MS,
  activationLabel,
  applyPatch,
  catalogScope,
  conflictLines,
  createTargetViews,
  customSeatIdError,
  emptyTargetView,
  errorMessage,
  familyHint,
  formSeatConflict,
  isDaemonHome,
  lineList,
  newOperationId,
  operationPending,
  operationRows,
  pollDelayAfterStatus,
  reconcileProblem,
  seatManagement,
  startPatch,
  stateHint,
  statusRows,
  targetKey,
  recoverPendingStart,
  thinkingOptionsFor,
  visibleConflicts,
} from "./manager-state.ts";
import type { ReconcileAction, TargetView } from "./manager-state.ts";
import {
  Badge,
  Button,
  Card,
  CheckRow,
  ChipSelect,
  Collapse,
  Field,
  KV,
  LanguageCard,
  OptionPicker,
  SeatTemplateRow,
  StatePill,
  SwitchRow,
  focusRing,
  styles,
} from "./ui-kit.tsx";
import type { Colors, ControlState } from "./ui-kit.tsx";
import { useLanguageCard } from "./cards/language.ts";
import { useRoutingCard, RoutingCard } from "./cards/routing.tsx";
import { useJevCard, JevCard, JEV_KIND_DEFAULT, JEV_KIND_LABEL } from "./cards/jev.tsx";
import { usePeerPoolCard, PeerPoolCard } from "./cards/peer-pool.tsx";
import { useWorkTrackerCard, WorkTrackerCard } from "./cards/work-tracker.tsx";
import { useSupervisionCard, SupervisionCard } from "./cards/supervision.tsx";

// Family knowledge derives from the shared registry (shared/families.ts):
// FAMILY_IDS is the canonical order, FAMILY_PICKER_ORDER the picker order
// (registry pickerRank), FAMILY_LABEL the display names — no local literals.
const AUTHORITY = { exclusiveAdministrativeWindow: true, verifiedHostHomeMapping: true } as const;


// In-surface nav — the mockup's left sidebar nav ported as a tab strip
// inside the routing region (the sidebar chrome itself is not ported).
const MANAGER_SECTIONS = [
  { id: "profiles", label: "Role profiles" },
  { id: "pool", label: "Peer pool" },
  { id: "language", label: "Communication language" },
  { id: "tracker", label: "Work tracker" },
  { id: "jev", label: "Jev" },
] as const;
type ManagerSectionId = (typeof MANAGER_SECTIONS)[number]["id"];

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/** Status rows that are audit/debug metadata — rendered inside the collapsed
 *  "Details" section so the card stays scannable. Everything else (state,
 *  canonical home, candidates, binding) stays visible: spec §4 requires the
 *  home and candidate to be shown before any mutation. */
const STATUS_DETAIL_LABELS = new Set([
  "Runtime",
  "Node",
  "Launch set",
  "Payload",
  "Baseline",
  "Retained runtimes",
  "Last verified",
  "Live acceptance",
]);

export function ManagerSurface({ host, layout, theme, navigation }: PluginSurfaceProps) {
  const colors = theme.colors;
  const compact = layout.compact;
  const callStatus = useRpc(status);
  const callActivate = useRpc(activate);
  const callReconcile = useRpc(reconcile);
  const callDeactivate = useRpc(deactivate);
  const callLocalTarget = useRpc(localTarget);
  const callCatalog = useRpc(catalog);
  const callSetLanguage = useRpc(setLanguage);
  const callGetRoleRouting = useRpc(getRoleRouting);
  const callSetRoleRouting = useRpc(setRoleRouting);
  const callGetJev = useRpc(getJev);
  const callSetJev = useRpc(setJev);
  const callSetJevKey = useRpc(setJevKey);
  const callTestJev = useRpc(testJev);
  const callGetPeerPool = useRpc(getPeerPool);
  const callGetWorkTracker = useRpc(getWorkTracker);
  const callSetWorkTracker = useRpc(setWorkTracker);
  const callSetPeerPool = useRpc(setPeerPool);
  const callGetSupervision = useRpc(getSupervision);
  const callSetSupervision = useRpc(setSupervision);

  const [detectedHome, setDetectedHome] = useState<string | null>(null);
  const [homeOverride, setHomeOverride] = useState("");
  const [exclusiveWindow, setExclusiveWindow] = useState(false);
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [adoptIdentical, setAdoptIdentical] = useState(false);
  const [nodePath, setNodePath] = useState("");
  const [binaries, setBinaries] = useState<Record<FamilyName, string>>(
    () => Object.fromEntries(FAMILY_IDS.map(family => [family, ""])) as Record<FamilyName, string>,
  );
  // Catalog entries are scoped `family|role` — providers.snapshot resolves
  // the managed provider id slp-<family>-<role>, so a supervisor and a peer
  // on the same family can report different catalogs.
  const [catalogs, setCatalogs] = useState<Partial<Record<string, CatalogResult>>>({});
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [catalogLoadingFor, setCatalogLoadingFor] = useState<string | null>(null);
  // Feature definitions depend on the selected model (the host requires a
  // provider/model draft) — cached per family|model|modeId key.
  const [featureSets, setFeatureSets] = useState<Record<string, { defs: CatalogResult["features"]; error: string | null }>>({});
  const [featuresLoadingFor, setFeaturesLoadingFor] = useState<string | null>(null);
  const [reconcileAction, setReconcileAction] = useState<ReconcileAction>("inspect");
  const [interruptedId, setInterruptedId] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [statusDetailsOpen, setStatusDetailsOpen] = useState(false);

  // In-surface section tabs (mockup sidebar → tab strip): a press switches
  // the active section — inactive sections stay mounted under display:none
  // so drafts and card-local state survive, but never lay out or scroll
  // into view.
  const [activeSection, setActiveSection] = useState<ManagerSectionId>("profiles");
  const sectionShown = (id: ManagerSectionId) => (activeSection === id ? null : { display: "none" as const });
  // Role profiles: the mockup's two-column .profile-grid, measured on the
  // card body container (never the window) — two panels ≥700px, else stacked.
  const [profilePanelWide, setProfilePanelWide] = useState(false);
  const scrollFocusNode = (node: unknown, focus = false) => {
    const dom = node as { scrollIntoView?: (options?: { block?: string }) => void; focus?: () => void } | null;
    dom?.scrollIntoView?.({ block: "nearest" });
    if (focus) dom?.focus?.();
  };
  const [store] = useState(createTargetViews);
  const [view, setView] = useState<TargetView>(emptyTargetView);

  const home = homeOverride.trim() !== "" ? homeOverride.trim() : (detectedHome ?? "");
  const target: TargetValue | null = isDaemonHome(home) ? { hostId: host.id, daemonHome: home } : null;
  const key = target ? targetKey(target) : null;
  const keyRef = useRef<string | null>(key);
  const autoLoadedFor = useRef<string | null>(null);
  const refreshedActivation = useRef<string | null>(null);

  // Prefill the daemon home from the plugin process's own environment
  // (PASEO_HOME else ~/.paseo). A suggestion only — the §4 mapping
  // acknowledgment remains a human decision, and Advanced can override it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detected = await callLocalTarget({ schemaVersion: 1 });
        if (!cancelled) setDetectedHome(detected.daemonHome);
      } catch { /* detection unavailable — the field stays empty for manual input */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Two-host isolation: each (hostId, daemonHome) keeps its own view state in
  // the store; switching the target swaps in that target's snapshot.
  useEffect(() => {
    keyRef.current = key;
    setView(target ? store.get(target) ?? emptyTargetView() : emptyTargetView());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key captures target
  }, [key]);

  // Bind every patch to the target the request was issued for: a late RPC
  // updates that target's stored view but repaints only while it is still the
  // displayed target — never old-target data over the new target's view.
  const update = useCallback((patch: Partial<TargetView>, forTarget: TargetValue) => {
    const { view, repaint } = applyPatch(store, forTarget, patch, keyRef.current);
    if (repaint) setView(view);
  }, [store]);

  const refresh = useCallback(async (forTarget: TargetValue, operationId?: string): Promise<StatusResult | null> => {
    try {
      const next = await callStatus({ schemaVersion: 1, target: forTarget, ...(operationId ? { operationId } : {}) });
      update({ status: next, lastError: null }, forTarget);
      return next;
    } catch (error) {
      update({ lastError: errorMessage(error) }, forTarget);
      return null;
    }
  }, [callStatus, update]);

  // Once a target is known (detected or typed), fetch status automatically —
  // read-only, so no authority acknowledgment is needed to inspect.
  useEffect(() => {
    if (!target || !key || view.status || view.busy || autoLoadedFor.current === key) return;
    autoLoadedFor.current = key;
    void refresh(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key captures target
  }, [key, view.status, view.busy]);

  const statusView = view.status;

  // Catalogs depend on the daemon and on the executable bound by activation.
  // A successful rebind can change the model set under the same family|role
  // key; stale cached options must not survive it.
  useEffect(() => {
    refreshedActivation.current = null;
    setCatalogs({});
    setFeatureSets({});
    setCatalogRevision(current => current + 1);
  }, [key]);
  useEffect(() => {
    const operation = statusView?.operation;
    if (operation?.kind !== "activate" || !["succeeded", "no-op"].includes(operation.outcome)) return;
    if (refreshedActivation.current === operation.operationId) return;
    refreshedActivation.current = operation.operationId;
    setCatalogs({});
    setFeatureSets({});
    setCatalogRevision(current => current + 1);
  }, [key, statusView?.operation]);

  // The stale-guard predicates are shell-owned — they read keyRef so every
  // card hook gates its post-await writes against the DISPLAYED target, not
  // the target the request was issued for.
  const sameTarget = (forTarget: TargetValue): boolean => keyRef.current === targetKey(forTarget);
  const isCurrentKey = (issueKey: string): boolean => keyRef.current === issueKey;

  // The language card owns its draft/apply lifecycle (prefill from status
  // until the Human edits, immediate-off toggle) — cards/language.ts.
  const language = useLanguageCard({ target, targetKey: key, isCurrentKey, statusView, callSetLanguage, refresh, update });

  // The routing card owns the stored value, the editable form, its
  // once-per-target load, prefill and save — cards/routing.tsx. `form` and
  // `featureKeys` feed the catalog-demand computation below; the caches
  // themselves stay shell-owned.
  const routing = useRoutingCard({
    target,
    targetKey: key,
    isCurrentKey,
    statusView,
    callGetRoleRouting,
    callSetRoleRouting,
    catalogs,
    featureSets,
    featuresLoadingFor,
    update,
  });

  // The Jev card owns its view, draft fields, load/save/key/test handlers
  // and target-switch reset — cards/jev.tsx. `sameTarget` is the shell-owned
  // stale-guard mechanism passed down unchanged.
  const jev = useJevCard({
    target,
    targetKey: key,
    sameTarget,
    callGetJev,
    callSetJev,
    callSetJevKey,
    callTestJev,
    update,
  });

  // The work-tracker card owns its view, once-per-target load and the
  // immediate toggle — cards/work-tracker.tsx. Per-daemon-home like Jev:
  // shows whenever a target resolves, independent of activation state.
  const tracker = useWorkTrackerCard({
    target,
    targetKey: key,
    sameTarget,
    callGetWorkTracker,
    callSetWorkTracker,
    update,
  });

  // The peer-pool card owns its snapshot/draft, seat handlers, editor UI
  // state and save/reload/import/copy — cards/peer-pool.tsx. `form` and
  // `featureKeys` feed the catalog-demand computation below; the caches,
  // the issueKey stale guard and the scroll helper stay shell-owned.
  const pool = usePeerPoolCard({
    target,
    targetKey: key,
    isCurrentKey,
    callGetPeerPool,
    callSetPeerPool,
    catalogs,
    featureSets,
    featuresLoadingFor,
    scrollFocusNode,
    update,
  });

  // The supervision card owns the config snapshot, draft (which Leads, what
  // happens on a finding, thresholds), agent pickers, CAS save/reload and
  // the findings readout — cards/supervision.tsx.
  // It loads with the target (independent of binding, like the Jev card).
  const supervision = useSupervisionCard({
    target,
    targetKey: key,
    isCurrentKey,
    callGetSupervision,
    callSetSupervision,
    update,
  });

  // "Retry catalog" (§7.4.E): the cached error entry is only overwritten
  // by a fresh RPC — a failed retry keeps the last error visible.
  const retryCatalog = async (family: FamilyName, role: RoleName) => {
    const scope = catalogScope(family, role);
    const issueKey = keyRef.current;
    setCatalogLoadingFor(scope);
    try {
      const result = await callCatalog({
        schemaVersion: 1, family, role,
        ...(target ? { cwd: target.daemonHome } : {}),
      });
      if (keyRef.current === issueKey) setCatalogs(current => ({ ...current, [scope]: result }));
    } catch (error) {
      if (keyRef.current === issueKey) {
        setCatalogs(current => ({
          ...current,
          [scope]: { schemaVersion: 1, models: [], modes: [], features: [], error: errorMessage(error) },
        }));
      }
    } finally {
      if (keyRef.current === issueKey) {
        setCatalogLoadingFor(current => (current === scope ? null : current));
      }
    }
  };


  // Fetch the model/mode catalog for the scopes the routing card and the
  // peer-pool seats pick — the routing card's two role-scoped picks plus
  // every seated family's peer scope are the only ones the form needs.
  // Cached per family|role scope; a failure caches an error result so the
  // picker degrades to free text instead of retrying forever.
  const neededScopes = [
    { family: routing.form.supervisor.family, role: "supervisor" as const },
    { family: routing.form.lead.family, role: "lead" as const },
    ...pool.poolForm.seats.map(seat => ({ family: seat.family, role: "peer" as const })),
  ].filter((scope): scope is { family: FamilyName; role: RoleName } => scope.family !== "");
  const neededKey = [...new Set(neededScopes.map(scope => catalogScope(scope.family, scope.role)))].join(",");
  useEffect(() => {
    const missing = neededKey.split(",").filter(k => k !== "" && catalogs[k] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const scope of missing) {
        const [family, role] = scope.split("|") as [FamilyName, RoleName];
        setCatalogLoadingFor(scope);
        try {
          const result = await callCatalog({
            schemaVersion: 1, family, role,
            ...(target ? { cwd: target.daemonHome } : {}),
          });
          if (!cancelled) setCatalogs(current => ({ ...current, [scope]: result }));
        } catch {
          if (!cancelled) {
            const failed: CatalogResult = {
              schemaVersion: 1, models: [], modes: [], features: [],
              error: "Catalog query failed",
            };
            setCatalogs(current => ({ ...current, [scope]: failed }));
          }
        }
      }
      if (!cancelled) setCatalogLoadingFor(null);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the needed scope set
  }, [neededKey, catalogRevision]);

  // Feature definitions need a model — fetch per role's routing-form
  // family|role|model|modeId pick (features resolve against the managed
  // provider id, which differs per role on the snapshot path). The routing
  // card declares its keys; each pool seat declares its own below.
  const neededFeatureKeys = routing.featureKeys.concat(pool.featureKeys);
  const neededFeaturesKey = neededFeatureKeys.join(",");
  // A failed feature-defs fetch keeps the raw-JSON fallback but records the
  // error — silently caching [] made a dropped mobile RPC look exactly like
  // "provider declares no features". One automatic retry absorbs transient
  // drops; only a persistent failure degrades to the JSON field + Retry.
  const fetchFeatureSet = async (key: string) => {
    const [family, role, model, modeId] = key.split("|") as [FamilyName, RoleName, string, string];
    const request = {
      schemaVersion: 1 as const, family, role, model,
      ...(modeId ? { modeId } : {}),
      ...(target ? { cwd: target.daemonHome } : {}),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await callCatalog(request);
        setFeatureSets(current => ({ ...current, [key]: { defs: result.features, error: result.error } }));
        return;
      } catch (error) {
        if (attempt === 1) {
          setFeatureSets(current => ({ ...current, [key]: { defs: [], error: errorMessage(error) } }));
        } else {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
    }
  };
  useEffect(() => {
    const missing = neededFeaturesKey.split(",").filter(k => k !== "" && featureSets[k] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const key of missing) {
        setFeaturesLoadingFor(key);
        await fetchFeatureSet(key);
        if (cancelled) return;
      }
      if (!cancelled) setFeaturesLoadingFor(null);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the needed feature set
  }, [neededFeaturesKey, catalogRevision]);
  const retryFeatureSet = async (key: string) => {
    setFeaturesLoadingFor(key);
    await fetchFeatureSet(key);
    setFeaturesLoadingFor(null);
  };

  // Poll the tracked operation until it reaches a terminal outcome. The first
  // delay is the server's pollAfterMs; later polls run every STATUS_POLL_MS.
  const pending = view.pending;
  useEffect(() => {
    if (!target || !pending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => { timer = setTimeout(tick, ms); };
    const tick = async () => {
      const next = await refresh(target, pending.operationId);
      if (cancelled) return;
      if (next == null) { schedule(STATUS_POLL_MS); return; }
      if (operationPending(next.operation)) { schedule(pollDelayAfterStatus(next)); return; }
      update({ pending: null }, target);
    };
    schedule(pending.nextPollMs);
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm only on target/operation change
  }, [key, pending?.operationId]);

  const runOperation = useCallback(async (invoke: () => Promise<StartResult>, operationId: string) => {
    if (!target || view.busy) return;
    update({ busy: true, lastError: null, notice: null }, target);
    const finish = (start: StartResult) => {
      // startPatch keeps start.conflicts visible whether or not the response
      // was accepted — an accepted reconcile inspect can still report drift.
      update(startPatch(start), target);
      void refresh(target);
    };
    try {
      finish(await invoke());
    } catch (error) {
      // §3: an invoke timeout does not cancel server-side work. Poll the
      // original operationId and retry the identical request only when status
      // reports it absent — never assume the timeout cancelled anything.
      let probe: StatusResult | null = null;
      try {
        probe = await callStatus({ schemaVersion: 1, target, operationId });
      } catch { /* probe failure reported below */ }
      if (probe == null) {
        update({ busy: false, lastError: `${errorMessage(error)} (status probe failed as well)` }, target);
        return;
      }
      update({ status: probe }, target);
      const recovery = recoverPendingStart(operationId, probe);
      if (recovery.kind === "retry") {
        try {
          finish(await invoke());
        } catch (again) {
          update({ busy: false, lastError: errorMessage(again) }, target);
        }
      } else if (recovery.kind === "poll") {
        update({
          busy: false,
          pending: { operationId, nextPollMs: STATUS_POLL_MS },
          notice: "start call did not return; the operation was accepted — tracking it",
        }, target);
      } else if (recovery.kind === "settled") {
        update({ busy: false, pending: null }, target);
      } else {
        update({ busy: false, lastError: recovery.message }, target);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key captures target
  }, [key, view.busy, update, callStatus, refresh]);

  const canMutate = target != null && exclusiveWindow && mappingConfirmed && !view.busy;
  // Conflicts from the last start response, the tracked operation's own
  // status(opId) results, and the status itself — merged and deduped; an
  // accepted or succeeded operation's conflicts stay visible.
  const conflictList = visibleConflicts(view);

  // The peer-pool family picker offers only families the host reports as
  // available (registry picker order) — a seat's stored family that is no
  // longer available keeps an "(unavailable)" escape-hatch chip.
  const availableFamilies: FamilyName[] = FAMILY_PICKER_ORDER.filter(family =>
    statusView?.families.find(view => view.family === family)?.availability === "available",
  );

  // `initialProfileFamily` and `profiles` stay activate RPC inputs for
  // scripted use — the UI never sends either; the routing card is the
  // single role→provider configurator and applies through activation.
  const activateInput = (): Parameters<typeof callActivate>[0] | { error: string } => {
    if (!target || !statusView) return { error: "No target" };
    return {
      schemaVersion: 1,
      target,
      operationId: newOperationId(),
      authority: AUTHORITY,
      candidateSha256: statusView.embeddedCandidateSha256,
      adoptIdentical,
      ...(nodePath.trim() ? { nodePath: nodePath.trim() } : {}),
      binaries: Object.fromEntries(
        FAMILY_IDS.map(family => [family, binaries[family].trim()] as const).filter(([, path]) => path !== ""),
      ),
    };
  };

  const runActivate = () => {
    const input = activateInput();
    if ("error" in input) { update({ lastError: input.error }, target!); return; }
    void runOperation(() => callActivate(input), input.operationId);
  };

  const runReconcile = () => {
    // §4: canonical home + candidate must be displayed before any operation —
    // reconcile is gated on a loaded status like activate/deactivate.
    if (!target || !statusView) return;
    const problem = reconcileProblem(reconcileAction, interruptedId);
    if (problem) { update({ lastError: problem }, target); return; }
    const input: Parameters<typeof callReconcile>[0] = {
      schemaVersion: 1,
      target,
      operationId: newOperationId(),
      authority: AUTHORITY,
      action: reconcileAction,
      ...(reconcileAction !== "inspect" ? { interruptedOperationId: interruptedId.trim() } : {}),
    };
    void runOperation(() => callReconcile(input), input.operationId);
  };

  const runDeactivate = () => {
    const binding = statusView?.binding;
    if (!target || !binding) return;
    const input: Parameters<typeof callDeactivate>[0] = {
      schemaVersion: 1,
      target,
      operationId: newOperationId(),
      authority: AUTHORITY,
      expectedBindingSha256: binding.bindingSha256,
    };
    void runOperation(() => callDeactivate(input), input.operationId);
  };

  return (
    <ScrollView
      contentContainerStyle={{ padding: compact ? 12 : 24, gap: compact ? 12 : 16 }}
    >
      <View style={styles.headerRow}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={[styles.pageTitle, { color: colors.foreground }]}>SLP</Text>
          <Text style={[styles.muted, { color: colors.foregroundMuted }]}>
            Provider hierarchy on {host.label}
          </Text>
        </View>
        <StatePill colors={colors} state={statusView?.state ?? null} />
      </View>

      <Card
        colors={colors}
        title="Daemon home"
        subtitle="Detected from this daemon's environment — use Advanced to manage a different home."
      >
        {home ? (
          <KV colors={colors} label="Daemon home" value={home} />
        ) : (
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
            Daemon home not detected — configure one under Advanced.
          </Text>
        )}
        <Button
          colors={colors}
          label={statusView ? "Refresh" : "Inspect"}
          onPress={() => { if (target) void refresh(target); }}
          disabled={!target || view.busy}
        />
      </Card>

      {statusView ? (
        <Card
          colors={colors}
          title="Status"
          subtitle={stateHint(statusView.state) || undefined}
        >
          {statusRows(statusView, { compact })
            .filter(row => !STATUS_DETAIL_LABELS.has(row.label))
            .map(row => (
              <KV key={row.label} colors={colors} label={row.label} value={row.value} />
            ))}
          <View style={{ gap: 6 }}>
            <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Provider families</Text>
            <View style={styles.chipRow}>
              {statusView.families.map(family => (
                <View
                  key={family.family}
                  style={[
                    styles.chip,
                    { borderColor: family.availability === "available" ? colors.statusSuccess : colors.statusWarning },
                  ]}
                >
                  <Text style={[styles.chipLabel, { color: colors.foreground }]}>
                    {FAMILY_LABEL[family.family]} · {familyHint(family, { compact: true })}
                  </Text>
                </View>
              ))}
            </View>
          </View>
          {statusView.operation ? (
            <KV
              colors={colors}
              label="Last operation"
              value={`${statusView.operation.kind} · ${statusView.operation.outcome}`}
            />
          ) : null}
          <Collapse
            colors={colors}
            title="Details"
            subtitle="Runtime paths, hashes, and operation metadata"
            open={statusDetailsOpen}
            onToggle={() => setStatusDetailsOpen(open => !open)}
          >
            {statusRows(statusView, { compact })
              .filter(row => STATUS_DETAIL_LABELS.has(row.label))
              .map(row => (
                <KV key={row.label} colors={colors} label={row.label} value={row.value} />
              ))}
            {statusView.operation
              ? operationRows(statusView.operation).map(row => (
                  <KV key={row.label} colors={colors} label={row.label} value={row.value} />
                ))
              : null}
          </Collapse>
          {view.pending ? <KV colors={colors} label="Polling" value={`operation ${view.pending.operationId}`} /> : null}
          {view.busy ? <KV colors={colors} label="Busy" value="start call in flight" /> : null}
          {view.notice ? <KV colors={colors} label="Note" value={view.notice} /> : null}
          {view.lastError ? (
            <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>{view.lastError}</Text>
          ) : null}
          {conflictList.length > 0 ? (
            <View style={[styles.conflictBox, { borderColor: colors.statusDanger }]}>
              <Text style={[styles.fieldLabel, { color: colors.statusDanger }]}>
                {conflictList.length} conflict{conflictList.length === 1 ? "" : "s"}
              </Text>
              {conflictLines(conflictList, compact ? 4 : 8).map((line, index) => (
                <Text key={index} style={[styles.mutedSmall, { color: colors.foreground }]} selectable>
                  {line}
                </Text>
              ))}
            </View>
          ) : null}
        </Card>
      ) : null}

      <Card
        colors={colors}
        title="Activation"
        subtitle={statusView ? undefined : "Inspect the daemon first — the candidate and conflicts must be visible before any change."}
      >
        <CheckRow
          colors={colors}
          checked={exclusiveWindow}
          onToggle={setExclusiveWindow}
          title="Exclusive configuration window"
          hint="No other writers may edit daemon configuration while an operation runs"
        />
        <CheckRow
          colors={colors}
          checked={mappingConfirmed}
          onToggle={setMappingConfirmed}
          disabled={!target}
          title="Daemon home confirmed"
          hint={target ? `${target.daemonHome} is the home of this daemon` : "Detect or configure the daemon home first"}
        />
        <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
          {EXCLUSIVE_WINDOW_NOTICE}
        </Text>
        {!statusView?.binding ? (
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
            Activation creates the SLP Supervisor and SLP Lead agent profiles, bound per
            the Role profiles card — an unrouted role falls back to the first enabled,
            available family.
          </Text>
        ) : null}
        <Button
          colors={colors}
          kind="primary"
          label={statusView ? activationLabel(statusView) : "Activate"}
          onPress={runActivate}
          disabled={!canMutate || !statusView}
        />
      </Card>

      {statusView ? (
        // The routing region's own intro — the mockup's .route-intro eyebrow +
        // headline + sub-copy, then the sidebar nav ported as an in-surface
        // tab strip. The host SLP header and the prototype's sidebar chrome
        // stay outside this surface.
        <View style={{ gap: compact ? 8 : 12 }}>
          <View style={{ gap: 4 }}>
            <Text style={[styles.eyebrow, { color: colors.foregroundMuted }]}>Routing configuration</Text>
            <Text style={[styles.routingHeadline, { color: colors.foreground }]}>Peer routing configuration</Text>
            <Text style={[styles.muted, { color: colors.foregroundMuted }]}>
              Review the draft. Save when the whole pool is ready.
            </Text>
          </View>
          <View role="tablist" accessibilityLabel="Manager sections" style={styles.navStrip}>
            {MANAGER_SECTIONS.map(section => {
              const active = activeSection === section.id;
              return (
                <Pressable
                  key={section.id}
                  onPress={() => setActiveSection(section.id)}
                  accessibilityRole="tab"
                  accessibilityLabel={`${section.label} tab`}
                  accessibilityState={{ selected: active }}
                  style={(state: ControlState) => [
                    styles.navItem,
                    compact && styles.navItemCompact,
                    (active || (state.hovered && !active)) && { backgroundColor: colors.surface2 },
                    state.focused && focusRing(colors),
                    state.pressed && { opacity: 0.75 },
                  ]}
                >
                  <Text
                    style={[
                      styles.navLabel,
                      compact && { fontSize: 12 },
                      { color: active ? colors.accent : colors.foregroundMuted },
                      active && { fontWeight: "700" },
                    ]}
                  >
                    {section.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {statusView ? (
        // ONE card edits the full profile each role binds — family, model,
        // mode, feature values, thinking option — behind one Save issuing a
        // single set-role-routing call with the full routing object
        // (saveRouting always builds both roles). The stored routing is the
        // sole role→provider configurator and applies at the NEXT
        // activation — saving never activates on its own, and a divergence
        // between the stored routing and the live binding shows once on the
        // card. The peer note lives inside this card because it scopes what
        // routing does NOT configure; a separate card would orphan one line
        // of disclosure.
        <View style={sectionShown("profiles")}>
        <RoutingCard
          colors={colors}
          target={target}
          statusView={statusView}
          routing={routing}
          catalogs={catalogs}
          catalogLoadingFor={catalogLoadingFor}
          retryCatalog={retryCatalog}
          retryFeatureSet={retryFeatureSet}
        />
        </View>
      ) : null}

      {target ? (
        // The user-scope Peer pool — slp-runtime/state/peer-pool.json, the
        // catalog readCatalog resolves for every repository without its own
        // .paseo-slp/slp-routing.json. This card is its sole writer; it loads
        // with the target (independent of binding, like the Jev card) and a
        // save takes effect the next time a Lead reads `routes`.
        <View style={sectionShown("pool")}>
        <PeerPoolCard
          colors={colors}
          target={target}
          compact={compact}
          statusView={statusView}
          jev={jev}
          pool={pool}
          availableFamilies={availableFamilies}
          catalogs={catalogs}
          catalogLoadingFor={catalogLoadingFor}
          retryCatalog={retryCatalog}
          retryFeatureSet={retryFeatureSet}
          scrollFocusNode={scrollFocusNode}
        />
        </View>
      ) : null}

      {statusView ? (
        <View style={sectionShown("language")}>
        <LanguageCard
          colors={colors}
          disabled={language.disabled}
          busy={language.busy}
          on={language.on}
          value={language.value}
          onToggle={language.onToggle}
          onChangeText={language.onChangeText}
          onApply={language.onApply}
        />
        </View>
      ) : null}

      {target ? (
        // Work tracker is per-daemon-home like Jev — shows whenever a target
        // resolves. Detect, never install: the card reports bd presence and
        // the toggle only; there is deliberately no install/init button.
        <View style={sectionShown("tracker")}>
        <WorkTrackerCard colors={colors} target={target} tracker={tracker} />
        </View>
      ) : null}

      {target ? (
        // Jev config is per-daemon-home — independent of activation state, so
        // the card shows whenever a target resolves (unlike the binding-bound
        // cards above). Provider kind selects the wire contract (OpenRouter
        // Decisions API vs TypeSafe first-party System One); model/baseUrl
        // default per kind, and toggles save through one set-jev call taking
        // effect at the NEXT preparation — a running session is never
        // mutated. The key is write-only: the card reports hasKey, never the
        // value.
        <View style={sectionShown("jev")}>
        <JevCard colors={colors} target={target} jev={jev} />
        {/* Supervision config is per-daemon-home plugin state (same class as
            the Jev card) — daemon defaults for discovered Leads plus explicit
            per-Lead routes, CAS-guarded whole-file saves, served-home
            verified server-side.
            The card mounts inside the Jev section: supervision assessments
            run through the same Jev config this section edits, and its
            on/off switch is the Jev supervision capability. */}
        <SupervisionCard colors={colors} target={target} jev={jev} supervision={supervision} navigation={navigation} />
        </View>
      ) : null}

      <Collapse
        colors={colors}
        title="Advanced"
        subtitle="Executable overrides and recovery options"
        open={showAdvanced}
        onToggle={setShowAdvanced}
      >
        <Field
          colors={colors}
          label="Daemon home"
          hint="Detected automatically — change only to manage a different daemon home"
          value={homeOverride}
          onChangeText={setHomeOverride}
          placeholder={detectedHome ?? "/absolute/path/to/paseo-home"}
        />
        {homeOverride.trim() !== "" && !isDaemonHome(homeOverride.trim()) ? (
          <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>Enter an absolute path</Text>
        ) : null}
        <SwitchRow
          colors={colors}
          checked={adoptIdentical}
          onToggle={setAdoptIdentical}
          disabled={!canMutate}
          title="Adopt identical entries"
          hint="Adopt byte-identical existing SLP entries — recovery after a crash between patch and receipt"
        />
        <Field
          colors={colors}
          label="Node.js path (optional)"
          hint="Absolute path to a standard Node.js binary; an invalid value fails activation instead of falling back"
          value={nodePath}
          onChangeText={setNodePath}
          placeholder="/usr/bin/node"
          disabled={!canMutate}
        />
        {FAMILY_IDS.map(family => (
          <Field
            key={family}
            colors={colors}
            label={`${FAMILY_LABEL[family]} executable (optional)`}
            value={binaries[family]}
            onChangeText={text => setBinaries(previous => ({ ...previous, [family]: text }))}
            placeholder={`/absolute/path/to/${family}`}
            disabled={!canMutate}
          />
        ))}
      </Collapse>

      <Collapse
        colors={colors}
        title="Maintenance"
        subtitle="Drift inspection, interrupted operations, and deactivation"
        open={showMaintenance}
        onToggle={setShowMaintenance}
      >
        <View style={styles.field}>
          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Reconcile action</Text>
          <ChipSelect<ReconcileAction>
            colors={colors}
            value={reconcileAction}
            options={[
              { label: "Inspect", value: "inspect" as const },
              { label: "Complete", value: "complete" as const },
              { label: "Restore before", value: "restore-before" as const },
            ]}
            onChange={setReconcileAction}
            disabled={!canMutate}
          />
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
            Inspect is read-only; Complete and Restore before finish an interrupted operation
          </Text>
        </View>
        {reconcileAction !== "inspect" ? (
          <Field
            colors={colors}
            label="Interrupted operation ID"
            hint="Required for Complete and Restore before"
            value={interruptedId}
            onChangeText={setInterruptedId}
            placeholder="uuid"
            disabled={!canMutate}
          />
        ) : null}
        <Button
          colors={colors}
          label="Reconcile"
          onPress={runReconcile}
          disabled={!canMutate || !statusView}
        />
        <View style={[styles.divider, { borderTopColor: colors.border }]} />
        <View style={styles.field}>
          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Deactivate</Text>
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{RESTORATION_NOTICE}</Text>
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{RETAINED_RUNTIME_NOTICE}</Text>
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{DISABLE_REMOVE_NOTICE}</Text>
          <Button
            colors={colors}
            kind="danger"
            label="Deactivate"
            onPress={runDeactivate}
            disabled={!canMutate || !statusView?.binding}
          />
        </View>
      </Collapse>
    </ScrollView>
  );
}
