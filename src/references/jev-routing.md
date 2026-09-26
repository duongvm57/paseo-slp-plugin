## Jev-assisted routing (opt-in, per-daemon)

Read this reference only when the `routes` output has `jevRouting.routing` set to
`shadow`, `armed` or `error`. Do not read it for `unconfigured` or `off`. An
`error` means the configured state is unreadable: block the dependent routing branch
and escalate to the Human; do not treat it as off or silently fall back.

Jev is a bounded decision primitive, not an agent: it answers one typed choice
question over a caller-supplied state and returns a calibrated answer. It is
served through one of two provider kinds: `openrouter` — OpenRouter's
Decisions API at `https://openrouter.ai/api/alpha/decisions` with the pinned
model `typesafe/jev-1.13` — or `typesafe` — the first-party System One API
at `https://api.typesafe.ai/v1/systemone` with the pinned model `jev-1.13.0`,
whose `baseUrl` may point at a custom https endpoint/proxy carrying an
origin+path prefix. Jev is never an ACP provider, never an agent seat and
never runs in a background loop or schedule — it is invoked only through the
explicit helper `node <installed>/bin/slp.mjs route-decide <request.json>`.

Jev routing mode is per-daemon configuration under
`<daemonHome>/slp-runtime/state/jev.json` with its provider key in
`jev-<kind>.key` (0600, write-only; the Manager card stores it and status
reports `hasKey` only). All toggles default off, evaluated at preparation
time — toggling never mutates already-running seats. Two live modes:

- **Shadow** (`enabled: true`, `capabilities.routing: false`): route-decide
  still runs and emits its receipt, but the Lead's pick stays binding.
  prepare verifies a supplied receipt for consistency and records BOTH picks
  in the plan (`routing.jev.jevChoice`, `routing.jev.declined`) — the paired
  record is the evaluation data.
- **Armed** (`enabled` and `capabilities.routing` both true): the receipt is
  required and binding — `route.optionId` must equal the receipt choice and a
  decline fails closed.

**Shadow evaluation is the gate before arming** — the capability toggle stays
OFF until shadow data exists. The procedure: (1) for each delegation, Lead
runs route-decide under an enabled-but-unarmed daemon to emit the receipt;
(2) Lead still chooses the seat by its own judgment and prepares with
`route.optionId` + `route.decision`; (3) the plan records both picks;
(4) the Human pre-registers exit criteria — agreement rate and the
asymmetric error class (Jev declining a fit option, or picking one the Lead
rejects) — and only after the recorded pairs satisfy them does the Human arm
`capabilities.routing`. Arming before that data exists skips the gate.

The flow in either mode: Lead authors a routing `brief` — a nonempty string
of raw task/assignment text (never raw `assignmentFile` bytes) — and runs
route-decide. Structured forms are refused (`jev-request-invalid`): a
`signals` field or object/array let the caller pre-classify the task with
Jev's own decision vocabulary, turning the seat choice into a rubber stamp —
inline the same facts as prose instead. Standard `axis:value` tokens quoted
verbatim inside the text still ship, but as unverified mentions: the decision
instructions tell Jev to read them as prose, and `warnings` in the output
lists every hit for the caller. A useful brief carries the task description,
risk/effort signals, constraints and dependencies — the brief is the entire
evidence surface, so a starved brief (`"x"`) yields answers that drift toward
chance; this is guidance, not a hard schema, because what a good brief needs
is itself measured during shadow evaluation. The helper computes the eligible
candidate set deterministically — the same `optionExclusions` tokens prepare
enforces — plus one explicit `no-suitable-option` sentinel, sends
`{brief, role, options}` as state (catalog `notes` are
withheld), and emits `{schemaVersion, optionId, catalogSha256, declined, role,
tokenConflicts, warnings, poolDrift, decision}` where `decision` is the
receipt and `poolDrift`/`warnings` surface repository-catalog↔live-pool
divergence (advisory — the catalog still binds). prepare then takes `route.optionId` +
`route.catalogSha256` + `route.decision` and verifies the receipt offline:
internal hash, pinned model (matching the configured provider), catalog hash
match, exactly the `route_option` question, matching role, candidate
membership — plus answer match when armed. A receipt is verified whenever
supplied — even with Jev off — and is required whenever the capability is
armed, so a bare `route.optionId` then fails closed. The same rules bind
prepare-handoff through the shared plan builder, and `prepare --check` runs
the identical receipt stages offline.

The receipt records the model, state hash, question set, catalog hash,
candidate list, the full answer with its probability distribution and
confidence, timestamp and latency. In armed mode the reason trail moves from
Lead prose to this receipt — a recorded distribution, not reasoning; the
"Lead records its choice rationale" posture applies when Jev routing is not
armed. Confidence is recorded evidence — never a routing threshold; a
low-confidence pick is not auto-rejected or retried. Receipts prove
consistency, not cryptographic authenticity: they cannot certify that a real
Jev answered, only that the supplied artifact is internally consistent with
this catalog.

Jev's answer is a proposal, not authority — deterministic eligibility and
prepare's receipt verification still bound it, and every failure is closed:
missing/disabled config or key, an OpenRouter/TypeSafe outage, a timeout,
an empty eligible set, a choice outside the candidate set or a stale catalog
hash all refuse rather than guess. A decline (`no-suitable-option`) emits
its receipt, exits nonzero and is escalated — the pool is Human-owned, so
Lead reports the gap rather than retrying. Controlled degradation: while the
capability stays armed an unreachable OpenRouter blocks the dependent Peer
delegation; the Human disables `enabled` or `capabilities.routing` in the
Manager card (or edits jev.json) and Lead judgment resumes — disabling keeps
the stored key.

Accepted risk (recorded): the key file is `0600` inside the daemon home, but
any process running as the same user — including a Peer seat — can read it.
`0600` narrows the exposure to same-user processes; it does not eliminate it.
The Jev provider key is the only credential SLP stores; treat daemon-home
integrity as the security boundary.
