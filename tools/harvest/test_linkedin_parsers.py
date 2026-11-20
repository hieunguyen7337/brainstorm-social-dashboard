"""Tests for tools/harvest/linkedin.py. Pure: no network, no browser, no real waiting.

The HTML fixtures in fixtures/linkedin_*.html are hand-written approximations of LinkedIn's markup, not
captures (each says so at the top), so these tests prove the parsers' logic, not that they match the live site.
"""

import json
import os
import re
import sys
import time
from datetime import UTC, datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(__file__))

import common
import linkedin

HERE = os.path.dirname(__file__)
NOW = datetime(2026, 11, 20, 12, 34, 56, tzinfo=UTC)
PROFILE = "https://www.linkedin.com/in/alex-rivera-demo/"
ACTIVITY = "https://www.linkedin.com/in/alex-rivera-demo/recent-activity/all/"

# ids used by the fixtures
ID_B, ID_A, ID_C, ID_D, ID_G = (
    "7263400000000000002",
    "7263100000000000001",
    "7261200000000000003",
    "7259900000000000004",
    "7213300000000000005",
)
ID_SQLITE = "7255500000000000077"


def fixture(name: str) -> str:
    with open(os.path.join(HERE, "fixtures", f"linkedin_{name}.html"), encoding="utf-8") as fh:
        return fh.read()


def by_id(posts: list[dict]) -> dict[str, dict]:
    return {p["external_id"]: p for p in posts}


def card_html(
    n: int, *, text: str | None = None, age: str = "2d •", extra: str = "", views: str = "100 impressions"
) -> str:
    body = text if text is not None else f"Post number {n} about shipping things"
    return (
        f'<div class="feed-shared-update-v2" data-urn="urn:li:activity:72{n:017d}">'
        f'<div class="update-components-actor"><span>Alex Rivera</span><span>{age}</span></div>'
        f'<div class="update-components-text"><span>{body}</span></div>{extra}'
        f'<div class="ca-entry-point"><strong>{views}</strong></div></div>'
    )


def one(**kw) -> dict:
    posts = linkedin.parse_recent_activity(card_html(1, **kw), now=NOW)
    assert len(posts) == 1
    return posts[0]


# ---------------------------------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://www.linkedin.com/in/alex-rivera-demo",
        "https://www.linkedin.com/in/alex-rivera-demo/",
        "https://www.linkedin.com/in/alex-rivera-demo/?utm_source=share&utm_medium=member_desktop",
        "https://www.linkedin.com/in/alex-rivera-demo/details/experience/",
        "http://linkedin.com/in/alex-rivera-demo/",
        "linkedin.com/in/alex-rivera-demo",
        "www.linkedin.com/in/alex-rivera-demo#about",
        "https://au.linkedin.com/in/alex-rivera-demo/recent-activity/all/",
        "  https://www.linkedin.com/in/alex-rivera-demo/  ",
    ],
)
def test_activity_url_personal_variants(url):
    assert linkedin.activity_url(url) == ACTIVITY
    assert linkedin.profile_page_url(url) == PROFILE


@pytest.mark.parametrize(
    "url",
    [
        "https://www.linkedin.com/company/pulse-labs",
        "https://www.linkedin.com/company/pulse-labs/",
        "https://linkedin.com/company/pulse-labs/about/?viewAsMember=true",
    ],
)
def test_activity_url_company(url):
    assert linkedin.activity_url(url) == "https://www.linkedin.com/company/pulse-labs/posts/?feedView=all"
    assert linkedin.profile_page_url(url) == "https://www.linkedin.com/company/pulse-labs/"


@pytest.mark.parametrize(
    "url",
    [
        "",
        "alex",
        "https://example.com/in/alex",
        "https://www.linkedin.com/feed/",
        "https://www.linkedin.com/in/",
    ],
)
def test_activity_url_rejects_non_profile_urls(url):
    with pytest.raises(common.HarvestError):
        linkedin.activity_url(url)


def test_creator_analytics_url_is_the_members_own_page():
    assert linkedin.ANALYTICS_URL == "https://www.linkedin.com/analytics/creator/content/"
    assert linkedin.creator_analytics_url() == linkedin.ANALYTICS_URL


# ---------------------------------------------------------------------------------------------------
# Login wall detection
# ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://www.linkedin.com/login",
        "https://www.linkedin.com/login?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Fin%2Falex",
        "https://www.linkedin.com/uas/login?session_redirect=x",
        "https://www.linkedin.com/authwall?trk=bf&sessionRedirect=x",
        "https://www.linkedin.com/checkpoint/challenge/AgE",
        "https://www.linkedin.com/signup/cold-join",
    ],
)
def test_looks_logged_out_by_url(url):
    assert linkedin.looks_logged_out(url, "") is True


def test_looks_logged_out_authwall_markup_even_on_a_normal_url():
    assert linkedin.looks_logged_out(ACTIVITY, fixture("authwall")) is True


@pytest.mark.parametrize("name", ["recent_activity", "creator_content", "profile", "edge_cases"])
def test_looks_logged_out_false_for_signed_in_pages(name):
    assert linkedin.looks_logged_out(ACTIVITY, fixture(name)) is False


