import time
from datetime import timedelta

from app.services import metrics


def test_create_and_seed(auth):
    client, h, ws = auth
    assert ws["brand_name"] == "Brew & Bloom" and ws["token"]
    assert client.get("/api/workspace", headers=h).json()["id"] == ws["id"]
    conns = client.get("/api/connections", headers=h).json()
    assert len(conns) == 6 and all(c["mode"] == "sandbox" and c["followers"] > 0 for c in conns)
    posts = client.get("/api/posts?limit=200", headers=h).json()
    assert len(posts) == 24
    by = {s: sum(p["status"] == s for p in posts) for s in ("published", "draft", "scheduled")}
    assert by == {"published": 18, "draft": 3, "scheduled": 3}
    assert len({p["link_code"] for p in posts}) == 24
    assert all(p["link_url"].endswith("/r/" + p["link_code"]) for p in posts)
    dash = client.get("/api/dashboard", headers=h).json()
    assert len(dash["timeseries"]) == 30


def test_seed_speed_and_custom_brand(client):
    t = time.perf_counter()
    r = client.post("/api/workspaces", json={"brand_name": "Acme <b>Co</b>"})
    assert time.perf_counter() - t < 0.3
    assert r.json()["brand_name"] == "Acme <b>Co</b>"
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    assert len(client.get("/api/posts?limit=200", headers=h).json()) == 24


def test_auth_401(client):
    for method, path in [("get", "/api/workspace"), ("get", "/api/dashboard"), ("get", "/api/posts"),
                         ("get", "/api/activity"), ("get", "/api/connections")]:
        assert getattr(client, method)(path).status_code == 401
    assert client.get("/api/workspace", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_workspace_patch_and_connections(auth):
    client, h, _ = auth
    r = client.patch("/api/workspace", headers=h, json={"offer": "Free shipping"})
    assert r.json()["offer"] == "Free shipping"
    r = client.delete("/api/connections/x", headers=h)
    assert r.json()["status"] == "disconnected"
    r = client.post("/api/connections/x", headers=h, json={"handle": "@newhandle"})
    assert r.json()["status"] == "connected" and r.json()["handle"] == "@newhandle"
    assert client.post("/api/connections/myspace", headers=h, json={"handle": "a"}).status_code == 404


def test_dashboard_shape_and_funnel(auth):
    client, h, _ = auth
    d = client.get("/api/dashboard?days=30", headers=h).json()
    vals = [s["value"] for s in d["funnel"]]
    assert vals == sorted(vals, reverse=True) and vals[0] > 0
    assert [s["stage"] for s in d["funnel"]] == ["views", "engagements", "clicks", "conversions"]
    e, k, c = d["funnel"][1]["rate"], d["funnel"][2]["rate"], d["funnel"][3]["rate"]
    assert 0.03 <= e <= 0.08 and 0.10 <= k <= 0.25 and 0.03 <= c <= 0.10
    assert abs(sum(p["share"] for p in d["by_platform"]) - 1) < 0.01
    assert len(d["by_platform"]) == 6 and len(d["top_posts"]) == 5
    views = [p["views"] for p in d["top_posts"]]
    assert views == sorted(views, reverse=True)
    assert set(d["change_pct"]) == {"views", "engagements", "clicks", "conversions"}
    # seeded growth, not a flat 0% (ids are random, so check direction only; small counts swing a lot)
    assert d["change_pct"]["views"] > 0 and all(v != 0 for v in d["change_pct"].values()), d["change_pct"]
    assert d["real_clicks"] == 0 and d["real_conversions"] == 0
    f = client.get("/api/dashboard?platform=linkedin", headers=h).json()
    assert [p["platform"] for p in f["by_platform"]] == ["linkedin"]
    assert all(p["platform"] == "linkedin" for p in f["top_posts"])
    assert f["totals"]["views"] < d["totals"]["views"]
    assert len(client.get("/api/dashboard?days=7", headers=h).json()["timeseries"]) == 7


def test_post_crud_and_publish_tick(auth, monkeypatch):
    client, h, _ = auth
    r = client.post("/api/posts", headers=h, json={"platform": "instagram", "content": "Hello world"})
    p = r.json()
    assert p["status"] == "draft" and p["source"] == "manual" and len(p["link_code"]) == 6
    assert client.get("/api/posts", headers=h).json()[0]["id"] == p["id"]
    r = client.patch(f"/api/posts/{p['id']}", headers=h, json={"content": "Edited", "hashtags": ["a"]})
    assert r.json()["content"] == "Edited" and r.json()["hashtags"] == ["a"]
    pub = client.post(f"/api/posts/{p['id']}/publish", headers=h).json()
    assert pub["status"] == "published" and pub["published_at"] and pub["views"] == 0
    day_before = client.get("/api/dashboard?days=1", headers=h).json()["totals"]["views"]
    real_now = metrics._now()
    monkeypatch.setattr(metrics, "_now", lambda: real_now + timedelta(seconds=60))
    posts = client.get("/api/posts?status=published", headers=h).json()
    grown = next(x for x in posts if x["id"] == p["id"])
    assert 30 <= grown["views"] <= 400
    assert client.get("/api/dashboard?days=1", headers=h).json()["totals"]["views"] >= day_before + grown["views"]
    acts = client.get("/api/activity?limit=50", headers=h).json()
    assert any(a["type"] == "published" and a["post_id"] == p["id"] for a in acts)
    assert client.delete(f"/api/posts/{p['id']}", headers=h).json() == {"ok": True}
    assert client.delete(f"/api/posts/{p['id']}", headers=h).status_code == 404


def test_cross_workspace_404(auth):
    client, h, _ = auth
    other = client.post("/api/workspaces", json={}).json()
    h2 = {"Authorization": f"Bearer {other['token']}"}
    pid = client.get("/api/posts", headers=h).json()[0]["id"]
    assert client.patch(f"/api/posts/{pid}", headers=h2, json={"content": "x"}).status_code == 404
    assert client.delete(f"/api/posts/{pid}", headers=h2).status_code == 404
    assert client.post(f"/api/posts/{pid}/publish", headers=h2).status_code == 404
    assert pid not in {p["id"] for p in client.get("/api/posts?limit=200", headers=h2).json()}
