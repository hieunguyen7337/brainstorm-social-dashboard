/**
 * Web file picking for "Your writing style" (desktop browsers, iPhone Safari, Android Chrome). The native version is
 * `pickFiles.ts`.
 *
 * One hidden `<input type="file" multiple>` is clicked inside the tap itself (iOS Safari only opens the picker for a click
 * made synchronously in a user gesture, so call `pickFiles()` first thing in the press handler). Choosing a file reads
 * nothing: each `PickedFile.read()` decodes it only when its batch is sent, so a hundred files never sit in memory at
 * once. Screenshots go through the same resize-to-JPEG step as "Upload a screenshot".
 */
import { fileKind, type PickedFile, type PickFilesResult } from './pickFiles.types';
import { prepareImageFile } from './pickImage.web';

export type { PickedFile, PickFilesResult } from './pickFiles.types';

/** The web build can choose documents (PDF, Word, text) as well as screenshots. */
export const PICK_DOCUMENTS = true;

const INPUT_ID = 'pulse-style-input';
const ACCEPT = '.txt,.md,.markdown,.pdf,.docx,image/png,image/jpeg,image/webp';

/** Resolves the pick in flight, if any. */
let pending: ((result: PickFilesResult) => void) | null = null;
let nextId = 0;

function settle(result: PickFilesResult): void {
  const done = pending;
  pending = null;
  done?.(result);
}

/** Base64 of the file's bytes with no `data:` prefix. */
function readBase64(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      if (comma < 0) reject(new Error('empty file'));
      else resolve(url.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function readImage(file: File): Promise<string> {
  const res = await prepareImageFile(file);
  if (res.status !== 'ok') throw new Error(res.status === 'error' ? res.message : "Couldn't read that image.");
  return res.image.base64;
}

function toPicked(file: File): PickedFile {
  const kind = fileKind(file.name, file.type);
  return {
    id: `f${++nextId}`,
    name: file.name,
    size: file.size,
    kind,
    mediaType: file.type,
    read: kind === 'image' ? () => readImage(file) : () => readBase64(file),
  };
}

/** The one hidden file input, created on first use. */
function fileInput(): HTMLInputElement {
  const existing = document.getElementById(INPUT_ID);
  if (existing instanceof HTMLInputElement) return existing;
  const input = document.createElement('input');
  input.id = INPUT_ID;
  input.type = 'file';
  input.multiple = true;
  input.accept = ACCEPT;
  input.hidden = true;
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.setAttribute('data-testid', 'style-files-input');
  input.addEventListener('change', () => {
    const chosen = Array.from(input.files ?? []); // copy first: the FileList is live and `value = ''` empties it
    input.value = ''; // so choosing the same files again still fires `change`
    if (!pending) return;
    settle(chosen.length > 0 ? { status: 'ok', files: chosen.map(toPicked) } : { status: 'cancelled' });
  });
  // Fired by current browsers when the picker is closed without a choice.
  input.addEventListener('cancel', () => settle({ status: 'cancelled' }));
  document.body.appendChild(input);
  return input;
}

/**
 * Open the file picker and resolve with the chosen files (nothing read yet). Never throws. Call it synchronously from a tap
 * handler. A browser without the `cancel` event never resolves a closed picker; nothing waits on it, so that is harmless,
 * and the next call resolves it as cancelled.
 */
export function pickFiles(): Promise<PickFilesResult> {
  if (typeof document === 'undefined') return Promise.resolve({ status: 'unavailable' });
  return new Promise<PickFilesResult>((resolve) => {
    settle({ status: 'cancelled' });
    pending = resolve;
    try {
      fileInput().click();
    } catch {
      settle({ status: 'error', message: "Couldn't open the file picker. Try again." });
    }
  });
}
