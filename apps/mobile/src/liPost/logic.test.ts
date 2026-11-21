/** Unit tests for src/liPost/logic.ts: `npx jest --ci src/liPost` (see package.json "jest"). No network, no real account. */
import {
  buildLiPostScript,
  LI_FALLBACK_ENDPOINT,
  LI_MAX_CHARS,
  LI_MSG,
  LI_POST_ENDPOINT,
  LI_STATE_PROBE_JS,
  liFailureText,
  liPostUrl,
  liTextProblem,
  liTimeoutFailure,
  parseLiMessage,
  redactSnippet,
} from './logic';

// jest provides these at run time; declared here so a type check needs no @types/jest.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => any;

interface FakeResponse {
  status: number;
  body?: unknown;
  /** Raw body text instead of JSON. */
  raw?: string;
  /** Throw instead of answering (network error). */
  boom?: boolean;
}

/** A fake linkedin.com page: runs an injected script against stubbed window, document, location and fetch. */
function fakePage(opts: { cookie?: string; host?: string; path?: string; responses?: FakeResponse[] }) {
  const msgs: Record<string, any>[] = [];
  const raw: string[] = [];
  const calls: { url: string; init: any }[] = [];
  const responses = [...(opts.responses ?? [])];
  const window: Record<string, any> = {
    ReactNativeWebView: {
      postMessage: (s: string) => {
        raw.push(s);
        msgs.push(JSON.parse(s));
      },
    },
  };
  const document = { cookie: opts.cookie ?? '' };
  const location = { hostname: opts.host ?? 'www.linkedin.com', protocol: 'https:', pathname: opts.path ?? '/feed/' };
  const fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 500 };
    if (r.boom) throw new Error('Network request failed');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (r.raw !== undefined ? r.raw : r.body === undefined ? '' : JSON.stringify(r.body)),
    };
  };
  const run = (script: string) =>
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'location', 'fetch', script)(window, document, location, fetch);
  return { msgs, raw, calls, window, run };
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The JSESSIONID value has quotes around it in the cookie, as LinkedIn sets it. */
const CSRF = 'ajax:1234567890123456789';
const SIGNED_IN = `bcookie="v=2&abc"; JSESSIONID="${CSRF}"; lang=v=2&lang=en-us`;
const URN = 'urn:li:share:7131234567890123456';
const caption = `New drop "today" </script>\nLine two ${String.fromCharCode(0x2028)} and ${String.fromCharCode(0x2029)} \\ #pulse https://pulse.example/r/abc123`;

describe('LI_STATE_PROBE_JS', () => {
  it('reports signed in on www.linkedin.com, with booleans only', () => {
    const page = fakePage({ cookie: SIGNED_IN, path: '/feed/' });
    page.run(LI_STATE_PROBE_JS);
    expect(page.msgs).toEqual([{ t: LI_MSG, kind: 'state', onLi: true, signedIn: true, settled: true }]);
    expect(page.raw.join('')).not.toContain(CSRF);
    expect(page.raw.join('')).not.toContain('1234567890');
  });
  it('reports signed out on LinkedIn sign-in pages and without a JSESSIONID', () => {
    for (const path of ['/login', '/uas/login?session_redirect=x', '/authwall?trk=x', '/checkpoint/challenge/abc']) {
      const page = fakePage({ cookie: SIGNED_IN, path });
      page.run(LI_STATE_PROBE_JS);
      expect(page.msgs[0]).toMatchObject({ onLi: true, signedIn: false, settled: false });
    }
    const none = fakePage({ cookie: 'bcookie="v=2"', path: '/feed/' });
    none.run(LI_STATE_PROBE_JS);
    expect(none.msgs[0]).toMatchObject({ onLi: true, signedIn: false });
  });
  it('is signed in but not settled off www.linkedin.com, and knows when it is not on linkedin.com', () => {
    const m = fakePage({ cookie: SIGNED_IN, host: 'm.linkedin.com' });
    m.run(LI_STATE_PROBE_JS);
    expect(m.msgs[0]).toMatchObject({ onLi: true, signedIn: true, settled: false });
    const evil = fakePage({ cookie: SIGNED_IN, host: 'evil-linkedin.com.example' });
    evil.run(LI_STATE_PROBE_JS);
    expect(evil.msgs[0]).toMatchObject({ onLi: false, signedIn: false, settled: false });
  });
});

