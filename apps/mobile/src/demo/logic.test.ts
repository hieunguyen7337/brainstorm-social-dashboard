/** Unit tests for src/demo/logic.ts: `npx jest --ci src/demo`. No network, no real account. */
import {
  checklist,
  demoEmail,
  demoHandle,
  demoMetricsToast,
  demoPostedAllToast,
  demoPostedToast,
  demoPostLabel,
  demoPostNote,
  demoRefreshLabel,
  demoSlug,
  demoSuccessNote,
  initialState,
  reduce,
  STEPS,
  type DemoEvent,
  type DemoState,
} from './logic';
import type { DemoSignInResult } from '../types';

// jest provides these at run time; declared here so `tsc --noEmit` needs no @types/jest.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => any;

const RESULT: DemoSignInResult = {
  platform: 'instagram',
  connection: {
    platform: 'instagram', handle: '@brewandbloom', status: 'connected', mode: 'sandbox', followers: 9712,
    connected_at: '2026-11-21T00:00:00+00:00',
  },
  followers: 9712, views: 84_300, engagements: 6100, period_days: 30, posts_added: 3, fresh: true,
  captured_at: '2026-11-21T00:00:00+00:00',
};

const run = (events: DemoEvent[], from: DemoState = initialState): DemoState => events.reduce(reduce, from);
const tick = (attempt: number): DemoEvent => ({ type: 'TICK', attempt });
const answer = (attempt: number): DemoEvent => ({ type: 'RESULT', attempt, result: RESULT });

describe('demo handle and email', () => {
  it('spells handles like the server', () => {
    expect(demoHandle('instagram', 'Brew & Bloom')).toBe('@brewandbloom');
    expect(demoHandle('linkedin', 'Brew & Bloom')).toBe('company/brewandbloom');
    expect(demoHandle('reddit', 'Brew & Bloom')).toBe('u/brewandbloom');
    expect(demoHandle('x', 'Acme Co!')).toBe('@acmeco');
    expect(demoHandle('tiktok', 'Acme Co!')).toBe('@acmeco');
  });

  it('falls back like the server for an empty or symbol-only brand, and clips at 24', () => {
    expect(demoSlug('')).toBe('brand');
    expect(demoSlug(null)).toBe('brand');
    expect(demoSlug('!!!')).toBe('brand');
    expect(demoSlug('A'.repeat(40))).toBe('a'.repeat(24));
  });

  it('uses a reserved example domain for the prefilled email', () => {
    expect(demoEmail('Brew & Bloom')).toBe('demo@brewandbloom.example.com');
  });
});

describe('the sign-in stages', () => {
  it('starts at the sign-in page and moves to reading on Sign in', () => {
    expect(initialState.stage).toBe('signin');
    const s = run([{ type: 'SIGN_IN' }]);
    expect(s).toEqual({ stage: 'reading', attempt: 1, ticks: 0, result: null, error: null });
  });

  it('is done only when all lines are ticked AND the server answered, in either order', () => {
    const ticksFirst = run([{ type: 'SIGN_IN' }, tick(1), tick(1), tick(1)]);
    expect(ticksFirst.stage).toBe('reading');
    expect(run([answer(1)], ticksFirst).stage).toBe('done');

    const answerFirst = run([{ type: 'SIGN_IN' }, answer(1), tick(1), tick(1)]);
    expect(answerFirst.stage).toBe('reading');
    expect(run([tick(1)], answerFirst).stage).toBe('done');
  });

  it('never counts more than STEPS ticks', () => {
    const s = run([{ type: 'SIGN_IN' }, tick(1), tick(1), tick(1), tick(1), tick(1)]);
    expect(s.ticks).toBe(STEPS);
  });

  it('ignores Sign in, ticks and answers outside the stage they belong to', () => {
    expect(run([tick(0), answer(0)])).toEqual(initialState);
    const done = run([{ type: 'SIGN_IN' }, tick(1), tick(1), tick(1), answer(1)]);
    expect(run([{ type: 'SIGN_IN' }, tick(1), { type: 'RETRY' }], done)).toEqual(done);
  });

  it('fails into an error and retries from the sign-in page', () => {
    const failed = run([{ type: 'SIGN_IN' }, tick(1), { type: 'FAIL', attempt: 1, message: 'offline' }]);
    expect(failed.stage).toBe('error');
    expect(failed.error).toBe('offline');
    const again = run([{ type: 'RETRY' }], failed);
    expect(again).toEqual({ stage: 'signin', attempt: 1, ticks: 0, result: null, error: null });
    expect(run([{ type: 'SIGN_IN' }], again).attempt).toBe(2);
  });

  it('ignores a late answer, tick or failure from an older attempt', () => {
    const second = run([
      { type: 'SIGN_IN' },
      { type: 'FAIL', attempt: 1, message: 'offline' },
      { type: 'RETRY' },
      { type: 'SIGN_IN' },
    ]);
    expect(second.attempt).toBe(2);
    const afterStale = run([answer(1), tick(1), tick(1), tick(1), { type: 'FAIL', attempt: 1, message: 'old' }], second);
    expect(afterStale).toEqual(second);
  });

  it('keeps the failure when a stale answer arrives after it', () => {
    const failed = run([{ type: 'SIGN_IN' }, { type: 'FAIL', attempt: 1, message: 'offline' }]);
    expect(run([answer(1)], failed)).toEqual(failed);
  });
});

