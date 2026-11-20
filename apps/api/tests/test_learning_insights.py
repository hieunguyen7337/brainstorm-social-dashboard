"""W1 learning loop, unit (b): insights math, summary refresh and the insights / classify routes.

Self-contained: its own helpers, no network, `anthropic` always faked.
"""

import json
import secrets
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import anthropic
import httpx
import pytest
from pydantic import BaseModel

from app.config import settings
from app.db import connect, new_id, now_iso
from app.services import ai, classify, insights, metrics
from app.services.posts import create_post

REQUEST = httpx.Request("POST", "https://api.anthropic.com/v1/messages")


# --- helpers ---------------------------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def no_api_key(monkeypatch):
    """AI is off unless a test fakes the client (which switches the key on)."""
    monkeypatch.setattr(settings, "anthropic_api_key", "")


@pytest.fixture()
def db(client):
    conn = connect()
    yield conn
    conn.close()


@pytest.fixture()
def frozen_metrics(monkeypatch):
    """The simulated audience would move the numbers between two calls; keep them exact."""
    monkeypatch.setattr(metrics, "tick", lambda conn, workspace_id: None)


def new_workspace(conn, brand="Acme") -> tuple[str, dict[str, str]]:
    ws_id, token = new_id("w_"), secrets.token_urlsafe(16)
    conn.execute(
        "INSERT INTO workspaces (id, token, name, brand_name, created_at) VALUES (?, ?, ?, ?, ?)",
        (ws_id, token, brand, brand, now_iso()),
    )
    conn.commit()
    return ws_id, {"Authorization": f"Bearer {token}"}


def add_theme(conn, ws_id, name, *, active=True, color="#123456") -> str:
    theme_id = new_id("t_")
    conn.execute(
        "INSERT INTO themes (id, workspace_id, name, description, color, active, created_at) "
        "VALUES (?, ?, ?, '', ?, ?, ?)",
        (theme_id, ws_id, name, color, int(active), now_iso()),
    )
    conn.commit()
    return theme_id


def add_post(conn, ws_id, platform, theme_id=None, *, views=0, eng=0, clicks=0, conv=0, days_ago=2.0,
             source="sim", status="published") -> str:
    """A post with exact counters. `theme_id` fills posts.theme_id (the seeded-workspace style)."""
    post = create_post(conn, ws_id, platform=platform, content=f"{platform} post", theme_id=theme_id,
                       status=status, commit=False)
    published = None
    if status == "published":
        published = (datetime.now(UTC) - timedelta(days=days_ago)).isoformat(timespec="seconds")
    conn.execute(
        "UPDATE posts SET published_at = ?, views = ?, engagements = ?, clicks = ?, conversions = ?, "
        "metrics_source = ? WHERE id = ?",
        (published, views, eng, clicks, conv, source, post.id),
    )
    conn.commit()
    return post.id


def link(conn, post_id, theme_id, confidence=1.0, classifier="manual", created_at=None) -> None:
    conn.execute(
        "INSERT INTO post_themes (post_id, theme_id, confidence, classifier, created_at) VALUES (?, ?, ?, ?, ?)",
        (post_id, theme_id, confidence, classifier, created_at or now_iso()),
    )
    conn.commit()


def by_name(items):
    return {i.name: i for i in items}


def fake_claude(monkeypatch, *, summary="Claude says: lean into customer stories.", stop_reason="end_turn",
                usage=(900, 120), exc=None) -> list[dict]:
    """Fakes the Anthropic client and the key; returns the kwargs of every messages.parse call."""
    calls: list[dict] = []

    def parse(**kwargs):
        calls.append(kwargs)
        if exc is not None:
            raise exc
        parsed = kwargs["output_format"](summary=summary) if summary is not None else None
        return SimpleNamespace(
            parsed_output=parsed,
            stop_reason=stop_reason,
            usage=SimpleNamespace(input_tokens=usage[0], output_tokens=usage[1]),
        )

    fake = SimpleNamespace(messages=SimpleNamespace(parse=parse))
    monkeypatch.setattr(ai, "get_client", lambda: fake)
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    return calls


def usage_rows(conn, ws_id):
    return conn.execute("SELECT * FROM ai_usage WHERE workspace_id = ?", (ws_id,)).fetchall()


def two_theme_workspace(conn):
    """Two themes with one linkedin post each and exact numbers; returns (ws_id, a_id, b_id)."""
    ws_id, _ = new_workspace(conn)
    return ws_id, add_theme(conn, ws_id, "Alpha"), add_theme(conn, ws_id, "Beta")


# --- rates, baseline, lift -------------------------------------------------------------------------------------


