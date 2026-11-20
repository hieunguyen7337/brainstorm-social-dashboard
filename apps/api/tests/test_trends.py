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
