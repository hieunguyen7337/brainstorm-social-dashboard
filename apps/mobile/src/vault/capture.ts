/**
 * Save-on-sign-in (docs/VAULT.md, "Saved when you sign in"). Pure: no react-native import, so it runs under Node / jsdom.
 *
 * `buildCaptureScript(platform)` is injected ONLY into the Connect sign-in sheet's WebView, and only while the WebView's
 * native URL is the platform's own login form (`canFill`). It listens for the form's submit, a login-button tap and Enter
 * in a field; then, if the page is still that login form (the same tamper-proof `here()` the filler uses) and shows no
 * one-time-code field, it reads the username and password fields and posts them ONCE per distinct value pair as
 * `{ pulse: 'vaultCapture', platform, u, p }`. It keeps nothing in a page global but an install flag.
 *
 * The native side (`makeCaptureHolder`) accepts that message only when the message's native source is the platform's
 * own https origin and the WebView's NATIVE navigation URL passes `canFill`; it keeps the values in memory only and
 * hands them to `save` once the sign-in succeeded (the page settled on a signed-in page of the same platform). A login
 * page again, leaving the platform, closing the sheet, or 2 minutes drop them. `routeSheetMessage` (autoRead/vaultOffer.ts)
 * makes sure the message never reaches the runner, the trace, the console or the remote browser.
 */
import { flowFor, parsePageUrl, type PageUrl } from '@/src/autoRead/platforms';
import { PLATFORMS, type Platform } from '@/src/types';
import { canFill, fillTarget, jsLiteral, PAGE_HELPERS, pageConfig } from './fill';

export const CAPTURE_TAG = 'vaultCapture';
/** A held capture is dropped this long after it was posted, success or not. */
export const CAPTURE_HOLD_MS = 120_000;
/** While a saved-login fill runs, captures are its own submit echoing back: ignored until it reports, at most this long. */
export const FILL_GUARD_MS = 15_000;
/** Same cap as `MAX_FIELD` in index.ts (a test keeps the two in step). */
export const CAPTURE_MAX_FIELD = 512;
/** Longest raw message parsed: two capped fields, fully escaped, plus the envelope. */
const MAX_RAW = 6 * 2 * CAPTURE_MAX_FIELD + 200;

export interface CaptureMessage {
  platform: Platform;
  u: string;
  p: string;
}

// ---- the in-page listener ---------------------------------------------------------------------------------------------

/** The listener script for `platform`'s login page. Carries no secret; installs itself once per document. */
export function buildCaptureScript(platform: Platform): string {
  const cfg = pageConfig(platform);
  // ES5 on purpose: older Android System WebViews. No arrow functions, no let/const, no template strings.
  return `(function () {
  'use strict';
  var K = ${jsLiteral(cfg)};
  var W = (typeof document !== 'undefined' && document.defaultView) || window;
  var FLAG = '__pulseVaultCapture';
  try {
    if (window[FLAG]) return;
    Object.defineProperty(window, FLAG, { value: true });
  } catch (e) { return; }
${PAGE_HELPERS}  var SECRET = ['input[type="password"]', 'input[autocomplete="current-password"]', 'input[name="password"]',
    'input[name="pass"]', 'input[name="session_password"]'];
  var WORDS = /^(log ?in|sign ?in|next|continue)$/i;
  var lastUser = '', lastSent = '';
  function val(el) {
    try { var v = el && el.value; return typeof v === 'string' ? v : ''; } catch (e) { return ''; }
  }
  function secretField() {
    for (var i = 0; i < SECRET.length; i++) {
      var el = first(SECRET[i]);
      if (el) return el;
    }
    return null;
  }
  function userValue(pw) {
    var el = username(pw), i, j, list;
    if (el) return val(el);
    // Two-step flows (X) show the username again in a read-only field on the password step.
    for (i = 0; i < K.user.length; i++) {
      list = all(K.user[i]);
      for (j = 0; j < list.length; j++) if (list[j] !== pw && list[j].type !== 'password' && val(list[j])) return val(list[j]);
    }
    return '';
  }
  function snap() {
    try {
      if (!here() || oneTimeCode()) return;
      var pw = secretField();
      var u = userValue(pw);
      if (u) lastUser = u;
      if (!pw) return;
      var p = val(pw);
      // The step-1 username only when the page has no editable username field (X's password step); a field the person
      // emptied is not filled in from memory.
      if (!u && !username(pw)) u = lastUser;
      if (!u || !p || u.length > ${CAPTURE_MAX_FIELD} || p.length > ${CAPTURE_MAX_FIELD}) return;
      if (u + '\\n' + p === lastSent) return;
      lastSent = u + '\\n' + p;
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ pulse: '${CAPTURE_TAG}', platform: K.platform, u: u, p: p }));
      }
    } catch (e) {}
  }
  function control(el) {
    if (!el || el.nodeType !== 1 || !el.matches) return null;
    try { return el.matches('button, [role="button"], input[type="submit"]') ? el : null; } catch (e) { return null; }
  }
  function onClick(e) {
    try {
      var path = (e.composedPath && e.composedPath()) || [], b = null, i;
      for (i = 0; i < path.length && !b; i++) b = control(path[i]);
      if (!b && e.target && e.target.closest) b = e.target.closest('button, [role="button"], input[type="submit"]');
      if (!b) return;
      var label = String(b.textContent || b.value || (b.getAttribute && b.getAttribute('aria-label')) || '')
        .replace(/\\s+/g, ' ').trim();
      if ((b.type === 'submit' && b.form) || WORDS.test(label) ||
        (b.getAttribute && b.getAttribute('data-testid') === 'LoginForm_Login_Button')) snap();
    } catch (err) {}
  }
  function onKey(e) {
    if (e && (e.key === 'Enter' || e.keyCode === 13) && e.target && e.target.tagName === 'INPUT') snap();
  }
  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', function () { snap(); }, true);
  document.addEventListener('keydown', onKey, true);
})();
true;`;
}

