"""Tests for tools/harvest/instagram.py.

Pure parsers are checked against HAND-WRITTEN fixtures (tools/harvest/fixtures/instagram_*.html, none of
them a capture of a real Instagram page) plus small inline snippets. The driver `harvest()` is checked
with tiny fake context/page classes: no Playwright, no network, no real sleeping.

Run from the repo root:
    apps/api/.venv/bin/python -m pytest -q tools/harvest/test_instagram_parsers.py
"""

import ast
import importlib
import json
import os
import re
import sys
import time
import types

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import common
import instagram

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = "https://www.instagram.com/pulse.demo/"
CODES = [  # the 15 distinct grid posts of instagram_profile.html, in page order
    "C8xKq2LpA01", "C8xKq2LpB02", "C8xKq2LpC03", "C8xKq2LpD04", "C8xKq2LpE05", "C8xKq2LpF06",
    "C8xKq2LpG07", "C8xKq2LpH08", "C8xKq2LpI09", "C8xKq2LpJ10", "C8xKq2LpK11", "C8xKq2LpL12",
    "C8xKq2LpM13", "C8xKq2LpN14", "C8xKq2LpO15",
]  # fmt: skip
REELS = {"C8xKq2LpB02", "C8xKq2LpH08"}


def fx(name: str) -> str:
    with open(os.path.join(HERE, "fixtures", f"instagram_{name}.html"), encoding="utf-8") as f:
        return f.read()


def post_html(body: str, *, code: str = "AbCdE12345", kind: str = "p", head: str = "") -> str:
    """Tiny post page with a canonical link, so only the facts under test are on it."""
    return (
        f'<html><head><link rel="canonical" href="https://www.instagram.com/{kind}/{code}/">{head}</head>'
        f"<body>{body}</body></html>"
    )


def by_id(posts):
    return {p["external_id"]: p for p in posts}


# ---------------------------------------------------------------------------------------------------
# module hygiene


def test_stdlib_only_and_no_playwright_import():
    with open(os.path.join(HERE, "instagram.py"), encoding="utf-8") as f:
        src = f.read()
    roots = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Import):
            roots |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".")[0])
    assert roots <= set(sys.stdlib_module_names) | {"common"}, roots
    assert "playwright" not in roots and "playwright" not in sys.modules


def test_imports_as_package_module_too():
    pkg = types.ModuleType("hpkg_ig")
    pkg.__path__ = [HERE]
    sys.modules["hpkg_ig"] = pkg
    try:
        mod = importlib.import_module("hpkg_ig.instagram")
        assert mod.common.__name__ == "hpkg_ig.common"
        assert mod.profile_username(PROFILE) == "pulse.demo"
    finally:
        for name in [n for n in sys.modules if n == "hpkg_ig" or n.startswith("hpkg_ig.")]:
            del sys.modules[name]


# ---------------------------------------------------------------------------------------------------
# URLs


@pytest.mark.parametrize(
    "url",
    [
        "https://www.instagram.com/pulse.demo/",
        "https://www.instagram.com/pulse.demo",
        "https://www.instagram.com/pulse.demo/?hl=en&igsh=abc123",
        "https://instagram.com/Pulse.Demo/reels/",
        "https://www.instagram.com/pulse.demo/tagged/#grid",
        "http://m.instagram.com/pulse.demo/",
        "https://www.instagram.com/pulse.demo/p/C8xKq2LpA01/",
        "www.instagram.com/pulse.demo/",
        "instagram.com/pulse.demo",
        "@pulse.demo",
        "pulse.demo",
        "  pulse.demo/  ",
    ],
)
def test_profile_username_found(url):
    assert instagram.profile_username(url) == "pulse.demo"


@pytest.mark.parametrize(
    "url",
    [
        None,
        "",
        "   ",
        "https://www.instagram.com/",
        "https://www.instagram.com/p/C8xKq2LpA01/",
        "https://www.instagram.com/reel/C8xKq2LpB02/",
        "https://www.instagram.com/reels/",
        "https://www.instagram.com/explore/tags/pulse/",
        "https://www.instagram.com/accounts/login/",
        "https://example.com/pulse.demo/",
        "evil.example/pulse.demo",
        "not a url with spaces",
        "https://www.instagram.com/" + "a" * 31 + "/",
    ],
)
def test_profile_username_missing(url):
    assert instagram.profile_username(url) is None


def test_normalise_profile_url_and_insights_url():
    assert instagram.normalise_profile_url("https://instagram.com/Pulse.Demo/reels/?hl=en") == PROFILE
    assert instagram.normalise_profile_url("@pulse.demo") == PROFILE
    assert instagram.insights_url() == "https://www.instagram.com/accounts/insights/"
    for bad in ("https://www.instagram.com/p/C8xKq2LpA01/", "https://example.com/x/", ""):
        with pytest.raises(common.HarvestError):
            instagram.normalise_profile_url(bad)


