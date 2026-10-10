// Ordinary formation selection. Only the admitted executor calls selectPeerSeat;
// CLI prepare/launchPlan revalidate receipts offline and never call this function.
import type { Provider, Route } from "./types.ts";
import { readCatalog, eligibleOptions, catalogBinding, ROUTE_DECISION_QUESTION, ROUTE_DECLINE_CANDIDATE } from "./routing.ts";
import { readJevConfig, canonicalJson, verifyReceipt } from "./jev.ts";
import { routeDecide } from "./jev-routing.ts";
import { hash } from "./package.ts";
import { seatTokenConflict } from "../../../shared/runtime/routing-vocabulary.ts";

export type PeerSelectionRequest = {
  repository: string; assignment: string; paseoHome: string;
  selection?: { optionId: string };
};
export type PeerSelectionMode = "unconfigured" | "off" | "shadow" | "armed";
export type SelectedPeer = {
  route: { optionId: string; catalogSha256: string; decision?: unknown };
  source: { repository: string; catalogFile: string; scope: string };
  mode: PeerSelectionMode; modeSha256: string;
  origin: "unique" | "lead" | "jev";
  // The full receipt is route.decision; retain the rest without duplicating it.
  decisionResult?: Omit<Awaited<ReturnType<typeof routeDecide>>, "decision">;
};
export class SeatSelectionError extends Error {
  readonly code: "INVALID_RECORD" | "ROUTE_DRIFT" | "REQUEST_TOO_LARGE";
  constructor(code: SeatSelectionError["code"], message: string) {
    super(message); this.name = "SeatSelectionError"; this.code = code;
  }
}
const MAX_SELECTION_BYTES = 32 * 1024;
const MAX_CHOICES = 32;
const MAX_CHOICES_BYTES = 32 * 1024;
function readInputs(request: PeerSelectionRequest) {
  // Unreadable configuration is an error, never equivalent to off.
  const config = readJevConfig(request.paseoHome);
  const mode: PeerSelectionMode = config === null ? "unconfigured" : !config.enabled ? "off"
    : config.capabilities.routing === true ? "armed" : "shadow";
  const catalog = readCatalog(request.repository, request.paseoHome);
  const usable = eligibleOptions(catalog, "peer").filter(option => !seatTokenConflict(option));
  if (usable.length === 0) throw new SeatSelectionError("INVALID_RECORD", "no eligible Peer option");
  if (request.selection && !usable.some(option => option.id === request.selection!.optionId)) {
    throw new SeatSelectionError("INVALID_RECORD", "selection is not an eligible Peer option");
  }
  return { catalog, usable, mode, modeSha256: hash(canonicalJson(config)),
    source: { repository: request.repository, catalogFile: catalog.path, scope: catalog.scope } };
}
function requireSameInputs(request: PeerSelectionRequest, selected: SelectedPeer) {
  const now = readInputs(request);
  if (now.catalog.sha256 !== selected.route.catalogSha256 || now.mode !== selected.mode
    || now.modeSha256 !== selected.modeSha256 || canonicalJson(now.source) !== canonicalJson(selected.source)) {
    throw new SeatSelectionError("ROUTE_DRIFT", "pool source or Jev configuration changed during formation");
  }
}
/** Pure local discovery; no decision, no intent or native resource is admitted. */
export async function preflightPeerChoice(request: PeerSelectionRequest) {
  const seen = readInputs(request);
  const needsChoice = request.selection === undefined && (seen.mode === "shadow"
    || ((seen.mode === "off" || seen.mode === "unconfigured") && seen.usable.length > 1));
  if (!needsChoice) return null;
  const choices: { optionId: string; provider: string; model: string; thinkingOptionId: string | null;
    suitableFor: string[]; avoidFor: string[] }[] = [];
  const reply = { ok: true as const, state: "selection-required" as const, operationAdmitted: false,
    mode: seen.mode, source: seen.source, catalogSha256: seen.catalog.sha256, choices,
    omittedCount: seen.usable.length };
  for (const option of seen.usable.slice(0, MAX_CHOICES)) {
    choices.push({ optionId: option.id, provider: option.provider, model: option.model,
      thinkingOptionId: option.thinkingOptionId ?? null, suitableFor: option.suitableFor, avoidFor: option.avoidFor });
    if (Buffer.byteLength(JSON.stringify(reply)) > MAX_CHOICES_BYTES) { choices.pop(); break; }
  }
  reply.omittedCount = seen.usable.length - choices.length;
  if (choices.length === 0) throw new SeatSelectionError("REQUEST_TOO_LARGE", "Peer choice surface exceeds its byte budget");
  return reply;
}
/** Verify the fixed selection against fresh local inputs/live provider facts. */
export function revalidatePeerSelection(request: PeerSelectionRequest, selected: SelectedPeer, providers: Provider[]) {
  requireSameInputs(request, selected);
  return catalogBinding(request.repository, "peer", providers, selected.route as Route, request.paseoHome);
}
export async function selectPeerSeat(request: PeerSelectionRequest, deps: {
  providers: Provider[]; phase: (name: string, value: unknown) => void;
  decide?: typeof routeDecide;
}): Promise<SelectedPeer> {
  const seen = readInputs(request);
  let optionId = request.selection?.optionId;
  if (seen.mode === "shadow" && optionId === undefined) {
    throw new SeatSelectionError("INVALID_RECORD", "shadow requires an independent Lead selection");
  }
  if ((seen.mode === "off" || seen.mode === "unconfigured") && optionId === undefined) {
    if (seen.usable.length !== 1) throw new SeatSelectionError("INVALID_RECORD", "multiple eligible Peer options require selection");
    optionId = seen.usable[0].id;
  }
  let decision: unknown;
  let decisionResult: SelectedPeer["decisionResult"];
  const provisional = { source: seen.source, mode: seen.mode, modeSha256: seen.modeSha256 };
  if (seen.mode === "armed" || seen.mode === "shadow") {
    deps.phase("route-issued", { ...provisional, catalogSha256: seen.catalog.sha256 });
    // No catch/fallback here. Decline, config/key, transport and schema failure
    // must block dependent creation. Transport's existing retry budget remains.
    const answer = await (deps.decide ?? routeDecide)({
      repository: request.repository, role: "peer", brief: request.assignment, paseoHome: request.paseoHome,
    });
    verifyReceipt(answer.decision);
    const receiptChoice = (answer.decision.answers[ROUTE_DECISION_QUESTION] as { choice?: unknown })?.choice;
    if (answer.catalogSha256 !== seen.catalog.sha256 || answer.role !== "peer"
      || answer.decision.context.armed !== (seen.mode === "armed")
      || answer.declined !== (receiptChoice === ROUTE_DECLINE_CANDIDATE)
      || answer.optionId !== (answer.declined ? null : receiptChoice)) {
      throw new SeatSelectionError("ROUTE_DRIFT", "decision envelope differs from its pinned mode/catalog/receipt");
    }
    const { decision: receipt, ...rest } = answer;
    decision = receipt; decisionResult = rest;
    if (seen.mode === "armed") {
      if (answer.declined) {
        const declined = { ...provisional, ...answer };
        if (Buffer.byteLength(JSON.stringify(declined)) > MAX_SELECTION_BYTES) {
          throw new SeatSelectionError("REQUEST_TOO_LARGE", "Peer decline receipt exceeds its byte budget");
        }
        deps.phase("route-declined", declined);
        throw new SeatSelectionError("INVALID_RECORD", "Jev declined Peer routing");
      }
      if (optionId !== undefined && optionId !== answer.optionId) {
        throw new SeatSelectionError("ROUTE_DRIFT", "independent selection differs from armed Jev");
      }
      optionId = answer.optionId!;
    }
  }
  const selected: SelectedPeer = {
    ...provisional, route: { optionId: optionId!, catalogSha256: seen.catalog.sha256,
      ...(decision !== undefined ? { decision } : {}) },
    origin: seen.mode === "armed" ? "jev" : request.selection ? "lead" : "unique",
    ...(decisionResult ? { decisionResult } : {}),
  };
  revalidatePeerSelection(request, selected, deps.providers);
  // Full receipt retained, or fail before native allocation. No lossy receipt.
  if (Buffer.byteLength(JSON.stringify(selected)) > MAX_SELECTION_BYTES) {
    throw new SeatSelectionError("REQUEST_TOO_LARGE", "Peer selection receipt exceeds its byte budget");
  }
  return selected;
}
