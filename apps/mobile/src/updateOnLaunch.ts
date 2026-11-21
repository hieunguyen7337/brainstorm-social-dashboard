/**
 * Start on the newest published update instead of the one built into the APK (2026-11-21: a tester reinstalled the APK and
 * kept testing the morning's broken sign-in, because a new update was only used after Pulse was closed and opened again).
 *
 * The native side already waits up to `fallbackToCacheTimeout` at a cold start (app.config.ts, new APKs only). This covers
 * the rest:
 * - right after launch, a newer update found within the first seconds is loaded at once;
 * - when Pulse comes back to the screen after RESUME_AFTER_MS in the background, it checks again and reloads into a new
 *   update, unless something is in progress (`holdUpdates`: the sign-in sheet), so nobody loses a half-done sign-in.
 * Later finds are used at the next start, as before.
 */
import { AppState, Platform, type AppStateStatus } from 'react-native';

const RELOAD_WINDOW_MS = 8_000;
const RESUME_AFTER_MS = 5 * 60_000;

let holds = 0;
let checking = false;

/** Keep the app from reloading itself while something is in progress. Returns the release function. */
export function holdUpdates(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
  };
}

async function checkAndReload(): Promise<void> {
  if (__DEV__ || Platform.OS === 'web' || checking || holds > 0) return;
  checking = true;
  const t0 = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const U = require('expo-updates');
    if (!U.isEnabled) return;
    const check = await U.checkForUpdateAsync();
    if (!check.isAvailable) return;
    const fetched = await U.fetchUpdateAsync();
    if (fetched.isNew && holds === 0 && Date.now() - t0 < RELOAD_WINDOW_MS) await U.reloadAsync();
  } catch {
    // offline or updates unavailable: keep running what we have
  } finally {
    checking = false;
  }
}

export async function applyUpdateOnLaunch(): Promise<void> {
  await checkAndReload();
}

/** Re-check when the app returns from a long stay in the background. Returns the unsubscribe function. */
export function watchForUpdates(): () => void {
  if (Platform.OS === 'web') return () => {};
  let leftAt: number | null = null;
  const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'background') leftAt = Date.now();
    else if (s === 'active' && leftAt !== null) {
      const away = Date.now() - leftAt;
      leftAt = null;
      if (away >= RESUME_AFTER_MS) void checkAndReload();
    }
  });
  return () => sub.remove();
}
