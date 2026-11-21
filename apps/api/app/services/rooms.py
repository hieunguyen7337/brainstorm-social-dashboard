"""Room mode: a presenter shows two AI-written posts on a big screen, the crowd votes from their phones.

Data model (no tables of its own, see docs/CONTRACT.md): `rooms` and `room_votes`. A scan is a `room_votes`
row with `choice = ''`; a vote sets `choice` to 'a' or 'b'; `onboarded = 1` marks the "Get started" tap.
Every request does a handful of small queries, so ~150 phones fit on one SQLite file.
"""

import copy
import random
import re
import secrets
import sqlite3
import time
from datetime import UTC, datetime

from app.config import settings
from app.db import new_id, now_iso
from app.models import Post
from app.qr import qr_svg  # noqa: F401  (re-exported: rooms and tests import it from here)
from app.routes.links import _record
from app.services import ai
from app.services import posts as posts_svc

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no I, L, O, 0, 1: easy to read off a big screen
CODE_LENGTH = 6
DEFAULT_TITLE = "Which post would you click?"
DEFAULT_THEME_COLOR = "#7C5CFF"
CONTENT_LIMIT = 700
RECENT_LIMIT = 8
STATS_TTL = 0.5  # seconds; read at call time so tests can set it to 0
VOTER_COOKIE = "pv"
VOTER_MAX_AGE = 24 * 3600
CHOICES = ("a", "b")

_VOTER_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_SCANNED_CAP = 100_000
_scanned: set[tuple[str, str]] = set()  # (room_id, voter) pairs whose scan row is known to exist
_stats_cache: dict[str, tuple[float, dict]] = {}  # room code -> (monotonic time, stats)


class RoomError(Exception):
    """A request problem the routes turn into `{"detail": ...}` with `status_code`."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


# ---------------------------------------------------------------- urls, codes, voter cookie


def public_base() -> str:
    return settings.public_base_url.rstrip("/")


def join_url(code: str) -> str:
    return f"{public_base()}/v/{code}"


def screen_url(code: str) -> str:
    return f"{public_base()}/room/{code}"


def display_url(url: str) -> str:
    """The URL without its scheme, for reading off a big screen."""
    return url.split("://", 1)[-1]


def normalise_code(code: str) -> str:
    return code.strip().upper()


def new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def voter_from_request(request) -> tuple[str, bool]:
    """The `pv` cookie value and False, or a fresh random token and True when the cookie is missing."""
    raw = request.cookies.get(VOTER_COOKIE, "")
    if _VOTER_RE.match(raw):
        return raw, False
    return secrets.token_urlsafe(12), True


def set_voter_cookie(response, voter: str) -> None:
    response.set_cookie(
        VOTER_COOKIE, voter, max_age=VOTER_MAX_AGE, path="/", httponly=True, samesite="lax"
    )


# ---------------------------------------------------------------- reading rooms


def find_room(conn: sqlite3.Connection, code: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM rooms WHERE code = ?", (normalise_code(code),)).fetchone()


def require_room(conn: sqlite3.Connection, code: str) -> sqlite3.Row:
    room = find_room(conn, code)
    if room is None:
        raise RoomError(404, "room not found")
    return room


def clip_text(text: str, limit: int = CONTENT_LIMIT) -> str:
    """At most `limit` characters, cut at a word boundary and ending in "..." when clipped."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 3]
    if not text[limit - 3].isspace():
        partial = re.search(r"\s+\S*$", cut)
        if partial is not None and partial.start() > 0:
            cut = cut[: partial.start()]
    return f"{cut.rstrip()}..."


def room_variants(conn: sqlite3.Connection, room: sqlite3.Row) -> list[dict]:
    """The two variants (A then B) the crowd sees. A deleted post shows up with empty text."""
    ids = [pid for pid in (room["post_a"], room["post_b"]) if pid]
    by_id: dict[str, sqlite3.Row] = {}
    if ids:
        marks = ",".join("?" * len(ids))
        rows = conn.execute(
            "SELECT p.id, p.platform, p.content, p.media_prompt, t.name AS theme_name, t.color AS theme_color"
            f" FROM posts p LEFT JOIN themes t ON t.id = p.theme_id WHERE p.id IN ({marks})",
            ids,
        ).fetchall()
        by_id = {r["id"]: r for r in rows}
    out = []
    for choice, post_id in zip(CHOICES, (room["post_a"], room["post_b"]), strict=True):
        row = by_id.get(post_id) if post_id else None
        out.append(
            {
                "choice": choice,
                "platform": row["platform"] if row else "linkedin",
                "content": clip_text(row["content"]) if row else "",
                "theme": (row["theme_name"] or "") if row else "",
                "theme_color": (row["theme_color"] or DEFAULT_THEME_COLOR) if row else DEFAULT_THEME_COLOR,
                "media_prompt": row["media_prompt"] if row else "",
            }
        )
    return out


