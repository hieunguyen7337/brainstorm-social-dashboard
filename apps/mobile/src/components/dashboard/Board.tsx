/**
 * The wide (>= 1024 px) Dashboard: the founders' whiteboard as a 12-column board of big cards.
 *
 *   row 1   header strip + KPI tiles + "Real people"  (cols 1-8)  |  Outside trends        (cols 9-12)
 *   row 2   donut | funnel, 30-day chart under them   (cols 1-8)  |  Generate + Themes     (cols 9-12, rows 2-3)
 *   row 3   Social media connectors                   (cols 1-8)  |  (the column above)
 *   row 4   Top posts (cols 1-6)                                  |  Live activity         (cols 7-12)
 *
 * The screen owns the dashboard and activity loaders (shared with the phone layout); the board loads the rest
 * (trends, posts, connectors, insights) itself, so phones never fetch them. A failing side loader only empties its
 * own card: nothing here can take the rest of the board down.
 */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { api, PLATFORMS, type ActivityItem, type DashboardSummary, type DayStats, type Platform, type Post } from '@/src/api';
import { POLL_MS } from '@/src/config';
import { useAsync, type AsyncState } from '@/src/hooks';
import { Col, Grid } from '@/src/layout';
import { platformMeta, space, type as t } from '@/src/theme';
import { Card, Chip, ChipRow, ErrorState, Skeleton } from '@/src/ui';
import { ActivityCard } from './ActivityCard';
import { BigChartsCard } from './BigChartsCard';
import { BoardKpis } from './BoardKpis';
import { ConnectorsCard } from './ConnectorsCard';
import { GenerateCard } from './GenerateColumn';
import { ReconnectingChip, Reveal, LiveTag } from './live';
import { OutsideTrendsCard } from './OutsideTrendsCard';
import { RealPeopleCard } from './RealPeopleCard';
import { ThemesCard } from './ThemesCard';
import { TopPostsCard } from './TopPostsCard';

/** Trends move slowly (the API caches the feeds); everything else follows the dashboard's 5 s beat or a third of it. */
const TRENDS_POLL_MS = 60_000;
const SLOW_POLL_MS = POLL_MS * 3;
const ACTIVITY_ROWS = 6;

type DashData = { platform: Platform | null; summary: DashboardSummary };

export interface DashboardBoardProps {
  brand: string;
  dash: AsyncState<DashData>;
  activity: AsyncState<ActivityItem[]>;
  /** Daily rows of the loaded summary, oldest first. */
  days: DayStats[];
  platform: Platform | null;
  onPlatform: (p: Platform | null) => void;
  /** Latest published post with a tracked link (for the "Open a tracked link" button). */
  linkPost: Post | undefined;
  onFired: () => void;
  reconnecting: boolean;
  /** Bumps when the person pulls to refresh / taps Refresh: the board's own loaders re-run quietly. */
  reloadSignal: number;
}

