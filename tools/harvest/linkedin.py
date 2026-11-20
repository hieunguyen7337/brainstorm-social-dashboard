"""Harvest LinkedIn stats from the user's OWN logged-in Chrome (stdlib only, no playwright import).

Pure parsers (str in, data out, no I/O, no clock unless `now` is passed in):
    activity_url, creator_analytics_url, profile_page_url, looks_logged_out, parse_recent_activity,
    parse_creator_content, parse_followers, merge_posts, build_payload
Driver (the only code that touches a browser; it is handed an already-created Playwright sync
BrowserContext and never imports playwright):
    harvest(context, profile_url, ...)

Payload returned by `harvest` / `build_payload` is the body of POST /api/metrics/ingest minus
`platform` and `source`:

    {"account": {"followers"?, "views"?, "engagements"?, "clicks"?, "profile_views"?},
     "posts": [{"external_id"?, "url"?, "content"?, "posted_at"?, "views", "engagements",
                "clicks"?, "conversions"?}]}

Every number is a plain int; unknown numbers are omitted rather than guessed.

IMPORTANT: every selector / class name / text pattern below is modelled on LinkedIn's markup as it was
understood when this was written. There was no live access, so none of it has been checked against a
real capture. The parsers lean on several independent signals (data-urn, activity links, aria-labels,
"N impressions" text) so one renamed class does not zero everything, but expect to adjust them after the
first real run.
"""

from __future__ import annotations

import contextlib
import html as _html
import math
import random
import re
import time
from datetime import UTC, datetime, timedelta
from html.parser import HTMLParser
from urllib.parse import urlsplit

try:
    from . import common
except ImportError:  # imported as a top-level module with tools/harvest on sys.path
    import common  # type: ignore[no-redef]

__all__ = [
    "ANALYTICS_URL",
    "activity_url",
    "build_payload",
    "creator_analytics_url",
    "harvest",
    "looks_logged_out",
    "merge_posts",
    "parse_creator_content",
    "parse_followers",
    "parse_recent_activity",
    "profile_page_url",
]

ANALYTICS_URL = "https://www.linkedin.com/analytics/creator/content/"
CONTENT_CHARS = 280
SCROLL_STEPS = 6
GOTO_TIMEOUT_MS = 45_000


# --------------------------------------------------------------------------------------------------
# URLs
# --------------------------------------------------------------------------------------------------

_PROFILE_RX = re.compile(
    r"^(?:https?://)?(?:[a-z0-9-]+\.)?linkedin\.com/(in|company|school|showcase)/([^/?#\s]+)", re.IGNORECASE
)


def creator_analytics_url() -> str:
    """The logged-in member's own "Content performance" page."""
    return ANALYTICS_URL


def _profile_parts(profile_url: str) -> tuple[str, str]:
    m = _PROFILE_RX.match((profile_url or "").strip())
    if not m:
        raise common.HarvestError(f"not a LinkedIn profile or company URL: {profile_url!r}")
    return m.group(1).lower(), m.group(2)


def profile_page_url(profile_url: str) -> str:
    """Canonical profile page: https://www.linkedin.com/in/<slug>/ (or /company/<slug>/)."""
    kind, slug = _profile_parts(profile_url)
    return f"https://www.linkedin.com/{kind}/{slug}/"


def activity_url(profile_url: str) -> str:
    """Where the posts of this profile are listed. Tolerates trailing slashes, query strings, regional or
    `www`-less hosts and `/in/<slug>/details/...` suffixes."""
    kind, slug = _profile_parts(profile_url)
    if kind == "in":
        return f"https://www.linkedin.com/in/{slug}/recent-activity/all/"
    return f"https://www.linkedin.com/{kind}/{slug}/posts/?feedView=all"


# --------------------------------------------------------------------------------------------------
# Tiny tolerant DOM (stdlib HTMLParser) + text extraction
# --------------------------------------------------------------------------------------------------

_VOID = frozenset(
    {
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
    }
)
_SKIP_TAGS = frozenset({"script", "style", "noscript", "template", "svg", "head", "title"})
_INLINE = frozenset(
    {
        "a", "abbr", "b", "bdi", "bdo", "button", "cite", "code", "data", "dfn", "em", "font", "i", "img",
        "kbd", "label", "mark", "option", "q", "s", "samp", "select", "small", "span", "strong", "sub", "sup",
        "td", "th", "time", "u", "var",
    }
)  # fmt: skip
_SPACED = frozenset(
    {"button", "label", "option", "select", "td", "th"}
)  # inline, but never glued, even with glue=True


