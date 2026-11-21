"""Demo workspaces (docs/REAL.md, "Demo workspaces"): the labelled synthetic sign-in and numbers.

A demo workspace starts empty like a real one. POST /api/connections/{platform}/demo connects a platform as `sandbox` and
backfills deterministic 60-day numbers, a few published `sim` posts and a `real = 0` event. Real-number writes (ingest,
screenshot, profile URL) are refused in it (409), and the demo endpoint is refused everywhere else.
"""

import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from app.config import settings
from app.db import PLATFORMS
from app.services import metrics
from app.services.seed import SHAPES

HANDLES = {"instagram": "@brewandbloom", "linkedin": "company/brewandbloom", "reddit": "u/brewandbloom",
           "x": "@brewandbloom", "tiktok": "@brewandbloom", "facebook": "@brewandbloom"}
SOURCES = ("script", "claude_chrome", "manual", "screenshot", "device")
SHOT = {"image_base64": "iVBORw0KGgo=", "media_type": "image/png"}


# ---------------------------------------------------------------- fixtures and helpers

@pytest.fixture()
def demo(client):
    """A demo workspace; returns (client, headers, workspace json) like `auth`."""
    return make_demo(client)


def make_demo(client, **body):
    r = client.post("/api/workspaces", json={"demo": True, **body})
    assert r.status_code == 200, r.text
    ws = r.json()
    return client, {"Authorization": f"Bearer {ws['token']}"}, ws


def q(sql, *args):
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def count(table, ws, **where):
    sql = f"SELECT COUNT(*) FROM {table} WHERE workspace_id = ?"
    args = [ws["id"]]
    for k, v in where.items():
        sql, args = f"{sql} AND {k} = ?", [*args, v]
    return q(sql, *args)[0][0]


def tallies(ws):
    """Row counts of what a demo workspace starts without, plus its connections' follower sum."""
    out = {t: count(t, ws) for t in ("posts", "daily_metrics", "metric_snapshots", "events")}
    out["followers"] = q("SELECT SUM(followers) FROM connections WHERE workspace_id = ?", ws["id"])[0][0]
    return out


