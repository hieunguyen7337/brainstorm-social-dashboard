import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';

import { gradient } from '@/src/theme';

// Speech bubble (social) with three rising bars (growth), in badge units x 24; scripts/gen-assets.mjs draws the same
// shapes for the app icons. (It replaced a heartbeat line, which read as a health-care app.)
const MARK =
  'M7.92 5.52H16.08A2.64 2.64 0 0 1 18.72 8.16V13.2A2.64 2.64 0 0 1 16.08 15.84H10.08L7.2 18.6L7.92 15.84' +
  'A2.64 2.64 0 0 1 5.28 13.2V8.16A2.64 2.64 0 0 1 7.92 5.52Z M9.12 13.2V11.52 M12 13.2V9.84 M14.88 13.2V7.92';
const MARK_STROKE = 1.68; // 7% of the badge, as in the icons

/**
 * The brand mark (speech bubble with rising bars). Web draws a plain DOM <svg> (react-native-svg renders exactly this
 * on web) so that the first
 * screen, which always shows the logo, does not pull the 50 KB react-native-svg library into the shared chunk. Native
 * keeps react-native-svg; Metro drops that require from the web bundle because the branch is dead there.
 */
function Mark({ size }: { size: number }) {
  if (process.env.EXPO_OS === 'web') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path
          d={MARK}
          fill="none"
          stroke="#ffffff"
          strokeWidth={MARK_STROKE}
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
          d={MARK}
          fill="none"
          stroke="#ffffff"
          strokeWidth={MARK_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
}

/** The brand mark: gradient badge with a speech bubble and rising bars. */
export function Logo({ size = 44 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size }} accessibilityRole="image" accessibilityLabel="Logo">
      <LinearGradient
        colors={gradient.colors}
        start={gradient.start}
        end={gradient.end}
        style={[styles.badge, { borderRadius: size * 0.28 }]}
      >
        <Mark size={size} />
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