def room_public(conn: sqlite3.Connection, room: sqlite3.Row) -> dict:
    """The public room JSON. Never carries the workspace id or token."""
    return {
        "code": room["code"],
        "title": room["title"],
        "status": room["status"],
        "variants": room_variants(conn, room),
    }


def fresh_votes(conn: sqlite3.Connection, room_id: str) -> dict[str, int]:
    row = conn.execute(
        "SELECT COALESCE(SUM(choice = 'a'), 0) AS a, COALESCE(SUM(choice = 'b'), 0) AS b"
        " FROM room_votes WHERE room_id = ?",
        (room_id,),
    ).fetchone()
    return {"a": int(row["a"]), "b": int(row["b"])}


def voter_state(conn: sqlite3.Connection, room_id: str, voter: str) -> tuple[str | None, bool]:
    """(choice 'a'/'b' or None, onboarded) for this voter."""
    row = conn.execute(
        "SELECT choice, onboarded FROM room_votes WHERE room_id = ? AND voter = ?", (room_id, voter)
    ).fetchone()
    if row is None:
        return None, False
    return (row["choice"] if row["choice"] in CHOICES else None), bool(row["onboarded"])


# ---------------------------------------------------------------- crowd actions


def _remember_scan(room_id: str, voter: str) -> None:
    if len(_scanned) >= _SCANNED_CAP:
        _scanned.clear()
    _scanned.add((room_id, voter))


def record_scan(conn: sqlite3.Connection, room_id: str, voter: str) -> None:
    """Counts a scan once per voter: a `room_votes` row with an empty choice."""
    if (room_id, voter) in _scanned:
        return
    conn.execute(
        "INSERT OR IGNORE INTO room_votes (room_id, voter, choice, onboarded, created_at)"
        " VALUES (?, ?, '', 0, ?)",
        (room_id, voter, now_iso()),
    )
    conn.commit()
    _remember_scan(room_id, voter)


def _post_row(conn: sqlite3.Connection, post_id: str | None) -> sqlite3.Row | None:
    if not post_id:
        return None
    return conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()


def cast_vote(conn: sqlite3.Connection, room: sqlite3.Row, voter: str, choice: str) -> dict:
    """One vote per voter, re-voting switches. A real click is recorded whenever the stored choice changes."""
    if room["status"] != "open":
        raise RoomError(409, "voting is closed")
    if choice not in CHOICES:
        raise RoomError(422, "choice must be 'a' or 'b'")
    # One atomic statement: insert the voter, or switch their choice. rowcount is 0 on a repeated choice.
    cur = conn.execute(
        "INSERT INTO room_votes (room_id, voter, choice, onboarded, created_at) VALUES (?, ?, ?, 0, ?)"
        " ON CONFLICT (room_id, voter) DO UPDATE SET choice = excluded.choice,"
        " created_at = excluded.created_at WHERE room_votes.choice != excluded.choice",
        (room["id"], voter, choice, now_iso()),
    )
    changed = cur.rowcount == 1
    post = _post_row(conn, room["post_a"] if choice == "a" else room["post_b"]) if changed else None
    if post is not None:
        _record(conn, post, "click")  # commits the vote and the click together
    else:
        conn.commit()
    _remember_scan(room["id"], voter)
    return {"ok": True, "choice": choice, "votes": fresh_votes(conn, room["id"])}


def onboard(conn: sqlite3.Connection, room: sqlite3.Row, voter: str) -> dict:
    """Marks the voter onboarded once and records one real conversion on their chosen post."""
    rows = conn.execute(
        "UPDATE room_votes SET onboarded = 1 WHERE room_id = ? AND voter = ? AND onboarded = 0"
        " AND choice IN ('a', 'b') RETURNING choice",
        (room["id"], voter),
    ).fetchall()  # fetchall drains the statement so the commit below is not blocked
    if rows:
        post = _post_row(conn, room["post_a"] if rows[0]["choice"] == "a" else room["post_b"])
        if post is not None:
            _record(conn, post, "conversion")  # commits
        else:
            conn.commit()
    else:
        conn.rollback()
        choice, _ = voter_state(conn, room["id"], voter)
        if choice is None:
            raise RoomError(400, "vote first")
    return {"ok": True, "onboarded": True}


# ---------------------------------------------------------------- stats


def _seconds_since(ts: str) -> int:
    try:
        then = datetime.fromisoformat(ts)
    except ValueError:
        return 0
    if then.tzinfo is None:
        then = then.replace(tzinfo=UTC)
    return max(0, int((datetime.now(UTC) - then).total_seconds()))


