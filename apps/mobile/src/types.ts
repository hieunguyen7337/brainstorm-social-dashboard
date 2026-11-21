/**
 * API types. These mirror `apps/api/app/models.py` field for field (docs/CONTRACT.md is the source of truth).
 * Pydantic fields with defaults are optional on request bodies and always present on responses.
 */

export type Platform = 'linkedin' | 'instagram' | 'x' | 'tiktok' | 'reddit' | 'facebook';
export type PostStatus = 'draft' | 'scheduled' | 'published' | 'failed';

export const PLATFORMS: readonly Platform[] = [
  'linkedin',
  'instagram',
  'x',
  'tiktok',
  'reddit',
  'facebook',
] as const;

// ---- workspace -------------------------------------------------------------------------------

export interface WorkspaceCreate {
  brand_name?: string | null;
  /**
   * true: a real workspace (docs/REAL.md): no seeded audience, posts or numbers; they appear when the person connects an
   * account. The app always sends true. false keeps the sample seed (tests, the MCP demo).
   */
  real?: boolean;
  /**
   * true: a demo workspace (docs/REAL.md, "Demo workspaces"): sign-ins and numbers are synthetic and labelled as such.
   * Only the "Try the demo" link sends it. Never combined with `real`.
   */
  demo?: boolean;
}

/**
 * 'real': every number comes from the person (a screenshot or typed). 'sample': an old seeded workspace (tests, the MCP
 * demo). 'demo': the labelled synthetic workspace behind "Try the demo".
 */
export type DataMode = 'sample' | 'real' | 'demo';

export interface Workspace {
  id: string;
  name: string;
  brand_name: string;
  brand_voice: string;
  audience: string;
  offer: string;
  product_url: string;
  created_at: string;
  /** Absent on servers older than docs/REAL.md: treat as 'sample'. */
  data_mode?: DataMode;
  /** What Claude learned from the person's own writing. Absent or null until they upload some. */
  writing_style?: WritingStyle | null;
}

/** docs/CONTRACT.md, "Writing style". */
export interface WritingStyle {
  summary: string;
  traits: string[];
  examples: string[];
  /** Names of what it learned from, newest last. */
  sources: string[];
  /** Samples learned from so far (files, screenshots and pasted text). */
  file_count: number;
  sample_chars: number;
  updated_at: string;
}

/** One file of a `POST /api/workspace/style` batch. */
export interface StyleFileUpload {
  name: string;
  media_type: string;
  /** Base64 of the file bytes, with no `data:` prefix. */
  data_base64: string;
}

/** At most 10 files per request (the app sends up to 100 files as batches, one after another). */
export interface StyleLearnRequest {
  files?: StyleFileUpload[];
  text?: string;
}

export interface StyleSkipped {
  name: string;
  reason: string;
}

export interface StyleLearnResult {
  style: WritingStyle;
  skipped: StyleSkipped[];
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
  /** Public profile page of the connected account. Optional: the API may not send it yet. */
  profile_url?: string | null;
  /** When the account's real numbers were last pulled (ISO). Optional: the API may not send it yet. */
  last_harvested_at?: string | null;
  /** True when this connector's numbers come from the real profile instead of the simulated audience. */
  real_data?: boolean;
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
  /** Followers on this platform (connected platforms only). Absent on servers older than docs/REAL.md. */
  followers?: number;
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
  /** Absent on servers older than docs/REAL.md. In a real workspace a 0 in `change_pct` means "no history yet": show "new". */
  data_mode?: DataMode;
  /** Followers across the connected platforms. Absent on servers older than docs/REAL.md. */
  followers_total?: number;
  /** The number each KPI tile shows; null = never read from the platform (show "—" and the reason). Absent on older servers: fall back to today's values. */
  tiles?: Partial<Record<keyof Totals, number | null>>;
  /** Short reason per metric whose `tiles` value is null, e.g. "Instagram does not share views for photo posts", "Not read yet: open Connect to read". */
  not_read?: Partial<Record<keyof Totals, string>>;
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
  /** Source popularity 0..1, ranked within its source's batch (so values spread across the range). */
  score: number;
  /** Match to this workspace's brand 0..1. `null` = the workspace has no brand profile yet: show no percentage. */
  relevance: number | null;
  /** Words in the title that overlap the brand profile (lowercase, at most 5). Absent on servers older than this field. */
  match_terms?: string[];
  /** When this row was last fetched from its source (ISO, UTC). */
  fetched_at: string;
  platform?: Platform;
}

