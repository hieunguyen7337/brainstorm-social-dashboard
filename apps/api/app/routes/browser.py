"""Remote-controlled phone browser: a per-workspace command queue between an agent (MCP) and the Pulse app.

The agent queues a command (open a page, click, type, read, screenshot) with POST /api/browser/commands and waits for
its result with GET /api/browser/commands/{id}. The phone's "Let Claude use your browser" screen long-polls
GET /api/browser/next, runs the command in its signed-in WebView and posts the result to /api/browser/results/{id}.
Nothing runs unless that screen is open: a command is refused while no phone has polled in the last CONNECTED_S.

State lives in memory on app.state (one Fly machine, one uvicorn worker; every handler is async so the queue is only
touched on the event loop): a restart drops the queue, which is fine for
commands that live seconds. The phone never sends cookies or passwords; results hold page text, a URL and a JPEG.
"""

from __future__ import annotations

import asyncio
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.auth import get_workspace

router = APIRouter(prefix="/api/browser")

MAX_WAIT_S = 25.0
POLL_STEP_S = 0.2
CONNECTED_S = 35.0  # a phone that polled within this many seconds counts as connected
PENDING_TTL_S = 120.0  # a command nobody picked up fails after this long
SENT_TTL_S = 90.0  # a command the phone took but never answered fails after this long
DONE_TTL_S = 600.0  # finished commands are forgotten after this long
MAX_COMMANDS = 200
MAX_TEXT = 30_000
MAX_IMAGE_B64 = 6_000_000
MAX_TYPE_LEN = 5_000

ACTIONS = ("open", "back", "click", "type", "press", "scroll", "screenshot", "read_text", "elements")
KEYS = (
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "PageUp",
    "PageDown",
    "Home",
    "End",
)
_BARE_HOST = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)+(/|$)", re.IGNORECASE)
NOT_CONNECTED = (
    "No phone is connected. Ask the user to open the Pulse app on their Android phone, go to Settings > "
    "'Let Claude use your phone's browser' and tap Start, then try again."
)


@dataclass
class Command:
    id: str
    action: str
    args: dict[str, Any]
    created: float
    status: str = "pending"  # pending | sent | done
    sent_at: float = 0.0
    done_at: float = 0.0
    result: dict[str, Any] | None = None

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "action": self.action, "status": self.status}
        if self.result is not None:
            out["result"] = self.result
        return out


@dataclass
class Session:
    commands: dict[str, Command] = field(default_factory=dict)
    last_seen: float = 0.0
    polling: int = 0
    epoch: int = 0  # bumped by Stop, so a long-poll already in flight ends and stops counting as connected
    url: str = ""

    def connected(self, now: float) -> bool:
        return self.last_seen > 0 and (self.polling > 0 or now - self.last_seen < CONNECTED_S)


def _hub(request: Request) -> dict[str, Session]:
    hub = getattr(request.app.state, "browser_hub", None)
    if hub is None:
        hub = {}
        request.app.state.browser_hub = hub
    return hub


def _session(request: Request, ws: sqlite3.Row) -> Session:
    hub = _hub(request)
    s = hub.get(ws["id"])
    if s is None:
        s = hub[ws["id"]] = Session()
    _expire(s, time.monotonic())
    return s


def _finish(cmd: Command, now: float, result: dict[str, Any]) -> None:
    cmd.status = "done"
    cmd.done_at = now
    cmd.result = result


def _expire(s: Session, now: float) -> None:
    for cid, cmd in list(s.commands.items()):
        if cmd.status == "pending" and now - cmd.created > PENDING_TTL_S:
            _finish(cmd, now, {"ok": False, "error": "The phone did not pick this command up in time."})
        elif cmd.status == "sent" and now - cmd.sent_at > SENT_TTL_S:
            _finish(cmd, now, {"ok": False, "error": "The phone took this command but never answered."})
        elif cmd.status == "done" and now - cmd.done_at > DONE_TTL_S:
            del s.commands[cid]


def _clean_wait(wait: float) -> float:
    return max(0.0, min(MAX_WAIT_S, wait))


# ---- validation -----------------------------------------------------------------------------------------------------


