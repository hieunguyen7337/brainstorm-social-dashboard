"""AI generation, themes and AI usage (U2). The Anthropic client is always faked; no real calls."""

import importlib
import json
import secrets
import sqlite3
import sys
import types
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from app.config import settings
from app.db import connect, new_id, now_iso
from app.models import Post

PLATFORMS = ["x", "linkedin", "instagram", "tiktok", "reddit", "facebook"]


def _install_posts_standin() -> None:
    """app.services.posts belongs to another unit; use a minimal stand-in until it lands."""
    try:
        importlib.import_module("app.services.posts")
        return
    except ImportError:
        pass

    def create_post(conn, workspace_id, *, platform, content, hashtags, media_prompt, theme_id, trend_id,
                    batch_id, source, quality, status):
        post_id, link_code = new_id("p"), new_id("l")
        conn.execute(
            "INSERT INTO posts (id, workspace_id, platform, content, hashtags, media_prompt, theme_id, trend_id, "
            "batch_id, link_code, status, source, quality, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (post_id, workspace_id, platform, content, json.dumps(hashtags), media_prompt, theme_id,
             trend_id, batch_id, link_code, status, source, quality, now_iso()),
        )
        conn.commit()
        return conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()

    def row_to_post(row) -> Post:
        return Post(
            id=row["id"], platform=row["platform"], content=row["content"],
            hashtags=json.loads(row["hashtags"]), media_prompt=row["media_prompt"],
            theme_id=row["theme_id"], trend_id=row["trend_id"], batch_id=row["batch_id"],
            link_code=row["link_code"], link_url=f"{settings.public_base_url}/r/{row['link_code']}",
            status=row["status"], source=row["source"], scheduled_at=row["scheduled_at"],
            published_at=row["published_at"], views=row["views"], engagements=row["engagements"],
            clicks=row["clicks"], conversions=row["conversions"], created_at=row["created_at"],
        )

    stub = types.ModuleType("app.services.posts")
    stub.create_post = create_post
    stub.row_to_post = row_to_post
    sys.modules["app.services.posts"] = stub


_install_posts_standin()

from app.services import ai


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


def insert_usage(workspace_id: str | None, *, cost: float = 0.0, input_tokens: int = 0, output_tokens: int = 0):
    execute(
        "INSERT INTO ai_usage (id, workspace_id, purpose, model, input_tokens, output_tokens, cost_usd, ts) "
        "VALUES (?, ?, 'generate', ?, ?, ?, ?, ?)",
        (new_id("u"), workspace_id, settings.ai_model, input_tokens, output_tokens, cost, now_iso()),
    )


def fake_model(monkeypatch, *, parsed=None, stop_reason="end_turn", usage=(1000, 500), exc=None) -> list[dict]:
    """Patches the client and the key; returns the list of kwargs each messages.parse call received."""
    calls: list[dict] = []

    def parse(**kwargs):
        calls.append(kwargs)
        if exc is not None:
            raise exc
        return SimpleNamespace(
            parsed_output=parsed,
            stop_reason=stop_reason,
            usage=SimpleNamespace(input_tokens=usage[0], output_tokens=usage[1]),
        )

    fake = SimpleNamespace(messages=SimpleNamespace(parse=parse))
    monkeypatch.setattr(ai, "get_client", lambda: fake)
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    return calls


def ai_variants(*platforms: str) -> ai.Variants:
    return ai.Variants(
        variants=[
            ai.Variant(platform=p, content=f"{p} copy for Acme {{link}}", hashtags=["#acme"],
                       media_prompt="a photo", quality=0.9)
            for p in platforms
        ]
    )


def generate(client, headers, **body):
    return client.post("/api/generate", json={"platforms": ["x", "linkedin", "reddit"], **body},
                       headers=headers)


@pytest.fixture()
def seed(client):
    """Seeds a guest workspace row; returns (headers, workspace_id)."""

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


def test_model_drafts_are_saved_with_real_links(client, seed, monkeypatch):
    headers, ws_id = seed()
    calls = fake_model(monkeypatch, parsed=ai_variants("x", "linkedin", "reddit"))

    r = generate(client, headers)

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ai_used"] is True
    assert [p["platform"] for p in body["posts"]] == ["x", "linkedin", "reddit"]
    for post in body["posts"]:
        assert post["status"] == "draft" and post["source"] == "ai" and post["batch_id"] == body["batch_id"]
        assert post["link_url"] in post["content"]
        assert "{link}" not in post["content"]
    quality = query("SELECT quality FROM posts WHERE workspace_id = ?", (ws_id,))
    assert {row["quality"] for row in quality} == {0.9}
    assert calls[0]["output_format"] is ai.Variants
    assert calls[0]["max_tokens"] == 4000
    assert calls[0]["output_config"] == {"effort": "low"}
    assert calls[0]["model"] == settings.ai_model
    event = query("SELECT detail FROM events WHERE workspace_id = ? AND type = 'generated'", (ws_id,))
    assert event[0]["detail"] == "3 drafts (AI)"


