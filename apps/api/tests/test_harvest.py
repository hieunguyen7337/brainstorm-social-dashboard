"""Harvest: profile URLs, real-stats ingest, snapshots, harvest status.

Harvested posts carry `HARVESTED_SOURCE`: 'harvested' once models.Post.source allows it, else 'manual'
(see services.harvest.pick_source), so tests find them through that constant, never the literal.
"""

import sqlite3
from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.config import settings
from app.db import PLATFORMS, connect
from app.models import Connection
from app.services import harvest, metrics

HSRC, pick_source = harvest.HARVESTED_SOURCE, harvest.pick_source
LI_PUT = "/api/connections/linkedin/profile"


# ---------------------------------------------------------------- helpers

def q(sql, *args):
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def w(sql, *args):
    conn = sqlite3.connect(settings.database_path)
    try:
        conn.execute(sql, args)
        conn.commit()
    finally:
        conn.close()


def ingest(client, h, posts=(), account=None, platform="linkedin", source="script"):
    body = {"platform": platform, "source": source, "posts": list(posts)}
    if account is not None:
        body["account"] = account
    return client.post("/api/metrics/ingest", headers=h, json=body)


def seeded(ws, platform="linkedin", status="published"):
    return q("SELECT * FROM posts WHERE workspace_id = ? AND platform = ? AND status = ? ORDER BY rowid",
             ws["id"], platform, status)[0]


def post(pid):
    return q("SELECT * FROM posts WHERE id = ?", pid)[0]


def by_external_id(ws, external_id):
    return q("SELECT * FROM posts WHERE workspace_id = ? AND external_id = ?", ws["id"], external_id)[0]


def harvested_count():
    return q("SELECT COUNT(*) FROM posts WHERE source = ?", HSRC)[0][0]


def daily(ws, platform, day):
    rows = q("SELECT * FROM daily_metrics WHERE workspace_id = ? AND platform = ? AND day = ?",
             ws["id"], platform, day)
    return dict(rows[0]) if rows else dict.fromkeys(("views", "engagements", "clicks", "conversions"), 0)


def day_ago(days):
    return (datetime.now(UTC).date() - timedelta(days=days)).isoformat()


def iso_ago(**kw):
    return (datetime.now(UTC) - timedelta(**kw)).replace(microsecond=0).isoformat()


def second_workspace(client):
    ws = client.post("/api/workspaces", json={}).json()
    return {"Authorization": f"Bearer {ws['token']}"}, ws


def cand(pid, external_id=None, url=None, content=None):
    return harvest.candidate(pid, external_id, url, content)


def put_profile(client, h, platform, url):
    return client.put(f"/api/connections/{platform}/profile", headers=h, json={"profile_url": url})


# ---------------------------------------------------------------- PUT /api/connections/{platform}/profile

@pytest.mark.parametrize("platform,url,stored", [
    ("linkedin", "  https://www.linkedin.com/company/acme/#about \n",
     "https://www.linkedin.com/company/acme/"),
    ("instagram", "https://www.instagram.com/jane/", "https://www.instagram.com/jane/"),
])
def test_put_profile_happy_path(auth, platform, url, stored):
    client, h, ws = auth
    before = next(c for c in client.get("/api/connections", headers=h).json() if c["platform"] == platform)
    r = put_profile(client, h, platform, url)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == set(Connection.model_fields) | {"profile_url", "availability"}
    assert body["profile_url"] == stored
    assert {k: body[k] for k in before} == before  # handle, followers, status... untouched
    assert q("SELECT profile_url FROM connections WHERE workspace_id = ? AND platform = ?",
             ws["id"], platform)[0][0] == stored
    assert put_profile(client, h, platform, url).json() == body  # idempotent


@pytest.mark.parametrize("platform,url", [
    ("linkedin", "https://uk.linkedin.com/in/jane"), ("linkedin", "HTTPS://LinkedIn.com/company/acme"),
    ("x", "https://x.com/jane"), ("x", "https://mobile.twitter.com/jane"),
    ("facebook", "https://fb.com/acme"), ("tiktok", "https://www.tiktok.com/@jane"),
    ("reddit", "https://old.reddit.com/user/jane"), ("instagram", "http://instagram.com/jane"),
])
def test_put_profile_accepts_platform_domains_and_subdomains(auth, platform, url):
    client, h, _ = auth
    r = put_profile(client, h, platform, url)
    assert r.status_code == 200, r.text
    assert r.json()["profile_url"] == url.replace("HTTPS://LinkedIn", "https://linkedin")


