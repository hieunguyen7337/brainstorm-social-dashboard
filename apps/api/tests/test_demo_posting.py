"""The demo posting pathway (docs/REAL.md, "Demo workspaces"): generate with the real AI pipeline, "post" synthetically,
get metrics back. The Anthropic client is always faked here (`fake_model`); nothing spends the real key.

Publishing in a demo workspace signs the platform's demo account in if needed, marks the post published and takes a first
synthetic metrics read; `POST /api/posts/{id}/demo/metrics` reads again. Nothing it writes is "real".
"""

import pytest

from tests.test_ai import ai_variants, fake_model
from tests.test_demo import count, make_demo, q


def draft(client, h, platform="instagram", content="Fresh from the roastery: a new single origin is in."):
    r = client.post("/api/posts", headers=h, json={"platform": platform, "content": content})
    assert r.status_code == 200, r.text
    return r.json()


def publish(client, h, post_id):
    r = client.post(f"/api/posts/{post_id}/publish", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def refresh(client, h, post_id, **query):
    return client.post(f"/api/posts/{post_id}/demo/metrics", headers=h, params=query)


def events(ws, kind):
    return q("SELECT * FROM events WHERE workspace_id = ? AND type = ? ORDER BY rowid", ws["id"], kind)


def real_events(ws):
    return q("SELECT SUM(real) FROM events WHERE workspace_id = ?", ws["id"])[0][0] or 0


def connection(client, h, platform):
    return next(c for c in client.get("/api/connections", headers=h).json() if c["platform"] == platform)


@pytest.fixture()
def demo(client):
    return make_demo(client)


# ---------------------------------------------------------------- generate: the real pipeline, unchanged

def test_a_demo_workspace_generates_with_the_real_pipeline(demo, monkeypatch):
    client, h, ws = demo
    theme = client.get("/api/themes", headers=h).json()[0]["id"]  # a theme given: no separate classifier call
    calls = fake_model(monkeypatch, parsed=ai_variants("linkedin", "instagram"))
    r = client.post("/api/generate", headers=h, json={"platforms": ["linkedin", "instagram"], "theme_id": theme})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ai_used"] is True and len(calls) == 2  # one Claude call per channel, like any workspace
    assert {p["platform"] for p in body["posts"]} == {"linkedin", "instagram"}
    assert all(p["status"] == "draft" and p["source"] == "ai" for p in body["posts"])
    assert all("{link}" not in p["content"] and p["link_url"] in p["content"] for p in body["posts"])
    assert count("ai_usage", ws, purpose="generate") == 1  # counted against the same caps as everyone


def test_a_demo_workspace_falls_back_to_templates_without_a_key(demo):
    client, h, ws = demo  # conftest blanks the key
    r = client.post("/api/generate", headers=h, json={"platforms": ["linkedin", "instagram"]})
    assert r.status_code == 200 and r.json()["ai_used"] is False
    assert count("ai_usage", ws) == 0 and len(r.json()["posts"]) == 2


# ---------------------------------------------------------------- post: sign in, publish, first read

def test_posting_signs_the_platform_in_and_returns_the_first_read(demo):
    client, h, ws = demo
    assert connection(client, h, "instagram")["status"] == "disconnected"
    post = draft(client, h)
    out = publish(client, h, post["id"])
    assert out["status"] == "published" and out["views"] > 0 and out["engagements"] > 0  # numbers come back with it
    conn = connection(client, h, "instagram")
    assert (conn["status"], conn["mode"]) == ("connected", "sandbox")
    assert count("daily_metrics", ws, platform="instagram") >= 60  # the demo account's history came with the sign-in
    assert [e["detail"] for e in events(ws, "connected")] == ["Connected Instagram (demo)"]
    assert len(events(ws, "published")) >= 1 and len(events(ws, "metrics")) == 1
    assert "(demo)" in events(ws, "metrics")[0]["detail"]
    assert q("SELECT metrics_source FROM posts WHERE id = ?", post["id"])[0][0] == "sim"
    assert real_events(ws) == 0  # nothing here is a real person


def test_posting_to_a_platform_already_signed_in_does_not_sign_in_again(demo):
    client, h, ws = demo
    client.post("/api/connections/linkedin/demo", headers=h)
    posts_before = count("posts", ws)
    publish(client, h, draft(client, h, "linkedin")["id"])
    assert count("posts", ws) == posts_before + 1  # only the one we made: no second set of seed posts
    assert len(events(ws, "connected")) == 1 and count("metric_snapshots", ws) == 1


def test_publishing_twice_reads_once(demo):
    client, h, ws = demo
    post = draft(client, h)
    first = publish(client, h, post["id"])
    again = publish(client, h, post["id"])
    assert again["views"] == first["views"] and len(events(ws, "metrics")) == 1


def test_the_first_read_does_not_dwarf_the_demo_history(demo):
    client, h, _ = demo
    publish(client, h, draft(client, h)["id"])
    d = client.get("/api/dashboard?days=30", headers=h).json()
    series = [row["views"] for row in sorted(d["timeseries"], key=lambda r: r["day"])]
    typical = sorted(series[:-1])[len(series) // 2]
    assert series[-1] <= typical * 2  # one post adds minutes of audience, not a spike


# ---------------------------------------------------------------- metrics back: refresh

def test_refreshing_metrics_reads_more_numbers_back(demo):
    client, h, ws = demo
    post = publish(client, h, draft(client, h)["id"])
    r = refresh(client, h, post["id"])
    assert r.status_code == 200, r.text
    read = r.json()
    assert read["advanced_minutes"] == 5 and read["views_gained"] > 0
    assert read["post"]["views"] == post["views"] + read["views_gained"]
    assert read["post"]["engagements"] == post["engagements"] + read["engagements_gained"]
    assert len(events(ws, "metrics")) == 2 and real_events(ws) == 0
    # the feeds' own tick must not undo or double it: the post was read ahead of the clock
    listed = next(p for p in client.get("/api/posts?status=published", headers=h).json() if p["id"] == post["id"])
    assert listed["views"] == read["post"]["views"]


def test_refreshing_can_jump_further_or_not_at_all(demo):
    client, h, _ = demo
    post = publish(client, h, draft(client, h)["id"])
    assert refresh(client, h, post["id"], advance_minutes=0).json()["views_gained"] == 0
    assert refresh(client, h, post["id"], advance_minutes=30).json()["views_gained"] > 0
    assert refresh(client, h, post["id"], advance_minutes=61).status_code == 422


def test_a_read_touches_only_its_own_post(demo):
    client, h, _ = demo
    a = publish(client, h, draft(client, h, content="Post A about the new roast is here for you.")["id"])
    b = publish(client, h, draft(client, h, content="Post B about plant care tips is here for you.")["id"])
    refresh(client, h, a["id"])
    listed = {p["id"]: p for p in client.get("/api/posts?status=published", headers=h).json()}
    assert listed[b["id"]]["views"] == b["views"]


# ---------------------------------------------------------------- guards

def test_only_a_published_post_can_be_read(demo):
    client, h, ws = demo
    post = draft(client, h)
    assert refresh(client, h, post["id"]).status_code == 409
    assert refresh(client, h, "p_missing").status_code == 404
    assert client.post(f"/api/posts/{post['id']}/demo/metrics").status_code == 401
    assert len(events(ws, "metrics")) == 0


@pytest.mark.parametrize("body", [{"real": True}, {}], ids=["real", "sample"])
def test_the_read_is_refused_outside_a_demo_workspace(client, body):
    ws = client.post("/api/workspaces", json=body).json()
    h = {"Authorization": f"Bearer {ws['token']}"}
    post = draft(client, h)
    before = q("SELECT views FROM posts WHERE id = ?", post["id"])[0][0]
    r = refresh(client, h, post["id"])
    assert r.status_code == 409 and "demo workspace" in r.json()["detail"]
    assert q("SELECT views FROM posts WHERE id = ?", post["id"])[0][0] == before
    assert count("events", ws, type="metrics") == 0


def test_publishing_in_a_real_workspace_is_unchanged(client):
    ws = client.post("/api/workspaces", json={"real": True}).json()
    h = {"Authorization": f"Bearer {ws['token']}"}
    out = publish(client, h, draft(client, h)["id"])
    assert out["views"] == 0  # no first read, no simulated audience
    assert count("events", ws, type="metrics") == 0 and count("daily_metrics", ws) == 0
    assert connection(client, h, "instagram")["status"] == "disconnected"  # and no demo sign-in

