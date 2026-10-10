// Native SLP aliases require Paseo's per-client V2 runtime. V1's shared
// server manager cannot establish the alias command/sentinel boundary.
// This bootstrap-safe predicate is shared by detection and every gate launch:
// a stable PATH alias can change targets after activation.
/** @param {string} output */
export function supportsOpenCodeVersion(output) {
  const match = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/i.exec(output.trim());
  return match !== null && match[1] === '2'
    && (Number(match[2]) > 0 || Number(match[3]) >= 10);
}

export const OPENCODE_VERSION_REQUIREMENT = 'OpenCode V2 >=2.0.10 (Paseo >=0.10.3; V1 and unknown majors unsupported)';
