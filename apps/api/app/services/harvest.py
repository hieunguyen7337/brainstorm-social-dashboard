"""Harvest: profile-URL validation, post matching and ingest of real platform stats.

Dashboard honesty: the dashboard reads `daily_metrics`, not `posts`. For every matched or created post the
ingest therefore adds the delta (new - old) of views/engagements/clicks/conversions to `daily_metrics`,
on the day the post was published when that day is inside the dashboard's 30-day window, else on today.
A negative delta is subtracted, but a daily value never drops below 0. Account-level numbers are windowed
totals rather than daily increments, so they only go to `metric_snapshots` (with the window they cover in
`period_days`, when stated) and `connections.followers`.

Real numbers (docs/REAL.md): in a real workspace, and for the `screenshot` / `device` sources anywhere, an ingest
also connects the platform in 'live' mode (the person's own numbers, never simulated): it sets the handle when
given and records a single 'connected' event the first time. Sample workspaces fed by the other sources behave
exactly as before (409 when the platform is disconnected, connections stay 'sandbox').
"""

import re
import sqlite3
from collections.abc import Collection, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal, NamedTuple, get_args
from urllib.parse import unquote, urlsplit, urlunsplit

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app import redact
from app.db import PLATFORMS, new_id, now_iso
from app.models import Platform, Post
from app.platforms import live_platforms, require_live
from app.services import metrics

DOMAINS = {
    "linkedin": ("linkedin.com",),
    "instagram": ("instagram.com",),
    "x": ("x.com", "twitter.com"),
    "tiktok": ("tiktok.com",),
    "reddit": ("reddit.com",),
    "facebook": ("facebook.com", "fb.com"),
}
NAMES = {"linkedin": "LinkedIn", "instagram": "Instagram", "x": "X", "tiktok": "TikTok",
         "reddit": "Reddit", "facebook": "Facebook"}
KEYS = ("views", "engagements", "clicks", "conversions")
MIN_PREFIX = 20  # shortest text (chars) that may match another by prefix
MAX_CONTENT, MAX_URL, MAX_ID = 5000, 2048, 200
WINDOW_DAYS = 30  # same window as the dashboard default
LIVE_SOURCES = ("screenshot", "device")  # the person's own numbers, read from their screen or their device
MAX_HANDLE = 100

Count = Annotated[int, Field(ge=0, le=10**12)]
PeriodDays = Annotated[int, Field(ge=1, le=365)]  # the window the account's views/engagements cover


def pick_source(allowed: Collection[str]) -> str:
    """`source` for posts created by a harvest: 'harvested' once models.Post accepts it, else 'manual'.

    models.Post.source is a Literal owned by the lead; a row whose source it rejects makes GET /api/posts and
    /api/dashboard raise a 500. Until the lead adds 'harvested' there, new posts fall back to 'manual' (they
    stay recognisable by metrics_source='real'); the moment the Literal allows it this switches by itself.
    """
    return "harvested" if "harvested" in allowed else "manual"


HARVESTED_SOURCE = pick_source(get_args(Post.model_fields["source"].annotation))


# ---------------------------------------------------------------- request models

def clean_handle(value: str | None) -> str | None:
    """A handle as stored: surrounding whitespace and leading '@' stripped; None when nothing is left."""
    return (value or "").strip().lstrip("@").strip() or None


class IngestAccount(BaseModel):
    model_config = ConfigDict(extra="ignore")
    followers: Count | None = None
    views: Count | None = None
    engagements: Count | None = None
    clicks: Count | None = None
    profile_views: Count | None = None
    # Also accepted here, as a convenience: IngestRequest.handle / .period_days (top level) win when both are sent.
    handle: str | None = Field(default=None, max_length=MAX_HANDLE)
    period_days: PeriodDays | None = None

    def numbers(self) -> dict[str, int]:
        """The account-level counts that were given (handle and period_days are not counts)."""
        return self.model_dump(exclude_none=True, exclude={"handle", "period_days"})


