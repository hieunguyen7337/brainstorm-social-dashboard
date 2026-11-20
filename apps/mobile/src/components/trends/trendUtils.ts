/** Pure helpers for the Trends screen: grouping, filtering, URL handling and wording. No React. */
import type { Trend, TrendSource } from '@/src/api';
import { parseTs, timeAgo } from '@/src/format';

/** Group order in the default "All" view. */
export const SOURCE_ORDER: readonly TrendSource[] = ['hackernews', 'reddit', 'google'];

export type SourceFilter = 'all' | TrendSource;

/** Short names for filter chips and sentences (the long names live in `trendSourceMeta`). */
export const SOURCE_SHORT: Record<TrendSource, string> = {
  hackernews: 'Hacker News',
  reddit: 'Reddit',
  google: 'Google Trends',
};

/** A trend is "Hot" at or above this source popularity (`score`). */
export const HOT_SCORE = 0.7;

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** 0.923 -> 92. */
export const toPct = (n: number): number => Math.round(clamp01(n) * 100);

export interface TrendGroup {
  source: TrendSource;
  items: Trend[];
}

const byRelevance = (a: Trend, b: Trend): number =>
  clamp01(b.relevance) - clamp01(a.relevance) ||
  clamp01(b.score) - clamp01(a.score) ||
  a.title.localeCompare(b.title);

/**
 * One group per source in `SOURCE_ORDER` (empty groups included, which keeps counts trivial), items sorted by
 * relevance desc. Duplicate ids are dropped so React keys stay unique; unknown sources are ignored.
 */
export function buildGroups(trends: readonly Trend[]): TrendGroup[] {
  const seen = new Set<string>();
  const bySource = new Map<TrendSource, Trend[]>();
  for (const trend of trends) {
    if (seen.has(trend.id)) continue;
    seen.add(trend.id);
    const list = bySource.get(trend.source);
    if (list) list.push(trend);
    else bySource.set(trend.source, [trend]);
  }
  return SOURCE_ORDER.map((source) => ({ source, items: (bySource.get(source) ?? []).sort(byRelevance) }));
}

/** Newest `fetched_at` across the list, in epoch ms (null when none parses). */
export function latestFetchedAt(trends: readonly Trend[]): number | null {
  let best: number | null = null;
  for (const trend of trends) {
    if (typeof trend.fetched_at !== 'string') continue;
    const ms = parseTs(trend.fetched_at).getTime();
    if (!Number.isNaN(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}

/** "3m ago" for an epoch time, never "in 2m" when the server clock runs ahead of the phone's. */
export function agoFromMs(ms: number, now: number): string {
  return timeAgo(new Date(Math.min(ms, now)).toISOString(), now);
}

/** `timeAgo` that tolerates a missing / malformed timestamp. */
export function safeAgo(iso: unknown, now: number = Date.now()): string {
  return typeof iso === 'string' && iso ? agoFromMs(parseTs(iso).getTime(), now) : '';
}

/** "https://www.news.ycombinator.com/item?id=1" -> "news.ycombinator.com". Empty when there is no usable host. */
export function hostOf(url: unknown): string {
  if (typeof url !== 'string') return '';
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)/i.exec(url.trim());
  return m ? m[1].replace(/^www\./i, '').toLowerCase() : '';
}

/** The trimmed url when it is a plain http(s) link, else null (empty, relative, `javascript:` and friends). */
export function safeUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  return /^https?:\/\/[^\s/?#]+/i.test(u) && u.length <= 2048 ? u : null;
}

/** Plain-words reading of a relevance value. */
export function fitWord(relevance: number): string {
  const r = clamp01(relevance);
  if (r >= 0.75) return 'Strong fit';
  if (r >= 0.5) return 'Good fit';
  if (r >= 0.25) return 'Loose fit';
  return 'Wildcard';
}

/** Plain-words reading of a popularity value. */
export function buzzWord(score: number): string {
  const s = clamp01(score);
  if (s >= HOT_SCORE) return 'Hot right now';
  if (s >= 0.4) return 'Gaining traction';
  return 'Quiet so far';
}
