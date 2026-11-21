import { LANES, laneCounts } from '@/src/components/dashboard/boardModel';
import { splitPosts } from '@/src/components/queue/queueModel';
import { defaultPlatforms, togglePlatform } from '@/src/components/settings/autopilot-logic';
import { buildGroups, SOURCE_ORDER, sourceChipLabel, sourceIsComingSoon } from '@/src/components/trends/trendUtils';
import {
  comingSoonLine,
  comingSoonReason,
  isLivePlatform,
  LIVE_PLATFORMS,
  UPCOMING_PLATFORMS,
} from '@/src/platforms';
import { SHAREABLE } from '@/src/shareLinks';
import type { Connection, Platform, Post, Trend } from '@/src/types';
import { PLATFORMS } from '@/src/types';

const post = (platform: Platform, status: Post['status'] = 'draft', id = `${platform}-${status}`): Post =>
  ({
    id, platform, status, content: 'hi', hashtags: [], created_at: '2026-11-01T00:00:00', scheduled_at: null,
    published_at: null,
  }) as unknown as Post;

describe('live / upcoming platform config', () => {
  it('only Instagram and LinkedIn are live; every other platform is upcoming', () => {
    expect([...LIVE_PLATFORMS]).toEqual(['linkedin', 'instagram']);
    expect([...UPCOMING_PLATFORMS]).toEqual(['x', 'tiktok', 'facebook', 'reddit']);
    expect([...LIVE_PLATFORMS, ...UPCOMING_PLATFORMS].sort()).toEqual([...PLATFORMS].sort());
    expect(comingSoonLine()).toBe('Coming soon: X, TikTok, Facebook, Reddit');
    expect(comingSoonReason('x')).toBe('X is coming soon to Pulse');
    expect(isLivePlatform('x')).toBe(false);
  });

  it('the dashboard lanes (and so the filter chips, which map LIVE_PLATFORMS) list live platforms only', () => {
    expect(LANES.flatMap((l) => l.platforms).sort()).toEqual(['instagram', 'linkedin']);
    expect(laneCounts([post('x', 'published')]).every((c) => c.published === 0)).toBe(true);
  });

  it('the queue never lists posts of an upcoming platform (so none can be published)', () => {
    const lists = splitPosts([post('x'), post('tiktok', 'scheduled'), post('reddit', 'published'), post('linkedin')]);
    expect([...lists.drafts, ...lists.scheduled, ...lists.published].map((p) => p.platform)).toEqual(['linkedin']);
  });

  it('autopilot and the share targets only offer live platforms', () => {
    const conns = PLATFORMS.map((platform) => ({ platform, status: 'connected' }) as unknown as Connection);
    expect(defaultPlatforms(conns)).toEqual(['linkedin', 'instagram']);
    expect(defaultPlatforms(undefined)).toEqual(['linkedin', 'instagram']);
    expect(togglePlatform(['linkedin'], 'instagram')).toEqual(['linkedin', 'instagram']);
    expect(SHAREABLE).toEqual(['linkedin']);
  });

  it('Trends: Reddit is "coming soon", labelled so, and its items are dropped', () => {
    expect(sourceIsComingSoon('reddit')).toBe(true);
    expect(sourceIsComingSoon('hackernews')).toBe(false);
    expect(sourceChipLabel('reddit')).toBe('Reddit · coming soon');
    expect(sourceChipLabel('hackernews')).toBe('Hacker News');
    const t = (id: string, source: Trend['source']) => ({ id, source, title: id, relevance: 0.5, score: 0.5 }) as Trend;
    const groups = buildGroups([t('a', 'hackernews'), t('b', 'reddit')]);
    expect(SOURCE_ORDER).toContain('reddit');
    expect(groups.find((g) => g.source === 'reddit')?.items).toEqual([]);
    expect(groups.find((g) => g.source === 'hackernews')?.items).toHaveLength(1);
  });
});
