/**
 * Background refresh of the numbers (Android only), and the sign-out that forgets the platform sign-ins.
 *
 *   <AutoRefresh />        mounted once in the signed-in tab layout. At app start and whenever the app returns to the
 *                          foreground it walks the connected platforms; each one whose last automatic read is older than
 *                          an hour is opened in ONE hidden WebView at a time (the sheet's WebView store, so the sign-in the
 *                          person made there is already in place), read with the same runner and page readers as the
 *                          sheet, and saved with `api.ingestMetrics({ source: 'device' })`. A login page, a read that takes
 *                          longer than REFRESH_TIMEOUT_MS, or any error skips the platform silently. When the page's own
 *                          requests fail, the hidden profile is captured and read by Claude, as in the sheet (owner,
 *                          2026-11-21: "if request keep failing, relying on the next step, screen capture and read with
 *                          claude instead").
 *   forgetSignIns()        drops the platform sign-ins (cookies). react-native-webview has no cookie API, but on Android the
 *                          `incognito` flag clears the cookie store when it is applied, so a hidden incognito WebView is
 *                          mounted briefly by the mounted `<AutoRefresh />`. Resolves when that is done (never rejects).
 *
 * Nothing here logs or stores cookies, tokens or page contents. The only thing kept is the time of the last read, in
 * AsyncStorage (the storage `src/http.ts` uses for the session token).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform as RNPlatform, StyleSheet, View } from 'react-native';
import type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';

import { api, getToken, isMock, PLATFORMS, type IngestAccount, type IngestRequest, type Platform } from '@/src/api';
import { useConnectSheet } from '@/src/components/connect/sheetContext';
import { DEFAULT_PERIOD, postsToIngest } from '@/src/connect/logic';
import { HREF_POLL_JS, HREF_POLL_MS, takeHref } from './hrefPoll';
import { CAPTURE_MAX_BYTES, CAPTURE_RETRY_QUALITY, FORGET_HOLD_MS, REFRESH_RETRY_MS, REFRESH_STALE_MS, REFRESH_TICK_MS, REFRESH_TIMEOUT_MS, UA_ANDROID } from './config';
import { loadNative, type NativeBits, type WebViewRef } from './native';
import { AutoReadRunner } from './runner';
import type { DeviceRead } from './types';

const LAST_KEY = 'pulse.autoRefresh.';
const MAX_COUNT = 10 ** 12;

// ---- forgetSignIns -------------------------------------------------------------------------------------------------------

/** Set by the mounted `<AutoRefresh />`: starts the erase and calls back when it is done. */
let eraseHost: ((done: () => void) => void) | null = null;

/**
 * Forget the platform sign-ins on this phone. Fire and forget is fine (the promise never rejects); `signOut` waits for it
 * briefly so the hidden WebView is not unmounted with the tab layout before Android has applied the incognito flag.
 * A no-op when no `<AutoRefresh />` is mounted, on iOS, on web and in an APK without the native modules.
 */
export function forgetSignIns(): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      if (!eraseHost) resolve();
      else eraseHost(resolve);
    } catch {
      resolve();
    }
  });
}

// ---- helpers -------------------------------------------------------------------------------------------------------------

const allowWebUrl = (req: { url: string }) => /^(https?:\/\/|about:blank)/i.test(req.url);

const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const count = (n: number): number => Math.min(MAX_COUNT, Math.max(0, Math.round(n)));

/** The ingest body for a page read, or null when it holds no number. Same shape `checkForm` builds for source "device". */
function toIngestRequest(read: DeviceRead, connectionHandle: string): IngestRequest | null {
  const account: IngestAccount = {};
  const fields: [keyof IngestAccount, number | null, boolean][] = [
    ['followers', read.followers, false], // a total, not a window
    ['views', read.views, true],
    ['engagements', read.engagements, true],
    ['profile_views', read.profile_views, true],
  ];
  let given = 0;
  let windowed = false;
  for (const [key, value, inWindow] of fields) {
    if (!num(value)) continue;
    account[key] = count(value);
    given += 1;
    if (inWindow) windowed = true;
  }
  const posts = postsToIngest(read.posts);
  if (given === 0 && posts.length === 0) return null;
  const handle = (read.handle ?? '').trim().replace(/^@+/, '') || connectionHandle.trim().replace(/^@+/, '');
  return {
    platform: read.platform,
    source: 'device',
    ...(handle ? { handle: handle.slice(0, 100) } : {}),
    ...(windowed ? { period_days: read.period_days ?? DEFAULT_PERIOD } : {}),
    account,
    posts,
  };
}

async function lastRead(platform: Platform): Promise<number> {
  try {
    const n = Number(await AsyncStorage.getItem(LAST_KEY + platform));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function markRead(platform: Platform): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_KEY + platform, String(Date.now()));
  } catch {
    // ignore: the platform is simply read again next time
  }
}