class IngestPost(BaseModel):
    model_config = ConfigDict(extra="ignore")
    external_id: str | None = None
    url: str | None = None
    content: str | None = None
    posted_at: str | None = None
    views: Count
    engagements: Count
    clicks: Count | None = None
    conversions: Count | None = None

    @field_validator("url")
    @classmethod
    def _drop_credential_query(cls, value: str | None) -> str | None:
        # A sign-in redirect can carry a session token or a one-time code; it is never stored or shown.
        return redact.strip_credential_query(value) if value else value


class IngestRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    platform: Platform
    source: Literal["script", "claude_chrome", "manual", "screenshot", "device"]
    handle: str | None = Field(default=None, max_length=MAX_HANDLE)  # leading '@' is stripped
    period_days: PeriodDays | None = None  # the window account.views/engagements/profile_views cover
    account: IngestAccount = Field(default_factory=IngestAccount)
    posts: list[IngestPost] = Field(default_factory=list, max_length=500)

    @field_validator("handle")
    @classmethod
    def _strip_handle(cls, value: str | None) -> str | None:
        return clean_handle(value)

    @model_validator(mode="after")
    def _adopt_account_extras(self) -> "IngestRequest":
        """Top-level handle / period_days win; fall back to the ones sent inside `account`."""
        self.handle = self.handle or clean_handle(self.account.handle)
        if self.period_days is None:
            self.period_days = self.account.period_days
        return self


# ---------------------------------------------------------------- pure matching helpers

def normalise_url(url: str | None) -> str:
    """Lowercase scheme+host, drop leading 'www.', query, fragment and trailing '/'. '' if unusable."""
    url = (url or "").strip()
    if not url:
        return ""
    try:
        p = urlsplit(url if "//" in url else "//" + url)
    except ValueError:
        return ""
    if not p.netloc:
        return ""
    host = p.netloc.lower().removeprefix("www.")
    return f"{(p.scheme or 'https').lower()}://{host}{p.path.rstrip('/')}"


_TAIL = re.compile(r"\s*(?:(?:…|\.\.\.)\s*(?:see\s+)?more|…|\.\.\.|(?<!\w)see more)\s*$")


def normalise_text(text: str | None) -> str:
    """Casefold, collapse whitespace, strip trailing ellipsis / 'see more' (the feed truncates posts)."""
    t = " ".join((text or "").casefold().split())
    while (s := _TAIL.sub("", t)) != t:
        t = s
    return t


class Candidate(NamedTuple):
    """An existing post with its match keys already normalised."""
    id: str
    external_id: str
    url: str
    text: str


def candidate(post_id: str, external_id: str | None = None, external_url: str | None = None,
              content: str | None = None) -> Candidate:
    return Candidate(
        post_id, (external_id or "").strip(), normalise_url(external_url), normalise_text(content)
    )


def _prefix_match(a: str, b: str) -> bool:
    short, long = sorted((a, b), key=len)
    return len(short) >= MIN_PREFIX and long.startswith(short)


def find_match(candidates: Sequence[Candidate], *, external_id: str | None = None, url: str | None = None,
               content: str | None = None, used: Collection[str] = ()) -> str | None:
    """Id of the candidate an ingested post refers to, or None.

    Precedence over all unused candidates: (i) external_id, (ii) normalised url, (iii) content prefix
    (an exact text match beats a mere prefix match; otherwise the first candidate wins).
    """
    free = [c for c in candidates if c.id not in used]
    eid = (external_id or "").strip()
    if eid:
        for c in free:
            if c.external_id == eid:
                return c.id
    nurl = normalise_url(url)
    if nurl:
        for c in free:
            if c.url == nurl:
                return c.id
    text = normalise_text(content)
    if not text:
        return None
    first = None
    for c in free:
        if _prefix_match(text, c.text):
            if c.text == text:
                return c.id
            first = first or c.id
    return first


# ---------------------------------------------------------------- profile URL

