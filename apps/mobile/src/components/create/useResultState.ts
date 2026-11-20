/**
 * State and actions of a finished generation, shared by the phone's pager (`ResultView`) and the wide board
 * (`ResultGrid`): unsaved edits, per-card busy/error flags, save / publish / schedule / discard, "Publish all" and the
 * guarded way back to the form. The two views only differ in how they lay the cards out.
 */
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Platform } from 'react-native';

import { api, openTrackedLink } from '@/src/api';
import { fmtDateTime, fmtInt } from '@/src/format';
import { platformMeta } from '@/src/theme';
import type { Connection, Post, PostPatch } from '@/src/types';
import { confirm, copyText, haptic, useToast } from '@/src/ui';

import { errorMessage, UiError } from './errors';
import {
  POST_MAX,
  clamp,
  draftOf,
  fallbackHandle,
  isDirty,
  isDone,
  isOpen,
  type Batch,
  type Busy,
  type Draft,
  type Edits,
} from './logic';
import type { PostActionsProps } from './PostActions';
import type { PostPageProps } from './PostPage';

export interface ResultStateInput {
  batch: Batch;
  connections: Connection[] | undefined;
  brandName: string;
  /** Back to the form ("Edit brief" / "New generation"). */
  onBack: () => void;
}

/** The block eases in (fade + 14 px rise) when the result appears. */
export function useEaseIn() {
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(appear, {
      toValue: 1,
      duration: 380,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [appear]);
  return { opacity: appear, transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] };
}

