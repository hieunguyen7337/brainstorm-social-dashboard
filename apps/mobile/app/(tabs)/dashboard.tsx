import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, PLATFORMS, type Platform } from '@/src/api';
import {
  ActivityCard,
  DashboardSkeleton,
  FunnelCard,
  InsightsCard,
  KpiGrid,
  PlatformDonutCard,
  RealPeopleCard,
  ReconnectingChip,
  Reveal,
  TopPostsCard,
  TrendCard,
  pickLinkPost,
  sortedDays,
} from '@/src/components/dashboard';
import { APP_NAME, POLL_MS } from '@/src/config';
import { useAsync } from '@/src/hooks';
import { useSession } from '@/src/session';
import { platformMeta } from '@/src/theme';
import { Card, Chip, ChipStrip, ErrorState, Screen } from '@/src/ui';

/** After "Open a tracked link" fires, re-fetch quietly at these delays instead of waiting for the next 5 s poll. */
const QUICK_REFRESH_MS = [900, 2600];

export default function DashboardScreen() {
  const { workspace } = useSession();
  const [platform, setPlatform] = useState<Platform | null>(null);
  // Bumping this re-runs the loaders quietly (no skeleton, no pull-to-refresh spinner).
  const [nonce, setNonce] = useState(0);

  // The result carries the filter it was fetched for, so numbers can tell "new filter" from "live increment".
  const dash = useAsync(
    async () => ({ platform, summary: await api.getDashboard({ days: 30, platform }) }),
    [platform, nonce],
    { intervalMs: POLL_MS },
  );
  const activity = useAsync(() => api.getActivity(20), [nonce], { intervalMs: POLL_MS });
  // Newest published posts, kept warm (refetched on focus) so the tracked-link button can open the browser inside
  // the tap itself: iOS Safari blocks a popup opened after an awaited request.
  const latest = useAsync(() => api.listPosts({ status: 'published', limit: 10 }), []);

  const summary = dash.data?.summary;
  // The filter the numbers on screen belong to (the chip selection can be ahead of it for a moment).
  const dataPlatform = dash.data?.platform ?? null;
  const dataContext = dataPlatform ?? 'all';
  const days = useMemo(() => (summary ? sortedDays(summary.timeseries).slice(-30) : []), [summary]);
  const linkPost = useMemo(() => (latest.data ? pickLinkPost(latest.data) : undefined), [latest.data]);

  const { reload: reloadDash } = dash;
  const { reload: reloadActivity } = activity;
  const { reload: reloadLatest } = latest;
  const reloadAll = useCallback(() => {
    void Promise.all([reloadDash(), reloadActivity(), reloadLatest()]);
  }, [reloadDash, reloadActivity, reloadLatest]);

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

  return (
    <Screen
      title="Dashboard"
      subtitle={brand.toLowerCase() === (workspace?.name ?? '').trim().toLowerCase() ? 'Last 30 days' : `${brand} · last 30 days`}
      right={reconnecting ? <ReconnectingChip /> : undefined}
      onRefresh={reloadAll}
      refreshing={dash.refreshing || activity.refreshing}
    >
      {!summary ? (
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
              {PLATFORMS.map((p) => (
                <Chip
                  key={p}
                  label={platformMeta[p].label}
                  platform={p}
                  testID={`filter-platform-${p}`}
                  selected={platform === p}
                  onPress={() => setPlatform(p)}
                />
              ))}
            </ChipStrip>
          </Reveal>

          <Reveal index={1}>
            <KpiGrid totals={summary.totals} change={summary.change_pct} timeseries={days} context={dataContext} />
          </Reveal>

          <Reveal index={2}>
            <RealPeopleCard
              clicks={summary.real_clicks}
              conversions={summary.real_conversions}
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

          <InsightsCard revealIndex={6} />

          <Reveal index={7}>
            <TopPostsCard posts={summary.top_posts} />
          </Reveal>

          <Reveal index={8}>
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
