import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { LIVE_PLATFORMS } from '@/src/platforms';
import { autoReadAvailable } from '@/src/autoRead';
import { useConnectSheet } from '@/src/components/connect/ConnectSheet';
import { colors, gradient, platformMeta, space, type as t, withAlpha } from '@/src/theme';
import { Button, Card, Chip, ChipRow } from '@/src/ui';

export const CONNECT_CTA_TITLE = 'Connect an account to see your real numbers';

/**
 * What a real workspace's Dashboard shows while no account is connected (docs/REAL.md): one large call to action instead
 * of charts. Every number on this screen comes from the person, so with nothing connected there is nothing to chart.
 * The button opens the connect dialog; the platform chips open it straight on that platform.
 */
export function ConnectCta({ style }: { style?: StyleProp<ViewStyle> }) {
  const { open } = useConnectSheet();
  return (
    <Card style={[styles.card, style]}>
      {/* A soft violet wash from the top, behind everything. */}
      <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
        <LinearGradient
          colors={[withAlpha(colors.accent, 0.16), withAlpha(colors.accent, 0)]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </View>

      <LinearGradient colors={gradient.colors} start={gradient.start} end={gradient.end} style={styles.icon}>
        <Ionicons name="stats-chart" size={28} color={colors.white} />
      </LinearGradient>

      <View style={styles.copy}>
        <Text style={styles.title} accessibilityRole="header">
          {CONNECT_CTA_TITLE}
        </Text>
        <Text style={[t.dim, styles.body]}>
          {Platform.OS === 'android' && autoReadAvailable()
            ? 'Sign in to your accounts inside Pulse and your numbers are read for you, then kept up to date. Everything on this dashboard comes from you.'
            : 'Connect your accounts and Pulse reads your numbers for you (in the Android app). No Android? Upload a screenshot instead. Everything on this dashboard comes from you.'}
        </Text>
      </View>

      <View style={styles.buttonWrap}>
        <Button title="Connect an account" icon="add" style={styles.button} onPress={() => open()} />
      </View>

      <View style={styles.platforms}>
        <Text style={t.label}>Or start with</Text>
        <ChipRow style={styles.chips}>
          {LIVE_PLATFORMS.map((p) => (
            <Chip key={p} small platform={p} label={platformMeta[p].label} onPress={() => open(p)} />
          ))}
        </ChipRow>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  // A centred column. When the board stretches the card to the row's height, the content stays in the middle.
  card: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    borderColor: withAlpha(colors.accent, 0.4),
  },
  icon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  copy: { alignItems: 'center', gap: space.sm, maxWidth: 520 },
  title: { ...t.h1, fontSize: 24, lineHeight: 30, textAlign: 'center' },
  body: { textAlign: 'center' },
  buttonWrap: { alignSelf: 'stretch', alignItems: 'center' },
  button: { width: '100%', maxWidth: 360 },
  platforms: { alignItems: 'center', gap: space.sm, maxWidth: 520 },
  chips: { justifyContent: 'center' },
});
