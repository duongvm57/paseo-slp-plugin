import { roles, orchestrates } from './profiles.ts';

// The spawn-kit is the package-owned approximation of the Paseo MCP surface a
// role actually needs, so a spawning-capable seat does not re-derive tool
// schemas through mcp_list_tools output truncation and overflow grepping
// (a measured ~40s-2min tax per seat). Signatures are concise
// `name(arg: type, ...)` strings with required arguments unmarked and
// optional ones suffixed `?`; the seat still verifies against live
// mcp_list_tools before relying on any parameter detail.

const orchestratingTools = [
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
  'send_agent_prompt(agentId: string, prompt: string, sessionMode?: string, background?: boolean, notifyOnFinish?: boolean)',
  'get_agent_status(agentId: string)',
];

export function spawnKit(role: string) {
  if (!roles.includes(role)) throw new Error('Unknown role');
  return {
    note: 'approximate; verify against live mcp_list_tools',
    tools: orchestrates(role) ? [...orchestratingTools] : [...peerTools],
  };
}
