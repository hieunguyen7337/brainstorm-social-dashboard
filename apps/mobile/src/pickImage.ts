/**
 * Native image picking for "Upload a screenshot" (iOS, Android). The web version is `pickImage.web.ts`.
 *
 * `expo-image-picker` is loaded with `require` at call time, inside try/catch: an OTA update (JS only) can reach an APK
 * that was built before the module existed, and importing a missing native module throws. In that case this resolves
 * `{ status: 'unavailable' }` and the caller opens the web upload page in the browser instead.
 */
import {
  base64Bytes,
  MAX_IMAGE_BYTES,
  MAX_PHOTOS,
  type PickedImage,
  type PickPhotosResult,
  type PickResult,
} from './pickImage.types';

export type { PickedImage, PickPhotosResult, PickResult } from './pickImage.types';

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

/** Open the photo library and return up to `max` chosen photos as JPEG base64. Never throws. */
export async function pickPhotos(max: number = MAX_PHOTOS): Promise<PickPhotosResult> {
  const ImagePicker = loadImagePicker();
  if (!ImagePicker || typeof ImagePicker.launchImageLibraryAsync !== 'function') return { status: 'unavailable' };
  try {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: max,
      allowsEditing: false,
      quality: 0.7,
      base64: true,
      exif: false,
    });
    if (res.canceled) return { status: 'cancelled' };
    const assets = res.assets ?? [];
    const images: PickedImage[] = [];
    for (const asset of assets) {
      if (!asset.base64 || base64Bytes(asset.base64) > MAX_IMAGE_BYTES) continue;
      images.push({ base64: asset.base64, mediaType: 'image/jpeg', uri: asset.uri, width: asset.width, height: asset.height });
    }
    if (images.length === 0) return { status: 'error', message: "Couldn't read those photos. Try others." };
    return { status: 'ok', images: images.slice(0, max), skipped: assets.length - Math.min(images.length, max) };
  } catch (e) {
    if (MISSING_NATIVE.test(e instanceof Error ? e.message : String(e))) return { status: 'unavailable' };
    return { status: 'error', message: "Couldn't open your photos. Try again." };
  }
}

/** Open the photo library and return the chosen screenshot as JPEG base64. Never throws. */
export async function pickScreenshot(): Promise<PickResult> {
  const ImagePicker = loadImagePicker();
  if (!ImagePicker || typeof ImagePicker.launchImageLibraryAsync !== 'function') return { status: 'unavailable' };
  try {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      allowsEditing: false,
      // base64 is always JPEG; 0.8 keeps a phone screenshot well under the API's 5 MB limit.
      quality: 0.8,
      base64: true,
      exif: false,
    });
    if (res.canceled) return { status: 'cancelled' };
    const asset = res.assets?.[0];
    if (!asset?.base64) return { status: 'error', message: "Couldn't read that image. Try another screenshot." };
    if (base64Bytes(asset.base64) > MAX_IMAGE_BYTES) {
      return { status: 'error', message: 'That image is too large. Crop the screenshot and try again.' };
    }
    return {
      status: 'ok',
      image: {
        base64: asset.base64,
        mediaType: 'image/jpeg',
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
      },
    };
  } catch (e) {
    if (MISSING_NATIVE.test(e instanceof Error ? e.message : String(e))) return { status: 'unavailable' };
    return { status: 'error', message: "Couldn't open your photos. Try again." };
  }
}
