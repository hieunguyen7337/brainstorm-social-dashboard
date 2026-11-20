"""Room mode: create, public room, vote, onboard, stats, close. The Anthropic client is always faked."""

import re
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.config import settings
from app.db import connect, now_iso
from app.services import ai, rooms

CODE_RE = re.compile(r"^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$")


def query(sql: str, args: tuple = ()) -> list:
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


@pytest.fixture(autouse=True)
def no_stats_cache(monkeypatch):
    monkeypatch.setattr(rooms, "STATS_TTL", 0)


@pytest.fixture()
def setup(auth):
    """(client, headers, workspace json, {theme name: theme id}) for a seeded workspace."""
    client, headers, ws = auth
    themes = {t["name"]: t["id"] for t in client.get("/api/themes", headers=headers).json()}
    return client, headers, ws, themes


def make_post(client, headers, theme_id, content="A LinkedIn draft about our latest idea.", platform="linkedin"):
    r = client.post(
        "/api/posts",
        json={"platform": platform, "content": content, "theme_id": theme_id, "status": "draft"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def new_room(client, headers, **body) -> dict:
    r = client.post("/api/rooms", json=body, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def room_with_posts(setup, **body) -> tuple:
    """A room over two fresh drafts with different themes; returns (client, headers, ws, room, post a, post b)."""
    client, headers, ws, themes = setup
    a = make_post(client, headers, themes["Behind the beans"], "Post A about beans.")
    b = make_post(client, headers, themes["Plant care tips"], "Post B about plants.")
    room = new_room(client, headers, post_a=a["id"], post_b=b["id"], **body)
    return client, headers, ws, room, a, b


def vote(client, code, choice):
    return client.post(f"/api/rooms/{code}/vote", json={"choice": choice})


def new_voter(client) -> None:
    client.cookies.clear()


def real_counts(client, headers) -> tuple[int, int]:
    d = client.get("/api/dashboard", headers=headers).json()
    return d["real_clicks"], d["real_conversions"]


def post_counts(post_id: str) -> tuple[int, int]:
    row = query("SELECT clicks, conversions FROM posts WHERE id = ?", (post_id,))[0]
    return row["clicks"], row["conversions"]


def add_votes(room_id: str, votes: list[tuple[str, str, str]]) -> None:
    """Direct `room_votes` rows: (voter, choice, created_at). A choice of '' is a scan."""
    for voter, choice, at in votes:
        execute(
            "INSERT INTO room_votes (room_id, voter, choice, onboarded, created_at) VALUES (?,?,?,0,?)",
            (room_id, voter, choice, at),
        )


def fake_model(monkeypatch, *, limit: int | None = None) -> list[dict]:
    """Fakes the Anthropic client and key; returns the kwargs of each messages.parse call."""
    calls: list[dict] = []

    def parse(**kwargs):
        calls.append(kwargs)
        variant = ai.Variant(
            platform="linkedin", content=f"AI draft number {len(calls)}. Read more: {{link}}",
            hashtags=["#ai"], media_prompt="a photo", quality=0.9,
        )
        return SimpleNamespace(
            parsed_output=ai.Variants(variants=[variant]), stop_reason="end_turn",
            usage=SimpleNamespace(input_tokens=1000, output_tokens=500),
        )

    monkeypatch.setattr(ai, "get_client", lambda: SimpleNamespace(messages=SimpleNamespace(parse=parse)))
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    if limit is not None:
        monkeypatch.setattr(settings, "ai_workspace_limit", limit)
    return calls


def drop_seeded_drafts(ws_id: str) -> None:
    execute("DELETE FROM posts WHERE workspace_id = ? AND platform = 'linkedin' AND status = 'draft'", (ws_id,))


# ---------------------------------------------------------------- create


def test_create_room_with_explicit_posts(setup):
    client, headers, ws, themes = setup
    a = make_post(client, headers, themes["Behind the beans"])
    b = make_post(client, headers, themes["Plant care tips"])
    before = len(client.get("/api/posts?limit=200", headers=headers).json())

    body = new_room(client, headers, title="Pick one", post_a=a["id"], post_b=b["id"])

    assert CODE_RE.match(body["code"])
    assert body["title"] == "Pick one" and body["status"] == "open" and body["id"].startswith("rm_")
    assert (body["post_a"], body["post_b"]) == (a["id"], b["id"])
    assert [p["id"] for p in body["posts"]] == [a["id"], b["id"]]
    assert body["posts"][0]["platform"] == "linkedin" and body["posts"][0]["link_url"]
    assert len(client.get("/api/posts?limit=200", headers=headers).json()) == before  # nothing generated
    row = query("SELECT * FROM rooms WHERE code = ?", (body["code"],))[0]
    assert (row["workspace_id"], row["status"], row["post_a"], row["post_b"]) == (ws["id"], "open", a["id"], b["id"])


def test_create_room_urls_title_and_code_alphabet(setup, monkeypatch):
    monkeypatch.setattr(settings, "public_base_url", "https://pulse.example.com/")
    client, headers, ws, room, _, _ = room_with_posts(setup)
    code = room["code"]
    assert CODE_RE.match(code)
    assert room["title"] == "Which post would you click?"
    assert room["join_url"] == f"https://pulse.example.com/v/{code}"
    assert room["screen_url"] == f"https://pulse.example.com/room/{code}"
    assert room["presenter_url"] == f"https://pulse.example.com/room/{code}?token={ws['token']}"
    assert new_room(client, headers, title="   ")["title"] == "Which post would you click?"


def test_create_room_without_posts_generates_two_themed_drafts(setup):
    client, headers, ws, themes = setup
    drop_seeded_drafts(ws["id"])  # no qualifying draft left, so both slots are generated

    room = new_room(client, headers, brief="Launch week")

    posts = room["posts"]
    assert len(posts) == 2 and posts[0]["id"] != posts[1]["id"]
    assert {p["platform"] for p in posts} == {"linkedin"} and {p["status"] for p in posts} == {"draft"}
    assert {p["source"] for p in posts} == {"ai"}
    theme_ids = {p["theme_id"] for p in posts}
    assert len(theme_ids) == 2 and theme_ids <= set(themes.values())
    assert all("Launch week" in p["content"] for p in posts)  # the brief reaches the template fallback
    assert all("{link}" not in p["content"] and p["link_url"] in p["content"] for p in posts)
    assert query("SELECT COUNT(*) AS n FROM ai_usage")[0]["n"] == 0  # no key: templates only


def test_create_room_keeps_the_single_seeded_draft_and_generates_the_other(setup):
    client, headers, _ws, _themes = setup
    seeded = client.get("/api/posts?status=draft&platform=linkedin", headers=headers).json()
    assert len(seeded) == 1

    room = new_room(client, headers)

    ids = {room["post_a"], room["post_b"]}
    assert seeded[0]["id"] in ids
    by_id = {p["id"]: p for p in room["posts"]}
    fresh = by_id[(ids - {seeded[0]["id"]}).pop()]
    assert fresh["theme_id"] and fresh["theme_id"] != seeded[0]["theme_id"]
    assert fresh["platform"] == "linkedin" and fresh["status"] == "draft"
    assert len(client.get("/api/posts?status=draft&platform=linkedin", headers=headers).json()) == 2


def test_create_room_reuses_two_newest_drafts_with_different_themes(setup, monkeypatch):
    client, headers, _ws, themes = setup
    t1, t2 = themes["Behind the beans"], themes["Plant care tips"]
    make_post(client, headers, t1, "oldest, theme 1")
    d2 = make_post(client, headers, t1, "newer, theme 1")
    d3 = make_post(client, headers, t2, "newest with a theme, theme 2")
    make_post(client, headers, None, "newest of all but no theme")
    make_post(client, headers, t2, "an instagram draft", platform="instagram")

    def boom(*args, **kwargs):
        raise AssertionError("generation must not run when two drafts qualify")

    monkeypatch.setattr(ai, "generate_variants", boom)
    before = query("SELECT COUNT(*) AS n FROM posts")[0]["n"]

    room = new_room(client, headers)

    assert (room["post_a"], room["post_b"]) == (d3["id"], d2["id"])
    assert query("SELECT COUNT(*) AS n FROM posts")[0]["n"] == before


def test_create_room_rejects_bad_posts(setup):
    client, headers, _ws, themes = setup
    mine = make_post(client, headers, themes["Behind the beans"])
    other = client.post("/api/workspaces", json={}).json()
    other_headers = {"Authorization": f"Bearer {other['token']}"}
    theirs = client.get("/api/posts?limit=1", headers=other_headers).json()[0]
    before = query("SELECT COUNT(*) AS n FROM rooms")[0]["n"]

    only_one = client.post("/api/rooms", json={"post_a": mine["id"]}, headers=headers)
    assert (only_one.status_code, only_one.json()) == (400, {"detail": "give both post_a and post_b, or neither"})
    only_b = client.post("/api/rooms", json={"post_b": mine["id"]}, headers=headers)
    assert only_b.status_code == 400
    same = client.post("/api/rooms", json={"post_a": mine["id"], "post_b": mine["id"]}, headers=headers)
    assert (same.status_code, same.json()) == (400, {"detail": "pick two different posts"})
    unknown = client.post("/api/rooms", json={"post_a": mine["id"], "post_b": "p_nope"}, headers=headers)
    assert unknown.status_code == 404
    foreign = client.post("/api/rooms", json={"post_a": mine["id"], "post_b": theirs["id"]}, headers=headers)
    assert foreign.status_code == 404
    assert client.post("/api/rooms", json={}).status_code == 401
    assert client.post("/api/rooms", json={"title": "x" * 81}, headers=headers).status_code == 422
    assert query("SELECT COUNT(*) AS n FROM rooms")[0]["n"] == before


def test_create_room_retries_a_code_collision(setup, monkeypatch):
    client, headers, _ws, _themes = setup
    codes = iter(["AAAAAA", "AAAAAA", "BBBBBB"])
    monkeypatch.setattr(rooms, "new_code", lambda: next(codes))
    first = new_room(client, headers)
    second = new_room(client, headers)
    assert (first["code"], second["code"]) == ("AAAAAA", "BBBBBB")


def test_create_room_uses_the_ai_when_allowed(setup, monkeypatch):
    client, headers, ws, _themes = setup
    drop_seeded_drafts(ws["id"])
    calls = fake_model(monkeypatch)

    room = new_room(client, headers, brief="Our big launch")

    assert len(calls) == 2  # one model call per slot
    prompts = [c["messages"][0]["content"] for c in calls]
    assert all("Brief: Our big launch" in p and "Theme: " in p for p in prompts)
    assert prompts[0].split("Theme: ")[1] != prompts[1].split("Theme: ")[1]
    contents = sorted(p["content"] for p in room["posts"])
    assert contents[0].startswith("AI draft number 1.") and contents[1].startswith("AI draft number 2.")
    assert all(p["link_url"] in p["content"] and "{link}" not in p["content"] for p in room["posts"])
    assert len({p["theme_id"] for p in room["posts"]}) == 2
    usage = query("SELECT purpose, workspace_id FROM ai_usage")
    assert [(u["purpose"], u["workspace_id"]) for u in usage] == [("generate", ws["id"])] * 2


def test_create_room_falls_back_to_templates_when_the_ai_cap_is_reached(setup, monkeypatch):
    client, headers, ws, _themes = setup
    drop_seeded_drafts(ws["id"])
    calls = fake_model(monkeypatch, limit=0)  # key present, workspace limit exhausted

    room = new_room(client, headers)

    assert calls == [] and len(room["posts"]) == 2
    assert all("Read more:" in p["content"] for p in room["posts"])  # the template fallback copy


# ---------------------------------------------------------------- public room


def test_public_room_clips_content_and_leaks_nothing(setup):
    client, headers, ws, themes = setup
    long = " ".join(f"word{i}" for i in range(400))  # ~2700 characters
    a = make_post(client, headers, themes["Behind the beans"], long)
    b = make_post(client, headers, themes["Plant care tips"], "Short and sweet.")
    room = new_room(client, headers, title="Vote!", post_a=a["id"], post_b=b["id"])

    r = client.get(f"/api/rooms/{room['code'].lower()}")  # lookup is case-insensitive

    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"code", "title", "status", "variants"}
    assert (body["code"], body["title"], body["status"]) == (room["code"], "Vote!", "open")
    va, vb = body["variants"]
    assert (va["choice"], vb["choice"]) == ("a", "b")
    assert set(va) == {"choice", "platform", "content", "theme", "theme_color", "media_prompt"}
    assert len(va["content"]) <= 700 and va["content"].endswith("...")
    kept = va["content"][:-3]
    assert long.startswith(kept) and long[len(kept)] == " "  # cut at a word boundary
    assert vb["content"] == "Short and sweet."
    assert (va["theme"], vb["theme"]) == ("Behind the beans", "Plant care tips")
    assert va["theme_color"].startswith("#") and va["platform"] == "linkedin"
    assert ws["id"] not in r.text and ws["token"] not in r.text
    assert client.get("/api/rooms/ZZZZZZ").json() == {"detail": "room not found"}
    assert client.get("/api/rooms/ZZZZZZ").status_code == 404


def test_public_room_survives_a_deleted_post_and_a_missing_theme(setup):
    client, headers, _ws, themes = setup
    a = make_post(client, headers, None, "No theme here.")
    b = make_post(client, headers, themes["Customer stories"], "Theme here.")
    room = new_room(client, headers, post_a=a["id"], post_b=b["id"])

    va, vb = client.get(f"/api/rooms/{room['code']}").json()["variants"]
    assert (va["theme"], va["theme_color"]) == ("", "#7C5CFF") and vb["theme"] == "Customer stories"

    assert client.delete(f"/api/posts/{b['id']}", headers=headers).status_code == 200
    r = client.get(f"/api/rooms/{room['code']}")
    assert r.status_code == 200
    assert r.json()["variants"][1] == {
        "choice": "b", "platform": "linkedin", "content": "", "theme": "", "theme_color": "#7C5CFF",
        "media_prompt": "",
    }
    assert vote(client, room["code"], "b").status_code == 200  # still votable, nothing to track


def test_clip_text_boundaries():
    assert rooms.clip_text("short") == "short"
    exact = "x" * 700
    assert rooms.clip_text(exact) == exact
    giant = "y" * 900  # no space to cut at
    assert rooms.clip_text(giant) == "y" * 697 + "..."
    words = "aa " * 400
    clipped = rooms.clip_text(words)
    assert len(clipped) <= 700 and clipped.endswith("aa...")
    assert rooms.clip_text("ab " * 233 + "abcdefgh " * 10).endswith("ab...")  # never ends mid-word


def test_qr_svg_is_inline_and_memoised():
    svg = rooms.qr_svg("http://localhost:8000/v/K7QX3M")
    assert svg.startswith("<svg") and "viewBox" in svg and 'class="qr"' in svg and "<?xml" not in svg
    assert "width=" not in svg.split(">", 1)[0]  # sized by CSS, not by attributes
    assert rooms.qr_svg("http://localhost:8000/v/K7QX3M") is svg
    assert rooms.display_url("https://pulse.example.com/v/K7QX3M") == "pulse.example.com/v/K7QX3M"
    assert rooms.display_url("localhost:8000/v/K7QX3M") == "localhost:8000/v/K7QX3M"


# ---------------------------------------------------------------- vote


def test_vote_sets_cookie_and_records_a_real_click(setup):
    client, headers, _ws, room, a, b = room_with_posts(setup)
    clicks_before = real_counts(client, headers)[0]
    a_before, b_before = post_counts(a["id"])[0], post_counts(b["id"])[0]

    r = vote(client, room["code"], "a")

    assert r.status_code == 200
    assert r.json() == {"ok": True, "choice": "a", "votes": {"a": 1, "b": 0}}
    cookie = r.headers["set-cookie"]
    assert cookie.startswith("pv=") and "HttpOnly" in cookie and "SameSite=lax" in cookie
    assert "Path=/" in cookie and "Max-Age=86400" in cookie and "Secure" not in cookie
    assert re.fullmatch(r"[A-Za-z0-9_-]{16}", client.cookies["pv"])
    assert real_counts(client, headers)[0] == clicks_before + 1
    assert post_counts(a["id"])[0] == a_before + 1 and post_counts(b["id"])[0] == b_before
    assert "set-cookie" not in vote(client, room["code"], "a").headers  # cookie already there
    acts = client.get("/api/activity?limit=5", headers=headers).json()
    assert any(x["type"] == "click" and x["real"] for x in acts)


def test_revote_changes_choice_without_adding_a_voter(setup):
    client, headers, _ws, room, a, b = room_with_posts(setup)
    code = room["code"]
    assert vote(client, code, "a").json()["votes"] == {"a": 1, "b": 0}

    r = vote(client, code, "b")

    assert r.json() == {"ok": True, "choice": "b", "votes": {"a": 0, "b": 1}}
    rows = query("SELECT voter, choice FROM room_votes WHERE room_id = ?", (room["id"],))
    assert [(x["voter"], x["choice"]) for x in rows] == [(client.cookies["pv"], "b")]
    assert client.get(f"/api/rooms/{code}/stats").json()["votes"] == {"a": 0, "b": 1}
    assert post_counts(a["id"])[0] == 1 and post_counts(b["id"])[0] == 1  # one click per change
    assert real_counts(client, headers)[0] == 2


def test_same_choice_double_tap_records_one_click(setup):
    client, headers, _ws, room, a, b = room_with_posts(setup)
    for _ in range(3):
        r = vote(client, room["code"], "b")
        assert r.json()["votes"] == {"a": 0, "b": 1}
    assert post_counts(b["id"])[0] == 1 and post_counts(a["id"])[0] == 0
    assert real_counts(client, headers)[0] == 1


def test_two_voters_on_different_choices(setup):
    client, headers, _ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]
    assert vote(client, code, "a").json()["votes"] == {"a": 1, "b": 0}
    first = client.cookies["pv"]
    new_voter(client)

    r = vote(client, code, "b")

    assert r.json()["votes"] == {"a": 1, "b": 1}
    assert client.cookies["pv"] != first
    assert query("SELECT COUNT(*) AS n FROM room_votes WHERE room_id = ?", (room["id"],))[0]["n"] == 2
    assert real_counts(client, headers)[0] == 2


def test_vote_errors(setup):
    client, headers, _ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]
    assert vote(client, code, "c").status_code == 422
    assert client.post(f"/api/rooms/{code}/vote", json={}).status_code == 422
    assert client.post(f"/api/rooms/{code}/vote").status_code == 422
    assert vote(client, "NOPE22", "a").json() == {"detail": "room not found"}
    assert query("SELECT COUNT(*) AS n FROM room_votes")[0]["n"] == 0

    assert vote(client, code, "a").status_code == 200
    assert client.post(f"/api/rooms/{code}/close", headers=headers).status_code == 200
    closed = vote(client, code, "b")
    assert (closed.status_code, closed.json()) == (409, {"detail": "voting is closed"})
    assert vote(client, code, "a").status_code == 409  # even a repeat of the same choice
    assert client.get(f"/api/rooms/{code}/stats").json()["votes"] == {"a": 1, "b": 0}


