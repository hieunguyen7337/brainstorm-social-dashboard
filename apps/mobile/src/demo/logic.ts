/**
 * Pure logic of the demo sign-in (docs/REAL.md, "Demo workspaces"): the demo account's handle and email, the stage machine
 * behind the sign-in sheet, the "Reading your numbers" checklist and the success note. No React, no network: the sheet
 * (`DemoSignInSheet.tsx`) drives it, `src/demo/logic.test.ts` tests it.
 */
import { fmtCompact } from '../format';
import { platformMeta } from '../theme';
import type { DemoMetricsRead, DemoSignInResult, Platform, Post } from '../types';

/** How long each checklist line takes: three lines, about three seconds, whatever the server's speed. */
export const STEP_MS = 1000;
export const STEPS = 3;

const DEMO_BRAND = 'Brew & Bloom';

/** The handle slug the server uses (`demo.demo_slug`): "Brew & Bloom" -> brewandbloom, otherwise lowercase letters and digits. */
export function demoSlug(brand: string | null | undefined): string {
  const name = (brand ?? '').trim();
  if (name === DEMO_BRAND) return 'brewandbloom';
  const slug = Array.from(name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).slice(0, 24).join('');
  return slug || 'brand';
}

/** The demo account's handle, spelled like the server's (`seed._handle`). Only a preview: the sign-in result carries the real one. */
export function demoHandle(platform: Platform, brand: string | null | undefined): string {
  const slug = demoSlug(brand);
  if (platform === 'linkedin') return `company/${slug}`;
  if (platform === 'reddit') return `u/${slug}`;
  return `@${slug}`;
}

/** The prefilled login on the demo page: a reserved example domain, never a real address. */
export const demoEmail = (brand: string | null | undefined): string => `demo@${demoSlug(brand)}.example.com`;

// ---- the stage machine ------------------------------------------------------------------------------

export type Stage = 'signin' | 'reading' | 'done' | 'error';

export interface DemoState {
  stage: Stage;
  /** Which sign-in attempt this is: events from an older attempt (a late reply, a stale timer) are ignored. */
  attempt: number;
  /** Checklist lines finished so far (0..STEPS). */
  ticks: number;
  result: DemoSignInResult | null;
  error: string | null;
}

export type DemoEvent =
  | { type: 'SIGN_IN' }
  | { type: 'TICK'; attempt: number }
  | { type: 'RESULT'; attempt: number; result: DemoSignInResult }
  | { type: 'FAIL'; attempt: number; message: string }
  | { type: 'RETRY' };

export const initialState: DemoState = { stage: 'signin', attempt: 0, ticks: 0, result: null, error: null };

/** Done needs every line ticked AND the server's answer, in either order. */
function settle(s: DemoState): DemoState {
  return s.stage === 'reading' && s.ticks >= STEPS && s.result ? { ...s, stage: 'done' } : s;
}

export function reduce(s: DemoState, e: DemoEvent): DemoState {
  switch (e.type) {
    case 'SIGN_IN':
      return s.stage === 'signin' ? { stage: 'reading', attempt: s.attempt + 1, ticks: 0, result: null, error: null } : s;
    case 'TICK':
      return s.stage === 'reading' && e.attempt === s.attempt ? settle({ ...s, ticks: Math.min(STEPS, s.ticks + 1) }) : s;
    case 'RESULT':
      return s.stage === 'reading' && e.attempt === s.attempt ? settle({ ...s, result: e.result }) : s;
    case 'FAIL':
      return s.stage === 'reading' && e.attempt === s.attempt ? { ...s, stage: 'error', error: e.message } : s;
    case 'RETRY':
      return s.stage === 'error' ? { ...s, stage: 'signin', ticks: 0, result: null, error: null } : s;
  }
}

// ---- the "Reading your numbers" checklist -----------------------------------------------------------

export type LineStatus = 'pending' | 'active' | 'done';

export interface ChecklistLine {
  key: 'followers' | 'views' | 'engagements';
  label: string;
  status: LineStatus;
  /** Shown once the line is done and the server has answered. */
  value: string | null;
}

const LINES: readonly { key: ChecklistLine['key']; label: string }[] = [
  { key: 'followers', label: 'Followers' },
  { key: 'views', label: 'Views, last 30 days' },
  { key: 'engagements', label: 'Engagement' },
];

export function checklist(s: DemoState): ChecklistLine[] {
  const reading = s.stage === 'reading' || s.stage === 'done';
  const finished = LINES.map((_l, i) => s.stage === 'done' || (reading && s.ticks > i && s.result !== null));
  const firstOpen = finished.indexOf(false);
  return LINES.map((line, i) => {
    const done = finished[i];
    return {
      ...line,
      status: done ? 'done' : s.stage === 'reading' && i === firstOpen ? 'active' : 'pending',
      value: done && s.result ? fmtCompact(s.result[line.key]) : null,
    };
  });
}

/** The note on the platform card after a sign-in: it says the numbers are synthetic. */
export function demoSuccessNote(platform: Platform, r: DemoSignInResult): string {
  return `Signed in to ${platformMeta[platform].label} with the demo account: ${fmtCompact(r.followers)} followers and ${fmtCompact(r.views)} views in the last ${r.period_days} days. Every number here is synthetic.`;
}

// ---- posting and metrics back (the demo pathway after the sign-in) -----------------------------------

const counted = (n: number, one: string, many: string): string => `${fmtCompact(n)} ${n === 1 ? one : many}`;

/** The one button a draft's card gets in a demo workspace instead of the real composers: it posts synthetically. */
export const demoPostLabel = (platform: Platform): string => `Post on ${platformMeta[platform].label} (demo)`;

/** The button a published post's card gets: it reads the post's metrics back again. */
export const demoRefreshLabel = (): string => 'Refresh metrics (demo)';

/** Under that button: nothing real happens, and the numbers are simulated. */
export const demoPostNote = (platform: Platform, published: boolean): string =>
  published
    ? 'Reads the metrics of this post back (synthetic). Each read moves the simulated clock on a few minutes.'
    : `Posts synthetically: nothing is sent to ${platformMeta[platform].label}, and the metrics that come back are simulated.`;

/** Toast after a post went out in a demo workspace; the first synthetic metrics read came back with it. */
export function demoPostedToast(label: string, post: Pick<Post, 'views' | 'engagements'>): string {
  return `Posted to ${label} (demo). First read: ${counted(post.views, 'view', 'views')}, ${counted(post.engagements, 'engagement', 'engagements')}. Synthetic.`;
}

/** Toast after "Publish all" in a demo workspace. */
export function demoPostedAllToast(count: number, every = false): string {
  const what = every && count > 1 ? `all ${count} posts` : `${count} ${count === 1 ? 'post' : 'posts'}`;
  return `Posted ${what} (demo). First metrics are in, all synthetic.`;
}

/** Toast after "Refresh metrics": what the read found. */
export function demoMetricsToast(label: string, read: Pick<DemoMetricsRead, 'views_gained' | 'engagements_gained' | 'advanced_minutes'>): string {
  const when = read.advanced_minutes > 0 ? ` after ${read.advanced_minutes} simulated min` : '';
  return `Read back from ${label} (demo): +${counted(read.views_gained, 'view', 'views')}, +${counted(read.engagements_gained, 'engagement', 'engagements')}${when}.`;
}
