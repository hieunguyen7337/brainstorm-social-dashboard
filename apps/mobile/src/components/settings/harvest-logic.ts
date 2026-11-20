/**
 * Pure logic for the LinkedIn / Instagram "profile link" rows: link validation, the status line wording and the
 * cache patch applied after a save. No React, so it is easy to reason about.
 */
import { timeAgo } from '@/src/format';
import type { HarvestPlatformStatus, HarvestStatus, Platform } from '@/src/types';

/** The two channels whose real numbers can be harvested (the founders' priority channels). */
export type HarvestPlatform = Extract<Platform, 'linkedin' | 'instagram'>;

export const isHarvestPlatform = (p: Platform): p is HarvestPlatform => p === 'linkedin' || p === 'instagram';

/** Placeholder link and the hosts that look right for each platform (short-link hosts included). */
export const HARVEST_LINKS: Record<HarvestPlatform, { placeholder: string; domains: readonly string[] }> = {
  linkedin: { placeholder: 'https://www.linkedin.com/in/your-name', domains: ['linkedin.com', 'lnkd.in'] },
  instagram: { placeholder: 'https://www.instagram.com/yourhandle', domains: ['instagram.com', 'instagr.am'] },
};

// ---- link validation -------------------------------------------------------------------------------------------

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/**
 * http(s), a dotted host (no user info, so `https://linkedin.com@evil.example` is rejected), an optional port, then an
 * optional path / query / fragment without spaces. Regex on purpose: React Native's own `URL` throws on most getters.
 */
const HTTP_URL = new RegExp(
  `^https?://((?:${LABEL}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])(?::\\d{1,5})?(?:[/?#]\\S*)?$`,
  'i',
);
/** "linkedin.com/in/me": a link without its scheme. */
const BARE_LINK = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export type LinkCheck =
  | { state: 'empty' }
  | { state: 'invalid'; message: string }
  /** A usable link. `hostMismatch`: valid, but the host does not look like this platform (a hint, never a block). */
  | { state: 'ok'; url: string; hostMismatch: boolean };

const hostMatches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

export function checkProfileLink(platform: HarvestPlatform, input: string): LinkCheck {
  const text = input.trim();
  if (text === '') return { state: 'empty' };
  const { placeholder, domains } = HARVEST_LINKS[platform];
  const match = HTTP_URL.exec(text);
  if (!match) {
    const bare = !HAS_SCHEME.test(text) && BARE_LINK.test(text);
    return { state: 'invalid', message: bare ? 'Start the link with https://' : `Enter a full link, like ${placeholder}` };
  }
  const host = match[1].toLowerCase();
  return { state: 'ok', url: text, hostMismatch: !domains.some((d) => hostMatches(host, d)) };
}

// ---- status line -----------------------------------------------------------------------------------------------

export interface StatusLine {
  text: string;
  /** harvested: real numbers came in. waiting: link saved, nothing yet. 'no-link': nothing to harvest from. */
  kind: 'harvested' | 'waiting' | 'no-link';
}

/** "3m ago", "just now", "on 12 Nov"; null when the timestamp is unreadable. */
function agoText(iso: string, now: number): string | null {
  const ago = timeAgo(iso, now);
  if (!ago) return null;
  if (ago.startsWith('in ')) return 'just now'; // the server's clock is a little ahead of ours
  return /ago$|^just now$/.test(ago) ? ago : `on ${ago}`; // timeAgo falls back to a short date after a week
}

export function harvestStatusLine(
  row: HarvestPlatformStatus | null,
  hasLink: boolean,
  now: number = Date.now(),
): StatusLine {
  const ago = row?.last_harvested_at ? agoText(row.last_harvested_at, now) : null;
  if (ago) {
    const n = row?.posts_harvested;
    const posts = typeof n === 'number' && Number.isFinite(n) ? ` · ${n} ${n === 1 ? 'post' : 'posts'}` : '';
    return { kind: 'harvested', text: `Last harvested ${ago}${posts}` };
  }
  return hasLink
    ? { kind: 'waiting', text: 'Not harvested yet' }
    : { kind: 'no-link', text: 'Add your profile link to pull real stats' };
}

// ---- cache --------------------------------------------------------------------------------------------------------

/** The harvest status with `platform`'s saved profile link replaced (the row is added when the server had none). */
export function withHarvestProfile(status: HarvestStatus, platform: Platform, url: string): HarvestStatus {
  const exists = status.platforms.some((r) => r.platform === platform);
  const platforms = exists
    ? status.platforms.map((r) => (r.platform === platform ? { ...r, profile_url: url } : r))
    : [...status.platforms, { platform, profile_url: url, last_harvested_at: null, posts_harvested: null, status: null }];
  return { ...status, platforms };
}
