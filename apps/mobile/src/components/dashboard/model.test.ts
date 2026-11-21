/** Unit tests for the KPI tile decision in model.ts (`kpiTile`): `npx jest --ci src/components/dashboard`. */
import { kpiTile, METRICS, NOT_READ_FALLBACK, NOT_READ_MARK, splitNote, splitRows, splitSpoken, type KpiSource } from './model';
import type { EngagementSplit } from '@/src/types';

const totals = { views: 1200, engagements: 340, clicks: 56, conversions: 7 };
const keys = METRICS.map((m) => m.key);

describe('kpiTile', () => {
  it('sample workspace (tiles == totals, not_read empty) renders exactly as before', () => {
    const src: KpiSource = { totals, tiles: { ...totals }, not_read: {} };
    for (const k of keys) {
      expect(kpiTile(src, k)).toEqual({ value: totals[k], reason: null, showBadge: true, showSparkline: true });
    }
  });

  it('old server without tiles / not_read: unchanged', () => {
    const src: KpiSource = { totals };
    for (const k of keys) {
      expect(kpiTile(src, k)).toEqual({ value: totals[k], reason: null, showBadge: true, showSparkline: true });
    }
  });

  it('real workspace, a metric never read: no number, the reason, no badge, no sparkline', () => {
    const src: KpiSource = {
      totals: { views: 0, engagements: 0, clicks: 0, conversions: 0 },
      tiles: { views: null, engagements: null, clicks: 0, conversions: null },
      not_read: {
        views: 'Instagram does not share views for photo posts',
        engagements: 'Not read yet: open Connect to read',
        conversions: 'No tracked link yet',
      },
    };
    expect(kpiTile(src, 'views')).toEqual({
      value: null,
      reason: 'Instagram does not share views for photo posts',
      showBadge: false,
      showSparkline: false,
    });
    expect(kpiTile(src, 'engagements')).toMatchObject({ value: null, reason: 'Not read yet: open Connect to read' });
    expect(kpiTile(src, 'conversions')).toMatchObject({ value: null, showBadge: false, showSparkline: false });
  });

  it('a real 0 stays 0 with its badge and sparkline', () => {
    const src: KpiSource = {
      totals: { views: 900, engagements: 40, clicks: 3, conversions: 0 },
      tiles: { views: 900, engagements: 40, clicks: 3, conversions: 0 },
      not_read: {},
    };
    expect(kpiTile(src, 'conversions')).toEqual({ value: 0, reason: null, showBadge: true, showSparkline: true });
  });

  it('a metric missing from a partial tiles map is shown as today', () => {
    const src: KpiSource = { totals, tiles: { views: null } };
    expect(kpiTile(src, 'clicks')).toEqual({ value: 56, reason: null, showBadge: true, showSparkline: true });
  });

  it('not_read missing or blank falls back to "Not read yet"', () => {
    expect(kpiTile({ totals, tiles: { views: null } }, 'views').reason).toBe(NOT_READ_FALLBACK);
    expect(kpiTile({ totals, tiles: { views: null }, not_read: { views: '  ' } }, 'views').reason).toBe(
      NOT_READ_FALLBACK,
    );
    expect(NOT_READ_FALLBACK).toBe('Not read yet');
  });

  it('the not-read mark is an em dash', () => {
    expect(NOT_READ_MARK).toBe('—');
  });
});

describe('engagement split rows', () => {
  const split: EngagementSplit = { likes: 1200, comments: 88, shares: 31, other: 0, unsplit: 0, platforms: ['instagram'] };

  it('has no rows without a split', () => {
    expect(splitRows(null)).toEqual([]);
    expect(splitRows(undefined)).toEqual([]);
    expect(splitNote(null)).toBeNull();
    expect(splitSpoken(undefined)).toBe('');
  });

  it('lists likes, comments and shares in that order', () => {
    expect(splitRows(split).map((r) => [r.key, r.label, r.value])).toEqual([
      ['likes', 'Likes', 1200],
      ['comments', 'Comments', 88],
      ['shares', 'Shares', 31],
    ]);
  });

  it('keeps a real 0 as a row', () => {
    const rows = splitRows({ ...split, comments: 0, shares: 0 });
    expect(rows.map((r) => r.value)).toEqual([1200, 0, 0]);
  });

  it('adds "Saves & other" only when it is more than 0', () => {
    expect(splitRows({ ...split, other: 0 })).toHaveLength(3);
    const rows = splitRows({ ...split, other: 60 });
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ key: 'other', label: 'Saves & other', value: 60 });
  });

  it('notes the engagements that come from accounts reporting only a total', () => {
    expect(splitNote({ ...split, unsplit: 0 })).toBeNull();
    expect(splitNote({ ...split, unsplit: 500 })).toBe('+500 from accounts that only report a total');
    expect(splitNote({ ...split, unsplit: 12_400 })).toBe('+12k from accounts that only report a total');
  });

  it('reads aloud as one sentence', () => {
    expect(splitSpoken(split)).toBe('Likes 1.2k, comments 88, shares 31.');
    expect(splitSpoken({ ...split, other: 9, unsplit: 40 })).toBe(
      'Likes 1.2k, comments 88, shares 31, saves & other 9, +40 from accounts that only report a total.',
    );
  });
});
