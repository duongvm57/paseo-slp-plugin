// plugin/server/capabilities.ts — the P0 capability audit (roadmap §6 P0).
//
// An audit is curated evidence, not an inference engine: every row names what
// it claims, the surface that backs it, the evidence kind and the limits of
// that evidence. Three rules keep it honest:
//   - default status is `unknown`; absence of a disproof is never support;
//   - `source-static-compat` evidence can establish interface/contract facts
//     (a field exists, a hook fires, a daemon rejects) but never live runtime
//     delivery — a delivery claim needs `live-probe` evidence;
//   - provider `enabled`/availability is presence, not capability.
//
// Negative evidence is allowed to mark a row `unsupported` (a missing field,
// a rejected contract); it is never upgraded to `supported`.
//
// Source pins: the host tree was audited at PASEO_SOURCE_REVISION; historical
// SDK citations retain their audited 0.8.0 pin. Current build dependencies are
// `@getpaseo/*` 0.11.2 in package.json. An upgrade does not refresh old evidence:
// rows can drift, so re-audit on upgrade and keep the original pins visible.

import { z } from "zod";
import { OperationConflict } from "../shared/contracts.ts";
import { limitation } from "./limitations.ts";
import {
  CapabilityRecord,
  CapabilityGap,
  type CapabilityRecordValue,
  type CapabilityGapValue,
} from "../shared/enforcement.ts";
import { FAMILY_IDS, type FamilyId } from "../shared/runtime/families.ts";

export const PASEO_SOURCE_REVISION = "0f20e6dfe4c2573e203dea2aae00aa5983ce4d62";
const src = (path: string) => `paseo@${PASEO_SOURCE_REVISION}:${path}`;
const sdk = (pkg: string, path: string) => `${pkg}@0.8.0:${path}`;

// Formation ABI evidence, not an extra status inventory row: the status
// capacity stays pinned at 39. The typed server entry also checks assignability
// against the published SDK; these facts establish no live delivery claim.
export const FORMATION_WORKSPACE_CONTRACT = {
  sourceRef: "@getpaseo/client@0.10.0:dist/index.d.ts PaseoWorkspaceActions/PaseoWorkspaceHandle",
  evidenceKind: "source-static-compat",
  primitives: ["workspaces.ref(id).refresh(options)", "workspaces.open({cwd,requestId})", "handle.agents.create(options)"],
  limits: ["active-only refresh cannot inventory archived history", "open may register/revive a workspace and outlive timeout",
    "new worktree creation has no setup-suppression flag; no formation V1 workspace.create"],
} as const;

export const CAPABILITY_IDS = {
  hookAgentCreate: "hook.agent.create",
  hookSessionOpen: "hook.agent.session-open",
  hookWorkspaceCreate: "hook.workspace.create",
  createCallerPrincipal: "create.caller-principal",
  createAgentId: "create.agent-id",
  parentAgentLabel: "parent-agent-id.label",
  pluginRpcDispatch: "plugin-rpc.dispatch",
  providersSnapshot: "host.providers-snapshot",
  agentsList: "host.agents-list",
  serverInfoAccessor: "host.server-info-accessor",
  paseoDisabledTools: "paseo-tools.disabled-tools",
  modelResolution: "model-resolution.introspection",
  mcpRecordPersistence: "mcp-servers.agent-record-persistence",
  deskLedger: "enforcement.desk-ledger",
  toolPolicyPreapproval: "tool-policy.mcp-preapproval",
  mcpStdioLaunch: "mcp-servers.stdio-launch",
  probeSessionOpenEnv: "probe.session-open-env-to-mcp-child",
  probeCreateMcpEnv: "probe.create-mcp-env-to-mcp-child",
  probeCreateEnvEcho: "probe.create-env-to-session-open-request",
  probeMcpResume: "probe.mcp-servers-resume-persistence",
  /** P2-d — the desk MCP bridge's own transport surface. */
  deskBridgeTransport: "desk-bridge.transport",
} as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[keyof typeof CAPABILITY_IDS];

/** Live observations the status handler may supply; null = surface was not
 *  exercised in this view, never silently treated as absent. */
