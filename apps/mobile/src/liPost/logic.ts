/**
 * "Post on LinkedIn" on Android, automatic: the pure parts (no react-native import, so it runs under plain Node and jest).
 *
 * Today the Android button hands the text to LinkedIn's composer (androidShare.ts) and the person still taps LinkedIn's
 * Post. This is the Instagram design (src/igPost) applied to LinkedIn: after a "Post to LinkedIn now?" confirm, the
 * in-app WebView that is already signed in to linkedin.com (the same cookie store as "Sign in and read my numbers")
 * publishes a text post, the caption with its tracked link, through the same endpoint LinkedIn's own web app uses.
 *
 * Nothing here reads, logs or returns a cookie or token value: the injected script reads the JSESSIONID cookie only to
 * send it back to linkedin.com as the `csrf-token` header (what LinkedIn's web app does, and what the reader in
 * src/autoRead already does), and reports booleans, status codes, a share URN and a short redacted error.
 */

/** Where the posting WebView starts; LinkedIn redirects to its sign-in page there when the person is signed out. */
export const LI_HOME_URL = 'https://www.linkedin.com/feed/';

/** The endpoint LinkedIn's web app posts a share to, and the fallback tried when it answers with another 4xx. */
export const LI_POST_ENDPOINT = 'https://www.linkedin.com/voyager/api/contentcreation/normShares';
export const LI_FALLBACK_ENDPOINT = 'https://www.linkedin.com/voyager/api/voyagerContentcreationDashShares?action=createShare';

/** LinkedIn refuses posts longer than this (characters). */
export const LI_MAX_CHARS = 3000;
/** A post that has not answered after this long is reported as failed (the person can check LinkedIn). */
export const LI_POST_TIMEOUT_MS = 60_000;
/** Each request the script makes gives up after this long (so the page itself reports a stuck request). */
export const LI_FETCH_TIMEOUT_MS = 25_000;
/** How often the posting sheet asks the page whether the person is signed in. */
export const LI_PROBE_MS = 1_500;
/** Longest error text kept from a response body. */
export const LI_SNIPPET_CHARS = 200;

/** Prefix of every message the posting scripts send, so other page messages are ignored. */
export const LI_MSG = 'pulse-li';

/** A share URN as LinkedIn returns it; also what `liPostUrl` accepts. */
export const LI_URN_SRC = 'urn:li:(?:activity|share|ugcPost):\\d{6,30}';
const LI_URN_EXACT = new RegExp(`^${LI_URN_SRC}$`);

/**
 * Looks like a token: JSESSIONID values are `ajax:<digits>`, anything else is a long unbroken run of letters, digits and
 * `_ - + =` (field names in LinkedIn's errors stay under 32 characters, so they remain readable).
 */
const TOKEN_SRC = '(?:ajax:[-\\d]+|bearer\\s+\\S+|[A-Za-z0-9_+=-]{32,})';
const TOKEN_RE = new RegExp(TOKEN_SRC, 'gi');

