"""API schemas: the REST contract in code. Change only through the lead (docs/CONTRACT.md)."""

from typing import Literal

from pydantic import BaseModel, Field

Platform = Literal["linkedin", "instagram", "x", "tiktok", "reddit", "facebook"]
PostStatus = Literal["draft", "scheduled", "published", "failed"]
DataMode = Literal["sample", "real", "demo"]  # docs/REAL.md ("demo": the labelled synthetic workspace)


class WorkspaceCreate(BaseModel):
    brand_name: str | None = None  # default: a demo brand
    real: bool = False  # True: no seeded numbers, they come from the person's own accounts (docs/REAL.md)
    demo: bool = False  # True: a labelled demo workspace whose sign-ins and numbers are synthetic (docs/REAL.md)


class Workspace(BaseModel):
    id: str
    name: str
    brand_name: str
    brand_voice: str
    audience: str
    offer: str
    product_url: str
    created_at: str
    data_mode: DataMode = "sample"


class WorkspaceWithToken(Workspace):
    token: str


class WorkspacePatch(BaseModel):
    name: str | None = None
    brand_name: str | None = None
    brand_voice: str | None = None
    audience: str | None = None
    offer: str | None = None
    product_url: str | None = None


class Connection(BaseModel):
    platform: Platform
    handle: str
    status: Literal["connected", "disconnected"]
    mode: Literal["sandbox", "live"]
    followers: int
    connected_at: str


class ConnectionCreate(BaseModel):
    handle: str = Field(min_length=1, max_length=60)


class Post(BaseModel):
    id: str
    platform: Platform
    content: str
    hashtags: list[str]
    media_prompt: str
    theme_id: str | None
    trend_id: str | None
    batch_id: str | None
    link_code: str | None
    link_url: str | None  # absolute tracked link, PUBLIC_BASE_URL + /r/<code>
    status: PostStatus
    source: Literal["manual", "ai", "autopilot", "seed", "harvested"]
    metrics_source: Literal["sim", "real"] = "sim"
    harvested_at: str | None = None
    scheduled_at: str | None
    published_at: str | None
    views: int
    engagements: int
    clicks: int
    conversions: int
    created_at: str


class PostCreate(BaseModel):
    platform: Platform
    content: str = Field(min_length=1, max_length=5000)
    hashtags: list[str] = []
    media_prompt: str = ""
    theme_id: str | None = None
    trend_id: str | None = None
    status: Literal["draft", "scheduled"] = "draft"
    scheduled_at: str | None = None


class PostPatch(BaseModel):
    content: str | None = None
    hashtags: list[str] | None = None
    media_prompt: str | None = None
    status: Literal["draft", "scheduled"] | None = None
    scheduled_at: str | None = None


class PlatformStats(BaseModel):
    platform: Platform
    views: int
    engagements: int
    clicks: int
    conversions: int
    share: float  # share of total views, 0..1
    followers: int = 0  # the connection's follower count; 0 when the platform is not connected


class FunnelStage(BaseModel):
    stage: Literal["views", "engagements", "clicks", "conversions"]
    value: int
    rate: float  # conversion from the previous stage, 0..1 (1.0 for views)


class DayStats(BaseModel):
    day: str
    views: int
    engagements: int
    clicks: int
    conversions: int


class Totals(BaseModel):
    views: int
    engagements: int
    clicks: int
    conversions: int


class DashboardSummary(BaseModel):
    days: int
    totals: Totals
    change_pct: Totals  # % change vs the previous period of the same length (ints, may be negative)
    by_platform: list[PlatformStats]
    funnel: list[FunnelStage]
    timeseries: list[DayStats]
    top_posts: list[Post]
    real_clicks: int  # clicks by real people on tracked links in the period
    real_conversions: int
    data_mode: DataMode = "sample"  # the workspace's data_mode (docs/REAL.md)
    followers_total: int = 0  # followers across the connected platforms listed in by_platform


class ActivityItem(BaseModel):
    id: str
    type: str
    platform: Platform | None
    post_id: str | None
    detail: str
    real: bool
    ts: str


class Theme(BaseModel):
    id: str
    name: str
    description: str
    color: str
    active: bool
    created_at: str


class ThemeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = ""
    color: str = "#7c5cff"


class ThemePatch(BaseModel):
    name: str | None = None
    description: str | None = None
    color: str | None = None
    active: bool | None = None


class Trend(BaseModel):
    id: str
    source: Literal["hackernews", "reddit", "google"]
    title: str
    url: str
    score: float  # source popularity 0..1
    relevance: float  # match to this workspace's brand 0..1
    fetched_at: str


class GenerateRequest(BaseModel):
    platforms: list[Platform] = Field(min_length=1)
    theme_id: str | None = None
    trend_id: str | None = None
    brief: str = Field(default="", max_length=1000)
    tone: str = ""


class GenerateResponse(BaseModel):
    batch_id: str
    ai_used: bool
    posts: list[Post]  # one draft per requested platform, already saved


class AiUsage(BaseModel):
    workspace_used: int
    workspace_limit: int
    global_spent_usd: float
    global_cap_usd: float
    ai_available: bool


class AutopilotConfig(BaseModel):
    enabled: bool = False
    interval_min: int = Field(default=30, ge=1, le=1440)
    platforms: list[Platform] = []
    require_approval: bool = True
    last_run_at: str | None = None


class AutopilotRun(BaseModel):
    ran_at: str
    trend_id: str | None
    theme_id: str | None
    posts: list[Post]
