import { useEffect, useState } from "react";
import { useAgent } from "@getpaseo/plugin/client";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { Button, styles } from "./ui-kit.tsx";
import type { Colors } from "./ui-kit.tsx";
import { useTargetLifetime } from "./target-async.ts";
import { errorMessage } from "./manager-state.ts";

/** Opens the recorded owner on the selected host. A title is display data,
 * never evidence of membership, liveness, responsibility or acceptance. */
export function OwnerLink({ colors, hostId, agentId, navigation }: {
  colors: Colors; hostId: string; agentId: string; navigation?: PluginWorkspacePanelProps["navigation"];
}) {
  const title = useAgent(agentId, agent => agent.title);
  const capture = useTargetLifetime(JSON.stringify([hostId, agentId]));
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setNotice(null); setError(null); }, [hostId, agentId]);
  const copy = async () => {
    const ticket = capture();
    try {
      await copyText(agentId);
      if (ticket.isCurrent()) { setNotice("Owner ID copied"); setError(null); }
    } catch (cause) {
      if (ticket.isCurrent()) setError(errorMessage(cause));
    }
  };
  const open = () => {
    try { navigation?.openAgent({ agentId, serverId: hostId }); }
    catch (cause) { setError(`Could not open owner chat: ${errorMessage(cause)}`); }
  };
  return <View style={{ gap: 6 }}>
    <Text selectable style={[styles.muted, { color: colors.foreground }]}>Owner · {title || agentId}</Text>
    <View style={styles.chipRow}>
      {navigation?.openAgent ? <Button colors={colors} label="Open owner chat" onPress={open} /> : null}
      <Button colors={colors} label="Copy owner ID" onPress={() => { void copy(); }} />
    </View>
    {!navigation?.openAgent ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Chat navigation is unavailable on this client. Copy the owner ID to find the chat.</Text> : null}
    {notice ? <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>{notice}</Text> : null}
    {error ? <Text selectable style={[styles.mutedSmall, { color: colors.statusDanger }]}>{error}</Text> : null}
  </View>;
}
