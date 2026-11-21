import { readerScript, READER_DEADLINE_MS } from '../readers';
import { makeEnv, navBar, page, profileJson, stories, type EnvOptions, type FetchHandler } from './igHarness';

const UID = '4242424242';
const SECRETS = ['SECRETCSRF', 'SECRETSESSION', UID];
const COOKIES = [`ds_user_id=${UID}`, 'csrftoken=SECRETCSRF', 'sessionid=SECRETSESSION'];

const CURRENT = 'accounts/current_user';
const INFO = `users/${UID}/info`;
const PROFILE = 'web_profile_info';

const ok = (body: unknown): FetchHandler => ({ status: 200, body });
const st = (status: number, body?: unknown): FetchHandler => ({ status, body });

async function run(opts: EnvOptions, ms = 20_000) {
  const env = makeEnv(opts);
  env.inject(readerScript('instagram', 0));
  await env.advance(ms);
  return env;
}

function expectNoSecrets(raw: string[]) {
  for (const s of SECRETS) for (const m of raw) expect(m).not.toContain(s);
}

describe('INSTAGRAM_0 executed in a jsdom page', () => {
  describe('happy paths', () => {
    it('current_user ok -> ok with counts, posts, and nothing but whitelisted fields', async () => {
      const env = await run({
        cookies: COOKIES,
        routes: [
          [CURRENT, ok({ user: { username: 'jane.doe', pk: '1', phone_number: '+1555' } })],
          [PROFILE, ok(profileJson('jane.doe'))],
        ],
      });
      expect(env.posted).toHaveLength(1);
      const m = env.posted[0];
      expect(m).toMatchObject({ pulse: 'autoRead', platform: 'instagram', step: 0, status: 'ok' });
      expect(m.data.user.username).toBe('jane.doe');
      expect(m.data.user.edge_followed_by).toEqual({ count: 1234 });
      expect(m.data.user.edge_follow).toEqual({ count: 56 });
      expect(m.data.user.edge_owner_to_timeline_media.count).toBe(78);
      expect(m.data.user.edge_owner_to_timeline_media.edges[0].node.edge_liked_by).toEqual({ count: 9 });
      expect(env.rawPosted[0]).not.toContain('phone_number');
      expectNoSecrets(env.rawPosted);
    });

    it('sends the app id and csrf header, same-origin, with credentials', async () => {
      const env = await run({
        cookies: COOKIES,
        routes: [
          [CURRENT, ok({ user: { username: 'jane' } })],
          [PROFILE, ok(profileJson('jane'))],
        ],
      });
      const first = env.calls[0];
      expect(first.url.startsWith('/')).toBe(true);
      expect(first.init.credentials).toBe('include');
      expect(first.init.headers['x-ig-app-id']).toBe('936619743392459');
      expect(first.init.headers['x-csrftoken']).toBe('SECRETCSRF');
      expect(env.calls[1].url).toContain('web_profile_info/?username=jane');
    });

    it('url-encodes the username it looks up', async () => {
      const env = await run({
        routes: [
          [CURRENT, ok({ user: { username: 'a b&c' } })],
          [PROFILE, ok(profileJson('x'))],
        ],
      });
      expect(env.calls[1].url).toContain('username=a%20b%26c');
    });

    it('current_user 400 + ds_user_id cookie + info ok -> ok', async () => {
      const env = await run({
        cookies: COOKIES,
        routes: [
          [CURRENT, st(400, { message: 'bad' })],
          [INFO, ok({ user: { username: 'viaInfo', follower_count: 10 } })],
          [PROFILE, ok(profileJson('viaInfo', 999))],
        ],
      });
      expect(env.posted).toHaveLength(1);
      expect(env.posted[0].status).toBe('ok');
      expect(env.posted[0].data.user.username).toBe('viaInfo');
      expect(env.posted[0].data.user.edge_followed_by.count).toBe(999);
      expectNoSecrets(env.rawPosted);
    });

    it('web_profile_info fails but info has flat counts -> ok from the flat counts', async () => {
      const env = await run({
        cookies: COOKIES,
        routes: [
          [CURRENT, st(400)],
          [INFO, ok({ user: { username: 'flat', follower_count: 10, following_count: 3, media_count: 4 } })],
          [PROFILE, st(500)],
        ],
      });
      expect(env.posted[0].status).toBe('ok');
      expect(env.posted[0].data.user).toMatchObject({
        username: 'flat',
        edge_followed_by: { count: 10 },
        edge_follow: { count: 3 },
        edge_owner_to_timeline_media: { count: 4 },
      });
    });

    it('a non-numeric ds_user_id is never put in a url', async () => {
      const env = await run({
        cookies: ['ds_user_id=../../evil', 'csrftoken=SECRETCSRF'],
        routes: [[CURRENT, st(400)]],
      });
      expect(env.calls.every((c) => !c.url.includes('evil'))).toBe(true);
      expectNoSecrets(env.rawPosted);
    });
  });

  describe('navigation bar fallback', () => {
    const noApi: EnvOptions['routes'] = [
      [CURRENT, st(400)],
      [INFO, st(400)],
    ];

    it('both calls fail -> takes the profile tab of the bar, never a story user', async () => {
      const env = await run({
        html: page(stories + '<main></main>' + navBar('real.me')),
        cookies: COOKIES,
        routes: [...noApi!, [PROFILE, ok(profileJson('real.me'))]],
      });
      expect(env.posted).toHaveLength(1);
      expect(env.posted[0].status).toBe('ok');
      expect(env.calls.map((c) => c.url).filter((u) => u.includes(PROFILE))).toEqual([
        expect.stringContaining('username=real.me'),
      ]);
      expect(env.rawPosted[0]).not.toContain('story');
    });

    it('works without any cookie (only the bar proves the account)', async () => {
      const env = await run({
        html: page(stories + navBar('barOnly')),
        routes: [[CURRENT, st(401)], [PROFILE, ok(profileJson('barOnly'))]],
      });
      expect(env.posted[0].status).toBe('ok');
      expect(env.posted[0].data.user.username).toBe('barOnly');
    });

    it('stories placed AFTER the bar in the document are still ignored', async () => {
      const env = await run({
        html: page(navBar('real.me') + stories),
        cookies: COOKIES,
        routes: [...noApi!, [PROFILE, ok(profileJson('real.me'))]],
      });
      expect(env.posted[0].data.user.username).toBe('real.me');
    });

    it('bar nested deep in wrappers together with the stories feed in a common ancestor', async () => {
      const env = await run({
        html: page(`<div><div><div>${stories}<div><div><nav>${navBar('deep_user')}</nav></div></div></div></div></div>`),
        cookies: COOKIES,
        routes: [...noApi!, [PROFILE, ok(profileJson('deep_user'))]],
      });
      expect(env.posted[0].data.user.username).toBe('deep_user');
    });

    it('a bar that appears after 1 s is still found', async () => {
      const env = makeEnv({
        html: page(stories),
        cookies: COOKIES,
        routes: [...noApi!, [PROFILE, ok(profileJson('late_bar'))]],
      });
      env.at(1000, () => env.dom.window.document.body.insertAdjacentHTML('beforeend', navBar('late_bar')));
      env.inject(readerScript('instagram', 0));
      await env.advance(20_000);
      expect(env.posted).toHaveLength(1);
      expect(env.posted[0].status).toBe('ok');
      expect(env.posted[0].data.user.username).toBe('late_bar');
    });

    it('a bar that appears after 5 s is still found (the wait is 6 s)', async () => {
      const env = makeEnv({
        html: page(stories),
        cookies: COOKIES,
        routes: [...noApi!, [PROFILE, ok(profileJson('very_late'))]],
      });
      env.at(5000, () => env.dom.window.document.body.insertAdjacentHTML('beforeend', navBar('very_late')));
      env.inject(readerScript('instagram', 0));
      await env.advance(20_000);
      expect(env.posted[0].data.user.username).toBe('very_late');
    });

    it('a bar that never appears: stops waiting and posts within the reader deadline', async () => {
      const env = makeEnv({ html: page(stories), cookies: COOKIES, routes: noApi });
      env.inject(readerScript('instagram', 0));
      await env.advance(READER_DEADLINE_MS);
      expect(env.posted).toHaveLength(1);
      expect(env.posted[0].status).toBe('empty');
      expect(env.posted[0].data.username).toBeUndefined();
    });

    it('reserved first-level paths are never taken as the username', async () => {
      // the bar has no profile tab: its last one-segment links are all Instagram's own pages
      const env = await run({
        html: page(
          `<div><a href="/">h</a><a href="/explore/">e</a><a href="/reels/">r</a><a href="/direct/inbox/">d</a>` +
            `<a href="/accounts/">x</a><a href="/stories/">s</a><a href="/p/">p</a></div>`,
        ),
        cookies: COOKIES,
        routes: noApi,
      });
      expect(env.posted[0].status).toBe('empty');
      expect(env.posted[0].data.username).toBeUndefined();
      expect(env.posted[0].data.diag.bar).toBe(true); // /direct/ link seen
      expect(env.posted[0].data.diag.nav).toBe(false);
    });

    it('relative links with a query or an absolute url are not taken (documented limits)', async () => {
      const env = await run({
        html: page(
          `<div><a href="/explore/">e</a><a href="/reels/">r</a><a href="/direct/inbox/">d</a>` +
            `<a href="https://www.instagram.com/abs_user/">p</a></div>`,
        ),
        cookies: COOKIES,
        routes: noApi,
      });
      expect(env.posted[0].status).toBe('empty');
    });
  });

  describe('signed out, rate limits and failures', () => {
    it('no cookie, no bar, login-ish page -> signed_out (no data)', async () => {
      const env = await run({ html: page(stories), routes: [[CURRENT, st(401)]] });
      expect(env.posted).toHaveLength(1);
      expect(env.posted[0].status).toBe('signed_out');
      expect(env.posted[0].data).toBeUndefined();
    });

    it('no cookie, no bar, empty page -> signed_out', async () => {
      const env = await run({ routes: [[CURRENT, st(403)]] });
      expect(env.posted[0].status).toBe('signed_out');
    });

    it('current_user 429 with nothing else -> error, not signed_out', async () => {
      const env = await run({ cookies: ['csrftoken=SECRETCSRF'], routes: [[CURRENT, st(429)]] });
      expect(env.posted[0].status).toBe('error');
      expectNoSecrets(env.rawPosted);
    });

    it('current_user 500 with nothing else -> error', async () => {
      const env = await run({ routes: [[CURRENT, st(503)]] });
      expect(env.posted[0].status).toBe('error');
    });

    it('current_user 429 but the bar gives the username -> carries on and reads', async () => {
      const env = await run({
        html: page(navBar('rate_ok')),
        routes: [[CURRENT, st(429)], [PROFILE, ok(profileJson('rate_ok'))]],
      });
      expect(env.posted[0].status).toBe('ok');
    });

    it('web_profile_info 429 -> empty with the username so the app can screenshot the profile', async () => {
      const env = await run({
        cookies: COOKIES,
        routes: [[CURRENT, ok({ user: { username: 'jane' } })], [PROFILE, st(429)]],
      });
      expect(env.posted[0].status).toBe('empty');
      expect(env.posted[0].data.username).toBe('jane');
      expect(env.posted[0].data.diag.b).toBe(429);
      expectNoSecrets(env.rawPosted);
    });

    it('web_profile_info with a non-JSON body -> empty with the username', async () => {
      const env = await run({
        routes: [[CURRENT, ok({ user: { username: 'jane' } })], [PROFILE, st(200, '<html>login</html>')]],
      });
      expect(env.posted[0]).toMatchObject({ status: 'empty', data: { username: 'jane' } });
    });

    it('web_profile_info with an unexpected shape -> empty with the username', async () => {
      const env = await run({
        routes: [[CURRENT, ok({ user: { username: 'jane' } })], [PROFILE, ok({ data: { user: null } })]],
      });
      expect(env.posted[0]).toMatchObject({ status: 'empty', data: { username: 'jane' } });
    });

    it('web_profile_info hangs -> times out and posts empty with the username (still inside the deadline)', async () => {
      const env = makeEnv({
        routes: [[CURRENT, ok({ user: { username: 'jane' } })], [PROFILE, { status: 200, hang: true }]],
      });
      env.inject(readerScript('instagram', 0));
      await env.advance(READER_DEADLINE_MS);
      expect(env.posted).toHaveLength(1);
      expect(env.posted[0]).toMatchObject({ status: 'empty', data: { username: 'jane' } });
    });

    it('cookie present, every call fails -> empty (the person IS signed in), diag has booleans only', async () => {
      const env = await run({ cookies: COOKIES, routes: [[CURRENT, st(400)], [INFO, st(400)]] });
      expect(env.posted[0].status).toBe('empty');
      const d = env.posted[0].data.diag;
      expect(d).toMatchObject({ a: 400, c: 400, uid: true, csrf: true, nav: false });
      expectNoSecrets(env.rawPosted);
    });

    it('on the feed, step 0 sends the numbers and asks for the profile page', async () => {
      const env = await run({
        routes: [
          [CURRENT, ok({ user: { username: 'jane' } })],
          [PROFILE, ok({ data: { user: { username: 'jane', edge_followed_by: { count: 7 } } } })],
        ],
      });
      expect(env.posted[0].status).toBe('ok');
      expect(env.posted[0].data.go).toBe('jane');
      expect(env.posted[0].data.user.edge_followed_by).toEqual({ count: 7 });
    });

    it('fixed: the profile page wins over a data call that says 0 followers (tester, 2026-11-21)', async () => {
      const page = '<meta property="og:description" content="1 Followers, 3 Following, 0 Posts - See Instagram photos" />';
      const env = await run({
        url: 'https://www.instagram.com/jane/',
        routes: [
          [CURRENT, ok({ user: { username: 'jane' } })],
          [PROFILE, ok({ data: { user: { username: 'jane', edge_followed_by: { count: 0 }, edge_follow: { count: 3 } } } })],
          ['/jane/', ok(page)],
        ],
      });
      expect(env.posted[0].status).toBe('ok');
      expect(env.posted[0].data.user.edge_followed_by).toEqual({ count: 1 });
      expect(env.posted[0].data.diag).toMatchObject({ api: 0, txt: 1, src: 'page' });
    });

    it('an abbreviated page count does not replace the exact count from the data call', async () => {
      const page = '<meta property="og:description" content="1.2K Followers, 3 Following, 9 Posts" />';
      const env = await run({
        url: 'https://www.instagram.com/jane/',
        routes: [
          [CURRENT, ok({ user: { username: 'jane' } })],
          [PROFILE, ok({ data: { user: { username: 'jane', edge_followed_by: { count: 1234 } } } })],
          ['/jane/', ok(page)],
        ],
      });
      expect(env.posted[0].data.user.edge_followed_by).toEqual({ count: 1234 });
      expect(env.posted[0].data.diag.src).toBeUndefined();
    });

    it('a username given by the API without numbers anywhere is not turned into numbers', async () => {
      const env = await run({
        routes: [[CURRENT, ok({ user: { username: 'jane' } })], [PROFILE, ok({ data: { user: { username: 'jane' } } })]],
      });
      expect(env.posted[0].status).toBe('ok');
      expect(env.posted[0].data.user).toEqual({ username: 'jane' });
    });

    it('fixed: a timed-out current_user with no cookie and no bar says signed_out, not error', async () => {
      // readers.ts: `if (a.status === 429 || a.status >= 500) return finish('error')` - a timeout / network failure is
      // status 0, so it falls through to `signed_out`, which sends a signed-in person back to the login screen.
      // Fix: `if (a.status === 0 || a.status === 429 || a.status >= 500)`.
      const env = await run({ routes: [[CURRENT, { status: 200, hang: true }]] });
      expect(env.posted[0].status).toBe('error');
    });
  });

  describe('guards', () => {
    it('posts exactly one message per injection and a double injection does nothing', async () => {
      const env = makeEnv({
        cookies: COOKIES,
        routes: [[CURRENT, ok({ user: { username: 'jane' } })], [PROFILE, ok(profileJson('jane'))]],
      });
      env.inject(readerScript('instagram', 0));
      env.inject(readerScript('instagram', 0));
      await env.advance(20_000);
      expect(env.posted).toHaveLength(1);
    });

    it('a new injection after the first posted runs again', async () => {
      const env = makeEnv({
        cookies: COOKIES,
        routes: [[CURRENT, ok({ user: { username: 'jane' } })], [PROFILE, ok(profileJson('jane'))]],
      });
      env.inject(readerScript('instagram', 0));
      await env.advance(5_000);
      env.inject(readerScript('instagram', 0));
      await env.advance(5_000);
      expect(env.posted).toHaveLength(2);
    });

    it('does nothing on another host', async () => {
      const env = await run({ url: 'https://evil.example.com/', cookies: COOKIES, routes: [[CURRENT, st(200, {})]] });
      expect(env.posted).toHaveLength(0);
      expect(env.calls).toHaveLength(0);
    });

    it('does nothing on a look-alike host', async () => {
      const env = await run({ url: 'https://notinstagram.com/', routes: [] });
      expect(env.posted).toHaveLength(0);
      expect(env.calls).toHaveLength(0);
    });

    it('runs on a subdomain', async () => {
      const env = await run({
        url: 'https://m.instagram.com/',
        routes: [[CURRENT, ok({ user: { username: 'jane' } })], [PROFILE, ok(profileJson('jane'))]],
      });
      expect(env.posted[0].status).toBe('ok');
    });

    it('does nothing without the bridge', async () => {
      const env = await run({ noBridge: true, routes: [[CURRENT, ok({ user: { username: 'jane' } })]] });
      expect(env.calls).toHaveLength(0);
    });

    it('is ES2017: no optional chaining, nullish coalescing, spread, and never touches storage or writes cookies', () => {
      const s = readerScript('instagram', 0);
      expect(s).not.toMatch(/\?\./);
      expect(s).not.toMatch(/\?\?/);
      expect(s).not.toMatch(/\.\.\./);
      expect(s).not.toMatch(/localStorage|sessionStorage|indexedDB|console\./);
      expect(s).not.toMatch(/document\.cookie\s*=[^=]/);
      expect(s.trim().endsWith('true;')).toBe(true);
    });

    it('the script has no template-literal syntax that would break String.raw (no backticks, no ${)', () => {
      const s = readerScript('instagram', 0);
      expect(s).not.toContain('`');
      expect(s).not.toContain('${');
    });

    it('readerScript throws for an unknown step', () => {
      expect(() => readerScript('instagram', 1)).toThrow('no such reader');
    });

    it('the deadline option is respected', async () => {
      const env = makeEnv({ cookies: COOKIES, routes: [[CURRENT, st(400)], [INFO, st(400)]] });
      env.inject(readerScript('instagram', 0, undefined, { deadlineMs: 2000 }));
      await env.advance(2500);
      expect(env.posted).toHaveLength(1);
    });
  });
});
