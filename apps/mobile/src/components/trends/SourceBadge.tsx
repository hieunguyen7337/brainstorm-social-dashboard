import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import { StyleSheet, Text, View } from 'react-native';

import type { TrendSource } from '@/src/api';
import { colors, space, trendSourceMeta, type as t, withAlpha } from '@/src/theme';

/** Round tinted badge with the source's glyph in the source colour. Decorative: the name is always next to it. */
export function SourceBadge({ source, size = 22 }: { source: TrendSource; size?: number }) {
  const meta = trendSourceMeta[source];
  return (
    <View
      aria-hidden
      style={[
        styles.badge,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: withAlpha(meta.color, 0.16) },
      ]}
    >
      <FontAwesome6 name={meta.icon} size={Math.round(size * 0.5)} color={meta.color} brand />
    </View>
  );
}

/** Group header in the "All" view: source glyph, name and how many trends it holds. */
export function SourceHeader({ source, count }: { source: TrendSource; count: number }) {
  const meta = trendSourceMeta[source];
  return (
    <View style={styles.header} accessibilityRole="header">
      <SourceBadge source={source} size={32} />
      <Text style={[t.h3, styles.label]} numberOfLines={1}>
        {meta.label}
      </Text>
      <View style={[styles.count, { backgroundColor: withAlpha(meta.color, 0.14) }]}>
        <Text style={[styles.countText, { color: meta.color }]}>{`${count} ${count === 1 ? 'trend' : 'trends'}`}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: 2 },
  label: { flex: 1, minWidth: 0 },
  count: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999 },
  countText: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.2, color: colors.textDim },
});
