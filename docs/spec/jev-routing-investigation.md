# Jev routing — investigation summary and reviewed design

Status: research consolidation + reviewed design, 2026-09-20. This document
merges four delegated investigations, one committee exercise, and a community
forum corpus into a single spec-ready record. Nothing here is implemented;
adoption requires Human assignment and the high-blast gate
(`Engineer → Reviewer + QC`, split-axis Reviewer seats, full `node --test`
output, candidate identity — per `.paseo-slp/workspace-protocol.md` task
classes).

## 1. What Jev is

**Jev** is the first public "System One" model from **TypeSafe AI** (ex-OpenAI
founder Diogo Almeida), early access since 2026-09-15. It deliberately cannot
generate text: callers send a `state` (≤32k tokens, inside a 64k request
budget) plus typed questions — `choice`, `score`, `noul` — and receive
structured answers with calibrated probabilities. Vendor-reported latency
70–500ms; pricing $0.042/M input tokens, output free.

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, Bearer key from
  `console.typesafe.ai` (waitlist). Custom shape — not OpenAI/Anthropic
  compatible. Also reachable via OpenRouter, Vercel AI Gateway, Cloudflare,
  and Pydantic AI (`TypeSafeModel('jev-latest')`).
- Model IDs: `jev-1.13.0`; aliases `jev-latest`/`jev-preview` — **pin the
  versioned ID, aliases drift**.
- English-primary; other languages degrade. No tool-call generation, no
  fine-tuning, single-turn.
- Benchmarks are vendor-published only (workflow evals at evals.typesafe.ai);
  no independent verification exists.
- Access notes from practitioner reports: waitlist approval reportedly comes
  with a small credit ($5 in multiple reports; one unreconciled $1 report);
  `typesafe/jev-1.13` is listed on OpenRouter — the practical route for
  benchmarking before committing to a first-party key.

**What Jev is not:** practitioners converged on the same correction — the
selling point is *specialization* (bounded decision space + calibrated
probability + very low latency + low cost), not structured output itself;
general LLMs have enforced JSON schema for a long time. And TypeSafe's own
"Zero Hallucinations" slogan is best read as "output stays inside the
declared decision space," not "decisions are correct."

**Consequence:** Jev can never be an agent provider/model for Paseo seats —
there is no generative interface for ACP. It can only be an internal decision
primitive inside application code.

## 2. Prior art — patterns, not packages

A survey of community Jev-router projects found **no implementation worth
integrating directly**: every published approach either embeds a hosted SaaS
call in the decision path, targets a different layer (per-turn inside an agent
CLI, or an HTTP gateway rather than delegation-time seat selection), or ships
infrastructure this package's posture forbids (native deps, external stores,
background launchers). Third-party projects are deliberately not enumerated
in this document.

The reusable patterns that survey surfaced — all implementable inside the
existing seam without new dependencies:

- **Deterministic eligibility before any semantic step.** Every surveyed
  router separates "what is allowed" from "what is best"; paseo-slp already
  owns the deterministic half in `catalogBinding`.
- **Closed exclusion vocabularies with reason trails** — exclusions report
  *why* (`disabled`, `availability:<state>`, `role-not-listed`), never just
  drop options silently.
- **A pure, total decision function** where every branch carries a reason —
  separable from transport so the decision layer is testable offline.
- **Signal / Human policy / deterministic enforcement separation** — the
  tool emits signals and facts; the Human's catalog stays the only policy;
  enforcement stays in `prepare`.
- **Confidence-gated escalation as a rule, not a threshold** — escalate on
  Human-owned boundaries, not on a computed number.

### Official TypeSafe agent skill

