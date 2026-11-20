import sqlite3

from fastapi import Depends, Header, HTTPException

from app.db import get_db


def get_workspace(
    authorization: str | None = Header(default=None),
    conn: sqlite3.Connection = Depends(get_db),
) -> sqlite3.Row:
    """Resolve `Authorization: Bearer <token>` to the workspace row, else 401."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    row = conn.execute("SELECT * FROM workspaces WHERE token = ?", (token,)).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="unknown workspace token")
    return row
