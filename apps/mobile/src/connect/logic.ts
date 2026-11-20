/**
 * Pure helpers for connecting an account by screenshot or typed numbers (docs/REAL.md): where to take each screenshot,
 * the editable numbers form, number parsing and building the `POST /api/metrics/ingest` body. No React, no network.
 */
import { ApiError } from '@/src/http';
import { fmtInt, parseTs, timeAgo } from '@/src/format';
import { platformMeta } from '@/src/theme';
import type {
  Connection,
  IngestAccount,
  IngestPost,
  IngestRequest,
  Platform,
  ScreenshotPost,
  ScreenshotRead,
} from '@/src/types';

// ---- where to take the screenshot -----------------------------------------------------------------

/** The help line on each platform card (docs/REAL.md, "App"). Shown as "Screenshot: <line>." */
export const PLATFORM_HELP: Record<Platform, string> = {
  instagram: 'your profile (followers), or Professional dashboard > Insights (accounts reached, last 30 days)',
  linkedin: 'linkedin.com/dashboard (post impressions, followers, profile viewers)',
  tiktok: 'your profile (followers, likes), or Creator tools > Analytics',
  x: 'your profile (followers), or Analytics',
  reddit: 'your profile (karma, followers)',
  facebook: 'your Page, or Professional dashboard',
};

/** Where the handle goes in the form's placeholder. */
export const HANDLE_PLACEHOLDER: Record<Platform, string> = {
  instagram: 'yourname',
  linkedin: 'your-name',
  tiktok: 'yourname',
  x: 'yourname',
  reddit: 'u/yourname',
  facebook: 'Your Page name',
};

// ---- the numbers form -------------------------------------------------------------------------------

export type PeriodDays = 7 | 30 | 90;
export const PERIODS: readonly PeriodDays[] = [7, 30, 90];
export const DEFAULT_PERIOD: PeriodDays = 30;

/** Everything is text while the person edits; `checkForm` turns it into numbers. */
export interface NumbersForm {
  handle: string;
  followers: string;
  views: string;
  engagements: string;
  profileViews: string;
  /** The window views, engagements and profile views cover. */
  period: PeriodDays;
}

export type FormField = 'handle' | 'followers' | 'views' | 'engagements' | 'profileViews';

export const MAX_HANDLE = 100;
/** Same ceiling as the API's `Count`. */
export const MAX_COUNT = 10 ** 12;

export const emptyForm = (): NumbersForm => ({
  handle: '',
  followers: '',
  views: '',
  engagements: '',
  profileViews: '',
  period: DEFAULT_PERIOD,
});

export const isConnected = (conn: Connection | null | undefined): conn is Connection => conn?.status === 'connected';

/** "Update" on a connected account starts from what is saved (handle, followers). */
export function formFromConnection(conn: Connection | null | undefined): NumbersForm {
  const form = emptyForm();
  if (!isConnected(conn)) return form;
  return { ...form, handle: conn.handle, followers: conn.followers > 0 ? String(conn.followers) : '' };
}

/** The closest window we know (7, 30 or 90 days); the default when the image showed none. */
export function nearestPeriod(days: number | null | undefined): PeriodDays {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return DEFAULT_PERIOD;
  return PERIODS.reduce((best, p) => (Math.abs(p - days) < Math.abs(best - days) ? p : best), DEFAULT_PERIOD);
}

const text = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n)) : '');

