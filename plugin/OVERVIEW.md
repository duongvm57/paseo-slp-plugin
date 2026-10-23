Paseo SLP helps you delegate complex coding work to a coordinated team of agents without having to manage every agent yourself. A Lead owns coordination and integration; Peers take bounded implementation, design or review assignments; an optional Supervisor observes the workflow and relays your decisions. You keep control of goals, important trade-offs and final acceptance.

The plugin loads each agent's role instructions and keeps shared work records in Paseo, so you can inspect who owns the work, what decisions were made and what evidence supports the result.

## When to use it

- Work has strong dependencies between steps, and implementation may expose a faulty assumption.
- Architecture, lifecycle or ownership needs clarification as work proceeds.
- Multiple modules, projects, workspaces or owners need to coordinate across integration boundaries.
- Long or complex work needs decisions and responsibility to survive interruptions or handoffs.

For small tasks with clear contracts and few dependencies, such as simple CRUD or extensions following an existing pattern, one agent is often enough. Use SLP when coordination provides more value than its overhead.

## How work is organized

Give an **SLP Lead** a bounded objective, or work through an **SLP Supervisor**. The Lead chooses and creates the Peers needed for the task. Peers form independent judgments: they can challenge an assumption, request a missing dependency or report that work is blocked. Each moving scope has one writer.

Set up `.paseo-slp/workspace-protocol.md` for minimum sufficient coordination. A clear, bounded task can start with one Peer Engineer; the Lead adds an Architect or Reviewer when needed. The Supervisor is optional.

The repository desk preserves assignments, current briefs, decisions, dependencies, review and evidence. Its task queue supports Lead-invoked dispatch and integration, and planned handoff keeps an assignment's history. Open **Read SLP work** to inspect these records in the workspace. The desk distinguishes reported results from measured evidence; final acceptance stays with you.

Each team member is an ordinary Paseo agent you can open and chat with. Agents can use Codex, Pi, Devin, Claude Code, OpenCode or Antigravity, with different providers and models in the same team.

## What this changes in practice

| Coordination problem | SLP practice |
| --- | --- |
| Workers inherit a pre-solved answer | The Lead delegates outcomes; Peers can challenge the premise. |
| Parallel agents overwrite each other's work | One writer per moving scope, with declared ownership and repository isolation tactics. |
| Review approves an author's framing or an outdated change | Independent judgment on a stable candidate, with review revisited when the brief, scope or candidate changes. |
| An idle agent or passing tests are treated as completion | The Lead assesses the integrated candidate and its evidence; you retain final acceptance. |

## Setup

1. Enable the provider families you use in Paseo's agent settings, then open **SLP** in the sidebar and run **Inspect**.
2. Open **Maintenance > Runtime setup** and choose **Activate SLP runtime**. Keep other writers of Paseo's `config.json` out while it runs.
3. In **SLP > Profiles**, choose a provider and an explicit model for the Supervisor and the Lead, then choose **Save profiles**. A successful save applies the choices to future launches.
4. For each repository, onboard it with the `paseo-slp-onboarding` skill. It proposes `.paseo-slp/workspace-protocol.md` and the Peer pool, and shows the diff before writing.
5. Make sure the Peer pool has at least one enabled option, then start a task by creating an agent with the SLP Supervisor or SLP Lead profile.

For example: `Fix the checkout total rounding bug. Report back with the candidate and the checks you ran.`

Installing the plugin, or activating it, does not create any agent.

See the [README](https://github.com/duongvm57/paseo-slp-plugin#readme) for the full setup and operating guide.

## Settings and limits

- The SLP manager configures Supervisor/Lead models and the Peer pool of allowed runtimes. Engineer, Architect and Reviewer assignments come from the Lead's task brief, independently of the runtime choice.
- Optional features are off by default: a shared communication language, one designated Peer quota fallback, Jev-assisted runtime routing, and communication supervision that assesses captured Peer handbacks and Lead handling and can alert a Supervisor.
- A repository can pin its own Peer pool in `.paseo-slp/slp-routing.json`. A pinned pool takes precedence over the shared pool.
- Role changes affect future launches, not sessions that are already running.
- The plugin refuses to overwrite a provider or profile it does not own, and it stops with `RECOVERY_REQUIRED` when the configuration changed outside its journal.
- Role rules guide agents. Repository and shell permissions still come from Paseo and the provider.
- Antigravity supports full access only: its CLI automatically approves tools, subject to native policy denial. Thinking effort is part of the model ID. Its MCP integration supports stdio and Streamable HTTP; legacy SSE and explicit tool-policy preapproval are unsupported. Inherited native MCP services remain available; session routing does not sandbox tools. See [Antigravity support](https://github.com/duongvm57/paseo-slp-plugin/blob/main/docs/antigravity.md) for resume restrictions and evidence limits.

## Data, filesystem, subprocess and network access

- **Paseo configuration:** activation patches Paseo's `config.json` to add the providers and profiles and to enable MCP injection. Deactivating removes them.
- **Plugin state:** the plugin keeps its runtime files, journal and settings under `<daemonHome>/slp-runtime/`, including the shared Peer pool. Jev keys are stored there in files with 0600 permissions.
- **Temporary files:** Antigravity sessions use private directories under the host's temporary directory for MCP customization and attached images, removed when the session closes, including failed opens. MCP endpoints and credentials travel in the current process environment rather than those customization files. The adapter does not edit shared Antigravity configuration or workspace customization files.
- **Repository files:** the plugin reads `.paseo-slp/` files in repositories you onboard. It does not write your repository's routing catalog. Desk records are not stored in your repository. They live in a folder per repository inside the plugin's runtime state directory. Task integration applies a bounded change to a target repository only when the Lead invokes it, and uses Git worktrees for isolated placement.
- **Subprocesses:** the plugin finds Node and the provider CLIs on the daemon's `PATH` and runs short version probes against them. It runs Git when a Lead dispatches or integrates a task. A desk check can run only one of three fixed classes: a ledger integrity check, the repository's generated-payload check, or `git rev-parse HEAD`, run in the candidate's checkout. It also runs the bundled offline `slp.mjs` helper for launch validation. Paseo requests each seat; for Antigravity, this plugin's provider runs `agy` for version/model discovery and sessions, plus Node relays and the session's configured stdio MCP commands.
- **Network and credentials:** agent CLIs send prompts, code/context and tool results to the model services configured for your account. Antigravity's Streamable HTTP MCP relays send requests and configured authentication headers to the session's MCP endpoints; stdio MCP commands can use their own network connections. If you enable Jev-assisted routing or communication supervision, the configured inputs or captured communications are also sent to the Jev service you choose, either OpenRouter or the TypeSafe System One API. Review those services, permissions and costs before using them.
- **Tracking:** the plugin does not call external trackers or connectors.

## Requirements

- Paseo daemon and app 0.11.0 or later, with plugins enabled and MCP enabled.
- A Linux or macOS daemon host. Windows is not supported.
- Node.js 22.18 or later in the 22 line, or Node.js 23.6 or later, for native TypeScript.
- The CLI of each provider family you use, signed in on the daemon host.
- Antigravity requires agy 1.4.4 or newer and this manager plugin; the standalone installer does not register its providers.
