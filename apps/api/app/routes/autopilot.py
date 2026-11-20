"""Autopilot REST routes: read/update the workspace's autopilot config and run one cycle now."""

import sqlite3

from fastapi import APIRouter, Depends

from app.auth import get_workspace
from app.db import get_db
from app.models import AutopilotConfig, AutopilotRun
from app.services import autopilot

router = APIRouter()


@router.get("/api/autopilot", response_model=AutopilotConfig)
def get_autopilot(
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
) -> AutopilotConfig:
    return autopilot.load_config(conn, ws["id"])


@router.put("/api/autopilot", response_model=AutopilotConfig)
def put_autopilot(
    body: AutopilotConfig,
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
) -> AutopilotConfig:
    # last_run_at is owned by the runner; a client may not move the schedule.
    return autopilot.save_config(conn, ws["id"], body.model_copy(update={"last_run_at": None}))


@router.post("/api/autopilot/run", response_model=AutopilotRun)
def run_autopilot(
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
) -> AutopilotRun:
    return autopilot.run_once(conn, ws)
