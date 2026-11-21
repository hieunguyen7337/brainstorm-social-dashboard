"""Zero-knowledge guard: neither the REST API nor the MCP agent can reach a saved login (docs/VAULT.md).

Covers every OpenAPI operation, every route hidden from the schema and every MCP tool (browser_* included): no
credential-like field is accepted, stored or returned, every workspace route needs the bearer token, and the server
log never prints the bearer token.
"""

import logging
import re
import socket
import threading
import time

import httpx

from app.mcp_server import INSTAGRAM_STEPS, LINKEDIN_STEPS

HDRS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}

SECRET_NAME = re.compile(r"password|passwd|secret_value", re.IGNORECASE)
TOOL_NAME = re.compile(r"vault|password|passwd|credential", re.IGNORECASE)
# Anything that names a login, a one-time code, a cookie, a session or a token.
CRED_NAME = re.compile(
    r"password|passwd|passcode|pass_code|otp|one_?time|totp|mfa|2fa|cookie|session|secret|credential|csrf"
    r"|bearer|token|api_?key|vault|login",
    re.IGNORECASE,
)

FAKE_PASSWORD = "hunter2-fake"
FAKE_BEARER = "fake-bearer-hunter2"

# The only credential-like names allowed, each the app's own workspace bearer token (or no credential at all).
ALLOWED_NAMES = {
    ("POST /api/workspaces", "response", "token"): "sign-up returns the new workspace's own bearer token",
    ("GET /room/{code}", "query", "token"): "presenter link: the owner's own bearer token, docs/ROOM.md",
}
ALLOWED_PATHS = {"/api/browser/session": "phone browser heartbeat {active, url}: no credential"}

# Operations that work without the bearer token, on purpose. Everything else must answer 401 without it.
PUBLIC = {
    "GET /api/health": "health check",
    "GET /download/android": "APK redirect",
    "GET /download/android/qr.svg": "install QR image of the public APK url: no input, no token",
    "GET /get": "big-screen install page: no input, no token",
    "POST /api/workspaces": "sign-up: creates the workspace and its token",
    "GET /r/{code}": "tracked link click (counts a click on the post)",
    "GET /l/{code}": "tracked link landing page",
    "POST /api/links/{code}/convert": "tracked link conversion (counts a conversion)",
    "POST /api/billing/webhook": "Stripe webhook, checked by its stripe-signature",
    "GET /api/billing/demo-checkout": "demo checkout page, checked by an HMAC sig",
    "POST /api/billing/demo-checkout": "demo checkout confirm, checked by an HMAC sig",
    "GET /api/rooms/{code}": "room audience",
    "POST /api/rooms/{code}/vote": "room audience vote (anonymous voter cookie)",
    "POST /api/rooms/{code}/onboard": "room audience onboard (anonymous voter cookie)",
    "GET /api/rooms/{code}/stats": "room audience",
    "GET /v/{code}": "room phone page (counts a scan)",
    "POST /v/{code}/vote": "room no-JS vote",
    "POST /v/{code}/onboard": "room no-JS onboard",
    "GET /room/{code}": "big screen; presenter controls only for a valid ?token=",
}

# Routes outside the OpenAPI schema. /mcp checks the token on every tool call (test below).
HIDDEN_ROUTES = {"/mcp", "/{path:path}", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}

# Request bodies that accept keys the schema does not name. Each is validated or handled by its owner unit.
FREE_FORM = {
    "POST /api/browser/commands": "args: browser.validate keeps only the known keys per action",
    "POST /api/browser/results/{command_id}": "data: what the phone read (elements list)",
    "POST /api/autoread/trace": "app, events: sign-in diagnostics printed to the server log",
}

BROWSER_TOOLS = {
    "browser_status", "browser_open", "browser_back", "browser_screenshot", "browser_read_text",
    "browser_elements", "browser_click", "browser_type", "browser_press", "browser_scroll",
}
NO_TOKEN_TOOLS = {"harvest_instructions": "static instructions text, reads and writes nothing"}


