import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { localTarget, status } from "../shared/contracts.ts";
import type { StatusResult } from "../shared/contracts.ts";
import { errorMessage } from "./manager-state.ts";
import { managerLocation, MANAGER_SCREEN_ID } from "./manager-navigation.ts";
import { RuntimeIdentity } from "./runtime-overview.tsx";
import { Button, focusRing, StatePill, styles } from "./ui-kit.tsx";
import type { ControlState } from "./ui-kit.tsx";
import { useTargetLifetime } from "./target-async.ts";

/** Only mounted popovers read. No global sidebar poll or workspace totals. */
export function RuntimePopover({ host, theme, layout, openScreen, close }: PluginPopoverProps) {
  const callLocalTarget = useRpc(localTarget), callStatus = useRpc(status);
  const capture = useTargetLifetime(host.id);
  const sequence = useRef(0);
  const [read, setRead] = useState<{ home: string; result: StatusResult | null; loading: boolean; error: string | null }>(
    { home: "", result: null, loading: true, error: null });
  const refresh = useCallback(async () => {
    const ticket = capture(), issued = ++sequence.current;
    setRead({ home: "", result: null, loading: true, error: null });
    try {
      const detected = await callLocalTarget({ schemaVersion: 1 });
      if (!ticket.isCurrent() || issued !== sequence.current) return;
      const result = await callStatus({ schemaVersion: 1, target: { hostId: host.id, daemonHome: detected.daemonHome } });
      if (ticket.isCurrent() && issued === sequence.current) setRead({ home: detected.daemonHome, result, loading: false, error: null });
    } catch (error) {
      if (ticket.isCurrent() && issued === sequence.current) setRead({ home: "", result: null, loading: false, error: errorMessage(error) });
    }
    // RPC identity is host-owned; host/session changes invalidate the ticket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.id, capture]);
  useEffect(() => { void refresh(); }, [refresh]);
  const colors = theme.colors;
  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 12 }}>
    <Text style={[styles.cardTitle, { color: colors.foreground }]}>SLP on {host.label}</Text>
    {read.loading ? <Text style={[styles.muted, { color: colors.foregroundMuted }]}>Reading runtime…</Text> : null}
    {read.error ? <Text selectable style={[styles.muted, { color: colors.statusDanger }]}>Runtime unavailable: {read.error}. Refresh to retry.</Text> : null}
    <StatePill colors={colors} state={read.result?.state ?? null} />
    <RuntimeIdentity colors={colors} home={read.home} statusView={read.result} />
    {read.result ? <Text style={[styles.muted, { color: colors.foregroundMuted }]}>
      {read.result.conflicts.length} runtime conflict{read.result.conflicts.length === 1 ? "" : "s"} in this status read. Open Overview for details.
    </Text> : null}
    <View style={styles.chipRow}>
      <Button colors={colors} label="Open Overview" onPress={() => openScreen(managerLocation())} />
      <Button colors={colors} label="Refresh runtime" disabled={read.loading} onPress={() => { void refresh(); }} />
      <Button colors={colors} label="Close" onPress={close} />
    </View>
  </ScrollView>;
}

export function SlpSidebarItem({ currentScreen, openScreen, openPopover, theme }: PluginSidebarItemProps) {
  const size = 32;
  return <SidebarRow icon="Workflow" active={currentScreen?.screenId === MANAGER_SCREEN_ID}
    onPress={() => openScreen(managerLocation())}
    trailing={<Pressable accessibilityRole="button" accessibilityLabel="Quick view SLP runtime"
      accessibilityHint="Open runtime details for this host" focusable
      hitSlop={6} onPress={() => openPopover(RuntimePopover)}
      style={(state: ControlState) => [
        { width: size, height: size, borderRadius: 8, alignItems: "center", justifyContent: "center" },
        (state.hovered || state.focused) && { backgroundColor: theme.colors.surface2 },
        state.focused && focusRing(theme.colors),
        state.pressed && { opacity: 0.7 },
      ]}>
      <Icon name="Info" size={16} color={theme.colors.foregroundMuted} />
    </Pressable>} />;
}
