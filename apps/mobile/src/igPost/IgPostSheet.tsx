/**
 * Auto-post to Instagram (Android, behind IG_AUTOPOST): a full-screen sheet with a WebView on instagram.com that posts
 * the chosen photo with the caption through the person's own signed-in session. The web build uses IgPostSheet.web.tsx.
 *
 * The WebView is the same kind as the "Sign in and read my numbers" sheet (autoRead): not incognito, the same user
 * agent, so Android's shared cookie store means a person who signed in there is already signed in here. Flow:
 *   1. open https://www.instagram.com/ and ask the page every IG_PROBE_MS whether it is signed in (booleans only);
 *   2. signed out: show the page so the person signs in (the overlay is lifted), then keep asking;
 *   3. signed in on a settled page: cover the page, send the photo in chunks, then the posting script (logic.ts);
 *   4. the script answers once: posted (with the post's code) or failed (stage + HTTP status), or IG_POST_TIMEOUT_MS.
 * The person already confirmed "Post to Instagram now?" before this sheet opens.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// Type-only: erased at build time.
import type { WebViewMessageEvent } from 'react-native-webview';

import { UA_ANDROID } from '@/src/autoRead/config';
import { loadNative, type WebViewRef } from '@/src/autoRead/native';
import { colors, radius, space, withAlpha } from '@/src/theme';

import type { PostPhoto } from './device';
import {
  base64Size,
  buildIgPostScript,
  IG_HOME_URL,
  IG_POST_TIMEOUT_MS,
  IG_PROBE_MS,
  IG_STATE_PROBE_JS,
  igPostUrl,
  imageChunkScripts,
  newUploadId,
  parseIgMessage,
} from './logic';

export type IgPostOutcome =
  | { ok: true; url: string | null }
  | { ok: false; stage: string; status: number }
  /** The person closed the sheet; `whilePosting` when the post may still have gone through. */
  | { ok: null; whilePosting: boolean };

export interface IgPostSheetProps {
  photo: PostPhoto;
  caption: string;
  onDone: (outcome: IgPostOutcome) => void;
}

/** True when this APK has the WebView the auto-post needs. */
export function igAutoPostAvailable(): boolean {
  return loadNative() !== null;
}

type Phase = 'opening' | 'login' | 'posting';

const PHASE_TEXT: Record<Phase, string> = {
  opening: 'Opening Instagram…',
  login: 'Sign in to Instagram, then Pulse posts for you.',
  posting: 'Posting to Instagram…',
};

/** Only web pages load in the sheet; app deep links (instagram://, intent://) are dropped. */
const allowWebUrl = (req: { url: string }) => /^(https?:\/\/|about:blank)/i.test(req.url);

function Sheet({ photo, caption, onDone }: IgPostSheetProps) {
  const native = loadNative();
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebViewRef | null>(null);
  const [phase, setPhase] = useState<Phase>('opening');
  const [source, setSource] = useState({ uri: IG_HOME_URL });
  const started = useRef(false);
  const finished = useRef(false);
  const movedHome = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const finish = (outcome: IgPostOutcome) => {
    if (finished.current) return;
    finished.current = true;
    doneRef.current(outcome);
  };

  // Ask the page whether it is signed in until the post starts.
  useEffect(() => {
    if (phase === 'posting') return;
    const t = setInterval(() => webRef.current?.injectJavaScript(IG_STATE_PROBE_JS), IG_PROBE_MS);
    return () => clearInterval(t);
  }, [phase]);

  // A post that never answers ends as a timeout (it may still have gone through: the text says to check).
  useEffect(() => {
    if (phase !== 'posting') return;
    const t = setTimeout(() => finish({ ok: false, stage: 'timeout', status: 0 }), IG_POST_TIMEOUT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const startPosting = () => {
    const web = webRef.current;
    if (!web || started.current) return;
    started.current = true;
    setPhase('posting');
    try {
      const chunks = imageChunkScripts(photo.base64);
      const script = buildIgPostScript({
        uploadId: newUploadId(),
        width: photo.width,
        height: photo.height,
        bytes: base64Size(photo.base64),
        b64Length: photo.base64.length,
        caption,
      });
      for (const c of chunks) web.injectJavaScript(c);
      web.injectJavaScript(script);
    } catch {
      finish({ ok: false, stage: 'image', status: 0 });
    }
  };

  const onMessage = (data: string) => {
    const m = parseIgMessage(data);
    if (!m || finished.current) return;
    if (m.kind === 'result') {
      if (!started.current) return; // only the script we sent can answer
      finish(m.ok ? { ok: true, url: igPostUrl(m.code) } : { ok: false, stage: m.stage, status: m.status });
      return;
    }
    if (started.current || !m.onIg) return;
    if (!m.signedIn) {
      setPhase('login');
      return;
    }
    if (!m.settled) {
      // Signed in but on a page that navigates on by itself ("save your login info?"): go to the feed first, once.
      if (!movedHome.current) {
        movedHome.current = true;
        setPhase('opening');
        setSource({ uri: `${IG_HOME_URL}?pulse=1` });
      }
      return;
    }
    startPosting();
  };

  const close = () => finish({ ok: null, whilePosting: started.current });

  if (!native) return null;
  const { WebView } = native;
  const covered = phase !== 'login';

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={close}>
      <View style={[styles.root, { paddingTop: insets.top }]} testID="ig-post-sheet">
        <View style={styles.header}>
          <Text style={styles.headline} accessibilityRole="header">
            Posting to Instagram from your own account. Pulse never sees your password.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={close}
            hitSlop={8}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            testID="ig-post-close"
          >
            <Ionicons name="close" size={18} color={colors.text} />
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        <View style={styles.body}>
          <WebView
            ref={webRef}
            testID="ig-post-webview"
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
            onLoadEnd={() => {
              if (!started.current) webRef.current?.injectJavaScript(IG_STATE_PROBE_JS);
            }}
            onMessage={(e: WebViewMessageEvent) => onMessage(e.nativeEvent.data)}
          />
          {covered ? (
            <View style={styles.overlay} pointerEvents="auto">
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.overlayText}>{PHASE_TEXT[phase]}</Text>
            </View>
          ) : null}
        </View>
        {!covered ? (
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.sm) + space.xs }]}>
            <Text style={styles.footerText}>{PHASE_TEXT.login}</Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/** A WebView that cannot start ends the post as failed instead of crashing the app. */
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

export function IgPostSheet(props: IgPostSheetProps) {
  return (
    <Boundary onFail={() => props.onDone({ ok: false, stage: 'webview', status: 0 })}>
      <Sheet {...props} />
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
    backgroundColor: withAlpha(colors.bg, 0.94),
  },
  overlayText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  footer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: space.sm,
    paddingHorizontal: space.lg,
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  footerText: { color: colors.textDim, fontSize: 13, textAlign: 'center' },
});
