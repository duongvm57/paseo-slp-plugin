export interface JevProvider {
  kind: 'openrouter' | 'typesafe';
  baseUrl?: string;
  model: string;
  endpoint: string;
}
export interface JevQuestion {
  type: 'noul' | 'choice' | 'score';
  instructions: unknown;
  criteria?: Record<string, unknown> | unknown[];
}
export interface JevAnswer {
  type: JevQuestion['type'];
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  [key: string]: unknown;
}
export interface JevRequest {
  provider: JevProvider;
  key: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
  context?: Record<string, unknown>;
}
export interface JevOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  now?: () => Date;
}
type JevConfig = {
  path: string;
  enabled: false;
  capabilities: Record<string, boolean>;
  provider: null;
} | {
  path: string;
  enabled: true;
  capabilities: Record<string, boolean>;
  provider: Omit<JevProvider, 'endpoint'> & {
    baseUrl: string;
  };
};
type ReceiptInput = Omit<JevRequest, 'key'> & {
  context: Record<string, unknown>;
  answers: Record<string, unknown>;
  requestId?: unknown;
  responseModel?: string;
  responseProvider?: unknown;
  usage?: unknown;
  issuedAt: string;
  latencyMs: number;
  attempts: number;
};
export interface VerifiedJevReceipt {
  schemaVersion: number;
  kind: string;
  provider: Pick<JevProvider, 'kind' | 'endpoint'>;
  model: string;
  resolvedModel?: unknown;
  responseProvider?: unknown;
  stateSha256: string;
  questions: Record<string, JevQuestion>;
  context: Record<string, unknown>;
  answers: Record<string, unknown>;
  requestId?: unknown;
  usage?: unknown;
  issuedAt: string;
  latencyMs: number;
  attempts: number;
  sha256: string;
}
export interface JevReceipt extends VerifiedJevReceipt {
  resolvedModel: string;
  responseProvider: unknown;
  requestId: unknown;
  usage: unknown;
}
import type { RuntimeError } from './types.ts';
// plugin/server/runtime/cli/jev.ts — Jev (TypeSafe "System One") bounded-decision transport.
//
// Jev is not a generative model and can never be an agent provider: it answers
// typed questions (noul/choice/score) about a caller-supplied `state` with
// calibrated probabilities. This module owns ONLY the transport boundary:
//   - per-daemon config resolution (toggles + key), fail-closed
//   - request building + fetch with ~5s timeout and at most one bounded retry
//   - typed-answer validation against the declared question set
//   - credential-shaped-string redaction before send
//   - decision-receipt construction + offline consistency verification
// It knows nothing about routing; consumers (plugin/server/runtime/cli/jev-routing.ts, future
// capabilities) inject their own state/questions/context.
//
// Config (per daemon, outside repo/payload — plugin/state convention):
//   <daemonHome>/slp-runtime/state/jev.json            mode 0600
//   { schemaVersion: 1,
//     enabled: boolean,
//     capabilities: { routing: boolean, ...future bools },   // only when enabled
//     provider: { kind: "openrouter"|"typesafe", baseUrl?, model } }  // only when enabled
// Key: <daemonHome>/slp-runtime/state/jev-<kind>.key   mode must be *00
//
// TypeSafe first-party mapping (verified 2026-09-21 against the official API
// reference at docs.typesafe.ai — api.typesafe.ai, keys minted at
// console.typesafe.ai/keys): the native System One endpoint, NOT
// OpenAI-compatible chat/completions:
//   POST {baseUrl}/v1/systemone
//   { model, state: string|object|array, questions: {name: {type, instructions,
//     criteria}} }                                   — no `provider` field;
//     provider.allow_fallbacks is OpenRouter-only and must not be sent
//   → { model: "jev-1.13.0", answers: {name: {type, ...}},
//       usage: {input_tokens, output_tokens} }       — no id/provider fields
//   errors → 401 key, 422 body validation, 429 rate limit, 529 overloaded
// Models are pinned versioned ids (jev-1.13.0); aliases still reject. The
// documented auth probe is GET /v1/models (Bearer required). baseUrl may be
// a bare https origin or an origin+path prefix for a custom endpoint/proxy —
// path is appended after the prefix.
//
// OpenRouter mapping (verified 2026-09-20 against the OpenRouter OpenAPI at
// openrouter.ai/docs/api/api-reference/alphadecisions + the typesafe/jev-1.13
// model page): Jev is served through OpenRouter's Decisions API, NOT
// chat/completions — request/response are the native System One shape:
//   POST {baseUrl}/api/alpha/decisions
//   { model, state: string|object|array, questions: {name: {type, instructions,
//     criteria}}, provider?: ProviderPreferences }
//   → { id, model: "<resolved e.g. typesafe/jev-1.13-20260917>", provider,
//       answers: {name: {type, ...}}, usage: {cost, input_tokens, output_tokens} }
//   answers: noul → {type:"noul", noul}
//            choice → {type:"choice", choice, confidence?, probabilities?}
//            score  → {type:"score", score, confidence?, legend?, probabilities?}
//   errors → HTTP status + {error:{code,message}}
// ASSUMPTION: the OpenAPI declares server https://openrouter.ai/api/v1 with
// path /api/alpha/decisions (concatenating to /api/v1/api/alpha/decisions),
// while the model page and community examples use /api/alpha/decisions on the
// bare host. Default baseUrl is https://openrouter.ai (path appended below);
// operators hitting the prefixed form set baseUrl https://openrouter.ai/api/v1
// — the only non-empty path accepted (trailing slashes normalize away).
// ASSUMPTION: response fields `id`, `provider`, `usage` are optional in
// practice (required in the OpenAPI) — the receipt records them when present
// and tolerates their absence rather than failing an otherwise valid answer.

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { hash } from './package.ts';
import { JEV_TRANSPORTS as transports, assertRedacted as checkRedaction, sanitizeRemoteText } from "../../../shared/runtime/jev-transport.ts";
export { JEV_DEFAULT_BASE_URL, JEV_DEFAULT_MODEL, credentialShaped, sanitizeRemoteText } from "../../../shared/runtime/jev-transport.ts";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const sha256Pattern = /^[0-9a-f]{64}$/;

