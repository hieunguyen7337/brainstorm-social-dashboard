/**
 * Secure vault: saved platform logins that only the phone can use (docs/VAULT.md). Native build; `index.web.ts` is the
 * web stub with the same API (no vault on web).
 *
 * The rule this module keeps: NO exported function returns a saved username or password. Values go in through
 * `saveLogin` and come out only inside the fill script `fillScriptFor` builds for the platform's own login page.
 *
 *   - Secrets: `expo-secure-store` (Android Keystore / iOS Keychain), one entry per platform, readable only while the
 *     phone is unlocked and never synced off the device. Each login has its own biometric choice (`bio`): when it is on
 *     and the phone has biometrics, the entry needs the biometric prompt every time it is read. `setLoginBio` flips it
 *     without handing the values to anyone.
 *   - Index (not secret): AsyncStorage `pulse.vault.meta` = which platforms have a login and when it was saved, so the
 *     UI can say "Login saved" without unlocking anything. No username in it.
 *
 * Nothing here talks to the Pulse API, logs, or touches the clipboard. The server never stores or sees a saved login.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { platformMeta } from '@/src/theme';
import { PLATFORMS, type Platform } from '@/src/types';
import { buildFillScript } from './fill';
import { loadSecureStore, type SecureStoreLike } from './native';

export { canFill, takeVaultFill, type FillMessage, type FillStatus } from './fill';

const META_KEY = 'pulse.vault.meta';
const secretKey = (platform: Platform) => `pulse.vault.v1.${platform}`;

/** Longest username / password accepted (the secure store's per-entry budget is about 2 KB). */
export const MAX_FIELD = 512;

export interface VaultEntryInfo {
  /** ISO-8601 time the login was saved. */
  savedAt: string;
  /** Reading it needs the phone's biometric prompt. */
  bio: boolean;
}

export type VaultIndex = Partial<Record<Platform, VaultEntryInfo>>;

// ---- index (not secret) -------------------------------------------------------------------------------------------

const listeners = new Set<(index: VaultIndex) => void>();

function cleanIndex(raw: unknown): VaultIndex {
  const out: VaultIndex = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const p of PLATFORMS) {
    const e = (raw as Record<string, unknown>)[p];
    if (e && typeof e === 'object' && typeof (e as VaultEntryInfo).savedAt === 'string') {
      out[p] = { savedAt: (e as VaultEntryInfo).savedAt, bio: (e as VaultEntryInfo).bio === true };
    }
  }
  return out;
}