# ---------------------------------------------------------------- onboard


def test_onboard_needs_a_vote_and_is_idempotent(setup):
    client, headers, _ws, room, a, b = room_with_posts(setup)
    code = room["code"]
    no_cookie = client.post(f"/api/rooms/{code}/onboard")
    assert (no_cookie.status_code, no_cookie.json()) == (400, {"detail": "vote first"})
    client.cookies.set("pv", "scanned-only-0001")  # a cookie, but no vote
    assert client.post(f"/api/rooms/{code}/onboard").status_code == 400
    assert client.post("/api/rooms/NOPE22/onboard").status_code == 404
    new_voter(client)

    vote(client, code, "b")
    conversions = real_counts(client, headers)[1]
    first = client.post(f"/api/rooms/{code}/onboard")
    second = client.post(f"/api/rooms/{code}/onboard")

    assert first.json() == second.json() == {"ok": True, "onboarded": True}
    assert real_counts(client, headers)[1] == conversions + 1
    assert post_counts(b["id"])[1] == 1 and post_counts(a["id"])[1] == 0
    assert client.get(f"/api/rooms/{code}/stats").json()["onboarded"] == 1
    assert vote(client, code, "a").status_code == 200  # a later switch does not re-onboard
    assert client.post(f"/api/rooms/{code}/onboard").status_code == 200
    assert real_counts(client, headers)[1] == conversions + 1


