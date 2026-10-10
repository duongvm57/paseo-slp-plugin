# Work coordination

The desk records work that a bound Lead explicitly registers. Chat history and
external trackers do not automatically become desk state. The Human assignment
and effective workspace protocol still determine authority and required review.

The [assignment continuity guide](work-continuity.md) describes planned owner
handoff, its revision checks and the obligations that remain with the work.
For decomposed objectives, [native task execution](task-execution.md) adds the
dependency queue, supervised dispatch, result adjudication and controlled
integration to the same desk.

## Read the work

In the repository's Paseo workspace, open **Read SLP work** from the command
palette. The **SLP work** panel lists registered assignments and shows their
current brief, historical decisions, declared ownership/dependencies, review,
candidate/check observations and a **Tasks** section with shared readiness,
current result qualification and full-ledger counts. Discovery uses the whole operative objective;
legacy registration text is used only without a structured brief. The header
shows current ownership, recorded membership state and the latest durable
acknowledgment, without claiming to observe host-agent liveness. **Reload** starts a fresh read; **Next page**
continues the same ledger revision. A changed ledger requires a reload.

The server verifies the served daemon home and freshly resolves the selected
workspace to its Git common directory. Worktrees of one repository share its
desk. A missing host capability, unreadable ledger or absent structured brief
is reported explicitly. A client cannot choose an arbitrary filesystem root.
The panel only reads: it does not grant authority, transfer ownership or accept
the project. Work kept in other artifacts remains outside this view.

The evidence section includes typed handback and settlement summaries.
Handbacks retain their record digest and size, supplied output references and
explicit `pending`, `ok` or `failed` observation. Their full report bodies stay
in the ledger. Settlement accounts show all recorded resource dispositions,
including `unknown`, and keep claimed exports separate from measured export
verification. A summary proves neither cleanup nor project acceptance.

Reviews show whether they qualify under current pins and independence, supply
a current requirement or belong to the standing approval. Historical findings
and disagreements remain visible. Human responses stay within 65536 UTF-8
bytes by reducing complete page items; a single complete header or record that
cannot fit produces `VIEW_TOO_LARGE`, rather than a shortened proof.

## Keep the operative assignment

The registering Lead remains immutable historical metadata. Fresh owner
commands use the current exact agent/membership tuple, which changes only
through a planned offer and receiving acknowledgment. Current and prior live
pinned owners, attached seats and usable offer nominees can read the work;
only the current owner can amend its brief or append a material decision.
Attach does not transfer ownership.

| Desk tool | Purpose |
|---|---|
| `slp_assignment_register` / `slp_assignment_attach` | Register a bounded assignment and attach its seats using the existing authority contract. |
| `slp_assignment_offer` / `slp_assignment_accept` | Nominate an exact receiving Lead and acknowledge responsibility under ownership, ledger and brief revision checks. Preserve the assignment ID and original history. |
| `slp_assignment_amend` | Append a complete brief under `expectedBriefRevision`; zero opens the first structured brief of a legacy assignment. |
| `slp_decision_append` | Record a proposition, ruling, reasons, supporting/contrary evidence and unresolved risk against the current brief revision. |
| `slp_workflow_get` | Read one assignment section with revision pins and counted, retrievable history. |
| `slp_scope_declare` / `slp_scope_review` / `slp_scope_transition` | Declare ownership and review obligations, record independent observations, then request a gated state transition. |

The operative brief separates objective and acceptance from authority-backed
constraints, provisional design, assumptions, unknowns and required proof. It
also records owned/excluded surfaces, dependencies and notification recipients.
Amendments retain their reason, authority pointer and affected owners. Material
decisions retain notification and outcome references; recording a notification
intent is not proof that anyone received it or changed the work.

History is append-only. Exact retries preserve idempotency; changed requests or
stale revision pins produce conflicts. Legacy assignments remain readable
without invented context. Reference pointers and declared ownership are claims;
the desk separately observes membership, durable integrity, candidates and
actual check execution through its existing interfaces.

## Declare the review obligation