describe('buildLiPostScript', () => {
  it('names the endpoint, the headers and the post fields, with the text JSON-escaped', () => {
    const script = buildLiPostScript(caption);
    expect(script).toContain(LI_POST_ENDPOINT);
    expect(script).toContain('/voyager/api/contentcreation/normShares');
    expect(script).toContain("'csrf-token'");
    expect(script).toContain("'x-restli-protocol-version': '2.0.0'");
    expect(script).toContain('application/vnd.linkedin.normalized+json+2.1');
    expect(script).toContain('JSESSIONID');
    // Quotes, newlines and backslashes are escaped inside the embedded JSON; U+2028/2029 never appear raw.
    expect(script).toContain('New drop \\"today\\" </script>\\nLine two \\u2028 and \\u2029 \\\\ #pulse');
    expect(script).not.toContain(String.fromCharCode(0x2028));
    expect(script).not.toContain(String.fromCharCode(0x2029));
    // It is valid JavaScript.
    // eslint-disable-next-line no-new-func
    expect(() => new Function('window', 'document', 'location', 'fetch', script)).not.toThrow();
  });

  it('publishes a public text post with the web app headers and reports the URN', async () => {
    const page = fakePage({ cookie: SIGNED_IN, responses: [{ status: 201, body: { data: { urn: URN }, included: [] } }] });
    page.run(buildLiPostScript(caption));
    await settle();

    expect(page.calls).toHaveLength(1);
    const { url, init } = page.calls[0];
    expect(url).toBe(LI_POST_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers).toMatchObject({
      'csrf-token': CSRF, // the JSESSIONID value, quotes stripped
      'x-restli-protocol-version': '2.0.0',
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'content-type': 'application/json; charset=UTF-8',
    });
    expect(JSON.parse(init.body)).toEqual({
      visibleToConnectionsOnly: false,
      externalAudienceProviders: [],
      commentaryV2: { text: caption, attributes: [] },
      origin: 'FEED',
      allowedCommentersScope: 'ALL',
      postState: 'PUBLISHED',
      media: [],
    });
    expect(page.msgs).toEqual([{ t: LI_MSG, kind: 'result', ok: true, urn: URN, via: 'norm', firstStatus: null }]);
    // Never leaves the page except back to linkedin.com.
    expect(page.raw.join('')).not.toContain(CSRF);
    expect(page.window.__pulseLiPosting).toBe(false);
  });

  it('is a success with no URN when LinkedIn answers 2xx without one', async () => {
    const page = fakePage({ cookie: SIGNED_IN, responses: [{ status: 200, raw: '' }] });
    page.run(buildLiPostScript('hello'));
    await settle();
    expect(page.msgs[0]).toMatchObject({ kind: 'result', ok: true, urn: null, via: 'norm' });
  });

  it('finds an activity URN too', async () => {
    const page = fakePage({
      cookie: SIGNED_IN,
      responses: [{ status: 200, body: { value: { activityUrn: 'urn:li:activity:7131234567890123457' } } }],
    });
    page.run(buildLiPostScript('hello'));
    await settle();
    expect(page.msgs[0]).toMatchObject({ ok: true, urn: 'urn:li:activity:7131234567890123457' });
  });

  it('does not retry a 401, 403 or 429 and reports the status', async () => {
    for (const status of [401, 403, 429]) {
      const page = fakePage({ cookie: SIGNED_IN, responses: [{ status, body: { message: 'CSRF check failed.' } }] });
      page.run(buildLiPostScript('hello'));
      await settle();
      expect(page.calls).toHaveLength(1);
      expect(page.msgs).toEqual([
        { t: LI_MSG, kind: 'result', ok: false, stage: 'post', status, firstStatus: null, message: '{"message":"CSRF check failed."}' },
      ]);
    }
  });

  it('tries the fallback once after another 4xx and reports both answers', async () => {
    const page = fakePage({
      cookie: SIGNED_IN,
      responses: [
        { status: 400, body: { message: 'Field commentaryV2 is not allowed' } },
        { status: 404, raw: 'not found' },
      ],
    });
    page.run(buildLiPostScript('hello'));
    await settle();
    expect(page.calls.map((c) => c.url)).toEqual([LI_POST_ENDPOINT, LI_FALLBACK_ENDPOINT]);
    expect(page.calls[1].init.headers['csrf-token']).toBe(CSRF);
    expect(JSON.parse(page.calls[1].init.body).commentary.text).toBe('hello');
    expect(page.msgs).toEqual([
      {
        t: LI_MSG,
        kind: 'result',
        ok: false,
        stage: 'post',
        status: 404,
        firstStatus: 400,
        message: 'not found',
        firstMessage: '{"message":"Field commentaryV2 is not allowed"}',
      },
    ]);
  });

  it('succeeds through the fallback and says so', async () => {
    const page = fakePage({
      cookie: SIGNED_IN,
      responses: [{ status: 422, body: {} }, { status: 200, body: { urn: URN } }],
    });
    page.run(buildLiPostScript('hello'));
    await settle();
    expect(page.msgs).toEqual([{ t: LI_MSG, kind: 'result', ok: true, urn: URN, via: 'dash', firstStatus: 422 }]);
  });

  it('does not retry a 5xx', async () => {
    const page = fakePage({ cookie: SIGNED_IN, responses: [{ status: 503, raw: 'down' }] });
    page.run(buildLiPostScript('hello'));
    await settle();
    expect(page.calls).toHaveLength(1);
    expect(page.msgs[0]).toMatchObject({ ok: false, stage: 'post', status: 503 });
  });

  it('cuts the error to 200 characters and redacts anything that looks like a token', async () => {
    const long = `${'x '.repeat(150)}`;
    const token = 'AQEDATOKENabcdefghijklmnopqrstuvwxyz0123456789';
    const page = fakePage({
      cookie: SIGNED_IN,
      responses: [{ status: 401, raw: `bad csrf ${CSRF} and ${token} ${long}` }],
    });
    page.run(buildLiPostScript('hello'));
    await settle();
    const m = page.msgs[0];
    expect(m.message.length).toBeLessThanOrEqual(200);
    expect(m.message).toContain('bad csrf [redacted] and [redacted]');
    expect(page.raw.join('')).not.toContain(CSRF);
    expect(page.raw.join('')).not.toContain(token);
  });

  it('reports a network error as such', async () => {
    const page = fakePage({ cookie: SIGNED_IN, responses: [{ status: 0, boom: true }] });
    page.run(buildLiPostScript('hello'));
    await settle();
    expect(page.msgs[0]).toMatchObject({ ok: false, stage: 'network', status: 0, message: 'Network request failed' });
  });

  it('sends nothing when signed out, on a sign-in page or off www.linkedin.com', async () => {
    const out = fakePage({ cookie: 'bcookie="v=2"' });
    out.run(buildLiPostScript('hello'));
    await settle();
    expect(out.calls).toHaveLength(0);
    expect(out.msgs).toEqual([{ t: LI_MSG, kind: 'result', ok: false, stage: 'signed-out', status: 0, firstStatus: null }]);

    const login = fakePage({ cookie: SIGNED_IN, path: '/uas/login' });
    login.run(buildLiPostScript('hello'));
    await settle();
    expect(login.calls).toHaveLength(0);
    expect(login.msgs[0]).toMatchObject({ ok: false, stage: 'signed-out' });

    const other = fakePage({ cookie: SIGNED_IN, host: 'example.com' });
    other.run(buildLiPostScript('hello'));
    await settle();
    expect(other.calls).toHaveLength(0);
    expect(other.msgs[0]).toMatchObject({ ok: false, stage: 'page' });
  });

  it('does not post twice when injected twice', async () => {
    const page = fakePage({ cookie: SIGNED_IN, responses: [{ status: 200, body: { urn: URN } }] });
    const script = buildLiPostScript('hello');
    page.run(script);
    page.run(script);
    await settle();
    expect(page.calls).toHaveLength(1);
    expect(page.msgs).toHaveLength(1);
  });

  it('refuses empty and over-long text', () => {
    expect(() => buildLiPostScript('')).toThrow();
    expect(() => buildLiPostScript('   \n')).toThrow();
    expect(() => buildLiPostScript('a'.repeat(LI_MAX_CHARS + 1))).toThrow(/3,000/);
    expect(() => buildLiPostScript('a'.repeat(LI_MAX_CHARS))).not.toThrow();
  });
});

