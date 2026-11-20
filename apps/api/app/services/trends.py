"""Outside trends: fetch HN / Reddit / Google Trends, cache in `trends`, rank for a workspace."""

import asyncio
import hashlib
import logging
import re
import sqlite3
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from urllib.parse import quote

import httpx

from app.config import settings
from app.db import now_iso

log = logging.getLogger("pulse.trends")

USER_AGENT = "PulseHackathon/0.1"
TIMEOUT = 6.0
MAX_ROWS = 200
HN_URL = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30"
REDDIT_URL = "https://www.reddit.com/r/popular/hot.json?limit=30"
GOOGLE_URL = "https://trends.google.com/trending/rss?geo=AU"

Item = dict  # {source, title, url, score, region}


def trend_id(source: str, url: str) -> str:
    return hashlib.sha1((source + url).encode()).hexdigest()[:16]


def _norm(values: list[float]) -> list[float]:
    """Rank-preserving log scaling to 0..1 (max -> 1.0)."""
    import math

    if not values:
        return []
    top = math.log1p(max(max(values), 0)) or 1.0
    return [round(min(1.0, math.log1p(max(v, 0)) / top), 4) for v in values]


def parse_hn(data: dict) -> list[Item]:
    hits = [h for h in data.get("hits", []) if h.get("title")]
    scores = _norm([float(h.get("points") or 0) for h in hits])
    out = []
    for h, s in zip(hits, scores):
        url = h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID', '')}"
        out.append({"source": "hackernews", "title": h["title"], "url": url, "score": s, "region": ""})
    return out


def parse_reddit(data: dict) -> list[Item]:
    posts = [
        c["data"]
        for c in data.get("data", {}).get("children", [])
        if c.get("data", {}).get("title") and not c["data"].get("stickied")
    ]
    scores = _norm([float(p.get("score") or 0) for p in posts])
    out = []
    for p, s in zip(posts, scores):
        url = "https://www.reddit.com" + p.get("permalink", "")
        out.append({"source": "reddit", "title": p["title"], "url": url, "score": s, "region": ""})
    return out


def _traffic(text: str | None) -> float:
    m = re.search(r"[\d,]+", text or "")
    return float(m.group().replace(",", "")) if m else 0.0


def parse_google(xml_text: str) -> list[Item]:
    root = ET.fromstring(xml_text)
    rows = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        if not title:
            continue
        traffic = ""
        for child in item:
            if child.tag.endswith("approx_traffic"):
                traffic = (child.text or "").strip()
        link = (item.findtext("link") or "").strip()
        url = link if link and "trending?" not in link else (
            "https://trends.google.com/trends/explore?q=" + quote(title) + "&geo=AU"
        )
        rows.append((title, url, traffic))
    scores = _norm([_traffic(r[2]) for r in rows]) if any(r[2] for r in rows) else [
        round(1 - i / max(len(rows), 1) * 0.8, 4) for i in range(len(rows))
    ]
    out = []
    for (title, url, traffic), s in zip(rows, scores):
        label = f"{title} ({traffic} searches)" if traffic else title
        out.append({"source": "google", "title": label, "url": url, "score": s, "region": "AU"})
    return out


async def _get(client: httpx.AsyncClient, name: str, url: str, parser, as_json: bool) -> list[Item]:
    try:
        r = await client.get(url)
        r.raise_for_status()
        return parser(r.json() if as_json else r.text)
    except Exception as exc:  # noqa: BLE001 - a failing source is skipped, never a client error
        log.warning("trend source %s failed: %s", name, exc)
        return []


async def fetch_all(client: httpx.AsyncClient | None = None) -> dict[str, list[Item]]:
    own = client is None
    if own:
        client = httpx.AsyncClient(
            timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=True
        )
    try:
        hn, rd, gg = await asyncio.gather(
            _get(client, "hackernews", HN_URL, parse_hn, True),
            _get(client, "reddit", REDDIT_URL, parse_reddit, True),
            _get(client, "google", GOOGLE_URL, parse_google, False),
        )
    finally:
        if own:
            await client.aclose()
    return {"hackernews": hn, "reddit": rd, "google": gg}


FALLBACK = [
    ("google", "morning coffee rituals", 0.9),
    ("google", "indoor plants for small spaces", 0.85),
    ("reddit", "Small businesses embracing sustainability", 0.8),
    ("hackernews", "How AI is changing marketing for small teams", 0.75),
    ("reddit", "Local cafes are the new community hubs", 0.7),
    ("google", "cold brew recipes", 0.68),
    ("hackernews", "The case for building in public", 0.6),
    ("reddit", "Weekend farmers market finds", 0.55),
    ("google", "self care sunday ideas", 0.5),
    ("hackernews", "Short-form video is eating social media", 0.45),
    ("reddit", "Houseplant owners share their best propagation tips", 0.4),
    ("google", "eco friendly gift ideas", 0.35),
]


