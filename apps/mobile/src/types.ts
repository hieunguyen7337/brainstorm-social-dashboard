/**
 * API types. These mirror `apps/api/app/models.py` field for field (docs/CONTRACT.md is the source of truth).
 * Pydantic fields with defaults are optional on request bodies and always present on responses.
 */

export type Platform = 'linkedin' | 'instagram' | 'x' | 'tiktok' | 'reddit' | 'facebook';
export type PostStatus = 'draft' | 'scheduled' | 'published' | 'failed';

/** Channel order everywhere in the UI (founders' priority): LinkedIn, Instagram (+ TikTok), X, Reddit, Facebook. */
export const PLATFORMS: readonly Platform[] = [
  'linkedin',
  'instagram',
  'tiktok',
  'x',
  'reddit',
  'facebook',
] as const;

/** Preselected on Create. */
export const PRIMARY_PLATFORMS: readonly Platform[] = ['linkedin', 'instagram'] as const;

// ---- workspace -------------------------------------------------------------------------------

export interface WorkspaceCreate {
  brand_name?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  brand_name: string;
  brand_voice: string;
  audience: string;
  offer: string;
  product_url: string;
  created_at: string;
}

export interface WorkspaceWithToken extends Workspace {
  token: string;
}

export interface WorkspacePatch {
  name?: string | null;
  brand_name?: string | null;
  brand_voice?: string | null;
  audience?: string | null;
  offer?: string | null;
  product_url?: string | null;
}

// ---- connections -----------------------------------------------------------------------------

export interface Connection {
  platform: Platform;
  handle: string;
  status: 'connected' | 'disconnected';
  mode: 'sandbox' | 'live';
  followers: number;
  connected_at: string;
}

export interface ConnectionCreate {
  handle: string; // 1..60 chars
}

// ---- posts -----------------------------------------------------------------------------------

export interface Post {
  id: string;
  platform: Platform;
  content: string;
  hashtags: string[];
  media_prompt: string;
  theme_id: string | null;
  trend_id: string | null;
  batch_id: string | null;
  link_code: string | null;
  /** Absolute tracked link: PUBLIC_BASE_URL + /r/<code>. */
  link_url: string | null;
  status: PostStatus;
  source: 'manual' | 'ai' | 'autopilot' | 'seed';
  scheduled_at: string | null;
  published_at: string | null;
  views: number;
  engagements: number;
  clicks: number;
  conversions: number;
  created_at: string;
}

export interface PostCreate {
  platform: Platform;
  content: string; // 1..5000 chars
  hashtags?: string[];
  media_prompt?: string;
  theme_id?: string | null;
  trend_id?: string | null;
  status?: 'draft' | 'scheduled';
  scheduled_at?: string | null;
}

export interface PostPatch {
  content?: string | null;
  hashtags?: string[] | null;
  media_prompt?: string | null;
  status?: 'draft' | 'scheduled' | null;
  scheduled_at?: string | null;
}

// ---- dashboard -------------------------------------------------------------------------------

export interface PlatformStats {
  platform: Platform;
  views: number;
  engagements: number;
  clicks: number;
  conversions: number;
  /** Share of total views, 0..1. */
  share: number;
}

export type FunnelStageName = 'views' | 'engagements' | 'clicks' | 'conversions';

export interface FunnelStage {
  stage: FunnelStageName;
  value: number;
  /** Conversion from the previous stage, 0..1 (1.0 for views). */
  rate: number;
}

export interface DayStats {
  day: string;
  views: number;
  engagements: number;
  clicks: number;
  conversions: number;
}

export interface Totals {
  views: number;
  engagements: number;
  clicks: number;
  conversions: number;
}

export interface DashboardSummary {
  days: number;
  totals: Totals;
  /** % change vs the previous period of the same length (ints, may be negative). */
  change_pct: Totals;
  by_platform: PlatformStats[];
  funnel: FunnelStage[];
  timeseries: DayStats[];
  top_posts: Post[];
  /** Clicks by real people on tracked links in the period. */
  real_clicks: number;
  real_conversions: number;
}

