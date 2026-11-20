import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors } from '@/src/theme';
import { haptic } from '@/src/ui';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** Low-emphasis action (ghost button): icon + label, no fill. Used for Show more, Preview and Delete. */
export function TextAction({
  label,
  icon,
  onPress,
  tone = 'dim',
  disabled,
  accessibilityLabel,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  tone?: 'dim' | 'accent' | 'danger';
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const color = tone === 'danger' ? colors.danger : tone === 'accent' ? colors.accent : colors.textDim;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => [styles.action, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {icon ? <Ionicons name={icon} size={15} color={color} /> : null}
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 4 },
  label: { fontSize: 13.5, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
});
