import type { HostConfig, Profile } from './types.ts';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { json } from './package.ts';
import { families, providerId, roleOfProfileId } from './profiles.ts';

// Single reader/writer for the Paseo host configuration. Production and tests
// cross this seam; nothing else may reach config.agents or config.daemon.
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const mcpFlags = ['enabled', 'injectIntoAgents'];

export function configFile(home: string) {
  if (!isAbsolute(home)) throw new Error('Absolute Paseo home required');
  const path = join(home, 'config.json');
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('Paseo config must be a regular file');
  const bytes = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const config: HostConfig = bytes === null ? { version: 1 } : JSON.parse(bytes);
  for (const value of [config, config.agents ?? {}, config.agents?.providers ?? {}, config.daemon ?? {}, config.daemon?.mcp ?? {}]) {
    if (!record(value)) throw new Error('Invalid Paseo configuration object');
  }
  if (!Array.isArray(config.daemon?.agentProfiles ?? [])) throw new Error('Invalid Paseo agentProfiles');
  return { path, bytes, config };
}

export function writeConfig(file: ReturnType<typeof configFile>, next: HostConfig) {
  // Recheck immediately before replacing; preserve config permissions and unrelated fields.
  const current = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
  if (current !== file.bytes) throw new Error('Paseo config changed during installation; retry');
  const temp = `${file.path}.slp-${process.pid}.tmp`;
  let created = false;
  try {
    writeFileSync(temp, json(next), { flag: 'wx', mode: file.bytes === null ? 0o600 : lstatSync(file.path).mode & 0o777 });
    created = true;
    renameSync(temp, file.path);
  } finally { if (created) rmSync(temp, { force: true }); }
}

export const providers = (config: HostConfig) => config.agents?.providers ?? {};
export const agentProfiles = (config: HostConfig) => config.daemon?.agentProfiles ?? [];

// One rule for "is this owned provider still exactly as we installed it".
export function verifyOwnedProviders(config: HostConfig, owned: Record<string, Record<string, unknown>>, preserve = 'installation') {
  for (const [id, expected] of Object.entries(owned)) {
    if (!isDeepStrictEqual(providers(config)[id], expected)) throw new Error(`Modified provider ${id}; preserve ${preserve}`);
  }
}

// Two acceptance modes for an owned profile:
//   'bound' — the Human may edit settings, but it must still point at an SLP role provider.
//   'exact' — nothing may have changed since installation.
export function matchOwnedProfile(config: HostConfig, expected: Profile, mode: 'bound' | 'exact') {
  const matches = agentProfiles(config).filter(p => (p as { id?: unknown }).id === expected.id);
  if (mode === 'exact') {
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], expected)) throw new Error(`Modified profile ${expected.id}; preserve installation`);
    return matches[0] as Profile;
  }
  const role = roleOfProfileId(expected.id);
  if (matches.length !== 1 || !families.some(f => (matches[0] as { provider?: unknown }).provider === providerId(role, f))) throw new Error(`Missing or rebound profile ${expected.id}`);
  return matches[0] as Profile;
}

export function verifyOwnedProfiles(config: HostConfig, owned: Profile[], mode: 'bound' | 'exact') {
  return new Map(owned.map(expected => [expected.id, matchOwnedProfile(config, expected, mode)]));
}

export function requireMcp(config: HostConfig) {
  if (mcpFlags.some(key => config.daemon?.mcp?.[key] !== true)) throw new Error('SLP requires Paseo MCP enabled and injected');
}