def sign_in(client, h, platform="instagram"):
    r = client.post(f"/api/connections/{platform}/demo", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def connection(client, h, platform):
    return next(c for c in client.get("/api/connections", headers=h).json() if c["platform"] == platform)


# ---------------------------------------------------------------- creation

def test_demo_flag_creates_an_empty_demo_workspace(demo):
    client, h, ws = demo
    assert ws["data_mode"] == "demo" and ws["token"]
    assert client.get("/api/workspace", headers=h).json()["data_mode"] == "demo"
    conns = client.get("/api/connections", headers=h).json()
    assert [c["platform"] for c in conns] == list(PLATFORMS)
    assert all((c["status"], c["mode"], c["followers"], c["handle"]) == ("disconnected", "sandbox", 0, "")
               for c in conns)
    assert tallies(ws) == {"posts": 0, "daily_metrics": 0, "metric_snapshots": 0, "events": 0, "followers": 0}
    assert count("themes", ws) == 4
    assert q("SELECT enabled FROM autopilot WHERE workspace_id = ?", ws["id"])[0][0] == 0


def test_demo_and_real_together_is_refused(client):
    r = client.post("/api/workspaces", json={"demo": True, "real": True})
    assert r.status_code == 422


def test_demo_dashboard_starts_empty(demo):
    client, h, _ = demo
    d = client.get("/api/dashboard", headers=h).json()
    assert d["data_mode"] == "demo" and d["by_platform"] == [] and d["followers_total"] == 0


# ---------------------------------------------------------------- the synthetic sign-in

@pytest.mark.parametrize("platform", PLATFORMS)
def test_sign_in_connects_the_platform_with_synthetic_numbers(demo, platform):
    client, h, ws = demo
    result = sign_in(client, h, platform)
    conn = connection(client, h, platform)
    assert (conn["status"], conn["mode"], conn["handle"]) == ("connected", "sandbox", HANDLES[platform])
    base = SHAPES[platform][0]
    assert base * 0.92 - 1 <= conn["followers"] <= base * 1.08 + 1
    assert result["connection"] == conn and result["followers"] == conn["followers"]
    assert result["fresh"] is True and result["posts_added"] == 3 and result["period_days"] == 30
    assert result["views"] > 0 and result["engagements"] > 0
    # 60 daily rows for this platform only
    assert count("daily_metrics", ws, platform=platform) == 60 and count("daily_metrics", ws) == 60
    posts = q("SELECT * FROM posts WHERE workspace_id = ? AND platform = ?", ws["id"], platform)
    assert len(posts) == 3
    assert {(p["status"], p["source"], p["metrics_source"]) for p in posts} == {("published", "seed", "sim")}


def test_sign_in_events_and_snapshot_are_labelled_synthetic(demo):
    client, h, ws = demo
    sign_in(client, h, "x")
    connected = q("SELECT * FROM events WHERE workspace_id = ? AND type = 'connected'", ws["id"])
    assert [(e["detail"], e["real"]) for e in connected] == [("Connected X (demo)", 0)]
    assert q("SELECT SUM(real) FROM events WHERE workspace_id = ?", ws["id"])[0][0] == 0
    snaps = q("SELECT * FROM metric_snapshots WHERE workspace_id = ? AND post_id IS NULL", ws["id"])
    assert [(s["source"], s["period_days"], s["platform"]) for s in snaps] == [("demo", 30, "x")]
    assert snaps[0]["followers"] == connection(client, h, "x")["followers"]
    status = next(s for s in client.get("/api/connections/harvest-status", headers=h).json()
                  if s["platform"] == "x")
    assert (status["connected"], status["last_source"], status["real_posts"]) == (True, "demo", 0)


def test_signing_in_again_adds_nothing_twice(demo):
    client, h, ws = demo
    first = sign_in(client, h)
    second = sign_in(client, h)
    assert (first["fresh"], second["fresh"]) == (True, False) and second["posts_added"] == 0
    assert count("daily_metrics", ws) == 60 and count("posts", ws) == 3
    assert count("events", ws, type="connected") == 1
    assert count("metric_snapshots", ws) == 2 and second["followers"] == first["followers"]


def test_the_numbers_are_the_same_for_the_same_brand(client):
    _, h1, ws1 = make_demo(client)
    _, h2, ws2 = make_demo(client)
    a, b = sign_in(client, h1, "linkedin"), sign_in(client, h2, "linkedin")
    assert a["followers"] == b["followers"]
    today = datetime.now(UTC).date().isoformat()  # today is partial and depends on the hour

    def series(ws):
        return q("SELECT day, views, engagements FROM daily_metrics WHERE workspace_id = ? AND day != ?"
                 " ORDER BY day", ws["id"], today)

    assert [tuple(r) for r in series(ws1)] == [tuple(r) for r in series(ws2)]
    assert len(series(ws1)) == 59


def test_another_brand_gets_its_own_handle(client):
    _, h, _ = make_demo(client, brand_name="Acme Co!")
    sign_in(client, h, "instagram")
    assert connection(client, h, "instagram")["handle"] == "@acmeco"


def test_generic_connect_in_a_demo_workspace_is_the_demo_sign_in(demo):
    client, h, ws = demo
    r = client.post("/api/connections/instagram", headers=h, json={"handle": "ignored"})
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["mode"], r.json()["handle"]) == ("connected", "sandbox", "@brewandbloom")
    assert count("daily_metrics", ws) == 60
    assert [e["detail"] for e in q("SELECT detail FROM events WHERE workspace_id = ? AND type = 'connected'",
                                   ws["id"])] == ["Connected Instagram (demo)"]


def test_unknown_platform_and_no_token(demo):
    client, h, _ = demo
    assert client.post("/api/connections/myspace/demo", headers=h).status_code == 404
    assert client.post("/api/connections/instagram/demo").status_code == 401


# ---------------------------------------------------------------- dashboard, simulated audience, insights

def test_dashboard_shows_the_synthetic_numbers_with_a_positive_change(demo):
    client, h, _ = demo
    sign_in(client, h, "instagram")
    d = client.get("/api/dashboard?days=30", headers=h).json()
    assert d["data_mode"] == "demo"
    assert [p["platform"] for p in d["by_platform"]] == ["instagram"]
    assert d["followers_total"] == connection(client, h, "instagram")["followers"]
    assert d["totals"]["views"] > 0 and d["change_pct"]["views"] > 0
    assert len(d["timeseries"]) >= 30


