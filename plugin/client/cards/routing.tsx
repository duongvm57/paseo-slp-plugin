// Routing owns its stored value, draft/prefill, setters and save. Target async
// owns snapshot reads and session tickets; RPC callables are the adapter seam.
// Dirty routing drafts intentionally persist across targets. The shell supplies
// status, shared catalog read views and target-bound lastError plumbing.
import { useEffect, useState } from "react";
import { useTargetSnapshot } from "../target-async.ts";
import { Text, View } from "react-native";
import type {
  CatalogResult,
  FamilyName,
  GetRoleRoutingRequest,
  GetRoleRoutingResult,
  RoleRoutingValue,
  SetRoleRoutingRequest,
  SetRoleRoutingResult,
  StatusResult,
  TargetValue,
} from "../../shared/contracts.ts";
import { FAMILY_LABEL, FAMILY_PICKER_ORDER } from "../../shared/runtime/families.ts";
import type { RoleName } from "../../shared/runtime/families.ts";
import {
  activationLabel,
  applyFamilyChange,
  applySettingChange,
  buildRoleChoice,
  catalogScope,
  errorMessage,
  familyFromProviderId,
  featureKey,
  routingChoiceDiffers,
  routingDiverges,
  thinkingOptionsFor,
} from "../manager-state.ts";
import type { RoutingRoleForm } from "../manager-state.ts";
import type { Colors } from "../ui-kit.tsx";
import { Button, Card, ChipSelect, Field, OptionPicker, styles, SwitchRow } from "../ui-kit.tsx";

const sameRoleForm = (a: RoutingRoleForm, b: RoutingRoleForm): boolean =>
  a.family === b.family &&
  a.model === b.model &&
  a.modeId === b.modeId &&
  a.thinkingOptionId === b.thinkingOptionId &&
  a.features === b.features &&
  Object.keys(a.feature).length === Object.keys(b.feature).length &&
  Object.keys(a.feature).every(key => a.feature[key] === b.feature[key]);

export const emptyRoutingRoleForm = (): RoutingRoleForm => ({
  family: "codex",
  model: "",
  modeId: "",
  thinkingOptionId: "",
  features: "",
  feature: {},
});

export const emptyRoutingForm = () => ({
  supervisor: emptyRoutingRoleForm(),
  lead: emptyRoutingRoleForm(),
});

export type RoutingForm = ReturnType<typeof emptyRoutingForm>;
type RoutingRole = "supervisor" | "lead";

