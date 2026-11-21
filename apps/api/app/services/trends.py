"""Outside trends: fetch HN / Reddit / Google Trends, cache in `trends`, rank for a workspace.

Two scores per trend:
- `score` (buzz, 0..1) comes from the source's real signal (HN points + comments, Reddit score, Google search
  volume or, when Google gives no volume, its list position), spread 0..1 across the batch fetched from that source.
- `relevance` (match, 0..1 or None) is computed at read time from the workspace's brand profile (name, theme names
  and descriptions, audience, offer). Each brand term found in the headline adds its weight (synonyms count less);
  the total saturates at `MATCH_SATURATION`. `None` means the workspace has no brand profile at all.

Freshness is per source: `status()` reports, for each source, when its rows were last stored and why the last
attempt failed (process memory; the rows themselves carry their own `fetched_at`).
"""

import asyncio
import hashlib
import logging
import math
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

SOURCES = ("hackernews", "reddit", "google")
SOURCE_LABELS = {"hackernews": "Hacker News", "reddit": "Reddit", "google": "Google Trends"}

Item = dict  # {source, title, url, score, region}

# Last fetch attempt per source, in this process: {"ok": bool, "attempted_at": iso, "error": str | None}.
_LAST: dict[str, dict] = {}


def trend_id(source: str, url: str) -> str:
    return hashlib.sha1((source + url).encode()).hexdigest()[:16]


def _spread(values: list[float]) -> list[float]:
    """Buzz 0..1 across one batch: log-scaled, then min-max. A batch with no spread (one item, or all equal) is 0.5."""
    if not values:
        return []
    logs = [math.log1p(max(v, 0.0)) for v in values]
    lo, hi = min(logs), max(logs)
    if hi - lo < 1e-9:
        return [0.5 for _ in logs]
    return [round((x - lo) / (hi - lo), 4) for x in logs]


def parse_hn(data: dict) -> list[Item]:
    hits = [h for h in data.get("hits", []) if h.get("title")]
    signal = [float(h.get("points") or 0) + float(h.get("num_comments") or 0) for h in hits]
    out = []
    for h, s in zip(hits, _spread(signal)):
        url = h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID', '')}"
        out.append({"source": "hackernews", "title": h["title"], "url": url, "score": s, "region": ""})
    return out


def parse_reddit(data: dict) -> list[Item]:
    posts = [
        c["data"]
        for c in data.get("data", {}).get("children", [])
        if c.get("data", {}).get("title") and not c["data"].get("stickied")
    ]
    scores = _spread([float(p.get("score") or 0) for p in posts])
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
    if any(r[2] for r in rows):
        scores = _spread([_traffic(r[2]) for r in rows])
    else:
        # No search volumes in the feed: Google's own order is the only signal (first = most searched).
        scores = _spread([float(len(rows) - i) for i in range(len(rows))])
    out = []
    for (title, url, traffic), s in zip(rows, scores):
        label = f"{title} ({traffic} searches)" if traffic else title
        out.append({"source": "google", "title": label, "url": url, "score": s, "region": "AU"})
    return out


def describe_error(name: str, exc: Exception) -> str:
    """A plain reason a source could not be read, for the status line."""
    label = SOURCE_LABELS.get(name, name)
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code == 429:
            return f"Rate-limited by {label} (HTTP 429)"
        if code in (401, 403):
            return f"Blocked by {label} (HTTP {code})"
        return f"{label} returned HTTP {code}"
    if isinstance(exc, httpx.TimeoutException):
        return f"Timed out waiting for {label}"
    if isinstance(exc, httpx.RequestError):
        return f"Could not reach {label}"
    return f"Unexpected response from {label}"


async def _get(client: httpx.AsyncClient, name: str, url: str, parser, as_json: bool) -> list[Item]:
    try:
        r = await client.get(url)
        r.raise_for_status()
        items = parser(r.json() if as_json else r.text)
    except Exception as exc:  # noqa: BLE001 - a failing source is skipped, never a client error
        log.warning("trend source %s failed: %s", name, exc)
        _LAST[name] = {"ok": False, "attempted_at": now_iso(), "error": describe_error(name, exc)}
        return []
    _LAST[name] = {"ok": True, "attempted_at": now_iso(), "error": None}
    return items


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
    """Built-in examples, served only when every feed failed and nothing was ever fetched. Stored with no
    `fetched_at` (''), so no clock is shown for them and the next successful fetch replaces them."""
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


def store(conn: sqlite3.Connection, items: list[Item], fetched_at: str | None = None) -> None:
    ts = fetched_at if fetched_at is not None else now_iso()
    if ts:
        # Real rows replace the built-in examples.
        conn.execute("DELETE FROM trends WHERE fetched_at = ''")
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
        store(conn, fallback_items(), fetched_at="")


# ---- matching ------------------------------------------------------------------------------------

STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "be", "by",
    "at", "as", "it", "its", "this", "that", "from", "your", "our", "we", "you", "i", "my", "how", "why",
    "what", "new", "get", "more", "all", "us", "can", "will", "has", "have", "not", "but", "about", "than",
}
# Words that mean the same thing for brand matching. A synonym hit counts less than a direct one.
CONCEPTS: list[set[str]] = [
    {"coffee", "espresso", "latte", "brew", "cafe", "barista", "caffeine", "cappuccino", "roast"},
    {"plant", "houseplant", "garden", "gardening", "flower", "bloom", "succulent", "botanical"},
    {"tea", "matcha", "chai"},
    {"fitness", "gym", "workout", "running", "yoga"},
    {"software", "app", "code", "developer", "programming"},
    {"sustainable", "sustainability", "eco", "green", "zerowaste"},
]
SYNONYM_FACTOR = 0.6
# Brand term weights: a name or theme name is worth more than a word from a description.
W_NAME = 1.0
W_DESCRIPTION = 0.5
# Words too generic to say anything about a brand ("Plant care" must not make every "self care" headline a match).
PROFILE_GENERIC = {
    "care", "tips", "ideas", "guide", "lover", "parent", "people", "customer", "customers", "shop", "store",
    "brand", "business", "best", "friend", "family", "online", "local",
}
# A match total of this saturates relevance at 1.0 (one name hit is 0.67, a name plus a description word 1.0).
MATCH_SATURATION = 1.5
MAX_MATCH_TERMS = 5


def _stem(w: str) -> str:
    return w[:-1] if len(w) > 3 and w.endswith("s") else w


_CONCEPT_OF: dict[str, int] = {}
for _i, _group in enumerate(CONCEPTS):
    for _w in _group:
        _CONCEPT_OF.setdefault(_stem(_w), _i)


def _words(text: str | None) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(w) > 2 and w not in STOPWORDS]


def brand_profile(conn: sqlite3.Connection, ws: sqlite3.Row) -> dict[str, tuple[float, str]]:
    """Stem -> (weight, the word as written) for the workspace's brand name, theme names and theme descriptions,
    audience and offer. Empty when the workspace has said nothing about its brand."""
    profile: dict[str, tuple[float, str]] = {}

    def add(text: str | None, weight: float) -> None:
        for w in _words(text):
            s = _stem(w)
            if s in PROFILE_GENERIC:
                continue
            if weight > profile.get(s, (0.0, ""))[0]:
                profile[s] = (weight, w)

    add(ws["brand_name"], W_NAME)
    add(ws["audience"], W_DESCRIPTION)
    add(ws["offer"], W_DESCRIPTION)
    for t in conn.execute("SELECT name, description FROM themes WHERE workspace_id = ?", (ws["id"],)):
        add(t["name"], W_NAME)
        add(t["description"], W_DESCRIPTION)
    return profile


def match(title: str, profile: dict[str, tuple[float, str]]) -> tuple[float | None, list[str]]:
    """(relevance, match_terms). Relevance is None when the profile is empty; terms are the headline's own words
    that overlap the profile, strongest first."""
    if not profile:
        return None, []
    title_words: dict[str, str] = {}
    for w in _words(title):
        title_words.setdefault(_stem(w), w)
    # Each headline word counts once, with its best brand match, so one concept cannot add up over several terms.
    best: dict[str, tuple[float, str]] = {}  # headline stem -> (contribution, headline word)
    for ts, disp in title_words.items():
        concept = _CONCEPT_OF.get(ts)
        value = 0.0
        for ps, (weight, _) in profile.items():
            if ts == ps:
                value = max(value, weight)
            elif concept is not None and _CONCEPT_OF.get(ps) == concept:
                value = max(value, weight * SYNONYM_FACTOR)
        if value > 0:
            best[ts] = (value, disp)
    total = sum(v for v, _ in best.values())
    relevance = round(min(1.0, total / MATCH_SATURATION), 4)
    ranked_terms = sorted(best.values(), key=lambda p: (-p[0], p[1]))
    terms: list[str] = []
    for _, word in ranked_terms:
        if word not in terms:
            terms.append(word)
    return relevance, terms[:MAX_MATCH_TERMS]


# ---- ranking and status --------------------------------------------------------------------------


def ranked(conn: sqlite3.Connection, ws: sqlite3.Row, limit: int) -> list[dict]:
    """Trends sorted by match (unknown match last), then buzz, then title."""
    profile = brand_profile(conn, ws)
    rows = conn.execute("SELECT * FROM trends").fetchall()
    out = []
    for r in rows:
        rel, terms = match(r["title"], profile)
        out.append(
            {
                "id": r["id"], "source": r["source"], "title": r["title"], "url": r["url"],
                "score": r["score"], "relevance": rel, "match_terms": terms, "fetched_at": r["fetched_at"],
            }
        )
    out.sort(key=lambda d: d["title"])
    out.sort(key=lambda d: (d["relevance"] if d["relevance"] is not None else -1.0, d["score"]), reverse=True)
    return out[: max(1, limit)]


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        ts = datetime.fromisoformat(value)
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


def status(conn: sqlite3.Connection) -> dict:
    """Per-source freshness and last failure reason, plus the newest and oldest stored fetch time."""
    counts = {
        r["source"]: r
        for r in conn.execute(
            "SELECT source, COUNT(*) AS n, MAX(fetched_at) AS m FROM trends"
            " WHERE fetched_at <> '' GROUP BY source"
        )
    }
    sources = []
    stamps: list[datetime] = []
    for name in SOURCES:
        last = _LAST.get(name, {})
        row = counts.get(name)
        fetched = row["m"] if row else None
        if fetched and _parse_iso(fetched):
            stamps.append(_parse_iso(fetched))
        sources.append(
            {
                "source": name,
                "ok": last.get("ok"),
                "attempted_at": last.get("attempted_at"),
                "fetched_at": fetched or None,
                "count": row["n"] if row else 0,
                "error": last.get("error") if last.get("ok") is False else None,
            }
        )
    return {
        "sources": sources,
        "newest_fetched_at": max(stamps).isoformat(timespec="seconds") if stamps else None,
        "oldest_fetched_at": min(stamps).isoformat(timespec="seconds") if stamps else None,
    }
