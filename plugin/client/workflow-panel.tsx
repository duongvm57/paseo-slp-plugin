import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView, Text, View } from "react-native";
import { getWorkspaceWorkflow } from "../shared/workflow-view.ts";
import type { WorkspaceWorkflowRequest, WorkspaceWorkflowResult } from "../shared/workflow-view.ts";
import type { DeskWorkflowProjectionItemValue } from "../shared/enforcement.ts";
import { useTargetLifetime } from "./target-async.ts";
import { errorMessage } from "./manager-state.ts";
import { Button, Card, Collapse, KV } from "./ui-kit.tsx";
import type { Colors } from "./ui-kit.tsx";

type Section = WorkspaceWorkflowRequest["page"]["section"];
const sections: { id: Section; title: string }[] = [
  { id: "briefs", title: "Brief history" }, { id: "decisions", title: "Decisions" },
  { id: "ownership", title: "Owners and dependencies" }, { id: "reviews", title: "Review" },
  { id: "evidence", title: "Candidate and checks" },
];

const firstPage = (workspaceId: string, assignmentId: string | null = null, section: Section = "briefs"): WorkspaceWorkflowRequest => ({
  schemaVersion: 1, workspaceId, assignmentId, assignmentCursor: null, limit: 20,
  page: { section, expectedLedgerRevision: null, expectedBriefRevision: null, cursor: null, limit: 20 },
});

/** Each read owns a target ticket and a sequence. A late result cannot paint
 * another host/workspace, an A→B→A session, or a newer read on the same target. */
export function useWorkspaceWorkflow(key: string, workspaceId: string,
  read: (input: WorkspaceWorkflowRequest) => Promise<WorkspaceWorkflowResult>) {
  const capture = useTargetLifetime(key);
  const adapter = useRef(read);
  useLayoutEffect(() => { adapter.current = read; });
  const sequence = useRef(0);
  const [page, setPage] = useState<{
    key: string; request: WorkspaceWorkflowRequest; result: WorkspaceWorkflowResult | null; loading: boolean; error: string | null;
  } | null>(null);
  const run = useCallback(async (request: WorkspaceWorkflowRequest) => {
    const ticket = capture();
    if (!ticket.isCurrent()) return;
    const issued = ++sequence.current;
    setPage({ key, request, result: null, loading: true, error: null });
    try {
      const result = await adapter.current(request);
      if (ticket.isCurrent() && issued === sequence.current) {
        if (result.workspaceId !== request.workspaceId || (result.state === "ready" && request.assignmentId !== null && result.view?.assignmentId !== request.assignmentId)) {
          throw new Error("The work read does not match the selected workspace and assignment.");
        }
        setPage({ key, request, result, loading: false, error: null });
      }
    } catch (cause) {
      if (ticket.isCurrent() && issued === sequence.current) setPage({ key, request, result: null, loading: false, error: errorMessage(cause) });
    }
  }, [capture, key]);
  useEffect(() => { void run(firstPage(workspaceId)); }, [workspaceId, run]);
  const current = page?.key === key ? page : null;
  const reload = () => run(firstPage(workspaceId, current?.request.assignmentId ?? null, current?.request.page.section ?? "briefs"));
  const select = (assignmentId: string | null) => run(firstPage(workspaceId, assignmentId));
  const section = (section: Section) => {
    if (!current?.request.assignmentId) return;
    const request = firstPage(workspaceId, current.request.assignmentId, section);
    request.page.expectedLedgerRevision = current.result?.ledgerRevision ?? null;
    request.page.expectedBriefRevision = current.result?.view?.briefRevision ?? null;
    return run(request);
  };
  const more = () => {
    const result = current?.result;
    if (!current || !result) return;
    if (result.view?.nextCursor) {
      return run({ ...current.request, page: { ...current.request.page,
        expectedLedgerRevision: result.ledgerRevision, expectedBriefRevision: result.view.briefRevision, cursor: result.view.nextCursor } });
    }
    if (result.assignmentNextCursor) {
      return run({ ...current.request, assignmentCursor: result.assignmentNextCursor,
        page: { ...current.request.page, expectedLedgerRevision: result.ledgerRevision } });
    }
  };
  return { current, reload, select, section, more };
}

const display = (value: unknown): string => value == null ? "None recorded" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
const label = (key: string): string => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase());
const itemTitles: Record<string, string> = {
  briefRevision: "Brief revision", decisionEntry: "Material decision", scopeDeclaration: "Scope declaration",
  ownershipOffer: "Ownership offer", ownershipAccept: "Ownership acceptance",
  scopeReview: "Independent review observation", scopeTransition: "Scope transition",
  candidateObservation: "Runtime candidate observation", checkDefinition: "Declared check", checkRun: "Runtime check observation",
  handbackSummary: "Handback summary", settlementSummary: "Settlement summary",
};