export class JevError extends Error {
  declare code: string;
  declare details?: { status?: number; [key: string]: unknown };
  constructor(code: string, message: string, details?: JevError['details']) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
const jevError = (code: string, message: string, details?: JevError['details']) => new JevError(code, message, details);

// ---------------------------------------------------------------------------
// Per-daemon config + key
// ---------------------------------------------------------------------------

// CLI retains its daemon-home interface; the Node disk owner takes stableRoot.
import { jevConfigPath as configPath, jevKeyPath as keyPath, readJevConfigFile, readJevKeyFile } from '../jev-state.ts';
export const jevConfigPath = (home: string) => configPath(join(home, 'slp-runtime'));
export const jevKeyPath = (home: string, kind: string) => keyPath(join(home, 'slp-runtime'), kind);

export function readJevConfig(home: string): JevConfig | null {
  if (typeof home !== 'string' || !isAbsolute(home)) throw jevError('jev-config-invalid', 'Jev config requires an absolute daemon home');
  const path = jevConfigPath(home);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    const observed = readJevConfigFile(join(home, 'slp-runtime'));
    if (!observed.ok) throw observed.error;
    parsed = observed.value;
  } catch (error) {
    throw jevError('jev-config-invalid', `Jev config at ${path} is not valid JSON: ${(error as RuntimeError).message}`);
  }
  if (!record(parsed) || parsed.schemaVersion !== 1) throw jevError('jev-config-invalid', `Jev config at ${path} requires schemaVersion=1`);
  if (typeof parsed.enabled !== 'boolean') throw jevError('jev-config-invalid', `Jev config at ${path}: enabled must be a boolean`);
  // Historical CLI dialect: unknown top/provider keys are ignored, and
  // provider-less OFF files stay readable. Plugin persisted/RPC parsing is
  // deliberately strict; do not silently normalize either adapter.
  // The OFF path must stay readable: capabilities/provider only gate Jev while
  // it is in use, and catalogBinding reads this file on every Peer prepare —
  // a coherent "disabled, not configured yet" config must not block unrelated
  // routing work. enabled !== true returns a bare view with no provider and
  // no armed capabilities; the full validation below runs only when Jev is
  // actually on, where a broken config still fails loud.
  if (parsed.enabled !== true) {
    return { path, enabled: false, capabilities: {}, provider: null };
  }
  if (!record(parsed.capabilities) || Object.values(parsed.capabilities).some(value => typeof value !== 'boolean')) {
    throw jevError('jev-config-invalid', `Jev config at ${path}: capabilities must be a record of booleans`);
  }
  if (!record(parsed.provider) || !transports[parsed.provider.kind as keyof typeof transports]) {
    throw jevError('jev-config-invalid', `Jev config at ${path}: provider.kind must be one of ${Object.keys(transports).join(', ')}`);
  }
  const transport = transports[parsed.provider.kind as keyof typeof transports];
  const baseUrl = parsed.provider.baseUrl ?? transport.defaultBaseUrl;
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl as string);
  } catch {
    throw jevError('jev-config-invalid', `Jev config at ${path}: provider.baseUrl is not a URL`);
  }
  if (parsedUrl.protocol !== 'https:') throw jevError('jev-config-invalid', `Jev config at ${path}: provider.baseUrl must be https`);
  const urlPath = parsedUrl.pathname.replace(/\/+$/, '');
  if (!transport.baseUrlPathAllowed(urlPath) || parsedUrl.search !== '' || parsedUrl.hash !== '') {
    throw jevError('jev-config-invalid', `Jev config at ${path}: provider.baseUrl must be ${transport.baseUrlHint}`);
  }
  if (!transport.modelPattern.test(parsed.provider.model as string ?? '')) {
    throw jevError('jev-config-invalid', `Jev config at ${path}: provider.model must be a pinned Jev id like ${transport.modelHint} — aliases (jev-latest, jev-preview) drift and are rejected`);
  }
  return {
    path,
    enabled: parsed.enabled,
    capabilities: { ...parsed.capabilities } as Record<string, boolean>,
    provider: { kind: parsed.provider.kind as JevProvider['kind'], baseUrl: (baseUrl as string).replace(/\/+$/, ''), model: parsed.provider.model as string },
  };
}

