// Peer pool owns its draft, seat editors and CAS save/reload/import/copy.
// Target async owns snapshot reads and session tickets. Target changes reset
// this card's draft and transient state. The shell supplies RPC adapters,
// shared catalog read views, scroll/focus and target-bound lastError plumbing.
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTargetSnapshot } from "../target-async.ts";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { PEER_SEAT_ARCHETYPES } from "../../shared/archetypes.ts";
import { FAMILY_LABEL, FAMILY_PICKER_ORDER } from "../../shared/runtime/families.ts";
import type { RoleName } from "../../shared/runtime/families.ts";
import {
  HOW_TO_READ,
  STANDARD_SEAT_TOKENS,
  SUITABILITY_AXES,
  SUITABILITY_TOKENS,
  tokenDefinition,
} from "../../shared/runtime/routing-vocabulary.ts";
import type {
  CatalogResult,
  FamilyName,
  GetPeerPoolRequest,
  GetPeerPoolResult,
  SetPeerPoolRequest,
  SetPeerPoolResult,
  StatusResult,
  TargetValue,
} from "../../shared/contracts.ts";
import {
  applyFamilyChange,
  applySettingChange,
  buildPeerPool,
  catalogScope,
  featureKey,
  convertSeatToCustom,
  customSeatCopy,
  customSeatFromArchetype,
  emptyPeerPoolForm,
  errorMessage,
  formSeatConflict,
  legacyImportAllowed,
  peerPoolDiffers,
  peerPoolForm,
  peerSeatFromArchetype,
  samePeerPoolForm,
  suggestCustomSeatId,
} from "../manager-state.ts";
import {
  customSeatIdError,
  lineList,
  seatManagement,
  thinkingOptionsFor,
} from "../manager-state.ts";
import type { PeerPoolForm, PeerSeatForm } from "../manager-state.ts";
import type { Colors, ControlState } from "../ui-kit.tsx";
import {
  Badge,
  Button,
  Card,
  CheckRow,
  ChipSelect,
  Collapse,
  Field,
  focusRing,
  KV,
  OptionPicker,
  SeatTemplateRow,
  StatePill,
  styles,
  SwitchRow,
} from "../ui-kit.tsx";
import type { JevCardState } from "./jev.tsx";

