import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { Sparkline } from '@/src/charts';
import { fmtChange, fmtCompact } from '@/src/format';
import { colors, space, type as t, withAlpha } from '@/src/theme';
import type { DayStats, Totals } from '@/src/types';
import { Card } from '@/src/ui';
import { LiveNumber, useStable } from './live';
import { METRICS, type MetricDef } from './model';

/** Below this tile width the label shrinks and loses its dot, so "ENGAGEMENTS" still fits on the ~800px board. */
const TIGHT_AT = 150;
const SPARK_MIN = 40;
const SPARK_MAX = 140;
const MAX_HEIGHT = 250;

/** The four KPI tiles in one row (the phone layout wraps them 2x2). Tiles share the row equally. */
export function BoardKpis({
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
  return (
    <View style={styles.row}>
      {METRICS.map((m) => (
        <BoardKpiTile
          key={m.key}
          metric={m}
          value={totals[m.key]}
          changePct={change[m.key]}
          values={timeseries.map((d) => d[m.key])}
          context={context}
        />
      ))}
    </View>
  );
}

function BoardKpiTile({
  metric,
  value,
  changePct,
  values,
  context,
}: {
  metric: MetricDef;
  value: number;
  changePct: number;
  values: number[];
  context: string;
}) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [topH, setTopH] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setBox((prev) => (prev.width === Math.round(w) && prev.height === Math.round(h) ? prev : { width: Math.round(w), height: Math.round(h) }));
  }, []);
  const onTopLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setTopH((prev) => (prev === h ? prev : h));
  }, []);
  const { width } = box;
  // The tile can be stretched taller than its content (the row shares a height with the trends card): the sparkline
  // takes the spare room, up to a cap.
  const spark = Math.round(Math.min(SPARK_MAX, Math.max(SPARK_MIN, box.height - topH)));

  const series = useStable(values, values.join(','));
  const pct = Number.isFinite(changePct) ? changePct : 0;
  const direction = Math.round(pct) > 0 ? 'up' : Math.round(pct) < 0 ? 'down' : 'flat';
  const tone = direction === 'up' ? colors.success : direction === 'down' ? colors.danger : colors.textMute;
  const spoken = direction === 'flat' ? 'unchanged' : `${direction} ${Math.abs(Math.round(pct))} percent`;
  const tight = width > 0 && width < TIGHT_AT;

  return (
    <Card padded={false} style={styles.tile}>
      <View onLayout={onLayout} style={styles.measure}>
        <View
          onLayout={onTopLayout}
          style={styles.top}
          accessible
          accessibilityLabel={`${metric.label} ${fmtCompact(value)}, ${spoken} versus the previous period`}
        >
          <View style={styles.labelRow}>
            {tight ? null : <View style={[styles.dot, { backgroundColor: metric.color }]} />}
            <Text style={[t.label, tight && styles.labelTight]} numberOfLines={1}>
              {metric.label}
            </Text>
          </View>
          <LiveNumber value={value} format={fmtCompact} fromZero context={context} style={styles.number} />
          <View style={[styles.pill, { backgroundColor: withAlpha(tone, 0.14) }]}>
            <Ionicons
              name={direction === 'up' ? 'arrow-up' : direction === 'down' ? 'arrow-down' : 'remove'}
              size={11}
              color={tone}
            />
            <Text style={[styles.pillText, { color: tone }]}>{fmtChange(pct)}</Text>
          </View>
        </View>
        {width > 0 && series.length >= 2 ? (
          <Sparkline
            values={series}
            color={metric.color}
            width={Math.max(40, width - 2)}
            height={spark}
            title={`${metric.label} trend, last 30 days`}
          />
        ) : (
          <View style={{ height: SPARK_MIN }} />
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  // Grows with the row (it shares a height with the trends card) but never into tall bars.
  row: { flexDirection: 'row', gap: space.md, alignItems: 'stretch', flex: 1, maxHeight: MAX_HEIGHT },
  tile: { flex: 1, minWidth: 0 },
  // Fills the tile so the sparkline sits at the bottom when the row is stretched taller than its content.
  measure: { flex: 1, justifyContent: 'space-between' },
  top: { padding: space.md, paddingBottom: space.sm, gap: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  labelTight: { fontSize: 10.5, letterSpacing: 0.3 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  number: { color: colors.text, fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.8 },
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
