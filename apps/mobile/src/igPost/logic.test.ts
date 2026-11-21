/** Unit tests for src/igPost/logic.ts: `npx jest --ci src/igPost` (see jest.config.js). No network, no real account. */
import {
  base64Size,
  buildIgPostScript,
  IG_MSG,
  IG_STATE_PROBE_JS,
  igButtonMode,
  igFailureText,
  igImageProblem,
  igNote,
  igPostUrl,
  imageChunkScripts,
  isBase64,
  newUploadId,
  parseIgMessage,
} from './logic';

// jest provides these at run time; declared here so `tsc --noEmit` needs no @types/jest.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => any;
declare const Buffer: { from(data: string | Uint8Array, enc?: string): { toString(enc: string): string; length: number } };

interface FakeResponse {
  status: number;
  body?: unknown;
}

/** A fake instagram.com page: runs an injected script against stubbed window, document, location and fetch. */
function fakePage(opts: { cookie?: string; host?: string; path?: string; responses?: FakeResponse[]; claim?: string }) {
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
    sessionStorage: { getItem: (k: string) => (k === 'www-claim-v2' ? (opts.claim ?? null) : null) },
  };
  const document = { cookie: opts.cookie ?? '' };
  const location = { hostname: opts.host ?? 'www.instagram.com', protocol: 'https:', pathname: opts.path ?? '/' };
  const fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 500 };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.body === undefined) throw new Error('not json');
        return r.body;
      },
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

const SIGNED_IN = 'mid=abc; ds_user_id=12345; csrftoken=csrf-test-value; ig_nrcb=1';
/** A tiny fake "JPEG": the bytes do not matter to the script, only that they arrive whole. */
const BYTES = new Uint8Array(Array.from({ length: 1000 }, (_, i) => (i * 37) % 256));
const B64 = Buffer.from(BYTES).toString('base64');

describe('igButtonMode / igNote', () => {
  it('gives Android the photo flow and keeps copy elsewhere', () => {
    expect(igButtonMode('android')).toBe('instagram');
    expect(igButtonMode('ios')).toBe('copy');
    expect(igButtonMode('web')).toBe('copy');
  });
  it('mentions the visual plan only when the post has one', () => {
    expect(igNote({ autoPost: false, hasVisualPlan: true })).toContain('visual plan');
    expect(igNote({ autoPost: false, hasVisualPlan: false })).not.toContain('visual plan');
    expect(igNote({ autoPost: true, hasVisualPlan: false })).toContain('post it for you');
  });
});

describe('igImageProblem', () => {
  it('accepts square, 4:5 and 1.91:1 photos', () => {
    expect(igImageProblem({ width: 1080, height: 1080, bytes: 500_000 })).toBeNull();
    expect(igImageProblem({ width: 1080, height: 1350, bytes: 500_000 })).toBeNull();
    expect(igImageProblem({ width: 1910, height: 1000, bytes: 500_000 })).toBeNull();
  });
  it('refuses tall, wide, tiny, huge and unreadable photos', () => {
    expect(igImageProblem({ width: 1080, height: 1920, bytes: 500_000 })).toMatch(/4:5/);
    expect(igImageProblem({ width: 3000, height: 1000, bytes: 500_000 })).toMatch(/4:5/);
    expect(igImageProblem({ width: 200, height: 200, bytes: 10_000 })).toMatch(/too small/);
    expect(igImageProblem({ width: 1080, height: 1080, bytes: 9_000_000 })).toMatch(/too large/);
    expect(igImageProblem({ width: 0, height: 1080, bytes: 1 })).toMatch(/Couldn't read/);
  });
});

describe('base64 helpers', () => {
  it('measures decoded size', () => {
    expect(base64Size(B64)).toBe(BYTES.length);
    expect(base64Size('QQ==')).toBe(1);
    expect(base64Size('QUI=')).toBe(2);
    expect(base64Size('QUJD')).toBe(3);
  });
  it('accepts only plain base64', () => {
    expect(isBase64(B64)).toBe(true);
    expect(isBase64('')).toBe(false);
    expect(isBase64("QUJD';alert(1);//")).toBe(false);
    expect(isBase64('QUJ')).toBe(false);
  });
});

describe('imageChunkScripts', () => {
  it('rebuilds the photo on the page from small chunks', () => {
    const page = fakePage({});
    const chunks = imageChunkScripts(B64, 100);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) page.run(c);
    expect(page.window.__pulseIgImg).toBe(B64);
  });
  it('refuses anything that could break out of the string', () => {
    expect(() => imageChunkScripts("QUJD'+x+'")).toThrow('not base64');
  });
});

