// Jev-card ownership (wave 11 S3b/D): the card owns the stored view, every
// draft field and pending flag, the once-per-target load, prefill, the
// target-switch reset and the save/key/test handlers. The shell supplies
// the target, its stale-guard predicate (`sameTarget` wraps the shell-owned
// keyRef/targetKey mechanism), the RPC callers and the lastError plumbing.
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { JevProvider } from "../../shared/contracts.ts";
import type {
  GetJevRequest,
  GetJevResult,
  JevViewValue,
  SetJevKeyRequest,
  SetJevKeyResult,
  SetJevRequest,
  SetJevResult,
  TargetValue,
  TestJevRequest,
  TestJevResult,
} from "../../shared/contracts.ts";
import { errorMessage } from "../manager-state.ts";
import type { Colors } from "../ui-kit.tsx";
import { Badge, Button, Card, ChipSelect, Field, styles, SwitchRow } from "../ui-kit.tsx";

// Jev provider kinds — the same pin/defaults src/jev.mjs enforces
// daemon-side. Changing kind resets model/baseUrl to the kind's defaults.
export const JEV_KIND_DEFAULT = {
  openrouter: { model: "typesafe/jev-1.13", baseUrl: "https://openrouter.ai", keyLabel: "OpenRouter API key", keyFile: "jev-openrouter.key", keyPlaceholder: "sk-or-v1-…" },
  typesafe: { model: "jev-1.13.0", baseUrl: "https://api.typesafe.ai", keyLabel: "TypeSafe API key", keyFile: "jev-typesafe.key", keyPlaceholder: "ts-…" },
} as const;
// Display names for the key/test actions — they name the SAVED provider the
// daemon will actually call, never the dirty draft pick.
export const JEV_KIND_LABEL = { openrouter: "OpenRouter", typesafe: "TypeSafe" } as const;

type JevKind = keyof typeof JEV_KIND_DEFAULT;