def test_photos_are_sent_to_the_model_as_images(client, seed, monkeypatch):
    headers, _ = seed()
    calls = fake_model(monkeypatch, parsed=ai_variants("x", "linkedin", "reddit"))
    photos = [{"image_base64": "ZmFrZQ==", "media_type": "image/jpeg"},
              {"image_base64": "data:image/png;base64,ZmFrZQ==", "media_type": "image/png"}]

    r = generate(client, headers, photos=photos)

    assert r.status_code == 200, r.text
    for call in calls:
        content = call["messages"][0]["content"]
        assert [b["type"] for b in content] == ["image", "image", "text"]
        assert content[0]["source"] == {"type": "base64", "media_type": "image/jpeg", "data": "ZmFrZQ=="}
        assert content[1]["source"]["data"] == "ZmFrZQ=="  # the data: prefix is stripped
        assert "2 photos" in content[2]["text"]


def test_no_photos_keeps_a_plain_text_prompt(client, seed, monkeypatch):
    headers, _ = seed()
    calls = fake_model(monkeypatch, parsed=ai_variants("x", "linkedin", "reddit"))
    assert generate(client, headers).status_code == 200
    assert all(isinstance(call["messages"][0]["content"], str) for call in calls)


def test_photos_are_validated(client, seed, monkeypatch):
    headers, _ = seed()
    fake_model(monkeypatch, parsed=ai_variants("x", "linkedin", "reddit"))
    bad_type = generate(client, headers, photos=[{"image_base64": "ZmFrZQ==", "media_type": "image/gif"}])
    assert bad_type.status_code == 415
    not_b64 = generate(client, headers, photos=[{"image_base64": "***", "media_type": "image/jpeg"}])
    assert not_b64.status_code == 422
    eleven = [{"image_base64": "ZmFrZQ==", "media_type": "image/jpeg"}] * 11
    assert generate(client, headers, photos=eleven).status_code == 422


def test_refusal_falls_back_to_templates(client, seed, monkeypatch):
    headers, ws_id = seed()
    fake_model(monkeypatch, parsed=None, stop_reason="refusal")

    body = generate(client, headers).json()

    assert body["ai_used"] is False
    assert len(body["posts"]) == 3
    assert all("{link}" not in p["content"] for p in body["posts"])
    assert len(query("SELECT * FROM ai_usage WHERE workspace_id = ?", (ws_id,))) == 1  # response was real


def test_connection_error_falls_back_to_templates(client, seed, monkeypatch):
    headers, ws_id = seed()
    exc = anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))
    fake_model(monkeypatch, exc=exc)

    r = generate(client, headers)

    assert r.status_code == 200
    assert r.json()["ai_used"] is False
    assert len(r.json()["posts"]) == 3
    assert query("SELECT * FROM ai_usage WHERE workspace_id = ?", (ws_id,)) == []


@pytest.mark.parametrize("cap", ["workspace", "global"])
def test_cap_reached_skips_the_model(client, seed, monkeypatch, cap):
    headers, ws_id = seed()
    calls = fake_model(monkeypatch, parsed=ai_variants("x"))
    if cap == "workspace":
        monkeypatch.setattr(settings, "ai_workspace_limit", 2)
        insert_usage(ws_id, cost=0.01)
        insert_usage(ws_id, cost=0.01)
    else:
        insert_usage(None, cost=settings.ai_global_cap_usd)

    r = client.post("/api/generate", json={"platforms": ["x"]}, headers=headers)

    assert r.status_code == 200
    assert r.json()["ai_used"] is False
    assert calls == []


def test_cost_is_recorded_from_usage(client, seed, monkeypatch):
    headers, ws_id = seed()
    fake_model(monkeypatch, parsed=ai_variants("x"), usage=(1234, 567))

    client.post("/api/generate", json={"platforms": ["x"]}, headers=headers)

    rows = query("SELECT * FROM ai_usage WHERE workspace_id = ?", (ws_id,))
    assert len(rows) == 1
    assert rows[0]["purpose"] == "generate"
    assert (rows[0]["input_tokens"], rows[0]["output_tokens"]) == (1234, 567)
    assert rows[0]["cost_usd"] == pytest.approx(1234 * 2 / 1e6 + 567 * 10 / 1e6)


def test_generate_is_rate_limited_per_workspace(client, seed):
    headers, _ = seed()
    other_headers, _ = seed("Other")

    first = client.post("/api/generate", json={"platforms": ["x"]}, headers=headers)
    second = client.post("/api/generate", json={"platforms": ["x"]}, headers=headers)
    other = client.post("/api/generate", json={"platforms": ["x"]}, headers=other_headers)

    assert first.status_code == 200
    assert second.status_code == 429
    assert "detail" in second.json()
    assert other.status_code == 200


