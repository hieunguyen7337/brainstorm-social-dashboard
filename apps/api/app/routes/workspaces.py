"""Workspace and connection endpoints."""

import random
import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from app.auth import get_workspace
from app.config import settings
from app.db import PLATFORMS, get_db, new_id, now_iso
from app.models import (
    ConnectionCreate,
    Workspace,
    WorkspaceCreate,
    WorkspacePatch,
    WorkspaceWithToken,
)
from app.platforms import ConnectionOut, live_sql_list, platform_status, require_live
from app.services import harvest, style
from app.services.seed import DEMO, DEMO_BRAND, seed_real_workspace, seed_workspace

router = APIRouter()


def _ws(row: sqlite3.Row) -> dict:
    out = {k: row[k] for k in Workspace.model_fields if k != "writing_style"}
    out["writing_style"] = style.load(row)  # stored as JSON text; None until the person uploads writing
    return out


def _conn(row: sqlite3.Row) -> ConnectionOut:
    return ConnectionOut(
        platform=row["platform"], handle=row["handle"], status=row["status"], mode=row["mode"],
        followers=row["followers"], connected_at=row["connected_at"], availability=platform_status(row["platform"]),
    )


@router.post("/api/workspaces", response_model=WorkspaceWithToken)
def create_workspace(body: WorkspaceCreate | None = None, conn: sqlite3.Connection = Depends(get_db)):
    import secrets

    brand = (body.brand_name.strip() if body and body.brand_name else "") or DEMO_BRAND
    demo = brand == DEMO_BRAND
    real = bool(body and body.real)  # docs/REAL.md: no seeded numbers, they come from the person's accounts
    wid = new_id("w_")
    token = secrets.token_urlsafe(24)
    if demo:
        voice, audience, offer = DEMO["brand_voice"], DEMO["audience"], DEMO["offer"]
    else:
        voice = "Friendly, clear and helpful."
        audience = f"People who would love {brand}."
        offer = "10% off your first order"
    conn.execute(
        "INSERT INTO workspaces (id, token, name, brand_name, brand_voice, audience, offer, product_url,"
        " created_at, data_mode) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (wid, token, brand, brand, voice, audience, offer, settings.public_base_url, now_iso(),
         "real" if real else "sample"),
    )
    if real:
        seed_real_workspace(conn, wid)
    else:
        seed_workspace(conn, wid, brand, demo=demo)
    row = conn.execute("SELECT * FROM workspaces WHERE id = ?", (wid,)).fetchone()
    return {**_ws(row), "token": token}


@router.get("/api/workspace", response_model=Workspace)
def get_current_workspace(ws: sqlite3.Row = Depends(get_workspace)):
    return _ws(ws)


@router.patch("/api/workspace", response_model=Workspace)
def patch_workspace(body: WorkspacePatch, ws: sqlite3.Row = Depends(get_workspace),
                    conn: sqlite3.Connection = Depends(get_db)):
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if changes:
        cols = ", ".join(f"{k} = ?" for k in changes)
        conn.execute(f"UPDATE workspaces SET {cols} WHERE id = ?", (*changes.values(), ws["id"]))
        conn.commit()
    return _ws(conn.execute("SELECT * FROM workspaces WHERE id = ?", (ws["id"],)).fetchone())


@router.get("/api/connections", response_model=list[ConnectionOut])
def list_connections(ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)):
    rows = conn.execute(
        f"SELECT * FROM connections WHERE workspace_id = ? AND platform IN ({live_sql_list()})", (ws["id"],)
    ).fetchall()
    rows.sort(key=lambda r: PLATFORMS.index(r["platform"]))
    return [_conn(r) for r in rows]


def _check_platform(platform: str) -> None:
    if platform not in PLATFORMS:
        raise HTTPException(status_code=404, detail=f"unknown platform '{platform}'")
    require_live(platform)


@router.post("/api/connections/{platform}", response_model=ConnectionOut)
def connect_platform(platform: str, body: ConnectionCreate, ws: sqlite3.Row = Depends(get_workspace),
                     conn: sqlite3.Connection = Depends(get_db)):
    _check_platform(platform)
    now = now_iso()
    if ws["data_mode"] == "real":
        # A real workspace never gets an invented follower count or a simulated audience (docs/REAL.md): connect
        # it live and leave the numbers to what the person saves with POST /api/metrics/ingest.
        harvest.connect_live(conn, ws["id"], platform, handle=harvest.clean_handle(body.handle), now=now)
        conn.commit()
        return _conn(conn.execute(
            "SELECT * FROM connections WHERE workspace_id = ? AND platform = ?", (ws["id"], platform)).fetchone())
    existing = conn.execute(
        "SELECT * FROM connections WHERE workspace_id = ? AND platform = ?", (ws["id"], platform)
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE connections SET handle=?, status='connected', mode='sandbox', connected_at=? WHERE id=?",
            (body.handle, now, existing["id"]),
        )
    else:
        conn.execute(
            "INSERT INTO connections (id, workspace_id, platform, handle, status, mode, followers, connected_at)"
            " VALUES (?,?,?,?,'connected','sandbox',?,?)",
            (new_id("c_"), ws["id"], platform, body.handle, random.Random(body.handle).randint(800, 6000), now),
        )
    conn.execute(
        "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts)"
        " VALUES (?,?,NULL,'connected',?,?,0,?)",
        (new_id("e_"), ws["id"], platform, f"Connected {platform.capitalize()} (sandbox)", now),
    )
    conn.commit()
    return _conn(conn.execute(
        "SELECT * FROM connections WHERE workspace_id = ? AND platform = ?", (ws["id"], platform)).fetchone())


@router.delete("/api/connections/{platform}", response_model=ConnectionOut)
def disconnect_platform(platform: str, ws: sqlite3.Row = Depends(get_workspace),
                        conn: sqlite3.Connection = Depends(get_db)):
    _check_platform(platform)
    row = conn.execute(
        "SELECT * FROM connections WHERE workspace_id = ? AND platform = ?", (ws["id"], platform)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="connection not found")
    conn.execute("UPDATE connections SET status='disconnected' WHERE id = ?", (row["id"],))
    conn.commit()
    return _conn(conn.execute("SELECT * FROM connections WHERE id = ?", (row["id"],)).fetchone())
