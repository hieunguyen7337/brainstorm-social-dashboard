"""Real workspaces (docs/REAL.md), end to end: creation and the data_mode migration, ingest that connects a
platform live, Claude reading a screenshot (the Anthropic client is always faked), the dashboard of a real
workspace, and the simulated audience staying out of it.

A real workspace has no seeded audience, posts, daily metrics, snapshots or activity: every number on screen
comes from the person. `json={}` / `real: false` keeps the sample seed, which these tests use as the contrast.
"""

import base64
import json
import logging
import sqlite3
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import anthropic
import httpx
import pytest
from pydantic import BaseModel, ValidationError

from app import db
from app.config import settings
from app.db import PLATFORMS, connect, init_db, new_id, now_iso
from app.services import ai, metrics, vision

SHOT = {"followers": 46, "views": 1234, "engagements": 56, "profile_views": 215}  # an Instagram screenshot
HISTORY = ("posts", "daily_metrics", "metric_snapshots", "events")  # what a real workspace starts without
ZERO = {"posts": 0, "daily_metrics": 0, "metric_snapshots": 0, "events": 0, "followers": 0}  # see tallies()
WHERE = pytest.mark.parametrize("where", ["top-level", "account"])  # where handle / period_days are sent
NO_TOTALS = {"views": 0, "engagements": 0, "clicks": 0, "conversions": 0}


# ---------------------------------------------------------------- fixtures and helpers

@pytest.fixture()
def real(client):
    """A real workspace (no seeded numbers); returns (client, headers, workspace json) like `auth`."""
    r = client.post("/api/workspaces", json={"real": True})
    assert r.status_code == 200, r.text
    ws = r.json()
    return client, {"Authorization": f"Bearer {ws['token']}"}, ws


def second_real(client):
    ws = client.post("/api/workspaces", json={"real": True}).json()
    return {"Authorization": f"Bearer {ws['token']}"}, ws


def q(sql, *args):
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def w(sql, *args):
    conn = sqlite3.connect(settings.database_path)
    try:
        conn.execute(sql, args)
        conn.commit()
    finally:
        conn.close()


def count(table, ws):
    return q(f"SELECT COUNT(*) FROM {table} WHERE workspace_id = ?", ws["id"])[0][0]


def tallies(ws):
    """Row counts of every table a real workspace starts without, plus its connections' follower sum."""
    out = {t: count(t, ws) for t in HISTORY}
    out["followers"] = q("SELECT SUM(followers) FROM connections WHERE workspace_id = ?", ws["id"])[0][0]
    return out


def ingest(client, h, platform="instagram", source="screenshot", **fields):
    """POST /api/metrics/ingest; `fields` are handle, period_days, account and posts."""
    body = {"platform": platform, "source": source, **fields}
    return client.post("/api/metrics/ingest", headers=h, json=body)


def sent(where, extra, account=None):
    """Ingest fields with `extra` (handle / period_days) at the top level or inside `account`."""
    account = {"followers": 1, **(account or {})}
    return {"account": {**account, **extra}} if where == "account" else {**extra, "account": account}


def connection(client, h, platform):
    return next(c for c in client.get("/api/connections", headers=h).json() if c["platform"] == platform)


def state(c):
    """(status, mode, followers, handle) of a connection as the API shows it."""
    return c["status"], c["mode"], c["followers"], c["handle"]


def events(ws, kind, platform=None):
    sql, args = "SELECT * FROM events WHERE workspace_id = ? AND type = ?", [ws["id"], kind]
    if platform:
        sql, args = sql + " AND platform = ?", [*args, platform]
    return q(sql + " ORDER BY rowid", *args)


def account_snapshots(ws, platform="instagram"):
    return q("SELECT * FROM metric_snapshots WHERE workspace_id = ? AND platform = ? AND post_id IS NULL"
             " ORDER BY rowid", ws["id"], platform)


# ---------------------------------------------------------------- real workspace: creation

def test_real_flag_sets_data_mode(real):
    client, h, ws = real
    assert ws["data_mode"] == "real" and ws["token"]
    assert client.get("/api/workspace", headers=h).json()["data_mode"] == "real"
    assert q("SELECT data_mode FROM workspaces WHERE id = ?", ws["id"])[0][0] == "real"
    patched = client.patch("/api/workspace", headers=h, json={"offer": "Free shipping"}).json()
    assert (patched["offer"], patched["data_mode"]) == ("Free shipping", "real")  # an edit keeps the mode


@pytest.mark.parametrize("brand,expected", [
    ("Acme <b>Co</b>", "Acme <b>Co</b>"), ("  Acme Co  ", "Acme Co"),
    (None, "Brew & Bloom"), ("", "Brew & Bloom"), ("   ", "Brew & Bloom"),
])
def test_real_workspace_brand_logic_is_unchanged(client, brand, expected):
    body = {} if brand is None else {"brand_name": brand}
    brand_fields = ("name", "brand_name", "brand_voice", "audience", "offer", "product_url")
    sample = client.post("/api/workspaces", json=body).json()
    r = client.post("/api/workspaces", json={**body, "real": True})
    assert r.status_code == 200, r.text
    got = r.json()
    assert (sample["data_mode"], got["data_mode"]) == ("sample", "real")
    assert got["brand_name"] == got["name"] == expected
    # voice, audience, offer and product_url come out of the same logic as in a sample workspace
    assert {k: got[k] for k in brand_fields} == {k: sample[k] for k in brand_fields}
    h = {"Authorization": f"Bearer {got['token']}"}
    assert client.get("/api/workspace", headers=h).json()["brand_name"] == expected


def test_real_workspace_has_no_numbers_posts_or_history(real):
    client, h, ws = real
    assert client.get("/api/posts?limit=200", headers=h).json() == []
    assert client.get("/api/activity", headers=h).json() == []
    assert client.get("/api/metrics/snapshots", headers=h).json() == []
    assert {t: count(t, ws) for t in HISTORY} == dict.fromkeys(HISTORY, 0)


def test_real_workspace_has_six_disconnected_live_connections(real):
    client, h, _ = real
    conns = client.get("/api/connections", headers=h).json()
    assert [c["platform"] for c in conns] == list(PLATFORMS)
    assert [state(c) for c in conns] == [("disconnected", "live", 0, "")] * 6


def test_real_workspace_has_the_content_pillars_and_autopilot_off(real):
    client, h, _ = real
    themes = client.get("/api/themes", headers=h).json()
    assert len(themes) == 4
    assert all(t["name"].strip() and t["active"] is True for t in themes)
    autopilot = client.get("/api/autopilot", headers=h).json()
    assert autopilot["enabled"] is False and autopilot["require_approval"] is True


@pytest.mark.parametrize("body", [{}, {"real": False}, {"brand_name": "Acme Co", "real": False}, None],
                         ids=["empty", "real-false", "custom-brand", "no-body"])
def test_sample_workspace_is_untouched(client, body):
    r = client.post("/api/workspaces", json=body)
    assert r.status_code == 200, r.text
    ws = r.json()
    h = {"Authorization": f"Bearer {ws['token']}"}
    assert ws["data_mode"] == "sample"
    assert client.get("/api/workspace", headers=h).json()["data_mode"] == "sample"
    assert len(client.get("/api/posts?limit=200", headers=h).json()) == 24
    conns = client.get("/api/connections", headers=h).json()
    assert len(conns) == 6
    assert all(c["status"] == "connected" and c["mode"] == "sandbox" and c["followers"] > 0 for c in conns)
    assert count("daily_metrics", ws) > 0 and count("events", ws) > 0


def test_two_real_workspaces_are_isolated(real):
    client, h, ws = real
    h2, ws2 = second_real(client)
    assert tallies(ws) == tallies(ws2) == ZERO
    posts = [{"external_id": "ig:1", "content": "A real post, long enough", "views": 10, "engagements": 1}]
    assert ingest(client, h, handle="@mine", period_days=30, account=SHOT, posts=posts).status_code == 200
    mine = tallies(ws)
    assert all(v > 0 for v in mine.values()), mine
    # the other workspace is still at zero, however it is read
    assert tallies(ws2) == ZERO
    conns = client.get("/api/connections", headers=h2).json()
    assert [state(c) for c in conns] == [("disconnected", "live", 0, "")] * 6
    for path in ("/api/posts?limit=200", "/api/activity", "/api/metrics/snapshots"):
        assert client.get(path, headers=h2).json() == [], path
    # and saving numbers there does not move the first one
    r = ingest(client, h2, platform="linkedin", source="manual", account={"followers": 7})
    assert r.status_code == 200, r.text
    assert tallies(ws) == mine
    assert tallies(ws2) == {**ZERO, "metric_snapshots": 1, "events": 2, "followers": 7}


# ---------------------------------------------------------------- migration

def old_database(path):
    """A database from before COLUMNS_V2: just the SCHEMA and SCHEMA_V2 tables, a workspace, a snapshot."""
    conn = sqlite3.connect(path)
    conn.executescript(db.SCHEMA)
    conn.executescript(db.SCHEMA_V2)
    conn.execute("INSERT INTO workspaces (id, token, name, brand_name, created_at) VALUES (?,?,?,?,?)",
                 ("w_old", "tok_old", "Old Co", "Old Co", "2026-01-01T00:00:00+00:00"))
    conn.execute(
        "INSERT INTO metric_snapshots (id, workspace_id, post_id, platform, views, engagements, followers,"
        " source, captured_at) VALUES ('s_old', 'w_old', NULL, 'instagram', 100, 10, 46, 'manual',"
        " '2026-01-01T00:00:00')")
    conn.commit()
    return conn


def columns(conn, table):
    """{name: (type, notnull, default)} from PRAGMA table_info."""
    return {r[1]: (r[2], r[3], r[4]) for r in conn.execute(f"PRAGMA table_info({table})")}


