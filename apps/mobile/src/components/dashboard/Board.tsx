/**
 * The wide (>= 1024 px) Dashboard: the founders' whiteboard as a 12-column board of big cards.
 *
 *   row 1   header strip + KPI tiles + "Real people"  (cols 1-8)  |  Outside trends        (cols 9-12)
 *   row 2   donut | funnel, 30-day chart under them   (cols 1-8)  |  Generate + Themes     (cols 9-12, rows 2-3)
 *   row 3   Social media connectors                   (cols 1-8)  |  (the column above)
 *   row 4   Top posts (cols 1-6)                                  |  Live activity         (cols 7-12)
 *
 * A real workspace with nothing connected (docs/REAL.md) has no numbers to draw: the header strip keeps its place and
 * the call to action takes the rest of the big left area; only the cards without numbers stay.
 *
 *   row 1   header strip + call to action             (cols 1-8)  |  Outside trends        (cols 9-12)
 *   row 2   Social media connectors                   (cols 1-8)  |  Generate              (cols 9-12, rows 2-3)
 *   row 3   Themes                                    (cols 1-8)  |  (the card above)
 *
 * The screen owns the dashboard, activity and connections loaders (shared with the phone layout); the board loads the
 * rest (trends, posts, harvest status, insights) itself, so phones never fetch them. A failing side loader only empties
 * its own card: nothing here can take the rest of the board down.
 */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  api,
  type ActivityItem,
  type Connection,
  type DashboardSummary,
  type DayStats,
  type Platform,
  type Post,
} from '@/src/api';
import { useConnectSheet } from '@/src/components/connect/ConnectSheet';
import { POLL_MS } from '@/src/config';
import { useAsync, type AsyncState } from '@/src/hooks';
import { Col, Grid } from '@/src/layout';
import { useIsRealWorkspace } from '@/src/session';
import { platformMeta, space, type as t } from '@/src/theme';
import { LIVE_PLATFORMS } from '@/src/platforms';
import { Card, Chip, ComingSoonLine, ChipRow, ErrorState, Skeleton } from '@/src/ui';
import { ActivityCard } from './ActivityCard';
import { BigChartsCard } from './BigChartsCard';
import { BoardKpis } from './BoardKpis';
import { ConnectCta } from './ConnectCta';
import { ConnectorsCard } from './ConnectorsCard';
import { GenerateCard } from './GenerateColumn';
import { ReconnectingChip, Reveal, LiveTag } from './live';
import { OutsideTrendsCard } from './OutsideTrendsCard';
import { RealPeopleCard } from './RealPeopleCard';
import { dashMode, followerChips } from './realModel';
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
  /**
   * The workspace's connections, loaded once by the screen. In a real workspace they decide between the call to action
   * and the numbers; the connectors card shows them either way.
   */
  connections: AsyncState<Connection[]>;
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
  connections,
  days,
  platform,
  onPlatform,
  linkPost,
  onFired,
  reconnecting,
  reloadSignal,
}: DashboardBoardProps) {
  const real = useIsRealWorkspace();
  // Bumps after every save in the connect dialog: what a save changes is refetched at once instead of at the next poll.
  const { version } = useConnectSheet();
  const trends = useAsync(() => api.listTrends({ limit: 5 }), [reloadSignal], { intervalMs: TRENDS_POLL_MS });
  const posts = useAsync(() => api.listPosts({ limit: 200 }), [reloadSignal, version], { intervalMs: POLL_MS });
  const insights = useAsync(() => api.getInsights({ days: 30 }), [reloadSignal, version], { intervalMs: SLOW_POLL_MS });
  // Best effort: when each platform's numbers were last saved. Its failure only means "Updated ..." falls back to the
  // connection's own times, so the error is never shown.
  const harvest = useAsync(() => api.getHarvestStatus(), [reloadSignal, version], {
    intervalMs: SLOW_POLL_MS,
    enabled: real,
  });

  // Real workspace: nothing numeric is drawn while the connections load (no flash of charts before the call to action).
  const mode = dashMode(real, connections);
  const waiting = mode === 'loading';
  const empty = mode === 'empty';

  const summary = waiting ? undefined : dash.data?.summary;
  // The filter the numbers on screen belong to (the chip selection can be ahead of it for a moment).
  const dataPlatform = dash.data?.platform ?? null;
  const dataContext = dataPlatform ?? 'all';
  const followers =
    real && summary && typeof summary.followers_total === 'number'
      ? { total: summary.followers_total, chips: followerChips(summary.by_platform, connections.data, dataPlatform) }
      : undefined;

  const { setData: setPosts, reload: reloadPosts } = posts;
  const onGenerated = (created: Post[]) => {
    setPosts((prev) => [...created, ...(prev ?? []).filter((p) => !created.some((c) => c.id === p.id))]);
    void reloadPosts();
  };

  const header = <BoardHeader brand={brand} platform={platform} onPlatform={onPlatform} reconnecting={reconnecting} />;

  // Keyed: they move between cells when the first account is connected, and fade in again in their new place.
  const connectors = (
    <Reveal key="connectors" index={5} style={styles.fill}>
      <ConnectorsCard
        style={styles.fill}
        connections={connections.data}
        loading={connections.loading}
        error={connections.error}
        onRetry={() => void connections.reload()}
        real={real}
        harvest={harvest.data}
      />
    </Reveal>
  );
  const themes = (
    <Reveal key="themes" index={4} style={styles.fill}>
      <ThemesCard
        style={styles.fill}
        insights={insights.data}
        loading={insights.loading}
        error={insights.error}
        onRetry={() => void insights.reload()}
      />
    </Reveal>
  );

  return (
    <Grid testID="dashboard-board">
      {/* Row 1 left: header strip, then the KPI tiles and Real people (or, with nothing connected, the call to action). */}
      <Col span={8} start={1} row={1}>
        <Reveal index={0} style={styles.fill}>
          <View style={styles.stack}>
            {header}
            {empty ? (
              <ConnectCta style={styles.fill} />
            ) : (
              <>
                {summary ? (
                  <BoardKpis
                    totals={summary.totals}
                    change={summary.change_pct}
                    timeseries={days}
                    context={dataContext}
                    real={summary.data_mode === 'real'}
                    followers={followers}
                    tiles={summary.tiles}
                    notRead={summary.not_read}
                    split={summary.engagement_split}
                  />
                ) : (
                  <KpiSkeleton count={real ? 5 : 4} />
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
              </>
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

      {/* Row 2 left: the big card (nothing connected: the connectors, the only card here that is not a number). */}
      <Col span={8} start={1} row={2}>
        {empty ? (
          connectors
        ) : (
          <Reveal key="charts" index={2} style={styles.fill}>
            {summary ? (
              <BigChartsCard style={styles.fill} summary={summary} days={days} context={dataContext} />
            ) : !waiting && dash.error && !dash.refreshing ? (
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
        )}
      </Col>

      {/* Rows 2-3 right: Generate on top, Themes (Jev AI) below it taking the rest of the column (nothing connected:
          Themes sits under the connectors on the left, so both columns end at about the same height). */}
      <Col span={4} start={9} row={2} rowSpan={2} style={styles.column}>
        <Reveal index={3} style={empty ? styles.fill : undefined}>
          <GenerateCard
            style={empty ? styles.fill : undefined}
            posts={Array.isArray(posts.data) ? posts.data : undefined}
            loading={posts.loading}
            onGenerated={onGenerated}
          />
        </Reveal>
        {empty ? null : themes}
      </Col>

      {/* Row 3 left. */}
      <Col span={8} start={1} row={3}>
        {empty ? themes : connectors}
      </Col>

      {/* Row 4: Top posts and the live feed side by side. Numbers, so not drawn until something is connected. */}
      {empty ? null : (
        <>
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
                items={waiting ? undefined : activity.data}
                loading={waiting || activity.loading}
                error={waiting ? null : activity.error}
                onRetry={() => void activity.reload()}
              />
            </Reveal>
          </Col>
        </>
      )}
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
        {LIVE_PLATFORMS.map((p) => (
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
      <ComingSoonLine />
    </View>
  );
}

/** A real workspace has a Followers tile in front of the four metrics. */
function KpiSkeleton({ count }: { count: number }) {
  return (
    <View style={styles.kpiSkeleton}>
      {Array.from({ length: count }, (_, i) => (
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
