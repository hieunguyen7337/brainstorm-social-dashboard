import { LinearGradient } from 'expo-linear-gradient';
import { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { colors, gradient } from '@/src/theme';
import { clamp01 } from './trendUtils';

/**
 * A "%" width that eases to `value` (0..1): from empty on mount when `animateOnMount`, and again whenever `value`
 * changes later (e.g. relevance re-scored after a refresh). `animateOnMount` and `delay` are read once, at mount.
 */
function useFillWidth(value: number, animateOnMount: boolean, delay: number) {
  const target = clamp01(value);
  const initial = useRef({ animate: animateOnMount, delay }).current;
  const fill = useRef(new Animated.Value(initial.animate ? 0 : target)).current;
  const mounted = useRef(false);

  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (first && !initial.animate) return undefined; // already drawn at its target
    const anim = Animated.timing(fill, {
      toValue: target,
      duration: first ? 700 : 450,
      delay: first ? initial.delay : 0,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // animates `width` (layout), which the native driver cannot do
    });
    anim.start();
    return () => anim.stop();
  }, [fill, initial, target]);

  return useMemo(() => fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }), [fill]);
}

interface BarProps {
  /** 0..1 */
  value: number;
  /** Ease in from empty when the row mounts (first screenful only: keeps long lists cheap). */
  animate?: boolean;
  /** Mount-time delay in ms, so a bar starts once its row has faded in. */
  delay?: number;
}

/** Relevance: rounded track with a violet -> pink fill. Fills the row's remaining width. */
export const RelevanceBar = memo(function RelevanceBar({ value, animate = true, delay = 0 }: BarProps) {
  const width = useFillWidth(value, animate, delay);
  return (
    <View style={styles.track} aria-hidden>
      <Animated.View style={[styles.fill, { width }]}>
        <LinearGradient
          colors={gradient.colors}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
});

/** Popularity ("Buzz"): a small label and a thin amber bar, fixed width so rows line up. */
export const BuzzBar = memo(function BuzzBar({ value, animate = true, delay = 0 }: BarProps) {
  const width = useFillWidth(value, animate, delay);
  return (
    <View style={styles.buzz} aria-hidden>
      <Text style={styles.buzzLabel}>Buzz</Text>
      <View style={styles.buzzTrack}>
        <Animated.View style={[styles.buzzFill, { width }]} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  track: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.cardHi, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, overflow: 'hidden' },
  buzz: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  buzzLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.textMute,
  },
  buzzTrack: { width: 44, height: 4, borderRadius: 2, backgroundColor: colors.cardHi, overflow: 'hidden' },
  buzzFill: { height: '100%', borderRadius: 2, backgroundColor: colors.warn },
});