/** Owns the per-post local state of one batch. Call it from a component mounted with `key={batch.id}`. */
export function useResultState({ batch, connections, brandName, onBack }: ResultStateInput) {
  const toast = useToast();

  const [posts, setPosts] = useState<Post[]>(batch.posts);
  const [edits, setEdits] = useState<Edits>({});
  const [busy, setBusy] = useState<Record<string, Busy | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [index, setIndex] = useState(0);

  // Latest values for the async flows below (a "Publish all" run spans many renders).
  const postsRef = useRef(posts);
  postsRef.current = posts;
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const bulkRunning = useRef(false);

  // ---- small state helpers ----------------------------------------------------------------------------------------

  const setBusyFor = useCallback((id: string, kind: Busy | undefined) => {
    setBusy((b) => ({ ...b, [id]: kind }));
  }, []);

  const setErrorFor = useCallback((id: string, message: string | undefined) => {
    setErrors((e) => (e[id] === message ? e : { ...e, [id]: message }));
  }, []);

  const replacePost = useCallback((next: Post) => {
    setPosts((ps) => ps.map((p) => (p.id === next.id ? next : p)));
  }, []);

  const dropEdit = useCallback((id: string) => {
    setEdits((e) => {
      if (!(id in e)) return e;
      const rest = { ...e };
      delete rest[id];
      return rest;
    });
  }, []);

  /** Typing in a card: remember it locally (nothing is sent until Save / Publish / Schedule). */
  const onEdit = useCallback((id: string, patch: Partial<Draft>) => {
    setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }));
    setErrors((er) => (er[id] ? { ...er, [id]: undefined } : er));
  }, []);

  const openLink = useCallback(
    async (post: Post) => {
      try {
        await openTrackedLink(post);
        toast.show('Tracked link opened. Your click lands in the funnel.', 'info');
      } catch {
        toast.show("Couldn't open the link.", 'error');
      }
    },
    [toast],
  );

  // ---- requests ---------------------------------------------------------------------------------------------------

  /** PATCH the card's current values (plus anything extra, such as a schedule). Throws on failure. */
  const persist = async (post: Post, extra: PostPatch = {}): Promise<Post> => {
    const d = draftOf(post, editsRef.current[post.id]);
    if (!d.content.trim()) throw new UiError("A post can't be empty. Write something first.");
    if (d.content.length > POST_MAX) throw new UiError(`That post is over ${fmtInt(POST_MAX)} characters. Trim it first.`);
    const next = await api.patchPost(post.id, {
      content: d.content,
      hashtags: d.hashtags,
      media_prompt: d.mediaPrompt,
      ...extra,
    });
    replacePost(next);
    dropEdit(post.id);
    return next;
  };

  /** Run one card's request with its busy flag and error line handled. Resolves true on success. */
  const work = async (post: Post, kind: Busy, job: () => Promise<void>, opts: { quiet?: boolean } = {}): Promise<boolean> => {
    const id = post.id;
    setBusyFor(id, kind);
    setErrorFor(id, undefined);
    try {
      await job();
      return true;
    } catch (e) {
      const message = errorMessage(e);
      setErrorFor(id, message);
      if (!opts.quiet) {
        haptic.warn();
        toast.show(message, 'error');
      }
      return false;
    } finally {
      setBusyFor(id, undefined);
    }
  };

  const saveOne = (post: Post) =>
    work(post, 'saving', async () => {
      await persist(post);
      haptic.success();
      toast.show('Edits saved');
    });

  const publishOne = (post: Post, quiet = false) =>
    work(
      post,
      'publishing',
      async () => {
        const label = platformMeta[post.platform].label;
        const ready = isDirty(post, editsRef.current[post.id]) ? await persist(post) : post;
        const out = await api.publishPost(ready.id);
        replacePost(out);
        if (out.status === 'failed') throw new UiError(`Couldn't publish to ${label}. Try again.`);
        if (!quiet) {
          haptic.success();
          toast.show(`Published to ${label} (sandbox)`);
        }
      },
      { quiet },
    );

  const scheduleOne = (post: Post, whenIso: string) =>
    work(post, 'scheduling', async () => {
      const next = await persist(post, { status: 'scheduled', scheduled_at: whenIso });
      haptic.success();
      toast.show(`Scheduled for ${fmtDateTime(next.scheduled_at ?? whenIso)}`);
    });

  const discardOne = async (post: Post) => {
    const label = platformMeta[post.platform].label;
    const ok = await confirm(`Discard the ${label} draft?`, 'It is deleted from your queue too.', 'Discard', true);
    if (!ok) return;
    await work(post, 'discarding', async () => {
      await api.deletePost(post.id);
      const remaining = postsRef.current.filter((p) => p.id !== post.id);
      dropEdit(post.id);
      setPosts(remaining);
      setIndex((i) => clamp(i, 0, Math.max(0, remaining.length - 1)));
      toast.show('Draft discarded');
      if (remaining.length === 0) onBack();
    });
  };

  const copyLink = async (post: Post) => {
    if (!post.link_url) return;
    const copied = await copyText(post.link_url);
    toast.show(copied ? 'Tracked link copied' : "Couldn't copy the link", copied ? 'success' : 'error');
  };

  const viewQueue = (tab: 'published' | 'scheduled') => {
    router.push({ pathname: '/queue', params: { tab } });
  };

  /** Publish every open card one after the other, with progress on the button. */
  const publishAll = async () => {
    if (bulkRunning.current) return;
    const todo = postsRef.current.filter(isOpen);
    if (todo.length === 0) return;
    bulkRunning.current = true;
    let published = 0;
    try {
      for (let i = 0; i < todo.length; i++) {
        setBulk({ done: i, total: todo.length });
        const fresh = postsRef.current.find((p) => p.id === todo[i].id) ?? todo[i];
        if (await publishOne(fresh, true)) published += 1;
      }
    } finally {
      bulkRunning.current = false;
      setBulk(null);
    }
    if (published === todo.length) {
      haptic.success();
      toast.show(`Published all ${published} posts (sandbox)`);
    } else {
      haptic.warn();
      toast.show(`Published ${published} of ${todo.length}. Check the cards that need attention.`, 'error');
    }
  };

  /** Back to the form, asking first when there are edits that were never saved. */
  const leave = async () => {
    const unsaved = postsRef.current.some((p) => isDirty(p, editsRef.current[p.id]));
    if (unsaved) {
      const ok = await confirm(
        'Leave without saving?',
        'Some edits have not been saved. The drafts themselves are already in your queue.',
        'Leave',
        true,
      );
      if (!ok) return;
    }
    onBack();
  };

  // ---- derived ----------------------------------------------------------------------------------------------------

  const dirtyIds = useMemo(
    () => new Set(posts.filter((p) => isDirty(p, edits[p.id])).map((p) => p.id)),
    [posts, edits],
  );

  const active: Post | undefined = posts[clamp(index, 0, posts.length - 1)];
  const activeIndex = active ? posts.indexOf(active) : 0;

  const openCount = posts.filter(isOpen).length;
  const allDone = posts.every(isDone);
  const anyBusy = Object.values(busy).some(Boolean);
  const title = allDone ? 'All set' : `${posts.length} ${posts.length === 1 ? 'post' : 'posts'} ready`;

  /** Props for the platform-native card of one post (the user's unsaved edits on top of the saved values). */
  const pageProps = (p: Post): PostPageProps => {
    const conn = connections?.find((c) => c.platform === p.platform);
    const d = draftOf(p, edits[p.id]);
    return {
      post: p,
      content: d.content,
      hashtags: d.hashtags,
      mediaPrompt: d.mediaPrompt,
      brandName,
      handle: conn?.handle || fallbackHandle(brandName),
      followers: conn?.followers,
      accentColor: batch.themeColor ?? undefined,
      editable: isOpen(p) && !busy[p.id] && bulk === null,
      onEdit,
      onOpenLink: openLink,
    };
  };

  /** Props for the Publish / Schedule / Save actions of one post (the caller adds `wide`). */
  const actionProps = (p: Post): Omit<PostActionsProps, 'wide'> => ({
    post: p,
    dirty: dirtyIds.has(p.id),
    busy: busy[p.id],
    locked: bulk !== null,
    error: errors[p.id],
    onPublish: () => void publishOne(p),
    onSchedule: (iso) => void scheduleOne(p, iso),
    onSaveEdits: () => void saveOne(p),
    onCopyLink: () => void copyLink(p),
    onDiscard: () => void discardOne(p),
    onOpenLink: () => void openLink(p),
    onViewQueue: viewQueue,
  });

  return {
    posts,
    index,
    setIndex,
    active,
    activeIndex,
    bulk,
    dirtyIds,
    openCount,
    allDone,
    anyBusy,
    title,
    pageProps,
    actionProps,
    publishAll,
    leave,
  };
}

export type ResultState = ReturnType<typeof useResultState>;