describe('the "Reading your numbers" checklist', () => {
  const lines = (s: DemoState) => checklist(s).map((l) => [l.key, l.status, l.value]);

  it('is all pending before and after an error', () => {
    expect(lines(initialState).map((l) => l[1])).toEqual(['pending', 'pending', 'pending']);
    const failed = run([{ type: 'SIGN_IN' }, { type: 'FAIL', attempt: 1, message: 'x' }]);
    expect(lines(failed).map((l) => l[1])).toEqual(['pending', 'pending', 'pending']);
  });

  it('shows the first line active while reading, then ticks the rest in order', () => {
    const start = run([{ type: 'SIGN_IN' }]);
    expect(lines(start).map((l) => l[1])).toEqual(['active', 'pending', 'pending']);
    // ticks without an answer: nothing is finished yet, the first line keeps spinning
    const waiting = run([tick(1), tick(1)], start);
    expect(lines(waiting).map((l) => l[1])).toEqual(['active', 'pending', 'pending']);
    // the answer arrives: the two ticked lines are done, the third is active
    const answered = run([answer(1)], waiting);
    expect(lines(answered)).toEqual([
      ['followers', 'done', '9.7k'],
      ['views', 'done', '84k'],
      ['engagements', 'active', null],
    ]);
  });

  it('is all done, with values, when the stage is done', () => {
    const done = run([{ type: 'SIGN_IN' }, tick(1), tick(1), tick(1), answer(1)]);
    expect(done.stage).toBe('done');
    expect(lines(done)).toEqual([
      ['followers', 'done', '9.7k'],
      ['views', 'done', '84k'],
      ['engagements', 'done', '6.1k'],
    ]);
  });
});

describe('the success note', () => {
  it('names the platform and the numbers and says they are synthetic', () => {
    const note = demoSuccessNote('instagram', RESULT);
    expect(note).toContain('Instagram');
    expect(note).toContain('9.7k followers');
    expect(note).toContain('84k views in the last 30 days');
    expect(note).toContain('synthetic');
  });
});

describe('posting and metrics back', () => {
  it('labels the demo post button and the refresh button', () => {
    expect(demoPostLabel('linkedin')).toBe('Post on LinkedIn (demo)');
    expect(demoPostLabel('instagram')).toBe('Post on Instagram (demo)');
    expect(demoRefreshLabel()).toBe('Refresh metrics (demo)');
  });

  it('says nothing is sent and the metrics are simulated', () => {
    expect(demoPostNote('instagram', false)).toContain('nothing is sent to Instagram');
    expect(demoPostNote('instagram', false)).toContain('simulated');
    expect(demoPostNote('instagram', true)).toContain('synthetic');
  });

  it('toasts the first read that came back with the post', () => {
    const toast = demoPostedToast('LinkedIn', { views: 272, engagements: 1 });
    expect(toast).toBe('Posted to LinkedIn (demo). First read: 272 views, 1 engagement. Synthetic.');
    expect(demoPostedToast('Instagram', { views: 12_400, engagements: 880 })).toContain('12k views, 880 engagements');
  });

  it('toasts a bulk post', () => {
    expect(demoPostedAllToast(2)).toBe('Posted 2 posts (demo). First metrics are in, all synthetic.');
    expect(demoPostedAllToast(1)).toContain('1 post (demo)');
    expect(demoPostedAllToast(3, true)).toContain('all 3 posts');
  });

  it('toasts what a refresh read back', () => {
    const read = { views_gained: 410, engagements_gained: 1, advanced_minutes: 5 };
    expect(demoMetricsToast('LinkedIn', read)).toBe(
      'Read back from LinkedIn (demo): +410 views, +1 engagement after 5 simulated min.',
    );
    expect(demoMetricsToast('LinkedIn', { ...read, advanced_minutes: 0 })).not.toContain('simulated min');
  });
});
