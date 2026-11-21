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
WINDOWED = ("views", "engagements")  # what an account-level snapshot reports for a window (docs/REAL.md)


def _pct(cur: int, prev: int) -> int:
    return round((cur - prev) / prev * 100) if prev > 0 else 0


def _snapshot_history(conn: sqlite3.Connection, workspace_id: str, days: int,
                      platform: str | None) -> dict[tuple[str, str], list[tuple[int, int]]]:
    """The account-level numbers the person saved: {(platform, metric): [(value, period_days), ...]}, newest first.

    Only snapshots whose stated window fits inside the dashboard's (period_days <= days) are listed, and only for
    the metrics that were captured (a missing number is never read as 0).
    """
    sql = ("SELECT platform, views, engagements, period_days FROM metric_snapshots WHERE workspace_id = ?"
           " AND post_id IS NULL AND period_days IS NOT NULL AND period_days <= ?")
    args: list = [workspace_id, days]
    if platform:
        sql, args = sql + " AND platform = ?", [*args, platform]
    hist: dict[tuple[str, str], list[tuple[int, int]]] = {}
    for r in conn.execute(sql + " ORDER BY captured_at DESC, rowid DESC", args):
        for k in WINDOWED:
            if r[k] is not None:
                hist.setdefault((r["platform"], k), []).append((r[k], r["period_days"]))
    return hist


def _fold_snapshots(per_plat: dict[str, dict], cur_tot: dict[str, int],
                    hist: dict[tuple[str, str], list[tuple[int, int]]], connected: list[str]) -> None:
    """Per connected platform, views and engagements become the larger of the daily sum and the latest snapshot."""
    for p in connected:
        for k in WINDOWED:
            entries = hist.get((p, k))
            if entries and entries[0][0] > per_plat[p][k]:
                cur_tot[k] += entries[0][0] - per_plat[p][k]
                per_plat[p][k] = entries[0][0]


def _snapshot_change(hist: dict[tuple[str, str], list[tuple[int, int]]], connected: list[str]) -> dict[str, int]:
    """% change of the latest snapshot against the one before it that covers the same window, summed over the
    platforms that have two. Real history only: a platform with fewer than two comparable snapshots counts as 0."""
    out = {}
    for k in WINDOWED:
        cur = prev = 0
        for p in connected:
            entries = hist.get((p, k), [])
            if entries:
                value, period = entries[0]
                before = next((v for v, per in entries[1:] if per == period), None)
                if before is not None:
                    cur, prev = cur + value, prev + before
        out[k] = _pct(cur, prev)
    return out


NOT_READ = "Not read yet: open Connect to read"
NO_PHOTO_VIEWS = "Instagram does not share views for photo posts"
NO_LINK = "No tracked link yet: publish a post to count {}"