export function useRoutingCard({ target, targetKey, isCurrentKey, statusView, callGetRoleRouting, callSetRoleRouting, catalogs, featureSets, featuresLoadingFor, update }: {
  target: TargetValue | null;
  targetKey: string | null;
  isCurrentKey: (key: string) => boolean;
  statusView: StatusResult | null;
  callGetRoleRouting: (input: GetRoleRoutingRequest) => Promise<GetRoleRoutingResult>;
  callSetRoleRouting: (input: SetRoleRoutingRequest) => Promise<SetRoleRoutingResult>;
  catalogs: Partial<Record<string, CatalogResult>>;
  featureSets: Record<string, { defs: CatalogResult["features"]; error: string | null }>;
  featuresLoadingFor: string | null;
  update: (patch: { lastError: string | null }, target: TargetValue) => void;
}) {
  // `routing` is the stored server-side value, `routingForm` the editable
  // copy covering every RoleChoice field. The saved choice spreads the
  // stored entry first so any field the schema later adds passes through
  // untouched — the card never silently drops a stored choice.
  const snapshot = useTargetSnapshot(target, targetKey, async target =>
    (await callGetRoleRouting({ schemaVersion: 1, target })).routing);
  const { data: routing, replace: setRouting, capture } = snapshot;
  const [routingForm, setRoutingForm] = useState<RoutingForm>(emptyRoutingForm);
  const [routingDirty, setRoutingDirty] = useState(false);
  const [routingBusy, setRoutingBusy] = useState(false);
  // `routingSaved` shows a one-line confirmation after a bound save until
  // the next edit — the bound case otherwise gives no visible feedback.
  const [routingSaved, setRoutingSaved] = useState(false);

  // Prefill the routing form from the stored routing until the Human edits —
  // every field falls back to the live profile's value, then the defaults.
  // Same tracking discipline as the language form.
  useEffect(() => {
    if (routingDirty) return;
    const liveOf = (role: RoutingRole) =>
      statusView?.managedProfiles.find(profile => profile.id === `slp-${role}`);
    const prefill = (role: RoutingRole): RoutingRoleForm => {
      const stored = routing?.[role];
      const live = liveOf(role);
      const featureValues = stored?.featureValues ?? live?.featureValues;
      const feature: Record<string, string> = {};
      for (const [featureId, value] of Object.entries(featureValues ?? {})) {
        feature[featureId] = typeof value === "boolean" ? String(value) : String(value ?? "");
      }
      return {
        family:
          stored?.family ??
          (familyFromProviderId(live?.provider) as FamilyName | null) ??
          "codex",
        model: stored?.model ?? live?.model ?? "",
        modeId: stored?.modeId ?? live?.modeId ?? "",
        thinkingOptionId: stored?.thinkingOptionId ?? live?.thinkingOptionId ?? "",
        features: featureValues ? JSON.stringify(featureValues) : "",
        feature,
      };
    };
    const next = { supervisor: prefill("supervisor"), lead: prefill("lead") };
    setRoutingForm(current =>
      sameRoleForm(current.supervisor, next.supervisor) &&
      sameRoleForm(current.lead, next.lead)
        ? current
        : next,
    );
  }, [routing, statusView, routingDirty]);

  // Transient flags are per-target: a guarded save-finally skips its busy
  // clear when the target switched, so the switch itself releases the
  // abandoned flag — and a "Saved" badge earned on home A must not carry
  // over to home B. The dirty form deliberately persists across switches.
  useEffect(() => {
    setRoutingBusy(false);
    setRoutingSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey captures target
  }, [targetKey]);

  // A model or mode pick is not a plain field write: feature defs are keyed
  // family|model|modeId, so values authored under the previous key must
  // clear (applySettingChange) instead of persisting undeclared keys — and
  // a model that resolves with zero thinking options clears a stored
  // thinkingOptionId since no control can surface or correct it.
  const setField = (
    role: RoutingRole,
    field: "model" | "modeId" | "thinkingOptionId" | "features",
  ) => (value: string) => {
    setRoutingDirty(true);
    setRoutingSaved(false);
    setRoutingForm(current => ({
      ...current,
      [role]: field === "model" || field === "modeId"
        ? applySettingChange(current[role], field, value, catalogs[catalogScope(current[role].family, role)])
        : { ...current[role], [field]: value },
    }));
  };

  // An explicit family switch is not a single-field write: dependents
  // re-validate against the NEW family's catalog — applyFamilyChange keeps
  // only the model/mode/thinking values the new catalog lists and always
  // clears the per-provider feature values. Two edges are deliberate (B20):
  // re-pressing the active chip still clears features, and a family whose
  // catalog is not loaded yet clears dependents with no re-prefill on
  // arrival — re-prefill would race with edits made during the load.
  // Same dirty/saved discipline as the field setters.
  const setFamily = (
    role: RoutingRole,
  ) => (family: FamilyName) => {
    setRoutingDirty(true);
    setRoutingSaved(false);
    setRoutingForm(current => ({
      ...current,
      [role]: applyFamilyChange(current[role], family, catalogs[catalogScope(family, role)]),
    }));
  };

  const setFeature = (
    role: RoutingRole,
    featureId: string,
  ) => (value: string) => {
    setRoutingDirty(true);
    setRoutingSaved(false);
    setRoutingForm(current => ({
      ...current,
      [role]: { ...current[role], feature: { ...current[role].feature, [featureId]: value } },
    }));
  };

  const featureKeyFor = (role: RoutingRole): string | null => {
    const family = routingForm[role].family;
    const model = routingForm[role].model.trim();
    if (!model) return null;
    return featureKey(family, role, model, routingForm[role].modeId.trim());
  };
  const featureDefsFor = (role: RoutingRole) => {
    const key = featureKeyFor(role);
    const set = key ? featureSets[key] : undefined;
    return {
      key,
      defs: set?.defs ?? [],
      error: set?.error ?? null,
      loading: key !== null && featuresLoadingFor === key,
    };
  };

  // The Save diff-gate (spec §9): ONE build path produces the choices the
  // gate compares and save dispatches. Save enables when a bound form
  // builds to a routing that differs from the stored one — a bound form
  // equal to stored leaves nothing to persist (a save would be a no-op),
  // while a stored-absent routing always differs because the prefilled form
  // carries a config worth persisting.
  const builds = {
    supervisor: buildRoleChoice("supervisor", routingForm.supervisor, routing?.supervisor, featureDefsFor("supervisor").defs),
    lead: buildRoleChoice("lead", routingForm.lead, routing?.lead, featureDefsFor("lead").defs),
  };
  const differs =
    routingChoiceDiffers(builds.supervisor, routing?.supervisor) ||
    routingChoiceDiffers(builds.lead, routing?.lead);
  const diverged = routingDiverges(routing, statusView?.managedProfiles ?? []);

  // Save validates through the strict schema server-side and lands
  // atomically; it takes effect at the NEXT activation — never here. The
  // choices are the same builds the Save diff-gate compares, so an enabled
  // button can never write something the gate did not see, and a malformed
  // feature-values JSON arrives here as the build's error and surfaces in
  // lastError before dispatch rather than mid-operation.
  const save = async () => {
    if (!target || !targetKey) return;
    const supervisor = builds.supervisor;
    if ("error" in supervisor) { update({ lastError: supervisor.error }, target); return; }
    const lead = builds.lead;
    if ("error" in lead) { update({ lastError: lead.error }, target); return; }
    const ticket = capture();
    setRoutingBusy(true);
    try {
      const result = await callSetRoleRouting({
        schemaVersion: 1,
        target,
        routing: { schemaVersion: 1, supervisor: supervisor.choice, lead: lead.choice } as RoleRoutingValue,
      });
      // Stale-write guard (the issueKey discipline the pool ops use): a save
      // issued for home A must not land its routing on home B's view, clear
      // B's dirty gate, or flash "Saved" for a write B never saw.
      if (!ticket.isCurrent()) return;
      setRouting(result.routing);
      setRoutingDirty(false);
      setRoutingSaved(true);
    } catch (error) {
      update({ lastError: errorMessage(error) }, target);
    } finally {
      // A stale op must not clear the busy flag of a newer op already
      // in-flight on the displayed target — the target-switch reset above
      // releases the flag for the abandoned view instead.
      if (ticket.isCurrent()) setRoutingBusy(false);
    }
  };

  return {
    form: routingForm,
    busy: routingBusy,
    saved: routingSaved,
    differs,
    diverged,
    featureKeys: [featureKeyFor("supervisor"), featureKeyFor("lead")] as (string | null)[],
    featureDefsFor,
    setField,
    setFamily,
    setFeature,
    save,
  };
}