def test_rates_and_baseline_are_exact(db):
    ws_id, _ = new_workspace(db)
    a = add_theme(db, ws_id, "Customer stories", color="#e0527a")
    add_post(db, ws_id, "linkedin", a, views=1000, eng=100, clicks=20, conv=5)
    add_post(db, ws_id, "x", a, views=500, eng=25, clicks=5, conv=0)
    add_post(db, ws_id, "x", None, views=500, eng=25, clicks=0, conv=0)  # no theme: baseline only

    ins = insights.compute_insights(db, ws_id, 30)

    b = ins.baseline
    assert (b.posts, b.views, b.engagements, b.clicks, b.onboard) == (3, 2000, 150, 25, 5)
    assert (b.engagement_rate, b.click_rate, b.onboard_rate) == (0.075, 0.0125, 0.0025)
    assert len(ins.themes) == 1
    t = ins.themes[0]
    assert (t.theme_id, t.name, t.color) == (a, "Customer stories", "#e0527a")
    assert (t.posts, t.views, t.engagements, t.clicks, t.onboard) == (2, 1500, 125, 25, 5)
    assert (t.engagement_rate, t.click_rate, t.onboard_rate) == (0.08333, 0.01667, 0.00333)
    assert t.lift_by.engagement_rate == pytest.approx(0.111)
    assert t.lift_by.click_rate == pytest.approx(0.333)
    assert t.lift_by.onboard_rate == pytest.approx(0.333)
    assert t.lift == pytest.approx(0.333)  # onboard lift: the baseline onboard rate is above 0
    assert t.lift_by["click_rate"] == t.lift_by.click_rate


def test_zero_views_gives_zero_rates_not_an_error(db):
    ws_id, a, _ = two_theme_workspace(db)
    add_post(db, ws_id, "x", a, views=0, eng=0, clicks=0, conv=0)

    ins = insights.compute_insights(db, ws_id, 30)

    assert ins.baseline.posts == 1 and ins.baseline.views == 0
    assert (ins.baseline.engagement_rate, ins.baseline.click_rate, ins.baseline.onboard_rate) == (0.0, 0.0, 0.0)
    assert ins.themes[0].lift == 0.0 and ins.themes[0].lift_by.click_rate == 0.0


# (views, engagements, clicks, onboard) of theme Alpha and Beta, one linkedin post each
LIFT_CASES = {
    "onboard": ((1000, 100, 60, 10), (1000, 100, 40, 0), (1.0, -1.0)),  # primary = onboard lift
    "click": ((1000, 100, 60, 0), (1000, 100, 40, 0), (0.2, -0.2)),  # baseline onboard 0 -> click lift
    "engagement": ((1000, 120, 0, 0), (1000, 80, 0, 0), (0.2, -0.2)),  # no clicks at all -> engagement lift
    "nothing": ((1000, 0, 0, 0), (1000, 0, 0, 0), (0.0, 0.0)),  # nothing at all -> 0
}


@pytest.mark.parametrize("case", list(LIFT_CASES))
def test_primary_lift_follows_the_fallback_chain(db, case):
    (alpha, beta, expected) = LIFT_CASES[case]
    ws_id, a, b = two_theme_workspace(db)
    for theme, (views, eng, clicks, conv) in ((a, alpha), (b, beta)):
        add_post(db, ws_id, "linkedin", theme, views=views, eng=eng, clicks=clicks, conv=conv)

    ins = insights.compute_insights(db, ws_id, 30)

    themes = by_name(ins.themes)
    assert themes["Alpha"].lift == pytest.approx(expected[0])
    assert themes["Beta"].lift == pytest.approx(expected[1])
    if case == "click":
        assert themes["Alpha"].lift_by.onboard_rate == 0.0  # baseline rate 0 -> lift 0.0, never a division
        assert themes["Alpha"].lift_by.click_rate == pytest.approx(0.2)
    if case == "engagement":
        assert themes["Alpha"].lift_by.click_rate == 0.0
        assert themes["Alpha"].lift_by.engagement_rate == pytest.approx(0.2)
    if case == "onboard":
        assert themes["Alpha"].lift_by.click_rate == pytest.approx(0.2)
        assert themes["Beta"].lift_by.engagement_rate == 0.0  # same engagement rate as the baseline


def test_lift_is_never_negative_zero(db):
    ws_id, a, b = two_theme_workspace(db)
    add_post(db, ws_id, "x", a, views=10000, eng=4998)  # 0.04% below the baseline: rounds to -0.0
    add_post(db, ws_id, "x", b, views=10000, eng=5002)

    ins = insights.compute_insights(db, ws_id, 30)

    assert len(ins.themes) == 2
    assert all(str(t.lift) == "0.0" and str(t.lift_by.engagement_rate) == "0.0" for t in ins.themes)


# --- theme assignment ------------------------------------------------------------------------------------------