export function readJevKey(home: string, kind: string) {
  const path = jevKeyPath(home, kind);
  const observed = readJevKeyFile(join(home, 'slp-runtime'), kind);
  if (!observed.ok) {
    if (observed.reason === 'missing') throw jevError('jev-key-missing', `Jev ${kind} key missing: expected ${path} (0600) — set it via the SLP Manager Jev card`);
    if (observed.reason === 'not-regular') throw jevError('jev-key-invalid', `Jev ${kind} key at ${path} must be a regular file`);
    if (observed.reason === 'permissions') {
      throw jevError('jev-key-permissions', `Jev ${kind} key at ${path} is group/other-accessible (mode ${observed.mode!.toString(8).padStart(4, '0')}); chmod 600 required`);
    }
    // Preserve raw filesystem errors from either lstat or the later read.
    throw observed.error;
  }
  if (!observed.valid) throw jevError('jev-key-invalid', `Jev ${kind} key at ${path} is empty or contains whitespace`);
  return observed.key;
}

// Fail-closed resolution for a capability call: config must exist, be enabled
// (master switch), and hold a readable key. "No daemon home / no config" is an
// error here — callers that want the OFF path check jev*Required first.
// allowShadow: an enabled-but-not-armed capability still resolves (routing
// uses it for shadow evaluation — emit the receipt while the Lead decides);
// the returned `armed` flag records which mode produced the decision. Strict
// consumers omit it and get jev-capability-off.
export function resolveJev(home: string, capability: string, { allowShadow = false } = {}) {
  const config = readJevConfig(home);
  if (config === null) {
    throw jevError('jev-unconfigured', `Jev is not configured for daemon home ${home}: expected ${jevConfigPath(home)} — configure it via the SLP Manager Jev card`);
  }
  if (!config.enabled) throw jevError('jev-disabled', 'Jev is disabled for this daemon (jev.enabled=false)');
  const armed = config.capabilities[capability] === true;
  if (!armed && !allowShadow) throw jevError('jev-capability-off', `Jev capability "${capability}" is not enabled for this daemon`);
  const key = readJevKey(home, config.provider.kind);
  const endpoint = config.provider.baseUrl.replace(/\/+$/, '') + transports[config.provider.kind].endpoint;
  return { provider: { ...config.provider, endpoint }, key, armed };
}

