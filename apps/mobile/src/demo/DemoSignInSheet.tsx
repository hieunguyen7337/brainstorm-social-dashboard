/**
 * The demo sign-in (docs/REAL.md, "Demo workspaces"): a full-screen, platform-coloured fake sign-in page for the demo
 * workspace. It is pure React Native, so it works on web, iOS, Android and Expo Go, and it never opens a WebView, touches the
 * vault or contacts the platform. Sign in -> a three-line "Reading your numbers" checklist (about three seconds) while the
 * server's `POST /api/connections/{platform}/demo` connects the platform -> `onDone` with what was "read".
 *
 * The login shown is static text styled like fields (never a TextInput), so no browser or password manager offers to save it.
 * The stage logic is `./logic.ts` (pure, tested); this file only draws it and runs the timer and the request.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useReducer, useRef } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ApiError } from '@/src/api';
import { colors, onPlatformColor, platformMeta, radius, space, type as t, withAlpha } from '@/src/theme';
import type { DemoSignInResult, Platform } from '@/src/types';
import { Badge, Button, PlatformBadge } from '@/src/ui';
import { checklist, demoEmail, demoHandle, initialState, reduce, STEP_MS, type ChecklistLine } from './logic';

/** How long the finished checklist (with its numbers) stays on screen before the sheet hands the result back. */
const DONE_HOLD_MS = 700;

export interface DemoSignInSheetProps {
  platform: Platform;
  brand: string;
  /** The person closed the sheet (X, or the Android back button). The caller should refresh: the server may already be connected. */
  onClose: () => void;
  /** The sign-in finished: the server connected the platform and these are the synthetic numbers it "read". */
  onDone: (result: DemoSignInResult) => void;
}

const messageOf = (e: unknown): string =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.';

export function DemoSignInSheet({ platform, brand, onClose, onDone }: DemoSignInSheetProps) {
  const meta = platformMeta[platform];
  const insets = useSafeAreaInsets();
  const [state, dispatch] = useReducer(reduce, initialState);
  const alive = useRef(true);
  const finished = useRef(false);
  // The parent passes a fresh closure on every render: keep the latest in a ref so a re-render never restarts the hold timer.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // One line of the checklist per STEP_MS while reading; a new attempt starts a new timer, and a stale tick is ignored anyway.
  const { stage, attempt, result } = state;
  useEffect(() => {
    if (stage !== 'reading') return;
    const timer = setInterval(() => dispatch({ type: 'TICK', attempt }), STEP_MS);
    return () => clearInterval(timer);
  }, [stage, attempt]);

  // Finished: hold the completed checklist a moment, then hand the result back (once).
  useEffect(() => {
    if (stage !== 'done' || !result || finished.current) return;
    const timer = setTimeout(() => {
      if (!alive.current || finished.current) return;
      finished.current = true;
      onDoneRef.current(result);
    }, DONE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [stage, result]);

  const signIn = () => {
    const next = attempt + 1; // the attempt SIGN_IN is about to start: a late reply of an older one is ignored
    dispatch({ type: 'SIGN_IN' });
    api
      .demoSignIn(platform)
      .then((r) => alive.current && dispatch({ type: 'RESULT', attempt: next, result: r }))
      .catch((e: unknown) => alive.current && dispatch({ type: 'FAIL', attempt: next, message: messageOf(e) }));
  };

  const retry = () => {
    dispatch({ type: 'RETRY' });
    signIn();
  };

  const lines = checklist(state);
  const onBrand = onPlatformColor(platform);

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.root} testID="demo-signin">
        <View style={[styles.header, { backgroundColor: meta.color, paddingTop: insets.top + space.md }]}>
          <PlatformBadge platform={platform} size={36} solid style={styles.headBadge} />
          <Text style={[styles.headTitle, { color: onBrand }]} numberOfLines={1}>
            Sign in to {meta.label}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={10}
            onPress={onClose}
            style={styles.close}
            testID="demo-signin-close"
          >
            <Ionicons name="close" size={24} color={onBrand} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xl }]} keyboardShouldPersistTaps="handled">
          <View style={styles.banner} accessibilityRole="alert">
            <Badge label="DEMO" tone="warn" icon="flask-outline" />
            <Text style={[t.small, styles.bannerText]}>
              Not a real account. Nothing is sent to {meta.label}, and the numbers Pulse shows afterwards are synthetic.
            </Text>
          </View>

          {stage === 'signin' || stage === 'error' ? (
            <>
              <StaticField label="Email or username" value={demoEmail(brand)} />
              <StaticField label="Password" value="••••••••" />
              <Text style={t.small}>
                {`Demo account ${demoHandle(platform, brand)}. Tap Sign in and Pulse will read its (synthetic) followers, views and engagement.`}
              </Text>
              {stage === 'error' ? (
                <View style={styles.error} accessibilityRole="alert">
                  <Ionicons name="alert-circle" size={16} color={colors.danger} />
                  <Text style={[t.small, styles.errorText]}>{state.error}</Text>
                </View>
              ) : null}
              <Button
                full
                title={stage === 'error' ? 'Try again' : 'Sign in'}
                icon="log-in-outline"
                onPress={stage === 'error' ? retry : signIn}
              />
            </>
          ) : (
            <View style={styles.reading} testID="demo-signin-reading">
              <Text style={t.h3}>Reading your numbers</Text>
              {lines.map((line) => (
                <Line key={line.key} line={line} />
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** A field drawn like a text input but made of plain Text: nothing here can be typed into or saved by a password manager. */
function StaticField({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={t.label}>{label}</Text>
      <View style={styles.input} accessible accessibilityLabel={`${label}: ${value} (demo, prefilled)`}>
        <Text style={t.body}>{value}</Text>
      </View>
    </View>
  );
}

function Line({ line }: { line: ChecklistLine }) {
  return (
    <View style={styles.line} accessible accessibilityLabel={`${line.label}: ${line.status === 'done' ? (line.value ?? 'done') : line.status === 'active' ? 'reading' : 'waiting'}`}>
      <View style={styles.lineIcon}>
        {line.status === 'done' ? (
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
        ) : line.status === 'active' ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Ionicons name="ellipse-outline" size={22} color={colors.textMute} />
        )}
      </View>
      <Text style={[styles.lineLabel, line.status === 'pending' && styles.linePending]}>{line.label}</Text>
      {line.value ? <Text style={styles.lineValue}>{line.value}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.lg },
  headBadge: { backgroundColor: 'rgba(255,255,255,0.18)' },
  headTitle: { flex: 1, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.lg, gap: space.lg, maxWidth: 520, width: '100%', alignSelf: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: withAlpha(colors.warn, 0.4),
    backgroundColor: withAlpha(colors.warn, 0.08),
  },
  bannerText: { flex: 1, minWidth: 0 },
  field: { gap: 6 },
  input: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardHi,
  },
  error: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  errorText: { flex: 1, minWidth: 0, color: colors.danger },
  reading: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 32 },
  lineIcon: { width: 24, alignItems: 'center' },
  lineLabel: { flex: 1, fontSize: 15, color: colors.text },
  linePending: { color: colors.textMute },
  lineValue: { fontSize: 15, fontWeight: '700', color: colors.text },
});
