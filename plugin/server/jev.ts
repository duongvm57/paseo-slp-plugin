// plugin/server/jev.ts — Jev per-daemon state, key lifecycle and live probe.
//
// Same class of operation as set-language/set-role-routing: plugin-owned files
// under <stableRoot>/state, no journal, no mutex, no authority gate. Two files:
//   state/jev.json             config + toggles (0600, atomic write)
//   state/jev-<kind>.key       provider key (0600, atomic write)
// The key is the only credential SLP holds: it is never journaled, never
// echoed back — every view reports `hasKey` only. Toggling a capability off
// never removes the stored key.
//
// Config/key readers retain their plugin schema and observational view —
// absent config = unconfigured (Jev OFF), corrupt config = error surfaced,
// key group/other-accessible = reported. Keep the two validators aligned.
// test-jev is the ONLY Jev RPC that touches the network (explicit human
// action — per kind: GET {origin}/api/v1/auth/key for openrouter, GET
// {baseUrl}/v1/models for typesafe); the fetch seam is injectable.

import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  GetJevInput,
  JevConfig,
  OperationConflict,
  SetJevInput,
  SetJevKeyInput,
  TestJevInput,
  type GetJevResult,
  type JevConfigValue,
  type JevProviderValue,
  type JevViewValue,
  type SetJevResult,
  type SetJevKeyResult,
  type TestJevResult,
} from "../shared/contracts.ts";
import { sha256Hex } from "./config-view.ts";
import { resolveDaemonHome } from "./daemon-home.ts";
import { writePrivate } from "./state-store.ts";
import { JEV_TRANSPORTS, assertRedacted as checkRedaction, sanitizeRemoteText } from "../shared/runtime/jev-transport.ts";

const JEV_FILE = join("state", "jev.json");
const keyFileName = (kind: string) => join("state", `jev-${kind}.key`);
const DEFAULT_KIND = "openrouter";
const KIND_LABEL: Record<string, string> = { openrouter: "OpenRouter", typesafe: "TypeSafe" };

// Live auth probe per provider kind — both are documented key-check
// endpoints that answer 401 on a bad Bearer. openrouter's probe lives under
// /api/v1 on the origin regardless of a configured /api/v1 prefix (resolve
// from origin so the prefixed form does not double-prefix). typesafe's
// /v1/models hangs off the configured baseUrl so a custom endpoint/proxy
// with a path prefix is probed at its own mount.
const probeUrl = (provider: { kind: string; baseUrl: string }): string =>
  provider.kind === "typesafe"
    ? `${provider.baseUrl.replace(/\/+$/, "")}/v1/models`
    : `${new URL(provider.baseUrl).origin}/api/v1/auth/key`;

export interface JevDeps {
  now?: () => Date;
  uuid?: () => string;
  fetchImpl?: typeof fetch;
}

// Home verification lives in server/daemon-home.ts (§8.1, shared with the
// manager) — this caller keeps its generic "lacks a readable regular
// config.json" message for a non-regular config.json.
const resolveHome = (target: { hostId: string; daemonHome: string }): { canonicalHome: string; stableRoot: string } =>
  resolveDaemonHome(target, "daemon home lacks a readable regular config.json");

// Absent file = unconfigured (null); corrupt or schema-mismatched content is
// evidence — surfaced as an error string, never silently treated as OFF.
// sha256 is the raw-file CAS token: present whenever the file exists, even
// broken, so a stale client can still overwrite it under CAS.
function readConfig(stableRoot: string): { config: JevConfigValue | null; sha256: string | null; error: string | null } {
  const file = join(stableRoot, JEV_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: null, sha256: null, error: null };
    throw error;
  }
  const sha256 = sha256Hex(raw);
  try {
    const parsed = JevConfig.safeParse(JSON.parse(raw));
    return parsed.success
      ? { config: parsed.data, sha256, error: null }
      : { config: null, sha256, error: `jev.json failed schema validation: ${parsed.error.issues[0]?.message ?? "schema"}` };
  } catch (error) {
    return { config: null, sha256, error: `jev.json is not valid JSON: ${(error as Error).message}` };
  }
}

function keyProbe(stableRoot: string, kind: string): { hasKey: boolean; keyPermissionsOk: boolean | null } {
  try {
    const stat = lstatSync(join(stableRoot, keyFileName(kind)));
    return { hasKey: stat.isFile(), keyPermissionsOk: stat.isFile() ? (stat.mode & 0o077) === 0 : null };
  } catch {
    return { hasKey: false, keyPermissionsOk: null };
  }
}

