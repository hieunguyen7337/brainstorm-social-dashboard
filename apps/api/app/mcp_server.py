"""MCP server (Streamable HTTP) mounted at /mcp. Each tool calls the REST API in-process."""

from __future__ import annotations

import json
from typing import Any

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
            "browse trends and themes, generate/create/publish posts and control autopilot."
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

    # Mount the SDK's route directly so the endpoint is exactly /mcp (no Mount redirect, no /mcp/mcp).
    sub = mcp.streamable_http_app()
    app.router.routes[0:0] = sub.routes
    app.state.mcp_lifespan = mcp.session_manager.run