// Compact routing-mode view for catalog/status surfaces — a Lead reading
// `routes` sees whether a route-decide receipt would bind (armed), record
// (shadow), or be unavailable (off/unconfigured). 'error' reports a
// configured-but-unreadable jev.json instead of reading as unconfigured.
// Presence-only: never key material or provider details.
export function jevRoutingState(home: string) {
  let config;
  try {
    config = readJevConfig(home);
  } catch (error) {
    return { routing: 'error', error: error instanceof Error ? (error as RuntimeError).message : String(error) };
  }
  if (config === null) return { routing: 'unconfigured' };
  if (!config.enabled) return { routing: 'off' };
  return { routing: config.capabilities.routing === true ? 'armed' : 'shadow' };
}

// ---------------------------------------------------------------------------
// Redaction guard — credential-shaped strings never leave the machine
// ---------------------------------------------------------------------------

// Keep CLI error identity while the shared preflight owns traversal and patterns.
export function assertRedacted(payload: unknown) {
  checkRedaction(payload, message => jevError('jev-redacted', message));
}

// ---------------------------------------------------------------------------
// Canonical JSON + decision receipt (consistency artifact, not authenticity)
// ---------------------------------------------------------------------------

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
  return value;
};
export const canonicalJson = (value: unknown) => JSON.stringify(sortValue(value)) + '\n';

// Receipt = consistency artifact for offline verification (internal hash +
// structural checks). It is NOT cryptographic authenticity: a determined Lead
// could fabricate one — enforcement stays procedural (doctrine + audit).
const buildReceipt = ({ provider, state, questions, context, answers, requestId, responseModel, responseProvider, usage, issuedAt, latencyMs, attempts }: ReceiptInput): JevReceipt => {
  const receipt = {
    schemaVersion: 1,
    kind: 'jev-decision',
    provider: { kind: provider.kind, endpoint: provider.endpoint },
    model: provider.model,
    resolvedModel: responseModel ?? provider.model,
    responseProvider: responseProvider ?? null,
    stateSha256: hash(canonicalJson(state)),
    questions,
    context,
    answers,
    requestId: requestId ?? null,
    usage: usage ?? null,
    issuedAt,
    latencyMs,
    attempts,
  };
  return { ...receipt, sha256: hash(canonicalJson(receipt)) };
};

const answerValid = (answer: unknown, question: JevQuestion, name: string) => {
  if (!record(answer) || answer.type !== question.type) throw jevError('jev-response', `Answer ${name}: type mismatch or missing (expected ${question.type})`);
  if (answer.type === 'noul' && (typeof answer.noul !== 'number' || !(answer.noul >= 0 && answer.noul <= 1))) {
    throw jevError('jev-response', `Answer ${name}: noul must be a probability in [0,1]`);
  }
  if (answer.type === 'choice' && (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria!, answer.choice))) {
    throw jevError('jev-invalid-choice', `Answer ${name}: choice "${answer.choice}" is outside the declared candidate set`);
  }
  if (answer.type === 'score' && typeof answer.score !== 'number') throw jevError('jev-response', `Answer ${name}: score must be a number`);
  if (answer.confidence != null && typeof answer.confidence !== 'number') throw jevError('jev-response', `Answer ${name}: confidence must be a number`);
  if (answer.probabilities != null && (!record(answer.probabilities) || Object.values(answer.probabilities).some(p => typeof p !== 'number'))) {
    throw jevError('jev-response', `Answer ${name}: probabilities must be a numeric record`);
  }
};