def test_init_db_adds_data_mode_and_period_days_to_an_old_database(tmp_path):
    conn = old_database(tmp_path / "old.db")
    assert "data_mode" not in columns(conn, "workspaces")  # it really is an old database
    assert "period_days" not in columns(conn, "metric_snapshots")

    db.init_db(conn)
    assert columns(conn, "workspaces")["data_mode"] == ("TEXT", 1, "'sample'")
    assert columns(conn, "metric_snapshots")["period_days"] == ("INTEGER", 0, None)
    assert conn.execute("SELECT data_mode FROM workspaces WHERE id = 'w_old'").fetchone()[0] == "sample"
    old = conn.execute("SELECT views, engagements, followers, period_days FROM metric_snapshots"
                       " WHERE id = 's_old'").fetchone()
    assert tuple(old) == (100, 10, 46, None)
    conn.execute("INSERT INTO workspaces (id, token, name, brand_name, created_at) VALUES"
                 " ('w_new', 'tok_new', 'New Co', 'New Co', '2026-01-02T00:00:00+00:00')")
    assert conn.execute("SELECT data_mode FROM workspaces WHERE id = 'w_new'").fetchone()[0] == "sample"
    conn.commit()

    # a second run is a no-op: same schema, same columns, no row written
    schema = conn.execute("SELECT type, name, sql FROM sqlite_master ORDER BY name").fetchall()
    tables = {t: columns(conn, t) for t in ("workspaces", "metric_snapshots", "connections", "posts")}
    changes = conn.total_changes
    db.init_db(conn)
    assert conn.execute("SELECT type, name, sql FROM sqlite_master ORDER BY name").fetchall() == schema
    assert {t: columns(conn, t) for t in tables} == tables
    assert conn.total_changes == changes
    assert conn.execute("SELECT id, data_mode FROM workspaces ORDER BY id").fetchall() == \
        [("w_new", "sample"), ("w_old", "sample")]
    conn.close()


