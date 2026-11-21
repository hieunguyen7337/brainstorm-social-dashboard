import json


def test_trace_needs_auth(client):
    r = client.post("/api/autoread/trace", json={"platform": "instagram", "run": "x", "events": []})
    assert r.status_code == 401


def test_trace_is_logged_and_kept_per_workspace(auth, capsys):
    client, headers, _ws = auth
    body = {
        "platform": "instagram",
        "run": "abc123",
        "app": {"os": "android", "update": "u1"},
        "events": [{"ms": 5, "e": "page", "path": "/", "past": True}, {"ms": 9, "e": "msg", "status": "signed_out"}],
    }
    r = client.post("/api/autoread/trace", json=body, headers=headers)
    assert r.status_code == 200, r.text
    assert "autoread-trace" in capsys.readouterr().out
    got = client.get("/api/autoread/trace", headers=headers).json()["batches"]
    assert got[-1]["run"] == "abc123"
    assert got[-1]["events"][1]["status"] == "signed_out"

    other = client.post("/api/workspaces", json={}).json()
    seen = client.get("/api/autoread/trace", headers={"Authorization": f"Bearer {other['token']}"}).json()["batches"]
    assert all(b["run"] != "abc123" for b in seen)


def test_trace_rejects_oversized_batches(auth):
    client, headers, _ws = auth
    body = {"platform": "instagram", "run": "r", "events": [{"e": "x"}] * 401}
    assert client.post("/api/autoread/trace", json=body, headers=headers).status_code == 422


# ---- secrets never reach the log or the in-memory store (docs/VAULT.md) ---------------------------------------------

FAKES = ["hunter2-fake", "sessionid=fakecookie99", "123456", "fake-reset-token-0123456789abcdef"]


def _secret_body():
    return {
        "platform": "instagram",
        "run": "sec1",
        "app": {"os": "android", "update": "u1", "cookie": "sessionid=fakecookie99"},
        "events": [
            {"ms": 1, "e": "page", "host": "www.instagram.com", "path": "/", "past": True},
            {"ms": 2, "e": "form", "password": "hunter2-fake", "otp": 123456, "code": "123456"},
            {"ms": 3, "e": "msg", "status": "empty", "diag": {"csrf": True, "text": True, "csrftoken": "hunter2-fake",
                                                            "cookie": "sessionid=fakecookie99", "me": 200}},
            {"ms": 4, "e": "page", "path": "/accounts/password/reset/confirm/MQ/fake-reset-token-0123456789abcdef/"},
            {"ms": 5, "e": "page", "path": "https://www.instagram.com/accounts/login/?next=/&token=hunter2-fake#frag"},
            {"ms": 6, "e": "hdr", "status": "Authorization: Bearer hunter2-fake.tail and password=hunter2-fake", "note": "hunter2-fake"},
            {"ms": 7, "e": "otp", "value": "123456", "list": ["hunter2-fake"], "nested": {"a": {"b": {"c": {"d": "hunter2-fake"}}}}},
        ],
    }


def test_trace_redacts_secrets_before_log_and_store(auth, capsys):
    client, headers, _ws = auth
    r = client.post("/api/autoread/trace", json=_secret_body(), headers=headers)
    assert r.status_code == 200, r.text
    logged = capsys.readouterr().out
    stored = client.get("/api/autoread/trace", headers=headers).text
    for out in (logged, stored):
        for fake in FAKES:
            assert fake not in out, f"{fake!r} leaked"
        assert "hunter2" not in out
    batch = client.get("/api/autoread/trace", headers=headers).json()["batches"][-1]
    # what a diagnostic needs survives: phases, hosts, plain paths, booleans, status numbers
    assert batch["events"][0] == {"ms": 1, "e": "page", "host": "www.instagram.com", "path": "/", "past": True}
    assert batch["events"][2]["diag"]["csrf"] is True
    assert batch["events"][2]["diag"]["text"] is True
    assert batch["events"][2]["diag"]["me"] == 200
    assert batch["events"][4]["path"] == "https://www.instagram.com/accounts/login/"
    assert batch["events"][5]["note"] == "[redacted]"  # free text under an unknown key is dropped
    assert batch["app"]["os"] == "android" and batch["app"]["update"] == "u1"


def test_trace_keeps_update_ids(auth):
    client, headers, _ws = auth
    uuid = "0f3c9a52-7d1e-4b8a-9c66-2e5d1a7b4c90"
    body = {"platform": "x", "run": "u", "app": {"update": uuid}, "events": []}
    assert client.post("/api/autoread/trace", json=body, headers=headers).status_code == 200
    assert client.get("/api/autoread/trace", headers=headers).json()["batches"][-1]["app"]["update"] == uuid


def test_trace_bounds_every_field(auth, capsys):
    client, headers, _ws = auth
    body = {
        "platform": "instagram",
        "run": "big",
        "app": {f"k{i}": "v" * 500 for i in range(100)},
        "events": [{"e": "page", "path": "/" + "a/" * 2000, "big": "word " * 4000, "many": list(range(500))}] * 3,
    }
    assert client.post("/api/autoread/trace", json=body, headers=headers).status_code == 200
    capsys.readouterr()
    batch = client.get("/api/autoread/trace", headers=headers).json()["batches"][-1]
    assert len(batch["app"]) <= 24
    assert all(len(json.dumps(e)) <= 512 for e in batch["events"])
    assert len(json.dumps(batch)) < 4_000


def test_trace_rejects_oversized_bodies(auth, capsys):
    client, headers, _ws = auth
    body = {"platform": "instagram", "run": "huge", "events": [{"e": "x", "pad": "z" * 300_000}]}
    r = client.post("/api/autoread/trace", json=body, headers=headers)
    assert r.status_code == 413
    assert "huge" not in capsys.readouterr().out
    # chunked uploads carry no Content-Length: the cap must hold on the stream too
    def chunks():
        yield b'{"platform":"instagram","run":"huge2","events":[{"e":"x","pad":"'
        for _ in range(40):
            yield b"z" * 10_000
        yield b'"}]}'

    r = client.post("/api/autoread/trace", content=chunks(), headers={**headers, "Content-Type": "application/json"})
    assert r.status_code == 413


def test_trace_rejects_odd_platform_and_run(auth):
    client, headers, _ws = auth
    for bad in ({"platform": "insta gram\nforged-line", "run": "r"}, {"platform": "instagram", "run": "r\nforged"}):
        r = client.post("/api/autoread/trace", json={**bad, "events": []}, headers=headers)
        assert r.status_code == 422
