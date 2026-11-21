"""W1 unit (c): per-channel pipelines, parallel Claude calls, learning prompts and theme assignment.

The Anthropic client is always faked; no network. Self-contained: it carries its own helpers.
"""

import contextlib
import re
import secrets
import sqlite3
import threading
from itertools import pairwise
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from app.config import settings
from app.db import PLATFORMS, connect, new_id, now_iso
from app.services import ai, channels, classify, insights

ALL_PLATFORMS = ["x", "linkedin", "instagram", "tiktok", "reddit", "facebook"]
LINK_LENS = list(range(20, 121, 20))


# --------------------------------------------------------------------------------------------- helpers


def query(sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    conn = connect()
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def execute(sql: str, args: tuple = ()) -> None:
    conn = connect()
    try:
        conn.execute(sql, args)
        conn.commit()
    finally:
        conn.close()


@contextlib.contextmanager
def open_ws(ws_id: str):
    """A connection plus the workspace row, closed afterwards."""
    conn = connect()
    try:
        yield conn, conn.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,)).fetchone()
    finally:
        conn.close()


@pytest.fixture()
def seed_ws(client):
    """Seeds a guest workspace row; returns a factory giving (headers, workspace_id)."""

    def _seed(brand: str = "Acme") -> tuple[dict[str, str], str]:
        ws_id, token = new_id("w"), secrets.token_urlsafe(16)
        execute(
            "INSERT INTO workspaces (id, token, name, brand_name, brand_voice, audience, offer, product_url, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (ws_id, token, brand, brand, "warm and direct", "small business owners",
             "20% off your first month", "https://example.com", now_iso()),
        )
        return {"Authorization": f"Bearer {token}"}, ws_id

    return _seed


def add_theme(ws_id: str, name: str, *, active: bool = True, description: str = "Short, practical") -> str:
    theme_id = new_id("th")
    execute(
        "INSERT INTO themes (id, workspace_id, name, description, color, active, created_at) "
        "VALUES (?, ?, ?, ?, '#7c5cff', ?, ?)",
        (theme_id, ws_id, name, description, int(active), now_iso()),
    )
    return theme_id


def ctx_for(
    brand: str = "Acme",
    audience: str = "small business owners",
    offer: str = "20% off your first month",
    brief: str = "",
    theme: dict | None = None,
    trend: dict | None = None,
    tone: str = "",
) -> channels.Context:
    ws = {"brand_name": brand, "audience": audience, "offer": offer}
    return channels.build_context(ws, theme, trend, brief, tone)


MODEL_CTX = ctx_for(brand="ModelCo")


def ai_copy(platform: str, **updates) -> ai.Variant:
    """Valid model output for a platform, marked '[ai]' with quality 0.9 so it is recognisable in results."""
    base = channels.template_variant(platform, MODEL_CTX)
    return base.model_copy(update={"content": f"[ai] {base.content}", "quality": 0.9, **updates})


def asked_platforms(kwargs: dict) -> list[str]:
    prompt = kwargs["messages"][0]["content"]
    return prompt.rsplit("in this order: ", 1)[1].splitlines()[0].split(", ")


def ai_all(kwargs: dict) -> ai.Variants:
    return ai.Variants(variants=[ai_copy(p) for p in asked_platforms(kwargs)])


def fake_model(monkeypatch, *, parsed=None, stop_reason="end_turn", usage=(1000, 500), exc=None, barrier=None):
    """Patches the client and the key; returns the list of kwargs each messages.parse call received.

    `parsed` and `exc` may be callables taking the call's kwargs. Each call also records the calling thread.
    """
    calls: list[dict] = []

    def parse(**kwargs):
        calls.append({**kwargs, "thread": threading.get_ident()})
        if barrier is not None:
            barrier.wait()
        boom = exc(kwargs) if callable(exc) else exc
        if boom is not None:
            raise boom
        out = parsed(kwargs) if callable(parsed) else parsed
        return SimpleNamespace(
            parsed_output=out,
            stop_reason=stop_reason,
            usage=SimpleNamespace(input_tokens=usage[0], output_tokens=usage[1]),
        )

    fake = SimpleNamespace(messages=SimpleNamespace(parse=parse))
    monkeypatch.setattr(ai, "get_client", lambda: fake)
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    return calls


def connection_error() -> anthropic.APIConnectionError:
    return anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))


def generate_direct(ws_id: str, platforms: list[str], **kwargs) -> tuple[list[ai.Variant], bool]:
    with open_ws(ws_id) as (conn, ws):
        return ai.generate_variants(conn, ws, platforms=platforms, **kwargs)