def _https_url(value: Any) -> str:
    url = str(value or "").strip()
    if "://" not in url and _BARE_HOST.match(url):
        url = "https://" + url
    bad = HTTPException(status_code=422, detail="url must be an https:// web address")
    p = urlparse(url)
    try:
        _ = p.port  # raises on a malformed port
    except ValueError:
        raise bad from None
    if p.scheme != "https" or not p.hostname or len(url) > 2000:
        raise bad
    return url


def _num(args: dict[str, Any], key: str, lo: float, hi: float) -> float | None:
    if args.get(key) is None:
        return None
    try:
        v = float(args[key])
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail=f"{key} must be a number") from None
    if not lo <= v <= hi:  # also false for NaN
        raise HTTPException(status_code=422, detail=f"{key} must be between {lo:g} and {hi:g}")
    return v


def _str(args: dict[str, Any], key: str, limit: int = 500) -> str | None:
    v = args.get(key)
    if v is None or v == "":
        return None
    if not isinstance(v, str):
        raise HTTPException(status_code=422, detail=f"{key} must be text")
    if len(v) > limit:
        raise HTTPException(status_code=422, detail=f"{key} is longer than {limit} characters")
    return v


def validate(action: str, args: dict[str, Any]) -> dict[str, Any]:
    """The cleaned args the phone will run, or 422. The phone checks again on its side."""
    if action not in ACTIONS:
        raise HTTPException(status_code=422, detail=f"unknown action {action!r}; use one of {', '.join(ACTIONS)}")
    args = args or {}
    if action == "open":
        return {"url": _https_url(args.get("url"))}
    if action == "click":
        x, y = _num(args, "x", 0, 100_000), _num(args, "y", 0, 100_000)
        selector, text = _str(args, "selector"), _str(args, "text")
        if (x is None) != (y is None):
            raise HTTPException(status_code=422, detail="click needs both x and y")
        if x is None and not selector and not text:
            raise HTTPException(status_code=422, detail="click needs x and y, a css selector, or visible text")
        out: dict[str, Any] = {}
        if x is not None:
            out.update(x=x, y=y)
        if selector:
            out["selector"] = selector
        if text:
            out["text"] = text
        return out
    if action == "type":
        text = args.get("text")
        if not isinstance(text, str) or not text:
            raise HTTPException(status_code=422, detail="type needs non-empty text")
        if len(text) > MAX_TYPE_LEN:
            raise HTTPException(status_code=422, detail=f"text is longer than {MAX_TYPE_LEN} characters")
        out = {"text": text, "clear": bool(args.get("clear", False))}
        selector = _str(args, "selector")
        if selector:
            out["selector"] = selector
        return out
    if action == "press":
        key = str(args.get("key") or "")
        if key not in KEYS:
            raise HTTPException(status_code=422, detail=f"key must be one of {', '.join(KEYS)}")
        return {"key": key}
    if action == "scroll":
        dy = _num(args, "dy", -20_000, 20_000) or 0.0
        dx = _num(args, "dx", -20_000, 20_000) or 0.0
        return {"dy": dy, "dx": dx}
    return {}


# ---- models ---------------------------------------------------------------------------------------------------------


class CommandIn(BaseModel):
    action: str
    args: dict[str, Any] = Field(default_factory=dict)


class ResultIn(BaseModel):
    ok: bool
    text: str | None = None
    url: str | None = None
    title: str | None = None
    error: str | None = None
    image_jpeg_base64: str | None = None
    width: int | None = None
    height: int | None = None
    data: Any = None


class SessionIn(BaseModel):
    active: bool
    url: str | None = None


# ---- agent side -----------------------------------------------------------------------------------------------------


@router.get("/status")
async def status(request: Request, ws: sqlite3.Row = Depends(get_workspace)) -> dict[str, Any]:
    s = _session(request, ws)
    now = time.monotonic()
    return {
        "connected": s.connected(now),
        "last_seen_s": round(now - s.last_seen, 1) if s.last_seen else None,
        "url": s.url or None,
        "pending": sum(1 for c in s.commands.values() if c.status != "done"),
    }


