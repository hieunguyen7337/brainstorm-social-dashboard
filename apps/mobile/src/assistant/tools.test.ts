import type { Post } from '@/src/types';
import { MAX_CAPTION, TOOLS, runTool, type PostOutcome, type ToolDeps } from './tools';

const post = (over: Partial<Post> = {}): Post =>
  ({
    id: 'p1',
    platform: 'instagram',
    content: 'hello',
    hashtags: ['a'],
    media_prompt: 'secret plan',
    theme_id: null,
    trend_id: null,
    batch_id: 'b',
    link_code: 'c',
    link_url: 'https://x/r/c',
    status: 'draft',
    source: 'ai',
    scheduled_at: null,
    published_at: null,
    views: 1,
    engagements: 2,
    clicks: 3,
    conversions: 4,
    created_at: '2026-01-01',
    ...over,
  }) as Post;

function deps(over: Partial<ToolDeps['api']> = {}, outcome: PostOutcome = { status: 'cancelled' }) {
  const api = {
    getDashboard: jest.fn(async () => ({
      days: 30,
      totals: { views: 1, engagements: 2, clicks: 3, conversions: 4 },
      change_pct: { views: 0, engagements: 0, clicks: 0, conversions: 0 },
      by_platform: [],
      funnel: [],
      timeseries: [{ big: 'dropped' }],
      top_posts: [post({ id: 'a' }), post({ id: 'b' }), post({ id: 'c' }), post({ id: 'd' })],
      real_clicks: 5,
      real_conversions: 6,
    })),
    listTrends: jest.fn(async () => [
      { id: 't1', source: 'hn', title: 'T', url: 'u', score: 0.5, relevance: null, fetched_at: 'x' },
    ]),
    listPosts: jest.fn(async () => [post()]),
    createPost: jest.fn(async (b: { content: string }) => post({ content: b.content })),
    publishPost: jest.fn(async () => post({ status: 'published' })),
    ...over,
  };
  const proposePost = jest.fn(async () => outcome);
  return { api, proposePost, d: { api, proposePost } as unknown as ToolDeps };
}

describe('TOOLS', () => {
  it('are strict, closed schemas with the expected names (no browser / harvest tools)', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['get_dashboard', 'list_trends', 'list_posts', 'create_post', 'propose_instagram_post']);
    for (const t of TOOLS) {
      expect(t.strict).toBe(true);
      expect(t.input_schema).toMatchObject({ additionalProperties: false });
    }
  });
});

