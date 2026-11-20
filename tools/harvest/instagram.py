"""Instagram harvest: read the user's OWN profile and posts from their already-logged-in Chrome.

Two layers, kept apart on purpose:

* Pure parsers (`profile_username`, `normalise_profile_url`, `insights_url`, `looks_logged_out`,
  `parse_profile`, `parse_post_page`, `parse_insights`, `build_payload`): str in, data out, no I/O, no
  clock, standard library only. These are unit-tested against hand-written HTML fixtures.
* `harvest(context, profile_url, ...)`: a small, defensive driver. `context` is a Playwright sync
  BrowserContext of the user's running Chrome; this module never imports Playwright and never closes the
  context. It only navigates (profile, that profile's own posts, the insights page) and reads
  `page.content()`: it never types, clicks, likes, comments, follows or posts.

The payload returned by `build_payload` / `harvest` is the body of POST /api/metrics/ingest minus
`platform` and `source`: {"account": {...ints...}, "posts": [{"external_id", "url", "content"?,
"posted_at"?, "views", "engagements"}]}. Unknown numbers are omitted, never guessed (except that a post
with no known views/engagements gets 0, because the ingest body needs both).

IMPORTANT: every selector and text pattern below is modelled on Instagram's web markup from memory and
hand-written fixtures. Nothing here has been checked against a live page. Instagram changes its markup
often, so expect to adjust the regexes after a first real run.
"""

from __future__ import annotations

import json
import math
import re
import time
from datetime import UTC, datetime
from html.parser import HTMLParser
from urllib.parse import urlparse

try:  # works both as a package module and when the script dir itself is on sys.path
    from . import common
except ImportError:
    import common

__all__ = [
    "MAX_POSTS",
    "build_payload",
    "harvest",
    "insights_url",
    "looks_logged_out",
    "normalise_profile_url",
    "parse_insights",
    "parse_post_page",
    "parse_profile",
    "profile_username",
]

BASE = "https://www.instagram.com"
MAX_POSTS = 12  # hard cap per run (human pace); a larger max_posts is clamped to this
GRID_CONTENT_MAX = 300  # grid alt text is a loose caption at best
POST_CONTENT_MAX = 2200  # Instagram's own caption limit
NAV_TIMEOUT_MS = 45_000
SETTLE_TIMEOUT_MS = 8_000

_HOSTS = frozenset({"instagram.com", "www.instagram.com", "m.instagram.com"})
_RESERVED = frozenset(
    {
        "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "legal",
        "developer", "web", "challenge", "api", "oauth", "login", "emailsignup", "privacy", "press",
        "directory", "topics", "locations", "tags", "s", "download", "nametag",
    }
)  # fmt: skip
_USER_RE = re.compile(r"[A-Za-z0-9._]{1,30}")

# A number as Instagram prints it: 1,234 / 12.3K / 1.2M. Not followed by '%' (growth deltas).
_NUM = r"(\d[\d.,]*[KkMmBb]?)(?![\d.,]*\s*%)"
_LIKES = re.compile(rf"{_NUM}\s+likes?\b", re.IGNORECASE)
_COMMENTS = re.compile(rf"{_NUM}\s+comments?\b", re.IGNORECASE)
_PLAYS = re.compile(rf"{_NUM}\s+(?:plays?|views?)\b", re.IGNORECASE)
_STAT_FRAG = re.compile(rf"{_NUM}\s+(?:likes?|comments?|plays?|views?)\b", re.IGNORECASE)
_LIKES_SEG = re.compile(rf"{_NUM}\s+likes?", re.IGNORECASE)
_COMMENTS_SEG = re.compile(rf"(?:view(?:\s+all)?\s+)?{_NUM}\s+comments?", re.IGNORECASE)
_PLAYS_SEG = re.compile(rf"{_NUM}\s+(?:plays?|views?)", re.IGNORECASE)
_LIKED_BY = re.compile(rf"liked\s+by\s+(.{{1,200}}?)\s+and\s+{_NUM}\s+others?\b", re.IGNORECASE | re.DOTALL)
_VIEWS_LINE = re.compile(rf"^views\s*:?\s*{_NUM}\s*$", re.IGNORECASE | re.MULTILINE)
_SEG_SEP = re.compile(r"\s*[·•|]\s*|,\s+")