def validate_profile_url(platform: str, raw: str) -> str:
    """Return the normalised profile URL (whitespace and fragment dropped) or raise 422."""
    try:
        parts = urlsplit(raw.strip())
        host = parts.hostname or ""
        _ = parts.port  # raises ValueError on a malformed port
    except ValueError:
        raise HTTPException(status_code=422, detail="profile_url is not a valid URL") from None
    if parts.scheme not in ("http", "https") or not host:
        raise HTTPException(status_code=422, detail="profile_url must be an absolute http(s) URL")
    if parts.username is not None or parts.password is not None or redact.has_credential_query(raw):
        raise HTTPException(status_code=422, detail="profile_url must not contain credentials")
    domains = DOMAINS[platform]
    if not any(host == d or host.endswith("." + d) for d in domains):
        raise HTTPException(
            status_code=422,
            detail=f"profile_url host must be {' or '.join(domains)} (or a subdomain) for {platform}",
        )
    return urlunsplit(parts._replace(netloc=parts.netloc.lower(), fragment=""))


def derive_handle(platform: str, url: str) -> str:
    """Handle in the seed's style: company/acme, in/jane, u/jane, @jane; the hostname as a fallback."""
    parts = urlsplit(url)
    host = parts.hostname or DOMAINS[platform][0]
    segs = [unquote(s) for s in parts.path.split("/") if s]
    handle = host
    if segs and platform == "linkedin":
        if segs[0] in ("in", "company", "school", "showcase") and len(segs) > 1:
            handle = f"{segs[0]}/{segs[1]}"
    elif segs and platform == "reddit":
        kind = {"u": "u", "user": "u", "r": "r"}.get(segs[0])
        if kind and len(segs) > 1:
            handle = f"{kind}/{segs[1]}"
    elif segs:
        name = segs[0].lstrip("@")
        if name and not name.endswith(".php"):
            handle = f"@{name}"
    return handle[:60]


def _insert_connection(conn: sqlite3.Connection, workspace_id: str, platform: str, handle: str,
                       profile_url: str | None, now: str, followers: int = 0, mode: str = "sandbox") -> None:
    conn.execute(
        "INSERT INTO connections (id, workspace_id, platform, handle, status, mode, followers, connected_at,"
        " profile_url) VALUES (?,?,?,?,'connected',?,?,?,?)"
        " ON CONFLICT (workspace_id, platform) DO NOTHING",
        (new_id("c_"), workspace_id, platform, handle, mode, followers, now, profile_url),
    )


