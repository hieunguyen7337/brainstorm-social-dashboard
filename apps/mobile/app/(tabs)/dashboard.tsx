import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { api, type Platform } from '@/src/api';
import { LIVE_PLATFORMS } from '@/src/platforms';
import { useConnectSheet } from '@/src/components/connect/ConnectSheet';
import {
  ActivityCard,
  ConnectCta,
  DashboardBoard,
  DashboardSkeleton,
  FollowersTile,
  FunnelCard,
  KpiGrid,
  PlatformDonutCard,
  RealPeopleCard,
  ReconnectingChip,
  Reveal,
  TopPostsCard,
  TrendCard,
  dashMode,
  followerChips,
  pickLinkPost,
  sortedDays,
} from '@/src/components/dashboard';
import { InstallQr } from '@/src/components/share/InstallQr';
import { TopBanners } from '@/src/components/dashboard/TopBanners';
import { APP_NAME, POLL_MS } from '@/src/config';
import { useAsync } from '@/src/hooks';
import { useWide } from '@/src/layout';
import { useIsAccountsWorkspace, useSession } from '@/src/session';
import { platformMeta, space } from '@/src/theme';
import { Card, Chip, ComingSoonLine, ChipStrip, ErrorState, Screen } from '@/src/ui';

/** After "Open a tracked link" fires, re-fetch quietly at these delays instead of waiting for the next 5 s poll. */
const QUICK_REFRESH_MS = [900, 2600];
/** Connections change only when the person saves numbers (which refetches at once), so a slow beat is plenty. */
const CONNECTIONS_POLL_MS = POLL_MS * 3;

