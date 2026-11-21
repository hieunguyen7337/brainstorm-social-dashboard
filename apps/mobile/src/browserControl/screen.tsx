/**
 * "Let Claude use your phone's browser" (Android). A full-screen WebView that shares the app's cookie store (so it is
 * signed in wherever the person signed in through Pulse), with a banner that always says Claude is in control and a Stop
 * button. While this screen is open it long-polls GET /api/browser/next and runs each command (see commands.ts and
 * apps/api/app/routes/browser.py); closing the screen or pressing Stop ends the session at once.
 *
 * OTA safe: it uses only react-native-webview and react-native-view-shot through autoRead/native.ts, which the current
 * APK already ships.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelRatio, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';

import { UA_ANDROID } from '@/src/autoRead/config';
import { loadNative, type NativeBits, type WebViewRef } from '@/src/autoRead/native';
import { apiBase, getToken } from '@/src/http';
import { holdUpdates } from '@/src/updateOnLaunch';
import { colors, radius, space } from '@/src/theme';
import {
  PAGE_ACTIONS,
  allowedUrl,
  captureBlock,
  describeCommand,
  elementsInShotPixels,
  pageHasSecret,
  pageScript,
  parseCommand,
  parsePageMessage,
  safeUrl,
  shotSize,
  type BrowserCommand,
  type BrowserResult,
  type ShotSize,
} from './commands';

const LONG_POLL_S = 25;
const FETCH_TIMEOUT_MS = 35_000;
const PAGE_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 20_000;
const AFTER_ACTION_MS = 1_200;
const RETRY_MS = 2_000;
const CAPTURE_MAX_BYTES = 4_000_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const START_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;background:#0b1020;color:#f4f6ff;padding:24px;line-height:1.5}
a{display:block;color:#a99bff;margin:12px 0;font-size:18px}</style></head><body>
<h2>Waiting for Claude</h2>
<p>Ask Claude (with the Pulse connector) to read your numbers or post for you. You will see every step here.</p>
<p>Not signed in yet? Sign in yourself first; Claude never types passwords:</p>
<a href="https://www.instagram.com/">Instagram</a><a href="https://www.linkedin.com/login">LinkedIn</a>
<a href="https://x.com/login">X</a><a href="https://www.facebook.com/">Facebook</a><a href="https://www.tiktok.com/login">TikTok</a>
</body></html>`;

/** One constant object: a new `source` object on each render would make Android reload the start page. */
const START_SOURCE = { html: START_HTML, baseUrl: 'about:blank' };

