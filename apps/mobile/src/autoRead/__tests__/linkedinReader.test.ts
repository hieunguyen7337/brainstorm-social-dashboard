import { parseLinkedInData, parseLinkedInProfileText, parseLinkedInText } from '../parse';
import { flowFor, parsePageUrl } from '../platforms';
import { readerScript } from '../readers';
import { makeEnv, page, type EnvOptions, type FetchHandler } from './igHarness';

const CSRF = 'ajax:SECRET123456';
const COOKIES = [`JSESSIONID="${CSRF}"`, 'li_gc=SECRETGC'];
const SECRETS = ['SECRET123456', 'SECRETGC'];

const ME = 'voyager/api/me';
const NETWORK = '/networkinfo';
const FEED = 'https://www.linkedin.com/feed/';

const ok = (body: unknown): FetchHandler => ({ status: 200, body });
const st = (status: number, body?: unknown): FetchHandler => ({ status, body });

/** The normalized `/voyager/api/me` answer: the id sits in the included mini profile. */
const meJson = (publicIdentifier = 'jane-doe') => ({
  data: { '*miniProfile': 'urn:li:fs_miniProfile:ACoAAB', plainId: 42 },
  included: [{ entityUrn: 'urn:li:fs_miniProfile:ACoAAB', publicIdentifier, firstName: 'Janeprivate', lastName: 'Doe' }],
});
const networkJson = (followersCount = 1234, connectionsCount = 567) => ({
  data: { followersCount, connectionsCount, followable: true, entityUrn: 'urn:li:fs_profileNetworkInfo:ACoAAB' },
  included: [],
});

/** jsdom has no `innerText`: give it `textContent`, which keeps the newlines the fixtures are written with. */
function withInnerText(env: ReturnType<typeof makeEnv>) {
  Object.defineProperty(env.dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: { textContent: string | null }) {
      return this.textContent;
    },
  });
  return env;
}

async function run(step: 0 | 1, opts: EnvOptions, ms = 20_000) {
  const env = withInnerText(makeEnv({ url: FEED, ...opts }));
  env.inject(readerScript('linkedin', step));
  await env.advance(ms);
  return env;
}

function expectNoSecrets(raw: string[]) {
  for (const s of SECRETS) for (const m of raw) expect(m).not.toContain(s);
}