def rpc(c, method, params=None, headers=None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return c.post("/mcp", json=body, headers={**HDRS, **(headers or {})}, follow_redirects=False)


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


def _operations(spec):
    for path, ops in spec["paths"].items():
        for method, op in ops.items():
            yield f"{method.upper()} {path}", path, method.upper(), op


def _schema_names(spec, node, out, seen):
    """Every property name reachable from `node`, following $refs."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if ref:
            if ref not in seen:
                seen.add(ref)
                _schema_names(spec, spec["components"]["schemas"][ref.rsplit("/", 1)[1]], out, seen)
            return
        for key, val in node.items():
            if key == "properties" and isinstance(val, dict):
                out.update(val)
            _schema_names(spec, val, out, seen)
    elif isinstance(node, list):
        for item in node:
            _schema_names(spec, item, out, seen)


def _free_form(spec, node, seen):
    """True when `node` accepts keys its schema does not name (dict[str, Any], Any, extra="allow")."""
    if not isinstance(node, dict):
        return False
    if "$ref" in node:
        ref = node["$ref"]
        if ref in seen:
            return False
        seen.add(ref)
        return _free_form(spec, spec["components"]["schemas"][ref.rsplit("/", 1)[1]], seen)
    for key in ("anyOf", "oneOf", "allOf"):
        if key in node:
            return any(_free_form(spec, sub, seen) for sub in node[key])
    kind = node.get("type")
    if kind is None and not ({"enum", "const"} & node.keys()):
        return True  # Any
    if kind == "object" or "properties" in node:
        if node.get("additionalProperties") or "properties" not in node:
            return True
        return any(_free_form(spec, sub, seen) for sub in node["properties"].values())
    if kind == "array":
        return _free_form(spec, node.get("items") or {}, seen)
    return False


def _bodies(op):
    return [c.get("schema", {}) for c in (op.get("requestBody") or {}).get("content", {}).values()]


def _responses(op):
    return [c.get("schema", {}) for r in op.get("responses", {}).values() for c in r.get("content", {}).values()]


def _fill(path):
    return re.sub(r"\{[^}]+\}", "zz-fake", path)


def _tools(client):
    r = rpc(client, "tools/list")
    assert r.status_code == 200
    return r.json()["result"]["tools"]


def _dummy_args(tool):
    schema = tool.get("inputSchema") or {}
    args = {}
    for name in schema.get("required", []):
        prop = schema["properties"][name]
        kinds = [prop.get("type")] + [s.get("type") for s in prop.get("anyOf", [])]
        if "string" in kinds:
            args[name] = "https://example.com/" if name == "url" else "linkedin" if name == "platform" else "x"
        elif "integer" in kinds or "number" in kinds:
            args[name] = 1
        elif "boolean" in kinds:
            args[name] = False
        elif "array" in kinds:
            args[name] = []
        else:
            args[name] = {}
    return args


# ---- existing guards ------------------------------------------------------------------------------------------------


def test_openapi_has_no_secret_fields(client):
    bad: list[str] = []
    _walk(client.app.openapi(), bad)
    assert not bad, bad


def test_no_vault_routes(client):
    paths = [getattr(r, "path", "") for r in client.app.routes]
    assert not [p for p in paths if p.startswith("/api/vault") or "vault" in p.lower()]


def test_mcp_tools_expose_no_credentials(client):
    tools = _tools(client)
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


# ---- every OpenAPI operation ----------------------------------------------------------------------------------------


def test_every_openapi_operation_has_no_credential_like_names(client):
    """Paths, parameters, request and response fields of every operation; the only allowed ones are the bearer."""
    spec = client.app.openapi()
    bad, used = [], set()
    for key, path, _method, op in _operations(spec):
        if CRED_NAME.search(path) and path not in ALLOWED_PATHS:
            bad.append(f"{key}: path")
        found = [(p["in"], p["name"]) for p in op.get("parameters", []) if p["name"].lower() != "authorization"]
        for where, schemas in (("request", _bodies(op)), ("response", _responses(op))):
            names: set[str] = set()
            for schema in schemas:
                _schema_names(spec, schema, names, set())
            found += [(where, n) for n in names]
        for where, name in found:
            if CRED_NAME.search(name):
                if (key, where, name) in ALLOWED_NAMES:
                    used.add((key, where, name))
                else:
                    bad.append(f"{key}: {where} {name}")
    assert not bad, bad
    assert used == set(ALLOWED_NAMES), f"stale allowlist entries: {set(ALLOWED_NAMES) - used}"


def test_only_the_known_bodies_accept_unnamed_keys(client):
    """A body that takes arbitrary keys could carry a cookie or a password; each one is listed and owned."""
    spec = client.app.openapi()
    free = {key for key, _p, _m, op in _operations(spec) if any(_free_form(spec, s, set()) for s in _bodies(op))}
    assert free == set(FREE_FORM), {"new": free - set(FREE_FORM), "gone": set(FREE_FORM) - free}


def test_every_non_public_operation_needs_the_bearer_header(auth):
    """Without `Authorization: Bearer`, and with the real token only in ?token=, every workspace route is 401."""
    client, _headers, ws = auth
    spec = client.app.openapi()
    keys = set()
    for key, path, method, _op in _operations(spec):
        keys.add(key)
        if key in PUBLIC:
            continue
        url = _fill(path)
        for params in ({}, {"token": ws["token"]}):
            r = client.request(method, url, params=params, json={})
            assert r.status_code == 401, (key, params and "?token=", r.status_code, r.text[:200])
    assert set(PUBLIC) <= keys, f"stale PUBLIC entries: {set(PUBLIC) - keys}"


def test_public_operations_need_no_token_and_return_none(auth):
    """The public routes do not hand out the workspace token (sign-up excepted: it creates it)."""
    client, _headers, ws = auth
    room = client.post("/api/rooms", json={}, headers=_headers)
    code = room.json()["code"] if room.status_code == 200 else "zz-fake"
    spec = client.app.openapi()
    for key, path, method, _op in _operations(spec):
        if key not in PUBLIC or key == "POST /api/workspaces":
            continue
        url = _fill(path.replace("{code}", code))
        r = client.request(method, url, follow_redirects=False)
        assert r.status_code != 401, key
        assert ws["token"] not in r.text, key


def test_no_hidden_routes_besides_mcp_and_the_web_app(client):
    """A route left out of the schema would escape the checks above."""
    hidden = {getattr(r, "path", "") for r in client.app.routes if not getattr(r, "include_in_schema", True)}
    hidden |= {getattr(r, "path", "") for r in client.app.routes if getattr(r, "path", "") == "/mcp"}
    assert hidden == HIDDEN_ROUTES, hidden ^ HIDDEN_ROUTES


# ---- every MCP tool -------------------------------------------------------------------------------------------------


def test_every_mcp_tool_and_argument_is_credential_free(client):
    tools = _tools(client)
    names = {t["name"] for t in tools}
    assert BROWSER_TOOLS <= names, BROWSER_TOOLS - names
    for tool in tools:
        assert not CRED_NAME.search(tool["name"]), tool["name"]
        props: set[str] = set()
        _schema_names({"components": {"schemas": tool["inputSchema"].get("$defs", {})}}, tool["inputSchema"],
                      props, set())
        bad = [p for p in props if CRED_NAME.search(p)]
        assert not bad, (tool["name"], bad)


def test_every_mcp_tool_needs_the_bearer_token(client):
    """Every tool except the static instructions refuses before it reaches the API (or the phone)."""
    for tool in _tools(client):
        if tool["name"] in NO_TOKEN_TOOLS:
            continue
        for headers in ({}, {"Authorization": f"Bearer {FAKE_BEARER}"}):
            r = rpc(client, "tools/call", {"name": tool["name"], "arguments": _dummy_args(tool)}, headers)
            assert r.status_code == 200, (tool["name"], r.text[:200])
            res = r.json()["result"]
            text = " ".join(c.get("text", "") for c in res["content"])
            assert res.get("isError"), (tool["name"], headers, text[:200])
            assert ("Missing Pulse token" if not headers else "Unauthorized") in text, (tool["name"], text[:200])


def test_record_metrics_drops_credential_fields(auth, tmp_path):
    """The agent sends a password, a cookie and a session token with real numbers: none is stored or returned."""
    client, headers, _ws = auth
    secrets_sent = [FAKE_PASSWORD, "sessionid=fake-cookie-value", "fake-otp-123456"]
    args = {
        "platform": "linkedin",
        "account": {"followers": 10, "password": FAKE_PASSWORD, "cookie": secrets_sent[1]},
        "posts": [{"external_id": "7000000000000000001", "content": "Real post", "views": 5, "engagements": 1,
                   "session_token": secrets_sent[1], "otp": secrets_sent[2]}],
    }
    r = rpc(client, "tools/call", {"name": "record_metrics", "arguments": args}, headers)
    res = r.json()["result"]
    assert not res.get("isError"), res
    seen = r.text
    for tool in ("harvest_status", "list_posts"):
        seen += rpc(client, "tools/call", {"name": tool, "arguments": {}}, headers).text
    seen += client.get("/api/metrics/snapshots", headers=headers).text
    for value in secrets_sent:
        assert value not in seen
    db = b"".join(path.read_bytes() for path in tmp_path.glob("test.db*"))
    assert db
    for value in secrets_sent:
        assert value.encode() not in db, value


def test_profile_url_with_a_credential_query_is_refused(auth):
    """A profile URL copied from a sign-in redirect would hand its session token to every bearer holder."""
    client, headers, _ws = auth
    for url in (f"https://www.linkedin.com/in/jane/?session_token={FAKE_PASSWORD}",
                f"https://www.instagram.com/jane/?csrftoken={FAKE_PASSWORD}",
                f"https://www.linkedin.com/in/jane/?trk=x&password={FAKE_PASSWORD}"):
        platform = "instagram" if "instagram" in url else "linkedin"
        r = client.put(f"/api/connections/{platform}/profile", json={"profile_url": url}, headers=headers)
        assert r.status_code == 422, (url, r.status_code)
        res = rpc(client, "tools/call", {"name": "set_profile_url",
                                         "arguments": {"platform": platform, "profile_url": url}}, headers)
        assert res.json()["result"].get("isError"), url
    ok = client.put("/api/connections/linkedin/profile", headers=headers,
                    json={"profile_url": "https://www.linkedin.com/in/jane/?trk=public_profile"})
    assert ok.status_code == 200 and ok.json()["profile_url"].endswith("?trk=public_profile"), ok.text
    assert FAKE_PASSWORD not in rpc(client, "tools/call", {"name": "harvest_status", "arguments": {}}, headers).text


def test_ingested_post_url_drops_credential_query(auth, tmp_path):
    """A post URL with a session token or a one-time code is stored and shown without it."""
    client, headers, _ws = auth
    url = (f"https://www.instagram.com/p/C9fakeCode/?img_index=1&sessionid={FAKE_PASSWORD}"
           f"&otp=fake-otp-123456&oauth_token={FAKE_BEARER}")
    args = {"platform": "instagram", "posts": [{"external_id": "C9fakeCode", "url": url, "views": 4, "engagements": 1}]}
    res = rpc(client, "tools/call", {"name": "record_metrics", "arguments": args}, headers).json()["result"]
    assert not res.get("isError"), res
    seen = client.get("/api/posts", headers=headers, params={"platform": "instagram", "limit": 200}).text
    seen += rpc(client, "tools/call", {"name": "list_posts", "arguments": {"limit": 200}}, headers).text
    db = b"".join(path.read_bytes() for path in tmp_path.glob("test.db*"))
    assert b"img_index=1" in db
    for value in (FAKE_PASSWORD, FAKE_BEARER, "fake-otp-123456"):
        assert value not in seen and value.encode() not in db, value


# ---- the server log -------------------------------------------------------------------------------------------------


def test_access_log_redacts_query_tokens(client):
    """uvicorn prints `"GET /mcp?token=..."` for every request of a header-less MCP client: the value is redacted."""
    from uvicorn.logging import AccessFormatter

    from app.redact import RedactQuery

    assert any(isinstance(f, RedactQuery) for f in logging.getLogger("uvicorn.access").filters)
    lines: list[str] = []

    class Keep(logging.Handler):
        def emit(self, record):
            lines.append(self.format(record))

    handler = Keep()
    handler.setFormatter(AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False))
    logger = logging.getLogger("uvicorn.access")
    level, disabled = logger.level, logger.disabled
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.disabled = False
    try:
        for path in (f"/mcp?token={FAKE_BEARER}", f"/room/ABC123?x=1&token={FAKE_BEARER}",
                     f"/api/x?password={FAKE_PASSWORD}&otp=123456&sessionid=abc",
                     f"/api/y?csrftoken={FAKE_PASSWORD}&session_token={FAKE_BEARER}&access_token={FAKE_BEARER}"):
            logger.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET", path, "1.1", 200)
    finally:
        logger.removeHandler(handler)
        logger.setLevel(level)
        logger.disabled = disabled
    out = "\n".join(lines)
    assert FAKE_BEARER not in out and FAKE_PASSWORD not in out and "123456" not in out, out
    assert "/mcp?token=[redacted]" in out and "/room/ABC123?x=1&token=[redacted]" in out, out


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_live_server_log_never_prints_the_bearer_or_a_password(tmp_path, monkeypatch, capfd):
    """A real uvicorn: ?token= requests, an Authorization header and a body with a password leave no trace."""
    import uvicorn

    from app.config import settings

    monkeypatch.setattr(settings, "database_path", str(tmp_path / "live.db"))
    from app.main import create_app

    app = create_app()
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="info", lifespan="on"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 20
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        assert server.started
        base = f"http://127.0.0.1:{port}"
        with httpx.Client(base_url=base, timeout=10) as h:
            token = h.post("/api/workspaces", json={}).json()["token"]
            bearer = {"Authorization": f"Bearer {token}"}
            code = h.post("/api/rooms", json={}, headers=bearer).json().get("code", "ABC123")
            h.get(f"/room/{code}", params={"token": token})
            h.post("/mcp", params={"token": token}, headers=HDRS,
                   json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
            h.post("/mcp", params={"token": token}, headers=HDRS,
                   json={"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                         "params": {"name": "harvest_status", "arguments": {}}})
            h.post("/api/metrics/ingest", headers=bearer,
                   json={"platform": "linkedin", "account": {"followers": 3, "password": FAKE_PASSWORD}})
            h.patch("/api/workspace", headers={"Authorization": f"Bearer {FAKE_BEARER}"}, json={"name": "x"})
    finally:
        server.should_exit = True
        thread.join(timeout=20)
    out, err = capfd.readouterr()
    log = out + err
    assert "/mcp?token=[redacted]" in log and f"/room/{code}?token=[redacted]" in log, log[-2000:]
    for value in (token, FAKE_BEARER, FAKE_PASSWORD):
        assert value not in log, f"{value[:6]}... reached the server log"
