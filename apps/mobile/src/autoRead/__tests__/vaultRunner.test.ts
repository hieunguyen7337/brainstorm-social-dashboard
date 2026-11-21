import { AutoReadRunner, FILL_QUIET_MS, type RunnerDeps, type RunnerStatus } from '../runner';
import { FALLBACK_LOAD_MS, INJECT_DELAY_MS, SETTLE_MS } from '../config';
import { type DeviceRead } from '../types';
import { offerVaultFill } from '../vaultOffer';

const FEED = 'https://www.instagram.com/';
const LOGIN = 'https://www.instagram.com/accounts/login/';
const PROFILE = 'https://www.instagram.com/jane.doe/';
const CHALLENGE = 'https://www.instagram.com/challenge/abc/';

const flush = () => new Promise<void>((r) => setImmediate(r));

const msg = (status: string, data?: unknown) =>
  JSON.stringify({ pulse: 'autoRead', platform: 'instagram', step: 0, status, ...(data === undefined ? {} : { data }) });

function setup(over: Partial<RunnerDeps> = {}) {
  let now = 1_000_000;
  let seq = 0;
  let timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const log = {
    results: [] as DeviceRead[],
    closes: [] as Array<string | undefined>,
    statuses: [] as RunnerStatus[],
    signIn: [] as string[],
    captures: 0,
  };
  const deps: RunnerDeps = {
    platform: 'instagram',
    loadUrl: () => {},
    inject: () => {},
    capture: async () => {
      log.captures += 1;
      return 'b64';
    },
    readScreenshot: async () => {
      throw new Error('no');
    },
    emitResult: (r) => void log.results.push(r),
    emitClose: (reason) => void log.closes.push(reason),
    onStatus: (s) => void log.statuses.push(s),
    onSignInPage: (u) => void log.signIn.push(u),
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

async function toFallback(s: ReturnType<typeof setup>) {
  s.runner.navigated(FEED, false);
  await s.adv(INJECT_DELAY_MS + 10);
  s.runner.message(msg('empty', { username: 'jane.doe' }));
  await s.adv(0);
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const last = <T>(a: T[]) => a[a.length - 1];

describe('onSignInPage', () => {
  it('fires for the login page, not for a page past login', () => {
    const { runner, log } = setup();
    runner.start();
    runner.loadEnded(LOGIN);
    expect(log.signIn).toEqual([LOGIN]);
    runner.loadEnded(FEED);
    expect(log.signIn).toEqual([LOGIN]);
    expect(last(log.statuses)).toBe('reading');
  });

  it('fires for a challenge page too, but no fill is offered for it', () => {
    const { runner, log } = setup();
    runner.start();
    runner.loadEnded(CHALLENGE);
    expect(log.signIn).toEqual([CHALLENGE]);
    expect(
      offerVaultFill('instagram', { status: 'login', hasLogin: true, url: CHALLENGE, attempts: 0, dismissed: false }),
    ).toBe(false);
  });

  it('fires again when a read falls back to login', async () => {
    const { runner, log, adv } = setup();
    runner.start();
    runner.navigated(FEED, false);
    await adv(INJECT_DELAY_MS + 10);
    runner.navigated(LOGIN, false);
    expect(last(log.statuses)).toBe('login');
    expect(last(log.signIn)).toBe(LOGIN);
  });

  it('a throwing callback does not end the run', async () => {
    const { runner, log, adv } = setup({
      onSignInPage: () => {
        throw new Error('boom');
      },
    });
    runner.start();
    runner.loadEnded(LOGIN);
    runner.navigated(FEED, false);
    await adv(INJECT_DELAY_MS + 10);
    expect(log.closes).toHaveLength(0);
    expect(last(log.statuses)).toBe('reading');
  });
});

describe('capture and vault fills', () => {
  it('never captures a login form', async () => {
    const s = setup();
    s.runner.start();
    await toFallback(s);
    s.runner.navigated(LOGIN, true);
    await s.adv(FALLBACK_LOAD_MS + 10);
    expect(s.log.captures).toBe(0);
    expect(last(s.log.statuses)).toBe('login');
    expect(s.log.closes).toHaveLength(0);
  });

  it('a fill just before the fallback delays the capture', async () => {
    const s = setup();
    s.runner.start();
    s.runner.loadEnded(LOGIN);
    s.runner.noteVaultFill();
    await toFallback(s);
    s.runner.loadEnded(PROFILE);
    await s.adv(SETTLE_MS + 10);
    expect(s.log.captures).toBe(0);
    await s.adv(FILL_QUIET_MS);
    expect(s.log.captures).toBe(1);
  });

  it('a fill 11 s earlier does not delay the capture', async () => {
    const s = setup();
    s.runner.start();
    s.runner.loadEnded(LOGIN);
    s.runner.noteVaultFill();
    s.runner.navigated(FEED, false);
    await s.adv(11_000);
    s.runner.message(msg('empty', { username: 'jane.doe' }));
    await s.adv(0);
    s.runner.loadEnded(PROFILE);
    await s.adv(SETTLE_MS + 10);
    expect(s.log.captures).toBe(1);
  });
});

describe('offerVaultFill', () => {
  const base = { status: 'login' as RunnerStatus, hasLogin: true, url: LOGIN as string | null, attempts: 0, dismissed: false };
  it('is true on the login form', () => {
    expect(offerVaultFill('instagram', base)).toBe(true);
  });
  it.each([
    ['status is not login', { status: 'reading' as RunnerStatus }],
    ['no saved login', { hasLogin: false }],
    ['attempts used up', { attempts: 2 }],
    ['dismissed', { dismissed: true }],
    ['two factor page', { url: 'https://www.instagram.com/accounts/login/two_factor' }],
    ['http url', { url: 'http://www.instagram.com/accounts/login/' }],
    ['look-alike host', { url: 'https://www.instagram.com.evil.com/accounts/login/' }],
    ['no url', { url: null }],
  ])('is false when %s', (_n, over) => {
    expect(offerVaultFill('instagram', { ...base, ...over })).toBe(false);
  });
});
