import type { EvidenceReadResult, RecordIssue } from "../report-records.ts";
interface ExtractedRecord {
  blockIndex: number;
  record: unknown;
  valid: boolean;
  selected: boolean;
}
interface ExtractionIssue extends RecordIssue {
  blockIndex?: number;
  kind?: string;
  count?: number;
  selectedBlockIndex?: number;
}
import type { RuntimeError } from './types.ts';
// CLI record extraction and real-filesystem evidence adapter. The validator
// and vocabulary are shared with the plugin; desk callers omit the IO seams.
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  RECORD_KINDS, SHA256_PATTERN, HANDBACK_VERDICTS, SETTLEMENT_VIA,
  GIT_HEAD_PATTERN, UTC_TIMESTAMP_PATTERN, REPOSITORY_RELATIVE_PATH_PATTERN,
  validateReportRecordV1,
} from "../report-records.ts";
export {
  RECORD_KINDS, SHA256_PATTERN, HANDBACK_VERDICTS, SETTLEMENT_VIA,
  GIT_HEAD_PATTERN, UTC_TIMESTAMP_PATTERN, REPOSITORY_RELATIVE_PATH_PATTERN,
  recomputeSha,
} from "../report-records.ts";

const absoluteRepositoryPathPattern = process.platform === 'win32'
  ? /^(?:[A-Za-z]:[\\/]|\\\\)/u
  : /^\//u;
const nonBlankStringSchema = { type: 'string', minLength: 1, pattern: '\\S' };
const nullableNonBlankStringSchema = { anyOf: [{ type: 'null' }, nonBlankStringSchema] };
const kindSet = new Set<string>(RECORD_KINDS);
const issue = (code: string, field: string | undefined, message: string) => ({ code, ...(field ? { field } : {}), message });

function readEvidence(repositoryRoot: string, outputRef: string): EvidenceReadResult {
  try {
    const repoPath = realpathSync(repositoryRoot);
    const outputPath = realpathSync(resolve(repoPath, outputRef));
    const relativePath = relative(repoPath, outputPath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return { status: 'outside' };
    }
    return { status: 'ok', bytes: readFileSync(outputPath) };
  } catch {
    return { status: 'unreadable' };
  }
}

export function validateRecord(record: unknown, { repo }: { repo?: string } = {}) {
  return validateReportRecordV1(record, { repo, readEvidence, realpath: realpathSync });
}

export function extractRecords(text: unknown, { repo }: { repo?: string } = {}) {
  const records: ExtractedRecord[] = [];
  const errors: ExtractionIssue[] = [];
  const warnings: ExtractionIssue[] = [];
  const lines = String(text).split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  let blockIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/^```slp-record\s*$/u.test(lines[i])) continue;
    blockIndex++;
    let end = i + 1;
    while (end < lines.length && !/^```\s*$/u.test(lines[end])) end++;
    if (end === lines.length) {
      errors.push({ ...issue('invalid-json', undefined, 'slp-record fence has no closing ``` line'), blockIndex });
      break;
    }
    const source = lines.slice(i + 1, end).join('\n');
    i = end;
    let record;
    try { record = JSON.parse(source); }
    catch (error) {
      errors.push({ ...issue('invalid-json', undefined, (error as RuntimeError).message), blockIndex });
      continue;
    }
    const validation = validateRecord(record, { repo });
    records.push({ blockIndex, record, valid: validation.valid, selected: false });
    errors.push(...validation.errors.map(item => ({ ...item, blockIndex })));
    warnings.push(...validation.warnings.map(item => ({ ...item, blockIndex })));
  }

  const byKind = new Map<string, ExtractedRecord[]>();
  for (const entry of records) {
    const kind = (entry.record as { kind?: string } | null)?.kind;
    if (!kindSet.has(kind!)) continue;
    const entries = byKind.get(kind!) ?? [];
    entries.push(entry);
    byKind.set(kind!, entries);
  }
  for (const [kind, entries] of byKind) {
    entries.at(-1)!.selected = true;
    if (entries.length > 1) warnings.push({
      code: 'multiple-records', kind, count: entries.length,
      selectedBlockIndex: entries.at(-1)!.blockIndex,
      message: 'the last record of this kind is authoritative; earlier blocks are retained for inspection'
    });
  }
  if (blockIndex === 0) warnings.push({ code: 'no-record', message: 'report contains no slp-record block' });
  return { records, errors, warnings };
}

