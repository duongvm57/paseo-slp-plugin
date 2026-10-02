// Plain recovery vocabulary and bounds; no host, filesystem or schema dependency.
export const DESK_REJECTION_LIMITS = {
  rejectionMessage: 2048,
  rejectionRecovery: 1024,
} as const;
export const DESK_RECOVERY_LIMITS = {
  recoverActorKey: 128,
  recoverNonce: 64,
  recoverResult: 32,
} as const;
export const DESK_RECOVERY_RESULTS = [
  "home-unverified", "target-mismatch", "actor-invalid", "unsafe",
  "recover-lock-io", "busy", "recover-lock-orphan", "no-lock",
  "unreadable", "held", "undetermined", "changed", "audit-failed",
  "unlink-failed", "unlink-unsynced", "recovered", "internal-error",
] as const;
export type DeskRecoveryResultValue = typeof DESK_RECOVERY_RESULTS[number];
