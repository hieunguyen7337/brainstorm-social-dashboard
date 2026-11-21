import json
import pathlib
import sqlite3

import httpx
import pytest

from app.config import settings
from app.db import connect, init_db, new_id, now_iso
from app.services import trends as svc

FIX = pathlib.Path(__file__).parent / "fixtures"


def _handler(calls, fail=()):
    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        calls.append(host)
        if host in fail:
            return httpx.Response(403)
        if host == "hn.algolia.com":
            return httpx.Response(200, content=(FIX / "hn.json").read_bytes())
        if host == "www.reddit.com":
            return httpx.Response(200, content=(FIX / "reddit.json").read_bytes())
        return httpx.Response(200, text=(FIX / "google.xml").read_text())

    return handler


@pytest.fixture()
def feeds(monkeypatch):
    calls: list[str] = []
    cfg = {"fail": ()}
    real = httpx.AsyncClient

    def factory(*a, **kw):
        kw["transport"] = httpx.MockTransport(lambda r: _handler(calls, cfg["fail"])(r))
        return real(*a, **kw)

    monkeypatch.setattr(svc.httpx, "AsyncClient", factory)
    return calls, cfg


@pytest.fixture()
def tclient(client):
    c = client
    conn = connect()
    init_db(conn)
    wid = new_id("ws_")
    conn.execute(
        "INSERT INTO workspaces (id, token, name, brand_name, brand_voice, audience, offer, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (wid, "tok123", "Demo", "Brew & Bloom", "warm, friendly", "coffee lovers and plant parents",
         "coffee and plants", now_iso()),
    )
    conn.execute(
        "INSERT INTO themes (id, workspace_id, name, description, created_at) VALUES (?,?,?,?,?)",
        (new_id(), wid, "Plant care", "houseplants tips", now_iso()),
    )
    conn.commit()
    conn.close()
    return c, {"Authorization": "Bearer tok123"}


def test_parsers():
    hn = svc.parse_hn(json.loads((FIX / "hn.json").read_text()))
    assert len(hn) == 3 and all(0 <= i["score"] <= 1 for i in hn)
    assert hn[1]["url"].startswith("https://news.ycombinator.com/item")
    rd = svc.parse_reddit(json.loads((FIX / "reddit.json").read_text()))
    assert len(rd) == 2 and rd[0]["url"].startswith("https://www.reddit.com/r/")
    gg = svc.parse_google((FIX / "google.xml").read_text())
    assert len(gg) == 3 and "2,000,000+" in gg[1]["title"] and gg[1]["score"] == 1.0
    assert svc.trend_id("reddit", "x") == svc.trend_id("reddit", "x") and len(svc.trend_id("a", "b")) == 16


def test_requires_auth(client):
    assert client.get("/api/trends").status_code == 401


def test_fetch_rank_and_cache(tclient, feeds):
    calls, _ = feeds
    c, h = tclient
    r = c.get("/api/trends?limit=20", headers=h)
    assert r.status_code == 200
    data = r.json()
    assert {t["source"] for t in data} == {"hackernews", "reddit", "google"}
    assert len(calls) == 3
    titles = [t["title"] for t in data]
    assert titles.index("Cold brew coffee hits record sales this summer") < titles.index(
        "My cat learned to open doors"
    )
    assert data[0]["relevance"] > 0
    c.get("/api/trends", headers=h)
    assert len(calls) == 3  # cached
    c.get("/api/trends?refresh=true", headers=h)
    assert len(calls) == 6


def test_ttl_expiry(tclient, feeds, monkeypatch):
    calls, _ = feeds
    c, h = tclient
    c.get("/api/trends", headers=h)
    monkeypatch.setattr(settings, "trends_ttl_seconds", -1)
    c.get("/api/trends", headers=h)
    assert len(calls) == 6


def test_one_source_failing(tclient, feeds):
    _, cfg = feeds
    cfg["fail"] = ("www.reddit.com",)
    c, h = tclient
    r = c.get("/api/trends", headers=h)
    assert r.status_code == 200
    assert {t["source"] for t in r.json()} == {"hackernews", "google"}


