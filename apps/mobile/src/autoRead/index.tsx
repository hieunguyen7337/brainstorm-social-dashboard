/**
 * "Sign in and read my numbers" (docs/REAL.md, unit R3). Native build; `index.web.tsx` is the web stub with the same API.
 *
 *   import { AutoReadSheet, autoReadAvailable } from '@/src/autoRead';
 *
 *   {autoReadAvailable() ? <Button title="Sign in to read automatically" onPress={() => setOpen(true)} /> : null}
 *   <AutoReadSheet platform="instagram" visible={open} handle={knownHandle}
 *     onResult={(read) => { setOpen(false); prefillForm(read); }}      // read.source === 'device'
 *     onClose={(reason) => { setOpen(false); if (reason) showMessage(reason); }}  // reason only when reading gave up
 *     readScreenshot={(base64, mediaType) => api.readScreenshot(platform, base64, mediaType)} />
 *
 * The sheet is a full-screen modal with a WebView (not incognito: the sign-in stays in Android's cookie store, so a later
 * read opens signed in; `forgetSignIns()` drops it) on the platform's login page. After the person signs in it
 * opens the page with their numbers and reads them with a script it injects (never cookies, tokens or page HTML); if that
 * finds nothing within 12 s it captures the WebView as a JPEG and sends it to `readScreenshot`. `onResult` gets a
 * `ScreenshotRead` plus `source: 'device'`.
 *
 * `<AutoRefresh />` (refresh.tsx, mounted once in the tab layout) re-reads connected platforms in the background.
 *
 * OTA safety: see native.ts. Nothing here imports the native packages at the top level.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// Type-only imports: erased at build time, so they load nothing at runtime.
import type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';

import { colors, platformMeta, radius, space, withAlpha } from '@/src/theme';
import {
  CAPTURE_MAX_BYTES,
  CAPTURE_MAX_WIDTH,
  CAPTURE_QUALITY,
  CAPTURE_RETRY_QUALITY,
  CAPTURE_RETRY_WIDTH,
  CLICK_FACEBOOK_JS,
  IG_FB_LOGIN_URL,
  STALL_MS,
  UA_DESKTOP,
  UA_ANDROID,
  UA_IOS,
} from './config';
import { loadNative, type NativeBits, type WebViewRef } from './native';
import { AutoReadRunner, type RunnerStatus } from './runner';
import { AUTO_READ_FAILED, type AutoReadSheetProps } from './types';

export { AUTO_READ_FAILED } from './types';
export type { AutoReadSheetProps, DeviceRead, ReadPost, ScreenshotRead } from './types';
export { autoReadAvailable } from './native';
export { AutoRefresh, forgetSignIns } from './refresh';

// ---- the sheet --------------------------------------------------------------------------------------------------------

const STAYS_SIGNED_IN = 'Pulse stays signed in on this phone to refresh your numbers. Sign out in Settings.';

const STATUS_TEXT: Record<RunnerStatus, string> = {
  anon: 'Checking your public profile…',
  login: 'Sign in, then Pulse reads your numbers for you.',
  reading: 'Reading your numbers…',
  capturing: 'Capturing your page…',
  claude: 'Reading your page with Claude…',
};

/** Only web pages load inside the sheet; app deep links (instagram://, intent://) are dropped instead of opened. */
const allowWebUrl = (req: { url: string }) => /^(https?:\/\/|about:blank)/i.test(req.url);