# ---------------------------------------------------------------------------------------------------
# looks_logged_out


def test_logged_out_by_url_alone():
    assert instagram.looks_logged_out("https://www.instagram.com/accounts/login/?next=%2Fpulse.demo%2F", "")
    assert instagram.looks_logged_out("https://www.instagram.com/accounts/emailsignup/", None)


def test_logged_out_login_form_and_interstitial_fixtures():
    assert instagram.looks_logged_out(PROFILE, fx("login"))  # password field on a "profile" URL
    # logged-out public profile: header with counts IS present, wall on top
    assert instagram.looks_logged_out(PROFILE, fx("profile_loggedout"))


def test_logged_out_false_for_logged_in_pages():
    for name in ("profile", "profile_personal", "post_page", "reel_page", "insights"):
        assert instagram.looks_logged_out(PROFILE, fx(name)) is False, name


def test_logged_out_top_bar_only_and_member_override():
    bar = '<a href="/accounts/login/">Log in</a> <a href="/accounts/emailsignup/">Sign up</a>'
    assert instagram.looks_logged_out(PROFILE, f"<body>{bar}<header>5 followers</header></body>")
    member = '<a href="/direct/inbox/">Messages</a>'
    assert not instagram.looks_logged_out(PROFILE, f"<body>{member}{bar}</body>")


def test_logged_out_empty_and_garbage_are_false():
    for html in (None, "", "   ", "<<<>>> &&& \x00", 12345):
        assert instagram.looks_logged_out(PROFILE, html) is False
    assert instagram.looks_logged_out(None, "") is False


# ---------------------------------------------------------------------------------------------------
# parse_profile


def test_parse_profile_account_numbers_and_professional_flag():
    p = instagram.parse_profile(fx("profile"))
    assert p["account"] == {"followers": 1234}
    assert (p["following"], p["posts_count"]) == (567, 89)
    assert p["is_professional"] is True  # "View insights" / "Professional dashboard"


def test_parse_profile_caps_at_12_dedupes_and_keeps_order():
    p = instagram.parse_profile(fx("profile"))
    ids = [x["external_id"] for x in p["posts"]]
    assert ids == CODES[:12]  # 16 anchors, 15 distinct -> first 12, duplicate of A01 not repeated
    assert len(set(ids)) == 12
    assert [x["external_id"] for x in instagram.parse_profile(fx("profile"), max_posts=99)["posts"]] == ids
    assert len(instagram.parse_profile(fx("profile"), max_posts=3)["posts"]) == 3
    assert instagram.parse_profile(fx("profile"), max_posts=0)["posts"] == []


def test_parse_profile_urls_are_canonical_and_reels_are_marked():
    posts = by_id(instagram.parse_profile(fx("profile"), max_posts=12)["posts"])
    for code, post in posts.items():
        kind = "reel" if code in REELS else "p"
        assert post["url"] == f"https://www.instagram.com/{kind}/{code}/"


def test_parse_profile_grid_overlay_stats():
    posts = by_id(instagram.parse_profile(fx("profile"))["posts"])
    assert posts["C8xKq2LpA01"]["engagements"] == 1204 + 31
    assert posts["C8xKq2LpA01"]["content"] == "Sunrise run along the harbour bridge. Early starts, big skies."
    assert posts["C8xKq2LpB02"]["views"] == 12_300  # "12.3K plays" overlay on a reel
    assert posts["C8xKq2LpH08"]["views"] == 8_904  # bare count beside the Clip icon
    assert posts["C8xKq2LpG07"]["engagements"] == 245 + 12  # stats in the anchor's aria-label
    assert posts["C8xKq2LpG07"]["content"] == "Launch day recap"
    assert "views" not in posts["C8xKq2LpA01"]  # photos have no public view count: omitted, not guessed
    assert "engagements" not in posts["C8xKq2LpF06"]


def test_parse_profile_long_alt_is_trimmed_and_stats_removed():
    d04 = by_id(instagram.parse_profile(fx("profile"))["posts"])["C8xKq2LpD04"]
    assert d04["content"].startswith("Week one of building Pulse in public")
    assert len(d04["content"]) <= instagram.GRID_CONTENT_MAX
    assert d04["content"].endswith("…")
    assert "likes" not in d04["content"]
    assert d04["engagements"] == 47


