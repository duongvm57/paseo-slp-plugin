// Work tracker owns the immediate whole-file toggle and target-switch reset.
// Target async owns reads, read errors and session tickets; the shell supplies
// RPC adapters and target-bound lastError plumbing. SLP probes bd, never
// installs or initializes it.
import { useEffect, useState } from "react";
import { useTargetSnapshot } from "../target-async.ts";
import { Text, View } from "react-native";
import type {
  GetWorkTrackerRequest,
  GetWorkTrackerResult,
  SetWorkTrackerRequest,
  SetWorkTrackerResult,
  TargetValue,
  WorkTrackerViewValue,
} from "../../shared/contracts.ts";
import { errorMessage } from "../manager-state.ts";
import type { Colors } from "../ui-kit.tsx";
import { Badge, Button, Card, styles, SwitchRow } from "../ui-kit.tsx";

export function useWorkTrackerCard({ target, targetKey, sameTarget, callGetWorkTracker, callSetWorkTracker, update }: {
  target: TargetValue | null;
  targetKey: string | null;
  sameTarget: (forTarget: TargetValue) => boolean;
  callGetWorkTracker: (input: GetWorkTrackerRequest) => Promise<GetWorkTrackerResult>;
  callSetWorkTracker: (input: SetWorkTrackerRequest) => Promise<SetWorkTrackerResult>;
  update: (patch: { lastError: string | null }, target: TargetValue) => void;
}) {
  const snapshot = useTargetSnapshot(target, targetKey, async target =>
    (await callGetWorkTracker({ schemaVersion: 1, target })).workTracker);
  const { data: view, replace: setView, error: loadError, reload: load, capture } = snapshot;
  const [busy, setBusy] = useState(false);

  // Target switch drops the view and pending flags — a stale op's guarded
  // finally skips its busy clear, so the switch itself is what releases
  // the abandoned view's pending flag.
  useEffect(() => {
    setView(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey captures target
  }, [targetKey]);

  const apply = async (enabled: boolean) => {
    if (!target) return;
    const ticket = capture();
    setBusy(true);
    try {
      const result = await callSetWorkTracker({ schemaVersion: 1, target, enabled });
      if (!ticket.isCurrent()) return;
      setView(result.workTracker);
    } catch (error) {
      update({ lastError: errorMessage(error) }, target);
    } finally {
      if (ticket.isCurrent()) setBusy(false);
    }
  };

  return {
    view,
    busy,
    loadError,
    disabled: !target || busy,
    onToggle: (next: boolean) => void apply(next),
    refresh: () => { if (target) void load(target); },
    retryLoad: () => { if (target) void load(target); },
  };
}

// ---------------------------------------------------------------------------
// View — render-only. The hook above owns all state and handlers.
// ---------------------------------------------------------------------------

export type WorkTrackerCardState = ReturnType<typeof useWorkTrackerCard>;

export function WorkTrackerCard({ colors, target, tracker }: {
  colors: Colors;
  target: TargetValue | null;
  tracker: WorkTrackerCardState;
}) {
  const view = tracker.view;
  return (
    <Card
      colors={colors}
      title="Work tracker"
      subtitle="Beads (bd) — a durable per-repository issue graph SLP seats query for task state instead of rebuilding it from conversation. SLP detects bd, never installs or initializes it; the toggle writes slp-runtime/state/work-tracker.json and takes effect at the next session entry."
    >
      {tracker.loadError !== null ? (
        <View style={[styles.noticeBox, { borderColor: colors.statusDanger, backgroundColor: colors.surface2 }]} accessibilityLiveRegion="polite">
          <Text style={[styles.checkTitle, { color: colors.statusDanger }]}>Could not load work-tracker settings</Text>
          <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>{tracker.loadError}</Text>
          <View>
            <Button colors={colors} kind="primary" label="Retry" onPress={() => tracker.retryLoad()} />
          </View>
        </View>
      ) : view === null ? (
        <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]} accessibilityLiveRegion="polite">
          Loading work-tracker settings…
        </Text>
      ) : (
        <>
          <View style={[styles.cardHeadRow, { justifyContent: "space-between" }]}>
            <Text style={[styles.fieldLabel, { color: colors.foreground }]}>bd on daemon PATH</Text>
            {view.configured ? (
              <Badge
                colors={colors}
                label={view.enabled ? "Tracker enabled" : "Tracker disabled"}
                tone={view.enabled ? "good" : "draft"}
              />
            ) : null}
          </View>
          {view.bd !== null ? (
            <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
              {view.bd.version !== null ? `bd ${view.bd.version}` : "bd"} at {view.bd.path}
            </Text>
          ) : (
            <>
              <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>bd not found on daemon PATH</Text>
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                Install it yourself — SLP never installs it: brew install beads · npm i -g @beads/bd · or the upstream install.sh, then init the repository under your authority.
              </Text>
            </>
          )}
          {view.bdError !== null && view.bd !== null ? (
            <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>{view.bdError}</Text>
          ) : null}
          {view.error !== null ? (
            <Text style={[styles.mutedSmall, { color: colors.statusDanger }]} accessibilityLiveRegion="polite">
              setting error: {view.error}
            </Text>
          ) : null}
          <SwitchRow
            colors={colors}
            checked={view.enabled}
            disabled={tracker.disabled}
            onToggle={next => tracker.onToggle(next)}
            title="Use beads work tracker"
            hint="When on, managed sessions get a Work tracker pointer plus per-seat BEADS_ACTOR; seats probe `slp tracker` and treat a missing or uninitialized workspace as a recorded gap, never a block. Off preserves today's behavior exactly."
          />
          <View>
            <Button
              colors={colors}
              kind="ghost"
              label={tracker.busy ? "Working…" : "Refresh"}
              disabled={tracker.disabled}
              onPress={() => tracker.refresh()}
            />
          </View>
        </>
      )}
    </Card>
  );
}
