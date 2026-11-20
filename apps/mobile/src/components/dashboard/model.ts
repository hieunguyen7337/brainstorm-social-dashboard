/** View-model helpers for the dashboard: metric definitions, activity icon map and small pure functions. */
import type Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';

import { parseTs, timeAgo } from '@/src/format';
import { colors, platformMeta } from '@/src/theme';
import type { ActivityItem, DayStats, FunnelStageName, Platform, Post, Totals } from '@/src/types';

export type IconName = ComponentProps<typeof Ionicons>['name'];
export type MetricKey = keyof Totals;

export interface MetricDef {
  key: MetricKey;
  /** KPI tile label. */
  label: string;
  /** Label on the 30-day metric switcher. */
  chip: string;
  color: string;
  icon: IconName;
}

/** Metric colours are part of the product look: views violet, engagements pink, clicks cyan, conversions green. */
export const METRICS: readonly MetricDef[] = [
  { key: 'views', label: 'Views', chip: 'Views', color: colors.accent, icon: 'eye' },
  { key: 'engagements', label: 'Engagements', chip: 'Engagement', color: colors.accent2, icon: 'heart' },
  { key: 'clicks', label: 'Clicks', chip: 'Clicks', color: colors.info, icon: 'finger-print' },
  { key: 'conversions', label: 'Conversions', chip: 'Conversions', color: colors.success, icon: 'checkmark-circle' },
];

export const METRIC_BY_KEY: Record<MetricKey, MetricDef> = {
  views: METRICS[0],
  engagements: METRICS[1],
  clicks: METRICS[2],
  conversions: METRICS[3],
};

export const FUNNEL_ORDER: readonly FunnelStageName[] = ['views', 'engagements', 'clicks', 'conversions'];

export const FUNNEL_LABELS: Record<FunnelStageName, string> = {
  views: 'Views',
  engagements: 'Engagement',
  clicks: 'Clicks',
  conversions: 'Conversions',
};

/** Guard for strings that come from the server before indexing `platformMeta`. */
export const isPlatform = (p: string | null | undefined): p is Platform => !!p && p in platformMeta;

const tsMillis = (iso: string): number => {
  const n = parseTs(iso).getTime();
  return Number.isNaN(n) ? 0 : n;
};

/** Oldest first, so charts and sparklines always read left to right. Returns a new array. */
export const sortedDays = (days: DayStats[]): DayStats[] => [...days].sort((a, b) => a.day.localeCompare(b.day));

/** Newest first. Returns a new array. */
export const newestFirst = (items: ActivityItem[]): ActivityItem[] =>
  [...items].sort((a, b) => tsMillis(b.ts) - tsMillis(a.ts));

/** First non-empty line of a post, for one-line previews. */
export function firstLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim();
    if (s) return s;
  }
  return content.trim();
}

/** The most recently published post that has a tracked link (the one a judge just published). */
export function pickLinkPost(posts: Post[]): Post | undefined {
  let best: Post | undefined;
  let bestTs = -Infinity;
  for (const p of posts) {
    if (p.status !== 'published' || !p.link_url) continue;
    const ts = tsMillis(p.published_at ?? p.created_at);
    if (ts > bestTs) {
      best = p;
      bestTs = ts;
    }
  }
  return best;
}

/** `timeAgo`, but "just now" for events stamped in the future (a phone clock running ahead of the server). */
export function agoLabel(iso: string): string {
  return tsMillis(iso) > Date.now() ? 'just now' : timeAgo(iso);
}

// ---- activity feed icons -------------------------------------------------------------------------

export interface ActivityMeta {
  icon: IconName;
  color: string;
  size: number;
}

const ACTIVITY: Record<string, ActivityMeta | undefined> = {
  published: { icon: 'paper-plane', color: colors.accent, size: 16 },
  scheduled: { icon: 'calendar', color: colors.warn, size: 16 },
  views: { icon: 'eye', color: colors.accent, size: 16 },
  engagement: { icon: 'heart', color: colors.accent2, size: 16 },
  click: { icon: 'finger-print', color: colors.info, size: 16 },
  conversion: { icon: 'checkmark-circle', color: colors.success, size: 17 },
  generated: { icon: 'sparkles', color: colors.accent2, size: 16 },
  autopilot: { icon: 'rocket', color: colors.warn, size: 16 },
  connection: { icon: 'link', color: colors.info, size: 16 },
};

const ALIASES: Record<string, string | undefined> = {
  view: 'views',
  engagements: 'engagement',
  clicks: 'click',
  conversions: 'conversion',
  publish: 'published',
  schedule: 'scheduled',
  generate: 'generated',
  connected: 'connection',
  disconnected: 'connection',
  connect: 'connection',
};

const FALLBACK: ActivityMeta = { icon: 'ellipse', color: colors.textMute, size: 8 };

export function activityMeta(type: string): ActivityMeta {
  const key = type.trim().toLowerCase();
  return ACTIVITY[ALIASES[key] ?? key] ?? FALLBACK;
}
