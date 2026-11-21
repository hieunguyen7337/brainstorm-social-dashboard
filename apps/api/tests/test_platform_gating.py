"""Only Instagram and LinkedIn are live; X, TikTok, Facebook and Reddit are "coming soon" (app/platforms.py)."""

import pytest

from app import platforms
from app.db import get_db  # noqa: F401  (ensures app.db imports cleanly with the config)
from tests.test_ai import ai_variants, fake_model
from tests.test_mcp import HDRS

pytestmark = pytest.mark.gating

UPCOMING = ["x", "tiktok", "facebook", "reddit"]


def test_config():
    assert platforms.LIVE_PLATFORMS == ("linkedin", "instagram")
    assert platforms.UPCOMING_PLATFORMS == tuple(UPCOMING)
    assert platforms.coming_soon_reason("x") == "X is coming soon to Pulse"


@pytest.mark.parametrize("p", UPCOMING)
def test_generate_refuses_upcoming(auth, monkeypatch, p):
    client, h, _ = auth
    calls = fake_model(monkeypatch, parsed=ai_variants("linkedin"))
    r = client.post("/api/generate", json={"platforms": ["linkedin", p]}, headers=h)
    assert r.status_code == 422
    assert "coming soon to Pulse" in r.json()["detail"]
    assert calls == []  # no model call, no posts
    assert client.post("/api/generate", json={"platforms": ["linkedin"]}, headers=h).status_code == 200


def test_create_schedule_publish_refused(auth):
    client, h, _ = auth
    r = client.post("/api/posts", json={"platform": "x", "content": "hi"}, headers=h)
    assert r.status_code == 422 and r.json()["detail"] == "X is coming soon to Pulse"
    ok = client.post("/api/posts", json={"platform": "linkedin", "content": "hi"}, headers=h).json()
    assert client.post(f"/api/posts/{ok['id']}/publish", headers=h).status_code == 200


def test_old_rows_for_upcoming_platforms_do_not_crash_or_publish(auth):
    from app.db import connect

    client, h, ws = auth
    db = connect()
    try:
        db.execute("INSERT INTO posts (id, workspace_id, platform, content, hashtags, media_prompt, link_code,"
                   " status, source, quality, created_at) VALUES ('p_old', ?, 'x', 'old', '[]', '', 'zzzzzz',"
                   " 'scheduled', 'seed', 0.5, '2026-01-01T00:00:00')", (ws["id"],))
        db.commit()
    finally:
        db.close()
    assert client.post("/api/posts/p_old/publish", headers=h).status_code == 422
    assert client.patch("/api/posts/p_old", json={"status": "scheduled"}, headers=h).status_code == 422
    assert all(p["platform"] in ("linkedin", "instagram") for p in client.get("/api/posts", headers=h).json())
    assert [p["id"] for p in client.get("/api/posts?platform=x", headers=h).json()] == ["p_old"]
    assert client.get("/api/dashboard", headers=h).status_code == 200


def test_seed_dashboard_connections_exclude_upcoming(auth):
    client, h, _ = auth
    conns = client.get("/api/connections", headers=h).json()
    assert [c["platform"] for c in conns] == ["linkedin", "instagram"]
    assert all(c["availability"] == "live" for c in conns)
    d = client.get("/api/dashboard", headers=h).json()
    assert {p["platform"] for p in d["by_platform"]} == {"linkedin", "instagram"}
    assert d["totals"]["views"] == sum(p["views"] for p in d["by_platform"])
    assert client.get("/api/dashboard?platform=x", headers=h).status_code == 422
    assert client.post("/api/connections/x", json={"handle": "a"}, headers=h).status_code == 422


def test_autopilot_skips_upcoming(auth, monkeypatch):
    client, h, _ = auth
    fake_model(monkeypatch, parsed=ai_variants("linkedin"))
    client.put("/api/autopilot", json={"enabled": False, "platforms": ["x", "linkedin"],
                                       "require_approval": True, "interval_min": 30}, headers=h)
    r = client.post("/api/autopilot/run", headers=h)
    assert r.status_code == 200, r.text
    assert {p["platform"] for p in r.json()["posts"]} <= {"linkedin"}


def test_trends_do_not_fetch_or_rank_reddit(auth):
    client, h, _ = auth
    assert all(t["source"] != "reddit" for t in client.get("/api/trends", headers=h).json())


def test_mcp_tools_refuse_upcoming(auth):
    client, h, _ = auth
    hdr = {**HDRS, **h}

    def call(name, args):
        r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                      "params": {"name": name, "arguments": args}}, headers=hdr)
        assert r.status_code == 200, r.text
        return r.json()["result"]

    for name, args in (("create_post", {"platform": "x", "content": "hello"}),
                       ("generate_posts", {"platforms": ["x"]})):
        res = call(name, args)
        assert res["isError"] is True
        assert "X is coming soon to Pulse" in res["content"][0]["text"]