def test_theme_assignment_precedence(db):
    ws_id, _ = new_workspace(db)
    t1, t2, t3 = (add_theme(db, ws_id, n) for n in ("T1", "T2", "T3"))
    other_ws, _ = new_workspace(db, "Other")
    foreign = add_theme(db, other_ws, "Foreign")

    add_post(db, ws_id, "x", t1, views=100)  # only posts.theme_id: fallback -> T1
    p2 = add_post(db, ws_id, "x", t1, views=200)
    link(db, p2, t2, 0.9, "claude")  # a post_themes row beats posts.theme_id -> T2
    p3 = add_post(db, ws_id, "x", None, views=400)
    link(db, p3, t2, 0.6, "claude")
    link(db, p3, t3, 0.8, "keyword")  # highest confidence -> T3
    p4 = add_post(db, ws_id, "x", None, views=800)
    link(db, p4, t1, 0.8, "claude", "2026-01-01T00:00:00+00:00")
    link(db, p4, t2, 0.8, "manual", "2026-02-01T00:00:00+00:00")  # tie: manual wins -> T2
    p5 = add_post(db, ws_id, "x", None, views=1600)
    link(db, p5, t1, 0.7, "claude", "2026-02-01T00:00:00+00:00")
    link(db, p5, t3, 0.7, "claude", "2026-01-01T00:00:00+00:00")  # tie, both automatic: earliest -> T3
    add_post(db, ws_id, "x", None, views=3200)  # no theme at all
    add_post(db, ws_id, "x", "t_deleted", views=6400)  # posts.theme_id of a theme that no longer exists
    p8 = add_post(db, ws_id, "x", None, views=12800)
    link(db, p8, foreign, 1.0, "manual")  # a row for another workspace's theme is ignored

    ins = insights.compute_insights(db, ws_id, 30)

    themes = by_name(ins.themes)
    assert (themes["T1"].posts, themes["T1"].views) == (1, 100)
    assert (themes["T2"].posts, themes["T2"].views) == (2, 1000)  # p2 and p4
    assert (themes["T3"].posts, themes["T3"].views) == (2, 2000)  # p3 and p5
    assert "Foreign" not in themes
    assert ins.baseline.posts == 8 and ins.baseline.views == 25500  # unassigned posts stay in the baseline
    assert sum(t.posts for t in ins.themes) == 5


def test_theme_list_membership(db):
    ws_id, _ = new_workspace(db)
    used = add_theme(db, ws_id, "Used")
    add_theme(db, ws_id, "Idle active")
    retired = add_theme(db, ws_id, "Retired with posts", active=False)
    add_theme(db, ws_id, "Retired unused", active=False)
    stale = add_theme(db, ws_id, "Only old posts")
    add_post(db, ws_id, "x", used, views=1000, eng=50, clicks=10, conv=1)
    add_post(db, ws_id, "x", retired, views=1000, eng=10)
    add_post(db, ws_id, "x", stale, views=1000, eng=10, days_ago=90)

    ins = insights.compute_insights(db, ws_id, 30)

    names = [t.name for t in ins.themes]
    assert names[0] == "Used"
    assert set(names) == {"Used", "Idle active", "Retired with posts", "Only old posts"}
    idle = by_name(ins.themes)["Idle active"]
    assert (idle.posts, idle.views, idle.lift) == (0, 0, 0.0)  # no posts: no claim either way
    assert idle.lift_by.onboard_rate == 0.0


# --- window ----------------------------------------------------------------------------------------------------


def test_window_filters_by_days_and_status(db):
    ws_id, a, _ = two_theme_workspace(db)
    add_post(db, ws_id, "x", a, views=10, days_ago=5)
    add_post(db, ws_id, "x", a, views=100, days_ago=20)
    add_post(db, ws_id, "x", a, views=1000, days_ago=45)
    add_post(db, ws_id, "x", a, views=10000, days_ago=400)
    add_post(db, ws_id, "x", a, views=5, status="draft")
    add_post(db, ws_id, "x", a, views=5, status="scheduled")
    z_post = add_post(db, ws_id, "x", a, views=100000, days_ago=0)
    db.execute("UPDATE posts SET published_at = ? WHERE id = ?",
               (datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), z_post))  # a 'Z' timestamp still parses
    db.commit()

    def window(days):
        ins = insights.compute_insights(db, ws_id, days)
        return ins.days, ins.baseline.posts, ins.baseline.views

    assert window(1) == (1, 1, 100000)
    assert window(7) == (7, 2, 100010)
    assert window(30) == (30, 3, 100110)
    assert window(60) == (60, 4, 101110)
    assert window(365) == (365, 4, 101110)


# --- top themes ------------------------------------------------------------------------------------------------


def test_top_themes_rules_ordering_and_cap(db):
    ws_id, _ = new_workspace(db)
    themes = {n: add_theme(db, ws_id, n) for n in "ABCDEF"}
    for _ in range(2):  # A: onboard rate 0.005
        add_post(db, ws_id, "x", themes["A"], views=1000, eng=50, clicks=10, conv=5)
    for _ in range(2):  # B: onboard 0.003, fewer clicks than C
        add_post(db, ws_id, "x", themes["B"], views=1000, eng=50, clicks=10, conv=3)
    for _ in range(2):  # C: same onboard rate as B but more clicks -> ahead of B
        add_post(db, ws_id, "x", themes["C"], views=1000, eng=50, clicks=30, conv=3)
    for _ in range(2):  # D: no onboard, clicks only
        add_post(db, ws_id, "x", themes["D"], views=1000, eng=50, clicks=40, conv=0)
    add_post(db, ws_id, "x", themes["E"], views=100, eng=90, clicks=90, conv=90)  # one post: not enough evidence
    for _ in range(3):  # F: engagement only
        add_post(db, ws_id, "x", themes["F"], views=1000, eng=500)

    ins = insights.compute_insights(db, ws_id, 30)
    direct = insights.top_themes(db, ws_id, 30)

    assert [t.name for t in ins.top_themes] == ["A", "C", "B"]  # max 3, E excluded for having a single post
    assert [t.name for t in direct] == ["A", "C", "B"]
    assert [t.name for t in ins.themes] == ["E", "A", "C", "B", "D", "F"]  # the full list keeps single-post E
    assert all(isinstance(t, insights.ThemeInsight) for t in direct)


