/**
 * The three `pulse_desktop` tools (docs/DESKTOP.md 4.6). All side effects arrive through `ToolDeps`, so this runs under
 * plain Node in tests. Results never contain cookies, tokens or image data.
 */
import type { ConnectResult, Platform, PublishConfirmAnswer, PublishConfirmRequest, SocialStatus } from '@/src/desktop/types';
import { z } from 'zod';
import type { PostOutcome, PostRequest } from '../social/post.ts';
import { MAX_CAPTION } from './confirm.ts';
import { buildIngestRequest, summarizeRead } from './ingest.ts';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolDeps {
  apiUrl: string;
  getToken(): string | null;
  hasWindow(): boolean;
  status(): Promise<Record<Platform, SocialStatus>>;
  read(platform: Platform): Promise<ConnectResult>;
  confirm(req: Omit<PublishConfirmRequest, 'id'>): Promise<PublishConfirmAnswer>;
  post(req: PostRequest): Promise<PostOutcome>;
  fetch: typeof fetch;
  now(): number;
  readPlatforms: readonly Platform[];
  publishPlatforms: readonly Platform[];
  readIntervalMs?: number;
  maxPublishesPerDay?: number;
}

export const READ_INTERVAL_MS = 10 * 60_000;
export const MAX_PUBLISHES_PER_DAY = 5;
const DAY_MS = 24 * 3_600_000;

const PLATFORM_NAMES: Record<string, string> = {
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  x: 'X',
  reddit: 'Reddit',
  facebook: 'Facebook',
};
const nameOf = (p: string): string => PLATFORM_NAMES[p] ?? p;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });
const json = (o: unknown): ToolResult => text(JSON.stringify(o));
export const signedOutText = (p: string): string =>
  `${nameOf(p)} needs the person to sign in again: ask them to press Connect with ${nameOf(p)} in Pulse.`;

export const TOOL_DESCRIPTIONS = {
  social_status:
    "Which social accounts the person has signed in to inside Pulse Desktop, and when Pulse last read each one's numbers. Read-only.",
  social_read_metrics:
    "Reads the person's own numbers (followers, views, engagements, recent posts) from the platform in a hidden window using their " +
    'signed-in session, and saves them to Pulse. Never posts. At most one read per platform every 10 minutes.',
  social_publish:
    'Publishes a post to the person\'s own account (Instagram only for now). This does NOT post by itself: Pulse shows the person a ' +
    'confirmation with the caption, and they pick the photo and press Post in Pulse. If they cancel, nothing is posted. ' +
    'Instagram needs a photo, so ask for a caption only; the person chooses the image. At most 5 posts a day.',
} as const;

