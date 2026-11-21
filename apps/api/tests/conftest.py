import os

import pytest

os.environ.setdefault("PULSE_DISABLE_LOOPS", "1")
os.environ["ANTHROPIC_API_KEY"] = ""  # tests never call the real API


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import settings

    monkeypatch.setattr(settings, "database_path", str(tmp_path / "test.db"))
    from app.main import create_app

    with TestClient(create_app()) as c:
        yield c


@pytest.fixture()
def auth(client):
    """A seeded guest workspace; returns (client, headers, workspace json)."""
    r = client.post("/api/workspaces", json={})
    assert r.status_code == 200, r.text
    ws = r.json()
    return client, {"Authorization": f"Bearer {ws['token']}"}, ws


@pytest.fixture(autouse=True)
def all_platforms_live(request, monkeypatch):
    """Older tests exercise every platform's pipeline (templates, share links, harvest...), so they run with all six
    platforms live. Tests that check the real gating (tests/test_platform_gating.py) are marked `gating`."""
    if request.node.get_closest_marker("gating"):
        return
    from app import platforms
    from app.db import PLATFORMS

    monkeypatch.setattr(platforms, "LIVE_PLATFORMS", PLATFORMS)
    monkeypatch.setattr(platforms, "UPCOMING_PLATFORMS", ())