def test_onboard_is_allowed_after_the_room_closes(setup):
    client, headers, _ws, room, a, _b = room_with_posts(setup)
    code = room["code"]
    vote(client, code, "a")
    assert client.post(f"/api/rooms/{code}/close", headers=headers).status_code == 200

    r = client.post(f"/api/rooms/{code}/onboard")

    assert r.status_code == 200 and r.json() == {"ok": True, "onboarded": True}
    assert post_counts(a["id"])[1] == 1


# ---------------------------------------------------------------- stats


def test_stats_shape_and_values(setup):
    client, _headers, _ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]
    empty = client.get(f"/api/rooms/{code}/stats").json()
    assert empty == {
        "status": "open", "scans": 0, "votes": {"a": 0, "b": 0}, "onboarded": 0,
        "funnel": {"views": 0, "engage": 0, "click": 0, "onboard": 0},
        "winner": {"choice": None, "theme": None, "share": 0}, "recent": [],
    }

    add_votes(room["id"], [("scan-only-0001", "", now_iso()), ("scan-only-0002", "", now_iso())])
    for choice in ("a", "a", "b"):
        vote(client, code, choice)
        if choice == "b":
            assert client.post(f"/api/rooms/{code}/onboard").status_code == 200
        new_voter(client)
    stats = client.get(f"/api/rooms/{code}/stats").json()

    assert stats["status"] == "open" and stats["scans"] == 5
    assert stats["votes"] == {"a": 2, "b": 1} and stats["onboarded"] == 1
    assert stats["funnel"] == {"views": 5, "engage": 3, "click": 3, "onboard": 1}
    assert stats["winner"]["choice"] == "a" and stats["winner"]["theme"] == "Behind the beans"
    assert stats["winner"]["share"] == pytest.approx(2 / 3)
    assert [x["choice"] for x in stats["recent"]] == ["b", "a", "a"]  # newest first, scans left out
    assert all(isinstance(x["ago"], int) and x["ago"] >= 0 and x["at"] for x in stats["recent"])
    assert client.get("/api/rooms/NOPE22/stats").status_code == 404


