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
