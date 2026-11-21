/**
 * The save-on-sign-in listener (`buildCaptureScript`), run for real against jsdom login pages in the autoRead harness.
 * Only obvious fakes are typed; nothing here touches a real site.
 */
import { makeEnv, page, type Env } from '../../autoRead/__tests__/igHarness';
import type { Platform } from '../../types';
import { PLATFORMS } from '../../types';
import { buildCaptureScript, CAPTURE_MAX_FIELD, classifyCapture } from '../capture';

const USER = 'jane.fake@example.com';
const PASS = 'hunter2-fake';

const IG_LOGIN = 'https://www.instagram.com/accounts/login/';
const IG_FORM =
  '<form id="f"><input name="username" type="text" id="u"><input type="password" name="password" id="pw">' +
  '<button type="button" id="show">Show</button><a href="#forgot" id="forgot">Forgot password?</a>' +
  '<button type="submit" id="go">Log in</button></form>';

interface Run {
  env: Env;
  doc: Document;
  win: Window & typeof globalThis;
  type(sel: string, value: string): void;
  click(sel: string): void;
  enter(sel: string): void;
  submit(sel?: string): void;
}

/** Loads `html` at `url`, optionally runs the page's own `before` script, then injects the capture script. */
function run(platform: Platform, url: string, html: string, opts: { noBridge?: boolean; before?: string } = {}): Run {
  const env = makeEnv({ url, html: page(html), noBridge: opts.noBridge });
  const doc = env.dom.window.document;
  const win = env.dom.window as unknown as Window & typeof globalThis;
  // Never let jsdom attempt a real form submission.
  doc.addEventListener('submit', (e) => e.preventDefault());
  if (opts.before) env.inject(opts.before);
  env.inject(buildCaptureScript(platform));
  const el = (sel: string) => {
    const found = doc.querySelector(sel);
    if (!found) throw new Error(`no element ${sel}`);
    return found as HTMLElement;
  };
  return {
    env,
    doc,
    win,
    // Like a person typing: the native value setter, then an input event (what React forms listen for).
    type(sel, value) {
      const input = el(sel) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    },
    click(sel) {
      el(sel).click();
    },
    enter(sel) {
      el(sel).dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    },
    submit(sel = 'form') {
      el(sel).dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    },
  };
}

const msg = (platform: Platform, u = USER, p = PASS) => ({ pulse: 'vaultCapture', platform, u, p });

describe('the capture script on Instagram', () => {
  it('posts once per distinct (username, password) pair on a login-button click', () => {
    const r = run('instagram', IG_LOGIN, IG_FORM);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#go');
    expect(r.env.posted).toEqual([msg('instagram')]);

    r.click('#go'); // same values again: nothing new
    expect(r.env.posted).toHaveLength(1);

    r.type('#pw', 'hunter3-fake');
    r.click('#go');
    expect(r.env.posted).toEqual([msg('instagram'), msg('instagram', USER, 'hunter3-fake')]);
  });

  it('posts on Enter in the password field', () => {
    const r = run('instagram', IG_LOGIN, IG_FORM);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.enter('#pw');
    expect(r.env.posted).toEqual([msg('instagram')]);
  });

  it('posts on a form submit event', () => {
    const r = run('instagram', IG_LOGIN, IG_FORM);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.submit();
    expect(r.env.posted).toEqual([msg('instagram')]);
  });

  it('posts once, not twice, when Enter and the submit both fire with the same values', () => {
    const r = run('instagram', IG_LOGIN, IG_FORM);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.enter('#pw');
    r.submit();
    expect(r.env.posted).toEqual([msg('instagram')]);
  });

  it('never fills an emptied username field from an earlier capture', () => {
    const r = run('instagram', IG_LOGIN, IG_FORM);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#go');
    r.type('#u', '');
    r.type('#pw', 'hunter3-fake');
    r.click('#go');
    expect(r.env.posted).toEqual([msg('instagram')]);
  });

  it('ignores an unrelated "Show" button and the "Forgot password?" link', () => {
    const r = run('instagram', IG_LOGIN, IG_FORM);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#show');
    r.click('#forgot');
    expect(r.env.rawPosted).toEqual([]);
  });

  it('installs its listeners once per document: a second injection still posts one message per click', () => {
    const r = run('instagram', IG_LOGIN, IG_FORM);
    r.env.inject(buildCaptureScript('instagram'));
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#go');
    expect(r.env.posted).toEqual([msg('instagram')]);
    r.type('#pw', 'hunter3-fake');
    r.click('#go');
    expect(r.env.posted).toHaveLength(2);
  });

  it('still reads a password field a "show password" toggle switched to type=text', () => {
    const html =
      '<form><input name="username" type="text" id="u"><input type="text" name="password" id="pw">' +
      '<button type="submit" id="go">Log in</button></form>';
    const r = run('instagram', IG_LOGIN, html);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#go');
    expect(r.env.posted).toEqual([msg('instagram')]);
  });
});

