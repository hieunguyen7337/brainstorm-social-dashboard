import { StyleSheet, Text, View } from 'react-native';

import type { Theme } from '@/src/api';
import { colors, withAlpha } from '@/src/theme';
import { Badge } from '@/src/ui';

/** Only `#rrggbb` can be tinted: `withAlpha` hands anything else back unchanged, which would be an opaque fill. */
const HEX6 = /^#[0-9a-f]{6}$/i;

/** Colour dot + theme name in a pill shaped like `Badge`, tinted with the theme's own colour. Long names truncate. */
export function ThemeChip({ theme }: { theme: Theme }) {
  const color = theme.color || colors.accent;
  const tint = HEX6.test(color)
    ? { backgroundColor: withAlpha(color, 0.12), borderColor: withAlpha(color, 0.4) }
    : styles.chipNeutral;
  return (
    <View style={[styles.chip, tint]} accessible accessibilityLabel={`Theme: ${theme.name}`} testID="post-theme">
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.chipText} numberOfLines={1}>
        {theme.name}
      </Text>
    </View>
  );
}

/**
 * The compact tag row under a post's status line: its theme, and a "Real data" badge when the counters were
 * harvested from the platform instead of simulated. Renders nothing when neither applies.
 */
export function PostTags({ theme, realData }: { theme: Theme | null | undefined; realData: boolean }) {
  if (!theme && !realData) return null;
  return (
    <View style={styles.row}>
      {theme ? <ThemeChip theme={theme} /> : null}
      {realData ? (
        <View testID="post-real-data">
          <Badge label="Real data" tone="success" icon="shield-checkmark" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The status line above already sits 4px closer to the header than the card gap; tags join that group.
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: -4 },
  chip: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipNeutral: { backgroundColor: 'transparent', borderColor: colors.border },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  chipText: { flexShrink: 1, color: colors.text, fontSize: 11.5, fontWeight: '700', letterSpacing: 0.2 },
});
