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
 * The sheet is a full-screen modal with an incognito WebView on the platform's login page. After the person signs in it
 * opens the page with their numbers and reads them with a script it injects (never cookies, tokens or page HTML); if that
 * finds nothing within 12 s it captures the WebView as a JPEG and sends it to `readScreenshot`. `onResult` gets a
 * `ScreenshotRead` plus `source: 'device'`.
 *
 * OTA safety: the installed 1.0.0 APK has neither native module. Both libraries throw while being imported when their
 * native side is missing, and Metro reports an exception thrown by a lazy `require` as a FATAL error (it does not reach a
 * try/catch). So the native modules are probed first (`TurboModuleRegistry.get` returns null instead of throwing), and the
 * JS packages are required only when both are present. Nothing here imports them at the top level.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  NativeModules,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TurboModuleRegistry,
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
  SESSION_RESET_STEP_MS,
  UA_ANDROID,
  UA_IOS,
} from './config';
import { AutoReadRunner, type RunnerStatus } from './runner';
import { AUTO_READ_FAILED, type AutoReadSheetProps } from './types';

export { AUTO_READ_FAILED } from './types';
export type { AutoReadSheetProps, DeviceRead, ReadPost, ScreenshotRead } from './types';

// ---- native modules (loaded at call time, never at the top level) --------------------------------------------------------

type WebViewModule = typeof import('react-native-webview');
type ViewShotModule = typeof import('react-native-view-shot');
interface NativeBits {
  WebView: WebViewModule['WebView'];
  captureRef: ViewShotModule['captureRef'];
}

/** `TurboModuleRegistry.get` returns null (it never throws) for a module that is not in the native binary. */
function nativeModulePresent(name: string): boolean {
  try {
    return TurboModuleRegistry.get(name) != null || (NativeModules as Record<string, unknown>)[name] != null;
  } catch {
    return false;
  }
}

let loaded: NativeBits | null | undefined;

/** Both native modules, or null. Probes the native side first, then requires the JS packages (see the file comment). */
function loadNative(): NativeBits | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (Platform.OS === 'web') return loaded;
  // react-native-view-shot registers 'RNViewShot' and react-native-webview 'RNCWebViewModule' (both TurboModule names).
  if (!nativeModulePresent('RNViewShot') || !nativeModulePresent('RNCWebViewModule')) return loaded;
  try {
    const { WebView } = require('react-native-webview') as WebViewModule;
    const { captureRef } = require('react-native-view-shot') as ViewShotModule;
    if (WebView && typeof captureRef === 'function') loaded = { WebView, captureRef };
  } catch {
    loaded = null;
  }
  return loaded;
}

/** True only on native when both native modules are present and load. Cheap: safe to call on every render. */
export function autoReadAvailable(): boolean {
  return Platform.OS !== 'web' && loadNative() !== null;
}

// ---- the sheet --------------------------------------------------------------------------------------------------------

const STATUS_TEXT: Record<RunnerStatus, string> = {
  anon: 'Checking your public profile…',
  login: 'Sign in, then Pulse reads your numbers for you.',
  reading: 'Reading your numbers…',
  capturing: 'Capturing your page…',
  claude: 'Reading your page with Claude…',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Only web pages load inside the sheet; app deep links (instagram://, intent://) are dropped instead of opened. */
const allowWebUrl = (req: { url: string }) => /^(https?:\/\/|about:blank)/i.test(req.url);

type WebViewRef = InstanceType<WebViewModule['WebView']>;

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
  const [incognito, setIncognito] = useState(true);
  const webRef = useRef<WebViewRef | null>(null);
  const webMounted = useRef(false);
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

  /**
   * Android's `incognito` clears cookies when the flag is APPLIED, not when the WebView goes away, so the sign-in would
   * stay in the app's cookie store until the next sheet opens. Flip the flag off and on again before reporting back.
   */
  const resetSession = useCallback(async (): Promise<void> => {
    if (Platform.OS !== 'android' || !webMounted.current) return; // no WebView, no sign-in to drop
    setIncognito(false);
    await sleep(SESSION_RESET_STEP_MS);
    setIncognito(true);
    await sleep(SESSION_RESET_STEP_MS);
  }, []);

  useEffect(() => {
    const r = new AutoReadRunner({
      platform,
      handle: latest.current.handle,
      loadUrl: (uri) => {
        webMounted.current = true;
        setSource({ uri });
      },
      inject: (js) => webRef.current?.injectJavaScript(js),
      capture,
      readScreenshot: (base64, mediaType) => latest.current.readScreenshot(base64, mediaType),
      emitResult: (read) => latest.current.onResult(read),
      emitClose: (reason) => latest.current.onClose(reason),
      onStatus: setStatus,
      clearSession: resetSession,
    });
    runner.current = r;
    r.start();
    return () => {
      r.dispose();
      if (runner.current === r) runner.current = null;
    };
  }, [platform, capture, resetSession]);

  const close = () => (runner.current ? runner.current.cancel() : latest.current.onClose());
  const onLayout = (e: LayoutChangeEvent) => {
    size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  };
  const busy = status !== 'login';
  const overlay = status === 'anon' || status === 'claude';

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

        <View style={styles.body}>
          {source ? (
            <View ref={shotRef} collapsable={false} style={StyleSheet.absoluteFill} onLayout={onLayout}>
              <WebView
                ref={webRef}
                testID="auto-read-webview"
                source={source}
                incognito={incognito}
                userAgent={Platform.OS === 'ios' ? UA_IOS : UA_ANDROID}
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
              {STATUS_TEXT[status]}
            </Text>
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
  footerText: { color: colors.textDim, fontSize: 13, textAlign: 'center' },
});
