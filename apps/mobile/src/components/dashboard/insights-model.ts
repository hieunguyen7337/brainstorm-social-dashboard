/**
 * Pure helpers behind the "What's working" card (no React, no I/O): which theme rows to show and how long their bars
 * are, which cells of the platform table are the best of their column, the wording of the sources note and the
 * "Updated ..." label. The components only render what these return.
 */
import { fmtInt, parseTs, timeAgo } from '@/src/format';
import { PLATFORMS, type InsightSources, type Platform, type PlatformRate, type ThemeInsight } from '@/src/types';

/** Rows under "Top themes". */
export const MAX_THEMES = 4;
/** The shortest bar a non-zero lift gets, so a small lift next to a big one is still visible. */
const MIN_BAR = 4;

const finite = (n: number): number => (Number.isFinite(n) ? n : 0);

// ---- themes --------------------------------------------------------------------------------------

export type LiftTone = 'up' | 'down' | 'flat';

/** 0.384 -> 38, -0.06 -> -6. Rounds the way the pill reads and turns -0 into 0, so a tiny lift shows "0%". */
export function liftPercent(lift: number): number {
  const pct = Math.round(finite(lift) * 100);
  return pct === 0 ? 0 : pct;
}

export const liftTone = (pct: number): LiftTone => (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat');

/** "1 post", "7 posts". */
export function postsLabel(n: number): string {
  const count = Math.max(0, Math.round(finite(n)));
  return `${fmtInt(count)} ${count === 1 ? 'post' : 'posts'}`;
}

export interface ThemeRow {
  key: string;
  name: string;
  color: string | null;
  posts: number;
  /** Whole percent, signed (the number in the pill). */
  pct: number;
  tone: LiftTone;
  /** Bar length 0..100: this row's |lift| against the largest |lift| shown. */
  bar: number;
}

/** The first `max` themes (the server sorts best first), each with its bar scaled to the largest |lift| among them. */
export function themeRows(themes: readonly ThemeInsight[], max: number = MAX_THEMES): ThemeRow[] {
  const shown = themes.slice(0, max).map((theme) => ({ theme, pct: liftPercent(theme.lift) }));
  const biggest = Math.max(0, ...shown.map((s) => Math.abs(s.pct)));
  return shown.map(({ theme, pct }, i) => ({
    key: `${theme.theme_id ?? theme.name}:${i}`,
    name: theme.name.trim() || 'Untitled theme',
    color: theme.color || null,
    posts: finite(theme.posts),
    pct,
    tone: liftTone(pct),
    bar: pct === 0 || biggest === 0 ? 0 : Math.max(MIN_BAR, (Math.abs(pct) / biggest) * 100),
  }));
}

// ---- per-platform rates ----------------------------------------------------------------------------

/** Engagement, click (CTR) and onboard rates as fractions, in column order. */
export type RateTriple = readonly [number, number, number];
type Column = 0 | 1 | 2;

export interface PlatformRow {
  platform: Platform;
  /** Null when the platform has no data at all (shown as dashes, never as a misleading 0.0%). */
  rates: RateTriple | null;
  /** Per column: true when this cell holds the best value of the table. */
  best: readonly [boolean, boolean, boolean];
}

/** What `fmtPct(x, 1)` prints, as an integer: values that print the same also compare equal. */
const printed = (x: number): number => Math.round(x * 1000);

/**
 * Rows in channel order (`PLATFORMS`), unknown platforms dropped. The best value of each column is flagged, but only
 * when at least two platforms have data (a lone row is trivially "best") and the best value is above zero.
 */
export function platformRows(rates: readonly PlatformRate[]): PlatformRow[] {
  const byPlatform = new Map<Platform, PlatformRate>();
  for (const r of rates) if (PLATFORMS.includes(r.platform) && !byPlatform.has(r.platform)) byPlatform.set(r.platform, r);

  const rows = PLATFORMS.flatMap((platform): { platform: Platform; rates: RateTriple | null }[] => {
    const r = byPlatform.get(platform);
    if (!r) return [];
    const triple: RateTriple = [finite(r.engagement_rate), finite(r.click_rate), finite(r.conversion_rate)];
    const empty = finite(r.views) <= 0 && triple.every((x) => x <= 0);
    return [{ platform, rates: empty ? null : triple }];
  });

  const withData = rows.flatMap((r) => (r.rates ? [r.rates] : []));
  const topOf = (col: Column): number => {
    if (withData.length < 2) return -1;
    const top = Math.max(...withData.map((triple) => printed(triple[col])));
    return top > 0 ? top : -1;
  };
  const tops = [topOf(0), topOf(1), topOf(2)];
  const isBest = (triple: RateTriple | null, col: Column): boolean => triple !== null && printed(triple[col]) === tops[col];

  return rows.map((r) => ({ ...r, best: [isBest(r.rates, 0), isBest(r.rates, 1), isBest(r.rates, 2)] as const }));
}

// ---- sources ----------------------------------------------------------------------------------------

export interface SourcesView {
  real: number;
  simulated: number;
  total: number;
  /** One honest sentence about where the numbers come from. */
  sentence: string;
}

const count = (n: number): number => Math.max(0, Math.round(finite(n)));

export function sourcesView(sources: InsightSources): SourcesView {
  const real = count(sources.real);
  const simulated = count(sources.simulated);
  const total = real + simulated;
  const sentence =
    real === 0
      ? 'These numbers come from the sandbox simulation. Add your LinkedIn or Instagram profile link in Settings to learn from real data.'
      : `${real} of ${total} ${total === 1 ? 'post uses' : 'posts use'} real platform data.`;
  return { real, simulated, total, sentence };
}

// ---- footer -------------------------------------------------------------------------------------------

/** "Updated 3m ago", or null when the server did not say when. A timestamp ahead of this phone's clock reads "just now". */
export function updatedLabel(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = parseTs(iso).getTime();
  if (Number.isNaN(at)) return null;
  return `Updated ${at > now ? 'just now' : timeAgo(iso, now)}`;
}
