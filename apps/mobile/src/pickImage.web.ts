/**
 * Web image picking for "Upload a screenshot" (desktop browsers, iPhone Safari, Android Chrome). The native version is
 * `pickImage.ts`.
 *
 * One hidden `<input type="file" accept="image/*">` is clicked inside the tap itself (iOS Safari only opens the picker
 * for a click made synchronously in a user gesture, so call `pickScreenshot()` first thing in the press handler). The
 * chosen file is read with the browser's decoder, drawn onto a canvas with its longest side at most 2000 px and
 * re-encoded as JPEG 0.85; if the payload is still over 4 MB it shrinks further. The result is base64 for the API.
 */
import { base64Bytes, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, type PickResult } from './pickImage.types';

export type { PickedImage, PickResult } from './pickImage.types';

const INPUT_ID = 'pulse-screenshot-input';
/** Files this big are not screenshots; refuse before spending memory on decoding them. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
/** [scale multiplier, JPEG quality]: the first attempt is the normal one, the rest only run for very large images. */
const ATTEMPTS: readonly (readonly [number, number])[] = [
  [1, 0.85],
  [1, 0.7],
  [0.75, 0.7],
  [0.5, 0.6],
];

const failure = (message: string): PickResult => ({ status: 'error', message });
const UNREADABLE = "Couldn't read that image. Try a PNG or JPEG screenshot.";

/** Resolves the pick in flight, if any. */
let pending: ((result: PickResult) => void) | null = null;

function settle(result: PickResult): void {
  const done = pending;
  pending = null;
  done?.(result);
}

interface Decoded {
  draw: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file); // applies the photo's EXIF rotation
      return { draw: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // e.g. a format this browser decodes only through <img>: fall through
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    return { draw: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** Draw at `scale` on a white canvas (JPEG has no alpha) and return the JPEG as a data URL. */
function toJpeg(src: Decoded, scale: number, quality: number): { dataUrl: string; width: number; height: number } {
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(src.draw, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), width, height };
}

async function prepare(file: File): Promise<PickResult> {
  if (file.type && !file.type.startsWith('image/')) {
    return failure('Choose an image: a screenshot of your profile or insights page.');
  }
  if (file.size > MAX_SOURCE_BYTES) return failure('That image is too large. Crop the screenshot and try again.');
  let src: Decoded;
  try {
    src = await decode(file);
  } catch {
    return failure(UNREADABLE);
  }
  try {
    const longest = Math.max(src.width, src.height);
    if (!longest) return failure(UNREADABLE);
    const base = Math.min(1, MAX_IMAGE_SIDE / longest);
    for (const [shrink, quality] of ATTEMPTS) {
      const { dataUrl, width, height } = toJpeg(src, base * shrink, quality);
      const comma = dataUrl.indexOf(',');
      if (comma < 0) return failure(UNREADABLE);
      const base64 = dataUrl.slice(comma + 1);
      if (base64Bytes(base64) <= MAX_IMAGE_BYTES) {
        return { status: 'ok', image: { base64, mediaType: 'image/jpeg', uri: dataUrl, width, height } };
      }
    }
    return failure('That image is too large. Crop the screenshot and try again.');
  } catch {
    return failure(UNREADABLE);
  } finally {
    src.release();
  }
}

/** The one hidden file input, created on first use. */
function fileInput(): HTMLInputElement {
  const existing = document.getElementById(INPUT_ID);
  if (existing instanceof HTMLInputElement) return existing;
  const input = document.createElement('input');
  input.id = INPUT_ID;
  input.type = 'file';
  input.accept = 'image/*';
  input.hidden = true;
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.setAttribute('data-testid', 'screenshot-input');
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = ''; // so choosing the same screenshot again still fires `change`
    if (!pending) return;
    if (!file) {
      settle({ status: 'cancelled' });
      return;
    }
    const done = pending;
    pending = null;
    void prepare(file).then(done, () => done(failure(UNREADABLE)));
  });
  // Fired by current browsers when the picker is closed without a choice.
  input.addEventListener('cancel', () => settle({ status: 'cancelled' }));
  document.body.appendChild(input);
  return input;
}

/**
 * Open the file picker and resolve with the chosen screenshot as JPEG base64. Never throws. Call it synchronously from a
 * tap handler. A browser without the `cancel` event never resolves a closed picker; nothing waits on it, so that is
 * harmless, and the next call resolves it as cancelled.
 */
export function pickScreenshot(): Promise<PickResult> {
  if (typeof document === 'undefined') return Promise.resolve({ status: 'unavailable' });
  return new Promise<PickResult>((resolve) => {
    settle({ status: 'cancelled' });
    pending = resolve;
    try {
      fileInput().click();
    } catch {
      settle(failure("Couldn't open the file picker. Try again."));
    }
  });
}