_OG_FOLLOWERS = re.compile(rf"{_NUM}\s+followers?\b", re.IGNORECASE)
_OG_FOLLOWING = re.compile(rf"{_NUM}\s+following\b", re.IGNORECASE)
_OG_POSTS = re.compile(rf"{_NUM}\s+posts?\b", re.IGNORECASE)
_HDR_FOLLOWERS = re.compile(rf"{_NUM}\s+followers?", re.IGNORECASE)
_HDR_FOLLOWING = re.compile(rf"{_NUM}\s+following", re.IGNORECASE)
_HDR_POSTS = re.compile(rf"{_NUM}\s+posts?", re.IGNORECASE)

_SHORT = re.compile(r"/(?:[A-Za-z0-9._]+/)?(p|reel)/([A-Za-z0-9_-]{5,})(?:/|$)")
_GRID_HREF = re.compile(r"^/(?:([A-Za-z0-9._]+)/)?(p|reel)/([A-Za-z0-9_-]{5,})/?$")
_QUOTED = re.compile(r':\s*[“"](.*)[”"]\.?\s*$', re.DOTALL)
_ALT_BOILER = re.compile(
    r"^(?:Photo|Video|Reel|Image)s?\s+(?:shared\s+)?by\s+.{1,80}?\s+on\s+[A-Z][a-z]+ \d{1,2}, \d{4}\.?\s*"
)
_ALT_AUTO = re.compile(
    r"\s*May be (?:an? )?(?:image|selfie|illustration|closeup|close-up|meme)\b.*$", re.DOTALL
)
_PRO_LABELS = frozenset(
    {"insights", "view insights", "professional dashboard", "view professional dashboard"}
)
_GENERIC_LABELS = frozenset(
    {"clip", "reel", "video", "carousel", "photo", "image", "pinned", "multiple photos"}
)

_ACCOUNT_KEYS = ("followers", "views", "engagements", "clicks", "profile_views")
_INSIGHT_LABELS = {
    "profile_views": [r"profile\s+visits", r"profile\s+views", r"profile\s+activity"],
    "views": [r"(?<!profile )(?<!post )views", r"impressions"],
    "engagements": [r"interactions", r"accounts\s+engaged"],
    "clicks": [r"link\s+taps", r"website\s+taps", r"link\s+clicks", r"website\s+clicks"],
    "followers": [r"total\s+followers", r"followers"],
}
_REACH_LABELS = (r"impressions", r"accounts\s+reached", r"reach")


# ---------------------------------------------------------------------------------------------------
# small helpers


def _as_int(value) -> int | None:
    """A non-negative plain int, or None (bools, NaN, negatives and non-numbers are dropped)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        n = value
    elif isinstance(value, float):
        if not math.isfinite(value):
            return None
        n = round(value)
    else:
        n = common.parse_count(str(value))
        if n is None:
            return None
    return n if n >= 0 else None


def _trim(text: str, limit: int) -> str:
    """At most `limit` characters, cut on a word boundary when one is close, with a trailing ellipsis."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    space = cut.rfind(" ")
    if space >= limit - 40:
        cut = cut[:space]
    return cut.rstrip(" ,;:-") + "…"


def _text(html: str) -> str:
    try:
        return common.html_to_text(html) if html.strip() else ""
    except Exception:  # noqa: BLE001 - garbage HTML must never raise out of a parser
        return ""


def _count(rx: re.Pattern, text: str) -> int | None:
    """Largest count matched by `rx` (group 1) anywhere in `text`."""
    vals = [common.parse_count(m.group(1)) for m in rx.finditer(text)]
    vals = [v for v in vals if v is not None]
    return max(vals) if vals else None


def _first(*values):
    for v in values:
        if v is not None:
            return v
    return None


def _iso(value) -> str | None:
    """ISO-8601 string with offset from a `<time datetime>` / JSON-LD value; None if unusable.
    Date-only values are rejected (no time of day to report); naive times are taken as UTC."""
    v = common.clean(value if isinstance(value, str) else "")
    if "T" not in v:
        return None
    try:
        dt = datetime.fromisoformat(v)  # 3.11+ accepts a trailing Z
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.isoformat()


def _shortcode_of(url) -> tuple[str, str] | None:
    """('p'|'reel', shortcode) from an Instagram post/reel URL or path; None otherwise."""
    if not url or not isinstance(url, str):
        return None
    u = urlparse(url.strip())
    if u.netloc and (u.hostname or "").lower() not in _HOSTS:
        return None
    m = _SHORT.search(u.path)
    return (m.group(1), m.group(2)) if m else None


def _post_url(kind: str, code: str) -> str:
    return f"{BASE}/{kind}/{code}/"


# ---------------------------------------------------------------------------------------------------
# URLs


