/**
 * In-memory fake of the whole Pulse REST API (docs/CONTRACT.md), implementing `PulseApi`. Used for development
 * (EXPO_PUBLIC_MOCK=1) and as the offline-demo fallback when the real server is unreachable.
 *
 * - One module-level workspace, created (and seeded) by `createWorkspace`: 120 days of daily metrics, 6
 *   connections, 4 themes, 24 posts, trends and a lived-in activity feed. Seeds are deterministic per brand.
 * - No background timers: the audience simulation is closed-form and catches up lazily (`tick`) at the start of
 *   every polled call, so a post published a minute ago visibly grows on each 5 s poll.
 * - Activity `type` values: published, scheduled, views, engagement, click, conversion, generated, autopilot,
 *   connection. Events caused by a real person (tracked-link clicks/conversions) have `real: true`.
 */
import { APP_NAME } from './config';
import { ApiError, getToken, publicBaseUrl, raiseUnauthorized } from './http';
import {
  COPY, DEFAULT_BRAND, DEFAULT_PROFILE, FACTS, GENERIC_FACTS, LABEL, MEDIA, MODEL, SEED_NOTES, SEED_POSTS,
  SEED_THEMES, SHOTS, TAGS, THEME_CLASSIFIERS, THEME_EDGE, TREND_SEEDS,
} from './mockData';
import type { Mode } from './mockData';
import { PLATFORMS } from './types';
import type {
  ActivityItem, AutopilotConfig, AutopilotRun, ClassifierCounts, ClassifierName, Connection, DashboardSummary,
  InsightMetrics, InsightsResponse, LiftBy, Platform, PlatformInsight, Post, PostStatus, PulseApi, Theme,
  ThemeInsight, Totals, Trend, Workspace,
} from './types';

// ---- small helpers ------------------------------------------------------------------------------

type Rng = () => number;
type Range = readonly [number, number];
type Vars = Record<string, string>;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const HISTORY_DAYS = 120;
const AI_LIMIT = 30;
const AI_CAP_USD = 60;
const MILESTONES = [100, 500, 1000, 5000, 10000, 25000, 50000];

/** mulberry32: tiny deterministic PRNG. The same seed always yields the same sequence in [0, 1). */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: string -> uint32, to seed the PRNG from text. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Runtime randomness (ids, audience jitter). Seeds use their own deterministic stream instead. */
const entropy: Rng = mulberry32((Math.random() * 4294967296) >>> 0);

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** Like `parseTs` in format.ts: a timestamp without a zone is UTC. */
const parseIso = (v: string): number =>
  Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(v) || !v.includes('T') ? v : `${v}Z`);
