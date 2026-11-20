import { StyleSheet, Text, View } from 'react-native';

import { fmtCompact } from '@/src/format';
import { colors, platformMeta, radius, space, type as t } from '@/src/theme';
import { Card, PlatformBadge, PlatformIcon } from '@/src/ui';
import { KPI_PAD } from './KpiGrid';
import { LiveNumber } from './live';
import { platformsLabel, type FollowerChip } from './realModel';

/** Followers are not one of the four metrics: amber keeps the tile apart from violet, pink, cyan and green. */
export const FOLLOWERS_COLOR = colors.warn;

/** "Followers 1.3k across 2 platforms: LinkedIn 1.2k, Instagram 46" for a screen reader. */
export function followersSpoken(total: number, chips: readonly FollowerChip[]): string {
  const head = `Followers ${fmtCompact(total)}`;
  if (chips.length === 0) return head;
  const parts = chips.map((c) => `${platformMeta[c.platform].label} ${fmtCompact(c.followers)}`);
  return `${head} across ${platformsLabel(chips.length)}: ${parts.join(', ')}`;
}

/**
 * Followers per platform as a wrapping row of small chips (brand badge + compact count). `compact` is the wide board's
 * tile, which only has room for the bare glyph.
 */
export function FollowerChips({ chips, compact = false }: { chips: readonly FollowerChip[]; compact?: boolean }) {
  return (
    <View style={compact ? styles.rowCompact : styles.row}>
      {chips.map((c) =>
        compact ? (
          <View key={c.platform} style={styles.itemCompact}>
            <PlatformIcon platform={c.platform} size={12} />
            <Text style={styles.countCompact}>{fmtCompact(c.followers)}</Text>
          </View>
        ) : (
          <View key={c.platform} style={styles.chip}>
            <PlatformBadge platform={c.platform} size={22} />
            <Text style={styles.count}>{fmtCompact(c.followers)}</Text>
          </View>
        ),
      )}
    </View>
  );
}

/**
 * The phone's Followers tile: full width, above the 2x2 KPI grid. The number is the dashboard's `followers_total`; the
 * chips under it say where those followers are (only platforms with some).
 */
export function FollowersTile({
  total,
  chips,
  context,
}: {
  total: number;
  chips: readonly FollowerChip[];
  /** Changes when the data switches to another filter, so the counter does not flash for it. */
  context: string;
}) {
  return (
    <Card padded={false}>
      <View style={styles.body} accessible accessibilityLabel={followersSpoken(total, chips)}>
        <View style={styles.labelRow}>
          <View style={styles.dot} />
          <Text style={t.label} numberOfLines={1}>
            Followers
          </Text>
        </View>
        <LiveNumber value={total} format={fmtCompact} fromZero context={context} style={styles.number} />
        {chips.length > 0 ? <FollowerChips chips={chips} /> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { padding: KPI_PAD, gap: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: FOLLOWERS_COLOR },
  number: { color: colors.text, fontSize: 30, lineHeight: 36, fontWeight: '800', letterSpacing: -0.8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.sm, rowGap: space.sm, marginTop: space.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 3,
    paddingLeft: 3,
    paddingRight: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.cardHi,
    borderWidth: 1,
    borderColor: colors.border,
  },
  count: { color: colors.text, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  rowCompact: { flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1, columnGap: space.sm, rowGap: 4 },
  itemCompact: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  countCompact: { color: colors.textDim, fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
});