def test_parse_profile_drops_instagram_auto_description():
    c03 = by_id(instagram.parse_profile(fx("profile"))["posts"])["C8xKq2LpC03"]
    assert "content" not in c03  # "Photo by ... May be an image of ..." is not a caption


def test_parse_profile_personal_uses_header_and_ignores_other_users_posts():
    p = instagram.parse_profile(fx("profile_personal"))
    assert p["is_professional"] is False
    assert p["account"] == {"followers": 1_200_000}  # "1.2M followers" in the header, no og:description
    assert (p["following"], p["posts_count"]) == (3_400, 1_024)
    ids = [x["external_id"] for x in p["posts"]]
    assert ids == ["DaTe5ample01", "DaTe5ample02", "DaTe5ample03"]  # /other.user/p/... skipped
    assert by_id(p["posts"])["DaTe5ample02"]["views"] == 1_200_000  # "1.2M views", reel
    assert by_id(p["posts"])["DaTe5ample01"]["engagements"] == 2_100 + 64


def test_parse_profile_og_description_counts():
    def og(desc):
        return f'<meta property="og:description" content="{desc}">'

    p = instagram.parse_profile(og("1.2M Followers, 3.4K Following, 1,024 Posts - See Instagram photos"))
    assert (p["account"]["followers"], p["following"], p["posts_count"]) == (1_200_000, 3_400, 1_024)
    p = instagram.parse_profile(og("1 Follower, 2 Following, 0 Posts - hi"))
    assert (p["account"]["followers"], p["following"], p["posts_count"]) == (1, 2, 0)


def test_parse_profile_header_ignores_scripts():
    html = "<script>var x='999 followers'</script><ul><li><span>5</span> followers</li></ul>"
    assert instagram.parse_profile(html)["account"] == {"followers": 5}


def test_parse_profile_professional_detection_is_about_controls_not_captions():
    assert instagram.parse_profile("<div><button>Insights</button></div>")["is_professional"]
    assert instagram.parse_profile('<a href="/accounts/insights/">x</a>')["is_professional"]
    assert instagram.parse_profile("<div>View insights</div>")["is_professional"]
    assert not instagram.parse_profile("<div>Insights from the road: 5 tips</div>")["is_professional"]
    assert not instagram.parse_profile("<a href='/accounts/edit/'>Edit profile</a>")["is_professional"]


def test_parse_profile_username_arg_filters_grid():
    html = '<a href="/a.b/p/AAAAAA1/"><img alt="mine"></a><a href="/c.d/p/BBBBBB2/"><img alt="theirs"></a>'
    assert [x["external_id"] for x in instagram.parse_profile(html, username="a.b")["posts"]] == ["AAAAAA1"]
    assert len(instagram.parse_profile(html)["posts"]) == 2  # no username known -> nothing to filter on


@pytest.mark.parametrize(
    "html", [None, "", "   ", "<<<>>> garbage", "\x00\x01\x02", "<a href=", 42, b"bytes"]
)
def test_parse_profile_empty_and_garbage(html):
    p = instagram.parse_profile(html)
    assert p == {"account": {}, "is_professional": False, "posts": []}


# ---------------------------------------------------------------------------------------------------
# parse_post_page


def test_parse_post_page_photo_fixture():
    p = instagram.parse_post_page(fx("post_page"), url="https://www.instagram.com/p/C8xKq2LpA01/?img_index=1")
    assert p == {
        "external_id": "C8xKq2LpA01",
        "url": "https://www.instagram.com/p/C8xKq2LpA01/",
        "content": "Sunrise run along the harbour bridge. Early starts, big skies. #pulse #running",
        "posted_at": "2026-11-12T03:04:05+00:00",  # the post's own <time>, not a comment's
        "views": 5_432,  # photo: no plays, so impressions
        "engagements": 1_204 + 31,
    }


def test_parse_post_page_without_og_uses_liked_by_line_and_visible_comments():
    html = re.sub(r'<meta property="og:[^>]*>', "", fx("post_page"))
    p = instagram.parse_post_page(html)  # shortcode now only from the canonical link
    assert p["external_id"] == "C8xKq2LpA01"
    assert p["engagements"] == (1_203 + 1) + 31  # 'Liked by friend.one and 1,203 others'
    assert p["content"].startswith("Sunrise run along")


def test_parse_post_page_hidden_like_count_and_comment_row_likes_are_not_mistaken():
    html = re.sub(r'<meta property="og:[^>]*>', "", fx("post_page"))
    html = html.replace("1,203 others", "others")  # like count hidden by the author
    p = instagram.parse_post_page(html)
    assert p["engagements"] == 31  # comments only; '3 likes' on a comment row is not the post's likes


