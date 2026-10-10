// The desk store, bridge and operator recovery read the same lock record.
// This module interprets the bytes and syscall result; each caller still
// owns waiting, re-entry, release and the authority to recover a lock.
import { readFileSync } from "node:fs";
import { DESK_RECOVERY_LIMITS } from "../../shared/runtime/desk-contract.ts";

export interface LockHolder {
  pid: number;
  instanceNonce: string;
  startedAt?: string;
  processIdentity?: string;
}

export function parseLockHolder(bytes: Buffer | string): LockHolder | null {
  try {
    const value: unknown = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const { pid, instanceNonce, startedAt, processIdentity } = value as Record<string, unknown>;
    if (
      typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 ||
      typeof instanceNonce !== "string" || instanceNonce.length === 0 ||
      instanceNonce.length > DESK_RECOVERY_LIMITS.recoverNonce
    ) return null;
    if (processIdentity !== undefined &&
        (typeof processIdentity !== "string" || processIdentity.length === 0 || processIdentity.length > 128)) return null;
    return { pid, instanceNonce, ...(typeof startedAt === "string" ? { startedAt } : {}),
      ...(typeof processIdentity === "string" ? { processIdentity } : {}) };
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

/** Linux/WSL kernel identity: boot UUID + process start ticks, independent of
 * wall-clock time and PID reuse. Missing host capability is identity doubt;
 * other platforms retain ESRCH-only recovery. */
export function readProcessIdentity(pid: number, deps: {
  platform?: string;
  readFile?: (path: string) => string;
} = {}): string | null {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  try {
    const bootPath = "/proc/sys/kernel/random/boot_id";
    const boot = readFile(bootPath).trim();
    const stat = readFile(`/proc/${pid}/stat`);
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(boot) || !/^\d+$/.test(ticks ?? "") ||
        readFile(bootPath).trim() !== boot) return null;
    return `${boot}:${ticks}`;
  } catch { return null; }
}