describe('liTextProblem / redactSnippet', () => {
  it('counts characters, not UTF-16 units', () => {
    expect(liTextProblem('hello')).toBeNull();
    expect(liTextProblem(' ')).toMatch(/Write something/);
    expect(liTextProblem('\u{1F680}'.repeat(LI_MAX_CHARS))).toBeNull();
    expect(liTextProblem('\u{1F680}'.repeat(LI_MAX_CHARS + 1))).toMatch(/3,000/);
  });
  it('keeps field names and paths readable, drops token-like runs', () => {
    expect(redactSnippet('Unknown field visibleToConnectionsOnly in /voyager/api/x')).toBe(
      'Unknown field visibleToConnectionsOnly in /voyager/api/x',
    );
    expect(redactSnippet('csrf ajax:-5551234 failed')).toBe('csrf [redacted] failed');
    expect(redactSnippet('Bearer abc.def.ghi rest')).toBe('[redacted] rest');
    expect(redactSnippet(`  a \n\n b ${'z'.repeat(40)} `)).toBe('a b [redacted]');
    expect(redactSnippet('y'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(redactSnippet(undefined)).toBe('');
  });
});

describe('parseLiMessage', () => {
  it('ignores other messages and junk', () => {
    expect(parseLiMessage('not json')).toBeNull();
    expect(parseLiMessage('{"href":"https://x"}')).toBeNull();
    expect(parseLiMessage('null')).toBeNull();
    expect(parseLiMessage(JSON.stringify({ t: 'pulse-ig', kind: 'result', ok: true }))).toBeNull();
    expect(parseLiMessage(JSON.stringify({ t: LI_MSG, kind: 'nope' }))).toBeNull();
  });
  it('reads state with booleans only', () => {
    expect(parseLiMessage(JSON.stringify({ t: LI_MSG, kind: 'state', signedIn: true, onLi: true, settled: 1 }))).toEqual({
      kind: 'state',
      signedIn: true,
      onLi: true,
      settled: false,
    });
  });
  it('reads success, keeping only a well-formed URN', () => {
    expect(parseLiMessage(JSON.stringify({ t: LI_MSG, kind: 'result', ok: true, urn: URN, via: 'norm', firstStatus: null }))).toEqual({
      kind: 'result',
      ok: true,
      urn: URN,
      via: 'norm',
      firstStatus: null,
    });
    expect(parseLiMessage(JSON.stringify({ t: LI_MSG, kind: 'result', ok: true, urn: '../x', via: 'other', firstStatus: 400 }))).toEqual({
      kind: 'result',
      ok: true,
      urn: null,
      via: null,
      firstStatus: 400,
    });
  });
  it('reads a failed post with status and a redacted message', () => {
    expect(
      parseLiMessage(
        JSON.stringify({ t: LI_MSG, kind: 'result', ok: false, stage: 'post', status: 400, firstStatus: 404, message: `bad ${CSRF}`, firstMessage: 'gone' }),
      ),
    ).toEqual({
      kind: 'result',
      ok: false,
      stage: 'post',
      status: 400,
      firstStatus: 404,
      message: 'bad [redacted]',
      firstMessage: 'gone',
    });
  });
  it('reads signed-out and timeout failures', () => {
    expect(parseLiMessage(JSON.stringify({ t: LI_MSG, kind: 'result', ok: false, stage: 'signed-out', status: 0 }))).toEqual({
      kind: 'result',
      ok: false,
      stage: 'signed-out',
      status: 0,
      firstStatus: null,
      message: null,
      firstMessage: null,
    });
    expect(parseLiMessage(JSON.stringify({ t: LI_MSG, kind: 'result', ok: false, stage: 'timeout' }))).toMatchObject({
      ok: false,
      stage: 'timeout',
      status: 0,
    });
    expect(liTimeoutFailure()).toEqual({ ok: false, stage: 'timeout', status: 0, firstStatus: null, message: null, firstMessage: null });
  });
});

describe('liPostUrl / liFailureText', () => {
  it('links the published post from its URN', () => {
    expect(liPostUrl(URN)).toBe(`https://www.linkedin.com/feed/update/${URN}/`);
    expect(liPostUrl('urn:li:activity:7131234567890123457')).toBe(
      'https://www.linkedin.com/feed/update/urn:li:activity:7131234567890123457/',
    );
    expect(liPostUrl('urn:li:ugcPost:7131234567890123458')).toContain('/feed/update/urn:li:ugcPost:');
    expect(liPostUrl(null)).toBeNull();
    expect(liPostUrl('urn:li:share:../../x')).toBeNull();
    expect(liPostUrl('https://evil.example/')).toBeNull();
  });
  it('explains each failure and always offers the LinkedIn hand-off', () => {
    expect(liFailureText({ stage: 'signed-out', status: 0 })).toMatch(/Sign in again/);
    expect(liFailureText(liTimeoutFailure())).toMatch(/may have posted/);
    expect(liFailureText({ stage: 'post', status: 403 })).toMatch(/refused the post from here/);
    expect(liFailureText({ stage: 'post', status: 429 })).toMatch(/slow down/);
    expect(liFailureText({ stage: 'network', status: 0 })).toMatch(/Open LinkedIn instead/);
    expect(liFailureText({ stage: 'webview', status: 0 })).toMatch(/Open LinkedIn instead/);
    const refused = liFailureText({ stage: 'post', status: 404, firstStatus: 400, message: 'nope', firstMessage: 'bad field' });
    expect(refused).toContain('(400, then 404)');
    expect(refused).toContain('"bad field" / "nope"');
    expect(refused).toMatch(/Open LinkedIn instead/);
    expect(liFailureText({ stage: 'post', status: 410 })).toContain('(410)');
  });
});
