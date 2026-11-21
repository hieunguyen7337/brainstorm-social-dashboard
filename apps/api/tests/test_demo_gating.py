"""The demo workspace offers exactly the platforms the real app does (app/platforms.py): Instagram and LinkedIn are live,
X, TikTok, Facebook and Reddit are "coming soon" and cannot be signed in to, in the demo either."""

import sqlite3

import pytest

from app.config import settings

pytestmark = pytest.mark.gating  # the real live/upcoming config, not the all-live default of the other tests

UPCOMING = ["x", "tiktok", "facebook", "reddit"]


def q(sql, *args):
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


@pytest.fixture()
def demo(client):
    ws = client.post("/api/workspaces", json={"demo": True}).json()
    return client, {"Authorization": f"Bearer {ws['token']}"}, ws


def test_a_demo_workspace_lists_only_the_live_platforms(demo):
    client, h, _ = demo
    conns = client.get("/api/connections", headers=h).json()
    assert [(c["platform"], c["availability"], c["status"]) for c in conns] == [
        ("linkedin", "live", "disconnected"), ("instagram", "live", "disconnected")]


@pytest.mark.parametrize("platform", UPCOMING)
def test_the_demo_refuses_a_coming_soon_platform_and_writes_nothing(demo, platform):
    client, h, ws = demo
    r = client.post(f"/api/connections/{platform}/demo", headers=h)
    assert r.status_code == 422 and "coming soon to Pulse" in r.json()["detail"]
    assert q("SELECT COUNT(*) FROM daily_metrics WHERE workspace_id = ?", ws["id"])[0][0] == 0
    assert q("SELECT COUNT(*) FROM posts WHERE workspace_id = ?", ws["id"])[0][0] == 0
    assert q("SELECT COUNT(*) FROM connections WHERE workspace_id = ? AND platform = ? AND status = 'connected'",
             ws["id"], platform)[0][0] == 0


@pytest.mark.parametrize("platform", ["instagram", "linkedin"])
def test_the_demo_signs_in_to_a_live_platform(demo, platform):
    client, h, _ = demo
    r = client.post(f"/api/connections/{platform}/demo", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["connection"]["availability"] == "live"
    d = client.get("/api/dashboard?days=30", headers=h).json()
    assert [p["platform"] for p in d["by_platform"]] == [platform]
    assert d["data_mode"] == "demo" and d["totals"]["views"] > 0
