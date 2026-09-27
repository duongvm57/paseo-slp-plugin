// src/jev.mjs — Jev (TypeSafe "System One") bounded-decision transport.
//
// Jev is not a generative model and can never be an agent provider: it answers
// typed questions (noul/choice/score) about a caller-supplied `state` with
// calibrated probabilities. This module owns ONLY the transport boundary:
//   - per-daemon config resolution (toggles + key), fail-closed
//   - request building + fetch with ~5s timeout and at most one bounded retry
//   - typed-answer validation against the declared question set
//   - credential-shaped-string redaction before send
//   - decision-receipt construction + offline consistency verification
// It knows nothing about routing; consumers (src/jev-routing.mjs, future
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

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { hash } from './package.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sha256Pattern = /^[0-9a-f]{64}$/;

export class JevError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
const jevError = (code, message, details) => new JevError(code, message, details);

// ---------------------------------------------------------------------------
// Per-daemon config + key
// ---------------------------------------------------------------------------

// Historical default kind — its defaults keep their exported names.
export const JEV_DEFAULT_BASE_URL = 'https://openrouter.ai';
export const JEV_DEFAULT_MODEL = 'typesafe/jev-1.13';
// OpenRouter Jev model ids are `<owner>/jev-<version>`; aliases (~typesafe/
// jev-latest, jev-latest, jev-preview) drift and are rejected here. The
// first-party API pins bare versioned ids (jev-1.13.0) instead.
const pinnedModelPattern = /^[a-z0-9-]+\/jev-\d+\.\d+(\.\d+)?$/;
const typesafeModelPattern = /^jev-\d+\.\d+\.\d+$/;

export const jevConfigPath = home => join(home, 'slp-runtime', 'state', 'jev.json');
export const jevKeyPath = (home, kind) => join(home, 'slp-runtime', 'state', `jev-${kind}.key`);

// Transport seam: a provider kind owns its endpoint path, default baseUrl,
// model pin, baseUrl path rule and request extras — consumers do not change.
// requestExtras spread into the POST body: OpenRouter accepts
// ProviderPreferences (fallbacks pinned off); the native API has no provider
// field, so typesafe sends none.
const transports = {
  openrouter: {
    endpoint: '/api/alpha/decisions',
    defaultBaseUrl: JEV_DEFAULT_BASE_URL,
    modelPattern: pinnedModelPattern,
    modelHint: JEV_DEFAULT_MODEL,
    // The documented prefixed form is the only non-empty path allowed.
    baseUrlPathAllowed: path => path === '' || path === '/api/v1',
    baseUrlHint: 'a bare https origin or the documented prefixed form …/api/v1 (no other path, no query)',
    requestExtras: { provider: { allow_fallbacks: false } },
  },
  typesafe: {
    endpoint: '/v1/systemone',
    defaultBaseUrl: 'https://api.typesafe.ai',
    modelPattern: typesafeModelPattern,
    modelHint: 'jev-1.13.0',
    // Custom endpoint/proxy support: any origin+path prefix is a mount point.
    baseUrlPathAllowed: () => true,
    baseUrlHint: 'a bare https origin or an origin+path prefix (custom endpoint, no query)',
    requestExtras: {},
  },
};

export function readJevConfig(home) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw jevError('jev-config-invalid', 'Jev config requires an absolute daemon home');
  const path = jevConfigPath(home);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw jevError('jev-config-invalid', `Jev config at ${path} is not valid JSON: ${error.message}`);
  }
  if (!record(parsed) || parsed.schemaVersion !== 1) throw jevError('jev-config-invalid', `Jev config at ${path} requires schemaVersion=1`);
  if (typeof parsed.enabled !== 'boolean') throw jevError('jev-config-invalid', `Jev config at ${path}: enabled must be a boolean`);
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
  if (!record(parsed.provider) || !transports[parsed.provider.kind]) {
    throw jevError('jev-config-invalid', `Jev config at ${path}: provider.kind must be one of ${Object.keys(transports).join(', ')}`);
  }
  const transport = transports[parsed.provider.kind];
  const baseUrl = parsed.provider.baseUrl ?? transport.defaultBaseUrl;
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw jevError('jev-config-invalid', `Jev config at ${path}: provider.baseUrl is not a URL`);
  }
  if (parsedUrl.protocol !== 'https:') throw jevError('jev-config-invalid', `Jev config at ${path}: provider.baseUrl must be https`);
  const urlPath = parsedUrl.pathname.replace(/\/+$/, '');
  if (!transport.baseUrlPathAllowed(urlPath) || parsedUrl.search !== '' || parsedUrl.hash !== '') {
    throw jevError('jev-config-invalid', `Jev config at ${path}: provider.baseUrl must be ${transport.baseUrlHint}`);
  }
  if (!transport.modelPattern.test(parsed.provider.model ?? '')) {
    throw jevError('jev-config-invalid', `Jev config at ${path}: provider.model must be a pinned Jev id like ${transport.modelHint} — aliases (jev-latest, jev-preview) drift and are rejected`);
  }
  return {
    path,
    enabled: parsed.enabled,
    capabilities: { ...parsed.capabilities },
    provider: { kind: parsed.provider.kind, baseUrl: baseUrl.replace(/\/+$/, ''), model: parsed.provider.model },
  };
}

