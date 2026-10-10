import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { HANDBACK_VERDICTS, recomputeSha, validateRecord } from './report-records.ts';
import { snapshot } from './package.ts';
import { assertMeasurable, isInside } from './review-packet.ts';

// Builds one fenced v1 handback `slp-record` from measured inputs. The sha of
// every check is the SHA-256 of the exact bytes of its output file and the
// candidate comes from snapshot(); the request cannot carry either, so no
// placeholder or hand-typed sha can enter. The result must pass the shared
// validator against the same repository before anything is printed.
//
// Evidence form: a file inside the repository becomes `outputRef` (the verifier
// reads it from --repo); a file outside becomes inline `output` (UTF-8 only,
// capped) because outputRef is repository-relative by contract. Missing or
// unreadable output is an error — never `sha: null`, which a Lead would have
// to notice and chase.
const INLINE_LIMIT = 64 * 1024;
// The strict key allowlists below come from the published contract itself.
const nonemptyString = { type: 'string', pattern: '\\S' };
const absolutePath = { ...nonemptyString, description: 'Absolute filesystem path' };
const requestContract = {
  type: 'object', additionalProperties: false,
  required: ['repository', 'seat', 'verdict', 'checks'],
  properties: {
    repository: absolutePath,
    seat: {
      type: 'object', additionalProperties: false, required: ['role', 'disposition'],
      properties: {
        role: nonemptyString, disposition: nonemptyString,
        agentId: { type: ['string', 'null'], pattern: '\\S' },
      },
    },
    verdict: { type: ['string', 'null'], enum: [...HANDBACK_VERDICTS, null] },
    checks: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false, required: ['cmd', 'exit', 'outputFile'],
        properties: { cmd: nonemptyString, exit: { type: 'integer' }, outputFile: absolutePath },
      },
    },
  },
};
export function recordBuildSchema() { return requestContract; }
const REQUEST_KEYS = new Set(Object.keys(requestContract.properties));
const SEAT_KEYS = new Set(Object.keys(requestContract.properties.seat.properties));
const CHECK_KEYS = new Set(Object.keys(requestContract.properties.checks.items.properties));
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, where: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${where}: unknown field ${key}${key === 'sha' || key === 'output' || key === 'outputRef' ? ' — sha and evidence are derived from outputFile, never supplied' : ''}`);
  }
}

export interface RecordBuildRequest {
  repository: string;
  seat: { role: string; disposition: string; agentId?: string | null };
  verdict: string | null;
  checks: Array<{ cmd: string; exit: number; outputFile: string }>;
}

export function recordBuild(request: unknown): { record: Record<string, unknown>; fence: string; warnings: unknown[] } {
  if (!isObject(request)) throw new Error('record-build request must be a JSON object');
  unknownKeys(request, REQUEST_KEYS, 'request');
  const { repository, seat, verdict, checks } = request;
  if (!text(repository) || !isAbsolute(repository)) throw new Error('request.repository must be an absolute path');
  if (!isObject(seat)) throw new Error('request.seat must be an object with role and disposition');
  unknownKeys(seat, SEAT_KEYS, 'request.seat');
  if (!text(seat.role) || !text(seat.disposition)) throw new Error('request.seat.role and request.seat.disposition must be non-empty strings');
  if (seat.agentId !== undefined && seat.agentId !== null && !text(seat.agentId)) throw new Error('request.seat.agentId must be a non-empty string or null');
  if (verdict === undefined || (verdict !== null && !(HANDBACK_VERDICTS as readonly string[]).includes(verdict as string))) throw new Error(`request.verdict must be ${HANDBACK_VERDICTS.join(', ')} or null`);
  if (!Array.isArray(checks) || checks.length === 0) throw new Error('request.checks must list at least one check — an empty handback proves nothing');

  const root = realpathSync(repository);
  const built = checks.map((entry, index) => {
    const where = `request.checks[${index}]`;
    if (!isObject(entry)) throw new Error(`${where} must be an object`);
    unknownKeys(entry, CHECK_KEYS, where);
    if (!text(entry.cmd)) throw new Error(`${where}.cmd must be a non-empty string`);
    if (!Number.isInteger(entry.exit)) throw new Error(`${where}.exit must be an integer`);
    if (!text(entry.outputFile) || !isAbsolute(entry.outputFile)) throw new Error(`${where}.outputFile must be an absolute path`);
    let real: string;
    let bytes: Buffer;
    try {
      real = realpathSync(entry.outputFile);
      if (!statSync(real).isFile()) throw new Error('not a file');
      bytes = readFileSync(real);
    } catch { throw new Error(`${where}: output file missing or unreadable: ${entry.outputFile}`); }
    const base = { cmd: entry.cmd, exit: entry.exit as number, sha: recomputeSha(bytes) };
    if (isInside(root, real)) return { ...base, outputRef: relative(root, real).split(sep).join('/') };
    if (bytes.length > INLINE_LIMIT) throw new Error(`${where}: output file is ${bytes.length} bytes, over the ${INLINE_LIMIT}-byte inline limit — place it inside the repository to reference it as outputRef`);
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let output: string;
    try { output = decoded.decode(bytes); } catch { throw new Error(`${where}: output file is not valid UTF-8 and cannot be inlined: ${entry.outputFile}`); }
    return { ...base, output };
  });

  assertMeasurable(root);
  const measured = snapshot(root);
  const record = {
    version: 1,
    kind: 'handback',
    seat: { role: seat.role, disposition: seat.disposition, ...(seat.agentId ? { agentId: seat.agentId } : {}) },
    verdict,
    candidate: { repository: root, snapshotSha256: measured.sha256, ...(measured.incomplete ? { incomplete: measured.incomplete } : {}) },
    checks: built,
  };
  const validation = validateRecord(record, { repo: root });
  if (!validation.valid) throw new Error(`generated record failed validation: ${validation.errors.map(item => `${item.field ?? ''} ${item.code}: ${item.message}`).join('; ')}`);
  return { record, fence: '```slp-record\n' + JSON.stringify(record, null, 2) + '\n```\n', warnings: validation.warnings };
}
