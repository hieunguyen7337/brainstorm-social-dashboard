import { useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius, space } from '@/src/theme';

/** Pulsing placeholder block. */
export function Skeleton({
  width = '100%',
  height = 16,
  rounded = 8,
  style,
}: {
  width?: DimensionValue;
  height?: number;
  rounded?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const opacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(opacity, { toValue: 0.5, duration: 800, useNativeDriver: Platform.OS !== 'web' }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: rounded, backgroundColor: colors.cardHi, opacity }, style]}
    />
  );
}

/** A card-shaped skeleton with a few text lines. */
export function SkeletonCard({ lines = 3, height }: { lines?: number; height?: number }) {
  return (
    <View style={[styles.card, height ? { height } : null]}>
      <Skeleton width="40%" height={14} />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '65%' : '100%'} height={12} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.md,
  },
});