def test_stats_recent_is_limited_to_eight_newest_first(setup):
    client, _headers, _ws, room, _a, _b = room_with_posts(setup)
    start = datetime.now(UTC).replace(microsecond=0) - timedelta(seconds=60)
    add_votes(room["id"], [
        (f"voter-{i:04d}-abc", "ab"[i % 2], (start + timedelta(seconds=i)).isoformat(timespec="seconds"))
        for i in range(12)
    ])
    add_votes(room["id"], [("same-second-0001", "a", start.isoformat(timespec="seconds"))])  # oldest time

    stats = client.get(f"/api/rooms/{room['code']}/stats").json()

    assert len(stats["recent"]) == 8
    assert [x["at"] for x in stats["recent"]] == [
        (start + timedelta(seconds=i)).isoformat(timespec="seconds") for i in range(11, 3, -1)
    ]
    assert 47 <= stats["recent"][0]["ago"] <= 60 and 53 <= stats["recent"][-1]["ago"] <= 62
    assert stats["scans"] == 13 and stats["votes"] == {"a": 7, "b": 6}


def test_stats_recent_breaks_ties_by_newest_row(setup):
    client, _headers, _ws, room, _a, _b = room_with_posts(setup)
    same = now_iso()
    add_votes(room["id"], [("tie-voter-0001", "a", same), ("tie-voter-0002", "b", same), ("tie-voter-0003", "a", same)])
    stats = client.get(f"/api/rooms/{room['code']}/stats").json()
    assert [x["choice"] for x in stats["recent"]] == ["a", "b", "a"]  # rowid descending
    execute("DELETE FROM room_votes WHERE voter = 'tie-voter-0003'")
    assert [x["choice"] for x in client.get(f"/api/rooms/{room['code']}/stats").json()["recent"]] == ["b", "a"]