def test_all_fail_uses_fallback(tclient, feeds):
    _, cfg = feeds
    cfg["fail"] = ("www.reddit.com", "hn.algolia.com", "trends.google.com")
    c, h = tclient
    data = c.get("/api/trends", headers=h).json()
    assert len(data) == 12
    assert {t["source"] for t in data} <= {"hackernews", "reddit", "google"}


def test_row_cap():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    svc.store(conn, [{"source": "reddit", "title": f"t{i}", "url": f"u{i}", "score": 0.5, "region": ""}
                     for i in range(250)])
    assert conn.execute("SELECT COUNT(*) FROM trends").fetchone()[0] == 200


# ---- match, buzz, freshness (Unit H) -------------------------------------------------------------

BRAND_ROW = ("Brew & Bloom", "coffee lovers and plant parents", "coffee and plants")


def _profile_ws(conn, *, brand, audience="", offer="", themes=()):
    wid = new_id("ws_")
    conn.execute(
        "INSERT INTO workspaces (id, token, name, brand_name, brand_voice, audience, offer, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (wid, "tokx", "Demo", brand, "", audience, offer, now_iso()),
    )
    for name, desc in themes:
        conn.execute(
            "INSERT INTO themes (id, workspace_id, name, description, created_at) VALUES (?,?,?,?,?)",
            (new_id(), wid, name, desc, now_iso()),
        )
    conn.commit()
    return conn.execute("SELECT * FROM workspaces WHERE id = ?", (wid,)).fetchone()


def _mem_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def test_match_separates_related_from_unrelated():
    conn = _mem_conn()
    ws = _profile_ws(conn, brand=BRAND_ROW[0], audience=BRAND_ROW[1], offer=BRAND_ROW[2],
                     themes=[("Plant care", "houseplants tips")])
    profile = svc.brand_profile(conn, ws)
    rel_coffee, terms = svc.match("Cold brew coffee hits record sales this summer", profile)
    assert rel_coffee == 1.0 and "brew" in terms and "coffee" in terms
    rel_plant, terms_plant = svc.match("House plants everyone is buying", profile)
    assert 0.5 <= rel_plant <= 0.7 and terms_plant == ["plants"]
    rel_none, terms_none = svc.match("Linux 7.0 released", profile)
    assert rel_none == 0.0 and terms_none == []
    # A generic theme word must not make an unrelated headline a match.
    assert svc.match("My self care sunday routine", profile)[0] == 0.0
    # Synonym hits count less than direct hits.
    syn, syn_terms = svc.match("Show HN: a tiny espresso timer", profile)
    assert 0 < syn < rel_coffee and syn_terms == ["espresso"]


def test_match_is_continuous_not_a_step():
    conn = _mem_conn()
    ws = _profile_ws(conn, brand=BRAND_ROW[0], audience=BRAND_ROW[1], offer=BRAND_ROW[2])
    profile = svc.brand_profile(conn, ws)
    values = {svc.match(t, profile)[0] for t in [
        "Brew guide for beginners", "Coffee prices rise", "Plants in the office", "Latte art contest",
        "Linux kernel news",
    ]}
    # brand name hit (0.67), a synonym of a brand word (0.4), nothing (0): levels that follow the words, not one 50%.
    assert values == {0.0, 0.4, 0.6667}


def test_no_brand_profile_means_no_match():
    conn = _mem_conn()
    ws = _profile_ws(conn, brand="")
    profile = svc.brand_profile(conn, ws)
    assert profile == {}
    assert svc.match("Cold brew coffee hits record sales", profile) == (None, [])


def test_buzz_is_spread_across_the_batch():
    hn = svc.parse_hn(json.loads((FIX / "hn.json").read_text()))
    scores = [i["score"] for i in hn]
    assert len(set(scores)) == len(scores) and max(scores) == 1.0 and min(scores) == 0.0
    rd = svc.parse_reddit(json.loads((FIX / "reddit.json").read_text()))
    assert {i["score"] for i in rd} == {0.0, 1.0}
    assert svc._spread([5.0]) == [0.5]


