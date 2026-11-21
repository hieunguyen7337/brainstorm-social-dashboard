import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { ConnectSheetProvider } from '@/src/components/connect/ConnectSheet';
import { SessionProvider, useSession, type SessionStatus } from '@/src/session';
import { colors } from '@/src/theme';
import { ToastProvider } from '@/src/ui';
import { applyUpdateOnLaunch, watchForUpdates } from '@/src/updateOnLaunch';
import { IosInstallHint } from '@/src/ui/IosInstallHint';

// Web production builds load each route as its own chunk (asyncRoutes in app.config.ts). These two are what every
// cold start needs next (`/` only redirects to onboarding or the dashboard): importing them here ships them with the
// shell instead of as two more sequential round trips (layout, then index, then onboarding). Bare imports on purpose.
import './index';
import './onboarding';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

// Web, browser only (static export renders this module in Node): a saved guest token (the `TOKEN_KEY` of src/http.ts)
// means a returning visitor, who lands on the dashboard. Start its chunk now, in parallel with the session check,
// instead of after the redirect. Best effort only.
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  try {
    if (localStorage.getItem('pulse.token')) void import('./(tabs)/dashboard').catch(() => undefined);
  } catch {
    /* storage blocked */
  }
}

/** Route chunks in the order a user is most likely to need them (web only, see `usePrefetchRoutes`). */
const NEXT_SCREEN = [() => import('./(tabs)/_layout'), () => import('./(tabs)/dashboard')];
const OTHER_TABS = [
  () => import('./(tabs)/trends'),
  () => import('./(tabs)/create'),
  () => import('./(tabs)/queue'),
  () => import('./(tabs)/settings'),
];

type Conn = { saveData?: boolean; effectiveType?: string };
type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };

/**
 * Web production builds load every route as its own chunk (`asyncRoutes` in app.config.ts), so the first visit to a
 * screen would show an empty page for the length of one download. Once a screen is up (`landed`) and the browser is
 * idle, fetch the chunks the user is about to need, one at a time so they never compete with the app's own requests:
 * the dashboard after onboarding, the remaining tabs once signed in. Skipped on Save-Data and 2G connections.
 */
function usePrefetchRoutes(status: SessionStatus, landed: boolean) {
  useEffect(() => {
    if (Platform.OS !== 'web' || status === 'loading' || !landed) return;
    const conn = (navigator as Navigator & { connection?: Conn }).connection;
    if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return;

    let cancelled = false;
    const idle = (fn: () => void) => {
      const ric = (window as IdleWindow).requestIdleCallback;
      if (ric) ric.call(window, fn, { timeout: 4000 });
      else setTimeout(fn, 1500);
    };
    const queue = status === 'ready' ? [...NEXT_SCREEN, ...OTHER_TABS] : NEXT_SCREEN;
    const next = (i: number) => {
      if (cancelled || i >= queue.length) return;
      queue[i]()
        .then(() => idle(() => next(i + 1)))
        .catch(() => undefined); // offline or a stale deploy: the screen loads on demand instead
    };
    // Give the first screen's own requests (icon font, images) a second before starting.
    const timer = setTimeout(() => idle(() => next(0)), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status, landed]);
}

function Gate() {
  const { status } = useSession();
  useEffect(() => {
    // Web: request the icon font as soon as the shell is up instead of when the first icon mounts, which only happens
    // after the route chunk has been fetched and rendered. In production builds it is a ~30 KB subset (see
    // metro.config.js).
    // Never awaited and never gating anything: text and skeletons paint first, icons fill in when the font lands.
    // Skipped when hydrating pre-rendered HTML (PULSE_WEB_OUTPUT=static): a font registered before the icons hydrate
    // would make them render glyphs where the server HTML has none.
    const hydrating = (globalThis as { __EXPO_ROUTER_HYDRATE__?: boolean }).__EXPO_ROUTER_HYDRATE__;
    if (Platform.OS === 'web' && !hydrating) void Ionicons.loadFont().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (status !== 'loading') SplashScreen.hideAsync().catch(() => undefined);
  }, [status]);
  // '/' only redirects: a first segment means a real screen (onboarding, a tab) has been resolved.
  usePrefetchRoutes(status, useSegments().length > 0);

  return (
    <>
      <StatusBar style="light" />
      {/* Above the navigator: the connect dialog opens from any screen. */}
      <ConnectSheetProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'fade',
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </ConnectSheetProvider>
      {/* iPhone browsers only: one line on adding Pulse to the Home Screen (no Apple account, so no iOS build). */}
      <IosInstallHint />
    </>
  );
}

export default function RootLayout() {
  useEffect(() => {
    void applyUpdateOnLaunch();
    return watchForUpdates();
  }, []);
  return (
    <SessionProvider>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </SessionProvider>
  );
}