def is_real_workspace(conn: sqlite3.Connection, workspace_id: str) -> bool:
    row = conn.execute("SELECT data_mode FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
    return row is not None and row["data_mode"] == "real"


def connect_live(conn: sqlite3.Connection, workspace_id: str, platform: str, *, handle: str | None = None,
                 now: str | None = None) -> bool:
    """Connect `platform` in 'live' mode: its numbers come from the person's own account, never a simulation.

    Creates the connection when it is missing, (re)connects it otherwise and sets the handle when given. A
    'connected' event ("Connected Instagram (real)") is recorded only when this changes something, so a second
    ingest adds none. Does not commit. Returns True when the platform was newly connected live.
    """
    now = now or now_iso()
    row = conn.execute(
        "SELECT id, status, mode FROM connections WHERE workspace_id = ? AND platform = ?", (workspace_id, platform)
    ).fetchone()
    fresh = row is None or row["status"] != "connected" or row["mode"] != "live"
    if row is None:
        _insert_connection(conn, workspace_id, platform, handle or "", None, now, mode="live")
    else:
        sets = {"status": "connected", "mode": "live"}
        if fresh:
            sets["connected_at"] = now
        if handle:
            sets["handle"] = handle
        conn.execute(f"UPDATE connections SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",
                     (*sets.values(), row["id"]))
    if fresh:
        conn.execute(
            "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts)"
            " VALUES (?,?,NULL,'connected',?,?,1,?)",
            (new_id("e_"), workspace_id, platform, f"Connected {NAMES[platform]} (real)", now),
        )
    return fresh


def set_profile(conn: sqlite3.Connection, workspace_id: str, platform: str, raw_url: str) -> sqlite3.Row:
    """Store the profile URL; create the connection if missing, reconnect it if disconnected.

    In a real workspace the platform is connected live, with one 'connected' event (see `connect_live`), and a
    handle the person does not have yet is taken from the URL; the one they already have is kept.
    """
    if platform not in PLATFORMS:
        raise HTTPException(status_code=404, detail=f"unknown platform '{platform}'")
    require_live(platform)
    url = validate_profile_url(platform, raw_url)
    row = conn.execute(
        "SELECT id, handle FROM connections WHERE workspace_id = ? AND platform = ?", (workspace_id, platform)
    ).fetchone()
    if is_real_workspace(conn, workspace_id):
        derived = clean_handle(derive_handle(platform, url))
        if derived == (urlsplit(url).hostname or "")[:60] or (row is not None and row["handle"]):
            derived = None  # nothing but the site's name in the URL, or the person already has a handle
        connect_live(conn, workspace_id, platform, handle=derived)
        conn.execute("UPDATE connections SET profile_url = ? WHERE workspace_id = ? AND platform = ?",
                     (url, workspace_id, platform))
    elif row is None:
        _insert_connection(conn, workspace_id, platform, derive_handle(platform, url), url, now_iso())
    else:
        conn.execute("UPDATE connections SET profile_url = ?, status = 'connected' WHERE id = ?",
                     (url, row["id"]))
    conn.commit()
    return conn.execute(
        "SELECT * FROM connections WHERE workspace_id = ? AND platform = ?", (workspace_id, platform)
    ).fetchone()


# ---------------------------------------------------------------- ingest

def _clip(text: str | None, limit: int) -> str:
    return (text or "").strip()[:limit]


def _parse_utc(raw: str | None) -> datetime | None:
    try:
        dt = datetime.fromisoformat((raw or "").strip())
        return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).astimezone(UTC)
    except (ValueError, OverflowError):
        return None


def _published_at(raw: str | None, now: datetime) -> str:
    """ISO-8601 date/datetime -> UTC isoformat (seconds). Missing, unparseable or future -> now."""
    dt = _parse_utc(raw)
    return min(dt, now).isoformat(timespec="seconds") if dt else now.isoformat(timespec="seconds")


def _bucket_day(published_at: str | None) -> str:
    """The daily_metrics day for a post's delta: its publish day if in the 30-day window, else today."""
    today = date.fromisoformat(metrics.today())
    dt = _parse_utc(published_at)
    if dt and today - timedelta(days=WINDOW_DAYS - 1) <= dt.date() <= today:
        return dt.date().isoformat()
    return today.isoformat()


def _add_daily(conn: sqlite3.Connection, workspace_id: str, platform: str, published_at: str | None,
               delta: dict[str, int]) -> None:
    day = _bucket_day(published_at)
    if pos := {k: v for k, v in delta.items() if v > 0}:
        metrics.bump_daily(conn, workspace_id, platform, day, **pos)
    if neg := {k: v for k, v in delta.items() if v < 0}:
        sets = ", ".join(f"{k} = MAX({k} + ?, 0)" for k in neg)
        conn.execute(
            f"UPDATE daily_metrics SET {sets} WHERE workspace_id = ? AND platform = ? AND day = ?",
            (*neg.values(), workspace_id, platform, day),
        )


def _update_post(conn: sqlite3.Connection, workspace_id: str, platform: str, row: sqlite3.Row,
                 p: IngestPost, now: datetime) -> None:
    """Overwrite a matched post with the real numbers (omitted clicks/conversions are kept)."""
    stamp = now.isoformat(timespec="seconds")
    new = {k: row[k] if getattr(p, k) is None else getattr(p, k) for k in KEYS}
    sets = {
        **new, "metrics_source": "real", "harvested_at": stamp, "last_tick_at": stamp,
        "external_id": row["external_id"] or _clip(p.external_id, MAX_ID) or None,
        "external_url": row["external_url"] or _clip(p.url, MAX_URL),
    }
    published_at = row["published_at"]
    if row["status"] != "published" or not published_at:
        published_at = _published_at(p.posted_at, now)
        sets.update(status="published", published_at=published_at, scheduled_at=None)
    conn.execute(
        f"UPDATE posts SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), row["id"])
    )
    _add_daily(conn, workspace_id, platform, published_at, {k: new[k] - row[k] for k in KEYS})


