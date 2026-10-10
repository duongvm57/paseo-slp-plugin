// Ordinary formation and macro orchestration receipts. Immutable files hold
// the exact invocation and each phase; the task ledger still owns task effects.
// Only the winner of the exclusive intent publication executes. A crash or
// concurrent replay reads partial evidence and NEVER continues effects.
import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalSha256 } from "./config-view.ts";
import { assertRealComponents, ensurePrivateDirectory, fsyncDirectory } from "./kept-files.ts";
import type { DeskRejectionValue } from "../shared/enforcement.ts";
import { WIRE_LIMITS } from "../shared/enforcement.ts";

const CAP = WIRE_LIMITS.deskBridgeRequestBytes;
const LEGACY_SCAN_LIMIT = 4096;
const LEGACY_SCAN_BYTES = 16 * 1024 * 1024;
const Record = z.object({
  schemaVersion: z.literal(1), previousSha256: z.string().length(64).nullable(),
  body: z.unknown(), sha256: z.string().length(64),
}).strict();
type Phase = { name: string; value: unknown };
export type OperationIdentity = { repoKey: string; membershipId: string; agentId: string; requestId: string; kind: "seat-create" | "task-deliver" };
const Identity = z.object({ repoKey: z.string().min(1), membershipId: z.string().min(1),
  agentId: z.string().min(1), requestId: z.string().min(1), kind: z.enum(["seat-create", "task-deliver"]) }).strict();
const Intent = z.object({ identity: Identity, request: z.unknown() }).strict();
const nativeKey = (identity: OperationIdentity) => canonicalSha256([
  identity.repoKey, identity.agentId, identity.kind, identity.requestId,
]);
const reject = (code: DeskRejectionValue["code"], message: string): DeskRejectionValue => ({
  ok: false, code, message, recovery: "retain this operation; inspect its receipt and reconcile recorded identities without resubmitting effects",
});

