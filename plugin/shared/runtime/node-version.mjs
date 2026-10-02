// Bootstrap-safe JavaScript: this check runs before any native TypeScript import.
export const SUPPORTED_NODE_RANGE = '>=22.18.0 <23.0.0 || >=23.6.0';

/** @param {string} version */
export function supportsNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}