const compact = (n: number): string => (n >= 1000 ? `${n / 1000}k` : String(n));
const uniq = (list: string[]): string[] => [...new Set(list.filter(Boolean))];
const cleanTags = (tags: readonly string[]): string[] => uniq(tags.map((t) => t.replace(/^#+/, '').trim()));

/** Round without bias (2.3 becomes 3 about 30% of the time) so small rates still add up. */
const stoch = (x: number, rng: Rng): number => Math.floor(x) + (rng() < x - Math.floor(x) ? 1 : 0);

/** Random hex id like the real API's (`secrets.token_hex(6)`). */
function rid(rng: Rng, len = 12): string {
  let out = '';
  for (let i = 0; i < len; i++) out += '0123456789abcdef'[Math.floor(rng() * 16)];
  return out;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

const sentence = (t: string): string => {
  const s = t.trim();
  return s ? `${s[0].toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}` : '';
};

function unprocessable(msg: string): never {
  throw new ApiError(422, msg);
}
function notFound(what: string): never {
  throw new ApiError(404, `${what} not found`);
}

const isPlatform = (v: unknown): v is Platform => typeof v === 'string' && (PLATFORMS as readonly string[]).includes(v);

function platformOf(v: unknown, field = 'platform'): Platform {
  if (!isPlatform(v)) unprocessable(`${field}: unknown platform`);
  return v;
}

/** Validate a list of platforms (deduped, order kept). */
function platformList(list: unknown, field = 'platforms'): Platform[] {
  if (!Array.isArray(list)) return unprocessable(`${field}: Input should be a valid list`);
  const out: Platform[] = [];
  for (const p of list as unknown[]) {
    const ok = platformOf(p, field);
    if (!out.includes(ok)) out.push(ok);
  }
  return out;
}

function checkContent(v: string): string {
  if (typeof v !== 'string' || !v.trim()) unprocessable('content: String should have at least 1 character');
  if (v.length > 5000) unprocessable('content: String should have at most 5000 characters');
  return v;
}

/** A required, valid `scheduled_at`, normalised to the format the API returns. */
function schedule(v: string | null | undefined): string {
  if (!v) unprocessable('scheduled_at: required when status is "scheduled"');
  const t = parseIso(v);
  if (Number.isNaN(t)) unprocessable('scheduled_at: Input should be a valid datetime');
  return iso(t);
}

/** Share of a post's lifetime views reached at age `h` hours: a fast burst, a shoulder and a long tail. */
const reached = (h: number): number =>
  0.4 * (1 - Math.exp(-h / 0.12)) + 0.38 * (1 - Math.exp(-h / 4)) + 0.22 * (1 - Math.exp(-h / 60));

// ---- state ----------------------------------------------------------------------------------------

/** Simulation bookkeeping for one post (never leaves this module). */
interface Sim {
  vmax: number; // lifetime views this post is on course for (followers x reach x quality)
  age: number; // hours the counters have been simulated up to
  acc: number[]; // fractional remainders: views, engagements, clicks, conversions
  eng: number; // this post's funnel ratios
  clk: number;
  cvr: number;
  noteViews: number; // growth since the last "+N views" activity entry
  noteEng: number;
  noteAt: number;
}
interface PostRec { post: Post; sim: Sim }
interface RealEvent { kind: 'click' | 'conversion'; platform: Platform; ts: number }

interface State {
  token: string;
  rng: Rng;
  ws: Workspace;
  slug: string;
  conns: Connection[];
  themes: Theme[];
  posts: PostRec[];
  daily: Map<string, Totals>; // keyed `platform|YYYY-MM-DD` (UTC)
  events: RealEvent[];
  activity: ActivityItem[]; // newest first; `note` keeps it ordered even for back-dated entries
  trends: Trend[];
  autopilot: AutopilotConfig;
  nextAutoAt: number | null;
  runs: number; // autopilot cycles so far (rotates the trend and theme)
  gen: number; // generate batches so far (varies the copy on every tap)
  aiUsed: number;
  aiSpent: number;
}

let state: State | null = null;
let aiAvailable = process.env.EXPO_PUBLIC_MOCK_AI === '1';

const conn = (s: State, p: Platform): Connection => s.conns[PLATFORMS.indexOf(p)];

/** Public profile page of the two platforms the mock pretends to read for real. */
const profileUrl = (p: Platform, handle: string): string => {
  const name = handle.replace(/^@/, '');
  return p === 'linkedin' ? `https://www.linkedin.com/company/${name}` : `https://www.instagram.com/${name}/`;
};

/** Add to the four funnel counters (works on a daily row or a post). */
function add(t: Totals, v: number, e: number, c: number, q: number): void {
  t.views += v;
  t.engagements += e;
  t.clicks += c;
  t.conversions += q;
}

function dayRow(s: State, p: Platform, day: string): Totals {
  const row = s.daily.get(`${p}|${day}`) ?? { views: 0, engagements: 0, clicks: 0, conversions: 0 };
  s.daily.set(`${p}|${day}`, row);
  return row;
}

interface NoteOpts { platform?: Platform | null; post?: string | null; real?: boolean; at?: number }

/** Add an activity entry, keeping the feed newest-first (back-dated entries slot in by time) and capped. */
function note(s: State, type: string, detail: string, o: NoteOpts = {}): void {
  const item: ActivityItem = {
    id: rid(s.rng), type, platform: o.platform ?? null, post_id: o.post ?? null, detail, real: o.real === true,
    ts: iso(o.at ?? Date.now()),
  };
  let i = 0;
  while (i < s.activity.length && s.activity[i].ts > item.ts) i++;
  s.activity.splice(i, 0, item);
  if (s.activity.length > 200) s.activity.length = 200;
}

/** First line of a post as a quoted snippet for activity copy (drops the TikTok "Hook (0-3s):" prefix). */
const snippet = (p: Post): string =>
  `“${clip(p.content.split('\n')[0].replace(/^Hook \([^)]*\):\s*/, ''), 56)}”`;

const fill = (tpl: string, v: Vars): string => tpl.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? '');

// ---- posts ----------------------------------------------------------------------------------------

interface NewPost {
  platform: Platform;
  content: string;
  status: PostStatus;
  source: Post['source'];
  hashtags?: string[];
  media_prompt?: string;
  theme_id?: string | null;
  trend_id?: string | null;
  batch_id?: string | null;
  scheduled_at?: string | null;
}

function linkCode(s: State, rng: Rng): string {
  for (;;) {
    const code = Math.floor(rng() * 36 ** 6).toString(36).padStart(6, '0');
    if (!s.posts.some((r) => r.post.link_code === code)) return code;
  }
}

/** Create a post (counters at 0) with its tracked link and a simulation profile. */
function addPost(s: State, n: NewPost, o: { rng?: Rng; at?: number; q?: number } = {}): PostRec {
  const rng = o.rng ?? s.rng;
  const m = MODEL[n.platform];
  const code = linkCode(s, rng);
  const jit = (k: number): number => 1 - k + 2 * k * rng();
  const rec: PostRec = {
    post: {
      id: rid(rng), platform: n.platform, content: n.content, hashtags: n.hashtags ?? [],
      media_prompt: n.media_prompt ?? '', theme_id: n.theme_id ?? null, trend_id: n.trend_id ?? null,
      batch_id: n.batch_id ?? null, link_code: code, link_url: `${publicBaseUrl()}/r/${code}`, status: n.status,
      source: n.source, scheduled_at: n.scheduled_at ?? null, published_at: null, views: 0, engagements: 0,
      clicks: 0, conversions: 0, created_at: iso(o.at ?? Date.now()),
    },
    sim: {
      vmax: Math.max(500, conn(s, n.platform).followers) * m.reach * (o.q ?? 0.6 + 0.9 * rng()),
      age: 0, acc: [0, 0, 0, 0], eng: m.eng * jit(0.15), clk: m.clk * jit(0.2), cvr: m.cvr * jit(0.3),
      noteViews: 0, noteEng: 0, noteAt: 0,
    },
  };
  s.posts.push(rec);
  return rec;
}

/** Publish (sandbox): counters stay at 0 and grow through `tick`. `at` back-dates scheduled posts to their slot. */
function goLive(s: State, r: PostRec, at: number): void {
  const p = r.post;
  p.status = 'published';
  p.published_at = iso(at);
  p.scheduled_at = null;
  r.sim.age = 0;
  note(s, 'published', `Published to ${LABEL[p.platform]}: ${snippet(p)}`, { platform: p.platform, post: p.id, at });
}

/** A click or conversion by a real person on a tracked link: post, today's row, event and activity feed. */
function realEvent(s: State, r: PostRec, kind: RealEvent['kind']): void {
  const p = r.post;
  const now = Date.now();
  const field = kind === 'click' ? 'clicks' : 'conversions';
  p[field] += 1;
  dayRow(s, p.platform, dayOf(now))[field] += 1;
  s.events.push({ kind, platform: p.platform, ts: now });
  const l = LABEL[p.platform];
  note(s, kind, kind === 'click' ? `A real person clicked your ${l} link` : `A real person converted from your ${l} link`, {
    platform: p.platform, post: p.id, real: true, at: now,
  });
}

// ---- audience simulation --------------------------------------------------------------------------

/** Add `dv` views (plus the engagements, clicks and conversions that follow) to a post and to today's row. */
function grow(s: State, r: PostRec, dv: number, now: number): void {
  const { post: p, sim } = r;
  const j = (): number => 0.85 + 0.3 * s.rng();
  const de = dv * sim.eng * j();
  const dc = de * sim.clk * j();
  const dq = dc * sim.cvr * j();
  const [wv, we, wc, wq] = [dv, de, dc, dq].map((x, i) => {
    sim.acc[i] += x;
    const whole = Math.floor(sim.acc[i]);
    sim.acc[i] -= whole;
    return whole;
  });
  const before = p.views;
  add(p, wv, we, wc, wq);
  add(dayRow(s, p.platform, dayOf(now)), wv, we, wc, wq);

  const c = conn(s, p.platform);
  if (c.status === 'connected') c.followers += stoch(wv * 0.0015, s.rng); // a few views turn into followers

  const l = LABEL[p.platform];
  const at = { platform: p.platform, post: p.id, at: now };
  for (const m of MILESTONES) if (before < m && p.views >= m) note(s, 'views', `Your ${l} post passed ${compact(m)} views`, at);
  sim.noteViews += wv;
  sim.noteEng += we;
  if (sim.noteViews >= 30 && now - sim.noteAt > 20_000) {
    const eng = sim.noteEng >= 3 && s.rng() < 0.3;
    note(s, eng ? 'engagement' : 'views', eng ? `+${sim.noteEng} likes and comments on your ${l} post` : `+${sim.noteViews} views on your ${l} post`, at);
    sim.noteViews = 0;
    sim.noteEng = 0;
    sim.noteAt = now;
  }
}

/** Catch the simulated world up to now: due scheduled posts go live, audiences grow, autopilot may run. */
function tick(s: State): void {
  const now = Date.now();
  for (const r of s.posts) {
    const due = r.post.status === 'scheduled' && r.post.scheduled_at ? parseIso(r.post.scheduled_at) : Infinity;
    if (due <= now) goLive(s, r, due);
  }
  for (const r of s.posts) {
    if (r.post.status !== 'published' || !r.post.published_at) continue;
    const age = (now - parseIso(r.post.published_at)) / HOUR;
    if (age <= r.sim.age) continue;
    const dv = r.sim.vmax * (reached(age) - reached(r.sim.age)) * (0.85 + 0.3 * s.rng());
    r.sim.age = age;
    grow(s, r, dv, now);
  }
  for (const c of s.conns) {
    // Real-data connectors re-read their profile every few minutes.
    if (c.real_data && c.status === 'connected' && now - parseIso(c.last_harvested_at ?? c.connected_at) >= HARVEST_EVERY) {
      c.last_harvested_at = iso(now);
    }
  }
  if (s.autopilot.enabled && s.nextAutoAt !== null && now >= s.nextAutoAt) {
    try {
      autopilotCycle(s, now);
    } catch {
      s.nextAutoAt = now + s.autopilot.interval_min * MIN; // a failed cycle must never break polling
    }
  }
}

// ---- dashboard --------------------------------------------------------------------------------------

function dashboard(s: State, days: number, platform: Platform | null): DashboardSummary {
  const now = Date.now();
  const plats: Platform[] = platform ? [platform] : [...PLATFORMS];
  /** Sum daily rows for `n` days starting `from` days back (0 = today). */
  const sum = (ps: Platform[], from: number, n: number): Totals => {
    const t: Totals = { views: 0, engagements: 0, clicks: 0, conversions: 0 };
    for (let i = from; i < from + n; i++) {
      for (const p of ps) {
        const r = s.daily.get(`${p}|${dayOf(now - i * DAY)}`);
        if (r) add(t, r.views, r.engagements, r.clicks, r.conversions);
      }
    }
    return t;
  };
  const totals = sum(plats, 0, days);
  const prev = sum(plats, days, days);
  const pct = (a: number, b: number): number => (b > 0 ? Math.round(((a - b) / b) * 100) : 0);
  const rate = (a: number, b: number): number => (b > 0 ? a / b : 0);
  const since = Date.parse(`${dayOf(now - (days - 1) * DAY)}T00:00:00Z`);
  const real = s.events.filter((e) => e.ts >= since && (!platform || e.platform === platform));

  return {
    days,
    totals,
    change_pct: {
      views: pct(totals.views, prev.views), engagements: pct(totals.engagements, prev.engagements),
      clicks: pct(totals.clicks, prev.clicks), conversions: pct(totals.conversions, prev.conversions),
    },
    by_platform: plats
      .map((p) => {
        const t = sum([p], 0, days);
        return { platform: p, ...t, share: rate(t.views, totals.views) };
      })
      .sort((a, b) => b.views - a.views),
    funnel: [
      { stage: 'views', value: totals.views, rate: 1 },
      { stage: 'engagements', value: totals.engagements, rate: rate(totals.engagements, totals.views) },
      { stage: 'clicks', value: totals.clicks, rate: rate(totals.clicks, totals.engagements) },
      { stage: 'conversions', value: totals.conversions, rate: rate(totals.conversions, totals.clicks) },
    ],
    timeseries: Array.from({ length: days }, (_v, k) => {
      const t = sum(plats, days - 1 - k, 1);
      return { day: dayOf(now - (days - 1 - k) * DAY), ...t };
    }),
    top_posts: s.posts
      .filter((r) => r.post.status === 'published' && (!platform || r.post.platform === platform))
      .sort((a, b) => b.post.views - a.post.views)
      .slice(0, 5)
      .map((r) => r.post),
    real_clicks: real.filter((e) => e.kind === 'click').length,
    real_conversions: real.filter((e) => e.kind === 'conversion').length,
  };
}

// ---- insights ---------------------------------------------------------------------------------------

/** The mock keeps lifts in a believable band: tiny seed samples would otherwise swing to -100% or +400%. */
const LIFT_MIN = -0.3;
const LIFT_MAX = 0.8;
const HARVEST_EVERY = 10 * MIN;
const REAL_DATA_PLATFORMS: readonly Platform[] = ['linkedin', 'instagram'];

interface InsightAcc { posts: number; views: number; engagements: number; clicks: number; onboard: number }

const newAcc = (): InsightAcc => ({ posts: 0, views: 0, engagements: 0, clicks: 0, onboard: 0 });
const addToAcc = (a: InsightAcc, p: Post): void => {
  a.posts += 1;
  a.views += p.views;
  a.engagements += p.engagements;
  a.clicks += p.clicks;
  a.onboard += p.conversions;
};
const per = (n: number, views: number): number => (views > 0 ? n / views : 0);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round5 = (n: number): number => Math.round(n * 100000) / 100000;

const metricsOf = (a: InsightAcc): InsightMetrics => ({
  ...a,
  engagement_rate: round5(per(a.engagements, a.views)),
  click_rate: round5(per(a.clicks, a.views)),
  onboard_rate: round5(per(a.onboard, a.views)),
});

/** Lift of a group against the workspace baseline: the primary one is onboard, else click, else engagement rate. */
function liftsOf(a: InsightAcc, base: InsightAcc): { lift: number; lift_by: LiftBy } {
  if (a.posts === 0) return { lift: 0, lift_by: { engagement_rate: 0, click_rate: 0, onboard_rate: 0 } };
  const by = (n: number, baseN: number): number => {
    const b = per(baseN, base.views);
    return b > 0 ? round3(clamp(per(n, a.views) / b - 1, LIFT_MIN, LIFT_MAX)) + 0 : 0;
  };
  const lift_by: LiftBy = {
    engagement_rate: by(a.engagements, base.engagements),
    click_rate: by(a.clicks, base.clicks),
    onboard_rate: by(a.onboard, base.onboard),
  };
  const primary = base.onboard > 0 ? lift_by.onboard_rate : base.clicks > 0 ? lift_by.click_rate : lift_by.engagement_rate;
  return { lift: primary, lift_by };
}

/**
 * Who sorted this post into its theme. Seed themes follow THEME_CLASSIFIERS by the post's position among the
 * theme's published posts (oldest first, so a classifier never changes once assigned); a theme the person created
 * is theirs, so "manual".
 */
function classifierOf(s: State, post: Post): ClassifierName {
  const idx = s.themes.findIndex((t) => t.id === post.theme_id);
  const pattern = idx >= 0 && idx < SEED_THEMES.length ? THEME_CLASSIFIERS[idx] : undefined;
  if (!pattern) return 'manual';
  const rank = s.posts
    .map((r) => r.post)
    .filter((p) => p.status === 'published' && p.theme_id === post.theme_id)
    .sort((a, b) => parseIso(a.published_at ?? a.created_at) - parseIso(b.published_at ?? b.created_at))
    .findIndex((p) => p.id === post.id);
  return pattern[Math.max(0, rank) % pattern.length];
}

const addClassifier = (counts: ClassifierCounts, name: ClassifierName): void => {
  counts[name] = (counts[name] ?? 0) + 1;
};

const strongest = (list: { lift: number; views: number }[]): number =>
  list.reduce((best, x, i) => (x.views > 0 && (best < 0 || x.lift > list[best].lift) ? i : best), -1);

const pctOf = (n: number): string => `${(n * 100).toFixed(n >= 0.01 ? 1 : 2)}%`;
const vsAverage = (lift: number): string => {
  const p = Math.round(Math.abs(lift) * 100);
  return p === 0 ? 'in line with your average' : `${p}% ${lift > 0 ? 'above' : 'below'} your average`;
};

function insights(s: State, days: number): InsightsResponse {
  const since = Date.now() - days * DAY;
  const published = s.posts
    .map((r) => r.post)
    .filter((p) => p.status === 'published' && p.published_at && parseIso(p.published_at) >= since);

  const base = newAcc();
  const byTheme = new Map<string, { acc: InsightAcc; classifiers: ClassifierCounts }>();
  const byPlatform = new Map<Platform, InsightAcc>();
  const total: ClassifierCounts = {};
  let real = 0;
  for (const p of published) {
    addToAcc(base, p);
    const pa = byPlatform.get(p.platform) ?? newAcc();
    byPlatform.set(p.platform, pa);
    addToAcc(pa, p);
    if (REAL_DATA_PLATFORMS.includes(p.platform) && conn(s, p.platform).real_data) real += 1;
    if (!p.theme_id || !s.themes.some((t) => t.id === p.theme_id)) continue;
    const g = byTheme.get(p.theme_id) ?? { acc: newAcc(), classifiers: {} };
    byTheme.set(p.theme_id, g);
    addToAcc(g.acc, p);
    const who = classifierOf(s, p);
    addClassifier(g.classifiers, who);
    addClassifier(total, who);
  }

  const themes: ThemeInsight[] = s.themes
    .filter((t) => t.active || byTheme.has(t.id))
    .map((t) => {
      const g = byTheme.get(t.id);
      const acc = g?.acc ?? newAcc();
      return {
        theme_id: t.id, name: t.name, color: t.color, ...metricsOf(acc), ...liftsOf(acc, base),
        classifiers: g?.classifiers ?? {},
      };
    })
    .sort((a, b) => b.lift - a.lift || b.views - a.views || a.name.localeCompare(b.name));
  const platforms: PlatformInsight[] = [...byPlatform.entries()]
    .map(([platform, acc]) => ({ platform, ...metricsOf(acc), ...liftsOf(acc, base) }))
    .sort((a, b) => b.views - a.views || a.platform.localeCompare(b.platform));
  const top_themes = themes.filter((t) => t.posts >= 2 && t.views > 0).slice(0, 3);

  const b = metricsOf(base);
  const sources = { real, simulated: published.length - real };
  const parts: string[] = [];
  if (b.posts === 0) {
    parts.push(`There are no published posts in the last ${days} days yet, so there is nothing to learn from. Publish a few posts across your themes and platforms, then refresh to see what works.`);
  } else {
    parts.push(`In the last ${days} days, ${b.posts} published ${b.posts === 1 ? 'post' : 'posts'} earned ${b.views.toLocaleString('en-AU')} views, with a ${pctOf(b.engagement_rate)} engagement rate, a ${pctOf(b.click_rate)} click rate and a ${pctOf(b.onboard_rate)} onboard rate.`);
    if (top_themes.length) parts.push(`'${top_themes[0].name}' is the strongest theme: its onboard rate is ${vsAverage(top_themes[0].lift)} (${top_themes[0].posts} posts).`);
    const best = strongest(platforms);
    if (platforms.length >= 2 && best >= 0) parts.push(`${LABEL[platforms[best].platform]} is the strongest platform: its onboard rate is ${vsAverage(platforms[best].lift)} (${platforms[best].posts} posts).`);
    parts.push(sources.real > 0 ? `${sources.real} of these ${b.posts} posts have real metrics; the rest are simulated.` : 'All of these numbers come from simulated sandbox audiences, not real people.');
  }

  return {
    days, baseline: b, themes, platforms, top_themes, sources, summary: parts.join(' '), cached_summary: null,
    classifiers: total,
  };
}

// ---- seeding ----------------------------------------------------------------------------------------

/** 120 days of per-platform daily metrics: drift, weekly seasonality, noise, spikes and the funnel ratios. */
function seedDaily(s: State, now: number, rng: Rng): void {
  const todayShare = 0.6 + 0.4 * ((now % DAY) / DAY); // today is partial, but not a cliff on the chart
  for (const p of PLATFORMS) {
    const m = MODEL[p];
    // Error-diffusion rounding: each day's rounding error carries into the next, so small daily counts
    // (conversions) still add up to the expected funnel ratios over a month.
    const carry = [0, 0, 0, 0];
    const whole = (x: number, i: number): number => {
      const n = Math.max(0, Math.round(x + carry[i]));
      carry[i] += x - n;
      return n;
    };
    for (let off = HISTORY_DAYS - 1; off >= 0; off--) {
      const t = now - off * DAY;
      const level = m.views * Math.max(0.4, 1 - (m.growth * off) / 60);
      let v = level * m.weekly[new Date(t).getUTCDay()] * (1 + m.sigma * (rng() * 2 - 1));
      if (rng() < m.spike) v *= 1.6 + rng() * 2;
      if (off === 0) v *= todayShare;
      const views = whole(v, 0);
      const engagements = whole(views * m.eng * (1 - 0.0005 * off) * (1 + 0.12 * (rng() * 2 - 1)), 1);
      const clicks = whole(engagements * m.clk * (1 - 0.0008 * off) * (1 + 0.18 * (rng() * 2 - 1)), 2);
      const conversions = whole(clicks * m.cvr * (1 - 0.0011 * off) * (1 + 0.25 * (rng() * 2 - 1)), 3);
      s.daily.set(`${p}|${dayOf(t)}`, { views, engagements, clicks, conversions });
    }
  }
}

function seedPosts(s: State, now: number, rng: Rng): void {
  const vars = { brand: s.ws.brand_name, offer: s.ws.offer, slug: s.slug };
  for (const sp of SEED_POSTS) {
    const at = sp.status === 'scheduled' ? now + sp.hours * HOUR : now - sp.hours * HOUR;
    const created =
      sp.status === 'published' ? at - (1 + 5 * rng()) * HOUR : sp.status === 'scheduled' ? now - (4 + 20 * rng()) * HOUR : at;
    const rec = addPost(
      s,
      {
        platform: sp.platform, content: fill(sp.content, vars), hashtags: sp.hashtags.map((t) => fill(t, vars)),
        media_prompt: fill(sp.media ?? '', vars), theme_id: s.themes[sp.theme].id, status: sp.status, source: 'seed',
        scheduled_at: sp.status === 'scheduled' ? iso(at) : null,
      },
      { rng, at: created, q: sp.q * (0.92 + 0.16 * rng()) },
    );
    if (sp.status !== 'published') continue;
    const { post: p, sim } = rec;
    const edge = THEME_EDGE[sp.theme];
    if (edge) {
      sim.eng *= edge[0]; // some themes simply convert better (shows up in the insights lift)
      sim.clk *= edge[1];
      sim.cvr *= edge[2];
    }
    p.published_at = iso(at);
    sim.age = sp.hours; // counters sit on the same curve `tick` continues along
    p.views = Math.round(sim.vmax * reached(sp.hours));
    p.engagements = stoch(p.views * sim.eng, rng);
    p.clicks = stoch(p.engagements * sim.clk, rng);
    p.conversions = stoch(p.clicks * sim.cvr, rng);
  }
}

function seedActivity(s: State, now: number, rng: Rng): void {
  for (const c of s.conns) {
    note(s, 'connection', `Connected ${LABEL[c.platform]} (${c.handle})`, { platform: c.platform, at: parseIso(c.connected_at) });
  }
  for (const { post: p } of s.posts) {
    const l = LABEL[p.platform];
    const o = { platform: p.platform, post: p.id, at: parseIso(p.published_at ?? p.created_at) };
    if (p.status === 'published') note(s, 'published', `Published to ${l}: ${snippet(p)}`, o);
    else if (p.status === 'scheduled') note(s, 'scheduled', `Scheduled for ${l}: ${snippet(p)}`, o);
    else note(s, 'generated', `Drafted for ${l}: ${snippet(p)}`, o);
  }
  const live = s.posts.filter((r) => r.post.status === 'published').map((r) => r.post);
  for (const p of [...live].sort((a, b) => b.views - a.views).slice(0, 4)) {
    const m = [...MILESTONES].reverse().find((x) => x <= p.views);
    const at = Math.min(now - 5 * MIN, parseIso(p.published_at ?? p.created_at) + (2 + 6 * rng()) * HOUR);
    if (m) note(s, 'views', `Your ${LABEL[p.platform]} post passed ${compact(m)} views`, { platform: p.platform, post: p.id, at });
  }
  for (const p of [...live].sort((a, b) => b.engagements - a.engagements).slice(0, 2)) {
    const at = Math.min(now - 5 * MIN, parseIso(p.published_at ?? p.created_at) + (3 + 8 * rng()) * HOUR);
    note(s, 'engagement', `Your ${LABEL[p.platform]} post passed ${Math.floor(p.engagements / 100) * 100} engagements`, { platform: p.platform, post: p.id, at });
  }
  for (const n of SEED_NOTES) note(s, n.type, n.detail, { platform: n.platform, at: now - n.hours * HOUR });
}

function seed(brandInput: string | null | undefined): State {
  const now = Date.now();
  const brand = (brandInput ?? '').trim().slice(0, 60) || DEFAULT_BRAND;
  const slug = brand.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'pulsedemo';
  const rng = mulberry32(hashStr(brand.toLowerCase())); // same brand, same demo data
  const created = iso(now - 61 * DAY);
  const s: State = {
    token: `mock_${rid(entropy, 16)}`,
    rng: entropy,
    ws: {
      id: rid(rng), name: `${brand} workspace`, brand_name: brand, brand_voice: DEFAULT_PROFILE.voice,
      audience: DEFAULT_PROFILE.audience, offer: DEFAULT_PROFILE.offer, product_url: `https://${slug}.example.com`,
      created_at: created,
    },
    slug,
    conns: PLATFORMS.map(
      (p, i): Connection => ({
        platform: p, handle: p === 'reddit' ? `u/${slug}` : `@${slug}`, status: 'connected', mode: 'sandbox',
        followers: Math.round(MODEL[p].followers * (0.985 + 0.03 * rng())),
        connected_at: iso(now - (58 - i * 6 - Math.floor(rng() * 4)) * DAY),
        ...(p === 'linkedin' || p === 'instagram'
          ? { profile_url: profileUrl(p, slug), last_harvested_at: iso(now - (p === 'linkedin' ? 4 : 7) * MIN), real_data: true }
          : {}),
      }),
    ),
    themes: SEED_THEMES.map((t): Theme => ({ id: rid(rng), ...t, active: true, created_at: created })),
    posts: [],
    daily: new Map(),
    events: [],
    activity: [],
    trends: TREND_SEEDS.map(
      (t): Trend => ({
        id: `t${hashStr(t.source + t.title).toString(36)}`, source: t.source, title: t.title, url: t.url,
        score: t.score, relevance: round2(clamp(t.relevance + (rng() - 0.5) * 0.06, 0.02, 0.99)),
        fetched_at: iso(now - (2 + 7 * rng()) * MIN),
      }),
    ),
    autopilot: { enabled: false, interval_min: 30, platforms: [], require_approval: true, last_run_at: null },
    nextAutoAt: null,
    runs: 0, gen: 0, aiUsed: 0, aiSpent: 3.42,
  };
  seedDaily(s, now, rng);
  seedPosts(s, now, rng);
  seedActivity(s, now, rng);
  return s;
}

// ---- generation -------------------------------------------------------------------------------------

interface Ctx {
  brand: string; slug: string; offer: string; who: string; brief: string; tone: string;
  theme: Theme | null; trend: Trend | null;
}
interface Draft { content: string; hashtags: string[]; media_prompt: string }

const STOP = /^(a|an|the|and|or|for|to|of|in|on|at|is|are|was|be|it|its|you|your|how|why|what|whats|that|this|with|from|have|about|just|more|than|should|would|could|when|where|which|will|into|them|they|their|here|there|ask|show|me|my|i|we|us|do|does|did|can|who)$/i;
const EMOJI = /[\u2600-\u27BF\uFE0F]|[\uD83C-\uD83E][\uDC00-\uDFFF]/g;

/** "Black Friday deals 2026" -> "BlackFriday" (stop words dropped when `skipStop`). */
const tagify = (t: string, words: number, skipStop: boolean): string =>
  t.replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !(skipStop && STOP.test(w)))
    .slice(0, words).map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 24);

/** "Announce our new beans" -> "We're announcing our new beans." (a brief is an instruction, the copy a statement). */
function briefLine(brief: string): string {
  const b = brief.trim().replace(/^(announce|promote|highlight|push|share|introduce|launch|showcase|celebrate|feature|mention|talk|tell|write|post|focus|remind|thank|welcome|invite)\b/i, (m) => `We're ${m.toLowerCase().replace(/e$/, '')}ing`);
  return sentence(b);
}

/** 0 behind the scenes, 1 product, 2 customer love, 3 tips, 4 any other custom theme, -1 no theme. */
function themeKind(t: Theme | null): number {
  if (!t) return -1;
  const n = t.name.toLowerCase();
  if (/behind|scene|team|story|process/.test(n)) return 0;
  if (/product|spotlight|launch|menu|range/.test(n)) return 1;
  if (/customer|love|review|testimonial|community|shout/.test(n)) return 2;
  if (/\btips?\b|how-?to|guide|tutorial|hack/.test(n)) return 3;
  return 4;
}

/** Two different one-line facts that fit the theme. Brand-generic ones when there is no theme or a brief steers the copy. */
function twoFacts(c: Ctx, kind: number, rng: Rng): [string, string] {
  const name = c.theme?.name ?? '';
  const custom = [c.theme?.description ?? '', `${name} is a big part of how we do things at {brand}.`, `We keep coming back to ${name.toLowerCase()} because our customers do.`].filter(Boolean);
  const pool = kind < 0 || c.brief ? GENERIC_FACTS : kind <= 3 ? FACTS[kind] : custom;
  const i = pool === custom && name && c.theme?.description && rng() < 0.7 ? 0 : Math.floor(rng() * pool.length); // lead with the description
  const j = (i + 1 + Math.floor(rng() * (pool.length - 1))) % pool.length;
  return [fill(pool[i], { brand: c.brand }), fill(pool[j], { brand: c.brand })];
}

/** Template text that fits `max` characters: drop the fact if needed, then clip at a word. */
function fit(tpl: string, v: Vars, max: number): string {
  const full = fill(tpl, v);
  return clip(full.length <= max ? full : fill(tpl, { ...v, fact: '', fact2: '' }), max);
}

/** Tone nudges: formal drops emoji and exclamation marks, playful guarantees a smile (not on LinkedIn or Reddit). */
function applyTone(text: string, tone: string, platform: Platform): string {
  const t = tone.toLowerCase();
  if (/professional|formal|serious|authorit|corporate/.test(t)) return text.replace(EMOJI, '').replace(/!/g, '.').replace(/ +\n/g, '\n').replace(/ {2,}/g, ' ').trim();
  const smile = /playful|fun|witty|cheeky|quirky/.test(t) && platform !== 'linkedin' && platform !== 'reddit';
  return smile && text.search(EMOJI) < 0 ? text.replace(/\n|$/, ' 😄$&') : text;
}

/** One platform-native variant. Never includes the tracked URL (the post carries it separately). */
function compose(platform: Platform, c: Ctx, rng: Rng): Draft {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rng() * a.length)];
  const shuffled = (a: readonly string[]): string[] => [...a].sort(() => rng() - 0.5);
  const mode: Mode = c.trend ? 'trend' : c.brief ? 'brief' : 'plain';
  const kind = themeKind(c.theme);
  const k = kind >= 0 && kind <= 3 ? kind : 4;
  const [f1, f2] = twoFacts(c, kind, rng);
  const brief = briefLine(c.brief);
  const trend = c.trend ? c.trend.title.replace(/[\s.!?]+$/, '') : '';
  const v: Vars = {
    brand: c.brand, slug: c.slug, offer: c.offer, who: c.who, theme: c.theme?.name ?? 'our story', trend,
    trendShort: clip(trend, 52), brief, briefShort: clip(brief.replace(/[.!?]+$/, ''), 70),
    fact: mode === 'trend' && brief ? `${brief} ${f1}` : f1, fact2: f2,
  };
  const tTag = c.trend ? tagify(c.trend.title, 2, true) : '';
  const thTag = c.theme ? tagify(c.theme.name.split(/[&,/]/)[0], 3, false) : '';
  const lower = (t: string): string => t.toLowerCase();
  const photo = (aspect: string): string => `${fill(MEDIA[k][Math.floor(rng() * 2)], v)}, ${aspect}`;
  let content: string;
  let hashtags: string[] = [];
  let media_prompt = '';

  switch (platform) {
    case 'x':
      content = fit(pick(COPY.x[mode]), v, 270);
      hashtags = uniq([tTag, pick(TAGS.x), thTag]).slice(0, rng() < 0.5 ? 1 : 2);
      break;
    case 'linkedin': {
      const soft = rng() < 0.5 ? ` If you want to taste the difference: ${c.offer}.` : '';
      content = [
        fill(pick(COPY.linkedin.open[mode]), v),
        fill(pick(COPY.linkedin.insight), v),
        pick(COPY.linkedin.takeaway) + soft,
        pick(COPY.linkedin.question),
      ].join('\n\n');
      hashtags = uniq([tTag, thTag, pick(TAGS.biz), 'SmallBusiness', 'Coffee', 'Entrepreneurship']).slice(0, 3);
      media_prompt = photo('landscape 1.91:1');
      break;
    }
    case 'instagram':
      content = [fill(pick(COPY.instagram.hook[mode]), v), `${v.fact}\n${v.fact2}`, fill(pick(COPY.instagram.cta), v)].join('\n\n');
      hashtags = uniq([c.slug, thTag, tTag, ...shuffled(TAGS.coffee)].map(lower)).slice(0, 8 + Math.floor(rng() * 5));
      media_prompt = `${photo('4:5 portrait')}.`;
      break;
    case 'tiktok':
      content = [
        `Hook (0-3s): ${fill(pick(COPY.tiktok.hook[mode]), v)}`,
        `Beat 1 (3-8s): ${v.fact}`,
        `Beat 2 (8-14s): ${v.fact2}`,
        `CTA (14-18s): ${fill(pick(COPY.tiktok.cta), v)}`,
      ].join('\n');
      hashtags = uniq(['coffeetok', lower(tTag), lower(thTag), ...shuffled(TAGS.tiktok)]).slice(0, 3 + Math.floor(rng() * 3));
      media_prompt = SHOTS[k];
      break;
    case 'reddit':
      content = `${clip(fill(pick(COPY.reddit.title[mode]), v), 120)}\n\n${fill(pick(COPY.reddit.body), v)}`;
      break;
    default: // facebook
      content = `${fill(pick(COPY.facebook.open[mode]), v)}\n\n${pick(COPY.facebook.ask)}`;
      hashtags = uniq([pick(TAGS.facebook), lower(thTag), lower(tTag)]).slice(0, 1 + Math.floor(rng() * 3));
      media_prompt = photo('landscape 16:9');
  }
  content = applyTone(content, c.tone, platform);
  return { content: platform === 'x' ? clip(content, 270) : content, hashtags, media_prompt };
}

