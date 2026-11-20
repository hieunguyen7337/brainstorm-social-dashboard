"""Harvest endpoints: profile URLs, real-stats ingest, snapshots and harvest status."""

import sqlite3

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.auth import get_workspace
from app.db import get_db
from app.models import Connection, Platform
from app.services import harvest

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
    row = harvest.set_profile(conn, ws["id"], platform, body.profile_url)
    return {k: row[k] for k in ConnectionProfile.model_fields}


@router.post("/api/metrics/ingest", response_model=IngestResult)
def ingest(body: harvest.IngestRequest, ws: sqlite3.Row = Depends(get_workspace),
           conn: sqlite3.Connection = Depends(get_db)):
    return harvest.ingest(conn, ws["id"], body)


@router.get("/api/metrics/snapshots", response_model=list[Snapshot])
def snapshots(platform: Platform | None = None, limit: int = Query(50, ge=1, le=500),
              ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)):
    return harvest.list_snapshots(conn, ws["id"], platform, limit)


@router.get("/api/connections/harvest-status", response_model=list[HarvestStatus])
def harvest_status(ws: sqlite3.Row = Depends(get_workspace), conn: sqlite3.Connection = Depends(get_db)):
    return harvest.harvest_status(conn, ws["id"])
