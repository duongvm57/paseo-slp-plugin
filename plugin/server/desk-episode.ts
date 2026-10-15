// Advisory episode tracking. The bridge is the writer; metadata IO never
// mutates the work ledger or admits/rejects a native effect. No host calls.
import { closeSync, constants, fdatasyncSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalSha256 } from './config-view.ts';
import { assertRealComponents, ensurePrivateDirectory, fsyncDirectory, lstatOrNull } from './kept-files.ts';
import { creatorClass, episodeId, episodeLabels, labelledEpisode, readEpisode, type Episode } from './runtime/episode.ts';
import { verifiedDeskEvents, type LedgerValue, type EventValue } from './desk-store.ts';

const EpisodeSchema = z.object({ episodeId: z.uuid(), rootAgentId: z.string().min(1).max(256) }).strict();
const OpenEvent = z.object({ kind: z.literal('episode-opened'), payload: EpisodeSchema.extend({ at: z.iso.datetime() }) }).strict();
const Body = z.object({ schemaVersion: z.literal(1), holderAgentId: z.string().min(1).max(256),
  current: EpisodeSchema, observedDesk: z.object({ repoKey: z.string(), head: z.string().nullable() }).strict(),
  events: z.array(OpenEvent).min(1).max(2048) }).strict();
const Header = Body.omit({ events: true });
const EntryBody = Header.omit({ current: true }).extend({ event: OpenEvent });
const Record = z.object({ body: EntryBody, previousSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type State = z.infer<typeof Body> & { lastSha256: string; bytes: number };
class MetadataFault extends Error {
  readonly warning: string;
  constructor(warning: string) { super(warning); this.warning = warning; }
}
export type EpisodeSelection = {
  episode: Episode | null; labels: Record<string, string>; warnings: string[]; basis: string;
};
type Creator = { agentId: string; labels: Record<string, string> | null; ledger: Readonly<LedgerValue> | null };
type Observation = { registered: readonly Episode[]; closed: ReadonlySet<string>; history: readonly EventValue[] | null;
  repoKey: string; head: string | null };
const selection = (episode: Episode | null, basis: string, warnings: string[] = []): EpisodeSelection => ({
  episode, basis, warnings, labels: episodeLabels(episode),
});

/** Read only already-verified desk events. Registration is the assignment
 * association; its root-assignment marker prevents a child handback/close
 * from closing the whole Supervisor episode. Legacy registrations stay gaps. */
export function assignmentEpisode(ledger: Readonly<LedgerValue>, assignmentId: string): Episode | null {
  const registered = verifiedDeskEvents(ledger)?.find(event => event.kind === 'assignment-registered'
    && event.payload.assignmentId === assignmentId);
  return readEpisode(registered?.payload);
}
function observedEpisodes(ledger: Readonly<LedgerValue> | null, agentId: string): Observation {
  if (!ledger) return { registered: [], closed: new Set(), history: null, repoKey: '', head: null };
  const history = verifiedDeskEvents(ledger);
  const associations = new Map((history ?? []).filter(event => event.kind === 'assignment-registered')
    .map(event => [event.payload.assignmentId, readEpisode(event.payload)]));
  const registered = ledger.assignments.filter(row => row.state === 'open'
    && (row.ownerAgentId === agentId || row.seats.some(seat => seat.agentId === agentId)))
    .flatMap(row => { const episode = associations.get(row.assignmentId); return episode ? [episode] : []; });
  return { registered: [...new Map(registered.map(row => [row.episodeId, row])).values()], history,
    repoKey: ledger.repo.repoKey, head: ledger.lastEventSha256,
    closed: new Set((history ?? []).filter(event => event.kind === 'episode-closed')
      .flatMap(event => { const episode = readEpisode(event.payload); return episode ? [episode.episodeId] : []; })) };
}

// A closed assignment invalidates an older pointer, but never one explicitly
// opened after that assignment was registered. Missing/cross-desk anchors are
// gaps, not evidence that the old pointer survived.
function observedAnchor(state: State, observation: Observation): number | null {
  if (!observation.history || state.observedDesk.repoKey !== observation.repoKey) return null;
  return state.observedDesk.head === null ? 0
    : observation.history.find(event => event.sha256 === state.observedDesk.head)?.seq ?? null;
}
function currentValid(state: State, observation: Observation): boolean {
  const anchor = observedAnchor(state, observation);
  if (anchor === null || observation.closed.has(state.current.episodeId)) return false;
  return !observation.history!.some(event => event.seq > anchor && event.kind === 'assignment-registered'
    && event.payload.ownerAgentId === state.holderAgentId && event.payload.episodeRootAssignment === true
    && typeof event.payload.episodeId === 'string' && observation.closed.has(event.payload.episodeId));
}

export function createEpisodeTracker(stableRoot: string, deps: { now?: () => Date } = {}) {
  const directory = join(stableRoot, 'state', 'episodes');
  const cache = new Map<string, { stamp: string; state: State }>();
  const pathOf = (agentId: string) => join(directory, `${canonicalSha256(agentId)}.jsonl`);
  const stamp = (stat: Stats) => [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size].join(':');
  function read(agentId: string): State | null {
    assertRealComponents(stableRoot, directory, 'episode metadata');
    const path = pathOf(agentId);
    let info;
    try { info = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new MetadataFault('episode-state-unsafe');
    if (info.size > 1024 * 1024) throw new MetadataFault('episode-state-budget');
    const cached = cache.get(agentId);
    if (cached?.stamp === stamp(info)) return cached.state;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || stamp(before) !== stamp(info)) throw new Error('episode metadata changed');
      let state: State | null = null;
      try {
        const bytes = readFileSync(fd, 'utf8');
        if (!bytes.endsWith('\n')) throw new Error('incomplete append');
        const byteLength = Buffer.byteLength(bytes);
        const lines = bytes.slice(0, -1).split('\n');
        if (lines.length > 2048) throw new MetadataFault('episode-state-budget');
        const events: State['events'] = [];
        let previousSha256: string | null = null;
        for (const line of lines) {
          const record = Record.parse(JSON.parse(line));
          const { event, ...entryHeader } = record.body;
          const header = { ...entryHeader, current: { episodeId: event.payload.episodeId, rootAgentId: event.payload.rootAgentId } };
          if (header.holderAgentId !== agentId || record.previousSha256 !== previousSha256
            || record.sha256 !== canonicalSha256({ body: record.body, previousSha256 })) throw new Error('invalid episode chain');
          events.push(event);
          previousSha256 = record.sha256;
          state = { ...header, events, lastSha256: record.sha256, bytes: byteLength };
        }
        if (!state || stamp(fstatSync(fd)) !== stamp(before)) throw new Error('episode metadata changed');
      } catch (error) {
        if (error instanceof MetadataFault) throw error;
        throw new MetadataFault('episode-state-corrupt');
      }
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(agentId, { stamp: stamp(info), state });
      return state;
    } finally { closeSync(fd); }
  }
  function existing(creator: Pick<Creator, 'agentId' | 'labels'>, observation: Observation, state: State | null): EpisodeSelection {
    const classification = creatorClass(creator.labels);
    if (classification === 'missing') return selection(null, 'missing-context', ['episode-context-missing']);
    if (!observation.history) return selection(null, 'missing-history', ['episode-history-unavailable']);
    if (observation.registered.length > 1) return selection(null, 'ambiguous', ['episode-context-ambiguous']);
    const current = state?.current;
    const anchor = state ? observedAnchor(state, observation) : null;
    const registeredAfterPointer = observation.history.some(event => event.kind === 'assignment-registered'
      && event.payload.ownerAgentId === creator.agentId && event.payload.episodeRootAssignment === true
      && (anchor === null || event.seq > anchor));
    if (current && currentValid(state, observation) && (!observation.registered.length || !registeredAfterPointer)) return selection(current, 'current-episode');
    if (observation.registered.length === 1) return selection(observation.registered[0], 'assignment');
    if (state) return anchor === null ? selection(null, 'missing-history', ['episode-history-unavailable'])
      : selection(null, 'new-root-assignment');
    const labelled = labelledEpisode(creator.labels);
    if (labelled) return observation.closed.has(labelled.episodeId)
      ? selection(null, 'closed-context', ['episode-context-closed']) : selection(labelled, 'creator-labels');
    return selection(null, classification === 'root' ? 'creator-unlabelled-unformed' : 'new-root-assignment');
  }
  return {
    /** Called after formation qualification, before the durable create issue.
     * IO is synchronous under a short exclusive metadata lock, with no retries
     * or waits. Parallel calls in one bridge share the committed current ID.
     * Retained operation replay never calls this method again. */
    forSeat(input: Creator & { mode?: 'inherit' | 'new'; key: string }): EpisodeSelection {
      try {
        if (creatorClass(input.labels) === 'missing') return selection(null, 'missing-context', ['episode-context-missing']);
        const observation = observedEpisodes(input.ledger, input.agentId);
        const inherited = existing(input, observation, read(input.agentId));
        if (!observation.history || input.mode !== 'new' && (inherited.episode || inherited.warnings.length)) return inherited;
        assertRealComponents(stableRoot, directory, 'episode metadata');
        if (lstatOrNull(directory) === null) {
          ensurePrivateDirectory(directory, process.platform);
          fsyncDirectory(join(directory, '..'), process.platform);
        }
        const path = pathOf(input.agentId), lock = `${path}.lock`;
        let lockFd: number;
        try { lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new MetadataFault('episode-lock-retained');
          throw error;
        }
        try {
          // Re-read after exclusion; never overwrite a corrupt historical file.
          const prior = read(input.agentId);
          const id = episodeId(input.key);
          const recorded = prior?.events.find(event => event.payload.episodeId === id);
          if (recorded) return selection(readEpisode(recorded.payload), inherited.basis);
          if (input.mode !== 'new' && prior && currentValid(prior, observation)) {
            return selection(prior.current, 'current-episode');
          }
          const episode = { episodeId: id, rootAgentId: input.agentId };
          const event = OpenEvent.parse({ kind: 'episode-opened', payload: { ...episode, at: (deps.now?.() ?? new Date()).toISOString() } });
          if ((prior?.events.length ?? 0) >= 2048) throw new MetadataFault('episode-state-budget');
          // Prior history was validated on read or produced by this writer.
          // Validate only the new header/event; never reparse all retained
          // events for every opening in a long-lived root.
          const header = Header.parse({ schemaVersion: 1, holderAgentId: input.agentId, current: episode,
            observedDesk: { repoKey: observation.repoKey, head: observation.head } });
          const { current: _current, ...entryHeader } = header;
          const body = { ...entryHeader, event }, previousSha256 = prior?.lastSha256 ?? null;
          const sha256 = canonicalSha256({ body, previousSha256 });
          const bytes = JSON.stringify({ body, previousSha256, sha256 }) + '\n';
          const size = (prior?.bytes ?? 0) + Buffer.byteLength(bytes);
          if (size > 1024 * 1024) throw new MetadataFault('episode-state-budget');
          // Synchronize append data and file length; mtime is not evidence. A
          // torn append is detected on restart and remains an advisory gap;
          // never truncate or discard previously recorded evidence.
          const flags = constants.O_WRONLY | constants.O_NOFOLLOW | (prior ? constants.O_APPEND : constants.O_CREAT | constants.O_EXCL);
          const fd = openSync(path, flags, 0o600);
          let info: Stats;
          try {
            info = fstatSync(fd);
            if (!info.isFile() || info.size !== (prior?.bytes ?? 0)) throw new MetadataFault('episode-state-corrupt');
            writeFileSync(fd, bytes); fdatasyncSync(fd);
            info = fstatSync(fd);
          } finally { closeSync(fd); }
          if (!prior) fsyncDirectory(directory, process.platform);
          if (cache.size >= 256) cache.delete(cache.keys().next().value!);
          cache.set(input.agentId, { stamp: stamp(info), state: { ...header, events: [...(prior?.events ?? []), event], lastSha256: sha256, bytes: size } });
          return selection(episode, inherited.basis);
        } finally {
          closeSync(lockFd);
          try { unlinkSync(lock); } catch { /* A retained lock makes future writes advisory gaps. */ }
        }
      } catch (error) { return selection(null, 'metadata-unavailable', [error instanceof MetadataFault ? error.warning : 'episode-state-unavailable']); }
    },
    /** Capture optional file context before the work-ledger transaction.
     * The returned resolver is pure and uses the verified decide snapshot;
     * no metadata IO runs while the work-ledger writer lock is held. */
    prepareAssignment(input: Pick<Creator, 'agentId' | 'labels'> & { key: string }): (ledger: Readonly<LedgerValue>) => EpisodeSelection {
      try {
        if (creatorClass(input.labels) === 'root') return () => selection({ episodeId: episodeId(input.key),
          rootAgentId: input.agentId }, 'creator-unlabelled-unformed');
        const state = read(input.agentId);
        return ledger => {
          const known = existing(input, observedEpisodes(ledger, input.agentId), state);
          if (known.episode || known.warnings.length) return known;
          return selection({ episodeId: episodeId(input.key), rootAgentId: input.agentId }, known.basis);
        };
      } catch (error) { return () => selection(null, 'metadata-unavailable', [error instanceof MetadataFault ? error.warning : 'episode-state-unavailable']); }
    },
  };
}
