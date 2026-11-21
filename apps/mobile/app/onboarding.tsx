import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, router } from 'expo-router';
import { useState, type ComponentProps } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { APP_NAME } from '@/src/config';
import { autoReadAvailable } from '@/src/autoRead';
import { desktopTitleBarInset } from '@/src/desktop';
import { ConnectAccounts } from '@/src/components/connect/ConnectAccounts';
import { ROOM_GUEST_BRAND, useRoomJoin } from '@/src/components/room/roomStore';
import { useSession } from '@/src/session';
import { colors, radius, space, type as t, withAlpha } from '@/src/theme';
import { Badge, Button, Logo, TextField } from '@/src/ui';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** Android with the in-app reader leads with signing in; web and iPhone upload a screenshot. */
const AUTO_READ = Platform.OS === 'android' && autoReadAvailable();

const FEATURES: { icon: IconName; color: string; title: string; text: string }[] = [
  {
    icon: 'pie-chart',
    color: colors.accent,
    title: 'Your real numbers',
    text: AUTO_READ
      ? 'Sign in to your accounts inside Pulse and your numbers are read for you. Views, engagement and followers: only yours.'
      : 'Upload a screenshot of your profile or insights and Claude reads it. Views, engagement and followers: only yours.',
  },
  { icon: 'trending-up', color: colors.info, title: 'Real trends', text: 'Hacker News, Reddit and Google Trends, ranked for your brand.' },
  {
    icon: 'sparkles',
    color: colors.accent2,
    title: 'Posts written by Claude',
    text: 'One native post per platform. Share it from here and your numbers follow.',
  },
];

/**
 * First screen, two steps. 1 (brand): no sign-up, one tap creates an empty private workspace. 2 (connect): the person adds
 * their real numbers by screenshot or typing, or skips with "Later". Nothing on screen is sample data.
 */