type Phase = 'connecting' | 'waiting' | 'running' | 'offline' | 'stopped';

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function api<T>(method: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const token = getToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  try {
    const res = await fetch(apiBase() + path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function Controller({ native }: { native: NativeBits }) {
  const { WebView, captureRef } = native;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebViewRef | null>(null);
  const shotRef = useRef<View>(null);
  const shot = useRef<ShotSize>({ w: 0, h: 0 });
  const nav = useRef({ url: 'about:blank', title: '', canGoBack: false });
  const lastFill = useRef(0); // when Claude last typed into a field: no screenshot for a while after
  const loadWaiters = useRef<(() => void)[]>([]);
  const pageWaiters = useRef(new Map<string, (r: BrowserResult) => void>());
  const [phase, setPhase] = useState<Phase>('connecting');
  const [doing, setDoing] = useState('');
  const [count, setCount] = useState(0);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    shot.current = shotSize(width, height, PixelRatio.get());
  };

  const waitLoad = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      loadWaiters.current.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });

  const runInPage = (cmd: BrowserCommand) =>
    new Promise<BrowserResult>((resolve) => {
      const t = setTimeout(() => {
        pageWaiters.current.delete(cmd.id);
        resolve({ ok: false, error: 'The page did not answer (still loading?). Try again.' });
      }, PAGE_TIMEOUT_MS);
      pageWaiters.current.set(cmd.id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      webRef.current?.injectJavaScript(pageScript(cmd, shot.current));
    });

  const capture = useCallback(async (): Promise<BrowserResult> => {
    const { w, h } = shot.current;
    if (!shotRef.current || w <= 0 || h <= 0) return { ok: false, error: 'The browser is not on screen yet.' };
    // Never capture a sign-in page, a page with a password or code field on screen, or the moment after a fill.
    const probe = await runInPage({ id: `probe-${Date.now()}`, action: 'elements', args: {} });
    const blocked = captureBlock({
      url: nav.current.url,
      now: Date.now(),
      lastFillAt: lastFill.current,
      secretOnPage: pageHasSecret(probe),
    });
    if (blocked) return { ok: false, error: blocked };
    for (const quality of [0.7, 0.45]) {
      const raw = await captureRef(shotRef, { format: 'jpg', quality, result: 'base64', width: w, height: h });
      const b64 = typeof raw === 'string' ? raw.replace(/^data:[^,]*,/, '') : '';
      if (b64 && (b64.length * 3) / 4 <= CAPTURE_MAX_BYTES) {
        return { ok: true, image_jpeg_base64: b64, width: w, height: h };
      }
    }
    return { ok: false, error: 'The screenshot was too large.' };
  }, [captureRef]);

  const execute = useCallback(
    async (cmd: BrowserCommand): Promise<BrowserResult> => {
      const here = () => ({ url: nav.current.url, title: nav.current.title });
      switch (cmd.action) {
        case 'open': {
          const loaded = waitLoad(LOAD_TIMEOUT_MS);
          webRef.current?.injectJavaScript(`window.location.href=${JSON.stringify(String(cmd.args.url))};true;`);
          const ok = await loaded;
          await sleep(800);
          return { ok: true, ...here(), ...(ok ? {} : { text: 'The page is still loading.' }) };
        }
        case 'back': {
          if (!nav.current.canGoBack) return { ok: false, error: 'There is no page to go back to.' };
          const loaded = waitLoad(8_000);
          webRef.current?.goBack();
          await loaded;
          await sleep(500);
          return { ok: true, ...here() };
        }
        case 'screenshot': {
          const r = await capture();
          return { ...r, ...here() };
        }
        default: {
          if (!PAGE_ACTIONS.includes(cmd.action)) return { ok: false, error: `Unsupported action ${cmd.action}` };
          if (cmd.action === 'type') lastFill.current = Date.now();
          const r = await runInPage(cmd);
          if (cmd.action === 'elements' && r.ok) r.data = elementsInShotPixels(r.data, shot.current);
          if (r.ok && (cmd.action === 'click' || cmd.action === 'press' || cmd.action === 'type')) {
            await sleep(AFTER_ACTION_MS);
            return { ...r, ...here() };
          }
          return r;
        }
      }
    },
    [capture],
  );

  // The session: heartbeat, then long-poll for commands until Stop or the screen closes.
  useEffect(() => {
    const ctrl = new AbortController();
    const release = holdUpdates(); // no auto-update reload while Claude drives the browser
    let alive = true;
    let online = false;
    (async () => {
      while (alive) {
        try {
          if (!online) {
            // One quick heartbeat so the banner and Claude's browser_status say "connected" at once.
            await api('POST', '/api/browser/session', { active: true }, ctrl.signal);
            online = true;
            if (alive) setPhase('waiting');
          }
          const next = await api<{ command: unknown }>('GET', `/api/browser/next?wait=${LONG_POLL_S}`, undefined, ctrl.signal);
          if (!alive) break;
          setPhase('waiting');
          if (!next.command) continue;
          const parsed = parseCommand(next.command);
          let id: string | undefined;
          let result: BrowserResult;
          if ('cmd' in parsed) {
            id = parsed.cmd.id;
            setPhase('running');
            setDoing(describeCommand(parsed.cmd));
            try {
              result = await execute(parsed.cmd);
            } catch (e) {
              result = { ok: false, error: e instanceof Error ? e.message : 'The phone failed to run it.' };
            }
            setCount((n) => n + 1);
          } else {
            id = parsed.id;
            result = { ok: false, error: parsed.error };
          }
          if (id && alive) await api('POST', `/api/browser/results/${encodeURIComponent(id)}`, result, ctrl.signal);
          if (alive) setPhase('waiting');
        } catch (e) {
          if (!alive) break;
          if (e instanceof HttpError && e.status === 401) {
            setPhase('stopped');
            setDoing('This workspace key no longer works. Open Pulse again.');
            break;
          }
          online = false;
          setPhase('offline');
          await sleep(RETRY_MS);
        }
      }
    })();
    return () => {
      alive = false;
      release();
      ctrl.abort();
      // Tell the server now, so Claude is told the phone stopped instead of waiting for the heartbeat to lapse.
      void api('POST', '/api/browser/session', { active: false }, new AbortController().signal).catch(() => undefined);
    };
  }, [execute]);

  const stop = () => {
    setPhase('stopped');
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };

  const onMessage = (e: WebViewMessageEvent) => {
    const msg = parsePageMessage(e.nativeEvent.data);
    if (!msg) return;
    const waiter = pageWaiters.current.get(msg.id);
    if (!waiter) return;
    pageWaiters.current.delete(msg.id);
    const { id: _id, ...result } = msg;
    waiter(result);
  };

  const onNav = (s: WebViewNavigation) => {
    nav.current = { url: safeUrl(s.url), title: s.title ?? '', canGoBack: s.canGoBack };
  };

  const onLoadEnd = () => {
    const waiters = loadWaiters.current;
    loadWaiters.current = [];
    waiters.forEach((fn) => fn());
  };

  const statusText =
    phase === 'connecting'
      ? 'Connecting to Pulse…'
      : phase === 'offline'
        ? 'Reconnecting…'
        : phase === 'running'
          ? doing
          : phase === 'stopped'
            ? doing || 'Stopped'
            : count
              ? `Waiting for Claude · last: ${doing}`
              : 'Waiting for Claude…';

  return (
    <View style={[styles.root, { paddingTop: insets.top }]} testID="browser-control">
      <View style={styles.banner} accessibilityRole="alert">
        <View style={styles.bannerText}>
          <View style={styles.row}>
            <View style={[styles.dot, phase === 'running' && styles.dotLive]} />
            <Text style={styles.title}>Claude is controlling this browser</Text>
          </View>
          <Text style={styles.status} numberOfLines={2} testID="browser-control-status">
            {statusText}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop Claude"
          onPress={stop}
          hitSlop={10}
          style={({ pressed }) => [styles.stop, pressed && styles.pressed]}
          testID="browser-control-stop"
        >
          <Ionicons name="stop-circle" size={18} color={colors.white} />
          <Text style={styles.stopText}>Stop</Text>
        </Pressable>
      </View>
      <View ref={shotRef} collapsable={false} style={styles.body} onLayout={onLayout}>
        <WebView
          ref={webRef}
          testID="browser-control-webview"
          source={START_SOURCE}
          incognito={false}
          userAgent={UA_ANDROID}
          javaScriptEnabled
          domStorageEnabled
          textZoom={100}
          setSupportMultipleWindows={false}
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={(req) => allowedUrl(req.url)}
          allowFileAccess={false}
          style={styles.web}
          onNavigationStateChange={onNav}
          onLoadEnd={onLoadEnd}
          onMessage={onMessage}
        />
      </View>
      <View style={{ height: insets.bottom, backgroundColor: colors.card }} />
    </View>
  );
}

/** The screen. Android only: elsewhere (or without the native modules) it says so. */
export function BrowserControlScreen() {
  const native = loadNative();
  if (!native) return <Unavailable />;
  return <Controller native={native} />;
}

function Unavailable() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
      <Text style={styles.title}>Not available in this version of the app</Text>
      <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))} style={styles.stop}>
        <Text style={styles.stopText}>Back</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: '#3a1030',
    borderBottomWidth: 2,
    borderBottomColor: colors.accent2,
  },
  bannerText: { flex: 1, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.warn },
  dotLive: { backgroundColor: colors.danger },
  title: { color: colors.text, fontSize: 15, fontWeight: '800' },
  status: { color: colors.textDim, fontSize: 13 },
  stop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
  },
  stopText: { color: colors.white, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.7 },
  body: { flex: 1, backgroundColor: colors.bg },
  web: { flex: 1, backgroundColor: colors.bg },
});