async function readIndex(): Promise<VaultIndex> {
  try {
    const raw = await AsyncStorage.getItem(META_KEY);
    return raw ? cleanIndex(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

async function writeIndex(index: VaultIndex): Promise<void> {
  if (Object.keys(index).length === 0) await AsyncStorage.removeItem(META_KEY);
  else await AsyncStorage.setItem(META_KEY, JSON.stringify(index));
  for (const fn of listeners) {
    try {
      fn(index);
    } catch {
      // a listener's failure never breaks a save
    }
  }
}

// ---- public API ---------------------------------------------------------------------------------------------------

/** True on native when the secure store is in this binary. False on web and in APKs built before the vault. */
export function vaultAvailable(): boolean {
  return loadSecureStore() !== null;
}

function storeOptions(store: SecureStoreLike, platform: Platform, bio: boolean) {
  return {
    keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: bio,
    authenticationPrompt: `Unlock your saved ${platformMeta[platform].label} login`,
  };
}

function canUseBio(store: SecureStoreLike): boolean {
  try {
    return store.canUseBiometricAuthentication() === true;
  } catch {
    return false;
  }
}

/** True when this phone can put a saved login behind the fingerprint / face prompt. Never throws. */
export function biometricsAvailable(): boolean {
  try {
    const store = loadSecureStore();
    return store !== null && canUseBio(store);
  } catch {
    return false;
  }
}

/** Which platforms have a saved login (index only: nothing secret is read, no prompt). */
export async function vaultIndex(): Promise<VaultIndex> {
  if (!vaultAvailable()) return {};
  return readIndex();
}

export async function hasLogin(platform: Platform): Promise<boolean> {
  return !!(await vaultIndex())[platform];
}

/**
 * Save (or replace) the login for `platform`. Throws an Error with a message fit to show when the input is unusable or the
 * secure store is missing. The values are not kept anywhere else, and cannot be read back.
 *
 * `opts.bio`: whether reading it needs the biometric prompt (only honoured when the phone has biometrics). Left out, the
 * prompt is on whenever the phone supports it. A login saved automatically at a Connect sign-in should pass `{ bio: false }`
 * so it never prompts until the person turns the prompt on in Settings (`setLoginBio`).
 */
export async function saveLogin(
  platform: Platform,
  username: string,
  password: string,
  opts?: { bio?: boolean },
): Promise<void> {
  const store = loadSecureStore();
  if (!store) throw new Error('Saved logins need the latest version of the app.');
  const u = typeof username === 'string' ? username.trim() : '';
  const p = typeof password === 'string' ? password : '';
  if (!u || !p) throw new Error('Enter both the username and the password.');
  if (u.length > MAX_FIELD || p.length > MAX_FIELD) throw new Error('That username or password is too long.');

  const index = await readIndex();
  const old = index[platform];
  if (old) await deleteSecret(store, platform, old.bio);
  const bio = typeof opts?.bio === 'boolean' ? opts.bio && canUseBio(store) : canUseBio(store);
  try {
    await store.setItemAsync(secretKey(platform), JSON.stringify({ v: 1, u, p }), storeOptions(store, platform, bio));
  } catch {
    // The old login (if any) is already gone: say so in the index rather than offer a login that is not there.
    if (old) {
      const next = { ...index };
      delete next[platform];
      await writeIndex(next).catch(() => undefined);
    }
    throw new Error("Couldn't save the login on this phone. Try again.");
  }
  try {
    await writeIndex({ ...index, [platform]: { savedAt: new Date().toISOString(), bio } });
  } catch (e) {
    await deleteSecret(store, platform, bio);
    throw e;
  }
}

async function deleteSecret(store: SecureStoreLike, platform: Platform, bio: boolean): Promise<void> {
  try {
    await store.deleteItemAsync(secretKey(platform), storeOptions(store, platform, bio));
  } catch {
    // already gone, or a key the OS invalidated (biometrics changed): nothing left to remove
  }
}

/**
 * Turn the biometric prompt on or off for the login already saved for `platform`. The saved value is unlocked (with the
 * prompt, when the old entry has one) and rewritten in place under the new setting; it is never returned, kept or logged.
 * Throws an Error with a message fit to show; on failure the old entry and its index stay as they were.
 */
export async function setLoginBio(platform: Platform, on: boolean): Promise<void> {
  const store = loadSecureStore();
  if (!store) throw new Error('Saved logins need the latest version of the app.');
  const info = (await readIndex())[platform];
  if (!info) throw new Error('No login saved for this platform.');
  const want = on === true;
  if (want && !biometricsAvailable()) throw new Error("This phone can't ask for a fingerprint or face.");
  if (want === info.bio) return;

  const key = secretKey(platform);
  const oldOpts = storeOptions(store, platform, info.bio);
  let raw: string | null = null;
  try {
    raw = await store.getItemAsync(key, oldOpts);
    const v = raw ? (JSON.parse(raw) as { u?: unknown; p?: unknown }) : null;
    if (!v || typeof v.u !== 'string' || typeof v.p !== 'string' || !v.u || !v.p) raw = null;
  } catch {
    raw = null;
  }
  if (!raw) throw new Error("Couldn't unlock the saved login.");
  const value: string = raw;

  // Put the old entry back (best effort). If even that fails, the next fill reports the login unreadable.
  const restore = async () => {
    await deleteSecret(store, platform, want);
    try {
      await store.setItemAsync(key, value, oldOpts);
    } catch {
      // nothing more to do; the error below still tells the person it did not work
    }
  };

  // Delete-then-write, as saveLogin does: on iOS the prompt and no-prompt items live under different keychain services.
  await deleteSecret(store, platform, info.bio);
  try {
    await store.setItemAsync(key, value, storeOptions(store, platform, want));
  } catch {
    // e.g. the person cancelled the prompt Android shows when writing a prompt-bound item
    await restore();
    throw new Error("Couldn't change the saved login. Try again.");
  }
  try {
    await writeIndex({ ...(await readIndex()), [platform]: { savedAt: info.savedAt, bio: want } });
  } catch {
    await restore();
    throw new Error("Couldn't change the saved login. Try again.");
  }
}

/** Forget the saved login for `platform`. Never throws. */
export async function deleteLogin(platform: Platform): Promise<void> {
  const store = loadSecureStore();
  const index = await readIndex();
  if (store) {
    await deleteSecret(store, platform, index[platform]?.bio ?? false);
    if (index[platform]?.bio !== true) await deleteSecret(store, platform, true);
  }
  const next = { ...index };
  delete next[platform];
  try {
    await writeIndex(next);
  } catch {
    // the secret is gone; a stale index entry only makes the sheet offer a login that then reports "unreadable"
  }
}

/** Forget every saved login (workspace sign-out / reset). Never throws. */
export async function clearVault(): Promise<void> {
  const store = loadSecureStore();
  const index = await readIndex();
  if (store) {
    for (const p of PLATFORMS) {
      await deleteSecret(store, p, index[p]?.bio ?? false);
      if (index[p]?.bio !== true) await deleteSecret(store, p, true);
    }
  }
  try {
    await writeIndex({});
  } catch {
    // nothing secret is left either way
  }
}

/**
 * The script that types the saved login into `platform`'s login page (see fill.ts), or null when there is no saved login,
 * the person cancelled the biometric prompt, or the OS no longer lets us read it. The caller injects it into the WebView
 * and drops it; it never reads the values out of it.
 */
export async function fillScriptFor(platform: Platform): Promise<string | null> {
  const store = loadSecureStore();
  if (!store) return null;
  const info = (await readIndex())[platform];
  if (!info) return null;
  let raw: string | null;
  try {
    raw = await store.getItemAsync(secretKey(platform), storeOptions(store, platform, info.bio));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { u?: unknown; p?: unknown };
    if (typeof v.u !== 'string' || typeof v.p !== 'string' || !v.u || !v.p) return null;
    return buildFillScript(platform, { u: v.u, p: v.p });
  } catch {
    return null;
  }
}

/** Live view of the index for the UI. `saved[platform]` is set when that platform has a login. */
export function useVaultStatus(): { available: boolean; saved: VaultIndex; loaded: boolean; refresh(): void } {
  const available = vaultAvailable();
  const [saved, setSaved] = useState<VaultIndex>({});
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const onChange = (index: VaultIndex) => {
      if (alive) setSaved(index);
    };
    listeners.add(onChange);
    void vaultIndex().then((index) => {
      if (!alive) return;
      setSaved(index);
      setLoaded(true);
    });
    return () => {
      alive = false;
      listeners.delete(onChange);
    };
  }, [tick]);
  return { available, saved, loaded, refresh: () => setTick((n) => n + 1) };
}
