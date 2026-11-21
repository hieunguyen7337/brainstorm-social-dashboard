"""The engagement split in a demo workspace (docs/CONTRACT.md, "Engagement split"): the Engagements tile breaks into likes,
comments and shares, synthetically. Every platform with engagements is split with fixed ratios, so the parts always add up
to the tile and keep tracking as the simulated posts grow. Sample and real workspaces are untouched."""

import pytest

from app.services import demo
from tests.test_demo import make_demo, q
from tests.test_demo_posting import draft, publish, refresh

PARTS = ("likes", "comments", "shares", "other", "unsplit")


def sign_in(client, h, platform="instagram"):
    assert client.post(f"/api/connections/{platform}/demo", headers=h).status_code == 200


def dash(client, h):
    r = client.get("/api/dashboard?days=30", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def adds_up(d):
    split = d["engagement_split"]
    assert split is not None
    assert sum(split[k] for k in PARTS) == d["totals"]["engagements"]
    return split


# ---------------------------------------------------------------- the arithmetic

@pytest.mark.parametrize("platform", ["linkedin", "instagram", "x"])
def test_the_four_parts_always_add_up_to_the_total(platform):
    for total in list(range(120)) + [999, 1_000, 12_345, 98_765]:
        parts = demo.split_engagements(total, platform)
        assert sum(parts.values()) == total and all(v >= 0 for v in parts.values())
        assert list(parts) == ["likes", "comments", "shares", "other"]


def test_the_numbers_match_the_apps_mock():
    # pinned on both sides: apps/mobile/src/demo/logic.test.ts asserts the same literals
    assert demo.split_engagements(10_000, "instagram") == {"likes": 8600, "comments": 700, "shares": 400, "other": 300}
    assert demo.split_engagements(10_000, "linkedin") == {"likes": 7400, "comments": 1400, "shares": 900, "other": 300}
    assert demo.split_engagements(10, "instagram") == {"likes": 9, "comments": 1, "shares": 0, "other": 0}


def test_likes_lead_then_comments_then_shares():
    for platform in ("linkedin", "instagram"):
        p = demo.split_engagements(10_000, platform)
        assert p["likes"] > p["comments"] > p["shares"] > p["other"] > 0


def test_a_negative_or_empty_total_splits_to_zeros():
    assert demo.split_engagements(-5, "instagram") == {"likes": 0, "comments": 0, "shares": 0, "other": 0}
    assert demo.engagement_split({"instagram": {"engagements": 0}}) is None


# ---------------------------------------------------------------- the dashboard

def test_no_split_before_any_account_has_engagements(client):
    c, h, _ = make_demo(client)
    assert dash(c, h)["engagement_split"] is None


def test_the_split_appears_with_the_first_sign_in_and_adds_up(client):
    c, h, _ = make_demo(client)
    sign_in(c, h, "instagram")
    d = dash(c, h)
    split = adds_up(d)
    assert split["platforms"] == ["instagram"] and split["unsplit"] == 0
    assert split["likes"] > split["comments"] > split["shares"] > 0


def test_it_adds_up_with_two_platforms_and_after_posting_and_refreshing(client):
    c, h, _ = make_demo(client)
    sign_in(c, h, "instagram")
    post = publish(c, h, draft(c, h, "linkedin")["id"])  # signs LinkedIn in too
    refresh(c, h, post["id"], advance_minutes=20)
    d = dash(c, h)
    split = adds_up(d)
    assert split["platforms"] == ["linkedin", "instagram"] and split["unsplit"] == 0


def test_a_platform_filter_splits_only_that_platform(client):
    c, h, _ = make_demo(client)
    sign_in(c, h, "instagram")
    sign_in(c, h, "linkedin")
    d = c.get("/api/dashboard?days=30&platform=linkedin", headers=h).json()
    assert adds_up(d)["platforms"] == ["linkedin"]


def test_the_sign_in_snapshot_stores_the_split_like_a_real_read(client):
    c, h, ws = make_demo(client)
    sign_in(c, h, "linkedin")
    snap = q("SELECT engagements, likes, comments, shares FROM metric_snapshots WHERE workspace_id = ?"
             " AND post_id IS NULL", ws["id"])[0]
    assert snap["likes"] + snap["comments"] + snap["shares"] <= snap["engagements"]
    assert snap["likes"] > snap["comments"] > snap["shares"] > 0
    expected = demo.split_engagements(snap["engagements"], "linkedin")
    assert (snap["likes"], snap["comments"], snap["shares"]) == (
        expected["likes"], expected["comments"], expected["shares"])


# ---------------------------------------------------------------- a metrics read reports its split

def test_a_read_reports_the_gained_engagements_as_likes_comments_and_shares(client):
    c, h, ws = make_demo(client)
    post = publish(c, h, draft(c, h)["id"])
    read = refresh(c, h, post["id"], advance_minutes=30).json()
    gained = demo.split_engagements(read["engagements_gained"], "instagram")
    assert (read["likes_gained"], read["comments_gained"], read["shares_gained"]) == (
        gained["likes"], gained["comments"], gained["shares"])
    assert read["likes_gained"] + read["comments_gained"] + read["shares_gained"] <= read["engagements_gained"]
    detail = q("SELECT detail FROM events WHERE workspace_id = ? AND type = 'metrics' ORDER BY rowid DESC LIMIT 1",
               ws["id"])[0][0]
    assert "likes" in detail and "comments" in detail and "shares" in detail


# ---------------------------------------------------------------- other workspaces are untouched

def test_a_sample_workspace_has_no_split(auth):
    c, h, _ = auth
    assert dash(c, h)["engagement_split"] is None


def test_a_real_workspace_has_no_split_until_it_saves_one(client):
    ws = client.post("/api/workspaces", json={"real": True}).json()
    h = {"Authorization": f"Bearer {ws['token']}"}
    assert dash(client, h)["engagement_split"] is None
