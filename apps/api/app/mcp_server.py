"""MCP server (Streamable HTTP) mounted at /mcp. Each tool calls the REST API in-process."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import FastAPI
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings

POST_FIELDS = (
    "id",
    "platform",
    "status",
    "content",
    "hashtags",
    "theme_id",
    "trend_id",
    "link_url",
    "views",
    "engagements",
    "clicks",
    "conversions",
    "published_at",
    "scheduled_at",
    "created_at",
)

MAX_INGEST_POSTS = 500

LINKEDIN_STEPS = """\
HARVEST YOUR REAL LINKEDIN NUMBERS INTO PULSE (steps for a Claude-in-Chrome agent)

If the harvest script (tools/harvest) already ran successfully for LinkedIn, you do not need to do this.

0) Rules. Read them first and keep to them the whole time.
   - Use only the user's OWN LinkedIn account, in the browser they are already logged in to.
   - Never ask for, read or type a password. If a login page shows, stop, ask the user to log in
     themselves, then carry on once they say they are done.
   - Work at a human pace: wait 1-2 seconds between pages.
   - Read at most 30 posts.
   - Never like, comment, follow, connect, post or message anyone. Read only.
1) Get the profile URL. Call the harvest_status tool and look at the linkedin entry's profile_url.
   If it is empty, ask the user for the link to their own LinkedIn page, then call
   set_profile_url(platform="linkedin", profile_url=...) once.
2) Read the posts. Open <profile_url>/recent-activity/all/ (for a company page open
   /company/<slug>/posts/?feedView=all). Scroll down gently. For each of the latest 30 posts at most,
   read:
   - the post id: the digits after urn:li:activity: in the post link (for example
     urn:li:activity:7123456789012345678 gives 7123456789012345678),
   - the post URL,
   - the first 200 characters or so of the text,
   - impressions (views), reactions, comments and reposts.
3) Read the analytics. Open https://www.linkedin.com/analytics/creator/content/ and read the totals
   (impressions, reactions, comments, reposts) for the period shown. Use the top posts' impressions
   to fill in any per-post impressions you could not see in step 2.
4) Read the follower count from the profile page.
5) Call record_metrics ONCE with every post, for example:
   record_metrics(platform="linkedin",
     account={"followers": 3140, "views": 18250, "engagements": 904},
     posts=[{"external_id": "7123456789012345678",
             "url": "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/",
             "content": "We just launched ...", "views": 4210, "engagements": 188}])
   Integers only. Expand abbreviations (1.2K is 1200, 3.4M is 3400000). views is impressions.
   engagements is reactions + comments + reposts. If you cannot read a number, leave it out
   instead of guessing. Never estimate.
   posted_at is optional: only add it as an ISO 8601 time such as 2026-11-18T09:30:00Z when you can see
   the exact date, otherwise leave it out.
6) Finish by calling harvest_status. Tell the user how many posts were matched and created (from the
   record_metrics reply) and which numbers you could not read.
"""

INSTAGRAM_STEPS = """\
HARVEST YOUR REAL INSTAGRAM NUMBERS INTO PULSE (steps for a Claude-in-Chrome agent)

If the harvest script (tools/harvest) already ran successfully for Instagram, you do not need to do this.

0) Rules. Read them first and keep to them the whole time.
   - Use only the user's OWN Instagram account, in the browser they are already logged in to.
   - Never ask for, read or type a password. If a login page shows, stop, ask the user to log in
     themselves, then carry on once they say they are done.
   - Work at a human pace: wait 1-2 seconds between pages.
   - Read at most 12 posts or reels.
   - Never like, comment, follow, post or message anyone. Read only.
1) Get the profile URL. Call the harvest_status tool and look at the instagram entry's profile_url.
   If it is empty, ask the user for the link to their own Instagram page, then call
   set_profile_url(platform="instagram", profile_url=...) once.
