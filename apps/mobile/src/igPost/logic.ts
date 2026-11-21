/**
 * "Post to Instagram" on Android: the pure parts (no react-native import, so it runs under plain Node and jest).
 *
 * Instagram has no composer link and needs a photo, while a Pulse post only has a caption and a visual plan (the
 * `media_prompt` text; Pulse does not generate images). So the Android button:
 *   1. copies the caption,
 *   2. asks for a photo (the phone's library, cropped square),
 *   3. hands it to Instagram, in one of two ways:
 *      - share: Android's share sheet with the photo (expo-sharing; pick "Instagram Feed"), the caption is pasted by the
 *        person. Needs an APK built with expo-sharing; older APKs open the Instagram app instead (the photo is already in
 *        the gallery, the caption on the clipboard).
 *      - auto (behind IG_AUTOPOST, off unless EXPO_PUBLIC_IG_AUTOPOST=1): after a "Post to Instagram now?" confirm, the
 *        in-app WebView that is already signed in to instagram.com uploads the photo and publishes it with the caption,
 *        the same two requests instagram.com's own "Create" page makes (design below, `buildIgPostScript`).
 *
 * Nothing here reads, logs or returns a cookie or token value: the injected scripts read csrftoken only to send it back
 * to instagram.com as the x-csrftoken header (what Instagram's own web app does), and report booleans and short errors.
 */

/** Auto-post through the WebView. Off by default: it publishes publicly and is untested against live Instagram. */
export const IG_AUTOPOST: boolean = process.env.EXPO_PUBLIC_IG_AUTOPOST === '1';

/** Instagram's web app id and the extra headers its own requests carry (same values as the reader in autoRead). */
export const IG_APP_ID = '936619743392459';
export const IG_ASBD_ID = '129477';

/** Where the posting WebView starts; Instagram shows its sign-in page there when the person is signed out. */
export const IG_HOME_URL = 'https://www.instagram.com/';

/** Feed photos must be between 4:5 (portrait) and 1.91:1 (landscape); Instagram refuses others at configure time. */
export const IG_MIN_RATIO = 4 / 5;
export const IG_MAX_RATIO = 1.91;
/** Instagram's web upload refuses photos narrower than this. */
export const IG_MIN_SIDE = 320;
/** Largest photo Pulse sends (decoded bytes); Instagram's own limit is about 8 MB. */
export const IG_MAX_BYTES = 7_000_000;

/** Base64 characters per injected chunk (a multi-megabyte `injectJavaScript` call is slow and can be dropped). */
export const IG_CHUNK_CHARS = 200_000;
/** A post that has not answered after this long is reported as failed (the person can check Instagram). */
export const IG_POST_TIMEOUT_MS = 90_000;
/** How often the posting sheet asks the page whether the person is signed in. */
export const IG_PROBE_MS = 1_500;

/** Prefix of every message the posting scripts send, so other page messages are ignored. */
export const IG_MSG = 'pulse-ig';

/** Which Instagram button a card gets on this OS. */
export type IgButtonMode = 'copy' | 'instagram';

/** Android gets "Post to Instagram" (photo + caption); every other OS keeps "Copy caption". */
export function igButtonMode(os: string): IgButtonMode {
  return os === 'android' ? 'instagram' : 'copy';
}

/** The note under the Instagram button on Android. */
export function igNote(opts: { autoPost: boolean; hasVisualPlan: boolean }): string {
  const plan = opts.hasVisualPlan ? ' that fits the visual plan' : '';
  return opts.autoPost
    ? `Pick a photo${plan}. Pulse copies the caption and can post it for you, or hand both to the Instagram app.`
    : `Pick a photo${plan}. Pulse copies the caption and opens Instagram with the photo: paste the caption there.`;
}

export interface IgImageInfo {
  width: number;
  height: number;
  /** Decoded size in bytes. */
  bytes: number;
}

/** null when Instagram takes the photo, otherwise what the person should do (shown as is). */
export function igImageProblem(img: IgImageInfo): string | null {
  const { width, height, bytes } = img;
  if (!(width > 0) || !(height > 0)) return "Couldn't read that photo. Try another one.";
  if (Math.min(width, height) < IG_MIN_SIDE) return 'That photo is too small for Instagram. Pick a larger one.';
  const ratio = width / height;
  if (ratio < IG_MIN_RATIO - 0.005 || ratio > IG_MAX_RATIO + 0.005) {
    return 'Instagram needs a photo between 4:5 and 1.91:1. Crop it square and try again.';
  }
  if (bytes > IG_MAX_BYTES) return 'That photo is too large. Crop it tighter and try again.';
  return null;
}

/** Decoded byte length of a base64 string (no data: prefix). */
export function base64Size(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Plain base64 only: it is written into a script, so anything else is refused. */
export function isBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && BASE64.test(s);
}

