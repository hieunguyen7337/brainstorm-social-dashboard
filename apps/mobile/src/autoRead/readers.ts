/**
 * Page-side "readers" for the in-app "sign in and read my numbers" flow (docs/REAL.md, unit R3).
 *
 * `readerScript(platform, step, ctx?, opts?)` returns one self-contained JavaScript string. The runner passes it to
 * `WebView.injectJavaScript(script)` on an already-loaded page of the platform; the script reads the signed-in
 * person's OWN numbers and posts back exactly one `PageMessage` (see `types.ts`) through `window.ReactNativeWebView`.
 *
 * Every generated script:
 * - runs only on the platform's own hosts (anywhere else it does nothing) and does nothing without the bridge;
 * - posts one message per injection; a second injection of the same `platform:step` while the first still runs
 *   does nothing (`window.__pulseAutoRead`), and after it has posted a new injection may run again;
 * - is ES2017 at most (no `?.`, no `??`, no object spread: stale Android WebViews exist) and ends with `true;`;
 * - reads only what `PageMessage` documents: `innerText` capped at 20000 chars, or JSON fields pruned to a whitelist.
 *   It never touches cookies, web storage, form-field values, tokens or page HTML, and never logs;
 * - makes no network request except the same-origin GETs listed per platform, each with an 8 s timeout (less when
 *   the script's own deadline is nearer, so every reader posts by `READER_DEADLINE_MS`, plus the settle for text readers);
 * - never throws into the page: an exception becomes `status: 'error'`.
 *
 * The page code lives in `String.raw` templates so regex backslashes reach the page untouched. Keep it free of
 * backticks and `${`, and keep to the rules above (no logging, no `?.`/`??`, no storage or cookie access).
 */
import type { Platform, StepCtx } from './types';

/** Each script's own polling deadline (ms, measured from injection) before it posts status `empty`. */
export const READER_DEADLINE_MS = 10000;

/** Per-request timeout (AbortController). A request also never outlives the script's deadline: see `fetchText`. */
const FETCH_TIMEOUT_MS = 8000;
/** DOM readers look again this often until their data is found or the deadline passes. */
const POLL_MS = 500;
/** Once the labels appear, wait this long and read once more so late-rendering numbers are included. */
const SETTLE_MS = 1200;
/** First read happens this long after injection: lets a freshly loaded page hydrate and absorbs a double `onLoadEnd`. */
const START_DELAY_MS = 250;
/** Cap on the page text a reader may post. */
const TEXT_CAP = 20000;

interface ReaderDef {
  /** Registrable hosts; the page's hostname must equal one or be a subdomain of one. */
  hosts: readonly string[];
  /** Uses `fetchText` (adds `FETCH_MS`). */
  net?: boolean;
  /** Uses `readText` and `bodyText` (adds `SETTLE_MS`, `TEXT_CAP`). */
  text?: boolean;
  /** Takes `ctx.handle` (adds `CTX_HANDLE`). */
  handle?: boolean;
  /** Platform code: defines `async function run()`, which must end in exactly one `finish(...)` call. */
  body: string;
}

// ---- shared page code -----------------------------------------------------------------------------------------------

/** Always included: host/path helpers, timing, and the one place a message is posted. */
const CORE = String.raw`
var W = window;
var KEY = PLATFORM + ':' + STEP;
var T0 = Date.now();
var bridge = null;
var done = false;

function lower(s) {
  return String(s === null || s === undefined ? '' : s).toLowerCase();
}
function isObj(v) {
  return !!v && typeof v === 'object';
}
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}
function cut(s, n) {
  if (s.length <= n) return s;
  var c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}
function hostAllowed() {
  var h = lower(location.hostname).replace(/\.$/, '');
  for (var i = 0; i < HOSTS.length; i++) {
    var base = HOSTS[i];
    if (h === base) return true;
    if (h.length > base.length + 1 && h.slice(h.length - base.length - 1) === '.' + base) return true;
  }
  return false;
}
function pathIs() {
  var p = lower(location.pathname);
  for (var i = 0; i < arguments.length; i++) {
    var b = arguments[i];
    if (p === b || p.indexOf(b + '/') === 0 || p.indexOf(b + '.') === 0) return true;
  }
  return false;
}
function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}
function remaining() {
  return DEADLINE_MS - (Date.now() - T0);
}
function tick() {
  return sleep(Math.max(0, Math.min(POLL_MS, remaining())));
}
function finish(status, data) {
  if (done) return;
  done = true;
  try {
    W.__pulseAutoRead[KEY] = false;
  } catch (e) {}
  try {
    var msg = { pulse: 'autoRead', platform: PLATFORM, step: STEP, status: status };
    if (data !== undefined && (status === 'ok' || status === 'empty')) msg.data = data;
    bridge.postMessage(JSON.stringify(msg));
  } catch (e) {}
}
`;

