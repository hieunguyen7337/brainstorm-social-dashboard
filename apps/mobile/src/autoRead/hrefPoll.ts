/**
 * Where the page really is, asked from inside it. A signed-in Instagram turns its login page into the feed by rewriting
 * the address in the page (history API), and Android's WebView then reports the old address or "still loading", so the
 * runner never saw the person was past the login (2026-11-21). While the runner waits for a sign-in, the WebView hosts
 * inject this every HREF_POLL_MS and hand the answer to `runner.navigated(href, false)`.
 */
export const HREF_POLL_MS = 2_000;

const KEY = '__pulseHref';

export const HREF_POLL_JS = `(function(){try{window.ReactNativeWebView.postMessage(JSON.stringify({${KEY}:String(location.href)}));}catch(e){}})();true;`;

/** The address from a poll answer, or null when the message is anything else (then the runner gets it as usual). */
export function takeHref(data: unknown): string | null {
  if (typeof data !== 'string' || !data.includes(KEY)) return null;
  try {
    const v = (JSON.parse(data) as Record<string, unknown>)[KEY];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
