"""MCP harvest tools: set_profile_url, record_metrics, harvest_status, harvest_instructions."""

import contextlib
import json

import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

from app.mcp_server import INSTAGRAM_STEPS, LINKEDIN_STEPS, mount_mcp

HDRS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
GOOD = {"Authorization": "Bearer good"}
NEW_TOOLS = {"set_profile_url", "record_metrics", "harvest_status", "harvest_instructions"}

STATUS = [
    {
        "platform": "linkedin",
        "connected": True,
        "profile_url": "https://www.linkedin.com/in/me/",
        "last_harvest_at": "2026-11-20T01:00:00Z",
        "last_source": "claude_chrome",
        "followers": 3140,
        "real_posts": 2,
        "snapshots": 4,
    },
    {
        "platform": "instagram",
        "connected": True,
        "profile_url": None,
        "last_harvest_at": None,
        "last_source": None,
        "followers": None,
        "real_posts": 0,
        "snapshots": 0,
    },
]


def make_app() -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(app):
        async with app.state.mcp_lifespan():
            yield

    app = FastAPI(lifespan=lifespan)
    seen: list[tuple[str, str, str | None, dict | None]] = []
    app.state.seen = seen

    def check(authorization: str | None) -> None:
        if authorization != "Bearer good":
            raise HTTPException(status_code=401, detail="unknown workspace token")

    @app.put("/api/connections/{platform}/profile")
    def put_profile(platform: str, body: dict, authorization: str | None = Header(default=None)):
        seen.append(("PUT", f"/api/connections/{platform}/profile", authorization, body))
        check(authorization)
        return {"platform": platform, "profile_url": body["profile_url"], "status": "sandbox"}

    @app.post("/api/metrics/ingest")
    def ingest(body: dict, authorization: str | None = Header(default=None)):
        seen.append(("POST", "/api/metrics/ingest", authorization, body))
        check(authorization)
        return {
            "platform": body["platform"],
            "source": body["source"],
            "matched": 1,
            "created": len(body.get("posts", [])) - 1,
            "snapshots": len(body.get("posts", [])) + 1,
            "captured_at": "2026-11-20T01:00:00Z",
        }

    @app.get("/api/connections/harvest-status")
    def status(authorization: str | None = Header(default=None)):
        seen.append(("GET", "/api/connections/harvest-status", authorization, None))
        check(authorization)
        return STATUS

    mount_mcp(app)
    return app


