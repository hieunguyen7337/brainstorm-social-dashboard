"""Autopilot: config routes, one-cycle runs, due-workspace scheduling and the background loop.

Generation runs on the template fallback (ANTHROPIC key is always empty in tests), so nothing calls a real API.
"""

import asyncio
import importlib
import json
import logging
import sys
import types
from datetime import UTC, datetime, timedelta

import pytest

from app import db
from app.config import settings
from app.db import new_id, now_iso
from app.models import AutopilotConfig, Post


def _install_posts_standin() -> None:
    """Tests only: app.services.posts is another unit that may not exist yet. ai.py imports it, so a minimal
    stand-in is registered when the real module is absent. It is a no-op once the real module lands."""
    try:
        importlib.import_module("app.services.posts")
        return  # the real module, or a stand-in another test module already registered
    except ModuleNotFoundError as exc:
        if exc.name != "app.services.posts":
            raise
    import app.services as services_pkg

    def create_post(conn, workspace_id, *, platform, content, hashtags, media_prompt, theme_id, trend_id,
                    batch_id, source, quality, status):
        post_id = new_id("p")
        conn.execute(
            "INSERT INTO posts (id, workspace_id, platform, content, hashtags, media_prompt, theme_id, trend_id, "
            "batch_id, link_code, status, source, quality, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (post_id, workspace_id, platform, content, json.dumps(hashtags), media_prompt, theme_id, trend_id,
             batch_id, new_id("l"), status, source, quality, now_iso()),
        )
        return conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()

    def row_to_post(row):
        data = dict(row)
        return Post(
            id=data["id"],
            platform=data["platform"],
            content=data["content"],
            hashtags=json.loads(data["hashtags"]),
            media_prompt=data["media_prompt"],
            theme_id=data["theme_id"],
            trend_id=data["trend_id"],
            batch_id=data["batch_id"],
            link_code=data["link_code"],
            link_url=f"{settings.public_base_url}/r/{data['link_code']}",
            status=data["status"],
            source=data["source"],
            scheduled_at=data["scheduled_at"],
            published_at=data["published_at"],
            views=data["views"],
            engagements=data["engagements"],
            clicks=data["clicks"],
            conversions=data["conversions"],
            created_at=data["created_at"],
        )

    stand_in = types.ModuleType("app.services.posts")
    stand_in.create_post = create_post
    stand_in.row_to_post = row_to_post
    sys.modules["app.services.posts"] = stand_in
    services_pkg.posts = stand_in


_install_posts_standin()

from app.services import autopilot

T0 = "2026-11-20T01:00:00+00:00"
T0_DT = datetime(2026, 11, 20, 1, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _no_real_ai(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "")


@pytest.fixture()
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "database_path", str(tmp_path / "autopilot.db"))
    c = db.connect()
    db.init_db(c)
    yield c
    c.close()


@pytest.fixture()
def api(client):
    """A seeded workspace behind the real HTTP client: (client, auth headers, workspace id)."""
    conn = db.connect()
    try:
        wid, token = _seed(conn, connected=("linkedin", "x", "reddit"), disconnected=("tiktok",))
    finally:
        conn.close()
    return client, {"Authorization": f"Bearer {token}"}, wid


def _seed(conn, *, connected=("linkedin", "x"), disconnected=()):
    wid, token = new_id("w"), new_id("tok")
    conn.execute(
        "INSERT INTO workspaces (id, token, name, brand_name, brand_voice, audience, offer, product_url, created_at) "
        "VALUES (?, ?, 'Test', 'Acme', '', '', 'Free trial', 'https://example.com', ?)",
        (wid, token, now_iso()),
    )
    rows = [(p, "connected") for p in connected] + [(p, "disconnected") for p in disconnected]
    for platform, status in rows:
        conn.execute(
            "INSERT INTO connections (id, workspace_id, platform, handle, status, mode, followers, connected_at) "
            "VALUES (?, ?, ?, ?, ?, 'sandbox', 0, ?)",
            (new_id("c"), wid, platform, f"@{platform}", status, now_iso()),
        )
    conn.commit()
    return wid, token


def _ws(conn, wid):
    return conn.execute("SELECT * FROM workspaces WHERE id = ?", (wid,)).fetchone()


def _theme(conn, wid, name, *, created_at, active=True) -> str:
    tid = new_id("th")
    conn.execute(
        "INSERT INTO themes (id, workspace_id, name, description, color, active, created_at) "
        "VALUES (?, ?, ?, '', '#7c5cff', ?, ?)",
        (tid, wid, name, int(active), created_at),
    )
    conn.commit()
    return tid


def _autopilot_events(conn, wid):
    return conn.execute(
        "SELECT * FROM events WHERE workspace_id = ? AND type = 'autopilot' ORDER BY ts", (wid,)
    ).fetchall()


def _enable(conn, wid, *, interval_min=30, require_approval=True):
    autopilot.save_config(
        conn,
        wid,
        AutopilotConfig(enabled=True, interval_min=interval_min, require_approval=require_approval),
    )