// ---------------------------------------------------------------------------
// View — render-only (wave 11 S3c). The hook above owns all state and
// handlers; this component paints them. The panel-width breakpoint state is
// presentation-local.
// ---------------------------------------------------------------------------

export type RoutingCardState = ReturnType<typeof useRoutingCard>;

export function RoutingCard({ colors, target, statusView, routing, catalogs, catalogLoadingFor, retryCatalog, retryFeatureSet }: {
  colors: Colors;
  target: TargetValue | null;
  statusView: StatusResult | null;
  routing: RoutingCardState;
  catalogs: Partial<Record<string, CatalogResult>>;
  catalogLoadingFor: string | null;
  retryCatalog: (family: FamilyName, role: RoleName) => Promise<unknown>;
  retryFeatureSet: (key: string) => Promise<unknown>;
}) {
  const [profilePanelWide, setProfilePanelWide] = useState(false);
  return (
    <Card
      colors={colors}
      title="Role profiles"
      subtitle="The provider, model, mode, feature values, and thinking option each role's profile binds — applied at the next activation."
    >
      <View
        style={[styles.profileGrid, { flexDirection: profilePanelWide ? "row" : "column", alignItems: "flex-start" }]}
        onLayout={event => setProfilePanelWide(event.nativeEvent.layout.width >= 700)}
      >
      {(["supervisor", "lead"] as const).map(role => {
        const form = routing.form[role];
        const roleCatalog = catalogs[catalogScope(form.family, role)];
        const thinking = thinkingOptionsFor(roleCatalog, form.model);
        const featureDefs = routing.featureDefsFor(role);
        const disabled = !target || routing.busy;
        return (
          <View
            key={role}
            style={[styles.profilePanel, { borderColor: colors.border, backgroundColor: colors.surface0 }, profilePanelWide && { flex: 1, minWidth: 0 }]}
          >
            <View style={[styles.profileHeading, { borderBottomColor: colors.border }]}>
              <Text style={[styles.profileRole, { color: colors.foreground }]}>
                {role === "supervisor" ? "SLP Supervisor" : "SLP Lead"}
              </Text>
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                {role === "supervisor" ? "Supervision and review" : "Task planning and delegation"}
              </Text>
            </View>
            <View style={styles.field}>
              <Text style={[styles.legend, { color: colors.foregroundMuted }]}>Provider family</Text>
              <ChipSelect
                colors={colors}
                variant="choice"
                value={form.family}
                options={FAMILY_PICKER_ORDER.map(entry => ({
                  label: FAMILY_LABEL[entry],
                  value: entry,
                }))}
                onChange={routing.setFamily(role)}
                disabled={disabled}
              />
            </View>
            {catalogLoadingFor === catalogScope(form.family, role) ? (
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                Loading {FAMILY_LABEL[form.family]} catalog…
              </Text>
            ) : null}
            {roleCatalog?.error ? (
              <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
                Catalog unavailable: {roleCatalog.error} — enter values manually.
              </Text>
            ) : null}
            {roleCatalog && roleCatalog.models.length > 0 ? (
              <OptionPicker
                colors={colors}
                label="Model"
                hint="Provider default when unset"
                options={roleCatalog.models}
                value={form.model}
                onChange={routing.setField(role, "model")}
                onOpen={() => { void retryCatalog(form.family, role); }}
                disabled={disabled}
                placeholder="Filter models…"
              />
            ) : (
              <Field
                colors={colors}
                label="Model"
                hint="Provider default when unset"
                value={form.model}
                onChangeText={routing.setField(role, "model")}
                placeholder="Model ID — e.g. swe-2-max"
                disabled={disabled}
              />
            )}
            {roleCatalog?.models.length === 0 ? (
              <Button
                colors={colors}
                label="Refresh models"
                onPress={() => { void retryCatalog(form.family, role); }}
                disabled={disabled || catalogLoadingFor === catalogScope(form.family, role)}
              />
            ) : null}
            {roleCatalog && roleCatalog.modes.length > 0 ? (
              <View style={styles.field}>
                <Text style={[styles.legend, { color: colors.foregroundMuted }]}>Mode</Text>
                <ChipSelect
                  colors={colors}
                  variant="choice"
                  value={form.modeId}
                  options={[
                    { label: "Provider default", value: "" },
                    ...roleCatalog.modes.map(mode => ({ label: mode.label, value: mode.id })),
                    // A stored mode the catalog doesn't list stays visible.
                    ...(form.modeId !== "" && !roleCatalog.modes.some(mode => mode.id === form.modeId)
                      ? [{ label: form.modeId, value: form.modeId }]
                      : []),
                  ]}
                  onChange={routing.setField(role, "modeId")}
                  disabled={disabled}
                />
              </View>
            ) : (
              <Field
                colors={colors}
                label="Mode"
                value={form.modeId}
                onChangeText={routing.setField(role, "modeId")}
                placeholder="Mode ID — e.g. bypass"
                disabled={disabled}
              />
            )}
            {featureDefs.loading ? (
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Loading features…</Text>
            ) : null}
            {featureDefs.defs.length > 0 ? (
              featureDefs.defs.map(def => (
                // The mockup's .profile-feature tinted box around each
                // provider feature control.
                <View key={def.id} style={[styles.profileFeature, { backgroundColor: colors.surface2 }]}>
                {def.type === "toggle" ? (
                  <SwitchRow
                    colors={colors}
                    checked={(form.feature[def.id] ?? "") === "" ? def.value : form.feature[def.id] === "true"}
                    onToggle={next => routing.setFeature(role, def.id)(String(next))}
                    title={def.label}
                    hint={def.description}
                    disabled={disabled}
                  />
                ) : (
                  <View style={styles.field}>
                    <Text style={[styles.legend, { color: colors.foregroundMuted }]}>{def.label}</Text>
                    <ChipSelect
                      colors={colors}
                      variant="choice"
                      value={form.feature[def.id] ?? ""}
                      options={[
                        { label: "Provider default", value: "" },
                        ...def.options.map(option => ({ label: option.label, value: option.id })),
                      ]}
                      onChange={routing.setFeature(role, def.id)}
                      disabled={disabled}
                    />
                    {def.description ? (
                      <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{def.description}</Text>
                    ) : null}
                  </View>
                )}
                </View>
              ))
            ) : (
              <>
                <Field
                  colors={colors}
                  label="Feature values (JSON)"
                  hint='Provider feature flags — e.g. {"auto_accept": true}'
                  value={form.features}
                  onChangeText={routing.setField(role, "features")}
                  placeholder="{}"
                  disabled={disabled}
                />
                {featureDefs.error ? (
                  <>
                    <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
                      Feature controls unavailable: {featureDefs.error} — edit JSON or retry.
                    </Text>
                    <Button
                      colors={colors}
                      label="Retry feature controls"
                      onPress={() => {
                        if (featureDefs.key) void retryFeatureSet(featureDefs.key);
                      }}
                      disabled={disabled || featureDefs.loading}
                    />
                  </>
                ) : null}
              </>
            )}
            {thinking === null ? (
              // No catalog / no picked model / model not listed — the
              // established free-text degradation path.
              <Field
                colors={colors}
                label="Thinking option"
                hint="Enter an option ID or leave empty for the provider default"
                value={form.thinkingOptionId}
                onChangeText={routing.setField(role, "thinkingOptionId")}
                placeholder="Thinking option ID"
                disabled={disabled}
              />
            ) : thinking.options.length > 0 ? (
              <View style={styles.field}>
                <Text style={[styles.legend, { color: colors.foregroundMuted }]}>Thinking option</Text>
                <ChipSelect
                  colors={colors}
                  value={form.thinkingOptionId}
                  options={[
                    {
                      label: thinking.defaultId
                        ? `Provider default (${thinking.defaultId})`
                        : "Provider default",
                      value: "",
                    },
                    ...thinking.options.map(option => ({
                      label: option.id === thinking.defaultId || option.isDefault
                        ? `${option.label} (default)`
                        : option.label,
                      value: option.id,
                    })),
                    // Same escape hatch as the mode picker: a stored
                    // option the model doesn't declare stays visible and
                    // clearable, marked "(stored)" so it reads as
                    // leftover rather than a real option. It only exists
                    // inside this declaring-model branch — a model
                    // declaring ZERO options renders no control at all
                    // (host parity: the stored ID is never surfaced).
                    ...(form.thinkingOptionId !== "" &&
                      !thinking.options.some(option => option.id === form.thinkingOptionId)
                      ? [{ label: `${form.thinkingOptionId} (stored)`, value: form.thinkingOptionId }]
                      : []),
                  ]}
                  onChange={routing.setField(role, "thinkingOptionId")}
                  disabled={disabled}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      </View>
      <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
        Peers are pool-driven — each Lead delegation picks a family, so all four managed
        peer providers stay generated; the picks above are the only routed roles.
      </Text>
      {routing.diverged ? (
        <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
          Stored role profiles differ from the live binding — the changes apply at
          the next activation; nothing activates on save. Run
          {` ${activationLabel(statusView)}`} to apply them.
        </Text>
      ) : null}
      {routing.saved && statusView?.binding && !routing.diverged ? (
        <Text style={[styles.mutedSmall, { color: colors.statusSuccess }]}>
          Saved — matches the live binding.
        </Text>
      ) : null}
      {!statusView?.binding ? (
        <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
          Activate first — role profiles are saved against a live binding.
        </Text>
      ) : null}
      <Button
        colors={colors}
        label={routing.busy ? "Saving…" : "Save"}
        disabled={!target || routing.busy || !statusView?.binding || !routing.differs}
        onPress={() => void routing.save()}
      />
    </Card>
  );
}