def test_theme_ordering_ties_fall_back_to_engagement_then_name(db):
    ws_id, _ = new_workspace(db)
    for name, eng in (("Delta", 10), ("Charlie", 10), ("Bravo", 30), ("Alpha", 10)):
        theme = add_theme(db, ws_id, name)
        for _ in range(2):
            add_post(db, ws_id, "x", theme, views=1000, eng=eng)

    ins = insights.compute_insights(db, ws_id, 30)

    assert [t.name for t in ins.themes] == ["Bravo", "Alpha", "Charlie", "Delta"]
    assert [t.name for t in ins.top_themes] == ["Bravo", "Alpha", "Charlie"]


def test_top_themes_need_views(db):
    ws_id, a, _ = two_theme_workspace(db)
    add_post(db, ws_id, "x", a, views=0)
    add_post(db, ws_id, "x", a, views=0)

    assert insights.top_themes(db, ws_id, 30) == []


# --- sources and platforms -------------------------------------------------------------------------------------


def test_sources_count_sim_versus_real(db):
    ws_id, a, _ = two_theme_workspace(db)
    add_post(db, ws_id, "x", a, views=10, source="sim")
    add_post(db, ws_id, "x", a, views=10, source="sim")
    add_post(db, ws_id, "linkedin", a, views=10, source="harvest")
    add_post(db, ws_id, "linkedin", a, views=10, source="api")
    add_post(db, ws_id, "linkedin", a, views=10, source="harvest", days_ago=90)  # outside the window
    add_post(db, ws_id, "linkedin", a, views=10, source="harvest", status="draft")  # not published

    ins = insights.compute_insights(db, ws_id, 30)

    assert (ins.sources.real, ins.sources.simulated) == (2, 2)
    assert ins.sources.real + ins.sources.simulated == ins.baseline.posts


def test_platform_blocks_are_ordered_by_views_and_include_unthemed_posts(db):
    ws_id, a, _ = two_theme_workspace(db)
    add_post(db, ws_id, "x", a, views=100, eng=10, clicks=2, conv=1)
    add_post(db, ws_id, "linkedin", a, views=300, eng=60, clicks=30, conv=3)
    add_post(db, ws_id, "reddit", None, views=200, eng=10, clicks=0, conv=0)  # no theme
    add_post(db, ws_id, "tiktok", a, views=9999, days_ago=60)  # outside the window: absent

    ins = insights.compute_insights(db, ws_id, 30)

    assert [p.platform for p in ins.platforms] == ["linkedin", "reddit", "x"]
    linkedin, reddit, x = ins.platforms
    assert (linkedin.posts, linkedin.views, linkedin.engagements, linkedin.clicks, linkedin.onboard) == (
        1, 300, 60, 30, 3)
    assert (linkedin.engagement_rate, linkedin.click_rate, linkedin.onboard_rate) == (0.2, 0.1, 0.01)
    # baseline: 600 views, 80 engagements, 32 clicks, 4 onboard -> onboard rate 4/600
    assert linkedin.lift == pytest.approx(round(0.01 / (4 / 600) - 1, 3))
    assert linkedin.lift_by.click_rate == pytest.approx(round(0.1 / (32 / 600) - 1, 3))
    assert reddit.views == 200 and reddit.lift == -1.0 and reddit.lift_by.engagement_rate == pytest.approx(-0.625)
    assert x.onboard == 1


# --- text ------------------------------------------------------------------------------------------------------


def test_template_summary_on_an_empty_workspace(db):
    ws_id, _ = new_workspace(db)

    ins = insights.compute_insights(db, ws_id, 30)

    assert ins.baseline.posts == 0 and ins.themes == [] and ins.platforms == [] and ins.top_themes == []
    assert ins.summary == insights.template_summary(ins)
    assert ins.summary.strip()
    assert "no published posts" in ins.summary
    assert ins.cached_summary is None


