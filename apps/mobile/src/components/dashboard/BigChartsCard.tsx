import { useCallback, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { colors, space } from '@/src/theme';
import type { DashboardSummary, DayStats } from '@/src/types';
import { Card } from '@/src/ui';
import { BOARD_FUNNEL_LABELS } from './boardModel';
import { FunnelCard, PlatformDonutCard, TrendCard } from './ChartCards';

/** Inner width from which the donut gets the wider half, so its legend sits beside the ring (the Donut's own switch is 480). */
const ROOMY_AT = 730;
const DONUT_BASIS = 484;

/**
 * The big card of the board: the views-by-platform donut and the sales funnel side by side, the 30-day area chart
 * under both. It reuses the phone's chart cards, drawn without their own card frames.
 */
export function BigChartsCard({
  summary,
  days,
  context,
  style,
}: {
  summary: DashboardSummary;
  /** Daily rows, oldest first. */
  days: DayStats[];
  /** Changes when the data switches to another filter, so the total does not flash for it. */
  context: string;
  style?: StyleProp<ViewStyle>;
}) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidth((prev) => (prev === w ? prev : w));
  }, []);
  // Roomy (>= ~1280 px windows): ring and legend side by side. Tight (the ~800 px board at 1024): equal halves, legend
  // under the ring, so the funnel gets the extra height instead.
  const roomy = width >= ROOMY_AT;

  return (
    <Card style={[styles.card, style]}>
      <View style={styles.inner} onLayout={onLayout}>
        <View style={styles.pair}>
          <View style={[styles.half, roomy && styles.donutHalf]}>
            <PlatformDonutCard bare byPlatform={summary.by_platform} totalViews={summary.totals.views} />
          </View>
          <View style={styles.half}>
            <FunnelCard bare stages={summary.funnel} labels={BOARD_FUNNEL_LABELS} chartHeight={roomy ? 260 : 400} />
          </View>
        </View>
        <View style={styles.divider} />
        <TrendCard bare timeseries={days} totals={summary.totals} context={context} chartHeight={roomy ? 330 : 220} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.lg },
  inner: { gap: space.lg },
  pair: { flexDirection: 'row', alignItems: 'flex-start', gap: space.lg },
  half: { flex: 1, minWidth: 0 },
  donutHalf: { flexGrow: 0, flexShrink: 0, flexBasis: DONUT_BASIS },
  divider: { height: 1, backgroundColor: colors.border },
});
