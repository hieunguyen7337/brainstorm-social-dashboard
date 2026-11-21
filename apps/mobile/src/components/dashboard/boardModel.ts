/** Pure helpers for the wide Dashboard board (no React): funnel names, channel lanes, lift formatting, urls. */
import { isLivePlatform, platformName } from '@/src/platforms';
import { parseTs } from '@/src/format';
import { colors } from '@/src/theme';
import type { Connection, FunnelStageName, Platform, Post } from '@/src/types';

/** The wide board names the funnel stages the way the founders do: Views, Engage, Click, Onboard. */
export const BOARD_FUNNEL_LABELS: Record<FunnelStageName, string> = {
  views: 'Views',
  engagements: 'Engage',
  clicks: 'Click',
  conversions: 'Onboard',
};

// ---- channel lanes ---------------------------------------------------------------------------------

export interface Lane {
  key: string;
  label: string;
  /** Platforms whose posts count in this lane. */
  platforms: readonly Platform[];
  /** Also draw the Threads glyph (Threads has no platform of its own: it shares X's lane). */
  threads?: boolean;
}

/** The lanes on the whiteboard, left to right. */
const ALL_LANES: readonly Lane[] = [
  { key: 'reddit', label: 'Reddit', platforms: ['reddit'] },
  { key: 'linkedin', label: 'LinkedIn', platforms: ['linkedin'] },
  { key: 'meta', label: 'Instagram + TikTok', platforms: ['instagram', 'tiktok'] },
  { key: 'x', label: 'X + Threads', platforms: ['x'], threads: true },
  { key: 'facebook', label: 'Facebook', platforms: ['facebook'] },
];

/** Lanes for live platforms only; a lane whose platforms are all "coming soon" is dropped. */
export const LANES: readonly Lane[] = ALL_LANES.map((lane) => {
  const live = lane.platforms.filter(isLivePlatform);
  const label = lane.key === 'meta' && live.length === 1 ? platformName(live[0]) : lane.label;
  return { ...lane, platforms: live, label };
}).filter((lane) => lane.platforms.length > 0);

export interface LaneCount {
  lane: Lane;
  drafts: number;
  scheduled: number;
  published: number;
}

/** Drafts (a failed post is a draft that needs a retry), scheduled and published posts per lane. */
export function laneCounts(posts: readonly Post[]): LaneCount[] {
  return LANES.map((lane) => {
    const mine = posts.filter((p) => lane.platforms.includes(p.platform));
    return {
      lane,
      drafts: mine.filter((p) => p.status === 'draft' || p.status === 'failed').length,
      scheduled: mine.filter((p) => p.status === 'scheduled').length,
      published: mine.filter((p) => p.status === 'published').length,
    };
  });
}

/** Newest drafts first (by creation time). */
export function latestDrafts(posts: readonly Post[], limit: number): Post[] {
  const stamp = (p: Post): number => {
    const n = parseTs(p.created_at).getTime();
    return Number.isNaN(n) ? 0 : n;
  };
  return posts
    .filter((p) => p.status === 'draft')
    .sort((a, b) => stamp(b) - stamp(a))
    .slice(0, limit);
}

// ---- connectors ------------------------------------------------------------------------------------

/** LinkedIn and Instagram are the two connectors that carry real data: they lead the card. */
export const FEATURED_CONNECTORS: readonly Platform[] = ['linkedin', 'instagram'];

/** Featured platforms first (in that order), then the rest in the given order. */
export function orderConnectors(all: readonly Platform[]): Platform[] {
  return [...FEATURED_CONNECTORS, ...all.filter((p) => !FEATURED_CONNECTORS.includes(p))];
}

/** Only web links are ever opened from server data. */
export function safeWebUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  return /^https?:\/\/[^\s]+$/i.test(u) ? u : null;
}

/** "https://www.linkedin.com/company/brewandbloom" -> "linkedin.com/company/brewandbloom". */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');
}

export const isConnected = (c: Connection | undefined): boolean => c?.status === 'connected';

// ---- theme lift ------------------------------------------------------------------------------------

export type LiftTone = 'up' | 'down' | 'flat';

/** `lift` is a fraction (0.25 = 25% above the baseline). Anything that rounds to 0% is flat. */
export function liftTone(lift: number): LiftTone {
  const pct = Math.round((Number.isFinite(lift) ? lift : 0) * 100);
  return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
}

export const LIFT_COLOR: Record<LiftTone, string> = {
  up: colors.success,
  down: colors.danger,
  flat: colors.textMute,
};

/** 0.254 -> "+25%", -0.18 -> "-18%", 0 -> "0%". */
export function fmtLift(lift: number): string {
  const pct = Math.round((Number.isFinite(lift) ? lift : 0) * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}