export function DashboardBoard({
  brand,
  dash,
  activity,
  days,
  platform,
  onPlatform,
  linkPost,
  onFired,
  reconnecting,
  reloadSignal,
}: DashboardBoardProps) {
  const trends = useAsync(() => api.listTrends({ limit: 5 }), [reloadSignal], { intervalMs: TRENDS_POLL_MS });
  const posts = useAsync(() => api.listPosts({ limit: 200 }), [reloadSignal], { intervalMs: POLL_MS });
  const connections = useAsync(() => api.listConnections(), [reloadSignal], { intervalMs: SLOW_POLL_MS });
  const insights = useAsync(() => api.getInsights({ days: 30 }), [reloadSignal], { intervalMs: SLOW_POLL_MS });

  const summary = dash.data?.summary;
  // The filter the numbers on screen belong to (the chip selection can be ahead of it for a moment).
  const dataPlatform = dash.data?.platform ?? null;
  const dataContext = dataPlatform ?? 'all';

  const { setData: setPosts, reload: reloadPosts } = posts;
  const onGenerated = (created: Post[]) => {
    setPosts((prev) => [...created, ...(prev ?? []).filter((p) => !created.some((c) => c.id === p.id))]);
    void reloadPosts();
  };

  const header = <BoardHeader brand={brand} platform={platform} onPlatform={onPlatform} reconnecting={reconnecting} />;

  return (
    <Grid testID="dashboard-board">
      {/* Row 1 left: header strip, KPI tiles, Real people. */}
      <Col span={8} start={1} row={1}>
        <Reveal index={0} style={styles.fill}>
          <View style={styles.stack}>
            {header}
            {summary ? (
              <BoardKpis totals={summary.totals} change={summary.change_pct} timeseries={days} context={dataContext} />
            ) : (
              <KpiSkeleton />
            )}
            {summary ? (
              <RealPeopleCard
                compact
                clicks={summary.real_clicks}
                conversions={summary.real_conversions}
                context={dataContext}
                filterLabel={dataPlatform ? platformMeta[dataPlatform].label : undefined}
                linkPost={linkPost}
                onFired={onFired}
              />
            ) : (
              <Skeleton height={64} rounded={16} />
            )}
          </View>
        </Reveal>
      </Col>

      {/* Row 1 right. */}
      <Col span={4} start={9} row={1}>
        <Reveal index={1} style={styles.fill}>
          <OutsideTrendsCard
            style={styles.fill}
            trends={trends.data}
            loading={trends.loading}
            error={trends.error}
            onRetry={() => void trends.reload()}
          />
        </Reveal>
      </Col>

      {/* Row 2 left: the big card. */}
      <Col span={8} start={1} row={2}>
        <Reveal index={2} style={styles.fill}>
          {summary ? (
            <BigChartsCard style={styles.fill} summary={summary} days={days} context={dataContext} />
          ) : dash.error && !dash.refreshing ? (
            <Card style={styles.fill}>
              <ErrorState
                title="Couldn't load your dashboard"
                message={dash.error.message || 'Something went wrong.'}
                onRetry={() => void dash.reload()}
              />
            </Card>
          ) : (
            <ChartsSkeleton />
          )}
        </Reveal>
      </Col>

      {/* Rows 2-3 right: Generate on top, Themes (Jev AI) below it taking the rest of the column. */}
      <Col span={4} start={9} row={2} rowSpan={2} style={styles.column}>
        <Reveal index={3}>
          <GenerateCard posts={Array.isArray(posts.data) ? posts.data : undefined} loading={posts.loading} onGenerated={onGenerated} />
        </Reveal>
        <Reveal index={4} style={styles.fill}>
          <ThemesCard
            style={styles.fill}
            insights={insights.data}
            loading={insights.loading}
            error={insights.error}
            onRetry={() => void insights.reload()}
          />
        </Reveal>
      </Col>

      {/* Row 3 left. */}
      <Col span={8} start={1} row={3}>
        <Reveal index={5} style={styles.fill}>
          <ConnectorsCard
            style={styles.fill}
            connections={connections.data}
            loading={connections.loading}
            error={connections.error}
            onRetry={() => void connections.reload()}
          />
        </Reveal>
      </Col>

      {/* Row 4: Top posts and the live feed side by side. */}
      <Col span={6} start={1} row={4}>
        <Reveal index={6} style={styles.fill}>
          {summary ? (
            <TopPostsCard style={styles.fill} posts={summary.top_posts} />
          ) : (
            <Card style={styles.fill}>
              <Skeleton height={200} rounded={12} />
            </Card>
          )}
        </Reveal>
      </Col>
      <Col span={6} start={7} row={4}>
        <Reveal index={7} style={styles.fill}>
          <ActivityCard
            style={styles.fill}
            maxRows={ACTIVITY_ROWS}
            items={activity.data}
            loading={activity.loading}
            error={activity.error}
            onRetry={() => void activity.reload()}
          />
        </Reveal>
      </Col>
    </Grid>
  );
}

/** "Dashboard" with the workspace name, the live tag and the platform filter chips. */
function BoardHeader({
  brand,
  platform,
  onPlatform,
  reconnecting,
}: {
  brand: string;
  platform: Platform | null;
  onPlatform: (p: Platform | null) => void;
  reconnecting: boolean;
}) {
  return (
    <View style={styles.head}>
      <View style={styles.titleRow}>
        <View style={styles.headText}>
          <View style={styles.titleLine}>
            <Text style={t.h1} accessibilityRole="header">
              Dashboard
            </Text>
            <LiveTag />
          </View>
          <Text style={[t.dim, styles.subtitle]} numberOfLines={1}>{`${brand} · Last 30 days`}</Text>
        </View>
        {reconnecting ? <ReconnectingChip /> : null}
      </View>
      <ChipRow style={styles.chips}>
        <Chip small label="All" icon="apps" selected={platform === null} onPress={() => onPlatform(null)} />
        {PLATFORMS.map((p) => (
          <Chip
            key={p}
            small
            label={platformMeta[p].label}
            platform={p}
            selected={platform === p}
            onPress={() => onPlatform(p)}
          />
        ))}
      </ChipRow>
    </View>
  );
}

function KpiSkeleton() {
  return (
    <View style={styles.kpiSkeleton}>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={132} rounded={16} style={styles.fill} />
      ))}
    </View>
  );
}

function ChartsSkeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <Card style={[styles.fill, styles.skeletonCard, style]}>
      <View style={styles.skeletonPair}>
        <Skeleton height={240} rounded={16} style={styles.fill} />
        <Skeleton height={240} rounded={16} style={styles.fill} />
      </View>
      <Skeleton height={210} rounded={12} />
    </Card>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Spare height (the row is as tall as the trends card) becomes air between the three blocks.
  stack: { flex: 1, gap: space.lg, justifyContent: 'space-between' },
  column: { gap: space.lg },
  head: { gap: space.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  headText: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  subtitle: { marginTop: 2 },
  chips: { gap: 6 },
  kpiSkeleton: { flexDirection: 'row', gap: space.md, flex: 1 },
  skeletonCard: { gap: space.lg },
  skeletonPair: { flexDirection: 'row', gap: space.xl },
});
