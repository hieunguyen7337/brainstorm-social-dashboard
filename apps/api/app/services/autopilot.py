"""Autopilot: every N minutes pick a trend and a theme, draft posts, then queue them or publish them (sandbox).

`run_once` does one cycle for one workspace. `run_due` runs the due workspaces (called from the background loop
in a worker thread) and `autopilot_loop` is that loop.
"""

import asyncio
import json
import logging
import sqlite3
from datetime import UTC, datetime, timedelta

from app import db
from app.config import settings
from app.db import PLATFORMS, new_id, now_iso
from app.models import AutopilotConfig, AutopilotRun
from app.services import ai

log = logging.getLogger("pulse")


def load_config(conn: sqlite3.Connection, workspace_id: str) -> AutopilotConfig:
    row = conn.execute("SELECT * FROM autopilot WHERE workspace_id = ?", (workspace_id,)).fetchone()
    if row is None:
        return AutopilotConfig()
    return AutopilotConfig(
        enabled=bool(row["enabled"]),
        interval_min=row["interval_min"],
        platforms=json.loads(row["platforms"] or "[]"),
        require_approval=bool(row["require_approval"]),
        last_run_at=row["last_run_at"],
    )


def save_config(conn: sqlite3.Connection, workspace_id: str, cfg: AutopilotConfig) -> AutopilotConfig:
    conn.execute(
        """
        INSERT INTO autopilot (workspace_id, enabled, interval_min, platforms, require_approval, last_run_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
            enabled = excluded.enabled,
            interval_min = excluded.interval_min,
            platforms = excluded.platforms,
            require_approval = excluded.require_approval,
            last_run_at = COALESCE(excluded.last_run_at, autopilot.last_run_at)
        """,
        (
            workspace_id,
            int(cfg.enabled),
            cfg.interval_min,
            json.dumps(cfg.platforms),
            int(cfg.require_approval),
            cfg.last_run_at,
        ),
    )
    conn.commit()
    return load_config(conn, workspace_id)


def _connected_platforms(conn: sqlite3.Connection, workspace_id: str) -> set[str]:
    rows = conn.execute(
        "SELECT platform FROM connections WHERE workspace_id = ? AND status = 'connected'", (workspace_id,)
    ).fetchall()
    return {r["platform"] for r in rows}


def run_once(conn: sqlite3.Connection, ws: sqlite3.Row, *, now: str | None = None) -> AutopilotRun:
    now = now or now_iso()
    workspace_id = ws["id"]
    cfg = load_config(conn, workspace_id)

    # Theme: next active theme, round-robin over the workspace's autopilot runs so far.
    themes = conn.execute(
        "SELECT * FROM themes WHERE workspace_id = ? AND active = 1 ORDER BY created_at, id", (workspace_id,)
    ).fetchall()
    runs_so_far = conn.execute(
        "SELECT COUNT(*) FROM events WHERE workspace_id = ? AND type = 'autopilot'", (workspace_id,)
    ).fetchone()[0]
    theme = themes[runs_so_far % len(themes)] if themes else None

    trend = conn.execute("SELECT * FROM trends ORDER BY score DESC, fetched_at DESC LIMIT 1").fetchone()

    connected = _connected_platforms(conn, workspace_id)
    wanted = set(cfg.platforms) if cfg.platforms else connected
    platforms = [p for p in PLATFORMS if p in wanted and p in connected]

    # Make sure the config row exists, so last_run_at can be stored even for a workspace never configured.
    conn.execute("INSERT OR IGNORE INTO autopilot (workspace_id) VALUES (?)", (workspace_id,))

    if not platforms:
        conn.execute("UPDATE autopilot SET last_run_at = ? WHERE workspace_id = ?", (now, workspace_id))
        conn.commit()
        return AutopilotRun(
            ran_at=now,
            trend_id=trend["id"] if trend else None,
            theme_id=theme["id"] if theme else None,
            posts=[],
        )

    variants, ai_used = ai.generate_variants(
        conn, ws, platforms=platforms, theme=theme, trend=trend, brief="", tone=""
    )
    status = "scheduled" if cfg.require_approval else "published"
    scheduled_at = now if status == "scheduled" else None
    posts = ai.save_variants(
        conn,
        ws,
        variants,
        batch_id=new_id("b"),
        theme_id=theme["id"] if theme else None,
        trend_id=trend["id"] if trend else None,
        source="autopilot",
        status=status,
        scheduled_at=scheduled_at,
    )

    detail = f"{len(posts)} posts {status} ({'AI' if ai_used else 'template'})"
    conn.execute(
        "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts) "
        "VALUES (?, ?, NULL, 'autopilot', NULL, ?, 0, ?)",
        (new_id("e"), workspace_id, detail, now),
    )
    conn.execute("UPDATE autopilot SET last_run_at = ? WHERE workspace_id = ?", (now, workspace_id))
    conn.commit()
    return AutopilotRun(
        ran_at=now,
        trend_id=trend["id"] if trend else None,
        theme_id=theme["id"] if theme else None,
        posts=posts,
    )


def _as_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def _is_due(interval_min: int, last_run_at: str | None, current: datetime) -> bool:
    if last_run_at is None:
        return True
    return current - _as_utc(last_run_at) >= timedelta(minutes=interval_min)


def run_due(now: datetime | None = None) -> list[str]:
    """Run one cycle for every enabled workspace that is due. Returns the workspace ids that ran successfully."""
    current = datetime.now(UTC) if now is None else _as_utc(now.isoformat())
    current_iso = current.isoformat(timespec="seconds")

    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT a.workspace_id, a.interval_min, a.last_run_at FROM autopilot a "
            "JOIN workspaces w ON w.id = a.workspace_id WHERE a.enabled = 1"
        ).fetchall()
    finally:
        conn.close()
    due = [r["workspace_id"] for r in rows if _is_due(r["interval_min"], r["last_run_at"], current)]

    ran: list[str] = []
    for workspace_id in due:
        conn = db.connect()
        try:
            ws = conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
            if ws is None:
                continue
            run_once(conn, ws, now=current_iso)
            ran.append(workspace_id)
        except Exception:
            log.exception("autopilot run failed for workspace %s", workspace_id)
        finally:
            conn.close()
    return ran


async def autopilot_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(run_due)
        except Exception:
            log.exception("autopilot loop iteration failed")
        await asyncio.sleep(settings.autopilot_loop_seconds)