export function createTools(deps: ToolDeps) {
  const readInterval = deps.readIntervalMs ?? READ_INTERVAL_MS;
  const maxPerDay = deps.maxPublishesPerDay ?? MAX_PUBLISHES_PER_DAY;
  const lastRead = new Map<string, { at: number; result: ToolResult }>();
  const handles = new Map<string, string>();
  let publishing = false;
  let publishTimes: number[] = [];

  const api = async (path: string, body?: unknown): Promise<unknown> => {
    const res = await deps.fetch(`${deps.apiUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.getToken() ?? ''}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => null);
  };

  async function socialStatus(): Promise<ToolResult> {
    const s = await deps.status();
    return json(Object.fromEntries(deps.readPlatforms.map((p) => [p, s[p]])));
  }

  async function readMetrics(args: { platform: string }): Promise<ToolResult> {
    const platform = args.platform as Platform;
    if (!deps.readPlatforms.includes(platform)) return text(`Unknown platform "${args.platform}".`, true);
    if (!deps.getToken()) return text('Open Pulse and finish setup first.', true);
    const prev = lastRead.get(platform);
    if (prev && deps.now() - prev.at < readInterval) {
      const mins = Math.max(1, Math.ceil((readInterval - (deps.now() - prev.at)) / 60_000));
      return text(
        `${nameOf(platform)} was read less than 10 minutes ago, so it was not read again (next read in about ${mins} min). ` +
          `Last result: ${prev.result.content[0].text}`,
        prev.result.isError === true,
      );
    }
    const result = await readOnce(platform);
    lastRead.set(platform, { at: deps.now(), result });
    return result;
  }

  async function readOnce(platform: Platform): Promise<ToolResult> {
    let r: ConnectResult;
    try {
      r = await deps.read(platform);
    } catch {
      return text(`Couldn't read ${nameOf(platform)} right now. Nothing was saved.`, true);
    }
    if (!r.ok) {
      if (r.reason === 'signed_out') return text(signedOutText(platform));
      return text(r.reason ?? `Couldn't read ${nameOf(platform)}. Nothing was saved.`, true);
    }
    if (r.read.handle) handles.set(platform, r.read.handle);
    const numbers = summarizeRead(r.read);
    const request = buildIngestRequest(r.read);
    if (!request) return json({ numbers, saved: false, note: 'No account numbers were found on the page.' });
    try {
      const saved = (await api('/api/metrics/ingest', request)) as Record<string, unknown> | null;
      return json({
        numbers,
        saved: true,
        ingest: saved ? { matched: saved.matched, created: saved.created, snapshots: saved.snapshots, captured_at: saved.captured_at } : null,
      });
    } catch {
      return json({ numbers, saved: false, note: "The numbers were read but couldn't be saved to Pulse." });
    }
  }

  async function publish(args: { platform: string; caption: string; pulse_post_id?: string }): Promise<ToolResult> {
    const platform = args.platform as Platform;
    if (!deps.publishPlatforms.includes(platform)) {
      return text(`Publishing to ${nameOf(args.platform)} isn't supported yet. Only Instagram can be posted from Pulse Desktop.`, true);
    }
    if (typeof args.caption !== 'string' || args.caption.trim() === '' || args.caption.length > MAX_CAPTION) {
      return text(`The caption must be 1 to ${MAX_CAPTION} characters.`, true);
    }
    const postId = args.pulse_post_id ?? null;
    if (postId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(postId)) return text('pulse_post_id is not valid.', true);
    if (publishing) return text('Another post is already waiting for the person. Try again after it finishes.', true);
    const t = deps.now();
    publishTimes = publishTimes.filter((x) => t - x < DAY_MS);
    if (publishTimes.length >= maxPerDay) return text(`The limit of ${maxPerDay} posts a day has been reached.`, true);
    publishing = true;
    try {
      const status = await deps.status();
      if (!status[platform]?.signedIn) return text(signedOutText(platform));
      if (!deps.hasWindow()) return text('Pulse is not open, so the person cannot confirm. Nothing was posted.', true);
      const answer = await deps.confirm({
        platform,
        handle: handles.get(platform) ?? null,
        caption: args.caption,
        pulsePostId: postId,
      });
      if (!answer.ok) return text('The person cancelled; nothing was posted.');
      publishTimes.push(deps.now());
      const outcome = await deps.post({ caption: answer.caption, imageBase64: answer.imageBase64, mediaType: answer.mediaType });
      if (!outcome.ok) return text(outcome.text, true);
      const out: Record<string, unknown> = { posted: true, platform, url: outcome.url, code: outcome.code };
      if (postId) {
        try {
          await api(`/api/posts/${encodeURIComponent(postId)}/publish`);
          out.pulse_post_marked_published = true;
        } catch {
          out.pulse_post_marked_published = false;
          out.note = "It was posted, but Pulse couldn't mark the post as published.";
        }
      }
      return json(out);
    } catch {
      return text("Couldn't post. Nothing was retried.", true);
    } finally {
      publishing = false;
    }
  }

  return { socialStatus, readMetrics, publish };
}

export type Tools = ReturnType<typeof createTools>;

export const platformArg = z.string().min(1).max(32).describe('instagram, linkedin, tiktok, x, reddit or facebook');
export const publishArgs = {
  platform: platformArg.describe('Only "instagram" for now'),
  caption: z.string().min(1).max(MAX_CAPTION).describe('The post text (max 2200 characters). The person can edit it before posting.'),
  pulse_post_id: z.string().max(64).optional().describe('A Pulse post id to mark as published once it is posted'),
};
