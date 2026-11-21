"""Engagement split: the Engagements tile broken into likes, comments and shares
(DashboardSummary.engagement_split, docs/CONTRACT.md "Engagement split")."""

from types import SimpleNamespace

import pytest

from app.services import vision


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


def ingest(client, h, platform="instagram", period_days=30, posts=(), expect=200, **account):
    body = {"platform": platform, "source": "screenshot", "account": account, "posts": list(posts),
            "period_days": period_days}
    r = client.post("/api/metrics/ingest", headers=h, json=body)
    assert r.status_code == expect, r.text
    return r


def parts(split):
    return split["likes"] + split["comments"] + split["shares"] + split["other"] + split["unsplit"]


def test_the_three_numbers_alone_become_the_engagements_total(real):
    client, h, _ = real
    ingest(client, h, likes=120, comments=14, shares=6)
    d = dash(client, h)
    assert d["totals"]["engagements"] == 140
    assert d["tiles"]["engagements"] == 140
    assert d["engagement_split"] == {"likes": 120, "comments": 14, "shares": 6, "other": 0, "unsplit": 0,
                                     "platforms": ["instagram"]}


def test_a_total_larger_than_its_parts_keeps_the_rest_as_other(real):
    client, h, _ = real
    ingest(client, h, engagements=200, likes=120, comments=14, shares=6)  # 60 saves
    d = dash(client, h)
    assert d["totals"]["engagements"] == 200
    assert d["engagement_split"]["other"] == 60
    assert parts(d["engagement_split"]) == 200


def test_a_total_smaller_than_its_parts_is_raised_to_their_sum(real):
    client, h, _ = real
    ingest(client, h, engagements=100, likes=120, comments=14, shares=6)
    d = dash(client, h)
    assert d["totals"]["engagements"] == 140
    assert d["engagement_split"]["other"] == 0


def test_one_or_two_parts_are_enough_and_the_rest_read_as_zero(real):
    client, h, _ = real
    ingest(client, h, platform="linkedin", likes=300)
    d = dash(client, h)
    assert d["totals"]["engagements"] == 300
    assert d["engagement_split"] == {"likes": 300, "comments": 0, "shares": 0, "other": 0, "unsplit": 0,
                                     "platforms": ["linkedin"]}


def test_a_platform_that_only_reports_a_total_is_counted_as_unsplit(real):
    client, h, _ = real
    ingest(client, h, platform="instagram", likes=120, comments=14, shares=6)
    ingest(client, h, platform="tiktok", engagements=500)
    d = dash(client, h)
    s = d["engagement_split"]
    assert s["platforms"] == ["instagram"]
    assert (s["likes"], s["comments"], s["shares"], s["unsplit"]) == (120, 14, 6, 500)
    assert parts(s) == d["totals"]["engagements"] == 640


def test_no_split_saved_means_no_split(real):
    client, h, _ = real
    ingest(client, h, engagements=56, views=1234)
    assert dash(client, h)["engagement_split"] is None


def test_nothing_saved_means_no_split(real):
    client, h, _ = real
    assert dash(client, h)["engagement_split"] is None


def test_a_sample_workspace_has_no_split(auth):
    client, h, _ = auth
    d = dash(client, h)
    assert d["data_mode"] == "sample"
    assert d["engagement_split"] is None


def test_a_newer_total_without_a_split_replaces_the_older_split(real):
    """The split always belongs to the snapshot the total comes from: a later total-only save is not mixed with it."""
    client, h, _ = real
    ingest(client, h, likes=120, comments=14, shares=6)
    ingest(client, h, engagements=900)
    d = dash(client, h)
    assert d["totals"]["engagements"] == 900
    assert d["engagement_split"] is None


def test_a_newer_split_replaces_the_older_one(real):
    client, h, _ = real
    ingest(client, h, likes=120, comments=14, shares=6)
    ingest(client, h, likes=200, comments=20, shares=10)
    s = dash(client, h)["engagement_split"]
    assert (s["likes"], s["comments"], s["shares"]) == (200, 20, 10)


def test_a_split_for_a_longer_window_does_not_reach_a_shorter_dashboard(real):
    client, h, _ = real
    ingest(client, h, period_days=90, likes=500, comments=50, shares=5)
    assert dash(client, h, "?days=30")["engagement_split"] is None
    assert dash(client, h, "?days=90")["engagement_split"]["likes"] == 500


