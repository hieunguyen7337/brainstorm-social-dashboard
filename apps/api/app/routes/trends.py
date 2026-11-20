import sqlite3

from fastapi import APIRouter, Depends, Query

from app.auth import get_workspace
from app.db import get_db
from app.models import Trend
from app.services import trends as svc

router = APIRouter(prefix="/api", tags=["trends"])


@router.get("/trends", response_model=list[Trend])
async def list_trends(
    refresh: bool = False,
    limit: int = Query(20, ge=1, le=100),
    conn: sqlite3.Connection = Depends(get_db),
    ws: sqlite3.Row = Depends(get_workspace),
):
    await svc.ensure_fresh(conn, refresh)
    return svc.ranked(conn, ws, limit)