describe('the capture script refuses', () => {
  it.each([
    ['an http:// login URL', 'http://www.instagram.com/accounts/login/'],
    ['a look-alike host', 'https://instagram.com.evil.example/accounts/login/'],
    ['a non-login path', 'https://www.instagram.com/explore/'],
    ['a denied segment', 'https://www.instagram.com/accounts/login/two_factor'],
  ])('on %s (%s)', (_why, url) => {
    const r = run('instagram', url, IG_FORM);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#go');
    r.enter('#pw');
    r.submit();
    expect(r.env.rawPosted).toEqual([]);
  });

  it('when a visible one-time-code field sits next to the password', () => {
    const html =
      '<form><input name="username" id="u"><input type="password" name="password" id="pw">' +
      '<input autocomplete="one-time-code" id="code"><button type="submit" id="go">Log in</button></form>';
    const r = run('instagram', IG_LOGIN, html);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#go');
    r.enter('#pw');
    expect(r.env.rawPosted).toEqual([]);
  });

  it.each([
    ['an empty password', USER, ''],
    ['an empty username', '', PASS],
    ['a username longer than the cap', 'u'.repeat(CAPTURE_MAX_FIELD + 1), PASS],
    ['a password longer than the cap', USER, 'p'.repeat(CAPTURE_MAX_FIELD + 1)],
  ])('with %s', (_why, u, p) => {
    const r = run('instagram', IG_LOGIN, IG_FORM);
    if (u) r.type('#u', u);
    if (p) r.type('#pw', p);
    r.click('#go');
    expect(r.env.rawPosted).toEqual([]);
  });

  it('but accepts values exactly at the cap', () => {
    const r = run('instagram', IG_LOGIN, IG_FORM);
    const u = 'u'.repeat(CAPTURE_MAX_FIELD);
    const p = 'p'.repeat(CAPTURE_MAX_FIELD);
    r.type('#u', u);
    r.type('#pw', p);
    r.click('#go');
    expect(r.env.posted).toEqual([msg('instagram', u, p)]);
  });
});

describe('tamper resistance', () => {
  // A hostile page shares the injected script's JS realm and can replace built-ins before the script runs.
  const INDEX_OF = 'String.prototype.indexOf = function () { return 0; };';
  const LOWER = "String.prototype.toLowerCase = function () { return 'www.instagram.com'; };";
  const SOME = 'Array.prototype.some = function () { return true; };';
  const INCLUDES =
    'String.prototype.includes = function () { return true; }; Array.prototype.includes = function () { return true; };';
  const ENDS =
    'String.prototype.endsWith = function () { return true; }; String.prototype.startsWith = function () { return true; };';

  it.each([
    ['String.prototype.indexOf', INDEX_OF],
    ['String.prototype.toLowerCase', LOWER],
    ['Array.prototype.some', SOME],
    ['String/Array.prototype.includes', INCLUDES],
    ['String.prototype.endsWith / startsWith', ENDS],
    ['all of them at once', [INDEX_OF, LOWER, SOME, INCLUDES, ENDS].join('\n')],
  ])('a look-alike host that replaced %s still gets nothing', (_what, before) => {
    const r = run('instagram', 'https://instagram.com.evil.example/accounts/login/', IG_FORM, { before });
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#go');
    r.enter('#pw');
    r.submit();
    expect(r.env.rawPosted).toEqual([]);
  });

  it('control: the same replacements (minus indexOf) on the real login page still capture', () => {
    // indexOf is left out because a fake "found" indexOf makes the one-time-code check refuse everywhere.
    const r = run('instagram', IG_LOGIN, IG_FORM, { before: [LOWER, SOME, INCLUDES, ENDS].join('\n') });
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#go');
    expect(r.env.posted).toEqual([msg('instagram')]);
  });
});

