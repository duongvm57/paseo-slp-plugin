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
its role contract, delegation rules and policy locators at session entry, separate from your task
prompt. You keep talking to the Supervisor in the same chat. You can also start directly with an
**SLP Lead**; the Supervisor is an optional observer of the workflow.

![Paseo SLP at a glance: the Human owns intent and final acceptance; the Lead delegates bounded outcomes to independent Peers; an optional Supervisor observes workflow and relays decisions; the plugin supplies role instructions and checked preparation](docs/images/slp-overview.svg)

## How a task goes

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
| Registers up to 12 `slp-<family>-<role>` providers and the **SLP Supervisor** / **SLP Lead** profiles | To overwrite a provider or profile it does not own (`COLLISION`)             | Creates an agent on install or activation                        |
| Loads each seat's role instructions at session entry, separate from the task prompt         | To guess when the config drifted outside its journal (`RECOVERY_REQUIRED`)        | Runs a scheduler or agent database; Paseo stays the control plane |
| Keeps a Peer pool that the Lead picks each Peer's runtime from                               | A Peer binding outside the pool during `prepare`                                 | Writes your repository's routing catalog                          |
| Validates launch arguments offline (`prepare`), with named failures                          | Unverified or incompatible provider inventory supplied to `prepare`              | Runs a monitoring daemon; `monitor` is a scan you invoke          |
| Offers opt-in Jev routing, communication supervision and a beads work tracker                | A Jev routing receipt that fails offline verification (hash, model, catalog)      | Installs or initializes beads                                     |

Saved role choices narrow the Supervisor/Lead providers; all four Peer providers remain
pool-driven. Provider entries for unavailable CLIs are disabled. The pool check above belongs to
`prepare`. Role rules guide agents, while managed launch and desk checks cover their own
interfaces; repository and shell permissions still come from Paseo and the provider.

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

- Paseo `>=0.8.0`, with `pluginsEnabled: true` and an effective `mcp.enabled: true`
- a POSIX daemon host (Linux/macOS), with Node.js 22.x from 22.18, or Node.js 23.6+
  (native TypeScript stripping)
- the CLI of each provider family you use (Codex, Pi, Devin, Claude), signed in on the daemon host;
  Pi needs repeatable `--append-system-prompt` support

Enable the installed family you want to use in Paseo's agent settings before the first activation.

```bash
paseo plugin install duongvm57/paseo-slp-plugin:plugin                # follow the default branch
paseo plugin install duongvm57/paseo-slp-plugin:plugin --ref <tag>    # or pin a release
```