// Offline verification of a receipt's internal consistency: shape, typed
// answers matching their questions, and the self-declared sha256. Throws
// Error('Jev decision receipt: ...') on any mismatch; returns true otherwise.
export function verifyReceipt(decision: unknown): decision is VerifiedJevReceipt {
  const fail: (message: string) => never = message => { throw new Error(`Jev decision receipt: ${message}`); };
  if (!record(decision) || decision.schemaVersion !== 1 || decision.kind !== 'jev-decision') fail('requires schemaVersion=1 and kind=jev-decision');
  if (!record(decision.provider) || !nonempty(decision.provider.kind) || !nonempty(decision.provider.endpoint)) fail('provider{kind,endpoint} required');
  // The pin is per provider kind: OpenRouter ids are <owner>/jev-<version>,
  // the native API pins bare jev-<semver>. An unknown kind has no pin and
  // fails here rather than slipping an unpinned model through.
  const pin = transports[decision.provider.kind as keyof typeof transports]?.modelPattern;
  if (!nonempty(decision.model) || !pin || !pin.test(decision.model)) fail('a pinned Jev model id is required');
  if (!sha256Pattern.test(decision.stateSha256 as string ?? '')) fail('stateSha256 must be a sha256 hex');
  if (!record(decision.questions) || Object.keys(decision.questions).length === 0) fail('questions must be a nonempty record');
  if (!record(decision.context)) fail('context must be a record');
  if (!record(decision.answers) || Object.keys(decision.answers).length === 0) fail('answers must be a nonempty record');
  if (!nonempty(decision.issuedAt)) fail('issuedAt timestamp required');
  if (!Number.isFinite(decision.latencyMs) || (decision.latencyMs as number) < 0) fail('latencyMs must be a non-negative number');
  if (!Number.isInteger(decision.attempts) || (decision.attempts as number) < 1) fail('attempts must be a positive integer');
  if (!sha256Pattern.test(decision.sha256 as string ?? '')) fail('sha256 must be a sha256 hex');
  for (const [name, question] of Object.entries(decision.questions)) {
    try {
      validateQuestion(name, question);
      answerValid(decision.answers[name], question, name);
    } catch (error) {
      fail(error instanceof JevError ? (error as RuntimeError).message : `answer/question ${name}: ${(error as RuntimeError).message}`);
    }
  }
  const { sha256, ...unsigned } = decision;
  if (hash(canonicalJson(unsigned)) !== sha256) fail('hash mismatch — the receipt was altered after issue');
  return true;
}

// ---------------------------------------------------------------------------
// Question/answer validation + transport
// ---------------------------------------------------------------------------

const guidanceValid = (value: unknown) => nonempty(value) || record(value) || Array.isArray(value);
function validateQuestion(name: string, question: unknown): asserts question is JevQuestion {
  if (!record(question) || !['noul', 'choice', 'score'].includes(question.type as string)) throw jevError('jev-request-invalid', `Question ${name}: type must be noul, choice or score`);
  if (!guidanceValid(question.instructions) || (typeof question.instructions === 'string' && !nonempty(question.instructions))) {
    throw jevError('jev-request-invalid', `Question ${name}: instructions required`);
  }
  if (question.type === 'noul' && question.criteria != null && (!record(question.criteria) || !guidanceValid(question.criteria.true) || !guidanceValid(question.criteria.false))) {
    throw jevError('jev-request-invalid', `Question ${name}: noul criteria must name both "true" and "false"`);
  }
  if (question.type === 'choice' && (!record(question.criteria) || Object.keys(question.criteria).length === 0 || Object.keys(question.criteria).some(key => !nonempty(key)) || Object.values(question.criteria).some(value => !guidanceValid(value)))) {
    throw jevError('jev-request-invalid', `Question ${name}: choice criteria must be a nonempty record of candidates`);
  }
  if (question.type === 'score' && (!Array.isArray(question.criteria) || question.criteria.length === 0 || question.criteria.some(value => !guidanceValid(value)))) {
    throw jevError('jev-request-invalid', `Question ${name}: score criteria must be a nonempty ordered list`);
  }
}

const retryable = (error: JevError) =>
  (error as RuntimeError).code === 'jev-timeout' || (error as RuntimeError).code === 'jev-network' ||
  ((error as RuntimeError).code === 'jev-http' && (error.details?.status === 429 || error.details?.status! >= 500));