@pytest.mark.parametrize("platform,url", [
    ("linkedin", "https://evil-linkedin.com/in/jane"),
    ("linkedin", "https://linkedin.com.evil.com/in/jane"),
    ("linkedin", "https://evil.com/linkedin.com"),
    ("linkedin", "https://evil.com/?next=https://linkedin.com/in/jane"),
    ("linkedin", "https://instagram.com/jane"),
    ("instagram", "https://linkedin.com/in/jane"),
    ("linkedin", "ftp://linkedin.com/in/jane"),
    ("linkedin", "javascript:alert(1)"),
    ("linkedin", "linkedin.com/in/jane"),
    ("linkedin", "https://jane@linkedin.com/in/jane"),
    ("linkedin", "https://evil.com\\@linkedin.com/in/jane"),
    ("linkedin", ""),
    ("x", "https://notx.com/jane"),
    ("x", "https://x.com.evil.com/jane"),
    ("facebook", "https://evilfb.com/acme"),
])
def test_put_profile_rejects_bad_urls(auth, platform, url):
    client, h, ws = auth
    r = put_profile(client, h, platform, url)
    assert r.status_code == 422 and isinstance(r.json()["detail"], str) and r.json()["detail"]
    assert q("SELECT profile_url FROM connections WHERE workspace_id = ? AND platform = ?",
             ws["id"], platform)[0][0] is None


def test_put_profile_url_too_long_and_unknown_platform(auth):
    client, h, _ = auth
    assert put_profile(client, h, "linkedin", "https://www.linkedin.com/in/" + "a" * 2100).status_code == 422
    assert put_profile(client, h, "myspace", "https://myspace.com/x").status_code == 404


@pytest.mark.parametrize("platform,url,handle", [
    ("linkedin", "https://linkedin.com/company/acme/", "company/acme"),
    ("linkedin", "https://uk.linkedin.com/in/jane", "in/jane"),
    ("linkedin", "https://www.linkedin.com/", "www.linkedin.com"),
    ("instagram", "https://www.instagram.com/jane/", "@jane"),
    ("tiktok", "https://www.tiktok.com/@jane?lang=en", "@jane"),
    ("x", "https://twitter.com/jane", "@jane"),
    ("reddit", "https://www.reddit.com/user/jane/", "u/jane"),
    ("reddit", "https://www.reddit.com/r/coffee", "r/coffee"),
    ("facebook", "https://fb.com/acme.cafe", "@acme.cafe"),
    ("facebook", "https://www.facebook.com/profile.php?id=123", "www.facebook.com"),
])
def test_put_profile_creates_missing_connection(auth, platform, url, handle):
    client, h, ws = auth
    w("DELETE FROM connections WHERE workspace_id = ? AND platform = ?", ws["id"], platform)
    r = put_profile(client, h, platform, url)
    assert r.status_code == 200, r.text
    assert r.json() | {"connected_at": None} == {
        "platform": platform, "handle": handle, "status": "connected", "mode": "sandbox", "followers": 0,
        "connected_at": None, "profile_url": url, "availability": "live"}
    assert any(c["platform"] == platform for c in client.get("/api/connections", headers=h).json())


def test_put_profile_revives_disconnected_connection(auth):
    client, h, _ = auth
    assert client.delete("/api/connections/linkedin", headers=h).json()["status"] == "disconnected"
    r = put_profile(client, h, "linkedin", "https://www.linkedin.com/company/acme")
    assert r.json()["status"] == "connected"
    assert next(c for c in client.get("/api/connections", headers=h).json()
                if c["platform"] == "linkedin")["status"] == "connected"


# ---------------------------------------------------------------- auth and routing

@pytest.mark.parametrize("method,path,body", [
    ("PUT", LI_PUT, {"profile_url": "https://www.linkedin.com/in/jane"}),
    ("POST", "/api/metrics/ingest", {"platform": "linkedin", "source": "script"}),
    ("GET", "/api/metrics/snapshots", None),
    ("GET", "/api/connections/harvest-status", None),
])
def test_new_endpoints_require_token(client, method, path, body):
    assert client.request(method, path, json=body).status_code == 401
    bad = {"Authorization": "Bearer nope"}
    assert client.request(method, path, json=body, headers=bad).status_code == 401


def test_harvest_status_route_does_not_clash_with_connection_routes(auth):
    client, h, _ = auth
    r = client.get("/api/connections/harvest-status", headers=h)
    assert r.status_code == 200 and len(r.json()) == 6
    # POST/DELETE /api/connections/{platform} still reach the workspaces router
    assert client.post("/api/connections/harvest-status", headers=h, json={"handle": "x"}).status_code == 404
    assert client.delete("/api/connections/harvest-status", headers=h).status_code == 404
    r = client.post("/api/connections/linkedin", headers=h, json={"handle": "company/acme"})
    assert r.status_code == 200
    assert client.delete("/api/connections/linkedin", headers=h).json()["status"] == "disconnected"
    assert client.get("/api/connections/harvest-status", headers=h).json()[0]["connected"] is False
    assert len(client.get("/api/connections", headers=h).json()) == 6


# ---------------------------------------------------------------- ingest: create