def test_looks_logged_out_false_for_unknowns_and_lookalike_urls():
    assert linkedin.looks_logged_out(ACTIVITY, "") is False
    assert linkedin.looks_logged_out("", "") is False
    assert linkedin.looks_logged_out(ACTIVITY, "<<<garbage>>><div") is False
    assert (
        linkedin.looks_logged_out(
            "https://www.linkedin.com/in/jo-login/recent-activity/all/", "<html></html>"
        )
        is False
    )
    # a post that merely says "Sign in" / "Join now", on a page with signed-in chrome, is not a wall
    assert (
        linkedin.looks_logged_out(ACTIVITY, "<div class='global-nav'></div><p>Sign in</p><p>Join now</p>")
        is False
    )


def test_looks_logged_out_sign_in_and_join_now_lines_without_form():
    html = "<header><a>Sign in</a><a>Join now</a></header><p>Some public page</p>"
    assert linkedin.looks_logged_out(ACTIVITY, html) is True
    assert linkedin.looks_logged_out(ACTIVITY, "<header><a>Sign in</a></header>") is False


# ---------------------------------------------------------------------------------------------------
# parse_recent_activity
# ---------------------------------------------------------------------------------------------------


def test_recent_activity_fixture_posts_in_page_order():
    posts = linkedin.parse_recent_activity(fixture("recent_activity"))
    assert [p["external_id"] for p in posts] == [ID_B, ID_A, ID_C, ID_D, ID_G]
    for p in posts:
        assert p["url"] == f"https://www.linkedin.com/feed/update/urn:li:activity:{p['external_id']}/"
        assert isinstance(p["views"], int) and isinstance(p["engagements"], int)
        assert "posted_at" not in p  # no `now`, no dates


def test_recent_activity_skips_unrecognised_and_foreign_cards():
    html = fixture("recent_activity")
    ids = {p["external_id"] for p in linkedin.parse_recent_activity(html)}
    assert "7262900000000000099" not in ids  # "Alex Rivera likes this": somebody else's post
    assert "7262999999999999001" not in ids  # aggregate urn promo card
    assert all("Premium" not in (p.get("content") or "") for p in linkedin.parse_recent_activity(html))


def test_recent_activity_k_abbreviated_counts_and_hashtags():
    a = by_id(linkedin.parse_recent_activity(fixture("recent_activity")))[ID_A]
    assert a["views"] == 12_400  # "12.4K impressions"
    assert a["engagements"] == 1_200 + 86 + 14  # "1.2K reactions" + "86 comments" + "14 reposts"
    assert a["content"].startswith("Shipped our Pulse demo this week.")
    assert a["content"].endswith(
        "#hackathon #buildinpublic"
    )  # no "hashtag" screen-reader words, no "see more"
    assert "see more" not in a["content"].lower()


def test_recent_activity_zero_comments_row_missing_and_class_only_reaction_count():
    b = by_id(linkedin.parse_recent_activity(fixture("recent_activity")))[ID_B]
    assert b["views"] == 1_204
    assert (
        b["engagements"] == 9 + 2
    )  # reactions from the bare "9" next to the icons, no comments row, 2 reposts


def test_recent_activity_singular_nouns_and_id_from_feed_update_link():
    c = by_id(linkedin.parse_recent_activity(fixture("recent_activity")))[ID_C]  # no data-urn on this card
    assert c["views"] == 867  # number in its own <span class="t-bold">
    assert c["engagements"] == 23 + 4 + 1  # "1 repost"


def test_recent_activity_entities_emoji_and_counts_only_in_aria_labels():
    d = by_id(linkedin.parse_recent_activity(fixture("recent_activity")))[ID_D]
    assert (
        d["content"]
        == 'Lessons from our first 100 users & what we got wrong \U0001f680 "Ship it" isn’t a strategy. Thread below.'
    )
    assert d["views"] == 2_300
    assert d["engagements"] == 87 + 12 + 3


def test_recent_activity_missing_impressions_gives_zero_views_and_keeps_the_rest():
    g = by_id(linkedin.parse_recent_activity(fixture("recent_activity")))[
        ID_G
    ]  # id only from a /posts/...-activity-<id>- link
    assert g["views"] == 0
    assert g["engagements"] == 7
    assert g["content"] == "Reflecting on a year of building in public. Thank you all."


def test_recent_activity_posted_at_only_with_now():
    posts = by_id(linkedin.parse_recent_activity(fixture("recent_activity"), now=NOW))
    assert posts[ID_B]["posted_at"] == "2026-11-20T07:00:00Z"  # 5h, hour precision
    assert posts[ID_A]["posted_at"] == "2026-11-18T00:00:00Z"  # "2d • Edited"
    assert posts[ID_C]["posted_at"] == "2026-10-30T00:00:00Z"  # 3w
    assert posts[ID_D]["posted_at"] == "2026-10-21T00:00:00Z"  # 1mo = 30 days
    assert posts[ID_G]["posted_at"] == "2025-11-20T00:00:00Z"  # 1yr = 365 days
    assert all("posted_at" not in p for p in linkedin.parse_recent_activity(fixture("recent_activity")))


