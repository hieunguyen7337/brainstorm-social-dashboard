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
 * The sheet is a full-screen modal with a WebView (not incognito: the sign-in stays in Android's cookie store, which
 * react-native-webview flushes to disk on every finished page, so a later read and an app restart open signed in;
 * `forgetSignIns()` drops it) on the platform's login page. The login the person types there is saved to the vault once
 * the sign-in worked (vault/capture.ts), and a later login page is filled and submitted by itself from the vault
 * (docs/VAULT.md). After the person signs in it
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
import { holdUpdates } from '@/src/updateOnLaunch';
import { makeTracer } from './trace';
import {
  CAPTURE_MAX_BYTES,
  CAPTURE_MAX_WIDTH,
  CAPTURE_QUALITY,
  CAPTURE_RETRY_QUALITY,
  CAPTURE_RETRY_WIDTH,
  STALL_MS,
  UA_ANDROID,
  UA_IOS,
} from './config';
import { useToast } from '@/src/ui/Toast';
import { fillScriptFor, saveLogin, useVaultStatus, vaultIndex, type FillStatus } from '@/src/vault';
import { buildCaptureScript, makeCaptureHolder, type CaptureHolder, type NavKind } from '@/src/vault/capture';
import { canFill } from '@/src/vault/fill';
import { HREF_POLL_JS, HREF_POLL_MS } from './hrefPoll';
import { loadNative, type NativeBits, type WebViewRef } from './native';
import { AutoReadRunner, type RunnerStatus } from './runner';
import {
  AUTO_FILL_DELAY_MS,
  FILL_CHECK_MS,
  FILLING_NOTICE,
  MAX_FILL_ATTEMPTS,
  NO_FORM_RETRY_MS,
  SAVE_FAILED_NOTICE,
  SAVED_NOTICE,
  fillNote,
  offerVaultFill,
  routeSheetMessage,
} from './vaultOffer';
import { AUTO_READ_FAILED, type AutoReadSheetProps } from './types';

export { AUTO_READ_FAILED } from './types';
export type { AutoReadSheetProps, DeviceRead, ReadPost, ScreenshotRead } from './types';
export { autoReadAvailable } from './native';
export { AutoRefresh, forgetSignIns } from './refresh';

// ---- the sheet --------------------------------------------------------------------------------------------------------