/** One source's last fetch attempt (GET /api/trends/status). */
export interface TrendSourceStatus {
  source: TrendSource;
  /** Result of the last fetch attempt; null = not attempted since the server started. */
  ok: boolean | null;
  attempted_at: string | null;
  /** When rows of this source were last stored (null if never). */
  fetched_at: string | null;
  /** Rows stored for this source. */
  count: number;
  /** Why the last attempt failed when `ok` is false, e.g. "Blocked by Reddit (HTTP 403)". */
  error: string | null;
}

/** GET /api/trends/status: always three sources, in hackernews, reddit, google order. */
export interface TrendsStatus {
  sources: TrendSourceStatus[];
  newest_fetched_at: string | null;
  oldest_fetched_at: string | null;
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

// ---- insights (GET /api/insights, apps/api/app/services/insights.py) --------------------------------

/** Who assigned a post to a theme. */
export type ClassifierName = 'jev' | 'claude' | 'keyword' | 'manual';

/** Posts per classifier. Keys with a zero count are omitted by the API. */
export interface ClassifierCounts {
  jev?: number;
  claude?: number;
  keyword?: number;
  manual?: number;
}

/** Published-post totals and rates (rate = count / views) for a group of posts. */
export interface InsightMetrics {
  posts: number;
  views: number;
  engagements: number;
  clicks: number;
  /** Conversions (posts.conversions). */
  onboard: number;
  engagement_rate: number;
  click_rate: number;
  onboard_rate: number;
}

/** Rate / baseline rate - 1 per metric (0.25 = 25% above the workspace baseline; 0 when the baseline rate is 0). */
export interface LiftBy {
  engagement_rate: number;
  click_rate: number;
  onboard_rate: number;
}

export interface ThemeInsight extends InsightMetrics {
  theme_id: string;
  name: string;
  color: string;
  /** Primary lift as a fraction (0.25 = 25% above the baseline): onboard, else click, else engagement rate. */
  lift: number;
  lift_by: LiftBy;
  /** How many of this theme's posts each classifier assigned. */
  classifiers: ClassifierCounts;
}

export interface PlatformInsight extends InsightMetrics {
  platform: Platform;
  lift: number;
  lift_by: LiftBy;
}

export interface InsightsResponse {
  days: number;
  /** All published posts in the window, themed or not. */
  baseline: InsightMetrics;
  themes: ThemeInsight[];
  platforms: PlatformInsight[];
  /** Best themes by lift, already ranked. */
  top_themes: ThemeInsight[];
  /** Published posts whose numbers are real vs simulated. */
  sources: { real: number; simulated: number };
  summary: string;
  cached_summary: { body: string; created_at: string } | null;
  /** The same classifier counts over every themed post in the window. */
  classifiers: ClassifierCounts;
}

export interface InsightsQuery {
  days?: number;
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

// ---- real numbers: screenshot read + ingest (docs/REAL.md) ------------------------------------

export type ScreenshotMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

/** POST /api/connections/{platform}/screenshot body. `image_base64` has no `data:` prefix; decoded size at most 5 MB. */
export interface ScreenshotRequest {
  image_base64: string;
  media_type: ScreenshotMediaType;
}

export interface ScreenshotPost {
  /** First 200 characters. */
  content: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** YYYY-MM-DD. */
  posted_at: string | null;
}

/** What Claude read from the image. Nothing is saved by that call; null means "not shown in the image". */
export interface ScreenshotRead {
  /** The platform in the request path. */
  platform: Platform;
  /** What the image looks like; the app warns when it differs from `platform`. */
  detected_platform: Platform | null;
  handle: string | null;
  followers: number | null;
  following: number | null;
  posts_count: number | null;
  views: number | null;
  engagements: number | null;
  profile_views: number | null;
  /** The window views, engagements and profile views cover, when the image shows one. */
  period_days: 7 | 30 | 90 | null;
  /** Max 20. */
  posts: ScreenshotPost[];
  confidence: 'high' | 'medium' | 'low';
  /** One short line for the person. */
  notes: string | null;
  ai_used: boolean;
}

/** `screenshot` = read by Claude and checked by the person, `manual` = typed, `device` = read on the phone. */
export type IngestSource = 'script' | 'claude_chrome' | 'manual' | 'screenshot' | 'device';

export interface IngestAccount {
  followers?: number | null;
  views?: number | null;
  engagements?: number | null;
  clicks?: number | null;
  profile_views?: number | null;
}

export interface IngestPost {
  external_id?: string | null;
  url?: string | null;
  content?: string | null;
  /** YYYY-MM-DD. */
  posted_at?: string | null;
  /** Required by the API: send 0 for a missing one only when the other is known, else skip the post. */
  views: number;
  engagements: number;
  clicks?: number | null;
  conversions?: number | null;
}

/** POST /api/metrics/ingest body. */
export interface IngestRequest {
  platform: Platform;
  source: IngestSource;
  /** Max 100 characters; a leading `@` is stripped by the server. */
  handle?: string | null;
  /** The window views, engagements and profile views cover. */
  period_days?: number | null;
  account?: IngestAccount;
  posts?: IngestPost[];
}

export interface IngestResult {
  platform: Platform;
  source: string;
  matched: number;
  created: number;
  snapshots: number;
  /** ISO time the numbers were saved. */
  captured_at: string;
}

/** GET /api/connections/harvest-status (one entry per platform). */
export interface HarvestStatus {
  platform: Platform;
  connected: boolean;
  profile_url: string | null;
  /** When numbers were last saved for this platform (ISO), whatever the source. */
  last_harvest_at: string | null;
  last_source: string | null;
  followers: number | null;
  real_posts: number;
  snapshots: number;
}

/** POST /api/connections/{platform}/demo (demo workspaces only): the synthetic sign-in and the numbers it "read". */
export interface DemoSignInResult {
  platform: Platform;
  connection: Connection;
  followers: number;
  /** 30-day totals of the synthetic numbers. */
  views: number;
  engagements: number;
  period_days: number;
  posts_added: number;
  /** false when the platform was already signed in: nothing was added twice. */
  fresh: boolean;
  captured_at: string;
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

/** GET /api/posts/{id}/share: where to open the real composer for one post. */
export interface ShareInfo {
  platform: Platform;
  /** Composer / intent URL; null for Instagram and TikTok (copy the caption instead). */
  url: string | null;
  /** Threads composer URL, only for X posts. */
  threads_url: string | null;
  /** Text to copy (content plus hashtags). */
  caption: string;
  /** Instagram/TikTok: why there is no composer link and what to do instead. */
  instagram_note: string | null;
}

/** POST /api/rooms: a crowd room (Room mode). */
export interface RoomInfo {
  code: string;
  /** Big-screen page; open it with `?token=<session token>`. */
  screen_url: string;
  /** What phones in the room open (QR target). */
  join_url: string;
  title: string;
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
  /** GET /api/insights: theme and platform lift against the workspace baseline. */
  getInsights(query?: InsightsQuery): Promise<InsightsResponse>;

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
  /** GET /api/trends/status: per source, when it was last fetched and why it failed (if it did). Old servers may 404. */
  trendsStatus(): Promise<TrendsStatus>;

