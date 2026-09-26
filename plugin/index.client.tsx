// Client entry for the paseo-slp manager plugin (Option A v1, spec §2).
// Registers one management surface plus the sidebar/command entries that open
// it, and the supervision Command Center items + recipient-workspace bell;
// components receive host.id/host.label, never a daemon filesystem path.
import type { PluginClientContribution } from "@getpaseo/plugin/client";
import { ManagerSurface } from "./client/ManagerSurface.tsx";
import { contributeSupervisionControls } from "./client/supervision-controls.ts";

// Host note: keep this a hoisted function declaration — the bundler's eager
// export interop resolves `export default const` to undefined at load time.
export default function contribute(client: Parameters<PluginClientContribution>[0]): ReturnType<PluginClientContribution> {
  const removers = [
    client.addSurface("manager", ManagerSurface),
    client.addSidebarItem({ id: "slp", title: "SLP", icon: "Workflow", surface: "manager" }),
    client.addCommandCenterItem({
      id: "open-slp",
      title: "Open SLP manager",
      icon: "Workflow",
      context: "global",
      keywords: ["slp", "supervisor", "lead", "peer", "providers", "hierarchy"],
      onSelect({ openSurface }) { openSurface("manager"); },
    }),
    contributeSupervisionControls(client),
  ];
  return () => { for (const remove of removers) void remove(); };
}
