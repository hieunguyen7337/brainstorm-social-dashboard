/**
 * Start on the newest published update instead of the one built into the APK (2026-11-21: a tester reinstalled the APK and
 * kept testing the morning's broken sign-in, because a new update was only used after Pulse was closed and opened again).
 *
 * The native side already waits up to `fallbackToCacheTimeout` at a cold start (app.config.ts, new APKs only). This covers
 * the rest: when a newer update is found right after launch, load it now. Only within the first seconds, so the app never
 * reloads under someone who has started using it; later finds are used at the next start, as before.
 */
import { Platform } from 'react-native';

const RELOAD_WINDOW_MS = 8_000;

export async function applyUpdateOnLaunch(): Promise<void> {
  if (__DEV__ || Platform.OS === 'web') return;
  const t0 = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const U = require('expo-updates');
    if (!U.isEnabled) return;
    const check = await U.checkForUpdateAsync();
    if (!check.isAvailable) return;
    const fetched = await U.fetchUpdateAsync();
    if (fetched.isNew && Date.now() - t0 < RELOAD_WINDOW_MS) await U.reloadAsync();
  } catch {
    // offline or updates unavailable: keep running what we have
  }
}