export default function DashboardScreen() {
  // Wide windows (>= 1024 px) get the board; below that the phone column below renders exactly as it always did.
  const wide = useWide();
  const { workspace } = useSession();
  // docs/REAL.md: a real workspace shows only what the person connected, and so does the demo workspace (with synthetic
  // numbers); an old sample one renders exactly as it always did.
  const real = useIsAccountsWorkspace();
  // Bumps after every save in the connect dialog, so a save refreshes this screen at once instead of at the next poll.
  const { version } = useConnectSheet();
  const [platform, setPlatform] = useState<Platform | null>(null);
  // Bumping this re-runs the loaders quietly (no skeleton, no pull-to-refresh spinner).
  const [nonce, setNonce] = useState(0);
  // Bumped by a manual refresh so the board's own loaders (trends, posts, connectors, insights) re-run too.
  const [boardNonce, setBoardNonce] = useState(0);

  // The result carries the filter it was fetched for, so numbers can tell "new filter" from "live increment".
  const dash = useAsync(
    async () => ({ platform, summary: await api.getDashboard({ days: 30, platform }) }),
    [platform, nonce, version],
    { intervalMs: POLL_MS },
  );
  const activity = useAsync(() => api.getActivity(20), [nonce, version], { intervalMs: POLL_MS });
  // Loaded once here and shared with the board: in a real workspace the connections decide between the call to action
  // and the numbers. A sample workspace needs them only for the board's connectors card, as it always did.
  const needConnections = real || wide;
  const connections = useAsync(() => api.listConnections(), [version], {
    intervalMs: CONNECTIONS_POLL_MS,
    enabled: needConnections,
  });
  const mode = dashMode(real, connections);
  // Newest published posts, kept warm (refetched on focus) so the tracked-link button can open the browser inside
  // the tap itself: iOS Safari blocks a popup opened after an awaited request.
  const latest = useAsync(() => api.listPosts({ status: 'published', limit: 10 }), []);

  const summary = dash.data?.summary;
  // The filter the numbers on screen belong to (the chip selection can be ahead of it for a moment).
  const dataPlatform = dash.data?.platform ?? null;
  const dataContext = dataPlatform ?? 'all';
  const days = useMemo(() => (summary ? sortedDays(summary.timeseries).slice(-30) : []), [summary]);
  const linkPost = useMemo(() => (latest.data ? pickLinkPost(latest.data) : undefined), [latest.data]);
  // The summary says 'real' (docs/REAL.md): a change of 0 means nothing earlier to compare, so the tiles say "new".
  const realNumbers = summary?.data_mode === 'real';
  // Real workspace: the Followers tile (hidden when an older server sends no total) and where those followers are.
  const followers =
    real && summary && typeof summary.followers_total === 'number'
      ? { total: summary.followers_total, chips: followerChips(summary.by_platform, connections.data, dataPlatform) }
      : undefined;

  const { reload: reloadDash } = dash;
  const { reload: reloadActivity } = activity;
  const { reload: reloadLatest } = latest;
  const { reload: reloadConnections } = connections;
  const reloadAll = useCallback(() => {
    setBoardNonce((n) => n + 1);
    // `reload` fetches even when the loader is disabled: a sample phone never asked for the connections.
    void Promise.all([reloadDash(), reloadActivity(), reloadLatest(), needConnections ? reloadConnections() : undefined]);
  }, [reloadDash, reloadActivity, reloadLatest, reloadConnections, needConnections]);

  const quickTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      quickTimers.current.forEach(clearTimeout);
    },
    [],
  );
  const refreshSoon = useCallback(() => {
    quickTimers.current.forEach(clearTimeout);
    quickTimers.current = QUICK_REFRESH_MS.map((ms) => setTimeout(() => setNonce((n) => n + 1), ms));
  }, []);

  const brand = workspace?.brand_name?.trim() || workspace?.name?.trim() || APP_NAME;
  const reconnecting = (!!dash.error && !!dash.data) || (!!activity.error && !!activity.data);

  const refreshing = dash.refreshing || activity.refreshing || connections.refreshing;

  if (wide) {
    return (
      <Screen bare title="Dashboard" onRefresh={reloadAll} refreshing={refreshing}>
        <TopBanners />
        <DashboardBoard
          brand={brand}
          dash={dash}
          activity={activity}
          connections={connections}
          days={days}
          platform={platform}
          onPlatform={setPlatform}
          linkPost={linkPost}
          onFired={refreshSoon}
          reconnecting={reconnecting}
          reloadSignal={boardNonce}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title="Dashboard"
      subtitle={`${brand} · Last 30 days`}
      right={reconnecting ? <ReconnectingChip /> : undefined}
      onRefresh={reloadAll}
      refreshing={refreshing}
    >
      <TopBanners />
      {mode === 'loading' ? (
        // A real workspace waits for its connections before drawing anything: no flash of charts, then a call to action.
        <DashboardSkeleton followers />
      ) : mode === 'empty' ? (
        <>
          <Reveal index={0}>
            <ConnectCta />
          </Reveal>
          <Reveal index={1}>
            <InstallQr />
          </Reveal>
        </>
      ) : !summary ? (
        // First load: skeleton. If it failed, a retry (the skeleton shows again while the retry is in flight).
        dash.error && !dash.refreshing ? (
          <Card>
            <ErrorState
              title="Couldn't load your dashboard"
              message={dash.error.message || 'Something went wrong.'}
              onRetry={() => void reloadDash()}
            />
          </Card>
        ) : (
          <DashboardSkeleton />
        )
      ) : (
        <>
          <Reveal index={0}>
            <ChipStrip>
              <Chip label="All" icon="apps" selected={platform === null} onPress={() => setPlatform(null)} />
              {LIVE_PLATFORMS.map((p) => (
                <Chip
                  key={p}
                  label={platformMeta[p].label}
                  platform={p}
                  selected={platform === p}
                  onPress={() => setPlatform(p)}
                />
              ))}
            </ChipStrip>
            <ComingSoonLine />
          </Reveal>

          <Reveal index={1}>
            {followers ? (
              <View style={styles.kpis}>
                <FollowersTile total={followers.total} chips={followers.chips} context={dataContext} />
                <KpiGrid
                  totals={summary.totals}
                  change={summary.change_pct}
                  timeseries={days}
                  context={dataContext}
                  real={realNumbers}
                  tiles={summary.tiles}
                  notRead={summary.not_read}
                />
              </View>
            ) : (
              <KpiGrid
                totals={summary.totals}
                change={summary.change_pct}
                timeseries={days}
                context={dataContext}
                real={realNumbers}
                tiles={summary.tiles}
                notRead={summary.not_read}
              />
            )}
          </Reveal>

          <Reveal index={2}>
            <InstallQr />
          </Reveal>

          <Reveal index={2}>
            <RealPeopleCard
              clicks={summary.real_clicks}
              conversions={summary.real_conversions}
              notRead={summary.tiles?.clicks === null}
              context={dataContext}
              filterLabel={dataPlatform ? platformMeta[dataPlatform].label : undefined}
              linkPost={linkPost}
              onFired={refreshSoon}
            />
          </Reveal>

          <Reveal index={3}>
            <PlatformDonutCard byPlatform={summary.by_platform} totalViews={summary.totals.views} />
          </Reveal>

          <Reveal index={4}>
            <FunnelCard stages={summary.funnel} />
          </Reveal>

          <Reveal index={5}>
            <TrendCard timeseries={days} totals={summary.totals} context={dataContext} />
          </Reveal>

          <Reveal index={6}>
            <TopPostsCard posts={summary.top_posts} />
          </Reveal>

          <Reveal index={7}>
            <ActivityCard
              items={activity.data}
              loading={activity.loading}
              error={activity.error}
              onRetry={() => void reloadActivity()}
            />
          </Reveal>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // The Followers tile sits above the 2x2 KPI grid with the grid's own gap.
  kpis: { gap: space.md },
});
