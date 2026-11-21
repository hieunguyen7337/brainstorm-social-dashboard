import sqlite3

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.auth import get_workspace
from app.db import get_db
from app.models import Trend
from app.services import trends as svc

router = APIRouter(prefix="/api", tags=["trends"])


class TrendOut(Trend):
    """`Trend` plus the explainable parts (added fields only, so older clients keep working).

    `relevance` is None when the workspace has no brand profile yet; `match_terms` are the headline's words
    that overlap that profile."""

    relevance: float | None = None
    match_terms: list[str] = Field(default_factory=list)


class TrendSourceStatus(BaseModel):
    source: str
    ok: bool | None  # result of the last fetch attempt in this server process; None = not attempted yet
    attempted_at: str | None
    fetched_at: str | None  # last time this source's rows were stored
    count: int
    error: str | None  # why the last attempt failed (only when ok is false)


class TrendsStatus(BaseModel):
    sources: list[TrendSourceStatus]
    newest_fetched_at: str | None
    oldest_fetched_at: str | None


@router.get("/trends", response_model=list[TrendOut])
async def list_trends(
    refresh: bool = False,
    limit: int = Query(20, ge=1, le=100),
    conn: sqlite3.Connection = Depends(get_db),
    ws: sqlite3.Row = Depends(get_workspace),
):
    await svc.ensure_fresh(conn, refresh)
    return svc.ranked(conn, ws, limit)


@router.get("/trends/status", response_model=TrendsStatus)
async def trends_status(
    conn: sqlite3.Connection = Depends(get_db),
    ws: sqlite3.Row = Depends(get_workspace),
):
    return svc.status(conn)
