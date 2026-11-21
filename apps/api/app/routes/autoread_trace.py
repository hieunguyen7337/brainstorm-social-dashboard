"""Sign-in diagnostics from the app's automatic reader (POST /api/autoread/trace).

The app sends phases, page hosts and paths, injection counts and the reader's status codes, never page text or
cookies. Each batch becomes one `autoread-trace` line in the server log (read with `flyctl logs`), and the last
batches stay in memory for GET /api/autoread/trace (the caller's own workspace only). Nothing is stored in the database.
"""

import json
import sqlite3
import time
from collections import deque
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.auth import get_workspace

router = APIRouter()

MAX_LINE = 16_000
_recent: deque[dict[str, Any]] = deque(maxlen=300)


class TraceIn(BaseModel):
    platform: str = Field(max_length=20)
    run: str = Field(max_length=40)
    app: dict[str, Any] = Field(default_factory=dict)
    events: list[dict[str, Any]] = Field(default_factory=list, max_length=400)


@router.post("/api/autoread/trace")
def post_trace(body: TraceIn, ws: sqlite3.Row = Depends(get_workspace)) -> dict[str, bool]:
    entry = {"ws": ws["id"], "at": int(time.time()), **body.model_dump()}
    line = json.dumps(entry, separators=(",", ":"), default=str)[:MAX_LINE]
    print(f"autoread-trace {line}", flush=True)
    _recent.append(entry)
    return {"ok": True}


@router.get("/api/autoread/trace")
def get_trace(ws: sqlite3.Row = Depends(get_workspace)) -> dict[str, Any]:
    return {"batches": [e for e in _recent if e["ws"] == ws["id"]][-100:]}
