/** Unit tests for the KPI tile decision in model.ts (`kpiTile`): `npx jest --ci src/components/dashboard`. */
import { kpiTile, METRICS, NOT_READ_FALLBACK, NOT_READ_MARK, type KpiSource } from './model';

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