def test_template_summary_names_the_best_theme_and_platform(db):
    ws_id, _ = new_workspace(db)
    best = add_theme(db, ws_id, "Customer stories")
    other = add_theme(db, ws_id, "Weekend deals")
    for _ in range(2):
        add_post(db, ws_id, "linkedin", best, views=1000, eng=100, clicks=40, conv=8)
        add_post(db, ws_id, "x", other, views=1000, eng=40, clicks=5, conv=1)

    ins = insights.compute_insights(db, ws_id, 30)

    assert "'Customer stories' is the strongest theme" in ins.summary
    assert "LinkedIn is the strongest platform" in ins.summary
    assert "above your average" in ins.summary
    assert "4,000 views" in ins.summary
    assert "simulated" in ins.summary  # honest about where the numbers come from


def test_template_summary_uses_multiples_for_big_lifts(db):
    ws_id, a, b = two_theme_workspace(db)
    for _ in range(2):
        add_post(db, ws_id, "x", a, views=1000, eng=10, clicks=5, conv=10)
        add_post(db, ws_id, "x", b, views=1000, eng=10, clicks=5, conv=0)

    summary = insights.compute_insights(db, ws_id, 30).summary

    assert "'Alpha' is the strongest theme: its onboard rate is 2.0x your average (2 posts)." in summary


def test_template_summary_is_plain_about_thin_data(db):
    ws_id, a, _ = two_theme_workspace(db)
    add_post(db, ws_id, "x", a, views=500, eng=20, clicks=2, conv=0, source="real")  # the only themed post
    add_post(db, ws_id, "linkedin", None, views=500, eng=20, clicks=2, conv=0, source="sim")

    ins = insights.compute_insights(db, ws_id, 30)

    assert insights.top_themes(db, ws_id, 30) == []
    assert "not enough themed data" in ins.summary
    assert "1 of these 2 posts have real metrics" in ins.summary

    unviewed_ws, _ = new_workspace(db, "Unviewed")
    add_post(db, unviewed_ws, "x", None, views=0)
    assert "none has any views yet" in insights.compute_insights(db, unviewed_ws, 30).summary


def test_what_works_lines(db):
    ws_id, _ = new_workspace(db)
    stories = add_theme(db, ws_id, "Customer stories")
    deals = add_theme(db, ws_id, "Weekend deals")
    # linkedin, clicks only: stories 0.03 vs a platform average of 0.02 -> 1.5x
    for _ in range(2):
        add_post(db, ws_id, "linkedin", stories, views=1000, clicks=30)
    add_post(db, ws_id, "linkedin", deals, views=2000, clicks=20)
    # x: no clicks at all -> engagement rate: stories 0.04 vs 0.025 -> 1.6x
    for _ in range(2):
        add_post(db, ws_id, "x", stories, views=1000, eng=40)
    add_post(db, ws_id, "x", deals, views=2000, eng=20)
    # facebook: ranked by onboard rate first, even though deals has more clicks
    add_post(db, ws_id, "facebook", stories, views=1000, clicks=20, conv=4)
    add_post(db, ws_id, "facebook", deals, views=1000, clicks=40, conv=0)
    # tiktok: a single theme, so there is nothing to compare
    for _ in range(2):
        add_post(db, ws_id, "tiktok", deals, views=100, eng=10, clicks=1)
    # no themed post / nothing measurable / not published: no line
    add_post(db, ws_id, "reddit", None, views=1000, eng=50, clicks=5)
    add_post(db, ws_id, "instagram", stories, views=0)
    add_post(db, ws_id, "instagram", deals, views=500, eng=50, status="draft")

    lines = insights.what_works(db, ws_id, 30)

    assert set(lines) == {"linkedin", "x", "facebook", "tiktok"}
    assert lines["linkedin"] == "On LinkedIn, 'Customer stories' posts earn 1.5x the platform's click rate (2 posts)."
    assert lines["x"] == (
        "On X, no posts have earned clicks yet; 'Customer stories' posts lead on engagement, earning 1.6x "
        "the platform's engagement rate (2 posts)."
    )
    assert lines["facebook"] == (
        "On Facebook, 'Customer stories' posts earn 2.0x the platform's onboard rate and 0.7x its click "
        "rate (1 post, an early signal)."
    )
    assert lines["tiktok"] == (
        "On TikTok, only 'Weekend deals' posts have been published so far (2 posts), so there is nothing "
        "to compare yet."
    )
    assert list(lines) == ["linkedin", "x", "facebook", "tiktok"]  # by views, descending


def test_what_works_is_empty_without_data(db):
    ws_id, _ = new_workspace(db)

    assert insights.what_works(db, ws_id, 30) == {}


def test_top_themes_and_what_works_never_raise(db):
    ws_id, a, _ = two_theme_workspace(db)
    add_post(db, ws_id, "x", a, views=100, eng=10)
    add_post(db, ws_id, "x", a, views=100, eng=10)
    assert insights.top_themes(db, ws_id, 30) and insights.what_works(db, ws_id, 30)

    db.close()
    assert insights.top_themes(db, ws_id, 30) == []
    assert insights.what_works(db, ws_id, 30) == {}

    bare = connect(":memory:")  # no tables at all
    try:
        assert insights.top_themes(bare, ws_id, 30) == []
        assert insights.what_works(bare, ws_id, 30) == {}
    finally:
        bare.close()


# --- routes ----------------------------------------------------------------------------------------------------