def test_ingest_creates_harvested_posts(auth):
    client, h, ws = auth
    posted = datetime.now(UTC).replace(microsecond=0) - timedelta(days=3)
    local = posted.astimezone(timezone(timedelta(hours=10))).isoformat()
    r = ingest(client, h, posts=[
        {"external_id": "urn:1", "url": "https://www.linkedin.com/posts/acme_1", "posted_at": local,
         "content": "Our launch day recap", "views": 1200, "engagements": 64, "clicks": 9, "conversions": 2,
         "bogus": "ignored"},
        {"url": "https://www.linkedin.com/posts/" + "a" * 3000, "views": 5, "engagements": 1},
        {"views": 0, "engagements": 0},
        {"content": "x" * 6000, "views": 1, "engagements": 0, "posted_at": "not a date"},
        {"content": "Posted from the far future", "views": 1, "engagements": 0, "posted_at": "2999-01-01"},
    ])
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["matched"], out["created"], out["snapshots"]) == (0, 5, 5)
    assert (out["platform"], out["source"]) == ("linkedin", "script")
    now = out["captured_at"]
    a = by_external_id(ws, "urn:1")
    assert (a["status"], a["source"], a["link_code"], a["quality"], a["hashtags"]) == \
        ("published", HSRC, None, 0.5, "[]")
    assert (a["content"], a["external_url"], a["published_at"]) == \
        ("Our launch day recap", "https://www.linkedin.com/posts/acme_1", posted.isoformat())
    assert (a["views"], a["engagements"], a["clicks"], a["conversions"]) == (1200, 64, 9, 2)
    assert (a["metrics_source"], a["harvested_at"], a["last_tick_at"], a["created_at"]) == \
        ("real", now, now, now)
    extra = q("SELECT * FROM posts WHERE workspace_id = ? AND source = ? AND external_id IS NULL"
              " ORDER BY rowid", ws["id"], HSRC)
    long_url, empty, long_text, future = extra
    assert len(long_url["external_url"]) == 2048 and long_url["content"] == long_url["external_url"]
    assert (empty["content"], empty["views"], empty["clicks"], empty["conversions"]) == \
        ("Harvested post", 0, 0, 0)
    assert len(long_text["content"]) == 5000 and long_text["published_at"] == now  # unparseable -> now
    assert future["published_at"] == now  # future -> now


def test_ingest_response_shape_and_idempotent_rerun(auth):
    client, h, ws = auth
    posts = [{"external_id": f"urn:{i}", "content": f"Harvested post number {i} for the idempotency test",
              "views": 100 * i, "engagements": i} for i in range(1, 4)]
    first = ingest(client, h, posts=posts).json()
    assert set(first) == {"platform", "source", "matched", "created", "snapshots", "captured_at"}
    assert (first["matched"], first["created"]) == (0, 3)
    again = ingest(client, h, posts=posts).json()
    assert (again["matched"], again["created"], again["snapshots"]) == (3, 0, 3)
    assert q("SELECT COUNT(*) FROM posts WHERE workspace_id = ? AND source = ?",
             ws["id"], HSRC)[0][0] == 3


def test_ingest_validation(auth):
    client, h, _ = auth
    ok = {"views": 1, "engagements": 0}
    assert ingest(client, h, platform="myspace").status_code == 422
    assert ingest(client, h, source="carrier-pigeon").status_code == 422
    assert ingest(client, h, posts=[{**ok, "views": -1}]).status_code == 422
    assert ingest(client, h, posts=[{"views": 1}]).status_code == 422
    assert ingest(client, h, account={"followers": -5}).status_code == 422
    assert ingest(client, h, account={"followers": 10, "surprise": True}).status_code == 200  # extras ignored


def test_ingest_rejects_more_than_500_posts(auth):
    client, h, _ = auth

    def many(n):
        return [{"content": f"Bulk harvested post number {i} of the batch", "views": i, "engagements": 0}
                for i in range(n)]
    assert ingest(client, h, posts=many(501)).status_code == 422
    assert harvested_count() == 0
    r = ingest(client, h, posts=many(500))
    assert r.status_code == 200 and r.json()["created"] == 500 and r.json()["snapshots"] == 500


# ---------------------------------------------------------------- ingest: matching

def test_ingest_matches_by_external_id_and_fills_ids(auth):
    client, h, ws = auth
    p = seeded(ws)
    w("UPDATE posts SET external_id = 'urn:li:42' WHERE id = ?", p["id"])
    r = ingest(client, h, posts=[{
        "external_id": "urn:li:42", "url": "https://linkedin.com/posts/acme_42",
        "content": "totally different text", "views": 4321, "engagements": 210}])
    assert (r.json()["matched"], r.json()["created"]) == (1, 0)
    after = post(p["id"])
    assert (after["views"], after["engagements"]) == (4321, 210)
    assert after["content"] == p["content"]
    assert after["external_url"] == "https://linkedin.com/posts/acme_42"  # empty url filled
    assert harvested_count() == 0