function qualificationLine(item: Extract<DeskWorkflowProjectionItemValue, { kind: "scopeReview" }>): string {
  if (item.qualification.standingApproval) return "Counts toward the current standing approval.";
  if (item.qualification.discharging) return "Discharges a current review requirement.";
  if (item.qualification.eligible) return "Eligible under the current round pins and reviewer independence.";
  return "Recorded history — outside the current standing qualification.";
}

function RecordedFields({ colors, value }: { colors: Colors; value: object }) {
  return <>{Object.entries(value).map(([key, value]) => <KV key={key} colors={colors} label={label(key)} value={display(value)} />)}</>;
}

function RecordDetails({ colors, title, children }: { colors: Colors; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Collapse colors={colors} title={title} open={open} onToggle={setOpen}>{children}</Collapse>;
}

const metadataFields = new Set(["requestId", "actorMembershipId", "ownerMembershipId", "reviewerSeatId", "actorSeatId",
  "bodySha256", "entrySha256", "priorEntrySha256", "priorDecisionId", "declarationSha256", "definitionSha256", "mandateSha256"]);

function WorkItem({ colors, item, briefRevision }: { colors: Colors; item: DeskWorkflowProjectionItemValue; briefRevision: number }) {
  if (item.kind === "reviewDisagreement") return <Card colors={colors} title="Unresolved review disagreement">
    <Text style={{ color: colors.statusWarning }}>This record needs the Lead's adjudication; it does not establish acceptance.</Text>
    <RecordedFields colors={colors} value={item} />
  </Card>;
  if (item.kind === "handbackSummary" || item.kind === "settlementSummary") return <Card colors={colors} title={itemTitles[item.kind]}>
    <Text style={{ color: colors.foregroundMuted }}>
      Typed summary of a ledger-held record — declared claims and measured observations stay distinct; no resource release or acceptance is inferred from it.
    </Text>
    <RecordedFields colors={colors} value={item.summary} />
  </Card>;
  const row = item.row;
  const title = item.kind === "decisionEntry" ? item.row.body.proposition : itemTitles[item.kind];
  const body = item.kind === "decisionEntry" || item.kind === "briefRevision" ? item.row.body : null;
  const primary = Object.fromEntries(Object.entries(body ?? row).filter(([key]) => !metadataFields.has(key)));
  const metadata = Object.fromEntries(Object.entries(row).filter(([key]) => metadataFields.has(key) || (body !== null && key !== "body")));
  return <Card colors={colors} title={title}>
    {"briefRevision" in row && row.briefRevision !== briefRevision ? <Text style={{ color: colors.statusWarning }}>
      Recorded against brief {row.briefRevision}; the current brief is {briefRevision}.
    </Text> : null}
    {item.kind === "scopeReview" ? <Text style={{ color: colors.foregroundMuted }}>{qualificationLine(item)}</Text> : null}
    <RecordedFields colors={colors} value={primary} />
    <RecordDetails colors={colors} title="Record provenance"><RecordedFields colors={colors} value={metadata} /></RecordDetails>
  </Card>;
}

export function WorkflowPanel({ workspaceId, host, theme, layout }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, workspace => workspace.directory);
  const call = useRpc(getWorkspaceWorkflow);
  const reader = useWorkspaceWorkflow(JSON.stringify([host.id, workspaceId, directory]), workspaceId, call);
  const colors = theme.colors;
  const current = reader.current;
  const result = current?.result;
  const view = result?.view;
  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: 14 }}>
    <Text style={{ color: colors.foreground, fontSize: 22, fontWeight: "600" }}>SLP work</Text>
    <Text style={{ color: colors.foregroundMuted }}>
      Read the repository's recorded brief, decisions, owners, review and proof. Reload for current state. This view does not establish acceptance.
    </Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Button colors={colors} label="Reload" onPress={() => { void reader.reload(); }} disabled={current?.loading} />
      {current?.request.assignmentId ? <Button colors={colors} label="Assignments" onPress={() => { void reader.select(null); }} /> : null}
    </View>
    {current?.loading || !current ? <Text style={{ color: colors.foregroundMuted }}>Reading work records…</Text> : null}
    {current?.error ? <Text style={{ color: colors.statusDanger }}>{current.error}</Text> : null}
    {result?.problem ? <Card colors={colors} title={result.state === "conflict" ? "Work changed — reload" : "Work records unavailable"}>
      <Text selectable style={{ color: colors.statusWarning }}>{result.problem.detail}</Text>
    </Card> : null}
    {result?.state === "absent" ? <Card colors={colors} title="No desk ledger">
      <Text style={{ color: colors.foregroundMuted }}>No desk ledger exists for this repository. Work in chats or other artifacts is not represented here.</Text>
    </Card> : null}
    {result?.state === "ready" && !view ? <>
      <Text style={{ color: colors.foregroundMuted }}>{result.assignments.length} of {result.assignmentTotal} registered assignments · ledger {result.ledgerRevision}</Text>
      {result.assignmentOffset > 0 ? <Text style={{ color: colors.foregroundMuted }}>{result.assignmentOffset} earlier entries omitted from this page; Reload returns to the first page.</Text> : null}
      {result.assignmentTotal === 0 ? <Text style={{ color: colors.foregroundMuted }}>No assignments are registered in this desk.</Text> : null}
      {result.assignments.map(assignment => <Card key={assignment.id} colors={colors} title={assignment.objective ?? assignment.id}>
        <Text selectable style={{ color: colors.foregroundMuted }}>
          {assignment.id} · {assignment.state} · owner {assignment.ownerAgentId} · ownership revision {assignment.ownershipRevision}
          {assignment.objectiveBasis === "registration" ? " · registration objective" : ` · brief ${assignment.briefRevision}`}
        </Text>
        <Button colors={colors} label="Read assignment" onPress={() => { void reader.select(assignment.id); }} />
      </Card>)}
    </> : null}
    {view ? <>
      <Text selectable style={{ color: colors.foregroundMuted }}>{view.assignmentId} · brief {view.briefRevision} · ledger {view.ledgerRevision}</Text>
      <Text selectable style={{ color: colors.foregroundMuted }}>
        Owner {view.ownership.ownerAgentId} · ownership revision {view.ownership.ownershipRevision}
        {view.ownership.ownerMembership ? ` · recorded membership ${view.ownership.ownerMembership.state}` : " · membership unrecorded"}
        {view.ownership.ownerAgentId !== view.ownership.registeredOwnerAgentId || view.ownership.ownerMembershipId !== view.ownership.registeredOwnerMembershipId
          ? ` · registered owner ${view.ownership.registeredOwnerAgentId}` : ""}
      </Text>
      {view.ownership.acceptedAcknowledgment ? <Text selectable style={{ color: colors.foregroundMuted }}>
        Accepted {view.ownership.acceptedAcknowledgment.acceptId} from offer {view.ownership.acceptedAcknowledgment.offerId}
        {view.ownership.acceptedAcknowledgment.gaps.length > 0 ? ` · recorded gaps: ${view.ownership.acceptedAcknowledgment.gaps.join(", ")}` : ""}
        {" — a responsibility acknowledgment, not review approval or project acceptance."}
      </Text> : null}
      {view.currentBrief ? <Card colors={colors} title="Operative brief" subtitle="Authority and source pointers are recorded claims.">
        <Text selectable style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>{view.currentBrief.body.objective}</Text>
        <RecordedFields colors={colors} value={Object.fromEntries(Object.entries(view.currentBrief.body).filter(([key]) => key !== "objective"))} />
        <RecordDetails colors={colors} title="Brief provenance"><RecordedFields colors={colors} value={Object.fromEntries(Object.entries(view.currentBrief).filter(([key]) => key !== "body"))} /></RecordDetails>
      </Card> : <Card colors={colors} title="Legacy assignment — structured brief absent">
        <Text selectable style={{ color: colors.foregroundMuted }}>{view.legacyObjective ?? "No objective recorded."}</Text>
      </Card>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{sections.map(section =>
        <Button key={section.id} colors={colors} label={section.title} kind={view.section === section.id ? "primary" : "ghost"}
          onPress={() => { void reader.section(section.id); }} />)}</View>
      <Text style={{ color: colors.foregroundMuted }}>
        {view.items.length} of {view.total} records · {view.omittedBefore} earlier and {view.omittedAfter} later records outside this page. Reload returns to the first page.
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>Declared intent and evidence pointers are claims. Candidate/check measurements describe what the runtime observed; a recorded review is not project acceptance.</Text>
      {view.items.map((item, index) => <WorkItem key={`${item.kind}:${view.omittedBefore + index}`} colors={colors} item={item} briefRevision={view.briefRevision} />)}
    </> : null}
    {result?.assignmentNextCursor || view?.nextCursor ? <Button colors={colors} label="Next page" onPress={() => { void reader.more(); }} /> : null}
    {result?.target ? <RecordDetails colors={colors} title="Read source">
      <KV colors={colors} label="Host" value={host.label} />
      <RecordedFields colors={colors} value={result.target} />
      <KV colors={colors} label="Read at" value={result.generatedAt} />
    </RecordDetails> : null}
  </ScrollView>;
}