export interface ActivityItem {
  id: string;
  type: string;
  platform: Platform | null;
  post_id: string | null;
  detail: string;
  real: boolean;
  ts: string;
}

// ---- themes / trends / generation / ai --------------------------------------------------------

export interface Theme {
  id: string;
  name: string;
  description: string;
  color: string;
  active: boolean;
  created_at: string;
}

export interface ThemeCreate {
  name: string; // 1..60 chars
  description?: string;
  color?: string; // default "#7c5cff"
}

export interface ThemePatch {
  name?: string | null;
  description?: string | null;
  color?: string | null;
  active?: boolean | null;
}

export type TrendSource = 'hackernews' | 'reddit' | 'google';

export interface Trend {
  id: string;
  source: TrendSource;
  title: string;
  url: string;
  /** Source popularity 0..1. */
  score: number;
  /** Match to this workspace's brand 0..1. */
  relevance: number;
  fetched_at: string;
}

export interface GenerateRequest {
  platforms: Platform[]; // at least one
  theme_id?: string | null;
  trend_id?: string | null;
  brief?: string; // max 1000 chars
  tone?: string;
}

export interface GenerateResponse {
  batch_id: string;
  /** false => deterministic template fallback ("template mode"). */
  ai_used: boolean;
  /** One draft per requested platform, already saved. */
  posts: Post[];
}

export interface AiUsage {
  workspace_used: number;
  workspace_limit: number;
  global_spent_usd: number;
  global_cap_usd: number;
  ai_available: boolean;
}

// ---- autopilot -------------------------------------------------------------------------------

export interface AutopilotConfig {
  enabled: boolean;
  interval_min: number; // 1..1440
  platforms: Platform[];
  require_approval: boolean;
  last_run_at: string | null;
}

export interface AutopilotRun {
  ran_at: string;
  trend_id: string | null;
  theme_id: string | null;
  posts: Post[];
}

export interface Health {
  ok: boolean;
  app: string;
  version: string;
}

// ---- the client surface (real client and in-memory mock both implement this) -------------------

export interface DashboardQuery {
  days?: number;
  platform?: Platform | null;
}

export interface PostsQuery {
  status?: PostStatus | null;
  platform?: Platform | null;
  limit?: number;
}

export interface TrendsQuery {
  refresh?: boolean;
  limit?: number;
}

export interface PulseApi {
  health(): Promise<Health>;

  /** POST /api/workspaces (public). The caller stores `token` via `session.start`. */
  createWorkspace(body?: WorkspaceCreate): Promise<WorkspaceWithToken>;
  getWorkspace(): Promise<Workspace>;
  patchWorkspace(body: WorkspacePatch): Promise<Workspace>;

  listConnections(): Promise<Connection[]>;
  connect(platform: Platform, body: ConnectionCreate): Promise<Connection>;
  disconnect(platform: Platform): Promise<Connection>;

  getDashboard(query?: DashboardQuery): Promise<DashboardSummary>;
  getActivity(limit?: number): Promise<ActivityItem[]>;

  listPosts(query?: PostsQuery): Promise<Post[]>;
  createPost(body: PostCreate): Promise<Post>;
  patchPost(id: string, body: PostPatch): Promise<Post>;
  deletePost(id: string): Promise<{ ok: true }>;
  publishPost(id: string): Promise<Post>;
  /** POST /api/links/{code}/convert (public). */
  convertLink(code: string): Promise<{ ok: true }>;

  listThemes(): Promise<Theme[]>;
  createTheme(body: ThemeCreate): Promise<Theme>;
  patchTheme(id: string, body: ThemePatch): Promise<Theme>;
  deleteTheme(id: string): Promise<{ ok: true }>;

  generate(body: GenerateRequest): Promise<GenerateResponse>;
  getAiUsage(): Promise<AiUsage>;

  getAutopilot(): Promise<AutopilotConfig>;
  putAutopilot(body: AutopilotConfig): Promise<AutopilotConfig>;
  runAutopilot(): Promise<AutopilotRun>;

  listTrends(query?: TrendsQuery): Promise<Trend[]>;
}
