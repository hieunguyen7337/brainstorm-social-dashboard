/** Unit tests for the numbers form in connect/logic.ts, the engagement split part: `npx jest --ci src/connect`. */
import { checkForm, emptyForm, engagementsTotal, formFromRead, savedSummary, type NumbersForm } from './logic';
import type { IngestRequest, ScreenshotRead } from '@/src/types';

// logic.ts only needs ApiError from the HTTP module, which itself pulls in react-native (not loadable under node).
jest.mock('@/src/http', () => ({ ApiError: class ApiError extends Error {} }));

const form = (patch: Partial<NumbersForm>): NumbersForm => ({ ...emptyForm(), ...patch });

function request(f: NumbersForm): IngestRequest {
  const out = checkForm('instagram', f, 'manual');
  if (!out.ok) throw new Error(JSON.stringify(out.errors));
  return out.request;
}

describe('the numbers form and the engagement split', () => {
  it('starts empty', () => {
    const f = emptyForm();
    expect([f.likes, f.comments, f.shares]).toEqual(['', '', '']);
  });

  it('sends likes, comments and shares as numbers, with the window', () => {
    const r = request(form({ likes: '1,200', comments: '88', shares: '1.2k', period: 7 }));
    expect(r.account).toEqual({ likes: 1200, comments: 88, shares: 1200 });
    expect(r.period_days).toBe(7);
  });

  it('the three alone are enough to save, and a part left blank is left out (never 0)', () => {
    const r = request(form({ likes: '40' }));
    expect(r.account).toEqual({ likes: 40 });
    expect(r.account).not.toHaveProperty('comments');
  });

  it('keeps a typed 0', () => {
    expect(request(form({ likes: '10', comments: '0' })).account).toEqual({ likes: 10, comments: 0 });
  });

  it('refuses a split number that is not a whole number', () => {
    const out = checkForm('instagram', form({ likes: '12.5', comments: 'abc' }), 'manual');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.likes).toBe('Likes: use a whole number, like 1234 or 1.2k.');
      expect(out.errors.comments).toBe('Comments: use a whole number, like 1234 or 1.2k.');
    }
  });

  it('prefills from what Claude read, blank where it was not shown', () => {
    const read = {
      platform: 'instagram',
      detected_platform: 'instagram',
      handle: 'acme',
      followers: null,
      following: null,
      posts_count: null,
      views: 900,
      engagements: null,
      likes: 300,
      comments: null,
      shares: 4,
      profile_views: null,
      period_days: 30,
      posts: [],
      confidence: 'high',
      notes: null,
      ai_used: true,
    } as ScreenshotRead;
    const f = formFromRead(read);
    expect([f.engagements, f.likes, f.comments, f.shares]).toEqual(['', '300', '', '4']);
  });

  it('prefills blank from an older server that does not send the split', () => {
    const old = { platform: 'x', detected_platform: null, handle: null, followers: 3, posts: [], ai_used: true } as unknown as ScreenshotRead;
    const f = formFromRead(old);
    expect([f.likes, f.comments, f.shares]).toEqual(['', '', '']);
  });
});

describe('engagementsTotal', () => {
  it('is the typed total when there is no split', () => {
    expect(engagementsTotal({ engagements: 56 })).toBe(56);
    expect(engagementsTotal({})).toBeNull();
  });

  it('is the sum of the parts when no total was given', () => {
    expect(engagementsTotal({ likes: 120, comments: 14, shares: 6 })).toBe(140);
    expect(engagementsTotal({ likes: 120 })).toBe(120);
  });

  it('never falls below the parts, and keeps a larger total (saves)', () => {
    expect(engagementsTotal({ engagements: 100, likes: 120, comments: 14, shares: 6 })).toBe(140);
    expect(engagementsTotal({ engagements: 200, likes: 120, comments: 14, shares: 6 })).toBe(200);
  });
});

describe('savedSummary', () => {
  it('says what was saved, with the split when there is one', () => {
    const r = request(form({ followers: '46', likes: '120', comments: '14', shares: '6' }));
    expect(savedSummary('instagram', r)).toBe('Saved Instagram: 46 followers, 140 engagements (120 likes, 14 comments, 6 shares).');
  });

  it('is unchanged for a plain total', () => {
    const r = request(form({ views: '1234', engagements: '56' }));
    expect(savedSummary('instagram', r)).toBe('Saved Instagram: 1,234 views, 56 engagements.');
  });
});
