import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius, space, type as t } from '@/src/theme';

export interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Makes the whole card pressable. */
  onPress?: () => void;
  /** Inner padding (default true: 16). */
  padded?: boolean;
  /** 'raised' uses the lighter surface; 'outline' is transparent with a border. */
  tone?: 'default' | 'raised' | 'outline';
  accessibilityLabel?: string;
  testID?: string;
}

export function Card({ children, style, onPress, padded = true, tone = 'default', accessibilityLabel, testID }: CardProps) {
  const base = [
    styles.card,
    tone === 'raised' && styles.raised,
    tone === 'outline' && styles.outline,
    padded && styles.padded,
    style,
  ];
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [base, pressed && styles.pressed]}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View style={base} testID={testID}>
      {children}
    </View>
  );
}

/** Small uppercase label with an optional right-hand slot (e.g. a link or a chip). */
export function SectionHeader({
  title,
  subtitle,
  right,
  style,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.sectionRow, style]}>
      <View style={styles.sectionText}>
        <Text style={t.h2}>{title}</Text>
        {subtitle ? <Text style={[t.small, styles.sub]}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  raised: { backgroundColor: colors.cardHi, borderColor: colors.borderHi },
  outline: { backgroundColor: 'transparent' },
  padded: { padding: space.lg },
  pressed: { opacity: 0.88, transform: [{ scale: 0.99 }] },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  sectionText: { flex: 1, minWidth: 0 },
  sub: { marginTop: 2 },
});