def test_ranking_is_match_then_buzz():
    conn = _mem_conn()
    ws = _profile_ws(conn, brand=BRAND_ROW[0], audience=BRAND_ROW[1], offer=BRAND_ROW[2])
    svc.store(conn, [
        {"source": "reddit", "title": "Linux kernel news", "url": "u1", "score": 1.0, "region": ""},
        {"source": "hackernews", "title": "Coffee prices rise", "url": "u2", "score": 0.2, "region": ""},
        {"source": "google", "title": "Cold brew recipes", "url": "u3", "score": 0.5, "region": ""},
    ])
    order = [r["title"] for r in svc.ranked(conn, ws, 10)]
    assert order[:2] == ["Cold brew recipes", "Coffee prices rise"]
    assert order[-1] == "Linux kernel news"


def test_status_reports_per_source_failure_reason(tclient, feeds):
    _, cfg = feeds
    cfg["fail"] = ("www.reddit.com",)
    svc._LAST.clear()
    c, h = tclient
    c.get("/api/trends", headers=h)
    st = c.get("/api/trends/status", headers=h).json()
    by = {s["source"]: s for s in st["sources"]}
    assert [s["source"] for s in st["sources"]] == ["hackernews", "reddit", "google"]
    assert by["hackernews"]["ok"] is True and by["hackernews"]["count"] > 0
    assert by["reddit"]["ok"] is False and by["reddit"]["count"] == 0
    assert by["reddit"]["error"] == "Blocked by Reddit (HTTP 403)"
    assert by["hackernews"]["error"] is None
    assert st["newest_fetched_at"] and st["oldest_fetched_at"]


def test_status_requires_auth(client):
    assert client.get("/api/trends/status").status_code == 401


def test_list_exposes_match_terms_and_null_relevance_without_profile(client):
    conn = connect()
    init_db(conn)
    wid = new_id("ws_")
    conn.execute(
        "INSERT INTO workspaces (id, token, name, brand_name, brand_voice, audience, offer, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (wid, "tokempty", "Blank", "", "", "", "", now_iso()),
    )
    conn.commit()
    conn.close()
    h = {"Authorization": "Bearer tokempty"}
    svc._LAST.clear()
    svc.store(connect(), [{"source": "reddit", "title": "Cold brew coffee", "url": "ux", "score": 0.4,
                           "region": ""}])
    data = client.get("/api/trends", headers=h).json()
    assert data and data[0]["relevance"] is None and data[0]["match_terms"] == []


def test_describe_error_reasons():
    req = httpx.Request("GET", "https://www.reddit.com/r/popular/hot.json")
    assert svc.describe_error("reddit", httpx.HTTPStatusError("x", request=req, response=httpx.Response(429, request=req))) == "Rate-limited by Reddit (HTTP 429)"
    assert svc.describe_error("reddit", httpx.HTTPStatusError("x", request=req, response=httpx.Response(403, request=req))) == "Blocked by Reddit (HTTP 403)"
    assert svc.describe_error("hackernews", httpx.ConnectError("boom", request=req)) == "Could not reach Hacker News"
    assert svc.describe_error("google", httpx.ReadTimeout("slow", request=req)) == "Timed out waiting for Google Trends"


def test_fallback_has_no_clock_and_real_data_replaces_it():
    conn = _mem_conn()
    svc.store(conn, svc.fallback_items(), fetched_at="")
    rows = conn.execute("SELECT fetched_at FROM trends").fetchall()
    assert len(rows) == 12 and all(r["fetched_at"] == "" for r in rows)
    assert svc._age_seconds(conn) is None
    svc.store(conn, [{"source": "reddit", "title": "Real one", "url": "real", "score": 0.5, "region": ""}])
    assert [r["title"] for r in conn.execute("SELECT title FROM trends")] == ["Real one"]
