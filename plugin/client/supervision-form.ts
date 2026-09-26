// Pure supervision-card view model (no React) — the card's editable draft,
// its conversion to/from the stored schema-2 config, agent-picker
// candidates, plain-English status/reason text and the findings summary.
// Kept import-light so tests exercise it directly.
//
// The card offers two scopes instead of raw routes:
//   all      → daemon defaults observe every discovered SLP Lead; unchecked
//              Leads become explicit `off` routes (an explicit off wins).
//   selected → defaults off; each checked Lead becomes an explicit route.
// One mode (record only / record and alert) and one Supervisor apply to the
// whole selection. Stored routes the two scopes cannot express (another
// mode, Supervisor or delay) are kept verbatim as `kept` and reported, so a
// save never silently rewrites a Lead the Human did not touch.
import {
  SUPERVISION_CONFIDENCE_DEFAULT,
  SUPERVISION_CONFIDENCE_MAX,
  SUPERVISION_CONFIDENCE_MIN,
  SUPERVISION_PENDING_DELAY_DEFAULT_MS,
  SUPERVISION_PENDING_DELAY_MAX_MS,
  isActiveAgentStatus,
  roleFromProviderId,
} from "../shared/supervision.ts";
import type {
  GetSupervisionResult,
  SupervisionConfig,
  SupervisionMigration,
  SupervisionObservation,
  SupervisionRoute,
} from "../shared/supervision.ts";

export type LeadPick = { agentId: string; workspaceId: string };
export type SupervisorPick = { agentId: string; workspaceId: string | null };

export type SupervisionForm = {
  scope: "all" | "selected";
  mode: "shadow" | "notify";
  supervisor: SupervisorPick | null;
  /** scope "selected": the Leads observed. */
  selected: LeadPick[];
  /** scope "all": the Leads left out (stored as explicit off routes). */
  excluded: LeadPick[];
  /** Stored routes the scopes cannot express — saved back unchanged. */
  kept: SupervisionRoute[];
  confidenceThreshold: string;
  /** Checkpoint before brief/handback alerts, in seconds (stored as ms). */
  delaySeconds: string;
};

const secondsOf = (ms: number): string => String(ms / 1000);

export const emptySupervisionForm = (): SupervisionForm => ({
  scope: "selected",
  mode: "shadow",
  supervisor: null,
  selected: [],
  excluded: [],
  kept: [],
  confidenceThreshold: String(SUPERVISION_CONFIDENCE_DEFAULT),
  delaySeconds: secondsOf(SUPERVISION_PENDING_DELAY_DEFAULT_MS),
});

const supervisorOfRoute = (route: SupervisionRoute): SupervisorPick | null =>
  route.supervisorAgentId === null ? null : { agentId: route.supervisorAgentId, workspaceId: route.supervisorWorkspaceId };

/** Stored config → draft. An absent/empty config reads as "selected, none"
 *  — observing nothing, which is what the store says. */
export function formFromConfig(config: SupervisionConfig | null): SupervisionForm {
  if (config === null) return emptySupervisionForm();
  const base = { ...emptySupervisionForm(), confidenceThreshold: String(config.confidenceThreshold) };
  const { defaults } = config;
  if (defaults.mode !== "off") {
    const excluded: LeadPick[] = [];
    const kept: SupervisionRoute[] = [];
    for (const route of config.routes) {
      if (route.mode === "off") excluded.push({ agentId: route.leadAgentId, workspaceId: route.leadWorkspaceId });
      else kept.push(route);
    }
    return {
      ...base,
      scope: "all",
      mode: defaults.mode,
      supervisor: defaults.supervisorAgentId === null ? null
        : { agentId: defaults.supervisorAgentId, workspaceId: defaults.supervisorWorkspaceId },
      excluded,
      kept,
      delaySeconds: secondsOf(defaults.pendingDelayMs),
    };
  }
  // Defaults off: the active routes are the selection. The first active
  // route sets the shared mode/Supervisor/delay; routes that differ are kept.
  const active = config.routes.filter(route => route.mode !== "off");
  const lead = active[0];
  if (lead === undefined) {
    return {
      ...base,
      supervisor: defaults.supervisorAgentId === null ? null
        : { agentId: defaults.supervisorAgentId, workspaceId: defaults.supervisorWorkspaceId },
      delaySeconds: secondsOf(defaults.pendingDelayMs),
    };
  }
  const selected: LeadPick[] = [];
  const kept: SupervisionRoute[] = [];
  for (const route of active) {
    const same = route.mode === lead.mode && route.supervisorAgentId === lead.supervisorAgentId &&
      route.pendingDelayMs === lead.pendingDelayMs;
    if (same) selected.push({ agentId: route.leadAgentId, workspaceId: route.leadWorkspaceId });
    else kept.push(route);
  }
  return {
    ...base,
    scope: "selected",
    mode: lead.mode === "notify" ? "notify" : "shadow",
    supervisor: supervisorOfRoute(lead),
    selected,
    kept,
    delaySeconds: secondsOf(lead.pendingDelayMs),
  };
}