@router.post("/commands")
async def create_command(body: CommandIn, request: Request, ws: sqlite3.Row = Depends(get_workspace)) -> dict[str, Any]:
    s = _session(request, ws)
    now = time.monotonic()
    args = validate(body.action, body.args)
    if not s.connected(now):
        raise HTTPException(status_code=409, detail=NOT_CONNECTED)
    if sum(1 for c in s.commands.values() if c.status != "done") >= 20:
        raise HTTPException(status_code=429, detail="Too many commands waiting for the phone; wait for them first.")
    while len(s.commands) >= MAX_COMMANDS:
        del s.commands[next(iter(s.commands))]
    cmd = Command(id=secrets.token_urlsafe(9), action=body.action, args=args, created=now)
    s.commands[cmd.id] = cmd
    return cmd.public()


@router.get("/commands/{command_id}")
async def get_command(
    command_id: str,
    request: Request,
    wait: float = Query(default=0.0),
    ws: sqlite3.Row = Depends(get_workspace),
) -> dict[str, Any]:
    s = _session(request, ws)
    cmd = s.commands.get(command_id)
    if cmd is None:
        raise HTTPException(status_code=404, detail="unknown or expired command")
    deadline = time.monotonic() + _clean_wait(wait)
    while cmd.status != "done" and time.monotonic() < deadline:
        await asyncio.sleep(POLL_STEP_S)
        _expire(s, time.monotonic())
    return cmd.public()


# ---- phone side -----------------------------------------------------------------------------------------------------


def _take_next(s: Session, now: float) -> Command | None:
    for cmd in s.commands.values():
        if cmd.status == "pending":
            cmd.status = "sent"
            cmd.sent_at = now
            return cmd
    return None


@router.get("/next")
async def next_command(
    request: Request, wait: float = Query(default=MAX_WAIT_S), ws: sqlite3.Row = Depends(get_workspace)
) -> dict[str, Any]:
    s = _session(request, ws)
    epoch = s.epoch
    s.last_seen = time.monotonic()
    s.polling += 1
    try:
        deadline = time.monotonic() + _clean_wait(wait)
        while s.epoch == epoch:
            now = time.monotonic()
            s.last_seen = now
            cmd = _take_next(s, now)
            if cmd is not None:
                return {"command": {"id": cmd.id, "action": cmd.action, "args": cmd.args}}
            if now >= deadline or await request.is_disconnected():
                break
            await asyncio.sleep(POLL_STEP_S)
        return {"command": None}
    finally:
        s.polling -= 1
        if s.epoch == epoch:
            s.last_seen = time.monotonic()


@router.post("/results/{command_id}")
async def post_result(
    command_id: str, body: ResultIn, request: Request, ws: sqlite3.Row = Depends(get_workspace)
) -> dict[str, Any]:
    s = _session(request, ws)
    now = time.monotonic()
    s.last_seen = now
    cmd = s.commands.get(command_id)
    if cmd is None:
        raise HTTPException(status_code=404, detail="unknown or expired command")
    if cmd.status == "done":
        return {"ok": True, "duplicate": True}
    if body.image_jpeg_base64 and len(body.image_jpeg_base64) > MAX_IMAGE_B64:
        raise HTTPException(status_code=413, detail="screenshot too large")
    result: dict[str, Any] = {"ok": body.ok}
    for key in ("url", "title", "error"):
        v = getattr(body, key)
        if v:
            result[key] = v[:2000]
    if body.text is not None:
        result["text"] = body.text[:MAX_TEXT]
    if body.image_jpeg_base64:
        result["image_jpeg_base64"] = body.image_jpeg_base64
        if body.width and body.height:
            result["width"], result["height"] = body.width, body.height
    if body.data is not None:
        result["data"] = body.data
    if body.url:
        s.url = body.url[:2000]
    _finish(cmd, now, result)
    return {"ok": True}


@router.post("/session")
async def session(body: SessionIn, request: Request, ws: sqlite3.Row = Depends(get_workspace)) -> dict[str, Any]:
    """The phone's heartbeat. `active: false` (Stop pressed) disconnects at once and fails what is still queued."""
    s = _session(request, ws)
    now = time.monotonic()
    if body.url:
        s.url = body.url[:2000]
    if body.active:
        s.last_seen = now
    else:
        s.last_seen = 0.0
        s.epoch += 1
        for cmd in s.commands.values():
            if cmd.status != "done":
                _finish(cmd, now, {"ok": False, "error": "The user stopped the browser on their phone."})
    return {"ok": True, "connected": s.connected(now)}