interface Batch {
  platforms: Platform[]; theme: Theme | null; trend: Trend | null; brief: string; tone: string;
  source: 'ai' | 'autopilot'; publish: boolean;
}

/** Draft (or publish) one post per platform. The copy varies with the inputs and a per-call counter. */
function makePosts(s: State, b: Batch): { batch: string; recs: PostRec[] } {
  const batch = rid(s.rng);
  s.gen += 1;
  const salt = hashStr([b.theme?.id, b.trend?.id, b.brief, b.tone, b.platforms.join()].join('|')) ^ Math.imul(s.gen, 0x9e3779b1);
  const ctx: Ctx = {
    brand: s.ws.brand_name, slug: s.slug, offer: s.ws.offer.trim() || 'Come say hello',
    who: s.ws.audience.split(/,| who /)[0].trim() || 'coffee lovers', theme: b.theme, trend: b.trend, brief: b.brief, tone: b.tone,
  };
  const recs = b.platforms.map((platform, i) => {
    const rec = addPost(s, {
      platform, ...compose(platform, ctx, mulberry32(salt + i * 7919)), theme_id: b.theme?.id ?? null,
      trend_id: b.trend?.id ?? null, batch_id: batch, status: 'draft', source: b.source,
    });
    if (b.publish) goLive(s, rec, Date.now());
    return rec;
  });
  return { batch, recs };
}