function Sheet({
  platform,
  onClose,
  onResult,
  readScreenshot,
  handle,
  native,
}: AutoReadSheetProps & { native: NativeBits }) {
  const { WebView, captureRef } = native;
  const insets = useSafeAreaInsets();
  const meta = platformMeta[platform];
  const [status, setStatus] = useState<RunnerStatus>('login');
  const [source, setSource] = useState<{ uri: string } | null>(null);
  const webRef = useRef<WebViewRef | null>(null);
  const shotRef = useRef<View>(null);
  const size = useRef({ w: 0, h: 0 });
  const runner = useRef<AutoReadRunner | null>(null);
  const latest = useRef({ onClose, onResult, readScreenshot, handle });
  latest.current = { onClose, onResult, readScreenshot, handle };

  /** The WebView as a JPEG (base64, no data: prefix), width at most 1400 px; a second, smaller try if it is too large. */
  const capture = useCallback(async (): Promise<string> => {
    const { w, h } = size.current;
    if (!shotRef.current || w <= 0 || h <= 0) throw new Error('not ready');
    const ratio = PixelRatio.get();
    const tries = [
      { width: CAPTURE_MAX_WIDTH, quality: CAPTURE_QUALITY },
      { width: CAPTURE_RETRY_WIDTH, quality: CAPTURE_RETRY_QUALITY },
    ];
    for (const attempt of tries) {
      const scale = Math.min(1, attempt.width / (w * ratio));
      const outW = Math.max(1, Math.round(w * ratio * scale));
      const outH = Math.max(1, Math.round(h * ratio * scale));
      // view-shot resizes only when both sides are given: Android takes output pixels, iOS takes points.
      const dims =
        Platform.OS === 'ios'
          ? { width: Math.max(1, Math.round(outW / ratio)), height: Math.max(1, Math.round(outH / ratio)) }
          : { width: outW, height: outH };
      const raw = await captureRef(shotRef, { format: 'jpg', quality: attempt.quality, result: 'base64', ...dims });
      const base64 = typeof raw === 'string' ? raw.replace(/^data:[^,]*,/, '') : '';
      if (base64 && (base64.length * 3) / 4 <= CAPTURE_MAX_BYTES) return base64;
    }
    throw new Error('capture too large');
  }, [captureRef]);

  useEffect(() => {
    const r = new AutoReadRunner({
      platform,
      handle: latest.current.handle,
      loadUrl: (uri) => setSource({ uri }),
      inject: (js) => webRef.current?.injectJavaScript(js),
      capture,
      readScreenshot: (base64, mediaType) => latest.current.readScreenshot(base64, mediaType),
      emitResult: (read) => latest.current.onResult(read),
      emitClose: (reason) => latest.current.onClose(reason),
      onStatus: setStatus,
    });
    runner.current = r;
    r.start();
    return () => {
      r.dispose();
      if (runner.current === r) runner.current = null;
    };
  }, [platform, capture]);

  const close = () => (runner.current ? runner.current.cancel() : latest.current.onClose());
  const onLayout = (e: LayoutChangeEvent) => {
    size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  };
  // A page that never finishes loading looked like an empty dark sheet (LinkedIn, 2026-11-21): show that it is
  // loading, reload it once by itself after STALL_MS, and keep a Reload button in the footer while signing in.
  const [loading, setLoading] = useState(false);
  const reloadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!loading || !source) return;
    const t = setTimeout(() => {
      if (reloadedFor.current === source.uri) return;
      reloadedFor.current = source.uri;
      webRef.current?.reload();
    }, STALL_MS);
    return () => clearTimeout(t);
  }, [loading, source]);
  const reload = () => webRef.current?.reload();

  // Instagram accounts made through Facebook have no Instagram password: open the full-site sign-in (it has the
  // Facebook button the phone page lacks) and press that button for the person.
  const [viaFacebook, setViaFacebook] = useState(false);
  const pressedFacebook = useRef(false);
  const continueWithFacebook = () => {
    setViaFacebook(true);
    setSource({ uri: IG_FB_LOGIN_URL });
  };
  const onLoadEndFacebook = (url: string) => {
    if (viaFacebook && !pressedFacebook.current && url.startsWith('https://www.instagram.com/accounts/login')) {
      pressedFacebook.current = true;
      webRef.current?.injectJavaScript(CLICK_FACEBOOK_JS);
    }
  };

  const busy = status !== 'login' || loading;
  const overlay = status === 'anon' || status === 'claude';
  const footerText = status === 'login' && loading ? `Loading ${meta.label}…` : STATUS_TEXT[status];

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={close}
      testID="auto-read-sheet"
    >
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.headline} accessibilityRole="header">
            {`Sign in to ${meta.label}. Pulse only reads your numbers; it never sees your password and nothing is posted.`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={close}
            hitSlop={8}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            testID="auto-read-close"
          >
            <Ionicons name="close" size={18} color={colors.text} />
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>

        <Text style={styles.note} testID="auto-read-stays-signed-in">
          {STAYS_SIGNED_IN}
        </Text>

        {platform === 'instagram' && status === 'login' && !viaFacebook ? (
          <Pressable
            accessibilityRole="button"
            onPress={continueWithFacebook}
            style={({ pressed }) => [styles.facebook, pressed && styles.pressed]}
            testID="auto-read-facebook"
          >
            <Ionicons name="logo-facebook" size={18} color="#ffffff" />
            <Text style={styles.facebookText}>Signed up with Facebook? Continue with Facebook</Text>
          </Pressable>
        ) : null}

        <View style={styles.body}>
          {source ? (
            <View ref={shotRef} collapsable={false} style={StyleSheet.absoluteFill} onLayout={onLayout}>
              <WebView
                ref={webRef}
                testID="auto-read-webview"
                source={source}
                incognito={false}
                key={viaFacebook ? 'facebook' : 'phone'}
                userAgent={viaFacebook ? UA_DESKTOP : Platform.OS === 'ios' ? UA_IOS : UA_ANDROID}
                javaScriptEnabled
                domStorageEnabled
                cacheEnabled={false}
                textZoom={100}
                webviewDebuggingEnabled // TEMP 2026-11-21: inspect the Facebook route from the dev PC; remove after
                setSupportMultipleWindows={false}
                originWhitelist={['*']}
                onShouldStartLoadWithRequest={allowWebUrl}
                allowFileAccess={false}
                style={styles.web}
                onNavigationStateChange={(s: WebViewNavigation) => runner.current?.navigated(s.url, s.loading)}
                onLoadStart={() => setLoading(true)}
                onLoadProgress={(e) => {
                  if (e.nativeEvent.progress >= 1) setLoading(false);
                }}
                onLoadEnd={(e) => {
                  setLoading(false);
                  onLoadEndFacebook(e.nativeEvent.url);
                  runner.current?.loadEnded(e.nativeEvent.url);
                }}
                onMessage={(e: WebViewMessageEvent) => runner.current?.message(e.nativeEvent.data)}
                onError={(e) => runner.current?.loadFailed(e.nativeEvent.url)}
              />
            </View>
          ) : null}
          {overlay ? (
            <View style={styles.overlay} pointerEvents="auto">
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.overlayText}>{STATUS_TEXT[status]}</Text>
            </View>
          ) : null}
        </View>

        {!overlay ? (
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.sm) + space.xs }]}>
            {busy ? <ActivityIndicator size="small" color={colors.accent} /> : null}
            <Text style={styles.footerText} testID="auto-read-status">
              {footerText}
            </Text>
            {status === 'login' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reload page"
                onPress={reload}
                hitSlop={8}
                style={({ pressed }) => [styles.reload, pressed && styles.pressed]}
                testID="auto-read-reload"
              >
                <Ionicons name="refresh" size={16} color={colors.accent} />
                <Text style={styles.reloadText}>Reload</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/** A render failure inside the sheet (for example a WebView that cannot start) ends the read instead of crashing the app. */
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

/** Reports "can't read automatically" once when the native modules turn out to be missing. */
function Unavailable({ onClose }: { onClose: (reason?: string) => void }) {
  useEffect(() => {
    onClose(AUTO_READ_FAILED);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** Full-screen sign-in sheet. Renders nothing while `visible` is false and on web. */
export function AutoReadSheet(props: AutoReadSheetProps) {
  if (!props.visible || Platform.OS === 'web') return null;
  const native = loadNative();
  if (!native) return <Unavailable onClose={props.onClose} />;
  return (
    <Boundary onFail={() => props.onClose(AUTO_READ_FAILED)}>
      <Sheet {...props} native={native} />
    </Boundary>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headline: { flex: 1, color: colors.textDim, fontSize: 13, lineHeight: 18 },
  close: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.cardHi,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHi,
  },
  note: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
    backgroundColor: colors.card,
  },
  closeText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  body: { flex: 1, backgroundColor: colors.bg },
  web: { flex: 1, backgroundColor: colors.bg },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    backgroundColor: withAlpha(colors.bg, 0.86),
  },
  overlayText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingTop: space.sm,
    paddingHorizontal: space.lg,
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  footerText: { color: colors.textDim, fontSize: 13, textAlign: 'center', flexShrink: 1 },
  reload: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: space.sm },
  facebook: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: '#1877F2',
  },
  facebookText: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  reloadText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
});