# --- run_once -------------------------------------------------------------------------------------


def test_run_once_in_approval_mode_queues_scheduled_posts(conn):
    wid, _ = _seed(conn, connected=("linkedin", "x"))
    _theme(conn, wid, "Build in public", created_at="2026-01-01T00:00:00+00:00")
    _enable(conn, wid, require_approval=True)

    run = autopilot.run_once(conn, _ws(conn, wid), now=T0)

    assert run.ran_at == T0
    assert sorted(p.platform for p in run.posts) == ["linkedin", "x"]
    for post in run.posts:
        assert post.status == "scheduled"
        assert post.source == "autopilot"
        assert post.scheduled_at == T0
        assert post.published_at is None
        assert "{link}" not in post.content
        assert post.link_url and post.link_url.endswith(f"/r/{post.link_code}")
    assert autopilot.load_config(conn, wid).last_run_at == T0
    events = _autopilot_events(conn, wid)
    assert len(events) == 1
    assert events[0]["detail"].startswith("2 posts scheduled")
    assert events[0]["real"] == 0


def test_run_once_in_publish_mode_publishes_posts(conn):
    wid, _ = _seed(conn, connected=("linkedin", "x"))
    _enable(conn, wid, require_approval=False)

    run = autopilot.run_once(conn, _ws(conn, wid), now=T0)

    assert len(run.posts) == 2
    for post in run.posts:
        assert post.status == "published"
        assert post.published_at is not None
        assert post.source == "autopilot"
        assert post.scheduled_at is None
    assert autopilot.load_config(conn, wid).last_run_at == T0


def test_default_platforms_are_connected_only(conn):
    wid, _ = _seed(conn, connected=("linkedin", "x", "reddit"), disconnected=("tiktok",))
    _enable(conn, wid)

    run = autopilot.run_once(conn, _ws(conn, wid), now=T0)
    assert sorted(p.platform for p in run.posts) == ["linkedin", "reddit", "x"]

    # A configured platform that is not connected is dropped as well.
    autopilot.save_config(conn, wid, AutopilotConfig(enabled=True, platforms=["tiktok", "reddit"]))
    run = autopilot.run_once(conn, _ws(conn, wid), now=T0)
    assert [p.platform for p in run.posts] == ["reddit"]


def test_no_connected_platforms_updates_last_run_only(conn):
    wid, _ = _seed(conn, connected=(), disconnected=("linkedin",))
    _enable(conn, wid)

    run = autopilot.run_once(conn, _ws(conn, wid), now=T0)

    assert run.posts == []
    assert autopilot.load_config(conn, wid).last_run_at == T0
    assert _autopilot_events(conn, wid) == []


def test_theme_round_robin_skips_inactive_themes(conn):
    wid, _ = _seed(conn, connected=("linkedin",))
    first = _theme(conn, wid, "Tips", created_at="2026-01-01T00:00:00+00:00")
    second = _theme(conn, wid, "Stories", created_at="2026-01-02T00:00:00+00:00")
    _theme(conn, wid, "Retired", created_at="2025-12-01T00:00:00+00:00", active=False)
    _enable(conn, wid)

    ws = _ws(conn, wid)
    run1 = autopilot.run_once(conn, ws, now=T0)
    run2 = autopilot.run_once(conn, ws, now="2026-11-20T01:30:00+00:00")
    run3 = autopilot.run_once(conn, ws, now="2026-11-20T02:00:00+00:00")

    assert [run1.theme_id, run2.theme_id, run3.theme_id] == [first, second, first]
    assert run1.posts[0].theme_id == first


def test_run_once_records_trend(conn):
    wid, _ = _seed(conn, connected=("linkedin",))
    conn.execute(
        "INSERT INTO trends (id, source, title, url, score, region, fetched_at) "
        "VALUES ('tr_top', 'hackernews', 'Hot topic', 'https://example.com/x', 0.9, '', ?)",
        (now_iso(),),
    )
    conn.commit()
    _enable(conn, wid)

    run = autopilot.run_once(conn, _ws(conn, wid), now=T0)

    assert run.trend_id == "tr_top"
    assert run.posts[0].trend_id == "tr_top"


# --- REST routes ----------------------------------------------------------------------------------


def test_get_autopilot_default_shape(api):
    client, headers, _ = api
    r = client.get("/api/autopilot", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "enabled": False,
        "interval_min": 30,
        "platforms": [],
        "require_approval": True,
        "last_run_at": None,
    }


