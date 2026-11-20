import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';

import { Sparkline } from '@/src/charts';
import { MAX_CONTENT_WIDTH } from '@/src/config';
import { fmtChange, fmtCompact } from '@/src/format';
import { colors, space, type as t, withAlpha } from '@/src/theme';
import type { DayStats, Totals } from '@/src/types';
import { Card } from '@/src/ui';
import { LiveNumber, useStable } from './live';
import { METRICS, type MetricDef } from './model';

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
}: {
  totals: Totals;
  change: Totals;
  /** Oldest first. */
  timeseries: DayStats[];
  /** Changes when the data switches to another filter, so counters do not flash for it. */
  context: string;
}) {
  const { onLayout, tileWidth } = useKpiLayout();
  return (
    <View style={styles.grid} onLayout={onLayout}>
      {METRICS.map((m) => (
        <KpiTile
          key={m.key}
          metric={m}
          value={totals[m.key]}
          changePct={change[m.key]}
          values={timeseries.map((d) => d[m.key])}
          width={tileWidth}
          context={context}
        />
      ))}
    </View>
  );
}

function KpiTile({
  metric,
  value,
  changePct,
  values,
  width,
  context,
}: {
  metric: MetricDef;
  value: number;
  changePct: number;
  values: number[];
  width: number;
  context: string;
}) {
  const series = useStable(values, values.join(','));
  const pct = Number.isFinite(changePct) ? changePct : 0;
  const direction = Math.round(pct) > 0 ? 'up' : Math.round(pct) < 0 ? 'down' : 'flat';
  const tone = direction === 'up' ? colors.success : direction === 'down' ? colors.danger : colors.textMute;
  const spoken =
    direction === 'flat' ? 'unchanged' : `${direction} ${Math.abs(Math.round(pct))} percent`;

  return (
    <Card padded={false} style={{ width }}>
      <View
        style={styles.top}
        accessible
        accessibilityLabel={`${metric.label} ${fmtCompact(value)}, ${spoken} versus the previous period`}
      >
        <View style={styles.labelRow}>
          <View style={[styles.dot, { backgroundColor: metric.color }]} />
          <Text style={t.label} numberOfLines={1}>
            {metric.label}
          </Text>
        </View>
        <LiveNumber value={value} format={fmtCompact} fromZero context={context} style={styles.number} />
        <View style={[styles.pill, { backgroundColor: withAlpha(tone, 0.14) }]}>
          <Ionicons name={direction === 'up' ? 'arrow-up' : direction === 'down' ? 'arrow-down' : 'remove'} size={11} color={tone} />
          <Text style={[styles.pillText, { color: tone }]}>{fmtChange(pct)}</Text>
        </View>
      </View>
      {series.length >= 2 ? (
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