export function useJevCard({ target, targetKey, sameTarget, callGetJev, callSetJev, callSetJevKey, callTestJev, update }: {
  target: TargetValue | null;
  targetKey: string | null;
  sameTarget: (forTarget: TargetValue) => boolean;
  callGetJev: (input: GetJevRequest) => Promise<GetJevResult>;
  callSetJev: (input: SetJevRequest) => Promise<SetJevResult>;
  callSetJevKey: (input: SetJevKeyRequest) => Promise<SetJevKeyResult>;
  callTestJev: (input: TestJevRequest) => Promise<TestJevResult>;
  update: (patch: { lastError: string | null }, target: TargetValue) => void;
}) {
  // Per-daemon config + key — the key value lives only in keyInput until
  // Save, is cleared right after, and status reports hasKey only. Provider
  // kind is selectable (OpenRouter relay vs TypeSafe first-party);
  // model/baseUrl default per kind, baseUrl editable for custom endpoints.
  const [jevView, setJevView] = useState<JevViewValue | null>(null);
  const [jevKind, setJevKind] = useState<JevKind>("openrouter");
  const [jevModel, setJevModel] = useState("");
  const [jevBaseUrl, setJevBaseUrl] = useState("");
  const [jevEnabledOn, setJevEnabledOn] = useState(false);
  const [jevRoutingOn, setJevRoutingOn] = useState(false);
  const [capabilityBusy, setCapabilityBusy] = useState(false);
  const [jevDirty, setJevDirty] = useState(false);
  const [jevBusy, setJevBusy] = useState(false);
  const [jevSaved, setJevSaved] = useState(false);
  const [jevKeyInput, setJevKeyInput] = useState("");
  const [jevKeyBusy, setJevKeyBusy] = useState(false);
  const [jevTest, setJevTest] = useState<{ ok: boolean; detail: string | null } | null>(null);
  const [jevTestBusy, setJevTestBusy] = useState(false);
  // Jev load state split (mockup recovery finding): a get-jev failure is a
  // distinct error branch with Retry, not an eternal "loading…".
  const [jevLoadError, setJevLoadError] = useState<string | null>(null);
  // Per-field validation errors — the model rule sits at the Model field and
  // the URL rule at Base URL, never pooled into one message (mockup Jev
  // field-error finding). Sourced from the shared JevProvider schema so the
  // client and daemon reject the same shapes.
  const [jevModelError, setJevModelError] = useState<string | null>(null);
  const [jevUrlError, setJevUrlError] = useState<string | null>(null);
  // Any settings edit (provider/model/baseUrl/toggles) invalidates the prior
  // test result AND the key actions — they run against the SAVED provider,
  // not the draft. A pending key input likewise voids the last test.
  const markEdited = () => {
    setJevDirty(true);
    setJevSaved(false);
    setJevTest(null);
    setJevModelError(null);
    setJevUrlError(null);
  };

  // Fetch the Jev view once per target — the config is plugin-owned and
  // independent of any binding, so it loads with the first status. loadJev
  // is also the Retry path after a failed load (the loadError branch in
  // the card JSX).
  const jevLoadedFor = useRef<string | null>(null);
  const loadJev = useCallback(async (forTarget: TargetValue) => {
    setJevLoadError(null);
    // Stale-write guard (the same issueKey discipline the pool ops use): a
    // response issued for the previous target must never paint its config
    // over the displayed target's view — an unguarded write would let a
    // late A-config seed B's fields, and saveJev would then write A's
    // provider settings to B.
    try {
      const result = await callGetJev({ schemaVersion: 1, target: forTarget });
      if (!sameTarget(forTarget)) return;
      setJevView(result.jev);
    } catch (error) {
      if (!sameTarget(forTarget)) return;
      setJevView(null);
      setJevLoadError(errorMessage(error));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sameTarget wraps the shell's key guard
  }, [callGetJev]);
  useEffect(() => {
    if (!target || !targetKey || jevLoadedFor.current === targetKey) return;
    jevLoadedFor.current = targetKey;
    setJevView(null);
    setJevModelError(null);
    setJevUrlError(null);
    void loadJev(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey captures target
  }, [targetKey]);

  // Target switch drops the draft and every pending flag — a draft authored
  // against home A must not Apply into home B, and a stale op's guarded
  // finally skips its busy clear, so the switch itself is what releases the
  // abandoned view's pending flags.
  useEffect(() => {
    setJevView(null);
    setJevDirty(false);
    setJevSaved(false);
    setJevKeyInput("");
    setJevTest(null);
    setJevLoadError(null);
    setJevModelError(null);
    setJevUrlError(null);
    setJevBusy(false);
    setJevKeyBusy(false);
    setJevTestBusy(false);
    setCapabilityBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey captures target
  }, [targetKey]);

  // Prefill the toggles and provider fields from the stored config until the
  // Human edits — same tracking discipline as the language form.
  useEffect(() => {
    if (jevDirty) return;
    setJevEnabledOn(jevView?.enabled === true);
    setJevRoutingOn(jevView?.capabilities?.routing === true);
    const kind = jevView?.provider?.kind === "typesafe" ? "typesafe" : "openrouter";
    setJevKind(kind);
    setJevModel(jevView?.provider?.model ?? JEV_KIND_DEFAULT[kind].model);
    setJevBaseUrl(jevView?.provider?.baseUrl ?? JEV_KIND_DEFAULT[kind].baseUrl);
  }, [jevView, jevDirty]);

  // Provider kind drives the model pin and the baseUrl default/rule — the
  // same contract src/jev.mjs readJevConfig enforces daemon-side. The shared
  // JevProvider schema validates client-side first so a rejected field lands
  // its error AT that field instead of one pooled message.
  const save = async () => {
    if (!target) return;
    const provider = {
      kind: jevKind,
      baseUrl: jevBaseUrl.trim() === "" ? JEV_KIND_DEFAULT[jevKind].baseUrl : jevBaseUrl.trim(),
      model: jevModel.trim() === "" ? JEV_KIND_DEFAULT[jevKind].model : jevModel.trim(),
    };
    const parsed = JevProvider.safeParse(provider);
    if (!parsed.success) {
      const fieldError = (field: string) =>
        parsed.error.issues.find(issue => issue.path[0] === field)?.message ?? null;
      setJevModelError(fieldError("model"));
      setJevUrlError(fieldError("baseUrl"));
      update({ lastError: parsed.error.issues[0]?.message ?? "Invalid Jev provider settings" }, target);
      return;
    }
    setJevModelError(null);
    setJevUrlError(null);
    setJevBusy(true);
    try {
      const result = await callSetJev({
        schemaVersion: 1,
        target,
        // Preserve every capability key the daemon already stores — a
        // reconstructed {routing} object would silently flip a capability
        // this card does not own (spec: set-jev must preserve saved keys and
        // reject a stale save via the raw-file CAS token). The supervision
        // capability is owned by the Supervision card's switch, so it always
        // comes from the saved view here.
        expectedSha256: jevView?.sha256 ?? null,
        jev: {
          schemaVersion: 1,
          enabled: jevEnabledOn,
          capabilities: {
            ...(jevView?.capabilities ?? {}),
            routing: jevRoutingOn,
          },
          provider: {
            kind: jevKind,
            baseUrl: jevBaseUrl.trim() === "" ? JEV_KIND_DEFAULT[jevKind].baseUrl : jevBaseUrl.trim(),
            model: jevModel.trim() === "" ? JEV_KIND_DEFAULT[jevKind].model : jevModel.trim(),
          },
        },
      });
      // Same stale-write guard as loadJev — a set-jev response issued on the
      // previous target must not paint its config over the displayed view,
      // clear the dirty gate (which would let the prefill seed A's fields
      // into B's draft), or flash "Saved." for a write B never saw.
      if (!sameTarget(target)) return;
      setJevView(result.jev);
      setJevDirty(false);
      setJevSaved(true);
    } catch (error) {
      update({ lastError: errorMessage(error) }, target);
    } finally {
      // A stale op must not clear the busy flag of a NEWER op already
      // in-flight on the displayed target — the key-change reset releases
      // the flag for the abandoned view instead.
      if (sameTarget(target)) setJevBusy(false);
    }
  };

  const saveKey = async (key: string | null) => {
    if (!target) return;
    setJevKeyBusy(true);
    try {
      await callSetJevKey({ schemaVersion: 1, target, key });
      const result = await callGetJev({ schemaVersion: 1, target });
      // Same stale-write guard as loadJev — the clears stay AFTER it so a
      // stale resolution never touches the new target's pending key input
      // or test result (the mutation already landed server-side; the guard
      // only blocks the view/state paint).
      if (!sameTarget(target)) return;
      setJevKeyInput("");
      setJevTest(null);
      setJevView(result.jev);
    } catch (error) {
      update({ lastError: errorMessage(error) }, target);
    } finally {
      if (sameTarget(target)) setJevKeyBusy(false);
    }
  };

  const runTest = async () => {
    if (!target) return;
    setJevTestBusy(true);
    setJevTest(null);
    try {
      const result = await callTestJev({ schemaVersion: 1, target });
      if (!sameTarget(target)) return;
      setJevTest({ ok: result.ok, detail: result.detail });
    } catch (error) {
      if (!sameTarget(target)) return;
      setJevTest({ ok: false, detail: errorMessage(error) });
    } finally {
      if (sameTarget(target)) setJevTestBusy(false);
    }
  };

  const setKind = (next: JevKind) => {
    markEdited();
    setJevKind(next);
    setJevModel(JEV_KIND_DEFAULT[next].model);
    setJevBaseUrl(JEV_KIND_DEFAULT[next].baseUrl);
  };
  const setModel = (text: string) => { markEdited(); setJevModel(text); };
  const setBaseUrl = (text: string) => { markEdited(); setJevBaseUrl(text); };
  const setEnabledOn = (next: boolean) => { markEdited(); setJevEnabledOn(next); };
  const setRoutingOn = (next: boolean) => { markEdited(); setJevRoutingOn(next); };
  // The Supervision card's on/off switch: one immediate set-jev built from
  // the SAVED view (never this card's draft), flipping only the supervision
  // capability under the view's CAS token. A dirty Jev draft stays a draft —
  // the prefill effect is gated on jevDirty, and saveJev takes supervision
  // from the refreshed view.
  const setSupervisionCapability = async (next: boolean): Promise<string | null> => {
    if (!target || jevView === null || jevView.provider === null) return "Jev settings are not loaded";
    setCapabilityBusy(true);
    try {
      const result = await callSetJev({
        schemaVersion: 1,
        target,
        expectedSha256: jevView.sha256,
        jev: {
          schemaVersion: 1,
          enabled: jevView.enabled === true,
          capabilities: { routing: false, ...(jevView.capabilities ?? {}), supervision: next },
          provider: jevView.provider,
        },
      });
      if (!sameTarget(target)) return null;
      setJevView(result.jev);
      return null;
    } catch (error) {
      const message = errorMessage(error);
      update({ lastError: message }, target);
      return message;
    } finally {
      if (sameTarget(target)) setCapabilityBusy(false);
    }
  };
  const setKeyInput = (text: string) => { setJevKeyInput(text); setJevTest(null); };

  return {
    view: jevView,
    kind: jevKind,
    model: jevModel,
    baseUrl: jevBaseUrl,
    enabledOn: jevEnabledOn,
    routingOn: jevRoutingOn,
    capabilityBusy,
    dirty: jevDirty,
    busy: jevBusy,
    saved: jevSaved,
    keyInput: jevKeyInput,
    keyBusy: jevKeyBusy,
    test: jevTest,
    testBusy: jevTestBusy,
    loadError: jevLoadError,
    modelError: jevModelError,
    urlError: jevUrlError,
    setKind,
    setModel,
    setBaseUrl,
    setEnabledOn,
    setRoutingOn,
    setSupervisionCapability,
    setKeyInput,
    save,
    saveKey,
    runTest,
    retryLoad: () => { if (target) void loadJev(target); },
  };
}

// ---------------------------------------------------------------------------
// View — render-only (wave 11 S3c). The hook above owns all state and
// handlers; this component paints them.
// ---------------------------------------------------------------------------

export type JevCardState = ReturnType<typeof useJevCard>;

export function JevCard({ colors, target, jev }: {
  colors: Colors;
  target: TargetValue | null;
  jev: JevCardState;
}) {
  return (
    <Card
      colors={colors}
      title="Jev"
      subtitle="Bounded routing decisions — a Lead runs `slp route-decide` so Jev picks the pool seat from the eligible set, and prepare verifies the receipt offline. All toggles default off; an outage fails closed and disabling restores Lead-judgment routing."
    >
      {// Mockup recovery finding — the three load states are distinct:
       // loading notice, an error branch with Retry, and the loaded
       // settings. A failed load never paints as eternal "loading…".
      jev.loadError !== null ? (
        <View style={[styles.noticeBox, { borderColor: colors.statusDanger, backgroundColor: colors.surface2 }]} accessibilityLiveRegion="polite">
          <Text style={[styles.checkTitle, { color: colors.statusDanger }]}>Could not load Jev settings</Text>
          <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>{jev.loadError}</Text>
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
            Settings and key status are unavailable.
          </Text>
          <View>
            <Button colors={colors} kind="primary" label="Retry" onPress={() => jev.retryLoad()} />
          </View>
        </View>
      ) : jev.view === null ? (
        <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]} accessibilityLiveRegion="polite">
          Loading Jev settings…
        </Text>
      ) : (
        <>
          {// Saved provider strip — the SAVED provider/model/baseUrl
           // stays visible above the unsaved settings so a dirty draft
           // never looks like the live config (mockup finding 1).
          }
          <View style={[styles.savedProvider, { borderLeftColor: colors.accent, backgroundColor: colors.surface2 }]}>
            <Text style={[styles.eyebrow, { color: colors.foregroundMuted }]}>Saved provider</Text>
            <View style={[styles.cardHeadRow, { justifyContent: "space-between" }]}>
              <Text style={[styles.checkTitle, { color: colors.foreground }]}>
                {jev.view.provider ? JEV_KIND_LABEL[jev.view.provider.kind] : "Not configured"}
              </Text>
              {jev.view.configured ? (
                <Badge
                  colors={colors}
                  label={jev.view.enabled === true ? "Configured · enabled" : "Configured · disabled"}
                  tone="good"
                />
              ) : null}
            </View>
            <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
              {jev.view.provider
                ? `${jev.view.provider.model} · ${jev.view.provider.baseUrl} · ${jev.view.hasKey
                    ? jev.view.keyPermissionsOk === false
                      ? "Key stored — file permissions too open (chmod 600)"
                      : "Key stored"
                    : "No key stored"}`
                : "No saved settings — Apply writes the first configuration."}
            </Text>
            {jev.view.error ? (
              <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>config error: {jev.view.error}</Text>
            ) : null}
          </View>
          <View style={[styles.cardHeadRow, { justifyContent: "space-between" }]}>
            <Text style={[styles.fieldLabel, { color: colors.foreground }]}>
              {jev.dirty ? "Unsaved settings" : "Settings"}
            </Text>
            {jev.dirty ? <Badge colors={colors} label="Apply before key actions" tone="draft" /> : null}
          </View>
          <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Provider</Text>
          <ChipSelect<"openrouter" | "typesafe">
            colors={colors}
            value={jev.kind}
            options={[
              { label: "OpenRouter", value: "openrouter" },
              { label: "TypeSafe (first-party)", value: "typesafe" },
            ]}
            disabled={!target || jev.busy}
            onChange={next => {
              jev.setKind(next);
            }}
          />
          <View style={styles.field}>
            <Field
              colors={colors}
              label="Model"
              hint={jev.kind === "typesafe"
                ? "Pinned versioned id (jev-<semver>) — aliases like jev-latest are rejected"
                : "Pinned <owner>/jev-<version> id — aliases like jev-latest are rejected"}
              value={jev.model}
              onChangeText={text => { jev.setModel(text); }}
              placeholder={JEV_KIND_DEFAULT[jev.kind].model}
              disabled={!target || jev.busy}
            />
            {jev.modelError ? (
              <Text style={[styles.mutedSmall, { color: colors.statusDanger }]} accessibilityLiveRegion="polite">
                {jev.modelError}
              </Text>
            ) : null}
          </View>
          <View style={styles.field}>
            <Field
              colors={colors}
              label={jev.baseUrl.trim() !== "" && jev.baseUrl.trim() !== JEV_KIND_DEFAULT[jev.kind].baseUrl
                ? "Base URL (custom)"
                : "Base URL"}
              hint={`POST ${(jev.baseUrl.trim() === "" ? JEV_KIND_DEFAULT[jev.kind].baseUrl : jev.baseUrl.trim()).replace(/\/+$/, "")}${jev.kind === "typesafe" ? "/v1/systemone" : "/api/alpha/decisions"}${jev.kind === "typesafe" ? " — an origin+path prefix mounts a custom endpoint/proxy" : " — bare origin or the documented …/api/v1 prefixed form"}`}
              value={jev.baseUrl}
              onChangeText={text => { jev.setBaseUrl(text); }}
              placeholder={JEV_KIND_DEFAULT[jev.kind].baseUrl}
              disabled={!target || jev.busy}
            />
            {jev.urlError ? (
              <Text style={[styles.mutedSmall, { color: colors.statusDanger }]} accessibilityLiveRegion="polite">
                {jev.urlError}
              </Text>
            ) : null}
          </View>
          <SwitchRow
            colors={colors}
            checked={jev.enabledOn}
            disabled={!target || jev.busy}
            onToggle={next => { jev.setEnabledOn(next); }}
            title="Enable Jev"
            hint="Master toggle — off keeps every capability inert without deleting the stored key."
          />
          <SwitchRow
            colors={colors}
            checked={jev.routingOn}
            disabled={!target || jev.busy || !jev.enabledOn}
            onToggle={next => { jev.setRoutingOn(next); }}
            title="Routing decisions"
            hint="When armed, prepare requires a Jev decision receipt for catalog routing (run `slp route-decide`); Lead judgment alone no longer suffices."
          />
          {/* The supervision capability is switched in the Supervision card
              below (one switch, with its disclosure); this line only points
              there so the Jev card does not carry a second control. */}
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
            Supervision: {jev.view.capabilities?.supervision === true ? "on" : "off"} — turn it on or off in the
            Supervision card below.
          </Text>
          {jev.saved && !jev.dirty ? (
            <Text style={[styles.mutedSmall, { color: colors.statusSuccess }]} accessibilityLiveRegion="polite">Saved.</Text>
          ) : null}
          <Button
            colors={colors}
            kind="primary"
            label={jev.busy ? "Saving…" : "Apply Jev settings"}
            disabled={!target || jev.busy || !jev.dirty}
            onPress={() => void jev.save()}
          />
          <View style={[styles.divider, { borderTopColor: colors.border }]} />
          {// Key & connection actions name the SAVED provider — they
           // operate on the stored config, so a dirty draft locks them
           // until Apply (mockup finding 1).
          }
          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>
            Key & connection · {JEV_KIND_LABEL[jev.view.provider?.kind ?? jev.kind]}
          </Text>
          {jev.dirty ? (
            <View style={[styles.noticeBox, { borderColor: colors.statusWarning, backgroundColor: colors.surface2 }]}>
              <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
                Apply settings before managing a key or testing — these actions use the saved
                provider: {JEV_KIND_LABEL[jev.view.provider?.kind ?? jev.kind]}. Any previous test
                result is no longer current.
              </Text>
            </View>
          ) : null}
          <Field
            colors={colors}
            label={`${JEV_KIND_LABEL[jev.view.provider?.kind ?? jev.kind]} API key`}
            hint={`Stored at slp-runtime/state/${JEV_KIND_DEFAULT[jev.view.provider?.kind ?? jev.kind].keyFile} (0600) — never shown back; enter a new key to replace it`}
            value={jev.keyInput}
            onChangeText={text => { jev.setKeyInput(text); }}
            placeholder={JEV_KIND_DEFAULT[jev.view.provider?.kind ?? jev.kind].keyPlaceholder}
            disabled={!target || jev.keyBusy || jev.dirty}
            secure
          />
          {jev.keyInput.trim() !== "" ? (
            <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
              Unsaved key — save it before testing.
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button
              colors={colors}
              label={jev.keyBusy ? "Working…" : `Save ${JEV_KIND_LABEL[jev.view.provider?.kind ?? jev.kind]} key`}
              disabled={!target || jev.keyBusy || jev.dirty || jev.keyInput.trim() === ""}
              onPress={() => void jev.saveKey(jev.keyInput.trim())}
            />
            <Button
              colors={colors}
              label={`Remove ${JEV_KIND_LABEL[jev.view.provider?.kind ?? jev.kind]} key`}
              disabled={!target || jev.keyBusy || jev.dirty || jev.view?.hasKey !== true}
              onPress={() => void jev.saveKey(null)}
            />
            <Button
              colors={colors}
              label={jev.testBusy ? "Testing…" : `Test ${JEV_KIND_LABEL[jev.view.provider?.kind ?? jev.kind]} connection`}
              disabled={!target || jev.testBusy || jev.dirty || jev.view?.hasKey !== true || jev.keyInput.trim() !== ""}
              onPress={() => void jev.runTest()}
            />
          </View>
          {jev.test ? (
            <Text style={[styles.mutedSmall, { color: jev.test.ok ? colors.statusSuccess : colors.statusDanger }]} accessibilityLiveRegion="polite">
              {jev.test.ok ? "Connection OK" : "Connection failed"}{jev.test.detail ? ` — ${jev.test.detail}` : ""}
            </Text>
          ) : null}
        </>
      )}
    </Card>
  );
}