describe('runTool', () => {
  it('get_dashboard summarises like the MCP tool and clamps days', async () => {
    const { api, d } = deps();
    const r = await runTool('get_dashboard', { days: 9999, platform: 'instagram' }, d);
    expect(api.getDashboard).toHaveBeenCalledWith({ days: 365, platform: 'instagram' });
    const out = JSON.parse(r.content);
    expect(r.isError).toBe(false);
    expect(out.top_posts.map((p: { id: string }) => p.id)).toEqual(['a', 'b', 'c']);
    expect(out.top_posts[0]).not.toHaveProperty('media_prompt');
    expect(out).not.toHaveProperty('timeseries');
  });

  it('list_posts passes filters and trims posts', async () => {
    const { api, d } = deps();
    const r = await runTool('list_posts', { status: 'draft', limit: 500 }, d);
    expect(api.listPosts).toHaveBeenCalledWith({ status: 'draft', platform: null, limit: 50 });
    expect(JSON.parse(r.content)[0]).not.toHaveProperty('batch_id');
  });

  it('list_trends defaults and trims', async () => {
    const { api, d } = deps();
    const r = await runTool('list_trends', {}, d);
    expect(api.listTrends).toHaveBeenCalledWith({ limit: 10 });
    expect(JSON.parse(r.content)[0]).not.toHaveProperty('fetched_at');
  });

  it('create_post saves a draft with cleaned hashtags', async () => {
    const { api, d } = deps();
    const r = await runTool('create_post', { platform: 'linkedin', content: ' Hi ', hashtags: ['#x', ' y ', '', 3] }, d);
    expect(api.createPost).toHaveBeenCalledWith({ platform: 'linkedin', content: 'Hi', hashtags: ['x', 'y'], status: 'draft' });
    expect(r.isError).toBe(false);
  });

  it.each([
    ['not a live platform', { platform: 'tiktok', content: 'x' }],
    ['empty content', { platform: 'instagram', content: '  ' }],
    ['no platform', { content: 'x' }],
  ])('create_post rejects %s as an error result without calling the api', async (_w, input) => {
    const { api, d } = deps();
    const r = await runTool('create_post', input, d);
    expect(r.isError).toBe(true);
    expect(api.createPost).not.toHaveBeenCalled();
  });

  it('turns an api failure into is_error', async () => {
    const { d } = deps({ listPosts: jest.fn(async () => Promise.reject(new Error('Pulse is down'))) });
    expect(await runTool('list_posts', {}, d)).toEqual({ content: 'Pulse is down', isError: true });
  });

  it('refuses an unknown tool', async () => {
    const { d } = deps();
    expect((await runTool('browser_click', {}, d)).isError).toBe(true);
  });

  describe('propose_instagram_post', () => {
    it('reports cancelled and never publishes', async () => {
      const { api, proposePost, d } = deps();
      const r = await runTool('propose_instagram_post', { caption: 'Hi', post_id: 'p1' }, d);
      expect(proposePost).toHaveBeenCalledWith({ caption: 'Hi', postId: 'p1' }, undefined);
      expect(JSON.parse(r.content).status).toBe('cancelled');
      expect(api.publishPost).not.toHaveBeenCalled();
    });

    it('reports a share-sheet hand-off honestly and marks the draft published', async () => {
      const { api, d } = deps({}, { status: 'shared', caption: 'Edited' });
      const out = JSON.parse((await runTool('propose_instagram_post', { caption: 'Hi', post_id: 'p1' }, d)).content);
      expect(out).toMatchObject({ status: 'handed_to_instagram', caption: 'Edited', pulse_post_marked_published: true });
      expect(api.publishPost).toHaveBeenCalledWith('p1');
    });

    it('reports posted with the url, without a post id touching the api', async () => {
      const { api, d } = deps({}, { status: 'posted', caption: 'Hi', url: 'https://www.instagram.com/p/abc/' });
      const out = JSON.parse((await runTool('propose_instagram_post', { caption: 'Hi' }, d)).content);
      expect(out).toMatchObject({ status: 'posted', url: 'https://www.instagram.com/p/abc/' });
      expect(api.publishPost).not.toHaveBeenCalled();
    });

    it('survives a failed mark-as-published', async () => {
      const { d } = deps({ publishPost: jest.fn(async () => Promise.reject(new Error('x'))) }, { status: 'shared', caption: 'Hi' });
      const out = JSON.parse((await runTool('propose_instagram_post', { caption: 'Hi', post_id: 'p1' }, d)).content);
      expect(out.pulse_post_marked_published).toBe(false);
    });

    it('maps a failed post to is_error', async () => {
      const { d } = deps({}, { status: 'failed', message: 'nope' });
      const r = await runTool('propose_instagram_post', { caption: 'Hi' }, d);
      expect(r.isError).toBe(true);
      expect(r.content).toContain('nope');
    });

    it('rejects an empty or over-long caption before opening the dialog', async () => {
      const { proposePost, d } = deps();
      expect((await runTool('propose_instagram_post', { caption: ' ' }, d)).isError).toBe(true);
      expect((await runTool('propose_instagram_post', { caption: 'x'.repeat(MAX_CAPTION + 1) }, d)).isError).toBe(true);
      expect(proposePost).not.toHaveBeenCalled();
    });
  });
});
