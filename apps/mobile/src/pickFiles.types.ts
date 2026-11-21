/**
 * Shared by `pickFiles.ts` (native) and `pickFiles.web.ts` (web): the files a person chooses so Claude can learn their
 * writing style (docs/CONTRACT.md, "Writing style"), and the rules for which files count and how they are sent.
 *
 * Up to 100 files are chosen, but the API reads at most 10 files (and 15 MB) per request, so `batchFiles` splits them and
 * the caller sends the batches one after another. A file is only read into memory (`read`) when its batch is sent.
 */

/** Files per upload. */
export const MAX_FILES = 100;
/** The API refuses a file over 5 MB (413). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Files per request: the API refuses more than 10 (422). */
export const BATCH_FILES = 10;
/** Bytes per request: the API refuses more than 15 MB (413); stay a little under it. */
export const BATCH_BYTES = 14 * 1024 * 1024;

export type FileKind = 'text' | 'pdf' | 'docx' | 'image';

/** One chosen file. Nothing is read until `read()` is called. */
export interface PickedFile {
  /** Distinguishes two files with the same name. */
  id: string;
  name: string;
  /** Bytes of the original file. */
  size: number;
  /** null: a type Pulse cannot read. `mergePicked` leaves such a file out and says so. */
  kind: FileKind | null;
  /** What the picker reported (may be empty: browsers guess types badly, so `kind` goes by the extension first). */
  mediaType: string;
  /** Base64 of the bytes to send, with no `data:` prefix. Rejects when the file cannot be read. */
  read: () => Promise<string>;
}

export type PickFilesResult =
  | { status: 'ok'; files: PickedFile[] }
  /** The person closed the picker without choosing. */
  | { status: 'cancelled' }
  /** Native only: this build has no image-picker module (an APK from before it was added). */
  | { status: 'unavailable' }
  /** The files could not be opened; `message` is for the person. */
  | { status: 'error'; message: string };

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Maps, not objects: a file called "notes.constructor" must not find a key on Object.prototype.
const EXT_KIND = new Map<string, FileKind>([
  ['txt', 'text'],
  ['text', 'text'],
  ['md', 'text'],
  ['markdown', 'text'],
  ['pdf', 'pdf'],
  ['docx', 'docx'],
  ['png', 'image'],
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['webp', 'image'],
]);
const TYPE_KIND = new Map<string, FileKind>([
  ['text/plain', 'text'],
  ['text/markdown', 'text'],
  ['application/pdf', 'pdf'],
  [DOCX_TYPE, 'docx'],
  ['image/png', 'image'],
  ['image/jpeg', 'image'],
  ['image/webp', 'image'],
]);

/** What kind of file this is, from its extension first and its type second; null when Pulse cannot read it. Mirrors the API. */
export function fileKind(name: string, mediaType = ''): FileKind | null {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return EXT_KIND.get(ext) ?? TYPE_KIND.get(mediaType.split(';')[0].trim().toLowerCase()) ?? null;
}

export interface Rejected {
  name: string;
  reason: string;
}

/**
 * Add `incoming` to the files already chosen. A file is left out (and reported) when Pulse cannot read its type, it is
 * empty or over 5 MB, or it would be the 101st; one already chosen (same name and size) is quietly ignored.
 */
export function mergePicked(
  current: readonly PickedFile[],
  incoming: readonly PickedFile[],
): { files: PickedFile[]; rejected: Rejected[] } {
  const files = [...current];
  const rejected: Rejected[] = [];
  const have = new Set(files.map((f) => `${f.name}|${f.size}`));
  for (const f of incoming) {
    if (have.has(`${f.name}|${f.size}`)) continue;
    if (f.kind === null) rejected.push({ name: f.name, reason: "this type isn't supported" });
    else if (f.size <= 0) rejected.push({ name: f.name, reason: 'the file is empty' });
    else if (f.size > MAX_FILE_BYTES) rejected.push({ name: f.name, reason: 'over 5 MB' });
    else if (files.length >= MAX_FILES) rejected.push({ name: f.name, reason: `over the ${MAX_FILES}-file limit` });
    else {
      files.push(f);
      have.add(`${f.name}|${f.size}`);
    }
  }
  return { files, rejected };
}

/** Split files, in order, into requests of at most 10 files and 14 MB. */
export function batchFiles<T extends { size: number }>(files: readonly T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const f of files) {
    if (batch.length > 0 && (batch.length >= BATCH_FILES || bytes + f.size > BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(f);
    bytes += f.size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** "name1, name2 and 3 more": for a short note about which files were left out. */
export function nameList(names: readonly string[], show = 3): string {
  if (names.length <= show) return names.join(', ');
  return `${names.slice(0, show).join(', ')} and ${names.length - show} more`;
}

/** One line per reason: "3 files left out (over 5 MB): a.pdf, b.pdf, c.pdf". */
export function leftOutNotes(items: readonly Rejected[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const { name, reason } of items) byReason.set(reason, [...(byReason.get(reason) ?? []), name]);
  return [...byReason].map(
    ([reason, names]) => `${names.length === 1 ? '1 file' : `${names.length} files`} left out (${reason}): ${nameList(names)}`,
  );
}