def by_platform(variants: list[ai.Variant]) -> dict[str, ai.Variant]:
    return {v.platform: v for v in variants}


def fake_top_themes(monkeypatch, themes: list[tuple[str, str]]) -> None:
    rows = [SimpleNamespace(theme_id=theme_id, name=name) for theme_id, name in themes]
    monkeypatch.setattr(insights, "top_themes", lambda conn, workspace_id, days=30: rows)


def fake_what_works(monkeypatch, lines: dict[str, str]) -> None:
    monkeypatch.setattr(insights, "what_works", lambda conn, workspace_id, days=30: lines)


# ------------------------------------------------------------------------------- channel registry


def test_registry_maps_every_platform_to_one_channel():
    assert set(PLATFORMS) == {p for c in channels.CHANNELS.values() for p in c.platforms}
    assert sum(len(c.platforms) for c in channels.CHANNELS.values()) == len(PLATFORMS)  # no platform twice
    for platform in PLATFORMS:
        assert platform in channels.channel_for(platform).platforms
    assert channels.channel_for("instagram") is channels.channel_for("tiktok")
    assert channels.channel_for("x").platforms == ("x",)  # Threads rides on the x channel
    assert set(channels.CHANNELS) == {"linkedin", "instagram", "x", "reddit", "facebook"}
    with pytest.raises(ValueError):
        channels.channel_for("myspace")


def test_channel_limits_follow_the_brief():
    c = channels.CHANNELS
    assert (c["linkedin"].min_chars, c["linkedin"].max_chars) == (1200, 1800)
    assert (c["linkedin"].min_hashtags, c["linkedin"].max_hashtags) == (3, 3)
    assert (c["instagram"].min_hashtags, c["instagram"].max_hashtags, c["instagram"].max_chars) == (3, 5, 2200)
    assert c["x"].max_chars <= 280
    assert c["reddit"].max_hashtags == 0 and c["reddit"].title_max == 120
    assert (c["facebook"].min_hashtags, c["facebook"].max_hashtags, c["facebook"].max_chars) == (0, 3, 2000)


def test_system_prompts_are_per_channel_and_per_platform():
    for channel in channels.CHANNELS.values():
        prompt = channel.system_prompt()
        assert "{link}" in prompt and "data" in prompt and "real URL" in prompt
        assert "hashtags field" in prompt and "quality" in prompt
    instagram = channels.CHANNELS["instagram"]
    tiktok_only = instagram.system_prompt(["tiktok"])
    assert "- tiktok:" in tiktok_only and "- instagram:" not in tiktok_only
    assert "- linkedin:" not in instagram.system_prompt()
    assert "1200" in channels.CHANNELS["linkedin"].system_prompt()


# --------------------------------------------------------------------------------------- templates

INPUTS = {
    "thin": {"brand": "Thin", "audience": "", "offer": ""},
    "empty-brand": {"brand": "", "audience": "", "offer": ""},
    "typical": {
        "brief": "Our new onboarding checklist",
        "theme": {"name": "Product tips", "description": "Short, practical", "color": "#7c5cff"},
        "trend": {"title": "Small teams ship faster with AI helpers"},
        "tone": "playful",
    },
    "very-long": {
        "brand": "B" * 300,
        "audience": "a" * 300,
        "offer": "o" * 500,
        "brief": "b " * 600,
        "theme": {"name": "T" * 200, "description": "d " * 300, "color": "#112233"},
        "trend": {"title": "t " * 300},
        "tone": "z" * 200,
    },
    "unicode": {
        "brand": "株式会社テスト",
        "audience": "ユーザー " * 30,
        "offer": "割引 " * 60,
        "brief": "新製品 " * 80,
        "theme": {"name": "テーマ", "description": "説明", "color": "not-a-colour"},
        "trend": {"title": "トレンド " * 40},
    },
    "emoji": {
        "brand": "Pulse \U0001f600",
        "audience": "\U0001f600" * 80,
        "offer": "\U0001f600 " * 200,
        "brief": "\U0001f600 " * 300,
        "theme": {"name": "\U0001f600", "description": "", "color": "#00ff00"},
    },
}


def input_ctx(name: str) -> channels.Context:
    return ctx_for(**INPUTS[name])


def tag_problems(platform: str, variant: ai.Variant) -> list[str]:
    limits = channels.channel_for(platform)
    problems = []
    if not limits.min_hashtags <= len(variant.hashtags) <= limits.max_hashtags:
        problems.append(f"{len(variant.hashtags)} hashtags")
    if len({t.casefold() for t in variant.hashtags}) != len(variant.hashtags):
        problems.append("duplicate hashtags")
    if any(not re.fullmatch(r"#\w+", t) for t in variant.hashtags):
        problems.append("malformed hashtag")
    return problems