def test_parse_post_page_reel_fixture():
    p = instagram.parse_post_page(fx("reel_page"))
    assert p["external_id"] == "C8xKq2LpB02"
    assert p["url"] == "https://www.instagram.com/reel/C8xKq2LpB02/"
    assert p["views"] == 12_345  # plays win over anything else
    assert p["engagements"] == 1_234 + 89
    assert p["posted_at"] == "2026-11-14T22:15:30+00:00"
    assert p["content"] == "Behind the scenes of the Pulse launch #reels"


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("<div>Liked by x and 1,233 others</div>", 1_234),
        ("<div>Liked by <a>x</a> and <a>1,233 others</a></div>", 1_234),
        ("<div>Liked by x, y and 8 others</div>", 10),
        ("<div>Liked by x and 2 others</div><div>View all 56 comments</div>", 3 + 56),
        ("<div>1 like</div><div>View 1 comment</div>", 2),
        ("<div>1 comment</div>", 1),
        ("<div>1,234 likes</div>", 1_234),
        ("<div>1.2K likes</div><div>3 comments</div>", 1_203),
    ],
)
def test_parse_post_page_like_and_comment_wordings(body, expected):
    assert instagram.parse_post_page(post_html(body))["engagements"] == expected


def test_parse_post_page_liked_by_without_a_number_is_omitted():
    assert instagram.parse_post_page(post_html("<div>Liked by x and y</div>")) is None  # nothing known at all
    p = instagram.parse_post_page(post_html("<div>Liked by x and y</div><div>7 comments</div>"))
    assert p["engagements"] == 7


def test_parse_post_page_views_plays_then_reach_then_nothing():
    reel = instagram.parse_post_page(post_html("<span>1.2M views</span>", kind="reel"))
    assert reel["views"] == 1_200_000 and reel["url"].endswith("/reel/AbCdE12345/")
    assert (
        instagram.parse_post_page(post_html("<span>12,345 plays</span><div>Impressions 900</div>"))["views"]
        == 12_345
    )
    assert (
        instagram.parse_post_page(post_html("<div>Impressions 900</div><div>Reach 500</div>"))["views"] == 900
    )
    assert instagram.parse_post_page(post_html("<div>Accounts reached 500</div>"))["views"] == 500
    no_views = instagram.parse_post_page(post_html("<div>5 likes</div>"))
    assert "views" not in no_views  # unknown stays unknown here; build_payload turns it into 0


def test_parse_post_page_caption_fallback_chain():
    one = '<meta property="og:description" content="5 likes, 1 comment - u on May 1, 2026: &quot;From og desc&quot;.">'
    assert instagram.parse_post_page(post_html("", head=one))["content"] == "From og desc"
    two = '<meta property="og:title" content="U on Instagram: &quot;From og title&quot;"><title>x</title>'
    assert instagram.parse_post_page(post_html("<div>3 likes</div>", head=two))["content"] == "From og title"
    assert instagram.parse_post_page(post_html("<h1>From h1</h1><div>3 likes</div>"))["content"] == "From h1"
    block = '<div data-testid="post-caption"><span>From block</span></div><h1>From h1</h1><div>3 likes</div>'
    assert instagram.parse_post_page(post_html(block))["content"] == "From block"


def test_parse_post_page_caption_text_is_not_read_as_stats():
    p = instagram.parse_post_page(post_html('<h1>5000 likes</h1><div class="x">View all 2 comments</div>'))
    assert p["engagements"] == 2  # the caption "5000 likes" must not count as likes
    assert p["content"] == "5000 likes"


def test_parse_post_page_largest_stand_alone_count_wins_in_either_order():
    comment_first = (
        "<div>3 likes</div><div>1,204 likes</div><div>2 comments</div><div>View all 31 comments</div>"
    )
    post_first = (
        "<div>1,204 likes</div><div>3 likes</div><div>View all 31 comments</div><div>2 comments</div>"
    )
    for body in (comment_first, post_first):
        assert instagram.parse_post_page(post_html(body))["engagements"] == 1_204 + 31


def test_parse_post_page_posted_at_variants():
    def at(dt):
        return instagram.parse_post_page(post_html(f'<time datetime="{dt}">x</time><div>2 likes</div>'))

    assert at("2026-11-12T03:04:05.000Z")["posted_at"] == "2026-11-12T03:04:05+00:00"
    assert at("2026-11-12T13:04:05+10:00")["posted_at"] == "2026-11-12T13:04:05+10:00"
    assert at("2026-11-12T03:04:05")["posted_at"] == "2026-11-12T03:04:05+00:00"  # naive taken as UTC
    assert "posted_at" not in at("2026-11-12")  # date only: no time of day to report
    assert "posted_at" not in at("garbage")