export function usePeerPoolCard({ target, targetKey, isCurrentKey, callGetPeerPool, callSetPeerPool, catalogs, featureSets, featuresLoadingFor, scrollFocusNode, update }: {
  target: TargetValue | null;
  targetKey: string | null;
  isCurrentKey: (key: string) => boolean;
  callGetPeerPool: (input: GetPeerPoolRequest) => Promise<GetPeerPoolResult>;
  callSetPeerPool: (input: SetPeerPoolRequest) => Promise<SetPeerPoolResult>;
  catalogs: Partial<Record<string, CatalogResult>>;
  featureSets: Record<string, { defs: CatalogResult["features"]; error: string | null }>;
  featuresLoadingFor: string | null;
  scrollFocusNode: (node: unknown, focus?: boolean) => void;
  update: (patch: { lastError: string | null }, target: TargetValue) => void;
}) {
  // `poolData` is the last get-peer-pool response (pool + sha256 for the
  // CAS save + the legacy import view); `poolForm` is the editable copy.
  // Saves are whole-file with optimistic concurrency — a sha mismatch
  // refuses the write and the operator reloads.
  const snapshot = useTargetSnapshot(target, targetKey, target => callGetPeerPool({ schemaVersion: 1, target }));
  const { data: poolData, replace: setPoolData, error: poolReadError, capture } = snapshot;
  const [poolForm, setPoolForm] = useState<PeerPoolForm>(emptyPeerPoolForm);
  const [poolDirty, setPoolDirty] = useState(false);
  // Saving and Reloading are separate pending states (mockup busy-state
  // finding): each control labels its own in-flight work, while both lock
  // pool mutations through the derived poolBusy below.
  const [poolSaving, setPoolSaving] = useState(false);
  const [poolReloading, setPoolReloading] = useState(false);
  const [poolSaved, setPoolSaved] = useState(false);
  const [poolCopied, setPoolCopied] = useState(false);
  // poolData === null is ambiguous between "still reading" and "the read RPC
  // failed" — poolReadError separates the two (§7.4.E) so an unreadable pool
  // is never painted as an empty list, and so Save can require a successful
  // snapshot rather than silently sending expectedSha256:null.
  // Pool-specific errors (CAS conflict, save/reload failure) land in the
  // card's notice area, not only the shared lastError line (§7.4.D).
  const [poolError, setPoolError] = useState<{ message: string; cas: boolean } | null>(null);
  // Dirty-draft reload confirmation (§7.4.C): Reload on an edited draft shows
  // "Keep current edits" / "Discard changes and Reload" before the RPC runs.
  // The confirmation renders AT the control that invoked it (CAS locality):
  // "notice" beside the conflict notice's Reload, "footer" beside the card's.
  const [poolReloadConfirm, setPoolReloadConfirm] = useState<"notice" | "footer" | null>(null);
  // §7.4.D convert-to-custom editor state, and the "Standard set selected —
  // not yet saved" marker after a conflict is resolved toward the standard set.
  const [convertSeatIndex, setConvertSeatIndex] = useState<number | null>(null);
  const [convertId, setConvertId] = useState("");
  const [standardAppliedId, setStandardAppliedId] = useState<string | null>(null);
  // §7.4.F token lookup: which seat's editor hosts the open section and which
  // token is selected (null = the four-axis picker view).
  const [tokenLookupSeat, setTokenLookupSeat] = useState<number | null>(null);
  const [tokenLookupToken, setTokenLookupToken] = useState<string | null>(null);
  // The expanded seat editor and the archetype picker, tracked by seat index
  // (a renamed seat keeps its editor open); removing any seat closes both.
  // pickerQuery filters the picker rows by template id/notes.
  const [openSeat, setOpenSeat] = useState<number | null>(null);
  const [addSeatOpen, setAddSeatOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  // Best-effort scroll/focus targets (CAS locality + token lookup): on
  // react-native-web a host ref resolves to the DOM node, so a guarded
  // scrollIntoView/focus call works there and is a no-op elsewhere — the
  // host gives RN primitives no focus contract beyond this.
  const seatRowRefs = useRef(new Map<number, View | null>());
  const lookupRefs = useRef(new Map<number, View | null>());
  const definitionRefs = useRef(new Map<number, View | null>());
  const keepEditsRef = useRef<View | null>(null);

  // Pool state is keyed to the displayed target: switching daemon homes
  // drops the previous pool, its draft and every transient flag. Without
  // this a draft authored against home A could save into home B — B's
  // fresh sha256 would satisfy the CAS token and hide the swap.
  useEffect(() => {
    setPoolData(null);
    setPoolForm(emptyPeerPoolForm());
    setPoolDirty(false);
    setPoolSaving(false);
    setPoolReloading(false);
    setPoolSaved(false);
    setPoolCopied(false);
    setPoolError(null);
    setPoolReloadConfirm(null);
    setPickerQuery("");
    seatRowRefs.current.clear();
    lookupRefs.current.clear();
    definitionRefs.current.clear();
    setConvertSeatIndex(null);
    setConvertId("");
    setStandardAppliedId(null);
    setTokenLookupSeat(null);
    setTokenLookupToken(null);
    setOpenSeat(null);
    setAddSeatOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey captures target
  }, [targetKey]);

  // Prefill the pool form from the stored pool until the Human edits — same
  // tracking discipline as the routing form. An absent pool starts from the
  // template-policy empty form; a malformed one prefills empty as well (the
  // error line names what the file held).
  useEffect(() => {
    if (poolDirty) return;
    const next = poolData?.pool ? peerPoolForm(poolData.pool) : emptyPeerPoolForm();
    setPoolForm(current => (samePeerPoolForm(current, next) ? current : next));
  }, [poolData, poolDirty]);

  // The pool's diff-gate mirrors the routing card's: ONE build path produces
  // the document the gate compares and savePeerPool dispatches. The stored
  // options map lets buildPeerSeat preserve passthrough fields the form does
  // not model (and deliberately drop the retired `priority`).
  const storedSeatOptions = new Map(
    (poolData?.pool?.options ?? []).map(option => [option.id, option]),
  );
  // Seat feature defs read the same per-key cache as the role pickers —
  // hoisted above poolBuild because buildPeerPool invokes the lambda eagerly
  // during render (a const declared later would be a TDZ crash on any
  // non-empty seat list).
  const featureDefsForSeat = (seat: PeerSeatForm) => {
    const key = seat.family !== "" && seat.model.trim() !== ""
      ? featureKey(seat.family, "peer", seat.model.trim(), seat.modeId.trim())
      : null;
    const set = key ? featureSets[key] : undefined;
    return {
      key,
      defs: set?.defs ?? [],
      error: set?.error ?? null,
      loading: key !== null && featuresLoadingFor === key,
    };
  };
  const poolBuild = buildPeerPool(
    poolForm,
    seat => featureDefsForSeat(seat).defs,
    storedSeatOptions,
  );
  const poolDiffers = peerPoolDiffers(poolBuild, poolData?.pool ?? null);
  // §7.4.E — the editor stays locked until the first successful snapshot:
  // with no read there is no CAS token and no shared baseline to diff.
  // Either pending pool op locks mutations; the labels stay per-operation.
  const poolBusy = poolSaving || poolReloading;
  const poolLocked = poolBusy || poolData === null;
  // §7.4.D — reserved ids whose draft tokens diverge from the package set.
  // The card notice presses open the seat; the seat row carries the same
  // marker, and buildPeerPool refuses to Save/Copy while any remain.
  const conflictedSeats = poolForm.seats
    .map((seat, index) => ({ index, conflict: formSeatConflict(seat) }))
    .filter((entry): entry is { index: number; conflict: NonNullable<typeof entry.conflict> } => entry.conflict !== null);

  // Every pool edit goes through updatePool — it marks the form dirty and
  // clears the one-shot save/copy confirmations.
  const updatePool = (mutate: (form: PeerPoolForm) => PeerPoolForm) => {
    setPoolDirty(true);
    setPoolSaved(false);
    setPoolCopied(false);
    setPoolForm(current => mutate(current));
  };

  const setSeatField = (
    index: number,
    field: "model" | "modeId" | "thinkingOptionId" | "features" | "suitableFor" | "avoidFor" | "notes",
  ) => (value: string) =>
    updatePool(form => ({
      ...form,
      seats: form.seats.map((seat, i) =>
        i === index
          ? (field === "model" || field === "modeId"
            ? applySettingChange(seat, field, value, seat.family !== "" ? catalogs[catalogScope(seat.family, "peer")] : undefined)
            : { ...seat, [field]: value })
          : seat,
      ),
    }));

  // Renaming a seat also retargets the quota-fallback designation — a dangling
  // id would only surface as a build error later.
  const setSeatId = (index: number) => (value: string) =>
    updatePool(form => {
      const oldId = form.seats[index]?.id;
      const seats = form.seats.map((seat, i) => (i === index ? { ...seat, id: value } : seat));
      const quotaFallbackId = form.quotaFallbackId === oldId ? value.trim() : form.quotaFallbackId;
      return { ...form, seats, quotaFallbackId };
    });

  // Family switch on a seat re-validates dependents against the NEW family's
  // catalog — the same applyFamilyChange rule the role pickers use. "" parks
  // the seat (clears dependents); a stored family missing from the available
  // set stays as an escape-hatch chip.
  const setSeatFamily = (index: number) => (family: FamilyName | "") =>
    updatePool(form => ({
      ...form,
      seats: form.seats.map((seat, i) =>
        i !== index
          ? seat
          : {
              ...seat,
              ...(family === ""
                ? { family: "" as const, model: "", modeId: "", thinkingOptionId: "", features: "", feature: {} }
                : applyFamilyChange(seat, family, catalogs[catalogScope(family, "peer")])),
            },
      ),
    }));

  const setSeatEnabled = (index: number) => (next: boolean) =>
    updatePool(form => ({
      ...form,
      seats: form.seats.map((seat, i) => (i === index ? { ...seat, enabled: next } : seat)),
    }));

  const setSeatFeature = (index: number, featureId: string) => (value: string) =>
    updatePool(form => ({
      ...form,
      seats: form.seats.map((seat, i) =>
        i === index ? { ...seat, feature: { ...seat.feature, [featureId]: value } } : seat,
      ),
    }));

  // §7.4.C picker actions. A standard add always lands on the exact
  // canonical id — when the seat already exists (Token conflict included)
  // the entry just opens it ("Already present — open seat"); it never produces a suffix.
  const addStandardSeat = (archetype: (typeof PEER_SEAT_ARCHETYPES)[number]) => () => {
    const existingIndex = poolForm.seats.findIndex(seat => seat.id.trim() === archetype.id);
    if (existingIndex >= 0) {
      setOpenSeat(existingIndex);
      return;
    }
    updatePool(form => ({
      ...form,
      seats: [...form.seats, peerSeatFromArchetype(archetype)],
    }));
    setOpenSeat(poolForm.seats.length);
  };

  // "Create a custom seat from template": the archetype's tokens/notes copied into an
  // editable Custom seat — parked (blank binding, disabled) on a suggested
  // non-reserved id.
  const addCustomFromTemplate = (archetype: (typeof PEER_SEAT_ARCHETYPES)[number]) => () => {
    updatePool(form => ({
      ...form,
      seats: [...form.seats, customSeatFromArchetype(archetype, form.seats.map(seat => seat.id))],
    }));
    setOpenSeat(poolForm.seats.length);
  };

  // "Create a custom copy" (§7.4.C): copies the viewed row — binding and
  // contents — onto a suggested custom id, disabled. The original seat and
  // its quotaFallback references stay; the copy is not added to fallback.
  const copySeatAsCustom = (index: number) => () => {
    updatePool(form => ({
      ...form,
      seats: [...form.seats, customSeatCopy(form.seats[index], form.seats.map(seat => seat.id))],
    }));
    setOpenSeat(poolForm.seats.length);
  };

  // §7.4.D "Convert this seat to a custom seat": one draft edit renames the seat
  // and retargets the in-pool quotaFallback designation; the Save that lands
  // it keeps the two sides atomic.
  const openConvertToCustom = (index: number) => () => {
    setConvertSeatIndex(index);
    setConvertId(suggestCustomSeatId(poolForm.seats[index]?.id.trim() || "seat", poolForm.seats.map(seat => seat.id)));
  };
  const applyConvertToCustom = () => {
    if (convertSeatIndex === null) return;
    const index = convertSeatIndex;
    updatePool(form => convertSeatToCustom(form, index, convertId));
    setConvertSeatIndex(null);
    setConvertId("");
    setStandardAppliedId(null);
  };

  // "Apply the standard set" (§7.4.D): adopt the package token set into the draft —
  // not yet saved; the seat keeps its binding and notes.
  const applyStandardTokens = (index: number) => () => {
    const seatId = poolForm.seats[index]?.id.trim() ?? "";
    const standard = STANDARD_SEAT_TOKENS[seatId];
    if (!standard) return;
    updatePool(form => ({
      ...form,
      seats: form.seats.map((seat, i) =>
        i === index
          ? { ...seat, suitableFor: standard.suitableFor.join("\n"), avoidFor: standard.avoidFor.join("\n") }
          : seat,
      ),
    }));
    setStandardAppliedId(seatId);
  };

  // Removing a seat drops its fallback designation too — a stale id would
  // fail the build. Every index-keyed piece of editor state is cleared
  // because removal shifts the seats after it — a stale index would bind the
  // convert dialog, the token lookup or the standard-applied marker onto the
  // WRONG seat.
  const removeSeat = (index: number) => () => {
    const removedId = poolForm.seats[index]?.id;
    updatePool(form => ({
      ...form,
      seats: form.seats.filter((_, i) => i !== index),
      quotaFallbackId: form.quotaFallbackId === removedId ? "" : form.quotaFallbackId,
    }));
    setOpenSeat(null);
    setConvertSeatIndex(null);
    setConvertId("");
    setTokenLookupSeat(null);
    setTokenLookupToken(null);
    setStandardAppliedId(current => (current === removedId ? null : current));
    // Indexes shift on removal — ref targets keyed by index are stale.
    seatRowRefs.current.clear();
    lookupRefs.current.clear();
    definitionRefs.current.clear();
  };

  const setFallbackId = (seatId: string) =>
    updatePool(form => ({ ...form, quotaFallbackId: seatId }));

  // Save dispatches the same poolBuild the gate compared — whole-file write
  // guarded by the sha256 get-peer-pool returned. A build error is surfaced
  // AND opens the offending seat's editor; a CAS refusal lands in the card's
  // notice area (§7.4.D) with a Reload affordance instead of only lastError.
  const savePeerPool = async () => {
    if (!target || !targetKey) return;
    if ("error" in poolBuild) {
      update({ lastError: poolBuild.error }, target);
      if (poolBuild.seatIndex != null) setOpenSeat(poolBuild.seatIndex);
      return;
    }
    const ticket = capture();
    setPoolSaving(true);
    try {
      const result = await callSetPeerPool({
        schemaVersion: 1,
        target,
        pool: poolBuild.pool,
        expectedSha256: poolData?.sha256 ?? null,
      });
      // A save issued for home A must never land on home B's view.
      if (!ticket.isCurrent()) return;
      setPoolData(current => ({
        schemaVersion: 1,
        pool: result.pool,
        sha256: result.sha256,
        error: null,
        legacy: current?.legacy ?? null,
        legacyError: current?.legacyError ?? null,
      }));
      setPoolDirty(false);
      setPoolSaved(true);
      setPoolError(null);
      setStandardAppliedId(null);
      setConvertSeatIndex(null);
    } catch (error) {
      const message = errorMessage(error);
      update({ lastError: message }, target);
      // A stale failure must not paint home A's error onto home B's card —
      // lastError is target-bound and stays safe unguarded, but the
      // card-local poolError must check the issue key like the success path.
      if (ticket.isCurrent()) {
        const cas = message.includes("peer pool changed");
        setPoolError({
          message: cas ? "The pool changed since the last read; Reload to fetch the new version." : message,
          cas,
        });
      }
    } finally {
      // A stale op must not clear the busy flag of a newer op in-flight on
      // the displayed target — the target-switch reset releases it instead.
      if (ticket.isCurrent()) setPoolSaving(false);
    }
  };

  // Reload discards in-flight edits and refetches — the recovery path after
  // a CAS conflict, and the escape after a malformed-file fix elsewhere. On
  // a dirty draft the press first offers "Keep current edits" /
  // "Discard changes and Reload" (§7.4.C); a failed refetch keeps the draft.
  const reloadPeerPool = async () => {
    if (!target || !targetKey) return;
    const ticket = capture();
    setPoolReloading(true);
    try {
      const result = await callGetPeerPool({ schemaVersion: 1, target });
      if (!ticket.isCurrent()) return;
      setPoolData(result);
      setPoolError(null);
      setPoolDirty(false);
      setPoolSaved(false);
      setPoolCopied(false);
      setStandardAppliedId(null);
      setConvertSeatIndex(null);
    } catch (error) {
      const message = errorMessage(error);
      update({ lastError: message }, target);
      if (ticket.isCurrent()) setPoolError({ message, cas: false });
    } finally {
      if (ticket.isCurrent()) setPoolReloading(false);
    }
  };
  const requestReload = (origin: "notice" | "footer") => {
    if (poolDirty) {
      setPoolReloadConfirm(origin);
      // "Keep current edits" is the safe default — focus it once the
      // confirmation renders (best-effort on the host's DOM backend).
      setTimeout(() => scrollFocusNode(keepEditsRef.current, true), 0);
    } else {
      void reloadPeerPool();
    }
  };

  // One-time import of the legacy ~/.paseo/slp-routing.json the server
  // reports — fills the form only; nothing is written until Save, and the
  // legacy file is never removed. The affordance exists only for an absent
  // pool with a TRULY untouched draft (§7.4.C: seats AND policy/fallback):
  // importing over authored content would discard it with no undo. Legacy
  // tokens import verbatim — old tags stay and surface as Token conflicts.
  const canImportLegacy = legacyImportAllowed(poolData, poolForm, poolDirty);
  const importLegacyPool = () => {
    if (!canImportLegacy || !poolData?.legacy) return;
    setPoolForm(peerPoolForm(poolData.legacy));
    setPoolDirty(true);
    setPoolSaved(false);
    setPoolCopied(false);
  };

  // Copy renders the SAME pool the Save gate saw — a malformed form refuses
  // here too rather than copying JSON that would fail validateCatalog.
  const copyPoolJson = async () => {
    if ("error" in poolBuild) { if (target) update({ lastError: poolBuild.error }, target); return; }
    const ticket = capture();
    try {
      await copyText(JSON.stringify(poolBuild.pool, null, 2));
      // The clipboard write itself is target-agnostic; the "Copied"
      // confirmation is card state and skips like every other stale paint.
      if (targetKey === null || ticket.isCurrent()) setPoolCopied(true);
    } catch (error) {
      if (target) update({ lastError: errorMessage(error) }, target);
    }
  };

  return {
    poolData,
    poolForm,
    poolDirty,
    poolSaving,
    poolReloading,
    poolBusy,
    poolLocked,
    poolSaved,
    poolCopied,
    poolReadError,
    poolError,
    poolReloadConfirm,
    convertSeatIndex,
    convertId,
    standardAppliedId,
    tokenLookupSeat,
    tokenLookupToken,
    openSeat,
    addSeatOpen,
    pickerQuery,
    seatRowRefs,
    lookupRefs,
    definitionRefs,
    keepEditsRef,
    poolBuild,
    poolDiffers,
    conflictedSeats,
    featureDefsForSeat,
    updatePool,
    featureKeys: poolForm.seats.map(seat =>
      seat.family !== "" && seat.model.trim() !== ""
        ? featureKey(seat.family, "peer", seat.model.trim(), seat.modeId.trim())
        : null,
    ).filter((key): key is string => key !== null),
    setPoolReloadConfirm,
    setConvertSeatIndex,
    setConvertId,
    setStandardAppliedId,
    setTokenLookupSeat,
    setTokenLookupToken,
    setOpenSeat,
    setAddSeatOpen,
    setPickerQuery,
    setSeatField,
    setSeatId,
    setSeatFamily,
    setSeatEnabled,
    setSeatFeature,
    addStandardSeat,
    addCustomFromTemplate,
    copySeatAsCustom,
    openConvertToCustom,
    applyConvertToCustom,
    applyStandardTokens,
    removeSeat,
    setFallbackId,
    savePeerPool,
    reloadPeerPool,
    requestReload,
    canImportLegacy,
    importLegacyPool,
    copyPoolJson,
  };
}


// ---------------------------------------------------------------------------
// View — render-only (wave 11 S3c). The hook above owns all state and
// handlers; this component paints them. The destructure below keeps the
// moved JSX byte-identical to its shell form.
// ---------------------------------------------------------------------------

export type PeerPoolCardState = ReturnType<typeof usePeerPoolCard>;

export function PeerPoolCard({ colors, target, compact, statusView, jev, pool, availableFamilies, catalogs, catalogLoadingFor, retryCatalog, retryFeatureSet, scrollFocusNode }: {
  colors: Colors;
  target: TargetValue | null;
  compact: boolean;
  statusView: StatusResult | null;
  jev: JevCardState;
  pool: PeerPoolCardState;
  availableFamilies: readonly FamilyName[];
  catalogs: Partial<Record<string, CatalogResult>>;
  catalogLoadingFor: string | null;
  retryCatalog: (family: FamilyName, role: RoleName) => Promise<unknown>;
  retryFeatureSet: (key: string) => Promise<unknown>;
  scrollFocusNode: (node: unknown, focus?: boolean) => void;
}) {
  const {
    poolData,
    poolForm,
    poolDirty,
    poolSaving,
    poolReloading,
    poolBusy,
    poolLocked,
    poolSaved,
    poolCopied,
    poolReadError,
    poolError,
    poolReloadConfirm,
    convertSeatIndex,
    convertId,
    standardAppliedId,
    tokenLookupSeat,
    tokenLookupToken,
    openSeat,
    addSeatOpen,
    pickerQuery,
    seatRowRefs,
    lookupRefs,
    definitionRefs,
    keepEditsRef,
    poolBuild,
    poolDiffers,
    conflictedSeats,
    featureDefsForSeat,
    updatePool,
    setPoolReloadConfirm,
    setConvertSeatIndex,
    setConvertId,
    setStandardAppliedId,
    setTokenLookupSeat,
    setTokenLookupToken,
    setOpenSeat,
    setAddSeatOpen,
    setPickerQuery,
    setSeatField,
    setSeatId,
    setSeatFamily,
    setSeatEnabled,
    setSeatFeature,
    addStandardSeat,
    addCustomFromTemplate,
    copySeatAsCustom,
    openConvertToCustom,
    applyConvertToCustom,
    applyStandardTokens,
    removeSeat,
    setFallbackId,
    savePeerPool,
    reloadPeerPool,
    requestReload,
    canImportLegacy,
    importLegacyPool,
    copyPoolJson,
  } = pool;
  return (
        <Card
          colors={colors}
          title="Peer pool"
          subtitle="User-scope seats a Lead picks per task. Supervisor and Lead keep their saved profiles — only Peer routes here."
          // Draft-state badge beside the card title (mockup dirty-badge):
          // amber while edits are unsaved, else the saved/absent state.
          trailing={
            poolDirty ? (
              <Badge colors={colors} label="Unsaved changes" tone="draft" />
            ) : poolData?.pool != null ? (
              <Badge colors={colors} label="Saved pool" tone="good" />
            ) : (
              <Badge colors={colors} label="No saved pool" />
            )
          }
        >
          {jev.view?.enabled === true && jev.view.capabilities?.routing === true ? (
            <View style={[styles.noticeBox, { borderColor: colors.accent, backgroundColor: colors.surface2 }]}>
              <Text style={[styles.mutedSmall, { color: colors.foreground }]}>
                Jev routing is armed — the seats below are the draft candidate set Jev picks from;
                edits apply only after Save, and a seat marked Token conflict is not a
                valid standard seat.
              </Text>
            </View>
          ) : null}
          {// §7.4.E — the four read states are distinct: still loading, read
           // failed (never painted as an empty list), stored file malformed,
           // and absent. Editing stays locked until a successful snapshot.
          poolData === null ? (
            poolReadError !== null ? (
              <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>
                Could not read the pool: {poolReadError} — use Reload to retry.
              </Text>
            ) : (
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                Reading the pool…
              </Text>
            )
          ) : poolData.error ? (
            <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>
              The stored pool failed validation: {poolData.error} — saving replaces it.
            </Text>
          ) : poolData.pool === null ? (
            <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
              No pool yet — add seats below, or import a legacy slp-routing.json.
            </Text>
          ) : null}
          {// Pool summary (mockup finding 7): the saved-state line plus the
           // enabled/disabled/conflicted counts — conflicted is an
           // OVERLAPPING count (a conflicted seat is also enabled or
           // disabled), not a third bucket.
          poolData !== null ? (
            <View style={[styles.field, { borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 12 }]}>
              <View style={[styles.cardHeadRow, { justifyContent: "space-between" }]}>
                <Text style={[styles.checkTitle, { color: colors.foreground }]}>
                  {poolData.pool != null
                    ? `Saved pool · ${poolForm.seats.length} seat${poolForm.seats.length === 1 ? "" : "s"} in draft`
                    : `No saved pool — ${poolForm.seats.length} seat${poolForm.seats.length === 1 ? "" : "s"} in draft`}
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
                <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                  <Text style={{ color: colors.foreground, fontWeight: "700" }}>{poolForm.seats.filter(seat => seat.enabled).length}</Text> enabled
                </Text>
                <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                  <Text style={{ color: colors.foreground, fontWeight: "700" }}>{poolForm.seats.filter(seat => !seat.enabled).length}</Text> disabled
                </Text>
                <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                  <Text style={{ color: colors.foreground, fontWeight: "700" }}>{conflictedSeats.length}</Text> conflicted
                </Text>
              </View>
            </View>
          ) : null}
          {// §7.4.D card-level conflict notice — pressing a seat opens its
           // editor and scrolls it into view (CAS/open-seat locality).
          conflictedSeats.length > 0 ? (
            <View style={[styles.noticeBox, { borderColor: colors.statusDanger, backgroundColor: colors.surface2 }]} accessibilityLiveRegion="polite">
              <Text style={[styles.checkTitle, { color: colors.statusDanger }]}>
                {conflictedSeats.length === 1 ? "1 seat needs token resolution" : `${conflictedSeats.length} seats need token resolution`}
              </Text>
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                These seats carry a reserved standard id but diverging tokens — resolve each before Save or Copy.
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {conflictedSeats.map(entry => (
                  <Button
                    key={entry.index}
                    colors={colors}
                    label={`Open seat ${poolForm.seats[entry.index]?.id ?? ""}`}
                    onPress={() => {
                      setOpenSeat(entry.index);
                      setTimeout(() => scrollFocusNode(seatRowRefs.current.get(entry.index), true), 50);
                    }}
                  />
                ))}
              </View>
            </View>
          ) : null}
          {// §7.4.D card notice — save/reload failures and the CAS conflict
           // ("The pool changed since the last read; Reload to fetch the new version") live
           // here, with Reload offered right at the message and the
           // dirty-draft confirmation rendered at this control's origin.
          poolError !== null ? (
            <View style={[styles.noticeBox, { borderColor: colors.statusDanger, backgroundColor: colors.surface2 }]} accessibilityLiveRegion="polite">
              <Text style={[styles.checkTitle, { color: colors.statusDanger }]}>
                {poolError.cas ? "Pool version conflict" : "Pool operation failed"}
              </Text>
              <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>{poolError.message}</Text>
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Your draft is preserved.</Text>
              {poolError.cas ? (
                <View>
                  <Button
                    colors={colors}
                    label={poolReloading ? "Reloading…" : "Reload"}
                    onPress={() => requestReload("notice")}
                    disabled={poolBusy}
                  />
                </View>
              ) : null}
              {poolReloadConfirm === "notice" ? (
                <View style={[styles.confirmBox, { borderColor: colors.statusWarning, backgroundColor: colors.surface0 }]} accessibilityRole="alert">
                  <Text style={[styles.checkTitle, { color: colors.foreground }]}>Discard your unsaved changes?</Text>
                  <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                    Reload replaces this draft only after the saved pool loads successfully.
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    <Pressable
                      ref={keepEditsRef}
                      onPress={() => setPoolReloadConfirm(null)}
                      accessibilityRole="button"
                      accessibilityLabel="Keep current edits"
                      style={(state: ControlState) => [styles.button, { backgroundColor: colors.accent, borderColor: colors.accent }, state.hovered && { opacity: 0.88 }, state.focused && focusRing(colors), state.pressed && { opacity: 0.75 }]}
                    >
                      <Text style={[styles.buttonLabel, { color: colors.accentForeground }]}>Keep current edits</Text>
                    </Pressable>
                    <Button
                      colors={colors}
                      kind="danger"
                      label="Discard changes and Reload"
                      onPress={() => { setPoolReloadConfirm(null); void reloadPeerPool(); }}
                    />
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}
          {poolData?.legacy && !canImportLegacy ? (
            <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
              A legacy catalog exists at ~/.paseo/slp-routing.json — import is
              available while this pool is empty and unedited.
            </Text>
          ) : null}
          {canImportLegacy ? (
            <View style={[styles.roleBox, { borderColor: colors.border }]}>
              <Text style={[styles.mutedSmall, { color: colors.foreground }]}>
                A legacy catalog exists at ~/.paseo/slp-routing.json — import it once
                to populate this pool. The file is only read, never removed.
              </Text>
              <Button
                colors={colors}
                label="Import legacy catalog"
                onPress={importLegacyPool}
                disabled={poolBusy}
              />
            </View>
          ) : null}
          {poolData?.legacyError ? (
            <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
              ~/.paseo/slp-routing.json exists but is not a valid pool: {poolData.legacyError}
            </Text>
          ) : null}
          <Field
            colors={colors}
            label="Pool policy"
            hint="Who maintains this pool and the budget boundary — shown to the Lead"
            value={poolForm.policy}
            onChangeText={text => updatePool(form => ({ ...form, policy: text }))}
            placeholder="Human maintains model suitability and quota…"
            disabled={poolLocked}
            multiline
          />
          {poolForm.seats.length > 0 ? (
            <View style={[styles.cardHeadRow, { justifyContent: "space-between" }]}>
              <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Seats · draft order</Text>
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Enable only when configured</Text>
            </View>
          ) : null}
          {poolForm.seats.map((seat, index) => {
            const seatScope = seat.family !== "" ? catalogScope(seat.family, "peer") : null;
            const seatCatalog = seatScope !== null ? catalogs[seatScope] : undefined;
            const thinking = seat.family !== "" ? thinkingOptionsFor(seatCatalog, seat.model) : null;
            const featureDefs = featureDefsForSeat(seat);
            const open = openSeat === index;
            const disabled = poolLocked;
            // §7.2 management is by exact id; the draft row's conflict state
            // is computed against the package token set (unordered compare).
            const managed = seatManagement(seat) === "package-managed";
            const conflict = managed ? formSeatConflict(seat) : null;
            const standardTokens = managed ? STANDARD_SEAT_TOKENS[seat.id.trim()] : undefined;
            // Parked semantics (mockup finding 6): the row states the draft
            // lifecycle explicitly — enabled is a deliberate switch, never
            // inferred from a filled binding.
            const seatState = seat.enabled
              ? "Enabled in draft"
              : seat.family !== "" && seat.model.trim() !== ""
                ? "Disabled · configured"
                : "Disabled · needs provider/model";
            // One token row: the exact token text, its axis in muted parens,
            // an optional +/− conflict mark, and a press that opens the
            // definition lookup at that token.
            const tokenRows = (tokens: string[], mark: (token: string) => "+" | "−" | null = () => null) =>
              tokens.length === 0 ? (
                <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>No declarations</Text>
              ) : (
                // .token style — underlined mono buttons named "Define X";
                // a press opens the lookup at exactly this definition and
                // scrolls it into view (mockup findings 9–10).
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {tokens.map((token, tokenIndex) => {
                    const marked = mark(token);
                    const def = tokenDefinition(token);
                    return (
                      <Pressable
                        key={`${tokenIndex}:${token}`}
                        onPress={() => {
                          setTokenLookupSeat(index);
                          setTokenLookupToken(token);
                          setTimeout(() => scrollFocusNode(
                            definitionRefs.current.get(index) ?? lookupRefs.current.get(index),
                            true,
                          ), 50);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`Define ${token}`}
                        style={(state: ControlState) => [
                          { borderRadius: 4, paddingHorizontal: 2 },
                          state.hovered && { backgroundColor: colors.surface2 },
                          state.focused && focusRing(colors),
                          state.pressed && { opacity: 0.7 },
                        ]}
                      >
                        <Text style={[styles.tokenText, {
                          color: marked === "−" ? colors.statusDanger
                            : marked === "+" ? colors.statusSuccess
                            : colors.accent,
                        }]}>
                          {marked !== null ? `${marked} ` : ""}{token}
                          <Text style={{ color: colors.foregroundMuted, textDecorationLine: "none" }}>
                            {def ? ` (${def.axis})` : " (custom)"}
                          </Text>
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              );
            return (
              // key is the stable draft uid — editing `id` must not remount
              // the row (mockup finding 2: typing in the Custom ID field
              // preserved the focused input node).
              <View
                key={seat.uid}
                ref={node => { seatRowRefs.current.set(index, node); }}
                style={[styles.roleBox, { borderColor: conflict ? colors.statusDanger : open ? colors.accent : colors.border }, open && { borderWidth: 2, padding: 11 }]}
              >
                {/* .seat.open — the accent border above plus the accent-tinted
                    header row (surface2 fill + accent bottom rule). */}
                <View style={[
                  { flexDirection: "row", alignItems: "center", gap: 10 },
                  open && {
                    backgroundColor: colors.surface2,
                    marginTop: -11, marginHorizontal: -11,
                    paddingTop: 11, paddingHorizontal: 11, paddingBottom: 10,
                    borderTopLeftRadius: 7, borderTopRightRadius: 7,
                    borderBottomWidth: 1, borderBottomColor: colors.accent,
                  },
                ]}>
                  <Pressable
                    onPress={() => setSeatEnabled(index)(!seat.enabled)}
                    disabled={disabled}
                    accessibilityRole="switch"
                    accessibilityLabel={`Enable ${seat.id || "unnamed seat"} in draft`}
                    accessibilityState={{ checked: seat.enabled, disabled }}
                    style={(state: ControlState) => [
                      styles.switchTrack,
                      { backgroundColor: seat.enabled ? colors.accent : colors.border },
                      state.hovered && !disabled && { opacity: 0.85 },
                      state.focused && focusRing(colors),
                      state.pressed && !disabled && { opacity: 0.75 },
                    ]}
                  >
                    <View style={[
                      styles.switchThumb,
                      { backgroundColor: seat.enabled ? colors.accentForeground : colors.foregroundMuted },
                      seat.enabled ? styles.switchThumbOn : styles.switchThumbOff,
                    ]} />
                  </Pressable>
                  <Pressable
                    onPress={() => setOpenSeat(open ? null : index)}
                    accessibilityRole="button"
                    accessibilityLabel={`${open ? "Close" : "Open"} editor for ${seat.id || "unnamed seat"}`}
                    accessibilityState={{ expanded: open }}
                    style={(state: ControlState) => [
                      { flex: 1, gap: 2, borderRadius: 6, padding: 4, margin: -4 },
                      state.hovered && !open && { backgroundColor: colors.surface2 },
                      state.focused && focusRing(colors),
                    ]}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={[styles.roleTitle, styles.mono, { color: colors.foreground }]} numberOfLines={1}>
                        {seat.id || "(unnamed seat)"}
                      </Text>
                      <Badge colors={colors} label={managed ? "Package-managed" : "Custom"} tone={managed ? "managed" : "neutral"} />
                      {conflict ? <Badge colors={colors} label="Token conflict" tone="bad" /> : null}
                    </View>
                    <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]} numberOfLines={1}>
                      {(seat.family === "" ? "No provider" : FAMILY_LABEL[seat.family]) +
                        (seat.model ? ` · ${seat.model}` : " · No model") +
                        (seat.modeId ? ` · ${seat.modeId}` : "")}
                    </Text>
                    <Text
                      style={[styles.seatState, { color: seat.enabled ? colors.accent : colors.foregroundMuted }]}
                      numberOfLines={1}
                    >
                      {seatState}
                    </Text>
                  </Pressable>
                  <Button
                    colors={colors}
                    label={open ? "Close" : "Edit"}
                    onPress={() => setOpenSeat(open ? null : index)}
                    // Intentionally NOT disabled: expanding while the pool is
                    // locked is view-only — every control inside stays
                    // disabled — and matches the title press beside it.
                  />
                </View>
                {open ? (
                  <>
                    {!seat.enabled ? (
                      // Parked flow hint (mockup finding 6): the editor
                      // states the enable path before the fields.
                      <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                        Choose provider/model → enable → Save pool
                      </Text>
                    ) : null}
                    {managed ? (
                      // §7.4.B — a standard seat's id IS the package
                      // reference; renaming it is how a reserved name would
                      // be stolen, so the id is display-only.
                      <View style={styles.field}>
                        <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Seat ID</Text>
                        <Text style={[styles.mutedSmall, { color: colors.foreground }]}>{seat.id}</Text>
                        <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                          Reserved standard-seat id — package-managed; "Create a custom copy" below copies it into an editable Custom seat.
                        </Text>
                      </View>
                    ) : (
                      <>
                        <Field
                          colors={colors}
                          label="Seat ID"
                          hint="Lowercase letters, digits, dashes — the Lead quotes this id in a launch request. Reserved standard-seat ids are refused."
                          value={seat.id}
                          onChangeText={setSeatId(index)}
                          placeholder="peer-coding"
                          disabled={disabled}
                        />
                        {(() => {
                          const idError = customSeatIdError(
                            seat.id,
                            poolForm.seats.filter((_, i) => i !== index).map(other => other.id.trim()),
                          );
                          return idError !== null ? (
                            <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>{idError}</Text>
                          ) : null;
                        })()}
                      </>
                    )}
                    <View style={styles.field}>
                      <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Provider family</Text>
                      <ChipSelect
                        colors={colors}
                        value={seat.family}
                        options={[
                          { label: "Unset", value: "" as const },
                          ...FAMILY_PICKER_ORDER
                            .filter(entry => availableFamilies.includes(entry))
                            .map(entry => ({ label: FAMILY_LABEL[entry], value: entry })),
                          // A stored family the host no longer reports as
                          // available stays visible — the same escape hatch
                          // the mode/thinking pickers give stored values.
                          ...(seat.family !== "" && !availableFamilies.includes(seat.family)
                            ? [{ label: `${FAMILY_LABEL[seat.family]} (unavailable)`, value: seat.family }]
                            : []),
                        ]}
                        onChange={setSeatFamily(index)}
                        disabled={disabled}
                      />
                      {availableFamilies.length === 0 ? (
                        <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                          Inspect the daemon first — only families reported available are offered.
                        </Text>
                      ) : null}
                    </View>
                    {seatScope !== null && catalogLoadingFor === seatScope ? (
                      <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                        Loading {seat.family !== "" ? FAMILY_LABEL[seat.family] : ""} catalog…
                      </Text>
                    ) : null}
                    {seatCatalog?.error ? (
                      <>
                        <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
                          Catalog unavailable: {seatCatalog.error} — enter values manually.
                        </Text>
                        <Button
                          colors={colors}
                          label="Retry catalog"
                          onPress={() => { if (seat.family !== "") void retryCatalog(seat.family, "peer"); }}
                          disabled={disabled || catalogLoadingFor === seatScope}
                        />
                      </>
                    ) : null}
                    {seatCatalog && seatCatalog.models.length > 0 ? (
                      <OptionPicker
                        colors={colors}
                        label="Model"
                        hint="Required on an enabled seat"
                        options={seatCatalog.models}
                        value={seat.model}
                        onChange={setSeatField(index, "model")}
                        onOpen={() => { if (seat.family !== "") void retryCatalog(seat.family, "peer"); }}
                        disabled={disabled}
                        placeholder="Filter models…"
                      />
                    ) : (
                      <Field
                        colors={colors}
                        label="Model"
                        hint="Required on an enabled seat"
                        value={seat.model}
                        onChangeText={setSeatField(index, "model")}
                        placeholder="Model ID — e.g. swe-2-max"
                        disabled={disabled}
                      />
                    )}
                    {seatCatalog?.models.length === 0 && seat.family !== "" ? (
                      <Button
                        colors={colors}
                        label="Refresh models"
                        onPress={() => { if (seat.family !== "") void retryCatalog(seat.family, "peer"); }}
                        disabled={disabled || catalogLoadingFor === seatScope}
                      />
                    ) : null}
                    {seatCatalog && seatCatalog.modes.length > 0 ? (
                      // §7.4.B — Mode is a user pick on both seat kinds: the
                      // same catalog picker and free-text fallback as Custom.
                      <View style={styles.field}>
                        <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Mode</Text>
                        <ChipSelect
                          colors={colors}
                          value={seat.modeId}
                          options={[
                            { label: "Provider default", value: "" },
                            ...seatCatalog.modes.map(mode => ({ label: mode.label, value: mode.id })),
                            // A stored mode the catalog doesn't list stays
                            // visible and clearable — "(stored)" marks it as
                            // leftover, same convention as the thinking picker.
                            ...(seat.modeId !== "" && !seatCatalog.modes.some(mode => mode.id === seat.modeId)
                              ? [{ label: `${seat.modeId} (stored)`, value: seat.modeId }]
                              : []),
                          ]}
                          onChange={setSeatField(index, "modeId")}
                          disabled={disabled}
                        />
                      </View>
                    ) : (
                      <Field
                        colors={colors}
                        label="Mode"
                        value={seat.modeId}
                        onChangeText={setSeatField(index, "modeId")}
                        placeholder="Mode ID — e.g. bypass"
                        disabled={disabled}
                      />
                    )}
                    {managed ? (
                      // §7.4.B — Features remain the package's binding shape
                      // for a standard seat: read-only summary so a draft
                      // can't silently diverge. Only features hold this lock.
                      <View style={styles.field}>
                        <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Feature values</Text>
                        <Text style={[styles.mutedSmall, { color: colors.foreground }]}>
                          {seat.features.trim() !== ""
                            ? seat.features
                            : Object.keys(seat.feature).some(featureId => seat.feature[featureId] !== "")
                              ? JSON.stringify(seat.feature)
                              : "Provider/host default"}
                        </Text>
                      </View>
                    ) : featureDefs.loading ? (
                      <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Loading features…</Text>
                    ) : null}
                    {managed ? null : featureDefs.defs.length > 0 ? (
                      featureDefs.defs.map(def => (
                        def.type === "toggle" ? (
                          <SwitchRow
                            key={def.id}
                            colors={colors}
                            checked={(seat.feature[def.id] ?? "") === "" ? def.value : seat.feature[def.id] === "true"}
                            onToggle={next => setSeatFeature(index, def.id)(String(next))}
                            title={def.label}
                            hint={def.description}
                            disabled={disabled}
                          />
                        ) : (
                          <View key={def.id} style={styles.field}>
                            <Text style={[styles.fieldLabel, { color: colors.foreground }]}>{def.label}</Text>
                            <ChipSelect
                              colors={colors}
                              value={seat.feature[def.id] ?? ""}
                              options={[
                                { label: "Provider default", value: "" },
                                ...def.options.map(option => ({ label: option.label, value: option.id })),
                              ]}
                              onChange={setSeatFeature(index, def.id)}
                              disabled={disabled}
                            />
                            {def.description ? (
                              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{def.description}</Text>
                            ) : null}
                          </View>
                        )
                      ))
                    ) : (
                      <>
                        <Field
                          colors={colors}
                          label="Feature values (JSON)"
                          hint='Provider feature flags — e.g. {"auto_accept": true}'
                          value={seat.features}
                          onChangeText={setSeatField(index, "features")}
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
                        value={seat.thinkingOptionId}
                        onChangeText={setSeatField(index, "thinkingOptionId")}
                        placeholder="Thinking option ID"
                        disabled={disabled}
                      />
                    ) : thinking.options.length > 0 ? (
                      <View style={styles.field}>
                        <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>Thinking option</Text>
                        <ChipSelect
                          colors={colors}
                          value={seat.thinkingOptionId}
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
                            ...(seat.thinkingOptionId !== "" &&
                              !thinking.options.some(option => option.id === seat.thinkingOptionId)
                              ? [{ label: `${seat.thinkingOptionId} (stored)`, value: seat.thinkingOptionId }]
                              : []),
                          ]}
                          onChange={setSeatField(index, "thinkingOptionId")}
                          disabled={disabled}
                        />
                      </View>
                    ) : null}
                    <View style={styles.field}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Text style={[styles.fieldLabel, { color: colors.foreground, flex: 1 }]}>
                          Task suitability — sent to Jev
                        </Text>
                        <Button
                          colors={colors}
                          label={tokenLookupSeat === index ? "Hide token definitions" : "Show token definitions"}
                          onPress={() => {
                            const opening = tokenLookupSeat !== index;
                            setTokenLookupSeat(opening ? index : null);
                            setTokenLookupToken(null);
                            if (opening) setTimeout(() => scrollFocusNode(lookupRefs.current.get(index)), 50);
                          }}
                        />
                      </View>
                      {managed ? (
                        // §7.4.B "Record at Avoid" — advisory, not a runtime
                        // prohibition; shown once for both avoid lists,
                        // conflict view included.
                        <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                          avoidFor is advisory only — it does not block a runtime permission.
                        </Text>
                      ) : null}
                      {conflict && standardTokens ? (
                        // §7.4.D — both versions at exact values; the stored
                        // side marks tokens the standard set would drop (−),
                        // the standard side marks what it would add (+).
                        <View style={[styles.roleBox, { borderColor: colors.statusDanger }]}>
                          <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>
                            Token conflict — this seat carries a reserved standard id but
                            its stored tokens diverge from the package set. It cannot be
                            routed or saved until resolved.
                          </Text>
                          <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>
                            Currently stored/imported content
                          </Text>
                          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>suitableFor</Text>
                          {tokenRows(lineList(seat.suitableFor), token =>
                            standardTokens.suitableFor.includes(token) ? null : "−")}
                          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>avoidFor</Text>
                          {tokenRows(lineList(seat.avoidFor), token =>
                            standardTokens.avoidFor.includes(token) ? null : "−")}
                          <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>
                            The package's standard set
                          </Text>
                          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>suitableFor</Text>
                          {tokenRows([...standardTokens.suitableFor], token =>
                            lineList(seat.suitableFor).includes(token) ? null : "+")}
                          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>avoidFor</Text>
                          {tokenRows([...standardTokens.avoidFor], token =>
                            lineList(seat.avoidFor).includes(token) ? null : "+")}
                          {// Added/Removed summary across BOTH lists (mockup
                           // finding 9): the marks above are per-token; this
                           // line states the net difference in one read.
                          }
                          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                            {(() => {
                              const added = ["suitableFor", "avoidFor"].flatMap(k =>
                                standardTokens[k as "suitableFor" | "avoidFor"]
                                  .filter(t => !lineList(seat[k as "suitableFor" | "avoidFor"]).includes(t))
                                  .map(t => `${k}: ${t}`));
                              const removed = ["suitableFor", "avoidFor"].flatMap(k =>
                                lineList(seat[k as "suitableFor" | "avoidFor"])
                                  .filter(t => !standardTokens[k as "suitableFor" | "avoidFor"].includes(t))
                                  .map(t => `${k}: ${t}`));
                              return `Added: ${added.join(", ") || "none"} · Removed: ${removed.join(", ") || "none"}`;
                            })()}
                          </Text>
                          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                            <Button
                              colors={colors}
                              label="Apply the standard set"
                              onPress={applyStandardTokens(index)}
                              disabled={disabled}
                            />
                            <Button
                              colors={colors}
                              label="Convert this seat to a custom seat"
                              onPress={openConvertToCustom(index)}
                              disabled={disabled}
                            />
                          </View>
                        </View>
                      ) : managed ? (
                        // §7.4.B — a standard seat's two token lists are the
                        // package's exact values, read-only; pressing a token
                        // opens its definition.
                        <>
                          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>suitableFor</Text>
                          {tokenRows(lineList(seat.suitableFor))}
                          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>avoidFor</Text>
                          {tokenRows(lineList(seat.avoidFor))}
                        </>
                      ) : (
                        // Custom seats keep free-form strings — the seat's
                        // own semantics; they receive no package updates.
                        <>
                          <Field
                            colors={colors}
                            label="Suitable for"
                            hint="One per line — task shapes this seat handles. Standard seats use the closed axis:value vocabulary; see Token definitions."
                            value={seat.suitableFor}
                            onChangeText={setSeatField(index, "suitableFor")}
                            placeholder={"work:change\ndomain:software"}
                            disabled={disabled}
                            multiline
                          />
                          <Field
                            colors={colors}
                            label="Avoid for"
                            hint="One per line — advisory warning only; it does not block a runtime permission"
                            value={seat.avoidFor}
                            onChangeText={setSeatField(index, "avoidFor")}
                            placeholder={"work:design\nflow:staged"}
                            disabled={disabled}
                            multiline
                          />
                          {// §7.4.F — entered strings are pressable: a
                           // standard token opens its packaged definition, a
                           // free/legacy string resolves to "custom content"
                           // instead of borrowing a near-match's meaning.
                          lineList(seat.suitableFor).length + lineList(seat.avoidFor).length > 0 ? (
                            <>
                              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                                Press an entered string to look it up:
                              </Text>
                              {tokenRows(lineList(seat.suitableFor))}
                              {tokenRows(lineList(seat.avoidFor))}
                            </>
                          ) : null}
                        </>
                      )}
                    </View>
                    {standardAppliedId === seat.id.trim() && !conflict ? (
                      <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
                        Standard set selected — not yet saved
                      </Text>
                    ) : null}
                    {convertSeatIndex === index ? (
                      // §7.4.D convert-to-custom: id input + reserved-name
                      // error + the quotaFallback remap the one Save will
                      // carry, and the custom-seat caveat.
                      <View style={[styles.roleBox, { borderColor: colors.border }]}>
                        <Text style={[styles.fieldLabel, { color: colors.foreground }]}>
                          Convert "{seat.id}" to a custom seat
                        </Text>
                        <Field
                          colors={colors}
                          label="Custom seat ID"
                          value={convertId}
                          onChangeText={setConvertId}
                          placeholder={`${seat.id}-2`}
                          disabled={disabled}
                        />
                        {(() => {
                          const idError = customSeatIdError(
                            convertId,
                            poolForm.seats.filter((_, i) => i !== index).map(other => other.id.trim()),
                          );
                          const remapped = poolForm.quotaFallbackId === seat.id;
                          return (
                            <>
                              {idError !== null ? (
                                <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>{idError}</Text>
                              ) : null}
                              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                                {remapped
                                  ? `quotaFallback will be retargeted in this draft: ${seat.id.trim()} → ${convertId.trim() || "?"}`
                                  : "No quotaFallback designation to retarget."}
                              </Text>
                              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                                Custom seats do not receive package token updates; references
                                outside the pool must be updated separately.
                              </Text>
                              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                                <Button
                                  colors={colors}
                                  label="Apply to draft"
                                  onPress={applyConvertToCustom}
                                  disabled={disabled || idError !== null}
                                />
                                <Button
                                  colors={colors}
                                  label="Cancel"
                                  onPress={() => { setConvertSeatIndex(null); setConvertId(""); }}
                                />
                              </View>
                            </>
                          );
                        })()}
                      </View>
                    ) : null}
                    {tokenLookupSeat === index ? (
                      // §7.4.F — the package's token lookup: how-to-read, the
                      // four axes as pickers, then the selected token's full
                      // definition (or "custom content" for non-package text).
                      <View
                        ref={node => { lookupRefs.current.set(index, node); }}
                        role="region"
                        accessibilityLabel="Token definitions"
                        style={[styles.noticeBox, { borderColor: colors.accent, backgroundColor: colors.surface2 }]}
                      >
                        <View style={[styles.cardHeadRow, { justifyContent: "space-between" }]}>
                          <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Token definitions</Text>
                          <Button
                            colors={colors}
                            label="Close definitions"
                            onPress={() => { setTokenLookupSeat(null); setTokenLookupToken(null); }}
                          />
                        </View>
                        <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>How to read</Text>
                        {HOW_TO_READ.map(line => (
                          <Text key={line} style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                            {line}
                          </Text>
                        ))}
                        {SUITABILITY_AXES.map(axis => (
                          <View key={axis.id} style={{ gap: 2 }}>
                            <Text style={[styles.fieldLabel, { color: colors.foregroundMuted }]}>
                              {axis.id} — {axis.question}
                            </Text>
                            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                              {SUITABILITY_TOKENS.filter(token => token.axis === axis.id).map(token => (
                                <Pressable
                                  key={token.id}
                                  onPress={() => {
                                    setTokenLookupToken(token.id);
                                    setTimeout(() => scrollFocusNode(definitionRefs.current.get(index), true), 50);
                                  }}
                                  accessibilityRole="button"
                                  accessibilityLabel={`Define ${token.id}`}
                                  accessibilityState={{ selected: tokenLookupToken === token.id }}
                                  style={(state: ControlState) => [
                                    styles.chip,
                                    tokenLookupToken === token.id && { borderColor: colors.accent, backgroundColor: colors.surface2 },
                                    state.hovered && { backgroundColor: colors.surface2 },
                                    state.focused && focusRing(colors),
                                    state.pressed && { opacity: 0.75 },
                                  ]}
                                >
                                  <Text style={[styles.chipLabel, styles.mono, { color: colors.foreground }]}>{token.id}</Text>
                                </Pressable>
                              ))}
                            </View>
                          </View>
                        ))}
                        {tokenLookupToken !== null ? (() => {
                          const def = tokenDefinition(tokenLookupToken);
                          return (
                            <View
                              ref={node => { definitionRefs.current.set(index, node); }}
                              role="region"
                              accessibilityLabel={`Definition of ${tokenLookupToken}`}
                              style={[styles.noticeBox, { borderColor: colors.border, backgroundColor: colors.surface0, gap: 2 }]}
                            >
                              <Text style={[styles.checkTitle, styles.mono, { color: colors.foreground }]}>{tokenLookupToken}</Text>
                              {def ? (
                                <>
                                  <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                                    {def.axis} — {SUITABILITY_AXES.find(axis => axis.id === def.axis)?.question}
                                  </Text>
                                  <Text style={[styles.mutedSmall, { color: colors.foreground }]}>{def.sign}</Text>
                                  <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                                    Example: {def.example}
                                  </Text>
                                  <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                                    Counter-example: {def.counterExample}
                                  </Text>
                                  <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                                    Boundary: {def.boundary}
                                  </Text>
                                </>
                              ) : (
                                // A custom string is lookupable too — its
                                // "definition" states the package carries no
                                // meaning for it (mockup finding 9).
                                <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                                  Custom content — the package does not define this token.
                                </Text>
                              )}
                            </View>
                          );
                        })() : null}
                      </View>
                    ) : null}
                    <Text style={[styles.fieldLabel, { color: colors.foreground }]}>
                      Local only — Jev never sees this
                    </Text>
                    {/*
                      §7.4.B — Notes are a local-only annotation editable on
                      both seat kinds; on a managed seat the package-provided
                      explanation is the seeded default the user can overwrite.
                      The field stays required for every seat.
                    */}
                    <Field
                      colors={colors}
                      label="Notes"
                      hint="Why this seat exists, in the working language — required"
                      value={seat.notes}
                      onChangeText={setSeatField(index, "notes")}
                      placeholder="Cost, quota, and judgment notes for the Lead"
                      disabled={disabled}
                      multiline
                    />
                    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                      <Button
                        colors={colors}
                        kind="danger"
                        label="Remove seat"
                        onPress={removeSeat(index)}
                        disabled={disabled}
                      />
                      {managed ? (
                        <>
                          <Button
                            colors={colors}
                            label="Create a custom copy"
                            onPress={copySeatAsCustom(index)}
                            disabled={disabled}
                          />
                          {!conflict ? (
                            // §7.4.D — a non-conflicting standard seat can
                            // voluntarily leave management here; a conflicted
                            // one gets the same action inside its conflict
                            // section above.
                            <Button
                              colors={colors}
                              label="Convert this seat to a custom seat"
                              onPress={openConvertToCustom(index)}
                              disabled={disabled}
                            />
                          ) : null}
                        </>
                      ) : null}
                    </View>
                  </>
                ) : null}
              </View>
            );
          })}
          {addSeatOpen ? (
            // §7.4.C picker (mockup finding 5): Close at the top, a
            // name/description filter over the twelve canonical archetypes,
            // compact rows, and notes/custom creation expanded per row.
            <View
              style={[styles.noticeBox, { borderColor: colors.accent, backgroundColor: colors.surface0 }]}
              role="region"
              accessibilityLabel="Standard seat picker"
            >
              <View style={[styles.cardHeadRow, { justifyContent: "space-between" }]}>
                <Text style={[styles.fieldLabel, { color: colors.foreground }]}>Add a standard seat</Text>
                <Button colors={colors} label="Close" onPress={() => setAddSeatOpen(false)} />
              </View>
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                Twelve package templates. New seats start disabled with no provider or model;
                "Create a custom seat from template" copies a template into an editable Custom seat.
              </Text>
              <Field
                colors={colors}
                label="Filter by name or description"
                value={pickerQuery}
                onChangeText={setPickerQuery}
                placeholder="Search 12 archetypes…"
                disabled={poolLocked}
              />
              <ScrollView style={{ maxHeight: 385 }} nestedScrollEnabled>
                {PEER_SEAT_ARCHETYPES
                  .filter(archetype =>
                    `${archetype.id} ${archetype.notes}`
                      .toLowerCase()
                      .includes(pickerQuery.trim().toLowerCase()))
                  .map(archetype => (
                    <SeatTemplateRow
                      key={archetype.id}
                      colors={colors}
                      archetype={archetype}
                      exists={poolForm.seats.some(seat => seat.id.trim() === archetype.id)}
                      onAdd={addStandardSeat(archetype)}
                      onCustom={addCustomFromTemplate(archetype)}
                      disabled={poolLocked}
                    />
                  ))}
                {PEER_SEAT_ARCHETYPES.every(archetype =>
                  !`${archetype.id} ${archetype.notes}`
                    .toLowerCase()
                    .includes(pickerQuery.trim().toLowerCase())) ? (
                  <Text style={[styles.mutedSmall, { color: colors.foregroundMuted, paddingVertical: 8 }]} accessibilityLiveRegion="polite">
                    No templates match this filter.
                  </Text>
                ) : null}
              </ScrollView>
            </View>
          ) : (
            <Button
              colors={colors}
              kind="primary"
              label="Add a standard seat"
              onPress={() => { setPickerQuery(""); setAddSeatOpen(true); }}
              disabled={poolLocked}
            />
          )}
          {// §7.4.C quota fallback — the wave-6 contract: ONE designated
           // option, one retry, no ordering. The mockup's multi-select +
           // order numbers predate wave 6 and are deliberately not ported.
          }
          <View style={styles.field}>
            <SwitchRow
              colors={colors}
              checked={poolForm.quotaFallbackEnabled}
              onToggle={next => updatePool(form => ({ ...form, quotaFallbackEnabled: next }))}
              title="Quota fallback"
              hint="Designate one pool seat. On a quota error the Lead retries once on that seat — a repeated quota error or an unavailable target reports BLOCKED; no retry loop."
              disabled={poolLocked}
            />
            {poolForm.quotaFallbackEnabled ? (
              poolForm.seats.length === 0 ? (
                <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
                  Add seats before designating a fallback option.
                </Text>
              ) : (
                <>
                  <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                    Designated fallback seat:
                  </Text>
                  <ChipSelect<string>
                    colors={colors}
                    value={poolForm.quotaFallbackId}
                    options={poolForm.seats.map(seat => ({ label: seat.id || "(unnamed seat)", value: seat.id }))}
                    onChange={setFallbackId}
                    disabled={poolLocked}
                  />
                  <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                    Retry exactly once on the designated seat — the source seat and a
                    target sharing the exhausted quota are not viable fallbacks.
                  </Text>
                </>
              )
            ) : null}
          </View>
          {"error" in poolBuild ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Text style={[styles.mutedSmall, { color: colors.statusDanger, flex: 1 }]}>{poolBuild.error}</Text>
              {poolBuild.seatIndex != null ? (
                <Button
                  colors={colors}
                  label={`Open seat ${poolForm.seats[poolBuild.seatIndex]?.id ?? ""}`}
                  onPress={() => setOpenSeat(poolBuild.seatIndex ?? null)}
                />
              ) : null}
            </View>
          ) : null}
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Button
                colors={colors}
                label={poolCopied ? "Copied" : "Copy pool JSON"}
                onPress={() => void copyPoolJson()}
                disabled={poolBusy || "error" in poolBuild}
              />
            </View>
            <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
              Copies this pool as a catalog document. Pasting it into a repository's
              .paseo-slp/slp-routing.json makes that repository ignore this pool
              permanently — even if the pool is emptied later. The supported way to
              pin a repository pool is `slp init &lt;repo&gt; --routing-from &lt;file&gt; --apply`.
            </Text>
          </View>
          {poolSaved && !poolDirty ? (
            <Text style={[styles.mutedSmall, { color: colors.statusSuccess }]}>
              Saved — any route a Lead already read is now stale: the recorded catalog
              hash no longer matches, so the next prepare fails closed until `routes`
              is re-read.
            </Text>
          ) : null}
          <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, gap: 8 }}>
            <View style={[styles.cardHeadRow, { justifyContent: "space-between" }]}>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <Button
                  colors={colors}
                  kind="primary"
                  label={poolSaving ? "Saving…" : "Save pool"}
                  // §7.4.C — Save only exists once a read snapshot does; the
                  // button stays clickable on a build error so it can report it,
                  // but sends no RPC in that case.
                  disabled={!target || poolBusy || !poolDiffers || poolData === null}
                  onPress={() => void savePeerPool()}
                />
                <Button
                  colors={colors}
                  label={poolReloading ? "Reloading…" : "Reload"}
                  onPress={() => requestReload("footer")}
                  disabled={poolBusy}
                />
              </View>
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>One save for the whole pool</Text>
            </View>
            {poolReloadConfirm === "footer" ? (
              <View style={[styles.confirmBox, { borderColor: colors.statusWarning, backgroundColor: colors.surface0 }]} accessibilityRole="alert">
                <Text style={[styles.checkTitle, { color: colors.foreground }]}>Discard your unsaved changes?</Text>
                <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                  Reload replaces this draft only after the saved pool loads successfully.
                </Text>
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  <Pressable
                    ref={keepEditsRef}
                    onPress={() => setPoolReloadConfirm(null)}
                    accessibilityRole="button"
                    accessibilityLabel="Keep current edits"
                    style={(state: ControlState) => [styles.button, { backgroundColor: colors.accent, borderColor: colors.accent }, state.hovered && { opacity: 0.88 }, state.focused && focusRing(colors), state.pressed && { opacity: 0.75 }]}
                  >
                    <Text style={[styles.buttonLabel, { color: colors.accentForeground }]}>Keep current edits</Text>
                  </Pressable>
                  <Button
                    colors={colors}
                    kind="danger"
                    label="Discard changes and Reload"
                    onPress={() => { setPoolReloadConfirm(null); void reloadPeerPool(); }}
                  />
                </View>
              </View>
            ) : null}
          </View>
        </Card>
  );
}
