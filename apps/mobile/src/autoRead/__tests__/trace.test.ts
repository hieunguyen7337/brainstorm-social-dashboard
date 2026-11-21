/**
 * The sign-in trace posts to /api/autoread/trace. Nothing secret may be in what it posts: not a password, a typed value, a
 * one-time code, a cookie, a session/CSRF/bearer token, nor the token inside a reset or challenge page address (docs/VAULT.md).
 * Everything below is an obvious fake.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'android', Version: 34 } }));
jest.mock('@/src/http', () => ({ request: jest.fn(() => Promise.resolve({})) }));

import { request } from '@/src/http';
import { AutoReadRunner, type RunnerDeps } from '../runner';
import { makeTracer, scrub } from '../trace';

const mockRequest = request as unknown as jest.Mock;

/** Everything the tracer posted, as one string. */
function posted(): string {
  return mockRequest.mock.calls.map((c) => JSON.stringify(c[2])).join('\n');
}
function batches(): Array<{ platform: string; run: string; app: Record<string, unknown>; events: Array<Record<string, any>> }> {
  return mockRequest.mock.calls.map((c) => c[2].body);
}

beforeEach(() => {
  mockRequest.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const RESET = '/accounts/password/reset/confirm/MQ/fake-reset-token-0123456789abcdef/';
const CHALLENGE = '/checkpoint/challenge/AgEfake0challenge1token2abcdefghijklmnopqrstuvwxyz0123456789/';

describe('scrub', () => {
  it('keeps what a diagnostic needs', () => {
    expect(
      scrub({ ms: 5, e: 'page', host: 'www.instagram.com', path: '/in/me/', load: true, past: false, diag: { csrf: true, text: false, me: 200, txt: 1234, src: 'page' } }),
    ).toEqual({ ms: 5, e: 'page', host: 'www.instagram.com', path: '/in/me/', load: true, past: false, diag: { csrf: true, text: false, me: 200, txt: 1234, src: 'page' } });
  });

  it('keeps an update id', () => {
    const id = '0f3c9a52-7d1e-4b8a-9c66-2e5d1a7b4c90';
    expect(scrub({ update: id })).toEqual({ update: id });
  });

  it('redacts secret-named fields to a bare yes/no', () => {
    const out = scrub({ password: 'hunter2-fake', otp: 123456, csrf: true, csrftoken: 'hunter2-fake', cookie: 'sessionid=hunter2-fake', code: '123456', nope: null }) as Record<string, unknown>;
    expect(out).toEqual({ password: '[redacted]', otp: '[redacted]', csrf: true, csrftoken: '[redacted]', cookie: '[redacted]', code: '[redacted]', nope: null });
  });

  it('drops free text under unknown keys, and cleans text under known ones', () => {
    const out = scrub({ note: 'hunter2-fake', list: ['hunter2-fake'], status: 'Bearer hunter2-fake', path: '/login?next=/&token=hunter2-fake#x' }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(out.note).toBe('[redacted]');
    expect(out.path).toBe('/login');
  });

  it('masks tokens inside page addresses', () => {
    for (const path of [RESET, CHALLENGE]) {
      const out = (scrub({ path }) as { path: string }).path;
      expect(out).not.toMatch(/fake-reset|fake0challenge/);
      expect(out.startsWith('/accounts/password/reset/confirm/') || out.startsWith('/checkpoint/challenge/')).toBe(true);
    }
  });

  it('bounds depth, width and string length', () => {
    const out = scrub({ e: 'x'.repeat(5000), diag: { a: { b: { c: { d: 'deep' } } } }, many: Array.from({ length: 500 }, (_, i) => i) }) as Record<string, any>;
    expect(out.e.length).toBeLessThanOrEqual(130);
    expect(JSON.stringify(out)).not.toContain('deep');
    expect(out.many.length).toBeLessThanOrEqual(24);
  });
});

describe('the tracer', () => {
  it('posts only scrubbed events, each bounded', () => {
    const tr = makeTracer('instagram');
    tr.trace('form', { password: 'hunter2-fake', otp: '123456' });
    tr.trace('page', { host: 'www.instagram.com', path: RESET });
    tr.trace('big', { path: '/' + 'a/'.repeat(1000), pad: 'word '.repeat(4000) });
    tr.stop();
    const body = posted();
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('123456');
    expect(body).not.toContain('fake-reset-token');
    const [b] = batches();
    expect(b.events).toHaveLength(3);
    for (const e of b.events) expect(JSON.stringify(e).length).toBeLessThanOrEqual(512);
  });
});

// ---- through the real runner: page addresses and reader `diag` ---------------------------------------------------------

function runner(platform: 'instagram' | 'linkedin') {
  const tr = makeTracer(platform);
  let seq = 0;
  const deps: RunnerDeps = {
    platform,
    trace: tr.trace,
    loadUrl: () => {},
    inject: () => {},
    capture: async () => 'b64',
    readScreenshot: async () => ({}) as any,
    emitResult: () => {},
    emitClose: () => {},
    onStatus: () => {},
    clearSession: async () => {},
    setTimer: () => ++seq,
    clearTimer: () => {},
  };
  return { r: new AutoReadRunner(deps), tr };
}

describe('the runner trace', () => {
  it('never carries the token in a reset or challenge page address', () => {
    for (const [platform, url] of [
      ['instagram', `https://www.instagram.com${RESET}?token=hunter2-fake`],
      ['linkedin', `https://www.linkedin.com${CHALLENGE}?pin=123456&session=hunter2-fake`],
    ] as const) {
      mockRequest.mockClear();
      const { r, tr } = runner(platform);
      r.start();
      r.navigated(url, false);
      r.loadEnded(url);
      r.readBeforeClose();
      r.dispose();
      tr.stop();
      const body = posted();
      expect(body).toContain('"page"');
      expect(body).not.toMatch(/fake-reset|fake0challenge|hunter2|123456/);
    }
  });

  it('never forwards what a page puts in a reader message `diag`', () => {
    const { r, tr } = runner('instagram');
    r.start();
    r.navigated('https://www.instagram.com/', false); // signed in: step 0 is entered, reading
    const diag = { path: '/', csrf: true, a: 200, cookie: 'sessionid=hunter2-fake', password: 'hunter2-fake', typed: 'hunter2-fake', pad: 'x'.repeat(50_000) };
    r.message(JSON.stringify({ pulse: 'autoRead', platform: 'instagram', step: 0, status: 'empty', data: { diag } }));
    r.dispose();
    tr.stop();
    const body = posted();
    expect(body).toContain('"msg"');
    expect(body).not.toContain('hunter2');
    expect(body.length).toBeLessThan(5_000);
    const msg = batches().flatMap((b) => b.events).find((e) => e.e === 'msg')!;
    expect(msg.diag.csrf).toBe(true);
    expect(msg.diag.a).toBe(200);
  });
});
