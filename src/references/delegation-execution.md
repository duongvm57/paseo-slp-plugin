# Delegation execution

Read before preparing a spawn, continuing a child, verifying creation,
recovering an ambiguous create or retrieving a delegation report.
Use delegation-formation.md first to classify the operation. For tiny tasks,
follow the repository protocol's tiny procedure and keep formation in the brief
or timeline when it permits that; runtime checks and structural invariants remain.
Read/re-read policy text under the common core's freshness rule.

1. Resolve project/task identity, repository root, authority and existing ownership.
   Inspect Paseo reachability, list_workspaces and relevant list_agents, plus Git
   changes in the target checkout. Establish baseline resources to preserve. Read
   the repository's .paseo-slp/workspace-protocol.md for tactics and budget.
   A worktree target missing .paseo-slp/ — gitignored local state holding absolute
   paths — needs the protocol materialized before route resolution:
   `slp.mjs materialize <target> --from <source>` when the installed copy supports
   it, else copy .paseo-slp/ and rebase absolute paths that point under the
   source root onto the target root. Materialize carries the repo catalog only
   when the source pinned one; a target without it resolves the user-scope pool
   like the source does. It also carries .paseo-slp/references/, the
   operational facts the protocol points to, when present. Explicit extra files outside .paseo-slp/ — untracked
   spec or evidence the seat must read — stage via repeated
   `--include <repo-path>` flags: verbatim copies, deduped by target path,
   preserved when already present.
   Resolve runtime sources through references/provider-routing.md; disposition
   belongs to the assignment. Complete its setup checks before the dependent
   preparation branch.
   Before parallel writers, use references/orchestration.md for merge-safe scope,
   shared-resource ownership, actual paths, the protocol-selected isolation tactic
   and integration/candidate freeze. Complete preflight with an owner map and
   available route, or report the exact missing prerequisite for the dependent
   branch.
2. Read `references/provider-routing.md` before runtime selection and follow
   its saved-profile or Peer-pool procedure, conditional Jev read trigger,
   provider inventory rules and complete-bundle/mode precedence. Refresh the
   selected profile or catalog hash and live provider discovery before prepare.
   Use prepare with the selected role, repository, workspaceId, assignment and
   fresh inventory; Peer requests carry route.optionId/catalogSha256.
   State in the brief that candidate/check handbacks require the `slp-record`
   block; the record does not replace prose.
   Record selected profile ID or catalog option ID/hash and the exact runtime
   bundle with the launch arguments.
   Use agent-scoped Paseo create_agent for every seat joining the team —
   Supervisor→Lead and Lead→Peer alike; it has no profile parameter. Only
   agent-scoped creation gives the host the parent link, report route and
   sidebar tree the team relies on: prompting an existing standalone session
   can observe work that session already owns but cannot carry a new
   delegation. Pass the pinned workspaceId, title and notifyOnFinish=true.
   Without an explicit placement override, create the child in the parent's
   workspace — a read-only review seat included. Create another workspace
   only for a declared worktree, repository or independently isolated lane
   requirement, and record the reason and resulting paths: "delegation should
   be isolated" or a tidier sidebar is not such a requirement. Isolation never
   substitutes for parentage, a shared workspace never merges write
   authority, and a second workspace on the same checkout is not filesystem
   isolation. The formation record catches both defects before the tool call:
   planning a new team while the operation is send_agent_prompt to a
   parentless or differently parented seat, or planning a second workspace
   for the same team with no isolation reason — stop and correct the plan
   rather than proceed or reclassify the call as observation.
   Use titles `Supervisor — <task>`, `Lead — <task>` and
   `Peer — <Disposition> — <task>`; for example Engineer and Reviewer Peers
   share the task label but have distinct dispositions. Pass taskLabel and the
   Peer disposition to prepare and preserve its returned title. For multiple
   seats with the same disposition, qualify taskLabel with their bounded scope
   or seat (for example `checkout totals / API review`). Resume keeps the name;
   prepare-handoff adds `Handoff` for a new session. Titles aid Human navigation;
   record actual agent IDs for ownership and report routing.
   initialPrompt contains the neutral assignment: project/task identifiers,
   repository/workspace, role/disposition, objective or open question, owned/excluded
   scope, read/write mode, separate authority grants, known constraints/dependencies
   (including discovered filename hazards and their recovery technique), any
   effort/scope bound (for example, cover the top-N highest-risk references
   first, then breadth), verification, your own agent ID as the report
   recipient, and handback. For review, follow review-gates.md's neutral brief:
   include the objective and acceptance, authority constraints, exact candidate,
   reviewer mandate and lens, source paths, relevant observed facts and unknowns,
   and focused proof questions; omit the desired verdict, writer identity and
   prior findings on a first review. Pin the selected mandate and operative
   brief/scope/plan revisions; the review seat stays distinct from writer and
   accepting owner. Missing or stale rules block dependent review rather than
   silently choosing axes or omitting judgment. For sealed design include the report
   visibility boundary. A Peer receives only relevant repository tactics and may
   propose a different solution.
   The provider supplies common/role instructions; do not paste them each time.
   For phased work, state the child's current authority and completion condition
   separately from the eventual project outcome. Pass required prerequisites
   intact. A later write grant is a separate assignment after its conditions are
   verified; describing the eventual repair does not grant those writes now.
   A standby Lead — requested before its task is concrete — gets a bounded
   read-only assignment: orient on the repository and protocol, acknowledge
   ownership and handback conditions, then await the task; the acknowledgment is
   its completion condition. The later task and write grant arrive as a separate
   assignment. For an N-peer fan-out, write one brief file per seat under a
   non-deliverable scratch path (for example .local-checks/), pass a short
   assignment plus assignmentFile=<absolute path> to prepare and keep briefs one
   per seat; the emitted prompt references the seat's brief file instead of
   inlining it. When supervision needs an observable brief, the Lead may opt
   into `assignmentFileMode: "snapshot"`: prepare validates and inlines the
   bounded file, while the default pointer mode retains the existing prompt and
   makes the brief axis unobservable.
