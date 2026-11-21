/**
 * A login typed on the sign-in sheet (vault/capture.ts) must never reach the trace (POST /api/autoread/trace), the
 * console, the runner, the href poll or the remote phone browser. The capture script runs for real in jsdom; its message
 * goes through the sheet's router next to a real runner wired to a real tracer. Obvious fakes only.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'android', Version: 34 } }));
jest.mock('@/src/http', () => ({ request: jest.fn(() => Promise.resolve({})) }));

import fs from 'fs';
import path from 'path';

import { request } from '@/src/http';
import { buildCaptureScript } from '@/src/vault/capture';
import { AutoReadRunner } from '../runner';
import { makeTracer } from '../trace';
import { routeSheetMessage, type SheetMessageHandlers } from '../vaultOffer';
import { makeEnv, page } from './igHarness';

const mockRequest = request as unknown as jest.Mock;
const USER = 'jane.fake@example.com';
const PASS = 'hunter2-fake-Zq9';
const LOGIN = 'https://www.instagram.com/accounts/login/';

/** Types the fake login into a jsdom Instagram login page with the capture script, taps Log in, returns what it posted. */
function typedAndPosted(pass = PASS): string[] {
  const env = makeEnv({
    url: LOGIN,
    html: page(
      '<form id="f"><input name="username"><input type="password" name="password"><button type="submit">Log in</button></form>',
    ),
  });
  const doc = env.dom.window.document;
  doc.getElementById('f')!.addEventListener('submit', (e) => e.preventDefault());
  env.inject(buildCaptureScript('instagram'));
  (doc.querySelector('input[name="username"]') as HTMLInputElement).value = USER;
  (doc.querySelector('input[type="password"]') as HTMLInputElement).value = pass;
  (doc.querySelector('button') as HTMLButtonElement).click();
  return env.rawPosted;
}

function wiredSheet() {
  const tr = makeTracer('instagram');
  const runner = new AutoReadRunner({
    platform: 'instagram',
    trace: tr.trace,
    loadUrl: () => {},
    inject: () => {},
    capture: async () => 'b64',
    readScreenshot: async () => {
      throw new Error('no');
    },
    emitResult: () => {},
    emitClose: () => {},
    onStatus: () => {},
  });
  runner.start();
  runner.loadEnded(LOGIN);
  const got = { captures: [] as unknown[], runner: [] as string[], href: [] as string[], fill: [] as unknown[] };
  const h: SheetMessageHandlers = {
    capture: (m, src) => void got.captures.push({ ...m, src }),
    fill: (f) => void got.fill.push(f),
    href: (u) => {
      got.href.push(u);
      runner.navigated(u, false);
    },
    runner: (r) => {
      got.runner.push(r);
      runner.message(r);
    },
  };
  return { tr, runner, h, got };
}

let logs: string[] = [];
beforeEach(() => {
  mockRequest.mockClear();
  logs = [];
  for (const k of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    jest.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  }
});
afterEach(() => jest.restoreAllMocks());

const everythingSent = () => JSON.stringify(mockRequest.mock.calls);