def profile_username(profile_url: str | None) -> str | None:
    """Lower-case username from a profile URL or '@name' / bare 'name'; None if there is none.

    Works with trailing slashes, query strings, and sub-pages such as /name/reels/ or /name/tagged/.
    Non-Instagram hosts and reserved first segments (/p/, /reel/, /explore/, /accounts/ ...) give None."""
    s = (profile_url or "").strip() if isinstance(profile_url, str) else ""
    if not s:
        return None
    s = s.removeprefix("@")
    host_prefixed = s.lower().startswith(("instagram.com", "www.instagram.com", "m.instagram.com"))
    if "://" in s or host_prefixed:
        u = urlparse(s if "://" in s else "https://" + s)
        if (u.hostname or "").lower() not in _HOSTS:
            return None
        segs = [x for x in u.path.split("/") if x]
        first = segs[0] if segs else ""
    else:  # a bare 'name' / 'name/'; anything with more path segments is ambiguous, so refuse it
        rest = s.split("?")[0].split("#")[0].strip("/")
        first = "" if "/" in rest else rest
    if not first or first.lower() in _RESERVED or not _USER_RE.fullmatch(first):
        return None
    return first.lower()


def normalise_profile_url(url: str) -> str:
    """`https://www.instagram.com/<user>/` for any profile-ish input. Raises common.HarvestError when no
    username can be found (for example a post URL or a non-Instagram link)."""
    user = profile_username(url)
    if not user:
        raise common.HarvestError(f"could not find an Instagram username in {url!r}")
    return f"{BASE}/{user}/"


def insights_url() -> str:
    """Best-effort professional-account insights page (it may not exist for every account)."""
    return f"{BASE}/accounts/insights/"


# ---------------------------------------------------------------------------------------------------
# one-pass HTML scan (meta tags, links, controls, <time>, h1, caption block, JSON-LD)

_VOID = frozenset(
    [
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    ]
)