def test_stats_winner_for_a_tie_and_for_a_theme_less_leader(setup):
    client, headers, _ws, themes = setup
    a = make_post(client, headers, None, "No theme.")
    b = make_post(client, headers, themes["Customer stories"], "Themed.")
    room = new_room(client, headers, post_a=a["id"], post_b=b["id"])
    code = room["code"]

    vote(client, code, "a")
    new_voter(client)
    vote(client, code, "b")
    tie = client.get(f"/api/rooms/{code}/stats").json()["winner"]
    assert tie == {"choice": None, "theme": None, "share": 0.5}

    new_voter(client)
    vote(client, code, "a")
    leader = client.get(f"/api/rooms/{code}/stats").json()["winner"]
    assert leader["choice"] == "a" and leader["theme"] is None and leader["share"] == pytest.approx(2 / 3)


def test_stats_cache_serves_the_same_result_until_close(setup, monkeypatch):
    monkeypatch.setattr(rooms, "STATS_TTL", 5)
    client, headers, _ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]
    first = client.get(f"/api/rooms/{code}/stats").json()
    assert first["votes"] == {"a": 0, "b": 0}

    r = vote(client, code, "a")
    assert r.json()["votes"] == {"a": 1, "b": 0}  # the vote response itself is always fresh
    cached = client.get(f"/api/rooms/{code}/stats").json()
    assert cached == first  # still the cached copy

    closed = client.post(f"/api/rooms/{code}/close", headers=headers).json()
    assert closed["status"] == "closed" and closed["votes"] == {"a": 1, "b": 0}
    assert client.get(f"/api/rooms/{code}/stats").json() == closed
    assert client.get(f"/api/rooms/{code}/stats").json()["status"] == "closed"