def test_app_upgrades_an_old_database_file_at_startup(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import create_app

    path = tmp_path / "old.db"
    old_database(path).close()
    monkeypatch.setattr(settings, "database_path", str(path))
    with TestClient(create_app()) as client:  # the lifespan runs init_db on the old file
        old_h = {"Authorization": "Bearer tok_old"}
        old = client.get("/api/workspace", headers=old_h)
        assert old.status_code == 200 and old.json()["data_mode"] == "sample"
        assert [s["id"] for s in client.get("/api/metrics/snapshots", headers=old_h).json()] == ["s_old"]
        new = client.post("/api/workspaces", json={"real": True})
        assert new.status_code == 200 and new.json()["data_mode"] == "real"
        # the new columns work through the API on the upgraded file
        h = {"Authorization": f"Bearer {new.json()['token']}"}
        assert ingest(client, h, period_days=30, account=SHOT).status_code == 200
        assert [s["period_days"] for s in account_snapshots(new.json())] == [30]


# ---------------------------------------------------------------- ingest in a real workspace: connecting

def test_screenshot_ingest_connects_the_platform_live(real):
    client, h, ws = real
    r = ingest(client, h, handle="@hieu73372025", period_days=30, account=SHOT)
    assert r.status_code == 200, r.text
    out = r.json()
    assert set(out) == {"platform", "source", "matched", "created", "snapshots", "captured_at"}
    assert [out[k] for k in ("platform", "source", "matched", "created", "snapshots")] == \
        ["instagram", "screenshot", 0, 0, 1]
    conns = {c["platform"]: c for c in client.get("/api/connections", headers=h).json()}
    assert state(conns["instagram"]) == ("connected", "live", 46, "hieu73372025")  # the leading @ is gone
    assert [state(c) for p, c in conns.items() if p != "instagram"] == [("disconnected", "live", 0, "")] * 5
    (snap,) = account_snapshots(ws)
    assert (snap["source"], snap["period_days"]) == ("screenshot", 30)
    assert snap["captured_at"] == out["captured_at"]
    assert (snap["followers"], snap["views"], snap["engagements"]) == (46, 1234, 56)
    assert (snap["clicks"], snap["conversions"]) == (None, None)  # not captured: NULL, never an invented 0
    status = {s["platform"]: s for s in client.get("/api/connections/harvest-status", headers=h).json()}
    ig = status["instagram"]
    assert (ig["connected"], ig["followers"], ig["last_source"]) == (True, 46, "screenshot")
    assert ig["snapshots"] == 1
    assert not any(s["connected"] for p, s in status.items() if p != "instagram")


def test_screenshot_ingest_records_one_connected_event(real):
    client, h, ws = real
    assert ingest(client, h, handle="@hieu73372025", period_days=30, account=SHOT).status_code == 200

    def connected_in_feed():
        feed = client.get("/api/activity?limit=200", headers=h).json()
        return [a for a in feed if a["type"] == "connected"]

    (item,) = connected_in_feed()
    assert (item["platform"], item["detail"], item["real"], item["post_id"]) == \
        ("instagram", "Connected Instagram (real)", True, None)
    (row,) = events(ws, "connected")
    assert (row["platform"], row["detail"], row["real"], row["post_id"]) == \
        ("instagram", "Connected Instagram (real)", 1, None)
    # the same screenshot saved again: one more harvest, but the platform is not connected a second time
    assert ingest(client, h, handle="@hieu73372025", period_days=30, account=SHOT).status_code == 200
    assert len(connected_in_feed()) == len(events(ws, "connected")) == 1
    harvested = events(ws, "harvested")
    assert len(harvested) == 2 and all(e["real"] == 1 and e["platform"] == "instagram" for e in harvested)
    assert "215 profile views" in harvested[0]["detail"]
    assert [s["period_days"] for s in account_snapshots(ws)] == [30, 30]  # each save is its own snapshot


@pytest.mark.parametrize("source", ["screenshot", "device", "manual", "script", "claude_chrome"])
def test_any_source_connects_a_real_workspace_platform_live(real, source):
    client, h, ws = real
    r = ingest(client, h, platform="tiktok", source=source, account={"followers": 120})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == source
    assert state(connection(client, h, "tiktok")) == ("connected", "live", 120, "")
    (ev,) = events(ws, "connected")
    assert (ev["platform"], ev["detail"], ev["real"]) == ("tiktok", "Connected TikTok (real)", 1)
    assert ingest(client, h, platform="tiktok", source=source, account={"followers": 121}).status_code == 200
    assert state(connection(client, h, "tiktok")) == ("connected", "live", 121, "")
    assert len(events(ws, "connected")) == 1


@pytest.mark.parametrize("account", [{"followers": 120, "views": 900}, {"followers": 0}],
                         ids=["numbers", "zero-followers"])
def test_typed_numbers_connect_the_platform_without_a_handle(real, account):
    client, h, ws = real
    r = ingest(client, h, platform="x", source="manual", account=account)
    assert r.status_code == 200, r.text
    assert state(connection(client, h, "x")) == ("connected", "live", account["followers"], "")
    (ev,) = events(ws, "connected")
    assert (ev["platform"], ev["detail"], ev["real"]) == ("x", "Connected X (real)", 1)
    (snap,) = account_snapshots(ws, "x")
    assert (snap["source"], snap["period_days"], snap["followers"]) == ("manual", None, account["followers"])
    assert ingest(client, h, platform="x", source="manual", account=account).status_code == 200
    assert len(events(ws, "connected")) == 1


@pytest.mark.parametrize("source", ["carrier-pigeon", "", None])
def test_unknown_sources_are_still_422(real, source):
    client, h, ws = real
    assert ingest(client, h, source=source, account={"followers": 1}).status_code == 422
    assert connection(client, h, "instagram")["status"] == "disconnected"
    assert count("events", ws) == 0


def test_a_disconnected_platform_is_reconnected_by_the_next_ingest(real):
    client, h, ws = real
    posts = [
        {"external_id": "x:1", "content": "First real post, long enough", "views": 1200, "engagements": 64},
        {"external_id": "x:2", "content": "Second real post, long enough", "views": 300, "engagements": 20},
    ]
    assert ingest(client, h, platform="x", handle="@jane", account={"followers": 10}).status_code == 200
    gone = client.delete("/api/connections/x", headers=h)
    assert gone.status_code == 200 and gone.json()["status"] == "disconnected"
    assert len(events(ws, "connected", "x")) == 1

    account = {"followers": 12, "views": 500}
    r = ingest(client, h, platform="x", handle="@jane", period_days=30, account=account, posts=posts)
    assert r.status_code == 200, r.text  # the person's own numbers reconnect it: no 409
    assert (r.json()["matched"], r.json()["created"], r.json()["snapshots"]) == (0, 2, 3)
    assert state(connection(client, h, "x")) == ("connected", "live", 12, "jane")
    assert len(events(ws, "connected", "x")) == 2  # the reconnect is a new connection

    mine = client.get("/api/posts?platform=x&limit=200", headers=h).json()
    assert {(p["status"], p["metrics_source"]) for p in mine} == {("published", "real")}
    assert sorted((p["views"], p["engagements"]) for p in mine) == [(300, 20), (1200, 64)]
    assert q("SELECT COUNT(*) FROM posts WHERE workspace_id = ? AND metrics_source = 'real'",
             ws["id"])[0][0] == 2
    # the window belongs to the account-level snapshot only; the post-level ones carry none
    per_post = q("SELECT period_days FROM metric_snapshots WHERE workspace_id = ? AND post_id IS NOT NULL",
                 ws["id"])
    assert len(per_post) == 2 and all(row["period_days"] is None for row in per_post)
    assert [s["period_days"] for s in account_snapshots(ws, "x")] == [None, 30]
    # the posts' numbers still land in daily_metrics (once)
    totals = q("SELECT SUM(views), SUM(engagements) FROM daily_metrics WHERE workspace_id = ?", ws["id"])[0]
    assert tuple(totals) == (1500, 84)


def test_ingest_attaches_real_numbers_to_a_post_published_in_pulse(real):
    client, h, ws = real
    text = "Hello from my real Pulse workspace, long enough to match"
    made = client.post("/api/posts", headers=h, json={"platform": "instagram", "content": text}).json()
    assert client.post(f"/api/posts/{made['id']}/publish", headers=h).json()["status"] == "published"
    r = ingest(client, h, posts=[{"content": text[:40] + " … more", "views": 321, "engagements": 21}])
    assert r.status_code == 200, r.text
    assert (r.json()["matched"], r.json()["created"], r.json()["snapshots"]) == (1, 0, 1)
    (post,) = client.get("/api/posts?limit=200", headers=h).json()  # matched, not duplicated
    assert (post["id"], post["link_code"], post["status"]) == (made["id"], made["link_code"], "published")
    assert (post["metrics_source"], post["views"], post["engagements"]) == ("real", 321, 21)
    totals = q("SELECT SUM(views), SUM(engagements) FROM daily_metrics WHERE workspace_id = ?", ws["id"])[0]
    assert tuple(totals) == (321, 21)


def test_a_failed_ingest_leaves_a_real_workspace_untouched(real, monkeypatch):
    client, h, ws = real

    def boom(*args, **kwargs):
        raise RuntimeError("boom")
    monkeypatch.setattr(metrics, "bump_daily", boom)
    with pytest.raises(RuntimeError):
        ingest(client, h, handle="@jane", account=SHOT, posts=[
            {"content": "Rollback me, thanks a lot", "views": 10, "engagements": 1}])
    # connecting the platform is part of the same transaction: it is not left half-connected
    assert state(connection(client, h, "instagram")) == ("disconnected", "live", 0, "")
    assert tallies(ws) == ZERO


# ---------------------------------------------------------------- ingest: handle and period_days

@WHERE
@pytest.mark.parametrize("given,stored", [
    ("@hieu73372025", "hieu73372025"), ("  @jane  ", "jane"), ("@@x", "x"), ("jane@home", "jane@home"),
])
def test_handle_loses_its_leading_at_and_spaces(real, where, given, stored):
    client, h, _ = real
    assert ingest(client, h, **sent(where, {"handle": given})).status_code == 200
    assert connection(client, h, "instagram")["handle"] == stored


@WHERE
@pytest.mark.parametrize("blank", ["", "   ", "@@@", None])
def test_a_blank_or_all_at_handle_leaves_the_handle_unchanged(real, where, blank):
    client, h, _ = real
    assert ingest(client, h, **sent(where, {"handle": blank})).status_code == 200
    assert state(connection(client, h, "instagram")) == ("connected", "live", 1, "")  # never set: stays empty
    assert ingest(client, h, **sent(where, {"handle": "@first"})).status_code == 200
    assert ingest(client, h, **sent(where, {"handle": blank}, {"followers": 7})).status_code == 200
    assert state(connection(client, h, "instagram")) == ("connected", "live", 7, "first")  # set earlier: kept


@WHERE
def test_handle_longer_than_100_chars_is_422(real, where):
    client, h, ws = real
    assert ingest(client, h, **sent(where, {"handle": "a" * 101})).status_code == 422
    assert connection(client, h, "instagram")["status"] == "disconnected"  # a refused save connects nothing
    assert count("metric_snapshots", ws) == 0
    assert ingest(client, h, **sent(where, {"handle": "a" * 100})).status_code == 200
    assert connection(client, h, "instagram")["handle"] == "a" * 100


@WHERE
@pytest.mark.parametrize("days", [0, 366])
def test_period_days_outside_1_to_365_is_422(real, where, days):
    client, h, ws = real
    assert ingest(client, h, **sent(where, {"period_days": days})).status_code == 422
    assert connection(client, h, "instagram")["status"] == "disconnected"
    assert count("metric_snapshots", ws) == count("events", ws) == 0


@pytest.mark.parametrize("days", [1, 7, 28, 30, 90, 365])
def test_period_days_is_stored_on_the_account_snapshot(real, days):
    client, h, ws = real
    assert ingest(client, h, period_days=days, account=SHOT).status_code == 200
    (snap,) = account_snapshots(ws)
    assert snap["period_days"] == days
    assert (snap["views"], snap["engagements"], snap["followers"]) == (1234, 56, 46)


@pytest.mark.parametrize("top,inner,handle,days", [
    ({"handle": "@outer", "period_days": 7}, {"handle": "@inner", "period_days": 90}, "outer", 7),
    ({}, {"handle": "@inner", "period_days": 90}, "inner", 90),
    ({"handle": "@outer"}, {"handle": "@inner", "period_days": 90}, "outer", 90),
    ({"period_days": 7}, {"handle": "@inner", "period_days": 90}, "inner", 7),
], ids=["both", "account-only", "top-handle", "top-days"])
def test_handle_and_period_days_inside_account_work_and_top_level_wins(real, top, inner, handle, days):
    client, h, ws = real
    assert ingest(client, h, **top, account={**SHOT, **inner}).status_code == 200
    assert connection(client, h, "instagram")["handle"] == handle
    (snap,) = account_snapshots(ws)
    assert (snap["period_days"], snap["followers"], snap["views"]) == (days, 46, 1234)


@pytest.mark.parametrize("fields", [
    {"handle": "@only", "period_days": 30}, {"account": {"handle": "@only", "period_days": 30}},
], ids=["top-level", "account"])
def test_handle_and_period_days_alone_are_not_numbers(real, fields):
    client, h, ws = real
    r = ingest(client, h, **fields)
    assert r.status_code == 200, r.text
    assert r.json()["snapshots"] == 0 and count("metric_snapshots", ws) == 0  # nothing to snapshot
    assert state(connection(client, h, "instagram")) == ("connected", "live", 0, "only")


# ---------------------------------------------------------------- ingest in a sample workspace

@pytest.mark.parametrize("source", ["script", "claude_chrome", "manual"])
def test_sample_workspace_old_sources_behave_as_before(auth, source):
    client, h, ws = auth
    connected = len(events(ws, "connected"))  # the seed's "(sandbox)" events
    ok = ingest(client, h, platform="instagram", source=source, account={"followers": 77})
    assert ok.status_code == 200
    assert connection(client, h, "instagram")["mode"] == "sandbox"  # a connected sandbox platform stays one
    gone = client.delete("/api/connections/linkedin", headers=h).json()
    assert gone["status"] == "disconnected"
    r = ingest(client, h, platform="linkedin", source=source, handle="@acme", account={"followers": 5},
               posts=[{"content": "Should not be stored at all", "views": 1, "engagements": 1}])
    assert r.status_code == 409 and "disconnected" in r.json()["detail"]  # even with a handle, still refused
    li = connection(client, h, "linkedin")
    assert (li["status"], li["mode"], li["handle"]) == ("disconnected", "sandbox", gone["handle"])
    assert len(events(ws, "connected")) == connected  # no connected event, neither sandbox nor real
    assert not [e for e in events(ws, "connected") if e["real"]]
    assert events(ws, "harvested", "linkedin") == []
    assert count("metric_snapshots", ws) == 1  # the Instagram one only
    real_posts = q("SELECT COUNT(*) FROM posts WHERE workspace_id = ? AND metrics_source = 'real'", ws["id"])
    assert real_posts[0][0] == 0


@pytest.mark.parametrize("source", ["screenshot", "device"])
@pytest.mark.parametrize("disconnect_first", [False, True], ids=["connected-sandbox", "disconnected"])
def test_live_sources_in_a_sample_workspace_connect_live_once(auth, disconnect_first, source):
    client, h, ws = auth
    if disconnect_first:
        assert client.delete("/api/connections/instagram", headers=h).json()["status"] == "disconnected"
    assert connection(client, h, "instagram")["mode"] == "sandbox"
    seeded = len(events(ws, "connected"))  # the seed's "(sandbox)" events come first
    for _ in range(2):  # the second, identical save must not connect it again
        r = ingest(client, h, source=source, handle="@hieu73372025", period_days=30, account=SHOT)
        assert r.status_code == 200, r.text
        assert state(connection(client, h, "instagram")) == ("connected", "live", 46, "hieu73372025")
        new = events(ws, "connected")[seeded:]
        assert [(e["platform"], e["detail"], e["real"]) for e in new] == \
            [("instagram", "Connected Instagram (real)", 1)]
    assert connection(client, h, "tiktok")["mode"] == "sandbox"  # only the saved platform went live


# ---------------------------------------------------------------- legacy POST /api/connections/{platform}

@pytest.mark.parametrize("row_exists", [True, False], ids=["row-exists", "row-missing"])
def test_legacy_connect_in_a_real_workspace_stays_honest(real, row_exists):
    client, h, ws = real
    if not row_exists:
        w("DELETE FROM connections WHERE workspace_id = ? AND platform = 'x'", ws["id"])
    r = client.post("/api/connections/x", headers=h, json={"handle": "@x"})
    assert r.status_code == 200, r.text
    first = r.json()
    assert [first[k] for k in ("platform", "status", "mode", "followers")] == ["x", "connected", "live", 0]
    assert first["handle"].lstrip("@") == "x"
    (ev,) = events(ws, "connected")
    assert (ev["platform"], ev["detail"], ev["real"]) == ("x", "Connected X (real)", 1)
    again = client.post("/api/connections/x", headers=h, json={"handle": "@x"})
    assert again.json() == first  # a second, identical call changes nothing
    moved = client.post("/api/connections/x", headers=h, json={"handle": "@y"}).json()
    assert moved["handle"].lstrip("@") == "y" and moved["followers"] == 0
    assert len(events(ws, "connected")) == 1  # a second call, even with another handle, adds none
    gone = client.delete("/api/connections/x", headers=h)
    assert gone.status_code == 200 and gone.json()["status"] == "disconnected"
    assert state(connection(client, h, "x"))[:3] == ("disconnected", "live", 0)
    assert count("metric_snapshots", ws) == 0 and count("daily_metrics", ws) == 0  # no audience was invented


@pytest.mark.parametrize("row_exists", [True, False], ids=["row-exists", "row-missing"])
def test_legacy_connect_in_a_sample_workspace_is_unchanged(auth, row_exists):
    client, h, ws = auth
    gone = client.delete("/api/connections/reddit", headers=h).json()
    if not row_exists:  # only a brand-new connection row gets a made-up follower count
        w("DELETE FROM connections WHERE workspace_id = ? AND platform = 'reddit'", ws["id"])
    seeded = len(events(ws, "connected"))
    r = client.post("/api/connections/reddit", headers=h, json={"handle": "u/acme"})
    assert r.status_code == 200, r.text
    c = r.json()
    assert (c["status"], c["mode"], c["handle"]) == ("connected", "sandbox", "u/acme")
    if row_exists:
        assert c["followers"] == gone["followers"]  # the seeded audience stays
    else:
        assert 800 <= c["followers"] <= 6000  # a made-up audience, as for every sample connection
    new = events(ws, "connected")[seeded:]
    assert [(e["detail"], e["real"]) for e in new] == [("Connected Reddit (sandbox)", 0)]
    assert client.delete("/api/connections/reddit", headers=h).json()["status"] == "disconnected"


# ---------------------------------------------------------------- PUT /api/connections/{platform}/profile

def put_profile(client, h, platform, url):
    return client.put(f"/api/connections/{platform}/profile", headers=h, json={"profile_url": url})


@pytest.mark.parametrize("platform,url,handle,name", [
    ("linkedin", "https://www.linkedin.com/company/acme/", "company/acme", "LinkedIn"),
    ("instagram", "https://www.instagram.com/jane/", "jane", "Instagram"),
    ("reddit", "https://www.reddit.com/user/jane/", "u/jane", "Reddit"),
    ("x", "https://x.com/", "", "X"),  # nothing but the site's name in the URL: no handle to take from it
])
def test_profile_url_connects_a_real_workspace_platform_live(real, platform, url, handle, name):
    client, h, ws = real
    r = put_profile(client, h, platform, url)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["status"], body["mode"], body["followers"], body["handle"], body["profile_url"]) == \
        ("connected", "live", 0, handle, url)
    (ev,) = events(ws, "connected")
    assert (ev["platform"], ev["detail"], ev["real"]) == (platform, f"Connected {name} (real)", 1)
    assert put_profile(client, h, platform, url).json() == body  # idempotent
    assert ingest(client, h, platform=platform, source="claude_chrome", account={"followers": 9}).status_code == 200
    assert len(events(ws, "connected")) == 1  # the profile URL connected it already: the ingest adds no second one
    assert state(connection(client, h, platform)) == ("connected", "live", 9, handle)


