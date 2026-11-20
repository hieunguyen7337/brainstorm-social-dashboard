import { StyleSheet, View } from 'react-native';

import { colors, radius, space } from '@/src/theme';
import { Card, Skeleton } from '@/src/ui';
import { KPI_PAD, KPI_SPARK_HEIGHT, useKpiLayout } from './KpiGrid';
import { METRICS } from './model';

const CHIP_WIDTHS = [52, 96, 108, 50, 84, 80, 98];
const FUNNEL_WIDTHS: `${number}%`[] = ['100%', '72%', '46%', '24%'];

function CardTitle({ width = '38%' }: { width?: `${number}%` | number }) {
  return (
    <View style={styles.title}>
      <Skeleton width={width} height={18} />
      <Skeleton width="55%" height={11} />
    </View>
  );
}

/**
 * Placeholder with the same structure as the loaded dashboard (chips, KPI grid, then the cards). `followers`: a real
 * workspace, whose KPI grid has the full-width Followers tile above it.
 */
export function DashboardSkeleton({ followers = false }: { followers?: boolean }) {
  const { onLayout, tileWidth } = useKpiLayout();
  const kpis = (
    <View style={styles.grid} onLayout={onLayout}>
      {METRICS.map((m) => (
        <Card key={m.key} padded={false} style={{ width: tileWidth }}>
          <View style={styles.kpiTop}>
            <Skeleton width={70} height={11} />
            <Skeleton width="60%" height={30} rounded={8} />
            <Skeleton width={58} height={22} rounded={11} />
          </View>
          <Skeleton height={KPI_SPARK_HEIGHT} rounded={0} />
        </Card>
      ))}
    </View>
  );
  return (
    <>
      <View style={styles.chips}>
        {CHIP_WIDTHS.map((w, i) => (
          <Skeleton key={i} width={w} height={36} rounded={18} />
        ))}
      </View>

      {followers ? (
        <View style={styles.kpiStack}>
          <Card padded={false}>
            <View style={styles.kpiTop}>
              <Skeleton width={70} height={11} />
              <Skeleton width="34%" height={30} rounded={8} />
              <Skeleton width="62%" height={28} rounded={14} />
            </View>
          </Card>
          {kpis}
        </View>
      ) : (
        kpis
      )}

      <Card style={styles.card}>
        <CardTitle width="34%" />
        <View style={styles.pair}>
          <Skeleton height={84} rounded={14} style={styles.flex} />
          <Skeleton height={84} rounded={14} style={styles.flex} />
        </View>
        <Skeleton height={12} />
        <Skeleton width="70%" height={12} />
        <Skeleton height={48} rounded={radius.md} />
      </Card>

      <Card style={styles.card}>
        <CardTitle width="46%" />
        <View style={styles.donut}>
          <Skeleton width={160} height={160} rounded={80} />
          <View style={styles.legend}>
            <Skeleton width="80%" height={12} />
            <Skeleton width="65%" height={12} />
            <Skeleton width="72%" height={12} />
          </View>
        </View>
      </Card>

      <Card style={styles.card}>
        <CardTitle width="32%" />
        <View style={styles.funnel}>
          {FUNNEL_WIDTHS.map((w) => (
            <Skeleton key={w} width={w} height={38} rounded={10} />
          ))}
        </View>
      </Card>

      <Card style={styles.card}>
        <CardTitle width="36%" />
        <Skeleton height={200} rounded={12} />
      </Card>

      <Card style={styles.card}>
        <CardTitle width="28%" />
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.row}>
            <Skeleton width={36} height={36} rounded={18} />
            <View style={styles.rowText}>
              <Skeleton height={13} />
              <Skeleton width="45%" height={11} />
            </View>
          </View>
        ))}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', gap: space.sm, overflow: 'hidden' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  kpiStack: { gap: space.md },
  kpiTop: { padding: KPI_PAD, paddingBottom: space.sm, gap: 10 },
  card: { gap: space.md, backgroundColor: colors.card },
  title: { gap: 6 },
  pair: { flexDirection: 'row', gap: space.md },
  flex: { flex: 1 },
  donut: { flexDirection: 'row', alignItems: 'center', gap: space.xl },
  legend: { flex: 1, gap: space.md },
  funnel: { gap: space.sm, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowText: { flex: 1, gap: 6 },
});