def test_ingest_matches_by_normalised_url(auth):
    client, h, ws = auth
    p = seeded(ws)
    w("UPDATE posts SET external_url = 'https://linkedin.com/posts/acme_9' WHERE id = ?", p["id"])
    r = ingest(client, h, posts=[{
        "external_id": "urn:9", "url": "HTTPS://www.LinkedIn.com/posts/acme_9/?utm=x#c",
        "views": 77, "engagements": 7}])
    assert (r.json()["matched"], r.json()["created"]) == (1, 0)
    after = post(p["id"])
    assert (after["views"], after["external_id"], after["external_url"]) == \
        (77, "urn:9", "https://linkedin.com/posts/acme_9")  # existing url kept, empty id filled


def test_ingest_matches_by_content_prefix(auth):
    client, h, ws = auth
    p = seeded(ws)
    truncated = p["content"][:45] + "… see more"
    r = ingest(client, h, posts=[{"content": truncated, "views": 555, "engagements": 55}])
    assert (r.json()["matched"], r.json()["created"]) == (1, 0)
    assert (post(p["id"])["views"], post(p["id"])["content"]) == (555, p["content"])
    short = ingest(client, h, posts=[{"content": p["content"][:10], "views": 1, "engagements": 0}])
    assert (short.json()["matched"], short.json()["created"]) == (0, 1)  # under 20 chars never matches


def test_ingest_match_precedence_and_each_post_matched_once(auth):
    client, h, ws = auth
    a, b = q("SELECT * FROM posts WHERE workspace_id = ? AND platform = 'linkedin' AND status = 'published'"
             " ORDER BY rowid LIMIT 2", ws["id"])
    text = "A rather unique sentence used to test the matching"
    w("UPDATE posts SET external_id = 'urn:A' WHERE id = ?", a["id"])
    w("UPDATE posts SET content = ? WHERE id = ?", text, b["id"])
    r = ingest(client, h, posts=[
        {"external_id": "urn:A", "content": text, "views": 10, "engagements": 1},  # id beats content
        {"content": text + " …", "views": 20, "engagements": 2},              # b (a is used)
        {"content": text, "views": 30, "engagements": 3},                          # nothing left: created
    ])
    assert (r.json()["matched"], r.json()["created"], r.json()["snapshots"]) == (2, 1, 3)
    assert post(a["id"])["views"] == 10 and post(b["id"])["views"] == 20 and post(b["id"])["content"] == text
    new = q("SELECT * FROM posts WHERE source = ? AND id NOT IN (?, ?)", HSRC, a["id"], b["id"])
    assert len(new) == 1 and new[0]["views"] == 30 and new[0]["content"] == text


def test_matching_is_scoped_to_workspace_and_platform(auth):
    client, h, ws = auth
    h2, ws2 = second_workspace(client)
    mine = seeded(ws, "instagram")
    w("UPDATE posts SET external_id = 'urn:shared' WHERE id = ?", mine["id"])
    item = [{"external_id": "urn:shared", "views": 9, "engagements": 1}]
    # same external id in another workspace, and on another platform in this one: both create
    other = ingest(client, h2, platform="instagram", posts=item)
    assert (other.json()["matched"], other.json()["created"]) == (0, 1)
    wrong = ingest(client, h, platform="linkedin", posts=item)
    assert (wrong.json()["matched"], wrong.json()["created"]) == (0, 1)
    assert post(mine["id"])["views"] == mine["views"] and post(mine["id"])["metrics_source"] == "sim"
    assert by_external_id(ws2, "urn:shared")["workspace_id"] == ws2["id"]


# ---------------------------------------------------------------- ingest: matched post effects

def test_matched_post_takes_real_numbers_and_keeps_clicks_when_omitted(auth):
    client, h, ws = auth
    p = seeded(ws)
    w("UPDATE posts SET external_id = 'urn:k', clicks = 7, conversions = 2, views = 50, engagements = 5"
      " WHERE id = ?", p["id"])
    r = ingest(client, h, posts=[{"external_id": "urn:k", "views": 900, "engagements": 80}])
    after = post(p["id"])
    assert (after["views"], after["engagements"], after["clicks"], after["conversions"]) == (900, 80, 7, 2)
    assert (after["metrics_source"], after["harvested_at"], after["status"]) == \
        ("real", r.json()["captured_at"], "published")
    assert after["published_at"] == p["published_at"] and after["source"] == p["source"]
    ingest(client, h, posts=[{"external_id": "urn:k", "views": 900, "engagements": 80,
                              "clicks": 31, "conversions": 4}])
    after = post(p["id"])
    assert (after["clicks"], after["conversions"]) == (31, 4)