/**
 * Same-origin GET with `credentials: 'include'`. The AbortController timeout covers the body read too and is 8 s, or the
 * time left before the script's deadline if that is shorter (so two slow requests cannot push a reader past it).
 */
const NET = String.raw`
async function fetchText(url, headers) {
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = 0;
  var limit = Math.max(0, Math.min(FETCH_MS, remaining()));
  var timeout = new Promise(function (resolve, reject) {
    timer = setTimeout(function () {
      try {
        if (ctl) ctl.abort();
      } catch (e) {}
      reject(new Error('timeout'));
    }, limit);
  });
  var work = (async function () {
    var init = { credentials: 'include' };
    if (headers) init.headers = headers;
    if (ctl) init.signal = ctl.signal;
    var res = await fetch(url, init);
    var text = await res.text();
    return { ok: res.ok, status: res.status, text: text };
  })();
  work.catch(function () {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
function asJson(text) {
  try {
    var v = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch (e) {
    return null;
  }
}
`;

/** Poll the page text until it matches, settle, read once more, post it. `build(text)` makes the `ok` data. */
const TEXT = String.raw`
function bodyText() {
  var b = document.body;
  var t = b ? b.innerText : '';
  return typeof t === 'string' ? cut(t, TEXT_CAP) : '';
}
function hasPasswordInput() {
  return !!document.querySelector('input[type="password"]');
}
async function readText(pattern, signedOut, build) {
  for (;;) {
    if (signedOut()) return finish('signed_out');
    var text = bodyText();
    if (pattern.test(text)) {
      await sleep(SETTLE_MS);
      if (signedOut()) return finish('signed_out');
      var again = bodyText();
      return finish('ok', build(pattern.test(again) ? again : text));
    }
    if (remaining() <= 0) return finish('empty');
    await tick();
  }
}
`;

/** Last, after the platform code is defined: host guard, bridge check, double-injection guard, then run. */
const START = String.raw`
function start() {
  try {
    if (!hostAllowed()) return;
    bridge = W.ReactNativeWebView;
    if (!bridge || typeof bridge.postMessage !== 'function') return;
    if (!isObj(W.__pulseAutoRead)) W.__pulseAutoRead = {};
    if (W.__pulseAutoRead[KEY]) return;
    W.__pulseAutoRead[KEY] = true;
  } catch (e) {
    return;
  }
  try {
    sleep(START_DELAY_MS)
      .then(run)
      .then(
        function () {
          finish('error');
        },
        function () {
          finish('error');
        }
      );
  } catch (e) {
    finish('error');
  }
}
start();
`;

// ---- platform code --------------------------------------------------------------------------------------------------

/**
 * Instagram: two same-origin GETs. `current_user` says who is signed in (else `signed_out`; 429/5xx/timeouts are
 * `error`, not `signed_out`); `web_profile_info` gives the numbers (any failure there is `empty` with the username).
 */