@pytest.mark.parametrize(
    ("age", "expected"),
    [
        ("5m •", "2026-11-20T12:29:00Z"),
        ("3h •", "2026-11-20T09:00:00Z"),
        ("2d •", "2026-11-18T00:00:00Z"),
        ("1w • Edited •", "2026-11-13T00:00:00Z"),
        ("1mo •", "2026-10-21T00:00:00Z"),
        ("2mo •", "2026-09-21T00:00:00Z"),
        ("1yr •", "2025-11-20T00:00:00Z"),
        ("2y •", "2024-11-20T00:00:00Z"),
        ("2 days ago", "2026-11-18T00:00:00Z"),
        ("3 weeks ago • Edited", "2026-10-30T00:00:00Z"),
        ("2d", "2026-11-18T00:00:00Z"),
        ("now •", "2026-11-20T12:34:00Z"),
    ],
)
def test_relative_age_tokens(age, expected):
    assert one(age=age)["posted_at"] == expected


def test_relative_age_ignores_lookalikes_and_handles_odd_now_values():
    assert "posted_at" not in one(age="Engineer at 3M •")  # "3M" is a company, not three minutes
    assert "posted_at" not in one(age="Founder")
    aware = datetime(2026, 11, 20, 22, 0, tzinfo=timezone(timedelta(hours=10)))  # 12:00 UTC
    naive = datetime(2026, 11, 20, 12, 0)
    for now in (aware, naive):
        posts = linkedin.parse_recent_activity(card_html(1), now=now)
        assert posts[0]["posted_at"] == "2026-11-18T00:00:00Z"


def test_recent_activity_edge_fixture_long_text_and_body_counts_not_leaked():
    posts = by_id(linkedin.parse_recent_activity(fixture("edge_cases"), now=NOW))
    x1 = posts["7270000000000000011"]
    assert len(x1["content"]) == 280
    assert x1["content"].startswith(
        "Thread on how we onboard new members. Step 1: Sign in Step 2: Join now We got 500 comments"
    )
    assert "  " not in x1["content"]
    assert x1["views"] == 1_500_000  # "1.5M impressions", not the "12 impressions per tweet" in the body
    assert (
        x1["engagements"] == 87 + 1 + 1
    )  # "You and 86 others", "1 comment", "1 repost"; the body's "500 comments" is ignored
    assert x1["posted_at"] == "2026-11-13T00:00:00Z"


def test_recent_activity_edge_fixture_double_encoded_entities_and_explicit_zeros():
    x2 = by_id(linkedin.parse_recent_activity(fixture("edge_cases"), now=NOW))["7270000000000000012"]
    assert x2["content"] == 'Fish & chips \U0001f680 for lunch, "again"'
    assert x2["views"] == 0
    assert x2["engagements"] == 5  # "0 comments" and "0 reposts" count as zero
    assert x2["posted_at"] == "2026-11-20T12:34:00Z"  # "now •"


def test_recent_activity_max_posts_cap():
    html = "".join(card_html(i) for i in range(1, 41))
    assert len(linkedin.parse_recent_activity(html)) == 30  # default cap
    assert len(linkedin.parse_recent_activity(html, max_posts=100)) == 30  # never above 30
    posts = linkedin.parse_recent_activity(html, max_posts=5)
    assert [p["external_id"] for p in posts] == [f"72{n:017d}" for n in range(1, 6)]
    assert linkedin.parse_recent_activity(html, max_posts=0) == []


def test_recent_activity_duplicate_and_nested_cards_count_once():
    inner = card_html(2, text="Original post that was reshared by Alex")
    outer = (
        f'<div class="feed-shared-update-v2" data-urn="urn:li:activity:{"72" + "1".zfill(17)}">'
        f'<div class="update-components-text"><span>My take on this repost</span></div>{inner}</div>'
    )
    posts = linkedin.parse_recent_activity(
        outer + card_html(1), now=NOW
    )  # same id as the outer card, repeated
    assert [p["external_id"] for p in posts] == ["72" + "1".zfill(17)]
    assert posts[0]["content"] == "My take on this repost"


@pytest.mark.parametrize(
    "href",
    [
        "/feed/update/urn:li:activity:7263100000000000001/",
        "https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7263100000000000001/",
        "https://www.linkedin.com/posts/alex_some-title-words-activity-7263100000000000001-AbCd?utm_source=share",
    ],
)
def test_recent_activity_id_from_link_forms(href):
    html = (
        f'<div class="feed-shared-update-v2"><a href="{href}">2d •</a>'
        '<div class="update-components-text">Hello from a card without a data-urn</div></div>'
    )
    (post,) = linkedin.parse_recent_activity(html)
    assert post["external_id"] == "7263100000000000001"
    assert post["content"] == "Hello from a card without a data-urn"


def test_recent_activity_content_fallback_when_no_known_text_container():
    html = (
        '<div class="feed-shared-update-v2" data-urn="urn:li:activity:7263100000000000001">'
        "<span>Alex Rivera</span><p>A post body inside an unfamiliar container class, long enough to win.</p>"
        "<p>2d •</p><p>14 reactions</p><p>Like</p></div>"
    )
    (post,) = linkedin.parse_recent_activity(html, now=NOW)
    assert post["content"] == "A post body inside an unfamiliar container class, long enough to win."
    assert post["engagements"] == 14
    assert post["posted_at"] == "2026-11-18T00:00:00Z"