def test_get_insights_shape_on_the_seeded_workspace(auth):
    client, headers, _ = auth

    r = client.get("/api/insights?days=30", headers=headers)

    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"days", "baseline", "themes", "platforms", "top_themes", "sources", "summary",
                         "cached_summary", "classifiers"}
    assert body["days"] == 30
    assert body["baseline"]["posts"] == 18
    assert set(body["baseline"]) == {"posts", "views", "engagements", "clicks", "onboard", "engagement_rate",
                                     "click_rate", "onboard_rate"}
    assert body["baseline"]["views"] > 0
    assert len(body["platforms"]) == 6
    assert [p["views"] for p in body["platforms"]] == sorted((p["views"] for p in body["platforms"]), reverse=True)
    theme_keys = {"theme_id", "name", "color", "lift", "lift_by", "posts", "views", "engagements", "clicks",
                  "onboard", "engagement_rate", "click_rate", "onboard_rate", "classifiers"}
    assert all(set(t) == theme_keys for t in body["themes"])
    assert all(set(t["lift_by"]) == {"engagement_rate", "click_rate", "onboard_rate"} for t in body["themes"])
    # seeded posts only carry posts.theme_id: the fallback makes the insights work before classification
    assert {t["name"] for t in body["themes"]} == {"Behind the beans", "Plant care tips", "Customer stories",
                                                   "Weekend deals"}
    assert sum(t["posts"] for t in body["themes"]) == 18
    assert len(body["top_themes"]) == 3 and all(t["posts"] >= 2 for t in body["top_themes"])
    assert body["top_themes"] == body["themes"][:3]
    assert body["sources"] == {"real": 0, "simulated": 18}
    assert body["summary"].strip() and body["top_themes"][0]["name"] in body["summary"]
    assert body["cached_summary"] is None
    assert all(set(p) >= {"platform", "lift", "lift_by", "posts"} for p in body["platforms"])