@pytest.mark.parametrize("name", INPUTS)
@pytest.mark.parametrize("platform", ALL_PLATFORMS)
def test_every_template_keeps_the_link_tags_and_media_prompt(name, platform):
    variant = channels.template_variant(platform, input_ctx(name))
    assert variant.platform == platform
    assert variant.content.count("{link}") == 1
    assert variant.media_prompt.strip()
    assert tag_problems(platform, variant) == []
    assert not any(t in variant.content for t in variant.hashtags if len(t) > 3)  # tags live in the field


@pytest.mark.parametrize("name", INPUTS)
def test_linkedin_template_is_long_form_for_any_link_length(name):
    variant = channels.template_variant("linkedin", input_ctx(name))
    for link_len in LINK_LENS:
        assert 1200 <= channels.final_length(variant.content, link_len) <= 1800, link_len
    assert len(variant.hashtags) == 3
    lines = variant.content.split("\n")
    assert lines[0] and lines[1] == ""  # punchy hook on its own line, then a blank line
    assert variant.content.count("\n\n") >= 6  # short paragraphs, not a wall of text
    assert re.search(r"^1\. .+\n2\. .+\n3\. ", variant.content, re.MULTILINE)  # insight list
    assert "takeaway" in variant.content.lower()
    assert lines[-1].endswith("{link}")  # the closing call to action carries the tracked link


@pytest.mark.parametrize("name", INPUTS)
def test_instagram_template_is_a_caption_with_a_visual_plan(name):
    variant = channels.template_variant("instagram", input_ctx(name))
    assert 8 <= len(variant.hashtags) <= 15
    assert channels.final_length(variant.content, 120) <= 2200
    assert "\n\n" in variant.content and any(ord(ch) > 0x2000 for ch in variant.content)  # line breaks, emojis
    slides = re.findall(r"Slide (\d+):", variant.media_prompt)
    assert slides == [str(i) for i in range(1, len(slides) + 1)] and 3 <= len(slides) <= 6
    assert variant.media_prompt.count("On-slide text:") == len(slides)
    assert "Brand colours:" in variant.media_prompt and "Setting:" in variant.media_prompt


@pytest.mark.parametrize("name", INPUTS)
def test_tiktok_template_is_a_script_with_a_timed_shot_list(name):
    variant = channels.template_variant("tiktok", input_ctx(name))
    assert 8 <= len(variant.hashtags) <= 15
    lines = variant.content.split("\n")
    assert lines[0].startswith("Hook (0-3s):")
    assert [line.split(" (")[0] for line in lines[1:4]] == ["Beat 1", "Beat 2", "Beat 3"]
    assert lines[4].startswith("CTA") and "{link}" in lines[4]
    assert lines[5].startswith("On-screen text:")
    shots = [(int(a), int(b)) for a, b in re.findall(r"(\d+)-(\d+)s:", variant.media_prompt)]
    assert shots[0][0] == 0 and 15 <= shots[-1][1] <= 30
    assert all(prev[1] == nxt[0] for prev, nxt in pairwise(shots))  # contiguous timings
    assert channels.has_visual_plan("tiktok", variant.media_prompt)


def test_visual_plans_use_the_theme_colour_and_the_brief_setting():
    theme = {"name": "Weekend specials", "description": "Coffee deals", "color": "#ff6600"}
    carousel = channels.template_variant("instagram", ctx_for(brief="Saturday coffee tasting", theme=theme))
    assert "#ff6600" in carousel.media_prompt and "cafe counter" in carousel.media_prompt
    assert "Slide 1:" in carousel.media_prompt

    reel = channels.template_variant("instagram", ctx_for(brief="A 20 second reel of the new menu"))
    assert "Slide 1" not in reel.media_prompt
    assert re.search(r"0-3s:", reel.media_prompt) and channels.has_visual_plan("instagram", reel.media_prompt)

    other_brand = channels.template_variant("instagram", ctx_for(brand="Zephyr Labs", brief="coffee"))
    assert other_brand.media_prompt != carousel.media_prompt  # colours come from the brand


@pytest.mark.parametrize("name", INPUTS)
def test_x_template_fits_the_final_post_for_long_links(name):
    variant = channels.template_variant("x", input_ctx(name))
    for link_len in LINK_LENS:
        assert channels.final_length(variant.content, link_len) <= 280, link_len
    assert variant.content.endswith("{link}")


