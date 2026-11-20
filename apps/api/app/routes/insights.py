"""Learning-loop endpoints: performance insights, summary refresh and theme classification (W1)."""

import sqlite3

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.auth import get_workspace
from app.db import get_db
from app.services import classify, insights, metrics

router = APIRouter()

CLASSIFY_LIMIT = 60  # posts handled per /api/themes/classify call (backfill + classifier together)


class ThemeAssignment(BaseModel):
    post_id: str
    theme_id: str
    confidence: float
    classifier: str


class ClassifyResponse(BaseModel):
    backfilled: int
    classified: int
    remaining: int
    assignments: list[ThemeAssignment]
    classifiers: dict[str, int]


@router.get("/api/insights", response_model=insights.InsightsResponse)
def get_insights(
    days: int = Query(30, ge=1, le=365),
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
):
    metrics.tick(conn, ws["id"])
    return insights.compute_insights(conn, ws["id"], days)


@router.post("/api/insights/refresh", response_model=insights.RefreshResponse)
def refresh_insights(
    days: int = Query(30, ge=1, le=365),
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
):
    metrics.tick(conn, ws["id"])
    return insights.refresh_summary(conn, ws["id"], days)


def _remaining(conn: sqlite3.Connection, workspace_id: str) -> int:
    """Posts with no post_themes row and no usable posts.theme_id (one of this workspace's themes)."""
    return conn.execute(
        "SELECT COUNT(*) FROM posts p WHERE p.workspace_id = ? "
        "AND NOT EXISTS (SELECT 1 FROM post_themes pt WHERE pt.post_id = p.id) "
        "AND NOT EXISTS (SELECT 1 FROM themes t WHERE t.id = p.theme_id AND t.workspace_id = p.workspace_id)",
        (workspace_id,),
    ).fetchone()[0]


@router.post("/api/themes/classify", response_model=ClassifyResponse)
def classify_themes(ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)):
    """Classifies unclassified posts into themes, at most CLASSIFY_LIMIT per call (call again for the rest)."""
    ws_id = ws["id"]
    backfilled = int(classify.backfill_manual(conn, ws_id, limit=CLASSIFY_LIMIT) or 0)
    room = CLASSIFY_LIMIT - backfilled
    ids = classify.unclassified_post_ids(conn, ws_id, limit=room) if room > 0 else []
    results = classify.classify_posts(conn, ws_id, ids) if ids else []
    assignments = [
        ThemeAssignment(post_id=post_id, theme_id=theme_id, confidence=confidence, classifier=classifier)
        for post_id, theme_id, confidence, classifier in results
    ]
    classifiers = {"jev": 0, "claude": 0, "keyword": 0}
    for a in assignments:
        classifiers[a.classifier] = classifiers.get(a.classifier, 0) + 1
    return ClassifyResponse(
        backfilled=backfilled,
        classified=len(assignments),
        remaining=_remaining(conn, ws_id),
        assignments=assignments,
        classifiers=classifiers,
    )