const INSTAGRAM_0 = String.raw`
var IG_HEADERS = { 'x-ig-app-id': '936619743392459' };

function igCounter(dst, key, src) {
  var c = isObj(src) ? num(src.count) : undefined;
  if (c !== undefined) dst[key] = { count: c };
}
function igNode(n) {
  var o = {};
  var t = num(n.taken_at_timestamp);
  if (t !== undefined) o.taken_at_timestamp = t;
  if (typeof n.is_video === 'boolean') o.is_video = n.is_video;
  var v = num(n.video_view_count);
  if (v !== undefined) o.video_view_count = v;
  igCounter(o, 'edge_liked_by', n.edge_liked_by);
  igCounter(o, 'edge_media_preview_like', n.edge_media_preview_like);
  igCounter(o, 'edge_media_to_comment', n.edge_media_to_comment);
  var cap = n.edge_media_to_caption;
  var first = isObj(cap) && Array.isArray(cap.edges) && isObj(cap.edges[0]) ? cap.edges[0].node : null;
  if (isObj(first) && typeof first.text === 'string') {
    o.edge_media_to_caption = { edges: [{ node: { text: cut(first.text, 200) } }] };
  }
  return o;
}
function igUser(u, fallbackName) {
  var o = { username: typeof u.username === 'string' ? u.username : fallbackName };
  igCounter(o, 'edge_followed_by', u.edge_followed_by);
  igCounter(o, 'edge_follow', u.edge_follow);
  var m = u.edge_owner_to_timeline_media;
  if (isObj(m)) {
    var media = {};
    var c = num(m.count);
    if (c !== undefined) media.count = c;
    if (Array.isArray(m.edges)) {
      media.edges = [];
      for (var i = 0; i < m.edges.length && i < 12; i++) {
        if (isObj(m.edges[i]) && isObj(m.edges[i].node)) media.edges.push({ node: igNode(m.edges[i].node) });
      }
    }
    o.edge_owner_to_timeline_media = media;
  }
  return o;
}
// A cookie the page can read ('' when absent). ds_user_id (the signed-in account's id) and csrftoken are readable.
function igCookie(name) {
  var parts = String(document.cookie || '').split(';');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/^ +/, '');
    if (p.indexOf(name + '=') === 0) {
      try {
        return decodeURIComponent(p.slice(name.length + 1));
      } catch (e) {
        return '';
      }
    }
  }
  return '';
}
// Instagram's own web app sends these; without them current_user can answer 400/403 to a signed-in page (2026-11-21).
function igHeaders() {
  var h = { 'x-ig-app-id': IG_HEADERS['x-ig-app-id'], 'x-requested-with': 'XMLHttpRequest', 'x-asbd-id': '129477' };
  var csrf = igCookie('csrftoken');
  if (csrf) h['x-csrftoken'] = csrf;
  return h;
}
var IG_RESERVED = ['explore', 'reels', 'reel', 'direct', 'accounts', 'stories', 'p', 'tv', 'about', 'legal', 'web', 'developer', 'challenge'];
// The signed-in account's name from the navigation bar (the bar holding the Explore and Reels links): its last link to a
// one-segment path that is not one of Instagram's own pages. Story avatars sit outside that bar, so they are never taken.
function igNavUsername() {
  var out = { name: '', signedIn: false };
  try {
    var anchor = document.querySelector('a[href="/explore/"]') || document.querySelector('a[href="/reels/"]');
    if (!anchor) return out;
    out.signedIn = !!document.querySelector('a[href^="/direct/"]');
    var box = anchor.parentElement;
    for (var up = 0; box && up < 8; up++) {
      if (box.querySelectorAll('a[href]').length >= 4) break;
      box = box.parentElement;
    }
    if (!box) return out;
    var links = box.querySelectorAll('a[href]');
    for (var i = links.length - 1; i >= 0; i--) {
      var m = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(links[i].getAttribute('href') || '');
      if (m && IG_RESERVED.indexOf(m[1].toLowerCase()) < 0) {
        out.name = m[1];
        out.signedIn = true;
        break;
      }
    }
  } catch (e) {}
  return out;
}
// "1,234" -> 1234, "1.2K" -> 1200, "3M" -> 3000000; undefined when it is not a count.
function igAbbr(s) {
  var m = /^([0-9][0-9.,]*)\s*([KkMmBb]?)$/.exec(String(s || '').replace(/ /g, ' ').trim());
  if (!m) return undefined;
  var unit = lower(m[2]);
  var n = unit ? parseFloat(m[1].replace(/,/g, '')) : parseInt(m[1].replace(/[.,]/g, ''), 10);
  if (!isFinite(n)) return undefined;
  if (unit === 'k') n *= 1e3;
  else if (unit === 'm') n *= 1e6;
  else if (unit === 'b') n *= 1e9;
  return Math.round(n);
}
var IG_NUM = '([0-9][0-9.,]*\\s?[KkMmBb]?)';
// Followers, following and posts from profile text: the meta description first, then the visible header.
function igCountsFromText(text) {
  var s = String(text || '').replace(/ /g, ' ');
  var m = new RegExp(IG_NUM + '\\s+Followers?,\\s*' + IG_NUM + '\\s+Following,\\s*' + IG_NUM + '\\s+Posts?', 'i').exec(s);
  if (m) {
    var f = igAbbr(m[1]), g = igAbbr(m[2]), p = igAbbr(m[3]);
    if (f !== undefined) return { followers: f, following: g, posts: p };
  }
  function one(word) {
    var r = new RegExp(IG_NUM + '\\s*' + word + '\\b', 'i').exec(s);
    return r ? igAbbr(r[1]) : undefined;
  }
  var fol = one('followers?');
  if (fol === undefined) return null;
  return { followers: fol, following: one('following'), posts: one('posts?') };
}
function igMeta(doc) {
  var out = [];
  try {
    var metas = doc.querySelectorAll('meta[property="og:description"], meta[name="description"]');
    for (var i = 0; i < metas.length; i++) out.push(metas[i].getAttribute('content') || '');
  } catch (e) {}
  return out.join('\n');
}
function igMetaFromHtml(html) {
  var out = [];
  var re = /<meta[^>]+(?:property|name)="(?:og:description|description)"[^>]*>/gi;
  var m;
  while ((m = re.exec(String(html || ''))) && out.length < 4) {
    var c = /content="([^"]*)"/i.exec(m[0]);
    if (c) out.push(c[1].replace(/&#0?44;/g, ',').replace(/&amp;/g, '&'));
  }
  return out.join('\n');
}
async function igJson(path) {
  try {
    var r = await fetchText(path, igHeaders());
    return { status: r.status, json: r.ok ? asJson(r.text) : null };
  } catch (e) {
    return { status: 0, json: null };
  }
}
async function run() {
  var a = await igJson('/api/v1/accounts/current_user/?edit=true');
  var aj = a.json;
  var username = aj && isObj(aj.user) && typeof aj.user.username === 'string' ? aj.user.username : '';
  // Second way to the username: the account id cookie and that account's info.
  var info = null;
  var uid = igCookie('ds_user_id');
  var cStatus = -1;
  if (!username && /^[0-9]{1,30}$/.test(uid)) {
    var c = await igJson('/api/v1/users/' + uid + '/info/');
    cStatus = c.status;
    if (c.json && isObj(c.json.user)) {
      info = c.json.user;
      if (typeof info.username === 'string') username = info.username;
    }
  }
  // Third way: the profile tab of the page's own navigation bar links to /<username>/ (2026-11-21: on a signed-in phone
  // both calls above gave no username and the sheet looped on the feed).
  // The bar may not be drawn yet when the script lands: wait for it, leaving time for the profile call.
  var nav = igNavUsername();
  var navT0 = Date.now();
  while (!username && !nav.name && Date.now() - navT0 < 6000 && remaining() > 3500) {
    await tick();
    nav = igNavUsername();
  }
  if (!username && nav.name) username = nav.name;
  // Which step failed, for the app log: status codes and yes/no only, never a cookie value.
  var diag = { a: a.status, c: cStatus, uid: !!uid, csrf: !!igCookie('csrftoken'), nav: !!nav.name, bar: nav.signedIn, path: location.pathname };
  if (!username) {
    if (a.status === 0 || a.status === 429 || a.status >= 500) return finish('error');
    // Signed out only when the page has no account cookie and no signed-in navigation bar.
    return finish(uid || nav.signedIn ? 'empty' : 'signed_out', { diag: diag });
  }
  var user = null;
  try {
    var b = await igJson('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username));
    diag.b = b.status;
    var bj = b.json;
    if (bj && isObj(bj.data) && isObj(bj.data.user)) user = bj.data.user;
  } catch (e) {
    user = null;
  }
  // The account info already carries the counts in a flat shape: use them when the profile call fails.
  if (!user && info && num(info.follower_count) !== undefined) {
    user = {
      username: username,
      edge_followed_by: { count: num(info.follower_count) },
      edge_follow: { count: num(info.following_count) },
      edge_owner_to_timeline_media: { count: num(info.media_count) },
    };
  }
  // Last way before a screenshot: the profile page's own text ("12 Followers, 34 Following, 5 Posts"), which Instagram
  // serves even when its data calls answer 400/429/404 (2026-11-21, on the owner's phone).
  if (!user) {
    var counts = null;
    if (pathIs('/' + lower(username))) counts = igCountsFromText(igMeta(document) + '\n' + String((document.body && document.body.innerText) || ''));
    if (!counts && remaining() > 1500) {
      try {
        var h = await fetchText('/' + encodeURIComponent(username) + '/', { accept: 'text/html' });
        diag.h = h.status;
        if (h.ok) counts = igCountsFromText(igMetaFromHtml(h.text));
      } catch (e) {}
    }
    diag.t = !!counts;
    if (counts) {
      user = {
        username: username,
        edge_followed_by: { count: counts.followers },
        edge_follow: { count: counts.following },
        edge_owner_to_timeline_media: { count: counts.posts },
      };
    }
  }
  if (!user) return finish('empty', { username: username, diag: diag });
  finish('ok', { user: igUser(user, username) });
}
`;

