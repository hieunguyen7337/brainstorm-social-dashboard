import { AutoReadRunner, type RunnerDeps } from '../runner';
import { INJECT_DELAY_MS, NAV_TIMEOUT_MS, READ_TIMEOUT_MS, SETTLE_MS, STALE_PAGE_MS } from '../config';
import { AUTO_READ_FAILED, type DeviceRead } from '../types';

const LOGIN = 'https://www.linkedin.com/login';
const FEED = 'https://www.linkedin.com/feed/';
const DASHBOARD = 'https://www.linkedin.com/dashboard/';
const ME = 'https://www.linkedin.com/in/me/';
const PROFILE = 'https://www.linkedin.com/in/jane-doe/';

const flush = () => new Promise<void>((r) => setImmediate(r));

const msg = (step: number, status: string, data?: unknown) =>
  JSON.stringify({ pulse: 'autoRead', platform: 'linkedin', step, status, ...(data === undefined ? {} : { data }) });

function setup(over: Partial<RunnerDeps> = {}) {
  let now = 1_000_000;
  let seq = 0;
  let timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const log = { loads: [] as string[], injects: [] as string[], results: [] as DeviceRead[], closes: [] as Array<string | undefined>, captures: 0 };
  const deps: RunnerDeps = {
    platform: 'linkedin',
    loadUrl: (u) => void log.loads.push(u),
    inject: (s) => void log.injects.push(s),
    capture: async () => {
      log.captures += 1;
      return 'b64';
    },
    readScreenshot: async () =>
      ({
        platform: 'linkedin',
        detected_platform: 'linkedin',
        handle: null,
        followers: 77,
        following: null,
        posts_count: null,
        views: null,
        engagements: null,
        profile_views: null,
        period_days: null,
        posts: [],
        confidence: 'medium',
        notes: null,
        ai_used: true,
      }) as any,
    emitResult: (r) => void log.results.push(r),
    emitClose: (reason) => void log.closes.push(reason),
    onStatus: () => {},
    clearSession: async () => {},
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
    ...over,
  };
  const runner = new AutoReadRunner(deps);
  const adv = async (ms: number) => {
    const target = now + ms;
    await flush();
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      now = Math.max(now, next.at);
      next.fn();
      await flush();
    }
    now = target;
    await flush();
  };
  return { runner, log, adv };
}

