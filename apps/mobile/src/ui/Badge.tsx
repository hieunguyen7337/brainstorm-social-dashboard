import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius, withAlpha } from '@/src/theme';

type IconName = ComponentProps<typeof Ionicons>['name'];
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info';

const toneColor: Record<BadgeTone, string> = {
  neutral: colors.textDim,
  accent: colors.accent,
  success: colors.success,
  warn: colors.warn,
  danger: colors.danger,
  info: colors.info,
};

/** Small status pill: "sandbox", "Template mode", "Published", "Real". */
export function Badge({
  label,
  tone = 'neutral',
  icon,
  style,
}: {
  label: string;
  tone?: BadgeTone;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const c = toneColor[tone];
  return (
    <View style={[styles.badge, { backgroundColor: withAlpha(c, 0.14), borderColor: withAlpha(c, 0.4) }, style]}>
      {icon ? <Ionicons name={icon} size={11} color={c} /> : null}
      <Text style={[styles.text, { color: c }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  text: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.2 },
});
