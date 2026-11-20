import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';

import { gradient } from '@/src/theme';

const HEARTBEAT = 'M2 12.5h4.2l2.3-5.2 3.6 11 2.7-8 1.5 2.2H22';

/**
 * The heartbeat line. Web draws a plain DOM <svg> (react-native-svg renders exactly this on web) so that the first
 * screen, which always shows the logo, does not pull the 50 KB react-native-svg library into the shared chunk. Native
 * keeps react-native-svg; Metro drops that require from the web bundle because the branch is dead there.
 */
function Heartbeat({ size }: { size: number }) {
  if (process.env.EXPO_OS === 'web') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path
          d={HEARTBEAT}
          fill="none"
          stroke="#ffffff"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  } else {
    const { default: Svg, Path } = require('react-native-svg') as typeof import('react-native-svg');
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path
          d={HEARTBEAT}
          fill="none"
          stroke="#ffffff"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
}

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
        <Heartbeat size={size * 0.68} />
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