def _tiles(conn: sqlite3.Connection, workspace_id: str, days: int, platform: str | None, connected: list[str],
           totals: dict[str, int]) -> tuple[dict[str, int | None], dict[str, str]]:
    """A real workspace's tiles: totals[k] when metric k was ever read, else None and a short reason.

    Views/engagements need a snapshot of a connected platform in scope: a post snapshot at any time (an Instagram
    post's views of 0 do not count: Instagram gives none for photo posts), or an account snapshot whose window
    fits the dashboard's (the same rule as _snapshot_history: others never reach the totals, so they would show
    a false 0). Clicks/conversions need a published post with a tracked link in scope, or a real click/conversion
    event, at any time. A nonzero total is always read. Three aggregate queries.
    """
    plat_sql, plat_args = (" AND platform = ?", (platform,)) if platform else ("", ())
    fits = "post_id IS NULL AND period_days IS NOT NULL AND period_days <= ?"
    snaps = {r["platform"]: r for r in conn.execute(
        f"SELECT platform, MAX({fits} AND views IS NOT NULL) AS acc_views,"
        f" MAX({fits} AND engagements IS NOT NULL) AS acc_eng, MAX(post_id IS NOT NULL) AS posts,"
        " MAX(post_id IS NOT NULL AND views > 0) AS post_views"
        f" FROM metric_snapshots WHERE workspace_id = ?{plat_sql} GROUP BY platform",
        (days, days, workspace_id, *plat_args))}
    scoped = [snaps[p] for p in connected if p in snaps]
    links = conn.execute(
        "SELECT COUNT(*) FROM posts WHERE workspace_id = ? AND status = 'published' AND link_code IS NOT NULL"
        f"{plat_sql}", (workspace_id, *plat_args)).fetchone()[0]
    real_events = {r["type"]: r["n"] for r in conn.execute(
        "SELECT type, COUNT(*) AS n FROM events WHERE workspace_id = ? AND real = 1"
        f" AND type IN ('click', 'conversion'){plat_sql} GROUP BY type", (workspace_id, *plat_args))}

    read = {
        "views": any(r["acc_views"] or r["post_views"] or (r["posts"] and r["platform"] != "instagram")
                     for r in scoped),
        "engagements": any(r["acc_eng"] or r["posts"] for r in scoped),
        "clicks": links > 0 or real_events.get("click", 0) > 0,
        "conversions": links > 0 or real_events.get("conversion", 0) > 0,
    }
    tiles: dict[str, int | None] = {}
    not_read: dict[str, str] = {}
    for k in KEYS:
        if read[k] or totals[k] > 0:
            tiles[k] = totals[k]
            continue
        tiles[k] = None
        if k == "views" and snaps.get("instagram") and "instagram" in connected and snaps["instagram"]["posts"]:
            not_read[k] = NO_PHOTO_VIEWS
        elif k in ("clicks", "conversions") and connected:
            not_read[k] = NO_LINK.format(k)
        else:
            not_read[k] = NOT_READ
    return tiles, not_read


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

    followers = {c["platform"]: c["followers"] for c in conn.execute(
        "SELECT platform, followers FROM connections WHERE workspace_id = ? AND status = 'connected'", (ws["id"],))}
    connected = [p for p in followers if platform is None or p == platform]
    for p in connected:
        per_plat.setdefault(p, dict.fromkeys(KEYS, 0))
    change = None
    if ws["data_mode"] == "real":
        # Real workspace (docs/REAL.md): the account numbers the person saved are windowed totals with no daily
        # breakdown, so per connected platform views/engagements are the larger of the daily sum and the latest
        # snapshot that fits the window. The change is real history only: the last two comparable snapshots.
        hist = _snapshot_history(conn, ws["id"], days, platform)
        _fold_snapshots(per_plat, cur_tot, hist, connected)
        change = {**{k: _pct(cur_tot[k], prev_tot[k]) for k in KEYS}, **_snapshot_change(hist, connected)}
    total_views = cur_tot["views"]
    by_platform = sorted(
        (
            {"platform": p, **v, "share": (v["views"] / total_views) if total_views else 0.0,
             "followers": followers.get(p, 0)}  # connected platforms only
            for p, v in per_plat.items()
        ),
        key=lambda x: (-x["views"], PLATFORMS.index(x["platform"])),
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

    tiles, not_read = (_tiles(conn, ws["id"], days, platform, connected, cur_tot) if ws["data_mode"] == "real"
                       else (dict(cur_tot), {}))
    return {
        "days": days,
        "totals": cur_tot,
        "change_pct": change or {k: _pct(cur_tot[k], prev_tot[k]) for k in KEYS},
        "by_platform": by_platform,
        "funnel": stages,
        "timeseries": series,
        "top_posts": [row_to_post(conn, r) for r in top],
        "real_clicks": real("click"),
        "real_conversions": real("conversion"),
        "data_mode": ws["data_mode"],
        "followers_total": sum(x["followers"] for x in by_platform),
        "tiles": tiles,
        "not_read": not_read,
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
