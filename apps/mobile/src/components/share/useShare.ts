/**
 * "Post it for real": the logic behind the share buttons on every post card (Create results and Queue cards).
 *
 * - LinkedIn / X / Reddit / Facebook open the network's composer with the text pre-filled; X cards also offer Threads.
 * - Instagram / TikTok have no composer link: the button copies the caption and a note says what to do next.
 * - Android, Instagram: "Post to Instagram" copies the caption, asks for a photo (cropped square) and hands it to
 *   Instagram through the share sheet; with IG_AUTOPOST on it can instead publish it through the signed-in WebView
 *   after a "Post to Instagram now?" confirm (src/igPost: logic.ts has the design, IgPostSheet.tsx the WebView).
 * - After the composer was opened (or the caption copied) the post is marked published through the screen's own
 *   publish call, so the card updates through the live state it already has.
 *
 * Demo workspace (docs/REAL.md, "Demo workspaces"): none of the above. A draft's one button is "Post on <Platform> (demo)":
 * it publishes (the server signs the demo account in and takes the first synthetic metrics read) and toasts the numbers
 * that came back; a published post's one button, "Refresh metrics (demo)", reads them back again. Nothing opens, nothing is
 * copied and no photo is asked for.
 *
 * The composer URL comes from `GET /api/posts/{id}/share`. While that endpoint is not deployed (404), unreachable or
 * slow, the same URL is built on the client (`buildShareInfo`), so a button always does something.
 */
import * as Clipboard from 'expo-clipboard';
import { useCallback, useRef, useState } from 'react';
import { Alert, Linking, Platform as RNPlatform } from 'react-native';

import { api } from '@/src/api';
import { canSharePhoto, openInstagramApp, pickPostPhoto, sharePhoto, type PostPhoto } from '@/src/igPost/device';
import { igAutoPostAvailable, type IgPostOutcome } from '@/src/igPost/IgPostSheet';
import { demoMetricsToast, demoPostedToast, demoPostLabel, demoPostNote, demoRefreshLabel } from '@/src/demo/logic';
import { IG_AUTOPOST, igButtonMode, igFailureText, igNote } from '@/src/igPost/logic';
import { isLivePlatform } from '@/src/platforms';
import { useIsDemoWorkspace } from '@/src/session';
import { buildShareInfo, captionFor } from '@/src/shareLinks';
import { shareToLinkedInAndroid } from './androidShare';
import { platformMeta } from '@/src/theme';
import type { Platform, Post, ShareInfo } from '@/src/types';
import { copyText, haptic, useToast } from '@/src/ui';

/** Which composer a button opens: the platform's own, or Threads (X cards only). */
export type ShareKey = Platform | 'threads';

export interface ShareAction {
  key: ShareKey;
  /** `share-<key>`. */
  testID: string;
  /** Visible text and accessible label. */
  label: string;
  /**
   * `open`: open a composer URL. `copy`: copy the caption (Instagram off Android, TikTok). `instagram` (Android): copy
   * the caption, pick a photo, hand both to Instagram (or auto-post them, see src/igPost). `demo` / `demo-refresh` (demo
   * workspace only): post synthetically / read the metrics of the published post back.
   */
  mode: 'open' | 'copy' | 'instagram' | 'demo' | 'demo-refresh';
}

/** The buttons a card of this platform gets, in order. */
export function shareActionsFor(platform: Platform, os: string = RNPlatform.OS): ShareAction[] {
  if (!isLivePlatform(platform)) return []; // X, TikTok, Facebook, Reddit are "coming soon": no share targets
  const label = platformMeta[platform].label;
  switch (platform) {
    case 'instagram':
      if (igButtonMode(os) === 'instagram') {
        return [{ key: 'instagram', testID: 'share-instagram', label: 'Post to Instagram', mode: 'instagram' }];
      }
      return [{ key: platform, testID: `share-${platform}`, label: 'Copy caption', mode: 'copy' }];
    case 'tiktok':
      return [{ key: platform, testID: `share-${platform}`, label: 'Copy caption', mode: 'copy' }];
    case 'x':
      return [
        { key: 'x', testID: 'share-x', label: 'Post on X', mode: 'open' },
        { key: 'threads', testID: 'share-threads', label: 'Post on Threads', mode: 'open' },
      ];
    default:
      return [{ key: platform, testID: `share-${platform}`, label: `Post on ${label}`, mode: 'open' }];
  }
}