export interface CapabilityHostObservation {
  /** enforcement-status itself was dispatched through the host RPC surface. */
  rpcDispatched: boolean;
  /** providers.snapshot answered (true) / rejected as unknown (false). */
  providersSnapshot: boolean | null;
  /** agents.list answered (true) / failed (false). */
  agentsList: boolean | null;
  /** P2-d — the desk bridge lifecycle state this view observed; absent/undefined
   *  means the caller never saw it (unknown, never fabricated). */
  deskBridge?: "listening" | "unavailable" | null;
}

const record = (r: CapabilityRecordValue): CapabilityRecordValue =>
  CapabilityRecord.parse(r);

const gap = (g: CapabilityGapValue): CapabilityGapValue => CapabilityGap.parse(g);

/** The deliberate P0 scope reduction (spec §2.1 backlog): the host has no
 *  introspection surface for effective tool policy, so P0 emits this stable
 *  gap row instead of projecting configured-on-disk values. P1 picks the
 *  oracle/output schema/owner before any provider observation returns. */
export const PROVIDER_TOOLS_PROJECTION_GAP: CapabilityGapValue = gap({
  capabilityId: "providerTools-projection",
  family: null,
  missingPrimitive: "host lacks an introspection surface for effective tool policy (F10)",
  neededBy: "upstream-host (F10 permanent gap)",
  ownerAction: "Human: raise a Paseo core request for effective tool-policy introspection; SLP ships no projection",
});

/** P2-d — the operator transport finding: DaemonClient.invokePluginRpc
 *  exists in the client API and the daemon dispatches plugin RPCs through
 *  it, but no MCP tool exposes that surface to a seat. Typed gap, never a
 *  fabricated transport. */
export const OPERATOR_MCP_TRANSPORT_GAP: CapabilityGapValue = gap({
  capabilityId: "invoke-plugin-rpc-mcp",
  family: null,
  missingPrimitive:
    "an MCP tool or CLI verb reaching DaemonClient.invokePluginRpc — API exists, no operator transport",
  neededBy: "operator reach to plugin RPCs without the app client",
  ownerAction:
    "Human: raise a Paseo core request for an MCP-side plugin RPC surface; SLP ships no workaround",
});

const STATIC: CapabilityRecordValue["evidenceKind"] = "source-static-compat";

const LIFECYCLE_SRC = src("packages/server/src/server/plugins/lifecycle/index.ts");
const REGISTRY_SRC = src("packages/server/src/server/agent/provider-registry.ts");
const MANAGER_SRC = src("packages/server/src/server/agent/agent-manager.ts");

