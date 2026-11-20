"""Simulated audience (tick) and shared metric helpers."""

import math
import random
import sqlite3
from datetime import UTC, datetime

from app.db import new_id

# Per-platform audience behaviour: reach factor, engagement rate (of views), click rate (of
# engagements), conversion rate (of clicks). All inside the sane funnel bands.
PROFILE = {
    "linkedin": {"reach": 0.8, "eng": 0.055, "click": 0.22, "conv": 0.08},
    "instagram": {"reach": 1.3, "eng": 0.07, "click": 0.12, "conv": 0.05},
    "x": {"reach": 0.7, "eng": 0.035, "click": 0.14, "conv": 0.04},
    "tiktok": {"reach": 1.5, "eng": 0.065, "click": 0.12, "conv": 0.05},
    "reddit": {"reach": 1.0, "eng": 0.045, "click": 0.17, "conv": 0.05},
    "facebook": {"reach": 0.9, "eng": 0.04, "click": 0.15, "conv": 0.06},
}
TAU = 1200.0  # seconds: decay constant of a post's reach curve
_rng = random.Random()


def _now() -> datetime:
    return datetime.now(UTC)


def today() -> str:
    return _now().date().isoformat()


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    dt = datetime.fromisoformat(ts)
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _stoch(x: float) -> int:
    """Stochastic rounding so small expectations still grow over many ticks."""
    base = math.floor(x)
    return base + (1 if _rng.random() < x - base else 0)


def bump_daily(conn: sqlite3.Connection, workspace_id: str, platform: str, day: str,
               views: int = 0, engagements: int = 0, clicks: int = 0, conversions: int = 0) -> None:
    conn.execute(
        """INSERT INTO daily_metrics (workspace_id, platform, day, views, engagements, clicks, conversions)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT (workspace_id, platform, day) DO UPDATE SET
             views = views + excluded.views, engagements = engagements + excluded.engagements,
             clicks = clicks + excluded.clicks, conversions = conversions + excluded.conversions""",
        (workspace_id, platform, day, views, engagements, clicks, conversions),
    )


def tick(conn: sqlite3.Connection, workspace_id: str) -> None:
    """Advance every simulated published post by the time since its last tick. O(posts)."""
    now = _now()
    rows = conn.execute(
        """SELECT p.id, p.platform, p.quality, p.published_at, p.last_tick_at, c.followers, c.status, c.mode
           FROM posts p LEFT JOIN connections c ON c.workspace_id = p.workspace_id AND c.platform = p.platform
           WHERE p.workspace_id = ? AND p.status = 'published' AND p.published_at IS NOT NULL AND p.metrics_source = 'sim'""",
        (workspace_id,),
    ).fetchall()
    day = now.date().isoformat()
    changed = False
    for r in rows:
        if r["status"] == "disconnected" or r["mode"] == "live":
            continue
        published = _parse(r["published_at"])
        last = _parse(r["last_tick_at"]) or published
        a0 = max((last - published).total_seconds(), 0.0)
        a1 = (now - published).total_seconds()
        if a1 - a0 < 1:
            continue
        prof = PROFILE[r["platform"]]
        followers = r["followers"] if r["followers"] is not None else 1000
        per_min = min(300.0, (40 + followers * 0.02) * (0.5 + r["quality"]) * prof["reach"])
        expected = per_min / 60.0 * TAU * (math.exp(-a0 / TAU) - math.exp(-a1 / TAU))
        dv = _stoch(expected * _rng.uniform(0.8, 1.2))
        de = min(dv, _stoch(dv * prof["eng"] * _rng.uniform(0.85, 1.15)))
        dk = min(de, _stoch(dv * prof["eng"] * prof["click"]))
        dc = min(dk, _stoch(dv * prof["eng"] * prof["click"] * prof["conv"]))
        conn.execute(
            "UPDATE posts SET views = views + ?, engagements = engagements + ?, clicks = clicks + ?,"
            " conversions = conversions + ?, last_tick_at = ? WHERE id = ?",
            (dv, de, dk, dc, now.isoformat(timespec="seconds"), r["id"]),
        )
        changed = True
        if dv or de or dk or dc:
            bump_daily(conn, workspace_id, r["platform"], day, dv, de, dk, dc)
        if de >= 3 and _rng.random() < 0.35:
            name = r["platform"].capitalize() if r["platform"] != "x" else "X"
            conn.execute(
                "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts)"
                " VALUES (?,?,?,?,?,?,0,?)",
                (new_id("e_"), workspace_id, r["id"], "engagement", r["platform"],
                 f"{de} new likes on {name}", now.isoformat(timespec="seconds")),
            )
    if changed:
        conn.commit()