def _insert_post(conn: sqlite3.Connection, workspace_id: str, platform: str, p: IngestPost,
                 now: datetime) -> str:
    """Create a published, harvested post (no tracked link). Returns its id."""
    pid, stamp = new_id("p_"), now.isoformat(timespec="seconds")
    url = _clip(p.url, MAX_URL)
    published_at = _published_at(p.posted_at, now)
    vals = {k: getattr(p, k) or 0 for k in KEYS}
    conn.execute(
        """INSERT INTO posts (id, workspace_id, platform, content, hashtags, link_code, status, source,
           published_at, external_url, views, engagements, clicks, conversions, last_tick_at, created_at,
           metrics_source, external_id, harvested_at)
           VALUES (?,?,?,?,'[]',NULL,'published',?,?,?,?,?,?,?,?,?,'real',?,?)""",
        (pid, workspace_id, platform, _clip(p.content, MAX_CONTENT) or url or "Harvested post", HARVESTED_SOURCE,
         published_at, url, *vals.values(), stamp, stamp, _clip(p.external_id, MAX_ID) or None, stamp),
    )
    _add_daily(conn, workspace_id, platform, published_at, vals)
    return pid


def _snapshot(conn: sqlite3.Connection, workspace_id: str, platform: str, post_id: str | None, source: str,
              captured_at: str, *, followers: int | None = None, period_days: int | None = None,
              **counts: int | None) -> None:
    """One metric_snapshots row; a metric that was not captured stays NULL."""
    conn.execute(
        "INSERT INTO metric_snapshots (id, workspace_id, post_id, platform, views, engagements, clicks,"
        " conversions, followers, source, captured_at, period_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (new_id("s_"), workspace_id, post_id, platform, *(counts.get(k) for k in KEYS), followers, source,
         captured_at, period_days),
    )


def _event_detail(req: IngestRequest) -> str:
    acc = req.account
    text = f"Harvested {len(req.posts)} post{'' if len(req.posts) == 1 else 's'}"
    text += f" from {NAMES[req.platform]} ({req.source})"
    extras = [f"{v:,} {label}" for v, label in
              ((acc.followers, "followers"), (acc.views, "views"), (acc.profile_views, "profile views"))
              if v is not None]
    return text + (": " + ", ".join(extras) if extras else "")


