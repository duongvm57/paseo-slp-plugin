// Supervision-card ownership: the card owns the stored config snapshot, the
// editable draft (which Leads, what happens on a finding, advanced
// thresholds), load/save/reload with the raw-file CAS token, the agent
// pickers and the findings readout — the same discipline as the peer-pool
// card (spec docs/spec/supervision-integration.md §Configuration and
// authority, §Manager). The on/off switch is the Jev supervision capability,
// written through the Jev card hook from the SAVED Jev view. The shell
// supplies the target, its stale-guard predicate, the RPC callers, the Jev
// card state and client navigation. The header bell
// (supervision-controls.ts) writes through the same server-side CAS writer
// and opens the Manager.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { usePaseo } from "@getpaseo/plugin/client";
import type { TargetValue } from "../../shared/contracts.ts";
import { SUPERVISION_CONFIDENCE_MAX, SUPERVISION_CONFIDENCE_MIN, SUPERVISION_PENDING_DELAY_MAX_MS } from "../../shared/supervision.ts";
import type {
  GetSupervisionRequest,
  GetSupervisionResult,
  SetSupervisionRequest,
  SetSupervisionResult,
  SupervisionMigration,
  SupervisionObservation,
  SupervisionUnverified,
} from "../../shared/supervision.ts";
import { errorMessage } from "../manager-state.ts";
import { notifySupervisionChanged } from "../supervision-controls.ts";
import {
  agentChoices,
  configFromForm,
  describeReason,
  emptySupervisionForm,
  formFromConfig,
  jevReadiness,
  leadChecked,
  leadRows,
  restoreMigration,
  shortId,
  statusLine,
  summarizeObservations,
  supervisorRows,
  toggleLead,
  translateError,
} from "../supervision-form.ts";
import type { AgentChoice, AgentDirectoryEntry, SupervisionForm } from "../supervision-form.ts";
import type { Colors } from "../ui-kit.tsx";
import { Badge, Button, Card, CheckRow, ChipSelect, Collapse, Field, styles, SwitchRow } from "../ui-kit.tsx";
import type { JevCardState } from "./jev.tsx";

type Navigation = { openAgent(input: { agentId: string }): void } | undefined;

