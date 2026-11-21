/**
 * Saved-login filler (docs/VAULT.md). Pure: no react-native import, so it runs under plain Node / jsdom in tests.
 *
 * `buildFillScript(platform, creds)` returns the one script that ever carries a saved username and password. The sign-in
 * sheet injects it into the platform's own login page after the person approved. The script:
 *   - re-checks, inside the page, that it is on the platform's https login page (a redirect between our check and the
 *     injection makes it refuse with `wrong_host`);
 *   - fills the username and password fields it finds (through open shadow roots too), the way React forms notice;
 *   - for two-step flows (X: username, Next, then password) waits for the password field to appear;
 *   - submits, then posts back ONLY `{ pulse: 'vaultFill', platform, status }`. Values are never posted back, logged or
 *     left in a global.
 *
 * `canFill(platform, url)` is the site binding: the only pages a saved login may be typed into. Challenge, two-factor,
 * checkpoint and sign-up screens never qualify; the person finishes those by hand.
 */
import { parsePageUrl } from '@/src/autoRead/platforms';
import type { Platform } from '@/src/types';

export interface FillCreds {
  u: string;
  p: string;
}

export type FillStatus = 'filled' | 'partial' | 'no_form' | 'wrong_host';

export interface FillMessage {
  platform: Platform;
  status: FillStatus;
}

interface FillTarget {
  /** Same domains as the sign-in flow's `hostOk` (autoRead/platforms.ts); a test keeps the two in step. */
  domains: readonly string[];
  /** Login-form paths, matched by whole path segment. Each is also a login path of the flow (`isLogin`). */
  paths: readonly string[];
  /** Platform-specific username field selectors, tried before the generic ones. */
  user: readonly string[];
}

const TARGETS: Record<Platform, FillTarget> = {
  instagram: {
    domains: ['instagram.com'],
    paths: ['/accounts/login'],
    user: ['input[name="username"]', 'input[name="email"]'],
  },
  linkedin: {
    domains: ['linkedin.com'],
    paths: ['/login', '/uas/login', '/m/login'],
    user: ['#username', 'input[name="session_key"]'],
  },
  x: {
    domains: ['x.com', 'twitter.com'],
    paths: ['/i/flow/login', '/login'],
    user: ['input[autocomplete="username"]', 'input[name="text"]'],
  },
  tiktok: {
    domains: ['tiktok.com'],
    paths: ['/login'],
    user: ['input[name="username"]', 'input[type="email"]'],
  },
  reddit: {
    domains: ['reddit.com'],
    paths: ['/login'],
    user: ['input[name="username"]'],
  },
  facebook: {
    domains: ['facebook.com'],
    paths: ['/login', '/login.php'],
    user: ['input[name="email"]'],
  },
};

/** Any path segment containing one of these is a challenge / second-factor / recovery screen: never filled. */
const DENY = ['two_factor', 'two-factor', 'twofactor', '2fa', 'challenge', 'checkpoint', 'verify', 'verification',
  'otp', 'recover', 'reset', 'password', 'signup', 'sign-up', 'register', 'consent', 'suspended', 'captcha', 'code'];

const GENERIC_USER = [
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[type="email"]',
  'input[name="username"]',
  'input[name="email"]',
  'input[name="login"]',
];

const onDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** `/login` matches `/login`, `/login/` and `/login/x`, never `/login-submit`. */
const segmentMatch = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);

function pathFillable(path: string, target: FillTarget): boolean {
  const p = path.toLowerCase();
  if (!target.paths.some((x) => segmentMatch(p, x))) return false;
  const segments = p.split('/').filter(Boolean);
  // The matched login path itself (e.g. "login") is fine; any further segment naming a challenge is not.
  return !segments.some((s) => DENY.some((d) => s.includes(d)));
}

/** True when `url` is the platform's own https login form, the only kind of page a saved login is typed into. */
export function canFill(platform: Platform, url: string | null | undefined): boolean {
  const target = TARGETS[platform];
  if (!target || typeof url !== 'string' || !/^https:\/\//i.test(url.trim())) return false;
  const u = parsePageUrl(url);
  if (!u || !target.domains.some((d) => onDomain(u.host, d))) return false;
  return pathFillable(u.path, target);
}

/** Exposed for the consistency test only. */
export function fillTarget(platform: Platform): Readonly<FillTarget> {
  return TARGETS[platform];
}

/**
 * A value as a JavaScript literal that cannot break out of the script: JSON, plus `<`, `>` and the two JS line
 * separators escaped.
 */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BS = String.fromCharCode(0x5c); // backslash

export function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .split('<').join(`${BS}u003c`)
    .split('>').join(`${BS}u003e`)
    .split(LS).join(`${BS}u2028`)
    .split(PS).join(`${BS}u2029`);
}

export interface FillTiming {
  /** Wait before clicking submit, so a React form has re-rendered (its button enabled) after the input events. */
  submitDelayMs?: number;
  /** Two-step flows: how often, and how many times, to look for the password field. */
  pollMs?: number;
  pollTries?: number;
}