def rpc(c, method, params=None, id_=1, headers=None, url="/mcp"):
    body = {"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}}
    return c.post(url, json=body, headers={**HDRS, **(headers or {})}, follow_redirects=False)


INIT = {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {"name": "t", "version": "1"},
}


def call(c, name, args, headers):
    r = rpc(c, "tools/call", {"name": name, "arguments": args}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["result"]


def text(res) -> str:
    return res["content"][0]["text"]


@pytest.fixture()
def c():
    app = make_app()
    with TestClient(app) as client:
        client.app_ = app
        yield client


def test_tools_list_has_harvest_tools(c):
    assert rpc(c, "initialize", INIT).status_code == 200
    r = rpc(c, "tools/list", id_=2)
    assert r.status_code == 200
    names = {t["name"] for t in r.json()["result"]["tools"]}
    assert NEW_TOOLS <= names


def test_set_profile_url_forwards_token_and_body(c):
    res = call(c, "set_profile_url", {"platform": "linkedin", "profile_url": " https://www.linkedin.com/in/me/ "}, GOOD)
    assert not res.get("isError"), text(res)
    assert c.app_.state.seen[-1] == (
        "PUT",
        "/api/connections/linkedin/profile",
        "Bearer good",
        {"profile_url": "https://www.linkedin.com/in/me/"},
    )
    data = json.loads(text(res))
    assert data["profile_url"] == "https://www.linkedin.com/in/me/"


def test_set_profile_url_rejects_empty_values(c):
    res = call(c, "set_profile_url", {"platform": "linkedin", "profile_url": "  "}, GOOD)
    assert res["isError"] is True
    assert "profile_url is empty" in text(res)
    res = call(c, "set_profile_url", {"platform": "", "profile_url": "https://www.instagram.com/me/"}, GOOD)
    assert res["isError"] is True
    assert "platform is empty" in text(res)
    assert c.app_.state.seen == []  # nothing reached the API


def test_record_metrics_forces_source_and_forwards_payload(c):
    posts = [
        {"external_id": "7123456789012345678", "content": "Launch", "views": 4210, "engagements": 188},
        {"external_id": "7123456789012345679", "views": 900, "engagements": 40, "clicks": 12},
    ]
    account = {"followers": 3140, "views": 18250, "engagements": 904}
    res = call(c, "record_metrics", {"platform": "LinkedIn", "posts": posts, "account": account}, GOOD)
    assert not res.get("isError"), text(res)
    method, path, auth, body = c.app_.state.seen[-1]
    assert (method, path, auth) == ("POST", "/api/metrics/ingest", "Bearer good")
    assert body == {"platform": "linkedin", "source": "claude_chrome", "account": account, "posts": posts}
    data = json.loads(text(res))
    assert data["source"] == "claude_chrome"
    assert data["matched"] == 1 and data["created"] == 1 and data["snapshots"] == 3


def test_record_metrics_cannot_override_source(c):
    # the tool has no `source` argument; the body always says claude_chrome
    call(c, "record_metrics", {"platform": "instagram", "posts": [], "source": "manual"}, GOOD)
    body = c.app_.state.seen[-1][3]
    assert body["source"] == "claude_chrome"


def test_record_metrics_defaults_to_empty_posts_and_account(c):
    res = call(c, "record_metrics", {"platform": "instagram"}, GOOD)
    assert not res.get("isError"), text(res)
    body = c.app_.state.seen[-1][3]
    assert body == {"platform": "instagram", "source": "claude_chrome", "account": {}, "posts": []}


def test_record_metrics_rejects_more_than_500_posts(c):
    posts = [{"external_id": str(i), "views": 1, "engagements": 0} for i in range(501)]
    res = call(c, "record_metrics", {"platform": "linkedin", "posts": posts}, GOOD)
    assert res["isError"] is True
    assert "501" in text(res) and "500" in text(res)
    assert c.app_.state.seen == []
    # exactly 500 is fine
    res = call(c, "record_metrics", {"platform": "linkedin", "posts": posts[:500]}, GOOD)
    assert not res.get("isError"), text(res)
    assert len(c.app_.state.seen[-1][3]["posts"]) == 500


def test_record_metrics_rejects_empty_platform(c):
    for bad in ("", "   "):
        res = call(c, "record_metrics", {"platform": bad, "posts": []}, GOOD)
        assert res["isError"] is True
        assert "platform is empty" in text(res)
    assert c.app_.state.seen == []


def test_harvest_status_returns_stub_json(c):
    res = call(c, "harvest_status", {}, GOOD)
    assert not res.get("isError"), text(res)
    assert json.loads(text(res)) == STATUS
    assert c.app_.state.seen[-1][:3] == ("GET", "/api/connections/harvest-status", "Bearer good")


@pytest.mark.parametrize("tool", ["set_profile_url", "record_metrics", "harvest_status"])
def test_bad_token_surfaces_unauthorized(c, tool):
    args = {
        "set_profile_url": {"platform": "linkedin", "profile_url": "https://www.linkedin.com/in/me/"},
        "record_metrics": {"platform": "linkedin"},
        "harvest_status": {},
    }[tool]
    res = call(c, tool, args, {"Authorization": "Bearer nope"})
    assert res["isError"] is True
    assert "Unauthorized" in text(res)


def test_missing_token_fails_cleanly_for_api_tools(c):
    res = call(c, "harvest_status", {}, {})
    assert res["isError"] is True
    assert "Missing Pulse token" in text(res)


@pytest.mark.parametrize("platform", ["linkedin", "LinkedIn", " LINKEDIN "])
def test_harvest_instructions_linkedin_needs_no_token(c, platform):
    res = call(c, "harvest_instructions", {"platform": platform}, {})
    assert not res.get("isError"), text(res)
    out = text(res)
    assert out == LINKEDIN_STEPS
    for needle in (
        "record_metrics",
        "set_profile_url",
        "harvest_status",
        "urn:li:activity",
        "recent-activity",
        "password",
        "at most 30 posts",
        "latest 30 posts",
        "analytics/creator/content",
    ):
        assert needle in out, needle
    assert c.app_.state.seen == []  # no REST call


@pytest.mark.parametrize("platform", ["instagram", "Instagram", "INSTAGRAM"])
def test_harvest_instructions_instagram_needs_no_token(c, platform):
    res = call(c, "harvest_instructions", {"platform": platform}, {})
    assert not res.get("isError"), text(res)
    out = text(res)
    assert out == INSTAGRAM_STEPS
    for needle in ("record_metrics", "/p/<code>/", "/reel/<code>/", "password", "at most 12", "latest 12"):
        assert needle in out, needle
    assert c.app_.state.seen == []


def test_harvest_instructions_rejects_other_platforms(c):
    res = call(c, "harvest_instructions", {"platform": "tiktok"}, {})
    assert res["isError"] is True
    msg = text(res)
    assert "tiktok" in msg and "linkedin" in msg and "instagram" in msg


def test_step_constants_state_the_safety_rules():
    for steps in (LINKEDIN_STEPS, INSTAGRAM_STEPS):
        assert "OWN" in steps
        assert "Never ask for, read or type a password" in steps
        assert "1-2 seconds" in steps
        assert "Never like, comment, follow" in steps
        assert "Integers only" in steps
        assert "1.2K is 1200" in steps
        assert "ONCE" in steps
        assert "tools/harvest" in steps


def test_real_app_has_harvest_tools(client):
    ws = client.post("/api/workspaces", json={})
    if ws.status_code != 200:
        pytest.skip("workspaces router not present in this checkout")
    headers = {"Authorization": f"Bearer {ws.json()['token']}"}
    r = rpc(client, "tools/list")
    assert r.status_code == 200
    assert NEW_TOOLS <= {t["name"] for t in r.json()["result"]["tools"]}

    # No token needed, and nothing touches the database.
    res = call(client, "harvest_instructions", {"platform": "linkedin"}, {})
    assert not res.get("isError"), text(res)
    assert "record_metrics" in text(res)

    res = call(client, "harvest_status", {}, headers)
    if res.get("isError") and "Not found" in text(res):
        pytest.skip("metrics router not present in this checkout")
    assert not res.get("isError"), text(res)
    status = json.loads(text(res))
    assert {s["platform"] for s in status} >= {"linkedin", "instagram"}

    res = call(
        client,
        "set_profile_url",
        {"platform": "linkedin", "profile_url": "https://www.linkedin.com/in/pulse-test/"},
        headers,
    )
    if res.get("isError") and "Not found" in text(res):
        pytest.skip("profile endpoint not present in this checkout")
    assert not res.get("isError"), text(res)
    assert json.loads(text(res))["profile_url"] == "https://www.linkedin.com/in/pulse-test/"