def _winner(conn: sqlite3.Connection, room: sqlite3.Row, votes: dict[str, int]) -> dict:
    """The current leader. No votes or a tie: no choice (a tie reports a 0.5 share)."""
    total = votes["a"] + votes["b"]
    if total == 0:
        return {"choice": None, "theme": None, "share": 0}
    if votes["a"] == votes["b"]:
        return {"choice": None, "theme": None, "share": 0.5}
    choice = "a" if votes["a"] > votes["b"] else "b"
    leader = room_variants(conn, room)[0 if choice == "a" else 1]
    return {"choice": choice, "theme": leader["theme"] or None, "share": votes[choice] / total}


def _compute_stats(conn: sqlite3.Connection, room: sqlite3.Row) -> dict:
    row = conn.execute(
        "SELECT COUNT(*) AS scans, COALESCE(SUM(choice = 'a'), 0) AS a, COALESCE(SUM(choice = 'b'), 0) AS b,"
        " COALESCE(SUM(onboarded), 0) AS onboarded FROM room_votes WHERE room_id = ?",
        (room["id"],),
    ).fetchone()
    votes = {"a": int(row["a"]), "b": int(row["b"])}
    total = votes["a"] + votes["b"]
    recent_rows = conn.execute(
        "SELECT choice, created_at FROM room_votes WHERE room_id = ? AND choice IN ('a', 'b')"
        " ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (room["id"], RECENT_LIMIT),
    ).fetchall()
    return {
        "status": room["status"],
        "scans": int(row["scans"]),
        "votes": votes,
        "onboarded": int(row["onboarded"]),
        "funnel": {
            "views": int(row["scans"]),
            "engage": total,
            "click": total,
            "onboard": int(row["onboarded"]),
        },
        "winner": _winner(conn, room, votes),
        "recent": [
            {"choice": r["choice"], "at": r["created_at"], "ago": _seconds_since(r["created_at"])}
            for r in recent_rows
        ],
    }


def stats_for_room(conn: sqlite3.Connection, room: sqlite3.Row) -> dict:
    """Fresh stats for `room`, remembered for STATS_TTL seconds. Always returns a copy."""
    stats = _compute_stats(conn, room)
    if STATS_TTL > 0:
        _stats_cache[room["code"]] = (time.monotonic(), stats)
    return copy.deepcopy(stats)


def stats_for_code(conn: sqlite3.Connection, code: str) -> dict:
    """Stats by room code. A cache hit costs no query at all (the cache only holds existing rooms)."""
    key = normalise_code(code)
    if STATS_TTL > 0:
        hit = _stats_cache.get(key)
        if hit is not None and time.monotonic() - hit[0] < STATS_TTL:
            return copy.deepcopy(hit[1])
    return stats_for_room(conn, require_room(conn, key))


def forget_stats(code: str) -> None:
    _stats_cache.pop(normalise_code(code), None)


# ---------------------------------------------------------------- closing


def _insight_body(votes: dict[str, int], choice: str, variants: list[dict]) -> str:
    total = votes["a"] + votes["b"]
    leader, other = (variants[0], variants[1]) if choice == "a" else (variants[1], variants[0])
    theme = leader["theme"]
    pct = round(100 * votes[choice] / total)
    tail = f' over "{other["theme"]}"' if other["theme"] and other["theme"] != theme else " over the other post"
    noun = "vote" if total == 1 else "votes"
    return f'Room vote ({total} {noun}): the crowd preferred "{theme}" ({pct}%){tail}.'


def _apply_winner(conn: sqlite3.Connection, room: sqlite3.Row) -> None:
    """On the first close with a clear winner: remember the winning theme as an insight and a post theme."""
    votes = fresh_votes(conn, room["id"])
    if votes["a"] == votes["b"]:
        return
    choice = "a" if votes["a"] > votes["b"] else "b"
    winner = _post_row(conn, room["post_a"] if choice == "a" else room["post_b"])
    if winner is None or not winner["theme_id"]:
        return
    variants = room_variants(conn, room)
    share = votes[choice] / (votes["a"] + votes["b"])
    now = now_iso()
    conn.execute(
        "INSERT OR IGNORE INTO insights (workspace_id, body, created_at) VALUES (?, ?, ?)",
        (room["workspace_id"], _insight_body(votes, choice, variants), now),
    )
    conn.execute(
        "INSERT INTO post_themes (post_id, theme_id, confidence, classifier, created_at)"
        " VALUES (?, ?, ?, 'room', ?)"
        " ON CONFLICT (post_id, theme_id) DO UPDATE SET confidence = excluded.confidence, classifier = 'room'",
        (winner["id"], winner["theme_id"], share, now),
    )


def close_room(conn: sqlite3.Connection, room: sqlite3.Row) -> dict:
    """Closes voting (idempotent) and returns fresh stats. Only the first close writes anything else."""
    cur = conn.execute("UPDATE rooms SET status = 'closed' WHERE id = ? AND status = 'open'", (room["id"],))
    if cur.rowcount == 1:
        _apply_winner(conn, room)
    conn.commit()
    forget_stats(room["code"])
    return stats_for_room(conn, require_room(conn, room["code"]))


