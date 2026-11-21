import re
from urllib.parse import parse_qs, urlsplit

from app.config import settings

LINKEDIN = "https://www.linkedin.com/feed/?shareActive=true&text="
X = "https://x.com/intent/post?text="
THREADS = "https://www.threads.net/intent/post?text="
REDDIT = "https://www.reddit.com/submit?title="
FACEBOOK = "https://www.facebook.com/sharer/sharer.php?u="
NOTE = "copy the caption, then post the image in the app"
KEYS = {"linkedin", "x", "threads", "reddit", "facebook", "instagram", "instagram_note", "text", "link_url"}
NETWORKS = ("linkedin", "x", "threads", "reddit", "facebook")


def _param(url: str, key: str) -> str:
    return parse_qs(urlsplit(url).query, keep_blank_values=True)[key][0]


def _make(client, h, content, *, platform="linkedin", hashtags=None, status="draft"):
    body = {"platform": platform, "content": content, "status": status}
    if hashtags is not None:
        body["hashtags"] = hashtags
    r = client.post("/api/posts", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def _share(client, h, post_id):
    r = client.get(f"/api/posts/{post_id}/share", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def _texts(share):
    """The decoded text each network would receive."""
    return {
        "linkedin": _param(share["linkedin"], "text"),
        "x": _param(share["x"], "text"),
        "threads": _param(share["threads"], "text"),
        "reddit_title": _param(share["reddit"], "title"),
        "reddit_text": _param(share["reddit"], "text"),
        "facebook": _param(share["facebook"], "u"),
    }


def test_share_requires_token(auth):
    client, h, _ = auth
    post = client.get("/api/posts", headers=h).json()[0]
    url = f"/api/posts/{post['id']}/share"
    assert client.get(url).status_code == 401
    assert client.get(url, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/posts/does-not-exist/share").status_code == 401


def test_share_unknown_post_404(auth):
    client, h, _ = auth
    r = client.get("/api/posts/p_missing/share", headers=h)
    assert r.status_code == 404
    assert r.json() == {"detail": "post not found"}


def test_share_post_of_another_workspace_404(auth):
    client, h, _ = auth
    other = client.post("/api/workspaces", json={}).json()
    h2 = {"Authorization": f"Bearer {other['token']}"}
    theirs = client.get("/api/posts", headers=h2).json()[0]
    mine = client.get("/api/posts", headers=h).json()[0]
    r = client.get(f"/api/posts/{theirs['id']}/share", headers=h)
    assert r.status_code == 404 and r.json() == {"detail": "post not found"}
    assert client.get(f"/api/posts/{mine['id']}/share", headers=h2).status_code == 404
    assert client.get(f"/api/posts/{theirs['id']}/share", headers=h2).status_code == 200


def test_share_shape_and_url_prefixes(auth):
    client, h, _ = auth
    post = next(iter(client.get("/api/posts?status=published", headers=h).json()))
    share = _share(client, h, post["id"])
    assert set(share) == KEYS
    assert share["linkedin"].startswith(LINKEDIN)
    assert share["x"].startswith(X)
    assert share["threads"].startswith(THREADS)
    assert share["reddit"].startswith(REDDIT) and "&text=" in share["reddit"]
    assert share["facebook"].startswith(FACEBOOK)
    assert share["instagram"] is None
    assert share["instagram_note"] == NOTE
    assert share["link_url"] == post["link_url"]
    assert share["link_url"].endswith("/r/" + post["link_code"])


def test_tracked_link_in_every_text(auth):
    client, h, _ = auth
    post = next(iter(client.get("/api/posts?status=published", headers=h).json()))
    share = _share(client, h, post["id"])
    link = post["link_url"]
    t = _texts(share)
    assert link in share["text"]
    for key in ("linkedin", "x", "threads", "reddit_text"):
        assert t[key].count(link) == 1, key
    assert t["facebook"] == link
    assert post["content"] in t["linkedin"]
    assert t["linkedin"] == share["text"]


def test_tricky_content_round_trips(auth):
    client, h, _ = auth
    content = (
        'Fish & chips #1? 100% C++ is a+b=c; 50% off = "great" & it\'s <b>bold</b>\n'
        "Line two: “quoted” café ☕\U0001f680 日本語\n\n"
        "Last para: https://example.com/a?b=c&d=e#frag"
    )
    post = _make(client, h, content)
    share = _share(client, h, post["id"])
    link = post["link_url"]
    t = _texts(share)

    assert t["linkedin"] == f"{content}\n\n{link}" == share["text"]
    assert t["threads"] == t["linkedin"]
    assert t["x"] == " ".join(content.split()) + " " + link
    first, rest = content.split("\n", 1)
    assert t["reddit_title"] == first
    assert t["reddit_text"] == f"{rest.strip()}\n\n{link}"
    assert t["facebook"] == link

    # nothing from the content leaks out unencoded: the only `&` is the one between the parameters
    assert share["linkedin"].count("&") == 1 and share["reddit"].count("&") == 1
    for net in ("x", "threads", "facebook"):
        assert "&" not in share[net]
    for net in NETWORKS:
        query = share[net].split("?", 1)[1]
        assert "#" not in query and "?" not in query and " " not in query and "\n" not in query


def test_raw_urls_are_fully_encoded_for_every_seeded_post(auth):
    client, h, _ = auth
    posts = client.get("/api/posts?limit=200", headers=h).json()
    assert len(posts) >= 10
    seen_statuses = set()
    for post in posts:
        seen_statuses.add(post["status"])
        share = _share(client, h, post["id"])
        for net in NETWORKS:
            url = share[net]
            assert re.fullmatch(r"[A-Za-z0-9\-._~%:/?=&]+", url), (net, url)
        assert post["link_url"] in share["text"]
        assert _texts(share)["facebook"] == post["link_url"]
    assert {"published", "draft"} <= seen_statuses  # any status works


def test_x_text_is_clipped_to_280_and_keeps_the_link(auth):
    client, h, _ = auth
    content = " ".join(f"word{i:03d}" for i in range(200))
    assert len(content) > 1500
    post = _make(client, h, content)
    share = _share(client, h, post["id"])
    link = post["link_url"]
    x = _texts(share)["x"]
    assert len(x) <= 280
    assert x.endswith(" " + link) and x.count(link) == 1
    body = x[: -len(link) - 1]
    assert body.endswith("…")
    stem = body[:-1]
    assert content.startswith(stem) and content[len(stem)] == " "  # cut at a word boundary
    assert len(x) >= 265  # it uses the room it has
    # the full caption (LinkedIn / copy button) is untouched
    assert share["text"] == f"{content}\n\n{link}"
    assert _texts(share)["linkedin"] == share["text"]


def test_x_short_content_unchanged_apart_from_link(auth):
    client, h, _ = auth
    post = _make(client, h, "Short & sweet.  Two   spaces\nand a newline.")
    link = post["link_url"]
    x = _texts(_share(client, h, post["id"]))["x"]
    assert x == f"Short & sweet. Two spaces and a newline. {link}"
    exact = _make(client, h, "x" * (280 - 1 - len(link)))
    x = _texts(_share(client, h, exact["id"]))["x"]
    assert len(x) == 280 and x.endswith(exact["link_url"]) and "…" not in x


def test_x_hashtags_are_added_only_while_they_fit(auth):
    client, h, _ = auth
    probe = _make(client, h, "probe")
    link = probe["link_url"]  # same length for every post
    body = "x" * (280 - 1 - len(link) - 15)  # leaves 15 characters for hashtags
    post = _make(client, h, body, hashtags=["alpha", "beta", "gamma", "z" * 60, "delta"])
    x = _texts(_share(client, h, post["id"]))["x"]
    assert x == f"{body} #alpha #beta {post['link_url']}"
    assert len(x) <= 280
    # no room at all: the body is clipped and no hashtag is added
    long = _make(client, h, " ".join(["lorem"] * 80), hashtags=["alpha"])
    x = _texts(_share(client, h, long["id"]))["x"]
    assert len(x) <= 280 and "#alpha" not in x and x.endswith(long["link_url"])


def test_threads_text_is_clipped_to_500_and_keeps_the_link(auth):
    client, h, _ = auth
    content = " ".join(f"word{i:03d}" for i in range(200))
    post = _make(client, h, content, hashtags=["alpha", "beta"])
    link = post["link_url"]
    share = _share(client, h, post["id"])
    threads = _texts(share)["threads"]
    assert len(threads) <= 500
    assert threads.endswith("\n\n" + link) and threads.count(link) == 1
    body = threads[: -len(link) - 2]
    assert body.endswith("…") and content.startswith(body[:-1])
    assert "#alpha" not in threads  # no room left for hashtags
    assert len(threads) >= 480
    # content that fits is the LinkedIn caption, hashtags included
    short = _make(client, h, "Fits easily.\nSecond line.", hashtags=["alpha", "beta"])
    s = _share(client, h, short["id"])
    expected = f"Fits easily.\nSecond line.\n\n#alpha #beta\n\n{short['link_url']}"
    assert _texts(s)["threads"] == s["text"] == expected
    # medium content: body fits but not all hashtags
    probe_len = len(short["link_url"]) + 2
    medium = _make(client, h, "m" * (500 - probe_len - 12), hashtags=["alpha", "beta", "gamma"])
    t = _texts(_share(client, h, medium["id"]))["threads"]
    assert len(t) <= 500 and t.endswith(medium["link_url"])
    assert "#alpha" in t and "#gamma" not in t


def test_reddit_title_and_text_split(auth):
    client, h, _ = auth
    post = _make(client, h, "Launch day thoughts\n\nWe shipped it.\nMore soon.\n", hashtags=["launch"])
    link = post["link_url"]
    t = _texts(_share(client, h, post["id"]))
    assert t["reddit_title"] == "Launch day thoughts"
    assert t["reddit_text"] == f"We shipped it.\nMore soon.\n\n{link}"
    assert "#launch" not in t["reddit_text"] and "#launch" not in t["facebook"]  # none on reddit/facebook

    one_liner = _make(client, h, "Only one line here")
    t = _texts(_share(client, h, one_liner["id"]))
    assert t["reddit_title"] == "Only one line here" and t["reddit_text"] == one_liner["link_url"]

    leading_blank = _make(client, h, "\n\n  \nFirst real line\nSecond")
    t = _texts(_share(client, h, leading_blank["id"]))
    assert t["reddit_title"] == "First real line"
    assert t["reddit_text"] == f"Second\n\n{leading_blank['link_url']}"


def test_reddit_title_is_clipped_to_300_at_a_word_boundary(auth):
    client, h, _ = auth
    first = " ".join(f"word{i:03d}" for i in range(60))  # 479 chars
    post = _make(client, h, f"{first}\nsecond line")
    t = _texts(_share(client, h, post["id"]))
    assert len(t["reddit_title"]) <= 300 and t["reddit_title"].endswith("…")
    stem = t["reddit_title"][:-1]
    assert first.startswith(stem) and first[len(stem)] == " "
    assert t["reddit_text"].startswith(first)  # the clipped tail is not lost
    assert t["reddit_text"].endswith(f"second line\n\n{post['link_url']}")


def test_hashtags_are_normalised(auth):
    client, h, _ = auth
    tags = ["coffee", "#Coffee", "", "#", "  ", "#tea", "brew", "#brew", "my tag"]
    post = _make(client, h, "Morning #tea time", hashtags=tags)
    link = post["link_url"]
    share = _share(client, h, post["id"])
    t = _texts(share)
    # leading #, no empties, no duplicates (any case), none already in the content
    assert t["linkedin"] == f"Morning #tea time\n\n#coffee #brew #mytag\n\n{link}"
    assert t["x"] == f"Morning #tea time #coffee #brew #mytag {link}"
    assert share["text"] == t["linkedin"]
    assert "#coffee" not in t["reddit_text"] and "#coffee" not in t["reddit_title"]
    assert t["facebook"] == link


def test_content_with_its_own_link_is_not_duplicated(auth):
    client, h, _ = auth
    post = _make(client, h, "placeholder")
    link = post["link_url"]
    content = f"Read more: {link} today"
    r = client.patch(f"/api/posts/{post['id']}", json={"content": content, "hashtags": ["promo"]}, headers=h)
    assert r.status_code == 200
    share = _share(client, h, post["id"])
    t = _texts(share)
    assert share["text"] == t["linkedin"] == f"{content}\n\n#promo"
    for key in ("linkedin", "x", "threads", "reddit_text"):
        assert t[key].count(link) == 1, key
    assert share["text"].count(link) == 1
    assert t["x"] == f"Read more: today #promo {link}"
    assert t["reddit_title"] == "Read more: today" and t["reddit_text"] == link
    assert t["facebook"] == link


def test_post_without_a_link_code_omits_the_link(auth):
    from app.db import connect

    client, h, _ = auth
    post = _make(client, h, "No link here\nsecond line", hashtags=["solo"])
    conn = connect()
    conn.execute("UPDATE posts SET link_code = NULL WHERE id = ?", (post["id"],))
    conn.commit()
    conn.close()
    share = _share(client, h, post["id"])
    t = _texts(share)
    assert share["link_url"] is None
    assert share["text"] == t["linkedin"] == "No link here\nsecond line\n\n#solo"
    assert t["x"] == "No link here second line #solo"
    assert t["reddit_title"] == "No link here" and t["reddit_text"] == "second line"
    assert t["facebook"] == settings.public_base_url  # falls back to the public base URL


def test_share_is_read_only_and_works_for_any_status(auth):
    from app.db import connect

    client, h, _ = auth
    scheduled = _make(client, h, "Later", status="scheduled")
    draft = _make(client, h, "Not yet")
    published = client.post(f"/api/posts/{draft['id']}/publish", headers=h).json()
    assert published["status"] == "published"

    def snapshot():
        conn = connect()
        try:
            return (
                [tuple(r) for r in conn.execute("SELECT * FROM posts ORDER BY id")],
                conn.execute("SELECT COUNT(*) FROM events").fetchone()[0],
                [tuple(r) for r in conn.execute("SELECT * FROM daily_metrics ORDER BY 1, 2, 3")],
            )
        finally:
            conn.close()

    before = snapshot()
    for pid, status in ((scheduled["id"], "scheduled"), (draft["id"], "published")):
        share = _share(client, h, pid)
        assert share["link_url"] and share["instagram"] is None, status
    assert snapshot() == before


def test_instagram_caption_keeps_at_most_five_hashtags():
    """Instagram keeps 5 hashtags and strips the '#' from the rest (phone, 2026-11-21), so a post saved with 12
    copies only the first 5."""
    import json as _json

    from app.routes.share import build_share_links

    tags = [f"#tag{i}" for i in range(12)]
    row = {"content": "Fresh beans.", "hashtags": _json.dumps(tags), "link_code": None, "platform": "instagram"}
    text = build_share_links(row)["text"]
    assert text.count("#") == 5
    assert "#tag4" in text and "#tag5" not in text
    row["platform"] = "linkedin"
    assert build_share_links(row)["text"].count("#") == 12
