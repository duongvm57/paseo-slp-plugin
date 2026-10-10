# Assignment continuity

A planned handoff keeps one assignment ID and its work history. The current
Lead offers responsibility to one exact registered Lead membership; that
recipient acknowledges it through the desk. The original registration stays
immutable, while an accepted ownership revision determines who may make new
owner commands.

This transfers responsibility for the existing assignment. It does not expand
the Human grant, authorize direct implementation, accept the project, retire an
agent or prove that resources have been released. Those obligations remain
with the assignment and effective workspace protocol.

## Prepare and receive a handoff

Both Leads need registered memberships on the same repository desk. Use the
tools advertised by that desk's bridge; a preparation packet or chat message
alone does not create an ownership receipt.

1. The current owner reads the operative brief, decisions, open scopes,
   required review, candidate/check evidence and resource accounts. Preserve
   outstanding work and unresolved findings in the handoff context.
2. That owner calls `slp_assignment_offer` with the assignment ID, current
   ownership revision, recipient's exact agent and membership IDs, and
   authority/context references. References are stored claims. An offer does
   not change the owner or add the recipient to the execution/canary roster.
3. The nominated Lead can discover and read the assignment while its offer is
   usable. It rereads the current ledger and brief before acknowledging the
   work; the offer does not freeze concurrent changes.
4. The recipient calls `slp_assignment_accept` with the offer ID and current
   ownership, ledger and brief revisions, a nonblank acknowledgment, a
   nullable settlement reference and an explicit resource-account array.
   The store checks these pins under its lock and appends one acceptance.
5. The receiving Lead continues the same work streams as current owner. The
   former owner loses permission for fresh owner mutations immediately,
   including while its session remains live. Session archival and resource
   cleanup are separate authorized actions; a settled Peer seat archives under
   authorized host controls per the installed monitoring rules, and archive
   alone never proves process, descendant or resource quiescence.

```mermaid
sequenceDiagram
    participant A as Current Lead
    participant D as Repository desk
    participant B as Receiving Lead
    A->>D: Offer exact recipient at ownership revision r
    Note over D: Owner and moving work remain unchanged
    B->>D: Read current work and revision pins
    B->>D: Accept with acknowledgment and resource account
    D-->>B: Immutable receipt; owner revision r + 1
    Note over A,D: Former owner cannot make fresh owner mutations
    B->>D: Continue the same assignment, scopes and decisions
```

Acceptance can happen before or after the former owner retires: its required
native action was completed by the offer. A currently live former owner
retains participant read access through its exact membership pin. A revoked
or rebound membership cannot use that history as current authority.

## Pins, retries and competing offers

| Operation | Required pins and account |
|---|---|
| `slp_assignment_offer` | `assignmentId`, `expectedOwnershipRevision`, `targetAgentId`, `targetMembershipId`, `authorityRef`, `contextRef`, `requestId`. |
| `slp_assignment_accept` | `assignmentId`, `offerId`, `expectedOwnershipRevision`, `expectedLedgerRevision`, `expectedBriefRevision`, `acknowledgment`, `settlementRef`, `resources`, `requestId`. |

Each resource entry records a `ref` and a declared disposition:
`released`, `retained` or `unknown`. An empty account with no
settlement reference records `settlement-account-missing`; a pointer or a
status label does not verify cleanup.

Several offers may exist at one ownership revision; only one can advance it.
A successful acceptance or assignment closure makes the other offers unusable.
Ledger or brief changes cause a revision conflict, so the recipient rereads
before submitting a changed intended body under a new request ID. An identical
request can return its original receipt without another write. A different
body under that key conflicts. Offer/accept replay still requires the caller's
exact current live membership and grants no fresh mutation authority.

An unavailable owner with no prior offer has no native succession path.
The desk reports the authority gap; a claimed Human pointer, attachment,
settlement record or supplied recap cannot replace the missing offer.

## Continue work and proof

A live Peer writer keeps its declared moving scope. If the departing Lead was
the explicitly authorized writer, the receiving Lead must use the existing
attachment/declaration rules to name a valid writer. Ownership acceptance
does not supply a direct-write grant or remove overlap and dependency checks.

Briefs, decisions, scope declarations, reviews, check attempts and settlement
records keep their original actors and revisions. History is checked against
the owner who held responsibility at each committed event. Current commands
use the current exact owner tuple.

Current review qualification uses the exact brief, scope, mandate and candidate
pins and excludes the current owner and declared writer. A reviewer who later
becomes owner keeps its valid historical observation, but that observation
cannot discharge its own current gate. Unchanged independent third-party
observations can remain usable. Succession introduces no fixed reviewer count
or correction quota; findings and disagreements still require Lead adjudication.

A canary pins its ownership revision as well as its roster after succession.
Acceptance invalidates an earlier canary pin even when its member set happens
to stay equal. Migration at revision zero preserves the legacy digest recipe.
Use the existing hold, rollback and fresh rollout paths rather than treating
the old canary as evidence for new responsibility.

Fresh check execution measures the bound checkout before execution and again
before committing its result. A changed snapshot under the same Git HEAD is
candidate drift. An unavailable or incomplete capture is a capability gap.
Historical replay does not run the command again. These two measurements do
not prove absence of a transient change that was subsequently reverted.

## Storage and preparation

Ledger v8 adds append-only `ownershipOffers` and `ownershipAccepts`; legacy
assignments have ownership revision zero and no invented acknowledgment.
Reading an older ledger migrates it in memory. The first successful write
persists the current v9 schema, including an empty task stream for legacy work;
a rejected operation does not materialize the schema upgrade.
Every read still verifies the complete event history.

New registration events bind the immutable header content by digest. Retained
events without that digest keep their original evidence shape; migration does
not retroactively authenticate a previously unrecorded membership pin.

`prepare-handoff` and its optional recap remain explicit-source preparation
tools. They disclose supplied claims and fresh candidate measurements, while
leaving native ownership, settlement and recipient acknowledgment unverified.
They never perform the desk acceptance or a host lifecycle action.

See [work coordination](work-coordination.md) for operative briefs, selected
review mandates and the read interfaces, and the [CLI reference](cli.md#prepare--prepare-handoff)
for preparation inputs.