/** Signed in on the phone: the login page redirected to the mobile feed, and step 0 was injected there. */
async function onFeed() {
  const s = setup();
  s.runner.start();
  s.runner.loadEnded(FEED);
  await s.adv(INJECT_DELAY_MS + 10);
  return s;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('linkedin runner', () => {
  it('reads on the mobile feed the person lands on: no trip to /dashboard/', async () => {
    const s = await onFeed();
    expect(s.log.loads).toEqual([LOGIN]);
    expect(s.log.injects).toHaveLength(1);
    expect(s.log.injects[0]).toContain("var PLATFORM = \"linkedin\"");
    expect(s.log.injects[0]).toContain('var STEP = 0;');
  });

  it('Voyager numbers on step 0 are not saved alone: the app opens the own profile to read what is shown', async () => {
    const s = await onFeed();
    s.runner.message(msg(0, 'ok', { publicId: 'jane-doe', followers: 1234, connections: 567, diag: { me: 200 } }));
    await s.adv(10);
    expect(s.log.results).toHaveLength(0);
    expect(s.log.loads).toEqual([LOGIN, PROFILE]);
    expect(s.log.captures).toBe(0);
  });

  it('no numbers on step 0: opens the own profile and reads its text (step 1)', async () => {
    const s = await onFeed();
    s.runner.message(msg(0, 'ok', { publicId: 'jane-doe', diag: { me: 200, ni: 404 } }));
    await s.adv(10);
    expect(s.log.loads).toEqual([LOGIN, PROFILE]);
    await s.adv(STALE_PAGE_MS + 10);
    s.runner.loadEnded(PROFILE);
    await s.adv(INJECT_DELAY_MS + 10);
    expect(s.log.injects).toHaveLength(2);
    expect(s.log.injects[1]).toContain('var STEP = 1;');
    s.runner.message(msg(1, 'ok', { publicId: 'jane-doe', page: 'profile', text: 'Jane\n1,234 followers · 500+ connections' }));
    await s.adv(10);
    expect(s.log.results).toHaveLength(1);
    expect(s.log.results[0]).toMatchObject({ handle: 'jane-doe', followers: 1234, notes: 'Connections: 500+.', confidence: 'medium' });
  });

  it('Voyager refused (no id): /in/me/ is opened, and its redirect to the profile is read', async () => {
    const s = await onFeed();
    s.runner.message(msg(0, 'ok', { publicId: null, diag: { me: 403 } }));
    await s.adv(10);
    expect(s.log.loads).toEqual([LOGIN, ME]);
    await s.adv(STALE_PAGE_MS + 10);
    s.runner.loadEnded(PROFILE);
    await s.adv(INJECT_DELAY_MS + 10);
    expect(s.log.injects).toHaveLength(2);
    s.runner.message(msg(1, 'ok', { publicId: 'jane-doe', page: 'profile', text: '2.5K followers' }));
    await s.adv(10);
    expect(s.log.results[0]).toMatchObject({ followers: 2500, handle: 'jane-doe' });
  });

  it('a profile with no readable counts falls back to a screenshot of that profile', async () => {
    const s = await onFeed();
    s.runner.message(msg(0, 'ok', { publicId: 'jane-doe' }));
    await s.adv(STALE_PAGE_MS + 10);
    s.runner.loadEnded(PROFILE);
    await s.adv(INJECT_DELAY_MS + 10);
    s.runner.message(msg(1, 'empty', { publicId: 'jane-doe', diag: { text: false } }));
    await s.adv(SETTLE_MS + 500);
    expect(s.log.loads).toEqual([LOGIN, PROFILE]); // already on the profile: no extra navigation
    expect(s.log.captures).toBe(1);
    expect(s.log.results[0]).toMatchObject({ followers: 77, source: 'device' });
  });

  it('a step-0 error goes straight to a screenshot of the own profile', async () => {
    const s = await onFeed();
    s.runner.message(msg(0, 'error'));
    await s.adv(10);
    expect(s.log.loads).toEqual([LOGIN, ME]);
    s.runner.loadEnded(PROFILE); // the redirect lands on another path: the load timer captures it
    await s.adv(20_000);
    expect(s.log.captures).toBe(1);
  });

  it('signed out on step 0 goes back to waiting for the login, without reloading it', async () => {
    const s = await onFeed();
    s.runner.message(msg(0, 'signed_out'));
    await s.adv(READ_TIMEOUT_MS + NAV_TIMEOUT_MS);
    expect(s.log.loads).toEqual([LOGIN]);
    expect(s.log.closes).toEqual([]);
    expect(s.log.results).toEqual([]);
  });

  it('a dashboard landing page is read there too (and a page that never answers ends in a screenshot, not a loop)', async () => {
    const s = setup();
    s.runner.start();
    s.runner.loadEnded(DASHBOARD);
    await s.adv(INJECT_DELAY_MS + 10);
    expect(s.log.injects).toHaveLength(1);
    await s.adv(READ_TIMEOUT_MS + 10); // the reader never posts
    expect(s.log.loads).toEqual([LOGIN, ME]);
    await s.adv(20_000);
    expect(s.log.captures).toBe(1);
    expect(s.log.closes).not.toContain(AUTO_READ_FAILED);
  });

  it('logs the diag of an ok message but never its page text', async () => {
    const spy = console.log as unknown as jest.Mock;
    const s = await onFeed();
    s.runner.message(msg(0, 'ok', { publicId: 'jane-doe', page: 'profile', text: 'SECRET PAGE TEXT', diag: { me: 200 } }));
    await s.adv(10);
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('[autoRead] linkedin step 0 ok {"me":200}'))).toBe(true);
    expect(lines.join('\n')).not.toContain('SECRET PAGE TEXT');
  });
});