3. Record the returned agent/workspace IDs, assignment and ownership in your timeline.
   Verify the returned child against host evidence — actual parent and
   workspace/cwd are host-queryable; check them using the full agent ID from
   the creation receipt. The report route is a property of the brief, not
   host-queryable state: confirm it by the child's first report reaching the
   named recipient. A title, a sent prompt or a manually assigned label is
   not evidence of parentage; where the host exposes neither route evidence
   nor parent/workspace metadata, record the visibility gap instead of
   inferring the relationship. If verification finds a wrong relation — a
   missing or mismatched parent or an unexpected workspace — preserve the
   evidence and take the correction to the owning parent or Human; do not
   delete, archive or respawn the seat yourself.
   If create_agent is aborted, times out or loses its response, its outcome is
   unknown: the child may still start. Keep that scope reserved to the pending
   creation. Reconcile the request with host events and child inventory; an empty
   list_agents result alone does not prove the request had no side effect.
   Adopt a matching child when identified. Create a replacement only after the
   host confirms the original request cannot still create a child and any existing
   owner is settled. If the host cannot resolve that uncertainty, report this
   delegation blocked and continue only unrelated scopes; do not retry the create.
   Paseo owns parentage. Establish independent judgment in a session separate from
   the implementer and the Lead's reasoning; follow references/orchestration.md
   for reuse of an existing independent Reviewer. CLI run, native subagents and
   context forks are not delegation substitutes.
   Apply the required review-gate invariant in the always-loaded delegation core.
4. Use references/monitoring.md to arrange event-driven waits, material reporting
   from Lead to Supervisor, and a heartbeat safety net when needed. On a
   finish/error/permission notification, read get_agent_status and
   get_agent_activity. If the full report is absent, inspect the host timeline
   through Paseo; report a visibility blocker if still unavailable. Follow-ups
   use send_agent_prompt to the existing child, with background=true and
   notifyOnFinish=true for asynchronous corrections. Idle is not acceptance.

If SLP profiles/providers are unavailable, report the missing setup.
The installed bin/slp.mjs prepare command remains an explicit offline fallback
for a Human-authorized stock Codex/Pi launch: it renders installed role bytes plus
assignment into create_agent arguments, without starting an agent. Never silently
route through a legacy role provider or imply that its title loads this policy.