class _Node:
    __slots__ = ("attrs", "kids", "parent", "tag")

    def __init__(self, tag: str, attrs: dict[str, str], parent: _Node | None = None):
        self.tag = tag
        self.attrs = attrs
        self.kids: list = []  # str | _Node
        self.parent = parent

    @property
    def cls(self) -> str:
        return self.attrs.get("class", "").lower()

    def tokens(self) -> set[str]:
        return set(self.cls.split())


class _Builder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root", {})
        self.stack = [self.root]

    def _new(self, tag, attrs) -> _Node:
        node = _Node(tag, {k: (v or "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].kids.append(node)
        return node

    def handle_starttag(self, tag, attrs):
        node = self._new(tag, attrs)
        if tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self._new(tag, attrs)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].kids.append(data)


def _parse(html: str | None) -> _Node:
    b = _Builder()
    with contextlib.suppress(Exception):  # malformed markup: keep whatever was built so far
        b.feed(html if isinstance(html, str) else "")
        b.close()
    return b.root


def _descend(root: _Node, skip_ids=frozenset()):
    """Pre-order (document order) iteration over element nodes, iterative (no recursion limit)."""
    stack = [root]
    while stack:
        n = stack.pop()
        if id(n) in skip_ids:
            continue
        yield n
        for k in reversed(n.kids):
            if isinstance(k, _Node):
                stack.append(k)


def _is_hidden(node: _Node, hide_visually: bool = False) -> bool:
    a = node.attrs
    if "hidden" in a:
        return True
    if "display:none" in a.get("style", "").replace(" ", "").lower():
        return True
    if node.tag == "code" and a.get("id", "").startswith("bpr-guid"):  # LinkedIn's embedded JSON blobs
        return True
    cls = node.cls
    if "see-more-less-toggle" in cls:  # the "...see more" button inside a post
        return True
    return hide_visually and "visually-hidden" in cls


_BREAK = object()


def _walk(
    root: _Node,
    skip: _Node | None = None,
    *,
    hide_visually: bool = False,
    glue: bool = False,
    skip_ids=frozenset(),
):
    """(lines, aria_labels) of a subtree. Block elements start a new line. Inline elements are separated by a
    space (minified markup often has no whitespace between spans), except with `glue=True`, which keeps
    adjacent inline text exactly as written (used for post text so "#" + "hackathon" stays one hashtag)."""
    lines: list[str] = []
    labels: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        s = common.clean("".join(buf))
        buf.clear()
        if s:
            lines.append(s)

    stack: list = [root]
    while stack:
        item = stack.pop()
        if item is _BREAK:
            flush()
            continue
        if isinstance(item, str):
            buf.append(item)
            continue
        node = item
        if node is skip or id(node) in skip_ids:
            continue
        if node.tag in _SKIP_TAGS or _is_hidden(node, hide_visually):
            continue
        label = node.attrs.get("aria-label")
        if label:
            labels.append(label)
        if node.tag == "br":
            flush()
            continue
        if node.tag not in _INLINE:
            flush()
            stack.append(_BREAK)
        elif not glue or node.tag in _SPACED:
            buf.append(" ")
            stack.append(" ")
        stack.extend(reversed(node.kids))
    flush()
    return lines, labels


def _text_of(node: _Node, **kw) -> str:
    return " ".join(_walk(node, **kw)[0])


# --------------------------------------------------------------------------------------------------
# Numbers
# --------------------------------------------------------------------------------------------------

# '1,204' / '1.204' / '12.4K' / '2,3K' / '87' / '3.4M'
_NUM = r"(\d{1,3}(?:[,.\u00a0\u202f ]\d{3}(?!\d))+|\d+(?:[.,]\d+)?[KkMm]?)"


def _to_int(token: str | None) -> int | None:
    if token is None:
        return None
    t = token.strip()
    if re.fullmatch(r"\d{1,3}(?:[.\u00a0\u202f ]\d{3})+", t):  # '1.204' / '1 204' thousands separators
        return int(re.sub(r"\D", "", t))
    return common.parse_count(t)


def _count_rx(nouns: str) -> re.Pattern[str]:
    return re.compile(r"(?<![\w.,])" + _NUM + r"\s*\+?\s*(?:" + nouns + r")\b", re.IGNORECASE)


_IMPRESSIONS = _count_rx(r"impressions?")
_REACTIONS = _count_rx(r"reactions?|likes?")
_COMMENTS = _count_rx(r"comments?")
_REPOSTS = _count_rx(r"reposts?|shares?")
_ANY_METRIC = _count_rx(r"impressions?|reactions?|likes?|comments?|reposts?|shares?")
_OTHERS = re.compile(r"\band\s+(\d[\d,]*)\s+others?\b", re.IGNORECASE)  # "You and 86 others" -> 87 reactions


def _first_count(facts: list[str], rx: re.Pattern[str]) -> int | None:
    for f in facts:
        m = rx.search(f)
        if m:
            v = _to_int(m.group(1))
            if v is not None:
                return v
    return None


# --------------------------------------------------------------------------------------------------
# Login wall detection
# --------------------------------------------------------------------------------------------------

_LOGIN_PATH = re.compile(
    r"^/(?:uas/|login\b|authwall\b|checkpoint\b|signup\b|start/join\b|m/login\b)", re.IGNORECASE
)
_SIGNIN_LINE = re.compile(r"\bsign in\b", re.IGNORECASE)
_JOIN_LINE = re.compile(r"\bjoin (?:now|linkedin)\b|\bagree\s*&\s*join\b|\bnew to linkedin\b", re.IGNORECASE)


def looks_logged_out(url: str, html: str) -> bool:
    """True for LinkedIn's login / authwall / checkpoint pages; False for a normal feed or profile page.

    URL path first (/login, /uas/..., /authwall, /checkpoint, /signup), then the markup: a page that shows
    signed-in chrome (global nav, feed cards, a sign-out link) is never logged out; otherwise a login form
    (session_key input, authwall / join-form classes) or short "Sign in" + "Join now" lines mean a wall.
    """
    try:
        path = urlsplit(url or "").path
    except ValueError:
        path = ""
    if _LOGIN_PATH.match(path):
        return True
    if not html or not html.strip():
        return False
    root = _parse(html)
    wall = False
    for n in _descend(root):
        a = n.attrs
        if _strict_id(n) or any(t.startswith(("global-nav", "feed-shared-update-v2")) for t in n.tokens()):
            return False
        if n.tag == "a" and "/logout" in a.get("href", ""):
            return False
        if a.get("name") in ("session_key", "session_password") or "/uas/login" in a.get("action", ""):
            wall = True
        if any(
            k in n.cls for k in ("authwall", "join-form", "login__form", "login-form")
        ) or "authwall" in a.get("id", ""):
            wall = True
    if wall:
        return True
    lines = [ln for ln in _walk(root)[0] if len(ln) <= 60]
    return any(_SIGNIN_LINE.search(ln) for ln in lines) and any(_JOIN_LINE.search(ln) for ln in lines)


# --------------------------------------------------------------------------------------------------
# Post cards
# --------------------------------------------------------------------------------------------------

_CARD_CLASSES = frozenset(
    {
        "feed-shared-update-v2",
        "occludable-update",
        "profile-creator-shared-feed-update__container",
        "feed-shared-update",
    }
)
_ACT_STRICT = re.compile(r"^\s*urn:li:activity:(\d+)\s*$")
_ACT_LINK = re.compile(r"urn(?::|%3A)li(?::|%3A)activity(?::|%3A)(\d+)|[-_]activity-(\d{8,})", re.IGNORECASE)
_CONTENT_CLASSES = (
    "update-components-text",
    "feed-shared-text",
    "feed-shared-inline-show-more-text",
    "update-components-update-v2__commentary",
    "feed-shared-update-v2__description",
)
# "<Name> likes this", "<Name> commented on this": somebody else's post surfaced in the user's activity.
_FOREIGN = re.compile(
    r"\b(?:likes|loves|celebrates|supports|is curious about|finds this (?:insightful|funny)) this\b"
    r"|\bcommented on this\b|\breplied to\b",
    re.IGNORECASE,
)
_SEE_MORE = re.compile(r"\s*(?:\u2026|\.\.\.)\s*(?:see\s+)?more\s*$", re.IGNORECASE)
_CHROME_LINE = re.compile(
    r"^(?:like|comment|repost|send|share|follow|\+ follow|connect|message|view (?:post )?analytics|\u2026\s*(?:see )?more)$",
    re.IGNORECASE,
)

# Relative post age. Short tokens are case-sensitive on purpose ("3M" is a company, "3m" is minutes).
_AGE_SHORT = re.compile(
    r"(?<![\w.,/:+-])(\d{1,3})(yrs?|mos?|min|hrs?|[smhdwy])\b(?=\s*(?:[\u2022\u00b7|]|$|(?i:edited)\b))"
)
_AGE_WORDS = re.compile(
    r"(?<![\w.,])(\d{1,3})\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b", re.IGNORECASE
)
_AGE_NOW = re.compile(r"(?<![\w.,/:+-])(?:just\s+)?now(?=\s*[\u2022\u00b7|])", re.IGNORECASE)
_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86_400, "w": 604_800, "mo": 2_592_000, "y": 31_536_000}


def _strict_id(node: _Node) -> str | None:
    for key in ("data-urn", "data-id"):
        m = _ACT_STRICT.match(node.attrs.get(key, ""))
        if m:
            return m.group(1)
    return None


def _link_id(href: str | None) -> str | None:
    m = _ACT_LINK.search(href or "")
    return (m.group(1) or m.group(2)) if m else None


def _is_ancestor(anc: _Node, node: _Node) -> bool:
    p = node.parent
    while p is not None:
        if p is anc:
            return True
        p = p.parent
    return False


def _climb(a: _Node, loose: bool) -> _Node | None:
    """The card an activity link belongs to: nearest known card class; with `loose` also the nearest
    li/article/tr, else the nearest ancestor that shows a metric line."""
    first_tag = None
    node, depth = a.parent, 0
    while node is not None and node.tag not in ("body", "html", "#root") and depth < 30:
        if node.tokens() & _CARD_CLASSES:
            return node
        if loose and first_tag is None and node.tag in ("li", "article", "tr"):
            first_tag = node
        node, depth = node.parent, depth + 1
    if first_tag is not None or not loose:
        return first_tag
    node = a.parent
    for _ in range(6):
        if node is None or node.tag in ("body", "html", "#root"):
            break
        if any(_ANY_METRIC.search(ln) for ln in _walk(node)[0]):
            return node
        node = node.parent
    return a.parent or a


def _find_cards(root: _Node, *, loose: bool) -> list[tuple[_Node, str]]:
    """Post containers in document order. A container is the outermost element carrying
    data-urn="urn:li:activity:<id>", or (no data-urn) the card around a link to such a post
    (/feed/update/urn:li:activity:<id>/ or /posts/...-activity-<id>-...). Cards with neither are ignored."""
    cards: list[tuple[_Node, str]] = []
    seen_ids: set[str] = set()
    seen_nodes: set[int] = set()

    def accept(node: _Node, aid: str) -> None:
        if aid in seen_ids or id(node) in seen_nodes:
            return
        p = node.parent
        while p is not None:
            if id(p) in seen_nodes:  # nested inside an accepted card
                return
            p = p.parent
        if any(_is_ancestor(node, c) for c, _ in cards):  # wraps an accepted card
            return
        seen_ids.add(aid)
        seen_nodes.add(id(node))
        cards.append((node, aid))

    stack: list[_Node] = [root]
    while stack:
        node = stack.pop()
        aid = _strict_id(node)
        if aid:
            accept(node, aid)
            continue
        if node.tag == "a":
            aid = _link_id(node.attrs.get("href"))
            if aid and aid not in seen_ids:
                card = _climb(node, loose)
                if card is not None:
                    accept(card, aid)
        stack.extend(k for k in reversed(node.kids) if isinstance(k, _Node))
    return cards


def _content_node(card: _Node) -> _Node | None:
    for n in _descend(card):
        if "commentary" in n.attrs.get("data-test-id", "") or any(c in n.cls for c in _CONTENT_CLASSES):
            return n
    return None


def _is_foreign(card: _Node) -> bool:
    for n in _descend(card):
        c = n.cls
        if ("update-components-header" in c or "feed-shared-header" in c) and _FOREIGN.search(_text_of(n)):
            return True
    return False


def _finish_content(text: str) -> str:
    text = common.clean(text)
    if re.search(r"&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);", text, re.IGNORECASE):  # double-encoded entities
        text = common.clean(_html.unescape(text))
    text = _SEE_MORE.sub("", text)
    return text[:CONTENT_CHARS].rstrip()


def _fallback_content(lines: list[str]) -> str | None:
    """No known commentary container: the longest line that is not a metric, age or button label."""
    best = None
    for ln in lines:
        if len(ln) < 12 or _ANY_METRIC.search(ln) or _CHROME_LINE.match(ln):
            continue
        if _AGE_SHORT.search(ln) or _AGE_WORDS.search(ln):
            continue
        if best is None or len(ln) > len(best):
            best = ln
    return best


def _reaction_count_from_class(card: _Node, skip: _Node | None) -> int | None:
    for n in _descend(card, frozenset({id(skip)}) if skip is not None else frozenset()):
        if "reactions-count" in n.cls:
            m = re.search(_NUM, _text_of(n))
            if m:
                return _to_int(m.group(1))
    return None


def _utc(now: datetime | None) -> datetime | None:
    if now is None:
        return None
    return now.replace(tzinfo=UTC) if now.tzinfo is None else now.astimezone(UTC)


def _age_seconds(lines: list[str]) -> tuple[int, str] | None:
    """(seconds, granularity) from the first relative-age token found in `lines`, else None."""
    for ln in lines:
        if _AGE_NOW.search(ln):
            return 0, "m"
        m = _AGE_SHORT.search(ln)
        if m:
            unit = m.group(2)
            key = (
                "mo"
                if unit.startswith("mo")
                else "y"
                if unit.startswith("y")
                else "h"
                if unit.startswith("h")
                else "m"
                if unit == "min"
                else unit
            )
            return int(m.group(1)) * _UNIT_SECONDS[key], key
        m = _AGE_WORDS.search(ln)
        if m:
            word = m.group(2).lower().rstrip("s")
            key = {
                "second": "s",
                "minute": "m",
                "hour": "h",
                "day": "d",
                "week": "w",
                "month": "mo",
                "year": "y",
            }[word]
            return int(m.group(1)) * _UNIT_SECONDS[key], key
    return None


def _posted_at(lines: list[str], now: datetime | None) -> str | None:
    if now is None:
        return None
    age = _age_seconds(lines)
    if age is None:
        return None
    seconds, key = age
    try:
        t = now - timedelta(seconds=seconds)
    except OverflowError:
        return None
    if key in ("s", "m"):
        t = t.replace(second=0, microsecond=0)
    elif key == "h":
        t = t.replace(minute=0, second=0, microsecond=0)
    else:
        t = t.replace(hour=0, minute=0, second=0, microsecond=0)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _extract(card: _Node, aid: str, now: datetime | None) -> dict | None:
    if _is_foreign(card):
        return None
    content_node = _content_node(card)
    if content_node is not None:
        content = _finish_content(_text_of(content_node, hide_visually=True, glue=True))
        lines, labels = _walk(card, skip=content_node)
    else:
        lines, labels = _walk(card)
        picked = _fallback_content(lines)
        content = _finish_content(picked) if picked else ""
        if picked:
            lines = [ln for ln in lines if ln != picked]
    facts = lines + labels
    impressions = _first_count(facts, _IMPRESSIONS)
    reactions = _first_count(facts, _REACTIONS)
    if reactions is None:
        reactions = _reaction_count_from_class(card, content_node)
    if reactions is None:
        for f in facts:
            m = _OTHERS.search(f)
            if m:
                reactions = (_to_int(m.group(1)) or 0) + 1
                break
    comments = _first_count(facts, _COMMENTS)
    reposts = _first_count(facts, _REPOSTS)
    post: dict = {"external_id": aid, "url": f"https://www.linkedin.com/feed/update/urn:li:activity:{aid}/"}
    if content:
        post["content"] = content
    posted = _posted_at(lines, now)
    if posted:
        post["posted_at"] = posted
    post["views"] = impressions or 0
    post["engagements"] = (reactions or 0) + (comments or 0) + (reposts or 0)
    return post


def parse_recent_activity(html: str, *, now: datetime | None = None, max_posts: int = 30) -> list[dict]:
    """One dict per post card on the activity page, in page order (newest first), at most 30.

    views = impressions (0 when the card shows none); engagements = reactions + comments + reposts.
    posted_at (ISO-8601, date precision for d/w/mo/yr) only when `now` is given. Cards without a
    recognisable activity id are skipped, as are other people's posts the user merely reacted to.
    """
    cap = min(int(max_posts), common.MAX_POSTS)
    if cap <= 0 or not html:
        return []
    now_utc = _utc(now)
    posts: list[dict] = []
    for card, aid in _find_cards(_parse(html), loose=False):
        post = _extract(card, aid, now_utc)
        if post:
            posts.append(post)
            if len(posts) >= cap:
                break
    return posts


# --------------------------------------------------------------------------------------------------
# Creator analytics ("Content performance") and followers
# --------------------------------------------------------------------------------------------------

_TILE_LABELS = {
    "views": r"(?:post\s+|total\s+)?impressions",
    "reactions": r"(?:total\s+)?reactions",
    "comments": r"comments",
    "reposts": r"reposts",
    "engagements": r"(?:total\s+)?engagements",
    "profile_views": r"profile\s+(?:views|viewers)",
}
_TILE_RX = {
    key: (
        re.compile(
            r"^(?:" + label + r")\s*[:\-\u2013]?\s*" + _NUM + r"(?![\w])", re.IGNORECASE
        ),  # "Impressions 45,308"
        re.compile(r"^" + _NUM + r"\s*(?:" + label + r")\b", re.IGNORECASE),  # "45,308 Impressions"
    )
    for key, label in _TILE_LABELS.items()
}
_FOLLOW_AFTER = re.compile(r"(?<![\w.,])" + _NUM + r"\s*(?:followers?)\b", re.IGNORECASE)  # "1,234 followers"
_FOLLOW_BEFORE = re.compile(
    r"\bfollowers?\s*[:\-\u2013]?\s*" + _NUM + r"(?![\w])", re.IGNORECASE
)  # "Followers 1,234"


def _sizes(root: _Node) -> dict[int, int]:
    order = list(_descend(root))
    size = {id(n): 1 for n in order}
    for n in reversed(order):
        if n.parent is not None and id(n.parent) in size:
            size[id(n.parent)] += size[id(n)]
    return size


def _stat_tiles(root: _Node, skip_ids: set[int]) -> dict[str, int]:
    """Totals outside the top-posts cards: the first small element whose text is "<label> <number>" or
    "<number> <label>" (the number may sit in a separate span or block, in either order)."""
    size = _sizes(root)
    found: dict[str, int] = {}
    for n in _descend(root, frozenset(skip_ids)):
        if n.tag in _SKIP_TAGS or size[id(n)] > 40:
            continue
        text = _text_of(n)
        if not text or len(text) > 160:
            continue
        for key, (label_first, number_first) in _TILE_RX.items():
            if key in found:
                continue
            m = label_first.match(text) or number_first.match(text)
            if m:
                v = _to_int(m.group(1))
                if v is not None:
                    found[key] = v
    return found


def parse_followers(html: str) -> int | None:
    """ "1,234 followers" / "3.4K followers" / "Followers 1,234" from a profile or analytics page."""
    if not html:
        return None
    lines, labels = _walk(_parse(html))
    for ln in lines:
        m = _FOLLOW_AFTER.search(ln) or _FOLLOW_BEFORE.search(ln)
        if m:
            return _to_int(m.group(1))
    m = _FOLLOW_BEFORE.search(" ".join(lines))  # label and number in separate blocks
    if m:
        return _to_int(m.group(1))
    for lab in labels:
        m = _FOLLOW_AFTER.search(lab)
        if m:
            return _to_int(m.group(1))
    return None


def parse_creator_content(html: str) -> dict:
    """The "Content performance" page -> {"account": {...}, "posts": [...]}.

    account: views (= impressions), engagements, profile_views and followers, each only when shown.
    engagements = reactions + comments + reposts when all three are shown; else the page's explicit
    "Engagements" figure; else the sum of whichever of the three exist. posts: the "Top posts" cards
    (views, engagements and, when linked, external_id / url), same shape as parse_recent_activity.
    """
    if not html:
        return {"account": {}, "posts": []}
    root = _parse(html)
    cards = _find_cards(root, loose=True)
    posts = [p for card, aid in cards if (p := _extract(card, aid, None))]
    tiles = _stat_tiles(root, {id(c) for c, _ in cards})
    account: dict = {}
    if "views" in tiles:
        account["views"] = tiles["views"]
    parts = [tiles.get(k) for k in ("reactions", "comments", "reposts")]
    if all(p is not None for p in parts):
        account["engagements"] = sum(parts)  # type: ignore[arg-type]
    elif "engagements" in tiles:
        account["engagements"] = tiles["engagements"]
    elif any(p is not None for p in parts):
        account["engagements"] = sum(p for p in parts if p is not None)
    if "profile_views" in tiles:
        account["profile_views"] = tiles["profile_views"]
    followers = parse_followers(html)
    if followers is not None:
        account["followers"] = followers
    return {"account": account, "posts": posts}


# --------------------------------------------------------------------------------------------------
# Merge + payload
# --------------------------------------------------------------------------------------------------

_POST_KEYS = ("external_id", "url", "content", "posted_at", "views", "engagements", "clicks", "conversions")


def _int(v) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return max(v, 0)
    if isinstance(v, float) and math.isfinite(v):
        return max(int(v), 0)
    if isinstance(v, str) and v.strip().isdigit():
        return int(v.strip())
    return None


def _norm_url(url) -> str:
    if not isinstance(url, str) or not url.strip():
        return ""
    parts = urlsplit(url.strip())
    return f"{parts.netloc.lower()}{parts.path.rstrip('/')}"


def _post_id(p: dict) -> str:
    eid = p.get("external_id")
    if eid not in (None, ""):
        return str(eid)
    return _link_id(p.get("url")) or ""


def _prefix_key(p: dict) -> str:
    key = common.clean(p.get("content") or "").casefold()[:30]
    return key if len(key) >= 8 else ""  # very short posts are too ambiguous to match on text


def merge_posts(activity_posts: list[dict], analytics_posts: list[dict]) -> list[dict]:
    """Union of both lists, matched by external_id, then url, then the first 30 characters of the content
    (case-folded; never between two posts whose ids differ). Activity posts come first in their own order,
    analytics-only posts follow. views: the analytics number wins when > 0. engagements: the larger of the
    two. Missing fields are filled from the other side. Inputs are not mutated. Capped at 30."""
    out: list[dict] = []
    by_id: dict[str, dict] = {}
    by_url: dict[str, dict] = {}
    by_text: dict[str, dict] = {}

    def find(p: dict) -> dict | None:
        pid = _post_id(p)
        if pid and pid in by_id:
            return by_id[pid]
        url = _norm_url(p.get("url"))
        if url and url in by_url:
            return by_url[url]
        key = _prefix_key(p)
        cand = by_text.get(key) if key else None
        if cand is not None:
            cid = _post_id(cand)
            if pid and cid and pid != cid:
                return None
            return cand
        return None

    def register(rec: dict) -> None:
        pid = _post_id(rec)
        if pid:
            by_id.setdefault(pid, rec)
        url = _norm_url(rec.get("url"))
        if url:
            by_url.setdefault(url, rec)
        key = _prefix_key(rec)
        if key:
            by_text.setdefault(key, rec)

    for posts, from_analytics in ((activity_posts, False), (analytics_posts, True)):
        for p in posts or []:
            if not isinstance(p, dict):
                continue
            rec = find(p)
            if rec is None:
                rec = dict(p)
                out.append(rec)
            else:
                for k in ("external_id", "url", "content", "posted_at", "clicks", "conversions"):
                    if rec.get(k) in (None, "") and p.get(k) not in (None, ""):
                        rec[k] = p[k]
                pv, ev = _int(p.get("views")), _int(p.get("engagements"))
                if from_analytics and pv:
                    rec["views"] = pv
                else:
                    rec["views"] = max(_int(rec.get("views")) or 0, pv or 0)
                rec["engagements"] = max(_int(rec.get("engagements")) or 0, ev or 0)
            register(rec)
    for rec in out:
        rec["views"] = _int(rec.get("views")) or 0
        rec["engagements"] = _int(rec.get("engagements")) or 0
    return out[: common.MAX_POSTS]


def build_payload(activity_posts: list[dict], creator: dict | None, followers: int | None) -> dict:
    """Combine activity posts, the creator-analytics result and the follower count into the ingest body."""
    creator = creator or {}
    c_account = creator.get("account") or {}
    account: dict = {}
    for key in ("views", "engagements", "clicks", "profile_views", "followers"):
        v = _int(c_account.get(key))
        if v is not None:
            account[key] = v
    f = _int(followers)
    if f is not None:
        account["followers"] = f
    posts: list[dict] = []
    for p in merge_posts(activity_posts or [], creator.get("posts") or []):
        clean: dict = {}
        for k in _POST_KEYS:
            v = p.get(k)
            if k in ("views", "engagements", "clicks", "conversions"):
                v = _int(v)
            elif isinstance(v, str):
                v = v.strip() or None
            else:
                v = None if v is None else str(v)
            if v is not None:
                clean[k] = v
        clean.setdefault("views", 0)
        clean.setdefault("engagements", 0)
        posts.append(clean)
    return {"account": account, "posts": posts}


# --------------------------------------------------------------------------------------------------
# Driver: the only code that touches a browser
# --------------------------------------------------------------------------------------------------

_SHOW_MORE = re.compile(r"^\s*show more results\s*$", re.IGNORECASE)


def _goto(page, url: str):
    resp = page.goto(url, wait_until="domcontentloaded", timeout=GOTO_TIMEOUT_MS)
    return getattr(resp, "status", None)


def _wait_for(page, selector: str, timeout_ms: int = 8_000) -> None:
    """Best effort: LinkedIn renders after domcontentloaded. Never fatal."""
    with contextlib.suppress(Exception):
        page.wait_for_selector(selector, timeout=timeout_ms)


def _click_show_more(page) -> bool:
    """The only click this module ever makes: the "Show more results" pagination button."""
    with contextlib.suppress(Exception):  # no such button, or the page changed under us: just carry on
        btn = page.get_by_role("button", name=_SHOW_MORE)
        if btn.count() > 0:
            btn.first.click(timeout=3_000)
            return True
    return False


def _absorb(acc: dict[str, dict], posts: list[dict]) -> int:
    new = 0
    for p in posts:
        key = p.get("external_id") or p.get("url") or ""
        if key not in acc:
            new += 1
        acc[key] = p  # later snapshots are at least as complete
    return new


def _read_activity(page, url: str, cap: int, log, sleep, now) -> list[dict]:
    log(f"LinkedIn: opening {url}")
    try:
        _goto(page, url)
    except Exception as exc:
        raise common.HarvestError(f"LinkedIn: could not open {url} ({type(exc).__name__}: {exc})") from exc
    common.human_pause(sleep=sleep)
    html = page.content()
    if looks_logged_out(page.url, html):
        raise common.LoginRequired(common.LOGIN_MESSAGE)
    acc: dict[str, dict] = {}
    _absorb(acc, parse_recent_activity(html, now=now, max_posts=common.MAX_POSTS))
    if not acc:  # cards may still be rendering
        _wait_for(page, "[data-urn^='urn:li:activity'], div.feed-shared-update-v2", 10_000)
        _absorb(acc, parse_recent_activity(page.content(), now=now, max_posts=common.MAX_POSTS))
    log(f"LinkedIn: {len(acc)} posts visible on the activity page")
    steps = 0
    while len(acc) < cap and steps < SCROLL_STEPS:
        steps += 1
        page.mouse.wheel(0, random.randint(600, 900))
        common.human_pause(sleep=sleep)
        if _click_show_more(page):
            log("LinkedIn: clicked 'Show more results'")
            common.human_pause(sleep=sleep)
        new = _absorb(acc, parse_recent_activity(page.content(), now=now, max_posts=common.MAX_POSTS))
        log(f"LinkedIn: scroll {steps}/{SCROLL_STEPS}: {len(acc)} posts ({new} new)")
        if new == 0:
            break
    return list(acc.values())[:cap]


def _read_creator(page, log, sleep) -> dict:
    """Non-fatal: any problem here returns an empty result and the run continues with activity data."""
    empty: dict = {"account": {}, "posts": []}
    try:
        common.human_pause(sleep=sleep)
        log(f"LinkedIn: opening {ANALYTICS_URL}")
        status = _goto(page, ANALYTICS_URL)
        common.human_pause(sleep=sleep)
        if status is not None and status >= 400:
            log(f"LinkedIn: creator analytics returned HTTP {status}; continuing with activity data only")
            return empty
        html = page.content()
        if looks_logged_out(page.url, html):
            log("LinkedIn: creator analytics asked for a login; continuing with activity data only")
            return empty
        creator = parse_creator_content(html)
        if not creator["account"] and not creator["posts"]:
            _wait_for(page, "text=Impressions")
            creator = parse_creator_content(page.content())
        if not creator["account"] and not creator["posts"]:
            log(
                "LinkedIn: creator analytics page was empty or unreadable; continuing with activity data only"
            )
            return empty
        log(
            f"LinkedIn: creator analytics: {len(creator['account'])} totals, {len(creator['posts'])} top posts"
        )
        return creator
    except Exception as exc:  # noqa: BLE001 - non-fatal by design: any failure here keeps the activity data
        log(
            f"LinkedIn: creator analytics skipped ({type(exc).__name__}: {exc}); continuing with activity data only"
        )
        return empty


def _read_followers(page, url: str, log, sleep) -> int | None:
    try:
        common.human_pause(sleep=sleep)
        log(f"LinkedIn: opening {url} for the follower count")
        _goto(page, url)
        common.human_pause(sleep=sleep)
        html = page.content()
        if looks_logged_out(page.url, html):
            log("LinkedIn: profile page asked for a login; no follower count")
            return None
        n = parse_followers(html)
        log(f"LinkedIn: followers {n if n is not None else 'not found'}")
        return n
    except Exception as exc:  # noqa: BLE001 - non-fatal by design: a missing follower count is just omitted
        log(f"LinkedIn: follower count skipped ({type(exc).__name__}: {exc})")
        return None


def harvest(context, profile_url: str, *, max_posts: int = 30, log=print, sleep=time.sleep, now=None) -> dict:
    """Read the user's own LinkedIn stats through their already-logged-in Chrome.

    `context` is a Playwright sync BrowserContext. One new page is opened and always closed again; the
    context and browser are never touched. Only the user's own pages are visited: the activity page,
    the creator analytics page (personal profiles only) and the profile page. Nothing is typed and the
    only click is "Show more results". Raises common.LoginRequired when Chrome is logged out and
    common.HarvestError when nothing readable was found. `now` defaults to the current UTC time so posted_at
    can be derived from LinkedIn's relative ages.
    """
    cap = max(1, min(int(max_posts), common.MAX_POSTS))
    kind, _slug = _profile_parts(profile_url)  # validate before opening a tab
    act_url = activity_url(profile_url)
    own_url = profile_page_url(profile_url)
    now = _utc(now) or datetime.now(UTC)
    page = context.new_page()
    try:
        posts = _read_activity(page, act_url, cap, log, sleep, now)
        if kind == "in":
            creator = _read_creator(page, log, sleep)
        else:
            log("LinkedIn: company pages have no creator analytics page; using the posts page only")
            creator = {"account": {}, "posts": []}
        followers = _int(creator["account"].get("followers"))
        if followers is None:
            followers = _read_followers(page, own_url, log, sleep)
        payload = build_payload(posts, creator, followers)
        if not payload["posts"] and not payload["account"]:
            raise common.HarvestError(
                "LinkedIn: no stats found on the pages (no posts, no totals). Open the activity page in that "
                "Chrome window to check it shows your posts; the page layout may also have changed."
            )
        log(
            f"LinkedIn: done, {len(payload['posts'])} posts, account fields: {', '.join(payload['account']) or 'none'}"
        )
        return payload
    finally:
        with contextlib.suppress(
            Exception
        ):  # the tab may already be gone; never close the context or browser
            page.close()
