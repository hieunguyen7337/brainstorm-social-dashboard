"""Harvest endpoints: profile URLs, real-stats ingest, snapshots, harvest status and the screenshot reader."""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.auth import get_workspace
from app.db import PLATFORMS, get_db
from app.models import Connection, Platform
from app.services import demo, harvest, vision

router = APIRouter()


class ConnectionProfile(Connection):
    profile_url: str | None


class ProfileBody(BaseModel):
    profile_url: str = Field(max_length=2048)


class IngestResult(BaseModel):
    platform: Platform
    source: str
    matched: int
    created: int
    snapshots: int
    captured_at: str


class Snapshot(BaseModel):
    id: str
    platform: Platform
    post_id: str | None
    views: int | None
    engagements: int | None
    clicks: int | None
    conversions: int | None
    followers: int | None  # NULL = not captured
    source: str
    captured_at: str


class HarvestStatus(BaseModel):
    platform: Platform
    connected: bool
    profile_url: str | None
    last_harvest_at: str | None
    last_source: str | None
    followers: int | None
    real_posts: int
    snapshots: int


@router.put("/api/connections/{platform}/profile", response_model=ConnectionProfile)
def put_profile(platform: str, body: ProfileBody, ws: sqlite3.Row = Depends(get_workspace),
                conn: sqlite3.Connection = Depends(get_db)):
    demo.refuse_in_demo(ws)  # a demo workspace never takes real numbers
    row = harvest.set_profile(conn, ws["id"], platform, body.profile_url)
    return {k: row[k] for k in ConnectionProfile.model_fields}


@router.post("/api/metrics/ingest", response_model=IngestResult)
def ingest(body: harvest.IngestRequest, ws: sqlite3.Row = Depends(get_workspace),
           conn: sqlite3.Connection = Depends(get_db)):
    demo.refuse_in_demo(ws)  # a demo workspace never takes real numbers
    return harvest.ingest(conn, ws["id"], body)


@router.get("/api/metrics/snapshots", response_model=list[Snapshot])
def snapshots(platform: Platform | None = None, limit: int = Query(50, ge=1, le=500),
              ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)):
    return harvest.list_snapshots(conn, ws["id"], platform, limit)


@router.get("/api/connections/harvest-status", response_model=list[HarvestStatus])
def harvest_status(ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)):
    return harvest.harvest_status(conn, ws["id"])


class ScreenshotBody(BaseModel):
    image_base64: str  # the image as base64 text, without a "data:" prefix
    # image/png, image/jpeg or image/webp. A plain str on purpose: another type must answer 415, not 422.
    media_type: str


@router.post("/api/connections/{platform}/screenshot", response_model=vision.ScreenshotRead)
def read_screenshot(platform: str, body: ScreenshotBody, ws: sqlite3.Row = Depends(get_workspace),
                    conn: sqlite3.Connection = Depends(get_db)):
    """Claude reads a screenshot of the person's profile or insights page into numbers (docs/REAL.md).

    Nothing is saved: the app lets the person check the numbers, then saves them with
    POST /api/metrics/ingest. The first four checks need no AI key; the last one answers 503 when AI is
    off, capped or failing.
    """
    if platform not in PLATFORMS:
        raise HTTPException(status_code=404, detail=f"unknown platform '{platform}'")
    demo.refuse_in_demo(ws)  # before any AI use: a demo workspace has nothing real to read
    if body.media_type not in vision.MEDIA_TYPES:
        raise HTTPException(
            status_code=415, detail="unsupported media type: use image/png, image/jpeg or image/webp"
        )
    image_b64 = vision.clean_image_base64(body.image_base64)  # 413 above 5 MB, 422 for bad base64 or no image
    try:
        return vision.read_screenshot(conn, ws["id"], platform, image_b64, body.media_type)
    except vision.VisionUnavailable:
        raise HTTPException(status_code=503, detail=vision.UNAVAILABLE_DETAIL) from None