@pytest.mark.parametrize("name", INPUTS)
def test_reddit_template_has_title_body_and_subreddit(name):
    variant = channels.template_variant("reddit", input_ctx(name))
    lines = variant.content.split("\n")
    assert variant.hashtags == []
    assert 0 < len(lines[0]) <= 120 and "{link}" not in lines[0]
    assert lines[1] == ""
    assert re.fullmatch(r"Suggested subreddit: r/\w{2,21}", lines[-1])
    assert "{link}" in "\n".join(lines[2:-1])  # the tracked link sits inside the body


def test_reddit_subreddit_follows_the_keywords():
    assert channels.pick_subreddit(ctx_for(audience="", offer="")) == "r/smallbusiness"
    assert channels.pick_subreddit(ctx_for(brand="Peak Gym", audience="", offer="", brief="workout plans")) == "r/Fitness"
    assert channels.pick_subreddit(ctx_for(audience="", offer="", brief="SaaS founders")) == "r/startups"
    reddit = channels.template_variant("reddit", ctx_for(audience="", offer="", brief="ecommerce store tips"))
    assert reddit.content.endswith("Suggested subreddit: r/ecommerce")


@pytest.mark.parametrize("name", INPUTS)
def test_facebook_template_is_friendly_and_ends_with_a_question(name):
    variant = channels.template_variant("facebook", input_ctx(name))
    assert variant.content.endswith("?")
    assert channels.final_length(variant.content, 120) <= 2000
    assert len(variant.hashtags) <= 3


def test_templates_are_deterministic():
    ctx = input_ctx("typical")
    for platform in ALL_PLATFORMS:
        assert channels.template_variant(platform, ctx) == channels.template_variant(platform, ctx)


# ------------------------------------------------------------------- one Claude call per channel


def test_one_parallel_call_per_channel_and_one_usage_row(client, seed_ws, monkeypatch):
    headers, ws_id = seed_ws()
    barrier = threading.Barrier(5, timeout=10)  # all five calls must be in flight at once, or this breaks
    calls = fake_model(monkeypatch, parsed=ai_all, usage=(1000, 500), barrier=barrier)

    r = client.post("/api/generate", json={"platforms": ALL_PLATFORMS}, headers=headers)

    assert r.status_code == 200, r.text
    body = r.json()
    assert len(calls) == 5
    assert body["ai_used"] is True
    assert [p["platform"] for p in body["posts"]] == ALL_PLATFORMS
    assert all(p["content"].startswith("[ai] ") for p in body["posts"])
    assert all(p["link_url"] in p["content"] and "{link}" not in p["content"] for p in body["posts"])
    # worker threads, one per call, none of them the request thread
    assert len({c["thread"] for c in calls}) == 5 and threading.get_ident() not in {c["thread"] for c in calls}
    for call in calls:
        assert call["output_format"] is ai.Variants and call["max_tokens"] == 4000
        assert call["output_config"] == {"effort": "low"} and call["model"] == settings.ai_model
    rows = query("SELECT * FROM ai_usage WHERE workspace_id = ?", (ws_id,))
    assert len(rows) == 1 and rows[0]["purpose"] == "generate"
    assert (rows[0]["input_tokens"], rows[0]["output_tokens"]) == (5000, 2500)
    assert rows[0]["cost_usd"] == pytest.approx(5000 * 2 / 1e6 + 2500 * 10 / 1e6)
    detail = query("SELECT detail FROM events WHERE workspace_id = ? AND type = 'generated'", (ws_id,))
    assert detail[0]["detail"] == "6 drafts (AI)"


def test_each_call_only_covers_its_channels_platforms(client, seed_ws, monkeypatch):
    headers, _ = seed_ws()
    calls = fake_model(monkeypatch, parsed=ai_all)

    client.post("/api/generate", json={"platforms": ALL_PLATFORMS}, headers=headers)

    groups = sorted(asked_platforms(c) for c in calls)
    assert groups == [["facebook"], ["instagram", "tiktok"], ["linkedin"], ["reddit"], ["x"]]
    for call in calls:
        platforms = asked_platforms(call)
        channel = channels.channel_for(platforms[0])
        assert call["system"] == channel.system_prompt(platforms)
        other_platforms = [p for p in ALL_PLATFORMS if p not in platforms]
        assert not any(f"- {p}:" in call["system"] for p in other_platforms)
        assert not any(f"What works on {p}" in call["messages"][0]["content"] for p in other_platforms)


