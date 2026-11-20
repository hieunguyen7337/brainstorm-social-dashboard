import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { colors, gradient, space, type as t } from '@/src/theme';
import type { AiUsage } from '@/src/types';
import { Badge, Skeleton } from '@/src/ui';

/**
 * "3 of 30 AI generations used" with a thin progress bar. Falls back to a "Template mode" badge and a one-line
 * explanation when Claude can't be used (not reachable, or the workspace allowance is spent).
 */
export function UsageLine({ usage, loading }: { usage: AiUsage | undefined; loading: boolean }) {
  const used = usage?.workspace_used ?? 0;
  const limit = usage?.workspace_limit ?? 0;
  const frac = limit > 0 ? Math.min(1, used / limit) : 0;

  // Hooks first: the bar eases to its new value after each generation refreshes the usage.
  const fill = useRef(new Animated.Value(frac)).current;
  useEffect(() => {
    Animated.timing(fill, { toValue: frac, duration: 450, useNativeDriver: false }).start();
  }, [fill, frac]);

  if (!usage) {
    // Usage is a nicety: while it loads show a stub, and if it failed show nothing at all.
    return loading ? <Skeleton width="52%" height={12} style={styles.stub} /> : null;
  }

  const spent = limit > 0 && used >= limit;
  const template = !usage.ai_available || spent;
  const explanation = !usage.ai_available
    ? "Claude isn't reachable right now, so you'll get smart templates."
    : `You've used all ${limit} AI generations, so you'll get smart templates.`;
  const barColors: readonly [string, string] = frac >= 0.9 ? [colors.warn, colors.danger] : gradient.colors;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Ionicons name="sparkles" size={14} color={template ? colors.textMute : colors.accent} />
        <Text style={styles.text}>{`${used} of ${limit} AI generations used`}</Text>
        {template ? <Badge label="Template mode" tone="warn" /> : null}
      </View>
      <View
        style={styles.track}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: limit, now: used }}
      >
        <Animated.View
          style={[styles.fill, { width: fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}
        >
          <LinearGradient colors={barColors} start={gradient.start} end={gradient.end} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </View>
      {template ? <Text style={[t.small, styles.explain]}>{explanation}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  stub: { marginVertical: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  text: { fontSize: 13, fontWeight: '600', color: colors.textDim, fontVariant: ['tabular-nums'] },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.cardHi, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, overflow: 'hidden' },
  explain: { color: colors.textMute },
});