Optional scope ownership identifies its writer, canonical relative paths,
shared resources, state/module owners and dependencies. Active declared overlap
is rejected. This covers declared surfaces, so the Lead must still account for
undeclared shared state and semantic dependencies. Isolation tactics belong in
the repository protocol.

Lead selects independent mandates for material questions and Human/protocol
requirements. A single mandate can cover related concerns; additional reviewers
need distinct questions or a separation requirement. Spec/Standards labels and
provider diversity are optional. Verification, independent judgment and Lead
acceptance remain separate responsibilities.

Every new scope explicitly supplies `reviewPlan`. Each decision records
`authorityRef`, `ruleRef` and `reason`:

| `kind` | Meaning | Required shape |
|---|---|---|
| `required` | Independent review addresses selected obligations. | Nonempty `lenses`; `exemptionClass: null`. |
| `not-required` | No applicable review trigger remains. | `lenses: []`; `exemptionClass: null`. |
| `exempt` | An authorized exception waives an otherwise required review. | `lenses: []`; nonblank `exemptionClass`. |

Omitting the plan for a new scope is rejected. Explicit `reviewPlan: null` opts
into legacy Spec/Standards compatibility; stored legacy rounds keep that rule.
An omitted plan on redeclaration inherits the prior choice. Exact retries return
their original effective choice and result even after subsequent amendments.
The status projection exposes `reviewDecision` as `legacy`, `required`,
`not-required` or `exempt`; the full declaration retains the plan and its sources.

The plan is pinned before the candidate round; a transition cannot reduce the
required set. The assignment owner and scope writer cannot supply their own
required independent review. Brief, declaration or plan changes invalidate
dependent review freshness. Empty review sets still require current candidate
proof and valid approval/rollout history. Storing a decision does not verify its
authority pointers or authorize bypassing Human/protocol requirements. Mandates
cannot be dropped after adverse findings to evade an obligation.

Review observations and conflicting findings stay visible for Lead adjudication.
A scope transition, green check or reviewer PASS does not establish project
acceptance. A neutral review brief includes the objective, acceptance, constraints,
candidate, mandate, relevant sources and unknowns without a desired verdict.
The owner records the task's stop condition and authorized effort/resource bound.
Re-review targets the affected questions on a fresh candidate; an unresolved
prerequisite or exhausted bound is disclosed without treating it as acceptance.
The source checkout's optional proof-copy harness is described in
[development](development.md#independent-review-probes).

## Report and hand off

The v1 `slp-record` evidence envelope remains compatible. A handback may add a
`report` object with `format: "slp-report"`, `version: 1` and purpose `execution`,
`review` or `adjudication`. Selecting it requires meaningful fields for that
purpose. Findings distinguish hypotheses from confirmed observations; their
evidence and the reported `read`/`ran` fields remain author claims.

Use this optional format when the current runtime's `records --schema`
advertises `slp-report`, and rendering when its CLI usage advertises `--render`.
An older retained runtime may support only the legacy envelope.

```bash
node "$SLP_RT/bin/slp.mjs" records /absolute/report.md --require handback
node "$SLP_RT/bin/slp.mjs" records --render /absolute/report.md
node "$SLP_RT/bin/slp.mjs" records --schema
```

Rendering produces a readable report and preserves the original fenced block,
including its line endings. It does not run checks or establish acceptance.
See the [record contract](../src/references/report-records.md) and
[CLI reference](cli.md#records) for validation and evidence-reference rules.

`prepare-handoff` accepts optional `handoff.recapInputs` alongside the existing
required free-text state. Explicitly supplied context/report artifacts are
summarized with a fresh candidate measurement; missing sources, revision or
candidate mismatches and incomplete measurements remain visible. The planner
does not mine prose or read arbitrary host state. Settlement and receiving-owner
acknowledgment still need actual evidence. Native ownership acceptance is a
separate desk operation; host lifecycle operations require their own authority.

These are local storage, preparation and read interfaces. Live delivery and
agent behavior require separate E2E evidence. The detailed implementation
obligations are in the [work-coordination spec](spec/work-coordination.md).