def test_platform_order_is_preserved_and_deduplicated(client, seed_ws, monkeypatch):
    headers, _ = seed_ws()
    calls = fake_model(monkeypatch, parsed=ai_all)
    wanted = ["tiktok", "x", "linkedin", "instagram", "x"]

    r = client.post("/api/generate", json={"platforms": wanted}, headers=headers)

    assert [p["platform"] for p in r.json()["posts"]] == ["tiktok", "x", "linkedin", "instagram"]
    assert len(calls) == 3
    assert ["tiktok", "instagram"] in [asked_platforms(c) for c in calls]  # request order inside a channel


def test_connection_errors_fall_back_to_templates_without_usage(client, seed_ws, monkeypatch):
    headers, ws_id = seed_ws()
    calls = fake_model(monkeypatch, exc=connection_error())

    r = client.post("/api/generate", json={"platforms": ALL_PLATFORMS}, headers=headers)

    assert r.status_code == 200 and len(calls) == 5
    body = r.json()
    assert body["ai_used"] is False
    assert [p["platform"] for p in body["posts"]] == ALL_PLATFORMS
    assert not any(p["content"].startswith("[ai]") for p in body["posts"])
    assert query("SELECT * FROM ai_usage WHERE workspace_id = ?", (ws_id,)) == []
    detail = query("SELECT detail FROM events WHERE workspace_id = ? AND type = 'generated'", (ws_id,))
    assert detail[0]["detail"] == "6 drafts (template)"


def test_one_failing_channel_falls_back_alone(client, seed_ws, monkeypatch):
    headers, ws_id = seed_ws()
    fail_x = lambda kwargs: connection_error() if asked_platforms(kwargs) == ["x"] else None
    fake_model(monkeypatch, parsed=ai_all, exc=fail_x)

    body = client.post("/api/generate", json={"platforms": ALL_PLATFORMS}, headers=headers).json()

    assert body["ai_used"] is True
    by = {p["platform"]: p for p in body["posts"]}
    assert not by["x"]["content"].startswith("[ai]")
    assert all(by[p]["content"].startswith("[ai] ") for p in ALL_PLATFORMS if p != "x")
    rows = query("SELECT * FROM ai_usage WHERE workspace_id = ?", (ws_id,))
    assert len(rows) == 1 and (rows[0]["input_tokens"], rows[0]["output_tokens"]) == (4000, 2000)  # 4 answers


def test_no_empty_platform_list_crash_and_cap_skips_all_calls(client, seed_ws, monkeypatch):
    _, ws_id = seed_ws()
    calls = fake_model(monkeypatch, parsed=ai_all)
    monkeypatch.setattr(settings, "ai_workspace_limit", 1)
    execute(
        "INSERT INTO ai_usage (id, workspace_id, purpose, model, input_tokens, output_tokens, cost_usd, ts) "
        "VALUES (?, ?, 'generate', 'm', 0, 0, 0, ?)",
        (new_id("u"), ws_id, now_iso()),
    )

    variants, ai_used = generate_direct(ws_id, ALL_PLATFORMS)
    assert generate_direct(ws_id, []) == ([], False)

    assert ai_used is False and calls == []
    assert [v.platform for v in variants] == ALL_PLATFORMS


# --------------------------------------------------------------- AI output validation / normalising


def test_ai_output_is_repaired_to_each_channels_limits(client, seed_ws, monkeypatch):
    _, ws_id = seed_ws()
    many_tags = [f"tag{i}" for i in range(25)] + ["#Tag1", "tag 2"]
    bad = {
        "instagram": ai_copy("instagram", hashtags=many_tags, media_prompt="a photo"),
        "tiktok": ai_copy("tiktok", hashtags=["#one", "#one", "two"]),
        "x": ai_copy("x", content="Big news " * 60 + "{link} and again {link}", hashtags=["#a", "#b", "#c", "#d"]),
        "linkedin": ai_copy("linkedin", hashtags=["#a", "#b", "#c", "#d", "#e"]),
        "reddit": ai_copy("reddit", content="Honest question about onboarding {link}", hashtags=["#nope"]),
        "facebook": ai_copy("facebook", content="Come and join us at the shop on Saturday {link}", hashtags=[]),
    }
    fake_model(monkeypatch, parsed=lambda kwargs: ai.Variants(variants=[bad[p] for p in asked_platforms(kwargs)]))

    variants, ai_used = generate_direct(ws_id, ALL_PLATFORMS)
    by = by_platform(variants)

    assert ai_used is True and all(v.quality == 0.9 for v in variants)  # every channel kept its AI copy
    link_len = ai._tracked_link_len()
    for platform in ALL_PLATFORMS:
        assert tag_problems(platform, by[platform]) == [], platform
        assert by[platform].content.count("{link}") == 1, platform
    assert len(by["instagram"].hashtags) == 15 and by["instagram"].hashtags[0] == "#tag0"
    assert channels.has_visual_plan("instagram", by["instagram"].media_prompt)  # "a photo" was replaced
    assert by["tiktok"].hashtags[:2] == ["#one", "#two"] and len(by["tiktok"].hashtags) >= 3  # topped up
    assert channels.final_length(by["x"].content, link_len) <= 270
    assert by["x"].content.endswith("{link}") and len(by["x"].hashtags) == 3
    assert by["linkedin"].hashtags == ["#a", "#b", "#c"]
    assert by["reddit"].hashtags == []
    title, blank, *_ = by["reddit"].content.split("\n")
    assert "{link}" not in title and blank == "" and "Suggested subreddit: r/" in by["reddit"].content
    assert by["reddit"].content.split("\n")[-1].startswith("Suggested subreddit: r/")
    assert by["facebook"].content.endswith("?") and "{link}" in by["facebook"].content