/**
 * TikTok: the profile page embeds its data as JSON in one script tag. Read that tag; if the page was reached by a
 * client-side redirect (tag has no userInfo but the path is already /@name), fetch the profile HTML once and take
 * the same tag from it. Depth is counted from the blob root; the search looks at nodes down to depth 6.
 */
const TIKTOK_0 = String.raw`
var TT_TAG = '__UNIVERSAL_DATA_FOR_REHYDRATION__';
var TT_HTML = /<script[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/;
var TT_STATS = ['followerCount', 'followingCount', 'heartCount', 'videoCount'];
var ttRaw = null;
var ttInfo = null;

function ttStats(src) {
  if (!isObj(src)) return null;
  var o = {};
  var any = false;
  for (var i = 0; i < TT_STATS.length; i++) {
    var v = src[TT_STATS[i]];
    if (num(v) !== undefined || (typeof v === 'string' && v.length <= 32)) {
      o[TT_STATS[i]] = v;
      any = true;
    }
  }
  return any ? o : null;
}
function ttHasStats(i) {
  return isObj(i) && (isObj(i.stats) || isObj(i.statsV2));
}
function ttFind(node, depth) {
  if (!isObj(node) || depth > 6) return null;
  if (ttHasStats(node.userInfo)) return node.userInfo;
  var keys = Object.keys(node);
  for (var i = 0; i < keys.length; i++) {
    var hit = ttFind(node[keys[i]], depth + 1);
    if (hit) return hit;
  }
  return null;
}
function ttPick(blob) {
  var scope = blob.__DEFAULT_SCOPE__;
  var detail = isObj(scope) ? scope['webapp.user-detail'] : null;
  var info = isObj(detail) && ttHasStats(detail.userInfo) ? detail.userInfo : ttFind(blob, 0);
  if (!info) return null;
  var stats = ttStats(info.stats);
  var statsV2 = ttStats(info.statsV2);
  if (!stats && !statsV2) return null;
  var out = { user: {} };
  if (isObj(info.user) && typeof info.user.uniqueId === 'string') out.user.uniqueId = info.user.uniqueId;
  if (stats) out.stats = stats;
  if (statsV2) out.statsV2 = statsV2;
  return out;
}
function ttFromTag() {
  var el = document.getElementById(TT_TAG);
  var raw = el ? el.textContent : null;
  if (typeof raw !== 'string' || !raw) return null;
  if (raw !== ttRaw) {
    ttRaw = raw;
    var blob = asJson(raw);
    ttInfo = blob ? ttPick(blob) : null;
  }
  return ttInfo;
}
async function ttFallback() {
  try {
    var r = await fetchText(location.pathname);
    var m = r.ok ? TT_HTML.exec(r.text) : null;
    var blob = m ? asJson(m[1]) : null;
    var info = blob ? ttPick(blob) : null;
    if (info) finish('ok', { userInfo: info });
  } catch (e) {}
}
async function run() {
  var tried = false;
  while (!done) {
    if (pathIs('/login', '/signup')) return finish('signed_out');
    var info = ttFromTag();
    if (info) return finish('ok', { userInfo: info });
    if (!tried && /^\/@[^\/]+\/?$/.test(location.pathname)) {
      tried = true;
      ttFallback();
    }
    if (remaining() <= 0) return finish('empty');
    await tick();
  }
}
`;