Tags are listed on [Releases](https://github.com/duongvm57/paseo-slp-plugin/releases). Check it with
`paseo plugin ls`; the plugin should reach `running`. Installing changes no agent configuration until
you activate it.

## First run

1. **Activate.** Open **SLP** in Paseo's sidebar (or *Open SLP manager* from the command palette),
   choose **Inspect**, confirm **Daemon home confirmed** and **Exclusive configuration window**,
   then choose **Activate**. Keep other configuration writers out while it runs.
2. **Pick role models.** In **SLP → Role profiles**, choose a provider and an explicit model for
   **Supervisor** and **Lead**, plus mode, thinking and features where offered. Choose **Save**,
   then run the activation action again (**Re-verify binding** or **Rebind**) to apply the choices.
   Saving alone does not apply them. Models must be set before delegation; Devin uses `swe-2`
   models. Changes affect future launches, not sessions already running.
3. **Onboard a repository.** Install the onboarding skill, then ask any agent in that repo to
   *onboard / set up SLP*. It proposes `.paseo-slp/workspace-protocol.md` and the Peer pool, and
   shows the full diff before writing.

   ```bash
   npx skills add duongvm57/paseo-slp-plugin --skill paseo-slp-onboarding
   ```

4. **Make the Peer pool ready.** If the repo inherits the shared pool, use **SLP → Peer pool** to
   add suitable options with provider, model and available settings, enable them and **Save**.
   If onboarding pins `.paseo-slp/slp-routing.json`, configure that file's options during
   onboarding. The Manager edits the shared pool; a repo pin takes precedence, and an empty or
   invalid pin does not fall back to it.
5. **Hand over a task.** Choose **New agent** in the repo's workspace, then the **SLP Supervisor**
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

These capabilities are **off by default**. Configure them explicitly in the SLP manager;
quota fallback belongs to the selected Peer pool, including a repo-pinned pool.

| Capability                                                                  | What it adds                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Communication language](docs/operations.md#getting-started)                | Instructs managed seats to use one language with each other; replies to you follow your language       |
| [Peer quota fallback](docs/operations.md#peer-quota-fallback)               | One designated pool option the Lead may retry on once when a Peer runs out of quota                   |
| [Jev-assisted routing](docs/operations.md#jev-assisted-routing-optional)    | A calibrated routing receipt from Jev (TypeSafe System One): shadow mode records it, armed mode binds it |
| [Communication supervision](docs/operations.md#communication-supervision-optional) | Assesses captured Peer handbacks and Lead handling for configured Leads; records findings and optionally alerts a Supervisor |
| [Work tracker](docs/operations.md#work-tracker-optional)                    | A beads (`bd`) work graph seats can query instead of rebuilding task state from chat                  |

Jev-powered routing and supervision send the configured inputs or captured communications to
your chosen Jev service. Review that service and its costs before enabling them.

## Updating and removal

```bash
paseo plugin update paseo-slp               # git source on the default branch
paseo plugin update paseo-slp --ref <tag>   # pinned: choose the new ref explicitly
paseo plugin reload paseo-slp               # directory install: after the checkout changes
```

After an update or reload, open the SLP manager and run **Rebind** when it offers the new runtime.
Running sessions keep their existing process and role instructions; new launches use the new
binding. Managed session opens still require the plugin to be running.

To remove it, choose **Deactivate** on the SLP manager first (this removes the providers and
profiles and keeps the runtime files for sessions still running), then run
`paseo plugin remove paseo-slp`. Details are in [docs/operations.md](docs/operations.md#upgrading).

## Development

From a source checkout, install dependencies with `npm ci`, then run the local checks:

```bash
env -i HOME="$HOME" PATH="$PATH" PASEO_HOME="$(mktemp -d)" npm test  # clear inherited SLP runtime variables
npm run typecheck
npm run check                     # inspect the install-unit identity
npm run check:plugin-payload       # verify the generated payload is current
```

After changing install-unit sources (`package.json`, `install.sh`, `bin/`, `skills/`, `src/`,
`plugin/server/runtime/` or `plugin/shared/runtime/`), run `npm run generate:plugin-payload`,
then repeat the payload check. Local checks establish source behavior and payload freshness.

To dogfood live from a source checkout, ask an open session to *run the package's full E2E*. See
[docs/development.md](docs/development.md).

The localized README diagrams share one source: `scripts/generate-readme-diagrams.mjs`.
After editing it, run `node scripts/generate-readme-diagrams.mjs`; use `--check` to verify the SVGs.

## Docs

| Read                                             | When you want                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)     | The role model, what the plugin adds to Paseo, role delivery and delegation   |
| [docs/operations.md](docs/operations.md)         | Activation, upgrades, profiles, repository setup, the Peer pool, optional capabilities |
| [docs/cli.md](docs/cli.md)                       | The offline `slp.mjs` commands: `prepare`, `routes`, `route-decide`, `monitor` and the rest |
| [docs/contract.md](docs/contract.md)             | What every file owns, before you change it                                      |
| [docs/development.md](docs/development.md)       | Tests, verification status and the E2E harness                                  |
| [AGENTS.md](AGENTS.md)                           | The rules contributors and agents follow in this repository                     |

Specs and investigations live under [docs/spec/](docs/spec/) and [docs/reports/](docs/reports/).
Earlier operating lessons are recorded in [Protocol experience (Vietnamese)](docs/protocol-experience.vi.md).

<!-- Keep installation requirements, setup steps and examples synchronized with README.vi.md. -->

## License

MIT, see [LICENSE](LICENSE).
