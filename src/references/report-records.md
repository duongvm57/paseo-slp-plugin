# Handback and settlement records

Reports keep their prose. A fenced JSON block marked `slp-record` projects the
same facts for tools; `kind` distinguishes `handback` from `settlement`. The
opening marker must start at column 1 and use exactly `slp-record`; trailing
whitespace is allowed after the marker and closing fence. The last JSON-decoded
block of each kind is selected. The parser retains every decoded block and
warns when a kind appears more than once; parse or validation errors still
block acceptance.

A handback is the seat's bounded result and evidence for its assignment; it is
not project acceptance, a write grant or resource settlement. A handoff changes
ownership only through the authorized transfer process after the old owner is
settled and the successor acknowledges it. Messages and record claims route
information but do not prove work occurred or accept a candidate. The receiving
Lead verifies the candidate and checks under the assignment's gate.

## Handback

A handback record has `version: 1`, `kind: "handback"`, `seat`, `verdict`,
`candidate` and `checks`. `seat` identifies role and disposition; `agentId` is
optional when the seat cannot verify it. `verdict` is `APPROVE`, `FINDINGS`,
`BLOCKED`, `REOPEN_REQUEST`, `DEPENDENCY_REQUEST` or `null`. A candidate is
`null` for report-only handbacks; otherwise it names an absolute `repository` and
exactly one identity: `snapshotSha256` from the snapshot helper, or a full
`head` for a clean commit. `incomplete` mirrors snapshot gaps; a non-empty list warns
`candidate-incomplete`.

Each check records `cmd`, integer `exit` and `sha`. `sha` is the SHA-256 of
UTF-8 bytes in inline `output`, or, when output is long, the bytes at
repository-relative `outputRef`; inline output takes precedence if both are
present. When supplied, `--repo <absolute-path>` is the verifier's authoritative
root and overrides every record-declared `candidate.repository`. Without it, an
`outputRef` uses the per-check `candidate.repository`, then the record's
`candidate.repository`. If a declared root differs from `--repo` after
`realpath`, warn `repository-mismatch` with both resolved paths and still read
only from `--repo`. Read evidence only when the effective root is absolute; a
missing or non-absolute root leaves `outputRef` unread and warns
`check-evidence-missing` with the reason. The parser resolves paths and checks
containment against that root. `sha: null` is valid and warns
`check-evidence-missing`; a missing `sha` key is invalid and warns that the key
is absent. A readable mismatch is an error `sha-mismatch`. This hash
establishes record-to-output consistency only; it does not establish that the
command ran. Lead or CI reruns provide independent verification.

Candidate/check claims require a handback record. A report-only handback may
omit it or use `candidate: null`. If the report claims checks, include their
command and exit facts in both prose and the record. A record never strengthens
what the prose claims.

An optional handback `timeline.sessionId` carries a session identifier the
reporting seat can see. The receiving owner reconciles it with Paseo receipts
before recording settlement.

### Optional structured report

A handback may include an optional top-level `report` in the v1 record. When
present, it uses `format: "slp-report"` and `version: 1`; handbacks without it
remain valid, and settlement records do not accept it. This structure
supplements the prose and outer record rather than changing their evidence or
acceptance semantics. It is available when the current runtime's
`records --schema` advertises it; it is not a new required reporting ritual.

`purpose` selects the substantive body: `execution` summarizes the result and
completed or unfinished work; `review` gives the outcome and a mandate bound to
the assignment, scope revision and candidate; `adjudication` records a
decision, unresolved matter or explicit absence of a material decision. The
selected branch carries the meaningful body, with the other purpose branches
null. Report only what the seat can support from its bounded assignment.

Findings distinguish `hypothesis` from `confirmed`. A confirmed finding needs
at least one evidence item declared `observed`; that label and its source
pointer are still a claim and do not establish the finding. The report's
`selfReport.read` and `selfReport.ran`, `report.assignment.authority`, and the
enclosing record's candidate and checks are reported claims. Neither an
authority claim nor a record grants authority. A check's output hash binds
supplied bytes but does not show that its command ran. Independent rerun and
the applicable gate establish verification and acceptance.

When the current runtime advertises this mode, `records --render <file|->
[--repo <absolute-path>]` renders the selected handback's structured report;
`-` reads the explicitly supplied report from stdin. Rendering appends the
original `slp-record` fence unchanged, including its line endings, and does not
turn report claims into proof. Use `--render` only when the installed CLI
advertises that flag. Older retained runtimes or records may support only the
legacy envelope; their lack of structured-report or render support does not
invalidate an otherwise valid unstructured v1 handback.

## Settlement

