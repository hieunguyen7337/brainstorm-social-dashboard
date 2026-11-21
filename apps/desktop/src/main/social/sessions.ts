/**
 * Per-platform session facts (docs/DESKTOP.md 3 and 4.4). Pure: Electron pieces are injected, so node:test can run it.
 * Cookie VALUES are never read here: the signed-in check looks at cookie names and domains only.
 */
import type { Platform } from '@/src/desktop/types';

export const SOCIAL_PLATFORMS: readonly Platform[] = ['instagram', 'linkedin', 'tiktok', 'x', 'reddit', 'facebook'];

export function isSocialPlatform(v: unknown): v is Platform {
  return typeof v === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(v);
}

export const partitionFor = (platform: Platform): string => `persist:pulse-${platform}`;

/** The session cookie that exists while the person is signed in, and the site domain it lives on. */
export const SIGNED_IN_COOKIE: Record<Platform, { name: string; domain: string }> = {
  instagram: { name: 'sessionid', domain: 'instagram.com' },
  linkedin: { name: 'li_at', domain: 'linkedin.com' },
  x: { name: 'auth_token', domain: 'x.com' },
  tiktok: { name: 'sessionid', domain: 'tiktok.com' },
  facebook: { name: 'c_user', domain: 'facebook.com' },
  reddit: { name: 'reddit_session', domain: 'reddit.com' },
};

/** "Show <Platform>": the signed-in site. */
export const HOME_URL: Record<Platform, string> = {
  instagram: 'https://www.instagram.com/',
  linkedin: 'https://www.linkedin.com/feed/',
  x: 'https://x.com/home',
  tiktok: 'https://www.tiktok.com/',
  facebook: 'https://www.facebook.com/',
  reddit: 'https://www.reddit.com/',
};

/** The part of Electron's `session.cookies` we use. The returned objects also hold values; we never touch them. */
export interface CookieJar {
  get(filter: { name?: string }): Promise<ReadonlyArray<{ name: string; domain?: string }>>;
}

export async function isSignedIn(cookies: CookieJar, platform: Platform): Promise<boolean> {
  const { name, domain } = SIGNED_IN_COOKIE[platform];
  try {
    const found = await cookies.get({ name });
    return found.some((c) => {
      if (c.name !== name) return false;
      const d = (c.domain ?? '').replace(/^\./, '').toLowerCase();
      return d === domain || d.endsWith(`.${domain}`);
    });
  } catch {
    return false;
  }
}

/** Electron's default UA minus the `Electron/x` token and the app-name token(s), which sites treat as an embedded browser. */
export function cleanUserAgent(ua: string, appNames: readonly string[] = []): string {
  let out = ua.replace(/\s+Electron\/\S+/g, '');
  for (const n of appNames) {
    if (!n) continue;
    const variants = new Set([n, n.replace(/\s+/g, '-'), n.replace(/\s+/g, '')]);
    for (const v of variants) out = out.replace(new RegExp(`\\s+${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\S+`, 'g'), '');
  }
  return out.replace(/\s+/g, ' ').trim();
}