describe('a captured login never leaves the capture path', () => {
  it('the real capture message goes to the capture handler only, never the runner, tracer or console', () => {
    const posted = typedAndPosted();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(PASS); // the message does carry it, so the routing below is what keeps it in
    const { tr, runner, h, got } = wiredSheet();
    for (const m of posted) routeSheetMessage(m, 'https://www.instagram.com', h);
    runner.loadEnded('https://www.instagram.com/accounts/login/');
    tr.stop();
    expect(got.captures).toEqual([{ platform: 'instagram', u: USER, p: PASS, src: 'https://www.instagram.com' }]);
    expect(got.runner).toEqual([]);
    expect(got.href).toEqual([]);
    expect(got.fill).toEqual([]);
    expect(mockRequest).toHaveBeenCalled(); // the trace did post (start, page events) ...
    expect(everythingSent()).not.toContain(PASS); // ... but never the password
    expect(everythingSent()).not.toContain(USER);
    expect(logs.join('\n')).not.toContain(PASS);
    runner.dispose();
  });

  it('a malformed or oversized capture is swallowed, not passed on', () => {
    const { tr, runner, h, got } = wiredSheet();
    const junk = [
      `{"pulse":"vaultCapture","platform":"instagram","u":"${USER}","p":"${PASS}"`, // cut off
      JSON.stringify({ pulse: 'vaultCapture', platform: 'instagram', u: USER, p: PASS + 'x'.repeat(600) }),
      JSON.stringify({ pulse: 'vaultCapture', platform: 'myspace', u: USER, p: PASS }),
      `vaultCapture ${PASS}`,
    ];
    for (const m of junk) routeSheetMessage(m, 'https://www.instagram.com', h);
    tr.stop();
    expect(got).toEqual({ captures: [], runner: [], href: [], fill: [] });
    expect(everythingSent()).not.toContain(PASS);
    expect(logs.join('\n')).not.toContain(PASS);
    runner.dispose();
  });

  it('a password that looks like another message is still a capture', () => {
    for (const p of ['__pulseHref', '{"pulse":"vaultFill","status":"filled"}', '{"pulse":"autoRead"}']) {
      const posted = typedAndPosted(p);
      const { tr, runner, h, got } = wiredSheet();
      routeSheetMessage(posted[0], 'https://www.instagram.com', h);
      tr.stop();
      expect(got.captures).toHaveLength(1);
      expect(got.runner).toEqual([]);
      expect(got.href).toEqual([]);
      expect(got.fill).toEqual([]);
      runner.dispose();
    }
  });

  it('other messages are routed as before', () => {
    const { tr, runner, h, got } = wiredSheet();
    routeSheetMessage(JSON.stringify({ pulse: 'vaultFill', platform: 'instagram', status: 'filled' }), null, h);
    routeSheetMessage(JSON.stringify({ __pulseHref: LOGIN }), null, h);
    routeSheetMessage(JSON.stringify({ pulse: 'autoRead', platform: 'instagram', step: 0, status: 'empty' }), null, h);
    routeSheetMessage(42, null, h);
    tr.stop();
    expect(got.fill).toEqual([{ platform: 'instagram', status: 'filled' }]);
    expect(got.href).toEqual([LOGIN]);
    expect(got.runner).toHaveLength(1);
    runner.dispose();
  });
});

describe('where the capture can run (source)', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const walk = (dir: string): string[] =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => {
      const rel = path.join(dir, d.name);
      if (d.isDirectory()) return d.name === '__tests__' ? [] : walk(rel);
      return /\.tsx?$/.test(d.name) ? [rel] : [];
    });

  it('only the sign-in sheet injects the capture script or handles its message', () => {
    const users = [...walk('src'), ...walk('app')].filter((f) => {
      const src = read(f);
      return /buildCaptureScript|makeCaptureHolder|routeSheetMessage/.test(src) && !/vault[\\/]capture\.ts$/.test(f);
    });
    expect(users.sort()).toEqual([path.join('src', 'autoRead', 'index.tsx'), path.join('src', 'autoRead', 'vaultOffer.ts')].sort());
  });

  it("Claude's remote phone browser never touches the vault or the capture", () => {
    for (const f of [...walk('src/browserControl'), 'app/browser.tsx']) {
      expect(read(f)).not.toMatch(/@\/src\/vault|vaultCapture|buildCaptureScript|fillScriptFor/);
    }
  });

  it('the background refresh never fills, captures or saves a login', () => {
    expect(read('src/autoRead/refresh.tsx')).not.toMatch(/@\/src\/vault|fillScriptFor|buildCaptureScript|saveLogin/);
  });

  it('the sheet gives the router the native message source and has no approval bar', () => {
    const sheet = read('src/autoRead/index.tsx');
    expect(sheet).toMatch(/onMessage\(e\.nativeEvent\.data, e\.nativeEvent\.url\)/);
    expect(sheet).not.toMatch(/Sign in with your saved/);
    expect(sheet).not.toMatch(/console\./);
  });
});
