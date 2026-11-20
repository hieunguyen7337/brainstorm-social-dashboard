/**
 * The free first try: a plain anonymous `fetch` from the phone's own connection, for the platforms where that may work
 * (Reddit about.json, TikTok profile HTML, Instagram web_profile_info with its public app-id header). Needs the public
 * handle the caller passes in; skipped without one. 5 s timeout per request. No cookies are sent or kept.
 *
 * No react-native import: `fetch` and `AbortController` are globals (and injectable for tests).
 */
import { ANON_TIMEOUT_MS, UA_ANDROID } from './config';
import { hasNumbers, parseInstagramJson, parseRedditJson, parseTikTokJson } from './parse';
import type { ParsedRead, Platform } from './types';

const IG_APP_ID = '936619743392459';

/** Platforms with an anonymous try. */
export const ANON_PLATFORMS: readonly Platform[] = ['reddit', 'tiktok', 'instagram'];

/** A public handle as the platforms allow it (letters, digits, dot, underscore, hyphen); a leading "@" is stripped. */
export function cleanHandle(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const h = input.trim().replace(/^@+/, '');
  return /^[A-Za-z0-9._-]{1,60}$/.test(h) ? h : null;
}

export interface AnonOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

async function getText(url: string, headers: Record<string, string>, opts: AnonOptions): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? ANON_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': opts.userAgent ?? UA_ANDROID, 'Accept-Language': 'en', ...headers },
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The JSON inside `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" ...>` of a TikTok profile page. */
export function extractTikTokData(html: string | null): unknown {
  if (!html) return null;
  const m = /<script[^>]*\bid="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  return m ? parseJson(m[1]) : null;
}

/**
 * Reads one public profile without signing in. Resolves with the numbers found, or `null` (blocked, timed out, not
 * found, unsupported platform, no usable numbers). Never throws and never logs what it received.
 */
export async function readAnonymously(
  platform: Platform,
  handle: string | null | undefined,
  opts: AnonOptions = {},
): Promise<ParsedRead | null> {
  const h = cleanHandle(handle);
  if (!h) return null;
  let parsed: ParsedRead | null = null;
  if (platform === 'reddit') {
    const json = parseJson(
      await getText(`https://www.reddit.com/user/${encodeURIComponent(h)}/about.json`, { Accept: 'application/json' }, opts),
    );
    parsed = json ? parseRedditJson(null, json) : null;
  } else if (platform === 'tiktok') {
    const html = await getText(`https://www.tiktok.com/@${encodeURIComponent(h)}`, { Accept: 'text/html' }, opts);
    const data = extractTikTokData(html);
    parsed = data ? parseTikTokJson(data) : null;
  } else if (platform === 'instagram') {
    const json = parseJson(
      await getText(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(h)}`,
        { Accept: 'application/json', 'x-ig-app-id': IG_APP_ID },
        opts,
      ),
    );
    parsed = json ? parseInstagramJson(json) : null;
  }
  return parsed && hasNumbers(parsed) ? parsed : null;
}
