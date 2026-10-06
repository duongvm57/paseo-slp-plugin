<h1 align="center">Paseo SLP</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <b>Supervisor – Lead – Peer</b> for <a href="https://paseo.sh">Paseo</a>: a team of coding agents
  that separates <i>kinds of judgment</i>, not a chain of command.
</p>

Give an **SLP Lead** a bounded objective, or work through an optional **SLP Supervisor**.
The Lead coordinates independent Peers, integrates their work and returns a project verdict.
Each seat is an ordinary Paseo agent with its role instructions loaded separately from your task.
You keep control of intent, important trade-offs and final acceptance.

The plugin also supplies a **repository desk**: durable assignments, current briefs, a native
task queue, declared scopes, selected review obligations, candidate/check evidence and planned owner handoff.
Open **Read SLP work** to inspect registered work without reconstructing it from chat.

![Paseo SLP: Human intent and acceptance, Lead and independent Peers, optional Supervisor, and a durable repository desk for work, review, proof and handoff](docs/images/slp-overview.svg)

https://github.com/user-attachments/assets/c4211582-997c-429e-96c1-438d5a13f11e

## How work progresses

1. **Set the objective.** Start an **SLP Lead**, or an **SLP Supervisor** that observes or creates a
   Lead. For example: `Fix the checkout total rounding bug. Report back with the candidate and
   the checks you ran.` The Supervisor observes workflow and relays your decisions; it stays
   outside implementation and project acceptance.
2. **Make ownership explicit.** The Lead frames acceptance, dependencies and risks, registers
   work in the desk and decomposes large objectives into tasks. Their dependencies, attempts,
   output judgments and open obligations survive interruption. Each moving scope has
   one writer. Peers can challenge a premise, request a dependency or report blocked.
3. **Select review for the work.** The Lead chooses independent mandates for material questions
   and Human/protocol requirements. There is no fixed reviewer pair or count. Scope changes,
   brief changes and new candidates can invalidate earlier review.
4. **Return evidence.** The desk keeps handback claims separate from candidate observations and
   actual check runs. The Lead resolves findings and disagreements, integrates the work and
   reports what the proof establishes and what remains uncertain.
5. **Continue without losing the work.** A planned handoff uses an owner offer and the receiving
   Lead's acknowledgment under revision checks, keeping the same assignment and history.
   Handoff and resource accounts do not establish project acceptance; that remains yours.

## Why not just subagents

A subagent API creates processes. It does not decide ownership, independent judgment, coordination
or acceptance, and more agents can raise confidence without raising correctness.

| Failure mode              | What goes wrong                                                   | What SLP does                                                           |
| ------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Authority gradient        | The child agrees with the answer the parent already presented     | Peers may challenge the premise; evidence settles it                    |
| Perfect-plan trap         | The coordinator pre-solves the work; the worker becomes a typist  | The Lead delegates outcomes, not file-by-file instructions              |
| Attention dilution        | The coordinator implements and loses the project-wide view        | The Lead integrates; the Supervisor never joins execution               |
| Unsafe parallelism        | Two agents overwrite the same moving files                        | One writer per moving scope; declared scopes and repo isolation tactics |
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
| Records assignments, briefs, decisions, scopes, selected review and candidate/check evidence | Stale revision pins, overlapping declared scopes and unqualified required reviews | Infers acceptance from a handback, an agent status or a green check |
| Keeps a native dependency queue and performs Lead-invoked dispatch and staged integration | Unruled or unavailable prerequisites, uncertain effect retries and target drift | Dispatches, retries, commits or lands work unattended |
| Supports planned owner handoff and a read-only workspace work panel                         | An acknowledgment that does not match a usable offer and current revision pins  | Transfers authority through a chat message or a resource account  |
| Offers opt-in Jev routing and communication supervision                                    | A Jev routing receipt that fails offline verification (hash, model, catalog)     | Enables external services without your configuration              |

Saved role choices narrow the Supervisor/Lead providers; all four Peer providers remain
pool-driven. Provider entries for unavailable CLIs are disabled. Pool checks apply to
`prepare` and native task dispatch. Role rules guide agents, while managed launch and desk checks cover their own
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

Peer Engineer is the default implementation writer. An explicit Human assignment or effective
workspace protocol can grant a bounded Lead write for clear, reversible work. One writer,
candidate proof and required independent review still apply; a tiny task grants no exemption.

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

## Work records and review

Open **Read SLP work** from the workspace command palette to see assignments registered in
that repository's desk. The **SLP work** panel shows the current brief, decision history,
declared owners and dependencies, review observations, and candidate/check evidence. Use
**Reload** for fresh state; missing or older records are shown explicitly. It does not infer
work from chats or accept a task for you.