export function useSupervisionCard({ target, targetKey, isCurrentKey, callGetSupervision, callSetSupervision, update }: {
  target: TargetValue | null;
  targetKey: string | null;
  isCurrentKey: (key: string) => boolean;
  callGetSupervision: (input: GetSupervisionRequest) => Promise<GetSupervisionResult>;
  callSetSupervision: (input: SetSupervisionRequest) => Promise<SetSupervisionResult>;
  update: (patch: { lastError: string | null }, target: TargetValue) => void;
}) {
  const paseo = usePaseo();
  const [data, setData] = useState<GetSupervisionResult | null>(null);
  const [form, setForm] = useState<SupervisionForm>(emptySupervisionForm);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [unverified, setUnverified] = useState<SupervisionUnverified[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [cardError, setCardError] = useState<{ message: string; cas: boolean } | null>(null);
  const [agents, setAgents] = useState<AgentChoice[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  // Target switch drops the previous home's snapshot, draft and every
  // transient flag — a draft authored against home A must never save into B.
  useEffect(() => {
    setData(null);
    setForm(emptySupervisionForm());
    setDirty(false);
    setSaving(false);
    setReloading(false);
    setSaved(false);
    setUnverified([]);
    setReadError(null);
    setCardError(null);
    setAgents(null);
    setAgentsError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey captures target
  }, [targetKey]);

  // The pickers list the app's own active agents — the same list the
  // sidebar shows — so a thread is chosen by name, never by typed id.
  const loadAgents = async (issueKey: string) => {
    try {
      const result = await paseo.agents.list({ scope: "active", page: { limit: 200 } });
      if (!isCurrentKey(issueKey)) return;
      setAgents(agentChoices(result.entries as unknown as AgentDirectoryEntry[]));
      setAgentsError(null);
    } catch (error) {
      if (!isCurrentKey(issueKey)) return;
      setAgentsError(errorMessage(error));
    }
  };

  // Fetch once per target. data === null is ambiguous between "loading" and
  // "the read failed" — readError separates the two so a failed read never
  // paints as an empty config, and Save requires a successful snapshot
  // rather than silently sending expectedSha256:null.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!target || !targetKey || loadedFor.current === targetKey) return;
    loadedFor.current = targetKey;
    const issueKey = targetKey;
    let cancelled = false;
    void loadAgents(issueKey);
    void (async () => {
      try {
        const result = await callGetSupervision({ schemaVersion: 2, target });
        if (cancelled || !isCurrentKey(issueKey)) return;
        setData(result);
        setReadError(null);
        setForm(formFromConfig(result.config));
      } catch (error) {
        if (cancelled || !isCurrentKey(issueKey)) return;
        setReadError(errorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
      // A cancelled read never landed — release the guard so a re-run for
      // the same key (StrictMode replay, key round-trip) retries instead
      // of painting "loading" forever with data === null.
      if (loadedFor.current === issueKey) loadedFor.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey captures target; the shell mints a fresh target object every render, so keying on it would cancel every pending read
  }, [targetKey]);

  const edit = (change: (current: SupervisionForm) => SupervisionForm) => {
    setDirty(true);
    setSaved(false);
    setUnverified([]);
    setForm(change);
  };

  const save = async () => {
    if (!target || !targetKey) return;
    const built = configFromForm(form);
    if ("error" in built) {
      setCardError({ message: built.error, cas: false });
      return;
    }
    const issueKey = targetKey;
    setSaving(true);
    try {
      const result = await callSetSupervision({
        schemaVersion: 2,
        target,
        config: built.config,
        expectedSha256: data?.sha256 ?? null,
      });
      if (!isCurrentKey(issueKey)) return;
      setData(result);
      setForm(formFromConfig(result.config));
      setDirty(false);
      setSaved(true);
      setUnverified(result.unverified);
      setCardError(null);
      notifySupervisionChanged();
    } catch (error) {
      // The draft is kept on failure — the Human fixes one thing and saves
      // again instead of re-entering everything.
      const message = errorMessage(error);
      update({ lastError: message }, target);
      if (isCurrentKey(issueKey)) {
        setCardError({ message: translateError(message), cas: /changed since|changed during/i.test(message) });
      }
    } finally {
      if (isCurrentKey(issueKey)) setSaving(false);
    }
  };

  const reload = async () => {
    if (!target || !targetKey) return;
    const issueKey = targetKey;
    setReloading(true);
    void loadAgents(issueKey);
    try {
      const result = await callGetSupervision({ schemaVersion: 2, target });
      if (!isCurrentKey(issueKey)) return;
      setData(result);
      setReadError(null);
      setCardError(null);
      setForm(formFromConfig(result.config));
      setDirty(false);
      setSaved(false);
      setUnverified([]);
      notifySupervisionChanged();
    } catch (error) {
      const message = errorMessage(error);
      update({ lastError: message }, target);
      if (isCurrentKey(issueKey)) setCardError({ message: translateError(message), cas: false });
    } finally {
      if (isCurrentKey(issueKey)) setReloading(false);
    }
  };

  const restore = () => {
    const migration = data?.migration ?? null;
    if (migration === null) return;
    edit(() => restoreMigration(data?.config ?? null, migration));
  };

  return {
    data,
    form,
    dirty,
    busy: saving || reloading,
    saved,
    unverified,
    readError,
    cardError,
    agents,
    agentsError,
    edit,
    save,
    reload,
    restore,
    refreshAgents: () => { if (targetKey) void loadAgents(targetKey); },
  };
}
export type SupervisionCardState = ReturnType<typeof useSupervisionCard>;

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

const TONE_COLOR = (colors: Colors, tone: "good" | "neutral" | "warn" | "bad"): string =>
  tone === "good" ? colors.statusSuccess
    : tone === "warn" ? colors.statusWarning
      : tone === "bad" ? colors.statusDanger
        : colors.foregroundMuted;

function Notice({ colors, tone, children }: { colors: Colors; tone: "warn" | "bad" | "neutral"; children: ReactNode }) {
  const color = TONE_COLOR(colors, tone);
  return (
    <View style={[styles.noticeBox, { borderColor: tone === "neutral" ? colors.border : color, backgroundColor: colors.surface2 }]}>
      {children}
    </View>
  );
}

function Section({ colors, title, children }: { colors: Colors; title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.fieldLabel, { color: colors.foreground }]}>{title}</Text>
      {children}
    </View>
  );
}

// The old per-case readout, kept behind "Technical details" for review and
// debugging — ids, counts, reason codes and model choices, never bodies.
function TechnicalDetails({ colors, data }: { colors: Colors; data: GetSupervisionResult }) {
  const tone = (state: SupervisionObservation["state"]): "neutral" | "good" | "draft" | "bad" =>
    state === "evaluated" ? "good" : state === "observed" ? "draft" : state === "unknown" ? "neutral" : "bad";
  const muted = [styles.mutedSmall, { color: colors.foregroundMuted }];
  return (
    <View style={{ gap: 6 }}>
      {data.gates !== null && Object.keys(data.gates).length > 0 ? (
        <View style={{ gap: 2 }}>
          {Object.entries(data.gates).map(([leadId, reason]) => (
            <Text key={leadId} style={muted}>lead {leadId}: {reason ?? "ok"}</Text>
          ))}
        </View>
      ) : null}
      {data.diagnostics !== null && (data.diagnostics.droppedEvents > 0 || data.diagnostics.reasons.length > 0) ? (
        <Text style={muted}>
          observer: {data.diagnostics.droppedEvents} dropped event(s)
          {data.diagnostics.reasons.length > 0 ? ` — ${data.diagnostics.reasons.join(", ")}` : ""}
        </Text>
      ) : null}
      {(data.observations ?? []).map(entry => (
        <View key={entry.fingerprint} style={[styles.noticeBox, { borderColor: colors.border, backgroundColor: colors.surface2 }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Badge colors={colors} label={entry.state} tone={tone(entry.state)} />
            <Text style={muted}>case {shortId(entry.fingerprint)} · peer {entry.peerId} · lead {entry.leadAgentId} · {entry.updatedAt}</Text>
          </View>
          <Text style={muted}>
            {entry.route !== null ? `${entry.route.source}/${entry.route.mode} · ` : ""}room {entry.counts.roomMessages} · cross-peer {entry.counts.otherRoomMessages} · reports {entry.counts.reportMessages} · uncertain {entry.counts.uncertainRoomMessages} · peer-sends {entry.counts.peerSends} · assessments {entry.assessmentsUsed}
          </Text>
          {entry.findings.map(finding => (
            <Text key={finding.axis} style={muted}>
              finding {finding.axis}: {finding.choice}@{finding.confidence} · {finding.status}
              {finding.evidenceCallId !== null ? ` · linked ${finding.evidenceCallId}` : ""}
              {finding.resolvedBy !== null ? ` · resolved by ${finding.resolvedBy}` : ""}
            </Text>
          ))}
          {entry.delivery !== null ? (
            <Text style={muted}>
              delivery: {entry.delivery.state} → {entry.delivery.recipient} ({entry.delivery.findings.join(", ")}){entry.delivery.reason !== null ? ` — ${entry.delivery.reason}` : ""}
            </Text>
          ) : null}
          {entry.reason !== null ? <Text style={muted}>reason: {entry.reason}</Text> : null}
          {entry.visibility.length > 0 ? <Text style={muted}>visibility: {entry.visibility.join(", ")}</Text> : null}
          {entry.lastAssessment !== null ? (
            <Text style={muted}>
              {entry.lastAssessment.model} ({entry.lastAssessment.rubricVersion}): brief={entry.lastAssessment.choices.leadBrief.choice}@{entry.lastAssessment.choices.leadBrief.confidence} handback={entry.lastAssessment.choices.peerHandback.choice}@{entry.lastAssessment.choices.peerHandback.confidence} handling={entry.lastAssessment.choices.leadHandling.choice}@{entry.lastAssessment.choices.leadHandling.confidence}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

// Required disclosure (spec: "an explicit UI disclosure that full captured
// communication can leave the host") — shown in the consent step and kept
// one tap away afterwards.
function Disclosure({ colors }: { colors: Colors }) {
  const text = [styles.mutedSmall, { color: colors.foregroundMuted }];
  return (
    <View style={{ gap: 6 }}>
      <Text style={text}>
        • Sent to Jev: the Lead's brief to each Peer, the Peer's hand-back, the Lead's later messages to that Peer,
        to its other Peers and to the Supervisor, and the Peer's own messages. This content leaves this computer.
        Messages that could not be confirmed are sent as ids only.
      </Text>
      <Text style={text}>
        • Cost: each check is a paid Jev call. A conversation can be checked again when new messages arrive, up to a
        fixed limit.
      </Text>
      <Text style={text}>
        • Alerts: the Supervisor receives a short generated message quoting limited excerpts. Alerts wait while the
        Supervisor is busy, but one that lands just as its turn starts interrupts that turn. A failed alert is marked
        uncertain and never retried.
      </Text>
      <Text style={text}>
        • Coverage by agent family: Codex, Claude Code and Pi — the brief, the hand-back and the Lead's later messages.
        Devin — the brief and the hand-back only; whether a Devin message was delivered is not visible, so a Devin Lead's
        handling is never judged. A family never blocks the others in a mixed room.
      </Text>
      <Text style={text}>
        • Limits: findings are suspected communication issues to review — not proof, not an acceptance decision.
        Silence never triggers an alert. A restart forgets conversations in progress; only the recent summary is kept.
      </Text>
    </View>
  );
}

const migrationText = (migration: SupervisionMigration): string => {
  const leads = migration.disabledRoutes.length;
  const parts = [
    leads > 0 ? `${leads} Lead${leads === 1 ? "" : "s"}` : null,
    migration.disabledDefaults !== null ? "all SLP Leads" : null,
  ].filter(Boolean);
  return `Settings from an earlier version were found for ${parts.join(" and ")}.`;
};

export function SupervisionCard({ colors, target, jev, supervision, navigation }: {
  colors: Colors;
  target: TargetValue | null;
  jev: JevCardState;
  supervision: SupervisionCardState;
  navigation?: Navigation;
}) {
  const [consentOpen, setConsentOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);

  const { form, data } = supervision;
  const readiness = jevReadiness(jev.view);
  const capabilityOn = jev.view?.capabilities?.supervision === true;
  const choices = supervision.agents ?? [];
  const nameById = useMemo(() => new Map(choices.map(choice => [choice.agentId, choice.title])), [choices]);
  const names = (agentId: string): string => nameById.get(agentId) ?? shortId(agentId);
  const status = statusLine({ jev: readiness, capabilityOn, data, names });
  const summary = useMemo(() => summarizeObservations(data?.observations ?? null), [data]);
  const leads = leadRows(choices, form);
  const supervisors = supervisorRows(choices, form);
  const disabled = !target || supervision.busy || data === null;
  const migration = data?.migration ?? null;
  const gates = data?.gates ?? {};

  const setCapability = async (next: boolean) => {
    setSwitchError(null);
    if (next && !consentOpen) { setConsentOpen(true); return; }
    setConsentOpen(false);
    if (next === capabilityOn) return; // cancelling the consent step writes nothing
    const error = await jev.setSupervisionCapability(next);
    if (error !== null) {
      setSwitchError(/changed since|IDEMPOTENCY/i.test(error)
        ? "Jev settings changed elsewhere. Reload them in the Jev card, then try again."
        : error);
      jev.retryLoad();
    }
  };

  return (
    <Card
      colors={colors}
      title="Supervision"
      subtitle="Checks how each Lead briefs its Peers and handles their hand-backs, and can alert a Supervisor."
    >
      <SwitchRow
        colors={colors}
        checked={capabilityOn || consentOpen}
        disabled={!target || !readiness.ready || jev.capabilityBusy || jev.view === null}
        onToggle={next => { void setCapability(next); }}
        title="Supervision"
        hint={readiness.ready ? "Off by default. Turning it on sends conversation content to Jev." : readiness.why}
      />
      {consentOpen ? (
        <Notice colors={colors} tone="warn">
          <Text style={[styles.checkTitle, { color: colors.foreground }]}>Before you turn this on</Text>
          <Disclosure colors={colors} />
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button colors={colors} kind="primary" label={jev.capabilityBusy ? "Turning on…" : "Turn on"}
              disabled={jev.capabilityBusy} onPress={() => { void setCapability(true); }} />
            <Button colors={colors} kind="ghost" label="Cancel" disabled={jev.capabilityBusy}
              onPress={() => setConsentOpen(false)} />
          </View>
        </Notice>
      ) : null}
      {switchError !== null ? (
        <Text style={[styles.mutedSmall, { color: colors.statusDanger }]} accessibilityLiveRegion="polite">{switchError}</Text>
      ) : null}

      <Text style={[styles.checkTitle, { color: TONE_COLOR(colors, status.tone) }]} accessibilityLiveRegion="polite">
        {status.text}
      </Text>

      {supervision.readError !== null ? (
        <Notice colors={colors} tone="bad">
          <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>
            Could not load supervision settings: {translateError(supervision.readError)}
          </Text>
          <Button colors={colors} kind="ghost" label="Try again" disabled={supervision.busy} onPress={() => void supervision.reload()} />
        </Notice>
      ) : null}
      {data?.error ? (
        <Notice colors={colors} tone="bad">
          <Text style={[styles.mutedSmall, { color: colors.statusDanger }]}>{translateError(data.error)}</Text>
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Details: {data.error}</Text>
        </Notice>
      ) : null}
      {migration !== null && (migration.disabledRoutes.length > 0 || migration.disabledDefaults !== null) ? (
        <Notice colors={colors} tone="warn">
          <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
            {migrationText(migration)} They are paused because this version can send more to Jev (Claude Code, Devin and Pi
            conversations are now included). Read "What is sent and what it costs", restore, review, then save.
          </Text>
          <Button colors={colors} kind="ghost" label="Restore" disabled={disabled} onPress={supervision.restore} />
        </Notice>
      ) : null}

      <Section colors={colors} title="Which Leads">
        <ChipSelect<"all" | "selected">
          colors={colors}
          variant="choice"
          value={form.scope}
          options={[{ label: "All SLP Leads", value: "all" }, { label: "Selected Leads", value: "selected" }]}
          onChange={next => supervision.edit(current => ({ ...current, scope: next }))}
          disabled={disabled}
        />
        <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
          {form.scope === "all"
            ? "Every SLP Lead on this computer, including ones started later. Uncheck a Lead to leave it out."
            : "Only the Leads you check."}
        </Text>
        {supervision.agentsError !== null ? (
          <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
            Could not list agents: {supervision.agentsError}
          </Text>
        ) : supervision.agents === null ? (
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Loading agents…</Text>
        ) : leads.length === 0 ? (
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
            No SLP Leads are running right now.{form.scope === "all" ? " New Leads are picked up automatically." : ""}
          </Text>
        ) : (
          leads.map(row => {
            const gate = gates[row.agentId];
            const hint = [
              row.detail,
              row.custom ? "has custom settings (kept unless you change this row)" : null,
              gate !== undefined && gate !== null ? describeReason(gate) : null,
            ].filter(Boolean).join(" — ");
            return (
              <CheckRow
                key={row.agentId}
                colors={colors}
                checked={leadChecked(form, row.agentId) || row.custom}
                title={row.title}
                hint={hint}
                disabled={disabled || row.workspaceId === null}
                onToggle={next => {
                  if (row.workspaceId === null) return;
                  const pick = { agentId: row.agentId, workspaceId: row.workspaceId };
                  supervision.edit(current => toggleLead(current, pick, next));
                }}
              />
            );
          })
        )}
        <View style={{ flexDirection: "row" }}>
          <Button colors={colors} kind="ghost" label="Refresh list" disabled={!target} onPress={supervision.refreshAgents} />
        </View>
      </Section>

      <Section colors={colors} title="When an issue is found">
        <ChipSelect<"shadow" | "notify">
          colors={colors}
          variant="choice"
          value={form.mode}
          options={[{ label: "Record only", value: "shadow" }, { label: "Record and alert a Supervisor", value: "notify" }]}
          onChange={next => supervision.edit(current => ({ ...current, mode: next }))}
          disabled={disabled}
        />
        {form.mode === "notify" ? (
          supervisors.length === 0 ? (
            <Text style={[styles.mutedSmall, { color: colors.statusWarning }]}>
              No SLP Supervisor is running. Start one, then press Refresh list.
            </Text>
          ) : (
            supervisors.map(row => (
              <CheckRow
                key={row.agentId}
                colors={colors}
                checked={form.supervisor?.agentId === row.agentId}
                title={row.title}
                hint={row.detail}
                disabled={disabled}
                onToggle={next => supervision.edit(current => ({
                  ...current,
                  supervisor: next ? { agentId: row.agentId, workspaceId: row.workspaceId } : null,
                }))}
              />
            ))
          )
        ) : (
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
            Findings appear below; nobody is messaged.
          </Text>
        )}
      </Section>

      <Collapse colors={colors} title="Advanced" open={advancedOpen} onToggle={setAdvancedOpen}>
        <Field
          colors={colors}
          label="Confidence needed"
          hint={`How sure Jev must be before something counts as an issue (${SUPERVISION_CONFIDENCE_MIN}–${SUPERVISION_CONFIDENCE_MAX}). This is the model's own confidence, not measured accuracy.`}
          value={form.confidenceThreshold}
          onChangeText={text => supervision.edit(current => ({ ...current, confidenceThreshold: text }))}
          disabled={disabled}
        />
        <Field
          colors={colors}
          label="Wait before alerting (seconds)"
          hint={`Brief and hand-back issues are alerted only after this wait, so the Lead can fix them first (0–${SUPERVISION_PENDING_DELAY_MAX_MS / 1000}).`}
          value={form.delaySeconds}
          onChangeText={text => supervision.edit(current => ({ ...current, delaySeconds: text }))}
          disabled={disabled}
        />
      </Collapse>
      <Collapse colors={colors} title="What is sent and what it costs" open={disclosureOpen} onToggle={setDisclosureOpen}>
        <Disclosure colors={colors} />
      </Collapse>

      {supervision.cardError ? (
        <Notice colors={colors} tone={supervision.cardError.cas ? "warn" : "bad"}>
          <Text style={[styles.mutedSmall, { color: supervision.cardError.cas ? colors.statusWarning : colors.statusDanger }]}>
            {supervision.cardError.message}
          </Text>
          {supervision.cardError.cas ? (
            <Button colors={colors} kind="ghost" label="Reload" disabled={supervision.busy} onPress={() => void supervision.reload()} />
          ) : null}
        </Notice>
      ) : null}
      {supervision.saved && !supervision.dirty ? (
        <Text style={[styles.mutedSmall, { color: colors.statusSuccess }]} accessibilityLiveRegion="polite">Saved.</Text>
      ) : null}
      {supervision.unverified.length > 0 ? (
        <Notice colors={colors} tone="warn">
          {supervision.unverified.map(item => (
            <Text key={`${item.role}:${item.agentId}`} style={[styles.mutedSmall, { color: colors.statusWarning }]}>
              {names(item.agentId)} could not be checked right now.{" "}
              {item.role === "lead"
                ? "Watching starts once this Lead's next turn is seen."
                : "Alerts are checked again before each one is sent."}
            </Text>
          ))}
        </Notice>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button
          colors={colors}
          kind="primary"
          label={supervision.busy ? "Working…" : "Save changes"}
          disabled={disabled || !supervision.dirty || supervision.readError !== null}
          onPress={() => void supervision.save()}
        />
        <Button colors={colors} kind="ghost" label={supervision.dirty ? "Discard changes" : "Reload"}
          disabled={!target || supervision.busy} onPress={() => void supervision.reload()} />
      </View>

      <View style={[styles.divider, { borderTopColor: colors.border }]} />
      <Section colors={colors} title="Recent findings">
        {data === null || (data.observations === null && data.gates === null) ? (
          <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
            {data === null ? "Loading…" : "Nothing to show — the observer is not running for this Paseo home."}
          </Text>
        ) : (
          <>
            {summary.issues.length === 0 ? (
              <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>No open issues.</Text>
            ) : summary.issues.map(issue => (
              <Notice key={issue.fingerprint} colors={colors} tone="warn">
                <Text style={[styles.checkTitle, { color: colors.foreground }]}>
                  {names(issue.leadAgentId)} → {names(issue.peerId)}
                </Text>
                {issue.problems.map(problem => (
                  <Text key={problem} style={[styles.mutedSmall, { color: colors.statusWarning }]}>{problem}</Text>
                ))}
                <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                  {new Date(issue.at).toLocaleString()}{issue.delivery !== null ? ` · ${issue.delivery}` : ""}
                </Text>
                {navigation !== undefined ? (
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    <Button colors={colors} kind="ghost" label="Open Lead" onPress={() => navigation.openAgent({ agentId: issue.leadAgentId })} />
                    <Button colors={colors} kind="ghost" label="Open Peer" onPress={() => navigation.openAgent({ agentId: issue.peerId })} />
                  </View>
                ) : null}
              </Notice>
            ))}
            <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
              {summary.okCount} checked with no issue · {summary.inProgress} in progress
            </Text>
            {summary.unassessed.length > 0 ? (
              <View style={{ gap: 2 }}>
                <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>Not checked:</Text>
                {summary.unassessed.map(group => (
                  <Text key={group.label} style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
                    • {group.label} ({group.count})
                  </Text>
                ))}
              </View>
            ) : null}
            <Text style={[styles.mutedSmall, { color: colors.foregroundMuted }]}>
              No findings does not mean communication was fine — many conversations cannot be checked.
            </Text>
            <Collapse colors={colors} title="Technical details" open={technicalOpen} onToggle={setTechnicalOpen}>
              <TechnicalDetails colors={colors} data={data} />
            </Collapse>
          </>
        )}
      </Section>
    </Card>
  );
}