def test_put_then_get_round_trips(api):
    client, headers, _ = api
    body = {"enabled": True, "interval_min": 45, "platforms": ["x", "linkedin"], "require_approval": False}

    r = client.put("/api/autopilot", json=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["platforms"] == ["x", "linkedin"]

    got = client.get("/api/autopilot", headers=headers).json()
    assert got["enabled"] is True
    assert got["interval_min"] == 45
    assert got["platforms"] == ["x", "linkedin"]
    assert got["require_approval"] is False
    assert got["last_run_at"] is None


def test_put_rejects_invalid_platform(api):
    client, headers, _ = api
    r = client.put("/api/autopilot", json={"platforms": ["myspace"]}, headers=headers)
    assert r.status_code == 422


def test_put_cannot_move_last_run_at(api):
    client, headers, _ = api
    r = client.put("/api/autopilot", json={"last_run_at": "2099-01-01T00:00:00+00:00"}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["last_run_at"] is None


def test_autopilot_routes_require_token(api):
    client, _, _ = api
    assert client.get("/api/autopilot").status_code == 401
    assert client.put("/api/autopilot", json={}).status_code == 401
    assert client.post("/api/autopilot/run").status_code == 401


def test_post_run_returns_autopilot_run(api):
    client, headers, wid = api
    conn = db.connect()
    try:
        conn.execute(
            "INSERT INTO trends (id, source, title, url, score, region, fetched_at) "
            "VALUES ('tr_api', 'reddit', 'Api trend', 'https://example.com/r', 0.5, '', ?)",
            (now_iso(),),
        )
        conn.commit()
        _theme(conn, wid, "Launch", created_at="2026-01-01T00:00:00+00:00")
    finally:
        conn.close()

    r = client.post("/api/autopilot/run", headers=headers)

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["trend_id"] == "tr_api"
    assert body["theme_id"] is not None
    assert body["ran_at"]
    assert sorted(p["platform"] for p in body["posts"]) == ["linkedin", "reddit", "x"]
    assert all(p["status"] == "scheduled" and p["source"] == "autopilot" for p in body["posts"])


# --- run_due --------------------------------------------------------------------------------------


def test_run_due_runs_only_enabled_workspaces(conn):
    enabled, _ = _seed(conn, connected=("linkedin",))
    disabled, _ = _seed(conn, connected=("linkedin",))
    _enable(conn, enabled)
    autopilot.save_config(conn, disabled, AutopilotConfig(enabled=False))

    ran = autopilot.run_due(now=T0_DT)

    assert ran == [enabled]
    assert autopilot.load_config(conn, enabled).last_run_at == T0
    assert _autopilot_events(conn, disabled) == []
    assert autopilot.load_config(conn, disabled).last_run_at is None


def test_run_due_respects_interval(conn):
    wid, _ = _seed(conn, connected=("linkedin",))
    _enable(conn, wid, interval_min=30)

    assert autopilot.run_due(now=T0_DT) == [wid]
    assert autopilot.run_due(now=T0_DT + timedelta(minutes=10)) == []
    assert autopilot.run_due(now=T0_DT + timedelta(minutes=29, seconds=59)) == []
    assert autopilot.run_due(now=T0_DT + timedelta(minutes=30)) == [wid]


def test_run_due_isolates_a_failing_workspace(conn, monkeypatch, caplog):
    broken, _ = _seed(conn, connected=("linkedin",))
    healthy, _ = _seed(conn, connected=("linkedin",))
    _enable(conn, broken)
    _enable(conn, healthy)

    real_run_once = autopilot.run_once

    def flaky_run_once(conn, ws, *, now=None):
        if ws["id"] == broken:
            raise RuntimeError("generation exploded")
        return real_run_once(conn, ws, now=now)

    monkeypatch.setattr(autopilot, "run_once", flaky_run_once)

    with caplog.at_level(logging.ERROR, logger="pulse"):
        ran = autopilot.run_due(now=T0_DT)

    assert ran == [healthy]
    assert "generation exploded" in caplog.text
    assert any(r.name == "pulse" and r.exc_info for r in caplog.records)
    assert autopilot.load_config(conn, healthy).last_run_at == T0
    assert autopilot.load_config(conn, broken).last_run_at is None


# --- background loop ------------------------------------------------------------------------------


class _StopLoop(Exception):
    pass


def test_autopilot_loop_calls_run_due_then_sleeps(monkeypatch):
    calls = []
    sleeps = []

    def fake_run_due(now=None):
        calls.append(now)
        return []

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        raise _StopLoop

    monkeypatch.setattr(autopilot, "run_due", fake_run_due)
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    with pytest.raises(_StopLoop):
        asyncio.run(autopilot.autopilot_loop())

    assert len(calls) == 1
    assert sleeps == [settings.autopilot_loop_seconds]


def test_autopilot_loop_survives_a_failed_iteration(monkeypatch):
    calls = []
    sleeps = []

    def failing_run_due(now=None):
        calls.append(now)
        raise RuntimeError("database locked")

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        raise _StopLoop

    monkeypatch.setattr(autopilot, "run_due", failing_run_due)
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    with pytest.raises(_StopLoop):
        asyncio.run(autopilot.autopilot_loop())

    assert len(calls) == 1
    assert sleeps == [settings.autopilot_loop_seconds]