async function forgetTimes(): Promise<void> {
  try {
    await Promise.all(PLATFORMS.map((p) => AsyncStorage.removeItem(LAST_KEY + p)));
  } catch {
    // ignore
  }
}

// ---- the hidden reader ---------------------------------------------------------------------------------------------------

/** A render failure in a hidden WebView must never take the app down: it just ends that read. */
class Boundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface HiddenReadProps {
  platform: Platform;
  native: NativeBits;
  /** The connected account's handle: the screenshot fallback opens its profile when the requests name no account. */
  handle: string;
  /** Called once: the numbers, or null when the read did not work (login page, timeout, error). */
  onDone: (read: DeviceRead | null) => void;
}

function HiddenRead({ platform, native, handle, onDone }: HiddenReadProps) {
  const { WebView, captureRef } = native;
  const shotRef = useRef<View>(null);
  const handleRef = useRef(handle);
  const [source, setSource] = useState<{ uri: string } | null>(null);
  const webRef = useRef<WebViewRef | null>(null);
  const runner = useRef<AutoReadRunner | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  // While the runner waits for a sign-in, ask the page where it really is (see hrefPoll.ts).
  const waiting = useRef(true);
  useEffect(() => {
    if (!source) return;
    const t = setInterval(() => {
      if (waiting.current) webRef.current?.injectJavaScript(HREF_POLL_JS);
    }, HREF_POLL_MS);
    return () => clearInterval(t);
  }, [source]);

  useEffect(() => {
    let finished = false;
    let r: AutoReadRunner | null = null;
    let sawReading = false;
    let cap: ReturnType<typeof setTimeout> | null = null;
    const finish = (read: DeviceRead | null) => {
      if (finished) return;
      finished = true;
      if (cap) clearTimeout(cap);
      r?.dispose();
      onDoneRef.current(read);
    };
    r = new AutoReadRunner({
      platform,
      loadUrl: (uri) => setSource({ uri }),
      fallbackHandle: handleRef.current,
      inject: (js) => webRef.current?.injectJavaScript(js),
      // The hidden WebView (360 x 640) as a JPEG, read by Claude through the screenshot endpoint, like the sheet.
      capture: async () => {
        if (!shotRef.current) throw new Error('not ready');
        const raw = await captureRef(shotRef, { format: 'jpg', quality: CAPTURE_RETRY_QUALITY, result: 'base64' });
        const base64 = typeof raw === 'string' ? raw.replace(/^data:[^,]*,/, '') : '';
        if (!base64 || (base64.length * 3) / 4 > CAPTURE_MAX_BYTES) throw new Error('capture unusable');
        return base64;
      },
      readScreenshot: (base64, mediaType) => api.readScreenshot(platform, { image_base64: base64, media_type: mediaType }),
      emitResult: (read) => finish(read),
      emitClose: () => finish(null),
      onStatus: (s) => {
        waiting.current = s === 'login';
        // Back to the login state after reading began = the page says the person is signed out.
        if (s === 'reading') sawReading = true;
        else if (s === 'login' && sawReading) finish(null);
      },
    });
    runner.current = r;
    cap = setTimeout(() => finish(null), REFRESH_TIMEOUT_MS);
    try {
      r.start();
    } catch {
      finish(null);
    }
    return () => {
      finished = true;
      if (cap) clearTimeout(cap);
      r?.dispose();
      if (runner.current === r) runner.current = null;
    };
  }, [platform, captureRef]);

  return (
    <View pointerEvents="none" style={styles.clip} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {source ? (
        <View ref={shotRef} collapsable={false} style={styles.web}>
        <WebView
          ref={webRef}
          testID="auto-refresh-webview"
          source={source}
          incognito={false}
          userAgent={UA_ANDROID}
          javaScriptEnabled
          domStorageEnabled
          cacheEnabled={false}
          textZoom={100}
          setSupportMultipleWindows={false}
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={allowWebUrl}
          allowFileAccess={false}
          style={styles.web}
          onNavigationStateChange={(s: WebViewNavigation) => runner.current?.navigated(s.url, s.loading)}
          onLoadEnd={(e) => runner.current?.loadEnded(e.nativeEvent.url)}
          onMessage={(e: WebViewMessageEvent) => {
            const href = takeHref(e.nativeEvent.data);
            if (href) runner.current?.navigated(href, false);
            else runner.current?.message(e.nativeEvent.data);
          }}
          onError={(e) => runner.current?.loadFailed(e.nativeEvent.url)}
        />
        </View>
      ) : null}
    </View>
  );
}

// ---- AutoRefresh ---------------------------------------------------------------------------------------------------------

interface Job {
  key: number;
  platform: Platform;
  handle: string;
}

/**
 * Mount once where the person is signed in (the tab layout). Renders nothing visible; does nothing on web, iOS, in a mock
 * build or in an APK without the native modules.
 */