/** The one button a card gets in a demo workspace: post synthetically, or (once published) read the metrics back. */
export function demoActionsFor(platform: Platform, published: boolean): ShareAction[] {
  if (!isLivePlatform(platform)) return [];
  return [
    {
      key: platform,
      testID: `share-${platform}`,
      label: published ? demoRefreshLabel() : demoPostLabel(platform),
      mode: published ? 'demo-refresh' : 'demo',
    },
  ];
}

/** The text the user is looking at when it differs from the saved post (unsaved edits on the Create result). */
export interface ShareDraft {
  content: string;
  hashtags: string[];
}

/** What a screen supplies so the share buttons can mark the post published through its own machinery. */
export interface ShareWiring {
  /** Unsaved edits on screen: the composer link and the caption are built from them instead of the saved post. */
  draft?: ShareDraft;
  /** Mark the post published and resolve with the updated post (throw on failure). Default: `api.publishPost`. */
  publish?: (post: Post) => Promise<Post>;
  /** The post is published now: let the screen's live state show it. */
  onPublished?: (post: Post) => void;
}

/** A composer link the browser would not open for us (popup blocked): shown on the card to tap instead. */
export interface ShareLink {
  key: ShareKey;
  /** "LinkedIn", "Threads", ... */
  name: string;
  url: string;
}

/** Longest the buttons wait for the share endpoint before building the link on the client. */
const SHARE_TIMEOUT_MS = 4000;

const isWeb = RNPlatform.OS === 'web' && typeof window !== 'undefined';

/** Popup-blocked links outlive the card that showed them (a published post moves to another card). */
const pendingLinks = new Map<string, ShareLink[]>();

const sameTags = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((tag, i) => tag === b[i]);

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** The server's answer where it gave one, the client's own build everywhere else. Never throws. */
async function loadShare(post: Post, edited: boolean): Promise<ShareInfo> {
  const local = buildShareInfo(post);
  if (edited) return local; // the server only knows the saved text
  let remote: ShareInfo | null = null;
  try {
    remote = await withTimeout(api.getShare(post.id), SHARE_TIMEOUT_MS);
  } catch {
    remote = null; // 404 (not deployed yet), offline, slow: the client build below is just as good
  }
  if (!remote) return local;
  return {
    platform: post.platform,
    url: remote.url ?? local.url,
    threads_url: remote.threads_url ?? local.threads_url,
    caption: remote.caption.trim() ? remote.caption : local.caption,
    instagram_note: remote.instagram_note ?? local.instagram_note,
  };
}

/** Copy with fallbacks: expo-clipboard, then the browser's async clipboard, then the legacy textarea trick. */
async function copyCaption(text: string): Promise<boolean> {
  try {
    if (await Clipboard.setStringAsync(text)) return true;
  } catch {
    // fall through to the web fallbacks
  }
  if (isWeb && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  return copyText(text);
}

/** Web: a blank tab opened inside the press itself (iOS Safari blocks popups opened after an awaited request). */
function openBlankTab(): Window | null {
  if (!isWeb) return null;
  try {
    return window.open('', '_blank');
  } catch {
    return null;
  }
}

/** Resolves true when the URL was handed to a tab / app the user can see; false when the browser refused. */
async function openUrl(url: string, blank: Window | null): Promise<boolean> {
  if (!isWeb) {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      return false;
    }
  }
  let tab = blank && !blank.closed ? blank : null;
  try {
    if (tab) {
      tab.opener = null; // the composer page must not be able to reach back into this app
      tab.location.href = url;
    } else {
      tab = window.open(url, '_blank');
      if (tab) tab.opener = null;
    }
  } catch {
    tab = null;
  }
  return tab !== null;
}

