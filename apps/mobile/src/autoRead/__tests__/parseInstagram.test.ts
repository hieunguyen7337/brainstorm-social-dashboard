import { hasNumbers, parseCount, parseInstagramJson, toScreenshotRead } from '../parse';

const user = (over: Record<string, unknown> = {}) => ({
  username: 'jane.doe',
  edge_followed_by: { count: 1234 },
  edge_follow: { count: 56 },
  edge_owner_to_timeline_media: { count: 78 },
  ...over,
});

describe('parseInstagramJson', () => {
  describe('shapes', () => {
    it('reads the page message shape { user }, the raw { data: { user } } shape and a bare user', () => {
      const want = { handle: 'jane.doe', followers: 1234, following: 56, posts_count: 78 };
      expect(parseInstagramJson({ user: user() })).toEqual(want);
      expect(parseInstagramJson({ data: { user: user() } })).toEqual(want);
      expect(parseInstagramJson(user())).toEqual(want);
    });

    it('garbage gives {} and never throws', () => {
      for (const g of [null, undefined, 0, 1, 'x', true, [], [1], {}, { user: null }, { data: 5 }, () => 1, Symbol('s')])
        expect(parseInstagramJson(g)).toEqual({});
    });

    it('a throwing getter inside the json gives {}', () => {
      const evil = {
        get user() {
          throw new Error('boom');
        },
      };
      expect(parseInstagramJson(evil)).toEqual({});
    });

    it('a cyclic structure does not hang', () => {
      const a: any = { user: { username: 'x' } };
      a.user.self = a;
      expect(parseInstagramJson(a)).toEqual({ handle: 'x' });
    });
  });

  describe('missing counts', () => {
    it('only a username -> handle only, no numbers', () => {
      const p = parseInstagramJson({ username: 'jane' });
      expect(p).toEqual({ handle: 'jane' });
      expect(hasNumbers(p)).toBe(false);
    });

    it('an absent count leaves the key out (never 0, never null)', () => {
      const p = parseInstagramJson({ user: { username: 'j', edge_followed_by: { count: 5 } } });
      expect(p).toEqual({ handle: 'j', followers: 5 });
      expect('following' in p).toBe(false);
      expect('posts_count' in p).toBe(false);
    });

    it('count objects without count, or null edges, are absent', () => {
      expect(parseInstagramJson({ user: user({ edge_followed_by: {}, edge_follow: null, edge_owner_to_timeline_media: [] }) })).toEqual({
        handle: 'jane.doe',
      });
    });

    it('a real 0 is kept as 0 (zero followers is a number)', () => {
      const p = parseInstagramJson({ user: user({ edge_followed_by: { count: 0 } }) });
      expect(p.followers).toBe(0);
      expect(hasNumbers(p)).toBe(true);
    });

    it('a hidden count (-1) is absent', () => {
      const p = parseInstagramJson({ user: user({ edge_followed_by: { count: -1 } }) });
      expect('followers' in p).toBe(false);
    });

    it('no username: handle absent but numbers still read', () => {
      const p = parseInstagramJson({ user: { edge_followed_by: { count: 9 } } });
      expect(p).toEqual({ followers: 9 });
    });
  });

  describe('numeric strings', () => {
    it.each([
      ['1234', 1234],
      ['1,234', 1234],
      ['1.234.567', 1234567],
      ['12.5K', 12500],
      ['1.2M', 1200000],
      ['3B', 3e9],
      [' 42 ', 42],
      ['12 345', 12345],
    ])('%s -> %d', (s, n) => {
      expect(parseInstagramJson({ user: user({ edge_followed_by: { count: s } }) }).followers).toBe(n);
    });

    it.each(['', 'abc', '1.5', '12abc', '0x10', '1e3', '-5', 'NaN', 'Infinity', '1,2,3', '١٢٣', '9'.repeat(41)])(
      'rejects %j',
      (s) => {
        expect('followers' in parseInstagramJson({ user: user({ edge_followed_by: { count: s } }) })).toBe(false);
      },
    );

    it('non-number, non-string counts are absent (booleans, objects, arrays, null)', () => {
      for (const v of [true, {}, [], null, undefined]) {
        expect('followers' in parseInstagramJson({ user: user({ edge_followed_by: { count: v } }) })).toBe(false);
      }
    });

    it('floats are rounded to whole numbers', () => {
      expect(parseInstagramJson({ user: user({ edge_followed_by: { count: 12.6 } }) }).followers).toBe(13);
    });
  });

  describe('huge and odd numbers', () => {
    it('1e12 is the last accepted value, above it is absent', () => {
      expect(parseInstagramJson({ user: user({ edge_followed_by: { count: 1e12 } }) }).followers).toBe(1e12);
      expect('followers' in parseInstagramJson({ user: user({ edge_followed_by: { count: 1e12 + 1 } }) })).toBe(false);
      expect('followers' in parseInstagramJson({ user: user({ edge_followed_by: { count: 1e30 } }) })).toBe(false);
      expect('followers' in parseInstagramJson({ user: user({ edge_followed_by: { count: Number.MAX_VALUE } }) })).toBe(false);
    });

    it('NaN, Infinity and -0 are handled', () => {
      expect('followers' in parseInstagramJson({ user: user({ edge_followed_by: { count: NaN } }) })).toBe(false);
      expect('followers' in parseInstagramJson({ user: user({ edge_followed_by: { count: Infinity } }) })).toBe(false);
      expect(Object.is(parseInstagramJson({ user: user({ edge_followed_by: { count: -0 } }) }).followers, 0)).toBe(true);
    });

    it('a string with a huge exponent suffix is rejected, not computed', () => {
      expect('followers' in parseInstagramJson({ user: user({ edge_followed_by: { count: '999999999B' } }) })).toBe(false);
      expect(parseCount('1000B')).toBe(1e12);
      expect(parseCount('1001B')).toBeNull();
    });
  });

  describe('handle', () => {
    it('strips leading @, rejects whitespace, control characters and over-long handles', () => {
      expect(parseInstagramJson({ user: user({ username: '@@jane' }) }).handle).toBe('jane');
      for (const bad of ['a b', '', '   ', 'x'.repeat(101), 'a\u0000b', 5, null])
        expect('handle' in parseInstagramJson({ user: user({ username: bad }) })).toBe(false);
    });
  });

  describe('posts', () => {
    const node = (over: Record<string, unknown> = {}) => ({
      taken_at_timestamp: 1_700_000_000,
      is_video: false,
      edge_liked_by: { count: 10 },
      edge_media_to_comment: { count: 2 },
      edge_media_to_caption: { edges: [{ node: { text: 'hi' } }] },
      ...over,
    });
    const withPosts = (nodes: unknown[]) => parseInstagramJson({ user: user({ edge_owner_to_timeline_media: { count: 9, edges: nodes.map((n) => ({ node: n })) } }) });

    it('reads a post with the date in UTC and null shares', () => {
      const p = withPosts([node()]);
      expect(p.posts).toEqual([{ content: 'hi', views: null, likes: 10, comments: 2, shares: null, posted_at: '2023-11-14' }]);
    });

    it('video views only for videos', () => {
      expect(withPosts([node({ is_video: true, video_view_count: '1.2K' })]).posts![0].views).toBe(1200);
      expect(withPosts([node({ is_video: false, video_view_count: 500 })]).posts![0].views).toBeNull();
      expect(withPosts([node({ is_video: true })]).posts![0].views).toBeNull();
    });

    it('at most 12 posts', () => {
      expect(withPosts(Array.from({ length: 30 }, () => node())).posts).toHaveLength(12);
    });

    it('nodes that give nothing are not posts, so garbage nodes do not make hasNumbers true', () => {
      const p = parseInstagramJson({ username: 'j', edge_owner_to_timeline_media: { edges: [{ node: {} }, { node: null }, {}, 5, { node: { is_video: true } }] } });
      expect(p.posts).toBeUndefined();
      expect(hasNumbers(p)).toBe(false);
    });

    it('likes fall back to edge_media_preview_like, but a hidden like count (-1) does not fall through', () => {
      expect(withPosts([node({ edge_liked_by: undefined, edge_media_preview_like: { count: 7 } })]).posts![0].likes).toBe(7);
      expect(withPosts([node({ edge_liked_by: { count: -1 }, edge_media_preview_like: { count: 7 } })]).posts![0].likes).toBeNull();
    });

    it('captions are clipped to 200 characters without splitting a surrogate pair', () => {
      const text = 'a'.repeat(199) + '\u{1F600}tail';
      const c = withPosts([node({ edge_media_to_caption: { edges: [{ node: { text } }] } })]).posts![0].content!;
      expect(c.length).toBeLessThanOrEqual(200);
      expect(c).toBe('a'.repeat(199)); // the emoji straddles the cut and is dropped whole
      for (let i = 0; i < c.length; i++) {
        const code = c.charCodeAt(i);
        expect(code >= 0xd800 && code <= 0xdbff).toBe(false);
      }
    });

    it('blank captions are null; a post with only a timestamp is kept', () => {
      const p = withPosts([{ taken_at_timestamp: 1_700_000_000, edge_media_to_caption: { edges: [{ node: { text: '   ' } }] } }]);
      expect(p.posts![0]).toMatchObject({ content: null, posted_at: '2023-11-14' });
    });

    it('timestamps in milliseconds, zero, negative or absurd give posted_at null', () => {
      for (const t of [1_700_000_000_000, 0, -5, 1e15, 'soon', null]) {
        const p = withPosts([node({ taken_at_timestamp: t })]);
        expect(p.posts![0].posted_at).toBeNull();
      }
    });

    it('edges that is not an array is ignored', () => {
      expect(parseInstagramJson({ user: user({ edge_owner_to_timeline_media: { count: 3, edges: 'x' } }) }).posts).toBeUndefined();
    });
  });

  describe('feed posts (the reader\'s feed/user fallback)', () => {
    const reel = { like_count: 40, comment_count: 3, play_count: 900, ig_play_count: 800, taken_at: 1_700_000_000, media_type: 2, product_type: 'clips', caption: { text: 'reel' } };
    const video = { like_count: 5, comment_count: 1, view_count: 70, taken_at: 1_700_086_400, media_type: 2, product_type: 'feed' };
    const photo = { like_count: 12, comment_count: 0, taken_at: 1_700_172_800, media_type: 1, caption: { text: 'pic' } };
    const withFeed = (feed: unknown, u: Record<string, unknown> = { username: 'jane.doe', edge_followed_by: { count: 1 } }) =>
      parseInstagramJson({ user: u, feed, diag: { f: 200 } });

    it('reads a reel, a video and a photo: likes, comments, views (photos none), date and caption', () => {
      const p = withFeed([reel, video, photo]);
      expect(p).toMatchObject({ handle: 'jane.doe', followers: 1 });
      expect(p.posts).toEqual([
        { content: 'reel', views: 900, likes: 40, comments: 3, shares: null, posted_at: '2023-11-14' },
        { content: null, views: 70, likes: 5, comments: 1, shares: null, posted_at: '2023-11-15' },
        { content: 'pic', views: null, likes: 12, comments: 0, shares: null, posted_at: '2023-11-16' },
      ]);
      expect(hasNumbers(p)).toBe(true);
    });

    it('views are the first present of play_count, ig_play_count, view_count', () => {
      expect(withFeed([{ ...video, view_count: 70, ig_play_count: 66 }]).posts![0].views).toBe(66);
      expect(withFeed([{ ...video, ig_play_count: undefined, view_count: 70 }]).posts![0].views).toBe(70);
      expect(withFeed([{ ...reel, play_count: -1 }]).posts![0].views).toBeNull(); // hidden -1 does not fall through
    });

    it('hidden counts stay null, never 0: like_and_view_counts_disabled, a missing or a negative like_count', () => {
      const hidden = withFeed([{ ...reel, like_and_view_counts_disabled: true }]).posts![0];
      expect(hidden).toMatchObject({ likes: null, views: null, comments: 3 });
      expect(withFeed([{ ...photo, like_count: undefined }]).posts![0].likes).toBeNull();
      expect(withFeed([{ ...photo, like_count: -1 }]).posts![0].likes).toBeNull();
      expect(withFeed([{ ...photo, comment_count: undefined }]).posts![0].comments).toBeNull();
      expect(withFeed([{ ...reel, like_and_view_counts_disabled: false }]).posts![0].likes).toBe(40);
    });

    it('captions are clipped to 200 characters; taken_at in ms or garbage gives posted_at null', () => {
      expect(withFeed([{ ...photo, caption: { text: 'x'.repeat(500) } }]).posts![0].content).toBe('x'.repeat(200));
      expect(withFeed([{ ...photo, caption: null }]).posts![0].content).toBeNull();
      for (const t of [1_700_000_000_000, 0, -5, 'soon', null]) expect(withFeed([{ ...photo, taken_at: t }]).posts![0].posted_at).toBeNull();
    });

    it('garbage items are skipped and garbage feeds never throw', () => {
      expect(withFeed([null, 5, 'x', [], {}, { media_type: 1 }, photo]).posts).toHaveLength(1);
      for (const g of [null, 5, 'x', {}, { items: 3 }, [null]]) {
        const p = withFeed(g);
        expect(p.posts).toBeUndefined();
        expect(p.followers).toBe(1);
      }
      const evil = [{ get like_count(): number { throw new Error('boom'); } }];
      expect(() => withFeed(evil)).not.toThrow();
    });

    it('at most 12 posts', () => {
      expect(withFeed(Array.from({ length: 30 }, () => photo)).posts).toHaveLength(12);
    });

    it('web_profile_info posts are preferred: the feed is used only when the edges gave none', () => {
      const edges = { count: 9, edges: [{ node: { taken_at_timestamp: 1_700_000_000, edge_liked_by: { count: 99 } } }] };
      const both = withFeed([photo, video], { username: 'j', edge_owner_to_timeline_media: edges });
      expect(both.posts).toHaveLength(1);
      expect(both.posts![0].likes).toBe(99);
      const garbageEdges = withFeed([photo], { username: 'j', edge_owner_to_timeline_media: { count: 9, edges: [{ node: {} }] } });
      expect(garbageEdges.posts).toEqual([expect.objectContaining({ likes: 12, comments: 0 })]);
    });

    it('edge posts with no count (hidden -1, or missing) give way to the feed posts that have counts', () => {
      const bare = { count: 1, edges: [{ node: { taken_at_timestamp: 1_700_000_000, edge_media_preview_like: { count: -1 } } }] };
      const p = withFeed([photo], { username: 'j', edge_owner_to_timeline_media: bare });
      expect(p.posts).toEqual([expect.objectContaining({ likes: 12, comments: 0 })]);
      const noFeed = withFeed([], { username: 'j', edge_owner_to_timeline_media: bare });
      expect(noFeed.posts).toHaveLength(1);
      expect(noFeed.posts![0].likes).toBeNull();
    });

    it('a raw feed response ({ items, user }) is read too', () => {
      const p = parseInstagramJson({ items: [reel], user: { username: 'jane.doe' }, num_results: 1 });
      expect(p).toEqual({ handle: 'jane.doe', posts: [expect.objectContaining({ likes: 40, views: 900 })] });
    });

    it('the toScreenshotRead result carries the feed posts', () => {
      const r = toScreenshotRead('instagram', withFeed([reel, photo]), 'high');
      expect(r.posts.map((x) => [x.likes, x.comments, x.views])).toEqual([[40, 3, 900], [12, 0, null]]);
    });
  });

  describe('toScreenshotRead', () => {
    it('fills every contract field, nulls for what was not read, ai_used false', () => {
      const r = toScreenshotRead('instagram', parseInstagramJson({ user: user() }), 'high');
      expect(r).toMatchObject({
        platform: 'instagram',
        detected_platform: 'instagram',
        handle: 'jane.doe',
        followers: 1234,
        following: 56,
        posts_count: 78,
        views: null,
        engagements: null,
        profile_views: null,
        period_days: null,
        posts: [],
        confidence: 'high',
        notes: null,
        ai_used: false,
      });
    });
  });
});
