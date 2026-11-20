/** Shared by `pickImage.ts` (native) and `pickImage.web.ts` (web). */
import type { ScreenshotMediaType } from './types';

/** One chosen screenshot, ready for `POST /api/connections/{platform}/screenshot`. */
export interface PickedImage {
  /** Base64 of the image bytes, with no `data:` prefix. */
  base64: string;
  mediaType: ScreenshotMediaType;
  /** Shows the image in a thumbnail (a data URL on web, a file URI on native). */
  uri: string;
  width: number;
  height: number;
}

export type PickResult =
  | { status: 'ok'; image: PickedImage }
  /** The person closed the picker without choosing. */
  | { status: 'cancelled' }
  /** Native only: this build has no image-picker module (an APK from before it was added). Open the web upload page. */
  | { status: 'unavailable' }
  /** The image could not be read or is too large; `message` is for the person. */
  | { status: 'error'; message: string };

/** The API refuses images over 5 MB (413). Stay under it with room for the base64 overhead. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Longest side after downscaling (web). */
export const MAX_IMAGE_SIDE = 2000;

/** Decoded size of a base64 string. */
export const base64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