// ---- autopilot ----------------------------------------------------------------------------------------

const byRelevance = (a: Trend, b: Trend): number => b.relevance - a.relevance || b.score - a.score;

/** One cycle: the most relevant trend (rotating through the top three) plus an active theme. Null when nothing to post to. */
function autopilotCycle(s: State, now: number): AutopilotRun | null {
  const cfg = s.autopilot;
  const platforms = cfg.platforms.length ? cfg.platforms : s.conns.filter((c) => c.status === 'connected').map((c) => c.platform);
  if (!platforms.length) return null;
  const ranked = [...s.trends].sort(byRelevance);
  const themes = s.themes.filter((t) => t.active);
  const trend = ranked.length ? ranked[s.runs % Math.min(3, ranked.length)] : null;
  const theme = themes.length ? themes[s.runs % themes.length] : null;
  s.runs += 1;
  const { recs } = makePosts(s, { platforms, theme, trend, brief: '', tone: '', source: 'autopilot', publish: !cfg.require_approval });
  cfg.last_run_at = iso(now);
  s.nextAutoAt = now + cfg.interval_min * MIN;
  const topic = trend ? clip(trend.title, 48) : (theme?.name ?? 'your brand');
  note(s, 'autopilot', `Autopilot ${cfg.require_approval ? 'drafted' : 'published'} ${recs.length} ${recs.length === 1 ? 'post' : 'posts'} about “${topic}”${cfg.require_approval ? ', waiting for your approval' : ''}`, { at: now });
  return { ran_at: cfg.last_run_at, trend_id: trend?.id ?? null, theme_id: theme?.id ?? null, posts: recs.map((r) => r.post) };
}

