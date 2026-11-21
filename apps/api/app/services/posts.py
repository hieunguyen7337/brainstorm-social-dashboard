"""Post helpers shared with other units: row -> Post conversion, creation, publishing."""

import json
import secrets
import sqlite3
import zlib

from app.config import settings
from app.db import new_id, now_iso
from app.models import Post
from app.platforms import require_live

_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def link_url_for(code: str | None) -> str | None:
    if not code:
        return None
    return f"{settings.public_base_url.rstrip('/')}/r/{code}"


def new_link_code(conn: sqlite3.Connection) -> str:
    """A unique 6-char tracked-link code."""
    while True:
        code = "".join(secrets.choice(_ALPHABET) for _ in range(6))
        if conn.execute("SELECT 1 FROM posts WHERE link_code = ?", (code,)).fetchone() is None:
            return code


def row_to_post(conn: sqlite3.Connection, row: sqlite3.Row) -> Post:
    try:
        hashtags = json.loads(row["hashtags"] or "[]")
    except ValueError:
        hashtags = []
    return Post(
        id=row["id"],
        platform=row["platform"],
        content=row["content"],
        hashtags=hashtags,
        media_prompt=row["media_prompt"],
        theme_id=row["theme_id"],
        trend_id=row["trend_id"],
        batch_id=row["batch_id"],
        link_code=row["link_code"],
        link_url=link_url_for(row["link_code"]),
        status=row["status"],
        source=row["source"],
        scheduled_at=row["scheduled_at"],
        published_at=row["published_at"],
        views=row["views"],
        engagements=row["engagements"],
        clicks=row["clicks"],
        conversions=row["conversions"],
        created_at=row["created_at"],
        metrics_source=row["metrics_source"] if "metrics_source" in row.keys() else "sim",  # noqa: SIM118 (sqlite3.Row "in" checks values)
        harvested_at=row["harvested_at"] if "harvested_at" in row.keys() else None,  # noqa: SIM118
    )


def get_post_row(conn: sqlite3.Connection, workspace_id: str, post_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM posts WHERE id = ? AND workspace_id = ?", (post_id, workspace_id)
    ).fetchone()


def default_quality(content: str) -> float:
    """Deterministic 0.35..0.85 quality from the content (drives the simulated audience)."""
    return 0.35 + (zlib.crc32(content.encode()) % 51) / 100


def create_post(
    conn: sqlite3.Connection,
    workspace_id: str,
    *,
    platform: str,
    content: str,
    hashtags: list[str] | tuple[str, ...] = (),
    media_prompt: str = "",
    theme_id: str | None = None,
    trend_id: str | None = None,
    batch_id: str | None = None,
    status: str = "draft",
    source: str = "manual",
    scheduled_at: str | None = None,
    quality: float | None = None,
    commit: bool = True,
) -> Post:
    """Insert a post with a fresh unique link code and return it."""
    pid = new_id("p_")
    now = now_iso()
    conn.execute(
        """INSERT INTO posts (id, workspace_id, platform, content, hashtags, media_prompt, theme_id,
           trend_id, batch_id, link_code, status, source, quality, scheduled_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            pid, workspace_id, platform, content, json.dumps(list(hashtags)), media_prompt, theme_id,
            trend_id, batch_id, new_link_code(conn), status, source,
            default_quality(content) if quality is None else quality, scheduled_at, now,
        ),
    )
    if commit:
        conn.commit()
    return row_to_post(conn, get_post_row(conn, workspace_id, pid))


def publish_post(conn: sqlite3.Connection, workspace_id: str, post_id: str) -> Post | None:
    """Mark a post published (sandbox) and start its simulated audience. None if not found."""
    row = get_post_row(conn, workspace_id, post_id)
    if row is None:
        return None
    if row["status"] != "published":
        require_live(row["platform"])
        now = now_iso()
        conn.execute(
            "UPDATE posts SET status='published', published_at=?, last_tick_at=?, scheduled_at=NULL WHERE id=?",
            (now, now, post_id),
        )
        conn.execute(
            "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts)"
            " VALUES (?,?,?,?,?,?,0,?)",
            (new_id("e_"), workspace_id, post_id, "published", row["platform"],
             f"Published to {row['platform'].capitalize()}: {row['content'][:60]}", now),
        )
        conn.commit()
        row = get_post_row(conn, workspace_id, post_id)
    return row_to_post(conn, row)
