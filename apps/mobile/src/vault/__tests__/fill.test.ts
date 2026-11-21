/**
 * The saved-login filler: site binding (`canFill`), escaping, and the injected script run for real against jsdom login
 * pages (virtual clock from the autoRead harness).
 */
import { makeEnv, page } from '../../autoRead/__tests__/igHarness';
import { flowFor, parsePageUrl } from '../../autoRead/platforms';
import { PLATFORMS } from '../../types';
import { buildFillScript, canFill, fillTarget, jsLiteral, takeVaultFill } from '../fill';

const LS = String.fromCharCode(0x2028); // JS line separator
const PS = String.fromCharCode(0x2029); // JS paragraph separator
const CREDS = { u: 'jane@example.com', p: `pa"ss\\w0rd</script>${LS}x` };

function run(platform: Parameters<typeof buildFillScript>[0], url: string, html: string) {
  const env = makeEnv({ url, html: page(html) });
  const doc = env.dom.window.document;
  doc.querySelectorAll('form').forEach((f) => f.addEventListener('submit', (e) => e.preventDefault()));
  env.inject(buildFillScript(platform, CREDS, { submitDelayMs: 50, pollMs: 50, pollTries: 10 }));
  return { env, doc };
}

const val = (doc: Document, sel: string) => (doc.querySelector(sel) as HTMLInputElement).value;

describe('canFill (site binding)', () => {
  it.each([
    ['instagram', 'https://www.instagram.com/accounts/login/'],
    ['instagram', 'https://www.instagram.com/accounts/login/?next=%2F'],
    ['linkedin', 'https://www.linkedin.com/login'],
    ['linkedin', 'https://www.linkedin.com/uas/login'],
    ['x', 'https://x.com/i/flow/login'],
    ['reddit', 'https://www.reddit.com/login/'],
    ['facebook', 'https://m.facebook.com/login/'],
    ['tiktok', 'https://www.tiktok.com/login/phone-or-email/email'],
  ] as const)('%s %s is a fillable login page', (platform, url) => {
    expect(canFill(platform, url)).toBe(true);
  });

  it.each([
    ['instagram', 'https://www.instagram.com/accounts/login/two_factor?next=%2F', 'two-factor'],
    ['instagram', 'https://www.instagram.com/challenge/abc/', 'challenge'],
    ['instagram', 'https://www.instagram.com/accounts/password/reset/', 'password reset'],
    ['instagram', 'http://www.instagram.com/accounts/login/', 'not https'],
    ['instagram', 'https://instagram.com.evil.example/accounts/login/', 'look-alike host'],
    ['instagram', 'https://user@www.instagram.com/accounts/login/', 'userinfo in the URL'],
    ['instagram', 'https://www.linkedin.com/login', "another platform's host"],
    ['linkedin', 'https://www.linkedin.com/uas/login-submit', 'not a whole path segment'],
    ['linkedin', 'https://www.linkedin.com/checkpoint/lg/login-submit', 'checkpoint'],
    ['linkedin', 'https://www.linkedin.com/feed/', 'signed-in page'],
    ['x', 'https://x.com/account/access', 'account access check'],
    ['tiktok', 'https://www.tiktok.com/login/captcha', 'captcha'],
  ] as const)('%s %s is refused (%s)', (platform, url, _why) => {
    expect(canFill(platform, url)).toBe(false);
  });

  it('refuses junk', () => {
    expect(canFill('instagram', null)).toBe(false);
    expect(canFill('instagram', 'javascript:alert(1)')).toBe(false);
  });

  it('every fill page is on the flow’s own domain and is one of its login pages', () => {
    for (const p of PLATFORMS) {
      const t = fillTarget(p);
      for (const d of t.domains) {
        for (const path of t.paths) {
          const u = parsePageUrl(`https://www.${d}${path}`)!;
          expect(flowFor(p).hostOk(u)).toBe(true);
          expect(flowFor(p).isLogin(u)).toBe(true);
        }
      }
    }
  });
});

