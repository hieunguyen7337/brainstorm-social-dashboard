/**
 * Where the Anthropic API key lives: `expo-secure-store` only (Android Keystore / iOS Keychain), readable while the phone
 * is unlocked and never synced off the device. Same pattern as the vault (`src/vault/native.ts` probes the native module,
 * so an APK built before it existed reports "unavailable" instead of crashing).
 *
 * The key is never logged, never sent to Pulse's API and never written to AsyncStorage. The only thing the UI may show is
 * `maskKey(...)`. Web has no store (`loadSecureStore()` is null there): the Assistant is native-only.
 */
import { useEffect, useState } from 'react';

import { loadSecureStore } from '@/src/vault/native';

import { keyProblem, maskKey, normalizeKey } from './key';

const SECRET_KEY = 'pulse.assistant.anthropic.v1';

/** True when this binary has the secure store (false on web and in APKs built before the vault). */
export function keyStoreAvailable(): boolean {
  return loadSecureStore() !== null;
}

const listeners = new Set<() => void>();
const changed = () => {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a listener's failure never breaks a save
    }
  }
};

/** The saved key, or null (none saved, no store, or an entry the OS made unreadable). Hand it to the SDK and nothing else. */
export async function readApiKey(): Promise<string | null> {
  const store = loadSecureStore();
  if (!store) return null;
  try {
    const raw = await store.getItemAsync(SECRET_KEY, { keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    const key = raw ? normalizeKey(raw) : '';
    return key && keyProblem(key) === null ? key : null;
  } catch {
    return null;
  }
}

/** Save or replace the key. Throws an Error with a message fit to show. */
export async function saveApiKey(raw: string): Promise<void> {
  const store = loadSecureStore();
  if (!store) throw new Error('The Claude API key needs the latest version of the app.');
  const problem = keyProblem(raw);
  if (problem) throw new Error(problem);
  try {
    await store.setItemAsync(SECRET_KEY, normalizeKey(raw), { keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  } catch {
    throw new Error("Couldn't save the key on this phone. Try again.");
  }
  changed();
}

/** Forget the key. Never throws. */
export async function deleteApiKey(): Promise<void> {
  const store = loadSecureStore();
  if (store) {
    try {
      await store.deleteItemAsync(SECRET_KEY, { keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    } catch {
      // already gone
    }
  }
  changed();
}

export interface KeyStatus {
  /** Read once: false until the first answer. */
  ready: boolean;
  /** This binary can store a key. False: show "update the app". */
  available: boolean;
  /** "sk-ant-…WXYZ" when a key is saved, else null. */
  hint: string | null;
}

/** Live status of the saved key for Settings and the Assistant tab. */
export function useApiKeyStatus(): KeyStatus {
  const [status, setStatus] = useState<KeyStatus>({ ready: false, available: keyStoreAvailable(), hint: null });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const available = keyStoreAvailable();
      const key = available ? await readApiKey() : null;
      if (alive) setStatus({ ready: true, available, hint: key ? maskKey(key) : null });
    };
    void load();
    listeners.add(load as () => void);
    return () => {
      alive = false;
      listeners.delete(load as () => void);
    };
  }, []);
  return status;
}
