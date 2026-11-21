/**
 * Pure logic of the demo sign-in (docs/REAL.md, "Demo workspaces"): the demo account's handle and email, the stage machine
 * behind the sign-in sheet, the "Reading your numbers" checklist and the success note. No React, no network: the sheet
 * (`DemoSignInSheet.tsx`) drives it, `src/demo/logic.test.ts` tests it.
 */
import { fmtCompact } from '../format';
import { platformMeta } from '../theme';
import type { DemoSignInResult, Platform } from '../types';

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