def test_matched_draft_and_scheduled_posts_become_published(auth):
    client, h, ws = auth
    draft = seeded(ws, "linkedin", "draft")
    sched = seeded(ws, "instagram", "scheduled")
    assert sched["scheduled_at"]
    posted = iso_ago(days=2)
    r1 = ingest(client, h, posts=[{"content": draft["content"][:50], "posted_at": posted,
                                   "views": 40, "engagements": 4}])
    w("UPDATE posts SET external_id = 'urn:s' WHERE id = ?", sched["id"])
    r2 = ingest(client, h, platform="instagram",
                posts=[{"external_id": "urn:s", "views": 60, "engagements": 6}])
    assert r1.json()["matched"] == r2.json()["matched"] == 1
    d, s = post(draft["id"]), post(sched["id"])
    assert (d["status"], d["published_at"], d["views"]) == ("published", posted, 40)
    assert (s["status"], s["published_at"], s["scheduled_at"]) == \
        ("published", r2.json()["captured_at"], None)


# ---------------------------------------------------------------- ingest: daily_metrics stay honest

def test_ingest_delta_moves_dashboard_totals(auth, monkeypatch):
    monkeypatch.setattr(metrics, "tick", lambda *a, **k: None)  # no simulated growth between reads
    client, h, ws = auth
    p = seeded(ws)
    url = "/api/dashboard?days=30&platform=linkedin"
    before = client.get(url, headers=h).json()["totals"]
    w("UPDATE posts SET external_id = 'urn:d' WHERE id = ?", p["id"])
    ingest(client, h, posts=[{"external_id": "urn:d", "views": p["views"] + 700,
                              "engagements": p["engagements"] + 40}])
    after = client.get(url, headers=h).json()["totals"]
    assert after["views"] - before["views"] == 700 and after["engagements"] - before["engagements"] == 40
    assert (after["clicks"], after["conversions"]) == (before["clicks"], before["conversions"])
    ingest(client, h, posts=[{"external_id": "urn:d", "views": p["views"] + 100,
                              "engagements": p["engagements"]}])
    again = client.get(url, headers=h).json()["totals"]  # a lower real number subtracts again
    assert again["views"] - before["views"] == 100 and again["engagements"] == before["engagements"]


def test_delta_lands_on_publish_day_in_window_else_today(auth):
    client, h, ws = auth
    p = seeded(ws)
    w("UPDATE posts SET external_id = 'urn:old', published_at = ? WHERE id = ?", iso_ago(days=60), p["id"])
    today_before = daily(ws, "linkedin", day_ago(0))
    ingest(client, h, posts=[
        {"external_id": "urn:old", "views": p["views"] + 100, "engagements": p["engagements"] + 10},
        {"external_id": "urn:new3", "posted_at": iso_ago(days=3), "views": 500, "engagements": 50,
         "clicks": 5, "conversions": 1},                                                         # in window
        {"external_id": "urn:new90", "posted_at": iso_ago(days=90), "views": 300, "engagements": 30},
    ])
    three, today = daily(ws, "linkedin", day_ago(3)), daily(ws, "linkedin", day_ago(0))
    assert today["views"] - today_before["views"] == 100 + 300  # the 60- and 90-day-old posts: today
    assert today["engagements"] - today_before["engagements"] == 10 + 30
    assert today["clicks"] == today_before["clicks"]
    assert three["views"] >= 500 and three["clicks"] >= 5 and three["conversions"] >= 1
    assert q("SELECT COUNT(*) FROM daily_metrics WHERE day = ?", day_ago(90))[0][0] == 0
    assert by_external_id(ws, "urn:new90")["published_at"][:10] == day_ago(90)


def test_negative_delta_never_takes_a_daily_value_below_zero(auth):
    client, h, ws = auth
    p = seeded(ws)
    w("UPDATE posts SET external_id = 'urn:big', views = 1000000, engagements = 90000 WHERE id = ?", p["id"])
    day = p["published_at"][:10]
    others = ("SELECT day, views FROM daily_metrics WHERE workspace_id = ? AND platform = 'linkedin'"
              " AND day != ? ORDER BY day")
    other_days = q(others, ws["id"], day)
    ingest(client, h, posts=[{"external_id": "urn:big", "views": 100, "engagements": 10}])
    assert daily(ws, "linkedin", day)["views"] == 0 and daily(ws, "linkedin", day)["engagements"] == 0
    low = q("SELECT MIN(views), MIN(engagements) FROM daily_metrics WHERE workspace_id = ?", ws["id"])[0]
    assert low[0] >= 0 and low[1] >= 0
    assert q(others, ws["id"], day) == other_days  # other days untouched
    assert post(p["id"])["views"] == 100


# ---------------------------------------------------------------- ingest: snapshots, followers, events

