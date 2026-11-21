/**
 * The runner's console lines (visible in `adb logcat -s ReactNativeJS`) go through `scrub` from trace.ts: a page message
 * is page-controlled, so neither a non-ok message nor an ok message's `diag` may put a token, cookie or page text there.
 * Everything below is an obvious fake.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'android', Version: 34 } }));
jest.mock('@/src/http', () => ({ request: jest.fn(() => Promise.resolve({})) }));

import { AutoReadRunner, scrubForLog, type RunnerDeps } from '../runner';
import { scrub } from '../trace';

const FEED = 'https://www.instagram.com/';
const SECRET = 'sessionid=FAKE-abcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJl';

const msg = (status: string, data?: unknown) =>
  JSON.stringify({ pulse: 'autoRead', platform: 'instagram', step: 0, status, ...(data === undefined ? {} : { data }) });

function runner(): AutoReadRunner {
  const deps: RunnerDeps = {
    platform: 'instagram',
    loadUrl: () => {},
    inject: () => {},
    capture: async () => 'b64',
    readScreenshot: async () => ({}) as never,
    emitResult: () => {},
    emitClose: () => {},
    onStatus: () => {},
    now: () => 1_000_000,
    setTimer: () => 1,
    clearTimer: () => {},
  };
  const r = new AutoReadRunner(deps);
  r.start();
  r.navigated(FEED, false); // a page past the login one: the runner starts reading step 0
  return r;
}

let logSpy: jest.SpyInstance;
beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

const logged = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

describe('runner console lines are scrubbed', () => {
  it('scrubForLog is trace.scrub', () => {
    const v = { diag: { a: 429, csrf: true, cookie: SECRET, path: '/jane.doe/' }, text: 'page text' };
    expect(scrubForLog(v, 'data')).toEqual(scrub(v, 'data'));
  });

  it('a non-ok message logs only scrubbed fields, never the raw message', () => {
    const r = runner();
    logSpy.mockClear();
    r.message(msg('error', { diag: { a: 429, c: 0, token: TOKEN, note: SECRET }, username: 'jane.doe', html: '<b>x</b>' }));
    const out = logged();
    expect(out).toContain('[autoRead] instagram step 0 error');
    expect(out).toContain('"a":429');
    for (const leak of [TOKEN, SECRET, 'FAKE-abc', 'jane.doe', '<b>x</b>', 'pulse']) expect(out).not.toContain(leak);
  });

  it("an ok message's diag is scrubbed too", () => {
    const r = runner();
    logSpy.mockClear();
    r.message(
      msg('ok', {
        user: { username: 'jane.doe', edge_followed_by: { count: 100 } },
        diag: { a: 200, b: 429, csrf: true, src: 'page', cookie: SECRET, extra: TOKEN },
      }),
    );
    const out = logged();
    expect(out).toContain('[autoRead] instagram step 0 ok');
    expect(out).toContain('"b":429');
    expect(out).toContain('"src":"page"');
    for (const leak of [TOKEN, SECRET, 'FAKE-abc', 'jane.doe']) expect(out).not.toContain(leak);
  });

  it('without trace.ts (plain Node) only numbers and yes/no are logged', () => {
    jest.isolateModules(() => {
      jest.doMock('../trace', () => {
        throw new Error('react-native is not here');
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { scrubForLog: bare } = require('../runner') as typeof import('../runner');
      const out = bare({ diag: { a: 429, csrf: true, code: 123456, cookie: SECRET, path: '/x/', t: TOKEN }, n: [1, 'x'] }, 'data');
      expect(out).toEqual({ diag: { a: 429, csrf: true }, n: [1, null] });
    });
  });
});