def test_themes_crud_and_workspace_isolation(client, seed):
    headers_a, _ = seed("Acme")
    headers_b, _ = seed("Other")

    created = client.post("/api/themes", json={"name": "Tips", "description": "Quick wins"}, headers=headers_a)
    assert created.status_code == 200, created.text
    theme = created.json()
    assert theme["active"] is True and theme["color"] == "#7c5cff"
    theme_id = theme["id"]

    assert [t["id"] for t in client.get("/api/themes", headers=headers_a).json()] == [theme_id]
    patched = client.patch(f"/api/themes/{theme_id}", json={"name": "Hacks", "active": False},
                           headers=headers_a).json()
    assert patched["name"] == "Hacks" and patched["active"] is False

    assert client.get("/api/themes", headers=headers_b).json() == []
    assert client.patch(f"/api/themes/{theme_id}", json={"name": "x"}, headers=headers_b).status_code == 404
    assert client.delete(f"/api/themes/{theme_id}", headers=headers_b).status_code == 404
    other_generate = client.post("/api/generate", json={"platforms": ["x"], "theme_id": theme_id},
                                 headers=headers_b)
    assert other_generate.status_code == 404

    assert client.delete(f"/api/themes/{theme_id}", headers=headers_a).json() == {"ok": True}
    assert client.get("/api/themes", headers=headers_a).json() == []


def test_unknown_trend_is_404(client, seed):
    headers, _ = seed()
    r = client.post("/api/generate", json={"platforms": ["x"], "trend_id": "nope"}, headers=headers)
    assert r.status_code == 404


def test_ai_usage_shape(client, seed, monkeypatch):
    headers, ws_id = seed()
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    body = client.get("/api/ai/usage", headers=headers).json()
    assert body == {
        "workspace_used": 0,
        "workspace_limit": settings.ai_workspace_limit,
        "global_spent_usd": 0.0,
        "global_cap_usd": settings.ai_global_cap_usd,
        "ai_available": False,
    }

    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    insert_usage(ws_id, cost=1.5)
    body = client.get("/api/ai/usage", headers=headers).json()
    assert body["workspace_used"] == 1
    assert body["global_spent_usd"] == pytest.approx(1.5)
    assert body["ai_available"] is True


def test_template_fallback_covers_every_platform(client, seed, monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    headers, ws_id = seed()
    trend_id = new_id("t")
    execute(
        "INSERT INTO trends (id, source, title, url, score, region, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (trend_id, "hackernews", "Small teams ship faster with AI helpers", "https://example.com/story",
         0.8, "", now_iso()),
    )
    theme = client.post("/api/themes", json={"name": "Product tips", "description": "Short, practical"},
                        headers=headers).json()

    r = client.post(
        "/api/generate",
        json={"platforms": PLATFORMS, "theme_id": theme["id"], "trend_id": trend_id,
              "brief": "Our new onboarding checklist " * 30, "tone": "playful"},
        headers=headers,
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ai_used"] is False
    assert [p["platform"] for p in body["posts"]] == PLATFORMS
    for post in body["posts"]:
        assert post["link_url"] in post["content"]
        assert "{link}" not in post["content"]
        assert post["media_prompt"]
        limits = ai.channels.channel_for(post["platform"])
        assert limits.min_hashtags <= len(post["hashtags"]) <= limits.max_hashtags
    by_platform = {p["platform"]: p for p in body["posts"]}
    assert len(by_platform["x"]["content"]) <= 270
    assert 1200 <= len(by_platform["linkedin"]["content"]) <= 1800
    assert len(by_platform["linkedin"]["hashtags"]) == 3
    assert by_platform["facebook"]["content"].endswith("?")
    event = query("SELECT detail FROM events WHERE workspace_id = ? AND type = 'generated'", (ws_id,))
    assert event[0]["detail"] == "6 drafts (template)"

    # Thinnest possible brand: no offer, audience, brief, theme or trend.
    thin_headers, thin_ws = seed("Thin")
    execute("UPDATE workspaces SET audience = '', offer = '' WHERE id = ?", (thin_ws,))
    thin = client.post("/api/generate", json={"platforms": PLATFORMS}, headers=thin_headers).json()
    thin_by_platform = {p["platform"]: p for p in thin["posts"]}
    assert len(thin_by_platform["x"]["content"]) <= 270
    assert 1200 <= len(thin_by_platform["linkedin"]["content"]) <= 1800
    assert len(thin_by_platform["linkedin"]["hashtags"]) == 3


def test_save_variants_published_sets_timestamps(client, seed):
    _, ws_id = seed()
    conn = connect()
    try:
        ws = conn.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,)).fetchone()
        posts = ai.save_variants(
            conn, ws, [ai.Variant(platform="x", content="Hello {link}")],
            batch_id="b1", theme_id=None, trend_id=None, source="autopilot", status="published",
        )
    finally:
        conn.close()
    assert posts[0].status == "published"
    assert posts[0].published_at is not None
    assert posts[0].content == f"Hello {posts[0].link_url}"