def test_the_platform_filter_narrows_the_split(real):
    client, h, _ = real
    ingest(client, h, platform="instagram", likes=120, comments=14, shares=6)
    ingest(client, h, platform="linkedin", likes=30, comments=9, shares=3)
    both = dash(client, h)["engagement_split"]
    assert (both["likes"], both["comments"], both["shares"]) == (150, 23, 9)
    assert both["platforms"] == ["linkedin", "instagram"] or both["platforms"] == ["instagram", "linkedin"]
    only = dash(client, h, "?platform=linkedin")["engagement_split"]
    assert (only["likes"], only["comments"], only["shares"], only["platforms"]) == (30, 9, 3, ["linkedin"])


def test_daily_numbers_above_the_snapshot_are_unsplit_so_the_parts_still_add_up(real):
    client, h, _ = real
    ingest(client, h, likes=10, comments=1, shares=1,
           posts=[{"content": "A post that did well", "views": 100, "engagements": 80}])
    d = dash(client, h)
    s = d["engagement_split"]
    assert d["totals"]["engagements"] == 80
    assert (s["likes"], s["comments"], s["shares"], s["unsplit"]) == (10, 1, 1, 68)
    assert parts(s) == 80


def test_negative_or_absurd_numbers_are_refused(real):
    client, h, _ = real
    ingest(client, h, likes=-1, expect=422)
    ingest(client, h, comments=10**13, expect=422)


def test_the_split_is_stored_per_snapshot_and_missing_parts_stay_null(real):
    client, h, _ = real
    ingest(client, h, likes=7)
    rows = client.get("/api/metrics/snapshots", headers=h)
    assert rows.status_code == 200, rows.text
    row = next(r for r in rows.json() if r["post_id"] is None)
    assert row["likes"] == 7 and row["comments"] is None and row["shares"] is None  # NULL, never read as 0
    assert row["engagements"] == 7


# ---------------------------------------------------------------- the screenshot reader


def _reading(**fields):
    base = {
        "detected_platform": "instagram", "handle": "acme", "followers": 1, "following": 2, "posts_count": 3,
        "views": 4, "engagements": None, "likes": -1, "comments": -1, "shares": -1, "profile_views": 5,
        "period_days": 30, "posts": [], "confidence": "high", "notes": None,
    }
    return SimpleNamespace(**{**base, **fields})


def test_screenshot_reading_passes_the_split_through():
    read = vision._sanitise("instagram", _reading(likes=1200, comments=88, shares=31))
    assert (read.likes, read.comments, read.shares, read.engagements) == (1200, 88, 31, None)


def test_screenshot_reading_turns_not_shown_into_null_and_keeps_a_real_zero():
    """Claude says -1 for "not shown" (plain integers keep the schema inside the API's limits); the app gets null."""
    read = vision._sanitise("instagram", _reading(likes=-1, comments=0, shares=-1))
    assert (read.likes, read.comments, read.shares) == (None, 0, None)


def test_screenshot_reading_ignores_a_split_of_nothing_but_zeros():
    """A model asked for -1 can still answer 0 for figures the screenshot does not show: all zeros means not shown."""
    read = vision._sanitise("instagram", _reading(engagements=410, likes=0, comments=0, shares=0))
    assert (read.likes, read.comments, read.shares, read.engagements) == (None, None, None, 410)
    kept = vision._sanitise("instagram", _reading(likes=0, comments=0, shares=3))
    assert (kept.likes, kept.comments, kept.shares) == (0, 0, 3)  # a zero next to a real number is a real zero


def test_screenshot_reading_drops_a_bad_split_number():
    read = vision._sanitise("instagram", _reading(likes=-5, comments=True, shares="12"))
    assert (read.likes, read.comments, read.shares) == (None, None, None)
    sparse = vision._sanitise("instagram", SimpleNamespace(followers=3))  # an answer without the keys at all
    assert (sparse.likes, sparse.comments, sparse.shares) == (None, None, None)


def test_the_split_fields_add_no_union_parameters_to_the_structured_output_schema():
    """The live API refuses more than 16 union-typed (nullable) parameters; the schema was already at 16, so the
    three new fields must be plain, required integers."""
    import anthropic

    schema = anthropic.transform_schema(vision.ScreenshotReading)
    for key in ("likes", "comments", "shares"):
        assert key in schema["required"]
        assert schema["properties"][key]["type"] == "integer" and "anyOf" not in schema["properties"][key]
