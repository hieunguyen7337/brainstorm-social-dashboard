/**
 * Small pieces that make the dashboard feel alive without being noisy: a one-time staggered reveal, a pulsing
 * "live" dot, counters that flash only for genuine live increments, and a helper that keeps chart props
 * referentially stable across the 5 s polls.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { colors, radius, space, withAlpha } from '@/src/theme';
import { AnimatedNumber } from '@/src/ui';

const NATIVE = Platform.OS !== 'web';

/** Counters stay quiet (no green flash) this long after mount or after the data context changes. */
const SETTLE_MS = 1400;

/**
 * Returns the previous `value` while `key` is unchanged. Poll responses are always new objects; charts that key
 * their animations on prop identity would otherwise replay every 5 s.
 */
export function useStable<T>(value: T, key: string): T {
  const ref = useRef<{ key: string; value: T } | null>(null);
  if (ref.current === null || ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
}

/**
 * False for a short settle period after mount and after `context` changes (a new platform filter, another metric).
 * Increases during that period are the screen catching up, not live events, so they must not flash.
 * Read during render, right next to the value it guards.
 */
export function useSettled(context: string): boolean {
  const until = useRef(0);
  const last = useRef<string | null>(null);
  if (last.current !== context) {
    last.current = context;
    until.current = Date.now() + SETTLE_MS;
  }
  return Date.now() >= until.current;
}

/** 1 -> 0 envelope that fires whenever `value` grows (never on mount). Drive overlay opacity with it. */
export function useIncreaseFlash(value: number, enabled: boolean): Animated.Value {
  const flash = useRef(new Animated.Value(0)).current;
  const prev = useRef(value);
  useEffect(() => {
    if (enabled && value > prev.current) {
      flash.stopAnimation();
      flash.setValue(1);
      Animated.timing(flash, {
        toValue: 0,
        duration: 1800,
        easing: Easing.out(Easing.quad),
        useNativeDriver: NATIVE,
      }).start();
    }
    prev.current = value;
  }, [value, enabled, flash]);
  return flash;
}

/** Fade + slide up once on mount, staggered by `index`. Poll updates re-render it but never replay it. */
export function Reveal({
  index = 0,
  children,
  style,
}: {
  index?: number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 460,
      delay: Math.min(index, 6) * 70,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: NATIVE,
    });
    anim.start();
    return () => anim.stop();
  }, [progress, index]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** Solid dot with a halo that ripples outwards. Only runs while the screen is focused. */
export function LiveDot({ color = colors.success, size = 8 }: { color?: string; size?: number }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useCallback(() => {
      pulse.setValue(0);
      const loop = Animated.loop(
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1700,
          easing: Easing.out(Easing.quad),
          useNativeDriver: NATIVE,
        }),
      );
      loop.start();
      return () => loop.stop();
    }, [pulse]),
  );

  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: size / 2,
            backgroundColor: color,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.8] }) }],
          },
        ]}
      />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

/** Pulsing dot + "Live", for section headers. */
export function LiveTag() {
  return (
    <View style={styles.liveTag} accessibilityLabel="Live, updates every few seconds">
      <LiveDot size={7} />
      <Text style={styles.liveText}>Live</Text>
    </View>
  );
}

/** Muted status chip shown near the title when a poll fails but data is still on screen. */
export function ReconnectingChip() {
  return (
    <View style={styles.reconnect} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Ionicons name="cloud-offline-outline" size={13} color={colors.textDim} />
      <Text style={styles.reconnectText}>Reconnecting...</Text>
    </View>
  );
}

/**
 * `AnimatedNumber` that only flashes green for real live increments: not on the first count-up and not when the
 * screen swaps to another filter (`context`).
 */
export function LiveNumber({
  value,
  format,
  style,
  fromZero,
  context,
}: {
  value: number;
  format?: (n: number) => string;
  style?: StyleProp<TextStyle>;
  fromZero?: boolean;
  context: string;
}) {
  const settled = useSettled(context);
  return <AnimatedNumber value={value} format={format} style={style} fromZero={fromZero} flash={settled} />;
}

const styles = StyleSheet.create({
  liveTag: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: 4 },
  liveText: { color: colors.success, fontSize: 12, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  reconnect: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: withAlpha(colors.textMute, 0.14),
    borderWidth: 1,
    borderColor: colors.border,
  },
  reconnectText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
});