def test_stats_cache_returns_copies_and_expires(setup, monkeypatch):
    monkeypatch.setattr(rooms, "STATS_TTL", 5)
    _client, _headers, _ws, room, _a, _b = room_with_posts(setup)
    conn = connect()
    try:
        one = rooms.stats_for_code(conn, room["code"])
        one["votes"]["a"] = 99
        one["recent"].append("junk")
        two = rooms.stats_for_code(conn, room["code"])
        assert two["votes"] == {"a": 0, "b": 0} and two["recent"] == []
        monkeypatch.setattr(rooms, "STATS_TTL", 0)  # expired: recomputed from the database
        add_votes(room["id"], [("late-voter-0001", "b", now_iso())])
        assert rooms.stats_for_code(conn, room["code"])["votes"] == {"a": 0, "b": 1}
    finally:
        conn.close()


# ---------------------------------------------------------------- close


def test_close_needs_the_owners_token(setup):
    client, headers, _ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]
    other = client.post("/api/workspaces", json={}).json()
    other_headers = {"Authorization": f"Bearer {other['token']}"}

    assert client.post(f"/api/rooms/{code}/close").status_code == 401
    assert client.post(f"/api/rooms/{code}/close", headers={"Authorization": "Bearer nope"}).status_code == 401
    r = client.post(f"/api/rooms/{code}/close", headers=other_headers)
    assert (r.status_code, r.json()) == (404, {"detail": "room not found"})
    assert client.post("/api/rooms/NOPE22/close", headers=headers).status_code == 404
    assert client.get(f"/api/rooms/{code}").json()["status"] == "open"

    ok = client.post(f"/api/rooms/{code.lower()}/close", headers=headers)
    assert ok.status_code == 200 and ok.json()["status"] == "closed"
    assert client.get(f"/api/rooms/{code}").json()["status"] == "closed"


def test_close_records_the_winning_theme_and_an_insight(setup):
    client, headers, ws, room, a, b = room_with_posts(setup)
    code = room["code"]
    assert query("SELECT * FROM insights WHERE workspace_id = ?", (ws["id"],)) == []
    for choice in ("b", "b", "a"):
        vote(client, code, choice)
        new_voter(client)

    stats = client.post(f"/api/rooms/{code}/close", headers=headers).json()

    assert stats["status"] == "closed" and stats["winner"]["choice"] == "b"
    links = query("SELECT * FROM post_themes WHERE post_id IN (?, ?)", (a["id"], b["id"]))
    assert len(links) == 1
    link = links[0]
    assert (link["post_id"], link["theme_id"], link["classifier"]) == (b["id"], b["theme_id"], "room")
    assert link["confidence"] == pytest.approx(stats["winner"]["share"]) == pytest.approx(2 / 3)
    insight = query("SELECT * FROM insights WHERE workspace_id = ?", (ws["id"],))
    assert len(insight) == 1
    assert insight[0]["body"] == (
        'Room vote (3 votes): the crowd preferred "Plant care tips" (67%) over "Behind the beans".'
    )


def test_close_is_idempotent_and_writes_only_once(setup):
    client, headers, ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]
    vote(client, code, "a")
    first = client.post(f"/api/rooms/{code}/close", headers=headers)
    assert first.status_code == 200
    execute("DELETE FROM post_themes WHERE classifier = 'room'")
    execute("UPDATE insights SET body = 'edited' WHERE workspace_id = ?", (ws["id"],))

    second = client.post(f"/api/rooms/{code}/close", headers=headers)

    assert second.status_code == 200 and second.json() == first.json()
    assert query("SELECT * FROM post_themes WHERE classifier = 'room'") == []  # not written again
    assert query("SELECT body FROM insights WHERE workspace_id = ?", (ws["id"],))[0]["body"] == "edited"