export function createDeskOperations(stableRoot: string) {
  const namespace = join(stableRoot, "state", "operations");
  const pathOf = (identity: OperationIdentity) => join(stableRoot, "state", "operations",
    nativeKey(identity));
  function read(path: string): z.infer<typeof Record> | null {
    let fd;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > CAP) throw new Error("operation record is not a bounded regular file");
      const row = Record.parse(JSON.parse(readFileSync(fd, "utf8")));
      if (row.sha256 !== canonicalSha256({ previousSha256: row.previousSha256, body: row.body })) throw new Error("operation record digest mismatch");
      return row;
    } finally { closeSync(fd); }
  }
  function write(path: string, body: unknown, previousSha256: string | null) {
    const row = { schemaVersion: 1, previousSha256, body, sha256: canonicalSha256({ previousSha256, body }) };
    const bytes = JSON.stringify(row);
    if (Buffer.byteLength(bytes) > CAP) throw new Error("operation record exceeds budget");
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    fsyncDirectory(join(path, ".."), process.platform);
    return row.sha256;
  }
  /** Early format-v1 receipts used an epoch-dependent address. Resolve their
   * immutable native tuple without moving/resealing bytes. Unknown, ambiguous
   * or over-budget history cannot prove absence and admits no new invocation.
   * New receipts use the stable key; reads of those do not scan old history. */
  function locate(identity: OperationIdentity): { path: string; existing: boolean } {
    const path = pathOf(identity);
    assertRealComponents(stableRoot, path, "operation receipt");
    if (read(join(path, "intent.json")) !== null) return { path, existing: true };
    assertRealComponents(stableRoot, namespace, "operation namespace");
    let names: string[];
    try { names = readdirSync(namespace); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, existing: false }; throw error; }
    if (names.length > LEGACY_SCAN_LIMIT) throw new Error("legacy operation inventory exceeds its bound");
    let found: string | null = null, bytes = 0;
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name)) throw new Error("unsupported operation namespace entry");
      const legacyPath = join(namespace, name);
      assertRealComponents(stableRoot, legacyPath, "retained operation receipt");
      const intent = read(join(legacyPath, "intent.json"));
      if (intent === null) continue; // no published intent means no admitted effect
      bytes += Buffer.byteLength(JSON.stringify(intent));
      if (bytes > LEGACY_SCAN_BYTES) throw new Error("legacy operation inventory exceeds its byte bound");
      const original = Intent.parse(intent.body).identity;
      if (nativeKey(original) !== nativeKey(identity)) continue;
      if (found !== null) throw new Error("ambiguous retained native operation identity");
      found = legacyPath;
    }
    return { path: found ?? path, existing: found !== null };
  }
  function inspect(identity: OperationIdentity, request?: unknown, mutation = false, resolvedPath?: string) {
    const path = resolvedPath ?? locate(identity).path;
    assertRealComponents(stableRoot, path, "operation receipt");
    const intent = read(join(path, "intent.json"));
    if (intent === null) return reject("EVIDENCE_INCOMPLETE", "this operation has no retained intent");
    const body = Intent.parse(intent.body);
    if (intent.previousSha256 !== null || nativeKey(body.identity) !== nativeKey(identity)) return reject("ACTOR_MISMATCH", "operation identity differs from its native caller");
    const callerEpochMatches = body.identity.membershipId === identity.membershipId;
    if (mutation && !callerEpochMatches) return reject("ACTOR_MISMATCH", "this native operation retains its original caller epoch; a new epoch cannot execute it");
    if (request !== undefined && canonicalSha256(body.request) !== canonicalSha256(request)) return reject("IDEMPOTENCY_CONFLICT", "request differs from its immutable operation intent");
    let previous = intent.sha256;
    const phases: Phase[] = [];
    for (let index = 0; index < 16; index++) {
      const row = read(join(path, `${index}.json`));
      if (row === null) break;
      if (row.previousSha256 !== previous) throw new Error("operation phase lineage differs");
      phases.push(z.object({ name: z.string().min(1).max(64), value: z.unknown() }).strict().parse(row.body));
      previous = row.sha256;
    }
    const result = read(join(path, "result.json"));
    if (result !== null && result.previousSha256 !== previous) throw new Error("operation result lineage differs");
    return { ok: true as const, identity: body.identity, callerEpochMatches, intentSha256: intent.sha256, receiptSha256: result?.sha256 ?? previous,
      state: result === null ? "partial" : "recorded", phases, result: result?.body ?? null,
      replayed: true, acceptance: "not-established-by-this-receipt" as const };
  }
  return {
    get(identity: OperationIdentity) {
      try { return inspect(identity); } catch { return reject("STATE_UNREADABLE", "retained operation evidence is unreadable or invalid"); }
    },
    async run(identity: OperationIdentity, request: unknown,
      execute: (phase: (name: string, value: unknown) => void) => Promise<unknown>,
      preflight?: () => Promise<unknown | null>) {
      let path: string;
      let previous: string;
      try {
        let located = locate(identity);
        if (located.existing) return inspect(identity, request, true, located.path);
        if (preflight !== undefined) {
          const choice = await preflight();
          // A caller may have admitted this native identity while we awaited
          // choice discovery. Retained evidence wins, including conflicts.
          located = locate(identity);
          if (located.existing) return inspect(identity, request, true, located.path);
          if (choice !== null) return choice;
        }
        path = located.path;
        assertRealComponents(stableRoot, path, "operation receipt");
        ensurePrivateDirectory(path, process.platform);
        previous = write(join(path, "intent.json"), { identity, request }, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          try { return inspect(identity, request, true); } catch { return reject("STATE_UNREADABLE", "retained operation evidence is unreadable or invalid"); }
        }
        return reject("STATE_UNREADABLE", "operation intent could not be durably published; no new effect was admitted");
      }
      let index = 0;
      const phase = (name: string, value: unknown) => {
        if (index >= 16) throw new Error("operation phase budget exhausted");
        previous = write(join(path, `${index++}.json`), { name, value }, previous);
      };
      try {
        const result = await execute(phase);
        write(join(path, "result.json"), result, previous);
        const view = inspect(identity, request);
        return { ...view, replayed: false };
      } catch {
        // No second write can safely turn a failed durable phase into success.
        return { ...this.get(identity), recovery: "inspect partial phases and original host/ledger identities; no automatic continuation or retry" };
      }
    },
  };
}
