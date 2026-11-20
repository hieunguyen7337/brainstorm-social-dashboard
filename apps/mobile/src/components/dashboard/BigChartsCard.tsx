import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, space } from '@/src/theme';
import type { DashboardSummary, DayStats } from '@/src/types';
import { Card } from '@/src/ui';
import { BOARD_FUNNEL_LABELS } from './boardModel';
import { FunnelCard, PlatformDonutCard, TrendCard } from './ChartCards';

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
  return (
    <Card style={[styles.card, style]}>
      <View style={styles.pair}>
        <View style={styles.half}>
          <PlatformDonutCard bare byPlatform={summary.by_platform} totalViews={summary.totals.views} />
        </View>
        <View style={styles.half}>
          <FunnelCard bare stages={summary.funnel} labels={BOARD_FUNNEL_LABELS} chartHeight={280} />
        </View>
      </View>
      <View style={styles.divider} />
      <TrendCard bare timeseries={days} totals={summary.totals} context={context} chartHeight={210} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.lg },
  pair: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xl },
  half: { flex: 1, minWidth: 0 },
  divider: { height: 1, backgroundColor: colors.border },
});