def test_hashtags_trailing_the_content_move_to_the_field(client, seed_ws, monkeypatch):
    _, ws_id = seed_ws()
    linkedin = ai_copy("linkedin")
    linkedin = linkedin.model_copy(update={"content": f"{linkedin.content}\n\n#alpha #beta", "hashtags": ["#gamma"]})
    fake_model(monkeypatch, parsed=ai.Variants(variants=[linkedin]))

    (variant,), ai_used = generate_direct(ws_id, ["linkedin"])

    assert ai_used and variant.hashtags == ["#gamma", "#alpha", "#beta"]
    assert "#alpha" not in variant.content and variant.content.rstrip().endswith("{link}")


def test_linkedin_that_cannot_meet_its_limits_falls_back_for_that_channel_only(client, seed_ws, monkeypatch):
    _, ws_id = seed_ws()
    too_long = ai_copy("linkedin", content="word " * 600 + "{link}")  # ~3000 characters
    outputs = {p: ai_copy(p) for p in ALL_PLATFORMS} | {"linkedin": too_long}
    fake_model(monkeypatch, parsed=lambda kwargs: ai.Variants(variants=[outputs[p] for p in asked_platforms(kwargs)]))

    variants, ai_used = generate_direct(ws_id, ALL_PLATFORMS)
    by = by_platform(variants)

    assert ai_used is True
    assert by["linkedin"].quality == 0.5 and not by["linkedin"].content.startswith("[ai]")  # the template
    assert 1200 <= channels.final_length(by["linkedin"].content, 60) <= 1800
    for platform in ("x", "instagram", "tiktok", "reddit", "facebook"):
        assert by[platform].quality == 0.9 and by[platform].content.startswith("[ai] "), platform


def test_short_linkedin_is_topped_up_and_keeps_the_ai_copy(client, seed_ws, monkeypatch):
    _, ws_id = seed_ws()
    short = ai_copy("linkedin", content="Hook line from the model\n\nOne short story paragraph.\n\nRead more: {link}")
    fake_model(monkeypatch, parsed=ai.Variants(variants=[short]))

    (variant,), ai_used = generate_direct(ws_id, ["linkedin"])

    assert ai_used and variant.quality == 0.9
    assert variant.content.startswith("Hook line from the model\n\nOne short story paragraph.\n\n")
    assert variant.content.endswith("Read more: {link}")  # the model's call to action stays last
    assert 1200 <= channels.final_length(variant.content, ai._tracked_link_len()) <= 1800


def test_unusable_ai_output_for_every_channel_means_templates_and_ai_used_false(client, seed_ws, monkeypatch):
    _, ws_id = seed_ws()
    empty = lambda kwargs: ai.Variants(
        variants=[ai.Variant(platform=p, content="   ") for p in asked_platforms(kwargs)]
    )
    fake_model(monkeypatch, parsed=empty)

    variants, ai_used = generate_direct(ws_id, ALL_PLATFORMS)

    assert ai_used is False and [v.platform for v in variants] == ALL_PLATFORMS
    assert len(query("SELECT * FROM ai_usage WHERE workspace_id = ?", (ws_id,))) == 1  # the calls were real


