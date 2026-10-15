// Retrospective metadata only. None of these observations grant authority.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Episode = { episodeId: string; rootAgentId: string };
export type EpisodeEvent = { kind: 'episode-opened' | 'episode-closed'; payload: Episode & {
  at?: string; outcome?: 'handback' | 'cancelled' | 'unknown';
} };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
export function episodeId(key: string): string {
  const hex = createHash('sha256').update(`slp-episode/1:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function readEpisode(value: unknown): Episode | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<Episode>;
  return typeof row.episodeId === 'string' && uuid.test(row.episodeId) && id(row.rootAgentId)
    ? { episodeId: row.episodeId, rootAgentId: row.rootAgentId } : null;
}
export function readLabels(value: unknown): Record<string, string> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.length > 128 || entries.some(([key, val]) => !id(key) || typeof val !== 'string' || val.length > 4096)) return null;
    return Object.fromEntries(entries);
  } catch { return null; }
}
export const labelledEpisode = (labels: Record<string, string> | null): Episode | null => readEpisode({
  episodeId: labels?.['slp.episode-id'], rootAgentId: labels?.['slp.episode-root'],
});
export const episodeLabels = (episode: Episode | null): Record<string, string> => episode === null ? {} : {
  'slp.episode-id': episode.episodeId, 'slp.episode-root': episode.rootAgentId,
};
export function creatorClass(labels: Record<string, string> | null): 'labelled' | 'root' | 'missing' {
  if (labelledEpisode(labels)) return 'labelled';
  if (labels === null || labels['slp.episode-id'] || labels['slp.episode-root']
    || labels['slp.formation'] || labels['paseo.parent-agent-id']) return 'missing';
  return 'root';
}

// Cache raw file identity, not just mtime/size: replacement and restored mtimes
// must not reuse an unrelated protocol. Bounded for long-lived plugin processes.
const protocols = new Map<string, { key: string; sha: string }>();
export function protocolSha256(repository: string): string {
  const path = join(repository, '.paseo-slp/workspace-protocol.md');
  const stat = statSync(path, { bigint: true });
  const key = [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs, stat.size].join(':');
  const cached = protocols.get(path);
  if (cached?.key === key) return cached.sha;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > 256n * 1024n
      || [opened.dev, opened.ino, opened.mtimeNs, opened.ctimeNs, opened.size].join(':') !== key) throw new Error('protocol changed');
    const sha = createHash('sha256').update(readFileSync(fd)).digest('hex');
    const after = fstatSync(fd, { bigint: true });
    if ([after.dev, after.ino, after.mtimeNs, after.ctimeNs, after.size].join(':') !== key) throw new Error('protocol changed');
    if (protocols.size >= 256) protocols.delete(protocols.keys().next().value!);
    protocols.set(path, { key, sha });
    return sha;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function seatMetadata(input: { role: string; disposition?: string; runtimeSha?: string; repository: string }) {
  const labels: Record<string, string> = { 'slp.role': input.role };
  const warnings: string[] = [];
  if (input.disposition) labels['slp.disposition'] = input.disposition;
  if (input.runtimeSha && /^[a-f0-9]{64}$/.test(input.runtimeSha)) labels['slp.runtime-sha'] = input.runtimeSha;
  else warnings.push('runtime-sha-unavailable');
  try { labels['slp.protocol-sha'] = protocolSha256(input.repository); }
  catch { warnings.push('protocol-sha-unavailable'); }
  return { labels, warnings };
}