The owner receiving a seat's report writes one `kind: "settlement"` record
after Delivery and after correction or re-review closes. `task` is the root
issue ID when tracked; use `null` otherwise and keep the assignment slug in the
surrounding report. `seat` carries `agentId` when known, provider and title.
Include `nativeHandle`, `sessionId`, `via`, `export` and `gap` under `timeline`;
use `null` when a handle, distinct session ID, export or gap is absent. `via` is
`paseo-logs`, `host-transcript`, `sessions-db`, `unreadable` or `unchecked`.
`export` is `null` unless an authorized, available export is written; an export
names its repository-relative path, SHA-256 and byte count. A settlement record
or export contains no raw transcript or secrets. Record a missing export
capability in `gap`; do not invent an export path or workaround. `recordedBy`
names the owner and `at` is a UTC timestamp.

`nativeHandle` is host-native: Devin uses its session slug, Codex its rollout
UUID, and Pi its session-file path. For Claude, record the exact handle exposed
by the host; the package defines no normalization. Never infer or normalize a
handle. Today Paseo MCP exposes tail-oriented `get_agent_activity` without an
export API; `paseo agent logs` is a read path, not a durable archive, and Codex
rollout files can be garbage-collected. Record this capability gap; do not
invent a workaround. A pointer links task, seat and last-known evidence; it
cannot restore a timeline that the host has removed.

Use one durable sink, owned by its writer: add the block to the durable task
record the repository's work-state pointer names, when one is supplied;
otherwise the assigned Supervisor records
the relevant evidence-pointer fields in its authorized causal notebook, as
described in `references/governance.md`. If neither sink is available, the Lead
includes the Peer settlement block in the Lead's handback to the assigned
Supervisor. When no Supervisor is assigned, the Lead writes the Lead's own
settlement pointer to the durable task record or the note location named by the
repository's workspace protocol, and includes it in the Lead's handback. A Lead
does not write in a Supervisor-owned notebook.

Separately, the plugin's durable desk (`slp_handback_submit`, P3-a) stores an
accepted handback record verbatim as the seat's `claimed` revision under
`<stableRoot>/state/enforcement/` — durable claim storage bound to an
assignment, with the plugin's own observed candidate written alongside it.
This desk row is evidence storage, not a settlement sink and not acceptance:
the sink rules above are unchanged, and a desk record carries no verdict about
whether the handback was accepted.

### Optional structured handoff recap

`prepare-handoff` may receive explicit source projections through
`handoff.recapInputs`. The recap supplements the existing `handoff.state`
string, previous-owner settlement evidence and resource list; it does not parse
or replace them or add a mandatory handoff step. It uses only the supplied
sources and the candidate measurement already made for launch. It does not
search arbitrary files or host state, resolve source pointers, or refresh
ownership from the host. An omitted source group is a visible gap; an explicit
empty list reports that source as having no rows. The recap can flag invalid
rows and detected revision or candidate-pin conflicts, but does not validate
the referenced source files themselves.

The recap's `contextStatus` describes detected context gaps only. Source
pointers remain unverified. Candidate, check and finding data remain claims,
and a matching candidate pin means only that the supplied
identity pins match. The recap leaves settlement unverified and recipient
acknowledgment unobserved; it performs no transfer or lifecycle operation. A
complete recap therefore does not establish settled ownership, acceptance or
successful work.

## Extraction and failures

Run `slp.mjs records <path|->`; `-` reads stdin. `--kind` filters returned
records only; parse and validation errors remain complete for every block in
the report. `--require` makes a kind mandatory; it is satisfied when a record
of that kind is present, while validation errors still make the command exit 1.
A supplied `--repo <absolute-path>` overrides record-declared roots; without it,
`outputRef` falls back from the per-check candidate to the record candidate.
`--schema` prints the v1 JSON Schema. The JSON result retains each parsed record
with its block index and selected flag, plus `errors` and `warnings`. The last
decoded record of each kind is selected; duplicates warn `multiple-records`.
Prose-only input returns no records with `no-record`; it remains a successful
parse unless `--require` was given, which reports `required-kind-missing`.

Malformed JSON reports `invalid-json` and its block index. Missing or malformed
fields report `invalid-record` and a field path. Unsupported versions report
`unsupported-version`; unsupported kinds report `unknown-kind`. A missing
required kind reports `required-kind-missing`, duplicate kinds warn
`multiple-records`, and a verifier root that differs from a declared candidate
warns `repository-mismatch`. Any invalid record or missing required kind exits
1. An unsafe or escaping `outputRef` is an `invalid-record`; an unreadable
contained reference warns `check-evidence-missing`. A self-consistent record is
not proof of execution, identity or acceptance.