function view(stableRoot: string): JevViewValue {
  const { config, sha256, error } = readConfig(stableRoot);
  const probe = keyProbe(stableRoot, config?.provider.kind ?? DEFAULT_KIND);
  if (config === null) {
    // A file that exists but fails validation is configured-but-broken, not
    // unconfigured — the error field carries the evidence.
    return { configured: error !== null, enabled: null, capabilities: null, provider: null, ...probe, sha256, error };
  }
  return {
    configured: true,
    enabled: config.enabled,
    capabilities: config.capabilities,
    provider: config.provider,
    ...probe,
    sha256,
    error,
  };
}

// Atomic 0600 write — shared with the manager's state-file writes via
// ./state-store.ts.

export function createJev(deps: JevDeps = {}) {
  const uuid = deps.uuid ?? randomUUID;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = () => (deps.now ?? (() => new Date()))().getTime();

  async function getJev(input: unknown): Promise<GetJevResult> {
    const parsed = GetJevInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict("INVALID_REQUEST", `invalid get-jev input: ${parsed.error.issues[0]?.message ?? "schema"}`);
    }
    const ctx = resolveHome(parsed.data.target);
    return { schemaVersion: 1, jev: view(ctx.stableRoot) };
  }

  async function setJev(input: unknown): Promise<SetJevResult> {
    const parsed = SetJevInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict("INVALID_REQUEST", `invalid set-jev input: ${parsed.error.issues[0]?.message ?? "schema"}`);
    }
    const ctx = resolveHome(parsed.data.target);
    // CAS on the raw jev.json bytes — a save that overwrote a concurrent
    // client's capability keys would silently flip supervision; reject and
    // let the stale client reload first.
    const current = readConfig(ctx.stableRoot);
    if (current.sha256 !== parsed.data.expectedSha256) {
      throw new OperationConflict(
        "IDEMPOTENCY_CONFLICT",
        `jev.json changed since the client's read — reload and retry (expected sha256 ${parsed.data.expectedSha256 ?? "<none>"}, found ${current.sha256 ?? "<none>"})`,
      );
    }
    writePrivate(ctx.stableRoot, JEV_FILE, `${JSON.stringify(parsed.data.jev, null, 2)}\n`, uuid);
    return { schemaVersion: 1, jev: view(ctx.stableRoot) };
  }

  // `key` writes the file; `null` removes it. The value is written and
  // forgotten — never returned, never journaled.
  async function setJevKey(input: unknown): Promise<SetJevKeyResult> {
    const parsed = SetJevKeyInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict("INVALID_REQUEST", `invalid set-jev-key input: ${parsed.error.issues[0]?.message ?? "schema"}`);
    }
    const ctx = resolveHome(parsed.data.target);
    const { config } = readConfig(ctx.stableRoot);
    const file = keyFileName(config?.provider.kind ?? DEFAULT_KIND);
    if (parsed.data.key === null) {
      rmSync(join(ctx.stableRoot, file), { force: true });
    } else {
      if (/\s/.test(parsed.data.key)) {
        throw new OperationConflict("INVALID_REQUEST", "key must not contain whitespace");
      }
      writePrivate(ctx.stableRoot, file, `${parsed.data.key}\n`, uuid);
    }
    return { schemaVersion: 1, hasKey: parsed.data.key !== null };
  }

  // Live probe of the stored key against OpenRouter's key-info endpoint.
  // Returns ok:false + detail on any failure — never throws on network/API
  // errors, and never includes key material in the detail string.
  async function testJev(input: unknown): Promise<TestJevResult> {
    const parsed = TestJevInput.safeParse(input);
    if (!parsed.success) {
      throw new OperationConflict("INVALID_REQUEST", `invalid test-jev input: ${parsed.error.issues[0]?.message ?? "schema"}`);
    }
    const ctx = resolveHome(parsed.data.target);
    const { config, error } = readConfig(ctx.stableRoot);
    const fail = (detail: string, latencyMs = 0): TestJevResult => ({ schemaVersion: 1, ok: false, detail, latencyMs });
    if (config === null) return fail(error ?? "Jev is not configured for this daemon");
    const probe = keyProbe(ctx.stableRoot, config.provider.kind);
    if (!probe.hasKey) return fail(`no key stored — set the ${KIND_LABEL[config.provider.kind] ?? config.provider.kind} key first`);
    if (probe.keyPermissionsOk === false) return fail("key file is group/other-accessible — chmod 600 the jev key file");
    let key: string;
    try {
      key = readFileSync(join(ctx.stableRoot, keyFileName(config.provider.kind)), "utf8").trim();
    } catch (readError) {
      return fail(`key file unreadable: ${(readError as Error).message}`);
    }
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const label0 = KIND_LABEL[config.provider.kind] ?? config.provider.kind;
    try {
      const response = await fetchImpl(probeUrl(config.provider), {
        headers: { authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      const latencyMs = now() - started;
      if (!response.ok) return fail(`${label0} answered HTTP ${response.status}`, latencyMs);
      // OpenRouter's key-info answers {data:{label}}; /v1/models returns a
      // model list — a 2xx already proves the key, no field is consumed.
      const body: unknown = await response.json().catch(() => null);
      const label = config.provider.kind === "openrouter" && typeof body === "object" && body !== null && typeof (body as { data?: { label?: unknown } }).data?.label === "string"
        ? (body as { data: { label: string } }).data.label
        : null;
      return { schemaVersion: 1, ok: true, detail: label ? `key accepted (label ${sanitizeRemoteText(label, 120)})` : "key accepted", latencyMs };
    } catch (networkError) {
      return fail(`request failed: ${sanitizeRemoteText((networkError as Error).message)}`, now() - started);
    } finally {
      clearTimeout(timer);
    }
  }

  return { getJev, setJev, setJevKey, testJev };
}
export type Jev = ReturnType<typeof createJev>;

// ---------------------------------------------------------------------------
// Supervision decision requests (Phase B) — the observer's only HTTP path.
// Parity with plugin/server/runtime/cli/jev.ts resolveJev/askJev/postDecision: same endpoint join
// (baseUrl + kind endpoint), same requestExtras, same credential preflight
// over the assembled body, same envelope rule (model + answers record).
// Differences are the spec's: NO automatic retry (observer evaluation is
// single-shot), and an AbortSignal for plugin-stop instead of
// AbortSignal.timeout alone.
// ---------------------------------------------------------------------------

export class JevRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type SupervisionGate =
  | { ok: true; provider: JevProviderValue; authorization: string }
  | { ok: false; reason: string };

/** Fail-closed resolver for the supervision capability — config must exist,
 *  be enabled, hold capabilities.supervision === true, and carry a readable
 *  0600 key. Mirrors resolveJev(home, 'supervision') — allowShadow is NOT
 *  honored here: an unarmed capability must not evaluate. Reason codes are
 *  bounded strings safe for the Manager surface. */
export function resolveSupervision(stableRoot: string): SupervisionGate {
  let read: { config: JevConfigValue | null; error: string | null };
  try {
    read = readConfig(stableRoot);
  } catch {
    return { ok: false, reason: "jev-config-unreadable" };
  }
  const { config, error } = read;
  if (config === null) return { ok: false, reason: error !== null ? "jev-config-invalid" : "jev-unconfigured" };
  if (config.enabled !== true) return { ok: false, reason: "jev-disabled" };
  if (config.capabilities.supervision !== true) return { ok: false, reason: "jev-capability-off" };
  const transport = JEV_TRANSPORTS[config.provider.kind];
  if (transport === undefined) return { ok: false, reason: "jev-provider-unsupported" };
  const probe = keyProbe(stableRoot, config.provider.kind);
  if (!probe.hasKey) return { ok: false, reason: "jev-key-missing" };
  if (probe.keyPermissionsOk !== true) return { ok: false, reason: "jev-key-permissions" };
  let key: string;
  try {
    key = readFileSync(join(stableRoot, keyFileName(config.provider.kind)), "utf8").trim();
  } catch {
    return { ok: false, reason: "jev-key-unreadable" };
  }
  if (key === "" || /\s/.test(key)) return { ok: false, reason: "jev-key-invalid" };
  return { ok: true, provider: config.provider, authorization: `Bearer ${key}` };
}

// Keep the observer error identity; shared preflight owns traversal and patterns.
export function assertRedacted(payload: unknown): void {
  checkRedaction(payload, message => new JevRequestError("jev-redacted", message));
}

export interface JevDecisionRequest {
  state: unknown;
  questions: Record<string, { type: string; instructions: unknown; criteria: unknown }>;
}

export interface JevDecisionEnvelope {
  model: string;
  answers: Record<string, unknown>;
  usage: unknown;
  raw: Record<string, unknown>;
}

/** Single-shot Jev decision POST — the spec's "no automatic retry for
 *  observer evaluation" (retries=0, unlike the generic transport's one
 *  bounded retry). AbortSignal.timeout bounds the wait; the caller's signal
 *  aborts on plugin stop. Errors are JevRequestError with sanitized remote
 *  text — never key material, never the request body. */
export async function askJevDecision(
  provider: JevProviderValue,
  authorization: string,
  request: JevDecisionRequest,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JevDecisionEnvelope> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const transport = JEV_TRANSPORTS[provider.kind];
  if (transport === undefined) throw new JevRequestError("jev-request-invalid", `provider kind ${provider.kind} has no decision endpoint`);
  if (typeof request.state !== "string" && !isRecord(request.state) && !Array.isArray(request.state)) {
    throw new JevRequestError("jev-request-invalid", "state must be a string, object or array");
  }
  if (!isRecord(request.questions) || Object.keys(request.questions).length === 0) {
    throw new JevRequestError("jev-request-invalid", "questions must be a nonempty record");
  }
  for (const [name, question] of Object.entries(request.questions)) {
    if (!isRecord(question) || question.type !== "choice") {
      throw new JevRequestError("jev-request-invalid", `Question ${name}: type must be choice`);
    }
    if (typeof question.instructions !== "string" || question.instructions.trim() === "") {
      throw new JevRequestError("jev-request-invalid", `Question ${name}: instructions required`);
    }
    if (!isRecord(question.criteria) || Object.keys(question.criteria).length === 0 ||
        Object.keys(question.criteria).some(key => key.trim() === "") ||
        Object.values(question.criteria).some(value => typeof value !== "string" || value.trim() === "")) {
      throw new JevRequestError("jev-request-invalid", `Question ${name}: choice criteria must be a nonempty record of candidates`);
    }
  }
  const body = { model: provider.model, state: request.state, questions: request.questions, ...transport.requestExtras };
  // Redaction runs over the exact outbound payload — after assembly, before
  // any network call (plugin/server/runtime/cli/jev.ts askJev parity).
  assertRedacted(body);
  const endpoint = provider.baseUrl.replace(/\/+$/, "") + transport.endpoint;
  // ES2022 lib lacks AbortSignal.any/timeout — own the controller: the
  // timeout bounds the wait, the caller's signal aborts on plugin stop.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  // The deadline covers the WHOLE request — headers AND body reads (parity
  // plugin/server/runtime/cli/jev.ts). Aborting the fetch signal aborts a stalled body stream on
  // a real transport, but the deadline must not depend on it: every body
  // read races a rejection armed on this controller's abort.
  const requestError = (error: unknown): JevRequestError => {
    const err = error as Error;
    if (opts.signal?.aborted) return new JevRequestError("jev-abort", "Jev request aborted — plugin stopping");
    if (timedOut || err.name === "TimeoutError" || err.name === "AbortError") {
      return new JevRequestError("jev-timeout", `Jev request timed out after ${timeoutMs}ms`);
    }
    return new JevRequestError("jev-network", `Jev request failed: ${sanitizeRemoteText(err.message)}`);
  };
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(opts.signal?.aborted
        ? new JevRequestError("jev-abort", "Jev request aborted — plugin stopping")
        : requestError(new Error("body read aborted")));
    }, { once: true });
  });
  const readJson = (res: Response): Promise<unknown> => Promise.race([res.json(), aborted]);
  let response: Response;
  let parsedJson: unknown;
  try {
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw requestError(error);
    }
    if (!response.ok) {
      let detail = "";
      try {
        const parsed: unknown = await readJson(response);
        if (isRecord(parsed) && isRecord(parsed.error)) {
          const remote = parsed.error;
          detail = typeof remote.message === "string" && remote.message !== ""
            ? `: ${sanitizeRemoteText(remote.message)}`
            : typeof remote.code === "string" && remote.code !== ""
              ? ` (code ${sanitizeRemoteText(remote.code, 64)})`
              : "";
        }
      } catch (error) {
        if (error instanceof JevRequestError) throw error;
        if (timedOut || (error as Error).name === "AbortError") throw requestError(error);
        /* body not JSON */
      }
      throw new JevRequestError("jev-http", `Jev request failed with HTTP ${response.status}${detail}`);
    }
    try {
      parsedJson = await readJson(response);
    } catch (error) {
      if (error instanceof JevRequestError) throw error;
      if (timedOut || (error as Error).name === "AbortError") throw requestError(error);
      throw new JevRequestError("jev-response", "Jev response is not valid JSON");
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
  if (!isRecord(parsedJson) || typeof parsedJson.model !== "string" || parsedJson.model === "" || !isRecord(parsedJson.answers)) {
    throw new JevRequestError("jev-response", "Jev response requires model and answers");
  }
  return { model: parsedJson.model, answers: parsedJson.answers, usage: parsedJson.usage, raw: parsedJson };
}