// Remote-controlled HTTP detail is scrubbed by the shared credential rules.
const httpError = async (response: Response) => {
  let detail = '';
  try {
    const body = await response.json();
    if (record(body?.error)) {
      detail = nonempty(body.error.message)
        ? `: ${sanitizeRemoteText(body.error.message)}`
        : ` (code ${sanitizeRemoteText(body.error.code, 64)})`;
    }
  } catch { /* body not JSON */ }
  return jevError('jev-http', `Jev request failed with HTTP ${response.status}${detail}`, { status: response.status });
};

// HTTP delivery owns timeout creation, transport error normalization and the
// retry budget. Successful bodies stay outside this seam: malformed JSON or
// typed answers must fail once, never trigger another request.
async function postDecision(provider: JevProvider, key: string, body: unknown, { fetchImpl, timeoutMs, retries }: Required<Pick<JevOptions, 'fetchImpl' | 'timeoutMs' | 'retries'>> ) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(provider.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(timeoutMs),
      });
    } catch (error) {
      lastError = (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError'
        ? jevError('jev-timeout', `Jev request timed out after ${timeoutMs}ms`)
        : jevError('jev-network', `Jev request failed: ${(error as RuntimeError).message}`);
      if (attempt <= retries && retryable(lastError)) continue;
      throw lastError;
    }
    if (!response.ok) {
      lastError = await httpError(response);
      if (attempt <= retries && retryable(lastError)) continue;
      throw lastError;
    }
    return { response, attempts: attempt };
  }
  throw lastError;
}

export async function askJev({ provider, key, state, questions, context = {} }: JevRequest, { fetchImpl = fetch, timeoutMs = 5000, retries = 1, now = () => new Date() }: JevOptions = {}) {
  if (typeof state !== 'string' && !record(state) && !Array.isArray(state)) throw jevError('jev-request-invalid', 'state must be a string, object or array');
  if (!record(questions) || Object.keys(questions).length === 0) throw jevError('jev-request-invalid', 'questions must be a nonempty record');
  for (const [name, question] of Object.entries(questions)) validateQuestion(name, question);
  // Per-kind extras: OpenRouter pins provider.allow_fallbacks off; the
  // native TypeSafe API has no provider field and must not receive one.
  const body = { model: provider.model, state, questions, ...(transports[provider.kind]?.requestExtras ?? {}) };
  // Redaction runs over the exact outbound payload — after the request is
  // assembled, before any network call.
  assertRedacted(body);
  const started = Date.now();
  const { response, attempts } = await postDecision(provider, key, body, { fetchImpl, timeoutMs, retries });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw jevError('jev-response', 'Jev response is not valid JSON');
  }
  if (!record(parsed) || !nonempty(parsed.model) || !record(parsed.answers)) throw jevError('jev-response', 'Jev response requires model and answers');
  for (const [name, question] of Object.entries(questions)) answerValid(parsed.answers[name], question, name);
  const issuedAt = now().toISOString();
  const latencyMs = Date.now() - started;
  const receipt = buildReceipt({
    provider, state, questions, context,
    answers: parsed.answers,
    requestId: parsed.id,
    responseModel: parsed.model,
    responseProvider: parsed.provider,
    usage: parsed.usage,
    issuedAt, latencyMs, attempts,
  });
  return { answers: parsed.answers, receipt };
}

// The three typed primitives — one entry point each so future consumers
// (monitor triage, quotaFallback target selection, handoff readiness) never
// rewrite transport. `askJev` remains the multi-question form; each of these
// asks exactly one question and unwraps its answer.
const single = (type: JevQuestion['type']) => ({ name, instructions, criteria, ...rest }: Omit<JevRequest, 'questions'> & Omit<JevQuestion, 'type'> & { name: string }, options?: JevOptions) =>
  askJev({ ...rest, questions: { [name]: { type, instructions, criteria } } }, options)
    .then(({ answers, receipt }) => ({ answer: answers[name] as JevAnswer, receipt }));
export const askChoice = single('choice');
export const askScore = single('score');
export const askNoul = single('noul');
