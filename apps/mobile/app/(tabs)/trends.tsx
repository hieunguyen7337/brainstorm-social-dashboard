import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { api, ApiError, type Trend, type TrendSource, type TrendsStatus } from '@/src/api';
import { SourceHeader } from '@/src/components/trends/SourceBadge';
import { TrendGrid } from '@/src/components/trends/TrendGrid';
import { TrendRow } from '@/src/components/trends/TrendRow';
import { TrendsIntro } from '@/src/components/trends/TrendsIntro';
import { TrendsSkeleton } from '@/src/components/trends/TrendsSkeleton';
import {
  SOURCE_ORDER,
  sourceChipLabel,
  sourceIsComingSoon,
  SOURCE_SHORT,
  buildGroups,
  feedProblem,
  oldestFetchedAt,
  safeUrl,
  sourceEmptyMessage,
  type SourceFilter,
  type TrendGroup,
} from '@/src/components/trends/trendUtils';
import { useAsync } from '@/src/hooks';
import { useWide } from '@/src/layout';
import { useSession } from '@/src/session';
import { space, trendSourceMeta } from '@/src/theme';
import { Button, Chip, ChipStrip, EmptyState, ErrorState, Screen, haptic, useToast } from '@/src/ui';

/** How many trends to ask the server for (it ranks them for this workspace's brand first). */
const LIMIT = 30;
/** Only the first rows on screen ease their bars in; further down nobody sees it and long lists stay cheap. */
const ANIMATED_ROWS = 12;
/** First load only: row n fades in n * STAGGER_MS after the first, capped so the tail never makes you wait. */
const STAGGER_MS = 45;
const STAGGER_CAP = 10;

/** Feed status is extra: an old server (404) or a failed call must never break the list, so any error reads as "unknown". */
async function loadStatus(): Promise<TrendsStatus | null> {
  try {
    return (await api.trendsStatus()) ?? null;
  } catch {
    return null;
  }
}

/** http(s) links only. On the web it must run inside the tap handler (popup blockers), hence no `await` before it. */
async function openSource(url: string): Promise<boolean> {
  const target = safeUrl(url);
  if (!target) return false;
  try {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return false;
      window.open(target, '_blank', 'noopener');
      return true;
    }
    await Linking.openURL(target);
    return true;
  } catch {
    return false;
  }
}

