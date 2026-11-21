/**
 * Shared types for the in-app "sign in and read my numbers" flow (docs/REAL.md, unit R3).
 *
 * Pure types and constants only: no react-native import, so the parsers and the runner can run under plain Node.
 */
import type { Platform, ScreenshotPost, ScreenshotRead } from '@/src/types';

export type { Platform, ScreenshotRead };

/** One recent post, as in the contract's `ScreenshotRead.posts[i]`. Anything not seen is `null`, never a guess. */
export type ReadPost = ScreenshotPost;

/** What `onResult` receives: a `ScreenshotRead` plus where it came from (the ingest `source` value). */
export type DeviceRead = ScreenshotRead & { source: 'device' };

/**
 * What a parser found. Absent (or `null`) = not seen on the page; parsers never estimate.
 * `toScreenshotRead` in `parse.ts` turns this into a full `ScreenshotRead`.
 */
export interface ParsedRead {
  handle?: string | null;
  followers?: number | null;
  following?: number | null;
  posts_count?: number | null;
  views?: number | null;
  engagements?: number | null;
  profile_views?: number | null;
  period_days?: 7 | 30 | 90 | null;
  posts?: ReadPost[];
  notes?: string | null;
}

// ---- page -> app protocol -------------------------------------------------------------------------------------------

/**
 * The one message a reader script posts back with `window.ReactNativeWebView.postMessage(JSON.stringify(msg))`.
 *
 * - `ok`         `data` holds the raw material for the platform's parser (shapes below).
 * - `signed_out` the page shows the person is not signed in (login page, or the API refused). `data` omitted.
 * - `empty`      signed in, but the numbers were not found before the reader's own deadline.
 *                `data` may carry a hint that lets the app open the page whose screenshot is worth reading
 *                (instagram `{ username }`, reddit `{ name }`).
 * - `error`      the script itself failed (exception). `data` omitted.
 *
 * Raw `data` per platform and step (only what is listed; never cookies, tokens, storage or page HTML):
 *   instagram step 0   `{ user: <web_profile_info data.user, pruned: username, edge_followed_by.count, edge_follow.count,
 *                         edge_owner_to_timeline_media.{count, edges[<=12].node.{taken_at_timestamp, is_video,
 *                         video_view_count, edge_liked_by.count, edge_media_preview_like.count,
 *                         edge_media_to_comment.count, edge_media_to_caption.edges[0].node.text}}> }`
 *   tiktok    step 0   `{ userInfo: { user: { uniqueId }, stats: { followerCount, followingCount, heartCount,
 *                         videoCount } } }`
 *   linkedin  step 0   `{ publicId, followers?, connections?, page?: 'dashboard' | 'profile', text?, diag }` (counts
 *                       from LinkedIn's own API; text = innerText of the dashboard or own profile, at most 20000 chars;
 *                       diag = status codes and yes/no only)
 *   linkedin  step 1   `{ publicId, page: 'profile', text: <innerText of the person's own profile>, diag }`
 *   x         step 0   `{ handle }`                       (the signed-in account's handle, no "@")
 *   x         step 1   `{ handle, text: <innerText, at most 20000 chars> }`
 *   reddit    step 0   `{ me: </api/me.json body, pruned to data.{name,total_karma,link_karma,comment_karma,
 *                         subreddit.subscribers}>, about: <the /user/<name>/about.json body, same pruning, or null> }`
 *   facebook  step 0   `{ text: <innerText, at most 20000 chars> }`
 */
export type PageStatus = 'ok' | 'signed_out' | 'empty' | 'error';

export interface PageMessage {
  /** Discriminator: the app ignores any other message the page posts. */
  pulse: 'autoRead';
  platform: Platform;
  step: number;
  status: PageStatus;
  data?: unknown;
}

/** Values carried from one step to the next (X: the handle found on /home). */
export interface StepCtx {
  handle?: string | null;
}

/** Shown to the person (as a note on the card) whenever the automatic read gives up. Nothing is typed by hand any more. */
export const AUTO_READ_FAILED = "Couldn't read it automatically. Upload a screenshot instead.";

/** Props of `AutoReadSheet` (`src/autoRead/index.tsx`). */
export interface AutoReadSheetProps {
  platform: Platform;
  /** The sheet renders nothing while false; it starts a fresh read every time it turns true. */
  visible: boolean;
  /**
   * Called once when the sheet ends WITHOUT a result: `reason` is set when the automatic read gave up (the card shows
   * it), and omitted when the person pressed Close. After `onResult` the sheet does NOT also call `onClose`: the card
   * hides the sheet (`visible=false`) itself.
   */
  onClose: (reason?: string) => void;
  /** Called once with the numbers read from the person's own signed-in pages (`source` is always 'device'). */
  onResult: (read: DeviceRead) => void;
  /** The card's screenshot call (`POST /api/connections/{platform}/screenshot`); used only when reading the page fails. */
  readScreenshot: (base64: string, mediaType: 'image/jpeg') => Promise<ScreenshotRead>;
  /** Optional public handle: enables the free anonymous first try (reddit, tiktok, instagram only). */
  handle?: string | null;
}
