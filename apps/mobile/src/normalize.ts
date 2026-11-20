/**
 * Tolerant parsers for the optional API features whose models have not landed in apps/api/app/models.py yet
 * (insights, harvest). They accept the plausible spellings of each field and always return the shapes in
 * src/types.ts, so the UI never sees `undefined`. When the real models land, tighten these in ONE place.
 */
import type {
  HarvestPlatformStatus,
  HarvestStatus,
  InsightSources,
  Insights,
  Platform,
  PlatformRate,
  ThemeInsight,
} from './types';
import { PLATFORMS } from './types';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const first = <T,>(...vals: (T | null | undefined)[]): T | null => {
  for (const v of vals) if (v !== null && v !== undefined) return v;
  return null;
};
const isPlatform = (v: unknown): v is Platform => typeof v === 'string' && (PLATFORMS as readonly string[]).includes(v);

/** Rates may arrive as fractions (0.062) or percents (6.2): normalise to a fraction. */
const rate = (v: unknown): number => {
  const n = num(v) ?? 0;
  return n > 1 ? n / 100 : n;
};

/** Lift is a fraction (0.35 = +35%). A percent-looking number (|x| > 5) or `lift_pct` is converted. */
const liftOf = (o: Rec): number => {
  const pct = num(o.lift_pct) ?? num(o.lift_percent);
  if (pct !== null) return pct / 100;
  const l = num(o.lift) ?? 0;
  return Math.abs(l) > 5 ? l / 100 : l;
};

export function normalizeInsights(raw: unknown, days = 30): Insights {
  const o = rec(raw);
  const themes: ThemeInsight[] = arr(first(o.top_themes, o.themes)).map((t) => {
    const r = rec(t);
    return {
      theme_id: str(r.theme_id) ?? str(r.id),
      name: str(r.name) ?? str(r.theme) ?? 'Theme',
      color: str(r.color),
      posts: num(r.posts) ?? num(r.post_count) ?? num(r.n) ?? 0,
      lift: liftOf(r),
      engagement_rate: num(r.engagement_rate) === null ? null : rate(r.engagement_rate),
    };
  });
  const platforms: PlatformRate[] = [];
  const rawPlatforms = first(o.by_platform, o.platforms, o.rates);
  const items: Rec[] = Array.isArray(rawPlatforms)
    ? rawPlatforms.map((p) => rec(p))
    : Object.entries(rec(rawPlatforms)).map(([k, v]): Rec => ({ platform: k, ...rec(v) }));
  for (const r of items) {
    if (!isPlatform(r.platform)) continue;
    platforms.push({
      platform: r.platform,
      views: num(r.views) ?? 0,
      engagement_rate: rate(r.engagement_rate ?? r.engagement),
      click_rate: rate(r.click_rate ?? r.ctr ?? r.clicks),
      conversion_rate: rate(r.conversion_rate ?? r.onboard_rate ?? r.conversions),
    });
  }
  const s = rec(o.sources);
  const sources: InsightSources = {
    real: num(s.real) ?? num(o.real) ?? 0,
    simulated: num(s.simulated) ?? num(s.sim) ?? num(o.simulated) ?? num(o.sim) ?? 0,
  };
  return {
    days: num(o.days) ?? days,
    summary: first(str(o.summary), str(o.text), str(o.body), str(o.advice)) ?? '',
    top_themes: themes.sort((a, b) => b.lift - a.lift),
    by_platform: platforms,
    sources,
    generated_at: first(str(o.generated_at), str(o.created_at), str(o.updated_at)),
  };
}

const harvestRow = (platform: Platform, r: Rec): HarvestPlatformStatus => ({
  platform,
  profile_url: first(str(r.profile_url), str(r.url)),
  last_harvested_at: first(str(r.last_harvested_at), str(r.harvested_at), str(r.last_run_at), str(r.last_run)),
  posts_harvested: first(num(r.posts_harvested), num(r.posts), num(r.count)),
  status: str(r.status),
});

export function normalizeHarvestStatus(raw: unknown): HarvestStatus {
  const o = rec(raw);
  const source = Array.isArray(raw) ? raw : first<unknown>(o.platforms, o.connections, o.items);
  const rows: HarvestPlatformStatus[] = [];
  if (Array.isArray(source)) {
    for (const item of source) {
      const r = rec(item);
      if (isPlatform(r.platform)) rows.push(harvestRow(r.platform, r));
    }
  } else {
    // keyed by platform, either at the top level or under `platforms`
    const keyed = rec(source ?? o);
    for (const p of PLATFORMS) if (keyed[p] !== undefined) rows.push(harvestRow(p, rec(keyed[p])));
  }
  const latest = rows
    .map((r) => r.last_harvested_at)
    .filter((v): v is string => !!v)
    .sort()
    .pop();
  return { platforms: rows, last_harvested_at: first(str(o.last_harvested_at), latest ?? null) };
}
