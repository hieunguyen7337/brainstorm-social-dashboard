/**
 * "Put link in bio" (Instagram): Instagram never makes a caption link tappable, so the only clickable link is the profile's
 * own. Pulse cannot change the profile; it copies the tracked link and opens Instagram's edit-profile page.
 */
import type { Post } from '@/src/types';

export const IG_EDIT_PROFILE_URL = 'https://www.instagram.com/accounts/edit/';

export const BIO_LINK_NEEDS_POST = 'Publish an Instagram post first: it gets the tracked link to put in your bio.';

/** The tracked link of the most recently published Instagram post that has one, or null. */
export function pickBioLink(posts: Pick<Post, 'platform' | 'status' | 'link_url' | 'published_at' | 'created_at'>[]): string | null {
  let best: string | null = null;
  let bestTs = -Infinity;
  for (const p of posts) {
    if (p.platform !== 'instagram' || p.status !== 'published' || !p.link_url) continue;
    const ts = Date.parse(p.published_at ?? p.created_at);
    const t = Number.isNaN(ts) ? -Infinity : ts;
    if (best === null || t > bestTs) {
      best = p.link_url;
      bestTs = t;
    }
  }
  return best;
}

/** What to tell the person once the link is on the clipboard and Instagram is opening. Honest: Pulse does not edit the bio. */
export function bioLinkSteps(copied: boolean): string {
  const how = 'In Instagram: Edit profile → Links → Add external link → paste, then Done. Pulse does not change your bio itself.';
  return copied ? `Link copied. ${how}` : `Couldn't copy the link, so copy it from a published post first. ${how}`;
}
