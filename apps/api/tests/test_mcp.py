import contextlib
import json

import pytest
from fastapi import FastAPI, Header
from fastapi.testclient import TestClient

from app.mcp_server import mount_mcp

HDRS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
TOOLS = {
    "get_dashboard",
    "list_posts",
    "create_post",
    "publish_post",
    "generate_posts",
    "list_trends",
    "list_themes",
    "get_ai_usage",
    "set_autopilot",
    "run_autopilot",
    "set_profile_url",
    "record_metrics",
    "harvest_status",
    "harvest_instructions",
    "browser_status",
    "browser_open",
    "browser_back",
    "browser_screenshot",
    "browser_read_text",
    "browser_elements",
    "browser_click",
    "browser_type",
    "browser_press",
    "browser_scroll",
}


def make_app() -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(app):
        async with app.state.mcp_lifespan():
            yield

    app = FastAPI(lifespan=lifespan)
    seen: list[tuple[str | None, dict]] = []
    app.state.seen = seen

    @app.get("/api/dashboard")
    def dashboard(days: int = 30, authorization: str | None = Header(default=None)):
        seen.append((authorization, {"days": days}))
        if authorization != "Bearer good":
            from fastapi import HTTPException

            raise HTTPException(status_code=401, detail="unknown workspace token")
        return {
            "days": days,
            "totals": {"views": 10},
            "funnel": [],
            "by_platform": [],
            "top_posts": [{"id": str(i), "content": "x", "secret": "drop"} for i in range(5)],
        }

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


@pytest.fixture()
def c():
    app = make_app()
    with TestClient(app) as client:
        client.app_ = app
        yield client


def test_initialize_and_list_tools(c):
    r = rpc(c, "initialize", INIT)
    assert r.status_code == 200, r.text
    assert r.json()["result"]["serverInfo"]["name"] == "pulse"
    r = rpc(c, "tools/list", id_=2)
    assert r.status_code == 200
    assert {t["name"] for t in r.json()["result"]["tools"]} == TOOLS


def test_no_redirect_and_token_query(c):
    r = rpc(c, "tools/list")
    assert r.status_code == 200  # exactly /mcp, no 307
    r = rpc(c, "tools/call", {"name": "get_dashboard", "arguments": {}}, url="/mcp?token=good")
    assert r.json()["result"].get("isError") in (None, False)


def call(c, name, args, headers):
    r = rpc(c, "tools/call", {"name": name, "arguments": args}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["result"]


def test_bad_token_fails_cleanly(c):
    res = call(c, "get_dashboard", {}, {"Authorization": "Bearer nope"})
    assert res["isError"] is True
    assert "Unauthorized" in res["content"][0]["text"]


def test_missing_token_fails_cleanly(c):
    res = call(c, "get_dashboard", {}, {})
    assert res["isError"] is True
    assert "Missing Pulse token" in res["content"][0]["text"]


def test_get_dashboard_forwards_token_and_summarises(c):
    res = call(c, "get_dashboard", {"days": 7}, {"Authorization": "Bearer good"})
    assert not res.get("isError")
    assert c.app_.state.seen[-1] == ("Bearer good", {"days": 7})
    data = json.loads(res["content"][0]["text"])
    assert data["totals"] == {"views": 10}
    assert len(data["top_posts"]) == 3
    assert "secret" not in data["top_posts"][0]


def test_missing_endpoint_is_readable_error(c):
    res = call(c, "list_themes", {}, {"Authorization": "Bearer good"})
    assert res["isError"] is True
    assert "Not found" in res["content"][0]["text"]


def test_real_app_mounts_mcp(client):
    ws = client.post("/api/workspaces", json={})
    if ws.status_code != 200:
        pytest.skip("workspaces router not present in this checkout")
    headers = {"Authorization": f"Bearer {ws.json()['token']}"}
    r = rpc(client, "tools/list")
    assert r.status_code == 200
    assert {t["name"] for t in r.json()["result"]["tools"]} == TOOLS
    res = call(client, "list_posts", {"limit": 3}, headers)
    if res.get("isError"):
        pytest.skip("posts router not present in this checkout")
    assert len(json.loads(res["content"][0]["text"])) <= 3
