Paseo SLP adds a Supervisor, Lead and Peer team of coding agents to Paseo. You give a Lead a bounded objective, or work through an optional Supervisor. The Lead frames the work, coordinates independent Peers, integrates their results and returns a project verdict. You keep control of intent, important trade-offs and final acceptance.

## What it adds

- Up to 15 providers named `slp-<family>-<role>`, and two profiles: **SLP Supervisor** and **SLP Lead**. Seats can run on Codex, Pi, Devin, Claude Code or OpenCode, and can be mixed in one team.
- Role instructions that are loaded when a seat starts, separate from your task prompt.
- A Peer pool: the set of runtime options the Lead picks from for each Peer.
- A repository desk with durable assignments, briefs, decisions, declared scopes, selected review, and candidate and check evidence.
- A native task queue for large objectives, and planned handoff of an assignment to another Lead.
- A sidebar manager, and a read-only **SLP work** panel opened with **Read SLP work** from the command palette.
- Optional features, all off by default: a shared communication language, Peer quota fallback, Jev-assisted routing, and communication supervision.

## How it works

Each seat is an ordinary Paseo agent. Paseo stays the only control plane, and the plugin does not run its own scheduler or agent database. Each moving scope has one writer, and Peers do not spawn other agents. The desk keeps handback claims separate from measured candidate and check evidence. It does not infer acceptance from a handback, an agent status or a passing check. Acceptance stays with you.

## Setup

1. Enable the provider families you use in Paseo's agent settings, then open **SLP** in the sidebar and run **Inspect**.
2. Choose **Activate SLP runtime**. Keep other writers of Paseo's `config.json` out while it runs.
3. In **SLP > Profiles**, choose a provider and an explicit model for the Supervisor and the Lead, then save.
4. For each repository, onboard it with the `paseo-slp-onboarding` skill. It proposes `.paseo-slp/workspace-protocol.md` and the Peer pool, and shows the diff before writing.
5. Make sure the Peer pool has at least one enabled option, then start a task by creating an agent with the SLP Supervisor or SLP Lead profile.

Installing the plugin, or activating it, does not create any agent.

## Settings and limits

- Role choices, the Peer pool, and the optional features are configured in the SLP manager. Optional features are off until you turn them on.
- A repository can pin its own Peer pool in `.paseo-slp/slp-routing.json`. A pinned pool takes precedence over the shared pool.
- Role changes affect future launches, not sessions that are already running.
- The plugin refuses to overwrite a provider or profile it does not own, and it stops with `RECOVERY_REQUIRED` when the configuration changed outside its journal.
- Role rules guide agents. Repository and shell permissions still come from Paseo and the provider.

## Data, filesystem, subprocess and network access

- **Paseo configuration:** activation patches Paseo's `config.json` to add the providers and profiles and to enable MCP injection. Deactivating removes them.
- **Plugin state:** the plugin keeps its runtime files, journal and settings under `<daemonHome>/slp-runtime/`, including the shared Peer pool. Jev keys are stored there in files with 0600 permissions.
- **Repository files:** the plugin reads `.paseo-slp/` files in repositories you onboard. It does not write your repository's routing catalog. Desk records are not stored in your repository. They live in a folder per repository inside the plugin's runtime state directory. Task integration applies a bounded change to a target repository only when the Lead invokes it, and uses Git worktrees for isolated placement.
- **Subprocesses:** the plugin finds Node and the provider CLIs on the daemon's `PATH` and runs short version probes against them. It runs Git when a Lead dispatches or integrates a task. A desk check can run only one of three fixed classes: a ledger integrity check, the repository's generated-payload check, or `git rev-parse HEAD`, run in the candidate's checkout. It also runs the bundled offline `slp.mjs` helper for launch validation. Seats themselves are launched through Paseo.
- **Network:** none by default. If you enable Jev-assisted routing or communication supervision, the configured inputs or captured communications are sent to the Jev service you choose, either OpenRouter or the TypeSafe System One API. Review that service and its costs before enabling it.
- **Tracking:** the plugin does not call external trackers or connectors.

## Requirements

- Paseo daemon and app 0.11.0 or later, with plugins enabled and MCP enabled.
- A Linux or macOS daemon host. Windows is not supported.
- Node.js 22.18 or later in the 22 line, or Node.js 23.6 or later, for native TypeScript.
- The CLI of each provider family you use, signed in on the daemon host.