/**
 * LinkedIn, shared by both steps: the login-page test, the guest-page test and the profile id in the address.
 * A phone WebView lands on /feed/ after signing in, and /dashboard/ may not be served to every account on mobile web
 * (2026-11-21: LinkedIn still failed on the owner's phone with a reader that only ran on /dashboard/), so nothing here
 * depends on one page.
 */
const LINKEDIN_COMMON = String.raw`
var LI_ID = /^[^\s\/?#%"'\\<>&]{1,100}$/;
function liLoginPage() {
  return pathIs('/login', '/checkpoint', '/authwall', '/uas', '/signup', '/m/login') || hasPasswordInput();
}
// A guest (signed-out) page: links to sign in or join, which signed-in pages do not carry.
function liGuest() {
  try {
    return !!document.querySelector(
      'a[href*="/login"], a[href*="/signup"], a[href*="session_redirect"], form[action*="login"], a[href*="/start/join"]'
    );
  } catch (e) {
    return false;
  }
}
// The profile id in /in/<id>/ ('' elsewhere, and for the /in/me/ shortcut).
function liPathId() {
  var m = /^\/in\/([^\/?#]+)/.exec(location.pathname);
  if (!m) return '';
  var id = m[1];
  try {
    id = decodeURIComponent(id);
  } catch (e) {}
  return LI_ID.test(id) && lower(id) !== 'me' ? id : '';
}
var LI_PROFILE = /\d[\d.,]*\s?[KkMmBb]?\+?\s+(?:followers?|connections?)(?![A-Za-z])/i;
var LI_DASH = /post impressions|total followers|profile viewers|search appearances/i;
`;

/**
 * LinkedIn step 0, on whichever signed-in page the person is on (usually /feed/). Same-origin GETs to LinkedIn's own
 * Voyager API, the way its web app makes them: /voyager/api/me gives the public profile id, .../networkinfo the
 * follower and connection counts. The API wants the JSESSIONID cookie's value (quotes removed) as its `csrf-token`
 * header; that value is sent only to linkedin.com and never posted. On the dashboard or the person's own profile the
 * page text comes along too. Posts `ok` whenever the person is signed in, even with no numbers: the app then opens
 * the profile (step 1). `signed_out` only on a login page, or when the API refuses and the page is a guest page.
 */