export function readJevKey(home, kind) {
  const path = jevKeyPath(home, kind);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw jevError('jev-key-missing', `Jev ${kind} key missing: expected ${path} (0600) — set it via the SLP Manager Jev card`);
    throw error;
  }
  if (!stat.isFile()) throw jevError('jev-key-invalid', `Jev ${kind} key at ${path} must be a regular file`);
  if ((stat.mode & 0o077) !== 0) {
    throw jevError('jev-key-permissions', `Jev ${kind} key at ${path} is group/other-accessible (mode ${(stat.mode & 0o777).toString(8).padStart(4, '0')}); chmod 600 required`);
  }
  const key = readFileSync(path, 'utf8').trim();
  if (key.length === 0 || /\s/.test(key)) throw jevError('jev-key-invalid', `Jev ${kind} key at ${path} is empty or contains whitespace`);
  return key;
}

// Fail-closed resolution for a capability call: config must exist, be enabled
// (master switch), and hold a readable key. "No daemon home / no config" is an
// error here — callers that want the OFF path check jev*Required first.
// allowShadow: an enabled-but-not-armed capability still resolves (routing
// uses it for shadow evaluation — emit the receipt while the Lead decides);
// the returned `armed` flag records which mode produced the decision. Strict
// consumers omit it and get jev-capability-off.
export function resolveJev(home, capability, { allowShadow = false } = {}) {
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
export function jevRoutingState(home) {
  let config;
  try {
    config = readJevConfig(home);
  } catch (error) {
    return { routing: 'error', error: error instanceof Error ? error.message : String(error) };
  }
  if (config === null) return { routing: 'unconfigured' };
  if (!config.enabled) return { routing: 'off' };
  return { routing: config.capabilities.routing === true ? 'armed' : 'shadow' };
}

// ---------------------------------------------------------------------------
// Redaction guard — credential-shaped strings never leave the machine
// ---------------------------------------------------------------------------

// These three are assembled from fragments so the source never contains a
// detector-matching secret literal; the runtime regexes are unchanged.
const openRouterKeyPattern = new RegExp('\\b' + 'sk-or-' + '[A-Za-z0-9_-]{12,}');
const privateKeyPattern = new RegExp('-----BEGIN ' + '[A-Z0-9 ]*' + 'PRIVATE' + ' KEY-----');
const awsKeyPattern = new RegExp('\\b' + 'AKIA' + '[0-9A-Z]{16}' + '\\b');
const credentialPatterns = [
  { name: 'openrouter-key', pattern: openRouterKeyPattern },
  // Bare TypeSafe keys — a custom-baseUrl endpoint can reflect the key in
  // error text; the Bearer variant is covered by bearer-token below.
  { name: 'typesafe-key', pattern: /\bts-[A-Za-z0-9_-]{12,}/ },
  { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'bearer-token', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: 'private-key-block', pattern: privateKeyPattern },
  { name: 'aws-access-key', pattern: awsKeyPattern },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/ },
];