/** The script that fills and submits the login form. The only place a saved login ever leaves secure storage. */
export function buildFillScript(platform: Platform, creds: FillCreds, timing: FillTiming = {}): string {
  const target = TARGETS[platform];
  const submitDelay = timing.submitDelayMs ?? 350;
  const pollMs = timing.pollMs ?? 250;
  const pollTries = timing.pollTries ?? 40;
  const cfg = {
    platform,
    domains: target.domains,
    paths: target.paths,
    deny: DENY,
    user: [...target.user, ...GENERIC_USER],
  };
  // ES5 on purpose: older Android System WebViews. No arrow functions, no let/const, no template strings.
  return `(function () {
  'use strict';
  var K = ${jsLiteral(cfg)};
  var C = ${jsLiteral({ u: creds.u, p: creds.p })};
  var W = (typeof document !== 'undefined' && document.defaultView) || window;
  function post(status) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ pulse: 'vaultFill', platform: K.platform, status: status }));
      }
    } catch (e) {}
  }
  function seg(path, prefix) {
    return path === prefix || path.indexOf(prefix.charAt(prefix.length - 1) === '/' ? prefix : prefix + '/') === 0;
  }
  function here() {
    var host = String(location.hostname || '').toLowerCase();
    var path = String(location.pathname || '/').toLowerCase();
    if (location.protocol !== 'https:') return false;
    var hostOk = false, pathOk = false, i, j;
    for (i = 0; i < K.domains.length; i++) {
      var d = K.domains[i];
      if (host === d || host.slice(-(d.length + 1)) === '.' + d) hostOk = true;
    }
    for (i = 0; i < K.paths.length; i++) if (seg(path, K.paths[i])) pathOk = true;
    var parts = path.split('/');
    for (i = 0; i < parts.length; i++) {
      for (j = 0; j < K.deny.length; j++) if (parts[i] && parts[i].indexOf(K.deny[j]) >= 0) return false;
    }
    return hostOk && pathOk;
  }
  function all(sel) {
    var out = [], stack = [document], seen = 0;
    while (stack.length && seen < 50) {
      var root = stack.pop(); seen++;
      var found = [], kids = [], i;
      try { found = root.querySelectorAll(sel); } catch (e) {}
      for (i = 0; i < found.length; i++) out.push(found[i]);
      try { kids = root.querySelectorAll('*'); } catch (e) {}
      for (i = 0; i < kids.length; i++) if (kids[i].shadowRoot) stack.push(kids[i].shadowRoot);
    }
    return out;
  }
  function usable(el) {
    if (!el || el.disabled || el.readOnly || el.type === 'hidden') return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    try {
      var cs = W.getComputedStyle ? W.getComputedStyle(el) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    } catch (e) {}
    return true;
  }
  function first(sel) {
    var list = all(sel);
    for (var i = 0; i < list.length; i++) if (usable(list[i])) return list[i];
    return null;
  }
  function password() { return first('input[type="password"]'); }
  function username(pw) {
    for (var i = 0; i < K.user.length; i++) {
      var el = first(K.user[i]);
      if (el && el !== pw && el.type !== 'password') return el;
    }
    var form = pw && (pw.form || (pw.closest && pw.closest('form')));
    if (form) {
      var inputs = form.querySelectorAll('input');
      for (var j = 0; j < inputs.length; j++) {
        var t = (inputs[j].type || 'text').toLowerCase();
        if ((t === 'text' || t === 'email' || t === 'tel') && usable(inputs[j])) return inputs[j];
      }
    }
    return null;
  }
  function set(el, value) {
    try { el.focus(); } catch (e) {}
    var proto = W.HTMLInputElement && W.HTMLInputElement.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new W.Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new W.Event('change', { bubbles: true }));
  }
  var WORDS = /^(log ?in|sign ?in|next|continue)$/i;
  function submit(field) {
    var form = field.form || (field.closest && field.closest('form'));
    var btn = null, i;
    if (form) {
      var bs = form.querySelectorAll('button, input[type="submit"]');
      for (i = 0; i < bs.length && !btn; i++) if (bs[i].type === 'submit' && usable(bs[i])) btn = bs[i];
    }
    if (!btn) btn = first('[data-testid="LoginForm_Login_Button"]');
    if (!btn) {
      var cands = all('button, [role="button"]');
      for (i = 0; i < cands.length && !btn; i++) {
        var label = String(cands[i].textContent || cands[i].getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        if (WORDS.test(label) && usable(cands[i])) btn = cands[i];
      }
    }
    if (btn) { btn.click(); return; }
    if (form && form.requestSubmit) form.requestSubmit();
  }
  if (!here()) { C = null; post('wrong_host'); return; }
  var pw = password();
  var us = username(pw);
  if (!pw && !us) { C = null; post('no_form'); return; }
  if (us && C.u) set(us, C.u);
  if (pw) {
    set(pw, C.p);
    C = null;
    setTimeout(function () { submit(pw); post('filled'); }, ${submitDelay});
    return;
  }
  setTimeout(function () {
    submit(us);
    post('partial');
    var tries = 0;
    var poll = function () {
      tries++;
      if (!C) return;
      if (!here()) { C = null; post('wrong_host'); return; }
      var p2 = password();
      if (p2) {
        set(p2, C.p);
        C = null;
        setTimeout(function () { submit(p2); post('filled'); }, ${submitDelay});
        return;
      }
      if (tries >= ${pollTries}) { C = null; post('no_form'); return; }
      setTimeout(poll, ${pollMs});
    };
    setTimeout(poll, ${pollMs});
  }, ${submitDelay});
})();
true;`;
}

const STATUSES: readonly FillStatus[] = ['filled', 'partial', 'no_form', 'wrong_host'];

/** The filler's message, from a WebView `onMessage` string; null for anything else (reader messages, href polls). */
export function takeVaultFill(raw: unknown): FillMessage | null {
  if (typeof raw !== 'string' || raw.length > 500 || raw.indexOf('vaultFill') < 0) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.pulse !== 'vaultFill' || typeof o.platform !== 'string' || !(o.platform in TARGETS)) return null;
  if (!STATUSES.includes(o.status as FillStatus)) return null;
  return { platform: o.platform as Platform, status: o.status as FillStatus };
}
