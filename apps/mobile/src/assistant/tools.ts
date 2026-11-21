/**
 * The Assistant's tools, run on the phone against Pulse's own REST API (`@/src/api`, the workspace token). They mirror
 * the remote MCP tools in apps/api/app/mcp_server.py (same names, same trimmed shapes). Only the dashboard, trends,
 * posts and the post-confirm dialog are exposed: no browser, harvest or autopilot tools.
 *
 * Pure: no react-native import. The api client and the confirm dialog arrive as `ToolDeps`, so this runs under Node
 * (tools.test.ts). Every failure is a `ToolError` or a thrown api error, mapped to `is_error: true` by `runTool`.
 */
import type Anthropic from '@anthropic-ai/sdk';

import { LIVE_PLATFORMS, isLivePlatform } from '@/src/platforms';
import type { DashboardSummary, Platform, Post, PostStatus, PulseApi, Trend } from '@/src/types';

/** The slice of the Pulse api the tools use. */
export type PulseToolsApi = Pick<PulseApi, 'getDashboard' | 'listTrends' | 'listPosts' | 'createPost' | 'publishPost'>;

/** What Claude asked to post, shown in the confirm dialog (the caption is editable there). */
export interface PostProposal {
  caption: string;
  /** A saved Pulse post this caption comes from: marked published once the photo is handed to Instagram. */
  postId: string | null;
}

/** How the confirm dialog ended. `shared`: sent to Instagram's share sheet / app, the person finishes there. */
export type PostOutcome =
  | { status: 'posted'; caption: string; url: string | null }
  | { status: 'shared'; caption: string }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

export interface ToolDeps {
  api: PulseToolsApi;
  /** Opens the confirm dialog and resolves when the person has answered. Must resolve `cancelled` when `signal` aborts. */
  proposePost: (proposal: PostProposal, signal?: AbortSignal) => Promise<PostOutcome>;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** The tool_result content: compact JSON, or the error sentence. */
  content: string;
  isError: boolean;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Instagram's caption limit. */
export const MAX_CAPTION = 2200;
/** A tool result longer than this is cut (the model rarely needs more, and it is sent on every later request). */
const MAX_RESULT_CHARS = 20_000;

const POST_STATUSES: readonly PostStatus[] = ['draft', 'scheduled', 'published', 'failed'];

const platformSchema = { type: 'string', enum: [...LIVE_PLATFORMS] } as const;

/** `strict: true` schemas (additionalProperties false; no min/max, the code clamps). Names match the MCP tools. */
export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_dashboard',
    description:
      'Summarise the workspace dashboard: totals, change vs the previous period, the sales funnel (views, engagements, clicks, conversions), views by platform and the top 3 posts. `days` is the window (default 30). `platform` optionally filters to one platform.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Window in days, 1 to 365. Default 30.' }, platform: platformSchema },
      additionalProperties: false,
    },
  },
  {
    name: 'list_trends',
    description:
      'List current outside trends (Hacker News, Reddit, Google Trends) ranked for this workspace brand. Use them as post ideas.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'How many, 1 to 30. Default 10.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_posts',
    description:
      'List posts newest first with their text and metrics. Optional filters: `status` and `platform`. `limit` defaults to 20 (max 50).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...POST_STATUSES] },
        platform: platformSchema,
        limit: { type: 'integer', description: 'How many, 1 to 50. Default 20.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_post',
    description:
      'Save a post as a DRAFT in Pulse (linkedin or instagram only). It is not published: the person publishes it themselves. Returns the saved post with its id.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        platform: platformSchema,
        content: { type: 'string', description: 'The post text, up to 5000 characters.' },
        hashtags: { type: 'array', items: { type: 'string' }, description: 'Hashtags without the # sign.' },
      },
      required: ['platform', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_instagram_post',
    description:
      'Propose an Instagram post to the person. Opens a dialog with your caption (they can edit it) and a photo picker; nothing is posted unless they choose a photo and press the button. You cannot create or pick the photo. Returns "posted", "handed_to_instagram" (they finish in the Instagram share sheet) or "cancelled". Pass `post_id` when the caption comes from a saved draft.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        caption: { type: 'string', description: 'The caption, up to 2200 characters, hashtags included.' },
        post_id: { type: 'string', description: 'Id of the saved Pulse draft this caption comes from, if any.' },
      },
      required: ['caption'],
      additionalProperties: false,
    },
  },
];

// ---- input checks (the model's input is untrusted: strict schemas help, they do not replace this) -------------------

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function clampInt(v: unknown, def: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
}

function optPlatform(v: unknown): Platform | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !isLivePlatform(v)) throw new ToolError(`platform must be one of: ${LIVE_PLATFORMS.join(', ')}.`);
  return v;
}

function optStatus(v: unknown): PostStatus | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !(POST_STATUSES as readonly string[]).includes(v)) {
    throw new ToolError(`status must be one of: ${POST_STATUSES.join(', ')}.`);
  }
  return v as PostStatus;
}

// ---- trimmed shapes, as the MCP server returns them -------------------------------------------------------------------

