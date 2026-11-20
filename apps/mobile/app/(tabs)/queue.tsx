import { router, useIsFocused, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { api, ApiError, isMock, openTrackedLink, type Platform, type Post, type Theme } from '@/src/api';
import { EmptyQueue } from '@/src/components/queue/EmptyQueue';
import { FadeIn } from '@/src/components/queue/FadeIn';
import { PostCard } from '@/src/components/queue/PostCard';
import { PostCardSkeleton } from '@/src/components/queue/PostCardSkeleton';
import {
  applyOverlay,
  parseQueueTab,
  plural,
  pruneOverlay,
  reuseUnchanged,
  splitPosts,
  type Account,
  type BusyKind,
  type Overlay,
  type OverlayEntry,
  type QueueTab,
  type Snapshot,
} from '@/src/components/queue/queueModel';
import { QueueStatusRow, type BulkProgress } from '@/src/components/queue/QueueStatusRow';
import { APP_NAME, POLL_MS } from '@/src/config';
import { fmtDateTime } from '@/src/format';
import { useAsync } from '@/src/hooks';
import { useSession } from '@/src/session';
import { platformMeta, space } from '@/src/theme';
import { Screen, Segmented, ErrorState, confirm, haptic, useToast, type SegmentedOption } from '@/src/ui';

const messageOf = (e: unknown): string =>
  e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';

/** The one navigation method used here: clearing this route's own `tab` param (scoped to this screen). */
interface TabNavigation {
  setParams: (params: { tab?: string }) => void;
}

/**
 * The posting queue: drafts, scheduled and published posts from one `listPosts` load, split client-side and
 * polled while focused so the counters of published posts visibly grow.
 *
 * Local changes (publish, delete, edit, schedule) are layered over the server list as an "overlay" until a list
 * request that started after the change has come back, so a poll that was already in flight can never flip a
 * card back for a moment.
 */
export default function QueueScreen() {
  const toast = useToast();
  const { workspace } = useSession();
  const focused = useIsFocused();
  const navigation = useNavigation<TabNavigation>();
  const params = useLocalSearchParams<{ tab?: string }>();
  const tabParam = parseQueueTab(params.tab);

  const [tab, setTab] = useState<QueueTab>(tabParam ?? 'drafts');
  const [scrollEpoch, setScrollEpoch] = useState(0);
  const [busy, setBusy] = useState<Record<string, BusyKind>>({});
  const [bulk, setBulk] = useState<BulkProgress | null>(null);
  const [pulling, setPulling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // ---- server data: one list, polled while focused -------------------------------------------------
  const known = useRef<Map<string, Post>>(new Map());
  const { data, error, reload } = useAsync<Snapshot>(
    async () => {
      const startedAt = Date.now();
      const fresh = await api.listPosts({ limit: 100 });
      const shared = reuseUnchanged(known.current, fresh);
      known.current = shared.byId;
      return { startedAt, posts: shared.posts };
    },
    [],
    { intervalMs: POLL_MS },
  );
  // Handles and follower counts for the optional platform-native preview (fetched once; failure is harmless).
  const connections = useAsync(() => api.listConnections(), []);
  // Theme names and colours for the chip on each card (a failure is ignored: the chips just stay out). Themes that did
  // not change keep their object, so a quiet re-fetch on focus does not re-render every memoised card.
  const knownThemes = useRef<Map<string, Theme>>(new Map());
  const themes = useAsync(async () => {
    const fresh = await api.listThemes();
    const shared = fresh.map((th) => {
      const old = knownThemes.current.get(th.id);
      return old && old.name === th.name && old.color === th.color ? old : th;
    });
    knownThemes.current = new Map(shared.map((th) => [th.id, th]));
    return shared;
  }, []);
  const themeById = useMemo(() => new Map((themes.data ?? []).map((th) => [th.id, th])), [themes.data]);

  // ---- optimistic overlay (the ref is the source of truth so writes never race a render) ----------
  const overlayRef = useRef<Overlay>({});
  const [overlay, setOverlay] = useState<Overlay>(overlayRef.current);
  const commitOverlay = useCallback((next: Overlay) => {
    overlayRef.current = next;
    setOverlay(next);
  }, []);
  /** Show `post` (null = deleted) right away, until the server confirms. */
  const stage = useCallback(
    (id: string, post: Post | null) => commitOverlay({ ...overlayRef.current, [id]: { post, settledAt: null } }),
    [commitOverlay],
  );
  /** The server answered: keep showing its version until a newer list request has caught up. */
  const settle = useCallback(
    (id: string, post: Post | null) => commitOverlay({ ...overlayRef.current, [id]: { post, settledAt: Date.now() } }),
    [commitOverlay],
  );
  const restore = useCallback(
    (id: string, entry: OverlayEntry | undefined) => {
      const next = { ...overlayRef.current };
      if (entry) next[id] = entry;
      else delete next[id];
      commitOverlay(next);
    },
    [commitOverlay],
  );
  useEffect(() => {
    if (!data) return;
    const next = pruneOverlay(overlayRef.current, data);
    if (next !== overlayRef.current) commitOverlay(next);
  }, [data, commitOverlay]);

  const posts = useMemo(() => (data ? applyOverlay(data, overlay) : undefined), [data, overlay]);
  const lists = useMemo(() => (posts ? splitPosts(posts) : undefined), [posts]);
  const draftsRef = useRef<Post[]>([]);
  draftsRef.current = lists?.drafts ?? [];

  const accounts = useMemo(() => {
    const map: Partial<Record<Platform, Account>> = {};
    for (const c of connections.data ?? []) map[c.platform] = { handle: c.handle, followers: c.followers };
    return map;
  }, [connections.data]);

  // ---- tabs ------------------------------------------------------------------------------------------
  const explicitTab = useRef(tabParam !== null);
  const autoPicked = useRef(false);
  const mounted = useRef(false);
  const navRef = useRef(navigation);
  navRef.current = navigation;

  /** Programmatic switch (after Publish, from the route): also remount the frame so the list starts at the top. */
  const goTab = useCallback((next: QueueTab) => {
    explicitTab.current = true;
    setTab(next);
    setScrollEpoch((e) => e + 1);
  }, []);

  /** The user tapped a segment: they are near the top already, so keep the scroll position. */
  const onSegment = useCallback((key: string) => {
    const next = parseQueueTab(key);
    if (!next) return;
    explicitTab.current = true;
    setTab(next);
  }, []);

  // A `tab` route param (Create navigates here after publishing or scheduling) selects that tab. It is consumed
  // right away, so pushing the same value again later still reads as a change.
  useEffect(() => {
    if (!tabParam) return;
    explicitTab.current = true;
    setTab(tabParam);
    if (mounted.current) setScrollEpoch((e) => e + 1);
    try {
      navRef.current.setParams({ tab: undefined });
    } catch {
      // Navigator not ready: the param stays, which is harmless.
    }
  }, [tabParam]);
  useEffect(() => {
    mounted.current = true;
  }, []);

  // First load without a requested tab: an empty Drafts tab is a poor landing page when posts exist elsewhere.
  useEffect(() => {
    if (!lists || autoPicked.current) return;
    autoPicked.current = true;
    if (explicitTab.current || lists.drafts.length > 0) return;
    if (lists.published.length > 0) setTab('published');
    else if (lists.scheduled.length > 0) setTab('scheduled');
  }, [lists]);

  // Keep "3m ago" labels fresh (cards are memoised, so they only re-render when `now` or their post changes).
  useEffect(() => {
    if (!focused) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [focused]);

  // Staggered fade-in only for the cards of the very first load.
  const introRef = useRef(true);
  const intro = introRef.current;
  useEffect(() => {
    if (data) introRef.current = false;
  }, [data]);

  // ---- mutations -------------------------------------------------------------------------------------
  const inFlight = useRef<Set<string>>(new Set());
  const bulkRef = useRef(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );
  const reloadSoon = useCallback(
    (ms: number) => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void reload(), ms);
    },
    [reload],
  );

  const setBusyFor = useCallback((id: string, kind: BusyKind | null) => {
    setBusy((prev) => {
      if (kind !== null) return prev[id] === kind ? prev : { ...prev, [id]: kind };
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  /** One request per post at a time; marks the card busy and puts its overlay back if the request fails. */
  const run = useCallback(
    async <T,>(id: string, kind: BusyKind, work: () => Promise<T>, quiet = false): Promise<T | undefined> => {
      if (inFlight.current.has(id)) return undefined;
      inFlight.current.add(id);
      setBusyFor(id, kind);
      const before = overlayRef.current[id];
      try {
        return await work();
      } catch (e) {
        restore(id, before);
        if (!quiet) toast.show(messageOf(e), 'error');
        return undefined;
      } finally {
        inFlight.current.delete(id);
        setBusyFor(id, null);
      }
    },
    [restore, setBusyFor, toast],
  );

  const publishRequest = useCallback(
    async (post: Post): Promise<Post> => {
      const saved = await api.publishPost(post.id);
      settle(post.id, saved);
      return saved;
    },
    [settle],
  );

  const onPublish = useCallback(
    async (post: Post) => {
      const label = platformMeta[post.platform].label;
      const saved = await run(post.id, 'publish', () => publishRequest(post));
      if (!saved) return;
      if (saved.status === 'published') {
        haptic.success();
        toast.show(`Published to ${label} (sandbox)`);
        goTab('published');
      } else {
        toast.show(`Couldn't publish to ${label}. Try again.`, 'error');
      }
      void reload();
    },
    [run, publishRequest, toast, goTab, reload],
  );

  const onDelete = useCallback(
    async (post: Post) => {
      if (inFlight.current.has(post.id)) return;
      const label = platformMeta[post.platform].label;
      const ok = await confirm(
        'Delete this post?',
        `Your ${label} post will be removed from the queue. This can't be undone.`,
        'Delete',
        true,
      );
      if (!ok) return;
      const done = await run(post.id, 'delete', async () => {
        stage(post.id, null); // optimistic: gone from the list right away
        await api.deletePost(post.id);
        settle(post.id, null);
        return true;
      });
      if (!done) return;
      toast.show('Post deleted');
      void reload();
    },
    [run, stage, settle, toast, reload],
  );

  const onUnschedule = useCallback(
    async (post: Post) => {
      const saved = await run(post.id, 'unschedule', async () => {
        stage(post.id, { ...post, status: 'draft', scheduled_at: null });
        const next = await api.patchPost(post.id, { status: 'draft', scheduled_at: null });
        settle(post.id, next);
        return next;
      });
      if (!saved) return;
      toast.show('Moved to drafts');
      void reload();
    },
    [run, stage, settle, toast, reload],
  );

  const onSchedule = useCallback(
    async (post: Post, iso: string) => {
      const saved = await run(post.id, 'schedule', async () => {
        stage(post.id, { ...post, status: 'scheduled', scheduled_at: iso });
        const next = await api.patchPost(post.id, { status: 'scheduled', scheduled_at: iso });
        settle(post.id, next);
        return next;
      });
      if (!saved) return;
      haptic.success();
      toast.show(`Scheduled for ${fmtDateTime(saved.scheduled_at ?? iso)}`);
      void reload();
    },
    [run, stage, settle, toast, reload],
  );

  const onSave = useCallback(
    async (post: Post, patch: { content: string; hashtags: string[] }): Promise<boolean> => {
      const saved = await run(post.id, 'save', async () => {
        const next = await api.patchPost(post.id, patch);
        settle(post.id, next);
        return next;
      });
      if (!saved) return false;
      toast.show('Draft saved');
      return true;
    },
    [run, settle, toast],
  );

  const onOpenLink = useCallback(
    async (post: Post) => {
      try {
        await openTrackedLink(post);
      } catch {
        toast.show("Couldn't open the link", 'error');
        return;
      }
      if (isMock()) toast.show('Click recorded (offline demo)', 'info');
      reloadSoon(1500); // the click lands in the counters without waiting for the next poll
    },
    [toast, reloadSoon],
  );

  /** Publish every draft, one after the other, with "Publishing 3/6" progress. */
  const publishAll = useCallback(async () => {
    if (bulkRef.current) return;
    const targets = draftsRef.current.filter((p) => !inFlight.current.has(p.id));
    if (targets.length === 0) return;
    bulkRef.current = true;
    let published = 0;
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const post = targets[i];
        setBulk({ current: i + 1, total: targets.length });
        const saved = await run(post.id, 'publish', () => publishRequest(post), true);
        if (saved?.status === 'published') published += 1;
      }
    } finally {
      bulkRef.current = false;
      setBulk(null);
    }
    const failed = targets.length - published;
    if (published > 0) {
      haptic.success();
      goTab('published');
    }
    if (failed === 0) toast.show(`Published ${plural(published, 'post')} (sandbox)`);
    else toast.show(`Published ${published} of ${targets.length}. ${failed} could not be published.`, 'error');
    void reload();
  }, [run, publishRequest, goTab, toast, reload]);

  const onRefresh = useCallback(async () => {
    setPulling(true);
    try {
      await reload();
    } finally {
      setPulling(false);
    }
  }, [reload]);

  const onRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await reload();
    } finally {
      setRetrying(false);
    }
  }, [reload]);

  const onCreate = useCallback(() => router.push('/create'), []);
  const onGoDrafts = useCallback(() => onSegment('drafts'), [onSegment]);

  // ---- render ----------------------------------------------------------------------------------------
  const options = useMemo<SegmentedOption[]>(
    () => [
      { key: 'drafts', label: 'Drafts', count: lists?.drafts.length },
      { key: 'scheduled', label: 'Scheduled', count: lists?.scheduled.length },
      { key: 'published', label: 'Published', count: lists?.published.length },
    ],
    [lists],
  );

  const brandName = workspace?.brand_name || APP_NAME;
  const items = lists ? lists[tab] : [];
  const locked = bulk !== null;

  let body: ReactNode;
  if (!lists) {
    body =
      error && !retrying ? (
        <ErrorState title="Couldn't load your queue" message={messageOf(error)} onRetry={onRetry} />
      ) : (
        <View style={styles.list}>
          <PostCardSkeleton />
          <PostCardSkeleton />
          <PostCardSkeleton />
        </View>
      );
  } else if (items.length === 0) {
    body = <EmptyQueue tab={tab} hasDrafts={lists.drafts.length > 0} onCreate={onCreate} onGoDrafts={onGoDrafts} />;
  } else {
    body = (
      <View style={styles.list}>
        {items.map((post, i) => (
          <FadeIn key={post.id} index={i} animate={intro}>
            <PostCard
              post={post}
              now={now}
              busy={busy[post.id]}
              locked={locked}
              brandName={brandName}
              account={accounts[post.platform]}
              theme={post.theme_id ? (themeById.get(post.theme_id) ?? null) : null}
              onPublish={onPublish}
              onDelete={onDelete}
              onUnschedule={onUnschedule}
              onSchedule={onSchedule}
              onSave={onSave}
              onOpenLink={onOpenLink}
            />
          </FadeIn>
        ))}
      </View>
    );
  }

  return (
    // Keyed by `scrollEpoch`: a programmatic tab switch remounts the frame, which resets its scroll position, so the
    // post that was just published is at the top of Published instead of off-screen.
    <Screen
      key={scrollEpoch}
      title="Queue"
      subtitle="Review, schedule and publish. Numbers update live."
      onRefresh={onRefresh}
      refreshing={pulling}
    >
      <Segmented options={options} value={tab} onChange={onSegment} />
      {lists ? (
        <QueueStatusRow
          tab={tab}
          hasItems={items.length > 0}
          focused={focused}
          reconnecting={!!error}
          draftCount={lists.drafts.length}
          bulk={bulk}
          onPublishAll={publishAll}
        />
      ) : null}
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.lg },
});