const LINKEDIN_0 = String.raw`
function liCookie(name) {
  var parts = String(document.cookie || '').split(';');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/^ +/, '');
    if (p.indexOf(name + '=') === 0) {
      try {
        return decodeURIComponent(p.slice(name.length + 1));
      } catch (e) {
        return '';
      }
    }
  }
  return '';
}
function liCsrf() {
  return liCookie('JSESSIONID').replace(/^"+|"+$/g, '');
}
async function liJson(path, csrf) {
  try {
    var r = await fetchText(path, {
      'csrf-token': csrf,
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': 'en_US',
    });
    return { status: r.status, json: r.ok ? asJson(r.text) : null };
  } catch (e) {
    return { status: 0, json: null };
  }
}
// Breadth-first: the shallowest value stored under key that passes test (at most 4000 nodes, depth 8).
function liFind(root, key, test) {
  var queue = [root];
  var depth = [0];
  for (var seen = 0; seen < queue.length && seen < 4000; seen++) {
    var v = queue[seen];
    var d = depth[seen];
    if (!isObj(v)) continue;
    if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, key) && test(v[key])) return v[key];
    if (d >= 8) continue;
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) {
      if (isObj(v[keys[i]])) {
        queue.push(v[keys[i]]);
        depth.push(d + 1);
      }
    }
  }
  return undefined;
}
function liIsId(s) {
  return typeof s === 'string' && LI_ID.test(s) && lower(s) !== 'me';
}
function liIsCount(n) {
  return num(n) !== undefined && n >= 0;
}
async function liWaitText(pattern, maxMs) {
  var t0 = Date.now();
  for (;;) {
    var text = bodyText();
    if (pattern.test(text)) {
      await sleep(Math.min(SETTLE_MS, Math.max(0, remaining() - 300)));
      var again = bodyText();
      return pattern.test(again) ? again : text;
    }
    if (Date.now() - t0 >= maxMs || remaining() <= 500) return '';
    await tick();
  }
}
async function run() {
  if (liLoginPage()) return finish('signed_out');
  var csrf = liCsrf();
  var diag = { path: location.pathname, csrf: !!csrf, me: -1 };
  var me = csrf ? await liJson('/voyager/api/me', csrf) : { status: -1, json: null };
  diag.me = me.status;
  // Only the API names the signed-in account: an /in/<id>/ address may be someone else's profile.
  var pid = (me.json ? liFind(me.json, 'publicIdentifier', liIsId) : undefined) || '';
  diag.id = !!pid;
  if (!pid && (me.status === -1 || me.status === 401 || me.status === 403) && liGuest()) {
    return finish('signed_out');
  }
  var out = { publicId: pid || null, diag: diag };
  if (pid && csrf && remaining() > 2500) {
    var ni = await liJson('/voyager/api/identity/profiles/' + encodeURIComponent(pid) + '/networkinfo', csrf);
    diag.ni = ni.status;
    var f = ni.json ? liFind(ni.json, 'followersCount', liIsCount) : undefined;
    var c = ni.json ? liFind(ni.json, 'connectionsCount', liIsCount) : undefined;
    if (f !== undefined) out.followers = f;
    if (c !== undefined) out.connections = c;
  }
  // The page's own numbers: the creator dashboard, or the person's own profile.
  if (pathIs('/dashboard') && remaining() > 1500) {
    var dt = await liWaitText(LI_DASH, 6000);
    if (dt) {
      out.page = 'dashboard';
      out.text = dt;
    }
  } else if (pid && lower(liPathId()) === lower(pid) && remaining() > 1500) {
    var pt = await liWaitText(LI_PROFILE, 6000);
    if (pt) {
      out.page = 'profile';
      out.text = pt;
    }
  }
  diag.text = !!out.text;
  finish('ok', out);
}
`;

/**
 * LinkedIn step 1, on the person's own profile (/in/<id>/, or /in/me/ which LinkedIn redirects there): wait for
 * "500+ connections" / "1,234 followers", settle, post the page text. Nothing found by the deadline is `empty` with a
 * `diag` (the app then sends a screenshot of this page).
 */
