"""Dashboard summary and activity feed."""

import sqlite3
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import get_workspace
from app.db import PLATFORMS, get_db
from app.models import ActivityItem, DashboardSummary
from app.services import metrics
from app.services.posts import row_to_post

router = APIRouter()
KEYS = ("views", "engagements", "clicks", "conversions")


def _pct(cur: int, prev: int) -> int:
    return round((cur - prev) / prev * 100) if prev > 0 else 0


@router.get("/api/dashboard", response_model=DashboardSummary)
def dashboard(days: int = Query(30, ge=1, le=365), platform: str | None = None,
              ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)):
    if platform is not None and platform not in PLATFORMS:
        raise HTTPException(status_code=422, detail="unknown platform")
    metrics.tick(conn, ws["id"])
    today = metrics._now().date()
    start = today - timedelta(days=days - 1)
    prev_start = start - timedelta(days=days)
    plat_sql, plat_args = (" AND platform = ?", (platform,)) if platform else ("", ())

    daily = conn.execute(
        "SELECT platform, day, views, engagements, clicks, conversions FROM daily_metrics"
        f" WHERE workspace_id = ? AND day >= ? AND day <= ?{plat_sql}",
        (ws["id"], prev_start.isoformat(), today.isoformat(), *plat_args),
    ).fetchall()

    cur_tot = dict.fromkeys(KEYS, 0)
    prev_tot = dict.fromkeys(KEYS, 0)
    per_day: dict[str, dict] = {}
    per_plat: dict[str, dict] = {}
    for r in daily:
        if r["day"] >= start.isoformat():
            for k in KEYS:
                cur_tot[k] += r[k]
            d = per_day.setdefault(r["day"], dict.fromkeys(KEYS, 0))
            p = per_plat.setdefault(r["platform"], dict.fromkeys(KEYS, 0))
            for k in KEYS:
                d[k] += r[k]
                p[k] += r[k]
        else:
            for k in KEYS:
                prev_tot[k] += r[k]

    connected = [c["platform"] for c in conn.execute(
        "SELECT platform FROM connections WHERE workspace_id = ? AND status = 'connected'", (ws["id"],))]
    for p in connected:
        if platform is None or p == platform:
            per_plat.setdefault(p, dict.fromkeys(KEYS, 0))
    total_views = cur_tot["views"]
    by_platform = sorted(
        (
            {"platform": p, **v, "share": (v["views"] / total_views) if total_views else 0.0}
            for p, v in per_plat.items()
        ),
        key=lambda x: -x["views"],
    )

    stages = []
    prev_val = None
    for k in KEYS:
        v = cur_tot[k]
        rate = 1.0 if prev_val is None else (min(v / prev_val, 1.0) if prev_val else 0.0)
        stages.append({"stage": k, "value": v, "rate": round(rate, 4)})
        prev_val = v

    series = []
    for i in range(days):
        day = (start + timedelta(days=i)).isoformat()
        series.append({"day": day, **per_day.get(day, dict.fromkeys(KEYS, 0))})

    top = conn.execute(
        f"SELECT * FROM posts WHERE workspace_id = ? AND status = 'published'{plat_sql}"
        " ORDER BY views DESC, created_at DESC LIMIT 5",
        (ws["id"], *plat_args),
    ).fetchall()

    def real(kind: str) -> int:
        return conn.execute(
            f"SELECT COUNT(*) FROM events WHERE workspace_id = ? AND real = 1 AND type = ? AND ts >= ?{plat_sql}",
            (ws["id"], kind, start.isoformat(), *plat_args),
        ).fetchone()[0]

    return {
        "days": days,
        "totals": cur_tot,
        "change_pct": {k: _pct(cur_tot[k], prev_tot[k]) for k in KEYS},
        "by_platform": by_platform,
        "funnel": stages,
        "timeseries": series,
        "top_posts": [row_to_post(conn, r) for r in top],
        "real_clicks": real("click"),
        "real_conversions": real("conversion"),
    }


@router.get("/api/activity", response_model=list[ActivityItem])
def activity(limit: int = Query(30, ge=1, le=200), ws: sqlite3.Row = Depends(get_workspace),
             conn: sqlite3.Connection = Depends(get_db)):
    metrics.tick(conn, ws["id"])
    rows = conn.execute(
        "SELECT * FROM events WHERE workspace_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?",
        (ws["id"], limit),
    ).fetchall()
    return [
        ActivityItem(id=r["id"], type=r["type"], platform=r["platform"], post_id=r["post_id"],
                     detail=r["detail"], real=bool(r["real"]), ts=r["ts"])
        for r in rows
    ]