/** Host-wide rows (family: null). Live-dependent rows consult `observed`. */
function hostRecords(now: string, observed: CapabilityHostObservation): CapabilityRecordValue[] {
  return [
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.hookAgentCreate,
      family: null,
      probeId: null,
      status: "supported",
      source: "paseo-src",
      sourceRef: LIFECYCLE_SRC,
      evidenceKind: STATIC,
      evidenceRef: 'beforeSchemas["agent.create"] = CreateAgentRequestMessageSchema.pick({config, env})',
      observedAt: null,
      limitations: [
        "request carries {config, env} only — no agentId, actor/principal or labels; a seat-bound credential cannot be minted at create",
        "before-hooks run per plugin-id in registration order; a later hook may overwrite config — output is not effective",
        "hook budget is the 30s plugin request timeout; no long I/O belongs here",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.hookSessionOpen,
      family: null,
      probeId: null,
      status: "supported",
      source: "paseo-src",
      sourceRef: LIFECYCLE_SRC,
      evidenceKind: STATIC,
      evidenceRef: 'beforeSchemas["agent.session_open"] {agentId, workspaceId, provider, cwd, reason, purpose, env}; host throws on non-env changes',
      observedAt: null,
      limitations: [
        "env is the only mutable field — mcpServers/toolPolicy/systemPrompt cannot be set at open",
        "no success/delivery callback exists; a failed open still ran the hook",
        "purpose \"history\" opens share this hook — a credential must not be minted for them",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.hookWorkspaceCreate,
      family: null,
      probeId: null,
      status: "supported",
      source: "paseo-src",
      sourceRef: LIFECYCLE_SRC,
      evidenceKind: STATIC,
      evidenceRef: 'beforeSchemas["workspace.create"] = WorkspaceCreateRequestSchema.omit({type, requestId})',
      observedAt: null,
      limitations: ["no caller principal; workspace.create cannot prove who asked"],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.createCallerPrincipal,
      family: null,
      probeId: null,
      status: "unsupported",
      source: "paseo-src",
      sourceRef: LIFECYCLE_SRC,
      evidenceKind: STATIC,
      evidenceRef: "agent.create hook request schema contains no actor/caller/principal field",
      observedAt: null,
      limitations: [
        "authority must be established after create — via session_open identity plus SDK verification, never from the create request",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.createAgentId,
      family: null,
      probeId: null,
      status: "unsupported",
      source: "paseo-src",
      sourceRef: LIFECYCLE_SRC,
      evidenceKind: STATIC,
      evidenceRef: "agent.create hook request has no agentId field",
      observedAt: null,
      limitations: [
        "a seat-bound handle can only be bound at session_open, where agentId exists (TOFU-style, verified against host state)",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.parentAgentLabel,
      family: null,
      probeId: null,
      status: "supported",
      source: "paseo-src",
      sourceRef: `${src("packages/server/src/server/plugins/lifecycle/index.ts")}#describeHookAgent`,
      evidenceKind: STATIC,
      evidenceRef: 'parentAgentId projected from labels["paseo.parent-agent-id"]',
      observedAt: null,
      limitations: [
        "label-derived provenance only — not an authenticated creation receipt; a label edit does not transfer authority",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.pluginRpcDispatch,
      family: null,
      probeId: null,
      status: observed.rpcDispatched ? "supported" : "unknown",
      source: "paseo-sdk",
      sourceRef: sdk("@getpaseo/plugin", "server/contracts.d.ts PluginServerContext.handle"),
      evidenceKind: observed.rpcDispatched ? "host-observation" : STATIC,
      evidenceRef: "this enforcement-status response was dispatched through server.handle",
      observedAt: observed.rpcDispatched ? now : null,
      limitations: [
        "PluginHandlerContext exposes {paseo} only — no caller principal accompanies an RPC",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.providersSnapshot,
      family: null,
      probeId: null,
      status: observed.providersSnapshot === null
        ? "unknown"
        : observed.providersSnapshot ? "supported" : "unsupported",
      source: "paseo-sdk",
      sourceRef: sdk("@getpaseo/client", "PaseoProviderActions.snapshot"),
      evidenceKind: observed.providersSnapshot === null ? STATIC : "host-observation",
      evidenceRef: "providers.snapshot invoked by this status call",
      observedAt: observed.providersSnapshot === null ? null : now,
      limitations: [
        "daemon versions predating the snapshot RPC reject with unknown_schema; provider-catalog.ts latches that absence",
        "a snapshot entry's presence/enabled is catalog state, never capability proof",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.agentsList,
      family: null,
      probeId: null,
      status: observed.agentsList === null
        ? "unknown"
        : observed.agentsList ? "supported" : "unsupported",
      source: "paseo-sdk",
      sourceRef: sdk("@getpaseo/client", "PaseoAgentActions.list → fetch_agents entries"),
      evidenceKind: observed.agentsList === null ? STATIC : "host-observation",
      evidenceRef: "agents.list invoked by this status call",
      observedAt: observed.agentsList === null ? null : now,
      limitations: [
        "entries carry the requested model and optional runtimeInfo; they do not expose effective mcpServers/toolPolicy/systemPrompt",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.serverInfoAccessor,
      family: null,
      probeId: null,
      status: "unsupported",
      source: "paseo-sdk",
      sourceRef: sdk("@getpaseo/client", "PaseoApi — no serverInfo accessor"),
      evidenceKind: STATIC,
      evidenceRef: "provider-catalog.ts records this missing accessor",
      observedAt: null,
      limitations: [
        "the daemon may answer server_info; the plugin SDK surface cannot reach it, so feature flags are uncheckable from here",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.paseoDisabledTools,
      family: null,
      probeId: null,
      status: "supported",
      source: "paseo-src",
      sourceRef: src("packages/server/src/server/agent/provider-registry.ts"),
      evidenceKind: STATIC,
      evidenceRef: "ProviderPaseoToolsPolicy.disabledTools filters Paseo built-in tools per provider entry",
      observedAt: null,
      limitations: [
        "deny-list over Paseo built-ins only — it cannot remove MCP tools, shell or raw client access",
        "it cannot grant or preapprove; configured values are not projected in P0 and effective policy is not observable",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.modelResolution,
      family: null,
      probeId: null,
      status: "supported",
      source: "paseo-src",
      sourceRef: src("packages/protocol AgentSnapshotPayload.runtimeInfo.model"),
      evidenceKind: observed.agentsList === true ? "host-observation" : STATIC,
      evidenceRef: "agents.list entries expose requested `model` and effective `runtimeInfo.model` side by side",
      observedAt: observed.agentsList === true ? now : null,
      limitations: [
        "runtimeInfo is optional — before the runtime reports, effective model is unknown, never equal-by-default to the request",
        "requested catalog model is not proof of effective: observed requested swe-2-max vs runtimeInfo swe-2-high (Lead 2026-09-28)",
        "snapshot/persistence keep the requested value; only runtimeInfo reflects the resolved model",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.mcpRecordPersistence,
      family: null,
      probeId: null,
      status: "supported",
      source: "paseo-src",
      sourceRef: MANAGER_SRC,
      evidenceKind: STATIC,
      evidenceRef: "config rebuild on resume restores record.config.mcpServers (agent-manager.ts:185)",
      observedAt: null,
      limitations: [
        "record persistence is not provider-session re-delivery — probe (d) holds the live question",
        "Pi handle.metadata keeps only cwd + model ids; systemPrompt/mcpServers survive via daemon-record overrides",
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.deskLedger,
      family: null,
      probeId: null,
      status: "unsupported",
      source: "none",
      sourceRef: null,
      evidenceKind: "none",
      evidenceRef: null,
      observedAt: now,
      limitations: [
        limitation("C-DL"),
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.deskBridgeTransport,
      family: null,
      probeId: null,
      status: observed.deskBridge === "listening"
        ? "supported"
        : observed.deskBridge === "unavailable"
          ? "unsupported"
          : "unknown",
      source: "host-file",
      sourceRef: "<stableRoot>/state/enforcement/desk.sock + reserved-repo lifecycle lock",
      evidenceKind: observed.deskBridge === undefined || observed.deskBridge === null ? STATIC : "host-observation",
      evidenceRef: "desk-bridge adapter state observed by this view's caller",
      observedAt: observed.deskBridge === "listening" ? now : null,
      limitations: [
        "unix-domain socket only — Windows is a typed CAPABILITY_GAP with no named-pipe fallback",
        "a listening socket is not seat delivery — MCP stdio env arrival stays probe (b), unproven until a live seat",
        "desk-busy and lifecycle-lock gaps are process-wide, not per-seat",
      ],
    }),
  ];
}

export interface FamilyFacts {
  /** Overrides for facts measured against a newer installed build; omitted
   *  families keep their historical source pins. These are static evidence. */
  contractRef?: string;
  resumeRef?: string;
  /** Registry contract flag for exact MCP preapproval (provider-registry.ts). */
  exactPreapproval: boolean;
  /** Source ref backing this family's stdio MCP launch path. */
  mcpLaunchRef: string;
  mcpLaunchEvidence: string;
  /** Resume-side mcpServers behaviour observed in source. */
  resumeEvidence: string;
  resumeLimitation: string | null;
}

// Keyed by FamilyId — the registry's own universe, so a key outside
// plugin/shared/runtime/families.ts cannot compile in. Keys are optional on purpose:
// a registry family landing ahead of its curation must not crash the audit —
// auditCapabilities fails closed with a typed gap per fact-dependent row.
const FAMILY_FACTS: Partial<Record<FamilyId, FamilyFacts>> = {
  opencode: {
    exactPreapproval: false,
    contractRef: "@getpaseo/server@0.10.3:dist/server/server/agent/provider-registry.js#PROVIDER_CONTRACTS.acp",
    mcpLaunchRef: "@getpaseo/server@0.10.3:dist/server/server/agent/providers/acp-agent.js#acpMcpServers",
    mcpLaunchEvidence: "generic ACP carries stdio command/args/env in session/new when OpenCode advertises MCP support; live child-env delivery unproven",
    resumeRef: "@getpaseo/server@0.10.3:dist/server/server/agent/providers/acp-agent.js#resumeSession",
    resumeEvidence: "generic ACP restores config and sends cwd+mcpServers on load/resume; the wrapper rearms entry delivery",
    resumeLimitation: "ACP capability supportsMcpServers gates MCP; exact MCP preapproval and actual model delivery on ACP are not proven",
  },
  codex: {
    exactPreapproval: true,
    mcpLaunchRef: src("packages/server/src/server/agent/providers/codex/codex-app-server-agent.ts"),
    mcpLaunchEvidence: "toCodexMcpConfig passes config.env verbatim into the codex MCP server config",
    resumeEvidence: "daemon record restores mcpServers; codex session config is rebuilt from stored config",
    resumeLimitation: "Codex MCP child-environment delivery is unproven; process-inspection fallback is prohibited",
  },
  pi: {
    exactPreapproval: false,
    mcpLaunchRef: src("packages/server/src/server/agent/providers/pi/agent.ts"),
    mcpLaunchEvidence: "createPiMcpConfigFile merges config.mcpServers into a generated 0600 mcp.json for the session",
    resumeEvidence: "buildResumeConfig spreads daemon-record overrides → prepareMcpConfig reruns on resume; Pi metadata drops mcpServers",
    resumeLimitation: "survival depends on the daemon record path — provider-side metadata alone would drop mcpServers",
  },
  devin: {
    exactPreapproval: false,
    mcpLaunchRef: src("packages/server/src/server/agent/providers/acp-agent.ts"),
    mcpLaunchEvidence: "acpMcpServers() normalizes config.mcpServers into session/new when the provider advertises MCP support",
    resumeEvidence: "session/load and unstable_resumeSession re-send cwd+mcpServers (acp-agent.ts:1753–1791)",
    resumeLimitation: "ACP capability supportsMcpServers gates the whole surface — a provider without it gets [] silently",
  },
  claude: {
    exactPreapproval: true,
    mcpLaunchRef: src("packages/server/src/server/agent/providers/claude/agent.ts"),
    mcpLaunchEvidence: "normalizeMcpServers feeds this.config.mcpServers into the spawn config; provider metadata restores mcpServers (agent.ts:985)",
    resumeEvidence: "claude persists mcpServers in its own provider metadata as well as the daemon record",
    resumeLimitation: null,
  },
};

/** Probe (a) row — host-lifecycle evidence, independent of family facts. */
function probeSessionOpenEnvRecord(family: FamilyId): CapabilityRecordValue {
  return record({
    schemaVersion: 1,
    capabilityId: CAPABILITY_IDS.probeSessionOpenEnv,
    family,
    probeId: "a",
    status: "unknown",
    source: "paseo-src",
    sourceRef: LIFECYCLE_SRC,
    evidenceKind: STATIC,
    evidenceRef: "session_open env lands in the agent launch context; no surface reports the MCP child's effective env",
    observedAt: null,
    limitations: [
      "live evidence requires a probe seat on this family with a desk MCP server — none is authorized at P0",
      "forbidden fallbacks stay forbidden: no /proc scraping, no transcript reads, no agent self-report",
    ],
  });
}

/** Probe (c) row — host-lifecycle evidence, independent of family facts. */
function probeCreateEnvEchoRecord(family: FamilyId): CapabilityRecordValue {
  return record({
    schemaVersion: 1,
    capabilityId: CAPABILITY_IDS.probeCreateEnvEcho,
    family,
    probeId: "c",
    status: "unknown",
    source: "paseo-src",
    sourceRef: LIFECYCLE_SRC,
    evidenceKind: STATIC,
    evidenceRef: "session_open request.env exists in the hook schema; whether create-supplied env lands there is unobserved",
    observedAt: null,
    limitations: [
      "create_agent has no env field; observing request.env needs hook instrumentation (plugin change + install: Human authority)",
    ],
  });
}

/** A registry family whose facts were never curated: every fact-dependent
 *  row fails closed to `unknown` and emits a typed gap, rather than crashing
 *  on an undefined lookup or fabricating evidence. */
function familyRecords(
  now: string,
  family: FamilyId,
  facts: FamilyFacts | undefined,
): { records: CapabilityRecordValue[]; gaps: CapabilityGapValue[] } {
  const gaps: CapabilityGapValue[] = [];
  /** Fact-dependent row for an uncurated family: unknown + typed gap. */
  const missingFacts = (
    capabilityId: CapabilityId,
    probeId: CapabilityRecordValue["probeId"],
  ): CapabilityRecordValue => {
    gaps.push(gap({
      capabilityId,
      family,
      missingPrimitive: `curated capability facts (FAMILY_FACTS) for registry family '${family}'`,
      neededBy: `capability row '${capabilityId}'`,
      ownerAction: "extend FAMILY_FACTS for the new registry family — the audit cannot claim evidence it does not hold",
    }));
    return record({
      schemaVersion: 1,
      capabilityId,
      family,
      probeId,
      status: "unknown",
      source: "none",
      sourceRef: null,
      evidenceKind: "none",
      evidenceRef: null,
      observedAt: null,
      limitations: [
        `registry family '${family}' has no FAMILY_FACTS curation — audit fails closed to unknown, never fabricated`,
      ],
    });
  };

  if (facts === undefined) {
    return {
      records: [
        missingFacts(CAPABILITY_IDS.toolPolicyPreapproval, null),
        missingFacts(CAPABILITY_IDS.mcpStdioLaunch, null),
        probeSessionOpenEnvRecord(family),
        missingFacts(CAPABILITY_IDS.probeCreateMcpEnv, "b"),
        probeCreateEnvEchoRecord(family),
        missingFacts(CAPABILITY_IDS.probeMcpResume, "d"),
      ],
      gaps,
    };
  }

  const rows: CapabilityRecordValue[] = [
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.toolPolicyPreapproval,
      family,
      probeId: null,
      status: facts.exactPreapproval ? "supported" : "unsupported",
      source: "paseo-src",
      sourceRef: facts.contractRef ?? REGISTRY_SRC,
      evidenceKind: STATIC,
      evidenceRef: facts.exactPreapproval
        ? `PROVIDER_CONTRACTS.${family}.supportsExactMcpPreapproval === true`
        : `${family} → UNSUPPORTED_PROVIDER_CONTRACT.supportsExactMcpPreapproval === false — daemon rejects toolPolicy`,
      observedAt: null,
      limitations: [
        "preapproval suppresses permission prompts only — it is not a deny list and grants no authority",
        "the daemon requires every preapproved server to exist in the same request's mcpServers (validateToolPolicyServers)",
        ...(facts.exactPreapproval
          ? []
          : ["a desk MCP tool on this family can never be preapproved — every call may prompt the seat"]),
      ],
    }),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.mcpStdioLaunch,
      family,
      probeId: null,
      status: "supported",
      source: "paseo-src",
      sourceRef: facts.mcpLaunchRef,
      evidenceKind: STATIC,
      evidenceRef: facts.mcpLaunchEvidence,
      observedAt: null,
      limitations: [
        "static config plumbing is proven; whether the spawned MCP child actually receives env is probe (b) — unproven",
        "providers may merge/filter server env before spawn; config presence is not delivery",
      ],
    }),
    probeSessionOpenEnvRecord(family),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.probeCreateMcpEnv,
      family,
      probeId: "b",
      status: "unknown",
      source: "paseo-src",
      sourceRef: facts.mcpLaunchRef,
      evidenceKind: STATIC,
      evidenceRef: "mcpServers[x].env is carried into the provider's MCP config at create",
      observedAt: null,
      limitations: [
        "plumbing proven, delivery unproven — needs the same probe seat",
      ],
    }),
    probeCreateEnvEchoRecord(family),
    record({
      schemaVersion: 1,
      capabilityId: CAPABILITY_IDS.probeMcpResume,
      family,
      probeId: "d",
      status: "unknown",
      source: "paseo-src",
      sourceRef: facts.resumeRef ?? MANAGER_SRC,
      evidenceKind: STATIC,
      evidenceRef: facts.resumeEvidence,
      observedAt: null,
      limitations: [
        "live proof needs a seat created WITH mcpServers, then resume/refresh — creation itself is blocked by the create-surface gap",
        ...(facts.resumeLimitation ? [facts.resumeLimitation] : []),
      ],
    }),
  ];
  return { records: rows, gaps };
}

/** Missing primitives behind every BLOCKED probe branch — one row per probe
 *  so a fix can be scoped per provider. */
function probeGaps(family: FamilyId): CapabilityGapValue[] {
  return [
    gap({
      capabilityId: CAPABILITY_IDS.probeSessionOpenEnv,
      family,
      missingPrimitive:
        "a host surface that reports an MCP stdio child's effective env, and a probe seat on this family carrying a desk MCP server",
      neededBy: "probe (a): session_open env → MCP stdio child",
      ownerAction:
        "Lead creates a probe seat once a fixture MCP server is attachable; create_agent lacks env/mcpServers — escalate to Human",
    }),
    gap({
      capabilityId: CAPABILITY_IDS.probeCreateMcpEnv,
      family,
      missingPrimitive:
        "an authorized create path that supplies mcpServers[x].env to a seat on this family",
      neededBy: "probe (b): create-time mcpServers[x].env → MCP child",
      ownerAction: "same probe seat; the create surface gap is shared with (a)",
    }),
    gap({
      capabilityId: CAPABILITY_IDS.probeCreateEnvEcho,
      family,
      missingPrimitive:
        "visibility into session_open request.env on create — a create_agent env field, hook instrumentation, or host hook trace",
      neededBy: "probe (c): create env → session_open(reason:create) request.env",
      ownerAction: "Human/host change: instrumented plugin hook install is host configuration; no authorized read surface exists",
    }),
    gap({
      capabilityId: CAPABILITY_IDS.probeMcpResume,
      family,
      missingPrimitive:
        "an existing seat on this family created with mcpServers, plus an authorized resume/refresh trigger",
      neededBy: "probe (d): mcpServers survives resume/refresh",
      ownerAction: "same probe seat; resume is an operator action on the created agent",
    }),
  ];
}

/** The P0 audit. `observed` is supplied by the status handler — a row whose
 *  evidence depends on a live surface degrades to unknown when the surface
 *  was never exercised, never to supported. The audited family universe is
 *  the canonical registry (FAMILY_IDS), never a second list; `familyFacts`
 *  is the curated-evidence seam — a registry family with no facts entry
 *  fails closed to `unknown` rows plus typed gaps instead of crashing. */
export function auditCapabilities(input: {
  now: string;
  observed: CapabilityHostObservation;
  familyFacts?: Partial<Record<FamilyId, FamilyFacts>>;
}): { records: CapabilityRecordValue[]; gaps: CapabilityGapValue[] } {
  const facts = input.familyFacts ?? FAMILY_FACTS;
  try {
    const records = [...hostRecords(input.now, input.observed)];
    // The mandatory providerTools-projection gap leads so the wire cap can
    // never shed it behind family probe gaps (§2.1); the P2-d operator
    // transport gap follows it for the same reason.
    const gaps: CapabilityGapValue[] = [
      PROVIDER_TOOLS_PROJECTION_GAP,
      OPERATOR_MCP_TRANSPORT_GAP,
    ];
    for (const family of FAMILY_IDS) {
      const block = familyRecords(input.now, family, facts[family]);
      records.push(...block.records);
      gaps.push(...block.gaps, ...probeGaps(family));
    }
    return { records, gaps };
  } catch (error) {
    // A static constant or curated fact that fails its wire schema is a
    // producer bug: surface the typed conflict, never a bare ZodError (§2.1).
    if (error instanceof z.ZodError) {
      throw new OperationConflict(
        "IO_FAILURE",
        "capability audit produced a schema-invalid row — view withheld",
      );
    }
    throw error;
  }
}