export interface ShareState {
  actions: ShareAction[];
  /** The action whose request is running. */
  busyKey: ShareKey | null;
  /** Instagram / TikTok: what to do after the caption is copied. */
  note: string | null;
  /** Composer links the browser blocked: tap to open. */
  links: ShareLink[];
  press: (action: ShareAction) => void;
  openLink: (link: ShareLink) => void;
  /** Android auto-post in progress: ShareButtons renders `<IgPostSheet {...igSheet} />`. */
  igSheet: { photo: PostPhoto; caption: string; onDone: (outcome: IgPostOutcome) => void } | null;
}

/** Auto-post when the build allows it and the person confirms; 'share' hands the photo to the Instagram app. */
type IgRoute = 'auto' | 'share' | 'cancel';

/** Android's Alert can fire onPress and onDismiss; the first answer wins. */
function ask<T>(title: string, message: string, buttons: { text: string; value: T; cancel?: boolean }[], dismissed: T) {
  return new Promise<T>((resolve) => {
    let done = false;
    const answer = (v: T) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    Alert.alert(
      title,
      message,
      buttons.map((b) => ({
        text: b.text,
        style: (b.cancel ? 'cancel' : 'default') as 'cancel' | 'default',
        onPress: () => answer(b.value),
      })),
      { cancelable: true, onDismiss: () => answer(dismissed) },
    );
  });
}

const askIgRoute = (): Promise<IgRoute> =>
  ask<IgRoute>(
    'Post to Instagram now?',
    'Pulse publishes this photo and caption on your Instagram account, where everyone can see it.',
    [
      { text: 'Cancel', value: 'cancel', cancel: true },
      { text: 'Open Instagram', value: 'share' },
      { text: 'Post now', value: 'auto' },
    ],
    'cancel',
  );

const askShareInstead = (message: string): Promise<boolean> =>
  ask<boolean>(
    "Couldn't post to Instagram",
    message,
    [
      { text: 'Cancel', value: false, cancel: true },
      { text: 'Open Instagram', value: true },
    ],
    false,
  );