def test_get_insights_auth_and_validation(auth):
    client, headers, _ = auth

    assert client.get("/api/insights").status_code == 401
    assert client.get("/api/insights", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/api/insights/refresh").status_code == 401
    assert client.get("/api/insights?days=0", headers=headers).status_code == 422
    assert client.get("/api/insights?days=366", headers=headers).status_code == 422
    assert client.post("/api/insights/refresh?days=0", headers=headers).status_code == 422
    assert client.get("/api/insights?days=7", headers=headers).json()["days"] == 7


def test_workspaces_are_isolated(client, db, frozen_metrics):
    ws_a, headers_a = new_workspace(db, "A")
    ws_b, headers_b = new_workspace(db, "B")
    theme_a, theme_b = add_theme(db, ws_a, "Only A"), add_theme(db, ws_b, "Only B")
    add_post(db, ws_a, "x", theme_a, views=100, eng=10)
    add_post(db, ws_b, "linkedin", theme_b, views=900, eng=90)

    a = client.get("/api/insights", headers=headers_a).json()
    b = client.get("/api/insights", headers=headers_b).json()

    assert (a["baseline"]["views"], b["baseline"]["views"]) == (100, 900)
    assert [t["name"] for t in a["themes"]] == ["Only A"] and [t["name"] for t in b["themes"]] == ["Only B"]
    assert [p["platform"] for p in a["platforms"]] == ["x"] and [p["platform"] for p in b["platforms"]] == ["linkedin"]

    client.post("/api/insights/refresh", headers=headers_a)
    assert client.get("/api/insights", headers=headers_a).json()["cached_summary"] is not None
    assert client.get("/api/insights", headers=headers_b).json()["cached_summary"] is None
    assert insights.what_works(db, ws_b, 30).keys() == {"linkedin"}


# --- refresh ---------------------------------------------------------------------------------------------------


def test_refresh_without_ai_stores_the_template(auth, monkeypatch, db):
    client, headers, ws = auth
    calls = fake_claude(monkeypatch)
    monkeypatch.setattr(settings, "anthropic_api_key", "")  # the fake switched the key on; AI is off here

    r = client.post("/api/insights/refresh", headers=headers)

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ai_used"] is False and body["summary"].strip() and body["created_at"]
    assert calls == []
    row = db.execute("SELECT * FROM insights WHERE workspace_id = ?", (ws["id"],)).fetchone()
    assert (row["body"], row["created_at"]) == (body["summary"], body["created_at"])
    assert usage_rows(db, ws["id"]) == []
    got = client.get("/api/insights", headers=headers).json()
    assert got["cached_summary"] == {"body": body["summary"], "created_at": body["created_at"]}


def test_refresh_with_claude_stores_its_paragraph_and_records_usage(auth, monkeypatch, db):
    client, headers, ws = auth
    calls = fake_claude(monkeypatch, summary="  Customer   stories win.\nPost more of them.  ", usage=(1234, 321))

    r = client.post("/api/insights/refresh?days=30", headers=headers)

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ai_used"] is True
    assert body["summary"] == "Customer stories win. Post more of them."
    rows = usage_rows(db, ws["id"])
    assert len(rows) == 1
    assert (rows[0]["purpose"], rows[0]["input_tokens"], rows[0]["output_tokens"]) == ("insights", 1234, 321)
    assert rows[0]["cost_usd"] == pytest.approx(1234 * 2 / 1e6 + 321 * 10 / 1e6)
    stored = db.execute("SELECT body, created_at FROM insights WHERE workspace_id = ?", (ws["id"],)).fetchone()
    assert (stored["body"], stored["created_at"]) == (body["summary"], body["created_at"])
    assert client.get("/api/insights", headers=headers).json()["cached_summary"]["body"] == body["summary"]

    assert len(calls) == 1
    call = calls[0]
    assert call["model"] == settings.ai_model and call["max_tokens"] == 1000
    assert call["output_config"] == {"effort": "low"}
    assert issubclass(call["output_format"], BaseModel)
    assert "data" in call["system"] and "120 words" in call["system"] and "no markdown" in call["system"].lower()
    header, _, payload = call["messages"][0]["content"].partition("\n")
    data = json.loads(payload)  # the computed numbers are passed as data
    assert call["messages"][0]["role"] == "user" and "JSON" in header
    assert data["baseline"]["posts"] == 18 and data["days"] == 30
    assert {t["name"] for t in data["themes"]} >= {"Customer stories", "Plant care tips"}
    assert "summary" not in data and "cached_summary" not in data


def _status_error(cls, status):
    return cls("boom", response=httpx.Response(status, request=REQUEST), body=None)


FALLBACKS = {
    "refusal": {"summary": None, "stop_reason": "refusal"},
    "max_tokens": {"summary": "cut off mid-sent", "stop_reason": "max_tokens"},
    "no_parsed_output": {"summary": None},
    "empty_text": {"summary": "   "},
    "runaway_text": {"summary": "word " * 400},
    "connection_error": {"exc": anthropic.APIConnectionError(request=REQUEST)},
    "rate_limit": {"exc": _status_error(anthropic.RateLimitError, 429)},
    "server_error": {"exc": _status_error(anthropic.APIStatusError, 500)},
}


@pytest.mark.parametrize("case", list(FALLBACKS))
def test_refresh_falls_back_to_the_template(auth, monkeypatch, db, frozen_metrics, case):
    client, headers, ws = auth
    fake_claude(monkeypatch, **FALLBACKS[case])
    template = client.get("/api/insights", headers=headers).json()["summary"]

    r = client.post("/api/insights/refresh", headers=headers)

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ai_used"] is False
    assert body["summary"] == template
    assert db.execute("SELECT body FROM insights WHERE workspace_id = ?", (ws["id"],)).fetchone()["body"] == template
    # a response that came back (even a refusal) is billed; a connection that failed is not
    expected_rows = 0 if case in ("connection_error", "rate_limit", "server_error") else 1
    rows = usage_rows(db, ws["id"])
    assert len(rows) == expected_rows
    assert all(row["purpose"] == "insights" for row in rows)


def test_refresh_respects_the_insights_budget_only(auth, monkeypatch, db):
    client, headers, ws = auth
    calls = fake_claude(monkeypatch)
    monkeypatch.setattr(settings, "ai_workspace_limit", 1)
    db.execute(
        "INSERT INTO ai_usage (id, workspace_id, purpose, model, input_tokens, output_tokens, cost_usd, ts) "
        "VALUES (?, ?, 'generate', ?, 1, 1, 0, ?)",
        (new_id("u_"), ws["id"], settings.ai_model, now_iso()),
    )
    db.commit()

    first = client.post("/api/insights/refresh", headers=headers).json()  # generate budget is spent, insights isn't
    second = client.post("/api/insights/refresh", headers=headers).json()  # now the insights budget is spent too

    assert first["ai_used"] is True and second["ai_used"] is False
    assert len(calls) == 1
    assert [r["purpose"] for r in usage_rows(db, ws["id"]) if r["purpose"] == "insights"] == ["insights"]


def test_refresh_keeps_one_row_and_takes_days(client, db, frozen_metrics):
    ws_id, headers = new_workspace(db)
    a = add_theme(db, ws_id, "Alpha")
    add_post(db, ws_id, "x", a, views=100, eng=10, days_ago=3)
    add_post(db, ws_id, "x", a, views=100, eng=10, days_ago=20)

    week = client.post("/api/insights/refresh?days=7", headers=headers).json()
    month = client.post("/api/insights/refresh", headers=headers).json()

    assert "In the last 7 days, 1 published post earned" in week["summary"]
    assert "In the last 30 days, 2 published posts earned" in month["summary"]
    rows = db.execute("SELECT * FROM insights WHERE workspace_id = ?", (ws_id,)).fetchall()
    assert len(rows) == 1 and rows[0]["body"] == month["summary"]


# --- /api/themes/classify --------------------------------------------------------------------------------------


def patch_classifier(monkeypatch, *, backfilled=0, unclassified=(), results=()):
    """Fakes the three classify entry points the route uses; returns a log of how they were called."""
    log: dict = {"backfill": [], "unclassified": [], "classify": []}

    def backfill_manual(conn, workspace_id, limit=60):
        log["backfill"].append(limit)
        return backfilled

    def unclassified_post_ids(conn, workspace_id, limit=60):
        log["unclassified"].append(limit)
        return list(unclassified)

    def classify_posts(conn, workspace_id, post_ids):
        log["classify"].append(list(post_ids))
        for post_id, theme_id, confidence, classifier in results:
            link(conn, post_id, theme_id, confidence, classifier)
        return list(results)

    monkeypatch.setattr(classify, "backfill_manual", backfill_manual, raising=False)
    monkeypatch.setattr(classify, "unclassified_post_ids", unclassified_post_ids)
    monkeypatch.setattr(classify, "classify_posts", classify_posts)
    return log


def test_classify_route_reports_what_was_done(auth, db, monkeypatch):
    client, headers, ws = auth
    theme = db.execute("SELECT id FROM themes WHERE workspace_id = ? LIMIT 1", (ws["id"],)).fetchone()["id"]
    u1 = create_post(db, ws["id"], platform="x", content="one").id
    u2 = create_post(db, ws["id"], platform="x", content="two").id
    u3 = create_post(db, ws["id"], platform="x", content="three").id
    create_post(db, ws["id"], platform="x", content="dangling", theme_id="t_gone")  # theme no longer exists
    log = patch_classifier(
        monkeypatch,
        backfilled=2,
        unclassified=[u1, u2, u3],
        results=[(u1, theme, 0.8, "keyword"), (u2, theme, 0.9, "claude")],
    )

    r = client.post("/api/themes/classify", headers=headers)

    assert r.status_code == 200, r.text
    assert r.json() == {
        "backfilled": 2,
        "classified": 2,
        "remaining": 2,  # u3 stayed unclassified and the dangling post has no usable theme
        "assignments": [
            {"post_id": u1, "theme_id": theme, "confidence": 0.8, "classifier": "keyword"},
            {"post_id": u2, "theme_id": theme, "confidence": 0.9, "classifier": "claude"},
        ],
        "classifiers": {"jev": 0, "claude": 1, "keyword": 1},
    }
    assert log == {"backfill": [60], "unclassified": [58], "classify": [[u1, u2, u3]]}


def test_classify_route_caps_the_batch_at_60(auth, monkeypatch):
    client, headers, _ = auth
    log = patch_classifier(monkeypatch, backfilled=60, unclassified=["never used"])

    r = client.post("/api/themes/classify", headers=headers)

    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["backfilled"], body["classified"], body["assignments"]) == (60, 0, [])
    assert body["classifiers"] == {"jev": 0, "claude": 0, "keyword": 0}
    assert log == {"backfill": [60], "unclassified": [], "classify": []}  # no room left for the classifier


