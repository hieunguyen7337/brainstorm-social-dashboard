import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors, radius, space, withAlpha } from '@/src/theme';
import { haptic } from '@/src/ui';
import { useRoomWelcome } from './roomStore';

/** Exact wording the room flow promises (ASCII arrow on purpose). */
export const ROOM_WELCOME_TEXT = "You're in! Try Create -> Generate, then Post it for real.";

/*
 * The banners draw their glyphs with SVG (no icon-font text), so the banner's text content is exactly its sentence.
 */
const Sparkle = ({ color, size = 15 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
    <Path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" fill={color} />
  </Svg>
);

/** Round close button with the accessibility label `label` (the welcome's is "Dismiss"). */
export function BannerClose({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => [styles.close, pressed && styles.pressed]}
    >
      <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.textDim} strokeWidth={2.6} strokeLinecap="round">
        <Path d="M5 5l14 14M19 5L5 19" />
      </Svg>
    </Pressable>
  );
}

/**
 * Slim, dismissible welcome for someone who joined through a room link. Shown on the Dashboard until the close button is
 * pressed; the dismissal is persisted. Renders nothing otherwise.
 */
export function RoomWelcome() {
  const { visible, dismiss } = useRoomWelcome();
  if (!visible) return null;
  return <RoomWelcomeBar onDismiss={dismiss} />;
}

export function RoomWelcomeBar({ onDismiss }: { onDismiss: () => void }) {
  return (
    <View testID="room-welcome" style={styles.bar}>
      <View style={styles.icon}>
        <Sparkle color={colors.accent2} />
      </View>
      <Text style={styles.text}>{ROOM_WELCOME_TEXT}</Text>
      <BannerClose label="Dismiss" onPress={onDismiss} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 8,
    paddingLeft: space.md,
    paddingRight: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: withAlpha(colors.accent, 0.55),
    backgroundColor: withAlpha(colors.accent, 0.14),
  },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.accent2, 0.16),
  },
  text: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14, lineHeight: 19, fontWeight: '600' },
  close: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
});
