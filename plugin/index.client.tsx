// Client entry for the paseo-slp manager plugin (Option A v1, spec §2).
// Registers one management surface plus the sidebar/command entries that open
// it, and the supervision Command Center items + recipient-workspace bell;
// components receive host.id/host.label, never a daemon filesystem path.
import type { PluginClientContribution, PluginScreenProps } from "@getpaseo/plugin/client";
import { ManagerSurface } from "./client/ManagerSurface.tsx";
import { contributeSupervisionControls } from "./client/supervision-controls.ts";
import { SlpSidebarItem } from "./client/sidebar.tsx";
import { MANAGER_SCREEN_ID, managerLocation, managerTitle } from "./client/manager-navigation.ts";
import { WorkflowPanel } from "./client/workflow-panel.tsx";

// Host note: keep this a hoisted function declaration — the bundler's eager
// export interop resolves `export default const` to undefined at load time.
export default function contribute(client: Parameters<PluginClientContribution>[0]): ReturnType<PluginClientContribution> {
  const removers: (() => void | Promise<void>)[] = [];
  // Sequential registration permits rollback when a later host API rejects.
  // Start the bell (which owns a timer) only after static registrations succeed.
  const cleanup = async () => {
    const failures: unknown[] = [];
    for (const remove of removers.splice(0).reverse()) {
      try { await remove(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "SLP contribution cleanup failed");
  };
  function ManagerScreen(props: PluginScreenProps) {
    return <ManagerSurface {...props} onSectionChange={section => client.openScreen(managerLocation(section))} />;
  }
  try {
    removers.push(client.addScreen({ id: MANAGER_SCREEN_ID, title: managerTitle, Component: ManagerScreen }));
    removers.push(client.addSidebarHeaderItem({ id: "slp", title: "SLP", Component: SlpSidebarItem }));
    removers.push(client.addCommandCenterItem({
      id: "open-slp", title: "Open SLP Overview", icon: "Workflow", context: "global",
      keywords: ["slp", "supervisor", "lead", "peer", "providers", "hierarchy"],
      onSelect({ openScreen }) { openScreen(managerLocation()); },
    }));
    removers.push(client.addWorkspacePanel({ id: "slp-work", title: "SLP work", icon: "Workflow", context: "workspace", Component: WorkflowPanel }));
    removers.push(client.addCommandCenterItem({
      id: "open-slp-work", title: "Read SLP work", icon: "Workflow", context: "workspace",
      keywords: ["slp", "brief", "review", "decisions", "proof"],
      onSelect({ openPanel }) { openPanel("slp-work"); },
    }));
    removers.push(contributeSupervisionControls(client));
  } catch (error) {
    // Invoke every acquired remover immediately; observe async failures without
    // masking the original registration error. No timer exists at this point.
    for (const remove of removers.splice(0).reverse()) {
      try { void Promise.resolve(remove()).catch(cause => console.error("SLP registration rollback failed", cause)); }
      catch (cause) { console.error("SLP registration rollback failed", cause); }
    }
    throw error;
  }
  return cleanup;
}