export function useShare(post: Post, wiring: ShareWiring = {}): ShareState {
  const toast = useToast();
  const demo = useIsDemoWorkspace();
  const actions = demo ? demoActionsFor(post.platform, post.status === 'published') : shareActionsFor(post.platform);

  const [busyKey, setBusyKey] = useState<ShareKey | null>(null);
  const [remoteNote, setRemoteNote] = useState<string | null>(null);
  const [links, setLinksState] = useState<ShareLink[]>(() => pendingLinks.get(post.id) ?? []);
  const [igJob, setIgJob] = useState<{ photo: PostPhoto; caption: string } | null>(null);
  const igResolve = useRef<((outcome: IgPostOutcome) => void) | null>(null);

  // Latest values for the async flow below (a press spans an awaited request and a re-render or two).
  const postRef = useRef(post);
  postRef.current = post;
  const wiringRef = useRef(wiring);
  wiringRef.current = wiring;
  const busyRef = useRef(false);
  const linksRef = useRef(links);

  const setLinks = useCallback((next: ShareLink[]) => {
    const id = postRef.current.id;
    if (next.length > 0) pendingLinks.set(id, next);
    else pendingLinks.delete(id);
    linksRef.current = next;
    setLinksState(next);
  }, []);

  /** The post as the user sees it (unsaved edits applied) and whether that differs from what is saved. */
  const current = (): { post: Post; edited: boolean } => {
    const p = postRef.current;
    const d = wiringRef.current.draft;
    const edited = !!d && (d.content !== p.content || !sameTags(d.hashtags, p.hashtags));
    return { post: edited && d ? { ...p, content: d.content, hashtags: d.hashtags } : p, edited };
  };

  /** Mark the post published (unless it is) and hand the result to the screen. Quiet when it fails. */
  const markPublished = async (done: string): Promise<void> => {
    const p = postRef.current;
    if (p.status === 'published') return;
    try {
      const publish = wiringRef.current.publish ?? ((target: Post) => api.publishPost(target.id));
      const out = await publish(p);
      if (out.status !== 'published') throw new Error('not published');
      wiringRef.current.onPublished?.(out);
    } catch {
      toast.show(`${done}, but couldn't mark the post as published.`, 'info');
    }
  };

  /**
   * Demo workspace: "post" synthetically (the publish call signs the demo account in and returns the post with its first
   * synthetic metrics read) or, for a post that is already published, read its metrics back. Throws on failure.
   */
  const demoPost = async (): Promise<void> => {
    const p = postRef.current;
    const label = platformMeta[p.platform].label;
    if (p.status === 'published') {
      const read = await api.demoReadMetrics(p.id);
      wiringRef.current.onPublished?.(read.post);
      haptic.success();
      toast.show(demoMetricsToast(label, read));
      return;
    }
    const publish = wiringRef.current.publish ?? ((target: Post) => api.publishPost(target.id));
    const out = await publish(p);
    if (out.status !== 'published') throw new Error('not published');
    wiringRef.current.onPublished?.(out);
    haptic.success();
    toast.show(demoPostedToast(label, out));
  };

  const copy = async (): Promise<void> => {
    const { post: shown, edited } = current();
    // Right inside the press (before any awaited request) so Safari still counts it as a user gesture.
    const caption = captionFor(shown);
    const copied = await copyCaption(caption);
    const info = loadShare(shown, edited);
    if (!copied) {
      toast.show("Couldn't copy the caption", 'error');
      return;
    }
    haptic.success();
    toast.show('Caption copied');
    void info.then((i) => {
      setRemoteNote(i.instagram_note);
      // The server's caption is the source of truth: should it differ, it replaces the copy (best effort, silent).
      if (!edited && i.caption.trim() !== caption.trim()) void copyCaption(i.caption);
    });
    await markPublished('Caption copied');
  };

  /** The photo to Instagram through Android's share sheet; an APK without expo-sharing opens the Instagram app. */
  const shareToInstagram = async (photo: PostPhoto | null, copied: boolean): Promise<void> => {
    const paste = copied ? 'The caption is copied: paste it in Instagram.' : "Couldn't copy the caption.";
    if (photo && canSharePhoto()) {
      toast.show(`Choose "Instagram Feed". ${paste}`, 'info');
      if (await sharePhoto(photo.uri)) {
        toast.show(paste, copied ? 'success' : 'error');
        await markPublished('Sent to Instagram');
        return;
      }
    }
    if (!(await openInstagramApp())) {
      toast.show("Couldn't open Instagram.", 'error');
      return;
    }
    toast.show(copied ? 'Caption copied. In Instagram tap +, pick the photo, then paste the caption.' : paste, 'info');
    await markPublished('Opened Instagram');
  };

  /** Opens the posting sheet and resolves when it is done. */
  const autoPost = (photo: PostPhoto, caption: string): Promise<IgPostOutcome> =>
    new Promise((resolve) => {
      igResolve.current = resolve;
      setIgJob({ photo, caption });
    });

  const igDone = (outcome: IgPostOutcome): void => {
    setIgJob(null);
    const resolve = igResolve.current;
    igResolve.current = null;
    resolve?.(outcome);
  };

  /** Android "Post to Instagram": caption to the clipboard, a photo from the library, then share or auto-post. */
  const postInstagram = async (): Promise<void> => {
    const caption = captionFor(current().post);
    const copied = await copyCaption(caption);
    const picked = await pickPostPhoto();
    if (picked.status === 'cancelled') {
      toast.show(
        copied ? 'Caption copied. Instagram needs a photo: tap again to pick one.' : 'Instagram needs a photo.',
        'info',
      );
      return;
    }
    if (picked.status === 'error') {
      toast.show(picked.message, 'error');
      return;
    }
    if (picked.status === 'unavailable') {
      await shareToInstagram(null, copied); // this APK has no photo picker: the person picks it in Instagram
      return;
    }
    const { photo } = picked;
    const route: IgRoute = IG_AUTOPOST && igAutoPostAvailable() ? await askIgRoute() : 'share';
    if (route === 'cancel') return;
    if (route === 'share') {
      await shareToInstagram(photo, copied);
      return;
    }
    const outcome = await autoPost(photo, caption);
    if (outcome.ok === true) {
      haptic.success();
      toast.show('Posted to Instagram');
      await markPublished('Posted to Instagram');
      return;
    }
    if (outcome.ok === null) {
      if (outcome.whilePosting) toast.show('Closed while posting. Check Instagram: it may have posted.', 'info');
      return;
    }
    const message = igFailureText(outcome);
    if (outcome.stage === 'timeout') {
      toast.show(message, 'info');
      return;
    }
    if (await askShareInstead(message)) await shareToInstagram(photo, copied);
  };

  const open = async (action: ShareAction, blank: Window | null): Promise<void> => {
    const { post: shown, edited } = current();
    const info = await loadShare(shown, edited);
    const url = action.key === 'threads' ? info.threads_url : info.url;
    if (!url) {
      if (blank && !blank.closed) blank.close();
      toast.show('Nothing to open for this post yet.', 'info');
      return;
    }
    const label = action.key === 'threads' ? 'Threads' : platformMeta[shown.platform].label;
    // LinkedIn's Android app ignores the composer URL (opens the feed, drops the text): hand it the post instead.
    if (RNPlatform.OS === 'android' && action.key === 'linkedin' && (await shareToLinkedInAndroid(info.caption))) {
      await markPublished(`Opened ${label}`);
      return;
    }
    if (await openUrl(url, blank)) {
      await markPublished(`Opened ${label}`);
      return;
    }
    // The browser refused the popup: keep the link on the card, the next tap is a fresh gesture.
    setLinks([...linksRef.current.filter((l) => l.key !== action.key), { key: action.key, name: label, url }]);
    toast.show(`Your browser blocked the ${label} tab. Tap the link on the card.`, 'info');
  };

  const press = (action: ShareAction): void => {
    if (busyRef.current) return;
    if (!current().post.content.trim()) {
      toast.show('Write something first, then post it.', 'info');
      return;
    }
    busyRef.current = true;
    setBusyKey(action.key);
    const blank = action.mode === 'open' ? openBlankTab() : null;
    const job =
      action.mode === 'demo' || action.mode === 'demo-refresh'
        ? demoPost()
        : action.mode === 'copy'
          ? copy()
          : action.mode === 'instagram'
            ? postInstagram()
            : open(action, blank);
    job
      .catch(() => {
        if (blank && !blank.closed) blank.close();
        toast.show("That didn't work. Please try again.", 'info');
      })
      .finally(() => {
        busyRef.current = false;
        setBusyKey(null);
      });
  };

  const openLink = (link: ShareLink): void => {
    setLinks(linksRef.current.filter((l) => l.key !== link.key));
    Linking.openURL(link.url).then(
      () => markPublished(`Opened ${link.name}`),
      () => toast.show("Couldn't open the link.", 'info'),
    );
  };

  const localNote = actions[0].mode === 'copy' ? buildShareInfo(post).instagram_note : null;
  // Android Instagram: the server's note describes the copy-only flow, so this button keeps its own.
  const note = demo
    ? demoPostNote(post.platform, post.status === 'published')
    : actions[0].mode === 'instagram'
      ? igNote({ autoPost: IG_AUTOPOST && igAutoPostAvailable(), hasVisualPlan: !!post.media_prompt?.trim() })
      : (remoteNote ?? localNote);
  const igSheet = igJob ? { ...igJob, onDone: igDone } : null;
  return { actions, busyKey, note, links, press, openLink, igSheet };
}
