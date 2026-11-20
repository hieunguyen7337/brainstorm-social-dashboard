import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect } from 'expo-router';
import { useState, type ComponentProps } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { APP_NAME } from '@/src/config';
import { ROOM_GUEST_BRAND, useRoomJoin } from '@/src/components/room/roomStore';
import { useSession } from '@/src/session';
import { colors, radius, space, type as t, withAlpha } from '@/src/theme';
import { Badge, Button, Logo, TextField } from '@/src/ui';

type IconName = ComponentProps<typeof Ionicons>['name'];

const FEATURES: { icon: IconName; color: string; title: string; text: string }[] = [
  { icon: 'pie-chart', color: colors.accent, title: 'Live dashboard', text: 'Views by platform, a sales funnel and real clicks, updating as you watch.' },
  { icon: 'trending-up', color: colors.info, title: 'Real trends', text: 'Hacker News, Reddit and Google Trends, ranked for your brand.' },
  { icon: 'sparkles', color: colors.accent2, title: 'Posts written by Claude', text: 'One native post per platform. Publish it and watch the numbers grow.' },
];

/** First screen: no sign-up, one tap creates a seeded guest workspace. */
export default function OnboardingScreen() {
  const { status, start, startOfflineDemo, starting, error, networkError, mock } = useSession();
  const [brand, setBrand] = useState('');
  // Someone who scanned a room code but could not get a workspace (offline) lands here: keep their room in view.
  const room = useRoomJoin();
  const inRoom = room.pending && !!room.code;
  const insets = useSafeAreaInsets();

  if (status === 'ready') return <Redirect href="/dashboard" />;

  const go = () => {
    if (!starting) void start(brand || (inRoom ? ROOM_GUEST_BRAND : ''));
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* soft colour glows behind the hero */}
      <View pointerEvents="none" style={styles.glowWrap}>
        <View style={[styles.glow, styles.glowViolet]} />
        <View style={[styles.glow, styles.glowPink]} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.column}>
          <View style={styles.brandRow}>
            <Logo size={44} />
            <Text style={t.h2}>{APP_NAME}</Text>
            {mock ? <Badge label="Offline demo" tone="warn" icon="cloud-offline" /> : null}
            {inRoom ? <Badge label={`Room ${room.code}`} tone="accent" icon="people" /> : null}
          </View>

          <View style={styles.hero}>
            <Text style={t.hero}>
              Your social media,{'\n'}
              <Text style={styles.heroAccent}>on autopilot.</Text>
            </Text>
            <Text style={styles.sub}>
              See what works, spot what is trending and let Claude write posts for every platform. Try a live demo
              workspace in one tap.
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
              onSubmitEditing={go}
              editable={!starting}
            />
            <Button
              title={starting ? 'Seeding your workspace…' : 'Start my demo'}
              icon={starting ? undefined : 'rocket'}
              loading={starting}
              onPress={go}
              full
            />
            <Text style={[t.small, styles.center]}>
              No sign-up. We create a private guest workspace with 30 days of sample data.
            </Text>

            {error && !starting ? (
              <View style={styles.errorCard} accessibilityRole="alert">
                <View style={styles.errorHead}>
                  <Ionicons name="alert-circle" size={18} color={colors.danger} />
                  <Text style={[t.h3, { color: colors.danger }]}>
                    {networkError ? "Can't reach the server" : "Couldn't start the demo"}
                  </Text>
                </View>
                <Text style={t.dim}>{error}</Text>
                <View style={styles.errorActions}>
                  <Button title="Try again" variant="secondary" small icon="refresh" onPress={go} />
                  <Button
                    title="Use the offline demo"
                    variant="ghost"
                    small
                    onPress={() => void startOfflineDemo(brand)}
                  />
                </View>
              </View>
            ) : null}
          </View>
        </View>
      </ScrollView>
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
});