def test_account_only_ingest_writes_one_snapshot_and_updates_followers(auth):
    client, h, ws = auth
    posts_before = q("SELECT COUNT(*) FROM posts")[0][0]
    r = ingest(client, h, platform="instagram", source="claude_chrome", account={
        "followers": 9876, "views": 12000, "engagements": 800, "clicks": 90, "profile_views": 431})
    assert r.status_code == 200
    assert (r.json()["matched"], r.json()["created"], r.json()["snapshots"]) == (0, 0, 1)
    snap = q("SELECT * FROM metric_snapshots WHERE workspace_id = ?", ws["id"])
    assert len(snap) == 1
    s = snap[0]
    assert (s["post_id"], s["platform"], s["source"], s["captured_at"]) == \
        (None, "instagram", "claude_chrome", r.json()["captured_at"])
    assert (s["views"], s["engagements"], s["clicks"], s["conversions"], s["followers"]) == \
        (12000, 800, 90, None, 9876)
    assert next(c for c in client.get("/api/connections", headers=h).json()
                if c["platform"] == "instagram")["followers"] == 9876
    assert q("SELECT COUNT(*) FROM posts")[0][0] == posts_before
    ev = q("SELECT * FROM events WHERE type = 'harvested'")[0]
    assert ev["real"] == 1 and ev["post_id"] is None and ev["platform"] == "instagram"
    assert ev["detail"] == ("Harvested 0 posts from Instagram (claude_chrome): "
                            "9,876 followers, 12,000 views, 431 profile views")
    assert ingest(client, h, platform="instagram").json()["snapshots"] == 0  # empty account: no account row


def test_ingest_snapshots_and_activity_event(auth):
    client, h, ws = auth
    r = ingest(client, h, account={"followers": 3100, "profile_views": 540}, posts=[
        {"external_id": "urn:a", "content": "First harvested post, long enough", "views": 10,
         "engagements": 1},
        {"external_id": "urn:b", "content": "Second harvested post, long enough", "views": 20,
         "engagements": 2, "clicks": 3, "conversions": 1},
    ])
    now = r.json()["captured_at"]
    assert r.json()["snapshots"] == 3
    snaps = q("SELECT s.*, p.external_id FROM metric_snapshots s LEFT JOIN posts p ON p.id = s.post_id"
              " WHERE s.workspace_id = ? ORDER BY s.rowid", ws["id"])
    a, b, acct = snaps
    assert (a["external_id"], a["views"], a["engagements"], a["clicks"], a["conversions"],
            a["followers"]) == ("urn:a", 10, 1, None, None, None)  # not captured -> NULL, never an invented 0
    assert (b["clicks"], b["conversions"]) == (3, 1)
    assert (acct["post_id"], acct["followers"], acct["views"]) == (None, 3100, None)
    assert {s["source"] for s in snaps} == {"script"} and {s["captured_at"] for s in snaps} == {now}
    feed = client.get("/api/activity?limit=5", headers=h).json()
    ev = next(e for e in feed if e["type"] == "harvested")
    assert ev["real"] is True and ev["platform"] == "linkedin" and ev["post_id"] is None
    assert ev["detail"] == "Harvested 2 posts from LinkedIn (script): 3,100 followers, 540 profile views"


def test_ingest_creates_missing_connection(auth):
    client, h, ws = auth
    w("DELETE FROM connections WHERE workspace_id = ? AND platform = 'tiktok'", ws["id"])
    assert ingest(client, h, platform="tiktok", account={"followers": 123}).status_code == 200
    c = next(c for c in client.get("/api/connections", headers=h).json() if c["platform"] == "tiktok")
    assert (c["status"], c["mode"], c["followers"], c["handle"]) == \
        ("connected", "sandbox", 123, "tiktok.com")


def test_ingest_into_disconnected_platform_is_409_and_writes_nothing(auth):
    client, h, _ = auth
    client.delete("/api/connections/linkedin", headers=h)
    r = ingest(client, h, account={"followers": 5}, posts=[
        {"content": "Should not be stored at all", "views": 1, "engagements": 1}])
    assert r.status_code == 409
    assert "disconnected" in r.json()["detail"] and "/api/connections/linkedin" in r.json()["detail"]
    assert q("SELECT COUNT(*) FROM metric_snapshots")[0][0] == 0
    assert harvested_count() == 0
    assert q("SELECT COUNT(*) FROM events WHERE type = 'harvested'")[0][0] == 0
    # the profile endpoint is the way back
    put_profile(client, h, "linkedin", "https://www.linkedin.com/in/jane")
    assert ingest(client, h, account={"followers": 5}).status_code == 200


