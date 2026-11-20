import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { colors, gradient, platformMeta, radius, withAlpha } from '@/src/theme';
import type { Platform } from '@/src/types';
import { PlatformIcon } from './PlatformIcon';
import { haptic } from './utils';

type IconName = ComponentProps<typeof Ionicons>['name'];

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /** Accent for the selected state (default violet). Ignored when `platform` is set. */
  color?: string;
  /** Show the brand glyph and use the platform colour. */
  platform?: Platform;
  icon?: IconName;
  /** Small trailing number. */
  count?: number;
  disabled?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Chip({ label, selected, onPress, color, platform, icon, count, disabled, small, style, testID }: ChipProps) {
  const tint = platform ? platformMeta[platform].color : (color ?? colors.accent);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      accessibilityLabel={label}
      disabled={disabled || !onPress}
      onPress={() => {
        haptic.select();
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.chip,
        small && styles.small,
        selected
          ? { backgroundColor: withAlpha(tint, 0.18), borderColor: withAlpha(tint, 0.75) }
          : { backgroundColor: colors.cardHi, borderColor: colors.border },
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      {platform ? <PlatformIcon platform={platform} size={small ? 12 : 14} color={selected ? tint : colors.textDim} /> : null}
      {icon ? <Ionicons name={icon} size={small ? 13 : 15} color={selected ? tint : colors.textDim} /> : null}
      <Text style={[styles.label, small && styles.labelSmall, { color: selected ? colors.text : colors.textDim }]} numberOfLines={1}>
        {label}
      </Text>
      {count !== undefined ? (
        <Text style={[styles.count, { color: selected ? tint : colors.textMute }]}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

/** Wrapping row of chips. */
export function ChipRow({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

/** Single-line horizontally scrolling chip strip (filters). */
export function ChipStrip({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
      {children}
    </ScrollView>
  );
}

export interface SegmentedOption {
  key: string;
  label: string;
  count?: number;
}

/** Equal-width segmented control (Queue: Drafts / Scheduled / Published). */
export function Segmented({
  options,
  value,
  onChange,
}: {
  options: SegmentedOption[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <View style={styles.segment} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.key === value;
        const inner = (
          <Text style={[styles.segLabel, active && styles.segLabelActive]} numberOfLines={1}>
            {o.label}
            {o.count !== undefined ? <Text style={styles.segCount}>{`  ${o.count}`}</Text> : null}
          </Text>
        );
        return (
          <Pressable
            key={o.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => {
              haptic.select();
              onChange(o.key);
            }}
            style={styles.segItem}
          >
            {active ? (
              <LinearGradient colors={gradient.colors} start={gradient.start} end={gradient.end} style={styles.segActive}>
                {inner}
              </LinearGradient>
            ) : (
              <View style={styles.segActive}>{inner}</View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    minHeight: 36,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  small: { minHeight: 30, paddingHorizontal: 10 },
  label: { fontSize: 14, fontWeight: '600' },
  labelSmall: { fontSize: 12.5 },
  count: { fontSize: 12, fontWeight: '700' },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.45 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  strip: { gap: 8, paddingVertical: 2, paddingRight: 8 },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    gap: 4,
  },
  segItem: { flex: 1 },
  segActive: { minHeight: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  segLabel: { fontSize: 14, fontWeight: '600', color: colors.textDim },
  segLabelActive: { color: colors.white, fontWeight: '800' },
  segCount: { fontSize: 12, fontWeight: '700', opacity: 0.8 },
});
