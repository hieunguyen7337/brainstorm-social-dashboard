import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  AreaChart,
  Donut,
  Funnel,
  type ChartSeries,
  type DonutDatum,
  type FunnelDatum,
} from '@/src/charts';
import { fmtCompact } from '@/src/format';
import { platformMeta, space, type as t } from '@/src/theme';
import type { DayStats, FunnelStage, PlatformStats, Totals } from '@/src/types';
import { Card, Chip, ChipRow, SectionHeader } from '@/src/ui';
import { LiveNumber, useStable } from './live';
import { FUNNEL_LABELS, FUNNEL_ORDER, METRIC_BY_KEY, METRICS, isPlatform, type MetricKey } from './model';

function NoData({ text }: { text: string }) {
  return <Text style={[t.dim, styles.noData]}>{text}</Text>;
}

/** Share of views per platform as a donut with the total in the hole. */
export function PlatformDonutCard({ byPlatform, totalViews }: { byPlatform: PlatformStats[]; totalViews: number }) {
  const slices: DonutDatum[] = byPlatform
    .filter((p) => isPlatform(p.platform) && p.views > 0)
    .sort((a, b) => b.views - a.views)
    .map((p) => ({
      key: p.platform,
      label: platformMeta[p.platform].label,
      value: p.views,
      color: platformMeta[p.platform].color,
    }));
  const data = useStable(slices, slices.map((s) => `${s.key}:${s.value}`).join('|'));

  return (
    <Card style={styles.card}>
      <SectionHeader title="Views by platform" subtitle="Share of views, last 30 days" />
      {data.length === 0 ? (
        <NoData text="No views yet. Publish a post and they will show up here." />
      ) : (
        <Donut data={data} centerValue={fmtCompact(totalViews)} centerLabel="views" legend title="Views by platform" />
      )}
    </Card>
  );
}

/** Views -> Engagement -> Clicks -> Onboard with the step rates. */
export function FunnelCard({ stages }: { stages: FunnelStage[] }) {
  const rows: FunnelDatum[] = FUNNEL_ORDER.flatMap((name) => {
    const s = stages.find((x) => x.stage === name);
    return s ? [{ key: s.stage, label: FUNNEL_LABELS[s.stage], value: s.value, rate: s.rate }] : [];
  });
  const data = useStable(rows, rows.map((r) => `${r.key}:${r.value}:${r.rate}`).join('|'));
  const empty = data.length === 0 || data.every((d) => d.value === 0);

  return (
    <Card style={styles.card}>
      <SectionHeader title="Sales funnel" subtitle="From first view to onboarded customer" />
      {empty ? (
        <NoData text="No traffic yet. The funnel fills as people view and click your posts." />
      ) : (
        <Funnel data={data} title="Sales funnel from views to onboard" />
      )}
    </Card>
  );
}

/** Daily area chart with a metric switcher. `timeseries` is oldest first. */
export function TrendCard({
  timeseries,
  totals,
  context,
}: {
  timeseries: DayStats[];
  totals: Totals;
  /** Changes when the data switches to another filter, so the total does not flash for it. */
  context: string;
}) {
  const [metric, setMetric] = useState<MetricKey>('views');
  const def = METRIC_BY_KEY[metric];

  const days = timeseries.map((d) => d.day);
  const values = timeseries.map((d) => d[metric]);
  const labels = useStable(days, days.join('|'));
  const series = useStable<ChartSeries[]>(
    [{ key: metric, label: def.chip, color: def.color, values }],
    `${metric}:${values.join(',')}`,
  );

  return (
    <Card style={styles.card}>
      <SectionHeader
        title="Last 30 days"
        subtitle="Daily totals"
        right={
          <View style={styles.total} accessible accessibilityLabel={`${fmtCompact(totals[metric])} ${def.chip} in total`}>
            <LiveNumber
              value={totals[metric]}
              format={fmtCompact}
              context={`${context}:${metric}`}
              style={[styles.totalNumber, { color: def.color }]}
            />
            <Text style={t.small}>total</Text>
          </View>
        }
      />
      {/* Slightly tighter than the default chip so all four fit on one row at 390px (they wrap on narrower phones). */}
      <ChipRow style={styles.switcher}>
        {METRICS.map((m) => (
          <Chip
            key={m.key}
            small
            label={m.chip}
            color={m.color}
            selected={m.key === metric}
            onPress={() => setMetric(m.key)}
            style={styles.switcherChip}
          />
        ))}
      </ChipRow>
      {labels.length === 0 ? (
        <NoData text="No daily data yet." />
      ) : (
        <AreaChart
          labels={labels}
          series={series}
          height={200}
          formatValue={fmtCompact}
          title={`${def.chip}, last 30 days`}
        />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  noData: { textAlign: 'center', paddingVertical: space.xl },
  switcher: { gap: 6 },
  switcherChip: { paddingHorizontal: 8 },
  total: { alignItems: 'flex-end' },
  totalNumber: { fontSize: 22, lineHeight: 26, fontWeight: '800', letterSpacing: -0.5 },
});
