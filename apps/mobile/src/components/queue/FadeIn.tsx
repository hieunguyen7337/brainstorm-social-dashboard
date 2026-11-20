import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Platform } from 'react-native';

/**
 * Staggered entrance (fade + 10px rise). `animate` is read once, at mount: the Queue passes true only for the
 * cards of the very first load, so polls, tab switches and new cards never replay it.
 */
export function FadeIn({ index = 0, animate, children }: { index?: number; animate: boolean; children: ReactNode }) {
  const progress = useRef(new Animated.Value(animate ? 0 : 1)).current;

  useEffect(() => {
    if (!animate) return undefined;
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 320,
      delay: Math.min(index, 8) * 55,
      useNativeDriver: Platform.OS !== 'web',
    });
    anim.start();
    return () => anim.stop();
    // Mount-only on purpose: later prop changes must not restart the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}
