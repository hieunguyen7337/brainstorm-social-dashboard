import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';

import { fmtCompact } from '@/src/format';
import { colors, type as t } from '@/src/theme';
import type { EngagementSplit } from '@/src/types';
import { splitNote, splitRows, splitSpoken } from './model';

/**
 * Engagements broken into Likes / Comments / Shares (docs/CONTRACT.md, "Engagement split"). It takes the place of the
 * trend line on the Engagements tile: a real workspace's numbers are account totals with no daily breakdown, so the
 * line is mostly flat anyway. Renders nothing when there is no split.
 */
export function EngagementSplitRows({
  split,
  color,
  inset,
}: {
  split: EngagementSplit | null | undefined;
  /** The tile's metric colour, for the icons. */
  color: string;
  /** Side padding so the rows line up with the tile's number. */
  inset: number;
}) {
  const rows = splitRows(split);
  if (rows.length === 0) return null;
  const note = splitNote(split);
  return (
    <View
      style={[styles.wrap, { paddingHorizontal: inset, paddingBottom: inset }]}
      accessible
      accessibilityLabel={splitSpoken(split)}
      testID="engagement-split"
    >
      {rows.map((r) => (
        <View key={r.key} style={styles.row}>
          <View style={styles.name}>
            <Ionicons name={r.icon} size={12} color={color} />
            <Text style={styles.label} numberOfLines={1}>
              {r.label}
            </Text>
          </View>
          <Text style={styles.value}>{fmtCompact(r.value)}</Text>
        </View>
      ))}
      {note ? (
        <Text style={t.small} numberOfLines={2}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** True when the Engagements tile has a breakdown to draw. */
export const hasSplit = (split: EngagementSplit | null | undefined): split is EngagementSplit => splitRows(split).length > 0;

const styles = StyleSheet.create({
  wrap: { gap: 4, paddingTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  name: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0 },
  label: { fontSize: 12.5, color: colors.textDim, flexShrink: 1 },
  value: { fontSize: 13, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
});