  /** POST /api/connections/{platform}/screenshot: Claude reads a profile or insights screenshot. Saves nothing. 503 = AI off or capped. */
  readScreenshot(platform: Platform, body: ScreenshotRequest): Promise<ScreenshotRead>;
  /** POST /api/workspace/style: one batch of the person's writing refines their learned style. 503 = AI off or capped. */
  learnStyle(body: StyleLearnRequest): Promise<StyleLearnResult>;
  /** DELETE /api/workspace/style: forget the learned style. */
  forgetStyle(): Promise<{ ok: true }>;
  /** POST /api/metrics/ingest: save numbers the person checked (source "screenshot") or typed (source "manual"). */
  ingestMetrics(body: IngestRequest): Promise<IngestResult>;
  /** GET /api/connections/harvest-status: when each platform's numbers were last saved. */
  getHarvestStatus(): Promise<HarvestStatus[]>;
  /** POST /api/connections/{platform}/demo: the synthetic sign-in of a demo workspace (409 anywhere else). */
  demoSignIn(platform: Platform): Promise<DemoSignInResult>;

  /** GET /api/posts/{id}/share (may 404 until the room/share API is deployed: callers fall back to `buildShareInfo`). */
  getShare(postId: string): Promise<ShareInfo>;
  /** POST /api/rooms {} (may 404 until deployed). */
  createRoom(): Promise<RoomInfo>;
}
