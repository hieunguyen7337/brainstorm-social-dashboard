/**
 * Save-on-sign-in (vault/capture.ts): which messages count as a capture, which page states save / drop / wait, and the
 * in-memory holder that only ever hands a login to `save` after a native-verified sign-in worked. Obvious fakes only.
 */
jest.mock('../native', () => ({ loadSecureStore: () => null }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { parsePageUrl } from '../../autoRead/platforms';
import {
  CAPTURE_HOLD_MS,
  CAPTURE_MAX_FIELD,
  FILL_GUARD_MS,
  captureOriginOk,
  classifyCapture,
  makeCaptureHolder,
  signInOutcome,
  type CaptureMessage,
} from '../capture';
import { MAX_FIELD } from '../index';

const U = 'jane.fake@example.com';
const P = 'hunter2-fake';
const IG_LOGIN = 'https://www.instagram.com/accounts/login/';
const IG_ORIGIN = 'https://www.instagram.com';
const LI_LOGIN = 'https://www.linkedin.com/login';
const raw = (o: Record<string, unknown>) => JSON.stringify(o);
const cap = (platform = 'instagram', u = U, p = P) => raw({ pulse: 'vaultCapture', platform, u, p });

describe('classifyCapture', () => {
  it('takes a well-formed capture', () => {
    expect(classifyCapture(cap())).toEqual({ kind: 'capture', msg: { platform: 'instagram', u: U, p: P } });
  });

  it.each([
    ['not JSON', `vaultCapture ${P}`],
    ['unknown platform', cap('myspace')],
    ['prototype key as platform', cap('__proto__')],
    ['empty password', cap('instagram', U, '')],
    ['blank username', cap('instagram', '   ', P)],
    ['password over the cap', cap('instagram', U, 'x'.repeat(513))],
    ['oversized message', cap('instagram', U, P) + ' '.repeat(7_000)],
    ['numbers instead of strings', raw({ pulse: 'vaultCapture', platform: 'instagram', u: 1, p: 2 })],
    ['no pulse key but names the tag', raw({ vaultCapture: true, p: P })],
    ['an array', `["vaultCapture","${P}"]`],
  ])('swallows %s as junk (never passed on)', (_why, m) => {
    expect(classifyCapture(m).kind).toBe('junk');
  });

  it.each([
    ['a reader message', raw({ pulse: 'autoRead', platform: 'instagram', step: 0, status: 'ok', data: {} })],
    ['a fill status', raw({ pulse: 'vaultFill', platform: 'instagram', status: 'filled' })],
    ['an href poll answer', raw({ __pulseHref: IG_LOGIN })],
    ['a reader message whose page text names the tag', raw({ pulse: 'autoRead', platform: 'x', step: 0, status: 'ok', data: { t: 'vaultCapture' } })],
    ['not a string', 42],
  ])('leaves %s alone', (_why, m) => {
    expect(classifyCapture(m).kind).toBe('none');
  });

  it('caps fields like the vault does', () => {
    expect(CAPTURE_MAX_FIELD).toBe(MAX_FIELD);
  });
});

describe('captureOriginOk (the message came from the platform itself, not an iframe)', () => {
  it.each([
    ['instagram', IG_ORIGIN, true],
    ['instagram', IG_LOGIN, true],
    ['x', 'https://twitter.com', true],
    ['instagram', 'https://ads.example', false],
    ['instagram', 'https://instagram.com.evil.example', false],
    ['instagram', 'http://www.instagram.com', false],
    ['instagram', 'https://www.linkedin.com', false],
    ['instagram', null, false],
    ['instagram', '', false],
  ] as const)('%s from %s: %s', (platform, src, ok) => {
    expect(captureOriginOk(platform, src)).toBe(ok);
  });
});

describe('signInOutcome', () => {
  const ig = parsePageUrl(IG_LOGIN)!;
  const li = parsePageUrl(LI_LOGIN)!;
  const x = parsePageUrl('https://x.com/i/flow/login')!;
  it.each([
    ['instagram', ig, 'https://www.instagram.com/', 'change', false, 'success'],
    ['instagram', ig, 'https://www.instagram.com/accounts/onetap/?next=%2F', 'end', true, 'success'],
    ['instagram', ig, 'https://www.instagram.com/accounts/login/two_factor?next=%2F', 'end', true, 'hold'],
    ['instagram', ig, 'https://www.instagram.com/challenge/abc/', 'end', true, 'hold'],
    ['instagram', ig, 'https://www.instagram.com/accounts/login/', 'change', false, 'hold'],
    ['instagram', ig, 'https://www.instagram.com/accounts/login/', 'end', true, 'failed'],
    ['instagram', ig, 'https://www.instagram.com/accounts/password/reset/', 'end', true, 'failed'],
    ['instagram', ig, 'https://www.facebook.com/login/', 'end', true, 'failed'],
    ['instagram', ig, 'https://www.instagram.com/', 'start', true, 'hold'],
    ['instagram', ig, 'about:blank', 'end', false, 'hold'],
    ['linkedin', li, 'https://www.linkedin.com/feed/', 'end', true, 'success'],
    ['linkedin', li, 'https://www.linkedin.com/checkpoint/lg/login-submit', 'end', true, 'failed'],
    ['linkedin', li, 'https://www.linkedin.com/checkpoint/challenge/AgEfake/', 'end', true, 'hold'],
    ['linkedin', li, 'https://www.linkedin.com/', 'end', true, 'hold'],
    ['x', x, 'https://x.com/home', 'change', false, 'success'],
    ['x', x, 'https://x.com/i/flow/login', 'change', false, 'hold'],
    ['x', x, 'https://x.com/account/access', 'end', true, 'hold'],
    ['facebook', parsePageUrl('https://m.facebook.com/login/')!, 'https://m.facebook.com/login/save-device/', 'end', true, 'success'],
    ['facebook', parsePageUrl('https://m.facebook.com/login/')!, 'https://m.facebook.com/checkpoint/?next', 'end', true, 'hold'],
    ['facebook', parsePageUrl('https://m.facebook.com/login/')!, 'https://m.facebook.com/login/device-based/regular/login/', 'end', true, 'failed'],
  ] as const)('%s: %s -> %s (%s) is %s', (platform, from, url, kind, reloaded, want) => {
    expect(signInOutcome(platform, url, from, kind, reloaded)).toBe(want);
  });
});

function setup(platform: 'instagram' | 'linkedin' = 'instagram') {
  let timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let seq = 0;
  const saves: Array<[string, string]> = [];
  const log = { saved: 0, failed: 0 };
  let saveImpl = async (u: string, p: string) => void saves.push([u, p]);
  const h = makeCaptureHolder({
    platform,
    save: (u, p) => saveImpl(u, p),
    onSaved: () => void (log.saved += 1),
    onSaveFailed: () => void (log.failed += 1),
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  });
  const fire = (ms: number) => {
    const due = timers.filter((t) => t.ms === ms);
    timers = timers.filter((t) => t.ms !== ms);
    due.forEach((t) => t.fn());
  };
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    h,
    saves,
    log,
    fire,
    flush,
    timers: () => timers,
    failSaves: () => {
      saveImpl = async () => {
        throw new Error('keystore');
      };
    },
  };
}

const msg = (over: Partial<CaptureMessage> = {}): CaptureMessage => ({ platform: 'instagram', u: U, p: P, ...over });

describe('the capture holder', () => {
  it('saves once when the sign-in reaches a signed-in page, and holds nothing after', async () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    expect(t.h.offer(msg(), IG_ORIGIN)).toBe(true);
    expect(t.h.holding()).toBe(true);
    t.h.native('https://www.instagram.com/', 'start');
    t.h.native('https://www.instagram.com/', 'end');
    t.h.native('https://www.instagram.com/', 'end');
    await t.flush();
    expect(t.saves).toEqual([[U, P]]);
    expect(t.log.saved).toBe(1);
    expect(t.h.holding()).toBe(false);
    expect(t.timers()).toEqual([]);
  });

  it('saves nothing when the login page comes back (failed sign-in)', async () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.offer(msg(), IG_ORIGIN);
    t.h.native(IG_LOGIN, 'start');
    t.h.native(IG_LOGIN, 'end');
    expect(t.h.holding()).toBe(false);
    t.h.native('https://www.instagram.com/', 'end');
    await t.flush();
    expect(t.saves).toEqual([]);
  });

  it('LinkedIn: a wrong password lands on login-submit, which drops the capture', async () => {
    const t = setup('linkedin');
    t.h.native(LI_LOGIN, 'end');
    t.h.offer(msg({ platform: 'linkedin' }), 'https://www.linkedin.com');
    t.h.native('https://www.linkedin.com/checkpoint/lg/login-submit', 'start');
    t.h.native('https://www.linkedin.com/checkpoint/lg/login-submit', 'end');
    t.h.native('https://www.linkedin.com/feed/', 'end');
    await t.flush();
    expect(t.saves).toEqual([]);
  });

  it('waits through a two-factor screen, then saves', async () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.offer(msg(), IG_ORIGIN);
    t.h.native('https://www.instagram.com/accounts/login/two_factor?next=%2F', 'end');
    expect(t.h.holding()).toBe(true);
    t.h.native('https://www.instagram.com/', 'change');
    await t.flush();
    expect(t.saves).toEqual([[U, P]]);
  });

  it('a retyped login replaces the held one (Instagram shows the error in place)', async () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.offer(msg({ p: 'wrong-fake' }), IG_ORIGIN);
    t.h.offer(msg(), IG_ORIGIN);
    t.h.native('https://www.instagram.com/', 'change');
    await t.flush();
    expect(t.saves).toEqual([[U, P]]);
  });

  it('accepts a capture only when the NATIVE url is the login form', () => {
    const t = setup();
    expect(t.h.offer(msg(), IG_ORIGIN)).toBe(false); // no native url yet
    t.h.native('https://www.instagram.com/explore/', 'end');
    expect(t.h.offer(msg(), IG_ORIGIN)).toBe(false);
    t.h.native('https://www.instagram.com/challenge/abc/', 'end');
    expect(t.h.offer(msg(), IG_ORIGIN)).toBe(false);
    // A page-reported href never counts as the native url.
    t.h.pageHref(IG_LOGIN, IG_ORIGIN);
    expect(t.h.offer(msg(), IG_ORIGIN)).toBe(false);
    t.h.native(IG_LOGIN, 'change');
    expect(t.h.offer(msg(), IG_ORIGIN)).toBe(true);
  });

  it("refuses a capture posted by an iframe, another platform's message, or with no native source", () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    expect(t.h.offer(msg(), 'https://ads.example')).toBe(false);
    expect(t.h.offer(msg(), null)).toBe(false);
    expect(t.h.offer(msg({ platform: 'linkedin' }), IG_ORIGIN)).toBe(false);
    expect(t.h.holding()).toBe(false);
  });

  it('lets the page confirm success only from its own origin', async () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.offer(msg(), IG_ORIGIN);
    t.h.pageHref('https://www.instagram.com/', 'https://ads.example');
    expect(t.h.holding()).toBe(true);
    t.h.pageHref('https://www.instagram.com/', IG_ORIGIN);
    await t.flush();
    expect(t.saves).toEqual([[U, P]]);
  });

  it('drops the capture after 2 minutes', async () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.offer(msg(), IG_ORIGIN);
    t.fire(CAPTURE_HOLD_MS);
    expect(t.h.holding()).toBe(false);
    t.h.native('https://www.instagram.com/', 'end');
    await t.flush();
    expect(t.saves).toEqual([]);
  });

  it('drops the capture when the sheet closes, and accepts nothing after', async () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.offer(msg(), IG_ORIGIN);
    t.h.dispose();
    expect(t.h.holding()).toBe(false);
    t.h.native(IG_LOGIN, 'end');
    expect(t.h.offer(msg(), IG_ORIGIN)).toBe(false);
    t.h.native('https://www.instagram.com/', 'end');
    await t.flush();
    expect(t.saves).toEqual([]);
    expect(t.timers()).toEqual([]);
  });

  it('drops the capture when the person leaves for another site', async () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.offer(msg(), IG_ORIGIN);
    t.h.native('https://www.facebook.com/login/', 'end');
    t.h.native('https://www.instagram.com/', 'end');
    await t.flush();
    expect(t.saves).toEqual([]);
  });

  it("ignores the saved-login fill's own submit until the fill reports", async () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.fillStarted();
    expect(t.h.offer(msg(), IG_ORIGIN)).toBe(false);
    t.h.native('https://www.instagram.com/', 'end');
    await t.flush();
    expect(t.saves).toEqual([]);
    t.h.native(IG_LOGIN, 'end');
    t.h.fillEnded();
    expect(t.h.offer(msg(), IG_ORIGIN)).toBe(true);
  });

  it('the fill guard ends by itself', () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.fillStarted();
    t.fire(FILL_GUARD_MS);
    expect(t.h.offer(msg(), IG_ORIGIN)).toBe(true);
  });

  it('a fill starting drops a held capture', () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.offer(msg(), IG_ORIGIN);
    t.h.fillStarted();
    expect(t.h.holding()).toBe(false);
  });

  it('reports a failed save without the values', async () => {
    const t = setup();
    t.failSaves();
    t.h.native(IG_LOGIN, 'end');
    t.h.offer(msg(), IG_ORIGIN);
    t.h.native('https://www.instagram.com/', 'end');
    await t.flush();
    expect(t.log).toEqual({ saved: 0, failed: 1 });
  });

  it('exposes no value: only yes/no', () => {
    const t = setup();
    t.h.native(IG_LOGIN, 'end');
    t.h.offer(msg(), IG_ORIGIN);
    expect(t.h.holding()).toBe(true);
    // Only methods on the object: no field carries the values.
    expect(Object.values(t.h).every((v) => typeof v === 'function')).toBe(true);
    expect(JSON.stringify(t.h)).not.toContain(P);
  });
});
