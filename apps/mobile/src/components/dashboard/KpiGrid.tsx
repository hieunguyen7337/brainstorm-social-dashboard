import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';

import { Sparkline } from '@/src/charts';
import { MAX_CONTENT_WIDTH } from '@/src/config';
import { fmtCompact } from '@/src/format';
import { colors, space, type as t, withAlpha } from '@/src/theme';
import type { DashboardSummary, DayStats, EngagementSplit, Totals } from '@/src/types';
import { Card } from '@/src/ui';
import { EngagementSplitRows, hasSplit } from './EngagementSplitRows';
import { LiveNumber, useStable } from './live';
import { changeView, kpiTile, METRICS, NOT_READ_MARK, type KpiTileView, type MetricDef } from './model';

const GAP = space.md;
/** Column width at which the four tiles go 4 across instead of 2x2. */
const WIDE_AT = 560;
export const KPI_PAD = 14;
export const KPI_SPARK_HEIGHT = 44;

/**
 * Measures the grid with `onLayout` (the column is 100% wide up to 720px) and derives the column count and an
 * exact tile width. Starts from a window-based guess so the first paint is already right.
 */
export function useKpiLayout() {
  const { width: windowWidth } = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);
  const width = measured ?? Math.min(windowWidth - space.lg * 2, MAX_CONTENT_WIDTH);
  const cols = width >= WIDE_AT ? 4 : 2;
  const tileWidth = Math.max(80, Math.floor((width - GAP * (cols - 1)) / cols));

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setMeasured((prev) => (prev !== null && Math.abs(prev - w) < 0.5 ? prev : w));
  }, []);

  return { onLayout, cols, tileWidth };
}

export function KpiGrid({
  totals,
  change,
  timeseries,
  context,
  real = false,
  tiles,
  notRead,
  split,
}: {
  totals: Totals;
  change: Totals;
  /** Oldest first. */
  timeseries: DayStats[];
  /** Changes when the data switches to another filter, so counters do not flash for it. */
  context: string;
  /** The summary's `data_mode` is 'real': a change of 0 means nothing earlier to compare, so the pill says "new". */
  real?: boolean;
  /** The summary's `tiles`: a null there means never read, and that tile shows "—" and its reason. Absent on old servers. */
  tiles?: DashboardSummary['tiles'];
  /** The summary's `not_read`: why a tile has no number. */
  notRead?: DashboardSummary['not_read'];
  /** The summary's `engagement_split`: when present the Engagements tile shows likes, comments and shares. */
  split?: EngagementSplit | null;
}) {
  const { onLayout, tileWidth } = useKpiLayout();
  return (
    <View style={styles.grid} onLayout={onLayout}>
      {METRICS.map((m) => (
        <KpiTile
          key={m.key}
          metric={m}
          tile={kpiTile({ totals, tiles, not_read: notRead }, m.key)}
          changePct={change[m.key]}
          values={timeseries.map((d) => d[m.key])}
          width={tileWidth}
          context={context}
          real={real}
          split={m.key === 'engagements' ? split : null}
        />
      ))}
    </View>
  );
}

function KpiTile({
  metric,
  tile,
  changePct,
  values,
  width,
  context,
  real,
  split,
}: {
  metric: MetricDef;
  tile: KpiTileView;
  changePct: number;
  values: number[];
  width: number;
  context: string;
  real: boolean;
  /** Engagements only: likes, comments and shares, drawn in place of the trend line. */
  split: EngagementSplit | null | undefined;
}) {
  const series = useStable(values, values.join(','));
  const view = changeView(changePct, real);
  const { value, reason } = tile;
  const spoken =
    value === null ? `${metric.label} not read, ${reason ?? ''}` : `${metric.label} ${fmtCompact(value)}, ${view.spoken}`;

  return (
    <Card padded={false} style={{ width }}>
      <View style={styles.top} accessible accessibilityLabel={spoken}>
        <View style={styles.labelRow}>
          <View style={[styles.dot, { backgroundColor: metric.color }]} />
          <Text style={t.label} numberOfLines={1}>
            {metric.label}
          </Text>
        </View>
        {value === null ? (
          <Text style={[styles.number, styles.notRead]}>{NOT_READ_MARK}</Text>
        ) : (
          <LiveNumber value={value} format={fmtCompact} fromZero context={context} style={styles.number} />
        )}
        {tile.showBadge ? (
          <View style={[styles.pill, { backgroundColor: withAlpha(view.tone, 0.14) }]}>
            <Ionicons name={view.icon} size={11} color={view.tone} />
            <Text style={[styles.pillText, { color: view.tone }]}>{view.label}</Text>
          </View>
        ) : null}
        {reason !== null ? (
          <Text style={t.small} numberOfLines={3}>
            {reason}
          </Text>
        ) : null}
      </View>
      {value !== null && hasSplit(split) ? (
        <EngagementSplitRows split={split} color={metric.color} inset={KPI_PAD} />
      ) : tile.showSparkline && series.length >= 2 ? (
        <Sparkline
          values={series}
          color={metric.color}
          width={width - 2}
          height={KPI_SPARK_HEIGHT}
          title={`${metric.label} trend, last 30 days`}
        />
      ) : (
        <View style={{ height: KPI_SPARK_HEIGHT }} />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  top: { padding: KPI_PAD, paddingBottom: space.sm, gap: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  number: { color: colors.text, fontSize: 30, lineHeight: 36, fontWeight: '800', letterSpacing: -0.8 },
  notRead: { color: colors.textMute },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  pillText: { fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
});