def test_parse_post_page_jsonld_fallback_and_bad_json():
    ld = json.dumps(
        {
            "@type": "ImageObject",
            "caption": "Hello from JSON-LD",
            "uploadDate": "2026-11-12T03:04:05Z",
            "commentCount": "7",
            "interactionStatistic": [
                {"@type": "InteractionCounter", "interactionType": {"@type": "http://schema.org/LikeAction"},
                 "userInteractionCount": "100"},
            ],
        }
    )  # fmt: skip
    body = (
        f'<script type="application/ld+json">{ld}</script><script type="application/ld+json">{{oops</script>'
    )
    p = instagram.parse_post_page(post_html(body))
    assert p["engagements"] == 107
    assert p["content"] == "Hello from JSON-LD"
    assert p["posted_at"] == "2026-11-12T03:04:05+00:00"


def test_parse_post_page_none_cases():
    assert instagram.parse_post_page(fx("login")) is None  # no shortcode
    assert instagram.parse_post_page(fx("profile")) is None  # profile, not a post
    assert instagram.parse_post_page(fx("insights")) is None
    for html in (None, "", "   ", "<<<>>> garbage", "\x00", 7):
        assert instagram.parse_post_page(html) is None
    assert instagram.parse_post_page(post_html("<div>hello world</div>")) is None  # shortcode but no facts


def test_parse_post_page_url_argument_rules():
    html = "<div>4 likes</div>"
    p = instagram.parse_post_page(html, url="https://www.instagram.com/reel/AbCdE12345/?igsh=zz")
    assert (p["external_id"], p["url"]) == ("AbCdE12345", "https://www.instagram.com/reel/AbCdE12345/")
    p = instagram.parse_post_page(html, url="/pulse.demo/p/AbCdE12345/")
    assert p["url"] == "https://www.instagram.com/p/AbCdE12345/"
    # a non-Instagram URL is not trusted for the shortcode
    assert instagram.parse_post_page(html, url="https://evil.example/p/AbCdE12345/") is None


# ---------------------------------------------------------------------------------------------------
# parse_insights


def test_parse_insights_fixture():
    assert instagram.parse_insights(fx("insights")) == {
        "views": 12_300,
        "engagements": 456,
        "profile_views": 789,
        "clicks": 34,
        "followers": 1_234,
    }


def test_parse_insights_aliases_and_traps():
    def ins(text):
        return instagram.parse_insights(f"<main>{text}</main>")

    assert ins("<div>Profile views 55</div>") == {"profile_views": 55}  # not 'views'
    assert ins("<div>Impressions 1.2M</div>") == {"views": 1_200_000}
    assert ins("<div>Accounts engaged</div><div>321</div>") == {"engagements": 321}
    assert ins("<div>Website taps: 8</div>") == {"clicks": 8}
    assert ins("<div>7,000 Views</div>") == {"views": 7_000}  # number before label
    assert ins("<div>Views 12 Impressions 99</div>") == {"views": 12}  # Views beats Impressions
    assert ins("<div>Views +8.2%</div><div>Interactions 12%</div>") == {}  # deltas are not counts
    assert ins("<div>Followers</div><div>Men 41%</div>") == {}


@pytest.mark.parametrize("html", [None, "", "   ", "<<<>>> garbage", "\x00", 9])
def test_parse_insights_empty_and_garbage(html):
    assert instagram.parse_insights(html) == {}


# ---------------------------------------------------------------------------------------------------
# build_payload


def test_build_payload_post_page_wins_over_grid():
    profile = {
        "account": {"followers": 1_234},
        "posts": [
            {"external_id": "AAAAAA1", "url": "https://www.instagram.com/p/AAAAAA1/", "content": "grid cap",
             "views": 10, "engagements": 20},
            {"external_id": "BBBBBB2", "url": "https://www.instagram.com/p/BBBBBB2/", "content": "grid two",
             "views": 5, "engagements": 6},
        ],
    }  # fmt: skip
    pages = [
        {"external_id": "AAAAAA1", "url": "https://www.instagram.com/p/AAAAAA1/", "content": "page cap",
         "posted_at": "2026-11-12T03:04:05+00:00", "views": 100, "engagements": 200},
        {"external_id": "BBBBBB2", "engagements": 60},  # page without views: the grid's stays
    ]  # fmt: skip
    out = instagram.build_payload(profile, pages, None)
    a, b = out["posts"]
    assert a == {"external_id": "AAAAAA1", "url": "https://www.instagram.com/p/AAAAAA1/", "content": "page cap",
                 "posted_at": "2026-11-12T03:04:05+00:00", "views": 100, "engagements": 200}  # fmt: skip
    assert (b["views"], b["engagements"], b["content"]) == (5, 60, "grid two")
    assert [p["external_id"] for p in out["posts"]] == ["AAAAAA1", "BBBBBB2"]  # grid order kept


