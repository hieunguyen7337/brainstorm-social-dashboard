"""Share links: network composer URLs prefilled with a post (GET /api/posts/{id}/share).

The route does one post SELECT and no writes. The text builders are pure functions in this file so they
can be unit-tested and reused: every limit is counted in raw characters (conservative), and the tracked
link is never cut, it is always the last part of the text.
"""

import json
import re
import sqlite3
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_workspace
from app.config import settings
from app.db import get_db
from app.services.channels import IG_MAX_HASHTAGS
from app.services.posts import get_post_row, link_url_for

router = APIRouter()

X_LIMIT = 280
THREADS_LIMIT = 500
REDDIT_TITLE_LIMIT = 300
INSTAGRAM_NOTE = "copy the caption, then post the image in the app"
_ELLIPSIS = "…"
_CLIP_TRAILING = " \t\n,;:-"


class ShareLinks(BaseModel):
    linkedin: str
    x: str
    threads: str
    reddit: str
    facebook: str
    instagram: str | None = None  # no web composer: the app has to be used
    instagram_note: str
    text: str  # plain caption incl. the tracked link, for a copy button
    link_url: str | None


def _enc(value: str) -> str:
    """Percent-encode everything (`&`, `#`, `?`, `+`, spaces, newlines, unicode, the link itself)."""
    return quote(value, safe="")


def _clip(text: str, limit: int) -> str:
    """Clip `text` to at most `limit` characters at a word boundary, ending with an ellipsis."""
    if len(text) <= limit:
        return text
    if limit < 2:
        return ""
    cut = text[: limit - 1]
    if not text[limit - 1].isspace():  # the cut lands inside a word: drop that partial word
        m = re.search(r"\s\S*$", cut)
        if m and m.start() > 0:
            cut = cut[: m.start()]
    return cut.rstrip(_CLIP_TRAILING) + _ELLIPSIS


def _tidy(text: str) -> str:
    """Collapse runs of spaces and blank lines but keep paragraph breaks."""
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _without_link(content: str, link: str | None) -> str:
    return content.replace(link, " ") if link else content


def _hashtags(raw: str | None, content: str) -> list[str]:
    """Hashtags from the JSON column: leading `#`, no empties or duplicates, none already in the content."""
    try:
        items = json.loads(raw or "[]")
    except ValueError:
        items = []
    if not isinstance(items, list):
        items = []
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        tag = "".join(item.split()).lstrip("#")
        key = tag.casefold()
        if not tag or key in seen:
            continue
        seen.add(key)
        if re.search(rf"(?<!\w)#{re.escape(tag)}(?!\w)", content, re.IGNORECASE):
            continue
        out.append("#" + tag)
    return out


def _caption(content: str, tags: list[str], link: str | None) -> str:
    """Full caption: content, hashtags right after it, tracked link last (not repeated if already in it)."""
    parts = [content]
    if tags:
        parts.append(" ".join(tags))
    if link and link not in content:
        parts.append(link)
    return "\n\n".join(p for p in parts if p)


def _compose(body: str, tags: list[str], link: str | None, limit: int, sep: str) -> str:
    """`body [+ hashtags that fit] + link` in <= `limit` characters. The body is clipped, never the link."""

    def build(b: str, t: list[str]) -> str:
        return sep.join(p for p in (b, " ".join(t), link or "") if p)

    if len(build(body, [])) > limit:
        reserved = len(sep) + len(link) if link else 0
        return build(_clip(body, limit - reserved), [])
    used: list[str] = []
    for tag in tags:  # as many as fit, in order
        if len(build(body, used + [tag])) <= limit:
            used.append(tag)
    return build(body, used)


def x_text(content: str, tags: list[str], link: str | None) -> str:
    """Always rebuilt as `<body> <hashtags that fit> <link>`, <= 280 chars, body clipped at a word."""
    body = " ".join(_without_link(content, link).split())
    return _compose(body, tags, link, X_LIMIT, " ")


def threads_text(content: str, tags: list[str], link: str | None) -> str:
    """The LinkedIn caption if it fits in 500 characters, else clipped body + hashtags that fit + link."""
    full = _caption(content, tags, link)
    if len(full) <= THREADS_LIMIT:
        return full
    return _compose(_tidy(_without_link(content, link)), tags, link, THREADS_LIMIT, "\n\n")


def reddit_parts(content: str, link: str | None) -> tuple[str, str]:
    """(title, text): title is the first non-empty line (<= 300 chars), text the rest plus the link last."""
    lines = content.splitlines()
    title, rest = "", []
    for i, line in enumerate(lines):
        cleaned = " ".join(_without_link(line, link).split())
        if cleaned:
            title = _clip(cleaned, REDDIT_TITLE_LIMIT)
            # a clipped title would lose its tail, so keep the whole first line in the text then
            rest = lines[i:] if title != cleaned else lines[i + 1 :]
            break
    text = "\n".join(rest).strip()
    if link and link not in text:
        text = f"{text}\n\n{link}" if text else link
    return title, text


def build_share_links(row: sqlite3.Row) -> dict:
    content = (row["content"] or "").strip()
    link = link_url_for(row["link_code"])
    tags = _hashtags(row["hashtags"], content)
    if row["platform"] in ("instagram", "tiktok"):
        tags = tags[:IG_MAX_HASHTAGS]  # posts saved before the limit may hold more; Instagram drops the rest
    caption = _caption(content, tags, link)
    title, reddit_text = reddit_parts(content, link)
    return {
        "linkedin": "https://www.linkedin.com/feed/?shareActive=true&text=" + _enc(caption),
        "x": "https://x.com/intent/post?text=" + _enc(x_text(content, tags, link)),
        "threads": "https://www.threads.net/intent/post?text=" + _enc(threads_text(content, tags, link)),
        "reddit": "https://www.reddit.com/submit?title=" + _enc(title) + "&text=" + _enc(reddit_text),
        "facebook": "https://www.facebook.com/sharer/sharer.php?u=" + _enc(link or settings.public_base_url),
        "instagram": None,
        "instagram_note": INSTAGRAM_NOTE,
        "text": caption,
        "link_url": link,
    }


@router.get("/api/posts/{post_id}/share", response_model=ShareLinks)
def share_links(post_id: str, ws: sqlite3.Row = Depends(get_workspace),
                conn: sqlite3.Connection = Depends(get_db)):
    row = get_post_row(conn, ws["id"], post_id)
    if row is None:
        raise HTTPException(status_code=404, detail="post not found")
    return build_share_links(row)