describe('LINKEDIN_0 (any signed-in page) in a jsdom page', () => {
  it('Voyager ok: posts the id and the API counts, sends csrf-token without quotes, posts no cookie or name', async () => {
    const env = await run(0, {
      cookies: COOKIES,
      html: page('<main>Feed\nSomeone else\n9,999 followers</main>'),
      routes: [
        [NETWORK, ok(networkJson())],
        [ME, ok(meJson())],
      ],
    });
    expect(env.posted).toHaveLength(1);
    const m = env.posted[0];
    expect(m).toMatchObject({ pulse: 'autoRead', platform: 'linkedin', step: 0, status: 'ok' });
    expect(m.data.publicId).toBe('jane-doe');
    expect(m.data.followers).toBe(1234);
    expect(m.data.connections).toBe(567);
    expect(m.data.text).toBeUndefined(); // the feed's text (other people's numbers) is never posted
    expect(m.data.diag).toMatchObject({ csrf: true, me: 200, id: true, ni: 200, path: '/feed/' });

    const first = env.calls[0];
    expect(first.url).toBe('/voyager/api/me');
    expect(first.init.credentials).toBe('include');
    expect(first.init.headers['csrf-token']).toBe(CSRF);
    expect(first.init.headers.accept).toBe('application/vnd.linkedin.normalized+json+2.1');
    expect(first.init.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(env.calls[1].url).toBe('/voyager/api/identity/profiles/jane-doe/networkinfo');
    expect(env.rawPosted[0]).not.toContain('Janeprivate');
    expectNoSecrets(env.rawPosted);

    // True number or error (owner, 2026-11-21): the API's numbers alone are not saved; the app reads the profile page.
    const outcome = flowFor('linkedin').steps[0].finish(m.data, {});
    expect(outcome).toEqual({ kind: 'next', ctx: { handle: 'jane-doe' } });
  });

  it('Voyager 403 on a signed-in feed: ok with no id, so the app goes on to the profile page', async () => {
    const env = await run(0, {
      cookies: COOKIES,
      html: page('<nav><a href="/feed/">Home</a><a href="/mynetwork/">My Network</a></nav><main>Feed</main>'),
      routes: [[ME, st(403)]],
    });
    const m = env.posted[0];
    expect(m.status).toBe('ok');
    expect(m.data.publicId).toBeNull();
    expect(m.data.diag).toMatchObject({ me: 403, id: false });
    expect(env.calls).toHaveLength(1);
    const outcome = flowFor('linkedin').steps[0].finish(m.data, {});
    expect(outcome).toEqual({ kind: 'next', ctx: { handle: null } });
    expect(flowFor('linkedin').steps[1].url({ handle: null })).toBe('https://www.linkedin.com/in/me/');
    expectNoSecrets(env.rawPosted);
  });

  it('Voyager 401 on the dashboard: the dashboard text is read instead', async () => {
    const text = 'Your dashboard\n1,567\nPost impressions\n2,345\nFollowers\n89\nProfile viewers\n12\nSearch appearances';
    const env = await run(0, {
      url: 'https://www.linkedin.com/dashboard/',
      cookies: COOKIES,
      html: page(`<main>${text}</main>`),
      routes: [[ME, st(401)]],
    });
    const m = env.posted[0];
    expect(m.status).toBe('ok');
    expect(m.data.page).toBe('dashboard');
    const outcome = flowFor('linkedin').steps[0].finish(m.data, {});
    expect(outcome).toMatchObject({ kind: 'read', confidence: 'medium' });
    if (outcome.kind !== 'read') throw new Error('unreachable');
    expect(outcome.read).toMatchObject({ followers: 2345, views: 1567, profile_views: 89, period_days: 7 });
  });

  it('Voyager networkinfo failing still gives the id, and the own profile text is read', async () => {
    const env = await run(0, {
      url: 'https://www.linkedin.com/in/jane-doe/',
      cookies: COOKIES,
      html: page('<main>Jane Doe\nLondon\n1,234 followers · 500+ connections</main>'),
      routes: [
        [NETWORK, st(410)],
        [ME, ok(meJson())],
      ],
    });
    const m = env.posted[0];
    expect(m.status).toBe('ok');
    expect(m.data).toMatchObject({ publicId: 'jane-doe', page: 'profile' });
    expect(m.data.diag.ni).toBe(410);
    const outcome = flowFor('linkedin').steps[0].finish(m.data, {});
    if (outcome.kind !== 'read') throw new Error('expected a read');
    expect(outcome.read).toMatchObject({ handle: 'jane-doe', followers: 1234, notes: 'Connections: 500+.' });
  });

  it('someone else\'s profile is never read as the person\'s own', async () => {
    const env = await run(0, {
      url: 'https://www.linkedin.com/in/someone-else/',
      cookies: COOKIES,
      html: page('<main>Someone Else\n88,000 followers · 500+ connections</main>'),
      routes: [[ME, st(403)]],
    });
    expect(env.posted[0].data.publicId).toBeNull();
    expect(env.posted[0].data.text).toBeUndefined();
  });

  it('signed out: the login page', async () => {
    const env = await run(0, {
      url: 'https://www.linkedin.com/login',
      html: page('<form action="/checkpoint/lg/login-submit"><input type="password"></form>'),
    });
    expect(env.posted).toEqual([expect.objectContaining({ status: 'signed_out' })]);
    expect(env.calls).toHaveLength(0);
  });

  it('signed out: a guest page (no session cookie, sign-in links)', async () => {
    const env = await run(0, {
      url: 'https://www.linkedin.com/feed/',
      html: page('<a href="https://www.linkedin.com/login?session_redirect=x">Sign in</a><a href="/signup">Join now</a>'),
    });
    expect(env.posted[0].status).toBe('signed_out');
  });

  it('a 401 on a page with no guest links is not signed out', async () => {
    const env = await run(0, { cookies: COOKIES, html: page('<main>Feed</main>'), routes: [[ME, st(401)]] });
    expect(env.posted[0].status).toBe('ok');
  });

  it('a hung API call still posts before the deadline', async () => {
    const env = await run(0, { cookies: COOKIES, html: page('<main>Feed</main>'), routes: [[ME, { status: 0, hang: true }]] });
    expect(env.posted).toHaveLength(1);
    expect(env.posted[0].status).toBe('ok');
    expect(env.posted[0].data.diag.me).toBe(0);
  });

  it('does nothing off linkedin.com', async () => {
    const env = await run(0, { url: 'https://linkedin.com.evil.com/feed/', cookies: COOKIES, routes: [[ME, ok(meJson())]] });
    expect(env.posted).toHaveLength(0);
    expect(env.calls).toHaveLength(0);
  });
});

describe('LINKEDIN_1 (own profile) in a jsdom page', () => {
  it('reads the profile text: followers and connections', async () => {
    const env = await run(1, {
      url: 'https://www.linkedin.com/in/jane-doe/',
      html: page('<main>Jane Doe\nProduct at Acme\n1,234 followers\n500+ connections</main>'),
    });
    const m = env.posted[0];
    expect(m).toMatchObject({ platform: 'linkedin', step: 1, status: 'ok' });
    expect(m.data).toMatchObject({ publicId: 'jane-doe', page: 'profile' });
    const outcome = flowFor('linkedin').steps[1].finish(m.data, {});
    if (outcome.kind !== 'read') throw new Error('expected a read');
    expect(outcome.read).toMatchObject({ handle: 'jane-doe', followers: 1234, notes: 'Connections: 500+.' });
    expect(env.calls).toHaveLength(0);
  });

  it('no counts by the deadline: empty with a diag, and the fallback is that profile', async () => {
    const env = await run(1, { url: 'https://www.linkedin.com/in/jane-doe/', html: page('<main>Open the app</main>') });
    const m = env.posted[0];
    expect(m.status).toBe('empty');
    expect(m.data.diag).toMatchObject({ path: '/in/jane-doe/', text: false });
    expect(flowFor('linkedin').fallbackUrl({}, m.data)).toBe('https://www.linkedin.com/in/jane-doe/');
  });

  it('the authwall is signed out', async () => {
    const env = await run(1, { url: 'https://www.linkedin.com/authwall?trk=x', html: page('<main>Sign in</main>') });
    expect(env.posted[0].status).toBe('signed_out');
  });
});

describe('LinkedIn scripts follow the reader rules', () => {
  for (const step of [0, 1]) {
    it(`step ${step}: ES2017, no storage, no logging, no cookie writes, no template syntax`, () => {
      const s = readerScript('linkedin', step);
      expect(s).not.toMatch(/\?\./);
      expect(s).not.toMatch(/\?\?/);
      expect(s).not.toMatch(/\.\.\./);
      expect(s).not.toMatch(/localStorage|sessionStorage|indexedDB|console\./);
      expect(s).not.toMatch(/document\.cookie\s*=[^=]/);
      expect(s).not.toContain('`');
      expect(s).not.toContain('${');
      expect(s.trim().endsWith('true;')).toBe(true);
    });
  }
  it('there is no step 2', () => {
    expect(() => readerScript('linkedin', 2)).toThrow('no such reader');
  });
});

describe('parseLinkedInProfileText', () => {
  it('"500+ connections" and "1,234 followers" on one line', () => {
    expect(parseLinkedInProfileText('Jane Doe\n1,234 followers · 500+ connections')).toEqual({
      followers: 1234,
      notes: 'Connections: 500+.',
    });
  });
  it('K and M suffixes', () => {
    expect(parseLinkedInProfileText('1.2K followers').followers).toBe(1200);
    expect(parseLinkedInProfileText('12.5k followers').followers).toBe(12500);
    expect(parseLinkedInProfileText('3M followers').followers).toBe(3_000_000);
  });
  it('the count on the line before the label', () => {
    expect(parseLinkedInProfileText('Jane\n2,345\nfollowers\n312\nconnections')).toEqual({
      followers: 2345,
      notes: 'Connections: 312.',
    });
  });
  it('a label-first layout is not read from neighbouring lines', () => {
    expect(parseLinkedInProfileText('Followers\n2,345\nConnections\n312')).toEqual({});
  });
  it('mutual connections and other words are not counts', () => {
    expect(parseLinkedInProfileText('12 mutual connections\nfollowing 30 people')).toEqual({});
  });
  it('private analytics on the own profile', () => {
    expect(
      parseLinkedInProfileText('Analytics\nPrivate to you\n52 profile views\n1,234 post impressions\n18 search appearances'),
    ).toEqual({ views: 1234, profile_views: 52, notes: 'Search appearances: 18.' });
  });
  it('garbage gives {}', () => {
    expect(parseLinkedInProfileText(null as unknown as string)).toEqual({});
    expect(parseLinkedInProfileText('')).toEqual({});
  });
});

describe('parseLinkedInData', () => {
  it('API counts win over the page text', () => {
    expect(
      parseLinkedInData({ publicId: 'jane', followers: 1500, connections: 600, page: 'profile', text: '1,234 followers' }),
    ).toEqual({ handle: 'jane', followers: 1500, notes: 'Connections: 600.' });
  });
  it('dashboard text goes through the dashboard parser', () => {
    expect(parseLinkedInData({ page: 'dashboard', text: '10\nPost impressions' })).toMatchObject({ views: 10 });
    expect(parseLinkedInData({ page: 'dashboard', text: '10\nPost impressions' })).toEqual(
      parseLinkedInText('10\nPost impressions'),
    );
  });
  it('nothing usable gives no numbers', () => {
    expect(parseLinkedInData({ publicId: null, diag: { me: 403 } })).toEqual({});
    expect(parseLinkedInData('nope')).toEqual({});
  });
});

describe('linkedin flow: platforms', () => {
  const f = flowFor('linkedin');
  it('the feed and other signed-in pages are past login; login and guest pages are not', () => {
    for (const u of [FEED, 'https://www.linkedin.com/in/jane/', 'https://www.linkedin.com/check/add-phone', 'https://www.linkedin.com/me/'])
      expect(f.pastLogin(parsePageUrl(u)!)).toBe(true);
    for (const u of ['https://www.linkedin.com/', 'https://www.linkedin.com/login', 'https://www.linkedin.com/checkpoint/challenge/x'])
      expect(f.pastLogin(parsePageUrl(u)!)).toBe(false);
  });
  it('step 0 reads the page the person lands on (no navigation to /dashboard/)', () => {
    expect(f.steps[0].direct!(parsePageUrl(FEED)!, {})).toBe(true);
  });
  it('step 1 opens the own profile by id, else /in/me/; odd ids are not used', () => {
    expect(f.steps[1].url({ handle: 'jane-doe' })).toBe('https://www.linkedin.com/in/jane-doe/');
    expect(f.steps[1].url({ handle: '../x' })).toBe('https://www.linkedin.com/in/me/');
    expect(f.fallbackUrl({}, { publicId: 'a b' })).toBe('https://www.linkedin.com/in/me/');
    expect(f.steps[1].matches(parsePageUrl('https://www.linkedin.com/in/jane-doe/')!, {})).toBe(true);
    expect(f.steps[1].matches(parsePageUrl(FEED)!, {})).toBe(false);
  });
});