@pytest.mark.parametrize("platform", PLATFORMS)
def test_the_simulated_audience_does_not_dwarf_the_synthetic_history(demo, monkeypatch, platform):
    """The dashboard's 30 days must stay near what the sign-in read: only the fresh post may grow, and only a little.

    Regression: seeding the older posts with `last_tick_at` at their publish time made the first tick re-grow them from
    zero (a post's whole reach curve at once), a spike on today's bar and ~45% more views than the sign-in read.
    """
    client, h, _ = demo
    result = sign_in(client, h, platform)
    start = metrics._now()
    monkeypatch.setattr(metrics, "_now", lambda: start + timedelta(seconds=120))
    d = client.get("/api/dashboard?days=30", headers=h).json()
    assert result["views"] <= d["totals"]["views"] <= result["views"] * 1.1
    series = [row["views"] for row in sorted(d["timeseries"], key=lambda r: r["day"])]
    typical = sorted(series[:-1])[len(series) // 2]  # median of the earlier days
    assert series[-1] <= typical * 2  # today's bar is not a spike


def test_the_simulated_audience_grows_the_fresh_post(demo, monkeypatch):
    client, h, ws = demo
    sign_in(client, h, "instagram")
    newest = "SELECT views FROM posts WHERE workspace_id = ? ORDER BY published_at DESC LIMIT 1"
    assert q(newest, ws["id"])[0][0] == 0  # published a few minutes ago with no views yet
    start = metrics._now()
    monkeypatch.setattr(metrics, "_now", lambda: start + timedelta(seconds=60))
    client.get("/api/posts?status=published", headers=h)  # every feed read runs metrics.tick
    assert q(newest, ws["id"])[0][0] > 0
    assert q("SELECT SUM(real) FROM events WHERE workspace_id = ?", ws["id"])[0][0] == 0


def test_insights_call_every_demo_post_simulated(demo):
    client, h, _ = demo
    sign_in(client, h, "instagram")
    body = client.get("/api/insights?days=30", headers=h).json()
    assert body["sources"] == {"real": 0, "simulated": 3}


# ---------------------------------------------------------------- real-number writes are refused in a demo workspace

@pytest.mark.parametrize("source", SOURCES)
def test_ingest_is_refused_in_a_demo_workspace(demo, source):
    client, h, ws = demo
    before = tallies(ws)
    r = client.post("/api/metrics/ingest", headers=h,
                    json={"platform": "instagram", "source": source, "account": {"followers": 5}})
    assert r.status_code == 409 and "demo workspace" in r.json()["detail"]
    assert tallies(ws) == before
    assert connection(client, h, "instagram")["status"] == "disconnected"


def test_screenshot_and_profile_url_are_refused_and_spend_no_ai(demo):
    client, h, ws = demo
    before = tallies(ws)
    ai_before = q("SELECT COUNT(*) FROM ai_usage")[0][0]
    r = client.post("/api/connections/instagram/screenshot", headers=h, json=SHOT)
    assert r.status_code == 409 and "demo workspace" in r.json()["detail"]
    r = client.put("/api/connections/instagram/profile", headers=h,
                   json={"profile_url": "https://instagram.com/someone"})
    assert r.status_code == 409
    assert q("SELECT COUNT(*) FROM ai_usage")[0][0] == ai_before and tallies(ws) == before


# ---------------------------------------------------------------- the demo endpoint is refused everywhere else

def test_demo_sign_in_is_refused_in_real_and_sample_workspaces(client, auth):
    _, sample_h, sample_ws = auth
    real_ws = client.post("/api/workspaces", json={"real": True}).json()
    real_h = {"Authorization": f"Bearer {real_ws['token']}"}
    real_before, sample_before = tallies(real_ws), tallies(sample_ws)
    for h in (real_h, sample_h):
        r = client.post("/api/connections/instagram/demo", headers=h)
        assert r.status_code == 409 and "demo workspace" in r.json()["detail"]
    assert tallies(real_ws) == real_before and tallies(sample_ws) == sample_before
    assert connection(client, real_h, "instagram")["status"] == "disconnected"