def test_x_is_clipped_against_the_real_link_length(client, seed_ws, monkeypatch):
    headers, _ = seed_ws()
    monkeypatch.setattr(settings, "public_base_url", "https://" + "a" * 70 + ".example.com")
    long_x = ai_copy("x", content="Launch day is here and we could not be more excited. " * 8 + "{link}")
    fake_model(monkeypatch, parsed=ai.Variants(variants=[long_x]))

    body = client.post("/api/generate", json={"platforms": ["x"]}, headers=headers).json()

    (post,) = body["posts"]
    assert body["ai_used"] is True and post["content"].endswith(post["link_url"])
    assert len(post["link_url"]) > 80 and len(post["content"]) <= 270


# ------------------------------------------------------------------------------------ learning loop


def test_prompt_lists_top_themes_and_what_works_per_requested_platform(client, seed_ws, monkeypatch):
    headers, ws_id = seed_ws()
    fake_top_themes(monkeypatch, [("th_a", "Product tips"), ("th_b", "Behind the scenes")])
    fake_what_works(monkeypatch, {"linkedin": "Stories beat tips.", "x": "Questions do best.", "reddit": "Be modest."})
    calls = fake_model(monkeypatch, parsed=ai_all)

    client.post("/api/generate", json={"platforms": ["linkedin", "x", "instagram"]}, headers=headers)

    prompts = {tuple(asked_platforms(c)): c["messages"][0]["content"] for c in calls}
    linkedin = prompts[("linkedin",)]
    assert "Top-performing themes for this workspace: Product tips, Behind the scenes" in linkedin
    assert "What works on linkedin: Stories beat tips." in linkedin
    assert "What works on x" not in linkedin and "What works on reddit" not in linkedin
    assert "What works on x: Questions do best." in prompts[("x",)]
    instagram = prompts[("instagram",)]
    assert "Top-performing themes for this workspace" in instagram
    assert "What works on" not in instagram  # no data for instagram: the line is omitted
    assert ws_id  # the learning is read for this workspace


def test_prompt_omits_learning_when_there_is_none(client, seed_ws, monkeypatch):
    headers, _ = seed_ws()
    fake_top_themes(monkeypatch, [])
    fake_what_works(monkeypatch, {})
    calls = fake_model(monkeypatch, parsed=ai_all)

    client.post("/api/generate", json={"platforms": ["linkedin", "x"]}, headers=headers)

    for call in calls:
        content = call["messages"][0]["content"]
        assert "Top-performing themes" not in content and "What works on" not in content


def test_build_prompt_accepts_a_learning_object(seed_ws):
    _, ws_id = seed_ws()
    learning = ai.Learning(top_themes=["Product tips"], what_works={"x": "Questions do best.", "tiktok": "Hooks."})
    with open_ws(ws_id) as (_, ws):
        plain = ai.build_prompt(ws, ["x"], None, None, "", "")
        full = ai.build_prompt(ws, ["x"], None, None, "launch", "playful", learning)
    assert "Top-performing" not in plain and "What works" not in plain
    assert "Top-performing themes for this workspace: Product tips" in full
    assert "What works on x: Questions do best." in full and "tiktok" not in full
    assert full.rstrip().endswith("in this order: x")


def test_load_learning_never_raises(client, seed_ws, monkeypatch):
    _, ws_id = seed_ws()

    def boom(*args, **kwargs):
        raise RuntimeError("insights are broken")

    monkeypatch.setattr(insights, "top_themes", boom)
    monkeypatch.setattr(insights, "what_works", boom)
    with open_ws(ws_id) as (conn, _):
        learning = ai.load_learning(conn, ws_id)
    assert learning == ai.Learning()

    fake_top_themes(monkeypatch, [("th_a", "Product tips")])
    fake_what_works(monkeypatch, {"x": "Questions do best.", "reddit": ""})
    with open_ws(ws_id) as (conn, _):
        learning = ai.load_learning(conn, ws_id)
    assert learning.top_themes == ["Product tips"] and learning.what_works == {"x": "Questions do best."}


def test_templates_lean_on_the_top_active_theme_when_no_theme_is_given(client, seed_ws, monkeypatch):
    _, ws_id = seed_ws()
    retired = add_theme(ws_id, "Retired idea", active=False)
    weekend = add_theme(ws_id, "Weekend specials", description="Coffee deals")
    other = add_theme(ws_id, "Team stories")
    fake_top_themes(monkeypatch, [(retired, "Retired idea"), ("th_gone", "Deleted"), (weekend, "Weekend specials")])

    (facebook,), ai_used = generate_direct(ws_id, ["facebook"])
    assert ai_used is False
    assert "Our focus this week is Weekend specials" in facebook.content  # skips inactive and unknown themes
    assert "#weekendspecials" in facebook.hashtags

    with open_ws(ws_id) as (conn, ws):  # an explicit theme always wins
        chosen = conn.execute("SELECT * FROM themes WHERE id = ?", (other,)).fetchone()
        (explicit,), _ = ai.generate_variants(conn, ws, platforms=["facebook"], theme=chosen)
    assert "Our focus this week is Team stories" in explicit.content

    fake_top_themes(monkeypatch, [])
    (plain,), _ = generate_direct(ws_id, ["facebook"])
    assert "Our focus this week" not in plain.content


