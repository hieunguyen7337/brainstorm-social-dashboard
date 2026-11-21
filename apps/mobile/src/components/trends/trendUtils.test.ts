import type { Trend, TrendsStatus, TrendSourceStatus } from '@/src/api';

import {
  buildGroups,
  byRelevance,
  failureSummary,
  feedProblem,
  knownRelevance,
  matchReason,
  matchTermsOf,
  oldestFetchedAt,
  sourceEmptyMessage,
  sourceFailureNote,
} from './trendUtils';

const trend = (over: Partial<Trend> & Pick<Trend, 'id'>): Trend => ({
  source: 'hackernews',
  title: 'A headline',
  url: 'https://news.ycombinator.com/item?id=1',
  score: 0.5,
  relevance: 0.5,
  fetched_at: '2026-11-21T00:00:00Z',
  ...over,
});

const source = (over: Partial<TrendSourceStatus> & Pick<TrendSourceStatus, 'source'>): TrendSourceStatus => ({
  ok: true,
  attempted_at: null,
  fetched_at: null,
  count: 0,
  error: null,
  ...over,
});

const status = (...sources: TrendSourceStatus[]): TrendsStatus => ({
  sources,
  newest_fetched_at: null,
  oldest_fetched_at: null,
});

describe('byRelevance / buildGroups', () => {
  it('sorts by match, then buzz, then title', () => {
    const groups = buildGroups([
      trend({ id: 'a', title: 'Zebra', relevance: 0.4, score: 0.9 }),
      trend({ id: 'b', title: 'Apple', relevance: 0.4, score: 0.2 }),
      trend({ id: 'c', title: 'Mango', relevance: 0.9, score: 0.1 }),
      trend({ id: 'd', title: 'Banana', relevance: 0.4, score: 0.9 }),
    ]);
    expect(groups[0].items.map((t) => t.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('puts trends with no match (null relevance) after every matched trend, ordered by buzz', () => {
    const groups = buildGroups([
      trend({ id: 'nomatch-hot', relevance: null, score: 0.95 }),
      trend({ id: 'match-quiet', relevance: 0.01, score: 0.1 }),
      trend({ id: 'nomatch-quiet', relevance: null, score: 0.2 }),
    ]);
    expect(groups[0].items.map((t) => t.id)).toEqual(['match-quiet', 'nomatch-hot', 'nomatch-quiet']);
  });

  it('orders two null-relevance trends by buzz, then title', () => {
    const a = trend({ id: 'a', title: 'Beta', relevance: null, score: 0.5 });
    const b = trend({ id: 'b', title: 'Alpha', relevance: null, score: 0.5 });
    const c = trend({ id: 'c', title: 'Gamma', relevance: null, score: 0.8 });
    expect([a, b, c].sort(byRelevance).map((t) => t.id)).toEqual(['c', 'b', 'a']);
  });

  it('keeps one group per source in order, drops duplicate ids and ignores unknown sources', () => {
    const groups = buildGroups([
      trend({ id: 'g1', source: 'google' }),
      trend({ id: 'h1', source: 'hackernews' }),
      trend({ id: 'h1', source: 'hackernews', title: 'duplicate' }),
      trend({ id: 'x1', source: 'myspace' as Trend['source'] }),
    ]);
    expect(groups.map((g) => g.source)).toEqual(['hackernews', 'reddit', 'google']);
    expect(groups[0].items.map((t) => t.id)).toEqual(['h1']);
    expect(groups[1].items).toEqual([]);
    expect(groups[2].items.map((t) => t.id)).toEqual(['g1']);
  });
});

describe('oldestFetchedAt', () => {
  it('returns the oldest parseable fetched_at in epoch ms', () => {
    const oldest = oldestFetchedAt([
      trend({ id: 'a', fetched_at: '2026-11-21T10:00:00Z' }),
      trend({ id: 'b', fetched_at: '2026-11-20T22:00:00Z' }),
      trend({ id: 'c', fetched_at: 'not a date' }),
    ]);
    expect(oldest).toBe(Date.parse('2026-11-20T22:00:00Z'));
  });

  it('is null for an empty list or when nothing parses', () => {
    expect(oldestFetchedAt([])).toBeNull();
    expect(oldestFetchedAt([trend({ id: 'a', fetched_at: 'nope' })])).toBeNull();
  });
});

describe('knownRelevance / matchTermsOf', () => {
  it('is null when relevance is null or missing, and clamps numbers to 0..1', () => {
    expect(knownRelevance({ relevance: null })).toBeNull();
    expect(knownRelevance({ relevance: undefined as unknown as number })).toBeNull();
    expect(knownRelevance({ relevance: 1.4 })).toBe(1);
    expect(knownRelevance({ relevance: 0.25 })).toBe(0.25);
  });

  it('treats missing match_terms (old server) as an empty list', () => {
    expect(matchTermsOf({})).toEqual([]);
    expect(matchTermsOf({ match_terms: ['coffee', 'plant'] })).toEqual(['coffee', 'plant']);
  });
});

describe('matchReason', () => {
  it('names one overlapping word', () => {
    expect(matchReason('Bean Co', 0.3, ['coffee'])).toBe(`Shares "coffee" with Bean Co's profile.`);
  });

  it('names two overlapping words with "and"', () => {
    expect(matchReason('Bean Co', 0.6, ['coffee', 'plant'])).toBe(`Shares "coffee" and "plant" with Bean Co's profile.`);
  });

  it('lists three or more with commas and a final "and"', () => {
    expect(matchReason('Bean Co', 0.6, ['coffee', 'plant', 'shop'])).toBe(
      `Shares "coffee", "plant" and "shop" with Bean Co's profile.`,
    );
  });

  it('says plainly when no words overlap but the match is known', () => {
    expect(matchReason('Bean Co', 0.1, [])).toBe(`No words from Bean Co's profile appear in this headline yet.`);
  });

  it('explains a missing match when the workspace has no brand profile', () => {
    expect(matchReason('your brand', null, [])).toBe('Matches are scored against your brand profile once it is set up.');
  });
});

describe('feed status wording', () => {
  it('names the failed source and its error', () => {
    expect(failureSummary('reddit', 'Blocked by Reddit (HTTP 403)')).toBe('Reddit feed failed: Blocked by Reddit (HTTP 403).');
    expect(failureSummary('reddit', null)).toBe('Reddit feed failed.');
  });

  it('says what the rows on screen are from when the failed source still has rows', () => {
    const entry = source({ source: 'reddit', ok: false, count: 4, error: 'Blocked by Reddit (HTTP 403)' });
    expect(sourceFailureNote(entry, '10h ago')).toBe(
      'Reddit feed failed: Blocked by Reddit (HTTP 403). Showing what we had from 10h ago.',
    );
  });

  it('asks for a refresh when the failed source has nothing', () => {
    const entry = source({ source: 'reddit', ok: false, error: 'Rate-limited by Reddit (HTTP 429)' });
    expect(sourceFailureNote(entry, null)).toBe('Reddit feed failed: Rate-limited by Reddit (HTTP 429). Refresh to try again.');
  });

  it('gives the failure as the empty message of a failed source', () => {
    const st = status(source({ source: 'reddit', ok: false, error: 'Blocked by Reddit (HTTP 403)' }));
    expect(sourceEmptyMessage('reddit', st)).toBe('Reddit feed failed: Blocked by Reddit (HTTP 403). Refresh to try again.');
  });

  it('says there is no status when it is unknown, or the source succeeded and came back empty', () => {
    expect(sourceEmptyMessage('reddit', null)).toBe('No Reddit trends came back yet. Refresh to try again.');
    expect(sourceEmptyMessage('reddit', undefined)).toBe('No Reddit trends came back yet. Refresh to try again.');
    expect(sourceEmptyMessage('reddit', status(source({ source: 'reddit', ok: true })))).toBe(
      'No Reddit trends came back yet. Refresh to try again.',
    );
  });

  it('finds the first failed source, or none', () => {
    const st = status(
      source({ source: 'hackernews', ok: true, count: 3 }),
      source({ source: 'reddit', ok: false, error: 'Timed out' }),
      source({ source: 'google', ok: false, error: 'Could not reach the source' }),
    );
    expect(feedProblem(st)?.source).toBe('reddit');
    expect(feedProblem(status(source({ source: 'reddit', ok: null })))).toBeNull();
    expect(feedProblem(null)).toBeNull();
  });
});