def test_garbage_and_empty_html_never_raise():
    deep = "<div>" * 6000 + "text" + "</div>" * 10
    for junk in (
        "",
        "   ",
        "<<<>>>",
        "<div class=",
        "</div></span>",
        "\x00\x01\x02",
        "plain text",
        deep,
        "<a href=>x</a>",
    ):
        assert linkedin.parse_recent_activity(junk, now=NOW) == []
        assert linkedin.parse_creator_content(junk) == {"account": {}, "posts": []}
        assert linkedin.parse_followers(junk) is None
        assert linkedin.looks_logged_out(PROFILE, junk) is False
    assert linkedin.parse_recent_activity(None) == []  # type: ignore[arg-type]


# ---------------------------------------------------------------------------------------------------
# parse_creator_content / parse_followers
# ---------------------------------------------------------------------------------------------------


def test_creator_content_account_totals():
    creator = linkedin.parse_creator_content(fixture("creator_content"))
    assert creator["account"] == {"views": 45_308, "engagements": 640 + 88 + 31, "followers": 3_412}


def test_creator_content_top_posts():
    posts = by_id(linkedin.parse_creator_content(fixture("creator_content"))["posts"])
    assert list(posts) == [ID_A, ID_D, ID_SQLITE]
    assert (posts[ID_A]["views"], posts[ID_A]["engagements"]) == (15_100, 1_310 + 90 + 15)
    assert (posts[ID_D]["views"], posts[ID_D]["engagements"]) == (2_450, 91 + 13 + 4)
    assert (posts[ID_SQLITE]["views"], posts[ID_SQLITE]["engagements"]) == (1_980, 55 + 6)  # no reposts row
    assert posts[ID_SQLITE]["url"] == f"https://www.linkedin.com/feed/update/urn:li:activity:{ID_SQLITE}/"
    assert posts[ID_SQLITE]["content"].startswith("Why we chose SQLite")
    assert posts[ID_D]["content"] == "Lessons from our first 100 users & what we got wrong"


def test_creator_content_totals_do_not_include_top_post_numbers():
    html = '<div><span>Impressions</span><span>1,000</span></div><ul><li data-urn="urn:li:activity:7263100000000000001">Text of a post here<span>999,999 impressions</span></li></ul>'
    creator = linkedin.parse_creator_content(html)
    assert creator["account"] == {"views": 1_000}
    assert creator["posts"][0]["views"] == 999_999


@pytest.mark.parametrize(
    ("html", "engagements"),
    [
        (
            "<div>Reactions 10</div><div>Comments 5</div><div>Reposts 2</div><div>Engagements 99</div>",
            17,
        ),  # all three: the sum
        ("<div>Engagements 99</div><div>Reactions 10</div>", 99),  # explicit total beats a partial sum
        ("<div>Reactions 10</div><div>Comments 5</div>", 15),  # whichever of the three exist
        ("<div>2.5K Engagements</div>", 2_500),
        ("<div>Impressions 7</div>", None),
    ],
)
def test_creator_content_engagement_rules(html, engagements):
    account = linkedin.parse_creator_content(html)["account"]
    assert account.get("engagements") == engagements
    if engagements is None:
        assert account == {"views": 7}


def test_creator_content_label_and_number_layouts_and_k_suffix():
    assert linkedin.parse_creator_content("<div><p>12.4K</p><p>Impressions</p></div>")["account"] == {
        "views": 12_400
    }
    assert linkedin.parse_creator_content("<div><span>Impressions</span><span>3,3M</span></div>")[
        "account"
    ] == {"views": 3_300_000}
    assert linkedin.parse_creator_content("<div>Profile viewers 212</div>")["account"] == {
        "profile_views": 212
    }


@pytest.mark.parametrize(
    ("html", "expected"),
    [
        ("<li>1,234 followers</li>", 1_234),
        ("<li>3.4K followers &bull; 500+ connections</li>", 3_400),
        ("<div>Followers 1,234</div>", 1_234),
        ("<span class='t-bold'>1,234</span> followers", 1_234),
        ("<h2>Followers</h2><div>1,234</div>", 1_234),
        ("<p>1 follower</p>", 1),
        ("<p>12M followers</p>", 12_000_000),
        ("<p>0 followers</p>", 0),
        ("<p>1 234 followers</p>", 1_234),
        ("<p>1.234 followers</p>", 1_234),
        ("<button aria-label='5,678 followers'></button>", 5_678),
        ("<p>You follow 12 people</p>", None),
        ("<p>Followers</p>", None),
    ],
)
def test_parse_followers(html, expected):
    assert linkedin.parse_followers(html) == expected


def test_parse_followers_profile_fixture_first_match_and_ignores_hidden_json_and_scripts():
    assert (
        linkedin.parse_followers(fixture("profile")) == 3_412
    )  # not 9,999 (script / hidden code), not 1.2K (aside)


# ---------------------------------------------------------------------------------------------------
# merge_posts / build_payload
# ---------------------------------------------------------------------------------------------------