2) Open the profile, for example https://www.instagram.com/<user>/ and read the follower count.
3) Open the latest 12 posts or reels one at a time (wait 1-2 seconds between each). For each one read:
   - the shortcode: the code in /p/<code>/ or /reel/<code>/ in the address,
   - the URL,
   - the start of the caption (the first 200 characters or so),
   - the date,
   - likes and comments, and for a reel the plays/views.
4) If it is a professional account, open the professional dashboard (or Insights) and read, for the
   period shown: views, accounts reached, accounts engaged, profile visits and link taps. These go in the
   account block. Skip this step if the account is not professional.
5) Call record_metrics ONCE with every post, for example:
   record_metrics(platform="instagram",
     account={"followers": 5210, "views": 40100, "engagements": 2300, "profile_views": 610, "clicks": 45},
     posts=[{"external_id": "C9xYzAbCdEf", "url": "https://www.instagram.com/p/C9xYzAbCdEf/",
             "content": "New drop ...", "views": 3900, "engagements": 410}])
   Integers only. Expand abbreviations (1.2K is 1200, 3.4M is 3400000). views is plays, reach or
   impressions, whichever Instagram shows for that post. engagements is likes + comments. If you
   cannot read a number, leave it out instead of guessing. Never estimate.
   posted_at is optional: only add it as an ISO 8601 time such as 2026-11-18T09:30:00Z when you can see
   the exact date, otherwise leave it out.
6) Finish by calling harvest_status. Tell the user how many posts were matched and created (from the
   record_metrics reply) and which numbers you could not read.
