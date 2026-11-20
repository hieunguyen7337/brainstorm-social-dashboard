/**
 * Tiny persisted store for the room flow: the last room code this device joined, whether the "You're in!" welcome is
 * still waiting to be shown, and whether the install banner was dismissed.
 *
 * Reads are synchronous from memory (so a banner can appear in the same frame the deep link marks it pending), writes
 * go to AsyncStorage in the background. Every storage access is wrapped in try/catch: a private window or blocked
 * storage just means nothing survives a reload, never a crash.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import type { RoomInfo } from '@/src/types';

const CODE_KEY = 'pulse.roomCode';
const WELCOME_KEY = 'pulse.roomWelcome';
const INSTALL_KEY = 'pulse.installDismissed';

/** Brand name of the guest workspace created by a room link (no form). */
export const ROOM_GUEST_BRAND = 'My brand';

type Welcome = 'none' | 'pending' | 'dismissed';

interface Snapshot {
  /** Storage has been read (until then nothing is shown, so a dismissed banner never flashes). */
  hydrated: boolean;
  code: string | null;
  welcome: Welcome;
  installDismissed: boolean;
}

let snap: Snapshot = { hydrated: false, code: null, welcome: 'none', installDismissed: false };
/** Fields changed in memory before the storage read finished: the stored value must not overwrite them. */
const touched = new Set<keyof Snapshot>();
const listeners = new Set<() => void>();
let hydration: Promise<void> | null = null;
let lastRoom: RoomInfo | null = null;

function set(patch: Partial<Snapshot>): void {
  for (const k of Object.keys(patch) as (keyof Snapshot)[]) if (k !== 'hydrated') touched.add(k);
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

function persist(key: string, value: string | null): void {
  void (async () => {
    try {
      if (value === null) await AsyncStorage.removeItem(key);
      else await AsyncStorage.setItem(key, value);
    } catch {
      // storage blocked: the flag lives for this page load only
    }
  })();
}

/** Read the persisted flags once. Never throws. */
export function hydrateRoomStore(): Promise<void> {
  hydration ??= (async () => {
    let code: string | null = null;
    let welcome: string | null = null;
    let install: string | null = null;
    try {
      [code, welcome, install] = await Promise.all([
        AsyncStorage.getItem(CODE_KEY),
        AsyncStorage.getItem(WELCOME_KEY),
        AsyncStorage.getItem(INSTALL_KEY),
      ]);
    } catch {
      // nothing persisted
    }
    const stored: Partial<Snapshot> = {
      code: code || null,
      welcome: welcome === 'pending' || welcome === 'dismissed' ? welcome : 'none',
      installDismissed: install === '1',
    };
    const next: Snapshot = { ...snap, hydrated: true };
    for (const k of Object.keys(stored) as (keyof Snapshot)[]) {
      if (!touched.has(k)) (next as unknown as Record<string, unknown>)[k] = stored[k];
    }
    snap = next;
    listeners.forEach((l) => l());
  })();
  return hydration;
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const getSnapshot = (): Snapshot => snap;

function useRoomSnapshot(): Snapshot {
  useEffect(() => {
    void hydrateRoomStore();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Letters, digits, dash and underscore only; anything else is not a room code. */
export function cleanRoomCode(raw: string | string[] | null | undefined): string | null {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return v && /^[A-Za-z0-9_-]{2,40}$/.test(v) ? v : null;
}

/**
 * Remember that this device opened a room link. `fresh` (a brand-new guest workspace) always shows the welcome again;
 * for an existing session the welcome shows once per room: re-opening the same room after dismissing it stays quiet.
 */
export async function markRoomJoined(code: string, fresh = false): Promise<void> {
  // An existing session compares against what was stored, so wait for the read (a fresh guest workspace does not).
  if (!fresh) await hydrateRoomStore();
  const sameRoom = snap.code === code;
  set({ code });
  persist(CODE_KEY, code);
  if (fresh || !sameRoom || snap.welcome === 'none') {
    set({ welcome: 'pending' });
    persist(WELCOME_KEY, 'pending');
  }
}

export function dismissRoomWelcome(): void {
  set({ welcome: 'dismissed' });
  persist(WELCOME_KEY, 'dismissed');
}

/** Forget a pending welcome (the person left this workspace); the remembered room code stays. */
export function clearRoomWelcome(): void {
  if (snap.welcome === 'none') return;
  set({ welcome: 'none' });
  persist(WELCOME_KEY, null);
}

export function dismissInstallBanner(): void {
  set({ installDismissed: true });
  persist(INSTALL_KEY, '1');
}

/** The welcome banner: visible while a room link is waiting to be acknowledged. */
export function useRoomWelcome(): { visible: boolean; code: string | null; dismiss: () => void } {
  const s = useRoomSnapshot();
  return { visible: s.hydrated && s.welcome === 'pending', code: s.code, dismiss: dismissRoomWelcome };
}

/** Room code this device joined and whether its welcome is still pending (onboarding fallback hint). */
export function useRoomJoin(): { code: string | null; pending: boolean } {
  const s = useRoomSnapshot();
  return { code: s.code, pending: s.welcome === 'pending' };
}

export function useInstallDismissed(): { ready: boolean; dismissed: boolean; dismiss: () => void } {
  const s = useRoomSnapshot();
  return { ready: s.hydrated, dismissed: s.installDismissed, dismiss: dismissInstallBanner };
}

// ---- last room created from this device (memory only: survives tab switches, not a reload) -----------------------

export const getLastRoom = (): RoomInfo | null => lastRoom;
export const setLastRoom = (room: RoomInfo | null): void => {
  lastRoom = room;
};
