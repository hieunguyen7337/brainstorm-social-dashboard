/**
 * "Post it for real": composer URLs for each network, built on the client.
 *
 * `GET /api/posts/{id}/share` is the source of truth once it exists; this builder backs the mock and is the
 * fallback when that endpoint answers 404 (or is unreachable), so the buttons work either way.
 */
import type { Platform, Post, ShareInfo } from './types';

const enc = encodeURIComponent;

const INSTAGRAM_NOTE =
  "Instagram can't open a composer from a link. Copy the caption, open Instagram, and add the image or reel from the visual plan.";
const TIKTOK_NOTE =
  "TikTok can't open a composer from a link. Copy the caption, open TikTok, and record the video from the shot list.";

/** Instagram keeps only the first 5 hashtags of a caption and strips the '#' from the rest. */
export const IG_MAX_HASHTAGS = 5;

/** Caption = text plus hashtags that are not already in it (at most 5 on Instagram and TikTok). */
export function captionFor(post: Pick<Post, 'content' | 'hashtags'> & { platform?: Platform }): string {
  const all = post.hashtags.filter((h) => !post.content.includes(h));
  const missing = post.platform === 'instagram' || post.platform === 'tiktok' ? all.slice(0, IG_MAX_HASHTAGS) : all;
  return missing.length ? `${post.content.trim()}\n\n${missing.join(' ')}` : post.content.trim();
}

/** First line as a title (Reddit), the rest as the body. */
function splitTitle(content: string): { title: string; body: string } {
  const [first, ...rest] = content.trim().split('\n');
  return { title: first.trim().slice(0, 300), body: rest.join('\n').trim() };
}

/** Platforms whose card offers a "Post on ..." button (X cards also offer Threads). */
export const SHAREABLE: readonly Platform[] = ['linkedin', 'x', 'reddit', 'facebook'];

export function buildShareInfo(post: Post): ShareInfo {
  const caption = captionFor(post);
  const base = { platform: post.platform, caption, threads_url: null as string | null, instagram_note: null as string | null };
  switch (post.platform) {
    case 'linkedin':
      return { ...base, url: `https://www.linkedin.com/feed/?shareActive=true&text=${enc(caption)}` };
    case 'x':
      return {
        ...base,
        url: `https://twitter.com/intent/tweet?text=${enc(post.content.trim())}`,
        threads_url: `https://www.threads.net/intent/post?text=${enc(post.content.trim())}`,
      };
    case 'reddit': {
      const { title, body } = splitTitle(post.content);
      return { ...base, url: `https://www.reddit.com/submit?type=self&title=${enc(title)}&text=${enc(body)}` };
    }
    case 'facebook':
      return {
        ...base,
        url: `https://www.facebook.com/sharer/sharer.php?u=${enc(post.link_url ?? '')}&quote=${enc(post.content.trim())}`,
      };
    case 'instagram':
      return { ...base, url: null, instagram_note: INSTAGRAM_NOTE };
    case 'tiktok':
      return { ...base, url: null, instagram_note: TIKTOK_NOTE };
  }
}
