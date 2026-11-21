"""Room mode: JSON API for the presenter and the crowd, plus the phone page, the big-screen page and the
no-JS form fallbacks. The logic lives in `app.services.rooms`; this module only maps it onto HTTP."""

import secrets
import sqlite3
import urllib.parse
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

from app import redact, templates_room
from app.auth import get_workspace
from app.config import settings
from app.db import get_db
from app.services import rooms
from app.services.rooms import RoomError

router = APIRouter()
redact.install_log_filter()  # the big screen opens /room/{code}?token=<bearer>: keep it out of the access log

NO_STORE = {"Cache-Control": "no-store"}
MAX_FORM_BYTES = 4096


class RoomCreate(BaseModel):
    title: str | None = Field(default=None, max_length=80)
    post_a: str | None = None
    post_b: str | None = None
    brief: str | None = Field(default=None, max_length=300)


class VoteBody(BaseModel):
    choice: Literal["a", "b"]


def _http(exc: RoomError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.detail)


def _room_or_404(conn: sqlite3.Connection, code: str) -> sqlite3.Row:
    try:
        return rooms.require_room(conn, code)
    except RoomError as exc:
        raise _http(exc) from None


# ---------------------------------------------------------------- JSON API


@router.post("/api/rooms")
def create_room(
    body: RoomCreate | None = None,
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
):
    body = body or RoomCreate()
    try:
        return rooms.create_room(
            conn, ws,
            title=body.title or "", post_a=body.post_a, post_b=body.post_b, brief=body.brief or "",
        )
    except RoomError as exc:
        raise _http(exc) from None


@router.get("/api/rooms/{code}")
def get_room(code: str, conn: sqlite3.Connection = Depends(get_db)):
    return rooms.room_public(conn, _room_or_404(conn, code))


@router.post("/api/rooms/{code}/vote")
def vote(
    code: str,
    body: VoteBody,
    request: Request,
    response: Response,
    conn: sqlite3.Connection = Depends(get_db),
):
    room = _room_or_404(conn, code)
    voter, is_new = rooms.voter_from_request(request)
    try:
        result = rooms.cast_vote(conn, room, voter, body.choice)
    except RoomError as exc:
        raise _http(exc) from None
    if is_new:
        rooms.set_voter_cookie(response, voter)
    return result


@router.post("/api/rooms/{code}/onboard")
def onboard(code: str, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    room = _room_or_404(conn, code)
    voter, is_new = rooms.voter_from_request(request)
    if is_new:  # no cookie, so no vote
        raise HTTPException(status_code=400, detail="vote first")
    try:
        return rooms.onboard(conn, room, voter)
    except RoomError as exc:
        raise _http(exc) from None


@router.get("/api/rooms/{code}/stats")
def stats(code: str, conn: sqlite3.Connection = Depends(get_db)):
    try:
        return rooms.stats_for_code(conn, code)
    except RoomError as exc:
        raise _http(exc) from None


@router.post("/api/rooms/{code}/close")
def close(
    code: str,
    ws: sqlite3.Row = Depends(get_workspace),
    conn: sqlite3.Connection = Depends(get_db),
):
    room = rooms.find_room(conn, code)
    if room is None or room["workspace_id"] != ws["id"]:
        raise HTTPException(status_code=404, detail="room not found")
    return rooms.close_room(conn, room)


# ---------------------------------------------------------------- pages


def _not_found_page(code: str) -> HTMLResponse:
    html = templates_room.render_not_found(app_name=settings.app_name, code=rooms.normalise_code(code)[:32])
    return HTMLResponse(html, status_code=404, headers=NO_STORE)


@router.get("/v/{code}", response_class=HTMLResponse)
def phone_page(code: str, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    room = rooms.find_room(conn, code)
    if room is None:
        return _not_found_page(code)
    voter, is_new = rooms.voter_from_request(request)
    rooms.record_scan(conn, room["id"], voter)
    voted, onboarded = (None, False) if is_new else rooms.voter_state(conn, room["id"], voter)
    html = templates_room.render_phone_page(
        app_name=settings.app_name,
        code=room["code"],
        title=room["title"],
        variants=rooms.room_variants(conn, room),
        status=room["status"],
        voted=voted,
        onboarded=onboarded,
        votes=rooms.fresh_votes(conn, room["id"]),
    )
    response = HTMLResponse(html, headers=NO_STORE)
    if is_new:
        rooms.set_voter_cookie(response, voter)
    return response


async def _form_fields(request: Request) -> dict[str, str]:
    raw = await request.body()
    if len(raw) > MAX_FORM_BYTES:
        return {}
    parsed = urllib.parse.parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)
    return {key: values[0] for key, values in parsed.items()}


def _back_to_phone_page(code: str, voter: str, is_new: bool) -> RedirectResponse:
    response = RedirectResponse(f"/v/{urllib.parse.quote(code, safe='')}", status_code=303)
    if is_new:
        rooms.set_voter_cookie(response, voter)
    return response


@router.post("/v/{code}/vote")
async def phone_vote_form(code: str, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    """No-JS fallback: a plain form post. A closed room or a bad choice just redirects back."""
    fields = await _form_fields(request)
    voter, is_new = rooms.voter_from_request(request)

    def work() -> None:
        room = rooms.find_room(conn, code)
        if room is not None:
            try:
                rooms.cast_vote(conn, room, voter, fields.get("choice", ""))
            except RoomError:
                pass

    await run_in_threadpool(work)
    return _back_to_phone_page(code, voter, is_new)


@router.post("/v/{code}/onboard")
async def phone_onboard_form(code: str, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    """No-JS fallback for "Get started"; without a vote it just redirects back."""
    voter, is_new = rooms.voter_from_request(request)

    def work() -> None:
        room = rooms.find_room(conn, code)
        if room is not None and not is_new:
            try:
                rooms.onboard(conn, room, voter)
            except RoomError:
                pass

    await run_in_threadpool(work)
    return _back_to_phone_page(code, voter, is_new)


@router.get("/room/{code}", response_class=HTMLResponse)
def screen_page(
    code: str,
    token: str | None = Query(default=None),
    conn: sqlite3.Connection = Depends(get_db),
):
    """The big-screen page. It does not count as a scan, and only shows presenter controls for a valid token."""
    room = rooms.find_room(conn, code)
    if room is None:
        return _not_found_page(code)
    shown_token = None
    if token:
        owner = conn.execute("SELECT token FROM workspaces WHERE id = ?", (room["workspace_id"],)).fetchone()
        if owner is not None and secrets.compare_digest(owner["token"].encode(), token.encode()):
            shown_token = token
    url = rooms.join_url(room["code"])
    html = templates_room.render_screen_page(
        app_name=settings.app_name,
        code=room["code"],
        title=room["title"],
        variants=rooms.room_variants(conn, room),
        status=room["status"],
        join_url=url,
        join_url_display=rooms.display_url(url),
        qr_svg=rooms.qr_svg(url),
        token=shown_token,
    )
    return HTMLResponse(html, headers={**NO_STORE, "Referrer-Policy": "no-referrer"})
