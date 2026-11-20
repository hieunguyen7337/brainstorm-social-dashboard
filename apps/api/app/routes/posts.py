"""Post CRUD and publish."""

import json
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import get_workspace
from app.db import get_db
from app.models import Platform, Post, PostCreate, PostPatch, PostStatus
from app.services import metrics
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
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
    args.append(limit)
    return [row_to_post(conn, r) for r in conn.execute(sql, args).fetchall()]


@router.post("/api/posts", response_model=Post)
def add_post(body: PostCreate, ws: sqlite3.Row = Depends(get_workspace),
             conn: sqlite3.Connection = Depends(get_db)):
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
    post = publish_post(conn, ws["id"], post_id)
    if post is None:
        raise HTTPException(status_code=404, detail="post not found")
    return post
