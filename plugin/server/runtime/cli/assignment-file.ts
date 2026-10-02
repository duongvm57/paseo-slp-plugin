import type { RuntimeError } from './types.ts';
import { isAbsolute, relative, sep } from 'node:path';
import { statSync, accessSync, constants } from 'node:fs';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { credentialShaped } from './jev.ts';
import { ASSIGNMENT_FILE_PREFIX, ASSIGNMENT_SNAPSHOT_PREFIX, ASSIGNMENT_SNAPSHOT_OPEN, ASSIGNMENT_SNAPSHOT_CLOSE } from '../../../shared/runtime/session-delivery.ts';

// How request.assignmentFile reaches the seat's prompt. Pointer mode (default)
// names the file and never opens it; snapshot mode reads a guarded,
// repository-contained copy and inlines it between fixed markers. Both prompt
// forms are rendered here, next to the reader that refuses nested copies of them.

// Pointer mode preserves the existing read-first reference and never opens
// the file here; snapshot mode uses the bounded reader below.
function assignmentFile(path: unknown) {
  if (path == null) return null;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Absolute assignmentFile required');
  let stat;
  try { stat = statSync(path); }
  catch (error) {
    if ((error as RuntimeError).code === 'ENOENT') throw new Error(`Assignment file does not exist: ${path}`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Assignment file must be a regular file: ${path}`);
  try { accessSync(path, constants.R_OK); }
  catch { throw new Error(`Assignment file is not readable: ${path}`); }
  return path;
}

const ASSIGNMENT_SNAPSHOT_CAP = 16_384;
const ASSIGNMENT_POINTER_LINE = /^[ \t]*Assignment file:[ \t]*\S/m;
const ASSIGNMENT_SNAPSHOT_MARKER = /^[ \t]*<<<(?:SLP assignment snapshot|end SLP assignment snapshot)>>>[ \t]*$/m;
const ASSIGNMENT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

function snapshotError(code: string, message: string) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function snapshotErrorCode(error: unknown) {
  return typeof (error as RuntimeError)?.code === 'string' && (error as RuntimeError & { code: string }).code.startsWith('assignment-snapshot-');
}

export function readAssignmentSnapshot(repository: string, path: string, io = fs) {
  if (typeof repository !== 'string' || !isAbsolute(repository) || typeof path !== 'string' || !isAbsolute(path)) {
    throw snapshotError('assignment-snapshot-unresolvable', 'repository and assignmentFile must be absolute paths');
  }

  let root;
  try {
    root = io.realpathSync(repository);
    if (!io.statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    throw snapshotError('assignment-snapshot-unresolvable', 'repository must resolve to a directory');
  }

  let real;
  try { real = io.realpathSync(path); }
  catch { throw snapshotError('assignment-snapshot-unresolvable', 'assignmentFile could not be resolved'); }
  const repoRelative = relative(root, real);
  if (repoRelative === '..' || repoRelative.startsWith(`..${sep}`) || isAbsolute(repoRelative)) {
    throw snapshotError('assignment-snapshot-outside-root', 'assignmentFile resolves outside the repository');
  }

  const pathCredential = credentialShaped(repoRelative.split(sep).join('/'));
  if (pathCredential) throw snapshotError('assignment-snapshot-credential', `assignmentFile path contains credential-shaped content (${pathCredential})`);

  let fd;
  try { fd = io.openSync(real, io.constants.O_RDONLY | io.constants.O_NOFOLLOW | (io.constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as RuntimeError)?.code === 'ELOOP') throw snapshotError('assignment-snapshot-not-regular', 'assignmentFile resolved to a symlink');
    throw snapshotError('assignment-snapshot-unresolvable', 'assignmentFile could not be opened');
  }

  let result;
  let failure;
  try {
    const opened = io.fstatSync(fd);
    if (!opened.isFile()) throw snapshotError('assignment-snapshot-not-regular', 'assignmentFile must be a regular file');
    if (opened.size > ASSIGNMENT_SNAPSHOT_CAP) throw snapshotError('assignment-snapshot-oversize', 'assignmentFile exceeds 16384 bytes');

    const buffer = Buffer.alloc(ASSIGNMENT_SNAPSHOT_CAP + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = io.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > ASSIGNMENT_SNAPSHOT_CAP) throw snapshotError('assignment-snapshot-oversize', 'assignmentFile exceeds 16384 bytes');

    const afterRead = io.fstatSync(fd);
    let targetStat;
    let currentReal;
    try {
      targetStat = io.statSync(real);
      currentReal = io.realpathSync(path);
    } catch {
      throw snapshotError('assignment-snapshot-changed', 'assignmentFile changed while it was read');
    }
    if (!targetStat.isFile() || afterRead.dev !== targetStat.dev || afterRead.ino !== targetStat.ino || currentReal !== real) {
      throw snapshotError('assignment-snapshot-changed', 'assignmentFile changed while it was read');
    }

    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
    catch { throw snapshotError('assignment-snapshot-not-text', 'assignmentFile is not valid UTF-8'); }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    text = text.replace(/\r\n?/g, '\n');
    if (ASSIGNMENT_CONTROL.test(text)) throw snapshotError('assignment-snapshot-not-text', 'assignmentFile contains a disallowed control character');
    if (ASSIGNMENT_POINTER_LINE.test(text) || ASSIGNMENT_SNAPSHOT_MARKER.test(text)) {
      throw snapshotError('assignment-snapshot-nested-marker', 'assignmentFile contains a nested assignment marker');
    }
    const credential = credentialShaped(text);
    if (credential) throw snapshotError('assignment-snapshot-credential', `assignmentFile contains credential-shaped content (${credential})`);

    const bytes = Buffer.byteLength(text, 'utf8');
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    result = { path: repoRelative.split(sep).join('/'), text, bytes, sha256 };
  } catch (error) {
    failure = snapshotErrorCode(error) ? error : snapshotError('assignment-snapshot-unresolvable', 'assignmentFile could not be read');
  }
  try { io.closeSync(fd); }
  catch {
    if (!failure) failure = snapshotError('assignment-snapshot-unresolvable', 'assignmentFile could not be closed');
  }
  if (failure) throw failure;
  return result;
}

export function assignmentFileSelection(request: { repository: string; assignmentFile?: string; assignmentFileMode?: string }) {
  const hasMode = Object.hasOwn(request, 'assignmentFileMode');
  const mode = hasMode ? request.assignmentFileMode : 'pointer';
  if (mode !== 'pointer' && mode !== 'snapshot') {
    throw snapshotError('assignment-snapshot-invalid-mode', 'assignmentFileMode must be "pointer" or "snapshot"');
  }
  if (hasMode && request.assignmentFile == null) {
    throw snapshotError('assignment-snapshot-invalid-mode', 'assignmentFileMode requires assignmentFile');
  }
  if (mode === 'pointer') return { file: assignmentFile(request.assignmentFile) };
  return { file: request.assignmentFile, snapshot: readAssignmentSnapshot(request.repository, request.assignmentFile!) };
}

// The prompt text a selection contributes after the assignment: the inline
// snapshot between its markers, the read-first pointer line, or nothing.
// readAssignmentSnapshot refuses files that already contain either form.
export function assignmentCarrier({ file, snapshot }: { file?: string | null; snapshot?: { path: string; text: string; bytes: number; sha256: string } } = {}) {
  if (snapshot) {
    const separator = snapshot.text.endsWith('\n') ? '' : '\n';
    return `\n${ASSIGNMENT_SNAPSHOT_PREFIX} ${snapshot.path} — sha256 ${snapshot.sha256}, ${snapshot.bytes} bytes; the inline text below is authoritative, do not re-read the file.\n${ASSIGNMENT_SNAPSHOT_OPEN}\n${snapshot.text}${separator}${ASSIGNMENT_SNAPSHOT_CLOSE}`;
  }
  return file ? `\n${ASSIGNMENT_FILE_PREFIX} ${file} — read it first; it is authoritative for scope details.` : '';
}