def test_build_payload_account_is_followers_updated_by_insights():
    profile = {"account": {"followers": 1_234}, "posts": []}
    out = instagram.build_payload(profile, [], {"views": 12_300, "followers": 1_300, "clicks": 34})
    assert out["account"] == {"followers": 1_300, "views": 12_300, "clicks": 34}
    assert instagram.build_payload(profile, [], None)["account"] == {"followers": 1_234}
    assert instagram.build_payload(profile, [], {})["account"] == {"followers": 1_234}


def test_build_payload_numbers_are_plain_ints_and_unknowns_dropped():
    profile = {
        "account": {"followers": "1.2K"},
        "posts": [{"external_id": "AAAAAA1", "views": "7", "engagements": 3.6}],
    }
    out = instagram.build_payload(
        profile, {}, {"views": 12.7, "clicks": "1.2K", "engagements": True, "profile_views": -5, "bogus": 3}
    )
    assert out["account"] == {"followers": 1_200, "views": 13, "clicks": 1_200}
    assert out["posts"] == [{"external_id": "AAAAAA1", "views": 7, "engagements": 4}]
    nums = [
        *out["account"].values(),
        *(v for p in out["posts"] for k, v in p.items() if k in ("views", "engagements")),
    ]
    assert all(type(n) is int for n in nums)


def test_build_payload_every_post_has_int_views_and_engagements():
    profile = {"account": {}, "posts": [{"external_id": "AAAAAA1", "url": "u"}, {"external_id": "BBBBBB2"}]}
    out = instagram.build_payload(profile, None, None)
    assert out["account"] == {}
    for p in out["posts"]:
        assert type(p["views"]) is int and type(p["engagements"]) is int
        assert (p["views"], p["engagements"]) == (0, 0)


def test_build_payload_caps_at_12_and_dedupes_and_appends_extras_only_with_room():
    grid = [{"external_id": f"POST{i:03d}", "views": i} for i in range(15)] + [{"external_id": "POST000"}]
    out = instagram.build_payload({"posts": grid}, [{"external_id": "EXTRA01", "views": 1}], None)
    assert [p["external_id"] for p in out["posts"]] == [f"POST{i:03d}" for i in range(12)]
    out = instagram.build_payload(
        {"posts": grid[:2]}, {"EXTRA01": {"external_id": "EXTRA01", "views": 9}}, None
    )
    assert [p["external_id"] for p in out["posts"]] == ["POST000", "POST001", "EXTRA01"]
    assert len(instagram.build_payload({"posts": grid}, None, None, max_posts=3)["posts"]) == 3


def test_build_payload_tolerates_none_and_junk():
    assert instagram.build_payload(None, None, None) == {"account": {}, "posts": []}
    assert instagram.build_payload({"posts": ["junk", None, 5]}, ["x", None], "nope") == {
        "account": {},
        "posts": [],
    }


def test_build_payload_from_fixtures_round_trips_through_json():
    profile = instagram.parse_profile(fx("profile"))
    pages = [
        instagram.parse_post_page(fx("post_page"), url="https://www.instagram.com/p/C8xKq2LpA01/"),
        instagram.parse_post_page(fx("reel_page"), url="https://www.instagram.com/reel/C8xKq2LpB02/"),
        None,
    ]
    out = instagram.build_payload(profile, [p for p in pages if p], instagram.parse_insights(fx("insights")))
    assert json.loads(json.dumps(out)) == out
    assert out["account"] == {"followers": 1_234, "views": 12_300, "engagements": 456, "profile_views": 789,
                              "clicks": 34}  # fmt: skip
    assert len(out["posts"]) == 12
    posts = by_id(out["posts"])
    assert (posts["C8xKq2LpA01"]["views"], posts["C8xKq2LpA01"]["engagements"]) == (5_432, 1_235)
    assert posts["C8xKq2LpA01"]["posted_at"] == "2026-11-12T03:04:05+00:00"
    assert (posts["C8xKq2LpB02"]["views"], posts["C8xKq2LpB02"]["engagements"]) == (12_345, 1_323)
    assert (posts["C8xKq2LpF06"]["views"], posts["C8xKq2LpF06"]["engagements"]) == (0, 0)
    for p in out["posts"]:
        assert type(p["views"]) is int and type(p["engagements"]) is int
        assert set(p) <= {"external_id", "url", "content", "posted_at", "views", "engagements"}


# ---------------------------------------------------------------------------------------------------
# harvest() driver with fake Playwright-shaped objects


