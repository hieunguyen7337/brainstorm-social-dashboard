/**
 * Words that differ between a real workspace (docs/REAL.md) and an old sample one, kept in one place.
 *
 * Pulse never posts to anyone's accounts. In a real workspace "published" only means Pulse marked the post: the person
 * posts it with the share button on its card (it opens the platform's composer, or copies the caption for Instagram and
 * TikTok). So real copy never says a post "went live", was "published to" a platform or "goes out" by itself. Old sample
 * workspaces (`data_mode` missing or 'sample') keep their sandbox wording exactly as it was.
 *
 * Pure functions: components pass `useIsRealWorkspace()` in as `real`.
 */
import type { Platform } from '@/src/types';

/** Instagram and TikTok have no composer link: their card's share button copies the caption instead. */
const copiesCaption = (platform?: Platform): boolean => platform === 'instagram' || platform === 'tiktok';

const posts = (n: number): string => `${n} ${n === 1 ? 'post' : 'posts'}`;

/** Toast after one post was published (Queue "Publish now", Create "Publish"). `label` is the platform's name. */
export function publishedToast(label: string, real: boolean, platform?: Platform): string {
  if (!real) return `Published to ${label} (sandbox)`;
  return copiesCaption(platform)
    ? `Marked as published. Copy the caption and post it on ${label}.`
    : `Marked as published. Use the ${label} button to post it.`;
}

/** Toast after "Publish all". `every` is the Create screen's "Published all 3 posts"; the Queue says "Published 3 posts". */
export function publishedAllToast(count: number, real: boolean, every = false): string {
  if (!real) return every ? `Published all ${count} posts (sandbox)` : `Published ${posts(count)} (sandbox)`;
  const what = every && count > 1 ? `all ${count} posts` : posts(count);
  return `Marked ${what} as published. Post ${count === 1 ? 'it' : 'each one'} from its card.`;
}

/** Title of the card that replaces the buttons of a published post on the Create screen. */
export function publishedCardTitle(label: string, real: boolean): string {
  return real ? `Marked as published on ${label}` : `Published to ${label}`;
}

/** The line under that title. The share buttons sit right below it. */
export function publishedCardNote(real: boolean, platform?: Platform): string {
  if (!real) return 'Sandbox mode: your numbers start moving on the dashboard.';
  const how = copiesCaption(platform)
    ? 'Use the button below to copy the caption, then paste it into the app.'
    : 'Use the button below to open the composer, then post it.';
  return `Pulse doesn't post for you. ${how} Your numbers come from the tracked link and your next screenshot.`;
}

/** Under "Ask me before publishing" when the switch is off. (The "on" line is true in both kinds of workspace.) */
export function autopilotOffHint(real: boolean): string {
  return real
    ? 'Off: autopilot marks posts as published without asking. Share each one from your Queue to post it.'
    : 'Off: posts are published automatically (sandbox, so nothing leaves the app).';
}

/** Subtitle of the result card of "Run one cycle now" when its posts were published rather than left as drafts. */
export function autopilotPublishedLine(real: boolean): string {
  return real
    ? 'Marked as published. Share each post from your Queue to post it.'
    : 'Published to your connected platforms (sandbox).';
}

/** Subtitle of the Autopilot section. */
export function autopilotSubtitle(real: boolean): string {
  return real
    ? "Claude picks a trend and a theme and drafts posts into your Queue. You share them when you're ready."
    : 'Claude picks a trend and a theme, drafts posts, and queues or publishes them for you';
}

/** Empty Published tab of the Queue. Real numbers do not grow by themselves. */
export function emptyPublishedMessage(real: boolean): string {
  return real
    ? 'Publish a draft to see it here. Your numbers come from its tracked link and your next screenshot.'
    : 'Publish a draft to see it here, then watch the numbers grow.';
}

/** Empty Scheduled tab of the Queue. In a real workspace Pulse never posts anything, so nothing "goes out" by itself. */
export function emptyScheduledMessage(real: boolean): string {
  return real
    ? "Schedule a draft and it waits here until its time. Pulse doesn't post for you: share it from its card."
    : 'Schedule a draft and it will wait here until it goes out.';
}

/** Subtitle of the Queue screen. Real numbers do not tick by themselves, so no "updates live". */
export function queueSubtitle(real: boolean): string {
  return real
    ? 'Review, schedule and publish. Then share each post from its card.'
    : 'Review, schedule and publish. Numbers update live.';
}