def p(eid=None, url=None, content=None, views=0, engagements=0, **extra):
    d = {"views": views, "engagements": engagements, **extra}
    for k, v in (("external_id", eid), ("url", url), ("content", content)):
        if v is not None:
            d[k] = v
    return d


def test_merge_by_id_analytics_views_win_when_positive_and_engagements_take_the_larger():
    merged = linkedin.merge_posts(
        [p("1", views=500, engagements=40, content="x")], [p("1", views=900, engagements=30)]
    )
    assert merged == [{"external_id": "1", "content": "x", "views": 900, "engagements": 40}]
    merged = linkedin.merge_posts([p("1", views=500, engagements=40)], [p("1", views=0, engagements=50)])
    assert (
        merged[0]["views"] == 500 and merged[0]["engagements"] == 50
    )  # analytics 0 never wipes a real number


def test_merge_fills_missing_fields_and_keeps_activity_values():
    activity = [p("1", content="from activity", posted_at="2026-11-18T00:00:00Z")]
    analytics = [
        p(
            "1",
            url="https://www.linkedin.com/feed/update/urn:li:activity:1/",
            content="other",
            views=7,
            clicks=3,
        )
    ]
    (m,) = linkedin.merge_posts(activity, analytics)
    assert m["content"] == "from activity" and m["posted_at"] == "2026-11-18T00:00:00Z"
    assert m["url"].endswith("urn:li:activity:1/") and m["clicks"] == 3 and m["views"] == 7


def test_merge_by_url_when_ids_are_missing_ignoring_query_and_trailing_slash():
    a = [p(url="https://www.linkedin.com/posts/x-activity-1-Ab/", views=1)]
    b = [p(url="https://www.linkedin.com/posts/x-activity-1-Ab?utm_source=share", views=9)]
    merged = linkedin.merge_posts(a, b)
    assert len(merged) == 1 and merged[0]["views"] == 9


def test_merge_derives_id_from_url_so_url_only_and_id_only_records_meet():
    a = [p("7263100000000000001", views=1)]
    b = [p(url="https://www.linkedin.com/posts/x-activity-7263100000000000001-Ab", views=9)]
    assert len(linkedin.merge_posts(a, b)) == 1


def test_merge_by_content_prefix_casefolded_but_not_across_different_ids():
    text = "Lessons from our first 100 users and what we got wrong"
    merged = linkedin.merge_posts(
        [p(content=text, views=1)], [p(content=text.upper() + " (more words)", views=9)]
    )
    assert len(merged) == 1 and merged[0]["views"] == 9
    both_ids = linkedin.merge_posts([p("1", content=text)], [p("2", content=text)])
    assert [m["external_id"] for m in both_ids] == ["1", "2"]
    short = linkedin.merge_posts([p(content="Thanks!")], [p(content="Thanks!")])
    assert len(short) == 2  # too short to match on text alone


def test_merge_keeps_the_union_activity_first_then_analytics_only():
    merged = linkedin.merge_posts([p("a"), p("b")], [p("c"), p("a", views=5)])
    assert [m["external_id"] for m in merged] == ["a", "b", "c"]


def test_merge_dedupes_within_each_list_and_does_not_mutate_inputs():
    activity = [p("1", views=5), p("1", views=8)]
    analytics = [p("2", views=3), p("2", views=4)]
    snapshot = json.dumps([activity, analytics], sort_keys=True)
    merged = linkedin.merge_posts(activity, analytics)
    assert [(m["external_id"], m["views"]) for m in merged] == [("1", 8), ("2", 4)]
    assert json.dumps([activity, analytics], sort_keys=True) == snapshot


def test_merge_caps_at_30_and_tolerates_empty_input():
    many = [p(str(i)) for i in range(25)]
    assert len(linkedin.merge_posts(many, [p(str(100 + i)) for i in range(25)])) == 30
    assert linkedin.merge_posts([], []) == []
    assert linkedin.merge_posts(None, None) == []  # type: ignore[arg-type]
    assert [m["external_id"] for m in linkedin.merge_posts([], [p("z")])] == ["z"]


def test_merge_fixtures_two_overlapping_posts():
    activity = linkedin.parse_recent_activity(fixture("recent_activity"))
    creator = linkedin.parse_creator_content(fixture("creator_content"))
    merged = by_id(linkedin.merge_posts(activity, creator["posts"]))
    assert len(merged) == 6  # 5 on the activity page + 1 analytics-only
    assert merged[ID_A]["views"] == 15_100  # analytics wins
    assert merged[ID_A]["engagements"] == 1_415  # larger of 1,300 and 1,415
    assert merged[ID_A]["content"].startswith(
        "Shipped our Pulse demo this week. Three days"
    )  # activity text kept
    assert merged[ID_D]["views"] == 2_450
    assert merged[ID_SQLITE]["views"] == 1_980
    assert merged[ID_B]["views"] == 1_204  # untouched