def test_close_keeps_an_existing_insight_and_upserts_the_post_theme(setup):
    client, headers, ws, room, a, _b = room_with_posts(setup)
    code = room["code"]
    execute("INSERT INTO insights (workspace_id, body, created_at) VALUES (?, 'keep me', ?)", (ws["id"], now_iso()))
    execute(
        "INSERT INTO post_themes (post_id, theme_id, confidence, classifier, created_at) VALUES (?,?,1.0,'ai',?)",
        (a["id"], a["theme_id"], now_iso()),
    )
    for choice in ("a", "a", "a", "b"):
        vote(client, code, choice)
        new_voter(client)

    client.post(f"/api/rooms/{code}/close", headers=headers)

    assert query("SELECT body FROM insights WHERE workspace_id = ?", (ws["id"],))[0]["body"] == "keep me"
    link = query("SELECT * FROM post_themes WHERE post_id = ?", (a["id"],))
    assert len(link) == 1 and link[0]["classifier"] == "room" and link[0]["confidence"] == pytest.approx(0.75)


@pytest.mark.parametrize("votes", [[], ["a", "b"]], ids=["no-votes", "tie"])
def test_close_without_a_winner_writes_nothing(setup, votes):
    client, headers, _ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]
    for choice in votes:
        vote(client, code, choice)
        new_voter(client)

    stats = client.post(f"/api/rooms/{code}/close", headers=headers).json()

    assert stats["status"] == "closed" and stats["winner"]["choice"] is None
    assert query("SELECT * FROM post_themes") == [] and query("SELECT * FROM insights") == []


def test_close_skips_a_winner_without_a_theme(setup):
    client, headers, _ws, themes = setup
    a = make_post(client, headers, None, "No theme.")
    b = make_post(client, headers, themes["Customer stories"], "Themed.")
    room = new_room(client, headers, post_a=a["id"], post_b=b["id"])
    vote(client, room["code"], "a")

    stats = client.post(f"/api/rooms/{room['code']}/close", headers=headers).json()

    assert stats["status"] == "closed" and stats["winner"] == {"choice": "a", "theme": None, "share": 1.0}
    assert query("SELECT * FROM post_themes") == [] and query("SELECT * FROM insights") == []


# ---------------------------------------------------------------- pages


def scans(room_id: str) -> int:
    return query("SELECT COUNT(*) AS n FROM room_votes WHERE room_id = ?", (room_id,))[0]["n"]


def test_phone_page_renders_and_counts_one_scan_per_cookie(setup):
    client, _headers, _ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]

    first = client.get(f"/v/{code}")

    assert first.status_code == 200 and first.headers["content-type"].startswith("text/html")
    assert first.headers["cache-control"] == "no-store"
    assert code in first.text and "Post A about beans." in first.text and "Post B about plants." in first.text
    assert re.fullmatch(r"[A-Za-z0-9_-]{16}", client.cookies["pv"])
    assert "HttpOnly" in first.headers["set-cookie"] and "SameSite=lax" in first.headers["set-cookie"]
    assert len(first.content) < 40_000
    assert scans(room["id"]) == 1

    again = client.get(f"/v/{code.lower()}")  # same cookie, other letter case
    assert again.status_code == 200 and "set-cookie" not in again.headers
    assert scans(room["id"]) == 1

    new_voter(client)
    assert client.get(f"/v/{code}").status_code == 200
    assert scans(room["id"]) == 2
    stats = client.get(f"/api/rooms/{code}/stats").json()
    assert stats["scans"] == 2 and stats["votes"] == {"a": 0, "b": 0}
    rows = query("SELECT choice, onboarded FROM room_votes WHERE room_id = ?", (room["id"],))
    assert {(r["choice"], r["onboarded"]) for r in rows} == {("", 0)}


def test_phone_page_shows_this_voters_state(setup):
    client, headers, _ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]
    fresh = client.get(f"/v/{code}").text
    assert 'data-voted=""' in fresh and 'data-onb="0"' in fresh and 'data-closed="0"' in fresh

    vote(client, code, "b")
    voted = client.get(f"/v/{code}").text
    assert 'data-voted="b"' in voted and 'data-onb="0"' in voted
    assert scans(room["id"]) == 1  # the scan row and the vote are the same voter row

    assert client.post(f"/api/rooms/{code}/onboard").status_code == 200
    assert 'data-voted="b"' in client.get(f"/v/{code}").text
    assert 'data-onb="1"' in client.get(f"/v/{code}").text

    assert client.post(f"/api/rooms/{code}/close", headers=headers).status_code == 200
    closed = client.get(f"/v/{code}")
    assert closed.status_code == 200 and closed.headers["cache-control"] == "no-store"
    assert 'data-closed="1"' in closed.text and 'data-voted="b"' in closed.text

    new_voter(client)
    assert 'data-voted=""' in client.get(f"/v/{code}").text  # another phone sees no vote of its own


