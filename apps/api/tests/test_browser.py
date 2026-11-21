"""Remote phone browser: the command queue (app/routes/browser.py) and its MCP tools (app/mcp_browser.py)."""

import base64
import json
import threading
import time

import pytest

from app.routes import browser as browser_route

HDRS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
FAKE_JPEG = base64.b64encode(b"\xff\xd8\xff\xe0 not really a jpeg \xff\xd9").decode()


def rpc(c, method, params=None, headers=None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    r = c.post("/mcp", json=body, headers={**HDRS, **(headers or {})})
    assert r.status_code == 200, r.text
    return r.json()["result"]


def tool(c, name, args, headers):
    return rpc(c, "tools/call", {"name": name, "arguments": args}, headers)


def connect_phone(c, h):
    r = c.get("/api/browser/next", params={"wait": 0}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json() == {"command": None}


def phone_answers(c, h, answer, seen):
    """A fake phone: take one command (long-poll) and post `answer(command)` back."""

    def run():
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            r = c.get("/api/browser/next", params={"wait": 2}, headers=h)
            cmd = r.json()["command"]
            if cmd:
                seen.append(cmd)
                c.post(f"/api/browser/results/{cmd['id']}", json=answer(cmd), headers=h)
                return

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


# ---- queue routes ---------------------------------------------------------------------------------------------------


def test_needs_auth(client):
    assert client.get("/api/browser/status").status_code == 401
    assert client.get("/api/browser/next").status_code == 401


def test_refuses_commands_until_a_phone_polls(auth):
    c, h, _ = auth
    assert c.get("/api/browser/status", headers=h).json()["connected"] is False
    r = c.post("/api/browser/commands", json={"action": "screenshot"}, headers=h)
    assert r.status_code == 409
    assert "Let Claude use your phone's browser" in r.json()["detail"]
    connect_phone(c, h)
    assert c.get("/api/browser/status", headers=h).json()["connected"] is True


def test_round_trip(auth):
    c, h, _ = auth
    connect_phone(c, h)
    r = c.post("/api/browser/commands", json={"action": "open", "args": {"url": "instagram.com"}}, headers=h)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    assert r.json()["status"] == "pending"

    cmd = c.get("/api/browser/next", params={"wait": 0}, headers=h).json()["command"]
    assert cmd == {"id": cid, "action": "open", "args": {"url": "https://instagram.com"}}
    assert c.get(f"/api/browser/commands/{cid}", headers=h).json()["status"] == "sent"
    # Taken once only.
    assert c.get("/api/browser/next", params={"wait": 0}, headers=h).json()["command"] is None

    res = {"ok": True, "url": "https://www.instagram.com/", "title": "Instagram"}
    assert c.post(f"/api/browser/results/{cid}", json=res, headers=h).json() == {"ok": True}
    done = c.get(f"/api/browser/commands/{cid}", headers=h).json()
    assert done["status"] == "done"
    assert done["result"] == {"ok": True, "url": "https://www.instagram.com/", "title": "Instagram"}
    assert c.get("/api/browser/status", headers=h).json()["url"] == "https://www.instagram.com/"
    # A second answer is ignored.
    again = c.post(f"/api/browser/results/{cid}", json={"ok": False}, headers=h).json()
    assert again["duplicate"] is True
    assert c.get(f"/api/browser/commands/{cid}", headers=h).json()["result"]["ok"] is True


@pytest.mark.parametrize(
    "action,args",
    [
        ("open", {"url": "http://example.com"}),
        ("open", {"url": "javascript:alert(1)"}),
        ("open", {"url": "file:///etc/passwd"}),
        ("open", {}),
        ("eval", {"js": "1"}),
        ("click", {}),
        ("click", {"x": 10}),
        ("click", {"x": "a", "y": 2}),
        ("type", {"text": ""}),
        ("type", {"text": "x" * 6000}),
        ("press", {"key": "F12"}),
        ("scroll", {"dy": "lots"}),
    ],
)
def test_validation(auth, action, args):
    c, h, _ = auth
    connect_phone(c, h)
    r = c.post("/api/browser/commands", json={"action": action, "args": args}, headers=h)
    assert r.status_code == 422, (action, args, r.text)


def test_clean_args(auth):
    c, h, _ = auth
    connect_phone(c, h)
    cases = [
        ("click", {"text": "Post", "junk": 1}, {"text": "Post"}),
        ("click", {"x": 10, "y": 20.5}, {"x": 10.0, "y": 20.5}),
        ("type", {"text": "hi", "selector": "textarea"}, {"text": "hi", "clear": False, "selector": "textarea"}),
        ("press", {"key": "Enter"}, {"key": "Enter"}),
        ("scroll", {"dy": -300}, {"dy": -300.0, "dx": 0.0}),
        ("screenshot", {"anything": 1}, {}),
    ]
    for action, args, want in cases:
        assert c.post("/api/browser/commands", json={"action": action, "args": args}, headers=h).status_code == 200
        cmd = c.get("/api/browser/next", params={"wait": 0}, headers=h).json()["command"]
        assert (cmd["action"], cmd["args"]) == (action, want)


def test_workspaces_are_isolated(auth):
    c, h, _ = auth
    other = {"Authorization": f"Bearer {c.post('/api/workspaces', json={}).json()['token']}"}
    connect_phone(c, h)
    connect_phone(c, other)
    cid = c.post("/api/browser/commands", json={"action": "read_text"}, headers=h).json()["id"]
    assert c.get(f"/api/browser/commands/{cid}", headers=other).status_code == 404
    assert c.get("/api/browser/next", params={"wait": 0}, headers=other).json()["command"] is None
    assert c.post(f"/api/browser/results/{cid}", json={"ok": True}, headers=other).status_code == 404
    assert c.get("/api/browser/next", params={"wait": 0}, headers=h).json()["command"]["id"] == cid


def test_stop_disconnects_and_fails_queued(auth):
    c, h, _ = auth
    connect_phone(c, h)
    cid = c.post("/api/browser/commands", json={"action": "screenshot"}, headers=h).json()["id"]
    r = c.post("/api/browser/session", json={"active": False}, headers=h)
    assert r.json()["connected"] is False
    res = c.get(f"/api/browser/commands/{cid}", headers=h).json()
    assert res["status"] == "done" and res["result"]["ok"] is False
    assert "stopped" in res["result"]["error"]
    assert c.post("/api/browser/commands", json={"action": "screenshot"}, headers=h).status_code == 409


def test_unanswered_commands_expire(auth, monkeypatch):
    c, h, _ = auth
    connect_phone(c, h)
    monkeypatch.setattr(browser_route, "PENDING_TTL_S", 0.0)
    cid = c.post("/api/browser/commands", json={"action": "screenshot"}, headers=h).json()["id"]
    time.sleep(0.01)
    res = c.get(f"/api/browser/commands/{cid}", headers=h).json()
    assert res["status"] == "done"
    assert "did not pick" in res["result"]["error"]


def test_result_wait_returns_as_soon_as_the_phone_answers(auth):
    c, h, _ = auth
    connect_phone(c, h)
    cid = c.post("/api/browser/commands", json={"action": "read_text"}, headers=h).json()["id"]
    seen: list = []
    phone_answers(c, h, lambda cmd: {"ok": True, "text": "Followers 1,204"}, seen)
    start = time.monotonic()
    res = c.get(f"/api/browser/commands/{cid}", params={"wait": 8}, headers=h).json()
    assert res["status"] == "done"
    assert res["result"]["text"] == "Followers 1,204"
    assert time.monotonic() - start < 6
    assert seen[0]["id"] == cid


def test_oversized_text_is_capped(auth):
    c, h, _ = auth
    connect_phone(c, h)
    cid = c.post("/api/browser/commands", json={"action": "read_text"}, headers=h).json()["id"]
    c.get("/api/browser/next", params={"wait": 0}, headers=h)
    c.post(f"/api/browser/results/{cid}", json={"ok": True, "text": "a" * 50_000}, headers=h)
    res = c.get(f"/api/browser/commands/{cid}", headers=h).json()
    assert len(res["result"]["text"]) == browser_route.MAX_TEXT


# ---- MCP tools ------------------------------------------------------------------------------------------------------


def test_mcp_lists_browser_tools(client):
    names = {t["name"] for t in rpc(client, "tools/list")["tools"]}
    assert {"browser_status", "browser_open", "browser_screenshot", "browser_click", "browser_type"} <= names


def test_mcp_without_phone_says_how_to_connect(auth):
    c, h, _ = auth
    res = tool(c, "browser_open", {"url": "https://www.linkedin.com/feed/"}, h)
    assert res["isError"] is True
    assert "No phone is connected" in res["content"][0]["text"]
    status = json.loads(tool(c, "browser_status", {}, h)["content"][0]["text"])
    assert status["connected"] is False


def test_mcp_screenshot_returns_an_image(auth):
    c, h, _ = auth
    connect_phone(c, h)
    seen: list = []
    answer = {"ok": True, "url": "https://www.instagram.com/", "image_jpeg_base64": FAKE_JPEG, "width": 720,
              "height": 1400}
    phone_answers(c, h, lambda cmd: answer, seen)
    res = tool(c, "browser_screenshot", {}, h)
    assert not res.get("isError"), res
    kinds = [b["type"] for b in res["content"]]
    assert kinds == ["text", "image"]
    assert res["content"][1]["mimeType"] == "image/jpeg"
    assert res["content"][1]["data"] == FAKE_JPEG
    info = json.loads(res["content"][0]["text"])
    assert info["url"] == "https://www.instagram.com/" and info["width"] == 720
    assert seen[0]["action"] == "screenshot"


def test_mcp_click_forwards_args_and_reports_phone_errors(auth):
    c, h, _ = auth
    connect_phone(c, h)
    seen: list = []
    phone_answers(c, h, lambda cmd: {"ok": False, "error": "No element with that text"}, seen)
    res = tool(c, "browser_click", {"text": "Post"}, h)
    assert res["isError"] is True
    assert "No element with that text" in res["content"][0]["text"]
    assert seen[0]["args"] == {"text": "Post"}


def test_mcp_type_and_read_text(auth):
    c, h, _ = auth
    connect_phone(c, h)
    seen: list = []
    phone_answers(c, h, lambda cmd: {"ok": True, "text": "TEXTAREA", "url": "https://x.com/compose"}, seen)
    res = tool(c, "browser_type", {"text": "Hello world", "selector": "textarea"}, h)
    assert not res.get("isError"), res
    assert json.loads(res["content"][0]["text"])["typed_into"] == "TEXTAREA"
    assert seen[0]["args"] == {"text": "Hello world", "clear": False, "selector": "textarea"}

    phone_answers(c, h, lambda cmd: {"ok": True, "text": "1,204 followers", "title": "Me"}, seen)
    res = tool(c, "browser_read_text", {}, h)
    assert json.loads(res["content"][0]["text"])["text"] == "1,204 followers"