# ---------------------------------------------------------------- creating


def _qualifying_drafts(conn: sqlite3.Connection, workspace_id: str) -> list[sqlite3.Row]:
    """The newest LinkedIn drafts with two different non-null themes (at most two, newest first)."""
    rows = conn.execute(
        "SELECT * FROM posts WHERE workspace_id = ? AND platform = 'linkedin' AND status = 'draft'"
        " AND theme_id IS NOT NULL ORDER BY created_at DESC, rowid DESC",
        (workspace_id,),
    ).fetchall()
    picked: list[sqlite3.Row] = []
    for row in rows:
        if not picked or row["theme_id"] != picked[0]["theme_id"]:
            picked.append(row)
        if len(picked) == 2:
            break
    return picked


def _generate_draft(
    conn: sqlite3.Connection, ws: sqlite3.Row, theme: sqlite3.Row | None, brief: str
) -> Post:
    """One LinkedIn draft for `theme` (AI when allowed, templates otherwise; never raises for AI problems)."""
    variants, _ai_used = ai.generate_variants(conn, ws, platforms=["linkedin"], theme=theme, brief=brief)
    saved = ai.save_variants(
        conn, ws, variants[:1],
        batch_id=new_id("b"), theme_id=theme["id"] if theme else None, trend_id=None,
        source="ai", status="draft",
    )
    return saved[0]


def _owned_post(conn: sqlite3.Connection, ws: sqlite3.Row, post_id: str) -> sqlite3.Row:
    row = posts_svc.get_post_row(conn, ws["id"], post_id)
    if row is None:
        raise RoomError(404, "post not found")
    return row


def _choose_posts(
    conn: sqlite3.Connection, ws: sqlite3.Row, post_a: str | None, post_b: str | None, brief: str
) -> list[Post]:
    """The two posts for a new room: the caller's own, else reused drafts, else freshly generated ones."""
    if bool(post_a) != bool(post_b):
        raise RoomError(400, "give both post_a and post_b, or neither")
    if post_a and post_b:
        if post_a == post_b:
            raise RoomError(400, "pick two different posts")
        return [posts_svc.row_to_post(conn, _owned_post(conn, ws, pid)) for pid in (post_a, post_b)]

    drafts = _qualifying_drafts(conn, ws["id"])
    if len(drafts) == 2:
        return [posts_svc.row_to_post(conn, row) for row in drafts]

    themes = conn.execute(
        "SELECT * FROM themes WHERE workspace_id = ? AND active = 1 ORDER BY created_at, id", (ws["id"],)
    ).fetchall()
    if drafts:  # one draft qualifies: keep it and generate the other with a different theme
        kept = drafts[0]
        others = [t for t in themes if t["id"] != kept["theme_id"]]
        fresh = _generate_draft(conn, ws, random.choice(others) if others else None, brief)
        pair = [posts_svc.row_to_post(conn, kept), fresh]
        random.shuffle(pair)  # no fixed "A is the old one" bias
        return pair
    picks: list[sqlite3.Row | None] = (
        random.sample(themes, 2) if len(themes) >= 2 else [*themes, None, None][:2]  # pad with "no theme"
    )
    return [_generate_draft(conn, ws, theme, brief) for theme in picks]


def create_room(
    conn: sqlite3.Connection,
    ws: sqlite3.Row,
    *,
    title: str = "",
    post_a: str | None = None,
    post_b: str | None = None,
    brief: str = "",
) -> dict:
    """Creates an open room for the workspace and returns the creation payload (see routes/rooms.py)."""
    posts = _choose_posts(conn, ws, post_a or None, post_b or None, brief.strip())
    title = title.strip() or DEFAULT_TITLE
    room_id = new_id("rm_")
    for _ in range(25):
        code = new_code()
        try:
            conn.execute(
                "INSERT INTO rooms (id, code, workspace_id, title, post_a, post_b, status, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, 'open', ?)",
                (room_id, code, ws["id"], title, posts[0].id, posts[1].id, now_iso()),
            )
        except sqlite3.IntegrityError as exc:
            conn.rollback()
            if "rooms.code" not in str(exc):
                raise
            continue
        conn.commit()
        break
    else:
        raise RoomError(500, "could not allocate a room code")
    screen = screen_url(code)
    return {
        "id": room_id,
        "code": code,
        "title": title,
        "status": "open",
        "join_url": join_url(code),
        "screen_url": screen,
        "presenter_url": f"{screen}?token={ws['token']}",
        "post_a": posts[0].id,
        "post_b": posts[1].id,
        "posts": posts,
    }