// ---- the message --------------------------------------------------------------------------------------------------------

export type CaptureClass = { kind: 'none' } | { kind: 'junk' } | { kind: 'capture'; msg: CaptureMessage };

/**
 * Sorts a WebView message: `capture` (ours, well formed), `junk` (names the capture tag but is malformed, oversized or
 * odd: swallowed, never passed on, because it may still carry a typed value), or `none` (anything else).
 */
export function classifyCapture(raw: unknown): CaptureClass {
  if (typeof raw !== 'string' || raw.indexOf(CAPTURE_TAG) < 0) return { kind: 'none' };
  if (raw.length > MAX_RAW) return { kind: 'junk' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { kind: 'junk' };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { kind: 'junk' };
  const o = v as Record<string, unknown>;
  if (o.pulse !== CAPTURE_TAG) return 'pulse' in o && typeof o.pulse === 'string' ? { kind: 'none' } : { kind: 'junk' };
  const ok =
    typeof o.platform === 'string' &&
    (PLATFORMS as readonly string[]).includes(o.platform) &&
    typeof o.u === 'string' &&
    typeof o.p === 'string' &&
    o.u.trim() !== '' &&
    o.p !== '' &&
    o.u.length <= CAPTURE_MAX_FIELD &&
    o.p.length <= CAPTURE_MAX_FIELD;
  if (!ok) return { kind: 'junk' };
  return { kind: 'capture', msg: { platform: o.platform as Platform, u: o.u as string, p: o.p as string } };
}

/**
 * The message's native source (react-native-webview's `nativeEvent.url`: the posting frame's origin on current Android
 * WebViews, the main frame's URL otherwise) is the platform's own https site. A third-party iframe on the login page can
 * post to the bridge too; this keeps it from planting a login.
 */
export function captureOriginOk(platform: Platform, sourceUrl: string | null | undefined): boolean {
  if (typeof sourceUrl !== 'string' || !/^https:\/\//i.test(sourceUrl.trim())) return false;
  const u = parsePageUrl(sourceUrl);
  if (!u) return false;
  return fillTarget(platform).domains.some((d) => u.host === d || u.host.endsWith(`.${d}`));
}

// ---- did the sign-in work? --------------------------------------------------------------------------------------------

/** `start`: a load began (WebView `loading: true`); `change`: settled route change; `end`: `onLoadEnd`. */
export type NavKind = 'start' | 'change' | 'end';
export type SignInOutcome = 'success' | 'failed' | 'hold';

/** A screen the person may pass through between the password and the signed-in page: wait, never save or drop. */
const CHALLENGE = ['two_factor', 'two-factor', 'twofactor', 'two_step', 'two-step', '2fa', 'challenge', 'verif', 'otp',
  'code', 'captcha', 'approval', 'access'];
/** Screens shown only after a password was accepted ("save your login info?"). */
const ACCEPTED = ['onetap', 'save-device'];

const samePath = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/\/+$/, '') === b.toLowerCase().replace(/\/+$/, '');

/**
 * Where a settled page leaves a captured login. `from` is the login page it was typed on; `reloaded` says a new document
 * load began since. Success: a signed-in page of the same platform. Failed: the login form again (another login URL, or
 * the same one loaded anew), any other login-flow screen, or another site. Hold: challenge / 2FA screens, the same page
 * reported again, and pages that prove nothing yet.
 */
export function signInOutcome(
  platform: Platform,
  url: string | null | undefined,
  from: PageUrl,
  kind: NavKind,
  reloaded: boolean,
): SignInOutcome {
  if (kind === 'start') return 'hold';
  const u = parsePageUrl(url);
  if (!u) return 'hold';
  const flow = flowFor(platform);
  if (!flow.hostOk(u)) return 'failed';
  const segs = u.path.toLowerCase().split('/').filter(Boolean);
  const anyHas = (words: readonly string[]) => segs.some((s) => words.some((w) => s.includes(w)));
  if (anyHas(ACCEPTED)) return 'success';
  if (flow.isLogin(u)) {
    if (anyHas(CHALLENGE)) return 'hold';
    if (anyHas(['login', 'signin'])) {
      const same = u.host === from.host && samePath(u.path, from.path);
      return same && !(kind === 'end' && reloaded) ? 'hold' : 'failed';
    }
    if (anyHas(['checkpoint'])) return 'hold';
    return 'failed';
  }
  return flow.pastLogin(u) ? 'success' : 'hold';
}

// ---- the native holder ------------------------------------------------------------------------------------------------

export interface CaptureHolderDeps {
  platform: Platform;
  /** Stores the login (the vault's `saveLogin`). Called at most once per capture, only after the sign-in worked. */
  save(username: string, password: string): Promise<void>;
  onSaved?(): void;
  onSaveFailed?(): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface CaptureHolder {
  /** Every WebView `onNavigationStateChange` (`start` while loading, else `change`) and `onLoadEnd` (`end`). */
  native(url: string | null | undefined, kind: NavKind): void;
  /** The page's own answer to the href poll, with the message's native source: may settle a held capture. */
  pageHref(url: string, sourceUrl: string | null | undefined): void;
  /** A capture message from the page, with the message's native source. True when it is now held. */
  offer(msg: CaptureMessage, sourceUrl: string | null | undefined): boolean;
  /** A saved-login fill is about to be injected: what it submits is not a new login. */
  fillStarted(): void;
  /** The fill reported filled / no_form / wrong_host. */
  fillEnded(): void;
  /** Yes/no only (never the values). */
  holding(): boolean;
  /** Sheet closed: drop everything, accept nothing more. */
  dispose(): void;
}

export function makeCaptureHolder(deps: CaptureHolderDeps): CaptureHolder {
  const setT = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let held: { u: string; p: string; from: PageUrl; reloaded: boolean } | null = null;
  let nativeUrl: string | null = null;
  let filling = false;
  let disposed = false;
  let holdTimer: unknown = null;
  let fillTimer: unknown = null;

  const stop = (id: unknown) => {
    if (id !== null && id !== undefined) clearT(id);
  };
  const drop = () => {
    held = null;
    stop(holdTimer);
    holdTimer = null;
  };
  const settle = (outcome: SignInOutcome) => {
    if (!held || outcome === 'hold') return;
    const { u, p } = held;
    drop();
    if (outcome !== 'success') return;
    // Already handed off: a save that started finishes even if the sheet closes meanwhile (so does its notice).
    deps.save(u, p).then(
      () => deps.onSaved?.(),
      () => deps.onSaveFailed?.(),
    );
  };
  const judge = (url: string | null | undefined, kind: NavKind) => {
    if (!held) return;
    let outcome: SignInOutcome;
    try {
      outcome = signInOutcome(deps.platform, url, held.from, kind, held.reloaded);
    } catch {
      outcome = 'failed';
    }
    settle(outcome);
  };

  return {
    native(url, kind) {
      if (disposed) return;
      if (typeof url === 'string') nativeUrl = url;
      if (!held) return;
      if (kind === 'start') {
        held.reloaded = true;
        return;
      }
      judge(url, kind);
    },
    pageHref(url, sourceUrl) {
      if (disposed || !held || !captureOriginOk(deps.platform, sourceUrl)) return;
      judge(url, 'change');
    },
    offer(msg, sourceUrl) {
      if (disposed || filling || !msg || msg.platform !== deps.platform) return false;
      if (!captureOriginOk(deps.platform, sourceUrl) || !canFill(deps.platform, nativeUrl)) return false;
      const from = parsePageUrl(nativeUrl);
      if (!from) return false;
      drop();
      held = { u: msg.u, p: msg.p, from, reloaded: false };
      holdTimer = setT(() => {
        holdTimer = null;
        held = null;
      }, CAPTURE_HOLD_MS);
      return true;
    },
    fillStarted() {
      if (disposed) return;
      drop();
      filling = true;
      stop(fillTimer);
      fillTimer = setT(() => {
        fillTimer = null;
        filling = false;
      }, FILL_GUARD_MS);
    },
    fillEnded() {
      filling = false;
      stop(fillTimer);
      fillTimer = null;
    },
    holding: () => held !== null,
    dispose() {
      disposed = true;
      drop();
      stop(fillTimer);
      fillTimer = null;
      nativeUrl = null;
    },
  };
}