def test_build_payload_shape_and_json_round_trip():
    activity = linkedin.parse_recent_activity(fixture("recent_activity"), now=NOW)
    creator = linkedin.parse_creator_content(fixture("creator_content"))
    payload = linkedin.build_payload(activity, creator, 3_412)
    assert set(payload) == {"account", "posts"}
    assert payload["account"] == {"views": 45_308, "engagements": 759, "followers": 3_412}
    assert len(payload["posts"]) == 6
    allowed = {"external_id", "url", "content", "posted_at", "views", "engagements", "clicks", "conversions"}
    for post in payload["posts"]:
        assert set(post) <= allowed
        assert type(post["views"]) is int and type(post["engagements"]) is int
        assert post["views"] >= 0 and post["engagements"] >= 0
    assert json.loads(json.dumps(payload)) == payload


def test_build_payload_without_creator_or_followers_omits_unknown_numbers():
    payload = linkedin.build_payload([p("1", views=3, engagements=1)], None, None)
    assert payload == {"account": {}, "posts": [{"external_id": "1", "views": 3, "engagements": 1}]}
    assert linkedin.build_payload([], {}, None) == {"account": {}, "posts": []}
    assert linkedin.build_payload([], {"account": {"followers": 10}}, None)["account"] == {"followers": 10}


def test_build_payload_explicit_followers_win_and_junk_values_are_dropped():
    creator = {
        "account": {
            "followers": 10,
            "views": "n/a",
            "engagements": True,
            "clicks": -4,
            "profile_views": 2.9,
            "bogus": 1,
        }
    }
    account = linkedin.build_payload([], creator, 99)["account"]
    assert account == {"clicks": 0, "profile_views": 2, "followers": 99}
    post = {
        "external_id": 12345,
        "url": " ",
        "views": "5",
        "engagements": None,
        "secret": "x",
        "content": "  hi  ",
    }
    (out,) = linkedin.build_payload([post], None, None)["posts"]
    assert out == {"external_id": "12345", "content": "hi", "views": 5, "engagements": 0}


def test_every_fixture_says_it_is_a_hand_written_approximation():
    for name in ("recent_activity", "creator_content", "profile", "authwall", "edge_cases"):
        head = fixture(name)[:1500]
        assert "HAND-WRITTEN APPROXIMATION" in head and "NOT a capture" in head


def test_module_does_not_import_playwright_or_third_party_parsers():
    with open(os.path.join(HERE, "linkedin.py"), encoding="utf-8") as fh:
        src = fh.read()
    for banned in ("playwright", "bs4", "lxml", "requests", "httpx"):
        assert not re.search(rf"^\s*(import|from)\s+{banned}\b", src, re.MULTILINE)
    assert not hasattr(linkedin, "playwright")


# ---------------------------------------------------------------------------------------------------
# harvest() with fake Playwright objects (no browser, no waiting)
# ---------------------------------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, status):
        self.status = status


class FakeMouse:
    def __init__(self, page):
        self.page = page

    def wheel(self, dx, dy):
        assert dx == 0 and 600 <= dy <= 900
        self.page.wheels.append(dy)
        self.page.scrolled += 1


class FakeLocator:
    def __init__(self, page, count):
        self.page, self._count = page, count

    def count(self):
        return self._count

    @property
    def first(self):
        return self

    def click(self, **kw):
        self.page.clicks.append("show-more")


class FakePage:
    """routes: url -> html | [html per scroll step] | Exception | (status, html)."""

    def __init__(self, routes, redirects=None, show_more=0):
        self.routes, self.redirects, self.show_more = routes, redirects or {}, show_more
        self.url = "about:blank"
        self.visited, self.wheels, self.clicks, self.roles, self.waits = [], [], [], [], []
        self.closed = False
        self.scrolled = 0
        self.status = 200
        self._html = ""
        self.mouse = FakeMouse(self)

    def goto(self, url, wait_until=None, timeout=None):
        assert wait_until == "domcontentloaded"
        self.visited.append(url)
        route = self.routes.get(url, "")
        if isinstance(route, Exception):
            raise route
        self.status = 200
        if isinstance(route, tuple):
            self.status, route = route
        self.url, self._html, self.scrolled = self.redirects.get(url, url), route, 0
        return FakeResponse(self.status)

    def content(self):
        if isinstance(self._html, list):
            return self._html[min(self.scrolled, len(self._html) - 1)]
        return self._html

    def wait_for_selector(self, selector, timeout=None):
        self.waits.append(selector)
        raise TimeoutError("not there")  # harvest must treat this as "keep going"

    def get_by_role(self, role, name=None):
        self.roles.append((role, name))
        return FakeLocator(self, self.show_more)

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, page=None):
        self.page = page
        self.opened = 0

    def new_page(self):
        self.opened += 1
        return self.page

    def close(self):
        raise AssertionError("harvest must never close the user's browser context")


def activity_pages(*counts):
    """Scroll snapshots with `n` cards each (a growing page)."""
    return [linkedin_cards(n) for n in counts]


def linkedin_cards(n):
    return "<div class='global-nav'></div>" + "".join(card_html(i) for i in range(1, n + 1))


@pytest.fixture
def no_real_sleep(monkeypatch):
    def boom(_s):
        raise AssertionError("real time.sleep was called")

    monkeypatch.setattr(time, "sleep", boom)


