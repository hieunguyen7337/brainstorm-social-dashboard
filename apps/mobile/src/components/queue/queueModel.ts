/**
 * Pure helpers for the Queue screen (no React): tab parsing, splitting and sorting posts by status, structural
 * sharing between polls, and the optimistic "overlay" that keeps a local change on screen until the server has
 * caught up with it (so a poll that was already in flight can never flip a card back for a moment).
 */
import { PLATFORMS, type Post } from '@/src/types';
import { isLivePlatform } from '@/src/platforms';
import { parseTs } from '@/src/format';

export type QueueTab = 'drafts' | 'scheduled' | 'published';

/** What a card is waiting on: disables its buttons and spins the matching one. */
export type BusyKind = 'publish' | 'delete' | 'save' | 'schedule' | 'unschedule';

export interface Counters {
  views: number;
  engagements: number;
  clicks: number;
  conversions: number;
}

/** A connected account, used to dress the optional platform-native preview. */
export interface Account {
  handle: string;
  followers: number;
}

/** `tab` may arrive as a string, an array (repeated query param) or garbage. */
export function parseQueueTab(value: unknown): QueueTab | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v === 'drafts' || v === 'scheduled' || v === 'published' ? v : null;
}

export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

// ---- splitting and sorting ---------------------------------------------------------------------

export interface QueueLists {
  /** `draft` and `failed` (failed ones carry a red badge and can be retried). */
  drafts: Post[];
  scheduled: Post[];
  published: Post[];
}

function stamp(iso: string | null | undefined, fallback: number): number {
  if (!iso) return fallback;
  const t = parseTs(iso).getTime();
  return Number.isNaN(t) ? fallback : t;
}

const cmp = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);

/** Deterministic tie-break so a generated batch keeps the Create screen's platform order between polls. */
const tieBreak = (a: Post, b: Post): number =>
  PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) || a.id.localeCompare(b.id);

/** Drafts newest first, scheduled by `scheduled_at` ascending, published by `published_at` descending. */
export function splitPosts(posts: readonly Post[]): QueueLists {
  const drafts: Post[] = [];
  const scheduled: Post[] = [];
  const published: Post[] = [];
  for (const p of posts) {
    // Old rows for platforms that are "coming soon" are never listed (and so never get a Publish button).
    if (!isLivePlatform(p.platform)) continue;
    if (p.status === 'published') published.push(p);
    else if (p.status === 'scheduled') scheduled.push(p);
    else drafts.push(p);
  }
  drafts.sort((a, b) => cmp(stamp(b.created_at, 0), stamp(a.created_at, 0)) || tieBreak(a, b));
  scheduled.sort(
    (a, b) => cmp(stamp(a.scheduled_at, Infinity), stamp(b.scheduled_at, Infinity)) || tieBreak(a, b),
  );
  published.sort(
    (a, b) =>
      cmp(stamp(b.published_at ?? b.created_at, 0), stamp(a.published_at ?? a.created_at, 0)) || tieBreak(a, b),
  );
  return { drafts, scheduled, published };
}

// ---- structural sharing ------------------------------------------------------------------------

/** Field-by-field equality (arrays compared element-wise). */
export function samePost(a: Post, b: Post): boolean {
  const keys = Object.keys(a) as (keyof Post)[];
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    const x: unknown = a[k];
    const y: unknown = b[k];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i])) continue;
    return false;
  }
  return true;
}

/**
 * Reuse the previous object for every post that did not change, so memoised cards skip re-rendering on a poll
 * (only the posts whose counters moved get new identities).
 */
export function reuseUnchanged(
  previous: ReadonlyMap<string, Post>,
  fresh: readonly Post[],
): { posts: Post[]; byId: Map<string, Post> } {
  const byId = new Map<string, Post>();
  const posts = fresh.map((p) => {
    const old = previous.get(p.id);
    const keep = old && samePost(old, p) ? old : p;
    byId.set(p.id, keep);
    return keep;
  });
  return { posts, byId };
}

// ---- optimistic overlay ------------------------------------------------------------------------

/** One list response plus the moment its request was sent. */
export interface Snapshot {
  /** `Date.now()` just before the request left. */
  startedAt: number;
  posts: Post[];
}

/**
 * A local change layered over the server data. `post: null` means "deleted". `settledAt` is null while the
 * request is in flight, then the time the server answered: any snapshot whose request started at or after that
 * moment already includes the change, so the entry can go.
 */
export interface OverlayEntry {
  post: Post | null;
  settledAt: number | null;
}
export type Overlay = Record<string, OverlayEntry>;

const reflected = (entry: OverlayEntry, snap: Snapshot): boolean =>
  entry.settledAt !== null && entry.settledAt <= snap.startedAt;

/** The posts to show: the server list with every not-yet-reflected local change applied. */
export function applyOverlay(snap: Snapshot, overlay: Overlay): Post[] {
  if (Object.keys(overlay).length === 0) return snap.posts;
  const out: Post[] = [];
  for (const p of snap.posts) {
    const entry = overlay[p.id];
    if (!entry || reflected(entry, snap)) out.push(p);
    else if (entry.post) out.push(entry.post);
  }
  return out;
}

/** Drop entries the snapshot already reflects. Returns the same object when nothing changed. */
export function pruneOverlay(overlay: Overlay, snap: Snapshot): Overlay {
  let next: Overlay | null = null;
  for (const [id, entry] of Object.entries(overlay)) {
    if (!reflected(entry, snap)) continue;
    if (!next) next = { ...overlay };
    delete next[id];
  }
  return next ?? overlay;
}

// ---- card text helpers -------------------------------------------------------------------------

/** Longer than this gets a "Show more" toggle; the collapsed text is cut near `CUT_CHARS`. */
const SHOW_MORE_ABOVE = 250;
const CUT_CHARS = 220;
const SHOW_MORE_LINES = 7;
const CUT_LINES = 6;

/** First ~220 characters (cut at a word boundary, line breaks kept) for the collapsed card. */
export function collapseText(content: string): { text: string; truncated: boolean } {
  const lines = content.split('\n');
  if (content.length <= SHOW_MORE_ABOVE && lines.length <= SHOW_MORE_LINES) return { text: content, truncated: false };

  let text = lines.length > SHOW_MORE_LINES ? lines.slice(0, CUT_LINES).join('\n') : content;
  if (text.length > CUT_CHARS) {
    const cut = text.slice(0, CUT_CHARS);
    const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
    text = at > CUT_CHARS * 0.6 ? cut.slice(0, at) : cut;
  }
  return { text: `${text.trimEnd()}…`, truncated: true };
}

/**
 * "https://pulse.example.com/r/ab12cd" -> "pulse.example.com/r/ab12cd", shortened from the host side (the code
 * at the end is the part people recognise) to at most `max` characters.
 */
export function shortLink(url: string, max = 28): string {
  const bare = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
  if (bare.length <= max) return bare;
  const slash = bare.indexOf('/');
  if (slash < 0) return `${bare.slice(0, Math.max(1, max - 1))}…`;
  const host = bare.slice(0, slash);
  const path = bare.slice(slash);
  const room = max - path.length - 1;
  if (room < 4) return `…${path.slice(-Math.max(4, max - 1))}`;
  return `${host.slice(0, room)}…${path}`;
}

/** "Brew & Bloom" -> "@brewbloom" (fallback handle when no connection is known). */
export const handleFromBrand = (brand: string): string => `@${brand.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'brand'}`;
