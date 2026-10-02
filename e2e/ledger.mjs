// Append-only evidence ledger: collection paths, the record index and the
// per-kind discharge check used by the seal gate and the status preview.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { files, hash, json, readJson } from '../plugin/server/runtime/cli/package.ts';
import { within, acceptEvidence, dischargesEvidence } from './evidence.mjs';
import { loadAttempt, nonempty, now, put, requireValue } from './runs.mjs';

export function collect(attempt, kind, path) {
  const loaded = loadAttempt(attempt);
  requireValue(loaded.frozen.evidenceKinds.includes(kind), 'Unknown evidence kind');
  requireValue(!existsSync(join(loaded.attempt, 'report.json')), 'Attempt sealed');
  // Raw capture: an invalid payload stays visible in the ledger. seal() is the gate.
  return storeEvidence(loaded, kind, path, readFileSync(path), 'raw');
}
export function collectCoordinator(attempt, path, sessionId) {
  const loaded = loadAttempt(attempt);
  requireValue(!existsSync(join(loaded.attempt, 'report.json')), 'Attempt sealed');
  requireValue(nonempty(sessionId), 'Coordinator native sessionId required');
  const source = realpathSync(path);
  requireValue(!within(loaded.directory, source), 'Coordinator transcript source must be outside the E2E run directory');
  requireValue(basename(source).includes(sessionId), 'Coordinator transcript filename must bind the native sessionId');
  const transcript = readFileSync(source, 'utf8');
  const bytes = Buffer.from(json({ operatorId: loaded.data.config.operatorId, sessionId, source,
    transcript, transcriptSha256: hash(Buffer.from(transcript)) }));
  acceptEvidence('coordinator', bytes, evidenceContext(loaded));
  return storeEvidence(loaded, 'coordinator', source, bytes, 'verified');
}
export function collectResources(attempt, path) {
  const loaded = loadAttempt(attempt);
  requireValue(!existsSync(join(loaded.attempt, 'report.json')), 'Attempt sealed');
  const bytes = readFileSync(path);
  acceptEvidence('resources', bytes, evidenceContext(loaded));
  return storeEvidence(loaded, 'resources', path, bytes);
}
function storeEvidence(loaded, kind, path, bytes, capture = 'raw') {
  const records = readdirSync(join(loaded.attempt, 'evidence'));
  const name = `${String(records.length + 1).padStart(4, '0')}-${kind}.json`;
  const record = { kind, capturedAt: now(), source: resolve(path), sha256: hash(bytes), encoding: 'base64', bytes: bytes.toString('base64'), capture };
  put(join(loaded.attempt, 'evidence', name), record);
  return { path: `evidence/${name}`, kind, sha256: hash(json(record)), payloadSha256: record.sha256 };
}
export function evidenceIndex(attempt) {
  return files(attempt, 'evidence').map(path => {
    const bytes = readFileSync(join(attempt, path));
    const record = JSON.parse(bytes);
    requireValue(hash(Buffer.from(record.bytes, 'base64')) === record.sha256, `Evidence payload changed: ${path}`);
    return { path, kind: record.kind, sha256: hash(bytes) };
  });
}
const evidenceContext = loaded => ({ operatorId: loaded.data.config.operatorId, runDirectory: loaded.directory });
export function missingEvidence(loaded, evidence) {
  const context = evidenceContext(loaded);
  return loaded.frozen.evidenceKinds.filter(kind => !evidence.some(item => {
    if (item.kind !== kind) return false;
    const record = readJson(join(loaded.attempt, item.path));
    return dischargesEvidence(kind, record, context);
  }));
}

// Reporting consumes the ledger's inspection result, not its storage layout
// or the context/provenance rules needed to discharge an evidence kind.
export function evidenceStatus(loaded) {
  const context = evidenceContext(loaded);
  const evidence = evidenceIndex(loaded.attempt).map(item => ({
    ...item, discharges: dischargesEvidence(item.kind, readJson(join(loaded.attempt, item.path)), context),
  }));
  return { evidence, missing: missingEvidence(loaded, evidence) };
}