def test_ingest_is_one_transaction_rolled_back_on_error(auth, monkeypatch):
    client, h, ws = auth

    def counts():
        return [q(sql, ws["id"])[0][0] for sql in (
            "SELECT COUNT(*) FROM posts WHERE workspace_id = ?",
            "SELECT COUNT(*) FROM metric_snapshots WHERE workspace_id = ?",
            "SELECT COUNT(*) FROM events WHERE workspace_id = ?",
            "SELECT SUM(followers) FROM connections WHERE workspace_id = ?",
            "SELECT SUM(views) FROM daily_metrics WHERE workspace_id = ?")]
    before, seen = counts(), {}

    def boom(conn, *args, **kwargs):
        seen["in_transaction"] = conn.in_transaction
        seen["created"] = conn.execute("SELECT COUNT(*) FROM posts WHERE source = ?", (HSRC,)).fetchone()[0]
        raise RuntimeError("boom")
    monkeypatch.setattr(metrics, "bump_daily", boom)
    with pytest.raises(RuntimeError):
        ingest(client, h, account={"followers": 1}, posts=[
            {"content": "Rollback me please, thanks a lot", "views": 10, "engagements": 1}])
    assert seen == {"in_transaction": True, "created": 1}  # the insert happened, inside the transaction
    assert counts() == before


# ---------------------------------------------------------------- snapshots listing and harvest status

def test_snapshots_listing_order_limit_filter_and_isolation(auth):
    client, h, _ = auth
    posts = [{"content": f"Snapshot listing post number {i}, long enough", "views": i, "engagements": 0}
             for i in (1, 2)]
    ingest(client, h, posts=posts, account={"followers": 100})
    ingest(client, h, platform="instagram", source="manual", posts=[
        {"content": "An Instagram caption that is long enough", "views": 9, "engagements": 1}])
    ids = [r["id"] for r in q("SELECT id FROM metric_snapshots ORDER BY rowid")]
    for i, sid in enumerate(ids):
        w("UPDATE metric_snapshots SET captured_at = ? WHERE id = ?", f"2026-11-0{i + 1}T00:00:00+00:00", sid)
    got = client.get("/api/metrics/snapshots", headers=h).json()
    assert [s["id"] for s in got] == ids[::-1]  # newest first
    assert set(got[0]) == {"id", "platform", "post_id", "views", "engagements", "clicks", "conversions",
                           "followers", "likes", "comments", "shares", "source", "captured_at"}
    assert [s["id"] for s in client.get("/api/metrics/snapshots?limit=2", headers=h).json()] == ids[::-1][:2]
    li = client.get("/api/metrics/snapshots?platform=linkedin", headers=h).json()
    assert [s["id"] for s in li] == ids[:3][::-1] and {s["platform"] for s in li} == {"linkedin"}
    ig = client.get("/api/metrics/snapshots?platform=instagram", headers=h).json()
    assert [(s["source"], s["views"]) for s in ig] == [("manual", 9)]
    for bad in ("?platform=myspace", "?limit=0", "?limit=501"):
        assert client.get("/api/metrics/snapshots" + bad, headers=h).status_code == 422
    h2, _ = second_workspace(client)
    assert client.get("/api/metrics/snapshots", headers=h2).json() == []
    ingest(client, h2, account={"followers": 5})
    assert len(client.get("/api/metrics/snapshots", headers=h2).json()) == 1
    assert len(client.get("/api/metrics/snapshots?limit=500", headers=h).json()) == 4


def test_harvest_status_before_and_after(auth):
    client, h, _ = auth
    before = client.get("/api/connections/harvest-status", headers=h).json()
    assert [s["platform"] for s in before] == list(PLATFORMS)
    assert all(s == {"platform": s["platform"], "connected": True, "profile_url": None,
                     "last_harvest_at": None, "last_source": None, "followers": None,
                     "real_posts": 0, "snapshots": 0} for s in before)
    put_profile(client, h, "linkedin", "https://www.linkedin.com/company/acme/")
    li = ingest(client, h, source="claude_chrome", account={"followers": 3300}, posts=[
        {"content": "A real LinkedIn post, long enough", "views": 5, "engagements": 1},
        {"content": "Another real LinkedIn post, also long", "views": 6, "engagements": 1}])
    ig = ingest(client, h, platform="instagram", source="manual", posts=[
        {"content": "A real Instagram post, long enough", "views": 7, "engagements": 1}])
    ingest(client, h, account={"views": 99})  # no followers: the last known count stays
    client.delete("/api/connections/x", headers=h)
    after = {s["platform"]: s for s in client.get("/api/connections/harvest-status", headers=h).json()}
    assert after["linkedin"]["profile_url"] == "https://www.linkedin.com/company/acme/"
    assert (after["linkedin"]["last_source"], after["linkedin"]["followers"]) == ("script", 3300)
    assert (after["linkedin"]["real_posts"], after["linkedin"]["snapshots"]) == (2, 4)
    assert after["linkedin"]["last_harvest_at"] >= li.json()["captured_at"]
    assert after["instagram"] == {
        "platform": "instagram", "connected": True, "profile_url": None,
        "last_harvest_at": ig.json()["captured_at"], "last_source": "manual", "followers": None,
        "real_posts": 1, "snapshots": 1}
    assert after["x"]["connected"] is False and after["x"]["snapshots"] == 0
    assert all(after[p]["real_posts"] == 0 for p in ("tiktok", "reddit", "facebook"))
    h2, _ = second_workspace(client)
    assert all(s["snapshots"] == 0 for s in client.get("/api/connections/harvest-status", headers=h2).json())


