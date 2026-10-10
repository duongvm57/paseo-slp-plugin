// Shared Jev provider rules and credential preflight. CLI decisions and the
// plugin observer keep their own config, retry and cancellation policies.
export const JEV_DEFAULT_BASE_URL = "https://openrouter.ai";
export const JEV_DEFAULT_MODEL = "typesafe/jev-1.13";

export type JevProviderKind = "openrouter" | "typesafe";
interface JevTransport {
  endpoint: string;
  defaultBaseUrl: string;
  modelPattern: RegExp;
  modelHint: string;
  baseUrlPathAllowed: (path: string) => boolean;
  baseUrlHint: string;
  requestExtras: Record<string, unknown>;
}

export const JEV_TRANSPORTS: Record<JevProviderKind, JevTransport> = {
  openrouter: {
    endpoint: "/api/alpha/decisions",
    defaultBaseUrl: JEV_DEFAULT_BASE_URL,
    modelPattern: /^[a-z0-9-]+\/jev-\d+\.\d+(\.\d+)?$/,
    modelHint: JEV_DEFAULT_MODEL,
    baseUrlPathAllowed: path => path === "" || path === "/api/v1",
    baseUrlHint: "a bare https origin or the documented prefixed form …/api/v1 (no other path, no query)",
    requestExtras: { provider: { allow_fallbacks: false } },
  },
  typesafe: {
    endpoint: "/v1/systemone",
    defaultBaseUrl: "https://api.typesafe.ai",
    modelPattern: /^jev-\d+\.\d+\.\d+$/,
    modelHint: "jev-1.13.0",
    baseUrlPathAllowed: () => true,
    baseUrlHint: "a bare https origin or an origin+path prefix (custom endpoint, no query)",
    requestExtras: {},
  },
};

// Assemble detector-matching literals from fragments so source files do not
// themselves look like credentials. Order and regex flags are contractual.
const credentialPatterns = [
  { name: "openrouter-key", pattern: new RegExp("\\b" + "sk-or-" + "[A-Za-z0-9_-]{12,}") },
  { name: "typesafe-key", pattern: /\bts-[A-Za-z0-9_-]{12,}/ },
  { name: "openai-style-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "bearer-token", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: "private-key-block", pattern: new RegExp("-----BEGIN " + "[A-Z0-9 ]*" + "PRIVATE" + " KEY-----") },
  { name: "aws-access-key", pattern: new RegExp("\\b" + "AKIA" + "[0-9A-Z]{16}" + "\\b") },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/ },
];

export function credentialShaped(text: unknown): string | null {
  if (typeof text !== "string") return null;
  return credentialPatterns.find(({ pattern }) => pattern.test(text))?.name ?? null;
}

// A rejected object key is reported at its parent path so matched text never
// enters diagnostics. Adapters supply their existing error class and code.
export function assertRedacted(payload: unknown, makeError: (message: string) => Error): void {
  const check = (text: string, path: string, what: string): void => {
    const name = credentialShaped(text);
    if (name) throw makeError(`Refusing to send: credential-shaped ${what} (${name}) at ${path === "" ? "<root>" : path}`);
  };
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") return check(value, path, "string");
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        check(key, path, "object key");
        walk(item, path === "" ? key : `${path}.${key}`);
      }
    }
  };
  walk(payload, "");
}

// Scrub before truncating, including case-insensitive bearer matches.
export function sanitizeRemoteText(value: unknown, maxLength = 200): string {
  let text = String(value);
  for (const { pattern } of credentialPatterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    text = text.replace(new RegExp(pattern.source, flags), "<redacted>");
  }
  return text.slice(0, maxLength);
}
