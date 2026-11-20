/**
 * Pure helpers and shared types for the Create screen. No React and no react-native imports (types only), so the
 * logic is easy to reason about and to exercise on its own.
 */
import type { Platform, Post, Trend } from '@/src/types';

export const BRIEF_MAX = 1000;
/** Mirrors the API's `PostCreate.content` limit. */
export const POST_MAX = 5000;
export const TONES = ['Friendly', 'Bold', 'Witty', 'Professional', 'Inspiring'] as const;
/** The inline trend list asks for a few spares and shows the top ones. */
export const TREND_FETCH = 12;
export const TREND_SHOWN = 10;

/** Lighter violet for small accent text (the plain accent is a touch dim on the card surface). */
export const ACCENT_TEXT = '#a794ff';

/** The trend picked for this generation. `full` is set when the whole record is known (picked from the list). */
export interface TrendChoice {
  id: string;
  title: string;
  full?: Trend;
}

/** One finished generation, as the result view receives it. */
export interface Batch {
  id: string;
  aiUsed: boolean;
  posts: Post[];
  /** Theme colour used to tint the previews' placeholders. */
  themeColor: string | null;
}

export type Busy = 'saving' | 'publishing' | 'scheduling' | 'discarding';

/** The editable parts of a post. */
export interface Draft {
  content: string;
  hashtags: string[];
  mediaPrompt: string;
}

/** Unsaved local edits keyed by post id (only the fields the user touched). */
export type Edits = Record<string, Partial<Draft>>;

export const draftOf = (post: Post, edit?: Partial<Draft>): Draft => ({
  content: edit?.content ?? post.content,
  hashtags: edit?.hashtags ?? post.hashtags,
  mediaPrompt: edit?.mediaPrompt ?? post.media_prompt,
});

export const sameTags = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((tag, i) => tag === b[i]);

/** True when the local edit differs from what the server has. */
export function isDirty(post: Post, edit?: Partial<Draft>): boolean {
  if (!edit) return false;
  const d = draftOf(post, edit);
  return d.content !== post.content || d.mediaPrompt !== post.media_prompt || !sameTags(d.hashtags, post.hashtags);
}

/** Can still be edited, published or scheduled. */
export const isOpen = (post: Post): boolean => post.status === 'draft' || post.status === 'failed';

/** Already out the door (published or scheduled): read-only here. */
export const isDone = (post: Post): boolean => post.status === 'published' || post.status === 'scheduled';

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export const capitalise = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** First value of a route param (expo-router may hand back an array); empty strings count as missing. */
export function firstParam(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s ? s : undefined;
}

/** "@" + the brand name lowercased, without spaces or common punctuation: "Brew & Bloom" -> "@brewbloom". */
export function fallbackHandle(brand: string): string {
  const slug = brand.toLowerCase().replace(/[\s&'".,!?:;()\\/@#-]+/g, '');
  return `@${slug || 'brand'}`;
}

/** Sort items so their platforms follow `order` (unknown platforms go last). */
export function orderLike<T extends { platform: Platform }>(items: readonly T[], order: readonly Platform[]): T[] {
  const rank = (p: Platform): number => {
    const i = order.indexOf(p);
    return i === -1 ? order.length : i;
  };
  return [...items].sort((a, b) => rank(a.platform) - rank(b.platform));
}

export interface StatusMessage {
  text: string;
  /** The platform this line is about (its skeleton card lights up). */
  platform?: Platform;
}

/** The rotating lines shown while Claude writes. */
export function statusMessages(opts: {
  platforms: readonly Platform[];
  labelOf: (p: Platform) => string;
  hasTrend: boolean;
  themeName?: string | null;
}): StatusMessage[] {
  const out: StatusMessage[] = [
    { text: opts.hasTrend ? 'Reading the trend...' : 'Reading your brand profile...' },
    { text: 'Matching your brand voice...' },
  ];
  if (opts.themeName) out.push({ text: `Leaning into your ${opts.themeName} theme...` });
  for (const p of opts.platforms) out.push({ text: `Writing the ${opts.labelOf(p)} post...`, platform: p });
  out.push({ text: 'Adding tracked links...' }, { text: 'Polishing the final touches...' });
  return out;
}
