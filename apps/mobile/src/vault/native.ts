/**
 * `expo-secure-store`, loaded at call time and never at the top level (same OTA rule as `autoRead/native.ts`).
 *
 * The installed APKs were built before this native module existed. An OTA update that imported `expo-secure-store` at the
 * top level would crash them, so the native side is probed first (`requireOptionalNativeModule` returns null instead of
 * throwing) and the JS package is required only when it is present. Without it the vault reports itself unavailable and
 * the app works exactly as before.
 *
 * Storage: Android EncryptedSharedPreferences (AES-256-GCM, key held by the Android Keystore); iOS Keychain.
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

type SecureStoreModule = typeof import('expo-secure-store');

/** The subset of `expo-secure-store` the vault uses (a fake in tests). */
export interface SecureStoreLike {
  getItemAsync: SecureStoreModule['getItemAsync'];
  setItemAsync: SecureStoreModule['setItemAsync'];
  deleteItemAsync: SecureStoreModule['deleteItemAsync'];
  canUseBiometricAuthentication: SecureStoreModule['canUseBiometricAuthentication'];
  /** Android Keystore / iOS Keychain accessibility constant: readable only while the phone is unlocked. */
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: SecureStoreModule['WHEN_UNLOCKED_THIS_DEVICE_ONLY'];
}

let loaded: SecureStoreLike | null | undefined;

/** The secure store, or null on web and in a native binary built without the module. */
export function loadSecureStore(): SecureStoreLike | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (Platform.OS === 'web') return loaded;
  try {
    if (requireOptionalNativeModule('ExpoSecureStore') == null) return loaded;
    const mod = require('expo-secure-store') as SecureStoreModule;
    if (mod && typeof mod.getItemAsync === 'function' && typeof mod.setItemAsync === 'function') loaded = mod;
  } catch {
    loaded = null;
  }
  return loaded;
}