def test_the_model_prompt_is_not_biased_towards_a_theme_the_user_did_not_pick(client, seed_ws, monkeypatch):
    headers, ws_id = seed_ws()
    weekend = add_theme(ws_id, "Weekend specials")
    fake_top_themes(monkeypatch, [(weekend, "Weekend specials")])
    calls = fake_model(monkeypatch, parsed=ai_all)

    client.post("/api/generate", json={"platforms": ["x"]}, headers=headers)

    content = calls[0]["messages"][0]["content"]
    assert "Theme: " not in content  # only the learning line mentions it
    assert "Top-performing themes for this workspace: Weekend specials" in content


# ------------------------------------------------------------------------ theme assignment


def test_save_variants_writes_manual_post_themes_only_when_a_theme_is_given(client, seed_ws):
    _, ws_id = seed_ws()
    theme_id = add_theme(ws_id, "Product tips")
    variants = [ai.Variant(platform="x", content="Hello {link}"), ai.Variant(platform="reddit", content="Hi {link}")]
    with open_ws(ws_id) as (conn, ws):
        themed = ai.save_variants(
            conn, ws, variants, batch_id="b1", theme_id=theme_id, trend_id=None, source="autopilot", status="published"
        )
        plain = ai.save_variants(conn, ws, variants, batch_id="b2", theme_id=None, trend_id=None, source="ai")

    rows = query("SELECT * FROM post_themes ORDER BY post_id")
    assert sorted(r["post_id"] for r in rows) == sorted(p.id for p in themed)
    assert {(r["theme_id"], r["classifier"], r["confidence"]) for r in rows} == {(theme_id, "manual", 1.0)}
    assert not {r["post_id"] for r in rows} & {p.id for p in plain}


def test_generate_with_a_theme_writes_manual_post_themes_and_skips_the_classifier(client, seed_ws, monkeypatch):
    headers, ws_id = seed_ws()
    theme_id = add_theme(ws_id, "Product tips")
    classified: list[tuple] = []
    monkeypatch.setattr(classify, "classify_posts", lambda *args, **kwargs: classified.append(args) or [])

    r = client.post(
        "/api/generate", json={"platforms": ["x", "linkedin", "reddit"], "theme_id": theme_id}, headers=headers
    )

    assert r.status_code == 200, r.text
    post_ids = [p["id"] for p in r.json()["posts"]]
    rows = query("SELECT * FROM post_themes WHERE theme_id = ?", (theme_id,))
    assert sorted(row["post_id"] for row in rows) == sorted(post_ids)
    assert all(row["classifier"] == "manual" and row["confidence"] == 1.0 for row in rows)
    assert classified == []


def test_generate_without_a_theme_calls_the_classifier_with_the_new_posts(client, seed_ws, monkeypatch):
    headers, ws_id = seed_ws()
    seen: list[tuple] = []

    def record(conn, workspace_id, post_ids):
        seen.append((workspace_id, list(post_ids)))
        assert conn.execute("SELECT COUNT(*) FROM posts WHERE id IN (?, ?)", post_ids[:2]).fetchone()[0] == 2
        return []

    monkeypatch.setattr(classify, "classify_posts", record)

    r = client.post("/api/generate", json={"platforms": ["x", "linkedin", "reddit"]}, headers=headers)

    assert r.status_code == 200, r.text
    assert seen == [(ws_id, [p["id"] for p in r.json()["posts"]])]
    assert query("SELECT * FROM post_themes") == []  # nothing is guessed on the generate path itself


def test_a_failing_classifier_never_breaks_generate(client, seed_ws, monkeypatch):
    headers, ws_id = seed_ws()

    def boom(*args, **kwargs):
        raise RuntimeError("classifier exploded")

    monkeypatch.setattr(classify, "classify_posts", boom)

    r = client.post("/api/generate", json={"platforms": ["x"]}, headers=headers)

    assert r.status_code == 200 and len(r.json()["posts"]) == 1
    detail = query("SELECT detail FROM events WHERE workspace_id = ? AND type = 'generated'", (ws_id,))
    assert detail[0]["detail"] == "1 drafts (template)"
