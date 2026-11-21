import { AutoReadRunner, type RunnerDeps, type RunnerStatus } from '../runner';
import { FALLBACK_LOAD_MS, INJECT_DELAY_MS, MAX_INJECTIONS, READ_TIMEOUT_MS, SETTLE_MS, STALE_PAGE_MS } from '../config';
import { AUTO_READ_FAILED, type DeviceRead } from '../types';
import { flowFor, parsePageUrl } from '../platforms';

const FEED = 'https://www.instagram.com/';
const LOGIN = 'https://www.instagram.com/accounts/login/';
const PROFILE = 'https://www.instagram.com/jane.doe/';

const flush = () => new Promise<void>((r) => setImmediate(r));

const msg = (status: string, data?: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ pulse: 'autoRead', platform: 'instagram', step: 0, status, ...(data === undefined ? {} : { data }), ...extra });

const okData = { user: { username: 'jane.doe', edge_followed_by: { count: 100 }, edge_follow: { count: 5 } } };

const shot = (over: Record<string, unknown> = {}) => ({
  platform: 'instagram',
  detected_platform: 'instagram',
  handle: 'jane.doe',
  followers: 100,
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
  ...over,
});

function setup(over: Partial<RunnerDeps> = {}) {
  let now = 1_000_000;
  let seq = 0;
  let timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const log = {
    loads: [] as string[],
    injects: [] as string[],
    results: [] as DeviceRead[],
    closes: [] as Array<string | undefined>,
    statuses: [] as RunnerStatus[],
    captures: 0,
    cleared: 0,
  };
  const deps: RunnerDeps = {
    platform: 'instagram',
    loadUrl: (u) => void log.loads.push(u),
    inject: (s) => void log.injects.push(s),
    capture: async () => {
      log.captures += 1;
      return 'b64';
    },
    readScreenshot: async () => shot() as any,
    emitResult: (r) => void log.results.push(r),
    emitClose: (reason) => void log.closes.push(reason),
    onStatus: (s) => void log.statuses.push(s),
    clearSession: async () => {
      log.cleared += 1;
    },
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
  return { runner, log, adv, pending: () => timers.length };
}

/** start() -> login page loaded, the person is on the feed, the reader script has been injected. */
async function onFeed(over: Partial<RunnerDeps> = {}) {
  const s = setup(over);
  s.runner.start();
  s.runner.navigated(FEED, false);
  await s.adv(INJECT_DELAY_MS + 10);
  return s;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('instagram flow: platforms', () => {
  const f = flowFor('instagram');
  it('any non-login instagram.com page is past login, login-ish pages are not', () => {
    expect(f.pastLogin(parsePageUrl(FEED)!)).toBe(true);
    expect(f.pastLogin(parsePageUrl('https://www.instagram.com/explore/')!)).toBe(true);
    expect(f.pastLogin(parsePageUrl(LOGIN)!)).toBe(false);
    expect(f.pastLogin(parsePageUrl('https://www.instagram.com/accounts/emailsignup/')!)).toBe(false);
    expect(f.pastLogin(parsePageUrl('https://www.instagram.com/challenge/abc/')!)).toBe(false);
  });
  it('look-alike hosts are never past login', () => {
    for (const u of ['https://instagram.com.evil.com/', 'https://evilinstagram.com/', 'https://user@instagram.com/'])
      expect(f.pastLogin(parsePageUrl(u) ?? { host: 'x', path: '/' })).toBe(false);
  });
  it('fallbackUrl only builds a profile url from a valid username hint', () => {
    expect(f.fallbackUrl({}, { username: 'jane.doe' })).toBe(PROFILE);
    for (const bad of [null, undefined, '', {}, { username: '' }, { username: 'a b' }, { username: '../x' }, { username: 'a/b' }, { username: 'x'.repeat(31) }, { username: 5 }])
      expect(f.fallbackUrl({}, bad)).toBeNull();
  });
  it('finish: numbers -> read; username only -> empty with the username hint; garbage -> empty', () => {
    const step = f.steps[0];
    expect(step.finish(okData, {})).toMatchObject({ kind: 'read', confidence: 'high' });
    expect(step.finish({ user: { username: 'jane' } }, {})).toEqual({ kind: 'empty', hint: { username: 'jane' } });
    expect(step.finish({ username: 'jane', diag: {} }, {})).toEqual({ kind: 'empty', hint: { username: 'jane' } });
    expect(step.finish(null, {})).toEqual({ kind: 'empty', hint: { username: null } });
    expect(step.finish('garbage', {})).toEqual({ kind: 'empty', hint: { username: null } });
  });
});

describe('instagram runner', () => {
  describe('happy path', () => {
    it('login page, then the feed: injects once and emits the numbers exactly once', async () => {
      const { runner, log, adv } = setup();
      runner.start();
      expect(log.loads).toEqual([LOGIN]);
      expect(log.statuses).toEqual(['login']);
      runner.navigated(LOGIN, false);
      runner.navigated(FEED, true); // loading: no read yet
      await adv(1000);
      expect(log.injects).toHaveLength(0);
      runner.navigated(FEED, false);
      runner.loadEnded(FEED);
      await adv(INJECT_DELAY_MS + 10);
      expect(log.injects).toHaveLength(1);
      expect(log.injects[0]).toContain("var PLATFORM = \"instagram\"");
      runner.message(msg('ok', okData));
      await adv(10);
      expect(log.results).toHaveLength(1);
      expect(log.results[0]).toMatchObject({ platform: 'instagram', source: 'device', handle: 'jane.doe', followers: 100, following: 5, confidence: 'high' });
      expect(log.closes).toHaveLength(0);
      expect(log.cleared).toBe(1);
      // nothing more after the end
      runner.navigated(FEED + '?again', false);
      runner.message(msg('ok', okData));
      await adv(60_000);
      expect(log.results).toHaveLength(1);
      expect(log.injects).toHaveLength(1);
    });

    it('a signed-in person who starts on the feed (no login page ever seen) is read directly', async () => {
      const { runner, log, adv } = setup();
      runner.start();
      runner.loadEnded(FEED);
      await adv(INJECT_DELAY_MS + 10);
      expect(log.injects).toHaveLength(1);
      expect(log.loads).toEqual([LOGIN]); // no navigation of our own: `direct`
    });

    it('anonymous try that fails falls back to the login page', async () => {
      const { runner, log, adv } = setup({ handle: 'jane.doe', fetchImpl: (() => Promise.reject(new Error('net'))) as any });
      runner.start();
      await adv(50);
      expect(log.loads).toEqual([LOGIN]);
      expect(log.statuses).toEqual(['anon', 'login']);
    });
  });

  describe('SPA navigation events from the feed', () => {
    it('the same url reported by navigation + load events injects once', async () => {
      const { runner, log, adv } = await onFeed();
      runner.navigated(FEED, false);
      runner.loadEnded(FEED);
      runner.navigated(FEED, false);
      await adv(1000);
      expect(log.injects).toHaveLength(1);
    });

    it('a reload (a new document load of the same url) after the script ran is read again', async () => {
      const { runner, log, adv } = await onFeed();
      await adv(3000);
      runner.loadEnded(FEED);
      await adv(INJECT_DELAY_MS + 10);
      expect(log.injects).toHaveLength(2);
    });

    it('a burst of distinct SPA urls (every 300 ms for 10 s) is debounced and the run still ends', async () => {
      const { runner, log, adv, pending } = await onFeed();
      for (let i = 0; i < 33; i++) {
        runner.navigated(`${FEED}?i=${i}`, false);
        await adv(300);
      }
      await adv(120_000);
      expect(log.injects.length).toBeLessThanOrEqual(MAX_INJECTIONS);
      expect(log.closes).toEqual([AUTO_READ_FAILED]);
      expect(log.results).toHaveLength(0);
      expect(pending()).toBe(0);
    });

    it('SPA events every 2 s for a minute against a silent reader: at most MAX_INJECTIONS injections, then a clean failure', async () => {
      const { runner, log, adv, pending } = await onFeed();
      for (let i = 0; i < 30; i++) {
        runner.navigated(`${FEED}?i=${i}`, false);
        await adv(2000);
      }
      await adv(120_000);
      expect(log.injects.length).toBeLessThanOrEqual(MAX_INJECTIONS);
      expect(log.closes).toEqual([AUTO_READ_FAILED]);
      expect(pending()).toBe(0);
    });

    it('the feed firing navigation events while the reader works does not break the read', async () => {
      const { runner, log, adv } = await onFeed();
      for (let i = 0; i < 5; i++) {
        runner.navigated(`${FEED}?i=${i}`, false);
        await adv(700);
      }
      runner.message(msg('ok', okData));
      await adv(10);
      expect(log.results).toHaveLength(1);
      expect(log.closes).toHaveLength(0);
    });

    it('SPA events for non-instagram pages are ignored', async () => {
      const { runner, log, adv } = setup();
      runner.start();
      for (const u of ['https://instagram.com.evil.com/', 'https://evilinstagram.com/', 'about:blank', 'javascript:alert(1)'])
        runner.navigated(u, false);
      await adv(5000);
      expect(log.injects).toHaveLength(0);
    });
  });

  describe('signed_out', () => {
    it('signed_out while on the feed goes back to waiting for the sign-in and does not end the run', async () => {
      const { runner, log, adv, pending } = await onFeed();
      runner.message(msg('signed_out'));
      await adv(10);
      expect(log.statuses[log.statuses.length - 1]).toBe('login');
      expect(log.results).toHaveLength(0);
      expect(log.closes).toHaveLength(0);
      expect(pending()).toBe(0); // waiting for the person: no timer, no busy loop
      await adv(600_000);
      expect(log.closes).toHaveLength(0);
    });

    it('after signed_out, signing in (feed again) reads again', async () => {
      const { runner, log, adv } = await onFeed();
      runner.message(msg('signed_out'));
      runner.navigated(LOGIN, false);
      runner.navigated(FEED + '?next=1', false);
      await adv(INJECT_DELAY_MS + 10);
      expect(log.injects).toHaveLength(2);
      runner.message(msg('ok', okData));
      await adv(10);
      expect(log.results).toHaveLength(1);
    });

    it('a signed_out that keeps coming with every feed event stays bounded (no infinite loop)', async () => {
      const { runner, log, adv } = await onFeed();
      for (let i = 0; i < 50; i++) {
        runner.message(msg('signed_out'));
        runner.navigated(`${FEED}?i=${i}`, false);
        await adv(INJECT_DELAY_MS + 10);
      }
      expect(log.injects.length).toBeLessThanOrEqual(MAX_INJECTIONS);
    });

    it.failing('BUG: the injection budget is spent by earlier signed_out cycles, so the real sign-in afterwards is never read', async () => {
      // runner.ts `injections` is never reset when the run goes back to `login`; after 8 signed_out cycles the
      // person finally signs in, the feed event arrives and `scheduleInject` returns on `injections >= MAX_INJECTIONS`.
      // Fix: reset `this.injections = 0` in `toLogin()`.
      const { runner, log, adv } = await onFeed();
      for (let i = 0; i < MAX_INJECTIONS; i++) {
        runner.message(msg('signed_out'));
        runner.navigated(`${FEED}?i=${i}`, false);
        await adv(INJECT_DELAY_MS + 10);
      }
      const before = log.injects.length;
      runner.message(msg('signed_out'));
      runner.navigated(`${FEED}?signedin`, false);
      await adv(INJECT_DELAY_MS + 10);
      expect(log.injects.length).toBe(before + 1);
    });

    it('the page turning into a login screen while reading goes back to login', async () => {
      const { runner, log, adv } = await onFeed();
      runner.navigated('https://www.instagram.com/accounts/login/?next=/', false);
      await adv(10);
      expect(log.statuses[log.statuses.length - 1]).toBe('login');
    });
  });

  describe('empty with / without a username', () => {
    it('empty with username -> opens the profile and captures it, then reads the screenshot', async () => {
      const { runner, log, adv } = await onFeed();
      runner.message(msg('empty', { username: 'jane.doe', diag: { a: 400 } }));
      await adv(10);
      expect(log.loads).toEqual([LOGIN, PROFILE]);
      runner.navigated(PROFILE, false);
      await adv(SETTLE_MS + 10);
      expect(log.captures).toBe(1);
      expect(log.results).toHaveLength(1);
      expect(log.results[0]).toMatchObject({ source: 'device', followers: 100 });
      expect(log.statuses).toEqual(expect.arrayContaining(['capturing', 'claude']));
      expect(log.closes).toHaveLength(0);
    });

    it('ok with a username but no numbers behaves like empty with username', async () => {
      const { runner, log, adv } = await onFeed();
      runner.message(msg('ok', { user: { username: 'jane.doe' } }));
      await adv(10);
      expect(log.loads).toEqual([LOGIN, PROFILE]);
    });

    it('the profile never reports a page event: captures anyway after the fallback load timeout', async () => {
      const { runner, log, adv } = await onFeed();
      runner.message(msg('empty', { username: 'jane.doe' }));
      await adv(FALLBACK_LOAD_MS + 100);
      expect(log.captures).toBe(1);
      expect(log.results).toHaveLength(1);
    });

    it('a late event for the feed we just left (inside the stale window) does not trigger a capture', async () => {
      const { runner, log, adv } = await onFeed();
      runner.message(msg('empty', { username: 'jane.doe' }));
      await adv(100);
      runner.navigated(FEED, false);
      await adv(SETTLE_MS + 500);
      expect(log.captures).toBe(0);
      void STALE_PAGE_MS;
    });

    it.failing('BUG: a feed SPA event AFTER the stale window and before the profile loaded makes it screenshot the feed', async () => {
      // runner.ts onPage(), `fallback` branch: any instagram.com page event arms the capture, not only the fallback
      // target's. A slow profile load + one more feed event (different url, e.g. ?variant=) => the feed is captured.
      // Fix: remember `this.fallbackTarget` in stepEmpty and in the fallback branch return unless the event's path equals it.
      const { runner, log, adv } = await onFeed();
      runner.message(msg('empty', { username: 'jane.doe' }));
      await adv(STALE_PAGE_MS + 500);
      runner.navigated(`${FEED}?variant=2`, false);
      await adv(SETTLE_MS + 500);
      expect(log.captures).toBe(0); // profile has not loaded yet; it must not capture
    });

    it('already on the profile page: captures after 300 ms without navigating', async () => {
      const { runner, log, adv } = setup();
      runner.start();
      runner.navigated(PROFILE, false);
      await adv(INJECT_DELAY_MS + 10);
      runner.message(msg('empty', { username: 'Jane.Doe' })); // case differs
      await adv(400);
      expect(log.loads).toEqual([LOGIN]);
      expect(log.captures).toBe(1);
    });

    it('empty WITHOUT a username -> fails cleanly, not stuck in reading, nothing navigated or captured', async () => {
      const { runner, log, adv, pending } = await onFeed();
      runner.message(msg('empty', { diag: { a: 400, uid: true } }));
      await adv(10);
      expect(log.closes).toEqual([AUTO_READ_FAILED]);
      expect(log.results).toHaveLength(0);
      expect(log.loads).toEqual([LOGIN]);
      expect(log.captures).toBe(0);
      expect(log.cleared).toBe(1);
      expect(pending()).toBe(0);
    });

    it('empty with no data at all, and error, both fail cleanly', async () => {
      for (const m of [msg('empty'), msg('error')]) {
        const { runner, log, adv } = await onFeed();
        runner.message(m);
        await adv(10);
        expect(log.closes).toEqual([AUTO_READ_FAILED]);
      }
    });

    it('an invalid username hint (path tricks) never navigates', async () => {
      for (const bad of ['../x', 'a b', 'a/b', '', 'x'.repeat(31), '?q=1', 'jane/../../evil']) {
        const { runner, log, adv } = await onFeed();
        runner.message(msg('empty', { username: bad }));
        await adv(10);
        expect(log.loads).toEqual([LOGIN]);
        expect(log.closes).toEqual([AUTO_READ_FAILED]);
      }
    });

    it('capture failing, the screenshot call failing, or finding no numbers all end with the failure reason', async () => {
      const variants: Array<Partial<RunnerDeps>> = [
        { capture: async () => Promise.reject(new Error('x')) },
        { readScreenshot: async () => Promise.reject(new Error('x')) },
        { readScreenshot: async () => shot({ followers: null }) as any },
        { readScreenshot: async () => null as any },
      ];
      for (const v of variants) {
        const { runner, log, adv } = await onFeed(v);
        runner.message(msg('empty', { username: 'jane.doe' }));
        runner.navigated(PROFILE, false);
        await adv(SETTLE_MS + 50);
        expect(log.closes).toEqual([AUTO_READ_FAILED]);
        expect(log.results).toHaveLength(0);
      }
    });
  });

  describe('timeouts', () => {
    it('a reader that never answers ends with the failure reason after the read timeout', async () => {
      const { runner, log, adv, pending } = await onFeed();
      await adv(READ_TIMEOUT_MS - 100);
      expect(log.closes).toHaveLength(0);
      await adv(200);
      expect(log.closes).toEqual([AUTO_READ_FAILED]);
      expect(pending()).toBe(0);
      expect(runner).toBeDefined();
    });

    it('the person sitting on the login page forever is not timed out and nothing busy-loops', async () => {
      const { runner, log, adv, pending } = setup();
      runner.start();
      runner.navigated(LOGIN, false);
      await adv(3_600_000);
      expect(log.closes).toHaveLength(0);
      expect(log.results).toHaveLength(0);
      expect(pending()).toBe(0);
    });

    it('the login page failing to load (offline) ends the run; a stray subresource failure does not', async () => {
      const a = setup();
      a.runner.start();
      a.runner.loadFailed('https://www.instagram.com/static/x.js');
      await a.adv(10);
      expect(a.log.closes).toHaveLength(0);
      a.runner.loadFailed(LOGIN);
      await a.adv(10);
      expect(a.log.closes).toEqual([AUTO_READ_FAILED]);
    });

    it('the stats page failing to load while reading ends the run', async () => {
      const { runner, log, adv } = await onFeed();
      runner.loadFailed(FEED);
      await adv(10);
      expect(log.closes).toEqual([AUTO_READ_FAILED]);
    });
  });

  describe('robustness', () => {
    it('ignores messages that are not ours: bad JSON, other platform, other step, oversized, wrong shape', async () => {
      const { runner, log, adv } = await onFeed();
      runner.message('not json');
      runner.message(42);
      runner.message(msg('ok', okData, { platform: 'reddit' }));
      runner.message(msg('ok', okData, { step: 1 }));
      runner.message(msg('ok', okData, { pulse: 'other' }));
      runner.message(msg('weird'));
      runner.message(JSON.stringify({ pulse: 'autoRead', platform: 'instagram', step: 0, status: 'ok', data: 'x'.repeat(400_001) }));
      await adv(10);
      expect(log.results).toHaveLength(0);
      expect(log.closes).toHaveLength(0);
    });

    it('a message before any injection (phase login) is ignored', () => {
      const { runner, log } = setup();
      runner.start();
      runner.message(msg('ok', okData));
      expect(log.results).toHaveLength(0);
    });

    it('cancel emits close without a reason, once, and later results are dropped', async () => {
      const { runner, log, adv } = await onFeed();
      runner.cancel();
      runner.message(msg('ok', okData));
      await adv(20_000);
      expect(log.closes).toEqual([undefined]);
      expect(log.results).toHaveLength(0);
    });

    it('dispose silences everything', async () => {
      const { runner, log, adv, pending } = await onFeed();
      runner.dispose();
      runner.message(msg('ok', okData));
      await adv(60_000);
      expect(log.results).toHaveLength(0);
      expect(log.closes).toHaveLength(0);
      expect(pending()).toBe(0);
    });

    it('clearSession rejecting still reports the result', async () => {
      const { runner, log, adv } = await onFeed({ clearSession: () => Promise.reject(new Error('x')) });
      runner.message(msg('ok', okData));
      await adv(10);
      expect(log.results).toHaveLength(1);
    });

    it('inject throwing inside a timer ends the run with the failure reason instead of throwing', async () => {
      const s = setup({
        inject: () => {
          throw new Error('webview gone');
        },
      });
      s.runner.start();
      s.runner.navigated(FEED, false);
      await expect(s.adv(INJECT_DELAY_MS + 10)).resolves.toBeUndefined();
      expect(s.log.closes).toEqual([AUTO_READ_FAILED]);
    });
  });
});