class FakePage:
    """Just enough of a sync Playwright Page. Any other attribute (click, fill, type, press, ...) fails
    the test, which proves the driver only navigates and reads."""

    def __init__(self, route, *, fail=(), redirects=None):
        self.route = route
        self.fail = set(fail)
        self.redirects = redirects or {}
        self.url = "about:blank"
        self.visited = []
        self.closed = False
        self._html = ""

    def goto(self, url, **kw):
        assert kw.get("wait_until") == "domcontentloaded"
        self.visited.append(url)
        if url in self.fail:
            raise RuntimeError("net::ERR_TIMED_OUT")
        self.url = self.redirects.get(url, url)
        self._html = self.route(url)

    def content(self):
        return self._html

    def wait_for_selector(self, selector, **kw):
        return None

    def close(self):
        self.closed = True

    def __getattr__(self, name):
        raise AssertionError(f"driver must not use page.{name}")


class FakeContext:
    def __init__(self, page):
        self.page = page
        self.new_pages = 0

    def new_page(self):
        self.new_pages += 1
        return self.page

    def close(self):
        raise AssertionError("harvest must never close the user's browser context")

    def __getattr__(self, name):
        raise AssertionError(f"driver must not use context.{name}")


def default_route(url):
    if url == PROFILE:
        return fx("profile")
    if url == instagram.insights_url():
        return fx("insights")
    m = re.search(r"/(p|reel)/([^/]+)/", url)
    assert m, f"unexpected navigation to {url}"
    kind, code = m.groups()
    if code == "C8xKq2LpA01":
        return fx("post_page")
    if code == "C8xKq2LpB02":
        return fx("reel_page")
    return post_html("<div>10 likes</div><div>View all 2 comments</div>", code=code, kind=kind)


def run(page, url=PROFILE, **kw):
    sleeps, logs = [], []
    ctx = FakeContext(page)
    kw.setdefault("sleep", sleeps.append)  # never a real sleep
    kw.setdefault("log", logs.append)
    try:
        return instagram.harvest(ctx, url, **kw), ctx, sleeps, logs
    finally:
        assert page.closed, "the page must be closed even on failure"


def test_harvest_happy_path():
    page = FakePage(default_route)
    payload, ctx, sleeps, logs = run(page, "https://www.instagram.com/pulse.demo/?hl=en")
    assert ctx.new_pages == 1 and page.closed
    assert page.visited[0] == PROFILE  # normalised, query stripped
    post_urls = page.visited[1:-1]
    assert page.visited[-1] == instagram.insights_url()
    assert len(post_urls) == 12 and len(set(post_urls)) == 12
    assert all(re.fullmatch(r"https://www\.instagram\.com/(p|reel)/C8xKq2Lp[A-L]\d\d/", u) for u in post_urls)
    assert len(sleeps) == len(page.visited) - 1  # a pause between every navigation
    assert all(1.0 <= s <= 2.0 for s in sleeps)
    assert payload["account"] == {"followers": 1_234, "views": 12_300, "engagements": 456, "profile_views": 789,
                                  "clicks": 34}  # fmt: skip
    posts = by_id(payload["posts"])
    assert len(posts) == 12
    assert (posts["C8xKq2LpA01"]["views"], posts["C8xKq2LpA01"]["engagements"]) == (5_432, 1_235)
    assert (posts["C8xKq2LpB02"]["views"], posts["C8xKq2LpB02"]["engagements"]) == (12_345, 1_323)
    assert posts["C8xKq2LpD04"]["engagements"] == 12  # post page (10 + 2) beats the grid's 47
    assert posts["C8xKq2LpD04"]["content"].startswith("Week one")  # grid caption kept
    assert json.loads(json.dumps(payload)) == payload
    assert logs and all(line.startswith("instagram:") for line in logs)


def test_harvest_raises_login_required_on_login_page():
    redirect = {PROFILE: "https://www.instagram.com/accounts/login/?next=%2Fpulse.demo%2F"}
    page = FakePage(lambda u: fx("login"), redirects=redirect)
    with pytest.raises(common.LoginRequired) as err:
        run(page)
    assert common.LOGIN_MESSAGE in str(err.value)
    assert page.visited == [PROFILE]  # stopped right there


def test_harvest_raises_login_required_on_logged_out_wall_without_redirect():
    page = FakePage(lambda u: fx("profile_loggedout"))
    with pytest.raises(common.LoginRequired):
        run(page)
    assert len(page.visited) == 1