const STAYS_SIGNED_IN = 'Pulse stays signed in on this phone to refresh your numbers. Sign out in Settings.';
const STAYS_SIGNED_IN_VAULT =
  'Pulse stays signed in on this phone and saves the login you type here, encrypted on this phone, to sign you back in. Remove it in Settings > Saved logins.';

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
  const vault = useVaultStatus();
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  /** The WebView's own (native) URL: onNavigationStateChange / onLoadEnd only, never a page-reported href. */
  const nativeUrl = useRef<string | null>(null);
  /** Document loads seen (a new one starts with every native `loading: true`): one automatic fill per load. */
  const loadSeq = useRef(0);
  const filledFor = useRef<string | null>(null);
  /** Saved-login fills injected in this sheet session (at most MAX_FILL_ATTEMPTS). */
  const fills = useRef(0);
  const fillingRef = useRef(false);
  const [filling, setFilling] = useState(false);
  const [vaultNote, setVaultNote] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const capture = useRef<CaptureHolder | null>(null);
  const statusRef = useRef<RunnerStatus>('login');
  statusRef.current = status;
  const alive = useRef(true);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ onClose, onResult, readScreenshot, handle });
  latest.current = { onClose, onResult, readScreenshot, handle };

  /** The WebView as a JPEG (base64, no data: prefix), width at most 1400 px; a second, smaller try if it is too large. */
  const captureShot = useCallback(async (): Promise<string> => {
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
    const tr = makeTracer(platform);
    const release = holdUpdates();
    const r = new AutoReadRunner({
      platform,
      trace: tr.trace,
      handle: latest.current.handle,
      loadUrl: (uri) => setSource({ uri }),
      inject: (js) => webRef.current?.injectJavaScript(js),
      capture: captureShot,
      readScreenshot: (base64, mediaType) => latest.current.readScreenshot(base64, mediaType),
      emitResult: (read) => latest.current.onResult(read),
      emitClose: (reason) => latest.current.onClose(reason),
      onStatus: (s) => {
        statusRef.current = s;
        setStatus(s);
      },
    });
    runner.current = r;
    r.start();
    return () => {
      r.dispose();
      tr.stop();
      release();
      if (runner.current === r) runner.current = null;
    };
  }, [platform, captureShot]);

  // The login typed on the sheet, held in memory until the sign-in worked (vault/capture.ts). Never logged or traced.
  useEffect(() => {
    const holder = makeCaptureHolder({
      platform,
      save: async (u, p) => {
        // Keep the person's biometric choice when the login replaces one saved before; a new one asks for nothing.
        const bio = (await vaultIndex())[platform]?.bio === true;
        await saveLogin(platform, u, p, { bio });
      },
      onSaved: () => {
        toastRef.current.show(SAVED_NOTICE); // the toast outlives the sheet, which may close as the read finishes
        if (alive.current) setSavedNote(SAVED_NOTICE);
      },
      onSaveFailed: () => {
        if (alive.current) setSavedNote(SAVE_FAILED_NOTICE);
      },
    });
    capture.current = holder;
    return () => {
      holder.dispose();
      if (capture.current === holder) capture.current = null;
    };
  }, [platform]);

  // Close on a signed-in page reads first (the person thinks they are done); a second Close, or Close on the login page,
  // closes.
  const close = () => {
    const r = runner.current;
    if (!r) return latest.current.onClose();
    if (!r.readBeforeClose()) r.cancel();
  };
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

  // While waiting for the sign-in, ask the page where it really is (see hrefPoll.ts).
  useEffect(() => {
    if (status !== 'login' || !source) return;
    const t = setInterval(() => webRef.current?.injectJavaScript(HREF_POLL_JS), HREF_POLL_MS);
    return () => clearInterval(t);
  }, [status, source]);
  const clearCheck = () => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
    checkTimer.current = null;
  };
  useEffect(() => {
    if (status === 'login') return;
    setVaultNote(null);
    clearCheck();
  }, [status]);
  useEffect(
    () => () => {
      alive.current = false;
      clearCheck();
      if (autoTimer.current) clearTimeout(autoTimer.current);
      autoTimer.current = null;
    },
    [],
  );

  const onFill = (fs: FillStatus) => {
    if (fs !== 'partial') capture.current?.fillEnded();
    if (fs === 'partial') {
      runner.current?.noteVaultFill();
    } else if (fs === 'filled') {
      runner.current?.noteVaultFill();
      clearCheck();
      checkTimer.current = setTimeout(() => {
        checkTimer.current = null;
        if (statusRef.current === 'login' && canFill(platform, nativeUrl.current)) {
          setVaultNote(fillNote('failed', meta.label));
        }
      }, FILL_CHECK_MS);
    } else if (fs === 'no_form' && fills.current < MAX_FILL_ATTEMPTS) {
      // The form had not rendered yet: one more try on this page, still within the attempt cap.
      filledFor.current = null;
      scheduleAutoFill(NO_FORM_RETRY_MS);
    } else {
      setVaultNote(fillNote(fs, meta.label));
    }
  };

  /** True when the saved login may be typed into the page the WebView is natively on, right now. */
  const fillAllowed = (): boolean =>
    offerVaultFill(platform, {
      status: statusRef.current,
      hasLogin: !!vaultRef.current.saved[platform],
      url: nativeUrl.current,
      attempts: fills.current,
      dismissed: false,
    });

  const signInWithSaved = async () => {
    if (fillingRef.current || !fillAllowed()) return;
    fillingRef.current = true;
    setFilling(true);
    let script: string | null = null;
    try {
      script = await fillScriptFor(platform);
    } catch {
      script = null;
    }
    fillingRef.current = false;
    if (!alive.current) return;
    setFilling(false);
    if (!script) {
      setVaultNote(fillNote('unreadable', meta.label));
      return;
    }
    // Re-checked after the (possibly biometric) unlock: the page may have moved on meanwhile.
    if (!(fillAllowed() && webRef.current)) {
      script = null;
      return;
    }
    setVaultNote(null);
    fills.current += 1;
    capture.current?.fillStarted();
    webRef.current.injectJavaScript(script);
    script = null;
    runner.current?.noteVaultFill();
  };

  /** Fill the saved login by itself once the login page had a moment to render (no approval bar any more). */
  const scheduleAutoFill = (ms: number) => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      if (!alive.current || !fillAllowed()) return;
      const key = `${loadSeq.current} ${nativeUrl.current}`;
      if (filledFor.current === key) return;
      filledFor.current = key;
      void signInWithSaved();
    }, ms);
  };

  /** Every native navigation event: the only source of the URL the vault trusts. */
  const onNative = (url: string | null | undefined, kind: NavKind) => {
    if (kind === 'start') loadSeq.current += 1;
    if (typeof url === 'string') nativeUrl.current = url;
    capture.current?.native(url, kind);
    if (kind === 'start' || !canFill(platform, url) || !webRef.current) return;
    // Listen for the login the person types (only on the platform's own login form, only with a vault on this phone).
    if (vaultRef.current.available) webRef.current.injectJavaScript(buildCaptureScript(platform));
    if (vaultRef.current.saved[platform] && filledFor.current !== `${loadSeq.current} ${url}`) {
      scheduleAutoFill(AUTO_FILL_DELAY_MS);
    }
  };

  // The saved-login index loads after the first page may already be up: fill then.
  const hasSaved = !!vault.saved[platform];
  useEffect(() => {
    const url = nativeUrl.current;
    if (hasSaved && canFill(platform, url) && filledFor.current !== `${loadSeq.current} ${url}`) {
      scheduleAutoFill(AUTO_FILL_DELAY_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSaved, platform]);

  const onMessage = (data: unknown, sourceUrl: string | null | undefined) =>
    routeSheetMessage(data, sourceUrl, {
      capture: (msg, src) => {
        capture.current?.offer(msg, src);
      },
      fill: (f) => {
        if (f.platform === platform) onFill(f.status);
      },
      href: (href, src) => {
        capture.current?.pageHref(href, src);
        runner.current?.navigated(href, false);
      },
      runner: (raw) => runner.current?.message(raw),
    });

  const autoFilling = filling && status === 'login';
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
            {`Sign in to ${meta.label}. Pulse only reads your numbers. Pulse's servers and Claude never see your password, and nothing is posted.`}
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
          {vault.available ? STAYS_SIGNED_IN_VAULT : STAYS_SIGNED_IN}
        </Text>

        {autoFilling ? (
          <View style={styles.vaultBar} testID="auto-read-vault-filling">
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.vaultText}>{FILLING_NOTICE}</Text>
          </View>
        ) : null}
        {vaultNote && status === 'login' ? (
          <Text style={styles.vaultNote} testID="auto-read-vault-note">
            {vaultNote}
          </Text>
        ) : null}
        {savedNote ? (
          <Text style={styles.vaultNote} testID="auto-read-vault-saved">
            {savedNote}
          </Text>
        ) : null}

        <View style={styles.body}>
          {source ? (
            <View ref={shotRef} collapsable={false} style={StyleSheet.absoluteFill} onLayout={onLayout}>
              <WebView
                ref={webRef}
                testID="auto-read-webview"
                source={source}
                incognito={false}
                userAgent={Platform.OS === 'ios' ? UA_IOS : UA_ANDROID}
                javaScriptEnabled
                domStorageEnabled
                cacheEnabled={false}
                thirdPartyCookiesEnabled
                textZoom={100}
                setSupportMultipleWindows={false}
                originWhitelist={['*']}
                onShouldStartLoadWithRequest={allowWebUrl}
                allowFileAccess={false}
                style={styles.web}
                onNavigationStateChange={(s: WebViewNavigation) => {
                  runner.current?.navigated(s.url, s.loading);
                  onNative(s.url, s.loading ? 'start' : 'change');
                }}
                onLoadStart={() => setLoading(true)}
                onLoadProgress={(e) => {
                  if (e.nativeEvent.progress >= 1) setLoading(false);
                }}
                onLoadEnd={(e) => {
                  setLoading(false);
                  runner.current?.loadEnded(e.nativeEvent.url);
                  onNative(e.nativeEvent.url, 'end');
                }}
                onMessage={(e: WebViewMessageEvent) => onMessage(e.nativeEvent.data, e.nativeEvent.url)}
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
  vaultBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: colors.cardHi,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderHi,
  },
  vaultText: { flex: 1, minWidth: 160, color: colors.text, fontSize: 13, fontWeight: '600' },
  vaultNote: {
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
  reloadText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
});