describe('the X two-step flow', () => {
  const STEP1 =
    '<div id="flow"><input autocomplete="username" name="text" type="text" id="u">' +
    '<div role="button" id="next"><span id="nextLabel">Next</span></div></div>';

  it('posts nothing on Next (no password yet), then posts the step-1 username with the step-2 password', () => {
    const r = run('x', 'https://x.com/i/flow/login', STEP1);
    r.type('#u', USER);
    r.click('#nextLabel'); // the tap lands on the label inside the role=button
    expect(r.env.rawPosted).toEqual([]);

    r.doc.getElementById('flow')!.innerHTML =
      `<input autocomplete="username" disabled value="${USER}" id="u2">` +
      '<input type="password" name="password" id="pw"><button id="login"><span>Log in</span></button>';
    r.type('#pw', PASS);
    r.click('#login');
    expect(r.env.posted).toEqual([msg('x')]);
  });

  it('remembers the step-1 username when step 2 does not show it again', () => {
    const r = run('x', 'https://x.com/i/flow/login', STEP1);
    r.type('#u', USER);
    r.click('#next');
    r.doc.getElementById('flow')!.innerHTML =
      '<input type="password" name="password" id="pw">' +
      '<button data-testid="LoginForm_Login_Button" type="button" id="login"><span>Log in</span></button>';
    r.type('#pw', PASS);
    r.click('#login');
    expect(r.env.posted).toEqual([msg('x')]);
  });
});

describe('other platforms', () => {
  it('Facebook (email / pass fields) posts with platform facebook', () => {
    const html =
      '<form><input name="email" type="text" id="u"><input name="pass" type="password" id="pw">' +
      '<button type="submit" name="login" id="go">Log in</button></form>';
    const r = run('facebook', 'https://m.facebook.com/login/', html);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#go');
    expect(r.env.posted).toEqual([msg('facebook')]);
  });

  it('LinkedIn (#username / session_password) posts with platform linkedin', () => {
    const html =
      '<form><input id="username" name="session_key" type="text"><input name="session_password" type="password" id="pw">' +
      '<button type="submit" id="go" aria-label="Sign in">Sign in</button></form>';
    const r = run('linkedin', 'https://www.linkedin.com/login', html);
    r.type('#username', USER);
    r.type('#pw', PASS);
    r.click('#go');
    expect(r.env.posted).toEqual([msg('linkedin')]);
  });
});

describe('the bridge and the message', () => {
  it('does not throw without window.ReactNativeWebView', () => {
    const r = run('instagram', IG_LOGIN, IG_FORM, { noBridge: true });
    expect(() => {
      r.type('#u', USER);
      r.type('#pw', PASS);
      r.click('#go');
      r.enter('#pw');
      r.submit();
    }).not.toThrow();
    expect(r.env.rawPosted).toEqual([]);
  });

  it.each(PLATFORMS)('the %s script carries no username or password and is one IIFE', (platform) => {
    const script = buildCaptureScript(platform);
    expect(script.startsWith('(function () {')).toBe(true);
    expect(script).not.toContain(USER);
    expect(script).not.toContain(PASS);
  });

  it('posts a string with exactly the keys pulse, platform, u, p, which the native side accepts', () => {
    const r = run('instagram', IG_LOGIN, IG_FORM);
    r.type('#u', USER);
    r.type('#pw', PASS);
    r.click('#go');
    expect(r.env.rawPosted).toHaveLength(1);
    const raw = r.env.rawPosted[0];
    expect(typeof raw).toBe('string');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['p', 'platform', 'pulse', 'u']);
    expect(classifyCapture(raw)).toEqual({ kind: 'capture', msg: { platform: 'instagram', u: USER, p: PASS } });
  });
});