const LINKEDIN_1 = String.raw`
async function run() {
  for (;;) {
    if (liLoginPage()) return finish('signed_out');
    var text = bodyText();
    if (LI_PROFILE.test(text)) {
      await sleep(SETTLE_MS);
      if (liLoginPage()) return finish('signed_out');
      var again = bodyText();
      return finish('ok', {
        publicId: liPathId() || null,
        page: 'profile',
        text: LI_PROFILE.test(again) ? again : text,
        diag: { path: location.pathname, text: true },
      });
    }
    if (remaining() <= 0) {
      if (liGuest() && !liPathId()) return finish('signed_out');
      return finish('empty', { publicId: liPathId() || null, diag: { path: location.pathname, text: false, len: text.length, guest: liGuest() } });
    }
    await tick();
  }
}
`;

/**
 * X step 0 (/home): find the signed-in handle in the navigation. Paths are matched on whole segments, so a handle
 * that merely starts with "login" is not mistaken for the login page.
 */
const X_COMMON = String.raw`
var X_RESERVED = [
  'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose', 'search',
  'login', 'logout', 'tos', 'privacy', 'hashtag', 'intent', 'share',
];
function xValid(h) {
  return typeof h === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(h) && X_RESERVED.indexOf(h.toLowerCase()) === -1;
}
function xSignedOut() {
  return pathIs('/i/flow', '/login');
}
`;

const X_0 = String.raw`
function xFromHref(href) {
  if (typeof href !== 'string') return null;
  var m = /^(?:https?:\/\/[^\/]+)?\/([^\/?#]+)\/?(?:[?#].*)?$/i.exec(href.trim());
  return m && xValid(m[1]) ? m[1] : null;
}
function xFind() {
  var sels = [
    'a[data-testid="AppTabBar_Profile_Link"]',
    'a[data-testid="DashButton_ProfileIcon_Link"]',
    'a[aria-label="Profile"]',
  ];
  for (var i = 0; i < sels.length; i++) {
    var els = document.querySelectorAll(sels[i]);
    for (var j = 0; j < els.length; j++) {
      var h = xFromHref(els[j].getAttribute('href'));
      if (h) return h;
    }
  }
  var sw = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  var t = sw ? sw.innerText : '';
  if (typeof t === 'string' && t) {
    var lines = t.split('\n');
    for (var k = 0; k < lines.length; k++) {
      var lm = /^\s*@([A-Za-z0-9_]{1,15})\s*$/.exec(lines[k]);
      if (lm && xValid(lm[1])) return lm[1];
    }
    var m = /@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/.exec(t);
    if (m && xValid(m[1])) return m[1];
  }
  return null;
}
async function run() {
  for (;;) {
    if (xSignedOut()) return finish('signed_out');
    var handle = xFind();
    if (handle) return finish('ok', { handle: handle });
    if (remaining() <= 0) return finish('empty');
    await tick();
  }
}
`;

/** X step 1 (/<handle>): wait for "<count> Followers" (the count may sit on the previous line), settle, post. */
const X_1 = String.raw`
function xHandleFromPath() {
  var m = /^\/([^\/?#]+)/.exec(location.pathname);
  return m && xValid(m[1]) ? m[1] : null;
}
async function run() {
  await readText(/\d[\d.,]*\s*[KMB]?\s+Followers/i, xSignedOut, function (text) {
    return { handle: xValid(CTX_HANDLE) ? CTX_HANDLE : xHandleFromPath(), text: text };
  });
}
`;

/**
 * Reddit: two same-origin GETs, pruned to the karma/subscriber fields. No numbers at all after pruning is `empty`
 * with the name (the app can then open the profile for a screenshot).
 */
const REDDIT_0 = String.raw`
var RD_HEADERS = { Accept: 'application/json' };
var RD_KEYS = ['total_karma', 'link_karma', 'comment_karma'];

function rdPick(body) {
  var out = {};
  if (typeof body.kind === 'string') out.kind = body.kind;
  var d = body.data;
  if (isObj(d)) {
    var data = {};
    if (typeof d.name === 'string') data.name = d.name;
    for (var i = 0; i < RD_KEYS.length; i++) {
      if (num(d[RD_KEYS[i]]) !== undefined) data[RD_KEYS[i]] = d[RD_KEYS[i]];
    }
    if (isObj(d.subreddit) && num(d.subreddit.subscribers) !== undefined) {
      data.subreddit = { subscribers: d.subreddit.subscribers };
    }
    out.data = data;
  }
  return out;
}
function rdHasNumbers(p) {
  var d = p ? p.data : null;
  return (
    isObj(d) &&
    (d.total_karma !== undefined || d.link_karma !== undefined || d.comment_karma !== undefined || isObj(d.subreddit))
  );
}
async function run() {
  var meRes = await fetchText('/api/me.json', RD_HEADERS);
  if (meRes.status === 429 || meRes.status >= 500) return finish('error');
  var meBody = meRes.ok ? asJson(meRes.text) : null;
  var name = meBody && isObj(meBody.data) && typeof meBody.data.name === 'string' ? meBody.data.name : '';
  if (!name) return finish('signed_out');
  var about = null;
  try {
    var ab = await fetchText('/user/' + encodeURIComponent(name) + '/about.json', RD_HEADERS);
    var abBody = ab.ok ? asJson(ab.text) : null;
    if (abBody && isObj(abBody.data)) about = rdPick(abBody);
  } catch (e) {
    about = null;
  }
  var me = rdPick(meBody);
  if (!rdHasNumbers(me) && !rdHasNumbers(about)) return finish('empty', { name: name });
  finish('ok', { me: me, about: about });
}
`;