TypeSafe publishes an official agent skill for building with Jev —
[`typesafe-ai/skills`](https://github.com/typesafe-ai/skills) (MIT): installable
as a Claude Code plugin (`claude plugin marketplace add typesafe-ai/skills`)
or via `npx skills add typesafe-ai/skills --skill typesafe-ai`. The skill does
not contain code — it teaches agents the System One programming model and
points them at the live docs (`docs.typesafe.ai/llms.txt` index, per-page
`.md` serving).

Guidance from that skill that applies directly to `route-decide`'s question
design:

- **One narrow, coherent judgment per question**; put the judgment in
  `instructions` and the possible answers in `criteria`; question IDs are
  never sent to the model.
- **Candidate coverage:** "the model cannot choose an omitted value" — the
  choice set must be exactly the eligible option set (no more, no less).
- **Include a no-match outcome** when nothing may fit — i.e., the routing
  question should offer an explicit "no suitable option" candidate and the
  design must define what a decline means (receipt records it; likely
  fail-closed with escalation to the Human, since the pool is Human-owned).
- **Confidence semantics:** confidence summarizes distribution concentration,
  not correctness or permission to act — consistent with recording it in the
  receipt while building no thresholds.
- **"Typed output guarantees the interface, not truth"** — TypeSafe's own
  guidance is to validate performance in the target domain; the bounded
  shadow-evaluation procedure below exists for exactly this.

## 3. Committee exercise — converged, then de-scoped

Two members (Codex `gpt-6-astra`, Claude `claude-opus-5`) designed a routing
aid for paseo-slp across three rounds. They converged on a deterministic
`route-suggest` returning four named buckets (`matched`/`neutral`/`conflicted`/
`excluded`) in pure catalog file order — no sorting, no winner, Lead declares
task tags before the tool speaks, `prepare` unchanged.

Post-committee review then de-scoped it: with ranking removed, the tool only
reformats the catalog — valuable but misnamed, and unjustified as a new
subcommand for the current small pool with zero recorded mis-picks.

**Surviving residue, justified by existing defects (independent of Jev):**

- Extract `optionExclusions(option, role)` as a shared predicate so
  `catalogBinding` (`plugin/server/runtime/cli/routing.ts`) reports specific exclusion tokens
  instead of the fused `"disabled, unavailable or excluded for <role>"` —
  one predicate, two consumers, view and enforcement cannot drift.
- Fix documented drift: `docs/agent-guide.md` claims `routes` returns
  "eligible options"; it returns the raw catalog.

A real recommender remains **blocked on Human-authored semantics**: `priority`
direction is undocumented, and `suitableFor`/`avoidFor` are free text — the
Human must define these before any tool can rank on them.

## 4. Reviewed design — Jev as a bounded routing capability

A subsequent design proposed actual Jev integration. Independent review
verdict: **sound backbone — proceed with three mandatory fixes.** Verified
against the codebase: `src/` contains zero network calls today;
`prepare --check` runs the same plan stages (`launchCheck` reuses
`launchPlan`/`handoffPlan`); the fused exclusion error exists verbatim;
`runtimeStatus` reads daemon config (key-leak surface); the plugin boundary
("installs and manages; does not orchestrate") is explicit.

### Architecture (as corrected by review)

| Layer | File | Knows |
|---|---|---|
| Transport/capability | `plugin/server/runtime/cli/jev.ts` (new) | Config resolution (toggle + key per daemon), `{state, model, questions}` build, `fetch` + timeout, typed-answer validation, redaction guard, error taxonomy, decision-receipt shape. **Nothing about routing.** Exposes all three primitives (`choice`/`score`/`noul`) so future consumers (monitor triage, quotaFallback target selection, handoff readiness) do not rewrite it |
| First consumer | `plugin/server/runtime/cli/jev-routing.ts` (new) | Builds `state` from catalog + Lead-authored brief; `choice` over the eligible option set computed via `optionExclusions` from `plugin/server/runtime/cli/routing.ts` |

**MUST-FIX 1 — no network inside `prepare`.** `prepare` is offline,
deterministic, and its `--check` mode runs the same stages; injecting a paid
API call breaks preflight parity, evidence replay
(`.e2e-runs/**/evidence/root-request.json`), and separates decision from
validation. Instead: `slp.mjs route-decide <request.json>` calls Jev and emits
`{optionId, catalogSha256, decision: <receipt>}`; `prepare` stays offline and,
when Jev mode is ON, **requires** a decision receipt rather than a bare
`route.optionId`. `prepare-handoff` must state explicitly whether Jev mode
applies (it shares the plan builder).

**MUST-FIX 2 — decision receipt.** Pin `jev-1.13.0`; record `state` hash,
question set, `catalogSha256`, candidate list, full answer + probability
distribution + confidence, timestamp, latency. Record confidence fully but
build no thresholds — that is a Human decision for later, on data.

**MUST-FIX 3 — bound egress, data and key.** Send a Lead-authored routing
brief, never raw `assignmentFile` bytes (the package deliberately passes the
assignment by pointer; shipping its bytes to TypeSafe self-contradicts).
Redaction guard before send (credential-shaped strings). The API key lives
per-daemon outside repo/payload; `runtimeStatus` must return `hasKey` only —
rule + test. Source-checkout invocations (no daemon home) fail closed with a
clear message.

### Toggles and boundaries

- Per-capability toggles: `jev: { enabled, capabilities: { routing: false,
  ... } }` — all OFF by default. One key, many capabilities, each armed
  separately; prevents authority creep via version bump.
- Fail-closed on API error; toggle evaluated per preparation, never mutates a
  running session; key retained when toggled off; UI (plugin Manager card
  "Jev (TypeSafe)") shows key field, Test connection, and a per-capability
  toggle list.
- Non-goal to write down in v1: **Jev is only invoked by a helper command a
  session deliberately runs — no background invocation, no loop, no
  schedule.** Without this line, a shared Jev module seeds a background
  orchestrator.
- The plugin manages config; the helper decides; the Lead still calls
  agent-scoped `create_agent` — `docs/architecture.md` boundary preserved.

### Additional gaps found on verification (beyond the review)

1. **Receipt = consistency, not authenticity.** Offline `prepare` can verify
   the receipt's internal hash but cannot prove it came from TypeSafe — a
   determined Lead could fabricate one (no second secret, no request-id in the
   API response). Enforcement here is procedural (doctrine + audit), not
   cryptographic; do not claim more.
2. **Catalog `notes` are Vietnamese; Jev is English-primary.** Exclude `notes`
   from `state` — send `optionId` + `suitableFor`/`avoidFor` + the Lead's
   brief only — or accept degraded accuracy / pre-translation.
3. **Escape hatch for fail-closed:** "TypeSafe down ⇒ no Peer spawns" is
   acceptable only because the Human can flip the toggle off to restore the
   Lead-judgment path. Write that controlled-degradation path into doctrine.
4. **Key readability:** same-user peers can read a daemon-home key file.
   At minimum `0600` + record the accepted risk.
5. **Edge cases to pin:** all-candidates-excluded ⇒ `route-decide` fails
   closed; no retries (each call is paid; at most one bounded retry); timeout
   ~5s; invalid choice outside the candidate set fails.
6. **Process coverage:** add an `e2e/` manifest entry (mocked or marked manual
   — real runs need a key) and check `docs/spec/` for a routing section to
   update.
7. **The brief is the real bottleneck** (from the forum corpus, §5 below):
   practitioner reports converge on Jev's output quality tracking the supplied
   evidence — starve the context and answers drift toward chance. The
   Lead-authored routing brief is that entire surface; its schema deserves as
   much design care as the question itself.
8. **Asymmetric error cost** (forum corpus): the expensive failure is a hard
   task scored easy and routed to a cheap/weak seat. Average accuracy does
   not capture it; the decline/no-match path and any later confidence
   threshold must be evaluated specifically on this error class.

### Shadow evaluation before reliance

TypeSafe's own guidance ("validate performance in the target domain") plus
the forum corpus (no completed third-party benchmarks, §5) make this
load-bearing: before Jev mode may gate `prepare`, run `route-decide` in
shadow — emit the receipt, the Lead still chooses, record both. Exit
criteria are pre-registered with the Human: agreement rate and,
specifically, the asymmetric error class (hard task scored easy → weak
seat, gap 8). The capability toggle stays OFF until that data exists;
"works in the vendor's demo" is not evidence.

### Contract amendment required (write explicitly, no silent contradiction)

The design trades away three existing postures: (a) a task brief leaves the
machine to a paid SaaS; (b) "Lead explains suitability" does not apply in Jev
mode — the reason trail moves from Lead prose to a Jev receipt that holds a
distribution, not reasoning; (c) a hard network dependency enters the
delegation path, mitigated only by fail-closed + the Human toggle escape
hatch. Item (c) will bite first in operations.

## 5. Community field reports (forum corpus, 16–19 Sep)

A practitioner forum discussed Jev intensively over four days; the Human
supplied a synthesis of that log. The corpus is anecdotal — no completed
benchmarks — but several observations sharpen this design.

**What the corpus corroborates**

- The mental model in §1: Jev's edge is specialization (bounded choice +
  calibrated probability + latency + cost), not structured output — the
  forum reached the same conclusion independently, including the same
  dismissal of the "Zero Hallucinations" slogan (read as "stays inside the
  declared space", not "decisions are correct").
- The flagship community use case is exactly ours: Jev scores task
  difficulty/risk, application code routes to a model tier. Jev is framed
  as an orchestration/routing primitive, never a Lead/reasoner replacement.
- The architectural shape matches MUST-FIX 3's spirit: in every use case
  that felt credible (computer-use via local segmentation+OCR, video
  cutting via transcript+timestamps), deterministic local code prepared a
  bounded text candidate set and Jev only chose. Jev never saw pixels,
  DOM, or raw artifacts — the same "bounded brief, never raw bytes" rule.
- Local RLCD experiments exist (community-trained ~1B models); the
  "small local model + calibrated decisions + bounded choice" pattern is
  being explored — consistent with the §2 survey finding that a local
  path is feasible but unproven.

**What the corpus adds**

- **Context starvation → chance-level output.** Practitioners report Jev
  needs adequate evidence inputs (a few concrete signals), otherwise
  answers drift toward 50/50. In our design the Lead-authored brief is the
  entire context surface — gap 7.
- **The named failure is asymmetric:** hard task misclassified easy →
  cheap/weak seat → task failure. The forum spotted this within a day of
  proposing SLP routing — gap 8.
- **schema ≠ deterministic ≠ correct.** One unverified log line had Jev
  endorse a wrong arithmetic result at 0.91 confidence; anecdotal (could
  be a typo or missing context), but exactly the failure shape to expect.
  Receipts-over-trust stands; confidence goes in the receipt, never in a
  gate.
- **Non-determinism is intrinsic:** the same state+question does not
  guarantee the same answer. The receipt records what *was* returned, not
  what "should" be — receipt-driven `prepare` validation is the right
  shape.

**What the corpus does not prove** — stated to keep this spec honest: no
completed Jev-vs-medium-model benchmark; no independent latency
verification (`~90ms/decision` is from shared material); no evidence the
confidence is calibrated on coding/orchestration/risk classification
specifically; no SLP-shaped routing trials. The shadow-evaluation gate in
§4 is therefore load-bearing, not optional.

## 6. Leaderboard input — investigated, dropped

Question: could an external LLM ranking replace or validate Human-entered
catalog fields (`suitableFor`/`avoidFor`/`priority`)?

**The model-vs-seat gap is measured, not hypothetical:** same model, different
context-management harness → 28%→49% SWE-bench F2P (arXiv 2608.26218); Claude
Opus 4.5 scores 45.9% under a standardized scaffold vs 55.4% under Claude Code
(arXiv 2605.23950); HAL reports up to ~48pp scaffold swings. Harness variance
regularly exceeds inter-model gaps. Leaderboards measure a model (or
model+one-scaffold); a paseo-slp seat is provider+model+CLI-harness — the
numbers do not transfer.

Source assessment: **Artificial Analysis** (independent Coding Agent Index +
cost data + JSON API) and **Aider polyglot** (real edits + real cost) are the
most trustworthy; **RouterArena** is the right concept but its dataset is
general-knowledge MCQ, no coding domain; **LMArena** is a coarse directional
signal at best (Leaderboard Illusion bias); **SWE-bench Verified** is
contaminated — OpenAI itself stopped reporting it; **Scale SEAL** is a
private dataset with a commercial conflict of interest.

DECISION (Human): dropped. Human-entered fields encode seat-level operational
experience no benchmark measures. If provenance is wanted later, record
per-option "date + source consulted" at onboarding — never benchmark scores.

## 7. File-level change plan (if the design proceeds)

| File | Change |
|---|---|
| `plugin/server/runtime/cli/jev.ts` | New transport: config, three primitives, fetch+timeout, validation, redaction, error taxonomy, receipt shape |
| `plugin/server/runtime/cli/jev-routing.ts` | New consumer; reuses `optionExclusions` |
| `plugin/server/runtime/cli/routing.ts` | Export `optionExclusions`; `catalogBinding` exclusion errors name tokens (surviving fix from §3) |
| `bin/slp.mjs` | `route-decide <request.json>` subcommand; `prepare` requires receipt in Jev mode; **no network in `prepare`/`--check`** |
| `plugin/server/runtime/cli/launch.ts` | Accept receipt as a binding source; state whether `prepare-handoff` applies Jev mode |
| `plugin/server/runtime/cli/runtime-state.ts` | Key redaction rule in `runtimeStatus` (`hasKey` only) |
| `plugin/client/ManagerSurface.tsx`, `plugin/shared/contracts.ts`, `plugin/index.server.ts`, new server module | Jev card: key, Test connection, per-capability toggles; status reports `hasKey` |
| Doctrine | `docs/contract.md` (scoped amendment), `src/references/provider-routing.md`, `src/delegation.md`, `docs/architecture.md`, `docs/agent-guide.md` (fix existing drift), `.paseo-slp/workspace-protocol.md`, `README.md`/`README.vi.md` |
| Tests | Both modes; no-key; API error/timeout/HTTP codes; invalid choice; stale hash; receipt-hash mismatch; **key never leaks via `runtimeStatus` or logs**; `prepare --check` stays offline; view↔`catalogBinding` exclusion parity |
| Payload | Regenerate `plugin/server/generated/runtime-payload.ts` via `scripts/generate-plugin-payload.mjs`, separate `chore:` commit |
| E2E | Manifest entry for Jev mode (mock or manual-marked) |