def run(routes, url=PROFILE, **kw):
    page = FakePage(routes, **{k: kw.pop(k) for k in ("redirects", "show_more") if k in kw})
    sleeps, logs = [], []
    ctx = FakeContext(page)
    kw.setdefault("now", NOW)
    try:
        result = linkedin.harvest(ctx, url, log=logs.append, sleep=sleeps.append, **kw)
    except Exception as exc:  # noqa: BLE001 - tests inspect the page after any failure
        result = exc
    return result, page, ctx, sleeps, logs


def test_harvest_happy_path_merges_activity_and_analytics_and_closes_the_page(no_real_sleep):
    routes = {
        ACTIVITY: [fixture("recent_activity")],
        linkedin.ANALYTICS_URL: fixture("creator_content"),
    }
    payload, page, ctx, sleeps, logs = run(routes)
    assert isinstance(payload, dict), payload
    assert page.closed and ctx.opened == 1
    assert page.visited == [
        ACTIVITY,
        linkedin.ANALYTICS_URL,
    ]  # followers came from the analytics page: no profile visit
    assert payload["account"] == {"views": 45_308, "engagements": 759, "followers": 3_412}
    posts = by_id(payload["posts"])
    assert len(posts) == 6 and posts[ID_A]["views"] == 15_100
    assert posts[ID_B]["posted_at"] == "2026-11-20T07:00:00Z"
    assert sleeps and all(1.0 <= s <= 2.0 for s in sleeps)  # human pace, but injected: no real waiting
    assert logs and all(isinstance(line, str) for line in logs)
    json.dumps(payload)


def test_parse_dashboard_reads_number_before_label_tiles():
    # "Total followers" must take the number before it, not the next tile's (347)
    assert linkedin.parse_dashboard(fixture("dashboard")) == {
        "views": 12,
        "profile_views": 347,
        "followers": 2_481,
    }
    assert linkedin.parse_followers(fixture("dashboard")) == 2_481
    assert linkedin.parse_dashboard("") == {}


def test_harvest_fills_missing_totals_from_the_dashboard_when_analytics_is_empty(no_real_sleep):
    routes = {
        ACTIVITY: [fixture("recent_activity")],
        linkedin.ANALYTICS_URL: "<html><body><main>No posts yet</main></body></html>",
        linkedin.DASHBOARD_URL: fixture("dashboard"),
    }
    payload, page, _, _, logs = run(routes)
    assert isinstance(payload, dict), payload
    assert page.visited == [ACTIVITY, linkedin.ANALYTICS_URL, linkedin.DASHBOARD_URL]  # no profile visit
    assert payload["account"] == {"views": 12, "profile_views": 347, "followers": 2_481}
    assert any("dashboard totals" in line for line in logs)
    assert page.closed


def test_harvest_dashboard_failure_is_not_fatal(no_real_sleep):
    routes = {
        ACTIVITY: [fixture("recent_activity")],
        linkedin.ANALYTICS_URL: "",
        linkedin.DASHBOARD_URL: RuntimeError("net::ERR_ABORTED"),
        PROFILE: fixture("profile"),
    }
    payload, _page, _, _, logs = run(routes)
    assert isinstance(payload, dict) and payload["account"] == {"followers": 3_412}
    assert any("dashboard skipped" in line for line in logs)


def test_harvest_authwall_raises_login_required_and_closes_the_page(no_real_sleep):
    routes = {ACTIVITY: fixture("authwall")}
    err, page, *_ = run(routes, redirects={ACTIVITY: "https://www.linkedin.com/authwall?trk=bf"})
    assert isinstance(err, common.LoginRequired)
    assert str(err) == common.LOGIN_MESSAGE
    assert page.closed and page.visited == [ACTIVITY]  # stopped at once: nothing else was opened
    assert page.wheels == [] and page.clicks == []


def test_harvest_login_redirect_by_url_alone_raises_login_required(no_real_sleep):
    routes = {ACTIVITY: ""}
    err, page, *_ = run(routes, redirects={ACTIVITY: "https://www.linkedin.com/uas/login?session_redirect=x"})
    assert isinstance(err, common.LoginRequired) and page.closed


def test_harvest_continues_when_the_analytics_page_fails_and_reads_followers_from_the_profile(no_real_sleep):
    routes = {
        ACTIVITY: [fixture("recent_activity")],
        linkedin.ANALYTICS_URL: RuntimeError("net::ERR_CONNECTION_RESET"),
        PROFILE: fixture("profile"),
    }
    payload, page, _, _, logs = run(routes)
    assert isinstance(payload, dict), payload
    assert page.visited == [ACTIVITY, linkedin.ANALYTICS_URL, linkedin.DASHBOARD_URL, PROFILE]
    assert payload["account"] == {"followers": 3_412}
    assert [x["external_id"] for x in payload["posts"]] == [ID_B, ID_A, ID_C, ID_D, ID_G]
    assert by_id(payload["posts"])[ID_A]["views"] == 12_400  # activity numbers only
    assert any("creator analytics skipped" in line for line in logs)
    assert page.closed