def test_classify_route_with_nothing_to_do_and_auth(auth, monkeypatch):
    client, headers, _ = auth
    log = patch_classifier(monkeypatch)

    r = client.post("/api/themes/classify", headers=headers)

    assert r.status_code == 200
    assert r.json() == {"backfilled": 0, "classified": 0, "remaining": 0, "assignments": [],
                        "classifiers": {"jev": 0, "claude": 0, "keyword": 0}}
    assert log == {"backfill": [60], "unclassified": [60], "classify": []}  # the seeded posts all carry a theme
    assert client.post("/api/themes/classify").status_code == 401


def test_classifier_counts_per_theme_and_overall(auth):
    """`classifiers` says how each theme's posts were assigned (jev / claude / keyword / manual)."""
    client, headers, _ws = auth
    themes = client.get("/api/themes", headers=headers).json()
    target = next(t["id"] for t in themes if t["name"] == "Behind the beans")  # 6 published seed posts
    conn = connect()
    try:
        post_ids = [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM posts WHERE theme_id = ? AND status = 'published' ORDER BY id", (target,)
            )
        ]
        assert len(post_ids) >= 3
        for post_id, classifier in zip(post_ids[:3], ("jev", "jev", "claude"), strict=True):
            conn.execute(
                "INSERT INTO post_themes (post_id, theme_id, confidence, classifier, created_at) "
                "VALUES (?, ?, 0.9, ?, ?)",
                (post_id, target, classifier, now_iso()),
            )
        conn.commit()
    finally:
        conn.close()

    body = client.get("/api/insights", headers=headers).json()
    by_id = {t["theme_id"]: t for t in body["themes"]}
    counts = by_id[target]["classifiers"]
    assert counts["jev"] == 2 and counts["claude"] == 1
    assert counts["manual"] == len(post_ids) - 3  # the rest fall back to posts.theme_id (manual)
    assert body["classifiers"]["jev"] == 2
    assert sum(body["classifiers"].values()) == sum(t["posts"] for t in body["themes"])
    other = next(t for t in body["themes"] if t["theme_id"] != target and t["posts"])
    assert set(other["classifiers"]) == {"manual"}
