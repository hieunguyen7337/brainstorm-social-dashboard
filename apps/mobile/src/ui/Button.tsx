import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, gradient, radius, withAlpha } from '@/src/theme';
import { haptic } from './utils';

type IconName = ComponentProps<typeof Ionicons>['name'];
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: Variant;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  /** Compact height (36) instead of 48. */
  small?: boolean;
  /** Stretch to the parent's width. */
  full?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  loading,
  disabled,
  small,
  full,
  style,
  accessibilityLabel,
}: ButtonProps) {
  const inactive = disabled || loading;
  const fg = variant === 'primary' ? colors.white : variant === 'danger' ? colors.danger : variant === 'ghost' ? colors.accent : colors.text;
  const content = (
    <View style={styles.inner}>
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : icon ? (
        <Ionicons name={icon} size={small ? 16 : 18} color={fg} />
      ) : null}
      <Text style={[styles.label, small && styles.labelSmall, { color: fg }]} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
  const sizeStyle = small ? styles.small : styles.regular;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={() => {
        haptic.tap();
        onPress?.();
      }}
      style={({ pressed }) => [
        full && styles.full,
        inactive && styles.inactive,
        pressed && styles.pressed,
        style,
      ]}
    >
      {variant === 'primary' ? (
        <LinearGradient colors={gradient.colors} start={gradient.start} end={gradient.end} style={[styles.base, sizeStyle]}>
          {content}
        </LinearGradient>
      ) : (
        <View
          style={[
            styles.base,
            sizeStyle,
            variant === 'secondary' && styles.secondary,
            variant === 'danger' && styles.danger,
            variant === 'ghost' && styles.ghost,
          ]}
        >
          {content}
        </View>
      )}
    </Pressable>
  );
}

/** Round icon-only button (header actions, row actions). */
export function IconButton({
  icon,
  onPress,
  label,
  color = colors.textDim,
  size = 20,
  disabled,
  style,
}: {
  icon: IconName;
  onPress?: () => void;
  label: string;
  color?: string;
  size?: number;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        haptic.tap();
        onPress?.();
      }}
      style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed, disabled && styles.inactive, style]}
    >
      <Ionicons name={icon} size={size} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  regular: { minHeight: 48 },
  small: { minHeight: 36, paddingHorizontal: 14, borderRadius: 12 },
  inner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  label: { fontSize: 15.5, fontWeight: '700', letterSpacing: 0.1 },
  labelSmall: { fontSize: 13.5 },
  secondary: { backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.borderHi },
  danger: { backgroundColor: withAlpha(colors.danger, 0.12), borderWidth: 1, borderColor: withAlpha(colors.danger, 0.35) },
  ghost: { backgroundColor: 'transparent' },
  full: { alignSelf: 'stretch' },
  inactive: { opacity: 0.5 },
  pressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cardHi,
  },
});
