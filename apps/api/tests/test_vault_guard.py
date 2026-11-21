"""Zero-knowledge guard: neither the REST API nor the MCP agent can reach a saved login."""

import re

from app.mcp_server import INSTAGRAM_STEPS, LINKEDIN_STEPS

HDRS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}

SECRET_NAME = re.compile(r"password|passwd|secret_value", re.IGNORECASE)
TOOL_NAME = re.compile(r"vault|password|passwd|credential", re.IGNORECASE)


def rpc(c, method, params=None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return c.post("/mcp", json=body, headers=HDRS, follow_redirects=False)


def _walk(node, bad, path=""):
    if isinstance(node, dict):
        for key, val in node.items():
            if key == "properties" and isinstance(val, dict):
                for prop in val:
                    if SECRET_NAME.search(prop):
                        bad.append(f"{path}/properties/{prop}")
            is_param_name = key == "name" and isinstance(val, str) and path.endswith("parameters/*")
            if is_param_name and SECRET_NAME.search(val):
                bad.append(f"{path}:{val}")
            _walk(val, bad, f"{path}/{key}")
    elif isinstance(node, list):
        for item in node:
            _walk(item, bad, f"{path}/*")


def test_openapi_has_no_secret_fields(client):
    bad: list[str] = []
    _walk(client.app.openapi(), bad)
    assert not bad, bad


def test_no_vault_routes(client):
    paths = [getattr(r, "path", "") for r in client.app.routes]
    assert not [p for p in paths if p.startswith("/api/vault") or "vault" in p.lower()]


def test_mcp_tools_expose_no_credentials(client):
    r = rpc(client, "tools/list")
    assert r.status_code == 200
    tools = r.json()["result"]["tools"]
    assert tools
    for tool in tools:
        assert not TOOL_NAME.search(tool["name"]), tool["name"]
        for prop in (tool.get("inputSchema") or {}).get("properties", {}):
            assert not SECRET_NAME.search(prop), (tool["name"], prop)


def test_agent_steps_say_logins_live_in_vault():
    for steps in (LINKEDIN_STEPS, INSTAGRAM_STEPS):
        low = steps.lower()
        assert "vault" in low
        assert "cannot request" in low