const delayMsOf = (text: string): number | null => {
  const seconds = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(seconds)) return null;
  const ms = Math.round(seconds * 1000);
  return ms >= 0 && ms <= SUPERVISION_PENDING_DELAY_MAX_MS ? ms : null;
};

/** Draft → the whole config the card saves. Supervisor workspace comes from
 *  the picker; the server replaces it whenever it can refresh the agent. */
export function configFromForm(form: SupervisionForm): { config: SupervisionConfig } | { error: string } {
  const threshold = Number(form.confidenceThreshold.trim());
  if (form.confidenceThreshold.trim() === "" || !Number.isFinite(threshold) ||
      threshold < SUPERVISION_CONFIDENCE_MIN || threshold > SUPERVISION_CONFIDENCE_MAX) {
    return { error: `Confidence must be a number from ${SUPERVISION_CONFIDENCE_MIN} to ${SUPERVISION_CONFIDENCE_MAX}.` };
  }
  const delayMs = delayMsOf(form.delaySeconds);
  if (delayMs === null) return { error: `Wait before alerting must be 0 to ${SUPERVISION_PENDING_DELAY_MAX_MS / 1000} seconds.` };
  if (form.mode === "notify" && form.supervisor === null) {
    return { error: "Choose the Supervisor who should receive alerts." };
  }
  // Record only saves no recipient: a Supervisor the Human cannot see in
  // the card must never make a save fail (the picker keeps the draft
  // choice while the card stays open).
  const supervisorId = form.mode === "notify" ? form.supervisor?.agentId ?? null : null;
  const supervisorWorkspaceId = supervisorId === null ? null : form.supervisor?.workspaceId ?? null;
  // "selected" with nothing checked is a valid save — it watches nothing.
  const picks = form.scope === "all" ? form.excluded : form.selected;
  const touched = new Set(picks.map(pick => pick.agentId));
  if (supervisorId !== null && form.scope === "selected" && touched.has(supervisorId)) {
    return { error: "The Supervisor cannot also be one of the watched Leads." };
  }
  const routes: SupervisionRoute[] = picks.map(pick => form.scope === "all"
    ? { leadAgentId: pick.agentId, leadWorkspaceId: pick.workspaceId, supervisorAgentId: null, supervisorWorkspaceId: null, mode: "off", pendingDelayMs: delayMs }
    : { leadAgentId: pick.agentId, leadWorkspaceId: pick.workspaceId, supervisorAgentId: supervisorId, supervisorWorkspaceId, mode: form.mode, pendingDelayMs: delayMs });
  for (const route of form.kept) if (!touched.has(route.leadAgentId)) routes.push(route);
  return {
    config: {
      schemaVersion: 3,
      confidenceThreshold: threshold,
      defaults: form.scope === "all"
        ? { mode: form.mode, supervisorAgentId: supervisorId, supervisorWorkspaceId, pendingDelayMs: delayMs }
        : { mode: "off", supervisorAgentId: null, supervisorWorkspaceId: null, pendingDelayMs: delayMs },
      routes,
    },
  };
}

/** Whether a Lead row is checked in the current scope. */
export const leadChecked = (form: SupervisionForm, agentId: string): boolean =>
  form.scope === "all"
    ? !form.excluded.some(pick => pick.agentId === agentId)
    : form.selected.some(pick => pick.agentId === agentId);

/** Toggle a Lead row. A kept (custom) route for that Lead is replaced by
 *  the standard choice — the Human touched it. */
export function toggleLead(form: SupervisionForm, pick: LeadPick, checked: boolean): SupervisionForm {
  const kept = form.kept.filter(route => route.leadAgentId !== pick.agentId);
  const without = (list: LeadPick[]) => list.filter(item => item.agentId !== pick.agentId);
  if (form.scope === "all") {
    return { ...form, kept, excluded: checked ? without(form.excluded) : [...without(form.excluded), pick] };
  }
  return { ...form, kept, selected: checked ? [...without(form.selected), pick] : without(form.selected) };
}

