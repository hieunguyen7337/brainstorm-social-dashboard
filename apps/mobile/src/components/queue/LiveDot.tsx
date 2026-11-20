import { useEffect, useRef } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';

import { colors } from '@/src/theme';

/**
 * Green dot with a halo that pulses outwards. Static grey when `live` is false (reconnecting, or the screen is
 * not focused), so the loop never runs in the background.
 */
export function LiveDot({ live = true, size = 8 }: { live?: boolean; size?: number }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!live) {
      pulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1500, useNativeDriver: Platform.OS !== 'web' }),
    );
    loop.start();
    return () => loop.stop();
  }, [live, pulse]);

  const color = live ? colors.success : colors.textMute;
  const dot = { width: size, height: size, borderRadius: size / 2, backgroundColor: color };

  return (
    <View
      style={[styles.box, { width: size + 6, height: size + 6 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {live ? (
        <Animated.View
          style={[
            styles.halo,
            dot,
            {
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.8] }) }],
            },
          ]}
        />
      ) : null}
      <View style={dot} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute' },
});