/**
 * The photo as a series of scripts that rebuild it in `window.__pulseIgImg` on the instagram.com page. Throws on
 * anything that is not plain base64 (it is written between quotes into page code).
 */
export function imageChunkScripts(b64: string, chunk = IG_CHUNK_CHARS): string[] {
  if (!isBase64(b64)) throw new Error('not base64');
  const size = Math.max(4, Math.floor(chunk / 4) * 4);
  const out = ["window.__pulseIgImg = '';true;"];
  for (let i = 0; i < b64.length; i += size) {
    out.push(`window.__pulseIgImg += '${b64.slice(i, i + size)}';true;`);
  }
  return out;
}

/** Shared by the injected scripts: post one JSON message, read one cookie the page can see. */
const PAGE_HELPERS = String.raw`
function pulsePost(o) {
  o.t = ${JSON.stringify(IG_MSG)};
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
function pulseOnInstagram() {
  return /(^|\.)instagram\.com$/.test(location.hostname) && location.protocol === 'https:';
}
`;

/**
 * Asks the page whether the person is signed in. Answers `{ t, kind: 'state', signedIn, onIg, settled }` (booleans
 * only). `settled` is false on Instagram's sign-in, "save your login" and checkpoint pages, which navigate on by
 * themselves (a navigation would cut a post in half).
 */
export const IG_STATE_PROBE_JS = `(function () {
${PAGE_HELPERS}
pulsePost({
  kind: 'state',
  onIg: pulseOnInstagram(),
  signedIn: !!pulseCookie('ds_user_id') && !!pulseCookie('csrftoken'),
  settled: ['accounts', 'challenge', 'auth_platform'].indexOf(String(location.pathname).split('/')[1] || '') < 0
});
})();
true;`;

export interface IgPostParams {
  /** Instagram's upload id: the current time in milliseconds, as a string of digits. */
  uploadId: string;
  width: number;
  height: number;
  /** Decoded bytes of the photo; the script checks the rebuilt photo against it. */
  bytes: number;
  /** Base64 length the chunks must add up to. */
  b64Length: number;
  caption: string;
}

/**
 * The script that publishes the photo already rebuilt in `window.__pulseIgImg` (see `imageChunkScripts`).
 *
 * Design (what instagram.com's own "Create" flow sends, same-origin, with the session cookies the WebView keeps):
 *   1. POST /rupload_igphoto/fb_uploader_<uploadId>, body = the JPEG bytes, headers:
 *        x-entity-name: fb_uploader_<uploadId>, x-entity-length: <bytes>, x-entity-type: image/jpeg, offset: 0,
 *        x-instagram-rupload-params: {"media_type":1,"upload_id":"<id>","upload_media_height":H,"upload_media_width":W}
 *      -> { upload_id, status: 'ok' }
 *   2. POST /api/v1/media/configure/ (form): source_type=library, caption, upload_id, disable_comments=0, ...
 *      -> { status: 'ok', media: { code } }   (https://www.instagram.com/p/<code>/)
 *   Both carry x-ig-app-id, x-csrftoken (from the csrftoken cookie), x-requested-with, x-asbd-id, and x-ig-www-claim
 *   when the page has one in sessionStorage (Instagram's web app sends all of these).
 * It answers `{ t, kind: 'result', ok, stage?, status?, message?, code? }` and clears the photo from the page.
 * Known risks: Instagram changes these private endpoints without notice, may ask for a checkpoint or refuse a new
 * device (stage 'upload' or 'configure' with status 400/403), and one tap that times out on our side may still post.
 */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

