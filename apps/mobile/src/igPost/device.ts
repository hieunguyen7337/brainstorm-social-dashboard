/**
 * "Post to Instagram" on Android: the device side (photo picker, share sheet, opening the Instagram app).
 * The web build uses `device.web.ts` (nothing to do there: the website is out of scope).
 *
 * OTA safety (see autoRead/native.ts): a JS update can reach an APK built before a native module existed, and a lazy
 * `require` of a JS package whose native half is missing can be a fatal error in Metro. So each Expo module is probed in
 * `globalThis.expo.modules` (a missing name reads as undefined, it never throws) before its package is required.
 *   - expo-image-picker (native 'ExponentImagePicker'): in APKs built since "Upload a screenshot".
 *   - expo-sharing (native 'ExpoSharing'): added with this feature, so only in APKs built after it. Without it the
 *     button opens the Instagram app instead and the person picks the photo there.
 */
import { Linking } from 'react-native';

import { base64Size, IG_HOME_URL, igImageProblem } from './logic';

type ImagePickerModule = typeof import('expo-image-picker');
type SharingModule = typeof import('expo-sharing');

function expoModulePresent(name: string): boolean {
  try {
    const mods = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules;
    return !!mods && mods[name] != null;
  } catch {
    return false;
  }
}

function loadPicker(): ImagePickerModule | null {
  if (!expoModulePresent('ExponentImagePicker')) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('expo-image-picker') as ImagePickerModule;
    return typeof m.launchImageLibraryAsync === 'function' ? m : null;
  } catch {
    return null;
  }
}

function loadSharing(): SharingModule | null {
  if (!expoModulePresent('ExpoSharing')) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('expo-sharing') as SharingModule;
    return typeof m.shareAsync === 'function' ? m : null;
  } catch {
    return null;
  }
}

export interface PostPhoto {
  /** file:// URI in the app's cache (what the share sheet hands to Instagram). */
  uri: string;
  /** JPEG bytes as base64, no data: prefix (what the WebView uploads). */
  base64: string;
  width: number;
  height: number;
}

export type PhotoResult =
  | { status: 'ok'; photo: PostPhoto }
  | { status: 'cancelled' }
  /** This APK has no photo picker: open Instagram and pick the photo there. */
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** The phone's photo library, cropped square (Instagram's feed shape). Never throws. */
export async function pickPostPhoto(): Promise<PhotoResult> {
  const picker = loadPicker();
  if (!picker) return { status: 'unavailable' };
  try {
    const res = await picker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
      base64: true,
      exif: false,
    });
    if (res.canceled) return { status: 'cancelled' };
    const asset = res.assets?.[0];
    if (!asset?.uri || !asset.base64) return { status: 'error', message: "Couldn't read that photo. Try another one." };
    const base64 = asset.base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    const problem = igImageProblem({ width: asset.width, height: asset.height, bytes: base64Size(base64) });
    if (problem) return { status: 'error', message: problem };
    return { status: 'ok', photo: { uri: asset.uri, base64, width: asset.width, height: asset.height } };
  } catch {
    return { status: 'error', message: "Couldn't open your photos. Try again." };
  }
}

/** True when this APK can hand a photo to Instagram through Android's share sheet. */
export function canSharePhoto(): boolean {
  return loadSharing() !== null;
}

/**
 * Android's share sheet with the photo ("Instagram Feed", "Stories", "Chats" are Instagram's targets). Resolves when the
 * sheet closes; Android does not say which app was chosen. False when this APK cannot share files.
 */
export async function sharePhoto(uri: string): Promise<boolean> {
  const sharing = loadSharing();
  if (!sharing) return false;
  try {
    if (!(await sharing.isAvailableAsync())) return false;
    await sharing.shareAsync(uri, { mimeType: 'image/jpeg', dialogTitle: 'Post to Instagram' });
    return true;
  } catch {
    return false;
  }
}

/** The Instagram app (Android opens instagram.com links in it when it is installed; the browser otherwise). */
export async function openInstagramApp(): Promise<boolean> {
  try {
    await Linking.openURL(IG_HOME_URL);
    return true;
  } catch {
    return false;
  }
}
