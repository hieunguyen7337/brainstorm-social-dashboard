"""Dashboard tiles: every number is the true number read from the platform, or an explicit "not read" state with
a short reason, never a placeholder 0 (DashboardSummary.tiles / .not_read)."""

import pytest

KEYS = ("views", "engagements", "clicks", "conversions")
NOT_READ = "Not read yet: open Connect to read"
PHOTO = "Instagram does not share views for photo posts"
NO_CLICK_LINK = "No tracked link yet: publish a post to count clicks"
NO_CONV_LINK = "No tracked link yet: publish a post to count conversions"


@pytest.fixture()
def real(client):
    r = client.post("/api/workspaces", json={"real": True})
    assert r.status_code == 200, r.text
    ws = r.json()
    return client, {"Authorization": f"Bearer {ws['token']}"}, ws


def dash(client, h, query=""):
    r = client.get(f"/api/dashboard{query}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def ingest(client, h, platform="instagram", posts=(), period_days=30, **account):
    body = {"platform": platform, "source": "screenshot", "account": account, "posts": list(posts),
            "period_days": period_days}
    r = client.post("/api/metrics/ingest", headers=h, json=body)
    assert r.status_code == 200, r.text


def publish(client, h, platform="instagram"):
    made = client.post("/api/posts", headers=h, json={"platform": platform, "content": "A post with a link"})
    assert made.status_code == 200, made.text
    post = client.post(f"/api/posts/{made.json()['id']}/publish", headers=h).json()
    assert post["status"] == "published" and post["link_code"]
    return post


def test_sample_workspace_tiles_are_the_totals(auth):
    client, h, _ = auth
    d = dash(client, h)
    assert d["data_mode"] == "sample"
    assert d["tiles"] == d["totals"] and d["not_read"] == {}
    assert dash(client, h, "?platform=linkedin")["tiles"] == dash(client, h, "?platform=linkedin")["totals"]


def test_real_workspace_with_nothing_connected_reads_nothing(real):
    client, h, _ = real
    d = dash(client, h)
    assert d["tiles"] == dict.fromkeys(KEYS)
    assert d["not_read"] == dict.fromkeys(KEYS, NOT_READ)
    assert d["totals"] == dict.fromkeys(KEYS, 0)  # totals unchanged for MCP and older clients


def test_instagram_followers_only_reads_no_metric(real):
    """The live bug: followers saved, views/engagements never read, no tracked link: no tile shows 0."""
    client, h, _ = real
    ingest(client, h, followers=46)
    d = dash(client, h)
    assert d["followers_total"] == 46
    assert d["tiles"] == dict.fromkeys(KEYS)
    assert d["not_read"] == {"views": NOT_READ, "engagements": NOT_READ,
                             "clicks": NO_CLICK_LINK, "conversions": NO_CONV_LINK}
    assert all(len(v) < 60 for v in d["not_read"].values())


def test_instagram_photo_posts_read_engagements_but_not_views(real):
    client, h, _ = real
    ingest(client, h, followers=46, posts=[{"content": "A photo", "views": 0, "engagements": 5}])
    d = dash(client, h)
    assert d["tiles"]["engagements"] == 5 and "engagements" not in d["not_read"]
    assert d["tiles"]["views"] is None and d["not_read"]["views"] == PHOTO


def test_instagram_reel_views_are_read(real):
    client, h, _ = real
    ingest(client, h, posts=[{"content": "A reel", "views": 120, "engagements": 9}])
    d = dash(client, h)
    assert (d["tiles"]["views"], d["tiles"]["engagements"]) == (120, 9)
    assert "views" not in d["not_read"] and "engagements" not in d["not_read"]


def test_zero_views_on_a_platform_that_shares_post_views_is_a_real_zero(real):
    client, h, _ = real
    ingest(client, h, platform="linkedin", posts=[{"content": "A post", "views": 0, "engagements": 0}])
    d = dash(client, h)
    assert (d["tiles"]["views"], d["tiles"]["engagements"]) == (0, 0)


def test_account_snapshot_views_are_read_when_their_window_fits(real):
    client, h, _ = real
    ingest(client, h, followers=46, views=1234)  # last 30 days
    d = dash(client, h)
    assert d["tiles"]["views"] == 1234 and d["tiles"]["engagements"] is None
    week = dash(client, h, "?days=7")  # a 30-day number is not this week's: not read, never a false 0
    assert week["tiles"]["views"] is None and week["not_read"]["views"] == NOT_READ


def test_tracked_link_makes_clicks_and_conversions_real_zeros_then_counts_a_click(real):
    client, h, _ = real
    ingest(client, h, followers=46)
    post = publish(client, h)
    d = dash(client, h)
    assert (d["tiles"]["clicks"], d["tiles"]["conversions"]) == (0, 0)
    assert "clicks" not in d["not_read"] and "conversions" not in d["not_read"]
    assert d["tiles"]["views"] is None  # a Pulse post's simulated 0 views are not a read
    assert client.get(f"/r/{post['link_code']}", follow_redirects=False).status_code == 302
    d = dash(client, h)
    assert (d["tiles"]["clicks"], d["tiles"]["conversions"]) == (1, 0)
    assert d["real_clicks"] == 1


def test_real_click_without_connection_is_never_hidden(real):
    client, h, _ = real
    made = client.post("/api/posts", headers=h, json={"platform": "instagram", "content": "Draft link"}).json()
    assert client.get(f"/r/{made['link_code']}", follow_redirects=False).status_code == 302
    d = dash(client, h)
    assert d["tiles"]["clicks"] == 1 and d["tiles"]["conversions"] is None
    assert d["not_read"]["conversions"] == NOT_READ


def test_platform_filter_is_respected(real):
    client, h, _ = real
    ingest(client, h, platform="linkedin", views=100, engagements=2)
    ingest(client, h, followers=46)
    publish(client, h, "linkedin")
    d = dash(client, h)
    assert d["tiles"] == {"views": 100, "engagements": 2, "clicks": 0, "conversions": 0}
    li = dash(client, h, "?platform=linkedin")
    assert li["tiles"] == {"views": 100, "engagements": 2, "clicks": 0, "conversions": 0}
    assert li["not_read"] == {}
    ig = dash(client, h, "?platform=instagram")
    assert ig["tiles"] == dict.fromkeys(KEYS)
    assert ig["not_read"] == {"views": NOT_READ, "engagements": NOT_READ,
                              "clicks": NO_CLICK_LINK, "conversions": NO_CONV_LINK}
    tt = dash(client, h, "?platform=tiktok")
    assert tt["tiles"] == dict.fromkeys(KEYS) and tt["not_read"] == dict.fromkeys(KEYS, NOT_READ)