def test_harvest_unreadable_profile_is_a_harvest_error_not_login_required():
    page = FakePage(lambda u: "<html><body>Sorry, this page isn't available.</body></html>")
    with pytest.raises(common.HarvestError) as err:
        run(page)
    assert not isinstance(err.value, common.LoginRequired)
    assert "pulse.demo" in str(err.value)


def test_harvest_rejects_non_profile_url_before_opening_a_page():
    page = FakePage(default_route)
    ctx = FakeContext(page)
    with pytest.raises(common.HarvestError):
        instagram.harvest(ctx, "https://www.instagram.com/p/C8xKq2LpA01/", sleep=lambda s: None)
    assert ctx.new_pages == 0 and page.visited == []


def test_harvest_skips_a_failing_post_and_keeps_going():
    bad = "https://www.instagram.com/p/C8xKq2LpC03/"
    page = FakePage(default_route, fail={bad})
    payload, _, _, logs = run(page)
    assert bad in page.visited and len(page.visited) == 14  # still tried everything else
    assert any("C8xKq2LpC03" in line and "skipped" in line for line in logs)
    posts = by_id(payload["posts"])
    assert len(posts) == 12
    assert (posts["C8xKq2LpC03"]["views"], posts["C8xKq2LpC03"]["engagements"]) == (0, 0)  # grid data only
    assert posts["C8xKq2LpA01"]["views"] == 5_432  # others unaffected


def test_harvest_unreadable_post_page_falls_back_to_grid_numbers():
    def route(url):
        return "<html><body>weird</body></html>" if url.endswith("/C8xKq2LpA01/") else default_route(url)

    payload, _, _, logs = run(FakePage(route))
    a01 = by_id(payload["posts"])["C8xKq2LpA01"]
    assert a01["engagements"] == 1_235 and a01["views"] == 0  # the grid's likes + comments
    assert any("nothing readable" in line for line in logs)


def test_harvest_insights_failure_is_not_fatal():
    page = FakePage(default_route, fail={instagram.insights_url()})
    payload, _, _, logs = run(page)
    assert payload["account"] == {"followers": 1_234}
    assert len(payload["posts"]) == 12
    assert any("insights" in line and "skipped" in line for line in logs)


def test_harvest_insights_page_without_numbers_or_behind_a_wall_is_not_fatal():
    def not_found(url):
        return (
            "<html><body>Sorry, this page isn't available.</body></html>"
            if "insights" in url
            else default_route(url)
        )

    payload, *_ = run(FakePage(not_found))
    assert payload["account"] == {"followers": 1_234}
    redirect = {instagram.insights_url(): "https://www.instagram.com/accounts/login/"}
    payload, *_ = run(
        FakePage(lambda u: fx("login") if "insights" in u else default_route(u), redirects=redirect)
    )
    assert payload["account"] == {"followers": 1_234}


def test_harvest_stops_post_pages_if_chrome_gets_logged_out_midway():
    third = f"https://www.instagram.com/p/{CODES[2]}/"  # the third post opened
    redirects = {third: "https://www.instagram.com/accounts/login/"}
    page = FakePage(lambda u: fx("login") if u == third else default_route(u), redirects=redirects)
    payload, _, _, logs = run(page)
    # profile + 2 good posts + the logged-out one + insights; the remaining 9 posts are never opened
    assert len(page.visited) == 5
    assert any("logged out" in line for line in logs)
    assert len(payload["posts"]) == 12  # grid data still returned
    assert by_id(payload["posts"])["C8xKq2LpA01"]["views"] == 5_432


def test_harvest_personal_account_never_opens_insights():
    def route(url):
        if url == "https://www.instagram.com/sam.example/":
            return fx("profile_personal")
        kind, code = re.search(r"/(p|reel)/([^/]+)/", url).groups()
        return post_html("<div>5 likes</div>", code=code, kind=kind)

    page = FakePage(route)
    payload, *_ = run(page, "https://www.instagram.com/sam.example/")
    assert instagram.insights_url() not in page.visited
    assert len(page.visited) == 1 + 3
    assert payload["account"] == {"followers": 1_200_000}
    assert all(p["engagements"] == 5 for p in payload["posts"])


def test_harvest_clamps_max_posts_and_never_waits_real_time(monkeypatch):
    def boom(seconds):
        raise AssertionError("real sleep attempted")

    monkeypatch.setattr(time, "sleep", boom)
    page = FakePage(default_route)
    payload, _, sleeps, _ = run(page, max_posts=3)
    assert len(page.visited) == 1 + 3 + 1 and len(payload["posts"]) == 3
    assert len(sleeps) == 4
    page = FakePage(default_route)
    payload, *_ = run(page, max_posts=500)  # clamped to the 12 cap
    assert len(payload["posts"]) == 12 and len(page.visited) == 14