const POST_FIELDS = [
  'id',
  'platform',
  'status',
  'content',
  'hashtags',
  'theme_id',
  'trend_id',
  'link_url',
  'views',
  'engagements',
  'clicks',
  'conversions',
  'published_at',
  'scheduled_at',
  'created_at',
] as const;

export function trimPost(p: Post): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of POST_FIELDS) if (k in p) out[k] = p[k];
  return out;
}

export function summariseDashboard(d: DashboardSummary): Record<string, unknown> {
  return {
    days: d.days,
    totals: d.totals,
    change_pct: d.change_pct,
    funnel: d.funnel,
    by_platform: d.by_platform,
    real_clicks: d.real_clicks,
    real_conversions: d.real_conversions,
    top_posts: (d.top_posts ?? []).slice(0, 3).map(trimPost),
  };
}

const trimTrend = (t: Trend) => ({
  id: t.id,
  source: t.source,
  title: t.title,
  url: t.url,
  score: t.score,
  relevance: t.relevance,
  match_terms: t.match_terms,
});

const compact = (data: unknown): string => {
  const text = JSON.stringify(data);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}... (cut: ask for fewer items)` : text;
};

// ---- dispatch ----------------------------------------------------------------------------------------------------------

async function propose(input: Record<string, unknown>, deps: ToolDeps): Promise<string> {
  const caption = typeof input.caption === 'string' ? input.caption.trim() : '';
  if (!caption) throw new ToolError('caption is empty.');
  if (caption.length > MAX_CAPTION) throw new ToolError(`caption is ${caption.length} characters: Instagram allows ${MAX_CAPTION}. Shorten it.`);
  const postId = typeof input.post_id === 'string' && input.post_id.trim() ? input.post_id.trim() : null;

  const outcome = await deps.proposePost({ caption, postId }, deps.signal);
  if (outcome.status === 'cancelled') {
    return compact({ status: 'cancelled', note: 'The person cancelled. Nothing was posted.' });
  }
  if (outcome.status === 'failed') throw new ToolError(`Posting failed: ${outcome.message}`);

  // Same as the Create and Queue buttons: once the photo is with Instagram the Pulse draft counts as published.
  let marked: boolean | undefined;
  if (postId) {
    try {
      marked = (await deps.api.publishPost(postId)).status === 'published';
    } catch {
      marked = false;
    }
  }
  const base = { caption: outcome.caption, ...(marked === undefined ? null : { pulse_post_marked_published: marked }) };
  return compact(
    outcome.status === 'posted'
      ? { status: 'posted', url: outcome.url, ...base }
      : {
          status: 'handed_to_instagram',
          note: "The person chose a photo and sent it to Instagram's share sheet. Pulse cannot see whether they finished posting.",
          ...base,
        },
  );
}

async function dispatch(name: string, raw: unknown, deps: ToolDeps): Promise<string> {
  const input = obj(raw);
  switch (name) {
    case 'get_dashboard': {
      const days = clampInt(input.days, 30, 1, 365);
      return compact(summariseDashboard(await deps.api.getDashboard({ days, platform: optPlatform(input.platform) ?? null })));
    }
    case 'list_trends': {
      const trends = await deps.api.listTrends({ limit: clampInt(input.limit, 10, 1, 30) });
      return compact(trends.map(trimTrend));
    }
    case 'list_posts': {
      const posts = await deps.api.listPosts({
        status: optStatus(input.status) ?? null,
        platform: optPlatform(input.platform) ?? null,
        limit: clampInt(input.limit, 20, 1, 50),
      });
      return compact(posts.map(trimPost));
    }
    case 'create_post': {
      const platform = optPlatform(input.platform);
      const content = typeof input.content === 'string' ? input.content.trim() : '';
      if (!platform) throw new ToolError(`platform is required: ${LIVE_PLATFORMS.join(' or ')}.`);
      if (!content) throw new ToolError('content is empty.');
      if (content.length > 5000) throw new ToolError('content is over 5000 characters. Shorten it.');
      const hashtags = (Array.isArray(input.hashtags) ? input.hashtags : [])
        .filter((h): h is string => typeof h === 'string')
        .map((h) => h.trim().replace(/^#+/, ''))
        .filter(Boolean)
        .slice(0, 30);
      return compact(trimPost(await deps.api.createPost({ platform, content, hashtags, status: 'draft' })));
    }
    case 'propose_instagram_post':
      return propose(input, deps);
    default:
      throw new ToolError(`Unknown tool: ${name}.`);
  }
}

/** Runs one tool call. Never throws: a failure becomes `{ isError: true }` with a sentence Claude can act on. */
export async function runTool(name: string, input: unknown, deps: ToolDeps): Promise<ToolResult> {
  try {
    return { content: await dispatch(name, input, deps), isError: false };
  } catch (e) {
    // ToolError text is ours; an api error's message is the server's detail (ApiError). Neither holds a secret.
    const message = e instanceof Error && e.message ? e.message : 'The tool failed.';
    return { content: message.slice(0, 500), isError: true };
  }
}
