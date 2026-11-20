import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { gradient } from '@/src/theme';

/** The brand mark: gradient badge with a heartbeat line. */
export function Logo({ size = 44 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size }} accessibilityRole="image" accessibilityLabel="Logo">
      <LinearGradient
        colors={gradient.colors}
        start={gradient.start}
        end={gradient.end}
        style={[styles.badge, { borderRadius: size * 0.28 }]}
      >
        <Svg width={size * 0.68} height={size * 0.68} viewBox="0 0 24 24">
          <Path
            d="M2 12.5h4.2l2.3-5.2 3.6 11 2.7-8 1.5 2.2H22"
            fill="none"
            stroke="#ffffff"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