describe('jsLiteral', () => {
  it.each(['plain', 'q"uote', 'back\\slash', '</script><script>alert(1)</script>', `line${LS}sep${PS}`, 'ünï😀', ''])(
    'round-trips %j without raw angle brackets or line separators',
    (s) => {
      const lit = jsLiteral({ s });
      for (const ch of ['<', '>', LS, PS]) expect(lit.includes(ch)).toBe(false);
      // eslint-disable-next-line no-new-func
      expect(new Function(`return ${lit};`)()).toEqual({ s });
    },
  );
});

describe('the fill script', () => {
  const IG_FORM =
    '<form id="f"><input name="username" type="text"><input name="password" type="password">' +
    '<button type="submit" id="go">Log in</button></form>';

  it('fills and submits the Instagram form, and posts only a status', async () => {
    const { env, doc } = run('instagram', 'https://www.instagram.com/accounts/login/', IG_FORM);
    let clicks = 0;
    doc.getElementById('go')!.addEventListener('click', () => clicks++);
    await env.advance(100);
    expect(val(doc, 'input[name="username"]')).toBe(CREDS.u);
    expect(val(doc, 'input[name="password"]')).toBe(CREDS.p);
    expect(clicks).toBe(1);
    expect(env.posted).toEqual([{ pulse: 'vaultFill', platform: 'instagram', status: 'filled' }]);
    for (const raw of env.rawPosted) {
      expect(raw).not.toContain(CREDS.u);
      expect(raw).not.toContain('pa"ss');
    }
  });

  it('fires the input events React forms listen for', async () => {
    const { env, doc } = run('instagram', 'https://www.instagram.com/accounts/login/', IG_FORM);
    const seen: string[] = [];
    // Listeners added after injection still see nothing: the events fired synchronously at injection. So listen on a
    // fresh run instead.
    const env2 = makeEnv({ url: 'https://www.instagram.com/accounts/login/', html: page(IG_FORM) });
    const d2 = env2.dom.window.document;
    d2.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    d2.addEventListener('input', (e) => seen.push(`input:${(e.target as HTMLInputElement).name}`));
    d2.addEventListener('change', (e) => seen.push(`change:${(e.target as HTMLInputElement).name}`));
    env2.inject(buildFillScript('instagram', CREDS, { submitDelayMs: 50 }));
    expect(seen).toEqual(['input:username', 'change:username', 'input:password', 'change:password']);
    await env.advance(100);
    expect(doc).toBeTruthy();
  });

  it('skips hidden decoy fields', async () => {
    const html =
      '<form><input name="username" style="display:none" id="decoy"><input name="username" id="real">' +
      '<input type="password" name="password"><button type="submit">Log in</button></form>';
    const { env, doc } = run('instagram', 'https://www.instagram.com/accounts/login/', html);
    await env.advance(100);
    expect((doc.getElementById('decoy') as HTMLInputElement).value).toBe('');
    expect((doc.getElementById('real') as HTMLInputElement).value).toBe(CREDS.u);
  });

  it('fills LinkedIn by its own field ids', async () => {
    const html =
      '<form><input id="username" name="session_key" type="email"><input id="password" name="session_password" ' +
      'type="password"><button type="submit" aria-label="Sign in">Sign in</button></form>';
    const { env, doc } = run('linkedin', 'https://www.linkedin.com/login', html);
    await env.advance(100);
    expect(val(doc, '#username')).toBe(CREDS.u);
    expect(val(doc, '#password')).toBe(CREDS.p);
    expect(env.posted.map((m) => m.status)).toEqual(['filled']);
  });

  it('handles the X two-step flow: username, Next, then the password field appears', async () => {
    const html =
      '<div id="flow"><input autocomplete="username" name="text" type="text">' +
      '<div role="button" id="next"><span>Next</span></div></div>';
    const { env, doc } = run('x', 'https://x.com/i/flow/login', html);
    let loggedIn = 0;
    doc.getElementById('next')!.addEventListener('click', () => {
      const flow = doc.getElementById('flow')!;
      flow.innerHTML =
        '<input name="password" type="password"><button data-testid="LoginForm_Login_Button" type="button">Log in</button>';
      flow.querySelector('button')!.addEventListener('click', () => loggedIn++);
    });
    await env.advance(60); // username filled, Next clicked
    expect(env.posted.map((m) => m.status)).toEqual(['partial']);
    await env.advance(200); // the poll finds the password field, fills it, submits
    expect(val(doc, 'input[name="password"]')).toBe(CREDS.p);
    expect(loggedIn).toBe(1);
    expect(env.posted.map((m) => m.status)).toEqual(['partial', 'filled']);
  });

  it('gives up with no_form when the password field never appears', async () => {
    const html = '<div><input autocomplete="username" name="text"><div role="button">Next</div></div>';
    const { env } = run('x', 'https://x.com/i/flow/login', html);
    await env.advance(2000);
    expect(env.posted.map((m) => m.status)).toEqual(['partial', 'no_form']);
  });

  it('fills fields inside open shadow roots (Reddit)', async () => {
    const { env, doc } = run('reddit', 'https://www.reddit.com/login/', '<form id="f"><div id="u"></div><div id="p"></div></form>');
    // The script already ran against an empty form; build the shadow DOM first on a fresh page.
    const env2 = makeEnv({ url: 'https://www.reddit.com/login/', html: page('<form id="f"><div id="u"></div><div id="p"></div></form>') });
    const d2 = env2.dom.window.document;
    d2.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    const su = d2.getElementById('u')!.attachShadow({ mode: 'open' });
    su.innerHTML = '<input name="username" type="text">';
    const sp = d2.getElementById('p')!.attachShadow({ mode: 'open' });
    sp.innerHTML = '<input name="password" type="password">';
    env2.inject(buildFillScript('reddit', CREDS, { submitDelayMs: 50 }));
    await env2.advance(100);
    expect((su.querySelector('input') as HTMLInputElement).value).toBe(CREDS.u);
    expect((sp.querySelector('input') as HTMLInputElement).value).toBe(CREDS.p);
    expect(env2.posted.map((m) => m.status)).toEqual(['filled']);
    await env.advance(100);
    expect(doc).toBeTruthy();
  });

  it('refuses to fill on a host that is not the platform (wrong_host), touching nothing', async () => {
    const { env, doc } = run('instagram', 'https://evil.example/accounts/login/', IG_FORM);
    await env.advance(100);
    expect(val(doc, 'input[name="username"]')).toBe('');
    expect(val(doc, 'input[name="password"]')).toBe('');
    expect(env.posted.map((m) => m.status)).toEqual(['wrong_host']);
  });

  it('refuses on a two-factor page even on the right host', async () => {
    const html = '<form><input name="verificationCode"><input type="password"></form>';
    const { env, doc } = run('instagram', 'https://www.instagram.com/accounts/login/two_factor', html);
    await env.advance(100);
    expect((doc.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
    expect(env.posted.map((m) => m.status)).toEqual(['wrong_host']);
  });

  // The sheet's URL check can be fed a page-reported address (the href poll), so the in-page check is the last guard.
  // A hostile page shares the injected script's JS realm and can replace String and its methods before we run.
  it.each([
    ['String.prototype.slice', "String.prototype.slice = function () { return '.instagram.com'; };"],
    [
      'the String global',
      "var S0 = String; String = function (v) { var s = S0(v); return s === 'evil.example' ? 'www.instagram.com' : s; };",
    ],
    [
      'String.prototype.toLowerCase',
      'var L0 = String.prototype.toLowerCase; String.prototype.toLowerCase = function () { var s = L0.call(this); ' +
        "return s === 'evil.example' ? 'www.instagram.com' : s; };",
    ],
  ])('a hostile page that replaced %s still gets wrong_host and no values', async (_what, override) => {
    const env = makeEnv({ url: 'https://evil.example/accounts/login/', html: page(IG_FORM) });
    const doc = env.dom.window.document;
    doc.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    const typed: string[] = [];
    doc.addEventListener('input', (e) => typed.push((e.target as HTMLInputElement).value));
    env.inject(override);
    env.inject(buildFillScript('instagram', CREDS, { submitDelayMs: 50, pollMs: 50, pollTries: 10 }));
    await env.advance(100);
    expect(val(doc, 'input[name="username"]')).toBe('');
    expect(val(doc, 'input[name="password"]')).toBe('');
    expect(typed).toEqual([]);
    expect(env.posted.map((m) => m.status)).toEqual(['wrong_host']);
  });

  it.each([
    ['instagram', 'https://www.instagram.com/accounts/login/'],
    ['instagram', 'https://WWW.Instagram.COM/Accounts/Login/'],
    ['instagram', 'https://instagram.com/accounts/login'],
    ['instagram', 'https://evil-instagram.com/accounts/login/'],
    ['instagram', 'https://instagram.com.evil.example/accounts/login/'],
    ['instagram', 'https://www.instagram.com/accounts/login/two_factor'],
    ['instagram', 'https://www.instagram.com/accounts/loginx/'],
    ['instagram', 'https://www.instagram.com/challenge/abc/'],
    ['linkedin', 'https://www.linkedin.com/uas/login'],
    ['linkedin', 'https://www.linkedin.com/uas/login-submit'],
    ['linkedin', 'https://www.linkedin.com/checkpoint/lg/login-submit'],
    ['linkedin', 'https://xlinkedin.com/login'],
    ['x', 'https://x.com/i/flow/login'],
    ['x', 'https://mobile.twitter.com/login'],
    ['x', 'https://ax.com/login'],
    ['tiktok', 'https://www.tiktok.com/login/captcha'],
    ['tiktok', 'https://www.tiktok.com/login/phone-or-email/email'],
    ['facebook', 'https://m.facebook.com/login.php'],
  ] as const)('the in-page check agrees with canFill on %s %s', async (platform, url) => {
    const { env } = run(platform, url, '<div></div>');
    await env.advance(100);
    expect(env.posted.map((m) => m.status)).toEqual([canFill(platform, url) ? 'no_form' : 'wrong_host']);
  });

  // X runs username, password, unusual-activity check and 2FA code all on /i/flow/login; TikTok opens its code dialog
  // over the login form. The URL alone cannot tell, so the page's own one-time-code field must stop the fill.
  it.each([
    [
      'x',
      'https://x.com/i/flow/login',
      '<div><input name="text" type="text" inputmode="numeric" data-testid="ocfEnterTextTextInput" id="code">' +
        '<div role="button">Next</div></div>',
    ],
    [
      'tiktok',
      'https://www.tiktok.com/login/phone-or-email/email',
      '<form><input name="username" id="u"><input type="password" name="password" id="pw">' +
        '<button type="submit">Log in</button></form><div role="dialog"><input autocomplete="one-time-code" id="code"></div>',
    ],
  ] as const)('never fills a %s second-factor step that shares the login URL', async (platform, url, html) => {
    const { env, doc } = run(platform, url, html);
    await env.advance(2000);
    for (const el of Array.from(doc.querySelectorAll('input'))) expect((el as HTMLInputElement).value).toBe('');
    expect(env.posted.map((m) => m.status)).toEqual(['no_form']);
  });

  it('reports no_form when the page has no login fields', async () => {
    const { env } = run('tiktok', 'https://www.tiktok.com/login', '<div>Use QR code</div>');
    await env.advance(100);
    expect(env.posted.map((m) => m.status)).toEqual(['no_form']);
  });

  it('leaves no globals behind', async () => {
    const env = makeEnv({ url: 'https://www.instagram.com/accounts/login/', html: page(IG_FORM) });
    env.dom.window.document.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    const before = Object.keys(env.dom.window).length;
    const script = buildFillScript('instagram', CREDS, { submitDelayMs: 10 });
    expect(script.startsWith('(function () {')).toBe(true); // everything lives inside one IIFE
    env.inject(script);
    await env.advance(50);
    expect(Object.keys(env.dom.window).length).toBe(before);
  });
});

describe('takeVaultFill', () => {
  it('reads the filler’s message', () => {
    expect(takeVaultFill('{"pulse":"vaultFill","platform":"x","status":"partial"}')).toEqual({
      platform: 'x',
      status: 'partial',
    });
  });

  it.each([
    '{"pulse":"autoRead","platform":"x","step":0,"status":"ok"}',
    '{"pulse":"vaultFill","platform":"myspace","status":"filled"}',
    '{"pulse":"vaultFill","platform":"x","status":"done"}',
    'not json vaultFill',
    42,
  ])('ignores %j', (raw) => {
    expect(takeVaultFill(raw)).toBeNull();
  });
});
