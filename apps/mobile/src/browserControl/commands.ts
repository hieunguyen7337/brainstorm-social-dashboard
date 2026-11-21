/**
 * "Let Claude use your phone's browser": the pure part. Commands come from the Pulse API's queue (apps/api/app/routes/
 * browser.py), this file checks them, turns page commands into the script injected into the WebView, and reads the
 * page's answer back. No imports at all, so it runs under plain Node (commands.test.mjs).
 *
 * Coordinates: Claude sees screenshots `shot.w` x `shot.h` pixels and clicks in those pixels. The page works in CSS
 * pixels, so the app sends fractions of the viewport (fx, fy) and the page multiplies by innerWidth/innerHeight. The
 * screenshot covers exactly the WebView, so the fractions line up.
 *
 * Safety (also enforced server side): only https pages open, a password or one-time-code field is never typed into,
 * and nothing the page answers with includes cookies, storage or HTML: only visible text, labels, a url and a title.
 */

export type BrowserAction =
  | 'open'
  | 'back'
  | 'click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'screenshot'
  | 'read_text'
  | 'elements';

export const ACTIONS: readonly BrowserAction[] = [
  'open',
  'back',
  'click',
  'type',
  'press',
  'scroll',
  'screenshot',
  'read_text',
  'elements',
];

/** Actions that run as a script inside the page. The others are handled by the app (load, back, capture). */
export const PAGE_ACTIONS: readonly BrowserAction[] = ['click', 'type', 'press', 'scroll', 'read_text', 'elements'];

export const KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
] as const;

export interface BrowserCommand {
  id: string;
  action: BrowserAction;
  args: Record<string, unknown>;
}

/** What the app posts to /api/browser/results/{id}. Never cookies or passwords. */
export interface BrowserResult {
  ok: boolean;
  text?: string;
  url?: string;
  title?: string;
  error?: string;
  image_jpeg_base64?: string;
  width?: number;
  height?: number;
  data?: unknown;
}

export interface ShotSize {
  w: number;
  h: number;
}

/** Screenshots are at most this many pixels wide: enough to read, cheap for Claude to look at. */
export const SHOT_MAX_WIDTH = 720;
export const MAX_TEXT = 30_000;
/** Message tag the injected scripts use; the app ignores every other message. */
export const MESSAGE_TAG = 'pulseBrowserCtl';

/** Only https pages (plus the blank start page) may load in the controlled browser. */
export function allowedUrl(url: string): boolean {
  return /^https:\/\/[^/\s]+/i.test(url) || url === 'about:blank' || url.startsWith('data:text/html');
}