/** Migration "Restore": the routes (and schema-2 defaults) the migration
 *  turned off, with their previous mode, as a draft the Human still has to
 *  save after reading the current disclosure. */
export function restoreMigration(config: SupervisionConfig | null, migration: SupervisionMigration): SupervisionForm {
  const previous = new Map(migration.disabledRoutes.map(route => [route.leadAgentId, route.previousMode]));
  const base: SupervisionConfig = config ?? { schemaVersion: 3, confidenceThreshold: SUPERVISION_CONFIDENCE_DEFAULT, defaults: { mode: "off", supervisorAgentId: null, supervisorWorkspaceId: null, pendingDelayMs: SUPERVISION_PENDING_DELAY_DEFAULT_MS }, routes: [] };
  return formFromConfig({
    ...base,
    defaults: migration.disabledDefaults === null ? base.defaults : { ...base.defaults, mode: migration.disabledDefaults.previousMode },
    routes: base.routes.map(route => {
      const mode = previous.get(route.leadAgentId);
      return mode === undefined ? route : { ...route, mode };
    }),
  });
}

// ---------------------------------------------------------------------------
// Agent pickers — candidates come from the app's own agent list
// (paseo.agents.list({ scope: "active" })), so the Human picks a thread by
// name instead of typing an id. The server re-verifies on save.
// ---------------------------------------------------------------------------

/** The structural subset of an agent-directory entry the pickers read. */
export type AgentDirectoryEntry = {
  agent: {
    id: string;
    provider: string;
    status: string;
    title?: string | null;
    workspaceId?: string;
    archivedAt?: string | null;
    labels?: Record<string, string>;
  };
  project?: { projectName?: string; workspaceName?: string | null } | null;
};

export type AgentChoice = {
  agentId: string;
  workspaceId: string | null;
  role: "lead" | "supervisor" | "peer";
  title: string;
  detail: string;
  status: string;
};

export const shortId = (id: string): string => id.length > 13 ? `${id.slice(0, 8)}…` : id;

/** SLP agents from the directory, grouped by role, newest-listed order kept. */
export function agentChoices(entries: readonly AgentDirectoryEntry[]): AgentChoice[] {
  const out: AgentChoice[] = [];
  for (const entry of entries) {
    const { agent } = entry;
    if (agent.archivedAt != null) continue;
    const role = roleFromProviderId(agent.provider);
    if (role !== "lead" && role !== "supervisor" && role !== "peer") continue;
    const place = [entry.project?.projectName, entry.project?.workspaceName].filter(part => typeof part === "string" && part !== "");
    out.push({
      agentId: agent.id,
      workspaceId: typeof agent.workspaceId === "string" && agent.workspaceId !== "" ? agent.workspaceId : null,
      role,
      title: typeof agent.title === "string" && agent.title.trim() !== "" ? agent.title.trim() : `${role} ${shortId(agent.id)}`,
      detail: [...place, agent.status].join(" · "),
      status: agent.status,
    });
  }
  return out;
}

/** Lead rows: every listed SLP Lead plus configured Leads the list does not
 *  show (archived, another host, or hidden from this client). */
export function leadRows(choices: readonly AgentChoice[], form: SupervisionForm): (AgentChoice & { listed: boolean; custom: boolean })[] {
  const custom = new Set(form.kept.map(route => route.leadAgentId));
  const rows = choices.filter(choice => choice.role === "lead")
    .map(choice => ({ ...choice, listed: true, custom: custom.has(choice.agentId) }));
  const listed = new Set(rows.map(row => row.agentId));
  const extra: LeadPick[] = [
    ...form.selected, ...form.excluded,
    ...form.kept.map(route => ({ agentId: route.leadAgentId, workspaceId: route.leadWorkspaceId })),
  ];
  for (const pick of extra) {
    if (listed.has(pick.agentId)) continue;
    listed.add(pick.agentId);
    rows.push({
      agentId: pick.agentId, workspaceId: pick.workspaceId, role: "lead",
      title: `Lead ${shortId(pick.agentId)}`, detail: "not in this app's agent list", status: "unknown",
      listed: false, custom: custom.has(pick.agentId),
    });
  }
  return rows;
}

