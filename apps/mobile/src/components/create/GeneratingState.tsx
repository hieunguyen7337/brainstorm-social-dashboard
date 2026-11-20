import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { colors, platformMeta, radius, space, withAlpha } from '@/src/theme';
import type { Platform as PlatformKey } from '@/src/types';
import { PlatformBadge } from '@/src/ui';

import { statusMessages } from './logic';

/** How often the status line moves on. */
const ROTATE_MS = 1800;
/** Skeleton cards shown at most (the rest is summarised in a line). */
const MAX_CARDS = 3;

/** Card with a soft highlight sweeping across it. One looping value, native-driven off the web. */
function Shimmer({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const [width, setWidth] = useState(0);
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 1500,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [sweep]);

  const band = Math.max(90, width * 0.55);
  const translateX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-band, width] });

  return (
    <View style={[styles.card, style]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {children}
      {width > 0 ? (
        <Animated.View
          style={[styles.band, { width: band, transform: [{ translateX }] }]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <LinearGradient
            colors={['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.07)', 'rgba(255, 255, 255, 0)']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

function Bar({ width, height = 11 }: { width: DimensionValue; height?: number }) {
  return <View style={{ width, height, borderRadius: 6, backgroundColor: colors.cardHi }} />;
}

/** A post-shaped placeholder for one platform; it lights up while that platform's line is on screen. */
function GhostCard({ platform, active }: { platform: PlatformKey; active: boolean }) {
  const color = platformMeta[platform].color;
  return (
    <Shimmer style={active ? { borderColor: withAlpha(color, 0.65) } : undefined}>
      <View style={styles.cardHead}>
        <PlatformBadge platform={platform} size={30} />
        <View style={styles.cardHeadText}>
          <Bar width="42%" height={12} />
          <Bar width="26%" height={9} />
        </View>
      </View>
      <Bar width="100%" />
      <Bar width="94%" />
      <Bar width="68%" />
    </Shimmer>
  );
}

/**
 * Shown under the Generate button while Claude writes (10-30 s): a rotating status line, and shimmering
 * platform-card skeletons. Presentational: the screen owns the request.
 */
export function GeneratingState({
  platforms,
  hasTrend,
  themeName,
}: {
  platforms: readonly PlatformKey[];
  hasTrend: boolean;
  themeName?: string | null;
}) {
  const platformKey = platforms.join('|');
  const messages = useMemo(
    () => statusMessages({ platforms, labelOf: (p) => platformMeta[p].label, hasTrend, themeName }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [platformKey, hasTrend, themeName],
  );

  const [tick, setTick] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  // Cross-fade to the next line every ~1.8 s.
  useEffect(() => {
    const native = Platform.OS !== 'web';
    const timer = setInterval(() => {
      Animated.timing(fade, { toValue: 0, duration: 160, useNativeDriver: native }).start(({ finished }) => {
        if (!finished) return;
        setTick((n) => n + 1);
        Animated.timing(fade, { toValue: 1, duration: 240, useNativeDriver: native }).start();
      });
    }, ROTATE_MS);
    return () => {
      clearInterval(timer);
      fade.stopAnimation();
    };
  }, [fade]);

  // The sparkle breathes.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const current = messages[tick % messages.length];
  const cards = platforms.slice(0, MAX_CARDS);
  const more = platforms.length - cards.length;
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1.18] });

  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <View style={styles.status}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <Ionicons name="sparkles" size={18} color={colors.accent} />
        </Animated.View>
        <Animated.Text style={[styles.statusText, { opacity: fade }]} numberOfLines={1}>
          {current.text}
        </Animated.Text>
      </View>
      {cards.map((p) => (
        <GhostCard key={p} platform={p} active={current.platform === p} />
      ))}
      {more > 0 ? <Text style={styles.more}>{`+ ${more} more on the way`}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 28 },
  statusText: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text, letterSpacing: -0.1 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: 10,
    overflow: 'hidden',
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: 4 },
  cardHeadText: { flex: 1, gap: 6 },
  band: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  more: { fontSize: 12.5, fontWeight: '600', color: colors.textMute, textAlign: 'center' },
});
