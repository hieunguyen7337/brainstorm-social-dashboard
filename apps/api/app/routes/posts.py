"""Post CRUD and publish."""

import json
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import get_workspace
from app.db import get_db
from app.models import Platform, Post, PostCreate, PostPatch, PostStatus
from app.platforms import live_sql_list, require_live
from app.services import demo, metrics
from app.services.posts import create_post, get_post_row, publish_post, row_to_post

router = APIRouter()


def _owned(conn: sqlite3.Connection, ws: sqlite3.Row, post_id: str) -> sqlite3.Row:
    row = get_post_row(conn, ws["id"], post_id)
    if row is None:
        raise HTTPException(status_code=404, detail="post not found")
    return row


@router.get("/api/posts", response_model=list[Post])
def list_posts(status: PostStatus | None = None, platform: Platform | None = None,
               limit: int = Query(50, ge=1, le=200), ws: sqlite3.Row = Depends(get_workspace),
               conn: sqlite3.Connection = Depends(get_db)):
    metrics.tick(conn, ws["id"])
    sql, args = "SELECT * FROM posts WHERE workspace_id = ?", [ws["id"]]
    if status:
        sql += " AND status = ?"
        args.append(status)
    if platform:
        sql += " AND platform = ?"
        args.append(platform)
    else:
        sql += f" AND platform IN ({live_sql_list()})"  # upcoming platforms: ask for one explicitly
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
    args.append(limit)
    return [row_to_post(conn, r) for r in conn.execute(sql, args).fetchall()]


@router.post("/api/posts", response_model=Post)
def add_post(body: PostCreate, ws: sqlite3.Row = Depends(get_workspace),
             conn: sqlite3.Connection = Depends(get_db)):
    require_live(body.platform)
    return create_post(
        conn, ws["id"], platform=body.platform, content=body.content, hashtags=body.hashtags,
        media_prompt=body.media_prompt, theme_id=body.theme_id, trend_id=body.trend_id,
        status=body.status, source="manual", scheduled_at=body.scheduled_at,
    )


@router.patch("/api/posts/{post_id}", response_model=Post)
def patch_post(post_id: str, body: PostPatch, ws: sqlite3.Row = Depends(get_workspace),
               conn: sqlite3.Connection = Depends(get_db)):
    row = _owned(conn, ws, post_id)
    changes = body.model_dump(exclude_unset=True)
    if changes.get("status") == "scheduled":
        require_live(row["platform"])
    if changes.get("status") and row["status"] == "published":
        raise HTTPException(status_code=409, detail="published posts cannot go back to draft")
    if "hashtags" in changes:
        if changes["hashtags"] is None:
            del changes["hashtags"]
        else:
            changes["hashtags"] = json.dumps(changes["hashtags"])
    for k in ("content", "media_prompt", "status"):
        if k in changes and changes[k] is None:
            del changes[k]
    if changes:
        cols = ", ".join(f"{k} = ?" for k in changes)
        conn.execute(f"UPDATE posts SET {cols} WHERE id = ?", (*changes.values(), post_id))
        conn.commit()
    return row_to_post(conn, get_post_row(conn, ws["id"], post_id))


@router.delete("/api/posts/{post_id}")
def delete_post(post_id: str, ws: sqlite3.Row = Depends(get_workspace),
                conn: sqlite3.Connection = Depends(get_db)):
    _owned(conn, ws, post_id)
    conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
    conn.commit()
    return {"ok": True}


@router.post("/api/posts/{post_id}/publish", response_model=Post)
def publish(post_id: str, ws: sqlite3.Row = Depends(get_workspace),
            conn: sqlite3.Connection = Depends(get_db)):
    row = get_post_row(conn, ws["id"], post_id)
    first_publish = row is not None and row["status"] != "published"
    if row is not None:
        require_live(row["platform"])
        if first_publish and demo.is_demo(ws):
            # Demo workspace: the platform's demo account is signed in first (a post on a platform that is not connected
            # would never grow), so posting never dead-ends.
            demo.ensure_signed_in(conn, ws, row["platform"])
    post = publish_post(conn, ws["id"], post_id)
    if post is None:
        raise HTTPException(status_code=404, detail="post not found")
    if first_publish and demo.is_demo(ws):
        # ...and "posting synthetically" ends with the first synthetic metrics read: the numbers come back with the post.
        return demo.read_metrics(conn, ws, post_id, demo.FIRST_READ_MINUTES).post
    return post


@router.post("/api/posts/{post_id}/demo/metrics", response_model=demo.DemoMetricsRead)
def demo_metrics(post_id: str, advance_minutes: int = Query(demo.REFRESH_MINUTES, ge=0, le=demo.MAX_ADVANCE_MINUTES),
                 ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)):
    """A synthetic metrics read of a published post in a demo workspace (409 in any other workspace, docs/REAL.md)."""
    demo.require_demo(ws)
    return demo.read_metrics(conn, ws, post_id, advance_minutes)