def test_profile_url_keeps_the_handle_the_person_already_has(real):
    client, h, ws = real
    assert ingest(client, h, platform="instagram", handle="@mine", account={"followers": 5}).status_code == 200
    r = put_profile(client, h, "instagram", "https://www.instagram.com/someone_else/")
    assert r.status_code == 200
    assert (r.json()["handle"], r.json()["profile_url"]) == ("mine", "https://www.instagram.com/someone_else/")
    assert len(events(ws, "connected")) == 1


def test_profile_url_reconnects_a_disconnected_real_platform_with_a_new_event(real):
    client, h, ws = real
    url = "https://www.linkedin.com/company/acme/"
    assert put_profile(client, h, "linkedin", url).status_code == 200
    assert client.delete("/api/connections/linkedin", headers=h).json()["status"] == "disconnected"
    r = put_profile(client, h, "linkedin", url)
    assert (r.json()["status"], r.json()["mode"]) == ("connected", "live")
    assert len(events(ws, "connected", "linkedin")) == 2


@pytest.mark.parametrize("given,stored", [("@x", "x"), ("  @@y  ", "y"), ("plain", "plain")])
def test_legacy_connect_in_a_real_workspace_stores_the_handle_like_ingest_does(real, given, stored):
    client, h, _ = real
    r = client.post("/api/connections/x", headers=h, json={"handle": given})
    assert r.status_code == 200 and r.json()["handle"] == stored


# ---------------------------------------------------------------- tick stays out of real workspaces

def publish_and_advance(client, h, monkeypatch, platform="instagram"):
    """Draft a post, publish it, move the clock 60 s on, then read the feeds (each read runs metrics.tick).

    Returns the post as GET /api/posts?status=published shows it, and the activity feed.
    """
    made = client.post("/api/posts", headers=h, json={"platform": platform, "content": "Hello from the test"})
    assert made.status_code == 200, made.text
    pid = made.json()["id"]
    published = client.post(f"/api/posts/{pid}/publish", headers=h)
    assert published.status_code == 200 and published.json()["status"] == "published"
    start = metrics._now()
    monkeypatch.setattr(metrics, "_now", lambda: start + timedelta(seconds=60))
    posts = client.get("/api/posts?status=published", headers=h).json()
    feed = client.get("/api/activity?limit=200", headers=h).json()
    return next(p for p in posts if p["id"] == pid), feed


@pytest.mark.parametrize("connect_first", [False, True], ids=["platform-disconnected", "platform-live"])
def test_no_simulated_audience_in_a_real_workspace(real, monkeypatch, connect_first):
    client, h, ws = real
    if connect_first:  # the person saves a screenshot of the platform first: connected, mode live
        assert ingest(client, h, handle="@hieu73372025", period_days=30, account=SHOT).status_code == 200
    ig = connection(client, h, "instagram")
    assert (ig["status"], ig["mode"]) == (("connected" if connect_first else "disconnected"), "live")
    post, feed = publish_and_advance(client, h, monkeypatch)
    assert (post["views"], post["engagements"], post["clicks"], post["conversions"]) == (0, 0, 0, 0)
    assert count("daily_metrics", ws) == 0
    assert "engagement" not in {a["type"] for a in feed}


def test_the_same_steps_do_grow_a_post_in_a_sample_workspace(auth, monkeypatch):
    client, h, _ = auth
    post, _ = publish_and_advance(client, h, monkeypatch)
    assert post["views"] > 0  # so the real-workspace test above proves something


# ---------------------------------------------------------------- dashboard of a real workspace

