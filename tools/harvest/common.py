"""Shared helpers for the harvest script (stdlib only, no network, no browser).

Payload shape every platform module returns (it is exactly the body of POST /api/metrics/ingest minus
`platform` and `source`):

    {"account": {"followers"?, "views"?, "engagements"?, "clicks"?, "profile_views"?},
     "posts": [{"external_id"?, "url"?, "content"?, "posted_at"?, "views", "engagements",
                "clicks"?, "conversions"?}, ...]}

Every number is a plain int (or absent). Parsers are pure functions over HTML / text so they can be
unit-tested against fixtures; only the `harvest()` drivers touch a browser.
"""

from __future__ import annotations

import random
import re
import time
from html.parser import HTMLParser

MAX_POSTS = 30  # human-pace cap per platform run


class HarvestError(Exception):
    """Something went wrong while reading a page (message is shown to the user)."""


class LoginRequired(HarvestError):
    """The user's Chrome is not logged in to the platform."""


LOGIN_MESSAGE = "log in in that Chrome window, then rerun"

_COUNT = re.compile(r"(?<![\w.,])(\d{1,3}(?:[,   ]\d{3})+|\d+)(?:([.,])(\d+))?\s*([kKmMbB])?(?![\w])")
_MULT = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}


def parse_count(text: str | int | None) -> int | None:
    """First number in `text` as an int: '1,234' -> 1234, '1.2K' -> 1200, '3.4M views' -> 3400000,
    '12 comments' -> 12, '1 234' -> 1234. None when there is no number."""
    if text is None:
        return None
    if isinstance(text, int):
        return text
    s = str(text).strip()
    m = _COUNT.search(s)
    if not m:
        return None
    whole, sep, frac, suffix = m.group(1), m.group(2), m.group(3), m.group(4)
    whole = re.sub(r"[,   ]", "", whole)
    if suffix:
        mult = _MULT[suffix.lower()]
        value = float(f"{whole}.{frac}") if frac else float(whole)
        return round(value * mult)
    if frac and sep == "," and len(frac) == 3:  # '1,234' written with a lone comma group
        return int(whole + frac)
    return int(whole)


class _TextExtractor(HTMLParser):
    BLOCK = frozenset({
        "p", "div", "li", "ul", "ol", "br", "tr", "section", "article", "header", "footer", "h1", "h2",
        "h3", "h4", "h5", "h6", "span", "a", "button", "dt", "dd", "table", "td", "th", "main", "nav",
    })
    INLINE_JOIN = frozenset({"span", "a", "button", "td", "th"})  # joined with a space, not a newline
    SKIP = frozenset({"script", "style", "noscript", "template", "svg"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag in self.BLOCK:
            self.parts.append(" " if tag in self.INLINE_JOIN else "\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag in self.BLOCK:
            self.parts.append(" " if tag in self.INLINE_JOIN else "\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    """Visible text of an HTML fragment, one logical line per block element, whitespace collapsed."""
    p = _TextExtractor()
    p.feed(html)
    p.close()
    lines = (re.sub(r"[ \t  ]+", " ", ln).strip() for ln in "".join(p.parts).splitlines())
    return "\n".join(ln for ln in lines if ln)


def clean(text: str | None) -> str:
    """Collapse whitespace."""
    return re.sub(r"\s+", " ", text or "").strip()


def human_pause(lo: float = 1.0, hi: float = 2.0, *, sleep=time.sleep) -> float:
    """Sleep a random 1-2 s (human pace). `sleep` is injectable so tests never wait."""
    d = random.uniform(lo, hi)
    sleep(d)
    return d
