"""Themes CRUD, AI generation and AI usage (U2, see docs/CONTRACT.md)."""

import logging
import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException

from app.auth import get_workspace
from app.db import get_db, new_id, now_iso
from app.models import AiUsage, GenerateRequest, GenerateResponse, Theme, ThemeCreate, ThemePatch
from app.platforms import require_all_live
from app.services import ai, classify

log = logging.getLogger("pulse")

router = APIRouter()

GENERATE_MIN_INTERVAL_S = 5.0
_last_generate: dict[str, float] = {}  # workspace_id -> monotonic time of the last accepted generate


def _theme(row: sqlite3.Row) -> Theme:
    return Theme(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        color=row["color"],
        active=bool(row["active"]),
        created_at=row["created_at"],
    )


def _owned_theme(conn: sqlite3.Connection, ws: sqlite3.Row, theme_id: str) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM themes WHERE id = ? AND workspace_id = ?", (theme_id, ws["id"])
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="theme not found")
    return row


def _accept_generate(workspace_id: str) -> None:
    now = time.monotonic()
    last = _last_generate.get(workspace_id)
    if last is not None and now - last < GENERATE_MIN_INTERVAL_S:
        raise HTTPException(status_code=429, detail="Too many generations: wait a few seconds and retry")
    _last_generate[workspace_id] = now


@router.get("/api/themes")
def list_themes(ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)) -> list[Theme]:
    rows = conn.execute(
        "SELECT * FROM themes WHERE workspace_id = ? ORDER BY created_at, id", (ws["id"],)
    ).fetchall()
    return [_theme(r) for r in rows]


@router.post("/api/themes")
def create_theme(
    body: ThemeCreate,
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
) -> Theme:
    theme_id = new_id("th")
    conn.execute(
        "INSERT INTO themes (id, workspace_id, name, description, color, active, created_at) "
        "VALUES (?, ?, ?, ?, ?, 1, ?)",
        (theme_id, ws["id"], body.name, body.description, body.color, now_iso()),
    )
    conn.commit()
    return _theme(_owned_theme(conn, ws, theme_id))


@router.patch("/api/themes/{theme_id}")
def patch_theme(
    theme_id: str,
    body: ThemePatch,
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
) -> Theme:
    _owned_theme(conn, ws, theme_id)
    changes = body.model_dump(exclude_none=True)  # keys are ThemePatch field names, never user input
    if "active" in changes:
        changes["active"] = int(changes["active"])
    if changes:
        assignments = ", ".join(f"{column} = ?" for column in changes)
        conn.execute(
            f"UPDATE themes SET {assignments} WHERE id = ? AND workspace_id = ?",
            (*changes.values(), theme_id, ws["id"]),
        )
        conn.commit()
    return _theme(_owned_theme(conn, ws, theme_id))


@router.delete("/api/themes/{theme_id}")
def delete_theme(
    theme_id: str,
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    _owned_theme(conn, ws, theme_id)
    conn.execute("DELETE FROM themes WHERE id = ? AND workspace_id = ?", (theme_id, ws["id"]))
    conn.commit()
    return {"ok": True}


@router.post("/api/generate")
def generate(
    body: GenerateRequest,
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
) -> GenerateResponse:
    require_all_live(body.platforms)
    _accept_generate(ws["id"])
    theme = _owned_theme(conn, ws, body.theme_id) if body.theme_id is not None else None
    trend = None
    if body.trend_id is not None:
        trend = conn.execute("SELECT * FROM trends WHERE id = ?", (body.trend_id,)).fetchone()
        if trend is None:
            raise HTTPException(status_code=404, detail="trend not found")

    batch_id = new_id("b")
    variants, ai_used = ai.generate_variants(
        conn, ws, platforms=body.platforms, theme=theme, trend=trend, brief=body.brief, tone=body.tone
    )
    posts = ai.save_variants(
        conn,
        ws,
        variants,
        batch_id=batch_id,
        theme_id=body.theme_id,
        trend_id=body.trend_id,
        source="ai",
        status="draft",
        scheduled_at=None,
    )
    if body.theme_id is None:
        # No theme was chosen: let the classifier file the drafts under the workspace's themes (it never raises).
        try:
            classify.classify_posts(conn, ws["id"], [p.id for p in posts])
        except Exception:
            log.warning("classifying generated drafts failed", exc_info=True)
    detail = f"{len(posts)} drafts ({'AI' if ai_used else 'template'})"
    conn.execute(
        "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts) "
        "VALUES (?, ?, NULL, 'generated', NULL, ?, 0, ?)",
        (new_id("e"), ws["id"], detail, now_iso()),
    )
    conn.commit()
    return GenerateResponse(batch_id=batch_id, ai_used=ai_used, posts=posts)


@router.get("/api/ai/usage")
def ai_usage(ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)) -> AiUsage:
    return ai.usage_status(conn, ws["id"])
