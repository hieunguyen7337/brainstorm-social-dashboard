import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { Sparkline } from '@/src/charts';
import { fmtCompact } from '@/src/format';
import { colors, space, type as t, withAlpha } from '@/src/theme';
import type { DayStats, Totals } from '@/src/types';
import { Card } from '@/src/ui';
import { FOLLOWERS_COLOR, FollowerChips, followersSpoken } from './FollowersTile';
import { LiveNumber, useStable } from './live';
import { changeView, METRICS, type MetricDef } from './model';
import { platformsLabel, type FollowerChip } from './realModel';

/** Below this tile width the label shrinks and loses its dot, so "ENGAGEMENTS" still fits on the ~800px board. */
const TIGHT_AT = 150;
const SPARK_MIN = 40;
const SPARK_MAX = 140;
const MAX_HEIGHT = 250;
/** Row width from which five tiles keep their labels whole ("ENGAGEMENTS" needs about 110 px a tile). */
const FIVE_UP_AT = 600;

/**
 * The four KPI tiles in one row (the phone layout wraps them 2x2). Tiles share the row equally. A real workspace puts a
 * Followers tile first (five in the row); it has no trend line, so its per-platform counts take the sparkline's place.
 * On a board too narrow for five tiles (the ~1024 px window) Followers becomes a slim strip above the four instead.
 */
export function BoardKpis({
  totals,
  change,
  timeseries,
  context,
  real = false,
  followers,
}: {
  totals: Totals;
  change: Totals;
  /** Oldest first. */
  timeseries: DayStats[];
  /** Changes when the data switches to another filter, so counters do not flash for it. */
  context: string;
  /** The summary's `data_mode` is 'real': a change of 0 means nothing earlier to compare, so the pill says "new". */
  real?: boolean;
  /** The summary's `followers_total` and where those followers are. Omit (old server, sample workspace) for four tiles. */
  followers?: { total: number; chips: readonly FollowerChip[] };
}) {
  const [rowWidth, setRowWidth] = useState(0);
  const onRowLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setRowWidth((prev) => (prev === w ? prev : w));
  }, []);

  const tiles = METRICS.map((m) => (
    <BoardKpiTile
      key={m.key}
      metric={m}
      value={totals[m.key]}
      changePct={change[m.key]}
      values={timeseries.map((d) => d[m.key])}
      context={context}
      real={real}
    />
  ));
  if (!followers) return <View style={styles.row}>{tiles}</View>;

  const strip = rowWidth > 0 && rowWidth < FIVE_UP_AT;
  return (
    <View style={styles.rows} onLayout={onRowLayout}>
      {strip ? <BoardFollowersStrip total={followers.total} chips={followers.chips} context={context} /> : null}
      <View style={styles.rowInner}>
        {strip ? null : <BoardFollowersTile total={followers.total} chips={followers.chips} context={context} />}
        {tiles}
      </View>
    </View>
  );
}

/** Followers on a narrow board: one slim card above the four tiles, number and per-platform counts side by side. */
function BoardFollowersStrip({ total, chips, context }: { total: number; chips: readonly FollowerChip[]; context: string }) {
  return (
    <Card padded={false}>
      <View style={styles.strip} accessible accessibilityLabel={followersSpoken(total, chips)}>
        <View style={styles.stripHead}>
          <View style={styles.labelRow}>
            <View style={[styles.dot, { backgroundColor: FOLLOWERS_COLOR }]} />
            <Text style={t.label} numberOfLines={1}>
              Followers
            </Text>
          </View>
          <LiveNumber value={total} format={fmtCompact} fromZero context={context} style={styles.stripNumber} />
        </View>
        {chips.length > 0 ? <FollowerChips chips={chips} compact /> : null}
      </View>
    </Card>
  );
}

function BoardFollowersTile({ total, chips, context }: { total: number; chips: readonly FollowerChip[]; context: string }) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidth((prev) => (prev === w ? prev : w));
  }, []);
  const tight = width > 0 && width < TIGHT_AT;

  return (
    <Card padded={false} style={styles.tile}>
      <View onLayout={onLayout} style={styles.measure} accessible accessibilityLabel={followersSpoken(total, chips)}>
        <View style={styles.top}>
          <View style={styles.labelRow}>
            {tight ? null : <View style={[styles.dot, { backgroundColor: FOLLOWERS_COLOR }]} />}
            <Text style={[t.label, tight && styles.labelTight]} numberOfLines={1}>
              Followers
            </Text>
          </View>
          <LiveNumber value={total} format={fmtCompact} fromZero context={context} style={styles.number} />
          {/* Where the pill sits on the other tiles. */}
          {chips.length > 0 ? (
            <Text style={styles.caption} numberOfLines={1}>
              {platformsLabel(chips.length)}
            </Text>
          ) : null}
        </View>
        {chips.length > 0 ? (
          <View style={styles.chips}>
            <FollowerChips chips={chips} compact />
          </View>
        ) : (
          <View style={{ height: SPARK_MIN }} />
        )}
      </View>
    </Card>
  );
}

function BoardKpiTile({
  metric,
  value,
  changePct,
  values,
  context,
  real,
}: {
  metric: MetricDef;
  value: number;
  changePct: number;
  values: number[];
  context: string;
  real: boolean;
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
  const view = changeView(changePct, real);
  const tight = width > 0 && width < TIGHT_AT;

  return (
    <Card padded={false} style={styles.tile}>
      <View onLayout={onLayout} style={styles.measure}>
        <View
          onLayout={onTopLayout}
          style={styles.top}
          accessible
          accessibilityLabel={`${metric.label} ${fmtCompact(value)}, ${view.spoken}`}
        >
          <View style={styles.labelRow}>
            {tight ? null : <View style={[styles.dot, { backgroundColor: metric.color }]} />}
            <Text style={[t.label, tight && styles.labelTight]} numberOfLines={1}>
              {metric.label}
            </Text>
          </View>
          <LiveNumber value={value} format={fmtCompact} fromZero context={context} style={styles.number} />
          <View style={[styles.pill, { backgroundColor: withAlpha(view.tone, 0.14) }]}>
            <Ionicons name={view.icon} size={11} color={view.tone} />
            <Text style={[styles.pillText, { color: view.tone }]}>{view.label}</Text>
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
  // The same row with a Followers strip above it: the pair is what grows with the board and stops at the cap.
  rows: { gap: space.md, flex: 1, maxHeight: MAX_HEIGHT },
  rowInner: { flexDirection: 'row', gap: space.md, alignItems: 'stretch', flex: 1 },
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space.lg,
    rowGap: space.sm,
    padding: space.md,
  },
  stripHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stripNumber: { color: colors.text, fontSize: 24, lineHeight: 28, fontWeight: '800', letterSpacing: -0.6 },
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
  caption: { ...t.small, lineHeight: 22 },
  chips: { paddingHorizontal: space.md, paddingBottom: space.md },
});
