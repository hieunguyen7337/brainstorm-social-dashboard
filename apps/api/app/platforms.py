"""Which platforms are live in Pulse and which are "coming soon". The API's single source of truth.

To flip a platform live, move its name from UPCOMING_PLATFORMS to LIVE_PLATFORMS here (one line), and do the same
in `apps/mobile/src/platforms.ts`. Everything else (generate, autopilot, posts, publish, connections, dashboard,
seed, MCP tools) follows. Stored rows for upcoming platforms stay in the database and are simply ignored.
"""

from typing import Literal

from fastapi import HTTPException

from app.models import Connection

LIVE_PLATFORMS: tuple[str, ...] = ("linkedin", "instagram")
UPCOMING_PLATFORMS: tuple[str, ...] = ("x", "tiktok", "facebook", "reddit")

_NAMES = {"x": "X", "tiktok": "TikTok", "facebook": "Facebook", "reddit": "Reddit",
          "linkedin": "LinkedIn", "instagram": "Instagram"}

PlatformStatus = Literal["live", "upcoming"]


def is_live(platform: str) -> bool:
    return platform in live_platforms()


def platform_status(platform: str) -> PlatformStatus:
    return "live" if is_live(platform) else "upcoming"


def display_name(platform: str) -> str:
    return _NAMES.get(platform, platform.capitalize())


def coming_soon_reason(platform: str) -> str:
    return f"{display_name(platform)} is coming soon to Pulse"


def require_live(platform: str) -> None:
    """Raises 422 with a clear reason when `platform` is not live yet."""
    if not is_live(platform):
        raise HTTPException(status_code=422, detail=coming_soon_reason(platform))


def require_all_live(platforms: list[str]) -> None:
    for p in platforms:
        require_live(p)


def live_platforms() -> tuple[str, ...]:
    """Read at call time (not import time) so tests can flip platforms."""
    return LIVE_PLATFORMS


def live_sql_list() -> str:
    """`'linkedin','instagram'` for an SQL `IN (...)` clause (constants only, never user input)."""
    return ",".join(f"'{p}'" for p in live_platforms())


class ConnectionOut(Connection):
    """Connection plus `availability`: old clients ignore the extra field."""

    availability: PlatformStatus = "live"