/** Facebook (m.facebook.com/me, which redirects to the profile): wait for "<count> followers|friends", settle, post. */
const FACEBOOK_0 = String.raw`
function fbSignedOut() {
  return pathIs('/login', '/checkpoint', '/recover') || hasPasswordInput();
}
async function run() {
  await readText(/\d[\d.,]*\s*[KMB]?\s+(?:followers|friends)/i, fbSignedOut, function (text) {
    return { text: text };
  });
}
`;

// ---- assembly -------------------------------------------------------------------------------------------------------

function readerFor(platform: unknown, step: unknown): ReaderDef | null {
  if (typeof platform !== 'string' || typeof step !== 'number') return null;
  switch (platform + ':' + step) {
    case 'instagram:0':
      return { hosts: ['instagram.com'], net: true, body: INSTAGRAM_0 };
    case 'tiktok:0':
      return { hosts: ['tiktok.com'], net: true, body: TIKTOK_0 };
    case 'linkedin:0':
      return { hosts: ['linkedin.com'], net: true, text: true, body: LINKEDIN_COMMON + LINKEDIN_0 };
    case 'linkedin:1':
      return { hosts: ['linkedin.com'], text: true, body: LINKEDIN_COMMON + LINKEDIN_1 };
    case 'x:0':
      return { hosts: ['x.com', 'twitter.com'], body: X_COMMON + X_0 };
    case 'x:1':
      return { hosts: ['x.com', 'twitter.com'], text: true, handle: true, body: X_COMMON + X_1 };
    case 'reddit:0':
      return { hosts: ['reddit.com'], net: true, body: REDDIT_0 };
    case 'facebook:0':
      return { hosts: ['facebook.com'], text: true, body: FACEBOOK_0 };
    default:
      return null;
  }
}

/** `ctx.handle` comes from a page, so it is re-validated here before it is written into a script. */
function cleanHandle(h: unknown): string | null {
  if (typeof h !== 'string') return null;
  const bare = h.charAt(0) === '@' ? h.slice(1) : h;
  return /^[A-Za-z0-9_]{1,15}$/.test(bare) ? bare : null;
}

/**
 * The script for `platform` at `step` (instagram, tiktok, reddit, facebook: 0; linkedin, x: 0 and 1), ready for
 * `WebView.injectJavaScript`. Any other pair throws `Error('no such reader')`. `opts.deadlineMs` exists for tests.
 */
export function readerScript(
  platform: Platform,
  step: number,
  ctx?: StepCtx,
  opts?: { deadlineMs?: number },
): string {
  const def = readerFor(platform, step);
  if (!def) throw new Error('no such reader');
  const asked = opts ? opts.deadlineMs : undefined;
  const deadline =
    typeof asked === 'number' && isFinite(asked) && asked > 0 ? Math.max(1, Math.round(asked)) : READER_DEADLINE_MS;

  const lines: string[] = [
    '(function () {',
    "'use strict';",
    'var PLATFORM = ' + JSON.stringify(platform) + ';',
    'var STEP = ' + step + ';',
    'var HOSTS = ' + JSON.stringify(def.hosts) + ';',
    'var DEADLINE_MS = ' + deadline + ';',
    'var POLL_MS = ' + POLL_MS + ';',
    'var START_DELAY_MS = ' + START_DELAY_MS + ';',
  ];
  if (def.net) lines.push('var FETCH_MS = ' + FETCH_TIMEOUT_MS + ';');
  if (def.text) lines.push('var SETTLE_MS = ' + SETTLE_MS + ';', 'var TEXT_CAP = ' + TEXT_CAP + ';');
  if (def.handle) lines.push('var CTX_HANDLE = ' + JSON.stringify(cleanHandle(ctx ? ctx.handle : null)) + ';');
  lines.push(CORE);
  if (def.net) lines.push(NET);
  if (def.text) lines.push(TEXT);
  lines.push(def.body, START, '})();', 'true;');
  return lines.join('\n');
}