export default function OnboardingScreen() {
  const { status, start, starting, error, networkError, mock } = useSession();
  const [brand, setBrand] = useState('');
  // Set at the tap, before the request: `start()` makes the session 'ready' before this screen re-renders, and a ready
  // session on this screen redirects to the dashboard, which would skip the connect step.
  const [connecting, setConnecting] = useState(false);
  // At least one account was saved in the connect step: "Later" becomes "Go to my dashboard".
  const [saved, setSaved] = useState(false);
  // Someone who scanned a room code but could not get a workspace (offline) lands here: keep their room in view.
  const room = useRoomJoin();
  const inRoom = room.pending && !!room.code;
  const insets = useSafeAreaInsets();

  if (status === 'ready' && !connecting) return <Redirect href="/dashboard" />;
  const connectStep = connecting && status === 'ready';

  const go = async () => {
    if (starting) return;
    setSaved(false);
    setConnecting(true);
    const ok = await start(brand || (inRoom ? ROOM_GUEST_BRAND : ''));
    if (!ok) setConnecting(false);
  };

  const finish = () => router.replace('/dashboard');

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* soft colour glows behind the hero */}
      <View pointerEvents="none" style={styles.glowWrap}>
        <View style={[styles.glow, styles.glowViolet]} />
        <View style={[styles.glow, styles.glowPink]} />
      </View>

      {/* Keyed by step: the connect step starts at the top, not at wherever the brand step was scrolled to. */}
      <ScrollView
        key={connectStep ? 'connect' : 'brand'}
        contentContainerStyle={[
          styles.scroll,
          connectStep && styles.scrollTop,
          { paddingTop: insets.top + desktopTitleBarInset() + space.xl, paddingBottom: connectStep ? space.xl : insets.bottom + space.xl },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.column}>
          <View style={styles.brandRow}>
            <Logo size={44} />
            <Text style={t.h2}>{APP_NAME}</Text>
            {mock ? <Badge label="Test build" tone="warn" icon="cloud-offline" /> : null}
            {inRoom ? <Badge label={`Room ${room.code}`} tone="accent" icon="people" /> : null}
          </View>

          {connectStep ? (
            <>
              <View style={styles.hero}>
                <Text style={t.h1} accessibilityRole="header">
                  Connect your real accounts
                </Text>
                <Text style={styles.sub}>
                  {AUTO_READ
                    ? 'Sign in to your accounts inside Pulse and your numbers are read for you, then kept up to date. You can also do this later in Settings.'
                    : 'Upload a screenshot of your profile or insights page and Claude reads the numbers. You can also do this later in Settings.'}
                </Text>
              </View>
              <ConnectAccounts onSaved={() => setSaved(true)} />
            </>
          ) : (
            <>
              <View style={styles.hero}>
                <Text style={t.hero}>
                  Your social media,{'\n'}
                  <Text style={styles.heroAccent}>on autopilot.</Text>
                </Text>
                <Text style={styles.sub}>
                  See what works, spot what is trending and let Claude write posts for every platform, all built on your
                  own real numbers.
                </Text>
              </View>

              <View style={styles.features}>
                {FEATURES.map((f) => (
                  <View key={f.title} style={styles.feature}>
                    <View style={[styles.featureIcon, { backgroundColor: withAlpha(f.color, 0.16) }]}>
                      <Ionicons name={f.icon} size={20} color={f.color} />
                    </View>
                    <View style={styles.featureText}>
                      <Text style={t.h3}>{f.title}</Text>
                      <Text style={t.small}>{f.text}</Text>
                    </View>
                  </View>
                ))}
              </View>

              <View style={styles.form}>
                <TextField
                  label="Your brand (optional)"
                  placeholder="Brew & Bloom"
                  value={brand}
                  onChangeText={setBrand}
                  maxLength={60}
                  autoCapitalize="words"
                  returnKeyType="go"
                  onSubmitEditing={() => void go()}
                  editable={!starting}
                />
                <Button
                  title={starting ? 'Creating your workspace…' : 'Start my workspace'}
                  icon={starting ? undefined : 'rocket'}
                  loading={starting}
                  onPress={() => void go()}
                  full
                />
                <Text style={[t.small, styles.center]}>
                  No sign-up. We create a private workspace with no data in it: every number comes from you.
                </Text>

                {error && !starting ? (
                  <View style={styles.errorCard} accessibilityRole="alert">
                    <View style={styles.errorHead}>
                      <Ionicons name="alert-circle" size={18} color={colors.danger} />
                      <Text style={[t.h3, { color: colors.danger }]}>
                        {networkError ? "Can't reach the server" : "Couldn't start your workspace"}
                      </Text>
                    </View>
                    <Text style={t.dim}>{error}</Text>
                    <View style={styles.errorActions}>
                      <Button title="Try again" variant="secondary" small icon="refresh" onPress={() => void go()} />
                    </View>
                  </View>
                ) : null}
              </View>
            </>
          )}
        </View>
      </ScrollView>

      {/* Outside the scroll view so "Later" is always in reach, however many accounts are open above it. */}
      {connectStep ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>
          <View style={styles.footerInner}>
            <Button
              title={saved ? 'Go to my dashboard' : 'Later'}
              variant={saved ? 'primary' : 'ghost'}
              icon={saved ? 'arrow-forward' : undefined}
              onPress={finish}
              full
            />
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  glowWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
  glow: { position: 'absolute', width: 40, height: 40, borderRadius: 20 },
  glowViolet: {
    top: 80,
    right: 30,
    backgroundColor: 'rgba(124, 92, 255, 0.28)',
    boxShadow: '0 0 160px 110px rgba(124, 92, 255, 0.28)',
  },
  glowPink: {
    bottom: 160,
    left: 10,
    backgroundColor: 'rgba(255, 92, 138, 0.16)',
    boxShadow: '0 0 160px 100px rgba(255, 92, 138, 0.16)',
  },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  // The connect step grows and shrinks as account panels open: pin it to the top instead of re-centring it each time.
  scrollTop: { justifyContent: 'flex-start' },
  column: { width: '100%', maxWidth: 480, gap: space.xl },
  brandRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md },
  hero: { gap: space.md },
  heroAccent: { color: colors.accent2 },
  sub: { ...t.dim, fontSize: 16, lineHeight: 24 },
  features: { gap: space.md },
  feature: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: withAlpha(colors.card, 0.85),
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
  },
  featureIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  featureText: { flex: 1, gap: 2 },
  form: { gap: space.md },
  center: { textAlign: 'center' },
  errorCard: {
    gap: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: withAlpha(colors.danger, 0.4),
    backgroundColor: withAlpha(colors.danger, 0.08),
    padding: space.md,
  },
  errorHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  errorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: 4 },
  footer: {
    alignItems: 'center',
    paddingTop: space.md,
    paddingHorizontal: space.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  footerInner: { width: '100%', maxWidth: 480 },
});
