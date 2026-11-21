/**
 * Auto-post to LinkedIn (Android): a full-screen sheet with a WebView on linkedin.com that publishes the post's text
 * through the person's own signed-in session. The web build uses LiPostSheet.web.tsx. Same design as IgPostSheet.
 *
 * The WebView is the same kind as the "Sign in and read my numbers" sheet (autoRead): not incognito, the same user
 * agent, so Android's shared cookie store means a person who signed in there is already signed in here. Flow:
 *   1. open https://www.linkedin.com/feed/ and ask the page every LI_PROBE_MS whether it is signed in (booleans only);
 *   2. signed out (LinkedIn sends /feed/ to its sign-in page): show the page so the person signs in, keep asking;
 *   3. signed in on www.linkedin.com: cover the page and send the posting script (logic.ts);
 *   4. the script answers once: posted (with the share URN when LinkedIn returned one) or failed (stage + HTTP status
 *      + a short redacted error), or LI_POST_TIMEOUT_MS.
 * The person already confirmed "Post to LinkedIn now?" before this sheet opens.
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

import {
  buildLiPostScript,
  LI_HOME_URL,
  LI_POST_TIMEOUT_MS,
  LI_PROBE_MS,
  LI_STATE_PROBE_JS,
  liPostUrl,
  liTimeoutFailure,
  parseLiMessage,
  type LiFailure,
} from './logic';

export type LiPostOutcome =
  | { ok: true; url: string | null }
  | LiFailure
  /** The person closed the sheet; `whilePosting` when the post may still have gone through. */
  | { ok: null; whilePosting: boolean };

export interface LiPostSheetProps {
  text: string;
  onDone: (outcome: LiPostOutcome) => void;
}

/** True when this APK has the WebView the auto-post needs. */
export function liAutoPostAvailable(): boolean {
  return loadNative() !== null;
}

type Phase = 'opening' | 'login' | 'posting';

const PHASE_TEXT: Record<Phase, string> = {
  opening: 'Opening LinkedIn…',
  login: 'Sign in to LinkedIn, then Pulse posts for you.',
  posting: 'Posting to LinkedIn…',
};

/** Only web pages load in the sheet; app deep links (linkedin://, intent://) are dropped. */
const allowWebUrl = (req: { url: string }) => /^(https?:\/\/|about:blank)/i.test(req.url);

function failed(stage: string): LiFailure {
  return { ok: false, stage, status: 0, firstStatus: null, message: null, firstMessage: null };
}

function Sheet({ text, onDone }: LiPostSheetProps) {
  const native = loadNative();
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebViewRef | null>(null);
  const [phase, setPhase] = useState<Phase>('opening');
  const [source, setSource] = useState({ uri: LI_HOME_URL });
  const started = useRef(false);
  const finished = useRef(false);
  const movedHome = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const finish = (outcome: LiPostOutcome) => {
    if (finished.current) return;
    finished.current = true;
    doneRef.current(outcome);
  };

  // Ask the page whether it is signed in until the post starts.
  useEffect(() => {
    if (phase === 'posting') return;
    const t = setInterval(() => webRef.current?.injectJavaScript(LI_STATE_PROBE_JS), LI_PROBE_MS);
    return () => clearInterval(t);
  }, [phase]);

  // A post that never answers ends as a timeout (it may still have gone through: the text says to check).
  useEffect(() => {
    if (phase !== 'posting') return;
    const t = setTimeout(() => finish(liTimeoutFailure()), LI_POST_TIMEOUT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const startPosting = () => {
    const web = webRef.current;
    if (!web || started.current) return;
    started.current = true;
    setPhase('posting');
    try {
      web.injectJavaScript(buildLiPostScript(text));
    } catch {
      finish(failed('script'));
    }
  };

  const onMessage = (data: string) => {
    const m = parseLiMessage(data);
    if (!m || finished.current) return;
    if (m.kind === 'result') {
      if (!started.current) return; // only the script we sent can answer
      finish(m.ok ? { ok: true, url: liPostUrl(m.urn) } : m);
      return;
    }
    if (started.current || !m.onLi) return;
    if (!m.signedIn) {
      setPhase('login');
      return;
    }
    if (!m.settled) {
      // Signed in but not on www.linkedin.com (the post is a same-origin request there): go to the feed first, once.
      if (!movedHome.current) {
        movedHome.current = true;
        setPhase('opening');
        setSource({ uri: `${LI_HOME_URL}?pulse=1` });
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
      <View style={[styles.root, { paddingTop: insets.top }]} testID="li-post-sheet">
        <View style={styles.header}>
          <Text style={styles.headline} accessibilityRole="header">
            Posting to LinkedIn from your own account. Pulse never sees your password.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={close}
            hitSlop={8}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            testID="li-post-close"
          >
            <Ionicons name="close" size={18} color={colors.text} />
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        <View style={styles.body}>
          <WebView
            ref={webRef}
            testID="li-post-webview"
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
              if (!started.current) webRef.current?.injectJavaScript(LI_STATE_PROBE_JS);
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

export function LiPostSheet(props: LiPostSheetProps) {
  return (
    <Boundary onFail={() => props.onDone(failed('webview'))}>
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
