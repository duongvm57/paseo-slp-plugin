// plugin/shared/archetypes.ts — the 12 standard Peer seat archetypes the
// Manager's "Add a standard seat" picker seeds from. Pure data; token content comes
// from runtime/routing-vocabulary.ts, the shared canonical vocabulary
// (docs/spec/routing-criteria.md §6).
//
// The package owns the meaning of these standard seats: suitableFor/avoidFor
// are the closed 16-token `axis:value` set, read-only on the form, and notes
// seed from the package-provided explanation but are user-editable (local
// only — Jev never receives notes). The id set is reserved (§7.2): an option on one of these ids is a
// standard seat whose tokens must equal the packaged set; every other id is
// a custom seat with free strings. Every archetype ships a parked seat:
// blank provider, blank model, enabled:false, availability:"ready" (the only
// state the form writes) and roles:["peer"] — the Human fills
// provider/model/thinking from live catalog discovery before enabling. Ids
// are seat names for KINDS of work, not dispositions: disposition is an open
// vocabulary the assignment supplies.

import { STANDARD_SEAT_TOKENS } from "./runtime/routing-vocabulary.ts";

export interface SeatArchetype {
  id: string;
  provider: "" | string;
  roles: string[];
  model: string;
  enabled: boolean;
  availability: string;
  suitableFor: string[];
  avoidFor: string[];
  notes: string;
}

const seat = (id: keyof typeof STANDARD_SEAT_TOKENS, notes: string): SeatArchetype => ({
  id,
  provider: "",
  roles: ["peer"],
  model: "",
  enabled: false,
  availability: "ready",
  suitableFor: [...STANDARD_SEAT_TOKENS[id].suitableFor],
  avoidFor: [...STANDARD_SEAT_TOKENS[id].avoidFor],
  notes,
});

export const PEER_SEAT_ARCHETYPES: readonly SeatArchetype[] = [
  seat("lightweight-recon",
    "Package-managed seat: collects and summarizes against already-clear requirements — inventory, extraction, triage by an existing rubric. Fill provider and model from discovery; a cheap model is usually enough."),
  seat("standard-coding",
    "Package-managed seat: produces software changes or test sets under settled acceptance — the default work seat. Deciding a new contract or investigating an open mechanism belongs to a more suitable seat."),
  seat("deep-reasoning",
    "Package-managed seat: judgment-heavy reasoning, design and verification — pick a stronger model or higher reasoning effort. Warns on fully rule-following (mechanical) work to avoid spending a heavy runtime."),
  seat("independent-second-opinion",
    "Package-managed seat: an independent verdict on an existing candidate or proposal. Independence is checked against the writer per assignment — prefer a different provider family than the implementation seats."),
  seat("autonomous-long-running",
    "Package-managed seat: work that must pass checkpoints and continue after each intermediate result (staged flow). A Devin-family seat requires a swe-2 model id — fill the exact variant from discovery."),
  seat("test-authoring",
    "Package-managed seat: builds test sets from existing acceptance or verifies a frozen candidate through tests — the QC checker, not the implementer."),
  seat("spec-docs-writing",
    "Package-managed seat: documentation and specs recording existing decisions — prose quality and accuracy are the product. Work that must itself decide software behavior routes by that technical obligation first."),
  seat("security-review",
    "Package-managed seat: builds threat models or verifies security on a candidate — auth boundaries, abuse cases, secrets, dependency risk. Fixing the product is a separate change assignment."),
  seat("debugging-root-cause",
    "Package-managed seat: answers failure-mechanism questions with evidence — reproduces before touching code. The post-cause fix is a separate change assignment."),
  seat("mechanical-refactor",
    "Package-managed seat: code transformations under a complete rule — codemods, rename sweeps, migrations whose mapping already decides behavior. Work still needing logic choices or open questions prefers another seat."),
  seat("research-spike",
    "Package-managed seat: feasibility or technology-choice questions answered by survey and experiment — ends in a report or throwaway code, never the production change."),
  seat("data-migration",
    "Package-managed seat: data and persisted-schema transformations — one-step conversions and multi-checkpoint backfills with rollback evidence and validation gates between steps."),
];