@pytest.mark.parametrize(
    "analytics",
    [
        (404, "<html><body>Page not found</body></html>"),
        "",
        "<html><body><div class='global-nav'></div><h1>Content performance</h1></body></html>",
    ],
)
def test_harvest_treats_404_or_empty_analytics_as_non_fatal(analytics, no_real_sleep):
    routes = {
        ACTIVITY: [fixture("recent_activity")],
        linkedin.ANALYTICS_URL: analytics,
        PROFILE: fixture("profile"),
    }
    payload, page, _, _, logs = run(routes)
    assert isinstance(payload, dict), payload
    assert len(payload["posts"]) == 5 and payload["account"] == {"followers": 3_412}
    assert any("continuing with activity data only" in line for line in logs)
    assert page.closed


def test_harvest_failure_everywhere_but_activity_still_returns_posts(no_real_sleep):
    routes = {
        ACTIVITY: [fixture("recent_activity")],
        linkedin.ANALYTICS_URL: ValueError("boom"),
        PROFILE: OSError("boom"),
    }
    payload, page, *_ = run(routes)
    assert isinstance(payload, dict) and payload["account"] == {} and len(payload["posts"]) == 5
    assert page.closed


def test_harvest_scrolls_gently_and_stops_when_the_page_stops_growing(no_real_sleep):
    routes = {ACTIVITY: activity_pages(2, 4, 4, 9)}
    payload, page, _, sleeps, _ = run(routes)
    assert isinstance(payload, dict), payload
    assert len(payload["posts"]) == 4 and len(page.wheels) == 2  # grew once, then stalled
    assert all(600 <= dy <= 900 for dy in page.wheels)
    assert len(sleeps) >= 1 + len(page.wheels)  # a pause after the load and after every scroll


def test_harvest_scrolls_at_most_six_steps(no_real_sleep):
    routes = {ACTIVITY: activity_pages(*range(2, 14))}
    payload, page, *_ = run(routes)
    assert isinstance(payload, dict) and len(page.wheels) == 6
    assert len(payload["posts"]) == 8  # 2 initial + 6 steps of growth


def test_harvest_stops_scrolling_once_max_posts_is_reached(no_real_sleep):
    routes = {ACTIVITY: activity_pages(2, 6, 9)}
    payload, page, *_ = run(routes, max_posts=3)
    assert isinstance(payload, dict) and len(payload["posts"]) == 3 and len(page.wheels) == 1


def test_harvest_never_returns_more_than_30_posts(no_real_sleep):
    routes = {ACTIVITY: [linkedin_cards(45)]}
    payload, page, *_ = run(routes, max_posts=500)
    assert isinstance(payload, dict) and len(payload["posts"]) == 30 and page.wheels == []


def test_harvest_company_page_skips_the_personal_creator_analytics(no_real_sleep):
    company = "https://www.linkedin.com/company/pulse-labs/"
    posts_url = "https://www.linkedin.com/company/pulse-labs/posts/?feedView=all"
    routes = {posts_url: [fixture("recent_activity")], company: fixture("profile")}
    payload, page, *_ = run(routes, url=company)
    assert isinstance(payload, dict), payload
    assert page.visited == [posts_url, company]
    assert linkedin.ANALYTICS_URL not in page.visited
    assert payload["account"] == {"followers": 3_412} and len(payload["posts"]) == 5


def test_harvest_blank_pages_raise_harvest_error_and_still_close_the_page(no_real_sleep):
    err, page, *_ = run({ACTIVITY: "<html><body><div class='global-nav'></div></body></html>"})
    assert isinstance(err, common.HarvestError) and not isinstance(err, common.LoginRequired)
    assert page.closed


def test_harvest_navigation_error_becomes_harvest_error_and_closes_the_page(no_real_sleep):
    err, page, *_ = run({ACTIVITY: RuntimeError("Timeout 45000ms exceeded")})
    assert isinstance(err, common.HarvestError) and "Timeout" in str(err)
    assert page.closed


def test_harvest_rejects_a_bad_url_before_opening_any_tab(no_real_sleep):
    err, page, ctx, *_ = run({}, url="https://example.com/in/alex")
    assert isinstance(err, common.HarvestError)
    assert ctx.opened == 0 and not page.closed


def test_harvest_only_ever_clicks_show_more_results_and_visits_only_own_urls(no_real_sleep):
    routes = {
        ACTIVITY: activity_pages(2, 4, 4),
        linkedin.ANALYTICS_URL: fixture("creator_content"),
    }
    payload, page, *_ = run(routes, show_more=1)
    assert isinstance(payload, dict), payload
    assert page.clicks and set(page.clicks) == {"show-more"}
    assert page.roles and all(role == "button" for role, _ in page.roles)
    name = page.roles[0][1]
    assert name.search("Show more results")
    for other in ("Show more", "See more", "Follow", "Connect", "Send", "Post", "Repost", "Like"):
        assert not name.search(other)
    assert set(page.visited) <= {ACTIVITY, linkedin.ANALYTICS_URL, PROFILE}


def test_harvest_defaults_now_to_the_clock_so_dates_are_present_in_real_runs(no_real_sleep):
    page = FakePage(
        {ACTIVITY: [fixture("recent_activity")], linkedin.ANALYTICS_URL: fixture("creator_content")}
    )
    payload = linkedin.harvest(FakeContext(page), PROFILE, log=lambda s: None, sleep=lambda s: None)
    assert all("posted_at" in post for post in payload["posts"] if post["external_id"] != ID_SQLITE)