def ingest(conn: sqlite3.Connection, workspace_id: str, req: IngestRequest) -> dict:
    """Apply an ingest in one transaction (rolled back on any error, committed once at the end)."""
    platform, now = req.platform, now_iso()
    now_dt = datetime.fromisoformat(now)
    try:
        if is_real_workspace(conn, workspace_id) or req.source in LIVE_SOURCES:
            connect_live(conn, workspace_id, platform, handle=req.handle, now=now)
        else:
            status = conn.execute(
                "SELECT status FROM connections WHERE workspace_id = ? AND platform = ?", (workspace_id, platform)
            ).fetchone()
            if status is not None and status["status"] == "disconnected":
                raise HTTPException(
                    status_code=409,
                    detail=f"{NAMES[platform]} is disconnected: reconnect it (POST /api/connections/{platform})"
                           f" or set its profile URL (PUT /api/connections/{platform}/profile) before ingesting",
                )
            if status is None:
                _insert_connection(conn, workspace_id, platform, DOMAINS[platform][0], None, now)
            if req.handle:
                conn.execute("UPDATE connections SET handle = ? WHERE workspace_id = ? AND platform = ?",
                             (req.handle, workspace_id, platform))

        # Newest first, so a newest-first feed pairs with newest-first posts when texts repeat.
        rows = {r["id"]: r for r in conn.execute(
            "SELECT id, external_id, external_url, content, status, published_at, views, engagements, clicks,"
            " conversions FROM posts WHERE workspace_id = ? AND platform = ?"
            " ORDER BY created_at DESC, rowid DESC",
            (workspace_id, platform))}
        cands = [candidate(r["id"], r["external_id"], r["external_url"], r["content"]) for r in rows.values()]
        used: set[str] = set()
        matched = created = snapshots = 0
        for p in req.posts:
            pid = find_match(cands, external_id=p.external_id, url=p.url, content=p.content, used=used)
            if pid:
                used.add(pid)
                matched += 1
                _update_post(conn, workspace_id, platform, rows[pid], p, now_dt)
            else:
                created += 1
                pid = _insert_post(conn, workspace_id, platform, p, now_dt)
            _snapshot(conn, workspace_id, platform, pid, req.source, now, views=p.views,
                      engagements=p.engagements, clicks=p.clicks, conversions=p.conversions)
            snapshots += 1

        acc = req.account
        if acc.numbers():
            _snapshot(conn, workspace_id, platform, None, req.source, now, followers=acc.followers,
                      period_days=req.period_days, views=acc.views, engagements=acc.engagements,
                      clicks=acc.clicks)
            snapshots += 1
        if acc.followers is not None:
            conn.execute("UPDATE connections SET followers = ? WHERE workspace_id = ? AND platform = ?",
                         (acc.followers, workspace_id, platform))
        conn.execute(
            "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts)"
            " VALUES (?,?,NULL,'harvested',?,?,1,?)",
            (new_id("e_"), workspace_id, platform, _event_detail(req), now),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"platform": platform, "source": req.source, "matched": matched, "created": created,
            "snapshots": snapshots, "captured_at": now}


# ---------------------------------------------------------------- read side

def list_snapshots(conn: sqlite3.Connection, workspace_id: str, platform: str | None,
                   limit: int) -> list[dict]:
    sql, args = "SELECT * FROM metric_snapshots WHERE workspace_id = ?", [workspace_id]
    if platform:
        sql, args = sql + " AND platform = ?", [*args, platform]
    rows = conn.execute(sql + " ORDER BY captured_at DESC, rowid DESC LIMIT ?", (*args, limit)).fetchall()
    return [dict(r) for r in rows]


def harvest_status(conn: sqlite3.Connection, workspace_id: str) -> list[dict]:
    """One entry per platform (PLATFORMS order): connection, last harvest and what is real so far."""
    conns = {r["platform"]: r for r in conn.execute(
        "SELECT platform, status, profile_url FROM connections WHERE workspace_id = ?", (workspace_id,))}
    snaps = {r["platform"]: r["n"] for r in conn.execute(
        "SELECT platform, COUNT(*) AS n FROM metric_snapshots WHERE workspace_id = ? GROUP BY platform",
        (workspace_id,))}
    real = {r["platform"]: r["n"] for r in conn.execute(
        "SELECT platform, COUNT(*) AS n FROM posts WHERE workspace_id = ? AND metrics_source = 'real'"
        " GROUP BY platform", (workspace_id,))}
    out = []
    for p in live_platforms():
        last = conn.execute(
            "SELECT captured_at, source FROM metric_snapshots WHERE workspace_id = ? AND platform = ?"
            " ORDER BY captured_at DESC, rowid DESC LIMIT 1", (workspace_id, p)).fetchone()
        fol = conn.execute(
            "SELECT followers FROM metric_snapshots WHERE workspace_id = ? AND platform = ?"
            " AND post_id IS NULL AND followers IS NOT NULL ORDER BY captured_at DESC, rowid DESC LIMIT 1",
            (workspace_id, p)).fetchone()
        c = conns.get(p)
        out.append({
            "platform": p, "connected": c is not None and c["status"] == "connected",
            "profile_url": c["profile_url"] if c else None,
            "last_harvest_at": last["captured_at"] if last else None,
            "last_source": last["source"] if last else None,
            "followers": fol["followers"] if fol else None,
            "real_posts": real.get(p, 0), "snapshots": snaps.get(p, 0),
        })
    return out