export function requireRecordKind(parsed: ReturnType<typeof extractRecords>, requiredKind: string) {
  if (!kindSet.has(requiredKind)) throw new TypeError(`unsupported required record kind: ${requiredKind}`);
  if (parsed.records.some(entry => (entry.record as { kind?: string } | null)?.kind === requiredKind)) return parsed;
  return {
    ...parsed,
    errors: [...parsed.errors, {
      code: 'required-kind-missing',
      kind: requiredKind,
      message: `required ${requiredKind} record is missing`
    }]
  };
}

export function recordSchema() {
  const sha = { type: 'string', pattern: SHA256_PATTERN.source };
  const candidate = {
    oneOf: [
      { type: 'null' },
      {
        type: 'object', required: ['repository'],
        properties: {
          repository: { ...nonBlankStringSchema, allOf: [{ pattern: absoluteRepositoryPathPattern.source }] },
          head: { type: 'string', pattern: GIT_HEAD_PATTERN.source },
          snapshotSha256: sha,
          incomplete: { type: 'array', items: { type: 'string' } }
        },
        oneOf: [{ required: ['head'], not: { required: ['snapshotSha256'] } }, { required: ['snapshotSha256'], not: { required: ['head'] } }]
      }
    ]
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Paseo SLP report record v1',
    oneOf: [
      {
        type: 'object', required: ['version', 'kind', 'seat', 'verdict', 'candidate', 'checks'],
        properties: {
          version: { const: 1 }, kind: { const: RECORD_KINDS[0] },
          seat: { type: 'object', required: ['role', 'disposition'], properties: { agentId: nullableNonBlankStringSchema, role: nonBlankStringSchema, disposition: nonBlankStringSchema } },
          verdict: { enum: [...HANDBACK_VERDICTS, null] }, candidate,
          checks: { type: 'array', items: { type: 'object', required: ['cmd', 'exit', 'sha'], properties: { cmd: nonBlankStringSchema, exit: { type: 'integer' }, sha: { oneOf: [sha, { type: 'null' }] }, output: { type: 'string' }, outputRef: { type: 'string', pattern: REPOSITORY_RELATIVE_PATH_PATTERN.source }, candidate } } },
          timeline: { type: 'object', properties: { sessionId: nullableNonBlankStringSchema } }
        }
      },
      {
        type: 'object', required: ['version', 'kind', 'task', 'seat', 'timeline', 'recordedBy', 'at'],
        properties: {
          version: { const: 1 }, kind: { const: RECORD_KINDS[1] }, task: nullableNonBlankStringSchema,
          seat: { type: 'object', required: ['provider', 'title'], properties: { agentId: nullableNonBlankStringSchema, provider: nonBlankStringSchema, title: nonBlankStringSchema } },
          timeline: {
            type: 'object', required: ['nativeHandle', 'sessionId', 'via', 'export', 'gap'], properties: {
              nativeHandle: nullableNonBlankStringSchema, sessionId: nullableNonBlankStringSchema,
              via: { enum: [...SETTLEMENT_VIA] },
              export: { oneOf: [{ type: 'null' }, { type: 'object', required: ['path', 'sha256', 'bytes'], properties: { path: { type: 'string', pattern: REPOSITORY_RELATIVE_PATH_PATTERN.source }, sha256: sha, bytes: { type: 'integer', minimum: 0 } } }] },
              gap: nullableNonBlankStringSchema
            }
          },
          recordedBy: nonBlankStringSchema, at: { type: 'string', format: 'date-time', pattern: UTC_TIMESTAMP_PATTERN.source }
        }
      }
    ]
  };
}