def save(client, h, platform="instagram", *, source="screenshot", period_days=30, handle=None, posts=(),
         **account):
    """What the app does after a screenshot or typed numbers: POST /api/metrics/ingest."""
    body = {"platform": platform, "source": source, "account": account, "posts": list(posts)}
    if period_days is not None:
        body["period_days"] = period_days
    if handle:
        body["handle"] = handle
    r = client.post("/api/metrics/ingest", headers=h, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def dash(client, h, query=""):
    r = client.get(f"/api/dashboard{query}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------- before and after the first account


def test_dashboard_real_before_any_account_is_all_zeros(real):
    client, h, _ = real
    d = dash(client, h)
    assert d["data_mode"] == "real" and d["days"] == 30
    assert d["totals"] == NO_TOTALS and d["change_pct"] == NO_TOTALS
    assert d["followers_total"] == 0 and d["by_platform"] == []
    assert [s["value"] for s in d["funnel"]] == [0, 0, 0, 0]
    assert len(d["timeseries"]) == 30 and all(day["views"] == day["engagements"] == 0 for day in d["timeseries"])
    assert d["top_posts"] == [] and d["real_clicks"] == 0 and d["real_conversions"] == 0
    assert dash(client, h, "?days=7")["totals"] == NO_TOTALS


def test_dashboard_real_shows_the_numbers_the_person_saved(real):
    client, h, _ = real
    save(client, h, "instagram", handle="@hieu73372025", followers=46, views=1234, engagements=56,
         profile_views=215)
    d = dash(client, h)
    assert d["data_mode"] == "real" and d["followers_total"] == 46
    assert d["totals"] == {"views": 1234, "engagements": 56, "clicks": 0, "conversions": 0}
    assert d["by_platform"] == [{"platform": "instagram", "views": 1234, "engagements": 56, "clicks": 0,
                                 "conversions": 0, "share": 1.0, "followers": 46}]
    assert [s["value"] for s in d["funnel"]] == [1234, 56, 0, 0]
    assert d["change_pct"] == NO_TOTALS  # one snapshot is no history: the app shows "new"
    # the account numbers are windowed totals without a daily breakdown: no invented series
    assert sum(day["views"] for day in d["timeseries"]) == 0
    assert d["top_posts"] == []


def test_dashboard_real_shares_and_followers_across_platforms(real):
    client, h, _ = real
    save(client, h, "instagram", followers=46, views=300, engagements=30)
    save(client, h, "linkedin", followers=120, views=100, engagements=10)
    save(client, h, "x", followers=4, views=600, engagements=5)  # connected, big views
    d = dash(client, h)
    assert [p["platform"] for p in d["by_platform"]] == ["x", "instagram", "linkedin"]  # by views
    assert d["totals"]["views"] == 1000 and d["totals"]["engagements"] == 45
    assert [p["share"] for p in d["by_platform"]] == [0.6, 0.3, 0.1]
    assert {p["platform"]: p["followers"] for p in d["by_platform"]} == {"x": 4, "instagram": 46, "linkedin": 120}
    assert d["followers_total"] == 170
    assert all(p["platform"] not in ("tiktok", "reddit", "facebook") for p in d["by_platform"])


# ---------------------------------------------------------------- which snapshot feeds the window


def test_dashboard_real_snapshot_must_fit_the_window(real):
    client, h, _ = real
    save(client, h, "instagram", followers=46, views=1234, engagements=56, period_days=30)
    for days, views in ((30, 1234), (60, 1234), (90, 1234), (365, 1234), (7, 0), (1, 0)):
        d = dash(client, h, f"?days={days}")
        assert d["totals"]["views"] == views, days
        assert d["totals"]["engagements"] == (56 if views else 0), days
        assert d["followers_total"] == 46  # followers do not depend on the window
    save(client, h, "linkedin", followers=9, views=77, period_days=7)  # a 7 day figure fits every window >= 7
    assert dash(client, h, "?days=7")["totals"]["views"] == 77
    assert dash(client, h, "?days=30")["totals"]["views"] == 1234 + 77


def test_dashboard_real_uses_the_latest_snapshot_not_the_largest(real):
    client, h, _ = real
    save(client, h, views=1000, engagements=50)
    save(client, h, views=1200, engagements=60)
    assert dash(client, h)["totals"] | {"clicks": 0} == {"views": 1200, "engagements": 60, "clicks": 0,
                                                           "conversions": 0}
    save(client, h, views=900, engagements=45)  # the newest wins even when it is lower
    assert dash(client, h)["totals"]["views"] == 900 and dash(client, h)["totals"]["engagements"] == 45
    # captured_at orders them, not insertion order
    ids = [r["id"] for r in q("SELECT id FROM metric_snapshots ORDER BY rowid")]
    for sid, stamp in zip(ids, ("2026-11-03T00:00:00+00:00", "2026-11-01T00:00:00+00:00",
                                "2026-11-02T00:00:00+00:00"), strict=True):
        w("UPDATE metric_snapshots SET captured_at = ? WHERE id = ?", stamp, sid)
    assert dash(client, h)["totals"]["views"] == 1000  # the one captured last (2026-11-03) is the first insert


def test_dashboard_real_metric_missing_from_the_newest_snapshot_falls_back(real):
    client, h, _ = real
    save(client, h, views=1000, engagements=50)
    save(client, h, views=1100)  # no engagements captured this time: never read as 0
    d = dash(client, h)
    assert d["totals"]["views"] == 1100 and d["totals"]["engagements"] == 50


def test_dashboard_real_snapshots_without_a_period_do_not_feed_the_window(real):
    client, h, _ = real
    save(client, h, followers=46, views=1234, engagements=56, period_days=None, handle="@x")
    assert len(q("SELECT * FROM metric_snapshots WHERE post_id IS NULL")) == 1  # saved, but it has no window
    d = dash(client, h)
    assert d["totals"] == NO_TOTALS and d["followers_total"] == 46
    assert [p["platform"] for p in d["by_platform"]] == ["instagram"]  # connected: listed, with its followers


def test_dashboard_real_larger_of_the_daily_sum_and_the_snapshot(real):
    client, h, _ = real
    now = datetime.now(UTC).isoformat()
    post = {"external_id": "ig:1", "content": "A post that was tracked by its own numbers", "posted_at": now,
            "views": 5000, "engagements": 40}
    save(client, h, views=1234, engagements=56, posts=[post])
    d = dash(client, h)
    assert d["totals"]["views"] == 5000  # the post alone already beats the account snapshot
    assert d["totals"]["engagements"] == 56  # here the snapshot is larger
    assert d["by_platform"][0]["views"] == 5000 and d["by_platform"][0]["share"] == 1.0
    assert sum(day["views"] for day in d["timeseries"]) == 5000  # the daily series is the tracked posts only
    save(client, h, views=9000, engagements=10, posts=[])
    d = dash(client, h)
    assert d["totals"]["views"] == 9000 and d["totals"]["engagements"] == 40
    assert [t["value"] for t in d["funnel"]] == [9000, 40, 0, 0]


# ---------------------------------------------------------------- change vs real history


def test_dashboard_real_change_needs_two_snapshots_of_the_same_window(real):
    client, h, _ = real
    save(client, h, views=1000, engagements=50)
    assert dash(client, h)["change_pct"] == NO_TOTALS
    save(client, h, views=1200, engagements=60)
    assert dash(client, h)["change_pct"] == {"views": 20, "engagements": 20, "clicks": 0, "conversions": 0}
    save(client, h, views=600, engagements=60)  # latest 600 vs the one before: -50%, engagements flat
    assert dash(client, h)["change_pct"] == {"views": -50, "engagements": 0, "clicks": 0, "conversions": 0}
    save(client, h, views=100, period_days=7)  # a different window never pairs with the 30 day ones
    d = dash(client, h)
    assert d["change_pct"]["views"] == 0 and d["totals"]["views"] == 100
    assert d["change_pct"]["engagements"] == 0
    assert dash(client, h, "?days=7")["change_pct"] == NO_TOTALS


def test_dashboard_real_change_counts_only_platforms_with_history(real):
    client, h, _ = real
    save(client, h, "instagram", views=1000)
    save(client, h, "instagram", views=1200)
    save(client, h, "linkedin", views=500)  # one snapshot: it must not look like +infinity or dilute the change
    d = dash(client, h)
    assert d["totals"]["views"] == 1700
    assert d["change_pct"]["views"] == 20


# ---------------------------------------------------------------- connected platforms only


def test_dashboard_real_forgets_a_disconnected_platform_and_remembers_it_on_reconnect(real):
    client, h, _ = real
    save(client, h, "instagram", followers=46, views=1234, engagements=56)
    save(client, h, "linkedin", followers=9, views=100, engagements=2)
    assert client.delete("/api/connections/instagram", headers=h).json()["status"] == "disconnected"
    d = dash(client, h)
    assert [p["platform"] for p in d["by_platform"]] == ["linkedin"]
    assert d["totals"]["views"] == 100 and d["followers_total"] == 9
    save(client, h, "instagram", followers=47, views=1234, engagements=56)  # saving again reconnects it
    d = dash(client, h)
    assert d["totals"]["views"] == 1334 and d["followers_total"] == 56


def test_dashboard_real_platform_filter(real):
    client, h, _ = real
    save(client, h, "instagram", followers=46, views=1234, engagements=56)
    save(client, h, "linkedin", followers=9, views=100, engagements=2)
    d = dash(client, h, "?platform=linkedin")
    assert [p["platform"] for p in d["by_platform"]] == ["linkedin"]
    assert d["totals"] == {"views": 100, "engagements": 2, "clicks": 0, "conversions": 0}
    assert d["followers_total"] == 9 and d["by_platform"][0]["share"] == 1.0
    assert dash(client, h, "?platform=tiktok")["by_platform"] == []
    assert client.get("/api/dashboard?platform=myspace", headers=h).status_code == 422


# ---------------------------------------------------------------- clicks and conversions stay real events


def test_dashboard_real_clicks_and_conversions_are_tracked_link_events(real):
    client, h, _ = real
    post = client.post("/api/posts", headers=h, json={"platform": "instagram", "content": "Our first post"}).json()
    for _ in range(2):
        assert client.get(f"/r/{post['link_code']}", follow_redirects=False).status_code == 302
    client.post(f"/api/links/{post['link_code']}/convert")
    d = dash(client, h)
    assert d["totals"] == {"views": 0, "engagements": 0, "clicks": 2, "conversions": 1}
    assert d["real_clicks"] == 2 and d["real_conversions"] == 1
    assert [s["value"] for s in d["funnel"]] == [0, 0, 2, 1]
    assert d["change_pct"] == NO_TOTALS
    # the platform is not connected yet, so it shows its real clicks but no followers
    assert [(p["platform"], p["clicks"], p["followers"]) for p in d["by_platform"]] == [("instagram", 2, 0)]
    save(client, h, "instagram", followers=46, views=1234, engagements=56)
    d = dash(client, h)
    assert d["totals"] == {"views": 1234, "engagements": 56, "clicks": 2, "conversions": 1}
    assert d["by_platform"][0]["followers"] == 46


# ---------------------------------------------------------------- sample workspaces are unchanged


def test_dashboard_sample_gets_followers_and_ignores_account_snapshots(auth, monkeypatch):
    monkeypatch.setattr(metrics, "tick", lambda *a, **k: None)  # no simulated growth between the reads
    client, h, _ = auth
    before = dash(client, h)
    conns = {c["platform"]: c["followers"] for c in client.get("/api/connections", headers=h).json()}
    assert before["data_mode"] == "sample" and len(before["by_platform"]) == 6
    assert {p["platform"]: p["followers"] for p in before["by_platform"]} == conns
    assert before["followers_total"] == sum(conns.values()) > 0
    # an account snapshot never feeds a sample workspace's totals (only the daily rows do)
    save(client, h, "instagram", views=10**9, engagements=10**8, followers=5)
    after = dash(client, h)
    assert after["totals"] == before["totals"] and after["change_pct"] == before["change_pct"]
    assert after["followers_total"] == before["followers_total"] - conns["instagram"] + 5
    # followers are for connected platforms only; a disconnected one keeps its daily numbers
    client.delete("/api/connections/x", headers=h)
    d = dash(client, h)
    x = next(p for p in d["by_platform"] if p["platform"] == "x")
    assert x["followers"] == 0 and x["views"] > 0
    assert d["followers_total"] == after["followers_total"] - conns["x"]


# ---------------------------------------------------------------- the screenshot reader: POST /api/connections/{platform}/screenshot

MIB = 1024 * 1024
TINY = base64.b64encode(b"not a real png: the bytes are never sniffed").decode()
UNAVAILABLE = {"detail": "Couldn't read the screenshot right now. Type the numbers instead."}
READ_KEYS = {
    "platform", "detected_platform", "handle", "followers", "following", "posts_count", "views",
    "engagements", "profile_views", "period_days", "posts", "confidence", "notes", "ai_used",
}
POST_KEYS = {"content", "views", "likes", "comments", "shares", "posted_at"}
COUNT_KEYS = ("followers", "following", "posts_count", "views", "engagements", "profile_views")
POST_COUNT_KEYS = ("views", "likes", "comments", "shares")
REQUEST = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
BLANK_READING = {
    "detected_platform": None, "handle": None, "followers": None, "following": None, "posts_count": None,
    "views": None, "engagements": None, "profile_views": None, "period_days": None, "confidence": "medium",
    "notes": None,
}
BLANK_POST = {
    "content": None, "views": None, "likes": None, "comments": None, "shares": None, "posted_at": None,
}


# ---------------------------------------------------------------- helpers


def _b64(size: int) -> str:
    return base64.b64encode(b"\0" * size).decode()


def _wrap(text: str, width: int = 76) -> str:
    """Base64 broken into lines, the way some encoders write it."""
    return "\n".join(text[i : i + width] for i in range(0, len(text), width))


def _shot(client, headers, platform="instagram", image=TINY, media_type="image/png"):
    return client.post(
        f"/api/connections/{platform}/screenshot",
        headers=headers,
        json={"image_base64": image, "media_type": media_type},
    )


def _rows(sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    conn = connect()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def _usage(workspace_id: str) -> list[sqlite3.Row]:
    return _rows("SELECT * FROM ai_usage WHERE workspace_id = ?", (workspace_id,))


def _spend(workspace_id: str | None, *, purpose: str = "vision", cost: float = 0.0) -> None:
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO ai_usage (id, workspace_id, purpose, model, input_tokens, output_tokens, cost_usd,"
            " ts) VALUES (?, ?, ?, ?, 0, 0, ?, ?)",
            (new_id("u"), workspace_id, purpose, settings.ai_model, cost, now_iso()),
        )
        conn.commit()
    finally:
        conn.close()


def _table_counts() -> dict[str, int]:
    """Row counts of every table except ai_usage: reading a screenshot must not change any of them."""
    names = [r["name"] for r in _rows("SELECT name FROM sqlite_master WHERE type = 'table'")]
    return {n: _rows(f"SELECT COUNT(*) AS n FROM {n}")[0]["n"] for n in names if n != "ai_usage"}


def _reading(**fields) -> vision.ScreenshotReading:
    """A complete ScreenshotReading (every key is required): null for whatever is not given."""
    return vision.ScreenshotReading(**{**BLANK_READING, "posts": [], **fields})


def _post(**fields) -> vision.ScreenshotPost:
    return vision.ScreenshotPost(**{**BLANK_POST, **fields})


def _duck(**fields) -> SimpleNamespace:
    """Not validated at all: what a misbehaving model, or a sloppy fake, might hand over."""
    return SimpleNamespace(**{**BLANK_READING, "posts": [], **fields})


def _duck_post(**fields) -> SimpleNamespace:
    return SimpleNamespace(**{**BLANK_POST, **fields})


def _claude(monkeypatch, parsed=None, *, stop_reason="end_turn", usage=(1200, 300), exc=None,
            key="sk-ant-test-key") -> list[dict]:
    """Fakes the Anthropic client and the key; returns the kwargs of every messages.parse call."""
    calls: list[dict] = []

    def parse(**kwargs):
        calls.append(kwargs)
        if exc is not None:
            raise exc
        return SimpleNamespace(
            parsed_output=parsed,
            stop_reason=stop_reason,
            usage=SimpleNamespace(input_tokens=usage[0], output_tokens=usage[1]),
        )

    monkeypatch.setattr(vision, "get_client", lambda: SimpleNamespace(messages=SimpleNamespace(parse=parse)))
    monkeypatch.setattr(settings, "anthropic_api_key", key)
    return calls


def _validation_error() -> ValidationError:
    try:
        # unterminated JSON: what an answer cut off at max_tokens looks like to the SDK's parser
        vision.ScreenshotReading.model_validate_json('{"confidence": "very"')
    except ValidationError as exc:
        return exc
    raise AssertionError("expected a ValidationError")


@pytest.fixture()
def vision_db():
    """An empty in-memory database: `read_screenshot` needs the ai_usage table, not a workspace."""
    conn = connect(":memory:")
    init_db(conn)
    yield conn
    conn.close()


def _direct(db, monkeypatch, **fields) -> dict:
    """What `read_screenshot` answers when Claude hands back these (unvalidated) fields, without HTTP."""
    _claude(monkeypatch, _duck(**fields))
    return vision.read_screenshot(db, "w_test", "instagram", TINY, "image/png").model_dump()


# ---------------------------------------------------------------- the checks before any AI call


def test_vision_needs_a_token(client, monkeypatch):
    calls = _claude(monkeypatch, _reading())
    url, body = "/api/connections/instagram/screenshot", {"image_base64": TINY, "media_type": "image/png"}

    assert client.post(url, json=body).status_code == 401
    assert client.post(url, json=body, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert calls == []


def test_vision_unknown_platform_is_404(auth, monkeypatch):
    client, headers, _ = auth
    calls = _claude(monkeypatch, _reading())

    r = _shot(client, headers, platform="myspace")

    assert r.status_code == 404
    assert r.json() == {"detail": "unknown platform 'myspace'"}
    assert calls == []


def test_vision_other_media_types_are_415(auth, monkeypatch):
    client, headers, _ = auth
    calls = _claude(monkeypatch, _reading())

    for media_type in ("image/gif", "image/svg+xml", "application/pdf", "image/jpg", ""):
        r = _shot(client, headers, media_type=media_type)
        assert r.status_code == 415, media_type
        assert r.json() == {"detail": "unsupported media type: use image/png, image/jpeg or image/webp"}
    assert calls == []


def test_vision_png_jpeg_and_webp_are_accepted(auth, monkeypatch):
    client, headers, _ = auth
    calls = _claude(monkeypatch, _reading())

    for media_type in ("image/png", "image/jpeg", "image/webp"):
        assert _shot(client, headers, media_type=media_type).status_code == 200, media_type

    assert [c["messages"][0]["content"][0]["source"]["media_type"] for c in calls] == [
        "image/png", "image/jpeg", "image/webp"
    ]


def test_vision_over_5_mib_is_413(auth, monkeypatch):
    client, headers, _ = auth
    calls = _claude(monkeypatch, _reading())

    r = _shot(client, headers, image=_b64(5 * MIB + 1))
    assert r.status_code == 413
    assert r.json() == {"detail": "image too large: 5 MB at most"}

    # Text that is already longer than 5 MiB of base64 is refused without being decoded: "!" is not base64,
    # so a decode attempt would have said 422.
    for chars in (vision.MAX_B64_CHARS + 1, 2 * vision.MAX_B64_CHARS + 1):
        assert _shot(client, headers, image="!" * chars).status_code == 413, chars
    # Far beyond any 5 MiB image even in wrapped lines (here a tiny image lost in blanks): not even cleaned.
    assert _shot(client, headers, image=" " * (2 * vision.MAX_B64_CHARS) + TINY).status_code == 413
    assert calls == []


def test_vision_exactly_5_mib_passes_every_check(auth, monkeypatch):
    client, headers, ws = auth
    image = _b64(5 * MIB)
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    assert _shot(client, headers, image=image).status_code == 503  # it reached the AI check, so no 413 or 422

    calls = _claude(monkeypatch, _reading(followers=7))
    for text in (image, _wrap(image)):  # also when an encoder broke the text into lines
        r = _shot(client, headers, image=text)
        assert r.status_code == 200, r.text
        assert r.json()["followers"] == 7

    assert [c["messages"][0]["content"][0]["source"]["data"] for c in calls] == [image, image]
    assert len(_usage(ws["id"])) == 2


def test_vision_invalid_or_empty_image_is_422(auth, monkeypatch):
    client, headers, _ = auth
    calls = _claude(monkeypatch, _reading())
    bad = [
        "not base64 at all!", "abc", "", "  \n ", "data:image/png;base64,", "cafécafé", "AAAA====",
        "AA AA\n!",
    ]

    for image in bad:
        r = _shot(client, headers, image=image)
        assert r.status_code == 422, repr(image)
        assert r.json()["detail"] in ("image_base64 is not valid base64", "image is empty")  # never echoes it
    assert calls == []


def test_vision_checks_come_before_the_ai_gate(auth, monkeypatch):
    """404, 415, 413 and 422 need no AI key: with none configured they are not turned into a 503."""
    client, headers, _ = auth
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    cases = [
        ({"platform": "myspace"}, 404),
        ({"media_type": "image/gif"}, 415),
        ({"image": _b64(5 * MIB + 1)}, 413),
        ({"image": "!!!"}, 422),
        ({}, 503),  # a good request is the only one that gets as far as the AI gate
    ]

    for kwargs, status in cases:
        assert _shot(client, headers, **kwargs).status_code == status, list(kwargs)


def test_vision_tolerates_a_data_url_prefix_and_line_breaks(auth, monkeypatch):
    client, headers, _ = auth
    calls = _claude(monkeypatch, _reading())

    r = _shot(client, headers, image="data:image/png;base64," + _wrap(TINY, 8) + "\n")

    assert r.status_code == 200, r.text
    assert calls[0]["messages"][0]["content"][0]["source"]["data"] == TINY


# ---------------------------------------------------------------- the AI gate


def test_vision_without_a_key_is_503_with_the_exact_text(auth, monkeypatch):
    client, headers, ws = auth
    calls = _claude(monkeypatch, _reading())
    monkeypatch.setattr(settings, "anthropic_api_key", "")

    r = _shot(client, headers)

    assert r.status_code == 503
    assert r.json() == UNAVAILABLE
    detail = "Couldn't read the screenshot right now. Type the numbers instead."  # a straight apostrophe
    assert r.json()["detail"] == detail == vision.UNAVAILABLE_DETAIL
    assert calls == [] and _usage(ws["id"]) == []


@pytest.mark.parametrize("cap", ["workspace", "global"])
def test_vision_stops_at_the_ai_caps(auth, monkeypatch, cap):
    client, headers, ws = auth
    calls = _claude(monkeypatch, _reading())
    if cap == "workspace":
        monkeypatch.setattr(settings, "ai_workspace_limit", 2)
        _spend(ws["id"])
        _spend(ws["id"])
    else:
        _spend(None, cost=settings.ai_global_cap_usd)

    r = _shot(client, headers)

    assert r.status_code == 503 and r.json() == UNAVAILABLE
    assert calls == []


def test_vision_has_its_own_budget_per_workspace(auth, monkeypatch):
    client, headers, ws = auth
    calls = _claude(monkeypatch, _reading())
    monkeypatch.setattr(settings, "ai_workspace_limit", 2)
    for _ in range(3):
        _spend(ws["id"], purpose="generate")  # other purposes do not use up the screenshot budget
    other_ws = client.post("/api/workspaces", json={}).json()
    _spend(other_ws["id"])
    _spend(other_ws["id"])  # nor does another workspace

    assert _shot(client, headers).status_code == 200
    assert _shot(client, headers).status_code == 200
    assert _shot(client, headers).status_code == 503  # its own two screenshot reads are used up now
    assert len(calls) == 2


# ---------------------------------------------------------------- a successful read


def test_vision_success_maps_the_reading(auth, monkeypatch):
    client, headers, ws = auth
    reading = _reading(
        detected_platform="instagram", handle="acme_studio", followers=1200, following=48, posts_count=12,
        views=34000, engagements=560, profile_views=215, period_days=30, confidence="high",
        notes="Read followers, following and posts from your Instagram profile.",
        posts=[
            _post(content="Launch day!", views=900, likes=40, comments=3, shares=2, posted_at="2026-11-02"),
        ],
    )
    calls = _claude(monkeypatch, reading, usage=(1234, 567))

    r = _shot(client, headers, platform="linkedin", media_type="image/webp")

    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == READ_KEYS
    assert set(body["posts"][0]) == POST_KEYS
    assert body["platform"] == "linkedin"  # the path's, although the picture looks like Instagram
    assert body["detected_platform"] == "instagram"
    assert body["ai_used"] is True
    assert body == {"platform": "linkedin", "ai_used": True, **reading.model_dump()}

    assert len(calls) == 1
    call = calls[0]
    assert call["model"] == settings.ai_model
    assert call["max_tokens"] == vision.MAX_TOKENS == 4000
    assert call["output_config"] == {"effort": "low"}
    assert isinstance(call["system"], str) and call["system"].strip()
    assert isinstance(call["output_format"], type) and issubclass(call["output_format"], BaseModel)
    assert call["output_format"] is vision.ScreenshotReading
    (message,) = call["messages"]
    images = [b for b in message["content"] if b["type"] == "image"]
    texts = [b for b in message["content"] if b["type"] == "text"]
    assert message["role"] == "user" and len(message["content"]) == 2 and len(images) == len(texts) == 1
    assert images[0]["source"] == {"type": "base64", "media_type": "image/webp", "data": TINY}
    assert "LinkedIn" in texts[0]["text"] and len(texts[0]["text"]) < 200

    (usage,) = _usage(ws["id"])
    assert usage["purpose"] == "vision" and usage["model"] == settings.ai_model
    assert (usage["input_tokens"], usage["output_tokens"]) == (1234, 567)
    assert usage["cost_usd"] == pytest.approx(1234 * 2 / 1e6 + 567 * 10 / 1e6)


@pytest.mark.parametrize("is_real", [False, True], ids=["sample", "real"])
def test_vision_saves_nothing_but_the_usage_row(client, monkeypatch, is_real):
    ws = client.post("/api/workspaces", json={"real": is_real}).json()
    headers = {"Authorization": f"Bearer {ws['token']}"}
    _claude(monkeypatch, _reading(followers=46, handle="acme", confidence="high", posts=[_post(views=9)]))
    tables, connections = _table_counts(), [tuple(r) for r in _rows("SELECT * FROM connections ORDER BY id")]

    r = _shot(client, headers)

    assert r.status_code == 200 and r.json()["followers"] == 46
    assert _table_counts() == tables  # no posts, daily_metrics, metric_snapshots, connections, events...
    assert [tuple(r) for r in _rows("SELECT * FROM connections ORDER BY id")] == connections
    assert len(_usage(ws["id"])) == 1


def test_vision_client_comes_from_ai_get_client(auth, monkeypatch):
    """Patching `ai.get_client` is enough: vision.get_client looks it up when it is called."""
    client, headers, _ = auth
    seen: list[dict] = []

    def parse(**kwargs):
        seen.append(kwargs)
        usage = SimpleNamespace(input_tokens=1, output_tokens=1)
        return SimpleNamespace(parsed_output=_reading(followers=3), stop_reason="end_turn", usage=usage)

    monkeypatch.setattr(ai, "get_client", lambda: SimpleNamespace(messages=SimpleNamespace(parse=parse)))
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-test-key")

    assert _shot(client, headers).json()["followers"] == 3
    assert len(seen) == 1


def test_vision_survives_a_failure_to_record_usage(auth, monkeypatch):
    client, headers, _ = auth
    _claude(monkeypatch, _reading(followers=5))

    def locked(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(ai, "_record_usage", locked)

    r = _shot(client, headers)

    assert r.status_code == 200 and r.json()["followers"] == 5  # a paid-for reading is not thrown away


# ---------------------------------------------------------------- never trust what Claude returned


def test_vision_endpoint_sanitises_the_answer(auth, monkeypatch):
    """The rules are checked one by one further down; this shows the endpoint applies them."""
    client, headers, _ = auth
    first = _duck_post(content="x" * 300, views=-1, posted_at="soon")
    _claude(monkeypatch, _duck(
        handle="@acme", followers=-5, following=48, period_days=28, notes="n" * 400,
        posts=[first, *[_duck_post(content=f"post {i}", views=i) for i in range(24)]],
    ))

    body = _shot(client, headers).json()

    assert body["handle"] == "acme" and body["followers"] is None and body["following"] == 48
    assert body["period_days"] == 30 and body["notes"] == "n" * 300
    assert len(body["posts"]) == 20
    assert body["posts"][0] == {**BLANK_POST, "content": "x" * 200}


@pytest.mark.parametrize(
    "value, expected",
    [(46, 46), (0, 0), (-1, None), (None, None), (True, None), ("1200", None), (10**13, 10**12)],
)
def test_vision_counts_are_clamped(vision_db, monkeypatch, value, expected):
    answer = _direct(
        vision_db, monkeypatch, **dict.fromkeys(COUNT_KEYS, value),
        posts=[_duck_post(**dict.fromkeys(POST_COUNT_KEYS, value))],
    )

    post = answer["posts"][0]
    assert {key: answer[key] for key in COUNT_KEYS} == dict.fromkeys(COUNT_KEYS, expected)
    assert {key: post[key] for key in POST_COUNT_KEYS} == dict.fromkeys(POST_COUNT_KEYS, expected)


@pytest.mark.parametrize(
    "value, expected",
    [(7, 7), (1, 7), (28, 30), (30, 30), (31, 90), (60, 90), (90, 90), (91, None), (365, None), (0, None),
     (-3, None), (None, None), (True, None), ("30", None)],
)
def test_vision_period_rounds_up_to_7_30_or_90(vision_db, monkeypatch, value, expected):
    assert _direct(vision_db, monkeypatch, period_days=value)["period_days"] == expected


@pytest.mark.parametrize(
    "value, expected",
    [("@acme", "acme"), ("  @@acme  ", "acme"), ("u/acme", "u/acme"), ("@", None), ("", None), (None, None),
     (123, None), ("a" * 150, "a" * 100)],
)
def test_vision_handle_loses_the_at_sign(vision_db, monkeypatch, value, expected):
    assert _direct(vision_db, monkeypatch, handle=value)["handle"] == expected


@pytest.mark.parametrize(
    "value, expected",
    [("2026-11-02", "2026-11-02"), ("2026-11-02T09:30:00Z", "2026-11-02"),
     ("2026-11-02T23:59:59+10:00", "2026-11-02"), (" 2026-11-02 ", "2026-11-02"), ("yesterday", None),
     ("3d", None), ("2026-02-30", None), ("11/02/2026", None), ("", None), (None, None), (20261102, None)],
)
def test_vision_posted_at_is_a_date_or_null(vision_db, monkeypatch, value, expected):
    answer = _direct(vision_db, monkeypatch, posts=[_duck_post(posted_at=value, views=1)])
    assert answer["posts"][0]["posted_at"] == expected


def test_vision_text_is_stripped_and_clipped(vision_db, monkeypatch):
    answer = _direct(
        vision_db, monkeypatch,
        notes="  " + "n" * 400 + "  ",
        posts=[
            _duck_post(content="  " + "x" * 300 + "  "),
            _duck_post(content="  Short and sweet \n"),
            _duck_post(content="   "),
            _duck_post(content=None),
        ],
    )

    assert answer["notes"] == "n" * 300
    assert [p["content"] for p in answer["posts"]] == ["x" * 200, "Short and sweet", None, None]
    assert _direct(vision_db, monkeypatch, notes="   ")["notes"] is None


def test_vision_keeps_at_most_20_posts_in_order(vision_db, monkeypatch):
    posts = [_duck_post(content=f"post {i}", views=i) for i in range(25)]

    answer = _direct(vision_db, monkeypatch, posts=posts)

    assert [p["content"] for p in answer["posts"]] == [f"post {i}" for i in range(20)]
    assert _direct(vision_db, monkeypatch, posts=None)["posts"] == []


def test_vision_unknown_platform_and_confidence_fall_back(vision_db, monkeypatch):
    answer = _direct(vision_db, monkeypatch, detected_platform="myspace", confidence="certain")
    assert answer["detected_platform"] is None and answer["confidence"] == "low"

    answer = _direct(vision_db, monkeypatch, detected_platform="tiktok", confidence="high")
    assert answer["detected_platform"] == "tiktok" and answer["confidence"] == "high"


def test_vision_a_sparse_duck_typed_answer_still_works(vision_db, monkeypatch):
    _claude(monkeypatch, SimpleNamespace(followers=46, confidence="high"))  # nothing else, not even posts

    answer = vision.read_screenshot(vision_db, "w_test", "x", TINY, "image/png").model_dump()

    assert set(answer) == READ_KEYS and answer["platform"] == "x" and answer["ai_used"] is True
    assert answer["followers"] == 46 and answer["following"] is None and answer["posts"] == []


# ---------------------------------------------------------------- failures


def test_vision_a_failed_call_is_503_and_costs_nothing(auth, monkeypatch):
    client, headers, ws = auth
    too_many, bad_image = httpx.Response(429, request=REQUEST), httpx.Response(400, request=REQUEST)
    failures = {
        "connection": anthropic.APIConnectionError(request=REQUEST),
        "timeout": anthropic.APITimeoutError(request=REQUEST),
        "rate-limit": anthropic.RateLimitError("slow down", response=too_many, body=None),
        "bad-request": anthropic.BadRequestError("bad image", response=bad_image, body=None),
        "validation": _validation_error(),
    }

    for name, exc in failures.items():
        calls = _claude(monkeypatch, exc=exc)
        r = _shot(client, headers)
        assert r.status_code == 503 and r.json() == UNAVAILABLE, name
        assert len(calls) == 1, name  # it was tried
    assert _usage(ws["id"]) == []  # and nothing is recorded when the call raised


def test_vision_an_unusable_answer_is_503_but_it_cost_tokens(auth, monkeypatch):
    client, headers, ws = auth
    answers = [  # (parsed, stop_reason)
        (None, "refusal"),
        (_reading(followers=9), "max_tokens"),
        (None, "end_turn"),
    ]

    for done, (parsed, stop_reason) in enumerate(answers, start=1):
        _claude(monkeypatch, parsed, stop_reason=stop_reason, usage=(900, 40))
        r = _shot(client, headers)
        assert r.status_code == 503 and r.json() == UNAVAILABLE, stop_reason
        rows = _usage(ws["id"])
        assert len(rows) == done  # a response came back, so it is counted every time
        last = rows[-1]
        assert last["purpose"] == "vision" and (last["input_tokens"], last["output_tokens"]) == (900, 40)


def test_vision_never_logs_the_image_or_the_key(auth, monkeypatch, caplog):
    client, headers, _ = auth
    caplog.set_level(logging.DEBUG)
    image = base64.b64encode(b"SECRET-PIXELS-" * 40).decode()
    key = "sk-ant-FAKE-do-not-log-this-key"
    cases = [
        {"parsed": _reading(followers=1)},
        {"exc": anthropic.APIConnectionError(request=REQUEST)},
        {"exc": _validation_error()},
        {"parsed": None, "stop_reason": "refusal"},
    ]

    for case in cases:
        _claude(monkeypatch, key=key, **case)
        _shot(client, headers, image=image)

    assert any(r.name == "pulse" for r in caplog.records)  # the failures did log something
    for record in caplog.records:
        assert image not in record.getMessage() and key not in record.getMessage()
    assert image not in caplog.text and key not in caplog.text


# ---------------------------------------------------------------- the real SDK, over a canned HTTP transport


@pytest.fixture()
def sdk_http():
    """The HTTP library the installed SDK talks through (httpx2 in anthropic 2.x)."""
    return pytest.importorskip("httpx2", reason="this SDK does not talk through httpx2")


def _real_client(sdk_http, monkeypatch, handler) -> None:
    """The real Anthropic client, answering from `handler` instead of the network (the key is a fake)."""
    http = sdk_http.Client(transport=sdk_http.MockTransport(handler))
    client = anthropic.Anthropic(api_key="sk-ant-test-key", max_retries=0, http_client=http)
    monkeypatch.setattr(ai, "get_client", lambda: client)
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-test-key")


def _reply(sdk_http, text=None, *, stop_reason="end_turn", content=None):
    """A Messages API reply: one text block, or whatever `content` says."""
    return sdk_http.Response(200, json={
        "id": "msg_test", "type": "message", "role": "assistant", "model": settings.ai_model,
        "content": [{"type": "text", "text": text}] if content is None else content,
        "stop_reason": stop_reason, "stop_sequence": None,
        "usage": {"input_tokens": 1500, "output_tokens": 220},
    })


def test_vision_real_sdk_sends_the_expected_request_and_parses_the_reply(vision_db, monkeypatch, sdk_http):
    answer = _reading(
        detected_platform="x", handle="acme", followers=46, following=48, period_days=7, confidence="high",
        posts=[_post(content="Hello", views=10, posted_at="2026-11-02")],
    )
    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return _reply(sdk_http, answer.model_dump_json())

    _real_client(sdk_http, monkeypatch, handler)

    result = vision.read_screenshot(vision_db, "w_test", "x", TINY, "image/jpeg")

    assert result.model_dump() == {"platform": "x", "ai_used": True, **answer.model_dump()}
    (request,) = sent
    assert request["model"] == settings.ai_model and request["max_tokens"] == 4000
    assert request["system"] == vision.SYSTEM_PROMPT
    assert request["output_config"]["effort"] == "low"
    fmt = request["output_config"]["format"]
    assert fmt["type"] == "json_schema"
    keys = set(vision.ScreenshotReading.model_fields)
    assert set(fmt["schema"]["properties"]) == set(fmt["schema"]["required"]) == keys
    (message,) = request["messages"]
    assert [block["type"] for block in message["content"]] == ["image", "text"]
    assert message["content"][0]["source"] == {"type": "base64", "media_type": "image/jpeg", "data": TINY}
    assert "X" in message["content"][1]["text"]
    (row,) = vision_db.execute("SELECT * FROM ai_usage").fetchall()
    assert (row["purpose"], row["input_tokens"], row["output_tokens"]) == ("vision", 1500, 220)


def test_vision_real_sdk_failures_all_end_as_unavailable(vision_db, monkeypatch, sdk_http):
    good = _reading(followers=1).model_dump_json()

    def error(status, kind):
        return sdk_http.Response(status, json={"type": "error", "error": {"type": kind, "message": "nope"}})

    def no_route(request):
        raise sdk_http.ConnectError("no route", request=request)

    cases = {
        "cut off": lambda request: _reply(sdk_http, good[:40], stop_reason="max_tokens"),
        "refusal": lambda request: _reply(sdk_http, "I can't help with that.", stop_reason="refusal"),
        "refusal without text": lambda request: _reply(sdk_http, content=[], stop_reason="refusal"),
        "nothing parsed": lambda request: _reply(sdk_http, content=[]),
        "missing keys": lambda request: _reply(sdk_http, '{"followers": 5}'),
        "rate limit": lambda request: error(429, "rate_limit_error"),
        "server error": lambda request: error(500, "api_error"),
        "bad key": lambda request: error(401, "authentication_error"),
        "bad image": lambda request: error(400, "invalid_request_error"),
        "no connection": no_route,
    }

    for name, handler in cases.items():
        _real_client(sdk_http, monkeypatch, handler)
        try:
            vision.read_screenshot(vision_db, "w_test", "instagram", TINY, "image/png")
        except vision.VisionUnavailable:
            continue
        pytest.fail(f"{name}: expected VisionUnavailable")


# ---------------------------------------------------------------- the contract in code


def _descriptions(node):
    """Every description string anywhere in a JSON schema, nested branches included."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "description" and isinstance(value, str):
                yield value
            else:
                yield from _descriptions(value)
    elif isinstance(node, list):
        for item in node:
            yield from _descriptions(item)


def test_vision_schema_fits_the_structured_output_limits():
    """The live API refuses schemas with over 24 optional or over 16 union-typed parameters ("Schema is too
    complex"), and a faked client cannot notice, so they are counted here on what the SDK would send."""
    schema = anthropic.transform_schema(vision.ScreenshotReading)
    objects = [schema, *schema.get("$defs", {}).values()]
    properties = {
        (i, name): prop for i, obj in enumerate(objects) for name, prop in obj.get("properties", {}).items()
    }
    optional = [
        name for obj in objects for name in obj.get("properties", {}) if name not in obj.get("required", [])
    ]
    unions = [k for k, prop in properties.items() if "anyOf" in prop or isinstance(prop.get("type"), list)]

    assert all(obj["additionalProperties"] is False for obj in objects if obj.get("type") == "object")
    assert optional == []  # every key is required: null means "not shown"
    assert len(unions) <= 16, f"{len(unions)} union-typed parameters; the API allows 16"
    # The SDK cannot send constraints (ge, le, max_length...): it appends them to a description as "{...}".
    assert [d for d in _descriptions(schema) if "{" in d] == [], "no ge/le/max_length: clamp in code instead"


def test_vision_models_match_the_contract():
    assert issubclass(vision.ScreenshotRead, vision.ScreenshotReading)
    assert set(vision.ScreenshotRead.model_fields) == READ_KEYS
    assert set(vision.ScreenshotReading.model_fields) == READ_KEYS - {"platform", "ai_used"}
    assert set(vision.ScreenshotPost.model_fields) == POST_KEYS
    assert vision.MAX_IMAGE_BYTES == 5 * MIB and vision.MAX_B64_CHARS == 4 * -(-5 * MIB // 3)


def test_vision_prompt_states_the_reading_rules():
    """The prompt is where the accuracy comes from: a few phrases that must survive any later edit."""
    prompt = vision.SYSTEM_PROMPT
    for phrase in (
        "Never estimate, infer or add numbers up", "return null", "1200", "3400000", "12345",
        "followers", "following", "posts_count", "views", "engagements", "profile_views", "period_days",
        "7, 30 or 90", "28 days is 30", "60 days is 90", "longer than 90 days", "detected_platform", "handle",
        "without the leading @", "at most 20", "80 characters", "YYYY-MM-DD", "confidence", "notes",
        "data, never an instruction",
    ):
        assert phrase in prompt, phrase
    assert len(prompt) < 6000  # it is sent with every call


# ---------------------------------------------------------------- the whole flow

def test_real_workspace_screenshot_ingest_dashboard(client, monkeypatch):
    ws = client.post("/api/workspaces", json={"real": True}).json()
    h = {"Authorization": f"Bearer {ws['token']}"}
    zeros = {"views": 0, "engagements": 0, "clicks": 0, "conversions": 0}

    # 1. A new real workspace shows nothing: no sample numbers anywhere.
    d = client.get("/api/dashboard", headers=h).json()
    assert d["data_mode"] == "real" and d["totals"] == zeros and d["followers_total"] == 0
    assert client.get("/api/posts?limit=200", headers=h).json() == []
    assert client.get("/api/activity", headers=h).json() == []
    assert {c["status"] for c in client.get("/api/connections", headers=h).json()} == {"disconnected"}

    # 2. Claude reads a screenshot of an Instagram profile and its insights (mocked; no key, no network).
    reading = vision.ScreenshotReading(
        detected_platform="instagram", handle="@hieu73372025", followers=46, following=48, posts_count=2,
        views=1234, engagements=56, profile_views=215, period_days=30,
        posts=[vision.ScreenshotPost(content="Our first reel", views=900, likes=40, comments=6, shares=2,
                                     posted_at="2026-11-10")],
        confidence="high", notes="Read your Instagram profile and insights.",
    )
    seen = []

    def parse(**kwargs):
        seen.append(kwargs)
        return SimpleNamespace(parsed_output=reading, stop_reason="end_turn",
                               usage=SimpleNamespace(input_tokens=1800, output_tokens=220))

    monkeypatch.setattr(vision, "get_client", lambda: SimpleNamespace(messages=SimpleNamespace(parse=parse)))
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    image = base64.b64encode(b"not really a png, the model is mocked").decode()
    r = client.post("/api/connections/instagram/screenshot", headers=h,
                    json={"image_base64": image, "media_type": "image/png"})
    assert r.status_code == 200, r.text
    read = r.json()
    assert (read["platform"], read["detected_platform"], read["handle"], read["ai_used"]) == \
        ("instagram", "instagram", "hieu73372025", True)
    assert (read["followers"], read["views"], read["engagements"], read["period_days"]) == (46, 1234, 56, 30)
    assert len(seen) == 1

    # reading saves nothing: the workspace is still empty until the person confirms
    assert client.get("/api/dashboard", headers=h).json()["totals"] == zeros
    assert {c["status"] for c in client.get("/api/connections", headers=h).json()} == {"disconnected"}
    assert client.get("/api/metrics/snapshots", headers=h).json() == []

    # 3. The app shows the numbers for checking, then saves them with the existing ingest endpoint.
    post = read["posts"][0]
    saved = client.post("/api/metrics/ingest", headers=h, json={
        "platform": "instagram", "source": "screenshot", "handle": read["handle"],
        "period_days": read["period_days"],
        "account": {k: read[k] for k in ("followers", "views", "engagements", "profile_views")},
        "posts": [{"content": post["content"], "posted_at": post["posted_at"], "views": post["views"],
                   "engagements": post["likes"] + post["comments"] + post["shares"]}],
    })
    assert saved.status_code == 200, saved.text
    assert (saved.json()["created"], saved.json()["snapshots"]) == (1, 2)

    # 4. The platform is connected live and the dashboard shows exactly those numbers.
    ig = next(c for c in client.get("/api/connections", headers=h).json() if c["platform"] == "instagram")
    assert (ig["status"], ig["mode"], ig["followers"], ig["handle"]) == ("connected", "live", 46, "hieu73372025")
    d = client.get("/api/dashboard", headers=h).json()
    assert d["data_mode"] == "real" and d["followers_total"] == 46
    assert d["totals"] == {"views": 1234, "engagements": 56, "clicks": 0, "conversions": 0}
    assert d["by_platform"] == [{"platform": "instagram", "views": 1234, "engagements": 56, "clicks": 0,
                                 "conversions": 0, "share": 1.0, "followers": 46}]
    assert [(p["content"], p["views"], p["metrics_source"]) for p in d["top_posts"]] == \
        [("Our first reel", 900, "real")]
    assert d["change_pct"] == zeros  # the first snapshot: "new"
    kinds = [a["type"] for a in client.get("/api/activity", headers=h).json()]
    assert kinds.count("connected") == 1 and kinds.count("harvested") == 1

    # 5. The reading was counted against the AI caps as a 'vision' call, and nothing else was spent.
    raw = sqlite3.connect(settings.database_path)
    try:
        usage = raw.execute("SELECT purpose, input_tokens, output_tokens FROM ai_usage WHERE workspace_id = ?",
                           (ws["id"],)).fetchall()
    finally:
        raw.close()
    assert usage == [("vision", 1800, 220)]

    # 6. A later screenshot with newer numbers moves the dashboard and the change against the first one.
    reading.views, reading.engagements, reading.followers = 1480, 70, 51
    assert client.post("/api/connections/instagram/screenshot", headers=h,
                       json={"image_base64": image, "media_type": "image/png"}).status_code == 200
    client.post("/api/metrics/ingest", headers=h, json={
        "platform": "instagram", "source": "screenshot", "period_days": 30,
        "account": {"followers": 51, "views": 1480, "engagements": 70}})
    d = client.get("/api/dashboard", headers=h).json()
    assert d["totals"]["views"] == 1480 and d["followers_total"] == 51
    assert d["change_pct"]["views"] == 20 and d["change_pct"]["engagements"] == 25