For a large objective, the **Tasks** section shows the native queue, readiness reasons,
attempts, current result judgments and unresolved delivery/resource obligations. The Lead
invokes dispatch explicitly: reserve first, create without a work prompt, bind the registered
worker's scope, then send work. Dependencies require qualified output judgments and measured
availability. Integration stages and checks the combined candidate before applying a bounded
delta to the target; conflicts and uncertain effects stay recorded for reconciliation.
Stage and backup cleanup uses separately granted steps with finite continuation;
unresolved resources retain the target reservation.
See [native task execution](docs/task-execution.md) for the sequence and operational limits.

Assignment handoff keeps the same work ID and history: the current Lead offers it to an
exact receiving Lead membership, which acknowledges responsibility under revision checks.
The panel distinguishes current ownership and usable reviews from historical observations,
and shows handback/settlement claims separately from measurements. See
[assignment continuity](docs/work-continuity.md) for the sequence and its limits.

The owning Lead can append brief revisions and material decisions through the desk tools.
Brief, scope and review-plan changes make dependent reviews stale. Lead selects independent
mandates for material questions and Human/protocol requirements, without a fixed reviewer
pair or count. New scopes explicitly record required review, no applicable trigger, or an
authorized exemption. A no-trigger decision does not waive a mandatory gate.

Handbacks can also carry an optional structured execution, review or adjudication report.
The renderer preserves the original evidence block; handoff recaps separate supplied claims
from the freshly measured candidate and disclose missing context. See
[work coordination](docs/work-coordination.md) for the tools, report and continuity contract.

External trackers and project-specific automation belong to your workspace/harness. The plugin
uses its own desk and does not add a tracker card, tracker RPC or tracker session instructions.

## Optional capabilities

These capabilities are **off by default**. Configure them explicitly in the SLP manager;
quota fallback belongs to the selected Peer pool, including a repo-pinned pool.

| Capability                                                                  | What it adds                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Communication language](docs/operations.md#getting-started)                | Instructs managed seats to use one language with each other; replies to you follow your language       |
| [Peer quota fallback](docs/operations.md#peer-quota-fallback)               | One designated pool option the Lead may retry on once when a Peer runs out of quota                   |
| [Jev-assisted routing](docs/operations.md#jev-assisted-routing-optional)    | A calibrated routing receipt from Jev (TypeSafe System One): shadow mode records it, armed mode binds it |
| [Communication supervision](docs/operations.md#communication-supervision-optional) | Assesses captured Peer handbacks and Lead handling for configured Leads; records findings and optionally alerts a Supervisor |

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
npm test                          # runs in a temporary, isolated PASEO_HOME
npm run typecheck
npm run check                     # inspect the install-unit identity
npm run check:plugin-payload       # verify the generated payload is current
```

After changing install-unit sources (`package.json`, `install.sh`, `bin/`, `skills/`, `src/`,
`plugin/server/runtime/` or `plugin/shared/runtime/`), run `npm run generate:plugin-payload`,
then repeat the payload check. Local checks establish source behavior and payload freshness.

To dogfood live from a source checkout, ask an open session to *run the package's full E2E*. See
[docs/development.md](docs/development.md).

Both READMEs use the same overview SVG from `scripts/generate-readme-diagrams.mjs`.
After editing it, run `node scripts/generate-readme-diagrams.mjs`; use `--check` to verify the SVG.

## Docs

| Read                                             | When you want                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)     | The role model, what the plugin adds to Paseo, role delivery and delegation   |
| [docs/operations.md](docs/operations.md)         | Activation, upgrades, profiles, repository setup, the Peer pool, optional capabilities |
| [docs/cli.md](docs/cli.md)                       | The offline `slp.mjs` commands: `prepare`, `routes`, `route-decide`, `monitor` and the rest |
| [docs/work-coordination.md](docs/work-coordination.md) | Durable briefs, decisions, review mandates, reports and the read-only workspace panel |
| [docs/work-continuity.md](docs/work-continuity.md) | Planned owner handoff, acknowledgment, historical authority and remaining obligations |
| [docs/task-execution.md](docs/task-execution.md) | Native task queue, supervised dispatch, dependency proof, integration and reconciliation |
| [docs/contract.md](docs/contract.md)             | What every file owns, before you change it                                      |
| [docs/development.md](docs/development.md)       | Tests, verification status and the E2E harness                                  |
| [docs/decisions/](docs/decisions/)               | Durable decisions, one file each: what was decided, by whom and why             |
| [AGENTS.md](AGENTS.md)                           | The rules contributors and agents follow in this repository                     |

Technical contracts for individual capabilities live under [docs/spec/](docs/spec/).

<!-- Keep installation requirements, setup steps and examples synchronized with README.vi.md. -->

## License

MIT, see [LICENSE](LICENSE).
