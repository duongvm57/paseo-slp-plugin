// Pure package model constraints shared by discovery and write guards.
// These are necessary restrictions, not host availability or admission proof.
import type { FamilyId } from "./families.ts";

export const swe2ModelPattern = /^swe-2($|-)/;

export function modelConstraintForFamily(family: FamilyId) {
  return family === "devin" ? {
    pattern: swe2ModelPattern.source,
    description: "Devin bindings and enabled Peer pool options require a swe-2 model.",
  } : undefined;
}