export function buildIgPostScript(p: IgPostParams): string {
  if (!/^\d{10,20}$/.test(p.uploadId)) throw new Error('bad upload id');
  const num = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  const params = {
    uploadId: p.uploadId,
    width: num(p.width),
    height: num(p.height),
    bytes: num(p.bytes),
    b64Length: num(p.b64Length),
    caption: String(p.caption),
    appId: IG_APP_ID,
    asbdId: IG_ASBD_ID,
  };
  // JSON is valid JS; U+2028/2029 (LS, PS) are escaped for engines that predate ES2019.
  const json = JSON.stringify(params).split(LS).join('\\u2028').split(PS).join('\\u2029');
  return `(function () {
'use strict';
var P = ${json};
${PAGE_HELPERS}
function short(s) { return typeof s === 'string' ? s.slice(0, 160) : undefined; }
function fail(stage, status, body) {
  pulsePost({ kind: 'result', ok: false, stage: stage, status: status, message: short(body && (body.message || body.error_title || body.feedback_message)) });
}
async function readJson(res) {
  try { return await res.json(); } catch (e) { return null; }
}
async function run() {
  if (!pulseOnInstagram()) return fail('page', 0, { message: 'not on instagram.com' });
  var csrf = pulseCookie('csrftoken');
  if (!csrf || !pulseCookie('ds_user_id')) return fail('signed-out', 0, null);
  var b64 = String(window.__pulseIgImg || '');
  if (b64.length !== P.b64Length) return fail('image', 0, { message: 'photo did not arrive whole' });
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length !== P.bytes) return fail('image', 0, { message: 'photo size mismatch' });
  var base = { 'x-ig-app-id': P.appId, 'x-requested-with': 'XMLHttpRequest', 'x-asbd-id': P.asbdId, 'x-csrftoken': csrf };
  try {
    var claim = window.sessionStorage && window.sessionStorage.getItem('www-claim-v2');
    if (claim) base['x-ig-www-claim'] = claim;
  } catch (e) {}
  var name = 'fb_uploader_' + P.uploadId;
  var upHeaders = Object.assign({}, base, {
    'content-type': 'image/jpeg',
    'x-entity-name': name,
    'x-entity-length': String(bytes.length),
    'x-entity-type': 'image/jpeg',
    'offset': '0',
    'x-instagram-rupload-params': JSON.stringify({
      media_type: 1, upload_id: P.uploadId, upload_media_height: P.height, upload_media_width: P.width
    })
  });
  var up = await fetch('/rupload_igphoto/' + name, { method: 'POST', credentials: 'include', headers: upHeaders, body: bytes });
  var upBody = await readJson(up);
  if (!up.ok || !upBody || upBody.status !== 'ok') return fail('upload', up.status, upBody);
  var form = new URLSearchParams();
  form.set('source_type', 'library');
  form.set('caption', P.caption);
  form.set('upload_id', P.uploadId);
  form.set('disable_comments', '0');
  form.set('like_and_view_counts_disabled', '0');
  form.set('igtv_share_preview_to_feed', '1');
  form.set('is_unified_video', '1');
  form.set('video_subtitles_enabled', '0');
  var cf = await fetch('/api/v1/media/configure/', {
    method: 'POST',
    credentials: 'include',
    headers: Object.assign({}, base, { 'content-type': 'application/x-www-form-urlencoded' }),
    body: form.toString()
  });
  var cfBody = await readJson(cf);
  if (!cf.ok || !cfBody || cfBody.status !== 'ok') return fail('configure', cf.status, cfBody);
  var media = cfBody.media || {};
  pulsePost({ kind: 'result', ok: true, code: typeof media.code === 'string' ? media.code : null });
}
run().catch(function (e) {
  fail('script', 0, { message: String(e && e.message || e) });
}).then(function () {
  window.__pulseIgImg = '';
});
})();
true;`;
}

export type IgMessage =
  | { kind: 'state'; signedIn: boolean; onIg: boolean; settled: boolean }
  | { kind: 'result'; ok: true; code: string | null }
  | { kind: 'result'; ok: false; stage: string; status: number; message: string | null };

/** A message from the posting scripts, or null for anything else (other page messages, junk). */
export function parseIgMessage(data: string): IgMessage | null {
  let o: unknown;
  try {
    o = JSON.parse(data);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const m = o as Record<string, unknown>;
  if (m.t !== IG_MSG) return null;
  if (m.kind === 'state') {
    return { kind: 'state', signedIn: m.signedIn === true, onIg: m.onIg === true, settled: m.settled === true };
  }
  if (m.kind !== 'result') return null;
  if (m.ok === true) {
    const code = typeof m.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(m.code) ? m.code : null;
    return { kind: 'result', ok: true, code };
  }
  return {
    kind: 'result',
    ok: false,
    stage: typeof m.stage === 'string' ? m.stage.slice(0, 32) : 'unknown',
    status: typeof m.status === 'number' && Number.isFinite(m.status) ? m.status : 0,
    message: typeof m.message === 'string' ? m.message.slice(0, 160) : null,
  };
}

/** The public link of a published post. */
export function igPostUrl(code: string | null): string | null {
  return code ? `https://www.instagram.com/p/${code}/` : null;
}

/** What the person reads when auto-posting failed; the share sheet is always the way out. */
export function igFailureText(m: { stage: string; status: number }): string {
  switch (m.stage) {
    case 'signed-out':
      return 'Instagram signed you out. Sign in again, or use "Open Instagram".';
    case 'image':
      return "The photo didn't reach Instagram whole. Try again.";
    case 'timeout':
      return "Instagram didn't answer. Check your profile before trying again: it may have posted.";
    case 'upload':
    case 'configure':
      if (m.status === 401 || m.status === 403) return 'Instagram refused the post from here. Use "Open Instagram" instead.';
      if (m.status === 429) return 'Instagram says to slow down. Try again later or use "Open Instagram".';
      return `Instagram refused the post (${m.stage}${m.status ? ` ${m.status}` : ''}). Use "Open Instagram" instead.`;
    default:
      return "Couldn't post from here. Use \"Open Instagram\" instead.";
  }
}

/** Instagram's upload id: the current time in milliseconds. */
export function newUploadId(now: number = Date.now()): string {
  return String(Math.floor(now));
}
