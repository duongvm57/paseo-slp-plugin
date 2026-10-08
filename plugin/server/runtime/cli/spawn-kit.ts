import { roles, orchestrates } from './profiles.ts';

// The spawn-kit is the package-owned approximation of the Paseo MCP surface a
// role actually needs, so a spawning-capable seat does not re-derive tool
// schemas through mcp_list_tools output truncation and overflow grepping
// (a measured ~40s-2min tax per seat). Signatures are concise
// `name(arg: type, ...)` strings with required arguments unmarked and
// optional ones suffixed `?`; unfamiliar parameters or an observed mismatch
// trigger a specific live schema lookup, rather than a full catalog dump.

const orchestratingTools = [
  'slp_seat_create(requestId: string, role: "lead", taskLabel: string, assignment: string, grantRef: string, delivery?: "caller" | "server")',
  'slp_seat_create(requestId: string, role: "peer", taskLabel: string, assignment: string, grantRef: string, runtime: { optionId: string, catalogSha256: string, decision?: object }, disposition?: string, delivery?: "caller" | "server")',
  'slp_task_deliver(requestId: string, assignmentId: string, expectedLedgerRevision: integer, expectedBriefRevision: integer, expectedOwnershipRevision: integer, task: object, runtime: object, text: string, placement?: object)',
  'slp_task_get(assignmentId: string, taskId: string, attemptId?: string, expectedLedgerRevision?: integer)',
  'slp_operation_get(requestId: string, kind: "seat-create" | "task-deliver")',
  'create_agent(title: string, provider: string, initialPrompt: string, workspaceId?: string, settings?: { modeId?: string, thinkingOptionId?: string, features?: object }, labels?: object, notifyOnFinish?: boolean)',
  'send_agent_prompt(agentId: string, prompt: string, sessionMode?: string, background?: boolean, notifyOnFinish?: boolean)',
  'create_workspace(isolation: "local" | "worktree", path?: string, projectId?: string, title?: string, mode?: "branch-off" | "checkout-branch" | "checkout-pr", worktreeSlug?: string, branchName?: string, baseBranch?: string, branch?: string, prNumber?: integer, forge?: string)',
  'list_workspaces()',
  'list_providers()',
  'list_profiles()',
  'list_agents(includeArchived?: boolean, cwd?: string, sinceHours?: integer, statuses?: string[], limit?: integer)',
  'get_agent_status(agentId: string)',
  'get_agent_activity(agentId: string, limit?: number)',
  'create_heartbeat(prompt: string, cron: string, timezone?: string, name?: string, maxRuns?: integer, expiresIn?: string)',
  'delete_heartbeat(id: string)',
  'cancel_agent(agentId: string)',
];

// A Peer never spawns; it only reports to its owner and checks its own status.
const peerTools = [
  'slp_status()',
  'slp_handback_submit(requestId, assignmentId, recordV1, candidateId: string | null)',
  'slp_task_hold(requestId, assignmentId, taskId, attemptId: string | null, holdId: string | null, expectedLedgerRevision?, expectedBriefRevision?, expectedOwnershipRevision?, expectedTaskRevision?, hold: object | null, ruling: object | null)',
  'slp_task_get(assignmentId: string, taskId: string, attemptId?: string, expectedLedgerRevision?: integer)',
  'send_agent_prompt(agentId: string, prompt: string, sessionMode?: string, background?: boolean, notifyOnFinish?: boolean)',
  'get_agent_status(agentId: string)',
];

export function spawnKit(role: string) {
  if (!roles.includes(role)) throw new Error('Unknown role');
  return {
    note: orchestrates(role)
      ? 'approximate; consult the specific live schema for unfamiliar parameters or a mismatch'
      : 'approximate; see tools/list; agentId: full id, not list_agents shortId; without slp_desk tools, hand back with one native send_agent_prompt report',
    tools: orchestrates(role) ? [...orchestratingTools] : [...peerTools],
  };
}