def test_screen_page_shows_the_qr_and_close_control_only_with_the_owners_token(setup):
    client, _headers, ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]
    before = scans(room["id"])

    anon = client.get(f"/room/{code}")
    wrong = client.get(f"/room/{code}?token=not-the-token")
    other = client.post("/api/workspaces", json={}).json()
    foreign = client.get(f"/room/{code}?token={other['token']}")
    owner = client.get(f"/room/{code}", params={"token": ws["token"]})

    for page in (anon, wrong, foreign, owner):
        assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
        assert "<svg" in page.text and code in page.text and len(page.content) < 40_000
        assert page.headers["cache-control"] == "no-store"
    assert "localhost:8000/v/" + code in anon.text
    for page in (anon, wrong, foreign):  # the script always knows the confirm text; the button is the control
        assert ">Close voting</button>" not in page.text and 'id="close"' not in page.text
        assert ws["token"] not in page.text and other["token"] not in page.text
    assert ">Close voting</button>" in owner.text and 'id="close"' in owner.text
    assert owner.headers["referrer-policy"] == "no-referrer"
    assert scans(room["id"]) == before and "pv" not in client.cookies  # the big screen is not a scan
    assert client.get(f"/room/{code.lower()}").status_code == 200


def test_unknown_room_pages_are_404(setup):
    client, _headers, _ws, _room, _a, _b = room_with_posts(setup)
    for path in ("/v/ZZZZZZ", "/room/ZZZZZZ", "/room/ZZZZZZ?token=x"):
        r = client.get(path)
        assert r.status_code == 404 and r.headers["content-type"].startswith("text/html")
        assert "ZZZZZZ" in r.text
    evil = client.get("/v/%3Cscript%3Ealert(1)%3C%2Fscript%3E")
    assert evil.status_code == 404 and "<script>alert(1)</script>" not in evil.text
    assert query("SELECT COUNT(*) AS n FROM room_votes")[0]["n"] == 0


def test_form_fallback_vote_and_onboard(setup):
    client, headers, _ws, room, _a, b = room_with_posts(setup)
    code = room["code"]

    r = client.post(f"/v/{code}/vote", content="choice=b", headers={"Content-Type": "application/x-www-form-urlencoded"},
                    follow_redirects=False)

    assert r.status_code == 303 and r.headers["location"] == f"/v/{code}"
    assert re.fullmatch(r"[A-Za-z0-9_-]{16}", client.cookies["pv"])  # the cookie rides on the redirect
    stats = client.get(f"/api/rooms/{code}/stats").json()
    assert stats["votes"] == {"a": 0, "b": 1}
    assert post_counts(b["id"])[0] == 1 and real_counts(client, headers)[0] == 1

    form = {"Content-Type": "application/x-www-form-urlencoded"}
    done = client.post(f"/v/{code}/onboard", content="", headers=form, follow_redirects=False)
    assert done.status_code == 303 and done.headers["location"] == f"/v/{code}"
    client.post(f"/v/{code}/onboard", content="", headers=form, follow_redirects=False)
    assert client.get(f"/api/rooms/{code}/stats").json()["onboarded"] == 1
    assert post_counts(b["id"])[1] == 1 and real_counts(client, headers)[1] == 1
    assert client.get(f"/v/{code}", follow_redirects=False).status_code == 200  # the page follows the cookie


def test_form_fallback_ignores_bad_input_and_closed_rooms(setup):
    client, headers, _ws, room, _a, _b = room_with_posts(setup)
    code = room["code"]
    form = {"Content-Type": "application/x-www-form-urlencoded"}

    for body in ("choice=c", "", "other=a", "choice="):
        r = client.post(f"/v/{code}/vote", content=body, headers=form, follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == f"/v/{code}"
    assert client.get(f"/api/rooms/{code}/stats").json()["votes"] == {"a": 0, "b": 0}
    no_vote = client.post(f"/v/{code}/onboard", content="", headers=form, follow_redirects=False)
    assert no_vote.status_code == 303 and client.get(f"/api/rooms/{code}/stats").json()["onboarded"] == 0

    new_voter(client)
    client.post(f"/v/{code}/vote", content="choice=a", headers=form)
    client.post(f"/api/rooms/{code}/close", headers=headers)
    late = client.post(f"/v/{code}/vote", content="choice=b", headers=form, follow_redirects=False)
    assert late.status_code == 303
    assert client.get(f"/api/rooms/{code}/stats").json()["votes"] == {"a": 1, "b": 0}

    missing = client.post("/v/ZZZZZZ/vote", content="choice=a", headers=form, follow_redirects=False)
    assert missing.status_code == 303 and missing.headers["location"] == "/v/ZZZZZZ"
    assert client.get("/v/ZZZZZZ").status_code == 404
