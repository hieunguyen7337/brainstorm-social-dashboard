"""Theme classifier: Jev decision model, then Claude, then an offline keyword fallback (W1).

STUB with the agreed interface; unit (a) replaces everything except the signatures.
"""

import sqlite3

from app.db import now_iso


def assign_theme(
    conn: sqlite3.Connection,
    post_id: str,
    theme_id: str,
    *,
    confidence: float = 1.0,
    classifier: str = "manual",
    commit: bool = True,
) -> None:
    """Upsert one post_themes row (post_id, theme_id)."""
    conn.execute(
        "INSERT INTO post_themes (post_id, theme_id, confidence, classifier, created_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(post_id, theme_id) DO UPDATE SET confidence = excluded.confidence, "
        "classifier = excluded.classifier, created_at = excluded.created_at",
        (post_id, theme_id, confidence, classifier, now_iso()),
    )
    if commit:
        conn.commit()


def unclassified_post_ids(conn: sqlite3.Connection, workspace_id: str, limit: int = 60) -> list[str]:
    """Posts of the workspace with no post_themes row, oldest first."""
    rows = conn.execute(
        "SELECT p.id FROM posts p WHERE p.workspace_id = ? "
        "AND NOT EXISTS (SELECT 1 FROM post_themes t WHERE t.post_id = p.id) "
        "ORDER BY p.created_at, p.id LIMIT ?",
        (workspace_id, limit),
    ).fetchall()
    return [r["id"] for r in rows]


def classify_posts(
    conn: sqlite3.Connection, workspace_id: str, post_ids: list[str]
) -> list[tuple[str, str, float, str]]:
    """Returns [(post_id, theme_id, confidence, classifier)] and upserts post_themes. Never raises."""
    return []
