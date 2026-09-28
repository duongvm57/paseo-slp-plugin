<h1 align="center">Paseo SLP</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <b>Supervisor – Lead – Peer</b> for <a href="https://paseo.sh">Paseo</a>: a team of coding agents
  that separates <i>kinds of judgment</i>, not a chain of command.
</p>

You open one **SLP Supervisor** session in Paseo and give it an objective. It observes or creates a
**Lead** for the work; the Lead splits the work into bounded outcomes and gives each to a **Peer**
that it picks from your Peer pool. Every seat is an ordinary Paseo agent. The plugin gives each one
its role contract, delegation rules and policy locators at session entry, so you never paste a role
prompt, and you keep talking to the Supervisor in the same chat.

![Paseo SLP role model: the Human owns intent and final acceptance; the Supervisor observes the Lead's workflow without joining execution; the Lead delegates bounded outcomes to independent Peers that return evidence, challenges, dependency requests or blocked work](docs/images/slp-role-model.svg)

## How a task goes

![A task, end to end: you give the Supervisor an objective; it observes or creates a Lead and stays out of execution; the Lead frames the work and delegates one bounded outcome to each Peer; Peers return evidence, challenges or blocked work; the Lead integrates behind a review gate; the Supervisor checks the handback and reports to you](docs/images/slp-task-flow.svg)

1. **You set the objective.** Start a new agent with the **SLP Supervisor** profile and say what you
   want, e.g. `Fix the checkout total rounding bug. Report back with verdict and the checks you ran.`
2. **The Supervisor stays out of execution.** It observes an existing Lead or creates one, protects
   the quality of the workflow (bias, repeated failure, lost momentum, drifting scope, weak evidence)
   and relays your decisions. It never implements or accepts the work.
3. **The Lead owns the project calls.** It frames the work, chooses the topology by risk (a single
   Engineer for a small fix; an Architect, an independent Reviewer or several lanes when lifecycle
   matters) and picks each Peer's provider and model from the pool.
4. **Peers are co-workers, not function calls.** Each owns one outcome. It may challenge the
   premise, ask for a dependency or stop as blocked. Disagreement is settled with evidence.
5. **You come back to a report** in the same Supervisor chat. Important trade-offs, exceptional
   grants and final acceptance stay yours.

## Why not just subagents

A subagent API creates processes. It does not decide ownership, independent judgment, coordination
or acceptance, and more agents can raise confidence without raising correctness.

| Failure mode              | What goes wrong                                                   | What SLP does                                                           |
| ------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Authority gradient        | The child agrees with the answer the parent already presented     | Peers may challenge the premise; evidence settles it                    |
| Perfect-plan trap         | The coordinator pre-solves the work; the worker becomes a typist  | The Lead delegates outcomes, not file-by-file instructions              |
| Attention dilution        | The coordinator implements and loses the project-wide view        | The Lead integrates; the Supervisor never joins execution               |
| Unsafe parallelism        | Two agents overwrite the same moving files                        | One writer per moving scope; separate worktrees for concurrent writers  |
| Biased or stale review    | The reviewer inherits the author's framing or reads moving files  | Independent review on a stable candidate                                |
| False completion          | `idle`, "done" and green tests are taken as proof                 | Acceptance needs the right artifact reviewed by the right authority     |
| Split control planes      | Workers spawn untracked workers                                   | Paseo is the only control plane; Peers never spawn                      |

The design rationale is in [docs/architecture.md](docs/architecture.md).

## What the plugin does, and what it doesn't

| It does                                                                                     | It refuses                                                                        | It never                                                         |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Registers 12 `slp-<family>-<role>` providers and the **SLP Supervisor** / **SLP Lead** profiles | To overwrite a provider or profile it does not own (`COLLISION`)                  | Creates an agent on install or activation                        |
| Injects each seat's role bundle at session entry, hidden from the agent tab                 | To guess when the config drifted outside its journal (`RECOVERY_REQUIRED`)        | Runs a scheduler or agent database; Paseo stays the control plane |
| Keeps a Peer pool that the Lead picks each Peer's runtime from                               | A Peer launch that does not come from a pool option                               | Writes your repository's routing catalog                          |
| Validates launch arguments offline (`prepare`), with named failures                          | Provider records that were edited after `list_providers` returned them            | Runs a monitoring daemon; `monitor` is a scan you invoke          |
| Offers opt-in Jev routing, communication supervision and a beads work tracker                | A Jev routing receipt that fails offline verification (hash, model, catalog)      | Installs or initializes beads                                     |

## The roles

| Role           | Owns                                                                                   | Never                                                   | Runtime comes from                      |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------- |
| **Human**      | Intent, important trade-offs, exceptional grants, protocol changes, final acceptance   | —                                                       | —                                       |
| **Supervisor** | The quality of the workflow and reasoning; relaying your decisions                     | Implements, or accepts the project                      | The **SLP Supervisor** profile          |
| **Lead**       | Framing, routing, dependencies, integration, the project verdict                       | Pre-solves hard work and hands Peers a typing job        | The **SLP Lead** profile                |
| **Peer**       | One bounded outcome, as an Engineer, Architect, Reviewer or Scout                      | Spawns other agents                                     | An option in the Peer pool, per task    |

Seats run on **Codex, Pi, Devin or Claude Code**, mixed freely: two Peers in the same team can use
different providers, models and effort levels.

## Installation

You need:

- Paseo `>=0.8.0 <0.11.0`, with `pluginsEnabled: true` and an effective `mcp.enabled: true`
- Node.js 22 or newer on the daemon host
- the CLI of each provider family you use (Codex, Pi, Devin, Claude), signed in on the daemon host;
  Pi needs repeatable `--append-system-prompt` support

```bash
paseo plugin install duongvm57/paseo-slp-plugin:plugin                # follow the default branch
paseo plugin install duongvm57/paseo-slp-plugin:plugin --ref <tag>    # or pin a release
```

Tags are listed on [Releases](https://github.com/duongvm57/paseo-slp-plugin/releases). Check it with
`paseo plugin ls`; the plugin should reach `running`. Installing changes no agent configuration until
you activate it.

## First run

1. **Activate.** Open **SLP** in Paseo's sidebar (or *Open SLP manager* from the command palette),
   check the daemon home it shows and choose **Activate**. **Inspect** is read-only if you want to
   look first.
2. **Pick models.** Under **Settings → your host → Agents → Agent profiles**, edit **SLP Supervisor** and
   **SLP Lead**: provider, model, thinking, mode.
3. **Onboard a repository.** Install the onboarding skill, then ask any agent in that repo to
   *onboard / set up SLP*. It proposes `.paseo-slp/workspace-protocol.md` and the Peer pool, and
   shows the full diff before writing.

   ```bash
   npx skills add duongvm57/paseo-slp-plugin --skill paseo-slp-onboarding
   ```

4. **Hand over a task.** Choose **New agent** in the repo's workspace, then the **SLP Supervisor**
   profile, and give it the title `Supervisor — <task>` and an objective. Then keep chatting there.

A few optional lines make an objective more robust:

| Line               | Use it when                                                                        |
| ------------------ | ---------------------------------------------------------------------------------- |
| `Repository: …`    | The session's workspace may not be the target, or the task spans repositories      |
| `Report back …`    | Always: it marks a bounded assignment with a deliverable, not an open conversation |
| `Heartbeat: …`     | Long work, e.g. `Heartbeat: sweep every 30m until handback`                         |

No skills installed? Paste this into any agent: *"Help me set up Paseo SLP. Read
https://raw.githubusercontent.com/duongvm57/paseo-slp-plugin/main/docs/agent-guide.md first, then
walk me through it step by step."*

## Optional capabilities

Everything below is **off by default** and configured on the SLP manager.

| Capability                                                                  | What it adds                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Communication language](docs/operations.md#getting-started)                | One language for everything seats write to each other; replies to you still follow your language      |
| [Peer quota fallback](docs/operations.md#peer-quota-fallback)               | One designated pool option the Lead may retry on once when a Peer runs out of quota                   |
| [Jev-assisted routing](docs/operations.md#jev-assisted-routing-optional)    | A calibrated routing receipt from Jev (TypeSafe System One): shadow mode records it, armed mode binds it |
| [Communication supervision](docs/operations.md#communication-supervision-optional) | Assesses each Peer handback and the Lead's handling of it; records findings, optionally alerts a Supervisor |
| [Work tracker](docs/operations.md#work-tracker-optional)                    | A beads (`bd`) work graph seats can query instead of rebuilding task state from chat                  |

## Updating and removal

```bash
paseo plugin update paseo-slp               # git source on the default branch
paseo plugin update paseo-slp --ref <tag>   # pinned: choose the new ref explicitly
paseo plugin reload paseo-slp               # directory install: after the checkout changes
```

To remove it, choose **Deactivate** on the SLP manager first (this removes the providers and
profiles and keeps the runtime files for sessions still running), then run
`paseo plugin remove paseo-slp`. Details are in [docs/operations.md](docs/operations.md#upgrading).

## Development

```bash
PASEO_HOME="$(mktemp -d)" npm test   # isolate from your live daemon, as CI does
npm run typecheck
npm run check:plugin-payload         # regenerate with npm run generate:plugin-payload after changing src/, bin/, skills/
```

To dogfood live from a source checkout, ask an open session to *run the package's full E2E*. See
[docs/development.md](docs/development.md).

## Docs

| Read                                             | When you want                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)     | The role model, what the plugin adds to Paseo, the hidden channel, delegation   |
| [docs/operations.md](docs/operations.md)         | Activation, upgrades, profiles, repository setup, the Peer pool, optional capabilities |
| [docs/cli.md](docs/cli.md)                       | The offline `slp.mjs` commands: `prepare`, `routes`, `route-decide`, `monitor` and the rest |
| [docs/contract.md](docs/contract.md)             | What every file owns, before you change it                                      |
| [docs/development.md](docs/development.md)       | Tests, verification status and the E2E harness                                  |
| [AGENTS.md](AGENTS.md)                           | The rules contributors and agents follow in this repository                     |

Specs and investigations live under [docs/spec/](docs/spec/) and [docs/reports/](docs/reports/).

## License

MIT, see [LICENSE](LICENSE).
