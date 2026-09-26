// Supervision header bell (upstream parity: a bell in the notification
// recipient's workspace). All settings live in the Manager's Supervision
// card; the bell only opens it or turns alerts off. Writes go through the
// server-side CAS writer (state.ts commit); the client holds no routing
// state of its own — the bell is re-derived from the served daemon's stored
// config on load, after local changes, and on a slow poll so another
// client's change converges.
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { disableSupervisionNotifications, getSupervisionStatus } from "../shared/supervision.ts";

export const SUPERVISION_BELL_POLL_MS = 60_000;

const listeners = new Set<() => void>();
/** Local change signal (Manager save/reload, bell actions) — refreshes the
 *  bell immediately instead of waiting for the poll. */
export function notifySupervisionChanged(): void {
  for (const listener of listeners) listener();
}

type Registration = { remove(): void };

export function contributeSupervisionControls(client: PluginClientContext): () => void {
  let disposed = false;
  const bells = new Map<string, Registration>(); // workspaceId → bell

  const disable = async (): Promise<void> => {
    await client.rpc(disableSupervisionNotifications, { schemaVersion: 2 });
    notifySupervisionChanged();
  };

  const addBell = (workspaceId: string): Registration => client.addHeaderButton({
    id: "slp-supervision-recipient",
    workspaceId,
    button: {
      title: "SLP Supervisor alerts",
      icon: "Bell",
      behavior: {
        kind: "menu",
        items: [
          {
            kind: "item", id: "settings", title: "Open supervision settings", icon: "Settings",
            behavior: { kind: "action", onPress() { client.openSurface("manager"); } },
          },
          { kind: "separator", id: "separator" },
          {
            kind: "item", id: "disable", title: "Turn off alerts", icon: "BellOff",
            behavior: { kind: "action", onPress: disable },
          },
        ],
      },
    },
  });

  // The bell mirrors the stored notify recipients; a failed read leaves the
  // current bells (no flicker on a transient RPC error).
  const refresh = async (): Promise<void> => {
    let status;
    try {
      status = await client.rpc(getSupervisionStatus, { schemaVersion: 2 });
    } catch {
      return;
    }
    if (disposed) return;
    const wanted = new Set(status.error === null ? status.recipients.map(recipient => recipient.workspaceId) : []);
    for (const [workspaceId, bell] of bells) {
      if (!wanted.has(workspaceId)) { bell.remove(); bells.delete(workspaceId); }
    }
    for (const workspaceId of wanted) {
      if (!bells.has(workspaceId)) bells.set(workspaceId, addBell(workspaceId));
    }
  };
  const onChange = () => { void refresh(); };
  listeners.add(onChange);

  const poll = setInterval(onChange, SUPERVISION_BELL_POLL_MS);
  void refresh();
  return () => {
    disposed = true;
    clearInterval(poll);
    listeners.delete(onChange);
    for (const bell of bells.values()) bell.remove();
    bells.clear();
  };
}
