/** Pure helpers for the Trends screen: grouping, sorting, freshness, match wording and feed status. No React. */
import type { Trend, TrendSource, TrendSourceStatus, TrendsStatus } from '@/src/api';
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

/** Names for status sentences: "No Google trends came back yet." */
export const SOURCE_NAME: Record<TrendSource, string> = {
  hackernews: 'Hacker News',
  reddit: 'Reddit',
  google: 'Google',
};

/** Shown in place of the match bar and percentage when the workspace has no brand profile (relevance null). */
export const SET_UP_BRAND_TEXT = 'Set up your brand to see matches';

/** A trend is "Hot" at or above this source popularity (`score`). */
export const HOT_SCORE = 0.7;

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** 0.923 -> 92. */
export const toPct = (n: number): number => Math.round(clamp01(n) * 100);

/** The match to the brand profile, 0..1, or null when there is none to show (no profile, or an old server). */
export function knownRelevance(trend: Pick<Trend, 'relevance'>): number | null {
  return typeof trend.relevance === 'number' && Number.isFinite(trend.relevance) ? clamp01(trend.relevance) : null;
}

/** The words of the headline that overlap the brand profile. Missing on old servers: []. */
export function matchTermsOf(trend: Pick<Trend, 'match_terms'>): string[] {
  return Array.isArray(trend.match_terms) ? trend.match_terms.filter((w): w is string => typeof w === 'string') : [];
}

export interface TrendGroup {
  source: TrendSource;
  items: Trend[];
}

/** Match first (no match sorts last), then buzz, then title. */
export function byRelevance(a: Trend, b: Trend): number {
  return (
    (knownRelevance(b) ?? -1) - (knownRelevance(a) ?? -1) ||
    clamp01(b.score) - clamp01(a.score) ||
    a.title.localeCompare(b.title)
  );
}

/**
 * One group per source in `SOURCE_ORDER` (empty groups included, which keeps counts trivial), items sorted by
 * `byRelevance`. Duplicate ids are dropped so React keys stay unique; unknown sources are ignored.
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

/**
 * Oldest `fetched_at` across the trends, in epoch ms (null when none parses). The header shows this one, so it never
 * claims a fresher time than the oldest row on screen.
 */
export function oldestFetchedAt(trends: readonly Trend[]): number | null {
  let best: number | null = null;
  for (const trend of trends) {
    if (typeof trend.fetched_at !== 'string') continue;
    const ms = parseTs(trend.fetched_at).getTime();
    if (!Number.isNaN(ms) && (best === null || ms < best)) best = ms;
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

/** `["coffee", "plant", "shop"]` -> `"coffee", "plant" and "shop"`. */
function quoteList(words: readonly string[]): string {
  const quoted = words.map((w) => `"${w}"`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * The "why it matches" sentence for the expanded row. Names the overlapping words when there are some, says so
 * plainly when there are none, and explains the missing match when the workspace has no brand profile yet.
 */
export function matchReason(brand: string, relevance: number | null, terms: readonly string[]): string {
  if (relevance === null) return 'Matches are scored against your brand profile once it is set up.';
  if (terms.length > 0) return `Shares ${quoteList(terms)} with ${brand}'s profile.`;
  return `No words from ${brand}'s profile appear in this headline yet.`;
}

/** The source's status entry, or null when the status is unknown or has no entry for it. */
export function sourceStatusOf(status: TrendsStatus | null | undefined, source: TrendSource): TrendSourceStatus | null {
  if (!status || !Array.isArray(status.sources)) return null;
  return status.sources.find((s) => s && s.source === source) ?? null;
}

/** The first source whose last fetch failed (ok === false), or null. */
export function feedProblem(status: TrendsStatus | null | undefined): TrendSourceStatus | null {
  if (!status || !Array.isArray(status.sources)) return null;
  return status.sources.find((s) => s && s.ok === false) ?? null;
}

/** "Reddit feed failed: Blocked by Reddit (HTTP 403)." (no reason given: "Reddit feed failed."). */
export function failureSummary(source: TrendSource, error: string | null | undefined): string {
  const reason = typeof error === 'string' ? error.trim().replace(/[.!?\s]+$/, '') : '';
  return `${SOURCE_NAME[source]} feed failed${reason ? `: ${reason}.` : '.'}`;
}

/**
 * A failed source's line under the header. With rows on screen it says what they are from: "... Showing what we had
 * from 10h ago." Without rows (`ago` null) it asks for a refresh.
 */
export function sourceFailureNote(entry: TrendSourceStatus, ago: string | null): string {
  const summary = failureSummary(entry.source, entry.error);
  return ago ? `${summary} Showing what we had from ${ago}.` : `${summary} Refresh to try again.`;
}

/**
 * What an empty source says in place of its trends: the failure when the last fetch failed, else a plain "no trends
 * yet" (also when the status is unknown, e.g. on a server without /api/trends/status).
 */
export function sourceEmptyMessage(source: TrendSource, status: TrendsStatus | null | undefined): string {
  const entry = sourceStatusOf(status, source);
  if (entry && entry.ok === false) return sourceFailureNote(entry, null);
  return `No ${SOURCE_NAME[source]} trends came back yet. Refresh to try again.`;
}