def fallback_items() -> list[Item]:
    return [
        {
            "source": s,
            "title": t,
            "url": f"https://example.com/evergreen/{quote(t.replace(' ', '-').lower())}",
            "score": sc,
            "region": "",
        }
        for s, t, sc in FALLBACK
    ]


def _age_seconds(conn: sqlite3.Connection) -> float | None:
    row = conn.execute("SELECT MAX(fetched_at) AS m FROM trends").fetchone()
    if not row or not row["m"]:
        return None
    try:
        ts = datetime.fromisoformat(row["m"])
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    return (datetime.now(UTC) - ts).total_seconds()


def store(conn: sqlite3.Connection, items: list[Item]) -> None:
    ts = now_iso()
    for it in items:
        conn.execute(
            """INSERT INTO trends (id, source, title, url, score, region, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET title=excluded.title, score=excluded.score,
               region=excluded.region, fetched_at=excluded.fetched_at""",
            (trend_id(it["source"], it["url"]), it["source"], it["title"], it["url"],
             it["score"], it["region"], ts),
        )
    conn.execute(
        "DELETE FROM trends WHERE id NOT IN (SELECT id FROM trends ORDER BY fetched_at DESC, id LIMIT ?)",
        (MAX_ROWS,),
    )
    conn.commit()


async def ensure_fresh(conn: sqlite3.Connection, refresh: bool = False) -> None:
    age = _age_seconds(conn)
    if not refresh and age is not None and age <= settings.trends_ttl_seconds:
        return
    results = await fetch_all()
    items = [i for lst in results.values() for i in lst]
    if items:
        store(conn, items)
    elif age is None:
        store(conn, fallback_items())


STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "be", "by",
    "at", "as", "it", "its", "this", "that", "from", "your", "our", "we", "you", "i", "my", "how", "why",
    "what", "new", "get", "more", "all", "us", "can", "will", "has", "have", "not", "but", "about",
}
SYNONYMS = {
    "coffee": {"espresso", "latte", "brew", "cafe", "barista", "caffeine", "cappuccino"},
    "plant": {"plants", "houseplant", "houseplants", "garden", "gardening", "flower", "flowers", "bloom", "succulent"},
    "tea": {"matcha", "chai"},
    "fitness": {"gym", "workout", "running", "yoga"},
    "software": {"app", "code", "developer", "developers", "programming", "ai"},
}


def _stem(w: str) -> str:
    return w[:-1] if len(w) > 3 and w.endswith("s") else w


def tokens(text: str) -> set[str]:
    out = {_stem(w) for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(w) > 2 and w not in STOPWORDS}
    expanded = set(out)
    for key, syns in SYNONYMS.items():
        group = {key} | {_stem(s) for s in syns}
        if out & group:
            expanded |= group
    return expanded


def workspace_keywords(conn: sqlite3.Connection, ws: sqlite3.Row) -> set[str]:
    parts = [ws["brand_name"], ws["brand_voice"], ws["audience"], ws["offer"]]
    for t in conn.execute("SELECT name, description FROM themes WHERE workspace_id = ?", (ws["id"],)):
        parts += [t["name"], t["description"]]
    return tokens(" ".join(p or "" for p in parts))


def relevance(title: str, keywords: set[str]) -> float:
    toks = tokens(title)
    if not toks or not keywords:
        return 0.0
    hits = len(toks & keywords)
    return round(min(1.0, hits / 2), 4)  # two matching keywords saturate


def ranked(conn: sqlite3.Connection, ws: sqlite3.Row, limit: int) -> list[dict]:
    kw = workspace_keywords(conn, ws)
    rows = conn.execute("SELECT * FROM trends").fetchall()
    out = []
    for r in rows:
        rel = relevance(r["title"], kw)
        out.append(
            {
                "id": r["id"], "source": r["source"], "title": r["title"], "url": r["url"],
                "score": r["score"], "relevance": rel, "fetched_at": r["fetched_at"],
                "_rank": 0.6 * rel + 0.4 * r["score"],
            }
        )
    out.sort(key=lambda d: d["_rank"], reverse=True)
    for d in out:
        d.pop("_rank")
    return out[: max(1, limit)]
