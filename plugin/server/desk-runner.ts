// Shared desk runner boundary. Feature modules own their commands and IO
// seams; every runner reads and binds envelopes through this store contract.

import type { DeskRejectionValue } from "../shared/enforcement.ts";
import type { DeskStore, LedgerValue, MembershipValue } from "./desk-store.ts";

export type DeskRunnerDeps = { store: DeskStore };
export type RunnerCtx = { repoKey: string; row: MembershipValue };

/** Read fresh after the dispatch guard and after a commit. Failure stays
 *  typed; a runner never answers from an unreadable ledger. */
export function readLedger(deps: DeskRunnerDeps, repoKey: string): Readonly<LedgerValue> | DeskRejectionValue {
  const read = deps.store.read(repoKey);
  if (read.state !== "ok") {
    return {
      ok: false,
      code: "STATE_UNREADABLE",
      message: `the bound repo ledger reads ${read.state}`,
      recovery: "the desk must read cleanly for a tool call to be answered",
    };
  }
  return read.ledger;
}

export const isRejection = (value: unknown): value is DeskRejectionValue =>
  typeof value === "object" && value !== null && "ok" in value && (value as { ok: unknown }).ok === false;

/** An envelope accepts only the durable hostId/gitCommonDir binding, not
 *  the derived fields stored alongside it in the ledger's repo row. */
export const repoEnvelope = (ledger: Readonly<LedgerValue>) => ({
  hostId: ledger.repo.hostId,
  gitCommonDir: ledger.repo.gitCommonDir,
});