describe('IG_STATE_PROBE_JS', () => {
  it('reports signed in on a settled instagram.com page, with booleans only', () => {
    const page = fakePage({ cookie: SIGNED_IN, path: '/' });
    page.run(IG_STATE_PROBE_JS);
    expect(page.msgs).toEqual([{ t: IG_MSG, kind: 'state', onIg: true, signedIn: true, settled: true }]);
    expect(page.raw.join('')).not.toContain('csrf-test-value');
    expect(page.raw.join('')).not.toContain('12345');
  });
  it('reports signed out and unsettled pages', () => {
    const out = fakePage({ cookie: 'mid=abc; csrftoken=x', path: '/accounts/login/' });
    out.run(IG_STATE_PROBE_JS);
    expect(out.msgs[0]).toMatchObject({ signedIn: false, settled: false });
    const onetap = fakePage({ cookie: SIGNED_IN, path: '/accounts/onetap/' });
    onetap.run(IG_STATE_PROBE_JS);
    expect(onetap.msgs[0]).toMatchObject({ signedIn: true, settled: false });
  });
  it('knows when it is not on instagram.com', () => {
    const page = fakePage({ cookie: SIGNED_IN, host: 'evil-instagram.com.example' });
    page.run(IG_STATE_PROBE_JS);
    expect(page.msgs[0]).toMatchObject({ onIg: false });
  });
});