/** Prefill the editable form with what Claude read (blank where the image did not show a number). */
export function formFromRead(read: ScreenshotRead): NumbersForm {
  return {
    handle: (read.handle ?? '').trim(),
    followers: text(read.followers),
    views: text(read.views),
    engagements: text(read.engagements),
    profileViews: text(read.profile_views),
    period: nearestPeriod(read.period_days),
  };
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/**
 * "" -> null (left blank), "1,234" -> 1234, "1.2K" -> 1200, "3.4m" -> 3400000. Anything else, including a decimal without
 * k/m/b, is 'invalid'.
 */
export function parseCount(raw: string): number | null | 'invalid' {
  const t = raw.trim().toLowerCase().replace(/[\s,_']/g, '');
  if (!t) return null;
  const m = /^(?:(\d+)|(\d+(?:\.\d+)?)([kmb]))$/.exec(t);
  if (!m) return 'invalid';
  const n = m[1] !== undefined ? Number(m[1]) : Math.round(Number(m[2]) * SUFFIX[m[3]]);
  return Number.isFinite(n) && n >= 0 && n <= MAX_COUNT ? n : 'invalid';
}

/** Trim, drop spaces inside and the leading `@`, cap at the API's 100 characters. */
export const cleanHandle = (raw: string): string => raw.trim().replace(/\s+/g, '').replace(/^@+/, '').slice(0, MAX_HANDLE);

export type FormErrors = Partial<Record<FormField | 'form', string>>;
export type FormCheck = { ok: true; request: IngestRequest } | { ok: false; errors: FormErrors };

const NUMBER_FIELDS: readonly { field: Exclude<FormField, 'handle'>; key: keyof IngestAccount; label: string }[] = [
  { field: 'followers', key: 'followers', label: 'Followers' },
  { field: 'views', key: 'views', label: 'Views' },
  { field: 'engagements', key: 'engagements', label: 'Engagements' },
  { field: 'profileViews', key: 'profile_views', label: 'Profile views' },
];

/**
 * Validate the form and build the ingest body. `source` is "screenshot" for numbers Claude read and the person checked,
 * "manual" for typed ones. A window (`period_days`) is only sent when a windowed number (views, engagements, profile
 * views) is present: followers are a total, not a window.
 */
export function checkForm(
  platform: Platform,
  form: NumbersForm,
  source: 'screenshot' | 'manual',
  posts: IngestPost[] = [],
): FormCheck {
  const errors: FormErrors = {};
  const account: IngestAccount = {};
  let given = 0;
  let windowed = false;
  for (const { field, key, label } of NUMBER_FIELDS) {
    const v = parseCount(form[field]);
    if (v === 'invalid') errors[field] = `${label}: use a whole number, like 1234 or 1.2k.`;
    else if (v !== null) {
      account[key] = v;
      given += 1;
      if (field !== 'followers') windowed = true;
    }
  }
  const handle = cleanHandle(form.handle);
  if (form.handle.replace(/\s+/g, '').replace(/^@+/, '').length > MAX_HANDLE) {
    errors.handle = `Handles are ${MAX_HANDLE} characters or fewer.`;
  }
  if (Object.keys(errors).length === 0 && given === 0) errors.form = 'Add at least one number. Followers is a good start.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    request: {
      platform,
      source,
      ...(handle ? { handle } : {}),
      ...(windowed ? { period_days: form.period } : {}),
      account,
      posts,
    },
  };
}

// ---- posts Claude read -----------------------------------------------------------------------------------

/** Likes + comments + shares of the ones that are shown; null when none of them is. */
export function engagementsOf(p: ScreenshotPost): number | null {
  const parts = [p.likes, p.comments, p.shares].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** The API takes at most this many posts from one screenshot read. */
export const MAX_READ_POSTS = 20;

const count = (n: number): number => Math.min(MAX_COUNT, Math.max(0, Math.round(n)));

/**
 * `views` and `engagements` are required on an ingest post. Send 0 for a missing one only when the other is known, else
 * skip the post (docs/REAL.md). A post with no text is skipped too: it could not be matched on the next screenshot.
 */
export function postsToIngest(posts: readonly ScreenshotPost[] | null | undefined): IngestPost[] {
  const out: IngestPost[] = [];
  for (const p of posts ?? []) {
    const content = (p.content ?? '').trim();
    const eng = engagementsOf(p);
    const views = typeof p.views === 'number' && Number.isFinite(p.views) ? p.views : null;
    if (!content || (views === null && eng === null)) continue;
    out.push({
      content,
      posted_at: p.posted_at ?? null,
      views: count(views ?? 0),
      engagements: count(eng ?? 0),
    });
    if (out.length >= MAX_READ_POSTS) break;
  }
  return out;
}

// ---- messages --------------------------------------------------------------------------------------------

/** A warning when the image looks like another platform than the card it was uploaded on; null otherwise. */
export function platformMismatch(read: ScreenshotRead): string | null {
  const seen = read.detected_platform;
  if (!seen || seen === read.platform) return null;
  return `This looks like a ${platformMeta[seen].label} screenshot, not ${platformMeta[read.platform].label}. Check the numbers, or upload it on the ${platformMeta[seen].label} card.`;
}

/** "Read by Claude" confidence as a short caution, or null when it is high. */
export function confidenceNote(read: ScreenshotRead): string | null {
  if (read.confidence === 'low') return 'Claude was not sure about this screenshot. Check every number.';
  if (read.confidence === 'medium') return 'Claude was fairly sure. Check the numbers.';
  return null;
}

/** What to tell the person when reading a screenshot failed (503 is the server's "try again" text). */
export function readFailure(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 413) return 'That image is too large. Crop the screenshot and try again.';
    if (e.status === 415) return "That image type isn't supported. Use a PNG, JPEG or WebP screenshot.";
    if (e.status === 0) return `${e.message} Try again when you're back online.`;
    return e.message;
  }
  return "Couldn't read the screenshot right now. Try again in a moment.";
}

/** What to tell the person when saving failed. */
export function saveFailure(e: unknown): string {
  return e instanceof ApiError ? e.message : "Couldn't save the numbers. Try again.";
}

/** "Instagram" -> "Saved Instagram: 46 followers, 1,234 views." (what was saved, in the person's words). */
export function savedSummary(platform: Platform, request: IngestRequest): string {
  const a = request.account ?? {};
  const bits: string[] = [];
  if (a.followers != null) bits.push(`${fmtInt(a.followers)} ${a.followers === 1 ? 'follower' : 'followers'}`);
  if (a.views != null) bits.push(`${fmtInt(a.views)} views`);
  if (a.engagements != null) bits.push(`${fmtInt(a.engagements)} engagements`);
  if (a.profile_views != null) bits.push(`${fmtInt(a.profile_views)} profile views`);
  const n = request.posts?.length ?? 0;
  if (n > 0) bits.push(`${n} ${n === 1 ? 'post' : 'posts'}`);
  return `Saved ${platformMeta[platform].label}${bits.length ? `: ${bits.join(', ')}` : ''}.`;
}

// ---- "Updated <relative time>" --------------------------------------------------------------------------

const millis = (iso: string | null | undefined): number => {
  if (!iso) return NaN;
  return parseTs(iso).getTime();
};

/** The newest valid timestamp of the candidates, or null. */
export function latestIso(...candidates: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const c of candidates) {
    const ms = millis(c);
    if (!Number.isNaN(ms) && ms > bestMs) {
      best = c ?? null;
      bestMs = ms;
    }
  }
  return best;
}

/** "Updated 3h ago". A time in the future (a phone clock behind the server) reads "just now". */
export function updatedLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
  const ms = millis(iso);
  if (Number.isNaN(ms) || !iso) return null;
  return `Updated ${ms > now ? 'just now' : timeAgo(iso, now)}`;
}

/** Followers as "1.2k followers" style text lives in `format.fmtCompact`; this is the plural-aware wrapper. */
export const followersLabel = (n: number, fmt: (n: number) => string): string => `${fmt(n)} ${n === 1 ? 'follower' : 'followers'}`;
