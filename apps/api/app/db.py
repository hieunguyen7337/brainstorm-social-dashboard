"""SQLite schema and connection helper. Units add no tables here (see docs/CONTRACT.md)."""

import os
import secrets
import sqlite3
from datetime import UTC, datetime

from app.config import settings

PLATFORMS = ("linkedin", "instagram", "x", "tiktok", "reddit", "facebook")

SCHEMA = """
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    brand_name TEXT NOT NULL,
    brand_voice TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL DEFAULT '',
    offer TEXT NOT NULL DEFAULT '',
    product_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'connected',      -- connected | disconnected
    mode TEXT NOT NULL DEFAULT 'sandbox',          -- sandbox | live
    followers INTEGER NOT NULL DEFAULT 0,
    connected_at TEXT NOT NULL,
    UNIQUE (workspace_id, platform)
);
CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#7c5cff',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trends (
    id TEXT PRIMARY KEY,                           -- stable hash of source+url
    source TEXT NOT NULL,                          -- hackernews | reddit | google
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    score REAL NOT NULL DEFAULT 0,                 -- source popularity, normalised 0..1
    region TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    content TEXT NOT NULL,
    hashtags TEXT NOT NULL DEFAULT '[]',           -- JSON list of strings
    media_prompt TEXT NOT NULL DEFAULT '',
    theme_id TEXT,
    trend_id TEXT,
    batch_id TEXT,
    link_code TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft',          -- draft | scheduled | published | failed
    source TEXT NOT NULL DEFAULT 'manual',         -- manual | ai | autopilot | seed
    quality REAL NOT NULL DEFAULT 0.5,             -- 0..1, drives the simulated audience
    scheduled_at TEXT,
    published_at TEXT,
    external_url TEXT NOT NULL DEFAULT '',
    views INTEGER NOT NULL DEFAULT 0,
    engagements INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    conversions INTEGER NOT NULL DEFAULT 0,
    last_tick_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_ws ON posts(workspace_id, status);
CREATE TABLE IF NOT EXISTS daily_metrics (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    day TEXT NOT NULL,                             -- YYYY-MM-DD
    views INTEGER NOT NULL DEFAULT 0,
    engagements INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    conversions INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, platform, day)
);
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    post_id TEXT,
    type TEXT NOT NULL,                            -- click | conversion | published | generated | autopilot | connected
    platform TEXT,
    detail TEXT NOT NULL DEFAULT '',
    real INTEGER NOT NULL DEFAULT 0,               -- 1 when caused by a real person (link click/convert)
    ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ws ON events(workspace_id, ts);
CREATE TABLE IF NOT EXISTS autopilot (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    interval_min INTEGER NOT NULL DEFAULT 30,
    platforms TEXT NOT NULL DEFAULT '[]',          -- JSON list
    require_approval INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_usage (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    ts TEXT NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def new_id(prefix: str = "") -> str:
    return f"{prefix}{secrets.token_hex(6)}"


def connect(path: str | None = None) -> sqlite3.Connection:
    path = path or settings.database_path
    if path != ":memory:":
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


def get_db():
    """FastAPI dependency: one connection per request."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()