describe('buildIgPostScript', () => {
  const caption = `New drop "today" </script>\nLine two ${String.fromCharCode(0x2028)} #pulse #launch`;
  const params = { uploadId: '1763712000000', width: 1080, height: 1080, bytes: BYTES.length, b64Length: B64.length, caption };

  const loaded = (opts: Parameters<typeof fakePage>[0]) => {
    const page = fakePage(opts);
    for (const c of imageChunkScripts(B64, 256)) page.run(c);
    return page;
  };

  it('uploads the photo, then publishes it with the caption', async () => {
    const page = loaded({
      cookie: SIGNED_IN,
      claim: 'hmac.claim',
      responses: [
        { status: 200, body: { upload_id: '1763712000000', status: 'ok' } },
        { status: 200, body: { status: 'ok', media: { code: 'DAbc_12-x' } } },
      ],
    });
    page.run(buildIgPostScript(params));
    await settle();

    expect(page.calls).toHaveLength(2);
    const [up, cf] = page.calls;
    expect(up.url).toBe('/rupload_igphoto/fb_uploader_1763712000000');
    expect(up.init.method).toBe('POST');
    expect(up.init.credentials).toBe('include');
    expect(up.init.headers).toMatchObject({
      'x-ig-app-id': '936619743392459',
      'x-csrftoken': 'csrf-test-value',
      'x-ig-www-claim': 'hmac.claim',
      'x-entity-name': 'fb_uploader_1763712000000',
      'x-entity-length': String(BYTES.length),
      'x-entity-type': 'image/jpeg',
      offset: '0',
      'content-type': 'image/jpeg',
    });
    expect(JSON.parse(up.init.headers['x-instagram-rupload-params'])).toEqual({
      media_type: 1,
      upload_id: '1763712000000',
      upload_media_height: 1080,
      upload_media_width: 1080,
    });
    expect(Array.from(up.init.body as Uint8Array)).toEqual(Array.from(BYTES));

    expect(cf.url).toBe('/api/v1/media/configure/');
    expect(cf.init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(cf.init.body);
    expect(form.get('caption')).toBe(caption);
    expect(form.get('upload_id')).toBe('1763712000000');
    expect(form.get('source_type')).toBe('library');

    expect(page.msgs).toEqual([{ t: IG_MSG, kind: 'result', ok: true, code: 'DAbc_12-x' }]);
    expect(page.window.__pulseIgImg).toBe('');
    expect(page.raw.join('')).not.toContain('csrf-test-value');
  });

  it('stops at the upload when Instagram refuses it', async () => {
    const page = loaded({ cookie: SIGNED_IN, responses: [{ status: 403, body: { message: 'login_required', status: 'fail' } }] });
    page.run(buildIgPostScript(params));
    await settle();
    expect(page.calls).toHaveLength(1);
    expect(page.msgs).toEqual([
      { t: IG_MSG, kind: 'result', ok: false, stage: 'upload', status: 403, message: 'login_required' },
    ]);
  });

  it('reports a refused configure', async () => {
    const page = loaded({
      cookie: SIGNED_IN,
      responses: [{ status: 200, body: { status: 'ok' } }, { status: 400, body: { status: 'fail', message: 'aspect ratio' } }],
    });
    page.run(buildIgPostScript(params));
    await settle();
    expect(page.msgs[0]).toMatchObject({ ok: false, stage: 'configure', status: 400, message: 'aspect ratio' });
  });

  it('sends nothing when signed out or when the photo did not arrive whole', async () => {
    const out = loaded({ cookie: 'mid=abc' });
    out.run(buildIgPostScript(params));
    await settle();
    expect(out.calls).toHaveLength(0);
    expect(out.msgs[0]).toMatchObject({ ok: false, stage: 'signed-out' });

    const partial = fakePage({ cookie: SIGNED_IN });
    partial.run(imageChunkScripts(B64, 256).slice(0, 2).join('\n'));
    partial.run(buildIgPostScript(params));
    await settle();
    expect(partial.calls).toHaveLength(0);
    expect(partial.msgs[0]).toMatchObject({ ok: false, stage: 'image' });
  });

  it('refuses to run off instagram.com', async () => {
    const page = loaded({ cookie: SIGNED_IN, host: 'example.com' });
    page.run(buildIgPostScript(params));
    await settle();
    expect(page.calls).toHaveLength(0);
    expect(page.msgs[0]).toMatchObject({ ok: false, stage: 'page' });
  });

  it('refuses an upload id that is not digits', () => {
    expect(() => buildIgPostScript({ ...params, uploadId: "1'; x()" })).toThrow('bad upload id');
    expect(newUploadId(1763712000123.7)).toBe('1763712000123');
  });
});

describe('parseIgMessage', () => {
  it('ignores other messages and junk', () => {
    expect(parseIgMessage('not json')).toBeNull();
    expect(parseIgMessage('{"href":"https://x"}')).toBeNull();
    expect(parseIgMessage(JSON.stringify({ t: 'other', kind: 'result', ok: true }))).toBeNull();
    expect(parseIgMessage(JSON.stringify({ t: IG_MSG, kind: 'nope' }))).toBeNull();
  });
  it('reads state, success and failure, dropping odd codes', () => {
    expect(parseIgMessage(JSON.stringify({ t: IG_MSG, kind: 'state', signedIn: true, onIg: true, settled: 1 }))).toEqual({
      kind: 'state',
      signedIn: true,
      onIg: true,
      settled: false,
    });
    expect(parseIgMessage(JSON.stringify({ t: IG_MSG, kind: 'result', ok: true, code: 'C0de_-' }))).toEqual({
      kind: 'result',
      ok: true,
      code: 'C0de_-',
    });
    expect(parseIgMessage(JSON.stringify({ t: IG_MSG, kind: 'result', ok: true, code: '../x' }))).toEqual({
      kind: 'result',
      ok: true,
      code: null,
    });
    expect(parseIgMessage(JSON.stringify({ t: IG_MSG, kind: 'result', ok: false, stage: 'upload', status: 429 }))).toEqual({
      kind: 'result',
      ok: false,
      stage: 'upload',
      status: 429,
      message: null,
    });
  });
});

describe('igPostUrl / igFailureText', () => {
  it('links the published post', () => {
    expect(igPostUrl('DAbc')).toBe('https://www.instagram.com/p/DAbc/');
    expect(igPostUrl(null)).toBeNull();
  });
  it('explains each failure', () => {
    expect(igFailureText({ stage: 'signed-out', status: 0 })).toMatch(/Sign in again/);
    expect(igFailureText({ stage: 'timeout', status: 0 })).toMatch(/may have posted/);
    expect(igFailureText({ stage: 'upload', status: 403 })).toMatch(/refused the post from here/);
    expect(igFailureText({ stage: 'configure', status: 429 })).toMatch(/slow down/);
    expect(igFailureText({ stage: 'configure', status: 400 })).toMatch(/configure 400/);
    expect(igFailureText({ stage: 'webview', status: 0 })).toMatch(/Open Instagram/);
  });
});
