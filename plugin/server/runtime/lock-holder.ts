// The desk store, bridge and operator recovery read the same lock record.
// This module interprets the bytes and syscall result; each caller still
// owns waiting, re-entry, release and the authority to recover a lock.
import { DESK_RECOVERY_LIMITS } from "../../shared/runtime/desk-contract.ts";

export interface LockHolder {
  pid: number;
  instanceNonce: string;
  startedAt?: string;
}

export function parseLockHolder(bytes: Buffer | string): LockHolder | null {
  try {
    const value: unknown = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const { pid, instanceNonce, startedAt } = value as Record<string, unknown>;
    if (
      typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 ||
      typeof instanceNonce !== "string" || instanceNonce.length === 0 ||
      instanceNonce.length > DESK_RECOVERY_LIMITS.recoverNonce
    ) return null;
    return { pid, instanceNonce, ...(typeof startedAt === "string" ? { startedAt } : {}) };
  } catch {
    return null;
  }
}

export type LockHolderProcess = "alive" | "esrch" | "eperm" | "undetermined";

export function classifyLockHolderProcess(pid: number, kill: (pid: number) => void): LockHolderProcess {
  try {
    kill(pid);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ESRCH") return "esrch";
    if (code === "EPERM") return "eperm";
    return "undetermined";
  }
}