# ---------------------------------------------------------------- helper unit tests

def test_normalise_url():
    n = harvest.normalise_url
    assert n("HTTPS://WWW.LinkedIn.com/posts/Acme_1/?utm=1#frag") == "https://linkedin.com/posts/Acme_1"
    assert n("https://www.linkedin.com/posts/x?a=b") == n("https://linkedin.com/posts/x/") == \
        "https://linkedin.com/posts/x"
    assert n("linkedin.com/posts/x") == "https://linkedin.com/posts/x"
    assert n("http://linkedin.com/posts/x") != n("https://linkedin.com/posts/x")
    assert n("https://linkedin.com/") == "https://linkedin.com"
    assert [n(v) for v in (None, "", "   ", "/relative/path", "http://[::1")] == [""] * 5


def test_normalise_text():
    n = harvest.normalise_text
    assert n("  Hello   WORLD\n again… ") == "hello world again"
    assert n("Great post that goes on ... see more") == "great post that goes on"
    assert n("Great post…see more") == n("Great post… more") == n("Great post See More") == "great post"
    assert n("Die Straße") == n("DIE   STRASSE")  # casefold: ß == ss
    assert n("We foresee more growth") == "we foresee more growth"
    assert n(None) == n("   ") == ""


def test_find_match_precedence_and_used():
    c = [cand("a", "e1", "https://x.com/a", "Alpha post that is long enough"),
         cand("b", "e2", "https://x.com/b", "Beta post that is long enough"),
         cand("c", None, "", "Gamma post that is long enough")]
    f = harvest.find_match
    assert f(c, external_id="e2", url="https://x.com/a", content="Alpha post that is long enough") == "b"
    assert f(c, external_id="nope", url="https://www.x.com/a/?q=1", content="Beta post that is long enough") \
        == "a"
    assert f(c, url="https://x.com/zzz", content="GAMMA   post that is long enough…") == "c"
    assert f(c, external_id="e1", used={"a"}) is None
    assert f(c, external_id="e1", content="Alpha post that is long enough", used={"a"}) is None
    assert f(c, url="", external_id="", content="") is None  # empty keys never match empty keys
    assert f([], external_id="e1") is None


def test_find_match_content_prefix_rules():
    f = harvest.find_match
    long = "This is the full text of a post that was stored in Pulse"
    c = [cand("p", content=long)]
    assert f(c, content=long[:20]) == "p"                              # ingested text is a prefix
    assert f(c, content=long[:19]) is None                              # ...but at least 20 chars
    assert f(c, content=long + " and the feed appended more") == "p"   # stored text is a prefix
    assert f([cand("q", content="Tiny")], content="Tiny and more") is None  # shorter text under 20 chars
    assert f(c, content="Not related at all, entirely different") is None
    assert f([cand("x", content=long + " tail"), cand("y", content=long)], content=long) == "y"  # exact wins
    assert f([cand("x", content=long + " tail"), cand("y", content=long + " other")], content=long) == "x"


# ---------------------------------------------------------------- known problems outside this unit

def test_source_is_always_one_models_post_accepts():
    from typing import get_args

    from app.models import Post

    assert HSRC in get_args(Post.model_fields["source"].annotation)
    assert pick_source(("manual", "ai", "harvested")) == "harvested"
    assert pick_source(("manual", "ai", "autopilot", "seed")) == "manual"


def test_harvested_posts_stay_readable_via_posts_and_dashboard_api(auth):
    client, h, _ = auth
    ingest(client, h, posts=[{"external_id": "urn:top", "content": "A harvested post that tops the table",
                              "views": 9_999_999, "engagements": 100}])
    posts = client.get("/api/posts?limit=200", headers=h)
    assert posts.status_code == 200
    mine = [p for p in posts.json() if p["content"] == "A harvested post that tops the table"]
    assert len(mine) == 1 and mine[0]["views"] == 9_999_999 and mine[0]["status"] == "published"
    dash = client.get("/api/dashboard", headers=h)
    assert dash.status_code == 200 and dash.json()["top_posts"][0]["views"] == 9_999_999


def test_tick_leaves_real_posts_alone(auth):
    client, h, ws = auth
    ingest(client, h, posts=[{"external_id": "urn:real", "content": "A real post that must stay real",
                              "views": 1000, "engagements": 50}])
    hour_ago = iso_ago(hours=1)
    w("UPDATE posts SET published_at = ?, last_tick_at = ? WHERE external_id = 'urn:real'",
      hour_ago, hour_ago)
    conn = connect()
    try:
        metrics.tick(conn, ws["id"])
    finally:
        conn.close()
    row = by_external_id(ws, "urn:real")
    assert (row["views"], row["engagements"]) == (1000, 50)
