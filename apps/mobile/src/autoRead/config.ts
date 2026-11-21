/** Tunables for the in-app read. Times are milliseconds. No react-native import: runs under plain Node. */

/** Plain anonymous `fetch` before the WebView opens (one request per platform). */
export const ANON_TIMEOUT_MS = 5_000;
/** A reader gets this long, counted from the moment its script is injected into the stats page. */
export const READ_TIMEOUT_MS = 12_000;
/** We opened the stats page but never landed on a page the reader can run on. */
export const NAV_TIMEOUT_MS = 25_000;
/** Let a single-page app mount before a reader is injected. */
export const INJECT_DELAY_MS = 500;
/** Let a page render before it is captured as an image. */
export const SETTLE_MS = 2_500;
/** Give the fallback page this long to load before capturing whatever is on screen. */
export const FALLBACK_LOAD_MS = 15_000;
/** Background refresh (refresh.tsx): a platform is read again when its last automatic read is older than this. */
export const REFRESH_STALE_MS = 60 * 60 * 1000;
/** Background refresh: one platform's read is abandoned after this long. */
export const REFRESH_TIMEOUT_MS = 30_000;
/** After a refresh that failed (signed out, timeout), do not try that platform again for this long (this app run). */
export const REFRESH_RETRY_MS = 15 * 60 * 1000;
/** Sign-out: how long the hidden incognito WebView stays mounted so Android applies the flag (clears cookies). */
export const FORGET_HOLD_MS = 500;

/** After we navigate away, late events for the page we left (its `onLoadEnd`) are ignored for this long. */
export const STALE_PAGE_MS = 1_500;

/** Safety nets against redirect loops and chatty re-injection. */
export const MAX_NAVIGATIONS = 3;
export const MAX_INJECTIONS = 8;

/** Screen capture: JPEG, width at most 1400 px, quality 0.8; a second, smaller try if it is still too large. */
export const CAPTURE_MAX_WIDTH = 1400;
export const CAPTURE_QUALITY = 0.8;
export const CAPTURE_RETRY_WIDTH = 900;
export const CAPTURE_RETRY_QUALITY = 0.6;
/** The screenshot endpoint refuses images above 5 MB decoded (413). */
export const CAPTURE_MAX_BYTES = 4_500_000;

/**
 * A normal mobile Chrome user agent: the reduced form modern Chrome itself sends (no `; wv`, no `Version/4.0`, which is
 * what makes sites treat an Android WebView as an embedded browser). Bump the major version here when it gets stale.
 */
export const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
export const UA_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';