/** Supervisor rows: active SLP Supervisors plus the chosen one if unlisted. */
export function supervisorRows(choices: readonly AgentChoice[], form: SupervisionForm): (AgentChoice & { listed: boolean })[] {
  const rows = choices.filter(choice => choice.role === "supervisor" && isActiveAgentStatus(choice.status))
    .map(choice => ({ ...choice, listed: true }));
  const chosen = form.supervisor;
  if (chosen !== null && !rows.some(row => row.agentId === chosen.agentId)) {
    rows.push({
      agentId: chosen.agentId, workspaceId: chosen.workspaceId, role: "supervisor",
      title: `Supervisor ${shortId(chosen.agentId)}`, detail: "not in this app's agent list", status: "unknown", listed: false,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Plain-English text
// ---------------------------------------------------------------------------

const REASONS: Record<string, string> = {
  // gate / route
  "jev-capability-off": "Supervision is switched off",
  "jev-disabled": "Jev is disabled",
  "jev-unconfigured": "Jev is not set up",
  "jev-config-invalid": "Jev settings have a problem",
  "jev-config-unreadable": "Jev settings cannot be read",
  "jev-key-missing": "No Jev key is stored",
  "jev-key-invalid": "The Jev key is not valid",
  "jev-key-unreadable": "The Jev key file cannot be read",
  "jev-key-permissions": "The Jev key file is readable by other users (run chmod 600)",
  "jev-provider-unsupported": "This Jev provider is not supported",
  "lead-not-seen-yet": "Waiting to see this Lead — it starts when the Lead's next turn begins",
  "lead-workspace-mismatch": "This Lead is now in a different workspace — pick it again",
  "lead-archived": "The Lead was archived",
  "lead-inactive": "The Lead is no longer active",
  "peer-archived": "The Peer was archived",
  "peer-inactive": "The Peer is no longer active",
  "route-removed": "The Lead is no longer watched",
  "config-invalid": "The supervision settings file has a problem",
  "capture-paused": "Paused while Jev was unavailable",
  // evidence
  "unsupported-family": "This agent family's messages cannot be read yet",
  "family-shape-unverified": "This agent family's message format is not verified yet",
  "brief-missing": "The Lead's brief to the Peer was not visible",
  "brief-references-assignment-file": "The brief only pointed to a file",
  "brief-source-ambiguous": "The brief could not be identified",
  "handback-missing": "The Peer's hand-back was not visible",
  "brief-unverified": "The brief could not be read reliably for this agent family",
  "handback-unverified": "The hand-back could not be read reliably for this agent family",
  "brief-unobservable": "The hand-back cannot be judged without a readable brief",
  "turn-boundary-unverified": "The start of the Peer's turn could not be found",
  "role-prefix-unrecognized": "The brief's format was not recognized",
  "send-result-contradictory": "A message reported both success and failure",
  "lead-provider-unknown": "The Lead's agent family could not be confirmed",
  "peer-turn-not-completed": "The Peer's turn did not finish",
  "lead-turn-not-completed": "The Lead's turn did not finish",
  "send-not-completed": "A message send did not finish",
  "send-input-unparsed": "A message could not be read",
  "send-result-unobservable": "Could not confirm a message was delivered",
  "send-coverage-unverified": "This agent family does not expose verifiable send receipts",
  "send-result-unsuccessful": "A message failed to send",
  "send-shape-unverified": "A message format is not verified yet",
  "recipient-refresh-failed": "Could not check who a message went to",
  "recipient-inactive": "A message went to an inactive agent",
  "lead-start-unmatched": "The order of the Lead's messages is unclear",
  "report-route-unverifiable": "The report route cannot be checked",
  "other-room-bodies-omitted": "Too much text to include messages to other Peers",
  "no-observable-communication": "No communication was visible",
  "queue-overflow": "Too many events at once — some were skipped",
  "case-ceiling": "Too many open cases — this one was skipped",
  "evidence-oversize": "The conversation was too large to assess",
  "assessment-ceiling": "Assessment limit reached for this case",
  "case-expired": "Expired before it could be assessed",
  "credential-shaped-content": "Skipped because the text looked like a secret",
  "jev-redacted": "Skipped because the text looked like a secret",
  "jev-request-failed": "The Jev request failed",
  "jev-response-invalid": "Jev returned an unusable answer",
  "assessment-inconclusive": "Jev was not confident enough",
  "handling-pending": "The Lead has not dealt with the hand-back yet",
  // delivery
  "recipient-running": "Waiting — the Supervisor is busy",
  "recipient-archived": "The Supervisor was archived",
  "recipient-not-found": "The Supervisor was not found",
  "recipient-not-slp-supervisor": "The chosen agent is not an SLP Supervisor",
  "recipient-mismatch": "The Supervisor changed",
  "route-changed-before-dispatch": "Settings changed before the alert was sent",
  "delivery-already-attempted": "An alert was already attempted",
  "delivery-attempt-ceiling": "Alert limit reached for this case",
  "delivery-store-corrupt": "The alert history file is damaged — alerts are blocked",
  "delivery-store-unreadable": "The alert history file cannot be read — alerts are blocked",
  "delivery-store-write-failed": "The alert history could not be saved — alerts are blocked",
  "delivery-store-full": "The alert history is full — alerts are blocked",
  "send-failed": "The alert failed to send",
  "send-timeout": "The alert timed out",
  "stopped-during-send": "Stopped while sending the alert",
  "sdk-failure": "The host call failed",
  "sdk-timeout": "The host call timed out",
  "sdk-unavailable": "The host connection was unavailable",
};

/** A reason code in plain English (unknown codes are de-hyphenated). */
export function describeReason(code: string | null): string {
  if (code === null || code === "") return "No reason recorded";
  if (REASONS[code] !== undefined) return REASONS[code];
  if (code.startsWith("notify-")) return describeReason(code.slice("notify-".length));
  const text = code.replace(/-/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const AXIS_TEXT = {
  brief: "The Lead's brief to the Peer looks incomplete",
  handback: "The Peer's hand-back looks incomplete",
  handling: "The Lead did not deal with the Peer's hand-back",
} as const;
export const describeAxis = (axis: "brief" | "handback" | "handling"): string => AXIS_TEXT[axis];

const DELIVERY_TEXT: Record<string, string> = {
  reserved: "Alert being sent",
  accepted: "Supervisor alerted",
  uncertain: "Alert may not have arrived",
  deferred: "Alert waiting",
  canceled: "Alert canceled",
  blocked: "Alert blocked",
};

const NOT_A_HANDLING_GAP: ReadonlySet<string> = new Set([
  "assessment-inconclusive", "assessment-ceiling", "jev-request-failed", "jev-response-invalid",
  "credential-shaped-content", "case-expired", "route-removed", "config-invalid",
  "lead-archived", "peer-archived", "lead-inactive", "peer-inactive",
]);

export type FindingsSummary = {
  issues: {
    fingerprint: string;
    leadAgentId: string;
    peerId: string;
    at: string;
    problems: string[];
    delivery: string | null;
  }[];
  okCount: number;
  inProgress: number;
  unassessed: { label: string; count: number }[];
};

/** Recent cases as the Human reads them: open issues first, then counts. */
export function summarizeObservations(observations: readonly SupervisionObservation[] | null): FindingsSummary {
  const summary: FindingsSummary = { issues: [], okCount: 0, inProgress: 0, unassessed: [] };
  const unassessed = new Map<string, number>();
  for (const entry of observations ?? []) {
    const open = entry.findings.filter(finding => finding.status === "open");
    if (open.length > 0) {
      summary.issues.push({
        fingerprint: entry.fingerprint,
        leadAgentId: entry.leadAgentId,
        peerId: entry.peerId,
        at: entry.updatedAt,
        problems: open.map(finding => describeAxis(finding.axis)),
        delivery: entry.delivery === null ? null
          : `${DELIVERY_TEXT[entry.delivery.state] ?? entry.delivery.state}${entry.delivery.reason !== null ? ` — ${describeReason(entry.delivery.reason)}` : ""}`,
      });
    } else if (entry.state === "observed") {
      summary.inProgress += 1;
    } else if (entry.state === "unknown") {
      // Jev assessed the case but it still closed unknown on a handling gate:
      // say which part was judged instead of labelling the whole case (or
      // the whole agent family) unsupported.
      const assessed = entry.lastAssessment !== null && entry.lastAssessment !== undefined;
      const handlingGap = assessed && entry.reason !== null && !NOT_A_HANDLING_GAP.has(entry.reason);
      const label = handlingGap
        ? `Assessed with no finding; the Lead's handling could not be judged — ${describeReason(entry.reason)}`
        : describeReason(entry.reason);
      unassessed.set(label, (unassessed.get(label) ?? 0) + 1);
    } else {
      summary.okCount += 1;
    }
  }
  summary.unassessed = [...unassessed].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  return summary;
}

export type JevReadiness = { ready: true } | { ready: false; why: string };

/** Whether the Jev setup can back supervision (saved view only). */
export function jevReadiness(view: {
  configured: boolean; enabled: boolean | null; provider: unknown; hasKey: boolean;
  keyPermissionsOk: boolean | null; error: string | null;
} | null): JevReadiness {
  if (view === null) return { ready: false, why: "Loading Jev settings…" };
  if (view.error !== null) return { ready: false, why: "Jev settings have a problem — fix them in the Jev card above." };
  if (!view.configured || view.provider === null) return { ready: false, why: "Set up Jev in the card above first." };
  if (view.enabled !== true) return { ready: false, why: "Enable Jev in the card above first." };
  if (!view.hasKey) return { ready: false, why: "Save a Jev key in the card above first." };
  if (view.keyPermissionsOk === false) return { ready: false, why: "The Jev key file is readable by other users — run chmod 600 on it." };
  return { ready: true };
}

/** One sentence for the top of the card — derived from SAVED state only. */
export function statusLine(input: {
  jev: JevReadiness;
  capabilityOn: boolean;
  data: GetSupervisionResult | null;
  names: (agentId: string) => string;
}): { text: string; tone: "good" | "neutral" | "warn" | "bad" } {
  const { jev, capabilityOn, data, names } = input;
  if (!jev.ready) return { text: `Off — ${jev.why}`, tone: "neutral" };
  if (!capabilityOn) return { text: "Off — nothing is watched or sent to Jev.", tone: "neutral" };
  if (data === null) return { text: "On — loading settings…", tone: "neutral" };
  if (data.config === null) return { text: "Off — the settings file has a problem (see below).", tone: "bad" };
  const config = data.config;
  const alerting = (mode: string, supervisorId: string | null) =>
    mode === "notify" && supervisorId !== null ? `alerts go to ${names(supervisorId)}` : "findings are recorded only";
  const paused = Object.values(data.gates ?? {}).filter(reason => reason !== null).length;
  const pausedText = paused > 0 ? ` ${paused} Lead${paused === 1 ? " is" : "s are"} waiting or paused.` : "";
  if (config.defaults.mode !== "off") {
    const left = config.routes.filter(route => route.mode === "off").length;
    return {
      text: `On — watching all SLP Leads${left > 0 ? ` except ${left}` : ""}; ${alerting(config.defaults.mode, config.defaults.supervisorAgentId)}.${pausedText}`,
      tone: paused > 0 ? "warn" : "good",
    };
  }
  const active = config.routes.filter(route => route.mode !== "off");
  if (active.length === 0) return { text: "On, but no Leads are selected — nothing is being watched.", tone: "warn" };
  const first = active[0] as SupervisionRoute;
  return {
    text: `On — watching ${active.length === 1 ? names(first.leadAgentId) : `${active.length} Leads`}; ${alerting(first.mode, first.supervisorAgentId)}.${pausedText}`,
    tone: paused > 0 ? "warn" : "good",
  };
}

/** Server/host errors the Human can act on, in plain English. The raw
 *  message stays available to the shell's lastError. */
export function translateError(message: string): string {
  if (/changed since|changed during/i.test(message)) {
    return "Someone else changed these settings. Reload to get the latest version, then make your change again.";
  }
  if (/not the daemon home this plugin serves|cannot verify the selected target/i.test(message)) {
    return "This Manager is pointed at a different Paseo home than the one running the plugin, so supervision settings cannot be changed here.";
  }
  if (/Agent not found/i.test(message)) {
    return "The host did not return that agent to the plugin. It may have been archived, or this Paseo version hides it from plugins. Nothing was saved.";
  }
  if (/is archived/i.test(message)) return "One of the chosen agents is archived. Pick another one. Nothing was saved.";
  if (/slp-<family>-supervisor/i.test(message)) return "The chosen alert recipient is not an SLP Supervisor. Nothing was saved.";
  if (/slp-<family>-lead/i.test(message)) return "One of the chosen Leads is not an SLP Lead. Nothing was saved.";
  if (/workspace binding is exact|in workspace/i.test(message)) {
    return "A chosen Lead has moved to another workspace. Refresh the list and pick it again. Nothing was saved.";
  }
  if (/an active agent/i.test(message)) return "One of the chosen agents is not active. Nothing was saved.";
  if (/supervision\.json is broken|failed schema validation|not valid JSON/i.test(message)) {
    return "The supervision settings file is damaged. Saving here replaces it with the settings shown.";
  }
  return message;
}
