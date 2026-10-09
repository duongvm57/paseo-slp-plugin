# Draft workflow E2E review — NOT CONFIRMED

This checklist follows the repository's E2E criteria and procedure.
For basic-* scenarios, the coordinator uses this checklist and the checked-in
outcome check without a prelaunch confirmer. Other scenarios require Human or an
independent reviewer to confirm the checklist and job-specific check before launch.
All scenarios retain independent final review of frozen evidence; coordinator
preparation is not a PASS.

| Criterion | Evidence needed |
|---|---|
| U1 Outcome | Real objective and independently chosen check; baseline, final artifact, exact output and exit status on a stable work snapshot. |
| U2 Entry/instructions | Source + installed identity, actual installed file paths, root launch arguments, each parent's native SDK/create_agent receipt and child's actual initial input. For desk placement capture bound Git-common-dir, source routing/protocol and target workspace/cwd/HEAD pins; verify a placed Lead delegates again from the same configured source with omitted/caller placement; new-semantic registration has a bounded read-only wait and pending names operation_get with the same requestId. Legacy omitted full-pin Peer/Lead keeps its old delivery path. Capture fresh saved-profile observations for Supervisor/Lead and project catalog bytes/hash, selected option/source/mode and suitability rationale or full Jev receipt for Peer; match provider/model/mode/thinking/features for each launch; provider identity alone is insufficient. Compare common/role/delegation bytes and bindings plus evidence that triggered references were read; titles or self-claims cannot prove loading. Record source-code reads needed to rescue normal usage. |
| U3 Topology/ownership | Host ParentAgentId and workspace inventory match the assignment and protocol-selected topology (direct Lead, observed existing Lead, or Supervisor/Lead/Peer lanes). Every new-team seat traces to the owning parent's native SDK/create_agent receipt — a prompt into a pre-existing standalone or differently parented session is not a create and establishes no parentage; an observed existing Lead keeps its real parent plus an explicit report recipient. Continuation reaches the verified existing child rather than respawning the team. Same-team seats share the assignment's pinned workspace unless a declared worktree/repository/lane-isolation reason and its resulting paths are recorded; a second workspace on the same checkout is not isolation, and isolation never substitutes for parentage. One writer per moving scope; parallel writers have distinct worktrees; read-only seats and sealed boundaries are respected. Artifacts preserve unrelated changes. No native second control plane. |
| U4 Acceptance | Peer implementer's proof, independent review when required, and Lead's actual inspection/verdict refer to the same unchanged candidate. Distinguish package identity from job identity. Findings remain visible. |
| U5 Human attention | Operator intervention log, launch-to-handback duration, routine assistance count and real owner decisions. No coaching, approval on behalf of agents, restart or candidate edits during observation. |
| U6 Honest handback | Lead reports verdict, actual checks, unresolved assumptions, authority limits and missing evidence; assigned Supervisor relays these faithfully. Idle and check success alone are insufficient. |
| U7 Settlement | Host evidence for task descendants, pending permissions, workspace scripts, terminals, schedules/heartbeats and task processes. Idle alone does not prove callbacks/processes settled. Preserve pre-existing resources. Existing placement cannot claim setup suppression or settled pre-existing scripts; unknown open/registration keeps IDs and gaps without recreate. |

Record review and outcome check as NOT_RUN until performed. Reviewer writes a separate
review file referencing frozen evidence hashes; never edits report.json. Use
PASS only when all seven have evidence, FAIL for observed violations, BLOCKED
for missing prerequisite/proof. A timeout is the end of observation, not an
implicit cancel. If curated CLI logs omit launch input or final report, obtain
actual host timeline evidence in the independent review; otherwise U2/U4 remain
BLOCKED. Role candidates seen in text are only search hints.

A coverage or parity claim on the package candidate requires an exhaustive
enumeration-site list — README, manifest, examples/*, docs/*, src policy
bytes and skills/* — every site checked in full, not sampled. Record the
enumerated list in the review; an enumeration covering only README and the
manifest while skipping examples/* leaves the claim unproven.

Record stop/recovery/concurrency as unverified unless actually exercised. One
successful job qualifies only that job, provider and candidate.

For a branch selected by the assignment, include its specific evidence: independent
review candidate/report; sealed design and Lead reconciliation; dependency ownership
and integration; heartbeat owner/creation/wake/deletion receipts; or recovery mandate,
old-owner settlement and replacement handback. Mark unexercised branches NOT_RUN.
The [candidate contract](contract.md) owns policy load paths and behavior.
Source inspection of those paths does not establish E2E outcomes.
