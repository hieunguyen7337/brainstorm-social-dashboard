/**
 * Native file picking for "Your writing style" (iOS, Android). The web version is `pickFiles.web.ts`.
 *
 * The app has no document picker (that would need a new APK), so on a phone the person chooses screenshots of their past
 * posts from the photo library, up to 100 at a time, or pastes text. To upload PDF, Word or text files they open Pulse in a
 * browser. `expo-image-picker` is loaded with `require` at call time, inside try/catch, like `pickImage.ts`: an OTA update
 * (JS only) can reach an APK built before the module existed, and importing a missing native module throws. In that case
 * this resolves `{ status: 'unavailable' }`.
 */
import { MAX_FILES, type PickedFile, type PickFilesResult } from './pickFiles.types';
import { base64Bytes } from './pickImage.types';

export type { PickedFile, PickFilesResult } from './pickFiles.types';

/** The native build can only choose screenshots. */
export const PICK_DOCUMENTS = false;

type ImagePickerModule = typeof import('expo-image-picker');

/** The module's JS may load while its native half is missing; both read as "not in this build". */
const MISSING_NATIVE = /native module|ExponentImagePicker|not (?:available|found|installed)|is not a function|undefined is not/i;

function loadImagePicker(): ImagePickerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-image-picker') as ImagePickerModule;
  } catch {
    return null;
  }
}

/** Open the photo library and return the chosen screenshots. Never throws. */
export async function pickFiles(): Promise<PickFilesResult> {
  const ImagePicker = loadImagePicker();
  if (!ImagePicker || typeof ImagePicker.launchImageLibraryAsync !== 'function') return { status: 'unavailable' };
  try {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: MAX_FILES,
      allowsEditing: false,
      // base64 is always JPEG; 0.7 keeps a phone screenshot of text far under the API's 5 MB-a-file limit.
      quality: 0.7,
      base64: true,
      exif: false,
    });
    if (res.canceled) return { status: 'cancelled' };
    const files: PickedFile[] = (res.assets ?? []).map((asset, i) => {
      const base64 = asset.base64 ?? '';
      return {
        id: `n${i}-${asset.uri}`,
        name: asset.fileName ? asset.fileName.replace(/\.[^.]+$/, '') + '.jpg' : `screenshot-${i + 1}.jpg`,
        size: base64 ? base64Bytes(base64) : 0,
        kind: 'image',
        mediaType: 'image/jpeg',
        read: () => (base64 ? Promise.resolve(base64) : Promise.reject(new Error("Couldn't read that image."))),
      };
    });
    return files.length > 0 ? { status: 'ok', files } : { status: 'cancelled' };
  } catch (e) {
    if (MISSING_NATIVE.test(e instanceof Error ? e.message : String(e))) return { status: 'unavailable' };
    return { status: 'error', message: "Couldn't open your photos. Try again." };
  }
}