// ---- call plumbing --------------------------------------------------------------------------------------

const FAST: Range = [80, 260];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Simulated latency, then the work; the result is deep-copied so the UI may mutate it freely. */
async function call<T>(work: () => T, ms: Range = FAST): Promise<T> {
  await new Promise<void>((done) => setTimeout(done, ms[0] + Math.random() * (ms[1] - ms[0])));
  return clone(work());
}

function auth(): State {
  if (!state || getToken() !== state.token) throw raiseUnauthorized();
  return state;
}

const authed = <T>(work: (s: State) => T, ms?: Range): Promise<T> => call(() => work(auth()), ms);
/** Authed call that first lets the simulated audience catch up (dashboard, posts, activity, ...). */
const live = <T>(work: (s: State) => T, ms?: Range): Promise<T> =>
  authed((s) => {
    tick(s);
    return work(s);
  }, ms);

const findPost = (s: State, id: string): PostRec => s.posts.find((r) => r.post.id === id) ?? notFound('post');
const findTheme = (s: State, id: string): Theme => s.themes.find((t) => t.id === id) ?? notFound('theme');
const findTrend = (s: State, id: string): Trend => s.trends.find((t) => t.id === id) ?? notFound('trend');
const int = (v: number | undefined, d: number, lo: number, hi: number): number =>
  v === undefined || !Number.isFinite(v) ? d : clamp(Math.floor(v), lo, hi);