// Throws jev-redacted naming only the pattern class + JSON path — the matched
// content itself is never included in the error (it would leak into logs).
// Object KEYS are tested too: a credential-shaped key rejects at its parent
// path so the key text never reaches the error either.
export function assertRedacted(payload) {
  const check = (text, path, what) => {
    const name = credentialShaped(text);
    if (name) throw jevError('jev-redacted', `Refusing to send: credential-shaped ${what} (${name}) at ${path === '' ? '<root>' : path}`);
  };
  const walk = (value, path) => {
    if (typeof value === 'string') return check(value, path, 'string');
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`));
    if (record(value)) for (const [key, item] of Object.entries(value)) {
      check(key, path, 'object key');
      walk(item, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(payload, '');
}

export function credentialShaped(text) {
  if (typeof text !== 'string') return null;
  return credentialPatterns.find(({ pattern }) => pattern.test(text))?.name ?? null;
}

// ---------------------------------------------------------------------------
// Canonical JSON + decision receipt (consistency artifact, not authenticity)
// ---------------------------------------------------------------------------

const sortValue = value => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
  return value;
};
export const canonicalJson = value => JSON.stringify(sortValue(value)) + '\n';

// Receipt = consistency artifact for offline verification (internal hash +
// structural checks). It is NOT cryptographic authenticity: a determined Lead
// could fabricate one — enforcement stays procedural (doctrine + audit).
const buildReceipt = ({ provider, state, questions, context, answers, requestId, responseModel, responseProvider, usage, issuedAt, latencyMs, attempts }) => {
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

const answerValid = (answer, question, name) => {
  if (!record(answer) || answer.type !== question.type) throw jevError('jev-response', `Answer ${name}: type mismatch or missing (expected ${question.type})`);
  if (answer.type === 'noul' && (typeof answer.noul !== 'number' || !(answer.noul >= 0 && answer.noul <= 1))) {
    throw jevError('jev-response', `Answer ${name}: noul must be a probability in [0,1]`);
  }
  if (answer.type === 'choice' && (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice))) {
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
export function verifyReceipt(decision) {
  const fail = message => { throw new Error(`Jev decision receipt: ${message}`); };
  if (!record(decision) || decision.schemaVersion !== 1 || decision.kind !== 'jev-decision') fail('requires schemaVersion=1 and kind=jev-decision');
  if (!record(decision.provider) || !nonempty(decision.provider.kind) || !nonempty(decision.provider.endpoint)) fail('provider{kind,endpoint} required');
  // The pin is per provider kind: OpenRouter ids are <owner>/jev-<version>,
  // the native API pins bare jev-<semver>. An unknown kind has no pin and
  // fails here rather than slipping an unpinned model through.
  const pin = transports[decision.provider.kind]?.modelPattern;
  if (!nonempty(decision.model) || !pin || !pin.test(decision.model)) fail('a pinned Jev model id is required');
  if (!sha256Pattern.test(decision.stateSha256 ?? '')) fail('stateSha256 must be a sha256 hex');
  if (!record(decision.questions) || Object.keys(decision.questions).length === 0) fail('questions must be a nonempty record');
  if (!record(decision.context)) fail('context must be a record');
  if (!record(decision.answers) || Object.keys(decision.answers).length === 0) fail('answers must be a nonempty record');
  if (!nonempty(decision.issuedAt)) fail('issuedAt timestamp required');
  if (!Number.isFinite(decision.latencyMs) || decision.latencyMs < 0) fail('latencyMs must be a non-negative number');
  if (!Number.isInteger(decision.attempts) || decision.attempts < 1) fail('attempts must be a positive integer');
  if (!sha256Pattern.test(decision.sha256 ?? '')) fail('sha256 must be a sha256 hex');
  for (const [name, question] of Object.entries(decision.questions)) {
    try {
      validateQuestion(name, question);
      answerValid(decision.answers[name], question, name);
    } catch (error) {
      fail(error instanceof JevError ? error.message : `answer/question ${name}: ${error.message}`);
    }
  }
  const { sha256, ...unsigned } = decision;
  if (hash(canonicalJson(unsigned)) !== sha256) fail('hash mismatch — the receipt was altered after issue');
  return true;
}

// ---------------------------------------------------------------------------
// Question/answer validation + transport
// ---------------------------------------------------------------------------

const guidanceValid = value => nonempty(value) || record(value) || Array.isArray(value);
function validateQuestion(name, question) {
  if (!record(question) || !['noul', 'choice', 'score'].includes(question.type)) throw jevError('jev-request-invalid', `Question ${name}: type must be noul, choice or score`);
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

const retryable = error =>
  error.code === 'jev-timeout' || error.code === 'jev-network' ||
  (error.code === 'jev-http' && (error.details?.status === 429 || error.details?.status >= 500));

// Remote-controlled text (error.message, error.code, auth/key labels) is
// untrusted: scrub credential-shaped substrings and bound the length before it
// reaches thrown errors, RPC details or logs. Reflected key material must not
// round-trip through our surfaces. The rebuild preserves each pattern's own
// flags (the bearer pattern is /i) and only adds 'g' — dropping /i would let
// lowercase `bearer <token>` through. Mirrored in plugin/server/jev.ts —
// keep the two implementations identical.
export const sanitizeRemoteText = (value, maxLength = 200) => {
  let text = String(value);
  for (const { pattern } of credentialPatterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    text = text.replace(new RegExp(pattern.source, flags), '<redacted>');
  }
  return text.slice(0, maxLength);
};

const httpError = async response => {
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
async function postDecision(provider, key, body, { fetchImpl, timeoutMs, retries }) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(provider.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error.name === 'TimeoutError' || error.name === 'AbortError'
        ? jevError('jev-timeout', `Jev request timed out after ${timeoutMs}ms`)
        : jevError('jev-network', `Jev request failed: ${error.message}`);
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

export async function askJev({ provider, key, state, questions, context = {} }, { fetchImpl = fetch, timeoutMs = 5000, retries = 1, now = () => new Date() } = {}) {
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
  let parsed;
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
const single = type => ({ name, instructions, criteria, ...rest }, options) =>
  askJev({ ...rest, questions: { [name]: { type, instructions, criteria } } }, options)
    .then(({ answers, receipt }) => ({ answer: answers[name], receipt }));
export const askChoice = single('choice');
export const askScore = single('score');
export const askNoul = single('noul');