/** An error text with anything token-like replaced, whitespace squeezed and cut to `LI_SNIPPET_CHARS`. */
export function redactSnippet(s: unknown, max: number = LI_SNIPPET_CHARS): string {
  const text = typeof s === 'string' ? s : '';
  return text.replace(TOKEN_RE, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** null when LinkedIn takes this text, otherwise what is wrong (shown as is). */
export function liTextProblem(text: string): string | null {
  if (!text.trim()) return 'Write something first, then post it.';
  if (Array.from(text).length > LI_MAX_CHARS) return 'LinkedIn posts can have at most 3,000 characters.';
  return null;
}

/** Shared by the injected scripts: post one JSON message, read one cookie, tell which linkedin.com page this is. */
const PAGE_HELPERS = String.raw`
function pulsePost(o) {
  o.t = ${JSON.stringify(LI_MSG)};
  try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
}
function pulseCookie(name) {
  var parts = String(document.cookie || '').split(';');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/^ +/, '');
    if (p.indexOf(name + '=') === 0) {
      try { return decodeURIComponent(p.slice(name.length + 1)); } catch (e) { return ''; }
    }
  }
  return '';
}
function pulseCsrf() {
  return pulseCookie('JSESSIONID').replace(/^"+|"+$/g, '');
}
function pulseOnLinkedIn() {
  return /(^|\.)linkedin\.com$/.test(location.hostname) && location.protocol === 'https:';
}
function pulseOnWww() {
  return location.hostname === 'www.linkedin.com' && location.protocol === 'https:';
}
function pulseLoginPage() {
  return /^\/(login|uas\/|checkpoint|authwall|signup|start\/join|m\/login)/i.test(String(location.pathname || ''));
}
`;

/**
 * Asks the page whether the person is signed in. Answers `{ t, kind: 'state', onLi, signedIn, settled }` (booleans only).
 * `settled` is false off www.linkedin.com (the post is a same-origin request there) and on sign-in or checkpoint pages.
 */
export const LI_STATE_PROBE_JS = `(function () {
${PAGE_HELPERS}
var login = pulseLoginPage();
pulsePost({
  kind: 'state',
  onLi: pulseOnLinkedIn(),
  signedIn: pulseOnLinkedIn() && !login && !!pulseCsrf(),
  settled: pulseOnWww() && !login
});
})();
true;`;

// JSON is valid JS; U+2028/2029 (LS, PS) are escaped for engines that predate ES2019.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/**
 * The script that publishes `text` as a public text post.
 *
 * Design (what LinkedIn's web app sends from the feed's "Start a post", same-origin, with the session cookies the
 * WebView keeps):
 *   POST https://www.linkedin.com/voyager/api/contentcreation/normShares
 *     headers: csrf-token = the JSESSIONID cookie value with its quotes removed, x-restli-protocol-version: 2.0.0,
 *              accept: application/vnd.linkedin.normalized+json+2.1, content-type: application/json; charset=UTF-8
 *     body:    {"visibleToConnectionsOnly":false,"externalAudienceProviders":[],"commentaryV2":{"text":TEXT,"attributes":[]},
 *               "origin":"FEED","allowedCommentersScope":"ALL","postState":"PUBLISHED","media":[]}
 *   Any 2xx is a published post; the response is searched for a share URN (urn:li:share:N / urn:li:activity:N).
 *   A 4xx other than 401, 403 and 429 (the endpoint or body shape changed) is followed once by the fallback
 *   (`voyagerContentcreationDashShares?action=createShare`, body shape below; a guess, see the report of this unit).
 * It answers `{ t, kind: 'result', ok: true, urn, via, firstStatus }` or `{ ok: false, stage, status, firstStatus,
 * message, firstMessage }` (`stage`: 'page' | 'signed-out' | 'post' | 'network' | 'script'; `message` is the first 200
 * characters of the last response body with anything token-like replaced). Never sends the cookie or token anywhere
 * but back to linkedin.com. Known risks: LinkedIn changes these private endpoints without notice and may refuse a
 * session it considers automated (401/403, or a checkpoint page); a request that times out here may still have posted.
 */
export function buildLiPostScript(text: string): string {
  const problem = liTextProblem(text);
  if (problem) throw new Error(problem);
  const params = {
    text,
    url: LI_POST_ENDPOINT,
    fallbackUrl: LI_FALLBACK_ENDPOINT,
    urnRe: LI_URN_SRC,
    tokenRe: TOKEN_SRC,
    snippet: LI_SNIPPET_CHARS,
    fetchMs: LI_FETCH_TIMEOUT_MS,
  };
  const json = JSON.stringify(params).split(LS).join('\\u2028').split(PS).join('\\u2029');
  return `(function () {
'use strict';
var P = ${json};
${PAGE_HELPERS}
function redact(s, csrf) {
  s = typeof s === 'string' ? s : '';
  if (csrf) s = s.split(csrf).join('[redacted]');
  return s.replace(new RegExp(P.tokenRe, 'gi'), '[redacted]').replace(/\\s+/g, ' ').replace(/^ | $/g, '').slice(0, P.snippet);
}
function fail(stage, status, first, text, firstText, csrf) {
  pulsePost({
    kind: 'result', ok: false, stage: stage, status: status, firstStatus: first,
    message: text ? redact(text, csrf) : undefined,
    firstMessage: firstText ? redact(firstText, csrf) : undefined
  });
}
function normBody() {
  return {
    visibleToConnectionsOnly: false,
    externalAudienceProviders: [],
    commentaryV2: { text: P.text, attributes: [] },
    origin: 'FEED',
    allowedCommentersScope: 'ALL',
    postState: 'PUBLISHED',
    media: []
  };
}
function dashBody() {
  return {
    allowedCommentersScope: 'ALL',
    intendedShareLifeCycleState: 'PUBLISHED',
    origin: 'FEED',
    visibilityDataUnion: { visibilityType: 'ANYONE' },
    commentary: { text: P.text, attributesV2: [] }
  };
}
async function send(url, body, csrf) {
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctl ? setTimeout(function () { ctl.abort(); }, P.fetchMs) : 0;
  try {
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'csrf-token': csrf,
        'x-restli-protocol-version': '2.0.0',
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'content-type': 'application/json; charset=UTF-8',
        'x-li-lang': 'en_US'
      },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined
    });
    var text = '';
    try { text = await res.text(); } catch (e) {}
    return { ok: res.ok, status: res.status, text: text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function done(r, via, first) {
  var m = new RegExp(P.urnRe).exec(r.text || '');
  pulsePost({ kind: 'result', ok: true, urn: m ? m[0] : null, via: via, firstStatus: first });
}
async function run() {
  if (!pulseOnWww()) return fail('page', 0, null, 'not on www.linkedin.com', '', '');
  var csrf = pulseCsrf();
  if (pulseLoginPage() || !csrf) return fail('signed-out', 0, null, '', '', '');
  var first;
  try {
    first = await send(P.url, normBody(), csrf);
  } catch (e) {
    return fail('network', 0, null, String(e && e.message || e), '', csrf);
  }
  if (first.ok) return done(first, 'norm', null);
  var s = first.status;
  if (s < 400 || s >= 500 || s === 401 || s === 403 || s === 429) return fail('post', s, null, first.text, '', csrf);
  var second;
  try {
    second = await send(P.fallbackUrl, dashBody(), csrf);
  } catch (e) {
    return fail('network', 0, s, String(e && e.message || e), first.text, csrf);
  }
  if (second.ok) return done(second, 'dash', s);
  return fail('post', second.status, s, second.text, first.text, csrf);
}
if (window.__pulseLiPosting) return;
window.__pulseLiPosting = true;
run().catch(function (e) {
  fail('script', 0, null, String(e && e.message || e), '', '');
}).then(function () {
  window.__pulseLiPosting = false;
});
})();
true;`;
}

export interface LiFailure {
  ok: false;
  /** 'page' | 'signed-out' | 'post' | 'network' | 'script' | 'timeout' | 'webview' (the last two come from the sheet). */
  stage: string;
  /** HTTP status of the last request, 0 when there was none. */
  status: number;
  /** Status of the first request when a fallback request followed it. */
  firstStatus: number | null;
  /** First 200 characters of the last response body, token-like parts replaced. */
  message: string | null;
  /** The same for the first response, when a fallback request followed it. */
  firstMessage: string | null;
}

export type LiMessage =
  | { kind: 'state'; signedIn: boolean; onLi: boolean; settled: boolean }
  | { kind: 'result'; ok: true; urn: string | null; via: 'norm' | 'dash' | null; firstStatus: number | null }
  | ({ kind: 'result' } & LiFailure);

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const snippet = (v: unknown): string | null => (typeof v === 'string' && v ? redactSnippet(v) || null : null);

/** A message from the posting scripts, or null for anything else (other page messages, junk). */
export function parseLiMessage(data: string): LiMessage | null {
  let o: unknown;
  try {
    o = JSON.parse(data);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const m = o as Record<string, unknown>;
  if (m.t !== LI_MSG) return null;
  if (m.kind === 'state') {
    return { kind: 'state', signedIn: m.signedIn === true, onLi: m.onLi === true, settled: m.settled === true };
  }
  if (m.kind !== 'result') return null;
  const first = typeof m.firstStatus === 'number' && Number.isFinite(m.firstStatus) ? m.firstStatus : null;
  if (m.ok === true) {
    const urn = typeof m.urn === 'string' && LI_URN_EXACT.test(m.urn) ? m.urn : null;
    const via = m.via === 'norm' || m.via === 'dash' ? m.via : null;
    return { kind: 'result', ok: true, urn, via, firstStatus: first };
  }
  return {
    kind: 'result',
    ok: false,
    stage: typeof m.stage === 'string' ? m.stage.slice(0, 32) : 'unknown',
    status: num(m.status),
    firstStatus: first,
    message: snippet(m.message),
    firstMessage: snippet(m.firstMessage),
  };
}

/** What the sheet reports when the page never answered. */
export function liTimeoutFailure(): LiFailure {
  return { ok: false, stage: 'timeout', status: 0, firstStatus: null, message: null, firstMessage: null };
}

/** The public link of a published post (null for anything that is not a share URN). */
export function liPostUrl(urn: string | null): string | null {
  return urn && LI_URN_EXACT.test(urn) ? `https://www.linkedin.com/feed/update/${urn}/` : null;
}

/** What the person reads when auto-posting failed; the LinkedIn composer is always the way out. */
export function liFailureText(m: Pick<LiFailure, 'stage' | 'status'> & Partial<LiFailure>): string {
  const instead = 'Use "Open LinkedIn instead".';
  switch (m.stage) {
    case 'signed-out':
      return 'LinkedIn signed you out. Sign in again, or use "Open LinkedIn instead".';
    case 'timeout':
      return "LinkedIn didn't answer. Check your LinkedIn feed before trying again: it may have posted.";
    case 'network':
      return `Couldn't reach LinkedIn from here. ${instead}`;
    case 'post': {
      if (m.status === 401 || m.status === 403) {
        return `LinkedIn refused the post from here (it may have signed you out). ${instead}`;
      }
      if (m.status === 429) return `LinkedIn says to slow down. Try again later. ${instead}`;
      const codes = m.firstStatus ? `${m.firstStatus}, then ${m.status}` : `${m.status}`;
      const said = [m.firstMessage, m.message].filter((x): x is string => !!x);
      const detail = said.length ? ` It said: ${said.map((x) => `"${x.slice(0, 120)}"`).join(' / ')}.` : '';
      return `LinkedIn refused the post (${codes}).${detail} ${instead}`;
    }
    default:
      return `Couldn't post from here. ${instead}`;
  }
}