"""

HARVEST_STEPS = {"linkedin": LINKEDIN_STEPS, "instagram": INSTAGRAM_STEPS}


class PulseToolError(Exception):
    """Raised to surface a readable error to the MCP client."""


def _token(ctx: Context) -> str:
    request = ctx.request_context.request
    token = ""
    if request is not None:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth.split(" ", 1)[1].strip()
        if not token:
            token = (request.query_params.get("token") or "").strip()
    if not token:
        raise PulseToolError(
            "Missing Pulse token: send 'Authorization: Bearer <token>' (or ?token=<token>). "
            "Copy the token from the app's Settings screen."
        )
    return token


def _platform_name(platform: str) -> str:
    name = (platform or "").strip().lower()
    if not name:
        raise PulseToolError("platform is empty: use one of linkedin, instagram, x, tiktok, reddit, facebook.")
    return name


def _trim_post(p: dict[str, Any]) -> dict[str, Any]:
    return {k: p[k] for k in POST_FIELDS if k in p}


def _compact(data: Any) -> str:
    return json.dumps(data, separators=(",", ":"), default=str)


def _summarise_dashboard(d: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in ("days", "totals", "change_pct", "funnel", "by_platform", "real_clicks", "real_conversions"):
        if key in d:
            out[key] = d[key]
    top = d.get("top_posts") or []
    out["top_posts"] = [_trim_post(p) for p in top[:3]]
    return out


def mount_mcp(app: FastAPI) -> None:
    mcp = FastMCP(
        "pulse",
        instructions=(
            "Pulse is an automated social media manager. Use these tools to read the dashboard, "
            "browse trends and themes, generate/create/publish posts and control autopilot. To bring in the "
            "user's real LinkedIn/Instagram numbers, call harvest_instructions, follow it in the user's own "
            "browser, then record_metrics."
        ),
        stateless_http=True,
        json_response=True,
        streamable_http_path="/mcp",
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    async def call(ctx: Context, method: str, path: str, *, params=None, body=None) -> Any:
        token = _token(ctx)
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://pulse") as client:
            r = await client.request(
                method, path, params=params, json=body, headers={"Authorization": f"Bearer {token}"}
            )
        if r.status_code >= 400:
            try:
                detail = (r.json() or {}).get("detail", r.text)
            except ValueError:
                detail = r.text
            if r.status_code == 401:
                raise PulseToolError(f"Unauthorized: {detail}. Check your Pulse token.")
            if r.status_code == 404:
                raise PulseToolError(f"Not found or not available: {detail}")
            raise PulseToolError(f"Pulse API error {r.status_code}: {detail}")
        return r.json()

    @mcp.tool()
    async def get_dashboard(ctx: Context, days: int = 30, platform: str | None = None) -> str:
        """Summarise the workspace dashboard: totals, sales funnel (views -> engagements -> clicks ->
        conversions), views share by platform and the top 3 posts. `days` is the window (default 30);
        `platform` optionally filters to one of linkedin, instagram, x, tiktok, reddit, facebook."""
        params: dict[str, Any] = {"days": days}
        if platform:
            params["platform"] = platform
        return _compact(_summarise_dashboard(await call(ctx, "GET", "/api/dashboard", params=params)))

    @mcp.tool()
    async def list_posts(
        ctx: Context, status: str | None = None, platform: str | None = None, limit: int = 20
    ) -> str:
        """List posts (newest first) with their key fields and metrics. Optional filters: `status`
        (draft, pending_approval, scheduled, published...) and `platform`. `limit` defaults to 20."""
        params: dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        if platform:
            params["platform"] = platform
        posts = await call(ctx, "GET", "/api/posts", params=params)
        return _compact([_trim_post(p) for p in posts])

    @mcp.tool()
    async def create_post(
        ctx: Context,
        platform: str,
        content: str,
        hashtags: list[str] | None = None,
        status: str = "draft",
    ) -> str:
        """Create a post on one platform (linkedin, instagram, x, tiktok, reddit, facebook) with the
        given text and hashtags. `status` is normally "draft"; use publish_post to publish it."""
        body = {"platform": platform, "content": content, "hashtags": hashtags or [], "status": status}
        return _compact(_trim_post(await call(ctx, "POST", "/api/posts", body=body)))

    @mcp.tool()
    async def publish_post(ctx: Context, post_id: str) -> str:
        """Publish an existing draft/pending post by id (sandbox mode: simulated audience then
        accrues views and engagement over time)."""
        return _compact(_trim_post(await call(ctx, "POST", f"/api/posts/{post_id}/publish")))

    @mcp.tool()
    async def generate_posts(
        ctx: Context,
        platforms: list[str],
        theme_id: str | None = None,
        trend_id: str | None = None,
        brief: str = "",
    ) -> str:
        """Have Claude write one post variant per platform, saved as draft posts. Steer it with a
        content theme (`theme_id`, see list_themes), a trend (`trend_id`, see list_trends) and/or a
        free-text `brief`. Returns the drafts."""
        body: dict[str, Any] = {"platforms": platforms, "brief": brief}
        if theme_id:
            body["theme_id"] = theme_id
        if trend_id:
            body["trend_id"] = trend_id
        res = await call(ctx, "POST", "/api/generate", body=body)
        if isinstance(res, dict):
            posts = res.get("posts") or res.get("variants") or []
            out = {k: v for k, v in res.items() if k not in ("posts", "variants")}
            out["posts"] = [_trim_post(p) for p in posts]
            return _compact(out)
        return _compact(res)

    @mcp.tool()
    async def list_trends(ctx: Context, limit: int = 10) -> str:
        """List current outside trends (Hacker News, Reddit, Google Trends AU) ranked for this
        workspace's brand. Use a trend's id with generate_posts."""
        return _compact(await call(ctx, "GET", "/api/trends", params={"limit": limit}))

    @mcp.tool()
    async def list_themes(ctx: Context) -> str:
        """List the workspace's content themes (pillars) that steer generation."""
        return _compact(await call(ctx, "GET", "/api/themes"))

    @mcp.tool()
    async def get_ai_usage(ctx: Context) -> str:
        """Show AI generation usage for this workspace against its limit."""
        return _compact(await call(ctx, "GET", "/api/ai/usage"))

    @mcp.tool()
    async def set_autopilot(
        ctx: Context,
        enabled: bool,
        interval_min: int = 30,
        platforms: list[str] | None = None,
        require_approval: bool = True,
    ) -> str:
        """Configure autopilot, which every `interval_min` minutes picks a trend and theme and drafts
        posts for `platforms`. With `require_approval` true they wait for approval; otherwise they
        are published automatically (sandbox)."""
        body = {
            "enabled": enabled,
            "interval_min": interval_min,
            "platforms": platforms or [],
            "require_approval": require_approval,
        }
        return _compact(await call(ctx, "PUT", "/api/autopilot", body=body))

    @mcp.tool()
    async def run_autopilot(ctx: Context) -> str:
        """Run one autopilot cycle right now and return what it drafted or published."""
        return _compact(await call(ctx, "POST", "/api/autopilot/run"))

    @mcp.tool()
    async def set_profile_url(ctx: Context, platform: str, profile_url: str) -> str:
        """Save the URL of the user's OWN LinkedIn or Instagram page (`platform` is "linkedin" or
        "instagram") so real stats can be harvested for it. Pulse only reads this page from the user's
        own logged-in browser; it never logs in for them."""
        name = _platform_name(platform)
        url = (profile_url or "").strip()
        if not url:
            raise PulseToolError("profile_url is empty: pass the link to the user's own profile page.")
        path = f"/api/connections/{quote(name, safe='')}/profile"
        return _compact(await call(ctx, "PUT", path, body={"profile_url": url}))

    @mcp.tool()
    async def record_metrics(
        ctx: Context,
        platform: str,
        posts: list[dict] | None = None,
        account: dict | None = None,
    ) -> str:
        """Record REAL numbers read from the user's OWN analytics pages (never estimated) for
        `platform`. Integers only: expand "1.2K" to 1200 and leave a number out if it cannot be read.
        `account` (optional) holds followers, views, engagements, clicks, profile_views. `posts` is a
        list (max 500) of {external_id, url, content, posted_at, views, engagements, clicks,
        conversions}. external_id should be the post's id from its URL: LinkedIn, the digits after
        `urn:li:activity:`; Instagram, the shortcode in /p/<code>/ or /reel/<code>/. views is
        impressions/plays/reach; engagements is reactions+comments+reposts (LinkedIn) or
        likes+comments (Instagram). Call it once with all posts. Returns matched/created/snapshots."""
        name = _platform_name(platform)
        post_list = list(posts or [])
        if len(post_list) > MAX_INGEST_POSTS:
            raise PulseToolError(
                f"Too many posts: {len(post_list)} sent, the limit is {MAX_INGEST_POSTS} per call. "
                "Send the most recent posts only."
            )
        body = {"platform": name, "source": "claude_chrome", "account": account or {}, "posts": post_list}
        return _compact(await call(ctx, "POST", "/api/metrics/ingest", body=body))

    @mcp.tool()
    async def harvest_status(ctx: Context) -> str:
        """Show, per platform, whether it is connected, its profile_url, when real numbers were last
        harvested (last_harvest_at, last_source), followers, and how many real posts and snapshots
        Pulse holds."""
        return _compact(await call(ctx, "GET", "/api/connections/harvest-status"))

    @mcp.tool()
    def harvest_instructions(platform: str) -> str:
        """Step-by-step instructions for a Claude-in-Chrome agent to read the user's real LinkedIn or
        Instagram numbers from their own logged-in browser and send them with record_metrics.
        `platform` is "linkedin" or "instagram". Needs no token."""
        key = (platform or "").strip().lower()
        if key not in HARVEST_STEPS:
            raise PulseToolError(
                f"Unsupported platform {platform!r}: harvest_instructions supports 'linkedin' and 'instagram'."
            )
        return HARVEST_STEPS[key]

    # Mount the SDK's route directly so the endpoint is exactly /mcp (no Mount redirect, no /mcp/mcp).
    sub = mcp.streamable_http_app()
    app.router.routes[0:0] = sub.routes
    app.state.mcp_lifespan = mcp.session_manager.run