export function AutoRefresh() {
  const native = RNPlatform.OS === 'android' ? loadNative() : null;
  const { markSaved } = useConnectSheet();
  const markSavedRef = useRef(markSaved);
  markSavedRef.current = markSaved;

  const [job, setJob] = useState<Job | null>(null);
  const [erasing, setErasing] = useState(false);
  const jobKey = useRef(0);
  const running = useRef(false);
  /** Bumped by forget / unmount: a pass in progress stops at its next step. */
  const generation = useRef(0);
  const settle = useRef<((read: DeviceRead | null) => void) | null>(null);
  const failedAt = useRef<Partial<Record<Platform, number>>>({});
  const erasers = useRef<(() => void)[]>([]);
  const eraseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const endJob = (read: DeviceRead | null) => {
    const fn = settle.current;
    settle.current = null;
    setJob(null);
    fn?.(read);
  };

  useEffect(() => {
    if (!native) return undefined;

    const readOne = (platform: Platform, handle: string): Promise<DeviceRead | null> =>
      new Promise<DeviceRead | null>((resolve) => {
        settle.current = resolve;
        jobKey.current += 1;
        setJob({ key: jobKey.current, platform, handle });
      });

    const due = async (platform: Platform): Promise<boolean> => {
      const failed = failedAt.current[platform];
      if (failed && Date.now() - failed < REFRESH_RETRY_MS) return false;
      return Date.now() - (await lastRead(platform)) >= REFRESH_STALE_MS;
    };

    const pass = async () => {
      if (running.current || isMock() || !getToken()) return;
      running.current = true;
      const mine = generation.current;
      try {
        const connections = await api.listConnections();
        for (const conn of connections) {
          if (generation.current !== mine) return;
          if (conn.status !== 'connected') continue;
          // Only connections the person signed in to themselves are read here: every real connection is `live`. A demo
          // workspace's are `sandbox` (docs/REAL.md, "Demo workspaces"): never open a hidden sign-in for them.
          if (conn.mode !== 'live') continue;
          try {
            if (!(await due(conn.platform)) || generation.current !== mine) continue;
            const read = await readOne(conn.platform, conn.handle ?? '');
            if (generation.current !== mine) return;
            const request = read ? toIngestRequest(read, conn.handle) : null;
            if (!request) {
              failedAt.current[conn.platform] = Date.now(); // login page, timeout or nothing found: skip silently
              continue;
            }
            await api.ingestMetrics(request);
            await markRead(conn.platform);
            if (generation.current === mine) markSavedRef.current(); // the connect lists and the dashboard refetch
          } catch {
            failedAt.current[conn.platform] = Date.now();
          }
        }
      } catch {
        // offline, signed out or anything else: try again at the next start / return to the foreground
      } finally {
        running.current = false;
      }
    };

    void pass();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void pass();
    });
    // Live numbers: while the app is in front, look again every REFRESH_TICK_MS (pass() skips fresh platforms).
    const tick = setInterval(() => {
      if (AppState.currentState === 'active') void pass();
    }, REFRESH_TICK_MS);
    return () => {
      clearInterval(tick);
      sub.remove();
      generation.current += 1;
      endJob(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  // forgetSignIns(): stop any read, forget the read times, then keep a hidden incognito WebView mounted for a moment.
  useEffect(() => {
    if (!native) return undefined;
    const host = (done: () => void) => {
      erasers.current.push(done);
      generation.current += 1;
      endJob(null);
      void forgetTimes();
      failedAt.current = {};
      if (eraseTimer.current) clearTimeout(eraseTimer.current);
      setErasing(true);
      eraseTimer.current = setTimeout(() => {
        eraseTimer.current = null;
        setErasing(false);
        const waiting = erasers.current.splice(0);
        waiting.forEach((fn) => fn());
      }, FORGET_HOLD_MS);
    };
    eraseHost = host;
    return () => {
      if (eraseHost === host) eraseHost = null;
      if (eraseTimer.current) clearTimeout(eraseTimer.current);
      eraseTimer.current = null;
      erasers.current.splice(0).forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  if (!native) return null;
  const { WebView } = native;
  return (
    <>
      {job && !erasing ? (
        <Boundary key={job.key} onFail={() => endJob(null)}>
          <HiddenRead platform={job.platform} native={native} handle={job.handle} onDone={endJob} />
        </Boundary>
      ) : null}
      {erasing ? (
        <View pointerEvents="none" style={styles.clip} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Boundary onFail={() => undefined}>
            {/* Android clears the cookie store when `incognito` is applied. */}
            <WebView testID="auto-refresh-eraser" source={{ uri: 'about:blank' }} incognito style={styles.web} />
          </Boundary>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  // A 1x1 clip window with a phone-sized page inside: pages lay out as on a phone, but nothing is visible or touchable.
  clip: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'hidden', opacity: 0.01 },
  web: { width: 360, height: 640 },
});
