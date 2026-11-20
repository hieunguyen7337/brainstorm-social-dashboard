import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Animated, Platform, StyleSheet, Text, View } from 'react-native';

import { STAGE_LABEL } from '@/src/config';
import { fmtCompact, fmtInt } from '@/src/format';
import { colors, withAlpha } from '@/src/theme';
import { AnimatedNumber } from '@/src/ui';
import type { Counters } from './queueModel';

type IconName = ComponentProps<typeof Ionicons>['name'];

const STATS: readonly { key: keyof Counters; label: string; icon: IconName; color: string }[] = [
  { key: 'views', label: 'Views', icon: 'eye-outline', color: colors.info },
  { key: 'engagements', label: 'Engagements', icon: 'heart-outline', color: colors.accent2 },
  { key: 'clicks', label: 'Clicks', icon: 'hand-left-outline', color: colors.warn },
  { key: 'conversions', label: STAGE_LABEL.conversions, icon: 'cart-outline', color: colors.success },
];

/** How long the "+N" chip stays after a counter grew. */
const DELTA_MS = 3000;
const native = Platform.OS !== 'web';

/** Full digits up to 99,999 (so +1 is visible), compact beyond so four columns never overflow. */
const fmtStat = (n: number): string => (n >= 100_000 ? fmtCompact(n) : fmtInt(n));

/**
 * The 4-up live counters of a published card. Each number tweens to its new value and flashes green while it
 * grows (AnimatedNumber), and a small "+N" chip replaces the icon for ~3 s whenever it rose since the previous
 * poll. The previous value is tracked in a ref inside each column, so a card that just mounted never shows a chip.
 */
export function LiveStats({ counters }: { counters: Counters }) {
  return (
    <View style={styles.panel}>
      {STATS.map((s, i) => (
        <Stat key={s.key} label={s.label} icon={s.icon} color={s.color} value={counters[s.key]} divider={i > 0} />
      ))}
    </View>
  );
}

function Stat({
  label,
  icon,
  color,
  value,
  divider,
}: {
  label: string;
  icon: IconName;
  color: string;
  value: number;
  divider: boolean;
}) {
  const previous = useRef(value);
  const chipShown = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pop = useRef(new Animated.Value(0)).current;
  const [delta, setDelta] = useState(0);

  useEffect(() => {
    const diff = value - previous.current;
    previous.current = value;
    if (diff <= 0) return;
    // Growth while the chip is still up adds to it instead of replacing it.
    setDelta((d) => (chipShown.current ? d : 0) + diff);
    chipShown.current = true;
    Animated.timing(pop, { toValue: 1, duration: 180, useNativeDriver: native }).start();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      Animated.timing(pop, { toValue: 0, duration: 300, useNativeDriver: native }).start(({ finished }) => {
        if (!finished) return;
        chipShown.current = false;
        setDelta(0);
      });
    }, DELTA_MS);
  }, [value, pop]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      pop.stopAnimation();
    },
    [pop],
  );

  return (
    <View
      style={[styles.cell, divider && styles.divider]}
      accessible
      accessibilityLabel={`${label}: ${fmtInt(value)}`}
    >
      <View style={styles.top}>
        <Animated.View style={{ opacity: pop.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}>
          <Ionicons name={icon} size={14} color={color} />
        </Animated.View>
        {delta > 0 ? (
          <Animated.View
            style={[
              styles.chip,
              { opacity: pop, transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }] },
            ]}
          >
            <Text style={styles.chipText} numberOfLines={1}>{`+${fmtCompact(delta)}`}</Text>
          </Animated.View>
        ) : null}
      </View>
      <AnimatedNumber value={value} format={fmtStat} style={styles.value} />
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
  },
  cell: { flex: 1, minWidth: 0, alignItems: 'center', gap: 3, paddingHorizontal: 2 },
  divider: { borderLeftWidth: 1, borderLeftColor: colors.border },
  top: { height: 16, alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: 18, fontWeight: '800', letterSpacing: -0.3, color: colors.text },
  label: { fontSize: 10.5, fontWeight: '600', color: colors.textMute },
  chip: {
    position: 'absolute',
    height: 16,
    paddingHorizontal: 6,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.success, 0.18),
    borderWidth: 1,
    borderColor: withAlpha(colors.success, 0.55),
  },
  chipText: { fontSize: 10.5, fontWeight: '800', color: colors.success, fontVariant: ['tabular-nums'] },
});