// ---- the API ----------------------------------------------------------------------------------------------

export const mockApi: PulseApi = {
  health: () => call(() => ({ ok: true, app: APP_NAME, version: 'mock' })),

  createWorkspace: (body) =>
    call(() => {
      const s = seed(body?.brand_name);
      state = s;
      return { ...s.ws, token: s.token };
    }),
  getWorkspace: () => authed((s) => s.ws),
  patchWorkspace: (b) =>
    authed((s) => {
      const next = { ...s.ws }; // validate while merging, swap in only if everything was fine
      for (const key of ['name', 'brand_name', 'brand_voice', 'audience', 'offer', 'product_url'] as const) {
        const val = b[key];
        if (typeof val !== 'string') continue;
        if ((key === 'name' || key === 'brand_name') && !val.trim()) unprocessable(`${key}: String should have at least 1 character`);
        next[key] = val;
      }
      return (s.ws = next);
    }),

  listConnections: () => live((s) => s.conns),
  connect: (platform, b) =>
    authed((s) => {
      const p = platformOf(platform);
      const handle = (b?.handle ?? '').trim();
      if (!handle || handle.length > 60) unprocessable('handle: String should have between 1 and 60 characters');
      const c = conn(s, p);
      Object.assign(c, {
        handle, status: 'connected', mode: 'sandbox', connected_at: iso(Date.now()),
        followers: c.followers > 0 ? c.followers : 800 + Math.floor(s.rng() * 3200),
      });
      if (c.real_data) Object.assign(c, { profile_url: profileUrl(p, handle), last_harvested_at: iso(Date.now()) });
      note(s, 'connection', `Connected ${LABEL[p]} (${handle})`, { platform: p });
      return c;
    }),
  disconnect: (platform) =>
    authed((s) => {
      const p = platformOf(platform);
      const c = conn(s, p);
      if (c.status === 'connected') note(s, 'connection', `Disconnected ${LABEL[p]} (${c.handle})`, { platform: p });
      c.status = 'disconnected';
      return c;
    }),

  getDashboard: (q) =>
    live((s) => {
      const days = q?.days ?? 30;
      if (!Number.isInteger(days) || days < 1 || days > HISTORY_DAYS) unprocessable(`days: Input should be between 1 and ${HISTORY_DAYS}`);
      return dashboard(s, days, q?.platform ? platformOf(q.platform) : null);
    }),
  getActivity: (limit = 30) => live((s) => s.activity.slice(0, int(limit, 30, 1, 200))),
  getInsights: (q) =>
    live((s) => {
      const days = q?.days ?? 30;
      if (!Number.isInteger(days) || days < 1 || days > 365) unprocessable('days: Input should be between 1 and 365');
      return insights(s, days);
    }),

  listPosts: (q) =>
    live((s) => {
      const status = q?.status ?? null;
      if (status && !['draft', 'scheduled', 'published', 'failed'].includes(status)) unprocessable('status: Input should be draft, scheduled, published or failed');
      const platform = q?.platform ? platformOf(q.platform) : null;
      const when = (p: Post): string => p.published_at ?? p.scheduled_at ?? p.created_at;
      return s.posts
        .map((r) => r.post)
        .filter((p) => (!status || p.status === status) && (!platform || p.platform === platform))
        .sort((a, b) => (status === 'scheduled' ? (when(a) < when(b) ? -1 : 1) : when(a) < when(b) ? 1 : -1))
        .slice(0, int(q?.limit, 200, 1, 500));
    }),
  createPost: (b) =>
    authed((s) => {
      const platform = platformOf(b.platform);
      const status = b.status ?? 'draft';
      if (status !== 'draft' && status !== 'scheduled') unprocessable('status: Input should be "draft" or "scheduled"');
      const content = checkContent(b.content);
      const scheduled_at = status === 'scheduled' ? schedule(b.scheduled_at) : null;
      const rec = addPost(s, {
        platform, content, hashtags: cleanTags(b.hashtags ?? []), media_prompt: b.media_prompt ?? '',
        theme_id: b.theme_id ?? null, trend_id: b.trend_id ?? null, status, source: 'manual', scheduled_at,
      });
      if (scheduled_at) note(s, 'scheduled', `Scheduled for ${LABEL[platform]}: ${snippet(rec.post)}`, { platform, post: rec.post.id });
      return rec.post;
    }),
  patchPost: (id, b) =>
    authed((s) => {
      const r = findPost(s, id);
      const p = r.post;
      if (p.status !== 'draft' && p.status !== 'scheduled') throw new ApiError(409, 'Only draft or scheduled posts can be edited');
      // Validate everything first so a bad field never leaves a half-applied edit.
      const content = b.content != null ? checkContent(b.content) : p.content;
      const status = b.status ?? (b.scheduled_at ? 'scheduled' : p.status);
      if (status !== 'draft' && status !== 'scheduled') unprocessable('status: Input should be "draft" or "scheduled"');
      const scheduled_at = status === 'scheduled' ? schedule(b.scheduled_at ?? p.scheduled_at) : null;
      Object.assign(p, { content, status, scheduled_at });
      if (b.hashtags != null) p.hashtags = cleanTags(b.hashtags);
      if (b.media_prompt != null) p.media_prompt = b.media_prompt;
      return p;
    }),
  deletePost: (id) =>
    authed((s) => {
      s.posts.splice(s.posts.indexOf(findPost(s, id)), 1);
      return { ok: true as const };
    }),
  publishPost: (id) =>
    authed((s) => {
      const r = findPost(s, id);
      if (r.post.status !== 'published') goLive(s, r, Date.now());
      return r.post;
    }),
  convertLink: (code) =>
    call(() => {
      const r = state?.posts.find((x) => x.post.link_code === code);
      if (!state || !r) notFound('link');
      realEvent(state, r, 'conversion');
      return { ok: true as const };
    }),

  listThemes: () => authed((s) => s.themes),
  createTheme: (b) =>
    authed((s) => {
      const name = (b.name ?? '').trim();
      if (!name || name.length > 60) unprocessable('name: String should have between 1 and 60 characters');
      const theme: Theme = {
        id: rid(s.rng), name, description: b.description ?? '', color: b.color || '#7c5cff', active: true,
        created_at: iso(Date.now()),
      };
      s.themes.push(theme);
      return theme;
    }),
  patchTheme: (id, b) =>
    authed((s) => {
      const t = findTheme(s, id);
      const name = b.name != null ? b.name.trim() : t.name;
      if (!name || name.length > 60) unprocessable('name: String should have between 1 and 60 characters');
      Object.assign(t, {
        name, description: b.description ?? t.description, color: b.color || t.color, active: b.active ?? t.active,
      });
      return t;
    }),
  deleteTheme: (id) =>
    authed((s) => {
      s.themes.splice(s.themes.indexOf(findTheme(s, id)), 1);
      return { ok: true as const };
    }),

  generate: (b) =>
    authed(
      (s) => {
        const platforms = platformList(b.platforms);
        if (!platforms.length) unprocessable('platforms: List should have at least 1 item');
        const brief = (b.brief ?? '').trim();
        if (brief.length > 1000) unprocessable('brief: String should have at most 1000 characters');
        const theme = b.theme_id ? findTheme(s, b.theme_id) : null;
        const trend = b.trend_id ? findTrend(s, b.trend_id) : null;
        const aiUsed = aiAvailable && s.aiUsed < AI_LIMIT && s.aiSpent < AI_CAP_USD;
        const { batch, recs } = makePosts(s, { platforms, theme, trend, brief, tone: (b.tone ?? '').trim(), source: 'ai', publish: false });
        s.aiUsed = Math.min(AI_LIMIT, s.aiUsed + 1);
        if (aiUsed) s.aiSpent = Math.round((s.aiSpent + 0.02 + s.rng() * 0.02) * 10000) / 10000;
        const what = `${recs.length} ${recs.length === 1 ? 'post' : 'posts'}`;
        note(s, 'generated', `${aiUsed ? 'Claude' : APP_NAME} drafted ${what}${theme ? ` for “${theme.name}”` : ''}${trend ? ` on “${clip(trend.title, 40)}”` : ''}`, {
          platform: platforms.length === 1 ? platforms[0] : null,
        });
        return { batch_id: batch, ai_used: aiUsed, posts: recs.map((r) => r.post) };
      },
      [900, 1800],
    ),
  getAiUsage: () =>
    authed((s) => ({
      workspace_used: s.aiUsed, workspace_limit: AI_LIMIT, global_spent_usd: s.aiSpent, global_cap_usd: AI_CAP_USD,
      ai_available: aiAvailable && s.aiSpent < AI_CAP_USD,
    })),

  getAutopilot: () => live((s) => s.autopilot),
  putAutopilot: (b) =>
    authed((s) => {
      const cur = s.autopilot;
      const interval = b.interval_min ?? cur.interval_min;
      if (!Number.isInteger(interval) || interval < 1 || interval > 1440) unprocessable('interval_min: Input should be between 1 and 1440');
      const platforms = platformList(b.platforms ?? cur.platforms);
      const enabled = b.enabled === true;
      const now = Date.now();
      s.autopilot = { enabled, interval_min: interval, platforms, require_approval: b.require_approval ?? cur.require_approval, last_run_at: cur.last_run_at };
      // Demo-friendly: the first automatic run lands ~20 s after switching on.
      if (!enabled) s.nextAutoAt = null;
      else if (!cur.enabled) s.nextAutoAt = now + 20_000;
      else s.nextAutoAt = Math.min(s.nextAutoAt ?? Infinity, now + interval * MIN);
      if (enabled !== cur.enabled) note(s, 'autopilot', enabled ? `Autopilot switched on (every ${interval} min)` : 'Autopilot switched off', { at: now });
      return s.autopilot;
    }),
  runAutopilot: () =>
    authed(
      (s) => autopilotCycle(s, Date.now()) ?? unprocessable('Connect at least one platform first'),
      [800, 1500],
    ),

  listTrends: (q) =>
    authed((s) => {
      if (q?.refresh) {
        const now = Date.now();
        for (const t of s.trends) {
          t.fetched_at = iso(now);
          t.score = round2(clamp(t.score + (s.rng() - 0.5) * 0.1, 0.02, 0.99));
          t.relevance = round2(clamp(t.relevance + (s.rng() - 0.5) * 0.06, 0.02, 0.99));
        }
      }
      return [...s.trends].sort(byRelevance).slice(0, int(q?.limit, 20, 1, 100));
    }),
};

/** Simulate a real person tapping a tracked link (`/r/<code>`), optionally converting on the landing page. */
export function mockClickLink(code: string, convert = false): void {
  const r = state?.posts.find((x) => x.post.link_code === code);
  if (!state || !r) return;
  realEvent(state, r, 'click');
  if (convert) realEvent(state, r, 'conversion');
}

/** Pretend the server has (or lacks) an Anthropic key: only flips the honest `ai_used` / `ai_available` flags. */
export function mockSetAiAvailable(on: boolean): void {
  aiAvailable = on;
}