class _Page(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.links: dict[str, str] = {}
        self.title = ""
        self.anchors: list[dict] = []
        self.controls: list[str] = []  # visible label of every <a> / <button>
        self.times: list[str] = []
        self.h1: list[str] = []
        self.captions: list[str] = []
        self.jsonld: list[str] = []
        self.has_password = False
        self._cur: dict | None = None
        self._cap: list | None = None  # [depth, text parts]
        self._h1: list[str] | None = None
        self._ld: list[str] | None = None
        self._in_title = False
        self._title_done = False
        self._script = False
        self._svg = 0

    # -- helpers
    def _open(self, tag: str, at: dict) -> None:
        if self._cur is not None:
            self._close()
        labels = [v for v in (at.get("aria-label"), at.get("title")) if v]
        self._cur = {"tag": tag, "href": at.get("href", ""), "labels": labels, "alts": [], "text": []}

    def _close(self) -> None:
        cur, self._cur = self._cur, None
        if cur is None:
            return
        cur["text"] = common.clean(" ".join(cur["text"]))
        if cur["tag"] == "a":
            self.anchors.append(cur)
        label = cur["text"] or (cur["labels"][0] if cur["labels"] else "")
        if label:
            self.controls.append(common.clean(label))

    @staticmethod
    def _is_caption(at: dict) -> bool:
        return any("caption" in at.get(k, "").lower() for k in ("data-testid", "class", "id", "itemprop"))

    def _end_caption(self) -> None:
        if self._cap is not None:
            text = common.clean(" ".join(self._cap[1]))
            if text:
                self.captions.append(text)
            self._cap = None

    # -- HTMLParser hooks
    def handle_starttag(self, tag, attrs):
        at = {k.lower(): (v or "") for k, v in attrs}
        void = tag in _VOID
        if self._cap is not None and not void:
            self._cap[0] += 1
        if tag == "svg":
            self._svg += 1
        elif tag == "title" and not self._svg and not self._title_done:
            self._in_title = True
        elif tag == "meta":
            key = (at.get("property") or at.get("name") or "").lower()
            if key and "content" in at:
                self.meta.setdefault(key, at["content"])
        elif tag == "link":
            rel = at.get("rel", "").lower()
            if rel and at.get("href"):
                self.links.setdefault(rel, at["href"])
        elif tag == "input":
            if at.get("type", "").lower() == "password" or at.get("name", "").lower() == "password":
                self.has_password = True
        elif tag == "time":
            if at.get("datetime"):
                self.times.append(at["datetime"])
        elif tag == "h1":
            self._h1 = []
        elif tag in ("script", "style"):
            self._script = True
            if tag == "script" and "ld+json" in at.get("type", "").lower():
                self._ld = []
        elif tag in ("a", "button"):
            self._open(tag, at)
        if self._cur is not None and tag not in ("a", "button"):
            if tag == "img":
                self._cur["alts"].append(at.get("alt", ""))
            if at.get("aria-label"):
                self._cur["labels"].append(at["aria-label"])
        if self._cap is None and not self.captions and not void and self._is_caption(at):
            self._cap = [1, []]

    def handle_endtag(self, tag):
        if tag in _VOID:
            return
        if tag == "svg":
            self._svg = max(0, self._svg - 1)
        elif tag == "title" and self._in_title:
            self._in_title = False
            self._title_done = True
        elif tag == "h1" and self._h1 is not None:
            text = common.clean(" ".join(self._h1))
            if text:
                self.h1.append(text)
            self._h1 = None
        elif tag in ("script", "style"):
            self._script = False
            if self._ld is not None:
                self.jsonld.append("".join(self._ld))
                self._ld = None
        elif tag in ("a", "button") and self._cur is not None and self._cur["tag"] == tag:
            self._close()
        if self._cap is not None:
            self._cap[0] -= 1
            if self._cap[0] <= 0:
                self._end_caption()

    def handle_data(self, data):
        if self._ld is not None:
            self._ld.append(data)
            return
        if self._script:
            return
        if self._in_title:
            self.title += data
        if self._h1 is not None:
            self._h1.append(data)
        if self._cur is not None:
            self._cur["text"].append(data)
        if self._cap is not None:
            self._cap[1].append(data)

    def finish(self) -> None:
        self._close()
        self._end_caption()


def _scan(html: str) -> _Page:
    page = _Page()
    try:
        page.feed(html)
        page.close()
    except Exception:  # noqa: BLE001, S110 - garbage in -> whatever was collected so far
        pass
    page.finish()
    return page


# ---------------------------------------------------------------------------------------------------
# login detection


def looks_logged_out(url: str | None, html: str | None) -> bool:
    """True when the browser is on a login/sign-up page or a logged-out wall, False for a normal
    logged-in profile (and for empty/garbage input, where there is nothing to conclude)."""
    path = urlparse(url).path.lower() if isinstance(url, str) and url else ""
    if "/accounts/login" in path or "/accounts/emailsignup" in path:
        return True
    if not isinstance(html, str) or not html.strip():
        return False
    page = _scan(html)
    if page.has_password:
        return True
    text = _text(html).lower()
    if any(
        s in text
        for s in (
            "log in to see photos and videos",
            "log in to instagram",
            "log into instagram",
            "sign up to see photos and videos",
        )
    ):
        return True
    labels = {c.lower() for c in page.controls}
    wall = ("log in" in labels or "log in with facebook" in labels) and "sign up" in labels
    if wall:
        # A logged-in session has the messages/inbox or account-edit links; the logged-out bar does not.
        member = any(
            (
                "/direct/inbox" in a["href"]
                or "/accounts/edit" in a["href"]
                or "/accounts/activity" in a["href"]
            )
            for a in page.anchors
        )
        return not member
    return False


# ---------------------------------------------------------------------------------------------------
# stats text helpers


def _stats(text: str) -> dict:
    return {
        "likes": _count(_LIKES, text),
        "comments": _count(_COMMENTS, text),
        "plays": _count(_PLAYS, text),
    }


def _visible_stats(text: str) -> dict:
    """Likes/comments/plays from visible page text. Only stand-alone fragments count ('1,234 likes',
    'View all 56 comments', '12,345 plays'): a comment row such as '2d 3 likes Reply' does not. The
    largest value wins, because a post's own numbers are never smaller than a comment's."""
    found: dict[str, list[int]] = {"likes": [], "comments": [], "plays": []}
    for line in text.splitlines():
        for seg in _SEG_SEP.split(line):
            seg = seg.strip()
            for key, rx in (("likes", _LIKES_SEG), ("comments", _COMMENTS_SEG), ("plays", _PLAYS_SEG)):
                m = rx.fullmatch(seg)
                if m:
                    n = common.parse_count(m.group(1))
                    if n is not None:
                        found[key].append(n)
    for m in _LIKED_BY.finditer(text):
        others = common.parse_count(m.group(2))
        if others is not None:
            named = [n for n in re.split(r",|\s+and\s+", m.group(1)) if n.strip()]
            found["likes"].append(others + max(1, len(named)))
    return {k: (max(v) if v else None) for k, v in found.items()}


def _reach(text: str) -> int | None:
    """Reach / impressions for photo posts (no public view count): label then number, or number then label."""
    for lab in _REACH_LABELS:
        m = re.search(rf"(?<!\w){lab}\b\s*[:\-]?\s*{_NUM}", text, re.IGNORECASE)
        if m:
            return common.parse_count(m.group(1))
        m = re.search(rf"{_NUM}\s+{lab}\b", text, re.IGNORECASE)
        if m:
            return common.parse_count(m.group(1))
    m = _VIEWS_LINE.search(text)
    return common.parse_count(m.group(1)) if m else None


def _quoted(text: str) -> str | None:
    m = _QUOTED.search(text or "")
    return common.clean(m.group(1)) if m and common.clean(m.group(1)) else None


def _jsonld(blobs: list[str]) -> dict:
    """Optional JSON-LD fallback: posted_at / content / likes / comments when such a block exists."""
    out: dict = {}

    def put(key, value):
        if value is not None and value != "":
            out.setdefault(key, value)

    for raw in blobs:
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        for node in data if isinstance(data, list) else [data]:
            if not isinstance(node, dict):
                continue
            put("posted_at", _iso(node.get("uploadDate") or node.get("datePublished")))
            cap = node.get("caption") or node.get("articleBody")
            put("content", common.clean(cap) if isinstance(cap, str) else None)
            put("comments", _as_int(node.get("commentCount")))
            stats = node.get("interactionStatistic") or []
            for st in stats if isinstance(stats, list) else [stats]:
                if not isinstance(st, dict):
                    continue
                kind = json.dumps(st.get("interactionType", "")).lower()
                n = _as_int(st.get("userInteractionCount"))
                if "like" in kind:
                    put("likes", n)
                elif "comment" in kind:
                    put("comments", n)
    return out


# ---------------------------------------------------------------------------------------------------
# profile page


def _clean_caption(raw: str, limit: int) -> str:
    """Caption-ish text from a grid alt/aria-label: drop 'N likes, M comments' fragments and Instagram's
    auto-generated 'Photo by X on <date>. May be an image of ...' description."""
    s = common.clean(raw)
    s = _ALT_BOILER.sub("", s, count=1)
    s = _ALT_AUTO.sub("", s)
    s = _STAT_FRAG.sub("", s)
    s = re.sub(r"(?:\s*[,;·•|]\s*){2,}", ", ", s)
    s = s.strip(" ,;·•|-")
    if s.lower() in _GENERIC_LABELS:
        return ""
    return _trim(s, limit)


def _infer_username(page: _Page) -> str | None:
    for key in (page.meta.get("og:url"), page.links.get("canonical")):
        user = profile_username(key) if key else None
        if user:
            return user
    for title in (page.meta.get("og:title", ""), page.title):
        m = re.search(r"\(@([A-Za-z0-9._]+)\)", title)
        if m:
            return m.group(1).lower()
    return None


def _grid_posts(page: _Page, username: str | None) -> list[dict]:
    order: list[str] = []
    posts: dict[str, dict] = {}
    for a in page.anchors:
        href = a["href"].strip()
        if not href:
            continue
        u = urlparse(href)
        if u.netloc and (u.hostname or "").lower() not in _HOSTS:
            continue
        m = _GRID_HREF.match(u.path)
        if not m:
            continue
        owner, kind, code = m.groups()
        if owner and username and owner.lower() != username.lower():
            continue  # somebody else's post (tagged / suggested): never ours to harvest
        blob = " ".join([*a["alts"], *a["labels"], a["text"]])
        st = _stats(blob)
        views = st["plays"]
        if views is None and kind == "reel":
            bare = re.fullmatch(_NUM, a["text"].strip())
            views = common.parse_count(bare.group(1)) if bare else None
        parts = [v for v in (st["likes"], st["comments"]) if v is not None]
        post: dict = {"external_id": code, "url": _post_url(kind, code)}
        for raw in [*a["alts"], *a["labels"]]:
            caption = _clean_caption(raw, GRID_CONTENT_MAX)
            if caption:
                post["content"] = caption
                break
        if views is not None:
            post["views"] = views
        if parts:
            post["engagements"] = sum(parts)
        if code in posts:  # duplicate anchor (pinned / repeated): keep the first, fill gaps only
            for k, v in post.items():
                posts[code].setdefault(k, v)
        else:
            posts[code] = post
            order.append(code)
    return [posts[c] for c in order]


def _is_professional(page: _Page, text: str) -> bool:
    if any(c.lower() in _PRO_LABELS for c in page.controls):
        return True
    if any("/accounts/insights" in a["href"] or "professional_dashboard" in a["href"] for a in page.anchors):
        return True
    return bool(re.search(r"\b(?:view insights|professional dashboard)\b", text, re.IGNORECASE))


def _first_count(rx: re.Pattern, *sources: str) -> int | None:
    for src in sources:
        m = rx.search(src)
        if m:
            n = common.parse_count(m.group(1))
            if n is not None:
                return n
    return None


def _header_count(rx_seg: re.Pattern, text: str) -> int | None:
    for line in text.splitlines():
        for seg in _SEG_SEP.split(line):
            m = rx_seg.fullmatch(seg.strip())
            if m:
                return common.parse_count(m.group(1))
    m = rx_seg.search(text)
    return common.parse_count(m.group(1)) if m else None


def parse_profile(html: str, *, max_posts: int = MAX_POSTS, username: str | None = None) -> dict:
    """Profile page -> {"account": {"followers"?}, "following"?, "posts_count"?, "is_professional",
    "posts": [{"external_id", "url", "content"?, "views"?, "engagements"?}]}.

    Followers/following/posts come from og:description ("1,234 Followers, 567 Following, 89 Posts - ..."),
    falling back to the header stat list. Grid posts come from `<a href=".../p/<code>/">` and
    `/reel/<code>/` anchors, de-duplicated by shortcode with order preserved, capped at `max_posts`
    (never more than 12). Anchors that name a different user than the profile are ignored."""
    html = html if isinstance(html, str) else ""
    page = _scan(html)
    text = _text(html)
    desc = page.meta.get("og:description", "")
    followers = _first_count(_OG_FOLLOWERS, desc)
    following = _first_count(_OG_FOLLOWING, desc)
    posts_count = _first_count(_OG_POSTS, desc)
    if followers is None:
        followers = _header_count(_HDR_FOLLOWERS, text)
    if following is None:
        following = _header_count(_HDR_FOLLOWING, text)
    if posts_count is None:
        posts_count = _header_count(_HDR_POSTS, text)
    limit = max(0, min(int(max_posts), MAX_POSTS))
    user = (username or "").lower() or _infer_username(page)
    out: dict = {"account": {}, "is_professional": _is_professional(page, text), "posts": []}
    if followers is not None:
        out["account"]["followers"] = followers
    if following is not None:
        out["following"] = following
    if posts_count is not None:
        out["posts_count"] = posts_count
    out["posts"] = _grid_posts(page, user)[:limit]
    return out


# ---------------------------------------------------------------------------------------------------
# post / reel page


def parse_post_page(html: str, *, url: str | None = None) -> dict | None:
    """An individual /p/<code>/ or /reel/<code>/ page -> a payload post dict with only the facts that are
    shown: `external_id`, `url`, then `content`, `posted_at`, `views`, `engagements` when found. None when
    the page has no shortcode (from `url`, og:url or the canonical link) or nothing useful at all.

    likes: "1,234 likes", or "Liked by x and 1,233 others" -> 1,234 (named users + 'others'); omitted when
    the like count is hidden. comments: "View all 56 comments" / "1 comment". views: "12,345 plays" /
    "1.2M views" for reels, else reach/impressions when shown (photos have no public view count).
    engagements = likes + comments (whichever are known)."""
    html = html if isinstance(html, str) else ""
    if not html.strip():
        return None
    page = _scan(html)
    ref = (
        _shortcode_of(url)
        or _shortcode_of(page.meta.get("og:url"))
        or _shortcode_of(page.links.get("canonical"))
    )
    if not ref:
        return None
    kind, code = ref
    text = _text(html)
    desc = page.meta.get("og:description", "")
    ld = _jsonld(page.jsonld)

    caption = _first(
        page.captions[0] if page.captions else None,
        page.h1[0] if page.h1 else None,
        _quoted(desc),
        _quoted(page.meta.get("og:title", "")),
        ld.get("content"),
    )
    visible = text.replace(caption, " ") if caption else text

    head = re.split(r"\s+-\s+", desc, maxsplit=1)[0] if re.search(r"\s+-\s+", desc) else ""
    og = _stats(head) if re.match(r"\s*\d", head) else {}
    vis = _visible_stats(visible)
    likes = _first(og.get("likes"), ld.get("likes"), vis["likes"])
    comments = _first(og.get("comments"), ld.get("comments"), vis["comments"])
    plays = _first(og.get("plays"), vis["plays"])
    views = _first(plays, _reach(visible))
    known = [v for v in (likes, comments) if v is not None]

    stamps = [d for d in (_iso(t) for t in page.times) if d]
    posted_at = min(stamps, key=datetime.fromisoformat) if stamps else ld.get("posted_at")

    post: dict = {"external_id": code, "url": _post_url(kind, code)}
    if caption:
        post["content"] = _trim(caption, POST_CONTENT_MAX)
    if posted_at:
        post["posted_at"] = posted_at
    if views is not None:
        post["views"] = views
    if known:
        post["engagements"] = sum(known)
    return post if len(post) > 2 else None


# ---------------------------------------------------------------------------------------------------
# insights page (professional accounts)


def _labelled(text: str, labels: list[str]) -> int | None:
    for lab in labels:  # label then number ("Views 12.3K", "Views: 12.3K", "Views\n12.3K")
        for m in re.finditer(rf"(?<!\w){lab}\b\s*[:\-]?\s*{_NUM}", text, re.IGNORECASE):
            n = common.parse_count(m.group(1))
            if n is not None:
                return n
    for lab in labels:  # number then label ("12.3K Views")
        for m in re.finditer(rf"{_NUM}\s+{lab}\b", text, re.IGNORECASE):
            n = common.parse_count(m.group(1))
            if n is not None:
                return n
    return None


def parse_insights(html: str) -> dict:
    """Professional-account insights page -> account dict with whichever of views (Views/Impressions),
    engagements (Interactions/Accounts engaged), profile_views (Profile visits/views/activity), clicks
    (Link taps/Website taps) and followers are shown. {} when none are."""
    html = html if isinstance(html, str) else ""
    text = _text(html)
    out: dict = {}
    if not text:
        return out
    for key, labels in _INSIGHT_LABELS.items():
        n = _labelled(text, labels)
        if n is not None:
            out[key] = n
    return out


# ---------------------------------------------------------------------------------------------------
# merge


def _int_fields(src, keys) -> dict:
    out: dict = {}
    for k in keys:
        n = _as_int(src.get(k)) if isinstance(src, dict) else None
        if n is not None:
            out[k] = n
    return out


def _index_pages(post_pages) -> dict[str, dict]:
    """post pages as a {shortcode: dict} map (accepts a list of dicts or a mapping)."""
    items = post_pages.values() if isinstance(post_pages, dict) else (post_pages or [])
    out: dict[str, dict] = {}
    for p in items:
        if not isinstance(p, dict):
            continue
        ref = _shortcode_of(p.get("url"))
        code = str(p.get("external_id") or (ref[1] if ref else "") or "")
        if code:
            out.setdefault(code, p)
    return out


def _finish_post(post: dict) -> dict:
    out: dict = {}
    for k in ("external_id", "url", "content", "posted_at"):
        v = post.get(k)
        if isinstance(v, str) and v.strip():
            out[k] = v
    out["views"] = _as_int(post.get("views")) or 0
    out["engagements"] = _as_int(post.get("engagements")) or 0
    for k in ("clicks", "conversions"):
        n = _as_int(post.get(k))
        if n is not None:
            out[k] = n
    return out


def build_payload(
    profile: dict | None, post_pages=None, insights: dict | None = None, *, max_posts: int = MAX_POSTS
) -> dict:
    """Merge into the ingest body {"account": {...}, "posts": [...]}.

    account = {followers from the profile} updated by the insights numbers. posts follow the grid's order
    (at most 12); numbers, caption and date from a post page win over the grid's; every post ends up with an
    int `views` and `engagements` (0 when never shown). Post pages for posts missing from the grid are
    appended while there is room. `post_pages` is a list of parse_post_page dicts or a {shortcode: dict} map."""
    profile = profile if isinstance(profile, dict) else {}
    account = _int_fields(profile.get("account"), _ACCOUNT_KEYS)
    account.update(_int_fields(insights, _ACCOUNT_KEYS))
    pages = _index_pages(post_pages)
    limit = max(0, min(int(max_posts), MAX_POSTS))
    posts: list[dict] = []
    seen: set[str] = set()
    for grid in profile.get("posts") or []:
        if not isinstance(grid, dict):
            continue
        code = str(grid.get("external_id") or "")
        if code in seen:
            continue
        seen.add(code)
        merged = dict(grid)
        if code in pages:
            merged.update({k: v for k, v in pages[code].items() if v is not None})
        posts.append(_finish_post(merged))
    for code, page in pages.items():  # pages for posts the grid did not list
        if code not in seen:
            seen.add(code)
            posts.append(_finish_post(page))
    return {"account": account, "posts": posts[:limit]}


# ---------------------------------------------------------------------------------------------------
# driver (the only part that touches a browser)


def _short_err(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {common.clean(str(exc))}"[:160]


def _wait_for(page, selector: str) -> None:
    """Best-effort wait for the page to render something; never fatal."""
    try:
        page.wait_for_selector(selector, timeout=SETTLE_TIMEOUT_MS)
    except Exception:  # noqa: BLE001, S110 - waiting is best effort, never fatal
        pass


def _open(page, url: str, selector: str) -> str:
    page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
    _wait_for(page, selector)
    return page.content()


def harvest(context, profile_url, *, max_posts=MAX_POSTS, log=print, sleep=time.sleep, now=None) -> dict:
    """Read the profile, up to `max_posts` (<= 12) of its own posts and (professional accounts) the
    insights page from the user's logged-in Chrome, and return the payload for POST /api/metrics/ingest.

    `context` is a Playwright sync BrowserContext. One new page is opened and always closed; the context
    is never closed. A 1-2 s human pause (`common.human_pause(sleep=sleep)`) separates navigations.
    Raises common.LoginRequired when Chrome is not logged in, common.HarvestError when the page is not a
    readable profile. A failing post or a failing insights page is logged and skipped, never fatal.
    `now` is accepted for symmetry with the other platform drivers; Instagram needs no clock because
    `<time datetime>` is absolute."""
    url = normalise_profile_url(profile_url)
    user = profile_username(url)
    cap = max(0, min(int(max_posts), MAX_POSTS))
    page = context.new_page()
    try:
        log(f"instagram: opening profile {url}")
        html = _open(page, url, "a[href*='/p/'], a[href*='/reel/'], header")
        if looks_logged_out(page.url, html):
            raise common.LoginRequired(common.LOGIN_MESSAGE)
        profile = parse_profile(html, max_posts=cap, username=user)
        if not profile["account"] and not profile["posts"]:
            raise common.HarvestError(
                f"could not read an Instagram profile at {url} (no follower count or posts on the page)"
            )
        followers = profile["account"].get("followers")
        kind = "professional" if profile["is_professional"] else "personal"
        shown = f"{followers:,} followers" if followers is not None else "followers not shown"
        log(f"instagram: profile @{user} - {shown}, {len(profile['posts'])} grid posts, {kind} account")

        post_pages: list[dict] = []
        total = len(profile["posts"])
        for i, grid in enumerate(profile["posts"], 1):
            label = f"instagram: post {i}/{total} {grid['external_id']}"
            common.human_pause(sleep=sleep)
            try:
                post_html = _open(page, grid["url"], "time, article, main")
                if looks_logged_out(page.url, post_html):
                    log(f"{label} - Chrome looks logged out, stopping post pages (grid numbers kept)")
                    break
                parsed = parse_post_page(post_html, url=grid["url"])
            except Exception as exc:  # noqa: BLE001 - one bad post is skipped, never fatal
                log(f"{label} - skipped ({_short_err(exc)})")
                continue
            if parsed is None:
                log(f"{label} - nothing readable, using grid numbers")
                continue
            post_pages.append(parsed)
            log(
                f"{label} - views {parsed.get('views', 'n/a')}, engagements {parsed.get('engagements', 'n/a')}"
            )

        insights: dict = {}
        if profile["is_professional"]:
            common.human_pause(sleep=sleep)
            try:
                ins_html = _open(page, insights_url(), "main, section")
                if looks_logged_out(page.url, ins_html):
                    log("instagram: insights - not available (login wall), skipped")
                else:
                    insights = parse_insights(ins_html)
                    if insights:
                        log("instagram: insights - " + ", ".join(f"{k} {v:,}" for k, v in insights.items()))
                    else:
                        log("instagram: insights - page had no readable numbers, skipped")
            except Exception as exc:  # noqa: BLE001 - insights are best effort
                log(f"instagram: insights - skipped ({_short_err(exc)})")

        payload = build_payload(profile, post_pages, insights, max_posts=cap)
        log(f"instagram: done - {len(payload['posts'])} posts, account fields {sorted(payload['account'])}")
        return payload
    finally:
        try:
            page.close()
        except Exception:  # noqa: BLE001, S110 - never mask the real result/error with a close failure
            pass