export default function TrendsScreen() {
  const wide = useWide();
  const { workspace } = useSession();
  const { show } = useToast();
  const {
    data,
    error,
    loading,
    refreshing: reloading,
    reload,
    setData,
  } = useAsync(() => api.listTrends({ limit: LIMIT }), []);
  /** null = status unknown (not loaded yet, an old server, or the call failed). */
  const {
    data: statusData,
    reload: reloadStatus,
    setData: setStatus,
  } = useAsync<TrendsStatus | null>(loadStatus, []);
  const status = statusData ?? null;

  const [filter, setFilter] = useState<SourceFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** A forced refresh (server re-pulls the feeds) is in flight. */
  const [forcing, setForcing] = useState(false);
  /** The load error that a later successful forced refresh already superseded (keeps the offline note honest). */
  const [healed, setHealed] = useState<Error | null>(null);

  const brand = workspace?.brand_name?.trim() || workspace?.name?.trim() || 'your brand';

  const trends = useMemo<Trend[]>(() => (Array.isArray(data) ? data : []), [data]);
  const groups = useMemo(() => buildGroups(trends), [trends]);
  const counts = useMemo(() => {
    const c: Record<SourceFilter, number> = { all: 0, hackernews: 0, reddit: 0, google: 0 };
    for (const g of groups) {
      c[g.source] = g.items.length;
      c.all += g.items.length;
    }
    return c;
  }, [groups]);

  // What is on screen: every non-empty group for "All", else just the chosen source. `start` is the group's offset in
  // the whole visible list (drives the entrance stagger and which rows animate their bars).
  const sections = useMemo(() => {
    const out: { group: TrendGroup; start: number }[] = [];
    let start = 0;
    for (const group of groups) {
      if (group.items.length === 0 || (filter !== 'all' && group.source !== filter)) continue;
      out.push({ group, start });
      start += group.items.length;
    }
    return out;
  }, [groups, filter]);

  // Freshness is the OLDEST row on screen (the chosen source, or every source for "All"), so the header never claims
  // a fresher time than some trend on screen has. Falls back to every row when the chosen source has none.
  const shownTrends = useMemo(() => sections.flatMap(({ group }) => group.items), [sections]);
  const updatedAt = useMemo(
    () => oldestFetchedAt(shownTrends.length > 0 ? shownTrends : trends),
    [shownTrends, trends],
  );

  // Row entrance runs on the first load only: later mounts (filter changes, new rows after a refresh) just appear.
  const introPlayed = useRef(false);
  const playIntro = !introPlayed.current;
  useEffect(() => {
    if (trends.length > 0) introPlayed.current = true;
  }, [trends]);

  // ---- forced refresh -------------------------------------------------------------------------
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const busy = useRef(false);
  const latest = useRef<{ hasData: boolean; error: Error | null }>({ hasData: false, error: null });
  latest.current = { hasData: data !== undefined, error };

  /**
   * "Refresh" button, the empty-state button, pull-to-refresh (native) and the header button (web) all land here.
   * The old list stays on screen while the server re-pulls the feeds; failure only toasts.
   */
  const forceRefresh = useCallback(async () => {
    if (!latest.current.hasData) {
      // Nothing on screen yet: a refresh is just a (re)load of the list and its status.
      await Promise.all([reload(), reloadStatus()]);
      return;
    }
    if (busy.current) return;
    busy.current = true;
    setForcing(true);
    // The status is read after the server re-pulled the feeds; it runs alongside the list and never throws.
    const statusRefresh = loadStatus().then((next) => {
      if (alive.current) setStatus(next);
    });
    try {
      const fresh = await api.listTrends({ refresh: true, limit: LIMIT });
      if (!alive.current) return;
      setData(fresh);
      setHealed(latest.current.error);
      if (fresh.length > 0) show(`Trends refreshed · ${fresh.length} ${fresh.length === 1 ? 'trend' : 'trends'}`);
      else show('The feeds answered, but no trends came back', 'info');
    } catch (e) {
      // A 401 already sends the user back to onboarding; do not toast over that.
      if (alive.current && !(e instanceof ApiError && e.status === 401)) show("Couldn't refresh trends", 'error');
    } finally {
      busy.current = false;
      await statusRefresh;
      if (alive.current) setForcing(false);
    }
  }, [reload, reloadStatus, setData, setStatus, show]);

  // ---- row actions (stable, so memoised rows do not re-render when only the refresh state changes) ---
  const onToggle = useCallback((id: string) => {
    haptic.select();
    setExpandedId((cur) => (cur === id ? null : id));
  }, []);

  const onCreate = useCallback((trend: Trend) => {
    router.push({ pathname: '/create', params: { trendId: trend.id, trendTitle: trend.title } });
  }, []);

  const onOpen = useCallback(
    (trend: Trend) => {
      void openSource(trend.url).then((ok) => {
        if (!ok) show("Couldn't open that link", 'error');
      });
    },
    [show],
  );

  const selectFilter = useCallback((next: SourceFilter) => {
    setFilter(next);
    setExpandedId(null);
  }, []);

  // ---- render ---------------------------------------------------------------------------------
  const hasData = data !== undefined;
  const offline = !!error && hasData && error !== healed;
  /** The chosen source has nothing right now (e.g. its feed failed on the last pull). */
  const emptySource: TrendSource | null = filter !== 'all' && counts[filter] === 0 ? filter : null;

  const refreshButton = (
    <Button
      title={forcing ? 'Refreshing' : 'Refresh'}
      icon="refresh"
      loading={forcing}
      onPress={forceRefresh}
    />
  );

  let body;
  if (!hasData) {
    body =
      loading || reloading ? (
        <TrendsSkeleton wide={wide} />
      ) : (
        <ErrorState
          title="Couldn't load trends"
          message={error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'}
          onRetry={reload}
        />
      );
  } else if (trends.length === 0) {
    const problem = feedProblem(status);
    body = (
      <EmptyState
        icon="trending-up-outline"
        title="No trends yet"
        message={
          problem
            ? sourceEmptyMessage(problem.source, status)
            : `The feeds have not returned anything yet. Fetch them now and they will be ranked for ${brand}.`
        }
        action={refreshButton}
      />
    );
  } else {
    body = (
      <>
        <ChipStrip>
          <Chip
            label="All"
            count={counts.all}
            selected={filter === 'all'}
            onPress={() => selectFilter('all')}
            style={styles.chip}
          />
          {SOURCE_ORDER.map((source) => (
            <Chip
              key={source}
              label={sourceChipLabel(source)}
              count={sourceIsComingSoon(source) ? undefined : counts[source]}
              color={trendSourceMeta[source].color}
              selected={filter === source}
              disabled={sourceIsComingSoon(source)}
              onPress={() => selectFilter(source)}
              style={styles.chip}
            />
          ))}
        </ChipStrip>

        {emptySource ? (
          <EmptyState
            icon="search-outline"
            title={`Nothing from ${SOURCE_SHORT[emptySource]} right now`}
            message={sourceEmptyMessage(emptySource, status)}
            action={<Button title="Show all trends" variant="secondary" onPress={() => selectFilter('all')} />}
          />
        ) : wide ? (
          // Desktop web (>= 1024 px): the same groups and order, as a 3-column grid of cards.
          <TrendGrid
            sections={sections}
            enterDelay={(index) => (playIntro ? Math.min(index, STAGGER_CAP) * STAGGER_MS : null)}
            animateBars={(index) => index < ANIMATED_ROWS}
            onCreate={onCreate}
            onOpen={onOpen}
          />
        ) : (
          <View style={styles.groups}>
            {sections.map(({ group, start }) => (
              <View key={group.source} style={styles.group}>
                <SourceHeader source={group.source} count={group.items.length} />
                {group.items.map((trend, i) => (
                  <TrendRow
                    key={trend.id}
                    trend={trend}
                    rank={i + 1}
                    brand={brand}
                    expanded={expandedId === trend.id}
                    enterDelay={playIntro ? Math.min(start + i, STAGGER_CAP) * STAGGER_MS : null}
                    animateBars={start + i < ANIMATED_ROWS}
                    onToggle={onToggle}
                    onCreate={onCreate}
                    onOpen={onOpen}
                  />
                ))}
              </View>
            ))}
          </View>
        )}
      </>
    );
  }

  return (
    <Screen
      title="Trends"
      subtitle={`What the world is talking about, ranked for ${brand}`}
      onRefresh={forceRefresh}
      refreshing={forcing || reloading}
    >
      <TrendsIntro
        updatedAt={updatedAt}
        ready={hasData && trends.length > 0}
        refreshing={forcing}
        offline={offline}
        status={status}
        onRefresh={forceRefresh}
        inline={wide}
      />
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  chip: { minHeight: 40 },
  groups: { gap: space.xl },
  group: { gap: space.md },
});