/** The size of the screenshot for a WebView laid out at `w` x `h` points on a screen with `ratio` pixels per point. */
export function shotSize(w: number, h: number, ratio: number, maxW: number = SHOT_MAX_WIDTH): ShotSize {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const px = w * (ratio > 0 ? ratio : 1);
  const scale = Math.min(1, maxW / px);
  return { w: Math.max(1, Math.round(px * scale)), h: Math.max(1, Math.round(h * (ratio > 0 ? ratio : 1) * scale)) };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A command from the server, checked again on the phone. Returns the command or an error to send back. */
export function parseCommand(raw: unknown): { cmd: BrowserCommand } | { error: string; id?: string } {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return { error: 'malformed command' };
  const id = raw.id;
  const action = raw.action as BrowserAction;
  if (!ACTIONS.includes(action)) return { id, error: `unknown action ${String(raw.action)}` };
  const args = isObj(raw.args) ? raw.args : {};
  if (action === 'open' && (typeof args.url !== 'string' || !/^https:\/\//i.test(args.url))) {
    return { id, error: 'Only https:// pages can be opened.' };
  }
  if (action === 'type' && (typeof args.text !== 'string' || !args.text)) return { id, error: 'Nothing to type.' };
  if (action === 'press' && !(KEYS as readonly string[]).includes(String(args.key))) {
    return { id, error: `Unsupported key ${String(args.key)}` };
  }
  return { cmd: { id, action, args } };
}

/** The args the page script gets: click x/y in screenshot pixels become fractions of the viewport. */
export function pageArgs(cmd: BrowserCommand, shot: ShotSize): Record<string, unknown> {
  const a = cmd.args;
  if (cmd.action !== 'click' || typeof a.x !== 'number' || typeof a.y !== 'number') return a;
  const { x, y, ...rest } = a;
  const fx = shot.w > 0 ? (x as number) / shot.w : 0;
  const fy = shot.h > 0 ? (y as number) / shot.h : 0;
  return { ...rest, fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
}

export interface PageElement {
  tag: string;
  label: string;
  role?: string;
  type?: string;
  secret?: boolean;
  fx: number;
  fy: number;
}

/** The page's element list with fractions turned into screenshot pixels, ready for browser_click. */
export function elementsInShotPixels(list: unknown, shot: ShotSize): Record<string, unknown>[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isObj).map((e) => {
    const { fx, fy, ...rest } = e as unknown as PageElement;
    return { ...rest, x: Math.round(Number(fx) * shot.w), y: Math.round(Number(fy) * shot.h) };
  });
}

/** One line for the banner: what Claude is doing right now. Typed text is shown so the person sees it. */
export function describeCommand(cmd: BrowserCommand): string {
  const a = cmd.args;
  const short = (s: unknown, n = 40) => {
    const t = String(s ?? '');
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  switch (cmd.action) {
    case 'open': {
      const host = /^https:\/\/([^/?#]+)/i.exec(String(a.url ?? ''));
      return `Opening ${host ? host[1] : 'a page'}`;
    }
    case 'back':
      return 'Going back';
    case 'click':
      if (typeof a.text === 'string') return `Tapping "${short(a.text)}"`;
      if (typeof a.selector === 'string') return `Tapping ${short(a.selector)}`;
      return 'Tapping the screen';
    case 'type':
      return `Typing "${short(a.text)}"`;
    case 'press':
      return `Pressing ${String(a.key)}`;
    case 'scroll':
      return Number(a.dy) < 0 ? 'Scrolling up' : 'Scrolling down';
    case 'screenshot':
      return 'Looking at the page';
    case 'read_text':
      return 'Reading the page';
    case 'elements':
      return 'Finding buttons and fields';
  }
}

/** Query parameters whose values are credentials or one-time codes (OAuth, magic links, one-time codes). */
const SENSITIVE_KEYS = new Set([
  'code', 'token', 'access_token', 'id_token', 'refresh_token', 'otp', 'passcode', 'pin', 'password', 'pass', 'pwd',
  'secret', 'session', 'sessionid', 'sid', 'auth', 'signature', 'sig', 'api_key', 'key', 'verification_code',
  'one_time_code',
]);

/** Exact names above, or any name ending in a credential word (oauth_token, reset-token, api_key, jwt...). */
const SENSITIVE_SUFFIXES = ['token', 'secret', 'password', 'passwd', 'otp', 'code', 'signature', 'sig', 'key', 'jwt'];
const sensitiveKey = (name: string) => {
  const k = unescapeKey(name).toLowerCase().replace(/-/g, '_');
  return SENSITIVE_KEYS.has(k) || SENSITIVE_SUFFIXES.some((suffix) => k.endsWith(suffix));
};

const unescapeKey = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

/**
 * A page address as it may leave the phone: no user:password@ part, no #fragment (OAuth implicit tokens live there),
 * and the value of every sensitive query parameter replaced by REDACTED. The server applies the same rules
 * (apps/api/app/routes/browser.py `_public_url`).
 */
export function safeUrl(url: string): string {
  const m = /^(https?:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(url);
  if (!m) return url.replace(/[?#].*$/, '');
  const [, scheme, authority, path, query] = m;
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  const pairs = (query ?? '')
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((piece) => {
      const eq = piece.indexOf('=');
      const name = eq < 0 ? piece : piece.slice(0, eq);
      return sensitiveKey(name) ? `${name}=REDACTED` : piece;
    });
  return `${scheme}${host}${path}${pairs.length ? `?${pairs.join('&')}` : ''}`;
}

/** A sign-in, two-step or challenge page, by its address. A page that shows a password field is caught separately. */
const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|sign_in|checkpoint|challenge|two-?factor|2fa|verify|password|otp)(\/|$)/i;
const LOGIN_HOST = /^(accounts|login|auth|sso|signin)\./i;
export function loginUrl(url: string): boolean {
  const m = /^https?:\/\/([^/?#]*)([^?#]*)/i.exec(url);
  if (!m) return false;
  const host = m[1].slice(m[1].lastIndexOf('@') + 1);
  return LOGIN_HOST.test(host) || LOGIN_PATH.test(m[2]);
}

/** After a `type` command the phone stays quiet for this long: no screenshot, so a typed value cannot be seen. */
export const FILL_QUIET_MS = 10_000;

/** Whether a screenshot must be refused now. `secretOnPage` is null when the page could not be checked (fails closed). */
export function captureBlock(p: { url: string; now: number; lastFillAt: number; secretOnPage: boolean | null }): string | null {
  if (p.now - p.lastFillAt < FILL_QUIET_MS) return 'No screenshot for 10 s after Claude types into a field. Try again shortly.';
  if (p.secretOnPage === true) return 'No screenshot while a password or code field is on screen.';
  if (loginUrl(p.url)) return 'No screenshot of a sign-in page. Ask the user to look at their phone.';
  if (p.secretOnPage === null) return 'The page did not answer the sign-in check, so no screenshot was taken. Try again.';
  return null;
}

/** Reads the answer of an `elements` probe: true when a password or code field is on screen, null when unknown. */
export function pageHasSecret(r: BrowserResult): boolean | null {
  if (!r.ok || !Array.isArray(r.data)) return null;
  return r.data.some((e) => isObj(e) && e.secret === true);
}

/** The page's answer to a script, or null when the message is not one of ours (or not for `id`). */
export function parsePageMessage(data: string, id?: string): (BrowserResult & { id: string }) | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObj(msg) || msg.tag !== MESSAGE_TAG || typeof msg.id !== 'string') return null;
  if (id !== undefined && msg.id !== id) return null;
  const out: BrowserResult & { id: string } = { id: msg.id, ok: msg.ok === true };
  if (typeof msg.text === 'string') out.text = msg.text.slice(0, MAX_TEXT);
  if (typeof msg.error === 'string') out.error = msg.error.slice(0, 500);
  if (typeof msg.url === 'string') out.url = safeUrl(msg.url);
  if (typeof msg.title === 'string') out.title = msg.title.slice(0, 300);
  if (msg.data !== undefined) out.data = msg.data;
  return out;
}

/** The script injected for a page action. It always posts exactly one message tagged MESSAGE_TAG with the command id. */
export function pageScript(cmd: BrowserCommand, shot: ShotSize): string {
  const payload = JSON.stringify({ id: cmd.id, action: cmd.action, args: pageArgs(cmd, shot), tag: MESSAGE_TAG });
  return `(function(){var CMD=${payload};${PAGE_LIB}})();true;`;
}

/**
 * The in-page library. Plain ES2017 run by Android's WebView; `CMD` is defined by pageScript. It reads only what is on
 * screen (text, labels, positions) and never cookies, storage or form values other than the one field it types into.
 * Written with String.raw so its regular expressions keep their backslashes; it contains no backticks or `${`.
 */
const PAGE_LIB = String.raw`
var A = CMD.args || {};
function post(r) {
  r.tag = CMD.tag; r.id = CMD.id; r.url = location.href; r.title = document.title;
  window.ReactNativeWebView.postMessage(JSON.stringify(r));
}
function vw() { return window.innerWidth || document.documentElement.clientWidth; }
function vh() { return window.innerHeight || document.documentElement.clientHeight; }
function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function attr(el, n) { return (el && el.getAttribute && el.getAttribute(n)) || ''; }
function label(el) {
  if (!el) return '';
  var t = attr(el, 'aria-label') || attr(el, 'title') || attr(el, 'placeholder') || attr(el, 'alt');
  if (!t) t = el.innerText || (el.tagName === 'INPUT' && !isSecret(el) ? el.value : '') || '';
  return clean(t).slice(0, 80);
}
function visible(el) {
  var r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  var s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
}
function inView(r) { return r.bottom > 0 && r.right > 0 && r.top < vh() && r.left < vw(); }
var CLICKABLE = 'a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],' +
  '[role=option],[role=checkbox],[role=switch],[role=textbox],[contenteditable=""],[contenteditable=true],[tabindex]';
function clickable(el) { return (el.closest && el.closest(CLICKABLE)) || el; }
function isField(el) { return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable); }
function isSecret(el) {
  if (!el || !el.getAttribute) return false;
  var type = attr(el, 'type').toLowerCase();
  var ac = attr(el, 'autocomplete').toLowerCase();
  var name = (attr(el, 'name') + ' ' + (el.id || '')).toLowerCase();
  if (type === 'password' || /password|one-time-code/.test(ac)) return true;
  return el.tagName === 'INPUT' && /passw|passcode|otp|one.?time/.test(name);
}
function describe(el) {
  var l = label(el);
  var tag = el.tagName ? el.tagName.toLowerCase() : 'element';
  return l ? tag + ' "' + l + '"' : tag;
}
function byText(text) {
  var want = clean(text).toLowerCase();
  var all = document.querySelectorAll('body *');
  var exact = [], part = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var t = clean(attr(el, 'aria-label') || el.innerText || attr(el, 'placeholder') || attr(el, 'title') ||
      attr(el, 'alt')).toLowerCase();
    if (!t) continue;
    if (t === want) exact.push(el);
    else if (t.length <= want.length + 40 && t.indexOf(want) >= 0) part.push(el);
  }
  function best(list) {
    var b = null, ba = Infinity;
    for (var j = 0; j < list.length; j++) {
      var e = list[j];
      if (!visible(e)) continue;
      var r = e.getBoundingClientRect();
      var area = r.width * r.height + (inView(r) ? 0 : 1e9);
      if (area < ba) { ba = area; b = e; }
    }
    return b;
  }
  return best(exact) || best(part);
}
function fire(el, type, o) {
  try {
    var E = type.indexOf('pointer') === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
    el.dispatchEvent(new E(type, o));
  } catch (e) {}
}
function tap(el, x, y) {
  if (x == null) {
    var r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > vh() || r.left < 0 || r.right > vw()) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      r = el.getBoundingClientRect();
    }
    x = r.left + r.width / 2; y = r.top + r.height / 2;
  }
  var o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0,
    pointerId: 1, pointerType: 'touch', isPrimary: true };
  fire(el, 'pointerdown', o); fire(el, 'mousedown', o);
  var f = clickable(el);
  if (f.focus) { try { f.focus({ preventScroll: true }); } catch (e) {} }
  fire(el, 'pointerup', o); fire(el, 'mouseup', o); fire(el, 'click', o);
}
function selectorEl() {
  try { return document.querySelector(A.selector); } catch (e) { return undefined; }
}
function valueSetter(el) {
  var proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, 'value').set;
}
function run() {
  var el;
  if (CMD.action === 'read_text') {
    return post({ ok: true, text: (document.body ? document.body.innerText : '').slice(0, 30000) });
  }
  if (CMD.action === 'click') {
    var x = null, y = null;
    if (typeof A.fx === 'number') {
      x = A.fx * vw(); y = A.fy * vh();
      el = document.elementFromPoint(x, y);
      if (!el) return post({ ok: false, error: 'Nothing at that point.' });
    } else if (A.selector) {
      el = selectorEl();
      if (el === undefined) return post({ ok: false, error: 'Bad CSS selector.' });
      if (!el) return post({ ok: false, error: 'No element matches ' + A.selector });
    } else {
      el = byText(A.text);
      if (!el) return post({ ok: false, error: 'No visible element with the text "' + A.text + '".' });
      el = clickable(el);
    }
    tap(el, x, y);
    return post({ ok: true, text: describe(clickable(el)) });
  }
  if (CMD.action === 'type') {
    if (A.selector) {
      el = selectorEl();
      if (el === undefined) return post({ ok: false, error: 'Bad CSS selector.' });
      if (!el) return post({ ok: false, error: 'No element matches ' + A.selector });
    } else {
      el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    }
    if (!el || el === document.body || el === document.documentElement) {
      return post({ ok: false, error: 'No text field is focused: click the field first, or pass a selector.' });
    }
    if (isSecret(el)) {
      return post({ ok: false, error: 'Refused: this is a password or code field. Ask the user to type it on the phone.' });
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.focus();
      valueSetter(el).call(el, (A.clear ? '' : el.value) + A.text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: A.text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return post({ ok: true, text: describe(el) });
    }
    var ed = el.isContentEditable ? el : el.querySelector && el.querySelector('[contenteditable=""],[contenteditable=true]');
    if (!ed) return post({ ok: false, error: 'The focused element (' + describe(el) + ') does not take text.' });
    ed.focus();
    var sel = window.getSelection();
    if (A.clear) {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    } else if (sel && !ed.contains(sel.anchorNode)) {
      var range = document.createRange();
      range.selectNodeContents(ed); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
    }
    var lines = String(A.text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) document.execCommand('insertParagraph', false);
      if (lines[i] && !document.execCommand('insertText', false, lines[i])) {
        ed.appendChild(document.createTextNode(lines[i]));
        ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: lines[i] }));
      }
    }
    return post({ ok: true, text: describe(ed) });
  }
  if (CMD.action === 'press') {
    var CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37,
      ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35 };
    var k = A.key;
    el = document.activeElement || document.body;
    var ko = { key: k, code: k, keyCode: CODES[k], which: CODES[k], bubbles: true, cancelable: true };
    var go = el.dispatchEvent(new KeyboardEvent('keydown', ko));
    if (k === 'Enter') el.dispatchEvent(new KeyboardEvent('keypress', ko));
    el.dispatchEvent(new KeyboardEvent('keyup', ko));
    if (go) {
      if (k === 'Enter' && el.tagName === 'INPUT' && el.form) {
        if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
      } else if (k === 'Enter' && (el.tagName === 'A' || el.tagName === 'BUTTON')) el.click();
      else if (k === 'PageDown') window.scrollBy(0, vh() * 0.85);
      else if (k === 'PageUp') window.scrollBy(0, -vh() * 0.85);
      else if (k === 'Home' && !isField(el)) window.scrollTo(0, 0);
      else if (k === 'End' && !isField(el)) window.scrollTo(0, document.body.scrollHeight);
      else if (k === 'Escape' && el.blur) el.blur();
      else if (k === 'Backspace' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !isSecret(el)) {
        valueSetter(el).call(el, el.value.slice(0, -1));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      } else if (k === 'Backspace' && el.isContentEditable) document.execCommand('delete', false);
      else if (k === 'Tab') {
        var f = Array.prototype.filter.call(document.querySelectorAll(CLICKABLE), function (n) {
          return visible(n) && n.tabIndex >= 0 && !n.disabled;
        });
        var at = f.indexOf(el);
        var nx = f[(at + 1) % (f.length || 1)];
        if (nx && nx.focus) nx.focus();
      }
    }
    return post({ ok: true, text: describe(document.activeElement || el) });
  }
  if (CMD.action === 'scroll') {
    var dx = Number(A.dx) || 0, dy = Number(A.dy) || 0;
    var se = document.scrollingElement || document.documentElement;
    var target = se, before = se.scrollTop, beforeX = se.scrollLeft;
    window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    if (se.scrollTop === before && se.scrollLeft === beforeX) {
      var n = document.elementFromPoint(vw() / 2, vh() / 2);
      while (n && n !== document.body && n !== document.documentElement) {
        var cs = getComputedStyle(n);
        if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) &&
            (n.scrollHeight > n.clientHeight + 2 || n.scrollWidth > n.clientWidth + 2)) {
          n.scrollBy({ left: dx, top: dy, behavior: 'instant' });
          target = n;
          break;
        }
        n = n.parentElement;
      }
    }
    var max = Math.max(0, target.scrollHeight - target.clientHeight);
    return post({ ok: true, text: 'scrolled to ' + Math.round(target.scrollTop) + ' of ' + Math.round(max) + ' px' });
  }
  if (CMD.action === 'elements') {
    var out = [];
    var nodes = document.querySelectorAll(CLICKABLE + ',[onclick]');
    for (var j = 0; j < nodes.length && out.length < 80; j++) {
      var e = nodes[j];
      if (!visible(e)) continue;
      var r = e.getBoundingClientRect();
      if (!inView(r)) continue;
      var cx = Math.max(0, Math.min(vw() - 1, r.left + r.width / 2));
      var cy = Math.max(0, Math.min(vh() - 1, r.top + r.height / 2));
      var top = document.elementFromPoint(cx, cy);
      if (top && top !== e && !e.contains(top) && !top.contains(e)) continue;
      if (r.width * r.height > 0.4 * vw() * vh() && !isField(e)) continue; // a whole card or page wrapper
      var item = { tag: e.tagName.toLowerCase(), label: label(e), fx: cx / vw(), fy: cy / vh() };
      if (attr(e, 'role')) item.role = attr(e, 'role');
      if (e.tagName === 'INPUT') item.type = attr(e, 'type') || 'text';
      if (isSecret(e)) item.secret = true;
      out.push(item);
    }
    return post({ ok: true, data: out });
  }
  return post({ ok: false, error: 'Unknown page action ' + CMD.action });
}
try { run(); } catch (err) { post({ ok: false, error: 'Page script failed: ' + String(err && err.message || err) }); }
`;
