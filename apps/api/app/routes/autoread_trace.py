"""Sign-in diagnostics from the app's automatic reader (POST /api/autoread/trace).

The app sends phases, page hosts and paths, injection counts and the reader's status codes, never page text, cookies,
form values or tokens. The server does not trust that: the body is capped, and every value is redacted and bounded
before it is logged or kept. Each batch becomes one `autoread-trace` line in the server log (read with `flyctl logs`),
and the last batches stay in memory for GET /api/autoread/trace (the caller's own workspace only). Nothing is stored in
the database.
"""

import json
import math
import re
import sqlite3
import time
from collections import deque
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field

from app.auth import get_workspace

MAX_LINE = 16_000
MAX_BODY = 256 * 1024  # bytes; 400 events of at most MAX_EVENT chars fit with room to spare
MAX_EVENT = 512  # serialized chars per event, after redaction
MAX_STR = 120
MAX_ITEMS = 24
MAX_DEPTH = 3
REDACTED = "[redacted]"


class _CappedRequest(Request):
    """Reads the body from the stream and stops at MAX_BODY, with or without a Content-Length."""

    async def body(self) -> bytes:
        if not hasattr(self, "_body"):
            declared = self.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > MAX_BODY:
                raise HTTPException(status_code=413, detail="trace too large")
            chunks: list[bytes] = []
            size = 0
            async for chunk in self.stream():
                size += len(chunk)
                if size > MAX_BODY:
                    raise HTTPException(status_code=413, detail="trace too large")
                chunks.append(chunk)
            self._body = b"".join(chunks)
        return self._body


class _CappedRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            return await original(_CappedRequest(request.scope, request.receive))

        return handler


router = APIRouter(route_class=_CappedRoute)
_recent: deque[dict[str, Any]] = deque(maxlen=300)

# Free-form text is kept only under these keys (the ones the app's trace uses); a string under any other key is dropped,
# because a typed value cannot be told from a diagnostic by its shape.
_STRING_KEYS = frozenset(
    {"e", "host", "path", "status", "phase", "from", "p", "src", "os", "osv", "update", "channel", "created", "via"}
)
# A field named like a secret keeps only a yes/no (the readers send `csrf: true`, never the value).
_SECRET_KEY = re.compile(
    r"pass|pwd|secret|token|cookie|csrf|xsrf|sess|auth|bearer|otp|code|credential|key|html|body|text|value|input|query|search",
    re.IGNORECASE,
)
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_BEARER = re.compile(r"\bbearer\s+\S+", re.IGNORECASE)
_JWT = re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]*")
_ASSIGN = re.compile(r"\b(\w*(?:pass|pwd|secret|token|cookie|csrf|sess|auth|otp|code|key)\w*)\s*[=:]\s*\S+", re.IGNORECASE)
_URL_QUERY = re.compile(r"(https?://[^\s?#]+)[?#]\S*", re.IGNORECASE)
_RUN = re.compile(r"[A-Za-z0-9_\-+=]{24,}")
_SEGMENT = re.compile(r"[A-Za-z0-9_\-+=%]+")


def _opaque_segment(seg: str) -> bool:
    """A path segment that looks like an id, reset token or challenge code rather than a word."""
    if re.fullmatch(r"\d{5,}", seg):
        return True
    if not _SEGMENT.fullmatch(seg):
        return False
    return len(seg) >= 20 or (len(seg) >= 12 and bool(re.search(r"\d", seg)) and bool(re.search(r"[A-Za-z]", seg)))


def _clean_str(s: str) -> str:
    if _UUID.fullmatch(s):
        return s
    if re.match(r"(https?://|/)", s, re.IGNORECASE):
        s = re.split(r"[?#]", s, maxsplit=1)[0]
        s = "/".join(":id" if _opaque_segment(p) else p for p in s.split("/"))
    s = _URL_QUERY.sub(r"\1", s)
    s = _BEARER.sub("Bearer " + REDACTED, s)
    s = _JWT.sub(REDACTED, s)
    s = _ASSIGN.sub(lambda m: f"{m.group(1)}={REDACTED}", s)
    s = _RUN.sub(REDACTED, s)
    if re.fullmatch(r"\d{4,10}", s):
        s = REDACTED
    return s if len(s) <= MAX_STR else s[:MAX_STR] + "…"


def scrub(value: Any, key: str = "", depth: int = 0) -> Any:
    """A copy of `value` with secrets redacted and every size bounded."""
    if value is None or isinstance(value, bool):
        return value
    if _SECRET_KEY.search(key):
        return REDACTED
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return _clean_str(value) if key in _STRING_KEYS else REDACTED
    if depth >= MAX_DEPTH:
        return None
    if isinstance(value, dict):
        return {_clean_str(str(k))[:40]: scrub(v, str(k), depth + 1) for k, v in list(value.items())[:MAX_ITEMS]}
    if isinstance(value, list):
        return [scrub(v, key, depth + 1) for v in value[:MAX_ITEMS]]
    return None


def _scrub_event(event: dict[str, Any]) -> dict[str, Any]:
    clean = scrub(event, depth=-1)  # an event is one level deeper than its fields: its own keys sit at depth 0
    if len(json.dumps(clean, separators=(",", ":"), default=str)) <= MAX_EVENT:
        return clean
    return {"ms": clean.get("ms") if isinstance(clean.get("ms"), int) else None, "e": str(clean.get("e", ""))[:40], "truncated": True}


class TraceIn(BaseModel):
    platform: str = Field(max_length=20, pattern=r"^[a-z0-9_-]+$")
    run: str = Field(max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    app: dict[str, Any] = Field(default_factory=dict)
    events: list[dict[str, Any]] = Field(default_factory=list, max_length=400)


@router.post("/api/autoread/trace")
def post_trace(body: TraceIn, ws: sqlite3.Row = Depends(get_workspace)) -> dict[str, bool]:
    entry = {
        "ws": ws["id"],
        "at": int(time.time()),
        "platform": body.platform,
        "run": body.run,
        "app": scrub(body.app),
        "events": [_scrub_event(e) for e in body.events],
    }
    line = json.dumps(entry, separators=(",", ":"), default=str)[:MAX_LINE]
    print(f"autoread-trace {line}", flush=True)
    _recent.append(entry)
    return {"ok": True}


@router.get("/api/autoread/trace")
def get_trace(ws: sqlite3.Row = Depends(get_workspace)) -> dict[str, Any]:
    return {"batches": [e for e in _recent if e["ws"] == ws["id"]][-100:]}
