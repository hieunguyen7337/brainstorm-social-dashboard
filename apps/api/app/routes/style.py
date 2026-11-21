"""Learn the person's writing style from uploaded samples (docs/CONTRACT.md, "Writing style")."""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from app.auth import get_workspace
from app.db import get_db
from app.models import StyleLearnRequest, StyleLearnResult
from app.services import style

router = APIRouter()


@router.post("/api/workspace/style", response_model=StyleLearnResult)
def learn_style(
    body: StyleLearnRequest,
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
):
    """One batch of writing samples refines the stored style. 413/415/422 bad upload, 409 busy, 503 AI unavailable."""
    if not style.acquire(ws["id"]):
        raise HTTPException(status_code=409, detail=style.BUSY_DETAIL)
    try:
        return style.learn(conn, ws, body)
    except style.StyleUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    finally:
        style.release(ws["id"])


@router.delete("/api/workspace/style")
def forget_style(ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)) -> dict:
    style.forget(conn, ws["id"])
    return {"ok": True}
